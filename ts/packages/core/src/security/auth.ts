import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import pg from 'pg';
import { assertNotRealDb, CONNECT_TIMEOUT_MS, privilegedLogin, type Queryable } from '../db.js';
import { approvalEnforced, authMode, type Env } from '../env.js';
import { type JsonFileError, readJson } from '../ops/py.js';
import { intFloatReviver } from '../ops/py-json.js';
import { dataPath } from '../paths.js';
import { casefold, cpHead, pyReprValue, pySplit, pyStr, pyStrip } from './py.js';

// Port `pipelines/auth.py` (phân quyền + cổng quyết định người) — logic thuần + gọi DB.
//  - 6 vai trò × 7 tab (`ROLE_TABS`), `CAN_APPROVE`/`CAN_SCHEDULE` là ĐỀ XUẤT (TGĐ chốt). Role lạ
//    → không tab, không quyền.
//  - `authorize(by, block, action)` — cổng ủy quyền DUY NHẤT cho quyết định người (UI + CLI).
//    Agent/system không bao giờ duyệt; người tạo không tự duyệt. Chế độ thực (`approvalEnforced`)
//    → người phải thuộc `approvers` của ĐÚNG khối (rỗng = chặn: Bên B chưa ủy quyền), tài khoản
//    users file có vai trò thuộc `approver_roles`, CLI chạy bằng login Postgres khớp `db_login`.
//  - Quyết định của người đi qua login Postgres RIÊNG (`personConnect`): kiểm session_user, từ
//    chối superuser/owner, đòi `human_whoami()`, ghi `human_login_check()`.
// KHÁC Python có chủ đích: đăng nhập web = Keycloak (OIDC) — `verifyAccessToken` thay header
// proxy + mật khẩu scrypt (`identity_from_headers`/`check_login`/`--hash` không port); không đọc
// `.env` (env truyền vào, mặc định process.env).

export const TABS = [
  'Chat Sâm Sâm',
  'Content Studio',
  'Chưa trả lời',
  'Leads',
  'Báo cáo',
  'Nhật ký vườn',
  'Duyệt & Lịch',
] as const;
export const ROLES = ['tgd', 'phap_che', 'gd_ban_hang', 'gd_marketing', 'mxh', 'ha_tang'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_TABS: Readonly<Record<Role, readonly string[]>> = {
  tgd: TABS,
  phap_che: ['Chat Sâm Sâm', 'Content Studio', 'Chưa trả lời', 'Báo cáo', 'Duyệt & Lịch'],
  // v13.5: GĐ bán hàng / Quản lý AI duyệt khối sales / data_platform → cần tab duyệt.
  gd_ban_hang: ['Chat Sâm Sâm', 'Chưa trả lời', 'Leads', 'Báo cáo', 'Duyệt & Lịch'],
  gd_marketing: ['Chat Sâm Sâm', 'Content Studio', 'Leads', 'Báo cáo', 'Duyệt & Lịch'],
  mxh: ['Chat Sâm Sâm', 'Content Studio', 'Chưa trả lời', 'Leads', 'Duyệt & Lịch'],
  ha_tang: ['Chat Sâm Sâm', 'Chưa trả lời', 'Báo cáo', 'Nhật ký vườn', 'Duyệt & Lịch'],
};
export const CAN_APPROVE: ReadonlySet<string> = new Set(['tgd', 'phap_che', 'gd_marketing']);
export const CAN_SCHEDULE: ReadonlySet<string> = new Set(['tgd', 'gd_marketing', 'mxh']);

const isRole = (r: unknown): r is Role =>
  typeof r === 'string' && (ROLES as readonly string[]).includes(r);

/** Tab được xem theo vai trò; role lạ/null → []. */
export function tabsFor(role: unknown): readonly string[] {
  return isRole(role) ? ROLE_TABS[role] : [];
}
export const canApprove = (role: unknown): boolean => CAN_APPROVE.has(role as string);
export const canSchedule = (role: unknown): boolean => CAN_SCHEDULE.has(role as string);
export { approvalEnforced, authMode };

// ---------- users file ----------

export type UserEntry = { role: Role; password_hash: string; db_login?: string };

/** `AUTH_USERS_FILE` (mặc định data/users.json, NGOÀI git) → Map username_lower → entry. File thiếu /
 * rỗng / JSON hỏng / không phải object → Map rỗng (không ai vào được = fail-closed). Entry role lạ
 * / không phải object bị bỏ; key bắt đầu "_" bị bỏ. Không ném lỗi. */
export function loadUsers(path?: string, env: Env = process.env): Map<string, UserEntry> {
  const file = path ?? (env.AUTH_USERS_FILE || dataPath('users.json'));
  const users = new Map<string, UserEntry>();
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file)),
    );
  } catch {
    return users;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return users;
  for (const [name, entry] of Object.entries(data)) {
    if (name.startsWith('_')) continue;
    const key = pyStrip(name).toLowerCase();
    if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (!isRole(e.role)) continue;
    const u: UserEntry = {
      role: e.role,
      password_hash: typeof e.password_hash === 'string' ? e.password_hash : '',
    };
    // v13.5: login Postgres RIÊNG của người (CLI duyệt chế độ thực — `--by` khớp login đang dùng).
    if (typeof e.db_login === 'string' && pyStrip(e.db_login))
      u.db_login = pyStrip(e.db_login).toLowerCase();
    users.set(key, u);
  }
  return users;
}

// ---------- v13.5 ủy quyền người duyệt (F08) ----------

export const ACTIONS = [
  'approve',
  'reject',
  'override_qa',
  'schedule',
  // v14.2: quyết định người ở CLI ngoài hàng duyệt chung — mỗi CLI gọi `cliGate` đúng việc.
  'intake',
  'approve_price',
  'sign',
  'issue',
  'revoke',
  'set_status',
  'promote',
  'severe',
  'disable',
  'ack',
  'verify',
  'consent',
  'assign',
  'handoff',
  'load_dealers',
  'purge_sample',
  'adopt_plot',
  'close_violation', // v15.4: ra_kenh --mark-removed
  'media_cap', // r12 G5-01: cấp/thu hồi tư liệu vườn cho Marketing
  'media_thu_hoi',
  'link_origin', // r12 G5-02: ánh xạ / gỡ lô ↔ nhật ký thu hoạch (QR)
  'unlink_origin',
] as const;
export const NON_HUMAN = ['agent:', 'system:', 'auto_policy:'];
export const DEV_WARNING =
  'CHẾ ĐỘ DEV — người duyệt CHƯA được đối chiếu danh sách ủy quyền (đặt AUTH_MODE=local|proxy ' +
  'hoặc APPROVAL_ENFORCE=1 khi dùng thật)';

/** Tên người thật: không rỗng, không tiền tố agent:/system:/auto_policy:. */
export function isHuman(name: unknown): boolean {
  const s = typeof name === 'string' ? casefold(pyStrip(name)) : '';
  return !!s && !NON_HUMAN.some((p) => s.startsWith(p));
}

const cf = (s: unknown): string => (typeof s === 'string' ? casefold(pyStrip(s)) : '');
const same = (a: unknown, b: unknown): boolean => cf(a) === cf(b);

/** NFC + gộp khoảng trắng + casefold (khớp `qr_trace.norm_name`). */
export function normName(s: unknown): string {
  return typeof s === 'string' ? casefold(pySplit(s.normalize('NFC')).join(' ')) : '';
}

// --- cấu hình khối `data/directors/<khối>.json` (validate như pipelines/director.py) ---
export const BLOCKS = [
  'ceo',
  'sales',
  'marketing',
  'intel',
  'finance',
  'production',
  'farming',
  'legal_hr',
  'data_platform',
] as const;
const RISKS = ['low', 'medium', 'high'];
const TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;

export class DirectorConfigError extends Error {
  override name = 'DirectorConfigError';
}
export type BlockConfig = Record<string, unknown> & {
  block: string;
  approver_roles: string[];
  approvers: string[];
};

const intIn = (v: unknown, lo: number, hi: number) =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Python `director.validate`. */
export function validateBlockConfig(cfg: unknown, block: string): BlockConfig {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new DirectorConfigError(`${block}: cấu hình không phải object JSON`);
  }
  const c = cfg as Record<string, unknown>;
  if (c.block !== block) {
    throw new DirectorConfigError(`${block}: 'block' = ${pyReprValue(c.block)} lệch tên file`);
  }
  for (const k of ['name', 'director_agent']) {
    if (typeof c[k] !== 'string' || !pyStrip(c[k] as string))
      throw new DirectorConfigError(`${block}: thiếu '${k}'`);
  }
  const roles = c.approver_roles;
  if (!Array.isArray(roles) || !roles.length)
    throw new DirectorConfigError(`${block}: 'approver_roles' rỗng`);
  const stray = roles.filter((r) => !isRole(r));
  if (stray.length) {
    throw new DirectorConfigError(
      `${block}: vai trò lạ ${pyStr(stray)} — phải thuộc (${ROLES.map((r) => `'${r}'`).join(', ')})`,
    );
  }
  for (const k of ['approvers', 'digest_recipients']) {
    const v = c[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new DirectorConfigError(`${block}: '${k}' phải là list chuỗi`);
    }
  }
  const types = c.object_types;
  if (!types || typeof types !== 'object' || Array.isArray(types) || !Object.keys(types).length) {
    throw new DirectorConfigError(`${block}: 'object_types' rỗng`);
  }
  for (const [t, spec] of Object.entries(types)) {
    if (t === 'content_draft' || !TYPE_RE.test(t)) {
      throw new DirectorConfigError(
        `${block}: loại việc '${t}' không hợp lệ (content_draft đi pipelines.store)`,
      );
    }
    const s = spec as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s) || !intIn(s.sla_hours, 1, 720)) {
      throw new DirectorConfigError(`${block}/${t}: sla_hours phải 1..720`);
    }
    if (!RISKS.includes(s.risk as string)) {
      throw new DirectorConfigError(`${block}/${t}: risk phải ('low', 'medium', 'high')`);
    }
  }
  if (!intIn(c.due_soon_hours, 1, 720))
    throw new DirectorConfigError(`${block}: due_soon_hours phải 1..720`);
  return c as BlockConfig;
}

let directorsDir = dataPath('directors');

/** Chỉ test: đổi thư mục cấu hình khối (Python `DIRECTORS_DIR`). */
export function setDirectorsDir(dir?: string): void {
  directorsDir = dir ?? dataPath('directors');
}

/** Python `director.load_config(block, base_dir)` — bản DUY NHẤT (ops/director re-export). */
export function loadBlockConfig(block: string, dir: string = directorsDir): BlockConfig {
  const name = `${block}.json`;
  let cfg: unknown;
  let ints: unknown;
  try {
    cfg = readJson(join(dir, name));
    // Python `isinstance(v, int)` từ chối `30.0`: kiểm luật trên bản giữ dạng float, trả bản JSON thường.
    ints = readJson(join(dir, name), intFloatReviver);
  } catch (e) {
    const t = (e as JsonFileError).pyType;
    throw new DirectorConfigError(
      t === 'FileNotFoundError' ? `không có file ${name}` : `${name} hỏng: ${t}`,
    );
  }
  validateBlockConfig(ints, block);
  return validateBlockConfig(cfg, block);
}

/** Python `auth._block_cfg`: khối lạ → lỗi, rồi `loadBlockConfig`. Đọc lại mỗi lần. */
export function blockConfig(block: string): BlockConfig {
  if (!(BLOCKS as readonly string[]).includes(block)) {
    throw new DirectorConfigError(`khối '${block}' không tồn tại`);
  }
  return loadBlockConfig(block);
}

export type AuthzResult = { ok: boolean; why: string | null };
export type AuthorizeOpts = {
  createdBy?: string | null;
  /** UI: vai trò từ phiên đăng nhập (Keycloak). */
  role?: string | null;
  /** CLI: login Postgres đang dùng (`sessionLogin`). */
  dbLogin?: string | null;
  via?: string;
  users?: Map<string, UserEntry>;
  env?: Env;
  /** v14.2: danh sách người riêng của việc đó (vd người ký QR) — THAY approvers/approver_roles. */
  allow?: readonly unknown[] | null;
  allowSrc?: string | null;
};

const deny = (why: string): AuthzResult => ({ ok: false, why });

/** → {ok, why}. Mọi chế độ: người rỗng / agent:/system:/auto_policy: → chặn; duyệt/override mục
 * chính mình tạo → chặn. Chế độ thực thêm: vai trò thuộc `approver_roles` (xếp lịch: CAN_SCHEDULE),
 * khối có `approvers` (rỗng = chặn), người thuộc `approvers` của ĐÚNG khối, có tài khoản users
 * file với vai trò được phép; CLI (`via != 'ui'`) phải có `dbLogin` khớp `db_login`. */
export function authorize(
  by: unknown,
  block: string | null,
  action: string,
  o: AuthorizeOpts = {},
): AuthzResult {
  const env = o.env ?? process.env;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return deny(
      `hành động '${action}' không hợp lệ — (${ACTIONS.map((a) => `'${a}'`).join(', ')})`,
    );
  }
  const who = typeof by === 'string' ? pyStrip(by) : '';
  if (!who) return deny('thiếu người quyết định (--by / đăng nhập)');
  if (!isHuman(who)) return deny(`'${who}' không phải người — agent/hệ thống KHÔNG được ${action}`);
  if ((action === 'approve' || action === 'override_qa') && same(who, o.createdBy)) {
    return deny('người quyết trùng người tạo — cần người khác duyệt');
  }
  if (!approvalEnforced(env)) return { ok: true, why: null }; // dev: caller in DEV_WARNING
  const via = o.via ?? 'cli';
  if (o.allow !== null && o.allow !== undefined) {
    const src = o.allowSrc || 'danh sách riêng';
    const names = new Set([...o.allow].map(normName).filter(Boolean));
    if (!names.size) {
      return deny(
        `chưa có người được ${action} (${src} rỗng) — Bên B cấp danh sách, không tự điền`,
      );
    }
    if (!names.has(normName(who)))
      return deny(`'${who}' không thuộc người được ${action} (${src})`);
    const entry = (o.users ?? loadUsers(undefined, env)).get(casefold(who));
    if (!entry) return deny(`'${who}' chưa có tài khoản đăng nhập/vai trò (users file)`);
    return loginMatch(entry, o.dbLogin, via);
  }
  const blk = pyStr(block);
  let roles: ReadonlySet<string>;
  let approvers = new Set<string>();
  if (action === 'schedule') {
    roles = CAN_SCHEDULE;
  } else {
    let cfg: BlockConfig;
    try {
      cfg = blockConfig(blk);
    } catch (e) {
      return deny(`không đọc được cấu hình khối '${blk}': ${(e as Error).message}`);
    }
    roles = new Set(cfg.approver_roles);
    approvers = new Set(cfg.approvers.filter((a) => pyStrip(a)).map((a) => casefold(pyStrip(a))));
    if (!approvers.size) {
      return deny(
        `khối ${blk} CHƯA có người được Bên B ủy quyền (approvers rỗng trong data/directors/${blk}` +
          '.json) — cần văn bản ủy quyền của Bên B, không tự điền',
      );
    }
  }
  if (o.role !== null && o.role !== undefined && !roles.has(o.role)) {
    return deny(
      `vai trò '${o.role}' không được ${action} ở khối ${blk} (${[...roles].sort().join(', ')})`,
    );
  }
  if (action !== 'schedule' && !approvers.has(casefold(who))) {
    return deny(`'${who}' không thuộc người được ủy quyền duyệt khối ${blk}`);
  }
  const entry = (o.users ?? loadUsers(undefined, env)).get(casefold(who));
  if (!entry) return deny(`'${who}' chưa có tài khoản đăng nhập/vai trò (users file)`);
  if (!roles.has(entry.role)) {
    return deny(`vai trò tài khoản '${entry.role}' không được ${action} ở khối ${blk}`);
  }
  return loginMatch(entry, o.dbLogin, via);
}

/** CLI chế độ thực: `--by` phải khớp login Postgres đang dùng. */
function loginMatch(entry: UserEntry, dbLogin: unknown, via: string): AuthzResult {
  if (via !== 'ui') {
    const got = typeof dbLogin === 'string' ? pyStrip(dbLogin).toLowerCase() : '';
    if (!entry.db_login || entry.db_login !== got) {
      return deny(
        '--by không khớp login Postgres đang dùng — CLI chế độ thực phải chạy bằng login DB riêng ' +
          "của người duyệt (users file 'db_login')",
      );
    }
  }
  return { ok: true, why: null };
}

/** Khối mà người đăng nhập (UI) được quyết hàng duyệt chung: vai trò thuộc `approver_roles`; chế độ
 * thực thêm có tên trong `approvers`. Khối cấu hình hỏng → bỏ qua (fail-closed). */
export function decidableBlocks(ident: unknown, role: unknown, env: Env = process.env): string[] {
  const out: string[] = [];
  for (const b of BLOCKS) {
    let cfg: BlockConfig;
    try {
      cfg = blockConfig(b);
    } catch {
      continue;
    }
    if (!cfg.approver_roles.includes(role as string)) continue;
    if (
      approvalEnforced(env) &&
      !new Set(cfg.approvers.map((a) => casefold(pyStrip(a)))).has(cf(ident))
    )
      continue;
    out.push(b);
  }
  return out;
}

// ---------- ghi lần bị từ chối + danh tính login ----------

/** Pool hoặc client (Python `conn`). */
export type Db = pg.Pool | pg.ClientBase;
const DENY_SQL =
  'insert into agent_action_log (actor, action, object_type, object_id, detail)' +
  " values ($1, 'authz_denied', $2, $3, $4::jsonb)";

function txStatus(db: Db): string | null {
  const c = db as { getTransactionStatus?: () => string | null };
  return typeof c.getTransactionStatus === 'function' ? c.getTransactionStatus() : null;
}

/** Kết nối PHỤ cùng login/tham số với client `db` (autocommit). */
async function sideClient(db: pg.ClientBase): Promise<pg.Client> {
  const p = db as unknown as {
    connectionParameters?: Record<string, unknown>;
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    database?: string;
  };
  const cp = p.connectionParameters ?? {};
  const c = new pg.Client({
    user: (cp.user as string) ?? p.user,
    password: (cp.password as string) ?? p.password,
    host: (cp.host as string) ?? p.host,
    port: (cp.port as number) ?? p.port,
    database: (cp.database as string) ?? p.database,
    ssl: cp.ssl as pg.ClientConfig['ssl'],
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await c.connect();
  return c;
}

/** Ghi lần BỊ TỪ CHỐI vào `agent_action_log` (hash chain) — best-effort, lỗi thì bỏ; chỉ chế độ
 * thực. KHÔNG commit giao dịch của caller: Pool / client rảnh → câu riêng (autocommit); client
 * đang có giao dịch → kết nối PHỤ cùng login (bền kể cả caller rollback, chờ khóa ≤ 3 s); kết nối
 * phụ lỗi → savepoint trong giao dịch caller. */
export async function denyLog(
  db: Db,
  by: unknown,
  block: string | null,
  action: string,
  objectType: string,
  objectId: unknown,
  reason: string | null,
  env: Env = process.env,
): Promise<void> {
  if (!approvalEnforced(env)) return;
  let actor: string;
  if (typeof by === 'string') actor = cpHead(pyStrip(by), 100) || '(trống)';
  else if (by === null || by === undefined || by === '' || by === 0 || by === false)
    actor = '(trống)';
  else return; // Python: (by or "").strip() trên giá trị không phải chuỗi → bỏ (best-effort)
  const args = [
    actor,
    objectType,
    pyStr(objectId),
    JSON.stringify({ block, action, reason: cpHead(reason ?? '', 300) }),
  ];
  const st = txStatus(db);
  if (st === null || st === 'I') {
    try {
      await db.query(DENY_SQL, args);
    } catch {
      // best-effort
    }
    return;
  }
  try {
    const side = await sideClient(db as pg.ClientBase);
    try {
      // Caller đã ghi log trong tx đang mở → giữ khóa chuỗi → kết nối phụ chờ caller = treo.
      await side.query("set lock_timeout = '3s'");
      await side.query(DENY_SQL, args);
      return;
    } finally {
      await side.end();
    }
  } catch {
    // rơi về savepoint
  }
  if (st !== 'T') return; // giao dịch caller đã lỗi: savepoint cũng không chạy được
  try {
    await db.query('savepoint authz_deny_log');
    try {
      await db.query(DENY_SQL, args);
      await db.query('release savepoint authz_deny_log');
    } catch {
      await db.query('rollback to savepoint authz_deny_log');
    }
  } catch {
    // best-effort
  }
}

/** Login Postgres của kết nối (`session_user`) — null khi lỗi. */
export async function sessionLogin(db: Queryable): Promise<string | null> {
  try {
    const r = await db.query('select session_user as u');
    return r.rows[0] ? String(r.rows[0].u) : null;
  } catch {
    return null;
  }
}

/** Không mở được phiên NGƯỜI — thông điệp không chứa mật khẩu/DSN. */
export class PersonSessionError extends Error {
  override name = 'PersonSessionError';
}

const LOGIN_RE = /^[a-z_][a-z0-9_$]{0,62}$/;

export type PersonSession = { client: pg.Client; person: string; blocks: string[] };

/** Đợt an toàn S04 (HĐ 6.7, 7.2): mở kết nối bằng LOGIN Postgres RIÊNG của người dùng — danh tính
 * quyết định = `session_user` ↔ `human_logins` (trigger `person_login_guard` + `human_actor`). Từ
 * chối (PersonSessionError): login sai định dạng/thiếu mật khẩu, xác thực hỏng, login superuser/
 * owner, login chưa ánh xạ người (gồm login UI dùng chung `svc_ui`). `dsn` = DSN nền (host/db/
 * options) — user/password bị thay; không giữ/in mật khẩu. Caller `client.end()` khi xong. */
export async function personConnect(
  dsn: string,
  dbLogin: unknown,
  password: unknown,
  opts: { connectTimeoutMs?: number; env?: Env } = {},
): Promise<PersonSession> {
  const login = typeof dbLogin === 'string' ? pyStrip(dbLogin).toLowerCase() : '';
  if (!LOGIN_RE.test(login)) throw new PersonSessionError('login Postgres không hợp lệ');
  if (typeof password !== 'string' || !password)
    throw new PersonSessionError('thiếu mật khẩu Postgres');
  assertNotRealDb(dsn, opts.env ?? process.env);
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new PersonSessionError('đăng nhập Postgres thất bại (ProgrammingError)');
  }
  url.username = login;
  url.password = encodeURIComponent(password);
  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  });
  client.on('error', () => {}); // lỗi socket sau khi mở: caller thấy ở câu kế, không làm sập tiến trình
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => {});
    throw new PersonSessionError('đăng nhập Postgres thất bại (OperationalError)');
  }
  try {
    if ((await sessionLogin(client)) !== login)
      throw new PersonSessionError('phiên Postgres không khớp login');
    const why = await privilegedLogin(client);
    if (why) throw new PersonSessionError(why);
    const r = await client.query<{ person: string; blocks: string[] | null }>(
      'select person, blocks from human_whoami()',
    );
    const row = r.rows[0];
    if (!row) {
      throw new PersonSessionError(
        `login ${login} chưa được ánh xạ người (human_logins — Bên B điền theo văn bản ủy quyền, không tự điền)`,
      );
    }
    // vòng r8: bằng chứng ĐĂNG NHẬP THẬT cho ma trận (thời điểm DB, không lưu mật khẩu)
    await client.query('select human_login_check()');
    return { client, person: row.person, blocks: [...(row.blocks ?? [])] };
  } catch (e) {
    await client.end().catch(() => {});
    if (e instanceof PersonSessionError) throw e;
    throw new PersonSessionError(`không kiểm được danh tính login (${pgErrorName(e)})`);
  }
}

/** Tên lớp lỗi psycopg tương ứng SQLSTATE (thông điệp giữ như Python). */
function pgErrorName(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  if (code === '42501') return 'InsufficientPrivilege';
  if (code === '42883') return 'UndefinedFunction';
  if (code === 'P0001') return 'RaiseException';
  return code.startsWith('08') || !code ? 'OperationalError' : 'DatabaseError';
}

export type GateOpts = {
  createdBy?: string | null;
  allow?: readonly unknown[] | null;
  allowSrc?: string | null;
  users?: Map<string, UserEntry>;
  env?: Env;
  warn?: (msg: string) => void;
};

/** Cổng cho MỌI quyết định người ở CLI (ngoài hàng duyệt chung) → lý do chặn | null. Chế độ thực:
 * `authorize` (khối/hành động hoặc `allow`, `--by` khớp `db_login` của login đang dùng); bị chặn →
 * `authz_denied`. Dev: chỉ chặn agent/system/tự duyệt + cảnh báo DEV_WARNING ra stderr. KHÔNG từ
 * chối login owner ở đây (các CLI này còn ghi bảng trực tiếp — runbook mục 9). */
export async function cliGate(
  db: Db,
  by: unknown,
  block: string | null,
  action: string,
  objectType: string,
  objectId: unknown,
  o: GateOpts = {},
): Promise<string | null> {
  const env = o.env ?? process.env;
  const enforced = approvalEnforced(env);
  const r = authorize(by, block, action, {
    createdBy: o.createdBy,
    dbLogin: enforced ? await sessionLogin(db) : null,
    env,
    allow: o.allow,
    allowSrc: o.allowSrc,
    users: o.users,
  });
  if (r.ok) {
    if (!enforced) (o.warn ?? ((m) => console.error(m)))(`[warn] ${DEV_WARNING}`);
    return null;
  }
  await denyLog(db, by, block, action, objectType, objectId, r.why, env);
  return r.why;
}

/** v15.4 (P10.2) cổng cho NHẬP LIỆU / THỰC THI mục đã duyệt ở CLI (không đối chiếu `approvers`)
 * → lý do chặn | null. Mọi chế độ: người rỗng / agent:/system:/auto_policy: → chặn. Chế độ thực:
 * `--by` phải là tài khoản users file có `db_login` khớp login đang dùng. Bị chặn → `authz_denied`. */
export async function cliIdentity(
  db: Db,
  by: unknown,
  objectType: string,
  objectId: unknown,
  o: { action?: string; users?: Map<string, UserEntry>; env?: Env } = {},
): Promise<string | null> {
  const env = o.env ?? process.env;
  const action = o.action ?? 'record';
  const who = typeof by === 'string' ? pyStrip(by) : '';
  let why: string | null = null;
  if (!who) why = 'thiếu người thực hiện (--by)';
  else if (!isHuman(who)) why = `'${who}' không phải người — agent/hệ thống không ghi thay người`;
  else if (approvalEnforced(env)) {
    const entry = (o.users ?? loadUsers(undefined, env)).get(casefold(who));
    why = entry
      ? loginMatch(entry, await sessionLogin(db), 'cli').why
      : `'${who}' chưa có tài khoản đăng nhập/vai trò (users file)`;
  }
  if (why) await denyLog(db, by, null, action, objectType, objectId, why, env);
  return why;
}

// ---------- v15.4 (P10.1) ghi qua function nghiệp vụ SECURITY DEFINER ----------

/** Function `*_human` từ chối nghiệp vụ (`raise exception`) — Python ValueError(thông điệp) →
 * RangeError như quy ước ops/rollout (caller bắt ValueError = bắt RangeError). */
export class HumanError extends RangeError {
  override name = 'HumanError';
}
/** DB từ chối danh tính/ủy quyền của login đang dùng (SQLSTATE 42501 — `human_actor`). */
export class HumanDenied extends HumanError {
  override name = 'HumanDenied';
}

const dbPrimary = (e: unknown): string =>
  cpHead(pyStrip((e as Error)?.message || (e as Error)?.name || 'DatabaseError'), 300);

/** Gọi function ghi `*_human` → kết quả. 42501 → `authz_denied` (chế độ thực, không commit việc dở
 * của caller) + HumanDenied. P0001 → HumanError(thông điệp, không kèm DETAIL). */
export async function callHuman<R extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db,
  sql: string,
  args: unknown[],
  o: {
    by: unknown;
    block: string | null;
    action: string;
    objectType: string;
    objectId: unknown;
    env?: Env;
  },
): Promise<pg.QueryResult<R>> {
  try {
    return await db.query<R>(sql, args);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42501') {
      const why = dbPrimary(e);
      await denyLog(db, o.by, o.block, o.action, o.objectType, o.objectId, why, o.env);
      throw new HumanDenied(why);
    }
    if (code === 'P0001') throw new HumanError(dbPrimary(e));
    throw e;
  }
}

// ---------- Keycloak (OIDC): xác minh access token bằng JWKS ----------

export class TokenError extends Error {
  override name = 'TokenError';
}
export type WebIdentity = {
  username: string;
  email: string | null;
  role: Role | null;
  sub: string;
};
export type OidcConfig = {
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey;
  clockToleranceS?: number;
};

/** JWKS của realm Keycloak (`<issuer>/protocol/openid-connect/certs`, jose tự cache + xoay khóa). */
export function keycloakJwks(issuer: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`));
}

/** Cấu hình OIDC từ env (`OIDC_ISSUER`, `OIDC_AUDIENCE` — deploy/compose); thiếu → TokenError. */
export function oidcFromEnv(env: Env = process.env): OidcConfig {
  const issuer = pyStrip(env.OIDC_ISSUER ?? '');
  const audience = pyStrip(env.OIDC_AUDIENCE ?? '');
  if (!issuer || !audience) throw new TokenError('thiếu OIDC_ISSUER / OIDC_AUDIENCE');
  return { issuer, audience, jwks: keycloakJwks(issuer) };
}

/** Access token Keycloak → danh tính web. Chỉ khóa bất đối xứng (không HS*), đúng issuer/audience,
 * còn hạn, `typ` = Bearer (ID token bị từ chối). Vai trò = realm role ∩ ROLES: 0 → null (không tab,
 * không quyền); >1 → từ chối (users file Python 1 người 1 vai trò — fail-closed, không đoán). */
export async function verifyAccessToken(token: unknown, cfg: OidcConfig): Promise<WebIdentity> {
  if (typeof token !== 'string' || !token) throw new TokenError('thiếu access token');
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, cfg.jwks, {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384', 'EdDSA'],
      requiredClaims: ['exp', 'sub'],
      clockTolerance: cfg.clockToleranceS ?? 5,
    }));
  } catch (e) {
    throw new TokenError(
      `token không hợp lệ (${(e as { code?: string }).code ?? (e as Error).name})`,
    );
  }
  if (payload.typ !== undefined && payload.typ !== 'Bearer')
    throw new TokenError('không phải access token');
  const username =
    typeof payload.preferred_username === 'string'
      ? pyStrip(payload.preferred_username).toLowerCase()
      : '';
  if (!username) throw new TokenError('token thiếu preferred_username');
  const realm = payload.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realm?.roles) ? realm.roles.filter(isRole) : [];
  const uniq = [...new Set(roles)];
  if (uniq.length > 1)
    throw new TokenError(`tài khoản có nhiều vai trò (${uniq.sort().join(', ')}) — chỉ được 1`);
  const email =
    typeof payload.email === 'string' ? pyStrip(payload.email).toLowerCase() || null : null;
  return { username, email, role: uniq[0] ?? null, sub: String(payload.sub) };
}
