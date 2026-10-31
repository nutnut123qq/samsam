import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '@samsam/core/env';
import { pyStrip } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { pyOsName } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { pgErrName } from '@samsam/core/rollout/counters';
import type pg from 'pg';
import {
  loadConfig,
  RETENTION_FILE,
  RetentionError,
  type RetentionItem,
  statusLines,
} from '../pmo_ops/retention.js';
import { insideRepo, io, isDir, isFile, openDb, pyResolve, sha256File } from './common.js';

// Port `scripts/retention_purge.py` (v13.4 C05) — xóa FILE dữ liệu cá nhân quá hạn lưu (CV / ảnh-video
// vườn / ghi âm vườn) theo `data/retention.json`. `ttl_days = null` = CHƯA CHỐT → mục đó KHÔNG xóa gì
// (`[blocked]`); cấu hình hỏng → exit 2, 0 xóa. Thứ tự an toàn: liệt kê → ghi `agent_action_log`
// (`retention_purge`, chỉ id mục + TTL + số file + sha256[:12], KHÔNG tên file) và COMMIT → mới xóa
// từng file; xóa lỗi → dòng log `retention_purge_failed`. Không bao giờ có file bị xóa mà chưa có log.
// DB không kết nối được → exit 2, 0 xóa. Ảnh/video gắn hồ sơ lô QR (`lot_origins`) không xóa; ghi âm
// chỉ xóa nháp `da_chep_loi`. `--dry-run` chỉ đếm. Exit: 0 xong · 1 có file/mục lỗi · 2 cấu hình/DB.
// `load_config`/`status_lines` dùng CHUNG bản của nhóm pmo_ops (bản tin sức khỏe) — không chép lại.

export { loadConfig, RetentionError, statusLines };
export const ACTOR = 'job:retention_purge';
export const MAX_LOG_IDS = 200;
const DAY_MS = 86_400_000;

type Kho = { loai: string; env?: string; duoi?: string[] };
export type Candidate = readonly [sha12: string, path: string];

function store(kho: Kho, env: Env): string {
  const name = String(kho.env);
  const d = pyStrip(env[name] ?? '');
  if (!d) throw new RetentionError(`thiếu env ${name}`);
  if (insideRepo(d)) throw new RetentionError(`${name} nằm trong repo — bỏ qua`);
  return pyResolve(d);
}

/** Python `Path.suffix` (đuôi sau dấu chấm cuối; tên bắt đầu bằng '.'/kết thúc bằng '.' → ''). */
function suffix(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

/** Python `sorted(Path.iterdir())` — theo tên (code point). */
const byCodePoint = (a: string, b: string) => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
};

/** [danh sách (sha12, đường dẫn) quá hạn, số ghi âm quá hạn CHƯA chép]. */
export async function candidates(
  db: Db,
  item: RetentionItem,
  now: Date,
  env: Env = process.env,
): Promise<[Candidate[], number]> {
  const kho = item.kho as Kho;
  const cutoff = new Date(now.getTime() - (item.ttl_days as number) * DAY_MS);
  if (kho.loai === 'khong_luu_ban_sao') return [[], 0];
  const base = store(kho, env);
  if (kho.loai === 'thu_muc') {
    const exts = new Set((kho.duoi ?? []).map((e) => String(e).toLowerCase()));
    const out: Candidate[] = [];
    if (isDir(base)) {
      for (const n of readdirSync(base).sort(byCodePoint)) {
        const f = join(base, n);
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(f);
        } catch {
          continue;
        }
        if (st.isSymbolicLink() || !st.isFile() || !exts.has(suffix(n).toLowerCase())) continue;
        if (st.mtimeMs < cutoff.getTime()) out.push([sha256File(f).slice(0, 12), f]);
      }
    }
    return [out, 0];
  }
  if (kho.loai === 'garden_media') {
    const { rows } = await db.query<{ sha256: string; ext: string }>(
      'select m.sha256, m.ext from garden_media m where m.created_at < $1 and not exists (select 1 from lot_origins o where m.sha256 = any(o.media_sha256)) order by m.id',
      [cutoff],
    );
    const out: Candidate[] = [];
    for (const { sha256: s, ext: x } of rows) {
      const p = join(base, s.slice(0, 2), `${s}.${x}`);
      if (isFile(p)) out.push([s.slice(0, 12), p]);
    }
    return [out, 0];
  }
  const { rows } = await db.query<{ sha256: string; ext: string; status: string }>(
    'select sha256, ext, status from garden_voice_drafts where received_at < $1 order by id',
    [cutoff],
  );
  const audio = join(base, 'audio');
  const done: Candidate[] = [];
  for (const { sha256: s, ext: x, status } of rows) {
    const p = join(audio, s.slice(0, 2), `${s}.${x}`);
    if (status === 'da_chep_loi' && isFile(p)) done.push([s.slice(0, 12), p]);
  }
  return [done, rows.filter((r) => r.status === 'cho_chep_loi').length];
}

/** Ghi 1 dòng `agent_action_log` (tự commit — Pool) — KHÔNG tên file, chỉ sha256[:12]. */
export async function logAction(
  db: Db,
  action: string,
  item: RetentionItem,
  ids: readonly string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const detail = {
    ttl_days: item.ttl_days,
    n: ids.length,
    sha12: ids.slice(0, MAX_LOG_IDS),
    ...extra,
  };
  await db.query(
    "insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, 'retention', $3, $4::jsonb)",
    [ACTOR, action, item.id, JSON.stringify(detail)],
  );
}

/** Điểm thay được trong test (Python monkeypatch `rp._log`). */
export const retentionDeps = { log: logAction };

export type PurgeResult = { n: number; deleted: number; failed: number; pending_voice: number };

/** 1 mục có TTL → {n, deleted, failed, pending_voice}. Log COMMIT trước khi xóa file. */
export async function purgeItem(
  db: Db,
  item: RetentionItem,
  now: Date,
  dryRun: boolean,
  env: Env = process.env,
): Promise<PurgeResult> {
  const [files, pending] = await candidates(db, item, now, env);
  const res: PurgeResult = { n: files.length, deleted: 0, failed: 0, pending_voice: pending };
  if (dryRun || !files.length) return res;
  await retentionDeps.log(
    db,
    'retention_purge',
    item,
    files.map(([s]) => s),
  );
  const failed: string[] = [];
  for (const [sha12, f] of files) {
    try {
      io.unlink(f);
      res.deleted++;
    } catch {
      failed.push(sha12);
    }
  }
  if (failed.length) {
    res.failed = failed.length;
    await retentionDeps.log(db, 'retention_purge_failed', item, failed);
  }
  return res;
}

/** Tên lỗi như Python `type(e).__name__` (OSError → tên lớp con, psycopg → tên lớp). */
function errName(e: unknown): string {
  if (isDbError(e)) return pgErrName(e);
  if (typeof (e as { code?: unknown })?.code === 'string') return pyOsName(e);
  return (e as Error)?.name ?? 'Exception';
}

export type RetentionOpts = { dryRun?: boolean };
export type RetentionDeps = {
  config?: string;
  env?: Env;
  now?: Date;
  connect?: (env: Env) => Promise<Db | null>;
};

/** `python scripts/retention_purge.py [--dry-run]` → exit code. */
export async function retentionMain(
  opts: RetentionOpts = {},
  deps: RetentionDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let items: RetentionItem[];
  try {
    items = loadConfig(deps.config ?? RETENTION_FILE);
  } catch (e) {
    if (!(e instanceof RetentionError)) throw e;
    console.error(`[err] ${e.message} — không xóa gì`);
    return 2;
  }
  for (const line of statusLines(items)) console.log(line);
  const todo = items.filter(
    (it) =>
      it.ttl_days !== null && it.ttl_days !== undefined && it.kho.loai !== 'khong_luu_ban_sao',
  );
  if (!todo.length) {
    console.log('[blocked] chưa mục nào được chốt hạn lưu — không xóa gì');
    return 0;
  }
  const db = await (deps.connect ?? openDb)(env);
  if (db === null) {
    console.error('[err] không kết nối được Postgres — không xóa gì (cần ghi log trước khi xóa)');
    return 2;
  }
  let rc = 0;
  const now = deps.now ?? io.now();
  try {
    for (const it of todo) {
      let r: PurgeResult;
      try {
        r = await purgeItem(db, it, now, Boolean(opts.dryRun), env);
      } catch (e) {
        const known =
          e instanceof RetentionError ||
          isDbError(e) ||
          typeof (e as { code?: unknown })?.code === 'string';
        if (!known) throw e;
        const why = e instanceof RetentionError ? e.message : errName(e);
        console.error(`[err] ${it.id}: ${why}`);
        rc = 1;
        continue;
      }
      const verb = opts.dryRun ? 'sẽ xóa' : 'đã xóa';
      const done = opts.dryRun ? r.n : r.deleted;
      console.log(
        `[${it.id}] ${verb} ${done}/${r.n} file quá ${it.ttl_days} ngày${r.failed ? `, lỗi ${r.failed}` : ''}${
          r.pending_voice
            ? `; CẢNH BÁO ${r.pending_voice} ghi âm quá hạn chưa chép lời (không xóa)`
            : ''
        }`,
      );
      if (r.failed) rc = 1;
    }
  } finally {
    if (!deps.connect) await (db as pg.Pool).end?.().catch(() => {});
  }
  return rc;
}
