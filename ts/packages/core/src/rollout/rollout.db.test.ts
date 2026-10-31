import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { enqueue } from '../ops/approval-queue.js';
import { addDays, parseShift, vnDate, vnMidnight, weekday } from '../ops/period.js';
import { writeReport } from '../ops/report.js';
import { installFakeDeps } from '../ops/testing.js';
import { dataPath } from '../paths.js';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import * as acc from './acceptance.js';
import {
  businessDays,
  checkGenerate,
  countSpec,
  disable,
  dossier,
  type Feature,
  facts,
  incidentRows,
  labelReport,
  legacyRows,
  loadFeatures,
  loadShift,
  mode,
  opsRollout,
  outputFacts,
  outputRows,
  pendingOutputs,
  promote,
  RolloutBlocked,
  RolloutError,
  recordSevere,
  renderDossier,
  reviewOutput,
  rolloutCli,
  type Source,
  seed,
  setConnector,
  settings,
  summary,
} from './rollout.js';

// Dịch các test DB của tests/test_rollout.py, test_rollout_enforce.py, test_v14_p3_rollout_edges.py,
// test_v15_p8_outputs.py, test_acceptance_matrix.py. Mỗi test 1 DB RIÊNG tạo từ mẫu (seed/promote
// tự commit như Python), xóa khi xong. KHÔNG BAO GIỜ DB samsam.

const HAS_DB = Boolean(process.env.TS_TEST_ADMIN_URL);
const BY = 'Quản lý AI MẪU';
const HUMAN = 'GĐ bán hàng';
const DAY = 86_400_000;
const TMP = mkdtempSync(join(tmpdir(), 'rollout-db-'));
const SHIFT = loadShift();
const COUNTS = {
  ceo: 9,
  sales: 12,
  marketing: 14,
  intel: 11,
  finance: 9,
  production: 6,
  farming: 9,
  legal_hr: 10,
  data_platform: 9,
};

function f(fid: string, kw: Record<string, unknown> = {}): Feature {
  const d: Record<string, unknown> = {
    id: fid,
    phong_ban: fid.split('-')[0],
    pham_vi: 'tinh_nang_ai',
    ten: 'Tính năng',
    nguon: "PL01 mục 2 — X: 'y'",
    giai_doan: 'P1',
    nguoi_duyet: 'Tổng giám đốc',
    owner: 'Bên A',
    dau_ra: 'Đầu ra.',
    modules: ['pipelines/rollout.py'],
    agent_ids: ['agent:t_b1'],
    output_sources: [{ table: 'feature_rollout_events' }],
    code_status: 'co_code',
    acceptance_status: 'chua_nghiem_thu',
    blocker: null,
    phu_thuoc: [],
    bang_chung: [],
  };
  if (fid.includes('.')) d.nhom_goc = fid.split('.')[0];
  return { ...d, ...kw } as Feature;
}
const ff = (fid: string, srcs: Source[]) => f(fid, { agent_ids: [], output_sources: srcs });

function writeCat(feats: Feature[]): string {
  const p = join(TMP, `cat-${Math.random().toString(36).slice(2)}.json`);
  const doc = {
    _doc: 'x',
    so_tinh_nang_hd: COUNTS,
    so_giai_doan_hd: { P1: 80, P2: 9 },
    tong_hop: summary(feats, COUNTS, { P1: 80, P2: 9 }),
    features: feats,
  };
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

const SRC = { table: 'approval_queue', block: 'ceo', object_type: 'weekly_report' };
const FEATS = [
  f('ceo-01', { output_sources: [SRC] }),
  f('ceo-02', { agent_ids: [], output_sources: [{ report: 'b-' }] }),
  f('sales-08', {
    modules: [],
    agent_ids: [],
    output_sources: [],
    code_status: 'lam_rieng',
    blocker: 'repo website chưa xác định',
  }),
  f('ceo-05', {
    giai_doan: 'P2',
    agent_ids: ['agent:t_b1_p2'],
    output_sources: [{ report: 'c-' }],
  }),
];
const CAT = [
  ...FEATS,
  ff('ceo-03', [{ report: 'ceo-risk-' }]),
  ff('ceo-04.6', [{ table: 'audit_runs', kind: 'inside_out' }]),
  ff('ceo-04.9', [{ table: 'audit_runs', kind: 'recon' }]),
  ff('production-01', [{ table: 'allocation_proposals' }]),
  ff('intel-02', [
    { table: 'red_alerts', source_agent: 'intel_red_alert', rules_any: ['brand_negative'] },
  ]),
  ff('data_platform-08', [
    { table: 'content_drafts', created_by: 'agent:mkt02', content_type: 'post' },
  ]),
];
const cat = (fid: string) => CAT.find((x) => x.id === fid) as Feature;

function workdaysAfter(t: Date, k: number): string[] {
  const out: string[] = [];
  for (let d = addDays(vnDate(t), 1); out.length < k; d = addDays(d, 1)) {
    if (weekday(d) < 5) out.push(d);
  }
  return out;
}
const at10 = (day: string) => new Date(vnMidnight(day).getTime() + 10 * 3600_000);

type OutOpts = {
  days?: number;
  block?: string;
  otype?: string;
  by?: string;
  status?: string;
  lane?: string | null;
  decidedBy?: string | null;
  ok?: boolean;
  oid?: string;
  title?: string;
};

describe.skipIf(!HAS_DB)('rollout (DB)', () => {
  let name: string;
  let pool: pg.Pool;
  const ORIG = { ...settings };

  async function out(n: number, start: Date, o: OutOpts = {}): Promise<void> {
    const days = o.days ?? 5;
    const ds = workdaysAfter(start, days);
    await pool.query('alter table approval_queue disable trigger approval_queue_guard_row');
    try {
      for (let i = 0; i < n; i++) {
        const ts = at10(ds[i % days] as string);
        const status = o.status ?? 'pending';
        await pool.query(
          'insert into approval_queue (object_type, object_id, block, title, payload, content_sha256,' +
            ' risk, guardrail, created_by, created_at, due_at, status, lane, decided_by, decided_at)' +
            " values ($1, $2, $3, $4, 'p', $5, 'low', $6::jsonb, $7, $8, $9, $10, $11, $12, $13)",
          [
            o.otype ?? 'weekly_report',
            `${o.oid ?? 'w'}-${i}-${vnDate(ts).replaceAll('-', '')}`,
            o.block ?? 'ceo',
            o.title ?? 'Báo cáo tuần',
            '0'.repeat(64),
            JSON.stringify({ ok: o.ok ?? true }),
            o.by ?? 'agent:t_b1',
            ts,
            new Date(ts.getTime() + 3 * DAY),
            status,
            o.lane ?? null,
            o.decidedBy ?? null,
            status !== 'pending' ? ts : null,
          ],
        );
      }
    } finally {
      await pool.query('alter table approval_queue enable trigger approval_queue_guard_row');
    }
  }
  const state = async (fid: string) =>
    (
      await pool.query('select stage, stage_since from feature_rollout where feature_id = $1', [
        fid,
      ])
    ).rows[0] as { stage: string; stage_since: Date } | undefined;
  const events = async (fid: string) =>
    (
      await pool.query(
        'select kind from feature_rollout_events where feature_id = $1 order by id',
        [fid],
      )
    ).rows.map((r) => r.kind);
  const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  // mốc `until` theo đồng hồ DB: created_at = now() của DB, đồng hồ container có thể lệch vài ms so với máy chủ
  // + 1 ms: Date của JS cắt µs của now() → máy nhanh (runner Linux) ghi dòng rồi lấy mốc trong CÙNG ms thì mốc
  // < created_at của dòng vừa ghi → `created_at <= until` loại mất dòng đó (Python giữ µs nên không gặp)
  const dbNow = async (): Promise<Date> =>
    new Date((await pool.query('select now() as t')).rows[0].t.getTime() + 1);
  async function stageOf(fid: string, stage: string, since: Date | null = null): Promise<void> {
    await seed(pool, [cat(fid)], BY, since ?? new Date(Date.now() - DAY));
    await pool.query('update feature_rollout set stage = $1 where feature_id = $2', [stage, fid]);
  }

  beforeEach(async () => {
    name = testDbName('rollout');
    pool = createPool(await createDbFromTemplate(name));
    settings.featuresFile = writeCat(CAT);
    settings.configFile = join(TMP, 'rollout_config.json');
    writeFileSync(
      settings.configFile,
      JSON.stringify({ enforce: true, workdays: [0, 1, 2, 3, 4], holidays: [] }),
    );
    settings.forceMode = null;
    setConnector(async () => ({ db: pool, release: async () => {} }));
    installFakeDeps({ rollout: opsRollout });
  });
  afterEach(async () => {
    Object.assign(settings, ORIG);
    setConnector(null);
    await pool?.end();
    await dropDb(name);
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  // ------------------------------------------------------------ test_rollout.py

  it('seed idempotent, chỉ co_code, ghi count_spec = Python; --by agent bị từ chối', async () => {
    const now = new Date();
    expect(await seed(pool, FEATS, BY, new Date(now.getTime() - 30 * DAY))).toEqual({
      inserted: 3,
      existing: 0,
      skipped: 1,
    });
    expect(await state('sales-08')).toBeUndefined();
    expect(await seed(pool, FEATS, BY, now)).toEqual({ inserted: 0, existing: 3, skipped: 1 });
    const st = await state('ceo-01');
    expect(st?.stage).toBe('chay_thu');
    expect(st?.stage_since.getTime()).toBeLessThan(now.getTime() - 29 * DAY);
    expect(await events('ceo-01')).toEqual(['seed']);
    const spec = (
      await pool.query("select count_spec from feature_rollout where feature_id = 'ceo-01'")
    ).rows[0].count_spec;
    expect(spec).toEqual(countSpec(FEATS[0] as Feature, SHIFT));
    await expect(seed(pool, FEATS, 'agent:x')).rejects.toThrow(RangeError);
  });

  it('mục tách vào sổ với mốc MỚI, nhóm tắt → tắt; id cũ giữ lịch sử', async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 30 * DAY);
    const old = [
      f('ceo-04', { output_sources: [{ report: 'a-' }] }),
      f('ceo-06', { agent_ids: [], output_sources: [{ report: 'd-' }] }),
    ];
    await seed(pool, old, BY, t0);
    await disable(pool, 'ceo-06', BY, null, new Date(t0.getTime() + DAY));
    const nw = [
      f('ceo-04.1', { agent_ids: [], output_sources: [{ report: 'e-' }] }),
      f('ceo-04.2', { agent_ids: [], output_sources: [{ report: 'f-' }] }),
      f('ceo-06.1', { agent_ids: [], output_sources: [{ report: 'g-' }] }),
    ];
    expect((await seed(pool, nw, BY, now)).inserted).toBe(3);
    expect((await state('ceo-04'))?.stage_since.getTime()).toBe(t0.getTime());
    for (const fid of ['ceo-04.1', 'ceo-04.2']) {
      expect((await state(fid))?.stage_since.getTime()).toBe(now.getTime());
      const ev = (
        await pool.query('select evidence from feature_rollout_events where feature_id = $1', [fid])
      ).rows[0].evidence;
      expect(ev).toEqual({ nhom_goc: 'ceo-04', stage_nhom_goc: 'chay_thu' });
    }
    expect((await state('ceo-06.1'))?.stage).toBe('tat');
    expect((await legacyRows(pool, nw)).map((r) => [r.id, r.tach_thanh])).toEqual([
      ['ceo-04', ['ceo-04.1', 'ceo-04.2']],
      ['ceo-06', ['ceo-06.1']],
    ]);
    await expect(promote(pool, nw, 'ceo-04.1', BY, SHIFT)).rejects.toThrow(/ngày làm việc/);
    const md = await dossier(pool, nw, 'P1', SHIFT);
    expect(md).toContain('ceo-04 (chạy thử từ');
    expect(md).toContain('→ ceo-04.1, ceo-04.2');
  });

  it('promote từ chối không ghi gì (danh mục, code_status, chưa vào sổ, ngày, --by)', async () => {
    await seed(pool, FEATS, BY, new Date(Date.now() - DAY));
    await expect(promote(pool, FEATS, 'ceo-99', BY, SHIFT)).rejects.toThrow(
      'không có trong danh mục',
    );
    await expect(promote(pool, FEATS, 'sales-08', BY, SHIFT)).rejects.toThrow('lam_rieng');
    const mp = [
      ...FEATS,
      f('intel-01', {
        agent_ids: [],
        code_status: 'mot_phan',
        blocker: 'thiếu OCR',
        output_sources: [{ report: 'z-' }],
      }),
    ];
    await expect(promote(pool, mp, 'intel-01', BY, SHIFT)).rejects.toThrow('mot_phan');
    await expect(promote(pool, [...FEATS, f('intel-01')], 'intel-01', BY, SHIFT)).rejects.toThrow(
      'chưa vào sổ',
    );
    await expect(promote(pool, FEATS, 'ceo-01', BY, SHIFT)).rejects.toThrow(RolloutError);
    await expect(promote(pool, FEATS, 'ceo-01', BY, SHIFT)).rejects.toThrow(/ngày làm việc/);
    expect((await state('ceo-01'))?.stage).toBe('chay_thu');
    expect(await events('ceo-01')).toEqual(['seed']);
    await expect(promote(pool, FEATS, 'ceo-01', 'system:x', SHIFT)).rejects.toThrow(RangeError);
  });

  it('không có nguồn đếm được → "không đếm được"; báo cáo 0 đầu ra → 0/50', async () => {
    const feats = [
      ...FEATS,
      f('intel-02', { agent_ids: [], output_sources: [{ file: 'conversations.jsonl' }] }),
    ];
    settings.dataDir = TMP; // không có convlog → nguồn không đọc được
    await seed(pool, feats, BY, new Date(Date.now() - 60 * DAY));
    await expect(promote(pool, feats, 'intel-02', BY, SHIFT)).rejects.toThrow('không đếm được');
    await expect(promote(pool, feats, 'ceo-02', BY, SHIFT)).rejects.toThrow('0/50');
  });

  it('chỉ đếm đầu ra từ lúc vào giai đoạn; 50 đầu ra rải 5 ngày → có người duyệt', async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 30 * DAY);
    await seed(pool, FEATS, BY, t0);
    await out(49, t0);
    await out(10, t0, { otype: 'weekly_board', oid: 'khac' }); // tính năng khác
    await expect(promote(pool, FEATS, 'ceo-01', BY, SHIFT)).rejects.toThrow('49/50');
    await out(1, t0, { oid: 'them' });
    const r = await promote(pool, FEATS, 'ceo-01', BY, SHIFT);
    expect([r.from, r.to]).toEqual(['chay_thu', 'co_nguoi_duyet']);
    const ev = (
      await pool.query(
        "select from_stage, to_stage, evidence, by_person from feature_rollout_events where kind = 'promote'",
      )
    ).rows[0];
    expect([ev.from_stage, ev.to_stage, ev.by_person]).toEqual(['chay_thu', 'co_nguoi_duyet', BY]);
    expect(ev.evidence.outputs).toBe(50);
    expect(ev.evidence.out_days).toBe(5);
    expect(ev.evidence.days).toBeGreaterThanOrEqual(5);
    const f3 = [f('ceo-03', { output_sources: [SRC] })];
    await seed(pool, f3, BY, new Date(now.getTime() + 3600_000));
    await expect(
      promote(pool, f3, 'ceo-03', BY, SHIFT, new Date(now.getTime() + 30 * DAY)),
    ).rejects.toThrow('0/50');
  });

  it('có người duyệt cần 10 ngày + 0 lỗi nghiêm trọng; đủ → vận hành rồi hết bước', async () => {
    const t0 = new Date(Date.now() - 40 * DAY);
    await seed(pool, FEATS, BY, t0);
    await out(50, t0);
    const t1 = new Date(t0.getTime() + 8 * DAY);
    await promote(pool, FEATS, 'ceo-01', BY, SHIFT, t1);
    await expect(
      promote(pool, FEATS, 'ceo-01', BY, SHIFT, new Date(t1.getTime() + 5 * DAY)),
    ).rejects.toThrow('/10 ngày');
    // 10 ngày mà KHÔNG có đầu ra người duyệt → chưa vận hành (F03)
    await expect(
      promote(pool, FEATS, 'ceo-01', BY, SHIFT, new Date(t0.getTime() + 24 * DAY)),
    ).rejects.toThrow('chưa có đầu ra nào');
    await out(1, t1, {
      days: 1,
      oid: 'duyet',
      status: 'approved',
      lane: 'per_item',
      decidedBy: HUMAN,
    });
    const r = await promote(pool, FEATS, 'ceo-01', HUMAN, SHIFT, new Date(t0.getTime() + 24 * DAY));
    expect(r.to).toBe('van_hanh');
    expect(r.facts.days).toBeGreaterThanOrEqual(10);
    expect([r.facts.human, r.facts.unapproved]).toEqual([1, 0]);
    await expect(promote(pool, FEATS, 'ceo-01', BY, SHIFT)).rejects.toThrow('đã vận hành');
    expect(await events('ceo-01')).toEqual(['seed', 'promote', 'promote']);
  });

  it('lỗi nghiêm trọng chèn tay vẫn chặn nâng', async () => {
    const t0 = new Date(Date.now() - 40 * DAY);
    await seed(pool, FEATS, BY, t0);
    await out(50, t0);
    const t1 = new Date(t0.getTime() + 14 * DAY);
    await promote(pool, FEATS, 'ceo-01', BY, SHIFT, t1);
    await out(2, t1, {
      days: 2,
      oid: 'duyet',
      status: 'approved',
      lane: 'per_item',
      decidedBy: HUMAN,
    });
    await pool.query(
      'insert into feature_rollout_events (ts, feature_id, kind, from_stage, to_stage, severe_code, by_person)' +
        " values ($1, 'ceo-01', 'severe', 'co_nguoi_duyet', 'co_nguoi_duyet', 'tu_cam', $2)",
      [new Date(t1.getTime() + DAY), BY],
    );
    await expect(
      promote(pool, FEATS, 'ceo-01', BY, SHIFT, new Date(t1.getTime() + 20 * DAY)),
    ).rejects.toThrow('1 lỗi nghiêm trọng');
    expect((await state('ceo-01'))?.stage).toBe('co_nguoi_duyet');
  });

  it('severe lùi về chạy thử, đặt lại mốc, che SĐT; disable rồi bật lại', async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 10 * DAY);
    await seed(pool, FEATS, BY, t0);
    await out(50, t0);
    await promote(pool, FEATS, 'ceo-01', BY, SHIFT, new Date(t0.getTime() + 8 * DAY));
    const tErr = new Date(now.getTime() + 3600_000);
    const r = await recordSevere(pool, 'ceo-01', 'thieu_nhan_ai', BY, 'khách 0905123456 báo', tErr);
    expect([r.from, r.to]).toEqual(['co_nguoi_duyet', 'chay_thu']);
    const st = await state('ceo-01');
    expect([st?.stage, st?.stage_since.getTime()]).toEqual(['chay_thu', tErr.getTime()]);
    const note = (await pool.query("select note from feature_rollout_events where kind = 'severe'"))
      .rows[0].note;
    expect(note).not.toContain('0905123456');
    await expect(
      promote(pool, FEATS, 'ceo-01', BY, SHIFT, new Date(tErr.getTime() + 10 * DAY)),
    ).rejects.toThrow('0/50');
    await expect(recordSevere(pool, 'ceo-01', 'khac', BY)).rejects.toThrow('--reason');
    await expect(recordSevere(pool, 'intel-01', 'lo_pii', BY)).rejects.toThrow('chưa vào sổ');
    expect((await disable(pool, 'ceo-02', BY, 'tạm dừng')).to).toBe('tat');
    await expect(disable(pool, 'ceo-02', BY)).rejects.toThrow('đã tắt');
    expect(await recordSevere(pool, 'ceo-02', 'tu_cam', BY)).toEqual({ from: 'tat', to: 'tat' });
    expect(await promote(pool, FEATS, 'ceo-02', BY, SHIFT)).toMatchObject({
      from: 'tat',
      to: 'chay_thu',
    });
    expect(await events('ceo-02')).toEqual(['seed', 'disable', 'severe', 'promote']);
    await expect(disable(pool, 'intel-01', BY)).rejects.toThrow('chưa vào sổ');
  });

  it('hồ sơ lọc theo giai đoạn; phase lạ → lỗi', async () => {
    await seed(pool, FEATS, BY, new Date(Date.now() - 2 * DAY));
    await recordSevere(pool, 'ceo-05', 'so_lieu_khong_nguon', BY);
    const p1 = await dossier(pool, FEATS, 'P1', SHIFT);
    expect(p1).toContain('(3 mục)');
    expect(p1).not.toContain('| ceo-05 |');
    expect(p1).toContain('| sales-08 |');
    expect(p1).toContain('Chưa ghi nhận lỗi nghiêm trọng');
    const p2 = await dossier(pool, FEATS, 'P2', SHIFT);
    expect(p2).toContain('(1 mục)');
    expect(p2).toContain('Số liệu không có nguồn');
    await expect(dossier(pool, FEATS, 'P9', SHIFT)).rejects.toThrow(RangeError);
  });

  it('CLI end-to-end: seed/status/promote từ chối/severe/disable/dossier --out', async () => {
    settings.featuresFile = writeCat(FEATS);
    const open = async () => ({ db: pool, release: async () => {} });
    const logs: string[] = [];
    const errs: string[] = [];
    const cli = (o: Parameters<typeof rolloutCli>[0]) =>
      rolloutCli(
        o,
        open,
        (s) => logs.push(s),
        (s) => errs.push(s),
      );
    expect(await cli({ seed: true, by: BY })).toBe(0);
    expect(logs.at(-1)).toContain('vào sổ 3');
    expect(await cli({ status: true })).toBe(0);
    expect(logs.join('\n')).toContain('ceo-01');
    expect(logs.join('\n')).toContain('chưa vào sổ');
    expect(await cli({ promote: 'ceo-01', by: BY })).toBe(1);
    expect(errs.at(-1)).toContain('TỪ CHỐI');
    expect(await cli({ severe: 'ceo-01', reason: 'lo_pii', by: BY, note: 'x' })).toBe(0);
    expect(await cli({ disable: 'ceo-02', by: BY })).toBe(0);
    const outFile = join(TMP, 'hs', 'nt.md');
    expect(await cli({ dossier: true, phase: 'P1', out: outFile })).toBe(0);
    const md = readFileSync(outFile, 'utf8');
    expect(md).toContain('Lộ dữ liệu cá nhân');
    expect(md).not.toContain('\r\n');
    // lỗi tham số / DB down / cấu hình hỏng (không DB): rollout.test.ts
  });

  // ------------------------------------------------------------ test_rollout_enforce.py

  it('đầu ra DISTINCT: xếp lại/mẫu/guardrail hỏng/loại+khối khác không tính; cửa sổ', async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 30 * DAY);
    await out(10, t0, { oid: 'r', status: 'rejected', lane: 'per_item', decidedBy: HUMAN });
    await out(10, t0, { oid: 'r' });
    await out(7, t0, { oid: 'sample' });
    await out(7, t0, { oid: 't', title: 'Báo cáo tuần (MẪU)' });
    await out(7, t0, { oid: 'g', ok: false });
    await out(7, t0, { oid: 'k', otype: 'weekly_board' });
    await out(7, t0, { oid: 'b', block: 'sales' });
    const o = await outputFacts(pool, cat('ceo-01'), t0, now, SHIFT);
    expect([o.outputs, o.out_days, o.human, o.unapproved, o.uncounted]).toEqual([10, 5, 0, 0, []]);
    expect(
      (await outputFacts(pool, cat('ceo-01'), new Date(now.getTime() - 60_000), now, SHIFT))
        .outputs,
    ).toBe(0);
    // 50 log hành động bất kỳ ≠ đầu ra
    for (let i = 0; i < 50; i++) {
      await pool.query(
        "insert into agent_action_log (actor, action, object_type, object_id) values ('agent:t_b1', 'x', 't', $1)",
        [String(i)],
      );
    }
    expect((await outputFacts(pool, cat('ceo-01'), t0, now, SHIFT)).outputs).toBe(10);
  });

  it('duyệt thiếu người (auto_policy/agent) bị gắn cờ; nháp nội dung DISTINCT theo text', async () => {
    const now = new Date();
    const t0 = new Date(now.getTime() - 30 * DAY);
    await out(2, t0, {
      oid: 'a',
      status: 'approved',
      lane: 'auto_policy',
      decidedBy: 'system:auto_policy',
    });
    await out(1, t0, {
      oid: 'g',
      status: 'approved',
      lane: 'per_item',
      decidedBy: 'agent:kd_quote',
    });
    await out(3, t0, { oid: 'h', status: 'approved', lane: 'per_item', decidedBy: HUMAN });
    const o = await outputFacts(pool, cat('ceo-01'), t0, now, SHIFT);
    expect([o.outputs, o.human, o.unapproved]).toEqual([6, 3, 3]);
    const ok = JSON.stringify({ ok: true });
    const bad = JSON.stringify({ ok: false });
    const rows: unknown[][] = [
      [1, 'b', 'bài 1', ok, 'cli', 'agent:mkt02', 'post', 'approved', HUMAN],
      [2, 'b', 'bài 1', ok, 'cli', 'agent:mkt02', 'post', 'pending', null],
      [3, 'b', 'bài 2', ok, 'cli', 'agent:mkt02', 'post', 'approved', 'agent:mkt02'],
      [3, 'b', 'bài 3', ok, 'sample:x', 'agent:mkt02', 'post', 'pending', null],
      [3, 'b (MẪU)', 'bài 4', ok, 'cli', 'agent:mkt02', 'post', 'pending', null],
      [3, 'b', 'bài 5', bad, 'cli', 'agent:mkt02', 'post', 'pending', null],
      [3, 'b', 'bài 6', ok, 'cli', 'agent:mkt02', 'listing', 'pending', null],
      [3, 'b', 'bài 7', ok, 'cli', 'agent:khac', 'post', 'pending', null],
    ];
    for (const [dd, ...r] of rows) {
      await pool.query(
        'insert into content_drafts (created_at, brief, channel, text, guardrail, source, created_by,' +
          " content_type, status, reviewer) values ($1, $2, 'facebook', $3, $4::jsonb, $5, $6, $7, $8, $9)",
        [new Date(t0.getTime() + (dd as number) * DAY), ...r],
      );
    }
    const c = await outputFacts(pool, cat('data_platform-08'), t0, now, SHIFT);
    expect([c.outputs, c.human, c.unapproved]).toEqual([2, 1, 1]);
  });

  it('mode đọc sổ; lỗi nghiêm trọng chặn NGAY; bảng thiếu → chạy thử, tx client còn dùng được', async () => {
    expect(await mode(pool, 'ceo-01')).toBe('chay_thu');
    await seed(pool, CAT, BY, new Date(Date.now() - 3 * DAY));
    await pool.query("update feature_rollout set stage = 'van_hanh'");
    expect(await mode(pool, 'ceo-01')).toBe('van_hanh');
    await recordSevere(pool, 'ceo-01', 'lo_pii', BY);
    expect(await mode(pool, 'ceo-01')).toBe('chay_thu');
    await disable(pool, 'ceo-02', BY);
    expect(await mode(pool, 'ceo-02')).toBe('tat');
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('alter table feature_rollout rename to feature_rollout_x');
      expect(await mode(c, 'ceo-02')).toBe('chay_thu');
      expect((await c.query('select 1 as x')).rows[0].x).toBe(1); // savepoint: tx không hỏng
      await c.query('rollback');
      // login agent_writer thấy 'tat' → chặn sinh
      await c.query('begin');
      await c.query('set local role agent_writer');
      expect(await mode(c, 'ceo-02')).toBe('tat');
      await expect(checkGenerate(c, 'ceo-02', 'x')).rejects.toThrow(RolloutBlocked);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  // ------------------------------------------------------------ test_v14_p3_rollout_edges.py

  it('báo cáo của tính năng: sổ report_outputs, DISTINCT tên, bỏ mẫu; sha = bản trên đĩa', async () => {
    const dir = join(TMP, `rp-${name}`);
    await writeReport('Rủi ro tuần 1', dir, 'ceo-risk-2026-10-05.md');
    await writeReport('Rủi ro tuần 1 (sửa)', dir, 'ceo-risk-2026-10-05.md');
    await writeReport('Rủi ro tuần 2', dir, 'ceo-risk-2026-10-12.md');
    await writeReport('Số mẫu', dir, 'ceo-risk-2026-10-13.md', true);
    await writeReport('Rủi ro (MẪU) — dữ liệu mẫu', dir, 'ceo-risk-2026-10-14.md');
    await writeReport('khác', dir, 'report-2026.md');
    expect(await count('select count(*)::int as n from report_outputs')).toBe(5);
    const o = await outputFacts(
      pool,
      cat('ceo-03'),
      new Date(Date.now() - 30 * DAY),
      await dbNow(),
      SHIFT,
    );
    expect([o.outputs, o.uncounted, o.human]).toEqual([2, [], 0]);
    const rows = (
      await pool.query('select name, sha256, is_sample from report_outputs order by id')
    ).rows;
    expect(rows[0].sha256).toBe(
      createHash('sha256')
        .update(labelReport('ceo-risk-2026-10-05.md', 'Rủi ro tuần 1', 'chay_thu'), 'utf8')
        .digest('hex'),
    );
    expect(rows.map((r) => r.is_sample)).toEqual([false, false, false, true, true]);
    await expect(pool.query('delete from report_outputs')).rejects.toThrow(); // append-only
    // DB down → báo cáo vẫn ghi, không được đếm
    setConnector(async () => null);
    const p = await writeReport('x', dir, 'ceo-risk-2026-10-20.md');
    expect(readFileSync(p, 'utf8')).toContain('CHẠY THỬ — KHÔNG GỬI');
  });

  it('bảng riêng đếm DISTINCT theo khóa tự nhiên + provenance + bộ lọc danh mục', async () => {
    const t0 = new Date(Date.now() - 30 * DAY);
    const fx = async (fid: string) => outputFacts(pool, cat(fid), t0, await dbNow(), SHIFT);
    for (const [kind, lab, sha, smp] of [
      ['inside_out', '2026-09', 'a', false],
      ['inside_out', '2026-09', 'a', false],
      ['inside_out', '2026-08', 'b', false],
      ['inside_out', '2026-07', 'c', true],
      ['recon', '2026-09', 'd', false],
    ] as [string, string, string, boolean][]) {
      await pool.query(
        "insert into audit_runs (kind, period_label, findings, report_sha256, run_by, is_sample) values ($1, $2, 0, $3, 'agent:x', $4)",
        [kind, lab, sha.repeat(64), smp],
      );
    }
    expect((await fx('ceo-04.6')).outputs).toBe(2);
    expect((await fx('ceo-04.9')).outputs).toBe(1);
    for (const [rid, sku, smp, st, by] of [
      ['r1', 'a', false, 'pending', null],
      ['r2', 'a', false, 'approved', 'GĐ SX'],
      ['r1', 'b', false, 'approved', 'agent:x'],
      ['r1', 'c', true, 'pending', null],
    ] as [string, string, boolean, string, string | null][]) {
      await pool.query(
        'insert into allocation_proposals (run_id, cutoff_id, cutoff_date, start_week, sku_key, channel,' +
          ' demand_low, demand_base, demand_high, proposed_qty, is_sample, status, decided_by, decided_at)' +
          " values ($1, 'tet', '2026-11-01', '2026-10-19', $2, 'shopee', 1, 2, 3, 2, $3, $4, $5, $6)",
        [rid, sku, smp, st, by, by === null ? null : new Date()],
      );
    }
    const o = await fx('production-01');
    expect([o.outputs, o.human, o.unapproved]).toEqual([2, 1, 1]);
    const ra = "insert into red_alerts (source_agent, title, detail) values ($1, 't', $2::jsonb)";
    await pool.query(ra, [
      'intel_red_alert',
      JSON.stringify({ intel_item_id: 1, rules: ['brand_negative'] }),
    ]);
    await pool.query(ra, [
      'intel_red_alert',
      JSON.stringify({ intel_item_id: 2, rules: ['legal_doc'] }),
    ]);
    await pool.query(ra, ['intel_red_alert', JSON.stringify({ escalation_of: 1 })]);
    await pool.query(ra, ['khac', JSON.stringify({ intel_item_id: 3, rules: ['brand_negative'] })]);
    expect((await fx('intel-02')).outputs).toBe(1);
  });

  it('1 lệnh --seed ghi N dòng sổ ≠ N đầu ra; quyết định người (tắt) mới tính', async () => {
    const t0 = new Date(Date.now() - 30 * DAY);
    const ev = ff('data_platform-09', [{ table: 'feature_rollout_events' }]);
    await seed(pool, CAT, BY, new Date(Date.now() - DAY));
    expect((await outputFacts(pool, ev, t0, await dbNow(), SHIFT)).outputs).toBe(0);
    await disable(pool, 'ceo-03', BY);
    const o = await outputFacts(pool, ev, t0, await dbNow(), SHIFT);
    expect([o.outputs, o.human]).toEqual([1, 1]);
  });

  it('cờ is_sample của hàng duyệt: mục dựng trên số MẪU (tiêu đề/mã bình thường) không là đầu ra', async () => {
    const hd = ff('ceo-05', [{ table: 'approval_queue', block: 'ceo', object_type: 'hdtv_pack' }]);
    for (const [oid, sample] of [
      ['2026-09', true],
      ['2026-08', false],
    ] as [string, boolean][]) {
      await enqueue(pool, {
        objectType: 'hdtv_pack',
        objectId: oid,
        block: 'ceo',
        title: `Gói báo cáo HĐTV tháng ${oid}`,
        payload: 'Gói báo cáo HĐTV tháng — số có nguồn.',
        risk: 'medium',
        createdBy: 'agent:hdtv_report',
        slaHours: 24,
        sample,
      });
    }
    expect(
      await count(
        "select count(*) as n from approval_queue where object_type = 'hdtv_pack' and is_sample",
      ),
    ).toBe(1);
    const o = await outputFacts(pool, hd, new Date(Date.now() - DAY), await dbNow(), SHIFT);
    expect(o.outputs).toBe(1);
  });

  it('danh mục THẬT: mọi nguồn bảng/báo cáo có bộ đếm và SQL chạy được trên schema thật', async () => {
    const real = loadFeatures(dataPath('contract_features.json'));
    let seen = 0;
    for (const x of real) {
      const o = await outputFacts(pool, x, new Date(Date.now() - 30 * DAY), await dbNow(), SHIFT);
      for (const u of o.uncounted) expect(u.startsWith('file='), `${x.id} ${u}`).toBe(true);
      seen += x.output_sources.length;
    }
    expect(seen).toBeGreaterThan(80);
  });

  // ------------------------------------------------------------ test_v15_p8_outputs.py

  it('báo cáo cần NGƯỜI duyệt đúng phiên bản; nội dung đổi → duyệt lại; rồi mới vận hành', async () => {
    const since = new Date(Date.now() - 30 * DAY);
    await stageOf('ceo-03', 'co_nguoi_duyet', since);
    const dir = join(TMP, `rv-${name}`);
    const nm = 'ceo-risk-2026-10-05.md';
    let p = await writeReport('# Rủi ro A\n', dir, nm, false);
    let fx = await facts(pool, cat('ceo-03'), 'co_nguoi_duyet', since, await dbNow(), SHIFT);
    expect([fx.outputs, fx.human, fx.unreviewed, fx.target]).toEqual([1, 0, 1, 'van_hanh']);
    expect(fx.why.length).toBeGreaterThan(0);
    await expect(promote(pool, CAT, 'ceo-03', BY, SHIFT)).rejects.toThrow('chưa có NGƯỜI duyệt');
    const pend = await pendingOutputs(pool, CAT, 'ceo-03');
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(pend.map((x) => [x.key, x.sha, x.review])).toEqual([[`rp:${nm}`, sha, null]]);
    await expect(
      reviewOutput(pool, CAT, 'ceo-03', `rp:${nm}`, '0'.repeat(64), 'approved', BY),
    ).rejects.toThrow('sha không khớp');
    await expect(
      reviewOutput(pool, CAT, 'ceo-03', 'rp:ceo-risk-khac.md', sha, 'approved', BY),
    ).rejects.toThrow('không phải đầu ra');
    for (const bad of ['agent:x', 'system:cron', '']) {
      await expect(
        reviewOutput(pool, CAT, 'ceo-03', `rp:${nm}`, sha, 'approved', bad),
      ).rejects.toThrow(RangeError);
    }
    await expect(reviewOutput(pool, CAT, 'ceo-03', `rp:${nm}`, sha, 'ok', BY)).rejects.toThrow(
      '--decision',
    );
    expect(await count('select count(*)::int as n from output_reviews')).toBe(0);
    const id = await reviewOutput(
      pool,
      CAT,
      'ceo-03',
      `rp:${nm}`,
      sha,
      'approved',
      BY,
      'đã đọc, gọi 0905123456',
    );
    expect(typeof id).toBe('bigint');
    fx = await facts(pool, cat('ceo-03'), 'co_nguoi_duyet', since, await dbNow(), SHIFT);
    expect([fx.human, fx.unreviewed, fx.why]).toEqual([1, 0, []]);
    p = await writeReport('# Rủi ro A (sửa số)\n', dir, nm, false);
    fx = await facts(pool, cat('ceo-03'), 'co_nguoi_duyet', since, await dbNow(), SHIFT);
    expect([fx.human, fx.unreviewed]).toEqual([0, 1]);
    const sha2 = createHash('sha256').update(readFileSync(p)).digest('hex');
    // DB tự kiểm phiên bản mới nhất + danh tính (gọi thẳng function)
    await expect(
      pool.query("select output_review_human('ceo-03', $1, $2, 'approved', $3, null)", [
        `rp:${nm}`,
        sha,
        BY,
      ]),
    ).rejects.toThrow(/MỚI NHẤT/);
    await expect(
      pool.query("select output_review_human('ceo-03', $1, $2, 'approved', 'agent:ceo', null)", [
        `rp:${nm}`,
        sha2,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await reviewOutput(pool, CAT, 'ceo-03', `rp:${nm}`, sha2, 'approved', BY);
    const r = await promote(pool, CAT, 'ceo-03', BY, SHIFT);
    expect([r.to, r.facts.why]).toEqual(['van_hanh', []]);
    const ev = (
      await pool.query("select evidence from feature_rollout_events where kind = 'promote'")
    ).rows[0].evidence;
    expect([ev.unreviewed, ev.human]).toEqual([0, 1]);
    const rv = (
      await pool.query(
        'select output_key, content_sha256, decision, reviewed_by, note from output_reviews order by id',
      )
    ).rows;
    expect(rv.map((x) => [x.output_key, x.content_sha256, x.decision, x.reviewed_by])).toEqual([
      [`rp:${nm}`, sha, 'approved', BY],
      [`rp:${nm}`, sha2, 'approved', BY],
    ]);
    expect(rv[0].note).not.toContain('0905123456');
  });

  it('đầu ra bảng: từ chối ≠ duyệt; sổ duyệt không đọc được → coi như chưa duyệt', async () => {
    const since = new Date(Date.now() - 30 * DAY);
    await stageOf('ceo-04.6', 'co_nguoi_duyet', since);
    await pool.query(
      "insert into audit_runs (kind, period_label, findings, report_sha256, run_by) values ('inside_out', '2026-09', 0, $1, 'agent:bks')",
      ['f'.repeat(64)],
    );
    const fz = async () =>
      facts(pool, cat('ceo-04.6'), 'co_nguoi_duyet', since, await dbNow(), SHIFT);
    let fx = await fz();
    expect([fx.outputs, fx.human, fx.unreviewed]).toEqual([1, 0, 1]);
    const [o] = await pendingOutputs(pool, CAT, 'ceo-04.6');
    expect(o?.key).toBe(`ar:inside_out/2026-09/${'f'.repeat(64)}`);
    expect(o?.sha?.length).toBe(64);
    await reviewOutput(pool, CAT, 'ceo-04.6', o?.key as string, o?.sha, 'rejected', BY);
    fx = await fz();
    expect([fx.human, fx.unreviewed]).toEqual([0, 0]);
    expect(fx.why.some((w) => w.includes('NGƯỜI duyệt từng mục'))).toBe(true);
    await reviewOutput(pool, CAT, 'ceo-04.6', o?.key as string, o?.sha, 'approved', BY);
    fx = await fz();
    expect([fx.human, fx.why]).toEqual([1, []]);
    await pool.query('alter table output_reviews rename to output_reviews_x');
    fx = await fz();
    expect([fx.human, fx.unreviewed]).toEqual([0, 1]);
  });

  it('DB đếm lại (rollout_db_facts trên count_spec) KHỚP outputFacts TS', async () => {
    const srcs: Source[] = [
      { table: 'approval_queue', block: 'ceo', object_type: 'weekly_report' },
      { table: 'content_drafts', created_by: 'agent:p8par', content_type: 'post' },
      { report: 'ceo-par-' },
      {
        table: 'red_alerts',
        source_agent: 'intel_red_alert',
        rules_any: ['legal_doc', 'regulation'],
      },
      { table: 'audit_runs', kind: 'inside_out' },
      { table: 'decision_log' },
      { table: 'bang_chua_co_bo_dem' },
    ];
    const fe = ff('ceo-01', srcs);
    const a = new Date('2026-10-01T00:00:00+07:00'); // T5
    const shift = parseShift({
      start: '00:00',
      end: '23:59',
      workdays: [0, 1, 2, 3, 4],
      holidays: ['2026-10-06'],
    });
    const c = await pool.connect();
    const q = (sql: string, args: unknown[] = []) => c.query(sql, args);
    const plus = (dd: number, hh = 0) => new Date(a.getTime() + dd * DAY + hh * 3600_000);
    try {
      await q('begin');
      await q('set local session_replication_role = replica');
      for (const [oid, dd, ok, smp, st, lane, by] of [
        ['wr-1', 1, true, false, 'approved', 'per_item', 'Người A'],
        ['wr-2', 2, true, false, 'approved', 'auto_policy', 'agent:x'],
        ['wr-3', 2, true, false, 'approved', 'per_item', 'system:cron'],
        ['wr-4', 3, true, false, 'pending', null, null],
        ['wr-5', 3, false, false, 'pending', null, null],
        ['wr-6', 4, true, true, 'pending', null, null],
        ['wr-mau-7', 4, true, false, 'pending', null, null],
        ['wr-8', 40, true, false, 'pending', null, null],
      ] as [string, number, boolean, boolean, string, string | null, string | null][]) {
        const ts = plus(dd, 3);
        await q(
          'insert into approval_queue (object_type, object_id, block, title, payload, content_sha256, risk,' +
            ' guardrail, created_by, created_at, due_at, status, lane, decided_by, is_sample) values' +
            " ('weekly_report', $1, 'ceo', 'Báo cáo tuần', 'x', $2, 'low', $3::jsonb, 'agent:ceo_report', $4, $4, $5, $6, $7, $8)",
          [oid, '0'.repeat(64), JSON.stringify({ ok }), ts, st, lane, by, smp],
        );
      }
      for (const [i, [st, rv, src]] of (
        [
          ['approved', 'Người B', 'cli'],
          ['approved', 'agent:y', 'cli'],
          ['pending', null, 'sample:x'],
          ['pending', null, 'cli'],
        ] as [string, string | null, string][]
      ).entries()) {
        await q(
          'insert into content_drafts (created_at, brief, channel, text, guardrail, status, reviewer, source,' +
            " created_by, content_type) values ($1, 'brief', 'facebook', $2, '{\"ok\": true}', $3, $4, $5, 'agent:p8par', 'post')",
          [plus(1 + i), `nháp ${i}`, st, rv, src],
        );
      }
      for (const [nm, sha, dd] of [
        ['ceo-par-1.md', 'a', 1],
        ['ceo-par-1.md', 'b', 2],
        ['ceo-par-2.md', 'c', 5],
        ['ceo-par-3.md', 'd', 6],
      ] as [string, string, number][]) {
        await q(
          "insert into report_outputs (feature_id, name, sha256, created_at) values ('ceo-01', $1, $2, $3)",
          [nm, sha.repeat(64), plus(dd)],
        );
      }
      for (const [i, [agent, rules, dd]] of (
        [
          ['intel_red_alert', ['legal_doc'], 7],
          ['intel_red_alert', ['brand_negative'], 7],
          ['khac', ['legal_doc'], 7],
          ['intel_red_alert', ['regulation', 'x'], 8],
        ] as [string, string[], number][]
      ).entries()) {
        await q(
          "insert into red_alerts (ts, source_agent, title, detail) values ($1, $2, 'Cảnh báo', $3::jsonb)",
          [plus(dd), agent, JSON.stringify({ rules, intel_item_id: `it${i}` })],
        );
      }
      await q(
        "insert into red_alert_acks (alert_id, acked_by) select id, 'Người C' from red_alerts where detail->>'intel_item_id' = 'it3'",
      );
      for (const kind of ['inside_out', 'recon']) {
        await q(
          "insert into audit_runs (kind, period_label, findings, report_sha256, run_by, created_at) values ($1, '2026-09', 0, $2, 'agent:bks', $3)",
          [kind, 'f'.repeat(64), plus(11)],
        );
      }
      await q(
        'insert into decision_log (entry_kind, decided_on, topic, decision, decided_by, basis_kind, note, recorded_by,' +
          " recorded_at) values ('quyet_dinh', '2026-10-12', 'Chủ đề', 'Quyết định', 'TGĐ', 'van_ban', 'Văn bản giả p8', 'Người D', $1)",
        [plus(12)],
      );
      await q(
        "insert into feature_rollout (feature_id, stage, updated_by) values ('ceo-01', 'co_nguoi_duyet', 'test-p8')",
      );
      const [ar] = await outputRows(c, fe, a, plus(20));
      const arKey = [...ar.keys()].find((k) => k.startsWith('ar:')) as string;
      for (const [key, sha, dec] of [
        ['rp:ceo-par-1.md', 'a'.repeat(64), 'approved'],
        ['rp:ceo-par-1.md', 'b'.repeat(64), 'approved'],
        ['rp:ceo-par-2.md', 'c'.repeat(64), 'rejected'],
        [arKey, ar.get(arKey)?.sha, 'approved'],
      ] as [string, string, string][]) {
        await q(
          "insert into output_reviews (feature_id, output_key, content_sha256, decision, reviewed_by) values ('ceo-01', $1, $2, $3, $4)",
          [key, sha, dec, BY],
        );
      }
      const spec = JSON.stringify(countSpec(fe, shift));
      let last: unknown[] = [];
      for (const b of [plus(20), plus(6, 1), plus(2)]) {
        const ts = await outputFacts(c, fe, a, b, shift);
        const db = (
          await c.query({
            text:
              'select count(*)::int, (count(distinct p10_vn_date(ts)) filter (where rollout_workday(p10_vn_date(ts), $1::jsonb)))::int,' +
              ' (count(*) filter (where human))::int, (count(*) filter (where unapp))::int, (count(*) filter (where unrev))::int,' +
              " rollout_business_days($2, $3, $1::jsonb) from rollout_db_facts('ceo-01', $1::jsonb, $2, $3)",
            values: [spec, a, b],
            rowMode: 'array',
          })
        ).rows[0];
        expect(ts.uncounted).toEqual(['table=bang_chua_co_bo_dem']);
        last = [ts.outputs, ts.out_days, ts.human, ts.unapproved, ts.unreviewed];
        expect([...last, businessDays(a, b, shift)], b.toISOString()).toEqual(db);
        const keys = (
          await c.query({
            text: "select k from rollout_db_facts('ceo-01', $1::jsonb, $2, $3)",
            values: [spec, a, b],
            rowMode: 'array',
          })
        ).rows.map((r) => r[0]);
        expect(new Set((await outputRows(c, fe, a, b))[0].keys())).toEqual(new Set(keys));
      }
      expect(last).not.toEqual([0, 0, 0, 0, 0]);
      const full = await outputFacts(c, fe, a, plus(20), shift);
      expect([full.outputs, full.out_days, full.human, full.unapproved, full.unreviewed]).toEqual([
        14, 7, 6, 3, 1,
      ]);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  // ------------------------------------------------------------ test_acceptance_matrix.py

  it('acceptance: CHÍNH người duyệt cần login hợp lệ đúng khối + bằng chứng đăng nhập thật', async () => {
    const data = join(TMP, `acc-${name}`);
    cpSync(dataPath('directors'), join(data, 'directors'), { recursive: true });
    const cfg = JSON.parse(readFileSync(join(data, 'directors', 'sales.json'), 'utf8'));
    cfg.approvers = ['Người Duyệt Giả'];
    writeFileSync(join(data, 'directors', 'sales.json'), JSON.stringify(cfg));
    const OK = { E1: null, E2: null, E3: null };
    const fa: Record<string, unknown> = {
      id: 'sales-99',
      phong_ban: 'sales',
      pham_vi: 'tinh_nang_ai',
      giai_doan: 'P1',
      ten: 'thử',
      nguon: 'PL01',
      dau_ra: 'nháp',
      nguoi_duyet: 'Giám đốc bán hàng',
      modules: ['agents/x.py'],
      output_sources: [{ table: 'approval_queue', block: 'sales', object_type: 't99' }],
      code_status: 'co_code',
      acceptance_status: 'chua_nghiem_thu',
      blocker: '',
      bang_chung: [],
    };
    const tag = `${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
    const [ok, other, nolog] = ['ok', 'ot', 'nl'].map((k) => `t_mx_${k}_${tag}`) as [
      string,
      string,
      string,
    ];
    await adminQuery(`create role ${ok} login in role app_human`);
    await adminQuery(`create role ${other} login in role app_human`);
    await adminQuery(`create role ${nolog} nologin in role app_human`);
    try {
      const row = async () =>
        acc.buildRows(
          [fa],
          data,
          OK,
          await acc.personLogins(pool),
          await acc.ledger(pool),
        )[0] as acc.MatrixRow;
      const maps = async (...rs: [string, string, string[], boolean][]) => {
        await pool.query('delete from human_logins');
        for (const [login, person, blocks, active] of rs) {
          await pool.query(
            "insert into human_logins (db_login, person, blocks, active, granted_by) values ($1, $2, $3, $4, 't')",
            [login, person, blocks, active],
          );
        }
        return row();
      };
      for (const rs of [
        [],
        [[other, 'Người Khác', ['sales'], true]],
        [[ok, 'Người Duyệt Giả', ['finance'], true]],
        [[ok, 'Người Duyệt Giả', ['sales'], false]],
        [[nolog, 'Người Duyệt Giả', ['sales'], true]],
      ] as [string, string, string[], boolean][][]) {
        const r = await maps(...rs);
        expect(r.status, JSON.stringify(rs)).toBe(acc.NOT_READY);
        expect(r.thieu.some((m) => m.includes('chưa có login hợp lệ'))).toBe(true);
      }
      let r = await maps([ok, 'người  duyệt giả', ['sales'], true]); // khớp chuẩn hóa
      expect(r.status).toBe(acc.NOT_READY);
      expect(r.thieu.some((m) => m.includes('bằng chứng đăng nhập thật'))).toBe(true);
      await pool.query(
        "insert into human_login_checks (db_login, person) values ($1, 'Người Cũ Của Login'), ($2, 'Người Duyệt Giả')",
        [ok, other],
      );
      r = await row();
      expect(
        r.thieu.some(
          (m) => m.includes('bằng chứng đăng nhập thật') && m.includes('Người Duyệt Giả'),
        ),
      ).toBe(true);
      await pool.query(
        "insert into human_login_checks (db_login, person) values ($1, 'Người Duyệt Giả')",
        [ok],
      );
      r = await row();
      expect([r.status, r.thieu]).toEqual([acc.READY, []]);
      for (const [stmt, undo] of [
        ["valid until '2000-01-01'", "valid until 'infinity'"],
        ['connection limit 0', 'connection limit -1'],
      ]) {
        await adminQuery(`alter role ${ok} ${stmt}`);
        expect((await row()).status, stmt).toBe(acc.NOT_READY);
        await adminQuery(`alter role ${ok} ${undo}`);
      }
      await pool.query('alter table human_logins rename to human_logins_x');
      r = await row();
      expect(r.status).toBe(acc.NOT_READY);
      expect(r.thieu.some((m) => m.includes('không kiểm được'))).toBe(true);
    } finally {
      for (const r2 of [ok, other, nolog]) await adminQuery(`drop role if exists ${r2}`);
    }
  });

  it('login NGƯỜI (app_human): liệt kê/duyệt qua function DB, sai người → 42501, DB đếm lại khi nâng', async () => {
    const P = 'Người Duyệt Giả Lập';
    const nm = 'ceo-risk-2026-10-09.md';
    const sha = createHash('sha256').update('# R p8\n').digest('hex');
    await stageOf('ceo-03', 'co_nguoi_duyet', new Date(Date.now() - 30 * DAY));
    await pool.query(
      "insert into report_outputs (feature_id, name, sha256) values ('ceo-03', $1, $2)",
      [nm, sha],
    );
    const login = `t_rh_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
    const pw = `p${Math.random().toString(36).slice(2)}A9`;
    await adminQuery(`create role ${login} login password '${pw}' in role app_human`);
    await pool.query(
      "insert into human_logins (db_login, person, blocks, active, granted_by) values ($1, $2, $3, true, 't')",
      [login, P, ['ceo']],
    );
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    const hp = createPool(u.toString());
    const st = installFakeDeps({ rollout: opsRollout });
    try {
      const pend = await pendingOutputs(hp, CAT, 'ceo-03');
      expect(pend.map((x) => [x.key, x.sha, x.review])).toEqual([[`rp:${nm}`, sha, null]]);
      // DB tự chặn nâng khi báo cáo CHƯA có người duyệt, kể cả bằng chứng caller khai 0
      await expect(
        hp.query(
          "select rollout_transition_human('ceo-03', 'promote', 'co_nguoi_duyet', 'van_hanh', $1, null, null, $2::jsonb, now())",
          [P, JSON.stringify({ human: 1, unapproved: 0, unreviewed: 0 })],
        ),
      ).rejects.toThrow('1 chưa duyệt');
      // --by không phải người của login → DB 42501 → authz_denied + từ chối
      await expect(
        reviewOutput(hp, CAT, 'ceo-03', `rp:${nm}`, sha, 'approved', 'Người Khác'),
      ).rejects.toThrow(RolloutError);
      expect(st.denied.length).toBeGreaterThanOrEqual(1);
      expect(await count('select count(*)::int as n from output_reviews')).toBe(0);
      const id = await reviewOutput(hp, CAT, 'ceo-03', `rp:${nm}`, sha, 'approved', P);
      expect(typeof id).toBe('bigint');
      const rv = (await pool.query('select reviewed_by, content_sha256 from output_reviews')).rows;
      expect(rv).toEqual([{ reviewed_by: P, content_sha256: sha }]);
      // login người không SELECT bảng nguồn → số DB đếm lại; DB quyết chuyển giai đoạn
      const r = await promote(hp, CAT, 'ceo-03', P, SHIFT);
      expect([r.from, r.to]).toEqual(['co_nguoi_duyet', 'van_hanh']);
      expect((await state('ceo-03'))?.stage).toBe('van_hanh');
    } finally {
      await hp.end();
      await pool.query('delete from human_logins').catch(() => {});
      await adminQuery(`drop role if exists ${login}`);
    }
  });

  it('hồ sơ: sổ sự cố vận hành từ DB; bảng thiếu → null (CHƯA CÓ DỮ LIỆU)', async () => {
    const t0 = new Date('2026-11-02T01:00:00Z');
    const iid = (
      await pool.query(
        'insert into ops_incidents (title, severity, source, ben_trach_nhiem, detected_at, created_by)' +
          " values ('Webhook ngừng', 'nghiem_trong', 'probe', 'ben_a', $1, 'Người Trực Giả') returning id",
        [t0],
      )
    ).rows[0].id;
    await pool.query(
      "insert into ops_incident_events (incident_id, kind, at, by_name) values ($1, 'responded', $2, 'Người Trực Giả'), ($1, 'fixed', $3, 'Người Trực Giả')",
      [iid, new Date(t0.getTime() + 3600_000), new Date(t0.getTime() + 2 * DAY)],
    );
    const inc = await incidentRows(pool);
    expect(inc?.map((i) => [i.severity, i.responded?.getTime(), i.fixed?.getTime()])).toEqual([
      ['nghiem_trong', t0.getTime() + 3600_000, t0.getTime() + 2 * DAY],
    ]);
    const md = renderDossier('P1', [], [], 0, t0, {
      incidents: inc,
      versions: { commit: 'abc' },
      exceptions: ['E1: thiếu'],
    });
    const sec = md.split('## 3b.')[1]?.split('## 4.')[0] ?? '';
    expect(sec).toContain('Webhook ngừng');
    expect(sec).toContain('02/11/2026 09:00');
    expect(md).toContain('- commit: `abc`');
    expect(md).toContain('- E1: thiếu');
    await pool.query('alter table ops_incidents rename to ops_incidents_x');
    expect(await incidentRows(pool)).toBeNull();
  });
});
