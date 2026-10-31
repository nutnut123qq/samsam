import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadData, readJsonFile } from './config.js';
import { dataPath, REPO_ROOT } from './paths.js';

const dir = mkdtempSync(join(tmpdir(), 'samsam-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  it('đọc data/*.json của repo', () => {
    const cfg = loadData(
      'directors/sales.json',
      z.looseObject({ approvers: z.array(z.unknown()) }),
    );
    expect(Array.isArray(cfg.approvers)).toBe(true);
    expect(dataPath('x.json')).toBe(join(REPO_ROOT, 'data', 'x.json'));
  });

  it('thiếu / hỏng / BOM / UTF-8 lỗi / NaN / sai schema → ConfigError (fail-closed)', () => {
    const f = (name: string, body: string | Buffer) => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    };
    expect(() => readJsonFile(join(dir, 'missing.json'))).toThrow('không có file missing.json');
    expect(() => readJsonFile(f('bad.json', '{"a":'))).toThrow(ConfigError);
    expect(() => readJsonFile(f('bom.json', '﻿{"a":1}'))).toThrow(ConfigError);
    expect(() => readJsonFile(f('u8.json', Buffer.from([0x7b, 0xff, 0x7d])))).toThrow(ConfigError);
    expect(() => readJsonFile(f('nan.json', '{"a": NaN}'))).toThrow(ConfigError);
    expect(() => readJsonFile(f('s.json', '{"a":"x"}'), z.object({ a: z.number() }))).toThrow(
      's.json sai cấu trúc',
    );
  });

  it('cache theo mtime/size: sửa file → đọc bản mới; bản cache bị đóng băng', () => {
    const p = join(dir, 'c.json');
    writeFileSync(p, '{"v":1}');
    const a = readJsonFile<{ v: number }>(p);
    expect(a.v).toBe(1);
    expect(Object.isFrozen(a)).toBe(true);
    writeFileSync(p, '{"v":22}');
    expect(readJsonFile<{ v: number }>(p).v).toBe(22);
  });

  it('chặn đường dẫn thoát khỏi data/', () => {
    expect(() => loadData('../.env')).toThrow('đường dẫn ngoài');
    expect(() => dataPath('/etc/passwd')).toThrow('đường dẫn ngoài');
  });
});
