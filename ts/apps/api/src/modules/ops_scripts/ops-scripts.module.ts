import { Module } from '@nestjs/common';
import {
  BreakGlassCommand,
  DbBackupCommand,
  DrDrillCommand,
  OnpremPreflightCommand,
  RetentionPurgeCommand,
  ReviewLoadCommand,
} from './ops-scripts.command.js';

// Nhóm ops_scripts: `scripts/db_backup.py` (data_platform-07.2 backup hằng ngày + bằng chứng DB),
// `scripts/dr_drill.py` (diễn tập DR, dùng lõi `db_restore_drill.run_drill` port ở restore-drill.ts),
// `scripts/retention_purge.py` (v13.4 C05 hạn lưu), `scripts/onprem_preflight.py` (r13
// data_platform-90), `scripts/break_glass.py` (v3.10 đóng băng), `scripts/review_load.py` (PC-A0).
// Không controller: không có giao diện/webhook riêng. Lệnh CLI: `db-backup`, `dr-drill`,
// `retention-purge`, `onprem-preflight`, `break-glass`, `review-load`. Job lịch (deploy/onprem/
// jobs.json): `backup` (= `db-backup`, login svc_backup qua BACKUP_DATABASE_URL), `dr_drill`
// (= `dr-drill`, login quản trị DATABASE_URL); `restore_drill` giữ bước Python
// (`scripts/db_restore_drill.py` — KE_HOACH mục 3).
@Module({
  providers: [
    DbBackupCommand,
    DrDrillCommand,
    RetentionPurgeCommand,
    OnpremPreflightCommand,
    BreakGlassCommand,
    ReviewLoadCommand,
  ],
})
export class OpsScriptsModule {}
