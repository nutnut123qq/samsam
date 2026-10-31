import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../db/db.module.js';
import { HealthController } from './health.controller.js';

// Mẫu test module: Pool giả qua token PG_POOL, server thật trên cổng ngẫu nhiên + fetch.
async function start(query: () => Promise<unknown>): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: PG_POOL, useValue: { query } }],
  }).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = async (path: string) => {
  const res = await fetch(`${await app?.getUrl()}${path}`);
  return { status: res.status, body: await res.json() };
};

describe('health', () => {
  it('/healthz = tiến trình sống, không đụng DB', async () => {
    app = await start(() => Promise.reject(new Error('down')));
    expect(await get('/healthz')).toEqual({ status: 200, body: { status: 'up' } });
  });

  it('/readyz: DB trả select 1 → 200 ready', async () => {
    app = await start(() => Promise.resolve({ rows: [{}] }));
    expect(await get('/readyz')).toEqual({
      status: 200,
      body: { ready: true, checks: { db: 'ok' } },
    });
  });

  it('/readyz: DB lỗi → 503, không lộ chi tiết lỗi', async () => {
    app = await start(() => Promise.reject(new Error('password authentication failed for "x"')));
    expect(await get('/readyz')).toEqual({
      status: 503,
      body: { ready: false, checks: { db: 'loi' } },
    });
  });
});
