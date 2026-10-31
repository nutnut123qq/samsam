import { Module } from '@nestjs/common';
import {
  DaPmoCommand,
  HealthBulletinCommand,
  OpsIncidentsCommand,
  OpsMonthlyCommand,
} from './pmo-ops.command.js';

// Nhóm pmo_ops: `agents/da_pmo.py` (ceo-02.1 sổ mốc + bảng tuần), `pipelines/ops_incidents.py` (sổ sự
// cố PL02 mục 2), `scripts/ops_monthly.py` (data_platform-08 báo cáo vận hành tháng), `scripts/
// health_bulletin.py` (data_platform-07.1 bản tin sức khỏe). Không controller: không có giao diện/
// webhook riêng (báo cáo .md đọc ở tab Báo cáo; duyệt qua hàng duyệt chung). Lệnh CLI: `da-pmo`,
// `ops-incidents`, `ops-monthly`, `health-bulletin`; job lịch `kpi_snapshot` (= `ops-monthly
// --snapshot`), `health_bulletin` (= `health-bulletin`), `ops_monthly` (= `ops-monthly --month prev`).
@Module({
  providers: [DaPmoCommand, OpsIncidentsCommand, OpsMonthlyCommand, HealthBulletinCommand],
})
export class PmoOpsModule {}
