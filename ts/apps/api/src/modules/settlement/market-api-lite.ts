import { isPrintable } from '@samsam/core/ops/py';
import { isDict } from '@samsam/core/ops/py-json';
import { cpHead, cpLen, pyStrip } from '@samsam/core/security/py';

// Phần `ingest/market_api.py` mà `settlement_api` dùng (lỗi, hằng endpoint quyết toán, phân trang,
// kiểm field phản hồi). Transport/ký/refresh/thử lại/allowlist của market_api KHÔNG ở đây — caller
// (lệnh `market-api --kind settlement` của nhóm market) truyền hàm `call` đã ký sẵn.
// Giá trị phản hồi theo `parsePy` của nhóm market: số thực → `PyFloat`, số nguyên ngoài vùng an toàn →
// bigint (giữ kiểu int/float như Python); phản hồi `JSON.parse` thường (test) cũng nhận.
// shortcut: bản sao hẹp (nhóm market đang port song song) — gom lớp lỗi/hằng vào một chỗ (core_requests).

/** Endpoint ngoài allowlist chỉ đọc — từ chối TRƯỚC khi request. */
export class ScopeError extends Error {
  override name = 'ScopeError';
}
/** Lỗi gọi API — message chỉ HTTP status/mã lỗi, không body/URL. */
export class ApiError extends Error {
  override name = 'ApiError';
}
/** Response sai dạng/giá trị — message chỉ nêu field, không giá trị. */
export class DataError extends Error {
  override name = 'DataError';
}

/** Lỗi "kéo dữ liệu" mà `run` bắt thành exit 1 (cả lớp cùng tên của nhóm market). */
export const isFetchError = (e: unknown): e is Error =>
  e instanceof Error && ['ApiError', 'DataError', 'ScopeError'].includes(e.name);

// Tài liệu CHÍNH THỨC (đọc 25/10/2026 — evidence/itacc_r15_remaining/NGUON_TAI_LIEU.md).
export const SP_ESCROW_LIST = '/api/v2/payment/get_escrow_list';
export const SP_ESCROW_DETAIL = '/api/v2/payment/get_escrow_detail';
export const TT_STATEMENTS = '/finance/202309/statements';
export const TT_STATEMENT_TX = '/finance/202501/statements/{statement_id}/statement_transactions';
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
export const MAX_PAGES = 50;
export const PAGE_SIZE = 100;

/** `call(method, path, params, body?, pathParams?)` → JSON phản hồi (đã kiểm HTTP/mã lỗi sàn). */
export type Call = (
  method: string,
  path: string,
  params: Record<string, unknown>,
  body?: unknown,
  pathParams?: Record<string, string> | null,
) => unknown | Promise<unknown>;

/** `_obj`: object con `key` của `d` — thiếu/sai kiểu → DataError. */
export function obj(d: unknown, key: string, where: string): Record<string, unknown> {
  const v = isDict(d) ? d[key] : undefined;
  if (!isDict(v)) throw new DataError(`${where}: thiếu object '${key}'`);
  return v;
}

/** `_list`: list object `key` (vắng/null → []); không phải list object → DataError. */
export function list(d: unknown, key: string, where: string): Record<string, unknown>[] {
  const v = isDict(d) ? d[key] : undefined;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => isDict(x))) {
    throw new DataError(`${where}: '${key}' không phải list object`);
  }
  return v as Record<string, unknown>[];
}

/**
 * `_id`: mã (int | str) → chuỗi đã strip, 1..64 ký tự in được; float (`PyFloat`)/bool → DataError.
 * TS chặt hơn: `number` ngoài vùng an toàn (JSON.parse thường đã làm mất chữ số) → DataError (`parsePy`
 * trả bigint giữ đủ chữ số → nhận).
 */
export function id(v: unknown, field: string, where: string): string {
  if (
    !(
      typeof v === 'string' ||
      typeof v === 'bigint' ||
      (typeof v === 'number' && Number.isSafeInteger(v))
    )
  ) {
    throw new DataError(`${where}: field '${field}' thiếu/sai kiểu`);
  }
  const s = pyStrip(String(v));
  if (!s || cpLen(s) > 64 || !isPrintable(s)) {
    throw new DataError(`${where}: field '${field}' không hợp lệ`);
  }
  return s;
}

/** `_str`: null/"" → null; không phải chuỗi → DataError; strip + cắt `n` code point (rỗng → null). */
export function str(v: unknown, field: string, where: string, n = 300): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new DataError(`${where}: field '${field}' sai kiểu`);
  return cpHead(pyStrip(v), n) || null;
}

/**
 * `_pages`: duyệt trang — fetch(cursor) → doc; xử lý doc (body) TRƯỚC khi tính trang kế
 * (next_of(doc)); cursor null/"" → dừng. Vượt MAX_PAGES → ApiError (không nạp nửa vời).
 */
export async function pages<C>(
  fetch: (cursor: C | null) => Promise<Record<string, unknown>>,
  nextOf: (doc: Record<string, unknown>) => C | null,
  body: (doc: Record<string, unknown>) => void,
): Promise<void> {
  let cursor: C | null = null;
  let n = 0;
  for (;;) {
    n++;
    if (n > MAX_PAGES) throw new ApiError(`vượt MAX_PAGES=${MAX_PAGES} — dừng, không nạp`);
    const doc = await fetch(cursor);
    body(doc);
    cursor = nextOf(doc);
    if (cursor === null || cursor === '') return;
  }
}
