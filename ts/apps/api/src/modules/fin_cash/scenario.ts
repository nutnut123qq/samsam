import { basename } from 'node:path';
import { addDays, weekday } from '@samsam/core/ops/period';
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
import { pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';

// Port `pipelines/scenario.py` (v7.3, WP09 Season Forecast) — engine kịch bản mùa DÙNG CHUNG.
// KD-A10 (dự báo mùa), SX-A3 (phân bổ tồn Tết) và FP-Cash (dòng tiền 13 tuần × 3 kịch bản) GỌI LẠI
// `project()` — không viết lại công thức. Hàm THUẦN: không DB/LLM/mạng/đồng hồ (đọc đồng hồ chỉ ở
// lệnh CLI). Kết quả luôn là KHOẢNG thấp/cơ sở/cao — không bao giờ 1 con số.
// Công thức: baseline[sku][kênh] × trend[mức] × max(hệ số sự kiện[mức] các sự kiện phủ tuần đó,
// mặc định 1) — chồng tuần lấy MAX (không nhân chồng), làm tròn bất đối xứng: thấp = floor, cơ sở =
// floor(x+0.5), cao = ceil. Sự kiện có `channels` chỉ áp cho các kênh đó (11.11/12.12 = sale sàn).
// Luật kênh (TRƯỚC tra baseline): rượu × kênh online → 0 BẤT KỂ allowed_channels; SKU không rượu ×
// kênh online ngoài allowed_channels → 0 + ghi chú; `offline` tính cho mọi SKU; thiếu baseline cho
// SKU × kênh được phép → lỗi (không coi = 0).
// Ngày = chuỗi 'YYYY-MM-DD' (Python `date`). Đây là bản CHUẨN của nhóm sở hữu scenario.py — bản tạm
// `garden_director/scenario.ts`, `sales_director/kd-forecast.deps.ts` gom về đây ở bước tích hợp.

export const ASSUMPTIONS_FILE = dataPath('scenario_assumptions.json');
export const LEVELS = ['low', 'base', 'high'] as const;
export type Level = (typeof LEVELS)[number];
export type Levels = Record<Level, number>;
export const OFFLINE = 'offline';
/** `golden_store.CHANNELS` — kênh online. */
export const CHANNELS = ['shopee', 'tiktok', 'web', 'facebook', 'zalo', 'chatbot'] as const;
export const ALL_CHANNELS: readonly string[] = [...CHANNELS, OFFLINE];
export const MAX_WEEKS = 104;
// Khung ngày hợp lệ cho start/ngày sự kiện (ngày sát biên `date` cộng offset tuần → tràn).
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2100-12-31';
// Mùng 1 Tết Âm lịch (dương lịch) — Bính Ngọ 17/02/2026, Đinh Mùi 06/02/2027, Mậu Thân 26/01/2028.
// Năm ngoài bảng → lỗi rõ, không đoán.
export const TET_DATES: Readonly<Record<number, string>> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
};
export const NOTE_ALCOHOL = 'rượu: chỉ kênh offline';
export const NOTE_NOT_ALLOWED = 'kênh chưa có trong allowed_channels (golden)';

/** Config/tham số kịch bản không dùng được — fail-closed (Python `ScenarioError(ValueError)`). */
export class ScenarioError extends RangeError {
  override name = 'ScenarioError';
}

const isOnline = (ch: unknown): boolean => (CHANNELS as readonly unknown[]).includes(ch);
const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k);
const get = (o: Record<string, unknown>, k: string): unknown => (has(o, k) ? o[k] : undefined);
/** Python `str(v)` cho giá trị JSON đã đọc bằng `parsePyJson` (float → `2027.0`). */
const strV = (v: unknown): string => (v instanceof PyFloat ? pyFloatStr(v.v) : pyStr(v));

// ---------------------------------------------------------------- ngày (Python `date`)

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Ngày hợp lệ y/m/d (lịch Gregory, năm 1..9999) → 'YYYY-MM-DD' | null. */
function ymd(y: number, m: number, d: number): string | null {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return d > dim ? null : `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** ms UTC 00:00 của ngày (setUTCFullYear — không dịch năm < 100 như `Date.UTC`). */
function dayMs(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime();
}

function msDay(ms: number): string {
  const t = new Date(ms);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const YMD_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$|^([0-9]{4})([0-9]{2})([0-9]{2})$/;
const WEEK_RE = /^([0-9]{4})-W([0-9]{2})(?:-([0-9]))?$|^([0-9]{4})W([0-9]{2})([0-9])?$/;

/** Python 3.12 `date.fromisoformat(s)` → 'YYYY-MM-DD' | null (YYYY-MM-DD, YYYYMMDD, YYYY-Www[-D],
 * YYYYWww[D]; chữ số ASCII). */
export function isoDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  let m = YMD_RE.exec(s);
  if (m) {
    const [y, mo, d] = (m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]]).map(Number) as number[];
    return ymd(y as number, mo as number, d as number);
  }
  m = WEEK_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1] ?? m[4]);
  const w = Number(m[2] ?? m[5]);
  const dow = Number(m[3] ?? m[6] ?? 1);
  if (y < 1) return null;
  const jan1 = (new Date(dayMs(y, 1, 1)).getUTCDay() + 6) % 7; // 0 = thứ Hai
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const maxW = jan1 === 3 || (leap && jan1 === 2) ? 53 : 52;
  if (w < 1 || w > maxW || dow < 1 || dow > 7) return null;
  // thứ Hai tuần 1 = thứ Hai của tuần chứa 4/1
  const jan4 = dayMs(y, 1, 4);
  const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return msDay(jan4 + (-jan4Dow + (w - 1) * 7 + (dow - 1)) * 86_400_000);
}

/** Chuỗi 'YYYY-MM-DD' là một `date` hợp lệ (kể cả năm < 2000 — biên kiểm riêng). */
export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && isoDate(s) === s;

const inRange = (d: string): boolean => DATE_MIN <= d && d <= DATE_MAX;

export function tetDate(year: unknown): string {
  // int thật (không bool/float/list): 2027.0 bị chặn TRƯỚC khi tra bảng như Python.
  if (!isPyInt(year) || !has(TET_DATES as Record<string, unknown>, String(year))) {
    throw new ScenarioError(`chưa có ngày Tết năm ${strV(year)} trong TET_DATES`);
  }
  return TET_DATES[year] as string;
}

/** Thứ Hai của tuần chứa `d` (ngày trong khung DATE_MIN..DATE_MAX ± 2 năm). */
export const weekStart = (d: string): string => addDays(d, -weekday(d));

// ---------------------------------------------------------------- validate giả định

function num(v: unknown, where: string): number {
  if (!(isPyInt(v) || v instanceof PyFloat || typeof v === 'number')) {
    throw new ScenarioError(`${where}: phải là số`);
  }
  const f = v instanceof PyFloat ? v.v : (v as number);
  // số nguyên khổng lồ (10**400) JSON.parse thành Infinity — Python: float() OverflowError
  if (typeof v === 'number' && !Number.isFinite(f) && !Number.isNaN(f)) {
    throw new ScenarioError(`${where}: số quá lớn`);
  }
  if (!Number.isFinite(f) || f < 0) throw new ScenarioError(`${where}: phải là số hữu hạn >= 0`);
  return f;
}

function levels(row: unknown, where: string): Levels {
  if (!isDict(row)) throw new ScenarioError(`${where}: phải là object low/base/high`);
  const v = {} as Levels;
  for (const lv of LEVELS) v[lv] = num(get(row, lv), `${where}.${lv}`);
  if (!(v.low <= v.base && v.base <= v.high)) {
    throw new ScenarioError(`${where}: phải low <= base <= high`);
  }
  return v;
}

function eventDate(ev: Record<string, unknown>, where: string): string {
  const hasD = has(ev, 'date');
  const hasT = has(ev, 'lunar_new_year');
  if (hasD === hasT) {
    throw new ScenarioError(`${where}: cần đúng 1 trong 'date' / 'lunar_new_year'`);
  }
  if (hasT) return tetDate(ev.lunar_new_year);
  const d = isoDate(ev.date);
  if (d === null) throw new ScenarioError(`${where}.date: không phải ngày ISO`);
  if (!inRange(d)) throw new ScenarioError(`${where}.date: phải trong ${DATE_MIN}..${DATE_MAX}`);
  return d;
}

export type ScenarioEvent = [id: string, weeks: Map<string, Levels>, channels: Set<string> | null];
export type Assumptions = {
  status: string;
  trend: Levels;
  baseline: Record<string, Record<string, number>>;
  events: ScenarioEvent[];
};
// Dấu "đã validate" — object riêng, JSON không giả được (doc thô ghi "_validated" vẫn validate lại).
const VALIDATED = new WeakSet<object>();

/** Validate + chuẩn hóa. Sai → ScenarioError. */
export function validateAssumptions(doc: unknown): Assumptions {
  if (!isDict(doc)) throw new ScenarioError('giả định: root phải là object');
  if (!Object.keys(doc).some((k) => k !== '_doc')) {
    throw new ScenarioError('giả định: không có dữ liệu (0 record)');
  }
  const status = get(doc, 'status');
  if (typeof status !== 'string' || !pyStrip(status)) {
    throw new ScenarioError("giả định: thiếu 'status'");
  }
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
      if (!ALL_CHANNELS.includes(ch)) {
        throw new ScenarioError(`baseline.${sku}.${ch}: kênh không hợp lệ`);
      }
      baseline[sku] ??= {};
      (baseline[sku] as Record<string, number>)[ch] = num(v, `baseline.${sku}.${ch}`);
    }
  }
  const raw = get(doc, 'events');
  if (!Array.isArray(raw)) throw new ScenarioError("giả định: 'events' phải là list");
  const events: ScenarioEvent[] = [];
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
      // Sự kiện chỉ áp cho 1 số kênh (11.11/12.12 = ngày sale sàn, không đẩy cầu đại lý offline).
      // Thiếu key = mọi kênh.
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
  const out: Assumptions = { status, trend, baseline, events };
  VALIDATED.add(out);
  return out;
}

/**
 * Đọc + validate file giả định. Mọi biến thể "không có dữ liệu" (thiếu / rỗng / JSON hỏng / `{}` /
 * chỉ `_doc`) → ScenarioError. KHÁC Python có chủ đích: chữ sau "JSON hỏng:" là thông điệp của JS.
 */
export function loadAssumptions(path: string = ASSUMPTIONS_FILE): Assumptions {
  const name = basename(path);
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

/** Nhận bản đã validate (`loadAssumptions`/`validateAssumptions`) hoặc doc thô. */
export const normAssumptions = (a: unknown): Assumptions =>
  typeof a === 'object' && a !== null && VALIDATED.has(a)
    ? (a as Assumptions)
    : validateAssumptions(a);

// ---------------------------------------------------------------- project

/** Python `round(x, 6)`: toFixed làm tròn từ giá trị nhị phân chính xác — điểm giữa đúng ở 1e-7
 * không biểu diễn được trong nhị phân nên không lệch Python. */
const round6 = (x: number): number => Number(x.toFixed(6));

export type WeekRow = { week_start: string; events: string[]; note: string | null } & Levels;
export type Sku = Record<string, unknown>;

export function project(
  sku: unknown,
  channel: unknown,
  start: unknown,
  weeks: unknown,
  assumptions: unknown,
): WeekRow[] {
  if (!ALL_CHANNELS.includes(channel as string)) {
    throw new ScenarioError(`kênh '${pyStr(channel)}' không hợp lệ`);
  }
  if (!isPyInt(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    throw new ScenarioError(`weeks phải trong 1..${MAX_WEEKS}`);
  }
  if (!isDate(start)) throw new ScenarioError('start phải là date');
  if (!isDict(sku) || !pyTruthy(get(sku, 'sku_key'))) throw new ScenarioError('sku thiếu sku_key');
  const a = normAssumptions(assumptions);
  const ch = channel as string;
  const rawKey = sku.sku_key;
  const key = strV(rawKey);
  let note: string | null = null;
  if (isOnline(ch)) {
    const allowed = Array.isArray(sku.allowed_channels) ? sku.allowed_channels : [];
    if (sku.category === 'alcohol') note = NOTE_ALCOHOL;
    else if (!allowed.includes(ch)) note = NOTE_NOT_ALLOWED;
  }
  let b = 0;
  if (note === null) {
    // khóa baseline là chuỗi JSON — sku_key không phải chuỗi không bao giờ khớp (như dict Python)
    const v =
      typeof rawKey === 'string' && Object.hasOwn(a.baseline, rawKey)
        ? a.baseline[rawKey]?.[ch]
        : undefined;
    if (v === undefined) throw new ScenarioError(`thiếu baseline cho ${key} × ${ch}`);
    b = v;
  }
  if (!inRange(start)) throw new ScenarioError(`start phải trong ${DATE_MIN}..${DATE_MAX}`);
  const w0 = weekStart(start);
  const out: WeekRow[] = [];
  for (let i = 0; i < weeks; i++) {
    const w = addDays(w0, 7 * i);
    const hits = a.events.filter(([, wk, cs]) => wk.has(w) && (cs === null || cs.has(ch)));
    const row = { week_start: w, events: hits.map(([id]) => id), note } as WeekRow;
    for (const lv of LEVELS) {
      if (note !== null) {
        row[lv] = 0;
        continue;
      }
      const f = hits.length ? Math.max(...hits.map(([, wk]) => (wk.get(w) as Levels)[lv])) : 1.0;
      let x = b * a.trend[lv] * f;
      if (!Number.isFinite(x)) {
        throw new ScenarioError(`${key} × ${ch}: kết quả tràn số (giả định quá lớn)`);
      }
      // khử nhiễu float (20*1.15=22.999...) trước khi làm tròn bất đối xứng: thấp=floor, cao=ceil,
      // cơ sở=nửa-lên → vẫn đơn điệu VÀ thấp < cao khi trend.low < trend.high (baseline nhỏ không
      // sập khoảng thành 1 điểm).
      x = round6(x);
      row[lv] = lv === 'low' ? Math.floor(x) : lv === 'high' ? Math.ceil(x) : Math.floor(x + 0.5);
    }
    out.push(row);
  }
  return out;
}
