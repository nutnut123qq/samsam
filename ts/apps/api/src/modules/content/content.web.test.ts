import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { ROLE_TABS } from '@samsam/core/security/auth';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AI_GATEWAY, PG_POOL } from '../../db/db.module.js';
import { PersonSessions } from '../approval/person-sessions.js';
import { ContentController, WebController } from './content.controller.js';
import { ContentModule } from './content.module.js';
import {
  ContentService,
  NEED_PERSON,
  openDraft,
  PERSON_DB,
  type PersonDb,
  sealDraft,
  studioOptions,
} from './content.service.js';

// REST web phần Content Studio (port tab Streamlit): GET /me, /content/options, /content/check,
// token lưu nháp (/content/draft → /content/save). Token Keycloak ký bằng JWKS sinh tại chỗ; LLM GIẢ
// (0 mạng ngoài loopback). Phần lưu thật chạy trên DB test riêng (testDbName, xóa khi xong) — KHÔNG
// BAO GIỜ DB `samsam`.

// biome-ignore lint/suspicious/noExplicitAny: thân JSON phản hồi
type Any = Record<string, any>;
const SAFE = 'Sâm Sâm Quảng Nam — đặc sản quê hương, quà tặng.\n\nNội dung có sử dụng AI';
const ENV_KEYS = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'AUTH_MODE', 'APPROVAL_ENFORCE', 'DEPLOY'];
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
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ['AUTH_MODE', 'APPROVAL_ENFORCE', 'DEPLOY']) delete process.env[k];
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

const token = (role: string | null, sub = 'u-1', user = 'lan') =>
  new SignJWT({
    preferred_username: user,
    typ: 'Bearer',
    realm_access: { roles: role ? [role] : [] },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience('samsam-api')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.APPROVAL_ENFORCE;
});

async function start(pool: unknown, personDb?: PersonDb) {
  const calls: string[] = [];
  const ai = {
    chat: async (agent: string) => {
      calls.push(agent);
      return { text: SAFE, model: 'f', provider: 'ollama', tokensIn: 0, tokensOut: 0 };
    },
  };
  const mod = await Test.createTestingModule({
    controllers: [ContentController, WebController],
    providers: [
      ContentService,
      { provide: AI_GATEWAY, useValue: ai },
      { provide: PG_POOL, useValue: pool },
      ...(personDb ? [{ provide: PERSON_DB, useValue: personDb }] : []),
    ],
  }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return calls;
}
const fakePool = { query: async () => ({ rows: [] }) };

async function req(method: string, path: string, body?: unknown, auth?: string) {
  const res = await fetch(`${await app?.getUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Any };
}

describe('GET /me', () => {
  it('tab theo vai trò = core ROLE_TABS; không vai trò → [] (200); không token → 401', async () => {
    await start(fakePool);
    for (const role of Object.keys(ROLE_TABS)) {
      const r = await req('GET', '/me', undefined, await token(role));
      expect(r.body).toEqual({
        username: 'lan',
        role,
        tabs: [...ROLE_TABS[role as keyof typeof ROLE_TABS]],
        enforced: false,
      });
    }
    expect((await req('GET', '/me', undefined, await token(null))).body.tabs).toEqual([]);
    expect((await req('GET', '/me')).status).toBe(401);
    process.env.APPROVAL_ENFORCE = '1';
    expect((await req('GET', '/me', undefined, await token('tgd'))).body.enforced).toBe(true);
  });
});

describe('studioOptions / GET /content/options', () => {
  it('dữ liệu thật: loại công khai bỏ image/video, mặc định có post; SKU golden', async () => {
    await start(fakePool);
    const r = await req('GET', '/content/options', undefined, await token('mxh'));
    expect(r.status).toBe(200);
    expect(r.body.contentTypes).toContain('post');
    expect(r.body.contentTypes).toContain('listing');
    expect(r.body.contentTypes).not.toContain('image');
    expect(r.body.contentTypes).not.toContain('video');
    expect(r.body.checkTypes).toEqual(expect.arrayContaining(r.body.contentTypes));
    expect(r.body.skus.length).toBe(13);
    expect((await req('GET', '/content/options', undefined, await token('ha_tang'))).status).toBe(
      403,
    );
  });

  it('file hỏng/thiếu → ["post"] / [] như Streamlit; loại không phải dict bị bỏ khỏi loại công khai', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-'));
    expect(studioOptions(dir)).toEqual({ contentTypes: ['post'], checkTypes: ['post'], skus: [] });
    const put = (rules: unknown, golden: unknown) => {
      writeFileSync(join(dir, 'guardrail_rules.json'), JSON.stringify(rules));
      writeFileSync(join(dir, 'golden_skus.json'), JSON.stringify(golden));
      return studioOptions(dir);
    };
    expect(
      put(
        { content_types: { post: { public: true }, note: 'x', image: { public: true }, reel: {} } },
        { skus: [{ sku_key: 'a' }, { sku_key: 'b' }] },
      ),
    ).toEqual({
      contentTypes: ['post'],
      checkTypes: ['post', 'note', 'image', 'reel'],
      skus: ['a', 'b'],
    });
    expect(put({ content_types: { video: { public: [] } } }, { skus: [{}] })).toEqual({
      contentTypes: ['post'],
      checkTypes: ['video'],
      skus: [],
    });
    expect(put({ content_types: ['post', 'reel'] }, { skus: [{ sku_key: 5 }] })).toEqual({
      contentTypes: ['post'],
      checkTypes: ['post'],
      skus: [],
    });
  });
});

describe('POST /content/check', () => {
  it('luật đăng bài không LLM: vi phạm → dòng error; body sai → 400', async () => {
    const calls = await start(fakePool);
    const t = await token('gd_marketing');
    const bad = await req(
      'POST',
      '/content/check',
      {
        text: 'Saphraton chữa khỏi tiểu đường',
        channel: 'facebook',
        contentType: 'post',
        isAi: true,
      },
      t,
    );
    expect(bad.status).toBe(200);
    expect(bad.body.guardrail.ok).toBe(false);
    expect(bad.body.lines.some(([lv]: [string]) => lv === 'error')).toBe(true);
    for (const body of [
      { text: '  ', channel: 'facebook', contentType: 'post', isAi: true },
      { text: 'x'.repeat(20001), channel: 'facebook', contentType: 'post', isAi: true },
      { text: 'x', channel: 'shopee', contentType: 'post', isAi: true },
      { text: 'x', channel: 'facebook', contentType: 'post', isAi: 'true' },
      { text: 'x', channel: 'facebook', isAi: true },
    ]) {
      expect((await req('POST', '/content/check', body, t)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});

describe('token nháp (/content/draft → /content/save)', () => {
  it('nháp có dòng guardrail + token; bản từ chối không có token', async () => {
    await start(fakePool);
    const t = await token('gd_marketing');
    const r = await req(
      'POST',
      '/content/draft',
      { brief: 'giới thiệu', channels: ['facebook'] },
      t,
    );
    const fb = r.body.results.facebook;
    expect(fb.lines).toEqual([
      ['success', 'Guardrail: PASS — không vi phạm'],
      ['info', 'Lớp LLM-check: off'],
      ['info', 'Nhãn bắt buộc: Nội dung có sử dụng AI'],
    ]);
    expect(openDraft(fb.token, 'u-1')).toMatchObject({
      sub: 'u-1',
      brief: 'giới thiệu',
      channel: 'facebook',
      text: SAFE,
      meta: { content_type: 'post', sku: null, is_ai: true },
    });
    const ruou = await req(
      'POST',
      '/content/draft',
      { brief: 'b', channels: ['facebook'], sku: 'ruou-sam-binh-su-do-500ml' },
      t,
    );
    expect(ruou.body.results.facebook.token).toBeNull();
  });

  it('token sửa/của người khác/rỗng → 400 TRƯỚC khi ghi; chế độ thực chưa có phiên người → 409', async () => {
    let queried = 0;
    const pool = {
      query: async () => {
        queried++;
        return { rows: [] };
      },
    };
    await start(pool);
    const tok = sealDraft({
      sub: 'u-1',
      brief: 'b',
      channel: 'facebook',
      text: SAFE,
      guardrail: { ok: true },
      meta: {
        content_type: 'post',
        sku: null,
        is_ai: true,
        prompt_version: null,
        prompt_sha256: null,
      },
    });
    const [p, sig] = tok.split('.');
    const forged = Buffer.from(
      Buffer.from(p, 'base64url').toString('utf8').replace('"is_ai":true', '"is_ai":false'),
    ).toString('base64url');
    const t = await token('mxh');
    for (const tokens of [
      [`${forged}.${sig}`],
      [`${tok}x`],
      [tok, 'abc'],
      [],
      'x',
      [tok, tok, tok, tok, tok],
      [tok, tok], // trùng kênh
    ]) {
      expect((await req('POST', '/content/save', { tokens }, t)).status).toBe(400);
    }
    expect(
      (await req('POST', '/content/save', { tokens: [tok] }, await token('mxh', 'u-2'))).status,
    ).toBe(400);
    process.env.APPROVAL_ENFORCE = '1';
    const r = await req('POST', '/content/save', { tokens: [tok] }, t);
    expect(r).toEqual({
      status: 409,
      body: { statusCode: 409, message: NEED_PERSON, error: 'Conflict' },
    });
    expect(queried).toBe(0);
  });
});

describe('ContentModule', () => {
  it('PERSON_DB = phiên người còn sống của đúng người đăng nhập (PersonSessions.forUser)', async () => {
    @Global()
    @Module({
      providers: [
        { provide: PG_POOL, useValue: fakePool },
        { provide: AI_GATEWAY, useValue: {} },
      ],
      exports: [PG_POOL, AI_GATEWAY],
    })
    class FakeDb {}
    const conn = { tag: 'phiên lan' };
    const mod = await Test.createTestingModule({ imports: [FakeDb, ContentModule] })
      .overrideProvider(PersonSessions)
      .useValue({ forUser: async (u: string) => (u === 'lan' ? conn : null) })
      .compile();
    const personDb = mod.get<PersonDb>(PERSON_DB);
    const who = { username: 'lan', email: null, role: 'gd_marketing' as const, sub: 'u-1' };
    expect(await personDb(who)).toBe(conn);
    expect(await personDb({ ...who, username: 'minh' })).toBeNull();
    await mod.close();
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('lưu vào hàng duyệt (DB thật)', () => {
  const name = testDbName('web_content');
  const ui = `t_webui_${process.pid}`;
  const person = `t_webp_${process.pid}`;
  const pw = `p${Math.random().toString(36).slice(2)}`;
  let pool: pg.Pool;
  const loginUrl = (login: string) => {
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    return u.toString();
  };

  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
    wireCore(pool);
    await adminQuery(`drop role if exists ${ui}`);
    await adminQuery(`drop role if exists ${person}`);
    await adminQuery(`create role ${ui} login password '${pw}' in role svc_ui`);
    await adminQuery(`create role ${person} login password '${pw}' in role app_human`);
    await pool.query(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, 'lan', '{marketing}', 'test')",
      [person],
    );
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
    await adminQuery(`drop role if exists ${ui}`);
    await adminQuery(`drop role if exists ${person}`);
    resetOpsDeps();
  });

  const draftTokens = async (t: string) =>
    (
      await req(
        'POST',
        '/content/draft',
        { brief: 'giới thiệu quà', channels: ['facebook', 'zalo'] },
        t,
      )
    ).body.results as Record<string, Any>;

  it('dev: lưu bằng pool → nháp pending của người đăng nhập + log draft_create; login svc_ui bị DB từ chối tên người → errs', async () => {
    await start(pool);
    const t = await token('gd_marketing');
    const res = await draftTokens(t);
    const r = await req(
      'POST',
      '/content/save',
      { tokens: [res.facebook.token, res.zalo.token] },
      t,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ saved: ['facebook', 'zalo'], dups: 0, errs: 0, blocked: null });
    expect(r.body.ids).toHaveLength(2);
    const rows = (
      await pool.query(
        "select channel, created_by, status, is_ai, source, guardrail->>'ok' as ok from content_drafts where id = any($1::bigint[]) order by id",
        [r.body.ids],
      )
    ).rows;
    expect(rows).toEqual([
      {
        channel: 'facebook',
        created_by: 'lan',
        status: 'pending',
        is_ai: true,
        source: 'manual:studio',
        ok: 'true',
      },
      {
        channel: 'zalo',
        created_by: 'lan',
        status: 'pending',
        is_ai: true,
        source: 'manual:studio',
        ok: 'true',
      },
    ]);
    const log = await pool.query(
      "select count(*)::int as n from agent_action_log where action = 'draft_create' and object_id = any($1::text[])",
      [r.body.ids],
    );
    expect(log.rows[0].n).toBe(2);
    await app?.close();

    const uiPool = createPool(loginUrl(ui));
    try {
      await start(uiPool);
      const res2 = await draftTokens(t);
      const r2 = await req('POST', '/content/save', { tokens: [res2.facebook.token] }, t);
      expect(r2.body).toMatchObject({ ids: [], saved: [], errs: 1 });
    } finally {
      await uiPool.end();
    }
  });

  it('chế độ thực: lưu bằng login Postgres RIÊNG của người (PERSON_DB) — DB đối chiếu human_logins', async () => {
    const c = new pg.Client({ connectionString: loginUrl(person) });
    await c.connect();
    try {
      await start(pool, (who) => (who.username === 'lan' ? c : null));
      process.env.APPROVAL_ENFORCE = '1';
      const t = await token('gd_marketing');
      const res = await draftTokens(t);
      const r = await req('POST', '/content/save', { tokens: [res.facebook.token] }, t);
      expect(r.body).toMatchObject({ saved: ['facebook'], errs: 0 });
      const row = (
        await pool.query('select created_by, created_login from content_drafts where id = $1', [
          r.body.ids[0],
        ])
      ).rows[0];
      expect(row).toEqual({ created_by: 'lan', created_login: person });
      // Người khác (không có phiên người) → 409, không ghi.
      const tm = await token('gd_marketing', 'u-3', 'minh');
      const mine = await draftTokens(tm);
      const other = await req('POST', '/content/save', { tokens: [mine.zalo.token] }, tm);
      expect(other.body).toMatchObject({ statusCode: 409, message: NEED_PERSON });
    } finally {
      await c.end();
    }
  });
});
