import CODECS from './xml-codecs.json' with { type: 'json' };

// Port tối thiểu `xml.etree.ElementTree.fromstring` (expat, có xử lý namespace) cho feed RSS/Atom
// của collector intel: kiểm well-formed như expat (thẻ lệch, thực thể chưa khai báo, ký tự cấm,
// prefix chưa bind, rác sau gốc…) → `XmlError` (Python ParseError). DOCTYPE/ENTITY bị chặn TRƯỚC ở
// `intel._parse`, nên ở đây gặp `<!DOCTYPE` cũng là lỗi. Comment/PI bị bỏ (TreeBuilder mặc định).
// Mã hóa: tên dựng sẵn của expat (utf-8/us-ascii/iso-8859-1, so không phân biệt hoa thường) + MỌI
// codec 1 byte mà pyexpat nhận qua Python (`xml-codecs.json` sinh từ Python thật: windows-1258,
// koi8-r…; byte không định nghĩa → 'invalid token'; codec nhiều byte → lỗi như pyexpat).
// shortcut: thông điệp lỗi không khớp chữ-từng-chữ expat ở vài chỗ (cột lỗi UTF-8 = 0, cột khi có
// BOM) — chỉ để log, cắt 80 ký tự.

export class XmlError extends Error {
  override name = 'ParseError';
}

export type XEl = { tag: string; attrs: Map<string, string>; items: (string | XEl)[] };

/** Python `_local(tag)` — phần sau '}' (tag đã mở rộng `{uri}local`). */
export const localName = (tag: string): string => tag.slice(tag.lastIndexOf('}') + 1);

/** `Element.itertext()` nối lại — duyệt LẶP (feed lồng sâu không tràn stack JS; C của Python cũng lặp). */
export function itertext(el: XEl | null): string {
  if (!el) return '';
  const out: string[] = [];
  const stack: [XEl, number][] = [[el, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1] as [XEl, number];
    const it = top[0].items[top[1]++];
    if (it === undefined) stack.pop();
    else if (typeof it === 'string') out.push(it);
    else stack.push([it, 0]);
  }
  return out.join('');
}

export function child(el: XEl, name: string): XEl | null {
  for (const it of el.items) if (typeof it !== 'string' && localName(it.tag) === name) return it;
  return null;
}

export const children = (el: XEl): XEl[] => el.items.filter((x): x is XEl => typeof x !== 'string');

const NS_XML = 'http://www.w3.org/XML/1998/namespace';
const START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_RE = new RegExp(
  `[${START}][${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`,
  'uy',
);
const BAD_CHAR =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ký tự cấm trong XML 1.0
  /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const WS = /[ \t\r\n]/;
const TEXT_RUN = /[^<&]+/y;
const PREDEF: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const CODEC = CODECS as {
  tables: Record<string, string>;
  multi: string[];
  rejected: string[];
  aliases: Record<string, string>;
};
const ASCII = String.fromCharCode(...Array.from({ length: 128 }, (_, i) => i));
// Tên dựng sẵn của expat (so không phân biệt hoa thường, KHÔNG chuẩn hóa) → codec cùng bảng.
const BUILTIN: Record<string, string> = { 'us-ascii': 'ascii', 'iso-8859-1': 'latin_1' };
const ENC_NAME = /^(?:[A-Za-z][A-Za-z0-9._-]*)?/; // EncName của XML 1.0
const own = (o: Record<string, string>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Lỗi expat tại vị trí `pos` của phần đầu tài liệu. */
function errAt(head: string, pos: number, what: string): never {
  const before = head.slice(0, pos);
  const col = pos - (before.lastIndexOf('\n') + 1);
  throw new XmlError(`${what}: line ${before.split('\n').length}, column ${col}`);
}

/** Bảng 256 ký tự (U+FFFD = byte không định nghĩa) pyexpat dùng cho tên mã hóa: chuẩn hóa như
 * `_Py_normalize_encoding` → `encodings.aliases` → codec Python. */
function codecMap(name: string, head: string, pos: number): string {
  const k = name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const mod =
    own(CODEC.aliases, k) ??
    own(CODEC.aliases, k.replaceAll('.', '_')) ??
    (k.includes('.') ? '' : k);
  const t = own(CODEC.tables, mod);
  if (t) return t.length === 256 ? t : ASCII + t;
  if (CODEC.multi.includes(mod)) throw new XmlError('multi-byte encodings are not supported');
  if (CODEC.rejected.includes(mod)) errAt(head, pos, 'unknown encoding');
  throw new XmlError(`unknown encoding: ${name}`);
}

function decode(data: Uint8Array): string {
  let bytes = data;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  // Đọc encoding khai báo ở `<?xml … ?>` đầu tài liệu (ASCII).
  const head = Buffer.from(bytes.subarray(0, 200)).toString('latin1');
  const m = /^<\?xml[ \t\r\n][^>]*?encoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/.exec(head);
  const name = m ? (m[1] ?? m[2] ?? '') : 'utf-8';
  const lower = name.toLowerCase();
  if (lower === 'utf-8') {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new XmlError('not well-formed (invalid token): line 1, column 0');
    }
  }
  const pos = m ? m.index + m[0].length - name.length - 1 : 0;
  const ok = (ENC_NAME.exec(name) as RegExpExecArray)[0].length;
  if (!name || ok < name.length) errAt(head, pos + ok, 'XML declaration not well-formed');
  if (['utf-16', 'utf-16be', 'utf-16le'].includes(lower)) {
    errAt(head, pos, 'encoding specified in XML declaration is incorrect');
  }
  const map = codecMap(own(BUILTIN, lower) ?? name, head, pos);
  // Byte không định nghĩa → U+FFFF: BAD_CHAR báo 'not well-formed (invalid token)' đúng vị trí byte.
  const units = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const c = map.charCodeAt(bytes[i] as number);
    units[i] = c === 0xfffd ? 0xffff : c;
  }
  return new TextDecoder('utf-16le').decode(units);
}

/** Thẻ đang mở: phần tử, tên gốc (so thẻ đóng), giá trị namespace cũ để hoàn tác khi đóng. */
type Frame = { el: XEl; qname: string; undo: [string, string | undefined][] };

class P {
  i = 0;
  // Bảng namespace GỘP prefix → uri ('' = bỏ khai báo) + hoàn tác theo thẻ: tra prefix O(1), không
  // duyệt chồng scope theo độ sâu (feed lồng sâu không thành O(n²)).
  readonly ns = new Map<string, string>([['xml', NS_XML]]);
  constructor(readonly s: string) {}

  err(what: string): never {
    const before = this.s.slice(0, this.i);
    const line = before.split('\n').length;
    const col = this.i - (before.lastIndexOf('\n') + 1);
    throw new XmlError(`${what}: line ${line}, column ${col}`);
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  starts(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }
  skipWs(): boolean {
    const a = this.i;
    while (!this.eof() && WS.test(this.s[this.i] as string)) this.i++;
    return this.i > a;
  }
  name(): string {
    NAME_RE.lastIndex = this.i;
    const m = NAME_RE.exec(this.s);
    if (!m) this.err(this.eof() ? 'unclosed token' : 'not well-formed (invalid token)');
    this.i += m[0].length;
    return m[0];
  }

  ref(): string {
    // this.s[this.i] === '&'
    const end = this.s.indexOf(';', this.i);
    if (end < 0) this.err('not well-formed (invalid token)');
    const body = this.s.slice(this.i + 1, end);
    let out: string;
    if (body.startsWith('#')) {
      const hex = body[1] === 'x';
      const digits = hex ? body.slice(2) : body.slice(1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
        this.err('not well-formed (invalid token)');
      }
      const n = Number.parseInt(digits, hex ? 16 : 10);
      const ok =
        n === 0x9 ||
        n === 0xa ||
        n === 0xd ||
        (n >= 0x20 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff);
      if (!ok || digits.length > 8) this.err('reference to invalid character number');
      out = String.fromCodePoint(n);
    } else {
      NAME_RE.lastIndex = 0;
      const nm = NAME_RE.exec(body);
      if (!nm || nm[0] !== body) this.err('not well-formed (invalid token)');
      if (!Object.hasOwn(PREDEF, body)) this.err('undefined entity');
      out = PREDEF[body] as string;
    }
    this.i = end + 1;
    return out;
  }

  comment(): void {
    // this.starts('<!--')
    const end = this.s.indexOf('--', this.i + 4);
    if (end < 0) this.err('unclosed token');
    if (this.s[end + 2] !== '>') this.err('not well-formed (invalid token)');
    this.i = end + 3;
  }

  pi(): void {
    this.i += 2;
    const target = this.name();
    if (target.toLowerCase() === 'xml') {
      this.err('XML or text declaration not at start of entity');
    }
    const end = this.s.indexOf('?>', this.i);
    if (end < 0) this.err('unclosed token');
    if (end > this.i && !WS.test(this.s[this.i] as string))
      this.err('not well-formed (invalid token)');
    this.i = end + 2;
  }

  misc(): boolean {
    if (this.skipWs()) return true;
    if (this.starts('<!--')) {
      this.comment();
      return true;
    }
    if (this.starts('<?')) {
      this.pi();
      return true;
    }
    return false;
  }

  resolve(qname: string, isAttr: boolean): string {
    const c = qname.indexOf(':');
    if (c < 0) {
      if (isAttr) return qname;
      const d = this.ns.get('');
      return d ? `{${d}}${qname}` : qname;
    }
    const prefix = qname.slice(0, c);
    const local = qname.slice(c + 1);
    if (!prefix || !local || local.includes(':')) this.err('not well-formed (invalid token)');
    const uri = this.ns.get(prefix);
    if (!uri) this.err('unbound prefix');
    return `{${uri}}${local}`;
  }

  /** Đóng scope namespace của thẻ (trả giá trị trước khi thẻ khai báo). */
  endScope(f: Frame): void {
    for (const [p, v] of f.undo) {
      if (v === undefined) this.ns.delete(p);
      else this.ns.set(p, v);
    }
  }

  attrValue(): string {
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") this.err('not well-formed (invalid token)');
    this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) this.err('unclosed token');
      const ch = this.s[this.i] as string;
      if (ch === q) {
        this.i++;
        return out;
      }
      if (ch === '<') this.err('not well-formed (invalid token)');
      if (ch === '&') {
        out += this.ref();
        continue;
      }
      out += ch === '\t' || ch === '\n' ? ' ' : ch;
      this.i++;
    }
  }

  /** Thẻ mở (con trỏ ở '<') → [thẻ, tự đóng `/>`]. Khai báo xmlns áp vào bảng gộp (hoàn tác ở
   * `endScope`). */
  startTag(): [Frame, boolean] {
    this.i++;
    const qname = this.name();
    const raw: [string, string][] = [];
    const seen = new Set<string>();
    const scope = new Map<string, string>();
    for (;;) {
      const ws = this.skipWs();
      if (this.starts('/>') || this.starts('>')) break;
      if (this.eof()) this.err('unclosed token');
      if (!ws) this.err('not well-formed (invalid token)');
      const at = this.i;
      const an = this.name();
      this.skipWs();
      if (this.s[this.i] !== '=') this.err('not well-formed (invalid token)');
      this.i++;
      this.skipWs();
      const v = this.attrValue();
      if (seen.has(an)) {
        this.i = at; // expat báo vị trí tên thuộc tính trùng
        this.err('duplicate attribute');
      }
      seen.add(an);
      raw.push([an, v]);
      if (an === 'xmlns') scope.set('', v);
      else if (an.startsWith('xmlns:')) {
        const p = an.slice(6);
        if (!v || p === 'xmlns') this.err('unbound prefix');
        scope.set(p, v);
      }
    }
    const undo: [string, string | undefined][] = [];
    for (const [p, v] of scope) {
      undo.push([p, this.ns.get(p)]);
      this.ns.set(p, v);
    }
    const attrs = new Map<string, string>();
    for (const [k, v] of raw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      const key = this.resolve(k, true);
      if (attrs.has(key)) this.err('duplicate attribute');
      attrs.set(key, v);
    }
    const f: Frame = { el: { tag: this.resolve(qname, false), attrs, items: [] }, qname, undo };
    const empty = this.starts('/>');
    this.i += empty ? 2 : 1;
    return [f, empty];
  }

  /** Phần tử (con trỏ ở '<') — duyệt LẶP với chồng thẻ tường minh, không đệ quy: feed lồng sâu
   * (50k thẻ) không tràn stack JS (RangeError làm chết cả lượt; expat của Python không đệ quy). */
  element(): XEl {
    const [root, rootEmpty] = this.startTag();
    if (rootEmpty) {
      this.endScope(root);
      return root.el;
    }
    const stack: Frame[] = [root];
    let text = '';
    for (;;) {
      const top = stack[stack.length - 1] as Frame;
      if (this.eof()) this.err('no element found');
      const ch = this.s[this.i] as string;
      if (ch === '<') {
        if (this.starts('</')) {
          this.i += 2;
          const end = this.name();
          this.skipWs();
          if (this.s[this.i] !== '>')
            this.err(this.eof() ? 'unclosed token' : 'not well-formed (invalid token)');
          if (end !== top.qname) this.err('mismatched tag');
          this.i++;
          if (text) top.el.items.push(text);
          text = '';
          this.endScope(top);
          stack.pop();
          if (!stack.length) return top.el;
          continue;
        }
        if (this.starts('<![CDATA[')) {
          const e = this.s.indexOf(']]>', this.i + 9);
          if (e < 0) this.err('unclosed CDATA section');
          text += this.s.slice(this.i + 9, e);
          this.i = e + 3;
          continue;
        }
        if (this.starts('<!--')) {
          this.comment();
          continue;
        }
        if (this.starts('<?')) {
          this.pi();
          continue;
        }
        if (this.starts('<!')) this.err('not well-formed (invalid token)');
        if (text) top.el.items.push(text);
        text = '';
        const [f, empty] = this.startTag();
        top.el.items.push(f.el);
        if (empty) this.endScope(f);
        else stack.push(f);
        continue;
      }
      if (ch === '&') {
        text += this.ref();
        continue;
      }
      // Đoạn chữ thường tới '<'/'&' kế tiếp (không được chứa "]]>").
      TEXT_RUN.lastIndex = this.i;
      const run = (TEXT_RUN.exec(this.s) as RegExpExecArray)[0];
      const bad = run.indexOf(']]>');
      if (bad >= 0) {
        this.i += bad;
        this.err('not well-formed (invalid token)');
      }
      text += run;
      this.i += run.length;
    }
  }

  document(): XEl {
    if (this.starts('<?xml') && WS.test(this.s[5] ?? '')) {
      const end = this.s.indexOf('?>');
      if (end < 0) this.err('unclosed token');
      const decl = this.s.slice(5, end);
      if (!/^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.[0-9]+\1/.test(decl)) {
        this.err('XML declaration not well-formed');
      }
      this.i = end + 2;
    }
    while (!this.eof() && this.misc());
    if (this.eof()) this.err('no element found');
    if (this.s[this.i] !== '<') this.err('syntax error');
    const root = this.element();
    while (!this.eof() && this.misc());
    if (!this.eof()) this.err('junk after document element');
    return root;
  }
}

/** `ET.fromstring(data)` → gốc. Lỗi well-formed/mã hóa → XmlError. */
export function parseXml(data: Uint8Array): XEl {
  const text = decode(data).replace(/\r\n?/g, '\n');
  const bad = BAD_CHAR.exec(text);
  if (bad) {
    const p = new P(text);
    p.i = bad.index;
    p.err('not well-formed (invalid token)');
  }
  return new P(text).document();
}
