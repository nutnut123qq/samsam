import type { Db } from '@samsam/core/ops/deps';
import { isPrintable } from '@samsam/core/ops/py';
import { pyStrip } from '@samsam/core/security/py';

// Tiện ích chung của nhóm sx_docs (doc_intake / sx_label / sx_tracuu / product_dossiers).

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** Kết nối mượn: `release` trả lại (pool riêng → end). */
export type DbLease = { db: Db; release: () => Promise<void> };

/** Lỗi hệ thống tệp của Node (Python OSError) — có `syscall`. */
export const isFsError = (e: unknown): boolean =>
  e instanceof Error && typeof (e as { syscall?: unknown }).syscall === 'string';

/** Python `Path(p).suffix` (3.12): phần sau dấu chấm cuối khi 0 < i < len-1. */
export function pySuffix(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 && i < base.length - 1 ? base.slice(i) : '';
}

/** Python `Path(p).name`. */
export const pyName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

/** Giá trị code point của 1 chữ số thập phân Unicode (Nd luôn thành dãy 10 liên tiếp từ 0). */
function digitValue(c: number): number {
  let k = 0;
  while (k < 60 && /\p{Nd}/u.test(String.fromCodePoint(c - k - 1))) k++;
  return k % 10;
}

/** Python `int(s)` cho chuỗi CHỈ gồm chữ số `\d` (Unicode Nd). */
export function ndInt(s: string): number {
  let v = 0;
  for (const ch of s) v = v * 10 + digitValue(ch.codePointAt(0) as number);
  return v;
}

/** Python `datetime.date(y, m, d)` hợp lệ? */
export function validDate(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

export const isoDate = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Python `"".join(c for c in s if c.isprintable())`. */
export const printableOnly = (s: string): string =>
  Array.from(s)
    .filter((c) => isPrintable(c))
    .join('');

export { pyStrip };
