import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  type Dirent,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { AiWorkerError, ocrViaWorker } from '@samsam/core/ai/ai-worker';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { isPrintable } from '@samsam/core/ops/py';
import { cpCmp, pyOsName } from '@samsam/core/ops/py-json';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { callHuman, cliGate, HumanDenied } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, cpLen, D, isSpace, re, S } from '@samsam/core/security/py';
import pg from 'pg';
import { PdfEncrypted, PdfError, pdfPageTexts as parsePdf } from './pdf-text.js';
import {
  type DbLease,
  type Io,
  isFsError,
  isoDate,
  ndInt,
  printableOnly,
  pyName,
  pyStrip,
  pySuffix,
  STD_IO,
  validDate,
} from './shared.js';

// Port `ingest/doc_intake.py` (v3.8 WP04b / F15.1, tính năng data_platform-02.1 "Đọc chữ tự động từ
// giấy tờ" + data_platform-02.2 "Lưu bản gốc kèm mã kiểm tra") — số hóa tài liệu CÓ KIỂM SOÁT:
// thư mục intake → sha256 → bản gốc bất biến `originals/<sha256>` → trích chữ (lớp chữ PDF; scan/ảnh →
// provider OCR cắm được) → quét PII → trích field pháp lý bằng regex TẤT ĐỊNH → `documents` +
// `document_fields` (chưa xác minh) → Pháp chế `--verify <sha256> --by "<tên>"`.
// Contract giữ nguyên Python: doc_type theo thư mục con; đuôi .pdf/.jpg/.jpeg/.png; 0 byte/đuôi lạ/
// symlink → skipped; bản gốc ghi tạm + link (không ghi đè, lệch hash → lỗi); idempotent theo sha256
// (`on conflict do nothing`); scan quyết THEO TRANG (< SCAN_MIN_CHARS → cả tài liệu sang OCR, pii NULL);
// pii_flag theo `maskPii` KHÔNG allowlist; tài liệu pii true/NULL không gửi LLM (module không gọi
// LLM/mạng); provider nước ngoài bị từ chối; không lưu full text, không in tên tệp/nội dung.
// KHÁC Python có chủ đích: OCR `paddle_local` chạy ở AI worker nội bộ (`AI_WORKER_URL`, mạng
// ai_private — bọc đúng `_ocr_paddle_local` của Python) thay tiến trình con tại chỗ; lớp chữ PDF đọc
// bằng `pdf-text.ts` (thay pypdf — xem giới hạn ở đó). Không đọc `.env`.

export const DOC_TYPES = ['giay_tiep_nhan', 'nhan', 'hop_dong_dai_ly', 'ho_so_vung_trong'];
export const PDF_EXT = '.pdf';
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
// Ngưỡng ký tự không-trắng MỖI TRANG — 1 trang dưới ngưỡng → cả tài liệu coi là scan (fail-closed:
// pii_flag NULL). Watermark "Scanned with CamScanner" (21), footer "Trang 1/10" không làm thành pdf_text.
export const SCAN_MIN_CHARS = 50;
export const SHA_RE = /^[0-9a-f]{64}$/;
const CHUNK = 1 << 20;
export const TEN_SP_MAX = 200;

/** Lỗi 1 tài liệu (PDF hỏng/mã hoá, bản gốc lệch hash, OCR lỗi) — lô chạy tiếp. */
export class DocError extends Error {}

/** OCR(path, env) → text. */
export type OcrFn = (path: string, env: Env) => Promise<string>;

/** Provider mặc định: không OCR, không mạng → tài liệu ở `cho_ocr`. */
const ocrNone: OcrFn = async () => '';

/** OCR TẠI CHỖ (PaddleOCR) qua AI worker nội bộ — ảnh/PDF không rời server Sâm Sâm (domestic). Worker
 * kiểm model cục bộ, tiến trình con, hạn OCR_TIMEOUT_S; lỗi → DocError có kiểm soát. */
const ocrPaddleLocal: OcrFn = async (path, env) => {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (e) {
    throw new DocError(`không đọc được tệp để OCR (${pyOsName(e)})`);
  }
  try {
    return await ocrViaWorker(data, env);
  } catch (e) {
    if (e instanceof AiWorkerError) throw new DocError(cpHead(e.message, 200));
    throw e;
  }
};

/** name → [OCR, domestic]. Vendor có phí (FPT.AI Reader…) = external-dep: hợp đồng + DPA trước khi cắm.
 * Test thêm/xóa mục như Python `monkeypatch.setitem(PROVIDERS, …)`. */
export const PROVIDERS: Record<string, [OcrFn, boolean]> = {
  none: [ocrNone, true],
  paddle_local: [ocrPaddleLocal, true],
};
/** Ghi vào documents.ocr_engine (truy vết engine/model tạo text OCR). */
export const OCR_ENGINES: Record<string, string> = {
  paddle_local: 'paddleocr-2.x/latin_PP-OCRv3',
};
export const OCR_BLOCKED =
  'OCR_PROVIDER chưa cấu hình — BLOCKED: vendor OCR trong nước ' +
  '+ hợp đồng/DPA + key (Bên B/Pháp chế chọn), cắm vào ' +
  'ingest.doc_intake.PROVIDERS; tạm thời người đọc bản gốc rồi ' +
  'nhập tay';

const known = (p: string) => Object.hasOwn(PROVIDERS, p);

// ---------------------------------------------------------------------------- tệp / bản gốc

export function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(CHUNK);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Lưu bản gốc bất biến `originalsDir/<sha>`. true = vừa ghi, false = đã có đúng hash. Đích có sẵn mà
 * lệch hash → DocError, KHÔNG ghi đè. Ghi tệp tạm cùng thư mục + `link` (lỗi nếu đích tồn tại) — không
 * bao giờ rename đè. Hash tính lại trong lúc copy: tệp nguồn đổi giữa chừng → DocError.
 */
export function storeOriginal(path: string, sha: string, originalsDir: string): boolean {
  if (!SHA_RE.test(sha)) throw new RangeError('sha256 không hợp lệ');
  mkdirSync(originalsDir, { recursive: true });
  const dest = join(originalsDir, sha);
  if (existsSync(dest)) {
    if (sha256File(dest) !== sha) throw new DocError('bản gốc lệch hash — không ghi đè');
    return false;
  }
  const tmp = join(originalsDir, `.tmp-${randomBytes(6).toString('hex')}`);
  const out = openSync(tmp, 'wx');
  try {
    const h = createHash('sha256');
    const src = openSync(path, 'r');
    const buf = Buffer.alloc(CHUNK);
    try {
      for (;;) {
        const n = readSync(src, buf, 0, CHUNK, null);
        if (!n) break;
        h.update(buf.subarray(0, n));
        writeSync(out, buf, 0, n);
      }
      fsyncSync(out);
    } finally {
      closeSync(src);
      closeSync(out);
    }
    if (h.digest('hex') !== sha) throw new DocError('file nguồn đổi trong lúc intake');
    try {
      linkSync(tmp, dest);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      // Race với tiến trình khác: đích vừa xuất hiện → kiểm hash.
      if (sha256File(dest) !== sha) throw new DocError('bản gốc lệch hash — không ghi đè');
      return false;
    }
    return true;
  } finally {
    unlinkSync(tmp);
  }
}

/** Số ký tự không phải khoảng trắng (Python `not c.isspace()`). */
export function nonspaceLen(text: string): number {
  let n = 0;
  for (const c of text) if (!isSpace(c)) n++;
  return n;
}

async function ocr(path: string, provider: string, env: Env): Promise<string> {
  const [fn, domestic] = PROVIDERS[provider];
  // PII chưa biết trước khi OCR → coi như có PII → cấm nước ngoài.
  if (!domestic) return '';
  return ((await fn(path, env)) || '').normalize('NFC');
}

/** Chữ NFC từng trang PDF (không mạng). PDF mã hoá/hỏng → DocError. */
export function pdfPageTexts(path: string): string[] {
  try {
    return parsePdf(readFileSync(path)).map((t) => t.normalize('NFC'));
  } catch (e) {
    if (e instanceof PdfEncrypted) throw new DocError('PDF mã hoá');
    if (e instanceof PdfError) throw new DocError(`PDF hỏng: ${e.pyType}`);
    if (isFsError(e)) throw new DocError(`PDF hỏng: ${pyOsName(e)}`);
    throw new DocError(`PDF hỏng: ${(e as Error)?.name ?? 'Exception'}`);
  }
}

export type TextSource = 'pdf_text' | 'ocr' | 'none';

/** → [text NFC, pages, nguồn pdf_text|ocr|none]. `ext` cho tệp không đuôi (bản gốc `<sha256>`). */
export async function extractText(
  path: string,
  provider = 'none',
  ext: string | null = null,
  env: Env = process.env,
): Promise<[string, number, TextSource]> {
  const e = (ext ?? pySuffix(path)).toLowerCase();
  let pages = 1;
  if (e === PDF_EXT) {
    const texts = pdfPageTexts(path);
    pages = texts.length;
    // Quyết định scan THEO TRANG: mọi trang đủ chữ mới là pdf_text; còn lại cả tài liệu chờ OCR.
    if (texts.length && texts.every((t) => nonspaceLen(t) >= SCAN_MIN_CHARS)) {
      return [texts.join('\n'), pages, 'pdf_text'];
    }
  }
  const text = await ocr(path, provider, env);
  if (nonspaceLen(text) === 0) return ['', pages, 'none'];
  return [text, pages, 'ocr'];
}

/** SĐT/email (không allowlist). Đếm token '***' thay vì so chuỗi (`maskPii` còn unwrap ngoặc toàn số
 * "(1500)" → text đổi dù không có PII). */
export function hasPii(text: string): boolean {
  const n = (s: string) => s.split('***').length - 1;
  return n(maskPii(text)) > n(text);
}

// ---------------------------------------------------------------------------- trích field (THUẦN)
// Đ có thể ra U+0110 (Đ) hoặc U+00D0 (Ð, font map lệch) tùy PDF.
const SO_GIAY_RE = re(`(?<!${D})${D}{1,6}/${D}{4}/[ĐÐD]KSP(?![A-Za-z])`, 'gi');
const NGAY_CHU_RE = re(
  `ng[àa]y[${S}]+(${D}{1,2})[${S}]+th[áa]ng[${S}]+(${D}{1,2})[${S}]+n[ăa]m[${S}]+(${D}{4})(?!${D})`,
  'gi',
);
const NGAY_SO_RE = re(`(?<!${D})(${D}{1,2})([/.-])(${D}{1,2})\\2(${D}{4})(?!${D})`, 'g');
const TEN_SP_RE = re(`t[êe]n[${S}]+s[ảa]n[${S}]+ph[ẩa]m[${S}]*:[ \\t]*([^\\n]*)`, 'gi');

function iso(d: string, m: string, y: string): string | null {
  const [yy, mm, dd] = [ndInt(y), ndInt(m), ndInt(d)];
  return validDate(yy, mm, dd) ? isoDate(yy, mm, dd) : null; // 31/02, tháng 13...
}

/** Ứng viên đầu; confidence 1.0 nếu đúng 1 giá trị khác nhau, 0.5 nếu > 1. */
function pick(cands: string[]): [string, number] | null {
  if (!cands.length) return null;
  return [cands[0], new Set(cands).size === 1 ? 1.0 : 0.5];
}

/** → {field: [value, confidence]} cho giấy tiếp nhận. Ngày dạng chữ "ngày d tháng m năm yyyy" ưu tiên,
 * chỉ fallback dd/mm/yyyy khi không có dạng chữ hợp lệ. */
export function extractFields(text: string): Record<string, [string, number]> {
  const t = text.normalize('NFC');
  const out: Record<string, [string, number]> = {};
  const so = pick([...t.matchAll(SO_GIAY_RE)].map((m) => m[0]));
  if (so) out.so_giay = so;
  let ngay = [...t.matchAll(NGAY_CHU_RE)]
    .map((m) => iso(m[1], m[2], m[3]))
    .filter((v): v is string => v !== null);
  if (!ngay.length) {
    ngay = [...t.matchAll(NGAY_SO_RE)]
      .map((m) => iso(m[1], m[3], m[4]))
      .filter((v): v is string => v !== null);
  }
  const p = pick(ngay);
  if (p) out.ngay_cap = p;
  // Bỏ ký tự điều khiển (ESC/CR...) — value in ra terminal ở --pending.
  const ten = [...t.matchAll(TEN_SP_RE)]
    .map((m) => pyStrip(printableOnly(m[1])))
    .filter((s) => s !== '')
    .map((s) => cpHead(s, TEN_SP_MAX));
  const pt = pick(ten);
  if (pt) out.ten_san_pham = pt;
  return out;
}

// ---------------------------------------------------------------------------- intake

export function docTypeOf(path: string, intakeDir: string): string {
  const parts = relative(intakeDir, path).split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 && DOC_TYPES.includes(parts[0]) ? parts[0] : 'khac';
}

const WIN = process.platform === 'win32';
const norm = (p: string) => (WIN ? p.toLowerCase() : p);

/** Python `PurePath.__lt__`: so danh sách phần đường dẫn (Windows: không phân biệt hoa/thường). */
function cmpPath(a: string, b: string): number {
  const x = norm(a).split(/[\\/]/);
  const y = norm(b).split(/[\\/]/);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = cpCmp(x[i], y[i]);
    if (c) return c;
  }
  return x.length - y.length;
}

/** Python `rglob("*")` lọc `is_file() or is_symlink()`: KHÔNG đi vào symlink/junction (Node coi junction
 * là symlink — chặt hơn Python 3.12 vốn đi vào junction rồi mới chặn bằng `resolve()`). */
function walk(dir: string, out: string[]): void {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // Python 3.12 rglob: scandir lỗi (EACCES/EPERM/ENOENT…) → bỏ thư mục đó, lô chạy tiếp
    if (isFsError(e)) return;
    throw e;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) out.push(p);
    else if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
}

function isRelativeTo(p: string, root: string): boolean {
  const a = norm(p);
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Tên lỗi in ra (Python `type(e).__name__`) — không in chi tiết/DSN. */
function errReason(e: unknown): string {
  if (e instanceof DocError) return e.message;
  if (isFsError(e)) return pyOsName(e);
  if (e instanceof pg.DatabaseError) return 'DatabaseError';
  return 'OperationalError';
}

/** Lỗi một tài liệu mà lô chạy tiếp (Python `DocError, OSError, psycopg.Error`). */
const perDocError = (e: unknown) => e instanceof DocError || isFsError(e) || isDbError(e);

const RACE = Symbol('race');

type Kind = 'new' | 'dup' | 'cho_ocr';

async function processOne(
  path: string,
  intakeDir: string,
  originalsDir: string,
  db: Db,
  provider: string,
  env: Env,
): Promise<[Kind, string, string]> {
  const sha = sha256File(path);
  storeOriginal(path, sha, originalsDir);
  const ex = await db.query('select status from documents where sha256 = $1', [sha]);
  if (ex.rows.length) return ['dup', sha, 'trùng — bỏ qua'];
  const dtype = docTypeOf(path, intakeDir);
  // Trích từ BẢN GỐC đã kiểm hash (không đọc lại tệp intake — tệp nguồn đổi sau khi hash thì field vẫn
  // khớp đúng sha256 đã lưu).
  const [text, pages, source] = await extractText(
    join(originalsDir, sha),
    provider,
    pySuffix(pyName(path)),
    env,
  );
  let status: string;
  let pii: boolean | null;
  let fields: Record<string, [string, number]>;
  if (source === 'none') [status, pii, fields] = ['cho_ocr', null, {}];
  else {
    status = 'pending_review';
    pii = hasPii(text);
    fields = dtype === 'giay_tiep_nhan' ? extractFields(text) : {};
  }
  try {
    await withTx(db, async (c) => {
      const cur = await c.query(
        'insert into documents (sha256, filename, doc_type, pages, text_source, pii_flag, status)' +
          ' values ($1, $2, $3, $4, $5, $6, $7) on conflict (sha256) do nothing',
        [sha, pyName(path), dtype, pages, source, pii, status],
      );
      if (cur.rowCount !== 1) throw RACE; // tiến trình khác vừa insert cùng sha
      const engine = OCR_ENGINES[provider];
      if (source === 'ocr' && engine) {
        // cùng giao dịch
        await c.query('update documents set ocr_engine = $1 where sha256 = $2', [engine, sha]);
      }
      for (const [field, [value, conf]] of Object.entries(fields)) {
        await c.query(
          'insert into document_fields (sha256, field, value, confidence, verified)' +
            ' values ($1, $2, $3, $4, false) on conflict (sha256, field) do nothing',
          [sha, field, value, conf],
        );
      }
    });
  } catch (e) {
    if (e === RACE) return ['dup', sha, 'trùng — bỏ qua'];
    throw e;
  }
  return [
    status === 'cho_ocr' ? 'cho_ocr' : 'new',
    sha,
    `${dtype} ${status} fields=${Object.keys(fields).length}`,
  ];
}

export type Counts = { new: number; dup: number; cho_ocr: number; skipped: number; error: number };

/** Quét đệ quy `intakeDir` → số đếm. Thư mục không tồn tại/rỗng → toàn 0. Lỗi 1 tệp không dừng lô. */
export async function intake(
  intakeDir: string,
  originalsDir: string,
  db: Db,
  provider = 'none',
  o: { env?: Env; log?: (s: string) => void } = {},
): Promise<Counts> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  if (!known(provider)) throw new RangeError(`OCR provider không hỗ trợ: ${provider}`);
  if (!PROVIDERS[provider][1]) {
    throw new RangeError(`OCR provider nước ngoài bị từ chối: ${provider}`);
  }
  const counts: Counts = { new: 0, dup: 0, cho_ocr: 0, skipped: 0, error: 0 };
  let isDir = false;
  try {
    isDir = statSync(intakeDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    log('[warn] thư mục intake không tồn tại — 0 file');
    return counts;
  }
  const root = realpathSync(intakeDir);
  const files: string[] = [];
  walk(intakeDir, files);
  files.sort(cmpPath);
  for (const [k, path] of files.entries()) {
    const i = k + 1;
    const ext = pySuffix(pyName(path)).toLowerCase();
    let res: [Kind, string, string];
    try {
      // Symlink/junction trỏ ra ngoài intake → không đọc (không kéo tệp tùy ý vào kho bản gốc).
      if (
        lstatSync(path).isSymbolicLink() ||
        !(ext === PDF_EXT || IMAGE_EXTS.includes(ext)) ||
        !isRelativeTo(realpathSync(path), root)
      ) {
        counts.skipped++;
        log(`[skip] #${i} đuôi/loại không nhận`);
        continue;
      }
      if (statSync(path).size === 0) {
        counts.skipped++;
        log(`[skip] #${i} file rỗng`);
        continue;
      }
      res = await processOne(path, intakeDir, originalsDir, db, provider, env);
    } catch (e) {
      if (!perDocError(e)) throw e;
      counts.error++;
      log(`[err] #${i} ${errReason(e)}`);
      continue;
    }
    const [kind, sha, info] = res;
    // cho_ocr là bản ghi MỚI ở trạng thái chờ OCR: đếm cả new.
    counts[kind === 'dup' ? 'dup' : 'new']++;
    if (kind === 'cho_ocr') counts.cho_ocr++;
    log(`[${kind === 'dup' ? 'dup' : 'new'}] ${sha.slice(0, 12)} ${info}`);
  }
  return counts;
}

/** OCR lại tài liệu `cho_ocr` (đợt hợp đồng G3) → {done, still, error}. Provider none/nước ngoài/lạ →
 * RangeError TRƯỚC mọi truy vấn. Không bao giờ tự `verified`. */
export async function reprocessPending(
  db: Db,
  originalsDir: string,
  provider: string,
  o: { env?: Env; log?: (s: string) => void } = {},
): Promise<{ done: number; still: number; error: number }> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  if (!known(provider) || provider === 'none') throw new RangeError(OCR_BLOCKED);
  if (!PROVIDERS[provider][1]) {
    throw new RangeError(`OCR provider nước ngoài bị từ chối: ${provider}`);
  }
  const counts = { done: 0, still: 0, error: 0 };
  const { rows } = await db.query<{ sha256: string; filename: string; doc_type: string }>(
    "select sha256, filename, doc_type from documents where status = 'cho_ocr'" +
      ' order by created_at, sha256',
  );
  for (const { sha256: sha, filename, doc_type: dtype } of rows) {
    const orig = join(originalsDir, sha);
    let nFields = 0;
    try {
      let isFile = false;
      try {
        isFile = statSync(orig).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile || sha256File(orig) !== sha) {
        throw new DocError('bản gốc thiếu/lệch hash — không OCR');
      }
      const [text, pages, source] = await extractText(orig, provider, pySuffix(filename), env);
      if (source === 'none') {
        counts.still++;
        log(`[still] ${sha.slice(0, 12)} OCR không ra chữ — giữ cho_ocr`);
        continue;
      }
      const fields = dtype === 'giay_tiep_nhan' ? extractFields(text) : {};
      nFields = Object.keys(fields).length;
      const ok = await withTx(db, async (c) => {
        const cur = await c.query(
          'update documents set text_source = $1, pii_flag = $2, pages = $3, ocr_engine = $4,' +
            " status = 'pending_review' where sha256 = $5 and status = 'cho_ocr'",
          [source, hasPii(text), pages, OCR_ENGINES[provider] ?? null, sha],
        );
        if (cur.rowCount !== 1) throw RACE; // tiến trình khác vừa xử lý
        for (const [field, [value, conf]] of Object.entries(fields)) {
          await c.query(
            'insert into document_fields (sha256, field, value, confidence, verified)' +
              ' values ($1, $2, $3, $4, false) on conflict (sha256, field) do nothing',
            [sha, field, value, conf],
          );
        }
        return true;
      }).catch((e) => {
        if (e === RACE) return false;
        throw e;
      });
      if (!ok) continue;
    } catch (e) {
      if (!perDocError(e)) throw e;
      counts.error++;
      log(`[err] ${sha.slice(0, 12)} ${errReason(e)}`);
      continue;
    }
    counts.done++;
    log(`[ocr] ${sha.slice(0, 12)} ${dtype} → pending_review fields=${nFields}`);
  }
  return counts;
}

// ---------------------------------------------------------------------------- Pháp chế

export type PendingRow = {
  sha256: string;
  doc_type: string;
  status: string;
  pii_flag: boolean | null;
  fields: string;
};

export async function listPending(db: Db): Promise<PendingRow[]> {
  const { rows } = await db.query<PendingRow>(
    'select d.sha256, d.doc_type, d.status, d.pii_flag,' +
      " coalesce(string_agg(f.field || '=' || f.value, '; '" +
      " order by f.field) filter (where not f.verified), '') as fields" +
      ' from documents d left join document_fields f using (sha256)' +
      " where d.status in ('pending_review', 'cho_ocr')" +
      ' group by d.sha256 order by d.created_at',
  );
  return rows;
}

/**
 * pending_review → verified|rejected qua function SECURITY DEFINER `doc_review_human` (v15.4 P10.1 —
 * danh tính theo login Postgres, khối legal_hr, + log `doc_<status>`). Không ở pending_review → false.
 * DB từ chối danh tính → HumanDenied.
 */
export async function setReview(
  db: Db,
  sha: string,
  status: 'verified' | 'rejected',
  by: string,
  env: Env = process.env,
): Promise<boolean> {
  const r = await callHuman<{ ok: boolean }>(
    db,
    'select doc_review_human($1, $2, $3) as ok',
    [sha, status, by],
    {
      by,
      block: 'legal_hr',
      action: status === 'verified' ? 'verify' : 'reject',
      objectType: 'document',
      objectId: sha.slice(0, 12),
      env,
    },
  );
  return r.rows[0]?.ok === true;
}

// ---------------------------------------------------------------------------- CLI

export type DocIntakeOpts = {
  pending?: boolean;
  verify?: string;
  reject?: string;
  by?: string;
  reprocessPending?: boolean;
};

export type DocIntakeDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  loaderGateFile?: string;
};

const PROG = 'doc-intake';

/** `doc-intake` (Python `python -m ingest.doc_intake`): intake · --pending · --verify/--reject SHA
 * --by · --reprocess-pending. Exit: 0 ok · 1 lỗi tệp/DB down/bị chặn quyền · 2 sai tham số, OCR chưa
 * cấu hình/không ra chữ, cổng loader chặn. */
export async function docIntakeMain(o: DocIntakeOpts, d: DocIntakeDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  const nOps =
    Number(Boolean(o.pending)) +
    Number(o.verify !== undefined) +
    Number(o.reject !== undefined) +
    Number(Boolean(o.reprocessPending));
  if (nOps > 1) {
    return usage('chỉ 1 thao tác mỗi lần (--pending | --verify | --reject | --reprocess-pending)');
  }
  let sha = o.verify !== undefined ? o.verify : o.reject;
  const by = pyStrip(o.by ?? '');
  if (sha !== undefined) {
    sha = pyStrip(sha).toLowerCase();
    if (!SHA_RE.test(sha)) return usage('sha256 phải đúng 64 ký tự hex');
    if (!by) return usage('--by <tên người xác nhận> là bắt buộc');
    if (cpLen(by) > 100 || !isPrintable(by)) {
      return usage('--by không hợp lệ (≤100 ký tự in được)');
    }
  } else if (o.by !== undefined) return usage('--by chỉ dùng với --verify/--reject');

  const provider = pyStrip(env.OCR_PROVIDER ?? '') || 'none';
  if (nOps === 0 && !known(provider)) {
    return usage(
      `OCR_PROVIDER=${provider} chưa hỗ trợ (có: ${Object.keys(PROVIDERS).join(', ')}) — provider có phí là external-dep`,
    );
  }
  if (nOps === 0 && !PROVIDERS[provider][1]) {
    return usage(
      `OCR_PROVIDER=${provider} là dịch vụ nước ngoài — bị từ chối (tài liệu chưa OCR coi như có PII)`,
    );
  }
  if (o.reprocessPending && (provider === 'none' || !known(provider) || !PROVIDERS[provider][1])) {
    io.out(`[blocked] ${OCR_BLOCKED}`);
    return 2;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.out('[err] không kết nối được Postgres (DATABASE_URL)');
    return 1;
  }
  const db = lease.db;
  const dirEnv = (name: string, def: string) => pyStrip(env[name] ?? '') || def;
  const origDir = dirEnv('DOC_ORIGINALS_DIR', repoPath('data', 'originals'));
  try {
    (d.wire ?? ((x: Db) => void wireCore(x)))(db);
    if (o.reprocessPending) {
      const c = await reprocessPending(db, origDir, provider, { env, log: io.out });
      io.out(`[done] done=${c.done} still=${c.still} error=${c.error}`);
      return c.error ? 1 : 0;
    }
    if (o.pending) {
      const rows = await listPending(db);
      for (const r of rows) {
        const piiS = r.pii_flag === true ? 'pii' : r.pii_flag === false ? 'no-pii' : 'pii?';
        io.out(`${r.sha256} ${r.doc_type} ${r.status} ${piiS} ${maskPii(r.fields)}`);
      }
      io.out(`[done] ${rows.length} tài liệu chờ`);
      return 0;
    }
    if (sha !== undefined) {
      const status = o.verify !== undefined ? 'verified' : 'rejected';
      // v14.2: Pháp chế được Bên B ủy quyền (cliGate, legal_hr) — bản đối chiếu này là căn cứ `da_cap`
      // của XNQC.
      const why = await cliGate(
        db,
        by,
        'legal_hr',
        o.verify !== undefined ? 'verify' : 'reject',
        'document',
        sha.slice(0, 12),
        { env, warn: io.err },
      );
      if (why) {
        io.out(`[err] ${why} — không đổi gì`);
        return 1;
      }
      let done: boolean;
      try {
        done = await setReview(db, sha, status, by, env);
      } catch (e) {
        if (e instanceof HumanDenied) {
          io.out(`[err] DB từ chối: ${e.message} — không đổi gì`);
          return 1;
        }
        throw e;
      }
      if (!done) {
        io.out(
          `[err] ${sha.slice(0, 12)} không tồn tại hoặc không ở pending_review — không đổi gì`,
        );
        return 1;
      }
      io.out(`[ok] ${sha.slice(0, 12)} → ${status} bởi ${by}`);
      return 0;
    }
    // v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) — chưa cấu hình + tính năng tắt →
    // không nhận tài liệu mới.
    const gate = await loaderGate('doc_intake', db, d.loaderGateFile, io.out);
    if (gate) {
      io.out(`[rollout] ${gate}`);
      return 2;
    }
    const c = await intake(
      dirEnv('DOC_INTAKE_DIR', repoPath('data', 'intake')),
      origDir,
      db,
      provider,
      {
        env,
        log: io.out,
      },
    );
    io.out(
      `[done] new=${c.new} dup=${c.dup} cho_ocr=${c.cho_ocr} skipped=${c.skipped} error=${c.error}`,
    );
    if (c.error) return 1;
    if (c.cho_ocr && provider === 'none') {
      // Không báo thành công câm: tài liệu scan/ảnh CHƯA có chữ.
      io.out(`[blocked] ${c.cho_ocr} tài liệu scan/ảnh ở cho_ocr — ${OCR_BLOCKED}`);
      return 2;
    }
    if (c.cho_ocr) {
      // r13: có provider mà OCR không ra chữ (ảnh trắng/mờ) — vẫn không báo thành công câm.
      io.out(
        `[cho_ocr] ${c.cho_ocr} tài liệu OCR (${provider}) không ra chữ — giữ cho_ocr; người đọc bản gốc hoặc quét lại`,
      );
      return 2;
    }
    return 0;
  } finally {
    await lease.release().catch(() => {});
  }
}
