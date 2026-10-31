// Client REST tới API NestJS (chạy phía server Next — token Keycloak nằm trong cookie httpOnly, trình
// duyệt không cầm token). Lỗi trả về dạng giá trị, không ném: trang hiển thị thông báo thay vì
// traceback; KHÔNG đưa chi tiết kết nối/DSN/đường dẫn nội bộ ra người dùng.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export type Me = { username: string; role: string | null; tabs: string[]; enforced: boolean };

export type CallInit = {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_TIMEOUT_MS = 120_000;

/** `API_URL` (compose: http://api:3001) — chỉ http(s), bỏ `/` cuối; thiếu/sai → null (fail-closed). */
export function apiBase(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.API_URL ?? '').trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Thông điệp lỗi của Nest (`message` chuỗi hoặc mảng) → chuỗi ngắn; không có → theo mã HTTP. */
export function errorMessage(status: number, body: unknown): string {
  const m =
    typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : null;
  if (typeof m === 'string' && m) return m.slice(0, 500);
  if (Array.isArray(m) && m.every((x) => typeof x === 'string')) return m.join('; ').slice(0, 500);
  if (status === 401) return 'Phiên đăng nhập hết hạn — đăng nhập lại.';
  if (status === 403) return 'Vai trò không có quyền truy cập mục này.';
  return `API lỗi (HTTP ${status}).`;
}

export async function callApi<T>(path: string, init: CallInit = {}): Promise<ApiResult<T>> {
  const base = apiBase(init.env);
  if (!base) return { ok: false, status: 503, message: 'API chưa cấu hình (API_URL).' };
  if (!init.token) return { ok: false, status: 401, message: errorMessage(401, null) };
  const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await (init.fetchImpl ?? fetch)(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError';
    return {
      ok: false,
      status: timeout ? 504 : 502,
      message: timeout ? 'API phản hồi quá hạn — thử lại.' : 'Không kết nối được API — thử lại.',
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) return { ok: false, status: res.status, message: errorMessage(res.status, body) };
  if (body === null) return { ok: false, status: 502, message: 'API trả dữ liệu không đọc được.' };
  return { ok: true, data: body as T };
}
