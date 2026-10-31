import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { jobRun, type RunState } from '@samsam/core/ops/job-runs';

// Phần CLI dùng chung của nhóm intel_alert: luồng in (test thay), kết nối kiểu Python
// `lead_store.connect()` (DATABASE_URL → kết nối | null), bọc `job_run`.

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };
export type JobFn = <T>(name: string, body: (run: RunState) => Promise<T>) => Promise<T>;

/** `with job_run(name)` ghi 1 dòng `job_runs` (login job/DATABASE_URL của env). */
export const defaultJob =
  (env: Env = process.env): JobFn =>
  (name, body) =>
    jobRun(name, body, env);

/** Python list repr của số nguyên: `[1, 2]`. */
export const pyIntList = (xs: readonly (number | bigint)[]): string => `[${xs.join(', ')}]`;

/** Python `round(x, 1)`: đúng theo giá trị thập phân chính xác, hòa → số chẵn. Hòa ở 1 chữ số
 * thập phân chỉ xảy ra khi x = lẻ/4 (giá trị nhị phân chính xác). */
export function pyRound1(x: number): number {
  if (!Number.isFinite(x)) return x;
  const q = x * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    const lo = Math.floor(x * 10);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** Python `f"{x:.1f}"` (hòa → chẵn trên giá trị chính xác). */
export function pyFixed1(x: number): string {
  const r = pyRound1(x);
  const s = r.toFixed(1);
  return Object.is(r, -0) || (r === 0 && x < 0) ? `-${s.replace(/^-/, '')}` : s;
}

/** Python `f"{x:.0%}"`: x*100 (số thực) rồi làm tròn 0 chữ số (hòa → chẵn). */
export function pyPct0(x: number): string {
  const v = x * 100;
  const f = Math.floor(v);
  const d = v - f;
  const r = d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  return `${Object.is(r, -0) ? '-0' : r}%`;
}
