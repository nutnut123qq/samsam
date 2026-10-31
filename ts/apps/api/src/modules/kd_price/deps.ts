import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { parseDay } from '@samsam/core/ops/period';
import { isPrintable } from '@samsam/core/ops/py';
import { cpCmp, isDict, PyFloat, parsePyJson, pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { readinessKey } from '@samsam/core/security/guardrail';
import { END, pyStrip, re, S } from '@samsam/core/security/py';

// Phần `agents/kd_listing.py` (đọc listing/golden/readiness/cảnh báo v3.3, đẩy hàng duyệt),
// `agents/fp_pnl.py` (cấu hình FP&A, giá vốn đã duyệt), `ingest/market_csv.py` (mapping, số VND,
// làm sạch chuỗi) mà KD-A5/combo/giá đại lý gọi lại. Ngày = chuỗi 'YYYY-MM-DD' (Python `date`).
// shortcut: bản riêng của nhóm kd_price (kd_listing/fp_pnl/market_csv chưa có port dùng chung; nhóm
// kd_quote có `goldenPrices`/`cogsAt` tương tự còn đang viết) — khi các module đó port xong thì
// import dùng chung, xóa phần trùng ở đây.

export type Day = string;
export type PriceCell = { price: number; id: number; approved: boolean };
/** Khóa `readinessKey(sku, kênh)` → {list|floor: PriceCell}. */
export type GoldenPrices = Map<string, Record<string, PriceCell>>;
export type Readiness = Map<string, string>;
export type CogsVersion = {
  id: number;
  sku_key: string;
  cost_vnd: number;
  valid_from: Day;
  approved_by: string | null;
};
export const key2 = readinessKey;

// ------------------------------------------------------------ chuỗi/số kiểu Python

/** So tuple Python (chuỗi theo code point, số theo giá trị). */
export function cmpTuple(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : cpCmp(String(x), String(y));
    if (d) return d;
  }
  return a.length - b.length;
}

/** Python `f"{n:,}"` cho số nguyên. */
export function grp(n: number | bigint): string {
  const s = BigInt(n).toString();
  const neg = s.startsWith('-');
  const d = neg ? s.slice(1) : s;
  return (neg ? '-' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `kd_listing.vnd`. */
export const vnd = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${grp(Math.trunc(n)).replaceAll(',', '.')} đ`;

const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** `kd_listing.ref_code`: mã sàn chỉ [A-Za-z0-9_.-] ≤ 40 ký tự, khác → '(mã lạ)' (không lọt chữ tự do). */
export const refCode = (s: unknown): string =>
  typeof s === 'string' && ITEM_RE.test(s) ? s : '(mã lạ)';

/** Python `json.dumps(v, ensure_ascii=…, sort_keys=…)` (separators mặc định `, ` `: `) cho giá trị
 * JSON thuần (ngày đã là chuỗi = `default=str`). */
export function pyDumps(v: unknown, o: { ascii?: boolean; sortKeys?: boolean } = {}): string {
  const str = (s: string) => {
    const j = JSON.stringify(s);
    return o.ascii
      ? j.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      : j;
  };
  const go = (x: unknown): string => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'string') return str(x);
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'number' || typeof x === 'bigint') return String(x);
    if (x instanceof PyFloat) return String(x.v);
    if (Array.isArray(x)) return `[${x.map(go).join(', ')}]`;
    const ks = Object.keys(x as object);
    if (o.sortKeys) ks.sort(cpCmp);
    return `{${ks.map((k) => `${str(k)}: ${go((x as Record<string, unknown>)[k])}`).join(', ')}}`;
  };
  return go(v);
}

/** `kd_listing.evidence_sha`. */
export const evidenceSha = (ev: Record<string, unknown>): string =>
  createHash('sha256')
    .update(pyDumps(ev, { sortKeys: true }), 'utf8')
    .digest('hex')
    .slice(0, 12);

/** `market_csv._clean`: bỏ ký tự điều khiển (escape terminal), cắt `n` code point. */
export function clean(s: unknown, n = 120): string {
  const out: string[] = [];
  for (const c of typeof s === 'string' ? s : String(s)) {
    if (out.length >= n) break;
    out.push(isPrintable(c) ? c : '?');
  }
  return out.join('');
}

// Số nguyên VND: "159000" | nhóm 3 chữ số cùng 1 ký tự phân cách ("482.900", "1,490,000").
const INT_RE = /^(?:[0-9]+|[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*)$/;
const STRIP_RE = re(`[${S}₫]|(?:VND|vnđ|đ)${END}`, 'gi');

/** `market_csv._to_int` → số | null. */
export function toInt(s: string | null | undefined, cap: number): number | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(STRIP_RE, '');
  if ([...t].length > 25 || !INT_RE.test(t)) return null;
  const n = BigInt(t.replaceAll('.', '').replaceAll(',', ''));
  return n <= BigInt(cap) ? Number(n) : null;
}

const ISO_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

/** `kd_price._date` / `dealer_price._date`: 'YYYY-MM-DD' hợp lệ → ngày | null (chữ số Unicode khớp
 * `\d` của Python nhưng `date.fromisoformat` từ chối → null như Python). */
export const pyDate = (s: unknown): Day | null =>
  typeof s === 'string' && ISO_RE.test(s) && parseDay(s) !== null ? s : null;

export const dayDiff = (a: Day, b: Day): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

// ------------------------------------------------------------ Decimal tỷ lệ (fp_pnl.frac)

/** `Decimal(str(v))` của Python: `s` = `str(Decimal)`, giá trị = n/d (d > 0). */
export type Ratio = { s: string; n: bigint; d: bigint };

/** Hệ số + số mũ → `str(Decimal)` (to-sci-string). */
function decStr(c: string, e: number, neg: boolean): string {
  const adj = e + c.length - 1;
  let s: string;
  if (e <= 0 && adj >= -6) {
    if (e === 0) s = c;
    else if (c.length > -e) s = `${c.slice(0, c.length + e)}.${c.slice(c.length + e)}`;
    else s = `0.${'0'.repeat(-e - c.length)}${c}`;
  } else {
    s = `${c[0]}${c.length > 1 ? `.${c.slice(1)}` : ''}E${adj >= 0 ? '+' : '-'}${Math.abs(adj)}`;
  }
  return (neg ? '-' : '') + s;
}

/** Số JSON (int | PyFloat) → Ratio đúng như `Decimal(str(v))`. */
export function ratioOf(v: number | PyFloat): Ratio {
  const x = v instanceof PyFloat ? v.v : v;
  let c: string;
  let e: number;
  if (v instanceof PyFloat && Number.isInteger(x)) {
    c = `${Math.abs(x)}0`; // str(1.0) = '1.0' → hệ số 10, mũ -1
    e = -1;
  } else {
    const [m, ex] = String(Math.abs(x)).split('e') as [string, string | undefined];
    const [ip, fp = ''] = m.split('.') as [string, string | undefined];
    c = (ip + fp).replace(/^0+(?=\d)/, '');
    e = Number(ex ?? 0) - fp.length;
  }
  const n = BigInt(c) * (x < 0 ? -1n : 1n);
  return e < 0
    ? { s: decStr(c, e, x < 0), n, d: 10n ** BigInt(-e) }
    : { s: decStr(c, e, x < 0), n: n * 10n ** BigInt(e), d: 1n };
}

/** Ratio từ chuỗi thập phân thuần ('0.85') — cho test/caller. */
export const ratio = (s: string): Ratio => ratioOf(new PyFloat(Number(s)));

/** Python `a // b` (làm tròn xuống) cho BigInt. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

// ------------------------------------------------------------ fp_pnl

export const FPA_CONFIG = dataPath('fpa_config.json');
export const NO_COGS = 'chưa có giá vốn duyệt';

/** `json.loads(p.read_bytes().decode("utf-8"))` → giá trị | tên lỗi Python. BOM = JSON hỏng. */
export function readStrictJson(path: string): [unknown, null] | [null, string] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return [null, pyOsName(e)];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return [null, 'UnicodeDecodeError'];
  }
  try {
    return [parsePyJson(text), null];
  } catch {
    return [null, 'JSONDecodeError'];
  }
}

/** `fp_pnl.read_config`: 1 mục của fpa_config.json (chưa validate) → [mục, null] | [null, lý do]. */
export function readConfig(
  section: string,
  path: string = FPA_CONFIG,
): [Record<string, unknown>, null] | [null, string] {
  const [raw, err] = readStrictJson(path);
  if (err !== null) return [null, `không đọc được ${basename(path)}: ${err}`];
  const sec = isDict(raw) ? raw[section] : undefined;
  if (!isDict(sec)) return [null, `${basename(path)}: thiếu mục '${section}'`];
  return [sec, null];
}

/** `fp_pnl.frac`: số 0..1 (không bool) → Ratio. */
export function frac(v: unknown, where: string): [Ratio, null] | [null, string] {
  if (!(typeof v === 'number' || v instanceof PyFloat)) return [null, `${where}: phải là số 0..1`];
  const x = v instanceof PyFloat ? v.v : v;
  if (!(x >= 0 && x <= 1)) return [null, `${where}: ngoài 0..1`];
  return [ratioOf(v), null];
}

/** `fp_pnl.cogs_at`: giá vốn ĐÃ duyệt hiệu lực ngày `day` (mới nhất theo valid_from, id) | null. */
export function cogsAt(versions: CogsVersion[], sku: unknown, day: Day): number | null {
  let best: [Day, number, number] | null = null;
  for (const v of versions) {
    if (v.sku_key !== sku || !pyStrip(v.approved_by ?? '')) continue;
    if (v.valid_from > day) continue;
    if (best === null || v.valid_from > best[0] || (v.valid_from === best[0] && v.id > best[1])) {
      best = [v.valid_from, v.id, v.cost_vnd];
    }
  }
  return best === null ? null : best[2];
}

export async function fetchVersions(db: Db): Promise<CogsVersion[]> {
  const { rows } = await db.query(
    'select id::text as id, sku_key, cost_vnd::text as cost, valid_from::text as valid_from, approved_by from cogs_versions order by id',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sku_key: r.sku_key,
    cost_vnd: Number(r.cost),
    valid_from: r.valid_from,
    approved_by: r.approved_by,
  }));
}

// ------------------------------------------------------------ market_csv

export const MARKET_CHANNELS = ['shopee', 'tiktok'];
export const MAP_FILE = dataPath('market_csv_map.json');

/** `market_csv.load_mapping` → [mapping, null] | [null, lý do]. */
export function loadMapping(path: string = MAP_FILE): [unknown, null] | [null, string] {
  const [raw, err] = readStrictJson(path);
  return err === null ? [raw, null] : [null, `không đọc được mapping ${basename(path)}: ${err}`];
}

// ------------------------------------------------------------ kd_listing (chỉ SELECT + đẩy)

export type ListingRow = {
  snapshot_id?: number;
  channel: string;
  row_no?: number;
  item_id: string | null;
  seller_sku: string | null;
  sku_key: string | null;
  title?: string | null;
  price_vnd: number | null;
  status?: string | null;
  sale_price: number | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** Python `int(s)` cho chữ trong `raw->>'sale_price'` → số | null (ValueError). */
function pyIntStr(s: string): number | null {
  const t = pyStrip(s);
  return /^[+-]?\d+(?:_\d+)*$/.test(t) ? Number(BigInt(t.replaceAll('_', ''))) : null;
}

/** `kd_listing.running_listings` → [dòng ĐANG BÁN của snapshot listing mới nhất mỗi kênh, kênh có
 * snapshot]. Status ∈ `inactive_status` → bỏ; status lạ/None = đang bán (fail-closed).
 * shortcut: `int()` của Python nhận cả chữ số Unicode (vd '١٢') — TS chỉ chữ số ASCII (file sàn
 * loader ghi chữ số ASCII); nâng khi có nguồn ghi khác. */
export async function runningListings(
  db: Db,
  mapping: unknown,
): Promise<[ListingRow[], Set<string>]> {
  const snaps = (
    await db.query(
      "select distinct on (channel) id::text as id, channel from market_snapshots where export_kind = 'listing' order by channel, imported_at desc, id desc",
    )
  ).rows;
  if (!snaps.length) return [[], new Set()];
  const { rows } = await db.query(
    "select snapshot_id::text as sid, channel, row_no, item_id, seller_sku, sku_key, title, price_vnd::text as price, status, raw->>'sale_price' as sale from market_rows where snapshot_id = any($1::bigint[]) order by channel, row_no",
    [snaps.map((s) => s.id)],
  );
  const m = isDict(mapping) ? mapping : {};
  const out: ListingRow[] = [];
  for (const r of rows) {
    const ch = isDict(m[r.channel]) ? (m[r.channel] as Record<string, unknown>) : {};
    const lst = isDict(ch.listing) ? (ch.listing as Record<string, unknown>) : {};
    const inactive = new Set(
      (Array.isArray(lst.inactive_status) ? lst.inactive_status : []).map((s: string) =>
        pyStrip(String(s).normalize('NFC')),
      ),
    );
    if (r.status !== null && inactive.has(pyStrip(String(r.status).normalize('NFC')))) continue;
    out.push({
      snapshot_id: Number(r.sid),
      channel: r.channel,
      row_no: r.row_no,
      item_id: r.item_id,
      seller_sku: r.seller_sku,
      sku_key: r.sku_key,
      title: r.title,
      price_vnd: num(r.price),
      status: r.status,
      sale_price: r.sale === null ? null : pyIntStr(r.sale),
    });
  }
  return [out, new Set(snaps.map((s) => s.channel as string))];
}

export async function readinessMap(db: Db): Promise<Readiness> {
  const { rows } = await db.query('select sku_key, channel, readiness from sku_readiness');
  return new Map(rows.map((r) => [key2(r.sku_key, r.channel), r.readiness]));
}

/** `kd_listing.golden_prices`: giá thường trực (program_id null) list/floor hiệu lực ngày `day`; nhiều
 * dòng mở (lỗi dữ liệu) → dòng valid_from/id mới nhất. */
export async function goldenPrices(db: Db, day: Day): Promise<GoldenPrices> {
  const { rows } = await db.query(
    "select sku_key, channel, kind, price_vnd::text as price, id::text as id, approved_by from price_list where program_id is null and kind in ('list', 'floor') and valid_from <= $1 and (valid_to is null or valid_to > $1) order by valid_from, id",
    [day],
  );
  const out: GoldenPrices = new Map();
  for (const r of rows) {
    const k = key2(r.sku_key, r.channel);
    const cur = out.get(k) ?? {};
    cur[r.kind] = { price: Number(r.price), id: Number(r.id), approved: r.approved_by !== null };
    out.set(k, cur);
  }
  return out;
}

/** {(kind, kênh, item_id, seller_sku): id} cảnh báo v3.3 đang mở — khóa nối bằng \0. */
export async function openV33Alerts(db: Db, kinds: string[]): Promise<Map<string, number>> {
  const { rows } = await db.query(
    "select id::text as id, kind, channel, item_id, seller_sku from market_alerts where status = 'open' and export_kind = 'listing' and kind = any($1::text[]) order by id",
    [kinds],
  );
  return new Map(
    rows.map((r) => [
      [r.kind, r.channel, r.item_id ?? '', r.seller_sku ?? ''].join('\0'),
      Number(r.id),
    ]),
  );
}

/** (object_type, object_id) đã có trong hàng duyệt Ở BẤT KỲ status — khóa nối bằng \0. */
export async function seenIds(db: Db, prefix: string): Promise<Set<string>> {
  const { rows } = await db.query(
    'select object_type, object_id from approval_queue where object_id like $1',
    [`${prefix}:%`],
  );
  return new Set(rows.map((r) => `${r.object_type}\0${r.object_id}`));
}

export type Item = { object_type: string; object_id: string; title: string; payload: string };
export const itemKey = (it: { object_type: string; object_id: string }) =>
  `${it.object_type}\0${it.object_id}`;

export function planOf(
  items: Item[],
  findings: { dup_alert?: unknown }[],
  seen: Set<string>,
): { new: number; seen: number; dup: number } {
  const s = items.filter((i) => seen.has(itemKey(i))).length;
  return {
    new: items.length - s,
    seen: s,
    dup: findings.filter((f) => f.dup_alert !== undefined && f.dup_alert !== null).length,
  };
}

/** `kd_listing.enqueue_new`: đẩy qua `director.submit` mục chưa có (mọi status) → số mục mới. */
export async function enqueueNew(
  db: Db,
  items: Item[],
  cfg: DirectorConfig,
  seen: Set<string>,
  agent: string,
  block = 'sales',
): Promise<number> {
  let n = 0;
  for (const it of items) {
    if (seen.has(itemKey(it))) continue;
    try {
      await submit(db, {
        block,
        objectType: it.object_type,
        objectId: it.object_id,
        title: it.title,
        payload: it.payload,
        createdBy: agent,
        cfg,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue; // cùng mục vừa được đẩy song song
      throw e;
    }
    seen.add(itemKey(it));
    n++;
  }
  return n;
}
