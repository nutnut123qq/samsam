import { Module } from '@nestjs/common';
import { SALES_DIRECTOR_COMMANDS } from './sales-director.command.js';

// Lệnh CLI `sales-director` (job `sales_sla`) + `kd-forecast` — tự mở pool login job, không cần
// PG_POOL. Bước tích hợp đăng ký SALES_DIRECTOR_COMMANDS trong CliModule (cli.ts).
@Module({ providers: SALES_DIRECTOR_COMMANDS })
export class SalesDirectorModule {}
