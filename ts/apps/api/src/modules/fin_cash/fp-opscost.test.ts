import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { repoPath } from '@samsam/core/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FPA_CONFIG_FILE } from '../fin_ar_pnl/fin-common.js';
import { type CliDeps, type FpOpscostOpts, fpOpscostMain } from './fin-cash.command.js';
import { dumpPy, fixture, type J } from './fin-cash.testing.js';
import * as fo from './fp-opscost.js';

// Dịch tests/test_fp_opscost.py (phần thuần + CLI không DB) + test_r12_dot3.py (G1-L3 nguồn). Fixture
// golden sinh bằng hàm Python THẬT (`agents/fp_opscost.py`, gen_fin.py ở scratchpad). `opex_MAU.csv`
// + users trong test là MẪU. Phần DB ở fin-cash.db.test.ts.

const FIX = fixture('fp_opscost.golden.json');
const RAW_FPA = parsePyJson(readFileSync(FPA_CONFIG_FILE, 'utf8')) as J;
const OPEX = repoPath('tests/fixtures/finance/opex_MAU.csv');
const X = 5_000_000;
const usersOf = (u: J): fo.Users =>
  new Map(Object.entries(u).map(([k, v]) => [k, v as { role: string }]));
const USERS = usersOf({
  'tgd@samsam.test': { role: 'tgd' },
  'banhang@samsam.test': { role: 'gd_ban_hang' },
});
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fp-opscost-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const file = (body: string | Buffer, name = 'f.csv') => {
  const d = join(tmp, String(++seq));
  const p = join(d, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe('fp_opscost — golden Python', () => {
  it('load_cfg: repo + biến thể (scope lạ, int thật, warn < stop, X > 0)', () => {
    expect(fo.loadCfg()[0]).toEqual(FIX.cfg_repo);
    for (const v of FIX.cfg_variants as J[]) {
      const sec = { ...(RAW_FPA.opscost as J), ...(v.over as J) };
      if ((v.over as J).warn_pct === null) delete sec.warn_pct;
      const p = file(dumpPy({ ...RAW_FPA, opscost: sec }), 'c.json');
      const [cfg, why] = fo.loadCfg(p);
      expect(why, v.name as string).toBe(v.why);
      expect(cfg, v.name as string).toEqual(v.cfg);
    }
  });

  it('read_opex: fixture MẪU + lỗi chỉ nêu số dòng/field (không giá trị ô)', async () => {
    const [es, errs, s] = await fo.readOpex(OPEX);
    expect({ entries: es, errs, sha: s }).toEqual(FIX.read_opex_fixture);
    for (const c of FIX.read_opex as J[]) {
      const p = c.label === 'bad_ext' ? file('x', 'f.txt') : file(Buffer.from(c.body as string));
      const [e2, err2, s2] = await fo.readOpex(p);
      expect({ entries: e2, errs: err2, sha: s2 }, c.label as string).toEqual({
        entries: c.entries,
        errs: c.errs,
        sha: c.sha,
      });
    }
  });

  it('ai_vnd = ROUND_HALF_UP(Decimal(str(usd)) × tỷ giá); actuals theo scope', () => {
    for (const [u, r, want] of FIX.ai_vnd as [string, number, number][]) {
      expect(fo.aiVnd(u, r), `${u}×${r}`).toBe(want);
    }
    expect(fo.aiVnd(160, 25000)).toBe(4_000_000);
    expect(fo.aiVnd(0.1, 3)).toBe(0);
    const a = FIX.actuals as J;
    expect(
      fo.actuals(a.ai_usd as Record<string, string>, a.opex as fo.OpexEntry[], a.rate as number),
    ).toEqual(a.out);
  });

  it('budget_alerts: biên 80%/100% (đúng ≤ 1 cảnh báo/scope, số nguyên)', () => {
    for (const c of FIX.alerts as J[]) {
      expect(
        fo.budgetAlerts(
          { 'ai:content': c.spent as number },
          { 'ai:content': 5_000_000 },
          c.warn as number,
          100,
        ),
        `${c.spent}@${c.warn}`,
      ).toEqual(c.out);
    }
    expect(
      fo.budgetAlerts(
        { ai: 4_000_000, cloud: 1, saas: 9_000_000, tong: 35_000_000 },
        { tong: 35_000_000, ai: 5_000_000, cloud: 4_000_000, saas: 7_000_000, ads: 1 },
        80,
        100,
      ),
    ).toEqual(FIX.alerts_multi);
    for (const [s, b, want] of FIX.pct as [number, number, string][]) {
      expect(fo.pct(s, b), `${s}/${b}`).toBe(want);
    }
  });

  it('verdict: fail-closed — chỉ mục CỦA agent, đúng khóa tự nhiên + nội dung, TGĐ per_item', () => {
    for (const c of FIX.verdict as J[]) {
      expect(
        fo.verdict(
          c.entry as fo.OpexEntry,
          c.items as fo.QueueRow[],
          usersOf(c.users as J),
          c.x as number,
        ),
        c.name as string,
      ).toEqual(c.out);
    }
    expect(fo.WHY).toEqual(FIX.why);
  });

  it('payload opex_over_x byte y hệt Python (chữ ký TGĐ dùng chung DB với bản Python)', () => {
    const o = FIX.over_x as J;
    const e = o.entry as fo.OpexEntry;
    expect(fo.renderOverX(e)).toBe(o.text);
    expect(sha(fo.renderOverX(e))).toBe(o.sha);
    expect(fo.opexKey(e)).toBe(o.key);
  });

  it('render_report y hệt Python (không in doc_ref)', async () => {
    const [cfg] = fo.loadCfg();
    const r = FIX.report as J;
    const [es, , s] = await fo.readOpex(OPEX);
    const opex = es
      .map((e, i) => ({ ...e, id: i + 1, file_sha256: s as string }))
      .filter((e) => e.month === '2026-10-01');
    const acts = fo.actuals(r.ai_usd as Record<string, string>, opex, (cfg as fo.OpsCfg).usd_vnd);
    expect(acts).toEqual(r.acts);
    const alerts = fo.budgetAlerts(
      acts,
      (cfg as fo.OpsCfg).budget_vnd,
      (cfg as fo.OpsCfg).warn_pct,
      (cfg as fo.OpsCfg).stop_pct,
    );
    expect(alerts).toEqual(r.alerts);
    const over = opex
      .filter((e) => e.amount_vnd > (cfg as fo.OpsCfg).threshold_x_vnd)
      .map((e) => [e, fo.spendStatus(e, [], new Map(), X)] as [fo.OpexEntry, string]);
    expect(over.map(([, st]) => st)).toEqual(r.over_status);
    const text = fo.renderReport('2026-10-01', acts, cfg as fo.OpsCfg, alerts, over);
    expect(text).toBe(r.text);
    expect(text).not.toContain('HD-MAU');
    const n = FIX.report_no_alerts as J;
    const cfg2 = { ...(cfg as fo.OpsCfg), budget_vnd: { 'ai:content': 5_000_000 } };
    const acts2 = fo.actuals({ content: '160', chatbot: '1' }, [], 25000);
    expect(acts2).toEqual(n.acts);
    expect(fo.renderReport('2026-10-01', acts2, cfg2, [], [])).toBe(n.text);
    expect(fo.renderReport('2026-10-01', acts2, cfg2, [], [])).toContain(
      '`ai:chatbot` | 25.000đ | chưa có trần',
    );
  });
});

describe('fp_opscost — luật', () => {
  it('summary đánh dấu phạm vi CÓ nguồn (0 dòng ≠ chi 0đ) — r12 G1-L3', async () => {
    const cfg: fo.OpsCfg = {
      usd_vnd: 25000,
      threshold_x_vnd: 10 ** 9,
      budget_vnd: { cloud: 1, ads: 1 },
      warn_pct: 80,
      stop_pct: 100,
    };
    const s = await fo.summary(null as never, '2026-09-01', cfg, new Map(), {
      fetchOpex: async () => [
        {
          id: 1,
          file_sha256: 'a'.repeat(64),
          row_no: 2,
          month: '2026-09-01',
          category: 'cloud',
          amount_vnd: 0,
          service: 'x',
        },
      ],
      fetchAiUsd: async () => ({}),
      fetchItems: async () => [],
    });
    expect([...s.co_nguon].sort()).toEqual(['cloud', 'tong']);
  });

  it('chỉ TGĐ (theo users) duyệt per_item mới "được chi"; ≤ X là trong ngưỡng', () => {
    const e = {
      id: 7,
      file_sha256: 'a'.repeat(64),
      row_no: 5,
      month: '2026-10-01',
      category: 'saas',
      service: 'misa-amis',
      amount_vnd: X + 1,
    };
    const it0 = (by: string, lane = 'per_item'): fo.QueueRow => ({
      object_type: 'opex_over_x',
      object_id: fo.opexKey(e),
      block: 'finance',
      created_by: fo.CREATED_BY,
      content_sha256: sha(fo.renderOverX(e)),
      status: 'approved',
      lane,
      decided_by: by,
    });
    expect(fo.spendStatus({ ...e, amount_vnd: X }, [], new Map(), X)).toBe('trong_nguong');
    expect(fo.spendStatus(e, [it0('  TGD@SamSam.test ')], USERS, X)).toBe('duoc_chi');
    expect(fo.spendStatus(e, [it0('banhang@samsam.test')], USERS, X)).toBe('cho_tgd_ky');
    expect(fo.spendStatus(e, [it0('tgd@samsam.test', 'auto_policy')], USERS, X)).toBe('cho_tgd_ky');
    expect(fo.spendStatus(e, [it0('tgd@samsam.test')], new Map(), X)).toBe('cho_tgd_ky');
  });

  it('module không mạng / không AI gateway / không chi tiền', () => {
    const src = readFileSync(new URL('./fp-opscost.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/fetch\(|node:http|@samsam\/core\/ai|smtp/);
  });
});

describe('fp_opscost CLI (không DB)', () => {
  const run = async (o: FpOpscostOpts, extra: Partial<CliDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: number[] = [];
    const rc = await fpOpscostMain(o, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      connect: async () => {
        calls.push(1);
        return null;
      },
      ...extra,
    });
    return { rc, text: out.join('\n'), err: err.join('\n'), calls };
  };

  it('tham số sai → exit 2 TRƯỚC connect', async () => {
    for (const o of [
      { report: true, status: true, month: '2026-10' },
      { report: true },
      { report: true, month: '2026-13' },
      { load: 'x.csv', month: '2026-10' },
      {},
    ] as FpOpscostOpts[]) {
      const r = await run(o);
      expect(r.rc, JSON.stringify(o)).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });

  it('file lỗi / cấu hình hỏng → exit 1, 0 connect, không in giá trị ô', async () => {
    const bad = file(
      Buffer.from(
        'month,category,service,amount_vnd,doc_ref\n2026-10,cloud,aws,-5000,\n2026-10,khac2,aws,5,\n',
      ),
    );
    let r = await run({ load: bad });
    expect(r.rc).toBe(1);
    expect(r.text).toContain('không connect, không nạp gì');
    expect(r.text).not.toContain('-5000');
    expect(r.text).not.toContain('khac2');
    r = await run({ report: true, month: '2026-10' }, { fpaConfig: file('{', 'c.json') });
    expect(r.rc).toBe(1);
    expect(r.text).toContain('không connect');
    expect(r.calls).toEqual([]);
  });

  it('quá 30 lỗi → in 30 + "và N lỗi khác"', async () => {
    const body = `month,category,service,amount_vnd,doc_ref\n${'2026-10,cloud,aws,0,\n'.repeat(35)}`;
    const r = await run({ load: file(Buffer.from(body)) });
    expect(r.rc).toBe(1);
    expect(r.text).toContain('[err] ... và 5 lỗi khác');
    expect(r.text).toContain('[err] 35 lỗi — không connect, không nạp gì.');
  });

  it('DB down → exit 2', async () => {
    const r = await run({ status: true, month: '2026-10' });
    expect(r.rc).toBe(2);
    expect(r.err).toContain('không kết nối được Postgres');
  });

  it('cấu hình khối finance hỏng → --submit-over-x exit 1 trước connect', async () => {
    const r = await run(
      { submitOverX: true, month: '2026-10' },
      { directorsDir: join(tmp, 'none') },
    );
    expect(r.rc).toBe(1);
    expect(r.text).toContain('[err] cấu hình khối finance:');
    expect(r.text).toContain('không connect');
    expect(r.calls).toEqual([]);
  });
});
