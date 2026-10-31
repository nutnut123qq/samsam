import { createHmac, hkdfSync } from 'node:crypto';
import type { Env } from '../env.js';
import { decodeFernetKey, Fernet, InvalidToken } from '../fernet.js';
import { pyStr, pyStrip } from './py.js';

// Port kho liên hệ (contact vault) của `ingest/crm.py`: PII khách (SĐT/tên/email/địa chỉ) CHỈ nằm
// trong bảng `contacts`, mã hóa ở TẦNG ỨNG DỤNG bằng Fernet với khóa env `CONTACT_VAULT_KEY`
// (không pgcrypto: khóa sẽ đi trong câu SQL). Tra trùng: `phone_hmac` = HMAC-SHA256(khóa lookup,
// SĐT chuẩn hóa), khóa lookup = HKDF(SHA256, salt rỗng, info=LOOKUP_INFO) từ cùng khóa vault (tách
// miền với khóa mã hóa; không sha256 trần — SĐT VN ~10^9 giá trị dò ngược được). Thiếu/sai khóa →
// VaultKeyError TRƯỚC khi chạm DB (fail-closed). Ciphertext/HMAC khớp từng byte với bản Python.

export const KEY_ENV = 'CONTACT_VAULT_KEY';
export const LOOKUP_INFO = 'samsam/contact_vault/lookup/v1';

/** Thiếu/sai khóa vault hoặc khóa không khớp dữ liệu — fail-closed. Thông điệp không chứa khóa. */
export class VaultKeyError extends Error {
  override name = 'VaultKeyError';
}

export type VaultKeys = { fernet: Fernet; lookupKey: Buffer };

/** `CONTACT_VAULT_KEY` (urlsafe-base64 32 byte) → (Fernet, khóa lookup HMAC). */
export function loadVaultKey(env: Env = process.env): VaultKeys {
  const raw = pyStrip(env[KEY_ENV] ?? '');
  if (!raw) {
    throw new VaultKeyError(`thiếu ${KEY_ENV} — không ghi/đọc PII (xem sop mục CRM để sinh khóa)`);
  }
  let master: Buffer;
  try {
    master = decodeFernetKey(raw);
  } catch {
    throw new VaultKeyError(`${KEY_ENV} không phải khóa Fernet hợp lệ (urlsafe-base64 32 byte)`);
  }
  // HKDF salt=None của `cryptography` = HashLen byte 0 — HMAC khóa rỗng tương đương (RFC 5869).
  const lookupKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), LOOKUP_INFO, 32));
  return { fernet: new Fernet(raw), lookupKey };
}

const PHONE_RE = /^[ \t(]*\+?[0-9 \t().-]+$/;

/** SĐT → `0xxxxxxxxx` (bỏ ký tự không phải số, `+84`/`84` đầu → `0`, `+84 (0)`/`84 0` → `0`;
 * tiền tố `00` bị từ chối). Chỉ chữ số ASCII (số Ả Rập/Devanagari = chuỗi khác → lách tra trùng).
 * Chữ cái giữa số = gõ sai → từ chối. Sai → Error KHÔNG kèm giá trị đầu vào. */
export function normalizePhone(raw: unknown): string {
  if (typeof raw !== 'string' || [...raw].length > 40 || !PHONE_RE.test(raw)) {
    throw new Error('SĐT không hợp lệ');
  }
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('840') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  } else if (digits.startsWith('84') && (digits.length === 11 || digits.length === 12)) {
    digits = `0${digits.slice(2)}`;
  }
  if (!/^0[1-9][0-9]{8,9}$/.test(digits)) throw new Error('SĐT không hợp lệ');
  return digits;
}

export function phoneLookup(phoneNorm: string, lookupKey: Buffer): string {
  return createHmac('sha256', lookupKey).update(phoneNorm, 'utf8').digest('hex');
}

/** Mã hóa 1 field; null/undefined/rỗng sau strip → null (cột null). */
export function seal(f: Fernet, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = pyStrip(pyStr(value).normalize('NFC'));
  return v ? f.encrypt(Buffer.from(v, 'utf8')) : null;
}

export function unseal(f: Fernet, token: string | null | undefined): string | null {
  if (token === null || token === undefined) return null;
  let raw: Buffer;
  try {
    raw = f.decrypt(token);
  } catch (e) {
    if (e instanceof InvalidToken) throw new VaultKeyError('khóa không khớp dữ liệu');
    throw e;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}
