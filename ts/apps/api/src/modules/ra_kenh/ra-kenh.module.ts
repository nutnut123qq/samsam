import { Module } from '@nestjs/common';
import { RaKenhCommand } from './ra-kenh.command.js';

// Nhóm ra_kenh: `agents/ra_kenh.py` — legal_hr-04 (PC-A4 rà bài kênh sở hữu: file xuất tay, nguồn
// tự thu web/listing/Fanpage → ticket gỡ/sửa 24h, `--mark-removed` qua function `*_human`, báo cáo
// Pháp chế tuần) + marketing-04.2 (`--partner-file` rà bài KOC/đại lý). Không controller: Python
// không có giao diện/webhook riêng (duyệt qua hàng duyệt chung). Lệnh CLI: `ra-kenh`; job lịch
// `channel_scan` (bước `ra-kenh --scan-auto`, sau `crawler.collect`).
@Module({ providers: [RaKenhCommand] })
export class RaKenhModule {}
