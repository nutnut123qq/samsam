import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import type { Queue } from 'bullmq';
import type pg from 'pg';
import { createPool, SERVICES, type Service, ServiceBindError, servicePool } from '../db.js';
import { approvalEnforced, type Env, pyStrip } from '../env.js';
import { REPO_ROOT, repoPath } from '../paths.js';
import { dep } from './deps.js';
import { cpSlice, isInt, isPlainObject, type JsonFileError, readJson } from './py.js';

// Port `pipelines/job_runs.py` — lịch sử chạy job lịch (bảng `job_runs`, F17.2) + wrapper lịch
// on-prem. Python: systemd timer → `python -m pipelines.job_runs --run <tên>` giữ khóa FILE chống
// chạy chồng. TS: BullMQ repeatable job (`registerJobSchedulers`) → `runScheduled` giữ khóa
// ADVISORY Postgres theo phiên (Postgres tự nhả khi kết nối/tiến trình chết — không khóa mồ côi,
// như flock) + đúng 1 dòng `job:<tên>` mỗi lần chạy; bị khóa → dòng ok=false + exit 75.
// Ghi `job_runs` lỗi → cảnh báo (KHÔNG in DSN), job vẫn chạy, exit code giữ nguyên.

export const DETAIL_MAX = 300;
const PRE_MAX = DETAIL_MAX * 4; // cắt trước regex (chống DoS)
export const STEP_TIMEOUT_MS = 3 * 3600_000;
export const EXIT_LOCKED = 75;
export const EXIT_SERVICE = 78; // EX_CONFIG: login dịch vụ thiếu/sai quyền
export const JOBS_FILE = repoPath('deploy', 'onprem', 'jobs.json');
// Job → login dịch vụ; mặc định 'job'. Diễn tập khôi phục/DR tạo DB tạm → login quản trị hạ
// tầng (giữ DATABASE_URL, null).
export const JOB_SERVICE: Record<string, Service | null> = {
  backup: 'backup',
  restore_drill: null,
  dr_drill: null,
};
const NAME_RE = /^[a-z0-9_]{1,40}$/;
const INSERT =
  'insert into job_runs (job, started_at, finished_at, ok, detail, host) values ($1, $2, $3, $4, $5, $6)';

// Khoảng trắng Python (`\s`/`\S` Unicode của `re`), ranh giới từ `\b` theo `\w` Unicode.
const WS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const B = '(?<![\\p{L}\\p{N}_])';
// URL/DSN (có thể chứa user:pass), DSN libpq key=value (password=...), khóa API sk-... / Bearer.
const SECRET_RE = new RegExp(
  `${B}[a-z][a-z0-9+.-]*://[^${WS}]+|${B}sk-[\\p{L}\\p{N}_-]{8,}|${B}bearer[${WS}]+[^${WS}]+|${B}pass(?:word)?[${WS}]*=[${WS}]*[^${WS}]+`,
  'giu',
);
const TRAIL_WS = new RegExp(`[${WS}]+$`, 'u');
const LEAD_WS = new RegExp(`^[${WS}]+`, 'u');
const LAST_WS_RUN = new RegExp(`[${WS}]+(?=[^${WS}]*$)`, 'u');

function warn(msg: string): void {
  console.log(`[job-runs] ${msg}`);
}

/** Python `(s.rsplit(None, 1) or [""])[0]`. */
function rsplitHead(s: string): string {
  const t = s.replace(TRAIL_WS, '');
  const m = LAST_WS_RUN.exec(t);
  if (!m || m.index === 0) return t.replace(LEAD_WS, '');
  return t.slice(0, m.index);
}

/**
 * Mask SĐT/email + che URL/DSN/khóa API + cắt 300 ký tự. Cắt PRE_MAX TRƯỚC regex (str(exception)
 * không giới hạn); mép cắt bỏ token dở + đuôi số/dấu (SĐT dở có khoảng).
 */
export function cleanDetail(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  let s = String(detail);
  if (Array.from(s).length > PRE_MAX) {
    s = rsplitHead(cpSlice(s, 0, PRE_MAX)).replace(/[0-9 .+\-()]+$/, '');
  }
  return cpSlice(dep('maskPii')(s.replace(SECRET_RE, '<secret>')), 0, DETAIL_MAX);
}

export type JobRunRow = {
  job: string;
  started: Date;
  finished: Date;
  ok: boolean;
  detail: string | null;
};

/** 1 dòng `job_runs` bằng login job lịch (JOB_DATABASE_URL, rơi về DATABASE_URL). Không ném. */
export async function recordJobRun(row: JobRunRow, env: Env = process.env): Promise<void> {
  const dsn = pyStrip(env.JOB_DATABASE_URL ?? '') || pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    warn('không có DATABASE_URL — bỏ ghi job_runs');
    return;
  }
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(dsn, { max: 1 }, env);
    await pool.query(INSERT, [row.job, row.started, row.finished, row.ok, row.detail, hostname()]);
  } catch (e) {
    warn(`ghi job_runs lỗi (${(e as Error).name}) — job vẫn chạy bình thường`);
  } finally {
    await pool?.end().catch(() => {});
  }
}

export type RunState = { ok: boolean; detail: string | null };

/**
 * Python `with job_run(job) as run:` — chạy `body`, ghi ĐÚNG 1 dòng khi kết thúc. Lỗi trong body →
 * ok=false, detail "<Tên lỗi>: <thông điệp>" (đã che), rồi NÉM LẠI nguyên lỗi.
 */
export async function jobRun<T>(
  job: string,
  body: (run: RunState) => Promise<T>,
  env: Env = process.env,
): Promise<T> {
  const run: RunState = { ok: true, detail: null };
  const started = new Date();
  try {
    return await body(run);
  } catch (e) {
    run.ok = false;
    run.detail = `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`;
    throw e;
  } finally {
    await recordJobRun(
      { job, started, finished: new Date(), ok: Boolean(run.ok), detail: cleanDetail(run.detail) },
      env,
    );
  }
}

// ---------------------------------------------------------------- lịch

export class JobConfigError extends Error {}
export type JobSpec = { on_calendar: string; max_gap_hours: number; steps: string[][] };

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Python job_runs: tệp của bước (`-m <module>` / `scripts/<file>.py`) có trong repo. */
export function pythonStepExists(step: string[]): boolean {
  const target = step[0] === '-m' ? `${(step[1] ?? '').replaceAll('.', '/')}.py` : (step[0] ?? '');
  return isFile(`${REPO_ROOT}/${target}`);
}

/**
 * Lịch đã kiểm: bước là `-m <module>` hoặc `scripts/<file>.py` và `stepOk(bước)` (mặc định: tệp
 * Python tồn tại; worker TS truyền "có lệnh TS tương ứng hoặc được phép chạy Python").
 */
export function loadJobs(
  path: string = JOBS_FILE,
  stepOk: (step: string[]) => boolean = pythonStepExists,
): Record<string, JobSpec> {
  let doc: unknown;
  try {
    doc = readJson(path);
  } catch (e) {
    const t = (e as JsonFileError).pyType;
    throw new JobConfigError(
      `${basename(path)} hỏng: ${t === 'FileNotFoundError' ? 'FileNotFoundError' : t}`,
    );
  }
  if (!isPlainObject(doc)) throw new JobConfigError(`${basename(path)} hỏng: AttributeError`);
  const jobs = doc.jobs;
  if (!isPlainObject(jobs) || Object.keys(jobs).length === 0) {
    throw new JobConfigError(`${basename(path)}: thiếu 'jobs'`);
  }
  const out: Record<string, JobSpec> = {};
  for (const [name, j] of Object.entries(jobs)) {
    if (!NAME_RE.test(name) || !isPlainObject(j)) {
      throw new JobConfigError(`job '${name}': tên/cấu trúc sai`);
    }
    const steps = j.steps;
    const gap = j.max_gap_hours;
    if (
      !Array.isArray(steps) ||
      steps.length === 0 ||
      !steps.every((s) => Array.isArray(s) && s.length > 0 && s.every((a) => typeof a === 'string'))
    ) {
      throw new JobConfigError(`job '${name}': steps phải là list argv`);
    }
    if (!isInt(gap) || gap < 1) throw new JobConfigError(`job '${name}': max_gap_hours phải ≥ 1`);
    if (typeof j.on_calendar !== 'string' || !j.on_calendar) {
      throw new JobConfigError(`job '${name}': thiếu on_calendar`);
    }
    for (const s of steps as string[][]) {
      const head = s[0] as string; // đã kiểm: list argv không rỗng
      if (head !== '-m' && (!head.startsWith('scripts/') || head.includes('..'))) {
        throw new JobConfigError(`job '${name}': script phải ở scripts/`);
      }
      if (!stepOk(s)) {
        const target = head === '-m' ? `${(s[1] ?? '').replaceAll('.', '/')}.py` : head;
        throw new JobConfigError(`job '${name}': không có ${basename(target)}`);
      }
    }
    out[name] = { on_calendar: j.on_calendar, max_gap_hours: gap, steps: steps as string[][] };
  }
  return out;
}

/** `--list`: 1 dòng/job như Python. */
export function listLines(jobs: Record<string, JobSpec>): string[] {
  return Object.entries(jobs).map(
    ([n, j]) =>
      `${n}: ${j.on_calendar} (hạn ${j.max_gap_hours}h) ${j.steps.map((s) => s.join(' ')).join(' ; ')}`,
  );
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const CAL_RE =
  /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\*-\*-(\*|\d{2}) (\*|\d{2}):(\d{2})(?:\/(\d{1,2}))?:00$/;

/**
 * systemd OnCalendar (đúng các dạng `deploy/onprem/jobs.json` dùng) → cron 6 trường của BullMQ
 * (giây phút giờ ngày tháng thứ). Dạng khác → JobConfigError (không đoán lịch).
 */
export function onCalendarToCron(cal: string): string {
  const m = CAL_RE.exec(cal);
  if (!m) throw new JobConfigError(`on_calendar '${cal}' chưa hỗ trợ (chỉ dạng của jobs.json)`);
  const [, dow, dom, hour, min, step] = m as unknown as (string | undefined)[] as [
    string,
    string | undefined,
    string,
    string,
    string,
    string | undefined,
  ];
  const mi = Number(min);
  if (
    mi > 59 ||
    (hour !== '*' && Number(hour) > 23) ||
    (dom !== '*' && !(+dom >= 1 && +dom <= 31))
  ) {
    throw new JobConfigError(`on_calendar '${cal}' sai giá trị`);
  }
  let minutes = String(mi);
  if (step !== undefined) {
    const st = Number(step);
    if (!(st >= 1 && st <= 59)) throw new JobConfigError(`on_calendar '${cal}' sai bước phút`);
    const xs: number[] = [];
    for (let x = mi; x < 60; x += st) xs.push(x);
    minutes = xs.join(',');
  }
  const h = hour === '*' ? '*' : String(Number(hour));
  const d = dom === '*' ? '*' : String(Number(dom));
  return `0 ${minutes} ${h} ${d} * ${dow ? DOW[dow] : '*'}`;
}

// systemd timer chạy theo giờ máy chủ (VN); BullMQ tính theo tz tường minh.
export const SCHEDULE_TZ = 'Asia/Ho_Chi_Minh';

/** Đăng ký mọi job của lịch thành job scheduler BullMQ (idempotent: upsert theo tên). */
export async function registerJobSchedulers(
  queue: Pick<Queue, 'upsertJobScheduler'>,
  jobs: Record<string, JobSpec> = loadJobs(),
): Promise<string[]> {
  const patterns = Object.entries(jobs).map(
    ([n, j]) => [n, onCalendarToCron(j.on_calendar)] as const,
  );
  for (const [name, pattern] of patterns) {
    await queue.upsertJobScheduler(name, { pattern, tz: SCHEDULE_TZ }, { name, data: {} });
  }
  return patterns.map(([n]) => n);
}

export type StepRunner = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number; env: Env },
) => Promise<number>;

/** Bước = tiến trình con `bin(env) ...prefix ...argv` như subprocess.run (hết giờ → kill, 124). */
export const commandRunner =
  (bin: (env: Env) => string, prefix: string[] = []): StepRunner =>
  (argv, { cwd, timeoutMs, env }) =>
    new Promise((resolve) => {
      const p = spawn(bin(env), [...prefix, ...argv], {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: 'inherit',
      });
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        p.kill('SIGKILL');
      }, timeoutMs);
      p.on('error', () => {
        clearTimeout(t);
        resolve(127);
      });
      p.on('close', (code) => {
        clearTimeout(t);
        resolve(timedOut ? 124 : (code ?? 1));
      });
    });

/** Mặc định: chạy bước Python (`python -m …` / `python scripts/….py`). */
export const pythonRunner: StepRunner = commandRunner((env) => env.PYTHON || 'python');

/** Pool của sổ job (JOB_DATABASE_URL → DATABASE_URL) cho khóa advisory. */
function lockPool(env: Env): pg.Pool | null {
  const dsn = pyStrip(env.JOB_DATABASE_URL ?? '') || pyStrip(env.DATABASE_URL ?? '');
  return dsn ? createPool(dsn, { max: 1 }, env) : null;
}

/**
 * Khóa độc quyền KHÔNG chờ theo tên job: khóa advisory phiên (2 khóa int — không trùng không gian
 * khóa 1 bigint mà schema/agent khác dùng). → client giữ khóa | null (đang bị giữ).
 */
export async function tryJobLock(pool: pg.Pool, name: string): Promise<pg.PoolClient | null> {
  const c = await pool.connect();
  try {
    const r = await c.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtext('samsam:job'), hashtext($1)) as ok",
      [name],
    );
    if (r.rows[0]?.ok === true) return c;
  } catch (e) {
    c.release();
    throw e;
  }
  c.release();
  return null;
}

export async function releaseJobLock(c: pg.PoolClient, name: string): Promise<void> {
  try {
    await c.query("select pg_advisory_unlock(hashtext('samsam:job'), hashtext($1))", [name]);
  } finally {
    c.release();
  }
}

/** Chạy 1 job lịch có khóa + ghi `job_runs` (`job:<tên>`) → exit code (mã lỗi đầu tiên ≠ 0). */
export async function runScheduled(
  name: string,
  opts: { jobs?: Record<string, JobSpec>; runner?: StepRunner; env?: Env } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const jobs = opts.jobs ?? loadJobs();
  const spec = jobs[name];
  if (!spec) throw new JobConfigError(`không có job '${name}' trong lịch`);
  const runner = opts.runner ?? pythonRunner;
  const childEnv: Env = { ...env };
  const svc = name in JOB_SERVICE ? JOB_SERVICE[name] : 'job';
  if (svc) {
    // Job chạy bằng login dịch vụ riêng — tiến trình con kế thừa DATABASE_URL; chế độ thực từ chối
    // login superuser/owner/sai role (không chạy bước nào, exit 78). Như `auth.bind_service`.
    const dsn = pyStrip(env[SERVICES[svc].envVar] ?? '');
    if (dsn) childEnv.DATABASE_URL = dsn;
    if (approvalEnforced(env)) {
      try {
        await (await servicePool(svc, env)).end();
      } catch (e) {
        if (!(e instanceof ServiceBindError)) throw e;
        warn(`job '${name}' KHÔNG chạy — ${e.message}`);
        return EXIT_SERVICE;
      }
    }
  }
  const pool = lockPool(env);
  let lock: pg.PoolClient | null = null;
  try {
    try {
      lock = pool ? await tryJobLock(pool, name) : null;
    } catch (e) {
      warn(
        `job '${name}' KHÔNG chạy — không giữ được khóa chống chạy chồng (${(e as Error).name})`,
      );
      return EXIT_LOCKED;
    }
    if (pool === null) {
      warn(
        `job '${name}' KHÔNG chạy — thiếu JOB_DATABASE_URL/DATABASE_URL cho khóa chống chạy chồng`,
      );
      return EXIT_LOCKED;
    }
    if (lock === null) {
      const now = new Date();
      await recordJobRun(
        {
          job: `job:${name}`,
          started: now,
          finished: now,
          ok: false,
          detail: 'chạy chồng — lần trước còn đang chạy, bỏ lượt',
        },
        env,
      );
      warn(`job '${name}' đang chạy ở tiến trình khác — bỏ lượt`);
      return EXIT_LOCKED;
    }
    let rcFirst = 0;
    const fails: string[] = [];
    await jobRun(
      `job:${name}`,
      async (jr) => {
        for (const [i, step] of spec.steps.entries()) {
          const rc = await runner(step, {
            cwd: REPO_ROOT,
            timeoutMs: STEP_TIMEOUT_MS,
            env: childEnv,
          });
          if (rc !== 0) {
            fails.push(`bước ${i + 1} exit ${rc}`);
            rcFirst = rcFirst || rc;
          }
        }
        jr.ok = fails.length === 0;
        jr.detail = fails.join('; ') || null;
      },
      env,
    );
    return rcFirst;
  } finally {
    if (lock) await releaseJobLock(lock, name).catch(() => {});
    await pool?.end().catch(() => {});
  }
}

/** Processor BullMQ: `new Worker(queue, processScheduledJob, …)` — exit ≠ 0 → job failed. */
export async function processScheduledJob(job: { name: string }): Promise<number> {
  const rc = await runScheduled(job.name);
  if (rc !== 0) throw new Error(`job '${job.name}' exit ${rc}`);
  return rc;
}
