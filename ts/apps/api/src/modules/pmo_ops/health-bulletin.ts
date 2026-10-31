import { readFileSync } from 'node:fs';
import { pyFloat, WARN_RATIO } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cleanDetail, JobConfigError } from '@samsam/core/ops/job-runs';
import { vnDate, vnFormat } from '@samsam/core/ops/period';
import { cpSlice, squash } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { smtpSender } from '@samsam/core/ops/red-alert';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError } from '@samsam/core/ops/tx';
import { createGateway } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { pyStrip } from '@samsam/core/security/py';
import { loadWorkerJobs } from '../../jobs.js';
import { errName, isoDate, pyFixed, pyOsName } from './py.js';
import { loadConfig, RetentionError, statusLines } from './retention.js';

// Port `scripts/health_bulletin.py` (v3.7, F17.2 + F17.3 FinOps — data_platform-07.1 "Giám sát lỗi").
// Mọi số lấy từ SQL — 0 lời gọi LLM. 6 mục cố định: DB · Job 24h · Chi phí AI tháng theo agent · Lời gọi
// LLM lỗi 24h · Hàng chờ duyệt · Hạn lưu dữ liệu cá nhân (đọc `data/retention.json`, TTL null = CẢNH
// BÁO). Bản tin CHỈ BÁO — việc chặn do gateway làm. DB chết/thiếu DSN → vẫn ra bản tin, exit 0. Gửi
// (human-gate C2.4): mặc định KHÔNG; `--notify` + `HEALTH_NOTIFY=email|telegram` + biến kênh đủ mới mở
// mạng; gửi lỗi → cảnh báo, exit 0; không in token/mật khẩu/URL bot. KHÔNG đọc `.env` (Python
// `load_dotenv` — TS chỉ dùng env tiến trình).

export const CONNECT_TIMEOUT_MS = 3_000; // bản tin DB chết phải ra ≤10s
export const NOTIFY_TIMEOUT_MS = 10_000;
export const TELEGRAM_MAX = 4000; // giới hạn Telegram 4096 ký tự/tin
// Job lịch → số giờ tối đa giữa 2 lần chạy OK; quá hạn = "không chạy/trễ".
export const EXPECTED_JOBS: Record<string, number> = {
  'ingest.lead_store': 24,
  'agents.report': 24 * 8,
};
// Mốc 00:00 ngày 1 tháng này giờ VN — PHẢI giống SPEND_SQL của gateway (test drift-guard).
export const MONTH_START_SQL =
  "(date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')";
export const MISSING = 'missing';
export const H_DB = '## 1. DB';
export const H_JOBS = '## 2. Job 24h';
export const H_COST = '## 3. Chi phí AI tháng này theo agent';
export const H_ERR = '## 4. Lời gọi LLM lỗi 24h';
export const H_QUEUE = '## 5. Hàng chờ duyệt';
export const H_RETENTION = '## 6. Hạn lưu dữ liệu cá nhân';
export const FEATURE = 'data_platform-07.1';
export { WARN_RATIO };

/** v13.7: + mọi job lịch on-prem (`deploy/onprem/jobs.json`, dòng `job:<tên>`). Lịch hỏng → chỉ
 * danh sách cũ (không im lặng — mục Job vẫn báo job cũ trễ). Lịch đọc như worker TS (bước = lệnh TS
 * hoặc bước giữ Python) — image TS không chứa tệp Python nên kiểm tệp kiểu job_runs sẽ luôn "hỏng". */
export function expectedJobs(
  load: () => Record<string, { max_gap_hours: number }> = () => loadWorkerJobs(),
) {
  let sched: Record<string, number> = {};
  try {
    for (const [n, j] of Object.entries(load())) sched[`job:${n}`] = j.max_gap_hours;
  } catch (e) {
    if (!(e instanceof JobConfigError)) throw e;
    sched = {};
  }
  return { ...EXPECTED_JOBS, ...sched };
}

/** v13.4 — tình trạng `data/retention.json` (không DB): TTL null = CẢNH BÁO chưa chốt. */
export function retentionLines(path?: string): string[] {
  try {
    return statusLines(loadConfig(path));
  } catch (e) {
    if (!(e instanceof RetentionError)) throw e;
    return [`- LỖI cấu hình hạn lưu (${e.message}) — job xóa không chạy`];
  }
}

export type Jobs = {
  counts: [string, number, number][];
  failed: [string, unknown, unknown][];
  expected: Record<string, number>;
  last_ok_hours: Record<string, number>;
};
export type Data = {
  db_ok: boolean;
  db_error?: string;
  jobs?: unknown;
  spend?: unknown;
  llm_errors?: unknown;
  pending?: unknown;
};

async function qJobs(db: Db, exp: Record<string, number>): Promise<Jobs> {
  const counts = await db.query(
    "select job, count(*) filter (where ok) as ok, count(*) filter (where ok is not true) as bad from job_runs where started_at >= now() - interval '24 hours' group by job order by job",
  );
  const failed = await db.query(
    "select job, started_at, detail from job_runs where started_at >= now() - interval '24 hours' and ok is not true order by started_at desc limit 20",
  );
  const last = await db.query(
    'select job, extract(epoch from now() - max(started_at)) / 3600 as h from job_runs where ok and job = any($1) group by job',
    [Object.keys(exp)],
  );
  return {
    counts: counts.rows.map((r) => [r.job, Number(r.ok), Number(r.bad)]),
    failed: failed.rows.map((r) => [r.job, r.started_at, r.detail]),
    expected: exp,
    last_ok_hours: Object.fromEntries(last.rows.map((r) => [r.job, Number(r.h)])),
  };
}

async function qSpend(db: Db): Promise<Record<string, number>> {
  const { rows } = await db.query(
    `select agent_id, coalesce(sum(cost_usd), 0) as c from llm_usage where ts >= ${MONTH_START_SQL} group by agent_id`,
  );
  return Object.fromEntries(rows.map((r) => [r.agent_id, Number(r.c)]));
}

async function qErrors(db: Db): Promise<[string, number][]> {
  const { rows } = await db.query(
    "select agent_id, count(*) as n from llm_usage where not ok and ts >= now() - interval '24 hours' group by agent_id order by agent_id",
  );
  return rows.map((r) => [r.agent_id, Number(r.n)]);
}

async function qPending(db: Db): Promise<number> {
  const { rows } = await db.query(
    "select count(*) as n from content_drafts where status = 'pending'",
  );
  return Number(rows[0]?.n);
}

/** Số liệu 4 mục sau DB. Lỗi từng mục không làm hỏng mục khác (mỗi câu tự giao dịch). */
export async function collect(db: Db, exp: Record<string, number> = expectedJobs()): Promise<Data> {
  const data: Data = { db_ok: true };
  const parts: [keyof Data, () => Promise<unknown>][] = [
    ['jobs', () => qJobs(db, exp)],
    ['spend', () => qSpend(db)],
    ['llm_errors', () => qErrors(db)],
    ['pending', () => qPending(db)],
  ];
  for (const [key, fn] of parts) {
    try {
      (data as Record<string, unknown>)[key] = await fn();
    } catch (e) {
      if (!isDbError(e)) throw e;
      (data as Record<string, unknown>)[key] =
        (e as { code?: string }).code === '42P01' ? MISSING : { error: pgErrName(e) };
    }
  }
  return data;
}

/** Connect (timeout 3 giây) + collect; DB chết/thiếu DSN → {db_ok: false} (chỉ tên lỗi, không DSN). */
export async function gather(env: Env = process.env): Promise<Data> {
  const dsn = env.DATABASE_URL;
  if (!dsn) return { db_ok: false, db_error: 'thiếu DATABASE_URL' };
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(dsn, { connectionTimeoutMillis: CONNECT_TIMEOUT_MS, max: 1 }, env);
    await pool.query('select 1');
  } catch (e) {
    await pool?.end().catch(() => {});
    return { db_ok: false, db_error: isDbError(e) ? pgErrName(e) : errName(e) };
  }
  try {
    return await collect(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** [(job, giờ từ lần OK gần nhất | null, hạn giờ)] cho job quá hạn. */
export function lateJobs(
  lastOk: Record<string, number>,
  expected: Record<string, number> = EXPECTED_JOBS,
): [string, number | null, number][] {
  const out: [string, number | null, number][] = [];
  for (const [job, limit] of Object.entries(expected)) {
    const h = Object.hasOwn(lastOk, job) ? (lastOk[job] as number) : null;
    if (h === null || h > limit) out.push([job, h, limit]);
  }
  return out;
}

export type CostRow = [string, number, number, number | null, string];

/** [(agent, spend, cap, pct|null, nhãn)] — so sánh giống `_gate` của gateway. */
export function costRows(spend: Record<string, number>, caps: Record<string, number>): CostRow[] {
  const agents = [
    ...new Set([...Object.keys(spend), ...Object.keys(caps).filter((k) => k !== 'default')]),
  ].sort(cpCmp);
  return agents.map((a): CostRow => {
    const s = Number(spend[a] ?? 0);
    const cap = Number(Object.hasOwn(caps, a) ? caps[a] : (caps.default ?? 0));
    if (cap <= 0) return [a, s, cap, null, 'ĐÃ CHẶN (cap 0)'];
    const label = s >= cap ? 'ĐÃ CHẶN (gateway)' : s >= WARN_RATIO * cap ? 'CẢNH BÁO' : 'OK';
    return [a, s, cap, (100 * s) / cap, label];
  });
}

/** Giá trị từ DB vào markdown: che PII/secret, bỏ xuống dòng/'|'. */
function cell(v: unknown): string {
  return cpSlice(squash((cleanDetail(v) ?? '').replaceAll('|', '/')), 0, 300);
}

function sectionState(val: unknown, table: string): string | null {
  if (val === MISSING) {
    return `chưa có bảng \`${table}\` — chạy \`python scripts/apply_schema.py\``;
  }
  if (typeof val === 'object' && val !== null && !Array.isArray(val) && 'error' in val) {
    return `lỗi đọc \`${table}\` (${String((val as { error: unknown }).error)})`;
  }
  return null;
}

export type RenderOpts = {
  caps?: Record<string, number> | null;
  capError?: string | null;
  retention?: string[] | null;
  /** "Sinh lúc" (Python `datetime.now(VN)`) — test truyền mốc cố định. */
  now?: Date;
};

export function render(data: Data, day: string, o: RenderOpts = {}): string {
  const now = o.now ?? new Date();
  const L: string[] = [
    `# Bản tin sức khỏe hệ thống — ${day}`,
    '',
    `_Sinh lúc ${vnFormat(now, '%Y-%m-%d %H:%M')} giờ VN — số liệu từ SQL, không dùng LLM. Bản tin chỉ BÁO, không tự xử lý._`,
    '',
    H_DB,
    '',
  ];
  const down = !data.db_ok;
  if (down) {
    L.push(
      `- **DB không truy cập được** (${data.db_error ?? 'None'}) — kiểm service Postgres / \`DATABASE_URL\` (SOP mục 7).`,
    );
  } else L.push('- DB: sống (connect + query OK)');
  const na = '- không có số liệu (DB không truy cập được)';

  L.push('', H_JOBS, '', '_Nguồn: bảng `job_runs` (24h qua)._', '');
  const jobs = data.jobs;
  if (down) L.push(na);
  else if (sectionState(jobs, 'job_runs')) L.push(`- ${sectionState(jobs, 'job_runs')}`);
  else {
    const j = jobs as Jobs;
    if (j.counts.length) {
      L.push('| Job | OK | Lỗi |', '|---|---:|---:|');
      for (const [n, ok, bad] of j.counts) L.push(`| ${cell(n)} | ${ok} | ${bad} |`);
    } else L.push('- không có lần chạy nào trong 24h');
    for (const [n, ts, detail] of j.failed) {
      const when = ts instanceof Date ? vnFormat(ts, '%Y-%m-%d %H:%M') : cell(ts);
      L.push(`- LỖI \`${cell(n)}\` lúc ${when}: ${cell(detail)}`);
    }
    for (const [n, h, limit] of lateJobs(j.last_ok_hours, j.expected ?? EXPECTED_JOBS)) {
      const seen = h === null ? 'chưa có lần OK nào' : `lần OK gần nhất ${pyFixed(h, 1)} giờ trước`;
      L.push(`- KHÔNG CHẠY/TRỄ \`${n}\` — ${seen} (hạn ${limit} giờ)`);
    }
  }

  L.push(
    '',
    H_COST,
    '',
    `_Nguồn: bảng \`llm_usage\` (\`sum(cost_usd)\` từ 00:00 ngày 1 giờ VN) + trần \`data/llm_gateway.json\` \`monthly_cap_usd\`. Ngưỡng: ≥${pyFixed(WARN_RATIO * 100, 0)}% cảnh báo, ≥100% gateway chặn._`,
    '',
  );
  const spend = data.spend;
  if (down) L.push(na);
  else if (sectionState(spend, 'llm_usage')) L.push(`- ${sectionState(spend, 'llm_usage')}`);
  else if (o.capError || !o.caps) L.push(`- không đọc được trần chi phí (${o.capError ?? 'None'})`);
  else {
    L.push('| Agent | Đã dùng (USD) | Trần (USD) | % | Trạng thái |', '|---|---:|---:|---:|---|');
    for (const [a, s, cap, p, label] of costRows(spend as Record<string, number>, o.caps)) {
      L.push(
        `| ${cell(a)} | ${pyFixed(s, 4)} | ${pyFixed(cap, 2)} | ${p === null ? '—' : `${pyFixed(p, 0)}%`} | ${label} |`,
      );
    }
  }

  L.push('', H_ERR, '', '_Nguồn: bảng `llm_usage` `ok = false` (24h qua)._', '');
  const errs = data.llm_errors;
  if (down) L.push(na);
  else if (sectionState(errs, 'llm_usage')) L.push(`- ${sectionState(errs, 'llm_usage')}`);
  else {
    const list = errs as [string, number][];
    L.push(`- Tổng: ${list.reduce((t, [, n]) => t + Number(n), 0)}`);
    for (const [a, n] of list) L.push(`  - \`${cell(a)}\`: ${n}`);
  }

  L.push('', H_QUEUE, '', "_Nguồn: bảng `content_drafts` `status = 'pending'`._", '');
  const pend = data.pending;
  if (down) L.push(na);
  else if (sectionState(pend, 'content_drafts'))
    L.push(`- ${sectionState(pend, 'content_drafts')}`);
  else L.push(`- Draft chờ duyệt: ${pend}`);

  L.push(
    '',
    H_RETENTION,
    '',
    '_Nguồn: `data/retention.json` (CV / chấm công / ảnh-video / ghi âm vườn); job `scripts/retention_purge.py`._',
    '',
  );
  L.push(...(o.retention ?? retentionLines()));
  return `${L.join('\n')}\n`;
}

export type FetchLike = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;
export type Sender = (to: string, subject: string, body: string) => Promise<void>;
export type NotifyDeps = {
  env?: Env;
  fetch?: FetchLike;
  /** SMTP (STARTTLS bắt buộc + kiểm chứng chỉ — core `smtpSender`) | null khi chưa cấu hình. */
  smtp?: (env: Env) => Sender | null;
  log?: (s: string) => void;
};

/** Cổng gửi — 'skipped' | 'sent' | 'error'. Chỉ mở mạng khi đủ biến. */
export async function notify(text: string, d: NotifyDeps = {}): Promise<string> {
  const env = d.env ?? process.env;
  const log = d.log ?? ((s: string) => console.log(s));
  const kind = pyStrip(env.HEALTH_NOTIFY ?? '').toLowerCase();
  try {
    if (kind === 'telegram' && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const body = new URLSearchParams({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: cpSlice(text, 0, TELEGRAM_MAX),
      }).toString();
      const f = d.fetch ?? (globalThis.fetch as unknown as FetchLike);
      const res = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      // urllib: HTTP ≠ 2xx → HTTPError (gửi lỗi).
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: 'HTTPError' });
    } else if (kind === 'email' && env.SMTP_HOST && env.HEALTH_MAIL_TO) {
      // Python: From = SMTP_USER | health-bulletin@localhost; STARTTLS verify cert+hostname.
      const send = (d.smtp ?? smtpSender)({
        ...env,
        RED_ALERT_NOTIFY: 'email',
        SMTP_FROM: env.SMTP_USER || 'health-bulletin@localhost',
      });
      if (send === null) throw new Error('SMTP chưa cấu hình');
      await send(env.HEALTH_MAIL_TO, '[Sâm Sâm AI] Bản tin sức khỏe hệ thống', text);
    } else {
      log('[notify] bỏ qua (chưa cấu hình)');
      return 'skipped';
    }
  } catch (e) {
    // gửi lỗi không làm hỏng bản tin — chỉ in TÊN lỗi (không token/URL bot/mật khẩu).
    log(`[notify] gửi lỗi (${errName(e)}) — bản tin vẫn ở file/stdout`);
    return 'error';
  }
  log(`[notify] đã gửi qua ${kind}`);
  return 'sent';
}

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type HealthOpts = { outDir?: string; date?: string; notify?: boolean };
export type HealthDeps = NotifyDeps & {
  io?: Io;
  now?: () => Date;
  gather?: (env: Env) => Promise<Data>;
  /** trần `monthly_cap_usd` của gateway (`_config()`); lỗi → tên lỗi. */
  caps?: () => Record<string, number>;
  retention?: () => string[];
};

function gatewayCaps(env: Env): Record<string, number> {
  const cfg = createGateway(null, { env }).config();
  return Object.fromEntries(
    Object.entries(cfg.monthly_cap_usd).map(([k, v]) => {
      const n = pyFloat(v); // Python `float(v)`
      if (n === null) throw Object.assign(new Error(`cap '${k}'`), { name: 'ValueError' });
      return [k, n];
    }),
  );
}

/** `python scripts/health_bulletin.py [--out-dir DIR] [--date YYYY-MM-DD] [--notify]`. */
export async function healthMain(o: HealthOpts, d: HealthDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const now = d.now?.() ?? new Date();
  let day = vnDate(now);
  if (o.date !== undefined && o.date !== '') {
    const v = isoDate(o.date);
    if (v === null) {
      io.err('health_bulletin: error: --date sai định dạng YYYY-MM-DD');
      return 2;
    }
    day = v;
  }
  const name = `health-${day}.md`;
  // KHÁC Python có chủ đích (r19): tính năng TẮT → `[rollout]` exit 2 TRƯỚC connect/in/ghi (Python
  // đọc DB + in bản tin ra stdout rồi mới chặn ở write_report).
  const why = await blocked(null, 'bản tin sức khỏe', null, { report: name });
  if (why) {
    io.out(`[rollout] ${why} — không gửi`);
    return 2;
  }
  const data = await (d.gather ?? gather)(env);
  let caps: Record<string, number> | null = null;
  let capError: string | null = null;
  try {
    caps = (d.caps ?? (() => gatewayCaps(env)))();
  } catch (e) {
    caps = null;
    capError = errName(e);
  }
  const text = render(data, day, {
    caps,
    capError,
    retention: d.retention?.() ?? null,
    now,
  });
  io.out(text);
  let rc = 0;
  let sent = text;
  // docx P2 (data_platform-07.1, HĐ 6.7, PL02 mục 1): ghi qua `writeReport` — TẮT → không sinh; chạy
  // thử / có người duyệt → nhãn trong nội dung; sổ `report_outputs`. sample=false: số đo trực tiếp.
  try {
    const path = await writeReport(text, o.outDir ?? REPORTS_DIR, name, false);
    sent = readFileSync(path).toString('utf8'); // đúng bản có nhãn
    io.out(`[done] ${path}`);
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      io.out(`[rollout] ${e.message} — không gửi`);
      return 2;
    }
    // Python `except OSError`: lỗi hệ thống tệp (Node SystemError có `syscall`).
    if (typeof (e as { syscall?: unknown }).syscall !== 'string') throw e;
    io.out(`[err] không ghi được file bản tin (${pyOsName(e)}) — nội dung đã in stdout`);
    rc = 1;
  }
  if (o.notify) {
    // Thông báo NỘI BỘ vận hành (như cảnh báo đỏ — vẫn gửi khi chạy thử, chỉ dừng khi TẮT).
    await notify(sent, { ...d, env, log: io.out });
  } else io.out('[notify] bỏ qua (chưa cấu hình — cần --notify)');
  return rc;
}
