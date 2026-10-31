import { describe, expect, it } from 'vitest';
import G from './__fixtures__/py-compat.golden.json' with { type: 'json' };
import { CsvReader, csvRows } from './py-csv.js';
import { isoDate } from './py-date.js';
import { PyFloat, parsePyJson, pyFixed, pyFloatStr, pyLoads, pyRound, reprV } from './py-json.js';
import { pgErrName } from './tx.js';

// Golden: chạy Python thật (str(float), f"{x:.nf}", round, date.fromisoformat, psycopg.errors).
const f64 = (hex: string): number => Buffer.from(hex, 'hex').readDoubleBE(0);

describe('ngữ nghĩa Python dùng chung (core ops/py-*) ↔ golden', () => {
  it('pyFloatStr = str(float)', () => {
    for (const [hex, want] of G.float_str) expect(pyFloatStr(f64(hex as string)), want).toBe(want);
    expect([pyFloatStr(Number.NaN), pyFloatStr(Infinity), pyFloatStr(-Infinity)]).toEqual([
      'nan',
      'inf',
      '-inf',
    ]);
  });

  it('pyFixed = f"{x:.nf}", pyRound = round(x, n)', () => {
    for (const [hex, n, fixed, rounded] of G.fixed) {
      const x = f64(hex as string);
      expect(pyFixed(x, n as number), `${x}:${n}`).toBe(fixed);
      expect(pyFloatStr(pyRound(x, n as number)), `${x}:${n}`).toBe(rounded);
    }
  });

  it('isoDate = date.fromisoformat (gồm năm < 100, tuần ISO)', () => {
    for (const [s, want] of G.iso_date) expect(isoDate(s as string), String(s)).toBe(want);
  });

  it('pgErrName = type(e).__name__ của psycopg (lớp riêng / lớp gốc)', () => {
    for (const [code, want] of G.pg_err) expect(pgErrName({ code }), code).toBe(want);
    // Không mang SQLSTATE (mất kết nối giữa chừng, mã hệ thống Node) → OperationalError.
    expect(pgErrName(new Error('Connection terminated unexpectedly'))).toBe('OperationalError');
    expect(pgErrName(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe('OperationalError');
  });

  it('PyFloat: parsePyJson bọc mọi số thực, pyLoads chỉ số nguyên viết dạng thực', () => {
    expect(parsePyJson('[1, 1.5, 2.0]')).toEqual([1, new PyFloat(1.5), new PyFloat(2)]);
    expect(pyLoads('[1, 1.5, 2.0, 1e1]')).toEqual([1, 1.5, new PyFloat(2), new PyFloat(10)]);
    expect([reprV(new PyFloat(14)), reprV(new PyFloat(1e16)), reprV('a')]).toEqual([
      '14.0',
      '1e+16',
      "'a'",
    ]);
  });

  it('csvRows = CsvReader không trần field_size_limit', () => {
    const big = `"${'x'.repeat(131_073)}"\n`;
    expect(() => [...new CsvReader(big)]).toThrow('field larger than field limit (131072)');
    expect(csvRows(big)[0]?.[0]).toHaveLength(131_073);
    expect(csvRows('a,"b\r\nc"\r\n\r\nd')).toEqual([['a', 'b\r\nc'], [], ['d']]);
  });
});
