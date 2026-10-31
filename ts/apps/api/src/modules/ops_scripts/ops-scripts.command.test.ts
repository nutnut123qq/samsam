import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFactory } from 'nest-commander';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { OpsScriptsModule } from './ops-scripts.module.js';

// Lệnh nest-commander của nhóm ops_scripts nhận đúng cờ như argparse của Python (exit code qua
// process.exitCode). Không DB: chỉ đường usage / chưa cấu hình / TTL chưa chốt.

const root = mkdtempSync(join(tmpdir(), 'ops-cmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const VARS = ['BACKUP_DIR', 'BREAK_GLASS_LOG', 'DR_RPO_MAX_HOURS'];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function cli(...args: string[]): Promise<{ code: unknown; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const lo = vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  const le = vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
  const argv = process.argv;
  process.argv = ['node', 'cli', ...args];
  process.exitCode = undefined;
  try {
    const app = await CommandFactory.runWithoutClosing(OpsScriptsModule, { logger: false });
    await app.close();
    return { code: process.exitCode, out: out.join('\n'), err: err.join('\n') };
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    lo.mockRestore();
    le.mockRestore();
  }
}

describe('lệnh CLI ops_scripts', () => {
  it('db-backup / dr-drill thiếu BACKUP_DIR → exit 2 [usage] (không connect, không docker)', async () => {
    delete process.env.BACKUP_DIR;
    const a = await cli('db-backup');
    expect(a.code).toBe(2);
    expect(a.out).toContain('[usage] thiếu BACKUP_DIR');
    const b = await cli('dr-drill', '--backup', join(root, 'x.manifest.json'));
    expect(b.code).toBe(2);
    expect(b.out).toContain('[usage] thiếu BACKUP_DIR');
  });

  it('retention-purge --dry-run: TTL repo chưa chốt → [blocked] exit 0', async () => {
    const r = await cli('retention-purge', '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[blocked] chưa mục nào được chốt hạn lưu — không xóa gì');
  });

  it('break-glass: không thao tác → 2; --open đủ cờ → 0 + 1 dòng log; --status → 0', async () => {
    process.env.BREAK_GLASS_LOG = join(root, 'bg.jsonl');
    expect((await cli('break-glass')).code).toBe(2);
    const o = await cli(
      'break-glass',
      '--open',
      '--reason',
      'Sự cố webhook cần đổi cấu hình',
      '--by',
      'Người Thử',
      '--hours',
      '1',
    );
    expect(o.code).toBe(0);
    expect(o.out).toContain('BREAK-GLASS mở tới');
    expect(readFileSync(join(root, 'bg.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect((await cli('break-glass', '--status')).code).toBe(0);
    expect((await cli('break-glass', '--status', '--hours', '2')).code).toBe(2);
  });

  it('review-load / onprem-preflight tham số sai → exit 2', async () => {
    const r = await cli('review-load', '--days', '0');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--days phải trong 1..366');
    expect((await cli('review-load', '--today', '2026-13-01')).code).toBe(2);
    const p = await cli('onprem-preflight', '--max-backup-age-h', '0');
    expect(p.code).toBe(2);
    expect(p.err).toContain('ngưỡng không hợp lệ');
  });
});
