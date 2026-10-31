import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay } from '@samsam/core/ops/period';
import { cpCmp, PyFloat, parsePyJson, pyFloatStr, pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyStrip } from '@samsam/core/security/py';
import {
  type Cell,
  MAX_FILE_BYTES,
  nfc,
  safe,
  suffixOf,
  type TableRow,
  table,
  toInt,
} from '../intel_import/table.js';

// Phần dùng chung của nhóm fin_ar_pnl: số/ngày/header của `ingest/settlement_csv.py` (đọc sổ công nợ,
// file yêu cầu hóa đơn), tiện ích FP&A của `agents/fp_pnl.py` ("dùng chung fp_ads/fp_opscost/fp_cash/
// fin_director") và số học Decimal ROUND_HALF_UP chính xác (BigInt — không float).
// shortcut: bản sao phần `settlement_csv`/`market_csv` mà nhóm này cần (nhóm settlement/market port
// song song) — bước tích hợp gom về một chỗ (core_requests).

export { type Cell, MAX_PRINT_ERRS, nfc, safe, type TableRow } from '../intel_import/table.js';
export { cpCmp };

export const CHANNELS = ['shopee', 'tiktok'] as const;
export const MONEY_CAP = 10 ** 15;
export const FPA_CONFIG_FILE = dataPath('fpa_config.json');

// ---------------------------------------------------------------- Decimal ROUND_HALF_UP (BigInt)

/** Python `Decimal`: giá trị = coef × 10^exp (giữ số mũ như Decimal để `str()` y hệt). */
export type Dec = { coef: bigint; exp: number };

const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** `Decimal(s)` cho chuỗi số thập phân/mũ (đầu vào từ `str(int|float)`). */
export function parseDec(s: string): Dec {
  const m = DEC_RE.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`không phải số: ${s}`);
  const frac = m[3] ?? '';
  let coef = BigInt(`${m[2] || '0'}${frac}`);
  if (m[1] === '-') coef = -coef;
  return { coef, exp: Number(m[4] ?? 0) - frac.length };
}

/** Python `Decimal(str(v))` cho số JSON (int → chữ số, float → repr Python). */
export const decOf = (v: number | PyFloat): Dec =>
  parseDec(v instanceof PyFloat ? pyFloatStr(v.v) : String(v));

/** Python `str(Decimal)` (to-sci-string). */
export function decStr(d: Dec): string {
  const sign = d.coef < 0n ? '-' : '';
  const digits = (d.coef < 0n ? -d.coef : d.coef).toString();
  const left = d.exp + digits.length;
  const dot = d.exp <= 0 && left > -6 ? left : 1;
  let s: string;
  if (dot <= 0) s = `0.${'0'.repeat(-dot)}${digits}`;
  else if (dot >= digits.length) s = digits + '0'.repeat(dot - digits.length);
  else s = `${digits.slice(0, dot)}.${digits.slice(dot)}`;
  return sign + s + (left === dot ? '' : `E${left - dot >= 0 ? '+' : ''}${left - dot}`);
}

/** So sánh Decimal (a < b → âm). */
export function decCmp(a: Dec, b: Dec): number {
  const e = Math.min(a.exp, b.exp);
  const x = a.coef * 10n ** BigInt(a.exp - e);
  const y = b.coef * 10n ** BigInt(b.exp - e);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** round(num/den) kiểu ROUND_HALF_UP (nửa → xa 0), den > 0. */
export function roundHalfUpFrac(num: bigint, den: bigint): bigint {
  const a = num < 0n ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return num < 0n ? -q : q;
}

/** `round_half_up(Decimal(n) * d)` → số nguyên. */
export function mulRound(n: bigint, d: Dec): bigint {
  const p = n * d.coef;
  return d.exp >= 0 ? p * 10n ** BigInt(d.exp) : roundHalfUpFrac(p, 10n ** BigInt(-d.exp));
}

// ---------------------------------------------------------------- số / ngày / chuỗi kiểu Python

/** `f"{int(n):,}".replace(",", ".") + "đ"` (fp_pnl.vnd = acc_ar._vnd = acc_invoice._vnd). */
export function vnd(n: number | bigint): string {
  const v = BigInt(n);
  const s = (v < 0n ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0n ? '-' : ''}${s}đ`;
}

/** `(a - b).days` cho ngày 'YYYY-MM-DD'. */
export function dayDiff(a: string, b: string): number {
  return Math.round(((parseDay(a) as number) - (parseDay(b) as number)) / 86_400_000);
}

/** strftime ngày: '%d/%m/%Y' | '%m/%Y' | '%Y-%m' từ 'YYYY-MM-DD'. */
export function fmtDay(day: string, f: '%d/%m/%Y' | '%m/%Y' | '%Y-%m' | '%d/%m'): string {
  const [y, m, d] = day.split('-');
  if (f === '%d/%m/%Y') return `${d}/${m}/${y}`;
  if (f === '%m/%Y') return `${m}/${y}`;
  if (f === '%d/%m') return `${d}/${m}`;
  return `${y}-${m}`;
}

/** `[start, end)` của tháng chứa `day` (Python `period_bounds("month", d)` → `.date()`). */
export function monthBounds(day: string): [string, string] {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const start = `${day.slice(0, 7)}-01`;
  const end =
    m === 12
      ? `${String(y + 1).padStart(4, '0')}-01-01`
      : `${day.slice(0, 4)}-${String(m + 1).padStart(2, '0')}-01`;
  return [start, end];
}

/** Python `json.dumps(str, ensure_ascii=False)` cho chuỗi (null → `null`). */
export const pyJsonStr = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s));

/** Python `str(x)` dùng trong `sorted(..., key=lambda kv: tuple(map(str, kv)))`. */
export const strNone = (v: string | null | undefined): string => (v == null ? 'None' : v);

export const sha256hex = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- settlement_csv (dùng chung)

/** `order_hash` — sha256("kênh:mã đơn")[:16] (PHẢI giống market_csv). */
export const orderHash = (channel: string, orderId: string): string =>
  sha256hex(Buffer.from(`${channel}:${orderId}`, 'utf8')).slice(0, 16);

/** `_to_signed`: số nguyên VND có `-` đầu tùy chọn; phần số theo `_to_int`. Sai → null. */
export function toSigned(s: string | null | undefined, cap: number = MONEY_CAP): number | null {
  if (s === null || s === undefined) return null;
  const t = pyStrip(s);
  const neg = t.startsWith('-');
  const n = toInt(neg ? t.slice(1) : t, cap);
  if (n === null) return null;
  return neg ? -n : n;
}

const YMD_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]00:00(?::00)?)?$/;
const DMY_RE = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;

function ymd(y: string, m: string, d: string): string | null {
  const s = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return parseDay(s) === null ? null : s;
}

/** `_to_date`: `YYYY-MM-DD` (ô XLSX datetime 00:00 cũng nhận) hoặc `DD/MM/YYYY` → 'YYYY-MM-DD'. */
export function toDate(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = pyStrip(s);
  let m = YMD_RE.exec(t);
  if (m) return ymd(m[1] as string, m[2] as string, m[3] as string);
  m = DMY_RE.exec(t);
  return m ? ymd(m[3] as string, m[2] as string, m[1] as string) : null;
}

/** `map_header`: header → ({field: chỉ số cột}, lỗi). Header lạ in qua `safe` (che SĐT/email). */
export function mapHeader(
  header: Cell[],
  required: Record<string, string>,
  optional: Record<string, string>,
  drop: string[],
  ctx: string,
): [Record<string, number>, string[]] {
  const hs = header.map((h) => (h === null ? null : nfc(h)));
  const want: Record<string, string> = {};
  for (const [f, h] of Object.entries(optional)) want[f] = nfc(h);
  for (const [f, h] of Object.entries(required)) want[f] = nfc(h);
  const byHeader = new Map<string, string>();
  for (const [f, h] of Object.entries(want)) byHeader.set(h, f);
  const dropSet = new Set(drop.map(nfc));
  const colOf: Record<string, number> = {};
  const errs: string[] = [];
  const seen = new Set<string>();
  hs.forEach((h, j) => {
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
        `cột lạ '${safe(h)}' (không thuộc required/optional/drop — thêm vào mapping sau khi xác minh)`,
      );
    }
  });
  const missing = Object.entries(required)
    .filter(([f]) => !Object.hasOwn(colOf, f))
    .map(([, h]) => h);
  const nReq = Object.keys(required).length;
  if (missing.length && missing.length === nReq) {
    // dòng đầu nhiều khả năng là DỮ LIỆU — không in ô (có thể là PII)
    return [
      {},
      [
        `dòng đầu không khớp header ${ctx} (${hs.length} cột, 0/${nReq} cột bắt buộc) — sai kênh/loại file hoặc thiếu dòng header`,
      ],
    ];
  }
  if (missing.length)
    errs.push(`thiếu cột bắt buộc: ${missing.map((h) => `'${nfc(h)}'`).join(', ')}`);
  return [colOf, errs];
}

/** File đã đọc (đuôi/trần byte/rỗng đã kiểm) — mở bảng bằng `openTable` TRONG khối bắt TableError. */
export type TableSrc = { data: Buffer; suffix: string; name: string };

/** `read_table` → [nguồn | null, sha | null, lỗi | null]. */
export function readTable(path: string): [TableSrc | null, string | null, string | null] {
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
  const sha = sha256hex(data);
  // bytes.isspace(): chỉ khoảng trắng ASCII
  if (!data.length || data.every((b) => b === 0x20 || (b >= 0x09 && b <= 0x0d))) {
    return [null, sha, 'file rỗng'];
  }
  return [{ data, suffix, name: basename(path) }, sha, null];
}

/** Iterator dòng (số dòng file, ô) — lỗi cấu trúc → TableError (có thể ném khi mở hoặc khi duyệt). */
export const openTable = (src: TableSrc): Promise<Iterator<TableRow>> =>
  table(src.data, src.suffix);

/** `next(it, None)`. */
export function nextRow(it: Iterator<TableRow>): TableRow | null {
  const r = it.next();
  return r.done ? null : r.value;
}

/** Ô của dòng theo cột header (thiếu → null) + có ô ngoài header không. */
export function rowRecord(
  cells: Cell[],
  width: number,
  colOf: Record<string, number>,
): [Record<string, Cell>, boolean] {
  const extra = cells.slice(width).some((c) => c !== null);
  const rec: Record<string, Cell> = {};
  for (const [f, j] of Object.entries(colOf)) rec[f] = j < cells.length ? (cells[j] ?? null) : null;
  return [rec, extra];
}

const MONEY_COLS = [
  'order_amount',
  'fixed_fee',
  'payment_fee',
  'service_fee',
  'shipping_fee',
  'voucher_seller',
  'affiliate',
  'refund',
  'payout',
];

export type Overlap = { trung: number; lech: number; files: string[] };

/**
 * `settlement_csv.overlaps`: khoản quyết toán xuất lại ở ≥2 file → {kênh: {trung, lech, files}}.
 * CHỈ SELECT, không mã đơn/hash. Khung kỳ: nhóm có ≥1 dòng `settled_on` trong [start, end).
 */
export async function overlaps(
  db: Db,
  channels: readonly string[],
  start: string | null = null,
  end: string | null = null,
): Promise<Record<string, Overlap>> {
  const { rows } = await db.query<{ channel: string; n_var: number; files: string[] }>(
    `select channel, count(distinct (settled_on, ${MONEY_COLS.map((c) => `${c}_vnd`).join(', ')}))::int as n_var,` +
      ' array_agg(distinct file_name) as files from settlement_rows where channel = any($1)' +
      ' group by channel, order_id_hash, txn_type having count(distinct file_sha256) >= 2 and' +
      ' ($2::date is null or bool_or(settled_on >= $2::date and settled_on < $3::date)) order by 1',
    [[...channels], start, end],
  );
  const out: Record<string, { trung: number; lech: number; files: Set<string> }> = {};
  for (const r of rows) {
    out[r.channel] ??= { trung: 0, lech: 0, files: new Set() };
    const o = out[r.channel] as { trung: number; lech: number; files: Set<string> };
    if (r.n_var <= 1) o.trung += 1;
    else o.lech += 1;
    for (const f of r.files) o.files.add(f);
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, o]) => [
      k,
      { trung: o.trung, lech: o.lech, files: [...o.files].sort(cpCmp) },
    ]),
  );
}

// ---------------------------------------------------------------- FP&A dùng chung (fp_pnl)

/** `parse_month`: 'YYYY-MM' → 'YYYY-MM-01'; sai → null (CLI → exit 2). TS chặt hơn: năm 0000 →
 * null (Python `date(0, …)` ném ValueError → traceback). */
export function parseMonth(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Python `json.loads(p.read_bytes().decode("utf-8"))` (số thực giữ `PyFloat`); lỗi → tên lỗi Python. */
export class PyJsonError extends Error {
  constructor(readonly pyType: string) {
    super(pyType);
  }
}

export function loadPyJson(path: string): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new PyJsonError(pyOsName(e));
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new PyJsonError('UnicodeDecodeError');
  }
  try {
    return parsePyJson(text);
  } catch {
    throw new PyJsonError('JSONDecodeError');
  }
}

/** Python `isinstance(v, dict)`. */
export const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);

/** `read_config(section, path)`: 1 mục của `data/fpa_config.json` → [dict, null] | [null, lý do]. */
export function readConfig(
  section: string,
  path: string = FPA_CONFIG_FILE,
): [Record<string, unknown> | null, string | null] {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = loadPyJson(path);
  } catch (e) {
    return [null, `không đọc được ${name}: ${(e as PyJsonError).pyType}`];
  }
  const sec = isDict(raw) ? raw[section] : undefined;
  if (!isDict(sec)) return [null, `${name}: thiếu mục '${section}'`];
  return [sec, null];
}

/** `frac`: số 0..1 (không bool) → Decimal. */
export function frac(v: unknown, where: string): [Dec | null, string | null] {
  if (!(typeof v === 'number' || v instanceof PyFloat)) return [null, `${where}: phải là số 0..1`];
  const d = decOf(v);
  if (decCmp(d, { coef: 0n, exp: 0 }) < 0 || decCmp(d, { coef: 1n, exp: 0 }) > 0) {
    return [null, `${where}: ngoài 0..1`];
  }
  return [d, null];
}

/** `is_int(v, lo, hi)` — int JSON thật (không bool, không float). */
export const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && lo <= v && v <= hi;

// ---------------------------------------------------------------- kết nối CLI

export type DbLease = { db: Db; release: () => Promise<void> };

/** Ngày hôm sau ('YYYY-MM-DD'). */
export const nextDay = (d: string): string => addDays(d, 1);
