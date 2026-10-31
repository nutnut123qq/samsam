import { accessSync, constants, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createPool, DbConfigError, privilegedLogin, SERVICES } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import { vnFormat } from '@samsam/core/ops/period';
import { fromIsoformat, toDate } from '@samsam/core/ops/py-date';
import { pyFixed } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { REPO_ROOT } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import type pg from 'pg';
import {
  type BackupConfig,
  loadManifest,
  MANIFEST_SUFFIX,
  type Manifest,
  readConfig,
  sameDevice,
} from './backup.js';
import { conninfo, fmtG, io, isDir, isFile, pyFloat, sha256File, UsageError } from './common.js';

// Port `scripts/onprem_preflight.py` (r13 data_platform-90) — kiểm SẴN SÀNG hạ tầng on-prem trên CHÍNH
// máy chạy lệnh; chỉ báo ĐẠT cho điều kiện ĐO ĐƯỢC lúc chạy; không đọc bằng chứng cũ/tệp mẫu, không
// sửa gì. Chỉ đọc biến môi trường TIẾN TRÌNH (không `.env`, không DSN mặc định). Mục ngoài máy (máy
// chủ vật lý/UPS, máy giám sát độc lập, máy offsite khác, người giữ tài khoản cao nhất) luôn
// CHUA_XAC_NHAN (Bên B ký). Exit: 0 mọi mục ĐO được ĐẠT · 1 có mục đo được CHƯA ĐẠT · 2 tham số sai.
// KHÁC Python có chủ đích: đo thêm login dịch vụ `ui` (UI_DATABASE_URL — web/API TS đọc bằng svc_ui).

export const NGOAI = [
  'may chu vat ly + UPS',
  'may giam sat DOC LAP (ngoai server)',
  'may offsite la MAY KHAC',
  'nguoi giu tai khoan cao nhat',
];
/** Sổ ghi muộn hơn giờ máy quá mức này = thời điểm tương lai, không phải bản mới. */
export const CLOCK_SKEW_H = 5 / 60;

export type Row = readonly [
  key: string,
  status: 'DAT' | 'CHUA_DAT' | 'KHONG_AP_DUNG',
  note: string,
];

export function machineId(): string {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      return pyStrip(readFileSync(p, 'utf8')).slice(0, 32);
    } catch {
      // thử tệp kế
    }
  }
  return 'khong-co';
}

async function connectOnce<T>(
  dsn: string,
  env: Env,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = createPool(dsn, { max: 1, connectionTimeoutMillis: 5000 }, env);
  try {
    const c = await pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Python `type(e).__name__` cho lỗi kết nối/truy vấn psycopg (DSN sai dạng → ProgrammingError). */
function dbErrName(e: unknown): string {
  if (e instanceof DbConfigError) return 'ProgrammingError';
  return pgErrName(e);
}

export async function checkDb(env: Env): Promise<[Row['1'], string, number | null]> {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) return ['CHUA_DAT', 'thiếu DATABASE_URL', null];
  if (!conninfo(dsn).dbname) return ['CHUA_DAT', 'DATABASE_URL thiếu dbname tường minh', null];
  let major: number;
  try {
    major = await connectOnce(dsn, env, async (c) => {
      const r = await c.query<{ n: number }>(
        "select current_setting('server_version_num')::int as n",
      );
      return Math.floor(Number(r.rows[0]?.n) / 10000);
    });
  } catch (e) {
    if (!isDbError(e) && !(e instanceof DbConfigError)) throw e;
    return ['CHUA_DAT', `không kết nối được (${dbErrName(e)})`, null];
  }
  const pgBin = pyStrip(env.PG_BIN ?? '');
  const cands = pgBin ? [join(pgBin, 'pg_dump')] : [];
  const w = io.which('pg_dump', env);
  if (w) cands.push(w);
  cands.push(join(`C:/Program Files/PostgreSQL/${major}/bin/pg_dump.exe`));
  const withExe = (p: string) =>
    /\.[^\\/.]*$/.test(p) ? p.replace(/\.[^\\/.]*$/, '.exe') : `${p}.exe`;
  const found = cands.find((c) => isFile(c) || isFile(withExe(c))) ?? null;
  const note = `server PG ${major}; pg_dump: ${found ?? 'không tìm thấy (PG_BIN/PATH)'}`;
  return [found ? 'DAT' : 'CHUA_DAT', note, major];
}

export async function checkServices(env: Env): Promise<Row[]> {
  const out: Row[] = [];
  for (const [svc, { envVar, role }] of Object.entries(SERVICES)) {
    const key = `dich_vu:${svc}`;
    const dsn = pyStrip(env[envVar] ?? '');
    if (!dsn) {
      out.push([key, 'CHUA_DAT', `thiếu ${envVar}`]);
      continue;
    }
    let bad: string | null;
    let member: boolean;
    try {
      [bad, member] = await connectOnce(dsn, env, async (c) => {
        const b = await privilegedLogin(c);
        const r = await c.query<{ m: boolean }>(
          "select pg_has_role(current_user, $1, 'member') as m",
          [role],
        );
        return [b, r.rows[0]?.m === true] as const;
      });
    } catch (e) {
      if (!isDbError(e) && !(e instanceof DbConfigError)) throw e;
      out.push([key, 'CHUA_DAT', `${envVar}: không kết nối được (${dbErrName(e)})`]);
      continue;
    }
    if (bad) out.push([key, 'CHUA_DAT', `${envVar}: ${bad}`]);
    else if (!member) out.push([key, 'CHUA_DAT', `${envVar}: login không thuộc role ${role}`]);
    else out.push([key, 'DAT', `${envVar}: login riêng thuộc ${role}`]);
  }
  return out;
}

/** Đo tệp dump THẬT trong `folder` so manifest (size_bytes + sha256). */
function copyProblems(folder: string, m: Manifest, where: string): string[] {
  const f = join(folder, m.file);
  if (!isFile(f)) return [`${where}: thiếu tệp dump ${m.file}`];
  if (statSync(f).size !== m.size_bytes) return [`${where}: kích thước tệp dump lệch manifest`];
  if (sha256File(f) !== m.sha256) return [`${where}: sha256 tệp dump lệch manifest`];
  return [];
}

const pyStrOrNone = (v: unknown) => (v === undefined || v === null ? 'None' : String(v));

/** r13-fix4 F3: bản gần nhất trong sổ chỉ ĐẠT khi tệp dump + manifest tồn tại và khớp ở CẢ BACKUP_DIR
 * lẫn offsite `dir:` cấu hình — sổ/manifest một mình không chứng minh có bản sao. */
export function latestProblems(
  d: string,
  off: BackupConfig['offsite'],
  last: Record<string, unknown>,
  maxAgeH: number,
  now: Date,
): string[] {
  const probs: string[] = [];
  if (last.status !== 'ok') probs.push(`status=${pyStrOrNone(last.status)}`);
  const dt = fromIsoformat(last.ts === undefined || last.ts === null ? 'None' : String(last.ts));
  // naive → coi như UTC (Python `replace(tzinfo=timezone.utc)`).
  const age = dt === null ? null : (now.getTime() - toDate(dt).getTime()) / 3600_000;
  if (age === null) probs.push('thời điểm trong sổ không đọc được');
  else if (age < -CLOCK_SKEW_H)
    probs.push(`thời điểm trong sổ ở tương lai (${pyFixed(-age, 1)} giờ)`);
  else if (age > maxAgeH) probs.push(`cách ${pyFixed(age, 1)} giờ (> ${fmtG(maxAgeH)})`);
  if (last.offsite === undefined || last.offsite === null) probs.push('sổ chưa ghi offsite xong');
  const fname = last.file;
  const m =
    typeof fname === 'string' && fname ? loadManifest(join(d, fname + MANIFEST_SUFFIX)) : null;
  if (m === null) return [...probs, 'manifest local thiếu/hỏng — không kiểm được tệp dump'];
  if (m.encrypted !== true) probs.push('bản dump chưa mã hóa');
  if (!(last.sha256 === undefined || last.sha256 === null || last.sha256 === m.sha256)) {
    probs.push('sha256 trong sổ lệch manifest');
  }
  probs.push(...copyProblems(d, m, 'local'));
  if (off === null || off[0] !== 'dir') {
    return [...probs, 'chưa cấu hình offsite dir: — không kiểm được bản sao'];
  }
  const om = loadManifest(join(off[1], (fname as string) + MANIFEST_SUFFIX));
  if (om === null || om.sha256 !== m.sha256 || om.size_bytes !== m.size_bytes) {
    probs.push('offsite: manifest thiếu/hỏng/lệch bản local');
  }
  return [...probs, ...copyProblems(off[1], m, 'offsite')];
}

/** Bản ghi cuối là object trong `backup_runs.jsonl` (dòng hỏng bỏ qua). */
function lastRecord(log: string): Record<string, unknown> | null {
  if (!isFile(log)) return null;
  let last: Record<string, unknown> | null = null;
  const raw = readFileSync(log);
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf(0x0a, start);
    if (end === -1) end = raw.length;
    let line = raw.subarray(start, end);
    start = end + 1;
    // json.loads(bytes): BOM utf-8 được chấp nhận; byte lỗi/dòng rỗng → bỏ.
    if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) line = line.subarray(3);
    try {
      const rec: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) {
        last = rec as Record<string, unknown>;
      }
    } catch {
      // dòng hỏng
    }
  }
  return last;
}

export function checkBackup(
  env: Env,
  minFreeGb: number,
  maxAgeH: number,
  now: Date,
  log: (s: string) => void = console.log,
): Row[] {
  const out: Row[] = [];
  let cfg: BackupConfig;
  try {
    cfg = readConfig(env, log);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    return [['sao_luu:cau_hinh', 'CHUA_DAT', e.message]];
  }
  const d = cfg.dir;
  let okDir = isDir(d);
  if (okDir) {
    try {
      accessSync(d, constants.W_OK);
    } catch {
      okDir = false;
    }
  }
  let free = 0;
  if (isDir(d)) {
    const s = statfsSync(d);
    free = (Number(s.bavail) * Number(s.bsize)) / 2 ** 30;
  }
  out.push([
    'sao_luu:thu_muc',
    okDir && free >= minFreeGb ? 'DAT' : 'CHUA_DAT',
    `tồn tại+ghi được: ${okDir ? 'True' : 'False'}; trống ${pyFixed(free, 1)} GB (cần ≥ ${fmtG(minFreeGb)})`,
  ]);
  const enc = cfg.passfile !== null && pyStrip(env.BACKUP_REQUIRE_ENCRYPTION ?? '') === '1';
  out.push([
    'sao_luu:ma_hoa_bat_buoc',
    enc ? 'DAT' : 'CHUA_DAT',
    enc ? 'BACKUP_REQUIRE_ENCRYPTION=1 + có tệp khóa' : 'chưa bắt buộc mã hóa / thiếu tệp khóa',
  ]);
  const off = cfg.offsite;
  if (off === null || off[0] !== 'dir') {
    out.push(['sao_luu:offsite', 'CHUA_DAT', 'chưa cấu hình offsite dir: (s3 chưa hỗ trợ)']);
  } else {
    const other = !preflightDeps.sameDevice(d, off[1]);
    out.push([
      'sao_luu:offsite',
      other ? 'DAT' : 'CHUA_DAT',
      other ? 'offsite khác thiết bị lưu trữ' : 'offsite CÙNG thiết bị với BACKUP_DIR',
    ]);
  }
  const last = lastRecord(join(d, 'backup_runs.jsonl'));
  if (last === null) {
    out.push(['sao_luu:ban_gan_nhat', 'CHUA_DAT', 'chưa có bản backup nào trong sổ']);
  } else {
    const probs = latestProblems(d, off, last, maxAgeH, now);
    out.push([
      'sao_luu:ban_gan_nhat',
      probs.length ? 'CHUA_DAT' : 'DAT',
      probs.length
        ? probs.join('; ')
        : `status=ok; ${pyStrOrNone(last.file)} mã hóa; dump local + offsite đo khớp size/sha256 manifest`,
    ]);
  }
  return out;
}

const OS_NAME: Record<string, string> = { win32: 'Windows', linux: 'Linux', darwin: 'Darwin' };

export function checkTimers(platform: string = process.platform, etc = '/etc/systemd/system'): Row {
  const sys = OS_NAME[platform] ?? platform;
  if (sys !== 'Linux') {
    return ['lich:systemd', 'KHONG_AP_DUNG', `hệ điều hành ${sys} — không phải server systemd`];
  }
  const jobs = JSON.parse(
    readFileSync(join(REPO_ROOT, 'deploy', 'onprem', 'jobs.json'), 'utf8'),
  ) as {
    jobs: Record<string, unknown>;
  };
  const names = Object.keys(jobs.jobs).filter((k) => !k.startsWith('_'));
  const missing = names.filter((n) => !isFile(join(etc, `samsam-job-${n}.timer`)));
  return [
    'lich:systemd',
    missing.length ? 'CHUA_DAT' : 'DAT',
    missing.length
      ? `thiếu ${missing.length} timer: ${missing.slice(0, 8).join(', ')}`
      : 'đủ timer',
  ];
}

/** Điểm thay được trong test (Python monkeypatch `db_backup.same_device`). */
export const preflightDeps = { sameDevice };

export type PreflightOpts = { out?: string; minFreeGb?: string; maxBackupAgeH?: string };

/** `python scripts/onprem_preflight.py [--out FILE.md] [--min-free-gb 50] [--max-backup-age-h 26]`. */
export async function preflightMain(
  opts: PreflightOpts = {},
  env: Env = process.env,
  now: Date = io.now(),
): Promise<number> {
  const minFree = opts.minFreeGb === undefined ? 50 : pyFloat(opts.minFreeGb);
  const maxAge = opts.maxBackupAgeH === undefined ? 26 : pyFloat(opts.maxBackupAgeH);
  if (minFree === null || maxAge === null) {
    console.error('[err] --min-free-gb / --max-backup-age-h phải là số');
    return 2;
  }
  // Python `ap.error`: NaN qua được so sánh `< 0` / `<= 0` (giữ nguyên ngữ nghĩa).
  if (minFree < 0 || maxAge <= 0) {
    console.error('[err] ngưỡng không hợp lệ');
    return 2;
  }
  const [dbSt, dbNote] = await checkDb(env);
  const rows: Row[] = [
    ['db', dbSt, dbNote],
    ...(await checkServices(env)),
    ...checkBackup(env, minFree, maxAge, now),
    checkTimers(),
  ];
  const bad = rows.filter((r) => r[1] === 'CHUA_DAT');
  const stamp = vnFormat(new Date(now.getTime() - 7 * 3600_000), '%Y-%m-%d %H:%M');
  const head = [
    `# Preflight on-prem — ${hostname()} (machine-id ${machineId()}) · ${stamp}Z`,
    '',
    '| Mục | Kết quả | Chi tiết (đo tại máy này) |',
    '|---|---|---|',
  ];
  const body = rows.map(([k, st, note]) => `| ${k} | ${st} | ${note} |`);
  const tail = [
    '',
    `Không đo được từ trong máy — CHUA_XAC_NHAN (Bên B ký biên bản): ${NGOAI.join('; ')}`,
    '',
    bad.length
      ? `KẾT LUẬN: CHƯA SẴN SÀNG — ${bad.length} mục đo được chưa đạt`
      : 'KẾT LUẬN: mọi mục đo được ĐẠT — vẫn CHƯA sẵn sàng tới khi Bên B xác nhận các mục trên',
  ];
  const text = `${[...head, ...body, ...tail].join('\n')}\n`;
  if (opts.out) writeFileSync(opts.out, text, 'utf8');
  console.log(text);
  return bad.length ? 1 : 0;
}
