import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Env } from '@samsam/core/env';
import { cpSlice, isPrintable } from '@samsam/core/ops/py';
import { cpCmp, isDict, PyFloat, pyOsName } from '@samsam/core/ops/py-json';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import { cpLen, pyStrip } from '@samsam/core/security/py';
import { FIELDS, NUM_MAX, type Row } from './market-csv.js';
import { isPyInt, parsePy, pyJson, pyQueryStr, truthy } from './py-json.js';
import { clean, toInt } from './table.js';

// Port `ingest/market_api.py` (v10.3 connector API sàn CHỈ ĐỌC, WP16 nền P2) — kéo listing/đơn từ
// Shopee Open Platform v2 / TikTok Shop API (202309) vào CÙNG staging v3.3 (market_snapshots/rows/
// alerts) để đối chiếu + cảnh báo của market_csv chạy lại nguyên vẹn.
// CHỈ ĐỌC bằng cấu trúc: `ALLOWED` = allowlist CỨNG (kênh, method, path) hard-code ở đây (không đọc
// config/env); MỌI request đi qua `request()` — kiểm allowlist ĐẦU TIÊN (ngoài = ScopeError, chưa
// dựng URL, chưa mở socket). Không có đường đổi giá/listing/tồn/đơn.
// HTTP: node:http(s), không theo redirect (3xx = lỗi — chống lộ token sang host khác), timeout, trần
// byte, base chỉ https:// hoặc http://127.0.0.1|localhost (server giả). Lỗi chỉ mang HTTP status /
// mã lỗi — KHÔNG body, KHÔNG URL (URL shopee chứa token). PII người mua: chỉ trích TƯỜNG MINH field
// allowlist (cùng field market_csv); mã đơn → order_id_hash (cùng công thức market_csv).
// TRẠNG THÁI: BLOCKED — CHƯA VERIFIED với sàn thật (chưa có app/key/sandbox); chữ ký/endpoint/field/
// phân trang theo tài liệu công khai, kiểm bằng server giả (CONTRACT_TESTED).

export const CONFIG_FILE = dataPath('market_api.json');
export const CHANNELS = ['shopee', 'tiktok'] as const;
export const KINDS = ['listing', 'order'] as const;

// --- endpoint ĐỌC (giả định theo tài liệu công khai) ---
export const SP_ITEM_LIST = '/api/v2/product/get_item_list';
export const SP_ITEM_INFO = '/api/v2/product/get_item_base_info';
export const SP_MODEL_LIST = '/api/v2/product/get_model_list';
export const SP_ORDER_LIST = '/api/v2/order/get_order_list';
export const SP_ORDER_DETAIL = '/api/v2/order/get_order_detail';
export const TT_PRODUCT_SEARCH = '/product/202309/products/search';
export const TT_ORDER_SEARCH = '/order/202309/orders/search';
// r15: quyết toán CHỈ ĐỌC theo tài liệu CHÍNH THỨC — dùng bởi settlement_api (nhóm settlement).
export const SP_ESCROW_LIST = '/api/v2/payment/get_escrow_list';
export const SP_ESCROW_DETAIL = '/api/v2/payment/get_escrow_detail';
export const TT_STATEMENTS = '/finance/202309/statements';
export const TT_STATEMENT_TX = '/finance/202501/statements/{statement_id}/statement_transactions';
const PATH_PARAM_RE = /^[0-9]{1,30}$/;

const k3 = (c: string, m: string, p: string) => `${c} ${m} ${p}`;
export const ALLOWED: ReadonlySet<string> = new Set([
  k3('shopee', 'GET', SP_ITEM_LIST),
  k3('shopee', 'GET', SP_ITEM_INFO),
  k3('shopee', 'GET', SP_MODEL_LIST),
  k3('shopee', 'GET', SP_ORDER_LIST),
  k3('shopee', 'GET', SP_ORDER_DETAIL),
  k3('shopee', 'GET', SP_ESCROW_LIST),
  k3('shopee', 'GET', SP_ESCROW_DETAIL),
  k3('tiktok', 'POST', TT_PRODUCT_SEARCH),
  k3('tiktok', 'POST', TT_ORDER_SEARCH),
  k3('tiktok', 'GET', TT_STATEMENTS),
  k3('tiktok', 'GET', TT_STATEMENT_TX),
]);

// r14: refresh token theo tài liệu CHÍNH THỨC — CHỈ phục vụ xác thực cho các endpoint đọc ở ALLOWED.
export const SP_AUTH_REFRESH = '/api/v2/auth/access_token/get';
export const TT_AUTH_REFRESH = '/api/v2/token/refresh';
export const DEFAULT_AUTH_BASE: Record<string, string> = {
  tiktok: 'https://auth.tiktok-shops.com',
};
export const AUTH_ALLOWED: ReadonlySet<string> = new Set([
  k3('shopee', 'POST', SP_AUTH_REFRESH),
  k3('tiktok', 'GET', TT_AUTH_REFRESH),
]);
export const TOKEN_FILE_VAR = 'MARKET_TOKEN_FILE'; // kho token JSON NGOÀI repo
export const REFRESH_MARGIN_S = 3600; // còn < 1 giờ → refresh trước khi kéo
const TOKEN_RE = /^[\x21-\x7e]{8,512}$/;

export const KEYS: Record<string, readonly [string, string, string, string]> = {
  shopee: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_SHOP_ID', 'SHOPEE_ACCESS_TOKEN'],
  tiktok: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SHOP_CIPHER', 'TIKTOK_ACCESS_TOKEN'],
};
export const DEFAULT_BASE: Record<string, string> = {
  shopee: 'https://partner.shopeemobile.com',
  tiktok: 'https://open-api.tiktokglobalshop.com',
};
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

export const TIMEOUT_MS = 15_000;
// r13: HTTP 429/5xx → thử lại tối đa RETRY_MAX lần, chờ Retry-After (giây, trần RETRY_WAIT_MAX) hoặc
// lũy thừa 1,2,4…; GET/POST ở đây đều CHỈ ĐỌC nên lặp an toàn.
export const RETRY_STATUS = [429, 500, 502, 503, 504];
export const RETRY_MAX = 3;
export const RETRY_WAIT_MAX = 30;
export const FEATURE = 'data_platform-06';
export const PAGE_SIZE = 100;
export const BATCH = 50; // trần id/lần của get_*_base_info/detail
export const DAYS_DEFAULT = 7;
export const DAYS_MAX = 15; // get_order_list: cửa sổ ≤ 15 ngày
export const SP_ITEM_STATUSES = ['NORMAL', 'UNLIST', 'BANNED', 'REVIEWING'];
const NUM_RE = /^[0-9]{1,20}(?:\.0{1,6})?$/;
// http.client của Python: tối đa 100 header (`_MAXHEADERS`) → HTTPException.
const MAX_HEADERS = 100;

/** Trần/seam chỉnh được (Python test monkeypatch `MAX_RESP_BYTES`/`MAX_PAGES`/`_sleep`). */
export const LIMITS = { maxRespBytes: 10 * 1024 * 1024, maxPages: 50 };
export const hooks = {
  sleep: (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000)),
  log: (s: string): void => console.log(s),
};

/** Endpoint ngoài allowlist chỉ đọc — từ chối TRƯỚC khi request. */
export class ScopeError extends Error {
  override name = 'ScopeError';
}
/** Lỗi gọi API — message chỉ HTTP status/mã lỗi, không body/URL. */
export class ApiError extends Error {
  override name = 'ApiError';
}
/** Response sai dạng/giá trị — message chỉ nêu field, không giá trị. */
export class DataError extends Error {
  override name = 'DataError';
}
/** Thiếu key / base URL sai — message chỉ nêu TÊN biến. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Creds = Record<string, string>;
export type Doc = Record<string, unknown>;

// ---------------------------------------------------------------- ký

const hmacHex = (key: string, msg: string) =>
  createHmac('sha256', Buffer.from(key, 'utf8')).update(msg, 'utf8').digest('hex');

export function signShopee(
  partnerKey: string,
  partnerId: string,
  path: string,
  timestamp: number,
  accessToken: string,
  shopId: string,
): string {
  return hmacHex(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`);
}

export function signTiktok(
  appSecret: string,
  path: string,
  query: Record<string, string>,
  body: string,
): string {
  const parts = Object.keys(query)
    .sort(cpCmp)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .map((k) => `${k}${query[k]}`)
    .join('');
  return hmacHex(appSecret, `${appSecret}${path}${parts}${body}${appSecret}`);
}

// ---------------------------------------------------------------- cấu hình

/** Key từ env — thiếu/rỗng → ConfigError nêu TÊN biến (không giá trị). `token` = access token từ kho
 * (r14) thay biến env; `refreshOnly` = chỉ cần key app (chưa có access token). */
export function readCreds(
  channel: string,
  token: unknown = null,
  o: { refreshOnly?: boolean; env?: Env } = {},
): Creds {
  const env = o.env ?? process.env;
  const all = KEYS[channel] as readonly string[];
  const keys = o.refreshOnly ? all.slice(0, 3) : all;
  const creds: Creds = {};
  for (const k of keys) creds[k] = pyStrip(env[k] ?? '');
  if (truthy(token)) creds[all[3] as string] = pyQueryStr(token);
  const missing = Object.keys(creds).filter((k) => !creds[k]);
  if (missing.length) throw new ConfigError(`thiếu ${missing.join(', ')}`);
  return creds;
}

type Split = { scheme: string; netloc: string; path: string; query: string; fragment: string };

/** Python `urllib.parse.urlsplit` (đủ cho base URL). */
export function urlsplit(url: string): Split {
  let rest = url.replace(/[\t\r\n]/g, '');
  let scheme = '';
  const m = /^([A-Za-z][A-Za-z0-9+\-.]*):/.exec(rest);
  if (m) {
    scheme = (m[1] as string).toLowerCase();
    rest = rest.slice(m[0].length);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
    rest = end < 0 ? '' : rest.slice(2 + end);
    if (netloc.includes('[') !== netloc.includes(']')) throw new RangeError('Invalid IPv6 URL');
  }
  let fragment = '';
  const h = rest.indexOf('#');
  if (h >= 0) {
    fragment = rest.slice(h + 1);
    rest = rest.slice(0, h);
  }
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  return { scheme, netloc, path: rest, query, fragment };
}

/** `.hostname`/`.username`/`.password` của SplitResult; `.port` sai → RangeError (ValueError). */
function netlocParts(netloc: string) {
  const at = netloc.lastIndexOf('@');
  const user = at >= 0 ? netloc.slice(0, at) : null;
  const hostport = at >= 0 ? netloc.slice(at + 1) : netloc;
  let host: string;
  let port: string | null = null;
  if (hostport.startsWith('[')) {
    const e = hostport.indexOf(']');
    host = hostport.slice(1, e);
    const after = hostport.slice(e + 1);
    if (after.startsWith(':')) port = after.slice(1);
  } else {
    const c = hostport.indexOf(':');
    host = c >= 0 ? hostport.slice(0, c) : hostport;
    if (c >= 0) port = hostport.slice(c + 1);
  }
  if (port !== null && port !== '') {
    if (!/^[0-9]+$/.test(port)) throw new RangeError('Port could not be cast to integer value');
    if (Number(port) > 65535) throw new RangeError('Port out of range 0-65535');
  }
  const ci = user === null ? -1 : user.indexOf(':');
  return {
    hostname: host ? host.toLowerCase() : null,
    username: user === null ? null : ci >= 0 ? user.slice(0, ci) : user,
    password: user === null || ci < 0 ? null : user.slice(ci + 1),
  };
}

/** `api_base`: base URL chỉ https://<host> hoặc http://127.0.0.1|localhost (server giả). */
export function apiBase(
  channel: string,
  varName: string | null = null,
  dflt: string | null = null,
  env: Env = process.env,
): string {
  const v = varName ?? `${channel.toUpperCase()}_API_BASE`;
  const raw = pyStrip(env[v] ?? '') || dflt || (DEFAULT_BASE[channel] as string);
  let u: Split;
  let p: ReturnType<typeof netlocParts>;
  try {
    u = urlsplit(raw);
    p = netlocParts(u.netloc);
  } catch {
    throw new ConfigError(`${v} không hợp lệ`);
  }
  const host = p.hostname;
  const ok = host && (u.scheme === 'https' || (u.scheme === 'http' && LOCAL_HOSTS.includes(host)));
  if (
    !ok ||
    p.username ||
    p.password ||
    u.query ||
    u.fragment ||
    (u.path !== '' && u.path !== '/')
  ) {
    throw new ConfigError(
      `${v} không hợp lệ — chỉ https://<host> hoặc http://127.0.0.1|localhost (server giả)`,
    );
  }
  return `${u.scheme}://${u.netloc}`;
}

/** Lỗi đọc tệp JSON mang tên lỗi Python (`type(e).__name__`) ở `pyType`. */
class PyErr extends Error {
  constructor(
    readonly pyType: string,
    readonly code?: string,
  ) {
    super(pyType);
  }
}

/** Python `json.loads(path.read_bytes().decode("utf-8"))` (BOM = JSON hỏng). */
function readJsonFile(path: string): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new PyErr(pyOsName(e), (e as { code?: string }).code);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new PyErr('UnicodeDecodeError');
  }
  try {
    return parsePy(text);
  } catch {
    throw new PyErr('JSONDecodeError');
  }
}

export type StatusMap = Record<string, Record<string, Record<string, string>>>;

/** `load_status_map`: ánh xạ trạng thái API → từ vựng trạng thái file xuất tay v3.3. Hỏng →
 * ConfigError nêu tên tệp + loại lỗi Python. */
export function loadStatusMap(path: string = CONFIG_FILE): StatusMap {
  // raw["status_map"]: không phải dict → TypeError | thiếu khóa → KeyError
  const idx = (o: unknown, k: string): unknown => {
    if (!isDict(o)) throw new PyErr('TypeError');
    if (!Object.hasOwn(o, k)) throw new PyErr('KeyError');
    return o[k];
  };
  try {
    const sm = idx(readJsonFile(path), 'status_map');
    for (const ch of CHANNELS) {
      for (const kind of KINDS) {
        const m = idx(idx(sm, ch), kind);
        if (!isDict(m)) throw new PyErr('AttributeError'); // .items() trên không phải dict
        if (!Object.values(m).every((x) => typeof x === 'string')) throw new PyErr('ValueError');
      }
    }
    return sm as StatusMap;
  } catch (e) {
    if (!(e instanceof PyErr)) throw e;
    throw new ConfigError(`${basename(path)}: không đọc được (${e.pyType})`);
  }
}

// ---------------------------------------------------------------- HTTP

export type Params = Record<string, unknown>;
export type HttpReq = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
};

const ALWAYS_SAFE = /^[A-Za-z0-9_.\-~]$/;

/** Python `urllib.parse.quote_plus` (safe=''). */
export function quotePlus(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (ALWAYS_SAFE.test(c)) out += c;
    else if (b === 0x20) out += '+';
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Python `urllib.parse.urlencode(query, doseq=True)` (thứ tự khóa như dict). */
export function urlencode(query: Map<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of query) {
    if (Array.isArray(v)) {
      for (const x of v) parts.push(`${quotePlus(k)}=${quotePlus(pyQueryStr(x))}`);
    } else parts.push(`${quotePlus(k)}=${quotePlus(pyQueryStr(v))}`);
  }
  return parts.join('&');
}

const ERR_CODE_RE = /^[a-z]{2,24}(?:_[a-z]{1,24}){1,6}$/;

/**
 * `_err_code` (r14-fix2 F1): trường lỗi do SÀN trả có thể phản chiếu token/khóa → chỉ in mã đã kiểm
 * kiểu/dạng (Shopee chữ thường nối `_`, TikTok số nguyên), mọi giá trị khác ẩn; vẫn ẩn mọi giá trị
 * chứa credential đã biết.
 */
export function errCode(v: unknown, creds: Record<string, unknown>, ...extra: unknown[]): string {
  let s: string | null = null;
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 10 ** 9) s = String(v);
  else if (typeof v === 'bigint' && (v < 0n ? -v : v) < 10n ** 9n) s = v.toString();
  else if (typeof v === 'string' && ERR_CODE_RE.test(v)) s = v;
  const secrets = [...Object.values(creds), ...extra].filter(
    (x): x is string => typeof x === 'string' && cpLen(x) >= 8,
  );
  if (s === null || secrets.some((x) => (s as string).includes(x))) {
    return '(không đúng dạng mã lỗi — đã ẩn)';
  }
  return s;
}

/** Tên lỗi Python tương ứng (`type(e).__name__`) cho lỗi mạng/HTTP của Node — chỉ tên, không URL. */
export function netErrName(e: unknown): string {
  const code = String((e as { code?: unknown })?.code ?? '');
  const name = String((e as { name?: unknown })?.name ?? '');
  if (code === 'HPE_HEADER_OVERFLOW') return 'LineTooLong';
  if (/^HPE_INVALID_(CONSTANT|STATUS|VERSION)$/.test(code)) return 'BadStatusLine';
  if (code.startsWith('HPE_')) return 'HTTPException';
  if (code === 'ECONNRESET') return 'ConnectionResetError';
  if (code === 'EPIPE') return 'BrokenPipeError';
  if (code === 'ETIMEDOUT' || name === 'TimeoutError') return 'TimeoutError';
  if (
    /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)$/.test(code) ||
    /^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)
  ) {
    return 'URLError';
  }
  if (name === 'HTTPException' || name === 'IncompleteRead' || name === 'ValueError') return name;
  return 'OSError';
}

const named = (name: string, code?: string) => Object.assign(new Error(name), { name, code });

type RawResp = { status: number; headers: http.IncomingHttpHeaders; body: Buffer | null };

/** Một lần gửi: không redirect (node:http không bao giờ theo), timeout idle, trần byte. Mã ngoài
 * 2xx → không đọc body (như HTTPError của urllib). Không keep-alive (như urllib: Connection: close).
 * shortcut: node:http bỏ qua HTTPS_PROXY/HTTP_PROXY/NO_PROXY (urllib theo proxy của env/registry) —
 * máy chủ cần proxy mới ra được sàn thì TS báo "lỗi mạng"; thêm CONNECT qua proxy khi on-prem cần. */
function once(req: HttpReq): Promise<RawResp> {
  return new Promise((resolveP, reject) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      reject(named('ValueError'));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const ok = (r: RawResp) => {
      if (!done) {
        done = true;
        resolveP(r);
      }
    };
    const fail = (e: unknown) => {
      if (!done) {
        done = true;
        reject(e);
      }
    };
    // Dây như urllib: Accept-Encoding identity; có body → Content-Length (Node mặc định gửi chunked —
    // server chỉ đọc theo Content-Length thấy body rỗng).
    const headers: Record<string, string> = { ...req.headers, 'Accept-Encoding': 'identity' };
    if (req.body) headers['Content-Length'] = String(req.body.length);
    const r = mod.request(
      u,
      { method: req.method, headers, agent: false, timeout: TIMEOUT_MS },
      (res) => {
        if (res.rawHeaders.length / 2 > MAX_HEADERS) {
          res.destroy();
          fail(named('HTTPException'));
          return;
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          ok({ status, headers: res.headers, body: null });
          return;
        }
        const cap = LIMITS.maxRespBytes + 1;
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          if (n >= cap) return;
          const take = c.subarray(0, cap - n);
          chunks.push(take);
          n += take.length;
          if (n >= cap) {
            ok({ status, headers: res.headers, body: Buffer.concat(chunks) });
            res.destroy();
          }
        });
        res.on('end', () => ok({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', fail);
        // đóng trước khi đủ body (Content-Length) = IncompleteRead của http.client
        res.on('close', () => {
          if (!res.complete) fail(named('IncompleteRead'));
        });
      },
    );
    r.on('timeout', () => r.destroy(named('TimeoutError', 'ETIMEDOUT')));
    r.on('error', fail);
    r.end(req.body ?? undefined);
  });
}

/**
 * `_send`: gửi 1 request → JSON object. HTTP 429/5xx → thử lại (≤ `retries`, chờ Retry-After/lũy
 * thừa, trần 30 s). Lỗi chỉ nêu HTTP status/loại lỗi — KHÔNG body, KHÔNG URL (URL chứa token).
 */
export async function send(req: HttpReq, where: string, retries = RETRY_MAX): Promise<Doc> {
  let resp: RawResp | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      resp = await once(req);
    } catch (e) {
      throw new ApiError(`${where}: lỗi mạng (${netErrName(e)})`);
    }
    const code = resp.status;
    if (code >= 200 && code < 300) break;
    // urllib: ngoài 2xx (kể cả 3xx không theo) = HTTPError
    if (!RETRY_STATUS.includes(code) || attempt === retries) {
      throw new ApiError(`${where}: HTTP ${code}${attempt ? ` sau ${attempt + 1} lần` : ''}`);
    }
    const ra = pyStrip(String(resp.headers['retry-after'] ?? ''));
    const w = Math.min(/^[0-9]+$/.test(ra) ? Number(ra) : 2 ** attempt, RETRY_WAIT_MAX);
    hooks.log(`[retry] ${where}: HTTP ${code} — chờ ${w}s (${attempt + 1}/${RETRY_MAX})`);
    await hooks.sleep(w);
  }
  const r = resp as RawResp;
  if (r.status !== 200) throw new ApiError(`${where}: HTTP ${r.status}`);
  const raw = r.body as Buffer;
  if (raw.length > LIMITS.maxRespBytes) {
    throw new ApiError(`${where}: response > ${Math.floor(LIMITS.maxRespBytes / 2 ** 20)}MB`);
  }
  let doc: unknown;
  try {
    doc = parsePy(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new ApiError(`${where}: JSON hỏng`);
  }
  if (!isDict(doc)) throw new ApiError(`${where}: JSON không phải object`);
  return doc;
}

/** TikTok `doc.get("code") != 0` của Python: 0 / 0.0 / False là thành công. */
const ttOk = (c: unknown) => c === 0 || c === false || (c instanceof PyFloat && c.v === 0);

export type RequestOpts = {
  creds?: Creds;
  base?: string;
  timestamp?: number;
  pathParams?: Record<string, unknown>;
  env?: Env;
};

/**
 * `_request`: cửa DUY NHẤT ra sàn. Allowlist kiểm ĐẦU TIÊN (theo MẪU path); r15: tham số path
 * (`{statement_id}`) chỉ nhận số, thế vào SAU khi qua allowlist.
 */
export async function request(
  channel: string,
  method: string,
  path0: string,
  params: Params | null,
  body: Record<string, unknown> | null = null,
  o: RequestOpts = {},
): Promise<Doc> {
  if (!ALLOWED.has(k3(channel, method, path0))) {
    throw new ScopeError(
      `${clean(channel, 20)} ${clean(method, 10)} ${clean(path0, 100)}: ngoài allowlist chỉ đọc — từ chối, không gửi request`,
    );
  }
  let path = path0;
  for (const [k, v] of Object.entries(o.pathParams ?? {})) {
    if (typeof v !== 'string' || !PATH_PARAM_RE.test(v)) {
      throw new DataError(`${channel} ${path}: tham số path '${k}' sai dạng`);
    }
    path = path.replaceAll(`{${k}}`, v);
  }
  if (path.includes('{')) throw new ScopeError(`${clean(path, 100)}: thiếu tham số path`);
  const env = o.env ?? process.env;
  const creds = o.creds ?? readCreds(channel, null, { env });
  const base = o.base ?? apiBase(channel, null, null, env);
  const ts = o.timestamp === undefined ? Math.floor(Date.now() / 1000) : Math.trunc(o.timestamp);
  const query = new Map<string, unknown>(Object.entries(params ?? {}));
  const headers: Record<string, string> = { Accept: 'application/json' };
  let data: Buffer | null = null;
  const c = (k: string) => creds[k] as string;
  if (channel === 'shopee') {
    query.set('partner_id', c('SHOPEE_PARTNER_ID'));
    query.set('timestamp', ts);
    query.set('access_token', c('SHOPEE_ACCESS_TOKEN'));
    query.set('shop_id', c('SHOPEE_SHOP_ID'));
    query.set(
      'sign',
      signShopee(
        c('SHOPEE_PARTNER_KEY'),
        c('SHOPEE_PARTNER_ID'),
        path,
        ts,
        c('SHOPEE_ACCESS_TOKEN'),
        c('SHOPEE_SHOP_ID'),
      ),
    );
  } else {
    // r15: GET không có body — chữ ký TikTok nối body RỖNG (finance GET).
    const bodyS = method === 'GET' ? '' : pyJson(body ?? {}, { sortKeys: true });
    const q: Record<string, string> = {};
    for (const [k, v] of query) q[k] = pyQueryStr(v);
    q.app_key = c('TIKTOK_APP_KEY');
    q.timestamp = String(ts);
    q.shop_cipher = c('TIKTOK_SHOP_CIPHER');
    q.sign = signTiktok(c('TIKTOK_APP_SECRET'), path, q, bodyS);
    query.clear();
    for (const [k, v] of Object.entries(q)) query.set(k, v);
    headers['x-tts-access-token'] = c('TIKTOK_ACCESS_TOKEN');
    headers['Content-Type'] = 'application/json';
    data = method !== 'GET' ? Buffer.from(bodyS, 'utf8') : null;
  }
  const req: HttpReq = { method, url: `${base}${path}?${urlencode(query)}`, headers, body: data };
  const where = `${channel} ${path}`;
  const doc = await send(req, where);
  if (channel === 'shopee') {
    if (truthy(doc.error)) throw new ApiError(`${where}: mã lỗi ${errCode(doc.error, creds)}`);
  } else if (!ttOk(doc.code)) {
    throw new ApiError(`${where}: mã lỗi ${errCode(doc.code, creds)}`);
  }
  return doc;
}

// ---------------------------------------------------------------- token (r14)

/** `token_file`: đường kho token (`MARKET_TOKEN_FILE`) — trống = không dùng kho; nằm trong repo →
 * ConfigError (token không bao giờ vào git). So sánh sau khi giải symlink (như `Path.resolve`). */
export function tokenFile(env: Env = process.env, root: string = REPO_ROOT): string | null {
  const raw = pyStrip(env[TOKEN_FILE_VAR] ?? '');
  if (!raw) return null;
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      const d = dirname(p);
      return d === p ? p : join(real(d), basename(p));
    }
  };
  const p = real(resolve(raw));
  const rel = relative(real(resolve(root)), p);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new ConfigError(`${TOKEN_FILE_VAR} nằm trong repo — đặt NGOÀI repo`);
  }
  return p;
}

/** `load_tokens`: chưa có kho → {}; hỏng → ConfigError. */
export function loadTokens(path: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = readJsonFile(path);
  } catch (e) {
    if (!(e instanceof PyErr)) throw e;
    if (e.code === 'ENOENT') return {};
    throw new ConfigError(`${TOKEN_FILE_VAR}: không đọc được (${e.pyType})`);
  }
  if (!isDict(doc)) throw new ConfigError(`${TOKEN_FILE_VAR}: không phải object`);
  return doc;
}

/** `save_tokens`: ghi nguyên tử (tệp tạm cùng thư mục + rename). */
export function saveTokens(path: string, doc: Record<string, unknown>): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, Buffer.from(pyJson(doc, { sep: [', ', ': '], sortKeys: true, ascii: true })));
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // như Python: chmod lỗi (Windows/FS không hỗ trợ) → bỏ qua
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Tệp khóa kho token của bản TS — RIÊNG với `<kho>.lock` mà Python flock: xóa/thay tệp đó (inode Python
 * đang giữ) làm vỡ cả loại trừ Python↔Python. */
export const tokenLockPath = (store: string): string => `${store}.ts.lock`;

/**
 * Khóa độc quyền KHÔNG chờ (thay Python `job_runs._file_lock`) → hàm nhả | null (đang bị giữ). Node
 * không có flock: tệp tạo độc quyền chứa pid; tệp rỗng hoặc pid đã chết → coi là cũ, xóa rồi thử lại
 * 1 lần. KHÔNG loại trừ tiến trình Python (khóa ở tệp khác) — đừng refresh cùng kho token từ cả bản
 * Python lẫn bản TS cùng lúc (refresh_token Shopee dùng 1 lần). shortcut: pid trong tệp khóa cũ bị
 * tiến trình khác dùng lại → khóa coi như còn giữ, refresh bị chặn tới khi xóa tay tệp `.ts.lock`.
 */
export function fileLock(lockPath: string): (() => void) | null {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // thư mục không tạo được → mở tệp khóa sẽ lỗi → coi như đang bị giữ (không request)
  }
  const take = (): (() => void) | null => {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch {
      return null;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return () => {
      try {
        if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
      } catch {
        // tệp khóa đã mất — không còn gì để nhả
      }
    };
  };
  const got = take();
  if (got) return got;
  let held: string;
  try {
    held = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return null;
  }
  if (/^[0-9]+$/.test(held)) {
    const pid = Number(held);
    if (pid === process.pid) return null;
    try {
      process.kill(pid, 0);
      return null; // tiến trình giữ khóa còn sống
    } catch (e) {
      if ((e as { code?: string }).code !== 'ESRCH') return null;
    }
  }
  try {
    unlinkSync(lockPath);
  } catch {
    return null;
  }
  return take();
}

const tok = (v: unknown, field: string, where: string): string => {
  if (typeof v !== 'string' || !TOKEN_RE.test(v)) {
    throw new DataError(`${where}: thiếu/sai ${field}`);
  }
  return v;
};

export type NewToken = { access_token: string; refresh_token: string; expire_at: number };

/** Python `int(s)` cho id cấu hình (ASCII; TS chặt hơn: không nhận chữ số Unicode). */
const asInt = (s: string): bigint | null => {
  const m = /^[+-]?[0-9]+(?:_[0-9]+)*$/.exec(pyStrip(s));
  return m ? BigInt(m[0].replaceAll('_', '')) : null;
};

/** `refresh_token`: 1 lần gọi refresh (KHÔNG thử lại — refresh_token Shopee dùng 1 lần) →
 * {access_token, refresh_token, expire_at}. Lỗi → ApiError/DataError/ConfigError. */
export async function refreshToken(
  channel: string,
  creds: Creds,
  refresh: unknown,
  base: string,
  o: { timestamp?: number } = {},
): Promise<NewToken> {
  const [method, path] =
    channel === 'shopee' ? ['POST', SP_AUTH_REFRESH] : ['GET', TT_AUTH_REFRESH];
  if (!AUTH_ALLOWED.has(k3(channel, method, path))) {
    throw new ScopeError(`${clean(channel, 20)}: refresh ngoài allowlist`);
  }
  const ts = o.timestamp === undefined ? Math.floor(Date.now() / 1000) : Math.trunc(o.timestamp);
  const where = `${channel} refresh token`;
  if (channel === 'shopee') {
    const pid = creds.SHOPEE_PARTNER_ID as string;
    const pidN = asInt(pid);
    const shopN = asInt(creds.SHOPEE_SHOP_ID ?? '');
    if (pidN === null || shopN === null) {
      throw new ConfigError('SHOPEE_PARTNER_ID/SHOPEE_SHOP_ID phải là số');
    }
    const body = { refresh_token: refresh, partner_id: pidN, shop_id: shopN };
    const sign = hmacHex(creds.SHOPEE_PARTNER_KEY as string, `${pid}${SP_AUTH_REFRESH}${ts}`);
    const q = new Map<string, unknown>([
      ['partner_id', pid],
      ['timestamp', ts],
      ['sign', sign],
    ]);
    const doc = await send(
      {
        method: 'POST',
        url: `${base}${SP_AUTH_REFRESH}?${urlencode(q)}`,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: Buffer.from(pyJson(body, { sep: [', ', ': '], ascii: true }), 'utf8'),
      },
      where,
      0,
    );
    if (truthy(doc.error)) {
      throw new ApiError(`${where}: mã lỗi ${errCode(doc.error, creds, refresh)}`);
    }
    const exp = doc.expire_in;
    if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= 0) {
      throw new DataError(`${where}: thiếu/sai expire_in`);
    }
    return {
      access_token: tok(doc.access_token, 'access_token', where),
      refresh_token: tok(doc.refresh_token, 'refresh_token', where),
      expire_at: ts + exp,
    };
  }
  const q = new Map<string, unknown>([
    ['app_key', creds.TIKTOK_APP_KEY],
    ['app_secret', creds.TIKTOK_APP_SECRET],
    ['refresh_token', refresh],
    ['grant_type', 'refresh_token'],
  ]);
  const doc = await send(
    {
      method: 'GET',
      url: `${base}${TT_AUTH_REFRESH}?${urlencode(q)}`,
      headers: { Accept: 'application/json' },
      body: null,
    },
    where,
    0,
  );
  if (!ttOk(doc.code)) throw new ApiError(`${where}: mã lỗi ${errCode(doc.code, creds, refresh)}`);
  const data = doc.data;
  if (!isDict(data)) throw new DataError(`${where}: thiếu data`);
  const exp = data.access_token_expire_in;
  if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= ts) {
    throw new DataError(`${where}: thiếu/sai access_token_expire_in`);
  }
  return {
    access_token: tok(data.access_token, 'access_token', where),
    refresh_token: tok(data.refresh_token, 'refresh_token', where),
    expire_at: exp,
  };
}

/** Python `datetime.fromtimestamp(ts, VN_TZ):%Y-%m-%d %H:%M`. */
function vnStamp(ts: number): string {
  const d = new Date(ts * 1000 + 7 * 3600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export type RefreshDeps = {
  env?: Env;
  log?: (s: string) => void;
  now?: () => number;
  refresh?: typeof refreshToken;
};

/**
 * `_do_refresh`: refresh dưới khóa tệp kho → access token mới | null (lỗi đã in). Đọc lại kho TRONG
 * khóa: tiến trình khác vừa refresh xong → dùng luôn, không gọi.
 */
export async function doRefresh(
  channel: string,
  creds: Creds,
  path: string,
  force: boolean,
  d: RefreshDeps = {},
): Promise<string | null> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const now = d.now ?? (() => Date.now() / 1000);
  const release = fileLock(tokenLockPath(path));
  if (release === null) {
    log(`[err] ${channel}: tiến trình khác đang refresh token — bỏ lượt, không gửi request.`);
    return null;
  }
  let fresh: NewToken | null = null;
  try {
    let store: Record<string, unknown>;
    try {
      store = loadTokens(path);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      log(`[err] ${e.message}`);
      return null;
    }
    const e0 = store[channel];
    const entry = isDict(e0) ? e0 : {};
    const exp = entry.expire_at;
    if (
      !force &&
      truthy(entry.access_token) &&
      isPyInt(exp) &&
      Number(exp) > now() + REFRESH_MARGIN_S
    ) {
      return pyQueryStr(entry.access_token);
    }
    const old = truthy(entry.refresh_token)
      ? entry.refresh_token
      : pyStrip(env[`${channel.toUpperCase()}_REFRESH_TOKEN`] ?? '');
    if (!truthy(old)) {
      log(
        `[external-dep] ${channel}: chưa có refresh_token (kho ${TOKEN_FILE_VAR} hoặc ${channel.toUpperCase()}_REFRESH_TOKEN — chủ shop ủy quyền app); 0 request.`,
      );
      return null;
    }
    try {
      const base =
        channel === 'shopee'
          ? apiBase('shopee', null, null, env)
          : apiBase(channel, 'TIKTOK_AUTH_BASE', DEFAULT_AUTH_BASE.tiktok as string, env);
      fresh = await (d.refresh ?? refreshToken)(channel, creds, old, base);
    } catch (e) {
      if (e instanceof ApiError || e instanceof DataError || e instanceof ConfigError) {
        log(`[err] ${e.message} — kho token KHÔNG đổi.`);
        return null;
      }
      throw e;
    }
    store[channel] = fresh;
    try {
      saveTokens(path, store);
    } catch (e) {
      log(
        `[err] ${channel}: refresh xong nhưng KHÔNG lưu được kho token (${pyOsName(e)}) — refresh_token mới đã mất, cần chủ shop ủy quyền lại.`,
      );
      return null;
    }
  } finally {
    release();
  }
  log(`[ok] ${channel}: đã refresh token — hết hạn ${vnStamp(fresh.expire_at)} (giờ VN).`);
  return fresh.access_token;
}

// ---------------------------------------------------------------- chuẩn hóa

/** `_obj`: object con bắt buộc. */
export const obj = (d: unknown, key: string, where: string): Doc => {
  const v = isDict(d) ? d[key] : undefined;
  if (!isDict(v)) throw new DataError(`${where}: thiếu object '${key}'`);
  return v;
};

/** `_list`: thiếu/null → []; khác list object → lỗi. */
export const list = (d: unknown, key: string, where: string): Doc[] => {
  const v = isDict(d) ? d[key] : undefined;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isDict)) {
    throw new DataError(`${where}: '${key}' không phải list object`);
  }
  return v as Doc[];
};

/** `_id`: int/str, in được, ≤ 64 ký tự. */
export const idOf = (v: unknown, field: string, where: string): string => {
  const isInt = (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';
  if (typeof v !== 'string' && !isInt) {
    throw new DataError(`${where}: field '${field}' thiếu/sai kiểu`);
  }
  const s = pyStrip(String(v));
  if (!s || cpLen(s) > 64 || !isPrintable(s)) {
    throw new DataError(`${where}: field '${field}' không hợp lệ`);
  }
  return s;
};

/** `_str`: None/"" → null; khác str → lỗi; strip, cắt `n` ký tự. */
export const strOf = (v: unknown, field: string, where: string, n = 300): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new DataError(`${where}: field '${field}' sai kiểu`);
  return cpSlice(pyStrip(v), 0, n) || null;
};

/** `_num`: số nguyên ≥ 0 trong trần `market_csv.NUM_MAX`. Float/chuỗi có phần lẻ khác 0 (236000.5)
 * → lỗi — không làm tròn giá. */
export const numOf = (v: unknown, field: string, where: string): number => {
  if (v === undefined || v === null || typeof v === 'boolean') {
    throw new DataError(`${where}: field '${field}' thiếu/sai kiểu`);
  }
  let x: unknown = v;
  if (v instanceof PyFloat) {
    if (!Number.isInteger(v.v)) {
      throw new DataError(`${where}: field '${field}' không phải số nguyên`);
    }
    x = BigInt(v.v);
  }
  // str(dict/list) của Python không bao giờ khớp NUM_RE
  const s = typeof x === 'object' ? '{}' : pyStrip(String(x));
  const n = NUM_RE.test(s) ? toInt(s.split('.')[0] as string, NUM_MAX[field] as number) : null;
  if (n === null) {
    throw new DataError(`${where}: field '${field}' không phải số nguyên ≥ 0 hợp lệ`);
  }
  return n;
};

const orderHash = (channel: string, orderId: string): string =>
  createHash('sha256').update(`${channel}:${orderId}`, 'utf8').digest('hex').slice(0, 16);

function row(kw: Row): Row {
  const out: Row = {};
  for (const f of FIELDS) if (f !== 'order_id') out[f] = null;
  return Object.assign(out, kw);
}

/** `_status`: mã API → từ vựng file xuất tay; mã lạ giữ NGUYÊN (listing lạ = đang bán, fail-closed). */
function status(smap: StatusMap, channel: string, kind: string, s: unknown): string | null {
  const t = strOf(s, 'status', `${channel} ${kind}`, 60);
  if (!t) return null;
  const m = smap[channel]?.[kind] ?? {};
  return Object.hasOwn(m, t) ? (m[t] as string) : t;
}

function numberRows(rows: Row[]): Row[] {
  rows.forEach((r, i) => {
    r.row_no = i + 1;
  });
  return rows;
}

/** `_pages`: duyệt trang; vượt MAX_PAGES → ApiError (không nạp nửa vời). */
export async function* pages(
  fetchPage: (cursor: unknown) => Promise<Doc>,
  nextOf: (doc: Doc) => unknown,
): AsyncGenerator<Doc> {
  let cursor: unknown = null;
  let n = 0;
  while (true) {
    n++;
    if (n > LIMITS.maxPages) {
      throw new ApiError(`vượt MAX_PAGES=${LIMITS.maxPages} — dừng, không nạp`);
    }
    const doc = await fetchPage(cursor);
    yield doc;
    cursor = nextOf(doc);
    if (cursor === null || cursor === undefined || cursor === '') return;
  }
}

/** Lời gọi API đã ký sẵn (kênh/creds/base) — `request` của một kênh. */
export type Call = (
  method: string,
  path: string,
  params: Params,
  body?: Record<string, unknown> | null,
  pathParams?: Record<string, unknown>,
) => Promise<Doc>;

const shopeePrice = (d: Doc, w: string): number => {
  const pi = list(d, 'price_info', w);
  if (!pi.length) throw new DataError(`${w}: thiếu 'price_info'`);
  return numOf((pi[0] as Doc).original_price, 'price', w);
};

const shopeeStock = (d: Doc, w: string): number | null => {
  const s0 = d.stock_info_v2;
  const s = isDict(s0) ? s0.summary_info : undefined;
  const v = isDict(s) ? s.total_available_stock : undefined;
  return v === undefined || v === null ? null : numOf(v, 'stock', w);
};

export async function fetchShopeeListing(call: Call, smap: StatusMap): Promise<Row[]> {
  const w = 'shopee listing';
  const ids: string[] = [];
  const page = async (off: unknown) =>
    obj(
      await call('GET', SP_ITEM_LIST, {
        offset: truthy(off) ? off : 0,
        page_size: PAGE_SIZE,
        item_status: SP_ITEM_STATUSES,
      }),
      'response',
      w,
    );
  for await (const r of pages(page, (r) => (truthy(r.has_next_page) ? r.next_offset : null))) {
    for (const it of list(r, 'item', w)) ids.push(idOf(it.item_id, 'item_id', w));
  }
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const info = obj(
      await call('GET', SP_ITEM_INFO, { item_id_list: ids.slice(i, i + BATCH).join(',') }),
      'response',
      w,
    );
    for (const it of list(info, 'item_list', w)) {
      const iid = idOf(it.item_id, 'item_id', w);
      const title = strOf(it.item_name, 'item_name', w);
      const st = status(smap, 'shopee', 'listing', it.item_status);
      if (truthy(it.has_model)) {
        const m = obj(await call('GET', SP_MODEL_LIST, { item_id: iid }), 'response', w);
        for (const md of list(m, 'model', w)) {
          const sellerSku = strOf(md.model_sku, 'model_sku', w);
          const price = shopeePrice(md, w);
          const stock = shopeeStock(md, w);
          rows.push(row({ item_id: iid, title, status: st, seller_sku: sellerSku, price, stock }));
        }
      } else {
        const sellerSku = strOf(it.item_sku, 'item_sku', w);
        const price = shopeePrice(it, w);
        const stock = shopeeStock(it, w);
        rows.push(row({ item_id: iid, title, status: st, seller_sku: sellerSku, price, stock }));
      }
    }
  }
  return numberRows(rows);
}

export async function fetchShopeeOrder(
  call: Call,
  smap: StatusMap,
  days: number,
  now: number,
): Promise<Row[]> {
  const w = 'shopee order';
  const t1 = Math.trunc(now);
  const t0 = t1 - days * 86400;
  const sns: string[] = [];
  const page = async (cur: unknown) => {
    const p: Params = {
      time_range_field: 'create_time',
      time_from: t0,
      time_to: t1,
      page_size: PAGE_SIZE,
    };
    if (truthy(cur)) p.cursor = cur;
    return obj(await call('GET', SP_ORDER_LIST, p), 'response', w);
  };
  for await (const r of pages(page, (r) => (truthy(r.more) ? r.next_cursor : null))) {
    for (const o of list(r, 'order_list', w)) sns.push(idOf(o.order_sn, 'order_sn', w));
  }
  const rows: Row[] = [];
  for (let i = 0; i < sns.length; i += BATCH) {
    const det = obj(
      await call('GET', SP_ORDER_DETAIL, {
        order_sn_list: sns.slice(i, i + BATCH).join(','),
        response_optional_fields: 'item_list',
      }),
      'response',
      w,
    );
    for (const o of list(det, 'order_list', w)) {
      // chỉ trích field allowlist — buyer/recipient bỏ cùng object `o`
      const h = orderHash('shopee', idOf(o.order_sn, 'order_sn', w));
      const st = status(smap, 'shopee', 'order', o.order_status);
      for (const it of list(o, 'item_list', w)) {
        const itemId = idOf(it.item_id, 'item_id', w);
        const sellerSku = strOf(it.model_sku, 'model_sku', w) || strOf(it.item_sku, 'item_sku', w);
        const title = strOf(it.item_name, 'item_name', w);
        const qty = numOf(it.model_quantity_purchased, 'qty', w);
        const price = numOf(it.model_discounted_price, 'price', w);
        rows.push(
          row({
            item_id: itemId,
            seller_sku: sellerSku,
            title,
            qty,
            price,
            status: st,
            order_id_hash: h,
          }),
        );
      }
    }
  }
  return numberRows(rows);
}

async function* ttPages(
  call: Call,
  path: string,
  body: Record<string, unknown>,
  key: string,
  w: string,
): AsyncGenerator<Doc> {
  const page = async (t: unknown) => {
    const p: Params = { page_size: PAGE_SIZE };
    if (truthy(t)) p.page_token = t;
    return obj(await call('POST', path, p, body), 'data', w);
  };
  for await (const d of pages(page, (d) => d.next_page_token)) yield* list(d, key, w);
}

export async function fetchTiktokListing(call: Call, smap: StatusMap): Promise<Row[]> {
  const w = 'tiktok listing';
  const rows: Row[] = [];
  for await (const p of ttPages(call, TT_PRODUCT_SEARCH, {}, 'products', w)) {
    const pid = idOf(p.id, 'id', w);
    const title = strOf(p.title, 'title', w);
    const st = status(smap, 'tiktok', 'listing', p.status);
    for (const sku of list(p, 'skus', w)) {
      const pr = isDict(sku.price) ? sku.price : {};
      const inv = list(sku, 'inventory', w);
      const sellerSku = strOf(sku.seller_sku, 'seller_sku', w);
      const price = numOf(pr.tax_exclusive_price, 'price', w);
      const stock = inv.length ? inv.reduce((t, x) => t + numOf(x.quantity, 'stock', w), 0) : null;
      rows.push(row({ item_id: pid, title, status: st, seller_sku: sellerSku, price, stock }));
    }
  }
  return numberRows(rows);
}

export async function fetchTiktokOrder(
  call: Call,
  smap: StatusMap,
  days: number,
  now: number,
): Promise<Row[]> {
  const w = 'tiktok order';
  const t1 = Math.trunc(now);
  const body = { create_time_ge: t1 - days * 86400, create_time_lt: t1 };
  const rows: Row[] = [];
  for await (const o of ttPages(call, TT_ORDER_SEARCH, body, 'orders', w)) {
    const h = orderHash('tiktok', idOf(o.id, 'id', w));
    const st = status(smap, 'tiktok', 'order', o.status);
    for (const li of list(o, 'line_items', w)) {
      const itemId = idOf(li.product_id, 'product_id', w);
      const sellerSku = strOf(li.seller_sku, 'seller_sku', w);
      const title = strOf(li.product_name, 'product_name', w);
      const price = numOf(li.original_price, 'price', w);
      // 202309: 1 line_item = 1 đơn vị (giả định)
      rows.push(
        row({
          item_id: itemId,
          seller_sku: sellerSku,
          title,
          qty: 1,
          price,
          status: st,
          order_id_hash: h,
        }),
      );
    }
  }
  return numberRows(rows);
}

/** `fetch` của Python (đổi tên để không che `fetch` toàn cục). */
export async function fetchRows(
  channel: string,
  kind: string,
  call: Call,
  smap: StatusMap,
  days: number = DAYS_DEFAULT,
  now: number | null = null,
): Promise<Row[]> {
  const t = now ?? Date.now() / 1000;
  if (channel === 'shopee') {
    return kind === 'listing'
      ? fetchShopeeListing(call, smap)
      : fetchShopeeOrder(call, smap, days, t);
  }
  return kind === 'listing'
    ? fetchTiktokListing(call, smap)
    : fetchTiktokOrder(call, smap, days, t);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * `rows_sha256`: sha256 JSON chuẩn — cùng dữ liệu = cùng hash → `[skip]`. KHÁC Python có chủ đích:
 * chữ có surrogate lẻ (JSON `\ud800`) → DataError (Python: UnicodeEncodeError traceback) — lỗi có
 * kiểm soát, 0 dòng nạp.
 */
export function rowsSha256(channel: string, kind: string, rows: Row[]): string {
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && LONE_SURROGATE.test(v)) {
        throw new DataError(`${channel} ${kind}: field '${k}' có ký tự hỏng (surrogate lẻ)`);
      }
    }
  }
  const blob = pyJson({ channel, kind, rows }, { sortKeys: true });
  return createHash('sha256').update(blob, 'utf8').digest('hex');
}
