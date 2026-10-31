import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay, periodBounds, vnDate, vnMidnight } from '@samsam/core/ops/period';
import type { Marketing } from '@samsam/core/ops/report';
import { pyStrip, pyTruthy } from '@samsam/core/security/py';
import { dec, decStr, isIntegral, median, pyRound, toBigInt } from './dec.js';

// Port `pipelines/mkt_metrics.py` (v6.5 MKT-09, marketing-06.2) — số đo marketing THUẦN + query cho
// mục 5 báo cáo định kỳ (`@samsam/core/ops/report` — `Collectors.marketing`) và cockpit
// (`cockpit.collectInternal`).
//  - Tỷ lệ trả lại = rejected / (approved + rejected) trên nháp CÓ QUYẾT ĐỊNH trong kỳ:
//    `content_drafts` theo `reviewed_at`, `approval_queue` khối `marketing` theo `decided_at`.
//    `pending` KHÔNG vào mẫu số (in riêng `pending_end`); `expired` đếm riêng. Mẫu số 0 → `rate` null.
//  - Thời gian duyệt = giờ tạo → quyết định; trung vị + p90 nearest-rank, làm tròn 1 chữ số; n=0 →
//    null (thiếu số ≠ 0 giờ). Mốc thiếu / âm → loại khỏi mẫu + đếm `bad_ts`. Giờ tính từ
//    `extract(epoch …)` ở DB (micro giây chính xác như `timedelta.total_seconds()` — Date của JS chỉ
//    tới mili giây).
//  - Kỳ [since, until) là `Date` (luôn có múi giờ — giờ VN do caller, `ops/period`). Hiệu quả kênh =
//    tuần ISO ĐÃ ĐÓNG gần nhất trước `until`.
//  - Mọi số do CODE tính từ DB — 0 LLM. Lỗi DB nổi lên caller (báo cáo degrade mục 5, cockpit ghi
//    `errors`). Không trích text nội dung/vi phạm: chỉ đếm CODE guardrail.

export const MARKETING_BLOCK = 'marketing';
export const UNKNOWN_AGENT = '(không rõ)';
// docx P2 (marketing-06.2, PL01 "báo cáo lượt xem, đơn, tỷ lệ hủy"): tỷ lệ hủy = hủy / (hoàn thành + hủy).
export const CHANNEL_METRICS = [
  'social.reach',
  'social.engagement',
  'sales.orders_completed',
  'sales.orders_cancelled',
];
const INTERNAL_CHANNEL = 'noi_bo';

export type Bucket = {
  decided: number;
  approved: number;
  rejected: number;
  pending_end: number;
  rate: number | null;
};
export type Summary = {
  n: number;
  median_h: number | null;
  p90_h: number | null;
  max_h: number | null;
};
export type Hours = Summary & { bad_ts: number };
export type DraftDecisions = { by: [[string, string], Bucket][]; total: Bucket; hours: Hours };
export type QueueDecisions = {
  by: [string, Bucket][];
  total: Bucket;
  expired: number;
  hours: Hours;
};
export type ChannelRow = {
  channel: string;
  reach: number | null;
  engagement: number | null;
  orders: number | null;
  cancelled: number | null;
  cancel_rate: number | null;
  eng_rate: number | null;
  sample: boolean;
};
export type MarketingOk = Extract<Marketing, { ok: true }> & {
  drafts: [[string, string], Bucket][];
  drafts_total: Bucket;
  drafts_hours: Hours;
  queue: [string, Bucket][];
  queue_total: Bucket;
  queue_hours: Hours;
  queue_expired: number;
  channels: { week: string; rows: ChannelRow[] };
};

/** Python `_aware`: mốc phải là thời điểm (datetime có múi giờ) — chuỗi/ngày trần → lỗi TRƯỚC query. */
function aware(dt: unknown, name: string): Date {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) {
    throw new RangeError(`${name} phải là datetime có múi giờ (aware)`);
  }
  return dt;
}

/** THUẦN → {n, median_h, p90_h, max_h}; n=0 → 3 giá trị null. */
export function reviewSummary(hours: Iterable<number>): Summary {
  const hs = [...hours].map(Number).sort((a, b) => a - b);
  const n = hs.length;
  if (!n) return { n: 0, median_h: null, p90_h: null, max_h: null };
  return {
    n,
    median_h: pyRound(median(hs), 1),
    p90_h: pyRound(hs[Math.ceil(0.9 * n) - 1] as number, 1),
    max_h: pyRound(hs[n - 1] as number, 1),
  };
}

/** % trả lại 1 chữ số; mẫu số 0 → null (in "—"). */
export function rate(rejected: number, decided: number): number | null {
  return decided ? pyRound((100 * rejected) / decided, 1) : null;
}

const bucket = (): Bucket => ({ decided: 0, approved: 0, rejected: 0, pending_end: 0, rate: null });

function bucketOf(by: Map<string, Bucket>, k: string): Bucket {
  let b = by.get(k);
  if (!b) {
    b = bucket();
    by.set(k, b);
  }
  return b;
}

// Giờ tạo → quyết định từ `secs` (DB: extract epoch). Thiếu mốc → null; âm → null (bad_ts).
const SECS = (created: string, decided: string) =>
  `extract(epoch from (${decided} - ${created}))::text as secs`;

type TallyRow = { status: string | null; secs: string | null };

function tally<R extends TallyRow>(
  rows: R[],
  keyOf: (r: R) => string,
): { by: Map<string, Bucket>; total: Bucket; hours: number[]; bad: number; expired: number } {
  const by = new Map<string, Bucket>();
  const total = bucket();
  const hours: number[] = [];
  let bad = 0;
  let expired = 0;
  for (const r of rows) {
    if (r.status === 'expired') {
      expired++;
      continue;
    }
    if (r.status !== 'approved' && r.status !== 'rejected') continue;
    const b = bucketOf(by, keyOf(r));
    for (const x of [b, total]) {
      x.decided++;
      x[r.status]++;
    }
    const s = r.secs === null ? null : Number(r.secs);
    if (s === null || s < 0) bad++;
    else hours.push(s / 3600);
  }
  return { by, total, hours, bad, expired };
}

function finish(by: Iterable<Bucket>, total: Bucket): void {
  for (const b of [...by, total]) b.rate = rate(b.rejected, b.decided);
}

const orQ = (v: unknown): string => (typeof v === 'string' && v ? v : '?');
const SEP = '\u0000';

/** Nháp `content_drafts` có quyết định trong [since, until) — dùng chung cho báo cáo (mục 5) và cockpit. */
export async function draftDecisions(db: Db, since: Date, until: Date): Promise<DraftDecisions> {
  aware(since, 'since');
  aware(until, 'until');
  const { rows } = await db.query(
    `select status, ${SECS('created_at', 'reviewed_at')}, channel, content_type from content_drafts where status in ('approved', 'rejected') and reviewed_at >= $1 and reviewed_at < $2`,
    [since, until],
  );
  const t = tally(
    rows as (TallyRow & { channel: string | null; content_type: string | null })[],
    (r) => orQ(r.channel) + SEP + orQ(r.content_type),
  );
  const pend = await db.query(
    "select channel, content_type, count(*)::text as n from content_drafts where created_at < $1 and (status = 'pending' or reviewed_at >= $2) group by 1, 2",
    [until, until],
  );
  for (const r of pend.rows) {
    const b = bucketOf(t.by, orQ(r.channel) + SEP + orQ(r.content_type));
    b.pending_end += Number(r.n);
    t.total.pending_end += Number(r.n);
  }
  finish(t.by.values(), t.total);
  return {
    by: [...t.by].map(([k, b]) => [k.split(SEP) as [string, string], b]),
    total: t.total,
    hours: { ...reviewSummary(t.hours), bad_ts: t.bad },
  };
}

/** Hàng chờ `approval_queue` của khối theo `object_type` (decided_at ∈ kỳ); `expired` đếm riêng. */
export async function queueDecisions(
  db: Db,
  since: Date,
  until: Date,
  block: string = MARKETING_BLOCK,
): Promise<QueueDecisions> {
  aware(since, 'since');
  aware(until, 'until');
  const { rows } = await db.query(
    `select status, ${SECS('created_at', 'decided_at')}, object_type from approval_queue where block = $1 and decided_at >= $2 and decided_at < $3`,
    [block, since, until],
  );
  const t = tally(rows as (TallyRow & { object_type: string | null })[], (r) => orQ(r.object_type));
  const pend = await db.query(
    "select object_type, count(*)::text as n from approval_queue where block = $1 and created_at < $2 and (status = 'pending' or decided_at >= $3) group by 1",
    [block, until, until],
  );
  for (const r of pend.rows) {
    const b = bucketOf(t.by, orQ(r.object_type));
    b.pending_end += Number(r.n);
    t.total.pending_end += Number(r.n);
  }
  finish(t.by.values(), t.total);
  return {
    by: [...t.by],
    total: t.total,
    expired: t.expired,
    hours: { ...reviewSummary(t.hours), bad_ts: t.bad },
  };
}

/** Đếm violations[].code (thiếu → type → '?'); snapshot hỏng → `snapshot_hong`. */
export function countCodes(snapshot: unknown, out: Map<string, number>): void {
  const isDict = typeof snapshot === 'object' && snapshot !== null && !Array.isArray(snapshot);
  const viols = isDict ? (snapshot as Record<string, unknown>).violations : undefined;
  if (!Array.isArray(viols)) {
    out.set('snapshot_hong', (out.get('snapshot_hong') ?? 0) + 1);
    return;
  }
  for (const v of viols) {
    let c: unknown = null;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      c = pyTruthy(o.code) ? o.code : o.type;
    }
    const k = typeof c === 'string' && pyStrip(c) ? c : '?';
    out.set(k, (out.get(k) ?? 0) + 1);
  }
}

/** Nháp TẠO trong kỳ (content_drafts + hàng chờ khối) → [theo agent, theo code guardrail]. */
async function created(
  db: Db,
  since: Date,
  until: Date,
  block: string,
): Promise<[Record<string, number>, Record<string, number>]> {
  const a = await db.query(
    'select created_by, guardrail from content_drafts where created_at >= $1 and created_at < $2',
    [since, until],
  );
  const b = await db.query(
    'select created_by, guardrail from approval_queue where block = $1 and created_at >= $2 and created_at < $3',
    [block, since, until],
  );
  const byAgent = new Map<string, number>();
  const codes = new Map<string, number>();
  for (const r of [...a.rows, ...b.rows]) {
    const who =
      typeof r.created_by === 'string' && pyStrip(r.created_by)
        ? pyStrip(r.created_by)
        : UNKNOWN_AGENT;
    byAgent.set(who, (byAgent.get(who) ?? 0) + 1);
    countCodes(r.guardrail, codes);
  }
  return [Object.fromEntries(byAgent), Object.fromEntries(codes)];
}

/** Tuần ISO (năm, số tuần) của ngày 'YYYY-MM-DD' (Python `date.isocalendar()`). */
export function isoWeek(day: string): [number, number] {
  const t = parseDay(day);
  if (t === null) throw new RangeError(`ngày '${day}' không hợp lệ`);
  const wd = (new Date(t).getUTCDay() + 6) % 7;
  const thu = new Date(t + (3 - wd) * 86_400_000);
  const y = thu.getUTCFullYear();
  const jan1 = new Date(0);
  jan1.setUTCFullYear(y, 0, 1);
  return [y, Math.floor((thu.getTime() - jan1.getTime()) / 86_400_000 / 7) + 1];
}

/** Đầu tuần ISO ĐÃ ĐÓNG gần nhất trước `until` + nhãn `YYYY-Www` (= cockpit.lastClosedRef("week")). */
export function closedWeek(until: Date): [Date, string] {
  const start = vnMidnight(addDays(vnDate(periodBounds('week', until)[0]), -7));
  const [y, w] = isoWeek(vnDate(start));
  return [start, `${y}-W${String(w).padStart(2, '0')}`];
}

/** Decimal nguyên → số nguyên (in không đuôi .0); không nguyên → float. shortcut: số nguyên > 2^53
 * mất chính xác (CSV giới hạn 15 chữ số nên chưa gặp). */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const d = dec(String(v));
  return isIntegral(d) ? Number(toBigInt(d)) : Number(decStr(d));
}

const KEY_OF: Record<string, 'reach' | 'engagement' | 'orders' | 'cancelled'> = {
  'social.reach': 'reach',
  'social.engagement': 'engagement',
  'sales.orders_completed': 'orders',
  'sales.orders_cancelled': 'cancelled',
};

/** Số kênh ngoài (manual_export) tuần đã đóng → {week, rows}. Cờ `sample` khi BẤT KỲ dòng nguồn `sample:`. */
export async function channelWeek(
  db: Db,
  until: Date,
): Promise<{ week: string; rows: ChannelRow[] }> {
  const [start, label] = closedWeek(until);
  const { rows } = await db.query(
    "select channel, metric_id, value::text as value, source_ref from channel_snapshots where period_kind = 'week' and period_start = $1 and channel <> $2 and metric_id = any($3) order by channel, metric_id",
    [vnDate(start), INTERNAL_CHANNEL, CHANNEL_METRICS],
  );
  const per = new Map<string, ChannelRow>();
  for (const r of rows) {
    let d = per.get(r.channel);
    if (!d) {
      d = {
        channel: r.channel,
        reach: null,
        engagement: null,
        orders: null,
        cancelled: null,
        cancel_rate: null,
        eng_rate: null,
        sample: false,
      };
      per.set(r.channel, d);
    }
    d[KEY_OF[r.metric_id] as 'reach'] = num(r.value);
    if (typeof r.source_ref === 'string' && r.source_ref.startsWith('sample:')) d.sample = true;
  }
  for (const d of per.values()) {
    if (d.reach && d.engagement !== null) d.eng_rate = pyRound((100 * d.engagement) / d.reach, 1);
    if (d.cancelled !== null && d.orders !== null && d.orders + d.cancelled) {
      d.cancel_rate = pyRound((100 * d.cancelled) / (d.orders + d.cancelled), 1);
    }
  }
  const keys = [...per.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { week: label, rows: keys.map((k) => per.get(k) as ChannelRow) };
}

/** Toàn bộ số mục 5 báo cáo. Mốc không phải thời điểm → lỗi (0 query); lỗi DB nổi lên caller. */
export async function collect(db: Db, since: Date, until: Date): Promise<MarketingOk> {
  aware(since, 'since');
  aware(until, 'until');
  const drafts = await draftDecisions(db, since, until);
  const queue = await queueDecisions(db, since, until);
  const [byAgent, codes] = await created(db, since, until, MARKETING_BLOCK);
  return {
    ok: true,
    drafts: drafts.by,
    drafts_total: drafts.total,
    drafts_hours: drafts.hours,
    queue: queue.by,
    queue_total: queue.total,
    queue_hours: queue.hours,
    queue_expired: queue.expired,
    by_agent: byAgent,
    guardrail_codes: codes,
    channels: await channelWeek(db, until),
  };
}
