import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPath } from '../paths.js';
import golden from './__fixtures__/pii.golden.json' with { type: 'json' };
import { decodeArg, sameAsGolden } from './golden.js';
import {
  flattenParen,
  identityResidual,
  maskIdentity,
  maskPii,
  NAMES_CHECK_MS,
  namesCacheClear,
  scrubUser,
  setNamesClock,
  setNamesFiles,
} from './pii.js';

// Golden: đầu vào = mọi lời gọi pii.* mà test Python (test_zalo/test_v13_*/test_v14_p1/test_v15_p9/
// test_channels/test_llm_gateway/test_guardrail*) thực hiện, đầu ra = hàm Python THẬT với cấu hình
// mặc định (data/vn_names.json + vn_provinces_2025.json).
type Case = { fn: string; args: unknown[]; kwargs: Record<string, unknown>; out?: unknown };

const FN: Record<string, (...a: unknown[]) => unknown> = {
  mask_pii: (t) => maskPii(t as string),
  flatten_paren: (t) => flattenParen(t as string),
  mask_identity: (t, allow) => maskIdentity(t, (allow as Iterable<unknown>) ?? []),
  scrub_user: (t) => scrubUser(t),
  identity_residual: (t) => identityResidual(t),
};

describe('pii ↔ Python (golden)', () => {
  const cases = (golden as Case[]).filter((c) => 'out' in c);

  it.each(Object.keys(FN))('%s khớp từng ca', (fn) => {
    const mine = cases.filter((c) => c.fn === fn);
    expect(mine.length).toBeGreaterThan(5);
    const bad = mine.filter((c) => !sameAsGolden(FN[fn](...c.args.map(decodeArg)), c.out));
    expect(bad.map((c) => JSON.stringify(c.args).slice(0, 160))).toEqual([]);
  });
});

describe('pii: biên regex (AGENTS.md Gotcha)', () => {
  it('không ăn giá / khoảng giá / ngày; che SĐT nhiều dạng', () => {
    expect(maskPii('giá 10.050.000.000 đồng')).toBe('giá 10.050.000.000 đồng');
    expect(maskPii('50.000.000 - 100.000.000')).toBe('50.000.000 - 100.000.000');
    expect(maskPii('84 - 100.000.000')).toBe('84 - 100.000.000');
    expect(maskPii('(1.500.000)(2.000.000)')).toBe('(1.500.000)(2.000.000)');
    expect(maskPii('ngày 05.10.2026')).toBe('ngày 05.10.2026');
    expect(maskPii('gọi 0901 234 567 nhé')).toBe('gọi *** nhé');
    expect(maskPii('+84 (90) 123 4567')).not.toMatch(/\d{3}/);
    expect(maskPii('(0901) - (234) - (567)')).not.toMatch(/\d/);
    expect(maskPii('mail a.b+c@ex-ample.com.vn')).toBe('mail ***');
  });

  it('sha256 hex có dãy giống SĐT bị che y Python (khóa fp chain_alert, r22 A3)', () => {
    // Kỳ vọng = pipelines.pii._mask_pii THẬT (Python) trên cùng chuỗi.
    expect(maskPii('4d5775af4d885d729cb5638f43f38b85828d0397554326314dc04ffa15f91e43')).toBe(
      '4d5775af4d885d729cb5638f43f38b85828d***dc04ffa15f91e43',
    );
    expect(maskPii('c588c20645d0b85bb8425698524368a2f616f3e9ba3879b8fc3d745492bc4815')).toBe(
      'c588c20645d0b85bb***a2f616f3e9ba3879b8fc3d745492bc4815',
    );
  });

  it('đầu vào bệnh lý chạy tuyến tính (không DoS)', () => {
    const probes = [
      '('.repeat(100_000),
      `${'('.repeat(26)}x(0901) - (234) - (567)`,
      'x'.repeat(200_000),
      `${'a'.repeat(300)}@${'b'.repeat(300)}.com`,
      ' '.repeat(100_000),
      `ship về 9${' '.repeat(50_000)}9`,
      '0'.repeat(100_000),
      '(0901) - '.repeat(5_000),
    ];
    for (const p of probes) {
      const t0 = performance.now();
      maskPii(p);
      scrubUser(p);
      maskIdentity(p);
      expect(performance.now() - t0, p.slice(0, 30)).toBeLessThan(5_000);
    }
    // Cạn ngân sách: đuôi còn '(' thành '***', không lọt raw.
    expect(maskPii(`${'('.repeat(26)}x(0901) - (234) - (567)`)).not.toMatch(/0901|234|567/);
    expect(flattenParen('('.repeat(50_000))[1]).toBe(true);
  });
});

describe('pii: từ điển tên fail-closed + tự phục hồi (v15 P9.3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-names-'));
  const names = join(dir, 'vn_names.json');
  afterEach(() => {
    setNamesFiles({ names: dataPath('vn_names.json') });
    setNamesClock(null);
  });

  it('thiếu/hỏng → mọi câu có chữ là còn dấu hiệu; sửa file → phục hồi sau chu kỳ kiểm', () => {
    let now = 0;
    setNamesClock(() => now);
    setNamesFiles({ names });
    expect(scrubUser('cho mình hỏi giá')).toEqual(['cho mình hỏi giá', true]);
    expect(scrubUser('12345')[1]).toBe(false); // không có chữ → không chặn oan
    writeFileSync(names, '{hỏng');
    now += NAMES_CHECK_MS + 1;
    expect(scrubUser('cho mình hỏi giá')[1]).toBe(true);
    writeFileSync(names, readFileSync(dataPath('vn_names.json')));
    expect(scrubUser('cho mình hỏi giá')[1]).toBe(true); // chưa tới chu kỳ kiểm
    now += NAMES_CHECK_MS + 1;
    expect(scrubUser('cho mình hỏi giá')).toEqual(['cho mình hỏi giá', false]);
    rmSync(dir, { recursive: true, force: true });
    namesCacheClear();
  });
});
