import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import { goldenMap, readInventory } from './inventory-csv.js';
import { type Io, inventoryCsvMain, type Lease } from './production.command.js';

// Dịch phần thuần + CLI không DB của tests/test_inventory_csv.py (+ test_v14_p2_service_auth.py:
// loader chạy bằng login dịch vụ `loader`). Phần DB: production.db.test.ts.

const SAMPLE = dataPath('sample_inventory.csv');
const TODAY = '2026-10-12';
const HDR = 'sku_key,kho,qty,captured_at\n';
const OK_ROW = 'savina-12v,kho-mau-da-nang,10,2026-10-09\n';
const [G] = goldenMap();
const golden = G as NonNullable<typeof G>;
const TMP = mkdtempSync(join(tmpdir(), 'invunit-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const write = (name: string, text: string | Buffer) => {
  const p = join(TMP, name);
  writeFileSync(p, text);
  return p;
};
function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  const io: Io = { out: (s) => o.out.push(s), err: (s) => o.err.push(s) };
  return { o, io, text: () => [...o.out, ...o.err].join('\n') };
}
const noLoader = (calls: number[]) => async (): Promise<Lease> => {
  calls.push(1);
  throw new Error('không được connect');
};

describe('inventory_csv (thuần)', () => {
  it('tệp mẫu hợp lệ: ≥13 dòng, ≥2 kho mẫu, thiếu ≥1 SKU golden (nhánh chưa có số tồn)', async () => {
    const [rows, errs, sha] = await readInventory(SAMPLE, golden, TODAY);
    expect(errs).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const khos = new Set(rows.map((r) => r.kho));
    expect(khos.size).toBeGreaterThanOrEqual(2);
    expect([...khos].every((k) => k.startsWith('kho-mau-'))).toBe(true);
    const skus = new Set(rows.map((r) => r.sku_key));
    expect([...skus].every((s) => golden.has(s))).toBe(true);
    expect(golden.size - skus.size).toBeGreaterThanOrEqual(1);
    expect(rows.slice(0, 2).map((r) => r.row_no)).toEqual([2, 3]);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.captured_at))).toBe(true);
  });

  it('header trùng sắp theo code point như Python sorted (ký tự ngoài BMP)', async () => {
    // Python read_inventory trên đúng header này: "dòng 1: header trùng ～, \u{1f600}".
    const p = write('dup_astral.csv', 'sku_key,kho,qty,captured_at,\u{1f600},\u{1f600},～,～\n');
    const [, errs] = await readInventory(p, golden, TODAY);
    expect(errs.at(-1)).toBe('dòng 1: header trùng ～, \u{1f600}');
  });

  it.each([
    ['empty', 'x.csv', ''],
    ['header_only', 'x.csv', HDR],
    ['unknown_col', 'x.csv', `sku_key,kho,qty,captured_at,ghi_chu\n${OK_ROW.trim()},abc\n`],
    ['missing_qty', 'x.csv', 'sku_key,kho,captured_at\nsavina-12v,kho-mau-da-nang,2026-10-09\n'],
    ['dup_header', 'x.csv', 'sku_key,kho,qty,qty,captured_at\n'],
    ['sku_unknown', 'x.csv', `${HDR}khong-co-sku,kho-mau-da-nang,1,2026-10-09\n`],
    ['kho_pii', 'x.csv', `${HDR}savina-12v,Kho Anh Nam 0905123456,1,2026-10-09\n`],
    ['qty_neg', 'x.csv', `${HDR}savina-12v,kho-a,-3,2026-10-09\n`],
    ['qty_float', 'x.csv', `${HDR}savina-12v,kho-a,1.5,2026-10-09\n`],
    ['qty_abc', 'x.csv', `${HDR}savina-12v,kho-a,abc,2026-10-09\n`],
    ['qty_blank', 'x.csv', `${HDR}savina-12v,kho-a,,2026-10-09\n`],
    ['future', 'x.csv', `${HDR}savina-12v,kho-a,1,2026-10-13\n`],
    ['date_compact', 'x.csv', `${HDR}savina-12v,kho-a,1,20261009\n`],
    ['dup_key', 'x.csv', HDR + OK_ROW + OK_ROW],
    ['txt', 'x.txt', HDR + OK_ROW],
    // cp1258 "à" = 0xE0 → không phải UTF-8
    ['not_utf8', 'x.csv', Buffer.from(`${HDR}savina-12v,kho-\xe0,1,2026-10-09\n`, 'latin1')],
  ])('biến thể lỗi %s → 0 dòng, không in SĐT', async (_k, name, text) => {
    const [rows, errs] = await readInventory(write(name, text), golden, TODAY);
    expect(rows).toEqual([]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('0905123456'))).toBe(false);
  });

  it('thiếu tệp', async () => {
    const [rows, errs, sha] = await readInventory(join(TMP, 'nope.csv'), golden, TODAY);
    expect([rows, errs.length > 0, sha]).toEqual([[], true, null]);
  });

  it('dòng tốt + dòng xấu → không nạp gì, lỗi nêu số dòng', async () => {
    const [rows, errs] = await readInventory(
      write('m.csv', `${HDR}${OK_ROW}savina-12v,kho-b,x,2026-10-09\n`),
      golden,
      TODAY,
    );
    expect(rows).toEqual([]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('dòng 3');
  });

  it('không mã nào update/delete inventory_snapshots (append-only bằng code)', () => {
    const pat = /update\s+inventory_snapshots|delete\s+from\s+inventory_snapshots/i;
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        if (f === 'node_modules' || f.startsWith('.')) return [];
        return statSync(p).isDirectory()
          ? walk(p)
          : p.endsWith('.ts') && !p.endsWith('.test.ts')
            ? [p]
            : [];
      });
    for (const p of [
      ...walk(join(root, 'apps', 'api', 'src')),
      ...walk(join(root, 'packages', 'core', 'src')),
    ]) {
      expect([p, pat.test(readFileSync(p, 'utf8'))]).toEqual([p, false]);
    }
  });
});

describe('inventory-csv CLI (không DB)', () => {
  it('tệp hỏng → exit 1, không connect, không in SĐT', async () => {
    const calls: number[] = [];
    const c = cap();
    for (const text of [
      '',
      HDR,
      `${HDR}savina-12v,Kho Anh Nam 0905123456,1,2026-10-09\n`,
      `${HDR}savina-12v,kho-a,1,2099-01-01\n`,
    ]) {
      expect(
        await inventoryCsvMain(['--file', write('bad.csv', text)], {
          connectLoader: noLoader(calls),
          io: c.io,
        }),
      ).toBe(1);
    }
    expect(
      await inventoryCsvMain(['--file', join(TMP, 'missing.csv')], {
        connectLoader: noLoader(calls),
        io: c.io,
      }),
    ).toBe(1);
    expect(calls).toEqual([]);
    expect(c.text()).toContain('không connect, không nạp gì');
    expect(c.text()).not.toContain('0905123456');
  });

  it('quá 30 lỗi → in 30 + "… và N lỗi khác"', async () => {
    const c = cap();
    const rows = Array.from({ length: 35 }, (_, i) => `khong-co-${i},kho-a,1,2026-10-09`).join(
      '\n',
    );
    expect(
      await inventoryCsvMain(['--file', write('many.csv', `${HDR}${rows}\n`)], {
        connectLoader: noLoader([]),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.o.out).toContain('[err] ... và 5 lỗi khác');
    expect(c.o.out).toContain('[err] 35 lỗi — không connect, không nạp gì.');
  });

  it.each([[[]], [['--file', 'x.csv', '--source', 'tay']], [['--file']], [['--file', 'a', 'b']]])(
    'usage %j → exit 2',
    async (argv) => {
      const c = cap();
      expect(await inventoryCsvMain(argv, { connectLoader: noLoader([]), io: c.io })).toBe(2);
      expect(c.o.err.join('\n')).toContain('error:');
    },
  );

  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2, không rơi về DATABASE_URL', async () => {
    const c = cap();
    const rc = await inventoryCsvMain(['--file', SAMPLE], {
      env: {
        NODE_ENV: 'test',
        APPROVAL_ENFORCE: '1',
        DATABASE_URL: 'postgresql://u@127.0.0.1:9/x',
      },
      io: c.io,
    });
    expect(rc).toBe(2);
    expect(c.text()).toContain('LOADER_DATABASE_URL');
  });

  it('dev thiếu DSN → [err] thiếu DATABASE_URL, exit 1; host chết → exit 1', async () => {
    const c = cap();
    expect(
      await inventoryCsvMain(['--file', SAMPLE], { env: { NODE_ENV: 'test' }, io: c.io }),
    ).toBe(1);
    expect(c.o.out).toContain('[err] thiếu DATABASE_URL trong .env');
    const d = cap();
    expect(
      await inventoryCsvMain(['--file', SAMPLE], {
        env: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' },
        io: d.io,
      }),
    ).toBe(1);
    expect(d.o.out).toContain('[err] không kết nối được Postgres: OperationalError');
  });
});
