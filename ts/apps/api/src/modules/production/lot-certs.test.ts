import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { REPO_ROOT } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CertError,
  certDir,
  DocError,
  MAX_BYTES,
  record,
  sniff,
  storeOriginal,
} from './lot-certs.js';

// Dịch phần không DB của tests/test_contract_c03_lot_certs.py (kho ngoài repo, magic bytes) +
// `doc_intake.store_original` (bất biến, không ghi đè). Phần DB: production.db.test.ts.

const TMP = mkdtempSync(join(tmpdir(), 'lotcert-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const f = (name: string, data: Buffer | string) => {
  const p = join(TMP, name);
  writeFileSync(p, data);
  return p;
};
const PDF = Buffer.from('%PDF-1.4 phieu kiem nghiem gia');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('anh phieu')]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('jpg')]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('kho phiếu LOT_CERT_DIR', () => {
  it('chưa cấu hình / trong repo → từ chối; ngoài repo → đường dẫn đã resolve', () => {
    expect(() => certDir({})).toThrow(/chưa cấu hình/);
    expect(() => certDir({ LOT_CERT_DIR: '  ' })).toThrow(/chưa cấu hình/);
    expect(() => certDir({ LOT_CERT_DIR: join(REPO_ROOT, 'data', 'x') })).toThrow(/trong repo/);
    expect(() => certDir({ LOT_CERT_DIR: REPO_ROOT })).toThrow(/trong repo/);
    expect(() => certDir({ LOT_CERT_DIR: join(REPO_ROOT, 'data', '..', 'ts') })).toThrow(
      /trong repo/,
    );
    expect(resolve(certDir({ LOT_CERT_DIR: TMP })).toLowerCase()).toBe(resolve(TMP).toLowerCase());
  });
});

describe('sniff (magic bytes, không theo đuôi)', () => {
  it('PDF/PNG/JPG theo nội dung; đuôi sai vẫn nhận', () => {
    expect(sniff(f('a.pdf', PDF))).toBe('pdf');
    expect(sniff(f('b.bin', PNG))).toBe('png');
    expect(sniff(f('c.pdf', JPG))).toBe('jpg');
  });
  it('rỗng / quá lớn / loại lạ / không phải tệp thường → CertError', () => {
    expect(() => sniff(f('e.pdf', ''))).toThrow(/rỗng/);
    expect(() => sniff(f('x.pdf', 'khong phai pdf'))).toThrow(/magic/);
    const big = f('big.pdf', PDF);
    truncateSync(big, MAX_BYTES + 1);
    expect(() => sniff(big)).toThrow(/vượt 20 MB/);
    const dir = join(TMP, 'dir.pdf');
    mkdirSync(dir, { recursive: true });
    expect(() => sniff(dir)).toThrow(/không phải tệp thường/);
    expect(() => sniff(join(TMP, 'nope.pdf'))).toThrow(CertError);
  });
});

describe('store_original (bất biến, không ghi đè)', () => {
  it('ghi theo hash, lần 2 = đã có, đích lệch hash → DocError không ghi đè', () => {
    const store = join(TMP, 'kho');
    const p = f('s.pdf', PDF);
    const h = sha(PDF);
    expect(storeOriginal(p, h, store)).toBe(true);
    expect(storeOriginal(p, h, store)).toBe(false);
    expect(readFileSync(join(store, h))).toEqual(PDF);
    writeFileSync(join(store, h), 'sua');
    expect(() => storeOriginal(p, h, store)).toThrow(DocError);
    expect(readFileSync(join(store, h), 'utf8')).toBe('sua');
    // hash khai ≠ nội dung (tệp đổi giữa chừng) → DocError, không để lại tệp tạm
    const other = 'a'.repeat(64);
    expect(() => storeOriginal(p, other, store)).toThrow(/đổi trong lúc/);
    expect(() => storeOriginal(p, 'xyz', store)).toThrow(RangeError);
  });
});

describe('record: lỗi tệp/tham số TRƯỚC mọi ghi DB', () => {
  const noDb = {
    query: () => {
      throw new Error('không được chạm DB');
    },
  } as unknown as Db;
  it.each([['  '], ['x'.repeat(65)], [null]])('cert_no %j → CertError', async (no) => {
    await expect(record(noDb, 'LOT-1', f('a.pdf', PDF), no, 'A', { store: TMP })).rejects.toThrow(
      '--cert-no rỗng hoặc > 64 ký tự',
    );
  });
  it('tệp sai loại / rỗng → CertError, không chạm DB', async () => {
    await expect(
      record(noDb, 'LOT-1', f('x2.pdf', 'khong'), 'KN', 'A', { store: TMP }),
    ).rejects.toThrow(/magic/);
    await expect(record(noDb, 'LOT-1', f('e2.pdf', ''), 'KN', 'A', { store: TMP })).rejects.toThrow(
      /rỗng/,
    );
  });
});
