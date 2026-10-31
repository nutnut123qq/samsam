import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { check } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawResponse, Transport } from '../intel_crawl/intel.js';
import F from './__fixtures__/seo_fix.golden.json' with { type: 'json' };
import G from './__fixtures__/seo_web.golden.json' with { type: 'json' };
import { seoWebMain } from './mkt-koc-ugc-seo.command.js';
import * as sw from './seo-web.js';

// Dịch phần THUẦN + CLI không DB của tests/test_seo_web.py + cổng TẮT (tests/test_r12_dot2.py).
// from-crawl: jsonl tạm, 0 request. fetch: (1) Fetcher GIẢ như golden cũ; (2) `OwnFetcher` THẬT trên
// transport + đồng hồ GIẢ (= `_Net` của Python: MockTransport + clock/sleep) — so khớp từng request,
// thời điểm, giây ngủ, stats/issues/báo cáo với `OwnFetcher` Python chạy cùng route (seo_fix.golden).
// parse HTML so khớp `parse_page` (bs4 html.parser) trên trang mẫu + HTML hỏng/chữ có dấu/thực thể.
// KHÁC Python có chủ đích: dòng crawl có NaN/Infinity (Python json.loads nhận) → `bad` (JSON.parse
// từ chối — chặt hơn, như core `readJson`).

const RULES = sw.loadRules();
const WEB = RULES.web;
const NOW = new Date(Date.UTC(2026, 9, 12, 2, 0)); // 12/10/2026 09:00 giờ VN
const tmp = mkdtempSync(join(tmpdir(), 'seo-web-'));
let n = 0;
const dir = () => {
  const d = join(tmp, `d${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
};

/** Ghi jsonl giống script golden: dòng chuỗi = byte thô ('\xff\xfe' = latin-1), object = JSON. */
function writeCrawl(d: string, crawl: Record<string, unknown[]>): void {
  for (const [name, recs] of Object.entries(crawl)) {
    const lines = recs.map((r) =>
      typeof r === 'string'
        ? Buffer.from(r, r === 'ÿþ' ? 'latin1' : 'utf8')
        : Buffer.from(JSON.stringify(r), 'utf8'),
    );
    const nl = Buffer.from('\n');
    writeFileSync(
      join(d, `${name}.jsonl`),
      Buffer.concat([...lines.flatMap((l) => [l, nl]), Buffer.from('\n  \n')]),
    );
  }
}

class FakeFetcher implements sw.Fetcher {
  used = 0;
  robotsDeny = 0;
  blocked = 0;
  constructor(readonly budget: number) {}
  async fetch(url: string): Promise<{ status: unknown; body: Uint8Array | null } | null> {
    if (!sw.isOwn(sw.host(url), WEB.own_hosts)) {
      this.blocked += 1;
      throw new sw.BlockedDomain(url);
    }
    const sp = (G.special as Record<string, string>)[url];
    if (sp === 'robots') {
      this.robotsDeny += 1;
      return null;
    }
    if (this.used >= this.budget) throw new sw.BudgetExhausted();
    this.used += 1;
    if (sp === 'blocked') {
      this.blocked += 1;
      throw new sw.BlockedDomain(url);
    }
    if (sp === 'error') return null;
    const [st, body] = (G.routes as unknown as Record<string, [number, string | null]>)[url] ?? [
      404,
      '',
    ];
    return { status: st, body: body === null ? null : Buffer.from(body, 'utf8') };
  }
}

/** `_Net` của tests/test_seo_web.py: transport GIẢ + đồng hồ giả (sleep cộng dồn clock); ghi
 * (method, url, host, t) từng request. */
class Net {
  t = 0;
  slept = 0;
  reqs: [string, string, string, number][] = [];
  readonly logs: string[] = [];
  transport: Transport = async (url): Promise<RawResponse> => {
    this.reqs.push(['GET', url.href, url.hostname, this.t]);
    this.t += 0.05; // thời gian xử lý giả
    const routes = F.routes as unknown as Record<string, [number, string, Record<string, string>]>;
    const [st, body, hdr] = routes[url.href] ?? [404, '', {}];
    const bytes = Buffer.from(body, 'latin1');
    return {
      status: st,
      headers: hdr,
      body: (async function* () {
        if (bytes.length) yield bytes;
      })(),
      close: () => {},
    };
  };
  fetcher(budget: number, log: (s: string) => void = (s) => this.logs.push(s)) {
    return sw.ownFetcher(WEB.own_hosts, {
      budget,
      transport: this.transport,
      sleep: async (s) => {
        this.slept += s;
        this.t += s;
      },
      clock: () => this.t,
      log,
    });
  }
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const NL = String.fromCharCode(10);

beforeEach(() => {
  installFakeDeps();
});
afterEach(() => {
  settings.forceMode = null;
  resetOpsDeps();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('seo_web — luật + host (golden Python)', () => {
  it('own_hosts, is_own (evilsamsam/đuôi giả không khớp), hostname/norm_url như urllib', () => {
    expect(WEB.own_hosts).toEqual(['samsam.net.vn', 'samsamngoclinh.com']);
    for (const [h, want] of G.is_own) expect([h, sw.isOwn(h, WEB.own_hosts)]).toEqual([h, want]);
    for (const [u, want] of G.host) expect([u, sw.host(u)]).toEqual([u, want]);
    for (const [u, want] of G.norm) expect([u, sw.normUrl(u as string)]).toEqual([u, want]);
    for (const [u, want] of G.safe_url) expect(sw.safeUrl(u as string)).toBe(want);
  });

  it('load_rules fail-closed khớp Python; own_hosts chuẩn hóa', () => {
    const p = join(tmp, 'r.json');
    for (const c of G.rule_err) {
      writeFileSync(p, c.doc === null ? '{' : JSON.stringify(c.doc));
      expect(() => sw.loadRules(p)).toThrow(sw.SeoRulesError);
      expect(() => sw.loadRules(p)).toThrow((c.err as string).replace('SeoRulesError: ', ''));
    }
    const good = JSON.parse(readFileSync(repoPath('data/seo_rules.json'), 'utf8'));
    good.web.own_hosts = [' SamSam.net.vn. ', 'x.vn'];
    writeFileSync(p, JSON.stringify(good));
    expect(sw.loadRules(p).web.own_hosts).toEqual(G.hosts_norm);
    expect(good._doc).toContain('GIẢ ĐỊNH');
  });
});

describe('seo_web — from-crawl (0 request) + payload (golden Python)', () => {
  it('read_crawl + audit_crawl + báo cáo khớp Python, không trích text vi phạm', async () => {
    const d = dir();
    writeCrawl(d, G.crawl as Record<string, unknown[]>);
    expect(sw.readCrawl(d, WEB.own_hosts)).toEqual([G.records, G.stats]);
    const res = await sw.run({ mode: 'from-crawl', dataDir: d, now: NOW });
    expect({ day: res.day, issues: res.issues, stats: res.stats, text: res.text }).toEqual(G.run);
    expect(JSON.stringify(res.issues)).not.toContain('chữa');
    expect(res.text).not.toContain('Sâm giúp chữa');
    expect(res.text).toContain('chưa kiểm — cần `--fetch`');
    expect(res.text).not.toContain('evilsamsam');
    const p = sw.buildPayload(res.day, 'from-crawl', res.issues);
    expect(p).toBe(G.payload);
    expect(p).not.toContain('chữa');
    expect(p).not.toContain('chua-benh');
    expect(check(p).ok).toBe(true);
    const doc = JSON.parse(p);
    expect(doc.so_van_de).toBe(res.issues.length);
    for (const x of doc.van_de)
      expect(Object.keys(x).sort()).toEqual(['chi_tiet', 'code', 'de_xuat', 'url']);
  });
});

describe('seo_web — fetch (collector GIẢ, golden Python)', () => {
  it.each(Object.entries(G.pages))('parse_page trang %s', (_k, p) => {
    expect(sw.parsePage(p.url, Buffer.from(p.html, 'utf8'), WEB.own_hosts)).toEqual(p.out);
  });

  it.each(G.fetches.map((f) => [f.budget, f]))('fetch_audit ngân sách %s', async (budget, f) => {
    const ff = new FakeFetcher(budget as number);
    const [issues, stats] = await sw.fetchAudit(G.fetch_urls, WEB, ff);
    expect([issues, stats, ff.used]).toEqual([f.issues, f.stats, f.used]);
  });

  it('báo cáo + payload chế độ fetch khớp Python; run(fetch) ghi requests = số lần dùng', async () => {
    const f = G.fetches[0] as (typeof G.fetches)[number];
    expect(sw.render('2026-10-12', 'fetch', f.issues as sw.Issue[], f.stats, WEB)).toBe(
      G.fetch_render,
    );
    expect(sw.buildPayload('2026-10-12', 'fetch', f.issues as sw.Issue[])).toBe(G.fetch_payload);
    const d = dir();
    writeFileSync(
      join(d, 'news.jsonl'),
      `${G.fetch_urls.map((u) => JSON.stringify({ title: 't', body: 'x', url: u })).join('\n')}\n`,
    );
    let made: FakeFetcher | null = null;
    const res = await sw.run({
      mode: 'fetch',
      dataDir: d,
      now: NOW,
      maxRequests: 3,
      fetcherFactory: (b) => (made = new FakeFetcher(b)),
    });
    expect((made as FakeFetcher | null)?.budget).toBe(3);
    expect(res.stats.requests).toBe(3);
    expect(res.stats.het_ngan_sach).toBeGreaterThanOrEqual(1);
  });

  it('chỉ host ngoài → 0 request', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'news.jsonl'),
      '{"title":"e","body":"x","url":"https://evilsamsam.net.vn/e"}\n{"title":"f","body":"x","url":"http://example.com/"}\n',
    );
    const res = await sw.run({
      mode: 'fetch',
      dataDir: d,
      now: NOW,
      fetcherFactory: (b) => new FakeFetcher(b),
    });
    expect(res.stats.requests).toBe(0);
    expect(res.stats.external).toBe(2);
  });

  it('module không có đường ghi website / http client', () => {
    const src = readFileSync(new URL('./seo-web.ts', import.meta.url), 'utf8');
    for (const bad of [
      '.post(',
      '.put(',
      '.patch(',
      '.delete(',
      'fetch(url, {',
      'wp-json',
      'http.request',
    ]) {
      expect(src).not.toContain(bad);
    }
  });
});

describe('seo_web — fetch qua OwnFetcher THẬT (transport giả, golden Python)', () => {
  it.each(F.fetch_runs.map((f) => [f.budget, f]))(
    'test_fetch_get_only_robots_delay_and_html_checks / budget_caps (ngân sách %s)',
    async (budget, f) => {
      const d = dir();
      writeFileSync(join(d, 'articles.jsonl'), F.crawl.map((r) => JSON.stringify(r)).join(NL));
      const net = new Net();
      const res = await sw.run({
        mode: 'fetch',
        dataDir: d,
        now: NOW,
        maxRequests: budget as number,
        fetcherFactory: (n) => net.fetcher(n),
      });
      expect(net.reqs.map(([m, u, h, t]) => [m, u, h, r6(t)])).toEqual(f.reqs);
      expect(r6(net.slept)).toBe(f.slept);
      expect(res.issues).toEqual(f.issues);
      expect(res.stats).toEqual(f.stats);
      expect(res.text).toBe(f.text);
      expect(net.logs.filter((x) => !x.startsWith('[req]'))).toEqual(f.logs);
      // chỉ GET; host ngoài (evilsamsam, redirect evil.example) 0 request; request đầu mỗi origin là robots
      const hosts = net.reqs.map((r) => r[2]);
      expect(hosts).not.toContain('evilsamsam.net.vn');
      expect(hosts).not.toContain('evil.example');
      expect(net.reqs.map((r) => r[1])).not.toContain('https://samsam.net.vn/private/x.html');
      for (const h of new Set(hosts)) {
        const ts = net.reqs.filter((r) => r[2] === h).map((r) => r[3]);
        for (let i = 1; i < ts.length; i++) {
          expect((ts[i] as number) - (ts[i - 1] as number)).toBeGreaterThanOrEqual(1 - 1e-9);
        }
      }
      if (budget === 3) expect(net.reqs.length).toBeLessThanOrEqual(3);
    },
  );

  it.each(Object.entries(F.pages))('parse_page (bs4 html.parser) trang %s', (_k, p) => {
    expect(sw.parsePage(p.url, Buffer.from(p.body_hex, 'hex'), WEB.own_hosts)).toEqual(p.out);
  });

  it('_norm_url/_host như urllib 3.12 (scheme khác, ////, IPv6 zone, NFKC netloc)', () => {
    for (const [u, norm, h] of F.norm as [string, string, string][]) {
      expect([sw.normUrl(u), sw.host(u)]).toEqual([norm, h]);
    }
  });

  it('TS chặt hơn: dòng crawl NaN/Infinity → bad (Python json.loads nhận)', () => {
    const d = dir();
    writeFileSync(
      join(d, 'news.jsonl'),
      `{"title":"t","body":"x","url":"https://samsam.net.vn/n","gia":NaN}${NL}`,
    );
    const [recs, st] = sw.readCrawl(d, WEB.own_hosts);
    expect([recs.length, st.bad]).toEqual([0, 1]);
  });
});

describe('seo_web — CLI', () => {
  function cap() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  }
  const noDb = (calls: number[]) => async () => {
    calls.push(1);
    return null;
  };

  it.each([
    [{ fromCrawl: true, fetch: true }],
    [{ maxRequests: '3' }],
    [{ fetch: true, maxRequests: '0' }],
    [{ fetch: true, maxRequests: 'x' }],
  ])('tham số sai → exit 2 trước connect: %j', async (o) => {
    const calls: number[] = [];
    const c = cap();
    expect(await seoWebMain(o, { io: c.io, connect: noDb(calls) })).toBe(2);
    expect(calls).toEqual([]);
  });

  it('from-crawl ghi seo-web-<ngày VN>.md (UTC 18:30 = 13/10 VN), không --submit → không DB', async () => {
    const d = dir();
    writeCrawl(d, G.crawl as Record<string, unknown[]>);
    const out = join(d, 'rep');
    const calls: number[] = [];
    const c = cap();
    const late = new Date(Date.UTC(2026, 9, 12, 18, 30));
    expect(
      await seoWebMain(
        { outDir: out },
        { io: c.io, dataDir: d, now: () => late, connect: noDb(calls) },
      ),
    ).toBe(0);
    expect(existsSync(join(out, 'seo-web-2026-10-13.md'))).toBe(true);
    expect(c.out.join('\n')).toContain('requests=0');
    expect(calls).toEqual([]);
  });

  it('--submit mà DB down → exit 1 (chưa submit); không vấn đề → skip', async () => {
    const d = dir();
    writeCrawl(d, G.crawl as Record<string, unknown[]>);
    const calls: number[] = [];
    const c = cap();
    const rc = await seoWebMain(
      { submit: true, outDir: join(d, 'rep') },
      { io: c.io, dataDir: d, now: () => NOW, connect: noDb(calls) },
    );
    expect(rc).toBe(1);
    expect(c.err.join('\n')).toContain('chưa submit');
    const e = dir();
    const c2 = cap();
    expect(
      await seoWebMain(
        { submit: true, outDir: join(e, 'rep') },
        { io: c2.io, dataDir: e, now: () => NOW, connect: noDb(calls) },
      ),
    ).toBe(0);
    expect(c2.out.join('\n')).toContain('[skip] không có vấn đề');
    expect(calls).toEqual([1]);
  });

  it('--fetch qua OwnFetcher (transport GIẢ) → báo cáo fetch, requests = số GET; log [blocked] ra stdout', async () => {
    const d = dir();
    writeFileSync(join(d, 'articles.jsonl'), F.crawl.map((r) => JSON.stringify(r)).join(NL));
    const net = new Net();
    const c = cap();
    const out = join(d, 'rep');
    const rc = await seoWebMain(
      { fetch: true, maxRequests: '40', outDir: out },
      {
        io: c.io,
        dataDir: d,
        now: () => NOW,
        fetcherFactory: (b) => net.fetcher(b, c.io.out),
      },
    );
    expect(rc).toBe(0);
    const run = F.fetch_runs[0] as (typeof F.fetch_runs)[number];
    expect(readFileSync(join(out, 'seo-web-2026-10-12.md'), 'utf8')).toBe(run.text);
    expect(c.out.at(-1)).toMatch(
      /^\[done\] .*seo-web-2026-10-12\.md — fetch vấn đề=\d+ requests=7$/,
    );
    expect(c.out).toContain('[blocked] seo_web: host ngoài own_hosts — bỏ');
  });

  it('--fetch mặc định = OwnFetcher thật: chỉ host ngoài → 0 request, vẫn ghi báo cáo', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'news.jsonl'),
      [
        '{"title":"e","body":"x","url":"https://evilsamsam.net.vn/e"}',
        '{"title":"f","body":"x","url":"http://example.com/"}',
        '',
      ].join(NL),
    );
    const c = cap();
    const out = join(d, 'rep');
    expect(
      await seoWebMain({ fetch: true, outDir: out }, { io: c.io, dataDir: d, now: () => NOW }),
    ).toBe(0);
    expect(existsSync(join(out, 'seo-web-2026-10-12.md'))).toBe(true);
    expect(c.out.at(-1)).toContain('fetch vấn đề=0 requests=0');
  });

  it('marketing-06.1 TẮT → [rollout] exit 2, KHÔNG ghi báo cáo/submit', async () => {
    settings.forceMode = 'tat';
    const d = dir();
    const calls: number[] = [];
    const c = cap();
    const rc = await seoWebMain(
      { fromCrawl: true, submit: true, outDir: d },
      { io: c.io, connect: noDb(calls) },
    );
    expect(rc).toBe(2);
    expect(c.out).toHaveLength(1);
    expect(c.out[0]).toMatch(/^\[rollout\] .*marketing-06\.1/);
    expect(readdirSync(d)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
