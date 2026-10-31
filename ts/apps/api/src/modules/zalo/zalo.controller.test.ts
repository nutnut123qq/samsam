import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZaloWebhookCommand } from './zalo.command.js';
import { ZaloController, ZaloHealthController } from './zalo.controller.js';
import { ZaloService } from './zalo.service.js';
import { type Rig, rig } from './zalo.test-helpers.js';

// Dịch tests/test_zalo.py (HTTP: chữ ký, 411/413/400, đóng kết nối khi body sót, ACK nhanh) +
// tests/test_contract_c01_webhook.py (/readyz cấu hình + DB, lỗi cấu hình → exit 1).

const SECRET = 'test-secret';
const APP_ID = 'app123';
const sign = (raw: string, secret = SECRET) => {
  const d = JSON.parse(raw);
  return `mac=${createHash('sha256')
    .update(d.app_id + raw + String(d.timestamp) + secret)
    .digest('hex')}`;
};
const event = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    app_id: APP_ID,
    sender: { id: 'u1' },
    recipient: { id: 'oa1' },
    event_name: 'user_send_text',
    message: { msg_id: 'm1', text: 'Saphraton giá bao nhiêu' },
    timestamp: '1700000000000',
    ...o,
  });

let app: INestApplication | undefined;
let r: Rig;
let port = 0;
let got: unknown[][];

async function start(
  o: { pool?: unknown; rawBody?: boolean; bodyParser?: boolean; unwired?: boolean } = {},
) {
  r = rig();
  if (o.pool !== undefined) {
    const [ch, rag] = o.unwired ? [undefined, undefined] : [r.ch, r.rag];
    const svc = new ZaloService(o.pool as never, ch, rag, undefined, {
      env: { DEPLOY: '1' },
      tokenStore: join(r.dir, 'tok.json'),
      convLog: join(r.dir, 'c.jsonl'),
      seenDb: join(r.dir, 'seen.db'),
    });
    r = { ...r, svc };
  }
  r.svc.oaSecret = SECRET;
  r.svc.sender.cfg.accessToken = 'tok'; // đủ cấu hình DEPLOY → configProblem() null
  got = [];
  r.svc.handleText = async (...a: unknown[]) => {
    got.push(a);
    return { sent: true, text: '' };
  };
  const mod = await Test.createTestingModule({
    controllers: [ZaloController, ZaloHealthController],
    providers: [{ provide: ZaloService, useValue: r.svc }],
  }).compile();
  app = mod.createNestApplication({
    logger: false,
    bodyParser: o.bodyParser ?? false,
    rawBody: o.rawBody ?? false,
  });
  await app.listen(0, '127.0.0.1');
  port = Number(new URL(await app.getUrl()).port);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/zalo-webhook`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** Gửi raw bytes; đọc tới EOF (wantEof) hoặc hết 1 giây (kết nối còn sống). */
function exchange(req: string, wantEof: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    let ended = false;
    const timer = setTimeout(() => {
      s.destroy();
      if (wantEof) reject(new Error(`server lẽ ra phải đóng kết nối: ${buf.slice(0, 80)}`));
      else resolve(buf);
    }, 1000);
    s.on('data', (d) => {
      buf += d.toString('latin1');
    });
    s.on('end', () => {
      ended = true;
      clearTimeout(timer);
      if (!wantEof) reject(new Error('server đóng kết nối ngoài ý muốn'));
      else resolve(buf);
    });
    s.on('error', (e) => {
      if (!ended) {
        clearTimeout(timer);
        wantEof ? resolve(buf) : reject(e);
      }
    });
    s.write(req, 'latin1');
  });
}

const H = 'Host: x\r\nConnection: keep-alive\r\n';

describe('POST /zalo-webhook', () => {
  it('chữ ký đúng → 200 {ok} rồi xử lý nền; retry cùng msg_id chỉ 1 lần', async () => {
    await start();
    const raw = event({ message: { msg_id: 'dup1', text: 'Saphraton giá bao nhiêu' } });
    for (let i = 0; i < 2; i++) {
      const res = await post(raw, { 'X-ZEvent-Signature': sign(raw) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    await new Promise((x) => setTimeout(x, 50));
    expect(got).toEqual([['u1', 'Saphraton giá bao nhiêu', 'dup1']]);
  });

  it('timestamp kiểu số vẫn verify; sai chữ ký → 403; không secret (dev) + thân hỏng → 400', async () => {
    await start();
    const raw = event({ timestamp: 1700000000000 });
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(200);
    expect((await post(event(), { 'X-ZEvent-Signature': 'mac=bad' })).status).toBe(403);
    expect((await post(event())).status).toBe(403);
    r.svc.oaSecret = '';
    r.svc.sender.cfg.env = {}; // dev = DEPLOY tắt (DEPLOY bật + thiếu secret → 503)
    const bad = await post('{not json');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad json' });
  });

  it('ACK 200 trong khi trả lời vẫn đang chạy (dispatch async)', async () => {
    await start();
    let started = false;
    r.svc.handleText = () => {
      started = true;
      return new Promise(() => {}); // không bao giờ xong
    };
    const raw = event({ message: { msg_id: 'slow', text: 'x' } });
    const res = await post(raw, { 'X-ZEvent-Signature': sign(raw) });
    expect(res.status).toBe(200);
    expect(started).toBe(true);
  });

  it('V7.1: từ chối sớm khi chưa đọc body → đóng kết nối; 403 (đã đọc body) giữ keep-alive', async () => {
    await start();
    expect(
      await exchange(`POST /zalo-webhook HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n`, true),
    ).toMatch(/^HTTP\/1\.1 411/);
    expect(
      await exchange(`POST /zalo-webhook HTTP/1.1\r\n${H}Content-Length: 2000000\r\n\r\n`, true),
    ).toMatch(/^HTTP\/1\.1 413/);
    // Content-Length hỏng/âm: parser HTTP của Node trả 400 + đóng (trước khi tới controller).
    expect(
      await exchange(`POST /zalo-webhook HTTP/1.1\r\n${H}Content-Length: abc\r\n\r\n`, true),
    ).toMatch(/^HTTP\/1\.1 400/);
    expect(
      await exchange(`POST /zalo-webhook HTTP/1.1\r\n${H}Content-Length: -5\r\n\r\n`, true),
    ).toMatch(/^HTTP\/1\.1 400/);
    const raw = '{}';
    expect(
      await exchange(
        `POST /zalo-webhook HTTP/1.1\r\n${H}X-ZEvent-Signature: mac=bad\r\nContent-Length: ${raw.length}\r\n\r\n${raw}`,
        false,
      ),
    ).toMatch(/^HTTP\/1\.1 403/);
  });

  it('D5.1: DEPLOY bật mà cấu hình thiếu → 503, không xử lý', async () => {
    await start();
    r.svc.oaSecret = '';
    const raw = event();
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(503);
    expect(got).toEqual([]);
  });

  it('chế độ thực (DEPLOY tắt) thiếu OA secret → 503 cả event KHÔNG ký, không xử lý (TS chặt hơn)', async () => {
    await start();
    r.svc.oaSecret = '';
    r.svc.sender.cfg.env = { APPROVAL_ENFORCE: '1', NODE_ENV: 'production' };
    expect((await post(event())).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/zalo-webhook/readyz`)).status).toBe(503);
    r.svc.sender.cfg.env = {}; // dev: verify bỏ qua như Python
    expect((await post(event())).status).toBe(200);
    await new Promise((x) => setTimeout(x, 50));
    expect(got.length).toBe(1);
  });

  it('POST và /readyz cùng một luật, đọc live: sửa token store bằng tay → cả hai cùng sẵn sàng', async () => {
    await start();
    r.svc.sender.cfg.accessToken = ''; // DEPLOY=1, không token, không bộ refresh
    const raw = event({ message: { msg_id: 'live1', text: 'xin chào' } });
    const ready = () => fetch(`http://127.0.0.1:${port}/zalo-webhook/readyz`);
    expect((await ready()).status).toBe(503);
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(503);
    writeFileSync(join(r.dir, 'zalo_tokens.json'), JSON.stringify({ access_token: 'tok2' }));
    const res = await ready();
    expect([res.status, ((await res.json()) as { checks: object }).checks]).toEqual([
      503, // db chưa cấu hình (pool null) — riêng phần config đã ok
      { config: 'ok', db: 'chua_cau_hinh' },
    ]);
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(200);
    await new Promise((x) => setTimeout(x, 50));
    expect(got).toEqual([['u1', 'xin chào', 'live1']]);
  });

  it('DEPLOY bật mà lớp kênh/RAG CHƯA nối → POST 503 + /readyz config loi (probe báo động)', async () => {
    await start({ pool: { query: () => Promise.resolve({ rows: [{}] }) }, unwired: true });
    const raw = event();
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(503);
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([res.status, await res.json()]).toEqual([
      503,
      { ready: false, checks: { config: 'loi', db: 'ok' } },
    ]);
    expect(got).toEqual([]);
  });

  it('chạy chung API: parser JSON + rawBody → verify trên raw; thiếu rawBody → 500 (fail-closed)', async () => {
    await start({ bodyParser: true, rawBody: true });
    const raw = event({ message: { msg_id: 'api1', text: 'xin chào' } });
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(200);
    await new Promise((x) => setTimeout(x, 50));
    expect(got).toEqual([['u1', 'xin chào', 'api1']]);
    await app?.close();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await start({ bodyParser: true, rawBody: false });
    expect((await post(raw, { 'X-ZEvent-Signature': sign(raw) })).status).toBe(500);
  });
});

describe('GET /healthz, /readyz', () => {
  it('V8.1: GET kèm body → đóng kết nối; GET sạch giữ keep-alive (pipeline 2×200)', async () => {
    await start();
    expect(
      await exchange(`GET /healthz HTTP/1.1\r\n${H}Content-Length: 4\r\n\r\nJUNK`, true),
    ).toMatch(/^HTTP\/1\.1 200/);
    expect(
      await exchange(
        `GET /healthz HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n4\r\nJUNK\r\n0\r\n\r\n`,
        true,
      ),
    ).toMatch(/^HTTP\/1\.1 200/);
    for (const extra of ['Content-Length: 0\r\n', '']) {
      const out = await exchange(
        `GET /healthz HTTP/1.1\r\n${H}${extra}\r\nGET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
        true,
      );
      expect(out.match(/HTTP\/1\.1 200/g)?.length).toBe(2);
    }
  });

  it('C01: /readyz = cấu hình + DB webhook; DB lỗi → 503, không lộ chi tiết', async () => {
    await start({ pool: { query: () => Promise.resolve({ rows: [{}] }) } });
    let res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([res.status, await res.json()]).toEqual([
      200,
      { ready: true, checks: { config: 'ok', db: 'ok' } },
    ]);
    res = await fetch(`http://127.0.0.1:${port}/zalo-webhook/readyz`);
    expect(res.status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({
      status: 'up',
    });
    await app?.close();
    await start({
      pool: {
        query: () => Promise.reject(new Error('password authentication failed for "postgres"')),
      },
    });
    r.svc.sender.cfg.accessToken = '';
    res = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = (await res.json()) as { checks: Record<string, string> };
    expect(res.status).toBe(503);
    expect(body.checks.db).toBe('loi');
    expect(body.checks.config).toBe('loi'); // DEPLOY=1, thiếu access token/bộ refresh
    expect(JSON.stringify(body)).not.toContain('postgres');
    await app?.close();
    await start();
    res = await fetch(`http://127.0.0.1:${port}/readyz`);
    const b2 = (await res.json()) as { checks: Record<string, string> };
    expect([res.status, b2.checks.db]).toEqual([503, 'chua_cau_hinh']);
  });
});

describe('lệnh zalo-webhook', () => {
  it('DEPLOY bật thiếu OA secret → in [fatal], exit 1 (systemd Restart)', async () => {
    vi.stubEnv('DEPLOY', '1');
    vi.stubEnv('ZALO_OA_SECRET', '');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    await new ZaloWebhookCommand().run();
    expect(process.exitCode).toBe(1);
    expect(out.mock.calls.flat().join('\n')).toContain(
      '[fatal] zalo: DEPLOY bật nhưng thiếu ZALO_OA_SECRET',
    );
    process.exitCode = before;
  });

  it('chế độ thực thiếu WEBHOOK_DATABASE_URL → [fatal] zalo: …, exit 1', async () => {
    vi.stubEnv('DEPLOY', '1');
    vi.stubEnv('ZALO_OA_SECRET', 's');
    vi.stubEnv('ZALO_ACCESS_TOKEN', 'tok');
    vi.stubEnv('WEBHOOK_DATABASE_URL', '');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    await new ZaloWebhookCommand().run();
    expect(process.exitCode).toBe(1);
    expect(out.mock.calls.flat().join('\n')).toContain(
      '[fatal] zalo: chế độ thực: thiếu WEBHOOK_DATABASE_URL',
    );
    process.exitCode = before;
  });
});
