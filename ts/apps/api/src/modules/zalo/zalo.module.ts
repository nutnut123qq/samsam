import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  Optional,
  type Provider,
} from '@nestjs/common';
import { serviceDsn, servicePool } from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import type { Pool } from 'pg';
import { ZaloController, ZaloHealthController } from './zalo.controller.js';
import { type WebhookDeps, ZALO_CHANNELS, ZALO_DB, ZALO_GARDEN, ZALO_RAG } from './zalo.deps.js';
import { ZaloService } from './zalo.service.js';

/**
 * Pool login webhook (`svc_webhook`, WEBHOOK_DATABASE_URL — như `auth.bind_service("webhook")`).
 * Dev chưa cấu hình DB → null (bằng chứng/handoff chỉ warn). Chế độ thực: thiếu biến / login
 * superuser-owner / sai role → ném → tiến trình không khởi động (fail-closed).
 */
export async function webhookPool(env: Env = process.env): Promise<Pool | null> {
  if (serviceDsn('webhook', env).error !== null && !approvalEnforced(env)) return null;
  return servicePool('webhook', env);
}

@Injectable()
class ZaloCloser implements OnApplicationShutdown {
  constructor(
    @Inject(ZaloService) private readonly zalo: ZaloService,
    @Optional() @Inject(ZALO_DB) private readonly pool: Pool | null = null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.zalo.seen.close();
    await this.pool?.end();
  }
}

/** Chạy chung tiến trình API: POST /zalo-webhook + GET /zalo-webhook/readyz. Lớp kênh/RAG/vườn
 * lấy từ provider toàn cục ZALO_CHANNELS/ZALO_RAG/ZALO_GARDEN (thiếu → fail-closed). */
@Module({
  providers: [ZaloService, { provide: ZALO_DB, useFactory: () => webhookPool() }, ZaloCloser],
  controllers: [ZaloController],
  exports: [ZaloService],
})
export class ZaloModule {}

class ZaloWebhookApp {}

/** App riêng của lệnh `zalo-webhook` (Python `python -m connectors.zalo`): pool + phụ thuộc truyền
 * vào sẵn, thêm /healthz + /readyz. Lệnh tự đóng pool khi dừng. */
export function zaloWebhookApp(pool: Pool | null, deps: WebhookDeps = {}): DynamicModule {
  const providers: Provider[] = [ZaloService, { provide: ZALO_DB, useValue: pool }];
  if (deps.channels) providers.push({ provide: ZALO_CHANNELS, useValue: deps.channels });
  if (deps.rag) providers.push({ provide: ZALO_RAG, useValue: deps.rag });
  if (deps.garden) providers.push({ provide: ZALO_GARDEN, useValue: deps.garden });
  return {
    module: ZaloWebhookApp,
    providers,
    controllers: [ZaloController, ZaloHealthController],
    exports: [ZaloService],
  };
}
