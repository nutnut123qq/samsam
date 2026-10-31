import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceBindError } from '@samsam/core/db';
import { repoPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/kd_orders.golden.json' with { type: 'json' };
import {
  anomalies,
  anomalyItem,
  buildOrders,
  ck,
  type MarketRow,
  type OrderWatch,
  pct,
  type ReconRow,
  reconFromRows,
  renderCsv,
  type WeekCount,
} from './kd-orders.js';
import { type KdOrdersOpts, kdOrdersMain } from './kd-orders-care.command.js';

// Dịch tests/test_kd_orders.py (phần thuần + CLI không DB) + tests/test_v14_p4_sales.py (anomalies,
// CLI --watch tham số, cấu hình hỏng exit 1 trước connect). Golden = hàm Python thật
// (`__fixtures__/kd_orders.golden.json`, sinh từ script ngoài repo).

const tmp = mkdtempSync(join(tmpdir(), 'kdo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const num = (v: unknown): unknown =>
  typeof v === 'bigint'
    ? Number(v)
    : Array.isArray(v)
      ? v.map(num)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x)]))
        : v;

describe('kd_orders thuần (golden Python)', () => {
  it('buildOrders: gom đơn, hủy theo NFC, status sạch ≤40, note sắp code point ≤200, lỗi kiểu', () => {
    for (const c of G.build_orders) {
      const run = () =>
        buildOrders(c.rows as MarketRow[], c.cancel as Record<string, unknown> | null);
      if (!Array.isArray(c.out)) {
        expect(run, JSON.stringify(c.cancel)).toThrow(TypeError);
        continue;
      }
      expect(num(run())).toEqual(c.out);
    }
  });

  it('anomalies + anomalyItem: chỉ tuần ĐÃ đóng, ngưỡng tuyệt đối / spike so nền', () => {
    for (const c of G.anomalies) {
      const counts = new Map<string, WeekCount>(
        c.counts.map(([ch, wk, v]) => [ck(ch as string, wk as string), v as WeekCount]),
      );
      const fs = anomalies(counts, c.today, c.ow as OrderWatch);
      expect(fs).toEqual(c.out);
      expect(fs.map((f) => anomalyItem(f, c.ow as OrderWatch, G.label))).toEqual(c.items);
    }
    // payload qua guardrail + ghi rõ đơn TRỄ "chưa đo"
    const it0 = G.anomalies[0]?.items[0] as { payload: string };
    expect(it0.payload).toContain('CHƯA ĐO');
    expect(check(it0.payload).ok).toBe(true);
  });

  it('pct: ROUND_HALF_UP 1 chữ số; n = 0 → —', () => {
    for (const [b, n, want] of G.pct) expect(pct(b as number, n as number)).toBe(want);
  });

  it('renderCsv: BOM, LF, chặn công thức (=,+,-,@,tab), ngoặc kép, hàng TỔNG theo kênh', () => {
    const big = (r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]),
      ) as ReconRow;
    for (const c of G.render_csv) {
      const out = renderCsv(c.rows.map(big)).toString('utf8');
      expect(out).toBe(c.text);
    }
    const t = renderCsv([
      big({
        channel: 'shopee',
        order_ref: 'abcd1234',
        status: '=HYPERLINK(1)',
        total_vnd: -5,
        label: 'x',
      }),
    ]).toString('utf8');
    expect(t).toContain("'=HYPERLINK");
    expect(t).toContain(',-5,');
    expect(t.startsWith('﻿')).toBe(true);
    expect(t).not.toContain('\r');
  });

  it('reconFromRows: settlement mới nhất, chua_quyet_toan, thieu_don trong kỳ settled_on, CSV tất định', () => {
    const R = G.recon;
    for (const c of R.cases) {
      const rows = reconFromRows(
        R.sett,
        R.ids,
        R.period as [string, string, string, unknown][],
        c.since,
        c.until,
      );
      expect(num(rows)).toEqual(c.out);
      expect(renderCsv(rows).toString('utf8')).toBe(c.csv);
      // không lộ hash đủ 16 ký tự
      for (const id of R.ids) expect(c.csv).not.toContain(id.split(':')[1] as string);
    }
  });

  it('module không LLM/mạng/gửi', () => {
    for (const f of ['kd-orders.ts', 'kd-care.ts', 'kd-affiliate.ts', 'shared.ts']) {
      const src = readFileSync(join(import.meta.dirname, f), 'utf8');
      expect(src, f).not.toMatch(
        /ai\/gateway|AI_GATEWAY|\.chat\(|fetch\(|node:https?|smtp|unseal|loadVaultKey/,
      );
    }
  });
});

describe('kd_orders CLI (không DB)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const fail = async () => {
    throw new Error('không được connect');
  };

  it.each<[KdOrdersOpts]>([
    [{ sync: true, report: true }],
    [{ sync: true, recon: true }],
    [{}],
    [{ recon: true, since: '2026-10-31', until: '2026-10-01' }],
    [{ recon: true, since: '31/10/2026', until: '2026-11-01' }],
    [{ recon: true, since: '2026-10-01' }],
    [{ dryRun: true, recon: true, since: '2026-10-01', until: '2026-10-02' }],
    [{ watch: true, asOf: '2026-10-01' }],
    [{ watch: true, sync: true }],
    [{ watch: true, dryRun: true, asOf: '01/10/2026' }],
    [{ sync: true, snapshot: 'x' }],
    [{ sync: true, snapshot: '0' }],
    [{ recon: true, since: '2026-10-01', until: '2026-10-02', snapshot: '1' }],
    [{ sync: true, since: '2026-10-01' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await kdOrdersMain(o, { io: s.io, env: {}, service: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^kd_orders: error: /);
  });

  it('chế độ thực thiếu LOADER_/JOB_DATABASE_URL → [err] exit 2 (bind_service)', async () => {
    for (const [o, v] of [
      [{ sync: true }, 'LOADER_DATABASE_URL'],
      [{ watch: true }, 'JOB_DATABASE_URL'],
    ] as const) {
      const s = io();
      const rc = await kdOrdersMain(o, { io: s.io, env: { APPROVAL_ENFORCE: '1' }, service: fail });
      expect(rc).toBe(2);
      expect(s.out[0]).toContain(`thiếu ${v}`);
    }
  });

  it('cấu hình watch hỏng → exit 1 TRƯỚC connect; DB down → exit 2', async () => {
    const bad = join(tmp, 'w.json');
    writeFileSync(bad, '{broken');
    let s = io();
    expect(
      await kdOrdersMain(
        { watch: true, dryRun: true },
        { io: s.io, env: {}, watchFile: bad, service: fail },
      ),
    ).toBe(1);
    expect(s.err[0]).toMatch(/^\[error\] cấu hình lỗi: .* — không connect$/);
    s = io();
    expect(
      await kdOrdersMain(
        { watch: true, dryRun: true },
        { io: s.io, env: {}, service: async () => null },
      ),
    ).toBe(2);
    expect(s.err[0]).toContain('không kết nối được Postgres');
    s = io();
    expect(
      await kdOrdersMain(
        { sync: true, dryRun: true },
        { io: s.io, env: {}, service: async () => null },
      ),
    ).toBe(2);
  });

  it('sales.json thiếu order_anomaly → exit 1 trước connect', async () => {
    const dir = join(tmp, 'dirs');
    const cfg = JSON.parse(readFileSync(repoPath('data/directors/sales.json'), 'utf8'));
    delete cfg.object_types.order_anomaly;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    writeFileSync(join(dir, 'sales.json'), JSON.stringify(cfg));
    const s = io();
    expect(
      await kdOrdersMain(
        { watch: true, dryRun: true },
        { io: s.io, env: {}, directorsDir: dir, service: fail },
      ),
    ).toBe(1);
    expect(s.err[0]).toContain('order_anomaly');
  });

  it('--sync mapping hỏng → [error] ValueError exit 1 (không đọc DB); login dịch vụ bị từ chối → [err] exit 2', async () => {
    let s = io();
    const nodb = async () => ({
      db: {
        query: async () => {
          throw new Error('không được đọc DB');
        },
      } as never,
      release: async () => {},
    });
    const rc = await kdOrdersMain(
      { sync: true, dryRun: true },
      { io: s.io, env: {}, service: nodb, wire: () => {}, mapFile: join(tmp, 'khong-co.json') },
    );
    expect(rc).toBe(1);
    expect(s.err[0]).toBe(
      '[error] ValueError: không đọc được mapping khong-co.json: FileNotFoundError',
    );
    s = io();
    const denied = async () => {
      throw new ServiceBindError('login Postgres là SUPERUSER');
    };
    expect(await kdOrdersMain({ watch: true }, { io: s.io, env: {}, service: denied })).toBe(2);
    expect(s.out).toEqual(['[err] login Postgres là SUPERUSER']);
  });
});
