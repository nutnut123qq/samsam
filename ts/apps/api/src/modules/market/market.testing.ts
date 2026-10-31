import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { pyJson } from './py-json.js';

// Server HTTP GIẢ cho test nhóm market (Python `tests/test_market_api.py::_Server`): bind 127.0.0.1:0,
// ghi MỌI request (method, path, query, header, body) — không gọi sàn thật, không assert wall-clock.

export type SeenReq = {
  method: string;
  path: string;
  query: Record<string, string[]>;
  rawUrl: string;
  headers: Record<string, string>;
  body: string;
};
export type Reply = [number, unknown, Record<string, string>?];
export type Route = (
  method: string,
  path: string,
  query: Record<string, string[]>,
  body: string,
) => Reply;

export type FakeServer = { url: string; requests: SeenReq[]; close: () => Promise<void> };

const DEFAULT: Route = () => [200, { error: '', code: 0, response: {}, data: {} }];

export async function fakeServer(route: Route = DEFAULT): Promise<FakeServer> {
  const requests: SeenReq[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const query: Record<string, string[]> = {};
      for (const [k, v] of u.searchParams) query[k] = [...(query[k] ?? []), v];
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        path: u.pathname,
        query,
        rawUrl: req.url ?? '',
        headers,
        body,
      });
      let reply: Reply;
      try {
        reply = route(req.method ?? '', u.pathname, query, body);
      } catch {
        reply = [500, { error: 'route lỗi' }];
      }
      const [status, payload, hdrs] = reply;
      const data = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(
            typeof payload === 'string' ? payload : pyJson(payload, { sep: [', ', ': '] }),
          );
      res.writeHead(status, { ...(hdrs ?? {}), 'Content-Length': String(data.length) });
      res.end(data);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

/** Server socket thô trả đúng `payload` rồi đóng (giả response HTTP hỏng — r17 M3). */
export async function rawServer(
  payload: Buffer,
): Promise<{ url: string; close: () => Promise<void> }> {
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    socks.add(s);
    s.on('error', () => {});
    s.once('data', () => {
      s.end(payload);
    });
    s.on('close', () => socks.delete(s));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of socks) s.destroy();
        srv.close(() => r());
      }),
  };
}

export const spOk = (resp: unknown): Reply => [200, { error: '', message: '', response: resp }];
export const ttOk = (data: unknown): Reply => [200, { code: 0, message: 'Success', data }];

/** Đọc tệp chữ UTF-8 (fixture repo). */
export const text = (p: string): string => readFileSync(p, 'utf8');
