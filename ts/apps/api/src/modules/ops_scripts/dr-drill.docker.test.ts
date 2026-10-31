import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { backupMain, findTool, MANIFEST_SUFFIX, snapshotCounts } from './backup.js';
import { io, spawnRun } from './common.js';
import { drDeps, drMain, PREFIX, probeDocker } from './dr-drill.js';

// Dịch tests/test_dr_drill.py (E2E docker thật): backup DB test → dr-drill dựng container
// `postgres:<major>-alpine` ĐÃ CÓ (không pull) → khôi phục + đếm khớp → container + volume bị dọn; manifest
// lệch → exit 1 và container VẪN bị dọn; mọi kết nối/pg_restore đi tới container, không tới server
// test. Tốn RAM (1 container Postgres tạm) → chỉ chạy khi TS_TEST_DR_DOCKER=1 + TS_TEST_ADMIN_URL.

const ENABLED = Boolean(process.env.TS_TEST_ADMIN_URL) && process.env.TS_TEST_DR_DOCKER === '1';
// DB test có pgvector (như compose) → container DR dùng cùng image pgvector ĐÃ CÓ (DR_IMAGE).
const IMAGE = process.env.TS_TEST_DR_IMAGE || 'pgvector/pgvector:0.8.6-pg17-trixie';

async function drNames(): Promise<string[]> {
  const r = await spawnRun(
    ['docker', 'ps', '-a', '--filter', `name=${PREFIX}`, '--format', '{{.Names}}'],
    {
      timeoutMs: 30_000,
    },
  );
  return r.stdout
    .toString()
    .split(/\s+/)
    .filter((n) => n.startsWith(PREFIX));
}

describe.skipIf(!ENABLED)(
  'dr-drill docker thật (TS_TEST_DR_DOCKER=1)',
  { timeout: 300_000 },
  () => {
    const name = testDbName('ops_dr');
    const root = mkdtempSync(join(tmpdir(), 'ops-drdk-'));
    let dsn = '';
    let pool: pg.Pool;
    let ready = '';
    let k = 0;

    beforeAll(async () => {
      dsn = await createDbFromTemplate(name);
      pool = createPool(dsn);
      const n = Number(
        (await pool.query("select current_setting('server_version_num')::int as n")).rows[0].n,
      );
      const major = Math.floor(n / 10000);
      if ((await findTool('pg_dump', major, process.env, () => {})) === null)
        ready = 'không có pg_dump';
      else ready = (await probeDocker(IMAGE)) ?? '';
    });
    afterAll(async () => {
      await pool?.end();
      await dropDb(name);
      rmSync(root, { recursive: true, force: true });
    });
    afterEach(() => vi.restoreAllMocks());

    async function backup(): Promise<{ bdir: string; env: Record<string, string | undefined> }> {
      const bdir = join(root, `bk${k++}`);
      const env: Record<string, string | undefined> = {};
      for (const [key, v] of Object.entries(process.env)) {
        if (!/^(BACKUP_|DRILL_|DR_|PG_BIN$|DATABASE_URL$)/.test(key)) env[key] = v;
      }
      Object.assign(env, { BACKUP_DIR: bdir, DATABASE_URL: dsn, DR_IMAGE: IMAGE });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await backupMain(env)).toBe(0);
      return { bdir, env };
    }

    /** Bắt cổng container + đích pg_restore để chứng minh khôi phục vào container, không vào server test. */
    function trace() {
      const t = { ports: [] as number[], restores: [] as string[] };
      const realPort = drDeps.hostPort;
      vi.spyOn(drDeps, 'hostPort').mockImplementation(async (n) => {
        const p = await realPort(n);
        t.ports.push(p);
        return p;
      });
      const realRun = io.run;
      vi.spyOn(io, 'run').mockImplementation(async (argv, opts) => {
        const e = opts.env ?? {};
        if (e.PGDATABASE) t.restores.push(`${e.PGHOST}:${e.PGPORT}/${e.PGDATABASE}`);
        return realRun(argv, opts);
      });
      return t;
    }

    const lastRec = (bdir: string) =>
      JSON.parse(readFileSync(join(bdir, 'dr_runs.jsonl'), 'utf8').split('\n').at(-2) as string);

    it('khớp mọi bảng, container + volume bị dọn, nhật ký không bí mật', async (ctx) => {
      if (ready) return ctx.skip();
      const { bdir, env } = await backup();
      const c = await pool.connect();
      const before = await snapshotCounts(c);
      c.release();
      const t = trace();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await drMain({}, undefined, env)).toBe(0);
      const out = log.mock.calls.map((x) => String(x[0])).join('\n');
      const n = Object.keys(before).length;
      expect(out).toContain(`${n}/${n} bảng khớp`);
      const rec = lastRec(bdir);
      expect(rec).toMatchObject({
        status: 'ok',
        container_removed: true,
        tables_checked: n,
        mismatches: {},
      });
      expect(rec.rto_seconds).toBeGreaterThanOrEqual(rec.restore_rto_seconds);
      expect(await drNames()).not.toContain(rec.container);
      const [port] = t.ports;
      expect(t.restores.length).toBeGreaterThan(0);
      for (const r of t.restores) expect(r.startsWith(`127.0.0.1:${port}/`)).toBe(true);
      expect(new URL(dsn).port).not.toBe(String(port));
      const body = readFileSync(join(bdir, 'dr_runs.jsonl'), 'utf8');
      expect(body).not.toContain('postgresql://');
      expect(body).not.toContain(new URL(dsn).password);
      const c2 = await pool.connect();
      expect(await snapshotCounts(c2)).toEqual(before);
      c2.release();
    });

    it('manifest lệch → exit 1 mismatch, container VẪN bị dọn', async (ctx) => {
      if (ready) return ctx.skip();
      const { bdir, env } = await backup();
      const { readdirSync } = await import('node:fs');
      const mp = join(bdir, readdirSync(bdir).find((f) => f.endsWith(MANIFEST_SUFFIX)) as string);
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      m.row_counts.products += 1;
      writeFileSync(mp, JSON.stringify(m));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await drMain({}, undefined, env)).toBe(1);
      const rec = lastRec(bdir);
      expect(rec).toMatchObject({ status: 'mismatch', container_removed: true });
      expect(Object.keys(rec.mismatches)).toEqual(['products']);
      expect(await drNames()).not.toContain(rec.container);
    });

    it('cuối file: 0 container samsam-dr-* còn lại', async (ctx) => {
      if (ready) return ctx.skip();
      expect(await drNames()).toEqual([]);
    });
  },
);
