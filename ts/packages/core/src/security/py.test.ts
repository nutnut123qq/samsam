import { describe, expect, it } from 'vitest';
import chars from './__fixtures__/chars.golden.json' with { type: 'json' };
import { fold, hoiNga, stripLen } from './guardrail.js';
import { foldKeep } from './pii.js';
import {
  casefold,
  cpIndexer,
  isDigit,
  isUpper,
  pyRepr,
  pySplit,
  pyStr,
  splitlines,
  stripAccents,
} from './py.js';

// Golden từng ký tự (Latin/Việt/Hy Lạp/Kirin/toàn khổ/Cherokee/toán học/emoji/CJK tương thích…)
// sinh bằng Python 3.12: guardrail._fold_char/_strip_char/_hoi_nga, pii._fold_ch,
// llm_gateway._strip_accents, str.casefold/isupper/isdigit.
type C = {
  c: string;
  g_fold: string;
  g_strip: string;
  hoi_nga: string;
  p_fold: string;
  strip_accents: string;
  casefold: string;
  isupper: boolean;
  isdigit: boolean;
};

// Khác biệt CÓ CHỦ ĐÍCH: Python đếm code point nên fold astral → 1 ký tự BMP vẫn "giữ độ dài";
// JS giữ độ dài UTF-16 nên giữ ký tự gốc (shortcut ghi ở guardrail.ts/pii.ts). Guardrail vẫn bắt
// chữ toán học nhờ `prep` (đổi NFKC trước khi fold) — kiểm ở guardrail.test.ts.
const astralToBmp = (c: string, py: string) => c.length === 2 && py.length === 1;

describe('py.ts / fold từng ký tự ↔ Python', () => {
  it('khớp mọi ký tự mẫu (trừ astral → BMP, có lý do)', () => {
    const bad: string[] = [];
    for (const x of chars as C[]) {
      const cp = x.c.codePointAt(0)?.toString(16);
      const want: [string, unknown, unknown][] = [
        ['g_fold', fold(x.c), x.g_fold],
        ['g_strip', stripLen(x.c), x.g_strip],
        ['hoi_nga', hoiNga(x.c), x.hoi_nga],
        ['p_fold', foldKeep(x.c), x.p_fold],
        ['strip_accents', stripAccents(x.c), x.strip_accents],
        ['casefold', casefold(x.c), x.casefold],
        ['isupper', isUpper(x.c), x.isupper],
        ['isdigit', isDigit(x.c), x.isdigit],
      ];
      for (const [k, got, py] of want) {
        if (got === py) continue;
        if (typeof py === 'string' && astralToBmp(x.c, py) && got === x.c) continue;
        bad.push(`${cp} ${k}: ${JSON.stringify(got)} != ${JSON.stringify(py)}`);
      }
    }
    expect(bad).toEqual([]);
    expect((chars as C[]).length).toBeGreaterThan(1500);
  });

  it('split/splitlines/repr/str như Python', () => {
    expect(pySplit('\u00a0a\u2003b\x1cc\ufeffd ')).toEqual(['a', 'b', 'c\ufeffd']);
    expect(splitlines('a\r\nb\x1cc\u2028d\n')).toEqual(['a', 'b', 'c', 'd']);
    expect(pyRepr("it's")).toBe('"it\'s"');
    expect(pyRepr('a\u200bb\n')).toBe("'a\\u200bb\\n'");
    expect(pyStr(['savina-12v', null, true, 1])).toBe("['savina-12v', None, True, 1]");
    const u = cpIndexer('\u{1f33f}a\u{1f33f}');
    expect([u(0), u(2), u(3), u(5)]).toEqual([0, 1, 2, 3]);
  });
});
