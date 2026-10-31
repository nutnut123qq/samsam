import { inflateSync, constants as zc } from 'node:zlib';
import TABLES from './pdf-tables.json' with { type: 'json' };

// Lớp chữ PDF từng trang — thay `pypdf.PdfReader(...).pages[i].extract_text()` mà
// `ingest/doc_intake.pdf_page_texts` dùng (Python không mạng, không OCR). Repo TS chưa có gói đọc PDF
// (không thêm gói khi port) → bộ đọc TỐI THIỂU: đối tượng/bảng xref quét lại từ byte, object stream,
// lọc Flate/ASCIIHex/ASCII85, toán tử chữ Tj/TJ/'/" + Td/TD/Tm/T* + cm/q/Q, Form XObject, mã hóa
// chuẩn/WinAnsi/MacRoman/PDFDoc + /Differences (bảng trích từ pypdf — `pdf-tables.json`), ToUnicode CMap.
// Xuống dòng/khoảng trắng theo vị trí chữ (gần đúng heuristic của pypdf).
// shortcut: không có độ rộng glyph chuẩn của font không nhúng /Widths (ước 0,5 em) và không đọc font
// nhúng — chỗ ngắt khoảng trắng có thể khác pypdf; nâng bằng gói đọc PDF (pdfjs-dist) hoặc route
// lớp chữ PDF ở AI worker (pypdf) khi được duyệt.
// KHÁC pypdf có chủ đích (chặt hơn = fail-closed): trang dùng font Type0 KHÔNG có ToUnicode (pypdf giải
// mã CID như UTF-16 → chữ rác vẫn tính "có lớp chữ", pii_flag=False sai) hoặc lọc nén chưa hỗ trợ →
// trang coi như KHÔNG có chữ (cả tài liệu sang nhánh OCR, pii NULL — không gửi LLM).

/** PDF hỏng/không đọc được — `pyType` = tên lỗi pypdf tương ứng (in trong "PDF hỏng: <loại>"). */
export class PdfError extends Error {
  constructor(readonly pyType: string) {
    super(pyType);
  }
}
/** PDF mã hóa (trailer có /Encrypt) — pypdf `reader.is_encrypted`. */
export class PdfEncrypted extends Error {}

class Name {
  constructor(readonly v: string) {}
}
class Ref {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
class Op {
  constructor(readonly v: string) {}
}
class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: Uint8Array,
  ) {}
}
type Dict = Map<string, Obj>;
type Obj = null | boolean | number | Uint8Array | Name | Ref | Op | Obj[] | Dict | Stream;

const isDict = (o: unknown): o is Dict => o instanceof Map;
/** Trần byte sau giải nén MỘT stream (pypdf cũng giới hạn — chống bom nén). */
export const MAX_INFLATE = 75 * 1024 * 1024;
/** Trần CÔNG VIỆC một tài liệu, quy ra byte nội dung đã chạy (trang + MỖI lần gọi Form; ~180 ns/byte
 * toán tử dày trên máy dev → trần ≈ 10 s): + byte giải nén /16 + ô bảng font/CMap. PDF độc (Form lồng
 * bùng nổ, trang dùng lại nội dung khổng lồ, bom nén nhiều stream…) vượt → PdfError('LimitReachedError')
 * → DocError, lô chạy tiếp. KHÁC pypdf có chủ đích (pypdf không trần → treo cả lô); PDF thật > 64 MB nội
 * dung (pypdf mất hàng phút) cũng bị từ chối — lệch về phía an toàn. */
export const MAX_WORK = 64 * 1024 * 1024;
/** Trần ký tự chữ ra một tài liệu (CMap 1 mã → chuỗi dài, Form lồng). */
export const MAX_TEXT = 32 * 1024 * 1024;
/** Một ô dải bfrange (chuyển mã UTF-16 + Map.set, ~1 µs) quy ra byte nội dung. */
const CELL_WORK = 8;
class LimitReached extends Error {}
// pdfPageTexts đồng bộ, không gọi lồng → bộ đếm cấp module, đặt lại đầu mỗi lần gọi.
let work = 0;
let chars = 0;
const spend = (n: number): void => {
  work += n;
  if (work > MAX_WORK) throw new LimitReached();
};
const nameOf = (o: unknown): string | null => (o instanceof Name ? o.v : null);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const latin1 = (b: Uint8Array) =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');

// ------------------------------------------------------------------------------- lexer/parser

class Lexer {
  pos: number;
  constructor(
    readonly b: Uint8Array,
    pos = 0,
    readonly end = b.length,
  ) {
    this.pos = pos;
  }

  skipWs(): void {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** Token tiếp theo: Obj (không ghép Ref) | '<<' '>>' '[' ']' '{' '}' | null (hết). */
  token(): Obj | string | undefined {
    this.skipWs();
    const b = this.b;
    if (this.pos >= this.end) return undefined;
    const c = b[this.pos];
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return '<<';
      }
      return this.hex();
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] !== 0x3e) throw new PdfError('PdfReadError');
      this.pos += 2;
      return '>>';
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.pos++;
      return String.fromCharCode(c);
    }
    if (c === 0x2f) return this.name();
    const start = this.pos;
    while (this.pos < this.end && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    if (this.pos === start) {
      this.pos++; // ký tự lạ (`)` lẻ) — bỏ
      return new Op(String.fromCharCode(c));
    }
    const w = latin1(b.subarray(start, this.pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return Number(w);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Op(w);
  }

  private name(): Name {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    while (this.pos < this.end && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) {
      const c = b[this.pos];
      const h = c === 0x23 ? latin1(b.subarray(this.pos + 1, this.pos + 3)) : '';
      if (h && /^[0-9a-fA-F]{2}$/.test(h)) {
        out.push(Number.parseInt(h, 16));
        this.pos += 3;
      } else {
        out.push(c);
        this.pos++;
      }
    }
    return new Name(Buffer.from(out).toString('latin1'));
  }

  private hex(): Uint8Array {
    const b = this.b;
    this.pos++;
    let digits = '';
    while (this.pos < this.end && b[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(b[this.pos++]);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
    }
    if (this.pos >= this.end) throw new PdfError('PdfStreamError');
    this.pos++;
    if (digits.length % 2) digits += '0';
    return Uint8Array.from(Buffer.from(digits, 'hex'));
  }

  private literal(): Uint8Array {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const e = b[this.pos++];
        const map: Record<number, number> = {
          110: 10,
          114: 13,
          116: 9,
          98: 8,
          102: 12,
          40: 0x28,
          41: 0x29,
          92: 0x5c,
        };
        if (e === undefined) break;
        if (e in map) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) {
            v = v * 8 + (b[this.pos++] - 0x30);
          }
          out.push(v & 0xff);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++; // \<CR><LF> = nối dòng
        } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return Uint8Array.from(out);
      out.push(c);
    }
    throw new PdfError('PdfStreamError');
  }

  /** Một đối tượng hoàn chỉnh (dict/array/ref ghép). */
  object(): Obj {
    const t = this.token();
    if (t === undefined) throw new PdfError('PdfStreamError');
    return this.finish(t);
  }

  private depth = 0;

  private finish(t: Obj | string): Obj {
    if (t === '<<' || t === '[') {
      // lồng quá sâu (PDF độc hại) → lỗi có kiểm soát thay vì tràn ngăn xếp
      if (++this.depth > 256) throw new PdfError('PdfReadError');
      try {
        return this.container(t);
      } finally {
        this.depth--;
      }
    }
    return this.scalar(t);
  }

  private container(t: '<<' | '['): Obj {
    if (t === '<<') {
      const d: Dict = new Map();
      for (;;) {
        const k = this.token();
        if (k === '>>') return d;
        if (!(k instanceof Name)) throw new PdfError('PdfReadError');
        d.set(k.v, this.object());
      }
    }
    const a: Obj[] = [];
    for (;;) {
      const x = this.token();
      if (x === ']') return a;
      if (x === undefined) throw new PdfError('PdfStreamError');
      a.push(this.finish(x));
    }
  }

  private scalar(t: Obj | string): Obj {
    if (typeof t === 'string') throw new PdfError('PdfReadError');
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
      const save = this.pos;
      const g = this.token();
      if (typeof g === 'number' && Number.isInteger(g) && g >= 0) {
        const r = this.token();
        if (r instanceof Op && r.v === 'R') return new Ref(t, g);
      }
      this.pos = save;
    }
    return t;
  }
}

// ------------------------------------------------------------------------------- tài liệu

function decodeFilters(s: Stream, resolve: (o: Obj) => Obj): Uint8Array | null {
  let f = resolve(s.dict.get('Filter') ?? null);
  let parms = resolve(s.dict.get('DecodeParms') ?? null);
  const filters = Array.isArray(f) ? f : f === null ? [] : [f];
  const ps = Array.isArray(parms) ? parms : [parms];
  let data = s.raw;
  for (let i = 0; i < filters.length; i++) {
    f = resolve(filters[i]);
    parms = resolve(ps[i] ?? null);
    const pred = isDict(parms) ? resolve(parms.get('Predictor') ?? null) : null;
    if (typeof pred === 'number' && pred > 1) return null; // predictor: chưa hỗ trợ
    const n = nameOf(f);
    try {
      if (n === 'FlateDecode' || n === 'Fl') {
        // trần giải nén (bom nén) — vượt → stream coi như không giải mã được (fail-closed)
        data = inflateSync(data, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATE });
      } else if (n === 'ASCIIHexDecode' || n === 'AHx') {
        let h = latin1(data).replace(/[^0-9a-fA-F>]/g, '');
        h = h.split('>')[0];
        if (h.length % 2) h += '0';
        data = Uint8Array.from(Buffer.from(h, 'hex'));
      } else if (n === 'ASCII85Decode' || n === 'A85') {
        data = a85(data);
      } else return null;
    } catch {
      return null;
    }
    spend(data.length / 16); // giải nén rẻ hơn lex ~100 lần — vẫn chặn bom nhiều stream
  }
  return data;
}

function a85(src: Uint8Array): Uint8Array {
  const s = latin1(src).replace(/\s/g, '').replace(/^<~/, '').split('~>')[0];
  const out: number[] = [];
  let grp: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (grp[i] ?? 84);
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n));
    grp = [];
  };
  for (const ch of s) {
    if (ch === 'z' && grp.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) throw new Error('a85');
    grp.push(c);
    if (grp.length === 5) flush(4);
  }
  if (grp.length) flush(grp.length - 1);
  return Uint8Array.from(out);
}

class Doc {
  readonly objs = new Map<number, Obj>();
  readonly trailers: Dict[] = [];

  constructor(readonly b: Uint8Array) {
    const text = latin1(b);
    if (!text.slice(0, 1024).includes('%PDF-')) throw new PdfError('PdfStreamError');
    const lenRefs: [Dict, Ref, number, number][] = [];
    // Bỏ "n g obj" nằm TRONG dữ liệu stream đã đọc (byte nén có thể trùng mẫu).
    let skipUntil = 0;
    const heads = [...text.matchAll(/(?<![0-9])(\d+)\s+(\d+)\s+obj\b/g)];
    for (const [i, m] of heads.entries()) {
      if (m.index < skipUntil) continue;
      // Mỗi lần parse dừng ở đầu đối tượng KẾ → tổng tuyến tính (chuỗi hex/literal không đóng lặp lại
      // ngàn lần không còn đọc tới cuối tệp mỗi lần — O(n²)).
      // shortcut: chuỗi literal chứa đúng chữ "n g obj" bị cắt → đối tượng đó mất; nâng bằng đọc theo xref.
      const lx = new Lexer(b, m.index + m[0].length, heads[i + 1]?.index ?? b.length);
      try {
        const o = lx.object();
        const num = Number(m[1]);
        if (isDict(o)) {
          const after = /^\s*stream(\r\n|\n|\r)/.exec(text.slice(lx.pos, lx.pos + 16));
          if (after) {
            const start = lx.pos + after[0].length;
            const st = this.streamAt(o, start, text);
            this.objs.set(num, st);
            skipUntil = start + st.raw.length;
            const L = o.get('Length');
            if (L instanceof Ref) lenRefs.push([o, L, start, num]);
            if (nameOf(o.get('Type')) === 'XRef') this.trailers.push(o);
            continue;
          }
        }
        this.objs.set(num, o);
      } catch (e) {
        if (!(e instanceof PdfError)) throw e;
      }
    }
    // Length gián tiếp: cắt lại khi số độ dài đọc được + theo sau là endstream.
    for (const [d, ref, start, num] of lenRefs) {
      const L = this.objs.get(ref.num);
      if (typeof L === 'number' && /^\s*endstream/.test(text.slice(start + L, start + L + 32))) {
        this.objs.set(num, new Stream(d, b.subarray(start, start + L)));
      }
    }
    const trs = [...text.matchAll(/trailer\s*<</g)];
    for (const [i, m] of trs.entries()) {
      try {
        const o = new Lexer(b, m.index + 7, trs[i + 1]?.index ?? b.length).object();
        if (isDict(o)) this.trailers.push(o);
      } catch (e) {
        if (!(e instanceof PdfError)) throw e;
      }
    }
    // Object stream: đối tượng nén — đối tượng trực tiếp (bản sau) được ưu tiên.
    for (const o of [...this.objs.values()]) {
      if (!(o instanceof Stream) || nameOf(o.dict.get('Type')) !== 'ObjStm') continue;
      const data = decodeFilters(o, (x) => this.resolve(x));
      const n = this.resolve(o.dict.get('N') ?? null);
      const first = this.resolve(o.dict.get('First') ?? null);
      if (!data || typeof n !== 'number' || typeof first !== 'number') continue;
      const hdr = new Lexer(data, 0, Math.min(first, data.length));
      try {
        const pairs: [number, number][] = [];
        for (let i = 0; i < n; i++) {
          const num = hdr.object();
          const off = hdr.object();
          if (typeof num !== 'number' || typeof off !== 'number') break;
          pairs.push([num, off]);
        }
        // Mỗi offset parse MỘT lần, dừng ở offset kế (offset trùng/chồng lên chuỗi dài → không O(n²)).
        const offs = [...new Set(pairs.map(([, off]) => off))].sort((x, y) => x - y);
        const next = new Map(offs.map((off, j) => [off, offs[j + 1]]));
        const parsed = new Map<number, Obj>();
        for (const [num, off] of pairs) {
          if (this.objs.has(num)) continue;
          if (!parsed.has(off)) {
            const end = Math.min(first + (next.get(off) ?? data.length), data.length);
            parsed.set(off, new Lexer(data, first + off, end).object());
          }
          this.objs.set(num, parsed.get(off) ?? null);
        }
      } catch (e) {
        if (!(e instanceof PdfError)) throw e;
      }
    }
    if (!this.objs.size) throw new PdfError('PdfStreamError');
  }

  /** [từ vị trí, endstream đầu tiên sau đó | -1] — header quét theo thứ tự tăng → tìm lại chỉ khi vượt. */
  private endHit: [number, number] | null = null;

  private streamAt(d: Dict, start: number, text: string): Stream {
    const L = d.get('Length');
    if (typeof L === 'number' && /^\s*endstream/.test(text.slice(start + L, start + L + 32))) {
      return new Stream(d, this.b.subarray(start, start + L));
    }
    let h = this.endHit;
    if (!h || start < h[0] || (h[1] >= 0 && h[1] < start)) {
      h = [start, text.indexOf('endstream', start)];
      this.endHit = h;
    }
    const e = h[1];
    if (e < 0) throw new PdfError('PdfStreamError');
    let end = e;
    if (this.b[end - 1] === 10) end--;
    if (this.b[end - 1] === 13) end--;
    return new Stream(d, this.b.subarray(start, Math.max(start, end)));
  }

  resolve(o: Obj, depth = 0): Obj {
    let x = o;
    for (let i = 0; x instanceof Ref && i < 32 + depth; i++) x = this.objs.get(x.num) ?? null;
    return x instanceof Ref ? null : x;
  }

  get encrypted(): boolean {
    return this.trailers.some((t) => t.has('Encrypt'));
  }

  root(): Dict {
    for (const t of [...this.trailers].reverse()) {
      const r = this.resolve(t.get('Root') ?? null);
      if (isDict(r)) return r;
    }
    for (const o of [...this.objs.values()].reverse()) {
      if (isDict(o) && nameOf(o.get('Type')) === 'Catalog') return o;
    }
    throw new PdfError('PdfReadError');
  }

  /** Trang theo cây /Pages, kèm /Resources thừa kế. */
  pages(): [Dict, Dict | null][] {
    const out: [Dict, Dict | null][] = [];
    const seen = new Set<Obj>();
    const walk = (node: Obj, res: Dict | null, depth: number) => {
      const n = this.resolve(node);
      if (!isDict(n) || seen.has(n) || depth > 64) return;
      seen.add(n);
      const r = this.resolve(n.get('Resources') ?? null);
      const own = isDict(r) ? r : res;
      const kids = this.resolve(n.get('Kids') ?? null);
      if (nameOf(n.get('Type')) === 'Pages' || Array.isArray(kids)) {
        for (const k of Array.isArray(kids) ? kids : []) walk(k, own, depth + 1);
      } else out.push([n, own]);
    };
    const pagesNode = this.resolve(this.root().get('Pages') ?? null);
    if (!isDict(pagesNode)) throw new PdfError('PdfReadError');
    walk(pagesNode, null, 0);
    return out;
  }
}

// ------------------------------------------------------------------------------- font

type Font = {
  /** mã → chuỗi; null = không giải mã được (trang bỏ). */
  decode: (s: Uint8Array) => [string, number[]][] | null;
  /** độ rộng (phần nghìn em) theo mã */
  width: (code: number) => number;
  space: number;
  twoByte: boolean;
};

const T = TABLES as unknown as {
  std: string[];
  win: string[];
  mac: string[];
  pdfdoc: string[];
  glyphs: Record<string, string>;
};
const CHARSETS: Record<string, string[]> = {
  StandardEncoding: T.std,
  WinAnsiEncoding: T.win,
  MacRomanEncoding: T.mac,
  PDFDocEncoding: T.pdfdoc,
};
const LATIN1 = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
const DEFAULT_W = 500;
const DEFAULT_SPACE = 278;

/** Thân các khối `begin<tag> … end<tag>` — quét bằng indexOf (tuyến tính; regex lười
 * `begin…([\s\S]*?)end…` thành O(n²) khi hàng ngàn `begin` thiếu `end`). */
function* blocks(src: string, tag: string): Generator<string> {
  for (let i = 0; ; ) {
    const a = src.indexOf(`begin${tag}`, i);
    if (a < 0) return;
    const z = src.indexOf(`end${tag}`, a);
    if (z < 0) return;
    yield src.slice(a + 5 + tag.length, z);
    i = z + 3 + tag.length;
  }
}

/** ToUnicode CMap → [mã → chuỗi theo số byte, các độ dài mã]. */
function parseCMap(data: Uint8Array): [Map<string, string>, Set<number>] {
  const map = new Map<string, string>();
  const lens = new Set<number>();
  const src = latin1(data);
  const hex = (h: string) => h.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  const u16 = (h: string) => {
    const x = hex(h);
    return Buffer.from(x.length % 4 ? x.padStart(Math.ceil(x.length / 4) * 4, '0') : x, 'hex')
      .swap16()
      .toString('utf16le');
  };
  for (const blk of blocks(src, 'codespacerange')) {
    for (const m of blk.matchAll(/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g)) {
      lens.add(hex(m[1]).length / 2);
    }
  }
  for (const blk of blocks(src, 'bfchar')) {
    for (const m of blk.matchAll(/<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g)) {
      const k = hex(m[1]);
      map.set(k, u16(m[2]));
      lens.add(k.length / 2);
    }
  }
  for (const blk of blocks(src, 'bfrange')) {
    // mảng đích không chứa `[` → mỗi `[` không đóng chỉ quét tới `[` kế (không O(n²))
    const re = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<[0-9a-fA-F\s]*>|\[[^\][]*\])/g;
    for (const m of blk.matchAll(re)) {
      const lo = hex(m[1]);
      const n = lo.length;
      const a = Number.parseInt(lo, 16);
      const z = Number.parseInt(hex(m[2]), 16);
      lens.add(n / 2);
      if (!(z >= a) || z - a > 65535) continue;
      const key = (v: number) => v.toString(16).padStart(n, '0');
      if (m[3].startsWith('[')) {
        const dsts = [...m[3].matchAll(/<([0-9a-fA-F\s]*)>/g)].map((x) => u16(x[1]));
        for (let v = a; v <= z && v - a < dsts.length; v++) map.set(key(v), dsts[v - a]);
      } else {
        // ngàn dải 0000–FFFF chồng nhau = hàng tỉ ô → tính vào trần công việc
        spend((z - a + 1) * CELL_WORK);
        const d = hex(m[3]);
        const base = Number.parseInt(d, 16);
        for (let v = a; v <= z; v++) {
          map.set(key(v), u16((base + v - a).toString(16).padStart(d.length, '0')));
        }
      }
    }
  }
  return [map, lens];
}

function loadFont(doc: Doc, fd: Obj): Font {
  const f = doc.resolve(fd);
  const d: Dict = isDict(f) ? f : new Map();
  const sub = nameOf(d.get('Subtype'));
  const type0 = sub === 'Type0';
  let cmap: [Map<string, string>, Set<number>] | null = null;
  const tu = doc.resolve(d.get('ToUnicode') ?? null);
  if (tu instanceof Stream) {
    const data = decodeFilters(tu, (x) => doc.resolve(x));
    if (data) cmap = parseCMap(data);
  }
  // độ rộng
  const widths = new Map<number, number>();
  let dw = DEFAULT_W;
  if (type0) {
    const dfs = doc.resolve(d.get('DescendantFonts') ?? null);
    const dd = Array.isArray(dfs) ? doc.resolve(dfs[0] ?? null) : null;
    if (isDict(dd)) {
      const v = doc.resolve(dd.get('DW') ?? null);
      if (typeof v === 'number') dw = v;
      const w = doc.resolve(dd.get('W') ?? null);
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length; ) {
          const c = doc.resolve(w[i]);
          const nx = doc.resolve(w[i + 1] ?? null);
          if (typeof c !== 'number') break;
          if (Array.isArray(nx)) {
            nx.forEach((x, j) => {
              const v2 = doc.resolve(x);
              if (typeof v2 === 'number') widths.set(c + j, v2);
            });
            i += 2;
          } else {
            const ww = doc.resolve(w[i + 2] ?? null);
            if (typeof nx === 'number' && typeof ww === 'number' && nx - c <= 65535) {
              spend(Math.max(0, nx - c + 1));
              for (let k = c; k <= nx; k++) widths.set(k, ww);
            }
            i += 3;
          }
        }
      }
    }
  } else {
    const first = doc.resolve(d.get('FirstChar') ?? null);
    const w = doc.resolve(d.get('Widths') ?? null);
    if (typeof first === 'number' && Array.isArray(w)) {
      w.forEach((x, j) => {
        const v = doc.resolve(x);
        if (typeof v === 'number') widths.set(first + j, v);
      });
    }
  }
  const width = (c: number) => widths.get(c) ?? dw;
  // mã hóa 1 byte
  let enc: string[] = LATIN1;
  const e = doc.resolve(d.get('Encoding') ?? null);
  const en = nameOf(e);
  let identity = false;
  if (en !== null) {
    if (en in CHARSETS) enc = CHARSETS[en];
    else if (/^Identity-[HV]$/.test(en)) identity = true;
    else if (type0) identity = true; // CMap định sẵn khác: không có bảng → như Identity (chặt)
  } else if (isDict(e)) {
    const be = nameOf(doc.resolve(e.get('BaseEncoding') ?? null));
    enc = [...(be !== null && be in CHARSETS ? CHARSETS[be] : T.std)];
    const diff = doc.resolve(e.get('Differences') ?? null);
    let x = 0;
    for (const o of Array.isArray(diff) ? diff : []) {
      const v = doc.resolve(o);
      if (typeof v === 'number') x = v;
      else if (v instanceof Name) {
        if (x < 256) enc[x] = T.glyphs[v.v] ?? `/${v.v}`;
        x++;
      }
    }
  } else if (e !== null) enc = T.std;
  const twoByte = type0;
  const lens = cmap
    ? [...cmap[1]].filter((n) => n >= 1 && n <= 4).sort((a, b) => a - b)
    : [twoByte ? 2 : 1];
  const space = widths.get(32) ?? DEFAULT_SPACE;
  const decode = (s: Uint8Array): [string, number[]][] | null => {
    const out: [string, number[]][] = [];
    for (let i = 0; i < s.length; ) {
      let hit: [string, number] | null = null;
      if (cmap) {
        for (const n of lens.length ? lens : [twoByte ? 2 : 1]) {
          if (i + n > s.length) continue;
          const k = Buffer.from(s.subarray(i, i + n)).toString('hex');
          const v = cmap[0].get(k);
          if (v !== undefined) {
            hit = [v, n];
            break;
          }
        }
      }
      const n = twoByte ? 2 : 1;
      const code = n === 2 ? (s[i] << 8) | (s[i + 1] ?? 0) : s[i];
      if (hit) {
        out.push([hit[0], [code]]);
        i += hit[1];
        continue;
      }
      if (twoByte || identity) {
        // Type0 không ToUnicode (hoặc mã ngoài CMap của Type0): không biết chữ → bỏ trang
        if (!cmap) return null;
        i += n;
        continue;
      }
      out.push([enc[code] ?? '', [code]]);
      i += 1;
    }
    return out;
  };
  return { decode, width, space, twoByte };
}

// ------------------------------------------------------------------------------- nội dung

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

type Gs = {
  ctm: M;
  font: Font | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
};

class Undecodable extends Error {}

const EI_RE = /\sEI(\s|$)/g;

class Extractor {
  out = '';
  /** ký tự cuối của `out` ('' = rỗng) — không đọc `out` mỗi glyph (endsWith/regex làm phẳng chuỗi → O(n²)) */
  last = '';
  lastY: number | null = null;
  lastEnd: number | null = null;

  /** `fonts`/`forms` dùng chung cả tài liệu; `chain` = Form đang trên chuỗi gọi (như `known_ids` pypdf). */
  constructor(
    private readonly doc: Doc,
    private readonly fonts: Map<Obj, Font>,
    private readonly forms: Map<Stream, Uint8Array | null>,
    private readonly chain = new Set<Stream>(),
  ) {}

  private put(s: string): void {
    if (!s) return;
    chars += s.length;
    if (chars > MAX_TEXT) throw new LimitReached();
    this.out += s;
    this.last = s[s.length - 1];
  }

  private nl(): void {
    if (this.last && this.last !== '\n') this.put('\n');
  }

  run(content: Uint8Array, res: Dict | null, depth = 0): void {
    spend(content.length + 64); // + chi phí cố định mỗi lần chạy (Form rỗng gọi lặp)
    const doc = this.doc;
    let src: string | undefined; // chữ latin1 của content — chỉ dựng khi gặp BI, MỘT lần
    let gs: Gs = { ctm: ID, font: null, size: 12, tc: 0, tw: 0, th: 1, tl: 0 };
    const stack: Gs[] = [];
    let tm: M = ID;
    let tlm: M = ID;
    const lx = new Lexer(content);
    let ops: Obj[] = [];
    const fontRes = isDict(res) ? doc.resolve(res.get('Font') ?? null) : null;
    const xobjRes = isDict(res) ? doc.resolve(res.get('XObject') ?? null) : null;
    const move = (tx: number, ty: number) => {
      tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };
    const num = (i: number) => {
      const v = ops[ops.length - i];
      return typeof v === 'number' ? v : 0;
    };
    const show = (s: Uint8Array) => {
      const f = gs.font;
      const parts: [string, number[]][] | null = f
        ? f.decode(s)
        : Array.from(s, (c) => [LATIN1[c], [c]]);
      if (parts === null) throw new Undecodable();
      const m = mul(tm, gs.ctm);
      const fs = Math.max(gs.size, 1) * (Math.hypot(m[2], m[3]) || 1);
      if (this.lastY !== null && this.last) {
        if (Math.abs(m[5] - this.lastY) > fs * 0.5) this.nl();
        else if (this.lastEnd !== null && m[4] - this.lastEnd > fs * 0.139) {
          if (!/\s/u.test(this.last)) this.put(' ');
        }
      }
      for (const [txt, codes] of parts) {
        this.put(txt);
        for (const c of codes) {
          const w = (f ? f.width(c) : DEFAULT_W) / 1000;
          const tx = (w * gs.size + gs.tc + (c === 32 && !f?.twoByte ? gs.tw : 0)) * gs.th;
          tm = mul([1, 0, 0, 1, tx, 0], tm);
        }
      }
      const e = mul(tm, gs.ctm);
      this.lastY = e[5];
      this.lastEnd = e[4];
    };
    for (;;) {
      const t = lx.token();
      if (t === undefined) break;
      if (t === '[' || t === '<<') {
        // toán hạng mảng/dict
        lx.pos -= t.length;
        ops.push(lx.object());
        continue;
      }
      if (!(t instanceof Op)) {
        if (typeof t !== 'string') ops.push(t);
        continue;
      }
      const op = t.v;
      if (op === 'BI') {
        // ảnh nội tuyến: bỏ tới EI (tìm từ vị trí hiện tại — không chép lại cả content mỗi BI)
        src ??= latin1(content);
        const id = src.indexOf('ID', lx.pos);
        EI_RE.lastIndex = id + 3;
        const ei = id < 0 ? null : EI_RE.exec(src);
        lx.pos = ei === null ? content.length : ei.index + 3;
        ops = [];
        continue;
      }
      switch (op) {
        case 'q':
          stack.push({ ...gs });
          break;
        case 'Q':
          gs = stack.pop() ?? gs;
          break;
        case 'cm':
          gs.ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], gs.ctm);
          break;
        case 'BT':
          tm = ID;
          tlm = ID;
          break;
        case 'Tf': {
          const fn = nameOf(ops[ops.length - 2]);
          gs.size = num(1);
          const fdObj = fn !== null && isDict(fontRes) ? (fontRes.get(fn) ?? null) : null;
          if (fdObj === null) gs.font = null;
          else {
            const key = doc.resolve(fdObj);
            let font = this.fonts.get(key);
            if (!font) {
              font = loadFont(doc, fdObj);
              this.fonts.set(key, font);
            }
            gs.font = font;
          }
          break;
        }
        case 'Tc':
          gs.tc = num(1);
          break;
        case 'Tw':
          gs.tw = num(1);
          break;
        case 'Tz':
          gs.th = num(1) / 100;
          break;
        case 'TL':
          gs.tl = num(1);
          break;
        case 'Td':
          move(num(2), num(1));
          break;
        case 'TD':
          gs.tl = -num(1);
          move(num(2), num(1));
          break;
        case 'Tm':
          tlm = [num(6), num(5), num(4), num(3), num(2), num(1)];
          tm = tlm;
          break;
        case 'T*':
          move(0, -gs.tl);
          this.nl();
          break;
        case 'Tj': {
          const s = ops[ops.length - 1];
          if (s instanceof Uint8Array) show(s);
          break;
        }
        case "'":
        case '"': {
          if (op === '"') {
            gs.tw = num(3);
            gs.tc = num(2);
          }
          move(0, -gs.tl);
          this.nl();
          const s = ops[ops.length - 1];
          if (s instanceof Uint8Array) show(s);
          break;
        }
        case 'TJ': {
          const arr = ops[ops.length - 1];
          if (!Array.isArray(arr)) break;
          for (const x of arr) {
            if (x instanceof Uint8Array) show(x);
            else if (typeof x === 'number') {
              const sp = gs.font ? gs.font.space : DEFAULT_SPACE;
              if (Math.abs(x) >= sp / 2 && this.last && !/\s/u.test(this.last)) this.put(' ');
              tm = mul([1, 0, 0, 1, (-x / 1000) * gs.size * gs.th, 0], tm);
              this.lastEnd = mul(tm, gs.ctm)[4];
            }
          }
          break;
        }
        case 'Do': {
          this.nl();
          const n = nameOf(ops[ops.length - 1]);
          const xo = n !== null && isDict(xobjRes) ? doc.resolve(xobjRes.get(n) ?? null) : null;
          // Form đã trên chuỗi gọi (tự gọi/chu trình) → bỏ như pypdf ("cyclic form XObject") — không
          // nhân bản chữ (watermark lặp vượt SCAN_MIN_CHARS = xếp nhầm bản scan vào pdf_text).
          if (
            xo instanceof Stream &&
            nameOf(xo.dict.get('Subtype')) !== 'Image' &&
            depth < 8 &&
            !this.chain.has(xo)
          ) {
            const r = doc.resolve(xo.dict.get('Resources') ?? null);
            let data = this.forms.get(xo);
            if (data === undefined) {
              data = decodeFilters(xo, (x) => doc.resolve(x));
              this.forms.set(xo, data);
            }
            if (isDict(r) && data) {
              // pypdf trích Form như trang riêng (vị trí riêng) rồi nối vào
              const sub = new Extractor(doc, this.fonts, this.forms, this.chain);
              this.chain.add(xo);
              try {
                sub.run(data, r, depth + 1);
              } finally {
                this.chain.delete(xo);
              }
              this.out += sub.out; // ký tự đã tính ở `put` của sub
              if (sub.last) this.last = sub.last;
            }
          }
          break;
        }
      }
      ops = [];
    }
  }
}

/** Chữ từng trang (chưa NFC). PDF mã hóa → PdfEncrypted; hỏng → PdfError(tên lỗi pypdf); vượt trần
 * công việc/chữ (`MAX_WORK`/`MAX_TEXT`) → PdfError('LimitReachedError'). */
export function pdfPageTexts(data: Uint8Array): string[] {
  work = 0;
  chars = 0;
  try {
    return extractAll(data);
  } catch (e) {
    if (e instanceof LimitReached) throw new PdfError('LimitReachedError');
    throw e;
  }
}

function extractAll(data: Uint8Array): string[] {
  const doc = new Doc(data);
  if (doc.encrypted) throw new PdfEncrypted('PDF mã hoá');
  const fonts = new Map<Obj, Font>();
  const forms = new Map<Stream, Uint8Array | null>();
  return doc.pages().map(([page, res]) => {
    const c = doc.resolve(page.get('Contents') ?? null);
    const parts = Array.isArray(c) ? c.map((x) => doc.resolve(x)) : c === null ? [] : [c];
    const chunks: Uint8Array[] = [];
    for (const p of parts) {
      if (!(p instanceof Stream)) continue;
      const d = decodeFilters(p, (x) => doc.resolve(x));
      if (d === null) return ''; // lọc nén chưa hỗ trợ → trang coi như không chữ (fail-closed)
      chunks.push(d, Uint8Array.of(10));
    }
    const ex = new Extractor(doc, fonts, forms);
    try {
      ex.run(Buffer.concat(chunks), res);
    } catch (e) {
      if (e instanceof Undecodable) return '';
      if (e instanceof PdfError) return ex.out;
      throw e;
    }
    return ex.out;
  });
}
