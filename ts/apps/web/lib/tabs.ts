// Điều hướng web thay 7 tab Streamlit. Tên tab = `auth.TABS` của core (API trả danh sách tab theo vai
// trò ở GET /me — web KHÔNG tự suy vai trò → tab); ở đây chỉ gán đường dẫn cho từng tab.
// Trang của tab nào làm ở web-a (4 tab đầu) hay web-b (3 tab sau) đều dùng bảng này.

export type TabRoute = { tab: string; href: string };

export const TAB_ROUTES: readonly TabRoute[] = [
  { tab: 'Chat Sâm Sâm', href: '/chat' },
  { tab: 'Content Studio', href: '/content' },
  { tab: 'Chưa trả lời', href: '/unanswered' },
  { tab: 'Leads', href: '/leads' },
  { tab: 'Báo cáo', href: '/reports' },
  { tab: 'Nhật ký vườn', href: '/garden' },
  { tab: 'Duyệt & Lịch', href: '/review' },
];

/** Mục điều hướng được phép, theo thứ tự tab chuẩn (tab lạ từ API bị bỏ). */
export function navFor(tabs: readonly string[]): TabRoute[] {
  return TAB_ROUTES.filter((r) => tabs.includes(r.tab));
}

/** Trang đầu tiên được phép; không có tab nào → null. */
export function homeFor(tabs: readonly string[]): string | null {
  return navFor(tabs)[0]?.href ?? null;
}

/** Đích chuyển hướng sau đăng nhập: chỉ đường dẫn nội bộ (chặn open redirect `//x`, `/\x`, URL). */
export function safeNext(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) {
    return '/';
  }
  // Ký tự điều khiển/khoảng trắng/`\`: trình duyệt có thể bỏ qua/đổi thành `/` rồi hiểu thành `//host`.
  const bad = Array.from(v).some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n <= 0x20 || n === 0x7f || c === '\\';
  });
  return bad ? '/' : v;
}
