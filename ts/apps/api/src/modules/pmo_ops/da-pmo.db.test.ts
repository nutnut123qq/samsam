import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { setConnector } from '@samsam/core/rollout/rollout';
import { setDirectorsDir } from '@samsam/core/security/auth';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as pmo from './da-pmo.js';

// Dịch phần DB của tests/test_da_pmo.py + test_v15_fix_p102.py (da_pmo --set-status/--apply-due ghi
// qua *_human theo login). DB riêng dựng lại từ mẫu MỖI ca (Python: schema tạm + ROLLBACK), xóa khi
// xong. Người trong test là tên GIẢ LẬP. Dev mode trừ ca P10.2 (APPROVAL_ENFORCE=1 + users file +
// approvers khối ceo tạm).

const REAL = pmo.loadMilestones();
const APPROVER = 'TGĐ MẪU';
const PID = process.pid;
const NAME = testDbName('pmo_ops');

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('da_pmo (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  const extra: pg.Pool[] = [];
  const logins: string[] = [];
  let jobs: [string, boolean][] = [];

  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const due = async (code: string) =>
    one('select due_date::text from project_milestones where code = $1', [code]);
  const nQueue = async () => Number(await one('select count(*) from approval_queue'));

  async function cli(o: pmo.DaPmoOpts, db?: pg.Pool, env?: Record<string, string | undefined>) {
    const out: string[] = [];
    const err: string[] = [];
    const rc = await pmo.daPmoMain(o, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      connect: async () => ({ db: db ?? pool, release: async () => {} }),
      wire: () => {},
      env,
      jobRun: (async (name: string, body: (r: { ok: boolean; detail: null }) => unknown) => {
        const r = { ok: true, detail: null };
        try {
          return await body(r);
        } finally {
          jobs.push([name, r.ok]);
        }
      }) as never,
    });
    return { rc, out: out.join('\n'), err: err.join('\n') };
  }

  async function login(tag: string, person?: string): Promise<[string, pg.Pool]> {
    const name = `t_pmo_${tag}_${PID}`;
    const pw = `p${Math.random().toString(36).slice(2)}`;
    if (!logins.includes(name)) {
      await adminQuery(`drop role if exists ${name}`);
      await adminQuery(`create role ${name} login password '${pw}' in role app_human`);
      logins.push(name);
    } else await adminQuery(`alter role ${name} password '${pw}'`);
    if (person) {
      await q(
        "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, '{ceo}', 'Chu Khoi Gia Lap (test)')",
        [name, person],
      );
    }
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = name;
    u.password = pw;
    u.pathname = `/${NAME}`;
    const p = createPool(u.toString());
    extra.push(p);
    return [name, p];
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pmo-db-'));
  });
  beforeEach(async () => {
    for (const p of extra.splice(0)) await p.end();
    await pool?.end();
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    jobs = [];
  });
  afterAll(async () => {
    for (const p of extra.splice(0)) await p.end();
    await pool?.end();
    await dropDb(NAME);
    for (const r of logins) await adminQuery(`drop role if exists ${r}`);
    settings.forceMode = null;
    setConnector(null);
    resetOpsDeps();
    setDirectorsDir();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--seed hai lần không đè sửa tay; [lệch] khi DB khác file', async () => {
    let r = await cli({ seed: true, dryRun: true });
    expect(r.out).toContain(`would_insert=${REAL.length}`);
    expect(await one('select count(*) from project_milestones')).toBe('0');
    r = await cli({ seed: true });
    expect(r.out).toContain(`inserted=${REAL.length} existing=0`);
    // C05: mốc cần văn bản ký (`can_ky`) → cờ sign_required (TGĐ quyết/ký).
    const sign = Object.fromEntries(
      (await q('select code, sign_required from project_milestones')).map((x) => [
        x.code,
        x.sign_required,
      ]),
    );
    expect([sign['DUYET-1111'], sign['NGHIEM-THU-P1'], sign['MOC-A']]).toEqual([true, true, false]);
    await q("update project_milestones set due_date = '2026-11-28' where code = 'DA-05'");
    r = await cli({ seed: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`inserted=0 existing=${REAL.length}`);
    expect(r.err).toContain('[lệch] DA-05: DB giữ bản cũ');
    expect(await due('DA-05')).toBe('2026-11-28');
    // C05: cờ "mốc cần văn bản ký" theo file (chỉ cờ này).
    await q("update project_milestones set sign_required = not sign_required where code = 'DA-05'");
    await cli({ seed: true });
    const want = Boolean(REAL.find((m) => m.code === 'DA-05')?.can_ky);
    expect(await one("select sign_required from project_milestones where code = 'DA-05'")).toBe(
      want,
    );
  });

  it('--set-status: xong cần evidence, mốc lạ từ chối, trùng = no-op, agent không ghi (dev)', async () => {
    await cli({ seed: true });
    expect((await cli({ setStatus: 'DA-05', status: 'xong', by: 'X' })).rc).toBe(1);
    expect((await cli({ setStatus: 'DA-05', status: 'dang_lam', by: 'X' })).rc).toBe(0);
    const r = await cli({
      setStatus: 'DA-05',
      status: 'xong',
      by: 'X',
      evidence: 'evidence/bb-da05.md',
    });
    expect(r.rc).toBe(0);
    expect(r.err).toContain('CHẾ ĐỘ DEV'); // dev: cảnh báo, chưa đối chiếu ủy quyền
    expect(
      (
        await q("select status, evidence, updated_by from project_milestones where code = 'DA-05'")
      )[0],
    ).toEqual({ status: 'xong', evidence: 'evidence/bb-da05.md', updated_by: 'X' });
    const again = await cli({
      setStatus: 'DA-05',
      status: 'xong',
      by: 'X',
      evidence: 'evidence/bb-da05.md',
    });
    expect(again.out).toContain('no-op');
    const miss = await cli({ setStatus: 'KHONG-CO', status: 'dang_lam', by: 'X' });
    expect(miss.rc).toBe(1);
    expect(miss.err).toContain('[warn] không có mốc KHONG-CO — không ghi');
    const bot = await cli({ setStatus: 'DA-05', status: 'dang_lam', by: 'agent:da_pmo' });
    expect(bot.rc).toBe(1);
    expect(bot.err).toContain('[từ chối]');
    expect(await one("select status from project_milestones where code = 'DA-05'")).toBe('xong');
  });

  it('--board ghi file + --submit đẩy weekly_board (trùng tuần → exit 1); bảng thật duyệt được', async () => {
    await cli({ seed: true });
    let r = await cli({ board: true, date: '2026-10-25', outDir: tmp });
    expect(r.rc).toBe(0);
    const md = readFileSync(join(tmp, 'da-pmo-board-2026-10-25.md'), 'utf8');
    expect(md).toContain('**TRỄ** DA-01');
    expect(jobs).toEqual([['agents.da_pmo', true]]);
    expect(await nQueue()).toBe(0);
    r = await cli({ board: true, date: '2026-10-25', outDir: tmp, submit: true });
    expect(r.rc).toBe(0);
    const rows = await q(
      'select id::text as id, block, object_type, object_id, status, payload, created_by from approval_queue',
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      block: 'ceo',
      object_type: 'weekly_board',
      object_id: 'board:2026-W43',
      status: 'pending',
      created_by: 'agent:da_pmo',
      payload: md,
    });
    r = await cli({ board: true, date: '2026-10-24', outDir: tmp, submit: true }); // cùng W43
    expect(r.rc).toBe(1);
    expect(r.err).toContain('[warn] bảng 2026-W43 đã có mục đang chờ duyệt');
    expect(jobs.at(-1)).toEqual(['agents.da_pmo', false]);
    const [ok, msg] = await decide(pool, rows[0]?.id, APPROVER, 'approved');
    expect(ok, msg ?? '').toBe(true);
  });

  it('--submit: bảng trượt guardrail (evidence có từ cấm) → exit 1, KHÔNG đẩy; file nháp vẫn ghi', async () => {
    await cli({ seed: true });
    expect(
      (
        await cli({
          setStatus: 'MOC-C',
          status: 'dang_lam',
          by: 'X',
          evidence: 'biên bản sửa chữa máy chủ',
        })
      ).rc,
    ).toBe(0);
    const r = await cli({ board: true, date: '2026-10-25', outDir: tmp, submit: true });
    expect(r.rc).toBe(1);
    expect(r.err).toContain('trượt guardrail');
    expect(r.err).toContain('tu_cam');
    expect(r.err).toContain('KHÔNG đẩy');
    expect(await nQueue()).toBe(0);
    expect(readdirSync(tmp)).toContain('da-pmo-board-2026-10-25.md');
  });

  it('--propose-due → hàng duyệt (hạn CHƯA đổi) → --apply-due chỉ khi NGƯỜI duyệt, idempotent', async () => {
    await cli({ seed: true });
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-21', by: 'X' })).rc).toBe(1); // trùng hạn
    expect((await cli({ proposeDue: 'KHONG-CO', due: '2026-11-20', by: 'X' })).rc).toBe(1);
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-28', by: 'Chuyên viên MẪU' })).rc).toBe(
      0,
    );
    const rows = await q(
      "select id::text as id, status, object_id from approval_queue where object_type = 'milestone_change'",
    );
    expect(rows).toEqual([{ id: rows[0]?.id, status: 'pending', object_id: 'milestone:DA-05' }]);
    const qid = rows[0]?.id as string;
    expect(await due('DA-05')).toBe('2026-11-21');
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-29', by: 'X' })).rc).toBe(1); // đang chờ
    expect((await cli({ applyDue: qid, by: 'X' })).rc).toBe(1);
    expect(await due('DA-05')).toBe('2026-11-21');
    const [ok, msg] = await decide(pool, qid, APPROVER, 'approved');
    expect(ok, msg ?? '').toBe(true);
    const before = await q(
      'select code, due_date::text as d from project_milestones order by code',
    );
    expect((await cli({ applyDue: qid, by: 'X' })).rc).toBe(0);
    const after = await q('select code, due_date::text as d from project_milestones order by code');
    const diff = before.map((b, i) => [b, after[i]]).filter(([b, a]) => b?.d !== a?.d);
    expect(diff).toEqual([
      [
        { code: 'DA-05', d: '2026-11-21' },
        { code: 'DA-05', d: '2026-11-28' },
      ],
    ]);
    const r = await cli({ applyDue: qid, by: 'X' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('no-op');
    expect(await due('DA-05')).toBe('2026-11-28');
  });

  it('--apply-due: hạn sửa tay (stale) / mục bị từ chối / không tồn tại → exit 1, không đổi', async () => {
    await cli({ seed: true });
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-25', by: 'X' })).rc).toBe(0);
    const qid = (await one('select max(id)::text from approval_queue')) as string;
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    await q("update project_milestones set due_date = '2026-11-22' where code = 'DA-05'");
    const stale = await cli({ applyDue: qid, by: 'X' });
    expect(stale.rc).toBe(1);
    expect(stale.err).toContain('stale');
    expect(await due('DA-05')).toBe('2026-11-22');
    expect((await cli({ proposeDue: 'MOC-C', due: '2026-12-01', by: 'X' })).rc).toBe(0);
    const rq = (await one('select max(id)::text from approval_queue')) as string;
    expect((await decide(pool, rq, APPROVER, 'rejected'))[0]).toBe(true);
    const rej = await cli({ applyDue: rq, by: 'X' });
    expect(rej.rc).toBe(1);
    expect(rej.err).toContain(`mục #${rq} đang 'rejected' — chỉ áp dụng khi đã duyệt`);
    expect(await due('MOC-C')).toBe('2026-11-30');
    const none = await cli({ applyDue: '999999', by: 'X' });
    expect(none.rc).toBe(1);
    expect(none.err).toContain('không phải `milestone_change` khối ceo');
    const bot = await cli({ applyDue: qid, by: 'system:x' });
    expect(bot.rc).toBe(1);
    expect(bot.err).toContain('[từ chối]');
  });

  it('người đề xuất KHÔNG tự duyệt được đổi hạn của mình (created_by = người, không phải agent)', async () => {
    await cli({ seed: true });
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-28', by: 'Chuyên viên MẪU' })).rc).toBe(
      0,
    );
    const row = (
      await q(
        "select id::text as id, created_by from approval_queue where object_type = 'milestone_change'",
      )
    )[0];
    expect(row?.created_by).toBe('Chuyên viên MẪU');
    const [ok, msg] = await decide(pool, row?.id, ' Chuyên viên MẪU ', 'approved');
    expect(ok).toBe(false);
    expect(msg).toMatch(/trùng người tạo/);
    expect((await cli({ applyDue: row?.id, by: 'X' })).rc).toBe(1);
    expect(await due('DA-05')).toBe('2026-11-21');
    expect((await decide(pool, row?.id, APPROVER, 'approved'))[0]).toBe(true);
  });

  it('2 đề xuất cùng mốc đều duyệt → chỉ bản duyệt MỚI NHẤT áp dụng được (sha256)', async () => {
    await cli({ seed: true });
    const ids: string[] = [];
    for (const d of ['2026-11-28', '2026-12-02']) {
      expect((await cli({ proposeDue: 'DA-05', due: d, by: 'X' })).rc).toBe(0);
      ids.push((await one('select max(id)::text from approval_queue')) as string);
      expect((await decide(pool, ids.at(-1), APPROVER, 'approved'))[0]).toBe(true);
    }
    const old = await cli({ applyDue: ids[0], by: 'X' });
    expect(old.rc).toBe(1);
    expect(old.err).toContain('LỆCH bản duyệt (sha256)');
    expect(await due('DA-05')).toBe('2026-11-21');
    expect((await cli({ applyDue: ids[1], by: 'X' })).rc).toBe(0);
    expect(await due('DA-05')).toBe('2026-12-02');
  });

  it('đề xuất cũ khối `projects` (trước v12.0) vẫn áp dụng được sau khi người duyệt', async () => {
    await cli({ seed: true });
    expect((await cli({ proposeDue: 'DA-05', due: '2026-11-28', by: 'X' })).rc).toBe(0);
    const qid = (await one('select max(id)::text from approval_queue')) as string;
    const c = await pool.connect();
    try {
      await c.query('set session_replication_role = replica');
      await c.query("update approval_queue set block = 'projects' where id = $1", [qid]);
      await c.query('set session_replication_role = origin');
    } finally {
      c.release();
    }
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    expect((await cli({ applyDue: qid, by: 'X' })).rc).toBe(0);
    expect(await due('DA-05')).toBe('2026-11-28');
  });

  it('P10.2 chế độ thực: chỉ NGƯỜI của chính login (app_human, human_logins khối ceo) ghi trạng thái/hạn; khác người / chưa ánh xạ / agent → từ chối + authz_denied, 0 ghi', async () => {
    await cli({ seed: true });
    const CEO = 'Ceo Gia Lap (test)';
    const NOMAP = 'Khong Anh Xa (test)';
    const [ceoLogin, ceo] = await login('ceo', CEO);
    const [nomapLogin, nomap] = await login('nomap');
    // Cấu hình ủy quyền tạm: approvers khối ceo + users file (login riêng của từng người).
    const dir = mkdtempSync(join(tmp, 'directors-'));
    for (const f of readdirSync(dataPath('directors'))) {
      if (!f.endsWith('.json')) continue;
      const cfg = JSON.parse(readFileSync(dataPath('directors', f), 'utf8'));
      if (f === 'ceo.json') cfg.approvers = [CEO, NOMAP];
      writeFileSync(join(dir, f), JSON.stringify(cfg));
    }
    setDirectorsDir(dir);
    const users = join(tmp, 'users.json');
    writeFileSync(
      users,
      JSON.stringify({
        [CEO]: { role: 'tgd', password_hash: 'x', db_login: ceoLogin },
        [NOMAP]: { role: 'tgd', password_hash: 'x', db_login: nomapLogin },
      }),
    );
    const env = { ...process.env, APPROVAL_ENFORCE: '1', AUTH_USERS_FILE: users };
    const denied = async () =>
      Number(await one("select count(*) from agent_action_log where action = 'authz_denied'"));
    const snap = async () =>
      q("select status, updated_by from project_milestones where code = 'DA-05'");
    try {
      const s0 = await snap();
      const d0 = await denied();
      for (const [db, by] of [
        [ceo, 'agent:da_pmo'],
        [ceo, NOMAP], // --by khác người của login
        [nomap, NOMAP], // login chưa ánh xạ human_logins → DB 42501
      ] as const) {
        const r = await cli({ setStatus: 'DA-05', status: 'dang_lam', by }, db, env);
        expect(r.rc, by).toBe(1);
        expect(r.err).toContain('[từ chối]');
      }
      expect(await snap()).toEqual(s0);
      expect(await denied()).toBe(d0 + 3);
      const r = await cli({ setStatus: 'DA-05', status: 'dang_lam', by: CEO }, ceo, env);
      expect(r.rc, r.err).toBe(0);
      expect(await snap()).toEqual([{ status: 'dang_lam', updated_by: CEO }]);
      expect(
        await one(
          "select count(*) from agent_action_log where action = 'milestone_status' and object_id = 'DA-05' and actor = $1",
          [CEO],
        ),
      ).toBe('1');
      await expect(
        ceo.query("update project_milestones set status = 'xong' where code = 'DA-05'"),
      ).rejects.toThrow('permission denied');

      // --apply-due: THỰC THI mục đã duyệt — danh tính theo login.
      expect(
        (await cli({ proposeDue: 'DA-05', due: '2026-12-09', by: 'Chuyen Vien (test)' })).rc,
      ).toBe(0);
      const qid = (await one('select max(id)::text from approval_queue')) as string;
      expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
      for (const [db, by] of [
        [ceo, 'system:x'],
        [ceo, NOMAP],
        [nomap, NOMAP],
      ] as const) {
        const x = await cli({ applyDue: qid, by }, db, env);
        expect(x.rc, by).toBe(1);
        expect(x.err).toContain('[từ chối]');
      }
      expect(await due('DA-05')).toBe('2026-11-21');
      const ok = await cli({ applyDue: qid, by: CEO }, ceo, env);
      expect(ok.rc, ok.err).toBe(0);
      expect(
        (
          await q(
            "select due_date::text as d, updated_by from project_milestones where code = 'DA-05'",
          )
        )[0],
      ).toEqual({ d: '2026-12-09', updated_by: CEO });
      expect((await cli({ applyDue: qid, by: CEO }, ceo, env)).out).toContain('no-op');
      await expect(
        ceo.query("update project_milestones set due_date = '2027-01-01' where code = 'DA-05'"),
      ).rejects.toThrow('permission denied');
    } finally {
      setDirectorsDir();
    }
  });
});
