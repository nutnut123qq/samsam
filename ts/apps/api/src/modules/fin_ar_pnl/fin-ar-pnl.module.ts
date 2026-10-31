import { Module } from '@nestjs/common';
import {
  AccArCommand,
  AccInvoiceCommand,
  FinDirectorCommand,
  FpPnlCommand,
} from './fin-ar-pnl.command.js';

// Nhóm fin_ar_pnl (khối finance): `agents/acc_ar.py` (công nợ đại lý + nháp thư nhắc nợ — finance-03.1,
// finance-03.3), `agents/acc_invoice.py` (lô hóa đơn NHÁP — finance-02), `agents/fp_pnl.py` (giá vốn
// + P&L — finance-04.1), `agents/fin_director.py` (bản tin tuần GĐ tài chính — finance-05.1 phần bản
// tin). Không controller: không có giao diện/webhook riêng (duyệt qua hàng duyệt chung, báo cáo file).
// Lệnh CLI: `acc-ar`, `acc-invoice`, `fp-pnl`, `fin-director`; job lịch `invoice_batch` =
// `acc-invoice --batch`.
@Module({ providers: [AccArCommand, AccInvoiceCommand, FpPnlCommand, FinDirectorCommand] })
export class FinArPnlModule {}
