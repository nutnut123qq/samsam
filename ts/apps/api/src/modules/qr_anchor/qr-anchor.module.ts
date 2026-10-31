import { Module } from '@nestjs/common';
import { AnchorCommand, QrTraceCommand } from './qr-anchor.command.js';

// Nhóm qr_anchor: `pipelines/qr_trace.py` (farming-03.1 nối lô ↔ nhật ký thu hoạch, farming-03.2
// trang/tem QR) + `pipelines/anchor.py` (farming-06 neo blockchain). Python không có REST/webhook —
// chỉ lệnh CLI `qr-trace`, `anchor` (đăng ký ở CliModule, bước tích hợp); job lịch `anchor_build`
// (deploy/onprem/jobs.json) = `anchor --build`.
@Module({ providers: [QrTraceCommand, AnchorCommand] })
export class QrAnchorModule {}
