import { type NextRequest, NextResponse } from 'next/server';
import { oidcEnv, REFRESH_COOKIE, refreshTokens, setSession } from '../../../../lib/oidc';
import { safeNext } from '../../../../lib/tabs';

// Trang (Server Component) không ghi được cookie → access token hết hạn thì chuyển qua đây: làm mới
// bằng refresh token rồi quay lại `next`; không làm mới được → đăng nhập lại (giữ `next`).
export async function GET(req: NextRequest) {
  const env = oidcEnv();
  if (!env) return new NextResponse('OIDC chưa cấu hình', { status: 503 });
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  const t = await refreshTokens(req.cookies.get(REFRESH_COOKIE)?.value);
  if (!t) {
    const login = new URL('/api/auth/login', env.redirectUri);
    login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }
  const res = NextResponse.redirect(new URL(next, env.redirectUri));
  setSession(res.cookies, t);
  return res;
}
