import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { callHuman, cliGate } from '@samsam/core/security/auth';
import { cpHead, pyStrip } from '@samsam/core/security/py';
import sharp, { type Metadata } from 'sharp';
import { type DbLease, type Io, STD_IO } from './garden.js';
import { imageExifStats, inRepo, videoHasGps } from './garden-media.js';

// Port `scripts/garden_media_mkt.py` (đợt hợp đồng C07 — farming-04 cấp tư liệu vườn cho Marketing).
//  - Cấp/thu hồi = QUYẾT ĐỊNH của người khối farming: `cliGate` + function
//    `garden_media_release_human` (sổ append-only `garden_media_releases`).
//  - Marketing chỉ thấy view `v_garden_media_marketing` (không khoảnh/tác giả/tư liệu mẫu). `--get`
//    chỉ tư liệu ĐANG được cấp: tệp trong kho phải có, sha256 khớp, ảnh không còn EXIF/GPS, video
//    không còn hộp vị trí → chép `<out>/<sha>.<ext>` (ghi tạm + đổi tên). Thư mục ra trong repo → từ chối.
//  - Không in tên tệp gốc/khoảnh/tác giả — chỉ sha[:12].
// KHÁC Python có chủ đích: ảnh trong kho không đọc được → MediaError (Python: traceback) — vẫn không cấp.

const VIDEO = ['mp4', 'mov'];

/** Không cấp tệp — lý do rõ, không chép gì (Python ValueError). */
export class MediaError extends RangeError {}

export async function released(db: Db, sha: string): Promise<string | null> {
  const r = await db.query<{ ext: string }>(
    'select ext from v_garden_media_marketing where sha256 = $1',
    [sha],
  );
  return r.rows[0]?.ext ?? null;
}

export async function checkClean(data: Buffer, ext: string): Promise<void> {
  if (VIDEO.includes(ext)) {
    if (videoHasGps(data)) throw new MediaError('video còn dấu vị trí — không cấp');
    return;
  }
  let meta: Metadata;
  try {
    meta = await sharp(data, { limitInputPixels: false }).metadata();
  } catch {
    throw new MediaError('ảnh trong kho không đọc được — không cấp');
  }
  // Như Pillow getexif: cả EXIF trong chunk text 'Raw profile type exif' / sau IDAT của PNG
  const [n, gps] = imageExifStats(data, meta);
  if (n || gps) throw new MediaError('ảnh còn thẻ EXIF/GPS — không cấp');
}

export async function get(db: Db, sha: string, outDir: string, storeDir: string): Promise<string> {
  const s12 = cpHead(sha, 12);
  const ext = await released(db, sha);
  if (ext === null)
    throw new MediaError(`${s12} chưa được cấp cho Marketing (hoặc đã thu hồi / tư liệu mẫu)`);
  if (inRepo(outDir)) throw new MediaError('thư mục ra nằm trong repo (public) — từ chối');
  const src = join(storeDir, sha.slice(0, 2), `${sha}.${ext}`);
  let ok = false;
  try {
    ok = statSync(src).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new MediaError(`${s12} thiếu tệp trong kho`);
  const data = readFileSync(src);
  if (createHash('sha256').update(data).digest('hex') !== sha)
    throw new MediaError(`${s12} tệp trong kho lệch sha256 — không cấp`);
  await checkClean(data, ext);
  mkdirSync(outDir, { recursive: true });
  const dst = join(outDir, `${sha}.${ext}`);
  const tmp = join(outDir, `.${sha}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, dst);
  return dst;
}

/** Cấp ('cap') / thu hồi ('thu_hoi') → true nếu ghi mới, false nếu đã ở trạng thái đó. */
export async function decide(
  db: Db,
  sha: string,
  action: 'cap' | 'thu_hoi',
  by: string,
  note: string | null = null,
  env: Env = process.env,
): Promise<boolean> {
  const oid = cpHead(sha, 12);
  const why = await cliGate(db, by, 'farming', `media_${action}`, 'garden_media', oid, { env });
  if (why) throw new MediaError(why);
  const r = await callHuman<{ ok: boolean }>(
    db,
    'select garden_media_release_human($1, $2, $3, $4) as ok',
    [sha, action, by, note],
    {
      by,
      block: 'farming',
      action: `media_${action}`,
      objectType: 'garden_media',
      objectId: oid,
      env,
    },
  );
  return r.rows[0]?.ok === true;
}

export type MktOpts = {
  release?: string;
  revoke?: string;
  list?: boolean;
  get?: string;
  by?: string;
  note?: string;
  out?: string;
  store?: string;
};

/** `python scripts/garden_media_mkt.py` → exit: 0 ok · 1 từ chối · 2 sai tham số / DB down. */
export async function gardenMediaMktMain(
  o: MktOpts,
  d: { connect?: () => Promise<DbLease | null>; io?: Io; env?: Env } = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`garden_media_mkt.py: error: ${m}`);
    return 2;
  };
  const ops = (['release', 'revoke', 'list', 'get'] as const).filter((k) =>
    k === 'list' ? o.list : o[k] !== undefined,
  );
  if (!ops.length) return usage('one of the arguments --release --revoke --list --get is required');
  if (ops.length > 1) return usage(`argument --${ops[1]}: not allowed with argument --${ops[0]}`);
  const decision = o.release !== undefined || o.revoke !== undefined;
  if (decision && !pyStrip(o.by ?? ''))
    return usage('--release/--revoke cần --by "<tên người quyết>"');
  if (o.get !== undefined && o.out === undefined) return usage('--get cần --out DIR');
  const storeDir = o.store || env.GARDEN_MEDIA_DIR;
  if (o.get !== undefined && !storeDir) return usage('thiếu --store hoặc env GARDEN_MEDIA_DIR');
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[err] không kết nối được Postgres');
    return 2;
  }
  const { db } = lease;
  try {
    if (o.list) {
      // Định dạng ngày ở DB (múi giờ phiên) — như psycopg trả datetime theo TimeZone phiên.
      const r = await db.query<{
        sha256: string;
        ext: string;
        bytes: string;
        day: string;
        at: string;
      }>(
        "select sha256, ext, bytes::text, taken_on::text as day, to_char(released_at, 'YYYY-MM-DD') as at" +
          ' from v_garden_media_marketing order by released_at desc, sha256',
      );
      for (const x of r.rows) io.out(`${x.sha256} ${x.ext} ${x.bytes}B chụp ${x.day} cấp ${x.at}`);
      io.out(`[done] ${r.rows.length} tư liệu đang được cấp`);
      return 0;
    }
    let sha: string;
    let ok: boolean;
    try {
      if (o.get !== undefined) {
        const dst = await get(
          db,
          pyStrip(o.get).toLowerCase(),
          o.out as string,
          storeDir as string,
        );
        io.out(`[done] ${cpHead(o.get, 12)} → ${dst.split(/[\\/]/).pop()}`);
        return 0;
      }
      sha = pyStrip(o.release ?? o.revoke ?? '').toLowerCase();
      ok = await decide(
        db,
        sha,
        o.release !== undefined ? 'cap' : 'thu_hoi',
        pyStrip(o.by as string),
        o.note ?? null,
        env,
      );
    } catch (e) {
      // MediaError / function từ chối nghiệp vụ (HumanError) / HumanDenied — đều RangeError
      if (e instanceof RangeError) {
        io.err(`[từ chối] ${e.message}`);
        return 1;
      }
      throw e;
    }
    io.out(
      `[done] ${sha.slice(0, 12)} ${ok ? 'đã cập nhật' : 'đã ở trạng thái này — không ghi lặp'}`,
    );
    return 0;
  } finally {
    await lease.release();
  }
}
