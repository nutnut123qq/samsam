import pg from 'pg';
import { CONNECT_TIMEOUT_MS, DbConfigError, REAL_DB, targetDatabase } from '../db.js';
import type { Env } from '../env.js';

// DB test TS: mỗi nhóm/test tạo DB RIÊNG từ DB mẫu (dựng bằng apply_schema.py — setup-template.ts)
// trong container test, xóa khi xong. KHÔNG BAO GIỜ DB `samsam`.

export const TEMPLATE_DB = 'samsam_ts_tpl';
const NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const PROTECTED = new Set([REAL_DB, TEMPLATE_DB, 'postgres', 'template0', 'template1']);

/** Kết nối quản trị container test (`TS_TEST_ADMIN_URL` trong db.env, DB `postgres`). */
export function adminUrl(env: Env = process.env): string {
  const url = env.TS_TEST_ADMIN_URL;
  if (!url) throw new DbConfigError('thiếu TS_TEST_ADMIN_URL — nạp db.env (ts/CONVENTIONS.md)');
  if (targetDatabase(url).toLowerCase() === REAL_DB) {
    throw new DbConfigError(`TS_TEST_ADMIN_URL trỏ DB '${REAL_DB}' — từ chối`);
  }
  return url;
}

/** DSN cùng máy chủ/tài khoản quản trị nhưng tới DB `name`. */
export function dbUrl(name: string, env: Env = process.env): string {
  const u = new URL(adminUrl(env));
  u.pathname = `/${name}`;
  return u.toString();
}

/** Tên DB test duy nhất theo nhóm, vd `testDbName('approval')` → `t_approval_<pid>_<rand>`. */
export function testDbName(group: string): string {
  const g = group
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 30);
  return `t_${g}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

export function checkTestDbName(name: string): void {
  if (!NAME_RE.test(name) || PROTECTED.has(name.toLowerCase())) {
    throw new DbConfigError(`tên DB test không hợp lệ/bị cấm: '${name}'`);
  }
}

export async function adminQuery(sql: string, env: Env = process.env): Promise<void> {
  const c = new pg.Client({
    connectionString: adminUrl(env),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** `create database <name> template samsam_ts_tpl` → DSN của DB mới (quyền owner/superuser). */
export async function createDbFromTemplate(name: string, env: Env = process.env): Promise<string> {
  checkTestDbName(name);
  for (let attempt = 0; ; attempt++) {
    try {
      await adminQuery(`create database "${name}" template "${TEMPLATE_DB}"`, env);
      return dbUrl(name, env);
    } catch (e) {
      // 55006: DB mẫu đang có phiên khác (agent khác đang tạo cùng lúc) — thử lại ngắn.
      if ((e as { code?: string }).code !== '55006' || attempt >= 10) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

export async function dropDb(name: string, env: Env = process.env): Promise<void> {
  checkTestDbName(name);
  await adminQuery(`drop database if exists "${name}" with (force)`, env);
}
