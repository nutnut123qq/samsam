import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataPath } from '../paths.js';
import golden from './__fixtures__/auth.golden.json' with { type: 'json' };
import {
  type AuthorizeOpts,
  authorize,
  BLOCKS,
  canApprove,
  canSchedule,
  decidableBlocks,
  isHuman,
  loadBlockConfig,
  loadUsers,
  normName,
  ROLE_TABS,
  ROLES,
  setDirectorsDir,
  TABS,
  TokenError,
  tabsFor,
  type UserEntry,
  validateBlockConfig,
  verifyAccessToken,
} from './auth.js';

// Golden: pipelines.auth.authorize/decidable_blocks/is_human + director.validate (Python thật) trên
// bản sao data/directors có approvers GIẢ (sales/finance/marketing) + users GIẢ — như
// tests/test_v13_c04_authz.py. Không có người thật nào trong cấu hình repo.
const G = golden as unknown as {
  approvers: Record<string, string[]>;
  users: Record<string, UserEntry>;
  kws: Record<string, unknown>[];
  whys: (string | null)[];
  authorize: [boolean, unknown, string | null, string, number, [boolean, number]][];
  decidable: { enforced: boolean; ident: unknown; role: unknown; out: string[] }[];
  is_human: Record<string, boolean>;
  validate: { name: string; error: string | null }[];
};
const ENF = { APPROVAL_ENFORCE: '1' };

function opts(
  kw: Record<string, unknown>,
  enforced: boolean,
  users: Map<string, UserEntry>,
): AuthorizeOpts {
  return {
    createdBy: kw.created_by as string | undefined,
    role: kw.role as string | undefined,
    dbLogin: kw.db_login as string | undefined,
    via: kw.via as string | undefined,
    allow: kw.allow as string[] | undefined,
    allowSrc: kw.allow_src as string | undefined,
    users,
    env: enforced ? ENF : {},
  };
}

describe('authorize / decidableBlocks ↔ Python (golden)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-dir-'));
  const users = new Map(Object.entries(G.users));
  beforeAll(() => {
    cpSync(dataPath('directors'), dir, { recursive: true });
    for (const [b, who] of Object.entries(G.approvers)) {
      const p = join(dir, `${b}.json`);
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), approvers: who }));
    }
    setDirectorsDir(dir);
  });
  afterAll(() => {
    setDirectorsDir();
    rmSync(dir, { recursive: true, force: true });
  });

  it('authorize khớp từng ca (dev + chế độ thực, allow, ui/cli, tự duyệt…)', () => {
    const bad = G.authorize
      .map(([enf, by, block, action, k, [ok, w]]) => {
        const got = authorize(by, block, action, opts(G.kws[k], enf, users));
        const want = { ok, why: G.whys[w] };
        return JSON.stringify(got) === JSON.stringify(want)
          ? null
          : { enf, by, block, action, kw: G.kws[k], got, want };
      })
      .filter(Boolean);
    expect(bad.slice(0, 3)).toEqual([]);
    expect(G.authorize.length).toBeGreaterThan(2000);
  });

  it('decidableBlocks khớp', () => {
    for (const c of G.decidable) {
      expect(decidableBlocks(c.ident, c.role, c.enforced ? ENF : {}), JSON.stringify(c)).toEqual(
        c.out,
      );
    }
  });

  it('approvers THẬT của repo rỗng → chế độ thực không ai duyệt được (fail-closed)', () => {
    setDirectorsDir();
    for (const b of BLOCKS) {
      const r = authorize('Bất Kỳ Ai', b, 'approve', { role: 'tgd', via: 'ui', env: ENF, users });
      expect(r.ok).toBe(false);
      expect(r.why).toContain('CHƯA có người được Bên B ủy quyền');
    }
    setDirectorsDir(dir);
  });
});

describe('isHuman / director.validate / vai trò × tab ↔ Python', () => {
  it('isHuman', () => {
    for (const [name, want] of Object.entries(G.is_human)) expect(isHuman(name), name).toBe(want);
    expect(isHuman(null)).toBe(false);
    expect(normName('  Lê   Văn\u00a0A ')).toBe('lê văn a');
  });

  it('validateBlockConfig: thông điệp lỗi như Python', () => {
    const base = JSON.parse(readFileSync(dataPath('directors/sales.json'), 'utf8'));
    const mut: Record<string, (c: Record<string, unknown>) => unknown> = {
      not_obj: () => [],
      block: (c) => ({ ...c, block: 'xx' }),
      name: (c) => ({ ...c, name: '  ' }),
      roles_empty: (c) => ({ ...c, approver_roles: [] }),
      roles_stray: (c) => ({ ...c, approver_roles: ['tgd', 'boss'] }),
      approvers: (c) => ({ ...c, approvers: 'x' }),
      digest: (c) => ({ ...c, digest_recipients: [1] }),
      types_empty: (c) => ({ ...c, object_types: {} }),
      type_bad: (c) => ({ ...c, object_types: { content_draft: {} } }),
      sla: (c) => ({ ...c, object_types: { abc: { sla_hours: 0, risk: 'low' } } }),
      sla_bool: (c) => ({ ...c, object_types: { abc: { sla_hours: true, risk: 'low' } } }),
      risk: (c) => ({ ...c, object_types: { abc: { sla_hours: 2, risk: 'x' } } }),
      due: (c) => ({ ...c, due_soon_hours: 721 }),
    };
    for (const v of G.validate) {
      const run = () => validateBlockConfig(mut[v.name](base), 'sales');
      if (v.error === null) expect(run, v.name).not.toThrow();
      else expect(run, v.name).toThrow(v.error);
    }
  });

  it('loadBlockConfig: số nguyên viết dạng thực (24.0) bị từ chối như Python isinstance(v, int)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-int-'));
    try {
      const raw = readFileSync(dataPath('directors/sales.json'), 'utf8');
      writeFileSync(
        join(dir, 'sales.json'),
        raw.replace(/"due_soon_hours":\s*\d+/, '"due_soon_hours": 24.0'),
      );
      expect(() => loadBlockConfig('sales', dir)).toThrow('sales: due_soon_hours phải 1..720');
      writeFileSync(join(dir, 'sales.json'), raw);
      expect(loadBlockConfig('sales', dir).block).toBe('sales');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ma trận 6 vai trò × 7 tab; vai trò lạ → không tab/quyền', () => {
    expect(TABS).toHaveLength(7);
    expect(Object.keys(ROLE_TABS)).toEqual([...ROLES]);
    for (const r of ROLES) {
      expect(tabsFor(r).every((t) => (TABS as readonly string[]).includes(t))).toBe(true);
      expect(tabsFor(r)).toContain('Duyệt & Lịch');
    }
    expect(tabsFor('tgd')).toEqual(TABS);
    for (const bad of ['', 'TGD', 'admin', null, 5]) {
      expect(tabsFor(bad)).toEqual([]);
      expect(canApprove(bad) || canSchedule(bad)).toBe(false);
    }
    expect([canApprove('phap_che'), canApprove('mxh'), canSchedule('mxh')]).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe('loadUsers (fail-closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-users-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('thiếu / rỗng / {} / chỉ _doc / JSON hỏng / không phải object → rỗng; entry lạ bị bỏ', () => {
    const f = join(dir, 'u.json');
    expect(loadUsers(join(dir, 'khong_co.json')).size).toBe(0);
    for (const body of [
      '',
      '{}',
      '{"_doc": "x"}',
      '{hỏng',
      '[1]',
      '"x"',
      '\ufeff{"a": {"role": "tgd"}}',
    ]) {
      writeFileSync(f, body);
      expect(loadUsers(f).size, body).toBe(0);
    }
    writeFileSync(
      f,
      JSON.stringify({
        ' Lan@X.vn ': { role: 'tgd', db_login: ' LOGIN_LAN ' },
        b: { role: 'boss' },
        c: 'tgd',
        _x: { role: 'tgd' },
        d: { role: 'mxh', password_hash: 5, db_login: '  ' },
      }),
    );
    const u = loadUsers(f);
    expect([...u.entries()]).toEqual([
      ['lan@x.vn', { role: 'tgd', password_hash: '', db_login: 'login_lan' }],
      ['d', { role: 'mxh', password_hash: '' }],
    ]);
    expect(loadUsers(undefined, { AUTH_USERS_FILE: f }).size).toBe(2);
  });
});

describe('verifyAccessToken (Keycloak, JWKS sinh tại chỗ)', () => {
  const ISS = 'https://kc.test/realms/samsam';
  const AUD = 'samsam-api';
  let jwks: ReturnType<typeof createLocalJWKSet>;
  type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let priv: Key;
  let other: Key;
  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    priv = kp.privateKey;
    other = (await generateKeyPair('RS256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });
  const sign = (
    claims: Record<string, unknown>,
    o: { key?: Key; iss?: string; aud?: string; exp?: string } = {},
  ) =>
    new SignJWT({
      typ: 'Bearer',
      preferred_username: 'Lan.Anh',
      realm_access: { roles: ['tgd', 'offline_access'] },
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? ISS)
      .setAudience(o.aud ?? AUD)
      .setSubject('u-1')
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '5m')
      .sign(o.key ?? priv);

  it('token hợp lệ → danh tính + 1 vai trò; không vai trò → null', async () => {
    const cfg = { issuer: ISS, audience: AUD, jwks };
    expect(await verifyAccessToken(await sign({ email: 'Lan@X.VN' }), cfg)).toEqual({
      username: 'lan.anh',
      email: 'lan@x.vn',
      role: 'tgd',
      sub: 'u-1',
    });
    expect(
      (await verifyAccessToken(await sign({ realm_access: { roles: ['x'] } }), cfg)).role,
    ).toBeNull();
  });

  it('sai issuer/audience/khóa, hết hạn, HS256, ID token, nhiều vai trò, thiếu username → TokenError', async () => {
    const cfg = { issuer: ISS, audience: AUD, jwks };
    const bad = [
      await sign({}, { iss: 'https://evil/realms/samsam' }),
      await sign({}, { aud: 'account' }),
      await sign({}, { key: other }),
      await sign({}, { exp: '-1m' }),
      await new SignJWT({ preferred_username: 'x' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISS)
        .setAudience(AUD)
        .setSubject('s')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('k'.repeat(32))),
      await sign({ typ: 'ID' }),
      await sign({ realm_access: { roles: ['tgd', 'mxh'] } }),
      await sign({ preferred_username: '  ' }),
      'abc.def.ghi',
      '',
    ];
    for (const t of bad) await expect(verifyAccessToken(t, cfg)).rejects.toThrow(TokenError);
  });
});
