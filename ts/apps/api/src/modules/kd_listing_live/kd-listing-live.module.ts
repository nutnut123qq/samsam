import { Module } from '@nestjs/common';
import { KD_LISTING_LIVE_COMMANDS } from './kd-listing-live.command.js';

// Lệnh CLI `kd-listing` (job `listing_watch`), `listing-export`, `kd-live` — tự mở pool, không cần
// PG_POOL. Không có REST/webhook (agent chỉ đọc + nháp; người tải tệp/duyệt ở nơi khác). Bước tích hợp
// đăng ký KD_LISTING_LIVE_COMMANDS trong CliModule (cli.ts).
@Module({ providers: KD_LISTING_LIVE_COMMANDS })
export class KdListingLiveModule {}
