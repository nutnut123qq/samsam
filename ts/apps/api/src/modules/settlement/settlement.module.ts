import { Global, Module } from '@nestjs/common';
import { SETTLEMENT_HOOKS } from '../market/market.command.js';
import { RevShareCommand, SettlementCsvCommand } from './settlement.command.js';
import { settlementHooks } from './settlement-hooks.js';

// Nhóm settlement: `ingest/settlement_csv.py` (finance-01 đối soát tiền sàn), `ingest/settlement_api.py`
// (data_platform-06 quyết toán qua API sàn chỉ đọc — chạy trong lệnh `market-api --kind settlement`
// của nhóm market, hàm ở `settlement-api.ts`), `agents/rev_share.py` (finance-06 biên bản đối soát
// doanh thu quý). Không controller: không có giao diện/webhook riêng. Lệnh CLI: `settlement-csv`,
// `rev-share`. Không job lịch trong `deploy/onprem/jobs.json`.
// @Global + export `SETTLEMENT_HOOKS`: `MarketApiCommand` (nhóm market) nhận cửa nối quyết toán mà
// không phải import module này — thiếu provider thì lệnh đó báo [blocked] exit 2, 0 request.
@Global()
@Module({
  providers: [
    SettlementCsvCommand,
    RevShareCommand,
    { provide: SETTLEMENT_HOOKS, useValue: settlementHooks() },
  ],
  exports: [SETTLEMENT_HOOKS],
})
export class SettlementModule {}
