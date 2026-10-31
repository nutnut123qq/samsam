import { Module } from '@nestjs/common';
import { MKT_ADS_COMMANDS } from './mkt-ads.command.js';

// Nhóm mkt_ads: MKT-05 phiếu thử nghiệm ads (`mkt-ads`, marketing-03.1/03.2), FP-AdsBudget
// (`fp-ads`, finance-04.2), MKT-00 GĐ Marketing (`mkt-director`, marketing-01.2). Python không có
// REST/webhook/job lịch — chỉ lệnh CLI tự mở pool (DATABASE_URL như `lead_store.connect`), không cần
// PG_POOL. Bước tích hợp đăng ký MKT_ADS_COMMANDS trong CliModule (cli.ts).
@Module({ providers: MKT_ADS_COMMANDS })
export class MktAdsModule {}
