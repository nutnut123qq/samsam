import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import G from './__fixtures__/job_runs.golden.json' with { type: 'json' };
import {
  cleanDetail,
  EXIT_LOCKED,
  EXIT_SERVICE,
  type JobSpec,
  jobRun,
  listLines,
  loadJobs,
  onCalendarToCron,
  recordJobRun,
  registerJobSchedulers,
  releaseJobLock,
  runScheduled,
  tryJobLock,
} from './job-runs.js';
import { installFakeDeps } from './testing.js';

describe('job-runs golden (Python)', () => {
  beforeEach(() => {
    installFakeDeps(); // maskPii giả = đồng nhất (golden sinh với _mask_pii đồng nhất)
  });

  it('cleanDetail: che URL/DSN/khóa API, cắt trước regex, bỏ token dở ở mép', () => {
    for (const c of G.clean)
      expect(cleanDetail(c.in), JSON.stringify(c.in)?.slice(0, 60)).toBe(c.out);
  });

  it('cleanDetail: chuỗi bệnh lý không treo', () => {
    const t0 = performance.now();
    cleanDetail(`${'a.'.repeat(40_000)}://x`);
    cleanDetail('('.repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('loadJobs: lỗi y hệt Python; lịch thật hợp lệ', () => {
    const d = mkdtempSync(join(tmpdir(), 'jobs-'));
    for (const c of G.jobs) {
      const p = join(d, `jobs_${c.name}.json`);
      if (c.body !== null) writeFileSync(p, Buffer.from(c.body, 'base64'));
      const want = c.out as { ok?: unknown; msg?: string };
      if (want.msg) expect(() => loadJobs(p), c.name).toThrow(want.msg);
      else expect(loadJobs(p)).toEqual(want.ok);
    }
    const jobs = loadJobs();
    expect(Object.keys(jobs)).toContain('red_alert_sweep');
    expect(
      listLines(jobs).some((l) => l.startsWith('red_alert_sweep: *-*-* *:05:00 (hạn 2h)')),
    ).toBe(true);
  });
});

describe('lịch BullMQ', () => {
  it('OnCalendar của jobs.json → cron 6 trường; dạng lạ → lỗi', () => {
    const cases: [string, string][] = [
      ['*-*-* 06:45:00', '0 45 6 * * *'],
      ['*-*-* *:05:00', '0 5 * * * *'],
      ['*-*-03 08:30:00', '0 30 8 3 * *'],
      ['Mon *-*-* 08:20:00', '0 20 8 * * 1'],
      ['Sun *-*-* 03:00:00', '0 0 3 * * 0'],
      ['*-*-* *:00/5:00', '0 0,5,10,15,20,25,30,35,40,45,50,55 * * * *'],
      ['*-*-* *:00/15:00', '0 0,15,30,45 * * * *'],
      ['*-*-* *:10/30:00', '0 10,40 * * * *'],
    ];
    for (const [cal, cron] of cases) expect(onCalendarToCron(cal), cal).toBe(cron);
    for (const bad of [
      'daily',
      '*-*-* 25:00:00',
      '*-*-* 06:61:00',
      'Mon..Fri *-*-* 08:00:00',
      '*-*-32 01:00:00',
    ]) {
      expect(() => onCalendarToCron(bad), bad).toThrow();
    }
  });

  it('registerJobSchedulers: mọi job của lịch thật → upsert theo tên, giờ VN', async () => {
    const calls: unknown[][] = [];
    const names = await registerJobSchedulers({
      upsertJobScheduler: (async (...a: unknown[]) => {
        calls.push(a);
      }) as never,
    });
    expect(names.length).toBe(Object.keys(loadJobs()).length);
    expect(calls[0]).toEqual([
      'intel',
      { pattern: '0 45 6 * * *', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'intel', data: {} },
    ]);
  });
});

const JOBS: Record<string, JobSpec> = {
  x: {
    on_calendar: '*-*-* 01:00:00',
    max_gap_hours: 1,
    steps: [
      ['-m', 'a'],
      ['-m', 'b'],
      ['-m', 'c'],
    ],
  },
};

describe('jobRun / recordJobRun không có DB', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('thiếu DSN / DSN chết → cảnh báo, job vẫn chạy, lỗi body được ném lại', async () => {
    expect(
      await jobRun(
        't',
        async (r) => {
          r.ok = true;
          return 7;
        },
        {},
      ),
    ).toBe(7);
    await recordJobRun(
      { job: 't', started: new Date(), finished: new Date(), ok: true, detail: null },
      { NODE_ENV: 'test', JOB_DATABASE_URL: 'postgresql://u@127.0.0.1:9/nope' },
    );
    await expect(
      jobRun(
        't',
        async () => {
          throw new Error('hỏng');
        },
        {},
      ),
    ).rejects.toThrow('hỏng');
  });

  it('runScheduled: job lạ → lỗi cấu hình; thiếu DSN khóa → không chạy bước nào', async () => {
    await expect(runScheduled('nope', { jobs: JOBS, env: {} })).rejects.toThrow(
      /không có job 'nope'/,
    );
    const seen: string[][] = [];
    const rc = await runScheduled('x', {
      jobs: JOBS,
      env: {},
      runner: async (a) => {
        seen.push(a);
        return 0;
      },
    });
    expect([rc, seen]).toEqual([EXIT_LOCKED, []]);
  });

  it('chế độ thực thiếu login dịch vụ → exit 78, không chạy bước nào', async () => {
    const seen: string[][] = [];
    const rc = await runScheduled('x', {
      jobs: JOBS,
      env: { AUTH_MODE: 'local', NODE_ENV: 'test' },
      runner: async (a) => {
        seen.push(a);
        return 0;
      },
    });
    expect([rc, seen]).toEqual([EXIT_SERVICE, []]);
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('job-runs (DB)', () => {
  const name = testDbName('ops_jobs');
  let pool: pg.Pool;
  let env: Record<string, string>;
  beforeAll(async () => {
    const url = await createDbFromTemplate(name);
    pool = createPool(url);
    env = { NODE_ENV: 'test', JOB_DATABASE_URL: url };
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(() => {
    installFakeDeps({ maskPii: (s) => s.replaceAll('0912345678', '<SĐT>') });
  });
  const last = async () =>
    (
      await pool.query(
        'select job, ok, detail, host, started_at <= finished_at as ordered from job_runs order by id desc limit 1',
      )
    ).rows[0];

  it('jobRun ghi ĐÚNG 1 dòng; lỗi → ok=false, detail đã che + ném lại', async () => {
    await jobRun(
      'agents.report',
      async (r) => {
        r.ok = true;
      },
      env,
    );
    expect(await last()).toMatchObject({
      job: 'agents.report',
      ok: true,
      detail: null,
      ordered: true,
    });
    await expect(
      jobRun(
        'agents.report',
        async () => {
          throw new Error('postgresql://u:pw@h/db gọi 0912345678');
        },
        env,
      ),
    ).rejects.toThrow();
    expect(await last()).toMatchObject({ ok: false, detail: 'Error: <secret> gọi <SĐT>' });
    await jobRun(
      'agents.report',
      async (r) => {
        r.ok = false;
        r.detail = 'bước 1 exit 2';
      },
      env,
    );
    expect(await last()).toMatchObject({ ok: false, detail: 'bước 1 exit 2' });
  });

  it('runScheduled: chạy HẾT các bước, exit = mã lỗi đầu tiên; detail liệt kê bước lỗi', async () => {
    const rcs = [0, 3, 4];
    const seen: string[][] = [];
    const rc = await runScheduled('x', {
      jobs: JOBS,
      env,
      runner: async (a, o) => {
        seen.push(a);
        // như bind_service: có JOB_DATABASE_URL → tiến trình con chạy bằng login job (so không in DSN)
        expect(o.env.DATABASE_URL === env.JOB_DATABASE_URL).toBe(true);
        return rcs.shift() as number;
      },
    });
    expect([rc, seen]).toEqual([
      3,
      [
        ['-m', 'a'],
        ['-m', 'b'],
        ['-m', 'c'],
      ],
    ]);
    expect(await last()).toMatchObject({
      job: 'job:x',
      ok: false,
      detail: 'bước 2 exit 3; bước 3 exit 4',
    });
  });

  it('khóa chống chạy chồng: đang giữ → 1 dòng "chạy chồng", exit 75, không chạy bước nào; nhả → chạy được', async () => {
    const holder = await tryJobLock(pool, 'x');
    expect(holder).not.toBeNull();
    const seen: string[][] = [];
    const runner = async (a: string[]) => {
      seen.push(a);
      return 0;
    };
    expect(await runScheduled('x', { jobs: JOBS, env, runner })).toBe(EXIT_LOCKED);
    expect(seen).toEqual([]);
    expect(await last()).toMatchObject({
      job: 'job:x',
      ok: false,
      detail: 'chạy chồng — lần trước còn đang chạy, bỏ lượt',
    });
    // job khác không bị khóa của 'x' chặn
    const other = await tryJobLock(pool, 'y');
    expect(other).not.toBeNull();
    await releaseJobLock(other as pg.PoolClient, 'y');
    await releaseJobLock(holder as pg.PoolClient, 'x');
    expect(await runScheduled('x', { jobs: JOBS, env, runner })).toBe(0);
    expect(seen.length).toBe(3);
    expect(await last()).toMatchObject({ job: 'job:x', ok: true });
  });

  it('khóa tự nhả khi kết nối giữ khóa chết (không khóa mồ côi)', async () => {
    const p2 = createPool(env.JOB_DATABASE_URL as string, { max: 1 });
    const h = await tryJobLock(p2, 'z');
    expect(h).not.toBeNull();
    expect(await tryJobLock(pool, 'z')).toBeNull();
    h?.release(true); // hủy kết nối
    await p2.end();
    // backend bị hủy thoát bất đồng bộ phía server → chờ theo điều kiện (tối đa ~5 s), không giả định tức thì
    let again: pg.PoolClient | null = null;
    for (let i = 0; i < 50 && !again; i++) {
      again = await tryJobLock(pool, 'z');
      if (!again) await new Promise((r) => setTimeout(r, 100));
    }
    expect(again).not.toBeNull();
    await releaseJobLock(again as pg.PoolClient, 'z');
  });
});
