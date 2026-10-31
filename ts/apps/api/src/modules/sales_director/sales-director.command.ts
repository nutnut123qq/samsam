import { type Service, ServiceBindError, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { DIRECTORS_DIR, DirectorConfigError } from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { DATA_DIR } from '@samsam/core/paths';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool, PoolClient } from 'pg';
import { type ForecastOpts, kdForecastMain } from './kd-forecast.js';
import { bulletinName, gather, renderBulletin } from './sales-director.bulletin.js';
import {
  JOB,
  loadSalesConfig,
  PERIODS,
  type PlanResult,
  type RunResult,
  run,
  type SalesConfig,
  type SweepDeps,
} from './sales-director.service.js';

// Lệnh CLI thay `python -m agents.sales_director` (+ `python -m agents.kd_forecast`) — cùng cờ,
// exit code, thông điệp chính. Exit: 0 ok · 1 cấu hình lỗi · 2 DB down / lỗi DB / tham số sai.
// Không dry-run → ghi 1 dòng `job_runs` (bản tin sức khỏe F17.2, mục "Job 24h").

export type SdOpts = {
  run?: boolean;
  bulletin?: boolean;
  dryRun?: boolean;
  period?: string;
  outDir?: string;
  now?: string;
};
export type SdDeps = SweepDeps & {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  dataDir?: string;
  directorsDir?: string;
  watchPath?: string;
  clock?: () => Date;
  /** Pool của job (mặc định login dịch vụ `job` — dev rơi về DATABASE_URL). */
  open?: (env: Env) => Promise<Pool>;
  /** Nối core trên pool của lệnh (mặc định `wireCore`) — test bỏ qua. */
  wire?: ((pool: Pool) => void) | null;
  jobRun?: typeof jobRun;
};

const ISO_RE =
  /^(\d{4})(?:-(\d{2})-(\d{2})|(\d{2})(\d{2}))(?:[Tt ](\d{2})(?::?(\d{2})(?::?(\d{2}))?(?:[.,](\d+))?)?(Z|[+-](\d{2})(?::?(\d{2})(?::?(\d{2}))?)?)?)?$/;

/** `datetime.fromisoformat` (đủ cho `--now`) → Date | 'naive' | null (sai định dạng).
 * shortcut: không nhận ngày dạng tuần ISO / dấu tách khác T/space (Python 3.11+ nhận) — chặt hơn,
 * `--now` chỉ là đồng hồ giả cho dry-run. */
export function parseIsoNow(s: string): Date | 'naive' | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined ? 0 : Number(x));
  const [y, mo, d] = [n(m[1]), n(m[2] ?? m[4]), n(m[3] ?? m[5])];
  const [h, mi, sec] = [n(m[6]), n(m[7]), n(m[8])];
  const ms = Math.floor(n((m[9] ?? '').slice(0, 6).padEnd(6, '0')) / 1000);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (y < 1 || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  t.setUTCHours(h, mi, sec, ms);
  const tz = m[10];
  if (tz === undefined) return 'naive';
  if (tz === 'Z') return t;
  const [oh, om, os] = [n(m[11]), n(m[12]), n(m[13])];
  if (oh > 23 || om > 59 || os > 59) return null;
  const off = (tz.startsWith('-') ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
  return new Date(t.getTime() - off);
}

export function printRun(res: PlanResult | RunResult, log: (s: string) => void): void {
  if (res.dry_run) {
    const enq =
      Object.entries(res.enqueue)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || '0';
    log(
      `[dry-run] sẽ đẩy: ${enq} · CSKH vượt trần chờ lần sau ${res.cskh_deferred} · nhắc lead chờ` +
        ` lần sau ${res.lead_deferred} · sẽ expire ${res.expire} · sẽ leo thang ${res.escalate}` +
        ` (cảnh báo đỏ ${res.red_alerts}) · lead quá hạn nhắc ${res.stale_leads} — KHÔNG ghi DB`,
    );
    return;
  }
  log(
    `[run] đẩy ${res.enqueued} mục mới (CSKH vượt trần chờ lần sau ${res.cskh_deferred}, nhắc lead` +
      ` chờ lần sau ${res.lead_deferred}) · expired ${res.expired} · leo thang ${res.escalated}` +
      ` (cảnh báo đỏ ${res.red_alerts}) · lead quá hạn nhắc ${res.stale_leads}` +
      (res.errors ? ` · LỖI leo thang ${res.errors}` : ''),
  );
}

async function inner(o: SdOpts, now: Date | null, d: SdDeps): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  let cfg: SalesConfig;
  try {
    cfg = loadSalesConfig(d.directorsDir ?? DIRECTORS_DIR, d.watchPath);
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    err(`[error] cấu hình lỗi: ${e.message}`);
    return 1;
  }
  let pool: Pool | null = null;
  let c: PoolClient;
  try {
    pool = await (d.open ?? ((e: Env) => servicePool('job' as Service, e)))(env);
    c = await pool.connect();
  } catch (e) {
    await pool?.end().catch(() => {});
    err(
      e instanceof ServiceBindError
        ? `[error] ${e.message}`
        : '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)',
    );
    return 2;
  }
  if (d.wire !== null) (d.wire ?? wireCore)(pool);
  let rc = 0;
  try {
    const t = now ?? (d.clock ?? (() => new Date()))();
    const dataDir = d.dataDir ?? DATA_DIR;
    const period = o.period ?? 'day';
    if (o.run) {
      const res = await run(c, t, cfg, dataDir, Boolean(o.dryRun), d);
      printRun(res, log);
      rc = !res.dry_run && res.errors ? 2 : 0;
    }
    if (o.bulletin) {
      const data = await gather(c, t, cfg, period, dataDir);
      const text = renderBulletin(cfg, data, t, period);
      if (o.dryRun) log(text);
      else {
        // P8.4: hàng duyệt/lead/cảnh báo sàn thật (bản tin không có đường dữ liệu mẫu riêng).
        const path = await writeReport(
          text,
          o.outDir ?? REPORTS_DIR,
          bulletinName(period, data.start),
          false,
        );
        const nOver = data.queue.filter((q) => q.state === 'overdue').length;
        log(
          `[bulletin] ${path} · hàng chờ ${data.queue.length} (quá hạn ${nOver}) · lead mới ${data.n_leads}`,
        );
      }
    }
  } catch (e) {
    if (isDbError(e)) {
      err(`[error] lỗi DB: ${dbMsg(e)}`);
      return 2;
    }
    // Python: RolloutBlocked (tính năng TẮT ở biên enqueue) không được bắt → dừng, exit 1.
    if (e instanceof RolloutBlocked) {
      err(`[error] ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    c.release();
    await pool.end().catch(() => {});
  }
  return rc;
}

/** `sales-director --run [--dry-run] [--bulletin] [--period day|week] [--out-dir D] [--now ISO]`. */
export async function salesDirectorMain(o: SdOpts, d: SdDeps = {}): Promise<number> {
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  if (o.period !== undefined && !PERIODS.includes(o.period)) {
    return usage(`argument --period: invalid choice: '${o.period}' (choose from 'day', 'week')`);
  }
  if (!(o.run || o.bulletin)) return usage('cần --run và/hoặc --bulletin');
  if (o.dryRun && !o.run) return usage('--dry-run chỉ đi với --run');
  let now: Date | null = null;
  if (o.now !== undefined) {
    if (!o.dryRun) return usage('--now chỉ dùng với --dry-run (không ghi DB theo đồng hồ giả)');
    const t = parseIsoNow(o.now);
    if (t === null) return usage('--now phải là ISO 8601, vd 2026-10-12T09:00+07:00');
    if (t === 'naive') return usage('--now phải có múi giờ (vd +07:00)');
    now = t;
  }
  if (o.dryRun) return inner(o, now, d);
  return (d.jobRun ?? jobRun)(
    JOB,
    async (r) => {
      const rc = await inner(o, null, d);
      r.ok = rc === 0;
      return rc;
    },
    d.env ?? process.env,
  );
}

@Command({
  name: 'sales-director',
  description:
    'Agent GĐ Kinh doanh TMĐT — hàng duyệt + SLA handoff A/B + bản tin (BẢN NHÁP, không tự gửi)',
})
export class SalesDirectorCommand extends CommandRunner {
  async run(_args: string[], o: SdOpts): Promise<void> {
    process.exitCode = await salesDirectorMain(o);
  }

  @Option({ flags: '--run', description: 'đẩy việc từ nguồn thật + quét SLA/leo thang' })
  parseRun(): boolean {
    return true;
  }

  @Option({ flags: '--bulletin', description: 'bản tin GĐ KD → data/reports/' })
  parseBulletin(): boolean {
    return true;
  }

  @Option({ flags: '--dry-run', description: 'với --run: chỉ đọc, in kế hoạch; bản tin in stdout' })
  parseDryRun(): boolean {
    return true;
  }

  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({ flags: '--period <period>', description: 'day|week (mặc định day)' })
  parsePeriod(v: string): string {
    return v;
  }

  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }

  @Option({ flags: '--now <iso>', description: 'giờ giả ISO có múi giờ — chỉ với --dry-run' })
  parseNow(v: string): string {
    return v;
  }
}

@Command({
  name: 'kd-forecast',
  description:
    'KD-A10 dự báo mùa SKU × kênh (khoảng thấp–cơ sở–cao qua engine kịch bản chung) + đối chiếu tồn',
})
export class KdForecastCommand extends CommandRunner {
  async run(_args: string[], o: ForecastOpts): Promise<void> {
    process.exitCode = await kdForecastMain(o);
  }

  @Option({ flags: '--start <date>', description: 'mặc định thứ Hai tuần này (giờ VN)' })
  parseStart(v: string): string {
    return v;
  }

  @Option({ flags: '--weeks <n>' })
  parseWeeks(v: string): string {
    return v;
  }

  @Option({ flags: '--sku <sku>' })
  parseSku(v: string): string {
    return v;
  }

  @Option({ flags: '--write', description: 'ghi data/reports/kd-forecast-<start>.md' })
  parseWrite(): boolean {
    return true;
  }
}

export const SALES_DIRECTOR_COMMANDS = [SalesDirectorCommand, KdForecastCommand];
