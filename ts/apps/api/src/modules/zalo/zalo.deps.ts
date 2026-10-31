// Điểm nối tới module CHƯA thuộc nhóm zalo (bước tích hợp cung cấp provider theo token):
//   ZALO_CHANNELS ← connectors/channels.py (lớp kênh: luật trước LLM, đồng ý, handoff, gợi ý)
//   ZALO_RAG      ← api/rag.py (answer + NO_DATA + ngân sách 30 giây)
//   ZALO_GARDEN   ← connectors/zalo_garden.py (nhật ký vườn của nhân viên)
// Thiếu provider → fail-closed: lớp kênh/RAG ném lỗi → khách nhận ERROR_FALLBACK (hotline),
// không ai là nhân viên vườn (như allowlist hỏng ở Python); DEPLOY bật → từ chối serve
// (`wiringError` — POST 503, /readyz config loi, lệnh zalo-webhook exit 1).

import type { AiGateway } from '@samsam/core/ai/gateway';
import type { Pool } from 'pg';

export const ZALO_CHANNELS = Symbol('ZALO_CHANNELS');
export const ZALO_RAG = Symbol('ZALO_RAG');
export const ZALO_GARDEN = Symbol('ZALO_GARDEN');
/** Pool login dịch vụ webhook (`svc_webhook`) — null = chưa cấu hình DB (dev). */
export const ZALO_DB = Symbol('ZALO_DB');
export const ZALO_OPTIONS = Symbol('ZALO_OPTIONS');
/** Lệnh `zalo-webhook`: WebhookDepsFactory — dựng lớp kênh/RAG/vườn SAU khi lệnh mở pool webhook
 * và `wireCore(pool)` (Python `bind_service("webhook")`: mọi DB + LLM qua login svc_webhook). */
export const ZALO_WEBHOOK_DEPS = Symbol('ZALO_WEBHOOK_DEPS');

type Awaitable<T> = T | Promise<T>;

export type WebhookDeps = { channels?: ChatChannels; rag?: ChatRag; garden?: GardenIntake };
export type WebhookDepsFactory = (pool: Pool | null, gateway: AiGateway) => WebhookDeps;

/** channels.Inbound — zalo chỉ đọc `channel`, còn lại chuyển nguyên cho lớp kênh. */
export type Inbound = { channel: string } & Record<string, unknown>;
/** channels.Route — kind: consent_granted|consent_withdrawn|alcohol|health */
export type Route = { kind: string; text: string; handoff: string | null };
/** channels.Gate */
export type Gate = { prefix: string; block: boolean; prompted: boolean };
export type ReplyMeta = { guardrail_ok: unknown; handoff: string | null; blocked?: string[] };
export type AnswerResult = { answer: string; sources?: string[] | null; handoff?: string | null };
export type ChatMsg = { role: 'user' | 'assistant'; content: string };
export type SendFn = (userId: string, text: string) => Awaitable<unknown>;

export interface ChatChannels {
  /** Kênh lạ → ném lỗi (ValueError Python). */
  normalize(channel: string, userId: string, text: string): Inbound;
  preRoute(inb: Inbound): Route | null;
  consentGate(inb: Inbound): Awaitable<Gate>;
  /** rollout.mode('sales-01'): DB lỗi/chưa vào sổ → 'chay_thu'. */
  chatbotMode(): Awaitable<string>;
  /** Guardrail ĐÚNG 1 lần trên câu gốc (trước khi nối nguồn) → [text gửi khách, meta]. */
  formatReply(channel: string, res: AnswerResult): Awaitable<[string, ReplyMeta]>;
  /** id mục cskh_handoff | null (thiếu muối/DB down/tắt — không ném). */
  recordHandoff(inb: Inbound, reason: string, msgId: string): Awaitable<unknown>;
  recordConsent(inb: Inbound, action: string, msgId: string): Awaitable<unknown>;
  recordSuggestion(inb: Inbound, text: string, msgId: string, raw?: string): Awaitable<unknown>;
  template(key: string): string;
}

export interface ChatRag {
  NO_DATA: string;
  CHAT_BUDGET_S: number;
  SEND_RESERVE_S: number;
  /** Hạn chót (Python contextvar `rag.DEADLINE`): `deadline` = giây đồng hồ `clock.mono`,
   * `deadlineEpochMs` = cùng mốc theo epoch ms (đồng hồ của RagService). */
  answer(
    question: string,
    opts: { history?: ChatMsg[]; deadline: number; deadlineEpochMs: number },
  ): Awaitable<AnswerResult>;
}

export interface GardenIntake {
  /** Mã nhân viên vườn | null (allowlist thiếu/hỏng → null). */
  staffCode(userId: string): string | null;
  handle(
    userId: string,
    event: string,
    msg: Record<string, unknown>,
    msgId: string,
    send: SendFn,
  ): Awaitable<Record<string, unknown>>;
}

/** api.rag.DeadlineExceeded — `stage`: cho_lock | tra_loi | bước của RAG. Nhóm rag ném lớp này. */
export class DeadlineExceeded extends Error {
  constructor(readonly stage: string) {
    super(stage);
    this.name = 'DeadlineExceeded';
  }
}

export const isDeadline = (e: unknown): e is DeadlineExceeded =>
  e instanceof DeadlineExceeded ||
  (e instanceof Error &&
    e.name === 'DeadlineExceeded' &&
    typeof (e as { stage?: unknown }).stage === 'string');

const unwired = (name: string) => (): never => {
  throw new Error(`zalo: chưa nối '${name}'`);
};

// Hằng của api/rag.py (NO_DATA, CHAT_BUDGET_S, SEND_RESERVE_S) — dùng khi RAG chưa nối.
export const UNWIRED_RAG: ChatRag = {
  NO_DATA: 'Chưa đủ dữ liệu để trả lời.',
  CHAT_BUDGET_S: 30.0,
  SEND_RESERVE_S: 5.0,
  answer: unwired('rag'),
};

export const UNWIRED_CHANNELS: ChatChannels = {
  normalize: unwired('channels'),
  preRoute: unwired('channels'),
  consentGate: unwired('channels'),
  chatbotMode: unwired('channels'),
  formatReply: unwired('channels'),
  recordHandoff: unwired('channels'),
  recordConsent: unwired('channels'),
  recordSuggestion: unwired('channels'),
  template: unwired('channels'),
};

export const UNWIRED_GARDEN: GardenIntake = {
  staffCode: () => null,
  handle: unwired('garden'),
};
