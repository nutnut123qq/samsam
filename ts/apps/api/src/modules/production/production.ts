import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { addDays, parseDay, vnDate } from '@samsam/core/ops/period';
import { isPyInt, PyFloat, pyLoads } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { cpLen, pyStr, pyStrip, splitlines } from '@samsam/core/security/py';
import {
  ALL_CHANNELS,
  CHANNELS,
  DATE_MAX,
  DATE_MIN,
  LEVELS,
  type Levels,
  MAX_WEEKS,
  OFFLINE,
  type ProjectRow,
  project,
  type Sku,
  weekStart,
} from '../garden_director/scenario.js';
import { clean } from '../market/table.js';
import {
  type GoldenMap,
  isoDay,
  pyOsName,
  SLUG_RE,
  STALE_NOTE,
  type Stock,
} from './inventory-csv.js';

// Port phần THUẦN của `pipelines/production.py` (v9.2 Sản xuất P1, WP13): SX-A3 phân bổ tồn, SX-A4
// BOM combo/hộp quà, SX-A5 hồ sơ lô, SX-A0 bản tin tuần/tháng cho GĐ sản xuất (+ v12.3 hàng cận hạn
// FEFO, đợt hợp đồng C10 tiến độ, C03 phiếu kiểm nghiệm). Agent CHỈ ĐỀ XUẤT: không chuyển kho, không
// sửa tồn, không đặt mua, không lệnh sản xuất, 0 lời gọi LLM. Nhu cầu = `scenario.project()` (engine
// kịch bản mùa DÙNG CHUNG) cộng theo tuần — không công thức riêng. Rượu: phân bổ 0 mọi kênh online
// (chốt chặn thứ 2, bất kể nhu cầu), combo có rượu chỉ kênh offline. Hàm nhận ngày làm tham số (không
// đọc đồng hồ). Ngày = chuỗi 'YYYY-MM-DD' (Python `date`); thời điểm = Date.

export const CONFIG_FILE = dataPath('production_config.json');
export const MAX_BY_LEN = 100; // golden_store.MAX_BY_LEN
export const MAX_NOTE_LEN = 500;
export const QTY_MAX = 2 * 10 ** 9;
export const MAX_SLA_HOURS = 24 * 365;
export const MAX_NEAR_DAYS = 3650;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ONLINE: readonly string[] = CHANNELS;
export const FEATURE_ALLOC = 'production-01';
export const FEATURE_NEAR = 'production-04.3';

export const DISCLAIMER =
  'Khoảng thấp/cơ sở/cao — KHÔNG phải doanh số cam kết; ĐỀ XUẤT chờ GĐ sản xuất duyệt — không tự chuyển kho';
export const NO_NEW_PRODUCTION = 'chỉ phân bổ tồn hiện có — không đề xuất sản xuất mới';
export const NOTE_NO_STOCK = 'chưa có số tồn — không kết luận thiếu';
export const NOTE_SPARE = 'dự phòng chưa phân bổ';
export const NOTE_ALCOHOL_ONLINE = 'rượu: chỉ kênh offline — đề xuất 0';
export const BUILDABLE_NOTE = 'tính trên tồn CHƯA trừ phân bổ — tham khảo';
export const ALLOC_TABLES = [
  'inventory_snapshots',
  'allocation_proposals',
  'bom_combos',
  'bom_items',
  'production_lots',
] as const;

// KHÁC Python có chủ đích (chặt hơn, liệt kê trong test): `$` của Python khớp cả trước '\n' cuối
// ("L-001\n" lọt `LOT_RE` rồi vào DB); TS từ chối.
const ID_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
export const RUN_RE = /^[0-9a-f]{12}$/;
export const LOT_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const LOT_RE_SRC = '^[A-Z0-9][A-Z0-9-]{2,31}$';
const LOT_KEYS = ['lot_code', 'sku_key', 'mfg_date', 'exp_date', 'qty', 'note'];
const COMBO_KEYS = ['combo_key', 'name', 'channels', 'items', 'note'];
const ITEM_KEYS = ['sku_key', 'qty'];
const DAY_MS = 86_400_000;

/** Config/dữ liệu sản xuất không dùng được — fail-closed (Python ProductionError(ValueError)). */
export class ProductionError extends RangeError {
  override name = 'ProductionError';
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
const has = (o: Dict, k: string): boolean => Object.hasOwn(o, k);
const get = (o: Dict, k: string): unknown => (has(o, k) ? o[k] : undefined);
/** Python `isinstance(v, int) and not isinstance(v, bool)`. */
export const isInt = (v: unknown): v is number => isPyInt(v);
/** Python `sorted()` cho chuỗi (theo code point). */
export function cmpCp(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}
/** (a - b).days của 2 ngày 'YYYY-MM-DD'. */
export const daysBetween = (a: string, b: string): number =>
  Math.round(((parseDay(a) as number) - (parseDay(b) as number)) / DAY_MS);

function isoIn(v: unknown, where: string): string {
  const d = typeof v === 'string' ? isoDay(v) : null;
  if (d === null) throw new ProductionError(`${where}: không phải ngày YYYY-MM-DD`);
  if (d < DATE_MIN || d > DATE_MAX) {
    throw new ProductionError(`${where}: phải trong ${DATE_MIN}..${DATE_MAX}`);
  }
  return d;
}

// Hằng NaN/Infinity/-Infinity đứng ở vị trí giá trị (Python `parse_constant` từ chối = ValueError).
const PY_CONST_RE = /([[:,]\s*)(-?Infinity|NaN)(?=\s*[,\]}])/g;

/** Python `json.loads(text, parse_constant=_reject_constant)` → giá trị (PyFloat cho số viết dạng
 * thực) | ném `[tên lỗi Python]`. shortcut: doc có CẢ hằng NaN lẫn lỗi cú pháp → luôn báo
 * JSONDecodeError (Python báo lỗi nào gặp trước) — chỉ khác tên lỗi trong thông điệp. */
function loadsStrict(text: string): unknown {
  try {
    return pyLoads(text);
  } catch {
    let constOnly = false;
    try {
      JSON.parse(text.replace(PY_CONST_RE, '$10'));
      constOnly = true;
    } catch {
      // lỗi cú pháp thật
    }
    throw new Error(constOnly ? 'ValueError' : 'JSONDecodeError');
  }
}

/**
 * `read_json`: đọc file JSON nguồn (config/BOM/lô). Mọi biến thể "không có dữ liệu" (thiếu / rỗng /
 * JSON hỏng / không phải object / `{}` / chỉ `_doc`) → ProductionError; caller dừng TRƯỚC khi connect.
 */
export function readJson(path: string, listKey: string): Dict {
  const name = basename(path);
  let text: string;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw new ProductionError(`${name} quá lớn`);
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); // utf-8-sig
  } catch (e) {
    if (e instanceof ProductionError) throw e;
    if ((e as { code?: string }).code === 'ENOENT') throw new ProductionError(`thiếu file ${name}`);
    const t = e instanceof TypeError ? 'UnicodeDecodeError' : pyOsName(e);
    throw new ProductionError(`không đọc được ${name} (${t})`);
  }
  if (!pyStrip(text)) throw new ProductionError(`${name} rỗng`);
  let doc: unknown;
  try {
    doc = loadsStrict(text);
  } catch (e) {
    throw new ProductionError(`${name} JSON hỏng: ${(e as Error).message}`);
  }
  if (!isDict(doc)) throw new ProductionError(`${name}: root phải là object`);
  if (!Object.keys(doc).some((k) => k !== '_doc')) {
    throw new ProductionError(`${name}: không có dữ liệu (0 record)`);
  }
  if (listKey) {
    const v = get(doc, listKey);
    if (!Array.isArray(v) || !v.length) {
      throw new ProductionError(`${name}: '${listKey}' phải là list không rỗng`);
    }
  }
  return doc;
}

// ---------- cấu hình mốc chốt + SLA ----------

export type Cutoff = { id: string; date: string; covers_until: string; label: string };
export type ProductionConfig = {
  status: string;
  cutoffs: Cutoff[];
  sla_hours: number;
  remind_hours: number;
  near_expiry_days: number;
};

export function validateConfig(doc: Dict): ProductionConfig {
  const status = get(doc, 'status');
  if (typeof status !== 'string' || !pyStrip(status)) {
    throw new ProductionError("config: thiếu 'status'");
  }
  const raw = get(doc, 'cutoffs');
  if (!Array.isArray(raw) || !raw.length) {
    throw new ProductionError("config: 'cutoffs' phải là list không rỗng");
  }
  const cutoffs: Cutoff[] = [];
  const ids = new Set<string>();
  raw.forEach((c, i) => {
    const where = `cutoffs[${i}]`;
    if (!isDict(c)) throw new ProductionError(`${where}: phải là object`);
    const cid = get(c, 'id');
    if (typeof cid !== 'string' || !ID_RE.test(cid) || cpLen(cid) > 40) {
      throw new ProductionError(`${where}.id: phải là slug a-z0-9_-`);
    }
    if (ids.has(cid)) throw new ProductionError(`${where}.id: trùng`);
    ids.add(cid);
    const d = isoIn(get(c, 'date'), `${where}.date`);
    const until = isoIn(get(c, 'covers_until'), `${where}.covers_until`);
    if (until <= d) throw new ProductionError(`${where}: covers_until phải sau date`);
    const label = has(c, 'label') ? c.label : '';
    if (typeof label !== 'string') throw new ProductionError(`${where}.label: phải là chuỗi`);
    cutoffs.push({ id: cid, date: d, covers_until: until, label });
  });
  const sla = get(doc, 'sla_hours');
  const remind = get(doc, 'remind_hours');
  if (!(isInt(sla) && isInt(remind) && remind > 0 && remind < sla && sla <= MAX_SLA_HOURS)) {
    throw new ProductionError(
      `config: cần số nguyên 0 < remind_hours < sla_hours <= ${MAX_SLA_HOURS}`,
    );
  }
  const near = get(doc, 'near_expiry_days');
  if (!(isInt(near) && near > 0 && near <= MAX_NEAR_DAYS)) {
    throw new ProductionError(`config: near_expiry_days phải là số nguyên 1..${MAX_NEAR_DAYS}`);
  }
  return {
    status: pyStrip(status),
    cutoffs,
    sla_hours: sla,
    remind_hours: remind,
    near_expiry_days: near,
  };
}

export const loadConfig = (path: string = CONFIG_FILE): ProductionConfig =>
  validateConfig(readJson(path, ''));

// ---------- SX-A3 phân bổ tồn (thuần) ----------

export function weeksBetween(start: string, until: string): number {
  const n = daysBetween(weekStart(until), weekStart(start)) / 7 + 1;
  if (n < 1) throw new ProductionError('start sau covers_until của mốc');
  if (n > MAX_WEEKS) {
    throw new ProductionError(`quá ${MAX_WEEKS} tuần từ start tới covers_until`);
  }
  return n;
}

export type Demand = Levels & { note: string | null };
export type Demands = Record<string, Demand>;
export type ProjectFn = (
  sku: Sku,
  channel: string,
  start: string,
  weeks: unknown,
  a: unknown,
) => ProjectRow[];

/** Nhu cầu cộng dồn start..until theo MỖI kênh — gọi `scenario.project`, không công thức riêng.
 * Ném ScenarioError/ProductionError. `projectFn` = điểm nối test (Python monkeypatch). */
export function demandFor(
  sku: Sku,
  start: string,
  until: string,
  assumptions: unknown,
  projectFn: ProjectFn = project,
): Demands {
  const weeks = weeksBetween(start, until);
  const out: Demands = {};
  for (const ch of ALL_CHANNELS) {
    const rows = projectFn(sku, ch, start, weeks, assumptions);
    const d = {} as Demand;
    for (const lv of LEVELS) d[lv] = rows.reduce((s, r) => s + r[lv], 0);
    d.note = rows.find((r) => r.note)?.note ?? null;
    out[ch] = d;
  }
  return out;
}

export type Sums = Levels;

/** → [mức, chữ] — 'low' | 'base' | 'high' | null. stock null → [null, null]: chưa có số tồn KHÔNG
 * phải thiếu. */
export function shortage(stock: number | null, sums: Sums): [string | null, string | null] {
  if (stock === null) return [null, null];
  const gap = sums.base - stock;
  if (sums.low > stock) return ['low', `THIẾU CẢ KỊCH BẢN THẤP (thiếu ${gap} so với cơ sở)`];
  if (gap > 0) return ['base', `THIẾU (cơ sở) ${gap}`];
  if (sums.high > stock) {
    return ['high', `RỦI RO (kịch bản cao) thiếu ${sums.high - stock} nếu bán theo mức cao`];
  }
  return [null, null];
}

export type Allocation = {
  demand: Record<string, Levels>;
  proposed: Record<string, number>;
  notes: Record<string, string | null>;
  unallocated: number | null;
  sums: Sums;
  flag_level: string | null;
  flag: string | null;
};

/** Hàm thuần, tất định. Chia tỉ lệ cơ sở khi thiếu: floor + phần dư lớn nhất, hòa theo thứ tự kênh. */
export function allocate(stock: unknown, demand: unknown, category: unknown): Allocation {
  if (stock !== null && (!isInt(stock) || stock < 0)) {
    throw new ProductionError('stock phải là số nguyên >= 0 hoặc None');
  }
  const st = stock as number | null;
  if (!isDict(demand)) throw new ProductionError('demand phải là object kênh -> mức');
  const dm = demand;
  const chans = ALL_CHANNELS;
  const dem: Record<string, Levels> = {};
  const notes: Record<string, string | null> = {};
  for (const c of chans) {
    const raw = get(dm, c);
    // Python `demand.get(c) or {}`: thiếu/None/{} → 0 mọi mức; giá trị khác object → lỗi (Python crash).
    if (raw !== undefined && raw !== null && !isDict(raw)) {
      throw new ProductionError(`demand ${c}: phải là số nguyên >= 0`);
    }
    const d = (raw ?? {}) as Dict;
    let vals = {} as Levels;
    for (const lv of LEVELS) vals[lv] = (has(d, lv) ? d[lv] : 0) as number;
    if (!LEVELS.every((lv) => isInt(vals[lv]) && vals[lv] >= 0)) {
      throw new ProductionError(`demand ${c}: phải là số nguyên >= 0`);
    }
    notes[c] = (has(d, 'note') ? d.note : null) as string | null;
    // Chốt chặn thứ 2: rượu 0 mọi kênh online BẤT KỂ nhu cầu đưa vào.
    if (category === 'alcohol' && c !== OFFLINE) {
      notes[c] = NOTE_ALCOHOL_ONLINE;
      vals = { low: 0, base: 0, high: 0 };
    }
    dem[c] = vals;
  }
  const sums = {} as Sums;
  for (const lv of LEVELS) sums[lv] = chans.reduce((s, c) => s + (dem[c] as Levels)[lv], 0);
  const base = Object.fromEntries(chans.map((c) => [c, (dem[c] as Levels).base]));
  const total = sums.base;
  let proposed: Record<string, number>;
  let spare: number | null;
  if (st === null) {
    proposed = Object.fromEntries(chans.map((c) => [c, 0]));
    spare = null;
  } else if (st >= total) {
    proposed = { ...base };
    spare = st - total;
  } else {
    // BigInt: stock × base vượt 2^53 khi số lớn (Python int không giới hạn).
    const S = BigInt(st);
    const T = BigInt(total);
    proposed = Object.fromEntries(chans.map((c) => [c, Number((S * BigInt(base[c])) / T)]));
    let left = st - Object.values(proposed).reduce((a, b) => a + b, 0);
    const order = chans
      .map((c, i) => [Number((S * BigInt(base[c])) % T), i] as const)
      .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, i] of order) {
      if (left-- <= 0) break;
      proposed[chans[i] as string] = (proposed[chans[i] as string] as number) + 1;
    }
    spare = 0;
  }
  let [level, text] = shortage(st, sums);
  if (st === null) text = NOTE_NO_STOCK;
  return { demand: dem, proposed, notes, unallocated: spare, sums, flag_level: level, flag: text };
}

export type PlanRow = {
  sku_key: string;
  channel: string;
  stock_total: number | null;
  demand_low: number;
  demand_base: number;
  demand_high: number;
  proposed_qty: number;
  note: string | null;
  flag: string | null;
  flag_level: string | null;
  stale: string[];
  sample: boolean;
};

/** skus golden × kênh → dòng `allocation_proposals` (chưa có run_id). */
export function planRows(skus: Sku[], stock: Stock, demands: Record<string, Demands>): PlanRow[] {
  const rows: PlanRow[] = [];
  const sorted = [...skus].sort((a, b) => cmpCp(String(a.sku_key), String(b.sku_key)));
  for (const s of sorted) {
    const key = String(s.sku_key);
    const st = stock.get(key);
    const qty = st ? st.qty : null;
    const a = allocate(qty, demands[key], s.category);
    const stale = st ? st.stale : null;
    for (const c of ALL_CHANNELS) {
      const note = [a.notes[c], a.flag].filter((n): n is string => Boolean(n));
      if (stale?.length) note.push(`${STALE_NOTE} (${clean(stale.join(', '), 200)})`);
      if (c === OFFLINE && a.unallocated) note.push(`${NOTE_SPARE} ${a.unallocated}`);
      const d = a.demand[c] as Levels;
      rows.push({
        sku_key: key,
        channel: c,
        stock_total: qty,
        demand_low: d.low,
        demand_base: d.base,
        demand_high: d.high,
        proposed_qty: a.proposed[c] as number,
        note: note.join('; ') || null,
        flag: a.flag,
        flag_level: a.flag_level,
        stale: [...(stale ?? [])],
        sample: Boolean(st?.sample),
      });
    }
  }
  return rows;
}

/** Python `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))` cho giá trị
 * chuỗi/số nguyên/list/dict (JSON.stringify thoát chuỗi giống hệt ở chế độ ensure_ascii=False). */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isDict(v)) {
    const ks = Object.keys(v).sort(cmpCp);
    return `{${ks.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Khóa idempotent của 1 lượt phân bổ: cùng mốc + tuần + tồn đang dùng + giả định + golden → cùng
 * run_id (khớp Python để 2 hệ chạy song song không nhân bản run). */
export function runIdFor(
  cutoff: Cutoff,
  startWeek: string,
  stock: Map<string, { kho: Record<string, { qty: number; captured_at: string }> }>,
  assumptionsStatus: string,
  assumptionsBytes: Uint8Array,
  goldenBytes: Uint8Array,
): string {
  const used: [string, string, number, string][] = [];
  for (const [k, s] of stock) {
    for (const [kho, v] of Object.entries(s.kho)) used.push([k, kho, v.qty, v.captured_at]);
  }
  used.sort((a, b) => cmpCp(a[0], b[0]) || cmpCp(a[1], b[1]) || a[2] - b[2] || cmpCp(a[3], b[3]));
  return sha256Hex(
    canon({
      cutoff,
      start_week: startWeek,
      stock: used,
      status: assumptionsStatus,
      assumptions: sha256Hex(assumptionsBytes),
      golden: sha256Hex(goldenBytes),
    }),
  ).slice(0, 12);
}

// ---------- SX-A4 BOM (thuần) ----------

/**
 * Luật kênh THEO DỮ LIỆU golden: mỗi kênh online của combo phải có trong allowed_channels của MỌI
 * SKU thành phần; combo có rượu chỉ được kênh offline (bất kể allowed_channels của SKU rượu). Lỗi chỉ
 * nêu combo_key / sku_key / kênh. Tên combo qua guardrail.
 */
export function checkBom(combos: unknown, golden: GoldenMap): string[] {
  if (!Array.isArray(combos) || !combos.length) return ['combos phải là list không rỗng'];
  const errs: string[] = [];
  const seen = new Set<string>();
  combos.forEach((c, i) => {
    if (!isDict(c)) {
      errs.push(`combos[${i}]: phải là object`);
      return;
    }
    let key = get(c, 'combo_key') as string;
    if (typeof key !== 'string' || !SLUG_RE.test(key) || cpLen(key) > 64) {
      errs.push(`combos[${i}]: combo_key phải là slug ascii`);
      key = `combos[${i}]`;
    } else if (seen.has(key)) errs.push(`combo ${key}: combo_key trùng`);
    seen.add(key);
    const extra = Object.keys(c)
      .filter((k) => !COMBO_KEYS.includes(k))
      .sort(cmpCp);
    if (extra.length) errs.push(`combo ${key}: key lạ ${clean(extra.join(', '), 80)}`);
    const name = get(c, 'name');
    if (typeof name !== 'string' || !pyStrip(name) || cpLen(name) > 200) {
      errs.push(`combo ${key}: name rỗng hoặc > 200 ký tự`);
    } else if (!guardrailCheck(name).ok) errs.push(`combo ${key}: tên vi phạm guardrail`);
    const note = get(c, 'note');
    if (
      note !== undefined &&
      note !== null &&
      (typeof note !== 'string' || cpLen(note) > MAX_NOTE_LEN)
    ) {
      errs.push(`combo ${key}: note phải là chuỗi <= ${MAX_NOTE_LEN}`);
    }
    let chans = get(c, 'channels') as string[];
    if (
      !Array.isArray(chans) ||
      !chans.length ||
      !chans.every((x) => typeof x === 'string') ||
      new Set(chans).size !== chans.length ||
      !chans.every((x) => ALL_CHANNELS.includes(x))
    ) {
      errs.push(`combo ${key}: channels phải là list kênh hợp lệ, không rỗng, không trùng`);
      chans = [];
    }
    let items = get(c, 'items') as unknown[];
    if (!Array.isArray(items) || !items.length) {
      errs.push(`combo ${key}: items rỗng`);
      items = [];
    }
    const skus: string[] = [];
    const iseen = new Set<string>();
    items.forEach((it, j) => {
      if (!isDict(it) || Object.keys(it).some((k) => !ITEM_KEYS.includes(k))) {
        errs.push(`combo ${key}: items[${j}] phải là object {sku_key, qty}`);
        return;
      }
      const sku = get(it, 'sku_key');
      if (typeof sku !== 'string' || !golden.has(sku)) {
        errs.push(`combo ${key}: items[${j}] sku_key không có trong golden`);
      } else if (iseen.has(sku)) errs.push(`combo ${key}: SKU ${sku} trùng`);
      else {
        iseen.add(sku);
        skus.push(sku);
      }
      const q = get(it, 'qty');
      if (!isInt(q) || !(q > 0 && q <= QTY_MAX)) {
        errs.push(`combo ${key}: items[${j}] qty phải nguyên > 0`);
      }
    });
    const online = chans.filter((ch) => ONLINE.includes(ch));
    if (online.length && skus.some((s) => golden.get(s)?.category === 'alcohol')) {
      errs.push(`combo ${key}: combo có rượu chỉ được kênh offline (đang có ${online.join(', ')})`);
    }
    for (const ch of online) {
      for (const s of skus) {
        const allowed = golden.get(s)?.allowed_channels;
        if (!(Array.isArray(allowed) ? allowed : []).includes(ch)) {
          errs.push(`combo ${key} kênh ${ch}: SKU ${s} không có ${ch} trong allowed_channels`);
        }
      }
    }
  });
  return errs;
}

export type BomItem = { sku_key: string; qty: number };

/** Số combo làm được = min(tồn[sku] // qty). SKU thiếu số tồn → 0 + danh sách SKU thiếu (không đoán). */
export function buildable(items: BomItem[], stock: Map<string, number>): [number, string[]] {
  const missing = items
    .filter((it) => stock.get(it.sku_key) === undefined)
    .map((it) => it.sku_key)
    .sort(cmpCp);
  if (missing.length || !items.length) return [0, missing];
  return [
    Math.min(...items.map((it) => Math.floor((stock.get(it.sku_key) as number) / it.qty))),
    [],
  ];
}

// ---------- SX-A5 hồ sơ lô (thuần) ----------

export function validateLots(lots: unknown, golden: GoldenMap, today: string): string[] {
  if (!Array.isArray(lots) || !lots.length) return ['lots phải là list không rỗng'];
  const errs: string[] = [];
  const seen = new Set<string>();
  lots.forEach((lot, i) => {
    if (!isDict(lot)) {
      errs.push(`lots[${i}]: phải là object`);
      return;
    }
    let code = get(lot, 'lot_code') as string;
    if (typeof code !== 'string' || !LOT_RE.test(code)) {
      errs.push(`lots[${i}]: lot_code phải khớp ${LOT_RE_SRC}`);
      code = `lots[${i}]`;
    } else if (seen.has(code)) errs.push(`lô ${code}: lot_code trùng`);
    seen.add(code);
    const extra = Object.keys(lot)
      .filter((k) => !LOT_KEYS.includes(k))
      .sort(cmpCp);
    if (extra.length) errs.push(`lô ${code}: key lạ ${clean(extra.join(', '), 80)}`);
    const sku = get(lot, 'sku_key');
    if (typeof sku !== 'string' || !golden.has(sku)) {
      errs.push(`lô ${code}: sku_key không có trong golden`);
    }
    let mfg: string | null = null;
    let exp: string | null = null;
    try {
      mfg = isoIn(get(lot, 'mfg_date'), `lô ${code} mfg_date`);
      if (mfg > today) errs.push(`lô ${code}: mfg_date ở tương lai`);
    } catch (e) {
      if (!(e instanceof ProductionError)) throw e;
      errs.push(e.message);
    }
    try {
      exp = isoIn(get(lot, 'exp_date'), `lô ${code} exp_date`);
    } catch (e) {
      if (!(e instanceof ProductionError)) throw e;
      errs.push(e.message);
    }
    if (mfg && exp && exp <= mfg) errs.push(`lô ${code}: hạn dùng phải SAU ngày sản xuất`);
    const q = get(lot, 'qty');
    if (!isInt(q) || !(q > 0 && q <= QTY_MAX)) errs.push(`lô ${code}: qty phải nguyên > 0`);
    const note = get(lot, 'note');
    if (
      note !== undefined &&
      note !== null &&
      (typeof note !== 'string' || cpLen(note) > MAX_NOTE_LEN)
    ) {
      errs.push(`lô ${code}: note phải là chuỗi <= ${MAX_NOTE_LEN}`);
    }
  });
  return errs;
}

/** Điểm nối QR truy xuất (v9.4). Chỉ lô đã kiểm nhập 'passed'; không người kiểm, không PII. */
export function qrPayload(
  lot: unknown,
): { lot_code: unknown; sku_key: unknown; exp_date: unknown } | null {
  if (!isDict(lot) || get(lot, 'intake_status') !== 'passed') return null;
  return {
    lot_code: get(lot, 'lot_code') ?? null,
    sku_key: get(lot, 'sku_key') ?? null,
    exp_date: get(lot, 'exp_date') ?? null,
  };
}

// ---------- SX-A0 bản tin (thuần) ----------

export type ShortageRow = {
  cutoff_id: string;
  cutoff_date: string;
  run_id: string;
  status: string;
  sku_key: string;
  stock_total: number;
  low: number;
  base: number;
  high: number;
  flag: string | null;
};
export type PendingLot = {
  lot_code: string;
  sku_key: string;
  mfg_date: string;
  exp_date: string;
  qty: number;
  created_at: Date;
};
export type PendingItem = { kind: string; id: string; created_at: Date };
export type NearRow = {
  lot_code: string;
  sku_key: string;
  exp_date: string;
  qty: number;
  stock: number | null;
};
/** (plan_code, sku, qty_plan, start, due, is_sample, đạt, chờ, không đạt, lô mẫu). */
export type PlanProgress = [
  string,
  string,
  number,
  string,
  string,
  boolean,
  number,
  number,
  number,
  boolean,
];
/** (lot_code, intake_status, version | null, cert_no | null, sha | null, ext | null). */
export type CertRow = [string, string, number | null, string | null, string | null, string | null];

export type BulletinData = {
  date?: string | null;
  period?: string | null;
  missing_tables?: string[];
  sample?: boolean;
  shortages?: ShortageRow[];
  no_stock?: string[];
  stale_stock?: [string, string][];
  lots_pending?: PendingLot[];
  bom_errors?: string[];
  pending?: PendingItem[];
  near_expiry?: NearRow[];
  /** undefined = khóa vắng (data cũ) → bỏ mục; null = chưa có bảng. */
  plans?: PlanProgress[] | null;
  certs?: CertRow[] | null;
};

function ageLabel(ageMs: number, config: ProductionConfig): string {
  if (ageMs >= config.sla_hours * 3600_000) {
    return `QUÁ SLA ${config.sla_hours}h — đề xuất chuyển TGĐ`;
  }
  if (ageMs >= config.remind_hours * 3600_000) return 'NHẮC';
  return 'trong hạn';
}

export const PROGRESS_KEEP_DAYS = 31; // kế hoạch đã xong lâu hơn → không lặp lại

/** Đợt hợp đồng C10 — tiến độ = Σ số lượng lô đã GẮN kế hoạch (đạt / chờ / không đạt) so với kế
 * hoạch. Không có kế hoạch → THIẾU DỮ LIỆU (không suy từ số lô). */
function progressLines(plans: PlanProgress[] | null, day: string, noTable: string): string[] {
  const out = [
    '## Tiến độ sản xuất',
    'Nguồn: `production_plans` (NGƯỜI khối sản xuất ghi) × `production_plan_lots` (lô gắn tường minh) × `production_lots`. % = số lượng lô ĐẠT kiểm nhập / kế hoạch.',
  ];
  if (plans === null) return [...out, noTable];
  let shown = 0;
  for (const [code, sku, qty, start, due, smp, ok, wait, bad, lotSmp] of plans) {
    if (ok >= qty && daysBetween(day, due) > PROGRESS_KEEP_DAYS) continue;
    let st: string;
    if (ok >= qty) st = 'XONG';
    else if (day > due) st = `CHẬM — quá hạn ${daysBetween(day, due)} ngày`;
    else if (day < start) st = 'chưa tới khung';
    else st = 'đang làm';
    out.push(
      `- ${clean(code, 80)} · ${clean(sku, 80)} · kế hoạch ${qty} (${start}→${due}) · đạt ${ok} (${Math.floor((ok * 100) / qty)}%) · chờ kiểm ${wait} · không đạt ${bad} · ${st}` +
        (smp || lotSmp ? ' [MẪU]' : ''),
    );
    shown++;
  }
  if (!plans.length) {
    out.push('THIẾU DỮ LIỆU — chưa có kế hoạch sản xuất được ghi (`production plan-add`)');
  } else if (!shown) out.push('không có');
  return out;
}

const tieCmp = (a: string, b: string): number => cmpCp(a, b);

/** Tất định: cùng data + now → cùng chuỗi. Chỉ chữ — không đổi trạng thái, không gửi đi. */
export function renderBulletin(data: BulletinData, now: Date, config: ProductionConfig): string {
  const day = data.date || vnDate(now);
  const missing = new Set(data.missing_tables ?? []);
  const noTable = 'chưa có bảng — chạy apply_schema';
  const kind = data.period === 'month' ? 'tháng' : 'tuần';
  const out: string[] = [
    `# Bản tin Sản xuất ${kind} — ${day}`,
    '',
    `Cấu hình mốc/SLA: ${config.status}`,
  ];
  if (data.sample) out.push("[MẪU] Có dữ liệu mẫu (source='sample') — số liệu chưa phải thật.");
  out.push(
    'KHÔNG phải doanh số cam kết — agent chỉ đề xuất; không chuyển kho, không đặt mua, không lệnh sản xuất.',
    '',
  );

  out.push('## Thiếu hàng theo mốc chốt', 'Nguồn: `allocation_proposals` (run mới nhất mỗi mốc).');
  if (missing.has('allocation_proposals')) out.push(noTable);
  else {
    const rows = [...(data.shortages ?? [])].sort(
      (a, b) =>
        tieCmp(a.cutoff_date, b.cutoff_date) ||
        tieCmp(a.cutoff_id, b.cutoff_id) ||
        tieCmp(a.sku_key, b.sku_key),
    );
    for (const r of rows) {
      const left = daysBetween(r.cutoff_date, day);
      const when = left >= 0 ? `còn ${left} ngày` : `đã qua ${-left} ngày`;
      out.push(
        `- ${clean(r.cutoff_id, 80)} (${r.cutoff_date}, ${when}) · run ${clean(r.run_id, 80)} [${r.status}] · ${clean(r.sku_key, 80)}: tồn ${r.stock_total}, cơ sở ${r.base} (thấp ${r.low}, cao ${r.high}) — ${pyStr(r.flag)}`,
      );
    }
    const nostock = [...(data.no_stock ?? [])].sort(cmpCp);
    if (nostock.length) out.push(`- ${NOTE_NO_STOCK}: ${clean(nostock.join(', '), 2000)}`);
    const stale = [...(data.stale_stock ?? [])].sort(
      (a, b) => cmpCp(a[0], b[0]) || cmpCp(a[1], b[1]),
    );
    if (stale.length) {
      out.push(
        `- ${STALE_NOTE} (nguồn \`inventory_snapshots\`): ${clean(stale.map(([k, kho]) => `${k}@${kho}`).join(', '), 2000)}`,
      );
    }
    if (!rows.length && !nostock.length && !stale.length) out.push('không có');
  }
  out.push('');

  out.push('## Lô chờ kiểm nhập', 'Nguồn: `production_lots` (pending).');
  if (missing.has('production_lots')) out.push(noTable);
  else {
    const lots = [...(data.lots_pending ?? [])].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || cmpCp(a.lot_code, b.lot_code),
    );
    for (const r of lots) {
      out.push(
        `- ${clean(r.lot_code, 80)} · ${clean(r.sku_key, 80)} · SX ${r.mfg_date} · HSD ${r.exp_date} · ${r.qty}`,
      );
    }
    if (!lots.length) out.push('không có');
  }
  out.push('');

  out.push('## BOM lỗi', 'Nguồn: `bom_combos` + `bom_items` × golden file hiện tại.');
  if (missing.has('bom_combos') || missing.has('bom_items')) out.push(noTable);
  else {
    const errs = [...(data.bom_errors ?? [])].sort(cmpCp);
    out.push(...(errs.length ? errs.map((e) => `- ${clean(e, 300)}`) : ['không có']));
  }
  out.push('');

  const noPendTables = missing.has('allocation_proposals') || missing.has('production_lots');
  out.push(
    '## Mục chờ duyệt & SLA',
    `Nguồn: \`allocation_proposals\` + \`production_lots\` (nhắc ≥ ${config.remind_hours}h, SLA ${config.sla_hours}h — chỉ là chữ trong bản tin, không tự chuyển/duyệt thay).`,
  );
  if (noPendTables) out.push(noTable);
  const nowMs = now.getTime();
  const items = [...(data.pending ?? [])].sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() || cmpCp(a.kind, b.kind) || cmpCp(a.id, b.id),
  );
  for (const r of items) {
    const age = nowMs - r.created_at.getTime();
    const hours = Math.max(0, Math.floor(age / 3600_000));
    out.push(`- ${r.kind} ${clean(r.id, 80)} — chờ ${hours}h — ${ageLabel(age, config)}`);
  }
  if (!items.length && !noPendTables) out.push('không có');
  out.push('');

  const near = config.near_expiry_days;
  out.push(
    '## Hàng cận hạn (FEFO)',
    `Nguồn: \`production_lots\` (passed, HSD ≤ ${near} ngày tới, gồm lô đã quá hạn) × \`inventory_snapshots\` (tồn theo SKU — chưa theo lô; tồn 0 → bỏ).`,
  );
  if (missing.has('production_lots')) out.push(noTable);
  else {
    const lots = (data.near_expiry ?? [])
      .filter((r) => daysBetween(r.exp_date, day) <= near)
      .sort((a, b) => cmpCp(a.exp_date, b.exp_date) || cmpCp(a.lot_code, b.lot_code));
    for (const r of lots) {
      const left = daysBetween(r.exp_date, day);
      const when = left >= 0 ? `còn ${left} ngày` : `ĐÃ QUÁ HẠN ${-left} ngày`;
      const stock = r.stock === null ? 'chưa có số tồn' : `tồn SKU ${r.stock}`;
      out.push(
        `- ${clean(r.lot_code, 80)} · ${clean(r.sku_key, 80)} · HSD ${r.exp_date} (${when}) · lô ${r.qty} · ${stock}`,
      );
    }
    if (!lots.length) out.push('không có');
  }
  out.push('');

  // Đợt hợp đồng C10/C03 — mục mới đặt CUỐI bản tin (không xáo mục cũ); `collect` luôn đặt khóa
  // `plans`/`certs` (null = chưa có bảng).
  if (data.plans !== undefined) out.push(...progressLines(data.plans, day, noTable), '');
  if (data.certs === undefined) return `${out.slice(0, -1).join('\n')}\n`;
  out.push(
    '## Phiếu kiểm nghiệm lô',
    'Nguồn: `lot_test_certificates` (phiên bản mới nhất) × `production_lots` chờ/đạt. Lô chưa có dòng phiếu = THIẾU phiếu — kiểm tệp/hash: `production cert-verify`.',
  );
  if (data.certs === null) out.push(noTable);
  else {
    for (const [code, st, ver, no] of data.certs) {
      out.push(
        `- ${clean(code, 80)} (${st}) · ${ver ? `phiếu ${clean(no, 80)} (v${ver})` : 'THIẾU phiếu'}`,
      );
    }
    if (!data.certs.length) out.push('không có');
  }
  return `${out.join('\n')}\n`;
}

export const FEFO_HEAD = '## Hàng cận hạn (FEFO)';

/** Python `str.partition`. */
function partition(s: string, sep: string): [string, string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** → [bản tin bỏ mục cận hạn, tài liệu chỉ tiêu đề + mục cận hạn]. Mục cận hạn kết thúc ở tiêu đề
 * `## ` kế tiếp (tiến độ/phiếu kiểm nghiệm thuộc bản tin, không thuộc cận hạn). */
export function splitFefo(text: string): [string, string] {
  const [head, sep, rest] = partition(text, FEFO_HEAD);
  if (!sep) return [text, ''];
  const [fefo, nxt, tail] = partition(rest, '\n## ');
  const title = head ? (splitlines(head)[0] ?? '') : '# Bản tin Sản xuất';
  return [head + (nxt ? `## ${tail}` : ''), `${title}\n\n${FEFO_HEAD}${fefo}${nxt ? '\n' : ''}`];
}

/** Ngày + n ngày (ngày 'YYYY-MM-DD'). */
export const plusDays = addDays;
