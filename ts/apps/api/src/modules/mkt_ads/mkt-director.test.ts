import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@samsam/core/ops/director';
import { PyFloat } from '@samsam/core/ops/py-json';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validate } from '../kd_price/mkt-calendar.js';
import G from './__fixtures__/mkt_director.golden.json' with { type: 'json' };
import { type CmdDeps, DEFAULT_QUOTA, mktDirectorMain } from './mkt-ads.command.js';
import {
  at,
  build,
  CALENDAR_FILE,
  CalendarError,
  type Campaign,
  capFor,
  loadInputs,
  loadQuota,
  nonWorking,
  type Plan,
  toWorkday,
} from './mkt-calendar.js';
import {
  briefText,
  bulletin,
  DB_MISSING,
  enqueueBriefs,
  FOOTER,
  forecastLoad,
  NO_AUTO,
  type QueueItem,
  renderLoad,
} from './mkt-director.js';

// Dịch tests/test_mkt_director.py (phần thuần + CLI không DB) — engine lịch MKT-01 + quota + cân tải +
// bản tin so khớp golden sinh từ hàm Python THẬT (`__fixtures__/mkt_director.golden.json`).

const TMP = mkdtempSync(join(tmpdir(), 'mkt-dir-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let nf = 0;
const tfile = (b: Buffer | string) => {
  const p = join(TMP, `q${nf++}.json`);
  writeFileSync(p, b);
  return p;
};
const VN = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h - 7));
const NOW = VN(2026, 10, 26);

function ser(v: unknown): unknown {
  if (v instanceof Date) return { ms: v.getTime() };
  if (v instanceof Set) return [...v].sort();
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}
/** Ngược `ser`: {ms} → Date. */
function de(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(de);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.ms === 'number') return new Date(o.ms);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, de(x)]));
  }
  return v;
}
const [CAL, GOLDEN, SLA] = loadInputs();
const realPlan = (start = '2026-10-12', weeks = 26) => build(CAL, GOLDEN, start, weeks, SLA);

describe('engine lịch MKT-01 (golden)', () => {
  it('build: mốc LÙI theo SLA giờ VN, né ngày nghỉ, rượu không vào ô online', () => {
    expect(SLA).toBe(G.sla);
    for (const b of G.builds)
      expect(ser(build(CAL, GOLDEN, b.start, b.weeks, b.sla)), `${b.start}+${b.weeks}`).toEqual(
        b.plan,
      );
  });
  it('golden/lịch sửa: 4 ô khi SKU đủ readiness 2 kênh × 2 định dạng', () => {
    const g2 = structuredClone(GOLDEN) as { skus: Record<string, unknown>[] };
    const s = g2.skus.find((x) => x.sku_key === 'saphraton-20v') as Record<string, unknown>;
    Object.assign(s, { xnqc_status: 'approved', allowed_channels: ['shopee', 'tiktok'] });
    const cal2 = JSON.parse(readFileSync(CALENDAR_FILE, 'utf8'));
    cal2.campaigns = [
      {
        id: 'c-fx',
        event: '11.11',
        publish_offset_days: 0,
        channels: ['shopee', 'tiktok'],
        formats: ['listing', 'ads'],
        skus: ['saphraton-20v'],
        pillar: 'fx',
      },
    ];
    const plan = build(validate(cal2), g2, '2026-11-02', 2, 48);
    expect(plan.campaigns[0]?.cells.length).toBe(4);
    expect(ser(plan)).toEqual(G.modplan);
  });
  it('build lỗi → CalendarError (không bao giờ ra lịch rỗng câm)', () => {
    const vals: Record<string, unknown> = { '0': 0, '27': 27, True: true, '2.0': new PyFloat(2) };
    for (const [k, msg] of G.build_errs as [unknown, string | null][]) {
      const key = String(k);
      const run = key.startsWith('sla:')
        ? () => build(CAL, GOLDEN, '2026-10-12', 4, key === 'sla:48' ? '48' : Number(key.slice(4)))
        : () =>
            build(
              CAL,
              GOLDEN,
              '2026-10-12',
              vals[k === true ? 'True' : k === 2 ? '2.0' : key],
              SLA,
            );
      if (msg === null) expect(run).not.toThrow();
      else expect(run, key).toThrow(new CalendarError(msg));
    }
    const cal3 = JSON.parse(readFileSync(CALENDAR_FILE, 'utf8'));
    cal3.campaigns[0].skus = ['khong-co', 'savina-12v', 'zz-x'];
    expect(() => build(validate(cal3), GOLDEN, '2026-10-12', 4, SLA)).toThrow(
      new CalendarError(G.unknown_sku as string),
    );
    expect(() => build(CAL, { skus: [] }, '2026-10-12', 4, SLA)).toThrow(
      new CalendarError(G.no_golden as string),
    );
  });
  it('to_workday: chỉ LÙI về giờ làm việc gần nhất (golden)', () => {
    const nw = nonWorking(CAL);
    for (const [a, b] of G.to_workday as [number, number][]) {
      expect(toWorkday(new Date(a), CAL.lead as never, nw).getTime(), String(a)).toBe(b);
    }
  });
});

describe('quota duyệt (scripts/review_load.py — golden)', () => {
  it('load_quota + cap_for: lỗi bất kỳ → QuotaError', () => {
    for (const c of G.quota as Record<string, unknown>[]) {
      const p = tfile(Buffer.from(c.b64 as string, 'base64'));
      if (c.err !== null) {
        expect(() => loadQuota(p), c.err as string).toThrow(c.err as string);
        continue;
      }
      const q = loadQuota(p);
      expect(ser(q)).toEqual(c.ok);
      for (const [d, cap] of c.caps as [string, number | null][]) expect(capFor(d, q), d).toBe(cap);
    }
  });
});

describe('cân tải W60.5 (golden + test_mkt_director.py)', () => {
  it('forecast_load + render_load (golden): VƯỢT QUOTA, ĐỀ XUẤT dời, không tự dời', () => {
    for (const c of G.forecast as Record<string, unknown>[]) {
      const plan = de(c.plan) as Plan;
      const before = structuredClone(plan);
      const q = loadQuota(tfile(JSON.stringify(c.quota)));
      const fc = forecastLoad(plan, q, c.gd_cap as number, c.start as string, c.days as number);
      expect(plan).toEqual(before); // không tự dời
      expect(ser(fc)).toEqual(c.out);
    }
  });
  it('render_load (golden) + NO_AUTO', () => {
    for (const c of G.forecast as Record<string, unknown>[]) {
      const fc = forecastLoad(
        de(c.plan) as Plan,
        loadQuota(tfile(JSON.stringify(c.quota))),
        c.gd_cap as number,
        c.start as string,
        c.days as number,
      );
      expect(renderLoad(fc)).toBe(c.render);
      expect(renderLoad(fc)).toContain(NO_AUTO);
    }
    const first = (G.forecast as { out: { warnings: string[]; suggestions: string[] } }[])[0];
    expect(first?.out.warnings).toContain('VƯỢT QUOTA phap_che 2026-11-10: 3 mục > trần 2');
    expect(
      first?.out.suggestions.some((s) => s.includes('ĐỀ XUẤT') && s.includes('2026-11-09')),
    ).toBe(true);
  });
  it('forecastLoad thuần (không query/connect)', () => {
    const src = forecastLoad.toString();
    expect(src).not.toMatch(/query|connect/);
  });
});

describe('brief + bản tin (golden + test_mkt_director.py)', () => {
  it('brief_text: qua guardrail, không nêu SKU rượu, tất định, nêu GIẢ ĐỊNH + nguồn', () => {
    const plan = realPlan();
    expect(plan.campaigns.length).toBeGreaterThan(0);
    const gold = new Map(
      (G.briefs as [string, string, string][]).map(([id, a, b]) => [id, [a, b]]),
    );
    for (const c of plan.campaigns) {
      const text = briefText(c, plan.status);
      expect([text, briefText(c)]).toEqual(gold.get(c.id));
      const g = check(text);
      expect(g.ok, c.id).toBe(true);
      expect(text).not.toContain('ruou-sam-');
      expect(text).toContain('GIẢ ĐỊNH');
      expect(text).toContain('marketing_calendar.json');
      expect(briefText(c, plan.status)).toBe(text);
    }
    const qb = plan.campaigns.find((c) => c.id === 'c-tet-2027-qua-bieu') as Campaign;
    expect(briefText(qb)).toContain('1 SKU chỉ bán offline');
  });
  it('cấu hình brief không rủi ro thấp, chưa có người duyệt thật', () => {
    const cfg = loadConfig('marketing');
    expect(cfg.object_types.campaign_brief?.risk).not.toBe('low');
    expect(cfg.object_types.campaign_brief?.sla_hours).toBe(48);
    expect(cfg.approvers).toEqual([]);
    expect(cfg.digest_recipients).toEqual([]);
  });
  it('module không bao giờ quyết định/đăng/hẹn lịch', () => {
    const src = readFileSync(
      repoPath('ts', 'apps', 'api', 'src', 'modules', 'mkt_ads', 'mkt-director.ts'),
      'utf8',
    );
    expect(src).not.toMatch(
      /decide\(|autoApprove|override\(|approve_draft|setStatus|schedule\(|saveDraft|record_publish/,
    );
  });
  it('bulletin (golden): DB thiếu vẫn đủ 4 mục, trễ hạn che PII, brief đã qua mốc', () => {
    const q = loadQuota(DEFAULT_QUOTA);
    for (const c of G.bulletin as Record<string, unknown>[]) {
      const plan = build(CAL, GOLDEN, c.plan_start as string, 6, SLA);
      const now = new Date(c.now as number);
      const today = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
      const fc = forecastLoad(plan, q, 3, today, 14);
      expect(bulletin(plan, fc, de(c.items) as QueueItem[] | null, now)).toBe(c.text);
    }
    const t0 = (G.bulletin as { text: string }[])[0]?.text as string;
    expect(t0).toContain(DB_MISSING);
    for (const h of [
      '## 1. Chiến dịch 28 ngày tới',
      '## 2. Việc trễ hạn',
      '## 3. Tải duyệt dự báo',
      '## 4. SKU bị chặn kênh',
    ]) {
      expect(t0).toContain(h);
    }
    expect(t0.trim().split('\n').at(-1)).toContain('không chi tiền');
    const [head, sec4] = t0.split('## 4. SKU bị chặn kênh') as [string, string];
    expect(head).not.toContain('ruou-sam-');
    expect(sec4).toContain('ruou-sam-');
    const sec2of = (i: number) =>
      (((G.bulletin as { text: string }[])[i]?.text ?? '').split('## 2.')[1] ?? '').split(
        '## 3.',
      )[0] ?? '';
    const sec2 = sec2of(1);
    expect(sec2).toContain('#7');
    expect(sec2).not.toContain('#8');
    expect(sec2).not.toContain('0912345678');
    expect(sec2).not.toContain(DB_MISSING);
    expect(sec2).not.toContain('đã qua mốc brief'); // tại 26/10 chưa chiến dịch nào qua mốc brief
    expect(sec2of(2)).toContain('c-1111-2026: đã qua mốc brief');
    const has = sec2of(3);
    expect(has).not.toContain('c-1111-2026');
  });
});

describe('enqueueBriefs với db giả (test_brief_horizon_filter_fake_conn)', () => {
  const fakeDb = (existing: Set<string> = new Set()) => ({
    query: async (_sql: string, p: unknown[]) => ({
      rows: existing.has(p[1] as string) ? [{ '?column?': 1 }] : [],
    }),
  });
  it('chỉ chiến dịch trong horizon, đã có → bỏ qua, mốc đăng đã qua → không đẩy', async () => {
    const calls: unknown[][] = [];
    const submit = async (
      _db: unknown,
      a: { block: string; objectType: string; objectId: unknown; createdBy: string },
    ) => {
      calls.push([a.block, a.objectType, a.objectId, a.createdBy]);
      return BigInt(100 + calls.length);
    };
    const plan = realPlan();
    let res = await enqueueBriefs(fakeDb() as never, plan, NOW, 14, undefined, {
      submit: submit as never,
    });
    // 26/10 + 14 ngày = 09/11: c-1111 brief 04/11 → có; c-2011 brief 11/11 ngoài horizon; c-2010 đã đăng.
    expect(res.enqueued.map((x) => x.id)).toEqual(['c-1111-2026']);
    expect(calls).toEqual([['marketing', 'campaign_brief', 'c-1111-2026', 'agent:MKT-00']]);
    calls.length = 0;
    res = await enqueueBriefs(fakeDb(new Set(['c-1111-2026'])) as never, plan, NOW, 14, undefined, {
      submit: submit as never,
    });
    expect(res.enqueued).toEqual([]);
    expect(calls).toEqual([]);
    expect(res.skipped[0]?.id).toBe('c-1111-2026');
    res = await enqueueBriefs(fakeDb() as never, plan, VN(2026, 11, 11, 9), 14, undefined, {
      submit: submit as never,
    });
    expect(res.enqueued.map((x) => x.id)).not.toContain('c-1111-2026');
  });
});

describe('CLI mkt-director không DB', () => {
  let st: ReturnType<typeof installFakeDeps>;
  beforeEach(() => {
    settings.forceMode = 'van_hanh';
    st = installFakeDeps();
  });
  afterEach(() => {
    settings.forceMode = null;
  });
  const run = async (o: Record<string, unknown>, extra: CmdDeps = {}) => {
    const out: string[] = [];
    const errs: string[] = [];
    let calls = 0;
    const code = await mktDirectorMain(o as never, {
      log: (s) => out.push(s),
      err: (s) => errs.push(s),
      connect: async () => {
        calls++;
        return null;
      },
      wire: null,
      ...extra,
    });
    return { code, out: out.join('\n'), err: errs.join('\n'), calls };
  };
  it('--briefs --dry-run: in brief, không connect DB', async () => {
    const r = await run({ briefs: true, today: '2026-10-26', dryRun: true });
    expect([r.code, r.calls]).toEqual([0, 0]);
    expect(r.out).toContain('c-1111-2026');
    expect(r.out).toContain('không connect DB');
  });
  it('--briefs DB down → exit 2, stderr [err]', async () => {
    const r = await run({ briefs: true, today: '2026-10-26' });
    expect(r.code).toBe(2);
    expect(r.err.startsWith('[err]')).toBe(true);
  });
  it('--briefs tính năng TẮT → [rollout] exit 2 trước khi in/đẩy', async () => {
    settings.forceMode = 'tat';
    const r = await run({ briefs: true, today: '2026-10-26', dryRun: true });
    expect([r.code, r.calls]).toEqual([2, 0]);
    expect(r.out).toContain('[rollout]');
    expect(r.out).toContain('marketing-01.2');
    expect(r.out).not.toContain('c-1111-2026');
  });
  it('lịch hỏng → exit 1, không connect', async () => {
    const r = await run({ briefs: true, dryRun: true }, { paths: { calendar: tfile('{}') } });
    expect([r.code, r.calls]).toEqual([1, 0]);
  });
  it('quota hỏng → exit 2 TRƯỚC khi đọc lịch (lịch hỏng vẫn ra 2)', async () => {
    const bad = tfile('{}');
    const cal = tfile('{}');
    for (const m of ['load', 'bulletin']) {
      const r = await run({ [m]: true, quota: bad }, { paths: { calendar: cal } });
      expect([r.code, r.calls], m).toEqual([2, 0]);
      expect(r.err).toContain('[err] quota:');
    }
  });
  it('usage: thiếu/thừa chế độ, ngày/số sai → exit 2', async () => {
    for (const o of [
      {},
      { load: true, briefs: true },
      { load: true, today: '2026-13-01' },
      { load: true, days: '91' },
      { briefs: true, horizonDays: 'x' },
    ]) {
      const r = await run(o);
      expect(r.code, JSON.stringify(o)).toBe(2);
    }
  });
  it('--load thật: in bảng tải + NO_AUTO', async () => {
    const r = await run({ load: true, today: '2026-11-02', days: '14' });
    expect([r.code, r.calls]).toEqual([0, 0]);
    expect(r.out).toContain(NO_AUTO);
    expect(r.out).toContain('| T3 10/11 |');
  });
  it('--bulletin DB down → vẫn ghi file (DB_MISSING), cùng tuần ghi đè', async () => {
    const dir = mkdtempSync(join(TMP, 'b-'));
    let r = await run({ bulletin: true, today: '2026-10-14', outDir: dir });
    expect(r.code).toBe(0);
    const p = join(dir, 'mkt-week-2026-10-12.md');
    const text = readFileSync(p, 'utf8');
    expect(text).toContain(DB_MISSING);
    expect(text).toContain(FOOTER);
    expect(readdirSync(dir)).toEqual(['mkt-week-2026-10-12.md']);
    r = await run({ bulletin: true, today: '2026-10-16', outDir: dir });
    expect(r.code).toBe(0);
    expect(readdirSync(dir)).toEqual(['mkt-week-2026-10-12.md']);
    expect(st.recorded.at(-1)?.sample).toBe(false);
  });
  it('--bulletin DB lỗi khi đọc → giảm cấp DB_MISSING, vẫn ghi file', async () => {
    const dir = mkdtempSync(join(TMP, 'b-'));
    const broken = {
      query: async () => {
        throw Object.assign(new Error('Connection terminated unexpectedly'), {});
      },
    };
    const r = await run(
      { bulletin: true, today: '2026-10-14', outDir: dir },
      { connect: async () => ({ db: broken as never, release: async () => {} }) },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain(DB_MISSING);
    expect(existsSync(join(dir, 'mkt-week-2026-10-12.md'))).toBe(true);
    expect(readFileSync(join(dir, 'mkt-week-2026-10-12.md'), 'utf8')).toContain(DB_MISSING);
  });
  it('at(): mốc giờ VN', () => {
    expect(at('2026-10-26', 0).getTime()).toBe(NOW.getTime());
  });
});
