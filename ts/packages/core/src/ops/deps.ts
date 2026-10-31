import type pg from 'pg';
import type { Env } from '../env.js';

// Điểm nối tới hàm của core/security, core/ai, core/rollout — ops/ không import trực tiếp để test
// thay được; tiến trình gọi `wireCore(pool)` (ops/wire) MỘT lần lúc khởi động (api/worker: DbModule,
// cli: cli.ts), test gọi `installFakeDeps` (ops/testing). Chưa nối mà dùng → lỗi (fail-closed: không
// bao giờ "cho qua" khi thiếu guardrail/cổng triển khai/ủy quyền).
//
// Ánh xạ Python → nơi port dự kiến:
//   maskPii           pipelines.pii._mask_pii                @samsam/core/security/pii
//   guardrailCheck    pipelines.guardrail.check              @samsam/core/security/guardrail
//   checkPublish      pipelines.guardrail.check_publish      @samsam/core/security/guardrail
//   withViolation     pipelines.guardrail.with_violation     @samsam/core/security/guardrail
//   checkPublishLlm   pipelines.guardrail_llm.check_publish_llm  @samsam/core/security/guardrail-llm
//   auth.*            pipelines.auth                          @samsam/core/security/auth
//   rollout.*         pipelines.rollout                       @samsam/core/rollout/rollout

type Awaitable<T> = T | Promise<T>;
/** Pool hoặc client đang mở (Python: `conn`). */
export type Db = pg.Pool | pg.ClientBase;

export type GuardrailResult = Record<string, unknown> & { ok?: unknown };
export type PublishCtx = {
  channel: string;
  content_type: string;
  sku: string | null;
  is_ai: boolean;
  readiness?: Map<string, string> | null; // khóa `${sku_key}\u0000${channel}` → readiness
};
export type Feature = { id: string; phong_ban?: string } & Record<string, unknown>;

export interface OpsDeps {
  maskPii(s: string): string;
  guardrailCheck(text: string): GuardrailResult;
  checkPublish(text: string, ctx: PublishCtx): GuardrailResult;
  withViolation(
    result: unknown,
    code: string,
    detail: unknown,
    span?: unknown,
    start?: unknown,
    end?: unknown,
  ): GuardrailResult;
  checkPublishLlm(text: string, ctx: PublishCtx): Awaitable<GuardrailResult>;
  auth: {
    /** `pipelines.auth.ROLES` — vai trò hợp lệ của `approver_roles`. */
    ROLES: readonly string[];
    DEV_WARNING: string;
    isHuman(name: unknown): boolean;
    authorize(
      by: unknown,
      block: string | null,
      action: string,
      opts: {
        createdBy?: string | null;
        role?: string | null;
        via?: string;
        dbLogin?: string | null;
        env?: Env;
        allow?: string[] | null;
        allowSrc?: string | null;
      },
    ): Awaitable<{ ok: boolean; why: string | null }>;
    sessionLogin(db: Db): Awaitable<string | null>;
    denyLog(
      db: Db,
      by: unknown,
      block: string | null,
      action: string,
      objectType: string,
      objectId: string,
      reason: string | null,
      env?: Env,
    ): Awaitable<void>;
    cliGate(
      db: Db,
      by: unknown,
      block: string | null,
      action: string,
      objectType: string,
      objectId: string,
      opts: { createdBy?: string | null; allow?: string[] | null; allowSrc?: string; env?: Env },
    ): Awaitable<string | null>;
  };
  rollout: {
    /** Tính năng TẮT → ném lỗi (RolloutBlocked); chạy thử vẫn sinh. */
    checkGenerate(db: Db | null, fid: string | null, what: string): Awaitable<void>;
    decideReason(db: Db | null, fid: string | null, what: string): Awaitable<string | null>;
    useReason(
      db: Db | null,
      fid: string | null,
      what: string,
      humanReviewed: boolean,
    ): Awaitable<string | null>;
    featureFor(attrs: Record<string, unknown>): string | null;
    /** Giai đoạn biết được không cần DB | null. */
    quickMode(): string | null;
    mode(db: Db | null, fid: string | null): Awaitable<string>;
    /** Danh mục `data/contract_features.json` đã kiểm | null khi hỏng. */
    catalog(): readonly Feature[] | null;
    isHuman(name: unknown): boolean;
    /** Tiền tố báo cáo của tính năng TẮT → ném lỗi. → giai đoạn | null. */
    gateReport(name: string, fid?: string | null): Awaitable<string | null>;
    labelReport(name: string, text: string, md: string | null, fid?: string | null): string;
    recordReport(
      name: string,
      text: string,
      sample: boolean | null,
      fid?: string | null,
    ): Awaitable<boolean>;
  };
}

let bound: Partial<OpsDeps> = {};

/** Nối (hoặc thay một phần) hàm của nhóm khác. */
export function setOpsDeps(d: Partial<OpsDeps>): void {
  bound = { ...bound, ...d };
}

export function resetOpsDeps(): void {
  bound = {};
}

/** Hàm đã nối; thiếu → lỗi rõ tên (không bao giờ đoán mặc định). */
export function dep<K extends keyof OpsDeps>(k: K): OpsDeps[K] {
  const v = bound[k];
  if (v === undefined)
    throw new Error(`ops: chưa nối '${k}' (wireCore ở ops/wire — hoặc installFakeDeps trong test)`);
  return v as OpsDeps[K];
}
