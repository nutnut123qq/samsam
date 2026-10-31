import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { privilegedLogin, servicePool } from '../db.js';
import { adminQuery, checkTestDbName, createDbFromTemplate, dropDb, testDbName } from './db.js';

describe('tên DB test', () => {
  it('từ chối samsam / DB mẫu / DB hệ thống / tên lạ', () => {
    for (const n of [
      'samsam',
      'SAMSAM',
      'samsam_ts_tpl',
      'postgres',
      'template1',
      'a-b',
      'x;drop',
    ]) {
      expect(() => checkTestDbName(n), n).toThrow();
    }
    expect(() => checkTestDbName(testDbName('core'))).not.toThrow();
  });
});

// Cần container test (TS_TEST_ADMIN_URL — ts/CONVENTIONS.md); không có thì bỏ qua (chế độ unit).
describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('DB test từ mẫu (container)', () => {
  const name = testDbName('core');
  const login = `t_svcjob_${process.pid}`;
  afterAll(async () => {
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
  });

  it('tạo từ samsam_ts_tpl: có schema Python + embedding_v2 + dữ liệu golden', async () => {
    const url = await createDbFromTemplate(name);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query(
        `select (select count(*)::int from sku_master) as sku,
                (select atttypmod from pg_attribute where attrelid = 'chunks'::regclass
                   and attname = 'embedding_v2') as dim,
                exists (select from pg_proc where proname = 'enqueue_item') as enqueue`,
      );
      expect(r.rows[0]).toEqual({ sku: 13, dim: 1024, enqueue: true });
      expect(await privilegedLogin(c)).toMatch(/SUPERUSER/);
    } finally {
      await c.end();
    }
  });

  it('servicePool chế độ thực: login đúng role → được; sai role / superuser → từ chối', async () => {
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`create role ${login} login password '${pw}' in role svc_job`);
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    const env = { NODE_ENV: 'test', AUTH_MODE: 'local' };
    const pool = await servicePool('job', { ...env, JOB_DATABASE_URL: u.toString() });
    expect((await pool.query('select session_user as s')).rows[0].s).toBe(login);
    await pool.end();
    await expect(
      servicePool('webhook', { ...env, WEBHOOK_DATABASE_URL: u.toString() }),
    ).rejects.toThrow("login không thuộc role 'svc_webhook'");
    const admin = new URL(process.env.TS_TEST_ADMIN_URL as string);
    admin.pathname = `/${name}`;
    await expect(
      servicePool('job', { ...env, JOB_DATABASE_URL: admin.toString() }),
    ).rejects.toThrow('SUPERUSER');
  });
});
