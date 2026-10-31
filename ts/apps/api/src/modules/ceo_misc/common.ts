import { createPool, databaseUrl, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { dmy, vnDate } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import pg from 'pg';
import { isoDay } from '../ra_kenh/ra-kenh.js';

// Tiện ích chung nhóm ceo_misc (port `agents/ceo_audit|ceo_decisions|ceo_promo|ceo_risk`).
// Ngày VN = chuỗi 'YYYY-MM-DD' (Python `date`), thời điểm = Date (Python datetime có múi giờ).

export { cpCmp };

// Python `\d` (Unicode) — ngày chữ số Unicode lọt regex rồi trượt `date.fromisoformat` (ASCII).
const DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;
const ISO_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Python `agents.ra_kenh._iso_date(v, what)` cho chuỗi JSON/CLI → 'YYYY-MM-DD'. Sai → RangeError
 * (ValueError) cùng thông điệp. shortcut: bản sao (ra_kenh không export) — gom khi tích hợp. */
export function isoDate(v: unknown, what: string): string {
  const s = typeof v === 'string' ? pyStrip(v) : null;
  if (s === null || !DATE_RE.test(s)) throw new RangeError(`${what}: cần ngày YYYY-MM-DD`);
  const m = ISO_DAY.exec(s);
  if (!m) throw new RangeError(`Invalid isoformat string: ${pyRepr(s)}`);
  if (Number(m[1]) < 1) throw new RangeError(`year ${Number(m[1])} is out of range`);
  if (Number(m[2]) < 1 || Number(m[2]) > 12) throw new RangeError('month must be in 1..12');
  const d = isoDay(s);
  if (d === null) throw new RangeError('day is out of range for month');
  return d;
}

/** Python `_d`: ngày → 'dd/mm/YYYY'; khác (None) → '—'. */
export const dd = (x: string | null | undefined): string =>
  typeof x === 'string' && ISO_DAY.test(x) ? dmy(x) : '—';

/** Python `_vn_date(ts)`: thời điểm → ngày VN | null. */
export const vnDay = (ts: unknown): string | null =>
  ts instanceof Date && !Number.isNaN(ts.getTime()) ? vnDate(ts) : null;

/** Số ngày `a - b` (Python `(a - b).days`) cho hai ngày 'YYYY-MM-DD'. */
export const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** So tuple kiểu Python (chuỗi theo code point, số theo giá trị, False < True). */
export function tupleCmp(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    let d = 0;
    if (typeof x === 'string' && typeof y === 'string') d = cpCmp(x, y);
    else d = Number(x) - Number(y);
    if (d) return d < 0 ? -1 : 1;
  }
  return a.length - b.length;
}

/** Python `with conn.transaction():` trên kết nối có thể đang trong giao dịch → savepoint (Pool:
 * câu đơn tự commit). Lỗi → rollback về savepoint rồi ném lại. */
export async function savepoint<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) return fn();
  try {
    await db.query('savepoint ceo_misc_sp');
  } catch (e) {
    // không trong giao dịch (25P01) → chạy thẳng
    if ((e as { code?: string }).code === '25P01') return fn();
    throw e;
  }
  try {
    const r = await fn();
    await db.query('release savepoint ceo_misc_sp');
    return r;
  } catch (e) {
    await db.query('rollback to savepoint ceo_misc_sp');
    await db.query('release savepoint ceo_misc_sp');
    throw e;
  }
}

// ------------------------------------------------------------ kết nối CLI

/** Python `ingest.lead_store.connect()`: DATABASE_URL → Pool | null (thiếu DSN / host chết). */
export async function openDatabaseUrl(env: Env): Promise<pg.Pool | null> {
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
    return pool;
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
}

/** Python `auth.bind_service("job")` + `connect()`: login dịch vụ `job` (ServiceBindError nổi lên để
 * in lý do) → Pool | null (không tới được). */
export async function openJob(env: Env): Promise<pg.Pool | null> {
  const pool = await servicePool('job', env);
  try {
    await pool.query('select 1');
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

export const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';
