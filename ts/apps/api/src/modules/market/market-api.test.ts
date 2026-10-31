import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '@samsam/core/env';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiOpts,
  type CmdDeps,
  marketApiMain,
  type SettlementHooks,
} from './market.command.js';
import {
  type FakeServer,
  fakeServer,
  type Route,
  rawServer,
  spOk,
  ttOk,
} from './market.testing.js';
import {
  ALLOWED,
  ApiError,
  AUTH_ALLOWED,
  apiBase,
  ConfigError,
  type Creds,
  DataError,
  doRefresh,
  errCode,
  fetchRows,
  fileLock,
  hooks,
  KEYS,
  LIMITS,
  loadStatusMap,
  type Params,
  RETRY_MAX,
  RETRY_WAIT_MAX,
  refreshToken,
  request,
  rowsSha256,
  ScopeError,
  SP_AUTH_REFRESH,
  SP_ITEM_INFO,
  SP_ITEM_LIST,
  SP_ITEM_STATUSES,
  SP_MODEL_LIST,
  SP_ORDER_DETAIL,
  SP_ORDER_LIST,
  send,
  signShopee,
  signTiktok,
  TT_AUTH_REFRESH,
  TT_ORDER_SEARCH,
  TT_PRODUCT_SEARCH,
  tokenLockPath,
} from './market-api.js';
import { loadMapping, type Mapping, readExport } from './market-csv.js';

// Dịch tests/test_market_api.py (scope/ký/HTTP/chuẩn hóa/CLI không DB), r13 (thử lại 429/5xx),
// r14 (refresh token + kho ngoài repo + khóa), r15 (tham số --kind settlement), r17 (lỗi http.client →
// ApiError). Mạng: server GIẢ 127.0.0.1:0 đếm request — không gọi sàn thật, không assert wall-clock.

const CREDS: Creds = {
  SHOPEE_PARTNER_ID: '1000001',
  SHOPEE_PARTNER_KEY: 'SPKEY_SECRET_XYZ',
  SHOPEE_SHOP_ID: '2000002',
  SHOPEE_ACCESS_TOKEN: 'SPTOKEN_SECRET_ABC',
  TIKTOK_APP_KEY: 'ttappkey01',
  TIKTOK_APP_SECRET: 'TTSECRET_SECRET_QQ',
  TIKTOK_SHOP_CIPHER: 'ROW_cipher01',
  TIKTOK_ACCESS_TOKEN: 'TTTOKEN_SECRET_WW',
};
const PII = ['NGUOI MUA GIA', '0900000000', 'DIA CHI GIA 1', 'nguoimuagia', 'buyer@gia.example'];
const SRC = readFileSync(new URL('./market-api.ts', import.meta.url), 'utf8');
const TMP = mkdtempSync(join(tmpdir(), 'market-api-'));
const SMAP = loadStatusMap();
const MAP = loadMapping()[0] as Mapping;

let servers: FakeServer[] = [];
const server = async (route?: Route) => {
  const s = await fakeServer(route);
  servers.push(s);
  return s;
};
const savedLimits = { ...LIMITS };
const savedHooks = { ...hooks };
beforeEach(() => {
  settings.forceMode = 'van_hanh';
});
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
  Object.assign(LIMITS, savedLimits);
  Object.assign(hooks, savedHooks);
  settings.forceMode = null;
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const call =
  (s: FakeServer, ch: string) =>
  (m: string, p: string, params: Params, body?: Record<string, unknown> | null) =>
    request(ch, m, p, params, body ?? null, { creds: CREDS, base: s.url });
const errOf = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('không ném lỗi');
};

// ---------------------------------------------------------------- (1) scope

describe('allowlist chỉ đọc', () => {
  it.each([
    ['shopee', 'POST', '/api/v2/product/update_price'],
    ['shopee', 'GET', '/api/v2/product/update_item'],
    ['tiktok', 'POST', '/product/202309/products/123/prices/update'],
    ['shopee', 'DELETE', SP_ITEM_LIST],
    ['shopee', 'POST', SP_ITEM_LIST],
    ['tiktok', 'GET', TT_ORDER_SEARCH],
    ['lazada', 'GET', SP_ITEM_LIST],
  ])('%s %s %s → ScopeError, 0 request', async (ch, m, p) => {
    const s = await server();
    const e = await errOf(request(ch, m, p, { price: 1 }, { x: 1 }, { creds: CREDS, base: s.url }));
    expect(e).toBeInstanceOf(ScopeError);
    expect(e.message).toContain('allowlist');
    expect(s.requests).toEqual([]);
  });

  it('kiểm ĐẦU TIÊN — trước cả thiếu key / base sai', async () => {
    const env: Env = { SHOPEE_API_BASE: 'http://evil.example' };
    const e = await errOf(
      request('shopee', 'POST', '/api/v2/product/update_price', {}, null, { env }),
    );
    expect(e).toBeInstanceOf(ScopeError);
  });

  it('mọi literal endpoint trong mã nằm trong allowlist; allowlist không có đường ghi', () => {
    const paths = new Set([...ALLOWED].map((k) => k.split(' ')[2] as string));
    const auth = new Set([...AUTH_ALLOWED].map((k) => k.split(' ')[2] as string));
    expect(AUTH_ALLOWED.size).toBe(2);
    for (const p of auth) expect(p).toContain('token');
    const lits = [...SRC.matchAll(/'(\/(?:api\/v2|product|order|finance)\/[^']*)'/g)].map(
      (m) => m[1],
    );
    expect(lits.length).toBeGreaterThanOrEqual(11);
    for (const l of lits) expect(paths.has(l as string) || auth.has(l as string), l).toBe(true);
    const WRITE =
      /update|add|delete|create|cancel|ship|set_|edit|reply|unlist|boost|split|handle|upload/i;
    expect([...paths].filter((p) => WRITE.test(p))).toEqual([]);
    expect(ALLOWED.size).toBe(11);
    const rows = [...ALLOWED].map((k) => k.split(' ') as [string, string, string]);
    expect(new Set(rows.map((r) => r[1]))).toEqual(new Set(['GET', 'POST']));
    for (const [c, m, p] of rows) {
      if (c === 'shopee') expect(m).toBe('GET');
      else
        expect(
          (m === 'POST' && p.endsWith('/search')) || (m === 'GET' && p.startsWith('/finance/')),
        ).toBe(true);
    }
  });

  it('không dùng HTTP client bên thứ ba / fetch toàn cục (chỉ node:http/https)', () => {
    expect(SRC).not.toMatch(/from '(axios|undici|node-fetch|got|superagent)'/);
    expect(SRC).not.toMatch(/(?<![\w.])fetch\(/);
  });
});

// ---------------------------------------------------------------- (3) ký

describe('chữ ký', () => {
  it('vector độc lập (HMAC-SHA256 tự tính)', () => {
    const exp = createHmac('sha256', 'key123')
      .update('1000001/api/v2/shop/get_shop_info1700000000tok2000002')
      .digest('hex');
    expect(
      signShopee('key123', '1000001', '/api/v2/shop/get_shop_info', 1700000000, 'tok', '2000002'),
    ).toBe(exp);
    const q = {
      timestamp: '1700000000',
      app_key: 'ak',
      shop_cipher: 'c1',
      sign: 'IGNORED',
      access_token: 'IGNORED',
      page_size: '10',
    };
    const base =
      'sec/order/202309/orders/searchapp_keyakpage_size10shop_cipherc1timestamp1700000000{"a":1}sec';
    expect(signTiktok('sec', '/order/202309/orders/search', q, '{"a":1}')).toBe(
      createHmac('sha256', 'sec').update(base).digest('hex'),
    );
  });

  it('server nhận chữ ký hợp lệ; khóa bí mật không bao giờ lên dây', async () => {
    const absent = (r: FakeServer['requests'][number]) => {
      const blob = r.rawUrl + JSON.stringify(r.headers) + r.body;
      return !blob.includes('SPKEY_SECRET_XYZ') && !blob.includes('TTSECRET_SECRET_QQ');
    };
    const s = await server(() => spOk({ item: [], has_next_page: false }));
    await request('shopee', 'GET', SP_ITEM_LIST, { offset: 0 }, null, {
      creds: CREDS,
      base: s.url,
      timestamp: 1700000000,
    });
    const r = s.requests[0] as FakeServer['requests'][number];
    const q = Object.fromEntries(Object.entries(r.query).map(([k, v]) => [k, v[0] as string]));
    expect(q.sign).toBe(
      signShopee(
        CREDS.SHOPEE_PARTNER_KEY as string,
        q.partner_id as string,
        r.path,
        Number(q.timestamp),
        q.access_token as string,
        q.shop_id as string,
      ),
    );
    expect(q.timestamp).toBe('1700000000');
    expect(absent(r)).toBe(true);

    const t = await server(() => ttOk({ products: [] }));
    await request(
      'tiktok',
      'POST',
      TT_PRODUCT_SEARCH,
      { page_size: 5 },
      { status: 'ALL' },
      {
        creds: CREDS,
        base: t.url,
      },
    );
    const r2 = t.requests[0] as FakeServer['requests'][number];
    const q2 = Object.fromEntries(Object.entries(r2.query).map(([k, v]) => [k, v[0] as string]));
    expect(q2.sign).toBe(signTiktok(CREDS.TIKTOK_APP_SECRET as string, r2.path, q2, r2.body));
    expect(r2.headers['x-tts-access-token']).toBe('TTTOKEN_SECRET_WW');
    expect(r2.rawUrl).not.toContain('TTTOKEN_SECRET_WW');
    expect(r2.method).toBe('POST');
    expect(absent(r2)).toBe(true);
  });

  it('dây như urllib: POST có Content-Length (không chunked), Accept-Encoding identity — TikTok search + Shopee refresh', async () => {
    // server kiểu Python BaseHTTPRequestHandler chỉ đọc body theo Content-Length
    const t = await server(() => ttOk({ orders: [] }));
    await request(
      'tiktok',
      'POST',
      TT_ORDER_SEARCH,
      { page_size: 5 },
      { status: 'ALL' },
      {
        creds: CREDS,
        base: t.url,
      },
    );
    const s = await server(() => [
      200,
      {
        error: '',
        access_token: 'A2_SECRET_ACCESS_TOKEN',
        refresh_token: 'R2_SECRET_NEW',
        expire_in: 14400,
      },
    ]);
    await refreshToken('shopee', CREDS, 'R1_SECRET_OLD_TOKEN', s.url);
    const g = await server(() => spOk({ item: [], has_next_page: false }));
    await request('shopee', 'GET', SP_ITEM_LIST, { offset: 0 }, null, {
      creds: CREDS,
      base: g.url,
    });
    for (const r of [t.requests[0], s.requests[0]] as FakeServer['requests']) {
      expect(r.method).toBe('POST');
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.headers['transfer-encoding']).toBeUndefined();
      expect(r.headers['content-length']).toBe(String(Buffer.byteLength(r.body)));
      expect(r.headers['accept-encoding']).toBe('identity');
    }
    // GET không body: urllib không gửi Content-Length
    const rg = g.requests[0] as FakeServer['requests'][number];
    expect(rg.headers['content-length']).toBeUndefined();
    expect(rg.headers['transfer-encoding']).toBeUndefined();
    expect(rg.headers['accept-encoding']).toBe('identity');
  });
});

// ---------------------------------------------------------------- (4) HTTP

describe('HTTP', () => {
  it('không theo redirect (3xx = lỗi, không lộ token sang host khác)', async () => {
    const target = await server();
    const src = await server(() => [302, Buffer.alloc(0), { Location: `${target.url}/steal` }]);
    const e = await errOf(
      request('shopee', 'GET', SP_ITEM_LIST, {}, null, { creds: CREDS, base: src.url }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain('HTTP 302');
    expect(src.requests).toHaveLength(1);
    expect(target.requests).toEqual([]);
    expect(e.message).not.toContain('SPTOKEN');
  });

  it.each([
    [200, `{"error": "", "response": {"pad": "${'B'.repeat(400)}"}}`],
    [200, '{"error": "", "response": BODYMARK'],
    [200, '{"error": "error_auth", "message": "BODYMARK leak"}'],
    [500, '{"error": "BODYMARK"}'],
    [200, '["BODYMARK"]'],
  ])('lỗi API %# không bao giờ in body/URL/token', async (status, payload) => {
    LIMITS.maxRespBytes = 200;
    hooks.sleep = async () => {};
    hooks.log = () => {};
    const s = await server(() => [status, Buffer.from(payload)]);
    const e = await errOf(
      request('shopee', 'GET', SP_ITEM_LIST, {}, null, { creds: CREDS, base: s.url }),
    );
    expect(e).toBeInstanceOf(ApiError);
    for (const x of ['BODYMARK', 'BBBB', 'SPTOKEN', 'access_token'])
      expect(e.message).not.toContain(x);
  });

  it('JSON lồng rất sâu → ApiError có "JSON"', async () => {
    const s = await server(() => [200, Buffer.from(`${'['.repeat(100000)}${']'.repeat(100000)}`)]);
    const e = await errOf(
      request('shopee', 'GET', SP_ITEM_LIST, {}, null, { creds: CREDS, base: s.url }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain('JSON');
  });

  it('TikTok code ≠ 0 → lỗi chỉ mang mã', async () => {
    const s = await server(() => [200, { code: 105001, message: 'BODYMARK' }]);
    const e = await errOf(
      request('tiktok', 'POST', TT_ORDER_SEARCH, {}, {}, { creds: CREDS, base: s.url }),
    );
    expect(e.message).toContain('105001');
    expect(e.message).not.toContain('BODYMARK');
  });

  it.each([
    'http://evil.example',
    'ftp://127.0.0.1',
    'http://127.0.0.1.evil.example',
    'https://user:pw@partner.shopeemobile.com',
    'https://h/api',
    'https://',
    'http://localhost:99999',
    'https://h?x=1',
  ])('base URL sai %s → ConfigError, 0 request', async (base) => {
    const e = await errOf(
      request('shopee', 'GET', SP_ITEM_LIST, {}, null, {
        creds: CREDS,
        env: { SHOPEE_API_BASE: base },
      }),
    );
    expect(e).toBeInstanceOf(ConfigError);
  });

  it('base mặc định + server giả local', () => {
    expect(apiBase('shopee', null, null, {})).toBe('https://partner.shopeemobile.com');
    expect(apiBase('tiktok', null, null, { TIKTOK_API_BASE: 'http://localhost:8123/' })).toBe(
      'http://localhost:8123',
    );
  });

  it('r13: 429/5xx thử lại có trần (Retry-After chặn 30 s; lũy thừa 1,2,4); 403 không thử lại', async () => {
    const waits: number[] = [];
    const logs: string[] = [];
    hooks.sleep = async (s) => {
      waits.push(s);
    };
    hooks.log = (s) => logs.push(s);
    let seq: [number, Record<string, string>?][] = [[429, { 'Retry-After': '120' }], [200]];
    const s = await server(() => {
      const [st, h] = seq.shift() ?? [500];
      return [st, { error: '', response: {} }, h];
    });
    const opts = { creds: { ...CREDS }, base: s.url };
    await request('shopee', 'GET', SP_ITEM_LIST, {}, null, opts);
    expect(waits).toEqual([RETRY_WAIT_MAX]);
    expect(logs[0]).toMatch(
      /^\[retry\] shopee \/api\/v2\/product\/get_item_list: HTTP 429 — chờ 30s \(1\/3\)$/,
    );
    waits.length = 0;
    seq = Array.from({ length: RETRY_MAX + 1 }, () => [503] as [number]);
    const e = await errOf(request('shopee', 'GET', SP_ITEM_LIST, {}, null, opts));
    expect(e.message).toContain('503');
    expect(e.message).toContain('sau 4 lần');
    expect(waits).toEqual([1, 2, 4]);
    seq = [[403]];
    const n = s.requests.length;
    const e2 = await errOf(request('shopee', 'GET', SP_ITEM_LIST, {}, null, opts));
    expect(e2.message).toBe('shopee /api/v2/product/get_item_list: HTTP 403');
    expect(s.requests.length - n).toBe(1);
  });

  it.each([
    [Buffer.from('GARBAGE NOT HTTP\r\n\r\n'), 'BadStatusLine'],
    [
      Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\n'),
        Buffer.from(Array.from({ length: 150 }, (_, i) => `X-H${i}: v\r\n`).join('')),
        Buffer.from('Content-Length: 2\r\n\r\n{}'),
      ]),
      'HTTPException',
    ],
    [Buffer.from(`HTTP/1.1 200 OK\r\nX-Long: ${'a'.repeat(70000)}\r\n\r\n`), 'LineTooLong'],
  ])(
    'r17: response HTTP hỏng %# → ApiError "lỗi mạng (…)", không token/URL',
    async (payload, name) => {
      const raw = await rawServer(payload);
      try {
        const e = await errOf(
          send(
            {
              method: 'GET',
              url: `${raw.url}/api/v2/x?access_token=TOKENBIMAT`,
              headers: {},
              body: null,
            },
            'shopee: thử',
          ),
        );
        expect(e).toBeInstanceOf(ApiError);
        expect(e.message).toContain(`lỗi mạng (${name})`);
        expect(e.message).not.toContain('TOKENBIMAT');
        expect(e.message).not.toContain('127.0.0.1');
      } finally {
        await raw.close();
      }
    },
  );
});

// ---------------------------------------------------------------- (5)(6) chuẩn hóa

function spOrderRoute(orders: [string, string, unknown[]][]): Route {
  return (_m, p, q) => {
    if (p === SP_ORDER_LIST) {
      return spOk({
        order_list: orders.map((o) => ({ order_sn: o[0] })),
        more: false,
        next_cursor: '',
      });
    }
    if (p === SP_ORDER_DETAIL) {
      const want = (q.order_sn_list?.[0] ?? '').split(',');
      expect(q.response_optional_fields).toEqual(['item_list']);
      return spOk({
        order_list: orders
          .filter(([sn]) => want.includes(sn))
          .map(([sn, st, items]) => ({
            order_sn: sn,
            order_status: st,
            item_list: items,
            buyer_username: 'nguoimuagia',
            buyer_user_id: 99887766,
            recipient_address: {
              name: 'NGUOI MUA GIA',
              phone: '0900000000',
              full_address: 'DIA CHI GIA 1',
            },
            message_to_seller: 'goi 0900000000',
          })),
      });
    }
    throw new Error(p);
  };
}

type Item = Record<string, unknown>;
const item = (iid: number, name: string, price: unknown, o: Partial<Item> = {}): Item => ({
  item_id: iid,
  item_name: name,
  item_sku: o.sku ?? '',
  item_status: o.status ?? 'NORMAL',
  has_model: o.has_model ?? false,
  price_info: [{ current_price: price, original_price: price }],
  stock_info_v2: { summary_info: { total_available_stock: o.stock ?? 5 } },
});

function spListingRoute(items: Item[], models: Record<string, unknown[]> = {}): Route {
  return (_m, p, q) => {
    if (p === SP_ITEM_LIST) {
      expect(q.item_status).toEqual(SP_ITEM_STATUSES);
      return spOk({
        item: items.map((it) => ({ item_id: it.item_id, item_status: it.item_status })),
        has_next_page: false,
        total_count: items.length,
      });
    }
    if (p === SP_ITEM_INFO) {
      const want = (q.item_id_list?.[0] ?? '').split(',');
      return spOk({ item_list: items.filter((it) => want.includes(String(it.item_id))) });
    }
    if (p === SP_MODEL_LIST) return spOk({ model: models[q.item_id?.[0] ?? ''] });
    throw new Error(p);
  };
}

describe('chuẩn hóa dòng (không PII, cùng hash market_csv)', () => {
  it('đơn Shopee: bỏ PII người mua, hash = hash market_csv của cùng mã đơn', async () => {
    const it0 = {
      item_id: 24325987926,
      item_name: 'Savigout 30 viên',
      item_sku: '',
      model_sku: '',
      model_quantity_purchased: 2,
      model_discounted_price: 439000.0,
    };
    const s = await server(
      spOrderRoute([
        ['FAKEORDER123', 'CANCELLED', [it0]],
        ['FAKEORDER456', 'COMPLETED', [it0, it0]],
      ]),
    );
    const rows = await fetchRows('shopee', 'order', call(s, 'shopee'), SMAP, 7, 1700000000);
    const blob = JSON.stringify(rows);
    expect(rows.map((r) => r.row_no)).toEqual([1, 2, 3]);
    for (const x of [...PII, 'FAKEORDER', '99887766']) expect(blob).not.toContain(x);
    expect([rows[0]?.status, rows[1]?.status]).toEqual(['Đã hủy', 'Hoàn thành']);
    expect([rows[0]?.price, rows[0]?.qty]).toEqual([439000, 2]);
    const p = join(TMP, 'o.csv');
    writeFileSync(
      p,
      'Mã đơn hàng,Trạng thái đơn hàng,Tên sản phẩm,Số lượng,Giá ưu đãi,Mã sản phẩm\nFAKEORDER123,Đã hủy,X,1,100000,1\n',
    );
    const [csvRows, errs] = await readExport(p, 'shopee', 'order', MAP);
    expect(errs).toEqual([]);
    expect(rows[0]?.order_id_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0]?.order_id_hash).toBe(csvRows[0]?.order_id_hash);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(Object.keys(csvRows[0] ?? {}).sort());
    expect(s.requests[0]?.query.time_from).toEqual([String(1700000000 - 7 * 86400)]);
  });

  it('đơn TikTok: bỏ PII', async () => {
    const s = await server((_m, p, _q, b) => {
      expect(p).toBe(TT_ORDER_SEARCH);
      expect(JSON.parse(b).create_time_lt).toBeTruthy();
      return ttOk({
        orders: [
          {
            id: 'FAKEORDER789',
            status: 'CANCELLED',
            buyer_email: 'buyer@gia.example',
            recipient_address: {
              name: 'NGUOI MUA GIA',
              phone_number: '0900000000',
              full_address: 'DIA CHI GIA 1',
            },
            line_items: [
              {
                product_id: '17300001',
                product_name: 'Savina',
                seller_sku: 'savina-12v',
                original_price: '159000',
              },
            ],
          },
        ],
        next_page_token: '',
      });
    });
    const rows = await fetchRows('tiktok', 'order', call(s, 'tiktok'), SMAP, 3);
    expect(rows).toHaveLength(1);
    expect([rows[0]?.status, rows[0]?.price, rows[0]?.qty]).toEqual(['Cancelled', 159000, 1]);
    for (const x of [...PII, 'FAKEORDER']) expect(JSON.stringify(rows)).not.toContain(x);
  });

  it.each([
    ['236000.0', 236000],
    ['236000', 236000],
    ['"236000"', 236000],
    ['"236000.00"', 236000],
    ['236000.5', null],
    ['"236000.5"', null],
    ['-1', null],
    ['"236.000"', 236],
    ['"1.234.567"', null],
    ['"1,5"', null],
    ['true', null],
    ['null', null],
    ['10000000000000000', null],
  ])('giá %s → %s (không làm tròn, không đoán)', async (raw, ok) => {
    // JSON thô để giữ 236000.0 là số thực như Python
    const body = `{"error": "", "response": {"item": [{"item_id": 1, "item_status": "NORMAL"}], "has_next_page": false, "item_list": [{"item_id": 1, "item_name": "A", "item_sku": "", "item_status": "NORMAL", "has_model": false, "price_info": [{"original_price": ${raw}}]}]}}`;
    const s = await server(() => [200, Buffer.from(body)]);
    if (ok === null) {
      const e = await errOf(fetchRows('shopee', 'listing', call(s, 'shopee'), SMAP));
      expect(e).toBeInstanceOf(DataError);
      expect(e.message).toContain('price');
      expect(e.message).not.toContain(raw.replaceAll('"', ''));
    } else {
      const rows = await fetchRows('shopee', 'listing', call(s, 'shopee'), SMAP);
      expect(rows[0]?.price).toBe(ok);
    }
  });

  it('listing có biến thể → 1 dòng mỗi model; trạng thái ánh xạ từ vựng file', async () => {
    const models = {
      '555': [
        {
          model_sku: 'saphraton-20v',
          price_info: [{ original_price: 299000 }],
          stock_info_v2: { summary_info: { total_available_stock: 3 } },
        },
        {
          model_sku: 'saphraton-40v',
          price_info: [{ original_price: 560000 }],
          stock_info_v2: { summary_info: { total_available_stock: 1 } },
        },
      ],
    };
    const s = await server(
      spListingRoute(
        [
          item(555, 'Saphraton', 1, { has_model: true }),
          item(777, 'Lẻ', 100000, { status: 'UNLIST' }),
        ],
        models,
      ),
    );
    const rows = await fetchRows('shopee', 'listing', call(s, 'shopee'), SMAP);
    expect(rows.map((r) => [r.item_id, r.seller_sku, r.price, r.stock])).toEqual([
      ['555', 'saphraton-20v', 299000, 3],
      ['555', 'saphraton-40v', 560000, 1],
      ['777', null, 100000, 5],
    ]);
    expect(rows[2]?.status).toBe('Đã ẩn');
    expect(rows.map((r) => r.row_no)).toEqual([1, 2, 3]);
  });

  it('TikTok listing: tồn = tổng inventory; trạng thái tắt thuộc inactive_status', async () => {
    const s = await server(() =>
      ttOk({
        products: [
          {
            id: '1730',
            title: 'Savina',
            status: 'SELLER_DEACTIVATED',
            skus: [
              {
                seller_sku: 'savina-12v',
                price: { tax_exclusive_price: '159000' },
                inventory: [{ quantity: 3 }, { quantity: 4 }],
              },
            ],
          },
        ],
        next_page_token: '',
      }),
    );
    const [r] = await fetchRows('tiktok', 'listing', call(s, 'tiktok'), SMAP);
    expect([r?.item_id, r?.price, r?.stock, r?.status]).toEqual(['1730', 159000, 7, 'Deactivated']);
    const inactive = (
      (MAP.tiktok as Record<string, Record<string, string[]>>).listing as Record<string, string[]>
    ).inactive_status as string[];
    expect(inactive).toContain(r?.status);
  });

  it('vượt MAX_PAGES → lỗi, không nạp nửa vời', async () => {
    LIMITS.maxPages = 3;
    const s = await server(() =>
      spOk({ item: [{ item_id: 1 }], has_next_page: true, next_offset: 1 }),
    );
    const e = await errOf(fetchRows('shopee', 'listing', call(s, 'shopee'), SMAP));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain('MAX_PAGES');
    expect(s.requests).toHaveLength(3);
  });

  it('status map: tài liệu GIẢ ĐỊNH, không endpoint; khớp từ vựng inactive/cancel', () => {
    const raw = JSON.parse(readFileSync(repoPath('data', 'market_api.json'), 'utf8'));
    expect(raw._doc).toContain('GIẢ ĐỊNH');
    expect(JSON.stringify(raw)).not.toContain('/api/');
    const m = MAP as Record<string, Record<string, Record<string, string[]>>>;
    const sm = raw.status_map;
    expect(m.shopee?.listing?.inactive_status).toContain(sm.shopee.listing.UNLIST);
    expect(m.shopee?.order?.cancel_status).toContain(sm.shopee.order.CANCELLED);
    expect(m.tiktok?.listing?.inactive_status).toContain(sm.tiktok.listing.SELLER_DEACTIVATED);
    expect(m.tiktok?.order?.cancel_status).toContain(sm.tiktok.order.CANCELLED);
    // trạng thái đang bán KHÔNG được map vào inactive (lệch = mất cảnh báo S1)
    expect(m.shopee?.listing?.inactive_status).not.toContain(sm.shopee.listing.NORMAL);
    expect(m.tiktok?.listing?.inactive_status).not.toContain(sm.tiktok.listing.ACTIVATE);
  });

  it('TS chặt hơn: chữ có surrogate lẻ → DataError ở rows_sha256 (Python: UnicodeEncodeError traceback)', () => {
    const bad = { row_no: 1, item_id: '1', title: `x${String.fromCharCode(0xd800)}` };
    expect(() => rowsSha256('shopee', 'listing', [bad])).toThrow(DataError);
    expect(rowsSha256('shopee', 'listing', [{ row_no: 1, title: '😀' }])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- CLI không DB

type Io = { out: string[]; err: string[]; connects: number; jobs: string[] };
const newIo = (): Io => ({ out: [], err: [], connects: 0, jobs: [] });

/** Python `_cli_env`: đủ key, base = server giả, DATABASE_URL giả, connect = lỗi, job_run giả. */
function cliEnv(io: Io, base?: string, extra: Env = {}): CmdDeps {
  const env: Env = { ...CREDS, DATABASE_URL: 'postgresql://fake@127.0.0.1:9/x', ...extra };
  if (base) {
    env.SHOPEE_API_BASE = base;
    env.TIKTOK_API_BASE = base;
  }
  return {
    env,
    log: (s) => io.out.push(s),
    err: (s) => io.err.push(s),
    openService: async () => {
      io.connects++;
      throw new Error('connect không được gọi');
    },
    jobRun: (async (
      name: string,
      body: (r: { ok: boolean; detail: string | null }) => Promise<unknown>,
    ) => {
      io.jobs.push(name);
      return body({ ok: true, detail: null });
    }) as CmdDeps['jobRun'],
  };
}

describe('CLI market-api (không DB)', () => {
  it.each(Object.values(KEYS).flat())(
    'thiếu %s → [external-dep] exit 2, 0 request, không connect',
    async (v) => {
      const s = await server();
      const io = newIo();
      const d = cliEnv(io, s.url, { [v]: v.endsWith('_ID') ? '   ' : '' });
      const ch = v.split('_')[0]?.toLowerCase() as string;
      expect(await marketApiMain({ channel: ch, kind: 'listing' }, d)).toBe(2);
      expect(s.requests).toEqual([]);
      expect(io.connects).toBe(0);
      const out = io.out.join('\n');
      expect(out).toContain('[external-dep]');
      expect(out).toContain(v);
      for (const x of Object.values(CREDS)) expect(out).not.toContain(x);
    },
  );

  it.each([
    [{ channel: 'shopee', kind: 'ads' }],
    [{ channel: 'shopee', kind: 'order', days: '0' }],
    [{ channel: 'shopee', kind: 'order', days: '16' }],
    [{ channel: 'shopee', kind: 'listing', days: '3' }],
    [{ channel: 'shopee', kind: 'order', days: 'x' }],
    [{ channel: 'lazada', kind: 'listing' }],
    [{ channel: 'shopee' }],
    [{}],
    [{ channel: 'shopee', kind: 'listing', refresh: true }],
  ])('sai tham số %# → exit 2 trước request', async (o: ApiOpts) => {
    const s = await server();
    const io = newIo();
    expect(await marketApiMain(o, cliEnv(io, s.url))).toBe(2);
    expect(s.requests).toEqual([]);
    expect(io.connects).toBe(0);
    if (o.kind === 'ads') expect(io.err.join('\n')).toContain('ads chỉ qua file');
  });

  it.each([
    [{ kind: 'settlement' }],
    [{ kind: 'settlement', from: '2026-10-01' }],
    [{ kind: 'listing', dryRun: true }],
    [{ kind: 'order', from: '2026-10-01', to: '2026-10-31' }],
    [{ kind: 'settlement', from: '2026-10-01', to: '2026-12-01' }],
    [{ kind: 'settlement', from: '2026-10-01', to: '2026-10-31', days: '3' }],
  ])('r15: tham số settlement sai %# → exit 2, 0 request', async (o) => {
    const s = await server();
    const io = newIo();
    expect(await marketApiMain({ channel: 'shopee', ...o }, cliEnv(io, s.url))).toBe(2);
    expect(s.requests).toEqual([]);
  });

  it('base sai → [err] exit 2, không connect', async () => {
    const io = newIo();
    expect(
      await marketApiMain(
        { channel: 'shopee', kind: 'listing' },
        cliEnv(io, 'http://evil.example'),
      ),
    ).toBe(2);
    expect(io.connects).toBe(0);
    expect(io.out.join('\n')).toContain('SHOPEE_API_BASE');
  });

  it('lỗi API → exit 1, không connect, chỉ mã lỗi (không body/token)', async () => {
    const s = await server(() => [200, { error: 'error_auth', message: 'BODYMARK' }]);
    const io = newIo();
    expect(await marketApiMain({ channel: 'shopee', kind: 'listing' }, cliEnv(io, s.url))).toBe(1);
    const out = io.out.join('\n');
    expect(io.connects).toBe(0);
    expect(out).toContain('error_auth');
    expect(out).toContain('không connect, không nạp gì');
    expect(out).not.toContain('BODYMARK');
    expect(out).not.toContain('SPTOKEN_SECRET_ABC');
    expect(io.jobs).toEqual(['ingest.market_api']);
  });

  it('r13: tính năng data_platform-06 TẮT → [rollout] exit 2 TRƯỚC mọi request (kể cả refresh), không connect', async () => {
    settings.forceMode = 'tat';
    const s = await server();
    const io = newIo();
    expect(await marketApiMain({ channel: 'shopee', kind: 'listing' }, cliEnv(io, s.url))).toBe(2);
    expect(io.out.at(-1)).toMatch(/^\[rollout\] .*data_platform-06/);
    expect(s.requests).toEqual([]);
    expect(io.connects).toBe(0);
    expect(io.jobs).toEqual([]);
  });

  it('TS chặt hơn: chế độ thực thiếu LOADER_DATABASE_URL → [err] exit 2 TRƯỚC mọi request/refresh', async () => {
    const s = await server(() => spOk({ item: [], has_next_page: false }));
    const io = newIo();
    const d = cliEnv(io, s.url, { AUTH_MODE: 'local' });
    expect(await marketApiMain({ channel: 'shopee', kind: 'listing' }, d)).toBe(2);
    expect(io.out.at(-1)).toMatch(/^\[err\] chế độ thực: thiếu LOADER_DATABASE_URL/);
    expect(s.requests).toEqual([]);
    expect(io.connects).toBe(0);
    expect(io.jobs).toEqual([]);
  });

  it('API trả 0 dòng → [warn] exit 0, không connect', async () => {
    const s = await server(() => spOk({ item: [], has_next_page: false }));
    const io = newIo();
    expect(await marketApiMain({ channel: 'shopee', kind: 'listing' }, cliEnv(io, s.url))).toBe(0);
    expect(io.out).toContain('[warn] API shopee/listing trả 0 dòng — không nạp gì.');
    expect(io.connects).toBe(0);
  });

  it('r15 --kind settlement: chưa nối bản TS settlement_api → [blocked] exit 2, 0 request', async () => {
    const s = await server();
    const io = newIo();
    const o = { channel: 'shopee', kind: 'settlement', from: '2026-10-01', to: '2026-10-31' };
    expect(await marketApiMain(o, cliEnv(io, s.url))).toBe(2);
    expect(io.out.at(-1)).toMatch(/^\[blocked\] shopee: quyết toán qua API/);
    expect(s.requests).toEqual([]);
  });

  it('r15 --kind settlement: precheck chặn → exit theo precheck, 0 request; dry-run không ghi job_runs', async () => {
    const s = await server();
    const calls: string[] = [];
    const hooksBlocked: SettlementHooks = {
      precheck: async (_c, _b, _d, log) => {
        log('[blocked] shopee: bảng ánh xạ quyết toán CHƯA dùng được để ghi sổ — chua_chot');
        return { ctx: null, rc: 2 };
      },
      run: async () => {
        calls.push('run');
        return 0;
      },
    };
    const io = newIo();
    const o = { channel: 'shopee', kind: 'settlement', from: '2026-10-01', to: '2026-10-31' };
    expect(await marketApiMain(o, { ...cliEnv(io, s.url), settlement: hooksBlocked })).toBe(2);
    expect(calls).toEqual([]);
    expect(s.requests).toEqual([]);
    const ok: SettlementHooks = {
      precheck: async () => ({ ctx: { cfg: 1 }, rc: null }),
      run: async (args, _c, base, ctx) => {
        calls.push(
          `${args.window.join('..')} dry=${args.dryRun} ${base === s.url} ${JSON.stringify(ctx)}`,
        );
        return 0;
      },
    };
    const io2 = newIo();
    expect(
      await marketApiMain({ ...o, dryRun: true }, { ...cliEnv(io2, s.url), settlement: ok }),
    ).toBe(0);
    expect(io2.jobs).toEqual([]);
    expect(await marketApiMain(o, { ...cliEnv(io2, s.url), settlement: ok })).toBe(0);
    expect(io2.jobs).toEqual(['ingest.settlement_api']);
    expect(calls).toEqual([
      '2026-10-01..2026-10-31 dry=true true {"cfg":1}',
      '2026-10-01..2026-10-31 dry=false true {"cfg":1}',
    ]);
  });
});

// ---------------------------------------------------------------- r14 refresh token

const PID = '1000001';
const PKEY = 'SPKEY_SECRET_R14';
const SHOP = '2000002';
const R1 = 'R1_SECRET_OLD_TOKEN';
const R2 = 'R2_SECRET_NEW_TOKEN';
const A2 = 'A2_SECRET_ACCESS_TOKEN';

describe('r14 refresh token', () => {
  let store = '';
  const spEnv = (base: string): Env => ({
    SHOPEE_PARTNER_ID: PID,
    SHOPEE_PARTNER_KEY: PKEY,
    SHOPEE_SHOP_ID: SHOP,
    MARKET_TOKEN_FILE: store,
    SHOPEE_API_BASE: base,
  });
  beforeEach(() => {
    store = join(mkdtempSync(join(TMP, 'kho-')), 'kho.json');
    writeFileSync(
      store,
      JSON.stringify({
        shopee: { access_token: 'AOLD_SECRET_X', refresh_token: R1, expire_at: 1 },
      }),
    );
  });
  const authOk: Route = () => [
    200,
    { error: '', message: '', access_token: A2, refresh_token: R2, expire_in: 14400 },
  ];

  it.each([
    ['error', R1],
    ['error', PKEY],
    ['error', { t: R1 }],
    ['code', ['TTSEC_R14']],
    ['code', R1],
  ])('trường lỗi %s phản chiếu credential → không in (đã ẩn)', async (field, leak) => {
    const ch = field === 'error' ? 'shopee' : 'tiktok';
    const creds: Creds =
      ch === 'shopee'
        ? { SHOPEE_PARTNER_ID: PID, SHOPEE_PARTNER_KEY: PKEY, SHOPEE_SHOP_ID: SHOP }
        : { TIKTOK_APP_KEY: 'ak01', TIKTOK_APP_SECRET: 'TTSEC_R14' };
    const s = await server(() => [200, { [field]: leak, message: 'x' }]);
    const e = await errOf(refreshToken(ch, creds, R1, s.url));
    expect(e).toBeInstanceOf(ApiError);
    const text = `${e.message} ${String(e)}`;
    for (const x of [R1, PKEY, 'TTSEC_R14']) expect(text).not.toContain(x);
    expect(text).toContain('đã ẩn');
  });

  it('_err_code: chỉ mã đúng dạng', () => {
    for (const [code, shown] of [
      ['error_auth', 'error_auth'],
      [36004004, '36004004'],
      [true, 'đã ẩn'],
      ['Error Auth', 'đã ẩn'],
      [`error_${'x'.repeat(50)}`, 'đã ẩn'],
    ] as const) {
      expect(errCode(code, { K: 'SPKEY_SECRET_R14' })).toContain(shown);
    }
    expect(errCode('error_spkey_secret_r14', { K: 'spkey_secret_r14' })).toContain('đã ẩn');
  });

  it('--refresh Shopee: xoay token, ký đúng, không in bí mật', async () => {
    const s = await server(authOk);
    const io = newIo();
    expect(
      await marketApiMain(
        { channel: 'shopee', refresh: true },
        { ...cliEnv(io), env: spEnv(s.url) },
      ),
    ).toBe(0);
    const st = JSON.parse(readFileSync(store, 'utf8')).shopee;
    expect([st.access_token, st.refresh_token]).toEqual([A2, R2]);
    expect(st.expire_at).toBeGreaterThan(Date.now() / 1000 + 14000);
    const rq = s.requests[0] as FakeServer['requests'][number];
    expect(s.requests).toHaveLength(1);
    const ts = rq.query.timestamp?.[0];
    expect(rq.method).toBe('POST');
    expect(rq.path).toBe(SP_AUTH_REFRESH);
    expect('access_token' in rq.query).toBe(false);
    expect(rq.query.sign?.[0]).toBe(
      createHmac('sha256', PKEY).update(`${PID}${SP_AUTH_REFRESH}${ts}`).digest('hex'),
    );
    expect(JSON.parse(rq.body)).toEqual({
      refresh_token: R1,
      partner_id: Number(PID),
      shop_id: Number(SHOP),
    });
    const out = [...io.out, ...io.err].join('\n');
    for (const x of [R1, R2, A2, PKEY]) expect(out).not.toContain(x);
    expect(io.out.at(-1)).toMatch(
      /^\[ok\] shopee: đã refresh token — hết hạn \d{4}-\d\d-\d\d \d\d:\d\d \(giờ VN\)\.$/,
    );
  });

  it.each([
    [() => [200, { error: 'error_auth', message: 'invalid' }] as const],
    [() => [200, { error: '', access_token: A2, expire_in: 14400 }] as const],
    [() => [200, { error: '', access_token: A2, refresh_token: R2, expire_in: 0 }] as const],
    [() => [500, { error: 'error_server' }] as const],
    [() => [302, {}, { Location: 'http://127.0.0.1:1/x' }] as const],
  ])('refresh lỗi %# → exit 1, kho KHÔNG đổi, đúng 1 request (không thử lại)', async (resp) => {
    const s = await server(resp as unknown as Route);
    const before = readFileSync(store);
    const io = newIo();
    const d = { ...cliEnv(io), env: spEnv(s.url) };
    expect(await marketApiMain({ channel: 'shopee', kind: 'listing' }, d)).toBe(1);
    expect(readFileSync(store)).toEqual(before);
    expect(s.requests).toHaveLength(1);
    expect(io.out.join('\n')).toContain('kho token KHÔNG đổi');
  });

  it('kho token trong repo → exit 2, 0 request', async () => {
    const s = await server(authOk);
    const io = newIo();
    const env = { ...spEnv(s.url), MARKET_TOKEN_FILE: repoPath('data', 'kho_token.json') };
    expect(await marketApiMain({ channel: 'shopee', refresh: true }, { ...cliEnv(io), env })).toBe(
      2,
    );
    expect(io.out[0]).toContain('nằm trong repo');
    expect(s.requests).toEqual([]);
  });

  it('--refresh không có kho → exit 2', async () => {
    const io = newIo();
    const env = { ...spEnv('https://x.vn'), MARKET_TOKEN_FILE: '' };
    expect(await marketApiMain({ channel: 'shopee', refresh: true }, { ...cliEnv(io), env })).toBe(
      2,
    );
    expect(io.out[0]).toBe(
      '[err] --refresh cần MARKET_TOKEN_FILE (refresh_token xoay vòng phải được lưu) — 0 request.',
    );
  });

  it('khóa kho đang bị giữ → không refresh, không request', async () => {
    const release = fileLock(tokenLockPath(store));
    expect(release).not.toBeNull();
    try {
      const logs: string[] = [];
      const got = await doRefresh('shopee', {}, store, true, {
        log: (x) => logs.push(x),
        refresh: async () => {
          throw new Error('không được refresh khi đang khóa');
        },
      });
      expect(got).toBeNull();
      expect(logs[0]).toContain('tiến trình khác đang refresh token');
    } finally {
      release?.();
    }
  });

  it('khóa TS ở tệp riêng: KHÔNG xóa/thay `<kho>.lock` của Python (giữ loại trừ Python↔Python)', async () => {
    writeFileSync(`${store}.lock`, ''); // tệp rỗng Python để lại / đang flock
    const got = await doRefresh('shopee', {}, store, true, {
      log: () => {},
      refresh: async () => ({ access_token: A2, refresh_token: R2, expire_at: 1700014400 }),
    });
    expect(got).toBe(A2);
    expect(existsSync(`${store}.lock`)).toBe(true);
    expect(readFileSync(`${store}.lock`, 'utf8')).toBe('');
    expect(existsSync(tokenLockPath(store))).toBe(false);
  });

  it('khóa cũ (tệp rỗng / pid đã chết) → lấy lại được', () => {
    writeFileSync(tokenLockPath(store), '');
    const r1 = fileLock(tokenLockPath(store));
    expect(r1).not.toBeNull();
    r1?.();
    writeFileSync(tokenLockPath(store), '4194303');
    const r2 = fileLock(tokenLockPath(store));
    expect(r2).not.toBeNull();
    r2?.();
  });

  it('đọc lại kho TRONG khóa: token còn hạn → dùng luôn, không refresh', async () => {
    writeFileSync(
      store,
      JSON.stringify({
        shopee: {
          access_token: A2,
          refresh_token: R2,
          expire_at: Math.floor(Date.now() / 1000) + 7200,
        },
      }),
    );
    const got = await doRefresh('shopee', {}, store, false, {
      refresh: async () => {
        throw new Error('token còn hạn — không refresh');
      },
    });
    expect(got).toBe(A2);
  });

  it('TikTok refresh: GET đúng tham số theo tài liệu', async () => {
    const seen: [string, string, Record<string, string>][] = [];
    const s = await server((m, p, q) => {
      seen.push([m, p, Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v[0] as string]))]);
      return [
        200,
        {
          code: 0,
          data: {
            access_token: A2,
            refresh_token: R2,
            access_token_expire_in: Math.floor(Date.now() / 1000) + 604800,
          },
        },
      ];
    });
    const r = await refreshToken(
      'tiktok',
      { TIKTOK_APP_KEY: 'ak01', TIKTOK_APP_SECRET: 'TTSEC_R14' },
      R1,
      s.url,
    );
    expect([r.access_token, r.refresh_token]).toEqual([A2, R2]);
    expect(seen).toEqual([
      [
        'GET',
        TT_AUTH_REFRESH,
        {
          app_key: 'ak01',
          app_secret: 'TTSEC_R14',
          refresh_token: R1,
          grant_type: 'refresh_token',
        },
      ],
    ]);
  });

  it('token kho còn hạn → không refresh, dùng token kho thay env', async () => {
    writeFileSync(
      store,
      JSON.stringify({
        shopee: {
          access_token: A2,
          refresh_token: R2,
          expire_at: Math.floor(Date.now() / 1000) + 7200,
        },
      }),
    );
    const s = await server((_m, p) =>
      p === SP_ITEM_LIST ? spOk({ item: [], has_next_page: false }) : [500, {}],
    );
    const io = newIo();
    expect(
      await marketApiMain(
        { channel: 'shopee', kind: 'listing' },
        { ...cliEnv(io), env: spEnv(s.url) },
      ),
    ).toBe(0);
    expect(s.requests.map((r) => r.path)).toEqual([SP_ITEM_LIST]);
    expect(s.requests[0]?.query.access_token).toEqual([A2]);
  });
});
