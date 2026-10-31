import { describe, expect, it } from 'vitest';
import * as oi from './ops-incidents.js';

// Dịch phần thuần + CLI không DB của tests/test_v13_c07_ops.py (sổ sự cố): mốc 15 phút / 3 giờ / 3 ngày
// làm việc / 7 ngày; "chưa đo" khi thiếu lúc xảy ra; xử lý khách KHÔNG thay phản hồi kỹ thuật; tham
// số sai exit 2 TRƯỚC connect; --by agent/tương lai → từ chối, không ghi gì.

const SHIFT = { start: '00:00', end: '23:59', workdays: [0, 1, 2, 3, 4], holidays: [] };
const vn = (s: string) => new Date(`${s}+07:00`);
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe('ops_incidents — SLA thuần', () => {
  it('phát hiện/phản hồi/sửa theo PL02 mục 2', () => {
    const det = vn('2026-10-16T16:00:00'); // thứ Sáu
    const at = (ms: number) => new Date(det.getTime() + ms);
    const incs: oi.IncidentRow[] = [
      [1, 't', 'nghiem_trong', 'kuma', 'ben_a', at(-14 * MIN), det],
      [2, 't', 'nghiem_trong', 'kuma', 'ben_a', at(-16 * MIN), det],
      [3, 't', 'thuong', 'khach', 'ben_b', null, det],
      [4, 't', 'thuong', 'khach', 'ben_b', null, det],
      [5, 't', 'nghiem_trong', 'agent', 'ben_a', null, det],
    ];
    const ev: oi.EventRow[] = [
      [1, 'responded', at(2 * H + 59 * MIN)],
      [1, 'fixed', at(7 * D)],
      [2, 'responded', at(3 * H + MIN)],
      [2, 'fixed', at(7 * D + MIN)],
      [3, 'responded', vn('2026-10-21T17:00:00')], // T2,T3,T4 = 3 ngày LV
      [4, 'responded', vn('2026-10-22T09:00:00')], // ngày LV thứ 4
      [5, 'customer_resolved', at(30 * MIN)], // xử lý khách xong KHÔNG thay phản hồi kỹ thuật
    ];
    const r = Object.fromEntries(
      oi.evaluate(incs, ev, SHIFT, at(10 * D)).map((x) => [x.id, x]),
    ) as Record<number, oi.Evaluated>;
    expect([1, 2, 3].map((i) => r[i]?.detect)).toEqual(['ok', 'late', 'unmeasured']);
    expect([1, 2, 3, 4, 5].map((i) => r[i]?.respond)).toEqual(['ok', 'late', 'ok', 'late', 'late']);
    expect([1, 2, 5].map((i) => r[i]?.fix)).toEqual(['ok', 'late', 'late']);
    expect(r[5]?.customer_resolved_at).not.toBeNull();
    const early = oi.evaluate(incs.slice(4), [], SHIFT, at(H));
    expect([early[0]?.respond, early[0]?.fix]).toEqual(['pending', 'pending']);
    expect(oi.summarize(Object.values(r), 'respond', 'thuong')).toEqual({
      ok: 1,
      late: 1,
      pending: 0,
      unmeasured: 0,
    });
  });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe('ops_incidents — CLI', () => {
  const noConnect = async () => {
    throw new Error('connect');
  };
  const OPEN = {
    open: true,
    title: 'Chatbot chậm',
    severity: 'nghiem_trong',
    source: 'kuma',
    ben: 'ben_a',
    detectedAt: '2026-10-16T16:00',
    by: 'Người Trực',
  };

  it.each<[string, oi.OpsIncidentsOpts]>([
    ['không thao tác', {}],
    ['--open --list', { ...OPEN, list: true }],
    ['--open thiếu --by', { ...OPEN, by: undefined }],
    ['--open --title rỗng', { ...OPEN, title: '' }],
    ['--event thiếu --kind', { event: '1', by: 'X' }],
    ['--event không phải số', { event: 'abc', kind: 'note', by: 'X' }],
    ['--severity lạ', { ...OPEN, severity: 'nhe' }],
    ['--ben lạ', { ...OPEN, ben: 'ben_c' }],
    ['--kind lạ', { event: '1', kind: 'da_xong', by: 'X' }],
    ['--list --month sai', { list: true, month: '10/2026' }],
  ])('%s → exit 2 TRƯỚC connect', async (_n, o) => {
    const s = io();
    expect(await oi.opsIncidentsMain(o, { io: s.io, connect: noConnect })).toBe(2);
    expect(s.err[0]).toMatch(/^ops_incidents: error: /);
  });

  it('DB down → [err] exit 1', async () => {
    const s = io();
    expect(await oi.opsIncidentsMain(OPEN, { io: s.io, connect: async () => null })).toBe(1);
    expect(s.out).toEqual(['[err] không kết nối được Postgres']);
  });

  it('--by agent / thời điểm tương lai / xảy ra sau phát hiện → [warn] exit 1, KHÔNG ghi gì', async () => {
    const now = vn('2026-10-16T17:00:00');
    for (const o of [
      { ...OPEN, by: 'agent:bot' },
      { ...OPEN, by: 'System:x' },
      { ...OPEN, detectedAt: '2026-10-16T17:06' },
      { ...OPEN, occurredAt: '2026-10-16T16:01' },
      { ...OPEN, detectedAt: '16/10/2026 16:00' },
      { ...OPEN, title: '   ' },
    ]) {
      const sql: string[] = [];
      const db = {
        query: async (q: string) => {
          sql.push(q);
          return { rows: [{ id: '1' }] };
        },
      };
      const s = io();
      const rc = await oi.opsIncidentsMain(o, {
        io: s.io,
        now: () => now,
        connect: async () => ({ db: db as never, release: async () => {} }),
      });
      expect(rc, JSON.stringify(o)).toBe(1);
      expect(s.out[0]).toMatch(/^\[warn\] .* — không ghi$/);
      expect(sql).toEqual([]);
    }
  });

  it('--event: sự cố không có / mốc trước lúc phát hiện → từ chối, không ghi sự kiện', async () => {
    const now = vn('2026-10-16T20:00:00');
    const det = vn('2026-10-16T16:00:00');
    for (const [found, at, want] of [
      [false, undefined, 'không có sự cố #7'],
      [true, '2026-10-16T15:59', '--at trước lúc phát hiện sự cố'],
      [true, '2026-10-16T21:00', '--at ở tương lai'],
    ] as const) {
      const sql: string[] = [];
      const db = {
        query: async (q: string) => {
          sql.push(q);
          return { rows: found ? [{ detected_at: det }] : [] };
        },
      };
      const s = io();
      const rc = await oi.opsIncidentsMain(
        { event: '7', kind: 'responded', by: 'Người Trực', at },
        {
          io: s.io,
          now: () => now,
          connect: async () => ({ db: db as never, release: async () => {} }),
        },
      );
      expect(rc).toBe(1);
      expect(s.out[0]).toBe(`[warn] ${want} — không ghi`);
      expect(sql.some((q) => q.startsWith('insert'))).toBe(false);
    }
  });
});
