import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { addDays, parseDay } from '@samsam/core/ops/period';
import {
  isDict,
  isPyInt,
  PyFloat,
  parsePyJson,
  pyFloatStr,
  pyOsName,
} from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import {
  DATE_MAX,
  DATE_MIN,
  CHANNELS as GOLDEN_CHANNELS,
  ScenarioError,
  tetDate,
} from '../sales_director/kd-forecast.deps.js';

// Phần loader + validate của `pipelines/mkt_calendar.py` (lịch mùa `data/marketing_calendar.json`)
// mà KD-A5 dùng: `su_kien` của kế hoạch KM + mục "Sự kiện mùa" của báo cáo. Lịch hỏng → lỗi, không
// bao giờ "lịch rỗng câm" (fail-closed).
// shortcut: bản riêng của nhóm kd_price (engine lịch MKT-01 chưa port) — khi nhóm marketing port
// `pipelines/mkt_calendar.py` thì import dùng chung, xóa tệp này.

export const CALENDAR_FILE = dataPath('marketing_calendar.json');
export const FORMATS = ['listing', 'post', 'ads', 'koc', 'livestream'];
export const KINDS = ['sale', 'holiday', 'tet', 'harvest'];
export const DAILY_MAX = 9;
export const DAILY_CHANNELS = ['facebook', 'zalo', 'tiktok', 'web'];
const ID_SRC = '[a-z0-9][a-z0-9._-]{0,39}';
const ID_RE = new RegExp(`^${ID_SRC}$`);
const ISO_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

/** Lịch mùa vụ thiếu/hỏng/sai luật (Python `CalendarError(ValueError)`). */
export class CalendarError extends RangeError {
  override name = 'CalendarError';
}

type Dict = Record<string, unknown>;
export type CalEvent = Dict & { id: string };
export type Calendar = Dict & { events: CalEvent[] };

/** Python `repr()` của giá trị JSON đọc bằng `parsePyJson`. */
export function reprV(v: unknown): string {
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (typeof v === 'string') return pyRepr(v);
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return `[${v.map(reprV).join(', ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v)
      .map(([k, x]) => `${pyRepr(k)}: ${reprV(x)}`)
      .join(', ')}}`;
  }
  return String(v);
}

const tuple = (xs: readonly string[]) => `(${xs.map(pyRepr).join(', ')})`;
const get = (d: Dict, k: string) => (Object.hasOwn(d, k) ? d[k] : undefined);

function int(v: unknown, where: string, lo: number, hi: number): number {
  if (!isPyInt(v) || v < lo || v > hi) {
    throw new CalendarError(`${where}: phải là số nguyên ${lo}..${hi}, nhận ${reprV(v ?? null)}`);
  }
  return v;
}

function iso(v: unknown, where: string): string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) {
    throw new CalendarError(`${where}: cần ngày YYYY-MM-DD, nhận ${reprV(v ?? null)}`);
  }
  if (parseDay(v) === null) throw new CalendarError(`${where}: ngày không hợp lệ ${reprV(v)}`);
  return v;
}

function id(v: unknown, where: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) {
    throw new CalendarError(`${where}: id phải khớp ${ID_SRC}`);
  }
  return v;
}

/** Ngày dương lịch của sự kiện. Tết qua `scenario.tet_date` — năm ngoài TET_DATES → lỗi (không đoán). */
export function eventDate(ev: unknown): string {
  if (!isDict(ev)) throw new CalendarError('sự kiện phải là object');
  const where = `events[${reprV(get(ev, 'id') ?? null)}]`;
  const hasD = Object.hasOwn(ev, 'date');
  const hasT = Object.hasOwn(ev, 'lunar_new_year');
  if (hasD === hasT)
    throw new CalendarError(`${where}: cần đúng 1 trong 'date' / 'lunar_new_year'`);
  let d: string;
  if (hasT) {
    try {
      d = tetDate(ev.lunar_new_year);
    } catch (e) {
      if (e instanceof ScenarioError) throw new CalendarError(`${where}: ${e.message}`);
      throw e;
    }
  } else {
    d = iso(ev.date, `${where}.date`);
    if (!(DATE_MIN <= d && d <= DATE_MAX)) {
      throw new CalendarError(`${where}.date: ngoài ${DATE_MIN}..${DATE_MAX}`);
    }
  }
  const off = Object.hasOwn(ev, 'offset_days') ? ev.offset_days : 0;
  return addDays(d, int(off, `${where}.offset_days`, -60, 60));
}

function skusOk(s: unknown): boolean {
  return s === 'auto' || (Array.isArray(s) && s.every((x) => typeof x === 'string' && x !== ''));
}

const strOk = (v: unknown) => typeof v === 'string' && pyStrip(v) !== '';

function validateDaily(dp: unknown): void {
  if (dp === undefined || dp === null) return;
  if (!isDict(dp)) throw new CalendarError('daily_posts phải là object');
  int(get(dp, 'per_day'), 'daily_posts.per_day', 1, DAILY_MAX);
  const ev = get(dp, 'evergreen');
  if (!Array.isArray(ev) || !ev.length) throw new CalendarError('daily_posts.evergreen rỗng');
  const ids = new Set<string>();
  ev.forEach((e, i) => {
    const where = `daily_posts.evergreen[${i}]`;
    if (!isDict(e)) throw new CalendarError(`${where}: phải là object`);
    const eid = id(get(e, 'id'), `${where}.id`);
    if (ids.has(eid)) throw new CalendarError(`${where}: id trùng '${eid}'`);
    ids.add(eid);
    if (!DAILY_CHANNELS.includes(get(e, 'channel') as string)) {
      throw new CalendarError(`${where}: channel phải ∈ ${tuple(DAILY_CHANNELS)}`);
    }
    if (!strOk(get(e, 'pillar'))) throw new CalendarError(`${where}: thiếu 'pillar'`);
    if (!skusOk(get(e, 'skus'))) {
      throw new CalendarError(`${where}: skus phải 'auto' hoặc list sku_key ([] = không gắn SKU)`);
    }
  });
}

/** `mkt_calendar.validate` → lịch | CalendarError. */
export function validate(cal: unknown): Calendar {
  if (!isDict(cal)) throw new CalendarError('lịch phải là object JSON');
  if (!strOk(get(cal, 'status'))) throw new CalendarError("thiếu 'status' (GIẢ ĐỊNH / đã chốt)");
  const lead = get(cal, 'lead');
  if (!isDict(lead)) throw new CalendarError("thiếu 'lead'");
  int(get(lead, 'publish_hour'), 'lead.publish_hour', 0, 23);
  int(get(lead, 'approve_buffer_hours'), 'lead.approve_buffer_hours', 1, 720);
  int(get(lead, 'draft_review_hours'), 'lead.draft_review_hours', 1, 720);
  const ws = int(get(lead, 'work_start_hour'), 'lead.work_start_hour', 0, 23);
  const we = int(get(lead, 'work_end_hour'), 'lead.work_end_hour', 0, 23);
  if (ws >= we) throw new CalendarError('lead: work_start_hour phải < work_end_hour');
  const nwd = Object.hasOwn(cal, 'non_working_days') ? cal.non_working_days : [];
  if (!Array.isArray(nwd)) throw new CalendarError('non_working_days phải là list');
  for (const [i, d] of nwd.entries()) iso(d, `non_working_days[${i}]`);
  const rd = get(cal, 'reminder_days');
  if (!Array.isArray(rd) || !rd.length) throw new CalendarError('reminder_days rỗng');
  for (const [i, n] of rd.entries()) int(n, `reminder_days[${i}]`, 1, 60);
  const caps = get(cal, 'review_caps');
  if (!isDict(caps)) throw new CalendarError("thiếu 'review_caps'");
  int(get(caps, 'gd_marketing_daily'), 'review_caps.gd_marketing_daily', 0, 500);

  const events = get(cal, 'events');
  if (!Array.isArray(events) || !events.length) throw new CalendarError('events rỗng');
  const evIds = new Set<string>();
  events.forEach((ev, i) => {
    const where = `events[${i}]`;
    if (!isDict(ev)) throw new CalendarError(`${where}: phải là object`);
    const eid = id(get(ev, 'id'), `${where}.id`);
    if (evIds.has(eid)) throw new CalendarError(`${where}: id sự kiện trùng '${eid}'`);
    evIds.add(eid);
    if (!KINDS.includes(get(ev, 'kind') as string)) {
      throw new CalendarError(`${where}: kind phải ${tuple(KINDS)}`);
    }
    if (typeof get(ev, 'remind') !== 'boolean')
      throw new CalendarError(`${where}: remind phải true/false`);
    const st = get(ev, 'status');
    if (ev.kind === 'harvest' && !(typeof st === 'string' && st.includes('GIẢ ĐỊNH'))) {
      throw new CalendarError(
        `${where}: mùa thu hoạch thiếu 'status' GIẢ ĐỊNH (chờ GĐ vùng trồng xác nhận)`,
      );
    }
    const offs = Object.hasOwn(ev, 'off_days') ? ev.off_days : [];
    if (!Array.isArray(offs)) throw new CalendarError(`${where}.off_days phải là list`);
    for (const [j, o] of offs.entries()) int(o, `${where}.off_days[${j}]`, -15, 15);
    eventDate(ev);
  });

  const camps = get(cal, 'campaigns');
  if (!Array.isArray(camps) || !camps.length) throw new CalendarError('campaigns rỗng');
  const cIds = new Set<string>();
  camps.forEach((c, i) => {
    const where = `campaigns[${i}]`;
    if (!isDict(c)) throw new CalendarError(`${where}: phải là object`);
    const cid = id(get(c, 'id'), `${where}.id`);
    if (cIds.has(cid)) throw new CalendarError(`${where}: id chiến dịch trùng '${cid}'`);
    cIds.add(cid);
    const ev = get(c, 'event');
    if (typeof ev !== 'string' || !evIds.has(ev)) {
      throw new CalendarError(`${where}: event ${reprV(ev ?? null)} không có trong events`);
    }
    int(get(c, 'publish_offset_days'), `${where}.publish_offset_days`, -60, 0);
    const chs = get(c, 'channels');
    if (!Array.isArray(chs) || !chs.length || chs.some((ch) => !GOLDEN_CHANNELS.includes(ch))) {
      throw new CalendarError(`${where}: channels phải ⊆ ${tuple(GOLDEN_CHANNELS)}, không rỗng`);
    }
    const fmts = get(c, 'formats');
    if (!Array.isArray(fmts) || !fmts.length || fmts.some((f) => !FORMATS.includes(f))) {
      throw new CalendarError(`${where}: formats phải ⊆ ${tuple(FORMATS)}, không rỗng`);
    }
    if (!skusOk(get(c, 'skus')))
      throw new CalendarError(`${where}: skus phải 'auto' hoặc list sku_key`);
    if (!strOk(get(c, 'pillar'))) throw new CalendarError(`${where}: thiếu 'pillar'`);
  });
  validateDaily(get(cal, 'daily_posts'));
  return cal as Calendar;
}

/** `mkt_calendar.load_calendar` → lịch | CalendarError.
 * Khác Python có chủ đích: thông điệp "JSON hỏng" nêu tên lỗi, không nêu dòng/cột (JS không cho cùng
 * câu của `json.JSONDecodeError`) — vẫn exit 1 như Python. */
export function loadCalendar(path: string = CALENDAR_FILE): Calendar {
  const name = basename(path);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    const t = pyOsName(e);
    throw new CalendarError(
      t === 'FileNotFoundError' ? `không có file ${name}` : `${name} không đọc được: ${t}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // bỏ BOM = utf-8-sig
  } catch {
    throw new CalendarError(`${name} không phải UTF-8`);
  }
  if (!pyStrip(text)) throw new CalendarError(`${name} rỗng`);
  let cal: unknown;
  try {
    cal = parsePyJson(text);
  } catch {
    throw new CalendarError(`${name} JSON hỏng: JSONDecodeError`);
  }
  return validate(cal);
}
