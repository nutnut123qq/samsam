import { Module } from '@nestjs/common';
import { BksAuditCommand, BksReconCommand, HdtvReportCommand } from './bks-hdtv.command.js';

// Nhóm bks_hdtv: `agents/bks_audit.py` (audit inside-out BKS + `--chain-alert` báo nhật ký bị sửa —
// ceo-04.6), `agents/bks_recon.py` (đối soát độc lập 4 nguồn — ceo-04.6), `agents/hdtv_report.py`
// (gói báo cáo HĐTV tháng/quý vào hàng duyệt khối ceo — ceo-05). Không controller: không giao
// diện/webhook riêng (báo cáo file + hàng duyệt chung). Lệnh CLI: `bks-audit`, `bks-recon`,
// `hdtv-report`. Job lịch (deploy/onprem/jobs.json): `chain_watch` = `bks-audit --chain-alert`,
// `hdtv_month` = `hdtv-report --month prev --submit`.
@Module({ providers: [BksAuditCommand, BksReconCommand, HdtvReportCommand] })
export class BksHdtvModule {}
