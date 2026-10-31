import { GatewayBlocked, GatewayError } from '@samsam/core/ai/gateway';
import { createGateway } from '@samsam/core/ops/wire';
import { settings } from '@samsam/core/rollout/rollout';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import gold from './__fixtures__/rag.golden.json' with { type: 'json' };
import {
  type Ai,
  CHAT_BUDGET_S,
  DEADLINE,
  DeadlineExceeded,
  featureOf,
  type Hit,
  MIN_SCORE,
  NO_DATA,
  PGVECTOR_CANDIDATES,
  query,
  RagService,
  type Row,
  SEND_RESERVE_S,
  SYSTEM,
  scrubHistory,
  select,
  TOP_K,
  unverifiedNumber,
  vectorBackend,
} from './rag.service.js';

// Dịch từ tests/test_rag.py, test_rag_backend.py, test_kb_acl.py, test_v13_c07_ops.py (30 giây),
// test_fix_san_feature.py (feature theo kênh), test_v13_c01/v14_p1/v15_p9 (PII/sức khỏe trước AI).
// Logic thuần + luồng answer() so khớp golden sinh từ api/rag.py THẬT (__fixtures__/rag.golden.json).
// Nhà cung cấp/DB GIẢ — không gọi AI/DB thật.

type Call = Record<string, unknown>;
type Case = {
  q: string;
  h?: unknown[];
  hits: Hit[];
  rw?: string | null;
  ans: string | null;
  feature?: string;
};

/** AI giả ghi mọi lời gọi (kind/agent/messages/kw như golden Python). */
function fakeAi(c: Partial<Case>, calls: Call[]): Ai {
  return {
    chat: async (agent, messages, o) => {
      calls.push({
        kind: 'chat',
        agent,
        messages,
        kw: { temperature: o.temperature, max_tokens: o.maxTokens, feature: o.feature },
      });
      const isRw = String(messages[0].content).includes('Viết lại');
      return {
        text: (isRw ? c.rw : c.ans) ?? '',
        model: 'm',
        provider: 'ollama',
        tokensIn: 0,
        tokensOut: 0,
      };
    },
    embed: async (agent, input, o) => {
      calls.push({ kind: 'embed', agent, input, kw: { feature: o.feature } });
      return { embeddings: [[1, 0]], model: 'm', provider: 'ollama', tokensIn: 0 };
    },
  };
}

function service(ai: Ai, hits: Hit[] | null, calls: Call[], pool: unknown = {}): RagService {
  const s = new RagService(pool as Pool, ai);
  s.env = {};
  if (hits !== null) {
    s.retrieveByVector = async (qv, k, o) => {
      calls.push({ kind: 'rbv', qv, k, kw: { collection: o?.collection, backend: o?.backend } });
      return hits.map((h) => ({ ...h }));
    };
  }
  return s;
}

const pyRow = (r: unknown[]): Row => ({
  title: r[0] as string,
  url: r[1] as string,
  lang: r[2] as string,
  content: r[3] as string,
  doc_id: r[5] as string,
  chunk_index: r[6] as number,
});

describe('rag golden (logic thuần)', () => {
  it('hằng số khớp Python', () => {
    expect({ TOP_K, MIN_SCORE, NO_DATA, SYSTEM, CHAT_BUDGET_S, SEND_RESERVE_S }).toEqual({
      TOP_K: gold.consts.TOP_K,
      MIN_SCORE: gold.consts.MIN_SCORE,
      NO_DATA: gold.consts.NO_DATA,
      SYSTEM: gold.consts.SYSTEM,
      CHAT_BUDGET_S: gold.consts.CHAT_BUDGET_S,
      SEND_RESERVE_S: gold.consts.SEND_RESERVE_S,
    });
    expect(PGVECTOR_CANDIDATES).toBe(gold.consts.PGVECTOR_CANDIDATES);
  });

  it.each(gold.unverified)('unverifiedNumber %#', (c) => {
    expect(unverifiedNumber(c.in[0], c.in[1])).toBe(c.out);
  });

  it.each(gold.query)('query (deny-by-default) %#', (c) => {
    const run = () => query(c.in[0], c.in[1] as boolean);
    if ('err' in c) expect(run).toThrow(new RangeError(c.err));
    else expect(run()[1]).toEqual(c.ok?.[1]); // SQL TS khác (embedding_v2) — so params + chấp nhận/từ chối
  });

  it.each(gold.backend)('vectorBackend %#', (c) => {
    const env = c.env === null ? {} : { RAG_VECTOR_BACKEND: c.env };
    const run = () => vectorBackend(c.arg, env);
    if ('err' in c) expect(run).toThrow(new RangeError(c.err));
    else expect(run()).toBe(c.ok);
  });

  it.each(gold.select)('select (lọc rượu + ghim catalog) %#', (c) => {
    const cands = c.in.cands.map(([r, s]) => [pyRow(r as unknown[]), s as number] as [Row, number]);
    const catalog = c.in.catalog.map(
      ([r, s]) => [pyRow(r as unknown[]), s as number] as [Row, number],
    );
    const [hits, n] = select(cands, c.in.k, c.in.public, catalog, c.in.ident);
    expect({ hits, n }).toEqual(c.out);
  });

  it.each(gold.scrub_history)('scrubHistory %#', (c) => {
    expect(scrubHistory(c.in as unknown[])).toEqual(c.out);
  });

  it('featureOf: chỉ sales-01/sales-02', () => {
    expect(featureOf('sales-01')).toBe('sales-01');
    for (const bad of ['sales-99', 'marketing-01', '', null, ['sales-02'], 'Sales-02']) {
      expect(() => featureOf(bad)).toThrow(/danh sách nội bộ/);
    }
  });
});

describe('rag.answer (golden luồng gọi AI)', () => {
  it.each(Object.entries(gold.answer))('%s', async (_name, g) => {
    const c = g.case as unknown as Case;
    const calls: Call[] = [];
    const s = service(fakeAi(c, calls), c.hits, calls);
    const run = () => s.answer(c.q, c.h ?? null, c.feature ? { feature: c.feature } : {});
    if ('err' in g) await expect(run()).rejects.toThrow(new RangeError(g.err as string));
    else expect(await run()).toEqual(g.result);
    expect(calls).toEqual(g.calls);
  });
});

describe('retrieve: validate TRƯỚC embed/DB', () => {
  const bads = [
    null,
    '',
    'Public',
    'internal:',
    'chunks',
    "internal:kd' or '1'='1",
    'internal:KD',
    'internal:kd\n',
    `internal:${'a'.repeat(33)}`,
    1,
  ];
  it.each(bads)('collection %j → RangeError, 0 embed, 0 SQL', async (bad) => {
    const calls: Call[] = [];
    const sql: unknown[] = [];
    const s = service(fakeAi({}, calls), null, calls, { query: async (q: string) => sql.push(q) });
    await expect(s.retrieve('x', 8, { collection: bad as string })).rejects.toThrow(RangeError);
    await expect(s.retrieveByVector([1], 8, { collection: bad as string })).rejects.toThrow(
      RangeError,
    );
    expect(calls).toEqual([]);
    expect(sql).toEqual([]);
  });

  it.each(['abc', 'PGVECTOR', 'numpy'])(
    'RAG_VECTOR_BACKEND=%s → RangeError trước embed',
    async (v) => {
      const calls: Call[] = [];
      const s = service(fakeAi({}, calls), null, calls);
      s.env = { RAG_VECTOR_BACKEND: v };
      await expect(s.retrieve('x')).rejects.toThrow(RangeError);
      expect(calls).toEqual([]);
    },
  );

  it('feature lạ → RangeError trước mọi lời gọi (answer + retrieve)', async () => {
    const calls: Call[] = [];
    const s = service(fakeAi({ ans: 'ok' }, calls), [], calls);
    for (const bad of ['sales-99', '', 'Sales-02']) {
      await expect(s.answer('Shop giao hàng không?', [], { feature: bad })).rejects.toThrow(
        /danh sách nội bộ/,
      );
      await expect(s.retrieve('x', 8, { feature: bad })).rejects.toThrow(RangeError);
    }
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------ backend (DB giả)
type FRow = Row & { coll: string | null; emb: number[] };
const cos = (a: number[], b: number[]) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const n = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (n(a) * n(b));
};

/** Pool giả mô phỏng `order by embedding_v2 <=> q` (tính cosine trong test). */
function fakePool(rows: FRow[], o: { missing?: string; scan?: string } = {}) {
  const sql: [string, unknown[]][] = [];
  let ends = 0;
  const run = async (text: string, params: unknown[] = []) => {
    sql.push([text, params]);
    if (o.scan && text.includes('order by score desc')) {
      throw Object.assign(new Error('column "embedding_v2" does not exist'), { code: o.scan });
    }
    if (/^(begin|rollback|set local)/.test(text)) {
      if (o.missing && text.startsWith('set local')) {
        throw Object.assign(new Error('unrecognized configuration parameter'), { code: o.missing });
      }
      return { rows: [] };
    }
    const q = JSON.parse(params[0] as string) as number[];
    const internal = text.includes('chunks_internal');
    const pool = rows.filter((r) => (internal ? r.coll === params[1] : r.coll === null));
    const shape = (r: FRow) => ({ ...r, url: r.url, score: cos(r.emb, q) });
    if (text.includes("doc_id = 'catalog-products'")) {
      return { rows: pool.filter((r) => r.doc_id === 'catalog-products').map(shape) };
    }
    const got = pool.map(shape).sort((a, b) => b.score - a.score);
    if (text.includes('order by embedding_v2 <=>'))
      return { rows: got.slice(0, params.at(-1) as number) };
    return { rows: got };
  };
  return {
    sql,
    get released() {
      return ends;
    },
    query: run,
    connect: async () => ({ query: run, release: () => void ends++ }),
  };
}

const r = (
  doc: string,
  content: string,
  emb: number[],
  i = 0,
  title = 't',
  coll: string | null = null,
): FRow => ({
  title,
  url: `http://x/${doc}`,
  lang: coll ? null : 'vi',
  content,
  doc_id: doc,
  chunk_index: i,
  coll,
  emb,
});
const Q = [1.0, 0.2, 0.0];
const CORPUS = [
  r('ruou', 'Rượu sâm No.9 giá tốt', [1.0, 0.2, 0.0]),
  r('a', 'Saphraton 80 viên', [1.0, 0.25, 0.05]),
  r('a', 'Saphraton 20V', [0.9, 0.5, 0.1], 1),
  r('b', 'Savina tuýp', [0.7, 0.7, 0.2]),
  r('c', 'Lịch sử công ty', [0.2, 1.0, 0.3]),
  r('d', 'Trồng sâm', [0.1, 0.3, 1.0]),
  r('catalog-products', 'Danh mục sản phẩm', [0.3, 0.6, 0.8]),
  r('kd-1', 'Rượu — quy trình kho', [1.0, 0.2, 0.0], 0, 't', 'internal:kd'),
  r('kd-2', 'Quy trình B', [0.5, 0.5, 0.5], 0, 't', 'internal:kd'),
];
const svcOn = (p: ReturnType<typeof fakePool>) => {
  const s = new RagService(p as unknown as Pool, fakeAi({}, []));
  s.env = {};
  s.warn = () => {};
  return s;
};
const sig = (hits: Hit[]) => hits.map((h) => [h.doc_id, h.chunk_index ?? null]);

describe('retrieveByVector: float8 (quét chính xác) ≡ pgvector (HNSW)', () => {
  it.each([1, 2, 3, 8])('k=%i giống nhau, bỏ rượu, ghim catalog', async (k) => {
    const s = svcOn(fakePool(CORPUS));
    const f8 = await s.retrieveByVector(Q, k, { backend: 'float8' });
    const pg = await s.retrieveByVector(Q, k, { backend: 'pgvector' });
    expect(pg).toEqual(f8);
    const ids = f8.map((h) => h.doc_id);
    expect(ids).not.toContain('ruou');
    if (k <= 3) expect([ids.at(-1), ids.length]).toEqual(['catalog-products', k + 1]);
    const f8i = await s.retrieveByVector(Q, k, { backend: 'float8', ident: true });
    const pgi = await s.retrieveByVector(Q, k, { backend: 'pgvector', ident: true });
    expect(sig(pgi)).toEqual(sig(f8i));
    expect(f8i.every((h) => 'chunk_index' in h)).toBe(true);
    expect(f8.every((h) => !('chunk_index' in h))).toBe(true);
  });

  it('pgvector: SQL đúng hình (ef_search ≥ ứng viên, limit = ứng viên, chỉ chunks)', async () => {
    const p = fakePool(CORPUS);
    await svcOn(p).retrieveByVector(Q, 3, { backend: 'pgvector' });
    const main = p.sql.filter(([t]) => t.includes('order by embedding_v2 <=>'));
    expect(main.length).toBe(1);
    expect(main[0][0]).toContain('from chunks where');
    expect(main[0][0]).not.toContain('chunks_internal');
    expect(main[0][1].at(-1)).toBe(PGVECTOR_CANDIDATES);
    const ef = p.sql.find(([t]) => t.includes('ef_search'))?.[0] ?? '';
    expect(Number(ef.split('=').at(-1))).toBeGreaterThanOrEqual(PGVECTOR_CANDIDATES);
    expect(p.released).toBe(1);
  });

  it('mặc định float8: không HNSW, không limit', async () => {
    const p = fakePool(CORPUS);
    const s = svcOn(p);
    s.env = { RAG_VECTOR_BACKEND: '' };
    await s.retrieveByVector(Q, 3);
    expect(p.sql.some(([t]) => /hnsw|limit/.test(t))).toBe(false);
  });

  it.each(['42703', '42704', '42883'])(
    'pgvector thiếu (%s) → quét chính xác, [warn] 1 lần',
    async (code) => {
      const want = await svcOn(fakePool(CORPUS)).retrieveByVector(Q, 3, { backend: 'float8' });
      const p = fakePool(CORPUS, { missing: code });
      const s = svcOn(p);
      const warns: string[] = [];
      s.warn = (m) => warns.push(m);
      s.env = { RAG_VECTOR_BACKEND: 'pgvector' };
      expect(await s.retrieveByVector(Q, 3)).toEqual(want);
      expect(await s.retrieveByVector(Q, 3)).toEqual(want);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain(code);
      expect(p.sql.filter(([t]) => t === 'rollback').length).toBe(2);
    },
  );

  // Review đối kháng (MINOR): DB chưa áp docs/schema_ts.sql → lỗi DB thô lọt ra answer(). Giờ:
  // quét chính xác thiếu cột/extension → [] (answer → NO_DATA), [warn] 1 lần; lỗi khác vẫn ném.
  it.each(['42703', '42704', '42883'])(
    'quét chính xác thiếu embedding_v2 (%s) → [] + NO_DATA, [warn] 1 lần',
    async (code) => {
      const p = fakePool(CORPUS, { missing: code, scan: code });
      const s = svcOn(p);
      const warns: string[] = [];
      s.warn = (m) => warns.push(m);
      expect(await s.retrieveByVector(Q, 3, { backend: 'float8' })).toEqual([]);
      expect(await s.retrieveByVector(Q, 3, { backend: 'pgvector' })).toEqual([]);
      expect(await s.answer('Saphraton giá bao nhiêu?')).toEqual({ answer: NO_DATA, sources: [] });
      expect(warns.filter((w) => w.includes('embedding_v2')).length).toBe(2); // pgvector + quét
      expect(warns.filter((w) => w.includes('docs/schema_ts.sql + embed-store')).length).toBe(1);
    },
  );

  it('quét chính xác lỗi DB khác → vẫn ném (không nuốt thành NO_DATA)', async () => {
    const s = svcOn(fakePool(CORPUS, { scan: '57014' }));
    await expect(s.retrieveByVector(Q, 3)).rejects.toMatchObject({ code: '57014' });
  });

  it('pgvector: lọc rượu ăn hết ứng viên → chạy lại quét chính xác, vẫn đủ k', async () => {
    const flood = Array.from({ length: 70 }, (_, i) =>
      r(`r${i}`, `Rượu sâm số ${i}`, [1.0, 0.2, 0.0001 * i]),
    );
    const p = fakePool([...flood, ...CORPUS]);
    const s = svcOn(p);
    const f8 = await s.retrieveByVector(Q, 4, { backend: 'float8' });
    const pg = await s.retrieveByVector(Q, 4, { backend: 'pgvector' });
    expect(pg.length).toBe(4);
    expect(pg).toEqual(f8);
    expect(p.sql.some(([t]) => t.includes('order by embedding_v2 <=>'))).toBe(true);
  });

  it('pgvector corpus nhỏ (< limit ứng viên) → không chạy lại quét chính xác', async () => {
    const p = fakePool(CORPUS);
    await svcOn(p).retrieveByVector(Q, 8, { backend: 'pgvector' });
    expect(p.sql.some(([t]) => t.includes('order by score desc'))).toBe(false);
  });

  it.each(['float8', 'pgvector'])(
    'nội bộ (%s): chỉ chunks_internal + tham số, không lọc rượu',
    async (b) => {
      const p = fakePool(CORPUS);
      const hits = await svcOn(p).retrieveByVector(Q, 1, { collection: 'internal:kd', backend: b });
      expect(hits.map((h) => h.doc_id)).toEqual(['kd-1']);
      const sel = p.sql.filter(([t]) => t.startsWith('select'));
      expect(sel.every(([t]) => t.includes('chunks_internal'))).toBe(true);
      expect(sel.every(([, ps]) => ps.includes('internal:kd'))).toBe(true);
    },
  );

  it('public: row rượu bị loại kể cả điểm cao nhất (content hoặc title); catalog rượu không ghim', async () => {
    const p = fakePool([
      r('ruou', 'Rượu sâm No.9 giá tốt', [1, 0, 0]),
      r('ruou-title', 'Chai 500ml', [1, 0, 0], 0, 'Ngoc Linh Ginseng Wine No. 7'),
      r('ok', 'Saphraton', [0.9, 0.3, 0]),
      r('catalog-products', '- Rượu Sâm No.9 — Giá: Liên hệ', [0.5, 0.5, 0]),
    ]);
    expect((await svcOn(p).retrieveByVector([1, 0, 0])).map((h) => h.doc_id)).toEqual(['ok']);
  });
});

// ------------------------------------------------------------ hạn chót 30 giây
describe('hạn chót 30 giây (v13.7)', () => {
  const HIT: Hit[] = [
    {
      title: 'Saphraton',
      url: 'https://x/s',
      lang: 'vi',
      content: 'Giá 1',
      score: 0.9,
      doc_id: 'd',
    },
  ];

  it('ngân sách truyền xuống từng lời gọi; bước sau không bắt đầu khi hết hạn', async () => {
    let t = 1_000_000;
    const seen: [string, number | undefined][] = [];
    const ai: Ai = {
      chat: async (_a, _m, o) => {
        seen.push(['chat', o.timeoutMs]);
        t += 5000;
        return { text: 'câu rewrite', model: 'm', provider: 'ollama', tokensIn: 0, tokensOut: 0 };
      },
      embed: async (_a, _i, o) => {
        seen.push(['embed', o.timeoutMs]);
        t += 20000; // embed chậm
        return { embeddings: [[1]], model: 'm', provider: 'ollama', tokensIn: 0 };
      },
    };
    const s = service(ai, HIT, []);
    s.clock = () => t;
    const hist = [
      { role: 'user', content: 'giá?' },
      { role: 'assistant', content: '1' },
    ];
    const e = await s.answer('còn loại khác?', hist, { deadline: t + 25000 }).catch((x) => x);
    expect(e).toBeInstanceOf(DeadlineExceeded);
    expect(e.stage).toBe('chat');
    expect(seen).toEqual([
      ['chat', 25000],
      ['embed', 20000],
    ]);
  });

  it('hạn từ DEADLINE (AsyncLocalStorage) + client timeout → DeadlineExceeded(embed)', async () => {
    const t = 1_000_000;
    const ai: Ai = {
      ...fakeAi({}, []),
      embed: async () => {
        const cause = Object.assign(new Error('read timeout'), { name: 'TimeoutError' });
        throw new GatewayError('LLM provider lỗi', { cause });
      },
    };
    const s = service(ai, HIT, []);
    s.clock = () => t;
    const e = await DEADLINE.run(t + 25000, () => s.answer('Saphraton giá bao nhiêu?')).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(DeadlineExceeded);
    expect(e.stage).toBe('embed');
    // Không có hạn chót → hành vi cũ (GatewayError lan ra).
    await expect(s.answer('Saphraton giá bao nhiêu?')).rejects.toThrow(GatewayError);
    await expect(s.answer('Saphraton giá bao nhiêu?')).rejects.not.toThrow(DeadlineExceeded);
  });

  it('bước DB: còn < 1 giây → DeadlineExceeded(db), 0 truy vấn; DB chậm → cắt theo hạn', async () => {
    const t = 1_000_000;
    const sql: string[] = [];
    const slow = {
      query: (q: string) => {
        sql.push(q);
        return new Promise(() => {});
      },
    };
    const s = new RagService(slow as unknown as Pool, fakeAi({}, []));
    s.env = {};
    s.clock = () => t;
    await expect(s.retrieveByVector([1], 8, { deadline: t + 500 })).rejects.toMatchObject({
      stage: 'db',
    });
    expect(sql).toEqual([]);
    await expect(s.retrieveByVector([1], 8, { deadline: t + 1200 })).rejects.toMatchObject({
      stage: 'db',
    });
    expect(sql.length).toBe(1);
  });
});

// ------------------------------------------------------------ gateway THẬT (nhà cung cấp giả)
describe('qua AI Gateway thật: PII che, nút tắt theo tính năng (nhà cung cấp giả)', () => {
  const HITS: Hit[] = [
    {
      title: 'Shop',
      url: 'https://example.test/p',
      lang: 'vi',
      content: 'Shop có giao hàng toàn quốc.',
      score: 1,
      doc_id: 'p',
    },
  ];
  const HIST = [
    { role: 'user', content: 'Tên em là Trần Thị Thử, gửi cho chị Lan Giả ở hẻm 34/5 Đường Giả' },
    { role: 'assistant', content: 'Dạ shop ghi nhận ạ' },
  ];
  let bodies: { url: string; body: string }[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    bodies.push({ url: String(url), body: String(init.body) });
    const json = String(url).endsWith('/api/chat')
      ? { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 }
      : { embeddings: [Array(1024).fill(0.5)], prompt_eval_count: 1 };
    return new Response(JSON.stringify(json), { status: 200 });
  }) as unknown as typeof fetch;
  const usage: unknown[][] = [];
  const spendPool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('insert')) usage.push(params);
      return { rows: [{ spend: 0 }] };
    },
  };
  const gw = (env: Record<string, string> = {}) =>
    createGateway(spendPool as never, {
      env: { OLLAMA_URL: 'http://127.0.0.1:9', ...env },
      fetch: fetchFake,
      warn: () => {},
    });
  beforeEach(() => {
    bodies = [];
    usage.length = 0;
    settings.forceMode = 'van_hanh';
  });
  afterEach(() => {
    settings.forceMode = null;
  });

  it('tên/địa chỉ (câu hỏi + history) không tới nhà cung cấp; đủ rewrite + embed + chat', async () => {
    const s = service(gw(), HITS, []);
    const res = await s.answer(
      'Anh Nguyễn Văn Mẫu hỏi Saphraton giá bao nhiêu, giao đến 425 Lê Giả Định nhé',
      HIST,
    );
    expect(res.answer).toBe('ok');
    expect(bodies.map((b) => b.url.split('/').at(-1))).toEqual(['chat', 'embed', 'chat']);
    const out = bodies.map((b) => b.body).join('\n');
    for (const leak of [
      'Trần Thị Thử',
      'Thị Thử',
      'Lan Giả',
      '34/5',
      'Nguyễn Văn Mẫu',
      '425 Lê Giả Định',
      'Lê Giả',
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('Saphraton');
    expect(usage.map((u) => u.at(-1))).toEqual(['sales-01', 'sales-01', 'sales-01']);
  });

  it.each([
    ['sức khỏe', 'Mẹ tôi bi huyet ap cao', 'health'],
    ['sức khỏe vô hình', 'bị\u200Bgan', 'health'],
    ['rượu', 'Rượu sâm giá bao nhiêu?', 'alcohol'],
    ['PII sót', 'ship ve 123 nguyen trai q1 nhe', 'pii'],
  ])('%s → chuyển người, 0 lời gọi nhà cung cấp', async (_n, q, handoff) => {
    const s = service(gw(), HITS, []);
    expect(await s.answer(q)).toEqual({ answer: NO_DATA, sources: [], handoff });
    expect(bodies).toEqual([]);
  });

  it('sales-02 tắt khẩn → GatewayBlocked, 0 lời gọi; sales-01 không ảnh hưởng', async () => {
    const s = service(gw({ LLM_KILL_FEATURES: 'sales-02' }), HITS, []);
    await expect(s.answer('Shop giao hàng không?', HIST, { feature: 'sales-02' })).rejects.toThrow(
      GatewayBlocked,
    );
    expect(bodies).toEqual([]);
    await s.answer('Shop giao hàng không?', HIST);
    expect(usage.map((u) => u.at(-1))).toEqual(['sales-01', 'sales-01', 'sales-01']);
  });

  it('tính năng TẮT ở sổ triển khai → GatewayBlocked trước khi gọi AI', async () => {
    settings.forceMode = 'tat';
    const s = service(gw(), HITS, []);
    await expect(s.answer('Shop giao hàng không?')).rejects.toThrow(GatewayBlocked);
    expect(bodies).toEqual([]);
  });
});
