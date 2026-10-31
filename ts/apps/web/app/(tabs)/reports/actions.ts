'use server';

import { revalidatePath } from 'next/cache';
import { field } from '../../../lib/outcome';
import { apiAction } from '../../../lib/session';
import type { Notes } from '../../_ui/action-form';

// Tổng hợp nhiều nguồn (DB + convlog + marketing) — hạn dài hơn mặc định.
const GEN_TIMEOUT_MS = 300_000;

/** "Sinh báo cáo": API ghi `data/reports/report-*.md`; DB lỗi → bản DEGRADED (cảnh báo). */
export async function generateReport(_prev: Notes, form: FormData): Promise<Notes> {
  const r = await apiAction<{ dbOk: boolean; message: string }>('/reports/generate', {
    method: 'POST',
    body: { days: Number(field(form, 'days')) },
    timeoutMs: GEN_TIMEOUT_MS,
  });
  if (!r.ok) return [['error', r.message]];
  revalidatePath('/reports');
  return [[r.data.dbOk ? 'success' : 'warning', r.data.message]];
}
