import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyLoads } from '@samsam/core/ops/py-json';
import { afterAll, describe, expect, it } from 'vitest';
import { validateAssumptions } from '../garden_director/scenario.js';
import { type GoldenMap, isoDay, readInventory, type Stock } from './inventory-csv.js';
import * as prod from './production.js';

// Golden sinh bằng chạy hàm Python THẬT (`pipelines/production.py`, `ingest/inventory_csv.py`) trên
// đầu vào cố định — script ở scratchpad (gen.py), không trong repo. Fixture đọc bằng `pyLoads` để giữ
// phân biệt int/float như `json.loads` (qty 1.0 ≠ 1). Lỗi Python → {err: tên lớp, msg}.

const F = join(import.meta.dirname, '__fixtures__');
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON thô
const fx = (name: string): any => pyLoads(readFileSync(join(F, name), 'utf8'));
const CFG = fx('config.golden.json');
const AL = fx('allocate.golden.json');
const BL = fx('bom_lots.golden.json');
const BU = fx('bulletin.golden.json');
const INV = fx('inventory.golden.json');

type Res = { ok?: unknown; err?: string; msg?: string };
function run(fn: () => unknown): Res {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).name, msg: (e as Error).message };
  }
}
// biome-ignore lint/suspicious/noExplicitAny: fixture
const goldenOf = (doc: any): GoldenMap => new Map(doc.skus.map((s: any) => [s.sku_key, s]));
// biome-ignore lint/suspicious/noExplicitAny: fixture
const stockOf = (o: any): Stock => new Map(Object.entries(o)) as Stock;
/** `{$dt: iso}` → Date (datetime Python), còn lại giữ nguyên. */
function revive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$dt === 'string' && Object.keys(o).length === 1) return new Date(o.$dt);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]));
  }
  return v;
}

const TMP = mkdtempSync(join(tmpdir(), 'prodgold-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('config (validate_config / read_json / load_config)', () => {
  it.each(Object.keys(CFG.variants))('variant %s', (k) => {
    const v = CFG.variants[k];
    expect(run(() => prod.validateConfig(v.doc))).toEqual(v.res);
  });
  it.each(Object.keys(CFG.read))('read %s', (k) => {
    const v = CFG.read[k];
    const p = join(TMP, v.key ? 'b.json' : 'c.json');
    writeFileSync(p, Buffer.from(v.text, 'utf8'));
    const got = v.key ? run(() => prod.readJson(p, v.key)) : run(() => prod.loadConfig(p));
    expect(got).toEqual(v.res);
  });
  it('tệp không phải UTF-8 / thiếu tệp', () => {
    const bad = join(TMP, 'bad.json');
    writeFileSync(bad, Buffer.from('{"status": "\xff"}', 'latin1'));
    expect(run(() => prod.loadConfig(bad))).toEqual(CFG.read_not_utf8);
    expect(run(() => prod.loadConfig(join(TMP, 'nope.json')))).toEqual(CFG.read_missing);
  });
});

describe('demand_for / weeks_between / allocate / shortage / plan_rows / run_id_for', () => {
  const golden = goldenOf(AL.golden);
  const A = validateAssumptions(AL.assumptions);
  const idx = (xs: unknown[]): number[] => xs.map((_x, i) => i);
  it.each(idx(AL.cases))('demand #%s', (i) => {
    const c = AL.cases[i];
    expect(run(() => prod.weeksBetween(c.start, c.until))).toEqual(c.weeks);
    for (const [k, s] of golden) {
      expect([k, run(() => prod.demandFor(s, c.start, c.until, A))]).toEqual([k, c.by_sku[k]]);
    }
  });
  it.each(idx(AL.allocate))('allocate #%s', (i) => {
    const c = AL.allocate[i];
    expect(run(() => prod.allocate(c.stock, c.demand, c.category))).toEqual(c.res);
  });
  it('shortage', () => {
    for (const c of AL.shortage) expect(run(() => prod.shortage(c.stock, c.sums))).toEqual(c.res);
  });
  it('plan_rows trên golden thật × tồn giả định (stale, mẫu, thiếu số tồn, rượu)', () => {
    const p = AL.plan_rows;
    expect(run(() => prod.planRows([...golden.values()], stockOf(p.stock), p.demands))).toEqual(
      p.res,
    );
  });
  it('run_id_for khớp Python (2 hệ chạy song song không nhân bản run) + canon JSON', () => {
    for (const c of AL.run_id) {
      const got = prod.runIdFor(
        c.cutoff,
        c.start_week,
        stockOf(c.stock),
        c.status,
        Buffer.from(c.a_hex, 'hex'),
        Buffer.from(c.g_hex, 'hex'),
      );
      expect(got).toBe(c.res);
      expect(prod.canon({ cutoff: c.cutoff, x: '\x1bé"\\' })).toBe(c.canon);
    }
  });
});

describe('check_bom / buildable / validate_lots / qr_payload', () => {
  const golden = goldenOf(BL.golden);
  it.each(Object.keys(BL.cases))('bom %s', (k) => {
    expect(run(() => prod.checkBom(BL.cases[k].combos, golden))).toEqual(BL.cases[k].res);
  });
  it('buildable', () => {
    for (const c of BL.buildable) {
      expect(run(() => prod.buildable(c.items, new Map(Object.entries(c.stock))))).toEqual(c.res);
    }
  });
  it.each(Object.keys(BL.lots))('lots %s', (k) => {
    expect(run(() => prod.validateLots(BL.lots[k].lots, golden, '2026-10-12'))).toEqual(
      BL.lots[k].res,
    );
  });
  it('qr_payload', () => {
    for (const c of BL.qr) expect(run(() => prod.qrPayload(c.lot))).toEqual(c.res);
  });
});

describe('render_bulletin / split_fefo', () => {
  it.each(Object.keys(BU.cases))('bulletin %s', (k) => {
    const c = BU.cases[k];
    const got = run(() =>
      prod.renderBulletin(
        revive(c.data) as prod.BulletinData,
        new Date(c.now),
        c.config as prod.ProductionConfig,
      ),
    );
    expect(got).toEqual(c.res);
  });
  it('split_fefo', () => {
    for (const c of BU.split) expect(prod.splitFefo(c.text)).toEqual(c.res);
  });
});

describe('inventory_csv.read_inventory / _iso_date', () => {
  const golden = goldenOf(INV.golden);
  it.each(Object.keys(INV.cases))('%s', async (k) => {
    const c = INV.cases[k];
    const p = join(TMP, `inv-${k}`, c.name);
    rmSync(join(TMP, `inv-${k}`), { recursive: true, force: true });
    mkdirSync(join(TMP, `inv-${k}`), { recursive: true });
    writeFileSync(p, Buffer.from(c.hex, 'hex'));
    expect(await readInventory(p, golden, INV.today)).toEqual([c.rows, c.errs, c.sha]);
  });
  it('thiếu tệp', async () => {
    const m = INV.missing;
    expect(await readInventory(join(TMP, 'nope.csv'), golden, INV.today)).toEqual([
      m.rows,
      m.errs,
      m.sha,
    ]);
  });
  it('_iso_date', () => {
    for (const [s, want] of Object.entries(INV.iso)) expect([s, isoDay(s)]).toEqual([s, want]);
  });
  it('tệp mẫu data/sample_inventory.csv', async () => {
    const p = join(TMP, 'sample_inventory.csv');
    writeFileSync(p, Buffer.from(INV.sample.hex, 'hex'));
    expect(await readInventory(p, golden, INV.today)).toEqual([
      INV.sample.rows,
      INV.sample.errs,
      INV.sample.sha,
    ]);
  });
});
