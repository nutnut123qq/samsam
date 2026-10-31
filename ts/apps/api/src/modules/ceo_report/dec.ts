// `decimal.Decimal` tối thiểu của Python (context mặc định: 28 chữ số có nghĩa, làm tròn nửa-chẵn)
// cho số cockpit/báo cáo TGĐ: cộng/trừ/chia/nhân có làm tròn context, so sánh, quantize ROUND_HALF_UP
// (vượt 28 chữ số → InvalidOperation như Python), `str()`. BigInt chính xác — không float.
// shortcut: bản riêng của nhóm (fin_cash/mkt_ads/settlement đều có bản riêng) — gom vào core khi tích hợp.

export const PREC = 28;

/** Giá trị Decimal: hữu hạn = coef × 10^exp; `special` = NaN/±Infinity (Python `is_finite()` False). */
export type Dec = { readonly coef: bigint; readonly exp: number; readonly special?: 'nan' | 'inf' };

/** Python `decimal.InvalidOperation` (vd quantize vượt độ chính xác). */
export class InvalidOperation extends RangeError {
  override name = 'InvalidOperation';
}

const NUM_RE = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const SPECIAL_RE = /^[+-]?(?:s?nan\d*|inf|infinity)$/i;

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const digits = (n: bigint): number => (n === 0n ? 1 : abs(n).toString().length);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** `Decimal(s)` cho chuỗi số (văn bản numeric của Postgres, số CSV đã kiểm). Sai → InvalidOperation. */
export function dec(s: string | number | bigint): Dec {
  if (typeof s === 'bigint') return { coef: s, exp: 0 };
  if (typeof s === 'number') {
    if (!Number.isInteger(s)) throw new InvalidOperation('dec(number) chỉ nhận số nguyên');
    return { coef: BigInt(s), exp: 0 };
  }
  const t = s.trim();
  if (SPECIAL_RE.test(t)) return { coef: 0n, exp: 0, special: /nan/i.test(t) ? 'nan' : 'inf' };
  const m = NUM_RE.exec(t);
  if (!m) throw new InvalidOperation(`không phải số: ${s}`);
  const frac = m[3] ?? m[4] ?? '';
  let coef = BigInt(`${m[2] ?? '0'}${frac}`);
  if (m[1] === '-') coef = -coef;
  return { coef, exp: Number(m[5] ?? 0) - frac.length };
}

/** Python `is_finite()`. */
export const isFiniteDec = (d: Dec): boolean => d.special === undefined;

function finite(d: Dec): Dec {
  if (d.special) throw new InvalidOperation('phép tính trên NaN/Infinity');
  return d;
}

/** Python `adjusted()` (số mũ của chữ số có nghĩa đầu). */
export const adjusted = (d: Dec): number => d.exp + digits(d.coef) - 1;

/** Chia nguyên num/den (den > 0) làm tròn nửa-chẵn. */
function divHalfEven(num: bigint, den: bigint): bigint {
  const a = abs(num);
  let q = a / den;
  const r2 = 2n * (a % den);
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  return num < 0n ? -q : q;
}

/** Chia nguyên num/den (den > 0) làm tròn nửa-xa-0 (ROUND_HALF_UP). */
function divHalfUp(num: bigint, den: bigint): bigint {
  const q = (2n * abs(num) + den) / (2n * den);
  return num < 0n ? -q : q;
}

/** Làm tròn hệ số về PREC chữ số có nghĩa (context mặc định — nửa-chẵn). */
export function ctxRound(d: Dec): Dec {
  const n = digits(d.coef);
  if (d.special || n <= PREC) return d;
  const drop = n - PREC;
  let coef = divHalfEven(d.coef, pow10(drop));
  let exp = d.exp + drop;
  if (digits(coef) > PREC) {
    coef /= 10n;
    exp += 1;
  }
  return { coef, exp };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const e = Math.min(a.exp, b.exp);
  return [a.coef * pow10(a.exp - e), b.coef * pow10(b.exp - e), e];
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, e] = align(finite(a), finite(b));
  return ctxRound({ coef: x + y, exp: e });
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, e] = align(finite(a), finite(b));
  return ctxRound({ coef: x - y, exp: e });
}

/** So sánh giá trị (a < b → -1, = → 0, > → 1). */
export function cmp(a: Dec, b: Dec): number {
  const [x, y] = align(finite(a), finite(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export const sign = (d: Dec): number => (finite(d).coef < 0n ? -1 : d.coef > 0n ? 1 : 0);
export const isZero = (d: Dec): boolean => finite(d).coef === 0n;
export const absDec = (d: Dec): Dec => ({ coef: abs(finite(d).coef), exp: d.exp });

/** `a * n` (n nguyên, context). */
export const mulInt = (a: Dec, n: bigint): Dec =>
  ctxRound({ coef: finite(a).coef * n, exp: a.exp });

/**
 * `a / b` theo context (giá trị): thương chia hết trong 28 chữ số → chính xác, không → 28 chữ số có
 * nghĩa nửa-chẵn. b = 0 → InvalidOperation (Python DivisionByZero — caller đã chặn).
 */
export function div(a: Dec, b: Dec): Dec {
  finite(a);
  finite(b);
  if (b.coef === 0n) throw new InvalidOperation('chia cho 0');
  if (a.coef === 0n) return { coef: 0n, exp: a.exp - b.exp };
  const neg = a.coef < 0n !== b.coef < 0n;
  const na = abs(a.coef);
  const nb = abs(b.coef);
  // k: số chữ số dịch để thương nguyên có PREC chữ số
  let k = PREC - (digits(na) - digits(nb));
  const q = (kk: number): [bigint, bigint, bigint] => {
    const num = kk >= 0 ? na * pow10(kk) : na;
    const den = kk >= 0 ? nb : nb * pow10(-kk);
    return [num / den, num % den, den];
  };
  let [qi, r, den] = q(k);
  if (digits(qi) > PREC) [qi, r, den] = q(--k);
  else if (digits(qi) < PREC) [qi, r, den] = q(++k);
  let coef = qi;
  let exp = a.exp - b.exp - k;
  if (r !== 0n) {
    const r2 = 2n * r;
    if (r2 > den || (r2 === den && qi % 2n === 1n)) coef += 1n;
    if (digits(coef) > PREC) {
      coef /= 10n;
      exp += 1;
    }
  }
  return { coef: neg ? -coef : coef, exp };
}

/** `d.quantize(Decimal('1e-places'), rounding=ROUND_HALF_UP)` — vượt 28 chữ số → InvalidOperation. */
export function quantizeHalfUp(d: Dec, places: number): Dec {
  finite(d);
  const shift = d.exp + places;
  const coef = shift >= 0 ? d.coef * pow10(shift) : divHalfUp(d.coef, pow10(-shift));
  if (digits(coef) > PREC) throw new InvalidOperation('quantize vượt độ chính xác');
  return { coef, exp: -places };
}

/** Python `v == v.to_integral_value()`. */
export function isIntegral(d: Dec): boolean {
  finite(d);
  return d.exp >= 0 || d.coef % pow10(-d.exp) === 0n;
}

/** `int(d)` (cắt về 0). */
export function toBigInt(d: Dec): bigint {
  finite(d);
  return d.exp >= 0 ? d.coef * pow10(d.exp) : d.coef / pow10(-d.exp);
}

/** `format(d, "f")` (không dạng mũ, giữ số chữ số thập phân của số mũ). */
export function fixed(d: Dec): string {
  finite(d);
  const neg = d.coef < 0n;
  let s = abs(d.coef).toString();
  if (d.exp >= 0) s += '0'.repeat(d.exp);
  else {
    const p = -d.exp;
    s = s.padStart(p + 1, '0');
    s = `${s.slice(0, -p)}.${s.slice(-p)}`;
  }
  return (neg ? '-' : '') + s;
}

/** Python `str(Decimal)` (to_sci_string). */
export function decStr(d: Dec): string {
  if (d.special) return d.special === 'nan' ? 'NaN' : 'Infinity';
  const sg = d.coef < 0n ? '-' : '';
  const ds = abs(d.coef).toString();
  const left = d.exp + ds.length;
  const dot = d.exp <= 0 && left > -6 ? left : 1;
  let s: string;
  if (dot <= 0) s = `0.${'0'.repeat(-dot)}${ds}`;
  else if (dot >= ds.length) s = ds + '0'.repeat(dot - ds.length);
  else s = `${ds.slice(0, dot)}.${ds.slice(dot)}`;
  const e = left - dot;
  return sg + s + (e === 0 ? '' : `E${e > 0 ? '+' : ''}${e}`);
}

/** Văn bản numeric cho tham số SQL (không dạng mũ — Postgres nhận chính xác). */
export const sqlNum = (d: Dec): string => fixed(d);

/** Python `f"{n:,}".replace(",", ".")` cho số nguyên không âm. */
export function group(n: bigint): string {
  return abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ------------------------------------------------------------ float kiểu Python

/** Python `round(x, nd)` (giá trị NHỊ PHÂN chính xác, hòa → số chẵn; JS toFixed hòa → xa 0). */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const [ip, fp] = Math.abs(x).toFixed(100).split('.') as [string, string];
  const rest = fp.slice(nd);
  let n = BigInt(ip + fp.slice(0, nd));
  const half = /^50*$/.test(rest);
  if (rest[0] !== undefined && (rest[0] > '5' || (rest[0] === '5' && !half))) n += 1n;
  else if (half && n % 2n === 1n) n += 1n;
  const v = Number(n) / 10 ** nd;
  return neg ? -v : v;
}

/** Python `str(float)` cho số đã làm tròn (3.0 → "3.0"). */
export function pyFloatStr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (Object.is(v, -0)) return '-0.0';
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
}

/** Python `statistics.median` cho số thực. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const m = Math.floor(n / 2);
  return n % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
