import { describe, expect, it } from 'vitest';
import { Fernet } from '../fernet.js';
import golden from './__fixtures__/vault.golden.json' with { type: 'json' };
import {
  loadVaultKey,
  normalizePhone,
  phoneLookup,
  seal,
  unseal,
  VaultKeyError,
} from './fernet.js';

// Golden: ingest.crm.load_vault_key / normalize_phone / phone_lookup / seal / unseal (Python thật,
// khóa GIẢ của test) — HKDF lookup + HMAC + ciphertext phải đọc chéo được với bản Python.
type G = {
  key: string;
  lookup_hex: string;
  keys: { raw: string; error: string | null }[];
  phones: { raw: string; norm: string | null; hmac?: string; error?: string }[];
  seals: { value: string; token: string; plain: string }[];
  foreign_token: string;
};
const g = golden as G;

describe('contact vault ↔ ingest/crm.py', () => {
  const { fernet, lookupKey } = loadVaultKey({ CONTACT_VAULT_KEY: g.key });

  it('khóa lookup HKDF khớp Python; khóa thiếu/sai → VaultKeyError, không lộ khóa', () => {
    expect(lookupKey.toString('hex')).toBe(g.lookup_hex);
    for (const k of g.keys) {
      const run = () => loadVaultKey({ CONTACT_VAULT_KEY: k.raw });
      if (k.error === null) expect(run().lookupKey.toString('hex'), k.raw).toBe(g.lookup_hex);
      else {
        expect(run, JSON.stringify(k.raw)).toThrow(VaultKeyError);
        expect(run).toThrow(k.error);
      }
    }
    expect(() => loadVaultKey({})).toThrow('thiếu CONTACT_VAULT_KEY');
    try {
      loadVaultKey({ CONTACT_VAULT_KEY: `${g.key.slice(0, -4)}` });
    } catch (e) {
      expect((e as Error).message).not.toContain(g.key.slice(0, 10));
    }
  });

  it('normalizePhone + phoneLookup khớp từng ca', () => {
    for (const p of g.phones) {
      if (p.norm === null) {
        expect(() => normalizePhone(p.raw), JSON.stringify(p.raw)).toThrow(p.error);
      } else {
        expect(normalizePhone(p.raw), p.raw).toBe(p.norm);
        expect(phoneLookup(p.norm, lookupKey)).toBe(p.hmac);
      }
    }
    expect(() => normalizePhone(905123456)).toThrow('SĐT không hợp lệ');
  });

  it('unseal đọc ciphertext Python; seal → Python đọc được (cùng Fernet); rỗng → null', () => {
    for (const s of g.seals) {
      expect(unseal(fernet, s.token)).toBe(s.plain);
      const t = seal(fernet, s.value);
      expect(t && unseal(fernet, t)).toBe(s.plain);
      expect(new Fernet(g.key).decrypt(t as string).toString('utf8')).toBe(s.plain);
    }
    expect([seal(fernet, null), seal(fernet, '   '), unseal(fernet, null)]).toEqual([
      null,
      null,
      null,
    ]);
    expect(() => unseal(fernet, g.foreign_token)).toThrow(VaultKeyError);
    expect(() => unseal(fernet, 'không-phải-token')).toThrow('khóa không khớp dữ liệu');
  });
});
