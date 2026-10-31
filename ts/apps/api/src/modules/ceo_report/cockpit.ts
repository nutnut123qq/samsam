import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError, loadConfig as loadDirector } from '@samsam/core/ops/director';
import { addDays, parseDay, periodBounds, vnDate } from '@samsam/core/ops/period';
import { isPlainObject, parseJsonBytes } from '@samsam/core/ops/py';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { pyOsName } from '@samsam/core/ops/py-json';
import type { ChatStats } from '@samsam/core/ops/report';
import { dbMsg, isDbError, withTx } from '@samsam/core/ops/tx';
import { DATA_DIR } from '@samsam/core/paths';
import { sp } from '@samsam/core/rollout/counters';
import {
  casefold,
  cpHead,
  pyRepr,
  pyReprValue,
  pyStr,
  pyStrip,
  pyTruthy,
  stripCombining,
} from '@samsam/core/security/py';
import { CONSENT_REPLY_ROUTES } from '../crm/lead-store.js';
import { CONV_FILES, channelOf, iterConvlog, parseTs } from '../sales_director/convlog.js';
import { RETAIN_DAYS as CONVLOG_RETAIN_DAYS } from '../zalo/zalo.constants.js';
import {
  add,
  cmp,
  type Dec,
  dec,
  decStr,
  isFiniteDec,
  isIntegral,
  median,
  pyFloatStr,
  pyRound,
  sign,
  sqlNum,
  toBigInt,
} from './dec.js';
import * as mkt from './mkt-metrics.js';

// Port `pipelines/cockpit.py` (v8.0 W80.1–W80.4, WP10 — ceo-01 / marketing-06.2): thu số liệu điều
// hành cho cockpit TGĐ vào `channel_snapshots`.
//  - Từ điển chỉ số `data/metrics.json` (`loadMetrics` — lỗi cấu trúc → `MetricsError`; `metricSpec`
//    tra đúng id hoặc `ai.cost_usd.<agent>`).
//  - `collectInternal`: CHỈ kỳ ĐÃ ĐÓNG (`end <= now` giờ VN) — kỳ đang chạy → lỗi (0 query). Mỗi
//    metric 1 query trong savepoint; lỗi DB (thiếu bảng) → metric vào `errors`, KHÔNG thành 0. Số
//    nội bộ ghi `channel='noi_bo'`, `source='api'`, nguồn thật ở `source_ref`. Mốc kỳ truyền làm
//    tham số (không cắt kỳ bằng UTC trong SQL).
//  - Số chatbot (convlog) chỉ chụp khi đầu kỳ còn trong hạn lưu convlog (30 ngày): vượt hạn → errors
//    (số đếm thiếu ≠ số thật, sổ insert-only sẽ đóng băng số sai).
//  - `store`: INSERT thường (không ON CONFLICT/RETURNING — `agent_writer` không có SELECT), savepoint
//    từng dòng, trùng khóa → số đã chụp KHÔNG bị ghi đè; role có SELECT → so giá trị (bằng →
//    unchanged, khác → conflict); không SELECT → `unverified`. `atomic` (CSV): có conflict/unverified
//    → rollback CẢ lô (fail-closed).
//  - `readCsv`: kiểm TOÀN file trước khi connect; lỗi `dòng N, cột X: <lý do>` — KHÔNG in giá trị ô.
//  - `approvalTimes`/`summarizeHours`: thời gian duyệt của TGĐ; không có quyết định → null (KHÔNG 0).
//  - `content.drafts_rejected` + `content.review_hours_*` tính bằng CÙNG hàm `mkt.draftDecisions`
//    với mục 5 báo cáo định kỳ; không có quyết định → không ghi 2 metric giờ.

export const METRICS_PATH = join(DATA_DIR, 'metrics.json');
export const INTERNAL_CHANNEL = 'noi_bo';
export const CAPTURED_BY = 'agent:cockpit';
export const FEATURE_COLLECT = 'marketing-06.2';
export const METRIC_RE = /^[a-z][a-z0-9_.]{1,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{1,31}$/;
export const UNITS = [
  'lead',
  'câu',
  'bản',
  'cảnh báo',
  'USD',
  'job',
  'mục',
  'giờ',
  'VND',
  'đơn',
  'người',
  'lượt',
] as const;
export const BETTER = ['up', 'down', 'none'] as const;
export const SNAP_KINDS = ['day', 'week', 'month'];
export const SOURCES = ['manual_export', 'api'];
export const CSV_HEADER = ['channel', 'metric_id', 'period_kind', 'period_start', 'value'];
export const CSV_MAX_BYTES = 2 * 1024 * 1024;
// [0-9] tường minh: chữ số Unicode (full-width) KHÔNG được nhận (A03 validate đầu vào).
const INT_RE = /^[0-9]{1,15}$/;
const DEC_RE = /^[0-9]{1,15}(\.[0-9]{1,6})?$/;
export const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const AGENT_KEY = 'ai.cost_usd';
export const CEO_METRICS = [
  'approvals.ceo_decided',
  'approvals.ceo_hours_median',
  'approvals.ceo_hours_max',
  'approvals.ceo_expired',
];
export const MKT_METRICS = [
  'content.drafts_rejected',
  'content.review_hours_median',
  'content.review_hours_p90',
];

export type MetricSpec = {
  name: string;
  unit: (typeof UNITS)[number];
  better: (typeof BETTER)[number];
  kind: 'internal' | 'external';
  integer: boolean;
  channels: string[];
  source: string;
  per_agent?: boolean;
};
export type Metrics = Record<string, MetricSpec>;

/** Một số chụp (`channel_snapshots`); `period_start` = ngày VN 'YYYY-MM-DD'. */
export type SnapRow = {
  channel: string;
  metric_id: string;
  period_kind: string;
  period_start: string;
  value: Dec;
  source?: string;
  source_ref?: string | null;
};

/** data/metrics.json thiếu/hỏng/sai luật. */
export class MetricsError extends Error {
  override name = 'MetricsError';
}

const pyTuple = (xs: readonly string[]) => `(${xs.map((x) => pyRepr(x)).join(', ')})`;

// ---------------------------------------------------------------- W80.1

export function validateMetrics(cfg: unknown): Metrics {
  const ms = isPlainObject(cfg) ? cfg.metrics : undefined;
  if (!isPlainObject(ms) || !Object.keys(ms).length) {
    throw new MetricsError("thiếu object 'metrics'");
  }
  for (const [mid, s] of Object.entries(ms)) {
    if (!METRIC_RE.test(mid)) {
      throw new MetricsError(`metric_id '${mid}' không khớp ^[a-z][a-z0-9_.]{1,63}$`);
    }
    if (!isPlainObject(s)) throw new MetricsError(`${mid}: không phải object`);
    if (typeof s.name !== 'string' || !pyStrip(s.name)) {
      throw new MetricsError(`${mid}: thiếu name`);
    }
    if (!(UNITS as readonly unknown[]).includes(s.unit)) {
      throw new MetricsError(`${mid}: unit thiếu/lạ — dùng ${pyTuple(UNITS)}`);
    }
    if (!(BETTER as readonly unknown[]).includes(s.better)) {
      throw new MetricsError(`${mid}: better phải ${pyTuple(BETTER)}`);
    }
    if (s.kind !== 'internal' && s.kind !== 'external') {
      throw new MetricsError(`${mid}: kind phải internal|external`);
    }
    if (typeof s.integer !== 'boolean') throw new MetricsError(`${mid}: integer phải true|false`);
    const ch = s.channels;
    if (
      !Array.isArray(ch) ||
      !ch.length ||
      !ch.every((c) => typeof c === 'string' && CHANNEL_RE.test(c))
    ) {
      throw new MetricsError(`${mid}: channels thiếu/sai định dạng`);
    }
    if (s.kind === 'internal') {
      if (ch.length !== 1 || ch[0] !== INTERNAL_CHANNEL) {
        throw new MetricsError(`${mid}: internal chỉ có channels ['${INTERNAL_CHANNEL}']`);
      }
      const src = s.source;
      if (typeof src !== 'string' || !(src.startsWith('db:') || src.startsWith('file:'))) {
        throw new MetricsError(`${mid}: source internal phải db:|file:`);
      }
    } else {
      if (ch.includes(INTERNAL_CHANNEL)) {
        throw new MetricsError(`${mid}: external không dùng kênh '${INTERNAL_CHANNEL}'`);
      }
      if (s.source !== 'manual_export') {
        throw new MetricsError(`${mid}: source external phải manual_export`);
      }
    }
    if ('per_agent' in s && typeof s.per_agent !== 'boolean') {
      throw new MetricsError(`${mid}: per_agent phải true|false`);
    }
  }
  return ms as Metrics;
}

/** → {metric_id: spec}. Lỗi → MetricsError (không trả rỗng). KHÁC Python có chủ đích: NaN/Infinity
 * trong JSON bị từ chối (JSON.parse) — chặt hơn = fail-closed. */
export function loadMetrics(path: string = METRICS_PATH): Metrics {
  const name = basename(path);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    const t = pyOsName(e);
    throw new MetricsError(
      t === 'FileNotFoundError' ? `không có file ${name}` : `${name} hỏng: ${t}`,
    );
  }
  let cfg: unknown;
  try {
    cfg = parseJsonBytes(raw);
  } catch (e) {
    throw new MetricsError(`${name} hỏng: ${(e as { pyType?: string }).pyType ?? 'ValueError'}`);
  }
  return validateMetrics(cfg);
}

/** Spec của metric_id; `ai.cost_usd.<agent>` → spec `ai.cost_usd` (chỉ khi `per_agent`). */
export function metricSpec(metrics: Metrics, metricId: unknown): MetricSpec | null {
  if (typeof metricId !== 'string' || !METRIC_RE.test(metricId)) return null;
  if (Object.hasOwn(metrics, metricId)) return metrics[metricId] as MetricSpec;
  const i = metricId.lastIndexOf('.');
  const head = i < 0 ? '' : metricId.slice(0, i);
  const tail = metricId.slice(i + 1);
  const s = Object.hasOwn(metrics, head) ? metrics[head] : undefined;
  return s?.per_agent && /^[a-z0-9_]+$/.test(tail) ? s : null;
}

/** llm_usage.agent_id → `ai.cost_usd.<agent>` ([^a-z0-9_] → _). */
export function agentMetricId(agentId: unknown): string {
  const raw = pyTruthy(agentId) ? pyStr(agentId) : '';
  const a = cpHead(raw.toLowerCase().replace(/[^a-z0-9_]/gu, '_'), 51) || '_';
  return `${AGENT_KEY}.${a}`;
}

// ---------------------------------------------------------------- W80.4

export type HoursSummary = { n: number; median_h: number | null; max_h: number | null };

/** THUẦN: n=0 → median/max null (thiếu số ≠ 0 giờ). */
export function summarizeHours(hours: Iterable<number>): HoursSummary {
  const hs = [...hours].map(Number);
  if (!hs.length) return { n: 0, median_h: null, max_h: null };
  return {
    n: hs.length,
    median_h: pyRound(median(hs), 1),
    max_h: pyRound(
      hs.reduce((a, b) => Math.max(a, b)),
      1,
    ),
  };
}

/** Quyết định của khối trong [start, end): approved/rejected → giờ tạo → quyết; expired đếm riêng. */
export async function approvalTimes(
  db: Db,
  start: Date,
  end: Date,
  block = 'ceo',
): Promise<HoursSummary & { expired: number }> {
  const { rows } = await db.query(
    'select status, extract(epoch from (decided_at - created_at))::text as secs from approval_queue where block = $1 and decided_at >= $2 and decided_at < $3',
    [block, start, end],
  );
  const hours: number[] = [];
  let expired = 0;
  for (const r of rows) {
    if (r.status === 'expired') expired++;
    else if (r.status === 'approved' || r.status === 'rejected') {
      // Python `(decided - created)` với mốc None → TypeError (không đoán số).
      if (r.secs === null) throw new TypeError('approval_queue: thiếu created_at/decided_at');
      hours.push(Number(r.secs) / 3600);
    }
  }
  return { ...summarizeHours(hours), expired };
}

// ---------------------------------------------------------------- W80.2

const DAY_MS = 86_400_000;

/** Kỳ ĐÃ ĐÓNG → [start, end]; kỳ đang chạy → RangeError (Python ValueError). */
export function closed(kind: string, ref: string | Date, now?: Date | null): [Date, Date] {
  const [start, end] = periodBounds(kind, ref);
  const n = now ?? new Date();
  if (end.getTime() > n.getTime()) {
    throw new RangeError(
      `kỳ chưa đóng (${vnDate(start)} → hết ${vnDate(new Date(end.getTime() - DAY_MS))} giờ VN)`,
    );
  }
  return [start, end];
}

/** Ngày tham chiếu của kỳ VỪA ĐÓNG tính theo giờ VN. */
export function lastClosedRef(kind: string, now?: Date | null): string {
  return addDays(vnDate(periodBounds(kind, now ?? new Date())[0]), -1);
}

// [metric, nguồn, SQL] — SQL chỉ dùng $1 = HẾT kỳ khi không có $2 (pg đòi đúng số tham số).
const COUNT_SQL: [string, string, string][] = [
  ['leads.new', 'db:leads', 'select count(*)::text as n from leads where ts >= $1 and ts < $2'],
  [
    'content.drafts_created',
    'db:content_drafts',
    'select count(*)::text as n from content_drafts where created_at >= $1 and created_at < $2',
  ],
  [
    'content.drafts_approved',
    'db:approvals',
    "select count(distinct object_id)::text as n from approvals where object_type = 'content_draft' and decision = 'approved' and approved_at >= $1 and approved_at < $2",
  ],
  [
    'content.drafts_pending_end',
    'db:content_drafts',
    "select count(*)::text as n from content_drafts d where d.created_at < $1 and not exists (select 1 from approvals a where a.object_type = 'content_draft' and a.object_id = d.id::text and a.approved_at < $1)",
  ],
  [
    'market.alerts_open_end',
    'db:market_alerts',
    'select count(*)::text as n from market_alerts where opened_at < $1 and (closed_at is null or closed_at >= $1)',
  ],
  [
    'jobs.failed',
    'db:job_runs',
    'select count(*)::text as n from job_runs where ok is not true and started_at >= $1 and started_at < $2',
  ],
  [
    'approvals.overdue',
    'db:approval_queue',
    "select count(*)::text as n from approval_queue where due_at >= $1 and due_at < $2 and status in ('expired', 'pending') and due_at <= now()",
  ],
];

function row(mid: string, kind: string, start: Date, value: Dec, sourceRef: string): SnapRow {
  return {
    channel: INTERNAL_CHANNEL,
    metric_id: mid,
    period_kind: kind,
    period_start: vnDate(start),
    value,
    source: 'api',
    source_ref: sourceRef,
  };
}

export { row as internalRow };

const msg200 = (e: unknown) => cpHead(dbMsg(e), 200);

/** → [rows, errors]. Kỳ chưa đóng → RangeError (0 query). */
export async function collectInternal(
  db: Db,
  kind: string,
  ref: string | Date,
  opts: { dataDir?: string; now?: Date | null; directorsDir?: string } = {},
): Promise<[SnapRow[], string[]]> {
  const now = opts.now ?? new Date();
  const dataDir = opts.dataDir ?? DATA_DIR;
  const [start, end] = closed(kind, ref, now);
  const p = [start, end];
  const rows: SnapRow[] = [];
  const errors: string[] = [];
  for (const [mid, src, sql] of COUNT_SQL) {
    let n: string;
    try {
      const args = sql.includes('$2') ? p : [end];
      n = await sp(db, async () => (await db.query(sql, args)).rows[0].n);
    } catch (e) {
      if (!isDbError(e)) throw e;
      errors.push(`${mid}: ${msg200(e)}`);
      continue;
    }
    rows.push(row(mid, kind, start, dec(n), src));
  }

  let usage: { agent_id: unknown; cost: string }[] | null = null;
  try {
    usage = await sp(
      db,
      async () =>
        (
          await db.query(
            'select agent_id, coalesce(sum(cost_usd), 0)::text as cost from llm_usage where ts >= $1 and ts < $2 group by agent_id',
            p,
          )
        ).rows,
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    errors.push(`${AGENT_KEY}: ${msg200(e)}`);
  }
  if (usage !== null) {
    const per = new Map<string, Dec>();
    for (const u of usage) {
      const k = agentMetricId(u.agent_id);
      per.set(k, add(per.get(k) ?? dec(0), dec(u.cost)));
    }
    let total = dec(0);
    for (const v of per.values()) total = add(total, v);
    rows.push(row(AGENT_KEY, kind, start, total, 'db:llm_usage'));
    const keys = [...per.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys) rows.push(row(k, kind, start, per.get(k) as Dec, 'db:llm_usage'));
  }

  try {
    const block = loadDirector('ceo', opts.directorsDir).block;
    const t = await sp(db, () => approvalTimes(db, start, end, block));
    const src = 'db:approval_queue';
    rows.push(row('approvals.ceo_decided', kind, start, dec(t.n), src));
    if (t.median_h !== null) {
      // thiếu số ≠ 0 giờ
      rows.push(
        row('approvals.ceo_hours_median', kind, start, dec(pyFloatStr(t.median_h)), src),
        row('approvals.ceo_hours_max', kind, start, dec(pyFloatStr(t.max_h as number)), src),
      );
    }
    rows.push(row('approvals.ceo_expired', kind, start, dec(t.expired), src));
  } catch (e) {
    if (!isDbError(e) && !(e instanceof DirectorConfigError)) throw e;
    const m = isDbError(e) ? msg200(e) : cpHead(String((e as Error).message), 200);
    for (const x of CEO_METRICS) errors.push(`${x}: ${m}`);
  }

  try {
    const dd = await sp(db, () => mkt.draftDecisions(db, start, end));
    const src = 'db:content_drafts';
    rows.push(row('content.drafts_rejected', kind, start, dec(dd.total.rejected), src));
    const h = dd.hours;
    if (h.median_h !== null) {
      rows.push(
        row('content.review_hours_median', kind, start, dec(pyFloatStr(h.median_h)), src),
        row('content.review_hours_p90', kind, start, dec(pyFloatStr(h.p90_h as number)), src),
      );
    }
  } catch (e) {
    if (!isDbError(e)) throw e;
    for (const x of MKT_METRICS) errors.push(`${x}: ${msg200(e)}`);
  }

  const chatIds = ['chatbot.questions', 'chatbot.unanswered'];
  if (start.getTime() < now.getTime() - CONVLOG_RETAIN_DAYS * DAY_MS) {
    // Convlog đã purge phần đầu kỳ → số THIẾU; insert-only sẽ đóng băng số sai → không ghi.
    for (const m of chatIds) {
      errors.push(`${m}: convlog chỉ giữ ${CONVLOG_RETAIN_DAYS} ngày — kỳ vượt hạn lưu`);
    }
  } else if (!CONV_FILES.some((n) => existsSync(join(dataDir, n)))) {
    for (const m of chatIds) errors.push(`${m}: không có file ${CONV_FILES[0]}`);
  } else {
    const chat = collectChat(dataDir, start, end);
    const src = 'file:conversations.jsonl';
    rows.push(
      row('chatbot.questions', kind, start, dec(chat.in_period), src),
      row('chatbot.unanswered', kind, start, dec(chat.in_period - chat.answered_period), src),
    );
  }
  return [rows, errors];
}

/**
 * Port `agents.report.collect_chat` — số liệu convlog theo kỳ + toàn thời gian (file, đọc được cả
 * khi DB chết; đọc BYTES + split `\n` như lead_store). `answered` strict `=== true`; ts hỏng/không
 * phải chuỗi → `bad_ts`. Câu trả lời đồng ý bị bỏ (không phình chatbot.questions/unanswered).
 * docx P1: chỉ dòng `provenance: live`. shortcut: bản ở nhóm ceo_report — `Collectors.chat` của
 * `@samsam/core/ops/report` dùng được; gom vào core khi tích hợp.
 */
export function collectChat(dataDir: string, since: Date, until: Date): ChatStats {
  const z = () => ({ zalo: 0, messenger: 0, streamlit: 0 });
  const st: ChatStats = {
    total: 0,
    answered: 0,
    in_period: 0,
    answered_period: 0,
    by_channel: z(),
    by_channel_period: z(),
    bad_ts: 0,
    skipped: 0,
  };
  const tmp: Record<string, number> = { corrupt: 0, doc: 0, io_error: 0 };
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    for (const rec of iterConvlog(path, tmp, true)) {
      if (typeof rec.route === 'string' && CONSENT_REPLY_ROUTES.includes(rec.route)) continue;
      st.total++;
      const ch = channelOf(rec) as keyof ChatStats['by_channel'];
      st.by_channel[ch]++;
      if (rec.answered === true) st.answered++;
      const ts = parseTs(rec.ts);
      if (ts === null) {
        st.bad_ts++;
        continue;
      }
      if (since.getTime() <= ts.getTime() && ts.getTime() < until.getTime()) {
        st.in_period++;
        st.by_channel_period[ch]++;
        if (rec.answered === true) st.answered_period++;
      }
    }
  }
  st.skipped = (tmp.corrupt ?? 0) + (tmp.doc ?? 0) + (tmp.io_error ?? 0);
  st.excluded_not_live = (tmp.thu_nghiem ?? 0) + (tmp.thieu_provenance ?? 0);
  return st;
}

export function checkRow(metrics: Metrics, r: Partial<SnapRow>): void {
  const s = metricSpec(metrics, r.metric_id);
  if (s === null) throw new RangeError(`metric lạ: ${pyReprValue(r.metric_id ?? null)}`);
  const mid = r.metric_id as string;
  if (!s.channels.includes(r.channel as string)) {
    throw new RangeError(`${mid}: kênh không cho phép`);
  }
  if (!SNAP_KINDS.includes(r.period_kind as string)) throw new RangeError(`${mid}: period_kind lạ`);
  if (typeof r.period_start !== 'string' || parseDay(r.period_start) === null) {
    throw new TypeError(`${mid}: period_start phải là date`);
  }
  if (!SOURCES.includes(r.source as string)) throw new RangeError(`${mid}: source lạ`);
  const v = r.value;
  if (!v || typeof v.coef !== 'bigint' || !isFiniteDec(v) || sign(v) < 0) {
    throw new RangeError(`${mid}: value phải Decimal hữu hạn ≥ 0`);
  }
}

export type StoreStats = {
  inserted: number;
  unchanged: number;
  conflict: number;
  unverified: number;
  rolled_back: boolean;
};

class Conflict extends Error {}

/**
 * Ghi insert-only → {inserted, unchanged, conflict, unverified, rolled_back}. Row sai → lỗi TRƯỚC
 * mọi query. Chạy được dưới `agent_writer` (chỉ INSERT 8 cột): không ON CONFLICT/RETURNING.
 */
export async function store(
  db: Db,
  rows: SnapRow[],
  capturedBy: string,
  opts: { metrics?: Metrics; atomic?: boolean } = {},
): Promise<StoreStats> {
  const by = pyStrip(capturedBy ?? '');
  if (!by) throw new RangeError('store: thiếu captured_by');
  const metrics = opts.metrics ?? loadMetrics();
  for (const r of rows) checkRow(metrics, r);
  const st: StoreStats = {
    inserted: 0,
    unchanged: 0,
    conflict: 0,
    unverified: 0,
    rolled_back: false,
  };
  try {
    await withTx(db, async (c) => {
      for (const r of rows) {
        const key = [r.channel, r.metric_id, r.period_kind, r.period_start, r.source];
        await c.query('savepoint ck_row');
        try {
          await c.query(
            'insert into channel_snapshots (channel, metric_id, period_kind, period_start, value, source, source_ref, captured_by) values ($1, $2, $3, $4, $5, $6, $7, $8)',
            [...key.slice(0, 4), sqlNum(r.value), r.source, r.source_ref ?? null, by],
          );
          await c.query('release savepoint ck_row');
          st.inserted++;
          continue;
        } catch (e) {
          await c.query('rollback to savepoint ck_row');
          if ((e as { code?: string }).code !== '23505') throw e;
        }
        let old: { value: string } | undefined;
        try {
          old = (
            await c.query(
              'select value::text as value from channel_snapshots where channel = $1 and metric_id = $2 and period_kind = $3 and period_start = $4 and source = $5',
              key,
            )
          ).rows[0];
          await c.query('release savepoint ck_row');
        } catch (e) {
          await c.query('rollback to savepoint ck_row');
          if ((e as { code?: string }).code !== '42501') throw e;
          st.unverified++; // đã có, role không đọc được
          continue;
        }
        const o = old ? dec(old.value) : null;
        if (o && isFiniteDec(o) && cmp(o, r.value) === 0) st.unchanged++;
        else st.conflict++;
      }
      // CSV fail-closed: dòng đã có mà không so được (agent_writer) KHÔNG phân biệt được file y
      // nguyên với file đã sửa số → không được báo [done].
      if (opts.atomic && (st.conflict || st.unverified)) throw new Conflict();
    });
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
    st.inserted = 0;
    st.rolled_back = true;
  }
  return st;
}

// ---------------------------------------------------------------- W80.3

const countNl = (b: Uint8Array) => b.reduce((n, x) => n + (x === 0x0a ? 1 : 0), 0);

/** THUẦN, toàn file → [rows, errors]. Lỗi KHÔNG chứa giá trị ô. */
export function readCsv(
  path: string,
  metrics: Metrics,
  opts: { now?: Date | null; maxBytes?: number } = {},
): [SnapRow[], string[]] {
  const now = opts.now ?? new Date();
  const max = opts.maxBytes ?? CSV_MAX_BYTES;
  let raw: Buffer;
  try {
    if (statSync(path).size > max) return [[], [`dòng 1, cột (file): file > ${max} byte`]];
    raw = readFileSync(path);
  } catch (e) {
    return [[], [`dòng 1, cột (file): không đọc được file (${pyOsName(e)})`]];
  }
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = bom ? raw.subarray(3) : raw;
  const bad = utf8ErrorStart(body);
  if (bad >= 0) {
    // Python `decode("utf-8-sig")`: vị trí lỗi tính SAU BOM nhưng đếm `\n` trên bytes gốc — giữ y hệt.
    return [[], [`dòng ${countNl(raw.subarray(0, bad)) + 1}, cột (file): byte không phải UTF-8`]];
  }
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body);
  const rd = new CsvReader(text);
  const it = rd[Symbol.iterator]();
  let header: string[] | null;
  try {
    const h = it.next();
    header = h.done ? null : h.value;
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    return [[], ['dòng 1, cột (header): CSV hỏng']];
  }
  if (header === null) return [[], ['dòng 1, cột (header): file rỗng']];
  const hdr = header.map(pyStrip);
  if (hdr.length !== CSV_HEADER.length || hdr.some((h, i) => h !== CSV_HEADER[i])) {
    const missing = CSV_HEADER.filter((c) => !hdr.includes(c));
    return [
      [],
      [
        `dòng 1, cột (header): header phải đúng ${CSV_HEADER.join(',')}` +
          (missing.length ? ` — thiếu ${missing.join(', ')}` : ' — thừa cột hoặc sai thứ tự'),
      ],
    ];
  }
  const errors: string[] = [];
  const rows: SnapRow[] = [];
  const seen = new Set<string>();
  try {
    for (let x = it.next(); !x.done; x = it.next()) {
      const cells = x.value;
      const n = rd.lineNum;
      if (!cells.length || cells.every((c) => !pyStrip(c))) continue;
      if (cells.length !== CSV_HEADER.length) {
        errors.push(`dòng ${n}, cột (dòng): cần ${CSV_HEADER.length} cột`);
        continue;
      }
      const c = Object.fromEntries(CSV_HEADER.map((k, i) => [k, pyStrip(cells[i] as string)]));
      const [r, errs] = csvRow(c, metrics, now);
      for (const [col, why] of errs) errors.push(`dòng ${n}, cột ${col}: ${why}`);
      if (errs.length || r === null) continue;
      const key = [r.channel, r.metric_id, r.period_kind, r.period_start].join('\u0000');
      if (seen.has(key)) {
        errors.push(`dòng ${n}, cột (khóa): trùng khóa channel+metric_id+kỳ với dòng trước`);
        continue;
      }
      seen.add(key);
      rows.push(r);
    }
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    errors.push(`dòng ${rd.lineNum}, cột (dòng): CSV hỏng`);
  }
  if (!rows.length && !errors.length) errors.push('dòng 2, cột (file): không có dòng dữ liệu');
  return [errors.length ? [] : rows, errors];
}

function csvRow(
  c: Record<string, string>,
  metrics: Metrics,
  now: Date,
): [SnapRow | null, [string, string][]] {
  const errs: [string, string][] = [];
  const spec = metricSpec(metrics, c.metric_id);
  if (spec === null) errs.push(['metric_id', 'không có trong data/metrics.json']);
  else if (spec.kind !== 'external') errs.push(['metric_id', 'metric nội bộ — không nạp từ CSV']);
  else if (!spec.channels.includes(c.channel as string)) {
    errs.push(['channel', 'kênh không cho phép với metric này']);
  }
  const kindOk = SNAP_KINDS.includes(c.period_kind as string);
  if (!kindOk) errs.push(['period_kind', `phải ${SNAP_KINDS.join('|')}`]);
  let d: string | null = null;
  if (!DATE_RE.test(c.period_start as string)) errs.push(['period_start', 'phải YYYY-MM-DD']);
  else if (parseDay(c.period_start as string) === null) {
    errs.push(['period_start', 'ngày không hợp lệ']);
  } else d = c.period_start as string;
  if (d !== null && kindOk) {
    const [start, end] = periodBounds(c.period_kind as string, d);
    if (vnDate(start) !== d) {
      errs.push(['period_start', 'không phải ngày đầu kỳ (tuần: thứ Hai; tháng: ngày 1)']);
    } else if (end.getTime() > now.getTime()) errs.push(['period_start', 'kỳ chưa đóng']);
  }
  const isInt = spec?.integer === true;
  if (!(isInt ? INT_RE : DEC_RE).test(c.value as string)) {
    errs.push([
      'value',
      `phải là số ${isInt ? 'nguyên ≥ 0, không dấu nghìn' : '≥ 0, dấu chấm thập phân, không dấu nghìn'}`,
    ]);
  }
  if (errs.length) return [null, errs];
  return [
    {
      channel: c.channel as string,
      metric_id: c.metric_id as string,
      period_kind: c.period_kind as string,
      period_start: d as string,
      value: dec(c.value as string),
    },
    [],
  ];
}

const SAMPLE_NAME_RE = /(^|[^a-z])(mau|sample)([^a-z]|$)/;

/** Tên file có dấu hiệu MẪU (`mau`/`mẫu`/`sample`, tách khỏi chữ khác). */
export function isSampleName(path: string): boolean {
  const name = stripCombining(casefold(basename(path)).normalize('NFD'));
  return SAMPLE_NAME_RE.test(name.replaceAll('đ', 'd'));
}

export function csvSourceRef(path: string, sample: boolean): string {
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
  const name = cpHead(basename(path).replace(/[^\p{L}\p{N}_.-]/gu, '_'), 80);
  return `${sample ? 'sample:' : ''}${name}#sha256:${sha}`;
}

/** Python `_fmt`: nguyên → chữ số (không đuôi), không nguyên → `str(Decimal)`. */
export function fmtNum(v: Dec): string {
  return isIntegral(v) ? toBigInt(v).toString() : decStr(v);
}
