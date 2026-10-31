import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { type FakeState, installFakeDeps } from '@samsam/core/ops/testing';
import { wireSecurity } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import G from './__fixtures__/ceo_report.golden.json' with { type: 'json' };
import {
  type CeoReportOpts,
  type CliDeps,
  type CockpitOpts,
  ceoReportMain,
  cockpitMain,
} from './ceo-report.command.js';
import { SECTION_HEADS, type SnapIn, setCeoSections } from './ceo-report.js';

// Dịch phần KHÔNG cần DB của tests/test_cockpit.py + tests/test_ceo_report.py (CLI): sai tham số /
// kỳ chưa đóng / file CSV lỗi / cờ MẪU lệch tên file → exit trước connect; DB down → exit 2 không
// ghi file; trang vi phạm guardrail KHÔNG nộp; cổng TẮT ceo-01 chặn trước khi dựng trang/gọi LLM;
// LLM mặc định tắt (0 lời gọi); 3 section v8.1 lỗi riêng từng cái, che PII. Số trong fixture là số
// MẪU bịa; tên người là tên giả lập.

const NOW = new Date('2026-10-12T09:00:00+07:00');
const FIX = repoPath('tests', 'fixtures', 'cockpit');
type GSnap = [string, string, string, string, string, string | null, string | null];
const FULL: SnapIn[] = (G.variants.full_red.snaps as GSnap[]).map(
  ([ch, mid, ps, val, src, ref, cap]) => ({
    channel: ch,
    metric_id: mid,
    period_start: ps,
    value: val,
    source: src,
    source_ref: ref,
    captured_at: cap === null ? null : new Date(cap),
  }),
);

let tmp: string;
let routingRed: string;
let st: FakeState;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ceo-cli-'));
  routingRed = join(tmp, 'routing.json');
  writeFileSync(routingRed, '{"recipients": [], "excluded_roles": ["tgd"]}');
});
afterAll(() => {
  resetOpsDeps();
  settings.forceMode = null;
  setCeoSections(null);
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  st = installFakeDeps();
  settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
  setCeoSections(null);
});
afterEach(() => {
  settings.forceMode = 'van_hanh';
});

/** DB giả: SELECT channel_snapshots trả snapshot; savepoint no-op; `enqueue_item` đếm lời gọi. */
function fakeDb(snaps: SnapIn[] = FULL) {
  const calls: string[] = [];
  const enq: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (/^(savepoint|release savepoint|rollback to savepoint)/.test(sql)) return { rows: [] };
      if (sql.includes('from channel_snapshots')) {
        const [, cur, prev] = params as string[];
        return { rows: snaps.filter((s) => s.period_start === cur || s.period_start === prev) };
      }
      if (sql.includes('enqueue_item')) {
        enq.push(params);
        return { rows: [{ id: String(100 + enq.length) }] };
      }
      throw new Error(`query lạ trong test: ${sql}`);
    },
  } as unknown as Db;
  return { db, calls, enq };
}

const noConnect = async () => {
  throw new Error('connect không được gọi');
};

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

async function cockpit(o: CockpitOpts, extra: Partial<CliDeps> = {}) {
  const s = io();
  const rc = await cockpitMain(o, { io: s.io, now: NOW, connect: noConnect, ...extra });
  return { rc, out: s.out.join('\n'), err: s.err.join('\n') };
}

async function ceo(o: CeoReportOpts, extra: Partial<CliDeps> = {}) {
  const s = io();
  const rc = await ceoReportMain(o, {
    io: s.io,
    now: NOW,
    connect: noConnect,
    routing: routingRed,
    ...extra,
  });
  return { rc, out: s.out.join('\n'), err: s.err.join('\n') };
}

describe('cockpit CLI (không DB)', () => {
  it('--metrics: in từ điển; file hỏng → exit 1', async () => {
    const r = await cockpit({ metrics: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('internal');
    expect(r.out).toContain('external');
    const bad = join(tmp, 'metrics.json');
    writeFileSync(bad, '{hỏng');
    const r2 = await cockpit({ metrics: true }, { metricsPath: bad });
    expect(r2.rc).toBe(1);
    expect(r2.err).toBe('[error] data/metrics.json: metrics.json hỏng: JSONDecodeError');
  });

  it.each<[string, CockpitOpts]>([
    ['thieu-by', { import: 'x.csv' }],
    ['by-trang', { import: 'x.csv', by: '  ' }],
    ['import+collect', { import: 'x.csv', by: 'X', collect: true }],
    ['metrics+collect', { metrics: true, collect: true }],
    ['khong-op', {}],
    ['collect+by', { collect: true, by: 'X' }],
    ['metrics+dryrun', { metrics: true, dryRun: true }],
    ['ref-sai', { collect: true, ref: '12/10/2026' }],
    ['period-la', { collect: true, period: 'year' }],
  ])('sai tham số %s → exit 2 trước connect', async (_n, o) => {
    const r = await cockpit(o);
    expect(r.rc).toBe(2);
    expect(r.err).toMatch(/^cockpit: error: /);
  });

  it('kỳ chưa đóng / ngày không có thật → exit 2 trước connect', async () => {
    let r = await cockpit({ collect: true, period: 'week', ref: '2026-10-12' });
    expect([r.rc, r.err]).toEqual([2, '[error] kỳ chưa đóng (2026-10-12 → hết 2026-10-18 giờ VN)']);
    r = await cockpit({ collect: true, period: 'month', ref: '2026-10-01' });
    expect(r.rc).toBe(2);
    r = await cockpit({ collect: true, ref: '2026-02-30' });
    expect([r.rc, r.err]).toEqual([2, '[error] day is out of range for month']);
  });

  it('DB down → exit 2', async () => {
    const down = { connect: async () => null };
    expect((await cockpit({ collect: true, ref: '2026-10-05' }, down)).rc).toBe(2);
    const r = await cockpit(
      { import: join(FIX, 'kenh_MAU.csv'), by: 'X', sample: true },
      { ...down, now: NOW },
    );
    expect(r.rc).toBe(2);
    expect(r.err).toContain('không kết nối được Postgres');
  });

  it('--import file lỗi → exit 1, 0 dòng, không connect, không in giá trị ô', async () => {
    const r = await cockpit({ import: join(FIX, 'kenh_loi.csv'), by: 'X' });
    expect(r.rc).toBe(1);
    expect(r.err).toContain('0 dòng');
    expect(r.err).not.toContain('21.585.320');
    expect(r.err).not.toContain('lazada');
  });

  it('--import: tên file MẪU và cờ --sample phải khớp (không nạp số mẫu như số thật)', async () => {
    let r = await cockpit({ import: join(FIX, 'kenh_MAU.csv'), by: 'X' });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('--sample');
    const real = join(tmp, 'shopee_w41.csv');
    writeFileSync(real, readFileSync(join(FIX, 'kenh_MAU.csv')));
    r = await cockpit({ import: real, by: 'X', sample: true });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('--sample');
  });

  it('--import > 50 lỗi: in 50 dòng đầu + đếm phần còn lại', async () => {
    const p = join(tmp, 'nhieu_loi.csv');
    let body = 'channel,metric_id,period_kind,period_start,value\n';
    for (let i = 0; i < 60; i++) body += `lazada,sales.gmv_vnd,week,2026-10-05,${i}\n`;
    writeFileSync(p, body);
    const r = await cockpit({ import: p, by: 'X' });
    expect(r.rc).toBe(1);
    const lines = r.err.split('\n');
    expect(lines.filter((l) => l.startsWith('[error] dòng ')).length).toBe(50);
    expect(lines).toContain('[error] ... và 10 lỗi khác');
  });
});

describe('ceo-report CLI (không DB)', () => {
  it('kỳ chưa đóng / ngày sai → exit 2 trước connect', async () => {
    for (const o of [
      { ref: '2026-10-12', outDir: tmp },
      { period: 'month', ref: '2026-10-01' },
      { ref: '2026-02-30' },
    ]) {
      expect((await ceo(o)).rc).toBe(2);
    }
  });

  it('DB down → exit 2, không ghi file', async () => {
    const out = mkdtempSync(join(tmp, 'down-'));
    const r = await ceo({ ref: '2026-10-05', outDir: out }, { connect: async () => null });
    expect(r.rc).toBe(2);
    expect(readdirSync(out)).toEqual([]);
    const r2 = await ceo({ bulletin: true, outDir: out }, { connect: async () => null });
    expect(r2.rc).toBe(2);
    expect(readdirSync(out)).toEqual([]);
  });

  it.each<CeoReportOpts>([
    { bulletin: true, submit: true },
    { bulletin: true, llm: true },
    { bulletin: true, period: 'week' },
    { bulletin: true, ref: '2026-10-05' },
    { bulletin: true, now: '12/10/2026' },
    { now: '2026-10-12T09:00' },
    { period: 'quarter' },
  ])('--bulletin sai tổ hợp %o → exit 2 trước connect', async (o) => {
    const r = await ceo(o);
    expect(r.rc).toBe(2);
    expect(r.err).toMatch(/^ceo-report: error: /);
  });

  it('trang vi phạm guardrail: vẫn ghi file có dòng cảnh báo nhưng --submit KHÔNG nộp (exit 1)', async () => {
    const out = mkdtempSync(join(tmp, 'gr-'));
    st = installFakeDeps({
      guardrailCheck: () => ({ ok: false, violations: [{ type: 'banned_word' }] }),
    });
    const f = fakeDb();
    const r = await ceo(
      { ref: '2026-10-05', submit: true, outDir: out },
      { connect: async () => ({ db: f.db, release: async () => {} }), wire: () => null },
    );
    expect(r.rc).toBe(1);
    expect(f.enq).toEqual([]);
    expect(r.err).toContain('KHÔNG nộp');
    expect(r.out).toContain('[warn] guardrail vi phạm: banned_word');
    expect(readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8')).toContain('CẢNH BÁO GUARDRAIL');
    // Đối chứng: trang sạch → nộp đúng 1 lần, payload = trang, người tạo agent (không tự duyệt).
    st = installFakeDeps();
    const f2 = fakeDb();
    const r2 = await ceo(
      { ref: '2026-10-05', submit: true, outDir: out },
      { connect: async () => ({ db: f2.db, release: async () => {} }), wire: () => null },
    );
    expect(r2.rc).toBe(0);
    expect(f2.enq.length).toBe(1);
    const p = f2.enq[0] as unknown[];
    expect(p.slice(0, 4)).toEqual([
      'weekly_report',
      '2026-W41',
      'ceo',
      'Báo cáo tuần 2026-W41 — TGĐ',
    ]);
    expect(p[4]).toBe(readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8'));
    expect(p[8]).toBe('agent:ceo_report');
    expect(r2.out).toContain('[submit] mục #101 vào hàng chờ khối ceo');
    expect(st.recorded.map((x) => [x.name, x.sample, x.fid])).toEqual([
      ['ceo-2026-W41.md', true, 'ceo-01'],
    ]);
  });

  it('cổng TẮT ceo-01 → [rollout] exit 2, 0 câu đọc nguồn, không file', async () => {
    settings.forceMode = 'tat';
    const out = mkdtempSync(join(tmp, 'tat-'));
    const f = fakeDb();
    const r = await ceo(
      { ref: '2026-10-05', submit: true, llm: true, outDir: out },
      { connect: async () => ({ db: f.db, release: async () => {} }), wire: () => null },
    );
    expect(r.rc).toBe(2);
    expect(r.out).toMatch(/^\[rollout\] báo cáo tuần TGĐ: tính năng ceo-01 đang tắt/);
    expect(f.calls).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  });

  it('LLM mặc định TẮT: 0 lời gọi gateway; --llm số tự viết → bị loại, rơi về luật', async () => {
    const calls: unknown[] = [];
    const ai = {
      chat: async (...a: unknown[]) => {
        calls.push(a);
        return { text: 'GMV tăng 12%' } as never;
      },
    };
    const out = mkdtempSync(join(tmp, 'llm-'));
    const f = fakeDb();
    const deps = { connect: async () => ({ db: f.db, release: async () => {} }), wire: () => ai };
    let r = await ceo({ ref: '2026-10-05', outDir: out }, deps);
    expect(r.rc).toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8')).toContain('theo luật');
    r = await ceo({ ref: '2026-10-05', llm: true, outDir: out }, deps);
    expect(r.rc).toBe(0);
    expect(calls.length).toBe(1);
    expect(r.out).toContain('[warn] Nhận xét LLM bị loại: LLM tự viết số');
    expect(r.out).toMatch(
      /\[done\] .*ceo-2026-W41\.md — kỳ 2026-W41, \d+\/\d+ chỉ số có số kỳ này · ĐỎ/,
    );
  });

  it('3 section v8.1: chưa nối → mỗi section 1 dòng "không đọc được"; lỗi riêng từng cái, che PII', async () => {
    const out = mkdtempSync(join(tmp, 'sec-'));
    const f = fakeDb();
    const deps = { connect: async () => ({ db: f.db, release: async () => {} }), wire: () => null };
    let r = await ceo({ ref: '2026-10-05', outDir: out }, deps);
    expect(r.rc).toBe(0);
    let page = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
    for (const h of SECTION_HEADS) {
      expect(page).toContain(`${h}\n\n*(không đọc được: NotImplementedError: chưa nối section`);
    }
    // nối: decisions nhận ngày VN, risk lỗi cấu hình (ValueError), audit lỗi có SĐT → che
    wireSecurity(null); // che PII THẬT (rollout giả giữ nguyên)
    const seen: unknown[] = [];
    setCeoSections({
      decisions: (_db, today) => {
        seen.push(today);
        return ['## Tiến độ & Sổ quyết định', '', '- quá hạn thực hiện: 1'];
      },
      risk: () => {
        throw new RangeError('data/ceo_risk.json hỏng: JSONDecodeError');
      },
      audit: () => {
        throw new Error('liên hệ 0905123456 | `x`');
      },
    });
    r = await ceo({ ref: '2026-10-05', outDir: out }, deps);
    expect(r.rc).toBe(0);
    page = readFileSync(join(out, 'ceo-2026-W41.md'), 'utf8');
    expect(seen).toEqual(['2026-10-12']);
    expect(page).toContain(
      '## Rủi ro pháp lý mở\n\n*(không đọc được: ValueError: data/ceo_risk.json hỏng: JSONDecodeError)*',
    );
    expect(page).toContain('## Audit outside-in (P1)\n\n*(không đọc được: Exception: liên hệ');
    expect(page).not.toContain('0905123456');
    const pos = ['## Thời gian duyệt của TGĐ', ...SECTION_HEADS, '## Nhận xét'].map((h) =>
      page.indexOf(h),
    );
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(page).toContain('137 lead');
  });

  it('job ceo_weekly tồn tại với 2 bước cockpit → ceo_report (đăng ký BullMQ ở bước tích hợp)', () => {
    const jobs = JSON.parse(readFileSync(repoPath('deploy', 'onprem', 'jobs.json'), 'utf8'));
    const j = (jobs.jobs ?? jobs).ceo_weekly;
    expect(j.steps).toEqual([
      ['-m', 'pipelines.cockpit', '--collect', '--period', 'week'],
      ['-m', 'agents.ceo_report', '--period', 'week', '--submit'],
    ]);
    expect(existsSync(FIX)).toBe(true);
  });
});
