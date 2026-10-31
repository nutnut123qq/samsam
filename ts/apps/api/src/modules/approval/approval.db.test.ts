import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { personConnect, setDirectorsDir } from '@samsam/core/security/auth';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../db/db.module.js';
import { REPORT_DIRS, ReportController } from '../ceo_report/report.controller.js';
import { GardenController } from '../garden_zalo/garden.controller.js';
import { ApprovalController } from './approval.controller.js';
import { PERSON_CONNECT, PERSON_ENV, PersonSessions } from './person-sessions.js';
import { type Any, call, type Jwks, startJwks } from './web-testing.js';

// Đường thật trên DB riêng từ mẫu (KHÔNG BAO GIỜ DB `samsam`), chế độ thực (APPROVAL_ENFORCE=1):
// ĐỌC tab bằng login TẠM `in role svc_ui` (đúng quyền roles.sql), "Mở quyền quyết định" bằng login
// NGƯỜI TẠM `in role app_human` đã ánh xạ `human_logins`, rồi duyệt mục hàng duyệt chung / duyệt
// draft / ghi nhật ký vườn qua phiên đó — DB ghi tên người của login. Người khác cầm login của người
// này → bị từ chối. Guardrail/rollout của core giả (installFakeDeps), Keycloak = JWKS cục bộ.

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('web Duyệt & Lịch + Nhật ký vườn (DB thật)', () => {
  const name = testDbName('approval_web');
  const tag = `${process.pid}_${randomBytes(3).toString('hex')}`;
  const P = [`t_web_p_${tag}`, randomBytes(12).toString('hex')] as const;
  const UI = [`t_web_ui_${tag}`, randomBytes(12).toString('hex')] as const;
  const PERSON = 'lantest';
  let admin: pg.Pool;
  let ui: pg.Pool;
  let jw: Jwks;
  let dir = '';
  let app: INestApplication;
  let draftId = '';
  let queueId = '';

  beforeAll(async () => {
    const base = await createDbFromTemplate(name);
    admin = createPool(base);
    await adminQuery(
      `create role ${P[0]} login password '${P[1]}' nosuperuser nocreatedb nocreaterole in role app_human`,
    );
    await adminQuery(
      `create role ${UI[0]} login password '${UI[1]}' nosuperuser nocreatedb nocreaterole in role svc_ui`,
    );
    await admin.query(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, '{marketing,farming}', 'test-ts')",
      [P[0], PERSON],
    );
    await admin.query(
      "insert into plots (id, location, status, source) values ('T-WEB-1', 'Khoảnh test', 'active', 'test')",
    );
    draftId = (
      await admin.query(
        `insert into content_drafts (brief, channel, text, guardrail, source, created_by, content_type, is_ai, block)
         values ('Bài test web', 'facebook', 'Quà Tết an lành', '{"ok": true, "violations": []}', 'manual:studio', 'agent:mkt02', 'post', true, 'marketing') returning id`,
      )
    ).rows[0].id;
    queueId = (
      await admin.query(
        `select enqueue_item('koc_brief', 'k-web', 'marketing', 'Kit test', 'kit an toàn', 'medium', '{"ok": true}'::jsonb, null, 'agent:mkt04', 48) as id`,
      )
    ).rows[0].id;
    const uiUrl = new URL(base);
    uiUrl.username = UI[0];
    uiUrl.password = UI[1];
    ui = createPool(uiUrl.toString());

    jw = await startJwks();
    dir = mkdtempSync(join(tmpdir(), 'approval-db-'));
    writeFileSync(
      join(dir, 'marketing.json'),
      JSON.stringify({
        block: 'marketing',
        name: 'GĐ marketing (giả)',
        director_agent: 'MKT-00 (giả)',
        approver_roles: ['gd_marketing', 'tgd'],
        approvers: [PERSON],
        digest_recipients: [],
        object_types: { koc_brief: { sla_hours: 48, risk: 'medium' } },
        due_soon_hours: 4,
      }),
    );
    writeFileSync(
      join(dir, 'users.json'),
      JSON.stringify({
        [PERSON]: { role: 'tgd', password_hash: '', db_login: P[0] },
        // người khác khai login của lantest → mở phiên phải bị từ chối
        binhtest: { role: 'tgd', password_hash: '', db_login: P[0] },
      }),
    );
    setDirectorsDir(dir);
    installFakeDeps();
    const mod = await Test.createTestingModule({
      controllers: [ApprovalController, GardenController, ReportController],
      providers: [
        PersonSessions,
        { provide: REPORT_DIRS, useValue: { out: join(dir, 'reports'), data: dir } },
        { provide: PG_POOL, useValue: ui },
        { provide: PERSON_CONNECT, useValue: personConnect },
        {
          provide: PERSON_ENV,
          useValue: {
            NODE_ENV: 'test',
            APPROVAL_ENFORCE: '1',
            OIDC_ISSUER: jw.issuer,
            OIDC_AUDIENCE: 'samsam-api',
            AUTH_USERS_FILE: join(dir, 'users.json'),
            UI_DATABASE_URL: uiUrl.toString(),
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await ui?.end();
    await admin?.end();
    await jw?.close();
    resetOpsDeps();
    setDirectorsDir();
    if (dir) rmSync(dir, { recursive: true, force: true });
    await dropDb(name);
    for (const n of [P[0], UI[0]]) await adminQuery(`drop role if exists ${n}`);
  });

  it('đọc tab bằng svc_ui: draft + mục hàng duyệt chung + khoảnh, nút Duyệt mở cho người được ủy quyền', async () => {
    const t = await jw.token(PERSON, 'tgd');
    const a = await call(app, 'GET', '/approval', { token: t });
    expect(a.status).toBe(200);
    expect(a.body.devWarning).toBeNull();
    const d = a.body.drafts.find((x: Any) => x.id === String(draftId));
    expect([d.approve, d.text]).toEqual([{ ok: true, why: null }, 'Quà Tết an lành']);
    const q = a.body.queue.items.find((x: Any) => x.id === String(queueId));
    expect([q.approve.ok, q.text]).toEqual([true, 'kit an toàn']);
    const g = await call(app, 'GET', '/garden', { token: t });
    expect(g.status).toBe(200);
    expect(g.body.plots).toContainEqual({ id: 'T-WEB-1', label: 'T-WEB-1 — Khoảnh test' });
  });

  it('báo cáo định kỳ bằng svc_ui: sinh được file (DB đọc được hay bản DEGRADED đều ghi rõ)', async () => {
    const t = await jw.token(PERSON, 'tgd');
    const r = await call(app, 'POST', '/reports/generate', { token: t, body: { days: 7 } });
    expect(r.status).toBe(200);
    // Quyền svc_ui thật (roles.sql, 30/10): KHÔNG SELECT `orders` → bản DEGRADED ("permission denied
    // for table orders") — như Streamlit chạy bằng login UI; bản đủ số cần quyết định quyền ở roles.sql.
    const one = await call(app, 'GET', `/reports/${r.body.name}`, { token: t });
    expect(one.status).toBe(200);
    expect(one.body.text).toContain('## 3. Kênh chat (convlog)');
  });

  it('mở quyền: mật khẩu sai 403; login của người khác 403; đúng người → quyết định ghi tên người của login', async () => {
    const t = await jw.token(PERSON, 'tgd');
    const wrong = await call(app, 'POST', '/approval/person', {
      token: t,
      body: { password: 'sai' },
    });
    expect([wrong.status, wrong.body.message]).toEqual([
      403,
      'đăng nhập Postgres thất bại (OperationalError)',
    ]);
    const binh = await call(app, 'POST', '/approval/person', {
      token: await jw.token('binhtest', 'tgd'),
      body: { password: P[1] },
    });
    expect([binh.status, binh.body.message]).toEqual([
      403,
      `login \`${P[0]}\` thuộc người khác \`binhtest\` — không mở quyền quyết định`,
    ]);
    const ok = await call(app, 'POST', '/approval/person', { token: t, body: { password: P[1] } });
    expect([ok.status, ok.body.person]).toEqual([200, PERSON]);
    const person = ok.body.handle as string;

    const qd = await call(app, 'POST', `/approval/queue/${queueId}/decide`, {
      token: t,
      person,
      body: { decision: 'approved', note: 'ok web' },
    });
    expect(qd.body).toEqual({ ok: true, message: `Mục #${queueId} → approved` });
    const qrow = (
      await admin.query('select status, decided_by from approval_queue where id = $1', [queueId])
    ).rows[0];
    expect(qrow).toEqual({ status: 'approved', decided_by: PERSON });

    const dd = await call(app, 'POST', `/approval/drafts/${draftId}/decide`, {
      token: t,
      person,
      body: { decision: 'approved' },
    });
    expect(dd.body).toEqual({ ok: true, message: `Draft #${draftId} → approved` });
    const drow = (
      await admin.query('select status, reviewer from content_drafts where id = $1', [draftId])
    ).rows[0];
    expect(drow).toEqual({ status: 'approved', reviewer: PERSON });

    const gl = await call(app, 'POST', '/garden/logs', {
      token: t,
      person,
      body: { plot: 'T-WEB-1', activity: 'tưới', date: '2026-10-29', detail: 'ổn' },
    });
    expect(gl.body.ok).toBe(true);
    const lrow = (
      await admin.query("select author, source from plot_logs where plot_id = 'T-WEB-1'")
    ).rows;
    expect(lrow).toEqual([{ author: PERSON, source: 'manual' }]);
  });
});
