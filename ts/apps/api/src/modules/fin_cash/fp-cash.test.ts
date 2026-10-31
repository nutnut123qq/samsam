import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FPA_CONFIG_FILE } from '../fin_ar_pnl/fin-common.js';
import { buildExtra, setFinSources } from '../fin_ar_pnl/fin-director.js';
import { decStr, fmtFixed } from './decimal.js';
import { type CliDeps, type FpCashOpts, fpCashMain } from './fin-cash.command.js';
import { FinCashModule } from './fin-cash.module.js';
import { dumpPy, fixture, type J } from './fin-cash.testing.js';
import * as fc from './fp-cash.js';
import * as sc from './scenario.js';

// Dịch tests/test_fp_cash.py + test_r12_dot2.py (FP-Cash TẮT) + test_docx_p2.py (dong-tien-). Fixture
// golden sinh bằng hàm Python THẬT (`agents/fp_cash.py`, gen_fin.py ở scratchpad). Giả định/cấu hình
// trong test là FIXTURE (không phải số thật). Phần DB (tỷ lệ thực nhận đo từ settlement) ở
// fin-cash.db.test.ts.

const FIX = fixture('fp_cash.golden.json');
const RAW_FPA = parsePyJson(readFileSync(FPA_CONFIG_FILE, 'utf8')) as J;
const START = '2026-10-12';
const LV = sc.LEVELS;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fp-cash-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  settings.forceMode = null;
});

let seq = 0;
function writeCfg(doc: unknown): string {
  const p = join(tmp, `fpa-${++seq}.json`);
  writeFileSync(p, typeof doc === 'string' ? doc : dumpPy(doc));
  return p;
}
/** Bản cấu hình: mục cash = fixture (không chi, không số dư) + `over`. */
function cfgOf(over: J = {}): fc.CashCfg {
  const cash = {
    ...(RAW_FPA.cash as J),
    fixed_outflows: [],
    one_off: [],
    min_balance_vnd: 0,
    opening_balance_vnd: null,
    ...over,
  };
  const [cfg, why] = fc.loadCfg(writeCfg({ ...RAW_FPA, cash }));
  expect(why).toBeNull();
  return cfg as fc.CashCfg;
}
const cfgView = (c: fc.CashCfg | null) =>
  c === null
    ? null
    : {
        ...c,
        net_ratio_default: Object.fromEntries(
          Object.entries(c.net_ratio_default).map(([k, v]) => [k, decStr(v)]),
        ),
        offline_price_ratio: decStr(c.offline_price_ratio),
      };
const aOf = (base: unknown, events: unknown[] = []) =>
  sc.validateAssumptions({
    status: 'GIẢ ĐỊNH TEST',
    trend: { low: 0.8, base: 1.0, high: 1.2 },
    baseline_units_per_week: base,
    events,
  });
const SKUS: Record<string, sc.Sku> = {
  'a-sku': { sku_key: 'a-sku', category: 'tpbvsk', allowed_channels: ['shopee'] },
  'b-sku': { sku_key: 'b-sku', category: 'food', allowed_channels: ['shopee'] },
  'ruou-x': { sku_key: 'ruou-x', category: 'alcohol', allowed_channels: ['shopee'] },
  'no-price': { sku_key: 'no-price', category: 'food', allowed_channels: ['shopee'] },
};
const PRICES: [string, string, number][] = [
  ['a-sku', 'shopee', 100_000],
  ['a-sku', 'offline', 70_000],
  ['b-sku', 'shopee', 50_000],
  ['ruou-x', 'shopee', 500_000],
  ['ruou-x', 'offline', 350_000],
];
const BASE = {
  'a-sku': { shopee: 10, offline: 5 },
  'b-sku': { shopee: 4 },
  'ruou-x': { shopee: 3, offline: 2 },
  'no-price': { shopee: 1 },
  'ngoai-golden': { offline: 2 },
};
const priceMap = (ps: [string, string, number][]) =>
  new Map(ps.map(([k, ch, v]) => [fc.pk(k, ch), v]));
const measuredOf = (m: J): fc.Measured =>
  Object.fromEntries(
    Object.entries(m).map(([k, v]) => {
      const [p, o, n] = v as number[];
      return [k, [BigInt(p as number), BigInt(o as number), n as number]];
    }),
  );
const runFc = (cfg: fc.CashCfg, base: unknown = BASE, opening: number | null = null) =>
  fc.forecast(SKUS, aOf(base), priceMap(PRICES), fc.netRatios({}, cfg), cfg, START, opening);

describe('fp_cash — golden Python', () => {
  it('load_cfg: cấu hình repo + mọi biến thể hỏng (fail-closed, đúng thông điệp)', () => {
    expect(cfgView(fc.loadCfg()[0])).toEqual(FIX.cfg_repo);
    for (const v of FIX.cfg_variants as J[]) {
      let p: string;
      if ('over' in v) {
        p = writeCfg({ ...RAW_FPA, cash: { ...(RAW_FPA.cash as J), ...(v.over as J) } });
      } else {
        p = join(tmp, `raw-${v.name}.json`);
        if (v.raw !== null) writeFileSync(p, v.raw as string);
      }
      const [cfg, why] = fc.loadCfg(p);
      expect(why, v.name as string).toBe(v.why);
      expect(cfgView(cfg), v.name as string).toEqual(v.cfg);
    }
  });

  it('net_ratios: đo (28 chữ số Decimal) / mặc định + "chưa xác minh"; Σ đơn 0 / ngoài 0..1 bỏ', () => {
    const cfg = cfgOf();
    for (const c of FIX.net_ratios as J[]) {
      const nr = fc.netRatios(measuredOf(c.measured as J), cfg);
      const view = Object.fromEntries(
        Object.entries(nr).map(([k, v]) => [
          k,
          { ratio: decStr(v.ratio), fmt: fmtFixed(v.ratio, 4), note: v.note },
        ]),
      );
      expect(view).toEqual(c.out);
    }
  });

  it('forecast: dòng tiền/ghi chú/bảng y hệt Python (lag, một lần, số dư âm, tỷ lệ đo, lỗi)', () => {
    for (const c of FIX.forecast as J[]) {
      const [cfg, why] = fc.loadCfg(writeCfg({ ...RAW_FPA, cash: c.cash }));
      expect(why, c.name as string).toBeNull();
      const a = aOf(c.base, c.events as unknown[]);
      let got: J;
      try {
        const r = fc.forecast(
          SKUS,
          a,
          priceMap(c.prices as [string, string, number][]),
          fc.netRatios(measuredOf(c.measured as J), cfg as fc.CashCfg),
          cfg as fc.CashCfg,
          c.start as string,
          c.opening as number | null,
        );
        got = { json: fc.toJson(r), render: fc.render(r) };
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        const t = e instanceof sc.ScenarioError ? 'ScenarioError' : 'ValueError';
        got = { err: `${t}: ${e.message}` };
      }
      const want = 'err' in c ? { err: c.err } : { json: c.json, render: c.render };
      expect(got, c.name as string).toEqual(want);
    }
  });

  it('unit_prices: giá list golden; offline = list shopee × tỷ lệ (ROUND_HALF_UP); ghi đè cấu hình', () => {
    const golden = (JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as { skus: J[] })
      .skus;
    const flat = (m: fc.Prices) =>
      [...m.entries()].map(([k, v]) => [...k.split('\u0000'), v] as unknown[]);
    expect(
      flat(fc.unitPrices(golden, cfgOf({ unit_price_vnd: { 'savina-12v': { offline: 99_000 } } }))),
    ).toEqual(FIX.unit_prices);
    expect(
      flat(fc.unitPrices(golden, cfgOf({ offline_price_ratio: parsePyJson('0.33') }))),
    ).toEqual(FIX.unit_prices_033);
    const pr = fc.unitPrices(golden, cfgOf());
    expect(pr.get(fc.pk('saphraton-40v', 'offline'))).toBeUndefined(); // không có list
  });

  it('run(): cấu hình + giả định + golden THẬT của repo (DB down / có tỷ lệ đo)', () => {
    const inp = fc.loadInputs();
    let r = fc.run({}, START, null, inp);
    expect({ json: fc.toJson(r), render: fc.render(r) }).toEqual(FIX.run_repo);
    r = fc.run({ shopee: [8_500_000n, 10_000_000n, 12] }, '2026-12-01', 50_000_000, inp);
    expect({ json: fc.toJson(r), render: fc.render(r) }).toEqual(FIX.run_repo_measured);
  });
});

describe('fp_cash — luật (tests/test_fp_cash.py)', () => {
  it('không có engine bán hàng thứ 2 / không mạng / không AI', () => {
    const src = readFileSync(new URL('./fp-cash.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/scenario\.project/);
    expect(src).not.toMatch(/trend|Math\.floor|Math\.ceil|events/);
    expect(src).not.toMatch(/fetch\(|node:http|@samsam\/core\/ai|smtp/);
  });

  it('13 tuần luôn là khoảng; chi cố định theo every_weeks/first_week', () => {
    const cfg = cfgOf({
      fixed_outflows: [{ name: 'luong', amount_vnd: 3_000_000, every_weeks: 4, first_week: 1 }],
    });
    const out = runFc(cfg);
    expect(out.weeks).toHaveLength(13);
    expect(out.start).toBe(START);
    out.weeks.forEach((w, i) => {
      for (const k of ['in', 'close'] as const) {
        expect(w[k].low <= w[k].base && w[k].base <= w[k].high).toBe(true);
      }
      expect(w.out).toBe([1, 5, 9].includes(i) ? 3_000_000 : 0);
    });
    expect(out.weeks[0]?.in.low).toBeLessThan(out.weeks[0]?.in.high as number);
  });

  it('engine gọi đúng 1 lần mỗi cặp có giá; thiếu giá / thiếu SKU golden liệt kê, không coi = 0', () => {
    const calls: [string, string][] = [];
    const spy: typeof sc.project = (s, ch, st, w, a) => {
      calls.push([(s as sc.Sku).sku_key as string, ch as string]);
      return sc.project(s, ch, st, w, a);
    };
    const cfg = cfgOf();
    const out = fc.forecast(
      SKUS,
      aOf(BASE),
      priceMap(PRICES),
      fc.netRatios({}, cfg),
      cfg,
      START,
      null,
      spy,
    );
    expect(calls.sort()).toEqual([
      ['a-sku', 'offline'],
      ['a-sku', 'shopee'],
      ['b-sku', 'shopee'],
      ['ruou-x', 'offline'],
      ['ruou-x', 'shopee'],
    ]);
    expect(out.pairs).toBe(5);
    expect(out.thieu_gia).toEqual([['no-price', 'shopee']]);
    expect(out.thieu_sku).toEqual([['ngoai-golden', 'offline']]);
    expect(fc.render(out)).toContain('Thiếu giá — loại khỏi dự báo: `no-price` × shopee');
  });

  it('độ trễ tiền về: engine được gọi với start − lag tuần', () => {
    const cfg = cfgOf({ payout_lag_weeks: { shopee: 2, offline: 0, tiktok: 2 } });
    const lagWk = '2026-09-28';
    const a = aOf({ 'b-sku': { shopee: 4 } }, [
      { id: 'sale-test', date: lagWk, window: [{ offset: 0, low: 3, base: 3, high: 3 }] },
    ]);
    const starts: unknown[] = [];
    const spy: typeof sc.project = (s, ch, st, w, aa) => {
      starts.push(st);
      return sc.project(s, ch, st, w, aa);
    };
    const out = fc.forecast(
      SKUS,
      a,
      priceMap(PRICES),
      fc.netRatios({}, cfg),
      cfg,
      START,
      null,
      spy,
    );
    expect(starts).toEqual([lagWk]);
    const shifted = sc.project(SKUS['b-sku'], 'shopee', lagWk, 13, a);
    expect(shifted[0]?.events).toEqual(['sale-test']);
    for (const lv of LV) {
      expect(out.weeks[0]?.in[lv]).toBeGreaterThan(out.weeks[2]?.in[lv] as number);
    }
  });

  it('rượu × kênh online = 0 do engine', () => {
    const out = runFc(cfgOf(), { 'ruou-x': { shopee: 3 } });
    expect(out.pairs).toBe(1);
    expect(out.weeks.every((w) => LV.every((lv) => w.in[lv] === 0))).toBe(true);
  });

  it('khoản một lần làm số dư thấp âm đúng các tuần đó; số dư đầu kỳ thật cộng vào → hết âm', () => {
    const cfg = cfgOf({
      payout_lag_weeks: { shopee: 0, offline: 0, tiktok: 0 },
      net_ratio_default: {
        shopee: parsePyJson('0.85'),
        offline: parsePyJson('1.0'),
        tiktok: parsePyJson('0.85'),
      },
      one_off: [{ name: 'nhap-hang', amount_vnd: 500_000_000, week_start: '2026-11-18' }],
    });
    const out = runFc(cfg, { 'a-sku': { shopee: 1000 } });
    expect(out.weeks[5]?.out).toBe(500_000_000);
    expect(out.weeks[0]?.in).toEqual({ low: 68_000_000, base: 85_000_000, high: 102_000_000 });
    expect(out.weeks[5]?.close.low).toBe(6 * 68_000_000 - 500_000_000);
    expect(out.warn_weeks).toEqual(['2026-11-16', '2026-11-23']);
    expect(out.weeks.every((w) => w.close.high >= 0)).toBe(true);
    const text = fc.render(out);
    expect(text).toContain('tuần âm ở kịch bản thấp');
    expect(text).toContain('16/11, 23/11');
    const out2 = runFc(cfg, { 'a-sku': { shopee: 1000 } }, 100_000_000);
    expect(out2.warn_weeks).toEqual([]);
    expect(out2.notes).not.toContain(fc.NO_OPENING);
  });

  it('chưa có số dư đầu kỳ thật + nguồn chưa xác minh được ghi rõ', () => {
    const out = runFc(cfgOf());
    expect(out.notes).toContain(fc.NO_OPENING);
    const text = fc.render(out);
    expect(text).toContain('chưa có số dư đầu kỳ thật');
    expect(text).toContain('chưa xác minh');
    expect(text).toContain('GIẢ ĐỊNH TEST');
    const data = JSON.parse(fc.toJson(out));
    expect(data.weeks).toHaveLength(13);
    expect(data.start).toBe('2026-10-12');
  });
});

describe('fp_cash CLI', () => {
  const run = async (o: FpCashOpts, extra: Partial<CliDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: number[] = [];
    const rc = await fpCashMain(o, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      now: () => new Date('2026-10-14T03:00:00Z'),
      connect: async () => {
        calls.push(1);
        return null;
      },
      ...extra,
    });
    return { rc, out, err, calls, text: out.join('\n') };
  };
  const argv = (a: string[]): FpCashOpts => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < a.length; i++) {
      const k = (a[i] as string).slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (k === 'json' || k === 'forecast') o[k] = true;
      else o[k] = a[++i];
    }
    return o as FpCashOpts;
  };

  it('DB down: stdout/stderr/exit y hệt Python (bảng, JSON, --opening nhóm nghìn/âm)', async () => {
    settings.forceMode = 'van_hanh';
    for (const c of FIX.cli as J[]) {
      const r = await run(argv(c.argv as string[]));
      expect(r.rc, String(c.argv)).toBe(c.rc);
      expect(`${r.out.join('\n')}\n`, String(c.argv)).toBe(c.out);
      expect(`${r.err.join('\n')}\n`, String(c.argv)).toBe(c.err);
    }
  });

  it('tham số sai → exit 2 TRƯỚC connect', async () => {
    settings.forceMode = 'van_hanh';
    for (const o of [
      { forecast: true, start: '2026-02-30' },
      { forecast: true, opening: 'abc' },
      { forecast: true, start: '1999-12-31' },
      {},
    ]) {
      const r = await run(o);
      expect(r.rc).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });

  it('cấu hình hỏng → exit 1 "không connect", không connect', async () => {
    settings.forceMode = 'van_hanh';
    const r = await run({ forecast: true }, { fpaConfig: writeCfg('{') });
    expect(r.rc).toBe(1);
    expect(r.text).toContain('không connect');
    expect(r.calls).toEqual([]);
  });

  it('DB down + --json: [warn] + 13 tuần', async () => {
    settings.forceMode = 'van_hanh';
    const r = await run({ forecast: true, start: START, json: true });
    expect(r.rc).toBe(0);
    expect(r.err.join('\n')).toContain('[warn]');
    expect(JSON.parse(r.text).weeks).toHaveLength(13);
  });

  it('đo tỷ lệ lỗi DB → [warn] dùng mặc định, vẫn exit 0', async () => {
    settings.forceMode = 'van_hanh';
    const boom = new pg.DatabaseError('relation "v_settlement_khoan" does not exist', 0, 'error');
    const db = { query: async () => Promise.reject(boom) } as unknown as Db;
    const r = await run(
      { forecast: true, start: START },
      { connect: async () => ({ db, release: async () => {} }) },
    );
    expect(r.rc).toBe(0);
    expect(r.err.join('\n')).toContain('[warn] không đo được tỷ lệ thực nhận từ settlement');
    expect(r.text).toContain('chưa xác minh');
  });

  it('tính năng TẮT (finance-05.2) → [rollout] exit 2, 1 dòng, không đọc nguồn/connect/ghi', async () => {
    settings.forceMode = 'tat';
    const dir = join(tmp, 'off');
    const r = await run({ forecast: true, start: '2026-10-26', outDir: dir });
    expect(r.rc).toBe(2);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^\[rollout\] .*finance-05\.2/);
    expect(r.calls).toEqual([]);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('--out-dir: chạy thử ghi dong-tien-<ngày>.md mang nhãn CHẠY THỬ', async () => {
    wireCore(null);
    settings.forceMode = 'chay_thu';
    const dir = join(tmp, 'trial');
    const r = await run({ forecast: true, start: '2026-10-14', outDir: dir });
    expect(r.rc).toBe(0);
    const body = readFileSync(join(dir, 'dong-tien-2026-10-14.md'), 'utf8');
    expect(body.startsWith('> **CHẠY THỬ — KHÔNG GỬI.** Tính năng finance-05.2')).toBe(true);
    expect(r.text).toContain('[done]');
  });

  it('sổ đầu ra: DB down / không đo được → sample=true; đo từ quyết toán thật → sample=false', async () => {
    settings.forceMode = 'van_hanh';
    const st = installFakeDeps(
      {},
      { reportFeature: (n) => (n.startsWith('dong-tien-') ? fc.FEATURE : null) },
    );
    await run({ forecast: true, start: START, outDir: join(tmp, 'rec1') });
    const rows = [{ channel: 'shopee', p: '850', o: '1000', n: '3' }];
    const db = { query: async () => ({ rows }) } as unknown as Db;
    await run(
      { forecast: true, start: START, outDir: join(tmp, 'rec2') },
      { connect: async () => ({ db, release: async () => {} }) },
    );
    expect(st.recorded.map((x) => [x.name, x.sample])).toEqual([
      ['dong-tien-2026-10-12.md', true],
      ['dong-tien-2026-10-12.md', false],
    ]);
    expect(readFileSync(join(tmp, 'rec2', 'dong-tien-2026-10-12.md'), 'utf8')).toContain(
      'đo từ settlement 3 dòng',
    );
  });
});

describe('FinCashModule', () => {
  it('khởi động nối finSources vào bản tin GĐ tài chính (chưa nối = "chưa nối nguồn")', async () => {
    const boom = new pg.DatabaseError('máy chủ test không có bảng', 0, 'error');
    const db = { query: async () => Promise.reject(boom) } as unknown as Db;
    setFinSources(null);
    let text = (await buildExtra(db, START)).join('\n');
    expect(text).toContain('chưa nối nguồn nhóm fin_cash');
    new FinCashModule().onModuleInit();
    try {
      text = (await buildExtra(db, START)).join('\n');
      expect(text).not.toContain('chưa nối nguồn nhóm fin_cash');
      expect(text).toContain('## Chi phí vận hành tháng 10/2026');
      expect(text).toContain('(chưa có dữ liệu: máy chủ test không có bảng)');
    } finally {
      setFinSources(null);
    }
  });
});
