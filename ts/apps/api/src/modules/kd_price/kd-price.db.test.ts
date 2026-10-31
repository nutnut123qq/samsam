import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { loadConfig } from '@samsam/core/ops/director';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { RolloutBlocked, settings } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { section } from '../sales_director/sales-watch.js';
import { type ComboCfg, submit as comboSubmit, propose } from './combo-price.js';
import { loadDealerObs, readDealerFile } from './dealer-price.js';
import {
  type CogsVersion,
  enqueueNew,
  type GoldenPrices,
  key2,
  loadMapping,
  ratio,
  seenIds,
} from './deps.js';
import { type CmdDeps, dealerPriceMain, kdPriceMain } from './kd-price.command.js';
import {
  AGENT,
  dealerItem,
  type Finding,
  financeItems,
  JOB,
  loadWatch,
  mergePlan,
  readPlan,
  renderReport,
  SEVERITY,
  toItems,
  type Watch,
} from './kd-price.js';
import {
  analyze,
  dealerFindings,
  dealerWatch,
  enqueueFinance,
  internalPromos,
} from './kd-price.service.js';
import { loadCalendar } from './mkt-calendar.js';

// Dịch phần DB của tests/test_kd_price.py, tests/test_contract_c08_promo_loss.py,
// tests/test_contract_c09_combo_price.py, sales-06.1 của tests/test_v14_p4_sales.py. Mỗi ca một DB
// riêng `samsam_ts_kd_price` dựng lại từ DB mẫu (như schema tạm + ROLLBACK của Python) — KHÔNG BAO GIỜ
// DB `samsam`. Rollout ép `van_hanh` (như conftest Python `_FORCE_MODE`), ca cổng TẮT ép `tat`.

const NAME = 'samsam_ts_kd_price';
const TODAY = '2026-10-12';
const PLAN = repoPath('tests', 'fixtures', 'kd_price', 'promo_plan_MAU.csv');
const WATCH = loadWatch(repoPath('data', 'price_watch.json'))[0] as Watch;
const NET = { shopee: ratio('0.85'), tiktok: ratio('0.85') };
const CAL = loadCalendar();
const CFG = loadConfig('sales');
const MAPPING = loadMapping()[0];
const COMPETITOR = 77777;
const COMP_STR = ['77.777', '77777'];
const RUOU_TITLE = 'Rượu sâm X chai 500ml (GIẢ LẬP)';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('kd_price (DB)', () => {
  let pool: Pool;
  let dsn = '';
  const TMP = tmp('kdp-db-');

  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0])[0];
  /** Nhiều câu trong 1 giao dịch; `replica` = bỏ trigger append-only để dựng thẳng trạng thái (như
   * fixture Python `session_replication_role = replica`). */
  async function tx(fn: (c: PoolClient) => Promise<void>, replica = false): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (replica) await c.query('set local session_replication_role = replica');
      await fn(c);
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  /** Chạy `fn` bằng role dịch vụ (Python `set local role`). */
  async function asRole<T>(role: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query(`set role ${role}`);
      return await fn(c);
    } finally {
      await c.query('reset role');
      c.release();
    }
  }

  beforeAll(() => {
    settings.forceMode = 'van_hanh';
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
    resetOpsDeps();
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ KD-A5 (seed như tests/test_kd_listing)

  const SKUS: [string, string, string, boolean | null, string[]][] = [
    ['sam-a', 'tpbvsk', 'approved', null, ['shopee', 'tiktok']],
    ['sam-b', 'food', 'none', true, ['shopee']],
    ['sam-c', 'tpbvsk', 'none', null, ['shopee']],
    ['sam-e', 'tpbvsk', 'approved', null, ['shopee']],
    ['sam-f', 'tpbvsk', 'approved', null, ['tiktok']],
    ['sam-g', 'food', 'none', true, ['shopee']],
    ['ruou-x', 'alcohol', 'none', null, ['shopee']],
  ];
  const PRICES: [string, string, string, number, boolean][] = [
    ['sam-a', 'shopee', 'list', 200000, true],
    ['sam-a', 'shopee', 'floor', 150000, true],
    ['sam-a', 'tiktok', 'list', 200000, true],
    ['sam-a', 'tiktok', 'floor', 150000, true],
    ['sam-b', 'shopee', 'list', 100000, true],
    ['sam-b', 'shopee', 'floor', 80000, true],
    ['sam-c', 'shopee', 'list', 300000, true],
    ['sam-c', 'shopee', 'floor', 250000, false],
    ['sam-g', 'shopee', 'list', 200000, true],
    ['sam-g', 'shopee', 'floor', 100000, true],
    ['ruou-x', 'shopee', 'list', 500000, true],
    ['ruou-x', 'shopee', 'floor', 400000, true],
  ];
  const LISTING: [string, string | null, string, number, string | null, number | null][] = [
    ['1001', 'sam-a', '  sâm a   HỘP 30 viên ', 210000, 'Đang hoạt động', 140000],
    ['1002', 'sam-b', 'Mật ong B khuyến mãi', 90000, 'Đang hoạt động', null],
    ['1003', 'sam-c', 'Sâm C', 315001, 'Đang hoạt động', null],
    ['1004', 'ruou-x', RUOU_TITLE, 500000, 'Đang hoạt động', null],
    ['1005', 'sam-e', 'Sâm E', 100000, 'Đã ẩn', null],
    ['1006', 'sam-f', 'Sâm F', 100000, null, null],
    ['1007', null, 'Hàng lạ', 5000, 'Đang hoạt động', null],
    ['1008', 'sam-g', 'Sâm G', 200000, 'Đang hoạt động', 110000],
  ];

  async function seedPrice(): Promise<{ mismatch: number }> {
    let mismatch = 0;
    await tx(async (c) => {
      for (const [k, cat, x, sd, allowed] of SKUS) {
        await c.query(
          "insert into sku_master (sku_key, name, category, xnqc_status, self_declaration_ok, allowed_channels, source) values ($1, $2, $3, $4, $5, $6, 'manual')",
          [k, `Tên ${k}`, cat, x, sd, allowed],
        );
      }
      for (const [k, ch, kind, p, ok] of PRICES) {
        const id = (
          await c.query(
            "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, $2, $3, $4, '2026-01-01') returning id",
            [k, ch, kind, p],
          )
        ).rows[0].id;
        if (ok)
          await c.query(
            "update price_list set approved_by = 'GĐ (test)', approved_at = now() where id = $1",
            [id],
          );
      }
      const sid = (
        await c.query(
          "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'listing', 'l.csv', md5(random()::text), $1) returning id",
          [LISTING.length],
        )
      ).rows[0].id;
      for (const [n, [iid, sku, title, price, st, sale]] of LISTING.entries()) {
        await c.query(
          "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, price_vnd, status, raw) values ($1, $2, 'shopee', 'listing', $3, $4, $5, $6, $7, $8)",
          [
            sid,
            n + 2,
            iid,
            sku,
            title,
            price,
            st,
            JSON.stringify({ item_id: iid, price, sale_price: sale }),
          ],
        );
      }
      await c.query(
        "insert into market_alerts (kind, severity, channel, export_kind, item_id, sku_key, detail) values ('alcohol_listed', 'S1', 'shopee', 'listing', '1004', 'ruou-x', '{}')",
      );
      mismatch = Number(
        (
          await c.query(
            "insert into market_alerts (kind, severity, channel, export_kind, item_id, sku_key, detail) values ('price_mismatch', 'S2', 'shopee', 'listing', '1003', 'sam-c', '{}') returning id",
          )
        ).rows[0].id,
      );
      for (const [sku, cost, ok] of [
        ['sam-b', 90000, true],
        ['sam-c', 100000, false],
      ] as const) {
        const cid = (
          await c.query(
            "insert into cogs_versions (sku_key, cost_vnd, valid_from, created_by) values ($1, $2, '2026-01-01', 'KT (test)') returning id",
            [sku, cost],
          )
        ).rows[0].id;
        if (ok) {
          await c.query(
            "update cogs_versions set approved_by = 'GĐ tài chính (test)', approved_at = now() where id = $1",
            [cid],
          );
        }
      }
      const imp = (
        await c.query(
          "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('competitor', 'dt.csv', md5(random()::text), 1) returning id",
        )
      ).rows[0].id;
      await c.query(
        "insert into competitor_observations (import_id, row_no, competitor, channel, product_name, sku_key, price_vnd, promo_price_vnd, observed_on, source_ref) values ($1, 2, 'Đối thủ X', 'shopee', 'Sâm A loại khác', 'sam-a', $2, $3, '2026-10-10', 'ảnh chụp dt.png')",
        [imp, COMPETITOR, COMPETITOR - 7],
      );
    });
    return { mismatch };
  }

  const plan = () => readPlan(PLAN, WATCH.promo_kinds, CAL)[0];
  const q = async () =>
    (
      await pool.query(
        "select object_type, object_id, block, status, risk, decided_by, guardrail->>'ok' as gok, title, payload from approval_queue where object_id like 'a5:%' order by id",
      )
    ).rows;

  it('analyze → đẩy hàng duyệt idempotent, không tự duyệt, giá đối thủ chỉ ở báo cáo', async () => {
    const ids = await seedPrice();
    const p = plan();
    const priceBefore = await one('select count(*)::int from price_list');
    const res = await analyze(pool, MAPPING, WATCH, NET, TODAY, p);
    const lk = res.listing
      .filter((f) => f.severity !== 'INFO')
      .map((f) => [f.kind, f.item_id])
      .sort();
    expect(lk).toEqual(
      [
        ['below_floor', '1001'],
        ['list_deviation', '1002'],
        ['negative_margin', '1002'],
        ['list_deviation', '1003'],
        ['listing_promo_over_cap', '1008'],
      ].sort(),
    );
    expect(res.listing.filter((f) => f.dup_alert).map((f) => [f.item_id, f.dup_alert])).toEqual([
      ['1003', ids.mismatch],
    ]);
    expect(new Set(res.listing.filter((f) => f.severity === 'INFO').map((f) => f.sku_key))).toEqual(
      new Set(['sam-a', 'sam-c', 'sam-g']),
    );
    expect(res.competitor.map((r) => r[3])).toEqual([COMPETITOR]);
    // SKU nhóm CAM (rượu) trong giá đối thủ: không in sku_key ra báo cáo
    await tx(async (c) => {
      const imp = (
        await c.query(
          "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('competitor', 'r.csv', md5(random()::text), 1) returning id",
        )
      ).rows[0].id;
      await c.query(
        "insert into competitor_observations (import_id, row_no, competitor, channel, product_name, sku_key, price_vnd, observed_on, source_ref) values ($1, 2, 'Đối thủ Y', 'shopee', 'r', 'ruou-x', 500000, '2026-10-10', 'r.png')",
        [imp],
      );
    });
    const comp = (await analyze(pool, MAPPING, WATCH, NET, TODAY, p)).competitor;
    expect(comp.map((r) => r[0] ?? '').sort()).toEqual(['', 'sam-a']);
    const rep = renderReport({ ...res, competitor: comp }, WATCH, TODAY, p, null);
    expect(rep).not.toContain('ruou');
    expect(rep).toContain('(nhóm CAM)');
    const items = toItems([...res.listing, ...res.promo], CFG);
    const n = await enqueueNew(pool, items, CFG, await seenIds(pool, 'a5'), AGENT);
    // C08: "không tính được biên" = INFO → không vào hàng sales (chỉ finance)
    expect([n, items.length]).toEqual([13, 13]);
    const rows = await q();
    expect(rows.length).toBe(13);
    for (const r of rows) {
      expect([r.block, r.status, r.risk, r.decided_by, r.gok], r.object_id).toEqual([
        'sales',
        'pending',
        'high',
        null,
        'true',
      ]);
      expect(['market_alert_s1', 'price_change', 'promo_change']).toContain(r.object_type);
      for (const s of COMP_STR) {
        expect(r.payload).not.toContain(s);
        expect(r.title).not.toContain(s);
      }
      expect(r.payload).not.toContain('ruou');
      expect(r.payload).not.toContain(RUOU_TITLE);
    }
    expect(rows.filter((r) => r.object_id.includes(':1003:'))).toEqual([]); // trùng v3.3
    expect(
      new Set(rows.filter((r) => /KM1111-[DE]/.test(r.object_id)).map((r) => r.object_type)),
    ).toEqual(new Set(['market_alert_s1']));
    expect(
      await one(
        "select count(*)::int from approval_queue where object_id like 'a5:%' and lane is not null",
      ),
    ).toBe(0);
    // Lần 2 cùng dữ liệu → 0 mục mới.
    const res2 = await analyze(pool, MAPPING, WATCH, NET, TODAY, p);
    expect(
      await enqueueNew(
        pool,
        toItems([...res2.listing, ...res2.promo], CFG),
        CFG,
        await seenIds(pool, 'a5'),
        AGENT,
      ),
    ).toBe(0);
    // Giá golden/sàn không bị đụng.
    expect(await one('select count(*)::int from price_list')).toBe(priceBefore);
    expect(await one('select count(*)::int from market_alerts')).toBe(2);
  });

  function cli(extra: Partial<CmdDeps> = {}) {
    const out: string[] = [];
    const errs: string[] = [];
    const jobs: string[] = [];
    const d: CmdDeps = {
      log: (s) => out.push(s),
      err: (s) => errs.push(s),
      connect: async () => ({ db: pool, release: async () => {} }),
      openService: async () => createPool(dsn),
      wire: null,
      jobRun: (async (n: string, body: (r: { ok: boolean; detail: null }) => Promise<number>) => {
        jobs.push(n);
        return body({ ok: true, detail: null });
      }) as never,
      ...extra,
    };
    return { d, out, errs, jobs };
  }

  it('CLI --run --dry-run không ghi; --run (không kế hoạch) ghi qua job_runs', async () => {
    await seedPrice();
    const tables = [
      'approval_queue',
      'price_list',
      'market_alerts',
      'sku_master',
      'cogs_versions',
      'job_runs',
    ];
    const counts = async () =>
      Promise.all(tables.map((t) => one(`select count(*)::int from ${t}`)));
    const before = await counts();
    const c = cli();
    expect(
      await kdPriceMain({ run: true, dryRun: true, plan: PLAN, asOf: '2026-10-12' }, c.d),
    ).toBe(0);
    expect(await counts()).toEqual(before);
    expect(c.out.join('\n')).toContain('[dry-run] sẽ đẩy 13 mục mới');
    expect(c.jobs).toEqual([]);
    for (const s of COMP_STR) expect(c.out.join('\n')).not.toContain(s);
    const k = cli();
    expect(await kdPriceMain({ run: true }, k.d)).toBe(0);
    expect(k.jobs).toEqual([JOB]);
    expect(k.out.join('\n')).toContain('[info] chưa có kế hoạch KM');
    expect(k.out.join('\n')).toContain('[run] đẩy 4 mục mới');
  });

  it('CLI --run khi sales-06.1 TẮT → không sinh mục nào, exit 1 (Python: RolloutBlocked lọt khỏi _main)', async () => {
    await seedPrice();
    settings.forceMode = 'tat';
    const c = cli();
    expect(await kdPriceMain({ run: true }, c.d)).toBe(1);
    expect(c.jobs).toEqual([JOB]);
    expect(c.errs.join('\n')).toMatch(/^\[error\] .*tắt.* — không sinh đầu ra/);
    expect(await one('select count(*)::int from approval_queue')).toBe(0);
  });

  it('CLI --report: nhãn cửa sổ theo --as-of, S1 trước S2, đối thủ chỉ ở mục tham khảo', async () => {
    await seedPrice();
    for (const asOf of ['2026-10-12', '2026-11-12']) {
      const c = cli();
      expect(await kdPriceMain({ report: true, plan: PLAN, asOf, outDir: TMP }, c.d)).toBe(0);
      expect(c.jobs).toEqual([]);
    }
    const a = readFileSync(join(TMP, 'price-watch-2026-10-12.md'), 'utf8');
    const b = readFileSync(join(TMP, 'price-watch-2026-11-12.md'), 'utf8');
    expect(a).toContain('dự kiến T-29');
    expect(a).not.toContain('đang chạy');
    expect(b).toContain('đang chạy');
    expect(b).toContain('dự kiến T-30');
    expect(b).not.toContain('T-29');
    expect(a.indexOf('## S1')).toBeLessThan(a.indexOf('## S2'));
    expect(a).toContain('| 11.11 | 11/11/2026 | 5 | 11 |'); // C08: +2 biên
    expect(a).toContain('Tham khảo đối thủ (KHÔNG dùng để đề xuất giá)');
    expect(a).toContain('77.777 đ');
    const head = a.split('## Tham khảo đối thủ')[0] as string;
    for (const s of COMP_STR) expect(head).not.toContain(s);
    expect(a).not.toContain('ruou');
    expect(a).not.toContain(RUOU_TITLE);
  });

  // ------------------------------------------------------------ C08 KM lỗ (finance-04.2)

  it('C08: KM nội bộ CHỈ đã duyệt + còn hiệu lực; trùng với CSV giữ dòng CSV', async () => {
    await tx(async (c) => {
      await c.query(
        "insert into sku_master (sku_key, name, category, source) values ('c8-a', 'A', 'food', 'manual'), ('c8-b', 'B', 'food', 'manual')",
      );
    });
    await tx(async (c) => {
      for (const [sku, pr, pid, vf, vt, by] of [
        ['c8-a', 50000, 'P-A', '2026-10-15', null, 'GĐ BH'],
        ['c8-b', 60000, null, '2026-10-01', null, 'GĐ BH'],
        ['c8-b', 10000, 'P-CHUA', '2026-10-01', null, null],
        ['c8-b', 10000, 'P-HET', '2026-09-01', '2026-10-10', 'GĐ BH'],
      ]) {
        await c.query(
          "insert into price_list (sku_key, channel, kind, price_vnd, program_id, valid_from, valid_to, approved_by) values ($1, 'shopee', 'promo', $2, $3, $4, $5, $6)",
          [sku, pr, pid, vf, vt, by],
        );
      }
    }, true);
    const rows = await internalPromos(pool, '2026-10-20', 45);
    const got = rows.map((r) => [r.sku_key, r.program_id, r.price] as const).sort();
    expect(got[0]).toEqual(['c8-a', 'P-A', 50000]);
    expect(got[1]?.[0]).toBe('c8-b');
    expect(got[1]?.[1].startsWith('PL-')).toBe(true);
    expect(got.length).toBe(2); // chưa duyệt / hết hạn bị bỏ
    const csvRow = { ...(rows[0] as (typeof rows)[0]), price: 1, source: 'csv' };
    expect(
      mergePlan([csvRow], rows)
        .filter((r) => r.program_id === 'P-A')
        .map((r) => r.source),
    ).toEqual(['csv']);
  });

  it('C08: KM lỗ/không tính được biên → mục khối finance, không đẩy lặp', async () => {
    const f = (kind: string, oid: string): Finding => ({
      kind,
      severity: SEVERITY[kind] as string,
      channel: 'shopee',
      item_id: null,
      seller_sku: null,
      sku_key: 'c8-a',
      object_id: oid,
      program_ids: ['P-A'],
      cam: false,
      label: 'đang chạy',
      evidence: {
        program_ids: ['P-A'],
        list: 100000,
        floor: 40000,
        after: 50000,
        has_cogs: false,
        has_net_ratio: true,
      },
    });
    const fs = [f('promo_margin_unknown', 'a5:x:1'), f('promo_over_cap', 'a5:x:2')];
    expect(financeItems(fs).map((i) => i.object_id)).toEqual(['fin:a5:x:1']);
    expect(await enqueueFinance(pool, fs)).toBe(1);
    expect(await enqueueFinance(pool, fs)).toBe(0);
    const row = (
      await pool.query('select block, object_type, created_by, status from approval_queue')
    ).rows;
    expect(row).toEqual([
      {
        block: 'finance',
        object_type: 'promo_loss',
        created_by: 'agent:kd_price',
        status: 'pending',
      },
    ]);
  });

  // ------------------------------------------------------------ sales-06.1 giá đại lý

  const DP = section('dealer_price');
  const HDR = 'kenh,ma_dai_ly,sku_key,gia_vnd,ngay,url_nguon\n';
  const DTODAY = '2026-10-14';
  const OBS =
    'shopee,DL-01,sam-a,950000,2026-10-13,https://shopee.vn/dl1/a\n' +
    'shopee,DL-01,sam-b,520000,2026-10-13,https://shopee.vn/dl1/b\n' +
    'cua_hang,DL-02,sam-b,440000,2026-10-12,https://dl2.example.vn/b\n' +
    'web,DL-02,ruou-x,250000,2026-10-12,https://dl2.example.vn/r\n' +
    'tiktok,DL-02,sam-a,10,2026-10-12,https://tiktok.com/x\n' +
    'shopee,DL-02,sam-c,1,2026-10-12,https://shopee.vn/c\n';
  const csv = (body: string, name = 'gia.csv') => {
    const p = join(TMP, name);
    writeFileSync(p, HDR + body, 'utf8');
    return p;
  };
  const read = (p: string) =>
    readDealerFile(p, DP.channels as string[], DP.max_rows as number, DTODAY);

  async function golden(): Promise<void> {
    await tx(async (c) => {
      await c.query(
        "insert into sku_master (sku_key, name, category, source) values ('sam-a', 'Sâm A', 'food', 'manual'), ('sam-b', 'Sâm B', 'food', 'manual'), ('ruou-x', 'Rượu X', 'alcohol', 'manual'), ('sam-c', 'Sâm C', 'food', 'manual')",
      );
      await c.query(
        "insert into dealers (code, name, region, source) values ('DL-01', 'Đại lý 1', 'MIEN_TRUNG', 'manual'), ('DL-02', 'Đại lý 2', 'MIEN_TRUNG', 'manual')",
      );
    });
    // Giá đã duyệt: dựng thẳng trạng thái (bỏ trigger append-only) như fixture Python.
    await tx(async (c) => {
      for (const [sku, ch, price, by] of [
        ['sam-a', 'shopee', 1_000_000, 'Lan'],
        ['sam-a', 'web', 800_000, null],
        ['sam-b', 'shopee', 500_000, 'Lan'],
        ['sam-b', 'web', 450_000, 'Lan'],
        ['ruou-x', 'web', 300_000, 'Lan'],
      ]) {
        await c.query(
          "insert into price_list (sku_key, channel, kind, price_vnd, valid_from, approved_by) values ($1, $2, 'floor', $3, '2026-01-01', $4)",
          [sku, ch, price, by],
        );
      }
    }, true);
  }
  const load = async (body = OBS, name = 'obs.csv', source = 'manual_export') => {
    const [rows, errs, sha] = read(csv(body, name));
    expect(errs).toEqual([]);
    return asRole('svc_loader', (c) => loadDealerObs(c, rows, sha as string, 'Lan', source));
  };

  it('sales-06.1 nạp: kiểm toàn file theo sổ, idempotent theo sha, append-only', async () => {
    await golden();
    const [rows, errs, sha] = read(
      csv(`${OBS}shopee,DL-99,sam-a,1,2026-10-12,https://a.vn/z\n`, 'bad.csv'),
    );
    expect([errs, rows.length]).toEqual([[], 7]); // file đúng mẫu, sai sổ
    await expect(
      asRole('svc_loader', (c) => loadDealerObs(c, rows, sha as string, 'Lan')),
    ).rejects.toThrow(/dòng 8/);
    expect(await one('select count(*)::int from dealer_price_obs')).toBe(0);
    expect(await load()).toEqual({ inserted: 6, skipped_file: false });
    expect(await load()).toEqual({ inserted: 0, skipped_file: true });
    await expect(loadDealerObs(pool, rows, '0'.repeat(64), 'agent:x')).rejects.toThrow(/NGƯỜI/);
    await expect(pool.query('update dealer_price_obs set price_vnd = 1')).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(pool.query('delete from dealer_price_obs')).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('sales-06.1 phát hiện: floor cùng kênh / cửa hàng → floor thấp nhất; mẫu bị loại; payload không tên/đường dẫn', async () => {
    await golden();
    await load();
    await load('shopee,DL-02,sam-a,1,2026-10-12,https://s.vn/m\n', 'mau.csv', 'sample');
    const r = await asRole('svc_job', (c) =>
      dealerFindings(c, DTODAY, DP as { lookback_days: number }),
    );
    const got = Object.fromEntries(r.findings.map((f) => [f.object_id, f]));
    expect(new Set(Object.keys(got))).toEqual(
      new Set([
        'dp:DL-01:sam-a:shopee:2026-10-13',
        'dp:DL-02:sam-b:cua_hang:2026-10-12',
        'dp:DL-02:ruou-x:web:2026-10-12',
      ]),
    );
    expect(got['dp:DL-02:sam-b:cua_hang:2026-10-12']?.floor).toBe(450_000);
    // tiktok sam-a: không có floor tiktok → không kiểm được; sam-c: không floor
    expect([r.unverifiable, r.checked]).toEqual([2, 6]);
    let it = dealerItem(got['dp:DL-02:ruou-x:web:2026-10-12'] as never, CFG);
    expect(it.payload).not.toContain('ruou');
    expect(it.payload).toContain('nhóm hạn chế');
    it = dealerItem(got['dp:DL-01:sam-a:shopee:2026-10-13'] as never, CFG);
    expect(it.payload).toContain('950.000');
    expect(it.payload).toContain('shopee.vn');
    expect(it.payload).not.toContain('/dl1/');
    expect(it.payload).not.toContain('Đại lý 1');
    expect(check(it.payload).ok).toBe(true);
    const late = await asRole('svc_job', (c) =>
      dealerFindings(c, '2026-12-01', DP as { lookback_days: number }),
    );
    expect(late.checked).toBe(0);
  });

  it('sales-06.1 đẩy hàng duyệt idempotent; cổng rollout TẮT → không sinh', async () => {
    await golden();
    await load();
    const dp = DP as { lookback_days: number };
    await asRole('svc_job', async (c) => {
      const r = await dealerWatch(c, DTODAY, CFG, dp, true);
      expect([r.new, r.enqueued]).toEqual([3, 0]);
      expect((await dealerWatch(c, DTODAY, CFG, dp)).enqueued).toBe(3);
      expect((await dealerWatch(c, DTODAY, CFG, dp)).enqueued).toBe(0);
    });
    const rows = (
      await pool.query(
        "select created_by from approval_queue where object_type = 'dealer_price_alert'",
      )
    ).rows;
    expect(new Set(rows.map((r) => r.created_by))).toEqual(new Set([AGENT]));
    settings.forceMode = 'tat';
    await expect(dealerWatch(pool, DTODAY, CFG, dp)).rejects.toBeInstanceOf(RolloutBlocked);
  });

  it('CLI dealer-price + kd-price --dealer-watch --dry-run', async () => {
    await golden();
    const p = csv(OBS);
    const c = cli({ clock: () => new Date('2026-10-14T03:00:00Z') });
    expect(await dealerPriceMain({ file: p, by: 'Lan' }, c.d)).toBe(0);
    expect(await dealerPriceMain({ file: p, by: 'Lan' }, c.d)).toBe(0);
    expect(await kdPriceMain({ dealerWatch: true, dryRun: true, asOf: '2026-10-14' }, c.d)).toBe(0);
    const out = c.out.join('\n');
    expect(out).toContain('[ok] nạp 6');
    expect(out).toContain('[skip]');
    expect(out).toContain('dưới giá sàn 3');
    expect(out).toContain('KHÔNG ghi DB');
    const bad = csv(OBS.replace('950000', 'x'), 'b.csv');
    expect(await dealerPriceMain({ file: bad, by: 'Lan' }, c.d)).toBe(1);
    settings.forceMode = 'tat';
    const k = cli({ clock: () => new Date('2026-10-14T03:00:00Z') });
    expect(
      await dealerPriceMain(
        { file: csv(OBS.replace('950000', '940000'), 'c.csv'), by: 'Lan' },
        k.d,
      ),
    ).toBe(2);
    expect(k.out.join('\n')).toContain('[rollout]');
    expect(await kdPriceMain({ dealerWatch: true, dryRun: true, asOf: '2026-10-14' }, k.d)).toBe(2);
    expect(k.errs.join('\n')).toContain('[rollout]');
  });

  // ------------------------------------------------------------ C09 giá combo (intel-05.2)

  it('C09: phương án combo → hàng duyệt intel, idempotent, mẫu đánh dấu is_sample; rollout TẮT → không sinh', async () => {
    await tx(async (c) => {
      await c.query(
        "insert into bom_combos (combo_key, name, channels, source) values ('CB1', 'Hộp quà', '{shopee}', 'sample')",
      );
      await c.query(
        "insert into bom_items (combo_key, sku_key, qty) values ('CB1', 'a', 1), ('CB1', 'b', 2)",
      );
    });
    const cell = (price: number, id: number) => ({ price, id, approved: true });
    const prices: GoldenPrices = new Map([
      [key2('a', 'shopee'), { list: cell(100000, 1), floor: cell(80000, 2) }],
      [key2('b', 'shopee'), { list: cell(50000, 3), floor: cell(40000, 4) }],
    ]);
    const cogs: CogsVersion[] = [
      { id: 1, sku_key: 'a', cost_vnd: 70000, valid_from: '2026-01-01', approved_by: 'GĐ TC' },
      { id: 2, sku_key: 'b', cost_vnd: 30000, valid_from: '2026-01-01', approved_by: 'GĐ TC' },
    ];
    const cfg: ComboCfg = {
      pcts: [5, 10, 40],
      step: 1000,
      channels: ['shopee'],
      status: 'GIẢ ĐỊNH',
      chot_boi: null,
    };
    const promotable = new Set([key2('a', 'shopee'), key2('b', 'shopee')]);
    const recs = await propose(
      pool,
      '2026-10-20',
      cfg,
      { shopee: ratio('0.85') },
      { prices, promotable, cogs },
    );
    expect(recs.map((r) => r.status)).toEqual(['de_xuat']);
    expect(check(recs[0]?.item?.payload ?? '').ok).toBe(true);
    expect(await comboSubmit(pool, recs)).toBe(1);
    expect(await comboSubmit(pool, recs)).toBe(0);
    const row = (
      await pool.query(
        'select block, object_type, created_by, is_sample, status from approval_queue',
      )
    ).rows;
    expect(row).toEqual([
      {
        block: 'intel',
        object_type: 'combo_price_option',
        created_by: 'agent:combo_price',
        is_sample: true,
        status: 'pending',
      },
    ]);
    settings.forceMode = 'tat';
    await expect(comboSubmit(pool, recs)).rejects.toBeInstanceOf(RolloutBlocked);
    // Không có giá list đã duyệt trong DB thật (mẫu) → thiếu dữ liệu, không bịa giá.
    settings.forceMode = 'van_hanh';
    const real = await propose(pool, '2026-10-20', cfg, null, { promotable });
    expect(real.map((r) => [r.status, r.why])).toEqual([
      ['thieu_du_lieu', 'thiếu giá list ĐÃ DUYỆT của a'],
    ]);
  });
});
