import { readFileSync, statSync } from 'node:fs';
import { basename, extname, parse } from 'node:path';
import { withTx } from '@samsam/core/ops/tx';
import { isHuman } from '@samsam/core/security/auth';
import { casefold, cpLen, pyStrip, S, stripAccents } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { chunkText, embedAll, pyDumps, sha256, vecLiteral } from './embed-store.js';
import type { Ai } from './rag.service.js';

// Port `ingest/kb_internal.py` — nạp 1 tài liệu NỘI BỘ ĐÃ DUYỆT vào `chunks_internal`:
//  - CHỈ chạy sau khi trưởng phòng duyệt — `--approved-by` là QUYẾT ĐỊNH NGƯỜI (data_platform-03):
//    `agent:`/`system:` bị từ chối khi validate; rồi `cliGate(khối data_platform, approve)` trên kết
//    nối bằng login CỦA NGƯỜI (DATABASE_URL); ghi bảng bằng login loader (LOADER_DATABASE_URL).
//  - Validate HẾT trước khi connect DB và trước khi embed (lỗi → exit 2).
//  - Tài liệu MẬT bị TỪ CHỐI trước connect/embed: 20 dòng đầu có khóa `confidential` theo sau `:`/`=`
//    (FAIL-CLOSED: mọi giá trị trừ false/no/0/off/không — giá trị rỗng/lạ cũng chặn).
//  - Bảng RIÊNG `chunks_internal` (chatbot khách answer() không đọc tới).
//  - `doc_sha256` trùng bản đang có → 0 embed, "không đổi"; đổi → embed xong mới delete+insert trong
//    1 transaction, `doc_version`+1 — CHỈ khi `cutover` (chuyển hẳn sang TS, RAG Python đã tắt).
//  - KHÁC Python có chủ đích — mặc định SONG SONG (KE_HOACH mục 1): `chunks_internal` do Python ghi
//    (`embedding` float8[] mà tra cứu nội bộ Python đọc) → TS chỉ điền `embedding_v2` cho row có
//    (chunk_index, content) khớp đúng chunk TS; chưa có bản Python / nội dung lệch → `missing` /
//    `mismatch`, 0 embed, 0 ghi.
//  - Không in nội dung file.

export const COLLECTION_RE = /^internal:[a-z0-9_]{1,32}$/;
export const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_BYTES = 1_000_000;
// Khóa `confidential` (không phải 'confidentiality') + `:`/`=`, cho phép ngoặc/`*`/`_`/backtick bao
// quanh khóa. Giá trị = phần còn lại của dòng (Python `.` ăn cả \r, U+2028 — JS `.` thì không).
const Q = `[${S}"'*_\`]`;
const CONFIDENTIAL_RE = new RegExp(
  `(?<![a-z0-9_])confidential(?![a-z0-9_])${Q}*[:=](?<val>[^\\n]*)`,
  'u',
);
const NOT_CONFIDENTIAL_RE = new RegExp(`^${Q}*(?:false|no|0|off|khong|không)[${S}"'*_\`,;]*$`, 'u');
export const CONFIDENTIAL_SCAN_LINES = 20;
const SUFFIXES = new Set(['.md', '.txt']);

export function slug(stem: string): string {
  const s = casefold(stripAccents(stem)).replace(/[^a-z0-9]+/g, '-');
  return s.replace(/^-+|-+$/g, '').slice(0, 64);
}

/** FAIL-CLOSED: dòng có khóa `confidential` [:=] mà giá trị KHÔNG tường minh là
 * false/no/0/off/không → true (mật). */
export function isConfidentialLine(line: string): boolean {
  // BOM (U+FEFF) không thuộc \s — bỏ trước để dòng 1 có BOM không lọt.
  const ln = casefold(line.replaceAll('\uFEFF', '').normalize('NFC'));
  const m = CONFIDENTIAL_RE.exec(ln);
  if (m === null) return false;
  return !NOT_CONFIDENTIAL_RE.test((m.groups?.val ?? '').split('#', 1)[0]);
}

export type KbOpts = {
  file?: string;
  collection?: string;
  approvedBy?: string;
  docId?: string;
  cutover?: boolean;
};
export type KbArgs = {
  file: string;
  collection: string;
  approvedBy: string;
  docId: string;
  title: string;
  sourceRef: string;
  text: string;
};

/** Validate toàn bộ input (Python parse_args) → args | thông điệp lỗi (exit 2). */
export function parseKbArgs(o: KbOpts): KbArgs | { error: string } {
  const missing = (['file', 'collection', 'approvedBy'] as const)
    .filter((k) => o[k] === undefined)
    .map((k) => (k === 'approvedBy' ? '--approved-by' : `--${k}`));
  if (missing.length)
    return { error: `the following arguments are required: ${missing.join(', ')}` };
  const file = o.file as string;
  const collection = o.collection as string;
  const approvedBy = pyStrip(o.approvedBy as string);
  if (!approvedBy || cpLen(approvedBy) > 200)
    return { error: '--approved-by phải là tên người duyệt (1-200 ký tự)' };
  if (!isHuman(approvedBy)) {
    return {
      error: '--approved-by phải là NGƯỜI thật — agent/hệ thống không duyệt tài liệu nội bộ',
    };
  }
  if (!COLLECTION_RE.test(collection))
    return { error: '--collection phải dạng internal:<phong> ([a-z0-9_]{1,32})' };
  if (!SUFFIXES.has(extname(file).toLowerCase())) return { error: '--file chỉ nhận .md hoặc .txt' };
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { error: '--file không tồn tại' };
    size = st.size;
  } catch {
    return { error: '--file không tồn tại' };
  }
  if (size === 0 || size > MAX_BYTES) return { error: `--file rỗng hoặc > ${MAX_BYTES} byte` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    return { error: '--file không đọc được dạng UTF-8' };
  }
  if (!pyStrip(text)) return { error: '--file chỉ có khoảng trắng' };
  if (text.split('\n').slice(0, CONFIDENTIAL_SCAN_LINES).some(isConfidentialLine))
    return { error: '--file gắn confidential (tài liệu MẬT) — không nạp/embed' };
  const docId = o.docId !== undefined ? o.docId : slug(parse(file).name);
  if (!DOC_ID_RE.test(docId)) return { error: '--doc-id phải là slug [a-z0-9_-] (<=64)' };
  return {
    file,
    collection,
    approvedBy,
    docId,
    title: parse(file).name,
    sourceRef: basename(file),
    text,
  };
}

/** sha256 của doc nội bộ (cùng công thức Python ingest_doc). */
export function docSha(
  model: string,
  collection: string,
  docId: string,
  title: string,
  sourceRef: string,
  chunks: string[],
): string {
  return sha256(pyDumps([model, collection, docId, title, sourceRef, chunks]));
}

export type IngestResult = {
  status: 'loaded' | 'unchanged' | 'backfilled' | 'missing' | 'mismatch';
  chunks: number;
  version: number;
};

/** Nạp/cập nhật 1 doc vào `chunks_internal`. */
export async function ingestDoc(
  db: Pool,
  ai: Pick<Ai, 'embed'>,
  a: {
    collection: string;
    docId: string;
    title: string;
    sourceRef: string;
    text: string;
    approvedBy: string;
    model: string;
    cutover?: boolean;
  },
  log: (s: string) => void = console.log,
): Promise<IngestResult> {
  const chunks = chunkText(a.text);
  if (!a.cutover) return backfillDoc(db, ai, a, chunks, log);
  const sha = docSha(a.model, a.collection, a.docId, a.title, a.sourceRef, chunks);
  const r = (
    await db.query<{
      mn: string | null;
      mx: string | null;
      n: number;
      nv: number;
      ver: number | null;
    }>(
      'select min(doc_sha256) as mn, max(doc_sha256) as mx, count(*)::int as n,' +
        ' count(embedding_v2)::int as nv, max(doc_version) as ver from chunks_internal' +
        ' where collection = $1 and doc_id = $2',
      [a.collection, a.docId],
    )
  ).rows[0];
  // thiếu embedding_v2 (vd row Python cùng hash) → embed lại, không "không đổi"
  if (r.n && r.mn === sha && r.mx === sha && r.n === chunks.length && r.nv === r.n) {
    return { status: 'unchanged', chunks: r.n, version: r.ver as number };
  }
  const vectors = await embedAll(ai, a.model, chunks, undefined, log);
  const ver = (r.ver ?? 0) + 1;
  await withTx(db, async (c) => {
    await c.query('delete from chunks_internal where collection = $1 and doc_id = $2', [
      a.collection,
      a.docId,
    ]);
    for (const [i, chunk] of chunks.entries()) {
      await c.query(
        'insert into chunks_internal (collection, doc_id, chunk_index, title, source_ref,' +
          ' content, embedding_v2, doc_sha256, doc_version, approved_by, approved_at,' +
          ' ingested_at) values ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,now(),now())',
        [
          a.collection,
          a.docId,
          i,
          a.title,
          a.sourceRef,
          chunk,
          vecLiteral(vectors[i]),
          sha,
          ver,
          a.approvedBy,
        ],
      );
    }
  });
  return { status: 'loaded', chunks: chunks.length, version: ver };
}

/** SONG SONG: điền `embedding_v2` cho row Python khớp đúng chunk TS; không đụng cột/row khác. */
async function backfillDoc(
  db: Pool,
  ai: Pick<Ai, 'embed'>,
  a: { collection: string; docId: string; model: string },
  chunks: string[],
  log: (s: string) => void,
): Promise<IngestResult> {
  const rs = (
    await db.query<{ chunk_index: number; content: string; v2: boolean; ver: number }>(
      'select chunk_index, content, embedding_v2 is not null as v2, doc_version as ver' +
        ' from chunks_internal where collection = $1 and doc_id = $2 order by chunk_index',
      [a.collection, a.docId],
    )
  ).rows;
  const version = Math.max(0, ...rs.map((x) => x.ver));
  if (!rs.length) return { status: 'missing', chunks: 0, version };
  if (
    rs.length !== chunks.length ||
    rs.some((x, i) => x.chunk_index !== i || x.content !== chunks[i])
  )
    return { status: 'mismatch', chunks: rs.length, version };
  const miss = rs.filter((x) => !x.v2).map((x) => x.chunk_index);
  if (!miss.length) return { status: 'unchanged', chunks: rs.length, version };
  const vectors = await embedAll(
    ai,
    a.model,
    miss.map((i) => chunks[i]),
    undefined,
    log,
  );
  let updated = 0;
  await withTx(db, async (c) => {
    for (const [k, i] of miss.entries()) {
      const r = await c.query(
        'update chunks_internal set embedding_v2 = $1::vector where collection = $2 and doc_id = $3' +
          ' and chunk_index = $4 and content = $5 and embedding_v2 is null',
        [vecLiteral(vectors[k]), a.collection, a.docId, i, chunks[i]],
      );
      updated += r.rowCount ?? 0;
    }
  });
  // Python nạp lại giữa chừng → row mới không khớp, không gắn vector sai
  return {
    status: updated === miss.length ? 'backfilled' : 'mismatch',
    chunks: rs.length,
    version,
  };
}
