import { existsSync, statSync } from 'node:fs';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay, weekday } from '@samsam/core/ops/period';
import {
  isDict,
  isPyInt,
  PyFloat,
  PyReadError,
  parsePyJson,
  pyFloatStr,
  readUtf8Sig,
} from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyReprValue, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';

// Phần `pipelines/scenario.py` (engine kịch bản mùa DÙNG CHUNG), `ingest/golden_store.py`
// (read_golden + validate), `ingest/inventory_csv.current_stock` và `pipelines/production.shortage`
// mà KD-A10 (`agents/kd_forecast.py`) gọi lại.
// shortcut: bản riêng của nhóm sales_director (các module trên chưa port sang TS) — khi nhóm
// scenario/golden_store/inventory/production port xong thì import dùng chung, xóa tệp này.
// Ngày = chuỗi 'YYYY-MM-DD' (Python `date`).

export const GOLDEN_FILE = dataPath('golden_skus.json');
export const ASSUMPTIONS_FILE = dataPath('scenario_assumptions.json');
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol'];
export const XNQC = ['none', 'pending', 'approved'];
export const CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'];
export const KINDS = ['floor', 'list', 'promo'];
export const LEVELS = ['low', 'base', 'high'] as const;
export type Level = (typeof LEVELS)[number];
export type Levels = Record<Level, number>;
export const OFFLINE = 'offline';
export const ALL_CHANNELS = [...CHANNELS, OFFLINE];
export const MAX_WEEKS = 104;
// Khung ngày hợp lệ cho start/ngày sự kiện.
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2100-12-31';
// Mùng 1 Tết Âm lịch (dương lịch) — Bính Ngọ 17/02/2026, Đinh Mùi 06/02/2027, Mậu Thân 26/01/2028.
export const TET_DATES: Record<number, string> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
};
export const NOTE_ALCOHOL = 'rượu: chỉ kênh offline';
export const NOTE_NOT_ALLOWED = 'kênh chưa có trong allowed_channels (golden)';
export const STALE_NOTE = 'số tồn cũ hơn file kho mới nhất — kiểm lại';
export const NOTE_NO_STOCK = 'chưa có số tồn — không kết luận thiếu';

/** Config/tham số kịch bản không dùng được — fail-closed (Python ValueError). */
export class ScenarioError extends RangeError {}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const py = (v: unknown) => (v instanceof PyFloat ? pyFloatStr(v.v) : pyReprValue(v));
const pyStrV = (v: unknown) => (v instanceof PyFloat ? pyFloatStr(v.v) : pyStr(v));

// ---------------------------------------------------------------- golden_store

/** → [doc, null] | [null, lý do]. Mọi biến thể "không có dữ liệu" trả lý do. */
export function readGolden(
  path: string = GOLDEN_FILE,
): [Record<string, unknown>, null] | [null, string] {
  if (!existsSync(path) || !statSync(path).isFile()) return [null, `thiếu file ${path}`];
  let text: string;
  try {
    text = readUtf8Sig(path);
  } catch (e) {
    return [null, `${path} không phải UTF-8: ${e instanceof PyReadError ? e.pyType : 'OSError'}`];
  }
  if (!pyStrip(text)) return [null, `${path} rỗng`];
  let doc: unknown;
  try {
    doc = parsePyJson(text);
  } catch (e) {
    return [null, `${path} JSON hỏng: ${(e as Error).message}`];
  }
  const skus = isDict(doc) ? doc.skus : undefined;
  if (!isDict(doc) || !(skus instanceof PyFloat ? skus.v !== 0 : pyTruthy(skus))) {
    return [null, `${path} không có SKU nào (0 record) — không nạp`];
  }
  return [doc, null];
}

/** 3 ràng buộc giá người dùng đặt — số nguyên, chỉ khi đủ giá trị. */
function checkPrices(sku: string, channel: string, p: Record<string, number>): string[] {
  const errs: string[] = [];
  const { floor, list: lst, promo } = p;
  const w = `${sku}/${channel}`;
  const s = (v: number | undefined) => (v === undefined ? 'None' : String(v));
  if (floor !== undefined && lst !== undefined && lst * 100 > floor * 149) {
    errs.push(`${w} R1: giá thường ${lst} > 149% giá sàn ${floor}`);
  }
  if (lst !== undefined && promo !== undefined && (lst - promo) * 100 > lst * 49) {
    errs.push(`${w} R2: KM ${promo} giảm > 49% từ giá thường ${lst}`);
  }
  if (
    (floor !== undefined && promo !== undefined && promo < floor) ||
    (promo !== undefined && lst !== undefined && promo > lst) ||
    (floor !== undefined && lst !== undefined && floor > lst)
  ) {
    errs.push(`${w} R3: phải sàn ${s(floor)} <= KM ${s(promo)} <= thường ${s(lst)}`);
  }
  return errs;
}

const get = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
// Python `x in (True, False, None)` (== : 1 == True, 0 == False).
const triBool = (v: unknown) =>
  v === undefined || v === null || v === true || v === false || v === 0 || v === 1;

/** Hàm thuần: schema + R1/R2/R3. [] = hợp lệ. Mỗi lỗi nêu sku_key. */
export function validateGolden(doc: unknown): string[] {
  if (!isDict(doc)) return ['root phải là object {"_doc", "skus"}'];
  const skus = doc.skus;
  if (!Array.isArray(skus) || !skus.length) return ['skus phải là list không rỗng'];
  const errs: string[] = [];
  const seen = new Set<string>();
  const pidOwner = new Map<string, string>();
  skus.forEach((s, i) => {
    if (!isDict(s)) {
      errs.push(`skus[${i}] không phải object`);
      return;
    }
    let key = get(s, 'sku_key') as string;
    if (typeof key !== 'string' || !SLUG_RE.test(key)) {
      errs.push(`skus[${i}] sku_key ${py(get(s, 'sku_key'))} không phải slug ascii`);
      key = `skus[${i}]`;
    } else if (seen.has(key)) errs.push(`${key}: sku_key trùng`);
    seen.add(key);
    const name = get(s, 'name');
    if (typeof name !== 'string' || !pyStrip(name)) errs.push(`${key}: thiếu name`);
    if (!CATEGORIES.includes(get(s, 'category') as string)) {
      errs.push(`${key}: category ${py(get(s, 'category'))} không hợp lệ`);
    }
    const xq = Object.hasOwn(s, 'xnqc_status') ? s.xnqc_status : 'none';
    if (!XNQC.includes(xq as string)) errs.push(`${key}: xnqc_status ${py(xq)} không hợp lệ`);
    if (!triBool(get(s, 'self_declaration_ok'))) {
      errs.push(`${key}: self_declaration_ok phải true/false/null`);
    }
    for (const f of ['pack_spec', 'receipt_no', 'shopee_item_id', 'note']) {
      const v = get(s, f);
      if (v !== undefined && v !== null && typeof v !== 'string') {
        errs.push(`${key}: ${f} phải là chuỗi hoặc null`);
      }
    }
    const rd = get(s, 'receipt_date');
    if (rd !== undefined && rd !== null && (typeof rd !== 'string' || parseDay(rd) === null)) {
      errs.push(`${key}: receipt_date ${py(rd)} không phải ISO`);
    }
    const chans = Object.hasOwn(s, 'allowed_channels') ? s.allowed_channels : [];
    if (!Array.isArray(chans) || chans.some((c) => !CHANNELS.includes(c))) {
      errs.push(`${key}: allowed_channels phải ⊂ (${CHANNELS.map(pyRepr).join(', ')})`);
    }
    let pids = Object.hasOwn(s, 'product_ids') ? s.product_ids : [];
    if (!Array.isArray(pids) || !pids.every((p) => typeof p === 'string' && p)) {
      errs.push(`${key}: product_ids phải là list chuỗi`);
      pids = [];
    }
    for (const p of pids as string[]) {
      const owner = pidOwner.get(p);
      if (owner !== undefined) errs.push(`${key}: product_id ${p} đã map cho ${owner}`);
      else pidOwner.set(p, key);
    }
    const prices = Object.hasOwn(s, 'prices') ? s.prices : {};
    if (!isDict(prices)) {
      errs.push(`${key}: prices phải là object`);
      return;
    }
    for (const [ch, p] of Object.entries(prices)) {
      if (!CHANNELS.includes(ch)) {
        errs.push(`${key}: kênh giá ${pyRepr(ch)} không hợp lệ`);
        continue;
      }
      if (!isDict(p)) {
        errs.push(`${key}/${ch}: giá phải là object`);
        continue;
      }
      let bad = false;
      for (const [k, v] of Object.entries(p)) {
        if (!KINDS.includes(k)) {
          errs.push(`${key}/${ch}: loại giá ${pyRepr(k)} không hợp lệ`);
          bad = true;
        } else if (!isPyInt(v) || v <= 0) {
          errs.push(`${key}/${ch}: giá ${k}=${py(v)} phải nguyên dương`);
          bad = true;
        }
      }
      if (!bad) errs.push(...checkPrices(key, ch, p as Record<string, number>));
    }
  });
  return errs;
}

// ---------------------------------------------------------------- scenario

type Event = [string, Map<string, Levels>, Set<string> | null];
export type Assumptions = {
  status: string;
  trend: Levels;
  baseline: Record<string, Record<string, number>>;
  events: Event[];
};

export function tetDate(year: unknown): string {
  // int thật (không bool/float/list) — 2027.0 bị chặn như Python.
  if (!isPyInt(year) || !Object.hasOwn(TET_DATES, year)) {
    throw new ScenarioError(`chưa có ngày Tết năm ${pyStrV(year)} trong TET_DATES`);
  }
  return TET_DATES[year] as string;
}

/** Thứ Hai của tuần chứa d. */
export const weekStart = (d: string): string => addDays(d, -weekday(d));

function num(v: unknown, where: string): number {
  if (!(isPyInt(v) || v instanceof PyFloat)) throw new ScenarioError(`${where}: phải là số`);
  const f = v instanceof PyFloat ? v.v : v;
  if (!Number.isFinite(f) || f < 0) throw new ScenarioError(`${where}: phải là số hữu hạn >= 0`);
  return f;
}

function levels(row: unknown, where: string): Levels {
  if (!isDict(row)) throw new ScenarioError(`${where}: phải là object low/base/high`);
  const v = Object.fromEntries(
    LEVELS.map((lv) => [lv, num(get(row, lv), `${where}.${lv}`)]),
  ) as Levels;
  if (!(v.low <= v.base && v.base <= v.high)) {
    throw new ScenarioError(`${where}: phải low <= base <= high`);
  }
  return v;
}

function eventDate(ev: Record<string, unknown>, where: string): string {
  const hasD = Object.hasOwn(ev, 'date');
  const hasT = Object.hasOwn(ev, 'lunar_new_year');
  if (hasD === hasT)
    throw new ScenarioError(`${where}: cần đúng 1 trong 'date' / 'lunar_new_year'`);
  if (hasT) return tetDate(ev.lunar_new_year);
  // shortcut: chỉ dạng YYYY-MM-DD (Python 3.11+ fromisoformat nhận cả YYYYMMDD / tuần ISO) — chặt hơn.
  const d = ev.date;
  if (typeof d !== 'string' || parseDay(d) === null) {
    throw new ScenarioError(`${where}.date: không phải ngày ISO`);
  }
  if (!(DATE_MIN <= d && d <= DATE_MAX)) {
    throw new ScenarioError(`${where}.date: phải trong ${DATE_MIN}..${DATE_MAX}`);
  }
  return d;
}

/** Validate + chuẩn hóa → Assumptions | ScenarioError. */
export function validateAssumptions(doc: unknown): Assumptions {
  if (!isDict(doc)) throw new ScenarioError('giả định: root phải là object');
  if (!Object.keys(doc).some((k) => k !== '_doc')) {
    throw new ScenarioError('giả định: không có dữ liệu (0 record)');
  }
  const status = doc.status;
  if (typeof status !== 'string' || !pyStrip(status))
    throw new ScenarioError("giả định: thiếu 'status'");
  const trend = levels(get(doc, 'trend'), 'trend');
  const base = get(doc, 'baseline_units_per_week');
  if (!isDict(base) || !Object.keys(base).length) {
    throw new ScenarioError("giả định: 'baseline_units_per_week' rỗng/thiếu");
  }
  const baseline: Record<string, Record<string, number>> = {};
  for (const [sku, chans] of Object.entries(base)) {
    if (!isDict(chans) || !Object.keys(chans).length) {
      throw new ScenarioError(`baseline.${sku}: phải là object kênh -> số`);
    }
    for (const [ch, v] of Object.entries(chans)) {
      if (!ALL_CHANNELS.includes(ch))
        throw new ScenarioError(`baseline.${sku}.${ch}: kênh không hợp lệ`);
      baseline[sku] = { ...baseline[sku], [ch]: num(v, `baseline.${sku}.${ch}`) };
    }
  }
  const raw = get(doc, 'events');
  if (!Array.isArray(raw)) throw new ScenarioError("giả định: 'events' phải là list");
  const events: Event[] = [];
  const ids = new Set<string>();
  raw.forEach((ev, i) => {
    const where = `events[${i}]`;
    if (!isDict(ev)) throw new ScenarioError(`${where}: phải là object`);
    const eid = get(ev, 'id');
    if (typeof eid !== 'string' || !eid || ids.has(eid)) {
      throw new ScenarioError(`${where}.id: thiếu hoặc trùng`);
    }
    ids.add(eid);
    const ws = weekStart(eventDate(ev, where));
    let chans: Set<string> | null = null;
    const c = get(ev, 'channels');
    if (c !== undefined && c !== null) {
      // Sự kiện chỉ áp cho 1 số kênh (11.11/12.12 = ngày sale sàn). Thiếu key = mọi kênh.
      if (
        !Array.isArray(c) ||
        !c.length ||
        !c.every((x) => typeof x === 'string' && ALL_CHANNELS.includes(x)) ||
        new Set(c).size !== c.length
      ) {
        throw new ScenarioError(
          `${where}.channels: phải là list kênh hợp lệ, không rỗng, không trùng`,
        );
      }
      chans = new Set(c as string[]);
    }
    const win = get(ev, 'window');
    if (!Array.isArray(win) || !win.length) throw new ScenarioError(`${where}.window: rỗng/thiếu`);
    const weeks = new Map<string, Levels>();
    win.forEach((row, j) => {
      const off = isDict(row) ? get(row, 'offset') : undefined;
      if (!isPyInt(off) || Math.abs(off) > MAX_WEEKS) {
        throw new ScenarioError(
          `${where}.window[${j}].offset: phải là int trong -${MAX_WEEKS}..${MAX_WEEKS}`,
        );
      }
      const w = addDays(ws, 7 * off);
      if (weeks.has(w)) throw new ScenarioError(`${where}.window[${j}].offset: trùng`);
      weeks.set(w, levels(row, `${where}.window[${j}]`));
    });
    events.push([eid, weeks, chans]);
  });
  return { status, trend, baseline, events };
}

/** Đọc + validate file giả định. Mọi biến thể 'không có dữ liệu' → ScenarioError. */
export function loadAssumptions(path: string = ASSUMPTIONS_FILE): Assumptions {
  const name = path.split(/[\\/]/).pop() as string;
  let text: string;
  try {
    text = readUtf8Sig(path);
  } catch (e) {
    const t = e instanceof PyReadError ? e.pyType : 'OSError';
    if (t === 'FileNotFoundError') throw new ScenarioError(`thiếu file giả định ${name}`);
    throw new ScenarioError(`không đọc được ${name} (${t})`);
  }
  if (!pyStrip(text)) throw new ScenarioError(`${name} rỗng`);
  let doc: unknown;
  try {
    doc = parsePyJson(text); // NaN/Infinity: JSON.parse từ chối như parse_constant của Python
  } catch (e) {
    throw new ScenarioError(`${name} JSON hỏng: ${(e as Error).message}`);
  }
  return validateAssumptions(doc);
}

export type Sku = Record<string, unknown> & { sku_key: string };
export type WeekRow = Levels & { week_start: string; events: string[]; note: string | null };

export function project(
  sku: Sku,
  channel: string,
  start: string,
  weeks: number,
  a: Assumptions,
): WeekRow[] {
  if (!ALL_CHANNELS.includes(channel)) throw new ScenarioError(`kênh '${channel}' không hợp lệ`);
  if (!isPyInt(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    throw new ScenarioError(`weeks phải trong 1..${MAX_WEEKS}`);
  }
  if (typeof start !== 'string' || parseDay(start) === null) {
    throw new ScenarioError('start phải là date');
  }
  if (!isDict(sku) || !sku.sku_key) throw new ScenarioError('sku thiếu sku_key');
  const key = sku.sku_key;
  let note: string | null = null;
  if (CHANNELS.includes(channel)) {
    if (sku.category === 'alcohol') note = NOTE_ALCOHOL;
    else if (!(Array.isArray(sku.allowed_channels) ? sku.allowed_channels : []).includes(channel)) {
      note = NOTE_NOT_ALLOWED;
    }
  }
  let b = 0;
  if (note === null) {
    const v = a.baseline[key]?.[channel];
    if (v === undefined) throw new ScenarioError(`thiếu baseline cho ${key} × ${channel}`);
    b = v;
  }
  if (!(DATE_MIN <= start && start <= DATE_MAX)) {
    throw new ScenarioError(`start phải trong ${DATE_MIN}..${DATE_MAX}`);
  }
  const w0 = weekStart(start);
  const out: WeekRow[] = [];
  for (let i = 0; i < weeks; i++) {
    const w = addDays(w0, 7 * i);
    const hits = a.events.filter(([, wk, ch]) => wk.has(w) && (ch === null || ch.has(channel)));
    const row = { week_start: w, events: hits.map(([eid]) => eid), note } as WeekRow;
    for (const lv of LEVELS) {
      if (note !== null) {
        row[lv] = 0;
        continue;
      }
      const f = hits.length ? Math.max(...hits.map(([, wk]) => (wk.get(w) as Levels)[lv])) : 1.0;
      let x = b * a.trend[lv] * f;
      if (!Number.isFinite(x)) {
        throw new ScenarioError(`${key} × ${channel}: kết quả tràn số (giả định quá lớn)`);
      }
      // round 6 số lẻ khử nhiễu float (20*1.15=22.999...) trước khi làm tròn bất đối xứng:
      // thấp=floor, cao=ceil, cơ sở=nửa-lên. toFixed làm tròn từ giá trị nhị phân đúng như
      // round(x, 6); hòa đúng nửa (chỉ ở số dyadic) không bao giờ vượt qua số nguyên.
      x = Number(x.toFixed(6));
      row[lv] = lv === 'low' ? Math.floor(x) : lv === 'high' ? Math.ceil(x) : Math.floor(x + 0.5);
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- tồn + thiếu

export type StockEntry = {
  qty: number;
  kho: Record<string, { qty: number; captured_at: string; stale: boolean }>;
  stale: string[];
  sample: boolean;
};

/** `inventory_csv.current_stock`: mỗi (sku, kho) lấy dòng captured_at mới nhất (hòa → id lớn
 * nhất); `stale` = dòng đó KHÔNG thuộc FILE mới nhất của CÙNG kho. SKU không có dòng → không có key
 * (caller coi là "chưa có số tồn", KHÔNG = 0). */
export async function currentStock(db: Db): Promise<Record<string, StockEntry>> {
  const out: Record<string, StockEntry> = {};
  const { rows } = await db.query(
    'select distinct on (sku_key, kho) sku_key, kho, qty, captured_at::text as day, source,' +
      ' captured_at < max(captured_at) over w or file_sha256 <> first_value(file_sha256) over w as stale' +
      ' from inventory_snapshots' +
      ' window w as (partition by kho order by captured_at desc, id desc rows between unbounded preceding and unbounded following)' +
      ' order by sku_key, kho, captured_at desc, id desc',
  );
  for (const r of rows) {
    const s = out[r.sku_key] ?? { qty: 0, kho: {}, stale: [], sample: false };
    out[r.sku_key] = s;
    s.qty += r.qty;
    s.kho[r.kho] = { qty: r.qty, captured_at: r.day, stale: Boolean(r.stale) };
    if (r.stale) s.stale.push(r.kho);
    s.sample = s.sample || r.source === 'sample';
  }
  return out;
}

/** → [mức, chữ] — mức 'low' | 'base' | 'high' | null. stock null → chưa có số tồn ≠ thiếu. */
export function shortage(stock: number | null, sums: Levels): [string | null, string | null] {
  if (stock === null) return [null, null];
  const gap = sums.base - stock;
  if (sums.low > stock) return ['low', `THIẾU CẢ KỊCH BẢN THẤP (thiếu ${gap} so với cơ sở)`];
  if (gap > 0) return ['base', `THIẾU (cơ sở) ${gap}`];
  if (sums.high > stock) {
    return ['high', `RỦI RO (kịch bản cao) thiếu ${sums.high - stock} nếu bán theo mức cao`];
  }
  return [null, null];
}
