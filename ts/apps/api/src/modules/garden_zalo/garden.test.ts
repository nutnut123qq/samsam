import { HumanDenied } from '@samsam/core/security/auth';
import { describe, expect, it } from 'vitest';
import golden from './__fixtures__/garden.golden.json' with { type: 'json' };
import {
  ACTIVITY_VOCAB,
  addLog,
  addLogHuman,
  anomalyCheck,
  coerceTs,
  flagsFor,
  fold,
  gardenMain,
  normalizeActivity,
} from './garden.js';

// Dịch tests/test_garden.py (fake conn) + golden từ agents/garden.py thật.

const S_DT = new Date(Date.UTC(2026, 9, 9, 8, 30));
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0));
const day = 86_400_000;

// KHÁC Python có chủ đích (chặt hơn): dạng tuần ISO bị từ chối.
const TS_STRICTER = new Set(['2026-W41-5']);

describe('golden agents/garden.py', () => {
  it('fold', () => {
    for (const [s, want] of golden.fold) expect(fold(s as string), s as string).toBe(want);
  });
  it('normalize_activity', () => {
    for (const [s, want] of golden.normalize) expect(normalizeActivity(s), String(s)).toEqual(want);
  });
  it('_coerce_ts', () => {
    for (const [s, want] of golden.coerce_ts) {
      const got = coerceTs(s)?.getTime() ?? null;
      expect(got, s as string).toBe(TS_STRICTER.has(s as string) ? null : want);
    }
    expect(coerceTs(new Date(Number.NaN))).toBeNull();
    expect(coerceTs(S_DT)).toBe(S_DT);
    expect(coerceTs(null)).toBeNull();
  });
  it('flags_for chỉ quét detail', () => {
    for (const [a, d, want] of golden.flags)
      expect(flagsFor(a as string, d), String(d)).toEqual(want);
  });
});

type Call = [string, unknown[]];
function fakeDb(routes: [string[], unknown[] | ((p: unknown[]) => unknown[])][] = []) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push([sql, params]);
      for (const [subs, rows] of routes) {
        if (subs.every((s) => sql.includes(s)))
          return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      throw new Error(`no route: ${sql}`);
    },
  };
}
const errDb = (code: string, message = 'x') => ({
  async query() {
    throw Object.assign(new Error(message), { code });
  },
});
// biome-ignore lint/suspicious/noExplicitAny: fake Db
const asDb = (x: unknown) => x as any;

describe('add_log', () => {
  it('chuẩn hóa + tham số đúng (strip khoảnh, source manual:garden)', async () => {
    const db = fakeDb([[['insert into plot_logs', 'returning id'], [{ id: '42' }]]]);
    const [lid, warns] = await addLog(asDb(db), ' KV-A01 ', S_DT, 'tuoi nuoc', 'sáng', 'Minh');
    expect(lid).toBe(42n);
    expect(warns).toEqual([]);
    expect(db.calls[0]?.[1]).toEqual(['KV-A01', S_DT, 'tưới', 'sáng', 'Minh', 'manual:garden']);
  });
  it('hoạt động lạ vẫn ghi + cảnh báo; detail/author rỗng → NULL', async () => {
    const db = fakeDb([[['insert into plot_logs'], [{ id: '7' }]]]);
    const [lid, warns] = await addLog(asDb(db), 'KV-A01', S_DT, 'đắp mô', '', '');
    expect(lid).toBe(7n);
    expect(warns.some((w) => w.includes('chưa có trong vocab'))).toBe(true);
    expect(db.calls[0]?.[1].slice(3, 5)).toEqual([null, null]);
  });
  it('từ khóa dấu hiệu → cảnh báo; ts tương lai → cảnh báo (không chặn)', async () => {
    const db = fakeDb([[['insert into plot_logs'], [{ id: '8' }]]]);
    const [, w1] = await addLog(asDb(db), 'KV-A01', S_DT, 'kiểm tra sâu bệnh', 'phát hiện rệp');
    expect(w1.some((w) => w.includes('cần chú ý') && w.includes('rệp'))).toBe(true);
    const [lid, w2] = await addLog(asDb(db), 'KV-A01', new Date(Date.now() + 3 * day), 'tưới');
    expect(lid).toBe(8n);
    expect(w2.some((w) => w.includes('tương lai'))).toBe(true);
  });
  it('FK / trùng → cảnh báo thân thiện, KHÔNG ném', async () => {
    let [lid, warns] = await addLog(asDb(errDb('23503')), 'KV-XX', S_DT, 'tưới');
    expect(lid).toBeNull();
    expect(warns[0]).toContain('không tồn tại');
    [lid, warns] = await addLog(asDb(errDb('23505')), 'KV-A01', S_DT, 'tưới');
    expect(lid).toBeNull();
    expect(warns).toEqual(["đã có nhật ký trùng: KV-A01 2026-10-09 08:30 'tưới'"]);
    await expect(addLog(asDb(errDb('P0001')), 'KV-A01', S_DT, 'tưới')).rejects.toThrow();
  });
  it('đầu vào hỏng → không execute', async () => {
    const db = fakeDb();
    expect(await addLog(asDb(db), '  ', S_DT, 'tưới')).toEqual([null, ['thiếu --plot']]);
    const [lid, w] = await addLog(asDb(db), 'KV-A01', 'not-a-date', 'tưới');
    expect(lid).toBeNull();
    expect(w).toEqual(["ts không hợp lệ: 'not-a-date' (ISO YYYY-MM-DD[THH:MM:SS])"]);
    expect(db.calls).toEqual([]);
  });
});

describe('add_log_human (login người, function plot_log_add_human)', () => {
  it('42501 → HumanDenied; lỗi DB khác → lý do; trùng → cảnh báo', async () => {
    await expect(
      addLogHuman(
        asDb(errDb('42501', 'login không ánh xạ người')),
        'KV-A01',
        S_DT,
        'tưới',
        null,
        'A',
      ),
    ).rejects.toBeInstanceOf(HumanDenied);
    expect(
      await addLogHuman(
        asDb(errDb('P0001', 'khoảnh không active')),
        'KV-A01',
        S_DT,
        'tưới',
        null,
        'A',
      ),
    ).toEqual([null, ['DB từ chối ghi: khoảnh không active']]);
    const [, w] = await addLogHuman(asDb(errDb('23505')), 'KV-A01', S_DT, 'tưới', null, 'A');
    expect(w[0]).toContain('trùng');
    expect(await addLogHuman(asDb(fakeDb()), ' ', S_DT, 'tưới', null, 'A')).toEqual([
      null,
      ['thiếu khoảnh'],
    ]);
    const db = fakeDb([[['plot_log_add_human'], [{ id: '5' }]]]);
    expect(await addLogHuman(asDb(db), 'KV-A01', S_DT, 'TUOI', 'x', 'Bé')).toEqual([5n, []]);
    expect(db.calls[0]?.[1]).toEqual(['KV-A01', S_DT, 'tưới', 'x', 'Bé']);
  });
});

describe('anomaly_check', () => {
  it('đủ nhánh no-logs / gap / keyword', async () => {
    const horizon = new Date(NOW.getTime() - 14 * day);
    const db = fakeDb([
      [
        ['max(ts)'],
        [
          { plot_id: 'KV-A', mx: new Date(NOW.getTime() - 20 * day) },
          { plot_id: 'KV-B', mx: new Date(NOW.getTime() - day) },
        ],
      ],
      [
        ['from plots', "status = 'active'"],
        [
          { id: 'KV-A', loc: 'a' },
          { id: 'KV-B', loc: 'b' },
          { id: 'KV-C', loc: 'c' },
        ],
      ],
      [
        ['order by ts desc'],
        (p) => {
          expect(p).toEqual([horizon]);
          return [
            {
              ts: new Date(NOW.getTime() - 2 * day),
              plot_id: 'KV-A',
              activity: 'kiểm tra sâu bệnh',
              detail: 'phát hiện rệp',
            },
          ];
        },
      ],
    ]);
    const items = await anomalyCheck(asDb(db), 14, NOW);
    const by: Record<string, string[]> = {};
    for (const it of items) by[it.type] = [...(by[it.type] ?? []), it.plot];
    expect(by).toEqual({ gap: ['KV-A'], 'no-logs': ['KV-C'], keyword: ['KV-A'] });
    expect(items.find((i) => i.type === 'gap')?.msg).toBe('KV-A: không có nhật ký 20 ngày');
    expect(items.find((i) => i.type === 'keyword')?.msg).toBe('KV-A: kiểm tra sâu bệnh — rệp');
  });
  it('không bất thường', async () => {
    const db = fakeDb([
      [['max(ts)'], [{ plot_id: 'KV-A', mx: new Date(NOW.getTime() - day) }]],
      [['from plots'], [{ id: 'KV-A', loc: 'a' }]],
      [
        ['order by ts desc'],
        [{ ts: NOW, plot_id: 'KV-A', activity: 'tưới', detail: 'bình thường' }],
      ],
    ]);
    expect(await anomalyCheck(asDb(db), 14, NOW)).toEqual([]);
  });
  it('vocab 8 hoạt động', () => expect(ACTIVITY_VOCAB).toHaveLength(8));
});

describe('CLI garden', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  it('sai tham số → exit 2 (không connect)', async () => {
    const connect = async () => {
      throw new Error('không được connect');
    };
    for (const o of [
      { check: true, plot: 'KV' },
      {},
      { plot: 'KV' },
      { check: true, gapDays: 'abc' },
    ]) {
      const c = io();
      expect(await gardenMain(o, { connect, io: c.io }), JSON.stringify(o)).toBe(2);
    }
  });
  it('--ts chỉ kiểm ở nhánh ghi, sau khi có kết nối (như Python)', async () => {
    // Review vòng 3: `--check --ts rác` Python bỏ qua --ts (exit 0); TS từng báo sai tham số exit 2.
    const c = io();
    expect(
      await gardenMain({ check: true, ts: 'rác' }, { connect: async () => null, io: c.io }),
    ).toBe(0);
    expect(c.out[0]).toMatch(/^\[warn\] chưa nạp/);
    const d = io();
    const bad = { plot: 'KV', activity: 'tưới', ts: '12/10' };
    expect(await gardenMain(bad, { connect: async () => null, io: d.io })).toBe(2);
    expect(d.err[0]).toMatch(/^\[error\] .*không ghi được$/);
    const db = fakeDb([]);
    const e = io();
    const lease = { db: asDb(db), release: async () => {} };
    expect(await gardenMain(bad, { connect: async () => lease, io: e.io })).toBe(2);
    expect(e.err).toEqual(['garden: error: --ts sai định dạng ISO']);
    expect(db.calls).toEqual([]);
  });
  it('--check DB down → [warn] exit 0; ghi khi DB down → exit 2', async () => {
    const c = io();
    expect(await gardenMain({ check: true }, { connect: async () => null, io: c.io })).toBe(0);
    expect(c.out[0]).toMatch(/^\[warn\] chưa nạp/);
    const d = io();
    expect(
      await gardenMain({ plot: 'KV', activity: 'tưới' }, { connect: async () => null, io: d.io }),
    ).toBe(2);
    expect(d.err[0]).toMatch(/không ghi được$/);
  });
  it('ghi thành công / không ghi được', async () => {
    const db = fakeDb([[['insert into plot_logs'], [{ id: '3' }]]]);
    const c = io();
    const lease = { db: asDb(db), release: async () => {} };
    expect(
      await gardenMain(
        { plot: ' KV-A01 ', activity: 'đắp mô', ts: '2026-10-09T08:30:00Z' },
        { connect: async () => lease, io: c.io },
      ),
    ).toBe(0);
    expect(c.out).toEqual([
      "[warn] hoạt động 'đắp mô' chưa có trong vocab — ghi nguyên văn",
      '[done] nhật ký #3: KV-A01 — 2026-10-09 08:30 UTC',
    ]);
    const e = io();
    const bad = { db: asDb(errDb('23503')), release: async () => {} };
    expect(
      await gardenMain({ plot: 'KV', activity: 'tưới' }, { connect: async () => bad, io: e.io }),
    ).toBe(2);
  });
});
