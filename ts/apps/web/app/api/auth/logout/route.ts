import { type NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { oidcConfig, oidcEnv, REFRESH_COOKIE, SESSION_COOKIE } from '../../../../lib/oidc';

// Đăng xuất: xóa cookie phiên + kết thúc phiên SSO ở Keycloak (không thì bấm "Đăng nhập" là vào lại
// ngay không cần mật khẩu — máy dùng chung). POST (form) — tránh đăng xuất ép bằng link.
export async function POST(req: NextRequest) {
  const env = oidcEnv();
  let to: URL;
  try {
    if (!env) throw new Error('OIDC chưa cấu hình');
    to = client.buildEndSessionUrl(await oidcConfig(env), {
      post_logout_redirect_uri: new URL('/login', env.redirectUri).href,
    });
  } catch {
    // Keycloak không với tới: vẫn xóa phiên web.
    to = new URL('/login', env?.redirectUri ?? req.url);
  }
  const res = NextResponse.redirect(to, 303);
  res.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  res.cookies.delete({ name: REFRESH_COOKIE, path: '/' });
  return res;
}
