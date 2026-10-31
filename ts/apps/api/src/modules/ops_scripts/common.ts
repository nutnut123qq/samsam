import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { createPool, databaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import { vnFormat } from '@samsam/core/ops/period';
import { cpSlice, squash } from '@samsam/core/ops/py';
import { pyFixed } from '@samsam/core/ops/py-json';
import { REPO_ROOT } from '@samsam/core/paths';
import { pyDumps } from '@samsam/core/rollout/counters';
import { S } from '@samsam/core/security/py';
import type pg from 'pg';

// Tiện ích chung của nhóm ops_scripts (port phần dùng chung của `scripts/db_backup.py` mà
// db_restore_drill / dr_drill / break_glass / onprem_preflight import lại). Python là chuẩn.
// KHÁC Python có chủ đích: KHÔNG nạp `.env` (Python `load_dotenv(ROOT/.env)`) — TS chỉ đọc biến môi
// trường tiến trình (compose env_file / systemd EnvironmentFile); `.env` repo trỏ DB samsam thật.

/** Vi phạm cấu hình/tham số → exit 2 (Python `UsageError`). */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Python `RuntimeError` — lỗi nghiệp vụ được bắt + ghi nhật ký (không phải lỗi lập trình). */
export class RuntimeErr extends Error {
  override name = 'RuntimeError';
}

/** Python `subprocess.TimeoutExpired`. */
export class ProcTimeout extends Error {
  override name = 'TimeoutExpired';
}

export type RunOpts = {
  env?: Env;
  timeoutMs: number;
  /** stdin đọc từ file (Python `stdin=fh`); không có → không nối stdin. */
  stdinFile?: string;
  /** stdout ghi thẳng vào file (Python `stdout=fh`); không có → thu vào bộ nhớ. */
  stdoutFile?: string;
};
export type RunResult = { code: number; stdout: Buffer; stderr: Buffer };

/** Python `subprocess.run(argv, capture_output=True, timeout=…, check=False)` — không shell, argv
 * không bao giờ chứa mật khẩu (biến PG… và POSTGRES_PASSWORD qua env). Quá hạn → ProcTimeout (đã kill);
 * không chạy được (thiếu exe) → lỗi hệ thống (Python OSError). */
export function spawnRun(argv: readonly string[], opts: RunOpts): Promise<RunResult> {
  return new Promise((done, fail) => {
    const fds: number[] = [];
    const closeAll = () => {
      for (const fd of fds.splice(0)) {
        try {
          closeSync(fd);
        } catch {
          // đã đóng
        }
      }
    };
    let inFd: number | 'ignore' = 'ignore';
    let outFd: number | 'pipe' = 'pipe';
    try {
      if (opts.stdinFile) {
        inFd = openSync(opts.stdinFile, 'r');
        fds.push(inFd);
      }
      if (opts.stdoutFile) {
        outFd = openSync(opts.stdoutFile, 'w', 0o600);
        fds.push(outFd);
      }
    } catch (e) {
      closeAll();
      fail(e);
      return;
    }
    const [cmd, ...args] = argv as [string, ...string[]];
    const p = spawn(cmd, args, {
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [inFd, outFd, 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout?.on('data', (b: Buffer) => out.push(b));
    p.stderr?.on('data', (b: Buffer) => err.push(b));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, opts.timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      closeAll();
      fail(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      closeAll();
      if (timedOut) {
        fail(
          new ProcTimeout(
            `Command '${JSON.stringify(argv)}' timed out after ${opts.timeoutMs / 1000} seconds`,
          ),
        );
        return;
      }
      done({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/** Python `shutil.which(name)` (PATH; Windows thêm PATHEXT). KHÁC Python có chủ đích: không tìm ở
 * thư mục hiện hành trên Windows (chặt hơn — không chạy nhầm exe lạ trong cwd). */
export function which(name: string, env: Env = process.env): string | null {
  const path = env.PATH ?? env.Path ?? '';
  const win = process.platform === 'win32';
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const names = win && /\.[^\\/.]+$/.test(name) ? [name] : exts.map((x) => name + x);
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (!statSync(p).isFile()) continue;
        if (!win) accessSync(p, constants.X_OK);
        return p;
      } catch {
        // không có / không chạy được
      }
    }
  }
  return null;
}

/** Điểm thay được trong test (Python monkeypatch `subprocess.run`, `shutil.which`, `shutil.copyfile`,
 * `Path.unlink`, `vn_now`). Production không đổi. */
export const io = {
  run: spawnRun as (argv: readonly string[], opts: RunOpts) => Promise<RunResult>,
  which: which as (name: string, env?: Env) => string | null,
  copyFile: (src: string, dst: string): void => copyFileSync(src, dst),
  unlink: (p: string): void => unlinkSync(p),
  now: (): Date => new Date(),
};

// ------------------------------------------------------------ đường dẫn

/** Python `Path(p).expanduser()`. */
export function expandUser(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith(`~${sep}`)) return homedir() + p.slice(1);
  return p;
}

/** Python `Path(p).resolve()` (strict=False): realpath phần đã tồn tại + phần còn lại. */
export function pyResolve(p: string): string {
  const abs = resolve(expandUser(p));
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(pyResolve(parent), basename(abs));
  }
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const ROOT_REAL = pyResolve(REPO_ROOT);

/** Python `inside_repo`: path (đã resolve) là repo hoặc nằm dưới repo. Windows so không phân biệt hoa
 * thường (WindowsPath của Python cũng vậy). */
export function insideRepo(p: string, root: string = ROOT_REAL): boolean {
  const a = norm(pyResolve(p));
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Python `dir_outside_repo`: đường NGOÀI repo cho biến env `name`; vi phạm → UsageError. */
export function dirOutsideRepo(value: string | undefined | null, name: string): string {
  if (!value) throw new UsageError(`thiếu ${name}`);
  if (insideRepo(value)) throw new UsageError(`${name} nằm trong repo — phải đặt NGOÀI repo`);
  return pyResolve(value);
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** sha256 hex, đọc từng khối 1 MiB (bản dump có thể vài GB). */
export function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** Python `append_jsonl`: append BYTES + `\n` tường minh (`json.dumps(ensure_ascii=False)`); file mới
 * chỉ chủ sở hữu đọc được (Python `private_umask` 077). */
export function appendJsonl(path: string, rec: unknown): void {
  appendFileSync(path, Buffer.from(`${pyDumps(rec)}\n`, 'utf8'), { mode: 0o600 });
}

/** Python `write_json_atomic`: `json.dumps(indent=2, ensure_ascii=False)` + `\n`, tmp + os.replace. */
export function writeJsonAtomic(path: string, obj: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, 'utf8'), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Python `unlink(missing_ok=True)`. */
export function unlinkQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

/** Python `OSError.strerror or e`: phần mô tả của lỗi hệ thống Node ("EPERM: operation not
 * permitted, unlink 'x'" → "operation not permitted"); lỗi khác → message. */
export function strerror(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const m = /^E[A-Z]+: ([^,]+)/.exec(msg);
  return m ? (m[1] as string) : msg;
}

/** Lỗi được bắt + ghi nhật ký như Python bắt (psycopg.Error, RuntimeError, OSError, TimeoutExpired):
 * mọi lỗi TRỪ lỗi lập trình (TypeError/ReferenceError/SyntaxError) và lỗi Python khác (ValueError
 * ⇒ RangeError) — những lỗi đó vẫn nổi lên như Python. */
export function isExpectedError(e: unknown): boolean {
  return !(
    e instanceof TypeError ||
    e instanceof ReferenceError ||
    e instanceof SyntaxError ||
    e instanceof RangeError ||
    !(e instanceof Error)
  );
}

/** Python `@private_umask`: dump/manifest/nhật ký (có PII khách) chỉ chủ sở hữu đọc được trên Linux.
 * Luồng worker (vitest) không đổi được umask → bỏ qua (file vẫn tạo với mode 0600 tường minh). */
export async function privateUmask<T>(fn: () => Promise<T>): Promise<T> {
  let old: number | null = null;
  try {
    old = process.umask(0o077);
  } catch {
    old = null;
  }
  try {
    return await fn();
  } finally {
    if (old !== null) process.umask(old);
  }
}

// ------------------------------------------------------------ thời gian

/** Python `vn_now()` — giờ hiện tại, bỏ phần dưới giây. */
export function vnNow(): Date {
  const d = io.now();
  return new Date(d.getTime() - (((d.getTime() % 1000) + 1000) % 1000));
}

/** Python `dt.astimezone(VN_TZ).isoformat()` (có micro giây khi khác 0). */
export function vnIso(d: Date): string {
  const ms = ((d.getTime() % 1000) + 1000) % 1000;
  const frac = ms ? `.${String(ms).padStart(3, '0')}000` : '';
  return `${vnFormat(d, '%Y-%m-%dT%H:%M:%S')}${frac}+07:00`;
}

// ------------------------------------------------------------ DSN

/**
 * Python `psycopg.conninfo.conninfo_to_dict(dsn)` (libpq): URL `postgres[ql]://` (thành phần + tham
 * số query, query đè thành phần) hoặc chuỗi `key=value` (giá trị `'…'` với `\'` `\\`). Không parse
 * được → {} (Python bắt ProgrammingError rồi coi như rỗng ở `scrub`).
 */
export function conninfo(dsn: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (/^postgres(?:ql)?:\/\//.test(dsn)) {
    let u: URL;
    try {
      u = new URL(dsn);
    } catch {
      return {};
    }
    try {
      if (u.username) out.user = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
      const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
      if (host) out.host = decodeURIComponent(host);
      if (u.port) out.port = u.port;
      const db = u.pathname.replace(/^\//, '');
      if (db) out.dbname = decodeURIComponent(db);
      for (const [k, v] of u.searchParams) out[k] = v;
    } catch {
      return {};
    }
    return out;
  }
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*('((?:[^'\\]|\\.)*)'|(?:[^\s'\\]|\\.)+)/y;
  let i = 0;
  while (i < dsn.length) {
    if (/^\s*$/.test(dsn.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(dsn);
    if (!m) return {};
    const raw = m[3] ?? m[2] ?? '';
    out[m[1] as string] = raw.replace(/\\(.)/g, '$1');
    i = re.lastIndex;
  }
  return out;
}

const SECRET_URL = new RegExp(`postgres(?:ql)?://[^${S}]+`, 'gu');

/** Python `scrub`: rút gọn thông báo lỗi + che host/user/mật khẩu/DSN (không vào log). */
export function scrub(msg: unknown, dsn?: string | null): string {
  let s = String(msg instanceof Error ? msg.message : msg);
  if (dsn) {
    s = s.split(dsn).join('<dsn>');
    const parts = conninfo(dsn);
    for (const k of ['password', 'user', 'host']) {
      const v = parts[k];
      if (v && [...v].length >= 3) s = s.split(v).join(`<${k}>`);
    }
  }
  s = s.replace(SECRET_URL, '<dsn>');
  return cpSlice(squash(s), 0, 300);
}

const PG_ENV: Record<string, string> = {
  host: 'PGHOST',
  port: 'PGPORT',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  dbname: 'PGDATABASE',
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
};
export const PG_ENV_VARS = Object.values(PG_ENV);
export const CONNECT_TIMEOUT_S = 10;

/** Python `pg_env`: env cho công cụ PG (pg_dump/pg_restore) — DSN tách thành biến PG* (không argv),
 * xóa PG* thừa kế (DSN là nguồn duy nhất). */
export function pgEnv(dsn: string, dbname?: string | null, base: Env = process.env): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.toUpperCase().startsWith('PG') || k.toUpperCase() === 'PG_BIN') env[k] = v;
  }
  for (const [k, v] of Object.entries(conninfo(dsn))) {
    const name = PG_ENV[k];
    if (name && v !== '') env[name] = v;
  }
  if (dbname) env.PGDATABASE = dbname;
  env.PGCONNECT_TIMEOUT = String(CONNECT_TIMEOUT_S);
  return env;
}

/** Python `make_conninfo(dsn, dbname=…)` cho DSN dạng URL (pg chỉ nhận URL). */
export function withDb(dsn: string, db: string): string {
  const u = new URL(dsn);
  u.pathname = `/${encodeURIComponent(db)}`;
  return u.toString();
}

// ------------------------------------------------------------ số kiểu Python

const ND = /\p{Nd}/u;

/** Đổi chữ số Unicode (Nd) về ASCII — Python `int()`/`float()` nhận mọi chữ số thập phân Unicode.
 * Các khối Nd luôn là dãy liên tiếp 0..9 → giá trị = vị trí trong dãy liền mạch % 10. */
export function ndToAscii(s: string): string {
  let out = '';
  for (const c of s) {
    const cp = c.codePointAt(0) as number;
    if (cp < 0x80 || !ND.test(c)) {
      out += c;
      continue;
    }
    let k = 0;
    while (ND.test(String.fromCodePoint(cp - k - 1))) k++;
    out += String(k % 10);
  }
  return out;
}

const FLOAT_RE =
  /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `float(s)` → số | null (không parse được). */
export function pyFloat(raw: string): number | null {
  const s = ndToAscii(pyStrip(raw));
  const sp = SPECIAL_RE.exec(s);
  if (sp) {
    if ((sp[2] as string).toLowerCase() === 'nan') return Number.NaN;
    return sp[1] === '-' ? -Infinity : Infinity;
  }
  if (!FLOAT_RE.test(s)) return null;
  return Number(s.replaceAll('_', ''));
}

/** Python `int(s)` cho chuỗi chữ số không dấu (`re.fullmatch(r"\d+")` đã kiểm) → số. */
export function pyDigitsInt(s: string): number {
  return Number(ndToAscii(s));
}

/** Python `f"{x:g}"`. */
export function fmtG(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const [mant, e] = x.toExponential(5).split('e') as [string, string];
  const exp = Number(e);
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= 6) {
    return `${trim(mant)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return trim(x.toFixed(Math.max(0, 5 - exp)));
}

/** Python `str(float)` cho giá trị đã `round(…)` (3.0 → "3.0"); None → "None". */
export function pyNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'None';
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/** Python `round(x, 2)` — làm tròn đúng trên giá trị nhị phân chính xác, hòa → số chẵn (`x * 100` của
 * JS tự làm tròn: 2.675 * 100 = 267.5 → sai). */
export function round2(x: number): number {
  return Number(pyFixed(x, 2));
}

// ------------------------------------------------------------ DB

/** Python `ingest.lead_store.connect()`: DATABASE_URL → Pool | null (thiếu DSN / host chết). */
export async function openDb(env: Env): Promise<pg.Pool | null> {
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
