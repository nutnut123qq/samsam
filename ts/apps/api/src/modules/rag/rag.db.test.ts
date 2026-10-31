import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, type Service, servicePool } from '@samsam/core/db';
import { dataPath, repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { setDirectorsDir } from '@samsam/core/security/auth';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import {
  adminQuery,
  createDbFromTemplate,
  dbUrl,
  dropDb,
  testDbName,
} from '@samsam/core/testing/db';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfill, chunkText, SourceError, sync } from './embed-store.js';
import { ingestDoc } from './kb-internal.js';
import { embedStoreMain, kbInternalMain } from './rag.command.js';
import { type Ai, RagService } from './rag.service.js';

// DB THẬT (container test, DB riêng `testDbName('rag')` tạo từ mẫu, xóa khi xong — KHÔNG BAO GIỜ DB
// `samsam`). Dịch tests/test_embed_store.py (incremental/delete-trắng/0 ghi), test_kb_internal.py
// (CLI nạp/nạp lại/sửa, CHECK người duyệt), test_kb_acl_db.py (retrieve mặc định không trả nội
// bộ/rượu), test_rag_backend.py (2 backend trên Postgres thật), test_v14_p2 (cổng người duyệt chế
// độ thực), test_v15_p12 (cổng loader TẮT → không nạp). Embedding GIẢ 1024 chiều — không gọi AI.

const DB = testDbName('rag');
const DIM = 1024;
const pad = (v: number[]) => [...v, ...Array(DIM - v.length).fill(0)];

class FakeEmbed implements Ai {
  calls = 0;
  texts = 0;
  constructor(
    private readonly failAt: number | null = null,
    private readonly vec: number[] = pad([1, 0.5, 0.25]),
  ) {}
  async embed(agent: string, input: string | string[], o: { feature: string }) {
    const batch = Array.isArray(input) ? input : [input];
    expect(['ingest', 'chatbot']).toContain(agent);
    if (agent === 'ingest') expect(o.feature).toBe('data_platform-03');
    this.calls++;
    if (this.failAt === this.calls) throw new Error('embed down');
    this.texts += batch.length;
    return {
      embeddings: batch.map(() => this.vec),
      model: 'bge-m3',
      provider: 'ollama' as const,
      tokensIn: 0,
    };
  }
  async chat(): Promise<never> {
    throw new Error('không gọi chat');
  }
}

const LONG = 'Sâm Ngọc Linh được trồng dưới tán rừng ở Trà Linh, Nam Trà My. '.repeat(14);
const PRODUCTS = [
  {
    id: 'p-sap',
    name: 'Saphraton',
    price_vnd: 1000000,
    description: 'Hộp 80 viên.',
    url: 'https://x.vn/product/saphraton/',
  },
  {
    id: 'p-sav',
    name: 'Savina',
    price_vnd: 128000,
    description: 'Tuýp 12 viên ngậm.',
    url: 'https://x.vn/product/savina/',
  },
  {
    id: 'p-ruou',
    name: 'Rượu Sâm Ngọc Linh No. 9',
    price_vnd: null,
    description: 'Chai 500ml.',
    url: 'https://x.vn/product/ruou-no-9/',
  },
];
const ARTICLES = [
  { id: 'a-1', title: 'Vùng trồng sâm', body: LONG, url: 'https://x.vn/a-1/' },
  // Bài dài có 1 đoạn nhắc rượu ở giữa: chỉ chunk đó bị bỏ.
  {
    id: 'a-2',
    title: 'Showroom Đà Nẵng',
    body: `${LONG} Khách được thử sâm ngâm rượu tại quầy. ${LONG}`,
    url: 'https://x.vn/a-2/',
  },
];
const ABOUT = [
  { id: 'ab-1', title: 'Giới thiệu', body: 'Công ty TNHH Sâm Sâm.', url: 'https://x.vn/about/' },
];
const NEWS = [
  {
    id: 'n-1',
    title: 'Khai trương',
    body: 'Showroom 425 Phan Bội Châu.',
    url: 'https://x.vn/n-1/',
  },
];

const writeRecs = (d: string, fn: string, recs: unknown[]) =>
  writeFileSync(join(d, fn), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('rag (DB thật)', () => {
  let dsn = '';
  let pool: Pool;
  let dir = '';
  const quiet = () => {};

  beforeAll(async () => {
    dsn = await createDbFromTemplate(DB);
    pool = createPool(dsn);
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(DB);
  });
  beforeEach(async () => {
    await pool.query('delete from chunks; delete from chunks_internal');
    dir = mkdtempSync(join(tmpdir(), 'rag-db-'));
    writeRecs(dir, 'products.jsonl', PRODUCTS);
    writeRecs(dir, 'articles.jsonl', ARTICLES);
    writeRecs(dir, 'about.jsonl', ABOUT);
    writeRecs(dir, 'news.jsonl', NEWS);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    settings.forceMode = null;
  });

  // `sync` = đường CUTOVER (delete+insert như Python); mặc định CLI là `backfill` (song song).
  const run = (ai: FakeEmbed, batch?: number) =>
    sync(pool, ai, { dataDir: dir, model: 'bge-m3', batch, log: quiet });
  const rows = async () =>
    new Map(
      (
        await pool.query(
          'select doc_id, chunk_index, id, ingested_at, doc_version, source, doc_sha256, content, title' +
            ' from chunks',
        )
      ).rows.map((r) => [`${r.doc_id}#${r.chunk_index}`, r]),
    );
  const docs = async () =>
    new Set((await pool.query('select distinct doc_id from chunks')).rows.map((r) => r.doc_id));

  // ---------------------------------------------------------------- embed-store
  it('lượt 2 không đổi = 0 embed, id + ingested_at y nguyên; vector ở embedding_v2', async () => {
    const fe = new FakeEmbed();
    const st1 = await run(fe);
    expect(fe.calls).toBeGreaterThanOrEqual(1);
    expect(st1.new).toBe((await docs()).size);
    const before = await rows();
    const fe2 = new FakeEmbed();
    const st2 = await run(fe2);
    expect([fe2.calls, st2.new, st2.changed, st2.deleted, st2.embed_calls]).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(await rows()).toEqual(before);
    const v = (
      await pool.query(
        'select count(*)::int as n, count(embedding)::int as f8, count(embedding_v2)::int as v2,' +
          ' min(vector_dims(embedding_v2)) as dim from chunks',
      )
    ).rows[0];
    expect(v).toEqual({ n: v.n, f8: 0, v2: v.n, dim: DIM });
  });

  it('sửa 1 record → chỉ embed lại doc đó, version 2', async () => {
    await run(new FakeEmbed());
    const before = await rows();
    writeRecs(dir, 'about.jsonl', [{ ...ABOUT[0], body: 'Công ty TNHH Sâm Sâm, thành lập 2015.' }]);
    const fe = new FakeEmbed();
    const st = await run(fe);
    const after = await rows();
    const about = [...after.entries()].filter(([k]) => k.startsWith('ab-1#'));
    expect([st.changed, st.new, fe.texts]).toEqual([1, 0, about.length]);
    expect(new Set(about.map(([, r]) => r.doc_version))).toEqual(new Set([2]));
    for (const [k, r] of after) if (!k.startsWith('ab-1#')) expect(r).toEqual(before.get(k));
  });

  it('record bị gỡ → doc bị xóa', async () => {
    await run(new FakeEmbed());
    expect((await docs()).has('n-1')).toBe(true);
    writeRecs(dir, 'news.jsonl', [{ ...NEWS[0], id: 'n-2' }]);
    const st = await run(new FakeEmbed());
    const d = await docs();
    expect([d.has('n-1'), d.has('n-2'), st.deleted]).toEqual([false, true, 1]);
  });

  it.each(['missing', 'zero', 'blank', 'doc_only'])(
    'products.jsonl %s → KHÔNG xóa chunk (delete-trắng)',
    async (variant) => {
      await run(new FakeEmbed());
      const before = await rows();
      const p = join(dir, 'products.jsonl');
      if (variant === 'missing') unlinkSync(p);
      else
        writeFileSync(
          p,
          { zero: '', blank: '\n   \n\r\n', doc_only: '{"_doc": "comment"}\n' }[variant] as string,
        );
      const fe = new FakeEmbed();
      const st = await run(fe);
      expect([st.deleted, fe.calls]).toEqual([0, 0]);
      expect(st.trusted).not.toContain('products.jsonl');
      expect(st.trusted).not.toContain('catalog');
      expect(await rows()).toEqual(before);
      const d = await docs();
      for (const id of ['p-sap', 'p-sav', 'catalog-products']) expect(d.has(id)).toBe(true);
    },
  );

  it('JSON hỏng → SourceError TRƯỚC embed và ghi', async () => {
    await run(new FakeEmbed());
    const before = await rows();
    writeRecs(dir, 'about.jsonl', [{ ...ABOUT[0], body: 'đổi' }]);
    appendFileSync(join(dir, 'news.jsonl'), '{"id": "n-9", "title": "hong\n');
    const fe = new FakeEmbed();
    await expect(run(fe)).rejects.toThrow(SourceError);
    expect(fe.calls).toBe(0);
    expect(await rows()).toEqual(before);
  });

  it('embed lỗi ở batch 2 → 0 ghi', async () => {
    await run(new FakeEmbed());
    const before = await rows();
    writeRecs(
      dir,
      'articles.jsonl',
      ARTICLES.map((r) => ({ ...r, body: `${r.body} Cập nhật.` })),
    );
    writeRecs(
      dir,
      'about.jsonl',
      ABOUT.map((r) => ({ ...r, body: `${r.body} Cập nhật.` })),
    );
    const fe = new FakeEmbed(2);
    await expect(run(fe, 2)).rejects.toThrow('embed down');
    expect(fe.calls).toBe(2);
    expect(await rows()).toEqual(before);
  });

  it('lọc rượu: record rượu bỏ, chunk rượu bỏ, catalog không có SKU rượu', async () => {
    const st = await run(new FakeEmbed());
    const all = await rows();
    const d = await docs();
    expect(d.has('p-ruou')).toBe(false);
    expect(st.alcohol_records['products.jsonl']).toBe(1);
    expect(st.alcohol_chunks['articles.jsonl']).toBeGreaterThanOrEqual(1);
    expect(d.has('a-2')).toBe(true);
    for (const r of all.values()) expect(isAlcohol(r.content) || isAlcohol(r.title)).toBe(false);
    const cat = [...all.values()]
      .filter((r) => r.doc_id === 'catalog-products')
      .map((r) => r.content)
      .join(' ');
    expect(cat).toContain('Saphraton');
    expect(cat.toLowerCase()).not.toContain('rượu');
  });

  it('legacy source null nhắc rượu: chỉ xóa khi MỌI nguồn tin cậy', async () => {
    await pool.query(
      "insert into chunks (doc_id, chunk_index, source_url, title, lang, content) values ('wc-legacy-ruou', 0, 'u', 'Rượu No.7', 'vi', 'Rượu sâm No.7')",
    );
    unlinkSync(join(dir, 'products.jsonl'));
    await run(new FakeEmbed()); // 1 nguồn không tin cậy → legacy giữ
    expect((await docs()).has('wc-legacy-ruou')).toBe(true);
    writeRecs(dir, 'products.jsonl', PRODUCTS);
    await run(new FakeEmbed());
    expect((await docs()).has('wc-legacy-ruou')).toBe(false);
    expect(
      (await pool.query('select count(*)::int as n from chunks where source is null')).rows[0].n,
    ).toBe(0);
  });

  it('row legacy trùng doc_id → embed lại kèm hash, version 2', async () => {
    await pool.query(
      "insert into chunks (doc_id, chunk_index, source_url, title, lang, content) values ('ab-1', 0, 'u', 't', 'vi', 'cũ')",
    );
    await run(new FakeEmbed());
    const r = (
      await pool.query(
        "select source, doc_sha256, doc_version, content from chunks where doc_id = 'ab-1'",
      )
    ).rows;
    expect(r.length).toBe(1);
    expect([r[0].source, Boolean(r[0].doc_sha256), r[0].doc_version]).toEqual([
      'about.jsonl',
      true,
      2,
    ]);
    expect(r[0].content).toContain('Sâm Sâm');
  });

  it('row source "manual" (nạp tay) không bị đụng', async () => {
    await pool.query(
      "insert into chunks (doc_id, chunk_index, source_url, title, lang, content, source, doc_sha256) values ('m-1', 0, 'u', 't', 'vi', 'nạp tay', 'manual', 'x')",
    );
    await run(new FakeEmbed());
    await run(new FakeEmbed());
    expect((await docs()).has('m-1')).toBe(true);
  });

  it('lệnh embed-store: cổng loader TẮT → exit 2, 0 embed; vận hành → exit 0 + [done]', async () => {
    const env = { DATABASE_URL: dsn, NODE_ENV: 'test' };
    const fe = new FakeEmbed();
    const out: string[] = [];
    settings.forceMode = 'tat';
    expect(await embedStoreMain({ env, dataDir: dir, ai: () => fe, log: (s) => out.push(s) })).toBe(
      2,
    );
    expect(out.some((l) => l.startsWith('[rollout]'))).toBe(true);
    expect(fe.calls).toBe(0);
    expect((await docs()).size).toBe(0);
    settings.forceMode = 'van_hanh';
    out.length = 0;
    const cut = { cutover: true };
    expect(
      await embedStoreMain({ env, dataDir: dir, ai: () => fe, log: (s) => out.push(s) }, cut),
    ).toBe(0);
    expect(out.at(-1)).toMatch(/^\[done\] mới \d+ \/ đổi 0 \/ giữ 0 \/ xóa 0 doc/);
    // JSON hỏng → exit 1 "[err] SourceError: … — không ghi DB" (cả 2 chế độ)
    appendFileSync(join(dir, 'news.jsonl'), '{bad\n');
    for (const o of [cut, {}]) {
      out.length = 0;
      expect(
        await embedStoreMain({ env, dataDir: dir, ai: () => fe, log: (s) => out.push(s) }, o),
      ).toBe(1);
      expect(out.at(-1)).toMatch(
        /^\[err\] SourceError: news\.jsonl:2 JSON hỏng .* — không ghi DB$/,
      );
    }
  });

  // ---------------------------------------------------------------- song song với Python
  // Review đối kháng (MAJOR): writer TS delete+insert để `embedding` null → `_rank_float8` Python
  // (numpy trên row None) crash mọi câu chatbot; hash model khác → hai bên embed lại nhau mãi.
  // Giờ mặc định chỉ điền embedding_v2 trên row Python khớp; delete+insert chỉ với --cutover.
  const PY_EMB = 'array_fill(0.5::float8, array[1536])';
  /** Giả lập bản Python: row có `embedding` 1536 chiều, hash Python, chưa có embedding_v2. */
  const asPython = async (table: 'chunks' | 'chunks_internal') =>
    pool.query(
      `update ${table} set embedding = ${PY_EMB}, doc_sha256 = 'py:' || doc_id, embedding_v2 = null`,
    );
  const snap = async (table: 'chunks' | 'chunks_internal') =>
    (
      await pool.query(
        `select id, doc_id, chunk_index, content, doc_sha256, doc_version, ingested_at,` +
          ` md5(embedding::text) as emb, ${table === 'chunks' ? 'source' : 'approved_by'} as x` +
          ` from ${table} order by doc_id, chunk_index`,
      )
    ).rows;
  const v2count = async (table: 'chunks' | 'chunks_internal') =>
    (
      await pool.query(
        `select count(*)::int as n, count(embedding)::int as f8, count(embedding_v2)::int as v2 from ${table}`,
      )
    ).rows[0];

  it('embed-store mặc định (song song): giữ row Python, chỉ điền embedding_v2; chạy lại 0 embed', async () => {
    settings.forceMode = 'van_hanh';
    await run(new FakeEmbed());
    await asPython('chunks');
    const before = await snap('chunks');
    const env = { DATABASE_URL: dsn, NODE_ENV: 'test' };
    const out: string[] = [];
    const fe = new FakeEmbed();
    const d = { env, dataDir: dir, ai: () => fe, log: (s: string) => out.push(s) };
    expect(await embedStoreMain(d)).toBe(0);
    expect(fe.texts).toBe(before.length);
    expect(await snap('chunks')).toEqual(before); // embedding/doc_sha256/version/id/ingested_at y nguyên
    const n = before.length;
    expect(await v2count('chunks')).toEqual({ n, f8: n, v2: n });
    expect(out.at(-1)).toMatch(/^\[done\] song song: điền embedding_v2 \d+ doc \(\d+ chunk\)/);
    expect(out.at(-1)).toContain(`(embedding_v2: ${n}/${n})`);
    // chạy lại = 0 embed
    const fe2 = new FakeEmbed();
    expect(await embedStoreMain({ ...d, ai: () => fe2 })).toBe(0);
    expect(fe2.calls).toBe(0);
    // jsonl đổi/thêm mà Python chưa chạy → [blocked] exit 2, không ghi, không embed
    writeRecs(dir, 'about.jsonl', [{ ...ABOUT[0], body: 'Công ty TNHH Sâm Sâm, thành lập 2015.' }]);
    writeRecs(dir, 'news.jsonl', [...NEWS, { ...NEWS[0], id: 'n-2' }]);
    const fe3 = new FakeEmbed();
    out.length = 0;
    expect(await embedStoreMain({ ...d, ai: () => fe3 })).toBe(2);
    expect(fe3.calls).toBe(0);
    expect(out.at(-1)).toMatch(
      /^\[blocked\] 2 doc mới\/đổi so với bản Python \((ab-1, n-2|n-2, ab-1)\)/,
    );
    expect(out.at(-1)).toContain('python -m ingest.embed_store');
    expect(out.at(-1)).toContain('--cutover');
    expect(await snap('chunks')).toEqual(before);
    expect(await v2count('chunks')).toEqual({ n, f8: n, v2: n });
  });

  it('song song: Python nạp lại giữa lúc embed → không gắn vector cho nội dung đã đổi', async () => {
    await run(new FakeEmbed());
    await asPython('chunks');
    const n = (await v2count('chunks')).n;
    class Racing extends FakeEmbed {
      override async embed(agent: string, input: string | string[], o: { feature: string }) {
        await pool.query(
          "update chunks set content = content || ' (Python nạp lại)' where doc_id = 'ab-1'",
        );
        return super.embed(agent, input, o);
      }
    }
    const st = await backfill(pool, new Racing(), { dataDir: dir, model: 'bge-m3', log: quiet });
    expect([st.embedded_chunks, st.updated, st.blocked]).toEqual([n, n - 1, []]);
    const ab = (
      await pool.query("select count(embedding_v2)::int as v2 from chunks where doc_id = 'ab-1'")
    ).rows[0];
    expect(ab.v2).toBe(0);
  });

  it('cutover: row cùng hash nhưng thiếu embedding_v2 → embed lại (không "giữ")', async () => {
    await run(new FakeEmbed());
    await pool.query("update chunks set embedding_v2 = null where doc_id = 'ab-1'");
    const fe = new FakeEmbed();
    const st = await run(fe);
    const nAb = (await pool.query("select count(*)::int as n from chunks where doc_id = 'ab-1'"))
      .rows[0].n;
    expect([st.changed, fe.texts]).toEqual([1, nAb]);
    const v = await v2count('chunks');
    expect(v.v2).toBe(v.n);
  });

  it('lệnh embed-store: dev thiếu cả LOADER_DATABASE_URL lẫn DATABASE_URL → exit 2 (như Python)', async () => {
    // Python: bind_service dev = None, rồi loader_gate không kết nối được DB → "[rollout] … — không
    // nạp", exit 2 (chạy thật ingest.embed_store.main() với psycopg.connect bị chặn) — review đối
    // kháng nói exit 1 là sai.
    const out: string[] = [];
    const code = await embedStoreMain({
      env: { NODE_ENV: 'test' },
      dataDir: dir,
      ai: () => new FakeEmbed(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('DATABASE_URL');
  });

  it('lệnh embed-store: chế độ thực, thiếu LOADER_DATABASE_URL → exit 2', async () => {
    const out: string[] = [];
    const code = await embedStoreMain({
      env: { DATABASE_URL: dsn, NODE_ENV: 'test', APPROVAL_ENFORCE: '1' },
      dataDir: dir,
      ai: () => new FakeEmbed(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('LOADER_DATABASE_URL');
  });

  // ---------------------------------------------------------------- kb-internal
  const SAMPLE = repoPath('tests', 'fixtures', 'kb_noi_bo_MAU.md');
  const BY = 'MAU-test';

  it('CLI nạp → nạp lại (0 embed) → sửa (version 2); chỉ chunks_internal, không in nội dung', async () => {
    settings.forceMode = 'van_hanh';
    const f = join(dir, 'quy_trinh_MAU.md');
    copyFileSync(SAMPLE, f);
    const fe = new FakeEmbed();
    const out: string[] = [];
    const d = {
      env: { DATABASE_URL: dsn, NODE_ENV: 'test' },
      ai: () => fe,
      log: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
    };
    const o = { file: f, collection: 'internal:kd', approvedBy: BY, cutover: true };
    expect(await kbInternalMain(o, d)).toBe(0);
    const n1 = chunkText(readFileSync(f, 'utf8')).length;
    expect(fe.texts).toBe(n1);
    const r = (
      await pool.query(
        'select collection, doc_id, doc_version, approved_by, source_ref from chunks_internal',
      )
    ).rows;
    expect(r.length).toBe(n1);
    expect(new Set(r.map((x) => JSON.stringify(x)))).toEqual(
      new Set([
        JSON.stringify({
          collection: 'internal:kd',
          doc_id: 'quy-trinh-mau',
          doc_version: 1,
          approved_by: BY,
          source_ref: 'quy_trinh_MAU.md',
        }),
      ]),
    );
    expect((await pool.query('select count(*)::int as n from chunks')).rows[0].n).toBe(0);
    expect(out.join('\n')).not.toContain('Xử lý đơn đại lý');

    const fe2 = new FakeEmbed();
    out.length = 0;
    expect(await kbInternalMain(o, { ...d, ai: () => fe2 })).toBe(0);
    expect(fe2.calls).toBe(0);
    expect(out.at(-1)).toContain('không đổi');

    writeFileSync(f, readFileSync(f, 'utf8') + '\n\nBổ sung MẪU. '.repeat(120));
    const fe3 = new FakeEmbed();
    expect(await kbInternalMain(o, { ...d, ai: () => fe3 })).toBe(0);
    const n2 = chunkText(readFileSync(f, 'utf8')).length;
    expect(n2).toBeGreaterThan(n1);
    expect(fe3.texts).toBe(n2);
    expect(
      (
        await pool.query(
          "select distinct doc_version from chunks_internal where doc_id = 'quy-trinh-mau'",
        )
      ).rows,
    ).toEqual([{ doc_version: 2 }]);
    expect((await pool.query('select count(*)::int as n from chunks_internal')).rows[0].n).toBe(n2);
    expect((await pool.query('select count(*)::int as n from chunks')).rows[0].n).toBe(0);
  });

  it('kb-internal mặc định (song song): chưa có bản Python / lệch → [blocked] exit 2; khớp → chỉ điền embedding_v2', async () => {
    settings.forceMode = 'van_hanh';
    const f = join(dir, 'quy_trinh_MAU.md');
    copyFileSync(SAMPLE, f);
    const out: string[] = [];
    const mk = (fe: FakeEmbed) => ({
      env: { DATABASE_URL: dsn, NODE_ENV: 'test' },
      ai: () => fe,
      log: (s: string) => out.push(s),
      err: (s: string) => out.push(s),
    });
    const o = { file: f, collection: 'internal:kd', approvedBy: BY };
    const fe0 = new FakeEmbed();
    expect(await kbInternalMain(o, mk(fe0))).toBe(2);
    expect(out.at(-1)).toBe(
      '[blocked] internal:kd / quy-trinh-mau: chưa có bản do Python nạp — không ghi: nạp bằng' +
        ' python -m ingest.kb_internal trước; --cutover CHỈ khi đã tắt RAG Python' +
        ' (docs/rewrite/KE_HOACH.md mục 5)',
    );
    expect([fe0.calls, (await v2count('chunks_internal')).n]).toEqual([0, 0]);
    // bản Python: nạp (cutover) rồi đổi thành row Python (embedding 1536, hash Python, chưa v2)
    expect(await kbInternalMain({ ...o, cutover: true }, mk(new FakeEmbed()))).toBe(0);
    await asPython('chunks_internal');
    const before = await snap('chunks_internal');
    const n = before.length;
    const fe = new FakeEmbed();
    expect(await kbInternalMain(o, mk(fe))).toBe(0);
    expect(fe.texts).toBe(n);
    expect(out.at(-1)).toBe(
      `[kb-internal] internal:kd / quy-trinh-mau: điền embedding_v2 (bản Python giữ nguyên) — ${n} chunk, version 1`,
    );
    expect(await snap('chunks_internal')).toEqual(before);
    expect(await v2count('chunks_internal')).toEqual({ n, f8: n, v2: n });
    const fe2 = new FakeEmbed();
    expect(await kbInternalMain(o, mk(fe2))).toBe(0);
    expect([fe2.calls, out.at(-1)]).toEqual([
      0,
      `[kb-internal] internal:kd / quy-trinh-mau: không đổi (0 embed) — ${n} chunk, version 1`,
    ]);
    // file sửa mà Python chưa nạp lại → lệch → exit 2, 0 embed, 0 ghi
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n\nBổ sung MẪU.`);
    const fe3 = new FakeEmbed();
    expect(await kbInternalMain(o, mk(fe3))).toBe(2);
    expect(out.at(-1)).toMatch(
      /^\[blocked\] internal:kd \/ quy-trinh-mau: nội dung khác bản Python/,
    );
    expect(fe3.calls).toBe(0);
    expect(await snap('chunks_internal')).toEqual(before);
  });

  it('kb-internal cutover: cùng hash nhưng thiếu embedding_v2 → embed lại', async () => {
    const a = {
      collection: 'internal:kd',
      docId: 'v2-null',
      title: 't',
      sourceRef: 't.md',
      text: 'MẪU nội bộ. '.repeat(100),
      approvedBy: BY,
      model: 'bge-m3',
      cutover: true,
    };
    expect((await ingestDoc(pool, new FakeEmbed(), a, quiet)).status).toBe('loaded');
    await pool.query('update chunks_internal set embedding_v2 = null');
    const fe = new FakeEmbed();
    const r = await ingestDoc(pool, fe, a, quiet);
    expect([r.status, r.version, fe.texts]).toEqual(['loaded', 2, r.chunks]);
    const v = await v2count('chunks_internal');
    expect(v.v2).toBe(v.n);
  });

  it('CHECK DB chặn người duyệt trống kể cả bỏ qua CLI', async () => {
    const e = await ingestDoc(
      pool,
      new FakeEmbed(),
      {
        collection: 'internal:kd',
        docId: 'x',
        title: 't',
        sourceRef: 'x.md',
        text: 'MẪU',
        approvedBy: '  ',
        model: 'bge-m3',
        cutover: true,
      },
      quiet,
    ).catch((x) => x);
    expect(e.code).toBe('23514');
    expect((await pool.query('select count(*)::int as n from chunks_internal')).rows[0].n).toBe(0);
  });

  it.each([
    ['public', 'MAU-test'],
    ['internal:', 'MAU-test'],
    ['internal:KD', 'MAU-test'],
    ['internal:kd;x', 'MAU-test'],
    ['internal:kd', ''],
    ['internal:kd', '   '],
    ['internal:kd', null],
    [null, 'MAU-test'],
  ])('CHECK chunks_internal (%j, %j)', async (coll, by) => {
    const e = await pool
      .query(
        "insert into chunks_internal (collection, doc_id, chunk_index, content, doc_sha256, approved_by) values ($1,'t-x',0,'MẪU','x',$2)",
        [coll, by],
      )
      .catch((x) => x);
    expect(['23514', '23502']).toContain(e.code);
  });

  it('chế độ thực: người không có trong approvers khối data_platform → exit 1, authz_denied, 0 embed', async () => {
    settings.forceMode = 'van_hanh';
    const f = join(dir, 'quy_trinh_MAU.md');
    writeFileSync(f, '# Quy trình MẪU\n\nBước 1: kiểm hàng. Bước 2: ghi sổ.\n');
    const fe = new FakeEmbed();
    const out: string[] = [];
    const count = async () =>
      (
        await pool.query(
          "select count(*)::int as n from agent_action_log where action = 'authz_denied' and object_type = 'chunks_internal' and object_id = 'internal:kd/quy-trinh-mau'",
        )
      ).rows[0].n;
    const before = await count();
    const code = await kbInternalMain(
      { file: f, collection: 'internal:kd', approvedBy: 'Người Giả Lập' },
      {
        env: { DATABASE_URL: dsn, NODE_ENV: 'test', APPROVAL_ENFORCE: '1' },
        ai: () => fe,
        log: (s) => out.push(s),
        servicePool: async () => {
          throw new Error('không được tới loader');
        },
      },
    );
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('Bên B ủy quyền');
    expect(await count()).toBe(before + 1);
    expect(fe.calls).toBe(0);
  });

  // Dịch nửa sau tests/test_v14_p2_service_auth.py::test_kb_internal_enforced_gate_human_login_then_loader
  it('chế độ thực: người trong approvers + login của CHÍNH họ → qua cổng, ghi bằng login svc_loader', async () => {
    settings.forceMode = 'van_hanh';
    const pid = process.pid;
    const person = `t_rag_person_${pid}`;
    const loader = `t_rag_loader_${pid}`;
    const pw = `p${Math.random().toString(36).slice(2)}`;
    const NAME = 'Trưởng Phòng Giả Lập';
    const tmp = mkdtempSync(join(tmpdir(), 'rag-auth-'));
    const cfg = JSON.parse(readFileSync(dataPath('directors', 'data_platform.json'), 'utf8'));
    writeFileSync(join(tmp, 'data_platform.json'), JSON.stringify({ ...cfg, approvers: [NAME] }));
    const users = join(tmp, 'users.json');
    writeFileSync(
      users,
      JSON.stringify({ [NAME]: { role: 'ha_tang', password_hash: '', db_login: person } }),
    );
    const login = (role: string) => {
      const u = new URL(dbUrl(DB));
      u.username = role;
      u.password = pw;
      return u.toString();
    };
    await adminQuery(`drop role if exists ${person}`);
    await adminQuery(`drop role if exists ${loader}`);
    await adminQuery(`create role ${person} login password '${pw}' in role app_human`);
    await adminQuery(`create role ${loader} login password '${pw}' in role svc_loader`);
    setDirectorsDir(tmp);
    const writers: string[] = [];
    try {
      const f = join(dir, 'quy_trinh_MAU.md');
      writeFileSync(f, '# Quy trình MẪU\n\nBước 1: kiểm hàng. Bước 2: ghi sổ.\n');
      const denied = async () =>
        (
          await pool.query(
            "select count(*)::int as n from agent_action_log where action = 'authz_denied'",
          )
        ).rows[0].n;
      const before = await denied();
      const fe = new FakeEmbed();
      const out: string[] = [];
      const code = await kbInternalMain(
        { file: f, collection: 'internal:kd', approvedBy: NAME, cutover: true },
        {
          env: {
            NODE_ENV: 'test',
            APPROVAL_ENFORCE: '1',
            AUTH_USERS_FILE: users,
            DATABASE_URL: login(person),
            LOADER_DATABASE_URL: login(loader),
          },
          ai: () => fe,
          log: (s) => out.push(s),
          servicePool: async (s: Service, env) => {
            const p = await servicePool(s, env);
            writers.push((await p.query('select session_user as u')).rows[0].u);
            return p;
          },
        },
      );
      expect([code, out.at(-1)]).toEqual([
        0,
        '[kb-internal] internal:kd / quy-trinh-mau: đã nạp — 1 chunk, version 1',
      ]);
      expect(writers).toEqual([loader]);
      expect(fe.texts).toBe(1);
      expect((await pool.query('select distinct approved_by from chunks_internal')).rows).toEqual([
        { approved_by: NAME },
      ]);
      expect(await denied()).toBe(before);
      // login người không tự ghi/xóa được chunks_internal (chỉ loader)
      const hp = createPool(login(person));
      try {
        const e = await hp.query('delete from chunks_internal').catch((x) => x);
        expect(e.code).toBe('42501');
      } finally {
        await hp.end();
      }
    } finally {
      setDirectorsDir();
      rmSync(tmp, { recursive: true, force: true });
      await adminQuery(`drop role if exists ${person}`);
      await adminQuery(`drop role if exists ${loader}`);
    }
  });

  it('cổng loader TẮT → exit 2, 0 embed, 0 ghi', async () => {
    settings.forceMode = 'tat';
    const f = join(dir, 'quy-trinh.md');
    writeFileSync(f, '# Quy trình nội bộ\n\nNội dung.\n');
    const fe = new FakeEmbed();
    const out: string[] = [];
    const code = await kbInternalMain(
      { file: f, collection: 'internal:sx', approvedBy: 'Trưởng Phòng Giả Lập' },
      { env: { DATABASE_URL: dsn, NODE_ENV: 'test' }, ai: () => fe, log: (s) => out.push(s) },
    );
    expect(code).toBe(2);
    expect(out.some((l) => l.startsWith('[rollout]'))).toBe(true);
    expect(fe.calls).toBe(0);
    expect((await pool.query('select count(*)::int as n from chunks_internal')).rows[0].n).toBe(0);
  });

  // ---------------------------------------------------------------- retrieve
  const Q = pad([1, 0, 0]);
  const vec = (v: number[]) => `[${pad(v).join(',')}]`;
  const insertPublic = async (docId: string, content: string, v: number[], i = 0, title = 'MẪU') =>
    pool.query(
      "insert into chunks (doc_id, chunk_index, source_url, title, lang, content, embedding_v2, source) values ($1,$2,'http://test-rag',$3,'vi',$4,$5::vector,'test-rag')",
      [docId, i, title, content, vec(v)],
    );
  const svc = () => {
    const s = new RagService(pool, new FakeEmbed(null, Q));
    s.env = {};
    s.warn = quiet;
    return s;
  };

  it('retrieve mặc định không trả chunk nội bộ / chunk rượu; nội bộ phải truyền tường minh', async () => {
    const r = await ingestDoc(
      pool,
      new FakeEmbed(null, Q),
      {
        collection: 'internal:test_rag',
        docId: 'test-mau',
        title: 'MẪU',
        sourceRef: 'kb_noi_bo_MAU.md',
        approvedBy: BY,
        text: 'MẪU nội bộ — quy trình kiểm thử, không phải tài liệu thật.',
        model: 'bge-m3',
        cutover: true,
      },
      quiet,
    );
    expect(r.status).toBe('loaded');
    await insertPublic('test-ruou', 'Rượu sâm Ngọc Linh No.9 giá tốt', [1, 0, 0]);
    await insertPublic('test-pub', 'MẪU công khai Saphraton', [1, 0, 0]);
    // row chỉ có vector cũ (chưa embed lại BGE-M3) → không trả
    await pool.query(
      "insert into chunks (doc_id, chunk_index, source_url, title, lang, content, source) values ('test-old', 0, 'u', 't', 'vi', 'cũ', 'test-rag')",
    );
    const ids = (await svc().retrieve('bất kỳ')).map((h) => h.doc_id);
    expect(ids[0]).toBe('test-pub');
    for (const x of ['test-ruou', 'test-mau', 'test-old']) expect(ids).not.toContain(x);
    const hi = await svc().retrieve('bất kỳ', 8, { collection: 'internal:test_rag' });
    expect(hi[0].doc_id).toBe('test-mau');
    expect(hi.every((h) => h.doc_id === 'test-mau')).toBe(true);
  });

  it.each([1, 3, 8])(
    'Postgres thật: float8 (quét chính xác) ≡ pgvector (HNSW), k=%i',
    async (k) => {
      const corpus: [string, string, number[], number?][] = [
        ['ruou', 'Rượu sâm No.9 giá tốt', [1, 0.2, 0]],
        ['a', 'Saphraton 80 viên', [1, 0.25, 0.05]],
        ['a', 'Saphraton 20V', [0.9, 0.5, 0.1], 1],
        ['b', 'Savina tuýp', [0.7, 0.7, 0.2]],
        ['c', 'Lịch sử công ty', [0.2, 1, 0.3]],
        ['d', 'Trồng sâm', [0.1, 0.3, 1]],
        ['catalog-products', 'Danh mục sản phẩm', [0.3, 0.6, 0.8]],
      ];
      for (const [d, c, v, i] of corpus) await insertPublic(d, c, v, i ?? 0);
      const q = pad([1, 0.2, 0]);
      const s = svc();
      const f8 = await s.retrieveByVector(q, k, { backend: 'float8', ident: true });
      const pg = await s.retrieveByVector(q, k, { backend: 'pgvector', ident: true });
      expect(pg.map((h) => [h.doc_id, h.chunk_index])).toEqual(
        f8.map((h) => [h.doc_id, h.chunk_index]),
      );
      for (const [i, h] of pg.entries()) expect(h.score).toBeCloseTo(f8[i].score, 5);
      expect(f8.map((h) => h.doc_id)).not.toContain('ruou');
      if (k <= 3) expect(f8.at(-1)?.doc_id).toBe('catalog-products');
    },
  );

  it('Postgres thật: lũ chunk rượu → pgvector vẫn trả đủ k (chạy lại quét chính xác)', async () => {
    for (let i = 0; i < 70; i++)
      await insertPublic(`r${i}`, `Rượu sâm số ${i}`, [1, 0.2, 0.0001 * i]);
    await insertPublic('a', 'Saphraton 80 viên', [1, 0.25, 0.05]);
    await insertPublic('b', 'Savina tuýp', [0.7, 0.7, 0.2]);
    await insertPublic('c', 'Lịch sử công ty', [0.2, 1, 0.3]);
    await insertPublic('d', 'Trồng sâm', [0.1, 0.3, 1]);
    const q = pad([1, 0.2, 0]);
    const pg = await svc().retrieveByVector(q, 4, { backend: 'pgvector' });
    const f8 = await svc().retrieveByVector(q, 4, { backend: 'float8' });
    expect(pg.length).toBe(4);
    expect(pg.map((h) => h.doc_id)).toEqual(f8.map((h) => h.doc_id));
  });

  it.each(['float8', 'pgvector'])(
    'Postgres thật: nội bộ (%s) không lọc rượu, đúng collection',
    async (b) => {
      for (const [coll, id, c, v] of [
        ['internal:kd', 'kd-1', 'Rượu — quy trình kho', [1, 0.2, 0]],
        ['internal:kd', 'kd-2', 'Quy trình B', [0.5, 0.5, 0.5]],
        ['internal:kho', 'kho-1', 'Kho khác', [1, 0.2, 0]],
      ] as [string, string, string, number[]][]) {
        await pool.query(
          "insert into chunks_internal (collection, doc_id, chunk_index, content, embedding_v2, doc_sha256, approved_by) values ($1,$2,0,$3,$4::vector,'x',$5)",
          [coll, id, c, vec(v), BY],
        );
      }
      const hits = await svc().retrieveByVector(pad([1, 0.2, 0]), 2, {
        collection: 'internal:kd',
        backend: b,
      });
      expect(hits.map((h) => h.doc_id)).toEqual(['kd-1', 'kd-2']);
      expect(hits[0].lang).toBeNull();
    },
  );
});
