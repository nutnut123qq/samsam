import { Module } from '@nestjs/common';
import type { Command } from 'commander';
import { CORE_COMMANDS } from './cli/core.commands.js';
import { DbPingCommand } from './cli/db-ping.command.js';
import { RedAlertCommand } from './cli/red-alert.command.js';
import { BksHdtvModule } from './modules/bks_hdtv/bks-hdtv.module.js';
import { CeoMiscModule } from './modules/ceo_misc/ceo-misc.module.js';
import { CeoReportModule } from './modules/ceo_report/ceo-report.module.js';
import { B2bFormCommand, ChannelsCommand } from './modules/channels/channels.command.js';
import { CONTENT_COMMANDS } from './modules/content/content.module.js';
import { CrmModule } from './modules/crm/crm.module.js';
import { FinArPnlModule } from './modules/fin_ar_pnl/fin-ar-pnl.module.js';
import { FinCashModule } from './modules/fin_cash/fin-cash.module.js';
import { GardenDirectorModule } from './modules/garden_director/garden-director.module.js';
import { GardenZaloModule } from './modules/garden_zalo/garden-zalo.module.js';
import { IMAGE_VIDEO_COMMANDS } from './modules/image_video/image-video.module.js';
import { IntelAlertModule } from './modules/intel_alert/intel-alert.module.js';
import { IntelCrawlModule } from './modules/intel_crawl/intel-crawl.module.js';
import { IntelImportModule } from './modules/intel_import/intel-import.module.js';
import { KdListingLiveModule } from './modules/kd_listing_live/kd-listing-live.module.js';
import { KdOrdersCareModule } from './modules/kd_orders_care/kd-orders-care.module.js';
import { KdPriceModule } from './modules/kd_price/kd-price.module.js';
import { KdQuoteModule } from './modules/kd_quote/kd-quote.module.js';
import { LegalHrModule } from './modules/legal_hr/legal-hr.module.js';
import { LoadersModule } from './modules/loaders/loaders.module.js';
import { MarketModule } from './modules/market/market.module.js';
import { MessengerWebhookCommand } from './modules/messenger_fanpage/messenger.command.js';
import { MktAdsModule } from './modules/mkt_ads/mkt-ads.module.js';
import { MktKocUgcSeoModule } from './modules/mkt_koc_ugc_seo/mkt-koc-ugc-seo.module.js';
import { OpsScriptsModule } from './modules/ops_scripts/ops-scripts.module.js';
import { PmoOpsModule } from './modules/pmo_ops/pmo-ops.module.js';
import { ProductionModule } from './modules/production/production.module.js';
import { QrAnchorModule } from './modules/qr_anchor/qr-anchor.module.js';
import { RaKenhModule } from './modules/ra_kenh/ra-kenh.module.js';
import { RAG_COMMANDS } from './modules/rag/rag.module.js';
import { SalesDirectorModule } from './modules/sales_director/sales-director.module.js';
import { SettlementModule } from './modules/settlement/settlement.module.js';
import { SxDocsModule } from './modules/sx_docs/sx-docs.module.js';
import {
  WebhookProbeCommand,
  ZaloPreflightCommand,
  ZaloWebhookCommand,
} from './modules/zalo/zalo.command.js';
import { ZALO_WEBHOOK_DEPS } from './modules/zalo/zalo.deps.js';
import { CLI_RAG_PROVIDERS, webhookDeps } from './wiring.js';

/**
 * Lệnh CLI (nest-commander) thay `python -m …` — mỗi lệnh tự mở Pool đúng dịch vụ hoặc login người.
 * Module chỉ có lệnh được import nguyên; lệnh của module cần PG_POOL/AI_GATEWAY (content, rag,
 * zalo, messenger) hoặc cần provider của CliModule (channels: RAG_ANSWER) đăng ký thẳng ở đây.
 * SettlementModule @Global: `market-api --kind settlement` nhận SETTLEMENT_HOOKS.
 * CeoMiscModule/FinCashModule nối section/nguồn cho ceo-report/hdtv-report/fin-director lúc init.
 */
@Module({
  imports: [
    BksHdtvModule,
    CeoMiscModule,
    CeoReportModule,
    CrmModule,
    FinArPnlModule,
    FinCashModule,
    GardenDirectorModule,
    GardenZaloModule,
    IntelAlertModule,
    IntelCrawlModule,
    IntelImportModule,
    KdListingLiveModule,
    KdOrdersCareModule,
    KdPriceModule,
    KdQuoteModule,
    LegalHrModule,
    LoadersModule,
    MarketModule,
    MktAdsModule,
    MktKocUgcSeoModule,
    OpsScriptsModule,
    PmoOpsModule,
    ProductionModule,
    QrAnchorModule,
    RaKenhModule,
    SalesDirectorModule,
    SettlementModule,
    SxDocsModule,
  ],
  providers: [
    DbPingCommand,
    RedAlertCommand,
    ...CORE_COMMANDS,
    ChannelsCommand,
    B2bFormCommand,
    ...CONTENT_COMMANDS,
    ...RAG_COMMANDS,
    ...IMAGE_VIDEO_COMMANDS,
    ZaloWebhookCommand,
    WebhookProbeCommand,
    ZaloPreflightCommand,
    MessengerWebhookCommand,
    ...CLI_RAG_PROVIDERS,
    { provide: ZALO_WEBHOOK_DEPS, useValue: webhookDeps },
  ],
})
export class CliModule {}

/** Sai cú pháp/tham số → exit 2 như argparse. nest-commander chỉ gắn `errorHandler` cho lệnh GỐC
 * (`addCommand` không kế thừa) — lệnh con mặc định `process.exit(1)` khi cờ lạ/thiếu. */
export function cliExitOverride(root: Command, handler: (e: Error) => void): void {
  for (const c of root.commands) {
    c.exitOverride(handler);
    cliExitOverride(c, handler);
  }
}

/** errorHandler chung: help/version → 0, lỗi cú pháp → 2. */
export function cliErrorHandler(e: Error): never {
  const code = (e as { code?: string }).code;
  if (code === 'commander.helpDisplayed' || code === 'commander.version') process.exit(0);
  console.error(`[err] ${e.message}`);
  process.exit(2);
}
