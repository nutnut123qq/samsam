import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/rollout';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import K from './__fixtures__/kd_forecast.golden.json' with { type: 'json' };
import {
  ALL_CHANNELS,
  ASSUMPTIONS_FILE,
  GOLDEN_FILE,
  LEVELS,
  loadAssumptions,
  NOTE_ALCOHOL,
  project,
  readGolden,
  ScenarioError,
  type Sku,
  STALE_NOTE,
  type StockEntry,
  shortage,
  validateAssumptions,
  validateGolden,
  weekStart,
} from './kd-forecast.deps.js';
import { forecast, kdForecastMain, render } from './kd-forecast.js';

// Dịch tests/test_kd_forecast.py (+ test_r12_dot2 kd_forecast tắt): đi qua engine kịch bản chung,
// luôn khoảng thấp–cơ sở–cao, đối chiếu tồn THIẾU/RỦI RO/THỪA, chưa có số tồn ≠ 0. Golden từ hàm
// Python thật (scenario.project, kd_forecast.forecast/render, production.shortage, validate).

const START = '2026-10-12';
const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
const SAPH = 'saphraton-20v';
const CELL = /^(\d+)–(\d+)–(\d+)$/;
const [gdoc] = readGolden(GOLDEN_FILE);
const SKUS = ((gdoc as Record<string, unknown>).skus as unknown[]).filter(
  (s): s is Sku => typeof s === 'object' && s !== null,
);
const A = loadAssumptions();
const st = (qty: number, stale: string[] = [], sample = false): StockEntry => ({
  qty,
  kho: {},
  stale,
  sample,
});
const one = SKUS.filter((s) => s.sku_key === SAPH);

describe('engine kịch bản + dự báo = Python', () => {
  it('nguồn kd-forecast.ts chỉ gọi engine chung (không công thức riêng, không mạng/LLM)', () => {
    const src = readFileSync(join(import.meta.dirname, 'kd-forecast.ts'), 'utf8');
    expect(src).toContain('project(');
    expect(src).not.toMatch(/baseline|trend|coef|\* *1\.[0-9]/);
    expect(src).not.toMatch(/nodemailer|fetch\(|node:http|https|gateway|ai\.chat|openai/);
  });

  it('forecast + render từng chữ (11 bộ tồn/kỳ)', () => {
    for (const c of K.forecasts) {
      const skus = SKUS.filter((s) => c.only === null || (c.only as string[]).includes(s.sku_key));
      const rows = forecast(
        skus,
        c.stock as Record<string, StockEntry> | null,
        c.start,
        c.weeks,
        A,
      );
      expect(rows, c.label).toEqual(c.rows);
      expect(render(rows, c.start, c.weeks, A.status), c.label).toBe(c.text);
      expect(render(rows, c.start, c.weeks), c.label).toBe(c.text_nostatus);
    }
  });

  it('project từng tuần (sự kiện, rượu, allowed_channels)', () => {
    for (const p of K.project) {
      const sku = SKUS.find((s) => s.sku_key === p.sku) as Sku;
      expect(project(sku, p.channel, p.start, p.weeks, A), p.sku + p.channel).toEqual(p.rows);
    }
    expect(Object.entries(K.week_start).map(([d]) => weekStart(d))).toEqual(
      Object.values(K.week_start),
    );
  });

  it('shortage', () => {
    for (const [s, sums, want] of K.shortage as [number | null, never, unknown][]) {
      expect(shortage(s, sums)).toEqual(want);
    }
  });

  it('khoảng đơn điệu + tổng = cộng kênh; mỗi ô là khoảng', () => {
    const rows = forecast(SKUS, {}, START, 13, A);
    for (const r of rows) {
      for (const d of [...Object.values(r.channels), r.sums]) {
        expect(d.low <= d.base && d.base <= d.high).toBe(true);
      }
      for (const lv of LEVELS) {
        expect(r.sums[lv]).toBe(Object.values(r.channels).reduce((a, c) => a + c[lv], 0));
      }
      expect(Object.keys(r.channels)).toEqual(ALL_CHANNELS);
    }
    const text = render(rows, START, 13);
    const table = text.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| SKU'));
    expect(table).toHaveLength(SKUS.length);
    for (const ln of table) {
      const cells = ln
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
        .slice(1);
      expect(cells).toHaveLength(ALL_CHANNELS.length + 1);
      for (const c of cells) {
        const m = CELL.exec(c);
        expect(m, c).not.toBeNull();
        const [lo, ba, hi] = (m as RegExpExecArray).slice(1).map(Number) as [
          number,
          number,
          number,
        ];
        expect(lo <= ba && ba <= hi).toBe(true);
      }
    }
    expect(text).toContain('KHÔNG phải doanh số cam kết');
  });

  it('rượu online = 0 kèm ghi chú engine', () => {
    const [r] = forecast(
      SKUS.filter((s) => s.sku_key === RUOU),
      {},
      START,
      13,
      A,
    );
    expect(r?.channels.shopee).toEqual({ low: 0, base: 0, high: 0 });
    expect(r?.notes.shopee).toBe(NOTE_ALCOHOL);
    expect(r?.channels.offline?.high).toBeGreaterThan(0);
    const text = render([r as never], START, 13);
    expect(text).toContain(`| ${RUOU} | 0–0–0 |`);
    expect(text).toContain(`${RUOU} × shopee: ${NOTE_ALCOHOL}`);
  });

  it('cảnh báo tồn: THIẾU / THỪA / RỦI RO / đủ; chưa có số tồn ≠ 0; kho cũ + MẪU', () => {
    const [base] = forecast(one, {}, START, 13, A);
    const high = (base as { sums: { high: number } }).sums.high;
    const [low] = forecast(one, { [SAPH]: st(5) }, START, 13, A);
    expect(low?.level).toBe('low');
    expect(render([low as never], START, 13)).toContain('THIẾU CẢ KỊCH BẢN THẤP');
    const [ex] = forecast(one, { [SAPH]: st(high + 7) }, START, 13, A);
    const tx = render([ex as never], START, 13);
    expect(ex?.excess).toBe(7);
    expect(tx).toContain('THỪA: dư 7 so với kịch bản cao');
    expect(tx).not.toContain('THIẾU');
    const [risk] = forecast(one, { [SAPH]: st(high - 1) }, START, 13, A);
    expect(render([risk as never], START, 13)).toContain('RỦI RO');
    const [ok] = forecast(one, { [SAPH]: st(high) }, START, 13, A);
    expect(render([ok as never], START, 13)).not.toMatch(/THỪA|THIẾU|RỦI RO/);
    const [no] = forecast(one, { khac: st(1) }, START, 13, A);
    expect(no?.stock).toBeNull();
    expect(render([no as never], START, 13)).toContain('chưa có số tồn');
    const [n] = forecast(one, null, START, 13, A);
    expect(render([n as never], START, 13)).toContain('không đối chiếu được tồn');
    const [s] = forecast(one, { [SAPH]: st(10_000, ['KHO-A'], true) }, START, 13, A);
    const ts = render([s as never], START, 13);
    expect(ts).toContain(STALE_NOTE);
    expect(ts).toContain('KHO-A');
    expect(ts).toContain('(MẪU)');
  });

  it('giả định thiếu baseline → ScenarioError', () => {
    const bad = validateAssumptions({
      _doc: 'x',
      status: 'GIẢ ĐỊNH',
      trend: { low: 1, base: 1, high: 1 },
      baseline_units_per_week: { khac: { shopee: 1 } },
      events: [],
    });
    expect(() => forecast(one, {}, START, 4, bad)).toThrow(ScenarioError);
  });

  it('validate giả định: mọi biến thể hỏng → thông điệp = Python (2027.0 ≠ 2027)', () => {
    const raw = JSON.parse(readFileSync(ASSUMPTIONS_FILE, 'utf8'));
    for (const c of K.assumption_errors) {
      let text: string;
      if (c.value_json === '"__ROOT_LIST__"') text = '[]';
      else {
        const doc = structuredClone(raw);
        let node = doc;
        for (const k of c.path.slice(0, -1)) node = node[k];
        const last = c.path[c.path.length - 1] as string;
        if (c.value_json === '"__DEL__"') delete node[last];
        else node[last] = '\u0000V\u0000';
        text = JSON.stringify(doc).replace('"\\u0000V\\u0000"', c.value_json);
      }
      let msg: string | null = null;
      try {
        validateAssumptions(parsePyJson(text));
      } catch (e) {
        expect(e).toBeInstanceOf(ScenarioError);
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(c.path)).toBe(c.error);
    }
    const misc = [{}, { _doc: 'x' }].map((d) => {
      try {
        validateAssumptions(d);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(misc).toEqual(K.assumption_misc);
  });

  it('validate golden: schema + R1/R2/R3 = Python', () => {
    const raw = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'));
    expect(validateGolden(raw)).toEqual([]);
    for (const c of K.golden_errors) {
      let doc: unknown;
      if (c.value === '__ROOT_LIST__') doc = [];
      else {
        const d = structuredClone(raw);
        if (c.value === '__COPY0__') {
          d.skus[1].product_ids = [...(d.skus[0].product_ids ?? ['p0'])];
          d.skus[0].product_ids = [...d.skus[1].product_ids];
        } else {
          let node = d;
          for (const k of c.path.slice(0, -1)) node = node[k];
          node[c.path[c.path.length - 1] as string] = c.value;
        }
        doc = d;
      }
      expect(validateGolden(doc), JSON.stringify(c.path)).toEqual(c.errors);
    }
  });
});

describe('CLI kd-forecast', () => {
  const env = {}; // không DATABASE_URL: job_runs chỉ cảnh báo, không ghi
  beforeAll(() => installFakeDeps()); // writeReport: cổng rollout giả (báo cáo ngoài danh mục)
  afterAll(() => resetOpsDeps());
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: (s: string) => out.push(s), err_: (s: string) => err.push(s) };
  };

  it('--weeks ngoài 1..104 / không phải số → exit 2, không connect', async () => {
    for (const w of ['0', '105', 'x']) {
      let opened = 0;
      const o = io();
      const rc = await kdForecastMain(
        { weeks: w },
        {
          env,
          log: o.log,
          err: o.err_,
          open: async () => {
            opened++;
            throw new Error('x');
          },
        },
      );
      expect([rc, opened], w).toEqual([2, 0]);
    }
  });

  it('SKU lạ → exit 1', async () => {
    const o = io();
    expect(
      await kdForecastMain(
        { sku: 'khong-co' },
        {
          env,
          log: o.log,
          err: o.err_,
          open: async () => {
            throw new Error('x');
          },
        },
      ),
    ).toBe(1);
    expect(o.err[0]).toBe("[err] SKU 'khong-co' không có trong golden");
  });

  it('DB không tới được → vẫn in + ghi dự báo, exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-'));
    const o = io();
    const rc = await kdForecastMain(
      { start: '2026-10-14', weeks: '4', sku: SAPH, write: true },
      {
        env: { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' },
        log: o.log,
        err: o.err_,
        reportsDir: dir,
      },
    );
    expect(rc).toBe(1);
    expect(o.err.join('\n')).toContain('[warn] không đối chiếu được tồn');
    const out = o.out.join('\n');
    expect(out).toContain(`| ${SAPH} |`);
    expect(out).toContain('2026-10-12');
    expect(readdirSync(dir)).toEqual(['kd-forecast-2026-10-12.md']);
    expect(readFileSync(join(dir, 'kd-forecast-2026-10-12.md'), 'utf8')).toContain(
      'không đối chiếu được tồn',
    );
  });

  it('có tồn → THIẾU, exit 0', async () => {
    const o = io();
    const fakePool = { query: async () => ({ rows: [] }), end: async () => {} } as never;
    const rc = await kdForecastMain(
      { weeks: '4', sku: SAPH },
      {
        env,
        log: o.log,
        err: o.err_,
        open: async () => fakePool,
        stock: async () => ({ [SAPH]: st(3) }),
      },
    );
    expect(rc).toBe(0);
    expect(o.out.join('\n')).toContain('THIẾU CẢ KỊCH BẢN THẤP');
  });

  it('tính năng sales-07.3 TẮT → chỉ 1 dòng [rollout], exit 2, không đọc golden/DB', async () => {
    settings.forceMode = 'tat';
    onTestFinished(() => {
      settings.forceMode = null;
    });
    const o = io();
    let opened = 0;
    const rc = await kdForecastMain(
      { write: true },
      {
        env,
        log: o.log,
        err: o.err_,
        goldenFile: join(tmpdir(), 'khong-co-golden.json'),
        open: async () => {
          opened++;
          throw new Error('x');
        },
      },
    );
    expect(rc).toBe(2);
    expect(o.out).toHaveLength(1);
    expect(o.out[0]).toMatch(/^\[rollout\] .*sales-07\.3/);
    expect([opened, o.err]).toEqual([0, []]);
  });
});
