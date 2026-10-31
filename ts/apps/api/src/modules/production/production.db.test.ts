import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { addDays } from '@samsam/core/ops/period';
import { dataPath } from '@samsam/core/paths';
import { opsRollout, RolloutBlocked, setConnector, settings } from '@samsam/core/rollout/rollout';
import { HumanDenied, HumanError, setDirectorsDir } from '@samsam/core/security/auth';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_CHANNELS } from '../garden_director/scenario.js';
import * as ic from './inventory-csv.js';
import * as lc from './lot-certs.js';
import { type Io, inventoryCsvMain, type Lease, productionMain } from './production.command.js';
import * as prod from './production.js';
import { collect, saveProposals } from './production.service.js';

// Dịch phần DB của tests/test_production.py, test_inventory_csv.py, test_contract_c03_lot_certs.py,
// test_contract_c10_production_progress.py, test_v14_p3_rollout_edges.py (cổng TẮT), test_v14_p2_
// service_auth.py (CLI quyết định người — chế độ thực), test_r12_dot2.py (bản tin 2 tính năng).
// DB riêng testDbName('production') từ mẫu, xóa khi xong; giữa các ca xóa bảng sản xuất bằng
// session_replication_role = replica (superuser DB test). `agent_action_log` KHÔNG xóa (hash chain)
// — ca so theo mốc id đầu ca. KHÔNG BAO GIỜ DB `samsam`.

const TODAY = '2026-10-12';
const NOW = new Date('2026-10-12T10:00:00+07:00');
const CHANS = ALL_CHANNELS;
const ALCOHOL = ['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml'];
const SAMPLE_INV = dataPath('sample_inventory.csv');
const SAMPLE_BOM = dataPath('sample_bom.json');
const SAMPLE_LOTS = dataPath('sample_lots.json');
const ALLOC = ['allocate', '--cutoff', 'chot_11_11', '--start', '2026-10-12'];
const HEADINGS = [
  '## Thiếu hàng theo mốc chốt',
  '## Lô chờ kiểm nhập',
  '## BOM lỗi',
  '## Mục chờ duyệt & SLA',
];
const NEAR = '## Hàng cận hạn (FEFO)';
const [G0] = ic.goldenMap();
const G = G0 as NonNullable<typeof G0>;
const GOLDEN_DOC = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as {
  skus: Record<string, unknown>[];
};
const PDF = Buffer.from('%PDF-1.4 phieu kiem nghiem gia');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('anh phieu')]);

const PROD_TABLES = [
  'production_plan_lots',
  'production_plans',
  'lot_test_certificates',
  'allocation_proposals',
  'bom_items',
  'bom_combos',
  'production_lots',
  'inventory_snapshots',
  'feature_rollout_events',
  'feature_rollout',
  'report_outputs',
  'approvals',
];

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('production (DB thật)', () => {
  const NAME = testDbName('production');
  const TMP = mkdtempSync(join(tmpdir(), 'proddb-'));
  let pool: pg.Pool;
  let mark = 0;
  let o = { out: [] as string[], err: [] as string[] };
  const io: Io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s) };
  const out = () => {
    const s = o.out.join('\n');
    o = { out: [], err: [] };
    return s;
  };
  const lease = async (): Promise<Lease> => ({ pool, release: async () => {} });
  let env: Record<string, string | undefined> = { NODE_ENV: 'test' };
  let goldenFile: string | undefined;
  const run = (...argv: string[]) =>
    productionMain(argv, { connect: lease, wire: () => {}, io, env, now: () => NOW, goldenFile });
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
  const n = async (sql: string, args: unknown[] = []) => Number(await one(sql, args));
  const logs = async (where = 'true', args: unknown[] = []) =>
    (
      await q(
        `select action, object_id from agent_action_log where id > $1 and ${where} order by id`,
        [mark, ...args],
      )
    ).map((r) => [r.action, r.object_id]);
  const write = (name: string, data: string | Buffer | object) => {
    const p = join(TMP, name);
    writeFileSync(
      p,
      typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data),
    );
    return p;
  };
  async function loadInv(file: string, source = 'manual_export') {
    const [rows, errs, sha] = await ic.readInventory(file, G, TODAY);
    expect(errs).toEqual([]);
    await ic.load(pool, rows, source, file.split(/[\\/]/).pop() as string, sha as string);
  }
  const invState = () =>
    q('select count(*)::int as c, sum(qty)::int as s, max(id)::text as m from inventory_snapshots');
  const invCsv = (...rows: string[]) => ['sku_key,kho,qty,captured_at', ...rows, ''].join('\n');
  async function stage(fid: string, st: string) {
    await pool.query(
      "insert into feature_rollout (feature_id, stage, updated_by) values ($1, $2, 'Test')" +
        ' on conflict (feature_id) do update set stage = excluded.stage',
      [fid, st],
    );
  }

  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(NAME));
    setOpsDeps({ rollout: opsRollout });
  });
  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    setConnector(null);
    env = { NODE_ENV: 'test' };
    goldenFile = undefined;
    o = { out: [], err: [] };
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      for (const t of PROD_TABLES) await c.query(`delete from ${t}`);
      await c.query('commit');
    } finally {
      c.release();
    }
    mark = await n('select coalesce(max(id), 0) from agent_action_log');
  });
  afterAll(async () => {
    settings.forceMode = null;
    setConnector(null);
    resetOpsDeps();
    await pool?.end();
    await dropDb(NAME);
    rmSync(TMP, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ SX-A3 phân bổ

  it('allocate idempotent, duyệt qua function DB, log hash chain, không đụng tồn', async () => {
    await loadInv(SAMPLE_INV, 'sample');
    const inv0 = await invState();
    expect(await run(...ALLOC)).toBe(0);
    let s = out();
    for (const x of [
      '[MẪU]',
      'KHÔNG phải doanh số cam kết',
      'không đề xuất sản xuất mới',
      'GIẢ ĐỊNH',
      'THIẾU',
    ]) {
      expect([x, s.includes(x)]).toEqual([x, true]);
    }
    const total = await n('select count(*) from allocation_proposals');
    expect(total).toBe(GOLDEN_DOC.skus.length * CHANS.length);
    const rid = String(await one('select min(run_id) from allocation_proposals'));
    expect(await n('select count(distinct run_id) from allocation_proposals')).toBe(1);
    expect(await run(...ALLOC)).toBe(0);
    expect(out()).toContain('[skip] run đã có');
    expect(await n('select count(*) from allocation_proposals')).toBe(total);
    expect(await n("select count(*) from allocation_proposals where status <> 'pending'")).toBe(0);
    // rượu × online = 0, × offline > 0 (có tồn)
    for (const key of ALCOHOL) {
      const rows = Object.fromEntries(
        (
          await q('select channel, proposed_qty from allocation_proposals where sku_key = $1', [
            key,
          ])
        ).map((r) => [r.channel, r.proposed_qty]),
      );
      for (const c of CHANS) if (c !== 'offline') expect(rows[c]).toBe(0);
      expect(rows.offline).toBeGreaterThan(0);
    }
    // SKU không có dòng tồn: stock_total null, đề xuất 0
    expect(
      await q(
        "select bool_and(stock_total is null) as a, sum(proposed_qty)::int as b from allocation_proposals where sku_key = 'mat-ong-sam-300ml'",
      ),
    ).toEqual([{ a: true, b: 0 }]);
    for (const argv of [
      ['approve', '--run', rid],
      ['approve', '--run', rid, '--by', ' '],
    ]) {
      expect(await run(...argv)).toBe(2);
    }
    expect(await n("select count(*) from allocation_proposals where status <> 'pending'")).toBe(0);
    expect(await run('approve', '--run', rid, '--by', 'GĐ SX test')).toBe(0);
    expect(out()).toContain('Không chuyển kho');
    expect(
      await n(
        "select count(*) from allocation_proposals where run_id = $1 and status = 'approved' and decided_by = 'GĐ SX test'",
        [rid],
      ),
    ).toBe(total);
    expect(await q('select object_type, object_id, decision, approved_by from approvals')).toEqual([
      {
        object_type: 'allocation_run',
        object_id: rid,
        decision: 'approved',
        approved_by: 'GĐ SX test',
      },
    ]);
    expect(await logs()).toEqual([['alloc_approve', rid]]);
    expect(await q('select * from verify_action_log()')).toEqual([]);
    // content_sha256 tính trong DB = sha256 JSON [[sku, kênh, qty]] đã sort (json.dumps Python)
    const got = (
      await q(
        'select sku_key, channel, proposed_qty from allocation_proposals where run_id = $1' +
          ' order by sku_key collate "C", channel collate "C"',
        [rid],
      )
    ).map((r) => `["${r.sku_key}", "${r.channel}", ${r.proposed_qty}]`);
    expect(await one('select content_sha256 from approvals')).toBe(
      createHash('sha256')
        .update(`[${got.join(', ')}]`)
        .digest('hex'),
    );
    expect(await invState()).toEqual(inv0);
    // run đã duyệt / run không tồn tại → exit 1, không ghi thêm
    expect(await run('reject', '--run', rid, '--by', 'B')).toBe(1);
    s = out();
    expect(s).toContain('không còn dòng pending');
    expect(await run('approve', '--run', '000000000000', '--by', 'B')).toBe(1);
    expect(out()).toContain('không có run 000000000000');
    expect(await n('select count(*) from approvals')).toBe(1);
  });

  it('reject + tồn đổi → run_id mới', async () => {
    await loadInv(SAMPLE_INV, 'sample');
    expect(await run(...ALLOC)).toBe(0);
    const rid = String(await one('select min(run_id) from allocation_proposals'));
    await loadInv(write('x.csv', invCsv('savina-12v,kho-mau-da-nang,1,2026-10-10')));
    expect(await run(...ALLOC)).toBe(0);
    expect(await n('select count(distinct run_id) from allocation_proposals')).toBe(2);
    expect(
      await run('reject', '--run', rid, '--by', 'GĐ SX test', '--note', 'chờ số kho thật'),
    ).toBe(0);
    expect(await q('select decision, note from approvals')).toEqual([
      { decision: 'rejected', note: 'chờ số kho thật' },
    ]);
    expect(await logs()).toEqual([['alloc_reject', rid]]);
  });

  it('ràng buộc CHECK của allocation_proposals / production_lots', async () => {
    const bad = async (sql: string) =>
      expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' });
    const ap =
      'insert into allocation_proposals (run_id, cutoff_id, cutoff_date, start_week, sku_key, channel,' +
      ' demand_low, demand_base, demand_high, proposed_qty';
    await bad(
      `${ap}, status) values ('r', 'c', '2026-10-25', '2026-10-12', 's', 'shopee', 0, 0, 0, 0, 'approved')`,
    );
    await bad(
      `${ap}, decided_by) values ('r', 'c', '2026-10-25', '2026-10-12', 's', 'shopee', 0, 0, 0, 0, 'X')`,
    );
    const ins =
      'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, source, intake_status, checked_by) values ';
    await bad(`${ins}('L-1', 's', '2026-09-01', '2026-08-01', 1, 'manual', 'pending', null)`);
    await bad(`${ins}('L-1', 's', '2026-09-01', '2026-09-01', 1, 'manual', 'pending', null)`);
    await bad(`${ins}('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual', 'passed', null)`);
    await bad(`${ins}('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual', 'pending', 'QA')`);
    await bad(`${ins}('L-1', 's', '2026-09-01', '2027-09-01', 1, 'manual', 'passed', '  ')`);
  });

  it('tồn kho bỏ sót SKU (stale) → allocate + bản tin cảnh báo, giữ số cũ', async () => {
    await loadInv(SAMPLE_INV, 'sample'); // mẫu 2026-10-09, 2 kho
    await loadInv(write('k.csv', invCsv('savina-12v,kho-mau-da-nang,5,2026-10-10')));
    const st = await ic.currentStock(pool);
    expect(st.get('saphraton-20v')?.stale).toEqual(['kho-mau-da-nang']);
    expect(st.get('saphraton-20v')?.qty).toBe(70); // giữ số cũ, không = 0
    expect(st.get('saphraton-20v')?.kho['kho-mau-quang-nam']?.stale).toBe(false);
    expect(st.get('savina-12v')?.stale).toEqual([]);
    expect(st.get('saphraton-40v')?.stale).toEqual([]); // chỉ ở kho-mau-quang-nam
    expect(await run(...ALLOC)).toBe(0);
    let s = out();
    expect(s).toContain(ic.STALE_NOTE);
    expect(s).toContain('- saphraton-20v @ kho-mau-da-nang');
    expect(s).not.toContain('- savina-12v @');
    expect(
      await one(
        "select bool_and(note like $1) from allocation_proposals where sku_key = 'saphraton-20v'",
        [`%${ic.STALE_NOTE}%`],
      ),
    ).toBe(true);
    expect(await run('bulletin', '--date', TODAY)).toBe(0);
    s = out();
    const sec0 = s.split(HEADINGS[0] as string)[1]?.split(HEADINGS[1] as string)[0] as string;
    expect(sec0).toContain(ic.STALE_NOTE);
    expect(sec0).toContain('saphraton-20v@kho-mau-da-nang');
    expect(sec0).not.toContain('savina-12v@');
  });

  it('tồn stale biến thể cùng ngày: tệp đính chính bỏ SKU; liệt kê đủ lại → hết stale', async () => {
    await loadInv(SAMPLE_INV, 'sample');
    await loadInv(
      write(
        'p1.csv',
        invCsv(
          'savina-12v,kho-mau-da-nang,5,2026-10-10',
          'saphraton-20v,kho-mau-da-nang,9,2026-10-10',
        ),
      ),
    );
    await loadInv(write('p2.csv', invCsv('savina-12v,kho-mau-da-nang,4,2026-10-10')));
    let st = await ic.currentStock(pool);
    expect(st.get('saphraton-20v')?.kho['kho-mau-da-nang']).toEqual({
      qty: 9,
      captured_at: '2026-10-10',
      stale: true,
    });
    expect(st.get('saphraton-20v')?.stale).toEqual(['kho-mau-da-nang']);
    expect(st.get('savina-12v')?.kho['kho-mau-da-nang']).toEqual({
      qty: 4,
      captured_at: '2026-10-10',
      stale: false,
    });
    expect(st.get('savina-12v')?.stale).toEqual([]);
    expect(await run(...ALLOC)).toBe(0);
    const s = out();
    expect(s).toContain('- saphraton-20v @ kho-mau-da-nang');
    expect(s).not.toContain('- savina-12v @');
    await loadInv(
      write(
        'p3.csv',
        invCsv(
          'savina-12v,kho-mau-da-nang,4,2026-10-10',
          'saphraton-20v,kho-mau-da-nang,0,2026-10-10',
        ),
      ),
    );
    st = await ic.currentStock(pool);
    expect(st.get('saphraton-20v')?.stale).toEqual([]);
    expect(st.get('saphraton-20v')?.kho['kho-mau-da-nang']?.qty).toBe(0);
  });

  // ------------------------------------------------------------ cổng triển khai (HĐ 6.7)

  it('production-01 TẮT: không ghi đề xuất; chạy thử ghi + cờ mẫu theo provenance', async () => {
    const ROW = {
      sku_key: 'a',
      channel: 'shopee',
      stock_total: 5,
      demand_low: 1,
      demand_base: 2,
      demand_high: 3,
      proposed_qty: 2,
      note: null,
      sample: true,
    };
    const CUT = { id: 'tet', date: '2026-11-01' };
    settings.forceMode = 'tat';
    await expect(saveProposals(pool, 'r1', CUT, '2026-10-19', [ROW])).rejects.toThrow(
      RolloutBlocked,
    );
    expect(await n('select count(*) from allocation_proposals')).toBe(0);
    settings.forceMode = 'chay_thu';
    expect(
      await saveProposals(pool, 'r1', CUT, '2026-10-19', [
        ROW,
        { ...ROW, sku_key: 'b', sample: false },
      ]),
    ).toBe(2);
    expect(await n('select count(*) from allocation_proposals where is_sample')).toBe(1);
    // CLI allocate khi TẮT → [err] … không ghi, exit 1
    settings.forceMode = 'tat';
    await loadInv(SAMPLE_INV, 'sample');
    expect(await run(...ALLOC)).toBe(1);
    expect(out()).toContain('không sinh đầu ra — không ghi.');
    expect(await n("select count(*) from allocation_proposals where run_id <> 'r1'")).toBe(0);
  });

  it('production-01 TẮT: run pending không được duyệt, từ chối vẫn được (dọn hàng)', async () => {
    settings.forceMode = 'chay_thu';
    await saveProposals(pool, 'abcdef123456', { id: 'tet', date: '2026-11-01' }, '2026-10-19', [
      {
        sku_key: 'a',
        channel: 'shopee',
        stock_total: 5,
        demand_low: 1,
        demand_base: 2,
        demand_high: 3,
        proposed_qty: 2,
        note: null,
        sample: false,
      },
    ]);
    settings.forceMode = 'tat';
    expect(await run('approve', '--run', 'abcdef123456', '--by', 'GĐ SX')).toBe(1);
    expect(out()).toContain('không duyệt mục của tính năng tắt');
    expect(await n("select count(*) from allocation_proposals where status = 'approved'")).toBe(0);
    expect(await run('reject', '--run', 'abcdef123456', '--by', 'GĐ SX')).toBe(0);
  });

  it('chế độ thực: approve/reject/intake với --by tùy ý bị chặn + authz_denied', async () => {
    env = { NODE_ENV: 'test', APPROVAL_ENFORCE: '1' };
    for (const [argv, ot, oid] of [
      [['approve', '--run', 'abcdef123456', '--by', 'Ai Đó'], 'allocation_run', 'abcdef123456'],
      [['reject', '--run', 'abcdef123456', '--by', 'Ai Đó'], 'allocation_run', 'abcdef123456'],
      [
        ['intake', '--lot', 'LOT-P2', '--result', 'passed', '--by', 'Ai Đó'],
        'production_lot',
        'LOT-P2',
      ],
    ] as const) {
      const before = await n(
        "select count(*) from agent_action_log where action = 'authz_denied' and object_type = $1 and object_id = $2",
        [ot, oid],
      );
      expect(await run(...argv)).toBe(1);
      expect(out()).toContain('Bên B ủy quyền');
      expect(
        await n(
          "select count(*) from agent_action_log where action = 'authz_denied' and object_type = $1 and object_id = $2",
          [ot, oid],
        ),
      ).toBe(before + 1);
    }
    expect(await n('select count(*) from approvals')).toBe(0);
  });

  it('chế độ thực: đúng người được ủy quyền + login của chính họ → qua cổng; sai login → chặn', async () => {
    const dir = mkdtempSync(join(TMP, 'dir-'));
    const cfg = JSON.parse(readFileSync(dataPath('directors/production.json'), 'utf8'));
    cfg.approvers = ['Nguyễn Duyệt'];
    writeFileSync(join(dir, 'production.json'), JSON.stringify(cfg));
    const users = join(dir, 'users.json');
    const login = String(await one('select session_user'));
    writeFileSync(users, JSON.stringify({ 'nguyễn duyệt': { role: 'tgd', db_login: login } }));
    env = { NODE_ENV: 'test', APPROVAL_ENFORCE: '1', AUTH_USERS_FILE: users };
    const denied = () =>
      n(
        "select count(*) from agent_action_log where action = 'authz_denied' and object_type = 'production_lot' and object_id = 'LOT-OK'",
      );
    setDirectorsDir(dir);
    try {
      const before = await denied();
      const argv = ['intake', '--lot', 'LOT-OK', '--result', 'passed', '--by', 'Nguyễn Duyệt'];
      expect(await run(...argv)).toBe(1); // qua cổng → lỗi nghiệp vụ: lô không có
      let s = out();
      expect(s).toContain('không có lô LOT-OK');
      expect(s).not.toContain('ủy quyền');
      expect(await denied()).toBe(before);
      writeFileSync(
        users,
        JSON.stringify({ 'nguyễn duyệt': { role: 'tgd', db_login: 'login_khac' } }),
      );
      expect(await run(...argv)).toBe(1);
      s = out();
      expect(s).toContain('login Postgres');
      expect(await denied()).toBe(before + 1);
    } finally {
      setDirectorsDir();
    }
  });

  it('agent: không được duyệt/kiểm nhập (cả dev)', async () => {
    expect(await run('approve', '--run', 'abcdef123456', '--by', 'agent:sx')).toBe(1);
    expect(out()).toContain('không phải người');
    expect(await run('intake', '--lot', 'LOT-P2', '--result', 'passed', '--by', 'system:x')).toBe(
      1,
    );
    expect(await n('select count(*) from approvals')).toBe(0);
  });

  it('quyết định CHỈ qua function SECURITY DEFINER; role không INSERT approvals', async () => {
    for (const f of readdirSync(import.meta.dirname)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      expect([
        f,
        /insert\s+into\s+approvals/i.test(readFileSync(join(import.meta.dirname, f), 'utf8')),
      ]).toEqual([f, false]);
    }
    const rows = await q(
      "select proname, prosecdef, proconfig from pg_proc where proname = any($1) and pronamespace = 'public'::regnamespace",
      [['decide_allocation_run', 'record_lot_intake']],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
      'decide_allocation_run',
      'record_lot_intake',
    ]);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect((r.proconfig as string[]).filter((x) => x.startsWith('search_path='))).toEqual([
        'search_path=public, pg_temp',
      ]);
    }
    for (const fn of [
      'decide_allocation_run(text,text,text,text)',
      'record_lot_intake(text,text,text,text)',
    ]) {
      const priv = async (role: string) =>
        one("select has_function_privilege($1, $2, 'execute')", [role, fn]);
      expect([
        fn,
        await priv('app_human'),
        await priv('agent_writer'),
        await priv('public'),
      ]).toEqual([fn, true, false, false]);
    }
    for (const role of ['app_human', 'agent_writer']) {
      expect(await one("select has_table_privilege($1, 'approvals', 'insert')", [role])).toBe(
        false,
      );
    }
    // function tự kiểm: người rỗng / kết quả lạ / lô, run không có → RAISE
    for (const sql of [
      "select record_lot_intake('L-001', 'passed', '  ')",
      "select record_lot_intake('L-001', 'ok', 'QA')",
      "select record_lot_intake('KHONG-CO', 'passed', 'QA')",
      "select * from decide_allocation_run('abc', 'approved', ' ')",
      "select * from decide_allocation_run('abc', 'x', 'GĐ')",
      "select * from decide_allocation_run('abc', 'approved', 'GĐ')",
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: 'P0001' });
    }
    expect(await n('select count(*) from approvals')).toBe(0);
  });

  // ------------------------------------------------------------ SX-A4 BOM

  it('bom --load idempotent + --check (số combo làm được, luật golden hiện tại)', async () => {
    await loadInv(SAMPLE_INV, 'sample');
    const counts =
      'select (select count(*) from bom_combos)::int as a, (select count(*) from bom_items)::int as b';
    expect(await run('bom', '--load', SAMPLE_BOM, '--source', 'sample')).toBe(0);
    const c1 = await q(counts);
    expect(c1[0]?.a).toBeGreaterThanOrEqual(2);
    expect(await run('bom', '--load', SAMPLE_BOM, '--source', 'sample')).toBe(0);
    expect(await q(counts)).toEqual(c1);
    out();
    expect(await run('bom', '--check')).toBe(0);
    let s = out();
    expect(s).toContain('[MẪU]');
    expect(s).toContain(prod.BUILDABLE_NOTE);
    // combo shopee: saphraton-20v 70, mat-ong-120ml-1hu 150 → 70
    expect(s).toContain('combo-saphraton-mat-ong-shopee [shopee]: 70');
    // golden đổi (bỏ shopee khỏi SKU thành phần) → check báo lỗi
    const doc = structuredClone(GOLDEN_DOC);
    for (const sk of doc.skus) if (sk.sku_key === 'saphraton-20v') sk.allowed_channels = [];
    goldenFile = write('g.json', doc);
    expect(await run('bom', '--check')).toBe(1);
    s = out();
    expect(s).toContain('kênh shopee: SKU saphraton-20v');
  });

  it('bom tệp lỗi → 0 dòng; manual không bị sample đè', async () => {
    const combo = (key: string, chans: string[], ...items: string[]) => ({
      combo_key: key,
      name: `Combo ${key}`,
      channels: chans,
      items: items.map((x) => ({ sku_key: x, qty: 1 })),
    });
    expect(
      await run(
        'bom',
        '--load',
        write('b.json', { combos: [combo('r1', ['shopee'], 'ruou-sam-chai-thuy-tinh-500ml')] }),
      ),
    ).toBe(1);
    expect(await n('select count(*) from bom_combos')).toBe(0);
    const doc = JSON.parse(readFileSync(SAMPLE_BOM, 'utf8'));
    doc.combos[0].name = 'Combo tay';
    expect(await run('bom', '--load', write('m.json', doc))).toBe(0);
    expect(await run('bom', '--load', SAMPLE_BOM, '--source', 'sample')).toBe(0);
    expect(out()).toContain('2 combo manual giữ nguyên');
    expect(
      await one('select name from bom_combos where combo_key = $1', [doc.combos[0].combo_key]),
    ).toBe('Combo tay');
  });

  // ------------------------------------------------------------ SX-A5 lô + kiểm nhập

  it('lots nạp idempotent (không ghi đè) + intake qua record_lot_intake + qr_payload', async () => {
    expect(await run('lots', '--load', SAMPLE_LOTS, '--source', 'sample')).toBe(0);
    const total = await n('select count(*) from production_lots');
    expect(total).toBeGreaterThanOrEqual(3);
    out();
    expect(await run('lots', '--load', SAMPLE_LOTS, '--source', 'sample')).toBe(0);
    expect(out()).toContain(`[skip] ${total} lô đã có`);
    const doc = JSON.parse(readFileSync(SAMPLE_LOTS, 'utf8'));
    const lot = doc.lots[0].lot_code as string;
    const oldQty = doc.lots[0].qty as number;
    doc.lots[0].qty = oldQty + 999;
    expect(await run('lots', '--load', write('l.json', doc))).toBe(0);
    expect(await one('select qty from production_lots where lot_code = $1', [lot])).toBe(oldQty);
    for (const argv of [
      ['intake', '--lot', lot, '--result', 'passed'],
      ['intake', '--lot', lot, '--result', 'passed', '--by', '   '],
    ]) {
      expect(await run(...argv)).toBe(2);
    }
    expect(
      await q('select intake_status, checked_by from production_lots where lot_code = $1', [lot]),
    ).toEqual([{ intake_status: 'pending', checked_by: null }]);
    expect(await run('intake', '--lot', lot, '--result', 'passed', '--by', 'QA test')).toBe(0);
    expect(
      await q('select intake_status, checked_by from production_lots where lot_code = $1', [lot]),
    ).toEqual([{ intake_status: 'passed', checked_by: 'QA test' }]);
    expect(await q('select object_type, object_id, decision from approvals')).toEqual([
      { object_type: 'lot_intake', object_id: lot, decision: 'approved' },
    ]);
    expect(await logs()).toEqual([['lot_intake', lot]]);
    expect(await q('select * from verify_action_log()')).toEqual([]);
    // kiểm lần 2 cùng lô → exit 1, không thêm approvals
    expect(await run('intake', '--lot', lot, '--result', 'failed', '--by', 'QA khác')).toBe(1);
    expect(await n('select count(*) from approvals')).toBe(1);
    const lot2 = doc.lots[1].lot_code as string;
    expect(await run('intake', '--lot', lot2, '--result', 'failed', '--by', 'QA test')).toBe(0);
    expect(await one('select decision from approvals where object_id = $1', [lot2])).toBe(
      'rejected',
    );
    expect(
      await run('intake', '--lot', 'KHONG-CO-LO', '--result', 'passed', '--by', 'QA test'),
    ).toBe(1);
    // điểm nối QR từ dòng DB: không người kiểm
    const row = (
      await q(
        'select lot_code, sku_key, exp_date::text as exp_date, intake_status, checked_by from production_lots where lot_code = $1',
        [lot],
      )
    )[0];
    const payload = prod.qrPayload(row);
    expect(Object.keys(payload ?? {}).sort()).toEqual(['exp_date', 'lot_code', 'sku_key']);
    expect(JSON.stringify(payload)).not.toContain('QA test');
  });

  // ------------------------------------------------------------ bản tin

  it('bản tin chỉ đọc: không đổi trạng thái, run mới nhất mỗi mốc, không tên người', async () => {
    await loadInv(SAMPLE_INV, 'sample');
    expect(await run(...ALLOC)).toBe(0);
    expect(await run('lots', '--load', SAMPLE_LOTS, '--source', 'sample')).toBe(0);
    expect(await run('bom', '--load', SAMPLE_BOM, '--source', 'sample')).toBe(0);
    const lot = String(await one('select min(lot_code) from production_lots'));
    expect(await run('intake', '--lot', lot, '--result', 'passed', '--by', 'Nguoi Kiem Nhap')).toBe(
      0,
    );
    const rid = String(await one('select min(run_id) from allocation_proposals'));
    expect(await run('approve', '--run', rid, '--by', 'Nguoi Duyet SX')).toBe(0);
    expect(await run(...ALLOC.slice(0, 3), '--start', '2026-10-19')).toBe(0); // run pending mới
    const state =
      "select (select string_agg(status, ',' order by id) from allocation_proposals) as a," +
      " (select string_agg(intake_status, ',' order by lot_code) from production_lots) as b";
    const before = await q(state);
    const doc = structuredClone(GOLDEN_DOC);
    for (const sk of doc.skus) if (sk.sku_key === 'saphraton-20v') sk.allowed_channels = [];
    goldenFile = write('g2.json', doc);
    out();
    expect(await run('bulletin', '--date', TODAY)).toBe(0);
    const s = out();
    expect(await q(state)).toEqual(before);
    const pos = HEADINGS.map((h) => s.indexOf(h));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    const sec = [0, 1, 2, 3].map((i) => s.slice(pos[i], i < 3 ? pos[i + 1] : undefined));
    expect(s).toContain('[MẪU]');
    expect(s).toContain('KHÔNG phải doanh số cam kết');
    expect(sec[0]).toContain('saphraton-20v');
    expect(sec[0]).toContain('chot_11_11');
    const newRid = String(
      await one('select min(run_id) from allocation_proposals where run_id <> $1', [rid]),
    );
    expect(sec[0]).toContain(`run ${newRid}`);
    expect(sec[0]).not.toContain(`run ${rid}`);
    expect(
      (sec[0] as string).split('\n').filter((l) => l.includes(' · saphraton-20v:')).length,
    ).toBe(1);
    expect(sec[1]).toContain('MAU-');
    expect(sec[1]).not.toContain(lot);
    expect(sec[2]).toContain('SKU saphraton-20v');
    expect(sec[3]).toContain('phân bổ');
    expect(sec[3]).toContain('lô');
    expect(s).not.toContain('Nguoi Kiem Nhap');
    expect(s).not.toContain('Nguoi Duyet SX');
    expect((await collect(pool, G)).bom_errors).toEqual([]);
  });

  it('cận hạn FEFO: chỉ lô passed trong cửa sổ, SKU còn tồn (0 → bỏ, chưa có số → liệt kê)', async () => {
    await loadInv(
      write('inv.csv', invCsv('savina-12v,kho-a,4,2026-10-10', 'saphraton-20v,kho-a,0,2026-10-10')),
    );
    const stock = await ic.currentStock(pool);
    const nostock = [...G.keys()].find((k) => !stock.has(k)) as string;
    const soon = addDays(TODAY, 30);
    const lots: [string, string, string, string][] = [
      ['NE-OK-1', 'savina-12v', soon, 'passed'],
      ['NE-ZERO-1', 'saphraton-20v', soon, 'passed'],
      ['NE-NOSTK-1', nostock, soon, 'passed'],
      ['NE-PEND-1', 'savina-12v', soon, 'pending'],
      ['NE-FAIL-1', 'savina-12v', soon, 'failed'],
      ['NE-FAR-1', 'savina-12v', addDays(TODAY, 400), 'passed'],
      ['NE-OLD-1', 'savina-12v', addDays(TODAY, -1), 'passed'],
      ['NE-ANCIENT-1', 'savina-12v', addDays(TODAY, -400), 'passed'],
    ];
    for (const [code, sku, exp, st] of lots) {
      await pool.query(
        'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, intake_status, checked_by, checked_at, source)' +
          " values ($1, $2, $3, $4, 3, $5, $6, $7, 'sample')",
        [
          code,
          sku,
          addDays(TODAY, -700),
          exp,
          st,
          st === 'pending' ? null : 'QA test',
          st === 'pending' ? null : NOW,
        ],
      );
    }
    const data = await collect(pool, G, null, addDays(TODAY, 90), addDays(TODAY, -90));
    const got = Object.fromEntries(data.near_expiry.map((r) => [r.lot_code, r.stock]));
    expect(Object.keys(got).sort()).toEqual(['NE-NOSTK-1', 'NE-OK-1', 'NE-OLD-1']);
    expect(got['NE-NOSTK-1']).toBeNull();
    expect(got['NE-OK-1']).toBe(stock.get('savina-12v')?.qty);
    expect((await collect(pool, G)).near_expiry).toEqual([]); // không cửa sổ
    const before = await one(
      "select string_agg(lot_code || intake_status, ',' order by lot_code) from production_lots",
    );
    out();
    expect(await run('bulletin', '--date', TODAY)).toBe(0);
    const s = out();
    // đợt hợp đồng C03: bản tin có thêm mục phiếu kiểm nghiệm SAU FEFO
    const sec = s.split(NEAR)[1]?.split('## Phiếu kiểm nghiệm lô')[0] as string;
    expect(
      sec
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.split(' · ')[0]),
    ).toEqual(['- NE-OLD-1', '- NE-NOSTK-1', '- NE-OK-1']);
    expect(s).not.toContain('QA test');
    expect(
      await one(
        "select string_agg(lot_code || intake_status, ',' order by lot_code) from production_lots",
      ),
    ).toBe(before);
  });

  it('bản tin: 2 tính năng TẮT → exit 2, không in/ghi; 1 TẮT → chỉ phần kia', async () => {
    settings.forceMode = 'tat';
    const dir = mkdtempSync(join(TMP, 'rep-'));
    expect(await run('bulletin', '--date', TODAY, '--out-dir', dir)).toBe(2);
    let s = out();
    expect(s).toContain('[rollout]');
    expect(s).not.toContain('# Bản tin');
    expect(readdirSync(dir)).toEqual([]);
    // theo sổ: production-01 vận hành, production-04.3 TẮT → bản tin không có mục cận hạn
    settings.forceMode = null;
    setConnector(async () => ({ db: pool, release: async () => {} }));
    await stage('production-01', 'van_hanh');
    await stage('production-04.3', 'tat');
    expect(await run('bulletin', '--date', TODAY, '--out-dir', dir)).toBe(2);
    s = out();
    expect(s).toContain('# Bản tin Sản xuất tuần');
    expect(s).not.toContain(NEAR);
    expect(s).toContain('[rollout] cảnh báo cận hạn: tính năng production-04.3 đang tắt');
    expect(readdirSync(dir)).toEqual([`sx-bantin-tuan-${TODAY}.md`]);
    expect(readFileSync(join(dir, `sx-bantin-tuan-${TODAY}.md`), 'utf8')).not.toContain(NEAR);
    expect(await n("select count(*) from report_outputs where name like 'sx-bantin-%'")).toBe(1);
    // ngược lại: bản tin TẮT, cận hạn chạy → chỉ in/ghi mục cận hạn
    await stage('production-01', 'tat');
    await stage('production-04.3', 'chay_thu');
    const dir2 = mkdtempSync(join(TMP, 'rep-'));
    expect(await run('bulletin', '--date', TODAY, '--period', 'month', '--out-dir', dir2)).toBe(2);
    s = out();
    expect(s).toContain(NEAR);
    expect(s).not.toContain(HEADINGS[0]);
    expect(readdirSync(dir2)).toEqual([`sx-canhan-${TODAY}.md`]);
    expect(
      readFileSync(join(dir2, `sx-canhan-${TODAY}.md`), 'utf8').startsWith('> **CHẠY THỬ'),
    ).toBe(true);
  });

  // ------------------------------------------------------------ inventory_csv (DB)

  it('inventory-csv nạp idempotent theo sha256 (login loader), [MẪU]', async () => {
    const inv = (argv: string[]) =>
      inventoryCsvMain(argv, { connectLoader: lease, io, now: () => NOW });
    expect(await inv(['--file', SAMPLE_INV, '--source', 'sample'])).toBe(0);
    const total = await n('select count(*) from inventory_snapshots');
    expect(total).toBeGreaterThanOrEqual(13);
    expect(out()).toContain('[MẪU]');
    expect(await inv(['--file', SAMPLE_INV, '--source', 'sample'])).toBe(0);
    expect(out()).toContain('[skip]');
    expect(await n('select count(*) from inventory_snapshots')).toBe(total);
    expect(await n('select count(distinct source) from inventory_snapshots')).toBe(1);
  });

  it('current_stock: mới nhất mỗi (sku, kho), cộng qua kho, SKU bỏ sót giữ số + stale', async () => {
    await loadInv(
      write(
        'a.csv',
        invCsv(
          'savina-12v,kho-a,10,2026-10-01',
          'savina-12v,kho-b,5,2026-10-01',
          'saphraton-40v,kho-a,3,2026-10-01',
        ),
      ),
    );
    await loadInv(write('b.csv', invCsv('savina-12v,kho-a,7,2026-10-08')));
    const st = await ic.currentStock(pool);
    expect(st.get('savina-12v')?.qty).toBe(12); // 7 (kho-a mới nhất) + 5 (kho-b)
    expect(st.get('savina-12v')?.kho['kho-a']).toEqual({
      qty: 7,
      captured_at: '2026-10-08',
      stale: false,
    });
    expect(st.get('savina-12v')?.sample).toBe(false);
    expect(st.get('savina-12v')?.stale).toEqual([]);
    expect(st.get('saphraton-40v')?.qty).toBe(3);
    expect(st.get('saphraton-40v')?.stale).toEqual(['kho-a']);
    expect(st.has('saphraton-20v')).toBe(false); // chưa có số tồn ≠ 0
  });

  // ------------------------------------------------------------ phiếu kiểm nghiệm (C03)

  async function mkLot(code: string, st = 'pending', src = 'manual', sku = 'c3-sku', qty = 5) {
    await pool.query(
      'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, intake_status, checked_by, checked_at, source)' +
        " values ($1, $2, '2026-10-01', '2027-10-01', $3, $4, $5, $6, $7)",
      [code, sku, qty, st, st === 'pending' ? null : 'QA', st === 'pending' ? null : NOW, src],
    );
  }

  it('phiếu: phiên bản tăng, tệp theo hash ngoài repo, cùng tệp từ chối, sổ append-only', async () => {
    await mkLot('C3-LOT');
    const store = join(TMP, 'kho1');
    const v1 = await lc.record(pool, 'C3-LOT', write('a.pdf', PDF), 'KN-001', 'Tổ Trưởng SX', {
      lab: 'Lab A',
      issued: '2026-10-02',
      store,
    });
    const v2 = await lc.record(pool, 'C3-LOT', write('b.bin', PNG), 'KN-001b', 'Tổ Trưởng SX', {
      store,
    });
    expect([v1, v2]).toEqual([1, 2]);
    expect(
      await q(
        'select version, cert_no, file_ext, recorded_by from lot_test_certificates order by version',
      ),
    ).toEqual([
      { version: 1, cert_no: 'KN-001', file_ext: 'pdf', recorded_by: 'Tổ Trưởng SX' },
      { version: 2, cert_no: 'KN-001b', file_ext: 'png', recorded_by: 'Tổ Trưởng SX' },
    ]);
    for (const r of await q('select file_sha256 from lot_test_certificates')) {
      expect(readFileSync(join(store, r.file_sha256 as string)).length).toBeGreaterThan(0);
    }
    await expect(
      lc.record(pool, 'C3-LOT', write('c.pdf', PDF), 'KN-002', 'Tổ Trưởng SX', { store }),
    ).rejects.toThrow(/đã ghi/);
    await expect(pool.query("update lot_test_certificates set cert_no = 'x'")).rejects.toThrow();
    await expect(pool.query('delete from lot_test_certificates')).rejects.toThrow();
    expect(await logs("action = 'lot_cert_record'")).toEqual([
      ['lot_cert_record', 'C3-LOT'],
      ['lot_cert_record', 'C3-LOT'],
    ]);
  });

  it('phiếu: lô không có / tệp sai / agent → từ chối, 0 dòng', async () => {
    await mkLot('C3-LOT');
    const store = join(TMP, 'kho2');
    await expect(
      lc.record(pool, 'KHONG-CO', write('a2.pdf', PDF), 'KN', 'Tổ Trưởng SX', { store }),
    ).rejects.toThrow(HumanError);
    await expect(
      lc.record(pool, 'C3-LOT', write('x.pdf', 'khong phai pdf'), 'KN', 'Tổ Trưởng SX', { store }),
    ).rejects.toThrow(lc.CertError);
    await expect(
      lc.record(pool, 'C3-LOT', write('e.pdf', ''), 'KN', 'Tổ Trưởng SX', { store }),
    ).rejects.toThrow(/rỗng/);
    const agent = lc.record(
      pool,
      'C3-LOT',
      write('g.pdf', Buffer.concat([PDF, Buffer.from('2')])),
      'KN',
      'agent:sx',
      {
        store,
      },
    );
    await expect(agent).rejects.toBeInstanceOf(Error);
    expect(await n('select count(*) from lot_test_certificates')).toBe(0);
  });

  it('cert-verify: ok / thiếu phiếu / lệch hash / thiếu tệp; bản tin hiện THIẾU phiếu', async () => {
    await mkLot('C3-LOT');
    await mkLot('C3-OLD');
    const store = join(TMP, 'kho3');
    await lc.record(pool, 'C3-LOT', write('a3.pdf', PDF), 'KN-1', 'A', { store });
    const st = Object.fromEntries((await lc.verify(pool, store)).map((r) => [r.lot, r.state]));
    expect(st).toEqual({ 'C3-LOT': 'ok', 'C3-OLD': 'thieu_phieu' });
    const sha = String(await one('select file_sha256 from lot_test_certificates'));
    chmodSync(join(store, sha), 0o644);
    writeFileSync(join(store, sha), '%PDF-sua');
    expect((await lc.verify(pool, store, 'C3-LOT'))[0]?.state).toBe('lech_hash');
    unlinkSync(join(store, sha));
    expect((await lc.verify(pool, store, 'C3-LOT'))[0]?.state).toBe('thieu_tep');
    const txt = prod.renderBulletin(
      await collect(pool, null),
      new Date('2026-10-20T00:00:00Z'),
      prod.loadConfig(),
    );
    const sec = txt.split('## Phiếu kiểm nghiệm lô')[1]?.split('## ')[0] as string;
    expect(sec).toContain('C3-LOT (pending) · phiếu KN-1 (v1)');
    expect(sec).toContain('C3-OLD (pending) · THIẾU phiếu');
  });

  it('CLI cert + cert-verify (LOT_CERT_DIR ngoài repo), agent bị chặn trước khi ghi', async () => {
    await mkLot('C3-CLI');
    env = { NODE_ENV: 'test', LOT_CERT_DIR: join(TMP, 'kho-cli') };
    const pdf = write('cli.pdf', PDF);
    expect(
      await run(
        'cert',
        '--lot',
        'C3-CLI',
        '--file',
        pdf,
        '--cert-no',
        ' KN-9 ',
        '--issued',
        '2026-10-03',
        '--by',
        'Tổ SX',
      ),
    ).toBe(0);
    expect(out()).toContain('[done] lô C3-CLI: phiếu KN-9 phiên bản 1 — người ghi: Tổ SX');
    expect(
      await run('cert', '--lot', 'C3-CLI', '--file', pdf, '--cert-no', 'KN-10', '--by', 'Tổ SX'),
    ).toBe(1);
    expect(out()).toContain('đã ghi cho lô C3-CLI — không ghi.');
    expect(
      await run(
        'cert',
        '--lot',
        'C3-CLI',
        '--file',
        write('cli2.pdf', PNG),
        '--cert-no',
        'K',
        '--by',
        'agent:sx',
      ),
    ).toBe(1);
    expect(out()).toContain('không phải người');
    expect(await n('select count(*) from lot_test_certificates')).toBe(1);
    expect(await run('cert-verify')).toBe(0);
    expect(out()).toContain('[ok] C3-CLI (pending) · KN-9 v1');
    await mkLot('C3-NONE');
    expect(await run('cert-verify')).toBe(1);
    expect(out()).toContain('[thieu_phieu] C3-NONE (pending)');
  });

  // ------------------------------------------------------------ tiến độ (C10)

  const section = async () =>
    prod
      .renderBulletin(
        await collect(pool, null),
        new Date('2026-10-20T09:00:00Z'),
        prod.loadConfig(),
      )
      .split('## Tiến độ sản xuất')[1]
      ?.split('\n## ')[0] as string;
  const DAY = '2026-10-20';
  const plan = (
    code: string,
    sku: string,
    qty: number,
    start: string,
    due: string,
    sample = false,
    by = 'GĐ SX',
  ) =>
    pool.query('select production_plan_add_human($1, $2, $3, $4, $5, null, $6, $7)', [
      code,
      sku,
      qty,
      start,
      due,
      sample,
      by,
    ]);
  const link = (p: string, l: string, by = 'GĐ SX') =>
    pool.query('select production_plan_link_human($1, $2, $3)', [p, l, by]);

  it('tiến độ: chưa có kế hoạch → THIẾU DỮ LIỆU', async () => {
    await mkLot('L1', 'passed', 'manual', 's1', 10);
    expect(await section()).toContain('THIẾU DỮ LIỆU — chưa có kế hoạch');
  });

  it('tiến độ: CHẬM / XONG / chưa tới khung; xong lâu → ẩn; lô mẫu → [MẪU]', async () => {
    await mkLot('A1', 'passed', 'manual', 's1', 30);
    await mkLot('A2', 'pending', 'manual', 's1', 20);
    await mkLot('A3', 'failed', 'manual', 's1', 5);
    await mkLot('B1', 'passed', 'manual', 's2', 100);
    await mkLot('F1', 'passed', 'manual', 's2', 1);
    await plan('KH-A', 's1', 100, addDays(DAY, -10), addDays(DAY, -2));
    await plan('KH-B', 's2', 100, addDays(DAY, -5), addDays(DAY, 5));
    await plan('KH-C', 's1', 50, addDays(DAY, 3), addDays(DAY, 20));
    await plan('KH-OLD', 's2', 1, addDays(DAY, -90), addDays(DAY, -60));
    await plan('KH-DONE', 's2', 1, addDays(DAY, -90), addDays(DAY, -60));
    for (const [p, l] of [
      ['KH-A', 'A1'],
      ['KH-A', 'A2'],
      ['KH-A', 'A3'],
      ['KH-B', 'B1'],
      ['KH-DONE', 'F1'],
    ]) {
      await link(p as string, l as string);
    }
    const sec = await section();
    expect(sec).toContain(
      'KH-A · s1 · kế hoạch 100 (2026-10-10→2026-10-18) · đạt 30 (30%) · chờ kiểm 20 · không đạt 5 · CHẬM — quá hạn 2 ngày',
    );
    expect(sec).toContain('KH-B · s2 · kế hoạch 100');
    expect(sec).toContain('đạt 100 (100%)');
    expect(sec).toContain('· XONG');
    expect(sec).toContain('KH-C');
    expect(sec).toContain('chưa tới khung');
    expect(sec).toContain('KH-OLD'); // chưa xong → vẫn hiện CHẬM
    expect(sec).not.toContain('KH-DONE');
    await mkLot('S1', 'passed', 'sample', 's1', 5);
    await plan('KH-S', 's1', 5, DAY, DAY);
    await link('KH-S', 'S1');
    expect((await collect(pool, null)).sample).toBe(true);
    expect(await section()).toContain('[MẪU]');
  });

  it('kế hoạch: gắn lô khác SKU/không có → từ chối; trùng → unique; agent → từ chối; append-only', async () => {
    await mkLot('X1', 'pending', 'manual', 's1');
    await mkLot('Y1', 'pending', 'manual', 's9');
    await plan('KH-X', 's1', 10, DAY, DAY);
    await expect(link('KH-X', 'Y1')).rejects.toThrow(/khác SKU/);
    await expect(link('KH-X', 'KHONG')).rejects.toThrow(/không tồn tại/);
    await link('KH-X', 'X1');
    await expect(link('KH-X', 'X1')).rejects.toMatchObject({ code: '23505' });
    await expect(plan('KH-Z', 's1', 10, DAY, DAY, false, 'agent:sx')).rejects.toThrow();
    await expect(pool.query('update production_plans set qty_plan = 1')).rejects.toThrow();
    await expect(pool.query('delete from production_plan_lots')).rejects.toThrow();
  });

  it('CLI plan-add / plan-link: người ghi qua function *_human; lỗi DB nêu tên lớp', async () => {
    await mkLot('P-LOT', 'passed', 'manual', 'savina-12v', 5);
    const add = [
      'plan-add',
      '--code',
      'KH-CLI',
      '--sku',
      'savina-12v',
      '--qty',
      '10',
      '--start',
      DAY,
      '--due',
      addDays(DAY, 5),
    ];
    expect(await run(...add, '--by', 'GĐ SX')).toBe(0);
    expect(out()).toContain('[done] plan-add KH-CLI — người ghi: GĐ SX');
    expect(await run(...add, '--by', 'GĐ SX')).toBe(1);
    expect(out()).toMatch(/UniqueViolation: .* — không ghi\./);
    expect(await run(...add.map((x) => (x === 'KH-CLI' ? 'KH-AG' : x)), '--by', 'agent:sx')).toBe(
      1,
    );
    expect(out()).toContain('không phải người');
    expect(await run('plan-link', '--plan', 'KH-CLI', '--lot', 'KHONG-CO', '--by', 'GĐ SX')).toBe(
      1,
    );
    expect(out()).toContain('ValueError: lô KHONG-CO không tồn tại — không ghi.');
    expect(await run('plan-link', '--plan', 'KH-CLI', '--lot', 'P-LOT', '--by', 'GĐ SX')).toBe(0);
    expect(await q('select plan_code, recorded_by from production_plans')).toEqual([
      { plan_code: 'KH-CLI', recorded_by: 'GĐ SX' },
    ]);
    expect(await logs("object_type = 'production_plan'")).toEqual([
      ['production_plan_add', 'KH-CLI'],
      ['production_plan_link', 'KH-CLI'],
    ]);
    expect(await section()).toContain('KH-CLI · savina-12v · kế hoạch 10');
  });

  it('HumanDenied/HumanError là RangeError (Python ValueError) — CLI bắt đúng lớp', () => {
    expect(new HumanDenied('x')).toBeInstanceOf(RangeError);
    expect(new HumanError('x')).toBeInstanceOf(RangeError);
  });
});
