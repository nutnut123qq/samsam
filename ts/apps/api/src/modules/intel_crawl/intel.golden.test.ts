import { readFileSync } from 'node:fs';
import { pyStr } from '@samsam/core/ops/py-date';
import { urljoin } from '@samsam/core/ops/py-url';
import { dataPath } from '@samsam/core/paths';
import { describe, expect, it } from 'vitest';
import buildItemsG from './__fixtures__/build_items.golden.json' with { type: 'json' };
import classifyG from './__fixtures__/classify.golden.json' with { type: 'json' };
import cleanTextG from './__fixtures__/clean_text.golden.json' with { type: 'json' };
import collectG from './__fixtures__/collect.golden.json' with { type: 'json' };
import shaG from './__fixtures__/content_sha.golden.json' with { type: 'json' };
import datesG from './__fixtures__/dates.golden.json' with { type: 'json' };
import feedsG from './__fixtures__/feeds.golden.json' with { type: 'json' };
import hostsG from './__fixtures__/hosts.golden.json' with { type: 'json' };
import robotsG from './__fixtures__/robots.golden.json' with { type: 'json' };
import stripG from './__fixtures__/strip_html.golden.json' with { type: 'json' };
import urlG from './__fixtures__/url.golden.json' with { type: 'json' };
import {
  bricksLoc,
  degenerate,
  dumpsRec,
  nvArticle,
  nvId,
  nvPage,
  nvShop,
  type Rec,
  wcProduct,
  wpPost,
} from './collect.js';
import { parseHtml, select, stripHtml } from './html-soup.js';
import {
  buildItems,
  classify,
  cleanText,
  contentSha,
  FeedError,
  isBlocked,
  normalizeUrl,
  normHost,
  parse,
  parseDate,
} from './intel.js';
import { RobotFileParser, splitlines } from './robots.js';

// Golden sinh bằng hàm Python THẬT (crawler/intel.py, crawler/collect.py, urllib, bs4 4.14.2,
// Python 3.12.7) — script tạm ở scratchpad, không nằm trong repo. TS phải ra y hệt.

const NOW = new Date(Date.UTC(2026, 9, 12));
const TOPICS = JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8')).topics as Record<
  string,
  string[]
>;

type Res = { ok?: unknown; err?: string };
function attempt(fn: () => unknown): Res {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).name };
  }
}
// Python ValueError ↔ TS RangeError con (UrlError tên 'ValueError').
const errKind = (r: Res) => (r.err === undefined ? r : { err: 'error' });

describe('golden url (urllib.parse)', () => {
  it.each(urlG.normalize as [string, Res][])('normalize_url %j', (u, want) => {
    expect(errKind(attempt(() => normalizeUrl(u)))).toEqual(errKind(want));
  });
  it.each(urlG.join as [string, string, Res][])('urljoin %j + %j', (b, r, want) => {
    expect(errKind(attempt(() => urljoin(b, r)))).toEqual(errKind(want));
  });
});

describe('golden chặn host', () => {
  it.each(hostsG as [string, string, boolean, boolean][])('%j', (h, norm, hard, withC) => {
    expect(normHost(h)).toBe(norm);
    expect(isBlocked(h)).toBe(hard);
    expect(isBlocked(h, ['linkedin.com'])).toBe(withC);
  });
});

describe('golden strip_html (bs4 html.parser)', () => {
  it.each(stripG as [string, Res][])('%j', (h, want) => {
    const got = attempt(() => stripHtml(h));
    if (want.err) expect(got.err).toBe(want.err);
    else expect(got).toEqual(want);
  });
});

describe('golden clean_text (cắt + che PII + bỏ ký tự điều khiển)', () => {
  it.each(cleanTextG as [string | null, Res, Res][])('%#', (t, w300, w2000) => {
    expect(attempt(() => cleanText(t))).toEqual(w300);
    expect(attempt(() => cleanText(t, 2000))).toEqual(w2000);
  });
});

describe('golden parse_date (email.utils + fromisoformat C)', () => {
  it.each(datesG as [string, string | null][])('%j', (s, want) => {
    const d = parseDate(s, NOW);
    expect(d === null ? null : pyStr(d)).toBe(want);
  });
});

describe('golden feed RSS/Atom (ElementTree)', () => {
  it.each(
    feedsG.map((x, i) => [i, ...x]) as unknown as [number, string, Record<string, unknown>][],
  )('feed #%i', (_i, b64, want) => {
    const data = Buffer.from(b64, 'base64');
    let got: Record<string, unknown>;
    try {
      got = { ok: parse(data) };
    } catch (e) {
      if (!(e instanceof FeedError)) throw e;
      got = {
        err: 'FeedError',
        doctype: e.message.includes('DOCTYPE'),
        msg_head: e.message.split(' (')[0],
      };
    }
    expect(got).toEqual(want);
  });
});

describe('golden classify', () => {
  it.each(classifyG as [string, [string[], string[]]][])('%j', (t, want) => {
    expect(classify(t, '', TOPICS)).toEqual(want);
  });
});

describe('golden build_items', () => {
  it.each(
    buildItemsG.map((x, i) => [i, ...x]) as unknown as [
      number,
      string,
      { off: number; items: Rec[] },
    ][],
  )('feed #%i', (_i, b64, want) => {
    const [items, off] = buildItems(
      parse(Buffer.from(b64, 'base64')),
      { id: 's', tier: 'A' },
      'https://bao.example.vn/rss',
      TOPICS,
      NOW,
    );
    // parse_date của Python dùng now() thật — fixture chỉ có ngày ≤ 2026-10-12 nên cửa sổ khớp.
    expect({
      off,
      items: items.map((i) => ({
        ...i,
        published_at: i.published_at ? pyStr(i.published_at) : null,
      })),
    }).toEqual(want);
  });
});

describe('golden content_sha', () => {
  it.each(shaG as [string, string, string][])('%j %j', (a, b, want) => {
    expect(contentSha(a, b)).toBe(want);
  });
});

describe('golden robots.txt (urllib.robotparser)', () => {
  it.each(robotsG as [string, number | null, [string, boolean][]][])('%j', (txt, delay, paths) => {
    const rp = new RobotFileParser();
    rp.parse(splitlines(txt));
    expect(rp.crawlDelay('samsam-intel')).toBe(delay);
    for (const [p, ok] of paths) expect([p, rp.canFetch('samsam-intel', p)]).toEqual([p, ok]);
  });
});

describe('golden collect (parser WooCommerce/WP/NukeViet/Bricks)', () => {
  const G = collectG as unknown as {
    wc: [unknown, { ok?: Rec; err?: string; degenerate?: boolean }][];
    wp: [unknown, { ok?: Rec; err?: string; degenerate?: boolean }][];
    nv: [string, string, { ok?: Rec; err?: string; degenerate?: boolean }][];
    bricks_html: string;
    bricks: Rec[];
    bricks_selected: number;
    nv_ids: [string, string][];
    dumps: string[];
  };
  const norm = (r: Rec) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
    );
  const run = (kind: string, fn: () => Rec) => {
    try {
      const rec = fn();
      return { ok: norm(rec), degenerate: degenerate(kind, rec) };
    } catch {
      return { err: 'error' };
    }
  };
  const wantOf = (w: { ok?: Rec; err?: string; degenerate?: boolean }) =>
    w.err ? { err: 'error' } : w;

  it.each(G.wc.map((x, i) => [i, ...x]))('wc_product #%i', (_i, item, want) => {
    expect(run('wc_product', () => wcProduct(item))).toEqual(wantOf(want));
  });
  it.each(G.wp.map((x, i) => [i, ...x]))('wp_post #%i', (_i, item, want) => {
    expect(run('wp_post', () => wpPost(item))).toEqual(wantOf(want));
  });
  const NV = { nv_article: nvArticle, nv_page: nvPage, nv_shop: nvShop } as Record<
    string,
    (s: ReturnType<typeof parseHtml>, u: string) => Rec
  >;
  const URLS = [
    'http://samsam.net.vn/vi/news/tin-tuc/bai-viet-1.html',
    'http://samsam.net.vn/vi/news/tin-tuc/bai-viet-1.html',
    'http://samsam.net.vn/vi/news/tin-tuc/bai-viet-1.html',
    'http://samsam.net.vn/vi/news/tin-tuc/bai-viet-1.html',
    'http://samsam.net.vn/vi/shops/sam/sam-cu.html',
    'http://samsam.net.vn/vi/shops/x',
    'http://samsam.net.vn/vi/shops/y.html',
  ];
  it.each(G.nv.map((x, i) => [i, ...x]))('%i %s', (i, kind, html, want) => {
    const fn = NV[kind] as (s: ReturnType<typeof parseHtml>, u: string) => Rec;
    expect(run(kind, () => fn(parseHtml(html), URLS[i] as string))).toEqual(wantOf(want));
  });
  it('bricks_loc + bộ chọn [data-map]', () => {
    const soup = parseHtml(G.bricks_html);
    const lis = select(soup, 'li.brxe-loop-builder-on');
    expect(
      lis.map((li) => bricksLoc(li, 'https://samsamngoclinh.com/he-thong-phan-phoi/')),
    ).toEqual(G.bricks);
    expect(select(soup, 'li.brxe-loop-builder-on[data-map]').length).toBe(G.bricks_selected);
  });
  it('nv_id', () => {
    for (const [u, want] of G.nv_ids) expect(nvId(u)).toBe(want);
  });
  it('json.dumps(ensure_ascii=False) của bản ghi jsonl', () => {
    expect(
      dumpsRec({ id: 'wc-1', name: 'Sâm', price_vnd: 12345678901234567890n, images: ['a', 'b'] }),
    ).toBe(G.dumps[0]);
    expect(
      dumpsRec({
        id: 'x',
        body: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(1, 0x7f)}"q"${String.fromCharCode(92)}`,
        published_at: null,
      }),
    ).toBe(G.dumps[1]);
  });
});
