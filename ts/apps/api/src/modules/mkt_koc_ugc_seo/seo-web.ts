import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { submit as directorSubmit } from '@samsam/core/ops/director';
import { vnDate } from '@samsam/core/ops/period';
import { isInt, isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { hostname, UrlError, urljoin, urlsplit, urlunsplit } from '@samsam/core/ops/py-url';
import { isDbError } from '@samsam/core/ops/tx';
import { DATA_DIR, dataPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { casefold, cpLen, pyStr, pyStrip } from '@samsam/core/security/py';
import { cp1252Char, find, getText, parseHtml, select } from '../intel_crawl/html-soup.js';
import {
  BlockedDomain,
  BudgetExhausted,
  type FetcherOpts,
  Fetcher as IntelFetcher,
} from '../intel_crawl/intel.js';
import { pyDumps } from '../kd_price/deps.js';
import { type Dict, sha256 } from './shared.js';

// v6.5 MKT-10 (marketing-06.1) — rà SEO website CỦA CHÍNH CÔNG TY, chỉ đọc (`agents/seo_web.py`) →
// báo cáo + nháp đề xuất sửa vào hàng duyệt khối marketing. CHỈ host trong `seo_rules.json`
// `web.own_hosts` (khớp chính xác hoặc đuôi "." + host). `--from-crawl` (mặc định, 0 request) đọc
// `data/{products,articles,news,about}.jsonl`; `--fetch` GET qua collector intel (`OwnFetcher`: robots,
// ≥1s/host, ngân sách, redirect ra ngoài own_hosts bị chặn), parse HTML như bs4 html.parser.
// Payload CHỈ URL + code + đề xuất (không trích text vi phạm). Agent KHÔNG có đường ghi website.

export const RULES_PATH = dataPath('seo_rules.json');
export const CRAWL_FILES = ['products', 'articles', 'news', 'about'];
export const AGENT = 'agent:MKT-10';
export const OBJECT_TYPE = 'seo_web_fix';
export const SOURCE = 'seo_web';
export const FEATURE = 'marketing-06.1';
export const JOB = 'agents.seo_web';
export const MAX_PAYLOAD_ISSUES = 300;
const BROKEN = [404, 410];

export const SUGGEST: Record<string, string> = {
  title_thieu: 'bổ sung tiêu đề nội dung',
  title_trung: 'đặt tiêu đề riêng cho từng trang',
  title_dai: 'rút gọn tiêu đề về ≤ title_max ký tự',
  sp_khong_anh: 'thêm ảnh sản phẩm (packshot thật)',
  guardrail: 'sửa nội dung theo luật TPBVSK (Pháp chế duyệt) — xem code',
  url_guardrail: 'đổi slug URL không chứa cụm bị cấm (giữ redirect 301)',
  html_title_thieu: 'thêm thẻ <title>',
  html_title_trung: 'đặt <title> riêng cho từng trang',
  html_title_dai: 'rút gọn <title> về ≤ title_max ký tự',
  meta_desc_thieu: 'thêm meta description desc_min–desc_max ký tự',
  meta_desc_ngan: 'viết dài thêm meta description (≥ desc_min ký tự)',
  meta_desc_dai: 'rút gọn meta description (≤ desc_max ký tự)',
  meta_desc_trung: 'viết meta description riêng cho từng trang',
  h1_khong_bang_1: 'mỗi trang đúng 1 thẻ H1',
  img_thieu_alt: 'bổ sung alt mô tả ảnh',
  link_gay: 'sửa/bỏ link nội bộ trỏ trang 404/410',
  trang_loi: 'kiểm tra trang trả mã lỗi',
};

export type WebRules = {
  own_hosts: string[];
  title_max: number;
  desc_min: number;
  desc_max: number;
  max_requests: number;
};
export type SanRules = {
  default_seeds: string[];
  sku_seeds: Record<string, string[]>;
  title_sep: string;
};
export type SeoRules = Dict & { web: WebRules; san: SanRules };

/** data/seo_rules.json thiếu/hỏng/sai luật (Python ValueError). */
export class SeoRulesError extends RangeError {}

const intIn = (v: unknown, lo: number, hi: number) => isInt(v) && v >= lo && v <= hi;

/** → doc đã kiểm (web + san). Lỗi → SeoRulesError. */
export function loadRules(path: string = RULES_PATH): SeoRules {
  let doc: unknown;
  try {
    doc = readJson(path);
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    throw new SeoRulesError(`${basename(path)} hỏng/thiếu: ${e.pyType}`);
  }
  const web = isPlainObject(doc) ? doc.web : null;
  if (!isPlainObject(web)) throw new SeoRulesError("thiếu object 'web'");
  const hosts = web.own_hosts;
  if (
    !Array.isArray(hosts) ||
    !hosts.length ||
    !hosts.every((h) => typeof h === 'string' && pyStrip(h) && !h.includes('/'))
  ) {
    throw new SeoRulesError('web.own_hosts phải list host khác rỗng');
  }
  for (const [k, lo, hi] of [
    ['title_max', 10, 500],
    ['desc_min', 1, 1000],
    ['desc_max', 1, 2000],
    ['max_requests', 1, 200],
  ] as const) {
    if (!intIn(web[k], lo, hi)) throw new SeoRulesError(`web.${k} phải số nguyên ${lo}..${hi}`);
  }
  if ((web.desc_min as number) > (web.desc_max as number)) {
    throw new SeoRulesError('web.desc_min > desc_max');
  }
  const san = (doc as Dict).san;
  if (!isPlainObject(san)) throw new SeoRulesError("thiếu object 'san'");
  const seeds = san.default_seeds;
  if (!Array.isArray(seeds) || !seeds.every((x) => typeof x === 'string' && pyStrip(x))) {
    throw new SeoRulesError('san.default_seeds phải list chuỗi');
  }
  const ss = san.sku_seeds;
  if (
    !isPlainObject(ss) ||
    !Object.values(ss).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
  ) {
    throw new SeoRulesError('san.sku_seeds phải {sku: [seed]}');
  }
  if (typeof san.title_sep !== 'string' || !san.title_sep) {
    throw new SeoRulesError('san.title_sep phải chuỗi khác rỗng');
  }
  web.own_hosts = (hosts as string[]).map((h) => pyStrip(h).toLowerCase().replace(/\.+$/, ''));
  return doc as SeoRules;
}

const normHost = (h: string) => pyStrip(h).toLowerCase().replace(/\.+$/, '');

/** Host chính xác hoặc subdomain ('.' + host) của website công ty. */
export function isOwn(host: unknown, ownHosts: readonly string[]): boolean {
  if (typeof host !== 'string' || !host) return false;
  const h = normHost(host);
  return ownHosts.some((o) => h === o || h.endsWith(`.${o}`));
}

export function host(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return hostname(urlsplit(url).netloc) ?? '';
  } catch (e) {
    if (e instanceof UrlError) return '';
    throw e;
  }
}

const key = (s: string) => pyStrip(casefold(s.normalize('NFC')));

/** So link: scheme/host thường, bỏ fragment, path rỗng → '/'. */
export function normUrl(url: string): string {
  let s: ReturnType<typeof urlsplit>;
  try {
    s = urlsplit(url);
  } catch (e) {
    if (e instanceof UrlError) return url;
    throw e;
  }
  return urlunsplit({
    scheme: s.scheme.toLowerCase(),
    netloc: s.netloc.toLowerCase(),
    path: s.path || '/',
    query: s.query,
    fragment: '',
  });
}

// ---------------------------------------------------------------- crawl

const ASCII_BLANK = /^[ \t\n\r\v\f]*$/;
export type Rec = { kind: string; url: string; title: string; body: string; images: unknown };
export type CrawlStats = Record<string, number>;

/** jsonl đã crawl → [records own-host, stats]. 0 request mạng. BYTES + split `\n`. */
export function readCrawl(dataDir: string, ownHosts: readonly string[]): [Rec[], CrawlStats] {
  const stats: CrawlStats = { files: 0, bad: 0, external: 0, no_url: 0 };
  const recs: Rec[] = [];
  const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const name of CRAWL_FILES) {
    const p = join(dataDir, `${name}.jsonl`);
    if (!existsSync(p)) continue;
    stats.files += 1;
    const raw = readFileSync(p);
    let start = 0;
    while (start <= raw.length) {
      let end = raw.indexOf(0x0a, start);
      if (end < 0) end = raw.length;
      const line = raw.subarray(start, end);
      start = end + 1;
      if (ASCII_BLANK.test(line.toString('latin1'))) continue; // bytes.strip(): chỉ trắng ASCII
      let r: unknown;
      try {
        r = JSON.parse(dec.decode(line));
      } catch {
        stats.bad += 1;
        continue;
      }
      if (!isPlainObject(r) || Object.hasOwn(r, '_doc')) {
        stats.bad += 1;
        continue;
      }
      const url = r.url;
      if (typeof url !== 'string' || !pyStrip(url)) {
        stats.no_url += 1;
        continue;
      }
      if (!isOwn(host(url), ownHosts)) {
        stats.external += 1;
        continue;
      }
      const title = name !== 'products' ? r.title : r.name;
      const body = name !== 'products' ? r.body : r.description;
      recs.push({
        kind: name,
        url: pyStrip(url),
        title: typeof title === 'string' ? title : '',
        body: typeof body === 'string' ? body : '',
        images: r.images ?? null,
      });
    }
  }
  return [recs, stats];
}

export type Issue = { url: string; code: string; detail: Dict | null };
const issue = (url: string, code: string, detail: Dict | null = null): Issue => ({
  url,
  code,
  detail,
});

/** (codes, types) của violations — KHÔNG trích span/detail. */
function grCodes(res: { violations?: unknown }): [string[], string[]] {
  const vs = (Array.isArray(res.violations) ? res.violations : []).filter(isPlainObject);
  const codes = [...new Set(vs.map((v) => pyStr(v.code || v.type || '?')))].sort(cpCmp);
  const types = [...new Set(vs.map((v) => pyStr(v.type || '?')))].sort(cpCmp);
  return [codes, types];
}

/** items [url, title] → issue trùng (NFC casefold) trong cùng host. */
function dupTitles(items: [string, string][], code: string, out: Issue[]): void {
  const seen = new Map<string, string[]>();
  for (const [url, t] of items) {
    if (t && pyStrip(t)) {
      const k = `${host(url).toLowerCase()}\u0000${key(t)}`;
      seen.set(k, [...(seen.get(k) ?? []), url]);
    }
  }
  for (const urls of seen.values()) {
    if (urls.length > 1) for (const u of urls) out.push(issue(u, code, { so_trang: urls.length }));
  }
}

/** Rà dữ liệu đã crawl (thuần) → list issue {url, code, detail}. */
export function auditCrawl(records: Rec[], web: WebRules): Issue[] {
  const out: Issue[] = [];
  for (const r of records) {
    const t = pyStrip(r.title);
    if (!t) out.push(issue(r.url, 'title_thieu'));
    else if (cpLen(t) > web.title_max) out.push(issue(r.url, 'title_dai', { ky_tu: cpLen(t) }));
    if (
      r.kind === 'products' &&
      !(Array.isArray(r.images) && r.images.some((x) => typeof x === 'string' && pyStrip(x)))
    ) {
      out.push(issue(r.url, 'sp_khong_anh'));
    }
    const res = check(`${t}\n${r.body}`);
    if (res.ok !== true) {
      const [codes, types] = grCodes(res);
      out.push(issue(r.url, 'guardrail', { codes, types }));
    }
    const ures = check(r.url);
    if (ures.ok !== true) {
      const [codes, types] = grCodes(ures);
      out.push(issue(r.url, 'url_guardrail', { codes, types }));
    }
  }
  dupTitles(
    records.map((r) => [r.url, r.title]),
    'title_trung',
    out,
  );
  return out;
}

export const crawlUrls = (records: Rec[]): string[] =>
  [...new Set(records.map((r) => r.url))].sort(cpCmp);

// ---------------------------------------------------------------- fetch (collector intel)

export { BlockedDomain, BudgetExhausted };
/** Hợp đồng `crawler.intel.Fetcher` mà `fetchAudit` dùng (test tiêm Fetcher giả). */
export interface Fetcher {
  used: number;
  robotsDeny: number;
  fetch(url: string, source: string): Promise<{ status: unknown; body: Uint8Array | null } | null>;
  close?(): Promise<void> | void;
}

/** `OwnFetcher`: Fetcher của collector intel (robots, ≥1s/host, ngân sách, chặn cứng) chỉ cho phép host
 * website công ty — kể cả hop redirect (redirect ra host lạ → BlockedDomain, không GET). */
export function ownFetcher(ownHosts: readonly string[], opts: FetcherOpts = {}): IntelFetcher {
  const f = new IntelFetcher(opts);
  // shortcut: `Fetcher.check` của intel_crawl là private — bọc trên instance (Python ghi đè `_check`);
  // nâng khi intel có hook chọn host. Đổi tên/chữ ký → `.bind` ném (fail-closed) + test redirect đỏ.
  const me = f as unknown as { check(url: string, source: string): { u: URL; host: string } };
  const base = me.check.bind(f);
  me.check = (url, source) => {
    const c = base(url, source);
    if (!isOwn(c.host, ownHosts)) {
      f.blocked += 1;
      f.log(`[blocked] ${SOURCE}: host ngoài own_hosts — bỏ`);
      throw new BlockedDomain(c.host);
    }
    return c;
  };
  return f;
}

export type Page = {
  title: string;
  desc: string | null;
  h1: number;
  img_no_alt: number;
  img_total: number;
  links: string[];
};

/** bytes trang → chữ. shortcut: bỏ BOM UTF-8 → UTF-8 strict → hỏng thì windows-1252 từng byte; bs4
 * (UnicodeDammit) còn xét charset khai báo + đoán bằng chardet — trang không phải UTF-8 có thể khác;
 * nâng khi website công ty đổi bảng mã. */
function decodeBody(body: Uint8Array): string {
  const b = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? body.subarray(3) : body;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return Array.from(b, cp1252Char).join('');
  }
}

/** HTML (`bs4` html.parser) → {title, desc, h1, img_no_alt, links (nội bộ, đã chuẩn hóa)}. */
export function parsePage(url: string, body: Uint8Array, ownHosts: readonly string[]): Page {
  const soup = parseHtml(decodeBody(body));
  const t = find(soup, 'title');
  let desc: string | null = null;
  for (const m of select(soup, 'meta')) {
    if (pyStrip(m.attrs.get('name') ?? '').toLowerCase() === 'description') {
      desc = pyStrip(m.attrs.get('content') ?? '');
      break;
    }
  }
  const imgs = select(soup, 'img');
  const links = new Set<string>();
  for (const a of select(soup, 'a')) {
    const raw = a.attrs.get('href');
    if (raw === undefined) continue;
    const href = pyStrip(raw);
    if (!href || ['#', 'mailto:', 'tel:', 'javascript:'].some((p) => href.startsWith(p))) continue;
    let full: string;
    try {
      full = urljoin(url, href);
    } catch (e) {
      if (e instanceof UrlError) continue;
      throw e;
    }
    const sc = urlsplit(full).scheme;
    if ((sc === 'http' || sc === 'https') && isOwn(host(full), ownHosts)) links.add(normUrl(full));
  }
  return {
    title: t ? getText(t, ' ', true) : '',
    desc,
    h1: select(soup, 'h1').length,
    img_no_alt: imgs.filter((i) => !pyStrip(i.attrs.get('alt') ?? '')).length,
    img_total: imgs.length,
    links: [...links].sort(cpCmp),
  };
}

/** GET tuần tự qua Fetcher → [issues, stats]. Không crash vì mạng. */
export async function fetchAudit(
  urls: string[],
  web: WebRules,
  fetcher: Fetcher,
): Promise<[Issue[], Dict]> {
  const issues: Issue[] = [];
  const pages = new Map<string, Page>();
  const status = new Map<string, unknown>();
  const stats: Record<string, number> = {
    urls: urls.length,
    ok: 0,
    non_2xx: 0,
    robots_cam: 0,
    loi: 0,
    blocked: 0,
    het_ngan_sach: 0,
    link_chua_kiem: 0,
  };
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i] as string;
    const deny0 = fetcher.robotsDeny;
    let r: Awaited<ReturnType<Fetcher['fetch']>>;
    try {
      r = await fetcher.fetch(url, SOURCE);
    } catch (e) {
      if (e instanceof BlockedDomain) {
        stats.blocked = (stats.blocked as number) + 1;
        continue;
      }
      if (e instanceof BudgetExhausted) {
        stats.het_ngan_sach = urls.length - i;
        break;
      }
      throw e;
    }
    if (r === null) {
      const k = fetcher.robotsDeny > deny0 ? 'robots_cam' : 'loi';
      stats[k] = (stats[k] as number) + 1;
      continue;
    }
    status.set(normUrl(url), r.status);
    if (!(isInt(r.status) && r.status >= 200 && r.status < 300) || r.body === null) {
      stats.non_2xx = (stats.non_2xx as number) + 1;
      issues.push(issue(url, 'trang_loi', { status: r.status as number }));
      continue;
    }
    stats.ok = (stats.ok as number) + 1;
    pages.set(url, parsePage(url, r.body, web.own_hosts));
  }
  for (const [url, p] of pages) {
    const t = p.title;
    if (!t) issues.push(issue(url, 'html_title_thieu'));
    else if (cpLen(t) > web.title_max)
      issues.push(issue(url, 'html_title_dai', { ky_tu: cpLen(t) }));
    const d = p.desc;
    if (!d) issues.push(issue(url, 'meta_desc_thieu'));
    else if (cpLen(d) < web.desc_min)
      issues.push(issue(url, 'meta_desc_ngan', { ky_tu: cpLen(d) }));
    else if (cpLen(d) > web.desc_max) issues.push(issue(url, 'meta_desc_dai', { ky_tu: cpLen(d) }));
    if (p.h1 !== 1) issues.push(issue(url, 'h1_khong_bang_1', { h1: p.h1 }));
    if (p.img_no_alt) {
      issues.push(issue(url, 'img_thieu_alt', { anh: p.img_no_alt, tong: p.img_total }));
    }
    for (const link of p.links) {
      const st = status.get(link);
      if (st === undefined) stats.link_chua_kiem = (stats.link_chua_kiem as number) + 1;
      else if (BROKEN.includes(st as number)) {
        issues.push(issue(url, 'link_gay', { toi: link, status: st as number }));
      }
    }
  }
  dupTitles(
    [...pages].map(([u, p]) => [u, p.title]),
    'html_title_trung',
    issues,
  );
  dupTitles(
    [...pages].map(([u, p]) => [u, p.desc ?? '']),
    'meta_desc_trung',
    issues,
  );
  return [issues, stats];
}

/** URL có slug bị guardrail chặn → mã băm (payload hàng duyệt phải qua guardrail; URL đầy đủ nằm
 * trong file báo cáo). */
export function safeUrl(url: string): string {
  if (check(url).ok === true) return url;
  return `[url ${sha256(url).slice(0, 12)} — xem báo cáo]`;
}

/** Payload hàng duyệt: URL + code + đề xuất (không trích text). */
export function buildPayload(day: string, mode: string, issues: Issue[]): string {
  const items = issues.slice(0, MAX_PAYLOAD_ISSUES).map((it) => {
    let det: Dict | null = it.detail;
    if (det !== null && Object.hasOwn(det, 'toi'))
      det = { ...det, toi: safeUrl(det.toi as string) };
    return { url: safeUrl(it.url), code: it.code, chi_tiet: det, de_xuat: SUGGEST[it.code] };
  });
  return pyDumps(
    {
      ngay: day,
      che_do: mode,
      so_van_de: issues.length,
      van_de: items,
      ghi_chu: 'Người sửa website TAY trên CMS sau khi duyệt — agent không có quyền ghi.',
    },
    { sortKeys: true },
  );
}

function cell(v: unknown): string {
  let s: string;
  if (isPlainObject(v)) {
    s = Object.keys(v)
      .sort(cpCmp)
      .map((k) => {
        const x = v[k];
        return `${k}=${Array.isArray(x) ? x.map(pyStr).join('/') : pyStr(x)}`;
      })
      .join(', ');
  } else s = v === null || v === undefined ? '' : pyStr(v);
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function render(
  day: string,
  mode: string,
  issues: Issue[],
  stats: Dict,
  web: WebRules,
): string {
  const counts = new Map<string, number>();
  for (const it of issues) counts.set(it.code, (counts.get(it.code) ?? 0) + 1);
  const L = [
    `# Rà SEO website công ty — ${day}`,
    '',
    `**Chế độ:** \`${mode}\` · **Nguồn:** \`agents/seo_web.py\` · host: ${web.own_hosts.map((h) => `\`${h}\``).join(', ')}`,
    '',
    '> **BẢN NHÁP — chỉ đọc.** Agent KHÔNG sửa website; người sửa TAY trên CMS sau khi GĐ Marketing duyệt. Ngưỡng `data/seo_rules.json` là GIẢ ĐỊNH chờ MKT/SEO chốt. Search Console/GA4 chờ bàn giao (external-dep).',
    '',
    '## Thống kê',
    '',
    `- ${Object.keys(stats)
      .sort(cpCmp)
      .map((k) => `${k}=${pyStr(stats[k])}`)
      .join(' · ')}`,
    `- Vấn đề theo loại: ${
      [...counts.keys()]
        .sort(cpCmp)
        .map((k) => `\`${k}\` ${counts.get(k)}`)
        .join(' · ') || 'không có'
    }`,
  ];
  if (mode === 'from-crawl') {
    L.push(
      '- Tiêu đề ở đây là tiêu đề NỘI DUNG (title/name đã crawl), không phải thẻ `<title>`. Meta description / H1 / alt ảnh / link gãy: **chưa kiểm — cần `--fetch`**.',
    );
  }
  L.push('', '## Vấn đề + đề xuất sửa', '');
  if (!issues.length) L.push('- Không phát hiện vấn đề.');
  else {
    L.push('| URL | Vấn đề | Chi tiết | Đề xuất |', '|---|---|---|---|');
    const sorted = [...issues].sort((a, b) => cpCmp(a.code, b.code) || cpCmp(a.url, b.url));
    for (const it of sorted) {
      L.push(`| ${cell(it.url)} | \`${it.code}\` | ${cell(it.detail)} | ${SUGGEST[it.code]} |`);
    }
  }
  L.push(
    '',
    '---',
    '*Sinh tự động bởi `python -m agents.seo_web` — kiểm chứng trước khi sửa.*',
    '',
  );
  return L.join('\n');
}

export type SubmitOut = { status: string; codes?: string[]; id?: bigint; object_id?: string };

/** 1 mục hàng duyệt khối marketing. Trùng mục → skipped; payload không qua guardrail → refused. */
export async function submitIssues(
  db: Db,
  day: string,
  mode: string,
  issues: Issue[],
): Promise<SubmitOut> {
  const payload = buildPayload(day, mode, issues);
  const g = check(payload);
  if (g.ok !== true) return { status: 'refused', codes: grCodes(g)[0] };
  const oid = `seo-web:${day}:${sha256(payload).slice(0, 16)}`;
  const ttl = `Đề xuất sửa SEO website ${day} — ${issues.length} vấn đề (${mode})`;
  try {
    const id = await directorSubmit(db, {
      block: 'marketing',
      objectType: OBJECT_TYPE,
      objectId: oid,
      title: ttl,
      payload,
      createdBy: AGENT,
    });
    return { status: 'created', id, object_id: oid };
  } catch (e) {
    if (isDbError(e) && (e as { code?: string }).code === '23505') {
      return { status: 'skipped', object_id: oid };
    }
    throw e;
  }
}

export type RunResult = { day: string; mode: string; issues: Issue[]; stats: Dict; text: string };

/** Rà (không ghi DB) → {day, mode, issues, stats, text}. */
export async function run(o: {
  mode: string;
  dataDir?: string;
  rules?: SeoRules;
  maxRequests?: number | null;
  fetcherFactory?: (budget: number) => Fetcher | Promise<Fetcher>;
  now?: Date;
}): Promise<RunResult> {
  const rules = o.rules ?? loadRules();
  const web = rules.web;
  const day = vnDate(o.now ?? new Date());
  const [records, base] = readCrawl(o.dataDir ?? DATA_DIR, web.own_hosts);
  let stats: Dict = base;
  let issues: Issue[];
  if (o.mode === 'fetch') {
    const n = o.maxRequests ?? web.max_requests;
    const factory = o.fetcherFactory ?? ((budget: number) => ownFetcher(web.own_hosts, { budget }));
    const f = await factory(n);
    try {
      const [iss, fst] = await fetchAudit(crawlUrls(records), web, f);
      issues = iss;
      stats = { ...stats, ...fst, requests: f.used };
    } finally {
      await f.close?.();
    }
  } else {
    issues = auditCrawl(records, web);
    stats.requests = 0;
  }
  stats.pages = records.length;
  return { day, mode: o.mode, issues, stats, text: render(day, o.mode, issues, stats, web) };
}
