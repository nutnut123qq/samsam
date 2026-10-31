import { describe, expect, it } from 'vitest';
import { apiBase, callApi, errorMessage } from './api';

// Client REST phía server Next: fetch GIẢ (0 mạng). Lỗi trả dạng giá trị; KHÔNG lộ chi tiết kết
// nối/DSN cho người dùng; thiếu token → không gọi API.

type Seen = { url: string; init: RequestInit };
function fake(res: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return res();
  }) as unknown as typeof fetch;
  return { seen, f };
}
const env = { API_URL: 'http://api:3001/' };

describe('apiBase', () => {
  it('http(s) bỏ "/" cuối; thiếu/sai giao thức → null', () => {
    expect(apiBase(env)).toBe('http://api:3001');
    expect(apiBase({ API_URL: ' https://x.vn/api// ' })).toBe('https://x.vn/api');
    for (const v of [undefined, '', 'api:3001', 'file:///etc', 'javascript:x']) {
      expect(apiBase({ API_URL: v }), String(v)).toBeNull();
    }
  });
});

describe('errorMessage', () => {
  it('message Nest (chuỗi/mảng) → chuỗi; không có → theo mã HTTP', () => {
    expect(errorMessage(400, { message: 'cần sku' })).toBe('cần sku');
    expect(errorMessage(400, { message: ['a', 'b'] })).toBe('a; b');
    expect(errorMessage(401, null)).toBe('Phiên đăng nhập hết hạn — đăng nhập lại.');
    expect(errorMessage(403, {})).toBe('Vai trò không có quyền truy cập mục này.');
    expect(errorMessage(500, { message: 5 })).toBe('API lỗi (HTTP 500).');
    expect(errorMessage(409, { message: 'x'.repeat(900) })).toHaveLength(500);
  });
});

describe('callApi', () => {
  it('gắn Bearer + JSON body, no-store; 2xx → data', async () => {
    const { seen, f } = fake(() => Response.json({ tabs: ['Leads'] }));
    const r = await callApi('/me', { token: 'T', env, fetchImpl: f });
    expect(r).toEqual({ ok: true, data: { tabs: ['Leads'] } });
    expect(seen[0].url).toBe('http://api:3001/me');
    expect(seen[0].init.headers).toEqual({ Authorization: 'Bearer T' });
    expect(seen[0].init.cache).toBe('no-store');
    const p = fake(() => Response.json({ ok: 1 }));
    await callApi('/chat', { method: 'POST', body: { q: 'á' }, token: 'T', env, fetchImpl: p.f });
    expect(p.seen[0].init).toMatchObject({
      method: 'POST',
      body: '{"q":"á"}',
      headers: { Authorization: 'Bearer T', 'Content-Type': 'application/json' },
    });
  });

  it('thiếu token → 401 không gọi API; thiếu API_URL → 503', async () => {
    const { seen, f } = fake(() => Response.json({}));
    expect(await callApi('/me', { token: null, env, fetchImpl: f })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await callApi('/me', { token: 'T', env: {}, fetchImpl: f })).toEqual({
      ok: false,
      status: 503,
      message: 'API chưa cấu hình (API_URL).',
    });
    expect(seen).toEqual([]);
  });

  it('lỗi HTTP → message của API; lỗi mạng/quá hạn/thân hỏng → câu chung, không lộ chi tiết', async () => {
    const err = fake(() =>
      Response.json({ message: 'vai trò không có tab Leads' }, { status: 403 }),
    );
    expect(await callApi('/leads', { token: 'T', env, fetchImpl: err.f })).toEqual({
      ok: false,
      status: 403,
      message: 'vai trò không có tab Leads',
    });
    const net = fake(() => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.5:3001 postgresql://u:p@db/samsam');
    });
    const n = await callApi('/me', { token: 'T', env, fetchImpl: net.f });
    expect(n).toEqual({ ok: false, status: 502, message: 'Không kết nối được API — thử lại.' });
    const slow = fake(() => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    expect(await callApi('/me', { token: 'T', env, fetchImpl: slow.f })).toMatchObject({
      status: 504,
    });
    const junk = fake(() => new Response('<html>', { status: 200 }));
    expect(await callApi('/me', { token: 'T', env, fetchImpl: junk.f })).toMatchObject({
      ok: false,
      status: 502,
    });
    const html500 = fake(() => new Response('Internal error at /srv/api', { status: 500 }));
    expect(await callApi('/me', { token: 'T', env, fetchImpl: html500.f })).toEqual({
      ok: false,
      status: 500,
      message: 'API lỗi (HTTP 500).',
    });
  });
});
