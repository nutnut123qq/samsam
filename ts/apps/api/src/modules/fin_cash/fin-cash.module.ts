import { Module, type OnModuleInit } from '@nestjs/common';
import { setFinSources } from '../fin_ar_pnl/fin-director.js';
import { FpCashCommand, FpOpscostCommand, ScenarioCommand } from './fin-cash.command.js';
import { finSources } from './fin-sources.js';

// Nhóm fin_cash: `pipelines/scenario.py` (engine kịch bản mùa dùng chung — intel-06, sales-07.3),
// `agents/fp_cash.py` (dòng tiền 13 tuần — finance-05.2), `agents/fp_opscost.py` (chi phí vận hành so
// trần + khoản > X chờ TGĐ ký — finance-05.1). Không controller: không giao diện/webhook riêng (duyệt
// qua hàng duyệt chung, báo cáo file). Lệnh CLI: `scenario`, `fp-cash`, `fp-opscost`. Không job lịch.
// Khởi động: nối nguồn FP-OpsCost/FP-Cash vào bản tin tuần GĐ tài chính (`fin_director`, nhóm
// fin_ar_pnl) — chưa nối thì mục đó "(chưa có dữ liệu)" (fail-closed).
@Module({ providers: [ScenarioCommand, FpCashCommand, FpOpscostCommand] })
export class FinCashModule implements OnModuleInit {
  onModuleInit(): void {
    setFinSources(finSources);
  }
}
