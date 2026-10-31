import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import G from './__fixtures__/freeze.golden.json' with { type: 'json' };
import {
  activeWindows,
  type BgRecord,
  check,
  FreezeConfigError,
  isFrozen,
  loadBreakGlass,
  loadCalendar,
  parseBreakGlass,
  validateCalendar,
} from './freeze.js';

type Out = { ok?: unknown; error?: string; msg?: string };

function run(fn: () => unknown): Out {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).name, msg: (e as Error).message };
  }
}

/** Record TS → dạng golden (ISO giữ offset gốc không còn — so theo thời điểm). */
function norm(r: BgRecord): Record<string, unknown> {
  return r.action === 'open'
    ? { ...r, opened_at: r.opened_at.getTime(), expires_at: r.expires_at.getTime() }
    : { ...r, ts: r.ts.getTime() };
}
function normWant(r: Record<string, unknown>): Record<string, unknown> {
  const t = (k: string) => (k in r ? { [k]: Date.parse(r[k] as string) } : {});
  return { ...r, ...t('opened_at'), ...t('expires_at'), ...t('ts') };
}

const RAW = Buffer.from(G.bg_lines_b64, 'base64');

describe('freeze golden (Python)', () => {
  it('validateCalendar: mọi ca lỗi/đúng', () => {
    for (const c of G.calendars) {
      const got = run(() => validateCalendar(c.cal));
      const want = c.out as Out;
      if (want.error) expect(got.msg, JSON.stringify(c.cal).slice(0, 200)).toBe(want.msg);
      else expect(got.ok).toEqual(want.ok);
    }
  });

  it('đọc log break-glass: record + dòng bị bỏ', () => {
    const bad: number[] = [];
    const recs = parseBreakGlass(RAW, bad);
    expect(recs.map(norm)).toEqual((G.records as Record<string, unknown>[]).map(normWant));
    expect(bad).toEqual(G.bad_lines);
  });

  it('check: từng (kind, now) khớp thông điệp Python', () => {
    const recs = parseBreakGlass(RAW);
    for (const c of G.checks) {
      const cal = 'cal' in c ? c.cal : G.calendar;
      const got = run(() => check(c.kind, new Date(c.now), cal, recs));
      const want = c.out as Out;
      if (want.error) expect(got.msg, `${c.kind} ${c.now}`).toBe(want.msg);
      else expect(got.ok, `${c.kind} ${c.now}`).toEqual(want.ok);
    }
  });

  it('isFrozen hai đầu khung + activeWindows cắt theo max_hours', () => {
    for (const c of G.frozen) {
      const w = c.when as { d?: string; t?: string } | string;
      if (typeof w === 'string') continue; // TS: chuỗi ngày = date (Python: str → TypeError)
      const got = run(() => isFrozen(w.d ?? new Date(w.t as string), G.calendar));
      expect(got.ok, JSON.stringify(w)).toBe((c.out as Out).ok);
    }
    const recs = parseBreakGlass(RAW);
    for (const c of G.active) {
      const got = activeWindows(recs, new Date(c.now), c.max).map(norm);
      expect(got, `${c.now} ${c.max}`).toEqual(
        ((c.out as Out).ok as Record<string, unknown>[]).map(normWant),
      );
    }
  });
});

describe('freeze biên', () => {
  it('kiểu sai → TypeError; lịch thật không hỏng', () => {
    expect(() => isFrozen(5 as unknown as string, G.calendar)).toThrow(TypeError);
    expect(() => check('feature', '2026-12-25' as unknown as Date, G.calendar, [])).toThrow(
      TypeError,
    );
    expect(loadCalendar().windows.length).toBeGreaterThan(0);
  });

  it('lịch hỏng (thiếu/rỗng/BOM/JSON hỏng/sai cấu trúc) → fail-closed, không ném', () => {
    const d = mkdtempSync(join(tmpdir(), 'freeze-'));
    const cases: [string, string | null][] = [
      ['missing.json', null],
      ['empty.json', ''],
      ['bom.json', '﻿{}'],
      ['bad.json', '{'],
      ['arr.json', '[]'],
      ['nowin.json', '{"windows": []}'],
    ];
    for (const [name, body] of cases) {
      const p = join(d, name);
      if (body !== null) writeFileSync(p, body);
      expect(() => loadCalendar(p)).toThrow(FreezeConfigError);
      // check() nạp lịch mặc định — mô phỏng bằng lịch đã hỏng truyền vào.
    }
    const [ok1] = check('feature', new Date('2026-06-01T00:00:00+07:00'), { windows: [] }, []);
    const [ok2] = check('hotfix', new Date('2026-06-01T00:00:00+07:00'), { windows: [] }, []);
    expect([ok1, ok2]).toEqual([false, true]);
  });

  it('loadBreakGlass: không có file → []; ký tự điều khiển ở `by` → bỏ', () => {
    const d = mkdtempSync(join(tmpdir(), 'bg-'));
    expect(loadBreakGlass(join(d, 'none.jsonl'))).toEqual([]);
    expect(loadBreakGlass(undefined)).toEqual([]);
    const p = join(d, 'bg.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ action: 'open', opened_at: '2026-12-25T14:00:00+07:00', expires_at: '2026-12-25T15:00:00+07:00', by: 'x\u001b[31m' })}\n﻿{"action":"close","ts":"2026-12-25T14:00:00+07:00","by":"a"}\n`,
    );
    const bad: number[] = [];
    expect(loadBreakGlass(p, bad)).toEqual([]);
    expect(bad).toEqual([1, 2]);
  });

  it('BREAK_GLASS_LOG đọc từ env khi không truyền windows', () => {
    const d = mkdtempSync(join(tmpdir(), 'bge-'));
    const p = join(d, 'bg.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ action: 'open', opened_at: '2026-12-25T14:00:00+07:00', expires_at: '2026-12-25T18:00:00+07:00', by: 'Nguyễn A', holder_verified: true })}\n`,
    );
    const now = new Date('2026-12-25T15:00:00+07:00');
    expect(check('feature', now, G.calendar, undefined, { BREAK_GLASS_LOG: p })[0]).toBe(true);
    expect(check('feature', now, G.calendar, undefined, {})[0]).toBe(false);
  });
});
