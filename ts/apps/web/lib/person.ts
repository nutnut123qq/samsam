// Phiên "Mở quyền quyết định" (login Postgres RIÊNG của người — API `PersonSessions`): API trả mã
// phiên ngẫu nhiên, web giữ trong cookie httpOnly (trình duyệt không đọc được, không lên URL) và
// gửi kèm header `x-person-session` ở lời gọi tab Duyệt & Lịch / Nhật ký vườn. Mật khẩu Postgres
// chỉ đi qua 1 Server Action tới API, không lưu ở web.

export const PERSON_COOKIE = 'samsam_pc';
export const PERSON_HEADER = 'x-person-session';
// Khớp hạn rảnh phía API (IDLE_MS 30 phút) — cookie hết hạn thì phiên API cũng đã/ sẽ đóng.
export const PERSON_MAX_AGE_S = 30 * 60;

export const personCookie = (env: Record<string, string | undefined> = process.env) => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: PERSON_MAX_AGE_S,
});

/** fetch gắn thêm header mã phiên người (lib/api `callApi` không nhận header tùy ý → qua `fetchImpl`).
 * Không có mã → fetch nguyên bản (API coi như chưa mở quyền). */
export function withPerson(
  handle: string | null | undefined,
  f: typeof fetch = fetch,
): typeof fetch {
  if (!handle) return f;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(PERSON_HEADER, handle);
    return f(input, { ...init, headers });
  };
}

/** Mã đối tượng trong đường dẫn REST: chỉ chữ số (không chèn được `/`, `?`, `..`). */
export const idOk = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,18}$/.test(v);
