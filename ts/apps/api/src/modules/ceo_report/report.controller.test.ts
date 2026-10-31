import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../db/db.module.js';
import { PERSON_ENV } from '../approval/person-sessions.js';
import { call, type Jwks, startJwks } from '../approval/web-testing.js';
import { REPORT_DIRS, ReportController } from './report.controller.js';

// REST "Báo cáo": vai trò có tab (mxh không có), kỳ chỉ 7|14|30, DB chết → vẫn ghi bản DEGRADED
// (phần convlog file-based), xem báo cáo theo đúng tên trong thư mục (không đường dẫn tự do), nội
// dung trả web đã che SĐT. Rollout giả (installFakeDeps), Pool giả lỗi kết nối, thư mục tạm.

let jw: Jwks;
let root = '';
let out = '';
let app: INestApplication | undefined;
const down = {
  query: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  },
};

beforeAll(async () => {
  jw = await startJwks();
  root = mkdtempSync(join(tmpdir(), 'report-web-'));
  out = join(root, 'reports');
  mkdirSync(join(root, 'data'));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await jw.close();
});
beforeEach(() => {
  installFakeDeps();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  resetOpsDeps();
});

async function start(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    controllers: [ReportController],
    providers: [
      { provide: PG_POOL, useValue: down },
      { provide: REPORT_DIRS, useValue: { out, data: join(root, 'data') } },
      {
        provide: PERSON_ENV,
        useValue: { NODE_ENV: 'test', OIDC_ISSUER: jw.issuer, OIDC_AUDIENCE: 'samsam-api' },
      },
    ],
  }).compile();
  const a = mod.createNestApplication({ logger: false });
  await a.listen(0, '127.0.0.1');
  app = a;
  return a;
}

describe('REST /reports', () => {
  it('quyền tab + kỳ hợp lệ', async () => {
    const a = await start();
    expect((await call(a, 'GET', '/reports')).status).toBe(401);
    const mxh = await call(a, 'GET', '/reports', { token: await jw.token('x', 'mxh') });
    expect([mxh.status, mxh.body.message]).toEqual([403, 'vai trò không có tab Báo cáo']);
    const t = await jw.token('lan', 'gd_ban_hang');
    expect((await call(a, 'GET', '/reports', { token: t })).body).toEqual({ files: [] });
    for (const days of [5, '7', null]) {
      const r = await call(a, 'POST', '/reports/generate', { token: t, body: { days } });
      expect(r.status).toBe(400);
    }
  });

  it('DB chết → ghi bản DEGRADED; liệt kê + đọc theo tên; che SĐT; tên lạ 404', async () => {
    const a = await start();
    const t = await jw.token('lan', 'tgd');
    const g = await call(a, 'POST', '/reports/generate', { token: t, body: { days: 7 } });
    expect(g.status).toBe(200);
    expect(g.body.dbOk).toBe(false);
    expect(g.body.name).toMatch(/^report-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/);
    expect(g.body.message).toBe(
      `Đã ghi báo cáo DEGRADED — không kết nối được DB, phần DB đánh dấu [chưa nạp]: data/reports/${g.body.name}`,
    );
    expect(existsSync(join(out, g.body.name))).toBe(true);
    writeFileSync(join(out, 'report-2000-01-01_2000-01-07.md'), 'Liên hệ 0912345678\n');
    writeFileSync(join(out, 'ceo-2000-W01.md'), 'không phải báo cáo định kỳ');
    const list = await call(a, 'GET', '/reports', { token: t });
    expect(list.body.files).toEqual([g.body.name, 'report-2000-01-01_2000-01-07.md']);
    const one = await call(a, 'GET', `/reports/${g.body.name}`, { token: t });
    expect(one.body.text).toContain('[chưa nạp — connect ECONNREFUSED');
    const old = await call(a, 'GET', '/reports/report-2000-01-01_2000-01-07.md', { token: t });
    expect(old.body.text).not.toContain('0912345678');
    for (const bad of ['ceo-2000-W01.md', 'report-..%2F..%2Fx.md', '..%2Freports%2Fx']) {
      expect((await call(a, 'GET', `/reports/${bad}`, { token: t })).status).toBe(404);
    }
  });

  it('tính năng báo cáo TẮT (HĐ 6.7) → 409, không ghi', async () => {
    installFakeDeps(
      {},
      { quick: null, reportFeature: () => 'ceo-01', stages: { 'ceo-01': 'tat' } },
    );
    const a = await start();
    const r = await call(a, 'POST', '/reports/generate', {
      token: await jw.token('lan', 'tgd'),
      body: { days: 14 },
    });
    expect(r.status).toBe(409);
  });
});
