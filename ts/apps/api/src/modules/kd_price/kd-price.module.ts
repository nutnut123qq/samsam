import { Module } from '@nestjs/common';
import { KD_PRICE_COMMANDS } from './kd-price.command.js';

// Nhóm kd_price: KD-A5 giám sát giá & KM (`kd-price`, job `price_watch` + `dealer_price_watch`), phương
// án giá combo (`combo-price`), nạp giá đại lý quan sát tay (`dealer-price`). Python không có REST/
// webhook — chỉ lệnh CLI tự mở pool (DATABASE_URL / login dịch vụ job|loader), không cần PG_POOL.
// Bước tích hợp đăng ký KD_PRICE_COMMANDS trong CliModule (cli.ts).
@Module({ providers: KD_PRICE_COMMANDS })
export class KdPriceModule {}
