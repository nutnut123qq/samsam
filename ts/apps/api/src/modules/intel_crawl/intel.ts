import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename } from 'node:path';
import { domainToUnicode } from 'node:url';
import { gunzipSync, inflateRawSync, constants as zc } from 'node:zlib';
import { GatewayError } from '@samsam/core/ai/gateway';
import { isHealthQuestion } from '@samsam/core/ai/health';
import { casefold, stripAccents } from '@samsam/core/ai/text';
import type { Env } from '@samsam/core/env';
import {
  fromIsoformat,
  type PyDateTime,
  parsedateToDatetime,
  toDate,
  utcMicros,
  VN_US,
} from '@samsam/core/ops/py-date';
import {
  isIPv4,
  isIPv6,
  hostname as netlocHost,
  port as netlocPort,
  parseQsl,
  urlencode,
  urljoin,
  urlsplit,
  urlunsplit,
} from '@samsam/core/ops/py-url';
import { dataPath } from '@samsam/core/paths';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, isAlnum, pySplit, pyStrip, re, reEscape, S, W } from '@samsam/core/security/py';
import type pg from 'pg';
import { child, children, itertext, localName, parseXml, type XEl, XmlError } from './feed-xml.js';
import { stripHtml } from './html-soup.js';
import { RobotFileParser, splitlines } from './robots.js';
import { CRAWL_DELAY_S } from './sources.js';

/** `crawler.intel.parse_date`: RFC 822 rồi ISO 8601; naive → giờ VN; ngoài cửa sổ (năm < 2000 hoặc
 * > now + 2 ngày) → null; lỗi/tràn số → null (1 pubDate độc không giết cả lượt). */
export function parseDate(raw: unknown, now: Date = new Date()): PyDateTime | null {
  const s = [...pyStrip(typeof raw === 'string' ? raw : '')].slice(0, 100).join('');
  if (!s) return null;
  let dt = parsedateToDatetime(s) ?? fromIsoformat(s);
  if (!dt) return null;
  if (dt.offUs === null) dt = { ...dt, offUs: VN_US };
  const limit = BigInt(now.getTime()) * 1000n + 2n * 86_400_000_000n;
  return dt.y < 2000 || utcMicros(dt) > limit ? null : dt;
}

// Port `crawler/intel.py` — collector tin thị trường tầng A/B (v7.0, WP09), dùng chung cho DA-03,
// PC-A8, cảnh báo đỏ. Tầng P1-Shadow: KHÔNG gửi ai, KHÔNG đăng gì. Chỉ đọc RSS/Atom nguồn tầng A
// (báo chính thống/cơ quan nhà nước) và B (trang ngành/blog công khai) trong
// `data/intel_sources.json` (danh sách ĐỀ XUẤT — nguồn `cho_duyet` tới khi BGĐ/Quản lý MXH duyệt).
//
// Luật CHẶN cứng (cấu hình không nới được): HARD_BLOCK (sàn/MXH) ∪ host mọi nguồn tầng C — khớp hậu
// tố theo nhãn, không substring; kiểm TRƯỚC mọi request (URL nguồn, robots.txt, MỌI hop redirect).
// robots.txt 1 lần/origin/lượt: 2xx → luật file (Crawl-delay > 1 → dùng, trần 60 s); 401/403 → cấm
// hết; 4xx khác (trừ 429) → cho hết; 429/5xx/lỗi mạng/quá lớn → BỎ origin cả lượt (fail-closed).
// Nhịp ≥ 1 s giữa 2 lần BẮT ĐẦU request cùng host; 429 nội dung → không thử lại, bỏ origin.
// `--max-requests` = ngân sách TỔNG (robots + hop + feed). Trần body: feed 2 MB, robots 500 KB.
//
// Bảng `intel_items`: CHỈ tiêu đề + trích ≤300 ký tự đã che SĐT/email + link (không toàn văn, KHÔNG
// BAO GIỜ GET trang bài); tin 0 chủ đề → không lưu. Module CHỈ ghi `intel_items` (+ `job_runs`).
// LLM tóm tắt (mặc định TẮT): chỉ khi `--llm` VÀ `llm.enabled === true`, qua AI Gateway agent
// 'intel' (feature intel-01.1) + guardrail.check TRÊN CHUỖI ĐÃ LÀM SẠCH trước khi lưu.

export const SOURCES_FILE = dataPath('intel_sources.json');
export const GATEWAY_FILE = dataPath('llm_gateway.json');
export const HARD_BLOCK = [
  'shopee.vn',
  'shopee.com',
  'shp.ee',
  'tiktok.com',
  'tiktokv.com',
  'lazada.vn',
  'lazada.com',
  'lzd.co',
  'tiki.vn',
  'sendo.vn',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'instagram.com',
  'threads.net',
  'x.com',
  'twitter.com',
  'zalo.me',
] as const;
export const UA_TOKEN = 'samsam-intel';
export const TIMEOUT_S = 10;
export const TOTAL_S = 30; // trần tổng 1 request (chống server nhỏ giọt)
export const MAX_BYTES = 2_000_000; // feed
export const ROBOTS_MAX = 500_000;
export const MAX_HOPS = 3;
export const MAX_ENTRIES = 200;
export const MAX_URL = 2000; // btree unique index giới hạn ~2.7KB
export const TEXT_MAX = 300;
export const PRE_MAX = TEXT_MAX * 4; // cắt trước maskPii (chống DoS regex)
export const RAW_MAX = 20_000; // cắt HTML thô trước stripHtml
export const LLM_MAX_ITEMS = 20;
export const DEFAULT_MAX_REQUESTS = 60;
export const JOB = 'crawler.intel';
export const FEATURE = 'intel-01.1';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TIERS = ['A', 'B', 'C'];
const KINDS = ['rss', 'atom'];
const STATUSES = ['cho_duyet', 'duyet'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DROP_Q = new Set(['fbclid', 'gclid', 'zarsrc']);
// Ký tự điều khiển C0/C1 + line/para separator + zero-width + bidi.
// biome-ignore lint/suspicious/noControlCharactersInRegex: chủ đích lọc ký tự điều khiển
const CTRL_RE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const WS_RUN = new RegExp(`[${S}]+`, 'gu');
const INSERT =
  'insert into intel_items (url, domain, source, tier, title, snippet, summary, published_at,' +
  ' content_sha256, topics, flags) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)' +
  ' on conflict do nothing';
const LLM_PROMPT =
  'Tóm tắt tin sau trong 1-2 câu tiếng Việt, trung tính, tối đa 250 ký tự. Không thêm thông' +
  ' tin ngoài tin, không nêu công dụng sức khỏe.';

/** Host thuộc HARD_BLOCK / tầng C / scheme lạ — không gửi request. */
export class BlockedDomain extends Error {
  override name = 'BlockedDomain';
}
/** Hết ngân sách --max-requests. */
export class BudgetExhausted extends Error {
  override name = 'BudgetExhausted';
}
/** Feed không parse được (XML hỏng, DOCTYPE, encoding lạ). */
export class FeedError extends RangeError {
  override name = 'FeedError';
}

export type Resp = { status: number | string; body: Uint8Array | null; location: string | null };
export type Log = (s: string) => void;

const cpHead = (s: string, n: number): string => {
  if (s.length <= n) return s;
  return [...s].slice(0, n).join('');
};

/** Python `_clean`: bỏ ký tự điều khiển + gom khoảng trắng + cắt n (in/log an toàn). */
export function clean(s: unknown, n = 300): string {
  return cpHead(pyStrip(String(s).replace(CTRL_RE, ' ').replace(WS_RUN, ' ')), n);
}

/** Số thực kiểu Python khi in JSON (`1.0`, không phải `1`). */
class PyFloat {
  constructor(readonly v: number) {}
}

function dumps(v: unknown): string {
  if (v instanceof PyFloat) {
    return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
  }
  if (Array.isArray(v)) return `[${v.map(dumps).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${dumps(x)}`)
      .join(', ')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

export function emit(log: Log, tag: string, d: Record<string, unknown>): void {
  log(`[${tag}] ${dumps(d)}`);
}

/** Python `round(x)` (làm tròn về số chẵn). */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const r = x - f;
  if (r > 0.5) return f + 1;
  if (r < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function normHost(h0: string): string {
  let h = pyStrip((h0 ?? '').normalize('NFKC'));
  if (h.includes('://')) {
    try {
      h = urlsplit(h).netloc;
    } catch {
      return '';
    }
  }
  h = h.slice(h.lastIndexOf('@') + 1);
  if (h.startsWith('[')) h = h.slice(1).split(']')[0] as string;
  else if (h.split(':').length === 2) h = h.split(':')[0] as string;
  return h.toLowerCase().replace(/\.+$/, '');
}

/** True nếu host (hoặc URL) thuộc HARD_BLOCK ∪ extra — khớp hậu tố theo nhãn, KHÔNG substring
 * (`shopee.vn.evil.com`, `notshopee.vn` → false). */
export function isBlocked(host: string, extra: readonly string[] = []): boolean {
  const h = normHost(host);
  if (!h) return false;
  for (const d0 of [...HARD_BLOCK, ...extra]) {
    const d = normHost(d0);
    if (d && (h === d || h.endsWith(`.${d}`))) return true;
  }
  return false;
}

export type Source = {
  id: string;
  tier: string;
  url: string;
  kind: string;
  status: string;
  [k: string]: unknown;
};
export type SourcesCfg = {
  topics: Record<string, string[]>;
  llm: { enabled: boolean; [k: string]: unknown };
  sources: Source[];
  [k: string]: unknown;
};

/** Host các nguồn tầng C (bỏ 'www.' để chặn cả domain). */
export function tierCHosts(cfg: { sources?: unknown }): string[] {
  const out: string[] = [];
  for (const s of (Array.isArray(cfg.sources) ? cfg.sources : []) as Record<string, unknown>[]) {
    if (s?.tier === 'C') {
      const h = normHost(typeof s.url === 'string' ? s.url : '');
      out.push(h.startsWith('www.') ? h.slice(4) : h);
    }
  }
  return out.filter((h) => h);
}

const CONTACT_RE = new RegExp(`^[^${S}()<>@]{1,64}@[^${S}()<>@]{1,190}$`, 'u');

function contact(env: Env, gatewayFile: string): string {
  const c = pyStrip(env.INTEL_CONTACT ?? '');
  if (CONTACT_RE.test(c)) return c;
  try {
    const allow = (JSON.parse(readFileSync(gatewayFile, 'utf8')) as { pii_allow: unknown })
      .pii_allow;
    if (!Array.isArray(allow)) return 'unknown';
    const a = allow.find((x) => typeof x === 'string' && x.includes('@'));
    return typeof a === 'string' ? a : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function userAgent(env: Env = process.env, gatewayFile = GATEWAY_FILE): string {
  return `${UA_TOKEN}/0.1 (+mailto:${contact(env, gatewayFile)})`;
}

// ---------------------------------------------------------------- nguồn

/** Tên lỗi Python tương ứng (OSError/ValueError của `json.loads(read_bytes().decode())`). */
function pyErrName(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code) return 'OSError';
  return e instanceof SyntaxError ? 'JSONDecodeError' : 'UnicodeDecodeError';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Đọc + kiểm file nguồn. Fail-closed: bất kỳ lỗi nào → [null, errors] — errors nêu id + field,
 * không in giá trị dài. */
export function loadSources(path: string): [SourcesCfg | null, string[]] {
  const name = basename(path);
  let cfg: unknown;
  try {
    // ignoreBOM: giữ BOM → JSON.parse lỗi như `json.loads` của Python (fail-closed, không tự bỏ BOM).
    cfg = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );
  } catch (e) {
    return [null, [`${name}: không đọc được (${pyErrName(e)})`]];
  }
  if (!isObj(cfg)) return [null, [`${name}: gốc phải là object`]];
  const errs: string[] = [];
  const topics = cfg.topics;
  if (!isObj(topics) || !Object.keys(topics).length) errs.push('topics: rỗng hoặc sai kiểu');
  else {
    for (const [t, ph] of Object.entries(topics)) {
      if (
        !Array.isArray(ph) ||
        !ph.length ||
        !ph.every((p) => typeof p === 'string' && pyStrip(p) !== '')
      ) {
        errs.push(`topics.${clean(t, 40)}: 0 cụm hoặc cụm rỗng`);
      }
    }
  }
  const llm = Object.hasOwn(cfg, 'llm') ? cfg.llm : { enabled: false };
  if (!isObj(llm) || typeof llm.enabled !== 'boolean') errs.push('llm.enabled: phải là true/false');
  let srcs = cfg.sources;
  if (!Array.isArray(srcs) || !srcs.length) {
    errs.push('sources: rỗng hoặc sai kiểu');
    srcs = [];
  }
  const seen = new Set<string>();
  (srcs as unknown[]).forEach((s, i) => {
    if (!isObj(s)) {
      errs.push(`sources[${i}]: phải là object`);
      return;
    }
    let sid = s.id;
    if (typeof sid !== 'string' || !ID_RE.test(sid)) {
      errs.push(`sources[${i}].id: thiếu/sai dạng [a-z0-9_-]`);
      sid = `#${i}`;
    } else if (seen.has(sid)) errs.push(`${sid}.id: trùng`);
    seen.add(sid as string);
    if (!TIERS.includes(s.tier as string)) errs.push(`${sid}.tier: phải là A|B|C`);
    const url = s.url;
    let ok = false;
    if (typeof url === 'string') {
      try {
        const u = urlsplit(url);
        ok =
          ['http', 'https'].includes(u.scheme) && !!netlocHost(u.netloc) && cpLen(url) <= MAX_URL;
      } catch {
        ok = false;
      }
    }
    if (!ok) errs.push(`${sid}.url: phải là http(s) có host`);
    if (!KINDS.includes(s.kind as string)) errs.push(`${sid}.kind: phải là rss|atom`);
    if (!STATUSES.includes(s.status as string)) errs.push(`${sid}.status: phải là cho_duyet|duyet`);
  });
  if (errs.length) return [null, errs];
  if (!Object.hasOwn(cfg, 'llm')) cfg.llm = { enabled: false };
  return [cfg as SourcesCfg, []];
}

// ---------------------------------------------------------------- fetcher

/** Phản hồi thô của transport (không tự giải nén, không tự theo redirect). */
export type RawResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
};
/** Lỗi mạng/giao thức — tên kiểu như httpx (`error:<Tên>` trong log). */
export class TransportError extends Error {}
export type Transport = (
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<RawResponse>;

function errName(e: NodeJS.ErrnoException): string {
  if (e instanceof TransportError) return e.name;
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') {
    return 'ConnectError';
  }
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return 'ReadError';
  return 'RemoteProtocolError';
}

/** Transport mặc định: node:http(s), timeout 10 s mỗi bước (như httpx.Timeout(10)). */
export const nodeTransport: Transport = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers, timeout: timeoutMs });
    req.on('timeout', () => {
      const e = new TransportError('timeout');
      e.name = 'ReadTimeout';
      req.destroy(e);
    });
    req.on('error', (e) => {
      const t = new TransportError(e.message);
      t.name = errName(e as NodeJS.ErrnoException);
      reject(t);
    });
    req.on('response', (res) => {
      res.on('error', () => {});
      const hs: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) hs[k] = Array.isArray(v) ? v.join(', ') : v;
      resolve({
        status: res.statusCode ?? 0,
        headers: hs,
        body: (async function* () {
          try {
            for await (const c of res) yield c as Uint8Array;
          } catch (e) {
            const t = new TransportError((e as Error).message);
            t.name = errName(e as NodeJS.ErrnoException);
            throw t;
          }
        })(),
        close: () => res.destroy(),
      });
    });
    req.end();
  });

/** httpx dựng `next_request` cho MỌI redirect kể cả khi không theo: Location host sai (IPv6/IPv4/
 * port hỏng, ký tự điều khiển) → RemoteProtocolError ngay ở bước gửi. */
function httpxRejectsLocation(loc: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: httpx chặn ký tự không in được
  if (/[\x00-\x1f\x7f]/.test(loc)) return true;
  const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)/.exec(loc);
  if (!m) return false;
  const hp = (m[1] as string).slice((m[1] as string).lastIndexOf('@') + 1);
  let host: string;
  let port: string;
  if (hp.startsWith('[')) {
    const e = hp.indexOf(']');
    if (e < 0) return false;
    host = hp.slice(1, e);
    if (!isIPv6(host)) return true;
    port = hp.slice(e + 1).replace(/^:/, '');
  } else {
    const c = hp.indexOf(':');
    host = c < 0 ? hp : hp.slice(0, c);
    port = c < 0 ? '' : hp.slice(c + 1);
    if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host) && !isIPv4(host)) return true;
  }
  return port !== '' && !/^[0-9]+$/.test(port);
}

/** Member gzip ĐẦU (header RFC 1952 + deflate + 8 byte CRC/ISIZE). Python `decompressobj` dừng ở
 * member đầu, phần sau vào `unused_data`; Node gunzip lại nối mọi member và ném lỗi với rác đuôi →
 * cắt trước. Không xác định được (header dở/deflate lỗi/vượt trần) → cả raw để gunzip tự báo lỗi
 * theo đúng thứ tự zlib (header trước, rồi trần). */
function firstGzipMember(raw: Uint8Array, cap: number): Uint8Array {
  if (raw.length < 10 || raw[0] !== 0x1f || raw[1] !== 0x8b) return raw;
  const flg = raw[3] as number;
  let p = 10;
  if (flg & 4) p += 2 + ((raw[p] ?? 0) | ((raw[p + 1] ?? 0) << 8)); // FEXTRA
  for (const bit of [8, 16]) {
    // FNAME, FCOMMENT: chuỗi kết thúc 0
    if (flg & bit) {
      const z = raw.indexOf(0, p);
      if (z < 0) return raw;
      p = z + 1;
    }
  }
  if (flg & 2) p += 2; // FHCRC
  if (p >= raw.length) return raw;
  try {
    const r = inflateRawSync(raw.subarray(p), {
      info: true,
      finishFlush: zc.Z_SYNC_FLUSH,
      maxOutputLength: cap + 1,
    }) as unknown as { engine: { bytesWritten: number } };
    return raw.subarray(0, p + r.engine.bytesWritten + 8);
  } catch {
    return raw;
  }
}

/** Giải nén gzip có trần: tối đa cap+1 byte (bom nén không bung hết), chỉ member đầu như Python. */
export function gunzipCapped(
  raw: Uint8Array,
  cap: number,
): Uint8Array | 'too_large' | 'bad_encoding' {
  try {
    return gunzipSync(firstGzipMember(raw, cap), {
      finishFlush: zc.Z_SYNC_FLUSH,
      maxOutputLength: cap + 1,
    });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError
      ? 'too_large'
      : 'bad_encoding';
  }
}

export type FetcherOpts = {
  budget?: number;
  extraBlock?: readonly string[];
  transport?: Transport;
  /** ngủ s giây (test: đồng hồ giả) */
  sleep?: (s: number) => Promise<void>;
  /** giây đơn điệu (test: đồng hồ giả — không assert wall-clock) */
  clock?: () => number;
  log?: Log;
  maxBytes?: number;
  robotsMax?: number;
  env?: Env;
  gatewayFile?: string;
};

type Checked = { u: URL; host: string };

/** GET tuần tự, an toàn: chặn cứng, robots, nhịp/host, trần, ngân sách. */
export class Fetcher {
  readonly budget: number;
  readonly extra: string[];
  private readonly transport: Transport;
  private readonly sleep: (s: number) => Promise<void>;
  private readonly clock: () => number;
  readonly log: Log;
  private readonly maxBytes: number;
  private readonly robotsMax: number;
  private readonly headers: Record<string, string>;
  used = 0;
  blocked = 0;
  robotsDeny = 0;
  private readonly last = new Map<string, number>();
  private readonly delay = new Map<string, number>();
  private readonly robots = new Map<string, RobotFileParser | null>();
  private readonly dead = new Set<string>();

  constructor(o: FetcherOpts = {}) {
    this.budget = o.budget ?? DEFAULT_MAX_REQUESTS;
    this.extra = [...(o.extraBlock ?? [])];
    this.transport = o.transport ?? nodeTransport;
    this.sleep = o.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
    this.clock = o.clock ?? (() => performance.now() / 1000);
    this.log = o.log ?? ((s) => console.log(s));
    this.maxBytes = o.maxBytes ?? MAX_BYTES;
    this.robotsMax = o.robotsMax ?? ROBOTS_MAX;
    this.headers = {
      'User-Agent': userAgent(o.env ?? process.env, o.gatewayFile),
      'Accept-Encoding': 'gzip',
    };
  }

  close(): void {}

  /** URL → (URL, host). Chặn → log [blocked] + BlockedDomain. */
  private check(url: string, source: string): Checked {
    let u: URL | null = null;
    let hosts: string[];
    let schemeOk: boolean;
    try {
      u = new URL(url);
      const h = u.hostname;
      hosts = [h, domainToUnicode(h) || h];
      schemeOk = (u.protocol === 'http:' || u.protocol === 'https:') && !!h;
    } catch {
      hosts = [normHost(url)];
      schemeOk = false;
    }
    let reason: string | null = null;
    if (!schemeOk) reason = 'scheme';
    else if (hosts.some((h) => isBlocked(h))) reason = 'hard';
    else if (hosts.some((h) => isBlocked(h, this.extra))) reason = 'tier_c';
    const host = u?.hostname ? normHost(u.hostname) : '';
    if (reason) {
      this.blocked += 1;
      emit(this.log, 'blocked', { source, host: clean(host || url, 200), reason });
      throw new BlockedDomain(host);
    }
    return { u: u as URL, host };
  }

  /** GET 1 URL nội dung (kiểm robots). null = bỏ (robots cấm/lỗi). */
  fetch(url: string, source: string): Promise<Resp | null> {
    return this.get(url, source, 'feed', true, this.maxBytes);
  }

  private async get(
    url0: string,
    source: string,
    kind: string,
    robotsCheck: boolean,
    cap: number,
  ): Promise<Resp | null> {
    let url = url0;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const { u, host } = this.check(url, source);
      const origin = `${u.protocol.slice(0, -1)}://${u.host}`;
      if (this.dead.has(origin)) {
        this.log(`[warn] ${clean(source, 64)}: bỏ ${clean(origin, 200)} (đã lỗi/429 trong lượt)`);
        return null;
      }
      if (robotsCheck) {
        const rp = await this.robotsFor(origin, host, source);
        if (rp === null) return null;
        if (!rp.canFetch(UA_TOKEN, u.href)) {
          this.robotsDeny += 1;
          emit(this.log, 'robots-deny', { source, url: clean(u.href) });
          return null;
        }
      }
      const r = await this.send(u, host, source, kind, robotsCheck, cap);
      if (r === null) return null;
      if (typeof r.status === 'number' && REDIRECTS.has(r.status) && r.location) {
        try {
          url = urljoin(u.href, r.location);
        } catch {
          this.log(`[warn] ${clean(source, 64)}: redirect Location hỏng — bỏ`);
          return null;
        }
        continue;
      }
      if (r.status === 429) this.dead.add(origin);
      return r;
    }
    this.log(`[warn] ${clean(source, 64)}: quá ${MAX_HOPS} redirect — bỏ`);
    return null;
  }

  private async robotsFor(
    origin: string,
    host: string,
    source: string,
  ): Promise<RobotFileParser | null> {
    if (this.robots.has(origin)) return this.robots.get(origin) ?? null;
    let rp: RobotFileParser | null = null;
    let r: Resp | null;
    try {
      r = await this.get(`${origin}/robots.txt`, source, 'robots', false, this.robotsMax);
    } catch (e) {
      if (!(e instanceof BlockedDomain)) throw e;
      r = null;
    }
    const st = r !== null ? r.status : null;
    if (typeof st === 'number' && st >= 200 && st < 300 && r?.body) {
      rp = new RobotFileParser();
      rp.parse(splitlines(new TextDecoder('utf-8', { ignoreBOM: true }).decode(r.body)));
      const cd = rp.crawlDelay(UA_TOKEN);
      if (cd && cd > CRAWL_DELAY_S) this.delay.set(host, Math.min(cd, 60));
    } else if (st === 401 || st === 403) {
      rp = new RobotFileParser();
      rp.disallowAll = true;
    } else if (typeof st === 'number' && st >= 400 && st < 500 && st !== 429) {
      rp = new RobotFileParser();
      rp.allowAll = true;
    }
    if (rp === null) {
      this.dead.add(origin);
      this.log(
        `[warn] ${clean(source, 64)}: robots.txt của ${clean(origin, 200)} không đọc được` +
          ` (${st === null ? 'None' : st}) — bỏ host cả lượt`,
      );
    }
    this.robots.set(origin, rp);
    return rp;
  }

  private async send(
    u: URL,
    host: string,
    source: string,
    kind: string,
    robotsOk: boolean,
    cap: number,
  ): Promise<Resp | null> {
    if (this.used >= this.budget) throw new BudgetExhausted();
    const need = this.delay.get(host) ?? CRAWL_DELAY_S;
    const prev = this.last.get(host);
    if (prev !== undefined) {
      for (let gap = this.clock() - prev; gap < need; gap = this.clock() - prev) {
        await this.sleep(Math.max(need - gap, 0.001));
      }
    }
    const start = this.clock();
    this.last.set(host, start);
    this.used += 1;
    let status: number | string | null = null;
    let body: Uint8Array | null = null;
    let loc: string | null = null;
    let nbytes = 0;
    let res: RawResponse | null = null;
    try {
      res = await this.transport(u, this.headers, TIMEOUT_S * 1000);
      status = res.status;
      loc = res.headers.location ?? null;
      if (REDIRECTS.has(res.status) && loc !== null && httpxRejectsLocation(loc)) {
        throw Object.assign(new TransportError('Invalid URL in location header'), {
          name: 'RemoteProtocolError',
        });
      }
      if (res.status >= 200 && res.status < 300)
        [status, body, nbytes] = await this.read(res, cap, start);
    } catch (e) {
      status = `error:${e instanceof TransportError ? e.name : 'TransportError'}`;
      body = null;
    } finally {
      res?.close();
    }
    emit(this.log, 'req', {
      ts: `${new Date().toISOString().slice(0, 19)}+00:00`,
      source,
      host,
      kind,
      url: clean(u.href),
      status,
      robots_ok: robotsOk ? true : null,
      bytes: nbytes,
      ms: pyRound((this.clock() - start) * 1000),
      gap_s: prev === undefined ? null : new PyFloat(Number((start - prev).toFixed(3))),
    });
    if (typeof status === 'string' && status.startsWith('error:')) return null;
    return { status: status as number | string, body, location: loc };
  }

  /** Đọc body có trần → [status, body|null, số byte đã nhận]. */
  private async read(
    r: RawResponse,
    cap: number,
    start: number,
  ): Promise<[number | string, Uint8Array | null, number]> {
    const cl = pyStrip(r.headers['content-length'] ?? '');
    if (/^[0-9]+$/.test(cl) && (cl.length > 18 || Number(cl) > cap)) return ['too_large', null, 0];
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const chunk of r.body) {
      parts.push(chunk);
      n += chunk.length;
      if (n > cap) return ['too_large', null, n];
      if (this.clock() - start > TOTAL_S) return ['timeout', null, n];
    }
    const raw = Buffer.concat(parts);
    // Python `(… or "identity")`: header rỗng cũng là identity.
    const enc = pyStrip(r.headers['content-encoding'] || 'identity').toLowerCase();
    if (enc === 'gzip' || enc === 'x-gzip') {
      const out = gunzipCapped(raw, cap);
      if (typeof out === 'string') return [out, null, n];
      if (out.length > cap) return ['too_large', null, n];
      return [r.status, out, n];
    }
    if (enc !== 'identity') return ['bad_encoding', null, n];
    return [r.status, new Uint8Array(raw), n];
  }
}

// ---------------------------------------------------------------- parse

export type Entry = { title: string; link: string; desc: string; published: string };

/** bytes RSS 2.0 / Atom → [{title, link, desc, published}] (≤200). Từ chối DOCTYPE/ENTITY (chặn
 * entity expansion) + UTF-16/32. */
export function parse(data: Uint8Array): Entry[] {
  if (
    (data[0] === 0xff && data[1] === 0xfe) ||
    (data[0] === 0xfe && data[1] === 0xff) ||
    data.subarray(0, 200).includes(0)
  ) {
    throw new FeedError('encoding UTF-16/32 không hỗ trợ');
  }
  if (/<!(?:doctype|entity)/i.test(Buffer.from(data).toString('latin1'))) {
    throw new FeedError('feed có DOCTYPE/ENTITY — từ chối');
  }
  let root: XEl;
  try {
    root = parseXml(data);
  } catch (e) {
    // Python `except (ET.ParseError, LookupError, ValueError)` — RangeError ≈ ValueError: 1 feed hỏng
    // chỉ bỏ nguồn đó, không làm chết cả lượt.
    if (!(e instanceof XmlError || e instanceof RangeError)) throw e;
    throw new FeedError(`XML hỏng (${clean(e.message, 80)})`);
  }
  const out: Entry[] = [];
  const rootName = localName(root.tag);
  if (rootName === 'rss') {
    const ch = child(root, 'channel');
    for (const it of ch ? children(ch) : []) {
      if (localName(it.tag) !== 'item') continue;
      out.push({
        title: itertext(child(it, 'title')),
        link: pyStrip(itertext(child(it, 'link'))),
        desc: itertext(child(it, 'description')),
        published: itertext(child(it, 'pubDate')),
      });
      if (out.length >= MAX_ENTRIES) break;
    }
  } else if (rootName === 'feed') {
    for (const e of children(root)) {
      if (localName(e.tag) !== 'entry') continue;
      let link = '';
      for (const ln of children(e)) {
        if (localName(ln.tag) === 'link' && (ln.attrs.get('rel') ?? 'alternate') === 'alternate') {
          link = pyStrip(ln.attrs.get('href') ?? '');
          break;
        }
      }
      const summ = child(e, 'summary') ?? child(e, 'content');
      const pub = child(e, 'published') ?? child(e, 'updated');
      out.push({
        title: itertext(child(e, 'title')),
        link,
        desc: itertext(summ),
        published: itertext(pub),
      });
      if (out.length >= MAX_ENTRIES) break;
    }
  } else {
    throw new FeedError(`gốc XML lạ <${clean(rootName, 40)}>`);
  }
  return out;
}

/** Như `parse` nhưng lỗi → [warn] + [] (lượt chạy tiếp). */
export function parseFeed(data: Uint8Array, log: Log = console.log): Entry[] {
  try {
    return parse(data);
  } catch (e) {
    if (!(e instanceof FeedError)) throw e;
    log(`[warn] feed bỏ: ${e.message}`);
    return [];
  }
}

const TRAIL_EDGE = /[0-9 .+\-()@]+$/;

const TRAIL_WS = new RegExp(`[${S}]+$`, 'u');
const LAST_WS = new RegExp(`[${S}]+(?=[^${S}]*$)`, 'u');

/** Python `(s.rsplit(None, 1) or [""])[0]`. */
function rsplitHead(s: string): string {
  const parts = pySplit(s);
  if (parts.length <= 1) return parts[0] ?? '';
  const t = s.replace(TRAIL_WS, '');
  return t.slice(0, (LAST_WS.exec(t) as RegExpExecArray).index);
}

/** HTML/thô → text ngắn ≤n: stripHtml → gom trắng → cắt PRE_MAX → maskPii → bỏ ký tự điều khiển
 * → cắt n. Có thể ném ParserRejectedMarkup (HTML hỏng kiểu `<![foo]]>`) như bs4. */
export function cleanText(s0: unknown, n = TEXT_MAX): string {
  let s = cpHead(s0 === null || s0 === undefined || s0 === '' ? '' : String(s0), RAW_MAX);
  if (s.includes('<') || s.includes('&')) s = stripHtml(s);
  s = pyStrip(s.replace(WS_RUN, ' '));
  if (cpLen(s) > PRE_MAX) {
    // Bỏ token dở ở mép + đuôi số/dấu (SĐT/email bị cắt đôi không lọt).
    s = rsplitHead(cpHead(s, PRE_MAX)).replace(TRAIL_EDGE, '');
  }
  return clean(maskPii(s), n);
}

const norm = (s: string): string => casefold(s.normalize('NFC'));

function compile(list: string[]): RegExp | null {
  const parts = [...new Set(list)]
    .sort((a, b) => cpLen(b) - cpLen(a))
    .map((p) => {
      const body = pySplit(p).map(reEscape).join(`[${S}]+`);
      const chars = [...p];
      const pre = isAlnum(chars[0] as string) ? `(?<![${W}])` : '';
      const post = isAlnum(chars[chars.length - 1] as string) ? `(?![${W}])` : '';
      return pre + body + post;
    });
  return parts.length ? re(parts.join('|')) : null;
}

type Compiled = [RegExp | null, RegExp | null, RegExp | null];
const topicCache = new Map<string, [string, Compiled][]>();

function compileTopics(topics: Record<string, string[]>): [string, Compiled][] {
  const key = JSON.stringify(
    Object.keys(topics)
      .sort()
      .map((k) => [k, topics[k]]),
  );
  const hit = topicCache.get(key);
  if (hit) return hit;
  const out: [string, Compiled][] = [];
  for (const t of Object.keys(topics).sort()) {
    const ph = (topics[t] ?? []).filter((p) => pyStrip(p)).map((p) => norm(pyStrip(p)));
    const acc = ph.filter((p) => stripAccents(p) !== p);
    const asc = ph.filter((p) => stripAccents(p) === p);
    out.push([t, [compile(acc), compile(asc), compile(acc.map(stripAccents))]]);
  }
  if (topicCache.size >= 8) topicCache.delete(topicCache.keys().next().value as string);
  topicCache.set(key, out);
  return out;
}

/** (chủ đề, cờ) theo LUẬT. Cụm có dấu khớp text có dấu; cụm ASCII khớp bản bỏ dấu; bản bỏ dấu tự
 * sinh của cụm có dấu CHỈ áp khi text hoàn toàn không dấu ("săm lốp" không thành "sâm"). Cờ: `ruou`
 * (kb-filter — ném KbFilterError khi keyword hỏng), `suc_khoe` (isHealthQuestion). */
export function classify(
  title: string,
  snippet: string,
  topics: Record<string, string[]>,
): [string[], string[]] {
  const text = `${title || ''} ${snippet || ''}`;
  const t = norm(text);
  const plain = stripAccents(t);
  const bare = plain === t;
  const hit: string[] = [];
  for (const [name, [acc, asc, derived]] of compileTopics(topics)) {
    if (acc?.test(t) || asc?.test(plain) || (bare && derived?.test(plain))) hit.push(name);
  }
  const flags: string[] = [];
  if (isAlcohol(text)) flags.push('ruou');
  if (isHealthQuestion(text)) flags.push('suc_khoe');
  return [hit.sort(), flags];
}

/** scheme/host lowercase, bỏ port mặc định/userinfo/fragment, bỏ query utm_*\/fbclid/gclid/zarsrc,
 * sort query còn lại, bỏ '/' cuối path. Ném UrlError (Python ValueError) khi URL hỏng. */
export function normalizeUrl(url: string): string {
  const s = urlsplit(pyStrip(url));
  const scheme = s.scheme.toLowerCase();
  let host = (netlocHost(s.netloc) ?? '').toLowerCase().replace(/\.+$/, '');
  if (host.includes(':')) host = `[${host}]`;
  const port = netlocPort(s.netloc);
  if (port && !((scheme === 'http' && port === 80) || (scheme === 'https' && port === 443))) {
    host += `:${port}`;
  }
  const q = parseQsl(s.query, true)
    .filter(([k]) => !(k.toLowerCase().startsWith('utm_') || DROP_Q.has(k.toLowerCase())))
    .sort((a, b) => cmpPy(a[0], b[0]) || cmpPy(a[1], b[1]));
  let path = s.path || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  return urlunsplit({ scheme, netloc: host, path, query: urlencode(q), fragment: '' });
}

/** So sánh chuỗi theo code point (Python `sorted`). */
function cmpPy(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

export function contentSha(title: string, snippet: string): string {
  const n = (s: string) => pyStrip(norm(s || '').replace(WS_RUN, ' '));
  return createHash('sha256')
    .update(`${n(title)}\n${n(snippet)}`, 'utf8')
    .digest('hex');
}

export type Item = {
  url: string;
  domain: string;
  source: string;
  tier: string;
  title: string;
  snippet: string | null;
  summary: string | null;
  published_at: PyDateTime | null;
  content_sha256: string;
  topics: string[];
  flags: string[];
};

/** entries feed → [tin để lưu, số tin 0 chủ đề]. KHÔNG GET link. */
export function buildItems(
  entries: Entry[],
  src: { id: string; tier: string },
  baseUrl: string,
  topics: Record<string, string[]>,
  now?: Date,
): [Item[], number] {
  const items: Item[] = [];
  let off = 0;
  for (const e of entries) {
    const title = cleanText(e.title);
    let url: string;
    let host: string | null;
    let scheme: string;
    try {
      // urljoin cũng ném lỗi (host ngoặc hỏng "http://[::1") — 1 link hỏng chỉ bỏ entry đó.
      const link = urljoin(baseUrl, pyStrip(e.link || ''));
      url = normalizeUrl(link);
      const parts = urlsplit(url);
      host = netlocHost(parts.netloc);
      scheme = parts.scheme;
    } catch (err) {
      if (err instanceof RangeError) continue;
      throw err;
    }
    if (!title || !['http', 'https'].includes(scheme) || !host || cpLen(url) > MAX_URL) continue;
    const snippet = cleanText(e.desc);
    const [tps, flags] = classify(title, snippet, topics);
    if (!tps.length) {
      off += 1;
      continue;
    }
    items.push({
      url,
      domain: host,
      source: src.id,
      tier: src.tier,
      title,
      snippet: snippet || null,
      summary: null,
      published_at: parseDate(e.published, now),
      content_sha256: contentSha(title, snippet),
      topics: tps,
      flags,
    });
  }
  return [items, off];
}

// ---------------------------------------------------------------- lưu

export type StoreRes = { new: number; dup_url: number; dup_content: number };
type Client = Pick<pg.PoolClient, 'query'>;

/** Insert-only, idempotent. Chống trùng theo url chuẩn hóa + content_sha256 (tra trước trong cùng
 * tx, kể cả trùng trong lô). `enrich(item)` chạy CHỈ cho tin mới trước khi insert (LLM). 1 tx. */
export async function storeItems(
  c: Client,
  items: Item[],
  enrich?: (it: Item) => Promise<void>,
): Promise<StoreRes> {
  const res: StoreRes = { new: 0, dup_url: 0, dup_content: 0 };
  if (!items.length) return res;
  await c.query('begin');
  try {
    const urls = new Set(
      (
        await c.query<{ url: string }>('select url from intel_items where url = any($1::text[])', [
          items.map((i) => i.url),
        ])
      ).rows.map((r) => r.url),
    );
    const shas = new Set(
      (
        await c.query<{ content_sha256: string }>(
          'select content_sha256 from intel_items where content_sha256 = any($1::text[])',
          [items.map((i) => i.content_sha256)],
        )
      ).rows.map((r) => r.content_sha256),
    );
    for (const it of items) {
      if (urls.has(it.url)) {
        res.dup_url += 1;
        continue;
      }
      if (shas.has(it.content_sha256)) {
        res.dup_content += 1;
        continue;
      }
      urls.add(it.url);
      shas.add(it.content_sha256);
      if (enrich) await enrich(it);
      const r = await c.query(INSERT, [
        it.url,
        it.domain,
        it.source,
        it.tier,
        it.title,
        it.snippet,
        it.summary,
        it.published_at ? toDate(it.published_at) : null,
        it.content_sha256,
        it.topics,
        it.flags,
      ]);
      if (r.rowCount === 1) res.new += 1;
      else res.dup_url += 1;
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  }
  return res;
}

export type ChatFn = (
  agentId: string,
  messages: { role: 'system' | 'user'; content: string }[],
  opts: { feature: string; maxTokens?: number },
) => Promise<{ text: unknown }>;

/** Tóm tắt tùy chọn qua AI Gateway (agent 'intel'); lỗi gateway → tắt phần còn lại của lượt, tin
 * vẫn lưu. Guardrail chạy trên CHUỖI ĐÃ LÀM SẠCH và lưu đúng chuỗi đó (stripHtml giải mã entity:
 * "&#99;hữa" → "chữa" — kiểm text thô rồi lưu bản sạch = lọt từ cấm). */
export class LlmEnricher {
  n = 0;
  off = false;
  constructor(
    private readonly chat: ChatFn,
    private readonly log: Log,
  ) {}

  call = async (it: Item): Promise<void> => {
    if (this.off || this.n >= LLM_MAX_ITEMS) return;
    this.n += 1;
    const msgs = [
      { role: 'system' as const, content: LLM_PROMPT },
      { role: 'user' as const, content: `${it.title}\n${it.snippet || ''}` },
    ];
    let text: unknown;
    try {
      text = (await this.chat('intel', msgs, { maxTokens: 200, feature: FEATURE }))?.text;
    } catch (e) {
      if (e instanceof GatewayError) {
        this.log(`[warn] LLM tắt phần còn lại của lượt (${e.name})`);
        this.off = true;
        return;
      }
      throw e;
    }
    const s = typeof text === 'string' ? cleanText(text) : '';
    if (!s) return;
    if (guardrailCheck(s).ok !== true) {
      it.flags = [...it.flags, 'llm_guardrail_fail'];
      return;
    }
    it.summary = s;
  };
}

export type Health = { detail?: string };

/** Một lượt thu: mỗi nguồn 1 feed → parse → lọc chủ đề → lưu. Exit 1 nếu có nguồn mà 0 nguồn
 * thành công. `health.detail` = "fail=<id,...> robots_deny=N blocked=N" (chỉ id cấu hình). */
export async function run(
  c: Client,
  cfg: SourcesCfg,
  sources: Source[],
  fetcher: Fetcher,
  chat: ChatFn | null,
  log: Log,
  health?: Health,
): Promise<number> {
  const st = { ok: 0, new: 0, dup_url: 0, dup_content: 0, off_topic: 0 };
  const enrich = chat ? new LlmEnricher(chat, log).call : undefined;
  const fails: string[] = [];
  for (const src of sources) {
    const sid = src.id;
    let r: Resp | null;
    try {
      r = await fetcher.fetch(src.url, sid);
    } catch (e) {
      if (e instanceof BlockedDomain) {
        fails.push(sid);
        continue;
      }
      if (e instanceof BudgetExhausted) {
        log(`[warn] hết ngân sách --max-requests ${fetcher.budget} — dừng lượt`);
        break;
      }
      throw e;
    }
    if (r === null || r.status !== 200 || r.body === null) {
      fails.push(sid);
      if (r !== null) log(`[warn] ${sid}: feed status ${r.status} — bỏ nguồn`);
      continue;
    }
    let entries: Entry[];
    try {
      entries = parse(r.body);
    } catch (e) {
      if (!(e instanceof FeedError)) throw e;
      log(`[warn] ${sid}: ${e.message} — bỏ nguồn`);
      fails.push(sid);
      continue;
    }
    const [items, off] = buildItems(entries, src, src.url, cfg.topics);
    const res = await storeItems(c, items, enrich);
    st.ok += 1;
    st.off_topic += off;
    st.new += res.new;
    st.dup_url += res.dup_url;
    st.dup_content += res.dup_content;
    log(`[src] ${sid}: ${entries.length} tin, ${items.length} đúng chủ đề, mới ${res.new}`);
  }
  log(
    `[done] sources=${sources.length} ok=${st.ok} requests=${fetcher.used} new=${st.new}` +
      ` dup_url=${st.dup_url} dup_content=${st.dup_content} off_topic=${st.off_topic}` +
      ` blocked=${fetcher.blocked} robots_deny=${fetcher.robotsDeny}`,
  );
  if (health) {
    health.detail =
      `fail=${fails.join(',') || '-'} robots_deny=${fetcher.robotsDeny}` +
      ` blocked=${fetcher.blocked}`;
  }
  return sources.length && st.ok === 0 ? 1 : 0;
}

/** Ngày VN 'YYYY-MM-DD' của mốc; ngoài năm 1..9999 (Python OverflowError) → '?'. */
function vnDay(d: unknown): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '?';
  const v = new Date(d.getTime() + 7 * 3600_000);
  const y = v.getUTCFullYear();
  if (y < 1 || y > 9999) return '?';
  return `${String(y).padStart(4, '0')}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

/** `--report`: tóm tắt intel_items (chỉ đọc). */
export async function report(c: Client, log: Log): Promise<void> {
  const total = Number(
    (await c.query<{ n: string }>('select count(*) as n from intel_items')).rows[0]?.n ?? 0,
  );
  if (!total) {
    log('chưa có tin trong intel_items');
    return;
  }
  log(`Tổng tin: ${total}`);
  const groups: [string, string][] = [
    ['Theo tầng', 'select tier as k, count(*) as n from intel_items group by 1 order by 1'],
    [
      'Theo nguồn',
      'select source as k, count(*) as n from intel_items group by 1 order by 2 desc, 1',
    ],
    [
      'Theo chủ đề',
      'select t as k, count(*) as n from intel_items, unnest(topics) t group by 1 order by 2 desc, 1',
    ],
    [
      'Cờ',
      "select f as k, count(*) as n from intel_items, unnest(flags) f where f in ('ruou', 'suc_khoe') group by 1 order by 1",
    ],
  ];
  for (const [label, sql] of groups) {
    const rows = (await c.query<{ k: string; n: string }>(sql)).rows;
    log(`${label}: ${rows.map((r) => `${clean(r.k, 40)}=${r.n}`).join(', ') || '—'}`);
  }
  log('10 tin mới nhất:');
  const rows = (
    await c.query<{
      published_at: unknown;
      source: string;
      topics: string[];
      title: string;
      url: string;
    }>(
      'select published_at, source, topics, title, url from intel_items order by fetched_at desc, id desc limit 10',
    )
  ).rows;
  for (const r of rows) {
    const day = r.published_at ? vnDay(r.published_at) : '?';
    log(
      `  ${day} [${clean(r.source, 40)}] ${clean(r.topics.join(','), 60)} | ${clean(r.title, 160)} | ${clean(r.url, 200)}`,
    );
  }
}
