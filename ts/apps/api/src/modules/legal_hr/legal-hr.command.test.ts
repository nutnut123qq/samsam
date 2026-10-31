import 'reflect-metadata';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { CommandFactory } from 'nest-commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegalHrModule } from './legal-hr.module.js';

// Lệnh nest-commander của nhóm legal_hr nhận đúng cờ/giá trị như argparse của Python (exit code qua
// process.exitCode). Không DB: chỉ đường dry-run / không submit / tham số sai.

async function cli(...args: string[]): Promise<{ code: unknown; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const lo = vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  const le = vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
  const argv = process.argv;
  process.argv = ['node', 'cli', ...args];
  process.exitCode = undefined;
  try {
    const app = await CommandFactory.runWithoutClosing(LegalHrModule, { logger: false });
    await app.close();
    return { code: process.exitCode, out, err };
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    lo.mockRestore();
    le.mockRestore();
  }
}

describe('lệnh CLI legal_hr', () => {
  afterEach(() => {
    settings.forceMode = null;
  });

  it('contract-check --kind --file: mẫu đủ điều khoản → exit 0; kind lạ → exit 2', async () => {
    const ok = await cli(
      'contract-check',
      '--kind',
      'koc',
      '--file',
      repoPath('docs/legal/mau-hop-dong-koc-NHAP.md'),
    );
    expect(ok.code).toBe(0);
    expect(ok.out[0]).toMatch(/^\[ok\] đủ 9 điều khoản bắt buộc \(koc\)/);
    const bad = await cli('contract-check', '--kind', 'ncc', '--file', 'x.md');
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toContain('invalid choice');
  });

  it('pc-hr --jd --dry-run → exit 0 (không connect); --attendance thiếu --month → exit 2', async () => {
    settings.forceMode = 'van_hanh';
    const a = await cli('pc-hr', '--jd', 'nv_cskh', '--dry-run');
    expect(a.code).toBe(0);
    expect(a.out.join('\n')).toMatch(/\[dry-run\] hr_jd `jd:nv_cskh:[0-9a-f]{12}`/);
    const b = await cli('pc-hr', '--attendance', 'x.csv');
    expect(b.code).toBe(2);
    expect(b.err[0]).toContain('cần --month YYYY-MM');
  });

  it('xnqc: --today với thao tác ghi → exit 2; --draft không --submit in nháp, exit 0', async () => {
    const a = await cli('xnqc', '--list', '--today', '2030-01-01');
    expect(a.code).toBe(2);
    expect(a.err[0]).toContain('--today chỉ đi với --remind/--sync-golden');
    const b = await cli(
      'xnqc',
      '--draft',
      '--sku',
      'savina-12v',
      '--loai',
      'maket',
      '--ten',
      'maket fb',
    );
    expect(b.code).toBe(0);
    expect(b.out.join('\n')).toContain('# NHÁP hồ sơ XNQC — Savina tuýp 12 viên ngậm');
  });
});
