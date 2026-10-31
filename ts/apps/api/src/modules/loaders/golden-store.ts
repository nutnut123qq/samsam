import { readFileSync, statSync } from 'node:fs';
import { pyStrip } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { isoDate } from '@samsam/core/ops/py-date';
import { cpCmp, isPyInt, PyFloat, pyLoads, pyNum, reprV } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { callHuman, HumanDenied, HumanError } from '@samsam/core/security/auth';
import { D, pyRepr, pyStr, pyTruthy, S, W } from '@samsam/core/security/py';
import { LONE_SURROGATE } from './core-store.js';
import { pyDumps } from './py.js';

// Port `ingest/golden_store.py` (v3.2 golden master) — nạp `data/golden_skus.json` vào bảng golden
// (`sku_master`, `sku_map`, `price_list`) + dựng phiếu lệch `golden_discrepancies` + duyệt giá cho
// NGƯỜI thật. Luật giữ nguyên:
//   - `products` thuộc core_store — module này CHỈ ĐỌC products, không bao giờ ghi.
//   - Golden = nguồn sự thật DUY NHẤT cho listing/giá/trạng thái pháp lý. Agent lập phiếu lệch nhưng
//     KHÔNG tự chọn giá; mọi giá nạp với approved_by=null → `v_promotable` rỗng tới khi GĐ bán hàng duyệt.
//   - Đọc + validate TOÀN file TRƯỚC khi kết nối; file thiếu/rỗng/JSON hỏng/`{}`/chỉ `_doc`/`skus: []`
//     → [warn] exit 1, không kết nối, không xóa gì.
//   - Upsert theo khóa (KHÔNG delete-by-source): sku_master chỉ đổi khi không phải 'manual' VÀ dữ liệu
//     đổi thật → version+1; sku_map giữ row manual (đổi sku_key → trigger DB xóa duyệt cũ); price_list
//     APPEND-ONLY (khác giá → đóng valid_to = hôm nay VN + dòng mới chờ duyệt).
//   - SKU/mapping/giá vắng khỏi file → GIỮ NGUYÊN (ngừng bán / gỡ giá là quyết định của người).
//   - Phiếu lệch dựng lại mỗi lần nạp, `status`/`resolved_by` do người — loader không đụng; phiếu
//     `pending` của loader hết điều kiện thì xóa. `detail` ghi giá trị theo TỪNG nguồn.
//   - Ràng buộc giá (số nguyên): R1 list*100 <= floor*149 · R2 (list-promo)*100 <= list*49 ·
//     R3 floor <= promo <= list — mỗi rule chỉ xét khi đủ giá trị.

export const GOLDEN_FILE = dataPath('golden_skus.json');
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol'];
export const XNQC = ['none', 'pending', 'approved'];
export const CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'];
export const KINDS = ['floor', 'list', 'promo'] as const;
export const DISC_SOURCE = 'golden_store';
export const MAX_BY_LEN = 100;
export const TODAY_VN = "(now() at time zone 'Asia/Ho_Chi_Minh')::date";

// Python `^...$`: `$` khớp cả trước '\n' cuối (sku_key 'abc\n' qua được — giữ y Python).
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\n?$/;
// Python `(\d+)\s*(viên|v|ml)\b` + IGNORECASE (Unicode): lớp ký tự = đúng tập Python coi là bằng
// nhau khi bỏ hoa/thường (i ~ I ~ İ ~ ı — JS /iu không gộp İ/ı); `\b` = không có chữ/số/_ theo sau.
const SPEC_RE = new RegExp(`(${D}+)[${S}]*([vV][iIİı][êÊ][nN]|[vV]|[mM][lL])(?![${W}])`, 'u');
const ND = /^\p{Nd}$/u;

/** Cột dữ liệu sku_master do file golden quản (so "đổi thật" để version+1). */
export const SKU_COLS = [
  'name',
  'category',
  'pack_spec',
  'receipt_no',
  'receipt_date',
  'xnqc_status',
  'self_declaration_ok',
  'allowed_channels',
  'shopee_item_id',
  'note',
];

export type Doc = Record<string, unknown> & { skus: unknown };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
const truthy = (v: unknown) => (v instanceof PyFloat ? v.v !== 0 : pyTruthy(v));
const pyTuple = (xs: readonly string[]) => `(${xs.map(pyRepr).join(', ')})`;
/** Python `x in (…)` (so bằng `==`: 1 == 1.0 == True). */
const pyIn = (v: unknown, xs: readonly unknown[]) => {
  const n = typeof v === 'boolean' ? Number(v) : pyNum(v);
  return xs.some((x) =>
    n !== null && (typeof x === 'number' || typeof x === 'boolean') ? Number(x) === n : x === v,
  );
};
const has = (o: Obj, k: string) => Object.hasOwn(o, k);
const getOr = (o: Obj, k: string, d: unknown) => (has(o, k) ? o[k] : d);

// ---------------------------------------------------------------- đọc + validate (thuần)

/**
 * → [doc, null] | [null, lý do]. Mọi biến thể "không có dữ liệu" (thiếu / rỗng / JSON hỏng / `{}` /
 * chỉ `_doc` / `skus: []`) trả lý do để caller dừng TRƯỚC khi kết nối — không bao giờ xóa trắng.
 * KHÁC Python có chủ đích: NaN/Infinity → JSON hỏng (chặt hơn).
 */
export function readGolden(path: string): [Doc | null, string | null] {
  let raw: Buffer;
  try {
    if (!statSync(path).isFile()) return [null, `thiếu file ${path}`];
    raw = readFileSync(path);
  } catch {
    return [null, `thiếu file ${path}`];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ 1 BOM đầu
  } catch (e) {
    return [null, `${path} không phải UTF-8: ${(e as Error).message}`];
  }
  if (!pyStrip(text)) return [null, `${path} rỗng`];
  let doc: unknown;
  try {
    doc = pyLoads(text);
  } catch (e) {
    return [null, `${path} JSON hỏng: ${(e as Error).message}`];
  }
  if (!isObj(doc) || !truthy(doc.skus)) {
    return [null, `${path} không có SKU nào (0 record) — không nạp`];
  }
  return [doc as Doc, null];
}

/** 3 ràng buộc giá người dùng đặt — số nguyên, chỉ khi đủ giá trị. */
export function checkPrices(skuKey: string, channel: string, p: Obj): string[] {
  const errs: string[] = [];
  const g = (k: string) => (p[k] ?? null) as number | null;
  const [floor, lst, promo] = [g('floor'), g('list'), g('promo')];
  const where = `${skuKey}/${channel}`;
  if (floor !== null && lst !== null && lst * 100 > floor * 149) {
    errs.push(`${where} R1: giá thường ${lst} > 149% giá sàn ${floor}`);
  }
  if (lst !== null && promo !== null && (lst - promo) * 100 > lst * 49) {
    errs.push(`${where} R2: KM ${promo} giảm > 49% từ giá thường ${lst}`);
  }
  if (
    (floor !== null && promo !== null && promo < floor) ||
    (promo !== null && lst !== null && promo > lst) ||
    (floor !== null && lst !== null && floor > lst)
  ) {
    errs.push(
      `${where} R3: phải sàn ${pyStr(floor)} <= KM ${pyStr(promo)} <= thường ${pyStr(lst)}`,
    );
  }
  return errs;
}

/** Hàm thuần: schema + R1/R2/R3. [] = hợp lệ. Mỗi lỗi nêu sku_key. `doc` = kết quả `pyLoads`. */
export function validate(doc: unknown): string[] {
  if (!isObj(doc)) return ['root phải là object {"_doc", "skus"}'];
  const skus = doc.skus;
  if (!Array.isArray(skus) || !skus.length) return ['skus phải là list không rỗng'];
  const errs: string[] = [];
  const seen = new Set<string>();
  const owner = new Map<string, string>();
  skus.forEach((s, i) => {
    if (!isObj(s)) {
      errs.push(`skus[${i}] không phải object`);
      return;
    }
    let key = s.sku_key as string;
    if (typeof key !== 'string' || !SLUG_RE.test(key)) {
      errs.push(`skus[${i}] sku_key ${reprV(s.sku_key ?? null)} không phải slug ascii`);
      key = `skus[${i}]`;
    } else if (seen.has(key)) {
      errs.push(`${key}: sku_key trùng`);
    }
    seen.add(key);
    if (typeof s.name !== 'string' || !pyStrip(s.name)) errs.push(`${key}: thiếu name`);
    if (!pyIn(s.category ?? null, CATEGORIES)) {
      errs.push(`${key}: category ${reprV(s.category ?? null)} không hợp lệ`);
    }
    if (!pyIn(getOr(s, 'xnqc_status', 'none'), XNQC)) {
      errs.push(`${key}: xnqc_status ${reprV(s.xnqc_status ?? null)} không hợp lệ`);
    }
    if (!pyIn(s.self_declaration_ok ?? null, [true, false, null])) {
      errs.push(`${key}: self_declaration_ok phải true/false/null`);
    }
    for (const f of ['pack_spec', 'receipt_no', 'shopee_item_id', 'note']) {
      if ((s[f] ?? null) !== null && typeof s[f] !== 'string') {
        errs.push(`${key}: ${f} phải là chuỗi hoặc null`);
      }
    }
    const rd = s.receipt_date ?? null;
    if (rd !== null && (typeof rd !== 'string' || isoDate(rd) === null)) {
      errs.push(`${key}: receipt_date ${reprV(rd)} không phải ISO`);
    }
    const chans = getOr(s, 'allowed_channels', []);
    if (!Array.isArray(chans) || chans.some((c) => !pyIn(c, CHANNELS))) {
      errs.push(`${key}: allowed_channels phải ⊂ ${pyTuple(CHANNELS)}`);
    }
    let pids = getOr(s, 'product_ids', []);
    if (!Array.isArray(pids) || !pids.every((p) => typeof p === 'string' && p)) {
      errs.push(`${key}: product_ids phải là list chuỗi`);
      pids = [];
    }
    for (const p of pids as string[]) {
      if (owner.has(p)) errs.push(`${key}: product_id ${p} đã map cho ${owner.get(p)}`);
      else owner.set(p, key);
    }
    const prices = getOr(s, 'prices', {});
    if (!isObj(prices)) {
      errs.push(`${key}: prices phải là object`);
      return;
    }
    for (const [ch, p] of Object.entries(prices)) {
      if (!CHANNELS.includes(ch)) {
        errs.push(`${key}: kênh giá ${pyRepr(ch)} không hợp lệ`);
        continue;
      }
      if (!isObj(p)) {
        errs.push(`${key}/${ch}: giá phải là object`);
        continue;
      }
      let bad = false;
      for (const [k, v] of Object.entries(p)) {
        if (!(KINDS as readonly string[]).includes(k)) {
          errs.push(`${key}/${ch}: loại giá ${pyRepr(k)} không hợp lệ`);
          bad = true;
        } else if (!isPyInt(v) || v <= 0) {
          errs.push(`${key}/${ch}: giá ${k}=${reprV(v)} phải nguyên dương`);
          bad = true;
        }
      }
      if (!bad) errs.push(...checkPrices(key, ch, p));
    }
  });
  return errs;
}

/**
 * TS chặt hơn (sau `validate`, trước khi kết nối): thứ Python để DB/psycopg báo lỗi lúc ghi (exit 1,
 * rollback) hoặc node-pg ghi SAI lặng lẽ → lỗi rõ, không kết nối: self_declaration_ok là số (0/1 —
 * cột boolean), chuỗi có NUL/surrogate lẻ, giá vượt 2^53 (JS làm tròn).
 */
export function loadProblems(doc: Doc): string[] {
  const errs: string[] = [];
  const badStr = (v: unknown): boolean =>
    typeof v === 'string'
      ? LONE_SURROGATE.test(v) || v.includes('\0')
      : Array.isArray(v)
        ? v.some(badStr)
        : isObj(v) && Object.entries(v).some(([k, x]) => badStr(k) || badStr(x));
  for (const s of doc.skus as Obj[]) {
    const key = String(s.sku_key);
    const sd = s.self_declaration_ok ?? null;
    if (sd !== null && typeof sd !== 'boolean') {
      errs.push(
        `${key}: self_declaration_ok phải true/false/null — số không nạp được vào cột boolean`,
      );
    }
    if (badStr(s)) errs.push(`${key}: chuỗi có NUL/surrogate lẻ — không nạp`);
    for (const [ch, kp] of Object.entries((s.prices ?? {}) as Obj)) {
      for (const [k, v] of Object.entries(kp as Obj)) {
        if (!Number.isSafeInteger(v))
          errs.push(`${key}/${ch}: giá ${k}=${v} vượt 2^53 — không nạp`);
      }
    }
  }
  return errs;
}

/** Python `int()` của chuỗi chữ số Unicode (Nd: mọi dải 10 ký tự liên tiếp bắt đầu bằng số 0). */
function digitsValue(s: string): string {
  let n = 0n;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
    n = n * 10n + BigInt((cp - start) % 10);
  }
  return n.toString();
}

/** Tách quy cách đầu tiên 'số + đơn vị' (viên|v|ml) → '12 viên', '120 ml'. Không có → null (tên
 * không ghi quy cách thì không so). */
export function specOf(text: string | null | undefined): string | null {
  const m = SPEC_RE.exec(text || '');
  if (!m) return null;
  const unit = (m[2] as string).toLowerCase();
  return `${digitsValue(m[1] as string)} ${unit === 'ml' ? 'ml' : 'viên'}`;
}

// ---------------------------------------------------------------- phiếu lệch (thuần)

export type SkuInfo = {
  sku_key: string;
  name: string;
  category: string;
  pack_spec: string | null;
  shopee_item_id: string | null;
  allowed_channels: string[];
};
/** {sku_key: {kênh: {loại: giá}}} — chỉ dòng mở. */
export type Prices = Record<string, Record<string, Record<string, number>>>;
export type ProductInfo = { id: string; name: string; price_vnd: number | null };
export type Ticket = {
  kind: string;
  sku_key: string | null;
  product_id: string | null;
  detail: Record<string, unknown>;
};

/**
 * Dựng phiếu lệch từ dữ liệu đã đọc DB. `maps` = {product_id → sku_key}. Giá trị ghi theo TỪNG
 * nguồn, KHÔNG chọn giá nào đúng.
 */
export function buildDiscrepancies(
  skus: SkuInfo[],
  prices: Prices,
  maps: Map<string, string>,
  products: ProductInfo[],
): Ticket[] {
  const out: Ticket[] = [];
  const byKey = new Map(skus.map((s) => [s.sku_key, s]));
  const prodIds = new Set(products.map((p) => p.id));
  const pricesOf = (k: string) => (Object.hasOwn(prices, k) ? (prices[k] as Prices[string]) : {});

  for (const p of products) {
    const skuKey = maps.get(p.id);
    const s = skuKey === undefined ? undefined : byKey.get(skuKey);
    if (skuKey === undefined || s === undefined) {
      out.push({
        kind: 'product_unmapped',
        sku_key: null,
        product_id: p.id,
        detail: { web: { name: p.name, price_vnd: p.price_vnd } },
      });
      continue;
    }
    const golden = pricesOf(skuKey);
    const lists = Object.values(golden)
      .filter((kp) => Object.hasOwn(kp, 'list'))
      .map((kp) => kp.list);
    if (p.price_vnd !== null && lists.length && !lists.includes(p.price_vnd)) {
      out.push({
        kind: 'price_mismatch',
        sku_key: skuKey,
        product_id: p.id,
        detail: { web: { product_id: p.id, name: p.name, price_vnd: p.price_vnd }, golden },
      });
    }
    const webSpec = specOf(p.name);
    const goldSpec = specOf(s.pack_spec);
    if (webSpec && goldSpec && webSpec !== goldSpec) {
      out.push({
        kind: 'spec_mismatch',
        sku_key: skuKey,
        product_id: p.id,
        detail: {
          web: { name: p.name, spec: webSpec },
          golden: { pack_spec: s.pack_spec, spec: goldSpec },
        },
      });
    }
  }

  for (const s of skus) {
    const key = s.sku_key;
    const mapped = [...maps]
      .filter(([, k]) => k === key)
      .map(([pid]) => pid)
      .sort(cpCmp);
    if (!mapped.some((pid) => prodIds.has(pid))) {
      out.push({
        kind: 'sku_no_product',
        sku_key: key,
        product_id: null,
        detail: { golden: { name: s.name }, mapped_product_ids: mapped },
      });
    }
    const g = pricesOf(key);
    const shopee = Object.hasOwn(g, 'shopee') ? (g.shopee as Record<string, number>) : {};
    const missing = KINDS.filter((k) => !Object.hasOwn(shopee, k));
    if (missing.length) {
      out.push({
        kind: 'missing_price',
        sku_key: key,
        product_id: null,
        detail: { golden: { shopee }, missing },
      });
    }
    if (s.category === 'alcohol' && s.shopee_item_id) {
      out.push({
        kind: 'alcohol_online_listing',
        sku_key: key,
        product_id: null,
        detail: {
          golden: { shopee_item_id: s.shopee_item_id, allowed_channels: s.allowed_channels },
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- DB

const SKU_ALL = ['sku_key', ...SKU_COLS, 'source'];
export const SKU_SQL =
  `insert into sku_master (${SKU_ALL.join(', ')}) values (${SKU_ALL.map((_, i) => `$${i + 1}`).join(', ')})` +
  ` on conflict (sku_key) do update set ${SKU_COLS.map((c) => `${c} = excluded.${c}`).join(', ')}, ` +
  'source = excluded.source, version = sku_master.version + 1, updated_at = now() ' +
  "where sku_master.source <> 'manual' " +
  `and (${SKU_COLS.map((c) => `sku_master.${c}`).join(', ')}) is distinct from (${SKU_COLS.map((c) => `excluded.${c}`).join(', ')})`;
export const MAP_SQL =
  'insert into sku_map (product_id, sku_key, note, source) ' +
  'values ($1, $2, $3, $4) on conflict (product_id) do update set ' +
  'sku_key = excluded.sku_key, note = excluded.note ' +
  "where sku_map.source <> 'manual' and (sku_map.sku_key, " +
  'sku_map.note) is distinct from (excluded.sku_key, excluded.note)';
const MAP_NOTE = 'đề xuất của agent — chờ Sản xuất duyệt';

function skuParams(s: Obj, source: string): unknown[] {
  const v: Obj = {
    sku_key: s.sku_key,
    name: s.name,
    category: s.category,
    pack_spec: s.pack_spec ?? null,
    receipt_no: s.receipt_no ?? null,
    receipt_date: s.receipt_date ?? null,
    xnqc_status: getOr(s, 'xnqc_status', 'none'),
    self_declaration_ok: s.self_declaration_ok ?? null,
    allowed_channels: [...((getOr(s, 'allowed_channels', []) as string[]) ?? [])],
    shopee_item_id: s.shopee_item_id ?? null,
    note: s.note ?? null,
    source,
  };
  return SKU_ALL.map((c) => v[c]);
}

export type LoadStats = {
  sku_changed: number;
  map_changed: number;
  price_inserted: number;
  price_closed: number;
  price_same: number;
};

/** Upsert golden (doc ĐÃ validate + `loadProblems` rỗng). Không commit — caller giữ giao dịch. */
export async function load(db: Db, doc: Doc, source = 'golden_skus.json'): Promise<LoadStats> {
  const stats: LoadStats = {
    sku_changed: 0,
    map_changed: 0,
    price_inserted: 0,
    price_closed: 0,
    price_same: 0,
  };
  for (const s of doc.skus as Obj[]) {
    stats.sku_changed += (await db.query(SKU_SQL, skuParams(s, source))).rowCount ?? 0;
    for (const pid of getOr(s, 'product_ids', []) as string[]) {
      stats.map_changed +=
        (await db.query(MAP_SQL, [pid, s.sku_key, MAP_NOTE, source])).rowCount ?? 0;
    }
    for (const [ch, kp] of Object.entries(getOr(s, 'prices', {}) as Obj)) {
      for (const kind of KINDS) {
        if (!Object.hasOwn(kp as Obj, kind)) continue;
        const price = (kp as Obj)[kind] as number;
        const row = (
          await db.query(
            'select id, price_vnd from price_list where sku_key = $1 and channel = $2 and kind = $3' +
              ' and program_id is null and valid_to is null',
            [s.sku_key, ch, kind],
          )
        ).rows[0];
        if (row && String(row.price_vnd) === String(price)) {
          stats.price_same += 1;
          continue;
        }
        if (row) {
          await db.query(`update price_list set valid_to = ${TODAY_VN} where id = $1`, [row.id]);
          stats.price_closed += 1;
        }
        await db.query(
          'insert into price_list (sku_key, channel, kind, price_vnd, valid_from)' +
            ` values ($1, $2, $3, $4, ${TODAY_VN})`,
          [s.sku_key, ch, kind, price],
        );
        stats.price_inserted += 1;
      }
    }
  }
  return stats;
}

/**
 * Dựng lại phiếu lệch từ DB. Upsert: detail/updated_at đổi, status/resolved_by KHÔNG đụng. Xóa phiếu
 * `pending` của loader mà điều kiện hết đúng. Chỉ ĐỌC products. → {kind: số phiếu}.
 */
export async function applyDiscrepancies(db: Db): Promise<Record<string, number>> {
  const skus = (
    await db.query<SkuInfo>(
      'select sku_key, name, category, pack_spec, shopee_item_id, allowed_channels from sku_master order by sku_key',
    )
  ).rows;
  const prices: Prices = {};
  for (const r of (
    await db.query(
      'select sku_key, channel, kind, price_vnd from price_list where valid_to is null and program_id is null',
    )
  ).rows) {
    prices[r.sku_key] ??= {};
    const byCh = prices[r.sku_key] as Prices[string];
    byCh[r.channel] ??= {};
    (byCh[r.channel] as Record<string, number>)[r.kind] = Number(r.price_vnd);
  }
  const maps = new Map<string, string>();
  for (const r of (await db.query('select product_id, sku_key from sku_map')).rows) {
    maps.set(r.product_id, r.sku_key);
  }
  const products = (
    await db.query(
      // v15.5: sản phẩm ngừng niêm yết (retired_at) không còn là "giá web" để đối chiếu.
      'select id, name, price_vnd from products where retired_at is null order by id',
    )
  ).rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    price_vnd: r.price_vnd === null ? null : Number(r.price_vnd),
  }));
  const tickets = buildDiscrepancies(skus, prices, maps, products);
  for (const t of tickets) {
    await db.query(
      'insert into golden_discrepancies (kind, sku_key, product_id, detail, source) values ($1, $2, $3, $4::jsonb, $5)' +
        " on conflict (kind, (coalesce(sku_key, '')), (coalesce(product_id, ''))) do update set" +
        ' detail = excluded.detail, updated_at = now()' +
        ' where golden_discrepancies.detail is distinct from excluded.detail',
      [t.kind, t.sku_key, t.product_id, JSON.stringify(t.detail), DISC_SOURCE],
    );
  }
  await db.query(
    "delete from golden_discrepancies d where d.status = 'pending'" +
      ' and d.source = $1 and not exists (select 1 from' +
      ' unnest($2::text[], $3::text[], $4::text[]) as k(kind, sku, pid)' +
      " where k.kind = d.kind and k.sku = coalesce(d.sku_key, '')" +
      " and k.pid = coalesce(d.product_id, ''))",
    [
      DISC_SOURCE,
      tickets.map((t) => t.kind),
      tickets.map((t) => t.sku_key ?? ''),
      tickets.map((t) => t.product_id ?? ''),
    ],
  );
  const counts: Record<string, number> = {};
  for (const t of tickets) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  return counts;
}

/**
 * NGƯỜI thật duyệt 1 dòng giá → [ok, thông điệp]. Không commit (caller commit). Từ chối: id không
 * tồn tại / đã duyệt / đã đóng valid_to. v15.4 (P10.1): ghi qua function SECURITY DEFINER
 * `approve_price_human` — danh tính theo login (`human_actor`, khối sales), không UPDATE thẳng.
 */
export async function approvePrice(
  db: Db,
  priceId: bigint,
  by: string,
  env: Record<string, string | undefined> = process.env,
): Promise<[boolean, string]> {
  // `$1::numeric`: id ngoài dải bigint (Python int) → "không có dòng giá" như psycopg, không lỗi DB.
  const row = (
    await db.query(
      'select sku_key, channel, kind, price_vnd, approved_by, valid_to::text as valid_to' +
        ' from price_list where id = $1::numeric',
      [String(priceId)],
    )
  ).rows[0];
  if (!row) return [false, `không có dòng giá id=${priceId}`];
  if (row.approved_by !== null) return [false, `id=${priceId} đã được duyệt trước đó`];
  if (row.valid_to !== null) return [false, `id=${priceId} đã đóng (valid_to=${row.valid_to})`];
  try {
    // function nguyên tử; lỗi → caller rollback (không commit)
    await callHuman(db, 'select approve_price_human($1::bigint, $2)', [String(priceId), by], {
      by,
      block: 'sales',
      action: 'approve_price',
      objectType: 'price_list',
      objectId: String(priceId),
      env,
    });
  } catch (e) {
    if (e instanceof HumanDenied) return [false, `DB từ chối: ${e.message}`];
    if (e instanceof HumanError) return [false, `id=${priceId} vừa đổi trạng thái — thử lại`];
    throw e;
  }
  return [
    true,
    `đã duyệt id=${priceId} ${row.sku_key} ${row.channel} ${row.kind} ${row.price_vnd} VND`,
  ];
}

/** `--report`: phiếu lệch pending (giá trị theo nguồn) + giá chờ duyệt. Chỉ đọc. */
export async function report(db: Db, log: (s: string) => void = console.log): Promise<void> {
  const rows = (
    await db.query(
      'select id, kind, sku_key, product_id, detail from golden_discrepancies' +
        " where status = 'pending' order by kind, sku_key nulls first, product_id",
    )
  ).rows;
  log(`[report] ${rows.length} phiếu lệch pending (giá trị theo nguồn, agent không chọn):`);
  for (const r of rows) {
    log(
      `  #${r.id} ${r.kind} sku=${pyStr(r.sku_key)} product=${pyStr(r.product_id)} ${pyDumps(r.detail)}`,
    );
  }
  const prices = (
    await db.query(
      'select id, sku_key, channel, kind, price_vnd from price_list' +
        ' where approved_by is null and valid_to is null order by sku_key, channel, kind',
    )
  ).rows;
  log(
    `[report] ${prices.length} dòng giá chờ GĐ bán hàng duyệt (--approve-price <id> --by <tên>):`,
  );
  for (const p of prices) log(`  id=${p.id} ${p.sku_key} ${p.channel} ${p.kind} ${p.price_vnd}`);
}
