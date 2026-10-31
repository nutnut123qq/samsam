import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pyLoads } from '@samsam/core/ops/py-json';
import { repoPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildDiscrepancies,
  CHANNELS,
  type Doc,
  GOLDEN_FILE,
  KINDS,
  loadProblems,
  type Prices,
  type ProductInfo,
  readGolden,
  type SkuInfo,
  specOf,
  validate,
} from './golden-store.js';

// Dịch phần thuần của tests/test_golden_store.py (validate / read_golden / spec_of /
// build_discrepancies / file golden thật). Golden sinh bằng chạy hàm Python THẬT (scratchpad
// loaders_golden/gen_golden.py, DSN chết).
//
// TS_STRICTER:
//   read_golden `nan`  NaN trong JSON → "JSON hỏng" (Python nhận, luật kiểu chặn sau).
//   loadProblems       (chạy SAU validate, trước kết nối) self_declaration_ok là số 0/1 (Python qua
//                      validate vì 1 == True rồi DB lỗi cột boolean), chuỗi NUL/surrogate lẻ, giá
//                      vượt 2^53 → lỗi, không nạp.

const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/golden_store.golden.json', import.meta.url), 'utf8'),
) as {
  read_golden: Record<string, { b64: string | null; doc_none: boolean; why: string | null }>;
  validate: Record<string, { doc: string; errs: string[] }>;
  spec_of: [string | null, string | null][];
  build_discrepancies: {
    skus: SkuInfo[];
    prices: Prices;
    maps: Record<string, string>;
    products: ProductInfo[];
    out: unknown[];
  }[];
  CHANNELS: string[];
  KINDS: string[];
};

const TMP = mkdtempSync(join(tmpdir(), 'loaders-golden-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('golden_store — golden Python', () => {
  it('read_golden: mọi biến thể "không có dữ liệu" trả lý do, BOM utf-8-sig được bỏ', () => {
    const dir = join(TMP, 'rg');
    mkdirSync(join(dir, 'adir.json'), { recursive: true });
    const norm = (s: string | null) =>
      s === null ? null : s.split(dir).join('<DIR>').replaceAll('\\', '/');
    // Python JSONDecodeError/UnicodeDecodeError ≠ JS: so tới dấu ':' của phần chi tiết.
    const cut = (s: string | null) => s?.replace(/(JSON hỏng|không phải UTF-8): .*$/s, '$1: …');
    for (const [name, c] of Object.entries(G.read_golden)) {
      const p = join(dir, name === 'is_dir' ? 'adir.json' : `${name}.json`);
      if (c.b64 !== null) writeFileSync(p, Buffer.from(c.b64, 'base64'));
      const [doc, why] = readGolden(p);
      if (name === 'nan') {
        expect(doc).toBeNull(); // TS_STRICTER
        expect(why).toContain('JSON hỏng');
        continue;
      }
      expect(doc === null, name).toBe(c.doc_none);
      expect(cut(norm(why)), name).toBe(cut(c.why));
    }
  });

  it('validate: schema + R1/R2/R3 y hệt Python (float 1.0 ≠ int, 1 == True, $ của Python)', () => {
    for (const [name, c] of Object.entries(G.validate)) {
      expect(validate(pyLoads(c.doc)), name).toEqual(c.errs);
    }
  });

  it('spec_of: \\d Unicode + int(), IGNORECASE (İ/ı ~ i), \\b Unicode', () => {
    for (const [s, want] of G.spec_of) expect(specOf(s), String(s)).toBe(want);
  });

  it('build_discrepancies: đủ loại phiếu, ghi theo TỪNG nguồn, không chọn giá', () => {
    for (const c of G.build_discrepancies) {
      expect(
        buildDiscrepancies(c.skus, c.prices, new Map(Object.entries(c.maps)), c.products),
      ).toEqual(c.out);
    }
    expect(CHANNELS).toEqual(G.CHANNELS);
    expect([...KINDS]).toEqual(G.KINDS);
  });
});

// ---------------------------------------------------------------- dịch test_golden_store.py

const EXPECTED: Record<string, [string | null, string | null, string | null, (number | null)[]]> = {
  'savina-12v': ['8014/2021/ĐKSP', '2021-09-07', '27357883504', [128000, 159000, 132000]],
  'saphraton-combo-2x20v': [
    '2778/2018/ĐKSP',
    '2018-05-22',
    '28003783932',
    [469000, 698000, 480000],
  ],
  'saphraton-20v': ['2778/2018/ĐKSP', '2018-05-22', '24825885894', [236000, 299000, 250000]],
  'saphraton-40v': ['2778/2018/ĐKSP', '2018-05-22', null, [450000, null, null]],
  'saphraton-80v': ['2778/2018/ĐKSP', '2018-05-22', '29368491427', [1000000, 1490000, 1100000]],
  'savigout-30v': ['8560/2019/ĐKSP', '2019-07-02', '24325987926', [295000, 439000, 350000]],
  'sapentol-30v': ['5191/2020/ĐKSP', '2020-06-10', '27257950771', [280000, 417000, 330000]],
  'da-an-sam-30v': ['11129/2021/ĐKSP', '2021-12-29', '26857946153', [340000, 506000, 399000]],
  'mat-ong-sam-120ml-1hu': [null, null, '54916394790', [500000, 745000, 550000]],
  'mat-ong-sam-120ml-2hu': [null, null, '54916394790', [900000, 1340000, 950000]],
  'mat-ong-sam-300ml': [null, null, '29007947088', [2000000, 2980000, 2100000]],
  'ruou-sam-chai-thuy-tinh-500ml': [null, null, '27325048614', [500000, 745000, 550000]],
  'ruou-sam-binh-su-do-500ml': [null, null, '26975028961', [null, null, null]],
};
type Sku = Record<string, unknown> & { prices: Record<string, Record<string, number>> };
const sku = (key: string, prices: Record<string, unknown>, kw: Record<string, unknown> = {}) => ({
  sku_key: key,
  name: key,
  category: 'tpbvsk',
  prices: { shopee: prices },
  ...kw,
});

describe('golden_store — thuần (tests/test_golden_store.py)', () => {
  const doc = readGolden(GOLDEN_FILE)[0] as Doc;
  const skus = doc.skus as Sku[];

  it('file golden thật hợp lệ + số đếm (13 SKU, 34 giá, 15 product_id)', () => {
    expect(validate(doc)).toEqual([]);
    expect(skus).toHaveLength(13);
    expect(
      skus.reduce(
        (n, s) => n + Object.values(s.prices).reduce((m, kp) => m + Object.keys(kp).length, 0),
        0,
      ),
    ).toBe(34);
    expect(skus.reduce((n, s) => n + (s.product_ids as string[]).length, 0)).toBe(15);
    expect(
      skus.filter((s) => (s.sku_key as string).includes('ruou')).map((s) => s.category),
    ).toEqual(['alcohol', 'alcohol']);
    const honey = skus.filter((s) => (s.sku_key as string).startsWith('mat-ong'));
    expect(honey.map((s) => [s.category, s.self_declaration_ok])).toEqual([
      ['food', null],
      ['food', null],
      ['food', null],
    ]);
    const tpbvsk = skus.filter((s) => s.category === 'tpbvsk');
    expect(tpbvsk).toHaveLength(8);
    expect(tpbvsk.every((s) => s.xnqc_status === 'none')).toBe(true);
    // Mọi giá nạp chờ duyệt — file không được tự ghi người duyệt.
    expect(readFileSync(GOLDEN_FILE, 'utf8')).not.toContain('approved_by');
    expect(loadProblems(doc)).toEqual([]);
  });

  it('số liệu ghim THEO TỪNG SKU (tráo số giữa SKU vẫn bị bắt)', () => {
    const got: Record<string, unknown> = {};
    for (const s of skus) {
      expect(
        Object.keys(s.prices).every((ch) => ch === 'shopee'),
        s.sku_key as string,
      ).toBe(true);
      const sp = s.prices.shopee ?? {};
      got[s.sku_key as string] = [
        s.receipt_no,
        s.receipt_date,
        s.shopee_item_id,
        ['floor', 'list', 'promo'].map((k) => sp[k] ?? null),
      ];
    }
    expect(got).toEqual(EXPECTED);
  });

  it('file golden không chứa từ cấm', () => {
    const text = readFileSync(GOLDEN_FILE, 'utf8').toLowerCase();
    const words = readFileSync(repoPath('data', 'banned_words.txt'), 'utf8')
      .split('\n')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w && !w.startsWith('#'));
    expect(words.length).toBeGreaterThan(0);
    expect(words.filter((w) => text.includes(w))).toEqual([]);
  });

  it('3 vi phạm cài sẵn R1/R2/R3, chỉ-sàn và không-giá hợp lệ', () => {
    const errs = validate({
      skus: [
        sku('r1-x', { floor: 100000, list: 150000 }),
        sku('r2-x', { list: 200000, promo: 100000 }),
        sku('r3-x', { floor: 100000, list: 120000, promo: 90000 }),
        sku('only-floor', { floor: 450000 }),
        { sku_key: 'no-price', name: 'x', category: 'alcohol', prices: {} },
      ],
    });
    expect(errs.map((e) => / (R[123]):/.exec(e)?.[1]).sort()).toEqual(['R1', 'R2', 'R3']);
    expect(errs.some((e) => e.startsWith('r1-x/') && e.includes('R1'))).toBe(true);
    expect(errs.some((e) => e.startsWith('r3-x/') && e.includes('R3'))).toBe(true);
  });

  it('TS_STRICTER loadProblems: số ở cột boolean, NUL/surrogate lẻ, giá > 2^53', () => {
    const bad = (s: Record<string, unknown>) => loadProblems({ skus: [s] } as Doc);
    expect(bad(sku('a', {}, { self_declaration_ok: 1 }))).toHaveLength(1);
    expect(validate({ skus: [sku('a', {}, { self_declaration_ok: 1 })] })).toEqual([]);
    expect(bad(sku('a', {}, { note: 'x\0y' }))[0]).toContain('NUL/surrogate');
    expect(bad(sku('a', {}, { name: '\ud800' }))[0]).toContain('NUL/surrogate');
    expect(bad(sku('a', { list: 2 ** 60 }))[0]).toContain('2^53');
    expect(bad(sku('a', { list: 100 }, { self_declaration_ok: true }))).toEqual([]);
  });

  it('module không bao giờ ghi products', () => {
    const src = readFileSync(new URL('./golden-store.ts', import.meta.url), 'utf8');
    expect(/(update|insert into|delete from) +products/i.test(src)).toBe(false);
  });
});
