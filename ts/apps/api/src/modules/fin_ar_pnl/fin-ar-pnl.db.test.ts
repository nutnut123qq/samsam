import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import { submit as directorSubmit } from '@samsam/core/ops/director';
import { addDays } from '@samsam/core/ops/period';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath, repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { createDbFromTemplate, dbUrl, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ARG from './__fixtures__/acc_ar.golden.json' with { type: 'json' };
import IG from './__fixtures__/acc_invoice.golden.json' with { type: 'json' };
import DG from './__fixtures__/fin_director.golden.json' with { type: 'json' };
import PG from './__fixtures__/fp_pnl.golden.json' with { type: 'json' };
import * as ar from './acc-ar.js';
import * as inv from './acc-invoice.js';
import {
  type AccArOpts,
  type AccInvoiceOpts,
  accArMain,
  accInvoiceMain,
  type CliDeps,
  type FinDirectorOpts,
  type FpPnlOpts,
  finDirectorMain,
  fpPnlMain,
} from './fin-ar-pnl.command.js';
import { orderHash, sha256hex } from './fin-common.js';
import { type FinSources, setFinSources } from './fin-director.js';
import * as fp from './fp-pnl.js';

// Dịch phần DB của tests/test_acc_ar.py, test_v13_c06_daily_ar.py (nháp thư nhắc nợ), test_acc_invoice.py,
// test_fp_pnl.py, test_fin_director.py. DB riêng dựng lại từ mẫu MỖI ca (Python: schema tạm + ROLLBACK),
// xóa khi xong. Đơn sàn/quyết toán MẪU nạp bằng INSERT trực tiếp từ dòng do hàm Python THẬT
// (`market_csv.read_export`, `settlement_csv.read_settlement` + `reconcile_row`) phân tích (golden) —
// nhóm market/settlement có loader riêng. Người lập/duyệt trong test là tên GIẢ LẬP.

const NAME = testDbName('fin_ar_pnl');
const AR_FILE = repoPath('tests/fixtures/finance/dealer_ar_MAU.csv');
const REQS = repoPath('tests/fixtures/finance/invoice_requests_MAU.csv');
const AS_OF = '2026-10-12';
const OCT = '2026-10-01';
const BUYER = [
  'CONG TY GIA LAP HOA DON MAU',
  '0109999999',
  'SO 99 PHO HOA DON GIA LAP',
  'hoadon.gialap@example.invalid',
];
const MARKET_PII = ['nguoimuagia', 'NGUOI NHAN GIA', 'DUONG GIA LAP', 'FAKEINV'];
const LEAK = [
  'FAKESET',
  'nguoimuagia',
  'NGUOI NHAN GIA',
  'DUONG GIA LAP',
  'GHI CHU GIA',
  'VDGIA',
  '090000000',
  'lap A',
  'duyet B',
];
const DECIDER = 'nguoi_duyet_gia_lap';
const COST: Record<string, number> = {
  'savina-12v': 50000,
  'saphraton-20v': 90000,
  'savigout-30v': 130000,
  'mat-ong-sam-120ml-1hu': 70000,
  'mat-ong-sam-300ml': 180000,
  'sapentol-30v': 110000,
};
const HEADS = [
  '## Công nợ đại lý quá hạn',
  '## P&L tháng 10/2026',
  '## Chi phí vận hành tháng 10/2026',
  '## Dòng tiền 13 tuần',
  '## Đề xuất ngân sách ads',
  '## Người duyệt',
];
const leak = (text: string, needles: string[]) => needles.filter((n) => text.includes(n));

type MRow = {
  row_no: number;
  channel: string;
  sku_key: string | null;
  title: string | null;
  price_vnd: number | null;
  status: string | null;
  qty: number | null;
  order_id_hash: string;
  item_id: string | null;
  seller_sku: string | null;
  raw: unknown;
};
type Snap = { sha: string; name: string; rows: MRow[] };
type SRow = Record<string, unknown> & { row_no: number; order_id_hash: string; label: string };
const MARKET = PG.db_fixture.market as unknown as Snap[];
const SETTLE = PG.db_fixture.settlement as unknown as { name: string; sha: string; rows: SRow[] }[];
const INV_MARKET = IG.market_invoice as unknown as Snap;

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('fin_ar_pnl (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  let seq = 0;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const n = async (sql: string, p: unknown[] = []) =>
    Number(await one(`select count(*) ${sql}`, p));
  const dir = (tag: string) => {
    const d = join(tmp, `${++seq}-${tag}`);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const deps = (s: ReturnType<typeof io>, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: s.io,
    env: {},
    connect: async () => ({ db: pool, release: async () => {} }),
    wire: () => {},
    ...extra,
  });
  const run = async <O>(
    main: (o: O, d: CliDeps) => Promise<number>,
    o: O,
    extra: Partial<CliDeps> = {},
  ) => {
    const s = io();
    const rc = await main(o, deps(s, extra));
    return { rc, ...s, text: s.out.join('\n') };
  };
  const accAr = (o: AccArOpts, e?: Partial<CliDeps>) => run(accArMain, o, e);
  const accInv = (o: AccInvoiceOpts, e?: Partial<CliDeps>) => run(accInvoiceMain, o, e);
  const fpPnl = (o: FpPnlOpts, e?: Partial<CliDeps>) => run(fpPnlMain, o, e);
  const finDir = (o: FinDirectorOpts, e?: Partial<CliDeps>) => run(finDirectorMain, o, e);

  async function loadMarket(snap: Snap): Promise<string> {
    const sha = snap.sha.length === 64 ? snap.sha : sha256hex(JSON.stringify(snap.rows));
    const sid = (await one(
      "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'order', $1, $2, $3) returning id::text",
      [snap.name, sha, snap.rows.length],
    )) as string;
    for (const r of snap.rows) {
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, seller_sku, sku_key, title, price_vnd, status, qty, order_id_hash, raw) values ($1, $2, $3, 'order', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)",
        [
          sid,
          r.row_no,
          r.channel,
          r.item_id,
          r.seller_sku,
          r.sku_key,
          r.title,
          r.price_vnd,
          r.status,
          r.qty,
          r.order_id_hash,
          JSON.stringify(r.raw),
        ],
      );
    }
    return sid;
  }
  /** Bản xuất lại của snapshot với dòng bị sửa (file khác → sha khác). */
  const variant = (snap: Snap, name: string, fn: (r: MRow) => MRow): Snap => {
    const rows = snap.rows.map((r) => fn({ ...r }));
    return { name, sha: sha256hex(JSON.stringify(rows)), rows };
  };
  async function loadSettlement(set: { name: string; sha: string; rows: SRow[] }): Promise<void> {
    for (const r of set.rows) {
      const id = await one(
        "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd, payment_fee_vnd, service_fee_vnd, shipping_fee_vnd, voucher_seller_vnd, affiliate_vnd, refund_vnd, payout_vnd, settled_on, txn_type, source_kind) values ($1, $2, 'shopee', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'csv') returning id",
        [
          set.sha,
          set.name,
          r.row_no,
          r.order_id_hash,
          r.order_amount,
          r.fixed_fee,
          r.payment_fee,
          r.service_fee,
          r.shipping_fee,
          r.voucher_seller,
          r.affiliate,
          r.refund,
          r.payout,
          r.settled_on,
          r.txn_type,
        ],
      );
      await q(
        'insert into recon_results (settlement_row_id, label, reasons, expected_payout_vnd, order_amount_vnd) values ($1, $2, $3::jsonb, $4, $5)',
        [id, r.label, JSON.stringify(r.reasons), r.expected, r.recon_amount],
      );
    }
  }
  /** Đơn sàn + quyết toán MẪU (dùng lại ở fp_pnl/fin_director). */
  async function loadFixtures(): Promise<void> {
    for (const m of MARKET) await loadMarket(m);
    for (const s of SETTLE) await loadSettlement(s);
  }
  /** Giá vốn MẪU qua CLI: người lập `by`, người duyệt `approver`. */
  async function addCosts(skus = Object.keys(COST), by = 'lap A', approver = 'duyet B') {
    for (const sku of skus) {
      let r = await fpPnl({ cogsAdd: true, sku, cost: String(COST[sku]), from: OCT, by });
      expect(r.rc, r.err.join('\n')).toBe(0);
      const cid = String(await one('select max(id) from cogs_versions'));
      r = await fpPnl({ cogsApprove: cid, by: approver });
      expect(r.rc, r.text + r.err.join('\n')).toBe(0);
    }
  }
  const queue = async () =>
    q(
      'select id::text as id, object_type, object_id, block, status, risk, title, payload, created_by, (guardrail->>$1) as g_ok, extract(epoch from (due_at - created_at))::int as sla_s from approval_queue order by id',
      ['ok'],
    );
  const today = async () =>
    (await one("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date)::text")) as string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fin-ar-pnl-db-'));
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    setFinSources(null);
  });
  afterAll(async () => {
    settings.forceMode = null;
    setFinSources(null);
    await pool?.end();
    await dropDb(NAME);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ================================================================== acc_ar
  it('acc_ar: nạp sổ idempotent theo sha256, tuổi nợ, hoa hồng NHÁP, bản tin GĐ tài chính', async () => {
    let r = await accAr({ load: AR_FILE });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(await n('from dealer_ar')).toBe(9);
    r = await accAr({ load: AR_FILE });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('[skip]');
    expect(await n('from dealer_ar')).toBe(9);
    r = await accAr({ aging: true, asOf: AS_OF });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('DL-HN01: còn nợ 10.000.000đ');
    expect(r.text).not.toContain('PX-GIA');
    r = await accAr({ commission: true, from: '2026-09-01', to: '2026-10-31' });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('BẢN NHÁP — không phải lệnh chi');
    expect(r.text).toContain('DL-DN02 alcohol/online: cơ sở 8.000.000đ × 0 = 0đ [ruou_online');
    expect(r.text).toContain('[thieu_sku, tncn]');
    const [cfg] = ar.loadConfig();
    const out = dir('bulletin');
    const [path, rows] = await ar.bulletin(pool, AS_OF, new Date('2026-10-12T09:00:00+07:00'), {
      outDir: out,
      cfg: cfg as ar.ArConfig,
    });
    const text = readFileSync(path, 'utf8');
    expect(path.endsWith('director-finance-2026-10-12.md')).toBe(true);
    expect(text).toContain('## Công nợ đại lý quá hạn');
    expect(text).toContain('`DL-HN01`');
    expect(text.indexOf('## Công nợ đại lý quá hạn')).toBeLessThan(text.indexOf('## Người duyệt'));
    expect(text).not.toContain('PX-GIA');
    expect(new Set(rows.filter((x) => x.qua_han).map((x) => x.dealer_code))).toEqual(
      new Set(['DL-HN01', 'DL-DN02']),
    );
  });

  it('acc_ar --bulletin: ghi file lỗi → exit 1, [error], không [bulletin]', async () => {
    expect((await accAr({ load: AR_FILE })).rc).toBe(0);
    const f = join(dir('x'), 'file');
    writeFileSync(f, 'x');
    const r = await accAr({ bulletin: true, asOf: AS_OF }, { reportsDir: join(f, 'sub') });
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toMatch(/^\[error\] \w+Error/);
    expect(r.text).not.toContain('[bulletin]');
  });

  const E = (
    code: string,
    amount: number,
    daysAgo: number,
    ref: string,
    rowNo: number,
  ): ar.ArEntry => ({
    row_no: rowNo,
    dealer_code: code,
    dealer_type: 'ca_nhan',
    kind: 'phat_sinh',
    doc_ref: ref,
    doc_date: addDays(AS_OF, -daysAgo),
    due_date: null,
    amount_vnd: amount,
    sku_key: null,
    channel: null,
  });
  async function seedAr() {
    await q(
      "insert into dealers (code, name, region, source) values ('DL-01', 'Đại lý Tên Giả A', 'mien-trung', 'manual'), ('DL-03', 'Đại lý Tên Giả C', 'mien-trung', 'manual')",
    );
    await ar.load(
      pool,
      [
        E('DL-01', 1_000_000, 60, 'HD-001', 2),
        E('DL-01', 2_000_000, 40, 'HD-002', 3),
        E('DL-02', 900_000, 70, 'HD-7', 4),
        E('DL-03', 400_000, 5, 'HD-8', 5),
      ],
      'cong_no_T9.csv',
      'c'.repeat(64),
    );
  }
  const reminders = async () => (await queue()).filter((x) => x.object_type === 'ar_reminder');

  it('nháp thư nhắc nợ → hàng duyệt finance, chỉ đại lý trong sổ, không PII, idempotent theo đợt', async () => {
    await seedAr();
    const res0 = await ar.enqueueReminders(pool, AS_OF, 30, { dryRun: true });
    expect(res0.drafts).toHaveLength(1);
    expect(await reminders()).toEqual([]);
    const res = await ar.enqueueReminders(pool, AS_OF, 30);
    expect(res.enqueued.map((x) => x.dealer_code)).toEqual(['DL-01']);
    expect(new Set(res.skipped.map((x) => x.dealer_code))).toEqual(new Set(['DL-02']));
    const [row] = await reminders();
    expect([
      row?.block,
      row?.object_type,
      row?.object_id,
      row?.status,
      row?.created_by,
      row?.g_ok,
    ]).toEqual([
      'finance',
      'ar_reminder',
      res.drafts[0]?.object_id,
      'pending',
      'agent:acc_ar',
      'true',
    ]);
    expect(row?.payload).not.toContain('Tên Giả');
    expect(row?.payload).toContain('{{TEN_DAI_LY}}');
    expect(row?.payload).toContain('3.000.000đ');
    expect(row?.payload).toContain('cccccccc');
    // chạy lại (cron/restart) → không nhân bản
    const res2 = await ar.enqueueReminders(pool, addDays(AS_OF, 1), 30);
    expect(res2.enqueued).toEqual([]);
    expect(await reminders()).toHaveLength(1);
    expect(res2.skipped.at(-1)?.reason).toContain('đã có');
    // CLI in dòng tóm tắt, không gửi
    const r = await accAr({ reminders: true, asOf: AS_OF });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('[reminders] tính tới 2026-10-12: 0 nháp mới');
    expect(r.text).toContain('agent KHÔNG gửi thư');
  });

  it('nháp thư nhắc nợ: tính năng TẮT → RolloutBlocked, 0 mục; CLI [blocked] exit 2', async () => {
    await seedAr();
    settings.forceMode = 'tat';
    await expect(ar.enqueueReminders(pool, AS_OF, 30)).rejects.toBeInstanceOf(RolloutBlocked);
    const r = await accAr({ reminders: true, asOf: AS_OF });
    expect(r.rc).toBe(2);
    expect(r.err.join('\n')).toMatch(/^\[blocked\] .*finance-03\.3/);
    settings.forceMode = 'van_hanh';
    expect(await reminders()).toEqual([]);
  });

  // ================================================================== acc_invoice
  it('acc_invoice: lô → hàng duyệt finance, người mua chỉ trong CSV; skip; từ chối → lập lại; duyệt → verify; điều chỉnh', async () => {
    await loadMarket(INV_MARKET);
    const day = await today();
    const drafts = dir('hoa-don-nhap');
    const argv: AccInvoiceOpts = { batch: true, day, yeuCau: REQS, channel: 'shopee' };
    let r = await accInv(argv, { draftDir: drafts });
    expect(r.rc, r.err.join('\n')).toBe(0);
    let qs = await queue();
    expect(qs).toHaveLength(1);
    const q1 = qs[0] as Record<string, string | number>;
    expect([q1.object_type, q1.block, q1.status, q1.risk, q1.sla_s]).toEqual([
      'invoice_batch',
      'finance',
      'pending',
      'high',
      24 * 3600,
    ]);
    const key1 = q1.object_id as string;
    expect(key1).toMatch(new RegExp(`^${day}-[0-9a-f]{12}$`));
    const lines = await q(
      'select kind, count(*)::int as n from invoice_lines where batch_key = $1 group by 1 order by 1',
      [key1],
    );
    expect(Object.fromEntries(lines.map((x) => [x.kind, x.n]))).toEqual({ thuong: 12, can_mst: 1 });
    const draft = join(drafts, `lo-${key1}.csv`);
    expect(leak(readFileSync(draft, 'utf8'), BUYER).sort()).toEqual([...BUYER].sort());
    // không lộ người mua: payload/title/invoice_lines/action log/stdout
    const invTxt = JSON.stringify(await q('select * from invoice_lines'));
    const logTxt = JSON.stringify(await q('select detail from agent_action_log'));
    for (const blob of [q1.title as string, q1.payload as string, invTxt, logTxt, r.text]) {
      expect(leak(blob, BUYER)).toEqual([]);
      expect(leak(blob, MARKET_PII)).toEqual([]);
    }
    for (const x of await q('select order_id_hash from invoice_lines')) {
      expect(r.text).not.toContain(x.order_id_hash);
    }
    // chạy lại cùng ngày → skip
    r = await accInv(argv, { draftDir: drafts });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('[skip]');
    expect(await queue()).toHaveLength(1);
    // verify-draft: còn pending → exit 1
    r = await accInv({ verifyDraft: String(q1.id), file: draft });
    expect(r.rc).toBe(1);
    // từ chối → chạy lại → lô mới cùng 13 đơn, khóa mới (lần lập 2)
    let [ok, msg] = await decide(pool, q1.id, DECIDER, 'rejected');
    expect(ok, msg ?? '').toBe(true);
    r = await accInv(argv, { draftDir: drafts });
    expect(r.rc, r.err.join('\n')).toBe(0);
    qs = await queue();
    const q2 = qs[1] as Record<string, string>;
    expect([qs.length, q2.status, q2.object_id !== key1]).toEqual([2, 'pending', true]);
    const key2 = q2.object_id as string;
    expect(await n('from invoice_lines where batch_key = $1', [key2])).toBe(13);
    expect(q2.payload).toContain('Lần lập trong ngày: 2');
    // duyệt lô 2 → verify file nguyên OK, sửa 1 byte → fail; lô rejected → fail
    [ok, msg] = await decide(pool, q2.id, DECIDER, 'approved');
    expect(ok, msg ?? '').toBe(true);
    const draft2 = join(drafts, `lo-${key2}.csv`);
    r = await accInv({ verifyDraft: q2.id as string, file: draft2 });
    expect([r.rc, r.text]).toEqual([0, `[ok] mục #${q2.id} đã duyệt, file khớp csv_sha256`]);
    // biên DÙNG (HĐ 6.7): tính năng còn chạy thử → không được dùng bản duyệt (fail-closed)
    settings.forceMode = 'chay_thu';
    r = await accInv({ verifyDraft: q2.id as string, file: draft2 });
    settings.forceMode = 'van_hanh';
    expect([r.rc, r.text]).toEqual([1, `[fail] mục #${q2.id}: payload lệch bản đã duyệt`]);
    const raw = readFileSync(draft2);
    raw[raw.length - 3] = (raw[raw.length - 3] as number) ^ 1;
    const bad = join(dir('sua'), 'sua.csv');
    writeFileSync(bad, raw);
    r = await accInv({ verifyDraft: q2.id as string, file: bad });
    expect([r.rc, r.text]).toEqual([
      1,
      '[fail] file nháp KHÁC bản đã duyệt (sha256 lệch) — không nhập',
    ]);
    expect((await accInv({ verifyDraft: String(q1.id), file: draft })).rc).toBe(1);
    // 1 đơn đã duyệt nay trả hàng → lô D+1 chỉ 1 dòng điều chỉnh
    const h1 = orderHash('shopee', 'FAKEINV0001');
    await loadMarket(
      variant(INV_MARKET, 'order_tra_hang.csv', (x) =>
        x.order_id_hash === h1 ? { ...x, status: 'Trả hàng/Hoàn tiền' } : x,
      ),
    );
    const day2 = addDays(day, 1);
    r = await accInv({ batch: true, day: day2 }, { draftDir: drafts });
    expect(r.rc, r.err.join('\n')).toBe(0);
    qs = await queue();
    expect(qs).toHaveLength(3);
    const adj = await q(
      'select kind, ref_batch_key, order_id_hash, amount_vnd from invoice_lines where batch_key = $1',
      [qs[2]?.object_id],
    );
    expect(adj.map((x) => [x.kind, x.ref_batch_key, x.order_id_hash])).toEqual([
      ['dieu_chinh', key2, h1],
    ]);
    expect(qs[2]?.payload).toContain('điều chỉnh — lô gốc');
    // lô D+1 còn pending: đơn đã có điều chỉnh → không lặp
    const [cfg] = inv.loadConfig();
    const b = inv.buildBatch(
      await inv.fetchOrders(pool, day2),
      new Map(),
      await inv.fetchInvoiced(pool),
      cfg as inv.InvConfig,
      day2,
    );
    expect(b.lines).toEqual([]);
  });

  it('acc_invoice: lô rỗng → 0 mục; lần chạy khác giữ advisory lock → exit 1, không ghi', async () => {
    const day = await today();
    const drafts = dir('hoa-don-nhap');
    let r = await accInv({ batch: true, day }, { draftDir: drafts });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('không có đơn cần lập hóa đơn');
    expect(await queue()).toEqual([]);
    const other = createPool(dbUrl(NAME));
    const c = await other.connect();
    try {
      await c.query('select pg_advisory_lock($1::bigint)', [inv.LOCK_KEY]);
      await loadMarket(INV_MARKET);
      r = await accInv({ batch: true, day }, { draftDir: drafts });
      expect(r.rc).toBe(1);
      expect(r.text).toContain('đang có 1 lần --batch khác chạy');
      expect(await queue()).toEqual([]);
    } finally {
      c.release();
      await other.end();
    }
    r = await accInv({ batch: true, day }, { draftDir: drafts });
    expect(r.rc).toBe(0);
    expect(await queue()).toHaveLength(1);
  });

  it('acc_invoice: lô ngày D chỉ dùng snapshot nạp TRƯỚC hết ngày D (giờ VN)', async () => {
    await loadMarket(INV_MARKET); // FAKEINV0016 Đang giao
    const h = orderHash('shopee', 'FAKEINV0016');
    const sid2 = await loadMarket(
      variant(INV_MARKET, 'order_giao_xong.csv', (x) =>
        x.order_id_hash === h ? { ...x, status: 'Hoàn thành' } : x,
      ),
    );
    await q("update market_snapshots set imported_at = now() + interval '1 day' where id = $1", [
      sid2,
    ]);
    const day = await today();
    const [cfg] = inv.loadConfig();
    const status = async (d: string) =>
      (await inv.fetchOrders(pool, d)).find((o) => o.order_id_hash === h)?.status;
    expect(await status(day)).toBe('Đang giao');
    const b1 = inv.buildBatch(
      await inv.fetchOrders(pool, day),
      new Map(),
      [],
      cfg as inv.InvConfig,
      day,
    );
    expect(b1.excluded.chua_dat_moc).toBe(1);
    expect(await status(addDays(day, 1))).toBe('Hoàn thành');
    const b2 = inv.buildBatch(
      await inv.fetchOrders(pool, addDays(day, 1)),
      new Map(),
      [],
      cfg as inv.InvConfig,
      day,
    );
    expect(b2.excluded.chua_dat_moc).toBe(0);
  });

  it('acc_invoice: ghi file nháp lỗi → exit 1 + nhắc TỪ CHỐI rồi chạy lại; mục vẫn pending, 0 file', async () => {
    await loadMarket(INV_MARKET);
    const d = dir('x');
    const f = join(d, 'file');
    writeFileSync(f, 'x');
    const r = await accInv({ batch: true, day: await today() }, { draftDir: join(f, 'sub') });
    expect(r.rc).toBe(1);
    const err = r.err.join('\n');
    expect(err).toContain('ghi file nháp lỗi (');
    expect(err).toContain('TỪ CHỐI mục đó rồi chạy lại --batch');
    expect((await queue()).map((x) => [x.object_type, x.status])).toEqual([
      ['invoice_batch', 'pending'],
    ]);
    expect(readdirSync(d).filter((x) => x.startsWith('lo-'))).toEqual([]);
  });

  it('acc_invoice: tính năng TẮT → RolloutBlocked, rollback toàn bộ (0 dòng lô, 0 mục), exit 1', async () => {
    await loadMarket(INV_MARKET);
    settings.forceMode = 'tat';
    const r = await accInv({ batch: true, day: await today() }, { draftDir: dir('hd') });
    settings.forceMode = 'van_hanh';
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toMatch(/^\[error\] RolloutBlocked: .*finance-02/);
    expect(await n('from invoice_lines')).toBe(0);
    expect(await queue()).toEqual([]);
  });

  // ================================================================== fp_pnl
  it('fp_pnl: giá vốn người lập ≠ người duyệt, P&L khớp quyết toán, không rò mã đơn/PII, lọc kênh file riêng', async () => {
    const out = dir('reports');
    await loadFixtures();
    await addCosts(Object.keys(COST).filter((k) => k !== 'savigout-30v'));
    // savigout: người duyệt = người lập (khác hoa thường/khoảng trắng) → DB từ chối
    let r = await fpPnl({
      cogsAdd: true,
      sku: 'savigout-30v',
      cost: '130.000',
      from: OCT,
      by: 'lap A',
    });
    expect(r.rc).toBe(0);
    const gid = String(await one('select max(id) from cogs_versions'));
    r = await fpPnl({ cogsApprove: gid, by: '  LAP a ' });
    expect(r.rc).toBe(1);
    expect(r.text).toContain('trùng người lập');
    r = await fpPnl({ cogsAdd: true, sku: 'khong-co-sku', cost: '1', from: OCT, by: 'lap A' });
    expect(r.rc).toBe(1);
    r = await fpPnl({ cogsList: true });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('savina-12v: 50.000đ');
    expect(r.text).toContain(`[chờ duyệt] #${gid}`);

    r = await fpPnl({ pnl: true, month: '2026-10' }, { reportsDir: out });
    expect(r.rc, r.err.join('\n')).toBe(0);
    const full = join(out, 'pnl-2026-10.md');
    const report = readFileSync(full, 'utf8');
    expect(report.startsWith('# P&L')).toBe(true);
    expect(report).toContain(fp.DRAFT_HEAD);
    const total = Number(
      await one(
        "select sum(payout_vnd) from settlement_rows where settled_on >= '2026-10-01' and settled_on < '2026-11-01'",
      ),
    );
    const res = await fp.compute(pool, OCT);
    expect([res.cells.reduce((s, c) => s + c.thuc_nhan, 0), total]).toEqual([7562080, 7562080]);
    expect(res.loai).toEqual(['savigout-30v']);
    expect(report).toContain('1 SKU bị loại vì chưa có giá vốn duyệt: `savigout-30v`');
    const cells = Object.fromEntries(res.cells.map((c) => [c.sku_key, c]));
    expect(cells['savigout-30v']?.gia_von).toBeNull();
    expect(cells['savina-12v']?.gia_von).toBe(7 * 50000);
    expect(cells['savina-12v']?.lai_gop).toBe(971289 - 350000);
    expect(res.tong_lai_gop).toBe(4368080 - (1391380 - 520000));
    // đơn 2 dòng: tổng phân bổ 2 ô == số trên dòng quyết toán
    const h = orderHash('shopee', 'FAKESET0201');
    const rows = (await fp.fetchRows(pool, OCT)).filter((x) => x.order_id_hash === h);
    const lns = await fp.fetchLines(pool, [h]);
    expect([rows.length, new Set(lns.map((x) => x.sku_key))]).toEqual([
      1,
      new Set(['savina-12v', 'saphraton-20v']),
    ]);
    const oneRes = fp.pnl(rows, lns, await fp.fetchVersions(pool), OCT);
    expect(oneRes.cells).toHaveLength(2);
    for (const [k, v] of [
      ['doanh_thu', 757000],
      ['thuc_nhan', 651160],
      ['khau_tru_san', 30280 + 37850 + 22710 + 15000],
    ] as const) {
      expect(
        oneRes.cells.reduce((s, c) => s + (c[k] as number), 0),
        k,
      ).toBe(v);
    }
    // Σ trọng số dòng đơn == recon_results.order_amount_vnd (cùng quy tắc snapshot mới nhất)
    const allRows = await fp.fetchRows(pool, OCT);
    const w: Record<string, number> = {};
    for (const ln of await fp.fetchLines(
      pool,
      allRows.map((x) => x.order_id_hash),
    )) {
      w[ln.order_id_hash] = (w[ln.order_id_hash] ?? 0) + ln.qty * ln.price_vnd;
    }
    const recon = Object.fromEntries(
      (
        await q(
          'select s.order_id_hash, r.order_amount_vnd from settlement_rows s join recon_results r on r.settlement_row_id = s.id',
        )
      ).map((x) => [
        x.order_id_hash,
        x.order_amount_vnd === null ? null : Number(x.order_amount_vnd),
      ]),
    );
    expect(Object.keys(w).length).toBeGreaterThan(0);
    for (const k of Object.keys(w)) expect(w[k], k).toBe(recon[k]);
    expect(
      Object.keys(recon)
        .filter((k) => recon[k] === null)
        .sort(),
    ).toEqual(
      Object.keys(recon)
        .filter((k) => !(k in w))
        .sort(),
    );
    // không rò mã đơn/hash/PII/tên người lập-duyệt
    const hashes = (await q('select order_id_hash from settlement_rows')).map(
      (x) => x.order_id_hash,
    );
    for (const text of [r.text, report]) {
      for (const x of hashes) expect(text).not.toContain(x);
      expect(leak(text, LEAK)).toEqual([]);
    }
    // lọc kênh: file RIÊNG, không đè bản toàn kênh; số đếm theo đúng kênh
    const before = readFileSync(full);
    expect(res.thieu_chung_tu).toBeGreaterThanOrEqual(1);
    r = await fpPnl({ pnl: true, month: '2026-10', channel: 'tiktok' }, { reportsDir: out });
    expect(r.rc).toBe(0);
    expect(readFileSync(full).equals(before)).toBe(true);
    const tk = readFileSync(join(out, 'pnl-2026-10-tiktok.md'), 'utf8');
    for (const text of [r.text, tk]) {
      expect(text).toContain('không có dòng quyết toán trong tháng');
      expect(text).toContain('Tổng thực nhận: 0đ (0 dòng quyết toán trong tháng)');
      expect(text).toContain(`(vào ô ${fp.UNKNOWN_SKU}): 0; dòng hoàn: 0`);
    }
    expect(r.text).toContain('pnl-2026-10-tiktok.md');
    r = await fpPnl({ pnl: true, month: '2026-10', channel: 'shopee' }, { reportsDir: out });
    expect(r.rc).toBe(0);
    expect(readFileSync(full).equals(before)).toBe(true);
    const sh = readFileSync(join(out, 'pnl-2026-10-shopee.md'), 'utf8');
    expect(sh).toContain(
      `(vào ô ${fp.UNKNOWN_SKU}): ${res.thieu_chung_tu}; dòng hoàn: ${res.hoan}`,
    );
    expect(sh).toContain(`(${res.n_rows} dòng quyết toán trong tháng)`);
  });

  it('fp_pnl: dòng đơn chỉ lấy snapshot `order` MỚI NHẤT chứa mã đơn (xuất chồng)', async () => {
    for (const m of MARKET) await loadMarket(m);
    const h = orderHash('shopee', 'FAKESET0201');
    const multi = MARKET[1] as Snap;
    await loadMarket(
      variant(multi, 'order_shopee_multi_moi_MAU.csv', (x) =>
        x.order_id_hash === h && x.sku_key === 'saphraton-20v' ? { ...x, qty: 1 } : x,
      ),
    );
    await loadSettlement(SETTLE[1] as { name: string; sha: string; rows: SRow[] });
    await addCosts(['savina-12v', 'saphraton-20v']);
    expect(
      Number(
        await one('select count(distinct snapshot_id) from market_rows where order_id_hash = $1', [
          h,
        ]),
      ),
    ).toBe(2);
    const lns = await fp.fetchLines(pool, [h]);
    expect(lns.map((x) => [x.sku_key, x.qty, x.price_vnd]).sort()).toEqual([
      ['saphraton-20v', 1, 299000],
      ['savina-12v', 1, 159000],
    ]);
    expect(lns.reduce((s, x) => s + x.qty * x.price_vnd, 0)).toBe(458000);
    const rows = (await fp.fetchRows(pool, OCT)).filter((x) => x.order_id_hash === h);
    const res = fp.pnl(rows, lns, await fp.fetchVersions(pool), OCT);
    const cells = Object.fromEntries(res.cells.map((c) => [c.sku_key, c]));
    expect(cells['saphraton-20v']?.gia_von).toBe(COST['saphraton-20v']);
    expect(cells['savina-12v']?.gia_von).toBe(COST['savina-12v']);
    expect([cells['savina-12v']?.thuc_nhan, cells['saphraton-20v']?.thuc_nhan]).toEqual(
      fp.allocate(651160, [159000, 299000]),
    );
  });

  it('fp_pnl: chưa có giá vốn duyệt → liệt kê MỌI SKU bị loại, lãi gộp 0đ (không suy 0)', async () => {
    await loadFixtures();
    const r = await fpPnl({ pnl: true, month: '2026-10' }, { reportsDir: dir('rp') });
    expect(r.rc).toBe(0);
    expect(r.text).toContain(`${Object.keys(COST).length} SKU bị loại vì ${fp.NO_COGS}`);
    expect(r.text).toContain('Tổng lãi gộp (chỉ ô có giá vốn duyệt): 0đ');
    expect(r.text.split(fp.NO_COGS).length - 1).toBeGreaterThanOrEqual(
      Object.keys(COST).length + 1,
    );
    const res = await fp.compute(pool, OCT);
    expect(res.cells.every((c) => c.gia_von === null)).toBe(true);
  });

  it('fp_pnl: lỗi DB → exit 1 [error], không traceback; P&L TẮT → [rollout] exit 2, không file', async () => {
    const out = dir('rp');
    settings.forceMode = 'tat';
    let r = await fpPnl({ pnl: true, month: '2026-10' }, { reportsDir: out });
    settings.forceMode = 'van_hanh';
    expect(r.rc).toBe(2);
    expect(r.text).toMatch(/^\[rollout\] P&L: tính năng finance-04\.1 đang tắt/);
    expect(readdirSync(out)).toEqual([]);
    await q('drop table recon_results');
    r = await fpPnl({ pnl: true, month: '2026-10' }, { reportsDir: out });
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toMatch(/^\[error\] UndefinedTable: /);
  });

  it('fp_pnl --cogs-approve: agent/hệ thống không được duyệt (cliGate)', async () => {
    const r1 = await fpPnl({
      cogsAdd: true,
      sku: 'savina-12v',
      cost: '50000',
      from: OCT,
      by: 'lap A',
    });
    expect(r1.rc).toBe(0);
    const cid = String(await one('select max(id) from cogs_versions'));
    const r = await fpPnl({ cogsApprove: cid, by: 'agent:fp_pnl' });
    expect(r.rc).toBe(1);
    expect(r.text).toContain(`[err] giá vốn #${cid}: 'agent:fp_pnl' không phải người`);
    expect(await one('select approved_by from cogs_versions where id = $1', [cid])).toBeNull();
  });

  // ================================================================== fin_director
  const FAKE_SRC: FinSources = {
    ops: async () => DG.ops as unknown as Awaited<ReturnType<FinSources['ops']>>,
    cash: async () => (DG.cash as unknown as { fc: Awaited<ReturnType<FinSources['cash']>> }).fc,
    cashWeeks: () => 13,
  };
  async function seedFin(costs = true) {
    await loadFixtures();
    if (costs) await addCosts(Object.keys(COST).filter((k) => k !== 'sapentol-30v'));
    expect((await accAr({ load: AR_FILE })).rc).toBe(0);
    await directorSubmit(pool, {
      block: 'finance',
      objectType: 'budget_change',
      objectId: 'mau-2026-10',
      title: 'Đề xuất ngân sách ads MẪU',
      payload: 'Đề xuất ngân sách quảng cáo tháng 10/2026 (MẪU, giả lập test).',
      createdBy: 'agent:fp_ads',
    });
  }

  it('fin_director --weekly: 5 mục đúng thứ tự trước "Người duyệt", 0 mục thiếu dữ liệu, không PII', async () => {
    await seedFin();
    const out = dir('rp');
    const r = await finDir({ weekly: true, asOf: AS_OF }, { reportsDir: out, src: FAKE_SRC });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.text).toContain('director-finance-2026-10-12.md');
    expect(r.text).toContain('0 mục chưa có dữ liệu');
    const text = readFileSync(join(out, 'director-finance-2026-10-12.md'), 'utf8');
    const pos = HEADS.map((x) => text.indexOf(x));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(text).toContain('`DL-HN01`');
    expect(text).not.toContain('PX-GIA');
    expect(text).toContain('[CẢNH BÁO 80%] `cloud`: 3.300.000đ');
    expect(text).toContain('[VƯỢT TRẦN 100%] `saas`: 7.200.000đ');
    expect(text).toContain('đang chờ TGĐ ký: 2');
    expect(text).toContain(`1 SKU ${fp.NO_COGS}: \`sapentol-30v\``);
    expect(text).toContain('Mục `budget_change` đang chờ duyệt: 1');
    expect(text).toContain('Số tuần âm ở kịch bản thấp:');
    expect(maskPii(text)).toBe(text);
    expect(maskPii(r.text)).toBe(r.text);
    for (const x of (await q('select order_id_hash from settlement_rows')).map(
      (y) => y.order_id_hash,
    )) {
      expect(text).not.toContain(x);
    }
    expect(leak(text, LEAK)).toEqual([]);
    expect(text).not.toContain('chưa có dữ liệu');
  });

  it('fin_director: chưa có giá vốn → vẫn liệt kê MỌI SKU; nguồn fin_cash chưa nối → mục đó thiếu dữ liệu (fail-closed)', async () => {
    await seedFin(false);
    expect(await n('from cogs_versions')).toBe(0);
    const out = dir('rp');
    const r = await finDir({ weekly: true, asOf: AS_OF }, { reportsDir: out });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('2 mục chưa có dữ liệu');
    const text = readFileSync(join(out, 'director-finance-2026-10-12.md'), 'utf8');
    const m = new RegExp(`- (\\d+) SKU ${fp.NO_COGS}: (.+)`).exec(text);
    expect(Number(m?.[1])).toBe(Object.keys(COST).length);
    for (const k of Object.keys(COST)) expect(m?.[2]).toContain(`\`${k}\``);
    expect(text).toContain('Tổng lãi gộp (chỉ ô có giá vốn duyệt): 0đ');
    expect(text).toContain('chưa nối nguồn nhóm fin_cash');
  });

  it('fin_director: thiếu mục cấu hình + bảng công nợ → 3 mục "(chưa có dữ liệu)", bản tin vẫn ra', async () => {
    await seedFin();
    const raw = JSON.parse(readFileSync(dataPath('fpa_config.json'), 'utf8'));
    delete raw.cash;
    delete raw.opscost;
    const p = join(dir('cfg'), 'fpa.json');
    writeFileSync(p, JSON.stringify(raw));
    await q('drop table dealer_ar');
    const out = dir('rp');
    const r = await finDir({ weekly: true, asOf: AS_OF }, { reportsDir: out, fpaConfig: p });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.text).toContain('3 mục chưa có dữ liệu');
    const text = readFileSync(join(out, 'director-finance-2026-10-12.md'), 'utf8');
    for (const x of HEADS) expect(text, x).toContain(x);
    expect(text.split('(chưa có dữ liệu:').length - 1).toBe(3);
    expect(text).toContain("thiếu mục 'cash'");
    expect(text).toContain("thiếu mục 'opscost'");
    expect(text).toContain('## P&L tháng 10/2026');
    expect(text).toContain('Tổng thực nhận');
  });

  it('fin_director: golden AR khớp dữ liệu nạp (cùng sổ MẪU)', async () => {
    expect((await accAr({ load: AR_FILE })).rc).toBe(0);
    expect(await ar.fetchEntries(pool)).toEqual(ARG.fixture.entries);
  });
});
