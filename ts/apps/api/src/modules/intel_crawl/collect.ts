import { readFileSync, writeFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { join } from 'node:path';
import { urljoin } from '@samsam/core/ops/py-url';
import { DATA_DIR } from '@samsam/core/paths';
import { isDigit, pyStr, pyStrip, S } from '@samsam/core/security/py';
import {
  decompose,
  type El,
  find,
  getText,
  parseHtml,
  select,
  selectOne,
  stripHtml,
} from './html-soup.js';
import { CRAWL_DELAY_S, type CrawlSource, SOURCES } from './sources.js';

// Port `crawler/collect.py` — `crawl-collect` (thay `python -m crawler.collect`) → ghi data/*.jsonl.
// Hợp đồng output (mỗi dòng JSONL = 1 bản ghi):
//   products.jsonl : {"id","name","price_vnd"|null,"description","url","images":[url]}
//   articles.jsonl : {"id","title","body","url","published_at"|null}
//   about.jsonl    : {"id","title","body","url"}
//   news.jsonl     : giống articles nhưng từ samsam.net.vn
// Luật: delay ≥1s/request (CRAWL_DELAY_S), chỉ trang public, log ra stdout. Lỗi 1 item không làm
// chết cả job — ghi warning rồi chạy tiếp.
// Khác Python có chủ đích: nguồn Bricks (hệ thống phân phối) cần trình duyệt headless (playwright)
// — bản TS chưa có → bỏ qua có cảnh báo y như Python khi thiếu playwright, NHƯNG giữ nguyên các bản
// ghi `dist-` đang có trong file output (Python thiếu playwright ghi đè làm mất; TS không xóa).

export const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; samsam-pilot/0.1)' };
export const TIMEOUT_S = 20;

export type Rec = Record<string, unknown>;
export type Log = (s: string) => void;

/** Phản hồi HTTP đã đọc hết (httpx.Response tối giản). `url` = URL cuối sau redirect,
 * `statusText` = reason phrase của server (dùng cho thông điệp lỗi kiểu httpx). */
export type HttpResp = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  url?: string;
  statusText?: string;
};
export type HttpGet = (url: string) => Promise<HttpResp>;

export type CollectDeps = {
  http?: HttpGet;
  sleep?: (s: number) => Promise<void>;
  log?: Log;
  dataDir?: string;
};

/** Lỗi parse 1 item (Python KeyError/ValueError/AttributeError/TypeError) — bỏ item, chạy tiếp. */
export class ItemError extends Error {}

const WS_RUN = new RegExp(`[${S}]+`, 'gu');
const squash = (s: string) => s.replace(WS_RUN, ' ');

const defaultHttp: HttpGet = async (url) => {
  const r = await fetch(url, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_S * 1000),
  });
  return {
    status: r.status,
    headers: r.headers,
    body: new Uint8Array(await r.arrayBuffer()),
    url: r.url || url,
    statusText: r.statusText,
  };
};

const STATUS_KIND: Record<number, string> = {
  1: 'Informational response',
  3: 'Redirect response',
  4: 'Client error',
  5: 'Server error',
};

/** Thông điệp `httpx.Response.raise_for_status()` (HTTPStatusError) cho phản hồi không 2xx. */
export function statusErrorMessage(r: HttpResp, url: string): string {
  const kind = STATUS_KIND[Math.floor(r.status / 100)] ?? 'Invalid status code';
  const reason = r.statusText || STATUS_CODES[r.status] || '';
  // httpx `has_redirect_location`: chỉ 301/302/303/307/308 có header Location.
  const loc = [301, 302, 303, 307, 308].includes(r.status) ? r.headers.get('location') : null;
  const lines = [`${kind} '${r.status} ${reason}' for url '${r.url ?? url}'`];
  if (loc !== null) lines.push(`Redirect location: '${loc}'`);
  lines.push(
    `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${r.status}`,
  );
  return lines.join('\n');
}

/** httpx `Response.text`: charset của Content-Type, mặc định utf-8, byte lỗi → U+FFFD. */
export function respText(r: HttpResp): string {
  const m = /charset=["']?([^"';\s]+)/i.exec(r.headers.get('content-type') ?? '');
  try {
    return new TextDecoder(m?.[1] ?? 'utf-8').decode(r.body);
  } catch {
    return new TextDecoder('utf-8').decode(r.body);
  }
}

/** GET 1 url có delay; lỗi trả null (đã warn) — caller quyết định bỏ qua. */
export async function get(
  url: string,
  d: Required<Pick<CollectDeps, 'http' | 'sleep' | 'log'>>,
): Promise<HttpResp | null> {
  await d.sleep(CRAWL_DELAY_S);
  try {
    const r = await d.http(url);
    if (r.status < 200 || r.status >= 300) {
      d.log(`[warn] GET ${url}: ${statusErrorMessage(r, url)}`);
      return null;
    }
    return r;
  } catch (e) {
    d.log(`[warn] GET ${url}: ${(e as Error).message}`);
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
/** Python `x or y`. */
const or = <T>(v: unknown, dflt: T): unknown =>
  v === null ||
  v === undefined ||
  v === '' ||
  v === 0 ||
  v === false ||
  (Array.isArray(v) && !v.length) ||
  (isObj(v) && !Object.keys(v).length)
    ? dflt
    : v;
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new ItemError(`${what}: không phải chuỗi`);
  return v;
};
const getKey = (p: unknown, k: string): unknown => {
  if (!isObj(p)) throw new ItemError("'list' object has no attribute 'get'");
  return p[k];
};

/** Python `int(s)` cho chuỗi đã `isdigit()` (chữ số Nd) — số mũ ²… → ItemError (ValueError). */
function digitsInt(s: string): bigint {
  if (!/^\p{Nd}+$/u.test(s)) throw new ItemError(`invalid literal for int(): '${s}'`);
  let n = 0n;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    n = n * 10n + BigInt((cp - start) % 10);
  }
  return n;
}

/** WooCommerce Store API → products.jsonl. `prices.price` ở đơn vị nhỏ nhất theo
 * `currency_minor_unit` (VND = 0); "0"/thiếu giá → null (site ghi 'liên hệ'). */
export function wcProduct(p: unknown): Rec {
  const prices = or(getKey(p, 'prices'), {});
  const rawV = or(getKey(prices, 'price'), '');
  const raw = pyStrip(str(rawV, 'price'));
  const minor = or(getKey(prices, 'currency_minor_unit'), 0);
  let price: bigint | null = null;
  if (raw && [...raw].every(isDigit) && digitsInt(raw) > 0n) {
    const m = typeof minor === 'boolean' ? Number(minor) : minor;
    if (typeof m !== 'number') throw new ItemError('unsupported operand type(s) for ** or pow()');
    price = BigInt(Math.trunc(Number(digitsInt(raw)) / 10 ** m));
  }
  const desc = or(getKey(p, 'short_description'), null) ?? or(getKey(p, 'description'), '');
  if (!Object.hasOwn(p as object, 'id')) throw new ItemError("'id'");
  const images = or(getKey(p, 'images'), []);
  if (!Array.isArray(images)) throw new ItemError('images: không phải danh sách');
  return {
    id: `wc-${pyStr(getKey(p, 'id'))}`,
    name: stripHtml(str(or(getKey(p, 'name'), ''), 'name')),
    price_vnd: price,
    description: stripHtml(str(desc, 'description')),
    url: or(getKey(p, 'permalink'), ''),
    images: images.filter((i) => or(getKey(i, 'src'), null) !== null).map((i) => (i as Rec).src),
  };
}

/** WP REST post/page → articles.jsonl. WP id duy nhất xuyên post-type. */
export function wpPost(p: unknown): Rec {
  if (!Object.hasOwn(p as object, 'id') || !isObj(p)) throw new ItemError("'id'");
  const rendered = (k: string) => stripHtml(str(or(getKey(or(p[k], {}), 'rendered'), ''), k));
  return {
    id: `wp-${pyStr(p.id)}`,
    title: rendered('title'),
    body: rendered('content'),
    url: or(p.link, ''),
    published_at: or(p.date, null),
  };
}

const LOC_RE = /<loc>([^<]+)<\/loc>/g;

export async function sitemapUrls(
  url: string,
  d: Required<Pick<CollectDeps, 'http' | 'sleep' | 'log'>>,
): Promise<string[]> {
  const r = await get(url, d);
  if (r === null) return [];
  return [...respText(r).matchAll(LOC_RE)].map((m) => m[1] as string);
}

/** id từ slug file .html — duy nhất trong phạm vi site net.vn. */
export function nvId(url: string): string {
  const last = url.slice(url.lastIndexOf('/') + 1);
  return `nv-${last.endsWith('.html') ? last.slice(0, -5) : last}`;
}

/** Trang about/news NukeViet: h1 + div.bodytext (+ .hometext tóm tắt). */
export function nvArticle(soup: El, url: string): Rec {
  const h1 = find(soup, 'h1');
  const parts: string[] = [];
  for (const sel of ['div.hometext', 'div.bodytext']) {
    const el = selectOne(soup, sel);
    if (el) parts.push(getText(el, ' ', true));
  }
  const pub = selectOne(soup, '[itemprop=datePublished]');
  return {
    id: nvId(url),
    title: h1 ? getText(h1, '', true) : url,
    body: squash(parts.join(' ')),
    url,
    published_at: pub ? pub.attrs.get('content') || getText(pub, '', true) : null,
  };
}

export function nvPage(soup: El, url: string): Rec {
  const rec = nvArticle(soup, url);
  delete rec.published_at; // contract about.jsonl không có field này
  return rec;
}

const NOT_DIGIT = /[^\p{Nd}]/gu;

/** Trang sản phẩm NukeViet shops: giá trong microdata itemprop=price. */
export function nvShop(soup: El, url: string): Rec {
  const h1 = find(soup, 'h1');
  const priceEl = selectOne(soup, '[itemprop=price]');
  const digits = priceEl ? getText(priceEl).replace(NOT_DIGIT, '') : '';
  const detail = selectOne(soup, 'div#detail');
  if (detail) {
    // công dụng nằm ở cả block tóm tắt cạnh giá lẫn tab Mô tả → lấy hết #detail, chỉ bỏ phần rác:
    // sản phẩm cùng loại, từ khóa, tab đánh giá
    for (const junk of select(detail, '.other-box, .keywords, .nav, [id^=content_rate], form')) {
      decompose(junk);
    }
  }
  const imgs: string[] = [];
  for (const i of select(detail ?? soup, 'img')) {
    const src = i.attrs.get('src');
    if (src) {
      try {
        imgs.push(urljoin(url, src));
      } catch (e) {
        throw new ItemError((e as Error).message);
      }
    }
  }
  return {
    id: nvId(url),
    name: h1 ? getText(h1, '', true) : url,
    price_vnd: digits ? digitsInt(digits) : null,
    description: detail ? squash(getText(detail, ' ', true)) : '',
    url,
    images: imgs,
  };
}

/** 1 item `li.brxe-loop-builder-on` trong listing hệ thống phân phối → bản ghi dạng article:
 * title = tên điểm, body = địa chỉ + loại + SĐT. */
export function bricksLoc(li: El, pageUrl: string): Rec {
  const h5 = find(li, 'h5');
  const divs = select(li, 'div.brxe-text-basic').map((d) => getText(d, ' ', true));
  const tel = selectOne(li, 'a[href^="tel:"]');
  const title = h5 ? getText(h5, '', true) : '';
  const slug = title
    .normalize('NFKD')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: encode("ascii", "ignore")
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const body =
    `Địa chỉ: ${divs.length ? divs[0] : '—'}. ` +
    `Loại hình: ${divs.length > 1 ? divs[divs.length - 1] : '—'}. ` +
    `Điện thoại: ${tel ? getText(tel, '', true) : '—'}.`;
  return { id: `dist-${slug}`, title, body, url: pageUrl, published_at: null };
}

const PARSERS: Record<string, (soup: El, url: string) => Rec> = {
  nv_shop: nvShop,
  nv_article: nvArticle,
  nv_page: nvPage,
};
const ITEM_PARSERS: Record<string, (p: unknown) => Rec> = {
  wc_product: wcProduct,
  wp_post: wpPost,
};
const ARTICLE_KINDS = new Set(['wp_post', 'nv_article', 'nv_page', 'bricks_loc']);

/** Bản ghi rỗng payload: article thiếu body, product thiếu name. */
export function degenerate(kind: string, rec: Rec): boolean {
  if (ARTICLE_KINDS.has(kind)) return !pyStrip(String(rec.body ?? ''));
  return !pyStrip(String(rec.name ?? ''));
}

const idOf = (item: unknown) => pyStr(isObj(item) ? item.id : null);

/** Duyệt mọi trang WP REST (phân trang theo header X-WP-TotalPages). */
async function* wpItems(
  url: string,
  d: Required<Pick<CollectDeps, 'http' | 'sleep' | 'log'>>,
): AsyncGenerator<unknown> {
  let page = 1;
  for (;;) {
    const sep = url.includes('?') ? '&' : '?';
    const r = await get(`${url}${sep}per_page=100&page=${page}`, d);
    if (r === null) return;
    let items: unknown;
    try {
      items = JSON.parse(respText(r));
    } catch {
      d.log(`[warn] ${url} page ${page}: response không phải JSON`);
      return;
    }
    // shortcut: JSON không phải danh sách (Python lặp khóa dict rồi chết ở item.get) → dừng nguồn có cảnh báo.
    if (!Array.isArray(items)) {
      d.log(`[warn] ${url} page ${page}: response không phải danh sách`);
      return;
    }
    yield* items;
    const tp = pyStrip(r.headers.get('x-wp-totalpages') ?? '') || '1';
    if (!/^[+-]?[0-9]+$/.test(tp)) throw new RangeError(`invalid literal for int(): '${tp}'`);
    if (page >= Number(tp)) return;
    page += 1;
  }
}

/** Crawl 1 nguồn theo type/kind → danh sách bản ghi (bỏ item lỗi/rỗng). */
export async function crawl(src: CrawlSource, deps: CollectDeps = {}): Promise<Rec[]> {
  const d = {
    http: deps.http ?? defaultHttp,
    sleep: deps.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000))),
    log: deps.log ?? ((s: string) => console.log(s)),
  };
  const kind = src.kind;
  if (src.type === 'bricks_listing') {
    d.log(`[warn] ${src.name}: thiếu playwright — bỏ qua source`);
    return [];
  }
  const out: Rec[] = [];
  if (src.type === 'wp_api') {
    const parse = ITEM_PARSERS[kind] as (p: unknown) => Rec;
    for await (const item of wpItems(src.url, d)) {
      let rec: Rec;
      try {
        rec = parse(item);
      } catch (e) {
        if (!(e instanceof ItemError || e instanceof RangeError || e instanceof TypeError)) throw e;
        d.log(`[warn] ${src.name} item ${idOf(item)}: ${(e as Error).message}`);
        continue;
      }
      if (degenerate(kind, rec)) {
        d.log(`[warn] ${src.name} item ${idOf(item)} rỗng — bỏ qua`);
        continue;
      }
      out.push(rec);
    }
    return out;
  }
  const parse = PARSERS[kind] as (soup: El, url: string) => Rec;
  for (const url of await sitemapUrls(src.url, d)) {
    let rec: Rec | null = null;
    // net.vn throttle theo burst: đôi khi trả trang skeleton (không h1/body). Thử tối đa 3 lần,
    // backoff tăng dần chờ cửa sổ throttle nguội.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await get(url, d);
      if (r === null) break;
      try {
        rec = parse(parseHtml(respText(r)), url);
      } catch (e) {
        if (!(e instanceof ItemError || e instanceof RangeError || e instanceof TypeError)) throw e;
        d.log(`[warn] ${src.name} ${url}: ${(e as Error).message}`);
        rec = null;
        break;
      }
      if (!degenerate(kind, rec)) break;
      d.log(`[warn] ${src.name} ${url}: trang rỗng, retry ${attempt + 1}`);
      await d.sleep(CRAWL_DELAY_S * 8 * (attempt + 1));
    }
    if (rec === null || degenerate(kind, rec)) {
      d.log(`[warn] ${src.name} ${url}: không lấy được nội dung — bỏ qua`);
      continue;
    }
    out.push(rec);
  }
  return out;
}

/** Python `json.dumps(rec, ensure_ascii=False)` (giữ thứ tự khóa, số nguyên lớn chính xác). */
export function dumpsRec(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(dumpsRec).join(', ')}]`;
  if (isObj(v)) {
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${dumpsRec(x)}`)
      .join(', ')}}`;
  }
  if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v))
    return BigInt(v).toString();
  return v === undefined ? 'null' : JSON.stringify(v);
}

/** Tiền tố id bản ghi nguồn Bricks (`bricks_loc` của Python: `dist-<slug>`). */
const BRICKS_ID = 'dist-';

/** Bản ghi có id bắt đầu `prefix` trong file jsonl đang có (đọc BYTES, tách `\n`; dòng hỏng/không
 * phải UTF-8 bỏ qua; thiếu file → []). */
function keepRecords(path: string, prefix: string): Rec[] {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  const dec = new TextDecoder('utf-8', { fatal: true });
  const out: Rec[] = [];
  for (let at = 0; at < buf.length; ) {
    const nl = buf.indexOf(0x0a, at);
    const end = nl < 0 ? buf.length : nl;
    try {
      const v: unknown = JSON.parse(dec.decode(buf.subarray(at, end)));
      // chỉ bản ghi phẳng chuỗi/null đúng dạng `bricks_loc` (không lồng → dumpsRec an toàn)
      const flat = isObj(v) && Object.values(v).every((x) => x === null || typeof x === 'string');
      if (flat && typeof v.id === 'string' && v.id.startsWith(prefix)) out.push(v);
    } catch {
      // dòng hỏng — bỏ
    }
    at = end + 1;
  }
  return out;
}

/** Crawl tất cả SOURCES, ghi jsonl (LF), trả exit code. */
export async function collectMain(
  deps: CollectDeps = {},
  sources: readonly CrawlSource[] = SOURCES,
): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const dir = deps.dataDir ?? DATA_DIR;
  const files = new Map<string, Rec[]>();
  for (const src of sources) {
    log(`[src] ${src.name} -> ${src.output}`);
    let recs = await crawl(src, { ...deps, log });
    if (src.type === 'bricks_listing') {
      // TS chưa có trình duyệt headless (Python dùng playwright): KHÔNG để lần ghi đè file làm mất
      // bản ghi điểm phân phối đang có (KB/chatbot mất địa chỉ đại lý) — giữ nguyên bản cũ.
      const kept = keepRecords(join(dir, src.output), BRICKS_ID);
      if (kept.length) {
        log(
          `[warn] ${src.name}: giữ ${kept.length} bản ghi ${BRICKS_ID} đang có trong ${src.output}` +
            ' (chưa crawl lại được)',
        );
      }
      recs = [...recs, ...kept];
    }
    files.set(src.output, [...(files.get(src.output) ?? []), ...recs]);
    log(`[src] ${src.name}: ${recs.length} records`);
  }
  for (const [name, recs] of files) {
    const path = join(dir, name);
    writeFileSync(path, recs.map((r) => `${dumpsRec(r)}\n`).join(''), 'utf8');
    log(`[done] ${name}: ${recs.length} records -> ${path}`);
  }
  return 0;
}
