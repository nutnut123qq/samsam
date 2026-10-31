import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOBS_FILE,
  type JobSpec,
  loadJobs,
  onCalendarToCron,
  type StepRunner,
} from '@samsam/core/ops/job-runs';
import { REPO_ROOT } from '@samsam/core/paths';
import type { Command } from 'commander';
import { CommandFactory, CommandRunnerService } from 'nest-commander';
import { describe, expect, it } from 'vitest';
import { CliModule } from './cli.module.js';
import {
  jobStepRunner,
  loadWorkerJobs,
  planStep,
  selectJobs,
  syncSchedulers,
  TS_STEPS,
} from './jobs.js';

// 34 job của deploy/onprem/jobs.json ↔ lịch BullMQ (cron 6 trường, giờ VN) ↔ bước TS. Đổi jobs.json
// → test đỏ cho tới khi bảng này (và lệnh TS tương ứng) được rà lại.
const EXPECTED: Record<string, [string, string[][]]> = {
  intel: [
    '0 45 6 * * *',
    [
      ['ts', 'crawler-intel', '--run'],
      ['ts', 'intel-bulletin', '--period', 'day', '--suggest'],
    ],
  ],
  red_alert_sweep: [
    '0 5 * * * *',
    [
      ['ts', 'crawler-intel', '--run'],
      ['ts', 'intel-alert', '--run'],
      ['ts', 'red-alert', '--deliver'],
    ],
  ],
  channel_scan: [
    '0 0 7 * * *',
    [
      ['ts', 'crawler-collect'],
      ['ts', 'ra-kenh', '--scan-auto'],
    ],
  ],
  hdtv_month: ['0 30 8 3 * *', [['ts', 'hdtv-report', '--month', 'prev', '--submit']]],
  vt_weather: ['0 30 6 * * *', [['ts', 'vt-thoitiet', '--digest', '--fetch', '--submit']]],
  vt_harvest: ['0 20 8 * * 1', [['ts', 'vt-thuhoach', '--submit']]],
  vt_pests: ['0 35 6 * * *', [['ts', 'vt-thoitiet', '--pests', '--submit']]],
  webhook_health: ['0 0,5,10,15,20,25,30,35,40,45,50,55 * * * *', [['ts', 'webhook-probe']]],
  red_alert_escalate: ['0 0,15,30,45 * * * *', [['ts', 'red-alert', '--escalate']]],
  anchor_build: ['0 30 2 * * *', [['ts', 'anchor', '--build']]],
  legal_updates: ['0 15 7 * * *', [['ts', 'legal-updates', '--submit']]],
  sales_sla: ['0 10,40 * * * *', [['ts', 'sales-director', '--run']]],
  b2b_followups: ['0 30 8 * * *', [['ts', 'kd-quote', '--followups']]],
  order_watch: ['0 40 8 * * *', [['ts', 'kd-orders', '--watch']]],
  dealer_price_watch: ['0 50 8 * * *', [['ts', 'kd-price', '--dealer-watch']]],
  ceo_promo: ['0 0 9 * * *', [['ts', 'ceo-promo']]],
  intel_keywords: ['0 45 7 * * 1', [['ts', 'intel-weekly', '--suggest-keywords']]],
  ceo_weekly: [
    '0 0 8 * * 1',
    [
      ['ts', 'cockpit', '--collect', '--period', 'week'],
      ['ts', 'ceo-report', '--period', 'week', '--submit'],
    ],
  ],
  invoice_batch: ['0 0 21 * * *', [['ts', 'acc-invoice', '--batch']]],
  content_daily: ['0 0 6 * * *', [['ts', 'content', '--daily']]],
  backup: ['0 30 1 * * *', [['ts', 'db-backup']]],
  // KE_HOACH mục 3: diễn tập khôi phục giữ Python.
  restore_drill: ['0 0 3 * * 0', [['python', 'scripts/db_restore_drill.py']]],
  dr_drill: ['0 0 4 1 * *', [['ts', 'dr-drill']]],
  kpi_snapshot: ['0 50 23 * * *', [['ts', 'ops-monthly', '--snapshot']]],
  health_bulletin: ['0 30 7 * * *', [['ts', 'health-bulletin']]],
  ops_monthly: ['0 0 8 1 * *', [['ts', 'ops-monthly', '--month', 'prev']]],
  garden_remind: ['0 5 7 * * *', [['ts', 'garden-director', '--remind', '--submit']]],
  intel_weekly: ['0 40 7 * * 1', [['ts', 'intel-weekly', '--out-dir', 'data/reports']]],
  listing_watch: ['0 20 8 * * *', [['ts', 'kd-listing', '--run']]],
  price_watch: ['0 25 8 * * *', [['ts', 'kd-price', '--run']]],
  ceo_audit: ['0 10 9 * * *', [['ts', 'ceo-audit', '--report']]],
  chain_watch: ['0 20 6 * * *', [['ts', 'bks-audit', '--chain-alert']]],
  production_week: [
    '0 10 8 * * 1',
    [['ts', 'production', 'bulletin', '--period', 'week', '--out-dir', 'data/reports']],
  ],
  production_month: [
    '0 15 8 1 * *',
    [['ts', 'production', 'bulletin', '--period', 'month', '--out-dir', 'data/reports']],
  ],
};

const plan = (s: string[]) => {
  const p = planStep(s);
  return p.kind === 'none' ? ['none', p.key] : [p.kind, ...p.argv];
};

describe('lịch worker ↔ deploy/onprem/jobs.json', () => {
  it('đủ 34 job: tên, giờ (cron VN), bước TS/Python', () => {
    const jobs = loadWorkerJobs();
    expect(Object.keys(jobs).length).toBe(34);
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(EXPECTED).sort());
    // Cùng lịch với bản Python job_runs (kiểm tệp Python tồn tại).
    expect(loadJobs(JOBS_FILE)).toEqual(jobs);
    for (const [name, j] of Object.entries(jobs)) {
      const [cron, steps] = EXPECTED[name] as [string, string[][]];
      expect(onCalendarToCron(j.on_calendar), name).toBe(cron);
      expect(j.steps.map(plan), name).toEqual(steps);
    }
  });

  it('mọi bước TS có lệnh đã đăng ký ở CliModule và mọi cờ được lệnh đó nhận', async () => {
    const app = await CommandFactory.createWithoutRunning(CliModule, { logger: false });
    try {
      const root = (app.get(CommandRunnerService) as unknown as { commander: Command }).commander;
      const byName = new Map(root.commands.map((c) => [c.name(), c]));
      for (const cmd of Object.values(TS_STEPS)) expect(byName.has(cmd), cmd).toBe(true);
      for (const [name, j] of Object.entries(loadWorkerJobs())) {
        for (const s of j.steps) {
          const p = planStep(s);
          if (p.kind !== 'ts') continue;
          const [cmd, ...args] = p.argv as [string, ...string[]];
          const c = byName.get(cmd) as Command;
          // parseOptions: tách cờ khai báo / toán hạng / cờ lạ — không gọi run().
          const { unknown } = c.parseOptions(args);
          const tolerated = (c as unknown as { _allowUnknownOption: boolean })._allowUnknownOption;
          expect(tolerated ? [] : unknown, `${name}: ${p.argv.join(' ')}`).toEqual([]);
        }
      }
    } finally {
      await app.close();
    }
  });

  it('bước lạ (không TS, không được phép Python) → lịch hỏng; bước Python không cần tệp trong image', () => {
    const d = mkdtempSync(join(tmpdir(), 'wjobs-'));
    const write = (steps: string[][]) => {
      const p = join(d, `${Math.random()}.json`);
      writeFileSync(
        p,
        JSON.stringify({ jobs: { x: { on_calendar: '*-*-* 01:00:00', max_gap_hours: 1, steps } } }),
      );
      return p;
    };
    expect(() => loadWorkerJobs(write([['-m', 'agents.khong_co']]))).toThrow(
      "job 'x': không có khong_co.py",
    );
    expect(() => loadWorkerJobs(write([['scripts/../x.py']]))).toThrow('script phải ở scripts/');
    expect(Object.keys(loadWorkerJobs(write([['-m', 'agents.kd_price', '--run']])))).toEqual(['x']);
    // Mặc định core (job_runs Python): kiểm tệp Python thật.
    expect(() => loadJobs(write([['-m', 'agents.khong_co']]))).toThrow('không có khong_co.py');
    expect(loadJobs(write([['-m', 'agents.khong_co']]), () => true).x?.steps).toEqual([
      ['-m', 'agents.khong_co'],
    ]);
  });

  it('runner: TS → lệnh CLI cùng cờ, Python → argv nguyên vẹn, lạ → 127 không chạy gì', async () => {
    const calls: [string, string[]][] = [];
    const fake =
      (kind: string, rc: number): StepRunner =>
      async (argv) => {
        calls.push([kind, argv]);
        return rc;
      };
    const run = jobStepRunner(fake('ts', 3), fake('py', 0));
    const o = { cwd: REPO_ROOT, timeoutMs: 1000, env: {} };
    expect(await run(['-m', 'pipelines.production', 'bulletin', '--period', 'week'], o)).toBe(3);
    expect(await run(['scripts/db_restore_drill.py'], o)).toBe(0);
    expect(await run(['-m', 'agents.khong_co'], o)).toBe(127);
    expect(calls).toEqual([
      ['ts', ['production', 'bulletin', '--period', 'week']],
      ['py', ['scripts/db_restore_drill.py']],
    ]);
  });

  it('runner thật: tiến trình con tsx từ gốc repo (cwd = Python) — cờ lạ → exit 2 như argparse', {
    timeout: 180_000,
  }, async () => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const rc = await jobStepRunner()(['scripts/db_backup.py', '--khong-co'], {
      cwd: REPO_ROOT,
      timeoutMs: 170_000,
      env,
    });
    expect(rc).toBe(2);
  });
});

describe('WORKER_JOBS + đồng bộ scheduler', () => {
  const J = (n: string): JobSpec => ({ on_calendar: n, max_gap_hours: 1, steps: [['-m', 'a']] });
  const jobs = { a: J('*-*-* 01:00:00'), b: J('Mon *-*-* 02:30:00') };

  it('trống → lỗi (worker exit 78, KHÔNG cả lịch); danh sách = đúng các job đó; tên lạ → lỗi', () => {
    for (const raw of [undefined, '', ' ', ' , ']) {
      expect(() => selectJobs(jobs, raw), String(raw)).toThrow('WORKER_JOBS trống');
    }
    expect(Object.keys(selectJobs(jobs, 'b, a'))).toEqual(['b', 'a']);
    expect(() => selectJobs(jobs, 'a,zz')).toThrow('WORKER_JOBS có job lạ: zz');
    expect(() => selectJobs(jobs, 'all,a')).toThrow('WORKER_JOBS có job lạ: all');
  });

  it('`all` = cả lịch thật trừ restore_drill/dr_drill (cần Python/docker); liệt kê tường minh vẫn được', () => {
    const real = loadWorkerJobs();
    const all = selectJobs(real, 'all');
    expect(Object.keys(all).sort()).toEqual(
      Object.keys(real)
        .filter((n) => n !== 'restore_drill' && n !== 'dr_drill')
        .sort(),
    );
    expect(Object.keys(all).length).toBe(Object.keys(real).length - 2);
    expect(Object.keys(selectJobs(real, 'dr_drill'))).toEqual(['dr_drill']);
  });

  it('gỡ scheduler tồn từ lần trước không còn bật, upsert phần bật (giờ VN)', async () => {
    const log: unknown[][] = [];
    const queue = {
      getJobSchedulers: async () => [{ key: 'a' }, { key: 'cu' }],
      removeJobScheduler: async (k: string) => {
        log.push(['remove', k]);
        return true;
      },
      upsertJobScheduler: async (...a: unknown[]) => {
        log.push(['upsert', ...a]);
      },
    };
    expect(await syncSchedulers(queue as never, { a: jobs.a as JobSpec })).toEqual(['a']);
    expect(log).toEqual([
      ['remove', 'cu'],
      ['upsert', 'a', { pattern: '0 0 1 * * *', tz: 'Asia/Ho_Chi_Minh' }, { name: 'a', data: {} }],
    ]);
  });
});
