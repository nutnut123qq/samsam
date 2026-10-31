import { parseDay } from '@samsam/core/ops/period';
import { cpCmp, PyFloat, pyFloatStr } from '@samsam/core/ops/py-json';
import { pyRepr } from '@samsam/core/security/py';

// Tiện ích khớp ngữ nghĩa Python cho nhóm kd_quote (date/json) — chỉ thứ core chưa có (CSV ở core ops/py-csv).

/** Python `sorted()` chuỗi (theo code point). */
export const pySortedStr = (xs: Iterable<string>): string[] => [...xs].sort(cpCmp);

/** Python `str(list_of_str)` → `['a', 'b']`. */
export const pyListRepr = (xs: string[]): string => `[${xs.map((x) => pyRepr(x)).join(', ')}]`;

/** Python `date.fromisoformat(v)` cho chuỗi → 'YYYY-MM-DD' | null. TS CHẶT hơn (fail-closed): chỉ
 * nhận YYYY-MM-DD và YYYYMMDD — dạng tuần ISO (`2026-W40-4`) Python nhận, TS từ chối. */
export function isoDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : v;
  return parseDay(s) === null ? null : s;
}

/** Python `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))` (số thực
 * đọc bằng `parsePyJson` giữ dạng float). shortcut: chuỗi có surrogate lẻ JS thoát `\udXXX`, Python
 * ném UnicodeEncodeError khi encode — chỉ ảnh hưởng sha ma trận hỏng, nâng khi gặp. */
export function canonical(v: unknown): string {
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${pySortedStr(Object.keys(o))
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}
