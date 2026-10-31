import { DIRECTORS_DIR, DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { addDays, parseDay, vnDate, vnFormat, vnMidnight, weekday } from '@samsam/core/ops/period';
import { cpCmp, isDict, isPyInt } from '@samsam/core/ops/py-json';
import { readinessOf } from '@samsam/core/security/guardrail';
import { readStrictJson } from '../kd_price/deps.js';
import {
  CALENDAR_FILE,
  type Calendar,
  CalendarError,
  eventDate,
  loadCalendar,
  reprV,
} from '../kd_price/mkt-calendar.js';
import { GOLDEN_FILE, readGolden, validateGolden } from '../sales_director/kd-forecast.deps.js';

// Engine lịch đề xuất của `pipelines/mkt_calendar.py` (MKT-01: mốc brief/nháp/duyệt/đăng LÙI theo
// SLA giờ VN, né T7/CN/ngày nghỉ; rượu không vào ô online nào) + quota duyệt của
// `scripts/review_load.py` mà MKT-00 dùng. Loader/validate lịch dùng chung bản của nhóm kd_price.
// shortcut: bản riêng của nhóm mkt_ads (MKT-01 + review_load chưa có port dùng chung) — khi port xong
// thì import dùng chung, xóa tệp này.

export { CALENDAR_FILE, type Calendar, CalendarError };
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
export const NEED_SKU = ['listing', 'ads', 'koc']; // không SKU → bỏ ô
export const BRAND_NOTE = 'câu chuyện thương hiệu — không nêu tên SKU';
export const REASON_ALCOHOL = 'rượu: không kênh online';
export const MAX_WEEKS = 26;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const H = 3_600_000;

export type Day = string;
export type Milestones = Record<MilestoneKey, Date>;
export type CellOut = { channel: string; format: string; skus: string[]; note: string };
export type Blocked = {
  sku_key: string;
  channel: string;
  format: string;
  readiness: string;
  reason: string;
};
export type Campaign = {
  id: string;
  event: string;
  pillar: string;
  publish_day: Day;
  milestones: Milestones;
  cells: CellOut[];
  blocked: Blocked[];
  dropped: { channel: string; format: string; reason: string }[];
};
export type Reminder = { event: string; days_before: number; day: Day; at: Date };
export type Plan = {
  status: string;
  start?: Day;
  end?: Day;
  campaigns: Campaign[];
  reminders: Reminder[];
  non_working_days: Day[];
};
type Lead = {
  publish_hour: number;
  approve_buffer_hours: number;
  draft_review_hours: number;
  work_start_hour: number;
  work_end_hour: number;
};
type Sku = Record<string, unknown>;

function int(v: unknown, where: string, lo: number, hi: number): number {
  if (!isPyInt(v) || v < lo || v > hi) {
    throw new CalendarError(`${where}: phải là số nguyên ${lo}..${hi}, nhận ${reprV(v ?? null)}`);
  }
  return v;
}

/** Giờ `h` (VN) của ngày `day`. */
export const at = (day: Day, h: number): Date => new Date(vnMidnight(day).getTime() + h * H);
const off = (d: Day, nw: ReadonlySet<Day>) => weekday(d) >= 5 || nw.has(d);

export function nonWorking(cal: Calendar): Set<Day> {
  const days = new Set<Day>(((cal.non_working_days as Day[] | undefined) ?? []).map(String));
  for (const ev of cal.events) {
    const offs = ev.off_days as number[] | undefined;
    if (offs?.length) {
      const base = eventDate(ev);
      for (const o of offs) days.add(addDays(base, o));
    }
  }
  return days;
}

/** Đổi sang giờ VN rồi LÙI về giờ làm việc gần nhất ≤ dt (không bao giờ đẩy muộn hơn). */
export function toWorkday(dt: Date, lead: Lead, nw: ReadonlySet<Day>): Date {
  const d = vnDate(dt);
  const endOf = at(d, lead.work_end_hour);
  if (!off(d, nw)) {
    if (dt.getTime() >= at(d, lead.work_start_hour).getTime() && dt <= endOf) return dt;
    if (dt > endOf) return endOf;
  }
  let day = d;
  for (let i = 0; i < 366; i++) {
    day = addDays(day, -1);
    if (!off(day, nw)) return at(day, lead.work_end_hour);
  }
  throw new CalendarError(`không tìm được ngày làm việc trong 366 ngày trước ${d}`);
}

export function milestones(
  publishDay: Day,
  lead: Lead,
  briefSlaHours: unknown,
  nw: ReadonlySet<Day>,
): Milestones {
  const sla = int(briefSlaHours, 'brief_sla_hours', 1, 720);
  const pub = at(publishDay, lead.publish_hour);
  const appr = toWorkday(new Date(pub.getTime() - lead.approve_buffer_hours * H), lead, nw);
  const draft = toWorkday(new Date(appr.getTime() - lead.draft_review_hours * H), lead, nw);
  const brief = toWorkday(new Date(draft.getTime() - sla * H), lead, nw);
  return { publish: pub, approve: appr, draft, brief };
}

function cell(
  c: Record<string, unknown>,
  ch: string,
  fmt: string,
  byKey: Map<unknown, Sku>,
  goldenSkus: Sku[],
): [CellOut | null, Blocked[]] {
  const keys =
    c.skus === 'auto' ? goldenSkus.map((s) => s.sku_key as string) : (c.skus as string[]);
  const okSet = fmt === 'listing' ? LISTING_OK : CONTENT_OK;
  const ok: string[] = [];
  const blocked: Blocked[] = [];
  for (const k of keys) {
    const s = byKey.get(k) as Sku;
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
    if (r === 'CAM' && (!Array.isArray(allowed) || !allowed.includes(ch))) {
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

/** Lịch chiến dịch có việc trong [start, start + 7·weeks): ngày đăng ≥ start và mốc brief < end. */
export function build(
  cal: Calendar,
  golden: unknown,
  start: Day,
  weeks: unknown,
  briefSlaHours: unknown,
): Plan {
  const w = int(weeks, 'weeks', 1, MAX_WEEKS);
  const end = addDays(start, 7 * w);
  const gs = (isDict(golden) && Array.isArray(golden.skus) ? golden.skus : []) as Sku[];
  const byKey = new Map<unknown, Sku>();
  for (const s of gs) if (isDict(s)) byKey.set(s.sku_key, s);
  if (!byKey.size) throw new CalendarError('golden không có SKU nào');
  const lead = cal.lead as Lead;
  const nw = nonWorking(cal);
  const events = new Map(cal.events.map((ev) => [ev.id, ev]));
  const out: Campaign[] = [];
  for (const c of cal.campaigns as Record<string, unknown>[]) {
    if (c.skus !== 'auto') {
      const unknown = (c.skus as string[]).filter((k) => !byKey.has(k));
      if (unknown.length) {
        throw new CalendarError(`chiến dịch ${c.id}: SKU không có trong golden ${reprV(unknown)}`);
      }
    }
    const pday = addDays(eventDate(events.get(c.event as string)), c.publish_offset_days as number);
    const ms = milestones(pday, lead, briefSlaHours, nw);
    // Có việc trong kỳ: đăng chưa qua start VÀ mốc brief rơi trước end (giờ VN).
    if (pday < start || vnDate(ms.brief) >= end) continue;
    const cells: CellOut[] = [];
    const blocked: Blocked[] = [];
    const dropped: Campaign['dropped'] = [];
    for (const ch of c.channels as string[]) {
      for (const fmt of c.formats as string[]) {
        const [cl, bl] = cell(c, ch, fmt, byKey, gs);
        blocked.push(...bl);
        if (cl === null)
          dropped.push({ channel: ch, format: fmt, reason: 'không SKU đủ readiness — bỏ ô' });
        else cells.push(cl);
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
  const rdays = [...new Set(cal.reminder_days as number[])].sort((a, b) => b - a);
  for (const ev of cal.events) {
    if (!ev.remind) continue;
    const ed = eventDate(ev);
    for (const n of rdays) {
      const day = addDays(ed, -n);
      if (start <= day && day < end) {
        reminders.push({ event: ev.id, days_before: n, day, at: at(day, lead.work_start_hour) });
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

/** `mkt_calendar._fmt`: '%d/%m %H:%M' giờ VN. */
export const fmt = (ts: Date): string => vnFormat(ts, '%d/%m %H:%M');

/** → [lịch, golden, SLA brief giờ]. Lỗi → CalendarError. */
export function loadInputs(
  calPath: string = CALENDAR_FILE,
  goldenPath: string = GOLDEN_FILE,
  directorsDir: string = DIRECTORS_DIR,
): [Calendar, Record<string, unknown>, number] {
  const cal = loadCalendar(calPath);
  const [golden, err] = readGolden(goldenPath);
  if (golden === null) throw new CalendarError(`golden: ${err}`);
  const errs = validateGolden(golden);
  if (errs.length) throw new CalendarError(`golden sai luật: ${errs[0]}`);
  let spec: { sla_hours: number } | undefined;
  try {
    spec = loadConfig('marketing', directorsDir).object_types.campaign_brief;
  } catch (e) {
    if (e instanceof DirectorConfigError)
      throw new CalendarError(`director marketing: ${e.message}`);
    throw e;
  }
  if (spec === undefined)
    throw new CalendarError('director marketing: thiếu object_types.campaign_brief');
  return [cal, golden, spec.sla_hours];
}

/** `mkt_calendar._date_arg` → ngày | lý do (argparse exit 2). */
export function dateArg(s: string): [Day, null] | [null, string] {
  if (!ISO_RE.test(s)) return [null, `ngày phải YYYY-MM-DD: ${reprV(s)}`];
  return parseDay(s) === null ? [null, `ngày không hợp lệ: ${reprV(s)}`] : [s, null];
}

// ---------------------------------------------------------------- scripts/review_load.py (quota)

/** Quota/tham số sai → exit 2 (Python `QuotaError(ValueError)`). */
export class QuotaError extends RangeError {
  override name = 'QuotaError';
}
export type Quota = { status: string; phases: [Day, Day | null, number][]; absent_days: Set<Day> };

function qIso(v: unknown, where: string): Day {
  if (typeof v !== 'string' || !ISO_RE.test(v)) {
    throw new QuotaError(`${where}: cần ngày YYYY-MM-DD, nhận ${reprV(v ?? null)}`);
  }
  if (parseDay(v) === null) throw new QuotaError(`${where}: ngày không hợp lệ ${reprV(v)}`);
  return v;
}

/** Đọc + validate quota (trần quyết định duyệt/ngày của MỖI người duyệt). Lỗi bất kỳ → QuotaError. */
export function loadQuota(path: string): Quota {
  const [raw, err] = readStrictJson(path);
  if (err !== null) throw new QuotaError(`quota không đọc được: ${err}`);
  if (!isDict(raw)) throw new QuotaError('quota phải là object JSON');
  const phases = raw.phases;
  if (!Array.isArray(phases) || !phases.length)
    throw new QuotaError('quota.phases rỗng hoặc không phải list');
  const out: [Day, Day | null, number][] = [];
  phases.forEach((p, i) => {
    const where = `phases[${i}]`;
    if (!isDict(p)) throw new QuotaError(`${where} phải là object`);
    const start = qIso(p.from, `${where}.from`);
    const end = p.to === null || p.to === undefined ? null : qIso(p.to, `${where}.to`);
    if (end !== null && end < start) throw new QuotaError(`${where}: to < from`);
    const cap = p.daily_cap;
    if (!isPyInt(cap) || cap < 0) throw new QuotaError(`${where}.daily_cap phải là số nguyên >= 0`);
    out.push([start, end, cap]);
  });
  out.sort((a, b) => cpCmp(a[0], b[0]));
  for (let i = 1; i < out.length; i++) {
    const e1 = (out[i - 1] as [Day, Day | null, number])[1];
    const s2 = (out[i] as [Day, Day | null, number])[0];
    if (e1 === null || e1 >= s2) throw new QuotaError(`phases chồng nhau quanh ${s2}`);
  }
  const absent = Object.hasOwn(raw, 'absent_days') ? raw.absent_days : [];
  if (!Array.isArray(absent)) throw new QuotaError('absent_days phải là list');
  const status = raw.status;
  return {
    status: typeof status === 'string' ? status : '',
    phases: out,
    absent_days: new Set(absent.map((d) => qIso(d, 'absent_days'))),
  };
}

/** Trần/ngày của 1 người duyệt; ngày vắng → 0; không phase nào phủ → null. */
export function capFor(day: Day, quota: Quota): number | null {
  if (quota.absent_days.has(day)) return 0;
  for (const [s, e, cap] of quota.phases) if (s <= day && (e === null || day <= e)) return cap;
  return null;
}
