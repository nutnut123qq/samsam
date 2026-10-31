import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import { loadConfig as loadDirector, submit } from '@samsam/core/ops/director';
import { vnDate } from '@samsam/core/ops/period';
import { contentSha256, saveDraft } from '@samsam/core/ops/store';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeSections, setCeoSections } from '../ceo_report/ceo-report.js';
import { readPlan } from '../kd_price/kd-price.js';
import * as au from './ceo-audit.js';
import * as cd from './ceo-decisions.js';
import {
  type CliDeps,
  ceoAuditMain,
  ceoDecisionsMain,
  ceoPromoMain,
  ceoRiskMain,
} from './ceo-misc.command.js';
import { CEO_SECTIONS } from './ceo-misc.module.js';
import * as cp from './ceo-promo.js';
import * as cr from './ceo-risk.js';

// Dịch phần DB của tests/test_ceo_audit.py, test_contract_c06_ceo_audit_price.py, test_ceo_risk.py,
// test_ceo_decisions.py (E2E đề xuất/ghi/theo dõi), test_contract_c05_ceo_waiting.py,
// test_v14_p5_mkt_ceo_intel.py (ceo-04.5 DB: đợt lệch, golden KM đã duyệt, file KM chỉ dòng đang
// chạy, tính năng TẮT). DB riêng dựng từ mẫu (`samsam_ts_tpl`), xóa khi xong — KHÔNG BAO GIỜ DB
// `samsam`. Ca cô lập kiểu Python (schema tạm + ROLLBACK) chạy trong giao dịch của 1 client rồi
// ROLLBACK; ca qua CLI mở pool riêng dùng DB đã commit. Tên người là tên giả lập; số là số MẪU.

const RUN = Boolean(process.env.TS_TEST_ADMIN_URL);
const tmp = mkdtempSync(join(tmpdir(), 'ceo-misc-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const fresh = () => join(tmp, String(seq++));

const cap = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
/** Client trong giao dịch → "pool" cho CLI (end() no-op; ghi trong savepoint, ROLLBACK cuối ca). */
const asPool = (c: pg.ClientBase) =>
  ({
    query: (...a: unknown[]) => (c.query as (...x: unknown[]) => unknown)(...a),
    end: async () => {},
  }) as unknown as pg.Pool;

/** Ca cô lập: begin … ROLLBACK (Python: schema tạm + ROLLBACK). */
async function inTx(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const replica = (c: pg.ClientBase, on: boolean) =>
  c.query(`set local session_replication_role = ${on ? 'replica' : 'origin'}`);

const OK_SNAP = { ok: true, violations: [] };
const REVIEWER = 'Phap Che Gia Lap';
const CREATOR = 'agent:mkt-test';

async function approvedDraft(
  db: pg.Pool,
  text: string,
  o: { channel?: string; contentType?: string; sku?: string } = {},
): Promise<string> {
  const did = await saveDraft(db, {
    brief: 'brief test',
    channel: o.channel ?? 'facebook',
    text,
    guardrail: OK_SNAP,
    source: 'cli',
    createdBy: CREATOR,
    contentType: o.contentType ?? 'post',
    sku: o.sku ?? null,
    isAi: true,
  });
  await db.query('select approve_draft($1, $2, null)', [did, REVIEWER]);
  return did as string;
}

// ================================================================= ceo_audit — fixture P1–P6 + L1–L4

describe.skipIf(!RUN)('ceo_audit (DB) — WP10 audit outside-in trên fixture', () => {
  const NAME = testDbName('ceo_misc_audit');
  let dsn: string;
  let pool: pg.Pool;
  const FB = 'https://www.facebook.com/samsam/posts/';
  const P: Record<number, string> = {
    1: `${FB}p1`,
    2: `${FB}p2`,
    3: `${FB}p3?ref=0905123456`,
    4: `${FB}p4`,
    5: `${FB}p5`,
    6: `${FB}p6`,
  };
  const T: Record<number, string> = {
    1: 'Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem sản phẩm mới. Nội dung có sử dụng AI.',
    2: 'Sâm Sâm gửi lời chào buổi sáng tới quý khách! Mời ghé cửa hàng xem sản phẩm. Nội dung có sử dụng AI.',
    3: 'Sâm Sâm thông báo lịch nghỉ cuối tuần của cửa hàng. Nội dung có sử dụng AI.',
    4: 'Sâm Sâm chúc mừng ngày khai trương cửa hàng mới. Nội dung có sử dụng AI.',
    5: 'Sâm Sâm cảm ơn quý khách đã ghé gian hàng tuần qua. Nội dung có sử dụng AI.',
    6: 'Sâm Sâm mời quý khách đón xem buổi giới thiệu sản phẩm tối thứ Sáu. Nội dung có sử dụng AI.',
  };
  const L = { 1: '24325987926', 2: '27357883504', 3: '24825885894', 4: '99900000002' };
  const LISTING = {
    'mat-ong-sam-120ml-1hu':
      'Mật ong sâm 120ml 1 hũ\nMô tả chuẩn đã duyệt. Nội dung có sử dụng AI.',
    'mat-ong-sam-120ml-2hu':
      'Mật ong sâm 120ml 2 hũ\nMô tả chuẩn đã duyệt. Nội dung có sử dụng AI.',
  };
  const TITLES = [
    'Mật ong sâm 120ml 1 HŨ',
    'Mật ong sâm 2 hũ bản sửa tay',
    'Mật ong sâm 300ml',
    'Sản phẩm mẫu chưa có trong golden',
  ];
  // Viết sẵn (không tính lại bằng chính module): đúng 6 phát hiện.
  const EXPECT = new Set([
    `facebook|lech_ban_duyet|${P[2]}`,
    `facebook|thieu_ban_duyet|${P[3]}`,
    `facebook|thieu_ban_duyet|${P[5]}`,
    `shopee|lech_ban_duyet|${L[2]}`,
    `shopee|thieu_ban_duyet|${L[3]}`,
    `shopee|khong_xac_dinh_sku|${L[4]}`,
  ]);
  const found = (d: au.AuditData) =>
    new Set(au.findings(d.items).map((f) => `${f.channel}|${f.code}|${f.ref}`));
  const counts = async () =>
    (
      await pool.query(
        "select (select count(*) from channel_posts) || '/' || (select count(*) from market_rows) || '/' || (select count(*) from approval_queue) || '/' || (select count(*) from approvals) || '/' || (select count(*) from red_alerts) || '/' || (select count(*) from content_drafts) as n",
      )
    ).rows[0].n as string;

  beforeAll(async () => {
    settings.forceMode = 'van_hanh';
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
    const d1 = await approvedDraft(pool, T[1] as string);
    const approved2 = (T[2] as string).replace('quý khách!', 'quý khách.');
    const d2 = await approvedDraft(pool, approved2);
    const d5 = await approvedDraft(pool, T[5] as string);
    const post = (
      n: number,
      posted: string | null,
      draft: string | null,
      closed: string | null = null,
    ) =>
      pool.query(
        "insert into channel_posts (url, channel, content_type, posted_on, is_ai, draft_id, text, text_sha256, guardrail, imported_by, scanned_at, closed_at, close_reason) values ($1, 'facebook', 'post', $2, true, $3, $4, $5, '{}', 'Quản lý MXH (test)', '2026-10-12T09:00:00+07:00', $6, $7)",
        [
          P[n],
          posted,
          draft,
          T[n],
          contentSha256(T[n]),
          closed ? '2026-10-12T10:00:00+07:00' : null,
          closed,
        ],
      );
    await post(1, '2026-10-12', d1);
    await post(2, '2026-10-12', d2);
    await post(3, '2026-10-13', null);
    await post(4, '2026-09-01', null); // trước quy trình duyệt (quy_trinh_duyet_tu 2026-10-12)
    await post(5, '2026-10-12', d5);
    await post(6, '2026-10-12', null, 'da_go');
    // Thu hồi bản duyệt P5 SAU khi nạp — audit phải tính lại (không tin codes đã lưu).
    await pool.query(
      "insert into approvals (object_type, object_id, content_sha256, decision, approved_by, note) values ('content_draft', $1, $2, 'rejected', $3, 'thu hồi bản duyệt (test)')",
      [d5, contentSha256(T[5]), REVIEWER],
    );
    for (const [sku, text] of Object.entries(LISTING)) {
      await approvedDraft(pool, text, { channel: 'shopee', contentType: 'listing', sku });
    }
    const sid = (
      await pool.query(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count) values ('shopee', 'listing', 'listing_shopee_MAU.csv', $1, 4) returning id",
        ['a'.repeat(64)],
      )
    ).rows[0].id;
    const rows: [string, string | null, string, number][] = [
      [L[1], 'mat-ong-sam-120ml-1hu', TITLES[0] as string, 745000],
      [L[2], 'mat-ong-sam-120ml-2hu', TITLES[1] as string, 1340000],
      [L[3], 'mat-ong-sam-300ml', TITLES[2] as string, 2980000],
      [L[4], null, TITLES[3] as string, 100000],
    ];
    let no = 2;
    for (const [item, sku, title, price] of rows) {
      await pool.query(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, price_vnd, raw) values ($1, $2, 'shopee', 'listing', $3, $4, $5, $6, '{}')",
        [sid, no++, item, sku, title, price],
      );
    }
  });
  afterAll(async () => {
    settings.forceMode = null;
    setCeoSections(null);
    await pool?.end();
    await dropDb(NAME);
  });

  it('collect CHỈ SELECT, ra đúng 6 phát hiện viết sẵn + tỷ lệ theo kênh', async () => {
    const before = await counts();
    const log: string[] = [];
    const c = await pool.connect();
    const spy = {
      query: (sql: string, ...a: unknown[]) => {
        log.push(sql);
        return (c.query as (...x: unknown[]) => unknown)(sql, ...a);
      },
    } as unknown as pg.ClientBase;
    let data: au.AuditData;
    try {
      data = await au.collect(spy);
    } finally {
      c.release();
    }
    expect(await counts()).toBe(before);
    expect(log.length).toBeGreaterThan(0);
    for (const s of log) expect(s, s).toMatch(/^\s*select\b/i);
    expect(found(data)).toEqual(EXPECT);
    const comp = Object.fromEntries(
      au.compliance(data.items, [], undefined, data.snapshots).map((x) => [x.channel, x]),
    );
    expect([comp.facebook?.n, comp.facebook?.khop, comp.facebook?.rate]).toEqual([4, 1, '25%']);
    expect([comp.shopee?.n, comp.shopee?.khop, comp.shopee?.rate]).toEqual([4, 1, '25%']);
    expect(comp.shopee?.note).toBeNull();
    expect([comp.tiktok?.n, comp.tiktok?.rate, comp.tiktok?.note]).toEqual([0, '—', au.NO_DATA]);
    expect(data.removed.map((r) => (r as { ref: string }).ref)).toEqual([P[6]]);
    expect(data.before.map((r) => (r as { ref: string }).ref)).toEqual([P[4]]);
  });

  it('collect chạy được trong giao dịch read only (DB từ chối ghi)', async () => {
    await inTx(pool, async (c) => {
      await c.query('set local transaction_read_only = on');
      const data = await au.collect(c);
      expect(found(data)).toEqual(EXPECT);
      await expect(
        c.query(
          "insert into decision_log (entry_kind, decided_on, topic, decision, decided_by, basis_kind, note, recorded_by) values ('quyet_dinh', '2026-10-01', 'x', 'y', 'A', 'van_ban', 'văn bản test dài', 'B')",
        ),
      ).rejects.toMatchObject({ code: '25006' });
    });
  });

  it('CLI --report: che PII, không chép text bài/tiêu đề listing; section chỉ #id; ceo-gia riêng', async () => {
    const before = await counts();
    const out = fresh();
    const c = cap();
    const rc = await ceoAuditMain(
      { report: true, now: '2026-10-12T10:00', outDir: out },
      { ...c.deps, open: async () => createPool(dsn), wire: null, env: {} },
    );
    expect(rc).toBe(0);
    expect(await counts()).toBe(before);
    expect(readdirSync(out).sort()).toEqual(['ceo-audit-2026-10-12.md', 'ceo-gia-2026-10-12.md']);
    const page = readFileSync(join(out, 'ceo-audit-2026-10-12.md'), 'utf8');
    const sec = (await au.section(pool, new Date('2026-10-12T09:00:00+07:00'))).join('\n');
    for (const text of [page, sec]) {
      for (const t of Object.values(T)) {
        expect(text).not.toContain(t);
        expect(text).not.toContain(t.slice(0, 40));
      }
      for (const t of TITLES) expect(text).not.toContain(t);
      expect(text).not.toContain('0905123456');
    }
    expect(page).toContain('posts/p3?ref=***');
    expect(sec).not.toContain('facebook.com');
    expect(sec).not.toContain('posts/p');
    for (const v of Object.values(L)) expect(sec).not.toContain(v);
    expect(sec).toMatch(/— post #\d+$/m);
    const lines = (s: string) =>
      s.split('\n').filter((l) => /^- \[(facebook|shopee)\] /.test(l)).length;
    expect(lines(page)).toBe(6);
    expect(lines(sec)).toBe(5);
    expect(sec).toContain('…và 1 (xem ceo-audit-2026-10-12.md)');
    expect(page).toContain('| facebook | 4 | 1 | 25% |');
    expect(page).toContain('| shopee | 4 | 1 | 25% |');
    expect(page).toContain('| tiktok | 0 | 0 | — |');
    expect(page).toContain(au.NO_DATA);
    expect(page).toContain('GIỚI HẠN P1');
    expect(page).toContain('Giá & mô tả listing so bản đã duyệt: xem ceo-gia-2026-10-12.md');
    expect(check(page).ok).toBe(true);
    expect(c.out.join('\n')).toContain('6 phát hiện');
    const gia = readFileSync(join(out, 'ceo-gia-2026-10-12.md'), 'utf8');
    expect(gia).toContain('### Giá & mô tả listing đang chạy so bản đã duyệt');
    // giá golden mẫu chưa ai duyệt → không so được (chỉ dòng LỆCH mới liệt kê chi tiết)
    expect(gia).toContain('giá khop 0 · lech_ban_duyet 0 · khong_so_duoc 3');
    for (const t of TITLES) expect(gia).not.toContain(t);
  });

  it('r12 G1-L1: tắt RIÊNG ceo-04.4 → vẫn ghi ceo-audit (ceo-04.3), không ghi ceo-gia, exit 2', async () => {
    await pool.query(
      "insert into feature_rollout (feature_id, stage, updated_by) values ('ceo-04.3', 'van_hanh', 'Người Giả Lập'), ('ceo-04.4', 'tat', 'Người Giả Lập')",
    );
    settings.forceMode = null; // đọc sổ triển khai thật (DB) — không ép giai đoạn
    try {
      const out = fresh();
      const c = cap();
      const rc = await ceoAuditMain(
        { report: true, now: '2026-10-12T10:00', outDir: out },
        { ...c.deps, open: async () => createPool(dsn), wire: null, env: {} },
      );
      expect(rc).toBe(2);
      expect(readdirSync(out)).toEqual(['ceo-audit-2026-10-12.md']);
      const text = c.out.join('\n');
      expect(text).toContain('[done]');
      expect(text).toContain('[rollout]');
      expect(text).toContain('ceo-04.4');
      expect(text).not.toContain('[done] giá:');
    } finally {
      settings.forceMode = 'van_hanh';
      await pool.query("delete from feature_rollout where feature_id in ('ceo-04.3', 'ceo-04.4')");
    }
  });

  it('nối section trang TGĐ qua ceo_report.setCeoSections (đọc trong savepoint, không crash)', async () => {
    setCeoSections(CEO_SECTIONS);
    const secs = await computeSections(pool, new Date('2026-10-12T09:00:00+07:00'));
    expect(secs.map((s) => s[0])).toEqual([
      '## Tiến độ & Sổ quyết định',
      '## Rủi ro pháp lý mở',
      '## Audit outside-in (P1)',
    ]);
    for (const s of secs) expect(s.join('\n')).not.toContain('không đọc được');
    expect(check(secs.map((s) => s.join('\n')).join('\n')).ok).toBe(true);
  });
});

// ================================================================= C06 giá & mô tả listing

describe.skipIf(!RUN)('ceo_audit (DB) — C06 giá/mô tả listing so bản duyệt', () => {
  const NAME = testDbName('ceo_misc_c06');
  let pool: pg.Pool;
  // 3 ca (Python: 3 test riêng) trên 3 SKU của CÙNG 1 snapshot listing.
  const S1 = 'mat-ong-sam-120ml-1hu'; // giá khớp + mô tả khớp
  const S2 = 'mat-ong-sam-120ml-2hu'; // giá lệch + mô tả lệch
  const S3 = 'mat-ong-sam-300ml'; // giá chưa duyệt/hết hiệu lực + không cột mô tả
  let checks: Record<string, au.Check>;

  beforeAll(async () => {
    settings.forceMode = 'van_hanh';
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    const c = await pool.connect();
    try {
      // dữ liệu giá LỊCH SỬ giả cho test: bỏ trigger append-only trong setup
      await c.query('begin');
      await replica(c, true);
      await c.query("delete from price_list where kind = 'list' and sku_key = any($1)", [
        [S1, S2, S3],
      ]);
      const price = (sku: string, p: number, vf: string, vt: string | null, by: string | null) =>
        c.query(
          "insert into price_list (sku_key, channel, kind, price_vnd, valid_from, valid_to, approved_by) values ($1, 'shopee', 'list', $2, $3, $4, $5)",
          [sku, p, vf, vt, by],
        );
      await price(S1, 250000, '2026-01-01', null, 'GĐ Bán Hàng');
      await price(S2, 260000, '2026-01-01', null, 'GĐ Bán Hàng');
      await price(S3, 250000, '2026-01-01', '2026-10-01', 'GĐ Bán Hàng');
      await price(S3, 250000, '2026-10-01', null, null);
      await c.query('commit');
    } finally {
      c.release();
    }
    for (const sku of [S1, S2, S3]) {
      await approvedDraft(
        pool,
        'Mật ong sâm 120ml\nMô tả chuẩn đã duyệt. Nội dung có sử dụng AI.',
        { channel: 'shopee', contentType: 'listing', sku },
      );
    }
    const sid = (
      await pool.query(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', 'f.csv', $1, 3, '2026-10-15T09:00:00+07:00') returning id",
        ['c'.repeat(64)],
      )
    ).rows[0].id;
    const row = (no: number, sku: string, desc: string | null) =>
      pool.query(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, sku_key, title, price_vnd, raw) values ($1, $2, 'shopee', 'listing', $3, $4, 'Mật ong sâm 120ml', 250000, $5)",
        [
          sid,
          no,
          `it${no}`,
          sku,
          JSON.stringify(desc === null ? { title: 'x' } : { title: 'x', description: desc }),
        ],
      );
    await row(2, S1, 'Mô tả chuẩn  đã duyệt.  Nội dung có sử dụng AI.');
    await row(3, S2, 'Mô tả khác — chữa bệnh');
    await row(4, S3, null);
    const data = await au.collect(pool, { quy_trinh_duyet_tu: '2026-01-01' });
    const ids = Object.fromEntries(
      (await pool.query('select id::text as id, sku_key from market_rows')).rows.map((r) => [
        r.id,
        r.sku_key,
      ]),
    );
    checks = Object.fromEntries(data.checks.map((c) => [ids[String(c.row_id)], c]));
  });
  afterAll(async () => {
    settings.forceMode = null;
    await pool?.end();
    await dropDb(NAME);
  });

  it('giá khớp + mô tả khớp (gộp khoảng trắng); ngày quan sát = ngày VN của file', () => {
    const c = checks[S1] as au.Check;
    expect([c.price, c.desc]).toEqual([au.KHOP, au.KHOP]);
    expect(c.observed).toBe('2026-10-15');
  });

  it('giá lệch + mô tả lệch', () => {
    const c = checks[S2] as au.Check;
    expect(c.price).toBe(au.LECH);
    expect(c.price_why).toContain('duyệt 260000');
    expect(c.desc).toBe(au.LECH);
    const lines = au.checkLines([c]).join('\n');
    expect(lines).toContain('giá lech_ban_duyet');
    expect(lines).toContain('market_rows #');
  });

  it('giá chưa duyệt / hết hiệu lực → không so; không cột mô tả → không so', () => {
    const c = checks[S3] as au.Check;
    expect(c.price).toBe('khong_so_duoc');
    expect(c.price_why).toContain('chưa có giá list ĐÃ DUYỆT');
    expect(c.desc).toBe('khong_so_duoc');
    expect(au.checkLines([c]).join('\n')).toContain('chưa có cột mô tả');
  });
});

// ================================================================= DB dùng chung: ca ROLLBACK

describe.skipIf(!RUN)('ceo_misc (DB) — ca cô lập trong giao dịch', () => {
  const NAME = testDbName('ceo_misc');
  let dsn: string;
  let pool: pg.Pool;
  const CFG = cr.loadConfig();
  const TGD = 'TGĐ Giả Lập';
  const THU_KY = 'Thư Ký Giả Lập';

  beforeAll(async () => {
    settings.forceMode = 'van_hanh';
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
  });
  afterAll(async () => {
    settings.forceMode = null;
    await pool?.end();
    await dropDb(NAME);
  });

  // ------------------------------------------------------------ ceo_risk

  it('ceo_risk collect AS-OF: bài vi phạm / cảnh báo gốc / hồ sơ + chỉ đọc', async () => {
    await inTx(pool, async (c) => {
      const n = (await c.query('select now() as n')).rows[0].n as Date;
      const t = new Date('2026-10-12T09:00:00+07:00');
      const D = 86_400_000;
      const at = (ms: number) => new Date(t.getTime() + ms);
      const post = (
        url: string,
        ch: string,
        sev: string | null,
        scanned: Date,
        due: Date | null = null,
        closed: Date | null = null,
        reason: string | null = null,
      ) =>
        c.query(
          "insert into channel_posts (url, channel, content_type, is_ai, text, text_sha256, guardrail, codes, severity, first_detected_at, due_at, imported_by, scanned_at, closed_at, close_reason) values ($1, $2, 'post', true, 'bài mẫu', $3, '{}', $4, $5, $6, $7, 'Người Test', $8, $9, $10)",
          [
            url,
            ch,
            '0'.repeat(64),
            sev ? ['thieu_ban_duyet'] : [],
            sev,
            sev ? scanned : null,
            due,
            scanned,
            closed,
            reason,
          ],
        );
      // A: vi phạm, đóng SAU mốc t → vẫn mở tại t; tại t+2 ngày → đã đóng
      await post('u-a', 'facebook', 'S2', at(-2 * D), at(-D), at(D), 'da_go');
      // B: S1 đóng TRƯỚC t → không tính
      await post('u-b', 'web', 'S1', at(-2 * D), at(-D), at(-D), 'da_go');
      // C: dòng vi phạm cũ + snapshot sạch mới hơn trước t → không tính
      await post('u-c', 'web', 'S2', at(-3 * D), at(-2 * D), at(-D), 'da_sua');
      await post('u-c', 'web', null, at(-D));
      const ids: string[] = [];
      for (const [i, d] of [{}, {}, { escalation_of: '1' }].entries()) {
        ids.push(
          (
            await c.query(
              "insert into red_alerts (source_agent, title, detail) values ('test', $1, $2) returning id::text as id",
              [`cảnh báo ${i}`, JSON.stringify(d)],
            )
          ).rows[0].id,
        );
      }
      await c.query(
        "insert into red_alert_acks (alert_id, acked_by) values ($1, 'Phap Che Gia Lap')",
        [ids[1]],
      );
      await c.query(
        "insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so, status, ngay_nop, updated_by) values ('savigout-30v', 'maket', 'maket fanpage', 'da_nop', '2026-10-01', 'Phap Che Gia Lap')",
      );
      const f = await cr.collect(c, t);
      expect(f.posts?.map((p) => p.url)).toEqual(['u-a']);
      expect((await cr.collect(c, at(2 * D))).posts).toEqual([]);
      // red_alerts.ts / acked_at = now() của tx (DB đặt) → mốc ± 1 giây
      const after = await cr.collect(c, new Date(n.getTime() + 1000));
      expect(after.alerts).toEqual([ids[0]]); // ack ≤ as_of + leo thang: bỏ
      expect(after.dossiers?.map((d) => d.sku_key)).toEqual(['savigout-30v']);
      const early = await cr.collect(c, new Date(n.getTime() - 1000));
      expect([early.alerts, early.dossiers]).toEqual([[], []]);
      expect([after.recipients, after.dpia_signed]).toEqual([0, false]);
      const map = JSON.parse(readFileSync(dataPath('data_flow_map.json'), 'utf8'));
      expect(after.gaps).toBe(
        map.flows.reduce((s: number, x: { gaps: unknown[] }) => s + x.gaps.length, 0),
      );
      const r = cr.rank(after, new Date(n.getTime() + 1000), CFG);
      const codes = r.map((x) => x.code);
      expect(codes).toContain('XNQC-CHO-CAP:savigout-30v');
      expect(codes).not.toContain('XNQC-CHO-NOP:savigout-30v');
      expect(r.find((x) => x.code === 'CANH-BAO-DO')?.title.startsWith('1 cảnh báo')).toBe(true);
      // chỉ đọc: collect/compute trong giao dịch read only
      await c.query('savepoint ro');
      await c.query('set local transaction_read_only = on');
      await cr.collect(c, n);
      const [cur, tr] = await cr.compute(c, new Date(n.getTime() + 1000));
      await c.query('rollback to savepoint ro');
      expect(cur.map((x) => x.code)).toEqual(codes);
      const sec = cr.renderSection(cur, tr, n).join('\n');
      expect(sec).not.toContain('bài mẫu');
      expect(sec).not.toContain('Phap Che Gia Lap');
    });
  });

  it('ceo-risk CLI --report trên DB: T-14, mức phí, XNQC-CHO-NOP đỏ', async () => {
    const out = fresh();
    const c = cap();
    expect(
      await ceoRiskMain(
        { report: true, now: '2026-12-17T09:00', outDir: out },
        { ...c.deps, open: async () => createPool(dsn), wire: null, env: {} },
      ),
    ).toBe(0);
    const page = readFileSync(join(out, 'ceo-risk-2026-12-17.md'), 'utf8');
    expect(page).toContain('T-14');
    expect(page).toContain('550.000 đồng/hồ sơ đến hết 31/12/2026');
    expect(page).toContain('1.100.000 đồng/hồ sơ từ 01/01/2027');
    expect(page).toContain('| ĐỎ | XNQC-CHO-NOP:savigout-30v |');
    expect(c.out.join('\n')).toContain('[done]');
  });

  // ------------------------------------------------------------ ceo_decisions E2E

  async function ceoFixture(c: pg.ClientBase) {
    const item = async (oid: string, decision: string | null) => {
      const qid = await submit(c, {
        block: 'ceo',
        objectType: 'decision_record',
        objectId: oid,
        title: `Quyết định ${oid}`,
        payload: `Nội dung ${oid}`,
        createdBy: 'agent:ceo_report',
      });
      if (decision) expect(await decide(c, qid, TGD, decision)).toEqual([true, null]);
      return String(qid);
    };
    const q1 = await item('qd-1', 'approved');
    const q2 = await item('qd-2', 'rejected');
    const q3 = await item('qd-3', null);
    // = decided_at (cùng tx): +1 phút từng vượt 00:00 VN → today ≠ decided_on
    const now = (await c.query('select now() as n')).rows[0].n as Date;
    const n = async () =>
      Number((await c.query('select count(*) as n from decision_log')).rows[0].n);
    const deps = (k: ReturnType<typeof cap>, clock: Date = now): CliDeps => ({
      ...k.deps,
      open: async () => asPool(c),
      wire: null,
      env: {},
      clock: () => clock,
    });
    return { q1, q2, q3, now, today: vnDate(now), n, deps };
  }

  it('đề xuất (chỉ đọc) → ghi → trùng/từ chối → theo dõi → đóng', async () => {
    await inTx(pool, async (c) => {
      const { q1, q2, q3, now, today, n, deps } = await ceoFixture(c);
      const due = vnDate(new Date(now.getTime() + 18 * 86_400_000));
      let k = cap();
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q1}`,
            topic: 'Duyệt báo cáo tuần',
            decision: 'Đồng ý phương án',
            by: THU_KY,
            due,
          },
          deps(k),
        ),
      ).toBe(0);
      const row = (
        await c.query(
          'select decided_by, decided_on::text as on, recorded_by, follow_status, basis_kind, basis_id::text as bid from decision_log',
        )
      ).rows[0];
      expect(row).toEqual({
        decided_by: TGD,
        on: today,
        recorded_by: THU_KY,
        follow_status: 'mo',
        basis_kind: 'approval_queue',
        bid: q1,
      });
      const n0 = await n();
      k = cap();
      // Date JS chỉ tới mili giây, decided_at = now() có micro giây → mốc +1 ms (Python giữ µs)
      const nowP = new Date(now.getTime() + 1);
      expect(await ceoDecisionsMain({ propose: true, now: nowP.toISOString() }, deps(k))).toBe(0);
      const out = k.out.join('\n');
      expect(await n()).toBe(n0);
      expect(out).toContain(`approval_queue #${q2} `);
      expect(out).not.toContain(`#${q1} `);
      expect(out).not.toContain(`#${q3} `);
      expect(out).toContain('[đề xuất] 1 mục');
      expect((await cd.propose(c, nowP, 30)).map((p) => p.id)).toEqual([q2]);
      // ngoài cửa sổ --days: không đề xuất
      expect(await cd.propose(c, new Date(nowP.getTime() + 31 * 86_400_000), 30)).toEqual([]);
      // trùng căn cứ → 1
      k = cap();
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q1}`,
            topic: 'Lần hai',
            decision: 'x',
            by: THU_KY,
          },
          deps(k),
        ),
      ).toBe(1);
      expect(k.err.join('\n')).toContain('đã ghi (#');
      expect(await n()).toBe(n0);
      // căn cứ pending / không tồn tại → 1
      for (const b of [
        `approval_queue:${q3}`,
        'approval_queue:999999',
        'approvals:999999',
        'decisions:999999',
      ]) {
        expect(
          await ceoDecisionsMain(
            { record: true, basis: b, topic: 'x', decision: 'y', by: THU_KY },
            deps(cap()),
          ),
          b,
        ).toBe(1);
      }
      // --decided-by khác người đã duyệt → 1
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q2}`,
            topic: 'x',
            decision: 'y',
            by: THU_KY,
            decidedBy: 'Người Khác',
          },
          deps(cap()),
        ),
      ).toBe(1);
      // topic có từ cấm → 1, 0 dòng
      k = cap();
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q2}`,
            topic: 'Sâm chữa bệnh',
            decision: 'y',
            by: THU_KY,
          },
          deps(k),
        ),
      ).toBe(1);
      expect(k.err.join('\n')).toContain('guardrail');
      expect(await n()).toBe(n0);
      // ngày tương lai → 1; hạn trước ngày quyết → 1
      const tomorrow = vnDate(new Date(now.getTime() + 86_400_000));
      const yesterday = vnDate(new Date(now.getTime() - 86_400_000));
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q2}`,
            topic: 'x',
            decision: 'y',
            by: THU_KY,
            date: tomorrow,
          },
          deps(cap()),
        ),
      ).toBe(1);
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q2}`,
            topic: 'x',
            decision: 'y',
            by: THU_KY,
            due: yesterday,
          },
          deps(cap()),
        ),
      ).toBe(1);
      expect(await n()).toBe(n0);
      // SĐT trong topic → lưu bản đã che; --decided-by cùng người (khác hoa thường/khoảng trắng) được
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q2}`,
            topic: 'Họp với đối tác 0905 123 456',
            decision: 'Từ chối',
            by: THU_KY,
            decidedBy: '  tgđ giả lập ',
          },
          deps(cap()),
        ),
      ).toBe(0);
      const topic = (await c.query('select topic from decision_log order by id desc limit 1'))
        .rows[0].topic as string;
      expect(topic).not.toContain('0905');
      expect(topic).not.toContain('123 456');
      expect(topic).toContain('***');
      const did = (
        await c.query('select id::text as id from decision_log where basis_id = $1', [q1])
      ).rows[0].id as string;
      // follow: dang_lam → xong (note) → đã đóng
      expect(
        await ceoDecisionsMain({ follow: did, status: 'dang_lam', by: THU_KY }, deps(cap())),
      ).toBe(0);
      expect(
        await ceoDecisionsMain(
          { follow: did, status: 'xong', by: THU_KY, note: 'Biên bản nghiệm thu số 7' },
          deps(cap()),
        ),
      ).toBe(0);
      k = cap();
      expect(await ceoDecisionsMain({ follow: did, status: 'huy', by: THU_KY }, deps(k))).toBe(1);
      expect(k.err.join('\n')).toContain('đã đóng (xong)');
      expect(
        await ceoDecisionsMain({ follow: '999999', status: 'huy', by: THU_KY }, deps(cap())),
      ).toBe(1);
      const st = Object.fromEntries(
        (await cd.read(c)).decisions.map((x) => [String(x.id), x.status]),
      );
      expect(st[did]).toBe('xong');
      // van_ban: cần decided-by + note ≥ 10
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            topic: 'Chọn nhà cung cấp hộp quà',
            decision: 'Chọn phương án B',
            by: THU_KY,
            decidedBy: TGD,
            note: 'Biên bản họp HĐTV số 05/2026',
            date: today,
          },
          deps(cap()),
        ),
      ).toBe(0);
    });
  });

  it('--list: quá hạn + mốc trễ; section trang TGĐ', async () => {
    await inTx(pool, async (c) => {
      const { q1, now, today, deps } = await ceoFixture(c);
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            basis: `approval_queue:${q1}`,
            topic: 'Triển khai quầy Tết',
            decision: 'Đồng ý',
            by: THU_KY,
            due: today,
          },
          deps(cap()),
        ),
      ).toBe(0);
      await c.query(
        "insert into project_milestones (code, title, owner_role, due_date, gate, status, source) values ('XNQC-NOP', 'Nộp hồ sơ', 'phap_che', $1, 'biên nhận', 'dang_lam', 'test')",
        [vnDate(new Date(now.getTime() - 5 * 86_400_000))],
      );
      const nxt = new Date(now.getTime() + 86_400_000);
      let k = cap();
      expect(await ceoDecisionsMain({ list: true, now: nxt.toISOString() }, deps(k))).toBe(0);
      const out = k.out.join('\n');
      expect(out).toContain('QUÁ HẠN');
      expect(out).toContain('TRỄ XNQC-NOP');
      expect(out).toContain('trễ 6 ngày');
      k = cap();
      expect(await ceoDecisionsMain({ list: true, now: now.toISOString() }, deps(k))).toBe(0);
      expect(k.out.join('\n')).not.toContain('QUÁ HẠN'); // hạn = hôm nay
      const sec = (await cd.section(c, vnDate(nxt))).join('\n');
      expect(sec).toContain('quá hạn thực hiện: 1');
      expect(sec).toContain('Triển khai quầy Tết');
      expect(sec).toContain(`người quyết ${TGD}`);
      expect(sec).toContain('**TRỄ** XNQC-NOP');
      expect(sec).toContain('owner phap_che');
    });
  });

  it('căn cứ decisions expired (system:sla) không phải quyết định người → từ chối', async () => {
    await inTx(pool, async (c) => {
      const { q3, deps, n } = await ceoFixture(c);
      const did = (
        await c.query(
          "insert into decisions (kind, queue_id, decided_by, reason) values ('expired', $1, 'system:sla', 'hết hạn SLA không ai duyệt') returning id::text as id",
          [q3],
        )
      ).rows[0].id;
      expect(
        await ceoDecisionsMain(
          { record: true, basis: `decisions:${did}`, topic: 'x', decision: 'y', by: THU_KY },
          deps(cap()),
        ),
      ).toBe(1);
      expect(await n()).toBe(0);
    });
  });

  it.each([
    'Xem https://evil.example/x',
    'Bấm [đây](javascript:alert)',
    '<img src=x onerror=alert(1)>',
    'Chủ đề `code`',
  ])('topic có link/HTML (OWASP A03) → từ chối: %s', async (topic) => {
    await inTx(pool, async (c) => {
      const { q2, deps, n } = await ceoFixture(c);
      expect(
        await ceoDecisionsMain(
          { record: true, basis: `approval_queue:${q2}`, topic, decision: 'y', by: THU_KY },
          deps(cap()),
        ),
      ).toBe(1);
      expect(await n()).toBe(0);
    });
  });

  it('--decided-by có link (van_ban) → từ chối', async () => {
    await inTx(pool, async (c) => {
      const { deps, n } = await ceoFixture(c);
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            topic: 'Chủ đề',
            decision: 'y',
            by: THU_KY,
            decidedBy: '[TGĐ](https://evil.example)',
            note: 'Biên bản họp HĐTV số 01',
          },
          deps(cap()),
        ),
      ).toBe(1);
      expect(await n()).toBe(0);
    });
  });

  it('sổ append-only: DB chặn UPDATE/DELETE, CHECK chặn agent ghi (lớp DB)', async () => {
    await inTx(pool, async (c) => {
      const { deps } = await ceoFixture(c);
      expect(
        await ceoDecisionsMain(
          {
            record: true,
            topic: 'Chủ đề',
            decision: 'y',
            by: THU_KY,
            decidedBy: TGD,
            note: 'Biên bản họp HĐTV số 01',
          },
          deps(cap()),
        ),
      ).toBe(0);
      await c.query('savepoint a');
      await expect(c.query("update decision_log set topic = 'z'")).rejects.toThrow(/append-only/);
      await c.query('rollback to savepoint a');
      await expect(
        c.query(
          "insert into decision_log (entry_kind, decided_on, topic, decision, decided_by, basis_kind, note, recorded_by) values ('quyet_dinh', '2026-10-01', 'x', 'y', 'agent:ceo', 'van_ban', 'Biên bản họp số 12', 'B')",
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('rollback to savepoint a');
    });
  });

  // ------------------------------------------------------------ C05 chờ quyết/chờ ký

  const SEC = (s: string[]) =>
    s.join('\n').split('### Việc chờ TGĐ quyết định / chờ ký')[1] as string;

  it('C05: việc chờ quyết (quá hạn) + chờ ký mốc + đối soát quý; mốc xong kèm bằng chứng → hết', async () => {
    await inTx(pool, async (c) => {
      const TODAY = '2026-11-12';
      await c.query(
        "insert into project_milestones (code, title, owner_role, due_date, gate, status, source, sign_required) values ('DUYET-1111', 'Duyệt văn bản 1111', 'tgd', '2026-11-09', 'văn bản ký', 'dang_lam', 'test', true), ('MOC-A', 'Mốc thường', 'du_an', '2026-11-01', 'g', 'dang_lam', 'test', false)",
      );
      // hạn = lúc enqueue + 48h (giờ thật 10/2026) → 12/11 là quá hạn
      await c.query('select enqueue_item($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)', [
        'weekly_report',
        'c5-1',
        'ceo',
        'Báo cáo tuần chờ TGĐ',
        'payload',
        'low',
        '{"ok": true}',
        'none',
        'agent:ceo_report',
        48,
      ]);
      await c.query(
        "insert into revenue_quarters (quarter, period_start, period_end, report_sha256, recorded_by) values ('2026-Q4', '2026-10-01', '2027-01-01', $1, 'agent:rev_share')",
        ['a'.repeat(64)],
      );
      let sec = SEC(cd.renderSection(await cd.read(c), TODAY));
      expect(sec).toContain('weekly_report · Báo cáo tuần chờ TGĐ');
      expect(sec).toContain('QUÁ HẠN');
      expect(sec).toContain('DUYET-1111');
      expect(sec).toContain('TRỄ 3 ngày');
      expect(sec).not.toContain('MOC-A');
      expect(sec).toContain('2026-Q4');
      expect(sec).toContain('chưa có bằng chứng ký');
      await c.query(
        "update project_milestones set status = 'xong', evidence = 'Văn bản số 12/QĐ' where code = 'DUYET-1111'",
      );
      sec = SEC(cd.renderSection(await cd.read(c), TODAY));
      expect(sec).not.toContain('DUYET-1111');
    });
  });

  it('C05: nguồn không đọc được (thiếu quyền) → ghi rõ, không im', async () => {
    await inTx(pool, async (c) => {
      const data = await cd.read(c);
      await c.query('savepoint r');
      await c.query('set local role app_human'); // không có revenue_quarters
      data.waiting_rev = await cd.tryRead(c, async () =>
        (await c.query(cd.WAIT_REV_SQL)).rows.map((r): cd.WaitRev => [r.quarter, r.ts]),
      );
      await c.query('rollback to savepoint r');
      expect(data.waiting_rev).toBeNull();
      expect(cd.waitLines(data, '2026-11-12').join('\n')).toContain(
        'không đọc được — thiếu quyền/bảng',
      );
    });
  });

  it('C05: login svc_job đọc được 3 nguồn (job bản tin)', async () => {
    await inTx(pool, async (c) => {
      await c.query('set local role svc_job');
      const data = await cd.read(c);
      expect([data.waiting_queue, data.waiting_rev]).toEqual([[], []]);
    });
  });

  // ------------------------------------------------------------ ceo_promo (ceo-04.5)

  const SKU = 'mat-ong-sam-300ml';
  const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
  const TODAY = '2026-10-14';
  const CEO = loadDirector('ceo');
  const NOW = new Date('2026-10-14T09:00:00+07:00');

  async function seedPromo(c: pg.ClientBase) {
    await replica(c, true);
    await c.query('delete from price_list where sku_key = any($1)', [[SKU, RUOU]]);
    for (const k of [SKU, RUOU]) {
      await c.query(
        "insert into price_list (sku_key, channel, kind, price_vnd, valid_from, approved_by) values ($1, 'shopee', 'list', 1000000, '2026-01-01', 'GD KD')",
        [k],
      );
    }
    await replica(c, false);
  }
  async function snapshot(
    c: pg.ClientBase,
    n: number,
    rows: [string | null, number, number | null][],
  ) {
    const sid = (
      await c.query(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', $1, $2, $3, $4) returning id",
        [
          `listing${n}.csv`,
          n.toString(16).padStart(64, '0'),
          rows.length,
          new Date(NOW.getTime() + n * 60_000),
        ],
      )
    ).rows[0].id;
    let i = 2;
    for (const [sku, price, sale] of rows) {
      await c.query(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, seller_sku, sku_key, title, price_vnd, raw) values ($1, $2, 'shopee', 'listing', $3, $4, $5, 'Tiêu đề bí mật', $6, $7)",
        [sid, i, `99${i}`, `SS-${i}`, sku, price, JSON.stringify({ sale_price: String(sale) })],
      );
      i++;
    }
  }
  const plan = (body: string) => {
    const p = join(tmp, `plan-${seq++}.csv`);
    writeFileSync(
      p,
      `program_id,kenh,sku_key,loai_km,ngay_bat_dau,ngay_ket_thuc,giam_pct\n${body}`,
    );
    const [rows, errs] = readPlan(p);
    expect(errs).toEqual([]);
    return rows;
  };
  const promo = (c: pg.ClientBase, p: ReturnType<typeof plan> | null = null, dryRun = false) =>
    cp.promoCheck(c, TODAY, {
      mapping: {},
      plan: p,
      runningFile: null,
      planSha: 'ab'.repeat(32),
      runningSha: null,
      cfg: CEO,
      dryRun,
    });
  const queue = async (c: pg.ClientBase) =>
    (
      await c.query(
        "select id::text as id, block, object_id, title, payload, status, created_by, guardrail from approval_queue where object_type = 'promo_deviation' order by id",
      )
    ).rows;

  it('ceo-04.5: lệch → mục promo_deviation theo ĐỢT (dry-run 0 ghi, chờ duyệt dồn, đã quyết + snapshot mới → đợt mới)', async () => {
    await inTx(pool, async (c) => {
      await seedPromo(c);
      await snapshot(c, 1, [
        [SKU, 1_000_000, 700_000],
        [RUOU, 1_000_000, 900_000],
        [null, 500_000, 400_000],
        [SKU, 1_000_000, null],
      ]);
      const p = plan(`P1,shopee,${SKU},giam_gia,2026-10-01,2026-10-31,20\n`);
      let r = await promo(c, p, true);
      expect(r.findings.map((f) => f.code).sort()).toEqual([
        'khong_xac_dinh_sku',
        'km_ngoai_ke_hoach',
        'km_sau_hon_duyet',
      ]);
      expect(await queue(c)).toEqual([]); // dry-run 0 ghi
      r = await promo(c, p);
      const q = await queue(c);
      expect([r.enqueued, q.length]).toEqual([3, 3]);
      for (const x of q) {
        expect([x.block, x.status, x.created_by]).toEqual(['ceo', 'pending', 'agent:ceo_audit']);
        expect(x.payload + x.title).not.toContain('Tiêu đề bí mật');
        expect(x.payload + x.title).not.toContain(RUOU); // nhóm rượu ẩn mã
        expect(x.guardrail.ok).toBe(true);
      }
      // chạy lại cùng bằng chứng → 0 mới; snapshot MỚI khi đang chờ → dồn
      expect((await promo(c, p)).enqueued).toBe(0);
      await snapshot(c, 2, [[SKU, 1_000_000, 700_000]]);
      expect((await promo(c, p)).enqueued).toBe(0);
      // đã quyết rồi mà snapshot mới VẪN lệch → đợt mới
      const sau = q.find((x) => x.title.includes('thấp hơn'));
      expect((await decide(c, sau.id, 'TGD', 'rejected'))[0]).toBe(true);
      await snapshot(c, 3, [[SKU, 1_000_000, 700_000]]);
      expect((await promo(c, p)).enqueued).toBe(1);
      // kế hoạch nới (giảm 30%) → hết lệch giá
      const p30 = plan(`P1,shopee,${SKU},giam_gia,2026-10-01,2026-10-31,30\n`);
      expect((await promo(c, p30, true)).findings).toEqual([]);
    });
  });

  it('ceo-04.5: giá KM golden ĐÃ duyệt = bản duyệt; mức chưa duyệt không tính', async () => {
    await inTx(pool, async (c) => {
      await seedPromo(c);
      await replica(c, true);
      await c.query(
        "insert into price_list (sku_key, channel, kind, price_vnd, program_id, valid_from, approved_by) values ($1, 'shopee', 'promo', 700000, 'TET27', '2026-10-01', 'GD KD'), ($1, 'shopee', 'promo', 600000, 'CHUADUYET', '2026-10-01', null)",
        [SKU],
      );
      await replica(c, false);
      await snapshot(c, 1, [[SKU, 1_000_000, 700_000]]);
      let r = await promo(c, null, true);
      expect([r.findings, r.ok]).toEqual([[], 1]);
      await snapshot(c, 2, [[SKU, 1_000_000, 600_000]]); // mức CHƯA duyệt
      r = await promo(c, null, true);
      expect(r.findings.map((f) => f.code)).toEqual(['km_sau_hon_duyet']);
    });
  });

  it('ceo-04.5: file xuất KM — chỉ dòng ĐANG chạy hôm nay', async () => {
    await inTx(pool, async (c) => {
      await seedPromo(c);
      const run = plan(
        `V1,shopee,${SKU},voucher,2026-11-01,2026-11-30,30\nV2,shopee,${SKU},voucher,2026-09-01,2026-09-30,30\nV3,shopee,${SKU},voucher,2026-10-10,2026-10-20,30\n`,
      );
      const r = await cp.promoCheck(c, TODAY, {
        mapping: {},
        plan: null,
        runningFile: run,
        planSha: null,
        runningSha: 'cd'.repeat(32),
        cfg: CEO,
        dryRun: true,
      });
      expect(r.running).toBe(1);
      expect(r.findings.map((f) => f.code)).toEqual(['km_ngoai_ke_hoach']);
      expect(r.items[0]?.payload).toContain('V3');
    });
  });

  it('ceo-04.5: tính năng TẮT → RolloutBlocked, 0 ghi', async () => {
    await inTx(pool, async (c) => {
      await seedPromo(c);
      await snapshot(c, 1, [[SKU, 1_000_000, 700_000]]);
      settings.forceMode = 'tat';
      try {
        await expect(promo(c)).rejects.toBeInstanceOf(RolloutBlocked);
      } finally {
        settings.forceMode = 'van_hanh';
      }
      expect(await queue(c)).toEqual([]);
    });
  });

  it('ceo-promo CLI --dry-run trên DB: in tóm tắt, KHÔNG ghi', async () => {
    const k = cap();
    const rc = await ceoPromoMain(
      { asOf: TODAY, dryRun: true },
      { ...k.deps, open: async () => createPool(dsn), wire: null, env: {} },
    );
    expect(rc).toBe(0);
    expect(k.out[0]).toBe(
      '[dry-run] ngày 2026-10-14: 0 KM đang chạy, khớp 0, lệch 0 (mới 0), bản duyệt chưa thấy chạy 0 · đẩy 0 mục — KHÔNG ghi DB',
    );
    expect(k.out.join('\n')).toContain('[info] không có --plan');
  });
});
