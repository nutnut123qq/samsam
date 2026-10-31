import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isPlainObject } from '@samsam/core/ops/py';
import { pyStr } from '@samsam/core/security/py';

/** user_hash như field convlog — mọi print/log chỉ dùng hash này, KHÔNG raw user_id. */
export function uhash(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16);
}

/** user_hash kênh UI — per-session id để queue phân biệt user UI (D6.10). */
export function uiHash(session: Record<string, unknown>): string {
  if (!('convlog_uid' in session))
    session.convlog_uid = randomUUID().replaceAll('-', '').slice(0, 8);
  return uhash(`streamlit:${String(session.convlog_uid)}`);
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Python `json.loads(raw_bytes)`: UTF-8 strict, BOM UTF-8 đầu bị bỏ (utf-8-sig) → giá trị | ném.
 * KHÁC có chủ đích (chặt hơn): NaN/Infinity, UTF-16/32 bị từ chối.
 */
export function loadsBytes(raw: Uint8Array): unknown {
  let s = UTF8_STRICT.decode(raw);
  if (s.startsWith('\uFEFF')) s = s.slice(1);
  return JSON.parse(s);
}

/**
 * mac = sha256(app_id + raw_body + timestamp + OA_secret_key). Chưa cấu hình secret (dev) → bỏ
 * qua; có secret mà sai/thiếu signature/thân hỏng → false.
 */
export function verifySignature(raw: Uint8Array, header: string, secret: string): boolean {
  if (!secret) return true;
  try {
    const data = loadsBytes(raw);
    if (!isPlainObject(data) || !Object.hasOwn(data, 'app_id') || !Object.hasOwn(data, 'timestamp'))
      return false;
    if (typeof data.app_id !== 'string') return false; // Python: str + int → TypeError
    // raw.decode(): BOM giữ nguyên là ký tự (khác json.loads).
    const body = UTF8_STRICT.decode(raw);
    const expect = `mac=${createHash('sha256')
      .update(data.app_id + body + pyStr(data.timestamp) + secret, 'utf8')
      .digest('hex')}`;
    // hmac.compare_digest(str, str): ký tự ngoài ASCII → TypeError → false.
    if ([...header].some((c) => (c.codePointAt(0) ?? 0) > 0x7f)) return false;
    const a = Buffer.from(header, 'latin1');
    const b = Buffer.from(expect, 'latin1');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
