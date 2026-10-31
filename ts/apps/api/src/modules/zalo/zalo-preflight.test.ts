import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import golden from './__fixtures__/preflight.golden.json' with { type: 'json' };
import { clock } from './zalo.constants.js';
import type { FetchFn } from './zalo.sender.js';
import { resp, rig } from './zalo.test-helpers.js';
import {
  checkAi,
  checkEnv,
  checkSignature,
  expiryNote,
  type PreflightDeps,
  preflightMain,
  runChecks,
} from './zalo-preflight.js';

// Dịch tests/test_preflight.py + golden check_env/check_openrouter/_expiry_note từ Python thật.
// KHÁC Python có chủ đích: OPENROUTER_API_KEY → OLLAMA_URL, mục `openrouter` → `ai`.

const toTs = (s: string) => s.replaceAll('OPENROUTER_API_KEY', 'OLLAMA_URL');
const envTs = (e: Record<string, string>) =>
  Object.fromEntries(Object.entries(e).map(([k, v]) => [toTs(k), v]));

const realWall = clock.wall;
afterEach(() => {
  clock.wall = realWall;
  vi.restoreAllMocks();
});

function store() {
  return join(rig().dir, 'zalo_tokens.json');
}

const getoa = (fn: (tok: string | null) => unknown) => {
  const calls: (string | null)[] = [];
  const f: FetchFn = async (_u, init) => {
    const tok = (init.headers as Record<string, string>).access_token ?? null;
    calls.push(tok);
    return resp(200, fn(tok));
  };
  return { f, calls };
};

const byName = (rs: { name: string; status: string; detail: string }[]) =>
  Object.fromEntries(rs.map((x) => [x.name, x])) as Record<
    string,
    { status: string; detail: string }
  >;
const noDb: PreflightDeps['dbCheck'] = async () => {
  throw new Error('không được chạm DB');
};

describe('golden Python', () => {
  it('check_env × store; check_openrouter → check_ai; signature SKIP', () => {
    const p = store();
    for (const c of golden.env) {
      if (c.store === null) {
        try {
          unlinkSync(p);
        } catch {}
      } else if (c.store === 'corrupt') writeFileSync(p, '[');
      else writeFileSync(p, JSON.stringify(c.store));
      const env = envTs(c.env as Record<string, string>);
      const got = checkEnv(env, p);
      expect(got, JSON.stringify(c)).toEqual({ ...c.env_res, detail: toTs(c.env_res.detail) });
      const ai = checkAi(env);
      expect(ai).toEqual({ ...c.or_res, name: 'ai', detail: toTs(c.or_res.detail) });
      if (c.sig_skip) expect(checkSignature(env)).toEqual(c.sig_skip);
    }
    expect(checkSignature({ ZALO_OA_SECRET: 's3cret' })).toEqual(golden.signature_ok);
  });

  it('_expiry_note', () => {
    for (const n of golden.expiry_note)
      expect(expiryNote(n.v, golden.now), String(n.v)).toBe(n.note);
  });
});

describe('preflight', () => {
  it('DEPLOY=1 thiếu mọi ZALO_* → env FAIL liệt kê đủ; token FAIL', async () => {
    const res = byName(await runChecks({ DEPLOY: '1' }, false, { tokenStore: store() }));
    expect(res.env?.status).toBe('FAIL');
    for (const k of [
      'ZALO_OA_SECRET',
      'ZALO_APP_ID',
      'ZALO_APP_SECRET',
      'DATABASE_URL',
      'OLLAMA_URL',
    ]) {
      expect(res.env?.detail).toContain(k);
    }
    expect(res.env?.detail).toContain('ZALO_ACCESS_TOKEN|(');
    expect(res.token?.status).toBe('FAIL');
  });

  it('dev thiếu env → SKIP; ai SKIP', async () => {
    const res = byName(await runChecks({ DEPLOY: '0' }, false, { tokenStore: store() }));
    expect(res.env?.status).toBe('SKIP');
    expect(res.ai?.status).toBe('SKIP');
  });

  it('db: DATABASE_URL lỗi → FAIL (không crash); có → đếm chunks', async () => {
    const env = { DATABASE_URL: 'postgresql://x@127.0.0.1:9/t' };
    const ok = byName(
      await runChecks(env, false, { tokenStore: store(), dbCheck: async () => 42 }),
    );
    expect(ok.db).toMatchObject({ status: 'PASS', detail: 'chunks=42' });
    const bad = byName(await runChecks(env, false, { tokenStore: store(), dbCheck: noDb }));
    expect(bad.db?.status).toBe('FAIL');
  });

  it('getoa error=0 → token PASS', async () => {
    const g = getoa(() => ({ error: 0 }));
    const res = byName(
      await runChecks({ ZALO_ACCESS_TOKEN: 'tok' }, false, { tokenStore: store(), fetch: g.f }),
    );
    expect(res.token?.status).toBe('PASS');
    expect(g.calls).toEqual(['tok']);
  });

  it('getoa lỗi + có refresh_token, không --refresh → SKIP "sẽ refresh"', async () => {
    const g = getoa(() => ({ error: -216 }));
    const res = byName(
      await runChecks({ ZALO_ACCESS_TOKEN: 'old', ZALO_REFRESH_TOKEN: 'rt' }, false, {
        tokenStore: store(),
        fetch: g.f,
      }),
    );
    expect(res.token?.status).toBe('SKIP');
    expect(res.token?.detail).toContain('refresh');
  });

  it('--refresh mà chưa có hàm refresh → SKIP, không crash', async () => {
    const g = getoa(() => ({ error: -216 }));
    const res = byName(
      await runChecks({ ZALO_ACCESS_TOKEN: 'old', ZALO_REFRESH_TOKEN: 'rt' }, true, {
        tokenStore: store(),
        fetch: g.f,
        refresh: null,
      }),
    );
    expect(res.token?.status).toBe('SKIP');
    expect(res.token?.detail).toContain('refresh_access_token');
  });

  it('--refresh ép rotation kể cả token còn sống; getoa CHỈ trên token mới', async () => {
    const p = store();
    writeFileSync(
      p,
      JSON.stringify({
        access_token: 'old-tok',
        refresh_token: 'rt',
        expires_at: Date.now() / 1000 + 3600,
      }),
    );
    const g = getoa((tok) => ({ error: tok === 'new-tok' ? 0 : -216 }));
    let n = 0;
    const res = byName(
      await runChecks({ ZALO_ACCESS_TOKEN: 'old-tok', ZALO_REFRESH_TOKEN: 'rt' }, true, {
        tokenStore: p,
        fetch: g.f,
        refresh: async () => {
          n += 1;
          writeFileSync(
            p,
            JSON.stringify({
              access_token: 'new-tok',
              refresh_token: 'rt2',
              expires_at: Date.now() / 1000 + 3600,
            }),
          );
          return true;
        },
      }),
    );
    expect(res.token?.status).toBe('PASS');
    expect(n).toBe(1);
    expect(g.calls).toEqual(['new-tok']);
  });

  it('refresh trả false / crash → FAIL', async () => {
    const env = { ZALO_ACCESS_TOKEN: 'old', ZALO_REFRESH_TOKEN: 'rt' };
    const f = byName(
      await runChecks(env, true, { tokenStore: store(), refresh: async () => false }),
    );
    expect(f.token).toMatchObject({ status: 'FAIL', detail: 'refresh_access_token trả False' });
    const c = byName(
      await runChecks(env, true, {
        tokenStore: store(),
        refresh: async () => {
          throw new TypeError('x');
        },
      }),
    );
    expect(c.token).toMatchObject({
      status: 'FAIL',
      detail: 'refresh_access_token crash TypeError',
    });
  });

  it('signature: có secret → round-trip PASS; không secret → SKIP "event live"', () => {
    expect(checkSignature({ ZALO_OA_SECRET: 's3cret' }).status).toBe('PASS');
    const s = checkSignature({});
    expect(s.status).toBe('SKIP');
    expect(s.detail).toContain('event live');
  });

  it('main: in bảng + tổng; exit 1 khi có FAIL, 0 khi không', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await preflightMain({ DEPLOY: '1' }, false, { tokenStore: store() })).toBe(1);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('[preflight] Zalo OA go-live check');
    expect(out).toMatch(/^FAIL {2}env {9}DEPLOY bật nhưng thiếu: /m);
    expect(out).toContain('CHƯA OK — vá các mục FAIL trước');
    log.mockClear();
    const g = getoa(() => ({ error: 0 }));
    expect(
      await preflightMain({ ZALO_ACCESS_TOKEN: 't' }, false, { tokenStore: store(), fetch: g.f }),
    ).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('— OK để mở public');
  });
});
