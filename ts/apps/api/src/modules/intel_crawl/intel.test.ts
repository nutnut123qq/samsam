import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pyStr } from '@samsam/core/ops/py-date';
import { dataPath, repoPath } from '@samsam/core/paths';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { KbFilterError, resetCache, setKbFiles } from '@samsam/core/security/kb-filter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stripHtml } from './html-soup.js';
import {
  BlockedDomain,
  BudgetExhausted,
  buildItems,
  classify,
  cleanText,
  FeedError,
  Fetcher,
  gunzipCapped,
  isBlocked,
  loadSources,
  MAX_BYTES,
  MAX_ENTRIES,
  MAX_HOPS,
  normalizeUrl,
  PRE_MAX,
  parse,
  parseDate,
  parseFeed,
  run,
  tierCHosts,
  userAgent,
} from './intel.js';
import {
  Clock,
  closeServers,
  mockTransport,
  type Route,
  serve,
  spyTransport,
} from './intel.testing.js';
import { type IntelOpts, intelMain } from './intel-crawl.command.js';

// Dịch tests/test_intel.py (phần không cần DB): mạng = http.Server local (cổng 0), nhịp đo bằng
// đồng hồ/sleep GIẢ tiêm vào Fetcher (không assert wall-clock); transport "spy" ghi host để chứng
// minh 0 request tới host bị chặn.

const FIX = new URL('./__fixtures__/', import.meta.url);
const RSS = readFileSync(new URL('rss_sample.xml', FIX));
const ATOM = readFileSync(new URL('atom_sample.xml', FIX));
const TOPICS = JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8')).topics as Record<
  string,
  string[]
>;

afterEach(closeServers);
// Tệp tạm của test trong 1 thư mục riêng, xóa khi xong (không rác trong thư mục tạm chung).
const TMP = mkdtempSync(join(tmpdir(), 'intel_crawl_'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const ROBOTS_OK: Route = [200, {}, 'User-agent: *\nDisallow: /private/\n'];

function fetcher(
  clk: Clock,
  logs: string[],
  extra: Partial<ConstructorParameters<typeof Fetcher>[0]> = {},
) {
  return new Fetcher({
    transport: spyTransport(),
    sleep: clk.sleep,
    clock: clk.clock,
    log: (s) => logs.push(s),
    env: {},
    ...extra,
  });
}
const reqs = (lines: string[]) =>
  lines
    .filter((l) => l.startsWith('[req] '))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

// ---------------------------------------------------------------- nguồn (W70.1)

describe('load_sources — fail-closed', () => {
  it('file nguồn thật: tầng A/B chờ duyệt, có tầng C bị chặn, LLM tắt', () => {
    const [cfg, errs] = loadSources(dataPath('intel_sources.json'));
    expect(errs).toEqual([]);
    const ab = cfg?.sources.filter((s) => s.tier === 'A' || s.tier === 'B') ?? [];
    expect(ab.length).toBeGreaterThan(0);
    expect(ab.every((s) => s.status === 'cho_duyet')).toBe(true);
    expect(cfg?.sources.some((s) => s.tier === 'C')).toBe(true);
    expect(cfg?.llm.enabled).toBe(false);
    expect(String(cfg?._doc)).toContain('chờ');
    expect(String(cfg?.llm._doc)).toContain('chờ');
    expect(new Set(Object.keys(cfg?.topics ?? {}))).toEqual(
      new Set(['sam', 'tpbvsk', 'gioi_tre', 'quang_cao', 'doi_thu', 'chuong_trinh', 'phap_ly']),
    );
    const c = tierCHosts(cfg as { sources: unknown });
    expect(c).toContain('linkedin.com');
    expect(isBlocked('www.linkedin.com', c)).toBe(true);
  });

  const base = () => JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8'));
  // biome-ignore lint/suspicious/noExplicitAny: đột biến JSON tùy ý như test Python
  const BAD: [(c: Record<string, any>) => void, string][] = [
    [(c) => (c.sources = []), 'sources'],
    [(c) => c.sources.push(structuredClone(c.sources[0])), 'vnexpress-suc-khoe.id'],
    [(c) => (c.sources[1].tier = 'X'), 'vnexpress-kinh-doanh.tier'],
    [(c) => (c.sources[1].url = 'ftp://a.vn/x'), 'vnexpress-kinh-doanh.url'],
    [(c) => (c.sources[1].kind = 'html'), 'vnexpress-kinh-doanh.kind'],
    [(c) => (c.sources[1].status = 'ok'), 'vnexpress-kinh-doanh.status'],
    [(c) => (c.topics = {}), 'topics'],
    [(c) => (c.topics.sam = []), 'topics.sam'],
    [(c) => (c.sources[1].id = 'Bad Id!'), 'sources[1].id'],
    [(c) => (c.llm.enabled = 'yes'), 'llm.enabled'],
  ];
  it.each(BAD)('%#: lỗi %s', (mut, field) => {
    const c = base();
    mut(c);
    const p = join(TMP, `intel_src_${process.pid}_${field}.json`);
    writeFileSync(p, JSON.stringify(c));
    const [cfg, errs] = loadSources(p);
    expect(cfg).toBeNull();
    expect(errs.some((e) => e.startsWith(field))).toBe(true);
  });

  it('file thiếu / hỏng', () => {
    let [cfg, errs] = loadSources(join(TMP, 'khong-co.json'));
    expect(cfg).toBeNull();
    expect(errs[0]).toContain('khong-co.json');
    const p = join(TMP, `intel_broken_${process.pid}.json`);
    writeFileSync(p, '{hỏng');
    [cfg, errs] = loadSources(p);
    expect(cfg).toBeNull();
    expect(errs.length).toBeGreaterThan(0);
    // UTF-8 BOM: Python `json.loads(bytes.decode('utf-8'))` báo JSONDecodeError (không tự bỏ BOM).
    const bom = join(TMP, 'bom.json');
    writeFileSync(
      bom,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        readFileSync(dataPath('intel_sources.json')),
      ]),
    );
    [cfg, errs] = loadSources(bom);
    expect(cfg).toBeNull();
    expect(errs).toEqual(['bom.json: không đọc được (JSONDecodeError)']);
  });
});

// ---------------------------------------------------------------- chặn + robots + nhịp (W70.2)

describe('chặn cứng sàn/MXH/tầng C', () => {
  it.each([
    'shopee.vn',
    'm.shopee.vn',
    'SHOPEE.VN',
    'shopee.vn.',
    'vt.tiktok.com',
    'www.facebook.com',
    'https://user@shopee.vn:443/x',
    'shopee.vn:443',
    `${String.fromCharCode(0xff53, 0xff48, 0xff4f, 0xff50, 0xff45, 0xff45)}.vn`,
  ])('chặn %s', (h) => expect(isBlocked(h)).toBe(true));
  it.each(['shopee.vn.evil.com', 'notshopee.vn', 'vnexpress.net', '', 'x.com.vn'])(
    'không chặn %j',
    (h) => expect(isBlocked(h)).toBe(false),
  );

  it.each([
    'https://shopee.vn/x',
    'http://user@m.shopee.vn:443/a',
    'https://www.tiktok.com/@a',
    'ftp://vnexpress.net/rss',
    'javascript:alert(1)',
  ])('fetch %s → BlockedDomain, 0 request', async (url) => {
    const spy = spyTransport();
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs, { transport: spy });
    await expect(f.fetch(url, 't')).rejects.toBeInstanceOf(BlockedDomain);
    expect(spy.hosts).toEqual([]);
    expect(f.used).toBe(0);
    expect(logs.some((l) => l.startsWith('[blocked] '))).toBe(true);
  });
});

describe('Fetcher — robots, redirect, trần, nhịp, ngân sách', () => {
  it('robots cấm /private/', async () => {
    const s = await serve({ '/robots.txt': ROBOTS_OK, '/public/c': [200, {}, '<rss/>'] });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs);
    expect(await f.fetch(s.url('/private/a'), 't')).toBeNull();
    expect(await f.fetch(s.url('/private/b'), 't')).toBeNull();
    const r = await f.fetch(s.url('/public/c'), 't');
    expect(r?.status).toBe(200);
    expect(Buffer.from(r?.body ?? []).toString()).toBe('<rss/>');
    expect(s.hits).toEqual(['/robots.txt', '/public/c']);
    expect(logs.filter((l) => l.startsWith('[robots-deny] ')).length).toBe(2);
    const q = reqs(logs);
    expect(q[0]?.kind).toBe('robots');
    expect(q[0]?.robots_ok).toBeNull();
    expect(q[1]?.robots_ok).toBe(true);
  });

  it.each([
    [500, ['/robots.txt']],
    [429, ['/robots.txt']],
    [403, ['/robots.txt']],
    [401, ['/robots.txt']],
    [404, ['/robots.txt', '/feed']],
    [410, ['/robots.txt', '/feed']],
  ] as [number, string[]][])('robots status %i', async (st, hits) => {
    const s = await serve({ '/robots.txt': [st, {}, 'x'], '/feed': [200, {}, 'ok'] });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs);
    const r = await f.fetch(s.url('/feed'), 't');
    await f.fetch(s.url('/feed'), 't'); // lần 2: robots đã cache, không tải lại
    expect(s.hits.filter((h) => h === '/robots.txt').length).toBe(1);
    expect([...new Set(s.hits)].sort()).toEqual([...new Set(hits)].sort());
    if (!hits.includes('/feed')) expect(r).toBeNull();
    if (st === 401 || st === 403)
      expect(logs.some((l) => l.startsWith('[robots-deny] '))).toBe(true);
  });

  it('robots quá lớn → bỏ host cả lượt', async () => {
    const s = await serve({
      '/robots.txt': [200, {}, '#'.repeat(600_000)],
      '/feed': [200, {}, 'ok'],
    });
    const logs: string[] = [];
    expect(await fetcher(new Clock(), logs).fetch(s.url('/feed'), 't')).toBeNull();
    expect(s.hits).toEqual(['/robots.txt']);
    expect(reqs(logs)[0]?.status).toBe('too_large');
  });

  it('nội dung 429 → không thử lại, bỏ origin', async () => {
    const s = await serve({
      '/robots.txt': ROBOTS_OK,
      '/a': [429, {}, 'slow down'],
      '/b': [200, {}, 'ok'],
    });
    const f = fetcher(new Clock(), []);
    const r = await f.fetch(s.url('/a'), 't');
    expect(await f.fetch(s.url('/b'), 't')).toBeNull();
    expect(r?.status).toBe(429);
    expect(s.hits).toEqual(['/robots.txt', '/a']);
  });

  it('redirect sang tầng C / sàn bị chặn, 0 request tới host đích', async () => {
    const c = await serve({ '/x': [200, {}, 'KHONG DUOC TOI'] });
    const a = await serve({
      '/robots.txt': ROBOTS_OK,
      '/r1': [302, { Location: c.url('/x', 'localhost') }, ''],
      '/r2': [302, { Location: 'https://shopee.vn/x' }, ''],
      '/r3': [301, { Location: 'https://m.tiktok.com/@a' }, ''],
    });
    const extra = tierCHosts({ sources: [{ tier: 'C', url: c.url('/', 'localhost') }] });
    expect(extra).toEqual(['localhost']);
    const spy = spyTransport();
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs, { transport: spy, extraBlock: extra });
    for (const p of ['/r1', '/r2', '/r3']) {
      await expect(f.fetch(a.url(p), 't')).rejects.toBeInstanceOf(BlockedDomain);
    }
    expect(c.hits).toEqual([]);
    expect(new Set(spy.hosts)).toEqual(new Set(['127.0.0.1']));
    const blocked = logs
      .filter((l) => l.startsWith('[blocked] '))
      .map((l) => JSON.parse(l.slice(10)).reason);
    expect(blocked).toEqual(['tier_c', 'hard', 'hard']);
  });

  it('vòng redirect dừng sau 3 hop', async () => {
    const s = await serve({ '/robots.txt': ROBOTS_OK, '/loop': [302, { Location: '/loop' }, ''] });
    const logs: string[] = [];
    expect(await fetcher(new Clock(), logs).fetch(s.url('/loop'), 't')).toBeNull();
    expect(s.hits.filter((h) => h === '/loop').length).toBe(1 + MAX_HOPS);
    expect(logs.some((l) => l.includes('quá 3 redirect'))).toBe(true);
  });

  it('quá lớn: Content-Length, stream, bom gzip', async () => {
    const big: Route = (_q, res) => {
      res.writeHead(200);
      for (let i = 0; i < 50; i++) res.write(Buffer.alloc(1000, 0x78));
      res.end();
    };
    const s = await serve({
      '/robots.txt': ROBOTS_OK,
      '/big': (_q, res) => {
        res.writeHead(200, { 'Content-Length': '5000000' });
        res.write('x'.repeat(100));
      },
      '/stream': big,
      '/bomb': [200, { 'Content-Encoding': 'gzip' }, gzipSync(Buffer.alloc(5_000_000))],
    });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs);
    const r1 = await f.fetch(s.url('/big'), 't');
    const r3 = await f.fetch(s.url('/bomb'), 't');
    const r2 = await fetcher(new Clock(), logs, { maxBytes: 10_000 }).fetch(s.url('/stream'), 't');
    for (const r of [r1, r2, r3]) {
      expect(r?.status).toBe('too_large');
      expect(r?.body).toBeNull();
    }
    const st = Object.fromEntries(reqs(logs).map((q) => [String(q.url).split('/').pop(), q]));
    expect(st.big?.status).toBe('too_large');
    expect(st.big?.bytes).toBe(0);
    expect(st.stream?.status).toBe('too_large');
    expect(Number(st.stream?.bytes)).toBeLessThanOrEqual(10_000 + 65_536);
  });

  it('gzip golden Python (decompressobj): chỉ member đầu, bỏ rác đuôi, CRC/header lỗi, cụt, bom', () => {
    const G = JSON.parse(readFileSync(new URL('gzip.golden.json', FIX), 'utf8')).cases as Record<
      string,
      { raw: string; cap: number; py: string | { len: number; sha256: string } }
    >;
    expect(Object.keys(G).length).toBeGreaterThan(25);
    for (const [name, c] of Object.entries(G)) {
      const out = gunzipCapped(Buffer.from(c.raw, 'hex'), c.cap);
      const got =
        typeof out === 'string'
          ? out
          : out.length > c.cap
            ? 'too_large'
            : { len: out.length, sha256: createHash('sha256').update(out).digest('hex') };
      expect([name, got]).toEqual([name, c.py]);
    }
  });

  it('Content-Encoding rỗng = identity như Python (`or "identity"`)', async () => {
    const t = mockTransport({
      'a.vn/robots.txt': [404, {}, ''],
      'a.vn/feed': [200, { 'Content-Encoding': '' }, 'abc'],
      'a.vn/ws': [200, { 'Content-Encoding': ' ' }, 'abc'],
    });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs, { transport: t });
    const r = await f.fetch('http://a.vn/feed', 't');
    expect(r?.status).toBe(200);
    expect(Buffer.from(r?.body as Uint8Array).toString()).toBe('abc');
    // chỉ khoảng trắng: Python strip() → '' ≠ identity → bad_encoding
    expect((await f.fetch('http://a.vn/ws', 't'))?.status).toBe('bad_encoding');
  });

  it('bom gzip: giải nén dừng ở trần+1 byte (không bung hết)', () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000));
    expect(gunzipCapped(bomb, MAX_BYTES)).toBe('too_large');
    expect(gunzipCapped(Buffer.from('khong phai gzip'), MAX_BYTES)).toBe('bad_encoding');
    const ok = gunzipCapped(gzipSync(Buffer.from('abc')), MAX_BYTES);
    expect(Buffer.from(ok as Uint8Array).toString()).toBe('abc');
  });

  it('nhịp ≥1s/host với đồng hồ giả, 20 URL', async () => {
    const routes: Record<string, Route> = { '/robots.txt': ROBOTS_OK };
    for (let i = 0; i < 20; i++) routes[`/f${i}`] = [200, {}, 'ok'];
    const s = await serve(routes);
    const clk = new Clock();
    const logs: string[] = [];
    const f = fetcher(clk, logs);
    for (let i = 0; i < 20; i++) expect((await f.fetch(s.url(`/f${i}`), 't'))?.status).toBe(200);
    const q = reqs(logs);
    expect(q.length).toBe(21);
    expect(q[0]?.gap_s).toBeNull();
    expect(q.slice(1).every((x) => Number(x.gap_s) >= 1)).toBe(true);
    expect(clk.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20);
  });

  it('Crawl-delay của robots được tôn trọng', async () => {
    const s = await serve({
      '/robots.txt': [200, {}, 'User-agent: *\nCrawl-delay: 3\n'],
      '/a': [200, {}, 'ok'],
      '/b': [200, {}, 'ok'],
    });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs);
    await f.fetch(s.url('/a'), 't');
    await f.fetch(s.url('/b'), 't');
    const gaps = reqs(logs)
      .slice(1)
      .map((q) => Number(q.gap_s));
    expect(gaps.length).toBe(2);
    expect(gaps.every((g) => g >= 3)).toBe(true);
  });

  it('User-Agent có danh tính, không tiêm header', async () => {
    const s = await serve({ '/robots.txt': ROBOTS_OK, '/a': [200, {}, 'ok'] });
    await fetcher(new Clock(), []).fetch(s.url('/a'), 't');
    expect(s.uas.length).toBe(2);
    expect(s.uas.every((ua) => ua.includes('samsam-intel') && ua.includes('mailto:'))).toBe(true);
    expect(userAgent({ INTEL_CONTACT: 'x\r\nInjected: 1' })).not.toContain('Injected');
    expect(userAgent({ INTEL_CONTACT: 'ops@samsam.vn' })).toBe(
      'samsam-intel/0.1 (+mailto:ops@samsam.vn)',
    );
  });

  it('ngân sách TỔNG tính cả robots', async () => {
    const s = await serve({
      '/robots.txt': ROBOTS_OK,
      '/f1': [200, {}, '1'],
      '/f2': [200, {}, '2'],
      '/f3': [200, {}, '3'],
    });
    const f = fetcher(new Clock(), [], { budget: 3 });
    await f.fetch(s.url('/f1'), 't');
    await f.fetch(s.url('/f2'), 't');
    await expect(f.fetch(s.url('/f3'), 't')).rejects.toBeInstanceOf(BudgetExhausted);
    expect(s.hits.length).toBe(3);
  });

  it('Location redirect hỏng → null, không traceback', async () => {
    // "http://[bad]/x": httpx tự từ chối (RemoteProtocolError → null, không log Location hỏng);
    // "http://a]b/x" / "http://[a/": httpx NHẬN nhưng urljoin ném lỗi → bắt ở _get.
    const s = await serve({
      '/robots.txt': ROBOTS_OK,
      '/r1': [302, { Location: 'http://[bad]/x' }, ''],
      '/r2': [302, { Location: 'http://a]b/x' }, ''],
      '/r3': [301, { Location: 'http://[a/' }, ''],
    });
    const logs: string[] = [];
    const f = fetcher(new Clock(), logs);
    for (const p of ['/r1', '/r2', '/r3']) expect(await f.fetch(s.url(p), 't')).toBeNull();
    expect(s.hits).toEqual(['/robots.txt', '/r1', '/r2', '/r3']);
    expect(logs.filter((l) => l.includes('redirect Location hỏng')).length).toBe(2);
  });

  it('server nhỏ giọt → timeout tổng 30 s (đồng hồ giả)', async () => {
    const s = await serve({
      '/robots.txt': ROBOTS_OK,
      '/drip': (_q, res) => {
        res.writeHead(200);
        for (let i = 0; i < 5; i++) res.write(Buffer.alloc(70_000, 0x78));
        res.end();
      },
    });
    const clk = new Clock();
    const step = { clock: () => (clk.now += 20) };
    const logs: string[] = [];
    const f = fetcher(clk, logs, { clock: step.clock });
    const r = await f.fetch(s.url('/drip'), 't');
    expect(r?.status).toBe('timeout');
    expect(r?.body).toBeNull();
    const st = Object.fromEntries(reqs(logs).map((q) => [String(q.url).split('/').pop(), q]));
    expect(st['robots.txt']?.status).toBe(200);
    expect(st.drip?.status).toBe('timeout');
    expect(Number(st.drip?.bytes)).toBeGreaterThan(0);
    expect(Number(st.drip?.bytes)).toBeLessThan(350_000);
  });
});

// ---------------------------------------------------------------- parse + lọc (W70.3)

describe('parse feed + làm sạch + phân loại', () => {
  it('RSS mẫu', () => {
    const es = parseFeed(RSS);
    expect(es.length).toBe(4);
    expect(es[0]?.title).toBe('Sâm Ngọc Linh giả bị thu giữ tại Quảng Nam');
    expect(es[0]?.link.startsWith('https://bao.example.vn/bai/sam-gia/')).toBe(true);
    expect(pyStr(parseDate(es[0]?.published) as never)).toBe('2026-10-12 08:00:00+07:00');
    expect(parseDate(es[2]?.published)).toBeNull();
    expect(parseDate(es[3]?.published)).toBeNull();
  });

  it('encoding khai báo: golden Python (expat + codec 1 byte qua Python, tên chuẩn hóa như Python)', () => {
    type R = { ok?: string[]; err?: string };
    const G = JSON.parse(readFileSync(new URL('encodings.golden.json', FIX), 'utf8')) as {
      names: Record<string, { hi: string; ascii: R; bad: R; vi_utf8: R }>;
      bad_names: Record<string, R>;
      bom: Record<string, R>;
    };
    const feed = (name: string, title: Buffer) =>
      Buffer.concat([
        Buffer.from(`<?xml version="1.0" encoding="${name}"?><rss><channel><item><title>`),
        title,
        Buffer.from('</title></item></channel></rss>'),
      ]);
    const res = (doc: Buffer): R => {
      try {
        return { ok: parse(doc).map((e) => e.title) };
      } catch (e) {
        if (!(e instanceof FeedError)) throw e;
        return { err: e.message };
      }
    };
    // shortcut có chủ đích: cột lỗi byte hỏng của UTF-8 dựng sẵn (TS = 0) và cột khi có BOM.
    const noCol = (r: R): R => (r.err ? { err: r.err.replace(/column \d+/, 'column ?') } : r);
    expect(Object.keys(G.names).length).toBeGreaterThan(70);
    for (const [name, g] of Object.entries(G.names)) {
      const hi = Array.from({ length: 128 }, (_, i) => {
        const r = res(feed(name, Buffer.from([0x61, 0x80 + i])));
        return r.ok ? (r.ok[0] as string).slice(1) : '\ufffd';
      }).join('');
      expect([name, hi]).toEqual([name, g.hi]);
      const fix = name.toLowerCase() === 'utf-8' ? noCol : (r: R) => r;
      expect([name, res(feed(name, Buffer.from('Sam')))]).toEqual([name, g.ascii]);
      expect([name, fix(res(feed(name, Buffer.from([0x61, 0x62, 0x81, 0x63]))))]).toEqual([
        name,
        fix(g.bad),
      ]);
      expect([name, fix(res(feed(name, Buffer.from('sâm'))))]).toEqual([name, fix(g.vi_utf8)]);
    }
    for (const [name, g] of Object.entries(G.bad_names)) {
      expect([name, res(feed(name, Buffer.from('Sam')))]).toEqual([name, g]);
    }
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const [name, g] of Object.entries(G.bom)) {
      const doc = Buffer.concat([bom, feed(name, Buffer.from([0x53, 0xe2, 0x6d]))]);
      expect([name, noCol(res(doc))]).toEqual([name, noCol(g)]);
    }
  });

  it('Atom mẫu: summary ưu tiên hơn content, naive → giờ VN', () => {
    const es = parseFeed(ATOM);
    expect(es.length).toBe(2);
    expect(es[0]?.link).toBe('https://nganh.example.org/tin/tra-sua');
    expect(es[0]?.desc).not.toContain('Toàn văn');
    expect(es[1]?.link).toBe('https://nganh.example.org/tin/nhan-sam');
    expect(es[1]?.desc).toContain('KGC');
    expect(parseDate(es[1]?.published)?.offUs).toBe(7 * 3600 * 1_000_000);
    expect(pyStr(parseDate(es[0]?.published) as never)).toBe('2026-10-10 07:00:00+00:00');
  });

  it('trích ≤300 ký tự + che SĐT/email, giữ giá', () => {
    const long = 'Thông tin thị trường sâm. '.repeat(200);
    expect(long.length).toBeGreaterThan(5000);
    expect([...cleanText(long)].length).toBeLessThanOrEqual(300);
    const s = cleanText(
      '<p>Liên hệ 0905 123 456 hoặc a.b@gmail.com — lô hàng 10.050.000.000 đồng</p>',
    );
    expect(s).not.toContain('0905 123 456');
    expect(s).not.toContain('a.b@gmail.com');
    expect(s).toContain('10.050.000.000');
    expect(cleanText(`a${String.fromCharCode(0x2028)}b\x00c${String.fromCharCode(0x202e)}d`)).toBe(
      'a b c d',
    );
    // Mép cắt PRE_MAX rơi giữa SĐT: không lọt đuôi số dở.
    const edge = `${'x '.repeat(Math.floor((PRE_MAX - 6) / 2))}0905 123 456`;
    expect(cleanText(edge, 2000)).not.toContain('0905');
  });

  it('DOCTYPE/ENTITY bị từ chối (chặn entity expansion)', () => {
    const bomb = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><rss><channel><item><title>&b;</title></item></channel></rss>',
    );
    const logs: string[] = [];
    expect(parseFeed(bomb, (s) => logs.push(s))).toEqual([]);
    expect(logs[0]).toContain('DOCTYPE');
    expect(
      parseFeed(Buffer.from(bomb.toString().replace('DOCTYPE', 'doctype')), (s) => logs.push(s)),
    ).toEqual([]);
  });

  it('XML hỏng / UTF-16 / encoding lạ → [warn], không chết lượt', () => {
    const logs: string[] = [];
    const log = (s: string) => logs.push(s);
    expect(parseFeed(Buffer.from('<rss><channel><item>'), log)).toEqual([]);
    expect(logs[0]?.startsWith('[warn]')).toBe(true);
    expect(
      parseFeed(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<rss/>', 'utf16le')]), log),
    ).toEqual([]);
    expect(parseFeed(Buffer.from('<?xml version="1.0" encoding="bogus"?><rss/>'), log)).toEqual([]);
  });

  it('tối đa 200 tin/feed', () => {
    const items = Array.from({ length: 300 }, (_, i) => `<item><title>t${i}</title></item>`).join(
      '',
    );
    expect(parseFeed(Buffer.from(`<rss><channel>${items}</channel></rss>`)).length).toBe(
      MAX_ENTRIES,
    );
  });

  it.each([
    ['Sâm Ngọc Linh giả bị thu giữ', ['sam']],
    ['sam ngoc linh gia re', ['sam']],
    ['Săm lốp xe máy tăng giá', []],
    ['Cục ATTP xử phạt quảng cáo TPBVSK', ['quang_cao', 'tpbvsk']],
    ['Trà sữa hút giới trẻ', ['gioi_tre']],
  ] as [string, string[]][])('chủ đề %j', (t, want) => {
    expect(classify(t, '', TOPICS)[0]).toEqual(want);
  });

  it('cờ rượu / sức khỏe', () => {
    expect(classify('rượu sâm 40 độ', '', TOPICS)[1]).toContain('ruou');
    expect(classify('Sâm và bệnh ung thư', '', TOPICS)[1]).toContain('suc_khoe');
    expect(classify('Sâm Ngọc Linh giả', '', TOPICS)[1]).toEqual([]);
  });

  describe('bộ lọc rượu hỏng → fail-closed', () => {
    beforeAll(() => {
      const empty = join(TMP, `ruou_${process.pid}.txt`);
      writeFileSync(empty, '# chỉ comment\n');
      setKbFiles({ keywords: empty });
    });
    afterAll(() => {
      setKbFiles({ keywords: dataPath('ruou_keywords.txt') });
      resetCache();
    });
    it('classify ném KbFilterError', () => {
      expect(() => classify('rượu sâm', '', TOPICS)).toThrow(KbFilterError);
    });
    it('CLI exit 1 TRƯỚC khi kết nối DB / ra mạng', async () => {
      const opened: string[] = [];
      const spy = spyTransport();
      const rc = await intelMain(
        { run: true, source: ['vnexpress-suc-khoe'] },
        {
          env: {},
          log: () => {},
          err: () => {},
          open: async () => {
            opened.push('x');
            throw new Error('không được gọi');
          },
          fetcher: { transport: spy },
        },
      );
      expect(rc).toBe(1);
      expect(opened).toEqual([]);
      expect(spy.hosts).toEqual([]);
    });
  });

  it('tin ngoài chủ đề + link tương đối', () => {
    const [items, off] = buildItems(
      parseFeed(RSS),
      { id: 's', tier: 'A' },
      'https://bao.example.vn/rss',
      TOPICS,
    );
    expect(off).toBe(1);
    expect(items.length).toBe(3);
    expect(items[0]?.url).toBe('https://bao.example.vn/bai/sam-gia');
    expect(items[2]?.url).toBe('https://bao.example.vn/bai/ruou-sam');
    expect(items[2]?.flags).toEqual(['ruou']);
    for (const it of items) {
      expect([...it.title].length).toBeLessThanOrEqual(300);
      expect([...(it.snippet ?? '')].length).toBeLessThanOrEqual(300);
    }
  });

  it('link ngoặc hỏng chỉ bỏ entry đó', () => {
    const feed = Buffer.from(
      "<rss version='2.0'><channel><title>t</title>" +
        '<item><title>Sâm Ngọc Linh link hỏng 1</title><link>http://[::1</link></item>' +
        '<item><title>Sâm Ngọc Linh link hỏng 2</title><link>http://[bad]/x</link></item>' +
        '<item><title>Sâm Ngọc Linh link hỏng 3</title><link>//[x]/</link></item>' +
        '<item><title>Sâm Ngọc Linh tin hợp lệ</title><link>/bai/hop-le</link></item>' +
        '</channel></rss>',
    );
    const es = parseFeed(feed);
    expect(es.length).toBe(4);
    const [items, off] = buildItems(
      es,
      { id: 's', tier: 'A' },
      'https://bao.example.vn/rss',
      TOPICS,
    );
    expect(off).toBe(0);
    expect(items.map((i) => i.url)).toEqual(['https://bao.example.vn/bai/hop-le']);
  });

  it('pubDate tràn số không giết lượt', () => {
    const feed = Buffer.from(
      "<?xml version='1.0' encoding='utf-8'?><rss version='2.0'><channel><title>t</title>" +
        '<item><title>Sâm Ngọc Linh ngày độc</title><link>/bai/ngay-doc</link>' +
        '<pubDate>Fri, 31 Dec 2147483648 23:00:00 +0000</pubDate></item>' +
        '<item><title>Sâm Ngọc Linh tin hợp lệ</title><link>/bai/hop-le</link>' +
        '<pubDate>Mon, 12 Oct 2026 08:00:00 +0700</pubDate></item></channel></rss>',
    );
    const [items, off] = buildItems(
      parseFeed(feed),
      { id: 's', tier: 'A' },
      'https://bao.example.vn/rss',
      TOPICS,
    );
    expect(off).toBe(0);
    expect(items.map((i) => i.url)).toEqual([
      'https://bao.example.vn/bai/ngay-doc',
      'https://bao.example.vn/bai/hop-le',
    ]);
    expect(items[0]?.published_at).toBeNull();
    expect(pyStr(items[1]?.published_at as never)).toBe('2026-10-12 08:00:00+07:00');
  });
});

// ---------------------------------------------------------------- URL + schema (W70.4)

describe('chuẩn hóa URL + schema', () => {
  it('normalize_url', () => {
    expect(normalizeUrl('HTTPS://Bao.VN:443/a/?utm_source=x&b=2&a=1#c')).toBe(
      'https://bao.vn/a?a=1&b=2',
    );
    expect(normalizeUrl('http://u:p@bao.vn:8080/?fbclid=1&gclid=2&zarsrc=3')).toBe(
      'http://bao.vn:8080/',
    );
    expect(normalizeUrl('https://bao.vn')).toBe('https://bao.vn/');
  });

  it('bảng intel_items không có cột toàn văn', () => {
    const sql = readFileSync(repoPath('docs', 'schema.sql'), 'utf8');
    const block = sql.split('v7.0 intel collector')[1] ?? '';
    expect(block).toContain('create table if not exists intel_items');
    expect(/\b(body|content|html|raw_text)\b +text/i.test(block)).toBe(false);
  });
});

// ---------------------------------------------------------------- PC-A8 (tests/test_pc_a8.py)

describe('PC-A8 nguồn văn bản pháp luật qua collector chung', () => {
  const RULES = JSON.parse(readFileSync(dataPath('intel_alert_rules.json'), 'utf8')) as {
    legal_sources: string[];
    status: string;
    _doc: string;
  };
  const LEGAL = RULES.legal_sources;

  it('nguồn thật ↔ luật legal_sources khớp hai chiều; cụm phap_ly không có "luật" trần', () => {
    const [cfg, errs] = loadSources(dataPath('intel_sources.json'));
    expect(errs).toEqual([]);
    if (cfg === null) throw new Error('cfg null');
    const byId = new Map(cfg.sources.map((s) => [s.id, s]));
    expect(LEGAL.length).toBeGreaterThanOrEqual(3);
    for (const sid of LEGAL) {
      // luật → nguồn: tồn tại, tầng A, chờ Pháp chế duyệt
      const s = byId.get(sid);
      expect(s?.tier).toBe('A');
      expect(s?.status).toBe('cho_duyet');
      expect(s?.kind).toBe('rss');
      expect(String(s?.note)).toContain('Pháp chế duyệt nguồn');
      expect(s?.topics_hint).toContain('phap_ly');
    }
    // nguồn → luật: mọi nguồn gợi ý phap_ly đều nằm trong legal_sources.
    expect(
      new Set(
        cfg.sources
          .filter((s) => Array.isArray(s.topics_hint) && s.topics_hint.includes('phap_ly'))
          .map((s) => s.id),
      ),
    ).toEqual(new Set(LEGAL));
    const ph = cfg.topics.phap_ly as string[];
    for (const p of [
      'nghị định',
      'thông tư',
      'dự thảo',
      'văn bản hợp nhất',
      'quyết định số',
      'luật an toàn thực phẩm',
      'luật quảng cáo',
      'tác hại của rượu, bia',
    ]) {
      expect(ph).toContain(p);
    }
    expect(ph).not.toContain('luật');
    expect(String(cfg._doc)).toContain('PC-A8');
    expect(RULES._doc).toContain('legal_doc');
    expect(RULES.status).toBe('gia_dinh');
  });

  it('chủ đề phap_ly', () => {
    expect(classify('Dự thảo nghị định về quảng cáo', '', TOPICS)[0]).toContain('phap_ly');
    expect(classify('Luật sư tư vấn ly hôn', '', TOPICS)[0]).not.toContain('phap_ly');
  });

  it('--source tầng C → [blocked] tier_c, exit 2, 0 request, 0 kết nối', async () => {
    const mock = mockTransport({});
    const out: string[] = [];
    const opened: string[] = [];
    const rc = await intelMain(
      { run: true, source: ['c-shopee'] },
      {
        env: {},
        log: (s) => out.push(s),
        err: (s) => out.push(s),
        open: async () => {
          opened.push('x');
          throw new Error('down');
        },
        fetcher: { transport: mock },
      },
    );
    expect(rc).toBe(2);
    expect(mock.reqs).toEqual([]);
    expect(opened).toEqual([]);
    expect(out.join('\n')).toContain('"reason": "tier_c"');
  });
});

// ---------------------------------------------------------------- CLI không DB (W70.5)

describe('CLI — lỗi tham số/cấu hình/kết nối dừng TRƯỚC mạng', () => {
  const noConnect = () => {
    const opened: string[] = [];
    return {
      opened,
      spy: spyTransport(),
      open: async () => {
        opened.push('x');
        throw new Error('down');
      },
    };
  };
  it.each([
    [{ run: true, report: true }],
    [{}],
    [{ run: true, maxRequests: '0' }],
    [{ run: true, maxRequests: '201' }],
    [{ run: true, maxRequests: 'abc' }],
    [{ run: true, source: ['khong-co'] }],
    [{ run: true, source: ['c-shopee'] }],
    [{ run: true, source: ['c-linkedin'] }],
    [{ report: true, source: ['vnexpress-suc-khoe'] }],
    [{ report: true, llm: true }],
  ])('%j → exit 2, 0 kết nối, 0 request', async (o) => {
    const n = noConnect();
    const out: string[] = [];
    const rc = await intelMain(o, {
      env: {},
      log: (s) => out.push(s),
      err: () => {},
      open: n.open,
      fetcher: { transport: n.spy },
    });
    expect(rc).toBe(2);
    expect(n.opened).toEqual([]);
    expect(n.spy.hosts).toEqual([]);
    if ((o as IntelOpts).source?.[0] === 'c-shopee') expect(out.join('\n')).toContain('[blocked]');
  });

  it('file nguồn hỏng → exit 1 trước kết nối', async () => {
    const n = noConnect();
    const p = join(TMP, `intel_empty_${process.pid}.json`);
    writeFileSync(p, '{}');
    const rc = await intelMain(
      { run: true, sources: p },
      { env: {}, log: () => {}, open: n.open, fetcher: { transport: n.spy } },
    );
    expect(rc).toBe(1);
    expect(n.opened).toEqual([]);
    expect(n.spy.hosts).toEqual([]);
  });

  it('không kết nối được Postgres → exit 1, 0 request mạng', async () => {
    const { createPool } = await import('@samsam/core/db');
    const spy = spyTransport();
    const out: string[] = [];
    const rc = await intelMain(
      { run: true, source: ['vnexpress-suc-khoe'] },
      {
        env: {},
        log: (s) => out.push(s),
        open: async () =>
          createPool(
            'postgresql://u:p@127.0.0.1:9/khong_co',
            { connectionTimeoutMillis: 2000 },
            {},
          ),
        fetcher: { transport: spy },
      },
    );
    expect(rc).toBe(1);
    expect(out.join('\n')).toContain('không kết nối được Postgres');
    expect(spy.hosts).toEqual([]);
  });

  it('thiếu DSN → exit 1', async () => {
    const out: string[] = [];
    const rc = await intelMain({ report: true }, { env: {}, log: (s) => out.push(s) });
    expect(rc).toBe(1);
    expect(out.join('\n')).toMatch(/DATABASE_URL/);
  });
});

// ---------------------------------------------------------------- guardrail LLM + ranh giới ghi (W70.6/7)

describe('ranh giới: không đường tới hàng duyệt nội dung / đăng / gửi', () => {
  const dir = new URL('./', import.meta.url);
  const SRC = [
    'intel.ts',
    'intel-crawl.command.ts',
    'feed-xml.ts',
    'html-soup.ts',
    'robots.ts',
    // helper urllib/datetime dùng chung đã chuyển lên core — vẫn quét như phần của collector
    '../../../../../packages/core/src/ops/py-url.ts',
    '../../../../../packages/core/src/ops/py-date.ts',
  ]
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n');
  it('không nhắc content_drafts / store / content / connectors', () => {
    // ('zalo.me' nằm trong HARD_BLOCK — chỉ cấm import module kênh gửi, như Python `connectors\.`)
    expect(
      /content_drafts|ops\/store|modules\/content|saveDraft|connectors\/|modules\/(?:zalo|messenger)/i.test(
        SRC,
      ),
    ).toBe(false);
  });
  it('chỉ ghi bảng intel_items', () => {
    const writes = [...SRC.matchAll(/(?:insert into|update|delete from) +([a-z_]+)/gi)].map(
      (m) => m[1],
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes)).toEqual(new Set(['intel_items']));
  });
  it('import: không có store/content/approval-queue; LLM chỉ qua AI Gateway của core', () => {
    const imports = [...SRC.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(
      imports.some((m) =>
        /approval-queue|ops\/store|ops\/director|content|openai|anthropic/.test(m as string),
      ),
    ).toBe(false);
    expect(imports).toContain('@samsam/core/ai/gateway');
  });
  it('guardrail chạy trên chuỗi ĐÃ làm sạch (entity được giải mã trước)', () => {
    const reply = 'Tin tức sâm: &#99;hữa bệnh';
    expect(guardrailCheck(reply).ok).toBe(true); // tiền đề: thô thì lọt
    expect(guardrailCheck(cleanText(reply)).ok).not.toBe(true);
  });
});

// ---------------------------------------------------------------- review đối kháng (r3)

describe('feed độc: lồng sâu / nhiều thuộc tính — không chết lượt, tuyến tính (khớp Python)', () => {
  // Số kỳ vọng sinh bằng crawler/intel.py thật (expat/bs4 không đệ quy): `_parse(deep)`,
  // `clean_text('<i>'*6000 + ...)`, `_parse(80k thuộc tính)` = [] trong ~0,1 s.
  const N = 50_000;
  const deepXml = Buffer.concat([
    Buffer.from('<rss><channel><item><title>'),
    Buffer.from('<a>'.repeat(N)),
    Buffer.from('Sâm ngọc linh'),
    Buffer.from('</a>'.repeat(N)),
    Buffer.from(
      '</title><link>http://a.vn/x</link><description>d</description></item></channel></rss>',
    ),
  ]);
  const deepDesc = `${'<i>'.repeat(6000)}sâm ngọc linh tăng giá`;

  it('XML lồng 50k phần tử → parse được, itertext đúng (Python: 0,06 s)', () => {
    const t = performance.now();
    expect(parse(deepXml)).toEqual([
      { title: 'Sâm ngọc linh', link: 'http://a.vn/x', desc: 'd', published: '' },
    ]);
    expect(performance.now() - t).toBeLessThan(5_000);
  });

  it('HTML lồng 6000 thẻ trong description → cleanText như Python', () => {
    expect(cleanText(deepDesc)).toBe('sâm ngọc linh tăng giá');
    expect(cleanText(`${'<i> '.repeat(4900)}nhân sâm`)).toBe('nhân sâm');
    // collect dùng stripHtml trên cả trang (không trần RAW_MAX): 50k thẻ lồng vẫn chạy.
    expect(stripHtml(`${'<i>'.repeat(50_000)}x${'</i>'.repeat(50_000)}`)).toBe('x');
  });

  it('80k thuộc tính (~870 KB < MAX_BYTES) → parse tuyến tính; trùng thuộc tính = lỗi như expat', () => {
    const attrs = Array.from({ length: 80_000 }, (_, i) => `a${i}="1"`).join(' ');
    const t = performance.now();
    expect(parse(Buffer.from(`<rss ${attrs}><channel></channel></rss>`))).toEqual([]);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(() => parse(Buffer.from('<rss a="1" b="2" a="3"><channel/></rss>'))).toThrow(
      'XML hỏng (duplicate attribute: line 1, column 17)',
    );
  });

  it('50k phần tử lồng có khai báo xmlns ở gốc → tra namespace không O(độ sâu)', () => {
    const doc = `<rss xmlns:x="urn:x"><channel>${'<x:a>'.repeat(N)}${'</x:a>'.repeat(N)}</channel></rss>`;
    const t = performance.now();
    expect(parse(Buffer.from(doc))).toEqual([]);
    expect(performance.now() - t).toBeLessThan(5_000);
  });

  it('run(): nguồn a có feed lồng sâu vẫn lưu, nguồn b sau đó vẫn được thu (Python: ok=2 new=2)', async () => {
    const feedA = Buffer.concat([
      Buffer.from('<rss><channel><item><title>'),
      Buffer.from('<a>'.repeat(N)),
      Buffer.from('Sâm ngọc linh lên giá'),
      Buffer.from('</a>'.repeat(N)),
      Buffer.from(
        `</title><link>http://a.vn/x</link><description><![CDATA[${deepDesc}]]></description></item></channel></rss>`,
      ),
    ]);
    const feedB =
      '<rss><channel><item><title>Nhân sâm Hàn Quốc</title><link>http://b.vn/y</link>' +
      '<description>tin b</description></item></channel></rss>';
    const t = mockTransport({
      'a.vn/robots.txt': [404, {}, ''],
      'a.vn/feed': [200, {}, feedA],
      'b.vn/robots.txt': [404, {}, ''],
      'b.vn/feed': [200, {}, feedB],
    });
    const clk = new Clock();
    const logs: string[] = [];
    const f = new Fetcher({
      transport: t,
      sleep: clk.sleep,
      clock: clk.clock,
      log: (s) => logs.push(s),
      env: {},
    });
    const saved: unknown[][] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('insert')) saved.push(params ?? []);
        return { rows: [], rowCount: sql.startsWith('insert') ? 1 : 0 };
      },
    } as unknown as Parameters<typeof run>[0];
    const src = (id: string, host: string) => ({
      id,
      tier: 'A',
      url: `http://${host}/feed`,
      kind: 'rss',
      status: 'duyet',
    });
    const cfg = { topics: TOPICS, llm: { enabled: false }, sources: [] };
    const sources = [src('a', 'a.vn'), src('b', 'b.vn')];
    expect(await run(db, cfg, sources, f, null, (s) => logs.push(s))).toBe(0);
    expect(saved.map((p) => [p[2], p[4], p[5]])).toEqual([
      ['a', 'Sâm ngọc linh lên giá', 'sâm ngọc linh tăng giá'],
      ['b', 'Nhân sâm Hàn Quốc', 'tin b'],
    ]);
    expect(logs.at(-1)).toMatch(/^\[done\] sources=2 ok=2 requests=4 new=2 /);
  });
});
