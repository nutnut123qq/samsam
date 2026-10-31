import 'reflect-metadata';
import { Inject, Optional } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { ServiceBindError } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { wireCore } from '@samsam/core/ops/wire';
import { Command, CommandRunner } from 'nest-commander';
import type { Pool } from 'pg';
import { userHash } from '../channels/channels.service.js';
import { deployOn } from '../zalo/zalo.constants.js';
import { type WebhookDepsFactory, ZALO_WEBHOOK_DEPS } from '../zalo/zalo.deps.js';
import { webhookPool } from '../zalo/zalo.module.js';
import { wiringError, ZaloService } from '../zalo/zalo.service.js';
import { DEFAULT_PORT, envStr, PATH, REQUIRED_ENV, startupError } from './messenger.service.js';
import { messengerWebhookApp } from './messenger-fanpage.module.js';

/**
 * `messenger-webhook` thay `python -m connectors.messenger`: DEPLOY bật thiếu secret/token/muối →
 * in `[fatal]` exit 1; login DB dịch vụ webhook sai → `[fatal] messenger: …` exit 1; nghe
 * 0.0.0.0:MESSENGER_WEBHOOK_PORT (8789) — /messenger-webhook, /healthz, /readyz.
 * Lớp kênh/RAG: factory ZALO_WEBHOOK_DEPS của CliModule dựng SAU khi mở pool webhook + `wireCore(pool)`
 * (như zalo-webhook); DEPLOY bật mà chưa nối → `[fatal]` exit 1, thiếu khi dev → fail-closed.
 */
@Command({
  name: 'messenger-webhook',
  description:
    'Messenger webhook (Facebook Page) — dùng chung pipeline Zalo; DEPLOY tắt = không gửi gì ra Meta',
})
export class MessengerWebhookCommand extends CommandRunner {
  /** Chờ tín hiệu dừng (test thay). */
  waitStop: () => Promise<void> = () =>
    new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  env: Env = process.env;
  /** Nối core trên pool của lệnh (test thay). */
  wire: (pool: Pool | null) => AiGateway = wireCore;

  constructor(
    @Optional() @Inject(ZALO_WEBHOOK_DEPS) private readonly makeDeps?: WebhookDepsFactory,
  ) {
    super();
  }

  async run(): Promise<void> {
    const env = this.env;
    const err = startupError(env);
    if (err) {
      console.log(err);
      process.exitCode = 1;
      return;
    }
    const p = envStr(env, 'MESSENGER_WEBHOOK_PORT') || String(DEFAULT_PORT);
    if (!/^[0-9]+$/.test(p) || Number(p) > 65535) {
      console.log('[fatal] messenger: MESSENGER_WEBHOOK_PORT không hợp lệ');
      process.exitCode = 1;
      return;
    }
    // v14.2: login DB dịch vụ riêng (WEBHOOK_DATABASE_URL, role svc_webhook).
    let pool: Pool | null;
    try {
      pool = await webhookPool(env);
    } catch (e) {
      console.log(
        `[fatal] messenger: ${e instanceof ServiceBindError ? e.message : (e as Error).name}`,
      );
      process.exitCode = 1;
      return;
    }
    // Python bind_service("webhook"): mọi DB + LLM (gateway, cổng triển khai) qua login svc_webhook.
    const deps = this.makeDeps ? this.makeDeps(pool, this.wire(pool)) : {};
    const unwired = wiringError(env, deps);
    if (unwired) {
      console.log(unwired);
      process.exitCode = 1;
      await pool?.end();
      return;
    }
    const app = await NestFactory.create(
      messengerWebhookApp(pool, { channels: deps.channels, rag: deps.rag, options: { env } }),
      { bodyParser: false, logger: ['error', 'warn'] },
    );
    const port = Number(p);
    try {
      await app.listen(port, '0.0.0.0');
      const st = (k: string) => (envStr(env, k) ? 'set' : 'MISSING');
      const [secret, token, verify] = REQUIRED_ENV.map(st);
      console.log(
        `[messenger] webhook :${port}${PATH} (app_secret=${secret}, page_token=${token}, ` +
          `verify_token=${verify}, salt=${userHash('messenger', '', env) === null ? 'MISSING' : 'set'}, ` +
          `deploy=${deployOn(env) ? 'ON' : 'OFF (dry-run)'})`,
      );
      await this.waitStop();
    } finally {
      app.get(ZaloService).seen.close();
      await app.close();
      await pool?.end();
    }
  }
}
