import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/product_dossiers.golden.json' with { type: 'json' };
import * as pdo from './product-dossiers.js';
import { cap } from './sx-docs.testing.js';

// Dịch phần product_dossiers của tests/test_contract_finalize.py + test_v13_c05_media.py
// (`test_product_dossiers_map_golden_one_to_one`). Golden = `check()` Python THẬT trên các ca cố định
// (đủ / thiếu / từng lỗi cấu trúc / sổ thật của repo).

const TMP = mkdtempSync(join(tmpdir(), 'sxdocs-pdo-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
type Case = { name: string; doc: Record<string, unknown>; gold: unknown[]; res: pdo.CheckResult };
const CASES = G.cases as unknown as Case[];
const byName = (n: string) => CASES.find((c) => c.name === n) as Case;
const file = (obj: unknown, raw?: string | Buffer) => {
  const p = join(TMP, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, raw ?? JSON.stringify(obj));
  return p;
};
const main = (o: pdo.DossiersOpts) => {
  const t = cap();
  return { rc: pdo.productDossiersMain(o, t.io), ...t };
};

describe('check ↔ Python (golden)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(pdo.check(c.doc, c.gold)).toEqual(c.res);
  });
});

describe('luật', () => {
  it('sổ thật của repo: không bịa hồ sơ → BLOCKED exit 2', () => {
    const doc = JSON.parse(readFileSync(pdo.DOSSIER_FILE, 'utf8'));
    expect(doc.danh_muc_ho_so_goc).toEqual([]);
    const r = main({ check: true });
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('[blocked]');
  });

  it('đủ + khớp → exit 0; lỗi cấu trúc → exit 1; thiếu → exit 2 nêu đích danh SKU chưa gắn', () => {
    const ok = byName('complete');
    expect(ok.res.errors).toEqual([]);
    expect(main({ check: true, file: file(ok.doc), golden: file({ skus: ok.gold }) }).rc).toBe(0);
    const bad = byName('err7'); // xac_nhan_boi = agent:
    expect(bad.res.errors.some((e) => e.includes('NGƯỜI'))).toBe(true);
    expect(main({ check: true, file: file(bad.doc), golden: file({ skus: bad.gold }) }).rc).toBe(1);
    const inc = byName('incomplete');
    expect(inc.res.errors).toEqual([]);
    expect(inc.res.missing).toHaveLength(2);
    expect(inc.res.missing[1].endsWith('chưa gắn: sku-b')).toBe(true);
    const r = main({ check: true, file: file(inc.doc), golden: file({ skus: inc.gold }) });
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain(
      '[blocked] SKU golden đã gắn hồ sơ gốc: 1/2 — chưa gắn: sku-b',
    );
  });

  it('hồ sơ MẪU (mau=true) không bao giờ tính là thật', () => {
    expect(byName('err17').res.errors.some((e) => e.includes('MẪU'))).toBe(true);
    expect(byName('err17').res.dossiers).toBe(0);
  });

  it('tệp hỏng / golden sai cấu trúc → exit 1; thiếu --check → exit 2', () => {
    const g = file({ skus: [] });
    expect(main({ check: true, file: file(null, '{bad'), golden: g }).out[0]).toBe(
      '[err] không đọc được sổ/golden (JSONDecodeError)',
    );
    expect(main({ check: true, file: join(TMP, 'khong.json'), golden: g }).out[0]).toContain(
      'FileNotFoundError',
    );
    expect(main({ check: true, file: file({}), golden: file({ khac: 1 }) }).out[0]).toContain(
      'KeyError',
    );
    expect(main({ check: true, file: file({}), golden: file([1]) }).out[0]).toContain('TypeError');
    expect(main({ check: true, file: file([]), golden: g }).out[0]).toBe(
      '[err] sổ/golden sai cấu trúc',
    );
    expect(main({ check: true, file: file({}), golden: file({ skus: {} }) }).rc).toBe(1);
    expect(
      main({
        check: true,
        file: file(null, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
        golden: g,
      }).rc,
    ).toBe(1); // BOM = hỏng như Python
    expect(main({}).rc).toBe(2);
  });

  it('so_ho_so_hop_dong 14.0 / 1.4e1 (float Python) → lỗi như Python; khóa lồng cùng tên không tính', () => {
    // Python (đã chạy): `--check --file <sổ thật, 14 → 14.0>` → [err] … số nguyên ≥ 1, exit 1
    const raw = readFileSync(pdo.DOSSIER_FILE, 'utf8');
    expect(raw).toContain('"so_ho_so_hop_dong": 14,');
    for (const lit of ['14.0', '1.4e1']) {
      const f = file(null, raw.replace('"so_ho_so_hop_dong": 14,', `"so_ho_so_hop_dong": ${lit},`));
      const r = main({ check: true, file: f });
      expect(r.rc).toBe(1);
      expect(r.out[0]).toBe('[err] so_ho_so_hop_dong: phải là số nguyên ≥ 1');
      expect(r.out.at(-1)).toBe('[done] hồ sơ 0 · SKU golden 13 · đã gắn 0 · lỗi 1');
    }
    const nested = file(null, raw.replace('{', '{"khac": {"so_ho_so_hop_dong": 2.0}, '));
    expect(main({ check: true, file: nested }).rc).toBe(2);
  });

  it('sổ đối chiếu ↔ golden 1-1 (v13.4 C05): không thêm/bớt/nhân bản SKU, chưa gắn hồ sơ', () => {
    const dos = JSON.parse(readFileSync(pdo.DOSSIER_FILE, 'utf8'));
    const gold = JSON.parse(readFileSync(pdo.GOLDEN_FILE, 'utf8'));
    const gmap = new Map<string, Record<string, unknown>>(
      gold.skus.map((s: Record<string, unknown>) => [s.sku_key, s]),
    );
    const keys = dos.sku.map((r: Record<string, unknown>) => r.sku_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(gmap.size);
    expect(keys.length).toBe(dos.so_sku_golden);
    expect(new Set(keys)).toEqual(new Set(gmap.keys()));
    expect(dos.so_ho_so_hop_dong).toBe(14);
    expect(dos.so_sku_golden).not.toBe(14);
    for (const r of dos.sku) {
      expect(r.so_cong_bo).toBe(gmap.get(r.sku_key)?.receipt_no);
      expect(r.trang_thai).toBe('chua_xac_nhan');
      expect(r.ho_so_goc).toBeNull();
    }
    expect(dos.trang_thai_doi_chieu).toBe('chua_xac_nhan');
    expect(dos.blocker).toContain('Bên B');
    expect(dos.nguon.startsWith('PL01')).toBe(true);
  });
});
