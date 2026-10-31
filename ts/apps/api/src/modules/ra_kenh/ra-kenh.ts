import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, loadConfig as loadDirector, submit } from '@samsam/core/ops/director';
import { vnDate, vnFormat } from '@samsam/core/ops/period';
import { CsvError, CsvReader } from '@samsam/core/ops/py-csv';
import { hostname, urlsplit } from '@samsam/core/ops/py-url';
import { raiseAlert } from '@samsam/core/ops/red-alert';
import { contentSha256, verifyPublish } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { DATA_DIR } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { blocked, checkGenerate, EXIT_BLOCKED } from '@samsam/core/rollout/rollout';
import { callHuman } from '@samsam/core/security/auth';
import { check, checkPublish } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import {
  casefold,
  cpHead,
  cpLen,
  pyRepr,
  pySplit,
  pyStr,
  pyStrip,
  pyTruthy,
} from '@samsam/core/security/py';
import { contentCfg } from '../kd_listing_live/content-lite.js';
import * as fanpage from '../messenger_fanpage/fanpage.js';
import * as xnqc from './xnqc-read.js';

// v4.3 PC-A4 (WP05, legal_hr-04) — port `agents/ra_kenh.py`: rà bài ĐANG ĐĂNG trên kênh SỞ HỮU +
// ticket gỡ/sửa 24h + báo cáo Pháp chế tuần. Luồng: Quản lý MXH xuất tay danh sách bài (CSV) →
// `readExport` kiểm TOÀN file trước khi connect → `scanRow` chạy `checkPublish` theo kênh →
// `ingest` lưu snapshot `channel_posts`, đối chiếu bản đã duyệt (`verifyPublish`), mở 1 mục hàng
// duyệt (`director.submit`) cho mỗi "đợt vi phạm" của URL với hạn 24 giờ ĐỒNG HỒ THẬT (gồm
// T7/CN/Tết), S1 → `red_alerts`.
//
// Ranh giới (agent CHỈ phát hiện + đề xuất): KHÔNG gỡ/sửa/ẩn bài, KHÔNG gọi API kênh ngoài đường
// ĐỌC bài Fanpage của `--scan-auto`; KHÔNG ghi thẳng bảng duyệt/golden — mọi mục hàng duyệt/cảnh
// báo qua `director.submit` / `raiseAlert`. Duyệt mục = Pháp chế xác nhận lệnh gỡ/sửa, KHÔNG đóng
// vi phạm: chỉ đóng khi bản xuất lại SẠCH (`da_sua`) hoặc NGƯỜI ghi nhận đã gỡ (`da_go`). Payload
// ticket KHÔNG chép đoạn vi phạm; đoạn trích in ra luôn qua `maskPii`, ≤160 ký tự.
//
// Đợt vi phạm theo URL: vi phạm khi URL chưa có dòng mở → hạn now+24h + 1 mục; vi phạm CÙNG LOẠI
// (nội dung↔nội dung, hạ tầng↔hạ tầng) khi đã có đợt mở → kế thừa hạn/mục/cảnh báo (đồng hồ KHÔNG
// reset), dòng cũ `thay_ban_moi`; đổi loại → đóng đợt cũ + mở đợt mới đúng khối; sạch → `da_sua`
// (+1 `agent_action_log` `channel_post_fixed`). URL vắng trong file mới → giữ nguyên (vắng ≠ đã
// gỡ). Nạp lại → bỏ qua CHỈ khi sha text + cột bài + kết quả rà trùng snapshot mới nhất.
//
// Ngày dạng chuỗi 'YYYY-MM-DD' (như `ops/period`); `draft_id` dạng chuỗi số (bigint không mất chính
// xác); thời điểm = Date. Khóa dict giữ snake_case như Python/cột DB.

export const CONFIG = join(DATA_DIR, 'phap_che.json');
export const AGENT = 'agent:phap_che_a4';
export const SLA_MS = 24 * 3600_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 2000;
export const MAX_TEXT = 20_000;
export const EXCERPT = 160;
export const MAX_BY = 100;
/** BYTE UTF-8, không phải ký tự: btree `channel_posts_url_idx` giới hạn 2704 byte/dòng. */
export const MAX_URL = 2048;
export const BIGINT_MAX = 2n ** 63n - 1n;
export const REQUIRED = ['url', 'kenh', 'is_ai', 'text'];
export const OPTIONAL = ['loai_noi_dung', 'ngay_dang', 'draft_id', 'sku', 'is_sponsored'];
export const HOSTING = 'trang_mac_dinh_hosting';
export const LECH = 'lech_ban_duyet';
export const THIEU = 'thieu_ban_duyet';
export const AUTO_BY = AGENT;
export const FEATURE = 'legal_hr-04';
export const WEB_FILES = ['articles', 'news', 'products'];
export const WEB_MAX_AGE_DAYS = 7;
export const HIDDEN = '(ẩn: trượt guardrail)';

// Python `\d` (Unicode) — ngày Unicode lọt regex rồi trượt `date.fromisoformat` (ASCII) → cùng lỗi.
const DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;
const ISO_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const ASCII_WS_LINE = /^[ \t\n\r\v\f]*$/;
const LONE_SURROGATE = /\p{Cs}/u;
// cờ `u`: gập hoa/thường Unicode như Python re.IGNORECASE (`ſystem:` = `system:`)
const BY_AGENT_RE = /^\s*(agent|system)\s*:/iu;
const CTRL_CF = /[\p{Cc}\p{Cf}]/u;
const CTRL_CF_G = /[\p{Cc}\p{Cf}]/gu;
// Python `ch.isspace() or category(ch)[0] == "C"` = JS `\s` ∪ `\p{C}` (như `fanpage.postUrl`).
const SPACE_OR_C = /[\s\p{C}]/u;

export type Dict = Record<string, unknown>;

// ------------------------------------------------------------------ chung

/** Luật `--by` = tên NGƯỜI: rỗng / ký tự điều khiển / 'agent:'/'system:' → lý do từ chối. */
export function byError(by: unknown): string | null {
  if (typeof by !== 'string' || !pyStrip(by)) return 'thiếu tên người (--by)';
  if (CTRL_CF.test(by)) return '--by chứa ký tự điều khiển';
  if (BY_AGENT_RE.test(by)) return "--by phải là tên NGƯỜI — không nhận 'agent:'/'system:'";
  if (cpLen(pyStrip(by)) > MAX_BY) return `--by dài quá ${MAX_BY} ký tự`;
  return null;
}

/** In tên/chuỗi từ DB: thay ký tự điều khiển (chống giả dòng log). */
export function safe(s: unknown): string {
  return (s === null || s === undefined ? '' : pyStr(s)).replace(CTRL_CF_G, '?');
}

/** Chuỗi chép vào trang TGĐ/bản tin: tự nó trượt guardrail (slug `...-chua-...`) → `alt`. */
export function pageSafe(s: string, alt: string = HIDDEN): string {
  return check(s).ok === true ? s : alt;
}

/** Python `date.fromisoformat` cho 'YYYY-MM-DD' → chuỗi ngày | null (ngày không có thật). */
export function isoDay(s: string): string | null {
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(2000, mo, 0)).getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (d > (mo === 2 ? (leap ? 29 : 28) : dim)) return null;
  return s;
}

function isoDate(v: unknown, what: string): string {
  const s = typeof v === 'string' ? pyStrip(v) : null;
  if (s === null || !DATE_RE.test(s)) throw new RangeError(`${what}: cần ngày YYYY-MM-DD`);
  const m = ISO_DAY.exec(s);
  if (!m) throw new RangeError(`Invalid isoformat string: ${pyRepr(s)}`);
  // thông điệp như `date.fromisoformat` của Python
  if (Number(m[1]) < 1) throw new RangeError(`year ${Number(m[1])} is out of range`);
  if (Number(m[2]) < 1 || Number(m[2]) > 12) throw new RangeError('month must be in 1..12');
  const d = isoDay(s);
  if (d === null) throw new RangeError('day is out of range for month');
  return d;
}

/** ISO → thời điểm; thiếu múi giờ → giờ VN (+07:00). Sai → RangeError (ValueError). shortcut: chỉ
 * dạng `YYYY-MM-DD[(T| )HH:MM[:SS[.f{1,6}]]][Z|±HH[:]MM]` (Python 3.12 nhận thêm dạng gọn
 * `YYYYMMDD`/`HHMMSS`) — nâng khi người vận hành cần. */
export function parseNow(s: unknown): Date {
  const t = pyStrip(String(s ?? ''));
  const m =
    /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$/.exec(
      t,
    );
  const day = m ? isoDay(m[1] as string) : null;
  if (!m || day === null) throw new RangeError(`Invalid isoformat string: ${pyStr(t)}`);
  const [h, mi, se] = [Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (h > 23 || mi > 59 || se > 59) throw new RangeError('time out of range');
  const ms = m[5] ? Math.floor(Number(`0.${m[5]}`) * 1000) : 0;
  let off = 7 * 60;
  if (m[6] === 'Z') off = 0;
  else if (m[6]) {
    const z = m[6].replace(':', '');
    const oh = Number(z.slice(1, 3));
    const om = Number(z.slice(3, 5));
    if (om > 59 || oh > 23) throw new RangeError('offset out of range');
    off = (z[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms) - off * 60_000);
}

function aware(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('now phải là datetime có múi giờ');
  }
  return now;
}

/** Thời điểm → 'dd/mm/YYYY HH:MM' giờ VN; null → '—'. */
export function vn(dt: Date | null | undefined): string {
  return dt ? vnFormat(dt, '%d/%m/%Y %H:%M') : '—';
}

/** data/phap_che.json thiếu/hỏng — fail-closed (Python ValueError). */
export class ConfigError extends RangeError {}

export type PhapCheCfg = {
  dot2_han_nop: string;
  quy_trinh_duyet_tu: string;
  nhac_truoc_ngay: number;
  het_han_canh_bao_ngay: number;
  owned_web_hosts: string[];
  hosting_default_markers: string[];
};

const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tên lớp OSError của Python theo mã lỗi Node. */
export function osErrName(e: unknown): string {
  const code = (e as { code?: string }).code;
  return code === 'EISDIR'
    ? 'IsADirectoryError'
    : code === 'EACCES' || code === 'EPERM'
      ? 'PermissionError'
      : 'OSError';
}

function pyErrName(e: unknown): string {
  return e instanceof SyntaxError ? 'JSONDecodeError' : 'UnicodeDecodeError';
}

/** data/phap_che.json → cấu hình phẳng đã kiểm. Thiếu/hỏng/`{}`/chỉ `_doc`/ngày sai/số âm/list
 * rỗng → RangeError (fail-closed). */
export function loadConfig(path: string = CONFIG): PhapCheCfg {
  const name = basename(path);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw new RangeError(`không có file ${name}`);
    throw new RangeError(`${name} hỏng: ${osErrName(e)}`);
  }
  let doc: unknown;
  try {
    let s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    if (s.startsWith('\ufeff')) s = s.slice(1);
    doc = JSON.parse(s);
  } catch (e) {
    throw new RangeError(`${name} hỏng: ${pyErrName(e)}`);
  }
  if (!isObj(doc)) throw new ConfigError(`${name}: không phải object JSON`);
  const x = doc.xnqc;
  const r = doc.ra_kenh;
  if (!isObj(x) || !isObj(r)) throw new ConfigError(`${name}: thiếu khối 'xnqc'/'ra_kenh'`);
  const cfg = {
    dot2_han_nop: isoDate(x.dot2_han_nop, 'dot2_han_nop'),
    quy_trinh_duyet_tu: isoDate(r.quy_trinh_duyet_tu, 'quy_trinh_duyet_tu'),
  } as PhapCheCfg;
  for (const k of ['nhac_truoc_ngay', 'het_han_canh_bao_ngay'] as const) {
    const v = x[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new RangeError(`${k}: cần số nguyên ≥ 0`);
    }
    cfg[k] = v;
  }
  for (const k of ['owned_web_hosts', 'hosting_default_markers'] as const) {
    const v = r[k];
    if (
      !Array.isArray(v) ||
      !v.length ||
      !v.every((s) => typeof s === 'string' && pyStrip(s) !== '')
    ) {
      throw new RangeError(`${k}: cần list chuỗi không rỗng`);
    }
    cfg[k] = (v as string[]).map((s) => casefold(pyStrip(s).normalize('NFC')));
  }
  cfg.owned_web_hosts = cfg.owned_web_hosts.map((h) => (h.startsWith('www.') ? h.slice(4) : h));
  return cfg;
}

export type Rules = {
  golden: Map<string, unknown>;
  contentTypes: Record<string, unknown>;
  channels: unknown[];
  channelAlias: Record<string, unknown>;
};

/** Luật guardrail (kênh/alias/loại nội dung/golden) — CHỈ đọc; hỏng → RangeError. */
export function rules(): Rules {
  const [cfg, err] = contentCfg(DATA_DIR);
  if (err !== null || cfg === null) throw new RangeError(err ?? 'guardrail');
  return cfg as unknown as Rules;
}

/** Python `rules["channel_alias"].get(ch, ch)` + `ch in rules["channels"]`. */
export function normChannel(raw: string, r: Rules): [string, boolean] {
  let ch = pyStrip(raw).toLowerCase();
  if (Object.hasOwn(r.channelAlias, ch)) ch = r.channelAlias[ch] as string;
  return [ch, r.channels.includes(ch)];
}

// ------------------------------------------------------------------ URL (Python urlsplit)

/** `urlsplit(url)` → [scheme, hostname thường | ''] | null khi Python ném ValueError. */
export function splitUrl(url: string): [string, string] | null {
  try {
    const u = urlsplit(url);
    return [u.scheme, hostname(u.netloc) ?? ''];
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ đọc file

/** File xuất tay không hợp lệ: danh sách 'dòng N cột X: lý do' — KHÔNG kèm giá trị ô. */
export class ExportError extends RangeError {
  constructor(public readonly errors: string[]) {
    super(`${errors.length} lỗi`);
  }
}

function flag01(v: string, empty: boolean): boolean | null {
  const s = pyStrip(v);
  if (s === '') return empty;
  return s === '0' ? false : s === '1' ? true : null;
}

export type Row = {
  line: number | null;
  url: string;
  channel: string;
  content_type: string;
  posted_on: string | null;
  draft_id: string | null;
  sku: string | null;
  is_ai: boolean;
  is_sponsored: boolean;
  text: string;
  sha: string;
  require_draft?: boolean;
  text_is_post?: boolean;
  approval_codes?: string[];
};

/** Đọc file CSV (đuôi/kích thước/UTF-8/CSV hỏng/header) → [header, các dòng có chữ]. Dùng chung
 * cho file kênh sở hữu và file bài đối tác. */
export function readCsvFile(path: string): string {
  if (extname(path).toLowerCase() !== '.csv') throw new ExportError(['chỉ nhận file .csv']);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not file');
    size = st.size;
  } catch {
    throw new ExportError(['không có file']);
  }
  if (size > MAX_BYTES) {
    throw new ExportError([`file lớn hơn ${Math.floor(MAX_BYTES / 1024 / 1024)} MB`]);
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch {
    throw new ExportError(['file không phải UTF-8']);
  }
  return raw.startsWith('\ufeff') ? raw.slice(1) : raw;
}

function csvRecords(raw: string): string[][] {
  try {
    return [...new CsvReader(raw)];
  } catch (e) {
    if (e instanceof CsvError) throw new ExportError([`CSV hỏng (${e.name})`]);
    throw e;
  }
}

/** Kiểm URL 1 ô → [url, host | '', lỗi | null] (chung kênh sở hữu + đối tác). */
function checkUrl(cell: string, maxHost: number | null): [string, string, string | null] {
  const url = pyStrip(cell);
  const tooLong = Buffer.byteLength(url, 'utf8') > MAX_URL;
  const parts = url && !tooLong ? splitUrl(url) : null;
  const host = parts ? parts[1] : '';
  if (tooLong) return [url, host, `dài quá ${MAX_URL} byte UTF-8`];
  if (
    !parts ||
    !['http', 'https'].includes(parts[0]) ||
    !host ||
    (maxHost !== null && cpLen(host) > maxHost) ||
    SPACE_OR_C.test(url)
  ) {
    return [url, host, 'cần URL http(s) có host, không khoảng trắng/ký tự điều khiển'];
  }
  return [url, host, null];
}

/** Header + thân chung: lỗi header (rỗng/trùng/cột lạ/thiếu) do caller dựng; trả các dòng có chữ. */
function bodyRows(recs: string[][]): [number, string[]][] {
  const body: [number, string[]][] = [];
  recs.slice(1).forEach((r, i) => {
    if (r.some((c) => pyStrip(c) !== '')) body.push([i + 2, r]);
  });
  if (!body.length) throw new ExportError(['file không có dòng bài nào']);
  if (body.length > MAX_ROWS) throw new ExportError([`quá ${MAX_ROWS} dòng`]);
  return body;
}

function counter(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** Đọc + kiểm TOÀN file xuất tay TRƯỚC khi connect. Lỗi → ExportError. */
export function readExport(path: string, cfg: PhapCheCfg): Row[] {
  const raw = readCsvFile(path);
  const r = rules();
  const recs = csvRecords(raw);
  if (!recs.length) throw new ExportError(['file rỗng']);
  const head = (recs[0] as string[]).map((h) => pyStrip(h).toLowerCase());
  const errs: string[] = [];
  if (head.some((h) => !h)) errs.push('dòng 1: có cột header rỗng');
  // tên cột in ra: mask + cắt, tối đa 10 tên (header rộng)
  const names = (hs: string[]) => {
    const more = hs.length > 10 ? ` (+${hs.length - 10})` : '';
    return `${pyStr(hs.slice(0, 10).map((h) => cpHead(maskPii(h), 40)))}${more}`;
  };
  const dup = pySorted([...counter(head)].filter(([h, k]) => h && k > 1).map(([h]) => h));
  if (dup.length) errs.push(`dòng 1: header trùng ${names(dup)}`);
  const known = [...REQUIRED, ...OPTIONAL];
  const stray = head.filter((h) => h && !known.includes(h));
  if (stray.length) {
    errs.push(
      `dòng 1: cột lạ ${names(stray)} — chỉ nhận bài của công ty, không bình luận/người tương tác`,
    );
  }
  const miss = REQUIRED.filter((c) => !head.includes(c));
  if (miss.length) errs.push(`dòng 1: thiếu cột bắt buộc ${pyStr(miss)}`);
  if (errs.length) throw new ExportError(errs);
  const body = bodyRows(recs);
  const out: Row[] = [];
  const seen = new Map<string, number>();
  for (const [n, row] of body) {
    if (row.length !== head.length) {
      errs.push(`dòng ${n}: số ô ${row.length} ≠ số cột ${head.length}`);
      continue;
    }
    const c = new Map(head.map((h, i) => [h, row[i] as string]));
    const bad = (col: string, why: string) => errs.push(`dòng ${n} cột ${col}: ${why}`);
    for (const [col, v] of c) if (v.includes('\x00')) bad(col, 'chứa ký tự NUL');
    const [url, host, uerr] = checkUrl(c.get('url') as string, null);
    if (uerr) bad('url', uerr);
    else if (seen.has(url)) bad('url', `trùng URL với dòng ${seen.get(url)} (mơ hồ)`);
    if (!seen.has(url)) seen.set(url, n);
    const [ch, okCh] = normChannel(c.get('kenh') as string, r);
    if (!okCh) bad('kenh', `kênh không hợp lệ — nhận ${pyStr(r.channels)}`);
    else if (
      ch === 'web' &&
      host &&
      !cfg.owned_web_hosts.includes(host.startsWith('www.') ? host.slice(4) : host)
    ) {
      bad('url', 'host web không thuộc danh sách website sở hữu');
    }
    const ct = pyStrip(c.get('loai_noi_dung') ?? '') || 'post';
    const spec = Object.hasOwn(r.contentTypes, ct) ? r.contentTypes[ct] : undefined;
    if (spec === undefined) bad('loai_noi_dung', 'loại nội dung không hợp lệ');
    else if (isObj(spec) && Object.hasOwn(spec, 'public') && !spec.public) {
      // internal_note bỏ luật rượu — bài trên kênh luôn công khai
      bad('loai_noi_dung', 'loại nội bộ — bài đang đăng luôn công khai');
    }
    const isAi = flag01(c.get('is_ai') as string, true);
    if (isAi === null) bad('is_ai', 'chỉ nhận 0/1 (trống = 1)');
    const spon = flag01(c.get('is_sponsored') ?? '', false);
    if (spon === null) bad('is_sponsored', 'chỉ nhận 0/1 (trống = 0)');
    let posted: string | null = null;
    let d = pyStrip(c.get('ngay_dang') ?? '');
    if (d) {
      try {
        posted = isoDate(d, 'ngay_dang');
      } catch {
        bad('ngay_dang', 'cần ngày YYYY-MM-DD hợp lệ');
      }
    }
    let did: string | null = null;
    d = pyStrip(c.get('draft_id') ?? '');
    if (d) {
      // ≤19 chữ số ASCII trước khi đổi số; > bigint → lỗi DB
      if (/^[0-9]{1,19}$/.test(d) && BigInt(d) > 0n && BigInt(d) <= BIGINT_MAX) {
        did = String(BigInt(d));
      } else bad('draft_id', 'cần số nguyên 1..2^63-1');
    }
    const sku = pyStrip(c.get('sku') ?? '') || null;
    if (sku !== null && !r.golden.has(sku)) bad('sku', 'SKU không có trong golden');
    const text = (c.get('text') as string).replaceAll('\r\n', '\n');
    if (!pyStrip(text)) bad('text', 'rỗng');
    else if (cpLen(text) > MAX_TEXT) bad('text', `dài quá ${MAX_TEXT} ký tự`);
    out.push({
      line: n,
      url,
      channel: ch,
      content_type: ct,
      posted_on: posted,
      draft_id: did,
      sku,
      is_ai: isAi as boolean,
      is_sponsored: spon as boolean,
      text,
      sha: contentSha256(text),
    });
  }
  if (errs.length) throw new ExportError(errs);
  return out;
}

export { bodyRows, checkUrl, counter, csvRecords };

// ------------------------------------------------------------------ rà 1 bài

type Viol = { code?: unknown; severity?: unknown; start?: unknown; end?: unknown };

/** Chỉ số code point → UTF-16 trong `s`. */
function u16(s: string, cp: number): number {
  let i = 0;
  let k = 0;
  while (k < cp && i < s.length) {
    const c = s.codePointAt(i) as number;
    i += c > 0xffff ? 2 : 1;
    k++;
  }
  return i;
}
/** Python `s[a:b]` theo code point (a, b ≥ 0). */
const cpSlice = (s: string, a: number, b?: number): string =>
  s.slice(u16(s, a), b === undefined ? undefined : u16(s, b));
/** Python `s.find(sub, start)` theo code point. */
function cpFind(s: string, sub: string, start = 0): number {
  const i = s.indexOf(sub, u16(s, start));
  return i < 0 ? -1 : cpLen(s.slice(0, i));
}
const isPyInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Đoạn trích ≤160 ký tự quanh vi phạm. Che PII TOÀN văn rồi mới cắt — cắt trước thì SĐT vắt mép
 * cửa sổ còn nửa số, regex không bắt → lộ. */
export function excerpt(text: string, v: Viol | null): string {
  const masked = maskPii(text);
  const s = v ? v.start : null;
  let i = -1;
  let snip = '';
  if (isPyInt(s) && s >= 0 && s < cpLen(text)) {
    const e = isPyInt(v?.end) ? (v?.end as number) : s + 1;
    snip = cpSlice(text, s, Math.max(e, s + 1));
    // vị trí trong bản đã che ≈ độ dài bản che của phần trước (±40)
    i = cpFind(masked, snip, Math.max(0, cpLen(maskPii(cpSlice(text, 0, s))) - 40));
    if (i < 0) i = cpFind(masked, snip);
  }
  const piece =
    i >= 0
      ? cpSlice(masked, Math.max(0, i - 60), i + cpLen(snip) + 60)
      : cpSlice(masked, 0, EXCERPT * 2);
  return cpHead(safe(pySplit(piece).join(' ')), EXCERPT);
}

export type Scan = {
  codes: string[];
  severity: 'S1' | 'S2' | null;
  kind: 'content' | 'hosting';
  guardrail: Dict;
  excerpt: string;
};

/** Điểm thay cho test (Python monkeypatch `guardrail.check_publish` / `ra_kenh._link`). */
export const hooks = {
  checkPublish: checkPublish as (text: unknown, opts: Parameters<typeof checkPublish>[1]) => Dict,
  link: null as null | ((db: Db, postId: string, dcfg: Dcfg, st: Stats) => Promise<void>),
};

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** 1 bài → {codes, severity, kind, guardrail, excerpt}. THUẦN (không DB) — lệch bản duyệt thêm ở
 * `ingest`. LUÔN chạy `checkPublish`; dấu hiệu trang mặc định hosting chỉ xét kênh `web` và chỉ
 * thành mục hạ tầng khi KHÔNG có vi phạm nội dung — có vi phạm thì đi nhánh nội dung + nối code. */
export function scanRow(row: Row, cfg: PhapCheCfg): Scan {
  const text = row.text;
  const g = hooks.checkPublish(text, {
    channel: row.channel,
    contentType: row.content_type,
    sku: row.sku ?? null,
    isAi: row.is_ai,
    isSponsored: row.is_sponsored,
  });
  const viols = (Array.isArray(g.violations) ? g.violations : []) as Viol[];
  const folded = casefold(text.normalize('NFC'));
  const marker =
    row.channel === 'web' && cfg.hosting_default_markers.some((m) => folded.includes(m));
  if (marker && !viols.length) {
    return {
      codes: [HOSTING],
      severity: 'S2',
      kind: 'hosting',
      guardrail: { ...g, hosting_marker: true },
      excerpt: excerpt(text, null),
    };
  }
  const codes = uniq(viols.map((v) => v.code as string));
  const posted = row.posted_on;
  if (
    (row.require_draft ?? true) &&
    row.draft_id === null &&
    (posted === null || posted >= cfg.quy_trinh_duyet_tu)
  ) {
    codes.push(THIEU); // không rõ ngày = coi như bài mới (fail-closed)
  }
  if (marker) codes.push(HOSTING);
  const crit = viols.filter((v) => v.severity === 'critical');
  const sev = crit.length ? 'S1' : codes.length ? 'S2' : null;
  return {
    codes,
    severity: sev,
    kind: 'content',
    guardrail: marker ? { ...g, hosting_marker: true } : g,
    excerpt: excerpt(text, crit[0] ?? viols[0] ?? null),
  };
}

// ------------------------------------------------------------------ DB

const APPROVAL_CODES = [THIEU, LECH];
const HUMAN_COLS = ['content_type', 'posted_on', 'is_ai', 'is_sponsored', 'sku', 'draft_id'];

/** r16 cold-check: nguồn tự thu (web/Fanpage) không biết nhãn AI, tài trợ, SKU, bản duyệt, loại,
 * ngày do NGƯỜI khai ở CSV → kế thừa từ snapshot NGƯỜI nạp gần nhất cùng URL. `draft_id` chỉ kiểm
 * lại khi chữ tự thu CÙNG biểu diễn (cùng sha, hoặc Fanpage `message` = chữ bài); web = tiêu đề +
 * thân → không kiểm lại, MANG phán quyết duyệt (`lech_/thieu_ban_duyet`) của snapshot người. */
export async function inheritHuman(db: Db, row: Row): Promise<Row> {
  const { rows } = await db.query(
    'select content_type, posted_on::text as posted_on, is_ai, is_sponsored, sku,' +
      ' draft_id::text as draft_id, text_sha256, codes from channel_posts where url = $1' +
      " and imported_by !~* '^\\s*(agent|system)\\s*:' order by id desc limit 1",
    [row.url],
  );
  const h = rows[0];
  if (!h) return row;
  const meta = Object.fromEntries(HUMAN_COLS.map((k) => [k, h[k]])) as Partial<Row>;
  if (row.sha === h.text_sha256 || row.text_is_post) return { ...row, ...meta };
  return {
    ...row,
    ...meta,
    draft_id: null,
    require_draft: false,
    approval_codes: APPROVAL_CODES.filter((c) => (h.codes as string[]).includes(c)),
  };
}

type Post = {
  id: string;
  url: string;
  channel: string;
  content_type: string;
  codes: string[];
  severity: string;
  first_detected_at: Date;
  due_at: Date;
  queue_id: string | null;
  alert_id: string | null;
  text_sha256: string;
  due_iso: string;
};

// Python `due_at.isoformat()` (psycopg đọc theo TimeZone phiên, giữ micro giây; phần lẻ 0 thì bỏ).
const DUE_ISO =
  `to_char(due_at, 'YYYY-MM-DD"T"HH24:MI:SS') || case when to_char(due_at, 'US') = '000000'` +
  ` then '' else '.' || to_char(due_at, 'US') end || to_char(due_at, 'TZH:TZM') as due_iso`;

async function openPost(db: Db, postId: string): Promise<Post | null> {
  const { rows } = await db.query<Post>(
    'select id::text, url, channel, content_type, codes, severity, first_detected_at, due_at,' +
      ` queue_id::text, alert_id::text, text_sha256, ${DUE_ISO} from channel_posts` +
      ' where id = $1 and closed_at is null and severity is not null',
    [postId],
  );
  return rows[0] ?? null;
}

/** Payload ticket: chỉ mã/mức/hạn — KHÔNG chép đoạn vi phạm (Pháp chế duyệt được qua guardrail). */
export function ticketPayload(p: Post): string {
  return [
    `Lệnh rà kênh PC-A4 — bài #${p.id} trên kênh ${p.channel} (loại ${p.content_type})`,
    `Mã nội dung (sha256 12 ký tự đầu): ${p.text_sha256.slice(0, 12)}`,
    `Mức: ${p.severity} — mã vi phạm: ${p.codes.join(', ')}`,
    `Phát hiện: ${vn(p.first_detected_at)} — hạn xử lý: ${vn(p.due_at)} giờ VN (24 giờ đồng hồ thật, gồm T7/CN/lễ Tết)`,
    'Thao tác GỠ/ẨN/SỬA do người được ủy quyền thực hiện trên kênh — agent không gỡ/sửa.',
    'Duyệt mục này = Pháp chế xác nhận lệnh gỡ/sửa; vi phạm chỉ đóng khi bản xuất lại đã sạch hoặc người ghi nhận đã gỡ (python -m agents.ra_kenh --mark-removed <url> --by <tên>).',
  ].join('\n');
}

export type Dcfg = Record<string, DirectorConfig>;

export type Item = {
  id: string;
  url: string;
  channel: string;
  severity: string | null;
  codes: string[];
  due_at: Date | null;
  excerpt: string;
  closed: boolean;
};
export type Stats = {
  rows: number;
  new: number;
  skip: number;
  S1: number;
  S2: number;
  closed: number;
  tickets: number;
  alerts: number;
  items: Item[];
};

/** Đợt mở chưa có mục hàng duyệt / cảnh báo đỏ (S1) → tạo + gắn id. Chạy lại sau sự cố giữa
 * chừng: tìm mục đã tạo theo object_id trước. */
export async function link(db: Db, postId: string, dcfg: Dcfg, st: Stats): Promise<void> {
  const p = await openPost(db, postId);
  if (p === null) return;
  const hosting = p.codes.length === 1 && p.codes[0] === HOSTING;
  const [block, otype] = hosting
    ? ['data_platform', 'hosting_fix']
    : ['legal_hr', 'channel_takedown'];
  if (p.queue_id === null) {
    const oid = `channel_post:${p.id}`;
    const r = await db.query<{ id: string }>(
      'select id::text from approval_queue where object_type = $1 and object_id = $2 order by id limit 1',
      [otype, oid],
    );
    let qid: string;
    if (r.rows[0]) qid = r.rows[0].id;
    else {
      const what = hosting ? 'Sửa trang mặc định hosting' : `Gỡ/sửa bài ${p.severity} ${p.channel}`;
      qid = String(
        await submit(db, {
          block,
          objectType: otype,
          objectId: oid,
          title: cpHead(`${what}: ${maskPii(p.url)}`, 300),
          payload: ticketPayload(p),
          createdBy: AGENT,
          cfg: dcfg[block],
        }),
      );
      st.tickets += 1;
    }
    await db.query('update channel_posts set queue_id = $1 where id = $2', [qid, p.id]);
  }
  if (p.severity === 'S1' && p.alert_id === null) {
    const find = () =>
      db.query<{ id: string }>(
        "select id::text from red_alerts where source_agent = $1 and detail->>'post_id' = $2 order by id limit 1",
        [AGENT, p.id],
      );
    let r = (await find()).rows[0];
    if (!r) {
      // Tiêu đề thành tiêu đề/thân email (v13.7) — DF-45: thư không chứa URL; URL tra trong
      // channel_posts theo post_id.
      await raiseAlert(db, AGENT, `S1 ${p.channel}: bài #${p.id}`, {
        post_id: Number(p.id),
        codes: p.codes,
        due_at: p.due_iso,
      });
      st.alerts += 1;
      r = (await find()).rows[0];
    }
    await db.query('update channel_posts set alert_id = $1 where id = $2', [r?.id, p.id]);
  }
}

const sameArr = (a: unknown, b: string[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Nạp snapshot + mở/kế thừa/đóng đợt vi phạm → thống kê. Mỗi bài: snapshot trong 1 giao dịch,
 * rồi gắn mục hàng duyệt/cảnh báo (2 module đó tự commit). `auto` (C12): nguồn tự thu — người nạp
 * là `AUTO_BY` (agent), không giả tên người. Tính năng TẮT → RolloutBlocked TRƯỚC mọi ghi (r17). */
export async function ingest(
  db: Db,
  rows: Row[],
  cfg: PhapCheCfg,
  o: { by: string; now: Date; auto?: boolean },
): Promise<Stats> {
  const err = o.auto ? (o.by === AUTO_BY ? null : 'auto chỉ với AUTO_BY') : byError(o.by);
  if (err) throw new RangeError(err);
  await checkGenerate(db, FEATURE, 'rà kênh (snapshot + đợt vi phạm)');
  const now = aware(o.now);
  const by = pyStrip(o.by);
  const dcfg: Dcfg = {
    legal_hr: loadDirector('legal_hr'),
    data_platform: loadDirector('data_platform'),
  };
  if (o.auto) {
    const inh: Row[] = [];
    for (const r of rows) inh.push(await inheritHuman(db, r));
    rows = inh;
  }
  const scans = rows.map((r) => scanRow(r, cfg));
  if (scans.some((s) => s.codes.includes('config'))) {
    throw new RangeError('guardrail cấu hình hỏng — không nạp (fail-closed)');
  }
  const doLink = hooks.link ?? link;
  const st: Stats = {
    rows: rows.length,
    new: 0,
    skip: 0,
    S1: 0,
    S2: 0,
    closed: 0,
    tickets: 0,
    alerts: 0,
    items: [],
  };
  for (const [k, r] of rows.entries()) {
    const s = scans[k] as Scan;
    const codes = [...s.codes];
    let sev = s.severity;
    if (
      r.draft_id !== null &&
      s.kind === 'content' &&
      !(await verifyPublish(db, r.draft_id, r.text))
    ) {
      codes.push(LECH);
      sev = sev ?? 'S2';
    }
    for (const code of s.kind === 'content' ? (r.approval_codes ?? []) : []) {
      if (!codes.includes(code)) {
        codes.push(code);
        sev = sev ?? 'S2';
      }
    }
    const last = (
      await db.query(
        'select id::text as id, close_reason, text_sha256, channel, content_type, is_ai,' +
          ' is_sponsored, sku, draft_id::text as draft_id, posted_on::text as posted_on, codes,' +
          ' severity from channel_posts where url = $1 order by id desc limit 1',
        [r.url],
      )
    ).rows[0];
    // Bỏ qua CHỈ khi cùng text + cùng cột bài + cùng kết quả rà: luật guardrail/golden/bản duyệt
    // đổi thì cùng text vẫn phải rà lại.
    if (
      last &&
      last.close_reason !== 'da_go' &&
      last.text_sha256 === r.sha &&
      last.channel === r.channel &&
      last.content_type === r.content_type &&
      last.is_ai === r.is_ai &&
      last.is_sponsored === r.is_sponsored &&
      last.sku === r.sku &&
      last.draft_id === r.draft_id &&
      last.posted_on === r.posted_on &&
      sameArr(last.codes, codes) &&
      last.severity === sev
    ) {
      st.skip += 1;
      await doLink(db, last.id, dcfg, st);
      continue;
    }
    const hosting = codes.length === 1 && codes[0] === HOSTING;
    let reason: string | null = null;
    let due: Date | null = null;
    const pid = await withTx(db, async (c) => {
      const open = (
        await c.query(
          'select id::text as id, first_detected_at::text as fdt, due_at::text as due_txt, due_at,' +
            ' queue_id::text as queue_id, alert_id::text as alert_id, codes from channel_posts' +
            ' where url = $1 and closed_at' +
            ' is null and severity is not null order by id',
          [r.url],
        )
      ).rows;
      const lastOpen = open[open.length - 1];
      const wasHosting = Boolean(lastOpen) && sameArr(lastOpen.codes, [HOSTING]);
      // Mốc ghi: Date (đợt mới) hoặc chuỗi DB (kế thừa — Date JS chỉ tới mili giây, mốc micro giây
      // do Python ghi bị lệch → tách đợt). `due` (Date) chỉ để hiển thị.
      let fdt: Date | string | null = null;
      let dueArg: Date | string | null = null;
      let qid: string | null = null;
      let aid: string | null = null;
      if (sev && lastOpen && wasHosting === hosting) {
        // cùng loại → kế thừa
        [fdt, dueArg, due, qid, aid] = [
          lastOpen.fdt,
          lastOpen.due_txt,
          lastOpen.due_at,
          lastOpen.queue_id,
          lastOpen.alert_id,
        ];
        reason = 'thay_ban_moi';
      } else if (sev) {
        due = new Date(now.getTime() + SLA_MS);
        [fdt, dueArg] = [now, due];
      }
      if (open.length && reason === null) {
        // sạch, hoặc đổi loại: vấn đề loại cũ đã hết → da_sua; trang mặc định vẫn còn nhưng nay
        // kèm vi phạm nội dung → gộp vào đợt nội dung mới (code hosting vẫn trong codes).
        reason = wasHosting && codes.includes(HOSTING) ? 'thay_ban_moi' : 'da_sua';
      }
      const ins = await c.query<{ id: string }>(
        'insert into channel_posts (url, channel, content_type, posted_on, is_ai, is_sponsored,' +
          ' sku, draft_id, text, text_sha256, guardrail, codes, severity, first_detected_at,' +
          ' due_at, queue_id, alert_id, imported_by, scanned_at) values ($1, $2, $3, $4, $5, $6,' +
          ' $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id::text',
        [
          r.url,
          r.channel,
          r.content_type,
          r.posted_on,
          r.is_ai,
          r.is_sponsored,
          r.sku,
          r.draft_id,
          r.text,
          r.sha,
          JSON.stringify(s.guardrail),
          codes,
          sev,
          fdt,
          dueArg,
          qid,
          aid,
          by,
          now,
        ],
      );
      const id = (ins.rows[0] as { id: string }).id;
      if (open.length) {
        const ids = open.map((x) => x.id as string);
        await c.query(
          'update channel_posts set closed_at = $1, close_reason = $2, closed_by = $3 where id = any($4)',
          [now, reason, by, ids],
        );
        if (reason === 'da_sua') {
          // đối xứng mark_removed: ts do DB ép
          await c.query(
            'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)',
            [
              by,
              'channel_post_fixed',
              'channel_post',
              ids[0],
              JSON.stringify({ ids: ids.map(Number), snapshot: Number(id) }),
            ],
          );
        }
      }
      return id;
    });
    st.new += 1;
    if (reason === 'da_sua') st.closed += 1;
    if (sev) {
      st[sev] += 1;
      await doLink(db, pid, dcfg, st);
    }
    st.items.push({
      id: pid,
      url: r.url,
      channel: r.channel,
      severity: sev,
      codes,
      due_at: due,
      excerpt: s.excerpt,
      closed: reason === 'da_sua',
    });
  }
  return st;
}

// ------------------------------------------------- C12 nguồn tự thu
// Đợt hợp đồng C12 (legal_hr-04, PL01 Pháp chế "quét web, Fanpage, listing; mở yêu cầu gỡ bài vi
// phạm trong 24 giờ"):
//   - web: tệp crawl `data/{articles,news,products}.jsonl` (trang CÔNG KHAI của Bên B). Tệp cũ hơn
//     `WEB_MAX_AGE_DAYS` (GIẢ ĐỊNH 7) → KHÔNG quét nguồn đó (dữ liệu cũ không "đóng" vi phạm);
//   - listing: snapshot `listing` MỚI NHẤT mỗi sàn (`market_rows`); KHÔNG cộng `thieu_ban_duyet`
//     (đối chiếu bản duyệt listing là việc của ceo_audit — tránh mở trùng);
//   - Fanpage (r16): bài do CHÍNH Page đăng qua Graph API chỉ đọc — chưa cấu hình → ghi chú, vẫn
//     `--file`; lỗi nguồn → ghi chú + exit 1; tính năng TẮT → 0 request, exit 2.
//   - r18: ký tự không lưu được (NUL, surrogate lẻ) / permalink hỏng → bỏ bài + ghi chú.

/** r18: Postgres `text` không nhận NUL; surrogate lẻ không mã hóa UTF-8 được. */
export function storable(s: string): boolean {
  return !LONE_SURROGATE.test(s) && !s.includes('\x00');
}

/** r19: ngày crawl đúng dạng mà không có thật (`2026-13-45`) → null (coi như bài mới). */
export function webDate(s: string): string | null {
  return DATE_RE.test(s) ? isoDay(s) : null;
}

/** Python `json.loads(ln.decode("utf-8", errors="replace"))` — BOM giữ lại (Python không bỏ → JSON
 * hỏng). shortcut: JSON.parse không nhận NaN/Infinity như Python — dòng đó thành "hỏng — bỏ". */
function jsonLine(buf: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf));
}

/** Python `str(o.get(k) or "")`. */
const strOr = (v: unknown): string => (pyTruthy(v) ? pyStr(v) : '');

/** Tệp crawl web → [rows, ghi chú]. `dataDir` mặc định data/. */
export function webRows(now: Date, dataDir: string = DATA_DIR): [Row[], string[]] {
  const rows: Row[] = [];
  const notes: string[] = [];
  for (const name of WEB_FILES) {
    const f = join(dataDir, `${name}.jsonl`);
    let mtime: number;
    try {
      const stt = statSync(f);
      if (!stt.isFile()) throw new Error('not file');
      mtime = stt.mtimeMs;
    } catch {
      notes.push(`web/${name}: chưa có tệp crawl — chưa quét`);
      continue;
    }
    const ageMs = now.getTime() - mtime;
    if (ageMs > WEB_MAX_AGE_DAYS * 86_400_000) {
      notes.push(
        `web/${name}: dữ liệu crawl cũ ${Math.floor(ageMs / 86_400_000)} ngày (> ${WEB_MAX_AGE_DAYS}) — KHÔNG quét, chạy crawler.collect`,
      );
      continue;
    }
    let bad = 0;
    const raw = readFileSync(f);
    let n = 0;
    let start = 0;
    while (start <= raw.length) {
      let end = raw.indexOf(0x0a, start);
      if (end < 0) end = raw.length;
      const ln = raw.subarray(start, end);
      start = end + 1;
      n += 1;
      // bytes.strip(): chỉ khoảng trắng ASCII
      if (ASCII_WS_LINE.test(ln.toString('latin1'))) continue;
      let o: unknown;
      try {
        o = jsonLine(ln);
      } catch {
        // JSON hỏng (r19: lồng quá sâu cũng vào đây)
        notes.push(`web/${name}: dòng ${n} hỏng — bỏ`);
        continue;
      }
      if (!isObj(o)) continue;
      const url = strOr(o.url);
      let text = pyStrip(
        ['title', 'name', 'body', 'description'].map((k) => strOr(o[k])).join(' '),
      );
      if (!(storable(url) && storable(text))) {
        bad += 1;
        continue;
      }
      if (
        !(url.startsWith('http://') || url.startsWith('https://')) ||
        !text ||
        Buffer.byteLength(url, 'utf8') > MAX_URL
      ) {
        continue;
      }
      const pub = cpHead(strOr(o.published_at), 10);
      text = cpHead(text, MAX_TEXT);
      rows.push({
        line: n,
        url,
        channel: 'web',
        content_type: 'post',
        posted_on: webDate(pub),
        is_ai: false,
        is_sponsored: false,
        sku: null,
        draft_id: null,
        text,
        sha: contentSha256(text),
      });
    }
    if (bad) {
      notes.push(`web/${name}: bỏ ${bad} dòng có ký tự không lưu được (NUL/surrogate) ở url/chữ`);
    }
  }
  return [rows, notes];
}

// Python `strptime(v, "%Y-%m-%dT%H:%M:%S%z")` (regex _strptime, IGNORECASE trừ `Z`).
const FB_TIME =
  /^([0-9]{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12][0-9]|0[1-9]|[1-9]| [1-9])[Tt](2[0-3]|[01][0-9]|[0-9]):([0-5][0-9]|[0-9]):(6[01]|[0-5][0-9]|[0-9])(?:(Z)|([+-])([0-9]{2}):?([0-5][0-9])(?::?([0-5][0-9])(?:\.[0-9]{1,6})?)?)$/;

/** Mốc UTC (ms) của ngày giờ theo lịch (năm 1..9999, kể cả < 100) | null khi ngày không có thật. */
function utcMs(y: number, mo: number, d: number, h: number, mi: number, se: number): number | null {
  const day = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (y < 1 || isoDay(day) === null || se > 59) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, se, 0);
  return t.getTime();
}

/** `created_time` Graph → ngày VN | null. Số nguyên = epoch giây; chuỗi = strptime
 * `%Y-%m-%dT%H:%M:%S%z`; sai/ngoài năm 1..9999 → null. shortcut: số thực có giá trị nguyên (JSON
 * `1.0`) coi như số nguyên (JSON.parse không phân biệt). */
export function fbDate(v: unknown): string | null {
  let ms: number | null;
  if (typeof v === 'number' && Number.isInteger(v)) {
    ms = v * 1000;
  } else if (typeof v === 'string') {
    const m = FB_TIME.exec(v);
    if (!m) return null;
    const n = (i: number) => Number(pyStrip(m[i] ?? '0'));
    ms = utcMs(n(1), n(2), n(3), n(4), n(5), n(6));
    if (ms === null) return null;
    if (!m[7]) {
      if (n(9) > 23) return null;
      const off = (n(9) * 3600 + n(10) * 60 + n(11)) * 1000;
      ms -= m[8] === '-' ? -off : off;
    }
  } else return null;
  const vnY = new Date(ms + 7 * 3600_000).getUTCFullYear();
  if (!Number.isFinite(ms) || Number.isNaN(vnY) || vnY < 1 || vnY > 9999) return null;
  return vnDate(new Date(ms));
}

export type FbDeps = { env?: Record<string, string | undefined> };

/** r16: bài Fanpage → [rows, ghi chú, rc]. rc null = đọc được hoặc chưa cấu hình; 1 = lỗi nguồn;
 * 2 = cấu hình hỏng / tính năng TẮT (0 request). */
export async function fanpageRows(
  db: Db | null,
  d: FbDeps = {},
): Promise<[Row[], string[], number | null]> {
  let cfg: fanpage.FanpageConfig | null;
  try {
    cfg = fanpage.config(d.env ?? process.env);
  } catch (e) {
    if (!(e instanceof fanpage.FanpageConfigError)) throw e;
    return [[], [`fanpage: ${e.message} — chưa quét`], 2];
  }
  if (cfg === null) {
    return [
      [],
      [
        `fanpage: chưa cấu hình ${fanpage.ENV_PAGE}/${fanpage.ENV_TOKEN} — chưa quét (dùng --file CSV)`,
      ],
      null,
    ];
  }
  const why = await blocked(db, 'đọc bài Fanpage qua Graph API', FEATURE);
  if (why) return [[], [`fanpage: ${why}`], EXIT_BLOCKED];
  let posts: fanpage.Post[];
  try {
    posts = await fanpage.fetchPosts(cfg);
  } catch (e) {
    if (!(e instanceof fanpage.FanpageError)) throw e;
    return [[], [`${e.message} — chưa quét`], 1];
  }
  const rows: Row[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let bad = 0;
  for (const p of posts) {
    const url = fanpage.postUrl(p.permalink_url);
    // Cùng biểu diễn với CSV `readExport` (bản duyệt so byte): chỉ đổi \r\n → \n, KHÔNG
    // strip/cắt; strip chỉ để kiểm rỗng; > MAX_TEXT → bỏ (CSV cũng từ chối dòng đó).
    const text = typeof p.message === 'string' ? p.message.replaceAll('\r\n', '\n') : null;
    if (
      url === null ||
      Buffer.byteLength(url, 'utf8') > MAX_URL ||
      text === null ||
      !pyStrip(text) ||
      cpLen(text) > MAX_TEXT ||
      !storable(text)
    ) {
      bad += 1;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({
      line: null,
      url,
      channel: 'facebook',
      content_type: 'post',
      posted_on: fbDate(p.created_time),
      is_ai: false,
      is_sponsored: false,
      sku: null,
      draft_id: null,
      text,
      text_is_post: true,
      sha: contentSha256(text),
    });
  }
  if (bad) {
    notes.push(
      `fanpage: bỏ ${bad} bài không có chữ, dài quá ${MAX_TEXT} ký tự, chữ có ký tự không lưu được (NUL/surrogate) hoặc permalink không hợp lệ`,
    );
  }
  return [rows, notes, null];
}

/** Snapshot listing MỚI NHẤT mỗi sàn → rows (không đòi bản duyệt). */
export async function listingRows(db: Db): Promise<Row[]> {
  const { rows } = await db.query(
    "select r.channel, r.item_id, r.seller_sku, r.title, r.raw ->> 'description' as descr" +
      ' from market_rows r join (select distinct on (channel) id from market_snapshots where' +
      " export_kind = 'listing' order by channel, imported_at desc, id desc) s on s.id =" +
      ' r.snapshot_id order by r.channel, r.row_no',
  );
  const out: Row[] = [];
  for (const x of rows) {
    const key = x.item_id || x.seller_sku;
    const text = cpHead([x.title, x.descr].filter((v) => v).join('\n'), MAX_TEXT);
    if (!key || !text) continue;
    out.push({
      line: null,
      url: `${x.channel}:listing:${key}`,
      channel: x.channel,
      content_type: 'listing',
      posted_on: null,
      is_ai: false,
      is_sponsored: false,
      sku: null,
      draft_id: null,
      require_draft: false,
      text,
      sha: contentSha256(text),
    });
  }
  return out;
}

export function urlSha12(url: string | null | undefined): string {
  return contentSha256(pyStrip(url ?? '')).slice(0, 12);
}

/** NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt mở của URL (`da_go`) + `agent_action_log`
 * `channel_post_removed` — qua function `channel_post_mark_removed_human` (SECURITY DEFINER; DB
 * kiểm danh tính theo login + khối legal_hr; giờ đóng = đồng hồ DB khi login không phải owner).
 * DB từ chối danh tính → HumanDenied. */
export async function markRemoved(
  db: Db,
  url: string | null,
  by: string,
  now: Date,
  env?: Record<string, string | undefined>,
): Promise<[boolean, string]> {
  const err = byError(by);
  if (err) return [false, err];
  const t = aware(now);
  const r = await callHuman<{ n: number }>(
    db,
    'select channel_post_mark_removed_human($1, $2, $3) as n',
    [pyStrip(url ?? ''), t, pyStrip(by)],
    {
      by,
      block: 'legal_hr',
      action: 'close_violation',
      objectType: 'channel_post',
      objectId: urlSha12(url),
      env,
    },
  );
  const n = Number(r.rows[0]?.n ?? 0);
  if (!n) return [false, 'URL không có đợt vi phạm đang mở'];
  return [true, `đã ghi nhận gỡ — đóng ${n} dòng (da_go)`];
}

// ------------------------------------------------------------------ báo cáo

export type OpenRow = {
  id: string;
  url: string;
  channel: string;
  codes: string[];
  severity: string;
  first_detected_at: Date;
  due_at: Date;
  queue_id: string | null;
  queue_status: string | null;
};
export type ReportStats = {
  now: Date;
  days: number;
  dossiers: xnqc.Dossier[];
  reminders: string[];
  sync_pending: number;
  sync_notes: string[];
  open: OpenRow[];
  closed: { id: string; url: string; reason: string; closed_at: Date; due_at: Date }[];
  detected: { url: string; codes: string[]; first_detected_at: Date }[];
};

const cmpCp = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
};

/** Sắp vi phạm mở như Python `sorted(key=(severity, due_at, url))`. */
export function sortOpen<T extends { severity: string; due_at: Date; url: string }>(xs: T[]): T[] {
  return [...xs].sort(
    (a, b) =>
      cmpCp(a.severity, b.severity) ||
      a.due_at.getTime() - b.due_at.getTime() ||
      cmpCp(a.url, b.url),
  );
}

/** CHỈ SELECT → số liệu cho `renderReport`. */
export async function collectReport(
  db: Db,
  nowIn: Date,
  days: number,
  o: { config?: string; golden?: string } = {},
): Promise<ReportStats> {
  const now = aware(nowIn);
  const since = new Date(now.getTime() - days * 86_400_000);
  const cfg = loadConfig(o.config);
  const dossiers = await xnqc.listDossiers(db);
  const tpbvsk = xnqc.tpbvskSkus(o.golden);
  const syncPending = Number(
    (
      await db.query(
        "select count(*)::int as n from approval_queue where object_type = 'golden_xnqc_sync' and status = 'pending'",
      )
    ).rows[0]?.n ?? 0,
  );
  const open = (
    await db.query<OpenRow>(
      'select distinct on (p.url) p.id::text as id, p.url, p.channel, p.codes, p.severity,' +
        ' p.first_detected_at, p.due_at, p.queue_id::text as queue_id, q.status as queue_status' +
        ' from channel_posts p left join approval_queue q on q.id = p.queue_id where p.closed_at' +
        ' is null and p.severity is not null order by p.url, p.id desc',
    )
  ).rows;
  const closed = (
    await db.query(
      "select id::text as id, url, close_reason as reason, closed_at, due_at from channel_posts where close_reason in ('da_sua', 'da_go') and closed_at > $1 and closed_at <= $2 order by closed_at, id",
      [since, now],
    )
  ).rows;
  const detected = (
    await db.query(
      'select distinct on (url) url, codes, first_detected_at from channel_posts where codes && $1::text[] and first_detected_at > $2 and first_detected_at <= $3 order by url, id desc',
      [[LECH, THIEU], since, now],
    )
  ).rows;
  const today = vnDate(now);
  return {
    now,
    days,
    dossiers,
    reminders: xnqc.reminders(dossiers, tpbvsk, cfg, today),
    sync_pending: syncPending,
    sync_notes: await xnqc.syncNotes(db, today, o.golden),
    open: sortOpen(open),
    closed: closed as ReportStats['closed'],
    detected: detected as ReportStats['detected'],
  };
}

/** Python `f"{x:.1f}"` (x ≥ 0). `toFixed` làm tròn đúng theo giá trị nhị phân, chỉ khác Python ở ca
 * ĐÚNG giữa (x = m/4, m lẻ: 0.25, 0.75…) — Python về số chẵn, `toFixed` lên. */
export function fixed1(x: number): string {
  const q = x * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    const lo = Math.floor(x * 10);
    return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  return x.toFixed(1);
}

const hours = (ms: number): string => `${fixed1(Math.abs(ms / 1000) / 3600)} giờ`;

function openLine(d: OpenRow, now: Date): string {
  const left = d.due_at.getTime() - now.getTime();
  const when = now > d.due_at ? `QUÁ ${hours(left)}` : `còn ${hours(left)}`;
  const q = d.queue_id ? `mục #${d.queue_id} ${d.queue_status || '?'}` : 'chưa có mục hàng duyệt';
  return (
    `- [${d.severity}] ${maskPii(safe(d.url))} (${d.channel}) — ${d.codes.join(', ')} — phát hiện` +
    ` ${vn(d.first_detected_at)}, hạn ${vn(d.due_at)} (${when}) — ${q}`
  );
}

/** THUẦN. Không chép đoạn vi phạm — chỉ url/mã/hạn. */
export function renderReport(stats: ReportStats, nowIn: Date): string {
  const now = aware(nowIn);
  const open = stats.open;
  const over = open.filter((d) => now > d.due_at);
  const s1 = open.filter((d) => d.severity === 'S1');
  const L: string[] = [
    `# Báo cáo Pháp chế tuần — ${vn(now)} (giờ VN, ${stats.days} ngày)`,
    '',
    '> Agent chỉ phát hiện + đề xuất — gỡ/sửa do người; kết quả quét CHƯA được Pháp chế xác nhận.',
    '',
  ];
  if (over.length || s1.length) {
    L.push(`**CẢNH BÁO**: ${over.length} vi phạm QUÁ 24H, ${s1.length} S1 đang mở.`, '');
  }
  L.push('## 1. Hồ sơ XNQC theo trạng thái', '');
  const counts = new Map<string, number>(xnqc.STATUSES.map((s) => [s, 0]));
  for (const d of stats.dossiers) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  L.push([...counts].map(([s, n]) => `${s}: ${n}`).join(' · '));
  for (const d of stats.dossiers) {
    L.push(
      `- #${d.id} ${d.sku_key} ${d.loai_ho_so} [${d.status}] số giấy ${safe(d.so_giay || '—')},` +
        ` nộp ${d.ngay_nop || '—'}, cấp ${d.ngay_cap || '—'}, hết hạn ${d.ngay_het_han || '—'}`,
    );
  }
  L.push('', 'Nhắc mốc:');
  L.push(...(stats.reminders.length ? stats.reminders : ['(không có)']).map((m) => `- ${m}`));
  L.push(`Đề xuất đồng bộ golden (golden_xnqc_sync) đang chờ duyệt: ${stats.sync_pending}`);
  L.push(...(stats.sync_notes ?? []).map((m) => `- ${m}`));
  L.push('', `## 2. Vi phạm đang mở theo URL — S1 ${s1.length}, S2 ${open.length - s1.length}`, '');
  L.push(...(open.length ? open.map((d) => openLine(d, now)) : ['(không có)']));
  L.push('', `### QUÁ 24H — ${over.length}`);
  L.push(...(over.length ? over.map((d) => openLine(d, now)) : ['(không có)']));
  const closed = stats.closed;
  const ontime = closed.filter((c) => c.closed_at <= c.due_at).length;
  const byReason = new Map<string, number>();
  for (const c of closed) byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
  L.push(
    '',
    `## 3. Đã đóng trong ${stats.days} ngày — ${closed.length} (đúng hạn ${ontime}, trễ ${closed.length - ontime})`,
    pySorted(byReason.keys())
      .map((k) => `${k}: ${byReason.get(k)}`)
      .join(' · ') || '(không có)',
    '',
    '## 4. Lệch / thiếu bản duyệt',
    '',
  );
  for (const code of [LECH, THIEU]) {
    const o = open.filter((d) => d.codes.includes(code));
    const n = stats.detected.filter((d) => d.codes.includes(code));
    L.push(`- ${code}: đang mở ${o.length}, phát hiện trong kỳ ${n.length}`);
    L.push(...o.map((d) => `  - ${maskPii(safe(d.url))}`));
  }
  const host = open.filter((d) => d.codes.includes(HOSTING));
  L.push('', `## 5. Mục hạ tầng (trang mặc định hosting) — ${host.length}`);
  L.push(...(host.length ? host.map((d) => openLine(d, now)) : ['(không có)']));
  return `${L.join('\n')}\n`;
}

/** Tên báo cáo tuần theo ngày VN. */
export const reportName = (now: Date): string => `phap-che-tuan-${vnDate(now)}.md`;
