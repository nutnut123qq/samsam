import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/fernet.golden.json' with { type: 'json' };
import { decodeFernetKey, Fernet, generateFernetKey, InvalidToken } from './fernet.js';

// Golden: sinh bằng cryptography.fernet (Python) — Fernet._encrypt_from_parts / decrypt_at_time.
// TS chặt hơn có chủ đích (fail-closed): Python bỏ qua padding thừa khi giải base64.
const TS_STRICTER = new Set(['extra_padding']);

describe('Fernet ↔ cryptography (Python)', () => {
  const f = new Fernet(golden.key);

  it('encrypt khớp từng byte với IV/thời điểm cố định', () => {
    for (const c of golden.encrypt) {
      const tok = f.encrypt(Buffer.from(c.plain_hex, 'hex'), {
        iv: Buffer.from(c.iv_hex, 'hex'),
        time: c.time,
      });
      expect(tok).toBe(c.token);
      expect(f.decrypt(tok).toString('hex')).toBe(c.plain_hex);
    }
  });

  it('decrypt: hợp lệ / hết hạn / lệch giờ / sửa byte / sai khóa', () => {
    for (const c of golden.decrypt) {
      const run = () =>
        new Fernet(c.key).decrypt(c.token, c.ttl ?? undefined, c.now ?? undefined).toString('hex');
      if (c.ok && !TS_STRICTER.has(c.name)) expect(run(), c.name).toBe(c.plain_hex);
      else expect(run, c.name).toThrow(InvalidToken);
    }
    expect(golden.decrypt.find((c) => c.name === 'extra_padding')?.ok).toBe(true);
  });

  it('khóa sai → lỗi như ValueError của Python', () => {
    for (const c of golden.keys) {
      if (c.ok) expect(decodeFernetKey(c.key)).toHaveLength(32);
      else expect(() => new Fernet(c.key), c.key).toThrow('Fernet key must be 32');
    }
  });

  it('vòng mã hóa/giải mã với khóa và IV ngẫu nhiên', () => {
    const g = new Fernet(generateFernetKey());
    const t = g.encrypt(Buffer.from('0905123456'));
    expect(g.decrypt(t, 60).toString()).toBe('0905123456');
    expect(() => f.decrypt(t)).toThrow(InvalidToken);
  });
});
