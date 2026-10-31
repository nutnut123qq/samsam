import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Fernet (spec https://github.com/fernet/spec) khớp `cryptography.fernet.Fernet` của Python —
// dùng cho cột ciphertext `contacts` (khóa `CONTACT_VAULT_KEY`, ingest/crm.py). Không dùng gói npm.

/** Token hỏng / sai khóa / hết hạn — như `cryptography.fernet.InvalidToken`. */
export class InvalidToken extends Error {
  constructor() {
    super('InvalidToken');
    this.name = 'InvalidToken';
  }
}

const MAX_CLOCK_SKEW = 60n;
const B64URL = /^[A-Za-z0-9_-]*={0,2}$/;

// Chặt hơn Python (urlsafe_b64decode bỏ qua ký tự lạ): chỉ nhận base64url chuẩn có padding — fail-closed.
function b64urlDecode(s: string): Buffer | null {
  return s.length % 4 === 0 && B64URL.test(s) ? Buffer.from(s, 'base64url') : null;
}

function b64urlEncode(b: Buffer): string {
  // Python urlsafe_b64encode giữ padding '='.
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Khóa Fernet (urlsafe-base64 32 byte) → 32 byte; sai → Error như ValueError của Python. */
export function decodeFernetKey(key: string): Buffer {
  const raw = b64urlDecode(key);
  if (raw?.length !== 32) {
    throw new Error('Fernet key must be 32 url-safe base64-encoded bytes.');
  }
  return raw;
}

export function generateFernetKey(): string {
  return b64urlEncode(randomBytes(32));
}

export class Fernet {
  readonly #signingKey: Buffer;
  readonly #encryptionKey: Buffer;

  constructor(key: string) {
    const raw = decodeFernetKey(key);
    this.#signingKey = raw.subarray(0, 16);
    this.#encryptionKey = raw.subarray(16);
  }

  /** `opts.iv`/`opts.time` chỉ để test khớp vector Python (`_encrypt_from_parts`). */
  encrypt(data: Uint8Array, opts: { iv?: Buffer; time?: number } = {}): string {
    const iv = opts.iv ?? randomBytes(16);
    if (iv.length !== 16) throw new Error('iv must be 16 bytes');
    const time = BigInt(opts.time ?? Math.floor(Date.now() / 1000));
    const cipher = createCipheriv('aes-128-cbc', this.#encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(time);
    const basic = Buffer.concat([Buffer.from([0x80]), ts, iv, ciphertext]);
    const mac = createHmac('sha256', this.#signingKey).update(basic).digest();
    return b64urlEncode(Buffer.concat([basic, mac]));
  }

  /** `ttl` (giây) như Python `decrypt(token, ttl)`; `now` chỉ để test. */
  decrypt(token: string, ttl?: number, now?: number): Buffer {
    const data = b64urlDecode(token);
    if (!data || data.length < 9 || data[0] !== 0x80) throw new InvalidToken();
    const timestamp = data.readBigUInt64BE(1);
    if (ttl !== undefined) {
      const current = BigInt(now ?? Math.floor(Date.now() / 1000));
      if (timestamp + BigInt(ttl) < current) throw new InvalidToken();
      if (current + MAX_CLOCK_SKEW < timestamp) throw new InvalidToken();
    }
    if (data.length < 1 + 8 + 16 + 32) throw new InvalidToken();
    const body = data.subarray(0, -32);
    const mac = createHmac('sha256', this.#signingKey).update(body).digest();
    if (!timingSafeEqual(mac, data.subarray(-32))) throw new InvalidToken();
    try {
      const decipher = createDecipheriv('aes-128-cbc', this.#encryptionKey, data.subarray(9, 25));
      return Buffer.concat([decipher.update(data.subarray(25, -32)), decipher.final()]);
    } catch {
      throw new InvalidToken();
    }
  }
}
