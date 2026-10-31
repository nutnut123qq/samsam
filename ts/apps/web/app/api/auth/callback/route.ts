import { type NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { oidcConfig, oidcEnv, STATE_COOKIE, setSession } from '../../../../lib/oidc';
import { safeNext } from '../../../../lib/tabs';

export async function GET(req: NextRequest) {
  const env = oidcEnv();
  if (!env) return new NextResponse('OIDC chưa cấu hình', { status: 503 });
  let saved: { verifier: string; state: string; next?: string };
  try {
    saved = JSON.parse(req.cookies.get(STATE_COOKIE)?.value ?? '');
  } catch {
    return new NextResponse('Phiên đăng nhập hết hạn — đăng nhập lại', { status: 400 });
  }
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    // URL gọi lại dựng từ OIDC_REDIRECT_URI (sau proxy, req.url có thể là địa chỉ nội bộ).
    const current = new URL(env.redirectUri);
    current.search = req.nextUrl.search;
    tokens = await client.authorizationCodeGrant(await oidcConfig(env), current, {
      pkceCodeVerifier: saved.verifier,
      expectedState: saved.state,
    });
  } catch {
    return new NextResponse('Đăng nhập thất bại', { status: 401 });
  }
  const res = NextResponse.redirect(new URL(safeNext(saved.next), env.redirectUri));
  res.cookies.delete({ name: STATE_COOKIE, path: '/api/auth' });
  setSession(res.cookies, tokens);
  return res;
}
