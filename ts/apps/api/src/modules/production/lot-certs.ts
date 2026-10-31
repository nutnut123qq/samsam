import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { REPO_ROOT } from '@samsam/core/paths';
import { callHuman } from '@samsam/core/security/auth';
import { cpLen, pyStrip } from '@samsam/core/security/py';

// Port `pipelines/lot_certs.py` (đợt hợp đồng C03 — production-04.x, PL01 Sản xuất "hồ sơ lô: mã lô,
// hạn dùng, phiếu kiểm nghiệm") + phần `ingest/doc_intake.py` (sha256_file/store_original) nó dùng.
//  - Tệp phiếu: PDF/JPG/PNG theo MAGIC BYTES (không theo đuôi), ≤ MAX_BYTES (GIẢ ĐỊNH 20 MB), lưu bất
//    biến `LOT_CERT_DIR/<sha256>` (NGOÀI repo — trong repo thì từ chối), không ghi đè, hash tính lại
//    khi chép. Không in tên tệp/nội dung.
//  - Ghi sổ CHỈ qua `lot_cert_record_human` (DB: người khối production, lô phải tồn tại, cùng tệp
//    không ghi 2 lần, phiên bản tăng — bản cũ giữ).
//  - `verify`: mỗi lô chờ/đạt → thieu_phieu | ok | thieu_tep | lech_hash theo phiên bản MỚI NHẤT;
//    lô cũ không phiếu hiện THIẾU (không tự tạo chứng từ).

export const MAX_BYTES = 20 * 1024 * 1024;
const MAGIC: [Buffer, string][] = [
  [Buffer.from('%PDF-', 'latin1'), 'pdf'],
  [Buffer.from('ffd8ff', 'hex'), 'jpg'],
  [Buffer.from('89504e470d0a1a0a', 'hex'), 'png'],
];
const SHA_RE = /^[0-9a-f]{64}$/;
const CHUNK = 1 << 20;

/** Tệp/kho/tham số phiếu không hợp lệ — không ghi gì (Python CertError(ValueError)). */
export class CertError extends RangeError {
  override name = 'CertError';
}
/** `doc_intake.DocError`: bản gốc lệch hash / tệp nguồn đổi giữa chừng. */
export class DocError extends Error {
  override name = 'DocError';
}

/** Đường dẫn tuyệt đối sau khi giải symlink của phần đã tồn tại (Python `Path.resolve()`). */
function resolveReal(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Thư mục nằm TRONG `root` (sau giải symlink/..; Windows không phân biệt hoa thường)? */
export function inside(p: string, root: string): boolean {
  const rel = relative(resolveReal(root), resolveReal(p));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Kho phiếu `LOT_CERT_DIR` (đã resolve) — chưa cấu hình / nằm trong repo → CertError. */
export function certDir(env: Env = process.env, root: string = REPO_ROOT): string {
  const raw = pyStrip(env.LOT_CERT_DIR ?? '');
  if (!raw) throw new CertError('chưa cấu hình LOT_CERT_DIR (kho phiếu NGOÀI repo)');
  const d = resolveReal(raw);
  if (inside(d, root)) throw new CertError('LOT_CERT_DIR nằm trong repo — từ chối (repo public)');
  return d;
}

/** Đuôi chuẩn theo magic bytes; không phải tệp thường/rỗng/quá lớn/loại lạ → CertError. */
export function sniff(path: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new CertError('không phải tệp thường');
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new CertError('không phải tệp thường');
  const n = st.size;
  if (n === 0 || n > MAX_BYTES) {
    throw new CertError(`tệp rỗng hoặc vượt ${MAX_BYTES / 1024 / 1024} MB`);
  }
  const head = Buffer.alloc(8);
  const fd = openSync(path, 'r');
  let got: number;
  try {
    got = readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  const h = head.subarray(0, got);
  for (const [magic, ext] of MAGIC) {
    if (h.length >= magic.length && h.subarray(0, magic.length).equals(magic)) return ext;
  }
  throw new CertError('tệp không phải PDF/JPG/PNG (magic bytes)');
}

/** `doc_intake.sha256_file`. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * `doc_intake.store_original`: lưu bản gốc bất biến `<dir>/<sha>`. true = vừa ghi, false = đã có
 * đúng hash. Đích có sẵn mà lệch hash → DocError, KHÔNG ghi đè. Ghi qua tệp tạm cùng thư mục +
 * `link` (lỗi nếu đích tồn tại) — không bao giờ rename đè. Hash tính lại trong lúc chép: tệp nguồn
 * đổi giữa chừng → DocError.
 */
export function storeOriginal(path: string, sha: string, dir: string): boolean {
  if (!SHA_RE.test(sha)) throw new RangeError('sha256 không hợp lệ');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, sha);
  if (existsSync(dest)) {
    if (sha256File(dest) !== sha) throw new DocError('bản gốc lệch hash — không ghi đè');
    return false;
  }
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  const out = openSync(tmp, 'wx', 0o600);
  let open = true;
  try {
    const h = createHash('sha256');
    const src = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      for (;;) {
        const n = readSync(src, buf, 0, CHUNK, null);
        if (n <= 0) break;
        const chunk = buf.subarray(0, n);
        h.update(chunk);
        writeSync(out, chunk);
      }
    } finally {
      closeSync(src);
    }
    fsyncSync(out);
    closeSync(out);
    open = false;
    if (h.digest('hex') !== sha) throw new DocError('file nguồn đổi trong lúc intake');
    try {
      linkSync(tmp, dest);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      // Đua với tiến trình khác: đích vừa xuất hiện → kiểm hash.
      if (sha256File(dest) !== sha) throw new DocError('bản gốc lệch hash — không ghi đè');
      return false;
    }
    return true;
  } finally {
    if (open) closeSync(out);
    try {
      unlinkSync(tmp);
    } catch {
      // đã xóa
    }
  }
}

export type RecordOpts = {
  lab?: string | null;
  issued?: string | null;
  note?: string | null;
  /** Kho thay `LOT_CERT_DIR` (test). */
  store?: string | null;
  env?: Env;
};

/** Lưu tệp vào kho + ghi sổ qua function người → phiên bản. Lỗi tệp/kho → CertError TRƯỚC mọi ghi
 * DB. DB từ chối → HumanDenied (42501) / HumanError (RangeError — Python ValueError) — tệp đã lưu theo
 * hash: vô hại, không có dòng sổ trỏ tới. */
export async function record(
  db: Db,
  lot: string,
  path: string,
  certNo: unknown,
  by: string,
  o: RecordOpts = {},
): Promise<number> {
  const no = typeof certNo === 'string' ? pyStrip(certNo) : '';
  if (!no || cpLen(no) > 64) throw new CertError('--cert-no rỗng hoặc > 64 ký tự');
  const ext = sniff(path);
  const d = o.store ?? certDir(o.env);
  const sha = sha256File(path);
  try {
    storeOriginal(path, sha, d);
  } catch (e) {
    if (e instanceof DocError) throw new CertError(e.message);
    throw e;
  }
  const r = await callHuman<{ v: number }>(
    db,
    'select lot_cert_record_human($1, $2, $3, $4, $5, $6, $7, $8) as v',
    [lot, no, o.lab ?? null, o.issued ?? null, sha, ext, o.note ?? null, by],
    {
      by,
      block: 'production',
      action: 'lot_cert_record',
      objectType: 'production_lot',
      objectId: lot,
      env: o.env,
    },
  );
  return Number(r.rows[0]?.v);
}

/** (lot, intake_status, version | null, cert_no | null, sha | null, ext | null). */
export type LatestRow = [
  string,
  string,
  number | null,
  string | null,
  string | null,
  string | null,
];

/** Phiếu mới nhất của mọi lô đang chờ/đã đạt (hoặc 1 lô). */
export async function latest(db: Db, lot: string | null = null): Promise<LatestRow[]> {
  const { rows } = await db.query<{
    lot_code: string;
    intake_status: string;
    version: number | null;
    cert_no: string | null;
    file_sha256: string | null;
    file_ext: string | null;
  }>(
    'select l.lot_code, l.intake_status, c.version, c.cert_no, c.file_sha256, c.file_ext' +
      ' from production_lots l left join lateral (select version, cert_no, file_sha256, file_ext' +
      ' from lot_test_certificates t where t.lot_code = l.lot_code order by version desc limit 1)' +
      " c on true where l.intake_status in ('pending', 'passed') and ($1::text is null or" +
      ' l.lot_code = $1) order by l.lot_code',
    [lot],
  );
  return rows.map((r) => [
    r.lot_code,
    r.intake_status,
    r.version,
    r.cert_no,
    r.file_sha256,
    r.file_ext,
  ]);
}

export type VerifyRow = {
  lot: string;
  intake: string;
  version: number | null;
  cert_no: string | null;
  state: 'thieu_phieu' | 'ok' | 'thieu_tep' | 'lech_hash';
};

export async function verify(
  db: Db,
  store: string | null = null,
  lot: string | null = null,
  env: Env = process.env,
): Promise<VerifyRow[]> {
  const d = store ?? certDir(env);
  const out: VerifyRow[] = [];
  for (const [code, st, ver, no, sha] of await latest(db, lot)) {
    let state: VerifyRow['state'];
    if (ver === null) state = 'thieu_phieu';
    else {
      const f = join(d, sha as string);
      let isFile = false;
      try {
        isFile = statSync(f).isFile();
      } catch {
        isFile = false;
      }
      state = !isFile ? 'thieu_tep' : sha256File(f) === sha ? 'ok' : 'lech_hash';
    }
    out.push({ lot: code, intake: st, version: ver, cert_no: no, state });
  }
  return out;
}
