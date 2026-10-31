import { connectDatabaseUrl, type DbLease } from '@samsam/core/db';
import { pyInt } from '@samsam/core/ops/py';
import { type RedAlertCliOpts, redAlertCli } from '@samsam/core/ops/red-alert';
import { Command, CommandRunner, Option } from 'nest-commander';

type Opts = Omit<RedAlertCliOpts, 'after'> & { after?: string };

/** `red-alert` thay `python -m pipelines.red_alert` (job `red_alert_sweep` bước 3 `--deliver`,
 * `red_alert_escalate` `--escalate`). Kết nối DATABASE_URL như Python `connect()`. */
@Command({
  name: 'red-alert',
  description:
    'Cảnh báo đỏ: --check-routing | --deliver | --escalate [--dry-run [--after ID]] | --ack ID --by | --open',
})
export class RedAlertCommand extends CommandRunner {
  async run(_args: string[], o: Opts): Promise<void> {
    // argparse type=int: giá trị không phải số nguyên → NaN → redAlertCli báo sai tham số (exit 2).
    const after = o.after === undefined ? undefined : Number(pyInt(o.after) ?? Number.NaN);
    let lease: DbLease | null = null;
    try {
      process.exitCode = await redAlertCli({ ...o, after }, async () => {
        lease = await connectDatabaseUrl();
        return lease?.db ?? null;
      });
    } finally {
      await (lease as DbLease | null)?.release();
    }
  }

  @Option({
    flags: '--check-routing',
    description: 'kiểm người nhận + kênh gửi (exit 1 khi thiếu)',
  })
  parseCheckRouting(): boolean {
    return true;
  }
  @Option({ flags: '--deliver', description: 'gửi lại cảnh báo chưa gửi được (48 giờ)' })
  parseDeliver(): boolean {
    return true;
  }
  @Option({ flags: '--escalate', description: 'leo thang cảnh báo gốc quá 2 giờ chưa xác nhận' })
  parseEscalate(): boolean {
    return true;
  }
  @Option({ flags: '--ack <id>', description: 'xác nhận cảnh báo gốc (cần --by)' })
  parseAck(v: string): string {
    return v;
  }
  @Option({ flags: '--open', description: 'liệt kê cảnh báo gốc chưa xác nhận' })
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
  @Option({ flags: '--dry-run', description: 'chỉ xem trước --escalate, không ghi' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({
    flags: '--after <id>',
    description: 'trang cảnh báo tồn (id >), với --escalate --dry-run',
  })
  parseAfter(v: string): string {
    return v;
  }
}
