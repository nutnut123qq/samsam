import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { isPlainObject, JsonFileError, parseJsonBytes } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { cpLen, pyStr, pyStrip } from '@samsam/core/security/py';
import pg from 'pg';
import {
  type Cell,
  clean,
  MAX_FILE_BYTES,
  nfc,
  safe,
  suffixOf,
  TableError,
  type TableRow,
  table,
  toInt,
} from '../intel_import/table.js';

// Port `ingest/settlement_csv.py` (v9.0 ACC-Recon, WP12) — nạp file quyết toán (income/settlement)
// kế toán xuất TAY từ Seller Center Shopee / TikTok Shop, đối chiếu từng đơn với đơn sàn đã nạp
// (`market_rows` export `order`) + biểu phí cấu hình → MỖI dòng đúng 1 nhãn. Chỉ BÁO CÁO — không ghi
// sổ, không bút toán, không LLM. Ghi DUY NHẤT `settlement_rows` + `recon_results`; chỉ ĐỌC `market_rows`.
//  - Kiểm TOÀN file + mapping (`data/settlement_map.json`, GIẢ ĐỊNH) + biểu phí (`data/settlement_fees.json`,
//    GIẢ ĐỊNH) TRƯỚC khi connect. Lỗi → in số dòng + tên field (KHÔNG giá trị ô), exit 1, 0 dòng.
//  - `file_sha256` đã có → `[skip]` exit 0. Mới → 1 transaction: khóa (kênh, đơn) → kiểm đã nạp →
//    chặn nguồn khác (API sàn) → insert → đối chiếu → commit.
//  - Dấu số tiền: `fees_negative: true` ⇒ cột khấu trừ đổi dấu → khoản trừ DƯƠNG; `refund` âm sau
//    chuẩn hóa / `order_amount` âm → lỗi dòng. Mã đơn → `order_id_hash` = sha256("kênh:mã")[:16].
//  - Chồng kỳ (v13.2 F01): cùng khoản ở file khác KHÔNG bị chặn lúc nạp; số doanh thu đọc view
//    `v_settlement_khoan`; `overlaps()` báo nhóm ở ≥2 file (`trung`/`lech`).
//  - r17: finance-01 TẮT → dòng ĐÃ nạp + commit, KHÔNG đối soát, exit 2 (chặn một phần).
// Số tiền: mỗi ô ≤ MONEY_CAP (10^15 < 2^53) nên dòng parse dùng `number`; tổng/đối chiếu dùng bigint.

export const MAP_FILE = dataPath('settlement_map.json');
export const FEES_FILE = dataPath('settlement_fees.json');
export const CHANNELS = ['shopee', 'tiktok'] as const;
export const FIELDS = [
  'order_id',
  'order_amount',
  'fixed_fee',
  'payment_fee',
  'service_fee',
  'shipping_fee',
  'voucher_seller',
  'affiliate',
  'refund',
  'payout',
  'settled_on',
  'txn_type',
] as const;
export const TXN_TYPE_MAX = 64;
export const MUST = ['order_id', 'order_amount', 'payout'] as const;
// Khoản KHẤU TRỪ (đổi dấu khi fees_negative) — thứ tự = cột DB.
export const DEDUCT = [
  'fixed_fee',
  'payment_fee',
  'service_fee',
  'shipping_fee',
  'voucher_seller',
  'affiliate',
  'refund',
] as const;
export const MONEY = ['order_amount', ...DEDUCT, 'payout'] as const;
export type MoneyKey = (typeof MONEY)[number];
export const MONEY_CAP = 10 ** 15;
// (mã lý do, field phí, khóa pct trong biểu phí)
export const FEE_CHECKS = [
  ['phi_co_dinh', 'fixed_fee', 'fixed_fee_pct'],
  ['phi_thanh_toan', 'payment_fee', 'payment_fee_pct'],
  ['phi_dich_vu', 'service_fee', 'service_fee_pct'],
] as const;
export const LABELS = ['khop', 'lech', 'thieu_chung_tu', 'hoan'] as const;
export type Label = (typeof LABELS)[number];
export const MAX_REPORT_LINES = 200;
export const FEATURE_RECON = 'finance-01';
/** Cột tiền DB (thứ tự `_COLS` Python) — `<cột>_vnd`. */
export const COLS = MONEY;
// r15-fix1 F1: số ngăn khóa (kênh, đơn) — trần số khóa/transaction.
export const LOCK_BUCKETS = 256;

const DMY_RE = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;
const YMD_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]00:00(?::00)?)?$/;

// ---------------------------------------------------------------- số thập phân chính xác

/** Python `Decimal`: giá trị = n / 10^k (k ≥ 0). */
export type Dec = { n: bigint; k: number };

/** `Decimal(s)` cho chuỗi số thập phân thường / mũ (`1e-07`, `1E+3`) → Dec | null. */
export function decFrom(s: string): Dec | null {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const frac = m[3] ?? '';
  let n = BigInt(`${m[2] || '0'}${frac}`);
  let k = frac.length - Number(m[4] ?? 0);
  if (k < 0) {
    n *= 10n ** BigInt(-k);
    k = 0;
  }
  return { n: m[1] === '-' ? -n : n, k };
}

/** Python `Decimal(str(v))` của số JSON (String(v) của JS = repr ngắn nhất như Python). */
export function decOf(v: number): Dec {
  return decFrom(String(v)) as Dec;
}

const P10 = (k: number) => 10n ** BigInt(k);

/** So sánh giá trị hai Dec: <0, 0, >0. */
export function decCmp(a: Dec, b: Dec): number {
  const k = Math.max(a.k, b.k);
  const x = a.n * P10(k - a.k);
  const y = b.n * P10(k - b.k);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Python `format(d.normalize(), 'f')` — chuỗi thập phân thường, bỏ số 0 thừa. */
export function decStr(d: Dec): string {
  let { n, k } = d;
  while (k > 0 && n % 10n === 0n) {
    n /= 10n;
    k--;
  }
  const neg = n < 0n;
  let s = (neg ? -n : n).toString();
  if (k > 0) {
    s = s.padStart(k + 1, '0');
    s = `${s.slice(0, s.length - k)}.${s.slice(s.length - k)}`;
  }
  return (neg ? '-' : '') + s;
}

/** Python `round_half_up(x)` (ROUND_HALF_UP: .5 xa số 0) của x = num/den. */
export function roundHalfUp(num: bigint, den: bigint = 1n): bigint {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = (2n * a + d) / (2n * d);
  return neg ? -q : q;
}

/** round_half_up(amount × pct) → bigint (Python `round_half_up(Decimal(amt) * pct)`). */
export function mulRound(amount: bigint, pct: Dec): bigint {
  return roundHalfUp(amount * pct.n, P10(pct.k));
}

const big = (v: number | bigint): bigint => (typeof v === 'bigint' ? v : BigInt(v));
const absB = (v: bigint): bigint => (v < 0n ? -v : v);

/** Python `f"{int(n):,}".replace(",", ".") + "đ"`. */
export function vnd(n: bigint | number): string {
  const v = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${s}đ`;
}

/** Python repr của tuple chuỗi ASCII: ('a', 'b'). */
export const pyTuple = (xs: readonly string[]): string =>
  `(${xs.map((x) => `'${x}'`).join(', ')}${xs.length === 1 ? ',' : ''})`;

// ---------------------------------------------------------------- đọc số / ngày / header

/** Hash mã đơn — PHẢI giống `market_csv._parse` (test parity): sha256("kênh:mã")[:16]. */
export function orderHash(channel: string, orderId: string): string {
  return createHash('sha256').update(`${channel}:${orderId}`, 'utf8').digest('hex').slice(0, 16);
}

/** `_to_signed`: số nguyên VND có dấu `-` đầu tùy chọn; phần số theo `market_csv._to_int`. Sai → null. */
export function toSigned(s: string | null | undefined, cap: number = MONEY_CAP): number | null {
  if (s === null || s === undefined) return null;
  const t = pyStrip(s);
  const neg = t.startsWith('-');
  const n = toInt(neg ? t.slice(1) : t, cap);
  if (n === null) return null;
  return neg && n !== 0 ? -n : n;
}

/** Ngày hợp lệ (lịch Gregory, năm 1..9999) → 'YYYY-MM-DD' | null. */
export function ymd(y: number, m: number, d: number): string | null {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > (dim[m - 1] as number)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `_to_date`: `YYYY-MM-DD` (xlsx datetime 00:00 cũng nhận) hoặc `DD/MM/YYYY` → 'YYYY-MM-DD' | null. */
export function toDate(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = pyStrip(s);
  let m = YMD_RE.exec(t);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = DMY_RE.exec(t);
  if (m) return ymd(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

export type HeaderMap = Record<string, number>;

/**
 * `map_header`: header file → [{field: chỉ số cột}, lỗi]. Header trống/trùng/lạ, thiếu cột bắt buộc
 * → lỗi; header lạ in qua `safe` (che SĐT/email). Dòng đầu không khớp cột bắt buộc nào → 1 lỗi duy
 * nhất (dòng đầu nhiều khả năng là DỮ LIỆU — không in ô).
 */
export function mapHeader(
  header: readonly Cell[],
  required: Record<string, string>,
  optional: Record<string, string>,
  drop: readonly string[],
  ctx: string,
): [HeaderMap, string[]] {
  const hdr = header.map((h) => (h === null ? null : nfc(h)));
  const want = new Map<string, string>();
  for (const [f, h] of Object.entries(optional)) want.set(f, nfc(h));
  for (const [f, h] of Object.entries(required)) want.set(f, nfc(h));
  const byHeader = new Map<string, string>();
  for (const [f, h] of want) byHeader.set(h, f);
  const dropSet = new Set(drop.map(nfc));
  const colOf: HeaderMap = {};
  const errs: string[] = [];
  const seen = new Set<string>();
  hdr.forEach((h, j) => {
    if (h === null) {
      errs.push(`header cột ${j + 1} trống`);
      return;
    }
    if (seen.has(h)) {
      errs.push(`header trùng: '${safe(h)}'`);
      return;
    }
    seen.add(h);
    const f = byHeader.get(h);
    if (f !== undefined) colOf[f] = j;
    else if (!dropSet.has(h)) {
      errs.push(
        `cột lạ '${safe(h)}' (không thuộc required/optional/` +
          'drop — thêm vào mapping sau khi xác minh)',
      );
    }
  });
  const missing = Object.entries(required)
    .filter(([f]) => !Object.hasOwn(colOf, f))
    .map(([, h]) => h);
  const nReq = Object.keys(required).length;
  if (missing.length && missing.length === nReq) {
    return [
      {},
      [
        `dòng đầu không khớp header ${ctx} (${hdr.length} cột,` +
          ` 0/${nReq} cột bắt buộc) — sai kênh/loại ` +
          'file hoặc thiếu dòng header',
      ],
    ];
  }
  if (missing.length) {
    errs.push(`thiếu cột bắt buộc: ${missing.map((h) => `'${nfc(h)}'`).join(', ')}`);
  }
  return [colOf, errs];
}

/** Iterator ném lỗi ở lần duyệt đầu (Python: lỗi `_table` nổi lên khi caller lặp). */
const throwing = (e: unknown): Iterator<TableRow> => ({
  next: () => {
    throw e;
  },
});

/**
 * `read_table` → [iterator dòng | null, sha | null, lỗi | null] — đuôi/trần byte/rỗng. Lỗi cấu trúc
 * file (TableError) nổi lên LÚC DUYỆT như Python (caller bắt khi lặp).
 */
export async function readTable(
  path: string,
): Promise<[Iterator<TableRow> | null, string | null, string | null]> {
  const suffix = suffixOf(path);
  if (suffix !== '.csv' && suffix !== '.xlsx') {
    return [null, null, `đuôi '${suffix}' không hỗ trợ — chỉ .csv / .xlsx`];
  }
  let data: Buffer;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) {
      return [null, null, `file > ${Math.floor(MAX_FILE_BYTES / 2 ** 20)}MB — tách file`];
    }
    data = readFileSync(path);
  } catch (e) {
    return [null, null, `không đọc được file: ${pyOsName(e)}`];
  }
  const sha = createHash('sha256').update(data).digest('hex');
  // bytes.isspace(): chỉ khoảng trắng ASCII
  if (!data.length || data.every((b) => b === 0x20 || (b >= 0x09 && b <= 0x0d))) {
    return [null, sha, 'file rỗng'];
  }
  try {
    return [await table(data, suffix), sha, null];
  } catch (e) {
    if (e instanceof TableError) return [throwing(e), sha, null];
    throw e;
  }
}

// ---------------------------------------------------------------- cấu hình

export type ChannelSpec = {
  required: Record<string, string>;
  optional?: Record<string, string>;
  drop?: string[];
  fees_negative: boolean;
};
export type Mapping = Record<string, ChannelSpec>;
export type ChannelFees = {
  fixed_fee_pct: Dec;
  payment_fee_pct: Dec;
  service_fee_pct: Dec;
  tolerance_vnd: number;
};
export type Fees = Record<string, ChannelFees>;

function loadJson(path: string): [unknown, string | null] {
  try {
    return [parseJsonBytes(readFileSync(path)), null];
  } catch (e) {
    const name = e instanceof JsonFileError ? e.pyType : pyOsName(e);
    return [null, `không đọc được ${basename(path)}: ${name}`];
  }
}

const strMap = (v: unknown): v is Record<string, string> =>
  isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');

/**
 * `load_mapping` → [mapping, null] | [null, lý do]. TS chặt hơn (Python crash/nhận sai khi mapping
 * hỏng dạng): `optional` không phải object chuỗi, `drop` không phải list chuỗi, header không phải
 * chuỗi → "field lạ hoặc trùng" (fail-closed, không nạp).
 */
export function loadMapping(path: string = MAP_FILE): [Mapping | null, string | null] {
  const [m, why] = loadJson(path);
  if (why !== null) return [null, why];
  const name = basename(path);
  for (const ch of CHANNELS) {
    const spec = isPlainObject(m) ? m[ch] : undefined;
    if (!isPlainObject(spec) || !isPlainObject(spec.required)) {
      return [null, `${name}: thiếu kênh ${ch}/required`];
    }
    const opt = spec.optional ?? {};
    const drop = spec.drop ?? [];
    if (
      !strMap(spec.required) ||
      !strMap(opt) ||
      !Array.isArray(drop) ||
      !drop.every((x) => typeof x === 'string')
    ) {
      return [null, `${name}/${ch}: field lạ hoặc trùng`];
    }
    const fields = [...Object.keys(spec.required), ...Object.keys(opt)];
    if (
      !fields.every((f) => (FIELDS as readonly string[]).includes(f)) ||
      fields.length !== new Set(fields).size
    ) {
      return [null, `${name}/${ch}: field lạ hoặc trùng`];
    }
    if (!MUST.every((f) => Object.hasOwn(spec.required as object, f))) {
      return [null, `${name}/${ch}: required phải có ${pyTuple(MUST)}`];
    }
    if (typeof spec.fees_negative !== 'boolean') {
      return [null, `${name}/${ch}: fees_negative phải là bool`];
    }
  }
  return [m as Mapping, null];
}

const HALF: Dec = { n: 5n, k: 1 };
const ZERO: Dec = { n: 0n, k: 0 };

/**
 * `load_fees` → [{kênh: {pct Dec..., tolerance_vnd}}, null] | [null, lỗi].
 * shortcut: `tolerance_vnd: 100.0` (số thực nguyên) Python từ chối, TS nhận (JSON.parse không phân
 * biệt 100 với 100.0) — giá trị vẫn là số nguyên trong 0..100000; nâng khi cần đọc JSON giữ kiểu số.
 */
export function loadFees(path: string = FEES_FILE): [Fees | null, string | null] {
  const [raw, why] = loadJson(path);
  if (why !== null) return [null, why];
  const name = basename(path);
  const out: Fees = {};
  for (const ch of CHANNELS) {
    const spec = isPlainObject(raw) ? raw[ch] : undefined;
    if (!isPlainObject(spec)) return [null, `${name}: thiếu kênh ${ch}`];
    const cfg: Partial<ChannelFees> = {};
    for (const [, , key] of FEE_CHECKS) {
      const v = spec[key];
      if (typeof v !== 'number') return [null, `${name}/${ch}.${key}: phải là số`];
      // JSON `1e400` → Infinity (Python: Decimal('Infinity') → ngoài khoảng)
      const d = Number.isFinite(v) ? decOf(v) : null;
      if (d === null || decCmp(d, ZERO) < 0 || decCmp(d, HALF) > 0) {
        return [null, `${name}/${ch}.${key}: ngoài 0..0.5`];
      }
      cfg[key] = d;
    }
    const t = spec.tolerance_vnd;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > 100_000) {
      return [null, `${name}/${ch}.tolerance_vnd: phải int 0..100000`];
    }
    cfg.tolerance_vnd = t;
    out[ch] = cfg as ChannelFees;
  }
  return [out, null];
}

// ---------------------------------------------------------------- parse (thuần)

export type SettleRow = {
  row_no: number;
  txn_type: string | null;
  order_id_hash: string;
  settled_on: string | null;
} & Record<MoneyKey, number>;

/**
 * `read_settlement` (thuần): → [rows, errors, sha256 file]. errors ≠ [] → rows = []. Mỗi row CHỈ
 * có field chuẩn (trừ order_id) + `row_no` + `order_id_hash` (+ `txn_type` str | null).
 */
export async function readSettlement(
  path: string,
  channel: string,
  mapping: unknown,
): Promise<[SettleRow[], string[], string | null]> {
  const spec = isPlainObject(mapping) ? mapping[channel] : undefined;
  if (!isPlainObject(spec) || !isPlainObject(spec.required)) {
    return [[], [`mapping thiếu kênh ${channel}`], null];
  }
  const [tbl, sha, err] = await readTable(path);
  if (err !== null || tbl === null) return [[], [err as string], sha];
  let rows: SettleRow[];
  let errs: string[];
  try {
    [rows, errs] = parse(tbl, channel, spec as ChannelSpec);
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
  return [errs.length ? [] : rows, errs, sha];
}

function parse(
  table: Iterator<TableRow>,
  channel: string,
  spec: ChannelSpec,
): [SettleRow[], string[]] {
  const first = table.next();
  if (first.done) return [[], ['file rỗng']];
  const header = first.value[1];
  const [colOf, errs] = mapHeader(
    header,
    spec.required,
    spec.optional ?? {},
    spec.drop ?? [],
    `quyết toán ${channel}`,
  );
  if (errs.length) return [[], errs];
  const flip = spec.fees_negative;
  const width = header.length;
  const rows: SettleRow[] = [];
  const seen = new Map<string, number>();
  let nBody = 0;
  for (let it = table.next(); !it.done; it = table.next()) {
    const [rowNo, cells] = it.value;
    nBody++;
    if (cells.slice(width).some((c) => c !== null)) {
      errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
      continue;
    }
    const rec = (f: string): Cell => {
      const j = colOf[f];
      return j !== undefined && j < cells.length ? (cells[j] as Cell) : null;
    };
    const out: Record<string, unknown> = { row_no: rowNo };
    let bad = false;
    const rawTt = rec('txn_type');
    const tt = (rawTt !== null ? pyStrip(nfc(rawTt)) : '') || null;
    if (tt !== null && cpLen(tt) > TXN_TYPE_MAX) {
      errs.push(`dòng ${rowNo}: field 'txn_type' dài quá ${TXN_TYPE_MAX} ký tự`);
      bad = true;
    }
    out.txn_type = tt;
    const oid = rec('order_id');
    if (oid === null) {
      errs.push(`dòng ${rowNo}: thiếu mã đơn`);
      bad = true;
    } else {
      const h = orderHash(channel, oid);
      const key = tt === null ? `${h}|N` : `${h}|S${tt}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        errs.push(
          `dòng ${rowNo}: mã đơn trùng dòng ${prev} (GIẢ ĐỊNH 1 dòng/` +
            (Object.hasOwn(colOf, 'txn_type') ? 'đơn/loại giao dịch)' : 'đơn)'),
        );
        bad = true;
      } else seen.set(key, rowNo);
      out.order_id_hash = h;
    }
    for (const f of MONEY) {
      const v = rec(f);
      if (v === null && !Object.hasOwn(spec.required, f)) {
        out[f] = 0;
        continue;
      }
      let n = toSigned(v);
      if (n === null) {
        errs.push(`dòng ${rowNo}: field '${f}' không phải số nguyên VND hợp lệ`);
        bad = true;
        continue;
      }
      if (flip && (DEDUCT as readonly string[]).includes(f) && n !== 0) n = -n;
      out[f] = n;
    }
    if (!bad && (out.order_amount as number) < 0) {
      errs.push(`dòng ${rowNo}: field 'order_amount' âm`);
      bad = true;
    }
    if (!bad && (out.refund as number) < 0) {
      errs.push(`dòng ${rowNo}: field 'refund' âm sau chuẩn hóa dấu`);
      bad = true;
    }
    const v = rec('settled_on');
    out.settled_on = toDate(v);
    if (v !== null && out.settled_on === null) {
      errs.push(`dòng ${rowNo}: field 'settled_on' không phải ngày YYYY-MM-DD / DD/MM/YYYY`);
      bad = true;
    }
    if (!bad) rows.push(out as SettleRow);
  }
  if (!nBody) return [[], ['file chỉ có header, không có dòng dữ liệu']];
  return [rows, errs];
}

// ---------------------------------------------------------------- đối chiếu (thuần)

export type Reason = { code: string; expected: bigint; actual: bigint };
export type MoneyRow = Record<MoneyKey, number | bigint>;

/**
 * `reconcile_row` → [nhãn, lý do, thực nhận tính lại]. `row` theo field chuẩn (đã chuẩn hóa dấu),
 * `orderAmount` = tổng đơn sàn (null = không thấy đơn), `fees` = biểu phí 1 kênh từ `loadFees`.
 * Nhãn ưu tiên: không thấy đơn → `thieu_chung_tu` > hoàn > 0 → `hoan` > có lý do → `lech` > `khop`.
 */
export function reconcileRow(
  row: MoneyRow,
  orderAmount: number | bigint | null,
  fees: ChannelFees,
): [Label, Reason[], bigint] {
  const tol = BigInt(fees.tolerance_vnd);
  const amt = big(row.order_amount);
  const expected = DEDUCT.reduce((acc, f) => acc - big(row[f]), amt);
  const reasons: Reason[] = [];
  const payout = big(row.payout);
  if (absB(payout - expected) > tol) {
    reasons.push({ code: 'thuc_nhan', expected, actual: payout });
  }
  for (const [code, f, key] of FEE_CHECKS) {
    const expFee = mulRound(amt, fees[key]);
    const actual = big(row[f]);
    if (absB(actual - expFee) > tol) reasons.push({ code, expected: expFee, actual });
  }
  if (orderAmount !== null && amt !== big(orderAmount)) {
    reasons.push({ code: 'gia_tri_don', expected: big(orderAmount), actual: amt });
  }
  let label: Label;
  if (orderAmount === null) label = 'thieu_chung_tu';
  else if (big(row.refund) > 0n) label = 'hoan';
  else if (reasons.length) label = 'lech';
  else label = 'khop';
  return [label, reasons, expected];
}

/** jsonb lý do (số nguyên lớn giữ nguyên chữ số — JSON.stringify không nhận bigint). */
export function reasonsJson(rs: readonly Reason[]): string {
  return `[${rs
    .map(
      (r) =>
        `{"code": ${JSON.stringify(r.code)}, "expected": ${r.expected}, "actual": ${r.actual}}`,
    )
    .join(', ')}]`;
}

// ---------------------------------------------------------------- DB

const CHUNK = 500;

export type LoadRow = {
  row_no: number;
  order_id_hash: string;
  settled_on: string | null;
  txn_type?: string | null;
} & Record<MoneyKey, number | null>;

/**
 * `load`: insert `settlement_rows` (không commit) → số dòng. `sourceKind` = nguồn (`csv` file kế toán
 * xuất | `api_live` — `settlement-api`).
 */
export async function load(
  c: Db,
  rows: readonly LoadRow[],
  channel: string,
  fileName: string,
  sha: string,
  sourceKind = 'csv',
): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const params: unknown[] = [];
    const vals = rows.slice(i, i + CHUNK).map((r) => {
      const row = [
        sha,
        fileName,
        channel,
        r.row_no,
        r.order_id_hash,
        ...COLS.map((col) => (r[col] === null ? null : String(r[col]))),
        r.settled_on,
        r.txn_type ?? null,
        sourceKind,
      ];
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    await c.query(
      'insert into settlement_rows (file_sha256, file_name, channel,' +
        ' row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd,' +
        ' payment_fee_vnd, service_fee_vnd, shipping_fee_vnd,' +
        ' voucher_seller_vnd, affiliate_vnd, refund_vnd, payout_vnd,' +
        ` settled_on, txn_type, source_kind) values ${vals.join(', ')}`,
      params,
    );
  }
  return rows.length;
}

/**
 * r15: số đơn trong `hashes` ĐÃ có dòng quyết toán từ NGUỒN KHÁC `sourceKind` (csv ↔ api_live). Hai
 * nguồn có thể gắn `txn_type` khác nhau cho cùng khoản → caller CHẶN, người đối soát quyết.
 */
export async function crossSource(
  c: Db,
  channel: string,
  hashes: Iterable<string>,
  sourceKind: string,
): Promise<number> {
  const r = await c.query(
    'select count(distinct order_id_hash) as n from settlement_rows where' +
      ' channel = $1 and order_id_hash = any($2) and source_kind <> $3',
    [channel, pySorted(new Set(hashes)), sourceKind],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Kết nối không giữ được khóa tới hết transaction — không nạp. */
export class LockError extends Error {
  override name = 'LockError';
}

/** Khóa advisory của ngăn `bucket` (int8 có dấu: 8 byte đầu sha256, big-endian). */
export function lockKey(channel: string, bucket: number): bigint {
  const d = createHash('sha256')
    .update(`settlement_rows:nguon:${channel}:${bucket}`, 'utf8')
    .digest();
  return d.readBigInt64BE(0);
}

/** Ngăn khóa của các đơn (tăng dần — mọi caller lấy cùng thứ tự → không deadlock). */
export function lockBuckets(hashes: Iterable<string>): number[] {
  const s = new Set<number>();
  for (const h of hashes) s.add(Number(BigInt(`0x${h}`) % BigInt(LOCK_BUCKETS)));
  return [...s].sort((a, b) => a - b);
}

/** Thứ khóa được: client trong transaction (`autocommit` = Pool / client chưa `begin`). */
export type LockConn = Pick<pg.ClientBase, 'query'> & { autocommit?: boolean };

/**
 * `lock_orders`: `pg_advisory_xact_lock` theo (kênh, đơn) cho cả lô — câu ĐẦU của transaction ghi,
 * TRƯỚC kiểm file đã nạp + `crossSource` + `load`; nhả khi commit/rollback. READ COMMITTED bắt buộc:
 * câu kiểm sau khóa chụp snapshot mới → thấy dòng bên kia vừa commit.
 */
export async function lockOrders(
  c: LockConn | Db,
  channel: string,
  hashes: Iterable<string>,
): Promise<void> {
  if (c instanceof pg.Pool || (c as LockConn).autocommit === true) {
    throw new LockError('kết nối autocommit — khóa không giữ tới lúc ghi');
  }
  const iso = (await c.query("select current_setting('transaction_isolation') as iso")).rows[0]
    ?.iso;
  if (iso !== 'read committed') {
    throw new LockError(
      `mức cô lập ${clean(pyStr(iso), 24)} — cần read committed để kiểm nguồn khác sau khóa`,
    );
  }
  for (const b of lockBuckets(hashes)) {
    await c.query('select pg_advisory_xact_lock($1)', [String(lockKey(channel, b))]);
  }
}

// Nhóm (kênh, đơn, loại giao dịch) có dòng ở ≥2 file quyết toán. Số bộ giá trị khác nhau = 1 → trùng
// nguyên văn. Khung kỳ: nhóm có ÍT NHẤT 1 dòng `settled_on` trong [start, end) — start null = mọi kỳ.
export const OVERLAP_SQL =
  'select channel, count(distinct (settled_on, ' +
  COLS.map((c) => `${c}_vnd`).join(', ') +
  ')) as n_var, array_agg(distinct file_name) as files from settlement_rows where channel' +
  ' = any($1) group by channel, order_id_hash, txn_type having' +
  ' count(distinct file_sha256) >= 2 and ($2::date is null or' +
  ' bool_or(settled_on >= $2::date and settled_on < $3::date))' +
  ' order by 1';

export type Overlap = { trung: number; lech: number; files: string[] };

/**
 * `overlaps`: khoản quyết toán xuất lại ở ≥2 file → {kênh: {trung, lech, files}}; kênh không có →
 * vắng. CHỈ SELECT, không mã đơn/hash. `start`/`end` = 'YYYY-MM-DD' | null.
 */
export async function overlaps(
  c: Db,
  channels: readonly string[],
  start: string | null = null,
  end: string | null = null,
): Promise<Record<string, Overlap>> {
  const out: Record<string, Overlap> = {};
  const files: Record<string, Set<string>> = {};
  const r = await c.query(OVERLAP_SQL, [[...channels], start, end]);
  for (const row of r.rows as { channel: string; n_var: string; files: string[] }[]) {
    out[row.channel] ??= { trung: 0, lech: 0, files: [] };
    const o = out[row.channel] as Overlap;
    if (Number(row.n_var) <= 1) o.trung++;
    else o.lech++;
    files[row.channel] ??= new Set();
    for (const f of row.files) files[row.channel]?.add(f);
  }
  for (const [ch, o] of Object.entries(out)) o.files = pySorted(files[ch] ?? []);
  return out;
}

// Tổng đơn sàn theo (kênh, hash): snapshot `order` MỚI NHẤT có chứa hash.
export const ORDER_SQL =
  'with latest as (select distinct on (channel, order_id_hash) channel,' +
  ' order_id_hash, snapshot_id from market_rows where export_kind =' +
  " 'order' and order_id_hash = any($1) order by channel, order_id_hash," +
  ' snapshot_id desc) select l.channel, l.order_id_hash,' +
  ' sum(coalesce(m.price_vnd, 0) * coalesce(m.qty, 0)) as total from latest l' +
  ' join market_rows m on m.snapshot_id = l.snapshot_id and m.channel =' +
  ' l.channel and m.order_id_hash = l.order_id_hash and m.export_kind =' +
  " 'order' group by 1, 2";

const MONEY_SELECT = COLS.map((c) => `${c}_vnd`).join(', ');

/**
 * `reconcile`: đối chiếu (upsert `recon_results`, không commit) các dòng của file `sha` — null = MỌI
 * dòng. → {nhãn: số dòng}. finance-01 TẮT → RolloutBlocked (HĐ 6.7) TRƯỚC mọi ghi.
 */
export async function reconcile(
  c: Db,
  fees: Fees,
  sha: string | null = null,
): Promise<Record<Label, number>> {
  await checkGenerate(c, FEATURE_RECON, 'đối soát quyết toán');
  const sql = `select id, channel, order_id_hash, ${MONEY_SELECT} from settlement_rows`;
  const rows = (
    sha === null
      ? await c.query(`${sql} order by id`)
      : await c.query(`${sql} where file_sha256 = $1 order by id`, [sha])
  ).rows as Record<string, string>[];
  const counts = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
  if (!rows.length) return counts;
  const hashes = pySorted(new Set(rows.map((r) => r.order_id_hash as string)));
  const orders = new Map<string, bigint>();
  for (const o of (await c.query(ORDER_SQL, [hashes])).rows as Record<string, string>[]) {
    orders.set(`${o.channel}|${o.order_id_hash}`, BigInt(o.total as string));
  }
  const params: unknown[][] = [];
  for (const r of rows) {
    const rec = Object.fromEntries(
      COLS.map((col) => [col, BigInt(r[`${col}_vnd`] as string)]),
    ) as MoneyRow;
    const amt = orders.get(`${r.channel}|${r.order_id_hash}`) ?? null;
    const chFees = fees[r.channel as string];
    if (chFees === undefined) throw new RangeError(`biểu phí thiếu kênh ${r.channel}`);
    const [label, reasons, expected] = reconcileRow(rec, amt, chFees);
    counts[label]++;
    params.push([
      r.id,
      label,
      reasonsJson(reasons),
      String(expected),
      amt === null ? null : String(amt),
    ]);
  }
  for (let i = 0; i < params.length; i += CHUNK) {
    const flat: unknown[] = [];
    const vals = params.slice(i, i + CHUNK).map((p) => {
      const ph = p.map((v) => {
        flat.push(v);
        return `$${flat.length}`;
      });
      return `(${ph[0]}::bigint, ${ph[1]}, ${ph[2]}::jsonb, ${ph[3]}::bigint, ${ph[4]}::bigint)`;
    });
    await c.query(
      'insert into recon_results (settlement_row_id, label, reasons,' +
        ' expected_payout_vnd, order_amount_vnd) values ' +
        vals.join(', ') +
        ' on conflict (settlement_row_id) do update set label =' +
        ' excluded.label, reasons = excluded.reasons,' +
        ' expected_payout_vnd = excluded.expected_payout_vnd,' +
        ' order_amount_vnd = excluded.order_amount_vnd,' +
        ' reconciled_at = now()',
      flat,
    );
  }
  return counts;
}

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

/**
 * `report`: theo kênh — số dòng mỗi nhãn, tổng thực nhận file / tính lại / chênh, affiliate sàn khấu
 * trừ, đơn ở ≥2 file; liệt kê dòng lệch/thiếu/hoàn bằng `file dòng N` (không mã đơn/hash/người mua).
 * shortcut: chênh của từng lý do đọc từ jsonb (số JS) — lệch chữ số chỉ khi |số| > 2^53.
 */
export async function report(c: Db, io: Io = STD_IO): Promise<void> {
  io.out('[report] đối soát quyết toán sàn — CHỈ BÁO CÁO, không bút toán:');
  for (const ch of CHANNELS) {
    const by = new Map<string, string>();
    const labels = await c.query(
      'select r.label, count(*) as n from settlement_rows s join' +
        ' recon_results r on r.settlement_row_id = s.id where s.channel' +
        ' = $1 group by 1',
      [ch],
    );
    for (const r of labels.rows as { label: string; n: string }[]) by.set(r.label, r.n);
    // Tổng tiền đọc view 1 dòng/khoản (bản xuất lại tính 1 lần) — cùng số với rev_share/P&L/BKS; số
    // dòng theo nhãn vẫn là dòng thô.
    const t = (
      await c.query(
        'select count(*) as n_rows, coalesce(sum(s.payout_vnd), 0) as payout,' +
          ' coalesce(sum(r.expected_payout_vnd), 0) as expected,' +
          ' coalesce(sum(s.affiliate_vnd), 0) as aff, count(*) filter (where' +
          ' r.id is null) as n_unrec from v_settlement_khoan s left join' +
          ' recon_results r on r.settlement_row_id = s.id where s.channel' +
          ' = $1',
        [ch],
      )
    ).rows[0] as Record<string, string>;
    const nRows = Number(t.n_rows);
    if (!nRows) {
      io.out(`  ${ch}: chưa có file quyết toán`);
      continue;
    }
    const payout = BigInt(t.payout as string);
    const expected = BigInt(t.expected as string);
    const nUnrec = Number(t.n_unrec);
    const multi = (
      await c.query(
        'select count(*) as n from (select order_id_hash from settlement_rows' +
          ' where channel = $1 group by 1 having count(distinct' +
          ' file_sha256) >= 2) x',
        [ch],
      )
    ).rows[0]?.n;
    const nRaw = (
      await c.query('select count(*) as n from settlement_rows where channel = $1', [ch])
    ).rows[0]?.n;
    io.out(
      `  ${ch}: ${nRaw} dòng — ` +
        LABELS.map((lb) => `${lb}=${by.get(lb) ?? 0}`).join(', ') +
        (nUnrec ? `, CHƯA đối chiếu=${nUnrec}` : ''),
    );
    io.out(
      `    thực nhận theo file ${vnd(payout)}; tính lại ` +
        `${vnd(expected)}; chênh ${vnd(payout - expected)}; ` +
        `affiliate sàn khấu trừ ${vnd(BigInt(t.aff as string))}; đơn ở ≥2 file ` +
        `quyết toán: ${multi}`,
    );
    const ov = (await overlaps(c, [ch]))[ch] ?? { trung: 0, lech: 0, files: [] };
    io.out(
      `    khoản xuất lại ở ≥2 file: trùng ${ov.trung}, lệch ` +
        `${ov.lech} — tổng tiền tính ${nRows} khoản (trùng nguyên` +
        ' văn tính 1 lần; lệch giữ cả hai, chờ người đối soát)' +
        (ov.files.length
          ? `: ${ov.files
              .slice(0, 20)
              .map((f) => safe(f, 80))
              .join(', ')}`
          : ''),
    );
    const bad = (
      await c.query(
        'select s.file_name, s.row_no, r.label, r.reasons from' +
          ' settlement_rows s join recon_results r on r.settlement_row_id' +
          " = s.id where s.channel = $1 and r.label <> 'khop' order by" +
          ' r.label, s.file_name, s.row_no limit $2',
        [ch, MAX_REPORT_LINES + 1],
      )
    ).rows as { file_name: string; row_no: number; label: string; reasons: Reason[] }[];
    for (const b of bad.slice(0, MAX_REPORT_LINES)) {
      const why =
        b.reasons
          .map((x) => `${x.code} chênh ${vnd(Number(x.actual) - Number(x.expected))}`)
          .join('; ') || '-';
      io.out(`    [${b.label}] ${clean(b.file_name, 80)} dòng ${b.row_no}: ${why}`);
    }
    if (bad.length > MAX_REPORT_LINES) {
      io.out(`    ... còn nữa — chỉ in ${MAX_REPORT_LINES} dòng đầu`);
    }
  }
}

export { MAX_PRINT_ERRS } from '../intel_import/table.js';
