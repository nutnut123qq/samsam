import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { cpCmp } from '@samsam/core/ops/py-json';
import { cpLen } from '@samsam/core/security/py';
import { DATE_MIN, GOLDEN_FILE, readGolden, validateGolden } from '../garden_director/scenario.js';
import {
  bytesIsSpace,
  clean,
  MAX_FILE_BYTES,
  nfc,
  suffixOf,
  TableError,
  table,
  toInt,
} from '../market/table.js';

// Port `ingest/inventory_csv.py` (v9.2) — nạp tồn thành phẩm (SX-A3 đầu vào) từ file kho xuất tay
// CSV/XLSX. Agent CHỈ ĐỌC file, không sửa tồn, không chuyển kho. `readInventory` (thuần) kiểm TOÀN
// file TRƯỚC khi connect: đuôi .csv/.xlsx, header ĐÚNG tập `sku_key, kho, qty, captured_at`, sku_key
// có trong golden FILE, kho slug ascii (không chỗ cho tên/SĐT), qty nguyên ≥ 0, captured_at
// YYYY-MM-DD không ở tương lai, không trùng (sku, kho, ngày). Lỗi chỉ nêu số dòng/tên cột — KHÔNG in
// giá trị ô. Có lỗi → 0 dòng. Bảng `inventory_snapshots` append-only bằng code (không update/delete).
// Tồn hiện có = `currentStock`: mỗi (sku, kho) lấy snapshot ngày mới nhất (hòa → id lớn nhất), cộng
// qua kho; SKU bị BỎ khỏi file mới nhất của CHÍNH kho đó vẫn giữ số cũ (không đoán = 0) nhưng `stale`.

export const HEADER = ['sku_key', 'kho', 'qty', 'captured_at'] as const;
export const SOURCES = ['manual_export', 'sample'] as const;
export const QTY_MAX = 2 * 10 ** 9;
export const KHO_MAX_LEN = 64;
export const MAX_PRINT_ERRS = 30;
export const STALE_NOTE = 'số tồn cũ hơn file kho mới nhất — kiểm lại';

// golden_store._SLUG_RE. KHÁC Python có chủ đích: `$` của Python khớp cả trước '\n' cuối — ô đã strip
// nên không có ca đó ở đây; JSON (BOM) thì TS từ chối slug có '\n' cuối (chặt hơn, liệt kê trong test).
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** `_iso_date`: chỉ đúng dạng YYYY-MM-DD (chữ số ASCII — `date.fromisoformat` không nhận chữ số
 * Unicode). Ô ngày XLSX ('YYYY-MM-DD 00:00:00') cũng nhận. → 'YYYY-MM-DD' | null. */
export function isoDay(s: unknown): string | null {
  let v = s;
  if (typeof v === 'string' && v.endsWith(' 00:00:00')) v = v.slice(0, -9);
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  // Tự kiểm lịch Gregory: core `parseDay` dùng Date.UTC — năm 0..99 bị hiểu thành 1900+.
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1 && dim !== undefined && d >= 1 && d <= dim ? v : null;
}

export type InvRow = {
  row_no: number;
  sku_key: string;
  kho: string;
  qty: number;
  captured_at: string;
};
export type GoldenSku = Record<string, unknown> & { sku_key: string };
export type GoldenMap = Map<string, GoldenSku>;

/** Tên lớp OSError Python tương ứng mã lỗi Node. */
export function pyOsName(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  if (c === 'ENOENT') return 'FileNotFoundError';
  if (c === 'EACCES' || c === 'EPERM') return 'PermissionError';
  if (c === 'EISDIR') return 'IsADirectoryError';
  if (c === 'ENOTDIR') return 'NotADirectoryError';
  return 'OSError';
}

/** Hàm thuần (không DB) → [rows, errors, sha256]. errors ≠ [] → rows = [] (không nạp nửa vời). */
export async function readInventory(
  path: string,
  golden: GoldenMap,
  today: string,
): Promise<[InvRow[], string[], string | null]> {
  const suffix = suffixOf(path);
  if (suffix !== '.csv' && suffix !== '.xlsx') {
    return [[], [`đuôi '${clean(suffix, 10)}' không hỗ trợ — chỉ .csv / .xlsx`], null];
  }
  let data: Buffer;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return [[], ['file quá lớn — tách file'], null];
    data = readFileSync(path);
  } catch (e) {
    return [[], [`không đọc được file: ${pyOsName(e)}`], null];
  }
  const sha = createHash('sha256').update(data).digest('hex');
  if (!data.length || bytesIsSpace(data)) return [[], ['file rỗng'], sha];
  try {
    const [rows, errs] = parseTable(await table(data, suffix), golden, today);
    return [errs.length ? [] : rows, errs, sha];
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
}

function parseTable(
  it: Iterator<[number, (string | null)[]]>,
  golden: GoldenMap,
  today: string,
): [InvRow[], string[]] {
  const first = it.next();
  if (first.done) return [[], ['file rỗng']];
  const [hdrNo, hdr] = first.value;
  const errs: string[] = [];
  const norm = hdr.map((c) => (c ? nfc(c).toLowerCase() : ''));
  norm.forEach((h, i) => {
    if (!h) errs.push(`dòng ${hdrNo}: header cột thứ ${i + 1} trống`);
    else if (!(HEADER as readonly string[]).includes(h)) {
      // không in tên cột lạ (có thể là dữ liệu dán nhầm vào header)
      errs.push(`dòng ${hdrNo}: cột thứ ${i + 1} không thuộc tập ${HEADER.join(', ')}`);
    }
  });
  const dup = [...new Set(norm.filter((h) => h && norm.indexOf(h) !== norm.lastIndexOf(h)))].sort(
    cpCmp,
  );
  if (dup.length) errs.push(`dòng ${hdrNo}: header trùng ${dup.join(', ')}`);
  const missing = HEADER.filter((h) => !norm.includes(h));
  if (missing.length) errs.push(`dòng ${hdrNo}: thiếu cột ${missing.join(', ')}`);
  if (errs.length) return [[], errs];
  const idx = Object.fromEntries(HEADER.map((h) => [h, norm.indexOf(h)])) as Record<
    (typeof HEADER)[number],
    number
  >;
  const rows: InvRow[] = [];
  const seen = new Set<string>();
  for (let r = it.next(); !r.done; r = it.next()) {
    const [no, raw] = r.value;
    if (raw.length > HEADER.length) {
      errs.push(`dòng ${no}: có ô ngoài ${HEADER.length} cột`);
      continue;
    }
    const cells = [...raw, ...Array(HEADER.length - raw.length).fill(null)] as (string | null)[];
    const sku = cells[idx.sku_key] ?? null;
    const kho = cells[idx.kho] ?? null;
    const bad: string[] = [];
    if (sku === null || !golden.has(sku)) bad.push('sku_key (không có trong golden)');
    if (!kho || cpLen(kho) > KHO_MAX_LEN || !SLUG_RE.test(kho)) {
      bad.push('kho (phải là slug ascii a-z0-9-)');
    }
    const qty = toInt(cells[idx.qty], QTY_MAX);
    if (qty === null) bad.push(`qty (số nguyên 0..${QTY_MAX})`);
    const day = isoDay(cells[idx.captured_at]);
    if (day === null) bad.push('captured_at (YYYY-MM-DD)');
    else if (day < DATE_MIN || day > today) bad.push(`captured_at (trong ${DATE_MIN}..hôm nay)`);
    if (bad.length) {
      errs.push(`dòng ${no}: ${bad.join('; ')}`);
      continue;
    }
    const key = JSON.stringify([sku, kho, day]);
    if (seen.has(key)) {
      errs.push(`dòng ${no}: trùng (sku_key, kho, captured_at) với dòng trước`);
      continue;
    }
    seen.add(key);
    rows.push({
      row_no: no,
      sku_key: sku as string,
      kho: kho as string,
      qty: qty as number,
      captured_at: day as string,
    });
  }
  if (!rows.length && !errs.length) errs.push('file chỉ có header — 0 dòng tồn');
  return [rows, errs];
}

/** Golden đọc từ FILE (không connect) → [Map sku_key → sku, null] | [null, lý do]. */
export function goldenMap(path: string = GOLDEN_FILE): [GoldenMap | null, string | null] {
  const [doc, why] = readGolden(path);
  if (doc === null) return [null, why];
  const errs = validateGolden(doc);
  if (errs.length) return [null, `golden không hợp lệ (${errs.length} lỗi)`];
  const out: GoldenMap = new Map();
  for (const s of doc.skus as GoldenSku[]) out.set(s.sku_key, s);
  return [out, null];
}

// ---------- DB ----------

/** Insert append-only (caller lo giao dịch). */
export async function load(
  db: Db,
  rows: InvRow[],
  source: string,
  fileName: string,
  sha: string,
): Promise<number> {
  for (const r of rows) {
    await db.query(
      'insert into inventory_snapshots (sku_key, kho, qty, captured_at, source, file_name,' +
        ' file_sha256, row_no) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [r.sku_key, r.kho, r.qty, r.captured_at, source, fileName, sha, r.row_no],
    );
  }
  return rows.length;
}

export type KhoStock = { qty: number; captured_at: string; stale: boolean };
export type SkuStock = {
  qty: number;
  kho: Record<string, KhoStock>;
  stale: string[];
  sample: boolean;
};
export type Stock = Map<string, SkuStock>;

/**
 * → Map sku_key → {qty: tổng qua kho, kho: {kho: {qty, captured_at, stale}}, stale: [kho…], sample}.
 * `stale` = dòng KHÔNG thuộc FILE mới nhất của CÙNG kho (file kho mới bỏ sót SKU): (a) captured_at
 * cũ hơn ngày mới nhất của kho; (b) cùng ngày nhưng từ file nạp trước. Vẫn cộng qty cũ (không đoán
 * = 0) — caller PHẢI in `STALE_NOTE`. SKU không có dòng → không có key ("chưa có số tồn" ≠ 0).
 */
export async function currentStock(db: Db): Promise<Stock> {
  const { rows } = await db.query<{
    sku_key: string;
    kho: string;
    qty: number;
    day: string;
    source: string;
    stale: boolean;
  }>(
    'select distinct on (sku_key, kho) sku_key, kho, qty, captured_at::text as day, source,' +
      ' captured_at < max(captured_at) over w' +
      ' or file_sha256 <> first_value(file_sha256) over w as stale' +
      ' from inventory_snapshots' +
      ' window w as (partition by kho order by captured_at desc,' +
      ' id desc rows between unbounded preceding and unbounded following)' +
      ' order by sku_key, kho, captured_at desc, id desc',
  );
  const out: Stock = new Map();
  for (const r of rows) {
    let s = out.get(r.sku_key);
    if (!s) {
      s = { qty: 0, kho: {}, stale: [], sample: false };
      out.set(r.sku_key, s);
    }
    s.qty += r.qty;
    s.kho[r.kho] = { qty: r.qty, captured_at: r.day, stale: Boolean(r.stale) };
    if (r.stale) s.stale.push(r.kho);
    s.sample = s.sample || r.source === 'sample';
  }
  return out;
}

export const fileLabel = (path: string): string => clean(basename(path));
