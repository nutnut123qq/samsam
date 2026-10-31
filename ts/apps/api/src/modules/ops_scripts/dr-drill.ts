import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import { vnFormat } from '@samsam/core/ops/period';
import { fromIsoformat, toDate } from '@samsam/core/ops/py-date';
import { pyFixed } from '@samsam/core/ops/py-json';
import { dockerHasImage, type Manifest } from './backup.js';
import {
  appendJsonl,
  dirOutsideRepo,
  fmtG,
  io,
  isDir,
  isExpectedError,
  privateUmask,
  pyFloat,
  pyNum,
  RuntimeErr,
  round2,
  scrub,
  UsageError,
  vnIso,
  vnNow,
} from './common.js';
import { pickManifest, runDrill } from './restore-drill.js';

// Port `scripts/dr_drill.py` (v3.10, F17.4) — diễn tập khôi phục thảm họa trên Postgres MỚI: 1
// container tạm từ image ĐÃ CÓ (`docker run --rm --pull never`, cổng chỉ 127.0.0.1, mật khẩu ngẫu
// nhiên qua env — không argv, data dir `--tmpfs`), khôi phục bản backup mới nhất, so số dòng, đo RTO
// (gồm dựng server) + RPO (tuổi bản backup), rồi LUÔN `docker rm -f -v` + kiểm container/volume.
// Không docker / daemon tắt / thiếu image → `[external-dep]` exit 3. Container `samsam-dr-*` sót →
// `[warn]` (không tự xóa container không phải của lần chạy này).
// Exit: 0 khớp + RPO đạt + đã dọn; 1 lệch/lỗi/RPO vượt/chưa dọn; 2 usage; 3 thiếu docker/image.

export const PREFIX = 'samsam-dr-';
export const RTO_TARGET_S = 4 * 3600;
export const DOCKER_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const DEFAULT_PGDATA = '/var/lib/postgresql/data';

/** Tuổi bản backup tại `now` (giây) — RPO nếu thảm họa xảy ra lúc đó. */
export function rpoSeconds(manifest: Pick<Manifest, 'created_at'>, now: Date): number {
  const dt = fromIsoformat(String(manifest.created_at));
  if (dt === null) throw new RangeError(`Invalid isoformat string: '${manifest.created_at}'`);
  if (dt.offUs === null) throw new RangeError('created_at/now phải có múi giờ');
  return round2((now.getTime() - toDate(dt).getTime()) / 1000);
}

/** Python `_positive`: số thực > 0 hữu hạn (rỗng → mặc định); sai → UsageError. */
export function positive(raw: string | undefined | null, dflt: string, name: string): number {
  const s = pyStrip(raw ?? '') || dflt;
  const v = pyFloat(s);
  if (v === null || !Number.isFinite(v) || v <= 0) throw new UsageError(`${name} phải là số > 0`);
  return v;
}

export function containerName(now: Date): string {
  return `${PREFIX}${vnFormat(now, '%Y%m%d_%H%M%S')}-${randomBytes(2).toString('hex')}`;
}

function docker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS, env?: Env) {
  return io.run(['docker', ...args], { timeoutMs, env });
}

const txt = (b: Buffer) => b.toString('utf8');

/** null nếu dùng được; ngược lại lý do (external-dep). */
export async function probeDocker(image: string, env: Env = process.env): Promise<string | null> {
  if (!io.which('docker', env)) return 'không có docker CLI trên PATH';
  let r: { code: number };
  try {
    r = await docker(['version', '--format', '{{.Server.Version}}'], PROBE_TIMEOUT_MS);
  } catch {
    return 'docker daemon không phản hồi';
  }
  if (r.code !== 0) return 'docker daemon không chạy';
  if (!(await dockerHasImage(image, env))) {
    return `thiếu image ${image} trên máy (KHÔNG tự pull — cần duyệt)`;
  }
  return null;
}

/** Container sót theo tiền tố (mặc định DR; vector_eval dùng `samsam-vec-`). */
export async function leftovers(prefix: string = PREFIX): Promise<string[]> {
  try {
    const r = await docker(
      ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'],
      PROBE_TIMEOUT_MS,
    );
    return txt(r.stdout)
      .split(/\s+/)
      .filter((n) => n.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Đường dẫn VOLUME image khai báo (postgres = PGDATA) — mount tmpfs đè lên để dữ liệu khôi phục KHÔNG
 * chạm đĩa. Không đọc được → PGDATA mặc định. */
export async function imageVolumes(image: string): Promise<string[]> {
  let vols: unknown = null;
  try {
    const r = await docker(
      ['image', 'inspect', '-f', '{{json .Config.Volumes}}', image],
      PROBE_TIMEOUT_MS,
    );
    vols = r.code === 0 ? JSON.parse(txt(r.stdout) || 'null') : null;
  } catch {
    vols = null;
  }
  if (
    typeof vols !== 'object' ||
    vols === null ||
    Array.isArray(vols) ||
    !Object.keys(vols).length
  ) {
    return [DEFAULT_PGDATA];
  }
  return Object.keys(vols).sort();
}

/** Tên volume docker gắn vào container; rỗng nếu không có hoặc không đọc được. */
export async function containerVolumes(name: string): Promise<Set<string>> {
  const fmt = '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}';
  try {
    const r = await docker(['inspect', '-f', fmt, name], PROBE_TIMEOUT_MS);
    if (r.code !== 0) return new Set();
    return new Set(txt(r.stdout).split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** `docker rm -f -v` rồi kiểm `docker ps -a` + `docker volume ls`; true = container VÀ mọi volume của
 * nó đã mất hẳn (volume còn = còn bản sao dữ liệu khôi phục trên đĩa, A04). */
export async function cleanup(name: string, vols: Iterable<string> = []): Promise<boolean> {
  const all = new Set([...vols, ...(await containerVolumes(name))]);
  try {
    await docker(['rm', '-f', '-v', name], 60_000);
  } catch {
    // kiểm lại bên dưới
  }
  let v: { code: number; stdout: Buffer };
  try {
    const r = await docker(
      ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
      60_000,
    );
    if (r.code !== 0 || txt(r.stdout).split(/\s+/).includes(name)) return false;
    if (!all.size) return true;
    v = await docker(['volume', 'ls', '-q'], 60_000);
  } catch {
    return false;
  }
  const listed = new Set(txt(v.stdout).split(/\s+/));
  const left = [...all].filter((x) => listed.has(x)).sort();
  if (left.length) {
    console.log(
      `[ALERT] volume của container DR còn trên đĩa: ${left.join(', ')} — \`docker volume rm\` tay ngay`,
    );
  }
  return v.code === 0 && !left.length;
}

export async function hostPort(name: string): Promise<number> {
  const r = await docker(['port', name, '5432/tcp'], PROBE_TIMEOUT_MS);
  const m = /127\.0\.0\.1:(\d+)/.exec(txt(r.stdout));
  if (r.code !== 0 || !m) throw new RuntimeErr('không đọc được cổng container (docker port)');
  return Number(m[1]);
}

export async function waitReady(dsn: string, timeoutS: number): Promise<void> {
  const deadline = performance.now() + timeoutS * 1000;
  for (;;) {
    const pool = createPool(dsn, { max: 1, connectionTimeoutMillis: 2000 });
    try {
      await pool.query('select 1');
      return;
    } catch {
      if (performance.now() >= deadline) {
        throw new RuntimeErr(`server DR chưa sẵn sàng sau ${fmtG(timeoutS)}s`);
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await pool.end().catch(() => {});
    }
  }
}

/** Điểm thay được trong test (Python monkeypatch `dd.wait_ready`, `dd.rd.run_drill`, `host_port`,
 * `container_volumes`). */
export const drDeps = { waitReady, runDrill, hostPort, containerVolumes };

export type DrRec = {
  ts: string;
  backup_file: string | null;
  container: string | null;
  image: string | null;
  status: string;
  rto_seconds: number | null;
  restore_rto_seconds: number | null;
  rpo_seconds: number | null;
  rpo_max_hours: number;
  tables_checked: number;
  mismatches: Record<string, unknown>;
  container_removed: boolean | null;
  error?: string;
};

/** Dọn container khi bị ngắt (Ctrl+C / SIGTERM) — Python `finally` chạy cả khi KeyboardInterrupt. */
function onSignal(name: string): () => void {
  const handler = (sig: NodeJS.Signals) => {
    spawnSync('docker', ['rm', '-f', '-v', name], { timeout: 60_000, stdio: 'ignore' });
    console.log(`[ALERT] bị ngắt (${sig}) — đã gửi \`docker rm -f -v ${name}\`; kiểm lại tay`);
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export async function runDr(
  args: { backup?: string | null },
  bdir: string,
  dsn: string,
  now: Date,
  rpoMaxH: number,
  readyS: number,
  env: Env = process.env,
  imageOverride: string | null = null,
): Promise<[number, DrRec]> {
  const rec: DrRec = {
    ts: vnIso(now),
    backup_file: null,
    container: null,
    image: null,
    status: 'fail',
    rto_seconds: null,
    restore_rto_seconds: null,
    rpo_seconds: null,
    rpo_max_hours: rpoMaxH,
    tables_checked: 0,
    mismatches: {},
    container_removed: null,
  };
  // (0) Chọn manifest + major server.
  let mpath: string;
  let m: Manifest;
  let major: string;
  try {
    [mpath, m] = pickManifest(bdir, args.backup);
    const mm = /^[\s]*(\p{Nd}+)/u.exec(String(m.server_version));
    if (!mm) throw new RuntimeErr('manifest thiếu server_version hợp lệ');
    major = mm[1] as string;
    rec.backup_file = m.file;
    rec.rpo_seconds = rpoSeconds(m, now);
  } catch (e) {
    if (!(e instanceof RuntimeErr || e instanceof RangeError)) throw e;
    rec.error = scrub(e, dsn);
    console.log(`[err] ${rec.error}`);
    return [1, rec];
  }
  const image = imageOverride || `postgres:${major}-alpine`;
  rec.image = image;
  // (1) Docker + image có sẵn — không có thì dừng (external-dep).
  const why = await probeDocker(image, env);
  if (why) {
    rec.status = 'khong_chay';
    rec.error = why;
    console.log(`[external-dep] DR drill không chạy được: ${why}`);
    return [3, rec];
  }
  const old = await leftovers();
  if (old.length) {
    console.log(
      `[warn] container DR sót từ lần trước (KHÔNG tự xóa — kiểm rồi \`docker rm -f\` tay): ${old.join(', ')}`,
    );
  }
  const name = containerName(now);
  rec.container = name;
  const password = randomBytes(24).toString('base64url');
  let server: string | null = null;
  let vols = new Set<string>();
  let code = 1;
  const t0 = performance.now();
  const offSignal = onSignal(name);
  try {
    // (2) Dựng server mới — mật khẩu qua env, không argv; data dir tmpfs (RAM).
    const tmpfs = (await imageVolumes(image)).flatMap((p) => ['--tmpfs', p]);
    const r = await docker(
      [
        'run',
        '-d',
        '--rm',
        '--pull',
        'never',
        '--name',
        name,
        ...tmpfs,
        '-e',
        'POSTGRES_PASSWORD',
        '-p',
        '127.0.0.1::5432',
        image,
      ],
      DOCKER_TIMEOUT_MS,
      { ...env, POSTGRES_PASSWORD: password },
    );
    if (r.code !== 0) throw new RuntimeErr(`docker run lỗi: ${txt(r.stderr)}`);
    // Volume (nếu image/daemon vẫn tạo) ghi nhận NGAY — `--rm` có thể xóa container trước cleanup.
    vols = await drDeps.containerVolumes(name);
    // (3) Cổng + chờ sẵn sàng.
    const port = await drDeps.hostPort(name);
    server = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
    await drDeps.waitReady(server, readyS);
    console.log(
      `[dr] server mới ${image} sẵn sàng sau ${pyFixed((performance.now() - t0) / 1000, 1)}s — khôi phục ${m.file}`,
    );
    // (4) Khôi phục + đếm + drop: lõi v3.6.
    const [dcode, drec] = await drDeps.runDrill(
      { backup: mpath, targetDb: null },
      bdir,
      dsn,
      server,
      env,
    );
    rec.rto_seconds = round2((performance.now() - t0) / 1000);
    rec.restore_rto_seconds = drec.rto_seconds ?? null;
    rec.tables_checked = drec.tables_checked ?? 0;
    rec.mismatches = drec.mismatches ?? {};
    if (drec.error) rec.error = scrub(drec.error, server);
    const st = drec.status;
    rec.status = st === 'ok' || st === 'mismatch' || st === 'refused' ? st : 'fail';
    code = dcode;
    if (dcode === 0) {
      const rpoOk = (rec.rpo_seconds as number) <= rpoMaxH * 3600;
      const rtoOk = rec.rto_seconds <= RTO_TARGET_S;
      console.log(
        `[dr] RTO ${pyNum(rec.rto_seconds)}s (gồm dựng server; restore ${pyNum(rec.restore_rto_seconds)}s) — mục tiêu ≤ 4h: ${rtoOk ? 'đạt' : 'VƯỢT'}`,
      );
      console.log(
        `[dr] RPO ${pyFixed((rec.rpo_seconds as number) / 3600, 2)}h (tuổi bản backup) — mục tiêu ≤ ${fmtG(rpoMaxH)}h: ${rpoOk ? 'đạt' : 'VƯỢT'}`,
      );
      if (!rpoOk) {
        rec.status = 'rpo_breach';
        code = 1;
      }
    }
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    rec.error = scrub(e, server);
    console.log(`[err] DR drill lỗi: ${rec.error}`);
    code = 1;
  } finally {
    // (6) LUÔN dọn container — kể cả lỗi bất kỳ / bị ngắt.
    offSignal();
    rec.container_removed = await cleanup(name, vols);
    if (!rec.container_removed) {
      rec.status = 'cleanup_failed';
      console.log(
        `[ALERT] container DR ${name} chưa dọn — còn bản sao dữ liệu; chạy \`docker rm -f -v ${name}\` ngay`,
      );
      code = 1;
    }
  }
  return [code, rec];
}

export type DrOpts = { backup?: string };

// TS thêm (KHÁC Python có chủ đích): DB của hệ TS chạy image pgvector (`docs/schema_ts.sql` có cột
// `vector`) → khôi phục vào `postgres:<major>-alpine` lỗi ở `create extension vector`. `DR_IMAGE`
// (tùy chọn) = image Postgres ĐÃ CÓ trên máy cho container DR (vd `pgvector/pgvector:0.8.6-pg17-trixie`
// như deploy/compose) — vẫn `--pull never`; trống = mặc định Python. Sai dạng → usage exit 2.
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[0-9a-f]{64})?$/;

export function drImage(env: Env): string | null {
  const v = pyStrip(env.DR_IMAGE ?? '');
  if (!v) return null;
  if (!IMAGE_RE.test(v))
    throw new UsageError(
      'DR_IMAGE phải là tên image docker hợp lệ (vd pgvector/pgvector:0.8.6-pg17-trixie)',
    );
  return v;
}

/** `python scripts/dr_drill.py [--backup <manifest>]` → exit code. */
export async function drMain(
  opts: DrOpts = {},
  now?: Date,
  env: Env = process.env,
): Promise<number> {
  return privateUmask(async () => {
    let bdir: string;
    let rpoMaxH: number;
    let readyS: number;
    let image: string | null;
    try {
      bdir = dirOutsideRepo(env.BACKUP_DIR, 'BACKUP_DIR');
      rpoMaxH = positive(env.DR_RPO_MAX_HOURS, '24', 'DR_RPO_MAX_HOURS');
      readyS = positive(env.DR_READY_TIMEOUT_S, '60', 'DR_READY_TIMEOUT_S');
      image = drImage(env);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.log(`[usage] ${e.message}`);
      return 2;
    }
    if (!isDir(bdir)) {
      console.log('[usage] BACKUP_DIR không tồn tại');
      return 2;
    }
    const t = now ?? vnNow();
    const dsn = env.DATABASE_URL || '';
    const [code, rec] = await runDr(
      { backup: opts.backup ?? null },
      bdir,
      dsn,
      t,
      rpoMaxH,
      readyS,
      env,
      image,
    );
    appendJsonl(join(bdir, 'dr_runs.jsonl'), rec);
    return code;
  });
}
