import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { addDays, parseDay, vnDate, vnFormat, vnMidnight, weekday } from '@samsam/core/ops/period';
import { squash } from '@samsam/core/ops/py';
import {
  cpCmp,
  isDict,
  isPyInt,
  PyFloat,
  parsePyJson,
  pyFloatStr,
  pyOsName,
} from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dataPath } from '@samsam/core/paths';
import { readinessOf } from '@samsam/core/security/guardrail';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import {
  DATE_MAX,
  DATE_MIN,
  CHANNELS as GOLDEN_CHANNELS,
  readGolden,
  ScenarioError,
  tetDate,
  validateGolden,
  weekStart,
} from '../sales_director/kd-forecast.deps.js';

// Port `pipelines/mkt_calendar.py` — MKT-01 Agent Lịch mùa vụ (v6.0, WP08): lịch chiến dịch ĐỀ XUẤT.
// Hàm THUẦN (không DB, không LLM, không mạng, không đọc đồng hồ ngoài CLI): đọc
// `data/marketing_calendar.json` (GIẢ ĐỊNH — chờ GĐ Marketing chốt) + golden SKU → mỗi chiến dịch ×
// kênh × định dạng có SKU đủ readiness, mốc brief/nháp/duyệt/đăng LÙI từ ngày đăng theo SLA (giờ VN,
// né T7/CN/ngày nghỉ), nhắc trước 14/7/3 ngày; xuất markdown tuần/tháng + .ics.
// - Tết lấy từ `scenario.tet_date` (JSON ghi `lunar_new_year`) — không có ngày Tết thứ hai ở đây.
// - Rượu KHÔNG BAO GIỜ vào ô nào (mọi kênh golden đều online) — luôn vào `blocked`, kể cả golden ghi
//   `allowed_channels: ["shopee"]` (lệch đã biết v3.2).
// - Mốc chỉ LÙI (`toWorkday`). SLA brief đọc `data/directors/marketing.json` (`campaign_brief`).
// - Config hỏng → CalendarError, không bao giờ ra lịch rỗng câm.
// Ngày = chuỗi 'YYYY-MM-DD' (Python `date`), mốc = `Date` (VN = UTC+7 cố định).

export const CALENDAR_FILE = dataPath('marketing_calendar.json');
export const FORMATS = ['listing', 'post', 'ads', 'koc', 'livestream'];
export const KINDS = ['sale', 'holiday', 'tet', 'harvest'];
export const MILESTONES = ['brief', 'draft', 'approve', 'publish'] as const;
export type MilestoneKey = (typeof MILESTONES)[number];
export const MILESTONE_VN: Record<MilestoneKey, string> = {
  brief: 'brief',
  draft: 'nháp',
  approve: 'duyệt',
  publish: 'đăng',
};
export const LISTING_OK = ['MO_TA', 'TP_THUONG', 'QC_DAY_DU'];
export const CONTENT_OK = ['TP_THUONG', 'QC_DAY_DU'];
const NEED_SKU = ['listing', 'ads', 'koc']; // không SKU → bỏ ô
export const BRAND_NOTE = 'câu chuyện thương hiệu — không nêu tên SKU';
export const REASON_ALCOHOL = 'rượu: không kênh online';
export const MAX_WEEKS = 26;
export const DAILY_MAX = 9; // khóa slot 1 chữ số (content)
export const DAILY_CHANNELS = ['facebook', 'zalo', 'tiktok', 'web']; // kênh bài đăng
export const REASON_NO_SKU =
  'thiếu SKU đủ điều kiện kênh {ch} cho bài đăng (cần readiness TP_THUONG/QC_DAY_DU; rượu không kênh online)';
const ID_SRC = '[a-z0-9][a-z0-9._-]{0,39}';
const ID_RE = new RegExp(`^${ID_SRC}$`);
const ISO_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;
const H = 3_600_000;

/** Lịch mùa vụ thiếu/hỏng/sai luật (Python `CalendarError(ValueError)`) — fail-closed. */
export class CalendarError extends RangeError {
  override name = 'CalendarError';
}

type Dict = Record<string, unknown>;
export type CalEvent = Dict & { id: string };
export type Calendar = Dict & { events: CalEvent[] };
export type Lead = {
  publish_hour: number;
  approve_buffer_hours: number;
  draft_review_hours: number;
  work_start_hour: number;
  work_end_hour: number;
};
export type Milestones = Record<MilestoneKey, Date>;
export type Cell = { channel: string; format: string; skus: string[]; note: string };
export type BlockedSku = {
  sku_key: string;
  channel: string;
  format: string;
  readiness: string;
  reason: string;
};
export type PlanCampaign = {
  id: string;
  event: string;
  pillar: string;
  publish_day: string;
  milestones: Milestones;
  cells: Cell[];
  blocked: BlockedSku[];
  dropped: { channel: string; format: string; reason: string }[];
};
export type Reminder = { event: string; days_before: number; day: string; at: Date };
export type Plan = {
  status: string;
  start: string;
  end: string;
  campaigns: PlanCampaign[];
  reminders: Reminder[];
  non_working_days: string[];
};
export type Candidate = {
  kind: 'campaign' | 'evergreen';
  ref: string;
  channel: string;
  sku: string | null;
  pillar: string;
  publish_day: string | null;
  note: string;
  reason: string | null;
};
export type DailyCandidates = { status: string; per_day: number; candidates: Candidate[] };

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

// ------------------------------------------------------------------ loader

function int(v: unknown, where: string, lo: number, hi: number): number {
  // bool/float/chuỗi bị chặn vì không phải int (Python `isinstance(v, int)` trừ bool).
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

const skusOk = (s: unknown) =>
  s === 'auto' || (Array.isArray(s) && s.every((x) => typeof x === 'string' && x !== ''));
const strOk = (v: unknown) => typeof v === 'string' && pyStrip(v) !== '';

/** `daily_posts` (v13.6) tùy chọn; có thì phải đúng luật. */
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
 * Khác Python có chủ đích: "JSON hỏng" nêu tên lỗi, không nêu dòng/cột (JS không cho cùng câu của
 * `json.JSONDecodeError`) — vẫn CalendarError/exit 1 như Python. */
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

// ------------------------------------------------------------------ engine

function nonWorking(cal: Calendar): Set<string> {
  const days = new Set<string>((cal.non_working_days as string[] | undefined) ?? []);
  for (const ev of cal.events) {
    const offs = ev.off_days as number[] | undefined;
    if (offs?.length) {
      const base = eventDate(ev);
      for (const o of offs) days.add(addDays(base, o));
    }
  }
  return days;
}

const isOff = (d: string, nw: ReadonlySet<string>) => weekday(d) >= 5 || nw.has(d);

/** Đổi sang giờ VN rồi LÙI về giờ làm việc gần nhất ≤ dt (Date luôn có múi giờ — nhánh ValueError
 * datetime naive của Python không tồn tại ở JS). */
export function toWorkday(dt: Date, lead: Lead, nw: ReadonlySet<string>): Date {
  const day = vnDate(dt);
  const mid = vnMidnight(day).getTime();
  const t = dt.getTime();
  const endOf = mid + lead.work_end_hour * H;
  if (!isOff(day, nw)) {
    if (t - mid >= lead.work_start_hour * H && t <= endOf) return new Date(t);
    if (t > endOf) return new Date(endOf);
  }
  let d = day;
  for (let i = 0; i < 366; i++) {
    d = addDays(d, -1);
    if (!isOff(d, nw)) return new Date(vnMidnight(d).getTime() + lead.work_end_hour * H);
  }
  throw new CalendarError(`không tìm được ngày làm việc trong 366 ngày trước ${day}`);
}

export function milestones(
  publishDay: string,
  lead: Lead,
  briefSlaHours: unknown,
  nw: ReadonlySet<string>,
): Milestones {
  const sla = int(briefSlaHours, 'brief_sla_hours', 1, 720);
  const pub = new Date(vnMidnight(publishDay).getTime() + lead.publish_hour * H);
  const approve = toWorkday(new Date(pub.getTime() - lead.approve_buffer_hours * H), lead, nw);
  const draft = toWorkday(new Date(approve.getTime() - lead.draft_review_hours * H), lead, nw);
  const brief = toWorkday(new Date(draft.getTime() - sla * H), lead, nw);
  return { publish: pub, approve, draft, brief };
}

function cell(
  c: Dict,
  ch: string,
  fmt: string,
  byKey: Map<unknown, Dict>,
  goldenSkus: Dict[],
): [Cell | null, BlockedSku[]] {
  const keys =
    c.skus === 'auto' ? goldenSkus.map((s) => s.sku_key as string) : (c.skus as string[]);
  const okSet = fmt === 'listing' ? LISTING_OK : CONTENT_OK;
  const ok: string[] = [];
  const blocked: BlockedSku[] = [];
  for (const k of keys) {
    const s = byKey.get(k) as Dict;
    // Luật rượu đặt TRƯỚC readiness — mọi kênh golden đều online.
    if (s.category === 'alcohol') {
      blocked.push({
        sku_key: k,
        channel: ch,
        format: fmt,
        readiness: 'CAM',
        reason: REASON_ALCOHOL,
      });
      continue;
    }
    const r = readinessOf(s, ch);
    if (okSet.includes(r)) {
      ok.push(k);
      continue;
    }
    const allowed = s.allowed_channels;
    let why: string;
    if (r === 'CAM' && !(Array.isArray(allowed) && allowed.includes(ch))) {
      why = 'CAM: kênh chưa có trong allowed_channels (golden)';
    } else if (r === 'CAM' && s.category === 'food') {
      why = 'CAM: thực phẩm chưa có tự công bố (self_declaration_ok)';
    } else if (r === 'CAM') why = 'CAM: chưa đủ điều kiện kênh (golden)';
    else if (r === 'MO_TA') why = 'MO_TA: TPBVSK chưa có XNQC — chỉ listing mô tả';
    else why = `${r}: không đủ cho định dạng ${fmt}`;
    blocked.push({ sku_key: k, channel: ch, format: fmt, readiness: r, reason: why });
  }
  if (!ok.length && NEED_SKU.includes(fmt)) return [null, blocked];
  return [{ channel: ch, format: fmt, skus: ok, note: ok.length ? '' : BRAND_NOTE }, blocked];
}

const goldenList = (golden: unknown): Dict[] => {
  const skus = isDict(golden) ? golden.skus : undefined;
  return Array.isArray(skus) ? skus.filter(isDict) : [];
};

/** Lịch chiến dịch có việc trong [start, start + 7·weeks): ngày đăng ≥ start và mốc brief < end. */
export function build(
  cal: Calendar,
  golden: unknown,
  start: string,
  weeks: unknown,
  briefSlaHours: unknown,
): Plan {
  const w = int(weeks, 'weeks', 1, MAX_WEEKS);
  const end = addDays(start, 7 * w);
  const goldenSkus = goldenList(golden);
  const byKey = new Map<unknown, Dict>(goldenSkus.map((s) => [s.sku_key, s]));
  if (!byKey.size) throw new CalendarError('golden không có SKU nào');
  const lead = cal.lead as Lead;
  const nw = nonWorking(cal);
  const events = new Map(cal.events.map((ev) => [ev.id, ev]));
  const out: PlanCampaign[] = [];
  for (const c of cal.campaigns as Dict[]) {
    if (c.skus !== 'auto') {
      const unknown = (c.skus as string[]).filter((k) => !byKey.has(k));
      if (unknown.length) {
        throw new CalendarError(
          `chiến dịch ${c.id}: SKU không có trong golden [${unknown.map(pyRepr).join(', ')}]`,
        );
      }
    }
    const ev = events.get(c.event as string) as CalEvent;
    const pday = addDays(eventDate(ev), c.publish_offset_days as number);
    const ms = milestones(pday, lead, briefSlaHours, nw);
    // Có việc trong kỳ: đăng chưa qua start VÀ mốc brief rơi trước end (11.11 có brief 04/11 →
    // hiện trong lịch 4 tuần từ 12/10).
    if (pday < start || vnDate(ms.brief) >= end) continue;
    const cells: Cell[] = [];
    const blocked: BlockedSku[] = [];
    const dropped: PlanCampaign['dropped'] = [];
    for (const ch of c.channels as string[]) {
      for (const fmt of c.formats as string[]) {
        const [x, bl] = cell(c, ch, fmt, byKey, goldenSkus);
        blocked.push(...bl);
        if (x === null)
          dropped.push({ channel: ch, format: fmt, reason: 'không SKU đủ readiness — bỏ ô' });
        else cells.push(x);
      }
    }
    out.push({
      id: c.id as string,
      event: c.event as string,
      pillar: c.pillar as string,
      publish_day: pday,
      milestones: ms,
      cells,
      blocked,
      dropped,
    });
  }
  out.sort((a, b) => cpCmp(a.publish_day, b.publish_day) || cpCmp(a.id, b.id));
  const reminders: Reminder[] = [];
  const days = [...new Set(cal.reminder_days as number[])].sort((a, b) => b - a);
  for (const ev of cal.events) {
    if (!ev.remind) continue;
    const ed = eventDate(ev);
    for (const n of days) {
      const day = addDays(ed, -n);
      if (start <= day && day < end) {
        reminders.push({
          event: ev.id,
          days_before: n,
          day,
          at: new Date(vnMidnight(day).getTime() + lead.work_start_hour * H),
        });
      }
    }
  }
  reminders.sort((a, b) => cpCmp(a.day, b.day) || cpCmp(a.event, b.event));
  return {
    status: cal.status as string,
    start,
    end,
    campaigns: out,
    reminders,
    non_working_days: [...nw].sort(),
  };
}

/** Python `date.toordinal()` (0001-01-01 = 1). */
const ordinal = (day: string) =>
  ((parseDay(day) as number) - Date.UTC(1970, 0, 1)) / 86_400_000 + 719_163;

/** THUẦN → ứng viên chủ đề "3 bài/ngày" (PL01 Marketing): ô `post` của chiến dịch có mốc NHÁP rơi
 * đúng ngày VN `day` đứng trước, rồi trụ thường ngày xoay theo `day.toordinal()`. SKU xoay vòng
 * trong SKU hợp lệ — không bao giờ rượu. Trụ gắn SKU mà không SKU nào hợp lệ → `reason` (bị từ
 * chối, KHÔNG thay SKU khác cho đủ số). Thiếu `daily_posts` → CalendarError. */
export function dailyCandidates(
  cal: Calendar,
  golden: unknown,
  day: string,
  briefSlaHours: unknown,
): DailyCandidates {
  const dp = cal.daily_posts;
  if (!isDict(dp)) {
    throw new CalendarError(
      "thiếu 'daily_posts' trong lịch mùa vụ — chưa có cấu hình bài hằng ngày (GĐ Marketing chốt)",
    );
  }
  const byKey = new Map<unknown, Dict>(goldenList(golden).map((s) => [s.sku_key, s]));
  const rot = ordinal(day);
  const out: Candidate[] = [];
  const plan = build(cal, golden, day, 4, briefSlaHours);
  for (const c of plan.campaigns) {
    if (vnDate(c.milestones.draft) !== day) continue;
    for (const x of c.cells) {
      if (x.format !== 'post') continue;
      const ok = x.skus;
      out.push({
        kind: 'campaign',
        ref: c.id,
        channel: x.channel,
        sku: ok.length ? (ok[rot % ok.length] as string) : null,
        pillar: c.pillar,
        publish_day: c.publish_day,
        note: x.note,
        reason: null,
      });
    }
  }
  const ev = dp.evergreen as Dict[];
  const k = rot % ev.length;
  for (const e of [...ev.slice(k), ...ev.slice(0, k)]) {
    const ch = e.channel as string;
    const keys = e.skus === 'auto' ? [...byKey.keys()] : (e.skus as unknown[]);
    const unknown = keys.filter((s) => !byKey.has(s));
    if (unknown.length) {
      throw new CalendarError(
        `daily_posts ${e.id}: SKU không có trong golden [${unknown.map(reprV).join(', ')}]`,
      );
    }
    let sku: string | null = null;
    let reason: string | null = null;
    if (keys.length) {
      const ok = keys.filter((s) => {
        const g = byKey.get(s) as Dict;
        return g.category !== 'alcohol' && CONTENT_OK.includes(readinessOf(g, ch));
      });
      if (ok.length) sku = ok[rot % ok.length] as string;
      else reason = REASON_NO_SKU.replace('{ch}', ch);
    }
    out.push({
      kind: 'evergreen',
      ref: e.id as string,
      channel: ch,
      sku,
      pillar: e.pillar as string,
      publish_day: null,
      note: keys.length ? '' : BRAND_NOTE,
      reason,
    });
  }
  return { status: cal.status as string, per_day: dp.per_day as number, candidates: out };
}

// ------------------------------------------------------------------ xuất

/** Python `datetime.isoformat()` theo giờ VN (`+07:00`, micro giây chỉ khi ≠ 0). */
export function vnIso(d: Date): string {
  const ms = d.getTime() % 1000;
  const frac = ms ? `.${String(ms).padStart(3, '0')}000` : '';
  return `${vnFormat(d, '%Y-%m-%dT%H:%M:%S')}${frac}+07:00`;
}

/** Plan/ứng viên → JSON như `json.dumps(default=_json_default)` (Date → isoformat VN). */
export function toJson(o: unknown): unknown {
  if (o instanceof Date) return vnIso(o);
  if (Array.isArray(o)) return o.map(toJson);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toJson(v)]));
  }
  return o;
}

const fmt = (d: Date) => vnFormat(d, '%d/%m %H:%M');
const md = (s: unknown) => squash(String(s)).replaceAll('|', '\\|');
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dmy = (d: string) => `${dm(d)}/${d.slice(0, 4)}`;
const group = (d: string, by: string) =>
  by === 'week' ? `Tuần ${weekStart(d)}` : `Tháng ${d.slice(0, 7)}`;

export function renderMarkdown(plan: Plan, by = 'week'): string {
  if (by !== 'week' && by !== 'month') throw new RangeError('by phải week|month');
  const last = addDays(plan.end, -1);
  const L = [
    `> ${md(plan.status)} · Lịch ĐỀ XUẤT — GĐ Marketing duyệt trước khi chạy`,
    '',
    `# Lịch mùa vụ marketing ${dmy(plan.start)} → ${dmy(last)} (giờ VN)`,
    '',
  ];
  const groups = new Map<string, { c: PlanCampaign[]; r: Reminder[] }>();
  const at = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { c: [], r: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const c of plan.campaigns) at(group(c.publish_day, by)).c.push(c);
  for (const r of plan.reminders) at(group(r.day, by)).r.push(r);
  if (!groups.size) L.push('(Không có chiến dịch hay nhắc mốc trong kỳ.)', '');
  for (const key of [...groups.keys()].sort(cpCmp)) {
    const g = groups.get(key) as { c: PlanCampaign[]; r: Reminder[] };
    L.push(`## ${key}`, '');
    if (g.c.length) {
      L.push('| ngày | chiến dịch | kênh | định dạng | SKU | mốc |', '|---|---|---|---|---|---|');
      for (const c of g.c) {
        const moc = MILESTONES.map((k) => `${MILESTONE_VN[k]} ${fmt(c.milestones[k])}`).join(' · ');
        const cells: (Cell | null)[] = c.cells.length ? c.cells : [null];
        for (const x of cells) {
          if (x === null) {
            L.push(`| ${dm(c.publish_day)} | ${md(c.id)} | — | — | (mọi ô bị bỏ) | ${moc} |`);
            continue;
          }
          const sku = x.skus.join(', ') || md(x.note);
          L.push(
            `| ${dm(c.publish_day)} | ${md(c.id)} (${md(c.pillar)}) | ${x.channel} | ${x.format} | ${sku} | ${moc} |`,
          );
        }
      }
      L.push('');
    }
    for (const r of g.r) {
      L.push(`- Nhắc: còn ${r.days_before} ngày tới \`${r.event}\` (${dmy(r.day)})`);
    }
    if (g.r.length) L.push('');
  }
  L.push('## SKU bị chặn kênh', '');
  const agg = new Map<string, { key: string[]; fm: Set<string> }>();
  for (const c of plan.campaigns) {
    for (const b of c.blocked) {
      const key = [b.sku_key, b.channel, b.readiness, b.reason];
      const k = JSON.stringify(key);
      if (!agg.has(k)) agg.set(k, { key, fm: new Set() });
      agg.get(k)?.fm.add(b.format);
    }
  }
  if (agg.size) {
    L.push('| SKU | kênh | readiness | lý do | định dạng |', '|---|---|---|---|---|');
    const rows = [...agg.values()].sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        const d = cpCmp(a.key[i] as string, b.key[i] as string);
        if (d) return d;
      }
      return 0;
    });
    for (const { key, fm } of rows) {
      const [k, ch, r, why] = key;
      L.push(`| ${k} | ${ch} | ${r} | ${md(why)} | ${[...fm].sort(cpCmp).join(', ')} |`);
    }
  } else L.push('- (không có)');
  L.push('');
  return L.join('\n');
}

const icsText = (s: string) =>
  s
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
const icsTs = (d: Date) => `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

/** RFC 5545 §3.1: dòng > 75 octet gập bằng CRLF + 1 space; không cắt giữa ký tự UTF-8 nhiều byte. */
function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = '';
  let n = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > 75) {
      parts.push(cur);
      cur = ' ';
      n = 1;
    }
    cur += ch;
    n += b;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

export function renderIcs(plan: Plan, now: Date): string {
  const stamp = icsTs(now);
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SamSam//MKT-01 lich mua vu//VI',
    'CALSCALE:GREGORIAN',
  ];
  const ev = (uid: string, start: Date, summary: string, desc: string) =>
    L.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTs(start)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(desc)}`,
      'END:VEVENT',
    );
  for (const c of plan.campaigns) {
    for (const k of MILESTONES) {
      ev(
        `${c.id}-${k}@samsam`,
        c.milestones[k],
        `[MKT] ${MILESTONE_VN[k]}: ${c.id} (${c.event})`,
        `${c.pillar}; ${plan.status}; lịch ĐỀ XUẤT`,
      );
    }
  }
  for (const r of plan.reminders) {
    ev(
      `${r.event}-nhac-${r.days_before}@samsam`,
      r.at,
      `[MKT] nhắc: còn ${r.days_before} ngày tới ${r.event}`,
      plan.status,
    );
  }
  L.push('END:VCALENDAR');
  return L.map((x) => `${foldLine(x)}\r\n`).join('');
}

export type Inputs = [Calendar, Record<string, unknown>, number];

/** → [lịch, golden, brief_sla_hours]. Lỗi → CalendarError. */
export function loadInputs(calPath?: string, goldenFile?: string, directorsDir?: string): Inputs {
  const cal = loadCalendar(calPath);
  const [golden, err] = readGolden(goldenFile);
  if (err !== null || golden === null) throw new CalendarError(`golden: ${err}`);
  const errs = validateGolden(golden);
  if (errs.length) throw new CalendarError(`golden sai luật: ${errs[0]}`);
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = directorsDir ? loadConfig('marketing', directorsDir) : loadConfig('marketing');
  } catch (e) {
    if (e instanceof DirectorConfigError)
      throw new CalendarError(`director marketing: ${e.message}`);
    throw e;
  }
  const spec = Object.hasOwn(cfg.object_types, 'campaign_brief')
    ? cfg.object_types.campaign_brief
    : undefined;
  if (spec === undefined) {
    throw new CalendarError('director marketing: thiếu object_types.campaign_brief');
  }
  return [cal, golden, spec.sla_hours];
}

// ------------------------------------------------------------------ CLI

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type CalendarOpts = {
  start?: string;
  weeks?: string;
  by?: string;
  ics?: string | true;
  json?: boolean;
};
export type CalendarDeps = { io?: Io; now?: () => Date; calFile?: string; reportsDir?: string };

const PROG = 'python -m pipelines.mkt_calendar';

/** Python `_date_arg`: 'YYYY-MM-DD' hợp lệ | lỗi tham số. */
export function dateArg(s: string | undefined): string | null {
  return s !== undefined && ISO_RE.test(s) && parseDay(s) !== null ? s : null;
}

/** `python -m pipelines.mkt_calendar` — lịch ĐỀ XUẤT (không DB, không đăng bài).
 * Exit: 0 OK · 1 lịch/golden/cấu hình director hỏng · 2 tham số sai. */
export async function mktCalendarMain(o: CalendarOpts, d: CalendarDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  let start: string | null = null;
  if (o.start !== undefined) {
    start = dateArg(o.start);
    if (start === null) {
      return usage(
        `argument --start: ${ISO_RE.test(o.start) ? 'ngày không hợp lệ' : 'ngày phải YYYY-MM-DD'}: ${pyRepr(o.start)}`,
      );
    }
  }
  let weeks = 4;
  if (o.weeks !== undefined) {
    const t = pyStrip(o.weeks);
    // shortcut: chỉ chữ số ASCII (Python `int()` nhận cả chữ số Unicode) — chặt hơn, vẫn exit 2.
    if (!/^[+-]?\d+(?:_\d+)*$/.test(t))
      return usage(`argument --weeks: --weeks phải số: ${pyRepr(o.weeks)}`);
    weeks = Number(t.replaceAll('_', ''));
    if (!(weeks >= 1 && weeks <= MAX_WEEKS))
      return usage(`argument --weeks: --weeks phải 1..${MAX_WEEKS}`);
  }
  const by = o.by ?? 'week';
  if (by !== 'week' && by !== 'month') {
    return usage(`argument --by: invalid choice: ${pyRepr(by)} (choose from 'week', 'month')`);
  }
  const now = (d.now ?? (() => new Date()))();
  const s = start ?? weekStart(vnDate(now));
  let plan: Plan;
  try {
    const [cal, golden, sla] = loadInputs(d.calFile);
    plan = build(cal, golden, s, weeks, sla);
  } catch (e) {
    if (!(e instanceof CalendarError)) throw e;
    io.err(`[err] ${e.message}`);
    return 1;
  }
  io.out(o.json ? JSON.stringify(toJson(plan), null, 1) : renderMarkdown(plan, by));
  if (o.ics !== undefined) {
    const p =
      typeof o.ics === 'string' && o.ics
        ? o.ics
        : join(d.reportsDir ?? REPORTS_DIR, `mkt-calendar-${s}.ics`);
    // P8.4: lịch .ics dựng từ kế hoạch GIẢ ĐỊNH (không phải đầu ra đếm).
    const path = await writeReport(renderIcs(plan, now), dirname(p), basename(p), false);
    io.err(`[ok] .ics: ${path}`);
  }
  return 0;
}
