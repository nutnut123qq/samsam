import { SERVICES, type Service, servicePool } from '@samsam/core/db';
import { Command, CommandRunner, Option } from 'nest-commander';

/**
 * Mẫu lệnh CLI (thay `python -m …`): `npm run cli -w @samsam/api -- db-ping --service job`.
 * Kiểm login dịch vụ như auth.bind_service (chế độ thực: superuser/owner/sai role → exit 2).
 */
@Command({ name: 'db-ping', description: 'Kiểm kết nối + login DB của một dịch vụ' })
export class DbPingCommand extends CommandRunner {
  async run(_args: string[], opts: { service: string }): Promise<void> {
    if (!Object.hasOwn(SERVICES, opts.service)) {
      console.error(`[err] dịch vụ lạ '${opts.service}' (${Object.keys(SERVICES).join('|')})`);
      process.exitCode = 2;
      return;
    }
    const service = opts.service as Service;
    let pool: Awaited<ReturnType<typeof servicePool>>;
    try {
      pool = await servicePool(service);
    } catch (e) {
      console.error(`[err] ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    try {
      const r = await pool.query('select session_user as login, current_database() as db');
      console.log(`[ok] ${service}: login=${r.rows[0].login} db=${r.rows[0].db}`);
    } catch (e) {
      console.error(`[err] không truy vấn được (${(e as Error).name})`);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }

  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0, `choices` bị parse đè.
  @Option({ flags: '-s, --service <service>', required: true })
  parseService(v: string): string {
    return v;
  }
}
