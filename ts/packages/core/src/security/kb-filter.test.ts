import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { dataPath } from '../paths.js';
import golden from './__fixtures__/kb_filter.golden.json' with { type: 'json' };
import { decodeArg } from './golden.js';
import { isAlcohol, KbFilterError, setKbFiles } from './kb-filter.js';

// Golden: mọi lời gọi kb_filter.is_alcohol trong test Python guardrail/pii → hàm Python thật.
type Case = { args: unknown[]; out: boolean };

describe('kb-filter ↔ Python (golden)', () => {
  it('is_alcohol khớp từng ca', () => {
    const bad = (golden as Case[]).filter((c) => isAlcohol(decodeArg(c.args[0])) !== c.out);
    expect(bad.map((c) => JSON.stringify(c.args).slice(0, 120))).toEqual([]);
    expect((golden as Case[]).filter((c) => c.out).length).toBeGreaterThan(20);
  });
});

// Dịch tests/test_kb_filter.py: fail-closed khi keyword file thiếu/rỗng/chỉ comment.
describe('kb-filter fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kbf-'));
  const kw = join(dir, 'kw.txt');
  afterEach(() =>
    setKbFiles({ keywords: dataPath('ruou_keywords.txt'), golden: dataPath('golden_skus.json') }),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['thiếu file', null],
    ['0 byte', ''],
    ['chỉ comment/dòng trắng', '# a\n\n   \n#b\n'],
  ])('%s → KbFilterError (kể cả text không phải chuỗi)', (_n, content) => {
    if (content === null) rmSync(kw, { force: true });
    else writeFileSync(kw, content);
    setKbFiles({ keywords: kw });
    expect(() => isAlcohol('rượu sâm')).toThrow(KbFilterError);
    expect(() => isAlcohol(null)).toThrow(KbFilterError);
  });

  it('golden hỏng → chỉ dùng keyword file; tên SKU rượu nạp từ golden', () => {
    writeFileSync(kw, 'vodka\n');
    const g = join(dir, 'g.json');
    writeFileSync(g, '{hỏng');
    setKbFiles({ keywords: kw, golden: g });
    expect(isAlcohol('Uống VODKA không')).toBe(true);
    expect(isAlcohol('rượu')).toBe(false);
    writeFileSync(g, JSON.stringify({ skus: [{ category: 'alcohol', name: 'Sâm Đỏ No.9' }] }));
    setKbFiles({ golden: g });
    expect(isAlcohol('mua sam do no.9 nhé')).toBe(false); // cụm CÓ dấu chỉ so text có dấu
    expect(isAlcohol('Sâm Đỏ No.9')).toBe(true);
  });

  it('có dấu so trên text gốc, không dấu so bản bỏ dấu; biên từ; không phải chuỗi → false', () => {
    expect(isAlcohol('Rượu sâm Ngọc Linh')).toBe(true);
    expect(isAlcohol('ruou sam')).toBe(true);
    expect(isAlcohol('40% vol')).toBe(true);
    expect(isAlcohol('thuộc')).toBe(false);
    expect(isAlcohol('alcoholism')).toBe(false);
    expect(isAlcohol(42)).toBe(false);
    expect(isAlcohol('')).toBe(false);
  });
});
