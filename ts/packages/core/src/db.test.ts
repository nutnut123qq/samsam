import { parse } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/env_db.golden.json' with { type: 'json' };
import {
  assertNotRealDb,
  createPool,
  DbConfigError,
  PRIV_LOGIN_SQL,
  SERVICES,
  type Service,
  serviceDsn,
  servicePool,
  targetDatabase,
} from './db.js';

describe('db ↔ pipelines/auth.py', () => {
  it('SERVICES + PRIV_LOGIN_SQL giống Python', () => {
    for (const [k, [envVar, role]] of Object.entries(golden.services)) {
      expect(SERVICES[k as Service]).toEqual({ envVar, role });
    }
    expect(PRIV_LOGIN_SQL).toBe(golden.priv_login_sql);
  });

  it('service_dsn', () => {
    for (const c of golden.service_dsn) {
      const r = serviceDsn(c.service as Service, c.env as Record<string, string>);
      expect(r, JSON.stringify(c)).toEqual({ dsn: c.dsn, error: c.error });
    }
  });

  it('servicePool: chế độ thực thiếu biến dịch vụ → từ chối, không rơi về DATABASE_URL', async () => {
    await expect(
      servicePool('job', { AUTH_MODE: 'local', DATABASE_URL: 'postgresql://u@h/x' }),
    ).rejects.toThrow('chế độ thực: thiếu JOB_DATABASE_URL');
  });
});

describe('targetDatabase = DB mà pg thật sự dùng', () => {
  const dsns = [
    'postgresql://u:p@127.0.0.1:5432/samsam',
    'postgres://u@h/samsam?database=other',
    'postgresql://u@h/other?sslmode=disable',
    'postgresql://u@h/sam%73am',
    'postgresql://u@h/a b',
    'postgresql://u@/samsam',
    'postgresql://u@h/x?host=%2Fvar%2Frun',
    'socket:/var/run/pg?db=samsam',
    '/var/run/pg samsam',
    'samsam',
    'postgresql://[::1]:5432/t_db',
  ];
  it('khớp pg-connection-string', () => {
    for (const d of dsns) expect(targetDatabase(d), d).toBe(parse(d).database);
  });
  it('thiếu DB tường minh → lỗi (không để pg suy từ PGDATABASE/user)', () => {
    for (const d of ['postgresql://u@h', 'postgresql://u@h/', 'socket:/var/run/pg']) {
      expect(() => targetDatabase(d), d).toThrow(DbConfigError);
    }
  });
});

describe('chặn DB samsam khi NODE_ENV=test', () => {
  it('vitest đặt NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
  it('từ chối samsam (mọi cách viết pg hiểu là samsam)', () => {
    for (const d of [
      'postgresql://u@h/samsam',
      'postgresql://u@h/SamSam',
      'postgresql://u@h/sam%73am',
      'postgres://u@h/samsam?database=t_ok',
      'socket:/run?db=samsam',
    ]) {
      expect(() => assertNotRealDb(d), d).toThrow(/từ chối DB 'samsam'/);
      expect(() => createPool(d), d).toThrow(DbConfigError);
    }
    expect(assertNotRealDb('postgresql://u@h/samsam_ts_tpl')).toBe('samsam_ts_tpl');
  });
  it('ngoài test thì cho (DB thật của server tên samsam)', () => {
    expect(assertNotRealDb('postgresql://u@h/samsam', { NODE_ENV: 'production' })).toBe('samsam');
  });
});
