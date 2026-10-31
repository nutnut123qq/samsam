import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { nodeTransport, type RawResponse, type Transport } from './intel.js';

// Tiện ích test (không phải file test): http.Server local cổng 0, đồng hồ giả, transport "spy"
// ghi host để chứng minh 0 request tới host bị chặn.

export class Clock {
  now = 0;
  sleeps: number[] = [];
  clock = () => this.now;
  sleep = async (s: number) => {
    this.sleeps.push(s);
    this.now += s;
  };
}

export type Route =
  | [number, Record<string, string>, Buffer | string]
  | ((req: http.IncomingMessage, res: http.ServerResponse) => void);

export class Server {
  hits: string[] = [];
  uas: string[] = [];
  private srv: http.Server;
  port = 0;
  constructor(public routes: Record<string, Route>) {
    this.srv = http.createServer((req, res) => {
      this.hits.push(req.url ?? '');
      this.uas.push(String(req.headers['user-agent'] ?? ''));
      const route = this.routes[req.url ?? ''] ?? [404, {}, 'not found'];
      res.on('error', () => {});
      if (typeof route === 'function') return route(req, res);
      const [st, hdrs, body] = route;
      const b = Buffer.from(body);
      res.writeHead(st, { 'Content-Length': String(b.length), ...hdrs });
      res.end(b);
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((r) => this.srv.listen(0, '127.0.0.1', r));
    this.port = (this.srv.address() as AddressInfo).port;
    return this;
  }
  url(path: string, host = '127.0.0.1'): string {
    return `http://${host}:${this.port}${path}`;
  }
  close(): Promise<void> {
    this.srv.closeAllConnections();
    return new Promise((r) => this.srv.close(() => r()));
  }
}

const servers: Server[] = [];
export async function serve(routes: Record<string, Route>): Promise<Server> {
  const s = await new Server(routes).start();
  servers.push(s);
  return s;
}
/** Đóng mọi server test đã mở (gọi trong afterEach). */
export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((s) => s.close()));
}

export function spyTransport(): Transport & { hosts: string[] } {
  const hosts: string[] = [];
  const t = ((u, h, ms) => {
    hosts.push(u.hostname);
    return nodeTransport(u, h, ms);
  }) as Transport & { hosts: string[] };
  t.hosts = hosts;
  return t;
}

/** Transport GIẢ (như `httpx.MockTransport` của tests/test_pc_a8.py): `host + path` → [status,
 * headers, body], không route → 404. KHÔNG mở socket — dùng cho nguồn có host thật (vd vfa.gov.vn). */
export function mockTransport(
  routes: Record<string, [number, Record<string, string>, Buffer | string]>,
): Transport & { reqs: URL[] } {
  const reqs: URL[] = [];
  const t: Transport = async (u): Promise<RawResponse> => {
    reqs.push(u);
    const [status, hdrs, body] = routes[`${u.hostname}${u.pathname}`] ?? [404, {}, 'not found'];
    const headers = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
    const b = new Uint8Array(Buffer.from(body));
    return {
      status,
      headers,
      body: (async function* () {
        yield b;
      })(),
      close() {},
    };
  };
  return Object.assign(t, { reqs });
}
