import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GAP_DAYS } from '../garden_zalo/garden.js';
import G from './__fixtures__/garden_director.golden.json' with { type: 'json' };
import * as gd from './garden-director.js';

// Dịch tests/test_garden_director.py + test_contract_c02_garden_remind.py (phần thuần/CLI không DB).
// Golden: chạy hàm Python thật (scratchpad gen_pure.py) → so khớp y hệt.

const TMP = mkdtempSync(join(tmpdir(), 'gd-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const files = G.files as Record<string, string | null>;
function put(name: string): string {
  const p = join(TMP, name);
  const b = files[name];
  if (b !== null && b !== undefined) writeFileSync(p, Buffer.from(b, 'base64'));
  return p;
}
const iso = (d: Date | null) =>
  d === null
    ? null
    : d.toISOString().replace(/\.(\d{3})Z$/, (_, ms) => (ms === '000' ? 'Z' : `.${ms}000Z`));
const ser = (r: gd.Reminder) => ({ ...r, last_ts: iso(r.last_ts) });

type PyErr = { err: string; msg: string };
/** Python ValueError ↔ RangeError; lớp con giữ tên. */
function expectErr(fn: () => unknown, want: PyErr, msgPrefix?: string) {
  let got: unknown;
  try {
    fn();
  } catch (e) {
    got = e;
  }
  expect(got, want.msg).toBeInstanceOf(RangeError);
  if (want.err === 'ScheduleError') expect(got).toBeInstanceOf(gd.ScheduleError);
  else expect(got).not.toBeInstanceOf(gd.ScheduleError);
  if (msgPrefix === undefined) expect((got as Error).message).toBe(want.msg);
  else expect((got as Error).message.startsWith(msgPrefix)).toBe(true);
}

describe('reminders (golden)', () => {
  const now = new Date(G.reminders.now);
  it.each(G.reminders.cases.map((c, i) => [i, c] as const))('ca %i', (_i, c) => {
    const la = new Map(Object.entries(c.in.last_any).map(([k, v]) => [k, new Date(v as string)]));
    const lb = new Map(
      (c.in.last_by as string[][]).map(([p, a, t]) => [
        gd.actKey(p as string, a as string),
        new Date(t as string),
      ]),
    );
    const rems = gd.reminders(c.in.plots, la, lb, c.in.sched as gd.Schedule, now);
    expect(rems.map(ser)).toEqual(c.out);
    expect(rems.map(gd.fmtReminder)).toEqual(c.fmt);
    expect(rems.map(gd.mark)).toEqual(c.mark);
  });

  it('no-logs không sinh overdue kèm; gap biên nghiêm ngặt 14 ngày', () => {
    const NOW = new Date('2026-10-11T17:00:00Z');
    const SCHED = { gap_days: 14, activities: { tưới: 7, bón: 60 } };
    expect(gd.reminders(['KV-1'], new Map(), new Map(), SCHED, NOW)).toEqual([
      { type: 'no-logs', plot: 'KV-1', activity: null, last_ts: null, days: null },
    ]);
    const both = new Map([
      [gd.actKey('KV-1', 'tưới'), NOW],
      [gd.actKey('KV-1', 'bón'), NOW],
    ]);
    const d14 = new Date(NOW.getTime() - 14 * 86_400_000);
    expect(gd.reminders(['KV-1'], new Map([['KV-1', d14]]), both, SCHED, NOW)).toEqual([]);
    const out = gd.reminders(
      ['KV-1'],
      new Map([['KV-1', new Date(d14.getTime() - 1000)]]),
      both,
      SCHED,
      NOW,
    );
    expect(out.map((r) => [r.type, r.days])).toEqual([['gap', 14]]);
  });
});

describe('loadSchedule (golden)', () => {
  // KHÁC Python có chủ đích: thông điệp JSONDecodeError là của JS; NaN bị JSON.parse từ chối (Python
  // nhận NaN rồi chặn ở gap_days) — cả hai đều ValueError/fail-closed.
  const JS_JSON = new Set(['bad_json', 'bom', 'nan']);
  for (const [k, want] of Object.entries(G.schedule)) {
    if (k === 'repo') continue;
    it(k, () => {
      const p = put(`sched_${k}.json`);
      if ('err' in want) {
        expectErr(
          () => gd.loadSchedule(p),
          JS_JSON.has(k) ? { err: 'ValueError', msg: '' } : (want as PyErr),
          JS_JSON.has(k) ? `lịch sched_${k}.json JSON hỏng: ` : undefined,
        );
      } else {
        expect(gd.loadSchedule(p)).toEqual([want.ok, want.warns]);
      }
    });
  }
  it('lịch repo là GIẢ ĐỊNH hợp lệ', () => {
    const [s, w] = gd.loadSchedule();
    expect([s, w]).toEqual([G.schedule.repo.ok, G.schedule.repo.warns]);
    expect(w).toEqual([]);
    expect(s.gap_days).toBe(14);
    expect(readFileSync(gd.SCHEDULE_PATH, 'utf8')).toContain('GIẢ ĐỊNH');
  });
  it('mặc định gap_days = garden.DEFAULT_GAP_DAYS', () => {
    expect(gd.loadSchedule(join(TMP, 'khong-co.json'))[0]).toEqual({
      gap_days: DEFAULT_GAP_DAYS,
      activities: {},
    });
  });
});

describe('loadRemindCfg (golden)', () => {
  for (const [k, want] of Object.entries(G.remind_cfg)) {
    it(k, () => {
      const p = k === 'repo' ? undefined : put(`remind_${k}.json`);
      if ('err' in want) expectErr(() => gd.loadRemindCfg(p), want as PyErr);
      else expect(gd.loadRemindCfg(p)).toEqual(want.ok);
    });
  }
  it('không phải object → lỗi cấu hình (Python AttributeError traceback — TS chặt hơn)', () => {
    const p = join(TMP, 'remind_list.json');
    writeFileSync(p, '[1]');
    expect(() => gd.loadRemindCfg(p)).toThrow(RangeError);
  });
});

describe('thuần khác (golden)', () => {
  it.each(G.clean_detail)('cleanDetail %j', (d, want) => {
    expect(gd.cleanDetail(d as string | null)).toBe(want);
  });
  it('logFlags CHỈ detail', () => {
    for (const [d, want] of G.log_flags) expect(gd.logFlags(d)).toEqual(want);
    expect(gd.logFlags('định kỳ, không thấy gì')).toEqual([]);
    expect(gd.logFlags(null)).toEqual([]);
  });
  it('defaultUntil = hôm qua giờ VN', () => {
    for (const [n, want] of G.default_until)
      expect(gd.defaultUntil(new Date(n as string))).toBe(want);
  });
  it('coerceUntil', () => {
    for (const [s, want] of G.coerce_until) {
      if (typeof want === 'string') expect(gd.coerceUntil(s)).toBe(want);
      else expectErr(() => gd.coerceUntil(s), want as PyErr);
    }
  });
  it('reminderSql + sqlBlock', () => {
    for (const [n, want] of G.reminder_sql)
      expect(gd.reminderSql(new Date(n as string))).toEqual(want);
    expect(gd.sqlBlock(['select 1', 'select 2'])).toEqual(G.sql_block);
  });
});

// ------------------------------------------------------------------ CLI (không DB)

type Out = { out: string[]; err: string[] };
function io(): Out & { io: { out: (s: string) => void; err: (s: string) => void } } {
  const o: Out = { out: [], err: [] };
  return { ...o, io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) } };
}
const noConnect = async () => {
  throw new Error('connect() không được gọi');
};

describe('gardenDirectorMain CLI', () => {
  beforeAll(() => installFakeDeps());
  afterAll(() => resetOpsDeps());
  it.each<[gd.GardenDirectorOpts]>([
    [{}],
    [{ bulletin: true, remind: true }],
    [{ verify: true, precheck: true }],
    [{ purgeSample: true }],
    [{ purgeSample: true, by: '  ' }],
    [{ bulletin: true, until: '12/10/2026' }],
    [{ bulletin: true, days: '0' }],
    [{ bulletin: true, days: 'x' }],
    [{ adoptPlot: 'KV-A01' }],
    [{ adoptPlot: 'KV-A01', by: ' ' }],
    [{ adoptPlot: ' ', by: 'GĐ' }],
    [{ adoptPlot: 'KV-A01', purgeSample: true, by: 'GĐ' }],
    [{ markReminded: '3' }],
    [{ markReminded: 'x', by: 'A' }],
    [{ markReminded: '0', by: 'A' }],
    [{ precheck: true, submit: true }],
  ])('usage %j → exit 2 trước connect', async (o) => {
    const t = io();
    expect(await gd.gardenDirectorMain(o, { connect: noConnect, io: t.io })).toBe(2);
    if (o.purgeSample && !o.adoptPlot) expect(t.err.join('\n')).toContain('--by');
  });

  it('purgeSample/adoptPlot --by trống → RangeError, không đụng DB', async () => {
    const boom = new Proxy(
      {},
      {
        get: () => {
          throw new Error('không được đụng DB');
        },
      },
    ) as never;
    for (const by of [null, '', '   ']) {
      await expect(gd.purgeSample(boom, by)).rejects.toThrow(/--by/);
      await expect(gd.adoptPlot(boom, 'KV-A01', by)).rejects.toThrow(/--by/);
    }
  });

  it('lịch hỏng → [err] exit 1 trước connect', async () => {
    const p = join(TMP, 'broken.json');
    writeFileSync(p, '{');
    const t = io();
    expect(
      await gd.gardenDirectorMain({ remind: true, schedule: p }, { connect: noConnect, io: t.io }),
    ).toBe(1);
    expect(t.err.join('\n')).toContain('[err]');
  });

  it.each<[gd.GardenDirectorOpts, number]>([
    [{ remind: true }, 0],
    [{ precheck: true }, 0],
    [{ reminders: true }, 0],
    [{ bulletin: true, until: '2026-10-12' }, 0],
    [{ verify: true }, 2],
    [{ purgeSample: true, by: 'GĐ' }, 2],
    [{ adoptPlot: 'KV-A01', by: 'GĐ' }, 2],
  ])('DB down %j → exit %i, không ghi tệp', async (o, code) => {
    const out = mkdtempSync(join(TMP, 'out-'));
    const t = io();
    expect(
      await gd.gardenDirectorMain({ ...o, outDir: out }, { connect: async () => null, io: t.io }),
    ).toBe(code);
    if (code === 0) expect(t.out.join('\n')).toContain('[warn] chưa nạp');
    expect(readdirSync(out)).toEqual([]);
  });

  it('host chết THẬT (DATABASE_URL không tới được) → không treo', async () => {
    const env = { DATABASE_URL: 'postgresql://u@127.0.0.1:1/x', NODE_ENV: 'test' };
    const t = io();
    expect(await gd.gardenDirectorMain({ remind: true }, { env, io: t.io })).toBe(0);
    expect(await gd.gardenDirectorMain({ verify: true }, { env, io: t.io })).toBe(2);
  });

  it('không --until: kỳ kết thúc HÔM QUA VN (đồng hồ giả)', async () => {
    const out = mkdtempSync(join(TMP, 'out-'));
    let seen: string | null = null;
    const fake = {
      query: async (q: string | { text: string }) => {
        const sql = typeof q === 'string' ? q : q.text;
        if (sql.includes('select exists')) return { rows: [{ x: false }] };
        if (sql.includes('verify_plot_logs')) return { rows: [] };
        if (sql.startsWith('select count(*)')) return { rows: [[0]] };
        if (sql.includes('as plots')) return { rows: [[0, 0]] };
        if (sql.includes("max(ts) from plot_logs where ts < '")) seen = sql;
        return { rows: [] };
      },
    };
    const t = io();
    const rc = await gd.gardenDirectorMain(
      { bulletin: true, outDir: out },
      {
        connect: async () => ({ db: fake as never, release: async () => {} }),
        io: t.io,
        now: () => new Date('2026-10-12T01:00:00Z'), // 08:00 VN
      },
    );
    expect(rc, t.err.join('\n')).toBe(0);
    expect(readdirSync(out)).toEqual(['garden-week-2026-10-11.md']);
    expect(seen).toContain("'2026-10-11T17:00:00+00:00'"); // hết ngày 11/10 VN
  });
});

describe('ràng buộc nguồn (dịch test AST/grep Python)', () => {
  const ROOT = join(import.meta.dirname, '..');
  const srcOf = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8');
  it('purgeSample/adoptPlot chỉ gọi từ CLI garden-director', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          const s = readFileSync(p, 'utf8');
          if (/\b(purgeSample|adoptPlot)\(/.test(s))
            hits.push(p.slice(ROOT.length + 1).replaceAll('\\', '/'));
        }
      }
    };
    walk(ROOT);
    expect(hits).toEqual(['garden_director/garden-director.ts']);
  });
  it('mục 6 bản tin: Ảnh/video (không còn nhãn "Ảnh vườn mới")', () => {
    const s = srcOf('garden-director.ts');
    expect(s).toContain('## 6. Ảnh/video vườn mới');
    expect(s).toContain('| Khoảnh | Ảnh/video |');
    expect(s).toContain('Không có ảnh/video mới.');
    expect(s).not.toContain('Ảnh vườn mới');
  });
  it('không LLM/HTTP trong 3 tệp port', () => {
    for (const f of ['garden-director.ts', 'vt-thoitiet.ts', 'vt-thuhoach.ts']) {
      expect(srcOf(f)).not.toMatch(/ai\/gateway'|\.chat\(|fetch\(['"`]http|Math\.random/);
    }
  });
});
