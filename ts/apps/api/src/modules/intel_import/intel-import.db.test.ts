import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import { loadConfig } from '@samsam/core/ops/director';
import { CsvReader } from '@samsam/core/ops/py-csv';
import { withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked, setConnector } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import GW from './__fixtures__/intel_weekly.golden.json' with { type: 'json' };
import {
  type CliDeps,
  intelImportMain,
  intelWeeklyMain,
  socialVendorMain,
} from './intel-import.command.js';
import * as ii from './intel-import.js';
import * as iw from './intel-weekly.js';

// Dịch phần DB của tests/test_intel_import.py (ràng buộc bảng, idempotent theo sha file, SKU lạ →
// rollback, lệch giá golden, trend + spike, social PII/dedup/DPIA, file hỏng không đổi gì, thiếu
// bảng, tên file che PII, cổng TẮT marketing-05.1), tests/test_social_vendor.py (nạp vendor không
// PII, dedup, không chạm social_mentions), tests/test_intel_weekly.py (báo cáo tất định, spike, chỉ
// đếm social, tin theo chủ đề, LLM giả qua guardrail, độ phủ PL01, --out-dir 2 báo cáo + cổng TẮT
// riêng từng báo cáo) và test_v14_p5/test_v15_p12 (gợi ý từ khóa: 1 mục/file, dry-run, skip, file mới
// = đợt mới, TẮT → không ghi, danh sách đối thủ chưa duyệt → chờ quyết). DB riêng từ mẫu (KHÔNG BAO
// GIỜ `samsam`), xóa khi xong. LLM luôn là nhà cung cấp GIẢ (đếm lời gọi).

const FIX = repoPath('tests/fixtures/intel_import');
const VFIX = repoPath('tests/fixtures/social_vendor');
const COMP = join(FIX, 'competitor_MAU.csv');
const TL = join(FIX, 'multiTimeline_MAU.csv');
const REL = join(FIX, 'relatedQueries_MAU.csv');
const SOC = join(FIX, 'social_fanpage_MAU.csv');
const SOC2 = join(FIX, 'social_fanpage_2_MAU.csv');
const SALT = 'salt-test-MAU-0123456789';
const NOW = new Date('2026-10-12T12:00:00+07:00');
const WEEK = '2026-10-08'; // tuần 2026-10-05 → 2026-10-11 (tuần cài spike)
const HEADS = ['## 1. Đối thủ', '## 2. Trend', '## 3. Social', '## 4. Tin thị trường'];
const V72 = [
  'intel_imports',
  'competitor_observations',
  'trends_weekly',
  'trends_related',
  'social_mentions',
];
const RESET = [
  ...V72,
  'social_mentions_vendor',
  'intel_items',
  'approval_queue',
  'decisions',
  'approvals',
  'agent_action_log',
  'report_outputs',
  'feature_rollout_events',
  'feature_rollout',
];
const INTEL = loadConfig('intel');

/** Mọi chuỗi định danh / SĐT / email gốc trong fixture social (+ nội dung/mã tin cho báo cáo). */
function socialStrings(withText: boolean): Set<string> {
  const out = new Set(['0912 345 678', 'khach.mau7@example.com', '+84 905 222 333']);
  for (const f of [SOC, SOC2]) {
    const [head, ...body] = [...new CsvReader(readFileSync(f, 'utf8'))];
    for (const r of body) {
      const rec = Object.fromEntries((head as string[]).map((h, i) => [h, r[i] ?? '']));
      for (const k of ['ten_nguoi_dung', 'id_nguoi_dung', 'sdt']) out.add(rec[k] as string);
      if (withText) {
        out.add(rec.noi_dung as string);
        out.add(rec.ma_tin as string);
      }
    }
  }
  out.delete('');
  return out;
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('intel_import (DB)', () => {
  const NAME = testDbName('intel_import');
  let pool: pg.Pool;
  let dsn: string;
  let tmp: string;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (table: string, where = 'true') =>
    Number((await q(`select count(*)::int as n from ${table} where ${where}`))[0]?.n);
  const counts = async () =>
    Object.fromEntries(await Promise.all(V72.map(async (t) => [t, await n(t)])));
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const deps = (c: ReturnType<typeof cap>, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: c.io,
    env: { DATABASE_URL: dsn, INTEL_HASH_SALT: SALT },
    clock: () => NOW,
    ...extra,
  });
  const imp = async (o: Parameters<typeof intelImportMain>[0], extra: Partial<CliDeps> = {}) => {
    const c = cap();
    const rc = await intelImportMain(o, deps(c, extra));
    return { rc, out: c.out.join('\n') };
  };
  const vendor = async (file: string, extra: Partial<CliDeps> = {}) => {
    const c = cap();
    const cfg = join(tmp, 'social_vendor.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        vendor_approved_by_tgd: true,
        approval_ref: 'BB-TEST-01',
        vendor_name: 'V',
      }),
    );
    const rc = await socialVendorMain({ file }, deps(c, { configFile: cfg, ...extra }));
    return { rc, out: c.out.join('\n') };
  };
  const weekly = async (o: Parameters<typeof intelWeeklyMain>[0], extra: Partial<CliDeps> = {}) => {
    const c = cap();
    const rc = await intelWeeklyMain(o, deps(c, extra));
    return { rc, out: c.out.join('\n'), err: c.err.join('\n') };
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'intel-db-'));
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn, { max: 4 });
  });

  afterAll(async () => {
    settings.forceMode = null;
    setConnector(null);
    await pool?.end();
    await dropDb(NAME);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    wireCore(pool);
    await withTx(pool, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(`truncate ${RESET.join(', ')} restart identity cascade`);
      await c.query("delete from price_list where valid_from = '2026-01-01'");
      await c.query("delete from sku_master where sku_key like 'mau-%'");
    });
  });

  // ------------------------------------------------------------------ intel_import

  it('ràng buộc bảng v7.2: CHECK + unique msg_hash', async () => {
    const iid = (
      await q(
        "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('competitor', 'x', 'sha-x', 1) returning id",
      )
    )[0]?.id;
    const okObs =
      "insert into competitor_observations (import_id, row_no, competitor, channel, product_name, price_vnd, rating, observed_on, source_ref) values ($1, $2, 'D', $3, 'p', $4, $5, '2026-10-06', 'https://a')";
    const soc =
      "insert into social_mentions (import_id, channel, kind, posted_at, msg_hash, labels, sensitive) values ($1, $2, 'comment', now(), $3, $4, false)";
    const cases: [string, unknown[]][] = [
      [okObs, [iid, 1, 'web', 0, null]],
      [okObs, [iid, 2, 'web', 100, 5.5]],
      [
        "insert into trends_weekly (import_id, query_id, keyword, anchor, geo, week, value) values ($1, 'q', 'k', 'a', 'g', '2026-10-04', 101)",
        [iid],
      ],
      [soc, [iid, 'facebook', 'h1', ['khen']]],
      [soc, [iid, 'fanpage', 'h2', []]],
      [
        "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('khac', 'y', 'sha-y', 1)",
        [],
      ],
    ];
    for (const [sql, p] of cases) {
      await expect(pool.query(sql, p)).rejects.toMatchObject({ code: '23514' });
    }
    await pool.query(soc, [iid, 'fanpage', 'h3', ['khen']]);
    await expect(pool.query(soc, [iid, 'zalo_oa', 'h3', ['che']])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('competitor: nạp → [skip] khi nạp lại (idempotent sha) → SKU lạ rollback, không đổi gì', async () => {
    let r = await imp({ competitor: COMP });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[load] competitor');
    const before = await counts();
    expect(before.competitor_observations).toBe(5);
    r = await imp({ competitor: COMP });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[skip]');
    expect(await counts()).toEqual(before);
    r = await imp({ competitor: join(FIX, 'competitor_bad_sku_MAU.csv') });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('dòng 2: sku_tuong_duong không có trong golden');
    expect(r.out).toContain('đã rollback');
    expect(await counts()).toEqual(before);
  });

  it('competitor_gaps: golden hiệu lực tại ngày quan sát, ưu tiên cùng kênh rồi web, kèm nguồn', async () => {
    await q(
      "insert into sku_master (sku_key, name, category, source) values ('mau-a', 'A', 'food', 'manual'), ('mau-b', 'B', 'food', 'manual'), ('mau-c', 'C', 'food', 'manual')",
    );
    const gp = async (sku: string, ch: string, price: number, day: string) =>
      String(
        (
          await q(
            "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ($1, $2, 'list', $3, $4) returning id",
            [sku, ch, price, day],
          )
        )[0]?.id,
      );
    const old = await gp('mau-a', 'shopee', 120000, '2026-01-01');
    await q("update price_list set valid_to = '2026-10-06' where id = $1", [old]);
    const fresh = await gp('mau-a', 'shopee', 100000, '2026-10-06');
    await q("update price_list set approved_by = 'GĐ MAU', approved_at = now() where id = $1", [
      fresh,
    ]);
    // mau-a có CẢ giá web (cùng ngày, id lớn hơn) → vẫn phải chọn shopee
    const webA = await gp('mau-a', 'web', 110000, '2026-10-06');
    const web = await gp('mau-b', 'web', 100000, '2026-01-01');
    const iid = (
      await q(
        "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('competitor', 'g', 'sha-g', 4) returning id",
      )
    )[0]?.id;
    const obs = (
      row: number,
      ch: string,
      sku: string,
      price: number,
      promo: number | null,
      day: string,
    ) =>
      q(
        "insert into competitor_observations (import_id, row_no, competitor, channel, product_name, sku_key, price_vnd, promo_price_vnd, observed_on, source_ref) values ($1, $2, 'DOI-THU-MAU-9', $3, 'p', $4, $5, $6, $7, $8)",
        [iid, row, ch, sku, price, promo, day, `https://src.example/${row}`],
      );
    await obs(1, 'shopee', 'mau-a', 90000, null, '2026-10-06');
    await obs(2, 'shopee', 'mau-a', 90000, 80000, '2026-10-06');
    await obs(3, 'lazada', 'mau-b', 95000, null, '2026-10-06');
    await obs(4, 'web', 'mau-c', 95000, null, '2026-10-06');
    await obs(5, 'web', 'mau-b', 95000, null, '2026-10-13');
    const gaps = await ii.competitorGaps(pool, '2026-10-08');
    expect(gaps.length).toBe(4);
    expect(gaps.every((g) => g.week === '2026-10-05')).toBe(true);
    const by = Object.fromEntries(gaps.map((g) => [g.source_ref.split('/').pop(), g]));
    expect([by['1']?.gap_pct, by['2']?.gap_pct]).toEqual([-0.1, -0.2]);
    expect(by['1']).toMatchObject({
      golden_ref: `price_list#${fresh}`,
      golden_vnd: 100000,
      golden_approved: true,
      golden_channel: 'shopee',
    });
    expect(Number(webA) > Number(fresh)).toBe(true);
    expect(by['2']?.golden_ref).toBe(`price_list#${fresh}`);
    expect(by['3']).toMatchObject({
      golden_ref: `price_list#${web}`,
      golden_channel: 'web',
      golden_approved: false,
    });
    expect(by['4']).toMatchObject({ golden_vnd: null, gap_pct: null, note: 'chưa có giá golden' });
    expect(gaps.every((g) => g.obs_ref.startsWith('obs#'))).toBe(true);
  });

  it('trend: timeline + spike, nạp lại [skip], related lưu seed chuẩn hóa + cờ rượu', async () => {
    let r = await imp({ trend: TL });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[spike] sâm ngọc linh tuần 2026-10-11: 55 (trung vị 20.5)');
    expect(await n('trends_weekly')).toBe(56);
    expect(await n('trends_weekly', "anchor = 'quà tết' and query_id is not null")).toBe(56);
    expect(r.out).toContain('[load] trend_timeline #1 multiTimeline_MAU.csv: 14 dòng');
    r = await imp({ trend: TL });
    expect([r.rc, r.out.includes('[skip]')]).toEqual([0, true]);
    expect(await n('trends_weekly')).toBe(56);
    r = await imp({ trend: REL, seed: 'Nhân Sâm' });
    expect(r.rc).toBe(0);
    expect(
      await q("select seed, query, flags from trends_related where 'ruou' = any(flags)"),
    ).toEqual([{ seed: 'nhân sâm', query: 'rượu sâm ngọc linh', flags: ['ruou'] }]);
  });

  it('social: không PII trong DB, excerpt null khi DPIA chưa ký, dedup theo msg_hash có muối', async () => {
    let r = await imp({ social: SOC, channel: 'fanpage' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('new=21 dup=0');
    const dump = [
      ...(await q('select row_to_json(s)::text as j from social_mentions s')),
      ...(await q('select row_to_json(i)::text as j from intel_imports i')),
    ]
      .map((x) => x.j)
      .join(' ');
    for (const s of socialStrings(false)) expect(dump, s).not.toContain(s);
    expect(await n('social_mentions', 'excerpt is not null')).toBe(0);
    const labels = Object.fromEntries(
      (
        await q('select l, count(*)::int as c from social_mentions, unnest(labels) l group by 1')
      ).map((x) => [x.l, x.c]),
    );
    expect([labels.hoi_suc_khoe, labels.hoi_ruou]).toEqual([3, 1]);
    expect(labels.khieu_nai).toBeGreaterThanOrEqual(3);
    expect(labels.hoi_gia).toBeGreaterThanOrEqual(3);
    expect(await n('social_mentions', 'sensitive')).toBe(3);
    r = await imp({ social: SOC, channel: 'fanpage' });
    expect([r.rc, r.out.includes('[skip]')]).toEqual([0, true]);
    r = await imp({ social: SOC2, channel: 'fanpage' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('new=3 dup=5');
    expect(await n('social_mentions')).toBe(24);
  });

  it('social DPIA đã ký: excerpt chỉ ở tin không nhạy cảm, đã che PII', async () => {
    const d = JSON.parse(readFileSync(ii.RULES_FILE, 'utf8'));
    d.dpia_signed = true;
    const p = join(tmp, 'rules_MAU.json');
    writeFileSync(p, JSON.stringify(d));
    const r = await imp({ social: SOC, channel: 'zalo_oa' }, { rulesFile: p });
    expect(r.rc).toBe(0);
    const rows = await q('select sensitive, excerpt from social_mentions');
    expect(rows.filter((x) => x.sensitive).every((x) => x.excerpt === null)).toBe(true);
    expect(rows.filter((x) => !x.sensitive).every((x) => x.excerpt)).toBe(true);
    const ex = rows.map((x) => x.excerpt ?? '').join(' ');
    for (const s of socialStrings(false)) expect(ex).not.toContain(s);
  });

  it('marketing-05.1 TẮT → [blocked] exit 2, không ghi gì (HĐ 6.7)', async () => {
    settings.forceMode = 'tat';
    const r = await imp({ social: SOC, channel: 'fanpage' });
    expect(r.rc).toBe(2);
    expect(r.out).toContain('[blocked]');
    expect(r.out).toContain('marketing-05.1');
    expect(await n('intel_imports')).toBe(0);
    expect(await n('social_mentions')).toBe(0);
  });

  it('file hỏng không đổi gì; tên file có SĐT/email được che', async () => {
    await imp({ competitor: COMP });
    const before = await counts();
    for (const o of [
      { competitor: join(FIX, 'competitor_bad_gia_MAU.csv') },
      { trend: join(FIX, 'multiTimeline_no_anchor_MAU.csv') },
      { social: join(FIX, 'social_bad_cot_la_MAU.csv'), channel: 'fanpage' },
    ]) {
      expect((await imp(o)).rc).toBe(1);
    }
    expect(await counts()).toEqual(before);
    const p = join(tmp, 'gia_0905123456_a.b@example.com_MAU.csv');
    // sha khác (thêm 1 dòng trống cuối) để không bị [skip]
    writeFileSync(p, Buffer.concat([readFileSync(COMP), Buffer.from('\n')]));
    const r = await imp({ competitor: p });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[load] competitor');
    const names = (await q('select file_name from intel_imports'))
      .map((x) => x.file_name)
      .join(' ');
    for (const s of ['0905123456', 'a.b@example.com']) {
      expect(names).not.toContain(s);
      expect(r.out).not.toContain(s);
    }
  });

  // ------------------------------------------------------------------ social_vendor

  it('vendor: nạp không PII, dedup, [skip] nạp lại, overlap new=1 dup=1, không chạm social_mentions', async () => {
    const PII =
      /NGUOI DANG GIA|0900000000|profile\.gia|nguoidanggia|avatar-gia|post\/gia|bai-gia|u10[0-9]/;
    const owned = await n('social_mentions');
    let r = await vendor(join(VFIX, 'vendor_export.csv'));
    expect(r.rc).toBe(0);
    expect(await n('social_mentions_vendor')).toBe(4);
    const blob = (
      await q(
        'select row_to_json(s)::text as j from social_mentions_vendor s union all select row_to_json(i)::text from intel_imports i',
      )
    )
      .map((x) => x.j)
      .join(' ');
    expect(blob).not.toMatch(PII);
    expect(await n('social_mentions_vendor', 'excerpt is not null')).toBe(0);
    expect(await q('select kind, channel, row_count from intel_imports')).toEqual([
      { kind: 'social', channel: 'vendor', row_count: 4 },
    ]);
    const fb = (
      await q("select sensitive, labels from social_mentions_vendor where platform = 'facebook'")
    )[0];
    expect(fb?.sensitive).toBe(true);
    expect(fb?.labels).toContain('hoi_suc_khoe');
    expect(
      (await q("select labels from social_mentions_vendor where platform = 'tiktok'"))[0]?.labels,
    ).toContain('hoi_ruou');
    expect(r.out).toContain('new=4 dup=0');
    expect(r.out).not.toMatch(PII);
    r = await vendor(join(VFIX, 'vendor_export.csv'));
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[skip] file đã nạp');
    expect(await n('social_mentions_vendor')).toBe(4);
    r = await vendor(join(VFIX, 'vendor_export_overlap.csv'));
    expect(r.rc).toBe(0);
    expect(r.out).toContain('new=1 dup=1');
    expect(await n('social_mentions_vendor')).toBe(5);
    expect(await n('social_mentions')).toBe(owned);
  });

  it.each([['vendor_bad_column.csv'], ['vendor_bad_platform.csv']])(
    'vendor file hỏng %s → exit 1, 0 dòng',
    async (f) => {
      expect((await vendor(join(VFIX, f))).rc).toBe(1);
      expect(await n('social_mentions_vendor')).toBe(0);
      expect(await n('intel_imports')).toBe(0);
    },
  );

  // ------------------------------------------------------------------ intel_weekly

  const seed = async () => {
    const [cfg] = ii.loadTrendConfig();
    const [rules] = ii.loadSocialRules();
    // golden mẫu có valid_from = ngày dựng DB → thêm giá web hiệu lực từ đầu năm cho 1 SKU (chưa duyệt)
    await q(
      "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ('savina-12v', 'web', 'list', 160000, '2026-01-01')",
    );
    const [rows, errs, sha] = await ii.readCompetitor(COMP, '2026-10-12');
    expect(errs).toEqual([]);
    expect((await ii.loadCompetitor(pool, rows, 'competitor_MAU.csv', sha as string))[1]).toEqual(
      [],
    );
    const [, tl, , s2] = await ii.readTrend(TL, cfg as ii.TrendCfg);
    await ii.loadTrendTimeline(
      pool,
      tl as ii.TimelineRow[],
      cfg as ii.TrendCfg,
      'multiTimeline_MAU.csv',
      s2 as string,
    );
    const [, rel, , s3] = await ii.readTrend(REL, cfg as ii.TrendCfg);
    await ii.loadTrendRelated(
      pool,
      rel as ii.RelatedRow[],
      'nhân sâm',
      'relatedQueries_MAU.csv',
      s3 as string,
    );
    const [soc, , s4] = await ii.readSocial(SOC, 'fanpage', rules as ii.SocialRules, NOW);
    await ii.loadSocial(pool, soc, 'fanpage', SALT, 'social_fanpage_MAU.csv', s4 as string);
    const items: [string, string[], number][] = [
      ['Tin MẪU sâm ngọc linh mùa thu hoạch', ['sam'], 6],
      ['Tin MẪU quảng cáo TPBVSK bị phạt', ['quang_cao', 'tpbvsk'], 7],
      ['Tin MẪU tuần trước', ['sam'], 1],
    ];
    for (const [i, [t, topics, day]] of items.entries()) {
      await q(
        "insert into intel_items (url, domain, source, tier, title, fetched_at, content_sha256, topics) values ($1, 'bao.example.vn', 'fx', 'A', $2, $3, $4, $5)",
        [
          `https://bao.example.vn/${i}`,
          t,
          new Date(`2026-10-${String(day).padStart(2, '0')}T09:00:00+07:00`),
          `sha-${i}`,
          topics,
        ],
      );
    }
  };

  /** Nhà cung cấp LLM GIẢ: đếm lời gọi, trả chữ/ném lỗi theo kịch bản. */
  const fakeAi = (reply: string | Error) => {
    const calls: [string, unknown][] = [];
    return {
      calls,
      gateway: {
        chat: async (agent: string, messages: unknown) => {
          calls.push([agent, messages]);
          if (reply instanceof Error) throw reply;
          return { text: reply, model: 'gia', provider: 'gia', tokensIn: 0, tokensOut: 0 };
        },
      } as unknown as CliDeps['gateway'],
    };
  };
  const llmOn = () => {
    const p = join(tmp, 'intel_sources.json');
    const d = JSON.parse(readFileSync(repoPath('data/intel_sources.json'), 'utf8'));
    d.llm = { ...(d.llm ?? {}), enabled: true };
    writeFileSync(p, JSON.stringify(d));
    return p;
  };

  it('báo cáo tất định: 4 mục, spike đúng tuần, mỗi số có nguồn, social chỉ đếm, không LLM', async () => {
    await seed();
    const ai = fakeAi('x');
    const a = await weekly({ week: WEEK }, { gateway: ai.gateway });
    const b = await weekly({ week: WEEK }, { gateway: ai.gateway });
    expect([a.rc, b.rc]).toEqual([0, 0]);
    expect(Buffer.from(a.out).equals(Buffer.from(b.out))).toBe(true);
    for (const h of HEADS) expect(a.out).toContain(h);
    expect(a.out).toContain('# Báo cáo tuần intel 2026-10-05 → 2026-10-11');
    const spikes = a.out.split('\n').filter((l) => l.includes('TĂNG ĐỘT BIẾN'));
    expect(spikes.length).toBe(1);
    expect(spikes[0]).toContain('sâm ngọc linh');
    expect(spikes[0]).toContain('tuần 2026-10-11: 55 so trung vị 20.5');
    expect(spikes[0]).toContain('query_id');
    const comp = a.out.split('## 2.')[0] as string;
    expect(comp.split('obs#').length - 1).toBe(4);
    expect(comp).toContain('price_list#');
    expect(comp).toContain('CHƯA duyệt');
    expect(comp).toContain('chưa có giá golden');
    expect(a.out).toContain('rượu sâm ngọc linh: +120% (rượu — không dùng cho nhóm giới trẻ)');
    const soc = (a.out.split('## 3.')[1] as string).split('## 4.')[0] as string;
    expect(soc).toContain('| fanpage | 21 |');
    expect(soc).toContain('| 3 |');
    const news = a.out.split('## 4.')[1] as string;
    expect(news).toContain('Tin MẪU sâm ngọc linh');
    expect(news).not.toContain('Tin MẪU tuần trước');
    for (const s of socialStrings(true)) expect(a.out, s).not.toContain(s);
    expect(ai.calls).toEqual([]);
  });

  it('tuần khác: không in lại spike; tuần trống → 5 mục "chưa có dữ liệu"; chỉ đọc (không ghi bảng nào)', async () => {
    const before = [await n('content_drafts'), await n('agent_action_log'), await n('approvals')];
    await seed();
    let r = await weekly({ week: '2026-10-01' });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('TĂNG ĐỘT BIẾN');
    expect(r.out).toContain('- không có');
    r = await weekly({ week: '2026-10-14' });
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('TĂNG ĐỘT BIẾN');
    r = await weekly({ week: '2026-06-01' });
    expect(r.rc).toBe(0);
    expect(r.out.split('chưa có dữ liệu tuần này').length - 1).toBe(5);
    expect([await n('content_drafts'), await n('agent_action_log'), await n('approvals')]).toEqual(
      before,
    );
  });

  it('LLM: cổng tắt → cảnh báo, 0 lời gọi; bật → 1 lời gọi KHÔNG có mục social; guardrail/gateway chặn → bỏ tóm tắt', async () => {
    await seed();
    let ai = fakeAi('Tuần này giá đối thủ thấp hơn golden ở 2 SKU.');
    let r = await weekly({ week: WEEK, llm: true }, { gateway: ai.gateway });
    expect(r.rc).toBe(0);
    expect(r.err).toContain('[warn]');
    expect(ai.calls).toEqual([]);
    expect(r.out).not.toContain('Tóm tắt (LLM');
    const src = llmOn();
    r = await weekly({ week: WEEK, llm: true }, { gateway: ai.gateway, sourcesFile: src });
    expect(r.rc).toBe(0);
    expect(ai.calls.length).toBe(1);
    expect(ai.calls[0]?.[0]).toBe('intel');
    const payload = JSON.stringify(ai.calls[0]?.[1]);
    expect(payload).toContain('## 1. Đối thủ');
    expect(payload).not.toContain('## 3. Social');
    for (const s of socialStrings(true))
      expect(payload).not.toContain(JSON.stringify(s).slice(1, -1));
    expect(r.out).toContain('Tóm tắt (LLM');
    expect(r.out).toContain('golden ở 2 SKU');
    ai = fakeAi('Sâm giúp chữa bệnh tiểu đường.');
    r = await weekly({ week: WEEK, llm: true }, { gateway: ai.gateway, sourcesFile: src });
    expect([r.rc, ai.calls.length]).toEqual([0, 1]);
    expect(r.out).not.toContain('chữa');
    expect(r.err).toContain('guardrail');
    ai = fakeAi(new GatewayBlocked('cap'));
    r = await weekly({ week: WEEK, llm: true }, { gateway: ai.gateway, sourcesFile: src });
    expect(r.rc).toBe(0);
    expect(r.err).toContain('[warn] LLM lỗi (GatewayBlocked)');
    for (const h of HEADS) expect(r.out).toContain(h);
  });

  it('độ phủ PL01: K5 THIẾU, TRIMICO/KGC đếm quan sát + KM', async () => {
    await seed();
    const p = join(tmp, 'competitor_pl01_MAU.csv');
    writeFileSync(
      p,
      'doi_thu,kenh,ten_san_pham,sku_tuong_duong,gia_vnd,gia_km_vnd,khuyen_mai,rating,so_danh_gia,ngay_ghi,nguon,ghi_chu\n' +
        'Trimico,shopee,Viên sâm MẪU A,savina-12v,150000,140000,KM,,,2026-10-06,https://shopee.vn/product/t/1,MẪU\n' +
        'KGC Cheong Kwan Jang,web,Hồng sâm MẪU B,,500000,,,,,2026-10-07,https://kgc.example.com/b,MẪU\n',
    );
    const [rows, errs, sha] = await ii.readCompetitor(p, '2026-10-12');
    expect(errs).toEqual([]);
    expect(
      (await ii.loadCompetitor(pool, rows, 'competitor_pl01_MAU.csv', sha as string))[1],
    ).toEqual([]);
    const r = await weekly({ week: WEEK });
    const comp = r.out.split('## 2.')[0] as string;
    expect(r.rc).toBe(0);
    expect(comp).toContain('Độ phủ đối thủ theo PL01');
    expect(comp).toContain('- K5: **THIẾU dữ liệu tuần này**');
    expect(comp).toContain('- TRIMICO: 1 quan sát giá, 1 có giá KM');
    expect(comp).toContain('- KGC: 1 quan sát giá, 0 có giá KM');
  });

  it('--out-dir: 2 báo cáo intel-doithu-/intel-trend-; TẮT → [rollout] exit 2, không ghi', async () => {
    await seed();
    const dir = join(tmp, 'reports');
    let r = await weekly({ week: WEEK, outDir: dir });
    expect(r.rc).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      'intel-doithu-2026-10-05.md',
      'intel-trend-2026-10-05.md',
    ]);
    expect(r.out).toContain('[done]');
    expect(readFileSync(join(dir, 'intel-trend-2026-10-05.md'), 'utf8')).toContain('TĂNG ĐỘT BIẾN');
    const dir2 = join(tmp, 'reports2');
    settings.forceMode = 'tat';
    r = await weekly({ week: WEEK, outDir: dir2 });
    expect(r.rc).toBe(2);
    expect(r.out.split('\n').filter((l) => l.startsWith('[rollout]')).length).toBe(2);
    expect(r.out).not.toContain('[done]');
  });

  it('--out-dir r12 G1-L1: intel-03 TẮT không làm mất báo cáo trend của intel-04.1', async () => {
    await seed();
    settings.forceMode = null;
    setConnector(async () => ({ db: pool, release: async () => {} }));
    await q(
      "insert into feature_rollout (feature_id, stage, updated_by) values ('intel-03', 'tat', 'Người Giả Lập'), ('intel-04.1', 'van_hanh', 'Người Giả Lập')",
    );
    const dir = join(tmp, 'reports3');
    const r = await weekly({ week: WEEK, outDir: dir });
    expect(r.rc).toBe(2);
    expect(readdirSync(dir)).toEqual(['intel-trend-2026-10-05.md']);
    expect(r.out).toContain(
      '[rollout] báo cáo intel-doithu-2026-10-05.md: tính năng intel-03 đang tắt',
    );
    expect(await n('report_outputs', "feature_id = 'intel-04.1'")).toBe(1);
  });

  // ------------------------------------------------------------------ gợi ý từ khóa (intel-04.2)

  const trends = async (name = 'related_MAU.csv', rows?: [string, string, string, string][]) => {
    const iid = (
      await q(
        "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('trend_related', $1, $2, 5) returning id",
        [name, `${Math.random().toString(16).slice(2)}${Date.now()}`],
      )
    )[0]?.id;
    for (const [s, sec, qq, v] of rows ?? [
      ['sâm ngọc linh', 'rising', 'hộp quà sâm biếu tết', '+250%'],
      ['sâm ngọc linh', 'top', 'sâm ngọc linh chữa ung thư', '100'],
      ['sâm ngọc linh', 'rising', 'rượu sâm ngọc linh', 'Breakout'],
      ['sâm ngọc linh', 'top', 'Hộp quà sâm biếu Tết', '80'],
      ['sâm ngọc linh', 'top', 'sam ngoc linh tri tieu duong', '40'],
    ]) {
      await q(
        'insert into trends_related (import_id, seed, section, query, value) values ($1, $2, $3, $4, $5)',
        [iid, s, sec, qq, v],
      );
    }
    return Number(iid);
  };
  const queue = async () =>
    q(
      "select id::text as id, block, object_id, title, payload, status, created_by, is_sample, guardrail from approval_queue where object_type = 'keyword_suggest' order by id",
    );

  it('1 mục/file: dry-run không ghi, mục qua guardrail không chép từ loại, chạy lại skip, file mới = đợt mới', async () => {
    const iid = await trends();
    let r = await iw.suggestKeywords(pool, null, INTEL, true);
    expect(r.res?.safe.map((s) => s[3])).toEqual(['hộp quà sâm biếu tết']);
    expect(r.res?.excluded.length).toBe(3); // trùng hoa/thường gộp
    expect(await queue()).toEqual([]);
    r = await iw.suggestKeywords(pool, null, INTEL);
    const qq = await queue();
    expect(qq.length).toBe(1);
    expect(String(r.qid)).toBe(qq[0]?.id);
    expect(qq[0]).toMatchObject({
      block: 'intel',
      object_id: `kw:${iid}`,
      created_by: 'agent:intel_keywords',
      is_sample: true,
    });
    expect(qq[0]?.guardrail.ok).toBe(true);
    for (const leak of ['chữa', 'ung thư', 'rượu', 'tieu duong']) {
      expect(qq[0]?.payload).not.toContain(leak);
    }
    expect((await iw.suggestKeywords(pool, null, INTEL)).skipped).toBe(true);
    expect((await queue()).length).toBe(1);
    await trends('related_2.csv'); // file mới = đợt mới
    expect((await iw.suggestKeywords(pool, null, INTEL)).qid).not.toBeNull();
    expect((await queue()).map((x) => x.is_sample)).toEqual([true, false]);
  });

  it('chưa có file → res null; intel-04.2 TẮT → RolloutBlocked, không ghi (kể cả dry-run qua CLI)', async () => {
    expect((await iw.suggestKeywords(pool, null, INTEL)).res).toBeNull();
    await trends();
    settings.forceMode = 'tat';
    await expect(iw.suggestKeywords(pool, null, INTEL)).rejects.toBeInstanceOf(RolloutBlocked);
    const r = await weekly({ suggestKeywords: true, dryRun: true }, { wire: () => undefined });
    expect(r.rc).toBe(2);
    expect(r.out).toContain('[rollout]');
    expect(r.out).toContain('intel-04.2');
    expect(await queue()).toEqual([]);
  });

  it('CLI --suggest-keywords: dry-run in payload + [dry-run]; lượt thật [ok]; lần 2 [skip]', async () => {
    await trends();
    let r = await weekly({ suggestKeywords: true, dryRun: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Gợi ý từ khóa an toàn pháp lý');
    expect(r.out).toMatch(/\[dry-run\] kw:\d+ — KHÔNG ghi DB/);
    expect(await queue()).toEqual([]);
    r = await weekly({ suggestKeywords: true });
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/\[ok\] mục hàng duyệt #\d+ \(keyword_suggest, chờ Quản lý Marketing\)/);
    r = await weekly({ suggestKeywords: true });
    expect(r.out).toMatch(/\[skip\] kw:\d+ đã có mục #\d+/);
    r = await weekly({ suggestKeywords: true, import: '999999' });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('[info] không có file Google Trends related');
  });

  const COMP_ROWS: [string, string, string, string][] = [
    ['nhân sâm', 'rising', 'hộp quà sâm biếu tết', '+250%'],
    ['nhân sâm', 'top', 'nhân sâm hàn quốc', '100'],
    ['nhân sâm', 'top', 'nhan sam han quoc 6 nam', '90'],
    ['hồng sâm kgc', 'rising', 'hồng sâm KGC chính hãng', '+80%'],
  ];
  const compFile = (extra: Record<string, unknown>) => {
    const d = JSON.parse(readFileSync(iw.COMPETITORS_FILE, 'utf8'));
    const p = join(tmp, `kc_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ ...d, ...extra }));
    return iw.loadCompetitors(p);
  };

  it('P12.4: danh sách đối thủ CHƯA duyệt → nhóm CHỜ QUYẾT, không vào đề xuất; CLI báo [cho-quyet]', async () => {
    const iid = await trends('related_2.csv', COMP_ROWS);
    const r = await iw.suggestKeywords(pool, iid, INTEL);
    expect(r.res?.safe.map((s) => s[3])).toEqual(['hộp quà sâm biếu tết']);
    expect(r.res?.cho_quyet.map((x) => x[1])).toEqual([
      'nhân sâm hàn quốc',
      'nhan sam han quoc 6 nam',
      'hồng sâm KGC chính hãng',
    ]);
    const payload = (await queue())[0]?.payload as string;
    const [head, pend] = payload.split('CHỜ QUYẾT') as [string, string];
    expect(head).not.toContain('hàn quốc');
    expect(head).not.toContain('KGC');
    expect(head).toContain('(gốc: nhân sâm)'); // gốc không phải đối thủ: giữ
    expect(pend).toContain('nhân sâm hàn quốc');
    expect(pend).toContain('CHƯA được Pháp chế');
    expect(check(payload).ok).toBe(true);
    expect((await queue())[0]?.object_id).toBe(`kw:${iid}`);
  });

  it('P12.4: danh sách ĐÃ duyệt — loai → lý do doi_thu; cho_nguoi_quyet → chờ quyết; đợt mới theo sha', async () => {
    const iid = await trends('related_2.csv', COMP_ROWS);
    const ok = {
      trang_thai: 'da_duyet',
      duyet_boi: 'Pháp Chế Giả Lập',
      can_cu: 'Biên bản giả lập',
    };
    const loai = compFile({ ...ok, xu_ly: 'loai' });
    let res = await iw.keywordSuggestions(pool, iid, loai);
    expect(res?.cho_quyet).toEqual([]);
    expect(res?.excluded.length).toBe(3);
    expect(res?.excluded.every(([, why]) => why.includes('doi_thu'))).toBe(true);
    const hold = compFile({ ...ok, xu_ly: 'cho_nguoi_quyet' });
    res = await iw.keywordSuggestions(pool, iid, hold);
    expect([res?.cho_quyet.length, res?.excluded]).toEqual([3, []]);
    const r = await iw.suggestKeywords(pool, iid, INTEL, false, loai);
    expect(r.object_id).toBe(`kw:${iid}:dt-${loai.sha.slice(0, 8)}`);
    expect(r.payload).toContain('thương hiệu/xuất xứ đối thủ 3');
  });

  it('danh sách đối thủ hỏng → [err] … fail-closed exit 1, không ghi', async () => {
    await trends();
    const p = join(tmp, 'kc_hong.json');
    writeFileSync(p, '{');
    const r = await weekly({ suggestKeywords: true }, { competitorsFile: p });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('— không đề xuất (fail-closed)');
    expect(await queue()).toEqual([]);
  });

  // cuối cùng: phá bảng — chạy SAU các ca khác (vitest chạy tuần tự theo thứ tự khai báo)
  it('thiếu bảng → gợi ý chạy apply_schema, exit 1, không commit', async () => {
    await pool.query('drop table social_mentions cascade');
    const r = await imp({ social: SOC, channel: 'fanpage' });
    expect(r.rc).toBe(1);
    expect(r.out).toContain('apply_schema');
    expect(await n('intel_imports')).toBe(0);
    const w = await weekly({ week: WEEK });
    expect(w.rc).toBe(1);
    expect(w.out).toContain('thiếu bảng social_mentions');
  });
});

// Golden byte-for-byte: `scripts/intel_weekly.render` THẬT chạy trên DB test riêng dựng từ CÙNG mẫu
// (script golden_weekly.py ở scratchpad), dữ liệu nạp như dưới (loader TS) → báo cáo phải y hệt, kể
// cả id `obs#`/`price_list#` (DB mới từ mẫu), làm tròn lệch giá kiểu Python (-0.0625 → -6.2%).
describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('intel_weekly golden (DB)', () => {
  const NAME = testDbName('intel_weekly_g');
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(NAME), { max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
  });

  it('render() khớp Python cho 4 tuần (đầy đủ + phần gửi LLM)', async () => {
    const [cfg] = ii.loadTrendConfig();
    const [rules] = ii.loadSocialRules();
    const c = cfg as ii.TrendCfg;
    await pool.query(
      "insert into price_list (sku_key, channel, kind, price_vnd, valid_from) values ('savina-12v', 'web', 'list', 160000, '2026-01-01')",
    );
    const [rows, errs, sha] = await ii.readCompetitor(COMP, '2026-10-12');
    expect(errs).toEqual([]);
    expect((await ii.loadCompetitor(pool, rows, 'competitor_MAU.csv', sha as string))[1]).toEqual(
      [],
    );
    const [, tl, , s2] = await ii.readTrend(TL, c);
    await ii.loadTrendTimeline(
      pool,
      tl as ii.TimelineRow[],
      c,
      'multiTimeline_MAU.csv',
      s2 as string,
    );
    const [, rel, , s3] = await ii.readTrend(REL, c);
    await ii.loadTrendRelated(
      pool,
      rel as ii.RelatedRow[],
      'nhân sâm',
      'relatedQueries_MAU.csv',
      s3 as string,
    );
    const [soc, , s4] = await ii.readSocial(SOC, 'fanpage', rules as ii.SocialRules, NOW);
    await ii.loadSocial(pool, soc, 'fanpage', SALT, 'social_fanpage_MAU.csv', s4 as string);
    await pool.query(
      "update price_list set approved_by = 'GĐ MAU' where sku_key = 'savina-12v' and valid_from = '2026-01-01'",
    );
    const items: [string, string[], number][] = [
      ['Tin MẪU sâm ngọc linh mùa thu hoạch', ['sam'], 6],
      ['Tin MẪU quảng cáo TPBVSK | bị phạt', ['quang_cao', 'tpbvsk'], 7],
      ['Tin MẪU tuần trước', ['sam'], 1],
    ];
    for (const [i, [t, topics, day]] of items.entries()) {
      await pool.query(
        "insert into intel_items (url, domain, source, tier, title, fetched_at, content_sha256, topics) values ($1, 'bao.example.vn', 'fx', 'A', $2, $3, $4, $5)",
        [
          `https://bao.example.vn/${i}`,
          t,
          new Date(`2026-10-0${day}T09:00:00+07:00`),
          `sha-${i}`,
          topics,
        ],
      );
    }
    for (const [week, want] of Object.entries(
      GW as Record<string, { full: string; payload: string }>,
    )) {
      const [full, payload] = await iw.render(pool, week, c);
      expect(full, week).toBe(want.full);
      expect(payload, week).toBe(want.payload);
    }
  });
});
