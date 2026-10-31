import { describe, expect, it } from 'vitest';
import G from './__fixtures__/period.golden.json' with { type: 'json' };
import {
  addDays,
  businessDeadline,
  businessMinutes,
  parseDay,
  parseShift,
  periodBounds,
  rollingBounds,
  vnDate,
  vnFormat,
  weekday,
} from './period.js';

// Golden: chạy hàm Python thật (pipelines/period.py) trên đầu vào cố định.
type Out = { ok?: unknown; error?: string; msg?: string };

/** Đầu vào golden → TS: {"d"} = ngày 'YYYY-MM-DD', {"t"} = Date; khác giữ nguyên. */
function inp(v: unknown): unknown {
  if (v && typeof v === 'object' && 'd' in v) return (v as { d: string }).d;
  if (v && typeof v === 'object' && 't' in v) return new Date((v as { t: string }).t);
  return v;
}

function run(fn: () => unknown): Out {
  try {
    const r = fn();
    return { ok: r };
  } catch (e) {
    return { error: (e as Error).name, msg: (e as Error).message };
  }
}

const ms = (iso: unknown) => Date.parse(iso as string);

// KHÁC Python có chủ đích (biểu diễn): TS dùng chuỗi 'YYYY-MM-DD' làm "date" → chuỗi ngày hợp lệ được
// nhận (Python: str → TypeError); JSON không phân biệt 1.0 với 1 → workdays [1.0] được nhận.
const isRawDayString = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

describe('period golden (Python)', () => {
  it('periodBounds khớp từng ca', () => {
    for (const c of G.bounds) {
      if (isRawDayString(c.ref)) continue;
      const got = run(() => periodBounds(c.kind, inp(c.ref) as Date));
      const want = c.out as Out;
      if (want.error) {
        expect(got.msg, JSON.stringify(c)).toBe(want.msg);
      } else {
        const [a, b] = got.ok as [Date, Date];
        const [wa, wb] = want.ok as string[];
        expect([a.getTime(), b.getTime()], JSON.stringify(c)).toEqual([ms(wa), ms(wb)]);
      }
    }
  });

  it('rollingBounds', () => {
    for (const c of G.rolling) {
      const got = run(() => rollingBounds(c.days, inp(c.until) as Date));
      const want = c.out as Out;
      if (want.error) expect(got.msg).toBe(want.msg);
      else {
        const [a, b] = got.ok as [Date, Date];
        expect([a.getTime(), b.getTime()]).toEqual((want.ok as string[]).map(ms));
      }
    }
    const [s, e] = rollingBounds(1);
    expect(e.getTime() - s.getTime()).toBe(86_400_000);
    expect(Math.abs(Date.now() - e.getTime())).toBeLessThan(60_000);
  });

  it('parseShift: lỗi + chuẩn hóa', () => {
    const SHIFT = { start: '08:00', end: '18:00', workdays: [0, 1, 2, 3, 4], holidays: [] };
    for (const c of G.shifts) {
      const cfg = c.mut === null ? (c as { raw: unknown }).raw : { ...SHIFT, ...c.mut };
      const got = run(() => parseShift(cfg));
      const want = c.out as Out;
      if (JSON.stringify(c.mut) === '{"workdays":[1]}' && want.error) continue; // [1.0] trong Python
      if (want.error) expect(got.msg, JSON.stringify(c.mut)).toBe(want.msg);
      else {
        const s = got.ok as ReturnType<typeof parseShift>;
        const w = want.ok as {
          start_min: number;
          end_min: number;
          workdays: number[];
          holidays: string[];
        };
        expect([s.startMin, s.endMin, [...s.workdays].sort(), [...s.holidays].sort()]).toEqual([
          w.start_min,
          w.end_min,
          w.workdays,
          w.holidays,
        ]);
      }
    }
    const s = parseShift(SHIFT);
    expect(parseShift(s)).toBe(s); // idempotent
  });

  it('businessDeadline / businessMinutes', () => {
    for (const c of G.deadlines) {
      const got = run(() => businessDeadline(inp(c.start) as Date, c.hours as number, c.shift));
      const want = c.out as Out;
      if (want.error) expect(got.msg, JSON.stringify(c)).toBe(want.msg);
      else expect((got.ok as Date).getTime(), JSON.stringify(c)).toBe(ms(want.ok));
    }
    for (const c of G.minutes) {
      const got = run(() => businessMinutes(inp(c.a) as Date, inp(c.b) as Date, c.shift));
      const want = c.out as Out;
      if (want.error) expect(got.msg).toBe(want.msg);
      else expect(got.ok, JSON.stringify(c)).toBe(want.ok);
    }
  });

  it('lịch mọi ngày nghỉ → lỗi nhanh (vòng có trần)', () => {
    const t0 = performance.now();
    const hol = Array.from({ length: 60 }, (_, i) =>
      vnDate(new Date(Date.UTC(2026, 9, 12 + 7 * i))),
    );
    expect(() =>
      businessDeadline(new Date('2026-10-12T08:00:00+07:00'), 2, {
        start: '08:00',
        end: '18:00',
        workdays: [0],
        holidays: hol,
      }),
    ).toThrow(/400 ngày/);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('vnFormat theo giờ VN', () => {
    expect(vnFormat(new Date('2026-10-12T17:05:09Z'), '%Y-%m-%d %H:%M:%S %%')).toBe(
      '2026-10-13 00:05:09 %',
    );
  });
});

describe('năm < 100 (Date.UTC đổi 0–99 thành 1900+)', () => {
  // Python: date(1,1,1).weekday() == 0; date(99,12,31)+1 == 0100-01-01; 0050-02-28+1 == 0050-03-01.
  it('như Python date', () => {
    expect(parseDay('0001-01-01')).not.toBeNull();
    expect(parseDay('0000-01-01')).toBeNull();
    expect(parseDay('0004-02-29')).not.toBeNull();
    expect(parseDay('0100-02-29')).toBeNull();
    expect(weekday('0001-01-01')).toBe(0);
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(addDays('0050-02-28', 1)).toBe('0050-03-01');
  });
});
