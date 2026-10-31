import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { loadConfig } from '@samsam/core/ops/director';
import type { RunState } from '@samsam/core/ops/job-runs';
import { collectDb } from '@samsam/core/ops/report';
import { saveDraft } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check, checkPublish } from '@samsam/core/security/guardrail';
import { PII_RE } from '@samsam/core/security/pii';
import { search } from '@samsam/core/security/py';
import { adminQuery, createDbFromTemplate, dbUrl, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { section } from '../sales_director/sales-watch.js';
import * as ka from './kd-affiliate.js';
import * as kc from './kd-care.js';
import * as ko from './kd-orders.js';
import {
  type CliDeps,
  kdAffiliateMain,
  kdCareMain,
  kdOrdersMain,
} from './kd-orders-care.command.js';

// Dịch phần DB của tests/test_kd_orders.py, test_kd_care.py, test_kd_affiliate.py + sales-06.2 của
// tests/test_v14_p4_sales.py, order_history của test_v14_p2_service_auth.py, finance-03.2 TẮT của
// test_v14_p3_rollout_edges.py. DB riêng `samsam_ts_kd_orders_care` từ mẫu (KHÔNG BAO GIỜ `samsam`),
// xóa khi xong; mỗi ca làm sạch bảng động (truncate dưới replica). `--watch` chạy bằng login tạm
// `in role svc_job`, `--sync/--recon` bằng login tạm `in role svc_loader` (login thật của 2 dịch vụ).
// Đơn/khách/đại lý/người duyệt là dữ liệu GIẢ LẬP (mã đơn "MAU…", ciphertext/HMAC giả đúng định dạng).

const NAME = 'samsam_ts_kd_orders_care';
const PID = process.pid;
const HONEY = 'mat-ong-sam-300ml';
const SAPH = 'saphraton-20v';
const H1 = 'mat-ong-sam-120ml-1hu';
const H2 = 'mat-ong-sam-120ml-2hu';
const SAPENTOL = 'sapentol-30v';
const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
const DECIDER = 'nguoi_duyet_gia_lap';
const VN = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 7, mi));
const NOW = VN(2026, 10, 14, 10);
const RESET = [
  'orders',
  'order_history',
  'market_rows',
  'market_snapshots',
  'recon_results',
  'settlement_rows',
  'approval_queue',
  'decisions',
  'agent_action_log',
  'care_purchases',
  'consents',
  'contacts',
  'affiliate_attributions',
  'affiliate_codes',
  'dealers',
  'content_drafts',
  'job_runs',
  'report_outputs',
];
const orderHash = (ch: string, code: string) =>
  createHash('sha256').update(`${ch}:${code}`).digest('hex').slice(0, 16);

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('kd_orders_care (DB)', () => {
  let pool: pg.Pool;
  let job: pg.Pool;
  let loader: pg.Pool;
  let tmp: string;
  const logins: string[] = [];
  const jobs: [string, boolean][] = [];

  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const n = async (table: string, where = 'true', p: unknown[] = []) =>
    Number(await one(`select count(*) from ${table} where ${where}`, p));
  const replica = (sql: string, p: unknown[] = []) =>
    withTx(pool, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(sql, p);
    });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const lease = (db: pg.Pool) => async () => ({ db: db as Db, release: async () => {} });
  const deps = (s: ReturnType<typeof io>, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: s.io,
    env: {},
    connect: lease(pool),
    service: (svc) => lease(svc === 'job' ? job : loader)(),
    wire: () => {},
    now: () => NOW,
    outDir: join(tmp, 'reports'),
    jobRun: (async (name: string, body: (r: RunState) => Promise<number>) => {
      const r: RunState = { ok: true, detail: null };
      const rc = await body(r);
      jobs.push([name, r.ok]);
      return rc;
    }) as CliDeps['jobRun'],
    ...extra,
  });

  async function login(tag: string, role: string): Promise<pg.Pool> {
    const name = `t_kdoc_${tag}_${PID}`;
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`drop role if exists ${name}`);
    await adminQuery(`create role ${name} login password '${pw}' in role ${role}`);
    logins.push(name);
    const u = new URL(dbUrl(NAME));
    u.username = name;
    u.password = pw;
    return createPool(u.toString(), { max: 2 });
  }

  async function loadDealers(): Promise<void> {
    const doc = JSON.parse(readFileSync(repoPath('data/dealer_regions.json'), 'utf8'));
    for (const d of doc.dealers) {
      await q(
        "insert into dealers (code, name, region, status, commission_default, source) values ($1, $2, $3, $4, $5, 'dealer_regions.json')",
        [d.code, d.name, d.region, d.status ?? 'active', d.commission_default ?? 0],
      );
    }
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kdoc-db-'));
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME), { max: 6 });
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    job = await login('job', 'svc_job');
    loader = await login('ld', 'svc_loader');
    // kd_care `_promotable`: mật ong (tự công bố) + cả họ Saphraton (XNQC approved) mở kênh zalo, giá
    // zalo ĐÃ duyệt (người duyệt GIẢ LẬP); Sapentol có giá nhưng chưa XNQC; rượu có giá nhưng CAM.
    await q("update sku_master set self_declaration_ok = true where category = 'food'");
    await q("update sku_master set xnqc_status = 'approved' where sku_key like 'saphraton-%'");
    await q(
      "update sku_master set allowed_channels = array['shopee', 'zalo'] where sku_key = any($1) or sku_key like 'saphraton-%' or category = 'food'",
      [[SAPENTOL, RUOU]],
    );
    for (const [k, p] of [
      [H1, 250000],
      [H2, 480000],
      [SAPH, 320000],
      [SAPENTOL, 300000],
      [RUOU, 700000],
    ] as const) {
      const id = await one(
        "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, 'zalo', 'list', $2, '2026-01-01') returning id",
        [k, p],
      );
      await q(
        "update price_list set approved_by = 'GD gia lap', approved_at = now() where id = $1",
        [id],
      );
    }
    const prom = (await q("select sku_key from v_promotable where channel = 'zalo'")).map(
      (r) => r.sku_key,
    );
    expect(new Set(prom)).toEqual(new Set([H1, H2, SAPH]));
    // kd_affiliate: mật ong 300ml mở shopee/tiktok/web
    await q(
      "update sku_master set self_declaration_ok = true, allowed_channels = '{shopee,tiktok,web}' where sku_key = $1",
      [HONEY],
    );
  });

  afterAll(async () => {
    settings.forceMode = null;
    await job?.end();
    await loader?.end();
    await pool?.end();
    await dropDb(NAME);
    for (const l of logins) await adminQuery(`drop role if exists ${l}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    jobs.length = 0;
    await replica(`truncate ${RESET.join(', ')} restart identity cascade`);
    await loadDealers();
    rmSync(join(tmp, 'reports'), { recursive: true, force: true });
  });

  // ============================================================ kd_orders
  type Line = {
    code: string | null;
    status: string;
    title: string;
    qty: number;
    price: number;
    sku?: string | null;
  };
  async function snap(ch: string, rows: Line[], ts?: Date): Promise<string> {
    const sid = String(
      await one(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ($1, 'order', 'mau.csv', $2, $3, coalesce($4, now())) returning id",
        [
          ch,
          createHash('sha256').update(`${Math.random()}`).digest('hex'),
          rows.length,
          ts ?? null,
        ],
      ),
    );
    let i = 2;
    for (const r of rows) {
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, title, price_vnd, status, qty, order_id_hash, sku_key, raw) values ($1, $2, $3, 'order', $4, $5, $6, $7, $8, $9, '{}')",
        [
          sid,
          i++,
          ch,
          r.title,
          r.price,
          r.status,
          r.qty,
          r.code ? orderHash(ch, r.code) : null,
          r.sku ?? null,
        ],
      );
    }
    return sid;
  }
  const SHOPEE: Line[] = [
    { code: 'MAU001', status: 'Hoàn thành', title: 'Mật ong', qty: 2, price: 150000, sku: HONEY },
    { code: 'MAU001', status: 'Hoàn thành', title: 'Saphraton', qty: 1, price: 320000, sku: SAPH },
    { code: 'MAU002', status: 'Đang giao', title: 'Mật ong', qty: 1, price: 150000, sku: HONEY },
    { code: null, status: 'Hoàn thành', title: 'dòng lỗi', qty: 1, price: 1 },
  ];
  const TIKTOK: Line[] = [
    { code: 'MAUT01', status: 'Completed', title: 'Honey', qty: 3, price: 140000, sku: null },
  ];
  const orders = async () =>
    Object.fromEntries(
      (
        await q(
          'select id, ts, channel, product_id, qty, total_vnd::int8 as total, status, note, source from orders order by id',
        )
      ).map((r) => [r.id, r]),
    );

  it('sync: gom đơn, idempotent, đổi sang hủy giữ ts, --snapshot dry-run không ghi, row manual không bị đè, 0 PII', async () => {
    const t0 = new Date(Date.UTC(2026, 9, 1, 3));
    const s1 = await snap('shopee', SHOPEE, t0);
    await snap('tiktok', TIKTOK, new Date(t0.getTime() + 300_000));
    expect(await ko.sync(pool)).toEqual({
      inserted: 3,
      updated: 0,
      unchanged: 0,
      protected: 0,
      skipped: 1,
      snapshots: 2,
    });
    const got = await orders();
    expect(Object.keys(got)).toHaveLength(3);
    expect(
      Object.values(got).reduce((s: number, o) => s + Number((o as { total: unknown }).total), 0),
    ).toBe(2 * 150000 + 320000 + 150000 + 3 * 140000);
    const h1 = orderHash('shopee', 'MAU001');
    const o1 = got[`shopee:${h1}`];
    expect([o1.product_id, o1.qty, Number(o1.total), o1.note, o1.source]).toEqual([
      null,
      3,
      620000,
      `${HONEY},${SAPH}`,
      'market:shopee',
    ]);
    expect(o1.ts.getTime()).toBe(t0.getTime());
    const before = await q('select count(*), sum(total_vnd) from orders');
    const r2 = await ko.sync(pool);
    expect([r2.inserted, r2.updated, r2.unchanged]).toEqual([0, 0, 3]);
    expect(await q('select count(*), sum(total_vnd) from orders')).toEqual(before);
    // snapshot sau đổi trạng thái sang hủy → updated=1, ts giữ nguyên
    const rows = SHOPEE.slice(0, 3).map((r, i) => (i < 2 ? { ...r, status: 'Đã hủy' } : r));
    await snap('shopee', rows, new Date(t0.getTime() + 2 * 86_400_000));
    const r3 = await ko.sync(pool);
    expect([r3.inserted, r3.updated, r3.unchanged]).toEqual([0, 1, 2]);
    const o1b = (await orders())[`shopee:${h1}`];
    expect([o1b.status, o1b.ts.getTime()]).toEqual(['cancelled', t0.getTime()]);
    // --snapshot chỉ snapshot đầu: dry-run đếm updated nhưng không ghi
    expect((await ko.sync(pool, [BigInt(s1)], true)).updated).toBe(1);
    expect((await orders())[`shopee:${h1}`].status).toBe('cancelled');
    // row manual cùng id KHÔNG bị đè
    const h2 = orderHash('shopee', 'MAU002');
    await q("update orders set source = 'manual', status = 'tay', total_vnd = 1 where id = $1", [
      `shopee:${h2}`,
    ]);
    const r4 = await ko.sync(pool);
    expect([r4.protected, r4.updated]).toEqual([1, 0]);
    const o2 = (await orders())[`shopee:${h2}`];
    expect([Number(o2.total), o2.status]).toEqual([1, 'tay']);
    // 0 cột PII + 0 giá trị khớp PII_RE
    const cols = (
      await q(
        "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'orders'",
      )
    ).map((r) => r.column_name as string);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => /name|phone|sdt|address|dia_chi|buyer|email/.test(c))).toEqual([]);
    for (const r of await q(
      "select id, channel, status, note, source from orders where source like 'market:%'",
    )) {
      for (const v of Object.values(r))
        expect(v === null || !search(PII_RE, v as string)).toBe(true);
    }
  });

  it('CLI --sync (login svc_loader): dry-run không ghi; lượt thật ghi + 1 job_run; không in hash đủ/mã đơn', async () => {
    await snap('shopee', SHOPEE);
    const s = io();
    expect(await kdOrdersMain({ sync: true, dryRun: true }, deps(s))).toBe(0);
    expect(await n('orders')).toBe(0);
    expect(jobs).toEqual([]);
    expect(await kdOrdersMain({ sync: true }, deps(s))).toBe(0);
    expect(await n('orders')).toBe(2);
    expect(jobs).toEqual([['agents.kd_orders', true]]);
    expect(s.out.at(-1)).toBe(
      '[sync] 1 snapshot đơn: thêm 2, cập nhật 0, không đổi 0, giữ nguyên row không phải sàn 0, bỏ dòng thiếu mã đơn 1',
    );
    const all = s.out.join('\n') + s.err.join('\n');
    for (const c of ['MAU001', 'MAU002']) {
      expect(all).not.toContain(orderHash('shopee', c));
      expect(all).not.toContain(c);
    }
  });

  it('order_history: nạp lại cùng snapshot → 0 lịch sử; snapshot sau đổi trạng thái → 1 (v14.2)', async () => {
    await snap('shopee', [
      { code: 'MAUH1', status: 'Hoàn thành', title: 'x', qty: 1, price: 100000 },
    ]);
    expect((await ko.sync(pool)).inserted).toBe(1);
    expect((await ko.sync(pool)).unchanged).toBe(1);
    expect(await n('order_history')).toBe(0);
    await snap('shopee', [{ code: 'MAUH1', status: 'Đã hủy', title: 'x', qty: 1, price: 100000 }]);
    expect((await ko.sync(pool)).updated).toBe(1);
    expect(await n('order_history')).toBe(1);
  });

  async function settle(
    ch: string,
    code: string,
    amount: number,
    fees: [number, number, number] = [0, 0, 0],
    payout = 0,
    o: { on?: string; label?: string | null; imported?: Date } = {},
  ): Promise<void> {
    const sid = await one(
      "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd, payment_fee_vnd, service_fee_vnd, shipping_fee_vnd, payout_vnd, settled_on, imported_at) values ($1, 'qt.csv', $2, 2, $3, $4, $5, $6, $7, 1000, $8, $9, coalesce($10, now())) returning id",
      [
        createHash('sha256').update(`${Math.random()}`).digest('hex'),
        ch,
        orderHash(ch, code),
        amount,
        ...fees,
        payout,
        o.on ?? '2026-10-05',
        o.imported ?? null,
      ],
    );
    const label = o.label === undefined ? 'khop' : o.label;
    if (label) {
      await q(
        'insert into recon_results (settlement_row_id, label, reasons, expected_payout_vnd) values ($1, $2, $3::jsonb, 0)',
        [sid, label, label === 'khop' ? '[]' : '[{"code": "thuc_nhan"}]'],
      );
    }
  }

  it('recon: nhãn/phí/thiếu đơn trong kỳ, CSV tất định không hash đủ, CLI --recon (svc_loader) ghi --out-dir', async () => {
    await snap(
      'shopee',
      ['MAUK1', 'MAUL1', 'MAUC1'].map((c) => ({
        code: c,
        status: 'Hoàn thành',
        title: 'x',
        qty: 1,
        price: 100000,
        sku: HONEY,
      })),
      new Date(Date.UTC(2026, 9, 2, 3)),
    );
    await ko.sync(pool);
    await settle('shopee', 'MAUK1', 100000, [500, 300, 200], 98000, {
      label: 'lech',
      imported: new Date(Date.UTC(2026, 9, 3)),
    }); // bản cũ bị thay
    await settle('shopee', 'MAUK1', 100000, [1000, 2000, 3000], 93000);
    await settle('shopee', 'MAUL1', 100000, [1000, 2000, 3000], 90000, { label: 'lech' });
    await settle('shopee', 'MAUX9', 50000, [100, 200, 300], 48000, { label: 'thieu_chung_tu' });
    await settle('shopee', 'MAUX8', 50000, [0, 0, 0], 0, {
      on: '2026-11-20',
      label: 'thieu_chung_tu',
    });
    const got = await ko.reconRows(pool, '2026-10-01', '2026-10-31');
    expect(got).toHaveLength(4);
    const by = Object.fromEntries(got.map((r) => [r.order_ref, r]));
    const k1 = by[orderHash('shopee', 'MAUK1').slice(0, 8)];
    expect([k1?.label, k1?.platform_fee_vnd, k1?.payout_vnd, k1?.total_vnd]).toEqual([
      'khop',
      6000n,
      93000n,
      100000n,
    ]);
    expect(by[orderHash('shopee', 'MAUL1').slice(0, 8)]?.label).toBe('lech');
    const c1 = by[orderHash('shopee', 'MAUC1').slice(0, 8)];
    expect([c1?.label, c1?.payout_vnd]).toEqual(['chua_quyet_toan', null]);
    const x9 = by[orderHash('shopee', 'MAUX9').slice(0, 8)];
    expect([x9?.label, x9?.platform_fee_vnd]).toEqual(['thieu_don', 600n]);
    expect(await ko.reconRows(pool, '2026-10-03', '2026-10-31')).toEqual([x9]);
    const p1 = ko.writeCsv(got, tmp, '2026-10-01', '2026-10-31');
    const b1 = readFileSync(p1);
    expect(p1.endsWith('doi-soat-2026-10-01-2026-10-31.csv')).toBe(true);
    const p2 = ko.writeCsv(
      await ko.reconRows(pool, '2026-10-01', '2026-10-31'),
      tmp,
      '2026-10-01',
      '2026-10-31',
    );
    expect(readFileSync(p2).equals(b1)).toBe(true);
    const text = b1.toString('utf8');
    expect(text.startsWith('﻿') && !text.includes('\r')).toBe(true);
    const lines = text.slice(1).replace(/\n$/, '').split('\n');
    expect(lines[0]?.split(',')).toEqual([...ko.CSV_FIELDS]);
    expect(lines).toHaveLength(6);
    const tong = (lines.at(-1) as string).split(',');
    expect(tong.slice(0, 2)).toEqual(['shopee', 'TONG']);
    expect(Number(tong[ko.CSV_FIELDS.indexOf('platform_fee_vnd')])).toBe(6000 + 6000 + 600);
    for (const c of ['MAUK1', 'MAUL1', 'MAUC1', 'MAUX9'])
      expect(text).not.toContain(orderHash('shopee', c));
    const s = io();
    const out = join(tmp, 'cli');
    expect(
      await kdOrdersMain(
        { recon: true, since: '2026-10-01', until: '2026-10-31', outDir: out },
        deps(s),
      ),
    ).toBe(0);
    expect(readFileSync(join(out, 'doi-soat-2026-10-01-2026-10-31.csv')).equals(b1)).toBe(true);
    expect(s.out[0]).toContain(
      '[recon] 4 dòng (khop 1, lech 1, thieu_chung_tu 0, hoan 0, chua_quyet_toan 1, thieu_don 1)',
    );
  });

  it('đơn sàn cancelled KHÔNG vào Đơn hàng/Doanh thu báo cáo định kỳ', async () => {
    const t0 = new Date(Date.UTC(2026, 9, 1, 3));
    const since = new Date(t0.getTime() - 86_400_000);
    const until = new Date(t0.getTime() + 7 * 86_400_000);
    await snap('shopee', SHOPEE.slice(0, 3), t0);
    await ko.sync(pool);
    const sales = async () => {
      const r = await collectDb(pool, since, until);
      if (!r.db_ok) throw new Error(r.db_error);
      return r.sales;
    };
    let s = await sales();
    expect([Number(s.count), Number(s.revenue)]).toEqual([2, 620000 + 150000]);
    await snap(
      'shopee',
      [{ code: 'MAU009', status: 'Đã hủy', title: 'Mật ong', qty: 5, price: 150000, sku: HONEY }],
      new Date(t0.getTime() + 3_600_000),
    );
    expect((await ko.sync(pool)).inserted).toBe(1);
    s = await sales();
    expect([Number(s.count), Number(s.revenue), Number(s.by_status.cancelled)]).toEqual([
      2, 770000, 1,
    ]);
  });

  // ------------------------------------------------------------ sales-06.2
  const W = '2026-10-12'; // thứ Hai tuần hiện hành (as-of 14/10)
  const wk = (i: number) => {
    const d = new Date(`${W}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    return d.toISOString().slice(0, 10);
  };
  async function order(ch: string, ts: Date, status: string, source?: string): Promise<void> {
    await q(
      'insert into orders (id, ts, channel, qty, total_vnd, status, source) values ($1, $2, $3, 1, 100000, $4, $5)',
      [
        `${ch}:${createHash('sha256').update(`${Math.random()}`).digest('hex').slice(0, 16)}`,
        ts,
        ch,
        status,
        source ?? `market:${ch}`,
      ],
    );
  }
  async function week(
    monday: string,
    total: number,
    cancel = 0,
    ret = 0,
    source?: string,
  ): Promise<void> {
    const [y, m, d] = monday.split('-').map(Number) as [number, number, number];
    const t = VN(y, m, d, 10);
    for (let i = 0; i < total; i++) {
      const st = i < cancel ? 'cancelled' : i < cancel + ret ? 'Đã hoàn tiền' : 'Đã giao';
      await order('shopee', new Date(t.getTime() + (i % 50) * 3_600_000), st, source);
    }
  }
  const queue = async (ot: string) =>
    q(
      'select id, object_id, status, payload, block, created_by from approval_queue where object_type = $1 order by id',
      [ot],
    );
  const OW = () => section('order_watch') as unknown as ko.OrderWatch;

  it('watch (login svc_job): tuần đã đóng hủy 20% > 15% → 1 mục; đợt: pending nuốt, đã quyết → chỉ mục mới khi số đơn xấu TĂNG; TẮT → RolloutBlocked', async () => {
    await week(wk(1), 20, 4);
    for (let i = 2; i < 6; i++) await week(wk(i), 20, 1);
    await week(wk(1), 30, 30, 0, 'sample'); // MẪU bị loại
    await week(W, 20, 20); // tuần chưa đóng
    const cfg = loadConfig('sales');
    let r = await ko.watch(job, '2026-10-14', OW(), cfg);
    expect(r.enqueued).toBe(1);
    let rows = await queue('order_anomaly');
    expect(rows[0]?.object_id).toBe(`ow:shopee:cancel:${wk(1)}:4`);
    expect([rows[0]?.block, rows[0]?.created_by]).toEqual(['sales', 'agent:kd_orders']);
    const p = rows[0]?.payload as string;
    expect(p).toContain('20 đơn, hủy 4 (20.0%)');
    expect(p.toLowerCase()).toContain('chưa đo');
    expect(check(p).ok).toBe(true);
    await order(
      'shopee',
      VN(...(wk(1).split('-').map(Number) as [number, number, number]), 9),
      'cancelled',
    );
    expect((await ko.watch(job, '2026-10-14', OW(), cfg)).new).toBe(0);
    const [ok, msg] = await decide(pool, rows[0]?.id, 'Lan', 'rejected');
    expect(ok, msg ?? '').toBe(true);
    r = await ko.watch(job, '2026-10-14', OW(), cfg);
    expect(r.enqueued).toBe(1);
    rows = await queue('order_anomaly');
    expect(rows[1]?.object_id).toBe(`ow:shopee:cancel:${wk(1)}:5`);
    expect((await ko.watch(job, '2026-10-14', OW(), cfg)).new).toBe(0);
    settings.forceMode = 'tat';
    await expect(ko.watch(job, '2026-10-14', OW(), cfg)).rejects.toBeInstanceOf(RolloutBlocked);
  });

  it('CLI --watch --dry-run --as-of: trạng thái hoàn/trả theo kênh, KHÔNG ghi DB, đơn trễ CHƯA ĐO; TẮT → [rollout] exit 2', async () => {
    await week(wk(1), 20, 0, 3); // 15% > 10%
    let s = io();
    expect(await kdOrdersMain({ watch: true, dryRun: true, asOf: '2026-10-14' }, deps(s))).toBe(0);
    const out = s.out.join('\n');
    expect(out).toContain('hoàn/trả 3/20 (15.0%)');
    expect(out).toContain('KHÔNG ghi DB');
    expect(out).toContain('CHƯA ĐO');
    expect(await queue('order_anomaly')).toEqual([]);
    settings.forceMode = 'tat';
    s = io();
    expect(await kdOrdersMain({ watch: true }, deps(s))).toBe(2);
    expect(s.err[0]).toMatch(/^\[rollout\] .*sales-06\.2/);
  });

  // ============================================================ kd_care
  const ENC = new Map<number, [string, string]>();
  async function contact(k: number): Promise<number> {
    const hm = createHash('sha256').update(`gia-lap-${k}`).digest('hex');
    const enc = `gAAAAA${createHash('sha256').update(`enc-${k}`).digest('hex')}`;
    const id = Number(
      await one(
        "insert into contacts (phone_hmac, phone_enc, name_enc, province, source, created_by) values ($1, $2, $3, 'Đà Nẵng', 'manual', 'Nguoi ghi gia lap') returning id",
        [hm, enc, `${enc}N`],
      ),
    );
    ENC.set(id, [hm, enc]);
    return id;
  }
  const consent = (cid: number, purpose: string, granted = true) =>
    q(
      "insert into consents (contact_id, purpose, granted, source, evidence_ref, policy_version, recorded_by) values ($1, $2, $3, 'form_giay', 'BB-MAU-01', 'v0-mau', 'Nguoi ghi gia lap')",
      [cid, purpose, granted],
    );
  const purchase = async (
    cid: number,
    sku: string,
    channel = 'web',
    bought = '2026-09-01',
    got: string | null = '2026-09-03',
  ) =>
    Number(
      await one(
        "insert into care_purchases (contact_id, channel, sku_key, purchased_on, delivered_on, recorded_by) values ($1, $2, $3, $4, $5, 'Nguoi ghi gia lap') returning id",
        [cid, channel, sku, bought, got],
      ),
    );
  const careQueue = async () =>
    q(
      'select id, object_type, object_id, status, payload, title, risk, block from approval_queue order by id',
    );
  const checkViolation = async (fn: () => Promise<unknown>) =>
    expect(fn()).rejects.toMatchObject({ code: '23514' });

  it('care_purchases: DB chặn kênh sàn + người ghi agent:, không cột PII', async () => {
    const cid = await contact(99);
    for (const ch of ['shopee', 'tiktok', 'lazada'])
      await checkViolation(() => purchase(cid, H1, ch));
    await checkViolation(() =>
      q(
        "insert into care_purchases (contact_id, channel, sku_key, purchased_on, recorded_by) values ($1, 'web', $2, '2026-09-01', 'agent:kd_a7')",
        [cid, H1],
      ),
    );
    const cols = (
      await q(
        "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'care_purchases'",
      )
    ).map((r) => r.column_name as string);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => /name|phone|sdt|address|dia_chi|email|_enc|hmac/.test(c))).toEqual(
      [],
    );
  });

  it('run: đúng khách có đồng ý, trần tháng, rejected không tính trần, khuyến cáo TPBVSK, verify_send (sha/khung giờ/rút đồng ý), rượu/TPBVSK chưa XNQC', async () => {
    const ids: Record<number, number> = {};
    for (let k = 1; k < 19; k++) ids[k] = await contact(k);
    for (let k = 1; k < 31; k++)
      await checkViolation(() =>
        purchase(ids[(k % 18) + 1] as number, H1, k <= 20 ? 'shopee' : 'tiktok'),
      );
    for (let k = 1; k < 13; k++) await consent(ids[k] as number, 'marketing');
    for (const k of [13, 14, 15]) await consent(ids[k] as number, 'cskh');
    await consent(ids[16] as number, 'b2b');
    const pids: Record<number, number[]> = {};
    for (let k = 1; k < 19; k++) pids[k] = [await purchase(ids[k] as number, H1)];
    pids[1]?.push(await purchase(ids[1] as number, H2, 'web', '2026-09-02'));
    pids[1]?.push(await purchase(ids[1] as number, SAPH, 'web', '2026-09-03'));
    expect(await n('care_purchases')).toBe(20);
    const res = await kc.run(pool, NOW);
    const qq = await careQueue();
    const rebuy = qq.filter((r) => r.object_type === 'care_rebuy');
    const review = qq.filter((r) => r.object_type === 'care_review');
    expect(new Set(rebuy.map((r) => Number(String(r.object_id).split(':')[0])))).toEqual(
      new Set(Array.from({ length: 12 }, (_, i) => ids[i + 1])),
    );
    expect(rebuy).toHaveLength(13);
    expect(new Set(review.map((r) => r.object_id))).toEqual(
      new Set([13, 14, 15].map((k) => `review:${pids[k]?.[0]}`)),
    );
    expect([res.new, qq.length]).toEqual([16, 16]);
    expect(qq.every((r) => r.status === 'pending' && r.block === 'sales')).toBe(true);
    expect(new Set(rebuy.map((r) => r.risk))).toEqual(new Set(['high']));
    expect(new Set(review.map((r) => r.risk))).toEqual(new Set(['medium']));
    const why = new Map(res.skipped.map((s) => [`${s.contact_id}:${s.kind}`, s.ly_do]));
    expect(why.get(`${ids[16]}:rebuy`)).toBe('consent'); // b2b ≠ marketing
    expect(why.get(`${ids[13]}:rebuy`)).toBe('consent');
    expect(res.skipped.filter((s) => s.ly_do === 'tran_thang').map((s) => s.purchase_id)).toEqual([
      pids[1]?.[2],
    ]);
    for (const r of qq) {
      const payload = r.payload as string;
      expect(search(PII_RE, payload) ?? search(PII_RE, r.title)).toBeNull();
      for (const [hm, enc] of ENC.values())
        expect(payload.includes(hm) || payload.includes(enc)).toBe(false);
      expect(payload).toMatch(/^contact_id: \d+$/m);
      expect(payload).toContain('gui_luc: 2026-10-14 10:00');
      if (r.object_type === 'care_rebuy') {
        expect(payload).toContain('Quảng cáo');
        expect(payload).toContain('muc_dich: marketing');
      }
    }
    // chạy lại cùng now → 0 mục mới
    expect((await kc.run(pool, NOW)).new).toBe(0);
    expect(await n('approval_queue')).toBe(16);
    // mục rejected không tính trần → lần mua thứ 3 của khách 1 được đẩy; TPBVSK có câu khuyến cáo
    const first1 = rebuy.find((r) => Number(String(r.object_id).split(':')[0]) === ids[1]);
    let [ok, msg] = await decide(pool, first1?.id, DECIDER, 'rejected');
    expect(ok, msg ?? '').toBe(true);
    expect((await kc.run(pool, NOW)).new).toBe(1);
    const last = (await careQueue()).at(-1);
    expect(last?.object_id).toBe(`${ids[1]}:2026-10:p${pids[1]?.[2]}`);
    expect(last?.payload).toContain('không phải là thuốc');
    // verify_send: approved khách 2 → ok; sửa 1 ký tự → sha; ngoài khung → khung_gio; rút đồng ý → consent
    const it2 = rebuy.find((r) => Number(String(r.object_id).split(':')[0]) === ids[2]);
    const p2 = it2?.payload as string;
    expect(await kc.verifySend(pool, it2?.id, p2, NOW)).toEqual([false, 'chua_duyet']);
    [ok, msg] = await decide(pool, it2?.id, DECIDER, 'approved');
    expect(ok, msg ?? '').toBe(true);
    expect(await kc.verifySend(pool, it2?.id, p2, NOW)).toEqual([true, 'ok']);
    expect(await kc.verifySend(pool, it2?.id, `${p2} `, NOW)).toEqual([false, 'sha']);
    expect(await kc.verifySend(pool, it2?.id, p2, VN(2026, 10, 14, 21))).toEqual([
      false,
      'khung_gio',
    ]);
    await consent(ids[2] as number, 'marketing', false);
    expect(await kc.verifySend(pool, it2?.id, p2, NOW)).toEqual([false, 'consent']);
    expect(await kc.verifySend(pool, 10 ** 9, 'x', NOW)).toEqual([false, 'khong_tim_thay']);
    expect(await kc.verifySend(pool, 'abc', 'x', NOW)).toEqual([false, 'khong_tim_thay']);
    // rút đồng ý trước lần --run kế → 0 mục mới cho khách đó
    await purchase(ids[3] as number, H2, 'web', '2026-09-05', null);
    await consent(ids[3] as number, 'marketing', false);
    const r4 = await kc.run(pool, NOW);
    expect(r4.new).toBe(0);
    expect(r4.skipped.some((s) => s.contact_id === ids[3] && s.ly_do === 'consent')).toBe(true);
    // rượu + TPBVSK chưa XNQC → 0 tin nhắc
    const c19 = await contact(19);
    const c20 = await contact(20);
    for (const c of [c19, c20]) await consent(c, 'marketing');
    await purchase(c19, RUOU);
    await purchase(c20, SAPENTOL);
    const r5 = await kc.run(pool, NOW);
    expect(r5.new).toBe(0);
    const why5 = new Map(
      r5.skipped.filter((s) => s.kind === 'rebuy').map((s) => [s.contact_id, s.ly_do]),
    );
    expect([why5.get(c19), why5.get(c20)]).toEqual(['ruou', 'khong_promotable']);
  });

  it('CLI --record/--plan/--run: input lỗi exit 1 không ghi, không echo PII; dry-run không ghi; run ghi + 1 job_run', async () => {
    const cid = await contact(1);
    await consent(cid, 'marketing');
    const rec = {
      contact_id: cid,
      channel: 'web',
      sku_key: H1,
      purchased_on: '2026-09-01',
      order_ref: 'WEB-0001',
    };
    const s = io();
    const stdin = (o: unknown) => async () =>
      Buffer.from(Buffer.isBuffer(o) ? o : JSON.stringify(o));
    expect(
      await kdCareMain({ record: true, by: 'Nguoi ghi gia lap' }, deps(s, { stdin: stdin(rec) })),
    ).toBe(0);
    expect(await q('select channel, order_ref, recorded_by from care_purchases')).toEqual([
      { channel: 'web', order_ref: 'WEB-0001', recorded_by: 'Nguoi ghi gia lap' },
    ]);
    const log = (
      await q("select actor, detail from agent_action_log where action = 'care_purchase_record'")
    )[0];
    expect([log?.actor, log?.detail.contact_id]).toEqual(['Nguoi ghi gia lap', cid]);
    for (const bad of [
      { ...rec, channel: 'shopee' },
      { ...rec, phone: '0901234567' },
      { ...rec, '0907654321': 1 },
      { ...rec, order_ref: '0901234567' },
      [1],
      Buffer.from('{x'),
    ]) {
      expect(
        await kdCareMain({ record: true, by: 'Nguoi ghi gia lap' }, deps(s, { stdin: stdin(bad) })),
      ).toBe(1);
    }
    expect(await n('care_purchases')).toBe(1);
    expect(await kdCareMain({ plan: true }, deps(s))).toBe(0);
    expect(await kdCareMain({ run: true, dryRun: true }, deps(s))).toBe(0);
    expect(await n('approval_queue')).toBe(0);
    expect(jobs).toEqual([]);
    expect(await kdCareMain({ run: true }, deps(s))).toBe(0);
    expect(await n('approval_queue')).toBe(1);
    expect(jobs).toEqual([['agents.kd_care', true]]);
    const all = s.out.join('\n') + s.err.join('\n');
    expect(all).not.toContain('0901234567');
    expect(all).not.toContain('0907654321');
    expect(all).toContain('KHÔNG gửi');
    expect(all).toContain('[plan] 1 nháp');
  });

  it('trần theo THÁNG GỬI: chạy 31/10 22:30 (gửi 01/11 08:00) rồi 01/11 10:00 → ≤ 2 tin tháng 11; gửi trễ sang tháng 12 → thang_khac', async () => {
    const cid = await contact(1);
    await consent(cid, 'marketing');
    await purchase(cid, H1, 'web', '2026-09-15', null);
    await purchase(cid, H2, 'web', '2026-09-16', null);
    expect((await kc.run(pool, VN(2026, 10, 31, 22, 30))).new).toBe(2);
    await purchase(cid, SAPH, 'web', '2026-09-20', null);
    const nov1 = VN(2026, 11, 1, 10);
    const res = await kc.run(pool, nov1);
    expect(res.new).toBe(0);
    expect(res.skipped.map((s) => s.ly_do)).toEqual(['tran_thang']);
    const rows = (await careQueue()).filter((r) => r.object_type === 'care_rebuy');
    expect(rows.map((r) => String(r.object_id).split(':')[1]).sort()).toEqual([
      '2026-11',
      '2026-11',
    ]);
    const [ok, msg] = await decide(pool, rows[0]?.id, DECIDER, 'approved');
    expect(ok, msg ?? '').toBe(true);
    expect(await kc.verifySend(pool, rows[0]?.id, rows[0]?.payload, nov1)).toEqual([true, 'ok']);
    expect(await kc.verifySend(pool, rows[0]?.id, rows[0]?.payload, VN(2026, 12, 1, 10))).toEqual([
      false,
      'thang_khac',
    ]);
  });

  // ============================================================ kd_affiliate
  const HONEY_TEXT =
    'Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao Nội dung có sử dụng AI';
  async function draft(approve = true): Promise<number> {
    const g = checkPublish(HONEY_TEXT, {
      channel: 'shopee',
      contentType: 'ads',
      sku: HONEY,
      isAi: true,
    });
    const did = await saveDraft(pool, {
      brief: 'brief MẪU',
      channel: 'shopee',
      text: HONEY_TEXT,
      guardrail: g,
      createdBy: 'mkt lap',
      contentType: 'ads',
      sku: HONEY,
      isAi: true,
    });
    if (approve) await q("select approve_draft($1, 'duyet mkt', null)", [did]);
    return Number(did);
  }
  const codes = async () =>
    q(
      'select code, dealer_code, channel, status, queue_id::text as queue_id from affiliate_codes order by id',
    );
  const aff = async (o: Parameters<typeof kdAffiliateMain>[0]) => {
    const s = io();
    return { rc: await kdAffiliateMain(o, deps(s)), ...s };
  };
  const issueCli = (dealer: string, ids: number[], extra: Record<string, unknown> = {}) =>
    aff({
      issue: true,
      dealer,
      channel: 'shopee',
      draftIds: ids.join(','),
      by: 'nv kinh doanh',
      ...extra,
    });

  it('issue → release → revoke: dry-run không ghi; mã+mục pending; chạy lại skip; release chưa duyệt chặn; người duyệt → active + file kit; lệch bản duyệt → AFF_PAYLOAD_CHANGED', async () => {
    const d1 = await draft();
    const d2 = await draft();
    let r = await issueCli('DLM01', [d1, d2], { dryRun: true });
    expect(r.rc).toBe(0);
    expect(r.out.join('\n')).toContain('[dry-run]');
    expect(r.out.join('\n')).toContain(HONEY_TEXT);
    expect([await n('affiliate_codes'), await n('approval_queue')]).toEqual([0, 0]);
    r = await issueCli('DLM01', [d1, d2]);
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.out[0]).toContain('[issue]');
    const [c0] = await codes();
    expect([c0?.dealer_code, c0?.channel, c0?.status]).toEqual(['DLM01', 'shopee', 'pending']);
    expect(ka.CODE_RE.test(c0?.code)).toBe(true);
    const qid = c0?.queue_id as string;
    const cid = await one('select id from affiliate_codes where code = $1', [c0?.code]);
    const row = (
      await q(
        'select block, object_type, object_id, status, payload from approval_queue where id = $1',
        [qid],
      )
    )[0];
    expect([row?.block, row?.object_type, row?.object_id, row?.status]).toEqual([
      'sales',
      'affiliate_program',
      `aff-${cid}`,
      'pending',
    ]);
    expect(row?.payload).toContain(c0?.code);
    expect(row?.payload).toContain(HONEY_TEXT);
    expect(row?.payload).not.toContain('Đại lý MẪU 01');
    r = await issueCli('DLM01', [d1]);
    expect(r.out[0]).toContain('[skip]');
    expect([await n('affiliate_codes'), await n('approval_queue')]).toEqual([1, 1]);
    const rel = { release: qid, by: 'nguoi phat hanh' };
    r = await aff(rel);
    expect(r.rc).toBe(1);
    expect(r.out[0]).toContain('AFF_NOT_APPROVED');
    expect((await codes())[0]?.status).toBe('pending');
    expect(existsSync(join(tmp, 'reports'))).toBe(false);
    expect((await aff({ revoke: c0?.code, by: 'x' })).rc).toBe(1);
    const [ok, msg] = await decide(pool, qid, 'GD ban hang', 'approved');
    expect(ok, msg ?? '').toBe(true);
    r = await aff(rel);
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.out[0]).toContain('gửi TAY');
    expect(
      (
        await q(
          'select status, activated_by, queue_id::text as q from affiliate_codes where code = $1',
          [c0?.code],
        )
      )[0],
    ).toEqual({ status: 'active', activated_by: 'nguoi phat hanh', q: qid });
    const f = join(tmp, 'reports', `affiliate-kit-DLM01-${qid}.md`);
    expect(readFileSync(f, 'utf8')).toBe(row?.payload);
    // payload trong hàng bị sửa sau duyệt → không khớp bản đã duyệt
    await replica("update approval_queue set payload = payload || ' x' where id = $1", [qid]);
    expect(
      (await ka.release(pool, BigInt(qid), { by: 'x', outDir: join(tmp, 'reports') })).code,
    ).toBe('AFF_PAYLOAD_CHANGED');
    // thu hồi (mã chữ thường vẫn nhận) → revoked; thu hồi lần 2 → lỗi; được cấp mã mới
    expect((await aff({ revoke: c0?.code.toLowerCase(), by: 'GD ban hang' })).rc).toBe(0);
    expect((await codes())[0]?.status).toBe('revoked');
    expect((await aff({ revoke: c0?.code, by: 'x' })).rc).toBe(1);
    expect((await issueCli('DLM01', [d1])).rc).toBe(0);
    expect(await n('affiliate_codes')).toBe(2);
    expect((await ka.release(pool, 99_999_999n, { by: 'x' })).code).toBe('AFF_NOT_APPROVED');
  });

  it('nội dung chưa duyệt → AFF_CREATIVE_UNAPPROVED 0 ghi; mục rejected → mã void; đại lý ngưng/không có → AFF_DEALER', async () => {
    const d1 = await draft();
    const dp = await draft(false);
    let r = await issueCli('DLM02', [dp]);
    expect(r.rc).toBe(1);
    expect(r.out[0]).toContain('AFF_CREATIVE_UNAPPROVED');
    expect(await n('affiliate_codes')).toBe(0);
    expect((await issueCli('DLM02', [d1])).rc).toBe(0);
    const qid = (await codes())[0]?.queue_id;
    expect(await decide(pool, qid, 'GD ban hang', 'rejected')).toEqual([true, null]);
    r = await aff({ release: qid, by: 'x' });
    expect(r.rc).toBe(1);
    expect(r.out[0]).toContain('AFF_NOT_APPROVED');
    expect((await codes())[0]?.status).toBe('void');
    await q("update dealers set status = 'ended' where code = 'DLM04'");
    const nq = await n('approval_queue');
    r = await issueCli('DLM04', [d1]);
    expect(r.rc).toBe(1);
    expect(r.out[0]).toContain('AFF_DEALER');
    expect([await n('affiliate_codes'), await n('approval_queue')]).toEqual([1, nq]);
    expect((await issueCli('NOPE9', [d1])).rc).toBe(1);
  });

  it('issue: lỗi khi đẩy hàng duyệt → mã không treo (cùng giao dịch rollback); sau đó phát hành bình thường', async () => {
    const d1 = await draft();
    const cfg = loadConfig('sales');
    const bad = { ...cfg, object_types: { ...cfg.object_types } };
    delete bad.object_types.affiliate_program;
    await expect(
      ka.issue(pool, 'DLM01', 'shopee', [BigInt(d1)], { by: 'nv kinh doanh', dcfg: bad }),
    ).rejects.toThrow(/không nhận loại việc 'affiliate_program'/);
    expect([await n('affiliate_codes'), await n('approval_queue')]).toEqual([0, 0]);
    const res = await ka.issue(pool, 'DLM01', 'shopee', [BigInt(d1)], {
      by: 'nv kinh doanh',
      dcfg: cfg,
    });
    expect([res.skipped, res.qid !== null]).toEqual([false, true]);
    expect([await n('affiliate_codes'), await n('approval_queue')]).toEqual([1, 1]);
  });

  it('ràng buộc DB affiliate: mẫu mã, 1 mã mở/(đại lý, kênh), active cần activated_at, rượu/hủy hoa hồng = 0', async () => {
    await checkViolation(() =>
      q(
        "insert into affiliate_codes (code, dealer_code, channel, created_by) values ('SS0OOOOOOOOO', 'DLM01', 'shopee', 'x')",
      ),
    );
    await q(
      "insert into affiliate_codes (code, dealer_code, channel, created_by) values ('SSAAAAAAAAAA', 'DLM01', 'shopee', 'x')",
    );
    await expect(
      q(
        "insert into affiliate_codes (code, dealer_code, channel, created_by) values ('SSBBBBBBBBBB', 'DLM01', 'shopee', 'x')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await checkViolation(() =>
      q("update affiliate_codes set status = 'active' where code = 'SSAAAAAAAAAA'"),
    );
    const sid = await one(
      "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'order', 'f.csv', 'x', 1) returning id",
    );
    const mr = await one(
      "insert into market_rows (snapshot_id, row_no, channel, export_kind, raw) values ($1, 2, 'shopee', 'order', '{}') returning id",
      [sid],
    );
    const cid = await one("select id from affiliate_codes where code = 'SSAAAAAAAAAA'");
    const sql =
      "insert into affiliate_attributions (code_id, dealer_code, channel, order_id_hash, line_key, market_row_id, category, qty, amount_vnd, rate_pct, commission_vnd, status) values ($1, 'DLM01', 'shopee', '0123456789abcdef', 'k', $2, $3, 1, 100, 0, $4, $5)";
    await checkViolation(() => q(sql, [cid, mr, 'alcohol', 1, 'tinh']));
    await checkViolation(() => q(sql, [cid, mr, 'tpbvsk', 1, 'huy']));
    await q(sql, [cid, mr, 'alcohol', 0, 'tinh']);
  });

  async function active(code: string, dealer: string, channel = 'shopee'): Promise<void> {
    await q(
      "insert into affiliate_codes (code, dealer_code, channel, created_by, status, activated_at, activated_by) values ($1, $2, $3, 'x', 'active', now(), 'y')",
      [code, dealer, channel],
    );
  }
  type ORow = {
    code: string;
    status: string;
    sku: string;
    qty: number;
    price: number;
    voucher?: string;
  };
  /** Như `market_csv.load` file đơn Shopee: seller_sku = mã SKU, voucher_code chỉ trong `raw`. */
  async function loadOrder(rows: ORow[], noVoucherCol = false): Promise<string[]> {
    const sid = await one(
      "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'order', 'o.csv', $1, $2) returning id",
      [createHash('sha256').update(`${Math.random()}`).digest('hex'), rows.length],
    );
    let i = 2;
    for (const r of rows) {
      const raw = noVoucherCol ? {} : { voucher_code: r.voucher ?? '' };
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, seller_sku, sku_key, title, price_vnd, status, qty, order_id_hash, raw) values ($1, $2, 'shopee', 'order', $3, $3, 'x', $4, $5, $6, $7, $8)",
        [
          sid,
          i++,
          r.sku,
          r.price,
          r.status,
          r.qty,
          orderHash('shopee', r.code),
          JSON.stringify(raw),
        ],
      );
    }
    return rows.map((r) => orderHash('shopee', r.code));
  }
  const attr = async () =>
    Object.fromEntries(
      (
        await q(
          'select line_key, commission_vnd::int8 as com, status, flags, settled, rate_pct::text as rate from affiliate_attributions',
        )
      ).map((r) => [r.line_key, r]),
    );

  it('attribute: idempotent, rượu 0, hủy theo snapshot mới, đã quyết toán, mã pending 0; report BẢN NHÁP không hash; CLI', async () => {
    const [a, b] = ['SSAAAAAAAAAA', 'SSBBBBBBBBBB'];
    await active(a, 'DLM01');
    await active(b, 'DLM02');
    const hashes = await loadOrder([
      {
        code: 'FAKE-A1',
        status: 'Hoàn thành',
        sku: SAPH,
        qty: 2,
        price: 299000,
        voucher: ` ${a.toLowerCase()} `,
      },
      { code: 'FAKE-A2', status: 'Hoàn thành', sku: RUOU, qty: 1, price: 500000, voucher: b },
      {
        code: 'FAKE-A3',
        status: 'Hoàn thành',
        sku: HONEY,
        qty: 1,
        price: 100000,
        voucher: 'SSZZZZZZZZZZ',
      },
    ]);
    expect(await ka.attribute(pool)).toEqual({
      new: 2,
      updated: 0,
      same: 0,
      unknown_code: 1,
      web_skipped: 0,
    });
    let got = await attr();
    expect([Number(got[SAPH]?.com), got[SAPH]?.status, got[SAPH]?.flags]).toEqual([
      59_800,
      'tinh',
      [],
    ]);
    expect(Number(got[RUOU]?.com)).toBe(0);
    expect(got[RUOU]?.flags).toContain('ruou_online');
    expect(await ka.attribute(pool)).toEqual({
      new: 0,
      updated: 0,
      same: 2,
      unknown_code: 1,
      web_skipped: 0,
    });
    expect(await n('affiliate_attributions')).toBe(2);
    await loadOrder([
      { code: 'FAKE-A1', status: 'Đã hủy', sku: SAPH, qty: 2, price: 299000, voucher: a },
    ]);
    const r = await ka.attribute(pool);
    expect([r.new, r.updated]).toEqual([0, 1]);
    got = await attr();
    expect([Number(got[SAPH]?.com), got[SAPH]?.status]).toEqual([0, 'huy']);
    expect(got[SAPH]?.flags).toContain('huy');
    expect(await n('affiliate_attributions')).toBe(2);
    await q(
      "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, payout_vnd) values ($1, 's.csv', 'shopee', 2, $2, 500000, 450000)",
      ['a'.repeat(64), hashes[1]],
    );
    expect((await ka.attribute(pool)).updated).toBe(1);
    expect((await attr())[RUOU]?.settled).toBe(true);
    await q(
      "insert into affiliate_codes (code, dealer_code, channel, created_by) values ('SSCCCCCCCCCC', 'DLM03', 'shopee', 'x')",
    );
    await loadOrder([
      {
        code: 'FAKE-A4',
        status: 'Hoàn thành',
        sku: HONEY,
        qty: 3,
        price: 100000,
        voucher: 'SSCCCCCCCCCC',
      },
    ]);
    expect((await ka.attribute(pool)).new).toBe(1);
    const p = (await attr())[HONEY];
    expect(Number(p?.com)).toBe(0);
    expect(p?.flags).toContain('ma_chua_kich_hoat');
    const rep = await ka.report(pool, '2000-01-01', '2100-01-01');
    expect(rep).toContain('BẢN NHÁP');
    expect(rep).toContain('DLM01');
    expect(rep).toContain('DLM02');
    expect(rep).not.toContain('Đại lý MẪU');
    for (const h of hashes) expect(rep).not.toContain(h);
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const day = (k: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
    let c = await aff({ report: true, from: day(-2), to: day(2) });
    expect(c.rc).toBe(0);
    expect(c.out.join('\n')).toContain('BẢN NHÁP');
    for (const h of hashes) expect(c.out.join('\n')).not.toContain(h);
    c = await aff({ attribute: true });
    expect(c.rc).toBe(0);
    expect(c.out[0]).toContain('mới 0');
    // kỳ khác → không có dòng; kỳ hôm nay có dòng
    expect(await ka.report(pool, '2000-01-01', '2000-01-02')).toContain('(không có dòng)');
    expect(await ka.report(pool, day(-1), day(2))).toContain('| DLM01 | shopee | 1 |');
  });

  it('attribute: mã kênh khác đơn → unknown_code, mã web → web_skipped; voucher theo dòng mới nhất CÓ mã', async () => {
    await active('SSDDDDDDDDDD', 'DLM01', 'tiktok');
    await active('SSEEEEEEEEEE', 'DLM02', 'web');
    await loadOrder([
      {
        code: 'FAKE-C1',
        status: 'Hoàn thành',
        sku: HONEY,
        qty: 1,
        price: 100000,
        voucher: 'SSDDDDDDDDDD',
      },
      {
        code: 'FAKE-C2',
        status: 'Hoàn thành',
        sku: SAPH,
        qty: 1,
        price: 299000,
        voucher: 'SSEEEEEEEEEE',
      },
      {
        code: 'FAKE-C3',
        status: 'Hoàn thành',
        sku: HONEY,
        qty: 1,
        price: 100000,
        voucher: 'SSZZZZZZZZZZ',
      },
    ]);
    expect(await ka.attribute(pool)).toEqual({
      new: 0,
      updated: 0,
      same: 0,
      unknown_code: 2,
      web_skipped: 1,
    });
    expect(await n('affiliate_attributions')).toBe(0);
    await replica(
      'truncate affiliate_codes, market_rows, market_snapshots restart identity cascade',
    );
    const a = 'SSAAAAAAAAAA';
    await active(a, 'DLM01');
    await loadOrder([
      { code: 'FAKE-A1', status: 'Hoàn thành', sku: HONEY, qty: 1, price: 100000, voucher: a },
    ]);
    expect((await ka.attribute(pool)).new).toBe(1);
    const cid = String(await one('select id from affiliate_codes where code = $1', [a]));
    const row = async () =>
      (
        await q(
          'select code_id::text as c, qty, amount_vnd::int8 as amt, status from affiliate_attributions',
        )
      )[0];
    expect(await row()).toMatchObject({ c: cid, qty: 1, status: 'tinh' });
    await loadOrder([
      { code: 'FAKE-A1', status: 'Hoàn thành', sku: HONEY, qty: 3, price: 100000, voucher: '' },
    ]);
    let r = await ka.attribute(pool);
    expect([r.new, r.updated, r.same]).toEqual([0, 1, 0]);
    expect(await row()).toMatchObject({ c: cid, qty: 3, status: 'tinh' });
    expect(Number((await row())?.amt)).toBe(300_000);
    await loadOrder(
      [{ code: 'FAKE-A1', status: 'Đã hủy', sku: HONEY, qty: 3, price: 100000 }],
      true,
    );
    r = await ka.attribute(pool);
    expect([r.new, r.updated, r.same]).toEqual([0, 1, 0]);
    expect(await row()).toMatchObject({ c: cid, qty: 3, status: 'huy' });
    expect(await n('affiliate_attributions')).toBe(1);
  });

  it('finance-03.2 TẮT → attribute RolloutBlocked, 0 ghi; CLI [error] RolloutBlocked exit 1', async () => {
    await active('SSAAAAAAAAAA', 'DLM01');
    await loadOrder([
      {
        code: 'FAKE-A1',
        status: 'Hoàn thành',
        sku: HONEY,
        qty: 1,
        price: 100000,
        voucher: 'SSAAAAAAAAAA',
      },
    ]);
    settings.forceMode = 'tat';
    await expect(ka.attribute(pool, {})).rejects.toBeInstanceOf(RolloutBlocked);
    const c = await aff({ attribute: true });
    expect(c.rc).toBe(1);
    expect(c.err[0]).toMatch(/^\[error\] RolloutBlocked: .*finance-03\.2/);
    expect(await n('affiliate_attributions')).toBe(0);
  });
});
