import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, readinessKey } from '@samsam/core/security/guardrail';
import { describe, expect, it } from 'vitest';
import G from './__fixtures__/kd_affiliate.golden.json' with { type: 'json' };
import {
  ALPHABET,
  buildKit,
  CODE_LEN,
  CODE_RE,
  CODES,
  commissionLine,
  linkFor,
  newCode,
  parseIds,
  type ReportRow,
  renderReport,
  vnd,
} from './kd-affiliate.js';
import { type KdAffiliateOpts, kdAffiliateMain } from './kd-orders-care.command.js';
import { commissionRate, KIT_TYPES } from './shared.js';

// Dịch tests/test_kd_affiliate.py (mã, hoa hồng, kit, CLI không DB). Golden = hàm Python thật
// (`__fixtures__/kd_affiliate.golden.json`).

const HONEY = 'mat-ong-sam-300ml';
const SAPH = 'saphraton-20v';
const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
const GOLD = {
  [HONEY]: { category: 'food' },
  [SAPH]: { category: 'tpbvsk' },
  [RUOU]: { category: 'alcohol' },
};
const RD: [string, string, string][] = [
  [HONEY, 'shopee', 'TP_THUONG'],
  [HONEY, 'web', 'TP_THUONG'],
  [HONEY, 'tiktok', 'CAM'],
  [RUOU, 'shopee', 'CAM'],
];
const DEALER = {
  code: 'DLM01',
  name: 'Đại lý MẪU 01',
  region: 'MIEN_TRUNG',
  status: 'active',
  commission_default: '10',
  source: 'dealer_regions.json',
};
const HONEY_TEXT =
  'Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao Nội dung có sử dụng AI';
const dft = (o: Record<string, unknown> = {}) => ({
  id: 5,
  status: 'approved',
  sku: HONEY,
  content_type: 'ads',
  text: HONEY_TEXT,
  is_ai: true,
  verified: true,
  ...o,
});
const rmap = (rd: [string, string, string][]) =>
  new Map(rd.map(([s, c, v]) => [readinessKey(s, c), v]));
const SRC = ['kd-affiliate.ts', 'shared.ts']
  .map((f) => readFileSync(join(import.meta.dirname, f), 'utf8'))
  .join('\n');

describe('kd_affiliate thuần (golden Python)', () => {
  it('newCode: CSPRNG, đúng mẫu, không mã đại lý, bảng 32 ký tự ≥ 50 bit; rand tiêm được', () => {
    const codes = Array.from({ length: 2000 }, () => newCode());
    expect(new Set(codes).size).toBe(2000);
    for (const c of codes) {
      expect(c).toMatch(/^SS[A-HJ-NP-Z2-9]{10}$/);
      expect(CODE_RE.test(c) && !c.startsWith('-') && !c.includes('DLM01')).toBe(true);
    }
    expect(new Set(ALPHABET).size).toBe(32);
    expect([...'0O1I'].some((x) => ALPHABET.includes(x))).toBe(false);
    expect(32 ** CODE_LEN >= 2 ** 50).toBe(true);
    expect(newCode({ choice: (s) => s[0] as string })).toBe(G.codes.first);
    let i = 0;
    const cyc = (s: string) => {
      i += 7;
      return s[i % s.length] as string;
    };
    expect(newCode({ choice: cyc })).toBe(G.codes.cyc);
    expect(SRC).toContain("randomInt } from 'node:crypto'");
    expect(SRC).not.toMatch(/Math\.random/);
  });

  it('không gửi / không LLM / không tự duyệt trong mã nguồn', () => {
    expect(SRC).not.toMatch(/smtp|fetch\(|node:https?|ai\/gateway|\.chat\(|decide\(|autoApprove/);
    expect(SRC.split('\n').filter((l) => l.includes('dealer_commission'))).toEqual([]);
  });

  it('linkFor: chỉ kênh web', () => {
    for (const [ch, want] of Object.entries(G.links))
      expect(linkFor('SSABCDEFGH23', ch)).toBe(want);
  });

  it('commissionLine: rượu online 0, nửa lên, đại lý ngưng/mã chưa kích hoạt/hủy = 0, thu hồi vẫn tính', () => {
    for (const c of G.commission) {
      const [dealer, cat, amt, cst, cancel] = c.args as [unknown, unknown, number, string, boolean];
      const r = commissionLine(dealer, cat, amt, cst, cancel);
      expect({ ...r, commission_vnd: Number(r.commission_vnd) }, JSON.stringify(c.args)).toEqual(
        c.out,
      );
    }
    expect(commissionRate(DEALER, 'alcohol', true)).toBe('0');
  });

  it('buildKit: mã chặn AFF_* (đại lý, rượu, nội dung chưa duyệt/lệch, readiness, guardrail); kit đạt có mã, không tên đại lý', () => {
    for (const k of G.kits) {
      const c = k.case as Record<string, unknown>;
      const dealer = 'dealer' in c ? c.dealer : DEALER;
      const drafts = 'drafts' in c ? c.drafts : [dft()];
      const rd = rmap((c.rd as [string, string, string][] | undefined) ?? RD);
      const r = buildKit(
        dealer,
        (c.channel as string) ?? 'shopee',
        'SSABCDEFGH23',
        drafts,
        GOLD,
        rd,
      );
      expect(r, JSON.stringify(c)).toEqual(k.out);
      if (r.code) expect(CODES).toContain(r.code);
    }
    const ok = buildKit(DEALER, 'shopee', 'SSABCDEFGH23', [dft()], GOLD, rmap(RD));
    const kit = ok.kit as string;
    expect(kit).toContain('SSABCDEFGH23');
    expect(kit).toContain('(ĐẠI LÝ MẪU)');
    expect(kit).not.toContain(DEALER.name);
    expect(kit).not.toContain('coupon=');
    expect(check(kit).ok).toBe(true);
    expect(KIT_TYPES).toEqual(G.kit_types);
  });

  it('parseIds / revoke chuẩn hóa / vnd / renderReport (BẢN NHÁP, không hash đơn)', () => {
    for (const [s, want] of G.ids) {
      const got = parseIds(s as string | null);
      expect(got === null ? null : got.map(String), String(s)).toEqual(
        want === null ? null : (want as (number | string)[]).map((x) => BigInt(x).toString()),
      );
    }
    for (const [s, c, ok] of G.revoke) {
      const code = (s as string).replace(/^\s+|\s+$/g, '').toUpperCase();
      expect(code).toBe(c);
      expect(CODE_RE.test(code)).toBe(ok);
    }
    for (const [n, want] of G.vnd) expect(vnd(n)).toBe(want);
    for (const r of G.reports)
      expect(renderReport(r.rows as ReportRow[], r.start, r.end_excl)).toBe(r.text);
  });
});

describe('kd_affiliate CLI (không DB)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const fail = async () => {
    throw new Error('không được connect');
  };
  const issue = { issue: true, dealer: 'DLM01', channel: 'shopee', draftIds: '1' };

  it.each<[KdAffiliateOpts]>([
    [{}],
    [{ issue: true, release: '1', by: 'x' }],
    [{ attribute: true, report: true, from: '2026-10-01', to: '2026-10-31' }],
    [issue],
    [{ ...issue, by: '  ' }],
    [{ ...issue, by: 'x'.repeat(101) }],
    [{ release: '3' }],
    [{ release: 'x', by: 'x' }],
    [{ revoke: 'SSABC', by: 'x' }],
    [{ ...issue, draftIds: 'a', by: 'x' }],
    [{ ...issue, draftIds: '1,2,3,4,5,6', by: 'x' }],
    [{ ...issue, dealer: 'dl m', by: 'x' }],
    [{ ...issue, channel: 'zalo', by: 'x' }],
    [{ issue: true, dealer: 'DLM01', draftIds: '1', by: 'x' }],
    [{ report: true, from: '2026-10-31', to: '2026-10-01' }],
    [{ report: true, from: '2000-01-01', to: '2026-10-01' }],
    [{ report: true, to: '2026-10-01' }],
  ])('tham số sai → exit 2 TRƯỚC connect %j', async (o) => {
    const s = io();
    expect(await kdAffiliateMain(o, { io: s.io, env: {}, connect: fail })).toBe(2);
    expect(s.err.join('\n')).toMatch(/^kd_affiliate: error: /);
  });

  it('DB down → exit 2', async () => {
    const s = io();
    expect(
      await kdAffiliateMain({ attribute: true }, { io: s.io, env: {}, connect: async () => null }),
    ).toBe(2);
    expect(s.err[0]).toContain('không kết nối được');
  });
});
