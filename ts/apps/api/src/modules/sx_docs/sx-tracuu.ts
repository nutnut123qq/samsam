import { createHash } from 'node:crypto';
import { GatewayError } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import {
  casefold,
  cpHead,
  cpLen,
  D,
  pySplit,
  pyStr,
  re,
  S,
  splitlines,
  W,
} from '@samsam/core/security/py';
import pg, { type Pool } from 'pg';
import {
  type Ai,
  type Hit,
  MIN_SCORE,
  NO_DATA as RAG_NO_DATA,
  RagService,
} from '../rag/rag.service.js';
import { type DbLease, type Io, isFsError, pyStrip, STD_IO } from './shared.js';

// Port `agents/sx_tracuu.py` (v10.2 W102.3 — SX-A7 tra cứu khoa học NỘI BỘ, khối Sản xuất; tính năng
// production-05.1 "Tra cứu tài liệu R&D" + production-05.2 "Tóm tắt tài liệu R&D"). Tài liệu do GĐ SX
// duyệt nạp vào `chunks_internal` collection `internal:sx` (nạp bằng `kb-internal`) — CHỈ nội bộ,
// KHÔNG truyền thông, chatbot khách không đọc được.
// Contract giữ nguyên Python: câu rỗng/chỉ dấu câu, câu về rượu → NO_DATA, 0 embed. Embed qua AI
// Gateway (agent `sx_tracuu`, feature production-05.1) → `retrieveByVector(..., collection=COLLECTION)`
// (HẰNG module); điểm top < MIN_SCORE → NO_DATA. Nguồn: DOI/URL từ 20 dòng đầu chunk 0 (1 SELECT),
// không có → tên tệp. Mặc định trích NGUYÊN VĂN (≤ 600 ký tự/đoạn, ≤ 3 đoạn, che PII) + `[n]`. `--llm`:
// 1 lời gọi chat (production-05.2); lỗi/rỗng/guardrail không đạt → về trích đoạn + lý do (mã vi phạm,
// không trích span). MỌI đầu ra mở đầu nhãn LABEL. Module CHỈ ĐỌC DB, không đăng/gửi gì.

export const AGENT_ID = 'sx_tracuu';
// HẰNG — không nhận collection từ CLI/hàm (không tra chéo phòng khác).
export const COLLECTION = 'internal:sx';
export const LABEL = 'NỘI BỘ – không dùng cho truyền thông';
export const NO_DATA = RAG_NO_DATA;
export const MAX_Q = 2000;
export const DEFAULT_K = 5;
export const MAX_K = 20;
export const EXTRACT_MAX = 600;
export const MAX_EXTRACTS = 3;
const CITE_LINES = 20;
const CITE_MAX = 300;
const LLM_MAX = 3000;
export const FEATURE_LOOKUP = 'production-05.1';
export const FEATURE_SUMMARY = 'production-05.2';
const CITE_RE = re(`^(doi|url)[${S}]*:[${S}]*([^${S}]+)`, 'd');
const URL_OK = re(`^https?://[^${S}<>\`"']+$`);
const DOI_OK = re(`^10\\.${D}{4,9}/[^${S}<>\`"']+$`);
const WORD_RE = re(`[${W}]`);
const CITE_SQL =
  'select doc_id, content from chunks_internal where collection = $1 and doc_id = any($2)' +
  ' and chunk_index = 0';
export const SYSTEM =
  'Bạn hỗ trợ tra cứu tài liệu khoa học NỘI BỘ của bộ phận sản xuất.' +
  ' Chỉ dựa vào NGỮ CẢNH được cung cấp, trích số nguồn dạng [n] sau' +
  ' mỗi ý. Không bổ sung kiến thức ngoài ngữ cảnh. Không kết luận' +
  ' công dụng cho người tiêu dùng, không khuyến nghị sử dụng sản' +
  ' phẩm. Thiếu thông tin thì nói rõ là tài liệu chưa đề cập.';

export type Source = {
  doc_id: string;
  title: string | null;
  source_ref: string | null;
  cite: string;
};
export type Result = {
  answer: string;
  sources: Source[];
  label: string;
  mode: 'extract' | 'llm' | 'no_data';
  reason: string;
};

export const normQ = (q: unknown): string => pySplit(q ? pyStr(q) : '').join(' ');

/** DOI/URL từ 20 dòng đầu chunk 0 (casefold); không có → tên tệp. */
export function cite(docId: string, sourceRef: string | null, head: string | null): string {
  for (const line of splitlines(head ?? '').slice(0, CITE_LINES)) {
    const stripped = pyStrip(line);
    const m = CITE_RE.exec(casefold(stripped));
    if (!m) continue;
    // giữ nguyên chữ hoa/thường của giá trị (URL phân biệt hoa thường); tiền tố (doi|url)\s*:\s* là
    // ký tự BMP casefold 1:1 → vị trí nhóm 2 trên bản casefold = trên dòng gốc.
    const start = m.indices?.[2]?.[0] ?? 0;
    const raw = pySplit(cpHead(stripped.slice(start), CITE_MAX))[0] ?? '';
    if (m[1] === 'doi' && DOI_OK.test(casefold(raw))) return `DOI: ${raw}`;
    if (m[1] === 'url' && URL_OK.test(raw)) return `URL: ${raw}`;
  }
  const name = cpHead(pySplit(pyStr(sourceRef || docId)).join(' '), CITE_MAX);
  return `(chưa có DOI/URL — tên file ${name})`;
}

const noData = (reason: string): Result => ({
  answer: NO_DATA,
  sources: [],
  label: LABEL,
  mode: 'no_data',
  reason,
});

type HitLike = { doc_id: string; content?: unknown; title?: unknown };

export function extractHits(hits: HitLike[], idx: Map<string, number>): string {
  return hits
    .slice(0, MAX_EXTRACTS)
    .map((h) => {
      const raw = h.content ? pyStr(h.content) : '';
      const text = cpHead(pySplit(maskPii(cpHead(raw, EXTRACT_MAX * 2))).join(' '), EXTRACT_MAX);
      return `[${idx.get(h.doc_id)}] "${text}"`;
    })
    .join('\n\n');
}

export function violationCodes(g: Record<string, unknown>): string {
  const vs = Array.isArray(g.violations) ? g.violations : [];
  const codes = vs
    .filter(
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
    )
    .map((v) => pyStr(v.type || v.code || '?'));
  return [...new Set(codes)].join(',') || 'ok_not_true';
}

const errName = (e: unknown) => (e as Error)?.constructor?.name ?? 'Error';

async function llmAnswer(
  question: string,
  hits: HitLike[],
  idx: Map<string, number>,
  ai: Pick<Ai, 'chat'>,
): Promise<[string | null, string]> {
  const ctx = hits
    .map(
      (h) =>
        `[${idx.get(h.doc_id)}] ${h.title ? pyStr(h.title) : ''}\n${h.content ? pyStr(h.content) : ''}`,
    )
    .join('\n\n');
  const msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `NGỮ CẢNH:\n${ctx}\n\nCÂU HỎI: ${question}` },
  ];
  let text: unknown;
  try {
    const resp = await ai.chat(AGENT_ID, msgs, {
      feature: FEATURE_SUMMARY,
      temperature: 0.0,
      maxTokens: 600,
    });
    if (typeof resp !== 'object' || resp === null) return [null, 'phản hồi LLM hỏng'];
    text = resp.text;
  } catch (e) {
    if (e instanceof GatewayError) return [null, `gateway: ${errName(e)}`];
    throw e;
  }
  if (typeof text !== 'string' || !pyStrip(text)) return [null, 'LLM trả rỗng'];
  const out = maskPii(cpHead(pyStrip(text), LLM_MAX));
  const g = guardrailCheck(out) as unknown as Record<string, unknown>;
  if (g.ok !== true) return [null, `guardrail: ${violationCodes(g)}`];
  return [out, ''];
}

export type AskDeps = {
  ai: Ai;
  db: Db;
  /** top-k theo vector (mặc định RagService.retrieveByVector trên `db`) */
  retrieve?: (qv: number[], k: number, o: { collection: string }) => Promise<Hit[]>;
  env?: Env;
};

/** → {answer, sources, label, mode, reason}. `db` dùng cho 1 SELECT trích nguồn + truy vấn vector. */
export async function ask(
  question: unknown,
  o: { k?: number; llm?: boolean },
  d: AskDeps,
): Promise<Result> {
  const q = normQ(question);
  if (!WORD_RE.test(q)) return noData('câu hỏi rỗng');
  if (cpLen(q) > MAX_Q) throw new RangeError(`câu hỏi dài quá ${MAX_Q} ký tự`);
  if (isAlcohol(q)) return noData('không tra cứu đồ uống có cồn');
  const k = Math.max(1, Math.min(Math.trunc(o.k ?? DEFAULT_K), MAX_K));
  let qv: number[];
  try {
    qv = (await d.ai.embed(AGENT_ID, q, { feature: FEATURE_LOOKUP })).embeddings[0];
  } catch (e) {
    if (e instanceof GatewayError) return noData(`embed lỗi (${errName(e)})`);
    throw e;
  }
  const retrieve =
    d.retrieve ??
    ((v: number[], kk: number, opts: { collection: string }) => {
      const svc = new RagService(d.db as Pool, d.ai);
      if (d.env) svc.env = d.env;
      return svc.retrieveByVector(v, kk, opts);
    });
  const hits = (await retrieve(qv, k, { collection: COLLECTION })).filter(
    (h) => h.score >= MIN_SCORE,
  );
  if (!hits.length) return noData('không có tài liệu đủ liên quan');
  const docIds = [...new Set(hits.map((h) => h.doc_id))];
  const { rows } = await d.db.query<{ doc_id: string; content: string }>(CITE_SQL, [
    COLLECTION,
    docIds,
  ]);
  const heads = new Map(rows.map((r) => [r.doc_id, r.content]));
  const first = new Map<string, Hit>();
  for (const h of hits) if (!first.has(h.doc_id)) first.set(h.doc_id, h);
  const idx = new Map(docIds.map((id, i) => [id, i + 1]));
  const sources: Source[] = docIds.map((id) => {
    const h = first.get(id) as Hit;
    return {
      doc_id: id,
      title: h.title,
      source_ref: h.url,
      cite: cite(id, h.url, heads.get(id) ?? null),
    };
  });
  const res: Result = {
    answer: extractHits(hits, idx),
    sources,
    label: LABEL,
    mode: 'extract',
    reason: '',
  };
  if (o.llm) {
    const [text, why] = await llmAnswer(q, hits, idx, d.ai);
    if (text === null) res.reason = `LLM bị loại: ${why} — dùng trích đoạn`;
    else {
      res.answer = text;
      res.mode = 'llm';
    }
  }
  return res;
}

/** Markdown — dòng ĐẦU luôn là nhãn nội bộ. */
export function render(res: Result, question: string): string {
  const L = [
    `**${LABEL}**`,
    '',
    `Câu hỏi: ${cpHead(maskPii(normQ(question)), MAX_Q)}`,
    `Chế độ: ${res.mode}`,
    '',
    res.answer,
    '',
  ];
  if (res.reason) L.push(`Ghi chú: ${res.reason}`, '');
  if (res.sources.length) {
    L.push('Nguồn:');
    res.sources.forEach((s, i) => {
      L.push(`[${i + 1}] ${pySplit(pyStr(s.title || s.doc_id)).join(' ')} — ${s.cite}`);
    });
    L.push('');
  }
  L.push(`*${LABEL}. Không trích dẫn ra kênh khách/marketing.*`);
  return `${L.join('\n')}\n`;
}

// Đợt hoàn thiện 22/10: TRA CỨU (trích nguyên văn — production-05.1) và TÓM TẮT (LLM ĐÃ qua guardrail —
// production-05.2) là 2 đầu ra riêng. Tóm tắt bị loại → bản rơi về trích đoạn = đầu ra TRA CỨU.
export const PREFIX_LOOKUP = 'sx-tracuu-';
export const PREFIX_SUMMARY = 'sx-tomtat-';

export function reportName(question: string, now: Date, mode = 'extract'): string {
  const sha = createHash('sha256').update(normQ(question), 'utf8').digest('hex').slice(0, 8);
  const pre = mode === 'llm' ? PREFIX_SUMMARY : PREFIX_LOOKUP;
  return `${pre}${vnDate(now)}-${sha}.md`;
}

// ---------------------------------------------------------------------------- CLI

export type SxTracuuOpts = { ask?: string; k?: string; llm?: boolean; out?: boolean };
export type SxTracuuDeps = {
  env?: Env;
  io?: Io;
  connect?: () => Promise<DbLease | null>;
  /** AI Gateway trên kết nối của lệnh (mặc định `wireCore(db)` — nối cả cổng triển khai). */
  wire?: (db: Db) => Ai;
  retrieve?: AskDeps['retrieve'];
  now?: () => Date;
  reportsDir?: string;
};

const PROG = 'sx-tracuu';

/** `sx-tracuu --ask "<câu hỏi>" [--k N] [--llm] [--out]` (Python `python -m agents.sx_tracuu`).
 * Exit: 0 ok (kể cả NO_DATA) · 2 tham số sai / câu quá dài / DB down / lỗi DB / tính năng tắt. */
export async function sxTracuuMain(o: SxTracuuOpts, d: SxTracuuDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  if (o.ask === undefined) return usage('the following arguments are required: --ask');
  let k = DEFAULT_K;
  if (o.k !== undefined) {
    const v = pyInt(o.k);
    if (v === null) return usage(`argument --k: invalid int value: '${o.k}'`);
    k = v > 1000n ? 1000 : v < -1000n ? -1000 : Number(v);
  }
  if (cpLen(normQ(o.ask)) > MAX_Q) return usage(`--ask dài quá ${MAX_Q} ký tự`);
  if (!(k >= 1 && k <= MAX_K)) return usage(`--k phải trong 1..${MAX_K}`);
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  const db = lease.db;
  let res: Result;
  try {
    const ai = (d.wire ?? ((x: Db) => wireCore(x)))(db);
    // r12 D1/GATE-OUT: tra cứu (05.1) và tóm tắt AI (05.2) kiểm cổng TRƯỚC lời gọi AI/in/ghi — tắt thì
    // không embed/chat, không in trích đoạn/tóm tắt, không ghi tệp.
    const gates: [string, string][] = [[FEATURE_LOOKUP, 'tra cứu tài liệu R&D']];
    if (o.llm) gates.push([FEATURE_SUMMARY, 'tóm tắt AI tài liệu R&D']);
    for (const [fid, what] of gates) {
      const why = await blocked(db, what, fid);
      if (why) return sayBlocked(why, io.out);
    }
    try {
      res = await ask(o.ask, { k, llm: Boolean(o.llm) }, { ai, db, retrieve: d.retrieve, env });
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.err(
        `[warn] lỗi DB: ${e instanceof pg.DatabaseError ? 'DatabaseError' : 'OperationalError'}`,
      );
      return 2;
    }
  } finally {
    await lease.release().catch(() => {});
  }
  const now = (d.now ?? (() => new Date()))();
  const text = render(res, o.ask);
  io.out(text.replace(/\n$/, ''));
  if (o.out) {
    let p: string;
    try {
      // P8.4: tài liệu nội bộ trưởng phòng duyệt (chunks_internal).
      p = await writeReport(
        text,
        d.reportsDir ?? REPORTS_DIR,
        reportName(o.ask, now, res.mode),
        false,
      );
    } catch (e) {
      if (!isFsError(e)) throw e;
      io.err(`[warn] không ghi được file (${pyOsName(e)})`);
      return 2;
    }
    io.out(`[done] ${p}`);
  }
  return 0;
}
