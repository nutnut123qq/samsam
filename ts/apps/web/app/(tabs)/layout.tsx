import Link from 'next/link';
import type { ReactNode } from 'react';
import { getMe } from '../../lib/session';
import { navFor } from '../../lib/tabs';
import { Notice } from '../_ui/notice';

// Khung chung các trang tab: thanh điều hướng = tab được phép theo vai trò (GET /me), danh tính
// đăng nhập, đăng xuất. KHÔNG chuyển hướng ở đây (layout không biết trang hiện tại) — mỗi trang tự
// gọi `requireTab` (401 → làm mới phiên rồi quay lại đúng trang).
export default async function TabsLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  return (
    <>
      <header className="topbar">
        <strong>Sâm Sâm</strong>
        <nav aria-label="Các tab">
          {me.ok &&
            navFor(me.data.tabs).map((r) => (
              <Link key={r.href} href={r.href}>
                {r.tab}
              </Link>
            ))}
        </nav>
        {me.ok && (
          <span className="who">
            Đăng nhập: <b>{me.data.username}</b> — vai trò{' '}
            <code>{me.data.role ?? '(chưa có)'}</code>
          </span>
        )}
        <form action="/api/auth/logout" method="post">
          <button type="submit">Đăng xuất</button>
        </form>
      </header>
      <main>
        {me.ok && !me.data.tabs.length ? (
          <Notice level="error">
            Vai trò `{me.data.role ?? '(chưa có)'}` chưa được cấp tab nào.
          </Notice>
        ) : (
          children
        )}
      </main>
    </>
  );
}
