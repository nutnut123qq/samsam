import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import {
  callHuman,
  cliGate,
  cliIdentity,
  denyLog,
  HumanDenied,
  HumanError,
  PersonSessionError,
  personConnect,
  sessionLogin,
  type UserEntry,
} from './auth.js';

// Dịch tests/test_safety_s04_identity.py (person_connect) + test_v14_p2/test_v15_p10 (cli_gate,
// cli_identity, call_human, deny_log): DB riêng từ mẫu + login Postgres TẠM (không superuser/owner)
// `in role app_human|svc_ui`; người/khối là dữ liệu GIẢ. KHÔNG BAO GIỜ DB `samsam`.
const ENF = { APPROVAL_ENFORCE: '1', NODE_ENV: 'test' };
const P_MKT = 'Marketing Giả TS';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('auth (DB thật, login tạm)', () => {
  const name = testDbName('security');
  const tag = `${process.pid}_${randomBytes(3).toString('hex')}`;
  const L = {
    mkt: [`t_sec_mkt_${tag}`, randomBytes(12).toString('hex')],
    unmapped: [`t_sec_un_${tag}`, randomBytes(12).toString('hex')],
    ui: [`t_sec_ui_${tag}`, randomBytes(12).toString('hex')],
  } as const;
  const roleOf = { mkt: 'app_human', unmapped: 'app_human', ui: 'svc_ui' } as const;
  let admin: pg.Pool;
  let base = '';
  const asUrl = (who: keyof typeof L) => {
    const u = new URL(base);
    u.username = L[who][0];
    u.password = L[who][1];
    return u.toString();
  };
  const denies = async (objectId: string) =>
    (
      await admin.query(
        "select actor, object_type, detail from agent_action_log where action = 'authz_denied' and object_id = $1 order by id",
        [objectId],
      )
    ).rows;

  beforeAll(async () => {
    base = await createDbFromTemplate(name);
    admin = createPool(base);
    for (const k of Object.keys(L) as (keyof typeof L)[]) {
      await adminQuery(
        `create role ${L[k][0]} login password '${L[k][1]}' nosuperuser nocreatedb nocreaterole in role ${roleOf[k]}`,
      );
    }
    await admin.query(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, '{marketing}', 'test-ts')",
      [L.mkt[0], P_MKT],
    );
  });
  afterAll(async () => {
    await admin?.end();
    await dropDb(name);
    for (const [n] of Object.values(L)) await adminQuery(`drop role if exists ${n}`);
  });

  it('personConnect: chỉ login NGƯỜI đã ánh xạ; ghi bằng chứng đăng nhập; không lộ mật khẩu', async () => {
    const s = await personConnect(base, ` ${L.mkt[0].toUpperCase()} `, L.mkt[1]);
    try {
      expect([s.person, s.blocks]).toEqual([P_MKT, ['marketing']]);
      expect(await sessionLogin(s.client)).toBe(L.mkt[0]);
    } finally {
      await s.client.end();
    }
    const checks = await admin.query('select person from human_login_checks where db_login = $1', [
      L.mkt[0],
    ]);
    expect(checks.rows).toEqual([{ person: P_MKT }]);
    for (const who of ['ui', 'unmapped'] as const) {
      await expect(personConnect(base, L[who][0], L[who][1])).rejects.toThrow(PersonSessionError);
    }
    await expect(personConnect(base, L.unmapped[0], L.unmapped[1])).rejects.toThrow(
      'chưa được ánh xạ người',
    );
    const wrong = personConnect(base, L.mkt[0], `sai-${L.mkt[1]}`);
    await expect(wrong).rejects.toThrow('đăng nhập Postgres thất bại');
    await wrong.catch((e: Error) => expect(e.message).not.toContain(L.mkt[1]));
    for (const [login, pw] of [
      ['x; drop role y', 'p'],
      ['', 'p'],
      [L.mkt[0], ''],
      [5, 'p'],
    ]) {
      await expect(personConnect(base, login, pw)).rejects.toThrow(PersonSessionError);
    }
    // Superuser (owner) bị từ chối dù xác thực đúng.
    const su = new URL(base);
    await expect(personConnect(base, su.username, decodeURIComponent(su.password))).rejects.toThrow(
      'SUPERUSER',
    );
  });

  it('personConnect từ chối DB samsam khi NODE_ENV=test (trước khi mở kết nối)', async () => {
    const u = new URL(base);
    u.pathname = '/samsam';
    await expect(personConnect(u.toString(), L.mkt[0], L.mkt[1])).rejects.toThrow('DB thật');
  });

  it('denyLog: chỉ chế độ thực; Pool → ghi; client trong giao dịch → kết nối phụ, bền dù caller rollback', async () => {
    await denyLog(admin, 'Ai Đó', 'sales', 'approve', 'approval_queue', 'dev-1', 'x', {
      NODE_ENV: 'test',
    });
    expect(await denies('dev-1')).toEqual([]);
    await denyLog(admin, '  ', 'sales', 'approve', 'approval_queue', 'p-1', 'r'.repeat(400), ENF);
    const [row] = await denies('p-1');
    expect([row.actor, row.object_type, row.detail.reason.length, row.detail.block]).toEqual([
      '(trống)',
      'approval_queue',
      300,
      'sales',
    ]);
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('select 1');
      await denyLog(c, 'Người Tx', 'sales', 'approve', 'approval_queue', 'tx-1', 'trong tx', ENF);
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect((await denies('tx-1')).map((r) => r.actor)).toEqual(['Người Tx']);
    await denyLog(admin, 42, 'sales', 'approve', 'q', 'num-1', 'x', ENF); // Python: by không phải chuỗi → bỏ
    expect(await denies('num-1')).toEqual([]);
  });

  it('cliGate / cliIdentity chế độ thực: --by phải khớp login DB; bị chặn → authz_denied', async () => {
    const pool = createPool(asUrl('mkt'));
    try {
      const users = new Map<string, UserEntry>([
        ['lan', { role: 'gd_marketing', password_hash: '', db_login: L.mkt[0] }],
        ['khac', { role: 'gd_marketing', password_hash: '', db_login: 'login_khac' }],
      ]);
      const allow = ['Lan'];
      expect(
        await cliGate(pool, 'Lan', 'marketing', 'sign', 'qr_lot', 'g-1', {
          allow,
          users,
          env: ENF,
        }),
      ).toBeNull();
      const why = await cliGate(pool, 'Khac', 'marketing', 'sign', 'qr_lot', 'g-2', {
        allow: ['Khac'],
        users,
        env: ENF,
      });
      expect(why).toContain('--by không khớp login Postgres');
      expect((await denies('g-2')).map((r) => [r.actor, r.detail.action])).toEqual([
        ['Khac', 'sign'],
      ]);
      const warns: string[] = [];
      expect(
        await cliGate(pool, 'Ai', 'marketing', 'sign', 'q', 'g-3', {
          env: { NODE_ENV: 'test' },
          warn: (m) => warns.push(m),
        }),
      ).toBeNull();
      expect(warns[0]).toContain('CHẾ ĐỘ DEV');
      expect(
        await cliGate(pool, 'agent:x', 'marketing', 'sign', 'q', 'g-4', {
          env: { NODE_ENV: 'test' },
        }),
      ).toContain('không phải người');
      expect(await cliIdentity(pool, 'Lan', 'b2b_quote', 'i-1', { users, env: ENF })).toBeNull();
      expect(await cliIdentity(pool, 'Khac', 'b2b_quote', 'i-2', { users, env: ENF })).toContain(
        '--by không khớp',
      );
      expect(await cliIdentity(pool, 'Vô Danh', 'b2b_quote', 'i-3', { users, env: ENF })).toContain(
        'chưa có tài khoản',
      );
      expect(
        await cliIdentity(pool, 'system:x', 'b2b_quote', 'i-4', {
          users,
          env: { NODE_ENV: 'test' },
        }),
      ).toContain('không ghi thay người');
      expect((await denies('i-2')).map((r) => r.detail.action)).toEqual(['record']);
    } finally {
      await pool.end();
    }
  });

  it('callHuman: 42501 → HumanDenied + authz_denied; P0001 → HumanError (không kèm DETAIL)', async () => {
    const pool = createPool(asUrl('mkt'));
    try {
      const o = {
        by: P_MKT,
        block: 'marketing',
        action: 'approve',
        objectType: 'human_logins',
        objectId: 'h-1',
        env: ENF,
      };
      const denied = callHuman(
        pool,
        "insert into human_logins (db_login, person, granted_by) values ('x_y', 'X', 't')",
        [],
        o,
      );
      await expect(denied).rejects.toThrow(HumanDenied);
      expect((await denies('h-1')).map((r) => r.actor)).toEqual([P_MKT]);
      await expect(
        callHuman(
          pool,
          "do $$ begin raise exception 'trạng thái đã đổi' using detail = 'bí mật'; end $$",
          [],
          {
            ...o,
            objectId: 'h-2',
          },
        ),
      ).rejects.toThrow(new HumanError('trạng thái đã đổi'));
      expect(await denies('h-2')).toEqual([]);
      const ok = await callHuman<{ x: number }>(pool, 'select $1::int as x', [7], o);
      expect(ok.rows).toEqual([{ x: 7 }]);
    } finally {
      await pool.end();
    }
  });
});
