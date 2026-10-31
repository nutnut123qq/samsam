import { Command, CommandRunner, Option } from 'nest-commander';
import { type DaPmoOpts, daPmoMain } from './da-pmo.js';
import { type HealthOpts, healthMain } from './health-bulletin.js';
import { type OpsIncidentsOpts, opsIncidentsMain } from './ops-incidents.js';
import { type OpsMonthlyOpts, opsMonthlyMain } from './ops-monthly.js';

// Lệnh CLI thay `python -m agents.da_pmo` / `python -m pipelines.ops_incidents` /
// `python scripts/ops_monthly.py` / `python scripts/health_bulletin.py` — cùng cờ, exit code, thông
// điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ nối. Kiểm tham
// số trong `*Main` (lỗi ném trong hàm parse của nest-commander thoát 0, `choices` bị parse đè).

const str = (v: string) => v;

@Command({
  name: 'da-pmo',
  description: 'DA-01 sổ mốc + bảng tuần tiến độ (khối ceo, không tự gửi)',
})
export class DaPmoCommand extends CommandRunner {
  async run(_a: string[], o: DaPmoOpts): Promise<void> {
    process.exitCode = await daPmoMain(o);
  }
  @Option({ flags: '--seed' })
  parseSeed(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--set-status <code>' })
  parseSetStatus(v: string): string {
    return str(v);
  }
  @Option({ flags: '--status <status>', description: 'chua_bat_dau|dang_lam|xong|tam_dung' })
  parseStatus(v: string): string {
    return str(v);
  }
  @Option({ flags: '--evidence <ref>' })
  parseEvidence(v: string): string {
    return str(v);
  }
  @Option({ flags: '--board' })
  parseBoard(): boolean {
    return true;
  }
  @Option({ flags: '--date <yyyy-mm-dd>' })
  parseDate(v: string): string {
    return str(v);
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return str(v);
  }
  @Option({ flags: '--submit' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--propose-due <code>' })
  parseProposeDue(v: string): string {
    return str(v);
  }
  @Option({ flags: '--due <yyyy-mm-dd>' })
  parseDue(v: string): string {
    return str(v);
  }
  @Option({ flags: '--apply-due <queue_id>' })
  parseApplyDue(v: string): string {
    return str(v);
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return str(v);
  }
}

@Command({ name: 'ops-incidents', description: 'Sổ sự cố vận hành (PL02 mục 2)' })
export class OpsIncidentsCommand extends CommandRunner {
  async run(_a: string[], o: OpsIncidentsOpts): Promise<void> {
    process.exitCode = await opsIncidentsMain(o);
  }
  @Option({ flags: '--open', description: 'ghi sự cố mới' })
  parseOpen(): boolean {
    return true;
  }
  @Option({ flags: '--event <id>', description: 'ghi mốc phản hồi/sửa/xử lý khách cho sự cố ID' })
  parseEvent(v: string): string {
    return str(v);
  }
  @Option({ flags: '--list', description: 'liệt kê + SLA' })
  parseList(): boolean {
    return true;
  }
  @Option({ flags: '--title <t>' })
  parseTitle(v: string): string {
    return str(v);
  }
  @Option({ flags: '--severity <s>', description: 'nghiem_trong|thuong' })
  parseSeverity(v: string): string {
    return str(v);
  }
  @Option({ flags: '--source <s>' })
  parseSource(v: string): string {
    return str(v);
  }
  @Option({ flags: '--ben <b>', description: 'ben_a|ben_b|chua_xac_dinh' })
  parseBen(v: string): string {
    return str(v);
  }
  @Option({ flags: '--detected-at <iso>' })
  parseDetectedAt(v: string): string {
    return str(v);
  }
  @Option({ flags: '--occurred-at <iso>' })
  parseOccurredAt(v: string): string {
    return str(v);
  }
  @Option({ flags: '--kind <k>', description: 'responded|fixed|customer_resolved|note' })
  parseKind(v: string): string {
    return str(v);
  }
  @Option({ flags: '--at <iso>' })
  parseAt(v: string): string {
    return str(v);
  }
  @Option({ flags: '--note <n>' })
  parseNote(v: string): string {
    return str(v);
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return str(v);
  }
  @Option({ flags: '--month <yyyy-mm>', description: 'YYYY-MM cho --list (mặc định tháng này)' })
  parseMonth(v: string): string {
    return str(v);
  }
}

@Command({
  name: 'ops-monthly',
  description: 'Báo cáo vận hành tháng gửi Bên B (PL02 mục 3) — chỉ đọc, không tự gửi',
})
export class OpsMonthlyCommand extends CommandRunner {
  async run(_a: string[], o: OpsMonthlyOpts): Promise<void> {
    process.exitCode = await opsMonthlyMain(o);
  }
  @Option({ flags: '--month <m>', description: 'YYYY-MM | prev (tháng trước, giờ VN)' })
  parseMonth(v: string): string {
    return str(v);
  }
  @Option({ flags: '--snapshot', description: 'chụp dữ kiện chat không PII từ convlog vào DB' })
  parseSnapshot(): boolean {
    return true;
  }
  @Option({
    flags: '--mark-sent <yyyy-mm>',
    description: 'NGƯỜI GỬI xác nhận đã gửi báo cáo tháng cho Bên B',
  })
  parseMarkSent(v: string): string {
    return str(v);
  }
  @Option({ flags: '--file <path>', description: 'bản báo cáo đã gửi' })
  parseFile(v: string): string {
    return str(v);
  }
  @Option({ flags: '--by <name>', description: 'tên người đã gửi' })
  parseBy(v: string): string {
    return str(v);
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return str(v);
  }
}

@Command({
  name: 'health-bulletin',
  description: 'Bản tin sức khỏe hệ thống (chỉ số SQL, không LLM)',
})
export class HealthBulletinCommand extends CommandRunner {
  async run(_a: string[], o: HealthOpts): Promise<void> {
    process.exitCode = await healthMain(o);
  }
  @Option({ flags: '--out-dir <dir>', description: 'thư mục ghi bản tin (mặc định data/reports)' })
  parseOutDir(v: string): string {
    return str(v);
  }
  @Option({
    flags: '--date <yyyy-mm-dd>',
    description: 'nhãn ngày bản tin (số liệu luôn tính lúc chạy)',
  })
  parseDate(v: string): string {
    return str(v);
  }
  @Option({ flags: '--notify', description: 'gửi qua kênh cấu hình HEALTH_NOTIFY (mặc định tắt)' })
  parseNotify(): boolean {
    return true;
  }
}
