import { pyStrip } from '../env.js';

// Lớp tương thích `re`/str của Python cho security/ (bản Python là chuẩn). `\w` `\d` `\s` của Python
// là Unicode (JS mặc định ASCII); chỉ số Python theo code point (JS theo UTF-16). Các hàm 1 ký tự
// đã đối chiếu TOÀN BỘ code point với Python 3.12 (Unicode 15.0) trên Node 22: lower/upper/isupper/
// isspace/NFC/NFD/NFKC/NFKD khớp 100%; casefold khác `toLowerCase(toUpperCase())` đúng 174 ký tự
// (ı, Cherokee, ẞ — xử lý riêng dưới).

export { pyStrip };

/** Ruột lớp `\w` (str.isalnum() | '_' = L ∪ N ∪ '_', 0 khác biệt). */
export const W = '\\p{L}\\p{N}_';
/** Ruột lớp `\s` (str.isspace()). */
export const S =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Ruột lớp `[^\S\n]` (khoảng trắng trừ xuống dòng). */
export const S_NO_NL =
  '\\t\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** `\d` = Nd (str.isdecimal()). */
export const D = '\\p{Nd}';
/** `[^\W\d_]` = chữ (L) + số không thập phân (Nl, No). */
export const LETTER = '[\\p{L}\\p{Nl}\\p{No}]';
/** `$` của Python (không MULTILINE): cuối chuỗi HOẶC ngay trước '\n' cuối chuỗi. */
export const END = '(?=\\n?$)';

// unicodedata.combining(c) != 0 (sinh từ Python 3.12, Unicode 15.0 — \p{M} của JS khác 1528 ký tự).
const CCC =
  '\\u{300}-\\u{34e}\\u{350}-\\u{36f}\\u{483}-\\u{487}\\u{591}-\\u{5bd}\\u{5bf}\\u{5c1}-\\u{5c2}\\u{5c4}-\\u{5c5}\\u{5c7}\\u{610}-\\u{61a}\\u{64b}-\\u{65f}\\u{670}\\u{6d6}-\\u{6dc}\\u{6df}-\\u{6e4}\\u{6e7}-\\u{6e8}\\u{6ea}-\\u{6ed}\\u{711}\\u{730}-\\u{74a}\\u{7eb}-\\u{7f3}\\u{7fd}\\u{816}-\\u{819}\\u{81b}-\\u{823}\\u{825}-\\u{827}\\u{829}-\\u{82d}\\u{859}-\\u{85b}\\u{898}-\\u{89f}\\u{8ca}-\\u{8e1}\\u{8e3}-\\u{8ff}\\u{93c}\\u{94d}\\u{951}-\\u{954}\\u{9bc}\\u{9cd}\\u{9fe}\\u{a3c}\\u{a4d}\\u{abc}\\u{acd}\\u{b3c}\\u{b4d}\\u{bcd}\\u{c3c}\\u{c4d}\\u{c55}-\\u{c56}\\u{cbc}\\u{ccd}\\u{d3b}-\\u{d3c}\\u{d4d}\\u{dca}\\u{e38}-\\u{e3a}\\u{e48}-\\u{e4b}\\u{eb8}-\\u{eba}\\u{ec8}-\\u{ecb}\\u{f18}-\\u{f19}\\u{f35}\\u{f37}\\u{f39}\\u{f71}-\\u{f72}\\u{f74}\\u{f7a}-\\u{f7d}\\u{f80}\\u{f82}-\\u{f84}\\u{f86}-\\u{f87}\\u{fc6}\\u{1037}\\u{1039}-\\u{103a}\\u{108d}\\u{135d}-\\u{135f}\\u{1714}-\\u{1715}\\u{1734}\\u{17d2}\\u{17dd}\\u{18a9}\\u{1939}-\\u{193b}\\u{1a17}-\\u{1a18}\\u{1a60}\\u{1a75}-\\u{1a7c}\\u{1a7f}\\u{1ab0}-\\u{1abd}\\u{1abf}-\\u{1ace}\\u{1b34}\\u{1b44}\\u{1b6b}-\\u{1b73}\\u{1baa}-\\u{1bab}\\u{1be6}\\u{1bf2}-\\u{1bf3}\\u{1c37}\\u{1cd0}-\\u{1cd2}\\u{1cd4}-\\u{1ce0}\\u{1ce2}-\\u{1ce8}\\u{1ced}\\u{1cf4}\\u{1cf8}-\\u{1cf9}\\u{1dc0}-\\u{1dff}\\u{20d0}-\\u{20dc}\\u{20e1}\\u{20e5}-\\u{20f0}\\u{2cef}-\\u{2cf1}\\u{2d7f}\\u{2de0}-\\u{2dff}\\u{302a}-\\u{302f}\\u{3099}-\\u{309a}\\u{a66f}\\u{a674}-\\u{a67d}\\u{a69e}-\\u{a69f}\\u{a6f0}-\\u{a6f1}\\u{a806}\\u{a82c}\\u{a8c4}\\u{a8e0}-\\u{a8f1}\\u{a92b}-\\u{a92d}\\u{a953}\\u{a9b3}\\u{a9c0}\\u{aab0}\\u{aab2}-\\u{aab4}\\u{aab7}-\\u{aab8}\\u{aabe}-\\u{aabf}\\u{aac1}\\u{aaf6}\\u{abed}\\u{fb1e}\\u{fe20}-\\u{fe2f}\\u{101fd}\\u{102e0}\\u{10376}-\\u{1037a}\\u{10a0d}\\u{10a0f}\\u{10a38}-\\u{10a3a}\\u{10a3f}\\u{10ae5}-\\u{10ae6}\\u{10d24}-\\u{10d27}\\u{10eab}-\\u{10eac}\\u{10efd}-\\u{10eff}\\u{10f46}-\\u{10f50}\\u{10f82}-\\u{10f85}\\u{11046}\\u{11070}\\u{1107f}\\u{110b9}-\\u{110ba}\\u{11100}-\\u{11102}\\u{11133}-\\u{11134}\\u{11173}\\u{111c0}\\u{111ca}\\u{11235}-\\u{11236}\\u{112e9}-\\u{112ea}\\u{1133b}-\\u{1133c}\\u{1134d}\\u{11366}-\\u{1136c}\\u{11370}-\\u{11374}\\u{11442}\\u{11446}\\u{1145e}\\u{114c2}-\\u{114c3}\\u{115bf}-\\u{115c0}\\u{1163f}\\u{116b6}-\\u{116b7}\\u{1172b}\\u{11839}-\\u{1183a}\\u{1193d}-\\u{1193e}\\u{11943}\\u{119e0}\\u{11a34}\\u{11a47}\\u{11a99}\\u{11c3f}\\u{11d42}\\u{11d44}-\\u{11d45}\\u{11d97}\\u{11f41}-\\u{11f42}\\u{16af0}-\\u{16af4}\\u{16b30}-\\u{16b36}\\u{16ff0}-\\u{16ff1}\\u{1bc9e}\\u{1d165}-\\u{1d169}\\u{1d16d}-\\u{1d172}\\u{1d17b}-\\u{1d182}\\u{1d185}-\\u{1d18b}\\u{1d1aa}-\\u{1d1ad}\\u{1d242}-\\u{1d244}\\u{1e000}-\\u{1e006}\\u{1e008}-\\u{1e018}\\u{1e01b}-\\u{1e021}\\u{1e023}-\\u{1e024}\\u{1e026}-\\u{1e02a}\\u{1e08f}\\u{1e130}-\\u{1e136}\\u{1e2ae}\\u{1e2ec}-\\u{1e2ef}\\u{1e4ec}-\\u{1e4ef}\\u{1e8d0}-\\u{1e8d6}\\u{1e944}-\\u{1e94a}';
const COMBINING_G = new RegExp(`[${CCC}]`, 'gu');

// str.isdigit() = Nd + các số "Digit" (mũ, chỉ số dưới, số khoanh tròn…).
const DIGIT_RE =
  /^[\p{Nd}\u00b2\u00b3\u00b9\u1369-\u1371\u19da\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247c\u2488-\u2490\u24ea\u24f5-\u24fd\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]$/u;
const UPPER_RE = /^\p{Uppercase}$/u;
const SPACE_RE = new RegExp(`^[${S}]$`, 'u');
const ALNUM_RE = /^[\p{L}\p{N}]$/u;

/** Mọi hàm `isX` nhận MỘT code point (chuỗi rỗng → false). */
export const isDigit = (c: string): boolean => DIGIT_RE.test(c);
export const isUpper = (c: string): boolean => UPPER_RE.test(c);
export const isSpace = (c: string): boolean => SPACE_RE.test(c);
export const isAlnum = (c: string): boolean => ALNUM_RE.test(c);

/** Bỏ ký tự có combining class ≠ 0 (như `if not unicodedata.combining(c)`). */
export function stripCombining(s: string): string {
  return s.replace(COMBINING_G, '');
}

/** `llm_gateway._strip_accents`: NFD, đ/Đ → d/D, bỏ dấu kết hợp. */
export function stripAccents(s: string): string {
  return stripCombining(s.normalize('NFD').replaceAll('đ', 'd').replaceAll('Đ', 'D'));
}

/** Python `c.casefold()` cho 1 code point (có thể ra nhiều ký tự: ß → ss). */
export function casefoldChar(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  if (cp === 0x131) return c; // ı giữ nguyên
  if (cp >= 0x13a0 && cp <= 0x13f5) return c; // Cherokee hoa: casefold = chính nó
  if (cp >= 0x13f8 && cp <= 0x13fd) return String.fromCodePoint(cp - 8);
  if (cp >= 0xab70 && cp <= 0xabbf) return String.fromCodePoint(cp - 0xab70 + 0x13a0);
  if (cp === 0x1e9e) return 'ss';
  return c.toUpperCase().toLowerCase();
}

/** Python `s.casefold()`. */
export function casefold(s: string): string {
  let out = '';
  for (const c of s) out += casefoldChar(c);
  return out;
}

/** Python `len(s)` (số code point). */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Code point bắt đầu tại chỉ số UTF-16 `i` (`''` khi ngoài chuỗi) — Python `s[i]`. */
export function cpAt(s: string, i: number): string {
  const cp = s.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** Chỉ số UTF-16 sau khi đi tới `n` code point từ `i` (≤ s.length) — Python `i + n`. */
export function fwd(s: string, i: number, n: number): number {
  let j = i;
  for (let k = 0; k < n && j < s.length; k++) j += (s.codePointAt(j) ?? 0) > 0xffff ? 2 : 1;
  return Math.min(j, s.length);
}

/** Chỉ số UTF-16 sau khi lùi `n` code point từ `i` (≥ 0) — Python `max(0, i - n)`. */
export function back(s: string, i: number, n: number): number {
  let j = i;
  for (let k = 0; k < n && j > 0; k++) {
    const lo = s.charCodeAt(j - 1);
    j -= lo >= 0xdc00 && lo <= 0xdfff && j >= 2 && s.charCodeAt(j - 2) >= 0xd800 ? 2 : 1;
  }
  return Math.max(j, 0);
}

/** Bảng UTF-16 → chỉ số code point (offset trả ra ngoài theo Python). */
export function cpIndexer(s: string): (u: number) => number {
  const map = new Int32Array(s.length + 1);
  let cp = 0;
  for (let u = 0; u < s.length; u++) {
    map[u] = cp;
    const c = s.charCodeAt(u);
    if (!(c >= 0xd800 && c <= 0xdbff && u + 1 < s.length)) cp++;
  }
  map[s.length] = cp;
  return (u) => map[u];
}

const SPACE_RUN = new RegExp(`[${S}]+`, 'u');

/** Python `s.split()` (không đối số). */
export function pySplit(s: string): string[] {
  return s.split(SPACE_RUN).filter((x) => x !== '');
}

const LSTRIP = new RegExp(`^[${S}]+`, 'u');
const RSTRIP = new RegExp(`[${S}]+$`, 'u');
export const pyLstrip = (s: string): string => s.replace(LSTRIP, '');
export const pyRstrip = (s: string): string => s.replace(RSTRIP, '');

/** Python `str.splitlines()`. */
export function splitlines(s: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ranh giới dòng của Python (x1c-x1e)
  const out = s.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/u);
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Python `re.escape` cho mẫu JS cờ `u` (chỉ thoát ký tự cú pháp — cờ `u` cấm thoát thừa). */
export function reEscape(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

export function re(src: string, flags = ''): RegExp {
  return new RegExp(src, `u${flags}`);
}

const GLOBAL = new WeakMap<RegExp, RegExp>();
const STICKY = new WeakMap<RegExp, RegExp>();

function variant(rx: RegExp, flag: 'g' | 'y', cache: WeakMap<RegExp, RegExp>): RegExp {
  let v = cache.get(rx);
  if (!v) {
    v = new RegExp(rx.source, rx.flags.replace(/[gy]/g, '') + flag);
    cache.set(rx, v);
  }
  return v;
}

const cut = (s: string, end: number): string => (end < s.length ? s.slice(0, end) : s);

/** Python `rx.search(s, pos, endpos)`: lookbehind thấy trước `pos`, lookahead không thấy sau `endpos`. */
export function search(rx: RegExp, s: string, pos = 0, end = s.length): RegExpExecArray | null {
  const g = variant(rx, 'g', GLOBAL);
  g.lastIndex = pos;
  return g.exec(cut(s, end));
}

/** Python `rx.match(s, pos, endpos)` (neo tại `pos`). */
export function matchAt(rx: RegExp, s: string, pos = 0, end = s.length): RegExpExecArray | null {
  const y = variant(rx, 'y', STICKY);
  y.lastIndex = pos;
  return y.exec(cut(s, end));
}

/** Python `rx.finditer(s, pos, endpos)` — `matchAll` chép regex, lồng vòng an toàn. */
export function finditer(rx: RegExp, s: string, pos = 0, end = s.length): RegExpExecArray[] {
  const g = variant(rx, 'g', GLOBAL);
  g.lastIndex = pos;
  return [...cut(s, end).matchAll(g)];
}

/** Python `rx.findall(s, pos, endpos)` cho mẫu không có nhóm bắt. */
export function findall(rx: RegExp, s: string, pos = 0, end = s.length): string[] {
  return finditer(rx, s, pos, end).map((m) => m[0]);
}

/** Python `rx.sub(repl, s)`. */
export function sub(rx: RegExp, repl: string, s: string): string {
  return s.replace(variant(rx, 'g', GLOBAL), repl);
}

/** Python `bool(v)` cho giá trị JSON/tham số. */
export function pyTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python `str(v)` cho giá trị JSON (list/dict theo `repr` từng phần tử). */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(', ')}]`;
  if (typeof v === 'object') {
    const items = Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`);
    return `{${items.join(', ')}}`;
  }
  return String(v);
}

/** Python `repr(v)` cho giá trị JSON. */
export function pyReprValue(v: unknown): string {
  return typeof v === 'string' ? pyRepr(v) : pyStr(v);
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python `repr(s)` của chuỗi. */
export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    if (c === q || c === '\\') out += `\\${c}`;
    else if (c === '\t') out += '\\t';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c !== ' ' && NON_PRINTABLE.test(c)) {
      const h = cp.toString(16).padStart(cp < 0x100 ? 2 : cp < 0x10000 ? 4 : 8, '0');
      out += cp < 0x100 ? `\\x${h}` : cp < 0x10000 ? `\\u${h}` : `\\U${h}`;
    } else out += c;
  }
  return out + q;
}

/** Python `s[:n]` theo code point. */
export function cpHead(s: string, n: number): string {
  return s.slice(0, fwd(s, 0, n));
}

/** Python `bisect.bisect_right` / `bisect_left`. */
export function bisectRight(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < a[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function bisectLeft(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
