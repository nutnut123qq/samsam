import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import pg, { type Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CmdDeps, marketApiMain, marketCsvMain } from './market.command.js';
import { type FakeServer, fakeServer, type Route, spOk } from './market.testing.js';
import {
  fetchRows,
  loadStatusMap,
  request,
  SP_ITEM_INFO,
  SP_ITEM_LIST,
  SP_MODEL_LIST,
  SP_ORDER_DETAIL,
  SP_ORDER_LIST,
} from './market-api.js';
import { findAlerts, golden, loadMapping, type Mapping } from './market-csv.js';

// Dịch phần DB thật của tests/test_market_csv.py + tests/test_market_api.py (+ login svc_loader của
// tests/test_v14_p2_service_auth.py, cổng loader của tests/test_v15_p12_policies.py). Một DB test riêng
// từ mẫu (golden 13 SKU đã nạp) — KHÔNG BAO GIỜ DB `samsam`; mỗi ca xóa sạch 3 bảng market_* (như
// ROLLBACK cuối test của Python). Rollout ép `van_hanh` (conftest Python `_FORCE_MODE`).

const FIX = (n: string) => repoPath('tests', 'fixtures', 'market', n);
const LISTING = FIX('fixture_shopee_listing.csv');
const LISTING_FIXED = FIX('fixture_shopee_listing_fixed.csv');
const ADS = FIX('fixture_shopee_ads.csv');
const ORDER = FIX('fixture_shopee_order.csv');
const LISTING_KM = FIX('fixture_shopee_listing_km.csv');
const PII_RE = 'NGUOI (MUA|NHAN) GIA|nguoimuagia|090000000|DUONG GIA LAP|GHI CHU GIA|FAKEORDER';
const PII_JS = new RegExp(PII_RE);
const LISTING_HDR = 'Mã sản phẩm,Tên sản phẩm,SKU phân loại,Giá,Kho hàng,Trạng thái';
const CREDS: Env = {
  SHOPEE_PARTNER_ID: '1000001',
  SHOPEE_PARTNER_KEY: 'SPKEY_SECRET_XYZ',
  SHOPEE_SHOP_ID: '2000002',
  SHOPEE_ACCESS_TOKEN: 'SPTOKEN_SECRET_ABC',
  TIKTOK_APP_KEY: 'ttappkey01',
  TIKTOK_APP_SECRET: 'TTSECRET_SECRET_QQ',
  TIKTOK_SHOP_CIPHER: 'ROW_cipher01',
  TIKTOK_ACCESS_TOKEN: 'TTTOKEN_SECRET_WW',
};

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('market (DB)', () => {
  const name = testDbName('market');
  const loginName = `t_mkt_loader_${process.pid}`;
  let pool: Pool;
  let dsn = '';
  const TMP = mkdtempSync(join(tmpdir(), 'market-db-'));
  let servers: FakeServer[] = [];
  let out: string[] = [];

  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
  const counts = async () =>
    [
      Number(await one('select count(*) from market_snapshots')),
      Number(await one('select count(*) from market_rows')),
      Number(await one('select count(*) from market_alerts')),
    ] as const;
  const openAlerts = async () =>
    Object.fromEntries(
      (
        await pool.query(
          "select kind, severity, sku_key, item_id, detail from market_alerts where status = 'open'",
        )
      ).rows.map((r) => [r.kind, r]),
    );
  const alertState = async (ch: string) =>
    Object.fromEntries(
      (
        await pool.query(
          'select kind, status, closed_at is null as n from market_alerts where channel = $1',
          [ch],
        )
      ).rows.map((r) => [r.kind, [r.status, r.n]]),
    );
  const deps = (env: Env = { DATABASE_URL: dsn }): CmdDeps => ({
    env,
    log: (s) => out.push(s),
    err: (s) => out.push(s),
    openService: async () => createPool(dsn),
    jobRun: (async (
      _n: string,
      body: (r: { ok: boolean; detail: string | null }) => Promise<unknown>,
    ) => body({ ok: true, detail: null })) as CmdDeps['jobRun'],
  });
  /** Python `_run` → [rc, đã ghi snapshot mới (1/0)]. */
  const run = async (file: string, kind: string, channel = 'shopee'): Promise<[number, number]> => {
    const before = Number(await one('select count(*) from market_snapshots'));
    const rc = await marketCsvMain({ file, channel, kind }, deps());
    return [rc, Number(await one('select count(*) from market_snapshots')) - before];
  };
  let nf = 0;
  const write = (fname: string, text: string | Buffer) => {
    const p = join(TMP, `${nf++}-${fname}`);
    writeFileSync(p, text);
    return p;
  };

  beforeAll(async () => {
    dsn = await createDbFromTemplate(name);
    pool = createPool(dsn);
    wireCore(pool);
  });
  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    out = [];
    await pool.query(
      'truncate market_alerts, market_rows, market_snapshots restart identity cascade',
    );
  });
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers = [];
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
    await adminQuery(`drop role if exists ${loginName}`).catch(() => {});
    resetOpsDeps();
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  it('nạp idempotent theo sha256, nhầm kênh/loại → exit 1 0 ghi, đơn không PII + map golden', async () => {
    expect(await run(LISTING, 'listing')).toEqual([0, 1]);
    const c1 = await counts();
    expect(c1.slice(0, 2)).toEqual([1, 5]);
    out = [];
    expect(await run(LISTING, 'listing')).toEqual([0, 0]);
    expect(out.join('\n')).toContain('[skip] file đã nạp');
    expect(await counts()).toEqual(c1);
    expect(await run(LISTING, 'ads', 'tiktok')).toEqual([1, 0]);
    expect(await counts()).toEqual(c1);
    expect(await run(ORDER, 'order')).toEqual([0, 1]);
    const sid = await one("select id from market_snapshots where export_kind = 'order'");
    expect(
      (
        await pool.query(
          'select count(*)::int a, count(order_id_hash)::int b from market_rows where snapshot_id = $1',
          [sid],
        )
      ).rows[0],
    ).toEqual({ a: 4, b: 4 });
    expect(
      Number(
        await one('select count(*) from market_rows where raw::text ~* $1 or title ~* $1', [
          PII_RE,
        ]),
      ),
    ).toBe(0);
    expect(out.join('\n')).not.toMatch(PII_JS);
    const mapped = Object.fromEntries(
      (
        await pool.query(
          "select item_id, sku_key from market_rows r join market_snapshots s on s.id = r.snapshot_id where s.export_kind = 'listing'",
        )
      ).rows.map((r) => [r.item_id, r.sku_key]),
    );
    expect(mapped).toEqual({
      '27357883504': 'savina-12v',
      '24325987926': 'savigout-30v',
      '27325048614': 'ruou-sam-chai-thuy-tinh-500ml',
      '99900000001': null,
      '54916394790': 'mat-ong-sam-120ml-1hu',
    });
  });

  it('4 loại cảnh báo: mở → nạp lại skip → export đã sửa đóng đúng 2 → lỗi tái phát mở lại; golden không đổi', async () => {
    const goldenState = async () =>
      (
        await pool.query(
          'select count(*)::int n, max(id)::text mx, (count(*) filter (where approved_by is not null))::int appr,' +
            ' sum(price_vnd)::text total, (select count(*)::int from sku_master) skus from price_list',
        )
      ).rows[0];
    const before = await goldenState();
    expect([before.appr, before.skus]).toEqual([0, 13]);
    for (const [p, k] of [
      [LISTING, 'listing'],
      [ADS, 'ads'],
      [ORDER, 'order'],
    ] as const) {
      expect(await run(p, k)).toEqual([0, 1]);
    }
    let alerts = await openAlerts();
    expect(new Set(Object.keys(alerts))).toEqual(
      new Set(['alcohol_listed', 'price_mismatch', 'tpbvsk_ads_no_xnqc', 'item_unmapped']),
    );
    expect((await counts())[2]).toBe(4);
    expect([alerts.alcohol_listed.severity, alerts.alcohol_listed.sku_key]).toEqual([
      'S1',
      'ruou-sam-chai-thuy-tinh-500ml',
    ]);
    const pm = alerts.price_mismatch;
    expect([pm.severity, pm.sku_key, pm.item_id]).toEqual(['S2', 'savigout-30v', '24325987926']);
    expect([
      pm.detail.price_san,
      pm.detail.price_golden,
      pm.detail.golden_approved,
      pm.detail.approved_by,
    ]).toEqual([482900, 439000, false, null]);
    expect(pm.detail.golden_note).toContain('CHƯA duyệt');
    expect(Object.keys(pm.detail).some((k) => k.includes('de_xuat') || k.includes('suggest'))).toBe(
      false,
    );
    expect([alerts.tpbvsk_ads_no_xnqc.severity, alerts.tpbvsk_ads_no_xnqc.sku_key]).toEqual([
      'S1',
      'saphraton-20v',
    ]);
    expect(alerts.tpbvsk_ads_no_xnqc.detail.ads_spend_vnd).toBe(250000);
    expect([
      alerts.item_unmapped.severity,
      alerts.item_unmapped.sku_key,
      alerts.item_unmapped.item_id,
    ]).toEqual(['S2', null, '99900000001']);
    // nạp lại cả 3 → skip, vẫn 4, không nhân đôi
    const c = await counts();
    for (const [p, k] of [
      [LISTING, 'listing'],
      [ADS, 'ads'],
      [ORDER, 'order'],
    ] as const) {
      expect(await run(p, k)).toEqual([0, 0]);
    }
    expect(await counts()).toEqual(c);
    // export kế tiếp đã sửa → đóng đúng 2
    expect(await run(LISTING_FIXED, 'listing')).toEqual([0, 1]);
    const closed = Object.fromEntries(
      (
        await pool.query(
          "select kind, closed_at is not null c from market_alerts where status = 'closed'",
        )
      ).rows.map((r) => [r.kind, r.c]),
    );
    expect(closed).toEqual({ alcohol_listed: true, price_mismatch: true });
    alerts = await openAlerts();
    expect(new Set(Object.keys(alerts))).toEqual(new Set(['tpbvsk_ads_no_xnqc', 'item_unmapped']));
    // lỗi xuất hiện lại (bytes khác) → mở lại, không thêm dòng (theo ĐỢT: opened_at mới)
    const again = write(
      'listing_again.csv',
      Buffer.concat([readFileSync(LISTING), Buffer.from('\n')]),
    );
    expect(await run(again, 'listing')).toEqual([0, 1]);
    expect(Object.keys(await openAlerts())).toHaveLength(4);
    expect(
      (await pool.query('select count(*)::int n, count(closed_at)::int c from market_alerts'))
        .rows[0],
    ).toEqual({ n: 4, c: 0 });
    expect(await goldenState()).toEqual(before);
  });

  it('listing 1 phần: cảnh báo VẮNG mặt giữ mở (vắng ≠ đã sửa); có mặt + hết lỗi mới đóng', async () => {
    expect(await run(LISTING, 'listing')).toEqual([0, 1]);
    const before = await alertState('shopee');
    expect(new Set(Object.keys(before))).toEqual(
      new Set(['alcohol_listed', 'price_mismatch', 'item_unmapped']),
    );
    out = [];
    const savina = readFileSync(LISTING, 'utf8').split(/\r?\n/).slice(0, 2);
    expect(await run(write('partial.csv', `${savina.join('\n')}\n`), 'listing')).toEqual([0, 1]);
    expect(await alertState('shopee')).toEqual(before);
    for (const v of Object.values(before)) expect(v).toEqual(['open', true]);
    const text = out.join('\n');
    expect(text).toContain('[warn] 3 cảnh báo shopee/listing không thấy item trong file');
    expect(text).toContain('closed=0');
    const fixed = readFileSync(LISTING_FIXED, 'utf8').split(/\r?\n/);
    expect(
      await run(write('partial2.csv', `${[fixed[0], fixed[3]].join('\n')}\n`), 'listing'),
    ).toEqual([0, 1]);
    const st = await alertState('shopee');
    expect(st.alcohol_listed).toEqual(['closed', false]);
    expect(st.price_mismatch).toEqual(['open', true]);
    expect(st.item_unmapped).toEqual(['open', true]);
  });

  it('kênh khác (cùng item_id) không bao giờ đóng cảnh báo Shopee', async () => {
    for (const [p, k] of [
      [LISTING, 'listing'],
      [ADS, 'ads'],
    ] as const) {
      expect(await run(p, k)).toEqual([0, 1]);
    }
    const shopee = await alertState('shopee');
    expect(Object.keys(shopee)).toHaveLength(4);
    const m = (loadMapping()[0] as Mapping).tiktok as Record<
      string,
      { required: Record<string, string> }
    >;
    const lst = (m.listing as { required: Record<string, string> }).required;
    expect(
      await run(
        write(
          'tt_listing.csv',
          `${[lst.item_id, lst.title, lst.price, lst.status].join(',')}\n27325048614,X,1,Live\n24325987926,Y,1,Live\n99900000001,Z,1,Live\n`,
        ),
        'listing',
        'tiktok',
      ),
    ).toEqual([0, 1]);
    const ads = (m.ads as { required: Record<string, string> }).required;
    expect(
      await run(
        write(
          'tt_ads.csv',
          `${[ads.item_id, ads.title, ads.ads_spend].join(',')}\n24825885894,QC,0\n`,
        ),
        'ads',
        'tiktok',
      ),
    ).toEqual([0, 1]);
    expect(await alertState('shopee')).toEqual(shopee);
    for (const v of Object.values(shopee)) expect(v).toEqual(['open', true]);
  });

  it('item chung 2 biến thể không có SKU → item_unmapped kèm ứng viên (agent không tự chọn)', async () => {
    expect(
      await run(
        write('honey.csv', `${LISTING_HDR}\n54916394790,Mật ong,,745000,1,Đang hoạt động\n`),
        'listing',
      ),
    ).toEqual([0, 1]);
    const alerts = await openAlerts();
    expect(Object.keys(alerts)).toEqual(['item_unmapped']);
    expect(alerts.item_unmapped.detail.candidates).toEqual([
      'mat-ong-sam-120ml-1hu',
      'mat-ong-sam-120ml-2hu',
    ]);
  });

  it('--report: S1 trước S2, thiếu file ads, đơn hủy riêng, không PII/hash, không ghi', async () => {
    await run(LISTING, 'listing');
    out = [];
    expect(await marketCsvMain({ report: true }, deps())).toBe(0);
    expect(out.join('\n')).toContain('shopee: không đủ dữ liệu quảng cáo');
    await run(ADS, 'ads');
    await run(ORDER, 'order');
    const c = await counts();
    out = [];
    expect(await marketCsvMain({ report: true }, deps())).toBe(0);
    expect(await counts()).toEqual(c);
    const text = out.join('\n');
    const lines = out.filter((l) => /^ {2}\[S[12]\]/.test(l));
    expect(lines).toHaveLength(4);
    const sev = lines.map((l) => l.slice(3, 5));
    expect(sev).toEqual([...sev].sort());
    expect(sev.filter((s) => s === 'S1')).toHaveLength(2);
    expect(text).not.toContain('không đủ dữ liệu quảng cáo');
    expect(text).toContain('hủy=1 đơn');
    expect(text).not.toMatch(PII_JS);
    const hashes = (
      await pool.query('select order_id_hash h from market_rows where order_id_hash is not null')
    ).rows.map((r) => r.h as string);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(text).not.toContain(h);
  });

  it('sale_price / voucher_code chỉ nằm trong raw (không cột riêng)', async () => {
    expect(await run(LISTING_KM, 'listing')).toEqual([0, 1]);
    const got = Object.fromEntries(
      (await pool.query("select item_id, raw->>'sale_price' sp from market_rows")).rows.map((r) => [
        r.item_id,
        r.sp,
      ]),
    );
    expect(got).toEqual({ '27357883504': '120000', '29007947088': '1290000', '24325987926': null });
    const hdr =
      'Mã đơn hàng,Trạng thái đơn hàng,Tên sản phẩm,SKU phân loại hàng,Số lượng,Giá ưu đãi,Mã giảm giá của Shop';
    expect(
      await run(write('o.csv', `${hdr}\nO1,Hoàn thành,A,savina-12v,1,100,SSABCDEFGH23\n`), 'order'),
    ).toEqual([0, 1]);
    expect(
      await one("select raw->>'voucher_code' from market_rows where export_kind = 'order'"),
    ).toBe('SSABCDEFGH23');
    expect(
      Number(
        await one(
          "select count(*) from information_schema.columns where column_name in ('sale_price', 'voucher_code')",
        ),
      ),
    ).toBe(0);
  });

  it('cổng loader THẬT (rollout tắt, chính sách chưa cấu hình) → [rollout] exit 2, 0 snapshot', async () => {
    settings.forceMode = 'tat';
    expect(await run(LISTING, 'listing')).toEqual([2, 0]);
    expect(out.join('\n')).toMatch(/\[rollout\] loader market_csv: .*KHÔNG nạp \(HĐ 6\.7\)/);
    expect((await counts())[0]).toBe(0);
  });

  it('nạp song song cùng file → đúng 1 snapshot, lượt kia [skip]', async () => {
    const [a, b] = await Promise.all([
      marketCsvMain({ file: LISTING, channel: 'shopee', kind: 'listing' }, deps()),
      marketCsvMain({ file: LISTING, channel: 'shopee', kind: 'listing' }, deps()),
    ]);
    expect([a, b]).toEqual([0, 0]);
    expect((await counts())[0]).toBe(1);
    expect(out.filter((l) => l.startsWith('[load]'))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('[skip]'))).toHaveLength(1);
  });

  it('chế độ thực: login riêng `in role svc_loader` nạp được, không xóa được', async () => {
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`drop role if exists ${loginName}`);
    await adminQuery(
      `create role ${loginName} login password '${pw}' nosuperuser nocreatedb nocreaterole in role svc_loader`,
    );
    const u = new URL(dsn);
    u.username = loginName;
    u.password = pw;
    const env: Env = { AUTH_MODE: 'local', NODE_ENV: 'test', LOADER_DATABASE_URL: u.toString() };
    const rc = await marketCsvMain(
      { file: ORDER, channel: 'shopee', kind: 'order' },
      { ...deps(env), openService: undefined },
    );
    expect(rc, out.join('\n')).toBe(0);
    expect((await counts())[0]).toBe(1);
    // owner/superuser ở chế độ thực → từ chối (exit 2)
    out = [];
    const rc2 = await marketCsvMain(
      { file: LISTING, channel: 'shopee', kind: 'listing' },
      {
        ...deps({ AUTH_MODE: 'local', NODE_ENV: 'test', LOADER_DATABASE_URL: dsn }),
        openService: undefined,
      },
    );
    expect(rc2).toBe(2);
    expect(out[0]).toMatch(/SUPERUSER|CHỦ SỞ HỮU/);
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      await expect(c.query('delete from market_rows')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });

  // ---------------------------------------------------------------- API sàn → cùng staging

  const item = (iid: number, nm: string, price: number, status = 'NORMAL') => ({
    item_id: iid,
    item_name: nm,
    item_sku: '',
    item_status: status,
    has_model: false,
    price_info: [{ current_price: price, original_price: price }],
    stock_info_v2: { summary_info: { total_available_stock: 5 } },
  });
  const listingRoute =
    (items: ReturnType<typeof item>[]): Route =>
    (_m, p, q) => {
      if (p === SP_ITEM_LIST) {
        return spOk({ item: items.map((i) => ({ item_id: i.item_id })), has_next_page: false });
      }
      if (p === SP_ITEM_INFO) {
        const want = (q.item_id_list?.[0] ?? '').split(',');
        return spOk({ item_list: items.filter((i) => want.includes(String(i.item_id))) });
      }
      if (p === SP_MODEL_LIST) return spOk({ model: [] });
      throw new Error(p);
    };
  const apiDeps = (base: string) =>
    deps({ ...CREDS, DATABASE_URL: dsn, SHOPEE_API_BASE: base, TIKTOK_API_BASE: base });

  it('API listing: cùng cảnh báo như find_alerts thuần; dữ liệu không đổi → skip; ẩn rượu → đóng', async () => {
    const items = [
      item(27357883504, 'Savina tuýp 12 viên ngậm (FIXTURE)', 159000),
      item(24325987926, 'Savigout 30 viên (FIXTURE)', 482900),
      item(27325048614, 'Rượu sâm chai thủy tinh 500ml (FIXTURE)', 745000),
      item(99900000001, 'Sản phẩm lạ không có trong golden (FIXTURE)', 100000),
    ];
    const s = await fakeServer(listingRoute(items));
    servers.push(s);
    const o = { channel: 'shopee', kind: 'listing' };
    expect(await marketApiMain(o, apiDeps(s.url))).toBe(0);
    const snaps = (await pool.query('select id, file_name, row_count from market_snapshots')).rows;
    expect(snaps).toHaveLength(1);
    expect(snaps[0].file_name).toMatch(/^api:shopee:listing:\d{8}T\d{4}$/);
    expect(snaps[0].row_count).toBe(4);
    const open = (
      await pool.query(
        "select kind, coalesce(item_id, '') i, coalesce(seller_sku, '') s from market_alerts where status = 'open'",
      )
    ).rows.map((r) => JSON.stringify([r.kind, r.i, r.s]));
    expect(new Set(open.map((k) => JSON.parse(k)[0]))).toEqual(
      new Set(['alcohol_listed', 'price_mismatch', 'item_unmapped']),
    );
    const rows = await fetchRows(
      'shopee',
      'listing',
      (m, p, params, body) =>
        request('shopee', m, p, params, body ?? null, { creds: CREDS as never, base: s.url }),
      loadStatusMap(),
    );
    const [skus, prices] = await golden(pool, 'shopee');
    const inactive = (
      (loadMapping()[0] as Mapping).shopee as Record<string, { inactive_status: string[] }>
    ).listing?.inactive_status as string[];
    expect(new Set(open)).toEqual(
      new Set(findAlerts(rows, 'shopee', 'listing', skus, prices, inactive).keys()),
    );
    expect(out.some((l) => l.startsWith('[load]'))).toBe(true);
    expect(out.some((l) => l.startsWith('[alerts]'))).toBe(true);
    const c = await counts();
    out = [];
    expect(await marketApiMain(o, apiDeps(s.url))).toBe(0);
    expect(out.join('\n')).toContain('[skip] dữ liệu không đổi');
    expect(await counts()).toEqual(c);
    (items[2] as { item_status: string }).item_status = 'UNLIST';
    expect(await marketApiMain(o, apiDeps(s.url))).toBe(0);
    expect(await one("select status from market_alerts where kind = 'alcohol_listed'")).toBe(
      'closed',
    );
    expect(new Set(Object.keys(await openAlerts()))).toEqual(
      new Set(['price_mismatch', 'item_unmapped']),
    );
  });

  it('API đơn: không PII ở rows/snapshot, không cảnh báo; báo cáo v3.3 tách đơn hủy', async () => {
    const it0 = {
      item_id: 24325987926,
      item_name: 'Savigout 30 viên',
      item_sku: 'savigout-30v',
      model_sku: '',
      model_quantity_purchased: 1,
      model_discounted_price: 439000,
    };
    const orders: [string, string][] = [
      ['FAKEORDER1', 'CANCELLED'],
      ['FAKEORDER2', 'COMPLETED'],
    ];
    const s = await fakeServer((_m, p) => {
      if (p === SP_ORDER_LIST)
        return spOk({ order_list: orders.map((o) => ({ order_sn: o[0] })), more: false });
      if (p === SP_ORDER_DETAIL) {
        return spOk({
          order_list: orders.map(([sn, st]) => ({
            order_sn: sn,
            order_status: st,
            item_list: [it0],
            buyer_username: 'nguoimuagia',
            recipient_address: { name: 'NGUOI MUA GIA', phone: '0900000000' },
          })),
        });
      }
      throw new Error(p);
    });
    servers.push(s);
    expect(
      await marketApiMain({ channel: 'shopee', kind: 'order', days: '3' }, apiDeps(s.url)),
    ).toBe(0);
    expect(
      (await pool.query('select count(*)::int a, count(order_id_hash)::int b from market_rows'))
        .rows[0],
    ).toEqual({
      a: 2,
      b: 2,
    });
    expect(
      Number(
        await one('select count(*) from market_rows r where r::text ~* $1 or raw::text ~* $1', [
          PII_RE,
        ]),
      ),
    ).toBe(0);
    expect(
      Number(await one('select count(*) from market_snapshots s where s::text ~* $1', [PII_RE])),
    ).toBe(0);
    expect(Number(await one('select count(*) from market_alerts'))).toBe(0);
    expect(out.join('\n')).not.toMatch(PII_JS);
    out = [];
    expect(await marketCsvMain({ report: true }, deps())).toBe(0);
    const rep = out.join('\n');
    expect(rep).toContain('shopee đơn: hủy=1 đơn');
    expect(rep).toContain('Đã hủy=1');
    expect(rep).not.toMatch(PII_JS);
  });
});
