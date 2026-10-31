import { AiGateway, type GatewayDeps } from '../ai/gateway.js';
import { mode, opsRollout, setConnector } from '../rollout/rollout.js';
import * as auth from '../security/auth.js';
import * as guardrail from '../security/guardrail.js';
import { checkPublishLlm } from '../security/guardrail-llm.js';
import { maskIdentity, maskPii, PII_RE } from '../security/pii.js';
import { type Db, type OpsDeps, type PublishCtx, setOpsDeps } from './deps.js';

// Nối hàm THẬT của core/security + core/ai + core/rollout vào ops (`ops/deps`). Tiến trình
// (api/worker/cli) gọi `wireCore(pool)` MỘT lần lúc khởi động; test dùng `installFakeDeps`
// (ops/testing) hoặc `wireSecurity` khi chỉ cần security. Chưa nối → biên cần guardrail/cổng
// triển khai/ủy quyền ném lỗi (fail-closed).

const opts = (c: PublishCtx): guardrail.PublishOpts => ({
  channel: c.channel,
  contentType: c.content_type,
  sku: c.sku,
  isAi: c.is_ai,
  readiness: c.readiness ?? null,
});

const n = (v: unknown) => (v === undefined ? null : (v as never));

export function wireSecurity(gateway: Pick<AiGateway, 'chat'> | null): void {
  const a: OpsDeps['auth'] = {
    ROLES: auth.ROLES,
    DEV_WARNING: auth.DEV_WARNING,
    isHuman: auth.isHuman,
    authorize: (by, block, action, o) => auth.authorize(by, block, action, o),
    sessionLogin: (db) => auth.sessionLogin(db),
    denyLog: (db, by, block, action, ot, oid, reason, env) =>
      auth.denyLog(db, by, block, action, ot, oid, reason, env),
    cliGate: (db, by, block, action, ot, oid, o) => auth.cliGate(db, by, block, action, ot, oid, o),
  };
  setOpsDeps({
    maskPii,
    guardrailCheck: (t) => guardrail.check(t),
    checkPublish: (t, c) => guardrail.checkPublish(t, opts(c)),
    withViolation: (r, code, detail, span, start, end) =>
      guardrail.withViolation(r, code, detail, n(span), n(start), n(end)),
    checkPublishLlm: (t, c) => checkPublishLlm(t, opts(c), { gateway }),
    auth: a,
  });
}

/** AI Gateway với che PII thật (security/pii) + cổng triển khai thật (`rollout.mode`) trên `pool`
 * (login dịch vụ của tiến trình — đọc/ghi `llm_usage`, đọc `feature_rollout`). null = chặn mọi lời
 * gọi (không đọc được chi tiêu). `extra` chỉ cho test (env/files/fetch giả). */
export function createGateway(pool: Db | null, extra: Partial<GatewayDeps> = {}): AiGateway {
  return new AiGateway({
    pool,
    maskPii,
    maskIdentity,
    piiRe: PII_RE,
    rolloutMode: (_q, f) => mode(pool, f),
    ...extra,
  });
}

/** Nối toàn bộ core: security + guardrail LLM (gateway trên `pool`) + rollout (tự đọc sổ bằng
 * `pool`; null → DATABASE_URL như Python `connect()`). → gateway dùng chung của tiến trình. */
export function wireCore(pool: Db | null, extra: Partial<GatewayDeps> = {}): AiGateway {
  const gateway = createGateway(pool, extra);
  wireSecurity(gateway);
  setOpsDeps({ rollout: opsRollout });
  setConnector(pool ? async () => ({ db: pool, release: async () => {} }) : null);
  return gateway;
}
