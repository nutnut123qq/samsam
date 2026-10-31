import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { pyLoads } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { opsRollout, settings } from '@samsam/core/rollout/rollout';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_CHANNELS, loadAssumptions, type ProjectRow } from '../garden_director/scenario.js';
import { goldenMap, STALE_NOTE, type Stock } from './inventory-csv.js';
import {
  type Io,
  inventoryCsvMain,
  type Lease,
  productionMain,
  writeBulletin,
} from './production.command.js';
import * as prod from './production.js';

// Dịch phần THUẦN + CLI không DB của tests/test_production.py, test_r12_dot2.py (split_fefo/
// _write_bulletin), test_docx_p2.py (bản tin tách FEFO). Hàm thuần nhận ngày làm tham số — test không
// đọc đồng hồ. Phần DB: production.db.test.ts.

const TODAY = '2026-10-12';
const CHANS = ALL_CHANNELS;
const ALCOHOL = ['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml'];
const [GOLDEN] = goldenMap();
const G = GOLDEN as NonNullable<typeof GOLDEN>;
const sku = (k: string) => G.get(k) as NonNullable<ReturnType<typeof G.get>>;
const TMP = mkdtempSync(join(tmpdir(), 'produnit-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(TMP, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}
/** demand tay: kênh → base; low = base//2, high = base*2. */
function dem(base: Record<string, number> = {}): prod.Demands {
  return Object.fromEntries(
    CHANS.map((c) => {
      const b = base[c] ?? 0;
      return [c, { low: Math.floor(b / 2), base: b, high: b * 2, note: null }];
    }),
  );
}
function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  const io: Io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s) };
  return { o, io, text: () => [...o.out, ...o.err].join('\n') };
}
const noConnect = (calls: number[]) => async (): Promise<Lease | null> => {
  calls.push(1);
  throw new Error('không được connect');
};
const FAKE_PROJECT: prod.ProjectFn = (_s, _c, start, weeks) =>
  Array.from({ length: weeks as number }, () => ({
    week_start: start,
    events: [],
    low: 5,
    base: 10,
    high: 20,
    note: null,
  }));

// ---------- config ----------

describe('config', () => {
  it('tệp repo data/production_config.json', () => {
    const cfg = prod.loadConfig();
    expect(cfg.status).toContain('GIẢ ĐỊNH');
    expect(new Set(cfg.cutoffs.map((c) => c.date))).toEqual(
      new Set(['2026-10-25', '2026-11-01', '2026-11-15', '2026-12-10']),
    );
    expect([cfg.sla_hours, cfg.remind_hours, cfg.near_expiry_days]).toEqual([48, 24, 90]);
  });
});

// ---------- SX-A3: demand_for dùng scenario.project (không engine 2) ----------

describe('phân bổ tồn (SX-A3)', () => {
  it('không có engine thứ 2: import project từ scenario, không tự đọc giả định', () => {
    const src = readFileSync(join(import.meta.dirname, 'production.ts'), 'utf8');
    expect(src).toMatch(/from '\.\.\/garden_director\/scenario\.js'/);
    expect(src).not.toMatch(/scenario_assumptions|baseline|trend|lunar_new_year/);
  });

  it('demand_for gọi project đúng 1 lần mỗi kênh, cộng theo tuần', () => {
    const calls: [string, string, string, number][] = [];
    const spy: prod.ProjectFn = (s, ch, start, weeks) => {
      calls.push([String(s.sku_key), ch, start, weeks as number]);
      const k = CHANS.indexOf(ch) + 1;
      return Array.from({ length: weeks as number }, () => ({
        week_start: start,
        events: [],
        low: k,
        base: 2 * k,
        high: 3 * k,
        note: null,
      })) as ProjectRow[];
    };
    const d = prod.demandFor(sku('saphraton-20v'), TODAY, '2026-11-15', { x: 1 }, spy);
    expect(calls.map((c) => c[1]).sort()).toEqual([...CHANS].sort());
    const weeks = calls[0]?.[3] as number;
    expect(weeks).toBe(5); // tuần 12/10 .. tuần chứa 15/11 (thứ Hai 9/11)
    for (const c of CHANS) {
      const k = CHANS.indexOf(c) + 1;
      const x = d[c] as prod.Demand;
      expect([x.low, x.base, x.high]).toEqual([k * weeks, 2 * k * weeks, 3 * k * weeks]);
    }
  });

  it('engine thật: rượu online = 0, offline > 0', () => {
    const a = loadAssumptions();
    for (const key of ALCOHOL) {
      const d = prod.demandFor(sku(key), TODAY, '2026-11-15', a);
      for (const c of CHANS) if (c !== 'offline') expect(d[c]?.high).toBe(0);
      expect(d.offline?.base).toBeGreaterThan(0);
    }
  });

  it('quá 104 tuần / start sau covers_until → ProductionError', () => {
    const a = loadAssumptions();
    expect(() => prod.demandFor(sku('savina-12v'), TODAY, '2030-01-01', a)).toThrow(
      prod.ProductionError,
    );
    expect(() => prod.demandFor(sku('savina-12v'), TODAY, '2026-09-01', a)).toThrow(
      prod.ProductionError,
    );
  });

  it('chốt chặn rượu thứ 2: demand online giả > 0 vẫn đề xuất 0', () => {
    for (const key of ALCOHOL) {
      const d = prod.demandFor(sku(key), TODAY, '2026-11-15', {}, FAKE_PROJECT);
      expect(d.shopee?.base).toBeGreaterThan(0);
      const a = prod.allocate(100, d, 'alcohol');
      for (const c of CHANS) {
        if (c === 'offline') expect(a.proposed[c]).toBeGreaterThan(0);
        else {
          expect([a.proposed[c], a.demand[c]?.base]).toEqual([0, 0]);
          expect(a.notes[c]).toContain('rượu');
        }
      }
    }
  });

  it('chốt chặn rượu trên ĐƯỜNG THẬT plan_rows → allocate(category golden)', () => {
    const skus = ALCOHOL.map(sku);
    expect(new Set(skus.map((s) => s.category))).toEqual(new Set(['alcohol']));
    const demands = Object.fromEntries(
      ALCOHOL.map((k) => [k, prod.demandFor(sku(k), TODAY, '2026-11-15', {}, FAKE_PROJECT)]),
    );
    const stock: Stock = new Map(
      ALCOHOL.map((k) => [k, { qty: 1000, kho: {}, stale: [], sample: false }]),
    );
    const rows = prod.planRows(skus, stock, demands);
    expect(rows.length).toBe(ALCOHOL.length * CHANS.length);
    for (const r of rows) {
      if (r.channel === 'offline') expect(r.proposed_qty).toBeGreaterThan(0);
      else {
        expect([r.proposed_qty, r.demand_base]).toEqual([0, 0]);
        expect(r.note).toContain('rượu');
      }
    }
  });

  it('tồn 0 / dưới cơ sở (dư lớn nhất, hòa theo thứ tự kênh) / trên cơ sở / chưa có số tồn', () => {
    let a = prod.allocate(0, dem({ shopee: 4, offline: 2 }), 'tpbvsk');
    expect(new Set(Object.values(a.proposed))).toEqual(new Set([0]));
    expect(a.flag_level).toBe('low');
    expect(a.flag).toContain('THẤP');
    a = prod.allocate(7, dem({ shopee: 3, tiktok: 3, offline: 3 }), 'tpbvsk');
    expect([a.proposed.shopee, a.proposed.tiktok, a.proposed.offline, a.unallocated]).toEqual([
      3, 2, 2, 0,
    ]);
    a = prod.allocate(10, dem({ shopee: 9, offline: 3 }), 'food');
    expect([a.proposed.shopee, a.proposed.offline]).toEqual([8, 2]);
    a = prod.allocate(100, dem({ shopee: 30, offline: 20 }), 'tpbvsk');
    expect([a.proposed.shopee, a.proposed.offline, a.unallocated, a.flag_level]).toEqual([
      30,
      20,
      50,
      null,
    ]);
    for (const c of CHANS) if (c !== 'shopee' && c !== 'offline') expect(a.proposed[c]).toBe(0);
    a = prod.allocate(null, dem({ shopee: 30 }), 'tpbvsk');
    expect(new Set(Object.values(a.proposed))).toEqual(new Set([0]));
    expect([a.flag_level, a.flag, a.unallocated]).toEqual([null, prod.NOTE_NO_STOCK, null]);
  });

  it('mức thiếu', () => {
    const sums = { low: 10, base: 20, high: 30 };
    expect(prod.shortage(5, sums)[0]).toBe('low');
    const [lvl, text] = prod.shortage(15, sums);
    expect(lvl).toBe('base');
    expect(text).toContain('THIẾU (cơ sở) 5');
    expect(prod.shortage(25, sums)[0]).toBe('high');
    expect(prod.shortage(30, sums)).toEqual([null, null]);
    expect(prod.shortage(null, sums)).toEqual([null, null]);
  });

  it('stock sai kiểu → ProductionError (âm, bool, số thực)', () => {
    for (const bad of [-1, true, 1.5]) {
      expect(() => prod.allocate(bad, dem({ shopee: 1 }), 'tpbvsk')).toThrow(prod.ProductionError);
    }
  });

  it('test thuần không đọc đồng hồ', () => {
    const src = readFileSync(import.meta.filename, 'utf8');
    for (const bad of [`Date.${'now'}(`, `new Date${'()'}`]) expect(src.includes(bad)).toBe(false);
  });
});

// ---------- SX-A4 BOM ----------

const combo = (key: string, chans: string[], ...items: string[]) => ({
  combo_key: key,
  name: `Combo ${key}`,
  channels: chans,
  items: items.map((s) => ({ sku_key: s, qty: 1 })),
});

describe('BOM (SX-A4)', () => {
  it('tệp mẫu hợp lệ', () => {
    const doc = pyLoads(readFileSync(dataPath('sample_bom.json'), 'utf8')) as {
      status: string;
      _doc: string;
      combos: { channels: string[] }[];
    };
    expect(doc.status).toContain('MẪU');
    expect(doc._doc).toContain('MẪU');
    expect(prod.checkBom(doc.combos, G)).toEqual([]);
    const chans = doc.combos.map((c) => JSON.stringify(c.channels));
    expect(chans).toContain('["shopee"]');
    expect(chans).toContain('["offline"]');
  });

  it('SKU không có kênh của combo trong allowed_channels', () => {
    expect(prod.checkBom([combo('c1', ['shopee'], 'saphraton-20v', 'saphraton-40v')], G)).toEqual([
      'combo c1 kênh shopee: SKU saphraton-40v không có shopee trong allowed_channels',
    ]);
    const errs = prod.checkBom([combo('c2', ['tiktok'], 'saphraton-20v')], G);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('saphraton-20v');
    expect(errs[0]).toContain('tiktok');
  });

  it('rượu online lỗi dù golden cho shopee; offline thì được', () => {
    expect(sku('ruou-sam-chai-thuy-tinh-500ml').allowed_channels).toContain('shopee');
    const errs = prod.checkBom([combo('r1', ['shopee'], 'ruou-sam-chai-thuy-tinh-500ml')], G);
    expect(errs.some((e) => e.includes('combo có rượu chỉ được kênh offline'))).toBe(true);
    expect(
      prod.checkBom(
        [combo('r2', ['offline'], 'ruou-sam-chai-thuy-tinh-500ml', 'saphraton-40v')],
        G,
      ),
    ).toEqual([]);
  });

  it('luật theo DỮ LIỆU golden, không cứng trong mã', () => {
    const g2 = new Map(G);
    g2.set('saphraton-20v', { ...sku('saphraton-20v'), allowed_channels: ['shopee', 'tiktok'] });
    const combos = [combo('c2', ['tiktok'], 'saphraton-20v')];
    expect(prod.checkBom(combos, G)).not.toEqual([]);
    expect(prod.checkBom(combos, g2)).toEqual([]);
  });

  it.each([
    'banned_name',
    'qty0',
    'qty_bool',
    'sku',
    'channel',
    'no_items',
    'dup_key',
    'dup_sku',
    'bad_key',
    'extra_key',
  ])('biến thể lỗi %s — không in SĐT', (kind) => {
    const c: Record<string, unknown> = combo('c1', ['offline'], 'savina-12v');
    const items = c.items as Record<string, unknown>[];
    let combos: unknown[] = [c];
    if (kind === 'banned_name') c.name = 'Hộp quà chữa bệnh';
    else if (kind === 'qty0') (items[0] as Record<string, unknown>).qty = 0;
    else if (kind === 'qty_bool') (items[0] as Record<string, unknown>).qty = true;
    else if (kind === 'sku') (items[0] as Record<string, unknown>).sku_key = 'khong-co';
    else if (kind === 'channel') c.channels = ['lazada'];
    else if (kind === 'no_items') c.items = [];
    else if (kind === 'dup_key') combos = [c, structuredClone(c)];
    else if (kind === 'dup_sku') items.push({ sku_key: 'savina-12v', qty: 2 });
    else if (kind === 'bad_key') c.combo_key = 'Combo 1';
    else if (kind === 'extra_key') c.phone = '0905123456';
    const errs = prod.checkBom(combos, G);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('0905123456'))).toBe(false);
  });

  it('buildable', () => {
    const items = [
      { sku_key: 'a', qty: 1 },
      { sku_key: 'b', qty: 1 },
    ];
    expect(
      prod.buildable(
        items,
        new Map([
          ['a', 200],
          ['b', 50],
        ]),
      ),
    ).toEqual([50, []]);
    expect(prod.buildable([{ sku_key: 'a', qty: 3 }], new Map([['a', 10]]))).toEqual([3, []]);
    expect(prod.buildable(items, new Map([['a', 200]]))).toEqual([0, ['b']]);
  });
});

// ---------- SX-A5 lô ----------

const lot = (kw: Record<string, unknown> = {}) => ({
  lot_code: 'L-001',
  sku_key: 'savina-12v',
  mfg_date: '2026-09-01',
  exp_date: '2028-09-01',
  qty: 10,
  ...kw,
});

describe('hồ sơ lô (SX-A5)', () => {
  it('tệp mẫu hợp lệ, mã MAU-, có lô rượu', () => {
    const doc = pyLoads(readFileSync(dataPath('sample_lots.json'), 'utf8')) as {
      status: string;
      _doc: string;
      lots: { lot_code: string; sku_key: string }[];
    };
    expect(doc.status).toContain('MẪU');
    expect(doc._doc).toContain('MẪU');
    expect(prod.validateLots(doc.lots, G, TODAY)).toEqual([]);
    expect(doc.lots.length).toBeGreaterThanOrEqual(3);
    expect(doc.lots.every((l) => l.lot_code.startsWith('MAU-'))).toBe(true);
    expect(doc.lots.some((l) => ALCOHOL.includes(l.sku_key))).toBe(true);
  });

  it.each([
    lot({ exp_date: '2026-08-31' }),
    lot({ exp_date: '2026-09-01' }),
    lot({ mfg_date: '2026-10-13', exp_date: '2027-10-13' }),
    lot({ lot_code: 'l-001' }),
    lot({ lot_code: 'L 001' }),
    lot({ phone: '0905' }),
    lot({ qty: 0 }),
    lot({ qty: true }),
    lot({ sku_key: 'khong-co' }),
    lot({ sku_key: ['saphraton-20v'] }),
    lot({ sku_key: { a: 1 } }),
    lot({ mfg_date: '01/09/2026' }),
    lot({ note: 123 }),
  ])('biến thể lỗi %#', (l) => {
    expect(prod.validateLots([l], G, TODAY).length).toBeGreaterThan(0);
  });

  it('mã lô trùng', () => {
    expect(prod.validateLots([lot(), lot()], G, TODAY)).toEqual(['lô L-001: lot_code trùng']);
  });

  it('qr_payload chỉ lô passed, không người kiểm', () => {
    const l = { ...lot(), intake_status: 'pending', checked_by: 'QA' };
    expect(prod.qrPayload(l)).toBeNull();
    l.intake_status = 'passed';
    expect(prod.qrPayload(l)).toEqual({
      lot_code: 'L-001',
      sku_key: 'savina-12v',
      exp_date: '2028-09-01',
    });
  });

  it('TS_STRICTER: "\\n" cuối mã lô/combo/mốc/run bị từ chối (Python `$` cho lọt rồi ghi DB)', () => {
    // Python: LOT_RE.match("L-001\n") khớp → lô có '\n' cuối vào DB; TS từ chối (fail-closed).
    expect(prod.validateLots([lot({ lot_code: 'L-001\n' })], G, TODAY)).toEqual([
      'lots[0]: lot_code phải khớp ^[A-Z0-9][A-Z0-9-]{2,31}$',
    ]);
    expect(prod.checkBom([combo('c1\n', ['offline'], 'savina-12v')], G)).toEqual([
      'combos[0]: combo_key phải là slug ascii',
    ]);
    const cfg = {
      status: 'x',
      cutoffs: [{ id: 'a\n', date: '2026-10-25', covers_until: '2026-11-15' }],
      sla_hours: 48,
      remind_hours: 24,
      near_expiry_days: 90,
    };
    expect(() => prod.validateConfig(cfg)).toThrow('cutoffs[0].id: phải là slug a-z0-9_-');
    expect(prod.RUN_RE.test('abcdef012345\n')).toBe(false);
  });
});

// ---------- SX-A0 bản tin (thuần) ----------

const HEADINGS = [
  '## Thiếu hàng theo mốc chốt',
  '## Lô chờ kiểm nhập',
  '## BOM lỗi',
  '## Mục chờ duyệt & SLA',
];
const CREATED = new Date('2026-10-12T09:00:00+07:00');
const hours = (h: number) => h * 3600_000;
const at = (d: Date, ms: number) => new Date(d.getTime() + ms);
const NEAR = '## Hàng cận hạn (FEFO)';

function bdata(): prod.BulletinData {
  return {
    date: TODAY,
    missing_tables: [],
    sample: true,
    shortages: [
      {
        cutoff_id: 'chot_11_11',
        cutoff_date: '2026-10-25',
        run_id: 'abcdef012345',
        status: 'pending',
        sku_key: 'saphraton-20v',
        stock_total: 70,
        low: 83,
        base: 111,
        high: 145,
        flag: 'THIẾU CẢ KỊCH BẢN THẤP',
      },
    ],
    no_stock: ['mat-ong-sam-300ml'],
    lots_pending: [
      {
        lot_code: 'L-1',
        sku_key: 'savina-12v',
        mfg_date: '2026-09-01',
        exp_date: '2028-09-01',
        qty: 5,
        created_at: CREATED,
      },
    ],
    bom_errors: ['combo c1 kênh shopee: SKU x không có shopee trong allowed_channels'],
    pending: [
      { kind: 'phân bổ', id: 'abcdef012345', created_at: CREATED },
      { kind: 'lô', id: 'L-1', created_at: CREATED },
      { kind: 'lô', id: 'L-2', created_at: CREATED },
    ],
  };
}
const EMPTY: prod.BulletinData = {
  missing_tables: [],
  shortages: [],
  no_stock: [],
  lots_pending: [],
  bom_errors: [],
  pending: [],
  sample: false,
  date: TODAY,
};
const near = (code: string, s: string, exp: string, qty = 10, stock: number | null = 5) => ({
  lot_code: code,
  sku_key: s,
  exp_date: exp,
  qty,
  stock,
});

describe('bản tin (SX-A0)', () => {
  const cfg = prod.loadConfig();

  it('tất định + thứ tự mục + nhãn MẪU/GIẢ ĐỊNH', () => {
    const now = at(CREATED, hours(3));
    const a = prod.renderBulletin(bdata(), now, cfg);
    expect(a).toBe(prod.renderBulletin(bdata(), now, cfg));
    const pos = HEADINGS.map((h) => a.indexOf(h));
    expect(pos).toEqual([...pos].sort((x, y) => x - y));
    for (const s of ['[MẪU]', 'KHÔNG phải doanh số cam kết', 'GIẢ ĐỊNH', 'còn 13 ngày']) {
      expect(a).toContain(s);
    }
    expect(a.split(HEADINGS[0] as string)[1]?.split(HEADINGS[1] as string)[0]).toContain(
      'saphraton-20v',
    );
    expect(a).toContain('mat-ong-sam-300ml');
    expect(a.split(HEADINGS[2] as string)[1]).toContain('SKU x');
  });

  it('ngưỡng SLA: dưới nhắc / nhắc / quá SLA', () => {
    const sla = (now: Date) =>
      prod.renderBulletin(bdata(), now, cfg).split(HEADINGS[3] as string)[1] as string;
    let s = sla(at(CREATED, hours(23) + 59 * 60_000));
    expect([s.includes('NHẮC'), s.includes('QUÁ SLA'), s.split('trong hạn').length - 1]).toEqual([
      false,
      false,
      3,
    ]);
    s = sla(at(CREATED, hours(24)));
    expect([s.split('NHẮC').length - 1, s.includes('QUÁ SLA')]).toEqual([3, false]);
    s = sla(at(CREATED, hours(48) + 60_000));
    expect(s.split('QUÁ SLA 48h — đề xuất chuyển TGĐ').length - 1).toBe(3);
    expect(s.includes('NHẮC')).toBe(false);
  });

  it('rỗng → 5 mục "không có"; thiếu bảng → 5 lần "chưa có bảng"', () => {
    let out = prod.renderBulletin(EMPTY, CREATED, cfg);
    expect(out.split('không có').length - 1).toBe(5);
    expect(out).not.toContain('[MẪU]');
    out = prod.renderBulletin({ ...EMPTY, missing_tables: [...prod.ALLOC_TABLES] }, CREATED, cfg);
    expect(out.split('chưa có bảng — chạy apply_schema').length - 1).toBe(5);
  });

  it('chặn mã điều khiển + kẹp tuổi âm về 0', () => {
    const data = bdata();
    (data.lots_pending as prod.PendingLot[])[0] = {
      ...(data.lots_pending?.[0] as prod.PendingLot),
      lot_code: 'L-1\x1b[2J',
    };
    data.pending = [{ kind: 'lô', id: 'L-1\x1b[2J', created_at: at(CREATED, hours(2)) }];
    const out = prod.renderBulletin(data, CREATED, cfg);
    expect(out.includes('\x1b')).toBe(false);
    expect(out).toContain('chờ 0h');
    const errs = prod.checkBom([{ ...combo('c1', ['offline'], 'savina-12v'), 'x\x1b[31m': 1 }], G);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('\x1b'))).toBe(false);
  });

  it('tồn cũ (stale) hiện ở mục 1, không mã điều khiển', () => {
    const out = prod.renderBulletin(
      { ...EMPTY, stale_stock: [['savina-12v', 'kho-a\x1b[2J']] },
      CREATED,
      cfg,
    );
    const sec0 = out.split(HEADINGS[0] as string)[1]?.split(HEADINGS[1] as string)[0] as string;
    expect(sec0).toContain(STALE_NOTE);
    expect(sec0).not.toContain('không có');
    expect(out.includes('\x1b')).toBe(false);
  });

  it('cận hạn FEFO: cửa sổ 90 ngày, nhãn, thứ tự HSD rồi mã lô', () => {
    const d = (n: number) => prod.plusDays(TODAY, n);
    const data = {
      ...EMPTY,
      near_expiry: [
        near('L-B', 'savina-12v', d(90)),
        near('L-OUT', 'savina-12v', d(91)),
        near('L-OLD\x1b[2J', 'saphraton-20v', d(-2), 10, null),
        near('L-A', 'savina-12v', d(90)),
        near('L-TODAY', 'savina-12v', d(0), 10, 7),
      ],
    };
    const out = prod.renderBulletin(data, CREATED, cfg);
    const sec = out.split(NEAR)[1] as string;
    expect(out.indexOf(NEAR)).toBeGreaterThan(out.indexOf(HEADINGS[3] as string));
    const lines = sec.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => l.split(' · ')[0])).toEqual([
      '- L-OLD?[2J',
      '- L-TODAY',
      '- L-A',
      '- L-B',
    ]);
    expect(lines[0]).toContain('ĐÃ QUÁ HẠN 2 ngày');
    expect(lines[0]).toContain('chưa có số tồn');
    expect(lines[1]).toContain('còn 0 ngày');
    expect(lines[1]).toContain('tồn SKU 7');
    expect(lines[2]).toContain('còn 90 ngày');
    expect(out).not.toContain('L-OUT');
    expect(out.includes('\x1b')).toBe(false);
    expect(sec).not.toContain('không có');
    expect(out).toBe(prod.renderBulletin(data, CREATED, cfg));
  });

  it('cận hạn: data cũ thiếu khóa / thiếu bảng / cửa sổ nhỏ', () => {
    expect(prod.renderBulletin(EMPTY, CREATED, cfg).split(NEAR)[1]).toContain('không có');
    expect(
      prod
        .renderBulletin({ ...EMPTY, missing_tables: ['production_lots'] }, CREATED, cfg)
        .split(NEAR)[1],
    ).toContain('chưa có bảng');
    const out = prod.renderBulletin(
      { ...EMPTY, near_expiry: [near('L-2', 'savina-12v', prod.plusDays(TODAY, 2))] },
      CREATED,
      { ...cfg, near_expiry_days: 1 },
    );
    expect(out).not.toContain('L-2');
    expect(out).toContain('HSD ≤ 1 ngày');
  });

  it('module sản xuất không gọi LLM (0 import AI gateway)', () => {
    for (const f of readdirSync(import.meta.dirname)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(join(import.meta.dirname, f), 'utf8');
      expect([f, /core\/ai\/|AI_GATEWAY|openai|\.chat\(/.test(src)]).toEqual([f, false]);
    }
  });
});

// ---------- split_fefo + ghi báo cáo (r12 G1-L1, docx P2) ----------

const TEXT =
  '# Bản tin Sản xuất tuần — 2026-10-23\n\n## Thiếu hàng theo mốc chốt\n- A\n\n## Hàng cận hạn (FEFO)\n- L1 · sku · HSD\n\n## Tiến độ kế hoạch sản xuất\n- P1\n';

describe('split_fefo + writeBulletin', () => {
  beforeEach(() => {
    settings.forceMode = 'chay_thu'; // giai đoạn chạy thử (không DB): nhãn, không ghi sổ
    setOpsDeps({ rollout: opsRollout });
  });
  afterEach(() => {
    settings.forceMode = null;
    resetOpsDeps();
  });

  it('tách mục cận hạn', () => {
    const [bantin, canhan] = prod.splitFefo(TEXT);
    expect(bantin).toContain('Thiếu hàng');
    expect(bantin).toContain('Tiến độ');
    expect(bantin).not.toContain('Hàng cận hạn');
    expect(canhan).toContain('L1');
    expect(canhan).not.toContain('Thiếu hàng');
    expect(canhan).not.toContain('Tiến độ');
    expect(prod.splitFefo('# T\nx\n')).toEqual(['# T\nx\n', '']);
  });

  it.each([
    ['bantin', ['sx-canhan-2026-10-23.md']],
    ['canhan', ['sx-bantin-tuan-2026-10-23.md']],
  ])('bỏ đúng phần bị chặn (%s)', async (skip, want) => {
    const dir = mkdtempSync(join(TMP, 'wb-'));
    const c = cap();
    const rc = await writeBulletin(
      TEXT,
      { sample: true },
      dir,
      '2026-10-23',
      'week',
      new Set([skip]),
      c.io,
    );
    expect(rc).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(want);
  });

  it('bản tin tháng: tệp đủ + tệp cận hạn chỉ mục FEFO, có nhãn CHẠY THỬ', async () => {
    const dir = mkdtempSync(join(TMP, 'wb-'));
    const text =
      '# Bản tin Sản xuất tháng — 2026-10-01\n\nx\n\n## Hàng cận hạn (FEFO)\n- L1 · sku · HSD\n';
    expect(
      await writeBulletin(text, { sample: true }, dir, '2026-10-01', 'month', new Set(), cap().io),
    ).toBe(0);
    const full = readFileSync(join(dir, 'sx-bantin-thang-2026-10-01.md'), 'utf8');
    const fefo = readFileSync(join(dir, 'sx-canhan-2026-10-01.md'), 'utf8');
    expect(full).toContain('\nx\n');
    expect(fefo).toContain('## Hàng cận hạn (FEFO)');
    expect(fefo).not.toContain('\nx\n');
    expect(full.startsWith('> **CHẠY THỬ')).toBe(true);
  });

  it('tính năng TẮT → không ghi tệp, exit 2', async () => {
    settings.forceMode = 'tat';
    const dir = mkdtempSync(join(TMP, 'wb-'));
    const c = cap();
    expect(
      await writeBulletin(TEXT, { sample: false }, dir, '2026-10-23', 'week', new Set(), c.io),
    ).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(c.text()).toContain('[rollout]');
  });
});

// ---------- CLI usage (không DB) ----------

describe('CLI production (không DB)', () => {
  it.each([
    [['approve', '--run', 'abcdef012345']],
    [['approve', '--run', 'abcdef012345', '--by', '   ']],
    [['reject', '--run', 'abcdef012345', '--by', 'x'.repeat(101)]],
    [['approve', '--run', 'nothex', '--by', 'A']],
    [['intake', '--lot', 'MAU-SAP20-260901', '--result', 'passed']],
    [['intake', '--lot', 'MAU-SAP20-260901', '--result', 'passed', '--by', '   ']],
    [['intake', '--lot', 'MAU-SAP20-260901', '--result', 'ok', '--by', 'A']],
    [['bom']],
    [['bom', '--load', 'x.json', '--check']],
    [['bom', '--check', '--source', 'sample']],
    [[]],
    [['khong-co']],
    [['bulletin', '--date', '2026-13-01']],
    [['bulletin', '--period', 'year']],
    [
      [
        'plan-add',
        '--code',
        'KH-1',
        '--sku',
        's',
        '--qty',
        'x',
        '--start',
        '2026-10-01',
        '--due',
        '2026-10-02',
        '--by',
        'A',
      ],
    ],
    [['cert', '--lot', 'l-1', '--file', 'a.pdf', '--cert-no', 'K', '--by', 'A']],
    [['approve', '--run', 'abcdef012345', '--by', 'A', 'thua']],
    [['allocate']],
  ])('%j → exit 2, không connect', async (argv) => {
    const calls: number[] = [];
    const c = cap();
    expect(await productionMain(argv, { connect: noConnect(calls), io: c.io })).toBe(2);
    expect(calls).toEqual([]);
    expect(c.o.err.join('\n')).toContain('error:');
  });

  it('viết tắt tiền tố + `--x=v` như argparse', async () => {
    const calls: number[] = [];
    const c = cap();
    // --cut = --cutoff; mốc không có trong config → [err] exit 1 TRƯỚC connect
    expect(
      await productionMain(['allocate', '--cut=khong_co'], { connect: noConnect(calls), io: c.io }),
    ).toBe(1);
    expect(c.text()).toContain("không có mốc 'khong_co' trong config");
    expect(calls).toEqual([]);
  });

  it('BOM/lô tệp hỏng → exit 1, không connect, không nạp gì', async () => {
    const calls: number[] = [];
    const c = cap();
    const badBom = write('b.json', {
      _doc: 'x',
      combos: [combo('r1', ['shopee'], 'ruou-sam-chai-thuy-tinh-500ml')],
    });
    const badLots = write('l.json', { lots: [lot({ exp_date: '2026-08-01' })] });
    // sku_key không phải chuỗi → [err], không crash
    const listSku = write('ls.json', {
      lots: [lot({ sku_key: ['saphraton-20v'] }), lot({ lot_code: 'L-002', sku_key: { a: 1 } })],
    });
    for (const argv of [
      ['bom', '--load', badBom],
      ['bom', '--load', join(TMP, 'missing.json')],
      ['bom', '--load', write('e.json', '{}')],
      ['lots', '--load', badLots],
      ['lots', '--load', listSku],
      ['lots', '--load', write('d.json', { _doc: 'x' })],
    ]) {
      expect([
        argv[2],
        await productionMain(argv, { connect: noConnect(calls), io: c.io }),
      ]).toEqual([argv[2], 1]);
    }
    expect(calls).toEqual([]);
    expect(c.text()).toContain('không connect');
  });

  it('bản tin: DB chết → [err] exit 1, không traceback', async () => {
    const c = cap();
    const rc = await productionMain(['bulletin', '--date', '2026-10-12'], {
      env: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' },
      io: c.io,
      wire: () => {},
    });
    expect(rc).toBe(1);
    expect(c.o.out.join('\n')).toContain('[err]');
  });

  it('host treo quá hạn kết nối → ConnectionTimeout như psycopg (production + inventory-csv)', async () => {
    // Python (đã chạy với server TCP nhận rồi im): `[err] không kết nối được Postgres: ConnectionTimeout`.
    const held: Socket[] = [];
    const srv = createServer((s) => held.push(s));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://u@127.0.0.1:${(srv.address() as AddressInfo).port}/x`,
    };
    try {
      const c = cap();
      const d = cap();
      const rcs = await Promise.all([
        productionMain(['bulletin', '--date', TODAY], { env, io: c.io, wire: () => {} }),
        inventoryCsvMain(['--file', dataPath('sample_inventory.csv')], { env, io: d.io }),
      ]);
      expect(rcs).toEqual([1, 1]);
      for (const o of [c.o.out, d.o.out]) {
        expect(o).toContain('[err] không kết nối được Postgres: ConnectionTimeout');
      }
    } finally {
      for (const s of held) s.destroy();
      srv.close();
    }
  }, 20_000);

  it('MAJOR review: không còn đường đọc bản tin bỏ qua cổng production-01/04.3 (HĐ 6.7)', async () => {
    // ProductionService.bulletin() dựng bản tin không qua `blocked()` — gỡ; bản tin chỉ qua CLI có cổng.
    expect('ProductionService' in (await import('./production.service.js'))).toBe(false);
  });

  it('thiếu DATABASE_URL → [err] exit 1', async () => {
    const c = cap();
    const rc = await productionMain(['bom', '--check'], { env: { NODE_ENV: 'test' }, io: c.io });
    expect(rc).toBe(1);
    expect(c.o.out).toContain('[err] thiếu DATABASE_URL trong .env');
  });

  it('bom --check: chuỗi đọc từ DB bị chặn mã điều khiển', async () => {
    const c = cap();
    const client = {
      query: async (sql: string) => {
        if (sql.includes('from bom_combos')) {
          return {
            rows: [
              {
                combo_key: 'c1\x1b[2J',
                name: 'Combo',
                channels: ['offline\x1b]0;x\x07'],
                source: 'manual',
                note: null,
              },
            ],
          };
        }
        if (sql.includes('from bom_items')) {
          return { rows: [{ combo_key: 'c1\x1b[2J', sku_key: 'sku\x1b[2J', qty: 1 }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const lease = {
      pool: { connect: async () => client },
      release: async () => {},
    } as unknown as Lease;
    const rc = await productionMain(['bom', '--check'], {
      connect: async () => lease,
      io: c.io,
      wire: () => {},
    });
    expect(rc).toBe(1);
    const out = c.o.out.join('\n');
    expect(out.includes('\x1b') || out.includes('\x07')).toBe(false);
    expect(out).toContain('c1?[2J');
    expect(out).toContain('sku?[2J');
  });

  it('cert: thiếu LOT_CERT_DIR / tệp không phải phiếu → exit 1 TRƯỚC connect', async () => {
    const calls: number[] = [];
    const c = cap();
    const pdf = write('a.pdf', '%PDF-1.4 x');
    const argv = ['cert', '--lot', 'LOT-1', '--file', pdf, '--cert-no', 'KN', '--by', 'A'];
    expect(await productionMain(argv, { env: {}, connect: noConnect(calls), io: c.io })).toBe(1);
    expect(c.text()).toContain('chưa cấu hình LOT_CERT_DIR');
    const bad = write('x.pdf', 'khong phai pdf');
    const argv2 = ['cert', '--lot', 'LOT-1', '--file', bad, '--cert-no', 'KN', '--by', 'A'];
    expect(
      await productionMain(argv2, {
        env: { LOT_CERT_DIR: TMP },
        connect: noConnect(calls),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.text()).toContain('magic bytes');
    expect(calls).toEqual([]);
  });

  it('plan-add: qty ≤ 0 hoặc due < start → exit 1 TRƯỚC connect', async () => {
    const calls: number[] = [];
    const c = cap();
    for (const [qty, start, due] of [
      ['0', '2026-10-01', '2026-10-02'],
      ['-5', '2026-10-01', '2026-10-02'],
      ['5', '2026-10-02', '2026-10-01'],
    ] as const) {
      const argv = [
        'plan-add',
        '--code',
        'KH-1',
        '--sku',
        's',
        '--qty',
        qty,
        '--start',
        start,
        '--due',
        due,
        '--by',
        'A',
      ];
      expect(await productionMain(argv, { connect: noConnect(calls), io: c.io })).toBe(1);
    }
    expect(c.text()).toContain('--qty phải > 0 và --due ≥ --start — không ghi.');
    expect(calls).toEqual([]);
  });
});
