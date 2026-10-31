import { jobRun } from '@samsam/core/ops/job-runs';
import { cliEntry } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import { type IntelAlertOpts, intelAlertMain } from './intel-alert.js';
import { JOB as BULLETIN_JOB, type BulletinOpts, intelBulletinMain } from './intel-bulletin.js';
import { type LegalUpdatesOpts, legalUpdatesMain } from './legal-updates.js';
import { type PersonaSimOpts, personaSimMain } from './persona-sim.js';

// Lệnh CLI thay 4 tệp Python của nhóm (cùng cờ, exit code, thông điệp chính). Logic + kiểm tham số
// nằm ở `*Main(opts, deps)` (test gọi thẳng); lớp Command chỉ nối. Giá trị cờ kiểm ở `*Main` (lỗi
// ném trong hàm parse của nest-commander thoát 0).

/** `python -m pipelines.intel_alert --run | --ack ID --by "Tên" [--note ..] | --open`. */
@Command({
  name: 'intel-alert',
  description:
    'Cảnh báo đỏ intel — luật tất định, leo thang 2 giờ chưa xác nhận (KHÔNG tự gửi/liên hệ ai)',
})
export class IntelAlertCommand extends CommandRunner {
  async run(_a: string[], o: IntelAlertOpts): Promise<void> {
    process.exitCode = await intelAlertMain(o);
  }
  @Option({ flags: '--run', description: 'quét tin mới + leo thang cảnh báo quá 2 giờ' })
  parseRun(): boolean {
    return true;
  }
  @Option({ flags: '--ack <id>', description: 'xác nhận cảnh báo gốc (cần --by)' })
  parseAck(v: string): string {
    return v;
  }
  @Option({ flags: '--open', description: 'liệt kê cảnh báo chưa xác nhận' })
  parseOpen(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>', description: 'tên người xác nhận' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--note <text>', description: 'ghi chú xác nhận' })
  parseNote(v: string): string {
    return v;
  }
}

/** `python scripts/intel_bulletin.py --period day|week [--date YYYY-MM-DD] [--llm] [--suggest]`. */
@Command({
  name: 'intel-bulletin',
  description: 'Bản tin thị trường intel (BẢN NHÁP, không tự gửi)',
})
export class IntelBulletinCommand extends CommandRunner {
  async run(_a: string[], o: BulletinOpts): Promise<void> {
    // Python `__main__`: ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    process.exitCode = await jobRun(BULLETIN_JOB, async (jr) => {
      const rc = await cliEntry(intelBulletinMain)(o);
      jr.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--period <day|week>', description: 'kỳ bản tin (mặc định day)' })
  parsePeriod(v: string): string {
    return v;
  }
  @Option({ flags: '--date <YYYY-MM-DD>', description: 'ngày VN trong kỳ (mặc định hôm nay)' })
  parseDate(v: string): string {
    return v;
  }
  @Option({ flags: '--llm', description: 'tóm tắt AI (chỉ khi llm.enabled = true)' })
  parseLlm(): boolean {
    return true;
  }
  @Option({
    flags: '--suggest',
    description: 'đẩy gợi ý chủ đề vào hàng duyệt (Quản lý MXH duyệt)',
  })
  parseSuggest(): boolean {
    return true;
  }
}

/** `python -m pipelines.legal_updates --submit [--limit N] [--dry-run]`. */
@Command({
  name: 'legal-updates',
  description: 'Văn bản pháp luật mới → hàng duyệt Pháp chế (legal_hr-07)',
})
export class LegalUpdatesCommand extends CommandRunner {
  async run(_a: string[], o: LegalUpdatesOpts): Promise<void> {
    process.exitCode = await cliEntry(legalUpdatesMain)(o);
  }
  @Option({ flags: '--submit', description: 'đẩy văn bản khớp vào hàng duyệt khối legal_hr' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--limit <n>', description: 'trần mục mỗi lần 1..200 (mặc định 20)' })
  parseLimit(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run', description: 'chỉ đếm, không đẩy mục' })
  parseDryRun(): boolean {
    return true;
  }
}

/** `python scripts/persona_sim.py --dry-run [--config F] [--personas F]`. */
@Command({
  name: 'persona-sim',
  description: 'Nghiên cứu giả lập persona (v7.3) — không dự báo doanh số',
})
export class PersonaSimCommand extends CommandRunner {
  async run(_a: string[], o: PersonaSimOpts): Promise<void> {
    process.exitCode = await personaSimMain(o);
  }
  @Option({
    flags: '--dry-run',
    description: 'gateway GIẢ tất định (số giả) — chạy được khi DPIA chưa ký',
  })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--config <file>', description: 'cấu hình (mặc định data/sim_config.json)' })
  parseConfig(v: string): string {
    return v;
  }
  @Option({ flags: '--personas <file>', description: 'persona (mặc định data/personas.json)' })
  parsePersonas(v: string): string {
    return v;
  }
}
