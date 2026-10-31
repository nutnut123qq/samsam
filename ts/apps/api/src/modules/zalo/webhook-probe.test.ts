import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import golden from './__fixtures__/preflight.golden.json' with { type: 'json' };
import { defaultUrls, probe, probeMain } from './webhook-probe.js';

// Dịch tests/test_contract_c01_webhook.py (probe), test_r17_cong_tat.py M3 (lỗi http.client),
// test_r18_nguon_hong.py M2 (thân 200 không phải object). Server giả tại chỗ, không mạng ngoài.

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});

async function httpSrv(status: number, body: string): Promise<string> {
  const s = http.createServer((_q, res) => {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/readyz`;
}

/** Server socket thô trả đúng `payload` rồi đóng (Gotcha AGENTS.md: response hỏng). */
async function rawSrv(payload: Buffer): Promise<string> {
  const s = net.createServer((c) => {
    c.once('data', () => c.end(payload));
    c.on('error', () => {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/readyz`;
}

const http200 = (body: string) =>
  Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

describe('probe', () => {
  it('default_urls (golden)', () => {
    for (const c of golden.default_urls) expect(defaultUrls(c.env)).toEqual(c.urls);
  });

  it('200 ready / 503 / 302 (không theo redirect) / cổng chết', async () => {
    expect(await probe(await httpSrv(200, '{"ready": true}'))).toEqual([true, 'HTTP 200']);
    expect((await probe(await httpSrv(503, '{"ready": false}')))[0]).toBe(false);
    expect(await probe(await httpSrv(302, '{}'))).toEqual([false, 'HTTP 302']);
    expect(await probe(`http://127.0.0.1:${await freePort()}/readyz`)).toEqual([false, 'URLError']);
  });

  it.each([
    ['[1]', [false, 'HTTP 200']],
    ['"ready"', [false, 'HTTP 200']],
    ['null', [false, 'HTTP 200']],
    ['5', [false, 'HTTP 200']],
    ['', [false, 'HTTP 200']], // thân rỗng → {} → không ready
    ['{"ready": "true"}', [false, 'HTTP 200']],
    ['['.repeat(2000), [false, 'JSONDecodeError']],
    ['['.repeat(4096), [false, 'JSONDecodeError']],
    ['{"ready": true}', [true, 'HTTP 200']],
  ])('r18: thân %s', async (body, want) => {
    expect(await probe(await rawSrv(http200(body)))).toEqual(want);
  });

  it.each([
    [Buffer.from('GARBAGE NOT HTTP\r\n\r\n'), 'BadStatusLine'],
    [
      Buffer.from(
        `HTTP/1.1 200 OK\r\n${Array.from({ length: 150 }, (_, i) => `X-H${i}: v\r\n`).join('')}Content-Length: 2\r\n\r\n{}`,
      ),
      'HTTPException', // > 100 header như http.client
    ],
    [Buffer.from(`HTTP/1.1 200 OK\r\nX-Long: ${'a'.repeat(70000)}\r\n\r\n`), 'LineTooLong'],
  ])('r17: response hỏng → không sẵn sàng (%#)', async (payload, name) => {
    expect(await probe(await rawSrv(payload))).toEqual([false, name]);
  });

  it('URL lạ → không sẵn sàng, không ném', async () => {
    expect((await probe('not a url'))[0]).toBe(false);
    expect((await probe('ftp://127.0.0.1/readyz'))[0]).toBe(false);
  });
});

describe('probeMain', () => {
  it('mọi URL sẵn sàng → 0, không đụng DB', async () => {
    const connect = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await probeMain({ url: [await httpSrv(200, '{"ready": true}')] }, { connect })).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toMatch(
      /^\[ok\] http:\/\/127\.0\.0\.1:\d+\/readyz — HTTP 200$/,
    );
  });

  it('--dry-run có URL lỗi → 1, không ghi DB; DB không kết nối được → 1 + thông báo', async () => {
    const connect = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await rawSrv(http200('[1]'));
    expect(await probeMain({ url: [bad], dryRun: true }, { connect })).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await probeMain({ url: [bad] }, { connect: down as never })).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'không kết nối được DB — chưa ghi cảnh báo đỏ',
    );
  });

  it('mặc định dò 2 cổng Zalo/Messenger theo env', async () => {
    const seen: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await probeMain(
      { dryRun: true },
      {
        env: { ZALO_WEBHOOK_PORT: '9000' },
        probe: async (u) => {
          seen.push(u);
          return [true, 'HTTP 200'];
        },
      },
    );
    expect(seen).toEqual(['http://127.0.0.1:9000/readyz', 'http://127.0.0.1:8789/readyz']);
  });
});
