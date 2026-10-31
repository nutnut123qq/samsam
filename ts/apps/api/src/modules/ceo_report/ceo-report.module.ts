import { Module } from '@nestjs/common';
import { CeoReportCommand, CockpitCommand } from './ceo-report.command.js';

// Nhóm ceo_report: `pipelines/cockpit.py` (chụp số điều hành vào `channel_snapshots` — ceo-01,
// marketing-06.2), `pipelines/mkt_metrics.py` (số đo marketing cho mục 5 báo cáo định kỳ + cockpit —
// marketing-06.2), `agents/ceo_report.py` (trang tuần/tháng cho TGĐ vào hàng duyệt khối ceo — ceo-01).
// Không controller: không giao diện/webhook riêng (báo cáo file + hàng duyệt chung). Lệnh CLI:
// `cockpit`, `ceo-report`. Job lịch `ceo_weekly` (deploy/onprem/jobs.json): `cockpit --collect
// --period week` rồi `ceo-report --period week --submit`.
// Hàm dùng chung cho nhóm khác (import trực tiếp): `ceo-report.ts` build/fmtValue/fmtDelta
// (hdtv_report), `cockpit.ts` closed/lastClosedRef/loadMetrics (bks_audit, hdtv_report),
// `mkt-metrics.ts` collect (= `Collectors.marketing` của core ops/report), `cockpit.collectChat`
// (= `Collectors.chat`). 3 section v8.1 do nhóm ceo_misc nối qua `setCeoSections`.
@Module({ providers: [CockpitCommand, CeoReportCommand] })
export class CeoReportModule {}
