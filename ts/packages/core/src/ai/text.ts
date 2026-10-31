import { CASEFOLD_EXTRA, COMBINING_CLASS } from './unicode-tables.js';

// Hàm chữ khớp Python 3.12 (bảng sinh từ unicodedata 15.0 — unicode-tables.ts).

const COMBINING_G = new RegExp(`[${COMBINING_CLASS}]`, 'gu');
const COMBINING_1 = new RegExp(`^[${COMBINING_CLASS}]$`, 'u');

/** Python `unicodedata.combining(c) != 0` cho 1 ký tự. */
export function isCombining(ch: string): boolean {
  return COMBINING_1.test(ch);
}

/** Python `s.casefold()` (theo từng mã — casefold không phụ thuộc ngữ cảnh). */
export function casefold(s: string): string {
  let out = '';
  for (const ch of s) out += CASEFOLD_EXTRA[ch.codePointAt(0) as number] ?? ch.toLowerCase();
  return out;
}

/** `pipelines/llm_gateway._strip_accents`: NFD, đ→d, Đ→D, bỏ dấu kết hợp. */
export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(COMBINING_G, '');
}

/** Python `str.isalpha()` cho ít nhất 1 ký tự (any(c.isalpha())). */
export function hasAlpha(s: string): boolean {
  return /\p{L}/u.test(s);
}
