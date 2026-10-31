import type { Level } from '../app/_ui/notice';
import type { ApiResult } from './api';

// Kết quả 1 thao tác (API `{ok, message, warnings?}`) → dòng thông báo theo thứ tự Streamlit: cảnh
// báo trước, rồi thành công / thất bại. Lỗi HTTP (401/403/5xx, nút bị khóa phía API) → error.

export type Outcome = { ok: boolean; message: string; warnings?: string[] };

export function outcomeNotes(
  r: ApiResult<Outcome>,
  failLevel: Level = 'warning',
): [Level, string][] {
  if (!r.ok) return [['error', r.message]];
  return [
    ...(r.data.warnings ?? []).map((w): [Level, string] => ['warning', w]),
    [r.data.ok ? 'success' : failLevel, r.data.message],
  ];
}

/** Trường chữ của form (thiếu/tệp → ''). */
export const field = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === 'string' ? v : '';
};
