import { AsyncLocalStorage } from 'node:async_hooks';
import { clock } from './zalo.constants.js';

// v14.6: hạn chót TỔNG của một lượt trả lời (nhận + 30 giây) phủ cả phần GỬI (refresh token,
// chờ refresh, gửi lại). Python: contextvar `_SEND_DEADLINE`/`_SEND_LATE` do `_reply` đặt;
// TS: AsyncLocalStorage — `send` của Messenger (nhóm khác) đọc cùng hàm `left()`/`markLate()`.

type Turn = { deadline: number | null; late: string | null };
const store = new AsyncLocalStorage<Turn>();

/** Chạy `fn` với hạn chót `deadline` (giây `clock.mono`); ra khỏi `fn` = không còn hạn. */
export function withBudget<T>(deadline: number | null, fn: () => Promise<T>): Promise<T> {
  return store.run({ deadline, late: null }, fn);
}

/** Giây còn lại tới hạn chót của lượt (null = không có hạn — CLI/preflight). */
export function left(): number | null {
  const t = store.getStore();
  return t?.deadline == null ? null : t.deadline - clock.mono();
}

/** Đánh dấu bước bị bỏ vì hết ngân sách (lượt gửi gần nhất). */
export function markLate(stage: string): void {
  const t = store.getStore();
  if (t) t.late = stage;
  console.log(`[deadline] zalo: bỏ bước ${stage} — không đủ ngân sách 30 giây`);
}

/** Bước bị bỏ khi tin KHÔNG tới khách (null = không). */
export function sendLate(sent: unknown): string | null {
  return sent ? null : (store.getStore()?.late ?? null);
}

/** Python `_SEND_LATE.set(stage)` không in — Messenger dùng khi tự bỏ bước gửi. */
export function setLate(stage: string | null): void {
  const t = store.getStore();
  if (t) t.late = stage;
}
