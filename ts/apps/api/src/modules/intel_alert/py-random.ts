import { createHash } from 'node:crypto';

// Python `random.Random` (CPython 3.12, Mersenne Twister MT19937) — đủ phần persona_sim dùng: seed
// int/str (version 2: str → bytes + sha512), random(), uniform(), shuffle(). Gateway GIẢ của
// `--dry-run` và thứ tự phương án trong prompt phải ra Y HỆT bản Python (số giả tất định, golden).

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number | bigint | string) {
    this.seed(seed);
  }

  /** `random.seed(a)` — int: |a|; str: int.from_bytes(a + sha512(a)) (big-endian). */
  seed(a: number | bigint | string): void {
    let n: bigint;
    if (typeof a === 'string') {
      const b = Buffer.from(a, 'utf8');
      const all = Buffer.concat([b, createHash('sha512').update(b).digest()]);
      n = BigInt(`0x${all.toString('hex') || '0'}`);
    } else {
      n = BigInt(a);
      if (n < 0n) n = -n;
    }
    // _PyLong_AsByteArray little-endian → mảng word 32 bit (thấp trước); 0 → [0].
    const key: number[] = [];
    while (n > 0n) {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    }
    if (!key.length) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const x = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (Math.imul(1812433253, x) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      const x = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = ((((mt[i] as number) ^ Math.imul(x, 1664525)) >>> 0) + (key[j] as number) + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const x = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = ((((mt[i] as number) ^ Math.imul(x, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
    }
    mt[0] = UPPER;
  }

  /** `genrand_uint32`. */
  uint32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      const twist = (a: number, b: number, c: number) => {
        const y = ((mt[a] as number) & UPPER) | ((mt[b] as number) & LOWER);
        mt[a] = (mt[c] as number) ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      };
      for (; kk < N - M; kk++) twist(kk, kk + 1, kk + M);
      for (; kk < N - 1; kk++) twist(kk, kk + 1, kk + (M - N));
      twist(N - 1, 0, M - 1);
      this.mti = 0;
    }
    let y = mt[this.mti++] as number;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random()` ∈ [0, 1) — 53 bit. */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** `getrandbits(k)`, 1 ≤ k ≤ 32. */
  private bits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** `_randbelow_with_getrandbits(n)`, n ≥ 1. */
  randbelow(n: number): number {
    const k = n.toString(2).length;
    let r = this.bits(k);
    while (r >= n) r = this.bits(k);
    return r;
  }

  /** `shuffle(x)` tại chỗ (Fisher–Yates từ cuối). */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const t = x[i] as T;
      x[i] = x[j] as T;
      x[j] = t;
    }
  }
}
