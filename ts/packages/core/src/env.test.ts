import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/env_db.golden.json' with { type: 'json' };
import { approvalEnforced, authMode, truthy } from './env.js';

// Golden: sinh bằng pipelines/auth.py thật (_truthy, auth_mode, approval_enforced).
describe('env ↔ pipelines/auth.py', () => {
  it('truthy', () => {
    for (const c of golden.truthy) expect(truthy(c.v), JSON.stringify(c.v)).toBe(c.out);
  });

  it('auth_mode + approval_enforced', () => {
    for (const c of golden.modes) {
      const env = c.env as Record<string, string>;
      expect(authMode(env), JSON.stringify(env)).toBe(c.auth_mode);
      expect(approvalEnforced(env), JSON.stringify(env)).toBe(c.approval_enforced);
    }
  });
});
