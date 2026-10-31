import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GatewayError } from '@samsam/core/ai/gateway';
import { JsonFileError, parseJsonBytes } from '@samsam/core/ops/py';
import { withTx } from '@samsam/core/ops/tx';
import { DATA_DIR } from '@samsam/core/paths';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { casefold, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import type { Ai } from './rag.service.js';

// Port `ingest/embed_store.py` — đồng bộ data/*.jsonl vào bảng `chunks` (corpus CÔNG KHAI duy nhất
// của chatbot khách), incremental:
//  1. Nguồn TIN CẬY = đọc được + >=1 record. missing / 0 byte / chỉ dòng trắng / chỉ `{"_doc":…}`
//     → KHÔNG tin cậy → KHÔNG xóa chunk của nguồn đó (gotcha delete-trắng v1.8). Dòng hỏng →
//     SourceError TRƯỚC embed và TRƯỚC mọi ghi DB.
//  2. Lọc rượu (luật QC rượu >=15 độ): record có name/title nhắc rượu → bỏ cả record; chunk nhắc
//     rượu → bỏ. Doc `catalog-products` dựng SAU khi bỏ SKU rượu.
//  3. `doc_sha256` = sha256(model, source, title, url, lang, chunk sau lọc) → đổi model/từ khóa lọc
//     làm hash đổi → embed lại doc đó.
//  4. Chỉ embed chunk của doc mới/đổi hash (embed xong hết mới ghi DB — embed lỗi giữa chừng = 0 ghi).
//  5. MỘT transaction: delete+insert doc đổi (`doc_version` cũ+1, mới 1); xóa doc không còn trong tập
//     public của nguồn tin cậy; row legacy `source is null` chỉ xóa khi MỌI nguồn tin cậy. Row có
//     `source` ngoài danh sách nguồn (nạp tay) không bị đụng.
// KHÁC Python có chủ đích: vector ghi cột `embedding_v2` (BGE-M3 1024 chiều qua Ollama nội bộ),
// `embedding` float8[] để null — model trong hash = `ai_policy.json` local.embed_model.
// CHẠY SONG SONG với bản Python (KE_HOACH mục 1, docs/schema_ts.sql): `chunks` do Python ghi —
// `sync` (delete+insert, `embedding` null) làm RAG Python crash (numpy trên row null) và hai bên
// embed lại của nhau mãi → CHỈ chạy khi chuyển hẳn sang TS (`--cutover`). Mặc định `backfill`:
// chỉ điền `embedding_v2` cho row Python có nội dung khớp đúng chunk TS, không đụng cột/row khác.
// TS chặt hơn (fail-closed, SourceError trước embed): title/url/name/price_vnd sai kiểu (Python: crash
// TypeError/lỗi DB sau khi đã embed).

export const JSONL_FILES = ['products.jsonl', 'articles.jsonl', 'about.jsonl', 'news.jsonl'];
export const CATALOG = 'catalog'; // source của doc tổng hợp, phụ thuộc products.jsonl
export const CATALOG_ID = 'catalog-products';
export const CHUNK_SIZE = 700;
export const CHUNK_OVERLAP = 80;
export const EMBED_BATCH = 64;
export const FEATURE = 'data_platform-03';

/** File nguồn có dòng hỏng — abort trước embed/ghi DB. */
export class SourceError extends Error {
  override name = 'SourceError';
}

type Rec = Record<string, unknown>;
export type Doc = {
  doc_id: string;
  source: string;
  source_url: string;
  title: string;
  lang: string;
  chunks: string[];
  sha: string;
};
export type FilterStats = {
  records: Record<string, number>;
  alcohol_records: Record<string, number>;
  alcohol_chunks: Record<string, number>;
};
type Log = (s: string) => void;

function price(rec: Rec): string {
  const v = rec.price_vnd;
  if (!pyTruthy(v)) return 'Liên hệ';
  return `${(v as number).toLocaleString('en-US').replaceAll(',', '.')} đ`;
}

/** Record jsonl → text để chunk. Product: kèm dòng Giá verbatim — null → 'Liên hệ'. */
export function docText(rec: Rec): string {
  const get = (k: string) => (Object.hasOwn(rec, k) ? pyStr(rec[k]) : '');
  if (Object.hasOwn(rec, 'name')) {
    return `Sản phẩm: ${pyStr(rec.name)}\nGiá: ${price(rec)}\n${get('description')}`;
  }
  return `${get('title')}\n${get('body')}`;
}

/** ngoclinh.com EN có /en/ trong permalink; còn lại tiếng Việt. */
export function langOf(url: string): string {
  return url.includes('/en/') ? 'en' : 'vi';
}

/** Sliding window ~size ký tự (code point như Python), ưu tiên ngắt ở khoảng trắng. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const t = [...text];
  const n = t.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let j = Math.min(i + size, n);
    if (j < n) {
      // Python text.rfind(" ", i + size // 2, j)
      for (let c = j - 1; c >= i + Math.floor(size / 2); c--) {
        if (t[c] === ' ') {
          j = c;
          break;
        }
      }
    }
    const chunk = pyStrip(t.slice(i, j).join(''));
    if (chunk) out.push(chunk);
    if (j >= n) break;
    i = j - overlap > i ? j - overlap : j;
  }
  return out;
}

// Python bytes.strip(): khoảng trắng ASCII.
const ASCII_WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);
function bytesStrip(b: Buffer): Buffer {
  let a = 0;
  let z = b.length;
  while (a < z && ASCII_WS.has(b[a])) a++;
  while (z > a && ASCII_WS.has(b[z - 1])) z--;
  return b.subarray(a, z);
}

/** Tách BYTES theo `\n` tường minh (không cắt U+2028/\x85 làm đôi record). */
export function splitLines(raw: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let s = 0;
  for (let i = raw.indexOf(0x0a); i !== -1; i = raw.indexOf(0x0a, s)) {
    out.push(raw.subarray(s, i));
    s = i + 1;
  }
  out.push(raw.subarray(s));
  return out;
}

/** Record hợp lệ của 1 file jsonl; null = nguồn KHÔNG tin cậy (missing / 0 byte / chỉ dòng trắng /
 * chỉ `_doc`). Dòng hỏng (JSON lỗi, không phải object, thiếu `id`) → SourceError. */
export function readSource(path: string): Rec[] | null {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
  const name = basename(path);
  const recs: Rec[] = [];
  splitLines(raw).forEach((l, idx) => {
    const line = bytesStrip(l);
    if (!line.length) return;
    let rec: unknown;
    try {
      rec = parseJsonBytes(line);
    } catch (e) {
      const t = e instanceof JsonFileError ? e.pyType : 'JSONDecodeError';
      throw new SourceError(`${name}:${idx + 1} JSON hỏng (${t})`);
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      throw new SourceError(`${name}:${idx + 1} không phải object`);
    }
    if (Object.hasOwn(rec, '_doc')) return;
    const id = (rec as Rec).id;
    if (typeof id !== 'string' || !id) throw new SourceError(`${name}:${idx + 1} thiếu id`);
    recs.push(rec as Rec);
  });
  return recs.length ? recs : null;
}

/** Python `json.dumps(v, ensure_ascii=False)` cho chuỗi / list lồng chuỗi (dấu phân cách ", "). */
export function pyDumps(v: unknown): string {
  return Array.isArray(v) ? `[${v.map(pyDumps).join(', ')}]` : JSON.stringify(v);
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function makeDoc(
  docId: string,
  source: string,
  url: string,
  title: string,
  lang: string,
  chunks: string[],
  model: string,
): Doc {
  const sha = sha256(pyDumps([model, source, title, url, lang, chunks]));
  return { doc_id: docId, source, source_url: url, title, lang, chunks, sha };
}

/** TS chặt hơn Python: field sai kiểu → SourceError trước embed (Python crash sau khi đã embed). */
function checkTypes(fn: string, rec: Rec, url: unknown, title: unknown): void {
  const bad = (what: string) => new SourceError(`${fn}: '${rec.id}' ${what} sai kiểu`);
  if (typeof url !== 'string') throw bad('url');
  if (typeof title !== 'string') throw bad('title/name');
  if (Object.hasOwn(rec, 'name') && typeof rec.name !== 'string') throw bad('name');
  if (Object.hasOwn(rec, 'name') && pyTruthy(rec.price_vnd) && !Number.isInteger(rec.price_vnd)) {
    throw bad('price_vnd');
  }
}

/** → [docs public {doc_id: doc}, tập nguồn tin cậy, thống kê lọc]. */
export function buildDocs(
  dataDir: string,
  model: string,
  log: Log = console.log,
): { docs: Map<string, Doc>; trusted: Set<string>; stats: FilterStats } {
  const docs = new Map<string, Doc>();
  const seenIds = new Set<string>();
  const trusted = new Set<string>();
  const stats: FilterStats = { records: {}, alcohol_records: {}, alcohol_chunks: {} };
  const productsVi: Rec[] = [];

  const add = (
    docId: string,
    source: string,
    url: string,
    title: string,
    lang: string,
    text: string,
  ) => {
    const chunks = chunkText(text);
    const kept = chunks.filter((c) => !isAlcohol(c));
    stats.alcohol_chunks[source] =
      (stats.alcohol_chunks[source] ?? 0) + chunks.length - kept.length;
    if (kept.length) docs.set(docId, makeDoc(docId, source, url, title, lang, kept, model));
  };

  for (const fn of JSONL_FILES) {
    const recs = readSource(join(dataDir, fn));
    if (recs === null) {
      log(`[warn] ${fn} thiếu/rỗng — KHÔNG xóa chunk của nguồn này`);
      continue;
    }
    trusted.add(fn);
    stats.records[fn] = recs.length;
    for (const rec of recs) {
      const id = rec.id as string;
      if (seenIds.has(id) || id === CATALOG_ID)
        throw new SourceError(`${fn}: doc_id trùng '${id}'`);
      seenIds.add(id);
      const url = pyTruthy(rec.url) ? rec.url : '';
      const title = pyTruthy(rec.title) ? rec.title : pyTruthy(rec.name) ? rec.name : '';
      checkTypes(fn, rec, url, title);
      if (isAlcohol(title)) {
        stats.alcohol_records[fn] = (stats.alcohol_records[fn] ?? 0) + 1;
        continue;
      }
      const u = url as string;
      if (Object.hasOwn(rec, 'name') && langOf(u) === 'vi') productsVi.push(rec);
      add(id, fn, u, title as string, langOf(u), docText(rec));
    }
  }

  // Doc tổng hợp "danh mục sản phẩm" — transform thuần từ products.jsonl (không bịa), SAU khi bỏ
  // SKU rượu. Chỉ tin cậy khi products.jsonl tin cậy.
  if (trusted.has('products.jsonl')) {
    trusted.add(CATALOG);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const p of productsVi) {
      const key = casefold(p.name as string);
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(`- ${p.name} — Giá: ${price(p)}`);
      }
    }
    if (lines.length) {
      add(
        CATALOG_ID,
        CATALOG,
        'http://samsam.net.vn/vi/shops/',
        'Danh mục sản phẩm Sâm Sâm',
        'vi',
        `Danh mục sản phẩm Công ty TNHH Sâm Sâm (kèm giá bán public):\n${lines.join('\n')}`,
      );
    }
  }
  return { docs, trusted, stats };
}

export const vecLiteral = (v: readonly number[]): string => `[${v.map(String).join(',')}]`;

/** Embed theo batch qua gateway (agent "ingest", data_platform-03); lỗi → ném (fail sớm, không nạp
 * thiếu). */
export async function embedAll(
  ai: Pick<Ai, 'embed'>,
  model: string,
  texts: string[],
  batch = EMBED_BATCH,
  log: Log = console.log,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const b = texts.slice(i, i + batch);
    const r = await ai.embed('ingest', b, { feature: FEATURE, model });
    out.push(...r.embeddings);
    log(`[embed] batch ${i / batch + 1}: ${b.length} texts`);
  }
  if (out.length !== texts.length) {
    throw new GatewayError('số vector trả về lệch số chunk — không ghi DB');
  }
  return out;
}

export type SyncStats = {
  new: number;
  changed: number;
  kept: number;
  deleted: number;
  embedded_chunks: number;
  embed_calls: number;
  trusted: string[];
} & FilterStats;

type Existing = {
  doc_id: string;
  mn: string | null;
  mx: string | null;
  n: number;
  nsha: number;
  nv: number;
  ver: number | null;
  smin: string | null;
  smax: string | null;
};

function logFilter(stats: FilterStats, log: Log): void {
  for (const fn of Object.keys(stats.records).sort()) {
    log(
      `[src] ${fn}: ${stats.records[fn]} records, bỏ ${stats.alcohol_records[fn] ?? 0} record rượu`,
    );
  }
  for (const src of Object.keys(stats.alcohol_chunks).sort()) {
    const n = stats.alcohol_chunks[src];
    if (n) log(`[filter] ${src}: bỏ ${n} chunk nhắc rượu`);
  }
}

/** CUTOVER (chuyển hẳn sang TS, RAG Python đã tắt): đồng bộ incremental nguồn → `chunks` bằng
 * delete+insert như Python. Trả thống kê. */
export async function sync(
  db: Pool,
  ai: Pick<Ai, 'embed'>,
  o: { dataDir?: string; model: string; batch?: number; log?: Log },
): Promise<SyncStats> {
  const log = o.log ?? console.log;
  const batch = o.batch ?? EMBED_BATCH;
  const { docs, trusted, stats } = buildDocs(o.dataDir ?? DATA_DIR, o.model, log);
  const allSources = new Set([...JSONL_FILES, CATALOG]);
  const existing = new Map<string, Existing>(
    (
      await db.query<Existing>(
        'select doc_id, min(doc_sha256) as mn, max(doc_sha256) as mx, count(*)::int as n,' +
          ' count(doc_sha256)::int as nsha, count(embedding_v2)::int as nv,' +
          ' max(doc_version) as ver, min(source) as smin, max(source) as smax' +
          ' from chunks group by doc_id',
      )
    ).rows.map((r) => [r.doc_id, r]),
  );
  const unchanged = (d: Doc) => {
    const e = existing.get(d.doc_id);
    return (
      e !== undefined &&
      e.mn === d.sha &&
      e.mx === d.sha &&
      e.n === d.chunks.length &&
      e.nsha === d.chunks.length &&
      e.nv === d.chunks.length && // row cùng hash mà thiếu embedding_v2 → RAG TS không thấy
      e.smin === d.source &&
      e.smax === d.source
    );
  };
  const changed = [...docs.values()].filter((d) => !unchanged(d));
  const nNew = changed.filter((d) => !existing.has(d.doc_id)).length;
  const everyTrusted =
    [...allSources].every((s) => trusted.has(s)) && trusted.size === allSources.size;
  const removed = [...existing.values()]
    .filter(
      (e) =>
        !docs.has(e.doc_id) &&
        ((e.smin !== null && e.smin === e.smax && trusted.has(e.smin)) ||
          (e.smin === null && e.smax === null && everyTrusted)),
    )
    .map((e) => e.doc_id);

  const texts = changed.flatMap((d) => d.chunks);
  const nCalls = Math.ceil(texts.length / batch);
  log(
    `[plan] doc mới ${nNew} / đổi ${changed.length - nNew} / giữ ${docs.size - changed.length}` +
      ` / xóa ${removed.length} — embed ${texts.length} chunk (${nCalls} lời gọi)`,
  );
  const vectors = texts.length ? await embedAll(ai, o.model, texts, batch, log) : [];

  if (changed.length || removed.length) {
    await withTx(db, async (c) => {
      await c.query('delete from chunks where doc_id = any($1::text[])', [
        [...removed, ...changed.map((d) => d.doc_id)],
      ]);
      let vi = 0;
      for (const d of changed) {
        const e = existing.get(d.doc_id);
        const ver = e ? (e.ver ?? 0) + 1 : 1;
        for (const [i, chunk] of d.chunks.entries()) {
          await c.query(
            'insert into chunks (doc_id, chunk_index, source_url, title, lang, content,' +
              ' embedding_v2, source, doc_sha256, doc_version, ingested_at)' +
              ' values ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10,now())',
            [
              d.doc_id,
              i,
              d.source_url,
              d.title,
              d.lang,
              chunk,
              vecLiteral(vectors[vi++]),
              d.source,
              d.sha,
              ver,
            ],
          );
        }
      }
    });
  }
  logFilter(stats, log);
  return {
    new: nNew,
    changed: changed.length - nNew,
    kept: docs.size - changed.length,
    deleted: removed.length,
    embedded_chunks: texts.length,
    embed_calls: nCalls,
    trusted: [...trusted].sort(),
    ...stats,
  };
}

export type BackfillStats = {
  filled: number; // doc được điền embedding_v2
  kept: number; // doc đã đủ embedding_v2
  blocked: string[]; // doc TS mới/đổi so với row Python → không ghi
  embedded_chunks: number;
  embed_calls: number;
  updated: number; // row thực sự điền (< embedded_chunks = Python nạp lại giữa chừng)
  trusted: string[];
} & FilterStats;

/** SONG SONG với Python (mặc định): chỉ `update chunks set embedding_v2` trên row có
 * (doc_id, chunk_index, content, source) khớp đúng chunk TS — không delete/insert, không đụng
 * `embedding`/`doc_sha256`/`doc_version`/`ingested_at`; doc chưa khớp → `blocked`. Chạy lại = 0 embed.
 * shortcut: không có cột ghi model của embedding_v2 — đổi embed_model thì phải xóa embedding_v2
 * (hoặc --cutover); nâng khi cần đổi model lúc còn song song (cột doc_sha256_v2 ở schema_ts.sql). */
export async function backfill(
  db: Pool,
  ai: Pick<Ai, 'embed'>,
  o: { dataDir?: string; model: string; batch?: number; log?: Log },
): Promise<BackfillStats> {
  const log = o.log ?? console.log;
  const batch = o.batch ?? EMBED_BATCH;
  const { docs, trusted, stats } = buildDocs(o.dataDir ?? DATA_DIR, o.model, log);
  type R = {
    doc_id: string;
    chunk_index: number;
    content: string;
    source: string | null;
    v2: boolean;
  };
  const byDoc = new Map<string, R[]>();
  for (const r of (
    await db.query<R>(
      'select doc_id, chunk_index, content, source, embedding_v2 is not null as v2 from chunks' +
        ' where doc_id = any($1::text[]) order by doc_id, chunk_index',
      [[...docs.keys()]],
    )
  ).rows) {
    byDoc.set(r.doc_id, [...(byDoc.get(r.doc_id) ?? []), r]);
  }
  const todo: [Doc, number][] = [];
  const blocked: string[] = [];
  let kept = 0;
  for (const d of docs.values()) {
    const rs = byDoc.get(d.doc_id) ?? [];
    const same =
      rs.length === d.chunks.length &&
      rs.every((r, i) => r.chunk_index === i && r.content === d.chunks[i] && r.source === d.source);
    if (!same) {
      blocked.push(d.doc_id);
      continue;
    }
    const miss = rs.filter((r) => !r.v2);
    if (!miss.length) kept++;
    for (const r of miss) todo.push([d, r.chunk_index]);
  }
  const filled = docs.size - kept - blocked.length;
  const texts = todo.map(([d, i]) => d.chunks[i]);
  const nCalls = Math.ceil(texts.length / batch);
  log(
    `[plan] song song: điền embedding_v2 ${filled} doc / đủ sẵn ${kept} / lệch bản Python` +
      ` ${blocked.length} — embed ${texts.length} chunk (${nCalls} lời gọi)`,
  );
  const vectors = texts.length ? await embedAll(ai, o.model, texts, batch, log) : [];
  let updated = 0;
  if (todo.length) {
    await withTx(db, async (c) => {
      for (const [k, [d, i]] of todo.entries()) {
        // điều kiện content/source: Python nạp lại giữa chừng → 0 row, không gắn vector sai
        const r = await c.query(
          'update chunks set embedding_v2 = $1::vector where doc_id = $2 and chunk_index = $3' +
            ' and content = $4 and source = $5 and embedding_v2 is null',
          [vecLiteral(vectors[k]), d.doc_id, i, d.chunks[i], d.source],
        );
        updated += r.rowCount ?? 0;
      }
    });
  }
  logFilter(stats, log);
  return {
    filled,
    kept,
    blocked,
    embedded_chunks: texts.length,
    embed_calls: nCalls,
    updated,
    trusted: [...trusted].sort(),
    ...stats,
  };
}
