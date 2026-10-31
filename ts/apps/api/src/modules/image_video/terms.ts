import { fillerHits, findTerms } from '@samsam/core/security/guardrail';
import { isSpace, pySplit, pyStr, pyTruthy } from '@samsam/core/security/py';

// `image_studio._clean` + từ cấm mô tả nền/kịch bản (`guardrail._find_terms` + `_filler_hits` của core).

/** `_find_terms(s, terms) + _filler_hits(s, terms)` → tên cụm, thứ tự gặp (có thể trùng). */
export function termHits(text: string, terms: readonly string[]): string[] {
  return [...findTerms(text, terms), ...fillerHits(text, terms)].map((h) => h.term);
}

export const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

const CTRL = /^[\p{Cc}\p{Cf}]$/u;

/** `image_studio._clean`: NFC, bỏ ký tự điều khiển/vô hình (Cc/Cf) trừ khoảng trắng, gộp khoảng trắng
 * — chữ vẽ lên ảnh / vào prompt == chữ guardrail chấm. Không phải chuỗi → "". */
export function clean(s: unknown): string {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const c of s.normalize('NFC')) if (isSpace(c) || !CTRL.test(c)) out += c;
  return pySplit(out).join(' ');
}

/** `", ".join(dict.fromkeys(str(v.code or v.type) for v in violations)) or "?"`. */
export function codes(g: unknown): string {
  const vs = g && typeof g === 'object' ? (g as { violations?: unknown }).violations : null;
  const out: string[] = [];
  for (const v of Array.isArray(vs) ? vs : []) {
    const o = (v ?? {}) as Record<string, unknown>;
    out.push(pyStr(pyTruthy(o.code) ? o.code : (o.type ?? null)));
  }
  return uniq(out).join(', ') || '?';
}
