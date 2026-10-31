import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Call } from './market-api-lite.js';
import {
  CONFIG_FILE,
  FEE_COLS,
  loadConfig,
  record,
  fetch as revFetch,
  summarize,
} from './rev-share.js';
import { revShareMain, settlementCsvMain } from './settlement.command.js';
import { type ApiRow, loadMap, run, write } from './settlement-api.js';
import {
  type Fees,
  loadFees,
  loadMapping,
  load as loadRows,
  lockOrders,
  MONEY,
  orderHash,
  overlaps,
  readSettlement,
  reconcile,
} from './settlement-csv.js';

// Dịch phần DB của tests/test_settlement_csv.py, test_settlement_overlap.py, test_rev_share.py,
// test_r15_settlement_api.py, test_r17_cong_tat.py (M2), test_v14_p3_rollout_edges.py (recon/rev),
// test_v13_review_fix.py (năm lệch chồng kỳ). MỖI test một DB riêng tạo từ mẫu (settlement_rows
// append-only — không xóa được giữa các test), xóa khi xong. KHÔNG BAO GIỜ DB `samsam`.
// Giai đoạn ép `van_hanh` như tests/conftest.py (`_FORCE_MODE`); ca TẮT ép `tat`.

const FIX = repoPath('tests', 'fixtures', 'finance');
const SETTLE = join(FIX, 'settlement_shopee_MAU.csv');
const PII = [
  'nguoimuagia',
  'NGUOI NHAN GIA',
  'DUONG GIA LAP',
  'GHI CHU GIA',
  'VDGIA',
  'FAKESET',
  '090000000',
];
const hasPii = (s: string) => PII.some((p) => s.includes(p));
const HASH_RE = /\b[0-9a-f]{16}\b/;
const EXPECT = { khop: 9, lech: 3, thieu_chung_tu: 2, hoan: 2 };
const NOW = new Date('2026-10-14T09:00:00+07:00');
const HEADER =
  'Mã đơn hàng,Ngày hoàn thành thanh toán,Giá sản phẩm,Phí cố định,' +
  'Phí thanh toán,Phí dịch vụ,Tổng tiền đã thanh toán';
const ROW_A = 'OVTEST0001,05/08/2026,1.000.000,-50.000,0,0,950.000';
type OrderFx = {
  row_no: number;
  order_id_hash: string;
  price: number;
  qty: number;
  status: string;
};
const ORDERS = (
  JSON.parse(
    readFileSync(new URL('./__fixtures__/settlement-csv.golden.json', import.meta.url), 'utf8'),
  ) as { orders_fixture: { rows: OrderFx[] } }
).orders_fixture.rows;

const TMP = mkdtempSync(join(tmpdir(), 'settle-db-'));
const FEES = loadFees()[0] as Fees;

function cap() {
  const lines: string[] = [];
  return {
    io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) },
    text: () => lines.join('\n'),
    clear: () => lines.splice(0),
  };
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('settlement (DB)', () => {
  const dbs: string[] = [];
  const logins: string[] = [];
  afterEach(() => {
    settings.forceMode = null;
  });
  afterAll(async () => {
    for (const n of dbs) await dropDb(n).catch(() => {});
    for (const l of logins) await adminQuery(`drop role if exists ${l}`).catch(() => {});
    rmSync(TMP, { recursive: true, force: true });
  });

  /** DB riêng từ mẫu + pool superuser (dữ liệu test); trả về DSN để lệnh tự mở pool riêng. */
  async function fresh(): Promise<{ dsn: string; pool: pg.Pool; name: string }> {
    settings.forceMode = 'van_hanh';
    const name = testDbName('settlement');
    dbs.push(name);
    const dsn = await createDbFromTemplate(name);
    return { dsn, pool: createPool(dsn), name };
  }
  const n = async (pool: pg.Pool, sql: string, p: unknown[] = []) =>
    Number((await pool.query(sql, p)).rows[0]?.n);

  async function csv(dsn: string, o: Parameters<typeof settlementCsvMain>[0], d = {}) {
    const c = cap();
    const rc = await settlementCsvMain(o, {
      io: c.io,
      env: {},
      service: async () => createPool(dsn),
      ...d,
    });
    return { rc, out: c.text() };
  }
  async function loadOrders(pool: pg.Pool, rows: OrderFx[] = ORDERS, tag = 'a'): Promise<void> {
    const sid = (
      await pool.query(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'order', $1, $2, $3) returning id",
        [`order_${tag}.csv`, createHash('sha256').update(tag).digest('hex'), rows.length],
      )
    ).rows[0].id;
    for (const r of rows) {
      await pool.query(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, price_vnd, qty, status, order_id_hash, raw) values ($1, $2, 'shopee', 'order', $3, $4, $5, $6, '{}')",
        [sid, r.row_no, r.price, r.qty, r.status, r.order_id_hash],
      );
    }
  }
  const labels = async (pool: pg.Pool) =>
    Object.fromEntries(
      (await pool.query('select label, count(*)::int as n from recon_results group by 1')).rows.map(
        (r) => [r.label, r.n],
      ),
    );
  function file(name: string, rows: string[], eol = '\n'): string {
    const p = join(TMP, name);
    writeFileSync(p, [HEADER, ...rows, ''].join(eol));
    return p;
  }
  async function order(pool: pg.Pool, oid: string, status = 'Hoàn thành', ch = 'shopee') {
    await pool.query(
      'insert into orders (id, ts, channel, total_vnd, status, source) values ($1, now(), $2, 0, $3, $4)',
      [`${ch}:${orderHash(ch, oid)}`, ch, status, `market:${ch}`],
    );
  }
  function cfgFile(over: Record<string, unknown>): string {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    const p = join(TMP, `rs_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ ...raw, ...over }));
    return p;
  }
  /** Pool ghi lại câu SQL của client (đếm câu ghi như Python TxConn(log)). */
  function loggedPool(dsn: string, log: string[]): pg.Pool {
    const p = createPool(dsn);
    const orig = p.connect.bind(p);
    (p as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const c = await orig();
      const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as unknown as { query: unknown }).query = (sql: unknown, params?: unknown) => {
        log.push(typeof sql === 'string' ? sql : String((sql as { text?: string }).text));
        return q(sql, params);
      };
      return c;
    };
    return p;
  }
  async function rev(
    dsn: string,
    o: Parameters<typeof revShareMain>[0],
    d: Record<string, unknown> = {},
  ) {
    const c = cap();
    const rc = await revShareMain(o, {
      io: c.io,
      env: {},
      now: NOW,
      connect: async () => createPool(dsn),
      ...d,
    });
    return { rc, out: c.text() };
  }

  // ------------------------------------------------------------ settlement-csv

  it('nạp + đối chiếu + idempotent + báo cáo (không PII/hash, không ghi bảng khác)', async () => {
    const { dsn, pool } = await fresh();
    await loadOrders(pool);
    let r = await csv(dsn, { file: SETTLE, channel: 'shopee' });
    expect(r.rc, r.out).toBe(0);
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(16);
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(16);
    expect(await labels(pool)).toEqual(EXPECT);
    const lech = new Set(
      (
        await pool.query("select reasons->0->>'code' as c from recon_results where label = 'lech'")
      ).rows.map((x) => x.c),
    );
    expect(lech).toEqual(new Set(['thuc_nhan', 'phi_co_dinh', 'gia_tri_don']));
    const hoan = await pool.query(
      "select s.refund_vnd::int as r from settlement_rows s join recon_results r on r.settlement_row_id = s.id where r.label = 'hoan' order by s.row_no",
    );
    expect(hoan.rows.map((x) => x.r)).toEqual([299000, 100000]);
    // nạp lại → skip, không đổi
    r = await csv(dsn, { file: SETTLE, channel: 'shopee' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[skip]');
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(16);
    r = await csv(dsn, { report: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('khop=9, lech=3, thieu_chung_tu=2, hoan=2');
    expect(r.out).toContain('settlement_shopee_MAU.csv dòng 11: thuc_nhan chênh -5.000đ');
    expect(r.out).toContain(
      'thực nhận theo file 6.910.920đ; tính lại 6.915.920đ; chênh -5.000đ; affiliate sàn khấu trừ 68.400đ; đơn ở ≥2 file quyết toán: 0',
    );
    const hashes = (await pool.query('select order_id_hash from settlement_rows')).rows.map(
      (x) => x.order_id_hash as string,
    );
    expect(hashes.some((h) => r.out.includes(h))).toBe(false);
    expect(hasPii(r.out)).toBe(false);
    for (const t of ['invoice_lines', 'dealer_ar', 'approval_queue', 'market_alerts']) {
      expect(await n(pool, `select count(*) as n from ${t}`)).toBe(0);
    }
  });

  it('đơn ở 2 file quyết toán: khoản trùng nguyên văn tính 1 lần + báo chồng kỳ', async () => {
    const { dsn, pool } = await fresh();
    await loadOrders(pool);
    const t = readFileSync(SETTLE, 'utf8');
    const p = join(TMP, 'settlement_lan2.csv');
    writeFileSync(
      p,
      t
        .split('\n')
        .map((ln) =>
          ln.startsWith('FAKESET0001') || ln.startsWith('Mã đơn') || !ln
            ? ln
            : ln.replace('FAKESET00', 'FAKESEZ00'),
        )
        .join('\n'),
    );
    for (const f of [SETTLE, p])
      expect((await csv(dsn, { file: f, channel: 'shopee' })).rc).toBe(0);
    const r = await csv(dsn, { report: true });
    expect(r.out).toContain('shopee: 32 dòng');
    expect(r.out).toContain(
      'thực nhận theo file 13.542.000đ; tính lại 13.552.000đ; chênh -10.000đ; affiliate sàn khấu trừ 136.800đ; đơn ở ≥2 file quyết toán: 1',
    );
    expect(r.out).toContain('khoản xuất lại ở ≥2 file: trùng 1, lệch 0 — tổng tiền tính 31 khoản');
    expect(r.out).toContain('settlement_lan2.csv');
    expect(r.out).toContain('settlement_shopee_MAU.csv');
    expect(hasPii(r.out)).toBe(false);
  });

  it('file quyết toán tới trước file đơn → --reconcile; snapshot đơn MỚI NHẤT thắng', async () => {
    const { dsn, pool } = await fresh();
    expect((await csv(dsn, { file: SETTLE, channel: 'shopee' })).rc).toBe(0);
    expect(await labels(pool)).toEqual({ thieu_chung_tu: 16 });
    await loadOrders(pool);
    expect((await csv(dsn, { reconcile: true })).rc).toBe(0);
    expect(await labels(pool)).toEqual(EXPECT);
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(16);
    // snapshot đơn mới: FAKESET0001 đổi giá 159.000 → 160.000 (×2)
    const h1 = orderHash('shopee', 'FAKESET0001');
    await loadOrders(
      pool,
      ORDERS.map((o) => (o.order_id_hash === h1 ? { ...o, price: 160000 } : o)),
      'b',
    );
    expect((await csv(dsn, { reconcile: true })).rc).toBe(0);
    const row = (
      await pool.query(
        'select r.label, r.order_amount_vnd::int as amt, r.reasons from recon_results r join settlement_rows s on s.id = r.settlement_row_id where s.row_no = 2',
      )
    ).rows[0];
    expect(row.label).toBe('lech');
    expect(row.amt).toBe(320000);
    expect(row.reasons).toEqual([{ code: 'gia_tri_don', expected: 320000, actual: 318000 }]);
  });

  it('--reconcile khi rỗng + --report chưa có file; ràng buộc schema recon/settlement', async () => {
    const { dsn, pool } = await fresh();
    let r = await csv(dsn, { reconcile: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('khop=0, lech=0, thieu_chung_tu=0, hoan=0');
    r = await csv(dsn, { report: true });
    expect(r.out).toContain('shopee: chưa có file quyết toán');
    const sid = (
      await pool.query(
        "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, payout_vnd) values ($1, 'f.csv', 'shopee', 2, $2, 100, 90) returning id",
        ['a'.repeat(64), 'b'.repeat(16)],
      )
    ).rows[0].id;
    const ins =
      'insert into recon_results (settlement_row_id, label, reasons, expected_payout_vnd) values ($1, $2, $3, 0)';
    for (const [lb, rs] of [
      ['khac', '[]'],
      ['khop', '[{"code": "thuc_nhan"}]'],
      ['lech', '[]'],
    ]) {
      await expect(pool.query(ins, [sid, lb, rs])).rejects.toMatchObject({ code: '23514' });
    }
    await pool.query(ins, [sid, 'hoan', '[]']);
    await expect(pool.query(ins, [sid, 'khop', '[]'])).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, refund_vnd, payout_vnd) values ($1, 'f', 'shopee', 3, $2, 1, -1, 0)",
        ['a'.repeat(64), 'b'.repeat(16)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, payout_vnd, source_kind) values ($1, 'x', 'shopee', 2, $2, 1, 1, 'api_sandbox')",
        ['c'.repeat(64), 'd'.repeat(16)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('login svc_loader chế độ thực: nạp + đối soát được, KHÔNG xóa/sửa được settlement_rows', async () => {
    const { dsn, pool, name } = await fresh();
    settings.forceMode = null; // đọc sổ triển khai thật bằng login loader (chưa vào sổ → chạy thử)
    const login = `t_settle_ld_${process.pid}`;
    logins.push(login);
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password '${pw}' in role svc_loader`);
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    const env = { NODE_ENV: 'test', APPROVAL_ENFORCE: '1', LOADER_DATABASE_URL: u.toString() };
    const c = cap();
    expect(await settlementCsvMain({ file: SETTLE, channel: 'shopee' }, { io: c.io, env })).toBe(0);
    expect(c.text()).toContain('[load] quyết toán shopee settlement_shopee_MAU.csv: 16 dòng');
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(16);
    const lp = createPool(u.toString());
    try {
      await expect(lp.query('delete from settlement_rows')).rejects.toBeTruthy();
      await expect(lp.query('update settlement_rows set payout_vnd = 1')).rejects.toBeTruthy();
    } finally {
      await lp.end();
    }
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(16);
    // superuser/owner bị từ chối ở chế độ thực
    const c2 = cap();
    expect(
      await settlementCsvMain(
        { report: true },
        { io: c2.io, env: { ...env, LOADER_DATABASE_URL: dsn } },
      ),
    ).toBe(2);
    expect(c2.text()).toContain('SUPERUSER');
  });

  // ------------------------------------------------------------ chồng kỳ (F01) + rev_share

  it('probe F01: 2 file khác SHA cùng 1 khoản → thuần 950.000, BẤT THƯỜNG, không tính phí', async () => {
    const { dsn, pool } = await fresh();
    const a = file('quyet_toan_T8_lan1.csv', [ROW_A]);
    const b = file('quyet_toan_T8_lan2.csv', [ROW_A], '\r\n');
    expect((await csv(dsn, { file: a, channel: 'shopee' })).rc).toBe(0);
    const rb = await csv(dsn, { file: b, channel: 'shopee' });
    expect(rb.rc).toBe(0);
    expect(rb.out).toContain('[warn] khoản xuất lại ở ≥2 file (chồng kỳ): trùng 1, lệch 0');
    await order(pool, 'OVTEST0001');
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(2); // GIỮ thô
    const cfg = cfgFile({
      ngay_bat_dau_van_hanh: '2026-01-01',
      ty_le_phi_van_hanh: 0.05,
      kenh_truc_tuyen: ['shopee'],
    });
    const r = await rev(dsn, { quarter: '2026-Q3', dryRun: true }, { configFile: cfg });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('1.900.000đ');
    expect(r.out).toContain('**950.000đ**');
    expect(r.out).toContain('quyet_toan_T8_lan1.csv');
    expect(r.out).toContain('quyet_toan_T8_lan2.csv');
    expect(r.out).toContain('BẤT THƯỜNG');
    expect(r.out).toContain('chồng');
    expect(r.out).toContain('| Phí vận hành (quy đổi sản phẩm) | — (');
    expect(r.out).not.toContain('47.500đ');
    expect(r.out).not.toContain('95.000đ');
    expect(HASH_RE.test(r.out)).toBe(false);
    // cùng số ở mọi caller: rev_share = view Bên A = báo cáo ACC-Recon
    const [rows] = await revFetch(pool, '2026-07-01', '2026-10-01', ['shopee']);
    const ov = await overlaps(pool, ['shopee'], '2026-07-01', '2026-10-01');
    const s = summarize(rows, ['shopee'], FEE_COLS, ov);
    expect(s.total.payout).toBe(950_000n);
    expect(s.total.net).toBe(950_000n);
    expect(s.anomaly).toBe(true);
    expect(ov).toEqual({
      shopee: { trung: 1, lech: 0, files: ['quyet_toan_T8_lan1.csv', 'quyet_toan_T8_lan2.csv'] },
    });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role ben_a_reader');
      const got = (
        await c.query(
          'select sum(payout_vnd)::int as p, sum(n_rows)::int as k from v_ben_a_settlement_daily',
        )
      ).rows[0];
      expect(got).toEqual({ p: 950_000, k: 1 });
      await expect(c.query('select count(*) from v_settlement_khoan')).rejects.toThrow(
        'permission denied',
      );
    } finally {
      await c.query('rollback');
      c.release();
    }
    const rep = await csv(dsn, { report: true });
    expect(rep.out).toContain('thực nhận theo file 950.000đ');
    expect(rep.out).toContain('xuất lại ở ≥2 file: trùng 1, lệch 0');
  });

  it('cùng đơn ở 2 file nhưng số khác → giữ cả 2, BẤT THƯỜNG lệch; năm không xét mức thưởng', async () => {
    const { dsn, pool } = await fresh();
    for (const p of [
      file('lan1.csv', [ROW_A]),
      file('lan2.csv', ['OVTEST0001,05/08/2026,1.000.000,-60.000,0,0,940.000']),
    ]) {
      expect((await csv(dsn, { file: p, channel: 'shopee' })).rc).toBe(0);
    }
    await order(pool, 'OVTEST0001');
    const ov = await overlaps(pool, ['shopee'], '2026-07-01', '2026-10-01');
    expect(ov.shopee?.lech).toBe(1);
    expect(ov.shopee?.trung).toBe(0);
    const cfg = cfgFile({
      ngay_ky_hop_dong: '2026-01-01',
      ngay_bat_dau_van_hanh: '2026-01-01',
      ty_le_phi_van_hanh: 0.05,
      kenh_truc_tuyen: ['shopee'],
      muc_thuong: [{ muc: 1, tu_vnd: 1_000_000, ty_le: 0.1 }],
    });
    let r = await rev(dsn, { quarter: '2026-Q3', dryRun: true }, { configFile: cfg });
    expect(r.out).toContain('BẤT THƯỜNG');
    expect(r.out).toContain('lệch');
    expect(r.out).toContain('lan1.csv');
    expect(r.out).toContain('lan2.csv');
    expect(r.out).toContain('| Phí vận hành (quy đổi sản phẩm) | — (');
    // v13 vá review: năm có kênh lệch → không 'đạt', không thưởng trên số gấp đôi
    r = await rev(
      dsn,
      { year: '1', dryRun: true },
      { configFile: cfg, now: new Date('2027-01-02T00:00:00+07:00') },
    );
    expect(r.rc).toBe(0);
    const row = r.out.split('\n').find((ln) => ln.startsWith('| 1 |')) as string;
    expect(row).not.toContain('| đạt |');
    expect(row).toContain('bất thường');
    expect(r.out).not.toContain('89.000đ');
  });

  it('nạp lại cùng file idempotent; khoản trùng ngoài kỳ không gắn bất thường cho kỳ khác', async () => {
    const { dsn, pool } = await fresh();
    const a = file('lan1.csv', [ROW_A]);
    expect((await csv(dsn, { file: a, channel: 'shopee' })).rc).toBe(0);
    const again = await csv(dsn, { file: a, channel: 'shopee' });
    expect(again.rc).toBe(0);
    expect(again.out).toContain('[skip]');
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(1);
    expect(await overlaps(pool, ['shopee'])).toEqual({});
    expect(
      (await csv(dsn, { file: file('lan2.csv', [ROW_A], '\r\n'), channel: 'shopee' })).rc,
    ).toBe(0);
    expect(await overlaps(pool, ['shopee'], '2026-10-01', '2027-01-01')).toEqual({});
    expect(await overlaps(pool, ['tiktok'])).toEqual({});
    expect((await overlaps(pool, ['shopee'])).shopee?.trung).toBe(1);
  });

  it('điều chỉnh hợp lệ: cùng đơn 2 dòng khác txn_type → giữ cả 2, không bất thường', async () => {
    const { dsn, pool } = await fresh();
    const [m] = loadMapping();
    const mm = JSON.parse(JSON.stringify(m));
    mm.shopee.optional.txn_type = 'Loại giao dịch';
    const mp = join(TMP, 'map_txn.json');
    writeFileSync(mp, JSON.stringify(mm));
    const p = join(TMP, 'dieu_chinh.csv');
    writeFileSync(
      p,
      [
        `${HEADER},Loại giao dịch`,
        `${ROW_A},Đơn hàng`,
        'OVTEST0001,20/08/2026,0,0,0,0,-30.000,Điều chỉnh',
        '',
      ].join('\n'),
    );
    expect((await csv(dsn, { file: p, channel: 'shopee' }, { mapFile: mp })).rc).toBe(0);
    await order(pool, 'OVTEST0001');
    expect(
      (await pool.query('select array_agg(txn_type order by row_no) as a from settlement_rows'))
        .rows[0].a,
    ).toEqual(['Đơn hàng', 'Điều chỉnh']);
    const [rows] = await revFetch(pool, '2026-07-01', '2026-10-01', ['shopee']);
    const ov = await overlaps(pool, ['shopee'], '2026-07-01', '2026-10-01');
    const s = summarize(rows, ['shopee'], FEE_COLS, ov);
    expect(ov).toEqual({});
    expect(s.anomaly).toBe(false);
    expect(s.total.payout).toBe(920_000n);
    expect(rows).toHaveLength(2);
    const dup = join(TMP, 'trung_loai.csv');
    writeFileSync(
      dup,
      [`${HEADER},Loại giao dịch`, `${ROW_A},Đơn hàng`, `${ROW_A},Đơn hàng`, ''].join('\n'),
    );
    const [rows2, errs] = await readSettlement(dup, 'shopee', mm);
    expect(rows2).toEqual([]);
    expect(errs.some((e) => e.includes('trùng'))).toBe(true);
  });

  // ------------------------------------------------------------ rev_share

  const INS =
    'insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd,' +
    ' fixed_fee_vnd, payment_fee_vnd, service_fee_vnd, voucher_seller_vnd, refund_vnd, payout_vnd, settled_on)' +
    ' values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)';
  const FILE = 'quyet_toan_0901234567.csv'; // tên file có SĐT giả → phải che

  /** Quý 2026-Q3: shopee thuần 1.275.000 (1 đơn hủy), tiktok 270.000. */
  async function seed(pool: pg.Pool): Promise<void> {
    let k = 0;
    const s = async (
      ch: string,
      h: string,
      amount: number,
      o: {
        fixed?: number;
        pay?: number;
        svc?: number;
        vou?: number;
        refund?: number;
        payout?: number;
        day?: string | null;
        status?: string;
      },
    ) => {
      k++;
      await pool.query(INS, [
        ch === 'shopee' ? 'a'.repeat(64) : 'b'.repeat(64),
        FILE,
        ch,
        k + 1,
        h,
        amount,
        o.fixed ?? 0,
        o.pay ?? 0,
        o.svc ?? 0,
        o.vou ?? 0,
        o.refund ?? 0,
        o.payout ?? 0,
        o.day ?? null,
      ]);
      if (o.status) {
        await pool.query(
          'insert into orders (id, ts, channel, total_vnd, status, source) values ($1, now(), $2, $3, $4, $5)',
          [`${ch}:${h}`, ch, amount, o.status, `market:${ch}`],
        );
      }
    };
    await s('shopee', '1'.repeat(16), 1_000_000, {
      fixed: 40_000,
      pay: 30_000,
      svc: 20_000,
      vou: 10_000,
      payout: 900_000,
      day: '2026-07-01',
      status: 'Hoàn thành',
    });
    await s('shopee', '2'.repeat(16), 500_000, {
      fixed: 20_000,
      refund: 100_000,
      payout: 380_000,
      day: '2026-09-30',
      status: 'Hoàn thành',
    });
    await s('shopee', '3'.repeat(16), 200_000, {
      fixed: 5_000,
      refund: 200_000,
      payout: -5_000,
      day: '2026-08-01',
      status: 'cancelled',
    });
    await s('shopee', '4'.repeat(16), 999, { payout: 999, day: '2026-10-01', status: 'x' }); // ngoài kỳ (sau)
    await s('shopee', '5'.repeat(16), 777, { payout: 777, day: '2026-06-30', status: 'x' }); // ngoài kỳ (trước)
    await s('shopee', '6'.repeat(16), 555, { payout: 555, day: null, status: 'x' }); // không ngày
    await s('tiktok', '7'.repeat(16), 300_000, {
      svc: 30_000,
      payout: 270_000,
      day: '2026-08-10',
      status: 'Completed',
    });
  }

  it('fetch + summarize: công thức, đơn hủy không trừ 2 lần, đơn source khác market:% không tính', async () => {
    const { pool } = await fresh();
    await seed(pool);
    let [rows, undated] = await revFetch(pool, '2026-07-01', '2026-10-01', ['shopee', 'tiktok']);
    expect(rows).toHaveLength(4);
    expect(undated).toEqual({ shopee: 1 });
    const s = summarize(rows, ['shopee', 'tiktok'], FEE_COLS);
    const sh = s.channels.shopee;
    expect([sh?.gross, sh?.fee, sh?.cancel, sh?.refund, sh?.net]).toEqual([
      1_700_000n,
      125_000n,
      200_000n,
      100_000n,
      1_275_000n,
    ]);
    expect(sh?.payout).toBe(1_275_000n);
    expect([s.channels.tiktok?.net, s.total.net]).toEqual([270_000n, 1_545_000n]);
    await pool.query("update orders set source = 'manual' where id = $1", [
      `shopee:${'3'.repeat(16)}`,
    ]);
    [rows] = await revFetch(pool, '2026-07-01', '2026-10-01', ['shopee']);
    expect(summarize(rows, ['shopee'], FEE_COLS).total.net).toBeNull();
  });

  it('--quarter --record: biên bản + 1 dòng revenue_quarters (CHỈ SELECT + 1 insert), ghi lại = dòng mới', async () => {
    const { dsn, pool } = await fresh();
    await seed(pool);
    const out = mkdtempSync(join(TMP, 'q-'));
    const cfg = cfgFile({ ngay_bat_dau_van_hanh: '2026-01-01', ty_le_phi_van_hanh: 0.05 });
    const log: string[] = [];
    let r = await rev(
      dsn,
      { quarter: '2026-Q3', record: true, outDir: out },
      { configFile: cfg, connect: async () => loggedPool(dsn, log) },
    );
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toMatch(/revenue_quarters #\d+/);
    const text = readFileSync(join(out, 'doi-soat-2026-Q3.md'), 'utf8');
    for (const s of [
      'quý 2026-Q3',
      'BẢN ĐỀ XUẤT',
      '1.545.000đ',
      '1.275.000đ',
      '| Tỷ lệ phí vận hành | 5% |',
      '77.250đ',
      'Điều 7.6',
      '| (ký, ghi rõ họ tên) |',
      'shopee: 1 dòng quyết toán không có ngày',
      'website: chưa có nguồn',
    ]) {
      expect(text).toContain(s);
    }
    expect(HASH_RE.test(text)).toBe(false);
    expect(text).not.toContain('0901234567');
    const rows = (
      await pool.query(
        'select quarter, period_start::text as ps, period_end::text as pe, gross_vnd::int as g, platform_fee_vnd::int as f,' +
          ' cancel_vnd::int as c, refund_vnd::int as r, net_vnd::int as n, payout_vnd::int as p, fee_rate::text as fr,' +
          ' ops_fee_vnd::int as o, recorded_by as by, detail, report_sha256 as sha from revenue_quarters',
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const x = rows[0];
    expect([x.quarter, x.ps, x.pe, x.g, x.f, x.c, x.r, x.n, x.p, Number(x.fr), x.o, x.by]).toEqual([
      '2026-Q3',
      '2026-07-01',
      '2026-10-01',
      2_000_000,
      155_000,
      200_000,
      100_000,
      1_545_000,
      1_545_000,
      0.05,
      77_250,
      'agent:rev_share',
    ]);
    expect(HASH_RE.test(JSON.stringify(x.detail))).toBe(false);
    expect(x.detail.channels.tiktok.net).toBe(270_000);
    expect(x.sha).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    const writes = log.filter(
      (q) => !/^\s*(select|begin|commit|rollback|savepoint|release)\b/i.test(q),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('insert into revenue_quarters');
    r = await rev(dsn, { quarter: '2026-Q3', record: true, outDir: out }, { configFile: cfg });
    expect(r.rc).toBe(0);
    expect(await n(pool, 'select count(*) as n from revenue_quarters')).toBe(2);
  });

  it('cấu hình mặc định chưa chốt + thiếu kênh → "chưa có dữ liệu", số ghi sổ null', async () => {
    const { dsn, pool } = await fresh();
    await pool.query(INS, [
      'c'.repeat(64),
      'f.csv',
      'shopee',
      2,
      '8'.repeat(16),
      1000,
      0,
      0,
      0,
      0,
      0,
      1000,
      '2026-08-01',
    ]);
    await pool.query(
      "insert into orders (id, ts, channel, total_vnd, status, source) values ($1, now(), 'shopee', 1000, 'ok', 'market:shopee')",
      [`shopee:${'8'.repeat(16)}`],
    );
    const out = mkdtempSync(join(TMP, 'u-'));
    expect((await rev(dsn, { quarter: '2026-Q3', record: true, outDir: out })).rc).toBe(0);
    const text = readFileSync(join(out, 'doi-soat-2026-Q3.md'), 'utf8');
    expect(text).toContain('| Tỷ lệ phí vận hành | chưa chốt |');
    expect(text).toContain('— (chưa chốt tỷ lệ phí vận hành)');
    expect(text).toContain('tiktok: chưa có dữ liệu');
    expect(text).toMatch(/\| \*\*Tổng\*\* \| chưa có dữ liệu/);
    expect(
      (await pool.query('select net_vnd, gross_vnd, fee_rate, ops_fee_vnd from revenue_quarters'))
        .rows[0],
    ).toEqual({ net_vnd: null, gross_vnd: null, fee_rate: null, ops_fee_vnd: null });
  });

  it('--dry-run: in biên bản, KHÔNG ghi file/sổ, chỉ SELECT', async () => {
    const { dsn, pool } = await fresh();
    await seed(pool);
    const out = mkdtempSync(join(TMP, 'd-'));
    const log: string[] = [];
    const r = await rev(
      dsn,
      { quarter: '2026-Q3', dryRun: true, outDir: out },
      { connect: async () => loggedPool(dsn, log) },
    );
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Biên bản đối soát');
    expect(readdirSync(out)).toEqual([]);
    expect(log.every((q) => /^\s*(select|begin|rollback)\b/i.test(q))).toBe(true);
    expect(await n(pool, 'select count(*) as n from revenue_quarters')).toBe(0);
  });

  it('--year: năm hợp tác từ NGÀY KÝ, so mức thưởng; không ghi sổ', async () => {
    const { dsn, pool } = await fresh();
    await seed(pool);
    const out = mkdtempSync(join(TMP, 'y-'));
    const cfg = cfgFile({
      ngay_ky_hop_dong: '2025-09-01',
      kenh_truc_tuyen: ['shopee', 'tiktok'],
      muc_thuong: [
        { muc: 1, tu_vnd: 1_000_000, ty_le: 0.1 },
        { muc: 2, tu_vnd: 2_000_000, ty_le: null },
        { muc: 3, tu_vnd: null, ty_le: null },
      ],
    });
    expect((await rev(dsn, { year: '1', outDir: out }, { configFile: cfg })).rc).toBe(0);
    const text = readFileSync(join(out, 'doi-soat-nam-1.md'), 'utf8');
    // năm 1 = 2025-09-01 → 2026-08-31: 777 + 900.000 − 5.000 + 270.000 = 1.165.777
    expect(text).toContain('năm hợp tác thứ 1');
    expect(text).toContain('| 1 | 1.000.000đ | 10% | đạt | 165.777đ | 16.578đ |');
    expect(text).toContain('| 2 | 2.000.000đ | chưa chốt | chưa đạt | — | — |');
    expect(text).toContain('| 3 | chưa chốt | chưa chốt | chưa chốt ngưỡng | — | — |');
    expect(await n(pool, 'select count(*) as n from revenue_quarters')).toBe(0);
    // F09: ký 15/10/2026, vận hành 11/02/2027 → năm 1 tính từ ngày ký; 1 giây trước tròn năm → chưa đóng
    const cfg2 = cfgFile({ ngay_ky_hop_dong: '2026-10-15', ngay_bat_dau_van_hanh: '2027-02-11' });
    const late = new Date('2027-10-15T00:00:00+07:00');
    const r = await rev(dsn, { year: '1', dryRun: true }, { configFile: cfg2, now: late });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('năm 1: 2026-10-15 → 2027-10-14');
    expect(r.out).not.toContain('2028-02-1');
    expect(r.out).toContain('| Ngày ký hợp đồng (mốc năm hợp tác) | 2026-10-15 |');
    expect(r.out).toContain('| Ngày bắt đầu vận hành thương mại | 2027-02-11 |');
    expect(
      (
        await rev(
          dsn,
          { year: '1', dryRun: true },
          { configFile: cfg2, now: new Date(late.getTime() - 1000) },
        )
      ).rc,
    ).toBe(2);
  });

  it('revenue_quarters append-only + ràng buộc; ben_a_reader chỉ đọc view, không bảng gốc', async () => {
    const { pool } = await fresh();
    await seed(pool);
    const rid = (
      await pool.query(
        "insert into revenue_quarters (quarter, period_start, period_end, report_sha256, recorded_by) values ('2026-Q3', '2026-07-01', '2026-10-01', $1, 'agent:rev_share') returning id",
        ['a'.repeat(64)],
      )
    ).rows[0].id;
    for (const sql of [
      'update revenue_quarters set net_vnd = 1',
      'delete from revenue_quarters',
      'truncate revenue_quarters',
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: 'P0001' });
    }
    expect((await pool.query('select id from revenue_quarters')).rows.map((x) => x.id)).toEqual([
      rid,
    ]);
    for (const bad of [
      "('2026-Q5', '2026-07-01', '2026-10-01', $1, 'x', null)",
      "('2026-Q3', '2026-10-01', '2026-07-01', $1, 'x', null)",
      "('2026-Q3', '2026-07-01', '2026-10-01', $1, ' ', null)",
      "('2026-Q3', '2026-07-01', '2026-10-01', $1, 'x', 5)",
    ]) {
      await expect(
        pool.query(
          `insert into revenue_quarters (quarter, period_start, period_end, report_sha256, recorded_by, ops_fee_vnd) values ${bad}`,
          ['a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role ben_a_reader');
      const got = await c.query(
        "select channel, sum(order_amount_vnd)::int as g, sum(payout_vnd)::int as p from v_ben_a_settlement_daily where settled_on >= '2026-07-01' and settled_on < '2026-10-01' group by 1 order by 1",
      );
      expect(got.rows).toEqual([
        { channel: 'shopee', g: 1_700_000, p: 1_275_000 },
        { channel: 'tiktok', g: 300_000, p: 270_000 },
      ]);
      await c.query('rollback');
      for (const t of [
        'settlement_rows',
        'orders',
        'market_rows',
        'contacts',
        'leads',
        'recon_results',
      ]) {
        await c.query('begin');
        await c.query('set local role ben_a_reader');
        await expect(c.query(`select count(*) from ${t}`)).rejects.toMatchObject({ code: '42501' });
        await c.query('rollback');
      }
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  // ------------------------------------------------------------ cổng triển khai TẮT (HĐ 6.7)

  it('finance-01 TẮT: CSV nạp + commit dòng, KHÔNG đối soát, exit 2; chạy lại → skip', async () => {
    const { dsn, pool } = await fresh();
    settings.forceMode = 'tat';
    let r = await csv(dsn, { file: SETTLE, channel: 'shopee' });
    expect(r.rc).toBe(2);
    expect(r.out).toContain('[blocked]');
    expect(r.out).toContain('[load]');
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(16);
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(0);
    r = await csv(dsn, { file: SETTLE, channel: 'shopee' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[skip]');
    expect(await n(pool, 'select count(*) as n from settlement_rows')).toBe(16);
    r = await csv(dsn, { reconcile: true });
    expect(r.rc).toBe(2);
    expect(r.out).toContain('— không đối soát.');
    // reconcile trực tiếp: RolloutBlocked TRƯỚC mọi ghi
    const c = await pool.connect();
    try {
      await c.query('begin');
      await expect(reconcile(c, FEES)).rejects.toThrow(RolloutBlocked);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(0);
  });

  it('finance-06 TẮT: rev_share không ghi báo cáo/sổ (exit 2); record() chặn trước insert', async () => {
    const { dsn, pool } = await fresh();
    await seed(pool);
    settings.forceMode = 'tat';
    const out = mkdtempSync(join(TMP, 't-'));
    const r = await rev(dsn, { quarter: '2026-Q3', record: true, outDir: out });
    expect(r.rc).toBe(2);
    expect(r.out).toContain('[blocked]');
    expect(readdirSync(out)).toEqual([]);
    const c = await pool.connect();
    try {
      await c.query('begin');
      const s = summarize([], ['shopee'], FEE_COLS);
      await expect(
        record(c, '2026-Q3', '2026-07-01', '2026-10-01', s, null, null, 'x', loadConfig()),
      ).rejects.toThrow(RolloutBlocked);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(await n(pool, 'select count(*) as n from revenue_quarters')).toBe(0);
  });

  // ------------------------------------------------------------ settlement-api (ghi sổ)

  const SP_MAP = {
    trang_thai: 'da_chot',
    duyet_boi: 'Kế toán trưởng (GIẢ — test)',
    can_cu: 'FIXTURE test — không phải bảng thật',
    ngay_chot: '2026-10-25',
    tien_te_shop: 'VND',
    thanh_phan: {
      escrow_amount: { cot: 'payout', dau: 1 },
      order_original_price: { cot: 'order_amount', dau: 1 },
      commission_fee: { cot: 'fixed_fee', dau: 1 },
      buyer_paid_shipping_fee: { cot: 'shipping_fee', dau: -1 },
      actual_shipping_fee: { cot: 'shipping_fee', dau: 1 },
      buyer_total_amount: { bo_qua: true },
      'items[]': { bo_qua: true },
    },
  };
  const inc = (base: number) => ({
    escrow_amount: base - 20000,
    order_original_price: base,
    commission_fee: 10000,
    buyer_paid_shipping_fee: 15000,
    actual_shipping_fee: 25000,
    buyer_total_amount: base + 15000,
    pri_currency: 'VND',
    aff_currency: 'VND',
    items: [{ item_id: 1, item_name: 'SP GIA' }],
  });
  /** Server giả Shopee trong tiến trình (không gọi sàn): escrow list 1 trang + detail. */
  function spCall(prefix: string, k: number): Call {
    const orders = Array.from({ length: k }, (_, i) => [`${prefix}${i}FAKE`, 200000 + i] as const);
    return (_m, path, params) => {
      if (path.endsWith('get_escrow_list')) {
        return {
          response: {
            more: false,
            escrow_list: orders.map(([sn]) => ({
              order_sn: sn,
              payout_amount: 180000,
              escrow_release_time: 1759460000,
            })),
          },
        };
      }
      const hit = orders.find(([sn]) => sn === params.order_sn) as readonly [string, number];
      return {
        response: { order_sn: hit[0], buyer_user_name: 'nguoimuagia', order_income: inc(hit[1]) },
      };
    };
  }
  async function apiRun(dsn: string, call: Call, d: Record<string, unknown> = {}) {
    const mp = join(TMP, 'amap.json');
    writeFileSync(mp, JSON.stringify({ shopee: SP_MAP, tiktok: SP_MAP }));
    const { cfg } = loadMap('shopee', mp);
    const c = cap();
    const rc = await run(
      { channel: 'shopee', window: ['2026-10-01', '2026-10-07'], dryRun: false },
      call,
      cfg,
      FEES,
      'api_live', // server giả ⇒ ép nguồn (chỉ test)
      { io: c.io, env: {}, mapFile: mp, service: async () => createPool(dsn), ...d },
    );
    return { rc, out: c.text() };
  }
  const nOrders = (pool: pg.Pool, sns: string[]) =>
    n(pool, 'select count(*) as n from settlement_rows where order_id_hash = any($1)', [
      sns.map((x) => orderHash('shopee', x)),
    ]);

  it('API: ghi sổ api_live + đối soát; chạy lại = skip; CSV cùng đơn → chặn (không cộng 2 lần)', async () => {
    const { dsn, pool } = await fresh();
    let r = await apiRun(dsn, spCall('D', 2));
    expect(r.rc, r.out).toBe(0);
    const rows = (
      await pool.query(
        'select source_kind, file_name, row_no, payout_vnd from settlement_rows order by row_no',
      )
    ).rows;
    expect(rows.map((x) => x.source_kind)).toEqual(['api_live', 'api_live']);
    expect(rows[0].file_name.startsWith('api-shopee-quyet-toan-')).toBe(true);
    expect(rows.map((x) => x.row_no)).toEqual([2, 3]);
    expect(await n(pool, 'select count(*) as n from recon_results')).toBe(2);
    expect(hasPii(r.out)).toBe(false);
    r = await apiRun(dsn, spCall('D', 2));
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[skip]');
    expect(await nOrders(pool, ['D0FAKE', 'D1FAKE'])).toBe(2);
    const f = join(TMP, 'q.csv');
    writeFileSync(
      f,
      'Mã đơn hàng,Giá sản phẩm,Phí cố định,Phí thanh toán,Phí dịch vụ,Tổng tiền đã thanh toán\nD0FAKE,200000,-10000,0,0,190000\n',
    );
    const rc = await csv(dsn, { file: f, channel: 'shopee' });
    expect(rc.rc).toBe(2);
    expect(rc.out).toContain('từ API sàn');
    expect(await nOrders(pool, ['D0FAKE'])).toBe(1);
  });

  it('API: đơn đã có dòng CSV → chặn; lỗi DB giữa transaction → rollback, 0 dòng', async () => {
    const { dsn, pool } = await fresh();
    await pool.query(
      "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, payout_vnd) values ($1, 'k.csv', 'shopee', 2, $2, 1, 1)",
      [createHash('sha256').update('r15-e').digest('hex'), orderHash('shopee', 'E0FAKE')],
    );
    let r = await apiRun(dsn, spCall('E', 2));
    expect(r.rc).toBe(2);
    expect(r.out).toContain('NGUỒN KHÁC');
    expect(await nOrders(pool, ['E1FAKE'])).toBe(0);
    // lỗi DB ở bước đối soát (giả DataException) → rollback cả lô
    const boom = () => {
      const p = createPool(dsn);
      const orig = p.connect.bind(p);
      (p as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
        const c = await orig();
        const q = c.query.bind(c) as (...a: unknown[]) => unknown;
        (c as unknown as { query: unknown }).query = (sql: unknown, params?: unknown) => {
          if (typeof sql === 'string' && sql.startsWith('insert into recon_results')) {
            return Promise.reject(
              Object.assign(new pg.DatabaseError('giả', 0, 'error'), { code: '22000' }),
            );
          }
          return q(sql, params);
        };
        return c;
      };
      return p;
    };
    r = await apiRun(dsn, spCall('F', 2), { service: async () => boom() });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('[err] lỗi DB, đã rollback — 0 dòng: DataException');
    expect(await nOrders(pool, ['F0FAKE', 'F1FAKE'])).toBe(0);
  });

  it('API cùng nguồn nhiều lần nạp (khác txn_type) ghi được; finance-01 TẮT → nạp, không đối soát, exit 2', async () => {
    const { dsn, pool } = await fresh();
    const h = orderHash('tiktok', 'SAMEFAKE');
    const row = (t: string, p: number, no = 2): ApiRow =>
      ({
        ...Object.fromEntries(MONEY.map((m) => [m, 0])),
        order_id_hash: h,
        order_amount: 100,
        payout: p,
        txn_type: t,
        settled_on: '2026-10-03',
        row_no: no,
      }) as ApiRow;
    const d = { io: cap().io, env: {}, service: async () => createPool(dsn) };
    expect(
      await write(
        'tiktok',
        [row('ORDER', 90), row('PENALTY', -5, 3)],
        'api_live',
        FEES,
        '2026-10-01',
        '2026-10-07',
        d,
      ),
    ).toBe(0);
    expect(
      await write('tiktok', [row('ADJUST', 1)], 'api_live', FEES, '2026-10-01', '2026-10-07', d),
    ).toBe(0);
    expect(
      await n(pool, 'select count(*) as n from settlement_rows where order_id_hash = $1', [h]),
    ).toBe(3);
    settings.forceMode = 'tat';
    const c = cap();
    const h2 = orderHash('tiktok', 'R17FAKE');
    expect(
      await write(
        'tiktok',
        [{ ...row('ORDER', 90), order_id_hash: h2 }],
        'api_live',
        FEES,
        '2026-10-01',
        '2026-10-07',
        {
          ...d,
          io: c.io,
        },
      ),
    ).toBe(2);
    expect(c.text()).toContain('[blocked]');
    expect(c.text()).toContain('[load]');
    expect(
      await n(pool, 'select count(*) as n from settlement_rows where order_id_hash = $1', [h2]),
    ).toBe(1);
    expect(
      await n(
        pool,
        'select count(*) as n from recon_results r join settlement_rows s on s.id = r.settlement_row_id where s.order_id_hash = $1',
        [h2],
      ),
    ).toBe(0);
  });

  it('khóa (kênh, đơn) chung CSV ↔ API: bên đang giữ khóa ghi xong → bên chờ THẤY nguồn kia, chặn', async () => {
    const { dsn, pool } = await fresh();
    const oid = 'RACEFAKE';
    const h = orderHash('tiktok', oid);
    const f = join(TMP, 'race.csv');
    writeFileSync(
      f,
      'Order/adjustment ID,Total revenue,Platform commission,Transaction fee,Service fee,' +
        `Total settlement amount,Order settled time\n${oid},100000,-10000,0,0,90000,2026-10-03\n`,
    );
    const waiting = async () => {
      for (let i = 0; i < 200; i++) {
        const k = await n(
          pool,
          "select count(*) as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())",
        );
        if (k) return true;
        await new Promise((res) => setTimeout(res, 50));
      }
      return false;
    };
    const apiRow = {
      ...Object.fromEntries(MONEY.map((m) => [m, 0])),
      order_id_hash: h,
      order_amount: 100000,
      fixed_fee: 10000,
      payout: 90000,
      txn_type: 'ORDER',
      settled_on: '2026-10-03',
      row_no: 2,
    } as ApiRow;
    // (1) API đang giữ khóa → CSV chờ; API commit → CSV [blocked] exit 2, đúng 1 dòng
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await lockOrders(holder, 'tiktok', [h]);
      const p = csv(dsn, { file: f, channel: 'tiktok' });
      expect(await waiting()).toBe(true);
      await loadRows(holder, [apiRow], 'tiktok', 'api-tiktok-x', 'e'.repeat(64), 'api_live');
      await holder.query('commit');
      const r = await p;
      expect(r.rc).toBe(2);
      expect(r.out).toContain('từ API sàn');
    } finally {
      holder.release();
    }
    const tot = (
      await pool.query(
        'select count(*)::int as k, coalesce(sum(payout_vnd), 0)::int as s from v_settlement_khoan where order_id_hash = $1',
        [h],
      )
    ).rows[0];
    expect(tot).toEqual({ k: 1, s: 90000 });
    // (2) CSV đang giữ khóa (đơn khác) → API chờ; CSV commit → API [blocked] exit 2
    const h2 = orderHash('tiktok', 'RACE2FAKE');
    const holder2 = await pool.connect();
    try {
      await holder2.query('begin');
      await lockOrders(holder2, 'tiktok', [h2]);
      const c = cap();
      const p = write(
        'tiktok',
        [{ ...apiRow, order_id_hash: h2 }],
        'api_live',
        FEES,
        '2026-10-01',
        '2026-10-07',
        {
          io: c.io,
          env: {},
          service: async () => createPool(dsn),
        },
      );
      expect(await waiting()).toBe(true);
      await loadRows(
        holder2,
        [{ ...apiRow, order_id_hash: h2, txn_type: null }],
        'tiktok',
        'race2.csv',
        'f'.repeat(64),
        'csv',
      );
      await holder2.query('commit');
      expect(await p).toBe(2);
      expect(c.text()).toContain('NGUỒN KHÁC');
    } finally {
      holder2.release();
    }
    expect(
      await n(pool, 'select count(*) as n from settlement_rows where order_id_hash = $1', [h2]),
    ).toBe(1);
  });
});
