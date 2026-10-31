import * as client from 'openid-client';

// Đăng nhập web qua Keycloak (realm samsam, deploy/compose/keycloak/realm-samsam.json) — OIDC
// Authorization Code + PKCE. Quyết định của người vẫn mở bằng login Postgres riêng (KE_HOACH.md mục 2).
// Phiên = access token (5 phút, realm `accessTokenLifespan`) + refresh token trong cookie httpOnly;
// hết hạn → làm mới bằng refresh token (hết hạn theo phiên SSO 30 phút không hoạt động) — API xác
// minh JWT bằng JWKS ở mỗi lời gọi.

export const STATE_COOKIE = 'samsam_oidc';
export const SESSION_COOKIE = 'samsam_at';
export const REFRESH_COOKIE = 'samsam_rt';

type Env = { issuer: string; clientId: string; clientSecret: string; redirectUri: string };

/** Thiếu biến → null: route trả 503, không đăng nhập "tạm" (fail-closed). */
export function oidcEnv(): Env | null {
  const e = {
    issuer: process.env.OIDC_ISSUER ?? '',
    clientId: process.env.OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? '',
  };
  return Object.values(e).every(Boolean) ? e : null;
}

let cached: Promise<client.Configuration> | undefined;

export function oidcConfig(env: Env): Promise<client.Configuration> {
  cached ??= client.discovery(new URL(env.issuer), env.clientId, env.clientSecret).catch((e) => {
    cached = undefined; // Keycloak chưa lên → lần sau thử lại
    throw e;
  });
  return cached;
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number } & Record<
  string,
  unknown
>;
type CookieOpts = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
};
type Jar = { set: (name: string, value: string, opts: CookieOpts) => unknown };

/** Ghi cookie phiên (route handler: `res.cookies`; Server Action: `await cookies()`). */
export function setSession(jar: Jar, t: Tokens): void {
  const base = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
  jar.set(SESSION_COOKIE, t.access_token, { ...base, maxAge: t.expires_in ?? 300 });
  if (t.refresh_token) {
    const rt = typeof t.refresh_expires_in === 'number' ? t.refresh_expires_in : 1800;
    jar.set(REFRESH_COOKIE, t.refresh_token, { ...base, maxAge: rt });
  }
}

/** Refresh token → token mới | null (Keycloak từ chối/hết phiên SSO/chưa cấu hình). */
export async function refreshTokens(refreshToken: string | undefined): Promise<Tokens | null> {
  const env = oidcEnv();
  if (!env || !refreshToken) return null;
  try {
    return (await client.refreshTokenGrant(await oidcConfig(env), refreshToken)) as Tokens;
  } catch {
    return null;
  }
}
