import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { autoApprove, decide, enqueue } from '@samsam/core/ops/approval-queue';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { reportStage } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import PG from '../fin_ar_pnl/__fixtures__/fp_pnl.golden.json' with { type: 'json' };
import { FPA_CONFIG_FILE } from '../fin_ar_pnl/fin-common.js';
import { buildExtra } from '../fin_ar_pnl/fin-director.js';
import { decStr, divInt } from './decimal.js';
import {
  type CliDeps,
  type FpCashOpts,
  type FpOpscostOpts,
  fpCashMain,
  fpOpscostMain,
} from './fin-cash.command.js';
import { dumpPy, type J } from './fin-cash.testing.js';
import { finSources } from './fin-sources.js';
import * as fc from './fp-cash.js';
import * as fo from './fp-opscost.js';

// Dịch phần DB của tests/test_fp_opscost.py, test_fp_cash.py, test_fin_director.py (mục chi phí
// vận hành + dòng tiền). DB riêng dựng lại từ mẫu MỖI ca (Python: schema tạm + ROLLBACK), xóa khi
// xong — KHÔNG BAO GIỜ DB `samsam`. Quyết toán MẪU nạp bằng INSERT từ dòng do hàm Python THẬT
// (`settlement_csv.read_settlement`) phân tích (fixture golden của nhóm fin_ar_pnl, chỉ đọc).
// `opex_MAU.csv`, users, người duyệt trong test là MẪU/GIẢ LẬP.

const NAME = testDbName('fin_cash');
const OPEX = repoPath('tests/fixtures/finance/opex_MAU.csv');
const OCT = '2026-10-01';
const START = '2026-10-12';
type SRow = Record<string, unknown> & { row_no: number; order_id_hash: string };
const SETTLE = PG.db_fixture.settlement as unknown as { name: string; sha: string; rows: SRow[] }[];
const RAW_FPA = parsePyJson(readFileSync(FPA_CONFIG_FILE, 'utf8')) as J;

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('fin_cash (DB)', () => {
  let pool: pg.Pool;
  let url: string;
  let tmp: string;
  let fpa: string;
  let usersFile: string;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];

  const deps = (s: { out: string[]; err: string[] }, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: { out: (x) => s.out.push(x), err: (x) => s.err.push(x) },
    env: {},
    connect: async () => ({ db: pool, release: async () => {} }),
    fpaConfig: fpa,
    usersFile,
    ...extra,
  });
  const ops = async (o: FpOpscostOpts, extra: Partial<CliDeps> = {}) => {
    const s = { out: [] as string[], err: [] as string[] };
    const rc = await fpOpscostMain(o, deps(s, extra));
    return { rc, text: s.out.join('\n'), err: s.err.join('\n') };
  };
  const cashCli = async (o: FpCashOpts, extra: Partial<CliDeps> = {}) => {
    const s = { out: [] as string[], err: [] as string[] };
    const rc = await fpCashMain(o, deps(s, extra));
    return { rc, text: s.out.join('\n'), err: s.err.join('\n') };
  };
  /** Kết nối như `connectDatabaseUrl` thật: pool riêng của lệnh, `release` = `pool.end()`. */
  const ownPool = async () => {
    const p = createPool(url);
    return { db: p, release: () => p.end() };
  };
  const stageRow = (fid: string) =>
    q(
      "insert into feature_rollout (feature_id, stage, updated_by) values ($1, 'van_hanh', 'test')",
      [fid],
    );
  const items = async () =>
    q(
      "select id::text as id, object_id, risk, status, block from approval_queue where object_type = 'opex_over_x' order by id",
    );
  async function usage(agent: string, usd: string, ts: string) {
    await q(
      "insert into llm_usage (ts, agent_id, model, cost_usd, ok) values ($1::timestamptz, $2, 'test/mau', $3, true)",
      [ts, agent, usd],
    );
  }
  async function loadSettlement(): Promise<void> {
    for (const set of SETTLE) {
      for (const r of set.rows) {
        await q(
          "insert into settlement_rows (file_sha256, file_name, channel, row_no, order_id_hash, order_amount_vnd, fixed_fee_vnd, payment_fee_vnd, service_fee_vnd, shipping_fee_vnd, voucher_seller_vnd, affiliate_vnd, refund_vnd, payout_vnd, settled_on, txn_type, source_kind) values ($1, $2, 'shopee', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'csv')",
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
      }
    }
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fin-cash-db-'));
    // trần MẪU (Python setup): ai:content 5tr, ai:chatbot 2tr, cloud 4tr, saas 7tr, ads 20tr
    const raw = {
      ...RAW_FPA,
      opscost: {
        ...(RAW_FPA.opscost as J),
        budget_vnd: {
          'ai:content': 5_000_000,
          'ai:chatbot': 2_000_000,
          cloud: 4_000_000,
          saas: 7_000_000,
          ads: 20_000_000,
        },
      },
    };
    fpa = join(tmp, 'fpa.json');
    writeFileSync(fpa, dumpPy(raw));
    usersFile = join(tmp, 'users.json');
    writeFileSync(
      usersFile,
      JSON.stringify({
        'tgd@samsam.test': { role: 'tgd' },
        'banhang@samsam.test': { role: 'gd_ban_hang' },
      }),
    );
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    url = await createDbFromTemplate(NAME);
    pool = createPool(url);
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
  });
  afterEach(() => {
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    settings.forceMode = null;
    await pool?.end();
    await dropDb(NAME);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** llm_usage MẪU: biên tháng theo giờ VN tường minh (mốc UTC/naive sẽ lệch 2 dòng). */
  async function seedUsage() {
    await usage('content', '120', '2026-10-03T09:00:00+07:00');
    // 03:00 01/10 giờ VN = 20:00 30/09 UTC: tháng 10 theo giờ VN → TÍNH
    await usage('content', '40', '2026-10-01T03:00:00+07:00');
    await usage('chatbot', '64', '2026-10-31T23:59:00+07:00');
    // 03:00 01/11 giờ VN = 20:00 31/10 UTC: tháng 11 → KHÔNG tính
    await usage('chatbot', '16', '2026-11-01T03:00:00+07:00');
    // 23:30 30/09 giờ VN = tháng 9 → không tính
    await usage('content', '100', '2026-09-30T23:30:00+07:00');
  }

  it('opscost: nạp (idempotent) → báo cáo → đẩy khoản > X → chỉ TGĐ ký mới "được chi"', async () => {
    await seedUsage();
    expect((await ops({ load: OPEX })).rc).toBe(0);
    let r = await ops({ load: OPEX });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('[skip]');
    expect(Number(await one('select count(*) from opex_entries'))).toBe(7);

    r = await ops({ report: true, month: '2026-10' });
    expect(r.rc).toBe(0);
    expect(r.text).toContain('[CẢNH BÁO 80%] `ai:content`: 4.000.000đ / trần 5.000.000đ');
    expect(r.text).toContain('[CẢNH BÁO 80%] `ai:chatbot`: 1.600.000đ / trần 2.000.000đ');
    expect(r.text).toContain('[CẢNH BÁO 80%] `cloud`: 3.300.000đ');
    expect(r.text).toContain('[VƯỢT TRẦN 100%] `saas`: 7.200.000đ');
    expect(r.text).toContain('`ads`');
    expect(r.text).not.toContain('[CẢNH BÁO 80%] `ads`');
    expect(r.text.split('[CẢNH BÁO').length - 1 + r.text.split('[VƯỢT TRẦN').length - 1).toBe(4);
    expect(r.text).toContain('`ai` | 5.600.000đ | chưa có trần');
    expect(r.text).not.toContain('HD-MAU');

    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.rc).toBe(0);
    let its = await items();
    const ents = Object.fromEntries((await fo.fetchOpex(pool, OCT)).map((e) => [e.service, e]));
    const key = (s: string) => fo.opexKey(ents[s] as fo.OpexEntry);
    expect(its.map((i) => i.object_id).sort()).toEqual(
      [key('misa-amis'), key('shopee-ads')].sort(),
    );
    // object_id = khóa tự nhiên (sha file + dòng), không id tự tăng
    const sha = (await fo.readOpex(OPEX))[2] as string;
    expect(key('misa-amis')).toBe(`opex-${sha.slice(0, 16)}-5`);
    expect(new Set(its.map((i) => `${i.risk}|${i.status}|${i.block}`))).toEqual(
      new Set(['high|pending|finance']),
    );
    expect(await one("select bool_and(guardrail->>'ok' = 'true') from approval_queue")).toBe(true);
    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain('0 mục mới');
    expect(await items()).toHaveLength(2);

    // auto_policy đã ký vẫn không duyệt được (risk high) → chờ TGĐ
    await q(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('opex_auto', 'opex_over_x', 'low', true, 'Chu Khoi Gia Lap (test)', now())",
    );
    const qid = Object.fromEntries(its.map((i) => [i.object_id, i.id]));
    const misa = qid[key('misa-amis')] as string;
    const ads = qid[key('shopee-ads')] as string;
    expect((await autoApprove(pool, misa))[0]).toBe(false);
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text.split('cho_tgd_ky').length - 1).toBe(2);
    expect(r.text).not.toContain('duoc_chi');

    // người không phải TGĐ duyệt → vẫn chờ; TGĐ duyệt → được chi
    expect(await decide(pool, misa, 'banhang@samsam.test', 'approved')).toEqual([true, null]);
    expect(await decide(pool, ads, ' TGD@samsam.test ', 'approved')).toEqual([true, null]);
    r = await ops({ status: true, month: '2026-10' });
    const id = (s: string) => (ents[s] as fo.OpexEntry).id;
    expect(r.text).toContain(`khoản #${id('misa-amis')} saas/misa-amis 6.000.000đ: cho_tgd_ky`);
    expect(r.text).toContain(`khoản #${id('shopee-ads')} ads/shopee-ads 12.000.000đ: duoc_chi`);
    expect(r.text).toContain(`cho_tgd_ky — ${fo.WHY.khac_vai_tro}`);
    // users rỗng (file thiếu) → không ai là TGĐ → fail-closed
    r = await ops({ status: true, month: '2026-10' }, { usersFile: join(tmp, 'khong-co.json') });
    expect(r.text).not.toContain('duoc_chi');

    // misa approved bởi vai trò KHÁC → không kẹt: đẩy 1 mục pending MỚI; ads đã có chữ ký TGĐ
    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain(`[submit] khoản #${id('misa-amis')} →`);
    expect(r.text).toContain('1 mục mới');
    its = await items();
    expect(its).toHaveLength(3);
    const fresh = its.filter((i) => i.object_id === key('misa-amis') && i.status === 'pending');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.id).not.toBe(misa);
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text).toContain(`cho_tgd_ky — ${fo.WHY.cho_ky}`);
    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain('0 mục mới');
    expect(await items()).toHaveLength(3);
    // TGĐ duyệt mục mới → misa được chi qua hệ thống
    expect(await decide(pool, fresh[0]?.id, 'tgd@samsam.test', 'approved')).toEqual([true, null]);
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text.split('duoc_chi').length - 1).toBe(2);
    expect(r.text).not.toContain('cho_tgd_ky');
    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain('0 mục mới');
    expect(await items()).toHaveLength(3);
    expect(maskPii(r.text)).toBe(r.text);
  });

  it('opscost: mục giả (payload số nhỏ) KHÔNG bao giờ tính; mục giả pending → [chặn]', async () => {
    expect((await ops({ load: OPEX })).rc).toBe(0);
    const misa = (await fo.fetchOpex(pool, OCT)).find(
      (e) => e.service === 'misa-amis',
    ) as fo.OpexEntry;
    const fake = await enqueue(pool, {
      objectType: 'opex_over_x',
      objectId: fo.opexKey(misa),
      block: 'finance',
      title: 'giả',
      payload: fo.renderOverX({ ...misa, amount_vnd: 5_100_000 }),
      risk: 'high',
      createdBy: fo.CREATED_BY,
      slaHours: 72,
    });
    let r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain(`[chặn] khoản #${misa.id}: ${fo.WHY.bi_chan}`);
    expect(r.text).toContain('1 mục mới'); // chỉ shopee-ads
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text).toContain(`6.000.000đ: cho_tgd_ky — ${fo.WHY.bi_chan}`);
    // TGĐ ký mục giả → khoản thật vẫn không được chi
    expect(await decide(pool, fake, 'tgd@samsam.test', 'approved')).toEqual([true, null]);
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text).toContain(`6.000.000đ: cho_tgd_ky — ${fo.WHY.chua_co}`);
    // hết chặn → đẩy mục thật; TGĐ ký đúng mục → được chi
    r = await ops({ submitOverX: true, month: '2026-10' });
    expect(r.text).toContain(`[submit] khoản #${misa.id} →`);
    const real = await one(
      "select id::text from approval_queue where object_id = $1 and status = 'pending'",
      [fo.opexKey(misa)],
    );
    expect(await decide(pool, real, 'tgd@samsam.test', 'approved')).toEqual([true, null]);
    r = await ops({ status: true, month: '2026-10' });
    expect(r.text).toContain('6.000.000đ: duoc_chi');
  });

  it('opscost: finance-05.1 TẮT → --submit-over-x bị chặn ở biên sinh (enqueue), 0 mục', async () => {
    expect((await ops({ load: OPEX })).rc).toBe(0);
    settings.forceMode = 'tat';
    const r = await ops({ submitOverX: true, month: '2026-10' });
    // Python: RolloutBlocked (ValueError) bắt ở main → "[error] RolloutBlocked: RolloutBlocked" exit 1
    expect(r.rc).toBe(1);
    expect(r.err).toBe('[error] RolloutBlocked: RolloutBlocked');
    expect(await items()).toHaveLength(0);
  });

  it('opscost: file nạp lỗi giữa chừng không để lại dòng nào (một giao dịch)', async () => {
    const [es, , sha] = await fo.readOpex(OPEX);
    const bad = [...es, { ...(es[0] as fo.OpexRow) }]; // trùng (file_sha256, row_no) → unique
    await expect(fo.load(pool, bad, 'x.csv', sha as string)).rejects.toThrow();
    expect(Number(await one('select count(*) from opex_entries'))).toBe(0);
  });

  it('cash: tỷ lệ thực nhận đo từ v_settlement_khoan 8 tuần trước tuần bắt đầu', async () => {
    await loadSettlement();
    const [pay, order, n] = Object.values(
      (
        await q(
          "select sum(payout_vnd)::text as p, sum(order_amount_vnd)::text as o, count(*)::int as n from settlement_rows where channel = 'shopee'",
        )
      )[0] as J,
    ) as [string, string, number];
    const m = await fc.measure(pool, START);
    expect(m).toEqual({ shopee: [BigInt(pay), BigInt(order), n] });
    expect(n).toBe(17);
    const [cfg] = fc.loadCfg();
    const nr = fc.netRatios(m, cfg as fc.CashCfg);
    expect(decStr(nr.shopee?.ratio as never)).toBe(decStr(divInt(BigInt(pay), BigInt(order))));
    expect(nr.shopee?.note.startsWith('đo từ settlement 17 dòng')).toBe(true);
    expect(nr.offline?.note).toContain('chưa xác minh');
    expect(decStr(nr.offline?.ratio as never)).toBe('1.0');
    // trước kỳ đo (8 tuần) không có dòng → mặc định
    expect(await fc.measure(pool, '2026-10-01')).toEqual({});
    const out = fc.run(m, START, null, fc.loadInputs());
    expect(out.notes.some((x) => x.includes('đo từ settlement 17 dòng'))).toBe(true);
  });

  it('cash CLI trên DB: đo được → báo cáo sample=false ghi sổ report_outputs (chưa vào sổ = chạy thử)', async () => {
    await loadSettlement();
    settings.forceMode = null; // cổng thật: feature_rollout trống → chạy thử
    const dir = mkdtempSync(join(tmp, 'rep-'));
    const r = await cashCli({ forecast: true, start: START, outDir: dir });
    expect(r.rc, r.err).toBe(0);
    expect(r.text).toContain('đo từ settlement 17 dòng');
    const body = readFileSync(join(dir, 'dong-tien-2026-10-12.md'), 'utf8');
    expect(body.startsWith('> **CHẠY THỬ — KHÔNG GỬI.** Tính năng finance-05.2')).toBe(true);
    expect(
      await q(
        "select feature_id, name, is_sample from report_outputs where name like 'dong-tien-%'",
      ),
    ).toEqual([{ feature_id: 'finance-05.2', name: 'dong-tien-2026-10-12.md', is_sample: false }]);
    // không lộ mã đơn hash trong báo cáo
    const hashes = (await q('select order_id_hash from settlement_rows')).map(
      (x) => x.order_id_hash as string,
    );
    expect(hashes.some((h) => body.includes(h))).toBe(false);
  });

  it('cash CLI kết nối thật (release = pool.end): nhãn theo giai đoạn thật + ghi sổ, nối core tiến trình còn sống', async () => {
    // review r3 (MAJOR): lệnh từng nối core lên pool RIÊNG của lệnh rồi đóng pool đó TRƯỚC
    // writeReport → cổng báo cáo đọc sổ trên pool đã đóng → "CHẠY THỬ" sai, report_outputs không
    // ghi. Python `write_report`/`record_report` tự `connect()` riêng.
    await loadSettlement();
    settings.forceMode = null;
    await stageRow(fc.FEATURE);
    const dir = mkdtempSync(join(tmp, 'rep-'));
    const r = await cashCli({ forecast: true, start: START, outDir: dir }, { connect: ownPool });
    expect(r.rc, r.err).toBe(0);
    expect(r.err).not.toContain('không ghi được sổ');
    const body = readFileSync(join(dir, 'dong-tien-2026-10-12.md'), 'utf8');
    expect(body).not.toContain('CHẠY THỬ');
    expect(
      await q(
        "select feature_id, is_sample from report_outputs where name = 'dong-tien-2026-10-12.md'",
      ),
    ).toEqual([{ feature_id: fc.FEATURE, is_sample: false }]);
    expect(await reportStage('dong-tien-x.md')).toEqual([fc.FEATURE, 'van_hanh']);
  });

  it('opscost kết nối thật (release = pool.end): không để nối core tiến trình trỏ vào pool đã đóng', async () => {
    // review r3 (MINOR): sau lệnh, cổng của tiến trình (rollout tự đọc sổ) vẫn đọc được giai đoạn thật.
    settings.forceMode = null;
    await stageRow(fc.FEATURE);
    expect((await ops({ report: true, month: '2026-10' }, { connect: ownPool })).rc).toBe(0);
    expect(await reportStage('dong-tien-x.md')).toEqual([fc.FEATURE, 'van_hanh']);
  });

  it('bản tin tuần GĐ tài chính: mục chi phí vận hành + dòng tiền lấy từ finSources', async () => {
    await seedUsage();
    expect((await ops({ load: OPEX })).rc).toBe(0);
    expect((await ops({ submitOverX: true, month: '2026-10' })).rc).toBe(0);
    await loadSettlement();
    const text = (await buildExtra(pool, START, { fpaConfig: fpa, src: finSources })).join('\n');
    expect(text).toContain('## Chi phí vận hành tháng 10/2026');
    expect(text).toContain('[CẢNH BÁO 80%] `cloud`: 3.300.000đ');
    expect(text).toContain('[VƯỢT TRẦN 100%] `saas`: 7.200.000đ');
    expect(text).toContain('đang chờ TGĐ ký: 2');
    expect(text).toContain('## Dòng tiền 13 tuần');
    expect(text).toContain('Số tuần âm ở kịch bản thấp:');
    expect(maskPii(text)).toBe(text);
    // thiếu mục cash/opscost → "(chưa có dữ liệu: …)", bản tin vẫn ra
    const raw = { ...RAW_FPA };
    delete raw.cash;
    delete raw.opscost;
    const p = join(tmp, 'no-sections.json');
    writeFileSync(p, dumpPy(raw));
    const t2 = (await buildExtra(pool, START, { fpaConfig: p, src: finSources })).join('\n');
    expect(t2).toContain("thiếu mục 'cash'");
    expect(t2).toContain("thiếu mục 'opscost'");
    expect(finSources.cashWeeks(p)).toBeNull();
    expect(finSources.cashWeeks(fpa)).toBe(13);
  });
});
