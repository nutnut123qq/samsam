import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { periodBounds, rollingBounds } from '@samsam/core/ops/period';
import { generate } from '@samsam/core/ops/report';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CeoReportOpts,
  type CliDeps,
  type CockpitOpts,
  ceoReportMain,
  cockpitMain,
} from './ceo-report.command.js';
import {
  build,
  computeSections,
  finalize,
  render,
  SECTION_HEADS,
  setCeoSections,
} from './ceo-report.js';
import {
  approvalTimes,
  CAPTURED_BY,
  collectChat,
  collectInternal,
  csvSourceRef,
  internalRow,
  loadMetrics,
  MKT_METRICS,
  readCsv,
  type SnapRow,
  store,
} from './cockpit.js';
import { dec, decStr } from './dec.js';
import * as mm from './mkt-metrics.js';

// Dịch phần DB của tests/test_cockpit.py, tests/test_ceo_report.py, tests/test_mkt_metrics.py,
// tests/test_v14_p3_rollout_edges.py::test_cockpit_collect_off_not_written và phần ceo_report của
// tests/test_v14_p2_service_auth.py (login svc_job ra cùng trang). DB riêng dựng lại từ mẫu MỖI ca
// (Python: schema tạm + ROLLBACK), xóa khi xong — KHÔNG BAO GIỜ DB `samsam`. Mốc quá khứ của
// approval_queue chèn bằng superuser `session_replication_role = replica` (bỏ trigger) như Python.
// Số trong fixture là số MẪU bịa; tên người là tên giả lập.

const NAME = testDbName('ceo_report');
const NOW = new Date('2026-10-12T09:00:00+07:00');
const FIX = repoPath('tests', 'fixtures', 'cockpit');
const LIVE = { provenance: 'live' };
const OK_SNAP = { ok: true, violations: [] };
const u = (s: string) => new Date(s);
const W41 = '2026-10-05';
const W40 = '2026-09-28';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('ceo_report (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  const extraLogins: string[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const count = async (t: string) => Number((await q(`select count(*)::int as n from ${t}`))[0].n);

  async function lead(ts: string) {
    await q(
      "insert into leads (dedup_key, ts, channel, user_hash, intent, source) values ($1, $2, 'zalo', 'h', 'price', 'test')",
      [`t:${Math.random().toString(36).slice(2)}`, u(ts)],
    );
  }
  /** Hàng duyệt với mốc quá khứ (replica bỏ trigger) — tên giả lập. */
  async function queue(
    block: string,
    status: string,
    created: string,
    decided: string | null,
    o: { due?: string; otype?: string; by?: string; snap?: unknown } = {},
  ) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      const decision = status === 'approved' || status === 'rejected';
      await c.query(
        "insert into approval_queue (object_type, object_id, block, title, payload, content_sha256, risk, guardrail, created_by, created_at, due_at, status, decided_by, decided_at, lane) values ($1, $2, $3, 't', 'p', $4, 'medium', $5::jsonb, $6, $7, $8, $9, $10, $11, $12)",
        [
          o.otype ?? 'weekly_report',
          Math.random().toString(36).slice(2),
          block,
          '0'.repeat(64),
          JSON.stringify(o.snap ?? {}),
          o.by ?? 'agent:test',
          u(created),
          o.due ? u(o.due) : new Date(u(created).getTime() + 48 * 3600_000),
          status,
          decided === null || status === 'expired' ? null : 'Người Test',
          decided ? u(decided) : null,
          decision ? 'per_item' : null,
        ],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
  }
  async function draft(
    channel: string,
    ctype: string,
    status: string,
    created: string,
    reviewed: string | null = null,
    by = 'agent:mkt02',
    snap: unknown = OK_SNAP,
  ) {
    await q(
      "insert into content_drafts (created_at, brief, channel, text, guardrail, status, reviewer, reviewed_at, source, created_by, content_type) values ($1, 'b', $2, 't', $3::jsonb, $4, $5, $6, 'cli', $7, $8)",
      [
        u(created),
        channel,
        JSON.stringify(snap),
        status,
        reviewed ? 'Người Test' : null,
        reviewed ? u(reviewed) : null,
        by,
        ctype,
      ],
    );
  }
  async function snapRow(ch: string, metric: string, start: string, value: number, ref: string) {
    await q(
      "insert into channel_snapshots (channel, metric_id, period_kind, period_start, value, source, source_ref, captured_by) values ($1, $2, 'week', $3, $4, $5, $6, 'Người Xuất Test')",
      [ch, metric, start, value, ch === 'noi_bo' ? 'api' : 'manual_export', ref],
    );
  }
  const vals = (rows: SnapRow[]) =>
    Object.fromEntries(rows.map((r) => [r.metric_id, decStr(r.value)]));
  const lease =
    (db: pg.Pool | pg.PoolClient = pool) =>
    async () => ({
      db,
      release: async () => {},
    });
  function cliIo() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  }
  async function cockpit(o: CockpitOpts, extra: Partial<CliDeps> = {}) {
    const s = cliIo();
    const rc = await cockpitMain(o, {
      io: s.io,
      now: NOW,
      connect: lease(),
      dataDir: tmp,
      ...extra,
    });
    return { rc, out: s.out.join('\n'), err: s.err.join('\n') };
  }
  async function ceo(o: CeoReportOpts, extra: Partial<CliDeps> = {}) {
    const s = cliIo();
    const rc = await ceoReportMain(o, { io: s.io, now: NOW, connect: lease(), ...extra });
    return { rc, out: s.out.join('\n'), err: s.err.join('\n') };
  }
  async function tempLogin(role: string): Promise<pg.Pool> {
    const login = `t_ceo_${role}_${process.pid}`.slice(0, 60);
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password '${pw}' in role ${role}`);
    extraLogins.push(login);
    const url = new URL(process.env.TS_TEST_ADMIN_URL as string);
    url.username = login;
    url.password = pw;
    url.pathname = `/${NAME}`;
    return createPool(url.toString());
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ceo-db-'));
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    setCeoSections(null);
    for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { recursive: true, force: true });
  });
  afterEach(() => {
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    settings.forceMode = null;
    setCeoSections(null);
    await pool?.end();
    await dropDb(NAME);
    for (const l of extraLogins) await adminQuery(`drop role if exists ${l}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- cockpit W80.2

  it('tuần chứa 01/10 = 28/09..05/10 giờ VN; tháng cắt theo giờ VN', async () => {
    const [s, e] = periodBounds('week', '2026-10-01');
    expect([s.toISOString(), e.toISOString()]).toEqual([
      '2026-09-27T17:00:00.000Z',
      '2026-10-04T17:00:00.000Z',
    ]);
    for (const ts of [
      '2026-09-27T16:59:59Z', // 23:59:59 27/09 VN — KHÔNG
      '2026-09-27T17:00:00Z', // 00:00 28/09 VN — tính
      '2026-10-04T16:59:59Z', // 23:59:59 04/10 VN — tính
      '2026-10-04T17:00:00Z', // 00:00 05/10 VN — KHÔNG
    ]) {
      await lead(ts);
    }
    const recs = [
      { ts: '2026-09-28T01:00:00Z', answered: true, ...LIVE },
      { ts: '2026-09-29T01:00:00Z', answered: false, ...LIVE },
      { ts: '2026-09-30T01:00:00Z', answered: null, ...LIVE },
      { ts: '2026-09-30T02:00:00Z', ...LIVE },
      { ts: '2026-09-27T16:00:00Z', answered: false, ...LIVE }, // ngoài kỳ
    ];
    writeFileSync(
      join(tmp, 'conversations.jsonl'),
      `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const [rows, errors] = await collectInternal(pool, 'week', '2026-10-01', {
      dataDir: tmp,
      now: NOW,
    });
    const v = vals(rows);
    expect(errors).toEqual([]);
    expect(v['leads.new']).toBe('2');
    expect([v['chatbot.questions'], v['chatbot.unanswered']]).toEqual(['4', '3']);
    expect(rows.every((r) => r.period_start === W40)).toBe(true);
    expect(rows.every((r) => r.channel === 'noi_bo' && r.source === 'api')).toBe(true);
    const srcs = Object.fromEntries(rows.map((r) => [r.metric_id, r.source_ref]));
    expect(srcs['leads.new']).toBe('db:leads');
    expect(srcs['chatbot.questions']).toBe('file:conversations.jsonl');
    // Tháng: lead 2026-09-30T17:00Z (= 00:00 01/10 VN) thuộc tháng 10.
    await lead('2026-09-30T17:00:00Z');
    const [m9] = await collectInternal(pool, 'month', '2026-09-15', { dataDir: tmp, now: NOW });
    expect(vals(m9)['leads.new']).toBe('2');
    const [m10] = await collectInternal(pool, 'month', '2026-10-01', {
      dataDir: tmp,
      now: new Date('2026-11-02T00:00:00+07:00'),
    });
    expect(vals(m10)['leads.new']).toBe('3');
  });

  it('collectInternal: đủ metric nội bộ đúng định nghĩa', async () => {
    const s = '2026-10-05T01:00:00Z'; // trong W41
    const before = '2026-10-01T01:00:00Z';
    const after = '2026-10-12T01:00:00Z'; // sau end W41
    for (const ts of [before, s, s]) {
      await q(
        "insert into content_drafts (created_at, brief, channel, text, guardrail, source) values ($1, 'b', 'facebook', 't', '{}', 'cli')",
        [u(ts)],
      );
    }
    const ids = (await q('select id::text as id from content_drafts order by id')).map((r) => r.id);
    // draft 1 duyệt trước end; draft 2 duyệt SAU end → vẫn chờ cuối kỳ.
    for (const [oid, ts] of [
      [ids[0], s],
      [ids[1], after],
    ]) {
      await q(
        "insert into approvals (object_type, object_id, content_sha256, decision, approved_by, approved_at) values ('content_draft', $1, $2, 'approved', 'Người Test', $3)",
        [oid, '0'.repeat(64), u(ts as string)],
      );
    }
    for (const [opened, closedAt] of [
      [before, null],
      [before, '2026-10-08T01:00:00Z'],
      [before, after],
      [after, null],
    ] as [string, string | null][]) {
      await q(
        "insert into market_alerts (kind, severity, channel, export_kind, item_id, detail, opened_at, closed_at, status) values ('price_mismatch', 'S2', 'shopee', 'x', $1, '{}', $2, $3, $4)",
        [
          Math.random().toString(36).slice(2),
          u(opened),
          closedAt ? u(closedAt) : null,
          closedAt ? 'closed' : 'open',
        ],
      );
    }
    for (const [agent, cost, ts] of [
      ['chatbot', '0.25', s],
      ['chatbot', '0.5', s],
      ['Persona-Sim', '1.125', s],
      ['chatbot', '9', after],
    ]) {
      await q(
        "insert into llm_usage (ts, agent_id, model, cost_usd, ok) values ($1, $2, 'm', $3, true)",
        [u(ts as string), agent, cost],
      );
    }
    for (const [ok, ts] of [
      [false, s],
      [null, s],
      [true, s],
      [false, before],
    ]) {
      await q("insert into job_runs (job, started_at, ok) values ('j', $1, $2)", [
        u(ts as string),
        ok,
      ]);
    }
    await queue('sales', 'pending', '2026-10-01T01:00:00Z', null, { due: '2026-10-06T01:00:00Z' }); // quá hạn trong kỳ
    await queue('marketing', 'expired', '2026-10-01T01:00:00Z', '2026-10-07T01:00:00Z', {
      due: '2026-10-07T01:00:00Z',
    });
    await queue('sales', 'approved', '2026-10-01T01:00:00Z', '2026-10-02T01:00:00Z', {
      due: '2026-10-06T01:00:00Z',
    }); // đã duyệt
    await queue('sales', 'pending', '2026-10-01T01:00:00Z', null, { due: '2026-10-13T01:00:00Z' }); // hạn ngoài kỳ
    writeFileSync(join(tmp, 'conversations.jsonl'), '');
    const [rows, errors] = await collectInternal(pool, 'week', W41, { dataDir: tmp, now: NOW });
    const v = vals(rows);
    expect(errors).toEqual([]);
    expect(v['content.drafts_created']).toBe('2');
    expect(v['content.drafts_approved']).toBe('1');
    expect(v['content.drafts_pending_end']).toBe('2'); // draft 2 + draft 3
    expect(v['market.alerts_open_end']).toBe('2'); // mở + đóng sau end
    expect(dec(v['ai.cost_usd'] as string)).toEqual(dec('1.875000'));
    expect(v['ai.cost_usd.chatbot']).toBe('0.750000');
    expect(v['ai.cost_usd.persona_sim']).toBe('1.125000');
    expect(v['jobs.failed']).toBe('2');
    expect(v['approvals.overdue']).toBe('2');
    expect(v['chatbot.questions']).toBe('0'); // file có, 0 câu — số thật
  });

  it('thiếu bảng → metric vào errors, KHÔNG thành 0; savepoint giữ metric khác (cả trên client trong tx)', async () => {
    await q('drop table job_runs');
    for (const db of ['pool', 'client'] as const) {
      const c = db === 'client' ? await pool.connect() : null;
      try {
        if (c) await c.query('begin');
        const [rows, errors] = await collectInternal(c ?? pool, 'week', W41, {
          dataDir: tmp,
          now: NOW,
        });
        const ids = new Set(rows.map((r) => r.metric_id));
        expect(ids.has('jobs.failed')).toBe(false);
        expect(errors.some((e) => e.startsWith('jobs.failed:'))).toBe(true);
        // Không có file convlog → lỗi nguồn, không phải 0.
        expect(ids.has('chatbot.questions')).toBe(false);
        expect(errors.some((e) => e.startsWith('chatbot.questions:'))).toBe(true);
        expect(ids.has('leads.new')).toBe(true);
        expect(ids.has('approvals.ceo_decided')).toBe(true);
      } finally {
        if (c) {
          await c.query('rollback');
          c.release();
        }
      }
    }
  });

  it('store: idempotent; số khác bản đã chụp → conflict, GIỮ bản cũ', async () => {
    await lead('2026-10-06T01:00:00Z');
    const [rows] = await collectInternal(pool, 'week', W41, { dataDir: tmp, now: NOW });
    const n = rows.length;
    let st = await store(pool, rows, CAPTURED_BY);
    expect(st).toEqual({
      inserted: n,
      unchanged: 0,
      conflict: 0,
      unverified: 0,
      rolled_back: false,
    });
    expect(await count('channel_snapshots')).toBe(n);
    st = await store(pool, rows, CAPTURED_BY);
    expect([st.inserted, st.unchanged, st.conflict]).toEqual([0, n, 0]);
    const changed = rows.map((r) => (r.metric_id === 'leads.new' ? { ...r, value: dec(99) } : r));
    st = await store(pool, changed, CAPTURED_BY);
    expect([st.inserted, st.unchanged, st.conflict]).toEqual([0, n - 1, 1]);
    expect(await count('channel_snapshots')).toBe(n);
    const old = await q(
      "select value::text as v from channel_snapshots where metric_id = 'leads.new'",
    );
    expect(old[0].v).toBe('1'); // giữ bản cũ
    // row sai → lỗi TRƯỚC mọi ghi
    await expect(
      store(pool, [rows[0] as SnapRow, { ...(rows[0] as SnapRow), value: dec(-1) }], CAPTURED_BY),
    ).rejects.toThrow('value phải Decimal hữu hạn ≥ 0');
    await expect(store(pool, rows, '  ')).rejects.toThrow('store: thiếu captured_by');
  });

  it('thời gian duyệt TGĐ tuần 41; tuần không có quyết định → không ghi giờ (không 0)', async () => {
    await queue('ceo', 'approved', '2026-10-05T01:00:00Z', '2026-10-05T03:00:00Z'); // 2h
    await queue('ceo', 'rejected', '2026-10-06T02:00:00Z', '2026-10-07T08:00:00Z'); // 30h
    await queue('ceo', 'approved', '2026-10-09T13:00:00Z', '2026-10-11T17:30:00Z'); // 00:30 12/10 VN
    await queue('ceo', 'approved', '2026-10-03T01:00:00Z', '2026-10-04T16:59:00Z'); // 23:59 04/10 VN
    await queue('ceo', 'expired', '2026-10-03T01:00:00Z', '2026-10-08T01:00:00Z');
    await queue('marketing', 'approved', '2026-10-05T01:00:00Z', '2026-10-06T01:00:00Z');
    const [s, e] = periodBounds('week', W41);
    expect(await approvalTimes(pool, s, e, 'ceo')).toEqual({
      n: 2,
      median_h: 16.0,
      max_h: 30.0,
      expired: 1,
    });
    let [rows] = await collectInternal(pool, 'week', W41, { dataDir: tmp, now: NOW });
    let v = vals(rows);
    expect(v['approvals.ceo_decided']).toBe('2');
    expect(v['approvals.ceo_hours_median']).toBe('16.0');
    expect(v['approvals.ceo_hours_max']).toBe('30.0');
    expect(v['approvals.ceo_expired']).toBe('1');
    [rows] = await collectInternal(pool, 'week', '2026-09-21', { dataDir: tmp, now: NOW });
    v = vals(rows);
    expect('approvals.ceo_hours_median' in v).toBe(false);
    expect('approvals.ceo_hours_max' in v).toBe(false);
    expect(v['approvals.ceo_decided']).toBe('0');
  });

  // ---------------------------------------------------------------- cockpit CLI

  it('--import MẪU: idempotent; file sửa 1 số + thêm dòng → hủy CẢ file (exit 1, 0 dòng)', async () => {
    const mau = join(FIX, 'kenh_MAU.csv');
    const n = readCsv(mau, loadMetrics(), { now: NOW })[0].length;
    const argv = { import: mau, by: 'Người Xuất Test', sample: true };
    let r = await cockpit(argv);
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`inserted=${n}`);
    const snap = () =>
      q(
        'select channel, metric_id, period_kind, period_start::text, value::text, source, source_ref, captured_by from channel_snapshots order by id',
      );
    const first = await snap();
    expect(first.length).toBe(n);
    expect(
      first.every(
        (x) =>
          x.source === 'manual_export' &&
          x.source_ref.startsWith('sample:') &&
          x.captured_by === 'Người Xuất Test',
      ),
    ).toBe(true);
    r = await cockpit(argv);
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`inserted=0 unchanged=${n}`);
    expect(await snap()).toEqual(first);
    let body = readFileSync(mau, 'utf8').replace(
      'shopee,sales.orders_completed,week,2026-10-05,44',
      'shopee,sales.orders_completed,week,2026-10-05,45',
    );
    body += 'youtube,social.followers,week,2026-10-05,10\n';
    const p = join(tmp, 'kenh_MAU_sua.csv');
    writeFileSync(p, body);
    r = await cockpit({ import: p, by: 'X', sample: true });
    expect(r.rc).toBe(1);
    expect(r.err).toContain('0 dòng');
    expect(await snap()).toEqual(first);
  });

  it('store/import dưới agent_writer thật (chỉ INSERT 8 cột, KHÔNG SELECT sổ) — fail-closed khi không so được', async () => {
    const metrics = loadMetrics();
    const mau = join(FIX, 'kenh_MAU.csv');
    const n = readCsv(mau, metrics, { now: NOW })[0].length;
    const aw = await tempLogin('agent_writer');
    try {
      await expect(aw.query('select value from channel_snapshots')).rejects.toMatchObject({
        code: '42501',
      });
      const argv = { import: mau, by: 'X', sample: true };
      const awDeps = { connect: lease(aw) };
      let r = await cockpit(argv, awDeps);
      expect(r.rc).toBe(0);
      expect(r.out).toContain(`inserted=${n}`);
      // Nạp lại y nguyên: không so được giá trị → fail-closed exit 1, 0 dòng, không [done].
      r = await cockpit(argv, awDeps);
      expect(r.rc).toBe(1);
      expect(r.out).not.toContain('[done]');
      expect(r.err).toContain(`[fail] ${n} dòng`);
      expect(r.err).toContain('SELECT');
      expect(r.err).toContain('0 dòng');
      // File SỬA 1 số cùng khóa dưới agent_writer: exit 1, sổ GIỮ số cũ.
      const body0 = readFileSync(mau, 'utf8');
      expect(body0.split(',11111000').length - 1).toBe(1);
      const pFix = join(tmp, 'kenh_MAU_sua.csv');
      writeFileSync(pFix, body0.replace(',11111000', ',99999000'));
      r = await cockpit({ import: pFix, by: 'X', sample: true }, awDeps);
      expect(r.rc).toBe(1);
      expect(r.out).not.toContain('[done]');
      expect(r.err).toContain('KHÔNG được nạp');
      const gmv = await q(
        "select value::text as v from channel_snapshots where channel = 'shopee' and metric_id = 'sales.gmv_vnd' and period_start = '2026-09-28'",
      );
      expect(gmv.map((x) => x.v)).toEqual(['11111000']);
      // Dòng mới + dòng đã có → fail-closed cả file.
      const pAdd = join(tmp, 'kenh_MAU_them.csv');
      writeFileSync(pAdd, `${body0}youtube,social.followers,week,2026-10-05,10\n`);
      r = await cockpit({ import: pAdd, by: 'X', sample: true }, awDeps);
      expect(r.rc).toBe(1);
      expect(r.err).toContain('0 dòng');
      // store nội bộ (collector) dưới agent_writer: insert OK, lần 2 unverified.
      const internal = [
        internalRow('jobs.failed', 'week', periodBounds('week', W41)[0], dec(2), 'db:job_runs'),
      ];
      let st = await store(aw, internal, CAPTURED_BY, { metrics });
      expect([st.inserted, st.unverified]).toEqual([1, 0]);
      st = await store(aw, internal, CAPTURED_BY, { metrics });
      expect([st.inserted, st.unverified, st.conflict]).toEqual([0, 1, 0]);
      const got = await q(
        "select count(*)::int as n, (count(*) filter (where metric_id = 'social.followers' and channel = 'youtube'))::int as y from channel_snapshots",
      );
      expect([got[0].n, got[0].y]).toEqual([n + 1, 0]);
    } finally {
      await aw.end();
    }
  });

  it('--collect: ghi số máy chụp (agent:cockpit), idempotent; --dry-run không ghi; marketing-06.2 TẮT → [blocked] exit 2, 0 dòng', async () => {
    await lead('2026-10-06T01:00:00Z');
    let r = await cockpit({ collect: true, period: 'week', dryRun: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[cockpit] kỳ week bắt đầu 2026-10-05 (giờ VN)');
    expect(r.out).toContain('[dry-run] không ghi channel_snapshots');
    expect(await count('channel_snapshots')).toBe(0);
    settings.forceMode = 'tat';
    r = await cockpit(
      { collect: true, period: 'week' },
      { now: new Date('2026-10-16T09:00:00+07:00') },
    );
    expect(r.rc).toBe(2);
    expect(r.err).toContain('[blocked]');
    expect(r.err).toContain('marketing-06.2');
    expect(await count('channel_snapshots')).toBe(0);
    settings.forceMode = 'van_hanh';
    r = await cockpit({ collect: true });
    expect(r.rc).toBe(0);
    const n = await count('channel_snapshots');
    expect(r.out).toContain(`[done] inserted=${n} unchanged=0 conflict=0`);
    expect(r.out).toContain(
      '[warn] thiếu nguồn — chatbot.questions: không có file conversations.jsonl',
    );
    const by = await q('select distinct captured_by, source from channel_snapshots');
    expect(by).toEqual([{ captured_by: 'agent:cockpit', source: 'api' }]);
    r = await cockpit({ collect: true });
    expect(r.out).toContain(`[done] inserted=0 unchanged=${n} conflict=0`);
  });

  // ---------------------------------------------------------------- ceo_report

  async function seedReport() {
    const m = loadMetrics();
    await store(
      pool,
      [
        [W40, 120],
        [W41, 137],
      ].map(([ps, n]) => ({
        channel: 'noi_bo',
        metric_id: 'leads.new',
        period_kind: 'week',
        period_start: ps as string,
        value: dec(n as number),
        source: 'api',
        source_ref: 'db:leads',
      })),
      CAPTURED_BY,
      { metrics: m },
    );
    const mau = join(FIX, 'kenh_MAU.csv');
    const [csvRows, errs] = readCsv(mau, m, { now: NOW });
    expect(errs).toEqual([]);
    const ref = csvSourceRef(mau, true);
    for (const r of csvRows) Object.assign(r, { source: 'manual_export', source_ref: ref });
    await store(pool, csvRows, 'Người Xuất Test', { metrics: m, atomic: true });
  }
  const tableRows = (page: string) =>
    page
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Chỉ số'))
      .map((l) =>
        l
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim()),
      );

  it('build/render từ DB thật + --submit vào hàng chờ khối ceo (pending, không tự duyệt); nộp lại khi còn pending → exit 1', async () => {
    await seedReport();
    const rep = await build(pool, 'week', W41, { now: NOW });
    const page = render(rep);
    const by = Object.fromEntries(tableRows(page).map((r) => [r[0], r]));
    expect(by['Lead mới (leads.new)']?.slice(2, 6)).toEqual([
      '137 lead',
      '120 lead',
      '+17 lead (+14,2%)',
      'tốt',
    ]);
    expect(by['Lead mới (leads.new)']?.[6]).toMatch(/^api · db:leads · chụp /);
    const shopee = tableRows(page).find(
      (r) => r[0]?.endsWith('(sales.gmv_vnd)') && r[1] === 'shopee',
    ) as string[];
    expect(shopee.slice(2, 4)).toEqual(['12.222.000 đ', '11.111.000 đ']);
    expect(shopee[6]).toContain('(MẪU)');
    expect(shopee[6]).toContain('sample:kenh_MAU.csv');
    expect(page).toContain('ĐỎ — chưa có người nhận cảnh báo độc lập'); // cấu hình thật: recipients []

    const nAppr = await count('approvals');
    const out = join(tmp, 'out');
    let r = await ceo({ period: 'week', ref: W41, submit: true, outDir: out });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[submit]');
    const items = await q(
      'select block, object_type, object_id, status, created_by, payload, content_sha256 from approval_queue',
    );
    expect(items.map((x) => [x.block, x.object_type, x.object_id, x.status, x.created_by])).toEqual(
      [['ceo', 'weekly_report', '2026-W41', 'pending', 'agent:ceo_report']],
    );
    expect(await count('approvals')).toBe(nAppr);
    const file = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
    expect(file.startsWith('# Báo cáo tuần 2026-W41 — TGĐ')).toBe(true);
    expect(items[0].payload).toBe(file);
    expect(items[0].content_sha256).toBe(
      createHash('sha256').update(items[0].payload, 'utf8').digest('hex'),
    );
    r = await ceo({ period: 'week', ref: W41, submit: true, outDir: out });
    expect(r.rc).toBe(1);
    expect(r.err).toContain('[error] không nộp được hàng chờ:');
    expect(await count('approval_queue')).toBe(1);
  });

  it('cổng thật: ceo-01 chưa vào sổ → chạy thử: file mang nhãn CHẠY THỬ, sổ report_outputs (MẪU), payload = trang chưa nhãn', async () => {
    await seedReport();
    settings.forceMode = null; // đọc sổ feature_rollout thật (trống → chay_thu, fail-closed)
    const out = join(tmp, 'thu');
    const r = await ceo({ ref: W41, submit: true, outDir: out });
    expect(r.rc, r.err).toBe(0);
    const file = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
    expect(file.startsWith('> **CHẠY THỬ — KHÔNG GỬI.** Tính năng ceo-01')).toBe(true);
    const ro = await q('select feature_id, name, is_sample from report_outputs');
    expect(ro).toEqual([{ feature_id: 'ceo-01', name: 'ceo-2026-W41.md', is_sample: true }]);
    const [item] = await q('select payload, status from approval_queue');
    expect(item.status).toBe('pending');
    expect(item.payload.startsWith('# Báo cáo tuần 2026-W41 — TGĐ')).toBe(true);
    expect(file.endsWith(item.payload)).toBe(true);
  });

  it('v8.1: section lỗi DB (savepoint) chỉ hỏng phần đó; trang + nhận xét vẫn ra', async () => {
    await seedReport();
    setCeoSections({
      decisions: async (db) => {
        await db.query('select * from bang_khong_ton_tai');
        return [];
      },
      risk: () => {
        throw new RangeError('data/ceo_risk.json hỏng: JSONDecodeError');
      },
      audit: () => ['## Audit outside-in (P1)', '', '| facebook | 4 | 1 | 25% |'],
    });
    const out = join(tmp, 'o2');
    const r = await ceo({ ref: W41, outDir: out });
    expect(r.rc).toBe(0);
    const page = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
    expect(page).toContain(
      '## Rủi ro pháp lý mở\n\n*(không đọc được: ValueError: data/ceo_risk.json hỏng: JSONDecodeError)*',
    );
    expect(page).toContain('## Tiến độ & Sổ quyết định\n\n*(không đọc được: UndefinedTable:');
    expect(page).toContain('bang_khong_ton_tai');
    expect(page).toContain('| facebook | 4 | 1 | 25% |');
    expect(page).toContain('## Nhận xét');
    expect(page).toContain('137 lead');
    // cùng client trong giao dịch: lỗi section không làm hỏng câu đọc sau (savepoint)
    const c = await pool.connect();
    try {
      await c.query('begin');
      const secs = await computeSections(c, NOW);
      const rep = await build(c, 'week', W41, { now: NOW, sections: secs });
      expect(finalize(rep)[1]).toBe(true);
      expect(rep.rows.find((x) => x.metric_id === 'leads.new')?.cur).not.toBeNull();
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('v8.1 --bulletin: bản tin GĐ khối ceo kèm 3 section trước "Người duyệt"', async () => {
    setCeoSections({
      decisions: () => ['## Tiến độ & Sổ quyết định', '', '- quá hạn thực hiện: 1'],
      risk: () => ['## Rủi ro pháp lý mở', '', '| ĐỎ | TUYEN-CANH-BAO |'],
      audit: () => ['## Audit outside-in (P1)', '', '| facebook | 4 | 1 | 25% |'],
    });
    const out = join(tmp, 'b');
    const r = await ceo({ bulletin: true, now: '2026-10-12T09:00', outDir: out }, { now: null });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[bulletin]');
    const md = readFileSync(join(out, 'director-ceo-2026-10-12.md'), 'utf8');
    const pos = SECTION_HEADS.map((h) => md.indexOf(h));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(pos[2] as number).toBeLessThan(md.indexOf('## Người duyệt'));
    expect(md.startsWith('# Bản tin GĐ ')).toBe(true);
    expect(md).toContain('| facebook | 4 | 1 | 25% |');
  });

  it('login svc_job (job lịch ceo_weekly) ra CÙNG trang với owner, không InsufficientPrivilege', async () => {
    await seedReport();
    const job = await tempLogin('svc_job');
    try {
      const outs: Record<string, string> = {};
      for (const [who, db] of [
        ['admin', pool],
        ['svc_job', job],
      ] as const) {
        const out = join(tmp, `ceo-${who}`);
        const r = await ceo(
          { period: 'week', outDir: out },
          { connect: lease(db), wire: (d) => wireCore(d) },
        );
        expect(r.rc, `${who}: ${r.err}`).toBe(0);
        expect(`${r.out}${r.err}`).not.toContain('InsufficientPrivilege');
        outs[who] = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
      }
      expect(outs.svc_job).toBe(outs.admin);
      expect(outs.admin).toContain('12/10/2026 09:00'); // đồng hồ ghim in trong báo cáo
    } finally {
      await job.end();
      wireCore(pool);
    }
  });

  // ---------------------------------------------------------------- mkt_metrics

  async function mktFixture() {
    // Kỳ rollingBounds(7, 04/10) = 28/09 00:00 VN → 05/10 00:00 VN.
    await draft('facebook', 'post', 'approved', '2026-10-01T01:00:00Z', '2026-10-01T03:00:00Z');
    await draft('facebook', 'post', 'approved', '2026-10-02T01:00:00Z', '2026-10-02T05:00:00Z');
    await draft(
      'facebook',
      'post',
      'rejected',
      '2026-10-03T01:00:00Z',
      '2026-10-04T16:59:59Z',
      'agent:mkt02',
      {
        ok: false,
        violations: [{ type: 'banned_word' }],
      },
    );
    await draft(
      'shopee',
      'listing',
      'rejected',
      '2026-10-01T00:00:00Z',
      '2026-10-01T10:00:00Z',
      'agent:MKT-11',
      {
        ok: false,
        violations: [{ code: 'tu_cam', type: 'banned_word' }, { x: 1 }],
      },
    );
    await draft('facebook', 'post', 'pending', '2026-10-02T02:00:00Z', null, '', 'hong');
    await draft('facebook', 'post', 'approved', '2026-10-04T10:00:00Z', '2026-10-04T17:00:00Z');
    await draft('zalo', 'post', 'approved', '2026-10-03T10:00:00Z', '2026-10-03T05:00:00Z'); // mốc âm
    await draft('facebook', 'post', 'rejected', '2026-09-20T01:00:00Z', '2026-09-21T01:00:00Z');
    const mq = (
      block: string,
      otype: string,
      status: string,
      created: string,
      decided: string | null = null,
      by = 'agent:mkt01',
    ) => queue(block, status, created, decided, { otype, by, snap: OK_SNAP });
    await mq(
      'marketing',
      'listing_copy',
      'approved',
      '2026-10-01T01:00:00Z',
      '2026-10-01T07:00:00Z',
    );
    await mq(
      'marketing',
      'koc_brief',
      'rejected',
      '2026-10-02T00:00:00Z',
      '2026-10-02T12:00:00Z',
      'agent:MKT-03',
    );
    await mq('marketing', 'koc_brief', 'expired', '2026-09-29T00:00:00Z', '2026-10-03T00:00:00Z');
    await mq('marketing', 'campaign_brief', 'pending', '2026-10-01T05:00:00Z');
    await mq(
      'ceo',
      'weekly_report',
      'rejected',
      '2026-10-01T01:00:00Z',
      '2026-10-01T02:00:00Z',
      'agent:ceo',
    );
    await snapRow('facebook', 'social.reach', W40, 1000, 'sample:kenh_MAU.csv');
    await snapRow('facebook', 'social.engagement', W40, 50, 'sample:kenh_MAU.csv');
    await snapRow('tiktok_shop', 'sales.orders_completed', W40, 7, 'file:tiktok.csv');
    await snapRow('youtube', 'social.reach', W40, 0, 'file:yt.csv');
    await snapRow('youtube', 'social.engagement', W40, 3, 'file:yt.csv');
    await snapRow('facebook', 'social.reach', W41, 999, 'file:fb.csv');
    await snapRow('noi_bo', 'content.drafts_created', W40, 5, 'db:x');
  }

  it('mkt collect: tỷ lệ trả lại, giờ duyệt, biên kỳ, theo agent, code guardrail, kênh tuần đã đóng', async () => {
    await mktFixture();
    const [since, until] = rollingBounds(7, '2026-10-04');
    const m = await mm.collect(pool, since, until);
    const drafts = new Map(m.drafts.map(([k, b]) => [k.join('·'), b]));
    const fb = drafts.get('facebook·post');
    expect([fb?.decided, fb?.approved, fb?.rejected, fb?.rate]).toEqual([3, 2, 1, 33.3]);
    expect(fb?.pending_end).toBe(2);
    const sh = drafts.get('shopee·listing');
    expect([sh?.decided, sh?.rejected, sh?.rate]).toEqual([1, 1, 100.0]);
    const t = m.drafts_total;
    expect([t.decided, t.approved, t.rejected, t.rate]).toEqual([5, 3, 2, 40.0]);
    expect(m.drafts_hours).toEqual({ n: 4, median_h: 7.0, p90_h: 40.0, max_h: 40.0, bad_ts: 1 });
    expect(new Set(m.queue.map(([k]) => k))).toEqual(
      new Set(['listing_copy', 'koc_brief', 'campaign_brief']),
    );
    const qt = m.queue_total;
    expect([qt.decided, qt.rejected, qt.rate, qt.pending_end]).toEqual([2, 1, 50.0, 1]);
    expect(new Map(m.queue).get('koc_brief')?.rate).toBe(100.0);
    expect(m.queue_expired).toBe(1);
    expect(m.queue_hours).toEqual({ n: 2, median_h: 9.0, p90_h: 12.0, max_h: 12.0, bad_ts: 0 });
    expect(m.by_agent).toEqual({
      'agent:mkt02': 5,
      'agent:MKT-11': 1,
      '(không rõ)': 1,
      'agent:mkt01': 3,
      'agent:MKT-03': 1,
    });
    expect(m.guardrail_codes).toEqual({ banned_word: 1, tu_cam: 1, '?': 1, snapshot_hong: 1 });
    expect(m.channels.week).toBe('2026-W40');
    const rows = Object.fromEntries(m.channels.rows.map((r) => [r.channel, r]));
    expect(Object.keys(rows)).toEqual(['facebook', 'tiktok_shop', 'youtube']);
    expect(rows.facebook).toEqual({
      channel: 'facebook',
      reach: 1000,
      engagement: 50,
      orders: null,
      cancelled: null,
      cancel_rate: null,
      eng_rate: 5.0,
      sample: true,
    });
    expect(rows.tiktok_shop?.orders).toBe(7);
    expect(rows.tiktok_shop?.sample).toBe(false);
    expect(rows.youtube?.eng_rate).toBeNull(); // reach 0 → null
  });

  it('mkt biên nửa đêm VN; thiếu bảng → lỗi DB nổi lên; mốc không phải thời điểm → lỗi trước query', async () => {
    await draft('facebook', 'post', 'rejected', '2026-10-04T10:00:00Z', '2026-10-04T16:59:59Z');
    await draft('facebook', 'post', 'rejected', '2026-10-04T10:00:00Z', '2026-10-04T17:00:00Z');
    await draft('facebook', 'post', 'approved', '2026-09-27T10:00:00Z', '2026-09-27T16:59:59Z');
    await draft('facebook', 'post', 'approved', '2026-09-27T10:00:00Z', '2026-09-27T17:00:00Z');
    const [since, until] = rollingBounds(7, '2026-10-04');
    const d = await mm.draftDecisions(pool, since, until);
    expect([d.total.decided, d.total.approved, d.total.rejected]).toEqual([2, 1, 1]);
    let n = 0;
    const counting = {
      query: async () => {
        n++;
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    for (const [a, b] of [
      ['2026-10-04', until],
      [since, '2026-10-04'],
    ] as [unknown, unknown][]) {
      await expect(mm.collect(counting, a as Date, b as Date)).rejects.toThrow(
        'phải là datetime có múi giờ',
      );
      await expect(mm.draftDecisions(counting, a as Date, b as Date)).rejects.toThrow(RangeError);
    }
    expect(n).toBe(0);
    await q('drop table channel_snapshots');
    await expect(mm.collect(pool, since, until)).rejects.toMatchObject({ code: '42P01' });
  });

  it('cockpit dùng CÙNG số marketing; tuần không quyết định → không ghi giờ; lỗi DB → errors từng metric', async () => {
    for (const [created, reviewed, s] of [
      ['2026-10-05T01:00:00Z', '2026-10-05T03:00:00Z', 'approved'],
      ['2026-10-06T01:00:00Z', '2026-10-06T07:00:00Z', 'approved'],
      ['2026-10-06T01:00:00Z', '2026-10-07T01:00:00Z', 'rejected'],
    ]) {
      await draft('facebook', 'post', s as string, created as string, reviewed as string);
    }
    let [rows, errors] = await collectInternal(pool, 'week', W41, { dataDir: tmp, now: NOW });
    const v = Object.fromEntries(rows.map((r) => [r.metric_id, r]));
    expect(errors.filter((e) => e.startsWith('content.'))).toEqual([]);
    expect(decStr(v['content.drafts_rejected']?.value as never)).toBe('1');
    expect(decStr(v['content.review_hours_median']?.value as never)).toBe('6.0');
    expect(decStr(v['content.review_hours_p90']?.value as never)).toBe('24.0');
    expect(v['content.drafts_rejected']?.source_ref).toBe('db:content_drafts');
    [rows] = await collectInternal(pool, 'week', '2026-09-21', { dataDir: tmp, now: NOW });
    const ids = Object.fromEntries(rows.map((r) => [r.metric_id, decStr(r.value)]));
    expect('content.review_hours_median' in ids).toBe(false);
    expect('content.review_hours_p90' in ids).toBe(false);
    expect(ids['content.drafts_rejected']).toBe('0');
    await q('drop table content_drafts cascade');
    [rows, errors] = await collectInternal(pool, 'week', W41, { dataDir: tmp, now: NOW });
    const errIds = new Set(errors.map((e) => e.split(':')[0]));
    expect(MKT_METRICS.every((m) => errIds.has(m))).toBe(true);
    expect(rows.some((r) => r.metric_id === 'leads.new')).toBe(true);
  });

  it('báo cáo định kỳ (core ops/report.generate) dùng collect + collectChat của nhóm: mục 5 Marketing', async () => {
    await mktFixture();
    const out = join(tmp, 'rep');
    const [path, r] = await generate({
      until: '2026-10-04',
      outDir: out,
      db: pool,
      collectors: { chat: (s, e) => collectChat(tmp, s, e), marketing: mm.collect },
      now: NOW,
    });
    expect(r.marketing?.ok).toBe(true);
    const body = readFileSync(path, 'utf8');
    const sec = (body.split('## 5. Marketing')[1] as string).split('## 6.')[0] as string;
    expect(sec).toContain('| facebook · post | 1/3 | 33.3% | 2 |');
    expect(sec).toContain('| shopee · listing | 1/1 | 100.0% | 0 |');
    expect(sec).toContain('| **Tổng** | 2/5 | 40.0% |');
    expect(sec).toContain(
      'Nháp nội dung: trung vị 7.0 giờ · p90 40.0 giờ · lâu nhất 40.0 giờ (n=4) — loại 1 mục',
    );
    expect(sec).toContain('Hàng chờ khối marketing: trung vị 9.0 giờ · p90 12.0 giờ');
    expect(sec).toContain('tuần 2026-W40');
    expect(sec).toContain('facebook (MẪU)');
    expect(sec).toContain('| tiktok_shop | [chưa có dữ liệu] | [chưa có dữ liệu] | 7 |');
    expect(sec).toContain('Hết hạn không ai duyệt (không tính trả lại): 1');
  });
});
