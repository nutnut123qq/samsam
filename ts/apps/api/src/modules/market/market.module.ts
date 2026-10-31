import { Module } from '@nestjs/common';
import { MarketApiCommand, MarketCsvCommand } from './market.command.js';

// Nhóm market (data_platform-05 "Kết nối dữ liệu sàn (nhập file)", data_platform-06 "Kết nối API sàn
// chỉ đọc", nguồn đơn cho sales-06.2): `ingest/market_csv.py` (lệnh `market-csv`) và
// `ingest/market_api.py` (lệnh `market-api`). Không controller: không có giao diện/webhook riêng
// (cảnh báo sàn đọc qua báo cáo `--report` và agent kd_listing/kd_price/sales_director). Không job lịch.
// `--kind settlement` cần provider `SETTLEMENT_HOOKS` (bản TS của ingest.settlement_api — nhóm
// settlement) — chưa có thì lệnh báo [blocked] exit 2, 0 request.
@Module({ providers: [MarketCsvCommand, MarketApiCommand] })
export class MarketModule {}
