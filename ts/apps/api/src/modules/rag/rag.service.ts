import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import { type AiGateway, GatewayError } from '@samsam/core/ai/gateway';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { type Env, pyStrip } from '@samsam/core/env';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { scrubUser } from '@samsam/core/security/pii';
import { pyStr } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { AI_GATEWAY, PG_POOL } from '../../db/db.module.js';

// Port `api/rag.py` — RAG trên bảng `chunks`: embed câu hỏi → cosine top-k → LLM trả lời.
// Contract với caller (connector Zalo/Messenger/kênh sàn, tab Chat): answer() →
// { answer, sources[, handoff] } — sources rỗng = "không đủ dữ liệu", không bịa.
//  - Mọi lời gọi AI qua AI Gateway (agent "chatbot", feature sales-01 | sales-02).
//  - Câu hỏi sức khỏe → NO_DATA + handoff "health"; rượu → "alcohol"; còn dấu hiệu PII → "pii"
//    — 0 lời gọi AI. Text khách (câu hỏi + lượt user của history) che PII TRƯỚC mọi lời gọi.
//  - retrieve() DENY-BY-DEFAULT: mặc định chỉ corpus CÔNG KHAI `chunks` (bỏ chunk nhắc rượu);
//    `internal:<phong>` phải truyền tường minh, đọc bảng riêng `chunks_internal`. answer() KHÔNG có
//    tham số collection.
//  - Hạn chót 30 giây (PL02): trước MỖI bước tốn thời gian còn < 1 giây → DeadlineExceeded(bước);
//    còn đủ → truyền thời gian còn lại xuống lời gọi gateway / bước đọc DB.
// KHÁC Python có chủ đích (KE_HOACH mục 1, 5): vector = cột `embedding_v2 vector(1024)` (BGE-M3,
// docs/schema_ts.sql) thay `embedding float8[]` 1536 chiều — backend `float8` = quét CHÍNH XÁC trên
// cột đó bằng SQL (thay numpy), `pgvector` = HNSW; chunk chưa embed lại (embedding_v2 null) không
// được trả. Đồng hồ = epoch ms (cùng đồng hồ deadline của gateway) thay `time.monotonic()`.

export const TOP_K = 8;
export const MIN_SCORE = 0.25; // cosine dưới ngưỡng → coi như KB không có thông tin
export const NO_DATA = 'Chưa đủ dữ liệu để trả lời.';
export const AGENT = 'chatbot';
// v13.7 — PL02 mục 2: phản hồi tự động ≤ 30 giây TÍNH TỪ LÚC NHẬN TIN tới khi gửi xong. Connector
// chia: trả lời ≤ 30 − SEND_RESERVE_S, phần còn lại cho lời gọi gửi.
export const CHAT_BUDGET_S = 30.0;
export const SEND_RESERVE_S = 5.0;
export const MIN_CALL_S = 1.0; // còn ít hơn → không bắt đầu lời gọi mới
const MIN_CALL_MS = MIN_CALL_S * 1000;
/** Hạn chót tuyệt đối (epoch ms) của lượt trả lời — connector đặt bằng `DEADLINE.run(hạn, fn)`
 * (Python contextvar `DEADLINE`). */
export const DEADLINE = new AsyncLocalStorage<number>();

export const FEATURE = 'sales-01'; // chatbot CSKH — trần/nút tắt theo tính năng (PL01)
// Vá controller 22/10 (F1): gợi ý chat sàn (sales-02) dùng chung RAG nhưng chịu trần/nút tắt/ghi
// chi phí của CHÍNH nó. Caller chọn mã theo KÊNH (hằng nội bộ), không bao giờ từ text khách.
export const FEATURES: ReadonlySet<string> = new Set([FEATURE, 'sales-02']);
export const VECTOR_BACKENDS = ['float8', 'pgvector'] as const;
export type VectorBackend = (typeof VECTOR_BACKENDS)[number];
export const PGVECTOR_CANDIDATES = 64; // ứng viên lấy từ HNSW trước lọc rượu
export const PGVECTOR_EF_SEARCH = 100; // >= số ứng viên (mặc định pgvector 40)
export const CATALOG_MIN_SCORE = 0.15;
// Python `_PG_MISSING`: UndefinedColumn / UndefinedObject / UndefinedFunction.
const PG_MISSING = new Set(['42703', '42704', '42883']);
const INTERNAL_RE = /^internal:[a-z0-9_]{1,32}$/;

export const SYSTEM = `Bạn là trợ lý CSKH của Công ty TNHH Sâm Sâm (sâm Ngọc Linh).
Trả lời bằng tiếng Việt, ngắn gọn, CHỈ dựa vào NGỮ CẢNH bên dưới.

Luật:
- Thông tin không có trong ngữ cảnh -> trả lời đúng câu "Chưa đủ dữ liệu để trả lời."
- Giá ghi 'Liên hệ' -> nói nguyên văn 'Liên hệ', tuyệt đối không tự bịa giá.
- Tên sản phẩm kèm hậu tố quy cách (vd 'Saphraton 20V') là MỘT QUY CÁCH
  của sản phẩm gốc, không phải sản phẩm khác. Hỏi giá/loại sản phẩm X phải
  nêu ĐỦ giá của cả X lẫn mọi quy cách 'X ...' trong ngữ cảnh.
  VD: hỏi 'Saphraton giá bao nhiêu' mà ngữ cảnh có 'Saphraton — 1.000.000 đ'
  và 'Saphraton 20V — 236.000 đ' thì PHẢI trả lời: 'Saphraton hộp 80 viên:
  1.000.000 đ; gói Saphraton 20V: 236.000 đ'. Hỏi danh sách sản phẩm ->
  liệt kê tên sản phẩm, không kể nhóm công dụng.
- 'Mã số doanh nghiệp' chính là mã số thuế của công ty.
- Hỏi liên hệ/hotline/điện thoại -> liệt kê ĐỦ mọi số xuất hiện trong
  ngữ cảnh kèm nhãn của nó (vd 'Hotline:', 'ĐT:').
- Không khẳng định công dụng y tế ngoài công dụng đã công bố trong ngữ cảnh;
  tuyệt đối không nói sản phẩm "chữa", "điều trị", "thuốc", "khỏi bệnh".
- Không trích link trong câu trả lời — nguồn do hệ thống hiển thị riêng.
`;
const REWRITE =
  'Viết lại câu hỏi cuối của user thành một câu hỏi độc ' +
  'lập, đủ ngữ cảnh để tra knowledge base, giữ nguyên ' +
  'ngôn ngữ. Chỉ trả về câu hỏi đã viết lại, không giải ' +
  'thích.';

/** Hết ngân sách thời gian trả lời — connector chuyển người. */
export class DeadlineExceeded extends Error {
  override name = 'DeadlineExceeded';
  constructor(readonly stage: string) {
    super(`hết hạn 30 giây ở bước ${stage}`);
  }
}

export type Ai = Pick<AiGateway, 'chat' | 'embed'>;
export type Row = {
  title: string | null;
  url: string | null;
  lang: string | null;
  content: string;
  doc_id: string;
  chunk_index?: number;
};
export type Hit = Row & { score: number };
export type Answer = { answer: string; sources: string[]; handoff?: string };
type Msg = Record<string, unknown>;

/** Mã tính năng nội bộ; ngoài `FEATURES` → RangeError (Python ValueError) trước mọi lời gọi. */
export function featureOf(feature: unknown): string {
  if (typeof feature !== 'string' || !FEATURES.has(feature)) {
    throw new RangeError(
      `feature RAG không thuộc danh sách nội bộ ['${[...FEATURES].sort().join("', '")}']`,
    );
  }
  return feature;
}

/** Python `_query`: collection → [SQL quét chính xác, params]. Chỉ "public" hoặc internal:<phong>
 * (regex chặt); mọi giá trị khác → RangeError (deny-by-default). `ident` thêm chunk_index. */
export function query(collection: unknown, ident = false): [string, string[]] {
  const extra = ident ? ', chunk_index' : '';
  const score = '1 - (embedding_v2 <=> $1::vector) as score';
  if (collection === 'public') {
    return [
      `select title, source_url as url, lang, content, doc_id${extra}, ${score} from chunks` +
        ' where embedding_v2 is not null order by score desc, doc_id, chunk_index',
      [],
    ];
  }
  if (typeof collection === 'string' && INTERNAL_RE.test(collection)) {
    return [
      `select title, source_ref as url, null::text as lang, content, doc_id${extra}, ${score}` +
        ' from chunks_internal where collection = $2 and embedding_v2 is not null' +
        ' order by score desc, doc_id, chunk_index',
      [collection],
    ];
  }
  throw new RangeError(
    "collection không hợp lệ — chỉ 'public' hoặc 'internal:<phong>' ([a-z0-9_]{1,32})",
  );
}

/** v10.3: backend vector = tham số > env RAG_VECTOR_BACKEND > 'float8'. Giá trị lạ → RangeError. */
export function vectorBackend(backend?: string | null, env: Env = process.env): VectorBackend {
  const b =
    backend !== undefined && backend !== null
      ? backend
      : pyStrip(env.RAG_VECTOR_BACKEND ?? '') || 'float8';
  if (!(VECTOR_BACKENDS as readonly string[]).includes(b)) {
    throw new RangeError("RAG_VECTOR_BACKEND không hợp lệ — chỉ 'float8' | 'pgvector'");
  }
  return b as VectorBackend;
}

const allowed = (row: Row, isPublic: boolean) =>
  !isPublic || !(isAlcohol(row.content) || isAlcohol(row.title));

function hit(row: Row, score: number, ident: boolean): Hit {
  const h: Hit = {
    title: row.title,
    url: row.url,
    lang: row.lang,
    content: row.content,
    score: Number(score),
    doc_id: row.doc_id,
  };
  if (ident) h.chunk_index = row.chunk_index;
  return h;
}

/** CHUNG cho 2 backend (`_select`). cands = (row, score) giảm dần; catalog = chunk
 * `catalog-products` (public). Lọc rượu theo thứ tự điểm, dừng khi đủ k. → [hits, số hit TRƯỚC khi
 * ghim catalog]. */
export function select(
  cands: Iterable<[Row, number]>,
  k: number,
  isPublic: boolean,
  catalog: [Row, number][],
  ident: boolean,
): [Hit[], number] {
  const top: Hit[] = [];
  for (const [row, score] of cands) {
    if (top.length >= k) break;
    if (allowed(row, isPublic)) top.push(hit(row, score, ident));
  }
  const n = top.length;
  // Doc "Danh mục sản phẩm" list đủ SKU+giá trong 1 chunk → luôn ghim vào context nếu liên quan.
  if (isPublic && catalog.length && top.every((h) => h.doc_id !== 'catalog-products')) {
    const ok = catalog.filter(([r]) => allowed(r, isPublic));
    if (ok.length) {
      let best = ok[0];
      for (const x of ok) if (x[1] > best[1]) best = x;
      if (best[1] >= CATALOG_MIN_SCORE) top.push(hit(best[0], best[1], ident));
    }
  }
  return [top, n];
}

// Hậu kiểm định danh (nghiệm thu v3.9): chuỗi >=9 chữ số liền trong câu trả lời (MST/SĐT/STK)
// phải có nguyên văn trong ngữ cảnh/câu hỏi/history (so cả bản bỏ 1 dấu cách/chấm/gạch giữa 2 số).
const LONG_NUM_RE = /(?<!\p{Nd})\p{Nd}{9,}(?!\p{Nd})/gu;
const DIGIT_SEP_RE = /(?<=\p{Nd})[ .-](?=\p{Nd})/gu;

/** True nếu `text` có chuỗi >=9 chữ số liền không có trong `grounding`. */
export function unverifiedNumber(text: string, grounding: string): boolean {
  const nums = text.match(LONG_NUM_RE);
  if (!nums) return false;
  const pool = `${grounding}\n${grounding.replace(DIGIT_SEP_RE, '')}`;
  return nums.some((n) => !pool.includes(n));
}

const isObj = (m: unknown): m is Msg => typeof m === 'object' && m !== null && !Array.isArray(m);

/** v13.1: lượt user → `scrubUser`; lượt còn dấu hiệu PII thì bỏ luôn câu trả lời kế tiếp của nó
 * (cặp hỏi/đáp). docx P1: câu bot cũ cũng che trước khi gửi AI. */
export function scrubHistory(history: unknown[] | null | undefined): Msg[] {
  const out: Msg[] = [];
  let skip = false;
  for (const m of history ?? []) {
    if (!isObj(m)) continue;
    const c = m.content;
    if (m.role === 'user' && typeof c === 'string') {
      const [masked, risky] = scrubUser(c);
      skip = risky;
      if (skip) continue;
      out.push({ ...m, content: masked });
    } else if (skip && m.role === 'assistant') {
      skip = false;
    } else if (m.role === 'assistant' && typeof c === 'string') {
      out.push({ ...m, content: scrubUser(c)[0] });
    } else {
      out.push(m);
    }
  }
  return out;
}

// Python sorted() theo code point (JS sort mặc định theo UTF-16).
export function cpCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d) return d;
  }
  return x.length - y.length;
}

const vecLiteral = (qv: readonly number[]) => `[${qv.map((x) => String(Number(x))).join(',')}]`;
const toRow = (r: Record<string, unknown>): [Row, number] => [r as Row, Number(r.score)];

export type RetrieveOpts = {
  collection?: string;
  backend?: string | null;
  ident?: boolean;
  deadline?: number | null;
};

@Injectable()
export class RagService {
  /** đồng hồ epoch ms — test thay bằng đồng hồ giả (không wall-clock) */
  clock: () => number = Date.now;
  env: Env = process.env;
  warn: (m: string) => void = (m) => console.error(m);
  private pgWarned = false;
  private v2Warned = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AI_GATEWAY) private readonly ai: Ai,
  ) {}

  /** ms còn lại trước `deadline` (null = không hạn chót); < 1 giây → DeadlineExceeded. */
  private left(deadline: number | null | undefined, stage: string): number | null {
    if (deadline === null || deadline === undefined) return null;
    const left = deadline - this.clock();
    if (left < MIN_CALL_MS) throw new DeadlineExceeded(stage);
    return left;
  }

  /** Gọi gateway với timeout = thời gian còn lại; hết giờ (client timeout/đồng hồ) → Deadline. */
  private async timed<T>(
    stage: string,
    deadline: number | null | undefined,
    call: (timeoutMs: number | undefined) => Promise<T>,
  ): Promise<T> {
    const left = this.left(deadline, stage);
    try {
      return await call(left ?? undefined);
    } catch (e) {
      if (e instanceof GatewayError && deadline !== null && deadline !== undefined) {
        const name = (e.cause as { name?: unknown } | undefined)?.name;
        if (this.clock() >= deadline || (typeof name === 'string' && name.includes('Timeout'))) {
          throw new DeadlineExceeded(stage);
        }
      }
      throw e;
    }
  }

  /** Bước DB trong hạn còn lại (Python: connect_timeout theo thời gian còn lại). */
  private async within<T>(p: Promise<T>, left: number | null, stage: string): Promise<T> {
    if (left === null) return p;
    let t: NodeJS.Timeout | undefined;
    const timer = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new DeadlineExceeded(stage)), left);
    });
    try {
      return await Promise.race([p, timer]);
    } finally {
      clearTimeout(t);
    }
  }

  /** v10.3: top-`limit` ứng viên theo cosine qua HNSW + điểm các chunk `catalog-products` (public).
   * `set local` cần giao dịch (chỉ đọc → rollback). */
  private async rankPgvector(
    collection: string,
    lit: string,
    limit: number,
    ident: boolean,
  ): Promise<[[Row, number][], [Row, number][]]> {
    const extra = ident ? ', chunk_index' : '';
    const score = '1 - (embedding_v2 <=> $1::vector) as score';
    const isPublic = collection === 'public';
    const cols = isPublic
      ? `title, source_url as url, lang, content, doc_id${extra}, ${score}`
      : `title, source_ref as url, null::text as lang, content, doc_id${extra}, ${score}`;
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      // lọc collection SAU khi quét HNSW có thể trả thiếu → quét lặp
      if (!isPublic) await c.query('set local hnsw.iterative_scan = strict_order');
      const ef = Math.min(1000, Math.max(PGVECTOR_EF_SEARCH, Math.trunc(limit)));
      await c.query(`set local hnsw.ef_search = ${ef}`);
      const main = isPublic
        ? await c.query(
            `select ${cols} from chunks where embedding_v2 is not null` +
              ' order by embedding_v2 <=> $1::vector limit $2',
            [lit, Math.trunc(limit)],
          )
        : await c.query(
            `select ${cols} from chunks_internal where collection = $2 and` +
              ' embedding_v2 is not null order by embedding_v2 <=> $1::vector limit $3',
            [lit, collection, Math.trunc(limit)],
          );
      const catalog = isPublic
        ? (
            await c.query(
              `select ${cols} from chunks where doc_id = 'catalog-products'` +
                ' and embedding_v2 is not null',
              [lit],
            )
          ).rows.map(toRow)
        : [];
      await c.query('rollback');
      return [main.rows.map(toRow), catalog];
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private warnPgMissing(e: unknown): void {
    if (this.pgWarned) return;
    this.pgWarned = true;
    this.warn(
      `[warn] RAG_VECTOR_BACKEND=pgvector nhưng DB thiếu cột embedding_v2/extension vector ` +
        `(${(e as { code?: string }).code}) — dùng quét chính xác (áp docs/schema_ts.sql).`,
    );
  }

  /** Top-k chunk cho vector đã embed. `pgvector`: DB thiếu cột/extension/GUC → rollback + [warn]
   * 1 lần/tiến trình → quét chính xác; lọc rượu ăn hết `limit` ứng viên mà còn < k → chạy lại quét
   * chính xác (không trả thiếu). */
  async retrieveByVector(qv: readonly number[], k = TOP_K, o: RetrieveOpts = {}): Promise<Hit[]> {
    const collection = o.collection === undefined ? 'public' : o.collection; // null → từ chối như Python None
    const ident = o.ident ?? false;
    const [sql, params] = query(collection, ident);
    const backend = vectorBackend(o.backend, this.env);
    const isPublic = collection === 'public';
    const lit = vecLiteral(qv);
    const left = this.left(o.deadline, 'db');
    return this.within(
      (async () => {
        if (backend === 'pgvector') {
          const limit = Math.max(PGVECTOR_CANDIDATES, k);
          try {
            const [cands, catalog] = await this.rankPgvector(collection, lit, limit, ident);
            const [hits, n] = select(cands, k, isPublic, catalog, ident);
            if (n >= k || cands.length < limit) return hits;
          } catch (e) {
            if (!PG_MISSING.has((e as { code?: string }).code ?? '')) throw e;
            this.warnPgMissing(e);
          }
        }
        let rows: [Row, number][];
        try {
          rows = (await this.pool.query(sql, [lit, ...params])).rows.map(toRow);
        } catch (e) {
          // DB chưa áp docs/schema_ts.sql (thiếu embedding_v2/vector) → không có dữ liệu (answer →
          // NO_DATA), kênh khách không nhận lỗi DB thô; [warn] 1 lần/tiến trình.
          if (!PG_MISSING.has((e as { code?: string }).code ?? '')) throw e;
          if (!this.v2Warned) {
            this.v2Warned = true;
            this.warn(
              `[warn] DB thiếu cột embedding_v2/extension vector (${(e as { code?: string }).code})` +
                ' — RAG trả không có dữ liệu (áp docs/schema_ts.sql + embed-store).',
            );
          }
          return [];
        }
        if (!rows.length) return [];
        const catalog = isPublic ? rows.filter(([r]) => r.doc_id === 'catalog-products') : [];
        return select(rows, k, isPublic, catalog, ident)[0];
      })(),
      left,
      'db',
    );
  }

  /** Top-k chunk theo cosine. `collection` + backend validate TRƯỚC khi gọi embed; public bỏ row
   * nhắc rượu (lớp phòng thủ cho row nạp ngoài embed-store/legacy). */
  async retrieve(
    question: string,
    k = TOP_K,
    o: { collection?: string; deadline?: number | null; feature?: string } = {},
  ): Promise<Hit[]> {
    const collection = o.collection === undefined ? 'public' : o.collection; // null → từ chối như Python None
    query(collection);
    const feature = featureOf(o.feature === undefined ? FEATURE : o.feature);
    const backend = vectorBackend(undefined, this.env);
    const r = await this.timed('embed', o.deadline, (timeoutMs) =>
      this.ai.embed(AGENT, question, { feature, timeoutMs }),
    );
    return this.retrieveByVector(r.embeddings[0], k, {
      collection,
      backend,
      deadline: o.deadline,
    });
  }

  /** Rewrite câu follow-up thành câu độc lập đủ ngữ cảnh để retrieve (chỉ phục vụ retrieval).
   * Model trả rỗng → "" → caller dùng câu gốc. */
  private async standalone(
    question: string,
    history: Msg[],
    deadline: number | null,
    feature: string,
  ): Promise<string> {
    const r = await this.timed('rewrite', deadline, (timeoutMs) =>
      this.ai.chat(
        AGENT,
        [
          { role: 'system', content: REWRITE },
          ...(history as ChatMessage[]),
          { role: 'user', content: question },
        ],
        { feature: featureOf(feature), temperature: 0, maxTokens: 100, timeoutMs },
      ),
    );
    return pyStrip(r.text ?? '');
  }

  /**
   * Trả lời câu hỏi kèm nguồn. Thiếu context/score thấp → NO_DATA. `history` = các lượt Q&A trước
   * (caller giới hạn 4 lượt gần nhất): có history → rewrite câu hỏi thành câu độc lập trước khi
   * retrieve, prompt trả lời vẫn giữ câu hỏi gốc + history. Gateway chặn (trần/kill/tắt/không đọc
   * được chi tiêu) → GatewayBlocked lan ra caller (connector chuyển người). `feature` ngoài
   * `FEATURES` → RangeError, 0 lời gọi.
   */
  async answer(
    question: string,
    history?: unknown[] | null,
    o: { deadline?: number | null; feature?: string } = {},
  ): Promise<Answer> {
    const feature = featureOf(o.feature === undefined ? FEATURE : o.feature);
    const deadline = o.deadline ?? DEADLINE.getStore() ?? null;
    if (isHealthQuestion(question)) return { answer: NO_DATA, sources: [], handoff: 'health' };
    if (isAlcohol(question)) return { answer: NO_DATA, sources: [], handoff: 'alcohol' };
    // v13.1 (F02): đối chiếu số (`unverifiedNumber`) dùng text GỐC — kiểm cục bộ, không gửi đi.
    const rawTurns = [
      question,
      ...(history ?? [])
        .filter((m) => isObj(m) && typeof m.content === 'string')
        .map((m) => (m as Msg).content as string),
    ];
    const [q, risky] = scrubUser(question);
    if (risky) return { answer: NO_DATA, sources: [], handoff: 'pii' };
    const hist = scrubHistory(history);
    let searchQ = q;
    if (hist.length) {
      searchQ = scrubUser((await this.standalone(q, hist, deadline, feature)) || q)[0];
      if (isAlcohol(searchQ)) return { answer: NO_DATA, sources: [], handoff: 'alcohol' };
      if (isHealthQuestion(searchQ)) return { answer: NO_DATA, sources: [], handoff: 'health' };
    }
    const hits = await this.retrieve(searchQ, TOP_K, { deadline, feature });
    if (!hits.length || hits[0].score < MIN_SCORE) return { answer: NO_DATA, sources: [] };

    const context = hits
      .map((h, i) => `[${i + 1}] ${pyStr(h.title)} (${pyStr(h.url)})\n${pyStr(h.content)}`)
      .join('\n\n');
    const r = await this.timed('chat', deadline, (timeoutMs) =>
      this.ai.chat(
        AGENT,
        [
          { role: 'system', content: SYSTEM },
          ...(hist as ChatMessage[]),
          { role: 'user', content: `NGỮ CẢNH:\n${context}\n\nCÂU HỎI: ${q}` },
        ],
        { feature, temperature: 0, maxTokens: 500, timeoutMs },
      ),
    );
    // Rỗng/chỉ khoảng trắng → NO_DATA (D5.2/D5.8: không gửi message rỗng).
    const text = pyStrip(r.text ?? '') || NO_DATA;
    if (unverifiedNumber(text, [context, ...rawTurns].join('\n'))) {
      return { answer: NO_DATA, sources: [] };
    }
    let sources = [
      ...new Set(hits.filter((h) => h.score >= MIN_SCORE && h.url).map((h) => h.url as string)),
    ].sort(cpCompare);
    if (text.includes(NO_DATA)) sources = [];
    return { answer: text, sources };
  }
}
