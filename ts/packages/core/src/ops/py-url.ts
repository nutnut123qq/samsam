// Port phần `urllib.parse` (Python 3.12.7) mà collector intel dùng: urlsplit/urlparse/urljoin,
// urlunsplit/urlunparse, hostname/port, parse_qsl/urlencode, quote/unquote. URL lưu ở
// `intel_items.url` (khóa chống trùng) phải RA Y HỆT bản Python — test so golden.
// Lỗi Python `ValueError` = `UrlError extends RangeError`.

export class UrlError extends RangeError {
  override name = 'ValueError';
}

export type Split = {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
};
export type Parsed = Split & { params: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: _WHATWG_C0_CONTROL_OR_SPACE
const C0_LEAD = /^[\x00-\x20]+/;
const SCHEME_CHARS = /^[A-Za-z0-9+.-]*$/;

export const USES_RELATIVE = new Set([
  '',
  'ftp',
  'http',
  'gopher',
  'nntp',
  'imap',
  'wais',
  'file',
  'https',
  'shttp',
  'mms',
  'prospero',
  'rtsp',
  'rtsps',
  'rtspu',
  'sftp',
  'svn',
  'svn+ssh',
  'ws',
  'wss',
]);
export const USES_NETLOC = new Set([
  '',
  'ftp',
  'http',
  'gopher',
  'nntp',
  'telnet',
  'imap',
  'wais',
  'file',
  'mms',
  'https',
  'shttp',
  'snews',
  'prospero',
  'rtsp',
  'rtsps',
  'rtspu',
  'rsync',
  'svn',
  'svn+ssh',
  'sftp',
  'nfs',
  'git',
  'git+ssh',
  'ws',
  'wss',
  'itms-services',
]);
const USES_PARAMS = new Set([
  '',
  'ftp',
  'hdl',
  'prospero',
  'http',
  'imap',
  'https',
  'shttp',
  'rtsp',
  'rtsps',
  'rtspu',
  'sip',
  'sips',
  'mms',
  'sftp',
  'tel',
]);

const HEX = /^[0-9a-fA-F]+$/;
const DEC = /^[0-9]+$/;

/** `ipaddress.IPv4Address` (chặt: 4 octet thập phân ASCII, ≤255, không số 0 đứng đầu). */
export function isIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (p) => DEC.test(p) && p.length <= 3 && Number(p) <= 255 && !(p.length > 1 && p.startsWith('0')),
  );
}

/** `ipaddress.IPv6Address` (3.12, có scope id `%…`). */
export function isIPv6(s: string): boolean {
  let addr = s;
  const pct = s.indexOf('%');
  if (pct >= 0) {
    const scope = s.slice(pct + 1);
    if (!scope || scope.includes('%')) return false;
    addr = s.slice(0, pct);
  }
  if (!addr) return false;
  const parts = addr.split(':');
  if (parts.length < 3) return false;
  const last = parts[parts.length - 1] as string;
  if (last.includes('.')) {
    if (!isIPv4(last)) return false;
    parts.splice(parts.length - 1, 1, '0', '0');
  }
  if (parts.length > 9) return false;
  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skip !== null) return false;
      skip = i;
    }
  }
  if (skip !== null) {
    let hi = skip;
    let lo = parts.length - skip - 1;
    if (!parts[0]) {
      hi -= 1;
      if (hi) return false;
    }
    if (!parts[parts.length - 1]) {
      lo -= 1;
      if (lo) return false;
    }
    if (8 - (hi + lo) < 1) return false;
  } else {
    if (parts.length !== 8) return false;
    if (!parts[0] || !parts[parts.length - 1]) return false;
  }
  return parts.every((p) => p === '' || (HEX.test(p) && p.length <= 4));
}

function checkBracketedHost(h: string): void {
  if (h.startsWith('v')) {
    // Python `\Av[a-fA-F0-9]+\..+\Z`: `.` chỉ trừ '\n' (JS `.` trừ cả \r/\u2028/\u2029).
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/.test(h)) {
      throw new UrlError('IPvFuture address is invalid');
    }
    return;
  }
  if (isIPv4(h)) throw new UrlError('An IPv4 address cannot be in brackets');
  if (!isIPv6(h)) throw new UrlError(`'${h}' does not appear to be an IPv4 or IPv6 address`);
}

function checkNetloc(netloc: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: kiểm ASCII
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const n2 = n.normalize('NFKC');
  if (n === n2) return;
  for (const c of '/?#@:') {
    if (n2.includes(c)) {
      throw new UrlError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
}

/** Python `urlsplit(url, scheme)`. */
export function urlsplit(url: string, defScheme = ''): Split {
  let u = url.replace(C0_LEAD, '').replace(/[\t\r\n]/g, '');
  let scheme = defScheme;
  let netloc = '';
  let query = '';
  let fragment = '';
  const i = u.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(u) && SCHEME_CHARS.test(u.slice(0, i))) {
    scheme = u.slice(0, i).toLowerCase();
    u = u.slice(i + 1);
  }
  if (u.startsWith('//')) {
    let delim = u.length;
    for (const c of '/?#') {
      const w = u.indexOf(c, 2);
      if (w >= 0) delim = Math.min(delim, w);
    }
    netloc = u.slice(2, delim);
    u = u.slice(delim);
    if (netloc.includes('[') !== netloc.includes(']')) throw new UrlError('Invalid IPv6 URL');
    if (netloc.includes('[') && netloc.includes(']')) {
      const after = netloc.slice(netloc.indexOf('[') + 1);
      const j = after.indexOf(']');
      checkBracketedHost(j < 0 ? after : after.slice(0, j));
    }
  }
  const h = u.indexOf('#');
  if (h >= 0) [u, fragment] = [u.slice(0, h), u.slice(h + 1)];
  const q = u.indexOf('?');
  if (q >= 0) [u, query] = [u.slice(0, q), u.slice(q + 1)];
  checkNetloc(netloc);
  return { scheme, netloc, path: u, query, fragment };
}

function splitParams(url: string): [string, string] {
  let i: number;
  if (url.includes('/')) {
    i = url.indexOf(';', url.lastIndexOf('/'));
    if (i < 0) return [url, ''];
  } else {
    i = url.indexOf(';');
  }
  return [url.slice(0, i), url.slice(i + 1)];
}

/** Python `urlparse(url, scheme)`. */
export function urlparse(url: string, defScheme = ''): Parsed {
  const s = urlsplit(url, defScheme);
  let path = s.path;
  let params = '';
  if (USES_PARAMS.has(s.scheme) && path.includes(';')) [path, params] = splitParams(path);
  return { ...s, path, params };
}

export function urlunsplit(p: Split): string {
  let url = p.path;
  if (p.netloc) {
    if (url && !url.startsWith('/')) url = `/${url}`;
    url = `//${p.netloc}${url}`;
  } else if (url.startsWith('//')) {
    url = `//${url}`;
  } else if (p.scheme && USES_NETLOC.has(p.scheme) && (!url || url.startsWith('/'))) {
    url = `//${url}`;
  }
  if (p.scheme) url = `${p.scheme}:${url}`;
  if (p.query) url = `${url}?${p.query}`;
  if (p.fragment) url = `${url}#${p.fragment}`;
  return url;
}

export function urlunparse(p: Parsed): string {
  const path = p.params ? `${p.path};${p.params}` : p.path;
  return urlunsplit({ ...p, path });
}

/** Python `urljoin(base, url)` (RFC 3986). */
export function urljoin(base: string, url: string): string {
  if (!base) return url;
  if (!url) return base;
  const b = urlparse(base, '');
  const r = urlparse(url, b.scheme);
  let { netloc, path, params, query } = r;
  const { scheme, fragment } = r;
  if (scheme !== b.scheme || !USES_RELATIVE.has(scheme)) return url;
  if (USES_NETLOC.has(scheme)) {
    if (netloc) return urlunparse(r);
    netloc = b.netloc;
  }
  if (!path && !params) {
    path = b.path;
    params = b.params;
    if (!query) query = b.query;
    return urlunparse({ scheme, netloc, path, params, query, fragment });
  }
  const baseParts = b.path.split('/');
  if (baseParts[baseParts.length - 1] !== '') baseParts.pop();
  let segments: string[];
  if (path.startsWith('/')) {
    segments = path.split('/');
  } else {
    segments = [...baseParts, ...path.split('/')];
    if (segments.length > 2) {
      segments = [
        segments[0] as string,
        ...segments.slice(1, -1).filter((x) => x),
        segments[segments.length - 1] as string,
      ];
    }
  }
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else if (seg !== '.') resolved.push(seg);
  }
  const lastSeg = segments[segments.length - 1];
  if (lastSeg === '.' || lastSeg === '..') resolved.push('');
  return urlunparse({ scheme, netloc, path: resolved.join('/') || '/', params, query, fragment });
}

function hostinfo(netloc: string): [string, string | null] {
  const hi = netloc.slice(netloc.lastIndexOf('@') + 1);
  const ob = hi.indexOf('[');
  let host: string;
  let port: string;
  if (ob >= 0) {
    const br = hi.slice(ob + 1);
    const cb = br.indexOf(']');
    host = cb < 0 ? br : br.slice(0, cb);
    const rest = cb < 0 ? '' : br.slice(cb + 1);
    const c = rest.indexOf(':');
    port = c < 0 ? '' : rest.slice(c + 1);
  } else {
    const c = hi.indexOf(':');
    host = c < 0 ? hi : hi.slice(0, c);
    port = c < 0 ? '' : hi.slice(c + 1);
  }
  return [host, port || null];
}

/** `SplitResult.hostname` (null khi rỗng; giữ nguyên zone sau '%'). */
export function hostname(netloc: string): string | null {
  const [h] = hostinfo(netloc);
  if (!h) return null;
  const pct = h.indexOf('%');
  return pct < 0 ? h.toLowerCase() : h.slice(0, pct).toLowerCase() + h.slice(pct);
}

/** `SplitResult.port` — sai dạng/ngoài 0..65535 → UrlError. */
export function port(netloc: string): number | null {
  const [, p] = hostinfo(netloc);
  if (p === null) return null;
  if (!DEC.test(p)) {
    throw new UrlError(`Port could not be cast to integer value as '${p}'`);
  }
  const n = Number(p);
  if (!(n >= 0 && n <= 65535)) throw new UrlError('Port out of range 0-65535');
  return n;
}

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;

/** Python `quote(s, safe)` (UTF-8, ký tự ngoài safe → %XX hoa). Surrogate lẻ → lỗi như 'strict'. */
export function quote(s: string, safe = '/'): string {
  if (!s) return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 128 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))) {
      out += ch;
      continue;
    }
    if (cp >= 0xd800 && cp <= 0xdfff) throw new UrlError("'utf-8' codec can't encode surrogate");
    for (const b of Buffer.from(ch, 'utf8'))
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function quotePlus(s: string, safe = ''): string {
  if (!s.includes(' ')) return quote(s, safe);
  return quote(s, `${safe} `).replace(/ /g, '+');
}

const HEXPAIR = /^[0-9a-fA-F]{2}$/;

function unquoteBytes(s: string): Uint8Array {
  const parts = s.split('%');
  const out: number[] = [...Buffer.from(parts[0] as string, 'latin1')];
  for (const item of parts.slice(1)) {
    if (HEXPAIR.test(item.slice(0, 2))) {
      out.push(Number.parseInt(item.slice(0, 2), 16));
      out.push(...Buffer.from(item.slice(2), 'latin1'));
    } else {
      out.push(0x25, ...Buffer.from(item, 'latin1'));
    }
  }
  return Uint8Array.from(out);
}

const UTF8_REPLACE = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** Python `unquote(s)` (UTF-8, errors='replace'; chỉ giải mã trong đoạn ASCII liền). */
export function unquote(s: string): string {
  if (!s.includes('%')) return s;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: _asciire
  return s.replace(/[\x00-\x7f]+/g, (run) => UTF8_REPLACE.decode(unquoteBytes(run)));
}

export const unquotePlus = (s: string): string => unquote(s.replace(/\+/g, ' '));

/** Python `parse_qsl(qs, keep_blank_values)`. */
export function parseQsl(qs: string, keepBlank = false): [string, string][] {
  if (!qs) return [];
  const r: [string, string][] = [];
  for (const nv of qs.split('&')) {
    if (!nv) continue;
    const eq = nv.indexOf('=');
    const name = eq < 0 ? nv : nv.slice(0, eq);
    const value = eq < 0 ? '' : nv.slice(eq + 1);
    if (value || keepBlank) r.push([unquotePlus(name), unquotePlus(value)]);
  }
  return r;
}

/** Python `urlencode([(k, v), …])` (quote_plus). */
export function urlencode(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
}
