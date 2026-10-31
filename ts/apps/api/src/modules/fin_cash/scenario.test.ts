import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PyFloat, parsePyJson } from '@samsam/core/ops/py-json';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath, repoPath } from '@samsam/core/paths';
import { pyDumps, settings } from '@samsam/core/rollout/counters';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CliDeps, type ScenarioOpts, scenarioMain } from './fin-cash.command.js';
import { clone, dumpPy, fixture, type J, unPy } from './fin-cash.testing.js';
import * as sc from './scenario.js';

// Dịch tests/test_scenario.py + test_docx_p2.py (phần scenario). Fixture golden sinh bằng hàm Python
// THẬT (`pipelines/scenario.py`) — script gen_scenario.py ở scratchpad. Giả định/golden là file THẬT
// của repo (như Python test). Số trong giả định là GIẢ ĐỊNH/fixture, không phải số bán thật.

const FIX = fixture('scenario.golden.json');
const RAW = parsePyJson(readFileSync(sc.ASSUMPTIONS_FILE, 'utf8')) as J;
/** Áp thao tác đột biến của fixture lên bản sao RAW (["set", path, v] | ["del", path]). */
function applyOps(doc: J, ops: unknown[][]): J {
  const d = clone(doc);
  for (const [op, path, v] of ops as [string, (string | number)[], unknown][]) {
    let t = d as Record<string | number, unknown>;
    for (const k of path.slice(0, -1)) t = t[k] as Record<string | number, unknown>;
    const last = path[path.length - 1] as string | number;
    if (op === 'set') t[last] = v;
    else if (Array.isArray(t)) t.splice(last as number, 1);
    else delete t[last];
  }
  return d;
}
const GOLDEN = (JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as { skus: J[] })
  .skus;
const SKUS = Object.fromEntries(GOLDEN.map((s) => [s.sku_key as string, s]));
const ALCOHOL = GOLDEN.filter((s) => s.category === 'alcohol');

function res(fn: () => unknown): { ok: unknown } | { err: string } {
  try {
    return { ok: fn() };
  } catch (e) {
    if (e instanceof sc.ScenarioError) return { err: e.message };
    throw e;
  }
}
const normView = (a: sc.Assumptions) => ({
  status: a.status,
  trend: a.trend,
  baseline: a.baseline,
  events: a.events.map(([id, wk, ch]) => [
    id,
    Object.fromEntries([...wk.entries()].sort(([x], [y]) => (x < y ? -1 : 1))),
    ch === null ? null : [...ch].sort(),
  ]),
});

describe('scenario — golden Python', () => {
  it('tet_date / week_start', () => {
    const args: Record<string, unknown> = {
      '2026': 2026,
      '2027': 2027,
      '2028': 2028,
      '2030': 2030,
      true: true,
      '2027.0': new PyFloat(2027),
      '[2027]': [2027],
      "'2027'": '2027',
    };
    for (const [k, want] of Object.entries(FIX.tet as J)) {
      expect(
        res(() => sc.tetDate(args[k])),
        k,
      ).toEqual(want);
    }
    for (const [d, want] of FIX.week_start as [string, string][]) {
      expect(sc.weekStart(d)).toBe(want);
    }
  });

  it('giả định repo validate y hệt Python', () => {
    expect(normView(sc.loadAssumptions())).toEqual(unPy(FIX.repo_validated));
  });

  it('mọi biến thể giả định hỏng: cùng lỗi (fail-closed) — doc thô vào project cũng validate', () => {
    for (const [name, v] of Object.entries(FIX.validate as Record<string, J>)) {
      const doc = applyOps(RAW, v.ops as unknown[][]);
      const got = res(() => normView(sc.validateAssumptions(doc)));
      if ('err' in v) {
        expect(got, name).toEqual({ err: v.err });
        // project() trên doc thô cũng validate — không trả số câm
        expect(
          () => sc.project(SKUS['saphraton-20v'], 'shopee', '2026-10-12', 2, doc),
          name,
        ).toThrow(sc.ScenarioError);
      } else expect(got, name).toEqual({ ok: unPy(v.ok) });
    }
    for (const v of FIX.validate_root as J[]) {
      expect(res(() => normView(sc.validateAssumptions(v.doc)))).toEqual(
        'err' in v ? { err: v.err } : { ok: unPy(v.ok) },
      );
    }
  });

  it('NaN/âm/tràn số trong giả định → ScenarioError', () => {
    const d = clone(RAW);
    (d.trend as J).high = Number.NaN;
    expect(() => sc.validateAssumptions(d)).toThrow('trend.high: phải là số hữu hạn >= 0');
  });

  describe('loadAssumptions — mọi biến thể "không có dữ liệu"', () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'scenario-'));
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    // KHÁC Python có chủ đích: chữ sau "JSON hỏng:" là thông điệp của JSON.parse (JS).
    const JS_MSG = new Set(['{not json', '@nan']);
    it('khớp Python', () => {
      const real = readFileSync(sc.ASSUMPTIONS_FILE, 'utf8');
      for (const c of FIX.load as J[]) {
        const p = join(tmp, 'a.json');
        rmSync(p, { force: true });
        const label = c.content as string | null;
        if (label !== null) {
          const text =
            label === '@nan'
              ? real.replace('"high": 1.15', '"high": NaN')
              : label === '@bom'
                ? `﻿${real}`
                : label;
          writeFileSync(p, Buffer.from(text, 'utf8'));
        }
        const got = res(() => sc.loadAssumptions(p).status);
        if (label !== null && JS_MSG.has(label)) {
          expect('err' in got && got.err.startsWith('a.json JSON hỏng: '), label).toBe(true);
        } else expect(got, String(label)).toEqual('err' in c ? { err: c.err } : { ok: c.ok });
      }
      const bad = join(tmp, 'bad.json');
      writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
      expect(res(() => sc.loadAssumptions(bad).status)).toEqual(FIX.load_bad_utf8);
    });
  });

  it('project: toàn bộ SKU × kênh × 2 mốc khớp sha Python + mẫu tường minh', () => {
    const a = sc.loadAssumptions();
    const matrix: Record<string, unknown> = {};
    for (const [start, weeks] of [
      ['2026-10-12', 26],
      ['2027-01-04', 13],
    ] as const) {
      for (const s of GOLDEN) {
        for (const ch of sc.ALL_CHANNELS) {
          matrix[`${start}|${s.sku_key}|${ch}`] = sc.project(s, ch, start, weeks, a);
        }
      }
    }
    for (const [k, want] of Object.entries(FIX.matrix_sample as J)) {
      expect(matrix[k], k).toEqual(want);
    }
    const sha = createHash('sha256').update(pyDumps(matrix, true), 'utf8').digest('hex');
    expect(sha).toBe(FIX.matrix_sha);
  });

  it('project: ca biên (MAX chồng tuần, làm tròn bất đối xứng, nhiễu float, kênh sự kiện, tràn)', () => {
    for (const c of FIX.project_cases as J[]) {
      const doc = c.doc ?? applyOps(RAW, c.ops as unknown[][]);
      const got = res(() =>
        sc.project(SKUS[c.sku as string], c.channel, c.start, c.weeks as number, doc),
      );
      expect(got, c.name as string).toEqual('err' in c ? { err: c.err } : { ok: c.ok });
    }
  });

  it('project: tham số sai → ScenarioError (không OverflowError/traceback)', () => {
    const a = sc.loadAssumptions();
    for (const b of FIX.project_bad as J[]) {
      expect(
        res(() => sc.project(b.sku, b.channel, b.start, b.weeks, a)),
        b.what as string,
      ).toEqual({ err: b.err });
    }
    expect(sc.project(SKUS['saphraton-20v'], 'shopee', sc.DATE_MAX, sc.MAX_WEEKS, a)).toHaveLength(
      FIX.edge_max as number,
    );
    expect(sc.project(SKUS['saphraton-20v'], 'shopee', sc.DATE_MIN, 1, a)).toEqual(FIX.edge_min);
    // ngày không phải chuỗi YYYY-MM-DD (Python: không phải `date`)
    expect(() => sc.project(SKUS['saphraton-20v'], 'shopee', '12/10/2026', 2, a)).toThrow(
      'start phải là date',
    );
  });
});

describe('scenario — luật (tests/test_scenario.py)', () => {
  const a = sc.loadAssumptions();
  const allowed = (s: J, ch: string) =>
    ch === sc.OFFLINE ||
    (s.category !== 'alcohol' && (s.allowed_channels as string[]).includes(ch));

  it('Tết 2027 / 11.11 / 12.12 rơi đúng tuần; start chuẩn hóa về thứ Hai', () => {
    expect(sc.tetDate(2027)).toBe('2027-02-06');
    expect(sc.weekStart(sc.tetDate(2027))).toBe('2027-02-01');
    const tet = sc.project(SKUS['saphraton-20v'], 'shopee', '2027-01-25', 3, a);
    expect(tet.map((r) => r.week_start)).toEqual(['2027-01-25', '2027-02-01', '2027-02-08']);
    expect(tet[1]?.events).toContain('tet_2027');
    const rows = sc.project(SKUS['saphraton-20v'], 'shopee', '2026-10-12', 13, a);
    const by = Object.fromEntries(rows.map((r) => [r.week_start, r.events]));
    expect(by['2026-11-09']).toContain('11.11');
    expect(by['2026-12-07']).toContain('12.12');
    expect(by['2026-10-12']).toEqual([]);
    expect(
      sc.project(SKUS['saphraton-20v'], 'shopee', '2026-10-15', 2, a).map((r) => r.week_start),
    ).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('luôn là khoảng: 0 ≤ thấp ≤ cơ sở ≤ cao; kênh không được phép = 0 + ghi chú', () => {
    const base = RAW.baseline_units_per_week as Record<string, Record<string, unknown>>;
    for (const s of GOLDEN) {
      for (const ch of sc.ALL_CHANNELS) {
        const rows = sc.project(s, ch, '2026-10-12', 26, a);
        expect(rows).toHaveLength(26);
        for (const r of rows) {
          for (const lv of sc.LEVELS) expect(Number.isInteger(r[lv])).toBe(true);
          expect(0 <= r.low && r.low <= r.base && r.base <= r.high).toBe(true);
          if (!allowed(s, ch)) {
            expect([r.low, r.base, r.high]).toEqual([0, 0, 0]);
            expect(r.note).toBeTruthy();
          } else if (Number(unPy(base[s.sku_key as string]?.[ch])) > 0) {
            expect(r.low).toBeLessThan(r.high);
          }
        }
      }
    }
  });

  it('rượu × kênh online = 0 (kể cả có baseline); offline > 0', () => {
    expect(ALCOHOL).toHaveLength(2);
    for (const s of ALCOHOL) {
      for (const ch of sc.CHANNELS) {
        for (const r of sc.project(s, ch, '2026-10-12', 26, a)) {
          expect([r.low, r.base, r.high]).toEqual([0, 0, 0]);
          expect(r.note).toBe(sc.NOTE_ALCOHOL);
        }
      }
      expect(
        sc.project(s, sc.OFFLINE, '2026-10-12', 26, a).every((r) => r.low > 0 && r.note === null),
      ).toBe(true);
    }
  });

  it('11.11/12.12 không áp kênh offline; Tết áp mọi kênh', () => {
    const s = SKUS['saphraton-40v'];
    const b = Number((unPy((RAW.baseline_units_per_week as J)['saphraton-40v']) as J).offline);
    const plain = sc.project(s, sc.OFFLINE, '2026-10-12', 1, a)[0] as sc.WeekRow;
    for (const wk of ['2026-11-09', '2026-12-07']) {
      const r = sc.project(s, sc.OFFLINE, wk, 1, a)[0] as sc.WeekRow;
      expect(r.events).toEqual([]);
      expect([r.low, r.base, r.high]).toEqual([plain.low, plain.base, plain.high]);
    }
    expect(plain.base).toBe(b);
    const tet = sc.project(s, sc.OFFLINE, '2027-01-18', 1, a)[0] as sc.WeekRow;
    expect(tet.events).toEqual(['tet_2027']);
    expect(tet.base).toBeGreaterThan(b);
  });

  it('dấu "đã validate" giả trong JSON vẫn bị validate lại', () => {
    const doc = clone(RAW);
    doc._validated = true;
    (doc.trend as J).low = 9;
    expect(() => sc.project(SKUS['saphraton-20v'], 'shopee', '2026-10-12', 2, doc)).toThrow(
      sc.ScenarioError,
    );
  });

  it('module thuần: không DB/LLM/mạng, không đọc đồng hồ', () => {
    const src = readFileSync(new URL('./scenario.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from 'pg'|@samsam\/core\/ai|fetch\(|Date\.now|new Date\(\)/);
  });

  it('giả định repo là GIẢ ĐỊNH (không phải số thật)', () => {
    expect(RAW.status).toContain('GIẢ ĐỊNH');
    expect(String(RAW._doc).toLowerCase()).toContain('fixture');
  });
});

describe('scenario CLI', () => {
  const run = async (o: ScenarioOpts, extra: Partial<CliDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const rc = await scenarioMain(o, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      now: () => new Date('2026-10-14T03:00:00Z'),
      ...extra,
    });
    return { rc, out: out.join('\n'), err: err.join('\n') };
  };
  const argv = (a: string[]): ScenarioOpts => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < a.length; i++) {
      const k = (a[i] as string).slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (k === 'json') o.json = true;
      else o[k] = a[++i];
    }
    return o as ScenarioOpts;
  };

  it('stdout/stderr/exit code y hệt Python', async () => {
    for (const c of FIX.cli as J[]) {
      const r = await run(argv(c.argv as string[]));
      expect(r.rc, String(c.argv)).toBe(c.rc);
      expect(r.out ? `${r.out}\n` : '', String(c.argv)).toBe(c.out);
      expect(r.err ? `${r.err}\n` : '', String(c.argv)).toBe(c.err);
    }
  });

  it('tham số sai → exit 2 (kể cả ngày ISO sát biên, kênh lạ, thiếu --sku)', async () => {
    const base = { sku: 'saphraton-20v', channel: 'shopee' };
    expect((await run({ ...base, weeks: 'abc' })).rc).toBe(2);
    expect((await run({ ...base, weeks: '0' })).rc).toBe(2);
    expect((await run({ channel: 'shopee' })).rc).toBe(2);
    expect((await run({ ...base, start: '12/10/2026' })).rc).toBe(2);
    for (const bad of ['9999-12-20', '0001-01-01', '1999-12-31', '2101-01-01']) {
      const r = await run({ ...base, weeks: '13', start: bad });
      expect(r.rc).toBe(2);
      expect(r.err).toContain('2000-01-01..2100-12-31');
    }
    expect((await run({ sku: 'saphraton-20v', channel: 'lazada' })).rc).toBe(2);
    expect((await run({ ...base, json: true, outDir: 'x' })).rc).toBe(2);
    expect((await run({ ...base, weeks: ' 13 ', start: '2026-10-12' })).rc).toBe(0);
  });

  describe('file hỏng → exit 1, không traceback', () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'scenario-cli-'));
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const write = (doc: unknown) => {
      const p = join(tmp, `a-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
      return p;
    };
    it('giả định {} / thiếu baseline / biến thể từng lọt traceback / golden thiếu', async () => {
      const o = { sku: 'saphraton-20v', channel: 'shopee', start: '2026-10-12' };
      let r = await run(o, { assumptionsFile: write('{}') });
      expect(r.rc).toBe(1);
      expect(r.err).toContain('[err]');
      const nob = applyOps(RAW, [['del', ['baseline_units_per_week', 'saphraton-20v', 'offline']]]);
      r = await run({ ...o, channel: 'offline' }, { assumptionsFile: write(dumpPy(nob)) });
      expect(r.rc).toBe(1);
      expect(r.err).toContain('thiếu baseline');
      const muts: unknown[][][] = [
        [['set', ['events', 2, 'lunar_new_year'], [2027]]],
        [['set', ['events', 0, 'window', 0, 'offset'], 10 ** 12]],
      ];
      for (const m of muts) {
        r = await run(o, { assumptionsFile: write(dumpPy(applyOps(RAW, m))) });
        expect(r.rc).toBe(1);
        expect(r.err).toContain('[err]');
      }
      // số nguyên khổng lồ / tích tràn số (chữ JSON như Python ghi)
      const huge = readFileSync(sc.ASSUMPTIONS_FILE, 'utf8').replace(
        '"high": 1.15',
        `"high": 1${'0'.repeat(400)}`,
      );
      r = await run(o, { assumptionsFile: write(huge) });
      expect([r.rc, r.err]).toEqual([1, '[err] trend.high: số quá lớn']);
      const over = readFileSync(sc.ASSUMPTIONS_FILE, 'utf8')
        .replace('"high": 1.15', '"high": 1e300')
        .replace('"saphraton-20v": {"shopee": 12', '"saphraton-20v": {"shopee": 1e300');
      r = await run(o, { assumptionsFile: write(over) });
      expect(r.rc).toBe(1);
      expect(r.err).toContain('tràn số');
      r = await run(o, { goldenFile: join(tmp, 'missing.json') });
      expect(r.rc).toBe(1);
      expect(r.err).toContain('[err] golden: thiếu file');
    });
  });

  describe('--out-dir qua writeReport (docx P2, intel-06)', () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'scenario-rep-'));
      wireCore(null);
    });
    afterEach(() => {
      settings.forceMode = null;
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const o = { sku: 'savina-12v', channel: 'shopee', weeks: '2', start: '2026-11-02' };

    it('chạy thử: ghi kich-ban-<sku>-<kênh>-<ngày>.md mang nhãn CHẠY THỬ', async () => {
      settings.forceMode = 'chay_thu';
      const dir = join(tmp, 'trial');
      const r = await run({ ...o, outDir: dir });
      expect(r.rc).toBe(0);
      const f = join(dir, 'kich-ban-savina-12v-shopee-2026-11-02.md');
      expect(existsSync(f)).toBe(true);
      const body = readFileSync(f, 'utf8');
      expect(body.startsWith('> **CHẠY THỬ — KHÔNG GỬI.** Tính năng intel-06')).toBe(true);
      expect(body).toContain('KHÔNG phải doanh số cam kết');
      expect(r.out).toContain('[done]');
    });

    it('tính năng TẮT → exit 1, không ghi file', async () => {
      settings.forceMode = 'tat';
      const dir = join(tmp, 'off');
      const r = await run({ ...o, outDir: dir });
      expect(r.rc).toBe(1);
      expect(r.err).toContain('[err]');
      expect(r.err).toContain('intel-06');
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    });
  });

  it('dữ liệu golden repo vẫn đọc được (đường dẫn repo)', () => {
    expect(existsSync(repoPath('data/golden_skus.json'))).toBe(true);
  });
});
