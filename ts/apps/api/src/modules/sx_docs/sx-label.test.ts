import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import G from './__fixtures__/sx_label.golden.json' with { type: 'json' };
import * as di from './doc-intake.js';
import { cap, makePdf } from './sx-docs.testing.js';
import * as sx from './sx-label.js';

// Dịch tests/test_sx_label.py (phần thuần + CLI không DB; phần DB ở sx-docs.db.test.ts). Golden =
// hàm Python THẬT (low/flat/extract/name_tokens/compare/payload_of/validate_rules/spec_of/ref_code)
// trên đầu vào cố định — ngày là chuỗi ISO. Dữ liệu nhãn GIẢ LẬP.

const TMP = mkdtempSync(join(tmpdir(), 'sxdocs-lbl-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const RULES = sx.loadRules();
const GOLDEN: Record<string, sx.Sku> = Object.fromEntries(
  (
    JSON.parse(readFileSync(repoPath('data', 'golden_skus.json'), 'utf8')).skus as Record<
      string,
      unknown
    >[]
  ).map((s) => [
    s.sku_key,
    {
      sku_key: s.sku_key,
      name: s.name,
      category: s.category,
      pack_spec: s.pack_spec,
      receipt_no: s.receipt_no,
    } as sx.Sku,
  ]),
);
const SAP = GOLDEN['saphraton-20v'];
const RUOU_KEY = 'ruou-sam-chai-thuy-tinh-500ml';
const RUOU = GOLDEN[RUOU_KEY];
const GOOD = (G.cases.find((c) => c.name === 'good') as { text: string }).text;

type Case = {
  name: string;
  text: string;
  sku: sx.Sku;
  listings: sx.Listing[];
  lots: Record<string, sx.Lot>;
  today: string;
  findings: sx.Finding[];
  payload: [string, string, string];
  ref: string;
  restricted: boolean;
};

// ------------------------------------------------------------ golden
describe('golden Python', () => {
  it.each(G.lowflat as [string, string, string][])('low/flat %#', (t, lo, fl) => {
    expect(sx.low(t)).toBe(lo);
    expect(sx.flat(t)).toBe(fl);
  });
  it.each(G.extract as [string, sx.Fields][])('extract %#', (t, want) => {
    expect(sx.extract(t)).toEqual(want);
  });
  it.each(G.names as [string, string[]][])('name_tokens %#', (n, want) => {
    expect(sx.nameTokens(n, RULES.name_ignore)).toEqual(want);
  });
  it.each(G.cases as unknown as Case[])('compare + payload_of: $name', (c) => {
    const f = sx.compare(sx.extract(c.text), c.sku, RULES, c.listings, c.lots, c.today);
    expect(f).toEqual(c.findings);
    expect(sx.payloadOf(c.sku, f, 'ab'.repeat(32))).toEqual(c.payload);
    expect(sx.skuRef(c.sku)).toBe(c.ref);
    expect(sx.restricted(c.sku)).toBe(c.restricted);
  });
  it.each(
    G.payloads as {
      findings: sx.Finding[];
      sha: string;
      sap: [string, string, string];
      ruou: [string, string, string];
    }[],
  )('payload_of %#', (p) => {
    expect(sx.payloadOf(SAP, p.findings, p.sha)).toEqual(p.sap);
    expect(sx.payloadOf(RUOU, p.findings, p.sha)).toEqual(p.ruou);
  });
  it.each(
    G.rules_variants as {
      kind: string;
      doc: unknown;
      res: { ok: boolean; err?: string; status?: string; name_ignore?: string[] };
    }[],
  )('validate_rules $kind', (v) => {
    if (v.res.ok) {
      const r = sx.validateRules(v.doc);
      expect(r.status).toBe(v.res.status);
      expect([...r.name_ignore].sort()).toEqual(v.res.name_ignore);
    } else {
      expect(() => sx.validateRules(v.doc)).toThrow(sx.LabelError);
      try {
        sx.validateRules(v.doc);
      } catch (e) {
        expect((e as Error).message).toBe(v.res.err);
      }
    }
  });
  it.each(G.spec_of as [string | null, string | null][])('spec_of %#', (t, want) => {
    expect(sx.specOf(t)).toBe(want);
  });
});

// ------------------------------------------------------------ luật bằng chữ (test_sx_label.py)
const kinds = (
  text: string,
  o: Partial<{ sku: sx.Sku; listings: sx.Listing[]; lots: Record<string, sx.Lot> }> = {},
) =>
  sx
    .compare(sx.extract(text), o.sku ?? SAP, RULES, o.listings ?? [], o.lots ?? {}, '2026-10-12')
    .map((x) => x.kind);
const LOT_OK: Record<string, sx.Lot> = {
  'SAP-260901': {
    sku_key: 'saphraton-20v',
    mfg_date: '2026-09-01',
    exp_date: '2028-09-01',
    intake_status: 'passed',
  },
};

describe('so (luật)', () => {
  it('nhãn sạch → không lệch', () => {
    const listing = [
      { channel: 'shopee', item_id: '24825885894', title: 'Saphraton 20 viên nang mềm' },
    ];
    expect(kinds(GOOD, { listings: listing, lots: LOT_OK })).toEqual([]);
  });
  it('HSD đúng hôm nay chưa hết hạn; hôm qua → het_han', () => {
    expect(kinds(GOOD.replace('01/09/2028', '12/10/2026'))).not.toContain('het_han');
    expect(kinds(GOOD.replace('01/09/2028', '11/10/2026'))).toContain('het_han');
  });
  it('lô thuộc SKU khác → chỉ lo_khac_sku; lô chưa kiểm → lo_chua_kiem', () => {
    const other = { 'SAP-260901': { ...LOT_OK['SAP-260901'], sku_key: 'savina-12v' } };
    expect(kinds(GOOD, { lots: other })).toEqual(['lo_khac_sku']);
    const pend = { 'SAP-260901': { ...LOT_OK['SAP-260901'], intake_status: 'pending' } };
    expect(kinds(GOOD, { lots: pend })).toEqual(['lo_chua_kiem']);
  });
  it('listing: mã lạ → (mã lạ), không lọt ký tự điều khiển; nhãn không quy cách → không so listing', () => {
    const bad = [{ channel: 'tiktok', item_id: 'x\x1b[2J', title: 'Saphraton 30 viên' }];
    const f = sx.compare(sx.extract(GOOD), SAP, RULES, bad, LOT_OK, '2026-10-12');
    expect(f.map((x) => x.kind)).toEqual(['listing_quy_cach_lech']);
    expect(f[0].msg).toContain('(mã lạ)');
    expect(f[0].msg).not.toContain('\x1b');
  });
  it('không chép chữ tự do của nhãn vào phát hiện', () => {
    const t = `${GOOD}Chữa bách bệnh, uống là khỏi bệnh 0912345678\n`;
    const blob = JSON.stringify(sx.compare(sx.extract(t), SAP, RULES, [], {}, '2026-10-12'));
    expect(blob).not.toContain('bách');
    expect(blob).not.toContain('0912345678');
  });
});

// ------------------------------------------------------------ payload
describe('payload', () => {
  it('SKU rượu: không lộ sku_key/tên, qua guardrail, không cần bản rút gọn', () => {
    const f = sx.compare(sx.extract('Nhãn trắng'), RUOU, RULES, [], {}, '2026-10-12');
    expect(f.length).toBeGreaterThanOrEqual(3);
    const [oid, title, payload] = sx.payloadOf(RUOU, f, 'ab'.repeat(32));
    const ref = sx.skuRef(RUOU);
    expect(ref).toMatch(/^H-[0-9a-f]{8}$/);
    for (const s of [oid, title, payload]) {
      expect(s).not.toContain(RUOU_KEY);
      expect(sx.low(s)).not.toContain('ruou');
      expect(s).toContain(ref);
    }
    expect(guardrailCheck(payload).ok).toBe(true);
    expect(guardrailCheck(title).ok).toBe(true);
    expect(payload).not.toContain('chi tiết bị ẩn');
    expect(title).toContain(`${f.length} điểm lệch`);
  });
  it.each(Object.keys(GOLDEN).sort())(
    'mọi SKU golden, nhãn trắng → payload qua guardrail: %s',
    (k) => {
      const f = sx.compare(sx.extract('nhãn trắng'), GOLDEN[k], RULES, [], {}, '2026-10-12');
      const payload = sx.payloadOf(GOLDEN[k], f, 'ab'.repeat(32))[2];
      expect(f.length).toBeGreaterThan(0);
      expect(guardrailCheck(payload).ok).toBe(true);
      expect(payload).not.toContain('chi tiết bị ẩn');
    },
  );
  it('payload trượt guardrail → bản rút gọn, không đẩy chữ bẩn', () => {
    const [oid, , payload] = sx.payloadOf(
      SAP,
      [{ kind: 'x', msg: 'khỏi bệnh ngay' }],
      'cd'.repeat(32),
    );
    expect(payload).not.toContain('khỏi bệnh');
    expect(payload).toContain('chi tiết bị ẩn');
    expect(guardrailCheck(payload).ok).toBe(true);
    expect(oid.startsWith('sxlabel:')).toBe(true);
  });
  it('object_id theo ĐỢT (nhãn khác / phát hiện khác = đợt mới)', () => {
    const f = [{ kind: 'a', msg: 'm' }];
    const a = sx.payloadOf(SAP, f, 'ab'.repeat(32))[0];
    expect(a).toBe(sx.payloadOf(SAP, structuredClone(f), 'ab'.repeat(32))[0]);
    expect(a).not.toBe(sx.payloadOf(SAP, f, 'ac'.repeat(32))[0]);
    expect(a).not.toBe(sx.payloadOf(SAP, [...f, ...f], 'ab'.repeat(32))[0]);
    expect(a.startsWith('sxlabel:saphraton-20v:abababababab:')).toBe(true);
  });
});

// ------------------------------------------------------------ cấu hình
describe('label_rules', () => {
  it('tệp repo: GIẢ ĐỊNH, tpbvsk = dksp, đủ khuyến cáo', () => {
    expect(RULES.status).toContain('GIẢ ĐỊNH');
    expect(RULES.registration.tpbvsk).toBe('dksp');
    const ids = new Set(RULES.required.tpbvsk.map((i) => i.id));
    expect(ids.has('khuyen_cao_1') && ids.has('khuyen_cao_2')).toBe(true);
  });
  it.each([
    ['missing', null],
    ['empty', '  '],
    ['broken', '{"status": '],
    ['obj_empty', '{}'],
    ['only_doc', '{"_doc": "x"}'],
    ['not_obj', '[1]'],
    ['bad_utf8', Buffer.from([0xff, 0xfe, 0x7b])],
  ] as [string, string | Buffer | null][])('tệp hỏng (%s) → LabelError', (name, raw) => {
    const p = join(TMP, `r-${name}.json`);
    if (raw !== null) writeFileSync(p, raw);
    expect(() => sx.loadRules(p)).toThrow(sx.LabelError);
  });
  it('BOM utf-8-sig được nhận', () => {
    const p = join(TMP, 'r-bom.json');
    writeFileSync(p, `﻿${readFileSync(sx.RULES_FILE, 'utf8')}`);
    expect(sx.loadRules(p).status).toBe(RULES.status);
  });
  it('luật lấy từ dữ liệu, không hardcode', () => {
    const d = JSON.parse(readFileSync(sx.RULES_FILE, 'utf8'));
    d.required.food = [{ id: 'nguon_goc', phrase: 'xuất xứ', label: 'dòng xuất xứ' }];
    const p = join(TMP, 'r-food.json');
    writeFileSync(p, JSON.stringify(d));
    const rules = sx.loadRules(p);
    const t = 'MẬT ONG SÂM\n120ml x 1 hũ\nHSD: 18 tháng\nSố tự công bố: 01/SS/24\n';
    const f = sx.compare(
      sx.extract(t),
      GOLDEN['mat-ong-sam-120ml-1hu'],
      rules,
      [],
      {},
      '2026-10-12',
    );
    expect(f.map((x) => x.kind)).toEqual(['bat_buoc_thieu']);
  });
});

// ------------------------------------------------------------ CLI không DB
describe('CLI sx-label (không DB)', () => {
  const saved = { ...di.PROVIDERS };
  afterEach(() => {
    for (const k of Object.keys(di.PROVIDERS)) if (!(k in saved)) delete di.PROVIDERS[k];
    Object.assign(di.PROVIDERS, saved);
  });
  let connects = 0;
  beforeEach(() => {
    connects = 0;
  });
  const run = async (o: sx.SxLabelOpts, env: Record<string, string> = {}, rulesFile?: string) => {
    const t = cap();
    const rc = await sx.sxLabelMain(o, {
      io: t.io,
      env: { NODE_ENV: 'test', ...env },
      connect: async () => {
        connects++;
        return null; // DB down
      },
      rulesFile,
    });
    return { rc, ...t };
  };
  const label = (data: string | Buffer, name = 'n.txt') => {
    const p = join(TMP, `${Math.random().toString(36).slice(2)}-${name}`);
    writeFileSync(p, data);
    return p;
  };

  it.each([
    [{}],
    [{ sku: 'saphraton-20v' }],
    [{ text: 'a.txt' }],
    [{ sku: 'saphraton-20v', text: 'a.txt', image: 'b.png' }],
    [{ sku: 'Bad SKU!', text: 'a.txt' }],
    [{ sku: 'a'.repeat(65), text: 'a.txt' }],
  ] as [sx.SxLabelOpts][])('sai usage → exit 2, không connect %#', async (o) => {
    expect((await run(o)).rc).toBe(2);
    expect(connects).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n\t'],
    ['bad_utf8', Buffer.from([0xff, 0xfe, 0x61, 0x62, 0x63])],
    ['too_big', Buffer.alloc(sx.MAX_TEXT_BYTES + 1, 0x78)],
    ['missing', null],
  ] as [string, string | Buffer | null][])(
    'tệp nhãn hỏng (%s) → exit 1, không connect',
    async (_n, c) => {
      const p = c === null ? join(TMP, 'missing.txt') : label(c);
      const r = await run({ sku: 'saphraton-20v', text: p });
      expect(r.rc).toBe(1);
      expect(connects).toBe(0);
      expect(r.err.join('\n')).toContain('không connect');
    },
  );

  it('ảnh + OCR_PROVIDER chưa đặt → exit 2 kèm hướng dẫn, không connect', async () => {
    const r = await run({ sku: 'saphraton-20v', image: label('\x89PNG', 'n.png') });
    expect(r.rc).toBe(2);
    const err = r.err.join('\n');
    expect(err).toContain('OCR_PROVIDER');
    expect(err).toContain('--text');
    expect(connects).toBe(0);
  });

  it('provider lạ / nước ngoài → exit 2, không gửi ảnh', async () => {
    const p = label('\x89PNG', 'n.png');
    expect(
      (await run({ sku: 'saphraton-20v', image: p }, { OCR_PROVIDER: 'google_vision' })).rc,
    ).toBe(2);
    const called: string[] = [];
    di.PROVIDERS.ngoai = [
      async (x) => {
        called.push(x);
        return 'x';
      },
      false,
    ];
    expect((await run({ sku: 'saphraton-20v', image: p }, { OCR_PROVIDER: 'ngoai' })).rc).toBe(2);
    expect(called).toEqual([]);
    expect(connects).toBe(0);
  });

  it('đuôi lạ / tệp thiếu → exit 1', async () => {
    di.PROVIDERS.trongnuoc = [async () => GOOD, true];
    const env = { OCR_PROVIDER: 'trongnuoc' };
    expect((await run({ sku: 'saphraton-20v', image: label('x', 'n.gif') }, env)).rc).toBe(1);
    expect((await run({ sku: 'saphraton-20v', image: join(TMP, 'khong.png') }, env)).rc).toBe(1);
    expect(connects).toBe(0);
  });

  it('OCR trong nước ra chữ → tới bước DB (DB down → exit 2); OCR trắng → exit 1', async () => {
    di.PROVIDERS.trongnuoc = [async () => GOOD, true];
    const p = label('\x89PNG', 'n.jpg');
    expect((await run({ sku: 'saphraton-20v', image: p }, { OCR_PROVIDER: 'trongnuoc' })).rc).toBe(
      2,
    );
    expect(connects).toBe(1);
    di.PROVIDERS.trongnuoc = [async () => '   ', true];
    expect((await run({ sku: 'saphraton-20v', image: p }, { OCR_PROVIDER: 'trongnuoc' })).rc).toBe(
      1,
    );
    expect(connects).toBe(1);
  });

  it('PDF có lớp chữ → không cần OCR, tới DB; PDF scan + provider none → exit 2 không connect', async () => {
    const lines = GOOD.normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replaceAll('Đ', 'D')
      .replaceAll('đ', 'd')
      .split('\n')
      .filter(Boolean);
    const pdf = label(makePdf(lines), 'n.pdf');
    expect((await run({ sku: 'saphraton-20v', image: pdf })).rc).toBe(2);
    expect(connects).toBe(1);
    const scan = label(makePdf(null), 's.pdf');
    const r = await run({ sku: 'saphraton-20v', image: scan });
    expect(r.rc).toBe(2);
    expect(r.err.join('\n')).toContain('PDF không có lớp chữ');
    expect(connects).toBe(1);
  });

  it('luật hỏng → exit 1, không connect', async () => {
    const bad = label('{}', 'r.json');
    expect((await run({ sku: 'saphraton-20v', text: label(GOOD) }, {}, bad)).rc).toBe(1);
    expect(connects).toBe(0);
  });

  it('không LLM/HTTP, không câu SQL ghi trong module', () => {
    const src = readFileSync(new URL('./sx-label.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ai\/gateway|openai|anthropic|fetch\(/);
    expect(src).not.toMatch(/'\s*(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
  });
});
