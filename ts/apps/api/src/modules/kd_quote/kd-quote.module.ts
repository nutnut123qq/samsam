import { Module } from '@nestjs/common';
import { DaB2bCommand, KdCatalogCommand, KdQuoteCommand } from './kd-quote.command.js';

// Nhóm kd_quote (tính năng sales-05 "Báo giá B2B quà Tết"): `agents/kd_quote.py` (báo giá + nhắc chốt
// đơn), `agents/da_b2b.py` (tổ chức tiềm năng), `agents/kd_catalog.py` (catalog). Không controller:
// không có giao diện/webhook riêng (form B2B ở nhóm channels; duyệt qua hàng duyệt chung). Lệnh CLI:
// `kd-quote`, `da-b2b`, `kd-catalog`; job lịch `b2b_followups` = `kd-quote --followups`.
@Module({ providers: [KdQuoteCommand, DaB2bCommand, KdCatalogCommand] })
export class KdQuoteModule {}
