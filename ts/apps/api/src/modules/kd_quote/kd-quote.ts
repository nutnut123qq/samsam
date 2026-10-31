import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { addDays, dmy, parseDay } from '@samsam/core/ops/period';
import { squash } from '@samsam/core/ops/py';
import {
  isDict,
  isPyInt,
  PyReadError,
  parsePyJson,
  pyOsName,
  readUtf8Sig,
} from '@samsam/core/ops/py-json';
import { oneline } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import {
  checkPublish,
  type ReadinessMap,
  readinessKey,
  readinessOf,
} from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { PII_RE } from '@samsam/core/security/pii';
import { casefold, pyStrip, S, search } from '@samsam/core/security/py';
import { GOLDEN_FILE, readGolden } from '../channels/b2b-form.service.js';
import { canonical, isoDay, pyListRepr, pySortedStr } from './py.js';

// Port `agents/kd_quote.py` (v8.2 KD-A3, WP11) — phần THUẦN: ma trận báo giá GIẢ ĐỊNH → định giá +
// phân loại TẤT ĐỊNH → báo giá markdown/HTML in được → cổng tài liệu đối ngoại. Text báo giá do
// TEMPLATE + số do code tính — KHÔNG LLM (module không import AI Gateway) → cổng `checkPublish(...,
// isAi: false)`. Báo giá không chứa tên/SĐT/email người liên hệ, không claim sức khỏe.

export type Dict = Record<string, unknown>;
export const MATRIX_FILE = dataPath('b2b_pricing.json');
export const RULES_FILE = dataPath('guardrail_rules.json');
export { GOLDEN_FILE, readGolden };
export const BLOCK = 'sales';
export const OT_MATRIX = 'b2b_quote_matrix';
export const OT_QUOTE = 'b2b_quote';
export const OT_MARGIN = 'b2b_margin_review';
export const QUOTE_TYPES = [OT_QUOTE, OT_MATRIX];
export const AGENT = 'agent:kd_quote';
export const QA_SUITE = 'kd_a3';
export const MAX_QTY = 100_000;
export const MAX_LINES = 10;
export const MAX_DISCOUNT = 50;
export const MAX_SEND_BYTES = 2 * 1024 * 1024;
export const CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot']; // golden_store
export const KINDS = ['floor', 'list', 'promo'];
export const REASONS = [
  'ma_tran_chua_xac_nhan',
  'ngoai_ma_tran',
  'ngoai_bac_so_luong',
  'chiet_khau_vuot',
  'duoi_gia_san',
  'thieu_gia_niem_yet',
  'thieu_gia_von_duyet',
  'thieu_chi_phi_bao_bi',
  'bien_duoi_nguong',
  'tpbvsk_chua_xnqc',
];
export const PROBLEMS = [
  'ruou_khong_bao_gia',
  'ma_khong_ton_tai',
  'so_luong_khong_hop_le',
  'ma_tran_loi',
];
export const FINANCE_REASONS = ['bien_duoi_nguong', 'thieu_gia_von_duyet'];
export const ORG_LABELS: Record<string, string> = {
  doanh_nghiep: 'Doanh nghiệp',
  khach_san: 'Khách sạn',
  su_kien_hoi_nghi: 'Sự kiện – hội nghị',
  hiep_hoi: 'Hiệp hội',
  co_quan: 'Cơ quan',
  khac: 'Khác',
};
export const FOOTER = 'Báo giá chỉ có hiệu lực khi GĐ bán hàng ký — hệ thống không tự gửi.';
export const TERMS = 'Giá GIẢ ĐỊNH đã gồm VAT, chưa gồm vận chuyển — tài chính chốt trước khi ký.';
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMG_RE = /^!\[([^\]]{0,80})\]\((packshots\/[a-z0-9]+(?:-[a-z0-9]+)*\.png)\)$/u;

// ------------------------------------------------------------ tiện ích thuần
export const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  isPyInt(v) && lo <= v && v <= hi;

/** Tiền VND kiểu Python `f"{n:,}".replace(",", ".") + "đ"`; null → "—". */
export function vnd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+$)/g, '.');
  return `${n < 0 ? '-' : ''}${s}đ`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Ô markdown 1 dòng: gom khoảng trắng, escape `|`. */
export function md(s: unknown): string {
  const t = s === null || s === undefined || s === '' || s === 0 || s === false ? '' : String(s);
  return squash(t).replaceAll('|', '\\|') || '—';
}

/** golden doc `{"skus": [...]}` → Map sku_key → sku. */
export function gidx(golden: unknown): Map<string, Dict> {
  const skus = isDict(golden) ? golden.skus : null;
  const m = new Map<string, Dict>();
  for (const s of Array.isArray(skus) ? skus : [])
    if (isDict(s) && typeof s.sku_key === 'string') m.set(s.sku_key, s);
  return m;
}

export function cidx(combos: unknown): Map<string, Dict> {
  const m = new Map<string, Dict>();
  for (const c of Array.isArray(combos) ? combos : [])
    if (isDict(c) && typeof c.combo_key === 'string') m.set(c.combo_key, c);
  return m;
}

const nameOr = (s: Dict, k: string) => (s.name ? String(s.name) : k);
const strOr = (v: unknown) => (typeof v === 'string' ? v : '');

/** SKU `alcohol` / tên nhắc rượu / combo có thành phần rượu / chính key nhắc rượu ("ruou-..."). */
export function isAlcoholKey(
  key: unknown,
  g: Map<string, Dict>,
  c: Map<string, Dict>,
  depth = 0,
): boolean {
  if (typeof key !== 'string') return false;
  if (isAlcohol(key.replaceAll('-', ' '))) return true;
  const s = g.get(key);
  if (s !== undefined) return s.category === 'alcohol' || isAlcohol(strOr(s.name));
  const cb = c.get(key);
  if (cb !== undefined && depth < 2) {
    return (
      isAlcohol(strOr(cb.name)) ||
      (Array.isArray(cb.items) ? cb.items : []).some(
        (it) => isDict(it) && isAlcoholKey(it.sku_key, g, c, depth + 1),
      )
    );
  }
  return false;
}

export const tpUnapproved = (s: Dict | undefined): boolean =>
  s !== undefined && s.category === 'tpbvsk' && s.xnqc_status !== 'approved';

// -------------------------------------------------------------- ma trận
/** → [doc, null] | [null, lý do]. Không ném. Số thực giữ dạng float (Python phân biệt 5 và 5.0). */
export function readMatrix(path: string = MATRIX_FILE): [Dict | null, string | null] {
  const name = basename(path);
  let doc: unknown;
  try {
    if (statSync(path).size > 1_000_000) return [null, `${name} quá lớn`];
    doc = parsePyJson(readUtf8Sig(path));
  } catch (e) {
    const t =
      e instanceof PyReadError
        ? e.pyType
        : e instanceof SyntaxError
          ? 'JSONDecodeError'
          : pyOsName(e);
    return [null, t === 'FileNotFoundError' ? `thiếu file ${name}` : `${name} hỏng (${t})`];
  }
  if (!isDict(doc)) return [null, `${name}: root phải là object`];
  return [doc, null];
}

export const confirmed = (v: unknown): boolean =>
  isDict(v) && typeof v.by === 'string' && pyStrip(v.by) !== '' && isoDay(v.at) !== null;

export const matrixSha = (matrix: Dict): string => sha256(canonical(matrix));

const pyTuple = (xs: string[]) => `(${xs.map((x) => `'${x}'`).join(', ')})`;

/** → list lỗi (rỗng = hợp lệ). THUẦN trừ đọc golden file khi `golden` undefined. Key rượu → lỗi. */
export function validateMatrix(doc: unknown, golden?: unknown, combos?: unknown): string[] {
  if (!isDict(doc)) return ['ma trận không phải object JSON'];
  const errs: string[] = [];
  if (typeof doc.status !== 'string' || !pyStrip(doc.status)) {
    errs.push("thiếu 'status' (GIẢ ĐỊNH/đã chốt)");
  }
  if (!isIntIn(doc.version, 1, 10 ** 6)) errs.push("'version' phải số nguyên ≥ 1");
  for (const k of ['finance_confirmed', 'sales_confirmed']) {
    if (!Object.hasOwn(doc, k)) errs.push(`thiếu '${k}' (null = chưa xác nhận)`);
    else if (doc[k] !== null && !confirmed(doc[k])) {
      errs.push(`'${k}' phải null hoặc {by: tên người, at: YYYY-MM-DD}`);
    }
  }
  const base = doc.base;
  if (
    !(
      isDict(base) &&
      CHANNELS.includes(base.channel as string) &&
      KINDS.includes(base.kind as string)
    )
  ) {
    errs.push(`'base' phải {channel ∈ ${pyTuple(CHANNELS)}, kind ∈ ${pyTuple(KINDS)}}`);
  }
  if (!isIntIn(doc.min_margin_pct, 0, 90)) errs.push("'min_margin_pct' phải số nguyên 0..90");
  if (!isIntIn(doc.rounding_vnd, 1, 1_000_000)) {
    errs.push("'rounding_vnd' phải số nguyên 1..1.000.000");
  }
  if (!isIntIn(doc.quote_valid_days, 1, 90)) errs.push("'quote_valid_days' phải số nguyên 1..90");
  const tiers = doc.tiers;
  if (!Array.isArray(tiers) || !tiers.length) errs.push("'tiers' phải list khác rỗng");
  else {
    let prev: Tier | null = null;
    for (const [i, t] of (tiers as unknown[]).entries()) {
      if (
        !(
          isDict(t) &&
          isIntIn(t.min_qty, 1, MAX_QTY) &&
          isIntIn(t.max_qty, 1, MAX_QTY) &&
          t.max_qty >= t.min_qty
        )
      ) {
        errs.push(`tiers[${i}]: min_qty/max_qty nguyên 1..${MAX_QTY}, max ≥ min`);
        prev = null;
        continue;
      }
      if (!isIntIn(t.discount_pct, 0, MAX_DISCOUNT)) {
        errs.push(`tiers[${i}]: discount_pct nguyên 0..${MAX_DISCOUNT}`);
      }
      if (prev !== null && t.min_qty !== prev.max_qty + 1) {
        errs.push(`tiers[${i}]: phải liền ngay sau bậc trước (không chồng, không hở)`);
      }
      prev = t as Tier;
    }
  }
  const items = doc.items;
  if (!isDict(items) || !Object.keys(items).length) {
    errs.push("'items' phải object khác rỗng");
    return errs;
  }
  const gold = golden === undefined || golden === null ? readGolden(GOLDEN_FILE)[0] : golden;
  const g = gidx(gold ?? {});
  const c = cidx(combos);
  for (const [k, v] of Object.entries(items)) {
    if (!SLUG_RE.test(k)) {
      errs.push(`items: key '${oneline(k, 40)}' không phải slug`);
      continue;
    }
    if (isAlcoholKey(k, g, c)) errs.push(`items[${k}]: rượu không được vào ma trận báo giá`);
    if (!(isDict(v) && isIntIn(v.max_discount_pct, 0, MAX_DISCOUNT))) {
      errs.push(`items[${k}]: max_discount_pct nguyên 0..${MAX_DISCOUNT}`);
      continue;
    }
    const pk = v.packaging_cost_vnd;
    if (pk !== null && pk !== undefined && !isIntIn(pk, 0, 10 ** 9)) {
      errs.push(`items[${k}]: packaging_cost_vnd null hoặc nguyên ≥ 0`);
    }
    if (Object.keys(v).some((x) => x !== 'max_discount_pct' && x !== 'packaging_cost_vnd')) {
      errs.push(`items[${k}]: key lạ`);
    }
  }
  return errs;
}

type Tier = { min_qty: number; max_qty: number; discount_pct: number };

function tierOf(matrix: Dict, qty: number): Tier | null {
  for (const t of (matrix.tiers as Tier[] | undefined) ?? []) {
    if (t.min_qty <= qty && qty <= t.max_qty) return t;
  }
  return null;
}

// ---------------------------------------------------------------- định giá
export type Part = [unknown, number];

/** SKU → [[key, 1]]; combo → [[sku, qty]]; không thấy → null. */
export function partsOf(key: string, g: Map<string, Dict>, c: Map<string, Dict>): Part[] | null {
  if (g.has(key)) return [[key, 1]];
  const cb = c.get(key);
  if (cb === undefined) return null;
  if (!Array.isArray(cb.items)) return null; // Python: chuỗi/dict lặp ra phần tử không phải dict → None
  const out: Part[] = [];
  for (const it of cb.items) {
    if (!(isDict(it) && isIntIn(it.qty, 1, 10 ** 6))) return null;
    out.push([it.sku_key, it.qty]);
  }
  return out.length ? out : null;
}

// Tiền tính bằng number: giá ≤ 1e12 × SL ≤ 1e5 có thể vượt 2^53 → vượt thì DỪNG (TS chặt hơn
// Python — số tiền phi thực tế, không tính sai lặng lẽ).
function safe(n: number): number {
  if (!Number.isSafeInteger(n * 1000)) throw new RangeError('số tiền vượt giới hạn tính chính xác');
  return n;
}

export function sumPrice(
  parts: Part[],
  g: Map<string, Dict>,
  channel: unknown,
  kind: unknown,
): number | null {
  let total = 0;
  for (const [sku, q] of parts) {
    const prices = g.get(sku as string)?.prices;
    const p = isDict(prices) ? prices[channel as string] : undefined;
    const v = isDict(p) ? p[kind as string] : undefined;
    if (!isIntIn(v, 1, 10 ** 12)) return null;
    total = safe(total + v * q);
  }
  return total;
}

export type Line = {
  key: string;
  kind: 'sku' | 'combo';
  name: string;
  spec: string;
  qty: number;
  list_unit: number | null;
  floor_unit: number | null;
  discount_pct: number;
  unit: number | null;
  amount: number | null;
  tier: Tier | null;
  in_matrix: boolean;
  parts: Part[];
  tp: boolean;
  reasons: string[];
  cogs_unit?: number | null;
  cogs?: number | null;
};

/** → [lines, problems]. Mỗi dòng: key, kind, name, spec, qty, giá niêm yết/sàn, CK, đơn giá, thành
 * tiền, bậc, in_matrix, parts, tp (có TPBVSK chưa XNQC), reasons (mã cấp dòng trừ giá vốn/biên). */
export function priceLines(
  items: unknown,
  matrix: Dict,
  golden: unknown,
  combos: unknown,
  discount: number | null = null,
): [Line[], string[]] {
  const g = gidx(golden);
  const c = cidx(combos);
  const problems: string[] = [];
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_LINES) {
    return [[], ['so_luong_khong_hop_le']];
  }
  const base = isDict(matrix.base) ? matrix.base : {};
  const ch = base.channel;
  const kind = base.kind;
  const r = (matrix.rounding_vnd as number) || 1;
  const mitems = (isDict(matrix.items) ? matrix.items : {}) as Dict;
  const lines: Line[] = [];
  for (const it of items) {
    const key = isDict(it) ? it.key : undefined;
    const qty = isDict(it) ? it.qty : undefined;
    if (!isIntIn(qty, 1, MAX_QTY)) {
      problems.push('so_luong_khong_hop_le');
      continue;
    }
    if (isAlcoholKey(key, g, c)) {
      problems.push('ruou_khong_bao_gia');
      continue;
    }
    const parts = typeof key === 'string' ? partsOf(key, g, c) : null;
    if (parts === null || parts.some(([sku]) => !g.has(sku as string))) {
      problems.push('ma_khong_ton_tai');
      continue;
    }
    const k = key as string;
    const reasons: string[] = [];
    const specM = Object.hasOwn(mitems, k) && mitems[k] !== null ? (mitems[k] as Dict) : null;
    if (specM === null) reasons.push('ngoai_ma_tran');
    const t = tierOf(matrix, qty);
    if (t === null) reasons.push('ngoai_bac_so_luong');
    const tierCk = t ? t.discount_pct : 0;
    const ck = discount === null ? tierCk : discount;
    if (ck > tierCk || (specM !== null && ck > ((specM.max_discount_pct as number) ?? 0))) {
      reasons.push('chiet_khau_vuot');
    }
    const lst = sumPrice(parts, g, ch, kind);
    const flr = sumPrice(parts, g, ch, 'floor');
    let unit: number | null = null;
    let amount: number | null = null;
    if (lst === null || flr === null) reasons.push('thieu_gia_niem_yet');
    else {
      unit = Number((BigInt(lst) * BigInt(100 - ck)) / BigInt(100 * r)) * r;
      amount = safe(unit * qty);
      if (unit < flr) reasons.push('duoi_gia_san');
    }
    const tp = parts.some(([sku]) => tpUnapproved(g.get(sku as string)));
    if (tp) reasons.push('tpbvsk_chua_xnqc');
    let name: string;
    let spec: unknown;
    if (g.has(k)) {
      const s = g.get(k) as Dict;
      name = nameOr(s, k);
      spec = s.pack_spec;
    } else {
      name = nameOr(c.get(k) as Dict, k);
      spec = parts
        .map(([s, q]) => `${nameOr(g.get(s as string) as Dict, s as string)} ×${q}`)
        .join(' + ');
    }
    lines.push({
      key: k,
      kind: g.has(k) ? 'sku' : 'combo',
      name,
      spec: spec ? String(spec) : '—',
      qty,
      list_unit: lst,
      floor_unit: flr,
      discount_pct: ck,
      unit,
      amount,
      tier: t,
      in_matrix: specM !== null,
      parts,
      tp,
      reasons,
    });
  }
  return [lines, problems];
}

export type CogsVersion = {
  id: number;
  sku_key: string;
  cost_vnd: number;
  valid_from: string;
  approved_by: string | null;
};

/** `fp_pnl.cogs_at`: giá vốn ĐÃ duyệt hiệu lực ngày `day` (mới nhất theo valid_from, id) | null. */
export function cogsAt(versions: CogsVersion[], sku: unknown, day: string): number | null {
  let best: [string, number, number] | null = null;
  for (const v of versions) {
    if (v.sku_key !== sku || !pyStrip(v.approved_by ?? '')) continue;
    if (v.valid_from > day) continue;
    if (best === null || v.valid_from > best[0] || (v.valid_from === best[0] && v.id > best[1])) {
      best = [v.valid_from, v.id, v.cost_vnd];
    }
  }
  return best === null ? null : best[2];
}

/** Python `Decimal(n) * 100 / Decimal(d)` quantize 0.1 ROUND_HALF_UP → chuỗi `str(Decimal)`. */
function marginStr(n: number, d: number): string {
  const num = BigInt(n) * 1000n;
  const den = BigInt(d);
  const neg = num < 0n !== den < 0n && num !== 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  const s = q.toString().padStart(2, '0');
  return `${neg ? '-' : ''}${s.slice(0, -1)}.${s.slice(-1)}`;
}

export type Classified = {
  lines: Line[];
  total: number | null;
  cogs_total: number | null;
  margin_pct: string | null;
  within_matrix: boolean;
  reasons: string[];
  problems: string[];
  matrix_version: number | null;
  matrix_sha: string | null;
  matrix_errors?: string[];
};

/** Định giá + phân loại TẤT ĐỊNH (không DB/mạng/LLM). `margin_pct` = chuỗi Decimal 1 chữ số. */
export function classify(
  items: unknown,
  matrix: Dict,
  golden: unknown,
  combos: unknown,
  cogsVersions: CogsVersion[],
  day: string,
  discount: number | null = null,
): Classified {
  const mxErrs = validateMatrix(matrix, golden, combos);
  const out: Classified = {
    lines: [],
    total: null,
    cogs_total: null,
    margin_pct: null,
    within_matrix: false,
    reasons: [],
    problems: [],
    matrix_version: null,
    matrix_sha: null,
  };
  if (mxErrs.length) return { ...out, problems: ['ma_tran_loi'], matrix_errors: mxErrs };
  out.matrix_version = matrix.version as number;
  out.matrix_sha = matrixSha(matrix);
  if (discount !== null && !isIntIn(discount, 0, 100)) {
    throw new RangeError('discount phải số nguyên 0..100');
  }
  const [lines, problems] = priceLines(items, matrix, golden, combos, discount);
  const reasons = new Set<string>();
  if (!(confirmed(matrix.finance_confirmed) && confirmed(matrix.sales_confirmed))) {
    reasons.add('ma_tran_chua_xac_nhan');
  }
  const mitems = matrix.items as Dict;
  let cogsOk = true;
  for (const ln of lines) {
    for (const r of ln.reasons) reasons.add(r);
    let cost: number | null = 0;
    for (const [sku, q] of ln.parts) {
      const v = cogsAt(cogsVersions, sku, day);
      if (v === null) {
        cost = null;
        reasons.add('thieu_gia_von_duyet');
        break;
      }
      cost = safe(cost + v * q);
    }
    if (ln.kind === 'combo') {
      const spec = mitems[ln.key];
      const pk = isDict(spec) ? spec.packaging_cost_vnd : undefined;
      if (pk === null || pk === undefined) {
        reasons.add('thieu_chi_phi_bao_bi');
        cost = null;
      } else if (cost !== null) cost += pk as number;
    }
    ln.cogs_unit = cost;
    ln.cogs = cost === null ? null : safe(cost * ln.qty);
    if (ln.cogs === null) cogsOk = false;
  }
  let total: number | null = null;
  if (lines.length && lines.every((ln) => ln.amount !== null)) {
    total = safe(lines.reduce((a, ln) => a + (ln.amount as number), 0));
  }
  const cogsTotal =
    lines.length && cogsOk ? safe(lines.reduce((a, ln) => a + (ln.cogs as number), 0)) : null;
  let margin: string | null = null;
  if (total && cogsTotal !== null) {
    margin = marginStr(total - cogsTotal, total);
    // So biên CHƯA làm tròn (số nguyên, exact): 29.96% không được làm tròn lên 30.0 rồi lọt ngưỡng.
    if (
      BigInt(total - cogsTotal) * 100n <
      BigInt(matrix.min_margin_pct as number) * BigInt(total)
    ) {
      reasons.add('bien_duoi_nguong');
    }
  }
  const pset = new Set(problems);
  out.lines = lines;
  out.total = total;
  out.cogs_total = cogsTotal;
  out.margin_pct = margin;
  out.reasons = REASONS.filter((r) => reasons.has(r));
  out.problems = PROBLEMS.filter((p) => pset.has(p));
  out.within_matrix = !out.reasons.length && !out.problems.length;
  return out;
}

// ------------------------------------------------------------- báo giá
export function disclaimer(): string {
  const doc = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(RULES_FILE)),
  );
  return String(doc.disclaimer.canonical);
}

export function quoteNo(requestId: unknown, result: Classified, day: string): string {
  const key = {
    lines: result.lines.map((ln) => [ln.key, ln.qty, ln.discount_pct, ln.unit, ln.amount]),
    matrix_version: result.matrix_version,
    matrix_sha: result.matrix_sha,
    day,
  };
  return `BG-${day.replaceAll('-', '')}-${BigInt(String(requestId))}-${sha256(canonical(key)).slice(0, 8)}`;
}

export type QuoteRequest = {
  id: unknown;
  org_name?: unknown;
  org_type?: unknown;
  region?: unknown;
  need_by?: unknown;
  items?: unknown;
} & Dict;
export type Built = {
  quote_no: string | null;
  payload: string;
  internal: string;
  problems: string[];
};

/** → {quote_no, payload (BẢN GỬI — chuỗi được hash), internal (KHÔNG gửi khách), problems}.
 * Không tên/SĐT/email người liên hệ (không đọc cột liên hệ). `need_by` = chuỗi 'YYYY-MM-DD'. */
export function buildQuote(
  request: QuoteRequest,
  result: Classified,
  golden: unknown,
  day: string,
  matrix: Dict | null = null,
): Built {
  if (result.problems.length) {
    return { quote_no: null, payload: '', internal: '', problems: [...result.problems] };
  }
  const validDays = (matrix?.quote_valid_days as number) || 14;
  const qno = quoteNo(request.id, result, day);
  const orgT = ORG_LABELS[request.org_type as string] ?? 'Khác';
  const L = [
    `# Báo giá quà Tết — ${qno}`,
    '',
    `- Ngày báo giá: ${dmy(day)}`,
    `- Hiệu lực đến: ${dmy(addDays(day, validDays))}`,
    `- Kính gửi: ${md(request.org_name)} (${orgT}) — ${md(request.region)}`,
  ];
  const nb = request.need_by;
  if (typeof nb === 'string' && parseDay(nb) !== null) L.push(`- Ngày cần hàng: ${dmy(nb)}`);
  L.push(
    '',
    '| # | Sản phẩm | Quy cách | SL | Giá niêm yết | CK % | Đơn giá | Thành tiền |',
    '|---|---|---|---|---|---|---|---|',
  );
  result.lines.forEach((ln, i) => {
    L.push(
      `| ${i + 1} | ${md(ln.name)} | ${md(ln.spec)} | ${ln.qty} | ${vnd(ln.list_unit)} | ${ln.discount_pct} | ${vnd(ln.unit)} | ${vnd(ln.amount)} |`,
    );
  });
  L.push(
    '',
    `**Tổng cộng: ${vnd(result.total)}**`,
    '',
    'Điều khoản:',
    '',
    `- ${TERMS}`,
    `- Báo giá có hiệu lực ${validDays} ngày kể từ ngày báo giá.`,
    '- Số lượng và ngày giao theo xác nhận của GĐ bán hàng.',
  );
  const g = gidx(golden);
  if (
    result.lines.some((ln) => ln.parts.some(([s]) => g.get(s as string)?.category === 'tpbvsk'))
  ) {
    L.push('', `${disclaimer()}.`);
  }
  L.push('', FOOTER, '');
  const payload = L.join('\n');
  const m = result.margin_pct;
  const lane = result.within_matrix ? 'trong ma trận' : 'per_item';
  const margin = m === null ? 'chưa tính được' : `${m}%`;
  const mm = matrix && Object.hasOwn(matrix, 'min_margin_pct') ? matrix.min_margin_pct : '?';
  const inner = [
    `# Nội bộ — báo giá ${qno} (KHÔNG gửi khách)`,
    '',
    `- Yêu cầu: YC-${BigInt(String(request.id))}`,
    `- Phân loại: ${lane}`,
    `- Lý do: ${result.reasons.join(', ') || '(không)'}`,
    `- Tổng: ${vnd(result.total)} · Giá vốn đã duyệt: ${vnd(result.cogs_total)} · Biên: ${margin} (ngưỡng ${mm}%)`,
    `- Ma trận v${result.matrix_version} sha ${(result.matrix_sha ?? '').slice(0, 16)}`,
    '',
    '| # | Mã | SL | Đơn giá | Thành tiền | Giá vốn dòng | Lý do dòng |',
    '|---|---|---|---|---|---|---|',
  ];
  result.lines.forEach((ln, i) => {
    inner.push(
      `| ${i + 1} | ${ln.key} | ${ln.qty} | ${vnd(ln.unit)} | ${vnd(ln.amount)} | ${vnd(ln.cogs)} | ${ln.reasons.join(', ') || '—'} |`,
    );
  });
  inner.push('', 'Bản nội bộ cho tài chính/GĐ bán hàng — không đính kèm báo giá gửi khách.', '');
  return { quote_no: qno, payload, internal: inner.join('\n'), problems: [] };
}

/** Tên + key SKU rượu (để quét chuỗi đối ngoại). */
export function alcoholNames(golden: unknown): string[] {
  const out: string[] = [];
  for (const [k, s] of gidx(golden)) {
    if (s.category === 'alcohol' || isAlcohol(strOr(s.name))) out.push(k, nameOr(s, k));
  }
  return out;
}

export type PriceCell = { price: number; approved: boolean; id: number };
/** Khóa `readinessKey(sku, kênh)` → {kind: PriceCell} (`kd_listing.golden_prices`). */
export type GoldenPrices = Map<string, Record<string, PriceCell>>;

/** r12 L2: bản golden mà `prices` CHỈ còn giá `price_list` ĐÃ duyệt hiệu lực ngày lập — không
 * fallback giá trong data/golden_skus.json. Thiếu giá đã duyệt → dòng `thieu_gia_niem_yet`. */
export function approvedGolden(golden: Dict, prices: GoldenPrices): Dict {
  const by = new Map<string, Record<string, Record<string, number>>>();
  for (const [key, kinds] of prices) {
    const [sku, ch] = key.split('\u0000') as [string, string];
    for (const [kind, v] of Object.entries(kinds)) {
      if (!v.approved) continue;
      if (!by.has(sku)) by.set(sku, {});
      const cs = by.get(sku) as Record<string, Record<string, number>>;
      cs[ch] ??= {};
      cs[ch][kind] = v.price;
    }
  }
  const skus = Array.isArray(golden.skus) ? golden.skus : [];
  return {
    ...golden,
    skus: skus.map((s) => (isDict(s) ? { ...s, prices: by.get(s.sku_key as string) ?? {} } : s)),
  };
}

/** (sku, kênh) → mức readiness tính từ golden ĐANG dùng (cổng XNQC khớp dữ liệu báo giá/catalog). */
export function readinessMap(golden: unknown, channel = 'web'): ReadinessMap {
  return new Map(
    [...gidx(golden)].map(([k, s]) => [readinessKey(k, channel), readinessOf(s, channel)]),
  );
}

/** Cổng chung tài liệu đối ngoại (báo giá/catalog) → mã lỗi. `ids` = mã do CHÍNH hệ thống sinh (số
 * báo giá, sha ảnh) — bỏ ra trước khi quét PII (chuỗi hex/số của mã có thể giống mẫu SĐT). */
export function gateText(
  payload: string,
  excludedNames: unknown[],
  o: { contentType: string; readiness?: ReadinessMap | null; ids?: unknown[] },
): string[] {
  const errs: string[] = [];
  const g = checkPublish(payload, {
    channel: 'web',
    contentType: o.contentType,
    isAi: false,
    readiness: o.readiness ?? null,
  });
  if (g.ok !== true) {
    const codes = pySortedStr(new Set((g.violations ?? []).map((v) => String(v.code))));
    errs.push(...(codes.length ? codes : ['?']).map((c) => `guardrail:${c}`));
  }
  const low = casefold(payload);
  if (
    isAlcohol(payload) ||
    excludedNames.some((n) => typeof n === 'string' && n && low.includes(casefold(n)))
  ) {
    errs.push('ruou');
  }
  let scan = payload;
  for (const x of o.ids ?? []) if (typeof x === 'string' && x) scan = scan.replaceAll(x, ' ');
  if (search(PII_RE, scan)) errs.push('pii');
  return errs;
}

export const gateQuote = (
  payload: string,
  excludedNames: unknown[],
  readiness: ReadinessMap | null = null,
  ids: unknown[] = [],
): string[] => gateText(payload, excludedNames, { contentType: 'post', readiness, ids });

// --------------------------------------------------------------- HTML in
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^\n]+?)\*\*/gu, '<strong>$1</strong>')
    .replace(/`([^`]+)`/gu, '<code>$1</code>');
}

function cells(row: string): string[] {
  const parts = pyStrip(row).split(/(?<!\\)\|/);
  return parts.slice(1, -1).map((p) => pyStrip(p).replaceAll('\\|', '|'));
}

export function titleOf(payload: string): string {
  for (const ln of payload.split('\n')) if (ln.startsWith('# ')) return pyStrip(ln.slice(2));
  return 'Tài liệu';
}

const CSS =
  '@page { size: A4; margin: 15mm; }\n' +
  "body { font-family: 'Times New Roman', serif; font-size: 12pt; color: #000; background: #fff; max-width: 180mm; margin: 0 auto; }\n" +
  'h1 { font-size: 16pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }\n' +
  'table { border-collapse: collapse; width: 100%; margin: 6pt 0; }\n' +
  'th, td { border: 1px solid #444; padding: 3pt 5pt; text-align: left; vertical-align: top; }\n' +
  'img { max-width: 60mm; }\n' +
  '@media print { body { max-width: none; } }';
const HEAD_RE = /^(#{1,3}) ([^\n]+)$/u;
const SEP_ROW_RE = new RegExp(`^\\|[${S}:|-]+\\|$`, 'u');

/** Markdown TỐI THIỂU (đúng tập cú pháp payload tự sinh: #/##/###, `- `, bảng `|`, ảnh
 * `![](packshots/x.png)`, đoạn) → HTML A4 in được. TẤT ĐỊNH; mọi giá trị qua escape; không
 * `<script>`/tài nguyên ngoài (ảnh chỉ đường tương đối `packshots/<slug>.png`). */
export function renderHtml(payload: string, title: string | null = null): string {
  const t = title !== null ? title : titleOf(payload);
  const out = [
    '<!doctype html>',
    '<html lang="vi">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${esc(t)}</title>`,
    `<style>\n${CSS}\n</style>`,
    '</head>',
    '<body>',
  ];
  const lines = payload.split('\n');
  const n = lines.length;
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para.length = 0;
    }
  };
  while (i < n) {
    const s = pyStrip(lines[i] as string);
    const m = HEAD_RE.exec(s);
    const img = IMG_RE.exec(s);
    if (!s) {
      flush();
      i++;
    } else if (m) {
      flush();
      const lv = (m[1] as string).length;
      out.push(`<h${lv}>${inline(m[2] as string)}</h${lv}>`);
      i++;
    } else if (img) {
      flush();
      out.push(`<p><img src="${esc(img[2] as string)}" alt="${esc(img[1] as string)}"></p>`);
      i++;
    } else if (s.startsWith('|')) {
      flush();
      const rows: string[][] = [];
      while (i < n && pyStrip(lines[i] as string).startsWith('|')) {
        const r = pyStrip(lines[i] as string);
        if (!SEP_ROW_RE.test(r)) rows.push(cells(r));
        i++;
      }
      out.push('<table>');
      rows.forEach((cs, j) => {
        const tag = j === 0 ? 'th' : 'td';
        out.push(`<tr>${cs.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      });
      out.push('</table>');
    } else if (s.startsWith('- ')) {
      flush();
      out.push('<ul>');
      while (i < n && pyStrip(lines[i] as string).startsWith('- ')) {
        out.push(`<li>${inline(pyStrip(lines[i] as string).slice(2))}</li>`);
        i++;
      }
      out.push('</ul>');
    } else {
      para.push(s);
      i++;
    }
  }
  flush();
  out.push('</body>', '</html>', '');
  return out.join('\n');
}

/** `sorted(object_types)` của Python → `['a', 'b']`. */
export const typesRepr = (types: string[]): string => pyListRepr(pySortedStr(types));
