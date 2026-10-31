import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createPool, DbConfigError } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import { vnFormat } from '@samsam/core/ops/period';
import { fromIsoformat, toDate } from '@samsam/core/ops/py-date';
import { isDbError } from '@samsam/core/ops/tx';
import { pyDumps } from '@samsam/core/rollout/counters';
import type pg from 'pg';
import {
  appendJsonl,
  CONNECT_TIMEOUT_S,
  dirOutsideRepo,
  exists,
  io,
  isExpectedError,
  isFile,
  PG_ENV_VARS,
  pgEnv,
  privateUmask,
  pyDigitsInt,
  pyResolve,
  RuntimeErr,
  scrub,
  sha256File,
  strerror,
  UsageError,
  unlinkQuiet,
  vnIso,
  vnNow,
  writeJsonAtomic,
} from './common.js';

// Port `scripts/db_backup.py` (v3.6 + r13 + v15 fix P8.7c) — sao lưu Postgres, chạy lại an toàn.
// Đọc biến môi trường TIẾN TRÌNH (TS không nạp `.env`): BACKUP_DIR (bắt buộc, NGOÀI repo),
// BACKUP_KEEP (≥1, mặc định 7), BACKUP_PASSPHRASE_FILE (mã hóa openssl aes-256-cbc pbkdf2, passphrase
// không vào argv), BACKUP_OFFSITE (`dir:<path>` ngoài repo | `s3://` = external-dep exit 3),
// BACKUP_REQUIRE_ENCRYPTION=1, BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE=1, PG_BIN, DATABASE_URL (job
// `backup` đặt = BACKUP_DATABASE_URL, login svc_backup).
// Nhất quán: tx `repeatable read, read only` → `pg_export_snapshot()` → đếm mọi bảng public CÙNG
// snapshot → `pg_dump -Fc --snapshot=<id>` khi tx còn mở. Backup ok → ghi NGAY bằng chứng đầu ra vào sổ
// append-only `file_output_evidence` qua function `file_output_evidence_backup` (DB tự tính khóa
// `bk:<sha dump>` + sha phiên bản = sha256 chuỗi JSON sort key của bản ghi nhật ký).
// Exit: 0 OK; 1 lỗi (xóa `.partial`, không manifest); 2 usage (kiểm TRƯỚC connect); 3 local OK
// nhưng offsite chưa xong; 4 backup OK nhưng CHƯA ghi được bằng chứng DB.

export const DUMP_TIMEOUT_MS = 3600_000;
export const CIPHER = 'openssl-aes-256-cbc-pbkdf2';
export const OPENSSL_ENC = ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000'];
export const MAGIC = Buffer.from('PGDMP');
export const NAME_RE = /^[A-Za-z0-9_-]+_\d{8}_\d{6}_vn\.dump(\.enc)?$/;
export const MANIFEST_SUFFIX = '.manifest.json';
export const MIN_PASSPHRASE = 16;
export const MANIFEST_KEYS = [
  'format',
  'created_at',
  'db_name',
  'server_version',
  'pg_dump_version',
  'tool',
  'file',
  'size_bytes',
  'sha256',
  'encrypted',
  'cipher',
  'row_counts',
] as const;
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1']);

/** Biến mà test đổi (Python monkeypatch `PG_DEB_BASE`, `PG_WIN_BASE`, `CONNECT_TIMEOUT`, `tool_major`). */
export const settings = {
  pgDebBase: '/usr/lib/postgresql', // bố cục Debian/Ubuntu (apt/PGDG)
  pgWinBase: 'C:/Program Files/PostgreSQL',
  connectTimeoutMs: CONNECT_TIMEOUT_S * 1000,
  toolMajor: (tool: Tool, name: string, env: Env) => toolMajor(tool, name, env),
  findOpenssl: (env: Env = process.env) => findOpenssl(env),
};

export type Tool = readonly ['native' | 'docker', string];
export type Manifest = {
  format: number;
  created_at: string;
  db_name: string;
  server_version: string;
  pg_dump_version: string;
  tool: string;
  file: string;
  size_bytes: number;
  sha256: string;
  encrypted: boolean;
  cipher: string | null;
  row_counts: Record<string, number>;
} & Record<string, unknown>;
export type ManifestEntry = { created: Date; path: string; m: Manifest };

/** File bắt đầu bằng magic `PGDMP` (pg_dump -Fc) — chỉ đọc 5 byte đầu. */
export function hasMagic(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(MAGIC.length);
    const n = readSync(fd, b, 0, b.length, 0);
    return n === MAGIC.length && b.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

const exe = (name: string) => name + (process.platform === 'win32' ? '.exe' : '');
const posix = (p: string) => p.replaceAll('\\', '/');

// ------------------------------------------------------------ công cụ Postgres

export async function dockerHasImage(image: string, env: Env = process.env): Promise<boolean> {
  const docker = io.which('docker', env);
  if (!docker) return false;
  try {
    const r = await io.run([docker, 'image', 'inspect', image], { timeoutMs: 30_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

function pgBinTool(name: string, env: Env, log: (s: string) => void): Tool | null {
  const pgBin = env.PG_BIN;
  if (pgBin) {
    const p = join(pgBin, exe(name));
    if (exists(p)) return ['native', posix(p)];
    log(`[warn] PG_BIN không có ${exe(name)} — thử cách khác`);
  }
  return null;
}

/** Ứng viên sau PG_BIN, sinh LƯỜI (docker chỉ kiểm image khi ứng viên trước không đúng major):
 * `/usr/lib/postgresql/<major>/bin` (Debian/Ubuntu) → bộ cài Windows theo major server → PATH → image
 * `postgres:<major>-alpine` rồi `postgres:<major>` ĐÃ CÓ (không tự pull). */
export async function* toolCandidates(name: string, major: number, env: Env): AsyncGenerator<Tool> {
  for (const base of [settings.pgDebBase, settings.pgWinBase]) {
    const p = join(base, String(major), 'bin', exe(name));
    if (exists(p)) yield ['native', posix(p)];
  }
  const w = io.which(name, env);
  if (w) yield ['native', posix(w)];
  for (const image of [`postgres:${major}-alpine`, `postgres:${major}`]) {
    if (await dockerHasImage(image, env)) yield ['docker', image];
  }
}

/** ['native', path] | ['docker', image] | null — ứng viên có sẵn ĐẦU TIÊN (PG_BIN rồi
 * toolCandidates; chưa kiểm major — test dùng để skip). Chọn thật: resolveTool. */
export async function findTool(
  name: string,
  major: number,
  env: Env = process.env,
  log: (s: string) => void = console.log,
): Promise<Tool | null> {
  const t = pgBinTool(name, env, log);
  if (t) return t;
  for await (const c of toolCandidates(name, major, env)) return c;
  return null;
}

export const toolLabel = (t: Tool) => `${t[0]}:${t[1]}`;

/** argv chạy công cụ; dữ liệu qua stdin/stdout. Docker: biến PG* vào container bằng `-e NAME` (không
 * kèm giá trị → mật khẩu không nằm trong argv); host local → host.docker.internal. */
export function toolArgv(tool: Tool, name: string, args: readonly string[], env: Env): string[] {
  const [kind, where] = tool;
  if (kind === 'native') return [where, ...args];
  const argv = ['docker', 'run', '--rm', '-i'];
  for (const v of [...new Set([...PG_ENV_VARS, 'PGCONNECT_TIMEOUT'])].sort()) {
    if (!(v in env) || env[v] === undefined) continue;
    if (v === 'PGHOST' && LOCAL_HOSTS.has(env[v] as string)) {
      // docker engine Linux (runner/on-prem) không tự có tên này → host-gateway
      argv.push(
        '-e',
        'PGHOST=host.docker.internal',
        '--add-host=host.docker.internal:host-gateway',
      );
    } else argv.push('-e', v);
  }
  return [...argv, where, name, ...args];
}

export async function toolMajor(tool: Tool, name: string, env: Env): Promise<[number, string]> {
  const r = await io.run(toolArgv(tool, name, ['--version'], env), { env, timeoutMs: 120_000 });
  const out = pyStrip(r.stdout.toString('utf8'));
  const m = /(\d+)(?:\.\d+)?/.exec(out);
  if (r.code !== 0 || !m) throw new RuntimeErr(`${name} --version lỗi`);
  return [Number(m[1]), out];
}

/** [tool, version_text]: PG_BIN thắng (major khác server chỉ cảnh báo, thấp hơn → lỗi); không thì
 * ứng viên đầu tiên CÙNG major server, rồi mới tới bản mới hơn + `[warn]` (r22: pg_restore mới hơn
 * sinh `SET transaction_timeout`, server cũ từ chối); không có ứng viên ≥ server → RuntimeErr. */
export async function resolveTool(
  name: string,
  serverMajor: number,
  env: Env,
  log: (s: string) => void = console.log,
): Promise<[Tool, string]> {
  const pinned = pgBinTool(name, env, log);
  if (pinned) {
    const [major, text] = await settings.toolMajor(pinned, name, env);
    if (major < serverMajor) throw new RuntimeErr(`${name} major ${major} < server ${serverMajor}`);
    if (major !== serverMajor)
      log(`[warn] PG_BIN ${name} major ${major} ≠ server ${serverMajor} — dùng theo PG_BIN`);
    return [pinned, text];
  }
  let newer: [Tool, string, number] | null = null;
  let older: number | null = null;
  for await (const tool of toolCandidates(name, serverMajor, env)) {
    let major: number;
    let text: string;
    try {
      [major, text] = await settings.toolMajor(tool, name, env);
    } catch (e) {
      if (!isExpectedError(e)) throw e;
      log(`[warn] ${toolLabel(tool)}: ${name} --version lỗi — bỏ qua`);
      continue;
    }
    if (major === serverMajor) return [tool, text];
    if (major > serverMajor) newer ??= [tool, text, major];
    else older ??= major;
  }
  if (newer === null) {
    if (older !== null) throw new RuntimeErr(`${name} major ${older} < server ${serverMajor}`);
    throw new RuntimeErr(
      `không tìm thấy ${name} (PG_BIN / ${settings.pgDebBase}/${serverMajor}/bin / ${settings.pgWinBase}/${serverMajor}/bin / PATH / docker postgres:${serverMajor}-alpine|postgres:${serverMajor})`,
    );
  }
  const [tool, text, major] = newer;
  log(
    `[warn] không có ${name} major ${serverMajor} — dùng ${toolLabel(tool)} (major ${major}); bản mới hơn server có thể sinh lệnh server không hiểu (vd SET transaction_timeout)`,
  );
  return [tool, text];
}

export function findOpenssl(env: Env = process.env): string | null {
  const w = io.which('openssl', env);
  if (w) return w;
  for (const p of [
    'C:/Program Files/Git/usr/bin/openssl.exe',
    'C:/Program Files/Git/mingw64/bin/openssl.exe',
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

// ------------------------------------------------------------ manifest + retention

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Manifest hợp lệ (đủ key, format=1, `file` khớp tên manifest — chặn manifest trỏ file ngoài thư
 * mục, created_at có múi giờ) hoặc null. */
export function loadManifest(path: string): (Manifest & { _created: Date }) | null {
  const name = path.split(/[\\/]/).pop() as string;
  if (!name.endsWith(MANIFEST_SUFFIX)) return null;
  const fname = name.slice(0, -MANIFEST_SUFFIX.length);
  if (!NAME_RE.test(fname)) return null;
  let m: unknown;
  try {
    m = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );
  } catch {
    return null;
  }
  // Python `m.get("format") != 1`: True == 1 cũng hợp lệ.
  if (!isDict(m) || !(m.format === 1 || m.format === true) || m.file !== fname) return null;
  if (!MANIFEST_KEYS.every((k) => Object.hasOwn(m as object, k)) || !isDict(m.row_counts)) {
    return null;
  }
  if (typeof m.created_at !== 'string') return null;
  const dt = fromIsoformat(m.created_at);
  if (dt === null || dt.offUs === null) return null;
  return { ...(m as Manifest), _created: toDate(dt) };
}

const cmpDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/** [(created, manifest_path, manifest)] mới nhất trước (trùng thời điểm → theo tên giảm dần). */
export function validManifests(dir: string, dbName?: string | null): ManifestEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ManifestEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(MANIFEST_SUFFIX)) continue;
    const p = join(dir, n);
    const m = loadManifest(p);
    if (m && (dbName === undefined || dbName === null || m.db_name === dbName)) {
      out.push({ created: m._created, path: p, m });
    }
  }
  return out.sort((a, b) => b.created.getTime() - a.created.getTime() || cmpDesc(a.path, b.path));
}

/** Giữ `keep` bản mới nhất theo created_at; xóa cặp dump+manifest cũ. → [đã xóa, lỗi]: 1 file bị
 * khóa/thiếu quyền không chặn bản khác, không làm hỏng lần backup vừa xong. */
export function applyRetention(dir: string, keep: number, dbName: string): [string[], string[]] {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const { path, m } of validManifests(dir, dbName).slice(keep)) {
    try {
      for (const p of [join(dir, m.file), path]) {
        try {
          io.unlink(p);
        } catch (e) {
          if ((e as { code?: string }).code !== 'ENOENT') throw e;
        }
      }
    } catch (e) {
      errors.push(`${m.file}: ${strerror(e)}`);
      continue;
    }
    removed.push(m.file);
  }
  return [removed, errors];
}

/** openssl `-pass file:` chỉ lấy DÒNG ĐẦU và đọc như chuỗi C (dừng ở NUL): dòng đầu trống/ngắn →
 * mã hóa bằng khóa rỗng/yếu mà manifest vẫn ghi `encrypted`; file UTF-16 (PowerShell 5.1 `>`/Notepad
 * 'Unicode') dài >16 byte nhưng khóa thật ~3 byte → từ chối NUL/BOM UTF-16. Vi phạm → UsageError. */
export function checkPassfile(path: string): void {
  const raw = readFileSync(path);
  const nl = raw.indexOf(0x0a);
  let first = nl === -1 ? raw : raw.subarray(0, nl);
  let end = first.length;
  while (end > 0 && first[end - 1] === 0x0d) end--;
  first = first.subarray(0, end);
  if (
    first.includes(0x00) ||
    (first[0] === 0xff && first[1] === 0xfe) ||
    (first[0] === 0xfe && first[1] === 0xff)
  ) {
    throw new UsageError(
      'dòng đầu BACKUP_PASSPHRASE_FILE chứa NUL/BOM UTF-16 — file passphrase phải là UTF-8/ASCII (openssl cắt khóa ở byte NUL)',
    );
  }
  // Python `bytes.strip()` = khoảng trắng ASCII.
  const blank = first.every((b) => b === 0x20 || (b >= 0x09 && b <= 0x0d));
  if (blank || first.length < MIN_PASSPHRASE) {
    throw new UsageError(
      `dòng đầu BACKUP_PASSPHRASE_FILE trống hoặc ngắn hơn ${MIN_PASSPHRASE} ký tự (openssl chỉ dùng dòng đầu)`,
    );
  }
}

// ------------------------------------------------------------ cấu hình

export type Offsite = readonly ['dir', string] | readonly ['s3', string];
export type BackupConfig = {
  dir: string;
  keep: number;
  passfile: string | null;
  offsite: Offsite | null;
};

const flag = (env: Env, name: string) => pyStrip(env[name] ?? '') === '1';

/** Hai đường (thư mục gần nhất đang tồn tại) cùng thiết bị lưu trữ (`st_dev`)? Khác thiết bị KHÔNG
 * chứng minh khác máy — chỉ là điều kiện cần; máy offsite thật do Bên B xác nhận. */
export function sameDevice(a: string, b: string): boolean {
  const dev = (p: string): number => {
    let cur = pyResolve(p);
    for (;;) {
      try {
        return statSync(cur).dev;
      } catch {
        const parent = join(cur, '..');
        const up = pyResolve(parent);
        if (up === cur) return statSync(cur).dev;
        cur = up;
      }
    }
  };
  return dev(a) === dev(b);
}

/** Kiểm usage TRƯỚC khi connect; vi phạm → UsageError (exit 2). */
export function readConfig(
  env: Env = process.env,
  log: (s: string) => void = console.log,
): BackupConfig {
  const dir = dirOutsideRepo(env.BACKUP_DIR, 'BACKUP_DIR');
  const rawKeep = pyStrip(env.BACKUP_KEEP ?? '7') || '7';
  if (!/^\p{Nd}+$/u.test(rawKeep) || pyDigitsInt(rawKeep) < 1) {
    throw new UsageError('BACKUP_KEEP phải là số nguyên ≥ 1');
  }
  let passfile: string | null = null;
  if (env.BACKUP_PASSPHRASE_FILE) {
    passfile = dirOutsideRepo(env.BACKUP_PASSPHRASE_FILE, 'BACKUP_PASSPHRASE_FILE');
    if (!isFile(passfile)) throw new UsageError('BACKUP_PASSPHRASE_FILE không tồn tại');
    checkPassfile(passfile);
  }
  if (passfile === null && flag(env, 'BACKUP_REQUIRE_ENCRYPTION')) {
    // r13 (data_platform-90): server Bên B bật cờ này → KHÔNG bao giờ ghi bản rõ.
    throw new UsageError(
      'BACKUP_REQUIRE_ENCRYPTION=1 nhưng chưa có BACKUP_PASSPHRASE_FILE — không ghi bản chưa mã hóa',
    );
  }
  const off = pyStrip(env.BACKUP_OFFSITE ?? '');
  let offsite: Offsite | null = null;
  if (off.startsWith('dir:')) {
    offsite = ['dir', dirOutsideRepo(off.slice(4), 'BACKUP_OFFSITE dir:')];
    if (sameDevice(dir, offsite[1])) {
      // r13: cùng thiết bị lưu trữ với BACKUP_DIR = chưa phải offsite.
      if (flag(env, 'BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE')) {
        throw new UsageError(
          'BACKUP_OFFSITE cùng thiết bị lưu trữ với BACKUP_DIR — không phải bản sao ngoài máy',
        );
      }
      log(
        '[warn] BACKUP_OFFSITE cùng thiết bị lưu trữ với BACKUP_DIR (st_dev) — chưa phải offsite thật',
      );
    }
  } else if (off.startsWith('s3://')) {
    offsite = ['s3', off];
  } else if (off) {
    throw new UsageError('BACKUP_OFFSITE phải là dir:<path> hoặc s3://...');
  }
  return { dir, keep: pyDigitsInt(rawKeep), passfile, offsite };
}

// ------------------------------------------------------------ backup

/** Đếm `count(*)` mọi bảng public (gọi trong tx snapshot). */
export async function snapshotCounts(
  c: Pick<pg.ClientBase, 'query'>,
): Promise<Record<string, number>> {
  const { rows } = await c.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  const out: Record<string, number> = {};
  for (const { table_name: t } of rows) {
    const r = await c.query<{ n: string }>(
      `select count(*) as n from "${t.replaceAll('"', '""')}"`,
    );
    out[t] = Number(r.rows[0]?.n);
  }
  return out;
}

export type BackupRec = {
  ts: string;
  status: 'fail' | 'ok' | 'offsite_fail';
  file: string | null;
  size_bytes: number | null;
  sha256: string | null;
  offsite: string | null;
  error: string | null;
  retention_error: string | null;
};

const newRec = (): BackupRec => ({
  ts: vnIso(vnNow()),
  status: 'fail',
  file: null,
  size_bytes: null,
  sha256: null,
  offsite: null,
  error: null,
  retention_error: null,
});

/** Chép sang thư mục offsite; → [mô tả, lỗi retention]. Kiểm sha256 bản dump TRƯỚC khi đổi tên →
 * offsite không bao giờ có cặp dump hỏng + manifest; `.partial` dở bị xóa. */
function offsiteCopy(
  cfg: BackupConfig,
  files: string[],
  sha: string,
  db: string,
): [string, string[]] {
  const [kind, target] = cfg.offsite as Offsite;
  if (kind === 's3') {
    throw new RuntimeErr(
      '[external-dep] offsite S3-compatible (Bizfly/Backblaze) chưa bật — cần key + công cụ rclone/aws-cli',
    );
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  files.forEach((src, i) => {
    const name = src.split(/[\\/]/).pop() as string;
    const tmp = join(target, `${name}.partial`);
    try {
      io.copyFile(src, tmp);
      if (i === 0 && sha256File(tmp) !== sha)
        throw new RuntimeErr('sha256 bản offsite lệch manifest');
      renameSync(tmp, join(target, name)); // Python os.replace
    } finally {
      unlinkQuiet(tmp);
    }
  });
  const [, errors] = applyRetention(target, cfg.keep, db);
  return ['dir', errors];
}

/** Python `psycopg.Error` khi ghi bằng chứng → lý do (message chính của Postgres | tên lớp lỗi). */
function evidenceWhy(e: unknown, dsn: string): string {
  const code = (e as { code?: unknown }).code;
  const primary =
    typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? (e as Error).message : null;
  return scrub(primary ?? 'OperationalError', dsn);
}

/** v15 fix P8.7c: ghi bằng chứng lần backup `ok` vào DB (kết nối ghi riêng — kết nối dump là read
 * only) → null | lý do lỗi (đã che DSN). Chuỗi gửi = JSON sort key của ĐÚNG bản ghi nhật ký. */
export async function recordEvidence(
  dsn: string,
  rec: BackupRec,
  env: Env = process.env,
): Promise<string | null> {
  const text = pyDumps(rec, true);
  let pool: pg.Pool | null = null;
  try {
    pool = createPool(dsn, { max: 1, connectionTimeoutMillis: settings.connectTimeoutMs }, env);
    await pool.query('select file_output_evidence_backup($1, false)', [text]);
  } catch (e) {
    if (!isDbError(e) && !(e instanceof DbConfigError)) throw e;
    return evidenceWhy(e, dsn);
  } finally {
    await pool?.end().catch(() => {});
  }
  return null;
}

async function withEvidence(
  code: number,
  rec: BackupRec,
  dsn: string,
  env: Env,
): Promise<[number, BackupRec]> {
  const why = await recordEvidence(dsn, rec, env);
  if (why === null) {
    console.log('[evidence] đã ghi bằng chứng đầu ra vào DB (file_output_evidence)');
    return [code, rec];
  }
  console.log(`[warn] backup xong nhưng CHƯA ghi được bằng chứng DB: ${why}`);
  return [4, rec];
}

/** Thực hiện backup; → [exit_code, bản ghi backup_runs]. */
export async function runBackup(
  cfg: BackupConfig,
  dsn: string,
  env: Env = process.env,
): Promise<[number, BackupRec]> {
  const bdir = cfg.dir;
  const rec = newRec();
  const partials: string[] = [];
  let final = '';
  let dest = '';
  let mpath = '';
  let sha = '';
  let db = '';
  let tool: Tool | null = null;
  let counts: Record<string, number> = {};
  let size = 0;
  try {
    const pool = createPool(
      dsn,
      { max: 1, connectionTimeoutMillis: settings.connectTimeoutMs },
      env,
    );
    let plain = '';
    let created = new Date(0);
    let serverVersion = '';
    let dumpVer = '';
    try {
      const c = await pool.connect();
      // Mất kết nối khi client đang rảnh (pg_dump chạy tới 1 giờ) → pg phát 'error'; không ai nghe
      // = sập tiến trình, .partial bản rõ nằm lại. Ghi lại, ném ra sau pg_dump như psycopg.Error.
      let lost: Error | null = null;
      c.on('error', (e) => {
        lost ??= e;
      });
      try {
        await c.query('begin isolation level repeatable read read only');
        serverVersion = String((await c.query('show server_version')).rows[0]?.server_version);
        const v = await c.query<{ n: number; db: string }>(
          "select current_setting('server_version_num')::int as n, current_database() as db",
        );
        const serverMajor = Math.floor(Number(v.rows[0]?.n) / 10000);
        db = String(v.rows[0]?.db);
        const penv = pgEnv(dsn, db, env);
        [tool, dumpVer] = await resolveTool('pg_dump', serverMajor, penv);
        if (cfg.passfile && !settings.findOpenssl(env)) {
          throw new RuntimeErr(
            'có BACKUP_PASSPHRASE_FILE nhưng không tìm thấy openssl — từ chối ghi bản rõ',
          );
        }
        const snap = String((await c.query('select pg_export_snapshot() as s')).rows[0]?.s);
        counts = await snapshotCounts(c);
        created = vnNow();
        const safeDb = db.replace(/[^A-Za-z0-9_-]/gu, '_');
        const base = `${safeDb}_${vnFormat(created, '%Y%m%d_%H%M%S')}_vn.dump`;
        final = base + (cfg.passfile ? '.enc' : '');
        for (const n of [base, `${base}.enc`, final + MANIFEST_SUFFIX]) {
          if (exists(join(bdir, n))) throw new RuntimeErr(`file đích đã tồn tại: ${n}`);
        }
        rec.file = final;
        plain = join(bdir, `${base}.partial`);
        partials.push(plain);
        const r = await io.run(
          toolArgv(tool, 'pg_dump', ['-Fc', `--snapshot=${snap}`, '--no-password'], penv),
          { env: penv, timeoutMs: DUMP_TIMEOUT_MS, stdoutFile: plain },
        );
        if (r.code !== 0)
          throw new RuntimeErr(`pg_dump exit ${r.code}: ${r.stderr.toString('utf8')}`);
        if (lost) throw lost;
        await c.query('rollback');
      } finally {
        c.release();
      }
    } finally {
      await pool.end().catch(() => {});
    }
    if (!hasMagic(plain)) throw new RuntimeErr('file dump không có magic PGDMP');
    let out = plain;
    if (cfg.passfile) {
      const enc = join(bdir, `${final}.partial`);
      partials.push(enc);
      const r = await io.run(
        [
          settings.findOpenssl(env) as string,
          ...OPENSSL_ENC,
          '-pass',
          `file:${cfg.passfile}`,
          '-in',
          plain,
          '-out',
          enc,
        ],
        { timeoutMs: DUMP_TIMEOUT_MS },
      );
      if (r.code !== 0) throw new RuntimeErr(`openssl enc lỗi: ${r.stderr.toString('utf8')}`);
      io.unlink(plain);
      out = enc;
    }
    dest = join(bdir, final);
    if (exists(dest)) throw new RuntimeErr(`file đích đã tồn tại: ${final}`);
    renameSync(out, dest);
    partials.splice(partials.indexOf(out), 1);
    partials.push(dest); // lỗi trước khi có manifest → không để mồ côi
    sha = sha256File(dest);
    size = statSync(dest).size;
    const manifest: Manifest = {
      format: 1,
      created_at: vnIso(created),
      db_name: db,
      server_version: serverVersion,
      pg_dump_version: dumpVer,
      tool: toolLabel(tool as Tool),
      file: final,
      size_bytes: size,
      sha256: sha,
      encrypted: Boolean(cfg.passfile),
      cipher: cfg.passfile ? CIPHER : null,
      row_counts: counts,
    };
    mpath = join(bdir, final + MANIFEST_SUFFIX);
    writeJsonAtomic(mpath, manifest);
    partials.splice(partials.indexOf(dest), 1);
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    rec.error = scrub(e, dsn);
    console.log(`[err] backup lỗi: ${rec.error}`);
    return [1, rec];
  } finally {
    for (const p of partials) unlinkQuiet(p); // bản rõ/dở không bao giờ nằm lại
  }

  Object.assign(rec, { status: 'ok', size_bytes: size, sha256: sha });
  console.log(
    `[done] ${final} — ${size} bytes, sha256 ${sha.slice(0, 16)}…, tool ${toolLabel(tool as Tool)}, ${Object.keys(counts).length} bảng`,
  );
  if (!cfg.passfile) console.log('[warn] backup CHƯA mã hóa (external-dep: khóa công ty)');
  const retErrors: string[] = [];
  // Dọn bản cũ lỗi KHÔNG làm hỏng bản vừa xong: cảnh báo + ghi nhật ký, vẫn chạy offsite + nhật ký.
  const noteRetention = (where: string, errors: string[]) => {
    for (const err of errors) {
      retErrors.push(scrub(`${where} ${err}`, dsn));
      console.log(`[warn] retention lỗi: ${retErrors.at(-1)}`);
    }
    rec.retention_error = [...retErrors.join('; ')].slice(0, 300).join('') || null;
  };
  const [removed, errors] = applyRetention(bdir, cfg.keep, db);
  noteRetention('local', errors);
  if (removed.length) console.log(`[retention] giữ ${cfg.keep} bản, xóa: ${removed.join(', ')}`);
  if (cfg.offsite === null) {
    console.log('[warn] chưa cấu hình offsite (BACKUP_OFFSITE)');
    return withEvidence(0, rec, dsn, env);
  }
  let offErrors: string[];
  try {
    const [desc, errs] = offsiteCopy(cfg, [dest, mpath], sha, db);
    rec.offsite = desc;
    offErrors = errs;
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    Object.assign(rec, { status: 'offsite_fail', error: scrub(e, dsn) });
    console.log(`[warn] offsite chưa xong, bản local giữ nguyên: ${rec.error}`);
    return [3, rec];
  }
  noteRetention('offsite', offErrors);
  console.log('[offsite] đã chép + kiểm sha256');
  return withEvidence(0, rec, dsn, env);
}

/** Điểm thay được trong test (Python monkeypatch `bk.run_backup`). */
export const backupDeps = { runBackup };

/** `python scripts/db_backup.py` → exit code. */
export async function backupMain(env: Env = process.env): Promise<number> {
  return privateUmask(async () => {
    let cfg: BackupConfig;
    try {
      cfg = readConfig(env);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.log(`[usage] ${e.message}`);
      return 2;
    }
    const dsn = env.DATABASE_URL;
    mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
    let code: number;
    let rec: BackupRec;
    if (!dsn) {
      [code, rec] = [1, { ...newRec(), error: 'thiếu DATABASE_URL' }];
      console.log('[err] thiếu DATABASE_URL (biến môi trường tiến trình — TS không nạp .env)');
    } else {
      [code, rec] = await backupDeps.runBackup(cfg, dsn, env);
    }
    appendJsonl(join(cfg.dir, 'backup_runs.jsonl'), rec);
    return code;
  });
}
