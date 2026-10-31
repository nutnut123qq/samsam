import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Service } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { CsvReader } from '@samsam/core/ops/py-csv';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { catalog } from '@samsam/core/rollout/rollout';
import ExcelJS from 'exceljs';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketCsvMain } from './market.command.js';
import {
  CHANNELS,
  FIELDS,
  findAlerts,
  KINDS,
  loadMapping,
  type Mapping,
  mapSku,
  type Row,
  readExport,
  type Skus,
} from './market-csv.js';
import { MAX_COLS, MAX_ROWS } from './table.js';

// Dịch phần thuần + CLI không DB của tests/test_market_csv.py (parser/ánh xạ/đối chiếu/argparse) và
// cổng loader (tests/test_v15_p12_policies.py `_enter` market_csv). Fixture CSV = dữ liệu TỔNG HỢP
// trong tests/fixtures/market (tên/SĐT/địa chỉ giả rõ ràng).

const FIX = (n: string) => repoPath('tests', 'fixtures', 'market', n);
const LISTING = FIX('fixture_shopee_listing.csv');
const LISTING_FIXED = FIX('fixture_shopee_listing_fixed.csv');
const ADS = FIX('fixture_shopee_ads.csv');
const ORDER = FIX('fixture_shopee_order.csv');
const MISSING = FIX('fixture_shopee_listing_missing_col.csv');
const LISTING_KM = FIX('fixture_shopee_listing_km.csv');
const PII = [
  'NGUOI MUA GIA',
  'NGUOI NHAN GIA',
  'nguoimuagia',
  '0900000000',
  '0900000001',
  'DUONG GIA LAP',
  'GHI CHU GIA',
  'FAKEORDER',
];
const LISTING_HDR = 'Mã sản phẩm,Tên sản phẩm,SKU phân loại,Giá,Kho hàng,Trạng thái';
const MAP = loadMapping()[0] as Mapping;
const TMP = mkdtempSync(join(tmpdir(), 'market-csv-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const write = (name: string, data: string | Buffer): string => {
  const p = join(TMP, `${n++}-${name}`);
  writeFileSync(p, data);
  return p;
};
const read = (p: string, kind = 'listing', channel = 'shopee') => readExport(p, channel, kind, MAP);

describe('mapping', () => {
  it('doc + sanity: field ⊂ FIELDS, 1 header 1 nhóm, order có cancel_status + drop PII', () => {
    expect(String(MAP._doc)).toContain('chưa xác minh với file thật');
    for (const ch of CHANNELS) {
      const m = MAP[ch] as Record<string, Record<string, unknown>>;
      for (const kind of KINDS) {
        const spec = m[kind] as {
          required: Record<string, string>;
          optional?: Record<string, string>;
          drop?: string[];
        };
        const fields = new Set([
          ...Object.keys(spec.required),
          ...Object.keys(spec.optional ?? {}),
        ]);
        for (const f of fields)
          expect((FIELDS as readonly string[]).includes(f), `${ch}/${kind}/${f}`).toBe(true);
        expect(Object.keys(spec.required).filter((f) => f in (spec.optional ?? {}))).toEqual([]);
        const heads = [
          ...Object.values(spec.required),
          ...Object.values(spec.optional ?? {}),
          ...(spec.drop ?? []),
        ];
        expect(new Set(heads).size, `${ch}/${kind}`).toBe(heads.length);
      }
      const order = m.order as {
        required: Record<string, string>;
        cancel_status: string[];
        drop: string[];
      };
      expect('order_id' in order.required && order.cancel_status.length > 0).toBe(true);
      expect(order.drop.length).toBeGreaterThanOrEqual(5);
      expect((m.listing as { inactive_status: string[] }).inactive_status.length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('parser thuần (read_export)', () => {
  it('fixture: số dòng, giá VND nhóm nghìn, row_no theo file, đúng tập field', async () => {
    for (const [p, kind, cnt] of [
      [LISTING, 'listing', 5],
      [LISTING_FIXED, 'listing', 5],
      [ADS, 'ads', 3],
      [ORDER, 'order', 4],
    ] as const) {
      const [rows, errs, sha] = await read(p, kind);
      expect([errs, rows.length], p).toEqual([[], cnt]);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
    const [rows] = await read(LISTING);
    const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    expect(by['24325987926']?.price).toBe(482900); // "482.900"
    expect(by['27325048614']?.price).toBe(745000); // "745.000 ₫"
    expect(by['54916394790']?.price).toBe(745000); // "745,000"
    expect(by['54916394790']?.seller_sku).toBe('mat-ong-sam-120ml-1hu');
    expect(by['27357883504']?.seller_sku).toBeNull();
    expect(rows.map((r) => r.row_no)).toEqual([2, 3, 4, 5, 6]);
    const want = ['row_no', ...FIELDS.filter((f) => f !== 'order_id')].sort();
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(want);
  });

  it('thiếu cột bắt buộc → 1 lỗi nêu tên cột', async () => {
    const [rows, errs] = await read(MISSING);
    expect(rows).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('thiếu cột bắt buộc');
    expect(errs[0]).toContain("'Giá'");
  });

  it('cột lạ / header trùng → lỗi, không in giá trị ô', async () => {
    let [rows, errs] = await read(
      write('x.csv', `${LISTING_HDR},Email người mua\n1,a,,100,1,Đang hoạt động,a@b.c\n`),
    );
    expect(rows).toEqual([]);
    expect(errs.some((e) => e.includes("cột lạ 'Email người mua'"))).toBe(true);
    expect(errs.some((e) => e.includes('a@b.c'))).toBe(false);
    [rows, errs] = await read(
      write('d.csv', `${LISTING_HDR},Giá\n1,a,,100,1,Đang hoạt động,100\n`),
    );
    expect(rows).toEqual([]);
    expect(errs.some((e) => e.includes("header trùng: 'Giá'"))).toBe(true);
  });

  it('rỗng / chỉ khoảng trắng / chỉ header / đuôi lạ / không phải UTF-8 → lỗi; BOM + CRLF → đọc đúng', async () => {
    const cases: [string, Buffer][] = [
      ['e.csv', Buffer.alloc(0)],
      ['w.csv', Buffer.from('  \r\n\n')],
      ['h.csv', Buffer.from(`${LISTING_HDR}\n`)],
      ['x.txt', Buffer.from(`${LISTING_HDR}\n1,a,,1,1,b\n`)],
      [
        'b.csv',
        Buffer.concat([Buffer.from(`${LISTING_HDR}\n1,a,,1,1,`), Buffer.from([0xff, 0xfe, 0x0a])]),
      ],
    ];
    const got: Record<string, string[]> = {};
    for (const [name, data] of cases) {
      const [rows, errs] = await read(write(name, data));
      expect(rows, name).toEqual([]);
      expect(errs.length, name).toBeGreaterThan(0);
      got[name] = errs;
    }
    expect(got['x.txt']?.[0]).toContain('không hỗ trợ');
    expect(got['b.csv']?.[0]).toContain('không phải UTF-8');
    expect(got['h.csv']?.[0]).toContain('chỉ có header');
    const p = write(
      'bom.csv',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(`${LISTING_HDR}\r\n1,a,,100,1,X\r\n\r\n`),
      ]),
    );
    const [rows, errs] = await read(p);
    expect(errs).toEqual([]);
    expect(rows.map((r) => r.item_id)).toEqual(['1']);
  });

  it.each([
    'abc',
    '-5',
    '12,5',
    '1.234,50',
    '1.23.456',
    '99999999999999999999',
    '9'.repeat(5000),
    '١٢٣',
  ])('số sai dạng %# → lỗi chỉ nêu dòng + field, không giá trị', async (bad) => {
    const [rows, errs] = await read(
      write('p.csv', `${LISTING_HDR}\n1,a,,100,1,X\n2,b,,"${bad}",1,X\n`),
    );
    expect(rows).toEqual([]);
    expect(errs).toEqual(["dòng 3: field 'price' không phải số nguyên ≥ 0 hợp lệ"]);
  });

  it('lỗi header không bao giờ in PII (file thiếu header / header lạ có SĐT / escape terminal)', async () => {
    const lines = readFileSync(ORDER, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
    let [rows, errs] = await read(write('nohdr.csv', `${lines.join('\n')}\n`), 'order');
    expect(rows).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('không khớp header');
    for (const s of PII) expect(errs.join('\n')).not.toContain(s);
    [rows, errs] = await read(
      write('odd.csv', `${LISTING_HDR},Liên hệ 0900000000,\x1b[31mX\n1,a,,1,1,X,,\n`),
    );
    const joined = errs.join('\n');
    expect(rows).toEqual([]);
    expect(joined).not.toContain('0900000000');
    expect(joined).not.toContain('\x1b');
    expect(joined).toContain("cột lạ 'Liên hệ ***'");
  });

  it('dòng thiếu cả item_id lẫn seller_sku → lỗi', async () => {
    const [rows, errs] = await read(write('n.csv', `${LISTING_HDR}\n,a,,100,1,X\n`));
    expect(rows).toEqual([]);
    expect(errs).toEqual(['dòng 2: thiếu cả item_id lẫn seller_sku']);
  });

  it('order: bỏ cột PII, mã đơn → hash 16 hex (không giữ mã gốc)', async () => {
    const [rows, errs] = await read(ORDER, 'order');
    expect(errs).toEqual([]);
    const dumped = JSON.stringify(rows);
    for (const s of PII) expect(dumped).not.toContain(s);
    const hashes = rows.map((r) => r.order_id_hash as string);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).not.toBe(hashes[2]); // 2 dòng cùng 1 đơn
    for (const r of rows) expect('order_id' in r).toBe(false);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(['Hoàn thành', 'Đã hủy', 'Đang giao']),
    );
  });

  it('tiktok listing parse', async () => {
    const spec = (
      MAP.tiktok as Record<
        string,
        { required: Record<string, string>; optional: Record<string, string> }
      >
    ).listing as { required: Record<string, string>; optional: Record<string, string> };
    const hdr = [
      ...['item_id', 'title', 'price', 'status'].map((f) => spec.required[f]),
      spec.optional.seller_sku,
    ];
    const [rows, errs] = await read(
      write('t.csv', `${hdr.join(',')}\n1729,Savina,159000,Live,savina-12v\n`),
      'listing',
      'tiktok',
    );
    expect(errs).toEqual([]);
    expect(rows[0]?.seller_sku).toBe('savina-12v');
    expect(rows[0]?.price).toBe(159000);
  });

  it('trần dòng/cột CSV áp TRONG lúc duyệt (dòng trống cũng đếm; ô rỗng thừa cuối dòng bỏ qua)', async () => {
    const dataRow = '1,a,,100,1,X\n';
    let [rows, errs] = await read(
      write('blank.csv', `${LISTING_HDR}\n${'\n'.repeat(MAX_ROWS)}${dataRow}`),
    );
    expect(rows).toEqual([]);
    expect(errs).toEqual([`file > ${MAX_ROWS} dòng — tách file`]);
    [rows, errs] = await read(
      write('edge.csv', `${LISTING_HDR}\n${'\n'.repeat(MAX_ROWS - 2)}${dataRow}`),
    );
    expect(errs).toEqual([]);
    expect(rows[0]?.row_no).toBe(MAX_ROWS);
    [rows, errs] = await read(
      write('wide.csv', `${LISTING_HDR}\n${dataRow.trim()}${','.repeat(MAX_COLS)}z\n`),
    );
    expect(rows).toEqual([]);
    expect(errs).toEqual([`dòng 2: có ô ngoài ${MAX_COLS} cột`]);
    [rows, errs] = await read(
      write('wide_e.csv', `${LISTING_HDR}\n${dataRow.trim()}${','.repeat(MAX_COLS * 2)}\n`),
    );
    expect(errs).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- XLSX (exceljs)

async function xlsx(
  name: string,
  rows: unknown[][],
  extra?: (ws: ExcelJS.Worksheet) => void,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet');
  for (const r of rows) ws.addRow(r);
  extra?.(ws);
  const p = write(name, Buffer.from(await wb.xlsx.writeBuffer()));
  return p;
}
const ADS_HDR = ['Mã sản phẩm', 'Tên quảng cáo', 'Chi phí'];

describe('XLSX', () => {
  it('cùng dòng như CSV (ô toàn chữ số → số thật như Excel)', async () => {
    for (const [p, kind] of [
      [LISTING, 'listing'],
      [ADS, 'ads'],
      [ORDER, 'order'],
    ] as const) {
      // Python `csv.reader(text.splitlines())` (utf-8-sig) — CsvReader cùng ngữ nghĩa
      const text = new TextDecoder('utf-8').decode(readFileSync(p)); // bỏ BOM như utf-8-sig
      const cells = [...new CsvReader(text)]
        .filter((r) => r.length)
        .map((r) => r.map((c) => (/^[0-9]+$/.test(c) ? Number(c) : c || null)));
      const x = await xlsx(`${kind}.xlsx`, cells);
      const [a, ea] = await read(p, kind);
      const [b, eb] = await read(x, kind);
      expect([ea, eb], p).toEqual([[], []]);
      expect(b, p).toEqual(a);
    }
  });

  it('ô số thực: nguyên → đúng số; có phần lẻ → lỗi nêu dòng (không ×1000 câm)', async () => {
    const hdr = LISTING_HDR.split(',');
    let [rows, errs] = await read(await xlsx('ok.xlsx', [hdr, [1, 'a', null, 482900.0, 1.0, 'X']]));
    expect(errs).toEqual([]);
    expect([rows[0]?.price, rows[0]?.stock]).toEqual([482900, 1]);
    for (const bad of [12.345, 1.234, 250.125, 482.9]) {
      [rows, errs] = await read(
        await xlsx('p.xlsx', [hdr, [1, 'a', null, 100, 1, 'X'], [2, 'b', null, bad, 1, 'X']]),
      );
      expect(rows, String(bad)).toEqual([]);
      expect(errs, String(bad)).toEqual(["dòng 3: field 'price' không phải số nguyên ≥ 0 hợp lệ"]);
    }
    [rows, errs] = await read(
      await xlsx('ads.xlsx', [ADS_HDR, ['24825885894', 'QC', 250.125]]),
      'ads',
    );
    expect(rows).toEqual([]);
    expect(errs).toEqual(["dòng 2: field 'ads_spend' không phải số nguyên ≥ 0 hợp lệ"]);
  });

  it('vùng dữ liệu phóng đại (ô lạc xa) → chặn trước khi duyệt; đọc hết dòng thật (không cắt câm dòng rượu)', async () => {
    const hdr = LISTING_HDR.split(',');
    for (const [r, c] of [
      [MAX_ROWS + 5, 1],
      [3, MAX_COLS + 50],
      // TS_DIFF: Python (dimension khai thiếu A1:F2) báo "file > N dòng" / "dòng 3: có ô ngoài N cột"
      // trong lúc duyệt; exceljs bỏ qua <dimension> nên luôn đo vùng THẬT → cùng thông điệp
      // "vùng dữ liệu sheet …". Cả hai: 1 lỗi, 0 dòng nạp.
      [3, MAX_COLS + 1],
    ] as const) {
      const p = await xlsx(`far_${r}_${c}.xlsx`, [hdr, [1, 'a', null, 100, 1, 'X']], (ws) => {
        ws.getCell(r, c).value = 'x';
      });
      const [rows, errs] = await read(p);
      expect(rows, `${r},${c}`).toEqual([]);
      expect(errs, `${r},${c}`).toHaveLength(1);
      expect(errs[0]).toContain('vượt trần');
    }
    const rows3 = [
      hdr,
      ['24325987926', 'a', null, 482900, 1, 'Đang hoạt động'],
      ['54916394790', 'b', null, 745000, 1, 'Đang hoạt động'],
      ['27325048614', 'Rượu sâm (FIXTURE)', null, 745000, 1, 'Đang hoạt động'],
    ];
    const [rows, errs] = await read(await xlsx('dim.xlsx', rows3));
    expect(errs).toEqual([]);
    expect(rows.map((r) => [r.item_id, r.row_no])).toEqual([
      ['24325987926', 2],
      ['54916394790', 3],
      ['27325048614', 4],
    ]);
  });

  it('XLSX hỏng → lỗi XLSX, 0 dòng', async () => {
    const [rows, errs] = await read(write('bad.xlsx', 'không phải zip'));
    expect(rows).toEqual([]);
    expect(errs[0]).toContain('XLSX');
  });
});

// ---------------------------------------------------------------- ánh xạ + đối chiếu

const SKUS: Skus = new Map([
  ['savina-12v', { category: 'tpbvsk', xnqc_status: 'none', shopee_item_id: '27357883504' }],
  [
    'mat-ong-sam-120ml-1hu',
    { category: 'food', xnqc_status: 'none', shopee_item_id: '54916394790' },
  ],
  [
    'mat-ong-sam-120ml-2hu',
    { category: 'food', xnqc_status: 'none', shopee_item_id: '54916394790' },
  ],
  ['ruou-x', { category: 'alcohol', xnqc_status: 'none', shopee_item_id: '27325048614' }],
]);

describe('ánh xạ + đối chiếu thuần', () => {
  it('map_sku: seller_sku trước; item chung 2 biến thể → không tự chọn; TikTok không map qua item shopee', () => {
    expect(mapSku({ seller_sku: 'savina-12v', item_id: 'x' }, 'shopee', SKUS)).toEqual([
      'savina-12v',
      [],
    ]);
    expect(mapSku({ item_id: '27357883504' }, 'shopee', SKUS)).toEqual(['savina-12v', []]);
    expect(mapSku({ item_id: '54916394790' }, 'shopee', SKUS)).toEqual([
      null,
      ['mat-ong-sam-120ml-1hu', 'mat-ong-sam-120ml-2hu'],
    ]);
    expect(mapSku({ item_id: '27357883504' }, 'tiktok', SKUS)).toEqual([null, []]);
  });

  it('alcohol_listed fail-closed: status trống/lạ = đang bán; "Đã ẩn" (cả NFD) = đã ẩn; order không đối chiếu', () => {
    const base: Row = { row_no: 2, item_id: '27325048614', seller_sku: null, title: 'r', price: 1 };
    for (const [st, hit] of [
      [null, true],
      ['Đang hoạt động', true],
      ['lạ', true],
      ['Đã ẩn', false],
      ['Đã ẩn'.normalize('NFD'), false],
    ] as const) {
      const got = findAlerts([{ ...base, status: st }], 'shopee', 'listing', SKUS, new Map(), [
        'Đã ẩn',
      ]);
      expect(got.has(JSON.stringify(['alcohol_listed', '27325048614', ''])), String(st)).toBe(hit);
    }
    expect(
      findAlerts([{ ...base, status: null }], 'shopee', 'order', SKUS, new Map(), []).size,
    ).toBe(0);
  });

  it('sale_price (v5.3) tùy chọn: file cũ không cột → null, cảnh báo theo `price` không đổi', async () => {
    const m = MAP as Record<string, Record<string, { optional: Record<string, string> }>>;
    expect(m.shopee?.listing?.optional.sale_price).toBe('Giá khuyến mãi');
    expect(m.tiktok?.listing?.optional.sale_price).toBe('Sale Price');
    const [rows, errs] = await read(LISTING);
    expect(errs).toEqual([]);
    expect(rows.every((r) => r.sale_price === null)).toBe(true);
    const skus: Skus = new Map([
      ['savigout-30v', { category: 'tpbvsk', xnqc_status: 'none', shopee_item_id: '24325987926' }],
    ]);
    const got = findAlerts(
      rows,
      'shopee',
      'listing',
      skus,
      new Map([['savigout-30v', [439000, 1, null]]]),
      [],
    );
    expect(new Set([...got.values()].map((a) => a.kind))).toEqual(
      new Set(['price_mismatch', 'item_unmapped']),
    );
  });

  it('sale_price đọc số VND; ô trống → null; sai dạng → lỗi không in giá trị', async () => {
    const [rows, errs] = await read(LISTING_KM);
    expect(errs).toEqual([]);
    const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    expect([by['29007947088']?.sale_price, by['29007947088']?.price]).toEqual([1290000, 2980000]);
    expect(by['27357883504']?.sale_price).toBe(120000);
    expect(by['24325987926']?.sale_price).toBeNull();
    const km = 'Mã sản phẩm,Tên sản phẩm,SKU phân loại,Giá,Giá khuyến mãi,Kho hàng,Trạng thái';
    const [r2, e2] = await read(write('km.csv', `${km}\n1,a,,100,"12,5",1,X\n`));
    expect(r2).toEqual([]);
    expect(e2).toEqual(["dòng 2: field 'sale_price' không phải số nguyên ≥ 0 hợp lệ"]);
    expect(e2.join(' ')).not.toContain('12,5');
  });

  it('voucher_code (v5.4): tùy chọn, strip, ≤ 64 ký tự (vượt → lỗi không in mã)', async () => {
    const m = MAP as Record<string, Record<string, { optional: Record<string, string> }>>;
    expect(m.shopee?.order?.optional.voucher_code).toBe('Mã giảm giá của Shop');
    expect(m.tiktok?.order?.optional.voucher_code).toBe('Seller Voucher Code');
    expect(String(MAP._doc)).toContain('voucher_code');
    expect(String(MAP._doc)).toContain('GIẢ ĐỊNH');
    const [old, eo] = await read(ORDER, 'order');
    expect(eo).toEqual([]);
    expect(old.every((r) => r.voucher_code === null)).toBe(true);
    const hdr =
      'Mã đơn hàng,Trạng thái đơn hàng,Tên sản phẩm,SKU phân loại hàng,Số lượng,Giá ưu đãi,Mã giảm giá của Shop';
    const [rows, errs] = await read(
      write(
        'o.csv',
        `${hdr}\nO1,Hoàn thành,A,savina-12v,1,100, SSABCDEFGH23 \nO2,Hoàn thành,B,savina-12v,1,100,\n`,
      ),
      'order',
    );
    expect(errs).toEqual([]);
    expect(rows.map((r) => r.voucher_code)).toEqual(['SSABCDEFGH23', null]);
    const long = `${'V'.repeat(64)}Q`;
    const [r2, e2] = await read(
      write('o2.csv', `${hdr}\nO1,Hoàn thành,A,savina-12v,1,100,${long}\n`),
      'order',
    );
    expect(r2).toEqual([]);
    expect(e2).toEqual(["dòng 2: field 'voucher_code' dài quá 64 ký tự"]);
    expect(e2.join(' ')).not.toContain('VVVV');
    const [, e3] = await read(
      write('o3.csv', `${hdr}\nO1,Hoàn thành,A,savina-12v,1,100,${'V'.repeat(64)}\n`),
      'order',
    );
    expect(e3).toEqual([]);
  });
});

// ---------------------------------------------------------------- CLI không DB

type Io = { out: string[]; err: string[]; opened: number; queries: string[] };

/** Python `_no_connect`: connect bị gọi = lỗi; ghi lại mọi lần mở pool/câu SQL. */
function cli(io: Io, env: Env = { DATABASE_URL: 'postgresql://fake@127.0.0.1:9/x' }) {
  return {
    env,
    log: (s: string) => io.out.push(s),
    err: (s: string) => io.err.push(s),
    openService: async (_s: Service, _e: Env) => {
      io.opened++;
      return {
        query: async (sql: string) => {
          io.queries.push(sql);
          return { rows: [] };
        },
        end: async () => {},
      } as unknown as Pool;
    },
  };
}
/** Rollout/ops giả (giai đoạn `quick`) + danh mục THẬT (cổng loader kiểm mã tính năng). */
const fake = (quick: string | null) =>
  installFakeDeps({}, { quick, catalog: catalog() as { id: string }[] });
const newIo = (): Io => ({ out: [], err: [], opened: 0, queries: [] });

describe('CLI market-csv (không DB)', () => {
  beforeEach(() => {
    fake('van_hanh');
  });
  afterEach(() => resetOpsDeps());

  it.each([
    [{}],
    [{ file: 'x.csv', channel: 'lazada', kind: 'listing' }],
    [{ file: 'x.csv', channel: 'shopee', kind: 'promo' }],
    [{ file: 'x.csv', channel: 'shopee' }],
    [{ file: 'x.csv', kind: 'ads' }],
    [{ file: 'x.csv', channel: 'shopee', kind: 'ads', report: true }],
    [{ report: true, channel: 'shopee' }],
  ])('sai tham số %# → exit 2 trước connect', async (o) => {
    const io = newIo();
    expect(await marketCsvMain(o, cli(io))).toBe(2);
    expect(io.opened).toBe(0);
    expect(io.err.join('\n')).toMatch(/error:/);
  });

  it('lỗi schema/rỗng → exit 1 trước connect, không in giá trị ô (SĐT)', async () => {
    const io = newIo();
    const unknown = write('u.csv', `${LISTING_HDR},Số điện thoại\n1,a,,1,1,X,0900000000\n`);
    const empty = write('e.csv', '');
    for (const p of [MISSING, unknown, empty]) {
      expect(await marketCsvMain({ file: p, channel: 'shopee', kind: 'listing' }, cli(io))).toBe(1);
    }
    expect(io.opened).toBe(0);
    const out = io.out.join('\n');
    expect(out).toContain('không connect, không nạp gì');
    expect(out).not.toContain('0900000000');
  });

  it('mapping hỏng → [err] exit 1 trước connect', async () => {
    const io = newIo();
    const bad = write('map.json', '{');
    const rc = await marketCsvMain(
      { file: LISTING, channel: 'shopee', kind: 'listing' },
      { ...cli(io), mapFile: bad },
    );
    expect(rc).toBe(1);
    expect(io.out[0]).toMatch(/^\[err\] không đọc được mapping .*JSONDecodeError$/);
    expect(io.opened).toBe(0);
  });

  it('>30 lỗi → in 30 + "... và N lỗi khác"', async () => {
    const io = newIo();
    const body = Array.from({ length: 35 }, (_, i) => `${i + 1},a,,x,1,X`).join('\n');
    const rc = await marketCsvMain(
      { file: write('many.csv', `${LISTING_HDR}\n${body}\n`), channel: 'shopee', kind: 'listing' },
      cli(io),
    );
    expect(rc).toBe(1);
    expect(io.out.filter((l) => l.startsWith('[err] dòng'))).toHaveLength(30);
    expect(io.out).toContain('[err] ... và 5 lỗi khác');
    expect(io.out.at(-1)).toBe('[err] 35 lỗi — không connect, không nạp gì.');
  });

  it('cổng loader (HĐ 6.7): chưa cấu hình + tính năng TẮT → [rollout] exit 2, không ghi gì', async () => {
    fake('tat');
    const io = newIo();
    const rc = await marketCsvMain({ file: LISTING, channel: 'shopee', kind: 'listing' }, cli(io));
    expect(rc).toBe(2);
    expect(io.out.some((l) => l.startsWith('[rollout] loader market_csv:'))).toBe(true);
    expect(io.queries.filter((q) => !/^select 1$/.test(q))).toEqual([]);
  });

  it('--report không qua cổng loader (chỉ đọc)', async () => {
    fake('tat');
    const io = newIo();
    const rc = await marketCsvMain({ report: true }, cli(io));
    expect(rc).toBe(0);
    expect(io.out.some((l) => l.startsWith('[rollout]'))).toBe(false);
    expect(io.queries.every((q) => /^\s*select/i.test(q))).toBe(true);
  });

  it('chế độ thực thiếu LOADER_DATABASE_URL → [err] exit 2, không mở pool', async () => {
    const io = newIo();
    const rc = await marketCsvMain(
      { file: LISTING, channel: 'shopee', kind: 'listing' },
      cli(io, { AUTH_MODE: 'local', DATABASE_URL: 'postgresql://fake@127.0.0.1:9/x' }),
    );
    expect(rc).toBe(2);
    expect(io.out[0]).toContain('LOADER_DATABASE_URL');
    expect(io.opened).toBe(0);
  });

  it('dev không DSN nào → --report "[err] thiếu DATABASE_URL" exit 1; --file bị cổng chặn (không đọc được giai đoạn)', async () => {
    resetOpsDeps();
    fake(null);
    const io = newIo();
    expect(await marketCsvMain({ report: true }, cli(io, {}))).toBe(1);
    expect(io.out).toContain('[err] thiếu DATABASE_URL trong .env');
    const io2 = newIo();
    expect(
      await marketCsvMain({ file: LISTING, channel: 'shopee', kind: 'listing' }, cli(io2, {})),
    ).toBe(2);
    expect(io2.out.at(-1)).toMatch(/^\[rollout\] loader market_csv: không kết nối được DB/);
  });
});
