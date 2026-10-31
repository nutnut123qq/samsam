import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { approvalEnforced, type Env } from '@samsam/core/env';
import {
  type OidcConfig,
  oidcFromEnv,
  TokenError,
  tabsFor,
  verifyAccessToken,
  type WebIdentity,
} from '@samsam/core/security/auth';

// Cổng danh tính cho REST của web (thay khối đăng nhập + `ROLE_TABS` của app/streamlit_app.py):
// `Authorization: Bearer <access token Keycloak>` → danh tính; `tab` khác null → vai trò phải có tab
// đó (`auth.tabsFor`) — như Streamlit chỉ chạy khối code của tab được cấp. Thiếu cấu hình OIDC →
// 401 (fail-closed, như AUTH_MODE trống = chặn). Dùng chung cho content/rag/crm (tab Chat, Content
// Studio, Chưa trả lời, Leads) và `GET /me` (danh sách tab cho thanh điều hướng của web).

let oidc: [string, OidcConfig] | null = null;

export async function webIdentity(
  header: unknown,
  tab: string | null,
  env: Env = process.env,
): Promise<WebIdentity> {
  const m = typeof header === 'string' ? /^Bearer +(\S+)$/i.exec(header) : null;
  if (!m) throw new UnauthorizedException('thiếu access token');
  let who: WebIdentity;
  try {
    const k = `${env.OIDC_ISSUER ?? ''}\u0000${env.OIDC_AUDIENCE ?? ''}`;
    // JWKS cache theo cấu hình (jose tự cache khóa trong 1 bộ JWKS).
    if (oidc?.[0] !== k) oidc = [k, oidcFromEnv(env)];
    who = await verifyAccessToken(m[1], oidc[1]);
  } catch (e) {
    if (e instanceof TokenError) throw new UnauthorizedException(e.message);
    throw e;
  }
  if (tab !== null && !tabsFor(who.role).includes(tab)) {
    throw new ForbiddenException(`vai trò không có tab ${tab}`);
  }
  return who;
}

export type Me = { username: string; role: string | null; tabs: string[]; enforced: boolean };

/** `GET /me`: tab theo vai trò (rỗng → web báo "chưa được cấp tab nào", như Streamlit). */
export async function me(header: unknown, env: Env = process.env): Promise<Me> {
  const who = await webIdentity(header, null, env);
  return {
    username: who.username,
    role: who.role,
    tabs: [...tabsFor(who.role)],
    enforced: approvalEnforced(env),
  };
}
