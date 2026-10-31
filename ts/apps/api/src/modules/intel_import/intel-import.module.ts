import { Module } from '@nestjs/common';
import {
  IntelImportCommand,
  IntelWeeklyCommand,
  SocialVendorCommand,
} from './intel-import.command.js';

// Nhóm intel_import: `ingest/intel_import.py` (nạp file intel nhập tay — marketing-05.1 phân loại
// bình luận, intel-03 đối thủ, intel-04.1 Trends), `ingest/social_vendor.py` (social listening nhà
// cung cấp, cổng TGĐ duyệt) và `scripts/intel_weekly.py` (báo cáo tuần chỉ đọc intel-03/04.1 +
// `--suggest-keywords` intel-04.2). Không controller: Python không có giao diện/webhook riêng (đọc
// báo cáo/hàng duyệt chung). Lệnh CLI: `intel-import`, `social-vendor`, `intel-weekly`; job lịch
// `intel_weekly` (`intel-weekly --out-dir data/reports`), `intel_keywords` (`intel-weekly
// --suggest-keywords`).
@Module({ providers: [IntelImportCommand, SocialVendorCommand, IntelWeeklyCommand] })
export class IntelImportModule {}
