import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { connectDatabaseUrl, type DbLease } from '@samsam/core/db';
import { createGateway } from '@samsam/core/ops/wire';
import type { Pool } from 'pg';
import { RAG_ANSWER } from './modules/channels/channels.command.js';
import { type AnswerFn, chatChannels } from './modules/channels/channels.service.js';
import { GardenZaloService } from './modules/garden_zalo/garden-zalo.service.js';
import {
  CHAT_BUDGET_S,
  FEATURE,
  NO_DATA,
  RagService,
  SEND_RESERVE_S,
} from './modules/rag/rag.service.js';
import {
  type ChatRag,
  type WebhookDepsFactory,
  ZALO_CHANNELS,
  ZALO_GARDEN,
  ZALO_RAG,
} from './modules/zalo/zalo.deps.js';
import { webhookPool } from './modules/zalo/zalo.module.js';

// Nối chéo nhóm (bước tích hợp): lớp kênh (channels) + RAG (rag) + nhật ký vườn (garden_zalo) vào
// webhook Zalo/Messenger, answer() của RAG vào lệnh `channels`. Python: connectors.zalo/messenger
// chạy bằng login svc_webhook — mọi DB + LLM của lượt chat đi qua pool webhook.

/** RagService → cổng ChatRag của zalo/messenger (chatbot khách = tính năng sales-01). */
export const chatRag = (rag: RagService): ChatRag => ({
  NO_DATA,
  CHAT_BUDGET_S,
  SEND_RESERVE_S,
  answer: (q, o) =>
    rag.answer(q, o.history ?? null, { deadline: o.deadlineEpochMs, feature: FEATURE }),
});

/** ZALO_WEBHOOK_DEPS của lệnh `zalo-webhook`/`messenger-webhook` — gọi SAU khi lệnh mở pool
 * webhook và `wireCore(pool)` (pool null = dev chưa cấu hình DB: lớp kênh/RAG tự fail-closed). */
export const webhookDeps: WebhookDepsFactory = (pool, gateway) => ({
  channels: chatChannels(pool),
  rag: chatRag(new RagService(pool as Pool, gateway)),
  garden: new GardenZaloService(pool),
});

const WEBHOOK_POOL = Symbol('WEBHOOK_POOL');

@Injectable()
class WebhookPoolCloser implements OnApplicationShutdown {
  constructor(@Optional() @Inject(WEBHOOK_POOL) private readonly pool: Pool | null = null) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }
}

/**
 * Webhook chạy chung tiến trình API (ZaloModule/MessengerFanpageModule): ZALO_CHANNELS/ZALO_RAG/
 * ZALO_GARDEN trên pool login webhook riêng + gateway trên pool đó (llm_usage ghi bằng svc_webhook,
 * không phải svc_ui của API). Chế độ thực thiếu WEBHOOK_DATABASE_URL → API không khởi động.
 */
@Global()
@Module({
  providers: [
    { provide: WEBHOOK_POOL, useFactory: () => webhookPool() },
    {
      provide: ZALO_CHANNELS,
      inject: [WEBHOOK_POOL],
      useFactory: (p: Pool | null) => chatChannels(p),
    },
    {
      provide: ZALO_RAG,
      inject: [WEBHOOK_POOL],
      useFactory: (p: Pool | null) => chatRag(new RagService(p as Pool, createGateway(p))),
    },
    {
      provide: ZALO_GARDEN,
      inject: [WEBHOOK_POOL],
      useFactory: (p: Pool | null) => new GardenZaloService(p),
    },
    WebhookPoolCloser,
  ],
  exports: [ZALO_CHANNELS, ZALO_RAG, ZALO_GARDEN],
})
export class WebhookWiringModule {}

/** RAG_ANSWER của lệnh `channels` (Python `api.rag.answer` trên DATABASE_URL): kết nối khi gọi lần
 * đầu, đóng khi CLI tắt. DB down → RagService lỗi → lệnh dùng câu chuyển nhân viên. */
@Injectable()
export class CliRagAnswer implements OnApplicationShutdown {
  private lease?: Promise<DbLease | null>;

  readonly answer: AnswerFn = async (q, o) => {
    this.lease ??= connectDatabaseUrl();
    const db = (await this.lease)?.db ?? null;
    return new RagService(db as Pool, createGateway(db)).answer(q, null, { feature: o.feature });
  };

  async onApplicationShutdown(): Promise<void> {
    await (await this.lease)?.release();
  }
}

export const CLI_RAG_PROVIDERS = [
  CliRagAnswer,
  { provide: RAG_ANSWER, inject: [CliRagAnswer], useFactory: (r: CliRagAnswer) => r.answer },
];
