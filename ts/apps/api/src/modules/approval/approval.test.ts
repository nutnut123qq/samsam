import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { PersonSessionError, setDirectorsDir } from '@samsam/core/security/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../db/db.module.js';
import { ApprovalController } from './approval.controller.js';
import { draftGate, queueGate } from './approval.js';
import { PERSON_CONNECT, PERSON_ENV, PersonSessions } from './person-sessions.js';
import { type Any, call, type Jwks, startJwks } from './web-testing.js';

// REST "Duyệt & Lịch": quyền tab theo vai trò (Keycloak), khóa nút như Streamlit (cùng hàm cho GET
// và POST — yêu cầu giả mạo nút khóa → 403), phiên login Postgres riêng của người (mở/đóng, gắn đúng
// người đăng nhập, sai chủ = không có), chưa mở phiên → không quyết định. Pool + kết nối người GIẢ
// (0 DB, 0 mạng ngoài loopback); đường quyết định thật qua DB ở approval.db.test.ts.

const DRAFT = {
  created_at: null,
  brief: 'Bài Tết',
  channel: 'facebook',
  status: 'pending',
  reviewer: null,
  reviewed_at: null,
  review_note: null,
  scheduled_date: null,
  source: 'manual:studio',
  content_type: 'post',
  sku: null,
  is_ai: true,
  prompt_version: null,
  prompt_sha256: null,
};
const OK_G = { ok: true, violations: [] };
const BAD_G = { ok: false, violations: [{ code: 'tu_cam', detail: 'từ cấm', span: 'chữa' }] };
const drafts = [
  { ...DRAFT, id: '1', text: 'Quà Tết an lành', guardrail: OK_G, created_by: 'agent:mkt02' },
  { ...DRAFT, id: '2', text: 'chữa mọi bệnh', guardrail: BAD_G, created_by: 'agent:mkt02' },
  { ...DRAFT, id: '3', text: 'bài của lan', guardrail: OK_G, created_by: ' LAN ' },
  { ...DRAFT, id: '4', text: 'bài cũ', guardrail: OK_G, created_by: null },
  // snapshot giả ok nhưng text thật vi phạm → kiểm lại lúc hiển thị khóa Duyệt
  { ...DRAFT, id: '5', text: 'giúp chữa', guardrail: OK_G, created_by: 'agent:mkt02' },
];
const QUEUE = {
  object_type: 'koc_brief',
  object_id: 'k1',
  block: 'marketing',
  risk: 'medium',
  qa_status: 'not_required',
  created_at: new Date(0),
  due_at: null,
  status: 'pending',
};
const items = [
  {
    ...QUEUE,
    id: '11',
    title: 'Kit KOC',
    preview: 'kit an toàn',
    guardrail_ok: true,
    created_by: 'agent:mkt04',
  },
  {
    ...QUEUE,
    id: '12',
    title: 'Kit lỗi',
    preview: 'kit',
    guardrail_ok: false,
    created_by: 'agent:mkt04',
  },
];
const scheduled = [
  {
    ...DRAFT,
    id: '7',
    status: 'approved',
    scheduled_date: '2099-01-02',
    reviewer: 'Bình',
    text: 'x',
    guardrail: OK_G,
    created_by: 'agent:mkt02',
  },
];
const unscheduled = [
  {
    ...DRAFT,
    id: '8',
    status: 'approved',
    reviewer: 'Bình',
    text: 'y',
    guardrail: OK_G,
    created_by: 'agent:mkt02',
  },
];

const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('from content_drafts where status = $1')) return { rows: drafts };
    if (sql.includes('from content_drafts where id = $1'))
      return { rows: [...drafts, ...unscheduled].filter((d) => d.id === params[0]) };
    if (sql.includes('scheduled_date >= $1')) return { rows: scheduled };
    if (sql.includes('scheduled_date is null')) return { rows: unscheduled };
    if (sql.includes("where id = $1 and status = 'pending'"))
      return { rows: items.filter((q) => q.id === params[0]) };
    if (sql.includes("from approval_queue where status = 'pending'"))
      return { rows: items.filter((q) => q.block === params[params.length - 1]) };
    throw new Error(`SQL lạ: ${sql}`);
  },
};

type FakeClient = { ended: boolean; end: () => Promise<void>; on: () => void };
const clients: FakeClient[] = [];
let person = 'lan';
const connect = async (_dsn: string, login: unknown, pw: unknown) => {
  if (login !== 'lan_pg' || pw !== 'mk-dung') {
    throw new PersonSessionError('đăng nhập Postgres thất bại (OperationalError)');
  }
  const client: FakeClient = {
    ended: false,
    end: async () => {
      client.ended = true;
    },
    on: () => {},
  };
  clients.push(client);
  return { client: client as never, person, blocks: ['marketing'] };
};

let jw: Jwks;
let dir = '';
let env: Record<string, string | undefined> = {};
let app: INestApplication | undefined;

const dirCfg = (approvers: string[]) =>
  JSON.stringify({
    block: 'marketing',
    name: 'GĐ marketing (giả)',
    director_agent: 'MKT-00 (giả)',
    approver_roles: ['gd_marketing', 'tgd'],
    approvers,
    digest_recipients: [],
    object_types: { koc_brief: { sla_hours: 48, risk: 'medium' } },
    due_soon_hours: 4,
  });

beforeAll(async () => {
  jw = await startJwks();
  dir = mkdtempSync(join(tmpdir(), 'approval-web-'));
  writeFileSync(join(dir, 'marketing.json'), dirCfg(['lan']));
  writeFileSync(
    join(dir, 'users.json'),
    JSON.stringify({
      lan: { role: 'tgd', password_hash: '', db_login: 'lan_pg' },
      binh: { role: 'tgd', password_hash: '' },
    }),
  );
  setDirectorsDir(dir);
});
afterAll(async () => {
  setDirectorsDir();
  rmSync(dir, { recursive: true, force: true });
  await jw.close();
});
beforeEach(() => {
  installFakeDeps();
  person = 'lan';
  env = {
    NODE_ENV: 'test',
    OIDC_ISSUER: jw.issuer,
    OIDC_AUDIENCE: 'samsam-api',
    AUTH_USERS_FILE: join(dir, 'users.json'),
    UI_DATABASE_URL: 'postgresql://u@127.0.0.1:9/t_web',
  };
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  resetOpsDeps();
});

async function start() {
  const mod = await Test.createTestingModule({
    controllers: [ApprovalController],
    providers: [
      PersonSessions,
      { provide: PG_POOL, useValue: pool },
      { provide: PERSON_CONNECT, useValue: connect },
      { provide: PERSON_ENV, useValue: env },
    ],
  }).compile();
  const a = mod.createNestApplication({ logger: false });
  await a.listen(0, '127.0.0.1');
  app = a;
  return a;
}

const by = (xs: Any[], id: string): Any => xs.find((x) => x.id === id) ?? {};

describe('khóa nút (thuần, như Streamlit)', () => {
  const w = { ident: 'lan', role: 'tgd' };
  it('draft: thứ tự điều kiện + chế độ dev', () => {
    const g = (i: number, who = w) => draftGate(drafts[i] as never, who, env);
    expect(g(0)).toEqual({ approve: { ok: true, why: null }, reject: { ok: true, why: null } });
    expect(g(1).approve.why).toBe('Guardrail vi phạm — phải từ chối hoặc viết lại');
    expect(g(2)).toEqual({
      approve: { ok: false, why: 'Bạn là người tạo draft — cần người khác duyệt' },
      reject: { ok: true, why: null },
    });
    expect(g(3).approve.why).toBe('Draft trước v3.4 không có người tạo — từ chối rồi tạo lại');
    expect(g(4).approve.why).toBe(
      'Guardrail kiểm lại lúc hiển thị: VI PHẠM — phải từ chối hoặc viết lại',
    );
    expect(g(0, { ident: 'x', role: 'mxh' })).toEqual({
      approve: { ok: false, why: 'Vai trò `mxh` không có quyền duyệt' },
      reject: { ok: false, why: 'Vai trò `mxh` không có quyền duyệt/từ chối' },
    });
    // mxh là người tạo → vẫn được từ chối bài của mình
    expect(g(2, { ident: 'lan', role: 'mxh' }).reject.ok).toBe(true);
  });

  it('chế độ thực: người phải thuộc approvers của đúng khối + có tài khoản vai trò hợp lệ', () => {
    const enf = { ...env, APPROVAL_ENFORCE: '1' };
    expect(draftGate(drafts[0] as never, w, enf).approve).toEqual({ ok: true, why: null });
    const binh = draftGate(drafts[0] as never, { ident: 'binh', role: 'tgd' }, enf);
    expect(binh.approve.why).toBe("'binh' không thuộc người được ủy quyền duyệt khối marketing");
    expect(binh.reject.why).toBe("'binh' không thuộc người được ủy quyền duyệt khối marketing");
    const q = queueGate(items[0] as never, { ident: 'binh', role: 'tgd' }, enf);
    expect(q.approve.ok || q.reject.ok).toBe(false);
  });

  it('hàng duyệt chung: guardrail lúc vào hàng vi phạm → chỉ từ chối; agent không bao giờ duyệt', () => {
    expect(queueGate(items[1] as never, w, env)).toEqual({
      approve: { ok: false, why: 'Guardrail vi phạm — chỉ từ chối' },
      reject: { ok: true, why: null },
    });
    expect(queueGate(items[0] as never, { ident: 'agent:x', role: 'tgd' }, env).reject.why).toBe(
      "'agent:x' không phải người — agent/hệ thống KHÔNG được reject",
    );
  });
});

describe('REST /approval', () => {
  it('401 thiếu token; 403 tài khoản không có vai trò', async () => {
    const a = await start();
    expect((await call(a, 'GET', '/approval')).status).toBe(401);
    const r = await call(a, 'GET', '/approval', { token: await jw.token('lan', null) });
    expect([r.status, r.body.message]).toEqual([403, 'vai trò không có tab Duyệt & Lịch']);
  });

  it('GET: draft/lịch/hàng duyệt chung với nút đã khóa sẵn, cảnh báo chế độ dev', async () => {
    const a = await start();
    const { status, body } = await call(a, 'GET', '/approval', {
      token: await jw.token('lan', 'tgd'),
    });
    expect(status).toBe(200);
    expect(body.devWarning).toMatch(/^CHẾ ĐỘ DEV/);
    expect(body.person).toEqual({ unlocked: false, dbLogin: 'lan_pg', problem: null });
    const d1 = by(body.drafts, '1');
    expect(d1.label).toBe('#1 [facebook] Bài Tết — guardrail PASS');
    expect(d1.createdBy).toBe('Tạo bởi: agent:mkt02');
    expect(d1.guardrail).toEqual([['success', 'Guardrail: PASS — không vi phạm']]);
    expect(by(body.drafts, '2').guardrailNow).toEqual({ ok: false, codes: ['tu_cam'] });
    expect(by(body.drafts, '4').createdBy).toBe('Tạo bởi: —');
    expect(body.calendar).toMatchObject({
      canSchedule: true,
      info: null,
      unscheduled: [{ id: '8', label: '#8 [facebook] Bài Tết' }],
      scheduled: [
        {
          date: '2099-01-02',
          channel: 'facebook',
          draft: '#7',
          brief: 'Bài Tết',
          reviewer: 'Bình',
        },
      ],
    });
    expect(body.queue.blocks).toEqual(['marketing']);
    expect(body.queue.items.map((q: Any) => [q.id, q.label, q.approve.ok])).toEqual([
      ['11', '#11 [marketing/koc_brief] Kit KOC', true],
      ['12', '#12 [marketing/koc_brief] Kit lỗi', false],
    ]);
    expect(body.queue.items[0].meta).toBe(
      'Tạo bởi: agent:mkt04 · rủi ro medium · QA not_required · guardrail PASS',
    );
  });

  it('GET: vai trò không xếp lịch / không khối nào được duyệt → thông điệp như Streamlit', async () => {
    const a = await start();
    const { body } = await call(a, 'GET', '/approval', {
      token: await jw.token('lan', 'phap_che'),
    });
    expect(body.calendar).toMatchObject({
      canSchedule: false,
      unscheduled: [],
      info: 'Vai trò `phap_che` không có quyền xếp lịch — 1 bài đã duyệt đang chờ.',
    });
    expect(body.queue).toEqual({
      blocks: [],
      items: [],
      info:
        '`lan` (vai trò `phap_che`) chưa được ủy quyền duyệt khối nào — Bên B ủy quyền bằng văn ' +
        'bản rồi quản trị điền `approvers` trong data/directors/<khối>.json (không tự điền).',
    });
  });

  it('mở quyền quyết định: login riêng theo users file, gắn đúng người, đóng được', async () => {
    const a = await start();
    const lan = await jw.token('lan', 'tgd');
    const binhT = await jw.token('binh', 'tgd');
    const noLogin = await call(a, 'POST', '/approval/person', {
      token: binhT,
      body: { password: 'x' },
    });
    expect([noLogin.status, noLogin.body.message]).toEqual([
      403,
      '`binh` chưa có login Postgres riêng (users file `db_login`) — chế độ thực không ghi quyết ' +
        'định bằng login UI dùng chung. Quản trị cấp login + `human_logins` theo văn bản ủy quyền ' +
        'của Bên B (runbook 9.7).',
    ]);
    const wrong = await call(a, 'POST', '/approval/person', {
      token: lan,
      body: { password: 'mk-sai' },
    });
    expect([wrong.status, wrong.body.message]).toEqual([
      403,
      'đăng nhập Postgres thất bại (OperationalError)',
    ]);
    expect(JSON.stringify(wrong.body)).not.toContain('mk-sai');
    const ok = await call(a, 'POST', '/approval/person', {
      token: lan,
      body: { password: 'mk-dung' },
    });
    expect([ok.status, ok.body.person]).toEqual([200, 'lan']);
    const h = ok.body.handle as string;
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const st = (token: string, person?: string) =>
      call(a, 'GET', '/approval/person', { token, person });
    expect((await st(lan, h)).body.unlocked).toBe(true);
    // người khác cầm mã phiên của lan → không có phiên
    expect((await st(binhT, h)).body.unlocked).toBe(false);
    expect((await st(lan, 'ma-gia')).body.unlocked).toBe(false);
    // mở lại → phiên cũ đóng (mỗi người 1 phiên)
    const again = await call(a, 'POST', '/approval/person', {
      token: lan,
      body: { password: 'mk-dung' },
    });
    expect(clients[clients.length - 2]?.ended).toBe(true);
    expect((await st(lan, h)).body.unlocked).toBe(false);
    // PERSON_DB của Content Studio: phiên còn sống của đúng người, không cần mã phiên
    const sessions = a.get(PersonSessions);
    expect(await sessions.forUser('lan')).toBe(clients[clients.length - 1]);
    expect(await sessions.forUser('binh')).toBeNull();
    expect(
      (await call(a, 'POST', '/approval/person/close', { token: binhT, person: again.body.handle }))
        .status,
    ).toBe(200);
    expect(clients[clients.length - 1]?.ended).toBe(false); // người khác không đóng được
    expect(
      (await call(a, 'POST', '/approval/person/close', { token: lan, person: again.body.handle }))
        .status,
    ).toBe(200);
    expect(clients[clients.length - 1]?.ended).toBe(true);
    expect((await st(lan, again.body.handle)).body.unlocked).toBe(false);
  });

  it('login thuộc người khác → từ chối + đóng kết nối', async () => {
    const a = await start();
    person = 'Người Khác';
    const r = await call(a, 'POST', '/approval/person', {
      token: await jw.token('lan', 'tgd'),
      body: { password: 'mk-dung' },
    });
    expect([r.status, r.body.message]).toEqual([
      403,
      'login `lan_pg` thuộc người khác `lan` — không mở quyền quyết định',
    ]);
    expect(clients[clients.length - 1]?.ended).toBe(true);
  });

  it('quyết định draft: đầu vào xấu 400, không có 404, nút khóa 403, chưa mở phiên → không ghi', async () => {
    const a = await start();
    const t = await jw.token('lan', 'tgd');
    const post = (id: string, body: unknown, token = t) =>
      call(a, 'POST', `/approval/drafts/${id}/decide`, { token, body });
    expect((await post('1', { decision: 'ok' })).status).toBe(400);
    expect((await post('1x', { decision: 'approved' })).status).toBe(400);
    expect((await post('1', { decision: 'approved', note: 5 })).status).toBe(400);
    expect((await post('99', { decision: 'approved' })).status).toBe(404);
    const forged = await post('2', { decision: 'approved' });
    expect([forged.status, forged.body.message]).toEqual([
      403,
      'Guardrail vi phạm — phải từ chối hoặc viết lại',
    ]);
    const mxh = await post('1', { decision: 'rejected' }, await jw.token('x', 'mxh'));
    expect(mxh.status).toBe(403);
    expect((await post('1', { decision: 'approved' })).body).toEqual({
      ok: false,
      message: 'Chưa mở quyền quyết định bằng login Postgres của bạn (form phía trên).',
    });
  });

  it('xếp lịch + hàng duyệt chung: quyền vai trò, khối, guardrail trước khi cần phiên người', async () => {
    const a = await start();
    const t = await jw.token('lan', 'tgd');
    const sch = (body: unknown, token = t) =>
      call(a, 'POST', '/approval/drafts/8/schedule', { token, body });
    expect((await sch({})).body.message).toBe('Chọn ngày đăng.');
    expect((await sch({ date: '2099-01-03' }, await jw.token('lan', 'phap_che'))).status).toBe(403);
    expect((await sch({ date: '2099-01-03' })).body.ok).toBe(false);
    const q = (id: string, decision: string, token = t) =>
      call(a, 'POST', `/approval/queue/${id}/decide`, { token, body: { decision } });
    expect((await q('99', 'approved')).status).toBe(404);
    expect((await q('12', 'approved')).body.message).toBe('Guardrail vi phạm — chỉ từ chối');
    expect((await q('12', 'rejected')).body.message).toBe(
      'Chưa mở quyền quyết định bằng login Postgres của bạn (form phía trên).',
    );
    // gd_ban_hang không thuộc approver_roles của khối marketing → khối không quyết được
    const other = await q('11', 'rejected', await jw.token('lan', 'gd_ban_hang'));
    expect([other.status, other.body.message]).toEqual([
      403,
      '`lan` (vai trò `gd_ban_hang`) chưa được ủy quyền duyệt khối marketing',
    ]);
  });
});
