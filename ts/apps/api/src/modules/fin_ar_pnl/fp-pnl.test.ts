import { describe, expect, it } from 'vitest';
import G from './__fixtures__/fp_pnl.golden.json' with { type: 'json' };
import { type FpPnlOpts, fpPnlMain } from './fin-ar-pnl.command.js';
import { parseMonth, vnd } from './fin-common.js';
import * as fp from './fp-pnl.js';

// Dịch phần KHÔNG DB của tests/test_fp_pnl.py: giá vốn theo ngày hiệu lực, phân bổ chính xác, P&L
// (thiếu giá vốn = None không phải 0, ô chưa rõ SKU, lọc kênh), báo cáo — golden = hàm Python THẬT
// (`agents/fp_pnl.py`). Khác biệt CÓ CHỦ ĐÍCH ở TS_STRICTER. Phần DB ở fin-ar-pnl.db.test.ts.

const TS_STRICTER: Record<string, string> = {
  // Python `date(0, 1, 1)` ném ValueError → CLI traceback; TS trả null → `--pnl cần --month` exit 2.
  'parse_month:0000-01': 'năm 0000 → tham số sai (exit 2) thay vì traceback',
};

type PnlCase = {
  name: string;
  rows: fp.SettleRow[];
  lines: fp.OrderLine[];
  versions: fp.CogsVersion[];
  channel: string | null;
  res: fp.PnlResult;
  render: string;
};
const cases = G.pnl as unknown as PnlCase[];
const caseOf = (n: string) => cases.find((c) => c.name === n) as PnlCase;

describe('fp_pnl — golden Python', () => {
  it('cogs_at: hiệu lực theo ngày, chỉ dòng ĐÃ duyệt, hòa → id lớn nhất, không có → null', () => {
    for (const c of G.cogs_at as {
      versions: fp.CogsVersion[];
      sku: string;
      day: string;
      cost: number | null;
    }[]) {
      expect(fp.cogsAt(c.versions, c.sku, c.day), JSON.stringify(c)).toBe(c.cost);
    }
  });

  it('allocate: ROUND_HALF_UP, dư dồn cuối, tổng giữ chính xác (210 ca gồm 200 ngẫu nhiên)', () => {
    for (const [t, w, want] of G.allocate as [number, number[], number[]][]) {
      const got = fp.allocate(t, w);
      expect(got, JSON.stringify([t, w])).toEqual(want);
      expect(got.reduce((a, b) => a + b, 0)).toBe(t);
    }
    expect(() => fp.allocate(3, [])).toThrow(G.allocate_err as string);
  });

  it('pnl + render khớp Python mọi ca', () => {
    for (const c of cases) {
      const res = fp.pnl(c.rows, c.lines, c.versions, '2026-10-01', c.channel);
      expect(res, c.name).toEqual(c.res);
      expect(fp.render(res), c.name).toBe(c.render);
    }
    const ck = G.render_chong_ky as unknown as { res: fp.PnlResult; text: string };
    expect(fp.render(ck.res)).toBe(ck.text);
    expect(ck.text).not.toContain('0905123456'); // tên file qua `safe` (che SĐT)
  });

  it('thiếu giá vốn duyệt → None (KHÔNG 0) + nhãn, SKU bị loại; thêm giá vốn → hết loại', () => {
    const r = caseOf('missing_cogs').res;
    const b = r.cells.find((c) => c.sku_key === 'B') as fp.Cell;
    expect([b.gia_von, b.lai_gop, b.bien_gop_pct, b.nhan]).toEqual([null, null, null, fp.NO_COGS]);
    expect(r.loai).toEqual(['B']);
    expect(caseOf('missing_cogs').render).toContain('1 SKU bị loại vì chưa có giá vốn duyệt: `B`');
    expect(caseOf('missing_cogs_fixed').res.loai).toEqual([]);
  });

  it('lọc kênh: số đếm cùng phạm vi tổng tiền; tiktok rỗng', () => {
    const tk = caseOf('channel_tiktok');
    expect([
      tk.res.n_rows,
      tk.res.thieu_chung_tu,
      tk.res.hoan,
      tk.res.thieu_ngay,
      tk.res.cells,
    ]).toEqual([0, 0, 0, 0, []]);
    expect(tk.render).toContain('Tổng thực nhận: 0đ (0 dòng quyết toán trong tháng)');
    expect(tk.render).toContain('Lọc kênh: tiktok.');
    expect(tk.render).not.toContain('khớp tổng thực nhận');
  });

  it('biên gộp giữ dấu như Decimal ("-0.0", "-0.3")', () => {
    const bien = (n: string) =>
      caseOf(n).res.cells.map((c) => [c.sku_key, c.channel, c.bien_gop_pct]);
    expect(bien('neg_dt')).toContainEqual(['F', 'shopee', '-0.0']);
    expect(bien('neg_margin_rounding')).toContainEqual(['A', 'shopee', '-0.3']);
  });

  it('parse_month + vnd', () => {
    for (const [s, want] of G.parse_month as [string, string | null][]) {
      expect(parseMonth(s), JSON.stringify(s)).toBe(want);
    }
    expect([parseMonth(null), parseMonth(202610)]).toEqual(G.parse_month_nonstr);
    expect(parseMonth('0000-01'), TS_STRICTER['parse_month:0000-01']).toBeNull();
    for (const [n, want] of G.vnd as [number, string][]) expect(vnd(n)).toBe(want);
  });
});

// ------------------------------------------------------------------ CLI không DB
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const fail = async () => {
  throw new Error('không được connect');
};
const add = { cogsAdd: true, sku: 'savina-12v', cost: '50000', from: '2026-10-01', by: 'lap A' };

describe('fp_pnl CLI (không DB)', () => {
  it.each<[FpPnlOpts]>([
    [{ pnl: true, month: '2026-13' }],
    [{ pnl: true }],
    [{ pnl: true, cogsList: true }],
    [{ ...add, cost: '0' }],
    [{ ...add, cost: '-5' }],
    [{ ...add, from: '2026-02-30' }],
    [{ ...add, sku: 'Savina 12v' }],
    [{ ...add, by: '  ' }],
    [{ cogsApprove: '1' }],
    [{ cogsList: true, month: '2026-10' }],
    [{}],
    [{ cogsApprove: 'x', by: 'duyet B' }],
    [{ pnl: true, month: '2026-10', channel: 'lazada' }],
    [{ cogsList: true, by: 'x' }],
    [{ pnl: true, month: '2026-10', sku: 'savina-12v' }],
    [{ ...add, note: 'a'.repeat(201) }],
    [{ ...add, note: 'dòng\nhai' }],
    [{ ...add, by: 'x'.repeat(101) }],
    [{ pnl: true, month: '0000-01' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await fpPnlMain(o, { io: s.io, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^fp_pnl: error: /);
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(await fpPnlMain({ cogsList: true }, { io: s.io, connect: async () => null })).toBe(2);
    expect(s.err[0]).toContain('không kết nối được Postgres');
  });
});
