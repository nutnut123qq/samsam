import { redirect } from 'next/navigation';
import { getMe, refreshUrl } from '../lib/session';
import { homeFor } from '../lib/tabs';
import { Notice } from './_ui/notice';

// Trang gốc: chuyển tới tab đầu tiên vai trò được xem (thứ tự tab chuẩn); phiên hết hạn → làm mới.
export default async function Home() {
  const me = await getMe();
  if (!me.ok && me.status === 401) redirect(refreshUrl('/'));
  if (!me.ok) {
    return (
      <main>
        <Notice level="error">{me.message}</Notice>
      </main>
    );
  }
  const home = homeFor(me.data.tabs);
  if (home) redirect(home);
  return (
    <main>
      <Notice level="error">Vai trò `{me.data.role ?? '(chưa có)'}` chưa được cấp tab nào.</Notice>
      <form action="/api/auth/logout" method="post">
        <button type="submit">Đăng xuất</button>
      </form>
    </main>
  );
}
