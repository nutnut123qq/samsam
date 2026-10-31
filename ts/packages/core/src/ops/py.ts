import { readFileSync } from 'node:fs';

// Tiện ích khớp ngữ nghĩa chuỗi của Python (bản Python là chuẩn) — dùng trong ops/.

// Khoảng trắng của Python `str.split()`/`str.strip()` (khác `\s` của JS: có U+001C..U+001F, U+0085,
// không có U+FEFF).
const WS =
  '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const WS_RUN = new RegExp(`${WS}+`, 'u');

/** Python `" ".join(s.split())`. */
export function squash(s: string): string {
  return s
    .split(WS_RUN)
    .filter((x) => x !== '')
    .join(' ');
}

/** Python `s.split()` (không đối số). */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter((x) => x !== '');
}

// Python `str.isprintable()`: sai khi có ký tự loại Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs (trừ dấu cách ASCII).
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function isPrintable(s: string): boolean {
  return !NON_PRINTABLE.test(s.replaceAll(' ', ''));
}

/** Python `len(s)` — số code point (JS `.length` đếm đơn vị UTF-16). */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python `s[a:b]` theo code point (a, b ≥ 0). */
export function cpSlice(s: string, a: number, b?: number): string {
  return Array.from(s).slice(a, b).join('');
}

/**
 * Gần đúng `casefold()` cho phép so tiền tố `agent:`/`system:`: JS `toLowerCase` không gấp ſ/ﬅ/ﬆ
 * (Python gấp thành s/st) → thêm NFKC. NFKC còn gấp chữ toàn khổ (Python không) — chỉ làm CHẶT
 * hơn (tên dạng `ａｇｅｎｔ:` bị coi là agent = fail-closed).
 */
export function foldPrefix(s: string): string {
  return s.toLowerCase().normalize('NFKC').toLowerCase();
}

/** Python `int(x)` cho id CLI/caller: số nguyên (có thể có dấu/khoảng trắng) → bigint | null. */
export function pyInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (typeof v !== 'string') return null;
  const m = /^[+-]?\d+(?:_\d+)*$/.exec(v.replace(new RegExp(`^${WS}+|${WS}+$`, 'gu'), ''));
  return m ? BigInt(m[0].replaceAll('_', '')) : null;
}

/** Lỗi đọc JSON mang TÊN loại lỗi Python (thông điệp `"<file> hỏng: <loại>"` giữ nguyên câu Python). */
export class JsonFileError extends Error {
  constructor(
    readonly pyType: 'FileNotFoundError' | 'UnicodeDecodeError' | 'JSONDecodeError' | 'OSError',
  ) {
    super(pyType);
  }
}

/**
 * Python `json.loads(Path(p).read_bytes().decode("utf-8"))` — đọc mỗi lần (người vận hành sửa file
 * thì lần sau thấy bản mới), UTF-8 strict, BOM = hỏng. KHÁC Python có chủ đích: NaN/Infinity bị từ
 * chối (JSON.parse) — chặt hơn = fail-closed.
 */
export function readJson(file: string, reviver?: Reviver): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (e) {
    throw new JsonFileError(
      (e as { code?: string }).code === 'ENOENT' ? 'FileNotFoundError' : 'OSError',
    );
  }
  return parseJsonBytes(raw, reviver);
}

type Reviver = (key: string, value: unknown, ctx?: { source?: string }) => unknown;

export function parseJsonBytes(raw: Uint8Array, reviver?: Reviver): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new JsonFileError('UnicodeDecodeError');
  }
  try {
    return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
  } catch {
    throw new JsonFileError('JSONDecodeError');
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Python `isinstance(v, int) and not isinstance(v, bool)` cho giá trị JSON. */
export function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
