import { Command, CommandRunner, Option } from 'nest-commander';
import { backupMain } from './backup.js';
import { type BreakGlassOpts, breakGlassMain } from './break-glass.js';
import { type DrOpts, drMain } from './dr-drill.js';
import { type PreflightOpts, preflightMain } from './onprem-preflight.js';
import { type RetentionOpts, retentionMain } from './retention-purge.js';
import { type ReviewLoadOpts, reviewLoadMain } from './review-load.js';

// Lệnh CLI thay `python scripts/db_backup.py` / `retention_purge.py` / `onprem_preflight.py` /
// `break_glass.py` / `review_load.py` / `dr_drill.py` — cùng cờ, exit code, thông điệp chính. Hàm
// `*Main` trả exit code (test gọi thẳng); lớp Command chỉ nối. Kiểm tham số trong `*Main` (lỗi ném
// trong hàm parse của nest-commander thoát 0). Cấu hình đọc từ biến môi trường TIẾN TRÌNH (không .env).

const str = (v: string) => v;

@Command({
  name: 'db-backup',
  description:
    'Sao lưu Postgres (pg_dump snapshot + manifest + offsite + bằng chứng DB) — env BACKUP_*',
})
export class DbBackupCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await backupMain();
  }
}

@Command({
  name: 'retention-purge',
  description:
    'Xóa file dữ liệu cá nhân quá hạn lưu theo data/retention.json (TTL null = chưa chốt, không xóa)',
})
export class RetentionPurgeCommand extends CommandRunner {
  async run(_a: string[], o: RetentionOpts): Promise<void> {
    process.exitCode = await retentionMain(o);
  }
  @Option({ flags: '--dry-run', description: 'chỉ đếm, không ghi log, không xóa' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'onprem-preflight',
  description: 'Kiểm SẴN SÀNG hạ tầng on-prem trên chính máy chạy lệnh (chỉ đo, không sửa gì)',
})
export class OnpremPreflightCommand extends CommandRunner {
  async run(_a: string[], o: PreflightOpts): Promise<void> {
    process.exitCode = await preflightMain(o);
  }
  @Option({ flags: '--out <file>', description: 'ghi bảng kết quả .md' })
  parseOut(v: string): string {
    return str(v);
  }
  @Option({
    flags: '--min-free-gb <n>',
    description: 'dung lượng trống tối thiểu BACKUP_DIR (mặc định 50)',
  })
  parseMinFreeGb(v: string): string {
    return str(v);
  }
  @Option({
    flags: '--max-backup-age-h <n>',
    description: 'tuổi tối đa bản backup gần nhất (mặc định 26)',
  })
  parseMaxBackupAgeH(v: string): string {
    return str(v);
  }
}

@Command({
  name: 'break-glass',
  description:
    'Break-glass — mở cửa sổ ngoại lệ CÓ HẠN trong đóng băng (log BREAK_GLASS_LOG ngoài repo)',
})
export class BreakGlassCommand extends CommandRunner {
  async run(_a: string[], o: BreakGlassOpts): Promise<void> {
    process.exitCode = await breakGlassMain(o);
  }
  @Option({ flags: '--open' })
  parseOpen(): boolean {
    return true;
  }
  @Option({ flags: '--status' })
  parseStatus(): boolean {
    return true;
  }
  @Option({ flags: '--close' })
  parseClose(): boolean {
    return true;
  }
  @Option({ flags: '--reason <text>' })
  parseReason(v: string): string {
    return str(v);
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return str(v);
  }
  @Option({ flags: '--hours <n>', description: '1..break_glass_max_hours (mặc định 2)' })
  parseHours(v: string): string {
    return str(v);
  }
}

@Command({
  name: 'review-load',
  description: 'PC-A0 — tải hàng duyệt so với quota (chỉ đọc, chỉ nhắc)',
})
export class ReviewLoadCommand extends CommandRunner {
  async run(_a: string[], o: ReviewLoadOpts): Promise<void> {
    process.exitCode = await reviewLoadMain(o);
  }
  @Option({ flags: '--today <yyyy-mm-dd>', description: 'mặc định hôm nay giờ VN' })
  parseToday(v: string): string {
    return str(v);
  }
  @Option({ flags: '--days <n>', description: 'cửa sổ 1..366 ngày (mặc định 7)' })
  parseDays(v: string): string {
    return str(v);
  }
  @Option({ flags: '--quota <path>', description: 'mặc định data/review_quota.json' })
  parseQuota(v: string): string {
    return str(v);
  }
}

@Command({
  name: 'dr-drill',
  description:
    'Diễn tập DR trên Postgres docker tạm (image có sẵn, không pull) — đo RTO/RPO, luôn dọn',
})
export class DrDrillCommand extends CommandRunner {
  async run(_a: string[], o: DrOpts): Promise<void> {
    process.exitCode = await drMain(o);
  }
  @Option({ flags: '--backup <manifest>', description: 'đường dẫn manifest (mặc định: mới nhất)' })
  parseBackup(v: string): string {
    return str(v);
  }
}
