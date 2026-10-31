import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import type { jobRun } from '@samsam/core/ops/job-runs';
import { dataPath } from '@samsam/core/paths';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildItems,
  type ChatFn,
  cleanText,
  type Item,
  normalizeUrl,
  parseFeed,
  storeItems,
} from './intel.js';
import {
  Clock,
  closeServers,
  mockTransport,
  type Server,
  serve,
  spyTransport,
} from './intel.testing.js';
import { type IntelDeps, type IntelOpts, intelMain } from './intel-crawl.command.js';

// Dịch tests/test_intel.py (phần DB): DB riêng `t_intel_crawl_<pid>_<rand>` tạo từ mẫu (xóa khi xong),
// KHÔNG BAO GIỜ DB `samsam`. Mạng = http.Server local; đồng hồ giả.

const NAME = testDbName('intel_crawl');
const FIX = new URL('./__fixtures__/', import.meta.url);
const RSS = readFileSync(new URL('rss_sample.xml', FIX));
const SITE_FEED = readFileSync(new URL('site/feed.xml', FIX));
const TOPICS = JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8')).topics as Record<
  string,
  string[]
>;
const ROBOTS_OK: [number, Record<string, string>, string] = [
  200,
  {},
  'User-agent: *\nDisallow: /private/\n',
];

const items = (): Item[] =>
  buildItems(parseFeed(RSS), { id: 'fx-t', tier: 'A' }, 'https://bao.example.vn/rss', TOPICS)[0];

// Tệp tạm của test trong 1 thư mục riêng, xóa khi xong (không rác trong thư mục tạm chung).
const TMP = mkdtempSync(join(tmpdir(), 'intel_crawl_'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('crawler.intel (DB)', () => {
  let dsn: string;
  let pool: Pool;
  const count = async (t = 'intel_items') =>
    Number((await pool.query(`select count(*) as n from ${t}`)).rows[0].n);

  beforeAll(async () => {
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
  });
  beforeEach(async () => {
    await pool.query('truncate intel_items restart identity cascade');
  });
  afterEach(closeServers);

  // ------------------------------------------------------------ lưu (W70.4)

  it('lưu idempotent: lần 2 toàn trùng url, snippet ≤300', async () => {
    const c = await pool.connect();
    try {
      expect(await storeItems(c, items())).toEqual({ new: 3, dup_url: 0, dup_content: 0 });
      const n = await count();
      const r2 = await storeItems(c, items());
      expect(r2).toEqual({ new: 0, dup_url: 3, dup_content: 0 });
      expect(await count()).toBe(n);
    } finally {
      c.release();
    }
    const m = await pool.query('select max(char_length(snippet)) as m from intel_items');
    expect(Number(m.rows[0].m)).toBeLessThanOrEqual(300);
  });

  it('chống trùng: biến thể URL (utm) + cùng nội dung khác URL', async () => {
    const c = await pool.connect();
    try {
      const base = items()[0] as Item;
      const v1 = {
        ...base,
        url: normalizeUrl('https://bao.example.vn/bai/sam-gia/?utm_campaign=x'),
      };
      const v2 = { ...base, url: 'https://bao.example.vn/khac' };
      expect(await storeItems(c, [base, v1])).toEqual({ new: 1, dup_url: 1, dup_content: 0 });
      expect(await storeItems(c, [v2])).toEqual({ new: 0, dup_url: 0, dup_content: 1 });
    } finally {
      c.release();
    }
    expect(await count()).toBe(1);
  });

  it.each([
    ['snippet', 'x'.repeat(301)],
    ['title', 'x'.repeat(301)],
    ['summary', 'x'.repeat(301)],
    ['tier', 'C'],
  ])('ràng buộc DB: %s', async (col, val) => {
    const row: Record<string, unknown> = {
      url: 'https://a.vn/1',
      domain: 'a.vn',
      source: 'fx-t',
      tier: 'A',
      title: 't',
      snippet: 's',
      summary: null,
      content_sha256: '0'.repeat(64),
      topics: ['sam'],
    };
    row[col] = val;
    const cols = Object.keys(row);
    await expect(
      pool.query(
        `insert into intel_items (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ------------------------------------------------------------ CLI (W70.5)

  type JobLog = { seen: unknown[]; runs: [string, { ok: boolean; detail: string | null }][] };
  const fakeJob = (j: JobLog) =>
    (async (
      name: string,
      body: (r: { ok: boolean; detail: string | null }) => Promise<unknown>,
    ) => {
      j.seen.push(name);
      const run = { ok: true, detail: null as string | null };
      const r = await body(run);
      j.seen.push(run.ok);
      j.runs.push([name, run]);
      return r;
    }) as unknown as typeof jobRun;

  async function cli(o: IntelOpts, extra: Partial<IntelDeps> = {}) {
    const out: string[] = [];
    const j: JobLog = { seen: [], runs: [] };
    const clk = new Clock();
    const spy = spyTransport();
    const rc = await intelMain(o, {
      env: {},
      log: (s) => out.push(s),
      err: (s) => out.push(s),
      open: async () => createPool(dsn),
      fetcher: { transport: spy, sleep: clk.sleep, clock: clk.clock },
      jobRun: fakeJob(j),
      ...extra,
    });
    return { rc, out: out.join('\n'), spy, ...j };
  }
  const done = (out: string) => {
    const line = out
      .split('\n')
      .filter((l) => l.startsWith('[done] '))
      .pop() as string;
    return Object.fromEntries(
      line
        .split(' ')
        .slice(1)
        .map((kv) => kv.split('=')),
    );
  };

  const site = (feed: Buffer = SITE_FEED) =>
    serve({
      '/robots.txt': ROBOTS_OK,
      '/feed.xml': [200, {}, feed],
      '/private/feed.xml': [200, {}, feed],
    });

  function sourcesFile(s: Server, llm = false, extra: Record<string, unknown>[] = []): string {
    const cfg = JSON.parse(readFileSync(new URL('sources_e2e.json', FIX), 'utf8'));
    cfg.llm.enabled = llm;
    cfg.topics = TOPICS;
    cfg.sources[0].url = s.url('/feed.xml');
    cfg.sources[1].url = s.url('/private/feed.xml');
    cfg.sources.push(...extra);
    const p = join(TMP, `intel_e2e_${process.pid}_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(cfg));
    return p;
  }

  it('0 nguồn đã duyệt (file thật) → [warn], exit 0, 0 request', async () => {
    const r = await cli({ run: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('0 nguồn đã duyệt');
    expect(r.spy.hosts).toEqual([]);
    expect(r.seen).toEqual(['crawler.intel', true]);
  });

  it('E2E 2 lượt: idempotent, robots cấm, redirect tầng C bị chặn, không GET trang bài', async () => {
    const s = await site();
    const c = await serve({ '/feed.xml': [200, {}, 'x'] });
    const tierC = {
      id: 'fx-c2',
      name: 'c',
      tier: 'C',
      url: c.url('/feed.xml', 'localhost'),
      kind: 'rss',
      status: 'cho_duyet',
    };
    const redir = await serve({
      '/robots.txt': ROBOTS_OK,
      '/feed.xml': [302, { Location: c.url('/feed.xml', 'localhost') }, ''],
    });
    const toC = {
      id: 'fx-redir',
      name: 'r',
      tier: 'B',
      url: redir.url('/feed.xml'),
      kind: 'rss',
      status: 'cho_duyet',
    };
    const p = sourcesFile(s, false, [tierC, toC]);
    const before = [await count('content_drafts'), await count('agent_action_log')];
    const o = { run: true, source: ['fx-a', 'fx-private', 'fx-redir'], sources: p };
    const r1 = await cli(o);
    const d1 = done(r1.out);
    expect(r1.rc).toBe(0);
    expect(d1.new).toBe('2');
    expect(d1.off_topic).toBe('1');
    expect(d1.robots_deny).toBe('1');
    expect(d1.blocked).toBe('1');
    expect(r1.out).toContain('chạy thử');
    expect(r1.out).toContain('"reason": "tier_c"');
    const n = await count();
    const r2 = await cli(o);
    const d2 = done(r2.out);
    expect(r2.rc).toBe(0);
    expect(d2.new).toBe('0');
    expect(d2.dup_url).toBe('2');
    expect(await count()).toBe(n);
    expect(s.hits.some((h) => h.startsWith('/bai/'))).toBe(false);
    expect(c.hits).toEqual([]);
    expect([...r1.spy.hosts, ...r2.spy.hosts]).not.toContain('localhost');
    // W70.7: không đụng hàng duyệt nội dung / nhật ký hành động.
    expect([await count('content_drafts'), await count('agent_action_log')]).toEqual(before);
    expect([...r1.seen, ...r2.seen]).toEqual(['crawler.intel', true, 'crawler.intel', true]);
    const srcs = (await pool.query('select distinct source from intel_items')).rows.map(
      (x) => x.source,
    );
    expect(srcs).toEqual(['fx-a']);
  });

  it('mọi nguồn lỗi → exit 1', async () => {
    const s = await site();
    const r = await cli({ run: true, source: ['fx-private'], sources: sourcesFile(s) });
    expect(r.rc).toBe(1);
  });

  it('job_runs.detail mang id nguồn lỗi (không URL/host)', async () => {
    const s = await site();
    const bad = await serve({ '/robots.txt': ROBOTS_OK, '/feed.xml': [500, {}, 'loi'] });
    const src500 = {
      id: 'fx-500',
      name: 'x',
      tier: 'B',
      url: bad.url('/feed.xml'),
      kind: 'rss',
      status: 'cho_duyet',
    };
    const r = await cli({
      run: true,
      source: ['fx-a', 'fx-500', 'fx-private'],
      sources: sourcesFile(s, false, [src500]),
    });
    expect(r.rc).toBe(0);
    expect(r.runs.length).toBe(1);
    const [name, run] = r.runs[0] as [string, { ok: boolean; detail: string | null }];
    expect(name).toBe('crawler.intel');
    expect(run.ok).toBe(true);
    const detail = String(run.detail);
    expect(detail.startsWith('fail=fx-500,fx-private ')).toBe(true);
    expect(detail).toContain('robots_deny=1');
    expect(detail).toContain('blocked=0');
    expect(detail).not.toContain('http');
    expect(detail).not.toContain('127.0.0.1');
  });

  it('hết ngân sách → dừng lượt, exit 1', async () => {
    const s = await site();
    const r = await cli({ run: true, source: ['fx-a'], maxRequests: '1', sources: sourcesFile(s) });
    expect(r.rc).toBe(1);
    expect(s.hits.length).toBe(1);
    expect(r.out).toContain('hết ngân sách');
  });

  it('--report', async () => {
    let r = await cli({ report: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('chưa có tin');
    const c = await pool.connect();
    await storeItems(c, items()).finally(() => c.release());
    r = await cli({ report: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Tổng tin: 3');
    expect(r.out).toContain('ruou=1');
    expect(r.out).toContain('https://bao.example.vn/bai/sam-gia');
  });

  it('--report: dòng cũ năm 9999 → "?" (không tràn)', async () => {
    const it0 = {
      ...(items()[0] as Item),
      published_at: { y: 9999, mo: 12, d: 31, h: 20, mi: 0, s: 0, us: 0, offUs: 0 },
    };
    const c = await pool.connect();
    await storeItems(c, [it0]).finally(() => c.release());
    const r = await cli({ report: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('  ? [fx-t]');
  });

  it('link hỏng + Location hỏng: lượt chạy tiếp, không traceback', async () => {
    const feed = Buffer.from(
      "<rss version='2.0'><channel><title>t</title>" +
        '<item><title>Sâm Ngọc Linh link hỏng 1</title><link>http://[::1</link></item>' +
        '<item><title>Sâm Ngọc Linh link hỏng 2</title><link>http://[bad]/x</link></item>' +
        '<item><title>Sâm Ngọc Linh link hỏng 3</title><link>//[x]/</link></item>' +
        '<item><title>Sâm Ngọc Linh tin hợp lệ</title><link>/bai/hop-le</link></item></channel></rss>',
    );
    const s = await site(feed);
    const bad = await serve({
      '/robots.txt': ROBOTS_OK,
      '/feed.xml': [302, { Location: 'http://a]b/x' }, ''],
    });
    const badloc = {
      id: 'fx-badloc',
      name: 'b',
      tier: 'B',
      url: bad.url('/feed.xml'),
      kind: 'rss',
      status: 'cho_duyet',
    };
    const p = sourcesFile(s, false, [badloc]);
    let r = await cli({ run: true, source: ['fx-badloc', 'fx-a'], sources: p });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('fx-badloc: redirect Location hỏng');
    const d = done(r.out);
    expect(d.ok).toBe('1');
    expect(d.new).toBe('1');
    expect(r.seen).toEqual(['crawler.intel', true]);
    const urls = (await pool.query('select url from intel_items')).rows.map((x) => x.url);
    expect(urls).toEqual([s.url('/bai/hop-le')]);
    r = await cli({ run: true, source: ['fx-badloc'], sources: p });
    expect(r.rc).toBe(1);
  });

  // ------------------------------------------------------------ LLM (W70.6)

  type Call = [string, string];
  const fakeChat =
    (calls: Call[], reply = 'Tin về sâm Ngọc Linh giả bị thu giữ.', exc?: Error): ChatFn =>
    async (agent, messages) => {
      calls.push([agent, JSON.stringify(messages)]);
      if (exc) throw exc;
      return { text: reply };
    };
  async function llmRun(flag: boolean, enabled: boolean, reply?: string, exc?: Error) {
    const s = await serve({ '/robots.txt': ROBOTS_OK, '/feed.xml': [200, {}, RSS] });
    const calls: Call[] = [];
    const r = await cli(
      { run: true, source: ['fx-a'], sources: sourcesFile(s, enabled), llm: flag || undefined },
      { chat: fakeChat(calls, reply, exc) },
    );
    return { ...r, calls };
  }

  it('LLM mặc định TẮT (không --llm)', async () => {
    const r = await llmRun(false, true);
    expect(r.rc).toBe(0);
    expect(r.calls).toEqual([]);
    expect(
      Number(
        (await pool.query('select count(*) as n from intel_items where summary is not null'))
          .rows[0].n,
      ),
    ).toBe(0);
  });

  it('--llm nhưng llm.enabled=false → [warn], 0 gọi', async () => {
    const r = await llmRun(true, false);
    expect(r.rc).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('LLM tắt — chờ Pháp chế xác nhận');
  });

  it('--llm bật: agent intel, payload đã che PII, tin trùng không gọi lại', async () => {
    const r = await llmRun(true, true);
    expect(r.rc).toBe(0);
    expect(r.calls.length).toBe(3);
    expect(r.calls.every(([a]) => a === 'intel')).toBe(true);
    const payload = r.calls.map(([, m]) => m).join('');
    expect(payload).not.toContain('0905 123 456');
    expect(payload).not.toContain('a.b@gmail.com');
    expect(
      Number(
        (await pool.query('select count(*) as n from intel_items where summary is not null'))
          .rows[0].n,
      ),
    ).toBe(3);
    const r2 = await llmRun(true, true);
    expect(r2.rc).toBe(0);
    expect(r2.calls).toEqual([]);
  });

  it('tóm tắt vi phạm guardrail → không lưu summary, cờ llm_guardrail_fail', async () => {
    const r = await llmRun(true, true, 'Sâm giúp chữa bệnh ung thư.');
    expect(r.rc).toBe(0);
    expect(r.calls.length).toBeGreaterThan(0);
    const rows = (await pool.query('select summary, flags from intel_items')).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.summary === null && x.flags.includes('llm_guardrail_fail'))).toBe(
      true,
    );
  });

  it('gateway chặn (rollout tắt/trần/kill) → tắt LLM phần còn lại, tin vẫn lưu', async () => {
    const r = await llmRun(true, true, undefined, new GatewayBlocked('cap'));
    expect(r.rc).toBe(0);
    expect(r.calls.length).toBe(1);
    expect(r.out).toContain('LLM tắt phần còn lại của lượt (GatewayBlocked)');
    expect(await count()).toBe(3);
  });

  it('entity được giải mã TRƯỚC guardrail ("&#99;hữa" → "chữa")', async () => {
    const r = await llmRun(true, true, 'Tin tức sâm: &#99;hữa bệnh');
    expect(r.rc).toBe(0);
    const rows = (await pool.query('select summary, flags from intel_items')).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.summary === null && x.flags.includes('llm_guardrail_fail'))).toBe(
      true,
    );
  });

  it('summary lưu đúng chuỗi đã kiểm', async () => {
    const reply = 'Tin &amp; sâm <b>Ngọc Linh</b>   giả';
    const r = await llmRun(true, true, reply);
    expect(r.rc).toBe(0);
    const sums = new Set(
      (await pool.query('select summary from intel_items')).rows.map((x) => x.summary),
    );
    expect(sums).toEqual(new Set([cleanText(reply)]));
    expect(cleanText(reply)).toBe('Tin & sâm Ngọc Linh giả');
  });

  // ------------------------------------------------------------ PC-A8 (tests/test_pc_a8.py)
  // Nguồn văn bản pháp luật tầng A (host thật vfa.gov.vn) qua collector chung — transport GIẢ
  // theo host+path (0 request ra Internet), đồng hồ giả.

  describe('PC-A8 nguồn văn bản pháp luật', () => {
    const LEGAL_ID = 'cuc-attp-van-ban';
    const FEED = Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Văn bản mới</title>
<item><title>Nghị định quy định về thực phẩm bảo vệ sức khỏe</title>
<link>https://vfa.gov.vn/van-ban/nd-01</link>
<description>Văn bản quy phạm pháp luật mới ban hành.</description>
<pubDate>Mon, 12 Oct 2026 02:00:00 GMT</pubDate></item>
<item><title>Thông tư hướng dẫn quảng cáo thực phẩm</title>
<link>https://vfa.gov.vn/van-ban/tt-02</link>
<description>Hướng dẫn thủ tục.</description></item>
</channel></rss>`,
      'utf8',
    );
    const ROBOTS = 'User-agent: *\nDisallow: /private/\n';
    const src = new URL(
      (
        JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8')).sources as {
          id: string;
          url: string;
        }[]
      ).find((x) => x.id === LEGAL_ID)?.url as string,
    );
    const H = src.hostname;
    const FEED_PATH = src.pathname;

    async function legal(routes: Parameters<typeof mockTransport>[0]) {
      const mock = mockTransport(routes);
      const clk = new Clock();
      const r = await cli(
        { run: true, source: [LEGAL_ID] },
        { fetcher: { transport: mock, sleep: clk.sleep, clock: clk.clock } },
      );
      return { ...r, mock, clk };
    }
    const reqLines = (out: string) =>
      out
        .split('\n')
        .filter((l) => l.startsWith('[req] '))
        .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

    it('robots trước, chỉ GET robots + feed, nhịp ≥1s, lưu tin phap_ly', async () => {
      const r = await legal({
        [`${H}/robots.txt`]: [200, {}, ROBOTS],
        [`${H}${FEED_PATH}`]: [200, {}, FEED],
      });
      expect(r.rc, r.out).toBe(0);
      expect(r.mock.reqs.map((u) => u.pathname)).toEqual(['/robots.txt', FEED_PATH]);
      expect(new Set(r.mock.reqs.map((u) => u.hostname))).toEqual(new Set([H]));
      const reqs = reqLines(r.out);
      expect(reqs[0]?.kind).toBe('robots');
      expect(reqs[1]?.kind).toBe('feed');
      expect(Number(reqs[1]?.gap_s)).toBeGreaterThanOrEqual(1.0);
      expect(r.clk.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1.0 - 1e-9);
      expect(r.out).toContain('[warn] cuc-attp-van-ban: nguồn chưa duyệt — chạy thử');
      const rows = (
        await pool.query<{ source: string; tier: string; topics: string[] }>(
          'select source, tier, topics from intel_items order by id',
        )
      ).rows;
      expect(rows).toHaveLength(2);
      expect(
        rows.every((x) => x.source === LEGAL_ID && x.tier === 'A' && x.topics.includes('phap_ly')),
      ).toBe(true);
      expect(rows.some((x) => x.topics.includes('tpbvsk'))).toBe(true);
      expect(rows.some((x) => x.topics.includes('quang_cao'))).toBe(true);
    });

    it('robots cấm hết → 0 GET feed, exit 1, 0 dòng', async () => {
      const r = await legal({
        [`${H}/robots.txt`]: [200, {}, 'User-agent: *\nDisallow: /\n'],
        [`${H}${FEED_PATH}`]: [200, {}, FEED],
      });
      expect(r.rc).toBe(1); // 0 nguồn thành công
      expect(r.mock.reqs.map((u) => u.pathname)).toEqual(['/robots.txt']);
      expect(r.out).toContain('[robots-deny] ');
      expect(await count()).toBe(0);
    });

    it.each(['https://shopee.vn/rss', 'https://www.facebook.com/feed', 'https://m.tiktok.com/x'])(
      'redirect sang host bị chặn %s → [blocked], 0 request tới đích',
      async (target) => {
        const r = await legal({
          [`${H}/robots.txt`]: [200, {}, ROBOTS],
          [`${H}${FEED_PATH}`]: [302, { Location: target }, ''],
        });
        expect(r.rc).toBe(1);
        expect(r.out).toContain('[blocked] ');
        expect(r.mock.reqs.map((u) => u.hostname)).not.toContain(new URL(target).hostname);
        expect(r.mock.reqs.map((u) => u.pathname)).toEqual(['/robots.txt', FEED_PATH]);
      },
    );
  });

  // ------------------------------------------------------------ thiếu bảng (chạy cuối)

  describe('thiếu bảng intel_items', () => {
    beforeEach(async () => {
      await pool.query('alter table intel_items rename to intel_items_tam');
    });
    afterEach(async () => {
      await pool.query('alter table intel_items_tam rename to intel_items');
    });
    it('→ exit 1, nhắc apply_schema, 0 request', async () => {
      const r = await cli({ report: true });
      expect(r.rc).toBe(1);
      expect(r.out).toContain('apply_schema');
      expect(r.spy.hosts).toEqual([]);
    });
  });
});
