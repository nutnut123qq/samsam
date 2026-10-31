import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vnDate } from '@samsam/core/ops/period';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import type pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HIDDEN } from '../ra_kenh/ra-kenh.js';
import * as au from './ceo-audit.js';
import * as cd from './ceo-decisions.js';
import {
  type CliDeps,
  ceoAuditMain,
  ceoDecisionsMain,
  ceoPromoMain,
  ceoRiskMain,
} from './ceo-misc.command.js';
import * as cp from './ceo-promo.js';
import * as cr from './ceo-risk.js';
import { openDatabaseUrl } from './common.js';

// Dịch phần THUẦN + CLI không DB của tests/test_ceo_audit.py, test_ceo_risk.py,
// test_ceo_decisions.py, test_v14_p5_mkt_ceo_intel.py (ceo-04.1 THUẦN), test_r12_dot2.py (cổng TẮT
// ceo_risk/ceo_audit), test_r12_dot4.py (--list in việc chờ), test_docx_p2.py (rượu + chỉ dẫn địa
// lý). Kỳ vọng VIẾT SẴN như Python (không tính lại bằng chính module). Không DB: `open` giả ném lỗi
// (chứng minh chặn TRƯỚC connect); đường DB thật ở ceo-misc.db.test.ts.

const SRC = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'ceo-misc-'));
let seq = 0;
const fresh = () => {
  const d = join(tmp, String(seq++));
  mkdirSync(d);
  return d;
};
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const noConnect = async (): Promise<pg.Pool | null> => {
  throw new Error('connect không được gọi');
};
const cap = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};
const deps = (c: ReturnType<typeof cap>, extra: Partial<CliDeps> = {}): CliDeps => ({
  ...c.deps,
  open: noConnect,
  wire: null,
  env: {},
  ...extra,
});

beforeEach(() => {
  settings.forceMode = 'van_hanh';
});
afterEach(() => {
  settings.forceMode = null;
});

const vn = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 7, mi));

// ================================================================= ceo_audit

describe('ceo_audit — thuần', () => {
  it('rate / compliance / norm_title (test_rate_and_compliance_pure)', () => {
    expect([au.rate(0, 0), au.rate(1, 4), au.rate(1, 3), au.rate(4, 4)]).toEqual([
      '—',
      '25%',
      '33,3%',
      '100%',
    ]);
    const items: au.AuditItem[] = [
      { channel: 'facebook', code: 'khop', kind: 'post', ref: 'u1' },
      { channel: 'facebook', code: 'thieu_ban_duyet', kind: 'post', ref: 'u2' },
    ];
    let comp = Object.fromEntries(au.compliance(items).map((c) => [c.channel, c]));
    expect(Object.keys(comp).sort()).toEqual(['facebook', 'shopee', 'tiktok']);
    expect(comp.facebook?.rate).toBe('50%');
    expect([comp.shopee?.rate, comp.shopee?.n, comp.shopee?.note]).toEqual(['—', 0, au.NO_DATA]);
    comp = Object.fromEntries(
      au
        .compliance([...items, { channel: 'tiktok', code: 'khop', kind: 'post', ref: 'u3' }])
        .map((c) => [c.channel, c]),
    );
    expect(comp.tiktok?.note).toBe(`listing: ${au.NO_DATA}`);
    expect(au.normTitle(' Savigout  30\tVIÊN ')).toBe(au.normTitle('savigout 30 viên'));
  });

  it('ref file report = mã inline đã che PII, không tạo link markdown', () => {
    const items: au.AuditItem[] = [
      {
        channel: 'facebook',
        code: 'thieu_ban_duyet',
        kind: 'post',
        ref: 'https://facebook.com/x/[a](javascript:1)`b`?p=0905123456',
      },
    ];
    const sec = au.renderSection(
      { items, removed: [], before: [], snapshots: {}, price_alerts_open: 0 },
      au.SHOW,
      'x.md',
      true,
    );
    const line = sec.find((l) => l.startsWith('- [facebook]')) as string;
    expect(line.endsWith("`https://facebook.com/x/[a](javascript:1)'b'?p=***`")).toBe(true);
    expect(line.split('`').length - 1).toBe(2);
  });

  it('section trang TGĐ chỉ #id → sạch guardrail; file report giữ URL (cold-check MAJOR)', () => {
    const url = 'https://samsamngoclinh.com/sam-ngoc-linh-chua-qua-che-bien';
    const data: au.AuditData = {
      items: [
        { channel: 'web', code: 'thieu_ban_duyet', kind: 'post', ref: url, post_id: 41 },
        {
          channel: 'shopee',
          code: 'lech_ban_duyet',
          kind: 'listing',
          ref: '123 · sam-thuoc-bo',
          sku: 'x',
          row_id: 7,
        },
      ],
      removed: [],
      before: [],
      snapshots: {},
      price_alerts_open: 0,
    };
    const sec = au.renderSection(data).join('\n');
    expect(sec).toContain('- [web] thieu_ban_duyet — post #41');
    expect(sec).toContain('- [shopee] lech_ban_duyet — listing market_rows #7');
    expect(sec).not.toContain('chua');
    expect(sec).not.toContain('thuoc');
    expect(check(sec).ok).toBe(true);
    const full = au.renderSection(data, au.SHOW, 'x.md', true).join('\n');
    expect(full).toContain(url);
    expect(check(full).ok).toBe(false);
  });

  it('check_lines: chưa có snapshot → chưa có dữ liệu quan sát (C06)', () => {
    expect(au.checkLines([]).join('\n')).toContain('chưa có dữ liệu quan sát');
  });

  it('nguồn CHỈ ĐỌC: không ghi bảng, không cảnh báo/hàng duyệt, không mạng/LLM', () => {
    const src = SRC('./ceo-audit.ts');
    expect(src).not.toMatch(
      /insert into|update |delete from|raiseAlert|submit\(|markRemoved|ingest\(/i,
    );
    expect(src).not.toMatch(/node:http|node:net|fetch\(|ai\/gateway|\.chat\(/);
  });
});

describe('ceo-audit CLI (không DB)', () => {
  it.each([
    [{}, 'cần --report'],
    [{ now: '2026-10-12' }, 'cần --report'],
    [{ report: true, now: '12/10/2026' }, '--now sai định dạng ISO'],
  ])('tham số sai → exit 2 TRƯỚC connect: %j', async (o, msg) => {
    const c = cap();
    expect(await ceoAuditMain(o, deps(c))).toBe(2);
    expect(c.err.join('\n')).toContain(msg);
  });

  it('DB down → exit 2, không ghi tệp', async () => {
    const c = cap();
    const out = fresh();
    expect(
      await ceoAuditMain({ report: true, outDir: out }, deps(c, { open: async () => null })),
    ).toBe(2);
    expect(c.err.join('\n')).toContain('không kết nối');
    expect(readdirSync(out)).toEqual([]);
  });

  it('DATABASE_URL tới cổng đóng (host chết) → exit 2 "không kết nối"', async () => {
    const c = cap();
    const env = { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' };
    expect(
      await ceoAuditMain(
        { report: true, outDir: fresh() },
        { ...c.deps, env, open: openDatabaseUrl, wire: null },
      ),
    ).toBe(2);
    expect(c.err.join('\n')).toContain('không kết nối');
  });

  it('cấu hình phap_che.json hỏng → exit 2, không connect', async () => {
    const c = cap();
    const p = join(fresh(), 'phap_che.json');
    writeFileSync(p, '{hỏng');
    expect(await ceoAuditMain({ report: true }, deps(c, { phapChe: p }))).toBe(2);
    expect(c.err.join('\n')).toContain('[error] cấu hình phap_che.json: phap_che.json hỏng');
  });

  it('r12: cả ceo-04.3 lẫn ceo-04.4 TẮT → [rollout] exit 2, 0 tệp, không connect', async () => {
    settings.forceMode = 'tat';
    const c = cap();
    const out = fresh();
    const rc = await ceoAuditMain(
      { report: true, now: '2026-10-24T10:00:00+07:00', outDir: out },
      deps(c),
    );
    expect(rc).toBe(2);
    const text = c.out.join('\n');
    expect(text).toContain('[rollout]');
    expect(text).toContain('ceo-04.3');
    expect(text).toContain('ceo-04.4');
    expect(readdirSync(out)).toEqual([]);
  });
});

// ================================================================= ceo_risk

const CFG = cr.loadConfig();
const FEE_OLD = '550.000 đồng/hồ sơ đến hết 31/12/2026';
const FEE_NEW = '1.100.000 đồng/hồ sơ từ 01/01/2027';
const facts = (kw: cr.Facts = {}): cr.Facts => ({
  dossiers: [],
  tpbvsk: [],
  posts: [],
  alerts: [],
  dpia_signed: true,
  gaps: 0,
  recipients: 1,
  ...kw,
});
const dos = (
  id: number,
  sku: string,
  status: string,
  o: { het?: string; cap?: string; nop?: string } = {},
): cr.RiskDossier => ({
  id,
  sku_key: sku,
  status,
  ngay_nop: o.nop ?? null,
  ngay_cap: o.cap ?? null,
  ngay_het_han: o.het ?? null,
});
const NOW = vn(2026, 11, 10, 9);
const H = 3600_000;
const RANK_FACTS = facts({
  tpbvsk: ['A', 'B', 'C', 'D'],
  dossiers: [
    dos(2, 'B', 'da_nop', { nop: '2026-11-01' }),
    dos(3, 'C', 'da_cap', { het: '2026-11-20', cap: '2026-01-01', nop: '2025-12-01' }),
    dos(4, 'D', 'da_cap', { het: '2026-11-01', cap: '2025-11-01', nop: '2025-10-01' }),
  ],
  posts: [
    { url: 'u-fb', channel: 'facebook', severity: 'S1', due_at: new Date(NOW.getTime() + 10 * H) },
    { url: 'u-web', channel: 'web', severity: 'S2', due_at: new Date(NOW.getTime() - 2 * H) },
    { url: 'u-sp', channel: 'shopee', severity: 'S2', due_at: new Date(NOW.getTime() + 5 * H) },
  ],
  alerts: [11, 12], // 2 cảnh báo GỐC (bản leo thang lọc ở collect)
  dpia_signed: false,
  gaps: 5,
  recipients: 0,
});
// Thứ tự VIẾT SẴN: đỏ (ngày còn lại tăng, không hạn cuối, mã) → vàng → xanh.
const EXPECTED = [
  'XNQC-HET-HAN:4',
  'KENH:facebook',
  'KENH:web',
  'CANH-BAO-DO',
  'DPIA',
  'TUYEN-CANH-BAO',
  'KENH:shopee',
  'XNQC-HET-HAN:3',
  'XNQC-CHO-NOP:A',
  'XNQC-CHO-NOP:D',
  'XNQC-CHO-CAP:B',
];

describe('ceo_risk — đếm ngược mốc phí / xếp hạng / xu hướng', () => {
  it.each([
    [vn(2026, 12, 1, 9), 'T-30', 'do'], // đợt 2 (30/11) đã qua
    [vn(2026, 12, 17, 9), 'T-14', 'do'],
    [vn(2026, 12, 24, 9), 'T-7', 'do'],
    [vn(2027, 1, 2, 9), 'QUÁ MỐC PHÍ', 'do'],
    [vn(2026, 11, 1, 9), null, 'vang'], // 60 ngày tới mốc phí, 29 tới đợt 2
    [vn(2026, 12, 2, 0, 30), 'T-30', 'do'], // 29 ngày: vẫn T-30
  ])('mốc phí %s → %s %s', (now, marker, level) => {
    const r = cr.rank(facts({ tpbvsk: ['sku-a'] }), now, CFG);
    expect(r.map((x) => x.code)).toEqual(['XNQC-CHO-NOP:sku-a']);
    expect([r[0]?.marker, r[0]?.level]).toEqual([marker, level]);
    const row = cr.riskRow(r[0] as cr.Risk);
    expect(row).toContain(FEE_OLD);
    expect(row).toContain(FEE_NEW);
    expect(row).toContain(CFG.xnqc_phi_nguon_url);
    if (marker) expect(row).toContain(marker);
  });

  it('fee_marker ngưỡng', () => {
    expect(CFG.nhac_moc_ngay).toEqual([30, 14, 7]);
    const got = Object.fromEntries(
      [-1, 0, 7, 8, 14, 15, 30, 31].map((d) => [d, cr.feeMarker(d, CFG.nhac_moc_ngay)]),
    );
    expect(got).toEqual({
      '-1': 'QUÁ MỐC PHÍ',
      0: 'T-7',
      7: 'T-7',
      8: 'T-14',
      14: 'T-14',
      15: 'T-30',
      30: 'T-30',
      31: null,
    });
  });

  it('xếp hạng đúng thứ tự viết sẵn', () => {
    const r = cr.rank(RANK_FACTS, NOW, CFG);
    expect(r.map((x) => x.code)).toEqual(EXPECTED);
    const lv = Object.fromEntries(r.map((x) => [x.code, x.level]));
    expect([lv['XNQC-CHO-CAP:B'], r[r.length - 1]?.code]).toEqual(['xanh', 'XNQC-CHO-CAP:B']);
    expect([lv['KENH:web'], lv['KENH:shopee']]).toEqual(['do', 'vang']);
    expect([lv['XNQC-HET-HAN:3'], lv['XNQC-HET-HAN:4']]).toEqual(['vang', 'do']);
    const by = Object.fromEntries(r.map((x) => [x.code, x]));
    expect(by['CANH-BAO-DO']?.title.startsWith('2 cảnh báo đỏ gốc')).toBe(true);
    expect(by['KENH:web']?.title.endsWith('S1 0, S2 1, quá 24h 1')).toBe(true);
    expect(by['XNQC-HET-HAN:3']?.days_left).toBe(10);
    expect(by['XNQC-CHO-NOP:A']?.days_left).toBe(20); // tới hạn đợt 2
    expect(new Set(r.map((x) => x.owner_role))).toEqual(new Set(['phap_che', 'phap_che/bks']));
  });

  it('thứ tự đầu vào không ảnh hưởng', () => {
    const want = cr.rank(RANK_FACTS, NOW, CFG);
    let seed = 81;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const shuffle = <T>(xs: readonly T[]): T[] =>
      xs
        .map((x) => [rnd(), x] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, x]) => x);
    for (let i = 0; i < 5; i++) {
      const f: cr.Facts = {
        ...RANK_FACTS,
        dossiers: shuffle(RANK_FACTS.dossiers ?? []),
        tpbvsk: shuffle(RANK_FACTS.tpbvsk ?? []),
        posts: shuffle(RANK_FACTS.posts ?? []),
        alerts: shuffle(RANK_FACTS.alerts ?? []),
      };
      expect(cr.rank(f, NOW, CFG)).toEqual(want);
    }
  });

  it('DPIA đã ký còn rủi ro tồn dư → vàng; sạch → rỗng', () => {
    expect(
      cr.rank(facts({ dpia_signed: true, gaps: 3 }), NOW, CFG).map((x) => [x.code, x.level]),
    ).toEqual([['DPIA', 'vang']]);
    expect(cr.rank(facts(), NOW, CFG)).toEqual([]);
  });

  it('trend: ↑ / mới / đã hết', () => {
    const prev = cr.rank(
      facts({
        posts: [
          { url: 'u', channel: 'web', severity: 'S2', due_at: new Date(NOW.getTime() + 5 * H) },
        ],
        tpbvsk: ['Z'],
      }),
      new Date(NOW.getTime() - 7 * 24 * H),
      CFG,
    );
    const cur = cr.rank(
      facts({
        posts: [
          { url: 'u', channel: 'web', severity: 'S1', due_at: new Date(NOW.getTime() + 5 * H) },
        ],
        recipients: 0,
      }),
      NOW,
      CFG,
    );
    expect(Object.fromEntries(prev.map((x) => [x.code, x.level]))['KENH:web']).toBe('vang');
    const t = cr.trend(cur, prev);
    expect(t.codes).toEqual({ 'KENH:web': '↑', 'TUYEN-CANH-BAO': 'mới' });
    expect(t.gone).toBe(1); // XNQC-CHO-NOP:Z đã hết
    expect(cr.trend(prev, cur).codes['KENH:web']).toBe('↓');
    expect(cr.trend(cur, cur).codes['KENH:web']).toBe('=');
    const sec = cr.renderSection(cur, t, NOW).join('\n');
    expect(sec).toContain('đã hết trong tuần: 1');
    expect(sec).toContain('| ↑ |');
  });

  it('render_section: cắt 8 dòng + đếm theo mức', () => {
    const r = cr.rank(RANK_FACTS, NOW, CFG);
    const tr = cr.trend(r, []);
    const sec = cr.renderSection(r, tr, NOW);
    const rows = (s: string[]) =>
      s.filter((l) => l.startsWith('| ') && !l.includes('---') && !l.startsWith('| Mức')).length;
    expect(rows(sec)).toBe(8);
    expect(sec.some((l) => l.includes('…và 3 rủi ro khác'))).toBe(true);
    const text = sec.join('\n');
    expect(text.startsWith('## Rủi ro pháp lý mở')).toBe(true);
    expect(text).toContain('Đỏ 6 · Vàng 4 · Xanh 1');
    expect(text).toContain('| ĐỎ | XNQC-HET-HAN:4 |');
    expect(rows(cr.renderSection(r, tr, NOW, null))).toBe(11);
    expect(text).toContain('| mới |');
  });

  it('section qua guardrail sạch (mã không chứa chữ gập dấu thành từ cấm)', () => {
    for (const now of [NOW, vn(2027, 1, 2, 9)]) {
      const r = cr.rank(RANK_FACTS, now, CFG);
      const g = check(cr.renderSection(r, cr.trend(r, []), now, null).join('\n'));
      expect(g.ok, JSON.stringify(g.violations)).toBe(true);
    }
  });

  it('ô bảng chữ trần gập dấu thành từ cấm → ẩn ô (không làm trượt cả trang)', () => {
    const r: cr.Risk = {
      level: 'do',
      code: 'XNQC-CHO-NOP:sam-thuoc',
      title: 'SKU x',
      owner_role: 'phap_che',
      due: '2026-11-30',
      days_left: null,
      marker: null,
      source: 'https://example.vn/van-ban-chua-ro',
    };
    const row = cr.riskRow(r);
    expect(row).not.toContain('thuoc');
    expect(row).not.toContain('chua');
    expect(row.startsWith(`| ĐỎ | ${HIDDEN} | ${HIDDEN} | phap_che |`)).toBe(true);
    expect(check(row).ok).toBe(true);
    expect(cr.riskRow({ ...r, code: 'DPIA', source: null })).toContain(
      '| DPIA | SKU x | phap_che | 30/11/2026 |',
    );
  });

  it('docx P2: rượu (mã H-<sha8>) + chỉ dẫn địa lý — ô không bị ẩn', () => {
    const rs = cr.rank(
      facts({
        alcohol: [
          ['ruou-x', ['shopee']],
          ['ruou-y', []],
        ],
        gi_named: ['a', 'b'],
        gi_confirmed: ['a'],
        gi_identity: false,
      }),
      vn(2026, 10, 19),
      CFG,
    );
    const codes = rs.map((r) => r.code);
    expect(codes.filter((c) => c.startsWith('NHOM-HAN-CHE:H-')).length).toBe(1);
    expect(codes).toContain('CDDL-NGOC-LINH');
    for (const r of rs) {
      expect(check(r.title).ok, r.title).toBe(true);
      expect(r.code).not.toContain('ruou');
    }
  });

  it('cấu hình đọc data/phap_che.json (không chép số)', () => {
    const pc = JSON.parse(readFileSync(dataPath('phap_che.json'), 'utf8'));
    const good = JSON.parse(readFileSync(dataPath('ceo_risk.json'), 'utf8'));
    expect(CFG.dot2_han_nop).toBe(pc.xnqc.dot2_han_nop);
    expect('dot2_han_nop' in good).toBe(false);
    expect(good._doc).toContain('BẢN DEV SOẠN');
    expect(CFG.xnqc_phi_text).toBe(`${FEE_OLD}, ${FEE_NEW}`);
  });

  it('TS chặt hơn có chủ đích: số thực trong ceo_risk.json (30.0) bị từ chối như Python int', () => {
    const good = readFileSync(dataPath('ceo_risk.json'), 'utf8');
    const p = join(fresh(), 'ceo_risk.json');
    writeFileSync(p, good.replace('"do_khi_con_ngay": 7', '"do_khi_con_ngay": 7.0'));
    expect(() => cr.loadConfig(p)).toThrow('do_khi_con_ngay: cần số nguyên ≥ 0');
  });

  it('nguồn CHỈ ĐỌC: không ghi bảng, không cảnh báo, không mạng/LLM', () => {
    const src = SRC('./ceo-risk.ts');
    expect(src).not.toMatch(/insert into|update |delete from|raiseAlert|submit\(/i);
    expect(src).not.toMatch(/node:http|node:net|fetch\(|ai\/gateway|\.chat\(/);
  });
});

describe('ceo-risk CLI (không DB)', () => {
  const GOOD = JSON.parse(readFileSync(dataPath('ceo_risk.json'), 'utf8'));
  it.each([
    ['thieu', null],
    ['hong', '{hỏng'],
    ['rong', {}],
    ['chi-doc', { _doc: 'x' }],
    ['ngay-vn', { ...GOOD, xnqc_phi_moc: '31/12/2026' }],
    ['ngay-sai', { ...GOOD, xnqc_phi_moc: '2026-02-30' }],
    ['list-rong', { ...GOOD, nhac_moc_ngay: [] }],
    ['moc-0', { ...GOOD, nhac_moc_ngay: [30, 0] }],
    ['am', { ...GOOD, do_khi_con_ngay: -1 }],
    ['bool', { ...GOOD, do_khi_con_ngay: true }],
    ['text-rong', { ...GOOD, xnqc_phi_text: ' ' }],
    ['url-sai', { ...GOOD, xnqc_phi_nguon_url: 'ftp://x' }],
  ])('cấu hình %s → RangeError + CLI exit 2 không connect', async (_n, doc) => {
    const p = join(fresh(), 'ceo_risk.json');
    if (doc !== null) writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc));
    expect(() => cr.loadConfig(p)).toThrow(RangeError);
    const c = cap();
    expect(
      await ceoRiskMain({ report: true, outDir: join(fresh(), 'o') }, deps(c, { riskConfig: p })),
    ).toBe(2);
    expect(c.err.join('\n')).toContain('[error] cấu hình:');
  });

  it.each([
    [{}, 'cần --report'],
    [{ now: '2026-10-12' }, 'cần --report'],
    [{ report: true, now: '12/10/2026' }, '--now sai định dạng ISO'],
  ])('tham số sai → exit 2 TRƯỚC connect: %j', async (o, msg) => {
    const c = cap();
    expect(await ceoRiskMain(o, deps(c))).toBe(2);
    expect(c.err.join('\n')).toContain(msg);
  });

  it('DB down → exit 2, không ghi tệp', async () => {
    const c = cap();
    const out = fresh();
    expect(
      await ceoRiskMain({ report: true, outDir: out }, deps(c, { open: async () => null })),
    ).toBe(2);
    expect(readdirSync(out)).toEqual([]);
    const c2 = cap();
    const env = { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' };
    expect(
      await ceoRiskMain(
        { report: true, outDir: out },
        { ...c2.deps, env, open: openDatabaseUrl, wire: null },
      ),
    ).toBe(2);
    expect(c2.err.join('\n')).toContain('không kết nối');
  });

  it('r12: ceo-03 TẮT → [rollout] exit 2, không tệp, không connect', async () => {
    settings.forceMode = 'tat';
    const c = cap();
    const out = fresh();
    expect(
      await ceoRiskMain({ report: true, now: '2026-10-24T10:00:00+07:00', outDir: out }, deps(c)),
    ).toBe(2);
    expect(c.out.join('\n')).toContain('[rollout]');
    expect(c.out.join('\n')).toContain('ceo-03');
    expect(readdirSync(out)).toEqual([]);
  });
});

// ================================================================= ceo_decisions

const TGD = 'TGĐ Giả Lập';
const THU_KY = 'Thư Ký Giả Lập';

describe('ceo_decisions — thuần', () => {
  it('current_status / chains', () => {
    const rows: cd.DecRow[] = [
      { id: 1, entry_kind: 'quyet_dinh', parent_id: null, follow_status: 'mo' },
      { id: 3, entry_kind: 'cap_nhat', parent_id: 1, follow_status: 'xong' },
      { id: 2, entry_kind: 'cap_nhat', parent_id: 1, follow_status: 'dang_lam' },
      { id: 4, entry_kind: 'quyet_dinh', parent_id: null, follow_status: 'mo' },
    ];
    expect(cd.currentStatus(rows.slice(0, 3))).toBe('xong');
    expect(cd.currentStatus([])).toBeNull();
    expect(cd.chains(rows).map((c) => [c.id, c.status])).toEqual([
      [1, 'xong'],
      [4, 'mo'],
    ]);
  });

  it('quá hạn theo ngày VN (17:30 UTC 19/10 = 20/10 giờ VN)', () => {
    const now = new Date(Date.UTC(2026, 9, 19, 17, 30));
    expect(now.toISOString().slice(0, 10)).toBe('2026-10-19'); // UTC còn 19/10
    const today = vnDate(now);
    expect(today).toBe('2026-10-20'); // giờ VN đã 20/10
    const y = '2026-10-19';
    const ds: cd.Decision[] = [
      { id: 1, due_date: y, status: 'dang_lam' },
      { id: 2, due_date: y, status: 'xong' },
      { id: 3, due_date: today, status: 'mo' },
      { id: 4, due_date: null, status: 'mo' },
      { id: 5, due_date: y, status: 'huy' },
    ];
    expect(cd.overdue(ds, today).map((d) => d.id)).toEqual([1]);
  });

  const MS: cd.Milestone[] = [
    {
      code: 'XNQC-NOP',
      title: 'Nộp hồ sơ XNQC đợt 2',
      owner_role: 'phap_che',
      due_date: '2026-10-15',
      status: 'dang_lam',
    },
    {
      code: 'A-XONG',
      title: 'Việc xong',
      owner_role: 'ha_tang',
      due_date: '2026-10-01',
      status: 'xong',
    },
    {
      code: 'B-DUNG',
      title: 'Việc tạm dừng',
      owner_role: 'du_an',
      due_date: '2026-10-02',
      status: 'tam_dung',
    },
    {
      code: 'C-SAU',
      title: 'Việc sau',
      owner_role: 'du_an',
      due_date: '2026-10-30',
      status: 'chua_bat_dau',
    },
    {
      code: 'D-HOMNAY',
      title: 'Hạn hôm nay',
      owner_role: 'du_an',
      due_date: '2026-10-20',
      status: 'dang_lam',
    },
  ];

  it('mốc trễ CÙNG luật bảng tiến độ DA-01 (due < hôm nay, chưa xong)', () => {
    const today = '2026-10-20';
    expect(new Set(cd.lateMilestones(MS, today).map((r) => r.code))).toEqual(
      new Set(['XNQC-NOP', 'B-DUNG']),
    );
    const sec = cd.renderSection({ decisions: [], milestones: MS }, today).join('\n');
    expect(sec).toContain(
      '- **TRỄ** XNQC-NOP — hạn 15/10/2026 (trễ 5 ngày, owner phap_che, dang_lam)',
    );
    expect(sec).not.toContain('A-XONG');
    expect(sec).not.toContain('D-HOMNAY');
  });

  it('render_section: đếm + cắt 5', () => {
    const today = '2026-10-20';
    const rec = vn(2026, 10, 18, 9);
    const old = vn(2026, 10, 1, 9);
    const dec: cd.Decision[] = Array.from({ length: 7 }, (_, k) => ({
      id: k + 1,
      topic: `Chủ đề ${k + 1}`,
      decided_by: TGD,
      due_date: '2026-10-10',
      status: 'dang_lam',
      recorded_at: (k + 1) % 2 ? rec : old,
    }));
    dec.push({
      id: 9,
      topic: 'Đã xong',
      decided_by: TGD,
      due_date: '2026-10-10',
      status: 'xong',
      recorded_at: rec,
    });
    const ms = Array.from({ length: 7 }, (_, i) => ({ ...(MS[0] as cd.Milestone), code: `M${i}` }));
    const sec = cd.renderSection({ decisions: dec, milestones: ms }, today);
    const text = sec.join('\n');
    expect(sec[0]).toBe('## Tiến độ & Sổ quyết định');
    expect(text).toContain(
      'Quyết định đang theo dõi (mở/đang làm): 7 · quá hạn thực hiện: 7 · ghi trong 7 ngày: 5',
    );
    expect(sec.filter((l) => l.startsWith('- #')).map((l) => l.split(' ')[1])).toEqual([
      '#7',
      '#6',
      '#5',
      '#4',
      '#3',
    ]);
    expect(text).toContain('- …và 2 quyết định khác');
    expect(text).toContain('- …và 2 mốc khác');
    expect(text).toContain('trễ 10 ngày');
    expect(text).toContain('hạn 10/10/2026');
    const empty = cd.renderSection({ decisions: [], milestones: [] }, today).join('\n');
    expect(empty.split('- (không có)').length - 1).toBe(2);
  });

  it('r12 G1-L5: --list in việc chờ quyết/chờ ký', () => {
    const out: string[] = [];
    cd.printList(
      {
        decisions: [],
        milestones: [
          {
            code: 'M1',
            title: 'Ký nghiệm thu',
            due_date: '2026-11-01',
            status: 'chua_bat_dau',
            owner_role: 'tgd',
            sign_required: true,
          },
        ],
        waiting_queue: [['7', 'weekly_report', 'Báo cáo tuần', null]],
        waiting_rev: [],
      },
      '2026-10-24',
      (s) => out.push(s),
    );
    const text = out.join('\n');
    expect(text).toContain('Chờ quyết định');
    expect(text).toContain('#7 weekly_report');
    expect(text).toContain('Chờ ký');
    expect(text).toContain('M1');
  });

  it('nguồn chỉ INSERT decision_log, không mạng/LLM, không cổng rollout ở đường ghi', () => {
    const src = SRC('./ceo-decisions.ts');
    const hits = src.match(/insert into \w+|update \w|delete from/gi) ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.toLowerCase()))).toEqual(
      new Set(['insert into decision_log']),
    );
    expect(src).not.toMatch(
      /node:http|node:net|fetch\(|ai\/gateway|\.chat\(|checkGenerate|blocked\(/,
    );
  });
});

describe('ceo-decisions CLI — sai tham số / agent → exit 2 TRƯỚC connect', () => {
  const REC = { record: true, topic: 'Chủ đề', decision: 'Đồng ý', basis: 'approval_queue:1' };
  const cases: [string, cd.RecordArgs | Record<string, unknown>][] = [
    ['by agent', { ...REC, by: 'agent:ceo' }],
    ['by SYSTEM', { ...REC, by: ' SYSTEM:cron' }],
    ['decided-by agent', { ...REC, by: THU_KY, decidedBy: 'agent:x' }],
    ['by rỗng', { ...REC, by: '' }],
    ['by điều khiển', { ...REC, by: 'Thư\u001bký' }],
    ['thiếu by', REC],
    ['follow agent', { follow: '1', status: 'dang_lam', by: 'agent:ceo' }],
    ['follow xong không note', { follow: '1', status: 'xong', by: THU_KY }],
    ['2 thao tác', { propose: true, list: true }],
    ['0 thao tác', {}],
    ['record+list', { record: true, list: true }],
    ['date sai', { ...REC, by: THU_KY, date: '2026-13-01' }],
    ['due sai', { ...REC, by: THU_KY, due: '30/10/2026' }],
    ['basis sai', { ...REC, basis: 'approvals:abc', by: THU_KY }],
    [
      'van_ban note ngắn',
      { record: true, topic: 'x', decision: 'y', by: THU_KY, note: 'ngắn', decidedBy: TGD },
    ],
    [
      'van_ban thiếu decided-by',
      { record: true, topic: 'x', decision: 'y', by: THU_KY, note: 'Biên bản họp số 12' },
    ],
    ['topic dài', { record: true, topic: 'x'.repeat(201), decision: 'y', by: THU_KY }],
    ['now với record', { ...REC, by: THU_KY, now: '2026-10-12T09:00' }],
    ['list + topic', { list: true, topic: 'x' }],
    ['list + days', { list: true, days: '5' }],
    ['days 0', { propose: true, days: '0' }],
    ['list now sai', { list: true, now: '12/10/2026' }],
    ['follow thiếu status', { follow: '1', by: THU_KY }],
    ['status lạ', { follow: '1', status: 'mo', by: THU_KY }],
    ['follow không phải số', { follow: 'abc', status: 'huy', by: THU_KY }],
  ];
  it.each(cases)('%s', async (_n, o) => {
    const c = cap();
    expect(await ceoDecisionsMain(o as never, deps(c))).toBe(2);
    expect(c.err.length).toBeGreaterThan(0);
  });

  it('DB down → exit 2 "không kết nối"', async () => {
    const c = cap();
    expect(await ceoDecisionsMain({ list: true }, deps(c, { open: async () => null }))).toBe(2);
    expect(c.err.join('\n')).toContain('không kết nối');
    const c2 = cap();
    const env = { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' };
    expect(
      await ceoDecisionsMain(
        { propose: true },
        { ...c2.deps, env, open: openDatabaseUrl, wire: null },
      ),
    ).toBe(2);
    expect(c2.err.join('\n')).toContain('không kết nối');
  });

  it("--basis rỗng = van_ban (Python `a.basis or 'van_ban'`) → qua kiểm tham số, tới connect", async () => {
    const c = cap();
    const o = {
      record: true,
      topic: 'x',
      decision: 'y',
      by: THU_KY,
      basis: '',
      decidedBy: TGD,
      note: 'Biên bản họp số 12',
    };
    expect(await ceoDecisionsMain(o, deps(c, { open: async () => null }))).toBe(2);
    expect(c.err.join(' ')).toContain('không kết nối');
  });

  it('v14.3: tính năng ceo-02.2 TẮT KHÔNG chặn người ghi sổ (không có cổng ở --record)', async () => {
    settings.forceMode = 'tat';
    const c = cap();
    // tới bước connect (DB down giả) — không bị cổng rollout chặn trước đó
    expect(
      await ceoDecisionsMain(
        {
          record: true,
          topic: 'x',
          decision: 'y',
          by: THU_KY,
          decidedBy: TGD,
          note: 'Biên bản họp số 12',
        },
        deps(c, { open: async () => null }),
      ),
    ).toBe(2);
    expect(c.out.join('\n')).not.toContain('[rollout]');
    expect(c.err.join('\n')).toContain('không kết nối');
  });
});

// ================================================================= ceo_promo

const TODAY = '2026-10-14';
const run = (o: Partial<cp.Promo> = {}): cp.Promo => ({
  src: 'listing',
  channel: 'shopee',
  sku: 'mat-ong-sam-300ml',
  kind: null,
  price: null,
  pct: null,
  start: null,
  end: null,
  ref: 'r',
  evidence: 's1',
  ...o,
});
const ap = (o: Partial<cp.Promo> = {}): cp.Promo => ({
  src: 'plan',
  channel: 'shopee',
  sku: 'mat-ong-sam-300ml',
  kind: null,
  price: null,
  pct: null,
  start: '2026-10-01',
  end: '2026-10-31',
  ref: 'a',
  ...o,
});
const LISTS: cp.Lists = new Map([['mat-ong-sam-300ml\u0000shopee', 1_000_000]]);

describe('ceo_promo — compare_promos (ceo-04.5 THUẦN)', () => {
  const V = { src: 'file', kind: 'voucher', start: '2026-10-01' };
  it.each([
    ['không bản duyệt', [run({ price: 900_000 })], [], LISTS, ['km_ngoai_ke_hoach']],
    [
      'bản duyệt hết hạn',
      [run({ price: 900_000 })],
      [ap({ pct: 20, end: '2026-10-10' })],
      LISTS,
      ['km_ngoai_ke_hoach'],
    ],
    ['khớp', [run({ price: 800_000 })], [ap({ pct: 20 })], LISTS, []],
    ['sâu hơn duyệt', [run({ price: 799_000 })], [ap({ pct: 20 })], LISTS, ['km_sau_hon_duyet']],
    [
      'khác loại',
      [run({ ...V, pct: 30, end: '2026-10-31' })],
      [ap({ pct: 30, kind: 'flash_sale' })],
      LISTS,
      ['km_khac_loai'],
    ],
    [
      'quá thời gian',
      [run({ ...V, pct: 20, end: '2026-11-05' })],
      [ap({ pct: 20, kind: 'voucher' })],
      LISTS,
      ['km_qua_thoi_gian'],
    ],
    [
      'sâu + quá hạn',
      [run({ ...V, pct: 25, end: '2026-11-05' })],
      [ap({ pct: 20, kind: 'voucher' })],
      LISTS,
      ['km_sau_hon_duyet', 'km_qua_thoi_gian'],
    ],
    [
      'thiếu giá list → không suy',
      [run({ price: 800_000 })],
      [ap({ pct: 20 })],
      new Map(),
      ['km_khong_so_duoc'],
    ],
    [
      'không map SKU',
      [run({ sku: null, price: 800_000 })],
      [ap({ pct: 20 })],
      LISTS,
      ['khong_xac_dinh_sku'],
    ],
    [
      'golden giá KM cố định, mọi loại',
      [run({ price: 850_000 })],
      [ap({ price: 850_000, src: 'golden', end: null })],
      LISTS,
      [],
    ],
  ] as [string, cp.Promo[], cp.Promo[], cp.Lists, string[]][])(
    '%s',
    (_n, running, approved, lists, codes) => {
      const res = cp.comparePromos(running, approved, lists, TODAY);
      expect(res.findings.map((f) => f.code).sort()).toEqual([...codes].sort());
      expect(res.ok).toBe(codes.length ? 0 : 1);
    },
  );

  it('bản duyệt chưa thấy chạy chỉ là thông tin', () => {
    const res = cp.comparePromos([], [ap({ pct: 10 })], LISTS, TODAY);
    expect(res.findings).toEqual([]);
    expect(res.planned_idle.length).toBe(1);
  });

  it('promoCheck: tính năng TẮT → RolloutBlocked TRƯỚC mọi đọc/ghi DB', async () => {
    settings.forceMode = 'tat';
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        throw new Error('không được truy vấn');
      },
    } as unknown as pg.Pool;
    await expect(
      cp.promoCheck(db, TODAY, {
        mapping: {},
        plan: null,
        runningFile: null,
        planSha: null,
        runningSha: null,
        cfg: { object_types: {} } as never,
      }),
    ).rejects.toBeInstanceOf(RolloutBlocked);
    expect(calls).toEqual([]);
  });
});

describe('ceo-promo CLI (không DB)', () => {
  it('--as-of sai định dạng → exit 2', async () => {
    const c = cap();
    expect(await ceoPromoMain({ asOf: '14/10/2026' }, deps(c))).toBe(2);
    expect(c.err.join('\n')).toContain('cần ngày YYYY-MM-DD');
  });

  it('file kế hoạch hỏng → exit 1 TRƯỚC connect, "0 dòng"', async () => {
    const p = join(fresh(), 'plan.csv');
    writeFileSync(p, 'program_id,kenh\nX,shopee\n');
    const c = cap();
    expect(await ceoPromoMain({ plan: p }, deps(c))).toBe(1);
    expect(c.err.join('\n')).toContain('--plan không hợp lệ — 0 dòng');
  });

  it('mapping sàn hỏng / cấu hình khối ceo thiếu loại việc → exit 2 không connect', async () => {
    const d = fresh();
    const c = cap();
    expect(await ceoPromoMain({}, deps(c, { mapPath: join(d, 'thieu.json') }))).toBe(2);
    expect(c.err.join('\n')).toContain('không đọc được mapping');
    const dir = join(d, 'directors');
    mkdirSync(dir);
    const ceo = JSON.parse(readFileSync(dataPath('directors', 'ceo.json'), 'utf8'));
    delete ceo.object_types.promo_deviation;
    writeFileSync(join(dir, 'ceo.json'), JSON.stringify(ceo));
    const c2 = cap();
    expect(await ceoPromoMain({}, deps(c2, { directorsDir: dir }))).toBe(2);
    expect(c2.err.join('\n')).toContain('ceo.json thiếu loại việc promo_deviation');
  });

  it('TS chặt hơn có chủ đích: ceo.json hỏng (DirectorConfigError) → exit 2 không connect (Python: traceback)', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'ceo.json'), '{hỏng');
    const c = cap();
    expect(await ceoPromoMain({}, deps(c, { directorsDir: dir }))).toBe(2);
    expect(c.err.join('\n')).toContain('cấu hình lỗi');
  });

  it('DB down → exit 2', async () => {
    const c = cap();
    expect(await ceoPromoMain({}, deps(c, { open: async () => null }))).toBe(2);
    expect(c.err.join('\n')).toContain('không kết nối');
  });

  it('tính năng ceo-04.5 TẮT → [rollout] exit 2, 0 truy vấn', async () => {
    settings.forceMode = 'tat';
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        throw new Error('không được truy vấn');
      },
      end: async () => {},
    } as unknown as pg.Pool;
    const c = cap();
    expect(await ceoPromoMain({ dryRun: true }, deps(c, { open: async () => pool }))).toBe(2);
    expect(c.err.join('\n')).toContain('[rollout]');
    expect(c.err.join('\n')).toContain('ceo-04.5');
    expect(calls).toEqual([]);
  });

  it('nguồn: agent KHÔNG đổi giá/KM, không gọi sàn/mạng/LLM; chỉ ghi qua director.submit', () => {
    const src = SRC('./ceo-promo.ts');
    expect(src).not.toMatch(/insert into|update |delete from/i);
    expect(src).not.toMatch(/node:http|node:net|fetch\(|ai\/gateway|\.chat\(|market-api/);
    expect(src).toContain('await submit(db, {');
  });
});
