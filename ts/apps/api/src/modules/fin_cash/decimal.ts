import { type Dec, decStr } from '../fin_ar_pnl/fin-common.js';

// Số học `decimal.Decimal` của Python với context mặc định (28 chữ số có nghĩa, ROUND_HALF_EVEN) —
// FP-Cash nhân đơn vị × đơn giá × tỷ lệ thực nhận (tỷ lệ đo = Σ payout / Σ đơn, 28 chữ số) rồi
// ROUND_HALF_UP về đồng; FP-OpsCost quy USD → VND và in % trần. BigInt chính xác, không float:
// làm tròn 2 bước (28 chữ số rồi về đồng) phải y hệt Python mới ra cùng số tiền ở mọi ca biên.

export type { Dec };
export { decStr };

export const PREC = 28;

const abs = (n: bigint): bigint => (n < 0n ? -n : n);
const digits = (n: bigint): number => (n === 0n ? 1 : abs(n).toString().length);

/** Chia nguyên num/den (den > 0) làm tròn nửa-chẵn (ROUND_HALF_EVEN). */
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

/** Làm tròn hệ số về `PREC` chữ số có nghĩa (context mặc định — nửa-chẵn). */
export function ctxRound(d: Dec): Dec {
  const n = digits(d.coef);
  if (n <= PREC) return d;
  const drop = n - PREC;
  let coef = divHalfEven(d.coef, 10n ** BigInt(drop));
  let exp = d.exp + drop;
  // 999…9 làm tròn lên thành 10^PREC → bớt 1 chữ số (chính xác vì đuôi là 0)
  if (digits(coef) > PREC) {
    coef /= 10n;
    exp += 1;
  }
  return { coef, exp };
}

/** `Decimal(a) * Decimal(b)` (context mặc định). */
export const mul = (a: Dec, b: Dec): Dec => ctxRound({ coef: a.coef * b.coef, exp: a.exp + b.exp });

/** `Decimal(n)` cho số nguyên. */
export const decInt = (n: bigint | number): Dec => ({ coef: BigInt(n), exp: 0 });

/**
 * `Decimal(num) / Decimal(den)` với num/den nguyên, den ≠ 0 (context mặc định). Kết quả chia hết
 * → bỏ số 0 cuối tới số mũ lý tưởng 0 (như Python: 850/1000 = Decimal('0.85')); không hết → đúng
 * 28 chữ số có nghĩa nửa-chẵn.
 */
export function divInt(num: bigint, den: bigint): Dec {
  if (den === 0n) throw new RangeError('chia cho 0');
  if (den < 0n) return divInt(-num, -den);
  if (num === 0n) return { coef: 0n, exp: 0 };
  // k: số chữ số thập phân để thương có PREC chữ số nguyên
  let k = PREC - (digits(num) - digits(den));
  const scaled = (kk: number) =>
    kk >= 0 ? [abs(num) * 10n ** BigInt(kk), den] : [abs(num), den * 10n ** BigInt(-kk)];
  let [a, b] = scaled(k) as [bigint, bigint];
  if (a / b >= 10n ** BigInt(PREC)) {
    k -= 1;
    [a, b] = scaled(k) as [bigint, bigint];
  } else if (a / b < 10n ** BigInt(PREC - 1)) {
    k += 1;
    [a, b] = scaled(k) as [bigint, bigint];
  }
  const sign = num < 0n ? -1n : 1n;
  if (a % b === 0n) {
    // chia hết: hệ số chính xác, rút gọn số 0 cuối khi số mũ còn < 0
    let coef = a / b;
    let exp = -k;
    while (exp < 0 && coef % 10n === 0n) {
      coef /= 10n;
      exp += 1;
    }
    return { coef: sign * coef, exp };
  }
  return ctxRound({ coef: sign * divHalfEven(a, b), exp: -k });
}

/** `int(d.quantize(Decimal(1), rounding=ROUND_HALF_UP))` (= settlement_csv.round_half_up). */
export function roundHalfUp(d: Dec): bigint {
  if (d.exp >= 0) return d.coef * 10n ** BigInt(d.exp);
  return divHalfUp(d.coef, 10n ** BigInt(-d.exp));
}

/** `d.quantize(Decimal('1e-places'))` nửa-chẵn (context mặc định) → hệ số với số mũ -places. */
function rescaleHalfEven(d: Dec, places: number): bigint {
  const shift = d.exp + places;
  if (shift >= 0) return d.coef * 10n ** BigInt(shift);
  return divHalfEven(d.coef, 10n ** BigInt(-shift));
}

/** `f"{d:.{places}f}"` (Decimal.__format__ — nửa-chẵn, không dạng mũ). */
export function fmtFixed(d: Dec, places: number): string {
  const c = rescaleHalfEven(d, places);
  const neg = c < 0n || (c === 0n && d.coef < 0n);
  const s = abs(c)
    .toString()
    .padStart(places + 1, '0');
  const body = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  return (neg ? '-' : '') + body;
}
