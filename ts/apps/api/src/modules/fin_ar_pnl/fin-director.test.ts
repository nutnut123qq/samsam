import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskPii } from '@samsam/core/security/pii';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/fin_director.golden.json' with { type: 'json' };
import { type FinDirectorOpts, finDirectorMain } from './fin-ar-pnl.command.js';
import * as fd from './fin-director.js';

// Dịch phần KHÔNG DB của tests/test_fin_director.py: các mục bản tin thuần (golden = hàm Python THẬT
// `agents/fin_director.py`), CLI tham số sai/cấu hình hỏng/DB down TRƯỚC connect. Phần DB ở
// fin-ar-pnl.db.test.ts.

const tmp = mkdtempSync(join(tmpdir(), 'fin-dir-'));
let seq = 0;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name: string, data: string): string => {
  const dir = join(tmp, String(++seq));
  mkdirSync(dir);
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

describe('fin_director — golden Python', () => {
  it('mục P&L / ads / chưa có dữ liệu (1 dòng, ≤120) — không PII', () => {
    const res = {
      month: '2026-10-01',
      loai: ['savina-12v', 'b'],
      tong_thuc_nhan: 1_000_000,
      tong_lai_gop: -5,
      n_rows: 3,
    };
    expect(fd.pnlSection(res)).toEqual(G.pnl_section);
    expect(
      fd.pnlSection({
        month: '2026-01-01',
        loai: [],
        tong_thuc_nhan: 0,
        tong_lai_gop: 0,
        n_rows: 0,
      }),
    ).toEqual(G.pnl_section_empty);
    expect(fd.adsSection(2)).toEqual(G.ads);
    expect(fd.nodata(fd.H_AR, `lỗi\nnhiều   dòng\t${'x'.repeat(200)}`)).toEqual(G.nodata);
    const text = [...G.pnl_section, ...G.ads, ...G.nodata].join('\n');
    expect(maskPii(text)).toBe(text);
  });

  it('mục chi phí vận hành + dòng tiền (nguồn nhóm fin_cash) khớp Python', () => {
    const ops = G.ops as unknown as { cfg: fd.OpsCfg; summary: fd.OpsSummary; lines: string[] };
    expect(fd.opsSection('2026-10-01', ops.summary, ops.cfg)).toEqual(ops.lines);
    expect(fd.opsSection('2026-10-01', { alerts: [], over: [] }, ops.cfg)).toEqual(G.ops_empty);
    for (const k of ['cash', 'cash2'] as const) {
      const c = G[k] as unknown as { fc: fd.CashForecast; lines: string[] };
      expect(fd.cashSection(c.fc), k).toEqual(c.lines);
    }
    expect(fd.NO_OPENING).toBe(G.no_opening);
    expect([fd.hPnl('2026-10-01'), fd.hOps('2026-10-01'), fd.hCash(13), fd.H_AR, fd.H_ADS]).toEqual(
      G.heads,
    );
  });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const fail = async () => {
  throw new Error('không được connect');
};

describe('fin_director CLI (không DB)', () => {
  it.each<[FinDirectorOpts]>([
    [{ weekly: true, asOf: '2026-13-01' }],
    [{ asOf: '2026-10-12' }],
    [{}],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await finDirectorMain(o, { io: s.io, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^fin_director: error: /);
  });

  it('fpa_config hỏng / không phải object → exit 1 trước connect', async () => {
    for (const [raw, kind] of [
      ['{', 'JSONDecodeError'],
      ['[1]', 'TypeError'],
    ]) {
      const s = io();
      const rc = await finDirectorMain(
        { weekly: true },
        { io: s.io, connect: fail, fpaConfig: file('fpa.json', raw as string) },
      );
      expect(rc).toBe(1);
      expect(s.out).toEqual([`[err] fpa.json hỏng (${kind}) — không connect.`]);
    }
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(
      await finDirectorMain(
        { weekly: true, asOf: '2026-10-12' },
        { io: s.io, connect: async () => null },
      ),
    ).toBe(2);
  });
});
