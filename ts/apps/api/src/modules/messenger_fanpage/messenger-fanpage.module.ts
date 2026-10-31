import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  type ChatChannels,
  type ChatRag,
  ZALO_CHANNELS,
  ZALO_DB,
  ZALO_RAG,
} from '../zalo/zalo.deps.js';
import { ZaloModule } from '../zalo/zalo.module.js';
import { ZaloService } from '../zalo/zalo.service.js';
import { MessengerController, MessengerHealthController } from './messenger.controller.js';
import { MESSENGER_OPTIONS, type MessengerOptions, MessengerService } from './messenger.service.js';

// Nhóm messenger_fanpage: webhook Messenger (connectors/messenger.py) chạy chung tiến trình API
// (POST/GET /messenger-webhook + GET /messenger-webhook/readyz) dùng ZaloService của ZaloModule; hoặc
// tiến trình riêng qua lệnh `messenger-webhook` (messengerWebhookApp). connectors/fanpage.py =
// hàm thuần ở fanpage.ts (không provider — `ra_kenh --scan-auto` import trực tiếp).
@Module({
  imports: [ZaloModule],
  providers: [MessengerService],
  controllers: [MessengerController],
  exports: [MessengerService],
})
export class MessengerFanpageModule {}

/** Tiến trình Messenger không phục vụ Zalo → bỏ kiểm cấu hình Zalo lúc khởi động (Python chỉ chạy
 * `_startup_error` của messenger). */
class ZaloPipeline extends ZaloService {
  override onModuleInit(): void {}
}

class MessengerWebhookApp {}

export type MessengerAppDeps = {
  channels?: ChatChannels;
  rag?: ChatRag;
  options?: Partial<MessengerOptions>;
  /** Test: ZaloService dựng sẵn (thay ZaloPipeline). */
  zalo?: ZaloService;
};

/** App riêng của lệnh `messenger-webhook` (Python `python -m connectors.messenger`): pipeline Zalo +
 * /messenger-webhook + /healthz + /readyz. Lệnh tự đóng pool khi dừng. */
export function messengerWebhookApp(pool: Pool | null, deps: MessengerAppDeps = {}): DynamicModule {
  const providers: Provider[] = [
    deps.zalo
      ? { provide: ZaloService, useValue: deps.zalo }
      : { provide: ZaloService, useClass: ZaloPipeline },
    { provide: ZALO_DB, useValue: pool },
    MessengerService,
  ];
  if (deps.channels) providers.push({ provide: ZALO_CHANNELS, useValue: deps.channels });
  if (deps.rag) providers.push({ provide: ZALO_RAG, useValue: deps.rag });
  if (deps.options) providers.push({ provide: MESSENGER_OPTIONS, useValue: deps.options });
  return {
    module: MessengerWebhookApp,
    providers,
    controllers: [MessengerController, MessengerHealthController],
    exports: [MessengerService],
  };
}
