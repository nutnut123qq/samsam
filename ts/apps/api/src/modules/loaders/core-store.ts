import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pyStrip } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { isPlainObject } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { DATA_DIR as REPO_DATA_DIR } from '@samsam/core/paths';
import { pyRepr, pyTruthy, re, S, search } from '@samsam/core/security/py';
import type pg from 'pg';
import { pgTsToIso, pyType } from './py.js';

// Port `ingest/core_store.py` (WS1 — nạp DB lõi từ `data/` vào Postgres). Luật giữ nguyên:
//   - Idempotent 2 pha: xóa `where source = <file nguồn>` (con trước cha sau) rồi ghi (cha trước) →
//     chạy n lần không nhân đôi, KHÔNG đè row nhập tay (`source` khác, vd 'manual').
//   - File nguồn thiếu HOẶC 0 record → domain đó KHÔNG trả ra (không xóa trắng bảng đang có —
//     `claims_approved` là nguồn sự thật guardrail).
//   - v15.5 (HĐ 7.3): `products` KHÔNG delete-by-source — upsert theo id (chỉ đè dòng cùng `source`),
//     sản phẩm vắng khỏi nguồn → GIỮ + `retired_at`, xuất hiện lại → bỏ `retired_at`; id thuộc NGUỒN
//     KHÁC → không đè. Mọi sự kiện ghi `product_sync_log` (append-only). Loader không DELETE products.
//     `products.jsonl` thiếu / 0 record / hỏng và MỌI file nguồn hỏng → SourceError (không ghi gì).
//   - v9.3: `plots` không delete mù — khoảnh còn nhật ký ĐÃ CHAIN hoặc còn ảnh được GIỮ + upsert tại
//     chỗ; khoảnh trùng id khác `source` không bị đè. Sau `garden_sample_purge` bỏ hẳn domain mẫu vườn.
//   - Dòng `{"_doc": ...}` trong jsonl là comment. `sample_*.jsonl` nạp với source `sample:*`.
//   - `orders` KHÔNG lưu PII khách (chỉ lấy cột trong COLS).
// KHÁC Python có chủ đích (TS chặt hơn — Python cũng hỏng nhưng muộn hơn, lúc ghi DB/traceback):
// file không phải UTF-8, NaN/Infinity, `images`/`approved_claims` là chuỗi/object (Python lặp từng ký
// tự/khóa), `url` là list/object, giá trị object/list ở cột, chuỗi có NUL/surrogate lẻ, số nguyên
// vượt 2^53 → SourceError trước khi kết nối DB.

export const DATA_DIR = REPO_DATA_DIR;

export const COLS = {
  products: ['id', 'name', 'price_vnd', 'description', 'url', 'lang', 'source'],
  claims_approved: ['sku_key', 'product_id', 'claim', 'source_ref', 'note', 'source'],
  plots: ['id', 'location', 'area_m2', 'variety', 'tree_count', 'planted_year', 'status', 'source'],
  plot_logs: ['plot_id', 'ts', 'activity', 'detail', 'author', 'source'],
  orders: ['id', 'ts', 'channel', 'product_id', 'qty', 'total_vnd', 'status', 'note', 'source'],
  assets: ['id', 'kind', 'title', 'url', 'product_id', 'source'],
} as const;
export type Table = keyof typeof COLS;

/** Thứ tự ghi: cha trước con sau (FK). Xóa duyệt ngược lại. */
export const DOMAIN_ORDER: Table[] = [
  'products',
  'claims_approved',
  'plots',
  'plot_logs',
  'orders',
  'assets',
];

export type Row = Record<string, unknown>;
export type Domain = [table: Table, source: string, rows: Row[]];
export type ProductEvent = [kind: string, productId: string, detail: Record<string, unknown>];
export type Counts = Partial<Record<Table, number>> & { product_events?: ProductEvent[] };

// Python `https?://\S+` (`\S` Unicode).
const URL_RE = re(`https?://[^${S}]+`);

const ph = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');

// v9.3 — "khoảnh bị giữ": còn nhật ký đã chain hoặc còn ảnh.
const PLOT_PINNED =
  'exists (select 1 from plot_logs l where l.plot_id = p.id and l.row_hash is not null) or' +
  ' exists (select 1 from garden_media m where m.plot_id = p.id)';
export const PLOTS_DELETE_SQL = `delete from plots p where source = $1 and not (${PLOT_PINNED})`;
// Khoảnh còn giữ (cùng source) → cập nhật tại chỗ; trùng id khác source (vd 'manual') → không đè.
export const PLOTS_UPSERT_SUFFIX = ` on conflict (id) do update set ${COLS.plots
  .filter((c) => c !== 'id' && c !== 'source')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ')}, updated_at = now() where plots.source = excluded.source`;

// v15.5 — products upsert theo id: chỉ đè dòng CÙNG source, chỉ ghi khi dữ liệu đổi hoặc đang
// `retired_at` (nạp lại y nguyên = 0 UPDATE).
const PRODUCT_FIELDS = COLS.products.filter((c) => c !== 'id' && c !== 'source');
export const PRODUCTS_UPSERT_SQL =
  `insert into products (${COLS.products.join(', ')}) values (${ph(COLS.products.length)})` +
  ` on conflict (id) do update set ${PRODUCT_FIELDS.map((c) => `${c} = excluded.${c}`).join(', ')}` +
  ', retired_at = null, updated_at = now() where products.source = excluded.source and (' +
  `${PRODUCT_FIELDS.map((c) => `products.${c}`).join(', ')}, products.retired_at) is distinct from (` +
  `${PRODUCT_FIELDS.map((c) => `excluded.${c}`).join(', ')}, null)`;
// Sản phẩm của nguồn không còn trong file → đánh dấu, KHÔNG xóa; đếm đơn thật đang trỏ tới để báo.
export const PRODUCTS_RETIRE_SQL =
  'update products p set retired_at = now(), updated_at = now()' +
  ' where p.source = $1 and p.retired_at is null and p.id <> all($2)' +
  ' returning p.id, p.name, p.url, (select count(*) from orders o' +
  " where o.product_id = p.id and o.source <> 'sample'" +
  " and o.source not like 'sample:%')";
const SYNC_LOG_SQL =
  'insert into product_sync_log (kind, product_id, source, detail)' +
  " select $1::text, $2::text, $3::text, $4::jsonb where $1::text <> 'ambiguous'" +
  ' or not exists (select 1 from product_sync_log l where l.kind = $1::text' +
  ' and l.product_id = $2::text and l.source = $3::text and l.detail = $4::jsonb)';

/** File nguồn hỏng (JSON lỗi, record thiếu khóa, trùng id...) — main exit 1 TRƯỚC khi kết nối DB,
 * không ghi gì. Python ValueError → RangeError. */
export class SourceError extends RangeError {
  override name = 'SourceError';
}
/** Python KeyError (str = repr(khóa)). */
export class KeyErr extends Error {
  constructor(key: string) {
    super(pyRepr(key));
  }
}
/** Python TypeError / AttributeError khi map record. */
export class PyTypeErr extends Error {}

type Rec = Record<string, unknown>;
const get = (rec: Rec, k: string, dflt: unknown = null): unknown =>
  Object.hasOwn(rec, k) ? rec[k] : dflt;
function req(rec: Rec, k: string): unknown {
  if (!Object.hasOwn(rec, k)) throw new KeyErr(k);
  return rec[k];
}

function decodeUtf8(path: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new SourceError(`${basename(path)}: không đọc được (${(e as { code?: string }).code})`);
  }
  try {
    // BOM giữ nguyên (Python encoding="utf-8" không bỏ BOM → JSON hỏng).
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new SourceError(`${basename(path)}: không phải UTF-8 — file hỏng`);
  }
}

/**
 * Record dict từ file jsonl; bỏ dòng `{"_doc": ...}` (comment theo convention repo) và dòng trống.
 * Dòng không phải JSON object → SourceError (file hỏng, không nạp nửa vời). Dòng theo universal
 * newlines của Python (`\r\n`, `\r`, `\n`), strip kiểu Python.
 */
export function iterJsonl(path: string): Rec[] {
  const name = basename(path);
  const out: Rec[] = [];
  decodeUtf8(path)
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      const line = pyStrip(raw);
      if (!line) return;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        throw new SourceError(`${name}:${i + 1} JSON hỏng (${(e as Error).message})`);
      }
      if (!isPlainObject(rec)) throw new SourceError(`${name}:${i + 1} không phải JSON object`);
      if (Object.hasOwn(rec, '_doc')) return;
      out.push(rec);
    });
  return out;
}

/** ngoclinh.com EN có /en/ trong permalink; còn lại tiếng Việt. */
export function langOf(url: unknown): string {
  if (typeof url === 'string') return url.includes('/en/') ? 'en' : 'vi';
  if (url === null || typeof url !== 'object') {
    throw new PyTypeErr(`argument of type '${pyType(url)}' is not iterable`);
  }
  throw new PyTypeErr(`url là ${pyType(url)} — phải là chuỗi`); // TS chặt hơn
}

/** Segment path cuối bỏ '.html' — 'a/b/saphraton-48.html' → 'saphraton-48'. */
export function urlSegment(url: string): string {
  const s = url.replace(/\/+$/, '');
  const seg = s.slice(s.lastIndexOf('/') + 1);
  return seg.endsWith('.html') ? seg.slice(0, -5) : seg;
}

const isHtml = (url: string) => url.replace(/\/+$/, '').endsWith('.html');

export function productRow(rec: Rec): Row {
  return {
    id: req(rec, 'id'),
    name: req(rec, 'name'),
    price_vnd: get(rec, 'price_vnd'),
    description: get(rec, 'description'),
    url: get(rec, 'url'),
    lang: langOf(get(rec, 'url', '')),
    source: 'products.jsonl',
  };
}

/** Python `for x in v` trên giá trị truthy không phải list: số/bool → TypeError như Python; chuỗi/
 * object (Python lặp từng ký tự/khóa) → TS chặt hơn. */
function listOrFail(v: unknown, what: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'number' || typeof v === 'boolean') {
    throw new PyTypeErr(`'${pyType(v)}' object is not iterable`);
  }
  throw new PyTypeErr(`${what} là ${pyType(v)} — phải là list`);
}

/** Mỗi ảnh trong products.images[] → 1 asset '<product_id>#img<i>'. */
export function imageAssetRows(rec: Rec): Row[] {
  const imgs = get(rec, 'images');
  if (!pyTruthy(imgs)) return [];
  return listOrFail(imgs, 'images').map((img, i) => {
    const id = req(rec, 'id');
    return {
      id: `${String(id)}#img${i}`,
      kind: 'image',
      title: get(rec, 'name'),
      url: img,
      product_id: id,
      source: 'products.jsonl',
    };
  });
}

/** Bài báo/cẩm nang = tài sản truyền thông (SOW P0). */
export function articleAssetRow(rec: Rec, source: string): Row {
  return {
    id: req(rec, 'id'),
    kind: 'article',
    title: get(rec, 'title'),
    url: get(rec, 'url'),
    product_id: null,
    source,
  };
}

/**
 * 1 SKU trong claims_whitelist → n rows (mỗi approved_claim 1 row). SKU `approved_claims` rỗng →
 * 1 row claim=null + note 'chưa có công bố' để audit coverage. `product_id` link best-effort qua
 * segment URL cuối trong `source` (khớp products.url của net.vn shop).
 */
export function claimRows(skuKey: string, entry: unknown, segToPid: Map<string, string>): Row[] {
  if (!isPlainObject(entry))
    throw new PyTypeErr(`'${pyType(entry)}' object has no attribute 'get'`);
  const src = get(entry, 'source');
  const text = pyTruthy(src) ? src : '';
  if (typeof text !== 'string') {
    throw new PyTypeErr(`expected string or bytes-like object, got '${pyType(text)}'`);
  }
  const m = search(URL_RE, text);
  const productId = m ? (segToPid.get(urlSegment(m[0])) ?? null) : null;
  const base = {
    sku_key: skuKey,
    product_id: productId,
    source_ref: src,
    source: 'claims_whitelist.json',
  };
  const claims = get(entry, 'approved_claims');
  if (!pyTruthy(claims))
    return [{ ...base, claim: null, note: 'Chưa có công bố — không suy diễn' }];
  return listOrFail(claims, 'approved_claims').map((c) => ({ ...base, claim: c, note: null }));
}

export function plotRow(rec: Rec, source: string): Row {
  return {
    id: req(rec, 'id'),
    location: get(rec, 'location'),
    area_m2: get(rec, 'area_m2'),
    variety: get(rec, 'variety'),
    tree_count: get(rec, 'tree_count'),
    planted_year: get(rec, 'planted_year'),
    status: get(rec, 'status', 'active'),
    source,
  };
}

export function plotLogRow(rec: Rec, source: string): Row {
  return {
    plot_id: req(rec, 'plot_id'),
    ts: req(rec, 'ts'),
    activity: req(rec, 'activity'),
    detail: get(rec, 'detail'),
    author: get(rec, 'author'),
    source,
  };
}

/** orders không lưu PII khách — field khách trong record mẫu bị rớt (chỉ lấy cột trong COLS). */
export function orderRow(rec: Rec, source: string): Row {
  return {
    id: req(rec, 'id'),
    ts: req(rec, 'ts'),
    channel: req(rec, 'channel'),
    product_id: get(rec, 'product_id'),
    qty: get(rec, 'qty'),
    total_vnd: get(rec, 'total_vnd'),
    status: get(rec, 'status', 'new'),
    note: get(rec, 'note'),
    source,
  };
}

/** Surrogate lẻ (cờ `u`: cặp hợp lệ là 1 code point, không thuộc Cs). */
export const LONE_SURROGATE = /\p{Cs}/u;

/** TS chặt hơn: giá trị cột phải vô hướng ghi được nguyên vẹn (node-pg ghi object thành JSON, thay
 * surrogate lẻ bằng U+FFFD, làm tròn số > 2^53 — Python thì lỗi/ghi đúng) → lý do | null. */
function badValue(row: Row): string | null {
  for (const [col, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'object') return `cột ${col} là ${pyType(v)}`;
    if (typeof v === 'string' && (LONE_SURROGATE.test(v) || v.includes('\0'))) {
      return `cột ${col} có NUL/surrogate lẻ`;
    }
    if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
      return `cột ${col} số nguyên vượt 2^53`;
    }
  }
  return null;
}

/** Map record jsonl → row(s); record thiếu khóa bắt buộc (vd dòng `{}`) → SourceError thay vì lỗi
 * giữa chừng. */
function mapRows(path: string, fn: (rec: Rec) => Row | Row[]): Row[] {
  const name = basename(path);
  const out: Row[] = [];
  for (const rec of iterJsonl(path)) {
    let got: Row | Row[];
    try {
      got = fn(rec);
    } catch (e) {
      if (e instanceof KeyErr || e instanceof PyTypeErr) {
        throw new SourceError(`${name}: record thiếu/sai khóa ${e.message} — file hỏng`);
      }
      throw e;
    }
    for (const r of Array.isArray(got) ? got : [got]) {
      const why = badValue(r);
      if (why) throw new SourceError(`${name}: record sai kiểu (${why}) — file hỏng`);
      out.push(r);
    }
  }
  return out;
}

/** products.jsonl → rows; `id`/`name` rỗng hoặc trùng `id` → file hỏng (trùng id = ánh xạ không
 * rõ dòng nào đúng — không tự chọn). */
export function productRows(path: string): Row[] {
  const name = basename(path);
  const rows = mapRows(path, productRow);
  const seen = new Set<string>();
  for (const r of rows) {
    const ok = (v: unknown) => typeof v === 'string' && pyStrip(v) !== '';
    if (!(ok(r.id) && ok(r.name)))
      throw new SourceError(`${name}: record thiếu id/name — file hỏng`);
    const id = r.id as string;
    if (seen.has(id)) {
      throw new SourceError(`${name}: trùng id ${pyRepr(id)} — ánh xạ không rõ, file hỏng`);
    }
    seen.add(id);
  }
  return rows;
}

function whitelistRows(path: string, seg: Map<string, string>): Row[] {
  const name = basename(path);
  const fail = (msg: string) => new SourceError(`${name} hỏng (${msg})`);
  let wl: unknown;
  try {
    wl = JSON.parse(decodeUtf8(path));
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw fail((e as Error).message);
  }
  if (!isPlainObject(wl)) throw fail(`'${pyType(wl)}' object has no attribute 'items'`);
  // shortcut: khóa dạng số nguyên ("123") JS duyệt trước khóa khác (Python giữ thứ tự file) — chỉ
  // đổi thứ tự ghi claim, không đổi nội dung; sku_key thật là slug chữ.
  const out: Row[] = [];
  for (const [key, entry] of Object.entries(wl)) {
    if (key.startsWith('_')) continue;
    let rows: Row[];
    try {
      rows = claimRows(key, entry, seg);
    } catch (e) {
      if (e instanceof PyTypeErr) throw fail(e.message);
      throw e;
    }
    for (const r of rows) {
      const why = badValue(r);
      if (why) throw fail(`sai kiểu: ${why}`);
      out.push(r);
    }
  }
  return out;
}

const ROW_FN: Record<'plots' | 'plot_logs' | 'orders', (rec: Rec, src: string) => Row> = {
  plots: plotRow,
  plot_logs: plotLogRow,
  orders: orderRow,
};

/**
 * Đọc data dir → [(table, source, rows)] theo DOMAIN_ORDER (cha trước). File thiếu HOẶC 0 record
 * → domain bị bỏ (warn), KHÔNG xóa rows đang có. Ngoại lệ v15.5: `products.jsonl` thiếu/0 record và
 * file hỏng (bất kỳ) → SourceError (caller không ghi gì). `log` = print của Python.
 */
export function collectRows(
  dataDir: string = DATA_DIR,
  log: (s: string) => void = console.log,
): Domain[] {
  const domains: Domain[] = [];
  const products = join(dataDir, 'products.jsonl');
  const seg = new Map<string, string>();
  // v15.5: products.jsonl thiếu / 0 record → không nạp domain nào (claim map sản phẩm qua file này
  // — nạp claim khi thiếu nó = cắt `claims_approved.product_id` hàng loạt).
  if (!existsSync(products)) throw new SourceError('thiếu products.jsonl');
  const prodRows = productRows(products);
  if (!prodRows.length) throw new SourceError('products.jsonl 0 record (rỗng/chỉ _doc)');
  for (const r of prodRows) {
    // Chỉ map URL kiểu net.vn '<slug>.html' — whitelist.source trỏ trang net.vn; url wc (không
    // .html) cùng slug sẽ chen nhầm.
    const url = typeof r.url === 'string' ? r.url : '';
    if (isHtml(url)) seg.set(urlSegment(url), r.id as string);
  }
  domains.push(['products', 'products.jsonl', prodRows]);

  const wlPath = join(dataDir, 'claims_whitelist.json');
  if (existsSync(wlPath)) {
    const claims = whitelistRows(wlPath, seg);
    if (claims.length) domains.push(['claims_approved', 'claims_whitelist.json', claims]);
    else log(`[warn] ${wlPath} 0 SKU/claim — bỏ qua như file thiếu`);
  } else {
    log(`[warn] thiếu ${wlPath} — bỏ qua`);
  }

  for (const [table, fname] of [
    ['plots', 'sample_plots.jsonl'],
    ['plot_logs', 'sample_plot_logs.jsonl'],
    ['orders', 'sample_orders.jsonl'],
  ] as const) {
    const path = join(dataDir, fname);
    const src = `sample:${fname}`;
    if (existsSync(path)) {
      const rows = mapRows(path, (rec) => ROW_FN[table](rec, src));
      if (rows.length) domains.push([table, src, rows]);
      else log(`[warn] ${path} 0 record — bỏ qua như file thiếu`);
    } else {
      log(`[warn] thiếu ${path} — bỏ qua domain ${table}`);
    }
  }

  const assets = mapRows(products, imageAssetRows);
  for (const fname of ['articles.jsonl', 'news.jsonl']) {
    const path = join(dataDir, fname);
    if (existsSync(path)) assets.push(...mapRows(path, (rec) => articleAssetRow(rec, fname)));
    else log(`[warn] thiếu ${path} — bỏ qua`);
  }
  // Không file nào đóng góp → bỏ luôn domain (đừng delete-noop).
  if (assets.length) domains.push(['assets', 'multi', assets]);
  return domains;
}

// ---------------------------------------------------------------- DB

/** int8 (node-pg trả chuỗi) → number. */
const int8 = (v: unknown): unknown => (typeof v === 'string' ? Number(v) : v);

/** Python `a == b` cho giá trị vô hướng (1 == 1.0 == True). */
function pyEq(a: unknown, b: unknown): boolean {
  const num = (x: unknown) => typeof x === 'number' || typeof x === 'boolean';
  return num(a) && num(b) ? Number(a) === Number(b) : a === b;
}

/**
 * v15.5 — đồng bộ `products` của nguồn `src` GIỮ định danh: upsert theo id (không DELETE → FK
 * `on delete set null` không cắt đơn thật), sản phẩm vắng khỏi nguồn → `retired_at`. Trả các sự
 * kiện đã ghi `product_sync_log` (append-only):
 *   changed     — cùng id, đổi trường (giá trị cũ/mới; mô tả chỉ báo đổi)
 *   retired     — vừa biến mất khỏi nguồn (số đơn thật đang trỏ + id mới trùng url/tên làm ỨNG
 *                 VIÊN — KHÔNG tự chuyển liên kết)
 *   reactivated — đang retired, xuất hiện lại
 *   ambiguous   — id trong nguồn đã thuộc NGUỒN KHÁC (vd 'manual') → không đè, không xóa (ghi 1 lần
 *                 cho cùng tình trạng).
 */
export async function syncProducts(db: Db, src: string, rows: Row[]): Promise<ProductEvent[]> {
  const ids = rows.map((r) => r.id as string);
  const existing = new Map<string, Row>();
  for (const r of (
    await db.query(
      `select id, source, retired_at::text as retired_at, ${PRODUCT_FIELDS.join(', ')} from products where id = any($1)`,
      [ids],
    )
  ).rows) {
    existing.set(r.id, r);
  }
  const events: ProductEvent[] = [];
  const upsert: Row[] = [];
  for (const r of rows) {
    const id = r.id as string;
    const old = existing.get(id);
    if (!old) {
      upsert.push(r);
      continue;
    }
    if (old.source !== src) {
      events.push(['ambiguous', id, { ly_do: 'id_thuoc_nguon_khac', nguon_hien_tai: old.source }]);
      continue;
    }
    const diff: Record<string, unknown> = {};
    for (const c of PRODUCT_FIELDS) {
      const v = c === 'price_vnd' ? int8(old[c]) : old[c];
      if (!pyEq(v, r[c])) diff[c] = c === 'description' ? { doi: true } : { cu: v, moi: r[c] };
    }
    if (Object.keys(diff).length) events.push(['changed', id, diff]);
    if (old.retired_at !== null) {
      events.push(['reactivated', id, { retired_at: pgTsToIso(old.retired_at as string) }]);
    }
    upsert.push(r);
  }
  for (const r of upsert) {
    await db.query(
      PRODUCTS_UPSERT_SQL,
      COLS.products.map((c) => r[c] ?? null),
    );
  }
  for (const x of (await db.query(PRODUCTS_RETIRE_SQL, [src, ids])).rows) {
    const cands = rows
      .filter(
        (r) => !existing.has(r.id as string) && ((x.url && r.url === x.url) || r.name === x.name),
      )
      .map((r) => r.id as string)
      .sort(cpCmp);
    events.push(['retired', x.id, { don_that: Number(x.count), ung_vien_thay_the: cands }]);
  }
  for (const [kind, pid, detail] of events) {
    await db.query(SYNC_LOG_SQL, [kind, pid, src, JSON.stringify(detail)]);
  }
  return events;
}

/** Claim trỏ trang sản phẩm đã `retired` (vắng khỏi file hiện tại nên `collectRows` không map
 * được) → giữ link về id cũ thay vì null. */
export async function relinkRetiredClaims(db: Db, src: string, rows: Row[]): Promise<void> {
  const seg = new Map<string, string>();
  for (const r of (
    await db.query(
      'select id, url from products where source = $1 and retired_at is not null and url is not null',
      [src],
    )
  ).rows) {
    if (isHtml(r.url)) seg.set(urlSegment(r.url), r.id);
  }
  for (const r of rows) {
    const m = search(URL_RE, typeof r.source_ref === 'string' ? r.source_ref : '');
    if (r.product_id === null && m) r.product_id = seg.get(urlSegment(m[0])) ?? null;
  }
}

/**
 * 2 pha: delete by-source bảng CON (con trước cha sau) → ghi (cha trước). `products` KHÔNG xóa —
 * `syncProducts` upsert + retired (v15.5); sự kiện ở `counts.product_events`. Domain source 'multi'
 * (assets gom nhiều file) xóa theo tập source thành phần. `db` = client trong giao dịch của caller.
 */
export async function applyRows(db: Db, domains: Domain[]): Promise<Counts> {
  const byTable = new Map<Table, [string, Row[]]>();
  for (const [t, src, rows] of domains) byTable.set(t, [src, rows]);
  // Pha 1 — delete con → cha (trừ products)
  for (const table of [...DOMAIN_ORDER].reverse()) {
    const d = byTable.get(table);
    if (!d || table === 'products') continue;
    const [src, rows] = d;
    if (src === 'multi') {
      const sources = [...new Set(rows.map((r) => r.source as string))].sort(cpCmp);
      await db.query(`delete from ${table} where source = any($1)`, [sources]);
    } else if (table === 'plots') {
      // Khoảnh còn nhật ký đã chain (trigger chặn cascade) hoặc còn ảnh (FK no action) → giữ,
      // pha 2 upsert tại chỗ.
      await db.query(PLOTS_DELETE_SQL, [src]);
    } else {
      await db.query(`delete from ${table} where source = $1`, [src]);
    }
  }
  // Pha 2 — ghi cha → con
  const counts: Counts = {};
  for (const table of DOMAIN_ORDER) {
    const d = byTable.get(table);
    if (!d) continue;
    const [src, rows] = d;
    if (table === 'products') {
      counts.product_events = await syncProducts(db, src, rows);
      counts.products = rows.length;
      continue;
    }
    const prod = byTable.get('products');
    if (table === 'claims_approved' && prod) await relinkRetiredClaims(db, prod[0], rows);
    const cols = COLS[table];
    let sql = `insert into ${table} (${cols.join(', ')}) values (${ph(cols.length)})`;
    if (table === 'plots') sql += PLOTS_UPSERT_SUFFIX;
    for (const r of rows) {
      await db.query(
        sql,
        cols.map((c) => r[c] ?? null),
      );
    }
    counts[table] = rows.length;
  }
  return counts;
}

/** GĐ vùng trồng đã gỡ dữ liệu mẫu vườn chưa (có log `garden_sample_purge`)? Bảng
 * `agent_action_log` chưa có → false (savepoint giữ giao dịch sống). `c` phải đang trong giao dịch. */
export async function sampleGardenPurged(c: pg.ClientBase): Promise<boolean> {
  await c.query('savepoint core_store_purged');
  try {
    const r = await c.query(
      "select exists (select 1 from agent_action_log where action = 'garden_sample_purge') as x",
    );
    await c.query('release savepoint core_store_purged');
    return r.rows[0]?.x === true;
  } catch (e) {
    if ((e as { code?: string }).code !== '42P01') throw e;
    await c.query('rollback to savepoint core_store_purged');
    return false;
  }
}

/** Bỏ domain plots/plot_logs nguồn `sample:*` (không delete, không insert) — domain khác giữ. */
export function dropSampleGarden<T extends [string, string, unknown]>(domains: T[]): T[] {
  return domains.filter(
    (d) => !((d[0] === 'plots' || d[0] === 'plot_logs') && d[1].startsWith('sample:')),
  );
}

/** Khoảnh thuộc source plots đang nạp mà loader GIỮ (còn nhật ký đã chain / ảnh) → [id, số nhật
 * ký chain, số ảnh] theo id. */
export async function keptPlots(db: Db, domains: Domain[]): Promise<[string, number, number][]> {
  const srcs = domains.filter(([t]) => t === 'plots').map(([, s]) => s);
  if (!srcs.length) return [];
  const { rows } = await db.query(
    'select p.id, (select count(*) from plot_logs l where l.plot_id = p.id and l.row_hash is not null) as n_logs,' +
      ' (select count(*) from garden_media m where m.plot_id = p.id) as n_media' +
      ` from plots p where p.source = any($1) and (${PLOT_PINNED}) order by p.id`,
    [srcs],
  );
  return rows.map((r) => [r.id, Number(r.n_logs), Number(r.n_media)]);
}
