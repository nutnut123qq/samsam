import { readFileSync } from 'node:fs';
import { PyFloat, parsePyJson, pyFloatStr } from '@samsam/core/ops/py-json';

// Tiện ích test nhóm fin_cash: fixture golden đọc bằng `parsePyJson` (giữ phân biệt int/float như
// `json.loads` của Python — đầu vào cấu hình/giả định kiểm `isinstance(v, int)`).

export type J = Record<string, unknown>;

/** Fixture `__fixtures__/<tên>` (PyFloat cho số viết dạng thực). */
export const fixture = (name: string): J =>
  parsePyJson(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as J;

/** PyFloat → number (so khớp đầu ra). */
export function unPy(v: unknown): unknown {
  if (v instanceof PyFloat) return v.v;
  if (Array.isArray(v)) return v.map(unPy);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unPy(x)]));
  }
  return v;
}

/** Sao sâu giữ PyFloat (bất biến — dùng chung được). */
export function clone<T>(v: T): T {
  if (v instanceof PyFloat || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
}

/** Chữ JSON giữ dạng float (`1.0`) như `json.dumps` của Python. */
export function dumpPy(v: unknown): string {
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (Array.isArray(v)) return `[${v.map(dumpPy).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${dumpPy(x)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(v);
}
