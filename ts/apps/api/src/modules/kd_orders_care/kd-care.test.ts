import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@samsam/core/ops/director';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { readinessKey } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import G from './__fixtures__/kd_care.golden.json' with { type: 'json' };
import {
  type CareData,
  CareRulesError,
  canon,
  checkBy,
  guiLuc,
  inWindow,
  loadRules,
  monthKey,
  type Purchase,
  type Rules,
  selectItems,
  validateRecord,
} from './kd-care.js';
import { type KdCareOpts, kdCareMain } from './kd-orders-care.command.js';

// Dịch tests/test_kd_care.py (phần thuần + CLI không DB) + tests/test_r19_ngay_cong_som.py (kd_care
// TẮT → `[rollout]` exit 2 trước connect) + tests/test_v15_p10_human_authz.py (--verify-send không nhận
// --by). Golden = hàm Python thật (`__fixtures__/kd_care.golden.json`).

// Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn = fail-closed): tiền tố agent:/system: so sau NFKC (chữ toàn khổ).
const TS_STRICTER_BY = new Set(['Ａgent:x']);

const tmp = mkdtempSync(join(tmpdir(), 'kdc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  settings.forceMode = null;
});
const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const norm = (r: Rules) => ({ ...r, window: r.window.map(hm) });
const RULES = loadRules();

type GData = {
  purchases: Purchase[];
  consent: [number, string, boolean][];
  promotable: string[];
  month_counts: [number, number][];
  seen_rebuy: number[];
  seen_review: number[];
};
const data = (g: GData): CareData => ({
  purchases: g.purchases,
  consent: new Map(g.consent.map(([c, p, v]) => [`${c}:${p}`, v])),
  promotable: new Set(g.promotable),
  month_counts: new Map(g.month_counts),
  seen_rebuy: new Set(g.seen_rebuy),
  seen_review: new Set(g.seen_review),
});

describe('kd_care thuần (golden Python)', () => {
  it('loadRules: file mặc định + mọi biến thể hỏng → CareRulesError đúng thông điệp (fail-closed)', () => {
    expect(norm(RULES)).toEqual(G.rules_default);
    const p = join(tmp, 'r.json');
    for (const c of G.rules) {
      writeFileSync(p, Buffer.from(c.raw, 'base64'));
      if ('ok' in c) expect(norm(loadRules(p))).toEqual(c.ok);
      else expect(() => loadRules(p), c.error).toThrow(new CareRulesError(c.error as string));
    }
    expect(() => loadRules(join(tmp, 'khong-co.json'))).toThrow(G.rules_nofile.msg);
    const raw = readFileSync(repoPath('data/care_rules.json'), 'utf8');
    expect(raw).toContain('GIẢ ĐỊNH');
    expect(raw).toContain('GĐ KD/Pháp chế');
    expect(RULES.max_marketing_per_month).toBe(2);
  });

  it('inWindow/guiLuc/monthKey: khung [08:00, 20:00) giờ VN, ngoài khung dời tới mốc mở kế', () => {
    for (const w of G.windows) {
      const now = new Date(w.now);
      expect(inWindow(now, RULES.window), w.now).toBe(w.in);
      const at = guiLuc(now, RULES.window);
      expect(at.getTime(), w.now).toBe(new Date(w.gui_luc).getTime());
      expect(monthKey(at)).toBe(w.month);
    }
  });

  it('selectItems: bẫy kênh sàn/rượu/không promotable/trần tháng/lần mua mới nhất/cửa sổ/consent/khuyến cáo TPBVSK', () => {
    for (const c of G.select) {
      const rd = c.readiness
        ? new Map(
            (c.readiness as string[][]).map(([s, ch, v]) => [
              readinessKey(s as string, ch as string),
              v as string,
            ]),
          )
        : null;
      const res = selectItems(data(c.data as unknown as GData), new Date(c.now), RULES, rd);
      const items = res.items.map((i) => ({ ...i, gui_luc: i.gui_luc.getTime() }));
      const want = c.out.items.map((i) => ({ ...i, gui_luc: new Date(i.gui_luc).getTime() }));
      expect(items, c.now).toEqual(want);
      expect(res.skipped).toEqual(c.out.skipped);
    }
    // TPBVSK (XNQC đủ cả họ) → CODE nối câu khuyến cáo; payload không có PII, có contact_id + gui_luc
    const tp = G.select[8]?.out.items[0] as { payload: string };
    expect(tp.payload).toContain('không phải là thuốc');
    expect(canon()).toBe(G.canon);
    expect(tp.payload).toMatch(/^contact_id: \d+$/m);
  });

  it('checkBy: tên NGƯỜI ≤ 100 ký tự in được, không agent:/system:', () => {
    for (const c of G.check_by) {
      if (TS_STRICTER_BY.has(c.by as string)) {
        expect(() => checkBy(c.by)).toThrow(RangeError);
        continue;
      }
      if ('ok' in c) expect(checkBy(c.by)).toBe(c.ok);
      else expect(() => checkBy(c.by), String(c.by)).toThrow(c.msg as string);
    }
  });

  it('validateRecord: không nhận trường lạ (không echo tên trường), chỉ kênh sở hữu, order_ref không SĐT/email', () => {
    for (const c of G.record) {
      const run = () => validateRecord(c.rec, c.by);
      if (c.valid) expect(run, JSON.stringify(c.rec)).not.toThrow();
      else {
        const Err = c.error === 'TypeError' ? TypeError : RangeError;
        expect(run, JSON.stringify(c.rec)).toThrow(new Err(c.msg as string));
        expect(c.msg).not.toContain('0907654321');
      }
    }
  });

  it('sales.json có care_rebuy (high, B) + care_review (medium, A)', () => {
    const t = loadConfig('sales').object_types;
    expect([t.care_rebuy?.risk, t.care_rebuy?.handoff]).toEqual(['high', 'B']);
    expect([t.care_review?.risk, t.care_review?.handoff]).toEqual(['medium', 'A']);
  });
});

describe('kd_care CLI (không DB)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const fail = async () => {
    throw new Error('không được connect');
  };

  it.each<[KdCareOpts]>([
    [{ plan: true, run: true }],
    [{}],
    [{ record: true }],
    [{ record: true, by: 'agent:kd_a7' }],
    [{ plan: true, by: 'X' }],
    [{ plan: true, dryRun: true }],
    [{ verifySend: ['1', 'x.txt'], by: 'Lan' }],
    [{ verifySend: ['1'] }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await kdCareMain(o, { io: s.io, env: {}, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^kd_care: error: /);
  });

  it.each<[KdCareOpts]>([[{ run: true, dryRun: true }], [{ run: true }], [{ plan: true }]])(
    'sales-07.2 TẮT → đúng 1 dòng [rollout] exit 2, không connect %j',
    async (o) => {
      settings.forceMode = 'tat';
      const s = io();
      const rc = await kdCareMain(o, { io: s.io, env: {}, connect: fail, jobRun: fail as never });
      expect(rc).toBe(2);
      expect(s.out).toHaveLength(1);
      expect(s.out[0]).toMatch(/^\[rollout\] .*sales-07\.2/);
    },
  );

  it.each(['chay_thu', 'van_hanh'])(
    'giai đoạn %s: cổng không chặn — tới connect (DB down → exit 2)',
    async (st) => {
      settings.forceMode = st;
      for (const o of [{ run: true, dryRun: true }, { plan: true }] as KdCareOpts[]) {
        const s = io();
        let called = 0;
        const rc = await kdCareMain(o, {
          io: s.io,
          env: {},
          connect: async () => {
            called++;
            return null;
          },
        });
        expect(rc).toBe(2);
        expect(called).toBe(1);
        expect(s.out.join('\n')).not.toContain('[rollout]');
      }
    },
  );

  it('cấu hình hỏng → exit 1 trước connect; input JSON hỏng/quá 4 KB/không đọc được file → exit 1 trước connect', async () => {
    settings.forceMode = 'van_hanh';
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{x');
    let s = io();
    expect(
      await kdCareMain({ plan: true }, { io: s.io, env: {}, connect: fail, rulesFile: bad }),
    ).toBe(1);
    expect(s.err[0]).toBe('[error] cấu hình lỗi: care_rules.json không đọc được (JSONDecodeError)');
    const dir = join(tmp, 'dirs');
    mkdirSync(dir, { recursive: true });
    const cfg = JSON.parse(readFileSync(repoPath('data/directors/sales.json'), 'utf8'));
    delete cfg.object_types.care_review;
    writeFileSync(join(dir, 'sales.json'), JSON.stringify(cfg));
    s = io();
    expect(
      await kdCareMain({ plan: true }, { io: s.io, env: {}, connect: fail, directorsDir: dir }),
    ).toBe(1);
    expect(s.err[0]).toContain('care_rebuy/care_review');
    for (const [raw, t] of [
      [Buffer.from('{x'), 'JSONDecodeError'],
      [Buffer.from([0xff, 0xfe]), 'UnicodeDecodeError'],
      [Buffer.alloc(4097, 0x20), 'ValueError'],
    ] as const) {
      s = io();
      const rc = await kdCareMain(
        { record: true, by: 'Nguoi ghi gia lap' },
        { io: s.io, env: {}, connect: fail, stdin: async () => raw },
      );
      expect(rc).toBe(1);
      expect(s.err[0]).toBe(`[error] input JSON không hợp lệ (${t})`);
    }
    s = io();
    expect(
      await kdCareMain(
        { verifySend: ['1', join(tmp, 'khong-co.txt')] },
        { io: s.io, env: {}, connect: fail },
      ),
    ).toBe(1);
    expect(s.err[0]).toBe('[error] không đọc được file (FileNotFoundError)');
  });
});
