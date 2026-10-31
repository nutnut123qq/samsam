import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendLate, withBudget } from './zalo.budget.js';
import { clock, OAUTH_URL, REFRESH_TIMEOUT_S, SEND_TIMEOUT_S, SEND_URL } from './zalo.constants.js';
import { type FetchFn, senderConfig, ZaloSender } from './zalo.sender.js';
import { resp, rig } from './zalo.test-helpers.js';

// Dịch tests/test_zalo.py (token store / refresh / send V1.1–V2.3) + test_v14_p6_ops.py,
// test_docx_p1.py (30 giây phủ cả phần gửi). HTTP giả — không gọi Zalo thật.

type Call = { url: string; token: string | null; form: URLSearchParams | null; timeoutS?: number };

function fake(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    const u = new URL(String(url));
    const base = `${u.origin}${u.pathname}`;
    const c: Call = {
      url: base,
      token: u.searchParams.get('access_token'),
      form: base === OAUTH_URL ? new URLSearchParams(String(init.body)) : null,
      timeoutS: init.timeoutS,
    };
    if (base === OAUTH_URL) {
      expect((init.headers as Record<string, string>).secret_key).toBe('sec');
    }
    calls.push(c);
    return handler(c);
  };
  return { fn, calls, urls: () => calls.map((c) => c.url) };
}

const FULL = {
  DEPLOY: '1',
  ZALO_ACCESS_TOKEN: 'old-tok',
  ZALO_REFRESH_TOKEN: 'old-rtok',
  ZALO_APP_ID: 'app',
  ZALO_APP_SECRET: 'sec',
};

function sender(env: Record<string, string>, fn: FetchFn) {
  const store = join(rig().dir, 'zalo_tokens.json');
  return { s: new ZaloSender(senderConfig(env, store), fn), store };
}

const oauthOk = (n = 'new') =>
  resp(200, { access_token: `${n}-tok`, refresh_token: `${n}-rtok`, expires_in: '3600' });

const realMono = clock.mono;
const realWall = clock.wall;
afterEach(() => {
  clock.mono = realMono;
  clock.wall = realWall;
  vi.restoreAllMocks();
});

describe('token store', () => {
  it('V1.1: env là seed; store thắng env; store hỏng → env', () => {
    const { s, store } = sender(
      { ZALO_ACCESS_TOKEN: 'env-tok', ZALO_REFRESH_TOKEN: 'env-rtok' },
      fake(() => resp(500)).fn,
    );
    expect(s.currentAccessToken()).toBe('env-tok');
    expect(s.currentRefreshToken()).toBe('env-rtok');
    s.writeStore({ access_token: 'file-tok', refresh_token: 'file-rtok', expires_at: 1 });
    expect(s.currentAccessToken()).toBe('file-tok');
    expect(s.currentRefreshToken()).toBe('file-rtok');
    writeFileSync(store, '{not json');
    expect(s.currentAccessToken()).toBe('env-tok');
  });

  it('refresh rotate + persist cả access lẫn refresh + expires_at', async () => {
    const f = fake(() => oauthOk());
    const { s, store } = sender(
      { ZALO_REFRESH_TOKEN: 'old-rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      f.fn,
    );
    expect(await s.refreshAccessToken()).toBe(true);
    const st = JSON.parse(readFileSync(store, 'utf8'));
    expect(st.access_token).toBe('new-tok');
    expect(st.refresh_token).toBe('new-rtok');
    expect(st.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(f.calls[0]?.form?.get('refresh_token')).toBe('old-rtok');
    expect(f.calls[0]?.form?.get('grant_type')).toBe('refresh_token');
    expect(s.currentAccessToken()).toBe('new-tok');
  });

  it('thiếu credential → false, KHÔNG gọi mạng', async () => {
    const f = fake(() => {
      throw new Error('không được gọi network');
    });
    const { s } = sender({}, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.refreshAccessToken()).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('2 refresh đồng thời tuần tự: lần sau gửi refresh_token ĐÃ rotate', async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fake(async () => {
      n += 1;
      const k = n;
      if (k === 1) await gate;
      return resp(200, { access_token: `at-${k}`, refresh_token: `rtok-${k}`, expires_in: '3600' });
    });
    const { s } = sender(
      { ZALO_REFRESH_TOKEN: 'rtok-0', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      f.fn,
    );
    const p1 = s.refreshAccessToken();
    const p2 = s.refreshAccessToken();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls.map((c) => c.form?.get('refresh_token'))).toEqual(['rtok-0']);
    release();
    await Promise.all([p1, p2]);
    expect(f.calls.map((c) => c.form?.get('refresh_token'))).toEqual(['rtok-0', 'rtok-1']);
  });

  it('V2.3: persist fail → token rotate giữ trong mem; lần sau dùng bản mem', async () => {
    let n = 0;
    const f = fake((c) => {
      n += 1;
      void c;
      return resp(200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: '3600' });
    });
    const { s } = sender(
      { ZALO_REFRESH_TOKEN: 'old-rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      f.fn,
    );
    s.writeStore = () => {
      throw new Error('disk full');
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.refreshAccessToken()).toBe(true);
    expect(s.currentAccessToken()).toBe('at-1');
    expect(s.currentRefreshToken()).toBe('rt-1');
    expect(await s.refreshAccessToken()).toBe(true);
    expect(f.calls.map((c) => c.form?.get('refresh_token'))).toEqual(['old-rtok', 'rt-1']);
    expect(s.currentAccessToken()).toBe('at-2');
  });

  it('persist OK → mem trống, store ngoài (preflight) được tôn trọng', async () => {
    const { s } = sender(
      { ZALO_REFRESH_TOKEN: 'old-rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      fake(() => oauthOk('at1')).fn,
    );
    expect(await s.refreshAccessToken()).toBe(true);
    expect(s.memTokens).toEqual({});
    s.writeStore({
      access_token: 'ext-tok',
      refresh_token: 'ext-rtok',
      expires_at: Date.now() / 1000 + 3600,
    });
    expect(s.currentAccessToken()).toBe('ext-tok');
    expect(s.currentRefreshToken()).toBe('ext-rtok');
  });

  it('expires_in 0 → expires_at 0 ("không biết"), không refresh chủ động', async () => {
    const { s } = sender(
      { ZALO_REFRESH_TOKEN: 'rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      fake(() => resp(200, { access_token: 'new-tok', refresh_token: 'new-rtok', expires_in: '0' }))
        .fn,
    );
    expect(await s.refreshAccessToken()).toBe(true);
    expect(s.currentExpiresAt()).toBe(0);
    expect(s.tokenExpiringSoon()).toBe(false);
  });

  it('oauth HTTP lỗi / body không JSON → false, không log body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const r of [
      resp(500, { access_token: 'leak-tok' }),
      resp(200, 'not json'),
      resp(200, { access_token: '' }),
    ]) {
      const { s } = sender(
        { ZALO_REFRESH_TOKEN: 'r', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
        fake(() => r).fn,
      );
      expect(await s.refreshAccessToken()).toBe(false);
    }
    expect(log.mock.calls.flat().join('\n')).not.toContain('leak-tok');
  });
});

describe('send_text', () => {
  it('G5: DEPLOY tắt → dry-run, 0 request, log chỉ uh băm', async () => {
    for (const v of [undefined, '', '0', 'false', 'no']) {
      const f = fake(() => resp(200, { error: 0 }));
      const env: Record<string, string> = { ZALO_ACCESS_TOKEN: 'tok-that' };
      if (v !== undefined) env.DEPLOY = v;
      const { s } = sender(env, f.fn);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await s.sendText('user-raw-123', 'xin chào')).toBe(false);
      expect(f.calls).toEqual([]);
      const out = log.mock.calls.flat().join('\n');
      expect(out).toContain('[dry-run] zalo');
      expect(out).not.toContain('user-raw-123');
      log.mockRestore();
    }
  });

  it('không token → false + nhắc ZALO_ACCESS_TOKEN', async () => {
    const { s } = sender({ DEPLOY: '1' }, fake(() => resp(200)).fn);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.sendText('u', 't')).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('ZALO_ACCESS_TOKEN');
  });

  it('V1.1: API lỗi rõ → refresh rồi retry ĐÚNG 1 lần bằng token mới', async () => {
    const f = fake((c) =>
      c.url === OAUTH_URL ? oauthOk() : resp(200, { error: c.token === 'old-tok' ? -216 : 0 }),
    );
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.sendText('u1', 'xin chào')).toBe(true);
    expect(f.calls.filter((c) => c.url === SEND_URL).map((c) => c.token)).toEqual([
      'old-tok',
      'new-tok',
    ]);
  });

  it('send lỗi + refresh lỗi → false, không retry', async () => {
    const f = fake((c) => (c.url === OAUTH_URL ? resp(500) : resp(200, { error: -216 })));
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.sendText('u1', 'x')).toBe(false);
    expect(f.urls().filter((u) => u === SEND_URL).length).toBe(1);
    expect(f.urls().filter((u) => u === OAUTH_URL).length).toBe(1);
  });

  it('chỉ có bộ refresh → refresh TRƯỚC rồi gửi', async () => {
    const f = fake((c) => {
      if (c.url === OAUTH_URL) return oauthOk();
      expect(c.token).toBe('new-tok');
      return resp(200, { error: 0 });
    });
    const { s } = sender(
      { DEPLOY: '1', ZALO_REFRESH_TOKEN: 'rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      f.fn,
    );
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(f.urls()).toEqual([OAUTH_URL, SEND_URL]);
  });

  it('M3: send-fail thứ 2 trong 60 giây KHÔNG rotate lại', async () => {
    let n = 0;
    const f = fake((c) => {
      if (c.url === OAUTH_URL) {
        n += 1;
        return resp(200, { access_token: `tok-${n}`, refresh_token: 'rtok-x', expires_in: '3600' });
      }
      return resp(200, { error: -216 });
    });
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.sendText('u1', 'x')).toBe(false);
    expect(f.urls().filter((u) => u === OAUTH_URL).length).toBe(1);
    expect(await s.sendText('u1', 'x')).toBe(false);
    expect(f.urls().filter((u) => u === OAUTH_URL).length).toBe(1);
    expect(f.urls().filter((u) => u === SEND_URL).length).toBe(4);
  });

  it('V2.1: token sắp hết hạn → refresh chủ động trước khi gửi', async () => {
    const f = fake((c) => {
      if (c.url === OAUTH_URL) return oauthOk();
      expect(c.token).toBe('new-tok');
      return resp(200, { error: 0 });
    });
    const { s } = sender(FULL, f.fn);
    s.writeStore({
      access_token: 'old-tok',
      refresh_token: 'old-rtok',
      expires_at: Date.now() / 1000 + 60,
    });
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(f.urls()).toEqual([OAUTH_URL, SEND_URL]);
  });

  it('token còn xa hạn → không oauth', async () => {
    const f = fake(() => resp(200, { error: 0 }));
    const { s } = sender(FULL, f.fn);
    s.writeStore({
      access_token: 'old-tok',
      refresh_token: 'old-rtok',
      expires_at: Date.now() / 1000 + 3600,
    });
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(f.urls()).toEqual([SEND_URL]);
  });

  it('refresh chủ động lỗi → vẫn gửi token cũ; oauth sập thì throttle', async () => {
    const f = fake((c) => {
      if (c.url === OAUTH_URL) return resp(500);
      expect(c.token).toBe('old-tok');
      return resp(200, { error: 0 });
    });
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    s.writeStore({
      access_token: 'old-tok',
      refresh_token: 'old-rtok',
      expires_at: Date.now() / 1000 + 60,
    });
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(f.urls()).toEqual([OAUTH_URL, SEND_URL, SEND_URL]);
  });

  it('V2.2: refresh vừa fail + send fail → không retry bằng token hỏng', async () => {
    const f = fake((c) => (c.url === OAUTH_URL ? resp(500) : resp(200, { error: -216 })));
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await s.sendText('u1', 'x')).toBe(false);
    expect(await s.sendText('u1', 'x')).toBe(false);
    expect(f.urls().filter((u) => u === SEND_URL).length).toBe(2);
    expect(f.urls().filter((u) => u === OAUTH_URL).length).toBe(1);
  });

  it('V2.2+F2: send-fail khi lượt khác ĐANG refresh → chờ rồi retry token mới', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inOauth = new Promise<void>((r) => {
      entered = r;
    });
    const f = fake(async (c) => {
      if (c.url === OAUTH_URL) {
        entered();
        await gate;
        return oauthOk();
      }
      return resp(200, { error: c.token === 'old-tok' ? -216 : 0 });
    });
    const { s } = sender(FULL, f.fn);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r1 = s.refreshAccessToken();
    await inOauth;
    let done = false;
    const r2 = s.sendText('u1', 'x').then((v) => {
      done = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // đang chờ refresh
    release();
    await r1;
    expect(await r2).toBe(true);
    expect(f.calls.filter((c) => c.url === SEND_URL).map((c) => c.token)).toEqual([
      'old-tok',
      'new-tok',
    ]);
  });

  it('{"error": false} = 0 như Python (== 0); text cắt 2000 ký tự (code point)', async () => {
    let body = '';
    const fn: FetchFn = async (_u, init) => {
      body = String(init.body);
      return resp(200, { error: false });
    };
    const { s } = sender({ DEPLOY: '1', ZALO_ACCESS_TOKEN: 't' }, fn);
    expect(await s.sendText('u', '😀'.repeat(2500))).toBe(true);
    expect([...JSON.parse(body).message.text].length).toBe(2000);
  });
});

describe('ngân sách 30 giây ở phần gửi (v14.6, docx P1)', () => {
  it('lần gửi đầu dùng phần còn lại; không hạn → SEND_TIMEOUT_S', async () => {
    const f = fake(() => resp(200, { error: 0 }));
    const { s } = sender({ DEPLOY: '1', ZALO_ACCESS_TOKEN: 'TOK' }, f.fn);
    clock.mono = () => 1000;
    // giây LẺ của ngân sách (AbortSignal.timeout chỉ nhận ms nguyên — từng làm hỏng mọi lần gửi)
    expect(await withBudget(1003.7, () => s.sendText('u1', 'x'))).toBe(true);
    expect(f.calls[0]?.timeoutS).toBeCloseTo(3.7);
    expect(await withBudget(1012, () => s.sendText('u1', 'x'))).toBe(true);
    expect(f.calls[1]?.timeoutS).toBe(SEND_TIMEOUT_S);
    expect(await s.sendText('u1', 'x')).toBe(true);
    expect(f.calls[2]?.timeoutS).toBe(SEND_TIMEOUT_S);
  });

  it.each([0.5, 0, -1])('còn %s giây → không gọi API, đánh dấu bước "gui"', async (leftS) => {
    const f = fake(() => resp(200, { error: 0 }));
    const { s } = sender({ DEPLOY: '1', ZALO_ACCESS_TOKEN: 'TOK' }, f.fn);
    clock.mono = () => 1000;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const [ok, late] = await withBudget(1000 + leftS, async () => {
      const v = await s.sendText('u1', 'x');
      return [v, sendLate(v)] as const;
    });
    expect(ok).toBe(false);
    expect(late).toBe('gui');
    expect(f.calls).toEqual([]);
  });

  it('ngoài lượt trả lời (CLI/preflight) → refresh timeout 15 giây như cũ', async () => {
    const f = fake((c) => (c.url === OAUTH_URL ? oauthOk() : resp(200, { error: 0 })));
    const { s } = sender(
      { DEPLOY: '1', ZALO_REFRESH_TOKEN: 'rtok', ZALO_APP_ID: 'app', ZALO_APP_SECRET: 'sec' },
      f.fn,
    );
    expect(await s.sendText('u5', 'x')).toBe(true);
    expect(f.calls[0]).toMatchObject({ url: OAUTH_URL, timeoutS: REFRESH_TIMEOUT_S });
  });
});
