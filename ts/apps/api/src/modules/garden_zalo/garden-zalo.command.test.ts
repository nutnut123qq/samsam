import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GardenZaloModule } from './garden-zalo.module.js';

// Lệnh nest-commander nhận đúng cờ/giá trị như argparse của Python (exit code qua process.exitCode).

async function cli(...args: string[]): Promise<{ code: unknown; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const lo = vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  const le = vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
  const argv = process.argv;
  process.argv = ['node', 'cli', ...args];
  process.exitCode = undefined;
  try {
    const app = await CommandFactory.runWithoutClosing(GardenZaloModule, { logger: false });
    await app.close();
    return { code: process.exitCode, out, err };
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    lo.mockRestore();
    le.mockRestore();
  }
}

describe('lệnh CLI garden_zalo', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('garden --check khi không có DB → [warn] exit 0; --gap-days sai → exit 2', async () => {
    delete process.env.DATABASE_URL;
    const a = await cli('garden', '--check');
    expect(a.code).toBe(0);
    expect(a.out[0]).toMatch(/^\[warn\] chưa nạp/);
    const b = await cli('garden', '--check', '--gap-days', 'abc');
    expect(b.code).toBe(2);
    expect(b.err[0]).toContain("invalid int value: 'abc'");
  });

  it('zalo-garden / garden-media / garden-media-mkt: sai tham số → exit 2', async () => {
    expect((await cli('zalo-garden', '--done', '1', '--by', 'A')).code).toBe(2);
    expect((await cli('zalo-garden', '--pending', '--hash')).code).toBe(2);
    const m = await cli('garden-media', '--file', 'x');
    expect(m.code).toBe(2);
    expect(m.err[0]).toContain('--plot, --date, --by');
    expect((await cli('garden-media-mkt', '--list', '--get', 'abc')).code).toBe(2);
    process.env.GARDEN_STT_PROVIDER = 'none';
    const t = await cli('zalo-garden', '--transcribe', '1');
    expect(t.code).toBe(2);
    expect(t.err[0]).toMatch(/^\[blocked\]/);
  });
});
