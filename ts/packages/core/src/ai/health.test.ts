import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import health from './__fixtures__/health.golden.json' with { type: 'json' };
import strip from './__fixtures__/strip_accents.golden.json' with { type: 'json' };
import uni from './__fixtures__/unicode.golden.json' with { type: 'json' };
import { isHealthQuestion } from './health.js';
import { casefold, hasAlpha, stripAccents } from './text.js';

// Golden sinh bằng hàm Python thật (`pipelines/llm_gateway.is_health_question`, `_strip_accents`,
// casefold/`\w`/isalpha/`\d` của Python 3.12 — unicodedata 15.0) trên chuỗi cố định.

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Mọi mã đã gán ở Unicode 15.0 (tập của Python — Node 22 là Unicode 16, mã mới không xét). */
function assigned(): string[] {
  const out: string[] = [];
  for (const [a, b] of uni.assigned_ranges)
    for (let c = a; c <= b; c++) out.push(String.fromCodePoint(c));
  return out;
}

describe('unicode như Python 3.12', () => {
  const all = assigned();
  it('casefold / stripAccents / \\w / isalpha / \\d từng mã', () => {
    expect(sha(all.map(casefold).join(''))).toBe(uni.casefold_sha);
    expect(sha(all.map(stripAccents).join(''))).toBe(uni.strip_accents_sha);
    expect(sha(all.map((c) => (/^[\p{L}\p{N}_]$/u.test(c) ? '1' : '0')).join(''))).toBe(
      uni.word_sha,
    );
    expect(sha(all.map((c) => (hasAlpha(c) ? '1' : '0')).join(''))).toBe(uni.alpha_sha);
    expect(sha(all.map((c) => (/^\p{Nd}$/u.test(c) ? '1' : '0')).join(''))).toBe(uni.digit_sha);
  });
  it('stripAccents ca cố định', () => {
    for (const [s, want] of strip) expect(stripAccents(s), s).toBe(want);
  });
});

describe('isHealthQuestion = Python', () => {
  it(`${health.length} ca golden`, () => {
    const bad = health.filter(([s, want]) => isHealthQuestion(s) !== want).map(([s]) => s);
    expect(bad).toEqual([]);
  });
  it('ca tiêu biểu (test_llm_gateway.py)', () => {
    expect(isHealthQuestion('bị gout uống Savigout được không')).toBe(true);
    expect(isHealthQuestion('tôi bị tiểu đường'.normalize('NFD'))).toBe(true);
    expect(isHealthQuestion('tiể\u200bu đường dùng được không')).toBe(true);
    expect(isHealthQuestion('sản phẩm này thuộc loại nào')).toBe(false);
    expect(isHealthQuestion('Giao hàng ở Ho Chi Minh mất mấy ngày')).toBe(false);
    expect(isHealthQuestion(null)).toBe(false);
  });
  it('đầu vào bệnh lý chạy tuyến tính', () => {
    const t0 = performance.now();
    isHealthQuestion('Ba tôi bi tieu duong '.repeat(10000));
    isHealthQuestion('b\u200bi\u200b'.repeat(20000));
    isHealthQuestion('('.repeat(100000));
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
});
