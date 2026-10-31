import { Module } from '@nestjs/common';
import { ContractCheckCommand } from './contract-check.js';
import { PcHrCommand } from './pc-hr.command.js';
import { XnqcCommand } from './xnqc.command.js';

// Nhóm legal_hr (khối Pháp chế – nhân sự): `agents/pc_hr.py` (legal_hr-06.1/06.2/06.3 mô tả công
// việc, sàng lọc hồ sơ, chấm công), `agents/xnqc.py` (legal_hr-02 soạn nháp hồ sơ XNQC, legal_hr-03.2
// đồng bộ xnqc_status golden + sổ hồ sơ), `scripts/contract_check.py` (legal_hr-05.1 hợp đồng mẫu
// KOC/đại lý). Không controller: không có giao diện/webhook riêng — mục hàng duyệt duyệt ở tab
// "Duyệt & Lịch" chung. Lệnh CLI: `pc-hr`, `xnqc`, `contract-check`. Không job lịch.
@Module({ providers: [PcHrCommand, XnqcCommand, ContractCheckCommand] })
export class LegalHrModule {}
