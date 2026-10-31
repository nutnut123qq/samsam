import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { type ApiResult, type CallInit, callApi, type Me } from './api';
import { REFRESH_COOKIE, refreshTokens, SESSION_COOKIE, setSession } from './oidc';

// Phía server Next (Server Component / Server Action): gọi API bằng access token trong cookie.
// Quyền theo vai trò = GET /me của API (core `auth.tabsFor`) — web không tự suy; API vẫn kiểm vai
// trò ở MỌI endpoint (trang chỉ là lớp hiển thị).

type Init = Omit<CallInit, 'token'>;

/** Server Component: token trong cookie (không làm mới được — Server Component không ghi cookie). */
export async function api<T>(path: string, init: Init = {}): Promise<ApiResult<T>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return callApi<T>(path, { ...init, token });
}

/** Server Action: 401 → làm mới token (ghi cookie mới) rồi thử lại MỘT lần. */
export async function apiAction<T>(path: string, init: Init = {}): Promise<ApiResult<T>> {
  const jar = await cookies();
  const r = await callApi<T>(path, { ...init, token: jar.get(SESSION_COOKIE)?.value ?? null });
  if (r.ok || r.status !== 401) return r;
  const t = await refreshTokens(jar.get(REFRESH_COOKIE)?.value);
  if (!t) return r;
  setSession(jar, t);
  return callApi<T>(path, { ...init, token: t.access_token });
}

/** Danh tính + tab của người đang đăng nhập (1 lời gọi /me cho cả layout + trang của 1 request). */
export const getMe = cache((): Promise<ApiResult<Me>> => api<Me>('/me'));

/** Trang chuyển tới đây khi phiên hết hạn: làm mới token rồi quay lại `here`. */
export const refreshUrl = (here: string) => `/api/auth/refresh?next=${encodeURIComponent(here)}`;

/** Cổng của mỗi trang tab (vào thẳng URL cũng bị chặn): 401 → làm mới phiên; vai trò không có
 * tab → thông báo, KHÔNG gọi API của tab (như Streamlit không chạy khối code tab không được cấp). */
export async function requireTab(
  tab: string,
  here: string,
): Promise<{ me: Me } | { error: string }> {
  const r = await getMe();
  if (!r.ok) {
    if (r.status === 401) redirect(refreshUrl(here));
    return { error: r.message };
  }
  if (!r.data.tabs.includes(tab)) {
    return { error: `Vai trò \`${r.data.role ?? '(chưa có)'}\` không có tab ${tab}.` };
  }
  return { me: r.data };
}
