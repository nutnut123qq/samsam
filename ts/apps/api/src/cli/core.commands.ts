import { connectDatabaseUrl, type DbLease } from '@samsam/core/db';
import { type ApprovalCliOpts, approvalQueueCli } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { directorCli } from '@samsam/core/ops/director';
import { JobConfigError, jobRun, listLines, runScheduled } from '@samsam/core/ops/job-runs';
import { status as loaderGateStatus } from '@samsam/core/ops/loader-gate';
import { pyInt } from '@samsam/core/ops/py';
import { isoDate } from '@samsam/core/ops/py-date';
import { DEFAULT_DAYS, generate, REPORTS_DIR, toplineLines } from '@samsam/core/ops/report';
import { type StoreCliOpts, storeCli } from '@samsam/core/ops/store';
import { DATA_DIR } from '@samsam/core/paths';
import { type AcceptanceCliOpts, acceptanceCli } from '@samsam/core/rollout/acceptance';
import { cliEntry, type RolloutCliOpts, rolloutCli } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import { jobStepRunner, loadWorkerJobs } from '../jobs.js';
import { collectChat } from '../modules/ceo_report/cockpit.js';
import { collect as collectMarketing } from '../modules/ceo_report/mkt-metrics.js';

// Lệnh CLI mỏng cho các hàm CLI của core (thay `python -m pipelines.rollout|approval_queue|director|
// store|acceptance|loader_gate|job_runs` và `agents.report`). Cờ đặt đúng argparse của Python; kiểm
// tham số ở run() (lỗi ném trong hàm parse của nest-commander thoát 0). Kết nối = DATABASE_URL như
// Python `lead_store.connect()`.

/** Lỗi tham số kiểu argparse → exit 2. */
function usage(m: string): void {
  console.error(`[err] ${m}`);
  process.exitCode = 2;
}

/** `fn(open)` với kết nối DATABASE_URL mở lười (open → Db | null), đóng khi xong. */
async function withDb(fn: (open: () => Promise<Db | null>) => Promise<number>): Promise<number> {
  let lease: DbLease | null = null;
  try {
    return await fn(async () => {
      lease ??= await connectDatabaseUrl();
      return lease?.db ?? null;
    });
  } finally {
    // storeCli/approvalQueueCli tự `end()` pool khi xong (như Python conn.close()).
    const l = lease as DbLease | null;
    if (l && !l.db.ending) await l.release();
  }
}

@Command({
  name: 'rollout',
  description:
    'Sổ triển khai + nghiệm thu (HĐ 6.7/PL02): --seed | --status | --promote ID | --severe ID --reason | ' +
    '--disable ID | --dossier --phase | --catalog | --outputs ID | --review-output ID --key --sha --decision',
})
export class RolloutCommand extends CommandRunner {
  async run(_a: string[], o: RolloutCliOpts): Promise<void> {
    process.exitCode = await rolloutCli(o, () => connectDatabaseUrl());
  }
  @Option({ flags: '--seed' })
  parseSeed(): boolean {
    return true;
  }
  @Option({ flags: '--status' })
  parseStatus(): boolean {
    return true;
  }
  @Option({ flags: '--promote <id>' })
  parsePromote(v: string): string {
    return v;
  }
  @Option({ flags: '--severe <id>' })
  parseSevere(v: string): string {
    return v;
  }
  @Option({ flags: '--disable <id>' })
  parseDisable(v: string): string {
    return v;
  }
  @Option({ flags: '--dossier' })
  parseDossier(): boolean {
    return true;
  }
  @Option({ flags: '--catalog' })
  parseCatalog(): boolean {
    return true;
  }
  @Option({ flags: '--outputs <id>' })
  parseOutputs(v: string): string {
    return v;
  }
  @Option({ flags: '--review-output <id>' })
  parseReviewOutput(v: string): string {
    return v;
  }
  @Option({ flags: '--key <key>' })
  parseKey(v: string): string {
    return v;
  }
  @Option({ flags: '--sha <sha>' })
  parseSha(v: string): string {
    return v;
  }
  @Option({ flags: '--decision <d>' })
  parseDecision(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--reason <code>' })
  parseReason(v: string): string {
    return v;
  }
  @Option({ flags: '--note <text>' })
  parseNote(v: string): string {
    return v;
  }
  @Option({ flags: '--phase <p>' })
  parsePhase(v: string): string {
    return v;
  }
  @Option({ flags: '--out <file>' })
  parseOut(v: string): string {
    return v;
  }
}

@Command({
  name: 'acceptance',
  description: 'Ma trận nghiệm thu: --matrix [--out F] [--db] | --summary',
})
export class AcceptanceCommand extends CommandRunner {
  async run(_a: string[], o: AcceptanceCliOpts): Promise<void> {
    process.exitCode = await acceptanceCli(o, () => connectDatabaseUrl());
  }
  @Option({ flags: '--matrix' })
  parseMatrix(): boolean {
    return true;
  }
  @Option({ flags: '--summary' })
  parseSummary(): boolean {
    return true;
  }
  @Option({ flags: '--out <file>' })
  parseOut(v: string): string {
    return v;
  }
  @Option({ flags: '--db', description: 'đọc DB (chỉ đọc) để kiểm login/người duyệt' })
  parseDb(): boolean {
    return true;
  }
}

@Command({
  name: 'approval-queue',
  description:
    'Hàng duyệt chung: --pending [--block K] | --approve/--reject ID --by | --override-qa ID --by --reason | --expire',
})
export class ApprovalQueueCommand extends CommandRunner {
  async run(_a: string[], o: ApprovalCliOpts): Promise<void> {
    process.exitCode = await withDb((open) => approvalQueueCli(o, open));
  }
  @Option({ flags: '--pending' })
  parsePending(): boolean {
    return true;
  }
  @Option({ flags: '--block <k>' })
  parseBlock(v: string): string {
    return v;
  }
  @Option({ flags: '--approve <id>' })
  parseApprove(v: string): string {
    return v;
  }
  @Option({ flags: '--reject <id>' })
  parseReject(v: string): string {
    return v;
  }
  @Option({ flags: '--override-qa <id>' })
  parseOverrideQa(v: string): string {
    return v;
  }
  @Option({ flags: '--expire' })
  parseExpire(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--note <text>' })
  parseNote(v: string): string {
    return v;
  }
  @Option({ flags: '--reason <text>' })
  parseReason(v: string): string {
    return v;
  }
}

@Command({ name: 'director', description: 'Bản tin GĐ khối: --block K | --all [--dry-run]' })
export class DirectorCommand extends CommandRunner {
  async run(_a: string[], o: { block?: string; all?: boolean; dryRun?: boolean }): Promise<void> {
    process.exitCode = await withDb((open) => directorCli(o, open));
  }
  @Option({ flags: '--block <k>' })
  parseBlock(v: string): string {
    return v;
  }
  @Option({ flags: '--all' })
  parseAll(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

type StoreArgs = Omit<StoreCliOpts, 'days' | 'schedule'> & { days?: string; schedule?: string[] };

@Command({
  name: 'store',
  description:
    'Hàng duyệt nháp nội dung: --pending | --calendar [--days N] | --approve/--reject ID --by | ' +
    '--schedule ID YYYY-MM-DD --by | --verify-log',
})
export class StoreCommand extends CommandRunner {
  async run(_a: string[], o: StoreArgs): Promise<void> {
    for (const k of ['approve', 'reject', 'days'] as const) {
      if (o[k] !== undefined && pyInt(o[k]) === null) {
        return usage(`argument --${k}: invalid int value: '${o[k]}'`);
      }
    }
    if (o.schedule !== undefined && o.schedule.length !== 2) {
      return usage('argument --schedule: expected 2 arguments');
    }
    const days = o.days === undefined ? undefined : Number(pyInt(o.days));
    const schedule = o.schedule as [string, string] | undefined;
    process.exitCode = await withDb((open) => storeCli({ ...o, days, schedule }, open));
  }
  @Option({ flags: '--pending' })
  parsePending(): boolean {
    return true;
  }
  @Option({ flags: '--approve <id>' })
  parseApprove(v: string): string {
    return v;
  }
  @Option({ flags: '--reject <id>' })
  parseReject(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--note <text>' })
  parseNote(v: string): string {
    return v;
  }
  @Option({ flags: '--schedule <id_date...>' })
  parseSchedule(v: string, prev: string[] = []): string[] {
    return [...prev, v];
  }
  @Option({ flags: '--calendar' })
  parseCalendar(): boolean {
    return true;
  }
  @Option({ flags: '--days <n>' })
  parseDays(v: string): string {
    return v;
  }
  @Option({ flags: '--verify-log', description: 'kiểm hash chain agent_action_log' })
  parseVerifyLog(): boolean {
    return true;
  }
}

@Command({ name: 'loader-gate', description: 'Chính sách cổng tắt loader: --status' })
export class LoaderGateCommand extends CommandRunner {
  async run(_a: string[], o: { status?: boolean }): Promise<void> {
    if (!o.status) return usage('the following arguments are required: --status');
    process.exitCode = await withDb(async (open) => {
      const [lines, rc] = await loaderGateStatus(await open());
      for (const l of lines) console.log(l);
      return rc;
    });
  }
  @Option({ flags: '--status' })
  parseStatus(): boolean {
    return true;
  }
}

@Command({
  name: 'job-runs',
  description: 'Chạy job lịch có khóa + ghi job_runs: --run TEN | --list',
})
export class JobRunsCommand extends CommandRunner {
  async run(_a: string[], o: { run?: string; list?: boolean }): Promise<void> {
    if ((o.run === undefined) === !o.list) {
      return usage('one of the arguments --run --list is required (chỉ 1)');
    }
    try {
      const jobs = loadWorkerJobs();
      if (o.list) {
        for (const l of listLines(jobs)) console.log(l);
        process.exitCode = 0;
        return;
      }
      process.exitCode = await runScheduled(o.run as string, { jobs, runner: jobStepRunner() });
    } catch (e) {
      if (!(e instanceof JobConfigError)) throw e;
      console.log(`[err] lịch job: ${e.message}`);
      process.exitCode = 2;
    }
  }
  @Option({ flags: '--run <ten>' })
  parseRun(v: string): string {
    return v;
  }
  @Option({ flags: '--list' })
  parseList(): boolean {
    return true;
  }
}

@Command({
  name: 'report',
  description: 'Báo cáo định kỳ → data/reports/report-*.md (BẢN NHÁP — không tự gửi)',
})
export class ReportCommand extends CommandRunner {
  async run(_a: string[], o: { days?: string; until?: string; outDir?: string }): Promise<void> {
    const n = o.days === undefined ? DEFAULT_DAYS : pyInt(o.days);
    if (n === null) return usage(`argument --days: invalid int value: '${o.days}'`);
    const days = Number(n);
    if (!(days >= 1 && days <= 3660)) {
      return usage('--days phải trong 1..3660 (quá lớn OverflowError trong period_bounds)');
    }
    const until = o.until ? isoDate(o.until) : null;
    if (o.until && until === null) return usage('--until sai định dạng YYYY-MM-DD');
    // KHÁC Python có chủ đích: tính năng TẮT → `[rollout] …` exit 2 (Python lọt traceback exit 1).
    const main = cliEntry(() =>
      withDb(async (open) => {
        const [path, rep] = await generate({
          days,
          until,
          outDir: o.outDir ?? REPORTS_DIR,
          db: await open(),
          collectors: { chat: (s, e) => collectChat(DATA_DIR, s, e), marketing: collectMarketing },
        });
        for (const l of toplineLines(path, rep)) console.log(l);
        return 0;
      }),
    );
    process.exitCode = await jobRun('agents.report', async (jr) => {
      const rc = await main();
      jr.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--days <n>' })
  parseDays(v: string): string {
    return v;
  }
  @Option({ flags: '--until <date>' })
  parseUntil(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

export const CORE_COMMANDS = [
  RolloutCommand,
  AcceptanceCommand,
  ApprovalQueueCommand,
  DirectorCommand,
  StoreCommand,
  LoaderGateCommand,
  JobRunsCommand,
  ReportCommand,
];
