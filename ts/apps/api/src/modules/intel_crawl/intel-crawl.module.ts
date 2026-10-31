import { Module } from '@nestjs/common';
import { INTEL_CRAWL_COMMANDS } from './intel-crawl.command.js';

// Lệnh CLI `crawler-intel` (job `intel`, `red_alert_sweep`) + `crawler-collect` — tự mở pool login
// job, không cần PG_POOL; không có REST/webhook (Python không có giao diện). Module khác cần
// collector (vt-thoitiet, seo-web) import `Fetcher` từ `./intel.js`. Bước tích hợp đăng ký
// INTEL_CRAWL_COMMANDS trong CliModule (cli.ts).
@Module({ providers: INTEL_CRAWL_COMMANDS })
export class IntelCrawlModule {}
