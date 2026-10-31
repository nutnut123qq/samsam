import { Module } from '@nestjs/common';
import { REPORTS_DIR } from '@samsam/core/ops/report';
import { DATA_DIR } from '@samsam/core/paths';
import { ApprovalWebModule } from '../approval/approval.module.js';
import { REPORT_DIRS, ReportController } from './report.controller.js';

// Web tab "Báo cáo" (REST /reports) — tách khỏi CeoReportModule (chỉ lệnh CLI). PERSON_ENV (env
// tiến trình) lấy từ ApprovalWebModule; PG_POOL (svc_ui) từ DbModule global.
@Module({
  imports: [ApprovalWebModule],
  controllers: [ReportController],
  providers: [{ provide: REPORT_DIRS, useValue: { out: REPORTS_DIR, data: DATA_DIR } }],
})
export class ReportWebModule {}
