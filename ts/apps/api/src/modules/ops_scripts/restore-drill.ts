import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { vnFormat } from '@samsam/core/ops/period';
import { pyStr } from '@samsam/core/security/py';
import type pg from 'pg';
import {
  settings as bkSettings,
  checkPassfile,
  hasMagic,
  loadManifest,
  MANIFEST_SUFFIX,
  type Manifest,
  OPENSSL_ENC,
  resolveTool,
  snapshotCounts,
  toolArgv,
  validManifests,
} from './backup.js';
import {
  conninfo,
  io,
  isExpectedError,
  isFile,
  pgEnv,
  pyNum,
  RuntimeErr,
  round2,
  scrub,
  sha256File,
  UsageError,
  unlinkQuiet,
  vnIso,
  vnNow,
  withDb,
} from './common.js';

// Port phần LÕI của `scripts/db_restore_drill.py` (v3.6) mà `dr_drill.py` gọi lại (`run_drill(...,
// drill_server=)`): guard tên → chọn manifest → sha256 → giải mã → `create database` → pg_restore →
// đếm so `row_counts` → LUÔN drop DB tạm. CLI `db_restore_drill.py` giữ ở Python (KE_HOACH mục 3);
// job `restore_drill` vẫn chạy bước Python. KHÁC Python có chủ đích: DSN server diễn tập phải là URL
// (`pg` không nhận chuỗi key=value) và có tên DB tường minh (createPool).

export const DRILL_RE = /^samsam_drill_[0-9a-z_]+$/;
export const RESTORE_TIMEOUT_MS = 3600_000;

/** Guard từ chối (exit 2). */
export class Refuse extends Error {
  override name = 'Refuse';
}

export function defaultTarget(): string {
  return `samsam_drill_${vnFormat(vnNow(), '%Y%m%d_%H%M%S')}_${randomBytes(2).toString('hex')}`;
}

/** Guard tên (không cần DB): mẫu drill + khác mọi DB đang dùng (so tên, không theo host). */
export function guardName(target: string, dsns: readonly string[]): void {
  if (!DRILL_RE.test(target)) {
    throw new Refuse(`tên đích '${target}' không khớp ^samsam_drill_[0-9a-z_]+$`);
  }
  for (const d of dsns) {
    if (target === conninfo(d).dbname) throw new Refuse(`tên đích '${target}' trùng DB đang dùng`);
  }
}

async function admin<T>(dsn: string, env: Env, fn: (p: pg.Pool) => Promise<T>): Promise<T> {
  const pool = createPool(
    dsn,
    { max: 1, connectionTimeoutMillis: bkSettings.connectTimeoutMs },
    env,
  );
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function dbExists(
  adminDsn: string,
  name: string,
  env: Env = process.env,
): Promise<boolean> {
  return admin(adminDsn, env, async (p) => {
    const r = await p.query('select 1 from pg_database where datname = $1', [name]);
    return r.rows.length > 0;
  });
}

/** [manifest_path, manifest] — bản chỉ định hoặc mới nhất hợp lệ (manifest hỏng → cảnh báo). */
export function pickManifest(
  bdir: string,
  explicit: string | null | undefined,
  log: (s: string) => void = console.log,
): [string, Manifest] {
  if (explicit) {
    const m = loadManifest(explicit);
    const name = explicit.split(/[\\/]/).pop();
    if (m === null) throw new RuntimeErr(`manifest không hợp lệ: ${name}`);
    return [explicit, m];
  }
  let names: string[] = [];
  try {
    names = readdirSync(bdir).filter((n) => n.endsWith(MANIFEST_SUFFIX));
  } catch {
    names = [];
  }
  const found = validManifests(bdir);
  const ok = new Set(found.map((f) => f.path.split(/[\\/]/).pop()));
  for (const bad of names.filter((n) => !ok.has(n)).sort()) {
    log(`[warn] bỏ qua manifest hỏng: ${bad}`);
  }
  const first = found[0];
  if (!first) throw new RuntimeErr('không có manifest hợp lệ trong BACKUP_DIR');
  return [first.path, first.m];
}

/** Giải mã ra file tạm `drill_*.partial` trong BACKUP_DIR — luật passphrase như db_backup, kiểm
 * TRƯỚC khi gọi openssl. Lỗi → RuntimeErr (chưa tạo DB). */
export async function decrypt(
  src: string,
  passfile: string | undefined,
  bdir: string,
  env: Env = process.env,
): Promise<string> {
  if (!passfile || !isFile(passfile)) {
    throw new RuntimeErr('bản backup đã mã hóa — cần BACKUP_PASSPHRASE_FILE');
  }
  try {
    checkPassfile(passfile);
  } catch (e) {
    if (e instanceof UsageError) throw new RuntimeErr(e.message);
    throw e;
  }
  const openssl = bkSettings.findOpenssl(env);
  if (!openssl) throw new RuntimeErr('không tìm thấy openssl để giải mã');
  const tmp = join(bdir, `drill_${randomBytes(6).toString('hex')}.partial`);
  closeSync(openSync(tmp, 'wx', 0o600));
  let r: { code: number };
  try {
    r = await io.run(
      [openssl, ...OPENSSL_ENC, '-d', '-pass', `file:${passfile}`, '-in', src, '-out', tmp],
      { timeoutMs: RESTORE_TIMEOUT_MS },
    );
  } catch (e) {
    unlinkQuiet(tmp);
    throw e;
  }
  if (r.code !== 0) {
    unlinkQuiet(tmp);
    throw new RuntimeErr('giải mã lỗi (sai passphrase?)');
  }
  return tmp;
}

export async function countTables(
  dsn: string,
  env: Env = process.env,
): Promise<Record<string, number>> {
  return admin(dsn, env, async (p) => {
    const c = await p.connect();
    try {
      return await snapshotCounts(c);
    } finally {
      c.release();
    }
  });
}

/** `create database <target>` trên server diễn tập → major server. */
export async function createDb(
  adminDsn: string,
  target: string,
  env: Env = process.env,
): Promise<number> {
  return admin(adminDsn, env, async (p) => {
    const v = await p.query<{ n: number }>(
      "select current_setting('server_version_num')::int as n",
    );
    await p.query(`create database "${target}"`);
    return Math.floor(Number(v.rows[0]?.n) / 10000);
  });
}

export async function dropDb(
  adminDsn: string,
  target: string,
  env: Env = process.env,
): Promise<void> {
  await admin(adminDsn, env, (p) => p.query(`drop database if exists "${target}" with (force)`));
}

/** Điểm thay được trong test (Python monkeypatch `db_exists`/`_admin`/`count_tables`). Tên DB đã qua
 * guard `DRILL_RE` trước khi tới đây (an toàn để đặt trong dấu nháy kép). */
export const drillDeps = { dbExists, countTables, createDb, dropDb };

export type DrillRec = {
  ts: string;
  backup_file: string | null;
  drill_db: string;
  status: 'fail' | 'refused' | 'ok' | 'mismatch' | 'drop_failed';
  rto_seconds: number | null;
  tables_checked: number;
  mismatches: Record<string, [number | null, number | null]>;
  dropped: boolean | null;
  error?: string;
};

async function drop(adminDsn: string, target: string, env: Env): Promise<boolean> {
  try {
    await drillDeps.dropDb(adminDsn, target, env);
    return !(await drillDeps.dbExists(adminDsn, target, env));
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    return false;
  }
}

const fmtCell = (v: number | null | undefined, w: number) => pyStr(v ?? null).padStart(w);

/** Python `run_drill(args, bdir, dsn, drill_server=None)` → [exit, bản ghi drill_runs]. */
export async function runDrill(
  args: { backup?: string | null; targetDb?: string | null },
  bdir: string,
  dsn: string,
  drillServerArg: string | null = null,
  env: Env = process.env,
): Promise<[number, DrillRec]> {
  // v3.10: dr_drill truyền server container tạm; null → DRILL_DATABASE_URL → dsn.
  const drillServer = drillServerArg || env.DRILL_DATABASE_URL || dsn;
  const target = args.targetDb || defaultTarget();
  const rec: DrillRec = {
    ts: vnIso(vnNow()),
    backup_file: null,
    drill_db: target,
    status: 'fail',
    rto_seconds: null,
    tables_checked: 0,
    mismatches: {},
    dropped: null,
  };
  // (1) Guard trước mọi thao tác.
  try {
    guardName(target, [dsn, drillServer]);
    if (await drillDeps.dbExists(drillServer, target, env)) {
      throw new Refuse(`DB '${target}' đã tồn tại — không ghi đè`);
    }
  } catch (e) {
    if (e instanceof Refuse) {
      rec.status = 'refused';
      console.log(`[refuse] ${e.message}`);
      return [2, rec];
    }
    if (!isExpectedError(e)) throw e;
    rec.error = scrub(e, drillServer);
    console.log(`[err] không kết nối được server diễn tập: ${rec.error}`);
    return [1, rec];
  }

  let created = false;
  let tmpPlain: string | null = null;
  let code = 1;
  const drillDsn = withDb(drillServer, target);
  try {
    const [mpath, m] = pickManifest(bdir, args.backup);
    const src = join(dirname(mpath), m.file);
    rec.backup_file = m.file;
    const t0 = performance.now();
    // (2) sha256 — bản mới nhất hỏng thì FAIL, không lùi bản cũ.
    if (!isFile(src)) throw new RuntimeErr(`thiếu file dump ${m.file}`);
    if (sha256File(src) !== m.sha256) throw new RuntimeErr(`sha256 lệch manifest: ${m.file}`);
    // (3) Giải mã (nếu có) — trước khi tạo DB.
    let plain = src;
    if (m.encrypted) {
      tmpPlain = plain = await decrypt(src, env.BACKUP_PASSPHRASE_FILE, bdir, env);
    }
    if (!hasMagic(plain)) throw new RuntimeErr('file sau giải mã không phải pg_dump -Fc');
    // (4) Tạo DB tạm + restore.
    const serverMajor = await drillDeps.createDb(drillServer, target, env);
    created = true;
    const penv = pgEnv(drillServer, target, env);
    const [tool] = await resolveTool('pg_restore', serverMajor, penv);
    const r = await io.run(
      toolArgv(
        tool,
        'pg_restore',
        ['--no-owner', '--no-privileges', '--exit-on-error', '--no-password', '-d', target],
        penv,
      ),
      { env: penv, timeoutMs: RESTORE_TIMEOUT_MS, stdinFile: plain },
    );
    if (r.code !== 0)
      throw new RuntimeErr(`pg_restore exit ${r.code}: ${r.stderr.toString('utf8')}`);
    // (5) So số dòng.
    const actual = await drillDeps.countTables(drillDsn, env);
    const expected = m.row_counts;
    const all = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    const get = (o: Record<string, number>, t: string) =>
      Object.hasOwn(o, t) ? (o[t] as number) : null;
    const mism: DrillRec['mismatches'] = {};
    for (const t of all) {
      if (get(expected, t) !== get(actual, t)) mism[t] = [get(expected, t), get(actual, t)];
    }
    rec.rto_seconds = round2((performance.now() - t0) / 1000);
    rec.tables_checked = Object.keys(expected).length;
    rec.mismatches = mism;
    for (const t of all) {
      const mark = Object.hasOwn(mism, t) ? 'LỆCH' : 'khớp';
      console.log(
        `  ${t.padEnd(22)} manifest=${fmtCell(get(expected, t), 7)} thực tế=${fmtCell(get(actual, t), 7)}  ${mark}`,
      );
    }
    const okN = Object.keys(expected).filter((t) => !Object.hasOwn(mism, t)).length;
    console.log(
      `[drill] ${m.file} → ${target}: ${okN}/${Object.keys(expected).length} bảng khớp, RTO ${pyNum(rec.rto_seconds)}s`,
    );
    rec.status = Object.keys(mism).length ? 'mismatch' : 'ok';
    code = Object.keys(mism).length ? 1 : 0;
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    rec.error = scrub(e, drillServer);
    console.log(`[err] diễn tập lỗi: ${rec.error}`);
    code = 1;
  } finally {
    if (tmpPlain !== null) unlinkQuiet(tmpPlain);
    if (created) {
      rec.dropped = await drop(drillServer, target, env);
      if (!rec.dropped) {
        rec.status = 'drop_failed';
        console.log(`[ALERT] còn bản sao dữ liệu ở DB tạm ${target} — drop tay ngay`);
        code = 1;
      }
    }
  }
  return [code, rec];
}
