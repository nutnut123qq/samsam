import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { periodBounds, vnDate, vnFormat } from '@samsam/core/ops/period';
import { cpLen, cpSlice, squash } from '@samsam/core/ops/py';
import { isDbError } from '@samsam/core/ops/tx';
import { pgErrName } from '@samsam/core/rollout/counters';
import { businessDays, holidayWarning, loadShift } from '@samsam/core/rollout/rollout';
import { isHuman } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { pyStrip } from '@samsam/core/security/py';
import type { DbLease } from '../channels/channels.command.js';
import { fromIso, isoDate } from './py.js';

// Port `pipelines/ops_incidents.py` (v13.7 F06) — sổ sự cố vận hành theo PL02 mục 2. Bảng
// `ops_incidents` + `ops_incident_events` APPEND-ONLY (trigger DB): sửa sai = ghi sự kiện `note`.
// Chỉ tiêu (hằng code, số trong HĐ — không cấu hình): phát hiện ≤ 15 phút (thiếu `occurred_at` =
// "chưa đo", KHÔNG tính đạt); phản hồi lỗi nghiêm trọng ≤ 03 giờ / lỗi thường ≤ 03 ngày làm việc;
// sửa ≤ 07 ngày; `customer_resolved` đếm RIÊNG. `--by` là NGƯỜI thật; tiêu đề/ghi chú che PII.
// Giờ không kèm múi = giờ VN. `evaluate`/`summarize` THUẦN (báo cáo vận hành tháng dùng).
// Exit: 0 ok · 1 từ chối/DB lỗi · 2 tham số sai.

export const SEVERITIES = ['nghiem_trong', 'thuong'];
export const BEN = ['ben_a', 'ben_b', 'chua_xac_dinh'];
export const KINDS = ['responded', 'fixed', 'customer_resolved', 'note'];
export const DETECT_LIMIT_MS = 15 * 60_000;
export const RESPOND_SEVERE_MS = 3 * 3600_000;
export const RESPOND_NORMAL_WORKDAYS = 3;
export const FIX_LIMIT_MS = 7 * 86_400_000;
export const FUTURE_SKEW_MS = 5 * 60_000;
export const TITLE_MAX = 200;
export const SOURCE_MAX = 100;
export const NOTE_MAX = 500;
export const BY_MAX = 100;

/** Đầu vào bị từ chối — không ghi gì (Python IncidentError(ValueError)). */
export class IncidentError extends RangeError {
  override name = 'IncidentError';
}

/** ISO 8601; không kèm múi giờ = giờ VN (+07:00). */
export function parseTs(v: unknown, name: string): Date {
  if (v instanceof Date) return v;
  const r = fromIso(pyStrip(String(v)));
  if (r === null) throw new IncidentError(`${name}: cần thời điểm ISO (YYYY-MM-DD HH:MM[+07:00])`);
  return r.date; // naive → `fromIso` đã lấy giờ VN
}

export function checkBy(by: unknown): string {
  const s = squash(by ? String(by) : '');
  if (!s || cpLen(s) > BY_MAX || !isHuman(s)) {
    throw new IncidentError(
      `--by phải là tên NGƯỜI thật (1..${BY_MAX} ký tự, không agent:/system:)`,
    );
  }
  return maskPii(s);
}

/** Python `_text`: gộp khoảng trắng, cắt 2n TRƯỚC che PII (chống regex dài), che rồi cắt n. */
export function cleanText(v: unknown, name: string, n: number, required = true): string | null {
  const s = cpSlice(squash(v ? String(v) : ''), 0, n * 2);
  const out = pyStrip(cpSlice(maskPii(s), 0, n));
  if (required && !out) throw new IncidentError(`thiếu ${name}`);
  return out || null;
}

export type OpenArgs = {
  title: unknown;
  severity: unknown;
  source: unknown;
  ben: unknown;
  detectedAt: unknown;
  occurredAt?: unknown;
  by: unknown;
  now: Date;
};

export async function openIncident(db: Db, a: OpenArgs): Promise<string> {
  if (!SEVERITIES.includes(a.severity as string)) {
    throw new IncidentError(`--severity chỉ nhận ${SEVERITIES.join(', ')}`);
  }
  if (!BEN.includes(a.ben as string)) throw new IncidentError(`--ben chỉ nhận ${BEN.join(', ')}`);
  const det = parseTs(a.detectedAt, '--detected-at');
  const occ = a.occurredAt ? parseTs(a.occurredAt, '--occurred-at') : null;
  if (det.getTime() > a.now.getTime() + FUTURE_SKEW_MS) {
    throw new IncidentError('--detected-at ở tương lai');
  }
  if (occ !== null && occ > det) {
    throw new IncidentError('--occurred-at phải trước/bằng --detected-at');
  }
  const row = [
    cleanText(a.title, '--title', TITLE_MAX),
    a.severity,
    cleanText(a.source, '--source', SOURCE_MAX),
    a.ben,
    occ,
    det,
    checkBy(a.by),
  ];
  const { rows } = await db.query<{ id: string }>(
    'insert into ops_incidents (title, severity, source, ben_trach_nhiem, occurred_at, detected_at, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id',
    row,
  );
  return String(rows[0]?.id);
}

export type EventArgs = { by: unknown; at?: unknown; note?: unknown; now: Date };

export async function addEvent(
  db: Db,
  incidentId: bigint | number | string,
  kind: unknown,
  a: EventArgs,
): Promise<string> {
  if (!KINDS.includes(kind as string)) {
    throw new IncidentError(`--kind chỉ nhận ${KINDS.join(', ')}`);
  }
  const by = checkBy(a.by);
  const ts = a.at ? parseTs(a.at, '--at') : a.now;
  if (ts.getTime() > a.now.getTime() + FUTURE_SKEW_MS) throw new IncidentError('--at ở tương lai');
  const { rows } = await db.query<{ detected_at: Date }>(
    'select detected_at from ops_incidents where id = $1',
    [String(incidentId)],
  );
  if (!rows[0]) throw new IncidentError(`không có sự cố #${incidentId}`);
  if (ts < rows[0].detected_at) throw new IncidentError('--at trước lúc phát hiện sự cố');
  const ins = await db.query<{ id: string }>(
    'insert into ops_incident_events (incident_id, kind, at, by_name, note) values ($1, $2, $3, $4, $5) returning id',
    [String(incidentId), kind, ts, by, cleanText(a.note, '--note', NOTE_MAX, false)],
  );
  return String(ins.rows[0]?.id);
}

/** (id, title, severity, source, ben, occurred_at, detected_at) */
export type IncidentRow = [string | number, string, string, string, string, Date | null, Date];
/** (incident_id, kind, at) */
export type EventRow = [string | number, string, Date];
export type Loaded = { incidents: IncidentRow[]; events: EventRow[] };

/** CHỈ SELECT — sự cố phát hiện trong [start, end) + sự kiện của chúng. */
export async function load(db: Db, start: Date, end: Date): Promise<Loaded> {
  const incs = await db.query(
    'select id, title, severity, source, ben_trach_nhiem, occurred_at, detected_at from ops_incidents where detected_at >= $1 and detected_at < $2 order by detected_at, id',
    [start, end],
  );
  const evs = await db.query(
    'select e.incident_id, e.kind, e.at from ops_incident_events e join ops_incidents i on i.id = e.incident_id where i.detected_at >= $1 and i.detected_at < $2 order by e.at, e.id',
    [start, end],
  );
  return {
    incidents: incs.rows.map((r) => [
      String(r.id),
      r.title,
      r.severity,
      r.source,
      r.ben_trach_nhiem,
      r.occurred_at,
      r.detected_at,
    ]),
    events: evs.rows.map((r) => [String(r.incident_id), r.kind, r.at]),
  };
}

function first(events: readonly EventRow[], iid: unknown, kind: string): Date | null {
  let best: Date | null = null;
  for (const [i, k, at] of events) {
    if (i === iid && k === kind && (best === null || at < best)) best = at;
  }
  return best;
}

export type SlaState = 'ok' | 'late' | 'pending' | 'unmeasured';
export type Evaluated = {
  id: string | number;
  severity: string;
  ben: string;
  detect: SlaState;
  respond: SlaState;
  fix: SlaState;
  customer_resolved_at: Date | null;
};

/** THUẦN → mỗi sự cố {id, severity, ben, detect, respond, fix, customer_resolved_at}. */
export function evaluate(
  incidents: readonly IncidentRow[],
  events: readonly EventRow[],
  shift: unknown,
  now: Date,
): Evaluated[] {
  const out: Evaluated[] = [];
  for (const [iid, , sev, , ben, occ, det] of incidents) {
    const detect: SlaState =
      occ === null
        ? 'unmeasured'
        : det.getTime() - occ.getTime() <= DETECT_LIMIT_MS
          ? 'ok'
          : 'late';
    const resp = first(events, iid, 'responded');
    let respond: SlaState;
    if (sev === 'nghiem_trong') {
      const due = det.getTime() + RESPOND_SEVERE_MS;
      respond =
        resp !== null && resp.getTime() <= due
          ? 'ok'
          : resp !== null || now.getTime() > due
            ? 'late'
            : 'pending';
    } else {
      const end = resp ?? now;
      const within = businessDays(det, end, shift) <= RESPOND_NORMAL_WORKDAYS;
      respond = resp !== null && within ? 'ok' : resp === null && within ? 'pending' : 'late';
    }
    const fixAt = first(events, iid, 'fixed');
    const due = det.getTime() + FIX_LIMIT_MS;
    const fix: SlaState =
      fixAt !== null && fixAt.getTime() <= due
        ? 'ok'
        : fixAt !== null || now.getTime() > due
          ? 'late'
          : 'pending';
    out.push({
      id: iid,
      severity: sev,
      ben,
      detect,
      respond,
      fix,
      customer_resolved_at: first(events, iid, 'customer_resolved'),
    });
  }
  return out;
}

export type Counts = Record<SlaState, number>;

export function summarize(
  rows: readonly Evaluated[],
  key: 'detect' | 'respond' | 'fix',
  severity: string | null = null,
): Counts {
  const c: Counts = { ok: 0, late: 0, pending: 0, unmeasured: 0 };
  for (const r of rows) if (severity === null || r.severity === severity) c[r[key]]++;
  return c;
}

// =============================================================== CLI

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type OpsIncidentsOpts = {
  open?: boolean;
  event?: string;
  list?: boolean;
  title?: string;
  severity?: string;
  source?: string;
  ben?: string;
  detectedAt?: string;
  occurredAt?: string;
  kind?: string;
  at?: string;
  note?: string;
  by?: string;
  month?: string;
};

export type OpsIncidentsDeps = {
  env?: Env;
  io?: Io;
  connect?: () => Promise<DbLease | null>;
  now?: () => Date;
  /** Lịch ngày làm việc (`rollout.load_shift`) — test truyền lịch cố định. */
  shift?: () => unknown;
  holidayWarning?: () => string | null;
};

const choice = (flag: string, v: string, xs: string[]) =>
  `argument ${flag}: invalid choice: '${v}' (choose from ${xs.map((x) => `'${x}'`).join(', ')})`;

/** `python -m pipelines.ops_incidents`. */
export async function opsIncidentsMain(
  o: OpsIncidentsOpts,
  d: OpsIncidentsDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`ops_incidents: error: ${msg}`);
    return 2;
  };
  const ops = (
    [
      ['--open', Boolean(o.open)],
      ['--event', o.event !== undefined],
      ['--list', Boolean(o.list)],
    ] as const
  ).filter(([, on]) => on);
  if (ops.length === 0) return usage('one of the arguments --open --event --list is required');
  if (ops.length > 1) {
    return usage(`argument ${ops[1]?.[0]}: not allowed with argument ${ops[0]?.[0]}`);
  }
  let eventId: bigint | null = null;
  if (o.event !== undefined) {
    const m = /^[ \t\n\r\v\f]*([+-]?\d+(?:_\d+)*)[ \t\n\r\v\f]*$/.exec(o.event);
    if (!m?.[1]) return usage(`argument --event: invalid int value: '${o.event}'`);
    eventId = BigInt(m[1].replaceAll('_', ''));
  }
  for (const [flag, v, xs] of [
    ['--severity', o.severity, SEVERITIES],
    ['--ben', o.ben, BEN],
    ['--kind', o.kind, KINDS],
  ] as const) {
    if (v !== undefined && !xs.includes(v)) return usage(choice(flag, v, xs));
  }
  if (o.open && ![o.title, o.severity, o.source, o.ben, o.detectedAt, o.by].every(Boolean)) {
    return usage('--open cần --title --severity --source --ben --detected-at --by');
  }
  if (eventId !== null && !(o.kind && o.by)) return usage('--event cần --kind --by');
  const now = d.now?.() ?? new Date();
  let bounds: [Date, Date] | null = null;
  if (o.list) {
    const ref = o.month ? isoDate(`${o.month}-01`) : vnDate(now);
    if (ref === null) return usage('--month cần YYYY-MM');
    bounds = periodBounds('month', `${ref.slice(0, 8)}01`);
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) {
    io.out('[err] không kết nối được Postgres');
    return 1;
  }
  const db = lease.db;
  try {
    if (o.open) {
      const iid = await openIncident(db, {
        title: o.title,
        severity: o.severity,
        source: o.source,
        ben: o.ben,
        detectedAt: o.detectedAt,
        occurredAt: o.occurredAt,
        by: o.by,
        now,
      });
      io.out(`[done] đã ghi sự cố #${iid}`);
      return 0;
    }
    if (eventId !== null) {
      const eid = await addEvent(db, eventId, o.kind, { by: o.by, at: o.at, note: o.note, now });
      io.out(`[done] sự cố #${eventId}: ghi mốc ${o.kind} (#${eid})`);
      return 0;
    }
    const [s, end] = bounds as [Date, Date];
    const data = await load(db, s, end);
    const rows = evaluate(data.incidents, data.events, (d.shift ?? loadShift)(), now);
    io.out(`[list] ${rows.length} sự cố phát hiện trong ${vnFormat(s, '%m/%Y')}`);
    for (const r of rows) {
      const cr = r.customer_resolved_at;
      io.out(
        `  #${r.id} ${r.severity} (${r.ben}): phát hiện ${r.detect} · phản hồi ${r.respond} · sửa ${r.fix} · xử lý khách ${cr ? 'xong' : 'chưa ghi'}`,
      );
    }
    const w = (d.holidayWarning ?? (() => holidayWarning()))();
    if (w) io.out(`[warn] ${w}`);
    return 0;
  } catch (e) {
    if (e instanceof IncidentError) {
      io.out(`[warn] ${e.message} — không ghi`);
      return 1;
    }
    if (!isDbError(e)) throw e;
    io.out(`[err] lỗi DB: ${pgErrName(e)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}
