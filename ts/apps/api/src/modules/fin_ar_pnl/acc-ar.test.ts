import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { featureFor } from '@samsam/core/rollout/rollout';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/acc_ar.golden.json' with { type: 'json' };
import * as ar from './acc-ar.js';
import { type AccArOpts, accArMain } from './fin-ar-pnl.command.js';
import { decStr, parseDec } from './fin-common.js';

// Dịch phần KHÔNG DB của tests/test_acc_ar.py + tests/test_v13_c06_daily_ar.py (nháp thư nhắc nợ):
// golden = chạy hàm Python THẬT (`agents/acc_ar.py`) trên đầu vào cố định (script sinh ở scratchpad,
// golden.py) — TS phải ra y hệt. Phần DB ở fin-ar-pnl.db.test.ts.

const AR_FILE = repoPath('tests/fixtures/finance/dealer_ar_MAU.csv');
const AS_OF = '2026-10-12';
const tmp = mkdtempSync(join(tmpdir(), 'acc-ar-'));
let seq = 0;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const file = (name: string, data: string | Buffer): string => {
  const dir = join(tmp, String(++seq));
  mkdirSync(dir);
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

type Cfg = {
  term_days: number;
  rates_pct: Record<string, string>;
  zero_rules: unknown[];
  tncn_types: string[];
};
const cfgOut = (c: ar.ArConfig | null) =>
  c && {
    ...c,
    rates_pct: Object.fromEntries(Object.entries(c.rates_pct).map(([k, v]) => [k, decStr(v)])),
  };
const cfgIn = (c: Cfg): ar.ArConfig =>
  ({
    ...c,
    rates_pct: Object.fromEntries(Object.entries(c.rates_pct).map(([k, v]) => [k, parseDec(v)])),
  }) as ar.ArConfig;
const lineOut = (xs: ar.CommissionLine[]) => xs.map((x) => ({ ...x, ty_le: decStr(x.ty_le) }));
const openOut = (m: Map<string, ar.OpenDealer>) => Object.fromEntries(m);

describe('acc_ar — golden Python', () => {
  it('cấu hình thật + mọi biến thể hỏng → cùng lý do (fail-closed, exit 1 trước connect)', () => {
    expect(cfgOut(ar.loadConfig()[0])).toEqual(G.config);
    for (const c of G.config_cases as {
      name: string;
      raw?: string;
      raw_b64?: string;
      cfg: Cfg | null;
      why: string | null;
    }[]) {
      const p = file(
        'dealer_commission.json',
        c.raw_b64 === undefined ? (c.raw as string) : Buffer.from(c.raw_b64, 'base64'),
      );
      const [cfg, why] = ar.loadConfig(p);
      expect([cfgOut(cfg), why], c.name).toEqual([c.cfg, c.why]);
    }
  });

  it('age_bucket biên 0/30/31/60/61/90/91/400, tương lai → null', () => {
    for (const [days, b] of G.age_bucket as [number, string | null][]) {
      const d = new Date(Date.UTC(2026, 9, 12) - days * 86_400_000).toISOString().slice(0, 10);
      expect(ar.ageBucket(d, AS_OF), String(days)).toBe(b);
    }
  });

  it('read_ar: fixture + mọi lỗi nêu số dòng + tên field, không giá trị ô (PII)', async () => {
    const [es, errs, sha] = await ar.readAr(AR_FILE);
    expect([es, errs, sha]).toEqual([G.fixture.entries, G.fixture.errs, G.fixture.sha]);
    for (const c of G.read_ar as {
      name: string;
      text: string;
      entries: unknown;
      errs: string[];
      sha: string | null;
    }[]) {
      const got = await ar.readAr(file('a.csv', c.text));
      expect(got, c.name).toEqual([c.entries, c.errs, c.sha]);
    }
    expect(await ar.readAr(file('a.txt', 'x'))).toEqual([
      G.read_ar_ext.entries,
      G.read_ar_ext.errs,
      G.read_ar_ext.sha,
    ]);
    const bad = await ar.readAr(file('bad.csv', Buffer.from(G.read_ar_badutf8.b64, 'base64')));
    expect(bad).toEqual([G.read_ar_badutf8.entries, G.read_ar_badutf8.errs, G.read_ar_badutf8.sha]);
    // cột lạ chứa tên đại lý → lỗi không in giá trị ô
    const extra = (G.read_ar as { name: string; errs: string[] }[]).find(
      (x) => x.name === 'extra_col',
    );
    expect(extra?.errs.join(' ')).not.toContain('NGUYEN VAN GIA');
  });

  it('aging FIFO / dư có / điều chỉnh âm / quá hạn biên + open_items', () => {
    for (const c of G.aging as {
      name: string;
      entries: ar.ArEntry[];
      term: number;
      rows: unknown;
      open: unknown;
    }[]) {
      expect(ar.aging(c.entries, AS_OF, c.term), c.name).toEqual(c.rows);
      expect(openOut(ar.openItems(c.entries, AS_OF, c.term)), c.name).toEqual(c.open);
    }
  });

  it('commission: rượu online = 0, thiếu SKU/kênh fail-closed, TNCN, sàn 0, ROUND_HALF_UP', () => {
    const cfg = cfgIn(G.config as Cfg);
    for (const c of G.commission as {
      name: string;
      entries: ar.ArEntry[];
      start: string;
      end: string;
      lines: unknown;
    }[]) {
      expect(lineOut(ar.commission(c.entries, G.skus, cfg, c.start, c.end)), c.name).toEqual(
        c.lines,
      );
    }
    const c2 = G.commission_cfg2;
    const cfg2 = cfgIn({
      ...(G.config as Cfg),
      rates_pct: c2.cfg_rates,
      zero_rules: c2.zero_rules,
    });
    expect(
      lineOut(ar.commission(c2.entries as ar.ArEntry[], G.skus, cfg2, '2026-08-13', '2026-10-13')),
    ).toEqual(c2.lines);
  });

  it('mục quá hạn bản tin: chỉ mã đại lý + số tiền (không chứng từ)', async () => {
    const [es] = await ar.readAr(AR_FILE);
    expect(ar.overdueSection(ar.aging(es, AS_OF, 30), AS_OF)).toEqual(G.overdue_fixture);
    expect(ar.overdueSection([], AS_OF)).toEqual(G.overdue_empty);
    expect(ar.overdueSection(ar.aging(es, AS_OF, 5), AS_OF)).toEqual(G.overdue_short_term);
    const text = G.overdue_fixture.join('\n');
    expect(text).toContain('`DL-HN01`');
    expect(text).not.toContain('PX-GIA');
  });

  it('nháp thư nhắc nợ: căn cứ + placeholder, chỉ đại lý trong sổ, id theo trạng thái nợ, che PII', () => {
    for (const c of G.reminders as unknown as {
      name: string;
      entries: ar.ArEntry[];
      as_of: string;
      dealers: Record<string, string>;
      sources: Record<string, [string, string][]>;
      res: unknown;
    }[]) {
      expect(ar.reminderDrafts(c.entries, c.as_of, 30, c.dealers, c.sources), c.name).toEqual(
        c.res,
      );
    }
    const f = G.reminders_fixture;
    expect(
      ar.reminderDrafts(
        G.fixture.entries as ar.ArEntry[],
        AS_OF,
        30,
        f.dealers,
        f.sources as unknown as Record<string, [string, string][]>,
      ),
    ).toEqual(f.res);
    const basis =
      (G.reminders[0] as { res: { drafts: { body: string }[] } }).res.drafts[0]?.body ?? '';
    for (const ph of [
      '{{TEN_DAI_LY}}',
      '{{NGUOI_LIEN_HE}}',
      '{{HAN_THANH_TOAN}}',
      '{{NGUOI_KY}}',
    ]) {
      expect(basis).toContain(ph);
    }
    expect(basis).toContain('KHÔNG gửi');
    const pii = (G.reminders as { name: string; res: { drafts: { body: string }[] } }[]).find(
      (x) => x.name === 'pii',
    );
    expect(pii?.res.drafts[0]?.body).not.toContain('0905123456');
  });

  it('id đợt: cùng trạng thái nợ → cùng object_id; trả bớt → đợt mới', () => {
    const by = Object.fromEntries(
      (G.reminders as { name: string; res: { drafts: { object_id: string }[] } }[]).map((c) => [
        c.name,
        c.res.drafts[0]?.object_id,
      ]),
    );
    expect(by.state1).toBe(by.state2);
    expect(by.paid).not.toBe(by.state1);
  });

  it('regex mã/SKU fullmatch (không nhận xuống dòng cuối, không chữ thường)', () => {
    expect(ar.CODE_RE.test('DL-01\n')).toBe(false);
    expect(ar.CODE_RE.test('dl-01')).toBe(false);
    expect(ar.CODE_RE.test('DL-01')).toBe(true);
    expect(ar.SKU_RE.test('savina-12v\n')).toBe(false);
  });

  it('ánh xạ tính năng: ar_reminder của agent:acc_ar → finance-03.3', () => {
    expect(
      featureFor({
        table: 'approval_queue',
        block: 'finance',
        object_type: 'ar_reminder',
        created_by: ar.AGENT,
      }),
    ).toBe('finance-03.3');
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

describe('acc_ar CLI (không DB)', () => {
  it.each<[AccArOpts]>([
    [{ aging: true, asOf: '2026-13-01' }],
    [{ aging: true, bulletin: true }],
    [{ commission: true, from: '2026-10-01' }],
    [{ commission: true, from: '2026-10-02', to: '2026-10-01' }],
    [{ load: 'x.csv', asOf: '2026-10-01' }],
    [{}],
    [{ reminders: true, aging: true }],
    [{ aging: true, dryRun: true }],
    [{ reminders: true, from: '2026-01-01' }],
    [{ aging: true, asOf: '' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await accArMain(o, { io: s.io, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^acc_ar: error: /);
  });

  it('file lỗi → exit 1, 0 connect, chỉ số dòng + field', async () => {
    const hdr = 'dealer_code,dealer_type,kind,doc_ref,doc_date,due_date,amount_vnd,sku_key,channel';
    const p = file(
      'a.csv',
      `${hdr}\nDL-01,ca_nhan,thanh_toan,,2026-10-01,,5,,\nDL 02,ca_nhan,phat_sinh,,2026-10-01,,5,,\n`,
    );
    const s = io();
    expect(await accArMain({ load: p }, { io: s.io, connect: fail })).toBe(1);
    expect(s.out.join('\n')).toContain('không connect, không nạp gì');
    expect(s.out).toHaveLength(3);
  });

  it('cấu hình hỏng → exit 1 trước connect', async () => {
    const s = io();
    const rc = await accArMain(
      { aging: true },
      { io: s.io, connect: fail, arConfig: file('c.json', '{') },
    );
    expect(rc).toBe(1);
    expect(s.out).toEqual(['[err] không đọc được c.json: JSONDecodeError — không connect.']);
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(await accArMain({ aging: true }, { io: s.io, connect: async () => null })).toBe(2);
    expect(s.err[0]).toContain('không kết nối được Postgres');
  });
});
