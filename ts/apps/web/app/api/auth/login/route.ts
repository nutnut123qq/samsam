import { type NextRequest, NextResponse } from 'next/server';
import * as client from 'openid-client';
import { oidcConfig, oidcEnv, STATE_COOKIE } from '../../../../lib/oidc';
import { safeNext } from '../../../../lib/tabs';

export async function GET(req: NextRequest) {
  const env = oidcEnv();
  if (!env) return new NextResponse('OIDC chưa cấu hình', { status: 503 });
  const config = await oidcConfig(env);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: env.redirectUri,
    scope: 'openid profile',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
  });
  // `next`: trang quay về sau đăng nhập (chỉ đường dẫn nội bộ).
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, JSON.stringify({ verifier, state, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 600,
  });
  return res;
}
