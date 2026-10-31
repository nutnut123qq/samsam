import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import gold from './__fixtures__/kb_gaps.golden.json' with { type: 'json' };
import { clusterKey, collect, kbGapsMain, render } from './kb-gaps.js';

// Dịch từ tests/test_kb_gaps.py — cụm NO_DATA bằng luật (0 LLM: module không import AI Gateway),
// convlog BYTES-safe, che PII lần nữa, escape `|`/HTML, nhãn sức khỏe/rượu. Golden sinh từ
// scripts/kb_gaps.py THẬT.

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-gaps-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeGold = () => {
  for (const [fn, hex] of Object.entries(gold.files))
    writeFileSync(join(dir, fn), Buffer.from(hex, 'hex'));
};
const rec = (q: unknown, o: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-10-01T00:00:00Z',
    msg_id: '',
    user_hash: 'u1',
    question: q,
    answered: false,
    ...o,
  });

describe('kb-gaps golden', () => {
  it.each(gold.cluster_key)('clusterKey %#', (c) => expect(clusterKey(c.in)).toBe(c.out));

  it('collect + render khớp Python (2 file convlog, dòng hỏng/U+2028/PII/HTML/nhãn)', () => {
    writeGold();
    const groups = collect(dir);
    expect(groups).toEqual(gold.groups);
    expect(render(groups, 1)).toBe(gold.render1);
    expect(render(groups, 2)).toBe(gold.render2);
    expect(render(groups, 99)).toBe(gold.render99);
  });
});

describe('kb-gaps', () => {
  it('thiếu file → "0 câu", exit 0', () => {
    let out = '';
    expect(kbGapsMain({}, { dataDir: dir, print: (s) => (out += s) })).toBe(0);
    expect(out).toContain('0 câu');
  });

  it('SĐT đã che, | trong câu đã escape (đúng 6 cột)', () => {
    writeFileSync(
      join(dir, 'conversations.jsonl'),
      `${rec('Gọi 0905123456 | báo giá sỉ')}\n${rec('Gọi 0905 123 456 | báo giá sỉ', { user_hash: 'u2' })}\n`,
    );
    const out = render(collect(dir), 2);
    expect(out).not.toContain('0905');
    expect(out).not.toMatch(/\d{9,}/);
    const row = out.split('\n').find((l) => l.startsWith('| 1 |')) ?? '';
    expect(row.split(' | ').length - 1).toBe(5);
  });

  it('--min/--out ghi atomic; --min 0 / không phải số → exit 2', () => {
    writeFileSync(
      join(dir, 'conversations.jsonl'),
      [rec('câu một'), rec('câu một', { user_hash: 'u2' }), rec('câu hai')].join('\n'),
    );
    const out = join(dir, 'gaps.md');
    const quiet = { dataDir: dir, print: () => {}, err: () => {} };
    expect(kbGapsMain({ min: '2', out }, quiet)).toBe(0);
    const body = readFileSync(out, 'utf8');
    expect(body).toContain('câu một');
    expect(body).not.toContain('câu hai');
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(kbGapsMain({ min: '1', out }, quiet)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('câu hai');
    expect(kbGapsMain({ min: '0' }, quiet)).toBe(2);
    expect(kbGapsMain({ min: 'abc' }, quiet)).toBe(2);
    expect(kbGapsMain({ min: ' 3 ' }, quiet)).toBe(0); // Python int(" 3 ") hợp lệ
  });

  // Khác Python có chủ đích: JSON.parse từ chối NaN/Infinity (Python json.loads nhận) → dòng đó
  // tính là hỏng, không vào cụm.
  it('TS chặt hơn: dòng có NaN → bỏ như dòng hỏng', () => {
    writeFileSync(
      join(dir, 'conversations.jsonl'),
      `${rec('NaN test').replace('"msg_id":""', '"msg_id":NaN')}\n`,
    );
    expect(collect(dir)).toEqual([]);
  });
});
