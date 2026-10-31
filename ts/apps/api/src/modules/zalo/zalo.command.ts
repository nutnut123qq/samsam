import 'reflect-metadata';
import { Inject, Optional } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { ServiceBindError } from '@samsam/core/db';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool } from 'pg';
import { probeMain } from './webhook-probe.js';
import { type WebhookDepsFactory, ZALO_WEBHOOK_DEPS } from './zalo.deps.js';
import { webhookPool, zaloWebhookApp } from './zalo.module.js';
import { senderConfig, ZaloSender } from './zalo.sender.js';
import { wiringError, ZaloService } from './zalo.service.js';
import { preflightMain } from './zalo-preflight.js';

/**
 * `zalo-webhook` thay `python -m connectors.zalo`: DEPLOY bật thiếu OA secret / đường gửi → in
 * `[fatal]` exit 1; login DB dịch vụ webhook sai → `[fatal] zalo: …` exit 1; nối core trên pool
 * webhook (`wireCore`) rồi dựng lớp kênh/RAG/vườn bằng factory ZALO_WEBHOOK_DEPS của CliModule —
 * DEPLOY bật mà chưa nối → `[fatal]` exit 1; purge convlog lúc boot (onModuleInit, lỗi chỉ warn);
 * nghe 0.0.0.0:ZALO_WEBHOOK_PORT (8788) — /zalo-webhook, /healthz, /readyz.
 */
@Command({ name: 'zalo-webhook', description: 'Webhook Zalo OA :ZALO_WEBHOOK_PORT/zalo-webhook' })
export class ZaloWebhookCommand extends CommandRunner {
  /** Nối core trên pool của lệnh (test thay). */
  wire: (pool: Pool | null) => AiGateway = wireCore;

  constructor(
    @Optional() @Inject(ZALO_WEBHOOK_DEPS) private readonly makeDeps?: WebhookDepsFactory,
  ) {
    super();
  }

  async run(): Promise<void> {
    const probe = new ZaloService(null);
    const err = probe.startupError();
    if (err) {
      console.log(err);
      process.exitCode = 1;
      return;
    }
    let pool: Pool | null;
    try {
      pool = await webhookPool();
    } catch (e) {
      console.log(`[fatal] zalo: ${e instanceof ServiceBindError ? e.message : (e as Error).name}`);
      process.exitCode = 1;
      return;
    }
    // Python bind_service("webhook"): mọi DB + LLM (gateway, cổng triển khai) qua login svc_webhook.
    const gateway = this.wire(pool);
    const deps = this.makeDeps?.(pool, gateway) ?? {};
    const unwired = wiringError(process.env, deps);
    if (unwired) {
      console.log(unwired);
      process.exitCode = 1;
      await pool?.end();
      return;
    }
    const app = await NestFactory.create(zaloWebhookApp(pool, deps), {
      bodyParser: false,
      logger: ['error', 'warn'],
    });
    const zalo = app.get(ZaloService);
    await app.listen(zalo.port, '0.0.0.0'); // init → onModuleInit purge convlog TRƯỚC khi nghe
    const set = (b: boolean) => (b ? 'set' : 'MISSING');
    console.log(
      `[zalo] webhook :${zalo.port}/zalo-webhook (oa_secret=${set(Boolean(zalo.oaSecret))}, ` +
        `token=${set(Boolean(zalo.sender.currentAccessToken()))}, refresh=${set(zalo.sender.canRefresh())})`,
    );
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await app.close();
    await pool?.end();
  }
}

/** `webhook-probe` thay `python scripts/webhook_probe.py [--url URL ...] [--dry-run]`. */
@Command({ name: 'webhook-probe', description: 'Dò /readyz webhook Zalo/Messenger → cảnh báo đỏ' })
export class WebhookProbeCommand extends CommandRunner {
  async run(_args: string[], o: { url?: string[]; dryRun?: boolean }): Promise<void> {
    process.exitCode = await probeMain(o);
  }

  @Option({ flags: '--url <url>', description: 'URL /readyz (lặp lại được)' })
  parseUrl(v: string, prev: string[] = []): string[] {
    return [...prev, v];
  }

  @Option({ flags: '--dry-run', description: 'không ghi DB' })
  parseDryRun(): boolean {
    return true;
  }
}

/** `zalo-preflight` thay `python scripts/zalo_preflight.py [--refresh]`. */
@Command({ name: 'zalo-preflight', description: 'Preflight Zalo OA trước khi mở webhook public' })
export class ZaloPreflightCommand extends CommandRunner {
  async run(_args: string[], o: { refresh?: boolean }): Promise<void> {
    const tokenStore = dataPath('zalo_tokens.json');
    const sender = new ZaloSender(senderConfig(process.env, tokenStore));
    process.exitCode = await preflightMain({ ...process.env }, Boolean(o.refresh), {
      tokenStore,
      refresh: () => sender.refreshAccessToken(),
    });
  }

  @Option({
    flags: '--refresh',
    description: 'token hết hạn/thiếu: gọi refresh_access_token() thật rồi check lại',
  })
  parseRefresh(): boolean {
    return true;
  }
}
