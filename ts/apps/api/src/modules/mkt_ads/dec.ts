import { PyFloat } from '@samsam/core/ops/py-json';

// `decimal.Decimal` tối thiểu cho tiền/tỷ lệ của FP&A + phiếu ads: số thập phân = dấu + hệ số nguyên
// ≥ 0 + số mũ (giữ '-0' và số 0 đuôi như Python để `str()` ra cùng chữ); phép chia/so sánh làm trên
// phân số BigInt CHÍNH XÁC. shortcut: Python chia ở độ chính xác 28 chữ số rồi mới làm tròn — chỉ lệch
// khi thương sát mép nửa đơn vị ở chữ số thứ 28 (không gặp với số VND/tỷ lệ thực tế).

export type Dec = { neg: boolean; c: bigint; e: number };
/** Phân số n/d, d > 0. */
export type Rat = { n: bigint; d: bigint };

const DEC_RE = /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?$/;

/** `Decimal(s)` cho chuỗi số hữu hạn; sai dạng → null. */
export function decParse(s: string): Dec | null {
  const m = DEC_RE.exec(s);
  if (!m) return null;
  const ip = m[2] ?? '';
  const fp = m[3] ?? m[4] ?? '';
  return { neg: m[1] === '-', c: BigInt(ip + fp || '0'), e: Number(m[5] ?? 0) - fp.length };
}

/** `Decimal(str(v))` cho số JSON (int | float Python). */
export function decOf(v: number | PyFloat): Dec {
  const x = v instanceof PyFloat ? v.v : v;
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  // str(float) nguyên giá trị = '5000.0' (hệ số 50000, mũ -1); int = '5000'.
  const s = v instanceof PyFloat && Number.isInteger(a) && a < 1e16 ? `${a}.0` : String(a);
  const d = decParse(s) as Dec;
  return { ...d, neg };
}

/** Python `str(Decimal)` (to-sci-string). */
export function decStr(d: Dec): string {
  const digits = d.c.toString();
  const left = d.e + digits.length;
  const dot = d.e <= 0 && left > -6 ? left : 1;
  let ip: string;
  let fp: string;
  if (dot <= 0) {
    ip = '0';
    fp = `.${'0'.repeat(-dot)}${digits}`;
  } else if (dot >= digits.length) {
    ip = digits + '0'.repeat(dot - digits.length);
    fp = '';
  } else {
    ip = digits.slice(0, dot);
    fp = `.${digits.slice(dot)}`;
  }
  const exp = left === dot ? '' : `E${left - dot >= 0 ? '+' : '-'}${Math.abs(left - dot)}`;
  return `${d.neg ? '-' : ''}${ip}${fp}${exp}`;
}

export function decRat(d: Dec): Rat {
  const n = d.neg ? -d.c : d.c;
  return d.e >= 0 ? { n: n * 10n ** BigInt(d.e), d: 1n } : { n, d: 10n ** BigInt(-d.e) };
}

export const rat = (n: bigint | number, d: bigint | number = 1n): Rat => {
  const nn = BigInt(n);
  const dd = BigInt(d);
  return dd < 0n ? { n: -nn, d: -dd } : { n: nn, d: dd };
};

export const cmpRat = (a: Rat, b: Rat): number => {
  const x = a.n * b.d;
  const y = b.n * a.d;
  return x < y ? -1 : x > y ? 1 : 0;
};

export const mulRat = (a: Rat, b: Rat): Rat => ({ n: a.n * b.n, d: a.d * b.d });

/** Làm tròn n/d về số nguyên: half_up = nửa ra xa 0 (ROUND_HALF_UP), half_even = mặc định Decimal. */
export function roundRat(r: Rat, mode: 'half_up' | 'half_even'): bigint {
  const neg = r.n < 0n;
  const a = neg ? -r.n : r.n;
  const q = a / r.d;
  const rem2 = (a % r.d) * 2n;
  let k = q;
  if (rem2 > r.d || (rem2 === r.d && (mode === 'half_up' || q % 2n === 1n))) k = q + 1n;
  return neg ? -k : k;
}

/** `x.quantize(Decimal('1E<exp>'), rounding)` của phân số; 0 giữ dấu `neg0` (Decimal có -0). */
export function quantize(r: Rat, exp: number, mode: 'half_up' | 'half_even', neg0 = r.n < 0n): Dec {
  const scaled =
    exp <= 0 ? { n: r.n * 10n ** BigInt(-exp), d: r.d } : { n: r.n, d: r.d * 10n ** BigInt(exp) };
  const k = roundRat(scaled, mode);
  return { neg: k < 0n || (k === 0n && neg0), c: k < 0n ? -k : k, e: exp };
}

/** Python `int(x)` (cắt về 0). */
export const truncRat = (r: Rat): bigint => r.n / r.d;
