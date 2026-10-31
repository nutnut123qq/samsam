import { pyStrip, S } from '@samsam/core/security/py';
import HTML5 from './html5-entities.json' with { type: 'json' };

// Port tối thiểu `BeautifulSoup(html, "html.parser")` (bs4 4.14.2 trên `html.parser` của Python
// 3.12.7) cho `crawler.collect.strip_html` + các trang NukeViet/Bricks: tokenizer `HTMLParser`
// (convert_charrefs=False như bs4 đặt), cây bs4 (không tự đóng thẻ, chỉ `_popToTag`), `get_text`,
// `select`/`select_one` với bộ chọn đơn giản. Chuỗi trong script/style/template/rt/rp KHÔNG vào
// `get_text` (bs4 coi là Script/Stylesheet/…); comment/doctype/PI cũng không; CDATA có.
// shortcut: bộ chọn chỉ có thẻ/.class/#id/[attr]/[attr=v]/[attr^=v] và danh sách dấu phẩy (không
// tổ hợp con cháu) — đủ cho collect.py; nâng khi parser mới cần bộ chọn khác.

/** bs4 `ParserRejectedMarkup` (html.parser ném AssertionError — vd `<![foo]]>`). */
export class ParserRejectedMarkup extends Error {
  override name = 'ParserRejectedMarkup';
}

const ENT5 = HTML5 as Record<string, string>;
/** bs4 `HTML_ENTITY_TO_CHARACTER` = tên html5 có ';' bỏ ';'. */
const BS4_ENT = new Map<string, string>();
for (const [k, v] of Object.entries(ENT5)) if (k.endsWith(';')) BS4_ENT.set(k.slice(0, -1), v);

const INVALID_CHARREFS: Record<number, string> = {
  0: '\ufffd',
  13: '\r',
  128: '€',
  129: '\x81',
  130: '‚',
  131: 'ƒ',
  132: '„',
  133: '…',
  134: '†',
  135: '‡',
  136: 'ˆ',
  137: '‰',
  138: 'Š',
  139: '‹',
  140: 'Œ',
  141: '\x8d',
  142: 'Ž',
  143: '\x8f',
  144: '\x90',
  145: '‘',
  146: '’',
  147: '“',
  148: '”',
  149: '•',
  150: '–',
  151: '—',
  152: '˜',
  153: '™',
  154: 'š',
  155: '›',
  156: 'œ',
  157: '\x9d',
  158: 'ž',
  159: 'Ÿ',
};
function invalidCodepoint(n: number): boolean {
  return (
    (n >= 1 && n <= 8) ||
    n === 11 ||
    (n >= 14 && n <= 31) ||
    (n >= 127 && n <= 159) ||
    (n >= 0xfdd0 && n <= 0xfdef) ||
    (n & 0xfffe) === 0xfffe
  );
}

const CHARREF_UNESCAPE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

/** Python `html.unescape` (bảng HTML5 đầy đủ, tên thiếu ';' theo luật tiền tố dài nhất). */
export function htmlUnescape(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(CHARREF_UNESCAPE, (_m, g: string) => {
    if (g[0] === '#') {
      const hex = g[1] === 'x' || g[1] === 'X';
      const digits = (hex ? g.slice(2) : g.slice(1)).replace(/;$/, '');
      const big = BigInt(hex ? `0x${digits}` : digits);
      if (big <= 159n && Object.hasOwn(INVALID_CHARREFS, Number(big))) {
        return INVALID_CHARREFS[Number(big)] as string;
      }
      if (big > 0x10ffffn || (big >= 0xd800n && big <= 0xdfffn)) return '\ufffd';
      const num = Number(big);
      if (invalidCodepoint(num)) return '';
      return String.fromCodePoint(num);
    }
    if (Object.hasOwn(ENT5, g)) return ENT5[g] as string;
    const cps = [...g];
    for (let x = cps.length - 1; x > 1; x--) {
      const pre = cps.slice(0, x).join('');
      if (Object.hasOwn(ENT5, pre)) return (ENT5[pre] as string) + cps.slice(x).join('');
    }
    return `&${g}`;
  });
}

// ---------------------------------------------------------------- cây

export type TextKind = 'text' | 'cdata' | 'other';
export type TextNode = { type: 'text'; kind: TextKind; value: string; parent: El };
export type El = {
  type: 'el';
  name: string;
  attrs: Map<string, string>;
  children: (El | TextNode)[];
  parent: El | null;
};

const VOID = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'command',
  'embed',
  'frame',
  'hr',
  'image',
  'img',
  'input',
  'isindex',
  'keygen',
  'link',
  'menuitem',
  'meta',
  'nextid',
  'param',
  'source',
  'spacer',
  'track',
  'wbr',
]);
const STRING_CONTAINERS = new Set(['rt', 'rp', 'style', 'script', 'template']);
const PRESERVE_WS = new Set(['pre', 'textarea']);
const ROOT = '[document]';
// biome-ignore lint/suspicious/noControlCharactersInRegex: bs4 ASCII_SPACES
const ASCII_SPACES_ONLY = /^[\x20\x0a\x09\x0c\x0d]*$/;

/** Bộ dựng cây bs4 (BeautifulSoup.handle_* + BeautifulSoupHTMLParser). */
class Builder {
  readonly root: El = { type: 'el', name: ROOT, attrs: new Map(), children: [], parent: null };
  private stack: El[] = [this.root];
  private containers: El[] = [];
  private data: string[] = [];
  private openCount = new Map<string, number>();
  private preserve = 0; // số pre/textarea đang mở (bs4 preserve_whitespace_tag_stack) — O(1)
  alreadyClosedEmpty: string[] = [];

  private get current(): El {
    return this.stack[this.stack.length - 1] as El;
  }

  endData(kind: TextKind | null = null): void {
    if (!this.data.length) return;
    let s = this.data.join('');
    this.data = [];
    if (!this.preserve && ASCII_SPACES_ONLY.test(s)) {
      s = s.includes('\n') ? '\n' : ' ';
    }
    // string_container: chuỗi thường trong rt/rp/style/script/template → loại khỏi get_text.
    const k: TextKind = kind ?? (this.containers.length ? 'other' : 'text');
    this.current.children.push({ type: 'text', kind: k, value: s, parent: this.current });
  }

  handleData(s: string): void {
    this.data.push(s);
  }

  private push(t: El): void {
    this.current.children.push(t);
    this.stack.push(t);
    this.openCount.set(t.name, (this.openCount.get(t.name) ?? 0) + 1);
    if (STRING_CONTAINERS.has(t.name)) this.containers.push(t);
    if (PRESERVE_WS.has(t.name)) this.preserve++;
  }

  private pop(): El {
    const t = this.stack.pop() as El;
    this.openCount.set(t.name, (this.openCount.get(t.name) ?? 1) - 1);
    if (this.containers.length && this.containers[this.containers.length - 1] === t) {
      this.containers.pop();
    }
    if (PRESERVE_WS.has(t.name)) this.preserve--;
    return t;
  }

  startTag(name: string, attrs: [string, string | null][], handleEmpty = true): void {
    this.endData();
    const map = new Map<string, string>();
    for (const [k, v] of attrs) map.set(k, v ?? ''); // trùng → giá trị sau (REPLACE)
    this.push({ type: 'el', name, attrs: map, children: [], parent: this.current });
    if (VOID.has(name) && handleEmpty) {
      this.endTag(name, false);
      this.alreadyClosedEmpty.push(name);
    }
  }

  endTag(name: string, checkClosed = true): void {
    if (checkClosed) {
      const i = this.alreadyClosedEmpty.indexOf(name);
      if (i >= 0) {
        this.alreadyClosedEmpty.splice(i, 1);
        return;
      }
    }
    this.endData();
    if (name === ROOT) return;
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (!this.openCount.get(name)) break;
      const t = this.stack[i] as El;
      if (t.name === name) {
        this.pop();
        break;
      }
      this.pop();
    }
  }

  special(data: string, kind: TextKind): void {
    this.endData();
    this.handleData(data);
    this.endData(kind);
  }

  finish(): El {
    this.endData();
    while (this.stack.length > 1) this.pop();
    return this.root;
  }
}

// ---------------------------------------------------------------- tokenizer (html.parser 3.12.7)

const sticky = (src: string, flags = '') => new RegExp(src, `uy${flags}`);
const INTERESTING = /[&<]/gu;
const INCOMPLETE = sticky('&[a-zA-Z#]');
const ENTITYREF = sticky('&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]');
const CHARREF = sticky('&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]');
const STARTTAGOPEN = sticky('<[a-zA-Z]');
const TAGFIND = sticky(`([a-zA-Z][^\\t\\n\\r\\f />\\x00]*)(?:[${S}]|/(?!>))*`);
const ATTRFIND = sticky(
  `((?<=['"${S}/])[^${S}/>][^${S}/=>]*)([${S}]*=+[${S}]*('[^']*'|"[^"]*"|(?!['"])[^>${S}]*))?(?:[${S}]|/(?!>))*`,
);
const LOCATESTARTTAGEND = sticky(
  `<[a-zA-Z][^\\t\\n\\r\\f />\\x00]*(?:[${S}/]*(?:(?<=['"${S}/])[^${S}/>][^${S}/=>]*(?:[${S}]*=+[${S}]*(?:'[^']*'|"[^"]*"|(?!['"])[^>${S}]*)[${S}]*)?(?:[${S}]|/(?!>))*)*)?[${S}]*`,
);
const ENDTAGFIND = sticky(`</[${S}]*([a-zA-Z][-.a-zA-Z0-9:_]*)[${S}]*>`);
const COMMENTCLOSE = new RegExp(`--[${S}]*>`, 'gu');
const MARKEDCLOSE = new RegExp(`[\\]][${S}]*[\\]][${S}]*>`, 'gu');
const MSMARKEDCLOSE = new RegExp(`[\\]][${S}]*>`, 'gu');
const DECLNAME = sticky(`[a-zA-Z][-_.a-zA-Z0-9]*[${S}]*`);
const CDATA_CONTENT = new Set(['script', 'style']);

function matchAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}
function searchFrom(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/** 1 byte windows-1252 → ký tự (Node TextDecoder('windows-1252') giải 0x80–0x9f như latin1). */
export function cp1252Char(b: number): string {
  return b >= 0x80 && b <= 0x9f ? (INVALID_CHARREFS[b] as string) : String.fromCharCode(b);
}

class Parser {
  raw = '';
  cdataElem: string | null = null;
  interesting: RegExp = INTERESTING;
  constructor(private readonly b: Builder) {}

  feed(data: string): void {
    this.raw += data;
    this.goahead(false);
  }
  close(): void {
    this.goahead(true);
  }

  private setCdata(elem: string): void {
    this.cdataElem = elem.toLowerCase();
    this.interesting = new RegExp(`</[${S}]*${this.cdataElem}[${S}]*>`, 'giu');
  }
  private clearCdata(): void {
    this.interesting = INTERESTING;
    this.cdataElem = null;
  }

  private charref(name: string): void {
    const hex = name.startsWith('x') || name.startsWith('X');
    const big = BigInt(hex ? `0x${name.replace(/^[xX]+/, '')}` : name);
    let data: string | null = null;
    if (big < 256n) {
      const n = Number(big);
      // Số < 256: giải mã windows-1252 (&#147; → dấu nháy kép trái); byte chưa định nghĩa → chr(n).
      data = cp1252Char(n);
    }
    if (!data) data = big <= 0x10ffffn ? String.fromCodePoint(Number(big)) : null;
    this.b.handleData(data || '\ufffd');
  }

  private entityref(name: string): void {
    this.b.handleData(BS4_ENT.get(name) ?? `&${name}`);
  }

  private goahead(end: boolean): void {
    const raw = this.raw;
    let i = 0;
    const n = raw.length;
    while (i < n) {
      let j: number;
      const m = searchFrom(this.interesting, raw, i);
      if (m) j = m.index;
      else {
        if (this.cdataElem) break;
        j = n;
      }
      if (i < j) this.b.handleData(raw.slice(i, j));
      i = j;
      if (i === n) break;
      if (raw.startsWith('<', i)) {
        let k: number;
        if (matchAt(STARTTAGOPEN, raw, i)) k = this.parseStarttag(i);
        else if (raw.startsWith('</', i)) k = this.parseEndtag(i);
        else if (raw.startsWith('<!--', i)) k = this.parseComment(i);
        else if (raw.startsWith('<?', i)) k = this.parsePi(i);
        else if (raw.startsWith('<!', i)) k = this.parseHtmlDeclaration(i);
        else if (i + 1 < n) {
          this.b.handleData('<');
          k = i + 1;
        } else break;
        if (k < 0) {
          if (!end) break;
          k = raw.indexOf('>', i + 1);
          if (k < 0) {
            k = raw.indexOf('<', i + 1);
            if (k < 0) k = i + 1;
          } else k += 1;
          this.b.handleData(raw.slice(i, k));
        }
        i = k;
      } else if (raw.startsWith('&#', i)) {
        const cm = matchAt(CHARREF, raw, i);
        if (cm) {
          this.charref(cm[0].slice(2, -1));
          let k = i + cm[0].length;
          if (raw[k - 1] !== ';') k -= 1;
          i = k;
          continue;
        }
        if (raw.slice(i).includes(';')) {
          this.b.handleData(raw.slice(i, i + 2));
          i += 2;
        }
        break;
      } else if (raw.startsWith('&', i)) {
        const em = matchAt(ENTITYREF, raw, i);
        if (em) {
          this.entityref(em[1] as string);
          let k = i + em[0].length;
          if (raw[k - 1] !== ';') k -= 1;
          i = k;
          continue;
        }
        const im = matchAt(INCOMPLETE, raw, i);
        if (im) {
          if (end && im[0] === raw.slice(i)) i += 1;
          break;
        }
        if (i + 1 < n) {
          this.b.handleData('&');
          i += 1;
        } else break;
      }
    }
    if (end && i < n && !this.cdataElem) {
      this.b.handleData(raw.slice(i, n));
      i = n;
    }
    this.raw = raw.slice(i);
  }

  private parseHtmlDeclaration(i: number): number {
    const raw = this.raw;
    if (raw.startsWith('<!--', i)) return this.parseComment(i);
    if (raw.startsWith('<![', i)) return this.parseMarkedSection(i);
    if (raw.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gt = raw.indexOf('>', i + 9);
      if (gt < 0) return -1;
      this.b.special(raw.slice(i + 2, gt), 'other');
      return gt + 1;
    }
    return this.parseBogusComment(i);
  }

  private parseBogusComment(i: number): number {
    const pos = this.raw.indexOf('>', i + 2);
    if (pos < 0) return -1;
    this.b.special(this.raw.slice(i + 2, pos), 'other');
    return pos + 1;
  }

  private parsePi(i: number): number {
    const j = this.raw.indexOf('>', i + 2);
    if (j < 0) return -1;
    this.b.special(this.raw.slice(i + 2, j), 'other');
    return j + 1;
  }

  private parseComment(i: number): number {
    const m = searchFrom(COMMENTCLOSE, this.raw, i + 4);
    if (!m) return -1;
    this.b.special(this.raw.slice(i + 4, m.index), 'other');
    return m.index + m[0].length;
  }

  private parseMarkedSection(i: number): number {
    const raw = this.raw;
    const at = i + 3;
    if (at === raw.length) return -1;
    const dm = matchAt(DECLNAME, raw, at);
    if (!dm) {
      throw new ParserRejectedMarkup(
        `expected name token at ${JSON.stringify(raw.slice(i, i + 20))}`,
      );
    }
    if (at + dm[0].length === raw.length) return -1;
    const name = pyStrip(dm[0]).toLowerCase();
    let m: RegExpExecArray | null;
    if (['temp', 'cdata', 'ignore', 'include', 'rcdata'].includes(name)) {
      m = searchFrom(MARKEDCLOSE, raw, at);
    } else if (['if', 'else', 'endif'].includes(name)) {
      m = searchFrom(MSMARKEDCLOSE, raw, at);
    } else {
      throw new ParserRejectedMarkup(`unknown status keyword in marked section`);
    }
    if (!m) return -1;
    const data = raw.slice(at, m.index);
    if (data.toUpperCase().startsWith('CDATA[')) this.b.special(data.slice(6), 'cdata');
    else this.b.special(data, 'other');
    return m.index + m[0].length;
  }

  private checkWholeStartTag(i: number): number {
    const raw = this.raw;
    const m = matchAt(LOCATESTARTTAGEND, raw, i);
    if (!m) throw new ParserRejectedMarkup('we should not get here!');
    const j = i + m[0].length;
    const next = raw.slice(j, j + 1);
    if (next === '>') return j + 1;
    if (next === '/') {
      if (raw.startsWith('/>', j)) return j + 2;
      if (raw.startsWith('/', j)) return -1;
      return j > i ? j : i + 1;
    }
    if (next === '') return -1;
    if (/^[a-zA-Z=/]$/.test(next)) return -1;
    return j > i ? j : i + 1;
  }

  private parseStarttag(i: number): number {
    const endpos = this.checkWholeStartTag(i);
    if (endpos < 0) return endpos;
    const raw = this.raw;
    const attrs: [string, string | null][] = [];
    const tm = matchAt(TAGFIND, raw, i + 1) as RegExpExecArray;
    let k = i + 1 + tm[0].length;
    const tag = (tm[1] as string).toLowerCase();
    while (k < endpos) {
      const am = matchAt(ATTRFIND, raw, k);
      if (!am) break;
      const name = am[1] as string;
      const rest = am[2];
      let value: string | null = am[3] ?? null;
      if (!rest) value = null;
      else if (
        value !== null &&
        value.length >= 1 &&
        ((value[0] === "'" && value[value.length - 1] === "'") ||
          (value[0] === '"' && value[value.length - 1] === '"'))
      ) {
        value = value.slice(1, -1);
      }
      if (value) value = htmlUnescape(value);
      attrs.push([name.toLowerCase(), value]);
      k += am[0].length;
    }
    const endText = pyStrip(raw.slice(k, endpos));
    if (endText !== '>' && endText !== '/>') {
      this.b.handleData(raw.slice(i, endpos));
      return endpos;
    }
    if (endText.endsWith('/>')) {
      // handle_startendtag của bs4: không coi là void tự đóng, rồi đóng ngay.
      this.b.startTag(tag, attrs, false);
      this.b.endTag(tag);
    } else {
      this.b.startTag(tag, attrs);
      if (CDATA_CONTENT.has(tag)) this.setCdata(tag);
    }
    return endpos;
  }

  private parseEndtag(i: number): number {
    const raw = this.raw;
    const gt = raw.indexOf('>', i + 1);
    if (gt < 0) return -1;
    const gtpos = gt + 1;
    const m = matchAt(ENDTAGFIND, raw, i);
    if (!m) {
      if (this.cdataElem !== null) {
        this.b.handleData(raw.slice(i, gtpos));
        return gtpos;
      }
      const nm = matchAt(TAGFIND, raw, i + 2);
      if (!nm) {
        if (raw.slice(i, i + 3) === '</>') return i + 3;
        return this.parseBogusComment(i);
      }
      const tagname = (nm[1] as string).toLowerCase();
      const g = raw.indexOf('>', i + 2 + nm[0].length);
      this.b.endTag(tagname);
      return g + 1;
    }
    const elem = (m[1] as string).toLowerCase();
    if (this.cdataElem !== null && elem !== this.cdataElem) {
      this.b.handleData(raw.slice(i, gtpos));
      return gtpos;
    }
    this.b.endTag(elem);
    this.clearCdata();
    return gtpos;
  }
}

/** `BeautifulSoup(html, "html.parser")` → gốc cây. Có thể ném ParserRejectedMarkup. */
export function parseHtml(html: string): El {
  const b = new Builder();
  const p = new Parser(b);
  p.feed(html);
  p.close();
  b.alreadyClosedEmpty = [];
  return b.finish();
}

// ---------------------------------------------------------------- truy vấn

/** Con cháu theo thứ tự tài liệu — duyệt LẶP (bs4 `.descendants` cũng lặp): HTML lồng sâu không
 * tràn stack JS và không thành O(n·độ sâu) như generator đệ quy. */
function* descendants(el: El): Generator<El | TextNode> {
  const stack: [El, number][] = [[el, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1] as [El, number];
    const c = top[0].children[top[1]++];
    if (c === undefined) {
      stack.pop();
      continue;
    }
    yield c;
    if (c.type === 'el') stack.push([c, 0]);
  }
}

/** bs4 `get_text(sep, strip)` — chỉ chuỗi thường + CDATA. */
export function getText(el: El, sep = '', strip = false): string {
  const out: string[] = [];
  for (const d of descendants(el)) {
    if (d.type !== 'text' || d.kind === 'other') continue;
    const v = strip ? pyStrip(d.value) : d.value;
    if (strip && !v) continue;
    out.push(v);
  }
  return out.join(sep);
}

const WS_RUN = new RegExp(`[${S}]+`, 'gu');

/** `crawler.collect.strip_html`: HTML → text sạch (bỏ tag, gom khoảng trắng). */
export function stripHtml(html: string): string {
  return getText(parseHtml(html), ' ', true).replace(WS_RUN, ' ');
}

type Cond =
  | { k: 'tag'; v: string }
  | { k: 'class'; v: string }
  | { k: 'id'; v: string }
  | { k: 'attr'; name: string; op: '' | '=' | '^='; v: string };

const CLASS_SPLIT = new RegExp(`[^${S}]+`, 'gu');

function parseCompound(sel: string): Cond[] {
  const out: Cond[] = [];
  const re =
    /([a-zA-Z][a-zA-Z0-9-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:(\^?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/gy;
  let at = 0;
  re.lastIndex = 0;
  while (at < sel.length) {
    const m = re.exec(sel);
    if (!m) break;
    at = re.lastIndex;
    if (m[1]) out.push({ k: 'tag', v: m[1].toLowerCase() });
    else if (m[2]) out.push({ k: 'class', v: m[2] });
    else if (m[3]) out.push({ k: 'id', v: m[3] });
    else {
      out.push({
        k: 'attr',
        name: (m[4] as string).toLowerCase(),
        op: (m[5] ?? '') as '' | '=' | '^=',
        v: m[6] ?? m[7] ?? m[8] ?? '',
      });
    }
  }
  if (at !== sel.length || !out.length) throw new Error(`bộ chọn không hỗ trợ: ${sel}`);
  return out;
}

function matches(el: El, conds: Cond[]): boolean {
  return conds.every((c) => {
    if (c.k === 'tag') return el.name === c.v;
    if (c.k === 'id') return el.attrs.get('id') === c.v;
    if (c.k === 'class')
      return (el.attrs.get('class') ?? '').match(CLASS_SPLIT)?.includes(c.v) ?? false;
    const v = el.attrs.get(c.name);
    if (v === undefined) return false;
    if (c.op === '=') return v === c.v;
    if (c.op === '^=') return c.v !== '' && v.startsWith(c.v);
    return true;
  });
}

/** soupsieve `select` (thứ tự tài liệu, không trùng). */
export function select(el: El, selector: string): El[] {
  const groups = selector.split(',').map((s) => parseCompound(s.trim()));
  const out: El[] = [];
  for (const d of descendants(el)) {
    if (d.type === 'el' && groups.some((g) => matches(d, g))) out.push(d);
  }
  return out;
}

export const selectOne = (el: El, selector: string): El | null => select(el, selector)[0] ?? null;

/** bs4 `find(name)` — phần tử con cháu đầu tiên theo tên thẻ. */
export const find = (el: El, name: string): El | null => selectOne(el, name);

/** bs4 `decompose()` — gỡ khỏi cây. */
export function decompose(el: El): void {
  const p = el.parent;
  if (!p) return;
  const i = p.children.indexOf(el);
  if (i >= 0) p.children.splice(i, 1);
  el.parent = null;
}
