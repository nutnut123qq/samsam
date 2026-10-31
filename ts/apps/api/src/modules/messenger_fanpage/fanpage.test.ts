import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import golden from './__fixtures__/messenger_fanpage.golden.json' with { type: 'json' };
import {
  config,
  DEFAULT_BASE,
  ENV_BASE,
  ENV_PAGE,
  ENV_TOKEN,
  explain,
  type FanpageConfig,
  FanpageConfigError,
  FanpageError,
  fetchPosts,
  graphError,
  MAX_PAGES,
  postUrl,
  RETRY_MAX,
  settings,
} from './fanpage.js';

// Dịch phần `connectors.fanpage` của tests/test_r16_fanpage.py (Graph API chỉ đọc): server giả
// 127.0.0.1 ĐẾM request — không gọi Graph thật (CONTRACT_TESTED theo tài liệu v26.0). Phần
// `ra_kenh.fanpage_rows/ingest` (cổng legal_hr-04 TẮT → 0 request, ticket, kế thừa snapshot người)
// thuộc nhóm port agents/ra_kenh.py.

const TOKEN = 'FBTOKEN_SECRET_r16xyz';
const PAGE = '1234567890';
const POST_PATH = `/v26.0/${PAGE}/published_posts`;

type Req = { method: string; path: string; query: URLSearchParams };
type Reply = [number, unknown, Record<string, string>?];
type Srv = { url: string; requests: Req[]; close: () => Promise<void> };

const servers: Srv[] = [];
async function server(handler: (r: Req) => Reply = () => [200, {}]): Promise<Srv> {
  const requests: Req[] = [];
  const s = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const r = { method: req.method ?? '', path: u.pathname, query: u.searchParams };
    requests.push(r);
    const [status, body, headers] = handler(r);
    const raw =
      Buffer.isBuffer(body) || typeof body === 'string'
        ? Buffer.from(body)
        : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(raw);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const srv: Srv = {
    url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
    requests,
    close: () => new Promise((r) => s.close(() => r())),
  };
  servers.push(srv);
  return srv;
}

/** Server socket thô (lỗi tầng HTTP không giả được bằng http.createServer). */
async function rawServer(payload: Buffer): Promise<Srv> {
  const s = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => c.end(payload));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const srv: Srv = {
    url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
    requests: [],
    close: () => new Promise((r) => s.close(() => r())),
  };
  servers.push(srv);
  return srv;
}

const post = (i: number, text = 'Sâm Sâm ra mắt hộp quà Tết mới.') => ({
  id: `${PAGE}_${i}`,
  message: text,
  created_time: '2026-10-20T03:00:00+0000',
  permalink_url: `https://www.facebook.com/${PAGE}/posts/${i}`,
});

function page(data: unknown[], after?: string) {
  const doc: Record<string, unknown> = { data };
  if (after) {
    doc.paging = {
      cursors: { before: 'B', after },
      next: `https://graph.facebook.com/v26.0/x?after=${after}`,
    };
  }
  return doc;
}

const pages = (...docs: Reply[]) => {
  let i = 0;
  return () => docs[i++] as Reply;
};

const cfg = (base: string): FanpageConfig =>
  config({ [ENV_PAGE]: PAGE, [ENV_TOKEN]: TOKEN, [ENV_BASE]: base }) as FanpageConfig;

let out: string[] = [];
beforeEach(() => {
  settings.sleep = async () => {};
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    out.push(a.join(' '));
  });
});
afterEach(async () => {
  settings.maxPages = MAX_PAGES;
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function fails(c: FanpageConfig): Promise<string> {
  try {
    await fetchPosts(c);
  } catch (e) {
    expect(e).toBeInstanceOf(FanpageError);
    return (e as Error).message;
  }
  throw new Error('fetchPosts không ném');
}

// ------------------------------------------------------------------ golden Python
describe('golden Python', () => {
  it('post_url', () => {
    for (const c of golden.post_url) {
      const v = 'cps' in c ? String.fromCodePoint(...(c.cps as number[])) : c.v;
      expect(postUrl(v) === v && postUrl(v) !== null, JSON.stringify(c)).toBe(c.ok);
    }
  });

  it('api_base (qua config): base hợp lệ / thông điệp lỗi chỉ nêu TÊN biến', () => {
    for (const c of golden.api_base) {
      const env: Record<string, string> = { [ENV_PAGE]: '123', [ENV_TOKEN]: 'TOKEN_ABCDEFGH' };
      if (c.base !== null) env[ENV_BASE] = c.base;
      let got: { ok: string | null; err: string | null };
      try {
        got = { ok: config(env)?.base ?? null, err: null };
      } catch (e) {
        expect(e).toBeInstanceOf(FanpageConfigError);
        got = { ok: null, err: (e as Error).message };
      }
      expect(got, String(c.base)).toEqual({ ok: c.ok, err: c.err });
    }
  });

  it('config: chưa cấu hình → null; dở/sai dạng → lỗi nêu tên biến', () => {
    for (const c of golden.config) {
      const env: Record<string, string> = {};
      if (c.page !== null) env[ENV_PAGE] = c.page;
      if (c.token !== null) env[ENV_TOKEN] = c.token;
      let got: unknown;
      try {
        const r = config(env);
        got = r && { page_id: r.pageId, token: r.token, base: r.base };
      } catch (e) {
        got = (e as Error).message;
      }
      expect(got, JSON.stringify(c)).toEqual(c.err ?? c.cfg);
    }
  });

  it('_graph_error: chỉ mã NGUYÊN 0..10^7 (không bool/float), thân hỏng → [null, null]', () => {
    for (const c of golden.graph_error) {
      expect(graphError(Buffer.from(c.hex, 'hex')), c.hex).toEqual(c.out);
    }
  });

  it('_explain', () => {
    for (const c of golden.explain) {
      expect(explain(c.status, c.code, c.sub), JSON.stringify(c)).toBe(c.out);
    }
  });
});

// ------------------------------------------------------------------ HTTP (server giả)
describe('fetchPosts', () => {
  it('phân trang tới khi KHÔNG còn next; trang rỗng không phải hết; chỉ GET', async () => {
    const s = await server(
      pages([200, page([post(1)], 'A1')], [200, page([], 'A2')], [200, page([post(2), 'x', 5])]),
    );
    const posts = await fetchPosts(cfg(s.url));
    expect(posts.map((p) => p.id)).toEqual([`${PAGE}_1`, `${PAGE}_2`]);
    expect(s.requests.map((r) => r.path)).toEqual([POST_PATH, POST_PATH, POST_PATH]);
    const q = s.requests[0]?.query as URLSearchParams;
    expect(q.getAll('fields')).toEqual(['id,message,created_time,permalink_url']);
    expect(q.getAll('limit')).toEqual(['100']);
    expect(q.getAll('access_token')).toEqual([TOKEN]);
    expect(q.has('after')).toBe(false);
    expect(s.requests.slice(1).map((r) => r.query.getAll('after'))).toEqual([['A1'], ['A2']]);
    expect(new Set(s.requests.map((r) => r.method))).toEqual(new Set(['GET']));
  });

  it('mã tạm thời / 503 → thử lại rồi được; log không có token', async () => {
    const s = await server(
      pages([400, { error: { code: 4, message: TOKEN } }], [503, 'down'], [200, page([post(1)])]),
    );
    expect((await fetchPosts(cfg(s.url))).length).toBe(1);
    expect(s.requests.length).toBe(3);
    expect(out).toEqual([
      '[retry] fanpage: HTTP 400 mã 4 — chờ 1s (1/3)',
      '[retry] fanpage: HTTP 503 — chờ 2s (2/3)',
    ]);
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it.each([
    [190, null, 'Bên B cấp lại'],
    [102, null, 'Bên B cấp lại'],
    [100, 463, 'Bên B cấp lại'],
    [10, null, 'thiếu quyền'],
    [200, null, 'thiếu quyền'],
  ])(
    'lỗi token/quyền %s/%s → không thử lại; thông điệp không lộ token/host/message',
    async (code, sub, want) => {
      const err: Record<string, unknown> = { code, message: `bad ${TOKEN}`, fbtrace_id: 'T' };
      if (sub) err.error_subcode = sub;
      const s = await server(() => [400, { error: err }]);
      const msg = await fails(cfg(s.url));
      expect(msg).toContain(want);
      expect(msg).toContain(`mã ${code}`);
      for (const leak of [TOKEN, '127.0.0.1', 'bad']) expect(msg).not.toContain(leak);
      expect(s.requests.length).toBe(1);
    },
  );

  it('hết lượt thử lại → "sau 4 lần"', async () => {
    const s = await server(() => [400, { error: { code: 17 } }]);
    expect(await fails(cfg(s.url))).toBe('fanpage: HTTP 400 mã 17 sau 4 lần');
    expect(s.requests.length).toBe(RETRY_MAX + 1);
  });

  it('KHÔNG theo redirect (chống lộ token sang host khác)', async () => {
    const other = await server();
    const s = await server(() => [302, '', { Location: `${other.url}/steal` }]);
    expect(await fails(cfg(s.url))).toBe('fanpage: HTTP 302');
    expect(other.requests).toEqual([]);
  });

  it('2xx khác 200 → lỗi', async () => {
    const s = await server(() => [204, '']);
    expect(await fails(cfg(s.url))).toBe('fanpage: HTTP 204');
  });

  it.each([
    ['not json', 'fanpage: JSON hỏng'],
    [[1], 'fanpage: response thiếu mảng data'],
    [{ data: 'x' }, 'fanpage: response thiếu mảng data'],
    [{ data: [], paging: { next: 'u' } }, 'fanpage: có trang sau nhưng thiếu/sai cursor'],
    [
      { data: [], paging: { next: 'u', cursors: { after: 'a b' } } },
      'fanpage: có trang sau nhưng thiếu/sai cursor',
    ],
    ['{"data": [], "x": NaN}', 'fanpage: JSON hỏng'],
  ])('response sai dạng %j → FanpageError', async (doc, want) => {
    const s = await server(() => [200, doc]);
    expect(await fails(cfg(s.url))).toBe(want);
  });

  it('response quá trần byte → lỗi (không nạp)', async () => {
    const big = `{"data": [], "pad": "${'x'.repeat(5 * 1024 * 1024)}"}`;
    const s = await server(() => [200, big]);
    expect(await fails(cfg(s.url))).toBe('fanpage: response quá trần byte');
  });

  it('vượt MAX_PAGES → lỗi, không trả nửa vời', async () => {
    settings.maxPages = 2;
    const s = await server(() => [200, page([post(1)], 'A')]);
    expect(await fails(cfg(s.url))).toBe('fanpage: vượt 2 trang — không nạp nửa vời');
    expect(s.requests.length).toBe(2);
  });

  it('lỗi mạng: không kết nối được → "lỗi mạng", không lộ URL/token', async () => {
    const s = await server();
    const c = cfg(s.url);
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    const msg = await fails(c);
    expect(msg).toBe('fanpage: lỗi mạng (URLError)');
  });

  // http.client của Python ↔ undici của Node: cùng ý nghĩa "lỗi có kiểm soát, không traceback,
  // không lộ token/host". KHÁC đã biết (không phải luật nghiệp vụ): Python từ chối > 100 header
  // (HTTPException), undici chỉ giới hạn tổng cỡ header → 150 header nhỏ vẫn đọc được.
  it.each([
    [
      'cut',
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"data": [',
      'fanpage: JSON hỏng',
    ],
    ['status', 'GARBAGE NOT HTTP\r\n\r\n', 'fanpage: lỗi mạng (BadStatusLine)'],
    [
      'line',
      `HTTP/1.1 200 OK\r\nX-Long: ${'a'.repeat(70000)}\r\n\r\n`,
      'fanpage: lỗi mạng (LineTooLong)',
    ],
  ])('lỗi tầng HTTP (%s) → FanpageError', async (_name, payload, want) => {
    const s = await rawServer(Buffer.from(payload, 'latin1'));
    const msg = await fails(cfg(s.url));
    expect(msg).toBe(want);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain('127.0.0.1');
  });

  it('150 header (Python: HTTPException) — undici đọc được: trang rỗng hợp lệ', async () => {
    const hdr = Array.from({ length: 150 }, (_, i) => `X-H${i}: v\r\n`).join('');
    const s = await rawServer(
      Buffer.from(`HTTP/1.1 200 OK\r\n${hdr}Content-Length: 11\r\n\r\n{"data":[]}`),
    );
    expect(await fetchPosts(cfg(s.url))).toEqual([]);
  });
});

describe('config / post_url (ca của test Python)', () => {
  it('config', () => {
    expect(config({})).toBeNull();
    expect(() => config({ [ENV_PAGE]: PAGE })).toThrow(ENV_TOKEN);
    expect(config({ [ENV_PAGE]: PAGE, [ENV_TOKEN]: TOKEN })?.base).toBe(DEFAULT_BASE);
    expect(() => config({ [ENV_PAGE]: 'me', [ENV_TOKEN]: TOKEN })).toThrow(ENV_PAGE);
    expect(() =>
      config({ [ENV_PAGE]: PAGE, [ENV_TOKEN]: TOKEN, [ENV_BASE]: 'http://evil.example' }),
    ).toThrow(ENV_BASE);
    // thông điệp không mang giá trị token
    try {
      config({ [ENV_PAGE]: 'x', [ENV_TOKEN]: TOKEN });
    } catch (e) {
      expect((e as Error).message).not.toContain(TOKEN);
    }
  });

  it('post_url', () => {
    expect(postUrl('https://www.facebook.com/1/posts/2')).toBeTruthy();
    expect(postUrl('https://m.facebook.com/x')).toBeTruthy();
    for (const bad of [
      'http://www.facebook.com/x',
      'https://evilfacebook.com/x',
      'https://facebook.com.evil.example/x',
      'javascript:x',
      null,
      'https://u:p@www.facebook.com/x',
      5,
    ]) {
      expect(postUrl(bad), String(bad)).toBeNull();
    }
  });
});
