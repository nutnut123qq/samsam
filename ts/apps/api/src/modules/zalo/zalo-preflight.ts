import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pyFloat } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { isPlainObject, parseJsonBytes } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { pyStr, pyTruthy } from '@samsam/core/security/py';
import { clock, deployOn, GETOA_URL } from './zalo.constants.js';
import type { FetchFn, Tokens } from './zalo.sender.js';
import { verifySignature } from './zalo.util.js';

// Port scripts/zalo_preflight.py (V1.3): chạy trên máy deploy TRƯỚC khi mở public. 1 dòng
// PASS/FAIL/SKIP + lý do cho từng mục; exit 0 iff không có FAIL (SKIP không fail).
// KHÁC Python có chủ đích: mục `openrouter` (OPENROUTER_API_KEY) → `ai` (OLLAMA_URL) — bản TS gọi
// AI qua AI Gateway nội bộ (Ollama, KE_HOACH mục 2), không dùng OpenRouter. Không gọi API AI.

export type Check = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
const r = (name: string, status: Check['status'], detail = ''): Check => ({ name, status, detail });
/** Python `a or b`. */
const or = (a: unknown, b: unknown): unknown => (pyTruthy(a) ? a : b);
/** Python `data.get("error") == 0` (0 / 0.0 / False). */
const isOk = (d: unknown) => isPlainObject(d) && (d.error === 0 || d.error === false);
const errOf = (d: unknown) => pyStr(isPlainObject(d) ? d.error : 'non-json');

const AI_KEY = 'OLLAMA_URL';
// Mirror startupError: bắt buộc base + đường send = access_token ∨ bộ refresh (3 biến).
const REQUIRED_BASE = ['ZALO_OA_SECRET', 'DATABASE_URL', AI_KEY];

export type PreflightDeps = {
  tokenStore?: string;
  fetch?: FetchFn;
  /** zalo refresh thật (ZaloSender.refreshAccessToken) — null = chưa sẵn sàng → SKIP. */
  refresh?: (() => Promise<boolean>) | null;
  dbCheck?: (dsn: string) => Promise<number>;
};

export function readStore(path: string = dataPath('zalo_tokens.json')): Tokens {
  try {
    const d = parseJsonBytes(readFileSync(path));
    return isPlainObject(d) ? d : {};
  } catch {
    return {};
  }
}

export function checkEnv(env: Env, tokenStore?: string): Check {
  const missing = REQUIRED_BASE.filter((k) => !env[k]);
  // Token store là source-of-truth sau refresh — store hợp lệ thì env seed thiếu không FAIL.
  const store = readStore(tokenStore);
  const hasAccess = pyTruthy(or(store.access_token, env.ZALO_ACCESS_TOKEN));
  const rtok = or(store.refresh_token, env.ZALO_REFRESH_TOKEN);
  const hasRefresh = pyTruthy(rtok) && Boolean(env.ZALO_APP_ID && env.ZALO_APP_SECRET);
  if (!(hasAccess || hasRefresh)) {
    missing.push('ZALO_ACCESS_TOKEN|(ZALO_REFRESH_TOKEN+ZALO_APP_ID+ZALO_APP_SECRET)');
  }
  if (deployOn(env)) {
    if (missing.length) return r('env', 'FAIL', `DEPLOY bật nhưng thiếu: ${missing.join(', ')}`);
    if (!hasRefresh) {
      return r(
        'env',
        'PASS',
        'đủ env — nhưng không có bộ refresh: access token hết hạn ~25h sẽ không tự refresh',
      );
    }
    return r('env', 'PASS', 'đủ env cho DEPLOY');
  }
  if (missing.length) return r('env', 'SKIP', `dev mode — thiếu: ${missing.join(', ')}`);
  return r('env', 'PASS', 'dev mode, đủ env');
}

async function countChunks(dsn: string): Promise<number> {
  const pool = createPool(dsn, { max: 1 });
  try {
    const q = await pool.query<{ n: string }>('SELECT count(*) AS n FROM chunks');
    return Number(q.rows[0]?.n);
  } finally {
    await pool.end();
  }
}

export async function checkDb(env: Env, deps: PreflightDeps = {}): Promise<Check> {
  const dsn = env.DATABASE_URL ?? '';
  if (!dsn) return r('db', 'SKIP', 'DATABASE_URL chưa set');
  try {
    return r('db', 'PASS', `chunks=${await (deps.dbCheck ?? countChunks)(dsn)}`);
  } catch (e) {
    // Preflight không được crash: mọi lỗi connect/query đều FAIL.
    return r('db', 'FAIL', `${pgErrName(e)}: ${(e as Error).message}`);
  }
}

export function checkAi(env: Env): Check {
  if (env[AI_KEY]) return r('ai', 'PASS', `${AI_KEY} set (không gọi API)`);
  return r('ai', deployOn(env) ? 'FAIL' : 'SKIP', `${AI_KEY} MISSING`);
}

async function getoa(accessToken: string, http: FetchFn): Promise<unknown> {
  const res = await http(GETOA_URL, {
    headers: { access_token: accessToken },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    timeoutS: 15,
  });
  return parseJsonBytes(Buffer.from(await res.arrayBuffer()));
}

// shortcut: toFixed làm tròn "nửa lên" ở ca hòa nhị phân đúng (vd 0.25h), Python làm tròn về số
// chẵn — chỉ lệch chữ số hiển thị, không đổi PASS/FAIL.
const fmt1 = (x: number) => (Object.is(x, -0) ? '-0.0' : x.toFixed(1)); // Python giữ dấu -0.0

export function expiryNote(expiresAt: unknown, nowS: number = clock.wall()): string {
  if (!expiresAt) return ''; // 0/None = "không biết"
  const exp = pyFloat(expiresAt);
  if (exp === null) return '';
  const leftS = exp - nowS;
  if (leftS <= 0) return `expires_at đã qua ${fmt1(-leftS / 3600)}h`;
  return `expires_at còn ${fmt1(leftS / 3600)}h`;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

/** Token hết hạn/thiếu nhưng có refresh_token: không --refresh → SKIP; có → refresh thật rồi getoa. */
async function refreshOrSkip(refresh: boolean, why: string, deps: PreflightDeps): Promise<Check> {
  if (!refresh) {
    return r(
      'token',
      'SKIP',
      `${why} — có refresh_token, sẽ refresh khi chạy (hoặc chạy --refresh để thử ngay)`,
    );
  }
  const doRefresh = deps.refresh;
  if (!doRefresh) {
    return r(
      'token',
      'SKIP',
      'không gọi được refresh_access_token — connectors.zalo chưa sẵn sàng',
    );
  }
  let ok: boolean;
  try {
    ok = await doRefresh();
  } catch (e) {
    return r('token', 'FAIL', `refresh_access_token crash ${errName(e)}`);
  }
  if (!ok) return r('token', 'FAIL', 'refresh_access_token trả False');
  const access = readStore(deps.tokenStore).access_token;
  if (!pyTruthy(access))
    return r('token', 'FAIL', 'refresh xong nhưng token store thiếu access_token');
  let data: unknown;
  try {
    data = await getoa(String(access), deps.fetch ?? fetch);
  } catch (e) {
    return r('token', 'FAIL', `getoa sau refresh lỗi ${errName(e)}`);
  }
  if (isOk(data)) return r('token', 'PASS', 'refresh + getoa ok');
  return r('token', 'FAIL', `token sau refresh vẫn lỗi (error=${errOf(data)})`);
}

export async function checkToken(
  env: Env,
  refresh = false,
  deps: PreflightDeps = {},
): Promise<Check> {
  const store = readStore(deps.tokenStore);
  const access = or(store.access_token, env.ZALO_ACCESS_TOKEN ?? '');
  const rtok = or(store.refresh_token, env.ZALO_REFRESH_TOKEN ?? '');
  // --refresh ép rotation THẬT kể cả khi access còn sống (reviewer M1).
  if (refresh && pyTruthy(rtok)) return refreshOrSkip(refresh, '--refresh ép rotation', deps);
  if (!pyTruthy(access)) {
    if (!pyTruthy(rtok))
      return r('token', 'FAIL', 'không có access_token lẫn refresh_token (file/env)');
    return refreshOrSkip(refresh, 'chỉ có refresh_token', deps);
  }
  let data: unknown;
  try {
    data = await getoa(String(access), deps.fetch ?? fetch);
  } catch (e) {
    return r('token', 'FAIL', `getoa lỗi ${errName(e)}`);
  }
  if (isOk(data)) {
    const note = expiryNote(store.expires_at);
    return r('token', 'PASS', `getoa ok${note ? `, ${note}` : ''}`);
  }
  if (pyTruthy(rtok)) return refreshOrSkip(refresh, `getoa error=${errOf(data)}`, deps);
  return r(
    'token',
    'FAIL',
    `access token hỏng (getoa error=${errOf(data)}), không có refresh_token`,
  );
}

/** Tự ký event giả bằng ZALO_OA_SECRET → verifySignature phải true (round-trip chứng minh flow). */
export function checkSignature(env: Env): Check {
  const secret = env.ZALO_OA_SECRET ?? '';
  if (!secret) {
    return r(
      'signature',
      'SKIP',
      'ZALO_OA_SECRET chưa set — secret thật chỉ verify được khi có event live',
    );
  }
  const ev = {
    app_id: env.ZALO_APP_ID || 'preflight',
    sender: { id: 'preflight' },
    recipient: { id: 'oa' },
    event_name: 'user_send_text',
    message: { msg_id: 'preflight', text: 'ping' },
    timestamp: String(Math.trunc(clock.wall() * 1000)),
  };
  const raw = JSON.stringify(ev);
  const mac = `mac=${createHash('sha256')
    .update(ev.app_id + raw + ev.timestamp + secret, 'utf8')
    .digest('hex')}`;
  if (verifySignature(Buffer.from(raw, 'utf8'), mac, secret)) {
    return r(
      'signature',
      'PASS',
      'round-trip mac tự ký ok — secret thật chỉ verify được khi có event live',
    );
  }
  return r('signature', 'FAIL', 'verify_signature từ chối mac tự ký đúng — check impl');
}

export async function runChecks(
  env: Env,
  refresh = false,
  deps: PreflightDeps = {},
): Promise<Check[]> {
  return [
    checkEnv(env, deps.tokenStore),
    await checkDb(env, deps),
    checkAi(env),
    await checkToken(env, refresh, deps),
    checkSignature(env),
  ];
}

export async function preflightMain(
  env: Env,
  refresh: boolean,
  deps: PreflightDeps = {},
): Promise<number> {
  const results = await runChecks(env, refresh, deps);
  console.log('[preflight] Zalo OA go-live check\n');
  for (const x of results) console.log(`${x.status.padEnd(5)} ${x.name.padEnd(11)} ${x.detail}`);
  const fails = results.filter((x) => x.status === 'FAIL').length;
  const skips = results.filter((x) => x.status === 'SKIP').length;
  const verdict = fails === 0 ? 'OK để mở public' : 'CHƯA OK — vá các mục FAIL trước';
  console.log(`\n[done] ${fails} FAIL, ${skips} SKIP — ${verdict}`);
  return fails ? 1 : 0;
}
