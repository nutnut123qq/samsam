// Port `pipelines/auth.py` (_truthy, auth_mode, approval_enforced). KHÁC Python có chủ đích:
// KHÔNG đọc `.env` — chỉ biến môi trường của tiến trình (`.env` repo trỏ DB samsam thật).
export type Env = Record<string, string | undefined>;

export const AUTH_MODES = ['proxy', 'local', 'dev'] as const;
export type AuthMode = (typeof AUTH_MODES)[number] | 'blocked';

// Khoảng trắng của Python `str.strip()`: có U+001C..U+001F, U+0085; KHÔNG có U+FEFF (JS `trim` thì ngược lại).
const PY_WS =
  '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'g');

/** Python `s.strip()`. */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP, '');
}

export function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(pyStrip(v ?? '').toLowerCase());
}

/** 'proxy' | 'local' | 'dev' | 'blocked' (fail-closed: trống/lạ, hoặc dev khi DEPLOY). */
export function authMode(env: Env = process.env): AuthMode {
  const mode = pyStrip(env.AUTH_MODE ?? '').toLowerCase();
  if (!(AUTH_MODES as readonly string[]).includes(mode)) return 'blocked';
  if (mode === 'dev' && truthy(env.DEPLOY)) return 'blocked';
  return mode as AuthMode;
}

/** Chế độ thực: AUTH_MODE local|proxy, hoặc APPROVAL_ENFORCE / DEPLOY truthy. */
export function approvalEnforced(env: Env = process.env): boolean {
  const m = authMode(env);
  return m === 'local' || m === 'proxy' || truthy(env.APPROVAL_ENFORCE) || truthy(env.DEPLOY);
}
