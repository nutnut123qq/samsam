import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { addDays, parseDay, weekday } from '@samsam/core/ops/period';
import { isoDate } from '@samsam/core/ops/py-date';
import { isPyInt, PyFloat, pyLoads, pyNum, reprV } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import { pyOsName } from '../garden_zalo/garden-media.js';

// shortcut: bản port TẠI CHỖ phần `pipelines/scenario.py` (validate/load/project/week_start) và
// `ingest/golden_store.py` (read_golden/validate) mà `vt_thuhoach` cần — chưa có module TS chung;
// khi nhóm scenario/golden_store port xong thì import từ đó và xóa tệp này (golden test giữ nguyên).
// Hàm THUẦN: không DB/LLM/mạng/đồng hồ. Kết quả luôn là KHOẢNG thấp/cơ sở/cao — không 1 con số.
// Công thức: baseline[sku][kênh] × trend[mức] × max(hệ số sự kiện[mức] phủ tuần, mặc định 1); làm tròn
// bất đối xứng (thấp floor, cơ sở nửa-lên, cao ceil) sau khi khử nhiễu 6 số lẻ. Rượu × kênh online
// → 0; kênh online ngoài allowed_channels → 0 + ghi chú; thiếu baseline kênh được phép → lỗi.
// Ngày = chuỗi 'YYYY-MM-DD' (Python `date`).

export const ASSUMPTIONS_FILE = dataPath('scenario_assumptions.json');
export const GOLDEN_FILE = dataPath('golden_skus.json');
export const LEVELS = ['low', 'base', 'high'] as const;
export type Level = (typeof LEVELS)[number];
export type Levels = Record<Level, number>;
export const OFFLINE = 'offline';
export const CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'] as const;
export const ALL_CHANNELS: readonly string[] = [...CHANNELS, OFFLINE];
export const MAX_WEEKS = 104;
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2100-12-31';
// Mùng 1 Tết Âm lịch (dương lịch) — năm ngoài bảng → lỗi rõ, không đoán.
export const TET_DATES: Readonly<Record<number, string>> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
};
export const NOTE_ALCOHOL = 'rượu: chỉ kênh offline';
export const NOTE_NOT_ALLOWED = 'kênh chưa có trong allowed_channels (golden)';

/** Config/tham số kịch bản không dùng được — fail-closed (Python ScenarioError(ValueError)). */
export class ScenarioError extends RangeError {
  override name = 'ScenarioError';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
const strOf = (v: unknown): string => (v instanceof PyFloat ? reprV(v) : pyStr(v));
const pyTuple = (xs: readonly string[]) => `(${xs.map(pyRepr).join(', ')})`;

export function tetDate(year: unknown): string {
  if (!isPyInt(year) || !Object.hasOwn(TET_DATES, year)) {
    throw new ScenarioError(`chưa có ngày Tết năm ${strOf(year)} trong TET_DATES`);
  }
  return TET_DATES[year] as string;
}

/** Thứ Hai của tuần chứa `d`. */
export const weekStart = (d: string): string => addDays(d, -weekday(d));

function num(v: unknown, where: string): number {
  const n = typeof v === 'boolean' ? null : pyNum(v);
  if (n === null) throw new ScenarioError(`${where}: phải là số`);
  if (!Number.isFinite(n) || n < 0) throw new ScenarioError(`${where}: phải là số hữu hạn >= 0`);
  return n;
}

function levels(row: unknown, where: string): Levels {
  if (!isObj(row)) throw new ScenarioError(`${where}: phải là object low/base/high`);
  const v = {} as Levels;
  for (const lv of LEVELS) v[lv] = num(row[lv], `${where}.${lv}`);
  if (!(v.low <= v.base && v.base <= v.high))
    throw new ScenarioError(`${where}: phải low <= base <= high`);
  return v;
}

function eventDate(ev: Record<string, unknown>, where: string): string {
  const hasD = Object.hasOwn(ev, 'date');
  const hasT = Object.hasOwn(ev, 'lunar_new_year');
  if (hasD === hasT)
    throw new ScenarioError(`${where}: cần đúng 1 trong 'date' / 'lunar_new_year'`);
  if (hasT) return tetDate(ev.lunar_new_year);
  const d = typeof ev.date === 'string' ? isoDate(ev.date) : null;
  if (d === null) throw new ScenarioError(`${where}.date: không phải ngày ISO`);
  if (d < DATE_MIN || d > DATE_MAX)
    throw new ScenarioError(`${where}.date: phải trong ${DATE_MIN}..${DATE_MAX}`);
  return d;
}

export type ScenarioEvent = [id: string, weeks: Map<string, Levels>, channels: Set<string> | null];
export type Assumptions = {
  status: string;
  trend: Levels;
  baseline: Record<string, Record<string, number>>;
  events: ScenarioEvent[];
};
// Dấu "đã validate" — doc thô ghi `_validated` vẫn bị validate lại.
const VALIDATED = new WeakSet<object>();

/** Validate + chuẩn hóa. Sai → ScenarioError. */
export function validateAssumptions(doc: unknown): Assumptions {
  if (!isObj(doc)) throw new ScenarioError('giả định: root phải là object');
  if (!Object.keys(doc).some((k) => k !== '_doc')) {
    throw new ScenarioError('giả định: không có dữ liệu (0 record)');
  }
  const status = doc.status;
  if (typeof status !== 'string' || !pyStrip(status))
    throw new ScenarioError("giả định: thiếu 'status'");
  const trend = levels(doc.trend, 'trend');
  const base = doc.baseline_units_per_week;
  if (!isObj(base) || !Object.keys(base).length) {
    throw new ScenarioError("giả định: 'baseline_units_per_week' rỗng/thiếu");
  }
  const baseline: Record<string, Record<string, number>> = {};
  for (const [sku, chans] of Object.entries(base)) {
    if (!isObj(chans) || !Object.keys(chans).length) {
      throw new ScenarioError(`baseline.${sku}: phải là object kênh -> số`);
    }
    for (const [ch, v] of Object.entries(chans)) {
      if (!ALL_CHANNELS.includes(ch))
        throw new ScenarioError(`baseline.${sku}.${ch}: kênh không hợp lệ`);
      baseline[sku] = { ...baseline[sku], [ch]: num(v, `baseline.${sku}.${ch}`) };
    }
  }
  const raw = doc.events;
  if (!Array.isArray(raw)) throw new ScenarioError("giả định: 'events' phải là list");
  const events: ScenarioEvent[] = [];
  const ids = new Set<string>();
  raw.forEach((ev, i) => {
    const where = `events[${i}]`;
    if (!isObj(ev)) throw new ScenarioError(`${where}: phải là object`);
    const eid = ev.id;
    if (typeof eid !== 'string' || !eid || ids.has(eid))
      throw new ScenarioError(`${where}.id: thiếu hoặc trùng`);
    ids.add(eid);
    const ws = weekStart(eventDate(ev, where));
    let chans: Set<string> | null = null;
    const c = ev.channels ?? null;
    if (c !== null) {
      // Sự kiện chỉ áp 1 số kênh (11.11/12.12 = sale sàn, không đẩy cầu đại lý offline). Thiếu = mọi kênh.
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
    const win = ev.window;
    if (!Array.isArray(win) || !win.length) throw new ScenarioError(`${where}.window: rỗng/thiếu`);
    const weeks = new Map<string, Levels>();
    win.forEach((row, j) => {
      const off = isObj(row) ? row.offset : undefined;
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
  const out: Assumptions = { status, trend, baseline, events };
  VALIDATED.add(out);
  return out;
}

/** Đọc + validate file giả định. Mọi biến thể 'không có dữ liệu' → ScenarioError. KHÁC Python có
 * chủ đích: thông điệp JSON hỏng là của JS. */
export function loadAssumptions(path: string = ASSUMPTIONS_FILE): Assumptions {
  const name = basename(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); // utf-8-sig
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT')
      throw new ScenarioError(`thiếu file giả định ${name}`);
    const t = e instanceof TypeError ? 'UnicodeDecodeError' : pyOsName(e);
    throw new ScenarioError(`không đọc được ${name} (${t})`);
  }
  if (!pyStrip(text)) throw new ScenarioError(`${name} rỗng`);
  let doc: unknown;
  try {
    doc = pyLoads(text); // NaN/Infinity: JSON.parse từ chối (Python chặn tường minh)
  } catch (e) {
    throw new ScenarioError(`${name} JSON hỏng: ${(e as Error).message}`);
  }
  return validateAssumptions(doc);
}

const norm = (a: unknown): Assumptions =>
  typeof a === 'object' && a !== null && VALIDATED.has(a)
    ? (a as Assumptions)
    : validateAssumptions(a);

/** Python `round(x, 6)`: toFixed dùng giá trị nhị phân chính xác — điểm giữa đúng không xảy ra ở 1e-7. */
export const round6 = (x: number): number => Number(x.toFixed(6));

export type ProjectRow = Levels & { week_start: string; events: string[]; note: string | null };
export type Sku = Record<string, unknown> & { sku_key?: unknown };

export function project(
  sku: Sku,
  channel: string,
  start: string,
  weeks: unknown,
  assumptions: unknown,
): ProjectRow[] {
  if (!ALL_CHANNELS.includes(channel)) throw new ScenarioError(`kênh '${channel}' không hợp lệ`);
  if (!isPyInt(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    throw new ScenarioError(`weeks phải trong 1..${MAX_WEEKS}`);
  }
  if (typeof start !== 'string' || parseDay(start) === null)
    throw new ScenarioError('start phải là date');
  if (!isObj(sku) || !pyTruthy(sku.sku_key)) throw new ScenarioError('sku thiếu sku_key');
  const a = norm(assumptions);
  const key = String(sku.sku_key);
  let note: string | null = null;
  if ((CHANNELS as readonly string[]).includes(channel)) {
    const allowed = Array.isArray(sku.allowed_channels) ? sku.allowed_channels : [];
    if (sku.category === 'alcohol') note = NOTE_ALCOHOL;
    else if (!allowed.includes(channel)) note = NOTE_NOT_ALLOWED;
  }
  const b = a.baseline[key]?.[channel];
  if (note === null && b === undefined)
    throw new ScenarioError(`thiếu baseline cho ${key} × ${channel}`);
  if (start < DATE_MIN || start > DATE_MAX)
    throw new ScenarioError(`start phải trong ${DATE_MIN}..${DATE_MAX}`);
  const w0 = weekStart(start);
  const out: ProjectRow[] = [];
  for (let i = 0; i < weeks; i++) {
    const w = addDays(w0, 7 * i);
    const hits = a.events.filter(([, wk, ch]) => wk.has(w) && (ch === null || ch.has(channel)));
    const row = { week_start: w, events: hits.map(([id]) => id), note } as ProjectRow;
    for (const lv of LEVELS) {
      if (note !== null) {
        row[lv] = 0;
        continue;
      }
      const f = hits.length ? Math.max(...hits.map(([, wk]) => (wk.get(w) as Levels)[lv])) : 1.0;
      let x = (b as number) * a.trend[lv] * f;
      if (!Number.isFinite(x))
        throw new ScenarioError(`${key} × ${channel}: kết quả tràn số (giả định quá lớn)`);
      // khử nhiễu float (20*1.15=22.999...) trước khi làm tròn bất đối xứng — đơn điệu, thấp < cao.
      x = round6(x);
      row[lv] = lv === 'low' ? Math.floor(x) : lv === 'high' ? Math.ceil(x) : Math.floor(x + 0.5);
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------- golden_store (đọc + validate)

/** `golden_store.read_golden` → [doc, null] | [null, lý do]. Mọi biến thể "không có dữ liệu" trả lý do. */
export function readGolden(
  path: string = GOLDEN_FILE,
): [Record<string, unknown> | null, string | null] {
  let raw: Buffer;
  try {
    if (!statSync(path).isFile()) return [null, `thiếu file ${path}`];
    raw = readFileSync(path);
  } catch {
    return [null, `thiếu file ${path}`];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ BOM
  } catch {
    return [null, `${path} không phải UTF-8`];
  }
  if (!pyStrip(text)) return [null, `${path} rỗng`];
  let doc: unknown;
  try {
    doc = pyLoads(text);
  } catch (e) {
    return [null, `${path} JSON hỏng: ${(e as Error).message}`];
  }
  if (!isObj(doc) || !pyTruthy(doc.skus))
    return [null, `${path} không có SKU nào (0 record) — không nạp`];
  return [doc, null];
}

const CATEGORIES = ['tpbvsk', 'food', 'alcohol'];
const XNQC = ['none', 'pending', 'approved'];
const KINDS = ['floor', 'list', 'promo'];
// Python `^...$`: `$` khớp cả trước '\n' cuối.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\n?$/;

function checkPrices(skuKey: string, channel: string, p: Record<string, unknown>): string[] {
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

/** `golden_store.validate`: schema + R1/R2/R3 → [] = hợp lệ. */
export function validateGolden(doc: unknown): string[] {
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
    } else if (seen.has(key)) errs.push(`${key}: sku_key trùng`);
    seen.add(key);
    if (typeof s.name !== 'string' || !pyStrip(s.name)) errs.push(`${key}: thiếu name`);
    if (!CATEGORIES.includes(s.category as string)) {
      errs.push(`${key}: category ${reprV(s.category ?? null)} không hợp lệ`);
    }
    const xn = Object.hasOwn(s, 'xnqc_status') ? s.xnqc_status : 'none';
    if (!XNQC.includes(xn as string))
      errs.push(`${key}: xnqc_status ${reprV(xn ?? null)} không hợp lệ`);
    const sd = s.self_declaration_ok ?? null;
    const sdN = typeof sd === 'boolean' ? null : pyNum(sd);
    if (!(sd === null || typeof sd === 'boolean' || sdN === 0 || sdN === 1)) {
      errs.push(`${key}: self_declaration_ok phải true/false/null`); // Python: 1 == True, 0 == False
    }
    for (const f of ['pack_spec', 'receipt_no', 'shopee_item_id', 'note']) {
      if ((s[f] ?? null) !== null && typeof s[f] !== 'string')
        errs.push(`${key}: ${f} phải là chuỗi hoặc null`);
    }
    const rd = s.receipt_date ?? null;
    if (rd !== null && (typeof rd !== 'string' || isoDate(rd) === null)) {
      errs.push(`${key}: receipt_date ${reprV(rd)} không phải ISO`);
    }
    const chans = Object.hasOwn(s, 'allowed_channels') ? s.allowed_channels : [];
    if (!Array.isArray(chans) || chans.some((c) => !(CHANNELS as readonly unknown[]).includes(c))) {
      errs.push(`${key}: allowed_channels phải ⊂ ${pyTuple(CHANNELS)}`);
    }
    let pids = Object.hasOwn(s, 'product_ids') ? s.product_ids : [];
    if (!Array.isArray(pids) || !pids.every((p) => typeof p === 'string' && p)) {
      errs.push(`${key}: product_ids phải là list chuỗi`);
      pids = [];
    }
    for (const p of pids as string[]) {
      if (owner.has(p)) errs.push(`${key}: product_id ${p} đã map cho ${owner.get(p)}`);
      else owner.set(p, key);
    }
    const prices = Object.hasOwn(s, 'prices') ? s.prices : {};
    if (!isObj(prices)) {
      errs.push(`${key}: prices phải là object`);
      return;
    }
    for (const [ch, p] of Object.entries(prices)) {
      if (!(CHANNELS as readonly string[]).includes(ch)) {
        errs.push(`${key}: kênh giá ${pyRepr(ch)} không hợp lệ`);
        continue;
      }
      if (!isObj(p)) {
        errs.push(`${key}/${ch}: giá phải là object`);
        continue;
      }
      let bad = false;
      for (const [k, v] of Object.entries(p)) {
        if (!KINDS.includes(k)) {
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
