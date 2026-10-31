import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { PG_POOL } from './db/db.module.js';
import { ZALO_OPTIONS } from './modules/zalo/zalo.deps.js';

// API tích hợp: health + Content Studio + webhook Zalo/Messenger cùng một app (rawBody), DB giả;
// convlog/seen/token của Zalo trỏ thư mục tạm (không đụng data/ thật).
const dir = mkdtempSync(join(tmpdir(), 'api-'));

@Global()
@Module({
  providers: [
    {
      provide: ZALO_OPTIONS,
      useValue: {
        env: {},
        convLog: join(dir, 'conversations.jsonl'),
        seenDb: join(dir, 'seen.db'),
        tokenStore: join(dir, 'tokens.json'),
      },
    },
  ],
  exports: [ZALO_OPTIONS],
})
class TestOptions {}

let app: INestApplication;
let base: string;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule, TestOptions] })
    .overrideProvider(PG_POOL)
    .useValue({ query: async () => ({ rows: [{}] }), end: async () => {} })
    .compile();
  app = mod.createNestApplication({ logger: false, rawBody: true });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});

describe('AppModule', () => {
  it('/healthz + /readyz của API', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/readyz`)).json()).toEqual({
      ready: true,
      checks: { db: 'ok' },
    });
  });

  it('route webhook + Content Studio đã gắn (không 404); webhook không cấu hình DB → readyz 503', async () => {
    for (const p of ['/zalo-webhook/readyz', '/messenger-webhook/readyz']) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(503);
    }
    const draft = await fetch(`${base}/content/draft`, { method: 'POST' });
    expect(draft.status).not.toBe(404);
    // Zalo: chữ ký sai (raw body đọc được) → không 500 "thiếu raw body".
    const z = await fetch(`${base}/zalo-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(z.status).not.toBe(404);
    expect(z.status).not.toBe(500);
  });

  it('REST của web đã gắn: thiếu token → 401 (không 404)', async () => {
    for (const p of [
      '/me',
      '/content/options',
      '/chat/unanswered',
      '/leads',
      '/reports',
      '/garden',
      '/approval',
    ]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(401);
    }
    for (const p of [
      '/chat',
      '/content/check',
      '/content/save',
      '/reports/generate',
      '/garden/logs',
      '/approval/person',
      '/approval/queue/1/decide',
    ]) {
      expect((await fetch(`${base}${p}`, { method: 'POST' })).status, p).toBe(401);
    }
  });
});
