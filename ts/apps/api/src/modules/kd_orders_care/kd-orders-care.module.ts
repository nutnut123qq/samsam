import { Module } from '@nestjs/common';
import { KdAffiliateCommand, KdCareCommand, KdOrdersCommand } from './kd-orders-care.command.js';

// Nhóm kd_orders_care: `agents/kd_orders.py` (sales-06.2 cảnh báo hủy/hoàn + đơn sàn → orders +
// file đối soát finance-01), `agents/kd_care.py` (sales-07.2 chăm sóc sau bán), `agents/kd_affiliate.py`
// (marketing-04.1 kit affiliate + finance-03.2 hoa hồng). Không controller: Python không có giao
// diện/webhook riêng (duyệt qua hàng duyệt chung). Lệnh CLI: `kd-orders`, `kd-care`, `kd-affiliate`;
// job lịch `order_watch` = `kd-orders --watch` (login dịch vụ job).
@Module({ providers: [KdOrdersCommand, KdCareCommand, KdAffiliateCommand] })
export class KdOrdersCareModule {}
