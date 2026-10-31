import 'reflect-metadata';
import { wireCore } from '@samsam/core/ops/wire';
import type { Command } from 'commander';
import { CommandFactory, CommandRunnerService } from 'nest-commander';
import { CliModule, cliErrorHandler, cliExitOverride } from './cli.module.js';

// Lệnh CLI (nest-commander) thay `python -m …` — danh sách ở cli.module.ts.
// Nối core không pool (rollout đọc sổ qua DATABASE_URL như Python, AI bị chặn); lệnh mở pool riêng
// mà cần AI/cổng trên pool đó thì gọi lại `wireCore(pool)` trong run().
wireCore(null);

const app = await CommandFactory.createWithoutRunning(CliModule, {
  logger: ['error', 'warn'],
  errorHandler: cliErrorHandler,
});
try {
  const runner = app.get(CommandRunnerService);
  cliExitOverride((runner as unknown as { commander: Command }).commander, cliErrorHandler);
  await CommandFactory.runApplication(app);
} finally {
  await app.close();
}
