import { jobRun } from '@samsam/core/ops/job-runs';
import { cliEntry } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import { type GardenDirectorOpts, gardenDirectorMain } from './garden-director.js';
import { type VtOpts, vtThoitietMain } from './vt-thoitiet.js';
import { type VtThuhoachOpts, vtThuhoachMain } from './vt-thuhoach.js';

// Lệnh CLI thay Python (kiểm tham số trong *Main — lỗi parse của nest-commander thoát 0):
//   garden-director ← python -m agents.garden_director
//   vt-thoitiet     ← python -m agents.vt_thoitiet   (ghi job_runs 'agents.vt_thoitiet')
//   vt-thuhoach     ← python -m agents.vt_thuhoach   (ghi job_runs 'agents.vt_thuhoach')
// DB: DATABASE_URL như Python (`lead_store.connect()`): login của người chạy lệnh — quyết định
// --purge-sample/--adopt-plot/--mark-reminded cần login người riêng (runbook mục 9.7).
// Cổng TẮT lọt tới đỉnh (writeReport) → `[rollout]` exit 2 (cliEntry).

@Command({
  name: 'garden-director',
  description:
    'Agent GĐ vùng trồng — bản tin tuần, nhắc lịch/gap, kiểm hash chain nhật ký, gỡ dữ liệu mẫu (người ký)',
})
export class GardenDirectorCommand extends CommandRunner {
  async run(_a: string[], o: GardenDirectorOpts): Promise<void> {
    process.exitCode = await cliEntry(gardenDirectorMain)(o);
  }
  @Option({
    flags: '--bulletin',
    description: 'ghi bản tin tuần data/reports/garden-week-<until>.md',
  })
  parseBulletin(): boolean {
    return true;
  }
  @Option({ flags: '--remind', description: 'in danh sách nhắc lịch/gap (không ghi gì)' })
  parseRemind(): boolean {
    return true;
  }
  @Option({ flags: '--submit', description: '--remind: khoảnh VẪN bỏ trống → báo GĐ vùng trồng' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--verify', description: 'kiểm hash chain plot_logs (exit 1 nếu có vấn đề)' })
  parseVerify(): boolean {
    return true;
  }
  @Option({ flags: '--precheck', description: 'đếm dữ liệu mẫu + blocker (chỉ đọc)' })
  parsePrecheck(): boolean {
    return true;
  }
  @Option({
    flags: '--purge-sample',
    description: 'gỡ dữ liệu mẫu vườn — CHỈ GĐ vùng trồng, cần --by',
  })
  parsePurgeSample(): boolean {
    return true;
  }
  @Option({
    flags: '--adopt-plot <id>',
    description: 'GĐ vùng trồng ký nhận khoảnh mẫu thành khoảnh thật',
  })
  parseAdoptPlot(x: string): string {
    return x;
  }
  @Option({ flags: '--reminders', description: 'đợt nhắc đang mở — chỉ đọc' })
  parseReminders(): boolean {
    return true;
  }
  @Option({
    flags: '--mark-reminded <id>',
    description: 'NGƯỜI đánh dấu đã nhắc nhân viên (kênh thủ công)',
  })
  parseMarkReminded(x: string): string {
    return x;
  }
  @Option({ flags: '--by <name>', description: 'tên người ký (gỡ mẫu / nhận khoảnh / đã nhắc)' })
  parseBy(x: string): string {
    return x;
  }
  @Option({
    flags: '--until <day>',
    description: 'YYYY-MM-DD ngày cuối kỳ (mặc định HÔM QUA giờ VN)',
  })
  parseUntil(x: string): string {
    return x;
  }
  @Option({ flags: '--days <n>' })
  parseDays(x: string): string {
    return x;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(x: string): string {
    return x;
  }
  @Option({ flags: '--schedule <path>' })
  parseSchedule(x: string): string {
    return x;
  }
}

@Command({
  name: 'vt-thoitiet',
  description: 'VT cảnh báo thời tiết & sâu bệnh — digest nội bộ, không gửi/đăng gì',
})
export class VtThoitietCommand extends CommandRunner {
  async run(_a: string[], o: VtOpts): Promise<void> {
    process.exitCode = await jobRun('agents.vt_thoitiet', async (run) => {
      const rc = await cliEntry(vtThoitietMain)(o);
      run.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--digest' })
  parseDigest(): boolean {
    return true;
  }
  @Option({
    flags: '--pests',
    description: 'CHỈ cảnh báo sâu bệnh từ nhật ký nội bộ (farming-05.4)',
  })
  parsePests(): boolean {
    return true;
  }
  @Option({ flags: '--from-csv <file>' })
  parseFromCsv(x: string): string {
    return x;
  }
  @Option({ flags: '--fetch', description: 'dự báo qua collector (chỉ khi fetch.enabled)' })
  parseFetch(): boolean {
    return true;
  }
  @Option({ flags: '--max-requests <n>' })
  parseMaxRequests(x: string): string {
    return x;
  }
  @Option({ flags: '--submit', description: 'đẩy digest vào hàng duyệt khối farming' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--date <day>', description: 'YYYY-MM-DD (ngày VN)' })
  parseDate(x: string): string {
    return x;
  }
}

@Command({
  name: 'vt-thuhoach',
  description:
    'VT dự báo thu hoạch theo khoảnh + sẵn hàng theo lô (khoảng thấp–cơ sở–cao, KHÔNG phải cam kết)',
})
export class VtThuhoachCommand extends CommandRunner {
  async run(_a: string[], o: VtThuhoachOpts): Promise<void> {
    process.exitCode = await jobRun('agents.vt_thuhoach', async (run) => {
      const rc = await cliEntry(vtThuhoachMain)(o);
      run.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--date <day>', description: 'ngày as_of (giờ VN)' })
  parseDate(x: string): string {
    return x;
  }
  @Option({ flags: '--weeks <n>' })
  parseWeeks(x: string): string {
    return x;
  }
  @Option({ flags: '--submit', description: 'đẩy bản dự báo vào hàng duyệt khối farming' })
  parseSubmit(): boolean {
    return true;
  }
}
