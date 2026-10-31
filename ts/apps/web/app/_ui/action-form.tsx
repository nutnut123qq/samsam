'use client';

import { type ReactNode, useActionState } from 'react';
import { type Level, Notice } from './notice';

// Form gọi Server Action và hiện kết quả ngay dưới form (thay st.success/warning sau nút bấm của
// Streamlit). Trường/nút do trang server dựng (children) — nút submit có `name`/`value` để action biết
// nút nào được bấm (Duyệt/Từ chối). Đang chạy → khóa cả form (không bấm 2 lần ra 2 quyết định).

export type Notes = [Level, string][];
export type FormAction = (prev: Notes, form: FormData) => Promise<Notes>;

export function ActionForm({ action, children }: { action: FormAction; children: ReactNode }) {
  const [notes, run, pending] = useActionState(action, []);
  return (
    <form action={run}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
        {children}
      </fieldset>
      {notes.map(([level, text], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: danh sách thông báo tĩnh của 1 lần bấm
        <Notice key={i} level={level}>
          {text}
        </Notice>
      ))}
    </form>
  );
}
