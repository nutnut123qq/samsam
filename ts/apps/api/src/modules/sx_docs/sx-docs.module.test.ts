import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductDossiersCommand, SxLabelCommand } from './sx-docs.command.js';
import { SX_DOCS_COMMANDS, SxDocsModule } from './sx-docs.module.js';

// Module dựng được (không cần PG_POOL/AI_GATEWAY — lệnh tự mở kết nối), lớp Command nối đúng *Main.

describe('SxDocsModule', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('dựng module + 4 lệnh', async () => {
    const mod = await Test.createTestingModule({ imports: [SxDocsModule] }).compile();
    expect(SX_DOCS_COMMANDS).toHaveLength(4);
    for (const C of SX_DOCS_COMMANDS) expect(mod.get(C)).toBeInstanceOf(C);
    await mod.close();
  });

  it('lệnh đặt exit code của *Main (product-dossiers sổ repo → 2 BLOCKED; sx-label thiếu --sku → 2)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await new ProductDossiersCommand().run([], { check: true });
    expect(process.exitCode).toBe(2);
    expect(log.mock.calls.flat().join('\n')).toContain('[blocked]');
    process.exitCode = undefined;
    await new SxLabelCommand().run([], { text: 'x.txt' });
    expect(process.exitCode).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toContain('--sku');
  });
});
