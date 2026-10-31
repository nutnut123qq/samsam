import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AI_GATEWAY, PG_POOL } from '../../db/db.module.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

// REST Content Studio: token Keycloak (JWKS sinh tại chỗ, server JWKS cục bộ), vai trò phải có tab
// Content Studio, kênh lạ/brief rỗng → 400, gateway chặn → 503. Pool + gateway GIẢ (0 mạng ngoài
// loopback, 0 DB).

// biome-ignore lint/suspicious/noExplicitAny: thân JSON phản hồi
type Any = Record<string, any>;
const SAFE = 'Sâm Sâm Quảng Nam — đặc sản quê hương, quà tặng.\n\nNội dung có sử dụng AI';
let jwks: http.Server;
let issuer = '';
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      req.url?.endsWith('/protocol/openid-connect/certs') ? JSON.stringify({ keys: [jwk] }) : '{}',
    );
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

const token = (role: string | null, aud = 'samsam-api') =>
  new SignJWT({
    preferred_username: 'lan',
    typ: 'Bearer',
    realm_access: { roles: role ? [role] : [] },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(chat: (agent: string) => Promise<string>) {
  const calls: string[] = [];
  const ai = {
    chat: async (agent: string) => {
      calls.push(agent);
      return { text: await chat(agent), model: 'f', provider: 'ollama', tokensIn: 0, tokensOut: 0 };
    },
  };
  // view sku_readiness giả: savina-12v × shopee = MO_TA.
  const pool = {
    query: async () => ({
      rows: [{ sku_key: 'savina-12v', channel: 'shopee', readiness: 'MO_TA' }],
    }),
  };
  const mod = await Test.createTestingModule({
    controllers: [ContentController],
    providers: [
      ContentService,
      { provide: AI_GATEWAY, useValue: ai },
      { provide: PG_POOL, useValue: pool },
    ],
  }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return calls;
}

const post = async (path: string, body: unknown, auth?: string) => {
  const res = await fetch(`${await app?.getUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Any };
};

describe('POST /content/draft, /content/listing', () => {
  it('không token / token sai audience → 401; vai trò không có tab Content Studio → 403; 0 LLM', async () => {
    const calls = await start(async () => SAFE);
    const body = { brief: 'x', channels: ['facebook'] };
    expect((await post('/content/draft', body)).status).toBe(401);
    expect((await post('/content/draft', body, await token('gd_marketing', 'khac'))).status).toBe(
      401,
    );
    expect((await post('/content/draft', body, await token('ha_tang'))).status).toBe(403);
    expect((await post('/content/draft', body, await token(null))).status).toBe(403);
    expect(
      (await post('/content/listing', { sku: 'savina-12v', channels: ['shopee'] })).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  it('thiếu cấu hình OIDC → 401 (fail-closed)', async () => {
    await start(async () => SAFE);
    const t = await token('gd_marketing');
    delete process.env.OIDC_ISSUER;
    try {
      expect((await post('/content/draft', { brief: 'x', channels: ['facebook'] }, t)).status).toBe(
        401,
      );
    } finally {
      process.env.OIDC_ISSUER = issuer;
    }
  });

  it('gd_marketing: nháp mỗi kênh qua guardrail, không ghi DB', async () => {
    const calls = await start(async () => SAFE);
    const r = await post(
      '/content/draft',
      { brief: 'giới thiệu', channels: ['facebook', 'zalo'] },
      await token('gd_marketing'),
    );
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.results)).toEqual(['facebook', 'zalo']);
    for (const x of Object.values(r.body.results) as Any[]) {
      expect(x.guardrail.ok).toBe(true);
      expect(x.meta.prompt_version).toMatch(/^content_/);
    }
    expect(calls).toEqual(['content', 'content']);
    const ruou = await post(
      '/content/draft',
      { brief: 'b', channels: ['facebook'], sku: 'ruou-sam-binh-su-do-500ml' },
      await token('mxh'),
    );
    expect(ruou.body.results.facebook.meta.refused.code).toBe('ruou');
    expect(calls.length).toBe(2); // từ chối = 0 LLM
  });

  it('listing: khung golden theo readiness DB; kênh ngoài sàn → 400', async () => {
    const calls = await start(async () => SAFE);
    const t = await token('phap_che');
    const r = await post(
      '/content/listing',
      { sku: 'savina-12v', channels: ['shopee', 'tiktok'] },
      t,
    );
    expect(r.status).toBe(200);
    expect(r.body.results.shopee.ok).toBe(true);
    expect(r.body.results.shopee.text).toContain('Giá: 159.000 đ');
    expect(r.body.results.tiktok.refused.code).toBe('readiness');
    expect(calls).toEqual([]); // MO_TA = khung, 0 LLM
    expect(
      (await post('/content/listing', { sku: 'savina-12v', channels: ['facebook'] }, t)).status,
    ).toBe(400);
    expect((await post('/content/listing', { channels: ['shopee'] }, t)).status).toBe(400);
  });

  it('body sai → 400 TRƯỚC LLM; gateway bị chặn → 503', async () => {
    const calls = await start(async () => {
      throw new GatewayBlocked('kill-switch: content');
    });
    const t = await token('tgd');
    for (const body of [
      { brief: '   ', channels: ['facebook'] },
      { brief: 'x'.repeat(4001), channels: ['facebook'] },
      { brief: 'x', channels: [] },
      { brief: 'x', channels: ['insta'] },
      { brief: 'x', channels: ['facebook'], sku: 5 },
      [],
    ]) {
      expect(
        (await post('/content/draft', body, t)).status,
        JSON.stringify(body).slice(0, 40),
      ).toBe(400);
    }
    expect(calls).toEqual([]);
    const r = await post('/content/draft', { brief: 'x', channels: ['facebook'] }, t);
    expect(r.status).toBe(503);
    expect(r.body.message).toBe('kill-switch: content');
  });
});
