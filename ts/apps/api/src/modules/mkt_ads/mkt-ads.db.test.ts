import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { autoApprove, decide } from '@samsam/core/ops/approval-queue';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { run as directorRun, loadConfig, submit } from '@samsam/core/ops/director';
import { saveDraft } from '@samsam/core/ops/store';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { featureFor, RolloutBlocked, settings } from '@samsam/core/rollout/rollout';
import { checkPublish } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import FDB from './__fixtures__/fpa_db.golden.json' with { type: 'json' };
import { decStr } from './dec.js';
import { type AdsCfg, fetchReadiness, propose as fpPropose, loadCfg } from './fp-ads.js';
import { compute, vnd } from './fp-pnl.js';
import { DEFAULT_QUOTA, fpAdsMain, mktAdsMain } from './mkt-ads.command.js';
import {
  BUDGET_AGENT,
  FLAG_OVER,
  ITEMS,
  NOT_APPROVED,
  PROPOSE_AGENT,
  type ProposalCfg,
} from './mkt-ads.js';
import {
  capFor,
  type Dcfg,
  getPlan,
  loadCfgs,
  loadContext,
  planStatus,
  propose,
  submitPlan,
} from './mkt-ads.service.js';
import { build, loadInputs, loadQuota } from './mkt-calendar.js';
import { bulletin, enqueueBriefs, forecastLoad, queueItems } from './mkt-director.js';

// Dịch phần DB của tests/test_mkt_ads.py, tests/test_docx_mkt03.py, tests/test_fp_ads.py,
// tests/test_mkt_director.py, P8.2 của tests/test_v15_p8_outputs.py, ad_result của
// tests/test_contract_finalize.py. Dữ liệu FP&A MẪU (đơn sàn + quyết toán tests/fixtures/finance) nạp
// bằng loader Python THẬT rồi dump → `__fixtures__/fpa_db.golden.json` (kèm P&L/trần Python tính trên
// cùng dữ liệu — TS phải ra y hệt). DB riêng `samsam_ts_mkt_ads` dựng lại từ mẫu MỖI ca (như schema
// tạm + ROLLBACK của Python) — KHÔNG BAO GIỜ DB `samsam`. Rollout ép `van_hanh` (conftest Python
// `_FORCE_MODE`), ca cổng TẮT ép `tat`.

const NAME = 'samsam_ts_mkt_ads';
const OCT = '2026-10-01';
const TODAY = '2026-10-12';
const HONEY = 'mat-ong-sam-300ml';
const ALCOHOL = ['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml'];
const AD_TEXT =
  'Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao Nội dung có sử dụng AI';
const BAN = /rượu|ruou|alcohol/i;
const PLAN_FILE = repoPath('tests', 'fixtures', 'mkt', 'ads_plan_mat_ong_MAU.json');
const RESULT_FILE = repoPath('tests', 'fixtures', 'mkt', 'ads_ket_qua_MAU.csv');
const PCFG = {
  chot_boi: 'GĐ Marketing Giả Lập',
  can_cu: 'biên bản giả test',
  ty_le_tran: 0.5,
  so_ngay_chay: 14,
  bat_dau_sau_ngay: 1,
  success_metric: { metric: 'cpa', op: '<=', target: 80000 },
  stop_rules: [{ metric: 'cpa', op: '>=', value: 150000 }],
} as ProposalCfg;
const VN = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h - 7));
const js = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));

const plan = (kw: Record<string, unknown> = {}) => ({
  sku_key: HONEY,
  channel: 'shopee',
  hypothesis: 'Video 15 giây mở hộp quà có CTR cao hơn ảnh tĩnh',
  creative_draft_ids: [11],
  budget_vnd: 300_000,
  start_date: '2026-11-02',
  end_date: '2026-11-22',
  success_metric: { metric: 'ctr', op: '>=', target: 0.02 },
  stop_rules: [{ metric: 'cpc', op: '>=', value: 5000 }],
  ...kw,
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('mkt_ads (DB)', () => {
  let pool: Pool;
  let cfg: AdsCfg;
  let dcfg: Dcfg;
  const TMP = mkdtempSync(join(tmpdir(), 'mkt-ads-db-'));
  const lease = () => async () => ({ db: pool, release: async () => {} });
  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0])[0];
  const counts = async () => [
    Number(await one('select count(*) from ad_test_plans')),
    Number(await one('select count(*) from approval_queue')),
  ];

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
  /** `tests.test_fp_pnl.load_fixtures` + `add_costs` (người lập 'lap A', người duyệt 'duyet B'). */
  async function loadFpa(): Promise<void> {
    await tx(async (c) => {
      for (const t of [
        'market_snapshots',
        'market_rows',
        'settlement_rows',
        'recon_results',
      ] as const) {
        await c.query(
          `insert into ${t} overriding system value select * from jsonb_populate_recordset(null::${t}, $1::jsonb)`,
          [JSON.stringify(FDB.tables[t])],
        );
      }
    }, true);
    for (const [sku, cost] of Object.entries(FDB.costs)) {
      const id = await one(
        "insert into cogs_versions (sku_key, cost_vnd, valid_from, created_by) values ($1, $2, '2026-10-01', 'lap A') returning id",
        [sku, cost],
      );
      await pool.query("select approve_cogs($1, 'duyet B', null)", [id]);
    }
  }
  /** `_Env` của tests/test_mkt_ads.py. */
  async function env(): Promise<void> {
    await loadFpa();
    await pool.query('update sku_master set self_declaration_ok = true where sku_key = $1', [
      HONEY,
    ]);
  }
  async function draft(
    text = AD_TEXT,
    sku = HONEY,
    ct = 'ads',
    dec: 'approve' | 'reject' | null = 'approve',
  ) {
    const g = checkPublish(text, { channel: 'shopee', contentType: ct, sku, isAi: true });
    const did = await saveDraft(pool, {
      brief: 'brief MẪU',
      channel: 'shopee',
      text,
      guardrail: g,
      createdBy: 'mkt lap',
      contentType: ct,
      sku,
      isAi: true,
    });
    if (dec === 'approve') await pool.query("select approve_draft($1, 'duyet mkt', null)", [did]);
    if (dec === 'reject') await pool.query("select reject_draft($1, 'duyet mkt', 'MẪU')", [did]);
    return Number(did);
  }
  const sub = (p: unknown, kw: Record<string, unknown> = {}, d = {}) =>
    submitPlan(pool, p, { by: 'mkt lap', month: OCT, cfg, dcfg, today: TODAY, ...kw }, d);
  const insPlan = async (kw: Record<string, unknown> = {}) => {
    const row = {
      plan_sha256: 'a'.repeat(64),
      sku_key: HONEY,
      channel: 'shopee',
      hypothesis: 'giả thuyết MẪU đủ dài',
      creative_draft_ids: [1],
      budget_vnd: 100,
      cap_vnd: 100,
      cap_ref_month: OCT,
      start_date: '2026-11-02',
      end_date: '2026-11-22',
      success_metric: JSON.stringify({ metric: 'ctr' }),
      stop_rules: JSON.stringify([{ metric: 'cpc' }]),
      readiness: 'TP_THUONG',
      created_by: 'lap A',
      ...kw,
    };
    const cols = Object.keys(row);
    return Number(
      await one(
        `insert into ad_test_plans (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        Object.values(row),
      ),
    );
  };
  const cli = async (main: typeof mktAdsMain, o: Record<string, unknown>, extra = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(o as never, {
      log: (s) => out.push(s),
      err: (s) => err.push(s),
      connect: lease(),
      wire: null,
      today: TODAY,
      ...extra,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeAll(() => {
    const [c, d, why] = loadCfgs();
    expect(why).toBeNull();
    cfg = c as AdsCfg;
    dcfg = d as Dcfg;
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
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

  // ------------------------------------------------------------ parity P&L / trần với Python

  it('P&L + trần FP&A trên dữ liệu MẪU khớp Python (golden)', async () => {
    await env();
    const res = await compute(pool, OCT);
    expect(
      res.cells.map((c) => ({
        ...c,
        bien_gop_pct: c.bien_gop_pct === null ? null : { dec: decStr(c.bien_gop_pct) },
      })),
    ).toEqual(FDB.cells_oct);
    expect(await capFor(pool, HONEY, 'shopee', OCT, cfg)).toEqual(FDB.cap_honey);
    expect(await capFor(pool, HONEY, 'shopee', '2026-09-01', cfg)).toEqual(FDB.cap_honey_sep);
    expect(await capFor(pool, HONEY, 'facebook', OCT, cfg)).toEqual({
      code: 'NGOAI_KENH_ADS',
      budget_vnd: 0,
    });
  });

  // ------------------------------------------------------------ test_mkt_ads.py

  it('ad_test_plans: ràng buộc schema + append-only + unique', async () => {
    for (const kw of [
      { readiness: 'MO_TA' },
      { readiness: 'CAM' },
      { budget_vnd: 101 },
      { creative_draft_ids: [1, 2, 3, 4] },
      { stop_rules: '[]' },
      { end_date: '2026-12-03' },
      { created_by: '  ' },
      { plan_sha256: 'xyz' },
      { channel: 'lazada' },
    ]) {
      await expect(insPlan(kw), JSON.stringify(kw)).rejects.toMatchObject({ code: '23514' });
    }
    const pid = await insPlan();
    for (const sql of [
      'update ad_test_plans set budget_vnd = 1 where id = $1',
      'delete from ad_test_plans where id = $1',
    ]) {
      await expect(pool.query(sql, [pid])).rejects.toThrow(/append-only/);
    }
    await expect(insPlan()).rejects.toMatchObject({ code: '23505' });
  });

  it('bị từ chối → 0 ghi: rượu (kể cả golden ghi nhầm), listing_only, CAM, XNQC còn hạn, creative, trần', async () => {
    await env();
    const dOk = await draft();
    const dPending = await draft(AD_TEXT, HONEY, 'ads', null);
    const dRej = await draft(AD_TEXT, HONEY, 'ads', 'reject');
    const dOther = await draft(
      'Mật ong sâm 120ml — quà nhỏ xinh. #quangcao Nội dung có sử dụng AI',
      'mat-ong-sam-120ml-1hu',
    );
    const cap = await capFor(pool, HONEY, 'shopee', OCT, cfg);
    expect(cap.code).toBe('DE_XUAT');
    expect(cap.budget_vnd).toBeGreaterThan(0);
    let before = await counts();
    const code = async (kw: Record<string, unknown>) => {
      const res = await sub(plan({ creative_draft_ids: [dOk], ...kw }));
      expect(await counts(), JSON.stringify(kw)).toEqual(before);
      return res.code;
    };
    for (const k of ALCOHOL) expect(await code({ sku_key: k })).toBe('ADS_OFFLINE_ONLY');
    await pool.query(
      "update sku_master set allowed_channels = '{shopee,tiktok}', xnqc_status = 'approved', self_declaration_ok = true where category = 'alcohol'",
    );
    expect(await code({ sku_key: ALCOHOL[0] })).toBe('ADS_OFFLINE_ONLY');
    expect(await code({ sku_key: 'savigout-30v' })).toBe('ADS_LISTING_ONLY');
    await pool.query("update sku_master set xnqc_status = 'pending' where sku_key = 'savina-12v'");
    expect(await code({ sku_key: 'savina-12v' })).toBe('ADS_LISTING_ONLY');
    expect(await code({ sku_key: 'mat-ong-sam-120ml-1hu' })).toBe('ADS_CAM');
    expect(await code({ sku_key: 'khong-co-sku' })).toBe('ADS_CAM');
    await pool.query("update sku_master set xnqc_status = 'approved' where sku_key = 'savina-12v'");
    expect(await code({ sku_key: 'savina-12v', channel: 'tiktok' })).toBe('ADS_CAM');
    expect(await code({ sku_key: 'savina-12v' })).toBe('ADS_XNQC_DOSSIER');
    await pool.query(
      "insert into documents (sha256, filename, doc_type, text_source) values ($1, 'xnqc-MAU.pdf', 'khac', 'none')",
      ['d'.repeat(64)],
    );
    const dossier =
      "insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so, status, so_giay, ngay_nop, ngay_cap, ngay_het_han, document_sha256, updated_by) values ('savina-12v', 'maket', 'MẪU', 'da_cap', 'XNQC-MAU', $1, $2, $3, $4, 'Phap che A')";
    await pool.query(dossier, ['2025-01-01', '2025-01-02', '2026-10-11', 'd'.repeat(64)]); // hết hạn hôm qua
    expect(await code({ sku_key: 'savina-12v' })).toBe('ADS_XNQC_DOSSIER');
    await pool.query(dossier, ['2025-01-01', '2025-01-02', '2026-10-12', 'd'.repeat(64)]); // còn hạn hôm nay
    expect(await code({ sku_key: 'savina-12v' })).toBe('ADS_CREATIVE_UNAPPROVED');
    for (const d of [dPending, dRej, dOther, 99_999_999]) {
      expect(await code({ creative_draft_ids: [d] }), String(d)).toBe('ADS_CREATIVE_UNAPPROVED');
    }
    expect(await code({ budget_vnd: cap.budget_vnd + 1 })).toBe('ADS_OVER_CAP');
    await pool.query(
      "update sku_master set self_declaration_ok = true where sku_key = 'mat-ong-sam-120ml-2hu'",
    );
    const d2 = await draft(
      'Mật ong sâm 120ml hai hũ — quà biếu. #quangcao Nội dung có sử dụng AI',
      'mat-ong-sam-120ml-2hu',
    );
    before = await counts();
    expect(await code({ sku_key: 'mat-ong-sam-120ml-2hu', creative_draft_ids: [d2] })).toBe(
      'ADS_NO_CAP',
    );
    expect(['ADS_CAM', 'ADS_NO_CAP']).toContain(await code({ channel: 'facebook' }));
  });

  it('luồng CLI: dry-run 0 ghi → phiếu + 2 mục high → idempotent → kiểm soát kép → kết quả ad_result', async () => {
    await env();
    const d1 = await draft();
    const d2 = await draft(
      'Mật ong sâm 300ml — vị ngọt dịu cho bữa sáng. #quangcao Nội dung có sử dụng AI',
    );
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    const p = {
      ...JSON.parse(readFileSync(PLAN_FILE, 'utf8')),
      creative_draft_ids: [d1, d2],
      budget_vnd: cap,
    };
    const pf = join(TMP, 'plan.json');
    writeFileSync(pf, JSON.stringify(p));
    const base = { plan: pf, by: 'mkt lap', month: '2026-10' };
    let r = await cli(mktAdsMain, { ...base, dryRun: true });
    expect(r.code).toBe(0);
    expect(await counts()).toEqual([0, 0]);
    expect(r.out).toContain('[dry-run]');
    r = await cli(mktAdsMain, base);
    expect(r.code, r.out + r.err).toBe(0);
    const prow = (await pool.query('select id, cap_vnd, budget_vnd from ad_test_plans')).rows[0];
    const pid = Number(prow.id);
    expect([Number(prow.cap_vnd), Number(prow.budget_vnd)]).toEqual([cap, cap]);
    expect(r.out).toContain(`phiếu #${pid}`);
    const items = (
      await pool.query(
        "select id, block, object_type, object_id, risk, status, created_by, guardrail->>'ok' as g, payload from approval_queue order by id",
      )
    ).rows;
    expect(
      items.map((i) => [i.block, i.object_type, i.object_id, i.risk, i.status, i.created_by, i.g]),
    ).toEqual([
      ['marketing', 'ad_campaign', `adtest-${pid}`, 'high', 'pending', 'mkt lap', 'true'],
      // v15.2 (P8.2): mục ngân sách mang agent id RIÊNG để rollout quy đúng marketing-03
      ['finance', 'budget_change', `adtest-${pid}`, 'high', 'pending', BUDGET_AGENT, 'true'],
    ]);
    const payload = items[0].payload as string;
    expect(payload).toContain('agent không chi tiền');
    expect(payload).toContain('không gọi API');
    expect(payload).not.toMatch(BAN);
    expect(
      featureFor({
        table: 'approval_queue',
        block: 'finance',
        object_type: 'budget_change',
        created_by: BUDGET_AGENT,
      }),
    ).toBe('marketing-03.1');
    // chạy lại cùng file → không thêm dòng/mục
    r = await cli(mktAdsMain, base);
    expect(r.code).toBe(0);
    expect(await counts()).toEqual([1, 2]);
    expect(r.out).toContain('đã có');
    // risk high → auto_policy không áp; người lập tự duyệt → bị chặn
    await pool.query(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('ads_auto_test', 'ad_campaign', 'low', true, 'Chu Khoi Gia Lap (test)', now())",
    );
    let [ok, msg] = await autoApprove(pool, items[0].id);
    expect(ok).toBe(false);
    expect(msg).toContain('rủi ro high');
    [ok, msg] = await decide(pool, items[0].id, ' MKT LAP ', 'approved');
    expect(ok).toBe(false);
    expect(msg).toContain('trùng người tạo');
    expect(await planStatus(pool, pid)).toBe('cho_duyet');
    // nạp kết quả khi chưa duyệt đủ → từ chối, 0 ghi
    const rf = join(TMP, 'kq.csv');
    writeFileSync(
      rf,
      readFileSync(RESULT_FILE, 'utf8')
        .replaceAll(',101,', `,${d1},`)
        .replaceAll(',102,', `,${d2},`),
    );
    const rargs = { results: rf, planId: String(pid), by: 'mkt lap' };
    r = await cli(mktAdsMain, rargs);
    expect(r.code).toBe(1);
    expect(r.out).toContain(NOT_APPROVED);
    expect(await counts()).toEqual([1, 2]);
    expect(await decide(pool, items[0].id, 'GD Marketing', 'approved')).toEqual([true, null]);
    expect(await planStatus(pool, pid)).toBe('cho_duyet'); // mới 1/2
    expect((await cli(mktAdsMain, rargs)).code).toBe(1);
    expect(await counts()).toEqual([1, 2]);
    expect(await decide(pool, items[1].id, 'TGD', 'approved')).toEqual([true, null]);
    expect(await planStatus(pool, pid)).toBe('da_duyet');
    r = await cli(mktAdsMain, { status: String(pid) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('da_duyet');
    // đã duyệt đủ → 1 mục ad_result (marketing-03.2); nạp lại cùng file → skip
    r = await cli(mktAdsMain, rargs);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('đề xuất dung');
    expect(r.out).toContain(FLAG_OVER);
    const res = (
      await pool.query(
        "select object_type, object_id, risk, status, created_by, payload from approval_queue where object_id like 'adres-%'",
      )
    ).rows;
    expect(res.length).toBe(1);
    expect([res[0].object_type, res[0].risk, res[0].status, res[0].created_by]).toEqual([
      'ad_result',
      'high',
      'pending',
      'mkt lap',
    ]);
    expect(res[0].object_id.startsWith(`adres-${pid}-`)).toBe(true);
    expect((res[0].payload as string).toLowerCase()).not.toContain('tăng ngân sách');
    expect(
      featureFor({
        table: 'approval_queue',
        block: 'marketing',
        object_type: 'ad_result',
        created_by: 'Người Nhập',
      }),
    ).toBe('marketing-03.2');
    r = await cli(mktAdsMain, rargs);
    expect(r.out).toContain('[skip]');
    expect(await counts()).toEqual([1, 3]);
    // plan_status: thiếu mục / bản duyệt lệch nội dung phiếu / cùng 1 người duyệt cả 2 mục
    const pid2 = await insPlan({ plan_sha256: 'b'.repeat(64) });
    expect(await planStatus(pool, pid2)).toBe('thieu_muc');
    for (const [block, otype] of ITEMS) {
      const q = await submit(pool, {
        block,
        objectType: otype,
        objectId: `adtest-${pid2}`,
        title: 'giả',
        payload: 'Phiếu giả MẪU — nội dung khác dòng phiếu',
        createdBy: 'nguon khac',
        cfg: dcfg[block],
      });
      expect(await decide(pool, q, `GD ${block}`, 'approved')).toEqual([true, null]);
    }
    expect(await planStatus(pool, pid2)).toBe('lech_ban_duyet');
    const pid3 = await insPlan({ plan_sha256: 'c'.repeat(64) });
    for (const [[block, otype], who] of ITEMS.map(
      (x, i) => [x, ['GD Kep', ' gd kep '][i]] as const,
    )) {
      const q = await submit(pool, {
        block,
        objectType: otype,
        objectId: `adtest-${pid3}`,
        title: 'giả',
        payload: 'Phiếu giả MẪU',
        createdBy: 'nguon khac',
        cfg: dcfg[block],
      });
      expect(await decide(pool, q, who, 'approved')).toEqual([true, null]);
    }
    expect(await planStatus(pool, pid3)).toBe('cung_nguoi_duyet');
    // phiếu #1 giữ trọn trần tháng → phiếu 2 (sha mới) cùng SKU × kênh × tháng bị chặn
    const before = await counts();
    expect((await sub({ ...p, hypothesis: `${p.hypothesis} (vòng 2)`, budget_vnd: 1 })).code).toBe(
      'ADS_OVER_CAP',
    );
    expect(await counts()).toEqual(before);
  });

  it('kết quả cũ đã nộp dạng ad_campaign cùng oid → coi là đã có (không nộp lại)', async () => {
    await env();
    const d1 = await draft();
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    const res = await sub(plan({ creative_draft_ids: [d1], budget_vnd: cap }));
    const pid = res.plan_id as number;
    const [q1, q2] = res.new_items as bigint[];
    expect(await decide(pool, q1, 'GD Marketing', 'approved')).toEqual([true, null]);
    expect(await decide(pool, q2, 'TGD', 'approved')).toEqual([true, null]);
    const rf = join(TMP, 'kq2.csv');
    writeFileSync(
      rf,
      `ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang\n2026-11-03,${d1},100,1,1,1\n`,
    );
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(readFileSync(rf)).digest('hex');
    await submit(pool, {
      block: 'marketing',
      objectType: 'ad_campaign',
      objectId: `adres-${pid}-${sha.slice(0, 12)}`,
      title: 'kết quả cũ',
      payload: 'Kết quả cũ MẪU',
      createdBy: 'Người Nhập',
      cfg: dcfg.marketing,
    });
    const before = await counts();
    const r = await cli(mktAdsMain, { results: rf, planId: String(pid), by: 'Người Nhập' });
    expect(r.out).toContain('[skip]');
    expect(await counts()).toEqual(before);
  });

  it('trần THÁNG cộng dồn: chẻ phiếu không lách được; phiếu bị từ chối trả trần; đổi --month không mở trần', async () => {
    await env();
    const d = await draft();
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    expect(cap).toBeGreaterThanOrEqual(4);
    const half = Math.floor(cap / 2);
    const p = (tag: string, budget: number, kw: Record<string, unknown> = {}) =>
      plan({
        creative_draft_ids: [d],
        budget_vnd: budget,
        hypothesis: `Video mở hộp quà CTR cao hơn ảnh — ${tag}`,
        ...kw,
      });
    const a = await sub(p('A', half + 1));
    expect(a.code).toBeNull();
    expect(a.new_items?.length).toBe(2);
    let before = await counts();
    const b = await sub(p('B', half));
    expect(b.code).toBe('ADS_OVER_CAP');
    expect(b.reason).toContain('đã phân bổ');
    expect(await counts()).toEqual(before);
    expect(
      (await sub(p('B2', half, { start_date: '2026-11-23', end_date: '2026-11-30' }))).code,
    ).toBe('ADS_OVER_CAP');
    expect(await counts()).toEqual(before);
    const c = await sub(p('C', cap - (half + 1)));
    expect(c.code).toBeNull();
    const alloc = Number(
      await one('select allocated_vnd from ad_test_plans where id = $1', [c.plan_id]),
    );
    expect(alloc).toBe(half + 1);
    const pay = (await one('select payload from approval_queue where id = $1', [
      String(c.new_items?.[0]),
    ])) as string;
    expect(pay).toContain(`đã giữ ${vnd(alloc)}`);
    before = await counts();
    expect((await sub(p('D', 1))).code).toBe('ADS_OVER_CAP');
    expect(await counts()).toEqual(before);
    expect((await sub(p('E', 1, { start_date: '2026-12-01', end_date: '2026-12-20' }))).code).toBe(
      'ADS_OVER_CAP',
    );
    // phiếu A bị từ chối → trả trần, phiếu D đạt
    expect((await decide(pool, a.new_items?.[1], 'TGD', 'rejected'))[0]).toBe(true);
    expect(await planStatus(pool, a.plan_id as number)).toBe('tu_choi');
    expect((await sub(p('D', 1))).code).toBeNull();
    // phiếu cũ chạy lại (cùng sha) không tự đếm chính nó
    expect((await sub(p('C', cap - (half + 1)))).created).toBe(false);
    // đổi tháng P&L tham chiếu (--month) không mở thêm trần cho tháng lịch đã giữ
    const fixedCap = { capFor: async () => ({ code: 'DE_XUAT', budget_vnd: cap }) };
    before = await counts();
    const res = await sub(p('F', half + 1), { month: '2026-09-01' }, fixedCap);
    expect(res.code).toBe('ADS_OVER_CAP');
    expect(await counts()).toEqual(before);
    expect(
      (
        await sub(
          p('G', cap, { start_date: '2026-12-01', end_date: '2026-12-20' }),
          { month: '2026-09-01' },
          fixedCap,
        )
      ).code,
    ).toBeNull();
  });

  it('đếm lại trần SAU khóa advisory: phiếu khác ghi giữa chừng → ADS_OVER_CAP, 0 ghi', async () => {
    await env();
    const d = await draft();
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    const racy: typeof loadContext = async (...a) => {
      const ctx = await loadContext(...a);
      await insPlan({ budget_vnd: cap, cap_vnd: cap }); // "song song" giữ trọn trần
      return ctx;
    };
    const before = await counts();
    const res = await sub(
      plan({ creative_draft_ids: [d], budget_vnd: 1 }),
      {},
      { loadContext: racy },
    );
    expect(res.code).toBe('ADS_OVER_CAP');
    expect(res.reason).toContain('song song');
    expect(await counts()).toEqual([before[0] + 1, before[1]]);
  });

  it('giả thuyết làm phiếu vi phạm guardrail → ADS_INPUT, 0 ghi', async () => {
    await env();
    const d = await draft();
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    const before = await counts();
    const res = await sub(
      plan({
        creative_draft_ids: [d],
        budget_vnd: cap,
        hypothesis: 'Video nói sản phẩm chữa mất ngủ',
      }),
    );
    expect(res.code).toBe('ADS_INPUT');
    expect(res.reason).toContain('guardrail');
    expect(await counts()).toEqual(before);
  });

  it('cổng TẮT: --plan/--results exit 2 trước mọi ghi (r12 RB)', async () => {
    await env();
    settings.forceMode = 'tat';
    const pf = join(TMP, 'plan-tat.json');
    writeFileSync(pf, JSON.stringify(plan()));
    let r = await cli(mktAdsMain, { plan: pf, by: 'mkt lap', month: '2026-10' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('[rollout]');
    expect(r.out).toContain('marketing-03.1');
    r = await cli(mktAdsMain, { results: pf, planId: '1', by: 'mkt lap' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('marketing-03.2');
    expect(await counts()).toEqual([0, 0]);
  });

  // ------------------------------------------------------------ test_docx_mkt03.py

  it('marketing-03: agent tự đề xuất từ ô FP&A DE_XUAT + creative ĐÃ duyệt; chạy lại không nhân bản', async () => {
    await env();
    const d1 = await draft();
    const cap = await capFor(pool, HONEY, 'shopee', OCT, cfg);
    expect(cap.code).toBe('DE_XUAT');
    const prop = (today = TODAY) => propose(pool, { month: OCT, cfg, dcfg, pcfg: PCFG, today });
    const rows = await prop();
    const honey = rows.filter((r) => r.sku_key === HONEY && r.channel === 'shopee');
    expect(honey.length).toBe(1);
    expect(honey[0]?.code, js(rows)).toBe('DE_XUAT');
    const pid = honey[0]?.plan_id as number;
    const p = await getPlan(pool, pid);
    expect(p?.created_by).toBe(PROPOSE_AGENT);
    expect(p?.creative_draft_ids).toEqual([d1]);
    expect(p?.budget_vnd).toBe(Math.trunc(cap.budget_vnd * 0.5));
    expect(p?.budget_vnd).toBeLessThanOrEqual(p?.cap_vnd as number);
    expect(p?.start_date).toBe('2026-10-13');
    expect(p?.hypothesis).toContain('trần FP&A');
    expect(p?.hypothesis).toContain('ads_proposal');
    const items = (
      await pool.query(
        'select block, object_type, created_by, status from approval_queue where object_id = $1 order by id',
        [`adtest-${pid}`],
      )
    ).rows.map((r) => [r.block, r.object_type, r.created_by, r.status]);
    expect(items).toEqual([
      ['marketing', 'ad_campaign', PROPOSE_AGENT, 'pending'],
      ['finance', 'budget_change', BUDGET_AGENT, 'pending'],
    ]);
    // SKU không được phép (rượu, chưa XNQC...) không bao giờ là ứng viên
    expect(rows.some((r) => ALCOHOL.includes(r.sku_key))).toBe(false);
    for (const r of rows) {
      if (r.sku_key !== HONEY) {
        expect(['THIEU_CREATIVE', 'ADS_CREATIVE_UNAPPROVED']).toContain(r.code);
        expect(r.plan_id).toBeNull();
      }
    }
    const before = await counts();
    for (const t of [TODAY, '2026-10-13']) {
      const again = (await prop(t)).filter((r) => r.sku_key === HONEY && r.channel === 'shopee');
      expect([again[0]?.code, again[0]?.plan_id]).toEqual(['DA_CO', pid]);
    }
    expect(await counts()).toEqual(before);
  });

  it('marketing-03: không creative → THIẾU; vượt trần → chặn; tính năng TẮT → RolloutBlocked, 0 ghi', async () => {
    await env();
    let before = await counts();
    const prop = (pcfg = PCFG) => propose(pool, { month: OCT, cfg, dcfg, pcfg, today: TODAY });
    const rows = (await prop()).filter((r) => r.sku_key === HONEY);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.code === 'THIEU_CREATIVE')).toBe(true);
    expect(await counts()).toEqual(before);
    await draft();
    const cap = (await capFor(pool, HONEY, 'shopee', OCT, cfg)).budget_vnd;
    const d2 = await draft(
      'Mật ong sâm 300ml — vị ngọt dịu cho bữa sáng. #quangcao Nội dung có sử dụng AI',
    );
    const own = {
      sku_key: HONEY,
      channel: 'shopee',
      hypothesis: 'phiếu người lập giữ một phần trần',
      creative_draft_ids: [d2],
      budget_vnd: 1,
      start_date: TODAY,
      end_date: '2026-10-17',
      success_metric: PCFG.success_metric,
      stop_rules: PCFG.stop_rules,
    };
    expect((await sub(own)).code).toBeNull();
    before = await counts();
    const r = (await prop({ ...PCFG, ty_le_tran: 1.0 })).find(
      (x) => x.sku_key === HONEY && x.channel === 'shopee',
    );
    expect(r?.code, js(r)).toBe('ADS_OVER_CAP');
    expect(cap).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
    settings.forceMode = 'tat';
    await expect(prop()).rejects.toBeInstanceOf(RolloutBlocked);
    expect(await counts()).toEqual(before);
  });

  it('P8.2: người lập tự duyệt mục ngân sách (DB không biết vì created_by = agent) → cung_nguoi_duyet', async () => {
    await env();
    const d1 = await draft();
    const p = { ...JSON.parse(readFileSync(PLAN_FILE, 'utf8')), creative_draft_ids: [d1] };
    p.budget_vnd = (await capFor(pool, p.sku_key, 'shopee', OCT, cfg)).budget_vnd;
    const res = await sub(p);
    expect(res.code, res.reason).toBeNull();
    const rows = (
      await pool.query('select id, block, object_type, created_by from approval_queue order by id')
    ).rows;
    expect(Object.fromEntries(rows.map((r) => [r.object_type, r.created_by]))).toEqual({
      ad_campaign: 'mkt lap',
      budget_change: BUDGET_AGENT,
    });
    const qid = Object.fromEntries(rows.map((r) => [r.object_type, r.id]));
    expect(await decide(pool, qid.ad_campaign, 'GD Marketing', 'approved')).toEqual([true, null]);
    expect(await decide(pool, qid.budget_change, ' MKT LAP ', 'approved')).toEqual([true, null]);
    expect(await planStatus(pool, res.plan_id as number)).toBe('cung_nguoi_duyet');
  });

  // ------------------------------------------------------------ test_fp_ads.py

  it('fp-ads: readiness thật từ view, payload ẩn tên CAM, idempotent, risk high, song song, tháng khác', async () => {
    await loadFpa();
    await pool.query("update sku_master set xnqc_status = 'approved' where sku_key = 'savina-12v'");
    await pool.query(
      "update sku_master set self_declaration_ok = true where sku_key = 'mat-ong-sam-300ml'",
    );
    await pool.query(
      "update sku_master set allowed_channels = '{shopee}', xnqc_status = 'approved', self_declaration_ok = true where category = 'alcohol'",
    );
    const res = await compute(pool, OCT);
    const [acfg] = loadCfg();
    const CFG = { ...(acfg as AdsCfg), channels: ['shopee'] };
    const rd = await fetchReadiness(pool, ['shopee']);
    const props = fpPropose(res.cells, rd, CFG);
    expect(
      props.map((x) => ({
        ...x,
        bien_gop_pct: x.bien_gop_pct === null ? null : { dec: decStr(x.bien_gop_pct) },
      })),
    ).toEqual(FDB.fp_ads_props);
    const by = Object.fromEntries(props.map((x) => [x.sku_key, x]));
    expect(by['mat-ong-sam-300ml']?.code).toBe('DE_XUAT');
    expect(by['mat-ong-sam-120ml-1hu']?.code).toBe('CHAN_CAM');
    expect(by['saphraton-20v']?.code).toBe('CHAN_XNQC');
    for (const k of ALCOHOL) expect(by[k]?.code).toBe('CHAN_CAM');
    await pool.query("update sku_master set xnqc_status = 'pending' where sku_key = 'savina-12v'");
    const rd2 = await fetchReadiness(pool, ['shopee']);
    const sav = fpPropose(res.cells, rd2, CFG).find((x) => x.sku_key === 'savina-12v');
    expect([sav?.code, sav?.budget_vnd]).toEqual(['CHAN_XNQC', 0]);

    const items = async () =>
      (
        await pool.query(
          "select id, object_type, block, risk, status, guardrail->>'ok' as g, payload, created_by from approval_queue order by id",
        )
      ).rows;
    let r = await cli(fpAdsMain as never, { propose: true, month: '2026-10' });
    expect(r.code, r.out + r.err).toBe(0);
    const [it0] = await items();
    expect([it0.object_type, it0.block, it0.risk, it0.status, it0.g, it0.created_by]).toEqual([
      'budget_change',
      'finance',
      'high',
      'pending',
      'true',
      'agent:fp_ads',
    ]);
    expect(r.out).toContain(`#${it0.id}`);
    expect(r.out + it0.payload).not.toMatch(BAN);
    for (const k of ALCOHOL) expect(it0.payload).not.toContain(k);
    expect(it0.payload).toContain('`mat-ong-sam-300ml` | shopee');
    expect(it0.payload).toContain('DE_XUAT');
    // chạy lại → skip, không nhân đôi
    r = await cli(fpAdsMain as never, { propose: true, month: '2026-10' });
    expect(r.out).toContain('[skip]');
    expect((await items()).length).toBe(1);
    // auto_policy đã ký cho budget_change vẫn không duyệt được (risk high)
    await pool.query(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('ads_auto', 'budget_change', 'low', true, 'Chu Khoi Gia Lap (test)', now())",
    );
    const [ok, msg] = await autoApprove(pool, it0.id);
    expect(ok).toBe(false);
    expect(msg).toContain('rủi ro high');
    expect((await items())[0].status).toBe('pending');
    // tạo song song (kiểm pending lọt) → unique pending chặn → [skip]
    r = await cli(
      fpAdsMain as never,
      { propose: true, month: '2026-10' },
      { fpAds: { pendingForMonth: async () => null } },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('song song');
    expect((await items()).length).toBe(1);
    // tháng khác → mục mới
    r = await cli(fpAdsMain as never, { propose: true, month: '2026-09' });
    expect(r.code).toBe(0);
    expect((await items()).length).toBe(2);
    // mục ads-<tháng> không đụng tiền tố adtest- của phiếu thử nghiệm
    expect(String(it0.payload)).not.toContain('adtest-');
    // finance-04.2 TẮT → hàng duyệt chặn (Python: RolloutBlocked là ValueError → "[error]" exit 1), 0 ghi
    settings.forceMode = 'tat';
    r = await cli(fpAdsMain as never, { propose: true, month: '2026-08' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('[error] RolloutBlocked');
    expect((await items()).length).toBe(2);
  });

  // ------------------------------------------------------------ test_mkt_director.py

  describe('mkt-director (DB)', () => {
    const NOW = VN(2026, 10, 26);
    const [CAL, GOLDEN, SLA] = loadInputs();
    const realPlan = () => build(CAL, GOLDEN, '2026-10-12', 26, SLA);
    const mcfg = loadConfig('marketing');
    /** Python `set local role agent_writer` quanh lời gọi. */
    async function asWriter<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('set role agent_writer');
        return await fn(c);
      } finally {
        await c.query('reset role');
        c.release();
      }
    }
    const count = async () =>
      Number(await one("select count(*) from approval_queue where object_type = 'campaign_brief'"));

    it('brief idempotent, pending (không tự duyệt), SLA 48h, risk medium, guardrail ok — chạy dưới agent_writer', async () => {
      const plan0 = realPlan();
      const first = await asWriter((c) => enqueueBriefs(c, plan0, NOW, 14, mcfg));
      expect(first.enqueued.map((x) => x.id)).toEqual(['c-1111-2026']);
      const n1 = await count();
      const again = await asWriter((c) => enqueueBriefs(c, plan0, NOW, 14, mcfg));
      expect(again.enqueued).toEqual([]);
      expect(again.skipped.length).toBe(1);
      expect([await count(), n1]).toEqual([1, 1]);
      const rows = (
        await pool.query(
          "select status, lane, decided_by, created_by, extract(epoch from due_at - created_at)::int as gap, risk, block, object_id, guardrail->>'ok' as g from approval_queue where object_type = 'campaign_brief'",
        )
      ).rows;
      for (const r of rows) {
        expect([r.status, r.lane, r.decided_by, r.created_by]).toEqual([
          'pending',
          null,
          null,
          'agent:MKT-00',
        ]);
        expect([r.gap, r.risk, r.block, r.object_id, r.g]).toEqual([
          48 * 3600,
          'medium',
          'marketing',
          'c-1111-2026',
          'true',
        ]);
      }
      const dir = mkdtempSync(join(TMP, 'dir-'));
      const [path] = await asWriter((c) => directorRun(c, 'marketing', { cfg: mcfg, outDir: dir }));
      expect(path.startsWith(dir)).toBe(true);
      expect(
        await one(
          "select array_agg(distinct status) from approval_queue where object_type = 'campaign_brief'",
        ),
      ).toEqual(['pending']);
      expect(Number(await one('select count(*) from approvals'))).toBe(0);
    });

    for (const decision of ['approved', 'rejected']) {
      it(`brief đã quyết (${decision}) → lần chạy sau KHÔNG đẩy lại`, async () => {
        const plan0 = realPlan();
        const first = await asWriter((c) => enqueueBriefs(c, plan0, NOW, 14, mcfg));
        expect(first.enqueued.map((x) => x.id)).toEqual(['c-1111-2026']);
        await pool.query(
          "update approval_queue set status = $1, lane = 'per_item', decided_by = 'test:gd_marketing' where object_type = 'campaign_brief' and object_id = 'c-1111-2026'",
          [decision],
        );
        expect(await count()).toBe(1);
        const again = await asWriter((c) => enqueueBriefs(c, plan0, NOW, 14, mcfg));
        expect(again.enqueued).toEqual([]);
        expect(again.skipped).toEqual([{ id: 'c-1111-2026', reason: 'đã có trong hàng' }]);
        expect(await count()).toBe(1);
        expect(
          await one("select status from approval_queue where object_type = 'campaign_brief'"),
        ).toBe(decision);
      });
    }

    it('bản tin đọc hàng duyệt bằng cột metadata — chạy được dưới agent_writer', async () => {
      const plan0 = realPlan();
      await asWriter((c) => enqueueBriefs(c, plan0, NOW, 14));
      const items = await asWriter((c) => queueItems(c));
      expect(items.map((d) => [d.object_type, d.object_id, d.status])).toEqual([
        ['campaign_brief', 'c-1111-2026', 'pending'],
      ]);
      const late = VN(2026, 11, 5);
      const fc = forecastLoad(plan0, loadQuota(DEFAULT_QUOTA), 3, '2026-11-05', 14);
      const sec2 = (bulletin(plan0, fc, items, late).split('## 2.')[1] ?? '').split('## 3.')[0];
      expect(sec2).not.toContain('c-1111-2026: đã qua mốc brief');
    });
  });
});
