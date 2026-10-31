import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { ApprovalWebModule } from './modules/approval/approval.module.js';
import { ReportWebModule } from './modules/ceo_report/report-web.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { CrmWebModule } from './modules/crm/leads.controller.js';
import { GardenWebModule } from './modules/garden_zalo/garden-web.module.js';
import { MessengerFanpageModule } from './modules/messenger_fanpage/messenger-fanpage.module.js';
import { RagModule } from './modules/rag/rag.module.js';
import { ZaloModule } from './modules/zalo/zalo.module.js';
import { WebhookWiringModule } from './wiring.js';

// API (login svc_ui): /healthz, /readyz, REST cho web (Keycloak): /me, Content Studio (/content/*),
// Chat + Chưa trả lời (/chat, /chat/unanswered), Leads (/leads); webhook Zalo (/zalo-webhook) +
// Messenger (/messenger-webhook) trên pool login webhook riêng (WebhookWiringModule). Module chỉ có
// lệnh CLI đăng ký ở cli.module.ts, không ở đây.
@Module({
  imports: [
    DbModule.forRoot('ui'),
    HealthModule,
    WebhookWiringModule,
    ContentModule,
    CrmWebModule,
    // Báo cáo (/reports), Nhật ký vườn (/garden), Duyệt & Lịch (/approval + phiên login người).
    ReportWebModule,
    GardenWebModule,
    ApprovalWebModule,
    RagModule,
    ZaloModule,
    MessengerFanpageModule,
  ],
})
export class AppModule {}
