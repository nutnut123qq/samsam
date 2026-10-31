import { describe, expect, it } from 'vitest';
import { GatewayBlocked } from '../ai/gateway.js';
import { opsRollout } from '../rollout/rollout.js';
import { dep, resetOpsDeps } from './deps.js';
import { wireCore, wireSecurity } from './wire.js';

// Nối hàm THẬT của core/security: chưa nối → lỗi (fail-closed); đã nối → guardrail/PII/auth thật.
describe('wireSecurity', () => {
  it('chưa nối → mọi dep ném; nối → guardrail thật chặn từ cấm, auth dev chặn agent', async () => {
    resetOpsDeps();
    expect(() => dep('guardrailCheck')).toThrow(/chưa nối 'guardrailCheck'/);
    expect(() => dep('rollout')).toThrow(/chưa nối 'rollout'/);
    wireSecurity(null);
    expect(dep('guardrailCheck')('Sâm Ngọc Linh chữa bách bệnh').ok).toBe(false);
    expect(dep('maskPii')('gọi 0912 345 678')).not.toContain('345');
    const r = await dep('auth').authorize('agent:mkt', 'marketing', 'approve', { env: {} });
    expect(r.ok).toBe(false);
    expect(dep('auth').ROLES).toContain('gd_ban_hang');
    const res = dep('withViolation')({ ok: true, violations: [] }, 'config', 'x');
    expect(res.ok).toBe(false);
    expect(() => dep('rollout')).toThrow(); // rollout nối riêng
    resetOpsDeps();
  });
});

describe('wireCore', () => {
  it('nối cả rollout thật; gateway không pool → chặn trước khi gọi nhà cung cấp', async () => {
    resetOpsDeps();
    const gw = wireCore(null, { env: { OLLAMA_URL: 'http://127.0.0.1:9' }, warn: () => {} });
    expect(dep('rollout')).toBe(opsRollout);
    expect(dep('auth').isHuman('agent:x')).toBe(false);
    // Không DB → không đọc được chi tiêu → GatewayBlocked (fail-closed), không request mạng.
    await expect(
      gw.chat('chatbot', [{ role: 'user', content: 'hi' }], { feature: 'sales-01' }),
    ).rejects.toThrow(GatewayBlocked);
    resetOpsDeps();
  });
});
