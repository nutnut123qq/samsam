import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { readinessFromDb, verifyPublish } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName, useReason } from '@samsam/core/rollout/rollout';
import { checkPublish, type ReadinessMap } from '@samsam/core/security/guardrail';
import { pyReprValue, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import { contentCfg, listingFields, precheck, type Sku } from './content-lite.js';
import { goldenPrices, type PriceCell } from './kd-listing.js';

// Port `agents/listing_export.py` — đợt hợp đồng C04, sales-03 "Listing đa sàn: một bản mô tả chuẩn
// cho mỗi sản phẩm, xuất ra mọi sàn đúng giá đã duyệt".
//  - MÔ TẢ CHUẨN của 1 SKU = nháp `content_drafts` loại `listing` kênh `web` ĐÃ được NGƯỜI duyệt và
//    `verify_publish` còn đúng (sửa sau duyệt → sha lệch → không dùng). Phiên bản = id nháp.
//  - XUẤT cho sàn (shopee|tiktok): mô tả = văn bản chuẩn bỏ đúng dòng `Giá: …` (`bo_dong_gia`) + giá
//    `list` của kênh đích ĐÃ duyệt còn hiệu lực trong `price_list` (không fallback JSON/kênh khác/
//    floor/promo/giá chờ duyệt; manifest ghi id dòng giá → `--verify` phát hiện giá đổi). Kênh đích
//    qua `precheck` (readiness) + `checkPublish` (listing) — không đạt → từ chối, không ghi tệp. Cổng
//    rollout sales-03 (biên DÙNG). Agent KHÔNG đăng/cập nhật sàn: người tải tệp lên Seller Center.
//  - Cột tệp theo `data/listing_export_map.json` — CHƯA XÁC MINH với mẫu tải lên thật của sàn.
//  - `--website-feed`: NGUỒN DỮ LIỆU cho website (JSON + manifest sha). Chỉ bán được (`gio_hang`)
//    khi kênh `web` qua precheck + guardrail, có mô tả chuẩn ĐÃ duyệt và giá `list` kênh web ĐÃ duyệt
//    còn hiệu lực. RƯỢU luôn ẩn giá + không giỏ hàng. Dòng không bán được ghi `ly_do` cụ thể.

export const MAP_FILE = dataPath('listing_export_map.json');
export const FEATURE = 'sales-03';
export const CHANNELS = ['shopee', 'tiktok'];
export const TRANSFORM = 'bo_dong_gia';
export const FIELDS = ['sku_key', 'ten_san_pham', 'mo_ta', 'quy_cach', 'so_dksp', 'gia_vnd'];
export const WEB = 'web';
export const FEED_VERSION = 1;
export const FEED_KEYS = ['gia_vnd', 'gia_id', 'an_gia', 'gio_hang', 'approved_sha256'];
const PRICE_SRC =
  'ĐÃ duyệt, hiệu lực theo ngày giờ VN (không fallback golden JSON/kênh khác/floor/promo)';

/** Từ chối xuất — không ghi tệp (Python ValueError). */
export class ExportError extends RangeError {
  override name = 'ExportError';
}

type Map2 = { status: string; columns: Record<string, Record<string, string>> };
type Row = Record<string, string>;
type Manifest = Record<string, unknown>;

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const shaBytes = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function loadMap(path: string = MAP_FILE): Map2 {
  const name = basename(path);
  // Python `v[k]`: không phải dict → TypeError, thiếu khóa → KeyError.
  const idx = (v: unknown, k: string): unknown => {
    if (!isPlainObject(v)) throw new ExportError('TypeError');
    if (!Object.hasOwn(v, k)) throw new ExportError('KeyError');
    return v[k];
  };
  let doc: unknown;
  const cols: Record<string, unknown> = {};
  try {
    doc = readJson(path);
    for (const ch of CHANNELS) cols[ch] = idx(idx(idx(doc, 'channels'), ch), 'columns');
  } catch (e) {
    const t = e instanceof JsonFileError ? e.pyType : (e as Error).message;
    throw new ExportError(`${name} hỏng (${t})`);
  }
  for (const [ch, c] of Object.entries(cols)) {
    const ok =
      isPlainObject(c) &&
      Object.keys(c).length === FIELDS.length &&
      FIELDS.every((f) => Object.hasOwn(c, f)) &&
      Object.values(c).every((v) => typeof v === 'string' && pyStrip(v) !== '');
    if (!ok) {
      throw new ExportError(
        `${name}: cột kênh ${ch} phải đủ (${FIELDS.map((f) => `'${f}'`).join(', ')})`,
      );
    }
  }
  const status = (doc as Record<string, unknown>).status;
  return {
    status: pyTruthy(status) ? pyStr(status) : '',
    columns: cols as Record<string, Record<string, string>>,
  };
}

/** (id nháp, văn bản) của mô tả chuẩn ĐÃ duyệt mới nhất còn khớp sha. */
export async function master(db: Db, sku: string): Promise<[number, string]> {
  const { rows } = await db.query(
    "select id::text as id, text from content_drafts where content_type = 'listing' and channel = 'web' and sku = $1 and status = 'approved' order by reviewed_at desc nulls last, id desc",
    [sku],
  );
  if (!rows.length) {
    throw new ExportError(`${sku}: chưa có mô tả chuẩn (listing web) được người duyệt`);
  }
  const did = Number(rows[0].id);
  const text = rows[0].text as string;
  if (!(await verifyPublish(db, did, text))) {
    throw new ExportError(
      `${sku}: mô tả chuẩn #${did} đã đổi sau duyệt (sha lệch) — phải duyệt lại`,
    );
  }
  return [did, text];
}

/** Biến đổi tất định `bo_dong_gia`: bỏ dòng bắt đầu `Giá:`. */
export const describe = (text: string): string =>
  text
    .split('\n')
    .filter((ln) => !ln.startsWith('Giá:'))
    .join('\n');

const codes = (g: { violations?: unknown }) =>
  (Array.isArray(g.violations) ? g.violations : [])
    .map((v) => pyStr((v as Record<string, unknown>)?.code ?? null))
    .join(',');

/** Ngày hôm nay giờ VN. */
const vnToday = (): string => vnDate(new Date());

/** {sku: {price, id, approved}} giá `list` kênh `channel` thường trực hiệu lực ngày `day` — CÙNG
 * quy tắc `goldenPrices`. Không đọc được bảng giá (thiếu bảng/quyền/DB lỗi) → ExportError: không bán
 * bằng giá đoán. */
export async function channelPrices(
  db: Db,
  day: string,
  channel: string,
): Promise<Map<string, PriceCell>> {
  let prices: Awaited<ReturnType<typeof goldenPrices>>;
  try {
    prices = await goldenPrices(db, day);
  } catch (e) {
    if (!isDbError(e)) throw e;
    throw new ExportError(
      `không đọc được bảng giá đã duyệt (price_list: ${pgErrName(e)}) — không xuất`,
    );
  }
  const out = new Map<string, PriceCell>();
  for (const [k, kinds] of prices) {
    const [sku, ch] = k.split('\0') as [string, string];
    if (ch === channel && kinds.list) out.set(sku, kinds.list);
  }
  return out;
}

export const webPrices = (db: Db, day: string) => channelPrices(db, day, WEB);

/** → {row, manifest} — chưa ghi tệp. Từ chối → ExportError. Giá = `list` kênh đích ĐÃ duyệt hiệu
 * lực ngày `today` (mặc định hôm nay giờ VN) trong `price_list`. */
export async function build(
  db: Db,
  sku: string,
  channel: string,
  readiness: ReadinessMap | null = null,
  today: string | null = null,
): Promise<{ row: Row; manifest: Manifest }> {
  if (!CHANNELS.includes(channel)) {
    throw new ExportError(`kênh phải (${CHANNELS.map((c) => `'${c}'`).join(', ')})`);
  }
  const why = await useReason(db, FEATURE, 'xuất listing cho sàn', true);
  if (why) throw new ExportError(why);
  const rd = readiness ?? (await readinessFromDb(db));
  const ref = precheck(sku, channel, 'listing', rd);
  if (ref) throw new ExportError(`${sku} × ${channel}: ${ref.reason}`);
  const [did, text] = await master(db, sku);
  const desc = describe(text);
  const g = checkPublish(desc, { channel, contentType: 'listing', sku, readiness: rd });
  if (g.ok !== true) {
    throw new ExportError(`${sku} × ${channel}: guardrail không đạt ${codes(g)}`);
  }
  const f = listingFields(sku);
  const day = today ?? vnToday();
  const lp = (await channelPrices(db, day, channel)).get(sku);
  if (lp === undefined) {
    throw new ExportError(
      `${sku} × ${channel}: chưa có giá list kênh còn hiệu lực trong price_list`,
    );
  }
  if (!lp.approved) {
    throw new ExportError(
      `${sku} × ${channel}: giá list #${lp.id} đang CHỜ người duyệt — không xuất`,
    );
  }
  const row: Row = {
    sku_key: sku,
    ten_san_pham: f.name,
    mo_ta: desc,
    quy_cach: f.pack_spec || '',
    so_dksp: f.receipt_no || '',
    gia_vnd: String(lp.price),
  };
  return {
    row,
    manifest: {
      sku,
      channel,
      draft_id: did,
      approved_sha256: sha(text),
      transform: TRANSFORM,
      description_sha256: sha(desc),
      gia_vnd: lp.price,
      gia_id: lp.id,
      gia_ngay_hieu_luc: day,
      gia_nguon: `price_list kênh đích loại list ${PRICE_SRC}`,
    },
  };
}

/** Python `csv.writer(lineterminator="\n")` QUOTE_MINIMAL: trường có `,` `"` `\n` `\r` → bọc
 * nháy kép (nháy bên trong nhân đôi); dòng 1 trường rỗng → `""`. */
function csvLine(fields: string[]): string {
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  if (fields.length === 1 && fields[0] === '') return '""\n';
  return `${fields.map(q).join(',')}\n`;
}

/** Tệp CSV utf-8-sig (BOM) 2 dòng: tiêu đề cột + giá trị. */
export function toCsv(row: Row, cols: Record<string, string>): Buffer {
  const text =
    csvLine(FIELDS.map((k) => cols[k] as string)) + csvLine(FIELDS.map((k) => row[k] as string));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

function atomic(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const jsonBytes = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');

/** Xuất 1 SKU × kênh sàn → đường manifest. */
export async function exportListing(
  db: Db,
  sku: string,
  channel: string,
  outDir: string,
  readiness: ReadinessMap | null = null,
  mapPath: string = MAP_FILE,
): Promise<string> {
  const m = loadMap(mapPath);
  const b = await build(db, sku, channel, readiness);
  mkdirSync(outDir, { recursive: true });
  const stem = `listing-${channel}-${sku}-d${b.manifest.draft_id}`;
  const data = toCsv(b.row, m.columns[channel] as Record<string, string>);
  atomic(join(outDir, `${stem}.csv`), data);
  const man = {
    ...b.manifest,
    file: `${stem}.csv`,
    file_sha256: shaBytes(data),
    mapping_status: m.status,
  };
  const mp = join(outDir, `${stem}.manifest.json`);
  atomic(mp, jsonBytes(man));
  return mp;
}

/** Tệp cùng thư mục manifest (Python `Path.with_name`: tên có dấu tách/rỗng → lỗi, không thoát
 * khỏi thư mục) | null. */
function sibling(mp: string, name: unknown): string | null {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    return null;
  }
  return join(dirname(mp), name);
}

const isFile = (p: string | null): p is string =>
  p !== null && existsSync(p) && statSync(p).isFile();

/** Danh sách lệch (rỗng = khớp): mô tả chuẩn còn đúng bản đã duyệt, mô tả/giá/tệp tính lại trùng
 * manifest. Manifest hỏng (thiếu sku/channel/file) → ném lỗi như Python (KeyError/ValueError). */
export async function verify(
  db: Db,
  manifestPath: string,
  readiness: ReadinessMap | null = null,
  mapPath: string = MAP_FILE,
): Promise<string[]> {
  const man = readJson(manifestPath) as Manifest;
  if (!isPlainObject(man) || typeof man.sku !== 'string' || typeof man.channel !== 'string') {
    throw new TypeError('manifest thiếu sku/channel');
  }
  const bad: string[] = [];
  let b: Awaited<ReturnType<typeof build>>;
  try {
    b = await build(db, man.sku, man.channel, readiness);
  } catch (e) {
    if (e instanceof ExportError) return [`không dựng lại được: ${e.message}`];
    throw e;
  }
  for (const k of ['draft_id', 'approved_sha256', 'description_sha256', 'gia_vnd', 'gia_id']) {
    if (b.manifest[k] !== man[k]) bad.push(`${k} lệch (hiện ${pyStr(b.manifest[k])})`);
  }
  const data = toCsv(b.row, loadMap(mapPath).columns[man.channel] as Record<string, string>);
  const f = sibling(manifestPath, man.file);
  if (f === null) throw new RangeError('manifest: tên tệp không hợp lệ');
  if (!isFile(f)) {
    bad.push('thiếu tệp CSV');
  } else {
    if (shaBytes(readFileSync(f)) !== man.file_sha256) {
      bad.push('tệp CSV đã bị sửa (sha lệch manifest)');
    }
    if (shaBytes(data) !== man.file_sha256) bad.push('tệp dựng lại khác bản đã xuất');
  }
  return bad;
}

export type FeedRow = {
  sku_key: string;
  ten_san_pham: unknown;
  quy_cach: unknown;
  so_dksp: unknown;
  mo_ta: string | null;
  draft_id: number | null;
  approved_sha256: string | null;
  gia_vnd: number | null;
  gia_id: number | null;
  an_gia: boolean;
  gio_hang: boolean;
  ly_do: string[];
};

/** 1 dòng nguồn dữ liệu website — golden (tên/quy cách) + mô tả ĐÃ duyệt + giá web ĐÃ duyệt từ DB
 * (`prices` của `webPrices`; null → tự đọc ngày `today`, mặc định hôm nay giờ VN). */
export async function websiteRow(
  db: Db,
  sku: string,
  gold: Sku,
  readiness: ReadinessMap | null,
  prices: Map<string, PriceCell> | null = null,
  today: string | null = null,
): Promise<FeedRow> {
  const pr = prices ?? (await webPrices(db, today ?? vnToday()));
  const alcohol = gold.category === 'alcohol';
  const get = (k: string) => (gold[k] === undefined ? null : gold[k]);
  const row: FeedRow = {
    sku_key: sku,
    ten_san_pham: get('name'),
    quy_cach: get('pack_spec'),
    so_dksp: get('receipt_no'),
    mo_ta: null,
    draft_id: null,
    approved_sha256: null,
    gia_vnd: null,
    gia_id: null,
    an_gia: alcohol,
    gio_hang: false,
    ly_do: [],
  };
  const ref = precheck(sku, WEB, 'listing', readiness);
  if (ref) row.ly_do.push(`kênh web: ${ref.reason}`);
  try {
    const [did, text] = await master(db, sku);
    const desc = describe(text);
    const g = checkPublish(desc, { channel: WEB, contentType: 'listing', sku, readiness });
    if (g.ok === true) {
      row.mo_ta = desc;
      row.draft_id = did;
      row.approved_sha256 = sha(text);
    } else {
      row.ly_do.push(`guardrail không đạt ${codes(g)}`);
    }
  } catch (e) {
    if (!(e instanceof ExportError)) throw e;
    row.ly_do.push(e.message);
  }
  const lp = pr.get(sku);
  const okPrice = Boolean(lp?.approved);
  if (alcohol) row.ly_do.push('rượu: ẩn giá + không giỏ hàng (PL01 mục 3a)');
  else if (lp === undefined) {
    row.ly_do.push('chưa có giá list kênh web còn hiệu lực trong price_list');
  } else if (!okPrice) {
    row.ly_do.push(`giá list kênh web #${lp.id} đang CHỜ người duyệt — chưa dùng`);
  } else {
    row.gia_vnd = lp.price;
    row.gia_id = lp.id;
  }
  row.gio_hang = !alcohol && okPrice && row.mo_ta !== null && !row.ly_do.length;
  return row;
}

function golden(): Map<string, Sku> {
  const [cfg, err] = contentCfg();
  if (err !== null || cfg === null) throw new ExportError(err ?? 'config');
  return cfg.golden;
}

/** Ghi website-feed-<ngày>.json + .manifest.json → đường manifest. */
export async function websiteFeed(
  db: Db,
  outDir: string,
  readiness: ReadinessMap | null = null,
  now: Date | null = null,
): Promise<string> {
  const why = await useReason(db, FEATURE, 'xuất nguồn dữ liệu website', true);
  if (why) throw new ExportError(why);
  const rd = readiness ?? (await readinessFromDb(db));
  const gold = golden();
  const day = vnDate(now ?? new Date());
  const prices = await webPrices(db, day);
  const rows: FeedRow[] = [];
  for (const k of [...gold.keys()].sort()) {
    rows.push(await websiteRow(db, k, gold.get(k) as Sku, rd, prices));
  }
  const stem = `website-feed-${day}`;
  const data = jsonBytes({ version: FEED_VERSION, rows });
  mkdirSync(outDir, { recursive: true });
  atomic(join(outDir, `${stem}.json`), data);
  const man = {
    file: `${stem}.json`,
    file_sha256: shaBytes(data),
    version: FEED_VERSION,
    so_sku: rows.length,
    ban_duoc: rows.filter((r) => r.gio_hang).length,
    gia_nguon: `price_list kênh web loại list ${PRICE_SRC}`,
    gia_ngay_hieu_luc: day,
    gia_phien_ban: Object.fromEntries(
      rows.filter((r) => r.gia_id !== null).map((r) => [r.sku_key, r.gia_id]),
    ),
    mo_ta_nguon: 'content_drafts listing kênh web ĐÃ duyệt (sha)',
  };
  const mp = join(outDir, `${stem}.manifest.json`);
  atomic(mp, jsonBytes(man));
  return mp;
}

/** r13 (sales-08, biên repo website): kiểm 1 nguồn dữ liệu website đã xuất trước khi bên website
 * nạp → danh sách lệch (rỗng = dùng được): tệp còn đúng sha manifest; mỗi SKU tính lại HÔM NAY (giờ
 * VN) từ giá web ĐÃ duyệt + mô tả đã duyệt vẫn trùng giá/phiên bản giá/ẩn giá/giỏ hàng/sha mô tả. */
export async function verifyFeed(
  db: Db,
  man: Manifest,
  mp: string,
  readiness: ReadinessMap | null = null,
  now: Date | null = null,
): Promise<string[]> {
  const f = sibling(mp, man.file);
  if (!isFile(f)) return ['thiếu tệp nguồn dữ liệu website'];
  const raw = readFileSync(f);
  const bad: string[] = [];
  if (shaBytes(raw) !== man.file_sha256) {
    bad.push('tệp nguồn dữ liệu đã bị sửa (sha lệch manifest)');
  }
  let rows: unknown[];
  try {
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!isPlainObject(doc) || !Object.hasOwn(doc, 'rows')) throw new Error('KeyError');
    rows = doc.rows as unknown[];
    if (!Array.isArray(rows)) throw new Error('TypeError');
  } catch {
    return [...bad, 'tệp nguồn dữ liệu hỏng'];
  }
  const rd = readiness ?? (await readinessFromDb(db));
  const gold = golden();
  const prices = await webPrices(db, vnDate(now ?? new Date()));
  for (const r0 of rows) {
    const r = isPlainObject(r0) ? r0 : {};
    const k = r.sku_key;
    if (typeof k !== 'string' || !gold.has(k)) {
      bad.push(`${pyStr(k ?? null)}: không còn trong golden`);
      continue;
    }
    const cur = (await websiteRow(db, k, gold.get(k) as Sku, rd, prices)) as unknown as Record<
      string,
      unknown
    >;
    for (const key of FEED_KEYS) {
      const fileV = r[key] === undefined ? null : r[key];
      if (cur[key] !== fileV) {
        bad.push(`${k}: ${key} lệch (tệp ${pyReprValue(fileV)}, hiện ${pyReprValue(cur[key])})`);
      }
    }
  }
  const fileKeys = rows.map((r) => (isPlainObject(r) ? r.sku_key : undefined));
  const goldKeys = [...gold.keys()].sort();
  const sameSet =
    fileKeys.length === goldKeys.length &&
    fileKeys.every((x) => typeof x === 'string') &&
    (fileKeys as string[]).sort().every((x, i) => x === goldKeys[i]);
  if (!sameSet) bad.push('danh sách SKU khác golden hiện hành');
  return bad;
}
