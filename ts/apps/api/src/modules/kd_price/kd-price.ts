import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import type { DirectorConfig } from '@samsam/core/ops/director';
import { addDays, dmy } from '@samsam/core/ops/period';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { cpCmp, isDict, isPyInt, PyFloat, parsePyJson, pyOsName } from '@samsam/core/ops/py-json';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import {
  type CogsVersion,
  clean,
  cmpTuple,
  cogsAt,
  type Day,
  dayDiff,
  evidenceSha,
  FPA_CONFIG,
  floorDiv,
  frac,
  type GoldenPrices,
  type Item,
  key2,
  type ListingRow,
  MARKET_CHANNELS,
  NO_COGS,
  pyDate,
  type Ratio,
  type Readiness,
  readConfig,
  refCode,
  toInt,
  vnd,
} from './deps.js';
import { type Calendar, eventDate } from './mkt-calendar.js';

// Port `agents/kd_price.py` (v5.3 KD-A5, khối `sales`) — phần THUẦN: cấu hình, luật giá đang chạy,
// đọc CSV kế hoạch KM, luật KM, payload TEMPLATE, báo cáo. LUẬT tất định, KHÔNG LLM, KHÔNG gọi sàn.
// Agent KHÔNG BAO GIỜ đổi giá/KM/listing: mọi đề xuất là NHÁP trong hàng duyệt (risk high, GĐ bán
// hàng duyệt, Quản lý MXH sửa tay trên Seller Center). Số trong đề xuất CHỈ lấy từ golden
// (floor/list) hoặc file sàn; giá đối thủ CHỈ vào mục "Tham khảo đối thủ" của báo cáo.

export const WATCH_FILE = 'price_watch.json';
export const BLOCK = 'sales';
export const AGENT = 'agent:kd_price';
export const JOB = 'agents.kd_price';
export const PROMO_KINDS = ['voucher', 'flash_sale', 'giam_gia'];
const WATCH_KEYS = new Set([
  '_doc',
  'status',
  'confirmed_by',
  'channels',
  'list_deviation_pct',
  'max_discount_pct',
  'max_stacked_promos',
  'promo_kinds',
  'lookahead_days',
]);
export const SEVERITY: Record<string, string> = {
  below_floor: 'S1',
  negative_margin: 'S1',
  list_deviation: 'S2',
  listing_promo_over_cap: 'S2',
  promo_banned: 'S1',
  promo_below_floor: 'S1',
  promo_negative_margin: 'S1',
  promo_stacked: 'S2',
  promo_over_cap: 'S2',
  promo_unverifiable: 'S2',
  // C08: INFO như `no_cogs` — KHÔNG đẩy hàng sales (thiếu giá vốn không phải phát hiện), CHỈ mục
  // finance `promo_loss`.
  promo_margin_unknown: 'INFO',
};
export const KIND_LABELS: Record<string, string> = {
  below_floor: 'giá bán thực trên sàn dưới giá sàn golden',
  negative_margin: 'biên ước tính âm theo giá vốn đã duyệt',
  list_deviation: 'giá niêm yết trên sàn lệch giá list golden quá ngưỡng',
  listing_promo_over_cap: 'mức chiết khấu trên sàn vượt trần khuyến mãi',
  promo_banned: 'khuyến mãi cho SKU không được quảng bá trên kênh',
  promo_below_floor: 'khuyến mãi dự kiến làm giá dưới giá sàn golden',
  promo_negative_margin: 'khuyến mãi dự kiến làm biên ước tính âm',
  promo_stacked: 'khuyến mãi chồng nhau vượt số cho phép',
  promo_over_cap: 'khuyến mãi dự kiến vượt trần chiết khấu',
  promo_unverifiable: 'khuyến mãi không kiểm được (thiếu giá golden)',
  promo_margin_unknown:
    'khuyến mãi KHÔNG tính được biên (thiếu giá vốn đã duyệt/tỷ lệ thực nhận) — không kết luận không lỗ',
};
// Đợt hợp đồng C08 (finance-04.2, "chặn khuyến mãi bị lỗ", GĐ tài chính duyệt): KM lỗ / không tính
// được biên → THÊM 1 mục khối finance (`promo_loss`) ngoài mục khối sales. Agent không đổi giá/KM.
export const FINANCE_KINDS = ['promo_negative_margin', 'promo_margin_unknown'];
export const FIN_BLOCK = 'finance';
export const FIN_OT = 'promo_loss';
export const PROMO_FINDINGS = new Set(Object.keys(SEVERITY).filter((k) => k.startsWith('promo_')));
export const V33_DUP: Record<string, string> = { list_deviation: 'price_mismatch' };
export const NO_AUTO =
  'Agent KHÔNG tự đổi giá/khuyến mãi — GĐ bán hàng duyệt, MXH sửa tay trên Seller Center.';
export const PLAN_REQUIRED = [
  'program_id',
  'kenh',
  'sku_key',
  'loai_km',
  'ngay_bat_dau',
  'ngay_ket_thuc',
];
export const PLAN_OPTIONAL = ['giam_pct', 'gia_km_vnd', 'su_kien'];
export const PLAN_MAX_ROWS = 5000;
export const PLAN_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_PRINT_ERRS = 30;
const PID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const SKU_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PCT_RE = /^[0-9]{1,2}$/;

export type Watch = {
  status: string;
  confirmed_by: string | null;
  channels: string[];
  list_deviation_pct: number;
  max_discount_pct: Record<string, number>;
  max_stacked_promos: number;
  promo_kinds: string[];
  lookahead_days: number;
} & Record<string, unknown>;
export type NetRatio = Record<string, Ratio>;
export type Finding = Record<string, unknown> & {
  kind: string;
  severity: string;
  channel: string;
  item_id?: string | null;
  seller_sku?: string | null;
  sku_key?: string | null;
  evidence?: Record<string, unknown>;
  object_id?: string;
  program_ids?: string[];
  start?: Day;
  end?: Day;
  label?: string;
  cam?: boolean;
  dup_alert?: number;
};
export type PlanRow = {
  row_no: number | null;
  program_id: string;
  channel: string;
  sku_key: string;
  kind: string;
  start: Day;
  end: Day;
  pct: number | null;
  price: number | null;
  event: string | null;
  event_date: Day | null;
  source?: string;
};

const tuple = (xs: readonly string[]) => `(${xs.map(pyRepr).join(', ')})`;
const pyList = (xs: readonly string[]) => `[${xs.map(pyRepr).join(', ')}]`;
const intIn = (v: unknown, lo: number, hi: number) => isPyInt(v) && lo <= v && v <= hi;

// ---------------------------------------------------------------- cấu hình

/** → lý do lỗi | null. Fail-closed: không bao giờ 'cấu hình rỗng'. */
export function validateWatch(d: unknown): string | null {
  if (!isDict(d)) return 'phải là object JSON';
  const keys = Object.keys(d);
  if (!keys.some((k) => k !== '_doc')) return 'rỗng / chỉ có _doc';
  const stray = keys.filter((k) => !WATCH_KEYS.has(k)).sort(cpCmp);
  if (stray.length) return `key lạ ${pyList(stray)}`;
  if (typeof d.status !== 'string' || !pyStrip(d.status)) return "thiếu 'status'";
  const cb = d.confirmed_by;
  if (
    !Object.hasOwn(d, 'confirmed_by') ||
    !(cb === null || (typeof cb === 'string' && pyStrip(cb)))
  ) {
    return "'confirmed_by' phải null hoặc tên người chốt";
  }
  const ch = d.channels;
  if (
    !(
      Array.isArray(ch) &&
      ch.length &&
      ch.every((c) => MARKET_CHANNELS.includes(c)) &&
      new Set(ch).size === ch.length
    )
  ) {
    return `'channels' phải list không trùng ⊂ ${tuple(MARKET_CHANNELS)}`;
  }
  if (!intIn(d.list_deviation_pct, 1, 50)) return "'list_deviation_pct' phải số nguyên 1..50";
  const cap = d.max_discount_pct;
  if (
    !(
      isDict(cap) &&
      Object.keys(cap).length === new Set(ch).size &&
      ch.every((c) => Object.hasOwn(cap, c)) &&
      Object.values(cap).every((v) => intIn(v, 1, 49))
    )
  ) {
    return "'max_discount_pct' phải {kênh: số nguyên 1..49} đủ đúng các kênh trong 'channels' (≤ 49 khớp R2 golden)";
  }
  if (!intIn(d.max_stacked_promos, 1, 10)) return "'max_stacked_promos' phải số nguyên 1..10";
  const pk = d.promo_kinds;
  if (
    !(
      Array.isArray(pk) &&
      pk.length &&
      pk.every((k) => PROMO_KINDS.includes(k)) &&
      new Set(pk).size === pk.length
    )
  ) {
    return `'promo_kinds' phải list không trùng ⊂ ${tuple(PROMO_KINDS)}`;
  }
  if (!intIn(d.lookahead_days, 1, 120)) return "'lookahead_days' phải số nguyên 1..120";
  return null;
}

/** → [watch, null] | [null, lý do]. */
export function loadWatch(path: string): [Watch, null] | [null, string] {
  const name = basename(path);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return [null, `không đọc được ${name}: ${pyOsName(e)}`];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // bỏ BOM = utf-8-sig
  } catch {
    return [null, `${name} không phải UTF-8`];
  }
  if (!pyStrip(text)) return [null, `${name} rỗng`];
  let d: unknown;
  try {
    d = parsePyJson(text);
  } catch {
    return [null, `${name} JSON hỏng: JSONDecodeError`];
  }
  const why = validateWatch(d);
  return why ? [null, `${name}: ${why}`] : [d as Watch, null];
}

/** {kênh: Ratio} từ `fpa_config.cash.net_ratio_default` (v9.1, GIẢ ĐỊNH). */
export function loadNetRatio(
  channels: readonly string[],
  path: string = FPA_CONFIG,
): [NetRatio, null] | [null, string] {
  const [cash, why] = readConfig('cash', path);
  if (cash === null) return [null, why];
  const src = cash.net_ratio_default;
  if (!isDict(src)) return [null, 'fpa_config: thiếu cash.net_ratio_default'];
  const out: NetRatio = {};
  for (const ch of channels) {
    const [d, w] = frac(Object.hasOwn(src, ch) ? src[ch] : null, `cash.net_ratio_default.${ch}`);
    if (d === null || d.n === 0n) return [null, w ?? `cash.net_ratio_default.${ch} = 0`];
    out[ch] = d;
  }
  return [out, null];
}

// ---------------------------------------------------------------- tiện ích

/** Biên ước tính VND (làm tròn xuống) = giá × tỷ lệ thực nhận − giá vốn.
 * shortcut: Decimal của Python làm tròn tích ở 28 chữ số — giá × tỷ lệ ở đây ≪ 28 chữ số nên phép
 * BigInt chính xác cho cùng kết quả; nâng nếu tỷ lệ có > 12 chữ số lẻ. */
export const margin = (price: number, r: Ratio, cost: number): number =>
  Number(floorDiv(BigInt(price) * r.n, r.d)) - cost;

function oid(kind: string, ch: string, key: string, ev: Record<string, unknown>): string {
  return `a5:${kind}:${ch}:${refCode(key)}:${evidenceSha(ev)}`;
}

/** Python `_f(kind, ch, item_id=, seller_sku=, sku=, key=, ev=, **extra)`. */
function mk(
  kind: string,
  ch: string,
  o: {
    item_id?: string | null;
    seller_sku?: string | null;
    sku?: string | null;
    key?: string | null;
    ev?: Record<string, unknown>;
  },
  extra: Record<string, unknown> = {},
): Finding {
  const ev = o.ev ?? {};
  const sku = o.sku ?? null;
  return {
    kind,
    severity: SEVERITY[kind] as string,
    channel: ch,
    item_id: o.item_id ?? null,
    seller_sku: o.seller_sku ?? null,
    sku_key: sku,
    evidence: ev,
    object_id: oid(kind, ch, o.key || o.item_id || sku || '-', { sku, ...ev }),
    ...extra,
  };
}

const SEV_ORDER: Record<string, number> = { S1: 0, S2: 1, INFO: 2 };
function sortFindings(fs: Finding[]): Finding[] {
  const k = (f: Finding) => [
    SEV_ORDER[f.severity] as number,
    f.kind,
    f.channel,
    f.item_id || '',
    f.sku_key || '',
    f.object_id ?? '',
  ];
  return [...fs].sort((a, b) => cmpTuple(k(a), k(b)));
}

// ---------------------------------------------------------------- luật giá đang chạy

/** THUẦN, tất định → [finding] (+ mục INFO nhãn chưa có giá vốn duyệt — không đẩy). `readiness` thiếu
 * khóa = CAM (không xét giá — việc của A4). */
export function checkListingPrices(
  listings: ListingRow[],
  goldenPrices: GoldenPrices,
  cogs: CogsVersion[],
  netRatio: NetRatio,
  watch: Watch,
  today: Day,
  readiness: Readiness,
): Finding[] {
  coerceDay(today);
  const out: Finding[] = [];
  for (const r of listings) {
    const sku = r.sku_key ?? null;
    const ch = r.channel;
    if (sku === null || !watch.channels.includes(ch)) continue;
    if ((readiness.get(key2(sku, ch)) ?? 'CAM') === 'CAM') continue;
    const listed = r.price_vnd ?? null;
    const eff = r.sale_price ?? listed;
    if (eff === null) continue;
    const g = goldenPrices.get(key2(sku, ch)) ?? {};
    const fl = g.floor;
    const lp = g.list;
    const base = { item_id: r.item_id ?? null, seller_sku: r.seller_sku ?? null, sku };
    if (fl !== undefined && eff < fl.price) {
      out.push(
        mk('below_floor', ch, {
          ...base,
          ev: { price_san: listed, price_eff: eff, floor: fl.price, floor_approved: fl.approved },
        }),
      );
    }
    const cost = cogsAt(cogs, sku, today);
    if (cost === null) {
      out.push({
        kind: 'no_cogs',
        severity: 'INFO',
        channel: ch,
        item_id: r.item_id ?? null,
        sku_key: sku,
        note: NO_COGS,
      });
    } else if (margin(eff, netRatio[ch] as Ratio, cost) < 0) {
      out.push(
        mk('negative_margin', ch, {
          ...base,
          ev: {
            price_eff: eff,
            cogs: cost,
            net_ratio: (netRatio[ch] as Ratio).s,
            margin: margin(eff, netRatio[ch] as Ratio, cost),
          },
        }),
      );
    }
    if (lp !== undefined) {
      const lst = lp.price;
      if (listed !== null && Math.abs(listed - lst) * 100 > lst * watch.list_deviation_pct) {
        out.push(
          mk('list_deviation', ch, {
            ...base,
            ev: {
              price_san: listed,
              list: lst,
              list_approved: lp.approved,
              pct: watch.list_deviation_pct,
            },
          }),
        );
      }
      const cap = watch.max_discount_pct[ch] as number;
      if (eff < lst && (lst - eff) * 100 > lst * cap) {
        out.push(
          mk('listing_promo_over_cap', ch, {
            ...base,
            ev: { price_eff: eff, list: lst, cap_pct: cap },
          }),
        );
      }
    }
  }
  return sortFindings(out);
}

// ---------------------------------------------------------------- kế hoạch KM

/** Lỗi cấu trúc CSV kế hoạch — thông điệp không chứa nội dung ô. */
class PlanError extends Error {}

/** → [số bản ghi (Python enumerate từ 1), ô] bỏ dòng trống; trần `maxRows` áp trong lúc đọc. */
function planRows(text: string, maxRows: number): [number, string[]][] {
  const out: [number, string[]][] = [];
  let i = 0;
  for (const r of new CsvReader(text)) {
    i++;
    if (i > maxRows + 1) throw new PlanError(`file > ${maxRows} dòng — tách file`);
    if (r.some((c) => pyStrip(c))) out.push([i, r]);
  }
  if (!out.length) throw new PlanError('file rỗng');
  return out;
}

/** THUẦN (không DB): CSV kế hoạch KM → [rows, errs]. errs ≠ [] → rows = []. Lỗi chỉ nêu số dòng +
 * tên cột, KHÔNG giá trị ô. `su_kien` ∈ id sự kiện lịch mùa. */
export function readPlan(
  path: string,
  promoKinds: readonly string[] = PROMO_KINDS,
  calendar: Calendar | null = null,
  maxRows: number = PLAN_MAX_ROWS,
): [PlanRow[], string[]] {
  let data: Buffer;
  try {
    if (statSync(path).size > PLAN_MAX_BYTES) return [[], [`file > ${PLAN_MAX_BYTES / 2 ** 20}MB`]];
    data = readFileSync(path);
  } catch (e) {
    return [[], [`không đọc được file kế hoạch: ${pyOsName(e)}`]];
  }
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const bad = utf8ErrorStart(bom ? data.subarray(3) : data);
  if (bad >= 0) return [[], [`file không phải UTF-8 (byte ${bad})`]];
  const text = new TextDecoder('utf-8').decode(data);
  if (!pyStrip(text)) return [[], ['file rỗng']];
  const events = new Map<string, Day>();
  if (calendar !== null) for (const ev of calendar.events) events.set(ev.id, eventDate(ev));
  let table: [number, string[]][];
  try {
    table = planRows(text, maxRows);
  } catch (e) {
    if (e instanceof PlanError || e instanceof CsvError)
      return [[], [[...e.message].slice(0, 160).join('')]];
    throw e;
  }
  const [[, header], ...body] = table as [[number, string[]], ...[number, string[]][]];
  const errs: string[] = [];
  const seen = new Set<string>();
  const col = new Map<string, number>();
  const all = [...PLAN_REQUIRED, ...PLAN_OPTIONAL];
  header.forEach((h0, j) => {
    const h = pyStrip(h0 ?? '');
    if (!h) errs.push(`header cột ${j + 1} trống`);
    else if (seen.has(h)) errs.push(`header trùng: cột ${j + 1}`);
    else if (!all.includes(h)) errs.push(`cột lạ ở vị trí ${j + 1} (chỉ nhận ${all.join(', ')})`);
    else {
      seen.add(h);
      col.set(h, j);
    }
  });
  const miss = PLAN_REQUIRED.filter((c) => !col.has(c));
  if (miss.length) errs.push(`thiếu cột bắt buộc: ${miss.join(', ')}`);
  if (!col.has('giam_pct') && !col.has('gia_km_vnd')) errs.push('cần cột giam_pct hoặc gia_km_vnd');
  if (errs.length) return [[], errs];
  if (!body.length) return [[], ['file chỉ có header, không có dòng dữ liệu']];
  const rows: PlanRow[] = [];
  for (const [no, cells] of body) {
    if (cells.slice(header.length).some((c) => pyStrip(c))) {
      errs.push(`dòng ${no}: thừa ô ngoài header`);
      continue;
    }
    const v: Record<string, string | null> = {};
    for (const [k, j] of col) v[k] = (j < cells.length ? pyStrip(cells[j] as string) : '') || null;
    const bad: string[] = [];
    const pid = v.program_id ?? null;
    if (!(pid && PID_RE.test(pid))) bad.push('program_id');
    if (!MARKET_CHANNELS.includes(v.kenh as string)) bad.push('kenh');
    const sku = v.sku_key ?? null;
    if (!(sku && SKU_RE.test(sku) && [...sku].length <= 64)) bad.push('sku_key');
    if (!promoKinds.includes(v.loai_km as string)) bad.push('loai_km');
    const start = pyDate(v.ngay_bat_dau);
    const end = pyDate(v.ngay_ket_thuc);
    if (start === null) bad.push('ngay_bat_dau');
    if (end === null) bad.push('ngay_ket_thuc');
    if (start && end && end < start) bad.push('ngay_ket_thuc (trước ngày bắt đầu)');
    const pct = v.giam_pct ?? null;
    const gia = v.gia_km_vnd ?? null;
    if ((pct === null) === (gia === null)) bad.push('giam_pct/gia_km_vnd (cần đúng 1)');
    else if (pct !== null) {
      if (!PCT_RE.test(pct) || !(Number(pct) >= 1 && Number(pct) <= 99))
        bad.push('giam_pct (số nguyên 1..99)');
    } else if (!toInt(gia, 10 ** 15)) bad.push('gia_km_vnd (số nguyên > 0)');
    const ev = v.su_kien ?? null;
    if (ev !== null && !events.has(ev)) bad.push('su_kien (không có trong lịch mùa)');
    if (bad.length) {
      errs.push(`dòng ${no}: cột ${bad.join(', ')} không hợp lệ`);
      continue;
    }
    rows.push({
      row_no: no,
      program_id: pid as string,
      channel: v.kenh as string,
      sku_key: sku as string,
      kind: v.loai_km as string,
      start: start as Day,
      end: end as Day,
      pct: pct !== null ? Number(pct) : null,
      price: gia !== null ? toInt(gia, 10 ** 15) : null,
      event: ev,
      event_date: ev ? (events.get(ev) ?? null) : null,
    });
  }
  return errs.length ? [[], errs] : [rows, []];
}

/** str 'YYYY-MM-DD' → ngày (CLI truyền str) — sai → RangeError (Python ValueError). */
export function coerceDay(v: unknown): Day {
  const d = pyDate(v);
  if (d === null) throw new RangeError('ngày phải dạng YYYY-MM-DD');
  return d;
}

// ---------------------------------------------------------------- luật KM (THUẦN)

/** Phân số n/d (d > 0) — Python `Fraction`, không float. */
type Frac = { n: bigint; d: bigint };

/** Giá sau KM gộp, áp LẦN LƯỢT trên list golden: KM giá cố định (thấp nhất) trước, rồi các KM % theo
 * program_id. */
function after(lst: number, promos: PlanRow[]): Frac {
  const fixed = promos.filter((p) => p.price !== null).map((p) => p.price as number);
  let f: Frac = { n: BigInt(Math.min(lst, ...fixed)), d: 1n };
  for (const p of [...promos].sort((a, b) => cpCmp(a.program_id, b.program_id))) {
    if (p.pct !== null) f = { n: f.n * BigInt(100 - p.pct), d: f.d * 100n };
  }
  return f;
}

const intPrice = (f: Frac) => Number(floorDiv(f.n, f.d));
/** `_off_pct(lst, price) > cap` ⇔ (lst − price) × 100 > cap × lst (lst > 0). */
const offOver = (lst: number, f: Frac, cap: number) =>
  (BigInt(lst) * f.d - f.n) * 100n > BigInt(cap) * BigInt(lst) * f.d;
const below = (f: Frac, floor: number) => f.n < BigInt(floor) * f.d;

export const windowLabel = (start: Day, today: Day): string =>
  start <= today ? 'đang chạy' : `dự kiến T-${dayDiff(start, today)}`;

/** THUẦN, tất định → [finding]. Chỉ dòng kết thúc ≥ today và bắt đầu ≤ today + lookahead_days. Gộp
 * KM chồng theo NGÀY (cùng SKU × kênh). */
export function checkPromos(
  rows: PlanRow[],
  goldenPrices: GoldenPrices,
  readiness: Readiness,
  promotable: Set<string>,
  cogs: CogsVersion[],
  netRatio: Record<string, Ratio | string>,
  watch: Pick<Watch, 'channels' | 'max_discount_pct' | 'max_stacked_promos' | 'lookahead_days'>,
  today0: Day,
): Finding[] {
  const today = coerceDay(today0);
  const horizon = addDays(today, watch.lookahead_days);
  const live = rows.filter((r) => r.end >= today && r.start <= horizon);
  const out: Finding[] = [];
  const ok = new Map<string, PlanRow[]>();
  const sorted = [...live].sort((a, b) =>
    cmpTuple(
      [a.channel, a.sku_key, a.start, a.program_id],
      [b.channel, b.sku_key, b.start, b.program_id],
    ),
  );
  for (const r of sorted) {
    const sku = r.sku_key;
    const ch = r.channel;
    const rd = readiness.get(key2(sku, ch)) ?? 'CAM';
    const meta = {
      program_ids: [r.program_id],
      start: r.start,
      end: r.end,
      label: windowLabel(r.start, today),
      cam: rd === 'CAM',
    };
    if (!promotable.has(key2(sku, ch))) {
      out.push(
        mk(
          'promo_banned',
          ch,
          {
            sku,
            key: r.program_id,
            ev: { program_id: r.program_id, start: r.start, end: r.end, readiness: rd },
          },
          meta,
        ),
      );
      continue;
    }
    const g = goldenPrices.get(key2(sku, ch)) ?? {};
    if (!watch.channels.includes(ch) || !g.list || !g.floor) {
      out.push(
        mk(
          'promo_unverifiable',
          ch,
          {
            sku,
            key: r.program_id,
            ev: {
              program_id: r.program_id,
              start: r.start,
              has_list: 'list' in g,
              has_floor: 'floor' in g,
            },
          },
          meta,
        ),
      );
      continue;
    }
    const lst = g.list.price;
    const cap = watch.max_discount_pct[ch] as number;
    const price = after(lst, [r]);
    if (offOver(lst, price, cap)) {
      out.push(
        mk(
          'promo_over_cap',
          ch,
          {
            sku,
            key: r.program_id,
            ev: { program_ids: [r.program_id], list: lst, after: intPrice(price), cap_pct: cap },
          },
          meta,
        ),
      );
    }
    const k = `${sku}\0${ch}`;
    ok.set(k, [...(ok.get(k) ?? []), r]);
  }
  // Theo ngày: KM chồng + giá sau KM gộp (1 phát hiện / tổ hợp KM).
  const done = new Set<string>();
  const groups = [...ok.entries()].sort((a, b) => cmpTuple(a[0].split('\0'), b[0].split('\0')));
  for (const [k, rs] of groups) {
    const [sku, ch] = k.split('\0') as [string, string];
    const g = goldenPrices.get(key2(sku, ch)) as Record<
      string,
      { price: number; approved: boolean }
    >;
    const lst = (g.list as { price: number }).price;
    const floor = g.floor as { price: number; approved: boolean };
    const cap = watch.max_discount_pct[ch] as number;
    const cost = cogsAt(cogs, sku, today);
    const starts = rs.map((r) => r.start).sort();
    const ends = rs.map((r) => r.end).sort();
    const lo = [today, starts[0] as Day].sort()[1] as Day;
    const hi = [horizon, ends[ends.length - 1] as Day].sort()[0] as Day;
    for (let d = lo; d <= hi; d = addDays(d, 1)) {
      const act = rs.filter((r) => r.start <= d && d <= r.end);
      if (!act.length) continue;
      const pids = act.map((r) => r.program_id).sort(cpCmp);
      const first = [...act].sort((a, b) =>
        cmpTuple([a.start, a.program_id], [b.start, b.program_id]),
      )[0] as PlanRow;
      const mx = act.map((r) => r.start).sort()[act.length - 1] as Day;
      const meta = {
        program_ids: pids,
        start: mx,
        end: act.map((r) => r.end).sort()[0] as Day,
        label: windowLabel(mx, today),
        cam: false,
      };
      const price = after(lst, act);
      const ev = { program_ids: pids, list: lst, floor: floor.price, after: intPrice(price) };
      const add = (kind: string, extra: Record<string, unknown>) => {
        const dk = [kind, sku, ch, ...pids].join('\0');
        if (done.has(dk)) return;
        done.add(dk);
        out.push(mk(kind, ch, { sku, key: first.program_id, ev: { ...ev, ...extra } }, meta));
      };
      if (act.length > watch.max_stacked_promos)
        add('promo_stacked', { max: watch.max_stacked_promos });
      if (act.length > 1 && offOver(lst, price, cap)) add('promo_over_cap', { cap_pct: cap });
      if (below(price, floor.price)) add('promo_below_floor', { floor_approved: floor.approved });
      const r = Object.hasOwn(netRatio, ch) ? netRatio[ch] : undefined;
      if (cost === null || r === undefined) {
        add('promo_margin_unknown', { has_cogs: cost !== null, has_net_ratio: r !== undefined });
      } else if (margin(intPrice(price), r as Ratio, cost) < 0) {
        add('promo_negative_margin', {
          cogs: cost,
          net_ratio: (r as Ratio).s,
          margin: margin(intPrice(price), r as Ratio, cost),
        });
      }
    }
  }
  return sortFindings(out);
}

// ---------------------------------------------------------------- payload

export function markDups(findings: Finding[], v33: Map<string, number>): void {
  for (const f of findings) {
    const k = V33_DUP[f.kind];
    if (!k) continue;
    const aid = v33.get([k, f.channel, f.item_id || '', f.seller_sku || ''].join('\0'));
    if (aid !== undefined) f.dup_alert = aid;
  }
}

export function objectType(f: Pick<Finding, 'severity' | 'kind'>): string {
  if (f.severity === 'S1') return 'market_alert_s1';
  return PROMO_FINDINGS.has(f.kind) ? 'promo_change' : 'price_change';
}

export function where(f: Finding): string {
  const parts = [`kênh ${f.channel}`];
  if (f.item_id) parts.push(`mã sản phẩm sàn ${refCode(f.item_id)}`);
  if (f.program_ids?.length) parts.push(`chương trình ${f.program_ids.map(refCode).join(', ')}`);
  // SKU nhóm CAM (rượu...) KHÔNG in sku_key (từ khóa → guardrail chặn).
  if (f.sku_key && !f.cam) parts.push(`SKU ${refCode(f.sku_key)}`);
  return parts.join(', ');
}

const days = (f: Finding) => (f.start ? `${f.label}, ${dmy(f.start)}–${dmy(f.end as Day)}` : '');

/** Hạn xử lý: KM đang chạy → 'ngay'; dự kiến → trước ngày bắt đầu. */
const by = (f: Finding) =>
  f.label === 'đang chạy' ? 'ngay (đang chạy)' : `trước ${dmy(f.start as Day)}`;

/** [title, payload] từ TEMPLATE. Số CHỈ từ golden/file sàn/kế hoạch — không bao giờ giá đối thủ, không
 * tự tính 'giá nên đặt'. */
export function payloadOf(f: Finding): [string, string] {
  const ev = (f.evidence ?? {}) as Record<string, never>;
  const kind = f.kind;
  const label = KIND_LABELS[kind] as string;
  const wh = where(f);
  let num: string;
  let todo: string;
  if (kind === 'below_floor') {
    num =
      `giá niêm yết ${vnd(ev.price_san)}, giá bán thực ${vnd(ev.price_eff)}, giá sàn golden ${vnd(ev.floor)}` +
      (ev.floor_approved ? '' : ' (giá sàn CHƯA duyệt)');
    todo = `đưa giá bán về ≥ giá sàn ${vnd(ev.floor)}`;
  } else if (kind === 'negative_margin') {
    num = `giá bán thực ${vnd(ev.price_eff)}, giá vốn đã duyệt ${vnd(ev.cogs)}, tỷ lệ thực nhận GIẢ ĐỊNH ${ev.net_ratio}, biên ước tính ${vnd(ev.margin)}`;
    todo = 'GĐ bán hàng xem lại giá bán/khuyến mãi (agent không tính giá nên đặt)';
  } else if (kind === 'list_deviation') {
    num =
      `giá niêm yết trên sàn ${vnd(ev.price_san)}, giá list golden ${vnd(ev.list)}` +
      (ev.list_approved ? '' : ' (CHƯA duyệt)') +
      `, ngưỡng lệch ${ev.pct}%`;
    todo = `đưa về giá niêm yết ${vnd(ev.list)}`;
  } else if (kind === 'listing_promo_over_cap') {
    num = `giá bán thực ${vnd(ev.price_eff)}, giá list golden ${vnd(ev.list)}, trần chiết khấu ${ev.cap_pct}%`;
    todo = 'GĐ bán hàng xem lại mức chiết khấu trên sàn';
  } else if (kind === 'promo_banned') {
    num = `mức sẵn sàng golden ${ev.readiness}`;
    todo = `hủy khuyến mãi ${by(f)} — SKU không được quảng bá trên kênh này`;
  } else if (kind === 'promo_unverifiable') {
    num = !(ev.has_list && ev.has_floor)
      ? `thiếu ${(
          [
            ['giá list golden', ev.has_list],
            ['giá sàn golden', ev.has_floor],
          ] as [string, boolean][]
        )
          .filter(([, o]) => !o)
          .map(([n]) => n)
          .join(', ')}`
      : 'kênh ngoài cấu hình giám sát';
    todo = `xem lại/hoãn khuyến mãi ${by(f)} tới khi có giá golden đã duyệt`;
  } else {
    // promo_below_floor / promo_negative_margin / stacked / over_cap / margin_unknown
    num =
      'floor' in ev
        ? `giá list golden ${vnd(ev.list)}, giá sàn golden ${vnd(ev.floor)}`
        : `giá list golden ${vnd(ev.list)}`;
    num += `, giá sau khuyến mãi gộp ${vnd(ev.after)}`;
    if ('cap_pct' in ev) num += `, trần chiết khấu ${ev.cap_pct}%`;
    if ('max' in ev) num += `, tối đa ${ev.max} khuyến mãi cùng lúc`;
    if ('cogs' in ev) num += `, giá vốn đã duyệt ${vnd(ev.cogs)}, biên ước tính ${vnd(ev.margin)}`;
    todo = `xem lại/hủy khuyến mãi ${(f.program_ids ?? []).map(refCode).join(', ')} ${by(f)}`;
  }
  const head =
    f.severity === 'S1'
      ? 'Cảnh báo sàn S1 (A5 giá & khuyến mãi)'
      : PROMO_FINDINGS.has(kind)
        ? 'Khuyến mãi dự kiến cần xem lại (A5, NHÁP)'
        : 'Đề xuất giá (A5, NHÁP)';
  const d = days(f);
  const payload = `${head}: ${label} — ${wh}${d ? ` (${d})` : ''}. Số liệu: ${num}. Đề xuất NHÁP: ${todo}. ${NO_AUTO}`;
  return [`${label} — ${wh}`, payload];
}

export function toItems(findings: Finding[], cfg: DirectorConfig): Item[] {
  const out: Item[] = [];
  for (const f of findings) {
    if (f.severity === 'INFO' || (f.dup_alert !== undefined && f.dup_alert !== null)) continue;
    const ot = objectType(f);
    const [title, payload] = payloadOf(f);
    out.push({
      object_type: ot,
      object_id: f.object_id as string,
      title: `${(cfg.object_types[ot] as { label?: unknown }).label} — ${title}`,
      payload,
    });
  }
  return out;
}

/** CSV kế hoạch + KM nội bộ đã duyệt; trùng (program_id, kênh, SKU) → giữ dòng CSV. */
export function mergePlan(planRows: PlanRow[] | null, internal: PlanRow[]): PlanRow[] {
  const rows = [...(planRows ?? [])];
  const k = (r: PlanRow) => [r.program_id, r.channel, r.sku_key].join('\0');
  const have = new Set(rows.map(k));
  return [...rows, ...internal.filter((r) => !have.has(k(r)))];
}

/** Mục khối finance (`promo_loss`) cho KM lỗ / không tính được biên. */
export function financeItems(findings: Finding[]): Item[] {
  return findings
    .filter((f) => FINANCE_KINDS.includes(f.kind))
    .map((f) => {
      const [title, payload] = payloadOf(f);
      return {
        object_type: FIN_OT,
        object_id: `fin:${f.object_id}`,
        title: `Khuyến mãi lỗ/không tính được biên — ${title}`,
        payload: `${payload} GĐ tài chính xem biên; quyết định KM vẫn thuộc GĐ bán hàng (mục khối sales cùng mã).`,
      };
    });
}

// ---------------------------------------------------------------- báo cáo

/** Chữ người nhập (tên đối thủ) vào ô bảng markdown: bỏ ký tự điều khiển, cắt độ dài, '|' → '/'. */
export const cell = (s: unknown, n: number): string => clean(s, n).replaceAll('|', '/');

/** [(id, ngày)] sự kiện lịch mùa trong [today, today + days]. */
export function seasonEvents(calendar: Calendar | null, today: Day, n: number): [string, Day][] {
  if (calendar === null) return [];
  const end = addDays(today, n);
  const out: [string, Day][] = [];
  for (const ev of calendar.events) {
    const d = eventDate(ev);
    if (today <= d && d <= end) out.push([ev.id, d]);
  }
  return out.sort((a, b) => cmpTuple([a[1], a[0]], [b[1], b[0]]));
}

export type Competitor = [string | null, string, string, number, number | null, Day];
export type Analysis = {
  listing: Finding[];
  promo: Finding[];
  channels: string[];
  competitor: Competitor[];
};

/** THUẦN, tất định. S1 trước S2; nhóm CAM không in SKU. */
export function renderReport(
  res: Analysis,
  watch: Watch,
  today0: Day,
  planRows: PlanRow[] | null,
  calendar: Calendar | null,
  planInfo: { new: number; seen: number; dup: number } | null = null,
): string {
  const today = coerceDay(today0);
  const fs = [...res.listing, ...res.promo].filter((f) => f.severity !== 'INFO');
  const info = res.listing.filter((f) => f.severity === 'INFO');
  const caps = Object.entries(watch.max_discount_pct)
    .sort((a, b) => cpCmp(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}%`)
    .join(', ');
  const L = [
    `# Giám sát giá & khuyến mãi (A5) — ${dmy(today)}`,
    '',
    `Cấu hình \`data/price_watch.json\`: ${watch.status} · người chốt: ${watch.confirmed_by || 'chưa có (external-dep)'} · ngưỡng lệch niêm yết ${watch.list_deviation_pct}% · trần chiết khấu ${caps} · tối đa ${watch.max_stacked_promos} KM chồng · nhìn trước ${watch.lookahead_days} ngày.`,
    'Agent CHỈ ĐỌC — mọi đề xuất là NHÁP trong hàng duyệt; agent KHÔNG đổi giá/khuyến mãi/listing.',
    '',
  ];
  L.push(
    planRows === null
      ? '- [info] chưa có kế hoạch KM (--plan) — chỉ kiểm giá đang chạy trên sàn'
      : `- Kế hoạch KM: ${planRows.length} dòng`,
  );
  if (planInfo !== null) {
    L.push(
      `- Sẽ đẩy mục mới: ${planInfo.new} · đã có trong hàng duyệt: ${planInfo.seen} · trùng cảnh báo sàn: ${planInfo.dup}`,
    );
  }
  for (const sev of ['S1', 'S2']) {
    const part = fs.filter((f) => f.severity === sev);
    L.push('', `## ${sev} (${part.length})`, '');
    for (const f of part) {
      const dup =
        f.dup_alert !== undefined && f.dup_alert !== null
          ? ` (đã có cảnh báo sàn #${f.dup_alert})`
          : '';
      const d = days(f);
      L.push(`- ${KIND_LABELS[f.kind]} — ${where(f)}${d ? ` (${d})` : ''}${dup}`);
    }
    if (!part.length) L.push('- (không có)');
  }
  L.push('', `## Giá vốn (${info.length} listing ${NO_COGS})`, '');
  L.push(
    ...(info.length
      ? info.map((f) => `- kênh ${f.channel}, SKU ${refCode(f.sku_key)}: ${NO_COGS}`)
      : ['- (không có)']),
  );
  const evDays = seasonEvents(calendar, today, watch.lookahead_days);
  L.push(
    '',
    `## Sự kiện mùa trong ${watch.lookahead_days} ngày tới`,
    '',
    '| Sự kiện | Ngày | Dòng KM gắn | Phát hiện |',
    '|---|---|---|---|',
  );
  for (const [eid, d] of evDays) {
    const rows = (planRows ?? []).filter((r) => r.event === eid);
    const pids = new Set(rows.map((r) => r.program_id));
    const nF = res.promo.filter((f) => (f.program_ids ?? []).some((p) => pids.has(p))).length;
    L.push(`| ${eid} | ${dmy(d)} | ${rows.length} | ${nF} |`);
  }
  if (!evDays.length) L.push('| — | — | 0 | 0 |');
  L.push(
    '',
    '## Tham khảo đối thủ (KHÔNG dùng để đề xuất giá)',
    '',
    'Giá đối thủ do người ghi tay (v7.2) — chỉ để GĐ bán hàng tham khảo; agent KHÔNG đua giá, không đưa vào đề xuất.',
    '',
    '| SKU tương đương | Kênh | Đối thủ | Giá | Giá KM | Ngày ghi |',
    '|---|---|---|---|---|---|',
  );
  const comp = res.competitor ?? [];
  L.push(
    ...(comp.length
      ? comp.map(
          ([s, ch, c, p, pp, d]) =>
            `| ${s ? refCode(s) : '(nhóm CAM)'} | ${cell(ch, 20)} | ${cell(c, 60)} | ${vnd(p)} | ${vnd(pp)} | ${dmy(d)} |`,
        )
      : ['| — | — | — | — | — | — |']),
  );
  L.push('', '---', '*BẢN NHÁP — hệ thống không tự gửi, không tự đổi giá.*', '');
  return L.join('\n');
}

// ---------------------------------------------------- v14.4 giá đại lý (sales-06.1)

export const FEATURE_DEALER = 'sales-06.1';
export const OT_DEALER = 'dealer_price_alert';
export const GOLDEN_CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'];
const HOST_RE = /^[a-z0-9.-]{1,100}$/;

/** Python `urlsplit(url)` tối thiểu → [scheme, netloc] | null (ValueError): ngoặc IPv6 lệch / host
 * trong ngoặc không phải IPv6 (IPvFuture `v…` coi như hỏng — chặt hơn), netloc NFKC sinh ký tự tách
 * URL (`_checknetloc`). */
export function urlSplit(url: string): [string, string] | null {
  let k = 0;
  while (k < url.length && url.charCodeAt(k) <= 0x20) k++; // lstrip C0 + dấu cách (WHATWG)
  let rest = url.slice(k).replace(/[\t\r\n]/g, '');
  let scheme = '';
  const i = rest.indexOf(':');
  if (i > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(rest.slice(0, i))) {
    scheme = rest.slice(0, i).toLowerCase();
    rest = rest.slice(i + 1);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const m = /[/?#]/.exec(rest.slice(2));
    netloc = m ? rest.slice(2, 2 + m.index) : rest.slice(2);
    if (netloc.includes('[') !== netloc.includes(']')) return null;
    if (netloc.includes('[')) {
      const br = netloc.slice(netloc.indexOf('[') + 1);
      if (isIP(br.slice(0, br.indexOf(']') < 0 ? undefined : br.indexOf(']'))) !== 6) return null;
    }
    if ([...netloc].some((c) => c.charCodeAt(0) > 0x7f)) {
      const n = netloc.replace(/[@:#?]/g, '');
      const n2 = n.normalize('NFKC');
      if (n !== n2 && [...'/?#@:'].some((c) => n2.includes(c))) return null;
    }
  }
  return [scheme, netloc];
}

/** `urlsplit(url).hostname`: bỏ userinfo/cổng, chữ thường (phần trước '%') | null. */
export function hostname(netloc: string): string | null {
  const info = netloc.slice(netloc.lastIndexOf('@') + 1);
  const ob = info.indexOf('[');
  let h: string;
  if (ob >= 0) {
    const br = info.slice(ob + 1);
    h = br.indexOf(']') < 0 ? br : br.slice(0, br.indexOf(']'));
  } else h = info.split(':')[0] ?? '';
  if (!h) return null;
  const pc = h.indexOf('%');
  return pc < 0 ? h.toLowerCase() : h.slice(0, pc).toLowerCase() + h.slice(pc);
}

/** Tên miền nguồn (chỉ [a-z0-9.-]) — khác → '(trang lạ)'. Không đưa đường dẫn vào payload. */
export function host(url: unknown): string {
  const sp = typeof url === 'string' ? urlSplit(url) : null;
  const h = sp ? (hostname(sp[1]) ?? '') : '';
  return HOST_RE.test(h) ? h : '(trang lạ)';
}

export type DealerFinding = {
  object_id: string;
  obs_id: number;
  channel: string;
  dealer: string;
  sku: string;
  cam: boolean;
  price: number;
  day: Day;
  floor: number;
  floor_channel: string;
  floor_approved: boolean;
  ref: string;
  host: string;
};

/** Mục hàng duyệt: chỉ mã đại lý/mã SKU (nhóm rượu ẩn mã)/giá/ngày/tên miền nguồn — agent KHÔNG
 * liên hệ đại lý, KHÔNG đổi giá. */
export function dealerItem(f: DealerFinding, cfg: DirectorConfig): Item {
  const sku = f.cam ? 'nhóm hạn chế' : refCode(f.sku);
  const label = (cfg.object_types[OT_DEALER] as { label?: unknown }).label;
  const wh = `đại lý ${f.dealer}, SKU ${sku}, kênh ${f.channel}, ngày ${dmy(f.day)}`;
  return {
    object_type: OT_DEALER,
    object_id: f.object_id,
    title: `${label} — ${wh}`,
    payload:
      `Giá đại lý quan sát tay dưới giá sàn (A5, NHÁP): ${wh}. Số liệu: giá quan sát ${vnd(f.price)}, giá sàn golden ${vnd(f.floor)} (${f.ref}, kênh ${f.floor_channel})` +
      (f.floor_approved ? '' : ' (giá sàn CHƯA duyệt)') +
      `. Nguồn: quan sát #${f.obs_id}, trang ${f.host}. Việc cần làm: GĐ bán hàng xác minh lại trang nguồn và làm việc với đại lý theo hợp đồng đại lý. Agent KHÔNG liên hệ đại lý, KHÔNG đổi giá.`,
  };
}

export { PyFloat };
