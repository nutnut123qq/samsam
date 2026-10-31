import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { type Db, dep, resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { saveDraft, setStatus } from '@samsam/core/ops/store';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fmtValue } from '../ceo_report/ceo-report.js';
import { dec } from '../ceo_report/dec.js';
import { vnd } from '../fin_ar_pnl/fin-common.js';
import {
  load as marketLoad,
  loadMapping as marketMapping,
  readExport,
} from '../market/market-csv.js';
import {
  type Fees,
  loadFees,
  readSettlement,
  reconcile,
  load as settleLoad,
  loadMapping as settleMapping,
} from '../settlement/settlement-csv.js';
import * as A from './bks-audit.js';
import {
  bksAuditMain,
  bksReconMain,
  type CliDeps,
  hdtvReportMain,
  type Io,
} from './bks-hdtv.command.js';
import * as R from './bks-recon.js';
import * as H from './hdtv-report.js';

// Dịch phần DB của tests/test_bks_audit.py, test_bks_recon.py, test_hdtv_report.py (+ ca liên quan
// trong test_contract_c11_p2_jobs.py, test_v14_p3_rollout_edges.py, test_settlement_overlap.py).
// DB test RIÊNG tạo từ mẫu `samsam_ts_tpl` (superuser), xóa khi xong — KHÔNG BAO GIỜ DB `samsam`.
// Mỗi test chạy trong 1 giao dịch ROLLBACK cuối; `txConn` = `TxConn` của Python: begin/commit/
// rollback của module CHỈ ghi nhận (dữ liệu ở lại trong tx test), `log` ghi mọi câu SQL (chứng minh
// chỉ SELECT). Giả mạo = superuser `set local session_replication_role = replica` trong savepoint.
// Tên người là giả lập. Dữ liệu quyết toán GIẢ `FAKESET*` nạp bằng loader TS thật (market/settlement).

const NOW = new Date('2026-10-14T09:00:00+07:00');
const OK_G = { ok: true, violations: [], matched_claims: [] };
const DRAFT_TEXT = 'Sâm Sâm — bài mẫu kiểm soát. Nội dung có sử dụng AI';
const ENQ = 'select enqueue_item($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) as id';
const CREATOR = 'agent:test-bks';
const FIX = (f: string) => repoPath('tests', 'fixtures', 'bks', f);
const PII_RE =
  /FAKESET|nguoimuagia|NGUOI NHAN GIA|DUONG GIA LAP|VDGIA|090000\d{4}|\b[0-9a-f]{16}\b/;

function capture(): Io & { o: string[]; e: string[] } {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) };
}

/** Python `TxConn`: begin/commit/rollback chỉ ghi nhận; savepoint đi thẳng; `log` = mọi SQL khác. */
function txConn(c: pg.ClientBase, log?: string[]): Db {
  return {
    query: (q: string | { text: string }, v?: unknown[]) => {
      const text = typeof q === 'string' ? q : q.text;
      const t = text.trim().toLowerCase();
      if (/^(begin|commit|rollback)\b/.test(t) && !t.startsWith('rollback to')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (!/^(savepoint|release savepoint|rollback to savepoint)\b/.test(t)) log?.push(text);
      return (c.query as (a: unknown, b?: unknown) => Promise<unknown>)(q, v);
    },
  } as unknown as Db;
}

const isRead = (sql: string): boolean => {
  const s = sql.trim().toLowerCase();
  return (
    /^(select|with)\b/.test(s) && !/\b(insert|update|delete)\b/.test(s.split(' from ')[0] ?? '')
  );
};

/** Rollout giả (giai đoạn theo `stages`, mặc định vận hành) — tính năng `tat` → RolloutBlocked thật. */
function fakeRollout(stages: Record<string, string> = {}): void {
  installFakeDeps(
    {},
    {
      quick: null,
      stages: { 'ceo-04.6': 'van_hanh', 'ceo-05': 'van_hanh', ...stages },
      reportFeature: (n) => (n.startsWith('bks-') ? 'ceo-04.6' : null),
    },
  );
  const base = dep('rollout');
  const wrap =
    <T extends unknown[], R>(fn: (...a: T) => Promise<R> | R) =>
    async (...a: T): Promise<R> => {
      try {
        return await fn(...a);
      } catch (e) {
        throw new RolloutBlocked((e as Error).message);
      }
    };
  setOpsDeps({
    rollout: {
      ...base,
      checkGenerate: wrap(base.checkGenerate),
      gateReport: wrap(base.gateReport),
    },
  });
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('bks_hdtv (DB)', () => {
  const name = testDbName('bks_hdtv');
  let pool: pg.Pool;
  let c: pg.PoolClient;
  let tmp: string;

  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(async () => {
    fakeRollout();
    tmp = mkdtempSync(join(tmpdir(), 'bks-db-'));
    c = await pool.connect();
    await c.query('begin');
  });
  afterEach(async () => {
    await c.query('rollback').catch(() => {});
    c.release();
    resetOpsDeps();
    rmSync(tmp, { recursive: true, force: true });
  });

  const q = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows;
  const one = async (sql: string, v: unknown[] = []) =>
    Object.values((await q(sql, v))[0] ?? {})[0];

  /** Superuser tắt trigger trong savepoint — ROLLBACK khi ra. */
  async function tamper(fn: () => Promise<void>): Promise<void> {
    await c.query('savepoint tamper');
    try {
      await c.query('set local session_replication_role = replica');
      await fn();
    } finally {
      await c.query('rollback to savepoint tamper');
    }
  }
  async function asRole(role: string, fn: () => Promise<void>, pre: string[] = []): Promise<void> {
    await c.query('savepoint as_role');
    try {
      for (const s of pre) await c.query(s);
      await c.query(`set local role ${role}`);
      await fn();
    } finally {
      await c.query('rollback to savepoint as_role');
    }
  }

  async function log(n = 3): Promise<number[]> {
    for (let i = 0; i < n; i++) {
      await c.query(
        "insert into agent_action_log (actor, action, detail) values ($1, 'test', $2::jsonb)",
        [`a${i}`, JSON.stringify({ i })],
      );
    }
    return (await q('select id from agent_action_log order by id')).map((r) => Number(r.id));
  }
  async function plotLogs(n = 3): Promise<number[]> {
    await c.query("insert into plots (id, location, source) values ('KV-BKS', 'x', 'manual')");
    for (let i = 0; i < n; i++) {
      await c.query(
        "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('KV-BKS', now() - $1 * interval '1 day', 'tưới', 'ok', 'Ky thuat', 'manual')",
        [i + 1],
      );
    }
    return (await q("select id from plot_logs where plot_id = 'KV-BKS' order by id")).map((r) =>
      Number(r.id),
    );
  }
  const enq = async (oid: string, qa = 'none', by = CREATOR, payload?: string) =>
    Number(
      await one(ENQ, [
        'board_pack',
        oid,
        'ceo',
        't',
        payload ?? `payload ${oid}`,
        'medium',
        JSON.stringify(OK_G),
        qa,
        by,
        48,
      ]),
    );
  const decide = (qid: number, by: string, d = 'approved') =>
    c.query('select decide_item($1, $2, $3, $4)', [qid, by, d, null]);
  const override = async (qid: number, by: string) =>
    Number(await one('select override_qa($1, $2, $3)', [qid, by, 'đã xác nhận rủi ro, ép trình']));
  async function draft(): Promise<number> {
    const tx = txConn(c);
    const did = await saveDraft(tx, {
      brief: 'brief',
      channel: 'facebook',
      text: DRAFT_TEXT,
      guardrail: OK_G,
      createdBy: CREATOR,
    });
    expect(await setStatus(tx, did, 'approved', 'Phap Che Gia Lap')).toEqual([true, null]);
    return Number(did);
  }
  async function approvedWorld(): Promise<[number, number, number]> {
    const did = await draft();
    const q1 = await enq('BP-1');
    await decide(q1, 'Hoa Gia Lap');
    const q2 = await enq('BP-2', 'fail');
    await override(q2, 'Mai Gia Lap');
    await decide(q2, 'Hoa Gia Lap');
    return [did, q1, q2];
  }
  async function window(): Promise<[Date, Date]> {
    const now = (await one('select now()')) as Date;
    return [new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 86_400_000)];
  }
  const lease =
    (logSql?: string[]): CliDeps['connect'] =>
    async () => ({
      db: txConn(c, logSql),
      release: async () => {},
    });
  const cli = (logSql?: string[], io?: Io): CliDeps => ({
    io: io ?? capture(),
    connect: lease(logSql),
    wire: () => {},
    now: NOW,
  });
  const codes = (fs: { code: string }[]) => fs.map((f) => f.code).sort();

  // ------------------------------------------------------------ W100.1 schema

  it('audit_runs append-only + CHECK; bks_reader chỉ đọc + INSERT audit_runs', async () => {
    const ins =
      "insert into audit_runs (kind, period_label, findings, report_sha256, run_by) values ($1, $2, 0, $3, 'agent:x')";
    await c.query(ins, ['recon', '2026-Q3', 'a'.repeat(64)]);
    for (const sql of ['update audit_runs set findings = 1', 'delete from audit_runs']) {
      await c.query('savepoint s');
      await expect(c.query(sql)).rejects.toThrow(/append-only/);
      await c.query('rollback to savepoint s');
    }
    for (const bad of ['2026-13', '2026-Q5', '2026-W41', '26-09']) {
      await c.query('savepoint s');
      await expect(c.query(ins, ['recon', bad, 'a'.repeat(64)])).rejects.toMatchObject({
        code: '23514',
      });
      await c.query('rollback to savepoint s');
    }
    await asRole('bks_reader', async () => {
      for (const t of [
        'agent_action_log',
        'approvals',
        'approval_queue',
        'decisions',
        'audit_runs',
      ]) {
        await c.query(`select count(*) from ${t}`);
      }
      await c.query(
        "insert into audit_runs (kind, period_label, params, findings, report_sha256, run_by) values ('inside_out', '2026-09', '{}', 0, $1, 'agent:bks_audit')",
        ['b'.repeat(64)],
      );
      await c.query('select count(*) from verify_action_log()');
      await c.query('savepoint d');
      await expect(c.query("update content_drafts set text = 'x'")).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('rollback to savepoint d');
    });
  });

  // ------------------------------------------------------------ W100.2 chuỗi

  it('chuỗi sạch rồi bị sửa (b)(c)(d)(e)', async () => {
    const ids = await log(4);
    const pids = await plotLogs(3);
    const tx = txConn(c);
    const [heads, fs] = await A.checkChains(tx, null);
    expect(fs).toEqual([]);
    expect(heads.agent_action_log?.max_id).toBe(ids[ids.length - 1]);
    expect(heads.plot_logs?.n).toBe(3);
    await tamper(async () => {
      await c.query(`update agent_action_log set detail = '{"x":1}' where id = $1`, [ids[1]]);
      expect((await A.checkChains(tx, null))[1]).toEqual([
        { code: 'chuoi_bi_sua', table: 'agent_action_log', id: ids[1], problem: 'row_hash' },
      ]);
    });
    await tamper(async () => {
      await c.query('delete from agent_action_log where id = $1', [ids[1]]);
      expect((await A.checkChains(tx, null))[1]).toEqual([
        { code: 'chuoi_bi_sua', table: 'agent_action_log', id: ids[2], problem: 'prev_hash' },
      ]);
    });
    await tamper(async () => {
      await c.query("update plot_logs set detail = 'sua' where id = $1", [pids[1]]);
      expect((await A.checkChains(tx, null))[1]).toEqual([
        { code: 'chuoi_bi_sua', table: 'plot_logs', id: pids[1], problem: 'row_hash' },
      ]);
    });
    await tamper(async () => {
      const nid = Number(
        await one(
          "insert into plot_logs (plot_id, ts, activity, source) values ('KV-BKS', now(), 'bón', 'manual') returning id",
        ),
      );
      expect((await A.checkChains(tx, null))[1]).toEqual([
        { code: 'chuoi_bi_sua', table: 'plot_logs', id: nid, problem: 'unchained' },
      ]);
    });
    expect((await A.checkChains(tx, null))[1]).toEqual([]);
  });

  it('neo đuôi bắt xóa dòng CUỐI (chuỗi thuần không thấy)', async () => {
    const ids = await log(3);
    const tx = txConn(c);
    expect(await A.latestHeads(tx)).toBeNull();
    const [heads, fs] = await A.checkChains(tx, null);
    expect(fs).toEqual([]);
    await A.recordRun(tx, 'inside_out', '2026-09', { heads }, 0, 'x', A.RUN_BY);
    const prev = await A.latestHeads(tx);
    expect(prev?.agent_action_log?.max_id).toBe(ids[2]);
    expect((await A.checkChains(tx, prev))[1]).toEqual([]);
    await tamper(async () => {
      await c.query('delete from agent_action_log where id = $1', [ids[2]]);
      expect(Number(await one('select count(*) from verify_action_log()'))).toBe(0);
      expect((await A.checkChains(tx, null))[1]).toEqual([]);
      expect((await A.checkChains(tx, await A.latestHeads(tx)))[1]).toEqual([
        {
          code: 'mat_duoi_chuoi',
          table: 'agent_action_log',
          id: ids[2],
          problem: 'dong_neo_mat,so_dong_giam',
        },
      ]);
    });
  });

  it('không kiểm được chuỗi ≠ nguyên vẹn (thiếu EXECUTE verify_plot_logs)', async () => {
    await plotLogs(2);
    await asRole('bks_reader', async () => {
      const [heads, fs] = await A.checkChains(txConn(c), null);
      expect(fs.map((f) => [f.code, f.table])).toEqual([['khong_kiem_duoc', 'plot_logs']]);
      expect(codes(fs)).not.toContain('chuoi_bi_sua');
      expect(heads.plot_logs?.n).toBe(2);
    }, ['revoke execute on function verify_plot_logs() from bks_reader']);
  });

  it('neo trỏ dòng còn nhưng row_hash khác → row_hash_khac', async () => {
    const ids = await log(2);
    const tx = txConn(c);
    const [heads] = await A.checkChains(tx, null);
    const prev = {
      agent_action_log: { ...(heads.agent_action_log as A.Head), row_hash: '0'.repeat(64) },
    };
    expect((await A.checkChains(tx, prev))[1]).toEqual([
      { code: 'mat_duoi_chuoi', table: 'agent_action_log', id: ids[1], problem: 'row_hash_khac' },
    ]);
  });

  it('heads rác đã ghi sổ → mục hỏng bị bỏ, không crash (1.0 ≠ int như json.loads)', async () => {
    await log(2);
    const tx = txConn(c);
    const good = 'a'.repeat(64);
    const pl = { max_id: null, row_hash: null, n: 0 };
    for (const bad of [
      `{"max_id": "5", "row_hash": "${good}", "n": "3"}`,
      `{"max_id": true, "row_hash": "${good}", "n": 1}`,
      `{"max_id": 1, "row_hash": "XYZ", "n": 1}`,
      `{"max_id": 1, "row_hash": "${good}", "n": -1}`,
      `{"max_id": 1.0, "row_hash": "${good}", "n": 1}`,
    ]) {
      await c.query('savepoint j');
      await c.query(
        "insert into audit_runs (kind, period_label, params, findings, report_sha256, run_by) values ('inside_out', '2026-09', $1::jsonb, 0, $2, 'agent:bks_audit')",
        [
          `{"heads": {"agent_action_log": ${bad}, "plot_logs": ${JSON.stringify(pl)}, "khac": {"max_id": 1, "row_hash": "${good}", "n": 1}}}`,
          good,
        ],
      );
      const prev = await A.latestHeads(tx);
      expect(prev, bad).toEqual({ plot_logs: pl });
      expect((await A.checkChains(tx, prev))[1]).toEqual([]);
      await c.query('rollback to savepoint j');
    }
    await A.recordRun(tx, 'inside_out', '2026-09', { heads: 'rac' }, 0, 'x', A.RUN_BY);
    expect(await A.latestHeads(tx)).toBeNull();
  });

  // ------------------------------------------------------------ W100.3 duyệt

  it('duyệt sạch rồi mỗi lần giả mạo đúng 1 mã', async () => {
    const [did, q1, q2] = await approvedWorld();
    const tx = txConn(c);
    expect(await A.checkApprovals(tx)).toEqual([]);
    await tamper(async () => {
      await c.query("update content_drafts set text = text || ' sửa' where id = $1", [did]);
      expect(await A.checkApprovals(tx)).toEqual([
        { code: 'noi_dung_lech_ban_duyet', table: 'content_drafts', id: did },
      ]);
    });
    await tamper(async () => {
      await c.query("update approval_queue set payload = 'payload khac' where id = $1", [q1]);
      expect((await A.checkApprovals(tx)).map((f) => [f.code, f.table, f.id])).toEqual([
        ['noi_dung_lech_ban_duyet', 'approval_queue', q1],
      ]);
    });
    await tamper(async () => {
      const aid = Number(
        await one(
          "insert into approvals (object_type, object_id, content_sha256, decision, approved_by) values ('x_test', '999', $1, 'approved', 'Ai Do') returning id",
          ['e'.repeat(64)],
        ),
      );
      expect(await A.checkApprovals(tx)).toEqual([
        { code: 'duyet_ngoai_function', table: 'approvals', id: aid, object_type: 'x_test' },
      ]);
    });
    await tamper(async () => {
      await c.query('update approval_queue set decided_by = created_by where id = $1', [q1]);
      expect(await A.checkApprovals(tx)).toEqual([
        { code: 'tu_duyet', table: 'approval_queue', id: q1, block: 'ceo' },
      ]);
    });
    await tamper(async () => {
      await c.query('delete from decisions where queue_id = $1', [q2]);
      expect((await A.checkApprovals(tx)).map((f) => [f.code, f.id])).toEqual([
        ['qa_fail_khong_override', q2],
      ]);
    });
  });

  it('nộp lại CÙNG object sau khi đã quyết không bị báo oan; sửa payload mục cũ thì báo', async () => {
    const tx = txConn(c);
    const q1 = await enq('BP-R');
    await decide(q1, 'Hoa Gia Lap');
    const q2 = await enq('BP-R', 'none', CREATOR, 'payload BP-R v2');
    await decide(q2, 'Hoa Gia Lap', 'rejected');
    const q3 = await enq('BP-R', 'none', CREATOR, 'payload BP-R v3');
    await decide(q3, 'Lan Gia Lap');
    expect(await A.checkApprovals(tx)).toEqual([]);
    await tamper(async () => {
      await c.query("update approval_queue set payload = 'payload BP-R v3' where id = $1", [q1]);
      expect((await A.checkApprovals(tx)).map((f) => [f.code, f.id])).toEqual([
        ['noi_dung_lech_ban_duyet', q1],
      ]);
    });
  });

  it('agent_writer tự ghi log giả vẫn `duyet_ngoai_function` (db_role bị trigger ép)', async () => {
    await approvedWorld();
    const tx = txConn(c);
    await tamper(async () => {
      const aid = Number(
        await one(
          "insert into approvals (object_type, object_id, content_sha256, decision, approved_by) values ('content_draft', '999', $1, 'approved', 'Ai Do') returning id",
          ['e'.repeat(64)],
        ),
      );
      await c.query('set local session_replication_role = origin');
      await c.query('set local session authorization agent_writer');
      await c.query(
        "insert into agent_action_log (actor, action, object_type, object_id, detail) values ('Ai Do', 'draft_approve', 'content_draft', '999', $1::jsonb)",
        [JSON.stringify({ approval_id: aid, content_sha256: 'e'.repeat(64) })],
      );
      await c.query('reset session authorization');
      expect(await one('select db_role from agent_action_log order by id desc limit 1')).toBe(
        'agent_writer',
      );
      expect(await A.checkApprovals(tx)).toEqual([
        { code: 'duyet_ngoai_function', table: 'approvals', id: aid, object_type: 'content_draft' },
      ]);
    });
  });

  it('thiếu quyền đọc approvals/decisions → khong_kiem_duoc, không []', async () => {
    await approvedWorld();
    const [start, end] = await window();
    await asRole('bks_reader', async () => {
      const tx = txConn(c);
      expect((await A.checkApprovals(tx)).map((f) => [f.code, f.table])).toEqual([
        ['khong_kiem_duoc', 'approval_queue'],
        ['khong_kiem_duoc', 'approvals'],
        ['khong_kiem_duoc', 'tu_duyet'],
        ['khong_kiem_duoc', 'approval_queue'],
      ]);
      const res = await A.checkOverrides(tx, start, end);
      expect(res.overrides).toEqual([]);
      expect(res.findings.map((f) => [f.code, f.table])).toEqual([
        ['khong_kiem_duoc', 'decisions'],
      ]);
    }, ['revoke select on approvals, decisions from bks_reader']);
  });

  // ------------------------------------------------------ W100.4 override

  it('override trong kỳ + bất thường (tự trình/tự ép tự duyệt/dồn dập/căn cứ sai)', async () => {
    await approvedWorld();
    const q3 = await enq('BP-3', 'fail');
    await override(q3, 'Lan Gia Lap');
    await decide(q3, 'Hoa Gia Lap');
    const [start, end] = await window();
    const tx = txConn(c);
    const res = await A.checkOverrides(tx, start, end);
    expect(res.overrides.length).toBe(2);
    expect(res.findings).toEqual([]);
    expect(
      (
        await A.checkOverrides(
          tx,
          new Date(start.getTime() - 9 * 864e5),
          new Date(start.getTime() - 8 * 864e5),
        )
      ).overrides,
    ).toEqual([]);
    const qx = await enq('BP-4', 'fail');
    await tamper(async () => {
      const did = Number(
        await one(
          "insert into decisions (kind, queue_id, decided_by, reason) values ('override_qa', $1, $2, 'tu ep trinh ban cua minh') returning id",
          [qx, CREATOR],
        ),
      );
      expect((await A.checkOverrides(tx, start, end)).findings.map((f) => [f.code, f.id])).toEqual([
        ['override_tu_trinh', did],
      ]);
    });
    await c.query('savepoint s');
    const q5 = await enq('BP-5', 'fail');
    const d5 = await override(q5, 'Binh Gia Lap');
    await decide(q5, 'Binh Gia Lap');
    expect((await A.checkOverrides(tx, start, end)).findings.map((f) => [f.code, f.id])).toEqual([
      ['tu_ep_tu_duyet', d5],
    ]);
    await c.query('rollback to savepoint s');
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const qd = await enq(`BP-D${i}`, 'fail');
      ids.push(await override(qd, 'Tuan Gia Lap'));
      await decide(qd, 'Hoa Gia Lap');
    }
    expect((await A.checkOverrides(tx, start, end)).findings.map((f) => [f.code, f.ids])).toEqual([
      ['override_don_dap', ids],
    ]);
    await c.query('rollback to savepoint s');
    const q6 = await enq('BP-6');
    const lid = Number(
      await one(
        "insert into decision_log (entry_kind, decided_on, topic, decision, decided_by, basis_kind, basis_id, recorded_by) values ('quyet_dinh', current_date, 'chu de', 'quyet', 'TGD Gia Lap', 'approval_queue', $1, 'Thu Ky Gia Lap') returning id",
        [q6],
      ),
    );
    expect((await A.checkOverrides(tx, start, end)).findings.map((f) => [f.code, f.id])).toEqual([
      ['can_cu_sai', lid],
    ]);
  });

  it('quyền: sạch rồi vượt (GRANT trong savepoint); function ghi lấy từ catalog', async () => {
    const tx = txConn(c);
    expect(await A.checkPrivileges(tx)).toEqual([]);
    const probe = async (grants: string[], want: string[][]) => {
      await c.query('savepoint g');
      for (const g of grants) await c.query(g);
      const got = (await A.checkPrivileges(tx)).map((f) => [f.role, f.table, f.priv]);
      expect(got).toEqual(want);
      await c.query('rollback to savepoint g');
    };
    await probe(
      ['grant update on approvals to agent_writer'],
      [['agent_writer', 'approvals', 'UPDATE']],
    );
    await probe(['grant insert on approvals to app_human'], [['app_human', 'approvals', 'INSERT']]);
    await probe(
      [
        'grant delete on content_drafts to bks_reader',
        'grant execute on function decide_item(bigint, text, text, text) to bks_reader',
      ],
      [
        ['bks_reader', 'content_drafts', 'DELETE'],
        ['bks_reader', 'function decide_item(bigint,text,text,text)', 'EXECUTE'],
      ],
    );
    await probe(
      ['grant execute on function sign_qr_lot(text, text, text, text, text) to bks_reader'],
      [['bks_reader', 'function sign_qr_lot(text,text,text,text,text)', 'EXECUTE']],
    );
    await probe(['grant select on contacts to svc_job'], [['svc_job', 'contacts', 'SELECT']]);
  });

  // ------------------------------------------------------------ W100.4 CLI

  it('--report: chỉ SELECT, ghi file, không chép payload, không ghi sổ', async () => {
    await approvedWorld();
    const logSql: string[] = [];
    const io = capture();
    const n0 = Number(await one('select count(*) from audit_runs'));
    const rc = await bksAuditMain({ report: true, month: '2026-09', outDir: tmp }, cli(logSql, io));
    expect(rc).toBe(0);
    expect(logSql.length).toBeGreaterThan(0);
    expect(logSql.filter((s) => !isRead(s))).toEqual([]);
    expect(Number(await one('select count(*) from audit_runs'))).toBe(n0);
    const text = readFileSync(join(tmp, 'bks-audit-2026-09.md'), 'utf8');
    expect(text).toContain(A.FIRST_RUN);
    expect(text).toContain('external-dep');
    expect(text).not.toContain(DRAFT_TEXT);
    expect(text).not.toContain('payload BP');
    expect(io.o.join('\n')).toContain('không ghi sổ');
  });

  it('--report --record: đúng 1 INSERT audit_runs (sha = bản báo cáo), chạy được dưới bks_reader', async () => {
    await approvedWorld();
    await log(2);
    const logSql: string[] = [];
    expect(
      await bksAuditMain(
        { report: true, record: true, month: '2026-09', outDir: tmp },
        cli(logSql),
      ),
    ).toBe(0);
    const writes = logSql.filter((s) => !isRead(s));
    expect(writes.length).toBe(1);
    expect(writes[0]?.toLowerCase().startsWith('insert into audit_runs')).toBe(true);
    const rows = await q(
      'select kind, period_label, findings, report_sha256, run_by, params from audit_runs',
    );
    expect(rows.length).toBe(1);
    expect([rows[0].kind, rows[0].period_label, rows[0].findings]).toEqual([
      'inside_out',
      '2026-09',
      0,
    ]);
    const body = readFileSync(join(tmp, 'bks-audit-2026-09.md'));
    expect(rows[0].report_sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(rows[0].run_by).toBe('agent:bks_audit');
    expect(Object.keys(rows[0].params.heads).sort()).toEqual(['agent_action_log', 'plot_logs']);
    await asRole('bks_reader', async () => {
      expect(
        await bksAuditMain({ report: true, record: true, month: '2026-09', outDir: tmp }, cli()),
      ).toBe(0);
      expect(Number(await one('select count(*) from audit_runs'))).toBe(2);
    });
    expect(readFileSync(join(tmp, 'bks-audit-2026-09.md'), 'utf8')).not.toContain(A.FIRST_RUN);
  });

  it('--dry-run: in ra stdout, không file, không sổ', async () => {
    const io = capture();
    expect(
      await bksAuditMain(
        { report: true, dryRun: true, month: '2026-09', outDir: tmp },
        cli(undefined, io),
      ),
    ).toBe(0);
    expect(existsSync(join(tmp, 'bks-audit-2026-09.md'))).toBe(false);
    expect(io.o.join('\n')).toContain('# Audit inside-out BKS');
    expect(Number(await one('select count(*) from audit_runs'))).toBe(0);
  });

  it('ceo-04.6 TẮT → [blocked] exit 2, không file, không sổ', async () => {
    fakeRollout({ 'ceo-04.6': 'tat' });
    const io = capture();
    const out = join(tmp, 'off');
    expect(
      await bksAuditMain(
        { report: true, record: true, month: '2026-09', outDir: out },
        cli(undefined, io),
      ),
    ).toBe(2);
    expect(io.e.join('\n')).toContain('[blocked]');
    expect(existsSync(out)).toBe(false);
    expect(Number(await one('select count(*) from audit_runs'))).toBe(0);
  });

  // ------------------------------------------------ đợt hợp đồng: chain_watch

  it('chain_alert: sạch → không báo; sửa → đúng 1 cảnh báo; chạy lại → dup; chạy được dưới svc_job', async () => {
    const ids = await log(4);
    await plotLogs(2);
    const tx = txConn(c);
    const r0 = await A.chainAlert(tx, {});
    expect(r0.findings).toEqual([]);
    expect(r0.alert_id).toBeNull();
    await c.query('savepoint w');
    await c.query('set local session_replication_role = replica');
    await c.query(`update agent_action_log set detail = '{"x":1}' where id = $1`, [ids[1]]);
    await c.query('set local session_replication_role = origin');
    const r = await A.chainAlert(tx, {});
    expect(r.findings.map((f) => f.code)).toEqual(['chuoi_bi_sua']);
    expect(r.alert_id).not.toBeNull();
    expect(r.routed).toBe(false);
    expect(r.dup).toBe(false);
    const row = (
      await q('select source_agent, route_error, detail from red_alerts where id = $1', [
        r.alert_id,
      ])
    )[0];
    expect(row.source_agent).toBe(A.CHAIN_AGENT);
    expect(row.route_error).toBeTruthy();
    expect(row.detail.by_code.chuoi_bi_sua).toBe(1);
    expect(row.detail.ids).toContain(ids[1]);
    const r2 = await A.chainAlert(tx, {});
    expect(r2.dup).toBe(true);
    expect(r2.alert_id).toBeNull();
    expect(
      Number(await one('select count(*) from red_alerts where source_agent = $1', [A.CHAIN_AGENT])),
    ).toBe(1);
    await c.query('rollback to savepoint w');
    await c.query('savepoint w2');
    await c.query('set local session_replication_role = replica');
    await c.query(`update agent_action_log set detail = '{"y":2}' where id = $1`, [ids[2]]);
    await c.query('set local session_replication_role = origin');
    await c.query('set local role svc_job');
    const r3 = await A.chainAlert(tx, {});
    expect(r3.alert_id).not.toBeNull();
    expect(r3.findings.map((f) => f.code)).toEqual(['chuoi_bi_sua']);
    await c.query('rollback to savepoint w2');
  });

  it('--chain-alert CLI: sạch exit 0, có phát hiện exit 1 + [ALERT]; tắt ceo-04.6 KHÔNG làm im', async () => {
    fakeRollout({ 'ceo-04.6': 'tat' });
    const ids = await log(3);
    const io = capture();
    expect(await bksAuditMain({ chainAlert: true }, { ...cli(undefined, io), routing: {} })).toBe(
      0,
    );
    expect(io.o.join('\n')).toContain('nguyên vẹn');
    await tamper(async () => {
      await c.query(`update agent_action_log set detail = '{"x":1}' where id = $1`, [ids[0]]);
      await c.query('set local session_replication_role = origin');
      const io2 = capture();
      expect(
        await bksAuditMain({ chainAlert: true }, { ...cli(undefined, io2), routing: {} }),
      ).toBe(1);
      expect(io2.e.join('\n')).toMatch(
        /\[ALERT\] 1 phát hiện chuỗi nhật ký · cảnh báo đỏ #\d+ — CHƯA thông báo/,
      );
    });
  });

  it('--chain-alert gửi cảnh báo qua SMTP theo env (không truyền sender) — như Python `_ENV`', async () => {
    const ids = await log(3);
    // Cổng đã đóng → SMTP thử kết nối thật rồi lỗi ngay (không ra mạng ngoài).
    const port = await new Promise<number>((ok) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => ok(p));
      });
    });
    const routing = {
      recipients: [{ name: 'BKS Gia Lap', role: 'bks', channel: 'email:bks@example.invalid' }],
    };
    const env = { RED_ALERT_NOTIFY: 'email', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) };
    await tamper(async () => {
      await c.query(`update agent_action_log set detail = '{"x":1}' where id = $1`, [ids[0]]);
      await c.query('set local session_replication_role = origin');
      const io = capture();
      expect(
        await bksAuditMain({ chainAlert: true }, { ...cli(undefined, io), routing, env }),
      ).toBe(1);
      const d = await q(
        'select d.ok, d.error from red_alert_deliveries d join red_alerts r on r.id = d.alert_id where r.source_agent = $1',
        [A.CHAIN_AGENT],
      );
      expect(d).toHaveLength(1);
      expect(d[0].ok).toBe(false);
      expect(d[0].error).toMatch(/^gửi lỗi: /); // đã THỬ gửi, không phải "kênh gửi chưa cấu hình"
      expect(io.e.join('\n')).toContain('CHƯA thông báo');
    });
    await tamper(async () => {
      await c.query(`update agent_action_log set detail = '{"x":2}' where id = $1`, [ids[1]]);
      await c.query('set local session_replication_role = origin');
      const sent: string[] = [];
      const io = capture();
      expect(
        await bksAuditMain(
          { chainAlert: true },
          { ...cli(undefined, io), routing, sender: async (to) => void sent.push(to) },
        ),
      ).toBe(1);
      expect(sent).toEqual(['bks@example.invalid']);
      expect(io.e.join('\n')).not.toContain('CHƯA thông báo');
    });
  });

  // ------------------------------------------------------------ bks_recon (4 nguồn)

  async function loadFixture(kind: 'sach' | 'lech'): Promise<string> {
    const tx = txConn(c);
    const [mm] = marketMapping();
    const of = FIX(`order_shopee_${kind}_MAU.csv`);
    const [rows, errs, sha] = await readExport(of, 'shopee', 'order', mm as never);
    expect(errs).toEqual([]);
    const [snap] = await marketLoad(tx, rows, 'shopee', 'order', basename(of), sha as string);
    const [sm] = settleMapping();
    const sf = FIX(`settlement_shopee_${kind}_MAU.csv`);
    const [srows, errs2, ssha] = await readSettlement(sf, 'shopee', sm);
    expect(errs2).toEqual([]);
    await settleLoad(tx, srows as never, 'shopee', basename(sf), ssha as string);
    await reconcile(tx, loadFees()[0] as Fees, ssha);
    return snap;
  }
  async function cockpitSnap(delta: number): Promise<number> {
    const payout = BigInt(String(await one('select sum(payout_vnd) from settlement_rows')));
    return Number(
      await one(
        "insert into channel_snapshots (channel, metric_id, period_kind, period_start, value, source, source_ref, captured_by) values ('shopee', 'sales.settlement_vnd', 'month', '2026-09-01', $1, 'manual_export', 'sample:bks', 'test') returning id",
        [String(payout + BigInt(delta))],
      ),
    );
  }
  const collect = (seed = 1n) => R.collect(txConn(c), '2026-09-01', seed, loadFees()[0] as Fees);

  it('fixture SẠCH → 0 phát hiện; Q = P = C', async () => {
    await loadFixture('sach');
    await cockpitSnap(0);
    const data = await collect();
    expect(R.findingsOf(data)).toEqual([]);
    expect([data.n_total, data.n_checked]).toEqual([11, 11]);
    const sh = data.src.channels.shopee as R.ChanSrc;
    expect(sh.Q?.payout).toBe(sh.P?.thuc_nhan);
    expect(sh.Q?.payout).toBe(sh.C?.value);
  });

  it('3 lệch CÀI SẴN + cockpit lệch → đúng mã + nguồn (README fixture)', async () => {
    const snap = await loadFixture('lech');
    const cid = await cockpitSnap(50000);
    const data = await collect();
    const sf = 'settlement_shopee_lech_MAU.csv';
    const got = data.row_findings.map((f) => [f.code, f.channel, f.refs.join('|')]).sort();
    expect(got).toEqual(
      [
        ['quyet_toan_lech', 'shopee', `${sf} dòng 3`],
        ['quyet_toan_khong_don', 'shopee', `${sf} dòng 13`],
        ['don_chua_quyet_toan', 'shopee', `market_snapshots#${snap} dòng 14`],
      ].sort(),
    );
    expect(
      data.row_findings.filter((f) => f.code === 'quyet_toan_lech').flatMap((f) => f.reasons),
    ).toEqual(['thuc_nhan']);
    const ds = new Map(R.diffs(data.src).map((d) => [d.code, d]));
    expect([...ds.keys()].sort()).toEqual(['cockpit_lech_quyet_toan', 'don_lech_quyet_toan']);
    expect(ds.get('don_lech_quyet_toan')?.delta).toBe(300000n);
    expect(ds.get('don_lech_quyet_toan')?.refs).toEqual([`${sf} dòng 13`]);
    expect(ds.get('cockpit_lech_quyet_toan')?.delta).toBe(-50000n);
    expect(ds.get('cockpit_lech_quyet_toan')?.refs).toContain(`channel_snapshots#${cid}`);
  });

  it('cockpit thiếu → thieu_nguon (không coi = 0)', async () => {
    await loadFixture('sach');
    expect(R.diffs((await collect()).src).map((d) => [d.code, d.pair])).toEqual([
      ['thieu_nguon', 'cockpit_lech_quyet_toan'],
    ]);
  });

  it('nhãn đã lưu bị sửa → nhan_lech; thiếu dòng recon → chua_doi_soat', async () => {
    await loadFixture('lech');
    await cockpitSnap(0);
    await tamper(async () => {
      await c.query("update recon_results set label = 'khop', reasons = '[]' where label = 'lech'");
      const fs = (await collect()).row_findings.filter((f) => f.code === 'nhan_lech');
      expect(fs.map((f) => [f.refs, f.stored, f.recomputed])).toEqual([
        [['settlement_shopee_lech_MAU.csv dòng 3'], 'khop', 'lech'],
      ]);
    });
    await tamper(async () => {
      await c.query(
        'delete from recon_results where settlement_row_id = (select min(id) from settlement_rows)',
      );
      expect((await collect()).row_findings.filter((f) => f.code === 'chua_doi_soat').length).toBe(
        1,
      );
    });
  });

  it('khoản xuất lại ở 2 file → quyet_toan_chong_ky (Q tính 1 lần), chạy được dưới bks_reader', async () => {
    await loadFixture('sach');
    const [sm] = settleMapping();
    const sf = FIX('settlement_shopee_sach_MAU.csv');
    const [srows] = await readSettlement(sf, 'shopee', sm);
    await settleLoad(txConn(c), srows as never, 'shopee', 'lan2.csv', 'f'.repeat(64));
    await asRole('bks_reader', async () => {
      const data = await collect();
      expect((data.src.channels.shopee as R.ChanSrc).Q?.n).toBe(11);
      const ck = data.row_findings.filter((f) => f.code === 'quyet_toan_chong_ky');
      expect(ck.length).toBe(1);
      expect(ck[0]?.refs).toEqual(['lan2.csv', 'settlement_shopee_sach_MAU.csv']);
      expect(R.render(data, NOW)).toContain('quyet_toan_chong_ky');
    });
  });

  it('CLI recon: không PII, chỉ SELECT, (MẪU), trỏ file + dòng, không ghi sổ', async () => {
    await loadFixture('lech');
    await cockpitSnap(50000);
    const logSql: string[] = [];
    const io = capture();
    expect(await bksReconMain({ month: '2026-09', seed: '3', outDir: tmp }, cli(logSql, io))).toBe(
      0,
    );
    expect(logSql.filter((s) => !isRead(s))).toEqual([]);
    const text = readFileSync(join(tmp, 'bks-recon-2026-09.md'), 'utf8');
    for (const body of [text, io.o.join('\n')]) expect(body).not.toMatch(PII_RE);
    expect(text).toContain('seed 3');
    expect(text).toContain('(MẪU)');
    expect(text).toContain('settlement_shopee_lech_MAU.csv dòng 13');
    expect(Number(await one('select count(*) from audit_runs'))).toBe(0);
  });

  it('CLI recon --record dưới bks_reader: đúng 1 INSERT, params seed/n_total/n_checked, cờ mẫu', async () => {
    await loadFixture('lech');
    const logSql: string[] = [];
    await asRole('bks_reader', async () => {
      expect(
        await bksReconMain({ month: '2026-09', seed: '9', record: true, outDir: tmp }, cli(logSql)),
      ).toBe(0);
      const writes = logSql.filter((s) => !isRead(s));
      expect(writes.length).toBe(1);
      expect(writes[0]?.toLowerCase().startsWith('insert into audit_runs')).toBe(true);
      await c.query('reset role'); // đọc lại bằng superuser, vẫn trong savepoint của role
      const rows = await q(
        'select kind, period_label, params, findings, run_by, is_sample from audit_runs',
      );
      expect(rows.length).toBe(1);
      expect([rows[0].kind, rows[0].period_label, rows[0].run_by]).toEqual([
        'recon',
        '2026-09',
        'agent:bks_recon',
      ]);
      expect(rows[0].params).toEqual({ seed: 9, n_total: 12, n_checked: 12 });
      expect(rows[0].findings).toBe(5); // 3 dòng cài + don_lech + thieu_nguon (cockpit thiếu)
      expect(rows[0].is_sample).toBe(true);
    });
  });

  // ------------------------------------------------------------ hdtv_report

  const stubDeps: H.HdtvDeps = {
    decisions: async () => ['## Tiến độ & Sổ quyết định', '', '- (không có)'],
    risk: async () => ['## Rủi ro pháp lý mở', '', '- (không có)'],
  };

  async function snapRow(mid: string, ch: string, month: string, value: bigint): Promise<void> {
    await c.query(
      "insert into channel_snapshots (channel, metric_id, period_kind, period_start, value, source, source_ref, captured_by) values ($1, $2, 'month', $3, $4, 'manual_export', 'sample:hdtv', 'test')",
      [ch, mid, month, String(value)],
    );
  }
  async function hdtvOverride(oid: string, when: string): Promise<void> {
    const qid = await enq(oid, 'fail', 'agent:x', `p ${oid}`);
    await c.query(
      "insert into decisions (kind, queue_id, decided_by, reason, created_at) values ('override_qa', $1, 'Mai Gia Lap', 'ép trình vì hạn hợp đồng 3 ngày', $2)",
      [qid, when],
    );
  }
  async function world(months = ['2026-07-01', '2026-08-01', '2026-09-01']): Promise<void> {
    await loadFixture('sach');
    for (const m of months) {
      const mm = BigInt(Number(m.slice(5, 7)));
      await snapRow('sales.settlement_vnd', 'shopee', m, 3_000_000n + mm * 1000n);
      await snapRow('social.followers', 'facebook', m, 1200n + mm);
    }
    await hdtvOverride('BP-1', '2026-09-10T10:00:00+07:00');
    await hdtvOverride('BP-2', '2026-09-28T10:00:00+07:00');
    await hdtvOverride('BP-3', '2026-10-02T10:00:00+07:00');
  }
  const build = (period: string, deps: H.HdtvDeps = stubDeps) =>
    H.build(txConn(c), period, NOW, { deps });

  /** Kiểm grounding ĐỘC LẬP (không gọi checkGrounded của module). */
  function ungrounded(text: string, facts: H.Fact[]): string[] {
    const NUM = /\p{Nd}[\p{Nd}.,]*/gu;
    const W = '[\\p{L}\\p{N}_]';
    const SKIP = new RegExp(
      `\\p{Nd}{2}/\\p{Nd}{2}/\\p{Nd}{4}|\\p{Nd}{4}-\\p{Nd}{2}-\\p{Nd}{2}|(?<!${W})\\p{Nd}{2}:\\p{Nd}{2}(?!${W})|(?<!${W})\\p{Nd}{4}-(?:Q[1-4]|\\p{Nd}{2})(?!${W})|#\\p{Nd}+`,
      'gu',
    );
    const strip = (t: string) => t.replace(/[.,]+$/, '');
    const known = new Set<string>();
    for (const f of facts) {
      expect(f.source.trim()).not.toBe('');
      for (const m of f.text.matchAll(NUM)) known.add(strip(m[0]));
    }
    return [...text.replace(SKIP, ' ').matchAll(NUM)]
      .map((m) => strip(m[0]))
      .filter((t) => !known.has(t));
  }

  for (const period of ['2026-09', '2026-Q3']) {
    it(`mọi số có nguồn (${period}); 7 mục đúng thứ tự; (MẪU)`, async () => {
      await world();
      const pack = await build(period);
      const [text, ok] = H.finalize(pack);
      expect(ok).toBe(true);
      expect(ungrounded(text, pack.facts)).toEqual([]);
      expect(pack.unreadable, text).toBe(0);
      expect(H.SECTION_HEADS.filter((h) => text.includes(h))).toEqual([...H.SECTION_HEADS]);
      expect(text.indexOf(H.SECTION_HEADS[0])).toBeLessThan(text.indexOf(H.SECTION_HEADS[6]));
      expect(text.split('\n')[0]).toContain('(MẪU)');
    });
  }

  it('section THẬT của nhóm ceo_misc (sổ quyết định + rủi ro pháp lý) vẫn ra trang có nguồn', async () => {
    await world();
    const pack = await H.build(txConn(c), '2026-09', NOW);
    const [text] = H.finalize(pack);
    expect(ungrounded(text, pack.facts)).toEqual([]);
    expect(pack.unreadable, text).toBe(0);
  });

  it('số chính khớp SQL độc lập (thực nhận, số override, cockpit)', async () => {
    await world();
    const [text] = H.finalize(await build('2026-09'));
    const payout = await one(
      "select sum(payout_vnd) from settlement_rows where settled_on >= '2026-09-01' and settled_on < '2026-10-01'",
    );
    expect(text).toContain(`Tổng thực nhận quyết toán kỳ: ${vnd(BigInt(String(payout)))}`);
    const n = Number(
      await one(
        "select count(*) from decisions where kind = 'override_qa' and created_at >= '2026-09-01 00:00+07' and created_at < '2026-10-01 00:00+07'",
      ),
    );
    expect(n).toBe(2);
    expect(text).toContain(`Số lần ép trình bản QA FAIL trong kỳ: ${n}`);
    const v = await one(
      "select value from channel_snapshots where metric_id = 'sales.settlement_vnd' and channel = 'shopee' and period_start = '2026-09-01'",
    );
    const row = text
      .split('\n')
      .find((x) => x.includes('(sales.settlement_vnd)') && x.includes('| shopee |'));
    expect(row).toContain(`| ${fmtValue(dec(String(v)), 'VND')} |`);
  });

  it('override chỉ trong kỳ; quý gộp đúng', async () => {
    await world();
    const [text] = H.finalize(await build('2026-09'));
    const sec = text.slice(text.indexOf(H.SECTION_HEADS[5]), text.indexOf(H.SECTION_HEADS[6]));
    const lines = sec.split('\n').filter((x) => x.startsWith('- #'));
    expect(lines.length).toBe(2);
    expect(lines.every((x) => x.includes('ceo'))).toBe(true);
    expect(sec).not.toContain('02/10/2026');
    expect(sec).toContain('Mai Gia Lap');
    expect(H.finalize(await build('2026-Q3'))[0]).toContain(
      'Số lần ép trình bản QA FAIL trong kỳ: 2',
    );
  });

  it('quý thiếu 1 tháng → [chưa đủ dữ liệu], KHÔNG cộng thiếu; last lấy tháng cuối', async () => {
    await world(['2026-07-01', '2026-09-01']);
    const [text] = H.finalize(await build('2026-Q3'));
    const rowOf = (m: string) =>
      (text.split('\n').find((x) => x.includes(`(${m})`)) as string)
        .split('|')
        .map((s) => s.trim());
    const s = rowOf('sales.settlement_vnd');
    expect(s[4]).toBe(H.NO_DATA);
    expect(s[6]).toBe(H.NOT_ENOUGH);
    expect(text).not.toContain(fmtValue(dec(3_007_000 + 3_009_000), 'VND'));
    const f = rowOf('social.followers');
    expect(f[6]).toBe(fmtValue(dec(1209), 'người'));
    expect(f[7]).toBe('last');
  });

  it('mục lỗi DB (thiếu quyền llm_usage) → 1 dòng "không đọc được", mục khác vẫn ra', async () => {
    await world();
    let text = '';
    let pack: H.Pack | undefined;
    await asRole('bks_reader', async () => {
      pack = await build('2026-09');
      [text] = H.finalize(pack);
    }, ['revoke select on llm_usage from bks_reader']);
    expect(pack?.unreadable).toBe(1);
    const sec = text.slice(text.indexOf(H.SECTION_HEADS[3]), text.indexOf(H.SECTION_HEADS[4]));
    expect(sec).toContain('*(không đọc được:');
    expect(text.split('không đọc được').length - 1).toBe(1);
    expect(text).toContain('Tổng thực nhận quyết toán kỳ:');
  });

  it('Kiểm soát BKS: chưa chạy → "chưa chạy — không kiểm chứng được"; đã chạy → số + mã băm', async () => {
    await world();
    let text = H.finalize(await build('2026-09'))[0];
    let sec = text.slice(text.indexOf(H.SECTION_HEADS[6]));
    expect(sec.split(H.NOT_RUN).length - 1).toBe(2);
    expect(sec).not.toContain('không vi phạm');
    const rid = await one(
      "insert into audit_runs (kind, period_label, findings, report_sha256, run_by) values ('inside_out', '2026-09', 4, $1, 'agent:bks_audit') returning id",
      ['ab12'.repeat(16)],
    );
    text = H.finalize(await build('2026-09'))[0];
    sec = text.slice(text.indexOf(H.SECTION_HEADS[6]));
    expect(sec.split(H.NOT_RUN).length - 1).toBe(1);
    expect(sec).toContain(`4 phát hiện · mã băm báo cáo ${'ab12'.repeat(3)} (audit_runs #${rid})`);
  });

  const hd = (io?: Io, logSql?: string[]): CliDeps => ({
    ...cli(logSql, io),
    build: { deps: stubDeps },
  });

  it('guardrail vi phạm → file có CẢNH BÁO, KHÔNG nộp (exit 1)', async () => {
    await world();
    setOpsDeps({ guardrailCheck: () => ({ ok: false, violations: [{ type: 'banned_word' }] }) });
    const io = capture();
    expect(await hdtvReportMain({ month: '2026-09', submit: true, outDir: tmp }, hd(io))).toBe(1);
    const text = readFileSync(join(tmp, 'hdtv-2026-09.md'), 'utf8');
    expect(text).toContain('CẢNH BÁO GUARDRAIL');
    expect(text).toContain('banned_word');
    expect(io.e.join('\n')).toContain('KHÔNG nộp');
    expect(
      Number(await one("select count(*) from approval_queue where object_type = 'hdtv_pack'")),
    ).toBe(0);
  });

  it('--submit --record: 1 mục pending khối ceo (risk theo cấu hình) + 1 dòng audit_runs', async () => {
    await world();
    expect(
      await hdtvReportMain({ quarter: '2026-Q3', submit: true, record: true, outDir: tmp }, hd()),
    ).toBe(0);
    expect(
      await q(
        "select object_type, object_id, block, status, risk, created_by from approval_queue where object_type = 'hdtv_pack'",
      ),
    ).toEqual([
      {
        object_type: 'hdtv_pack',
        object_id: '2026-Q3',
        block: 'ceo',
        status: 'pending',
        risk: 'high',
        created_by: 'agent:hdtv_report',
      },
    ]);
    expect(await q('select kind, period_label, run_by from audit_runs')).toEqual([
      { kind: 'hdtv_pack', period_label: '2026-Q3', run_by: 'agent:hdtv_report' },
    ]);
  });

  it('--month: chỉ đọc (không INSERT/UPDATE/DELETE), không PII', async () => {
    await world();
    const logSql: string[] = [];
    expect(await hdtvReportMain({ month: '2026-09', outDir: tmp }, hd(undefined, logSql))).toBe(0);
    expect(
      logSql.filter((s) => /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(s)),
    ).toEqual([]);
    const text = readFileSync(join(tmp, 'hdtv-2026-09.md'), 'utf8');
    expect(text).not.toContain('FAKESET');
    expect(text).not.toContain('0900000');
  });

  it('C11: --month prev = tháng vừa đóng; chạy lại → [skipped], không nhân bản', async () => {
    const io = capture();
    const d: CliDeps = { ...hd(io), now: null };
    const o = { month: 'prev', now: '2026-11-03T08:30:00+07:00', submit: true, outDir: tmp };
    expect(await hdtvReportMain(o, d)).toBe(0);
    expect(io.o.join('\n')).toContain('kỳ 2026-10');
    expect(io.o.join('\n')).toContain('[submit]');
    const io2 = capture();
    expect(await hdtvReportMain(o, { ...d, io: io2 })).toBe(0);
    expect(io2.o.join('\n')).toContain('[skipped] kỳ 2026-10 đã có mục');
    expect(
      Number(await one("select count(*) from approval_queue where object_type = 'hdtv_pack'")),
    ).toBe(1);
  });
});
