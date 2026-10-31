import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { adminQuery, createDbFromTemplate, dbUrl, dropDb } from '@samsam/core/testing/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZaloService } from '../zalo/zalo.service.js';
import { fakeChannels, fakeRag } from '../zalo/zalo.test-helpers.js';
import { MessengerService } from './messenger.service.js';

// DB thật (container test, DB riêng từ mẫu — KHÔNG BAO GIỜ `samsam`): login dịch vụ webhook
// (`in role svc_webhook`) → /readyz select 1 + bằng chứng đầu ra sales-01 `file_output_evidence_chat`
// chỉ cho câu bot ĐÃ gửi khách bằng transport THẬT của Messenger (test_contract_c01_webhook,
// test_v15_fix_p81, docx P0).

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('messenger (DB)', () => {
  const name = 'samsam_ts_messenger_fanpage';
  const login = `t_msgr_webhook_${process.pid}`;
  let admin: Pool;
  let webhook: Pool;

  beforeAll(async () => {
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
    const url = await createDbFromTemplate(name);
    admin = createPool(url);
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`create role ${login} login password '${pw}' in role svc_webhook`);
    const u = new URL(dbUrl(name));
    u.username = login;
    u.password = pw;
    webhook = createPool(u.toString());
  });

  afterAll(async () => {
    await webhook?.end();
    await admin?.end();
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
  });

  function svc(pool: Pool) {
    const dir = mkdtempSync(join(tmpdir(), 'msgr-db-'));
    const zalo = new ZaloService(pool, fakeChannels(), fakeRag(), undefined, {
      env: { DEPLOY: '1' },
      seenDb: join(dir, 'seen.db'),
      convLog: join(dir, 'c.jsonl'),
      tokenStore: join(dir, 'tok.json'),
    });
    const m = new MessengerService(zalo, {
      env: { DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'page-token-gia' },
      fetch: async () => new Response('{}', { status: 200 }),
    });
    return { zalo, m };
  }

  it('login svc_webhook: readiness DB ok (select 1)', async () => {
    const { zalo } = svc(webhook);
    expect(await zalo.readiness(null)).toEqual([true, { config: 'ok', db: 'ok' }]);
    expect((await webhook.query('select session_user as s')).rows[0].s).toBe(login);
  });

  it('câu bot gửi bằng transport THẬT → 1 bằng chứng cv:messenger/<mid>; gửi giả/lỗi → 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { zalo, m } = svc(webhook);
    await zalo.handleText('messenger:1234567890123456', 'Saphraton giá?', 'mid.db1', {
      channel: 'messenger',
      send: m.sendText,
    });
    // transport thay thế (mẫu) và gửi lỗi không phải đầu ra
    await zalo.handleText('messenger:1234567890123457', 'Saphraton giá?', 'mid.db2', {
      channel: 'messenger',
      send: (u, t) => m.sendText(u, t),
    });
    const off = new MessengerService(zalo, { env: {} }); // DEPLOY tắt → không gửi
    await zalo.handleText('messenger:1234567890123458', 'Saphraton giá?', 'mid.db3', {
      channel: 'messenger',
      send: off.sendText,
    });
    log.mockRestore();
    const { rows } = await admin.query(
      `select output_key, ban_ghi::jsonb ->> 'channel' as ch, captured_by
         from file_output_evidence where nguon = 'conversations' order by id`,
    );
    expect(rows).toEqual([
      { output_key: 'cv:messenger/mid.db1', ch: 'messenger', captured_by: login },
    ]);
  });
});
