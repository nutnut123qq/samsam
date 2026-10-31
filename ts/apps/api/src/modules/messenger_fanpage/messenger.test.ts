import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { left, sendLate, withBudget } from '../zalo/zalo.budget.js';
import {
  clock,
  FALLBACK,
  HOLD_TEXT,
  NO_HANDOFF_TEXT,
  NON_TEXT_TEXT,
} from '../zalo/zalo.constants.js';
import type { FetchFn } from '../zalo/zalo.sender.js';
import { ZaloService } from '../zalo/zalo.service.js';
import { type Rig, rig } from '../zalo/zalo.test-helpers.js';
import { uhash } from '../zalo/zalo.util.js';
import golden from './__fixtures__/messenger_fanpage.golden.json' with { type: 'json' };
import { MessengerWebhookCommand } from './messenger.command.js';
import {
  KEY_PREFIX,
  MAX_TEXT,
  MessengerService,
  PATH,
  SEND_URL,
  startupError,
  verifySignature,
} from './messenger.service.js';
import { messengerWebhookApp } from './messenger-fanpage.module.js';

// Dịch tests/test_messenger.py + phần messenger của test_v15_p7_jobs.py (30 giây phủ bước gửi),
// test_v15_fix_p81.py (transport thật = provenance live), test_contract_c01_webhook.py (/readyz,
// lỗi cấu hình exit 1). Secret TEST sinh trong test — không Meta thật; HTTP ra Graph là fetch giả.

const PSID = '1234567890123456';
type Call = { url: string; init: RequestInit & { timeoutS?: number } };

function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status });
  };
  return { fn, calls };
}

const sign = (raw: Buffer | string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

function msg(text: string | null = 'Saphraton giá?', mid = 'mid.1', psid = PSID, extra = {}) {
  const m: Record<string, unknown> = { mid, ...extra };
  if (text !== null) m.text = text;
  return { sender: { id: psid }, recipient: { id: 'page1' }, timestamp: 1, message: m };
}
const event = (...msgs: unknown[]) =>
  Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: 'page1', messaging: msgs }] }));

type Ctx = {
  r: Rig;
  m: MessengerService;
  env: Record<string, string>;
  net: ReturnType<typeof fakeFetch>;
};

/** Như fixture `_env` của Python: secret ngẫu nhiên, không page token, không muối, DEPLOY tắt. */
function setup(over: Record<string, string> = {}): Ctx {
  const r = rig();
  const env: Record<string, string> = {
    MESSENGER_APP_SECRET: randomBytes(16).toString('hex'),
    MESSENGER_VERIFY_TOKEN: 'verify-test',
    ...over,
  };
  const n = fakeFetch();
  const m = new MessengerService(r.svc, { env, fetch: n.fn });
  return { r, m, env, net: n };
}

let app: INestApplication | undefined;
let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    logs.push(a.join(' '));
  });
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function start(c: Ctx, o: { rawBody?: boolean; parser?: boolean } = {}): Promise<string> {
  app = await NestFactory.create(
    messengerWebhookApp(null, { zalo: c.r.svc, options: { env: c.env, fetch: c.net.fn } }),
    { bodyParser: o.parser ?? false, rawBody: o.rawBody ?? false, logger: false },
  );
  c.m = app.get(MessengerService); // instance của app (cùng env/fetch/zalo) — để spy được
  await app.listen(0, '127.0.0.1');
  return (await app.getUrl()).replace('[::1]', '127.0.0.1');
}

const post = (base: string, raw: Buffer, headers: Record<string, string> = {}, path = PATH) =>
  fetch(base + path, { method: 'POST', body: raw, headers });

function rawGet(
  base: string,
  path: string,
): Promise<{ status: number; ctype: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(base + path, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            ctype: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      })
      .on('error', reject);
  });
}

/** Raw socket (server đóng sớm — gotcha v0.5.1). → dòng trạng thái. */
function rawExchange(base: string, data: string): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname, () => s.write(data));
    let got = '';
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('\r\n\r\n')) s.end();
    });
    s.on('close', () => resolve(got.split('\r\n')[0] as string));
    s.on('error', (e) => (got ? resolve(got.split('\r\n')[0] as string) : reject(e)));
    s.setTimeout(10_000, () => s.destroy());
  });
}

function spyHandle(m: MessengerService) {
  const got: unknown[][] = [];
  vi.spyOn(m.zalo, 'handleText').mockImplementation(async (...a: unknown[]) => {
    got.push(a);
    return { sent: true, text: '' };
  });
  return got;
}

// ------------------------------------------------------------------ golden Python
describe('golden Python', () => {
  it('verify_signature', () => {
    for (const c of golden.verify) {
      const env = { MESSENGER_APP_SECRET: c.secret };
      expect(verifySignature(Buffer.from(c.raw_hex, 'hex'), c.header, env), c.name).toBe(c.ok);
    }
  });

  it('_startup_error: ma trận DEPLOY × biến thiếu × muối', () => {
    for (const s of golden.startup) {
      const env = Object.fromEntries(Object.entries(s.env).filter(([, v]) => v !== null)) as Record<
        string,
        string
      >;
      expect(startupError(env), JSON.stringify(s.env)).toBe(s.err);
    }
  });

  it('dispatch: tin nào chạy, khóa dedup, thứ tự', () => {
    for (const c of golden.dispatch) {
      const seen = new Set<string>();
      const keys: string[] = [];
      const calls: Record<string, unknown>[] = [];
      const zalo = {
        dedup: (k: string) => {
          keys.push(k);
          if (seen.has(k)) return true;
          seen.add(k);
          return false;
        },
        handleText: (...a: unknown[]) => {
          const [key, text, mid, o] = a as [
            string,
            string,
            string,
            { channel: string; send: unknown },
          ];
          calls.push({
            target: 'handle_text',
            args: [key, text, mid],
            channel: o.channel,
            send_is_live: o.send === m.sendText,
          });
          return Promise.resolve();
        },
      } as unknown as ZaloService;
      const m = new MessengerService(zalo, { env: {} });
      vi.spyOn(m, 'handleNonText').mockImplementation((key) => {
        calls.push({ target: '_non_text', args: [key], channel: null, send_is_live: null });
        return Promise.resolve();
      });
      const n = m.dispatch(c.ev);
      // Python ném (TypeError) giữa chừng → TS log + trả số tin đã khởi chạy trước đó.
      expect(n, c.name).toBe(c.error === null ? c.n : calls.length);
      if (c.error !== null) expect(logs.join('\n')).toContain('bỏ event không hợp lệ (TypeError)');
      expect(calls, c.name).toEqual(c.calls);
      expect(keys, c.name).toEqual(c.dedup);
    }
  });

  it('GET verify / healthz qua server thật (parse_qs, so khớp token, challenge)', async () => {
    const c = setup();
    const base = await start(c);
    for (const g of golden.get_verify) {
      c.env.MESSENGER_VERIFY_TOKEN = (g as { env_token?: string }).env_token ?? 'verify-test';
      const got = await rawGet(base, g.path);
      expect(got.status, g.path).toBe(g.status);
      expect(got.ctype.split(';')[0], g.path).toBe(g.ctype);
      if (g.ctype === 'text/plain') expect(got.body, g.path).toBe(g.body);
      else expect(JSON.parse(got.body), g.path).toEqual(JSON.parse(g.body));
    }
  });
});

// ------------------------------------------------------------------ webhook
describe('webhook POST', () => {
  it('chữ ký hợp lệ → 200 {ok:true}, xử lý qua pipeline Zalo kênh messenger + transport thật', async () => {
    const c = setup();
    const base = await start(c);
    const got = spyHandle(c.m);
    const raw = event(msg());
    const r = await post(base, raw, {
      'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(got.length).toBe(1));
    const [key, text, mid, o] = got[0] as [
      string,
      string,
      string,
      { channel: string; send: unknown },
    ];
    expect([key, text, mid]).toEqual([`messenger:${PSID}`, 'Saphraton giá?', 'mid.1']);
    expect(o.channel).toBe('messenger');
    expect(o.send).toBe(c.m.sendText);
  });

  it.each(['sai', 'thieu', 'sua-1-byte', 'secret-rong', 'secret-khac'])(
    'chữ ký %s → 403, không xử lý, không tới bước dedup',
    async (kase) => {
      const c = setup();
      const base = await start(c);
      const got = spyHandle(c.m);
      let raw = event(msg());
      let headers: Record<string, string> = {
        'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
      };
      if (kase === 'sai') headers['X-Hub-Signature-256'] = `sha256=${'0'.repeat(64)}`;
      else if (kase === 'thieu') headers = {};
      else if (kase === 'sua-1-byte')
        raw = Buffer.from(raw.toString().replace('Saphraton', 'Saphratom'));
      else if (kase === 'secret-rong') c.env.MESSENGER_APP_SECRET = '';
      else headers['X-Hub-Signature-256'] = sign(raw, 'khac-secret');
      const r = await post(base, raw, headers);
      expect(r.status).toBe(403);
      expect(got).toEqual([]);
      expect(existsSync(c.r.svc.seen.path)).toBe(false);
    },
  );

  it('verify_signature: thiếu header / ký tự lạ / không secret → false', () => {
    const raw = Buffer.from('{"object":"page"}');
    const env: Record<string, string> = { MESSENGER_APP_SECRET: 'abc' };
    expect(verifySignature(raw, sign(raw, 'abc'), env)).toBe(true);
    expect(verifySignature(raw, null, env)).toBe(false);
    expect(verifySignature(raw, `sha256=é${'a'.repeat(63)}`, env)).toBe(false);
    expect(verifySignature(raw, sign(raw, ''), {})).toBe(false);
  });

  it('echo bị bỏ; Meta gửi lại cùng mid → 1 lần (dedup sqlite khóa msgr:)', async () => {
    const c = setup();
    const base = await start(c);
    const got = spyHandle(c.m);
    const raw = event(
      msg('echo', 'mid.e', PSID, { is_echo: true }),
      msg('Saphraton giá?', 'mid.dup'),
    );
    const r = await post(base, raw, {
      'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got.map((g) => g[2])).toEqual(['mid.dup']);
    expect(c.m.dispatch(JSON.parse(raw.toString()))).toBe(0);
    expect(got.map((g) => g[2])).toEqual(['mid.dup']);
    c.r.svc.seen.close();
    const db = new DatabaseSync(c.r.svc.seen.path);
    expect(
      db
        .prepare('select event_id from seen')
        .all()
        .map((x) => x.event_id),
    ).toEqual(['msgr:mid.dup']);
    db.close();
  });

  it('tin không phải chữ → NON_TEXT_TEXT qua transport messenger', async () => {
    const c = setup();
    const sent: [string, string][] = [];
    c.m.sendText = (k, t) => {
      sent.push([k, t]);
      return true;
    };
    const n = c.m.dispatch(
      JSON.parse(
        event(msg(null, 'mid.img', PSID, { attachments: [{ type: 'image' }] })).toString(),
      ),
    );
    expect(n).toBe(1);
    await vi.waitFor(() => expect(sent).toEqual([[`messenger:${PSID}`, NON_TEXT_TEXT]]));
  });

  it('DEPLOY tắt: TRỌN pipeline (thường + rượu + sức khỏe) → 0 lời gọi ra Meta, log không psid thô', async () => {
    const c = setup();
    const base = await start(c);
    const raw = event(
      msg('Saphraton giá?', 'mid.a'),
      msg('rượu sâm giá bao nhiêu', 'mid.b'),
      msg('tôi mất ngủ uống gì', 'mid.c'),
    );
    const r = await post(base, raw, {
      'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(c.r.logs().length).toBe(3));
    expect(c.net.calls).toEqual([]);
    expect(c.r.rag.calls.map((x) => x[0])).toEqual(['Saphraton giá?']); // rượu/sức khỏe: 0 answer
    const out = logs.join('\n');
    expect(out.split('[dry-run] messenger: DEPLOY tắt').length - 1).toBe(3);
    expect(out).not.toContain(PSID);
    expect(c.r.logs().every((l) => l.channel === 'messenger' && l.sent === false)).toBe(true);
  });

  it('khung POST: 413 / 411 chunked / 411 thiếu Content-Length / 400 Content-Length âm — không xử lý', async () => {
    const c = setup();
    const base = await start(c);
    const got = spyHandle(c.m);
    c.m.maxBody = 10;
    expect(
      await rawExchange(
        base,
        `POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n${'x'.repeat(100)}`,
      ),
    ).toContain('413');
    expect(
      await rawExchange(
        base,
        `POST ${PATH} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
      ),
    ).toContain('411');
    expect(await rawExchange(base, `POST ${PATH} HTTP/1.1\r\nHost: x\r\n\r\n`)).toContain('411');
    expect(
      await rawExchange(base, `POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n`),
    ).toContain('400');
    expect(got).toEqual([]);
  });

  it('đường lạ 404, JSON hỏng (đã ký đúng) 400, /healthz up', async () => {
    const c = setup();
    const base = await start(c);
    const raw = Buffer.from('{not json');
    const h = { 'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET) };
    expect((await post(base, raw, h, '/khac')).status).toBe(404);
    const r = await post(base, raw, h);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad json' });
    const hz = await fetch(`${base}/healthz`);
    expect([hz.status, await hz.json()]).toEqual([200, { status: 'up' }]);
  });

  it('DEPLOY bật thiếu cấu hình (chạy chung API) → POST 503, không xử lý', async () => {
    const c = setup({ DEPLOY: '1' });
    const base = await start(c);
    const got = spyHandle(c.m);
    const raw = event(msg());
    const r = await post(base, raw, {
      'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
    });
    expect(r.status).toBe(503);
    expect(got).toEqual([]);
    expect(logs.join('\n')).toContain(
      '[fatal] messenger: DEPLOY bật nhưng thiếu MESSENGER_PAGE_TOKEN',
    );
  });

  it('parser JSON của Nest đã đọc body mà không giữ raw → 500 (không verify được chữ ký); rawBody → 200', async () => {
    const c = setup();
    const raw = event(msg());
    const h = {
      'X-Hub-Signature-256': sign(raw, c.env.MESSENGER_APP_SECRET),
      'Content-Type': 'application/json',
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let base = await start(c, { parser: true });
    expect((await post(base, raw, h)).status).toBe(500);
    await app?.close();
    base = await start(c, { parser: true, rawBody: true });
    spyHandle(c.m);
    expect((await post(base, raw, h)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ /readyz
describe('/readyz (C01)', () => {
  async function ready(c: Ctx, query: () => Promise<unknown>) {
    const r = rig();
    const zalo = new ZaloService({ query } as never, r.ch, r.rag, undefined, {
      env: {},
      seenDb: join(r.dir, 'seen.db'),
      convLog: join(r.dir, 'c.jsonl'),
      tokenStore: join(r.dir, 'tok.json'),
    });
    c.r = { ...r, svc: zalo };
    const base = await start(c);
    const res = await fetch(`${base}/readyz`);
    return { status: res.status, body: await res.json() };
  }

  it('cấu hình đủ + DB select 1 → 200; DB lỗi → 503 không lộ chi tiết', async () => {
    const c = setup();
    expect(await ready(c, () => Promise.resolve({ rows: [{}] }))).toEqual({
      status: 200,
      body: { ready: true, checks: { config: 'ok', db: 'ok' } },
    });
    await app?.close();
    const down = await ready(c, () =>
      Promise.reject(new Error('password authentication failed postgres')),
    );
    expect(down).toEqual({
      status: 503,
      body: { ready: false, checks: { config: 'ok', db: 'loi' } },
    });
    expect(JSON.stringify(down)).not.toContain('postgres');
  });

  it('DEPLOY bật thiếu biến → config loi (503); chưa cấu hình DB → chua_cau_hinh', async () => {
    const c = setup({ DEPLOY: '1' });
    expect(await ready(c, () => Promise.resolve({ rows: [{}] }))).toEqual({
      status: 503,
      body: { ready: false, checks: { config: 'loi', db: 'ok' } },
    });
    await app?.close();
    const d = setup();
    const base = await start(d);
    const res = await fetch(`${base}/readyz`);
    expect([res.status, await res.json()]).toEqual([
      503,
      { ready: false, checks: { config: 'ok', db: 'chua_cau_hinh' } },
    ]);
  });
});

// ------------------------------------------------------------------ gửi Graph API
describe('send_text (Graph API)', () => {
  it('DEPLOY bật: token ở header Bearer, KHÔNG trong URL; cắt 2000 ký tự; timeout 5 giây', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
    expect(await c.m.sendText('messenger:42', 'x'.repeat(3000))).toBe(true);
    const [call] = c.net.calls as [Call];
    expect(call.url).toBe(SEND_URL);
    expect(call.url).not.toContain('PAGE-TOKEN-TEST');
    expect(call.url.startsWith('https://graph.facebook.com/')).toBe(true);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer PAGE-TOKEN-TEST',
    );
    const body = JSON.parse(String(call.init.body));
    expect(body.recipient).toEqual({ id: '42' });
    expect(body.messaging_type).toBe('RESPONSE');
    expect([...body.message.text].length).toBe(MAX_TEXT);
    expect(call.init.timeoutS).toBe(5);
    expect(call.init.redirect).toBe('manual');
  });

  it('lỗi gửi → false, không lộ token/psid thô; psid lạ → không gọi', async () => {
    const c = setup({ DEPLOY: 'yes', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
    const bad = new MessengerService(c.r.svc, { env: c.env, fetch: fakeFetch(400).fn });
    expect(await bad.sendText('messenger:42', 'x')).toBe(false);
    const boom = new MessengerService(c.r.svc, {
      env: c.env,
      fetch: () => Promise.reject(new TypeError('PAGE-TOKEN-TEST')),
    });
    expect(await boom.sendText('messenger:42', 'x')).toBe(false);
    expect(await c.m.sendText('messenger:abc', 'x')).toBe(false);
    expect(c.net.calls).toEqual([]);
    const out = logs.join('\n');
    expect(out).not.toContain('PAGE-TOKEN-TEST');
    expect(out).not.toContain('messenger:42');
    expect(out.split('(uh=').length - 1).toBe(3);
    expect(out).toContain('[warn] messenger: send HTTP 400');
  });

  it('3xx không theo redirect → false', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
    const m = new MessengerService(c.r.svc, { env: c.env, fetch: fakeFetch(302).fn });
    expect(await m.sendText('messenger:42', 'x')).toBe(false);
  });

  it('v15.1: timeout gửi = phần còn lại của 30 giây (trần 5 giây); không có hạn chót → 5', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
    const t = 1000;
    vi.spyOn(clock, 'mono').mockReturnValue(t);
    expect(
      await withBudget(t + 3, () => c.m.sendText('messenger:42', 'x') as Promise<boolean>),
    ).toBe(true);
    expect(
      await withBudget(t + 12, () => c.m.sendText('messenger:42', 'x') as Promise<boolean>),
    ).toBe(true);
    expect(await c.m.sendText('messenger:42', 'x')).toBe(true);
    expect(c.net.calls.map((x) => x.init.timeoutS)).toEqual([3, 5, 5]);
  });

  it.each([0.5, 0, -2])(
    'hết ngân sách (còn %s giây) → 0 lời gọi Graph, bước trễ "gui"',
    async (l) => {
      const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
      const t = 1000;
      vi.spyOn(clock, 'mono').mockReturnValue(t);
      const [ok, late] = await withBudget(t + l, async () => {
        const s = await c.m.sendText('messenger:42', 'x');
        return [s, sendLate(s)];
      });
      expect([ok, late]).toEqual([false, 'gui']);
      expect(c.net.calls).toEqual([]);
      const out = logs.join('\n');
      expect(out).toContain('[deadline] messenger');
      expect(out.replaceAll(uhash('messenger:42'), '')).not.toContain('42');
      expect(left()).toBeNull(); // không rò hạn chót ra ngoài lượt
    },
  );

  it('E2E lượt trả lời kênh messenger: xong sát hạn → không gửi, chuyển người lý do deadline', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'PAGE-TOKEN-TEST' });
    c.r.rag.SEND_RESERVE_S = 0.2;
    const t = 5000;
    vi.spyOn(clock, 'mono').mockReturnValue(t);
    const key = `${KEY_PREFIX}${PSID}`;
    let r = await c.r.svc.reply(key, 'Saphraton giá bao nhiêu?', 'mid.p7', {
      channel: 'messenger',
      send: c.m.sendText,
      tRecv: t - 29.5,
    });
    expect(c.net.calls).toEqual([]);
    expect(r.sent).toBe(false);
    expect(c.r.ch.calls.filter((x) => x.fn === 'recordHandoff').map((x) => x.args[1])).toEqual([
      'deadline',
    ]);
    let rec = c.r.logs().at(-1) as Record<string, unknown>;
    expect([rec.channel, rec.error, rec.sent, rec.answered]).toEqual([
      'messenger',
      'deadline:gui',
      false,
      false,
    ]);
    expect(rec.provenance).toBe('live');
    // còn đủ ngân sách (8 giây) → gửi, timeout = min(5, còn lại)
    c.r.ch.calls.length = 0;
    r = await c.r.svc.reply(key, 'Saphraton giá bao nhiêu?', 'mid.p7b', {
      channel: 'messenger',
      send: c.m.sendText,
      tRecv: t - 22,
    });
    expect(r.sent).toBe(true);
    expect(c.r.ch.calls.filter((x) => x.fn === 'recordHandoff')).toEqual([]);
    expect(c.net.calls.map((x) => x.init.timeoutS)).toEqual([5]);
    rec = c.r.logs().at(-1) as Record<string, unknown>;
    expect(rec.error).toBeUndefined();
    expect([rec.provenance, rec.answered, rec.sent]).toEqual(['live', true, true]);
  });

  it('v15 P8.1: chỉ transport THẬT của messenger → provenance live; hàm thay thế → mẫu', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'page-token-gia' });
    await c.r.svc.handleText('messenger:456', 'giá sâm?', 'live-2', {
      channel: 'messenger',
      send: c.m.sendText,
    });
    await c.r.svc.handleText('messenger:457', 'giá sâm?', 'mock-2', {
      channel: 'messenger',
      send: (u, t) => c.m.sendText(u, t),
    });
    expect(c.r.logs().map((l) => [l.msg_id, l.sent, l.provenance])).toEqual([
      ['live-2', true, 'live'],
      ['mock-2', true, 'sample'],
    ]);
  });
});

// ------------------------------------------------------------------ cổng của pipeline qua messenger
describe('pipeline qua messenger: cổng triển khai + guardrail trước nội dung', () => {
  function sentTexts(c: Ctx): string[] {
    return c.net.calls.map((x) => JSON.parse(String(x.init.body)).message.text);
  }

  it('sales-01 TẮT → 0 lời gọi answer(), khách không nhận câu bot', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'page-token-gia' });
    c.r.ch.mode = 'tat';
    await c.r.svc.handleText(`messenger:${PSID}`, 'Saphraton giá?', 'mid.t1', {
      channel: 'messenger',
      send: c.m.sendText,
    });
    expect(c.r.rag.calls).toEqual([]);
    // chưa ghi được cskh_handoff (không muối) → câu hotline, KHÔNG hứa nhân viên phản hồi
    expect(sentTexts(c)).toEqual([NO_HANDOFF_TEXT]);
    expect(c.r.logs().at(-1)?.answered).toBe(false);
  });

  it('chạy thử → câu bot thành gợi ý, khách nhận câu giữ chỗ', async () => {
    const c = setup({ DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'page-token-gia' });
    c.r.ch.mode = 'chay_thu';
    c.r.ch.recordHandoff = () => 7;
    await c.r.svc.handleText(`messenger:${PSID}`, 'Saphraton giá?', 'mid.t2', {
      channel: 'messenger',
      send: c.m.sendText,
    });
    expect(c.r.rag.calls.length).toBe(1);
    expect(sentTexts(c)).toEqual([HOLD_TEXT]);
  });

  it('câu bot vi phạm guardrail ("chữa") → KHÔNG tới khách, gửi câu dự phòng', async () => {
    const r = rig({ answer: () => ({ answer: 'Sâm chữa khỏi bệnh tiểu đường', sources: [] }) });
    const n = fakeFetch();
    const m = new MessengerService(r.svc, {
      env: { DEPLOY: '1', MESSENGER_PAGE_TOKEN: 'page-token-gia' },
      fetch: n.fn,
    });
    await r.svc.handleText(`messenger:${PSID}`, 'Saphraton giá bao nhiêu?', 'mid.g1', {
      channel: 'messenger',
      send: m.sendText,
    });
    const texts = n.calls.map((x) => JSON.parse(String(x.init.body)).message.text as string);
    expect(texts.length).toBe(1);
    expect(texts[0]).not.toContain('chữa');
    expect([FALLBACK, NO_HANDOFF_TEXT]).toContain(texts[0]);
    const rec = r.logs().at(-1) as Record<string, unknown>;
    expect(rec.guardrail_ok).toBe(false);
    expect(String(rec.answer)).not.toContain('chữa');
  });
});

// ------------------------------------------------------------------ lệnh CLI
describe('lệnh messenger-webhook', () => {
  async function runCmd(env: Record<string, string>, stop?: () => Promise<void>) {
    const cmd = new MessengerWebhookCommand();
    cmd.env = env;
    if (stop) cmd.waitStop = stop;
    process.exitCode = undefined;
    await cmd.run();
    const code = process.exitCode;
    process.exitCode = undefined;
    return code;
  }

  const FULL = {
    MESSENGER_APP_SECRET: 's',
    MESSENGER_PAGE_TOKEN: 't',
    MESSENGER_VERIFY_TOKEN: 'v',
    CHANNEL_HASH_SALT: 'test-salt-0123456789abcdef',
  };

  it.each([
    'MESSENGER_APP_SECRET',
    'MESSENGER_PAGE_TOKEN',
    'MESSENGER_VERIFY_TOKEN',
    'CHANNEL_HASH_SALT',
  ])('DEPLOY bật thiếu %s → [fatal] exit 1 (systemd Restart)', async (missing) => {
    expect(startupError({ ...FULL })).toBeNull(); // DEPLOY tắt
    expect(startupError({ ...FULL, DEPLOY: 'true' })).toBeNull();
    const env = { ...FULL, DEPLOY: 'true', [missing]: '' };
    expect(startupError(env)).toContain(missing);
    expect(await runCmd(env)).toBe(1);
    expect(logs.join('\n')).toContain('[fatal]');
  });

  it('muối ngắn → coi như thiếu', () => {
    const err = startupError({ ...FULL, DEPLOY: '1', CHANNEL_HASH_SALT: 'ngan' });
    expect(err).toContain('CHANNEL_HASH_SALT (≥16 ký tự)');
  });

  it('chế độ thực thiếu WEBHOOK_DATABASE_URL → [fatal] messenger: … exit 1', async () => {
    expect(await runCmd({ ...FULL, DEPLOY: '1', AUTH_MODE: 'local', NODE_ENV: 'test' })).toBe(1);
    expect(logs.join('\n')).toMatch(/\[fatal\] messenger: .*WEBHOOK_DATABASE_URL/);
  });

  it('cổng sai → exit 1', async () => {
    expect(await runCmd({ MESSENGER_WEBHOOK_PORT: 'abc' })).toBe(1);
    expect(await runCmd({ MESSENGER_WEBHOOK_PORT: '70000' })).toBe(1);
  });

  it('smoke: lên server, /healthz 200, /readyz 503 (DB chưa cấu hình), dòng trạng thái không lộ secret', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    let release!: () => void;
    const stopped = new Promise<void>((r) => {
      release = r;
    });
    const env = {
      ...FULL,
      MESSENGER_APP_SECRET: 'SECRET-XYZ',
      MESSENGER_WEBHOOK_PORT: String(port),
    };
    const done = runCmd(env, () => stopped);
    await vi.waitFor(() => expect(logs.join('\n')).toContain('[messenger] webhook'), {
      timeout: 15_000,
    });
    const hz = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect([hz.status, await hz.json()]).toEqual([200, { status: 'up' }]);
    const rz = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([rz.status, await rz.json()]).toEqual([
      503,
      { ready: false, checks: { config: 'ok', db: 'chua_cau_hinh' } },
    ]);
    release();
    expect(await done).toBeUndefined();
    const line = logs.find((l) => l.startsWith('[messenger] webhook')) as string;
    expect(line).toBe(
      `[messenger] webhook :${port}/messenger-webhook (app_secret=set, page_token=set, verify_token=set, salt=set, deploy=OFF (dry-run))`,
    );
    expect(logs.join('\n')).not.toContain('SECRET-XYZ');
  });
});

// Convlog của rig phải có câu khách đã che PII — kiểm nhanh không có SĐT thô khi đi qua messenger.
describe('không PII thô', () => {
  it('SĐT trong câu khách không nằm thô trong convlog/log', async () => {
    const c = setup();
    await c.r.svc.handleText(`messenger:${PSID}`, 'gọi tôi 0912345678 nhé', 'mid.pii', {
      channel: 'messenger',
      send: c.m.sendText,
    });
    const file = readFileSync(c.r.svc.convlog.path, 'utf8');
    expect(file).not.toContain('0912345678');
    expect(file).not.toContain(PSID);
    expect(logs.join('\n')).not.toContain(PSID);
  });
});
