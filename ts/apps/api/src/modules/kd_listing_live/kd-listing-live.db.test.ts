import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { addDays, vnDate } from '@samsam/core/ops/period';
import { SOURCE_CLI, saveDraft, setStatus } from '@samsam/core/ops/store';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { check, readinessKey as key2 } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import C from './__fixtures__/content.golden.json' with { type: 'json' };
import { loadMapping } from './content-lite.js';
import * as kl from './kd-listing.js';
import {
  type CliDeps,
  kdListingMain,
  kdLiveMain,
  listingExportMain,
} from './kd-listing-live.command.js';
import * as kv from './kd-live.js';
import * as le from './listing-export.js';

// Dịch phần DB của tests/test_kd_listing.py, test_contract_c04_listing_export.py, test_kd_live.py.
// DB riêng `samsam_ts_kd_listing_live` tạo lại từ mẫu MỖI ca, xóa khi xong. KHÔNG BAO GIỜ DB `samsam`.
// Dữ liệu golden/listing/nháp/giá là GIẢ LẬP; LLM = gateway GIẢ tất định (0 mạng, 0 key thật).

const NAME = 'samsam_ts_kd_listing_live';
const [MAPPING] = loadMapping();
const TODAY = vnDate(new Date());

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, d: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('kd_listing_live (DB thật)', () => {
  let pool: pg.Pool;
  let dsn = '';
  const TMP = mkdtempSync(join(tmpdir(), 'klldb-'));
  let tmpN = 0;
  const outDir = () => join(TMP, `o${++tmpN}`);
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
  const n = async (sql: string, args: unknown[] = []) => Number(await one(sql, args));
  /** Như schema tạm Python (chưa nạp golden) — bỏ trigger bằng replica (superuser của DB test). */
  async function clearGolden() {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      for (const t of ['price_list', 'sku_map', 'golden_discrepancies', 'sku_master']) {
        await c.query(`delete from ${t}`);
      }
      await c.query('commit');
    } finally {
      c.release();
    }
  }
  /** Pool riêng cho lệnh CLI (lệnh tự `end()` pool khi xong). */
  const openNew: CliDeps['open'] = async () => createPool(dsn);

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

  // ============================================================ kd_listing

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
  const RUOU_TITLE = 'Rượu sâm X chai 500ml (GIẢ LẬP)';
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

  /** Golden + snapshot listing shopee + nháp đã duyệt + cảnh báo v3.3. */
  async function seed(): Promise<{ alcohol: number; mismatch: number }> {
    await clearGolden();
    for (const [k, cat, x, sd, allowed] of SKUS) {
      await q(
        "insert into sku_master (sku_key, name, category, xnqc_status, self_declaration_ok, allowed_channels, source) values ($1, $2, $3, $4, $5, $6, 'manual')",
        [k, `Tên ${k}`, cat, x, sd, allowed],
      );
    }
    for (const [k, ch, kind, p, ok] of PRICES) {
      const pid = await one(
        "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, $2, $3, $4, '2026-01-01') returning id",
        [k, ch, kind, p],
      );
      if (ok) {
        await q(
          "update price_list set approved_by = 'GĐ (test)', approved_at = now() where id = $1",
          [pid],
        );
      }
    }
    const sid = await one(
      "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'listing', 'l.csv', md5(random()::text), $1) returning id",
      [LISTING.length],
    );
    let rno = 2;
    for (const [iid, sku, title, price, st, sale] of LISTING) {
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, price_vnd, status, raw) values ($1, $2, 'shopee', 'listing', $3, $4, $5, $6, $7, $8)",
        [
          sid,
          rno++,
          iid,
          sku,
          title,
          price,
          st,
          JSON.stringify({ item_id: iid, price, sale_price: sale }),
        ],
      );
    }
    let i = 0;
    for (const [sku, text] of [
      [
        'sam-a',
        'Sâm A hộp 30 viên\n\nThông tin sản phẩm:\nGiá: 200.000 đ\nHạn sử dụng: Xem trên bao bì',
      ],
      ['sam-b', 'Mật ong B\nGiá: 90.000 đ'],
    ]) {
      await q(
        "insert into content_drafts (brief, channel, text, guardrail, status, reviewer, reviewed_at, source, content_type, sku, prompt_version) values ('listing', 'shopee', $1, '{}', 'approved', 'Pháp chế (test)', now(), 'cli', 'listing', $2, $3)",
        [text, sku, `v${i++}`],
      );
    }
    const alcohol = Number(
      await one(
        "insert into market_alerts (kind, severity, channel, export_kind, item_id, sku_key, detail) values ('alcohol_listed', 'S1', 'shopee', 'listing', '1004', 'ruou-x', '{}') returning id",
      ),
    );
    const mismatch = Number(
      await one(
        "insert into market_alerts (kind, severity, channel, export_kind, item_id, sku_key, detail) values ('price_mismatch', 'S2', 'shopee', 'listing', '1003', 'sam-c', '{}') returning id",
      ),
    );
    return { alcohol, mismatch };
  }

  const queue = () =>
    q(
      "select object_type, object_id, block, status, risk, decided_by, guardrail->>'ok' as gok, payload from approval_queue where object_id like 'a4:%' order by id",
    );

  it('listing đang chạy + nháp duyệt từ DB; snapshot mới thay snapshot cũ', async () => {
    await seed();
    let [rows, chans] = await kl.runningListings(pool, MAPPING);
    expect([...chans]).toEqual(['shopee']);
    expect(new Set(rows.map((r) => r.item_id))).toEqual(
      new Set(['1001', '1002', '1003', '1004', '1006', '1007', '1008']),
    );
    const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    expect([by['1001']?.sale_price, by['1002']?.sale_price]).toEqual([140000, null]);
    const d = await kl.approvedDrafts(pool);
    expect(d.get(key2('sam-a', 'shopee'))?.price).toBe(200000);
    expect(d.get(key2('sam-b', 'shopee'))?.title).toBe('Mật ong B');
    const sid = await one(
      "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', 'l2.csv', 'x2', 1, now() + interval '1 minute') returning id",
    );
    await q(
      "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, price_vnd, status, raw) values ($1, 2, 'shopee', 'listing', '2001', 'sam-a', 'x', 1, 'Đang hoạt động', '{}')",
      [sid],
    );
    [rows] = await kl.runningListings(pool, MAPPING);
    expect(rows.map((r) => r.item_id)).toEqual(['2001']);
  });

  it('CLI --run: đẩy mục mới idempotent (mọi status), bỏ mục trùng cảnh báo sàn, báo cáo', async () => {
    const ids = await seed();
    const jobs: string[] = [];
    const deps = (t: ReturnType<typeof cap>): CliDeps => ({
      ...t.d,
      open: openNew,
      jobRun: async (name, body) => {
        jobs.push(name);
        return body({ ok: true, detail: null });
      },
    });
    let t = cap();
    expect(await kdListingMain({ run: true }, deps(t))).toBe(0);
    expect(jobs).toEqual([kl.JOB]);
    const q1 = await queue();
    // 8 phát hiện − 1 trùng alcohol_listed đang mở = 7 mục.
    expect(q1).toHaveLength(7);
    for (const r of q1) {
      expect([r.block, r.status, r.risk, r.decided_by, r.gok], r.object_id).toEqual([
        'sales',
        'pending',
        'high',
        null,
        'true',
      ]);
      expect(['listing_sync', 'market_alert_s1']).toContain(r.object_type);
      expect(r.payload).not.toContain('ruou');
      expect(r.payload).not.toContain(RUOU_TITLE);
    }
    expect(q1.filter((r) => r.object_id.includes(':1004:'))).toEqual([]);
    expect(q1.filter((r) => r.object_type === 'market_alert_s1')).toHaveLength(1); // sam-f
    // Lần 2: 0 mục mới — kể cả mục đã bị từ chối (mọi status).
    const qid = await one('select id from approval_queue where object_id = $1', [q1[0]?.object_id]);
    const [ok, why] = await decide(pool, qid, 'GĐ bán hàng (test)', 'rejected');
    expect([ok, why]).toEqual([true, null]);
    t = cap();
    expect(await kdListingMain({ run: true }, deps(t))).toBe(0);
    expect(t.out.join('\n')).toContain('[run] đẩy 0 mục mới');
    expect(await queue()).toHaveLength(7);
    // Báo cáo: phát hiện trùng vẫn có, kèm số cảnh báo sàn.
    const od = outDir();
    t = cap();
    expect(await kdListingMain({ report: true, outDir: od }, deps(t))).toBe(0);
    const [rep] = readdirSync(od).filter((f) => /^catalog-sync-.*\.md$/.test(f));
    const text = readFileSync(join(od, rep as string), 'utf8');
    expect(text).toContain(`(đã có cảnh báo sàn #${ids.alcohol})`);
    expect(text).not.toContain('ruou');
    expect(text).not.toContain(RUOU_TITLE);
  });

  it('--run --dry-run: CHỈ ĐỌC, không ghi bảng nào, không job_runs', async () => {
    await seed();
    const tables = [
      'approval_queue',
      'agent_action_log',
      'market_alerts',
      'price_list',
      'sku_master',
      'job_runs',
    ];
    const count = async () => Promise.all(tables.map((tb) => n(`select count(*) from ${tb}`)));
    const before = await count();
    const t = cap();
    let jobs = 0;
    const rc = await kdListingMain(
      { run: true, dryRun: true },
      {
        ...t.d,
        open: openNew,
        jobRun: async (_n, b) => {
          jobs++;
          return b({ ok: true, detail: null });
        },
      },
    );
    expect(rc).toBe(0);
    expect(await count()).toEqual(before);
    expect(jobs).toBe(0);
    const out = t.out.join('\n');
    expect(out).toContain('[dry-run] sẽ đẩy 7 mục mới');
    expect(out).toContain('trùng cảnh báo sàn 1');
    expect(out).not.toContain('ruou');
    expect(out).not.toContain(RUOU_TITLE);
  });

  it('lỗi DB giữa chừng → exit 2 "[error] lỗi DB"', async () => {
    await seed();
    await q('alter table market_rows rename to market_rows_x');
    const t = cap();
    expect(await kdListingMain({ run: true, dryRun: true }, { ...t.d, open: openNew })).toBe(2);
    expect(t.err.join('\n')).toMatch(/^\[error\] lỗi DB: /);
  });

  it('agent_writer không ghi được golden (bị chặn ở BẢNG)', async () => {
    await seed();
    const pid = await one('select id from price_list order by id limit 1');
    for (const [sql, args] of [
      ["update price_list set approved_by = 'x' where id = $1", [pid]],
      [
        "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ('sam-a', 'web', 'list', 1, '2026-01-01')",
        [],
      ],
      ["update sku_master set name = 'x' where sku_key = 'sam-a'", []],
    ] as [string, unknown[]][]) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role agent_writer');
        const e = await c.query(sql, args).then(
          () => null,
          (x) => x,
        );
        expect(e?.code, sql).toBe('42501');
        expect(String(e?.message)).toMatch(/table (price_list|sku_master)/);
      } finally {
        await c.query('rollback');
        c.release();
      }
    }
  });

  // ============================================================ listing_export

  const SKU = C.sku;
  const ALC = 'ruou-sam-chai-thuy-tinh-500ml';
  const RD = new Map(
    (C.readiness as [string, string, string][]).map(([a, b, v]) => [key2(a, b), v]),
  );
  const RDT = new Map([...RD, [key2(SKU, 'tiktok'), 'TP_THUONG']]);

  /** Mô tả chuẩn (khung golden do `content.listing(llm=False)` của Python sinh) → nháp qua
   * `saveDraft` THẬT; `approve` → `approve_draft` (người). */
  async function master(approve = true): Promise<[number, string]> {
    const did = await saveDraft(pool, {
      brief: `listing ${SKU} web`,
      channel: 'web',
      text: C.master.text,
      guardrail: C.master.guardrail,
      source: SOURCE_CLI,
      createdBy: 'agent:mkt02',
      contentType: 'listing',
      sku: SKU,
      isAi: true,
    });
    if (approve) await q("select approve_draft($1, 'GĐ Bán Hàng', null)", [did]);
    return [Number(did), C.master.text];
  }

  /** Dòng price_list qua ĐÚNG trigger append-only: INSERT mở chưa duyệt → UPDATE duyệt → tùy đóng. */
  async function webPrice(
    sku: string,
    price: number,
    o: {
      kind?: string;
      channel?: string;
      daysAgo?: number;
      to?: string;
      approve?: boolean;
      program?: string;
    } = {},
  ): Promise<number> {
    await q(
      "insert into sku_master (sku_key, name, category, allowed_channels, source) values ($1, $1, $2, '{web,shopee,tiktok}', 'test') on conflict do nothing",
      [sku, sku === ALC ? 'alcohol' : 'food'],
    );
    const pid = Number(
      await one(
        'insert into price_list (sku_key, channel, kind, price_vnd, program_id, valid_from) values ($1,$2,$3,$4,$5,$6) returning id',
        [
          sku,
          o.channel ?? 'web',
          o.kind ?? 'list',
          price,
          o.program ?? null,
          addDays(TODAY, -(o.daysAgo ?? 10)),
        ],
      ),
    );
    if (o.approve ?? true) {
      await q(
        "update price_list set approved_by = 'GĐ Bán Hàng', approved_at = now() where id = $1",
        [pid],
      );
    }
    if (o.to !== undefined)
      await q('update price_list set valid_to = $1 where id = $2', [o.to, pid]);
    return pid;
  }

  const refused = async (p: Promise<unknown>, why: RegExp) => {
    const e = await p.then(
      () => null,
      (x) => x,
    );
    expect(e, String(why)).toBeInstanceOf(le.ExportError);
    expect((e as Error).message).toMatch(why);
  };
  const empty = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };

  describe('listing_export', () => {
    beforeEach(clearGolden);

    it('xuất sàn: giá price_list ĐÃ duyệt (không JSON), CSV + manifest, verify khớp, sửa tay → lệch', async () => {
      const [did, text] = await master();
      expect(text).toContain('Giá:');
      // Đợt an toàn S03: giá DB khác JSON golden (745000) → chứng minh không dùng JSON.
      const pid = await webPrice(SKU, 151000, { channel: 'shopee' });
      const od = outDir();
      const mp = await le.exportListing(pool, SKU, 'shopee', od, RD);
      const man = JSON.parse(readFileSync(mp, 'utf8'));
      expect([man.draft_id, man.transform, man.gia_vnd, man.gia_id]).toEqual([
        did,
        'bo_dong_gia',
        151000,
        pid,
      ]);
      expect(man.gia_nguon).toContain('price_list');
      expect(man.mapping_status).toContain('CHƯA XÁC MINH');
      const raw = readFileSync(join(od, man.file));
      expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const body = raw.subarray(3).toString('utf8');
      expect(body.startsWith('Mã SKU,')).toBe(true);
      expect(body).toContain(`\n${SKU},`);
      expect(body).not.toContain('Giá:');
      expect(body.trimEnd().endsWith(`,${man.gia_vnd}`)).toBe(true);
      expect(await le.verify(pool, mp, RD)).toEqual([]);
      const f = join(od, man.file);
      writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from(' ')]));
      expect((await le.verify(pool, mp, RD)).some((b) => b.includes('đã bị sửa'))).toBe(true);
    });

    it('từ chối: chưa có mô tả duyệt / nháp chờ duyệt / kênh đích CAM — không ghi tệp', async () => {
      const od = outDir();
      await refused(le.exportListing(pool, SKU, 'shopee', od, RD), /chưa có mô tả chuẩn/);
      const [did] = await master(false);
      await refused(le.exportListing(pool, SKU, 'shopee', od, RD), /chưa có mô tả chuẩn/);
      await q("select approve_draft($1, 'GĐ Bán Hàng', null)", [did]);
      await refused(le.exportListing(pool, SKU, 'tiktok', od, RD), /mức CAM trên kênh tiktok/);
      await refused(le.build(pool, SKU, 'lazada', RD), /kênh phải \('shopee', 'tiktok'\)/);
      expect(empty(od)).toEqual([]);
    });

    it('sửa sau duyệt → phải duyệt lại', async () => {
      const [did] = await master();
      await q("update content_drafts set text = text || ' sửa' where id = $1", [did]);
      await refused(le.exportListing(pool, SKU, 'shopee', outDir(), RD), /duyệt lại/);
    });

    it('cổng rollout chạy thử → không dùng (xuất sàn + nguồn website), không ghi tệp', async () => {
      await master();
      settings.forceMode = 'chay_thu';
      const od = outDir();
      await refused(le.exportListing(pool, SKU, 'shopee', od, RD), /không dùng/);
      await refused(le.websiteFeed(pool, od, RD), /không dùng/);
      expect(empty(od)).toEqual([]);
    });

    it('sàn: không có giá DB → từ chối dù JSON golden có giá', async () => {
      await master();
      expect(C.listing_fields[SKU as keyof typeof C.listing_fields]).toBeTruthy();
      const od = outDir();
      await refused(le.exportListing(pool, SKU, 'shopee', od, RDT), /chưa có giá list kênh/);
      expect(empty(od)).toEqual([]);
    });

    it('sàn: giá chờ duyệt / hết hạn / từ mai / floor / promo / kênh khác → từ chối; kênh có giá riêng → xuất', async () => {
      await master();
      const od = outDir();
      const pid = await webPrice(SKU, 151000, { channel: 'shopee', approve: false });
      await refused(le.exportListing(pool, SKU, 'shopee', od, RDT), new RegExp(`#${pid} đang CHỜ`));
      await q('update price_list set valid_to = $1 where id = $2', [TODAY, pid]);
      await webPrice(SKU, 152000, { channel: 'shopee', daysAgo: -1 });
      await webPrice(SKU, 90000, { channel: 'shopee', kind: 'floor' });
      await webPrice(SKU, 80000, {
        channel: 'shopee',
        kind: 'promo',
        program: 'km-t',
        approve: false,
      });
      await webPrice(SKU, 120000, { channel: 'web' });
      await webPrice(SKU, 130000, { channel: 'tiktok' });
      await refused(le.exportListing(pool, SKU, 'shopee', od, RDT), /chưa có giá list kênh/);
      const mp = await le.exportListing(pool, SKU, 'tiktok', od, RDT);
      expect(JSON.parse(readFileSync(mp, 'utf8')).gia_vnd).toBe(130000);
    });

    it.each([['gia_moi'], ['het_han'], ['manifest_gia']])(
      'sàn verify phát hiện đổi giá: %s',
      async (change) => {
        await master();
        const pid = await webPrice(SKU, 151000, { channel: 'shopee' });
        const mp = await le.exportListing(pool, SKU, 'shopee', outDir(), RD);
        expect(await le.verify(pool, mp, RD)).toEqual([]);
        if (change === 'manifest_gia') {
          const man = JSON.parse(readFileSync(mp, 'utf8'));
          writeFileSync(mp, JSON.stringify({ ...man, gia_vnd: 99000 }));
        } else {
          await q('update price_list set valid_to = $1 where id = $2', [TODAY, pid]);
          if (change === 'gia_moi') await webPrice(SKU, 160000, { channel: 'shopee', daysAgo: 0 });
        }
        expect(await le.verify(pool, mp, RD)).not.toEqual([]);
      },
    );

    /** Bảng giá không đọc được: mất bảng / login không có quyền SELECT price_list. */
    async function unreadable(how: string, fn: (db: pg.ClientBase) => Promise<unknown>) {
      if (how === 'mat_bang') {
        await q('alter table price_list rename to price_list_x');
        const c = await pool.connect();
        try {
          return await fn(c);
        } finally {
          c.release();
        }
      }
      const role = `t_kll_noprice_${process.pid}`;
      await q(`drop role if exists ${role}`);
      await q(`create role ${role} nologin`);
      await q(`grant usage on schema public to ${role}`);
      await q(`grant select on all tables in schema public to ${role}`);
      await q(`grant execute on all functions in schema public to ${role}`);
      await q(`revoke select on price_list from ${role}`);
      const c = await pool.connect();
      try {
        await c.query(`set role ${role}`);
        return await fn(c);
      } finally {
        await c.query('reset role');
        c.release();
        await q(`drop owned by ${role}`);
        await q(`drop role ${role}`);
      }
    }

    it.each([['mat_bang'], ['khong_quyen']])(
      'bảng giá không đọc được (%s) → từ chối, không ghi tệp',
      async (how) => {
        await master();
        await webPrice(SKU, 151000, { channel: 'shopee' });
        await webPrice(SKU, 120000);
        const od = outDir();
        await unreadable(how, async (c) => {
          await refused(le.exportListing(c, SKU, 'shopee', od, RD), /không đọc được bảng giá/);
          await refused(le.websiteFeed(c, od, RD), /không đọc được bảng giá/);
        });
        expect(empty(od)).toEqual([]);
      },
    );

    const feed = async (od: string, rd = RD) => {
      const mp = await le.websiteFeed(pool, od, rd);
      const man = JSON.parse(readFileSync(mp, 'utf8'));
      const data = readFileSync(join(od, man.file));
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(data).digest('hex')).toBe(man.file_sha256);
      const rows = Object.fromEntries(
        (JSON.parse(data.toString('utf8')).rows as le.FeedRow[]).map((r) => [r.sku_key, r]),
      );
      return { mp, man, rows };
    };

    it('website: chưa có giá web DB → không bán; SKU chưa có mô tả duyệt → lý do cụ thể', async () => {
      await master();
      const { man, rows } = await feed(outDir());
      const r = rows[SKU] as le.FeedRow;
      expect([Boolean(r.mo_ta), r.gia_vnd, r.gio_hang]).toEqual([true, null, false]);
      expect(r.ly_do.some((x) => x.includes('giá list kênh web'))).toBe(true);
      expect([man.ban_duoc, man.so_sku]).toEqual([0, Object.keys(rows).length]);
      const other = Object.keys(rows).find((k) => k !== SKU && k !== ALC) as string;
      expect(rows[other]?.mo_ta).toBeNull();
      expect(rows[other]?.ly_do.length).toBeGreaterThan(0);
    });

    it('website: bán được bằng giá DB ĐÃ duyệt; rượu luôn ẩn giá + không giỏ', async () => {
      const pid = await webPrice(SKU, 120000);
      await webPrice(ALC, 500000);
      await master();
      const rd = new Map([...RD, [key2(ALC, 'web'), 'TP_THUONG']]);
      const { man, rows } = await feed(outDir(), rd);
      const r = rows[SKU] as le.FeedRow;
      expect([r.gio_hang, r.gia_vnd, r.gia_id, r.ly_do]).toEqual([true, 120000, pid, []]);
      expect(r.mo_ta).not.toContain('Giá:');
      expect(man.gia_phien_ban).toEqual({ [SKU]: pid });
      expect(man.gia_nguon).toContain('price_list');
      expect(man.gia_ngay_hieu_luc).toBe(TODAY);
      const a = rows[ALC] as le.FeedRow;
      expect([a.an_gia, a.gio_hang, a.gia_vnd, a.gia_id]).toEqual([true, false, null, null]);
    });

    const row = async (rd = RD) => {
      const [cfg] = (await import('./content-lite.js')).contentCfg();
      // JSON golden có giá web KHÔNG được dùng.
      const gold = { ...(cfg?.golden.get(SKU) ?? {}), prices: { web: { list: 99000 } } };
      return le.websiteRow(pool, SKU, gold, rd);
    };
    const notSellable = (r: le.FeedRow, why: string) => {
      expect([r.gio_hang, r.gia_vnd, r.gia_id]).toEqual([false, null, null]);
      expect(
        r.ly_do.some((x) => x.includes(why)),
        r.ly_do.join('|'),
      ).toBe(true);
    };

    it('website: giá JSON mà không có giá DB → không bán', async () => {
      await master();
      notSellable(await row(), 'chưa có giá list kênh web');
    });

    it('website: giá DB chờ duyệt → không dùng', async () => {
      await master();
      const pid = await webPrice(SKU, 120000, { approve: false });
      notSellable(await row(), `#${pid} đang CHỜ`);
    });

    it('website: giá hết hạn / hiệu lực từ mai → không dùng', async () => {
      await master();
      await webPrice(SKU, 120000, { daysAgo: 30, to: TODAY });
      notSellable(await row(), 'chưa có giá list kênh web');
      await webPrice(SKU, 130000, { daysAgo: -1 });
      notSellable(await row(), 'chưa có giá list kênh web');
    });

    it('website: không fallback floor / promo / kênh khác', async () => {
      await master();
      await webPrice(SKU, 80000, { kind: 'floor' });
      await webPrice(SKU, 70000, { kind: 'promo', program: 'km-test', approve: false });
      await webPrice(SKU, 110000, { channel: 'shopee' });
      notSellable(await row(), 'chưa có giá list kênh web');
    });

    it('website: mô tả sửa sau duyệt → không bán dù có giá DB', async () => {
      const [did] = await master();
      await webPrice(SKU, 120000);
      await q("update content_drafts set text = text || ' sửa' where id = $1", [did]);
      const r = await row();
      expect([r.gio_hang, r.mo_ta]).toEqual([false, null]);
      expect(r.ly_do.some((x) => x.includes('duyệt lại'))).toBe(true);
    });

    it('CLI listing-export: xuất → --verify khớp; manifest hỏng exit 1; kênh thiếu giá → [từ chối]; --website-feed', async () => {
      await webPrice(SKU, 151000, { channel: 'shopee' });
      await q('update sku_master set self_declaration_ok = true where sku_key = $1', [SKU]);
      await master();
      const od = outDir();
      const run = async (o: Parameters<typeof listingExportMain>[0]) => {
        const t = cap();
        const rc = await listingExportMain(o, { ...t.d, open: openNew });
        return { rc, ...t };
      };
      let r = await run({ sku: SKU, channel: 'shopee', out: od });
      expect(r.rc).toBe(0);
      expect(r.out[0]).toMatch(
        /^\[done\] listing-shopee-.+\.manifest\.json — mapping CHƯA XÁC MINH/,
      );
      const mp = join(od, readdirSync(od).find((f) => f.endsWith('.manifest.json')) as string);
      r = await run({ verify: mp });
      expect([r.rc, r.out]).toEqual([0, ['[done] khớp bản đã duyệt']]);
      writeFileSync(join(od, 'bad.json'), '{x');
      r = await run({ verify: join(od, 'bad.json') });
      expect([r.rc, r.err]).toEqual([1, ['[error] không đọc được manifest (JSONDecodeError)']]);
      r = await run({ sku: SKU, channel: 'tiktok', out: outDir() });
      expect(r.rc).toBe(1);
      expect(r.err[0]).toMatch(/^\[từ chối\] .*chưa có giá list kênh.* — không ghi tệp$/);
      r = await run({ websiteFeed: true, out: od });
      expect(r.rc).toBe(0);
      expect(r.out[0]).toMatch(
        /^\[done\] website-feed-.+\.manifest\.json — 0\/\d+ SKU bán được trên web/,
      );
    });

    it('website verify: khớp ngay sau xuất; giá web mới → lệch gia_id/gia_vnd; tệp sửa → lệch sha', async () => {
      const old = await webPrice(SKU, 120000);
      await master();
      const od = outDir();
      const mp = await le.websiteFeed(pool, od, RD);
      const man = JSON.parse(readFileSync(mp, 'utf8'));
      expect(await le.verifyFeed(pool, man, mp, RD)).toEqual([]);
      await q('update price_list set valid_to = $1 where id = $2', [addDays(TODAY, -1), old]);
      await webPrice(SKU, 130000, { daysAgo: 1 });
      const bad = await le.verifyFeed(pool, man, mp, RD);
      expect(bad.some((b) => b.startsWith(`${SKU}: gia_id lệch`))).toBe(true);
      expect(bad.some((b) => b.includes('gia_vnd'))).toBe(true);
      const f = join(od, man.file);
      writeFileSync(f, Buffer.concat([readFileSync(f), Buffer.from(' ')]));
      expect((await le.verifyFeed(pool, man, mp, RD)).some((b) => b.includes('sha lệch'))).toBe(
        true,
      );
      expect(await le.verifyFeed(pool, { ...man, file: '../x.json' }, mp, RD)).toEqual([
        'thiếu tệp nguồn dữ liệu website',
      ]);
    });
  });

  // ============================================================ kd_live

  const H1 = 'mat-ong-sam-120ml-1hu';
  const H2 = 'mat-ong-sam-300ml';
  const SAPH = 'saphraton-20v';
  const SAPENTOL = 'sapentol-30v';
  const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
  const MON = '2026-10-19';
  const BRIEF = 'Phiên quà quê cuối tuần';
  const RULES = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8'));
  const HEALTH = kv.healthTemplate();
  const GOOD = {
    mo_dau: [
      'Chào cả nhà đã ghé phiên live của Sâm Sâm.',
      'Hôm nay Sâm Sâm mang quà quê Quảng Nam tới cả nhà.',
    ],
    san_pham: [
      {
        sku: H1,
        loi_dan: [
          'Mật ong sóng sánh vàng óng từ vùng trồng sâm.',
          'Giá chỉ 199k hôm nay thôi.',
          'Rượu sâm uống kèm rất hợp.',
        ],
      },
      { sku: 'sku-la', loi_dan: ['Không thuộc giỏ.'] },
    ],
    hoi_dap: [
      { hoi: 'Shop có giao hàng ra Hà Nội không?', dap: 'Dạ Sâm Sâm giao toàn quốc ạ.' },
      { hoi: 'Người bị tiểu đường dùng được không?', dap: 'Dùng thoải mái nhé cả nhà.' },
    ],
    ket: ['Cảm ơn cả nhà đã xem live.'],
  };
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  /** Gateway GIẢ: trả lần lượt `queue` (phần tử cuối lặp lại). */
  function llm(queue: unknown[] = [GOOD]) {
    const st = { calls: [] as { agent: string; msgs: { content: unknown }[] }[], queue };
    const ai: kv.Chat = {
      chat: async (agent, msgs) => {
        st.calls.push({ agent, msgs });
        const x = st.queue[Math.min(st.calls.length, st.queue.length) - 1];
        return {
          text: typeof x === 'string' ? x : JSON.stringify(x),
          model: 'fake/llm',
          provider: 'ollama',
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };
    return { st, ai };
  }

  /** Golden mẫu (đã nạp) + SKU được quảng bá TikTok với giá list ĐÃ duyệt (người duyệt GIẢ LẬP). */
  async function promotable() {
    await q("update sku_master set self_declaration_ok = true where category = 'food'");
    await q("update sku_master set xnqc_status = 'approved' where sku_key like 'saphraton-%'");
    await q(
      "update sku_master set allowed_channels = array['shopee', 'tiktok'] where category <> 'alcohol' or sku_key = $1",
      [RUOU],
    );
    for (const [k, p] of [
      [H1, 250000],
      [H2, 480000],
      [SAPH, 320000],
      [SAPENTOL, 300000],
      [RUOU, 700000],
    ] as [string, number][]) {
      const pid = await one(
        "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, 'tiktok', 'list', $2, '2026-01-01') returning id",
        [k, p],
      );
      await q(
        "update price_list set approved_by = 'GD gia lap', approved_at = now() where id = $1",
        [pid],
      );
    }
  }
  const drafts = () =>
    q(
      'select id::text as id, status, brief, text, created_by, content_type, channel, prompt_version from content_drafts order by id',
    );

  describe('kd_live', () => {
    beforeEach(promotable);

    it('từ chối trước LLM: rượu / chưa promotable — 0 lời gọi, 0 nháp', async () => {
      const { st, ai } = llm();
      for (const [cart, code] of [
        [[H1, RUOU], 'ruou'],
        [[H1, SAPENTOL], 'khong_promotable'],
      ] as [string[], string][]) {
        const res = await kv.writeScript(pool, 'tiktok', cart, MON, BRIEF, { ai });
        expect([res.refused?.code, res.ok, res.guardrail?.ok]).toEqual([code, false, false]);
      }
      expect([st.calls, await drafts()]).toEqual([[], []]);
    });

    it('kịch bản: giá từ v_promotable, bỏ câu số/rượu, sức khỏe = template, khuyến cáo + nhãn, nháp pending', async () => {
      const { st, ai } = llm();
      const res = await kv.writeScript(pool, 'tiktok', [H1, SAPH], MON, BRIEF, { ai });
      expect(res.ok, JSON.stringify(res.refused)).toBe(true);
      expect(st.calls.map((c) => c.agent)).toEqual(['kd_livestream']);
      const text = res.text;
      expect(new Set(res.dropped.map((d) => d.ly_do))).toEqual(new Set(['so_lieu', 'ruou']));
      for (const bad of ['199', 'Rượu', 'rượu']) expect(text).not.toContain(bad);
      expect(text).toContain('250.000 đ');
      expect(text).toContain('320.000 đ');
      expect(res.cart.map((c) => c.price_vnd)).toEqual([250000, 320000]);
      let body = text
        .replace('250.000', '')
        .replace('320.000', '')
        .replace('19/10/2026', '')
        .replace(HEALTH, '');
      for (const c of res.cart) body = body.replace(c.name, '');
      expect(body.match(/\d+/g)).toEqual(['1', '2']); // chỉ số thứ tự giỏ
      expect(text).not.toContain('Không thuộc giỏ');
      expect(text).toContain(`Đáp: ${HEALTH}`);
      expect(text).not.toContain('thoải mái');
      // vá controller 20/10: nguyên văn câu hỏi sức khỏe KHÔNG vào kịch bản
      expect(text).not.toContain('tiểu đường');
      expect(text).toContain(`Hỏi: ${kv.HEALTH_Q}`);
      expect(text).toContain('Dạ Sâm Sâm giao toàn quốc ạ.');
      expect(text).toContain(RULES.disclaimer.canonical);
      expect(text).toContain(RULES.labels.ai[0]);
      expect(text).toContain(RULES.labels.ad[0]);
      expect(check(text).ok).toBe(true);
      const [d, ...more] = await drafts();
      expect(more).toEqual([]);
      expect(d?.id).toBe(res.draft_id);
      expect([d?.status, d?.created_by, d?.content_type, d?.channel, d?.prompt_version]).toEqual([
        'pending',
        'agent:kd_a9',
        'livestream_script',
        'tiktok',
        'livestream_script@1',
      ]);
      expect(d?.brief.split('\n')[0]).toBe('phien: 2026-10-19 kenh: tiktok');
      expect(d?.text).toBe(text);
    });

    it('vi phạm claim → 1 lượt sửa rồi từ chối; sửa xong → đạt; làm sạch escape/ZWSP; JSON hỏng → kich_ban', async () => {
      const bad = clone(GOOD);
      bad.san_pham[0] = { sku: H1, loi_dan: ['Mật ong sâm giúp ngủ ngon mỗi tối.'] };
      let L = llm([bad]);
      const res = await kv.writeScript(pool, 'tiktok', [H1], MON, BRIEF, { ai: L.ai });
      expect([res.refused?.code, res.ok, res.guardrail?.ok]).toEqual(['kich_ban', false, false]);
      expect(L.st.calls).toHaveLength(2);
      expect(String(L.st.calls[1]?.msgs.at(-1)?.content)).toContain('vi phạm');
      expect(await drafts()).toEqual([]);
      const bad2 = clone(GOOD);
      bad2.ket = ['Đây là thần dược của núi rừng.'];
      L = llm([bad2, GOOD]);
      const res2 = await kv.writeScript(pool, 'tiktok', [H1], MON, BRIEF, { ai: L.ai });
      expect([res2.ok, L.st.calls.length]).toEqual([true, 2]);
      const esc = clone(GOOD) as Record<string, unknown>;
      esc.mo_dau = ['Chào\x1b[m cả nhà\u200b nhé.'];
      esc.hoi_dap = [{ hoi: { x: 1 }, dap: 'Dạ.' }];
      L = llm([esc]);
      const res4 = await kv.writeScript(pool, 'tiktok', [H1], MON, BRIEF, {
        ai: L.ai,
        dryRun: true,
      });
      expect(res4.ok).toBe(true);
      for (const x of ['\x1b', '\u200b', 'Hỏi:']) expect(res4.text).not.toContain(x);
      expect(res4.text).toContain('Chào[m cả nhà nhé.');
      L = llm(['không phải json']);
      const res3 = await kv.writeScript(pool, 'tiktok', [H1], MON, BRIEF, { ai: L.ai });
      expect(res3.refused?.code).toBe('kich_ban');
    });

    it('trần phiên/tuần ISO: phiên thứ 3 bị chặn trước LLM; nháp bị từ chối không tính; dry-run không lưu', async () => {
      const { st, ai } = llm();
      const a = await kv.writeScript(pool, 'tiktok', [H1], MON, BRIEF, { ai });
      let b = await kv.writeScript(pool, 'shopee', [H1], '2026-10-25', BRIEF, { ai });
      expect([a.ok, b.ok]).toEqual([true, false]); // H1 chưa có giá shopee ĐÃ duyệt
      b = await kv.writeScript(pool, 'tiktok', [H2], '2026-10-25', BRIEF, { ai });
      expect(b.ok).toBe(true);
      const nCalls = st.calls.length;
      const c = await kv.writeScript(pool, 'tiktok', [H1], '2026-10-21', BRIEF, { ai });
      expect(c.refused?.code).toBe('vuot_tran_phien');
      expect(st.calls.length).toBe(nCalls); // 0 lời gọi
      const d = await kv.writeScript(pool, 'tiktok', [H1], '2026-10-26', BRIEF, { ai });
      expect(d.ok).toBe(true); // tuần kế
      const [ok, msg] = await setStatus(pool, a.draft_id, 'rejected', 'nguoi_duyet_gia_lap');
      expect([ok, msg]).toEqual([true, null]);
      const e = await kv.writeScript(pool, 'tiktok', [H1], '2026-10-21', BRIEF, { ai });
      expect(e.ok).toBe(true); // rejected không tính trần
      const dry = await kv.writeScript(pool, 'tiktok', [H1], '2026-11-02', BRIEF, {
        ai,
        dryRun: true,
      });
      expect([dry.ok, dry.draft_id]).toEqual([true, null]);
      expect(await drafts()).toHaveLength(4);
    });

    it('CLI: sai tham số exit 2 trước connect; --dry-run không lưu; rượu → [refuse] exit 1', async () => {
      const { ai } = llm();
      const opened: number[] = [];
      const deps = (t: ReturnType<typeof cap>): CliDeps => ({
        ...t.d,
        open: async () => {
          opened.push(1);
          return createPool(dsn);
        },
        ai,
      });
      for (const o of [
        { channel: 'tiktok', cart: H1, day: '19/10', brief: 'x' },
        { channel: 'lazada', cart: H1, day: MON, brief: 'x' },
        { channel: 'tiktok', cart: 'A;drop', day: MON, brief: 'x' },
      ]) {
        expect(await kdLiveMain(o, deps(cap()))).toBe(2);
      }
      expect(opened).toEqual([]);
      let t = cap();
      expect(
        await kdLiveMain(
          { channel: 'tiktok', cart: `${H1},${SAPH}`, day: MON, brief: BRIEF, dryRun: true },
          deps(t),
        ),
      ).toBe(0);
      expect(await drafts()).toEqual([]);
      expect(t.out.join('\n')).toContain('dry-run');
      t = cap();
      expect(
        await kdLiveMain({ channel: 'tiktok', cart: RUOU, day: MON, brief: BRIEF }, deps(t)),
      ).toBe(1);
      expect(t.out.join('\n')).toContain('[refuse] ruou');
    });
  });
});
