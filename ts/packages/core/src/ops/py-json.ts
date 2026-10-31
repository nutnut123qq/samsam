import { readFileSync } from 'node:fs';
import { pyReprValue, pyStrip } from '../security/py.js';

// Ngữ nghĩa Python cho giá trị JSON / số / đọc tệp (dùng chung mọi module).
// `json.loads` của Python phân biệt int (`30`) và float (`30.0`): luật `isinstance(v, int)` của
// cấu hình (sales_watch, giả định kịch bản, golden) từ chối float. JSON.parse của JS gộp hai loại
// → đọc lại nguồn chữ của số (JSON.parse source text access, Node ≥ 22) và bọc số thực thành
// `PyFloat` để kiểm int CHẶT như Python.

/** Số JSON viết dạng thực (`.`/`e`) — Python `float`. */
export class PyFloat {
  constructor(readonly v: number) {}
}

type Ctx = { source?: string } | undefined;

export function parsePyJson(text: string): unknown {
  const reviver = (_k: string, v: unknown, ctx: Ctx) =>
    typeof v === 'number' && ctx?.source !== undefined && /[.eE]/.test(ctx.source)
      ? new PyFloat(v)
      : v;
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/** Python `isinstance(v, dict)` cho giá trị đọc bằng `parsePyJson`. */
export function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
}

/** Python `sorted()` chuỗi — theo code point (JS `sort()` theo đơn vị UTF-16). */
export function cpCmp(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** Python `isinstance(v, int) and not isinstance(v, bool)`. */
export function isPyInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** int | float của Python → number; khác → null. */
export function pyNum(v: unknown): number | null {
  if (typeof v === 'number') return v;
  return v instanceof PyFloat ? v.v : null;
}

/** Python `str(float)` / `repr(float)`: chữ số ngắn nhất (như JS), dạng mũ khi số mũ thập phân
 * < -4 hoặc ≥ 16 (`1e-05`, `1e+16`), luôn có `.0` khi nguyên, `-0.0`, `nan`/`inf`. */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, exp] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const pt = Number(exp) + 1; // vị trí dấu thập phân so với dãy chữ số (Python `decpt`)
  let out: string;
  if (pt > 16 || pt <= -4) {
    const e = pt - 1;
    out = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  } else if (pt <= 0) out = `0.${'0'.repeat(-pt)}${digits}`;
  else if (pt >= digits.length) out = `${digits}${'0'.repeat(pt - digits.length)}.0`;
  else out = `${digits.slice(0, pt)}.${digits.slice(pt)}`;
  return x < 0 ? `-${out}` : out;
}

/** Python `f"{x:.{nd}f}"` (giá trị nhị phân chính xác, hòa → số chẵn; JS toFixed hòa → xa 0). */
export function pyFixed(x: number, nd: number): string {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x.toFixed(nd);
  const neg = x < 0 || Object.is(x, -0);
  const exact = Math.abs(x).toFixed(100);
  const [ip, fp] = exact.split('.') as [string, string];
  const keep = fp.slice(0, nd);
  const rest = fp.slice(nd);
  let digits = BigInt(ip + keep);
  const half = rest[0] === '5' && /^5(0*)$/.test(rest);
  if (rest[0] !== undefined && (rest[0] > '5' || (rest[0] === '5' && !half))) digits += 1n;
  else if (half && digits % 2n === 1n) digits += 1n;
  let s = digits.toString().padStart(nd + 1, '0');
  if (nd > 0) s = `${s.slice(0, -nd)}.${s.slice(-nd)}`;
  return (neg ? '-' : '') + s;
}

/** Python `round(x, nd)` (nd ≥ 0) cho float — cùng làm tròn với `f"{x:.{nd}f}"`. */
export const pyRound = (x: number, nd: number): number => Number(pyFixed(x, nd));

/** Lỗi đọc file mang TÊN loại lỗi Python (`type(e).__name__`). */
export class PyReadError extends Error {
  constructor(readonly pyType: string) {
    super(pyType);
  }
}

/** Tên lớp OSError của Python cho lỗi fs của Node (`type(e).__name__`). */
export function pyOsName(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'ENOTDIR') return 'NotADirectoryError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'EEXIST') return 'FileExistsError';
  return 'OSError';
}

/** Python `p.read_bytes().decode("utf-8-sig")` → chữ | PyReadError(tên lỗi OS/Unicode). */
export function readUtf8Sig(path: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new PyReadError(pyOsName(e));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw); // mặc định bỏ BOM = utf-8-sig
  } catch {
    throw new PyReadError('UnicodeDecodeError');
  }
}

/** Python `json.loads` kiểu "chỉ số nguyên viết dạng thực" (`14.0`, `1e1`) thành `PyFloat` (để
 * `isinstance(v, int)` sai như Python); số lẻ (`1.5`) giữ là number. Khác `parsePyJson` (mọi số
 * thực → PyFloat). KHÁC Python có chủ đích: NaN/Infinity bị từ chối (SyntaxError) — chặt hơn. */
export function pyLoads(text: string): unknown {
  return JSON.parse(text, intFloatReviver as Parameters<typeof JSON.parse>[1]);
}

/** Reviver của `pyLoads` (dùng với `ops/py.readJson(file, intFloatReviver)`). */
export const intFloatReviver = (_k: string, v: unknown, ctx?: { source?: string }): unknown =>
  typeof v === 'number' && Number.isInteger(v) && /[.eE]/.test(ctx?.source ?? '')
    ? new PyFloat(v)
    : v;

/** Python `repr(v)` cho giá trị JSON (PyFloat → `14.0`). */
export function reprV(v: unknown): string {
  return v instanceof PyFloat ? pyFloatStr(v.v) : pyReprValue(v);
}

const F_DIGITS = '[0-9](?:_?[0-9])*';
const FLOAT_RE = new RegExp(
  `^[+-]?(?:${F_DIGITS}(?:[.](?:${F_DIGITS})?)?|[.]${F_DIGITS})(?:[eE][+-]?${F_DIGITS})?$`,
);

/** Python `float(s)` cho chuỗi (strip, `_` giữa chữ số, inf/nan) → số | null (không parse được).
 * KHÁC Python: chữ số không phải ASCII bị từ chối (chặt hơn). */
export function pyFloat(s: string): number | null {
  const t = pyStrip(s);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m)
    return (m[2] as string).toLowerCase() === 'nan'
      ? Number.NaN
      : m[1] === '-'
        ? -Infinity
        : Infinity;
  return FLOAT_RE.test(t) ? Number(t.replaceAll('_', '')) : null;
}
