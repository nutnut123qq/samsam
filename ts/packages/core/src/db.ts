import pg from 'pg';
import { approvalEnforced, type Env, pyStrip } from './env.js';

// Port `pipelines/auth.py` (SERVICES, service_dsn, privileged_login, service_login_problem,
// bind_service) + `ingest/lead_store.connect` (DSN tường minh + connect timeout).
// KHÁC Python có chủ đích: không đọc `.env`, không ghi đè `process.env.DATABASE_URL` — trả Pool.

/** Dịch vụ không phải người: mỗi dịch vụ 1 login riêng `in role <role>` (docs/roles.sql khối v14.2). */
export const SERVICES = {
  webhook: { envVar: 'WEBHOOK_DATABASE_URL', role: 'svc_webhook' }, // Zalo/Messenger/B2B
  job: { envVar: 'JOB_DATABASE_URL', role: 'svc_job' }, // agent chạy lịch (worker)
  loader: { envVar: 'LOADER_DATABASE_URL', role: 'svc_loader' }, // nạp file
  backup: { envVar: 'BACKUP_DATABASE_URL', role: 'svc_backup' }, // pg_dump chỉ đọc
  // TS thêm (Python: Streamlit dùng DATABASE_URL bằng login `in role svc_ui`): web/API đọc.
  ui: { envVar: 'UI_DATABASE_URL', role: 'svc_ui' },
} as const;
export type Service = keyof typeof SERVICES;

export const CONNECT_TIMEOUT_MS = 5_000;
/** DB thật của Sâm Sâm — test không bao giờ chạm. */
export const REAL_DB = 'samsam';

export class DbConfigError extends Error {}
/** Dịch vụ không được phép chạy (thiếu biến ở chế độ thực, login superuser/owner/sai role). */
export class ServiceBindError extends Error {}

/** Thứ chạy được SQL: Pool hoặc PoolClient/Client. */
export type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Tên DB mà `pg` sẽ kết nối — theo đúng thuật toán `pg-connection-string` 2.x (pg chỉ lấy DB từ
 * path / `socket:?db=` / "/sock db"; `?database=` bị path đè). Thiếu → lỗi: không để pg tự suy
 * từ PGDATABASE/user (như tests/_db_guard.py: DB đích phải tường minh).
 */
export function targetDatabase(dsn: string): string {
  let db: string | null | undefined;
  if (dsn.startsWith('/')) {
    db = dsn.split(' ')[1];
  } else {
    let s = dsn;
    if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(s)) s = encodeURI(s).replace(/%25(\d\d)/g, '%$1');
    let u: URL;
    let dummyHost = false;
    try {
      try {
        u = new URL(s, 'postgres://base');
      } catch {
        u = new URL(s.replace('@/', '@___DUMMY___/'), 'postgres://base');
        dummyHost = true;
      }
    } catch {
      throw new DbConfigError('DSN không hợp lệ');
    }
    if (u.protocol === 'socket:') {
      db = u.searchParams.get('db');
    } else {
      let path = u.pathname;
      const hostname = dummyHost ? '' : u.hostname.replace(/^\[(.+)\]$/, '$1');
      if (u.searchParams.get('host') && hostname && /^%2f/i.test(hostname)) path = hostname + path;
      const p = path.slice(1);
      db = p ? decodeURI(p) : null;
    }
  }
  if (!db) throw new DbConfigError('DSN thiếu tên DB tường minh');
  return db;
}

/** NODE_ENV=test + DB `samsam` → lỗi (trước khi mở kết nối). → tên DB. */
export function assertNotRealDb(dsn: string, env: Env = process.env): string {
  const db = targetDatabase(dsn);
  if (env.NODE_ENV === 'test' && db.toLowerCase() === REAL_DB) {
    throw new DbConfigError(`NODE_ENV=test: từ chối DB '${REAL_DB}' (DB thật) — dùng DB test`);
  }
  return db;
}

/** Pool có connect timeout (psycopg/pg mặc định chờ vô hạn → UI treo khi host chết). */
export function createPool(
  dsn: string,
  opts: Omit<pg.PoolConfig, 'connectionString'> = {},
  env: Env = process.env,
): pg.Pool {
  assertNotRealDb(dsn, env);
  const pool = new pg.Pool({
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ...opts,
    connectionString: dsn,
  });
  // Kết nối RẢNH bị server đóng (restart, admin shutdown) → pg phát 'error' trên pool; không có
  // listener thì cả tiến trình sập. Chỉ ghi mã lỗi (không DSN) — câu sau tự mở kết nối mới / báo lỗi.
  pool.on('error', (e) => {
    console.error(`[db] kết nối rảnh bị đóng (${(e as { code?: string }).code ?? e.name})`);
  });
  return pool;
}

/** `DATABASE_URL` của tiến trình (công cụ chạy bằng owner ở máy dev/CI); thiếu → lỗi. */
export function databaseUrl(env: Env = process.env): string {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) throw new DbConfigError('thiếu DATABASE_URL');
  return dsn;
}

/** Kết nối mượn của lệnh CLI: `release()` đóng pool riêng của lệnh. */
export type DbLease = { db: pg.Pool; release: () => Promise<void> };

/** Python `ingest.lead_store.connect()`: `DATABASE_URL` → kết nối đã thử `select 1` | null (thiếu
 * DSN / host chết / DB `samsam` khi test). KHÁC Python có chủ đích: không đọc `.env` của repo. */
export async function connectDatabaseUrl(env: Env = process.env): Promise<DbLease | null> {
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

/** Python `service_dsn` → {dsn} | {error}. Chế độ thực: biến dịch vụ bắt buộc, không rơi về DATABASE_URL. */
export function serviceDsn(
  service: Service,
  env: Env = process.env,
): { dsn: string; error: null } | { dsn: null; error: string } {
  const { envVar } = SERVICES[service];
  const dsn = pyStrip(env[envVar] ?? '');
  if (dsn) return { dsn, error: null };
  if (approvalEnforced(env)) {
    return {
      dsn: null,
      error:
        `chế độ thực: thiếu ${envVar} — dịch vụ '${service}' phải ` +
        'chạy bằng login riêng, không rơi về DATABASE_URL',
    };
  }
  const fb = pyStrip(env.DATABASE_URL ?? '');
  return fb ? { dsn: fb, error: null } : { dsn: null, error: `thiếu ${envVar} / DATABASE_URL` };
}

// Superuser / thành viên role SỞ HỮU bảng (mọi schema không phải hệ thống) = vượt mọi trigger
// chặn/grant → chế độ thực từ chối. Cùng câu SQL với pipelines/auth.py `_PRIV_LOGIN_SQL`.
export const PRIV_LOGIN_SQL =
  'select r.rolsuper, exists (select 1 from pg_class c join pg_namespace n' +
  " on n.oid = c.relnamespace where n.nspname <> 'information_schema' and" +
  " n.nspname not like 'pg\\_%' and c.relkind in ('r', 'p', 'v', 'm')" +
  " and pg_has_role(session_user, c.relowner, 'MEMBER'))" +
  ' from pg_roles r where r.rolname = session_user';

/** Login superuser/owner → lý do; không kiểm được → lý do (fail-closed); login thường → null.
 * Gọi trên Pool hoặc client KHÔNG đang trong transaction (lỗi câu này làm hỏng transaction). */
export async function privilegedLogin(q: Queryable): Promise<string | null> {
  let row: { rolsuper: boolean; exists: boolean } | undefined;
  try {
    row = (await q.query(PRIV_LOGIN_SQL)).rows[0];
  } catch (e) {
    return `không kiểm được quyền login Postgres (${(e as Error).name})`;
  }
  if (!row) return 'không kiểm được quyền login Postgres';
  if (row.rolsuper) {
    return (
      'login Postgres là SUPERUSER — chế độ thực phải dùng login ' +
      'riêng không phải superuser/owner (docs/roles.sql)'
    );
  }
  if (row.exists) {
    return (
      'login Postgres là CHỦ SỞ HỮU (owner) bảng — chế độ thực ' +
      'phải dùng login riêng không sở hữu bảng (docs/roles.sql)'
    );
  }
  return null;
}

/** Chế độ thực: login superuser/owner hoặc không thuộc role dịch vụ → lý do. Dev → null. */
export async function serviceLoginProblem(
  q: Queryable,
  service: Service,
  env: Env = process.env,
): Promise<string | null> {
  if (!approvalEnforced(env)) return null;
  const why = await privilegedLogin(q);
  if (why) return why;
  const { role } = SERVICES[service];
  let ok: boolean;
  try {
    const r = await q.query(
      "select exists (select 1 from pg_roles where rolname = $1) and pg_has_role(session_user, $1, 'MEMBER') as ok",
      [role],
    );
    ok = r.rows[0]?.ok === true;
  } catch (e) {
    return `không kiểm được role dịch vụ (${(e as Error).name})`;
  }
  return ok ? null : `login không thuộc role '${role}' của dịch vụ '${service}' (docs/roles.sql)`;
}

/**
 * Python `bind_service`: đầu tiến trình dịch vụ → Pool bằng login của dịch vụ đó.
 * Chế độ thực: thiếu `<DỊCH VỤ>_DATABASE_URL`, không kết nối được, login superuser/owner/sai role
 * → ServiceBindError (tiến trình phải dừng; job Python exit 78). Dev: rơi về DATABASE_URL.
 */
export async function servicePool(service: Service, env: Env = process.env): Promise<pg.Pool> {
  const r = serviceDsn(service, env);
  if (r.error !== null) throw new ServiceBindError(r.error);
  const pool = createPool(r.dsn, {}, env);
  if (!approvalEnforced(env)) return pool;
  let why: string | null;
  try {
    const client = await pool.connect();
    try {
      why = await serviceLoginProblem(client, service, env);
    } finally {
      client.release();
    }
  } catch (e) {
    why = `không kết nối được DB dịch vụ '${service}' (${(e as Error).name})`;
  }
  if (why) {
    await pool.end();
    throw new ServiceBindError(why);
  }
  return pool;
}
