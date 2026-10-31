import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPool } from '@samsam/core/db';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../db/db.module.js';
import { LeadsController } from './leads.controller.js';

// REST tab Leads (port khối tab của app/streamlit_app.py): convlog ở thư mục tạm + Pool GIẢ trả
// đúng các câu của `leadStats`. Tỷ lệ "Đã trả lời" = Python `round(100*a/t)` (về số chẵn): giá trị
// Python thật 1/8 → 12, 3/8 → 38 (scratchpad web_a/golden_uhash.py).

// biome-ignore lint/suspicious/noExplicitAny: thân JSON phản hồi
type Any = Record<string, any>;
let jwks: http.Server;
let issuer = '';
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/realms/samsam`;
  for (const k of ['OIDC_ISSUER', 'OIDC_AUDIENCE']) saved[k] = process.env[k];
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_AUDIENCE = 'samsam-api';
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => jwks.close(r));
});

const token = (role: string) =>
  new SignJWT({ preferred_username: 'lan', typ: 'Bearer', realm_access: { roles: [role] } })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience('samsam-api')
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const TS = new Date('2026-10-20T03:04:59Z');
/** Pool giả: trả lời theo câu SQL của `leadStats`; `fail` → lỗi như thiếu bảng. */
function fakePool(fail = false) {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (q: string | { text: string }) => {
      const sql = typeof q === 'string' ? q : q.text;
      sqls.push(sql);
      if (fail)
        throw Object.assign(new Error('relation "leads" does not exist'), { code: '42P01' });
      if (sql.startsWith('select count(*) from leads where')) return { rows: [{ count: '1' }] };
      if (sql.startsWith('select count(*)')) return { rows: [{ count: '3' }] };
      if (sql.includes('group by channel')) return { rows: [{ k: 'zalo', count: '3' }] };
      if (sql.includes('group by intent'))
        return {
          rows: [
            { k: 'price', count: '2' },
            { k: 'order', count: '1' },
          ],
        };
      if (sql.includes('group by status')) return { rows: [{ k: 'new', count: '3' }] };
      return { rows: [[TS, 'zalo', 'price', 'SĐT 0912345678 của tôi', 'h1', 'new']] };
    },
  };
}

async function start(pool: unknown, conv: object[] | null) {
  const mod = await Test.createTestingModule({
    controllers: [LeadsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = mod.createNestApplication({ logger: false });
  const dir = mkdtempSync(join(tmpdir(), 'leads-'));
  app.get(LeadsController).dataDir = dir;
  if (conv) {
    writeFileSync(
      join(dir, 'conversations.jsonl'),
      `${conv.map((c) => JSON.stringify(c)).join('\n')}\n`,
    );
  }
  await app.listen(0, '127.0.0.1');
}

const get = async (auth?: string) => {
  const res = await fetch(`${await app?.getUrl()}/leads`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Any };
};

describe('GET /leads', () => {
  it('convlog + bảng leads; tỷ lệ làm tròn kiểu Python; câu hỏi che PII', async () => {
    const conv = [
      { ts: '2026-10-20T00:00:00Z', msg_id: 'm1', answered: true },
      ...Array.from({ length: 7 }, (_, i) => ({
        ts: '2026-10-20T00:00:00Z',
        msg_id: '',
        answered: false,
        n: i,
      })),
      { ts: '2026-10-20T00:00:00Z', route: 'consent_granted', answered: true },
    ];
    await start(fakePool(), conv);
    const r = await get(await token('gd_ban_hang'));
    expect(r.status).toBe(200);
    expect(r.body.conv).toEqual({
      total: 8,
      answered: 1,
      by_channel: { zalo: 1, messenger: 0, streamlit: 7 },
      skipped: 0,
      rate: '12%',
    });
    expect(r.body.leads).toEqual({
      total: 3,
      new_7d: 1,
      by_channel: { zalo: 3 },
      by_intent: { price: 2, order: 1 },
      by_status: { new: 3 },
      recent: [
        {
          ts: '2026-10-20T03:04:59.000Z',
          channel: 'zalo',
          intent: 'price',
          question: 'SĐT *** của tôi',
          user_hash: 'h1',
          status: 'new',
        },
      ],
    });
  });

  it('3/8 → 38%; không convlog → "—"; DB lỗi → leads null (không crash)', async () => {
    await start(fakePool(true), null);
    const r = await get(await token('mxh'));
    expect(r.body.conv.rate).toBe('—');
    expect(r.body.leads).toBeNull();
    await app?.close();
    await start(
      fakePool(),
      Array.from({ length: 8 }, (_, i) => ({ ts: '2026-10-20T00:00:00Z', answered: i < 3 })),
    );
    expect((await get(await token('tgd'))).body.conv.rate).toBe('38%');
  });

  it('không token → 401; vai trò không có tab Leads → 403, không đọc DB', async () => {
    const pool = fakePool();
    await start(pool, null);
    expect((await get()).status).toBe(401);
    for (const role of ['phap_che', 'ha_tang'])
      expect((await get(await token(role))).status).toBe(403);
    expect(pool.sqls).toEqual([]);
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('GET /leads (DB thật, login svc_ui)', () => {
  const name = testDbName('web_leads');
  const login = `t_webleads_${process.pid}`;
  const pw = `p${Math.random().toString(36).slice(2)}`;
  afterAll(async () => {
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
  });

  it('svc_ui đọc được bảng leads (quyền kế thừa app_human) — không rơi về "chưa có dữ liệu"', async () => {
    const admin = createPool(await createDbFromTemplate(name));
    try {
      await admin.query(
        "insert into leads (dedup_key, ts, channel, user_hash, question, intent, status, source) values ('k1', now(), 'zalo', 'h1', 'giá bao nhiêu', 'price', 'new', 'convlog')",
      );
    } finally {
      await admin.end();
    }
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password '${pw}' in role svc_ui`);
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    const pool = createPool(u.toString());
    try {
      await start(pool, null);
      const r = await get(await token('gd_marketing'));
      expect(r.body.leads).toMatchObject({ total: 1, by_intent: { price: 1 } });
      expect(r.body.leads.recent[0]).toMatchObject({ question: 'giá bao nhiêu', user_hash: 'h1' });
    } finally {
      await app?.close();
      app = undefined;
      await pool.end();
    }
  });
});
