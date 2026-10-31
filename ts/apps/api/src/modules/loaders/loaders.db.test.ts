import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath, DATA_DIR as REPO_DATA } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRows,
  collectRows,
  type Domain,
  dropSampleGarden,
  iterJsonl,
  keptPlots,
  plotLogRow,
  plotRow,
  type Row,
  SourceError,
  sampleGardenPurged,
} from './core-store.js';
import {
  applyDiscrepancies,
  approvePrice,
  CHANNELS,
  type Doc,
  load,
  readGolden,
  validate,
} from './golden-store.js';
import { type CmdDeps, coreStoreMain, goldenStoreMain } from './loaders.command.js';

// Dịch phần DB thật của tests/test_core_store.py + tests/test_v15_p11_core_store.py (P11.1–P11.3),
// tests/test_garden_chain.py (loader giữ khoảnh đã chain/có ảnh), tests/test_garden_director.py
// (main sau/trước gỡ mẫu), tests/test_golden_store.py (DB + CLI), tests/test_v14_p2_service_auth.py
// (login svc_loader nạp được, không tự duyệt; đơn thật giữ khi nạp lại đơn mẫu; quyết định người
// chế độ thực bị chặn + authz_denied), tests/test_v15_p10_human_authz.py (approve_price_human theo
// login). KHÔNG BAO GIỜ DB `samsam`: DB riêng từ mẫu (đã có core_store + golden_store do Python nạp).
// Ca thường: 1 giao dịch → ROLLBACK cuối ca (như schema tạm + rollback của Python); bảng làm sạch
// bằng superuser `session_replication_role = replica` trong giao dịch đó. Ca CLI (commit thật): DB
// riêng thứ hai. Rollout ép `van_hanh` (conftest Python `_FORCE_MODE`).

const SRC = 'products.jsonl';
const CORE_TABLES = [
  'product_sync_log',
  'order_history',
  'assets',
  'claims_approved',
  'orders',
  'plot_logs',
  'garden_media',
  'plots',
  'products',
];
const GOLDEN_TABLES = ['golden_discrepancies', 'price_list', 'sku_map', 'sku_master', 'products'];
const TODAY = "(now() at time zone 'Asia/Ho_Chi_Minh')::date";
const goldenDoc = (): Doc => readGolden(dataPath('golden_skus.json'))[0] as Doc;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const prod = (pid: string, name: string, over: Record<string, unknown> = {}) => ({
  id: pid,
  name,
  price_vnd: 100000,
  description: `mô tả ${name}`,
  url: `http://x/vi/shops/${pid}.html`,
  images: [] as string[],
  ...over,
});
const P1 = prod('nv-p1', 'Sâm mẫu 1', { images: ['http://x/1.png'] });
const P2 = prod('nv-p2', 'Sâm mẫu 2');
const WL = {
  'sku-p1': {
    approved_claims: ['hỗ trợ bồi bổ'],
    source: 'http://x/vi/shops/nv-p1.html — trang SP',
  },
};

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('loaders (DB)', () => {
  const name = testDbName('loaders');
  const TMP = mkdtempSync(join(tmpdir(), 'loaders-db-'));
  let pool: Pool;
  let nDir = 0;

  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
    wireCore(pool);
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
    resetOpsDeps();
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  /** 1 giao dịch → ROLLBACK cuối ca. `wipe` = bảng sạch như schema tạm của Python. */
  async function tx(wipe: string[], fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (wipe.length) {
        await c.query('set local session_replication_role = replica');
        for (const t of wipe) await c.query(`delete from ${t}`);
        await c.query('set local session_replication_role = origin');
      }
      await fn(c);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  }
  const one = async (c: PoolClient, sql: string, args: unknown[] = []) =>
    Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
  const rowsOf = async (c: PoolClient, sql: string, args: unknown[] = []) =>
    (await c.query({ text: sql, values: args, rowMode: 'array' })).rows;
  /** Lỗi DB trong savepoint (giao dịch test sống tiếp) → thông điệp. */
  async function raises(c: PoolClient, sql: string, args: unknown[] = []): Promise<string> {
    await c.query('savepoint t');
    try {
      await c.query(sql, args);
    } catch (e) {
      await c.query('rollback to savepoint t');
      return (e as Error).message;
    }
    await c.query('release savepoint t');
    throw new Error(`không bị chặn: ${sql}`);
  }

  function writeData(prods: unknown[], wl: unknown = WL): string {
    const d = join(TMP, `d${nDir++}`, 'data');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'products.jsonl'), prods.map((p) => `${JSON.stringify(p)}\n`).join(''));
    writeFileSync(join(d, 'claims_whitelist.json'), JSON.stringify(wl));
    return d;
  }
  const loadDir = (c: PoolClient, d: string) =>
    applyRows(
      c,
      collectRows(d, () => {}),
    );
  const realOrder = (c: PoolClient, oid = 'shopee:MAU001', pid = 'nv-p1') =>
    c.query(
      "insert into orders (id, ts, channel, product_id, qty, total_vnd, status, source) values ($1, now(), 'shopee', $2, 1, 100000, 'done', 'market:shopee')",
      [oid, pid],
    );
  const pidOf = (c: PoolClient, oid = 'shopee:MAU001') =>
    one(c, 'select product_id from orders where id = $1', [oid]);
  const hist = async (c: PoolClient) => Number(await one(c, 'select count(*) from order_history'));
  const syncLog = (c: PoolClient, kind?: string) =>
    rowsOf(
      c,
      `select kind, product_id, detail from product_sync_log${kind ? ' where kind = $1' : ''} order by id`,
      kind ? [kind] : [],
    );

  // ------------------------------------------------------------ P11.1

  it('P11.1 nạp lại (1 lần + lặp) giữ liên kết đơn THẬT, không order_history, id/created_at giữ', async () => {
    await tx(CORE_TABLES, async (c) => {
      const d = writeData([P1, P2]);
      await loadDir(c, d);
      await realOrder(c);
      const created = await one(c, "select created_at::text from products where id = 'nv-p1'");
      for (let i = 0; i < 3; i++) {
        await loadDir(c, d);
        expect(await pidOf(c)).toBe('nv-p1');
        expect(await hist(c)).toBe(0);
      }
      expect(
        await rowsOf(
          c,
          "select created_at::text, retired_at, source from products where id = 'nv-p1'",
        ),
      ).toEqual([[created, null, SRC]]);
      expect(await syncLog(c)).toEqual([]); // nạp lại y nguyên → 0 sự kiện
      expect(await one(c, "select product_id from claims_approved where sku_key = 'sku-p1'")).toBe(
        'nv-p1',
      );
      expect(await one(c, "select product_id from assets where id = 'nv-p1#img0'")).toBe('nv-p1');
    });
  });

  it('P11.1 row nhập tay (claim/asset manual) trỏ sản phẩm loader quản — giữ link sau reload', async () => {
    await tx(CORE_TABLES, async (c) => {
      const d = writeData([P1, P2]);
      await loadDir(c, d);
      await c.query(
        "insert into claims_approved (sku_key, product_id, claim, source) values ('sku-tay', 'nv-p2', 'claim tay', 'manual')",
      );
      await c.query(
        "insert into assets (id, kind, product_id, source) values ('tay-1', 'image', 'nv-p2', 'manual')",
      );
      await loadDir(c, d);
      expect(await one(c, "select product_id from claims_approved where source = 'manual'")).toBe(
        'nv-p2',
      );
      expect(await one(c, "select product_id from assets where id = 'tay-1'")).toBe('nv-p2');
    });
  });

  // ------------------------------------------------------------ P11.2

  it('P11.2 sản phẩm đổi → cập nhật tại chỗ + 1 sự kiện changed (lặp không thêm)', async () => {
    await tx(CORE_TABLES, async (c) => {
      const d = writeData([P1, P2]);
      await loadDir(c, d);
      await realOrder(c);
      writeFileSync(
        join(d, 'products.jsonl'),
        [{ ...P1, name: 'Sâm mẫu 1 (mới)', price_vnd: 120000 }, P2]
          .map((p) => `${JSON.stringify(p)}\n`)
          .join(''),
      );
      const counts = await loadDir(c, d);
      expect([await pidOf(c), await hist(c)]).toEqual(['nv-p1', 0]);
      expect(
        await rowsOf(c, "select name, price_vnd::int from products where id = 'nv-p1'"),
      ).toEqual([['Sâm mẫu 1 (mới)', 120000]]);
      expect(await syncLog(c, 'changed')).toEqual([
        [
          'changed',
          'nv-p1',
          {
            name: { cu: 'Sâm mẫu 1', moi: 'Sâm mẫu 1 (mới)' },
            price_vnd: { cu: 100000, moi: 120000 },
          },
        ],
      ]);
      expect(counts.product_events?.map((e) => e[0])).toEqual(['changed']);
      await loadDir(c, d);
      expect(await syncLog(c)).toHaveLength(1);
    });
  });

  it('P11.2 sản phẩm biến mất → retired_at (không xóa), claim/asset/đơn giữ link; xuất hiện lại → reactivated', async () => {
    await tx(CORE_TABLES, async (c) => {
      const d = writeData([P1, P2]);
      await loadDir(c, d);
      await realOrder(c);
      await c.query(
        "insert into assets (id, kind, product_id, source) values ('tay-1', 'image', 'nv-p1', 'manual')",
      );
      // P1 biến mất; id mới cùng TÊN xuất hiện — chỉ là ứng viên, KHÔNG tự chuyển liên kết.
      const p1b = { ...P1, id: 'wc-p1-moi', url: 'http://x/en/product/sam-1/', images: [] };
      const write = (ps: unknown[]) =>
        writeFileSync(join(d, 'products.jsonl'), ps.map((p) => `${JSON.stringify(p)}\n`).join(''));
      write([P2, p1b]);
      const counts = await loadDir(c, d);
      expect([await pidOf(c), await hist(c)]).toEqual(['nv-p1', 0]);
      expect(await one(c, "select retired_at is not null from products where id = 'nv-p1'")).toBe(
        true,
      );
      expect(await one(c, "select product_id from assets where id = 'tay-1'")).toBe('nv-p1');
      // claim trỏ trang của P1 (đã retired) vẫn link về id cũ.
      expect(await one(c, "select product_id from claims_approved where sku_key = 'sku-p1'")).toBe(
        'nv-p1',
      );
      expect(await syncLog(c, 'retired')).toEqual([
        ['retired', 'nv-p1', { don_that: 1, ung_vien_thay_the: ['wc-p1-moi'] }],
      ]);
      expect(counts.product_events?.some(([k, p]) => k === 'retired' && p === 'nv-p1')).toBe(true);
      await loadDir(c, d);
      expect(await syncLog(c, 'retired')).toHaveLength(1);
      // golden chỉ thấy sản phẩm còn niêm yết.
      await applyDiscrepancies(c);
      expect(
        await rowsOf(c, "select 1 from golden_discrepancies where product_id = 'nv-p1'"),
      ).toEqual([]);
      write([P1, P2, p1b]);
      await loadDir(c, d);
      expect(await one(c, "select retired_at from products where id = 'nv-p1'")).toBeNull();
      const re = await syncLog(c, 'reactivated');
      expect(re.map((r) => r[1])).toEqual(['nv-p1']);
      // detail.retired_at = datetime.isoformat() của Python (giờ có offset, có 'T').
      expect((re[0]?.[2] as { retired_at?: string } | undefined)?.retired_at).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{6})?[+-]\d\d:\d\d$/,
      );
      expect([await pidOf(c), await hist(c)]).toEqual(['nv-p1', 0]);
    });
  });

  it('P11.2 id thuộc NGUỒN KHÁC (manual) → không đè, ambiguous ghi 1 lần', async () => {
    await tx(CORE_TABLES, async (c) => {
      await c.query(
        "insert into products (id, name, price_vnd, source) values ('nv-p2', 'SP nhập tay', 5, 'manual')",
      );
      await realOrder(c, 'shopee:MAU001', 'nv-p2');
      const d = writeData([P1, P2]);
      for (let i = 0; i < 2; i++) await loadDir(c, d);
      expect(
        await rowsOf(
          c,
          "select name, price_vnd::int, source, retired_at from products where id = 'nv-p2'",
        ),
      ).toEqual([['SP nhập tay', 5, 'manual', null]]);
      expect([await pidOf(c), await hist(c)]).toEqual(['nv-p2', 0]);
      expect(await syncLog(c, 'ambiguous')).toEqual([
        ['ambiguous', 'nv-p2', { ly_do: 'id_thuoc_nguon_khac', nguon_hien_tai: 'manual' }],
      ]);
    });
  });

  it('P11.2 product_sync_log append-only', async () => {
    await tx(CORE_TABLES, async (c) => {
      const d = writeData([P1]);
      await loadDir(c, d);
      writeFileSync(join(d, 'products.jsonl'), `${JSON.stringify(P2)}\n`);
      await loadDir(c, d);
      expect((await syncLog(c, 'retired')).length).toBeGreaterThan(0);
      for (const sql of [
        'delete from product_sync_log',
        "update product_sync_log set kind = 'changed'",
        'truncate product_sync_log',
      ]) {
        expect(await raises(c, sql)).toContain('append-only');
      }
    });
  });

  // ------------------------------------------------------------ P11.3

  it('P11.3 nguồn hỏng sau lần nạp tốt → không ghi gì, FK orders/claims/assets giữ nguyên', async () => {
    await tx(CORE_TABLES, async (c) => {
      await loadDir(c, writeData([P1, P2]));
      await realOrder(c);
      const snap = async () => [
        await rowsOf(c, 'select id, product_id from orders order by id'),
        await rowsOf(c, 'select sku_key, product_id from claims_approved order by 1'),
        await rowsOf(c, 'select id, product_id from assets order by id'),
        await rowsOf(c, 'select id, name from products order by id'),
      ];
      const before = await snap();
      expect(before[1]).toEqual([['sku-p1', 'nv-p1']]);
      const bad: Record<string, string | null> = {
        missing: null,
        empty: '',
        doc_only: '{"_doc": "chỉ comment"}\n',
        brace: '{}\n',
        corrupt: '{"id": "nv-p1", "name": "cắt cụt',
        not_object: '[1, 2]\n',
        no_name: '{"id": "nv-p1"}\n',
        dup_id: `${JSON.stringify(P1)}\n${JSON.stringify({ ...P1, name: 'khác' })}\n`,
      };
      for (const [k, body] of Object.entries(bad)) {
        const d = writeData([P1, P2]);
        if (body === null) rmSync(join(d, 'products.jsonl'));
        else writeFileSync(join(d, 'products.jsonl'), body);
        let doms: Domain[] | null = null;
        try {
          doms = collectRows(d, () => {});
        } catch (e) {
          expect(e, k).toBeInstanceOf(SourceError);
        }
        expect(doms, k).toBeNull();
        expect(await snap(), k).toEqual(before);
      }
      expect(await hist(c)).toBe(0);
      expect(await syncLog(c)).toEqual([]);
    });
  });

  it('đơn mẫu: core_store xóa/nạp lại theo source; đơn THẬT giữ, không order_history', async () => {
    await tx(CORE_TABLES, async (c) => {
      await c.query(
        "insert into orders (id, ts, channel, status, source) values ('shopee:aaaa', now(), 'shopee', 'new', 'market:shopee'), ('mau-1', now(), 'web', 'new', 'sample:sample_orders.jsonl')",
      );
      await applyRows(c, [
        [
          'orders',
          'sample:sample_orders.jsonl',
          [
            {
              id: 'mau-2',
              ts: '2026-10-01T00:00:00+07:00',
              channel: 'web',
              product_id: null,
              qty: 1,
              total_vnd: 10,
              status: 'new',
              note: null,
              source: 'sample:sample_orders.jsonl',
            },
          ],
        ],
      ]);
      expect((await rowsOf(c, 'select id from orders order by id')).flat()).toEqual([
        'mau-2',
        'shopee:aaaa',
      ]);
      expect(await hist(c)).toBe(0);
    });
  });

  // ------------------------------------------------------------ vườn (test_garden_chain)

  const S_PLOTS = 'sample:sample_plots.jsonl';
  const S_LOGS = 'sample:sample_plot_logs.jsonl';
  function sampleDomains(drop: string[] = [], treeCount?: number): Domain[] {
    const plots: Row[] = [];
    for (const r of iterJsonl(join(REPO_DATA, 'sample_plots.jsonl'))) {
      if (drop.includes(r.id as string)) continue;
      const row = plotRow(r, S_PLOTS);
      if (treeCount !== undefined && r.id === 'KV-A01') row.tree_count = treeCount;
      plots.push(row);
    }
    const logs = iterJsonl(join(REPO_DATA, 'sample_plot_logs.jsonl'))
      .filter((r) => !drop.includes(r.plot_id as string))
      .map((r) => plotLogRow(r, S_LOGS));
    return [
      ['plots', S_PLOTS, plots],
      ['plot_logs', S_LOGS, logs],
    ];
  }
  const countSrc = async (c: PoolClient, t: string, src: string) =>
    Number(await one(c, `select count(*) from ${t} where source = $1`, [src]));
  const chainedLog = (c: PoolClient, plot = 'KV-A01') =>
    c.query(
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ($1, '2026-10-10T08:00:00Z', 'tưới', 'thật', 'Bé', 'manual:garden') returning id, row_hash",
      [plot],
    );

  it('khoảnh còn nhật ký ĐÃ CHAIN: giữ + upsert tại chỗ, không nhân đôi mẫu, [keep]', async () => {
    await tx(CORE_TABLES, async (c) => {
      await applyRows(c, sampleDomains());
      const nLogs = await countSrc(c, 'plot_logs', S_LOGS);
      expect(nLogs).toBeGreaterThan(0);
      const { rows } = await chainedLog(c);
      const [lid, rh] = [rows[0].id, rows[0].row_hash];
      expect(rh).toMatch(/^[0-9a-f]{64}$/);
      await applyRows(c, sampleDomains([], 4242)); // không exception
      expect(
        await rowsOf(c, "select id, row_hash from plot_logs where source = 'manual:garden'"),
      ).toEqual([[lid, rh]]);
      expect(await one(c, "select tree_count from plots where id = 'KV-A01'")).toBe(4242);
      expect(await countSrc(c, 'plot_logs', S_LOGS)).toBe(nLogs);
      const doms = sampleDomains(['KV-A01']);
      await applyRows(c, doms);
      expect(await one(c, "select source from plots where id = 'KV-A01'")).toBe(S_PLOTS);
      expect(await keptPlots(c, doms)).toEqual([['KV-A01', 1, 0]]);
    });
  });

  it('không bao giờ đè khoảnh nhập tay (manual)', async () => {
    await tx(CORE_TABLES, async (c) => {
      await c.query("insert into plots (id, tree_count, source) values ('KV-A02', 7, 'manual')");
      await applyRows(c, sampleDomains());
      await applyRows(c, sampleDomains());
      expect(
        await rowsOf(c, "select source, tree_count, location from plots where id = 'KV-A02'"),
      ).toEqual([['manual', 7, null]]);
    });
  });

  it('khoảnh còn ảnh garden_media → giữ (không ForeignKeyViolation)', async () => {
    await tx(CORE_TABLES, async (c) => {
      await applyRows(c, sampleDomains());
      await c.query(
        "insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author) values ($1, 'jpg', 1, 'KV-B01', '2026-10-12', 'Bé')",
        ['b'.repeat(64)],
      );
      const doms = sampleDomains(['KV-B01']);
      await applyRows(c, doms);
      expect(await keptPlots(c, doms)).toEqual([['KV-B01', 0, 1]]);
    });
  });

  it('sample_garden_purged + drop_sample_garden; thiếu bảng agent_action_log → false, giao dịch sống', async () => {
    await tx([], async (c) => {
      expect(await sampleGardenPurged(c)).toBe(false);
      await c.query(
        "insert into agent_action_log (actor, action, object_type) values ('GĐ', 'garden_sample_purge', 'plots')",
      );
      expect(await sampleGardenPurged(c)).toBe(true);
      const doms = [
        ...sampleDomains(),
        ['orders', 'sample:sample_orders.jsonl', [{ id: 'x' }]],
      ] as Domain[];
      expect(dropSampleGarden(doms).map(([t]) => t)).toEqual(['orders']);
      const manual = [['plots', 'plots_that.jsonl', []]] as Domain[];
      expect(dropSampleGarden(manual)).toEqual(manual);
      await c.query('savepoint s');
      const empty = `t_empty_${process.pid}`;
      await c.query(`create schema ${empty}`);
      await c.query(`set local search_path to ${empty}, pg_temp`);
      expect(await sampleGardenPurged(c)).toBe(false);
      expect(await one(c, 'select 1')).toBe(1);
      await c.query('rollback to savepoint s');
    });
  });

  it('PARITY với Python: nạp data/ thật lên DB mẫu (Python đã nạp) → 0 sự kiện, mọi bảng y hệt', async () => {
    await tx([], async (c) => {
      const SNAP = [
        'select id, name, price_vnd::text, description, url, lang, source, retired_at from products order by id',
        'select sku_key, product_id, claim, source_ref, note, source from claims_approved order by 1, 2, 3, 4, 5, 6',
        'select id, location, area_m2::text, variety, tree_count, planted_year, status, source from plots order by id',
        'select plot_id, ts::text, activity, detail, author, source from plot_logs order by 1, 2, 3, 4, 5, 6',
        'select id, ts::text, channel, product_id, qty, total_vnd::text, status, note, source from orders order by id',
        'select id, kind, title, url, product_id, source from assets order by id',
      ];
      const snap = async () => {
        const all: unknown[][] = [];
        for (const q of SNAP) all.push(await rowsOf(c, q)); // tuần tự: 1 client
        return all;
      };
      const before = await snap();
      expect(before[0]?.length).toBeGreaterThanOrEqual(27);
      const counts = await applyRows(
        c,
        collectRows(REPO_DATA, () => {}),
      );
      expect(counts.product_events).toEqual([]);
      expect(await snap()).toEqual(before);
    });
  });

  // ------------------------------------------------------------ golden (DB)

  const goldenCounts = async (c: PoolClient) =>
    (
      await rowsOf(
        c,
        "select (select count(*) from sku_master where source = 'golden_skus.json')::int," +
          " (select count(*) from sku_map where source = 'golden_skus.json')::int," +
          " (select count(*) from price_list p join sku_master m using (sku_key) where m.source = 'golden_skus.json')::int",
      )
    )[0];
  const priceId = async (c: PoolClient, sku: string, kind = 'list', ch = 'shopee') =>
    BigInt(
      (await one(
        c,
        'select id from price_list where sku_key = $1 and channel = $2 and kind = $3 and valid_to is null',
        [sku, ch, kind],
      )) as string,
    );

  it('PARITY với Python: nạp lại golden lên DB mẫu (Python đã nạp) → 0 thay đổi, phiếu lệch y hệt', async () => {
    await tx([], async (c) => {
      const disc = () =>
        rowsOf(
          c,
          'select kind, sku_key, product_id, detail, status, updated_at::text from golden_discrepancies order by 1, 2, 3',
        );
      const before = await disc();
      const st = await load(c, goldenDoc());
      expect(st).toEqual({
        sku_changed: 0,
        map_changed: 0,
        price_inserted: 0,
        price_closed: 0,
        price_same: 34,
      });
      const counts = await applyDiscrepancies(c);
      expect(await disc()).toEqual(before);
      const want: Record<string, number> = {};
      for (const [kind] of before) want[kind as string] = (want[kind as string] ?? 0) + 1;
      expect(counts).toEqual(want);
    });
  });

  it('nạp idempotent (13/15/34), giữ row manual, SKU vắng khỏi file → giữ', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      const doc = goldenDoc();
      await load(c, doc);
      expect(await goldenCounts(c)).toEqual([13, 15, 34]);
      expect(await load(c, doc)).toEqual({
        sku_changed: 0,
        map_changed: 0,
        price_inserted: 0,
        price_closed: 0,
        price_same: 34,
      });
      expect(await goldenCounts(c)).toEqual([13, 15, 34]);
      expect(
        await one(c, "select max(version) from sku_master where source = 'golden_skus.json'"),
      ).toBe(1);
      await c.query(
        "update sku_master set source = 'manual', name = 'Tay sửa' where sku_key = 'savina-12v'",
      );
      await c.query(
        "update sku_map set source = 'manual', sku_key = 'saphraton-20v' where product_id = 'wc-2298'",
      );
      const st = await load(c, doc);
      expect([st.sku_changed, st.map_changed]).toEqual([0, 0]);
      expect(
        await rowsOf(c, "select name, source from sku_master where sku_key = 'savina-12v'"),
      ).toEqual([['Tay sửa', 'manual']]);
      expect(await one(c, "select sku_key from sku_map where product_id = 'wc-2298'")).toBe(
        'saphraton-20v',
      );
      await load(c, {
        skus: (doc.skus as { sku_key: string }[]).filter((s) => s.sku_key === 'sapentol-30v'),
      });
      expect(
        Number(await one(c, "select count(*) from sku_master where sku_key = 'da-an-sam-30v'")),
      ).toBe(1);
    });
  });

  it('đổi giá → đóng dòng cũ (valid_to hôm nay VN) + dòng mới chờ duyệt; dòng đã đóng không duyệt được', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      const doc = goldenDoc();
      await load(c, doc);
      const before = Number(await one(c, 'select count(*) from price_list'));
      const oldId = await priceId(c, 'savina-12v');
      const changed = clone(doc);
      const sav = (
        changed.skus as { sku_key: string; prices: Record<string, Record<string, number>> }[]
      ).find((s) => s.sku_key === 'savina-12v');
      (sav?.prices.shopee as Record<string, number>).list = 158000;
      expect(validate(changed)).toEqual([]);
      const st = await load(c, changed);
      expect([st.price_inserted, st.price_closed]).toEqual([1, 1]);
      expect(Number(await one(c, 'select count(*) from price_list'))).toBe(before + 1);
      expect(
        await rowsOf(
          c,
          `select valid_to = ${TODAY}, price_vnd::int from price_list where id = $1`,
          [String(oldId)],
        ),
      ).toEqual([[true, 159000]]);
      const newId = await priceId(c, 'savina-12v');
      expect(newId).not.toBe(oldId);
      expect(
        await rowsOf(c, 'select price_vnd::int, approved_by from price_list where id = $1', [
          String(newId),
        ]),
      ).toEqual([[158000, null]]);
      expect(await one(c, "select version from sku_master where sku_key = 'savina-12v'")).toBe(1);
      const [ok, msg] = await approvePrice(c, oldId, 'A');
      expect(ok).toBe(false);
      expect(msg).toMatch(/^id=\d+ đã đóng \(valid_to=\d{4}-\d\d-\d\d\)$/);
    });
  });

  it('sku_map: cùng sku_key giữ duyệt Sản xuất; map sang SKU khác → trigger xóa duyệt cũ', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      const doc = goldenDoc();
      await load(c, doc);
      await c.query(
        "update sku_map set approved_by = 'Sản xuất', note = 'ghi tay' where product_id = 'wc-2298'",
      );
      expect((await load(c, doc)).map_changed).toBe(1);
      expect(
        await rowsOf(c, "select sku_key, approved_by from sku_map where product_id = 'wc-2298'"),
      ).toEqual([['savina-12v', 'Sản xuất']]);
      const remap = clone(doc);
      for (const s of remap.skus as { sku_key: string; product_ids: string[] }[]) {
        if (s.sku_key === 'savina-12v')
          s.product_ids = s.product_ids.filter((p) => p !== 'wc-2298');
        else if (s.sku_key === 'saphraton-20v') s.product_ids.push('wc-2298');
      }
      expect(validate(remap)).toEqual([]);
      expect((await load(c, remap)).map_changed).toBe(1);
      expect(
        await rowsOf(c, "select sku_key, approved_by from sku_map where product_id = 'wc-2298'"),
      ).toEqual([['saphraton-20v', null]]);
    });
  });

  it('phiếu lệch: idempotent, detail theo từng nguồn; phiếu người đã resolved không mở lại', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      await c.query(
        "insert into products (id, name, price_vnd, source) values ('wc-2298', 'SAVINA TUÝP 12 VIÊN', 128000, 'test')",
      );
      await load(c, goldenDoc());
      const c1 = await applyDiscrepancies(c);
      const n1 = await one(c, 'select count(*) from golden_discrepancies');
      expect(await applyDiscrepancies(c)).toEqual(c1);
      expect(await one(c, 'select count(*) from golden_discrepancies')).toBe(n1);
      const detail = (await one(
        c,
        "select detail from golden_discrepancies where kind = 'price_mismatch' and sku_key = 'savina-12v' and product_id = 'wc-2298'",
      )) as { web: { price_vnd: number }; golden: { shopee: unknown } };
      expect(detail.web.price_vnd).toBe(128000);
      expect(detail.golden.shopee).toEqual({ floor: 128000, list: 159000, promo: 132000 });
      const missing = (
        await rowsOf(c, "select sku_key from golden_discrepancies where kind = 'missing_price'")
      ).flat();
      expect(missing).toEqual(
        expect.arrayContaining(['saphraton-40v', 'ruou-sam-binh-su-do-500ml']),
      );
      expect(
        Number(
          await one(
            c,
            "select count(*) from golden_discrepancies where kind = 'alcohol_online_listing'",
          ),
        ),
      ).toBeGreaterThanOrEqual(1);
      await c.query(
        "update golden_discrepancies set status = 'resolved', resolved_by = 'Pháp chế' where kind = 'missing_price' and sku_key = 'saphraton-40v'",
      );
      await load(c, goldenDoc());
      await applyDiscrepancies(c);
      expect(
        await rowsOf(
          c,
          "select status, resolved_by from golden_discrepancies where kind = 'missing_price' and sku_key = 'saphraton-40v'",
        ),
      ).toEqual([['resolved', 'Pháp chế']]);
    });
  });

  it('phiếu pending của loader hết điều kiện → xóa; phiếu người resolved + phiếu manual → giữ', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      const ticket = (kind: string, sku: string) =>
        rowsOf(
          c,
          'select status, resolved_by, source from golden_discrepancies where kind = $1 and sku_key = $2',
          [kind, sku],
        );
      await load(c, goldenDoc());
      await applyDiscrepancies(c);
      expect((await ticket('missing_price', 'saphraton-40v'))[0]?.[0]).toBe('pending');
      await c.query(
        "update golden_discrepancies set status = 'resolved', resolved_by = 'Pháp chế' where kind = 'missing_price' and sku_key = 'ruou-sam-binh-su-do-500ml'",
      );
      await c.query(
        "insert into golden_discrepancies (kind, sku_key, detail, source) values ('missing_price', 'zz-manual', '{}', 'manual')",
      );
      for (const [sku, prices] of [
        ['saphraton-40v', { list: 600000, promo: 500000 }],
        ['ruou-sam-binh-su-do-500ml', { floor: 500000, list: 700000, promo: 600000 }],
      ] as const) {
        for (const [kind, price] of Object.entries(prices)) {
          await c.query(
            `insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, 'shopee', $2, $3, ${TODAY})`,
            [sku, kind, price],
          );
        }
      }
      await applyDiscrepancies(c);
      expect(await ticket('missing_price', 'saphraton-40v')).toEqual([]);
      expect(await ticket('missing_price', 'ruou-sam-binh-su-do-500ml')).toEqual([
        ['resolved', 'Pháp chế', 'golden_store'],
      ]);
      expect(await ticket('missing_price', 'zz-manual')).toEqual([['pending', null, 'manual']]);
    });
  });

  it('v_promotable cần NGƯỜI duyệt giá + readiness; duyệt lại / id lạ bị từ chối', async () => {
    await tx(GOLDEN_TABLES, async (c) => {
      const promotable = () =>
        rowsOf(c, 'select sku_key, channel, readiness from v_promotable order by 1, 2');
      const readiness = async (sku: string) =>
        Object.fromEntries(
          await rowsOf(c, 'select channel, readiness from sku_readiness where sku_key = $1', [sku]),
        );
      await load(c, goldenDoc());
      expect(await promotable()).toEqual([]);
      let [ok, msg] = await approvePrice(
        c,
        await priceId(c, 'mat-ong-sam-120ml-1hu'),
        'Người duyệt test',
      );
      expect(ok, msg).toBe(true);
      expect(msg).toMatch(/^đã duyệt id=\d+ mat-ong-sam-120ml-1hu shopee list 745000 VND$/);
      expect((await readiness('mat-ong-sam-120ml-1hu')).shopee).toBe('CAM');
      expect(await promotable()).toEqual([]);
      await c.query(
        "update sku_master set self_declaration_ok = true where sku_key = 'mat-ong-sam-120ml-1hu'",
      );
      expect(await promotable()).toEqual([['mat-ong-sam-120ml-1hu', 'shopee', 'TP_THUONG']]);
      [ok, msg] = await approvePrice(c, await priceId(c, 'mat-ong-sam-120ml-1hu'), 'B');
      expect([ok, msg.includes('đã được duyệt')]).toEqual([false, true]);
      expect((await approvePrice(c, await priceId(c, 'savina-12v'), 'A'))[0]).toBe(true);
      const r = await readiness('savina-12v');
      expect([r.shopee, r.tiktok]).toEqual(['MO_TA', 'CAM']);
      await c.query("update sku_master set xnqc_status = 'approved' where sku_key = 'savina-12v'");
      expect((await promotable()).map((p) => p.join('|'))).toContain('savina-12v|shopee|QC_DAY_DU');
      // Rượu: mọi kênh được phép + giá duyệt → vẫn CAM mọi kênh.
      await c.query(
        "update sku_master set allowed_channels = $1 where sku_key = 'ruou-sam-chai-thuy-tinh-500ml'",
        [CHANNELS],
      );
      expect(
        (await approvePrice(c, await priceId(c, 'ruou-sam-chai-thuy-tinh-500ml'), 'A'))[0],
      ).toBe(true);
      expect(new Set(Object.values(await readiness('ruou-sam-chai-thuy-tinh-500ml')))).toEqual(
        new Set(['CAM']),
      );
      expect(await approvePrice(c, -1n, 'A')).toEqual([false, 'không có dòng giá id=-1']);
      // id ngoài dải bigint: Python int → psycopg numeric → "không có dòng giá", không lỗi DB.
      expect(await approvePrice(c, 10n ** 20n, 'A')).toEqual([
        false,
        'không có dòng giá id=100000000000000000000',
      ]);
    });
  });
});

// ---------------------------------------------------------------- CLI (commit thật, DB riêng)

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('loaders CLI (DB)', () => {
  const name = testDbName('loaders_cli');
  const pid = process.pid;
  const LOADER = `t_ld_loader_${pid}`;
  const HUMAN = `t_ld_human_${pid}`;
  const pw = `p${Math.random().toString(36).slice(2)}`;
  let pool: Pool;
  let dsn = '';
  let out: string[] = [];
  let err: string[] = [];

  const loginDsn = (user: string) => {
    const u = new URL(dsn);
    u.username = user;
    u.password = pw;
    return u.toString();
  };
  const devEnv = (): Env => ({ NODE_ENV: 'test', DATABASE_URL: dsn });
  const deps = (env: Env = devEnv()): CmdDeps => ({
    env,
    log: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  const q = async (sql: string, args: unknown[] = []) =>
    (await pool.query({ text: sql, values: args, rowMode: 'array' })).rows;
  const n = async (sql: string, args: unknown[] = []) => Number((await q(sql, args))[0]?.[0]);

  beforeAll(async () => {
    dsn = await createDbFromTemplate(name);
    pool = createPool(dsn);
    wireCore(pool);
    settings.forceMode = 'van_hanh';
    for (const [role, grp] of [
      [LOADER, 'svc_loader'],
      [HUMAN, 'app_human'],
    ]) {
      await adminQuery(`drop role if exists ${role}`);
      await adminQuery(
        `create role ${role} login password '${pw}' nosuperuser nocreatedb nocreaterole in role ${grp}`,
      );
    }
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
    for (const role of [LOADER, HUMAN]) await adminQuery(`drop role if exists ${role}`);
    resetOpsDeps();
    settings.forceMode = null;
  });
  const reset = () => {
    out = [];
    err = [];
  };

  it('core-store: nạp lại data/ thật (dev) → 0 sự kiện, tổng bảng như cũ', async () => {
    reset();
    const before = await q(
      'select (select count(*) from products), (select count(*) from claims_approved), (select count(*) from assets), (select count(*) from orders)',
    );
    expect(await coreStoreMain(deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^\[load\] products: \d+ rows$/m);
    expect(text).not.toMatch(/^\[(changed|retired|reactivated|ambiguous)\]/m);
    expect(out.at(-1)).toMatch(
      /^\[done\] totals: products=\d+, claims_approved=\d+, plots=3, plot_logs=\d+, orders=\d+, assets=\d+$/,
    );
    expect(
      await q(
        'select (select count(*) from products), (select count(*) from claims_approved), (select count(*) from assets), (select count(*) from orders)',
      ),
    ).toEqual(before);
  });

  it('core-store chế độ thực bằng login riêng `in role svc_loader` → nạp được', async () => {
    reset();
    const env: Env = {
      NODE_ENV: 'test',
      APPROVAL_ENFORCE: '1',
      LOADER_DATABASE_URL: loginDsn(LOADER),
    };
    expect(await coreStoreMain(deps(env)), out.join('\n')).toBe(0);
    expect(out.at(-1)).toMatch(/^\[done\] totals: /);
  });

  it('core-store: khoảnh mẫu có nhật ký đã chain → [keep]; sau garden_sample_purge → [skip] mẫu vườn', async () => {
    reset();
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('KV-A01', '2026-10-10T08:00:00Z', 'tưới', 'thật', 'Bé', 'manual:garden')",
    );
    expect(await coreStoreMain(deps())).toBe(0);
    expect(out).toContain('[keep] plots: KV-A01 (1 nhật ký đã chain, 0 ảnh) — không xóa');
    expect(out.some((l) => l.startsWith('[skip]'))).toBe(false);
    expect(await n("select count(*) from plot_logs where source like 'sample:%'")).toBeGreaterThan(
      0,
    );
    reset();
    await pool.query(
      "insert into agent_action_log (actor, action, object_type) values ('GĐ', 'garden_sample_purge', 'plots')",
    );
    const ids = await q('select id from plot_logs order by id');
    // Không bỏ domain mẫu thì trigger `plot_logs_chain` raise 'đã được gỡ' → rollback cả lần nạp.
    expect(await coreStoreMain(deps())).toBe(0);
    expect(out.join('\n')).toContain('[skip] plots/plot_logs mẫu');
    expect(await q('select id from plot_logs order by id')).toEqual(ids);
    expect(out.at(-1)).toMatch(
      /^\[done\] totals: products=\d+, claims_approved=\d+, orders=\d+, assets=\d+$/,
    );
  });

  it('golden-store: nạp (dev) → price_same=34; duyệt giá; --report còn 33 chờ', async () => {
    reset();
    expect(await goldenStoreMain({}, deps())).toBe(0);
    expect(out).toContain(
      '[load] sku_changed=0, map_changed=0, price_inserted=0, price_closed=0, price_same=34',
    );
    expect(out.at(-1)).toMatch(
      /^\[done\] totals: sku_master=13, sku_map=15, price_list=34, golden_discrepancies=\d+$/,
    );
    const id = (
      await q(
        "select id from price_list where sku_key = 'mat-ong-sam-300ml' and channel = 'shopee' and kind = 'list' and valid_to is null",
      )
    )[0]?.[0] as string;
    reset();
    expect(await goldenStoreMain({ approvePrice: id, by: 'GĐ test' }, deps())).toBe(0);
    expect(
      await q('select approved_by, approved_at is not null from price_list where id = $1', [id]),
    ).toEqual([['GĐ test', true]]);
    expect(out.join('\n')).toMatch(/^\[done\] đã duyệt id=\d+ .* — người duyệt: GĐ test$/m);
    expect(err.join('\n')).toContain('[warn]'); // dev: cảnh báo DEV_WARNING
    reset();
    expect(await goldenStoreMain({ report: true }, deps())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('33 dòng giá chờ');
    expect(text).toMatch(/^ {2}#\d+ missing_price sku=saphraton-40v /m);
    const pending = [...text.matchAll(/^ {2}id=(\d+) /gm)].map((m) => m[1]);
    expect(pending).toHaveLength(33);
    expect(pending).not.toContain(id);
  });

  it('--approve-price chế độ thực: approvers rỗng → chặn trước khi ghi + authz_denied, exit 1', async () => {
    reset();
    const id = (
      await q('select min(id) from price_list where approved_by is null and valid_to is null')
    )[0]?.[0];
    const denied = () =>
      n(
        "select count(*) from agent_action_log where action = 'authz_denied' and object_type = 'price_list' and object_id = $1",
        [String(id)],
      );
    const before = await denied();
    const env: Env = { ...devEnv(), APPROVAL_ENFORCE: '1' };
    expect(await goldenStoreMain({ approvePrice: String(id), by: 'Ai Đó' }, deps(env))).toBe(1);
    expect(out.join('\n')).toContain('Bên B ủy quyền');
    expect(out.at(-1)).toMatch(/— không ghi\.$/);
    expect(await denied()).toBe(before + 1);
    expect(await q('select approved_by from price_list where id = $1', [String(id)])).toEqual([
      [null],
    ]);
  });

  it('--approve-price bằng login app_human chưa ánh xạ human_logins → DB từ chối (42501), không ghi', async () => {
    reset();
    const id = (
      await q('select min(id) from price_list where approved_by is null and valid_to is null')
    )[0]?.[0];
    const env: Env = { NODE_ENV: 'test', DATABASE_URL: loginDsn(HUMAN) };
    expect(await goldenStoreMain({ approvePrice: String(id), by: 'Nguyễn Duyệt' }, deps(env))).toBe(
      1,
    );
    expect(out.join('\n')).toMatch(/\[err\] DB từ chối: .*human_logins.* — không ghi\./);
    expect(await q('select approved_by from price_list where id = $1', [String(id)])).toEqual([
      [null],
    ]);
  });

  it('golden-store chế độ thực bằng login svc_loader: nạp được, KHÔNG tự duyệt giá/map/phiếu', async () => {
    reset();
    await pool.query(
      "insert into golden_discrepancies (kind, sku_key, detail, source) values ('price_mismatch', 'khong-con', '{}', 'golden_store')",
    );
    const env: Env = {
      NODE_ENV: 'test',
      APPROVAL_ENFORCE: '1',
      LOADER_DATABASE_URL: loginDsn(LOADER),
    };
    expect(await goldenStoreMain({}, deps(env)), out.join('\n')).toBe(0);
    // Phiếu pending hết điều kiện được loader dọn.
    expect(await n("select count(*) from golden_discrepancies where sku_key = 'khong-con'")).toBe(
      0,
    );
    const lp = createPool(loginDsn(LOADER));
    try {
      const open = (
        await q('select min(id) from price_list where approved_by is null and valid_to is null')
      )[0]?.[0];
      for (const [sql, args] of [
        ["update price_list set approved_by = 'svc', approved_at = now() where id = $1", [open]],
        ["update sku_map set approved_by = 'svc'", []],
        ["update golden_discrepancies set status = 'resolved', resolved_by = 'svc'", []],
      ] as [string, unknown[]][]) {
        await expect(lp.query(sql, args), sql).rejects.toThrow();
      }
    } finally {
      await lp.end();
    }
  });

  it('cổng loader THẬT (tính năng tắt, chính sách chưa cấu hình) → [rollout] exit 2, không ghi', async () => {
    reset();
    const before = await n('select count(*) from price_list');
    const doc = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8'));
    doc.skus[0].prices.shopee.list = 158000; // có thay đổi thật nếu lọt cổng
    const f = join(mkdtempSync(join(tmpdir(), 'loaders-gate-')), 'g.json');
    writeFileSync(f, JSON.stringify(doc));
    settings.forceMode = 'tat';
    try {
      expect(await goldenStoreMain({ file: f }, deps())).toBe(2);
    } finally {
      settings.forceMode = 'van_hanh';
    }
    expect(out.join('\n')).toMatch(/\[rollout\] loader golden_store: .*KHÔNG nạp \(HĐ 6\.7\)/);
    expect(await n('select count(*) from price_list')).toBe(before);
  });
});
