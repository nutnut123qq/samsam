import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay, vnDate, weekday } from '@samsam/core/ops/period';
import { isPrintable } from '@samsam/core/ops/py';
import { cpCmp, isDict, PyFloat, parsePyJson, pyFixed, pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import {
  casefold,
  cpHead,
  cpLen,
  pyRstrip,
  pyStr,
  pyStrip,
  re,
  reEscape,
  S,
  stripAccents,
  sub,
  W,
} from '@samsam/core/security/py';
import {
  type Cell,
  clean,
  nfc,
  readBytes,
  safe,
  suffixOf,
  TableError,
  type TableRow,
  table,
  toInt,
} from './table.js';

// Port `ingest/intel_import.py` (v7.2, WP09 — Competitor Tracker, Trend, Social Listening P1):
// nạp file intel NHẬP TAY. KHÔNG request mạng, không trả lời comment/inbox, không đăng, không gửi
// ai, không gọi LLM. Ghi DUY NHẤT 5 bảng v7.2 (`intel_imports`, `competitor_observations`,
// `trends_weekly`, `trends_related`, `social_mentions`); CHỈ ĐỌC golden (`sku_master`, `price_list`)
// — không đổi giá, không gợi ý "giá nên đặt"; không có đường sang bảng hàng duyệt nội dung.
// Mọi hàm read_* là THUẦN (không DB): kiểm TOÀN file, lỗi chỉ nêu số dòng + tên cột (KHÔNG in giá
// trị ô); rows ≠ [] chỉ khi errors = [].

export const KEYWORDS_FILE = dataPath('trend_keywords.json');
export const RULES_FILE = dataPath('social_rules.json');
export const VN_OFFSET_MIN = 7 * 60; // VN không DST

export const PRE_MAX = 1200; // cắt text ngoài TRƯỚC maskPii (chống DoS regex v1.4)
export const MAX_PRICE = 10 ** 15;
export const MAX_KW_PER_FILE = 5; // giới hạn so sánh của Google Trends
export const SALT_MIN = 16;
export const MAX_HEADER = 200; // ký tự / ô header Google Trends

export const C_REQUIRED = ['doi_thu', 'kenh', 'ten_san_pham', 'gia_vnd', 'ngay_ghi', 'nguon'];
export const C_OPTIONAL = [
  'sku_tuong_duong',
  'gia_km_vnd',
  'khuyen_mai',
  'rating',
  'so_danh_gia',
  'ghi_chu',
];
export const C_CHANNELS = ['shopee', 'tiktok', 'lazada', 'tiki', 'web', 'khac'];
export const MARKETPLACES = ['shopee', 'tiktok', 'lazada', 'tiki'];

export const S_REQUIRED = ['thoi_gian', 'noi_dung'];
export const S_OPTIONAL = ['loai', 'ma_tin', 'id_nguoi_dung'];
export const S_IDENTITY_DROP = ['ten_nguoi_dung', 'sdt', 'email', 'link_profile', 'avatar'];
export const S_CHANNELS = ['fanpage', 'zalo_oa', 'tiktok'];
export const S_KINDS = ['comment', 'inbox', 'review'];
// Đợt hoàn thiện 22/10 (marketing-05.1, PL01 "Phân loại bình luận (hỏi giá, khiếu nại, nghi hàng
// giả…)"): nhãn nghi_hang_gia (từ khóa ĐỀ XUẤT trong data/social_rules.json — Quản lý MXH chốt).
// Nhãn vắng trong config = không gắn (như các nhãn khác).
export const S_RULE_LABELS = ['khen', 'che', 'hoi_gia', 'khieu_nai', 'nghi_hang_gia'];

export const TREND_GROUPS = ['qua_tang', 'sam', 'gioi_tre'];
/** Ngày giá golden: kênh có trong golden (`ingest.golden_store.CHANNELS`). */
export const GOLDEN_CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'];

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TS_RE =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(Z|([+-])([0-9]{2}):([0-9]{2}))?$/;
// ô xlsx float 4.5 → "4.500000" (cellOf) — nhận tới 6 số lẻ, rồi kiểm: lượng hóa 0.1 không đổi giá trị.
const RATING_RE = /^([0-5])(?:[.,]([0-9]{1,6}))?$/;
const URL_RE = re(`^https?://[^${S}/]+[^${S}]*$`, 'i');
// Python `.` chỉ không khớp LF (JS `.` còn loại CR và 2 ký tự ngắt dòng Unicode) → dùng lớp [^LF].
const TL_COL_RE = /^([^\n]+?): \(([^\n]+)\)$/u;
const TL_VAL_RE = /^[0-9]{1,3}$/;
const REL_VAL_RE = /^(?:[0-9]{1,3}|\+[0-9][0-9.,]{0,12}%|Breakout|Đột phá)$/;
const WS_RUN = re(`[${S}]+`, 'g');
const WS_TAIL = re(`[${S}]+(?=[^${S}]*$)`);

/** Python `llm_gateway._kw_re(words)`: khớp nguyên cụm, biên `\w` Unicode. */
export const kwRe = (words: readonly string[]): RegExp =>
  re(`(?<![${W}])(?:${words.map(reEscape).join('|')})(?![${W}])`);

// Social: câu hỏi CÔNG DỤNG sức khỏe — bộ lọc chung `isHealthQuestion` chỉ bắt bệnh/thuốc/triệu
// chứng, sót "tác dụng gì / có bổ không / tốt cho ...". Lệch về phía nhạy cảm là an toàn (không lưu
// excerpt). Không dấu chỉ áp khi cả câu không dấu (cùng quy tắc gateway).
const SOC_HEALTH_RE = kwRe([
  'công dụng',
  'tác dụng',
  'sức khỏe',
  'sức khoẻ',
  'bồi bổ',
  'bổ không',
  'bổ gì',
  'tốt cho',
]);
const SOC_HEALTH_ASCII_RE = kwRe([
  'cong dung',
  'tac dung',
  'suc khoe',
  'boi bo',
  'bo khong',
  'tot cho',
]);
// 'giá' trong cụm KHÔNG hỏi giá ("đánh giá 5 sao", "giá trị", "định giá", "đáng giá") → xóa cụm
// trước khi xét nhãn hoi_gia (lớp lỗi intent_of v2.4).
const NOT_PRICE_RE = kwRe([
  'đánh giá',
  'định giá',
  'giá trị',
  'đáng giá',
  'quý giá',
  'vô giá',
  'danh gia',
  'dinh gia',
  'gia tri',
  'dang gia',
]);

// ------------------------------------------------------------------------------------- thuần

/** Python `(s.rsplit(None, 1) or [""])[0]`. */
function rsplitHead(s: string): string {
  const r = pyRstrip(s);
  const m = WS_TAIL.exec(r);
  if (!m) return r;
  return m.index === 0 ? r.slice(m[0].length) : r.slice(0, m.index);
}

/** `_text`: text từ file ngoài: cắt PRE_MAX (bỏ token dở ở mép — SĐT/email cắt đôi không lọt) →
 * maskPii → bỏ ký tự điều khiển/vô hình → gom trắng → cắt n. */
export function text(s: unknown, n: number): string {
  let t = s === null || s === undefined || s === '' ? '' : pyStr(s);
  if (cpLen(t) > PRE_MAX) {
    t = rsplitHead(cpHead(t, PRE_MAX)).replace(/[0-9 .+\-()@]+$/, '');
  }
  t = maskPii(t);
  let out = '';
  for (const c of t) out += isPrintable(c) ? c : ' ';
  return cpHead(pyStrip(sub(WS_RUN, ' ', out)), n);
}

/** `_kw`: chuẩn hóa từ khóa để so — NFC + casefold + gom trắng. */
export const kw = (s: string): string => pyStrip(sub(WS_RUN, ' ', casefold(s.normalize('NFC'))));

/** `_iso_date` → 'YYYY-MM-DD' | null. shortcut: năm 0001–0099 TS từ chối (Python nhận) — chặt hơn. */
export function isoDate(s: string | null | undefined): string | null {
  if (!s || !DATE_RE.test(s)) return null;
  return parseDay(s) === null ? null : s;
}

/** Mốc thời gian có múi giờ: `iso` = Python `datetime.isoformat()`, `ms` = epoch. */
export type Ts = { iso: string; ms: number };

/** `_iso_ts`: ISO có/không múi giờ (không múi giờ = giờ VN) → Ts | null. */
export function isoTs(s: string | null | undefined): Ts | null {
  const m = s ? TS_RE.exec(s) : null;
  if (!m) return null;
  const [, day, hh, mi, ss = '00', z, sign, oh, om] = m as unknown as string[];
  const t = parseDay(day as string);
  const h = Number(hh);
  const mm = Number(mi);
  const sec = Number(ss);
  if (t === null || h > 23 || mm > 59 || sec > 59) return null;
  let off = VN_OFFSET_MIN;
  if (z === 'Z') off = 0;
  else if (z) off = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  if (Math.abs(off) >= 24 * 60) return null; // timezone() cần |offset| < 24 giờ
  const a = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, '0');
  const tz = `${off < 0 ? '-' : '+'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
  return {
    iso: `${day}T${hh}:${mi}:${ss}${tz}`,
    ms: t + ((h * 60 + mm - off) * 60 + sec) * 1000,
  };
}

/** `today_vn()` → 'YYYY-MM-DD'. */
export const todayVn = (now: Date = new Date()): string => vnDate(now);

export type Rec = Record<string, Cell>;

/** `_records`: header + dòng → [(số dòng, {cột: ô})], lỗi. Cột `drop` đọc rồi bỏ NGAY (không vào
 * record); cột lạ / trùng / thiếu bắt buộc → lỗi. */
export function records(
  it: Iterator<TableRow>,
  required: readonly string[],
  optional: readonly string[] = [],
  drop: readonly string[] = [],
): [[number, Rec][], string[]] {
  const first = it.next();
  if (first.done) return [[], ['file rỗng']];
  const header = first.value[1].map((h) => (h === null ? null : casefold(nfc(h))));
  const known = new Set([...required, ...optional]);
  const colOf = new Map<string, number>();
  const errs: string[] = [];
  const seen = new Set<string>();
  header.forEach((h, j) => {
    if (h === null) errs.push(`header cột ${j + 1} trống`);
    else if (seen.has(h)) errs.push(`header trùng: '${safe(h)}'`);
    else {
      seen.add(h);
      if (known.has(h)) colOf.set(h, j);
      else if (!drop.includes(h)) errs.push(`cột lạ '${safe(h)}' (ngoài template)`);
    }
  });
  const missing = required.filter((c) => !colOf.has(c));
  if (missing.length) errs.push(`thiếu cột bắt buộc: ${missing.join(', ')}`);
  if (errs.length) return [[], errs];
  const width = header.length;
  const recs: [number, Rec][] = [];
  for (let n = it.next(); !n.done; n = it.next()) {
    const [rowNo, cells] = n.value;
    if (cells.slice(width).some((c) => c !== null)) {
      errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
      continue;
    }
    const rec: Rec = {};
    for (const [c, j] of colOf) rec[c] = cells[j] ?? null;
    recs.push([rowNo, rec]);
  }
  if (!recs.length && !errs.length) return [[], ['file chỉ có header, không có dòng dữ liệu']];
  return [recs, errs];
}

/** `_parse_table` → [records, lỗi, sha]. */
export async function parseTable(
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
  drop: readonly string[] = [],
): Promise<[[number, Rec][], string[], string | null]> {
  const [data, sha, errs] = readBytes(path);
  if (errs.length) return [[], errs, sha];
  try {
    const [recs, e] = records(
      await table(data as Buffer, suffixOf(path)),
      required,
      optional,
      drop,
    );
    return [recs, e, sha];
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
}

const opt = (r: Rec, c: string): Cell => r[c] ?? null;

// ---------- Competitor ----------

export type CompRow = {
  row_no: number;
  competitor: string;
  channel: string;
  product_name: string;
  sku_key: string | null;
  price_vnd: number;
  promo_price_vnd: number | null;
  promo_text: string | null;
  /** numeric(2,1) dạng chữ "4.5" (Python Decimal). */
  rating: string | null;
  review_count: number | null;
  observed_on: string;
  source_ref: string;
};

/** rating "0–5, 1 số lẻ": "4,5" → "4.5"; "4.55"/"5.5" → null. */
function rating(s: string): string | null {
  const m = RATING_RE.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac.slice(1))) return null; // 4.55 → lượng hóa 0.1 đổi giá trị
  const r = `${m[1]}.${frac[0] ?? '0'}`;
  return r > '5.0' ? null : r;
}

/** `read_competitor` (thuần, không DB): CSV/XLSX đối thủ ghi tay → [rows, lỗi, sha]. */
export async function readCompetitor(
  path: string,
  today: string = todayVn(),
): Promise<[CompRow[], string[], string | null]> {
  const [recs, errs0, sha] = await parseTable(path, C_REQUIRED, C_OPTIONAL);
  if (errs0.length) return [[], errs0, sha];
  const errs: string[] = [];
  const limit = addDays(today, 1);
  const rows: CompRow[] = [];
  for (const [n, r] of recs) {
    const bad: string[] = [];
    const comp = text(r.doi_thu, 200);
    const name = text(r.ten_san_pham, 300);
    if (!comp) bad.push('doi_thu');
    if (!name) bad.push('ten_san_pham');
    const kenh = kw(r.kenh || '');
    if (!C_CHANNELS.includes(kenh)) bad.push('kenh');
    const price = toInt(r.gia_vnd, MAX_PRICE);
    if (!price) bad.push('gia_vnd');
    let promo: number | null = null;
    if (opt(r, 'gia_km_vnd') !== null) {
      promo = toInt(r.gia_km_vnd, MAX_PRICE);
      if (!promo || (price && promo >= price)) bad.push('gia_km_vnd');
    }
    let rate: string | null = null;
    if (opt(r, 'rating') !== null) {
      rate = rating(r.rating as string);
      if (rate === null) bad.push('rating');
    }
    let reviews: number | null = null;
    if (opt(r, 'so_danh_gia') !== null) {
      reviews = toInt(r.so_danh_gia, 2 * 10 ** 9);
      if (reviews === null) bad.push('so_danh_gia');
    }
    let nd = r.ngay_ghi;
    if (nd?.endsWith(' 00:00:00')) nd = nd.slice(0, -9); // ô ngày xlsx → datetime nửa đêm
    const day = isoDate(nd);
    if (day === null || day > limit) bad.push('ngay_ghi');
    const rawSrc = r.nguon || '';
    const src = text(rawSrc, 500);
    // kênh sàn: nguồn phải là link hoặc "ảnh chụp <tên file>"
    const onMarket =
      MARKETPLACES.includes(kenh) && !(URL_RE.test(src) || kw(src).startsWith('ảnh chụp'));
    if (!src || cpLen(rawSrc) > 500 || onMarket) bad.push('nguon');
    if (bad.length) {
      for (const c of bad) errs.push(`dòng ${n}: cột '${c}' không hợp lệ`);
      continue;
    }
    rows.push({
      row_no: n,
      competitor: comp,
      channel: kenh,
      product_name: name,
      sku_key: opt(r, 'sku_tuong_duong') ? clean(r.sku_tuong_duong, 100) : null,
      price_vnd: price as number,
      promo_price_vnd: promo,
      promo_text: opt(r, 'khuyen_mai') ? text(r.khuyen_mai, 200) || null : null,
      rating: rate,
      review_count: reviews,
      observed_on: day as string,
      source_ref: src,
    });
  }
  if (errs.length) return [[], errs, sha];
  return [rows, [], sha];
}

// ---------- Trend ----------

export type Spike = { window_weeks: number; ratio: number; min_delta: number };
export type TrendCfg = { anchor: string; keywords: Map<string, string>; spike: Spike };

/** Python `json.loads(path.read_bytes().decode("utf-8"))` → giá trị (số thực = PyFloat) | tên lỗi. */
export function readPyJson(path: string): { v: unknown } | { err: string } {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return { err: pyOsName(e) };
  }
  let txt: string;
  try {
    txt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return { err: 'UnicodeDecodeError' };
  }
  try {
    return { v: parsePyJson(txt) };
  } catch {
    return { err: 'JSONDecodeError' };
  }
}

/** `load_trend_config`: đọc `trend_keywords.json` fail-closed → [cfg chuẩn hóa | null, lỗi].
 * KHÁC Python có chủ đích: NaN/Infinity trong JSON → lỗi đọc (Python nhận rồi báo lỗi trường). */
export function loadTrendConfig(path: string = KEYWORDS_FILE): [TrendCfg | null, string[]] {
  const name = basename(path);
  const got = readPyJson(path);
  if ('err' in got) return [null, [`${name}: không đọc được (${got.err})`]];
  const raw = got.v;
  if (!isDict(raw)) return [null, [`${name}: gốc phải là object`]];
  const errs: string[] = [];
  const kws = new Map<string, string>();
  let src = raw.keywords;
  if (!isDict(src) || !Object.keys(src).length) {
    errs.push('keywords: rỗng hoặc sai kiểu');
    src = {};
  }
  for (const [k, g] of Object.entries(src as Record<string, unknown>)) {
    const nk = kw(k);
    if (!nk) errs.push('keywords: từ khóa rỗng');
    else if (typeof g !== 'string' || !TREND_GROUPS.includes(g)) {
      errs.push(`keywords.${clean(nk, 40)}: nhóm lạ (chỉ ${TREND_GROUPS.join('|')})`);
    } else if (kws.has(nk)) errs.push(`keywords.${clean(nk, 40)}: trùng`);
    else {
      if (g === 'gioi_tre' && isAlcohol(nk)) {
        errs.push(`keywords.${clean(nk, 40)}: từ khóa rượu không được thuộc nhóm gioi_tre`);
      }
      kws.set(nk, g);
    }
  }
  const anchor = typeof raw.anchor === 'string' ? kw(raw.anchor) : '';
  if (!anchor || !kws.has(anchor)) errs.push('anchor: thiếu hoặc không nằm trong keywords');
  const spike = raw.spike;
  const sp: Partial<Spike> = {};
  if (!isDict(spike)) errs.push('spike: thiếu');
  else {
    for (const key of ['window_weeks', 'ratio', 'min_delta'] as const) {
      const v = spike[key];
      // window_weeks: int (không bool/float); ratio/min_delta: int | float
      const num =
        typeof v === 'number' ? v : key !== 'window_weeks' && v instanceof PyFloat ? v.v : null;
      if (num === null || !(num > 0)) errs.push(`spike.${key}: phải là số > 0`);
      else sp[key] = num;
    }
  }
  if (errs.length) return [null, errs];
  return [{ anchor, keywords: kws, spike: sp as Spike }, []];
}

export type SpikeHit = { week: string; value: number; median: number; medianStr: string };

/** Python `str()` của trung vị `statistics.median`: số phần tử chẵn → float, lẻ → phần tử (int). */
export function pyNumStr(x: number, isFloat: boolean): string {
  if (!isFloat) return String(x);
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? x.toFixed(1) : String(x);
}

/** `find_spikes` (thuần): series = [(tuần, giá trị)] sắp theo tuần của CÙNG (query_id, keyword,
 * geo). Tuần có ≥ window tuần trước → m = trung vị window tuần liền trước; spike khi value ≥
 * ratio·m VÀ value − m ≥ min_delta (m = 0 → chỉ cần value ≥ min_delta). */
export function findSpikes<W>(
  series: readonly (readonly [W, number])[],
  window: number,
  ratio: number,
  minDelta: number,
): { week: W; value: number; median: number; medianStr: string }[] {
  const out: { week: W; value: number; median: number; medianStr: string }[] = [];
  for (let i = window; i < series.length; i++) {
    const xs = series
      .slice(i - window, i)
      .map((x) => x[1])
      .sort((a, b) => a - b);
    const h = xs.length >> 1;
    const even = xs.length % 2 === 0;
    const m = even ? ((xs[h - 1] as number) + (xs[h] as number)) / 2 : (xs[h] as number);
    const [w, v] = series[i] as readonly [W, number];
    if (m === 0 ? v >= minDelta : v >= ratio * m && v - m >= minDelta) {
      out.push({ week: w, value: v, median: m, medianStr: pyNumStr(m, even) });
    }
  }
  return out;
}

export type TimelineRow = { keyword: string; geo: string; week: string; value: number };
export type RelatedRow = { section: string; query: string; value: string; flags: string[] };
export type TrendKind = 'trend_timeline' | 'trend_related';

/** `read_trend` (thuần): file Google Trends xuất tay → [kind | null, rows, lỗi, sha]. */
export async function readTrend(
  path: string,
  cfg: TrendCfg,
): Promise<[TrendKind | null, TimelineRow[] | RelatedRow[], string[], string | null]> {
  const [data, sha, errs] = readBytes(path);
  if (errs.length) return [null, [], errs, sha];
  try {
    const it = await table(data as Buffer, suffixOf(path));
    let first: TableRow | null = null;
    for (let n = it.next(); !n.done; n = it.next()) {
      const cells = n.value[1];
      if (cells.length === 1 && cells[0]) {
        const k = kw(cells[0]);
        if (k.startsWith('category:') || k.startsWith('danh mục:')) continue;
      }
      first = n.value;
      break;
    }
    if (first === null) return [null, [], ['file rỗng'], sha];
    const c0 = kw(first[1][0] || '');
    if (c0 === 'week' || c0 === 'tuần') return ['trend_timeline', ...timeline(first, it, cfg), sha];
    if (['day', 'ngày', 'month', 'tháng'].includes(c0)) {
      return [
        null,
        [],
        [`dòng ${first[0]}: chỉ nhận chuỗi tuần (Week) — xuất lại với khoảng thời gian 1–5 năm`],
        sha,
      ];
    }
    if ((c0 === 'top' || c0 === 'rising') && first[1].length === 1) {
      return ['trend_related', ...related(first, it), sha];
    }
  } catch (e) {
    if (e instanceof TableError) return [null, [], [e.message], sha];
    throw e;
  }
  return [
    null,
    [],
    ['không nhận dạng được file Google Trends (multiTimeline / relatedQueries)'],
    sha,
  ];
}

function timeline(
  first: TableRow,
  it: Iterator<TableRow>,
  cfg: TrendCfg,
): [TimelineRow[], string[]] {
  const [hdrNo, hdr] = first;
  const errs: string[] = [];
  const kws: string[] = [];
  const geos = new Set<string>();
  if (!(hdr.length - 1 >= 1 && hdr.length - 1 <= MAX_KW_PER_FILE)) {
    errs.push(`dòng ${hdrNo}: cần 1–${MAX_KW_PER_FILE} cột từ khóa`);
  }
  hdr.slice(1).forEach((h0, i) => {
    const j = i + 2;
    const h = nfc(h0 || '');
    // trần độ dài TRƯỚC regex: `(.+?): \((.+)\)` trên ô khổng lồ lặp ": (" là O(n²) (gotcha DoS v1.4)
    const m = cpLen(h) <= MAX_HEADER ? TL_COL_RE.exec(h) : null;
    if (!m) {
      errs.push(`header cột ${j}: không đúng dạng '<từ khóa>: (<vùng>)'`);
      return;
    }
    const k = kw(m[1] as string);
    if (!cfg.keywords.has(k)) {
      errs.push(`header cột ${j}: từ khóa '${safe(k, 40)}' không có trong trend_keywords.json`);
    } else if (kws.includes(k)) errs.push(`header cột ${j}: từ khóa trùng`);
    kws.push(k);
    geos.add(clean(nfc(m[2] as string), 60));
  });
  if (geos.size > 1) errs.push('file có nhiều vùng — mỗi file 1 vùng');
  if (!kws.includes(cfg.anchor)) {
    errs.push(`thiếu neo '${cfg.anchor}' — luôn xuất kèm từ khóa neo`);
  }
  if (errs.length) return [[], errs];
  const geo = [...geos][0] as string;
  const rows: TimelineRow[] = [];
  const weeks = new Set<string>();
  for (let n = it.next(); !n.done; n = it.next()) {
    const [rowNo, cells] = n.value;
    if (cells.length > hdr.length) {
      errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
      continue;
    }
    const w = isoDate(cells[0]);
    if (w === null) {
      errs.push(`dòng ${rowNo}: cột 'Week' không phải ngày YYYY-MM-DD`);
      continue;
    }
    if (weeks.has(w)) {
      errs.push(`dòng ${rowNo}: tuần trùng`);
      continue;
    }
    weeks.add(w);
    kws.forEach((k, i) => {
      const j = i + 1;
      const v = j < cells.length ? cells[j] : null;
      const val = v === '<1' ? 0 : v && TL_VAL_RE.test(v) ? Number(v) : null;
      if (val === null || val > 100) {
        errs.push(`dòng ${rowNo}: cột ${j + 1} (${k}) không phải số 0–100`);
        return;
      }
      rows.push({ keyword: k, geo, week: w, value: val });
    });
  }
  if (!weeks.size && !errs.length) errs.push('file chỉ có header, không có dòng dữ liệu');
  return errs.length ? [[], errs] : [rows, []];
}

function related(first: TableRow, it: Iterator<TableRow>): [RelatedRow[], string[]] {
  let section = kw(first[1][0] as string);
  const rows: RelatedRow[] = [];
  const errs: string[] = [];
  for (let n = it.next(); !n.done; n = it.next()) {
    const [rowNo, cells] = n.value;
    if (cells.length === 1 && ['top', 'rising'].includes(kw(cells[0] || ''))) {
      section = kw(cells[0] as string);
      continue;
    }
    if (cells.length !== 2 || cells[0] === null || cells[1] === null) {
      errs.push(`dòng ${rowNo}: cần đúng 2 cột query,value`);
      continue;
    }
    const q = text(cells[0], 200);
    if (!q) {
      errs.push(`dòng ${rowNo}: cột query rỗng`);
      continue;
    }
    if (!REL_VAL_RE.test(cells[1] as string)) {
      errs.push(`dòng ${rowNo}: cột value không hợp lệ`);
      continue;
    }
    rows.push({
      section,
      query: q,
      value: cells[1] as string,
      flags: isAlcohol(q) ? ['ruou'] : [],
    });
  }
  if (!rows.length && !errs.length) {
    errs.push('file chỉ có tiêu đề section, không có dòng dữ liệu');
  }
  return errs.length ? [[], errs] : [rows, []];
}

// ---------- Social ----------

export type SocialRules = { dpia_signed: boolean; labels: Map<string, RegExp> };

/** `load_social_rules`: đọc `social_rules.json` fail-closed → [{dpia_signed, labels: nhãn → regex}
 * | null, lỗi]. */
export function loadSocialRules(path: string = RULES_FILE): [SocialRules | null, string[]] {
  const name = basename(path);
  const got = readPyJson(path);
  if ('err' in got) return [null, [`${name}: không đọc được (${got.err})`]];
  const raw = got.v;
  if (!isDict(raw)) return [null, [`${name}: gốc phải là object`]];
  const errs: string[] = [];
  if (typeof raw.dpia_signed !== 'boolean') errs.push('dpia_signed: phải là true/false');
  let labels = raw.labels;
  const pats = new Map<string, RegExp>();
  if (!isDict(labels) || !Object.keys(labels).length) {
    errs.push('labels: rỗng hoặc sai kiểu');
    labels = {};
  }
  for (const [lab, words] of Object.entries(labels as Record<string, unknown>)) {
    if (!S_RULE_LABELS.includes(lab)) {
      errs.push(`labels.${clean(lab, 30)}: nhãn lạ (chỉ ${S_RULE_LABELS.join('|')})`);
      continue;
    }
    if (
      !Array.isArray(words) ||
      !words.length ||
      !words.every((w) => typeof w === 'string' && pyStrip(w))
    ) {
      errs.push(`labels.${lab}: 0 từ khóa hoặc từ khóa rỗng`);
      continue;
    }
    // cụm dài trước (Python sắp theo độ dài giảm dần); chỉ `search` nên thứ tự không đổi kết quả.
    const ws = [...new Set((words as string[]).map(kw))].sort((a, b) => cpLen(b) - cpLen(a));
    pats.set(lab, kwRe(ws));
  }
  if (errs.length) return [null, errs];
  return [{ dpia_signed: raw.dpia_signed as boolean, labels: pats }, []];
}

/** `classify_social`: nhãn theo LUẬT trên text ĐÃ che PII. 0 nhãn → ['khac']. */
export function classifySocial(t0: string, rules: SocialRules): string[] {
  const t = kw(t0);
  const noPrice = sub(NOT_PRICE_RE, ' ', t);
  const labels = S_RULE_LABELS.filter((lab) => {
    const rx = rules.labels.get(lab);
    return rx?.test(lab === 'hoi_gia' ? noPrice : t) === true;
  });
  if (
    isHealthQuestion(t0) ||
    SOC_HEALTH_RE.test(t) ||
    (stripAccents(t) === t && SOC_HEALTH_ASCII_RE.test(t))
  ) {
    labels.push('hoi_suc_khoe');
  }
  if (isAlcohol(t0)) labels.push('hoi_ruou');
  return labels.length ? labels : ['khac'];
}

/** `msg_hash`: sha256 CÓ MUỐI — dedup giữa các file xuất chồng ngày mà không giữ ID/nội dung gốc. */
export const msgHash = (salt: string, channel: string, key: string): string =>
  createHash('sha256').update(`${salt}|${channel}|${key}`, 'utf8').digest('hex');

export type SocialRow = {
  row_no: number;
  kind: string;
  posted_at: string;
  /** vật liệu hash dedup (chỉ trong RAM, không ghi DB). */
  key: string;
  labels: string[];
  sensitive: boolean;
  excerpt: string | null;
};

/** Giới hạn tương lai của mốc thời gian: bây giờ + 1 ngày. */
export const futureLimit = (now: Date): number => now.getTime() + 86_400_000;

/** `read_social` (thuần): export comment/inbox kênh SỞ HỮU → [rows, lỗi, sha]. Cột định danh bỏ
 * NGAY khi đọc; noi_dung che SĐT/email trước mọi bước sau. */
export async function readSocial(
  path: string,
  _channel: string,
  rules: SocialRules,
  now: Date = new Date(),
): Promise<[SocialRow[], string[], string | null]> {
  const [recs, errs0, sha] = await parseTable(path, S_REQUIRED, S_OPTIONAL, S_IDENTITY_DROP);
  if (errs0.length) return [[], errs0, sha];
  const errs: string[] = [];
  const limit = futureLimit(now);
  const rows: SocialRow[] = [];
  for (const [n, r] of recs) {
    const bad: string[] = [];
    const ts = isoTs(r.thoi_gian);
    if (ts === null || ts.ms > limit) bad.push('thoi_gian');
    const kind = kw(opt(r, 'loai') || 'comment');
    if (!S_KINDS.includes(kind)) bad.push('loai');
    const t = text(r.noi_dung, PRE_MAX); // che NGAY khi đọc
    if (!t) bad.push('noi_dung');
    if (bad.length) {
      for (const c of bad) errs.push(`dòng ${n}: cột '${c}' không hợp lệ`);
      continue;
    }
    const labels = classifySocial(t, rules);
    const sensitive = labels.includes('hoi_suc_khoe');
    const key = opt(r, 'ma_tin')
      ? `id:${r.ma_tin}`
      : `u:${opt(r, 'id_nguoi_dung') || ''}|${r.thoi_gian}|${t}`;
    rows.push({
      row_no: n,
      kind,
      posted_at: (ts as Ts).iso,
      key,
      labels,
      sensitive,
      excerpt: rules.dpia_signed === true && !sensitive ? cpHead(t, 200) : null,
    });
  }
  if (errs.length) return [[], errs, sha];
  return [rows, [], sha];
}

// ------------------------------------------------------------------------------------- DB

/** Python `round(x, nd)` (làm tròn giá trị NHỊ PHÂN chính xác, hòa → số chẵn). */
export function pyRound(x: number, nd: number): number {
  return Number(pyFixed(x, nd));
}

export async function newImport(
  db: Db,
  kind: string,
  channel: string | null,
  fileName: string,
  sha: string,
  n: number,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    'insert into intel_imports (kind, channel, file_name, file_sha256, row_count) values ($1, $2, $3, $4, $5) returning id',
    [kind, channel, fileName, sha, n],
  );
  return Number(rows[0]?.id);
}

/** `load_competitor`: kiểm SKU tương đương có trong golden TRƯỚC khi ghi (thiếu → lỗi, không ghi
 * gì) rồi insert (không commit). */
export async function loadCompetitor(
  db: Db,
  rows: CompRow[],
  fileName: string,
  sha: string,
): Promise<[number | null, string[]]> {
  const keys = [...new Set(rows.map((r) => r.sku_key).filter((k): k is string => !!k))].sort(cpCmp);
  const have = new Set<string>();
  if (keys.length) {
    const { rows: got } = await db.query<{ sku_key: string }>(
      'select sku_key from sku_master where sku_key = any($1)',
      [keys],
    );
    for (const g of got) have.add(g.sku_key);
  }
  const errs = rows
    .filter((r) => r.sku_key && !have.has(r.sku_key))
    .map((r) => `dòng ${r.row_no}: sku_tuong_duong không có trong golden`);
  if (errs.length) return [null, errs];
  const iid = await newImport(db, 'competitor', null, fileName, sha, rows.length);
  for (const r of rows) {
    await db.query(
      'insert into competitor_observations (import_id, row_no, competitor, channel, product_name, sku_key, price_vnd, promo_price_vnd, promo_text, rating, review_count, observed_on, source_ref) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [
        iid,
        r.row_no,
        r.competitor,
        r.channel,
        r.product_name,
        r.sku_key,
        r.price_vnd,
        r.promo_price_vnd,
        r.promo_text,
        r.rating,
        r.review_count,
        r.observed_on,
        r.source_ref,
      ],
    );
  }
  return [iid, []];
}

export async function loadTrendTimeline(
  db: Db,
  rows: TimelineRow[],
  cfg: TrendCfg,
  fileName: string,
  sha: string,
): Promise<number> {
  const iid = await newImport(
    db,
    'trend_timeline',
    null,
    fileName,
    sha,
    new Set(rows.map((r) => r.week)).size,
  );
  for (const r of rows) {
    await db.query(
      'insert into trends_weekly (import_id, query_id, keyword, anchor, geo, week, value) values ($1, $2, $3, $4, $5, $6, $7)',
      [iid, sha.slice(0, 16), r.keyword, cfg.anchor, r.geo, r.week, r.value],
    );
  }
  return iid;
}

export async function loadTrendRelated(
  db: Db,
  rows: RelatedRow[],
  seed: string,
  fileName: string,
  sha: string,
): Promise<number> {
  const iid = await newImport(db, 'trend_related', null, fileName, sha, rows.length);
  for (const r of rows) {
    await db.query(
      'insert into trends_related (import_id, seed, section, query, value, flags) values ($1, $2, $3, $4, $5, $6)',
      [iid, seed, r.section, r.query, r.value, r.flags],
    );
  }
  return iid;
}

/** `load_social` → [import_id, mới, trùng]. Dedup theo msg_hash (on conflict do nothing). */
export async function loadSocial(
  db: Db,
  rows: SocialRow[],
  channel: string,
  salt: string,
  fileName: string,
  sha: string,
): Promise<[number, number, number]> {
  const iid = await newImport(db, 'social', channel, fileName, sha, rows.length);
  let fresh = 0;
  for (const r of rows) {
    const { rows: got } = await db.query(
      'insert into social_mentions (import_id, channel, kind, posted_at, msg_hash, labels, sensitive, excerpt) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (msg_hash) do nothing returning id',
      [
        iid,
        channel,
        r.kind,
        r.posted_at,
        msgHash(salt, channel, r.key),
        r.labels,
        r.sensitive,
        r.excerpt,
      ],
    );
    if (got.length) fresh++;
  }
  return [iid, fresh, rows.length - fresh];
}

export type Gap = {
  week: string;
  competitor: string;
  channel: string;
  product_name: string;
  sku_key: string;
  observed_on: string;
  price_vnd: number;
  promo_price_vnd: number | null;
  obs_ref: string;
  source_ref: string;
  golden_vnd: number | null;
  golden_ref: string | null;
  golden_channel: string | null;
  golden_approved: boolean | null;
  gap_pct: number | null;
  note: string | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** `competitor_gaps`: lệch giá/KM đối thủ so giá `list` golden (CHỈ ĐỌC) trong tuần [thứ Hai, Chủ
 * nhật] chứa `weekStart`. Golden = dòng hiệu lực tại ngày quan sát, ưu tiên cùng kênh (nếu kênh có
 * trong golden) rồi `web`. Mỗi con số kèm nguồn. Không có "giá nên đặt". */
export async function competitorGaps(db: Db, weekStart: string): Promise<Gap[]> {
  const mon = addDays(weekStart, -weekday(weekStart));
  const sun = addDays(mon, 6);
  const { rows } = await db.query(
    'select o.id, o.competitor, o.channel, o.product_name, o.sku_key,' +
      ' o.price_vnd, o.promo_price_vnd, o.source_ref, o.observed_on::text as observed_on,' +
      ' g.id as gid, g.price_vnd as gprice, g.approved_by as gby, g.channel as gch' +
      ' from competitor_observations o left join lateral (' +
      '  select p.id, p.price_vnd, p.approved_by, p.channel' +
      '  from price_list p where p.sku_key = o.sku_key' +
      "  and p.kind = 'list' and p.program_id is null" +
      '  and p.valid_from <= o.observed_on' +
      '  and (p.valid_to is null or p.valid_to > o.observed_on)' +
      '  and p.channel in (case when o.channel = any($1) then o.channel' +
      "   else 'web' end, 'web')" +
      '  order by (p.channel = o.channel) desc, p.valid_from desc,' +
      '   p.id desc limit 1) g on true' +
      ' where o.sku_key is not null' +
      ' and o.observed_on between $2 and $3' +
      ' order by o.observed_on, o.competitor, o.channel,' +
      ' o.product_name, o.id',
    [GOLDEN_CHANNELS, mon, sun],
  );
  return rows.map((r) => {
    const price = Number(r.price_vnd);
    const promo = num(r.promo_price_vnd);
    const gprice = num(r.gprice);
    const has = r.gid !== null;
    const eff = promo || price;
    return {
      week: mon,
      competitor: r.competitor,
      channel: r.channel,
      product_name: r.product_name,
      sku_key: r.sku_key,
      observed_on: r.observed_on,
      price_vnd: price,
      promo_price_vnd: promo,
      obs_ref: `obs#${r.id}`,
      source_ref: r.source_ref,
      golden_vnd: gprice,
      golden_ref: has ? `price_list#${r.gid}` : null,
      golden_channel: r.gch ?? null,
      golden_approved: has ? r.gby !== null : null,
      gap_pct: gprice ? pyRound(eff / gprice - 1, 3) : null,
      note: has ? null : 'chưa có giá golden',
    };
  });
}
