import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPath, repoPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/acc_invoice.golden.json' with { type: 'json' };
import * as inv from './acc-invoice.js';
import { type AccInvoiceOpts, accInvoiceMain } from './fin-ar-pnl.command.js';
import { orderHash } from './fin-common.js';

// Dịch phần KHÔNG DB của tests/test_acc_invoice.py: cấu hình, file yêu cầu xuất HĐ, gom lô, CSV/payload
// — golden = hàm Python THẬT (`agents/acc_invoice.py`) trên đầu vào cố định. Thông tin người mua
// (BUYER) là dữ liệu GIẢ, khai báo hằng để quét rò rỉ. Phần DB ở fin-ar-pnl.db.test.ts.

const REQS = repoPath('tests/fixtures/finance/invoice_requests_MAU.csv');
const BUYER = [
  'CONG TY GIA LAP HOA DON MAU',
  '0109999999',
  'SO 99 PHO HOA DON GIA LAP',
  'hoadon.gialap@example.invalid',
];
const MARKET_PII = ['nguoimuagia', 'NGUOI NHAN GIA', 'DUONG GIA LAP', 'FAKEINV'];
const leak = (text: string, needles = BUYER) => needles.filter((n) => text.includes(n));
const tmp = mkdtempSync(join(tmpdir(), 'acc-inv-'));
let seq = 0;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name: string, data: string | Buffer): string => {
  const dir = join(tmp, String(++seq));
  mkdirSync(dir);
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};
const cfg0 = (): inv.InvConfig => {
  const [c, why] = inv.loadConfig();
  expect(why).toBeNull();
  return c as inv.InvConfig;
};

type BatchCase = {
  name: string;
  orders: inv.Order[];
  yeu_cau: [string, string, inv.Buyer][];
  invoiced: inv.Invoiced[];
  trigger: string;
  csv_columns: string[];
  confirmed_by: string | null;
  attempt: number;
  batch: unknown;
  csv: string;
  title: string;
  payload: string;
  batch_key: string;
  csv_sha: string;
};
const cases = G.batches as unknown as BatchCase[];
const caseOf = (n: string) => cases.find((c) => c.name === n) as BatchCase;

describe('acc_invoice — golden Python', () => {
  it('cấu hình GIẢ ĐỊNH hợp lệ; mọi biến thể hỏng → cùng lý do', () => {
    const raw = readFileSync(inv.CONFIG_FILE, 'utf8');
    expect(raw).toContain('GIẢ ĐỊNH');
    expect(raw).toContain('25/10/2026');
    const cfg = cfg0();
    expect(cfg).toEqual(G.config);
    expect(cfg.invoice_trigger).toBe('giao_thanh_cong');
    expect(cfg.confirmed_by).toBeNull();
    expect(cfg.cancel_status.shopee).toEqual(['Đã hủy']);
    const mm = file('mm.json', readFileSync(dataPath('market_csv_map.json')));
    for (const c of G.config_cases as {
      name: string;
      raw: string;
      cfg: unknown;
      why: string | null;
    }[]) {
      expect(inv.loadConfig(file('inv.json', c.raw), mm), c.name).toEqual([c.cfg, c.why]);
    }
    expect(inv.loadConfig(inv.CONFIG_FILE, file('mm.json', G.config_mm_bad.mm))).toEqual([
      G.config_mm_bad.cfg,
      G.config_mm_bad.why,
    ]);
  });

  it('file yêu cầu: MST 10/10-3 ASCII, thiếu tên, trùng mã đơn — lỗi không lộ giá trị ô', async () => {
    const cfg = cfg0();
    const [got, errs] = await inv.readYeuCau(REQS, 'shopee', cfg);
    expect([Object.fromEntries(got), errs]).toEqual([G.reqs.got, G.reqs.errs]);
    expect([...got.keys()]).toEqual([inv.reqKey('shopee', orderHash('shopee', 'FAKEINV0005'))]);
    for (const c of G.reqs_cases as {
      name: string;
      text: string;
      got: unknown;
      errs: string[];
    }[]) {
      const [g, e] = await inv.readYeuCau(file('r.csv', c.text), 'shopee', cfg);
      expect([Object.fromEntries(g), e], c.name).toEqual([c.got, c.errs]);
      expect(leak(e.join(' '), ['CONG TY GIA', '010999999', 'e@x.vn']), c.name).toEqual([]);
    }
    const hdr = readFileSync(REQS, 'utf8').split('\n')[0]?.replace(/\r$/, '');
    const [g2, e2] = await inv.readYeuCau(
      file('r.csv', `${hdr}\nFAKEINV0001,A,0109999999,,\n`),
      'tiktok',
      cfg,
    );
    expect([Object.fromEntries(g2), e2]).toEqual([G.reqs_tiktok.got, G.reqs_tiktok.errs]);
  });

  it('gom lô / CSV / payload khớp Python mọi ca (thường, cần MST, đã lập, điều chỉnh, formula)', () => {
    const base = cfg0();
    for (const c of cases) {
      const cfg = {
        ...base,
        invoice_trigger: c.trigger,
        csv_columns: c.csv_columns,
        confirmed_by: c.confirmed_by,
      };
      const yc = new Map(c.yeu_cau.map(([ch, h, b]) => [inv.reqKey(ch, h), b]));
      const b = inv.buildBatch(c.orders, yc, c.invoiced, cfg, '2026-10-12');
      expect(b, c.name).toEqual(c.batch);
      expect(inv.renderCsv(b, cfg, c.attempt).toString('utf8'), c.name).toBe(c.csv);
      expect(inv.renderPayload(b, c.batch_key, c.csv_sha, cfg, c.attempt), c.name).toEqual([
        c.title,
        c.payload,
      ]);
    }
  });

  it('đếm lô MẪU: 13 dòng (12 thường + 1 cần MST), loại 2 hủy + 1 chưa đạt mốc; đổi mốc → 14', () => {
    const b = caseOf('base').batch as inv.Batch;
    expect(b.lines.map((x) => x.kind).filter((k) => k === 'thuong')).toHaveLength(12);
    expect(b.lines.filter((x) => x.kind === 'can_mst')).toHaveLength(1);
    expect(b.excluded).toEqual({ huy: 2, chua_dat_moc: 1, da_lap: 0 });
    expect((caseOf('ban_giao').batch as inv.Batch).lines).toHaveLength(14);
    const p = caseOf('pending_first').batch as inv.Batch;
    expect([p.lines.length, p.excluded.da_lap]).toEqual([12, 1]);
  });

  it('người mua CHỈ trong CSV nháp — payload/title không PII, chỉ hash rút gọn, qua guardrail', () => {
    const c = caseOf('base');
    expect(leak(c.csv).sort()).toEqual([...BUYER].sort());
    expect(c.csv.split(G.config.retail_buyer).length - 1).toBeGreaterThanOrEqual(12);
    expect(leak(c.csv, MARKET_PII)).toEqual([]);
    expect(leak(c.title + c.payload)).toEqual([]);
    expect(c.payload).toContain(`csv_sha256: ${'c'.repeat(64)}`);
    expect(c.payload).toContain('BẢN NHÁP — agent không ký số, không phát hành');
    for (const x of (c.batch as inv.Batch).lines) expect(c.payload).not.toContain(x.order_id_hash);
    expect(check(c.payload).ok).toBe(true);
  });

  it('chống formula injection; dòng điều chỉnh trỏ HĐ gốc (không retail_buyer)', () => {
    const f = caseOf('formula').csv;
    expect(f).toContain("'=HYPERLINK");
    expect(f).not.toContain(',=HYPERLINK');
    for (const k of ['can_mst', 'thuong']) {
      const c = caseOf(`adj_${k}`);
      expect(c.csv).not.toContain(G.config.retail_buyer);
      expect(c.csv).toContain('THEO HĐ GỐC lô 2026-10-11-abcdefabcdef');
      expect(c.payload).toContain('người mua THEO HĐ GỐC');
      expect(c.payload).toContain('số tiền ghi DƯƠNG = giá trị điều chỉnh GIẢM');
      expect(c.csv.includes('gốc cần MST')).toBe(k === 'can_mst');
    }
    const y = caseOf('adj_yeu_cau');
    expect(leak(y.csv).sort()).toEqual([...BUYER].sort());
    expect(y.payload).toContain('người mua theo file yêu cầu');
    expect(leak(y.payload)).toEqual([]);
    expect((caseOf('adj_already').batch as inv.Batch).lines).toEqual([]);
  });

  it('cell_safe + MST chỉ chữ số ASCII, fullmatch', () => {
    for (const [v, want] of G.cell_safe as [string | number | null, string][]) {
      expect(inv.cellSafe(v), String(v)).toBe(want);
    }
    for (const [s, ok] of G.mst_re as [string, boolean][]) expect(inv.MST_RE.test(s), s).toBe(ok);
  });

  it('module không mạng/LLM (không import fetch/gateway/http)', () => {
    const src = readFileSync(join(import.meta.dirname, 'acc-invoice.ts'), 'utf8');
    expect(src).not.toMatch(/node:https?|fetch\(|ai\/gateway|nodemailer|undici/);
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

describe('acc_invoice CLI (không DB)', () => {
  it.each<[AccInvoiceOpts]>([
    [{ batch: true, verifyDraft: '1', file: 'x.csv' }],
    [{ batch: true, day: '2026-13-01' }],
    [{ verifyDraft: '1' }],
    [{ batch: true, yeuCau: 'x.csv' }],
    [{}],
    [{ verifyDraft: 'x', file: 'a.csv' }],
    [{ batch: true, yeuCau: 'x.csv', channel: 'lazada' }],
    [{ verifyDraft: '1', file: 'a.csv', day: '2026-10-01' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await accInvoiceMain(o, { io: s.io, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^acc_invoice: error: /);
  });

  it('file yêu cầu lỗi → exit 1, 0 connect, không lộ MST/tên', async () => {
    const hdr = readFileSync(REQS, 'utf8').split('\n')[0]?.replace(/\r$/, '');
    const p = file('r.csv', `${hdr}\nFAKEINV0001,CONG TY GIA,12345,DC,e@x.vn\n`);
    const s = io();
    expect(
      await accInvoiceMain(
        { batch: true, yeuCau: p, channel: 'shopee' },
        { io: s.io, connect: fail },
      ),
    ).toBe(1);
    const out = s.out.join('\n');
    expect(out).toContain('không connect, không ghi gì');
    expect(out).not.toContain('12345');
    expect(out).not.toContain('CONG TY GIA');
  });

  it('cấu hình hỏng → exit 1 trước connect; DB down → exit 2', async () => {
    let s = io();
    const rc = await accInvoiceMain(
      { batch: true },
      { io: s.io, connect: fail, invConfig: file('inv.json', '{"invoice_trigger": "x"}') },
    );
    expect(rc).toBe(1);
    expect(s.out[0]).toContain('invoice_trigger phải thuộc');
    s = io();
    expect(await accInvoiceMain({ batch: true }, { io: s.io, connect: async () => null })).toBe(2);
    expect(s.err[0]).toContain('không kết nối được Postgres');
  });
});
