import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { afterAll, describe, expect, it } from 'vitest';
import T from './__fixtures__/vt_thuhoach.golden.json' with { type: 'json' };
import * as sc from './scenario.js';
import * as vh from './vt-thuhoach.js';

// Dịch tests/test_vt_thuhoach.py (phần thuần/CLI không DB) + golden phần scenario/golden_store port
// tại chỗ. Golden: chạy hàm Python thật → so khớp y hệt.

const TMP = mkdtempSync(join(tmpdir(), 'vh-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const files = T.files as Record<string, string | null>;
function put(name: string): string {
  const p = join(TMP, name);
  const b = files[name];
  if (b !== null && b !== undefined) writeFileSync(p, Buffer.from(b, 'base64'));
  return p;
}
const [GOLDEN] = sc.readGolden();
const SKUS = (GOLDEN as { skus: unknown[] }).skus;
const HA = vh.loadAssumptions();
const SA = sc.loadAssumptions();
const NOW = new Date(T.harvest.now);
const toLogs = (xs: typeof T.harvest.logs) => xs.map((l) => ({ ...l, ts: new Date(l.ts) }));
const META = T.render.meta as vh.RenderMeta;

describe('forecastHarvest + availability + render (golden)', () => {
  it('harvest khớp Python; KV-4 inactive bỏ; thiếu dữ liệu không coi = 0', () => {
    const h = vh.forecastHarvest(T.harvest.plots as vh.Plot[], toLogs(T.harvest.logs), HA, NOW);
    expect(h).toEqual(T.harvest.out);
    expect(h.map((r) => r.plot_id)).not.toContain('KV-4');
    const kv1 = h.find((r) => r.plot_id === 'KV-1') as vh.HarvestRow;
    expect(kv1.low as number).toBeLessThan(kv1.high as number);
    expect(kv1.low).toBe(Math.floor((3000 * HA.yield.low * HA.survival.low) / 1000));
    const young = vh.forecastHarvest(
      [{ id: 'KV-Y', tree_count: 100, planted_year: 2026, status: 'active', source: 'manual' }],
      [],
      HA,
      NOW,
    );
    expect(young).toEqual(T.harvest.young);
    expect(young[0]?.notes[0]).toContain('chưa đủ 5 năm');
  });
  for (const [k, c] of Object.entries(T.avail)) {
    it(`availability ${k}`, () => {
      let sa = SA;
      if (c.nobase) {
        const doc = JSON.parse(readFileSync(sc.ASSUMPTIONS_FILE, 'utf8'));
        delete doc.baseline_units_per_week['saphraton-20v'];
        sa = sc.validateAssumptions(doc);
      }
      expect(vh.availability(c.lots as vh.Lot[], SKUS, sa, new Date(c.now), c.weeks)).toEqual(
        c.out,
      );
    });
  }
  it('nhu cầu = phép cộng ĐỘC LẬP project qua mọi kênh', () => {
    const honey = 'mat-ong-sam-120ml-1hu';
    const sku = SKUS.find((s) => (s as sc.Sku).sku_key === honey) as sc.Sku;
    const exp = { low: 0, base: 0, high: 0 };
    for (const ch of sc.ALL_CHANNELS) {
      for (const r of sc.project(sku, ch, sc.weekStart('2026-10-14'), 13, SA)) {
        for (const lv of sc.LEVELS) exp[lv] += r[lv];
      }
    }
    const lots = T.avail.main.lots as vh.Lot[];
    expect(
      vh.availability(lots, SKUS, SA, NOW, 13).find((r) => r.sku_key === honey)?.demand,
    ).toEqual(exp);
  });
  it('render khớp Python byte-identical; payload qua guardrail; dòng số lượng là khoảng', () => {
    const h = vh.forecastHarvest(T.harvest.plots as vh.Plot[], toLogs(T.harvest.logs), HA, NOW);
    const a = vh.availability(T.avail.main.lots as vh.Lot[], SKUS, SA, NOW, 13);
    const t = vh.render(h, a, META);
    expect(t).toBe(T.render.main);
    expect(Buffer.from(vh.render(h, a, META))).toEqual(Buffer.from(t));
    expect(vh.render([], [], { ...META, weeks: 1 })).toBe(T.render.empty);
    expect(guardrailCheck(t).ok).toBe(true);
    const qty = t.split('\n').filter((l) => l.includes(' kg') || l.includes('đơn vị'));
    expect(qty.length).toBeGreaterThanOrEqual(2);
    for (const l of qty) expect(l).toMatch(/\d+–\d+–\d+ (kg|đơn vị)/);
    expect(t).toContain('KV-2: thiếu dữ liệu (tree_count) — không ước lượng');
    expect(t).not.toMatch(/ruou|L-F/);
    expect(t.trimEnd().endsWith(vh.FOOTER)).toBe(true);
    for (const k of [
      'model: vt_thuhoach-rule-v1 + pipelines.scenario.project',
      'seed: 0',
      'as_of: 2026-10-14',
    ]) {
      expect(t).toContain(k);
    }
  });
  it('mã có xuống dòng không giả được dòng metadata', () => {
    const fi = T.render.forged_in;
    const t = vh.render(
      vh.forecastHarvest(fi.plots as vh.Plot[], [], HA, NOW),
      vh.availability(fi.lots as vh.Lot[], SKUS, SA, NOW),
      META,
    );
    expect(t).toBe(T.render.forged);
    expect(t).not.toContain('\n- seed: 42');
    expect(t.split('\n- seed: ').length - 1).toBe(1);
    expect(t.split('\n- model: ').length - 1).toBe(1);
  });
});

describe('loadAssumptions thu hoạch (golden, fail-closed)', () => {
  it('repo', () => {
    const { sha256, ...rest } = HA;
    expect(sha256).toBe(T.ha_sha);
    expect(rest).toEqual(Object.fromEntries(Object.entries(T.ha).filter(([k]) => k !== 'sha256')));
  });
  // KHÁC Python: NaN → JSONDecodeError (Python ValueError) — cùng bị chặn.
  const DIFF: Record<string, string> = { nan: 'h_nan.json hỏng (JSONDecodeError)' };
  for (const [k, want] of Object.entries(T.load_harvest)) {
    it(k, () => {
      const p = put(`h_${k}.json`);
      if ('err' in want) {
        expect(() => vh.loadAssumptions(p)).toThrow(vh.HarvestError);
        expect(() => vh.loadAssumptions(p)).toThrow(DIFF[k] ?? (want.msg as string));
      } else {
        const { sha256, ...rest } = vh.loadAssumptions(p);
        expect(rest).toEqual(want.ok);
        if ('sha' in want) expect(sha256).toBe(want.sha);
      }
    });
  }
  it('đổi giả định → đổi sha', () => {
    const doc = JSON.parse(readFileSync(vh.HARVEST_FILE, 'utf8'));
    doc.yield_g_per_tree.high += 1;
    const p = join(TMP, 'h-changed.json');
    writeFileSync(p, JSON.stringify(doc));
    expect(vh.loadAssumptions(p).sha256).not.toBe(HA.sha256);
  });
});

describe('scenario + golden_store (golden)', () => {
  const JS_JSON = new Set(['broken', 'nan']);
  for (const [k, want] of Object.entries(T.scenario.load)) {
    it(`load ${k}`, () => {
      const p = put(`s_${k}.json`);
      if ('err' in want) {
        expect(() => sc.loadAssumptions(p)).toThrow(sc.ScenarioError);
        expect(() => sc.loadAssumptions(p)).toThrow(
          JS_JSON.has(k) ? `s_${k}.json JSON hỏng: ` : (want.msg as string),
        );
      } else if ('events' in want) {
        const r = sc.loadAssumptions(p);
        expect(
          r.events.map(([id, w, c]) => [id, [...w.keys()].sort(), c ? [...c].sort() : null]),
        ).toEqual(want.events);
      }
    });
  }
  it('project mọi SKU × kênh', () => {
    for (const c of T.scenario.project) {
      const sku = SKUS.find((s) => (s as sc.Sku).sku_key === c.sku) as sc.Sku;
      if ('err' in c) {
        expect(() => sc.project(sku, c.ch, c.start, c.weeks, SA)).toThrow(
          (c as unknown as { msg: string }).msg,
        );
      } else
        expect(sc.project(sku, c.ch, c.start, c.weeks, SA), `${c.sku} ${c.ch}`).toEqual(c.rows);
    }
    for (const [d, want] of T.scenario.week_start) expect(sc.weekStart(d as string)).toBe(want);
  });
  it('validateGolden', () => {
    expect(sc.validateGolden(GOLDEN)).toEqual(T.golden_validate.repo);
    expect(sc.validateGolden([])).toEqual(T.golden_validate.root);
    expect(sc.validateGolden({ skus: [] })).toEqual(T.golden_validate.skus_empty);
    const bad = {
      skus: [
        {
          sku_key: 'A B',
          name: '',
          category: 'x',
          xnqc_status: 'y',
          self_declaration_ok: 1,
          pack_spec: 3,
          receipt_date: '2026-13-01',
          allowed_channels: ['lazada'],
          product_ids: [1],
          prices: [],
        },
        {
          sku_key: 'a',
          name: 'n',
          category: 'food',
          product_ids: ['p1'],
          prices: {
            web: { floor: 100, list: 200, promo: 50 },
            lazada: {},
            shopee: { x: 1, list: 0 },
            tiktok: 5,
          },
        },
        { sku_key: 'a', name: 'n', category: 'food', product_ids: ['p1'] },
        7,
      ],
    };
    expect(sc.validateGolden(bad)).toEqual(T.golden_validate.bad);
    const ok = {
      skus: [
        {
          sku_key: 'b-1',
          name: 'n',
          category: 'tpbvsk',
          prices: {
            web: { floor: 100, list: 149, promo: 100 },
            zalo: { list: 100, promo: 51 },
            chatbot: { list: 100, promo: 50 },
            facebook: { floor: 100, list: 150 },
          },
        },
      ],
    };
    expect(sc.validateGolden(ok)).toEqual(T.golden_validate.prices_ok);
  });
  it('readGolden', () => {
    const JS = new Set(['broken', 'utf8']);
    for (const [k, want] of Object.entries(T.read_golden)) {
      const p = put(`g_${k}.json`);
      const [doc, why] = sc.readGolden(p);
      expect(doc !== null, k).toBe(want.doc);
      const w = why === null ? null : why.replaceAll(p, '<P>');
      if (JS.has(k))
        expect(w?.startsWith((want.why as string).split(':')[0] as string), k).toBe(true);
      else expect(w, k).toBe(want.why);
    }
  });
});

// ------------------------------------------------------------------ CLI (không DB)

function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) } };
}
const noConnect = async () => {
  throw new Error('connect() không được gọi');
};

describe('vtThuhoachMain CLI', () => {
  it('DB down → exit 2', async () => {
    const t = cap();
    expect(await vh.vtThuhoachMain({}, { connect: async () => null, io: t.io, now: NOW })).toBe(2);
  });
  it.each<[vh.VtThuhoachOpts]>([
    [{ weeks: '0' }],
    [{ weeks: '105' }],
    [{ weeks: 'x' }],
    [{ date: 'x' }],
    [{ date: '1999-12-31' }],
  ])('usage %j → exit 2 trước connect', async (o) => {
    const t = cap();
    expect(await vh.vtThuhoachMain(o, { connect: noConnect, io: t.io })).toBe(2);
  });
  it('giả định hỏng → exit 1 trước connect', async () => {
    const p = join(TMP, 'h-bad.json');
    writeFileSync(p, '{}');
    const t = cap();
    expect(
      await vh.vtThuhoachMain({}, { connect: noConnect, io: t.io, now: NOW, harvestFile: p }),
    ).toBe(1);
    expect(t.o.err.join('\n')).toContain('[err] giả định');
  });
  it('golden hỏng → exit 1 trước connect', async () => {
    const p = join(TMP, 'g-bad.json');
    writeFileSync(p, '{"skus": [{"sku_key": "A"}]}');
    const t = cap();
    expect(
      await vh.vtThuhoachMain({}, { connect: noConnect, io: t.io, now: NOW, goldenFile: p }),
    ).toBe(1);
    expect(t.o.err.join('\n')).toContain('golden không dùng được');
  });
});
