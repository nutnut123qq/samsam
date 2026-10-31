import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import flowG from './__fixtures__/crawl_flow.golden.json' with { type: 'json' };
import { type CollectDeps, collectMain, crawl, dumpsRec, type HttpGet } from './collect.js';
import type { CrawlSource } from './sources.js';
import { SOURCES } from './sources.js';

// Luồng `crawl()`/`main()` của crawler/collect.py (Python không có test riêng cho collect): golden
// sinh bằng Python THẬT với httpx.MockTransport + time.sleep giả (script ở scratchpad). So y hệt
// bản ghi, dòng log, chuỗi sleep (nhịp ≥1s + backoff 8/16/24 s) và URL đã GET.
//
// Khác biệt CÓ CHỦ ĐÍCH với Python (TS_DIFF):
// - ghi jsonl: Python mở file chế độ text → trên Windows `\n` thành `\r\n`; TS luôn LF (hợp đồng
//   "1 dòng = 1 bản ghi", đúng như Python chạy trên server Linux) → so sau khi đổi CRLF → LF.
// - nguồn `bricks_listing` (playwright): TS không có trình duyệt headless → luôn bỏ qua có cảnh báo
//   y như Python khi thiếu playwright (golden không chạy playwright); `collectMain` GIỮ bản ghi `dist-`
//   đang có trong file output thay vì ghi đè mất (Python thiếu playwright xóa chúng).
// - JSON không phải danh sách: Python chết (AttributeError trong chính dòng warn) — TS cảnh báo và
//   dừng nguồn (đúng ý "lỗi 1 item không làm chết cả job").

type Route = [number, Record<string, string>, string];
type Flow = {
  name: string;
  src: CrawlSource;
  routes: Record<string, Route[]>;
  records: unknown[];
  log: string[];
  sleeps: number[];
  requests: string[];
};
const G = flowG as unknown as {
  flows: Flow[];
  main: {
    sources: CrawlSource[];
    routes: Record<string, Route[]>;
    rc: number;
    files: Record<string, string>;
    log: string[];
    sleeps: number[];
    requests: string[];
  };
};

/** HTTP giả: theo redirect như `fetch` (redirect: 'follow'), route nhiều phản hồi → lần lượt. */
function fakeHttp(routes: Record<string, Route[]>) {
  const seq = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const requests: string[] = [];
  const http: HttpGet = async (url0) => {
    let url = url0;
    for (let hop = 0; hop <= 20; hop++) {
      requests.push(url);
      const list = seq[url];
      const [status, hdrs, body] = list
        ? ((list.length > 1 ? list.shift() : list[0]) as Route)
        : ([404, {}, 'not found'] as Route);
      const headers = new Headers(hdrs);
      const loc = headers.get('location');
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        url = new URL(loc, url).href;
        continue;
      }
      return { status, headers, body: new Uint8Array(Buffer.from(body, 'utf8')), url };
    }
    throw new Error('Exceeded maximum allowed redirects.');
  };
  return { http, requests };
}

function deps(routes: Record<string, Route[]>) {
  const log: string[] = [];
  const sleeps: number[] = [];
  const f = fakeHttp(routes);
  const d: CollectDeps = {
    http: f.http,
    sleep: async (s) => {
      sleeps.push(s);
    },
    log: (s) => log.push(...s.split('\n')),
  };
  return { d, log, sleeps, requests: f.requests };
}

/** bigint (giá) → số như json.loads của bản ghi Python. */
const plain = (v: unknown) => JSON.parse(dumpsRec(v));

describe('golden luồng crawl() (wp_api phân trang, sitemap + thử lại, lỗi HTTP)', () => {
  it.each(G.flows.map((f) => [f.name, f] as const))('%s', async (_n, f) => {
    const t = deps(f.routes);
    const recs = await crawl(f.src, t.d);
    expect(plain(recs)).toEqual(f.records);
    expect(t.log).toEqual(f.log);
    expect(t.sleeps).toEqual(f.sleeps);
    expect(t.requests).toEqual(f.requests);
  });

  it('nguồn bricks_listing → cảnh báo thiếu playwright, 0 request (như Python thiếu playwright)', async () => {
    const src = SOURCES.find((s) => s.type === 'bricks_listing') as CrawlSource;
    const t = deps({});
    expect(await crawl(src, t.d)).toEqual([]);
    expect(t.log).toEqual(['[warn] ngoclinh:distributors: thiếu playwright — bỏ qua source']);
    expect(t.requests).toEqual([]);
  });

  it('JSON không phải danh sách → cảnh báo, dừng nguồn (TS_DIFF: Python chết)', async () => {
    const src = SOURCES[1] as CrawlSource;
    const t = deps({ [`${src.url}?per_page=100&page=1`]: [[200, {}, '{"id": 1}']] });
    expect(await crawl(src, t.d)).toEqual([]);
    expect(t.log).toEqual([`[warn] ${src.url} page 1: response không phải danh sách`]);
  });
});

describe('golden main(): gộp output theo file, ghi jsonl', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('ghi đủ file (kể cả 0 bản ghi → file rỗng như Python), log + exit 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'collect_'));
    const t = deps(G.main.routes);
    const rc = await collectMain({ ...t.d, dataDir: dir }, G.main.sources);
    expect(rc).toBe(G.main.rc);
    expect(t.log.map((l) => l.replaceAll(dir, '<DIR>').replaceAll('\\', '/'))).toEqual(G.main.log);
    expect(t.sleeps).toEqual(G.main.sleeps);
    expect(t.requests).toEqual(G.main.requests);
    expect(readdirSync(dir).sort()).toEqual(Object.keys(G.main.files).sort());
    for (const [name, want] of Object.entries(G.main.files)) {
      const got = readFileSync(join(dir, name), 'utf8');
      expect(got.includes('\r')).toBe(false); // TS luôn LF
      expect(got).toBe(want.replaceAll('\r\n', '\n'));
    }
  });
});

describe('nguồn bricks bị bỏ qua KHÔNG xóa bản ghi đang có (review r3)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('articles.jsonl có sẵn 2 bản ghi dist- (Python + playwright, CRLF) → sau collectMain vẫn còn đủ', async () => {
    dir = mkdtempSync(join(tmpdir(), 'collect_'));
    const dist = [
      {
        id: 'dist-dai-ly-a',
        title: 'Đại lý A',
        body: 'Địa chỉ: 1 Lê Lợi. Loại hình: Đại lý. Điện thoại: 0905.',
        url: 'https://samsamngoclinh.com/he-thong-phan-phoi/',
        published_at: null,
      },
      {
        id: 'dist-dai-ly-b',
        title: 'Đại lý B',
        body: 'Địa chỉ: 2 Trần Phú. Loại hình: Cửa hàng. Điện thoại: —.',
        url: 'https://samsamngoclinh.com/he-thong-phan-phoi/',
        published_at: null,
      },
    ];
    const old = { id: 'wp-1', title: 'cũ', body: 'cũ', url: 'u', published_at: null };
    writeFileSync(
      join(dir, 'articles.jsonl'),
      [old, ...dist].map((r) => `${dumpsRec(r)}\r\n`).join(''),
      'utf8',
    );
    const posts = SOURCES.find((s) => s.name === 'ngoclinh:posts') as CrawlSource;
    const bricks = SOURCES.find((s) => s.type === 'bricks_listing') as CrawlSource;
    const post = {
      id: 2,
      title: { rendered: 'Bài mới' },
      content: { rendered: '<p>Nội dung</p>' },
      link: 'https://samsamngoclinh.com/bai-moi/',
      date: '2026-10-01T08:00:00',
    };
    const t = deps({
      [`${posts.url}?per_page=100&page=1`]: [
        [200, { 'X-WP-TotalPages': '1' }, JSON.stringify([post])],
      ],
    });
    expect(await collectMain({ ...t.d, dataDir: dir }, [posts, bricks])).toBe(0);
    const lines = readFileSync(join(dir, 'articles.jsonl'), 'utf8').split('\n').filter(Boolean);
    const got = lines.map((l) => JSON.parse(l) as { id: string });
    expect(got.map((r) => r.id)).toEqual(['wp-2', 'dist-dai-ly-a', 'dist-dai-ly-b']);
    expect(got.slice(1)).toEqual(dist);
    expect(t.log).toContain(
      '[warn] ngoclinh:distributors: giữ 2 bản ghi dist- đang có trong articles.jsonl (chưa crawl lại được)',
    );
    expect(t.log).toContain('[src] ngoclinh:distributors: 2 records');
  });
});
