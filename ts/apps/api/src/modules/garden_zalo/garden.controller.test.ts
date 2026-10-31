import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../db/db.module.js';
import { PERSON_CONNECT, PERSON_ENV, PersonSessions } from '../approval/person-sessions.js';
import { call, type Jwks, startJwks } from '../approval/web-testing.js';
import { GardenController } from './garden.controller.js';

// REST "Nhật ký vườn": chỉ vai trò có tab (tgd, ha_tang); đọc khoảnh/bất thường/nhật ký gần nhất
// (chi tiết che SĐT); ghi CHỈ qua phiên login người (`plot_log_add_human`, người ghi = người đăng
// nhập), chưa mở phiên → không ghi; 42501 → "Không có quyền ghi nhật ký vườn". Pool/kết nối GIẢ.

const NOW = new Date();
const pool = {
  query: async (sql: string) => {
    if (sql.includes('from plots where status')) {
      return {
        rows: [
          { id: 'K01', loc: 'Trà Linh' },
          { id: 'K02', loc: '' },
        ],
      };
    }
    if (sql.includes('max(ts) as mx')) return { rows: [{ plot_id: 'K01', mx: NOW }] };
    if (sql.includes('from plot_logs where ts >= $1')) {
      return { rows: [{ ts: NOW, plot_id: 'K01', activity: 'ghi nhận', detail: 'có rệp' }] };
    }
    if (sql.includes('author, source from plot_logs')) {
      return {
        rows: [
          {
            ts: new Date('2026-10-30T01:02:03Z'),
            plot_id: 'K01',
            activity: 'tưới',
            detail: 'báo anh Hai 0912345678',
            author: 'Lan',
            source: 'manual:garden',
          },
        ],
      };
    }
    throw new Error(`SQL lạ: ${sql}`);
  },
};

const calls: unknown[][] = [];
let fail: { code: string; message: string } | null = null;
const client = {
  query: async (sql: string, params: unknown[]) => {
    calls.push([sql, params]);
    if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
    return { rows: [{ id: '7' }] };
  },
  end: async () => {},
  on: () => {},
};
const connect = async () => ({ client: client as never, person: 'Lan', blocks: ['farming'] });

let jw: Jwks;
let dir = '';
let app: INestApplication | undefined;

beforeAll(async () => {
  jw = await startJwks();
  dir = mkdtempSync(join(tmpdir(), 'garden-web-'));
  writeFileSync(
    join(dir, 'users.json'),
    JSON.stringify({ lan: { role: 'ha_tang', password_hash: '', db_login: 'lan_pg' } }),
  );
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await jw.close();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  fail = null;
  calls.length = 0;
});

async function start(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    controllers: [GardenController],
    providers: [
      PersonSessions,
      { provide: PG_POOL, useValue: pool },
      { provide: PERSON_CONNECT, useValue: connect },
      {
        provide: PERSON_ENV,
        useValue: {
          NODE_ENV: 'test',
          OIDC_ISSUER: jw.issuer,
          OIDC_AUDIENCE: 'samsam-api',
          AUTH_USERS_FILE: join(dir, 'users.json'),
          UI_DATABASE_URL: 'postgresql://u@127.0.0.1:9/t_web',
        },
      },
    ],
  }).compile();
  const a = mod.createNestApplication({ logger: false });
  await a.listen(0, '127.0.0.1');
  app = a;
  return a;
}

describe('REST /garden', () => {
  it('quyền tab: mxh không có Nhật ký vườn → 403', async () => {
    const a = await start();
    const r = await call(a, 'GET', '/garden', { token: await jw.token('lan', 'mxh') });
    expect([r.status, r.body.message]).toEqual([403, 'vai trò không có tab Nhật ký vườn']);
  });

  it('GET: khoảnh, vocab + khác…, bất thường, nhật ký gần nhất (che SĐT)', async () => {
    const a = await start();
    const { status, body } = await call(a, 'GET', '/garden', {
      token: await jw.token('lan', 'ha_tang'),
    });
    expect(status).toBe(200);
    expect(body.plots).toEqual([
      { id: 'K01', label: 'K01 — Trà Linh' },
      { id: 'K02', label: 'K02' },
    ]);
    expect(body.activities.at(-1)).toBe('khác…');
    expect(body.anomalies).toEqual(['K02: chưa có nhật ký nào', 'K01: ghi nhận — rệp']);
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]).toMatchObject({
      ts: '2026-10-30 01:02',
      plot: 'K01',
      activity: 'tưới',
      author: 'Lan',
      source: 'manual:garden',
    });
    expect(body.recent[0].detail).not.toContain('0912345678');
    expect(body.unlocked).toBe(false);
  });

  it('POST: thiếu khoảnh/ngày; chưa mở phiên người → không ghi', async () => {
    const a = await start();
    const token = await jw.token('lan', 'ha_tang');
    const post = (body: unknown) => call(a, 'POST', '/garden/logs', { token, body });
    expect((await post({ activity: 'tưới', date: '2026-10-30' })).body.message).toBe(
      'Chưa có khoảnh active nào trong DB.',
    );
    expect((await post({ plot: 'K01', activity: 'tưới', date: '2026-02-30' })).body.message).toBe(
      'Chọn ngày cho nhật ký.',
    );
    expect((await post({ plot: 'K01', detail: 5 })).status).toBe(400);
    expect((await post({ plot: 'K01', activity: 'tưới', date: '2026-10-30' })).body).toEqual({
      ok: false,
      message: 'Không ghi được — xem cảnh báo.',
      warnings: ['Chưa mở quyền bằng login Postgres riêng.'],
    });
    expect(calls).toEqual([]);
  });

  it('POST qua phiên người: plot_log_add_human với người đăng nhập; khác… dùng chữ tự ghi; 42501', async () => {
    const a = await start();
    const token = await jw.token('lan', 'ha_tang');
    const { handle } = await a.get(PersonSessions).open('lan', 'mk');
    const post = (body: unknown) =>
      call(a, 'POST', '/garden/logs', { token, person: handle, body });
    const r = await post({ plot: ' K01 ', activity: 'tưới', date: '2026-10-29', detail: ' ổn ' });
    expect(r.body).toEqual({ ok: true, message: 'Đã ghi nhật ký #7: K01 — tưới', warnings: [] });
    const [sql, params] = calls[0] as [string, unknown[]];
    expect(sql).toBe('select plot_log_add_human($1, $2, $3, $4, $5) as id');
    expect([params[0], params[2], params[3], params[4]]).toEqual(['K01', 'tưới', 'ổn', 'lan']);
    expect((params[1] as Date).toISOString().slice(0, 10)).toBe('2026-10-29');
    const other = await post({
      plot: 'K01',
      activity: 'khác…',
      activityFree: ' tỉa cành ',
      date: '2026-10-29',
    });
    expect(other.body.message).toBe('Đã ghi nhật ký #7: K01 — tỉa cành');
    expect(other.body.warnings).toEqual([
      "hoạt động 'tỉa cành' chưa có trong vocab — ghi nguyên văn",
    ]);
    fail = { code: '42501', message: 'login không thuộc khối farming' };
    expect((await post({ plot: 'K01', activity: 'tưới', date: '2026-10-29' })).body).toEqual({
      ok: false,
      message: 'Không ghi được — xem cảnh báo.',
      warnings: ['Không có quyền ghi nhật ký vườn: login không thuộc khối farming'],
    });
  });
});
