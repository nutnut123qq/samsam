import { type Env, pyStrip } from '@samsam/core/env';
import { isPlainObject } from '@samsam/core/ops/py';
import { hostname, type Split, urlsplit } from '@samsam/core/ops/py-url';
import { pyTruthy } from '@samsam/core/security/py';

// Port connectors/fanpage.py (r16 legal_hr-04 — PL01 Pháp chế "Quét web, Fanpage, listing; mở yêu
// cầu gỡ bài vi phạm trong 24 giờ"): đọc bài ĐÃ ĐĂNG của Fanpage công ty qua Meta Graph API, CHỈ
// ĐỌC. Người dùng duy nhất: `ra_kenh --scan-auto` (nhóm khác). Đặc tả theo tài liệu chính thức
// Graph API v26.0 (đọc 27/10/2026) — CHƯA chạy với Page/token thật (CONTRACT_TESTED server giả):
//   - `GET {base}/v26.0/{page-id}/published_posts?fields=id,message,created_time,permalink_url`,
//     `limit` ≤ 100, `access_token` ở query (cách tài liệu Graph hướng dẫn).
//   - Phân trang cursor: dừng khi KHÔNG còn `paging.next` — trang rỗng/ít hơn limit KHÔNG phải hết;
//     trang sau dựng lại từ `paging.cursors.after` trên CÙNG host/path (không theo URL `next` do
//     server trả — chống lộ token sang host khác).
//   - Lỗi `error.code` (+ `error_subcode`): 190/102 (463/467) token; 10, 200–299 thiếu quyền;
//     1, 2, 4, 17, 341, 368 tạm thời → chờ rồi thử lại.
// Chưa làm: `appsecret_proof`. Chỉ có 1 đường GET dựng URL từ PATH cứng; KHÔNG theo redirect, trần
// byte; lỗi chỉ mang HTTP status + mã số — KHÔNG URL (chứa token), KHÔNG body/message.

export const VERSION = 'v26.0';
export const DEFAULT_BASE = 'https://graph.facebook.com';
export const PATH = '/{page_id}/published_posts';
export const FIELDS = 'id,message,created_time,permalink_url';
export const LIMIT = 100; // trần tài liệu
export const MAX_PAGES = 50; // 5000 bài (~600 bài/năm theo tài liệu)
export const MAX_RESP_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_S = 15;
export const RETRY_MAX = 3;
export const RETRY_WAIT_MAX = 30.0;
export const RETRY_HTTP = [429, 500, 502, 503, 504];
export const TEMP_CODES = new Set([1, 2, 4, 17, 341, 368]);
export const TOKEN_CODES = new Set([190, 102]);
export const ENV_PAGE = 'FANPAGE_PAGE_ID';
export const ENV_TOKEN = 'FANPAGE_READ_TOKEN';
export const ENV_BASE = 'FANPAGE_API_BASE';
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost']; // ingest/market_api.py
const PAGE_RE = /^[0-9]{1,30}$/;
const TOKEN_RE = /^[\x21-\x7e]{8,1024}$/;
const CURSOR_RE = /^[A-Za-z0-9_=-]{1,1024}$/;
const POST_HOSTS = ['facebook.com'];
const ERR_BODY_MAX = 64 * 1024;

/** Lỗi đọc Fanpage — thông điệp KHÔNG chứa URL/token/body. */
export class FanpageError extends Error {
  override name = 'FanpageError';
}

/** Python `ingest.market_api.ConfigError` — thiếu key / base URL sai, chỉ nêu TÊN biến.
 * shortcut: lớp riêng của fanpage, gộp về module market_api khi nhóm đó port. */
export class FanpageConfigError extends Error {
  override name = 'ConfigError';
}

export type FanpageConfig = { pageId: string; token: string; base: string };
export type Post = Record<string, unknown>;

/** Test thay `sleep` (không chờ thật) / `maxPages`. */
export const settings = {
  maxPages: MAX_PAGES,
  sleep: (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000)),
};

// ------------------------------------------------- urllib.parse (urlsplit/hostname ở core ops/py-url)

/** `SplitResult._userinfo` → [username | null, password | null]. */
function userinfo(netloc: string): [string | null, string | null] {
  const at = netloc.lastIndexOf('@');
  if (at < 0) return [null, null];
  const ui = netloc.slice(0, at);
  const c = ui.indexOf(':');
  return c >= 0 ? [ui.slice(0, c), ui.slice(c + 1)] : [ui, null];
}

/** `SplitResult._hostinfo` → [hostname thô, port thô | null]. */
function hostinfo(netloc: string): [string, string | null] {
  const hi = netloc.slice(netloc.lastIndexOf('@') + 1);
  let host: string;
  let port: string;
  const ob = hi.indexOf('[');
  if (ob >= 0) {
    const br = hi.slice(ob + 1);
    const cb = br.indexOf(']');
    host = cb >= 0 ? br.slice(0, cb) : br;
    const rest = cb >= 0 ? br.slice(cb + 1) : '';
    const pc = rest.indexOf(':');
    port = pc >= 0 ? rest.slice(pc + 1) : '';
  } else {
    const c = hi.indexOf(':');
    host = c >= 0 ? hi.slice(0, c) : hi;
    port = c >= 0 ? hi.slice(c + 1) : '';
  }
  return [host, port || null];
}

/** `SplitResult.port`: chỉ chữ số ASCII, 0–65535; sai → RangeError. */
function checkPort(netloc: string): void {
  const p = hostinfo(netloc)[1];
  if (p === null) return;
  if (!/^[0-9]+$/.test(p) || Number(p) > 65535) throw new RangeError('bad port');
}

// ------------------------------------------------- cấu hình

/** Python `market_api.api_base`: base URL đổi được CHỈ cho server giả (`https://<host>` hoặc
 * `http://127.0.0.1|localhost`), không user/pass/path/query/fragment. */
export function apiBase(variable: string, dflt: string, env: Env = process.env): string {
  const raw = pyStrip(env[variable] ?? '') || dflt;
  let u: Split;
  let host: string | null;
  try {
    u = urlsplit(raw);
    host = hostname(u.netloc);
    checkPort(u.netloc);
  } catch {
    throw new FanpageConfigError(`${variable} không hợp lệ`);
  }
  const [user, pass] = userinfo(u.netloc);
  const ok =
    Boolean(host) &&
    (u.scheme === 'https' || (u.scheme === 'http' && LOCAL_HOSTS.includes(host as string)));
  if (!ok || user || pass || u.query || u.fragment || !['', '/'].includes(u.path)) {
    throw new FanpageConfigError(
      `${variable} không hợp lệ — chỉ https://<host> hoặc http://127.0.0.1|localhost (server giả)`,
    );
  }
  return `${u.scheme}://${u.netloc}`;
}

/** Env → cấu hình | null khi CHƯA cấu hình (cả 2 biến trống). Cấu hình dở/sai dạng →
 * FanpageConfigError nêu TÊN biến (không giá trị). */
export function config(env: Env = process.env): FanpageConfig | null {
  const page = pyStrip(env[ENV_PAGE] ?? '');
  const token = pyStrip(env[ENV_TOKEN] ?? '');
  if (!page && !token) return null;
  if (!PAGE_RE.test(page)) throw new FanpageConfigError(`${ENV_PAGE} thiếu/sai dạng (chỉ chữ số)`);
  if (!TOKEN_RE.test(token)) throw new FanpageConfigError(`${ENV_TOKEN} thiếu/sai dạng`);
  return { pageId: page, token, base: apiBase(ENV_BASE, DEFAULT_BASE, env) };
}

// ------------------------------------------------- lỗi Graph

const FLOAT = Symbol('float');
const INT_LIT = /^-?(0|[1-9][0-9]*)$/;

/** Python `_code`: chỉ số NGUYÊN JSON (không bool, không `4.0`/`1e2`), 0 ≤ v < 10^7. */
function code(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e7 ? v + 0 : null;
}

type Reviver = (key: string, value: unknown, ctx?: { source: string }) => unknown;

/** Python `json.loads(bytes)`: UTF-8 strict, BOM đầu bị bỏ (utf-8-sig) → giá trị | ném. Chặt hơn
 * có chủ đích: UTF-16/32, NaN/Infinity bị từ chối (→ "JSON hỏng"). */
function loads(raw: Uint8Array, reviver?: Reviver): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  return JSON.parse(text, reviver as ((k: string, v: unknown) => unknown) | undefined);
}

/** `error.code`/`error.error_subcode` của thân lỗi Graph; thân hỏng/sai dạng → [null, null]. */
export function graphError(raw: Uint8Array): [number | null, number | null] {
  let doc: unknown;
  try {
    // Python json phân biệt int/float theo literal — số không phải literal nguyên → không là mã.
    doc = loads(raw, (_k, v, ctx) =>
      typeof v === 'number' && ctx && !INT_LIT.test(ctx.source) ? FLOAT : v,
    );
  } catch {
    return [null, null];
  }
  const e = isPlainObject(doc) ? doc.error : undefined;
  if (!isPlainObject(e)) return [null, null];
  return [code(e.code), code(e.error_subcode)];
}

/** Thông điệp lỗi HTTP (không URL/token/body). */
export function explain(status: number, c: number | null, sub: number | null): string {
  const s = `HTTP ${status}${c !== null ? ` mã ${c}` : ''}${sub !== null ? `/${sub}` : ''}`;
  if ((c !== null && TOKEN_CODES.has(c)) || sub === 463 || sub === 467) {
    return `${s} — token hết hạn/thu hồi/không hợp lệ: Bên B cấp lại`;
  }
  if (c === 10 || (c !== null && c >= 200 && c <= 299)) {
    return `${s} — thiếu quyền đọc bài Page (pages_read_engagement)`;
  }
  return s;
}

// ------------------------------------------------- HTTP

/** Tên lỗi mạng kiểu Python (http.client/urllib) — chỉ tên, không thông điệp (có thể chứa URL). */
function netErrName(e: unknown): string {
  if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError')
    return 'TimeoutError';
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  const c = typeof cause?.code === 'string' ? cause.code : '';
  if (['HPE_INVALID_CONSTANT', 'HPE_INVALID_STATUS', 'HPE_INVALID_VERSION'].includes(c)) {
    return 'BadStatusLine';
  }
  if (c === 'UND_ERR_HEADERS_OVERFLOW' || c === 'HPE_HEADER_OVERFLOW') return 'LineTooLong';
  if (c.startsWith('HPE_')) return 'HTTPException';
  if ((e as { code?: unknown })?.code === 'ERR_INVALID_URL') return 'ValueError';
  return 'URLError';
}

/** Đọc tối đa `limit` byte. Lỗi giữa chừng: hết giờ → ném; kết nối đóng sớm → phần đã nhận
 * (như `resp.read(amt)` của http.client trả phần đã có). */
async function readUpTo(r: Response, limit: number): Promise<Uint8Array> {
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } catch (e) {
    if (netErrName(e) === 'TimeoutError') throw e;
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/** 1 trang `published_posts` → JSON object (thử lại lỗi tạm thời). */
async function get(cfg: FanpageConfig, after: string | null): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ fields: FIELDS, limit: String(LIMIT), access_token: cfg.token });
  if (after !== null) q.set('after', after);
  const url = `${cfg.base}/${VERSION}${PATH.replace('{page_id}', cfg.pageId)}?${q}`;
  let status = 0;
  let raw: Uint8Array = new Uint8Array();
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_S * 1000),
      });
      if (r.status >= 200 && r.status < 300) {
        status = r.status;
        raw = await readUpTo(r, MAX_RESP_BYTES + 1);
        break;
      }
    } catch (e) {
      throw new FanpageError(`fanpage: lỗi mạng (${netErrName(e)})`);
    }
    // HTTP lỗi (gồm 3xx — không theo redirect): chỉ đọc thân 4xx/5xx để lấy mã Graph.
    let body: Uint8Array = new Uint8Array();
    if (r.status >= 400 && r.status < 600) {
      try {
        body = await readUpTo(r, ERR_BODY_MAX);
      } catch {
        body = new Uint8Array();
      }
    } else {
      r.body?.cancel().catch(() => {});
    }
    const [c, sub] = graphError(body);
    const temp = RETRY_HTTP.includes(r.status) || (c !== null && TEMP_CODES.has(c));
    if (!temp || attempt === RETRY_MAX) {
      throw new FanpageError(
        `fanpage: ${explain(r.status, c, sub)}${attempt ? ` sau ${attempt + 1} lần` : ''}`,
      );
    }
    const wait = Math.min(2 ** attempt, RETRY_WAIT_MAX);
    console.log(
      `[retry] fanpage: HTTP ${r.status}${c !== null ? ` mã ${c}` : ''} — chờ ${wait}s (${attempt + 1}/${RETRY_MAX})`,
    );
    await settings.sleep(wait);
  }
  if (status !== 200) throw new FanpageError(`fanpage: HTTP ${status}`);
  if (raw.length > MAX_RESP_BYTES) throw new FanpageError('fanpage: response quá trần byte');
  let doc: unknown;
  try {
    doc = loads(raw);
  } catch {
    throw new FanpageError('fanpage: JSON hỏng');
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.data)) {
    throw new FanpageError('fanpage: response thiếu mảng data');
  }
  return doc;
}

/** MỌI bài đã đăng của Page (theo phân trang) → mảng object thô (chỉ các field xin). Lỗi ở bất kỳ
 * trang nào → FanpageError (không trả nửa vời). */
export async function fetchPosts(cfg: FanpageConfig): Promise<Post[]> {
  const out: Post[] = [];
  let after: string | null = null;
  for (let i = 0; i < settings.maxPages; i++) {
    const doc = await get(cfg, after);
    for (const p of doc.data as unknown[]) if (isPlainObject(p)) out.push(p);
    const paging = isPlainObject(doc.paging) ? doc.paging : {};
    if (!pyTruthy(paging.next)) return out;
    const cur = paging.cursors;
    const a = isPlainObject(cur) ? cur.after : undefined;
    if (typeof a !== 'string' || !CURSOR_RE.test(a)) {
      throw new FanpageError('fanpage: có trang sau nhưng thiếu/sai cursor');
    }
    after = a;
  }
  throw new FanpageError(`fanpage: vượt ${settings.maxPages} trang — không nạp nửa vời`);
}

/** `permalink_url` hợp lệ (https, host facebook.com hoặc tên miền con), không user/pass. r18: không
 * khoảng trắng/ký tự điều khiển/surrogate (kiểm chuỗi GỐC — urlsplit tự bỏ \t\r\n). */
export function postUrl(v: unknown): string | null {
  // Python `isspace()` ∪ nhóm Unicode C* = JS `\s` ∪ `\p{C}` (U+FEFF thuộc Cf).
  if (typeof v !== 'string' || /[\s\p{C}]/u.test(v)) return null;
  let u: Split;
  try {
    u = urlsplit(v);
  } catch {
    return null;
  }
  const host = (hostname(u.netloc) ?? '').toLowerCase();
  const [user, pass] = userinfo(u.netloc);
  if (u.scheme !== 'https' || user || pass) return null;
  return POST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? v : null;
}
