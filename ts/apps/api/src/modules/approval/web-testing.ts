import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Chỉ test: server JWKS cục bộ + token Keycloak giả (khóa RS256 sinh tại chỗ, 0 mạng ngoài
// loopback) + gọi REST bằng fetch — dùng chung cho test controller tab web (approval/garden/report).

export type Jwks = { issuer: string; close: () => Promise<void>; token: Signer };
type Signer = (user: string, role: string | null) => Promise<string>;

export async function startJwks(): Promise<Jwks> {
  const kp = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      req.url?.endsWith('/protocol/openid-connect/certs') ? JSON.stringify({ keys: [jwk] }) : '{}',
    );
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/realms/samsam`;
  const token: Signer = (user, role) =>
    new SignJWT({
      preferred_username: user,
      typ: 'Bearer',
      realm_access: { roles: role ? [role] : [] },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('samsam-api')
      .setSubject(`sub-${user}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(kp.privateKey);
  return { issuer, token, close: () => new Promise((r) => srv.close(() => r())) };
}

// biome-ignore lint/suspicious/noExplicitAny: thân JSON phản hồi
export type Any = Record<string, any>;

export async function call(
  app: INestApplication,
  method: string,
  path: string,
  o: { token?: string; person?: string; body?: unknown } = {},
): Promise<{ status: number; body: Any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.person) headers['x-person-session'] = o.person;
  const res = await fetch(`${await app.getUrl()}${path}`, {
    method,
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
