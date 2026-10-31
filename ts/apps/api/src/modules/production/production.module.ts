import { Module } from '@nestjs/common';
import { InventoryCsvCommand, ProductionCommand } from './production.command.js';

// Nhóm production (tính năng production-01 "Báo cáo sản xuất", production-04.3 "Hồ sơ lô, cảnh báo
// cận hạn"): `pipelines/production.py` (phân bổ tồn/BOM/lô/kiểm nhập/phiếu kiểm nghiệm/kế hoạch/bản
// tin), `pipelines/lot_certs.py`, `ingest/inventory_csv.py`. Không controller: Python không có giao
// diện/webhook riêng (quyết định của người qua CLI + function DB `*_human`/SECURITY DEFINER).
// Không có service đọc bản tin: bản tin chỉ dựng qua lệnh `production bulletin` (có cổng
// production-01/04.3, HĐ 6.7) — trang web cần thì gọi qua đúng cổng đó.
// Lệnh CLI: `production <lệnh con>`, `inventory-csv`; job lịch `production_week`/`production_month`
// = `production bulletin --period week|month --out-dir data/reports`.
@Module({
  providers: [ProductionCommand, InventoryCsvCommand],
})
export class ProductionModule {}
