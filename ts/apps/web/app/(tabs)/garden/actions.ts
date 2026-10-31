'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { field, type Outcome, outcomeNotes } from '../../../lib/outcome';
import { PERSON_COOKIE, withPerson } from '../../../lib/person';
import { apiAction } from '../../../lib/session';
import type { Notes } from '../../_ui/action-form';

/** "Ghi nhật ký": ghi bằng phiên login Postgres riêng của người (mở ở tab Duyệt & Lịch). */
export async function addGardenLog(_prev: Notes, form: FormData): Promise<Notes> {
  const r = await apiAction<Outcome>('/garden/logs', {
    method: 'POST',
    body: {
      plot: field(form, 'plot'),
      activity: field(form, 'activity'),
      activityFree: field(form, 'activityFree'),
      date: field(form, 'date'),
      detail: field(form, 'detail'),
    },
    fetchImpl: withPerson((await cookies()).get(PERSON_COOKIE)?.value),
  });
  if (r.ok && r.data.ok) revalidatePath('/garden');
  return outcomeNotes(r, 'error');
}
