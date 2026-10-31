import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { catalog } from '@samsam/core/rollout/rollout';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as di from './doc-intake.js';
import { FakeDb, makePdf } from './sx-docs.testing.js';

// Python 3.12 `intake_dir.rglob("*")`: scandir một thư mục con lỗi (EACCES/EPERM) → bỏ thư mục đó, lô chạy
// tiếp (pathlib `_WildcardSelector`/`Path.walk(on_error=None)` nuốt OSError). Windows không chmod được thư
// mục → giả lỗi readdirSync cho thư mục tên `locked` (tệp riêng vì vi.mock áp cả tệp test).
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readdirSync: ((p: fs.PathLike, o?: unknown) => {
      if (String(p).endsWith('locked')) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), {
          code: 'EACCES',
          errno: -13,
          syscall: 'scandir',
        });
      }
      return real.readdirSync(p, o as never);
    }) as typeof real.readdirSync,
  };
});

const TMP = fs.mkdtempSync(join(tmpdir(), 'sxdocs-walk-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
  installFakeDeps({}, { quick: 'van_hanh', stages: {}, catalog: catalog() as { id: string }[] });
});
afterEach(() => resetOpsDeps());

it('thư mục con không đọc được → bỏ qua, các tệp khác vẫn nạp (không ném khỏi intake)', async () => {
  const intakeDir = join(TMP, 'intake');
  fs.mkdirSync(join(intakeDir, 'giay_tiep_nhan'), { recursive: true });
  fs.mkdirSync(join(intakeDir, 'locked'), { recursive: true });
  fs.writeFileSync(join(intakeDir, 'giay_tiep_nhan', 'a.pdf'), makePdf(['So: 1234/2024/DKSP']));
  fs.writeFileSync(join(intakeDir, 'locked', 'b.pdf'), makePdf(['x']));
  expect(() => fs.readdirSync(join(intakeDir, 'locked'))).toThrow(/EACCES/);
  const log: string[] = [];
  const c = await di.intake(intakeDir, join(TMP, 'orig'), new FakeDb().db, 'none', {
    env: { NODE_ENV: 'test' },
    log: (s) => log.push(s),
  });
  expect([c.new, c.error, c.skipped]).toEqual([1, 0, 0]);
});
