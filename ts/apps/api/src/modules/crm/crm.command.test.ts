import 'reflect-metadata';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandFactory } from 'nest-commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrmModule } from './crm.module.js';

// Lệnh nest-commander nhận đúng cờ/giá trị như argparse của Python (`--status LEAD STATE` 2 giá
// trị, `--load-dealers [PATH]` tùy chọn, `--add-contact -` = stdin); exit code qua process.exitCode.

async function cli(...args: string[]): Promise<{ code: unknown; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const lo = vi.spyOn(console, 'log').mockImplementation((s) => void out.push(String(s)));
  const le = vi.spyOn(console, 'error').mockImplementation((s) => void err.push(String(s)));
  const argv = process.argv;
  process.argv = ['node', 'cli', ...args];
  process.exitCode = undefined;
  try {
    const app = await CommandFactory.runWithoutClosing(CrmModule, { logger: false });
    await app.close();
    return { code: process.exitCode, out, err };
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    lo.mockRestore();
    le.mockRestore();
  }
}

describe('lệnh CLI crm / lead-store', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('--status cần đúng 2 giá trị; STATE lạ → exit 2', async () => {
    expect((await cli('crm', '--status', '1', '--by', 'Lan')).code).toBe(2);
    const r = await cli('crm', '--status', '1', 'bogus', '--by', 'Lan');
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatch(/^crm: error: --status LEAD STATE/);
  });

  it('--load-dealers PATH hỏng → exit 2; không PATH → file mặc định, DB thiếu → exit 1', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'crm-cmd-')), 'r.json');
    writeFileSync(p, '{');
    const a = await cli('crm', '--load-dealers', p, '--by', 'Lan');
    expect([a.code, a.out]).toEqual([
      2,
      ['[err] r.json: không đọc được (JSONDecodeError) — không ghi gì.'],
    ]);
    delete process.env.DATABASE_URL;
    const b = await cli('crm', '--load-dealers', '--by', 'Lan');
    expect(b.code).toBe(1);
    expect(b.out.join('\n')).toContain('DB không truy cập được');
  });

  it('host DB chết → exit 1, không treo', async () => {
    process.env.DATABASE_URL = 'postgresql://u@127.0.0.1:9/x';
    const r = await cli('crm', '--report');
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toContain('DB không truy cập được');
  });

  it('--add-contact - nhận "-" là stdin; thiếu khóa vault → exit 2 trước khi đọc', async () => {
    process.env.CONTACT_VAULT_KEY = '';
    const r = await cli('crm', '--add-contact', '-', '--by', 'Lan');
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toContain('CONTACT_VAULT_KEY');
  });

  it('lead-store chế độ thực thiếu LOADER_DATABASE_URL → exit 2', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.JOB_DATABASE_URL;
    delete process.env.LOADER_DATABASE_URL;
    process.env.APPROVAL_ENFORCE = '1';
    const r = await cli('lead-store');
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toContain('LOADER_DATABASE_URL');
  });
});
