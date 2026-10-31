import pg from 'pg';
import type { Db } from './deps.js';
import { SQLSTATE_BASE, SQLSTATE_CLASS } from './pg-errors.js';

// Python `with conn.transaction(): ...; conn.commit()` — nhiều câu cùng giao dịch. Pool → mượn 1
// client; client truyền vào phải RẢNH (không đang trong giao dịch của caller).

export async function withTx<T>(db: Db, fn: (c: pg.ClientBase) => Promise<T>): Promise<T> {
  const c = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    if (c !== db) (c as pg.PoolClient).release();
  }
}

// Pool đã `end()` / client đã đóng = psycopg OperationalError "the connection is closed" (Python bắt).
const CONN_MSG =
  /Connection terminated|timeout exceeded when trying to connect|connection error|Connection refused|Cannot use a pool after calling end|Client was closed and is not queryable/i;

/**
 * Python `psycopg.Error`: lỗi Postgres (SQLSTATE) HOẶC lỗi kết nối (pg ném Error thường: mã hệ thống
 * ECONNREFUSED/ETIMEDOUT…, "Connection terminated", timeout). Lỗi khác (lập trình, cổng triển khai
 * RolloutBlocked, cấu hình) KHÔNG tính — vẫn nổi lên như Python.
 */
export function isDbError(e: unknown): e is Error {
  if (e instanceof pg.DatabaseError) return true;
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return (typeof code === 'string' && /^E[A-Z]+$/.test(code)) || CONN_MSG.test(e.message);
}

/** Thông điệp lỗi function DB (raise tiếng Việt) — không kèm context/SQL/detail (Python `_db_msg`). */
export function dbMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).trim();
}

// Mã SQLSTATE (5 ký tự, không bắt đầu bằng 'E' như mã hệ thống ECONNRESET/EPIPE của Node).
const SQLSTATE_RE = /^[0-9A-DF-Z][0-9A-Z]{4}$/;

/**
 * Python `type(e).__name__` của lỗi psycopg khi CHẠY câu: SQLSTATE → lớp riêng (`errors.lookup`),
 * mã lạ → lớp gốc (`get_base_exception` theo 2 rồi 1 ký tự đầu, không có → DatabaseError); lỗi không
 * mang SQLSTATE (mất kết nối giữa chừng) → OperationalError. Chỉ tên — không thông điệp/DSN.
 */
export function pgErrName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !SQLSTATE_RE.test(code)) return 'OperationalError';
  return (
    SQLSTATE_CLASS[code] ??
    SQLSTATE_BASE[code.slice(0, 2)] ??
    SQLSTATE_BASE[code.slice(0, 1)] ??
    'DatabaseError'
  );
}

/** Lỗi khi MỞ kết nối: psycopg `connect()` chỉ ném OperationalError (hết `connect_timeout` →
 * ConnectionTimeout), kể cả lỗi phía server như 28P01 sai mật khẩu / 3D000 không có DB. */
export function connErrName(e: unknown): string {
  return !(e instanceof pg.DatabaseError) && /timeout/i.test(String((e as Error)?.message))
    ? 'ConnectionTimeout'
    : 'OperationalError';
}
