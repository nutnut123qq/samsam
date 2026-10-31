'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { field, type Outcome, outcomeNotes } from '../../../lib/outcome';
import { idOk, PERSON_COOKIE, personCookie, withPerson } from '../../../lib/person';
import { apiAction } from '../../../lib/session';
import type { Notes } from '../../_ui/action-form';

// Server Action tab "Duyệt & Lịch". Người quyết = danh tính đăng nhập (API lấy từ token, không gõ
// tay); mọi quyết định đi bằng phiên login Postgres riêng (cookie `samsam_pc` → header). Nút bị khóa
// mà vẫn gửi được (sửa HTML) → API kiểm lại cùng điều kiện và trả 403.

const person = async () => withPerson((await cookies()).get(PERSON_COOKIE)?.value);

/** "Mở quyền quyết định": mật khẩu Postgres CỦA NGƯỜI → API mở phiên → mã phiên vào cookie
 * httpOnly. Mật khẩu không lưu, không log. */
export async function unlock(_prev: Notes, form: FormData): Promise<Notes> {
  const r = await apiAction<{ handle: string; person: string }>('/approval/person', {
    method: 'POST',
    body: { password: field(form, 'password') },
  });
  if (!r.ok) return [['error', r.message]];
  (await cookies()).set(PERSON_COOKIE, r.data.handle, personCookie());
  revalidatePath('/review');
  return [['success', `Đã mở quyền quyết định — ${r.data.person}.`]];
}

/** "Khóa quyền": đóng phiên người ở API + xóa cookie. */
export async function lock(_prev: Notes, _form: FormData): Promise<Notes> {
  const r = await apiAction('/approval/person/close', {
    method: 'POST',
    fetchImpl: await person(),
  });
  (await cookies()).delete(PERSON_COOKIE);
  revalidatePath('/review');
  return r.ok ? [] : [['error', r.message]];
}

async function decision(path: string, body: unknown): Promise<Notes> {
  const r = await apiAction<Outcome>(path, { method: 'POST', body, fetchImpl: await person() });
  if (r.ok && r.data.ok) revalidatePath('/review');
  return outcomeNotes(r);
}

export async function decideDraft(_prev: Notes, form: FormData): Promise<Notes> {
  const id = field(form, 'id');
  if (!idOk(id)) return [['error', 'id không hợp lệ']];
  return decision(`/approval/drafts/${id}/decide`, {
    decision: field(form, 'decision'),
    note: field(form, 'note'),
  });
}

export async function scheduleDraft(_prev: Notes, form: FormData): Promise<Notes> {
  const id = field(form, 'id');
  if (!idOk(id)) return [['error', 'Chọn bài đã duyệt để xếp lịch.']];
  const date = field(form, 'date');
  if (!date) return [['error', 'Chọn ngày đăng.']];
  return decision(`/approval/drafts/${id}/schedule`, { date });
}

export async function decideQueue(_prev: Notes, form: FormData): Promise<Notes> {
  const id = field(form, 'id');
  if (!idOk(id)) return [['error', 'id không hợp lệ']];
  return decision(`/approval/queue/${id}/decide`, {
    decision: field(form, 'decision'),
    note: field(form, 'note'),
  });
}
