import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '@samsam/core/paths';
import { normName } from '@samsam/core/security/auth';
import { checkPublish, setGuardrailDataDir } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/qr_trace.golden.json' with { type: 'json' };
import * as q from './qr-trace.js';

// Dịch phần thuần + CLI-không-DB của tests/test_qr_trace.py. Golden = chạy hàm Python THẬT
// (pipelines/qr_trace.py, production._*_arg, golden_store) trên đầu vào cố định (gen_golden.py).
// KHÁC Python có chủ đích (TS chặt hơn = fail-closed):
const TS_STRICTER = {
  // regex `$` của Python khớp trước '\n' cuối → 'LOT-1\n' / '<sha>\n' / '<mã>\n' lọt qua argparse rồi
  // DB không thấy; TS từ chối ngay (exit 2).
  trailing_newline: ['LOT-MO-001\n', `${'a'.repeat(64)}\n`, `${'A'.repeat(22)}\n`],
  // JSON NaN/Infinity trong qr_config/qr_signers: Python `parse_constant` → lỗi; TS JSON.parse → lỗi
  // (cùng kết cục, khác tên lỗi trong thông điệp: JSONDecodeError).
  nan: '{"status": NaN}',
};

const TMP = mkdtempSync(join(tmpdir(), 'qrtrace-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let nFile = 0;
function write(obj: unknown): string {
  const p = join(TMP, `f${nFile++}.json`);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

const GOLDEN = q.goldenMap();
const SKU = 'mat-ong-sam-120ml-1hu';
const LOT = 'LOT-MO-001';
const SIGN = {
  gd_san_xuat: 'Trần Sản Xuất',
  gd_vung_trong: 'Lê Vùng Trồng',
  phap_che_qa: 'Phạm Pháp Chế',
};
const SIGNERS_DOC = {
  status: 'fixture',
  roles: Object.fromEntries(Object.entries(SIGN).map(([r, n]) => [r, [n]])),
};
const CFG = JSON.parse(readFileSync(dataPath('qr_config.json'), 'utf8'));
const BANNED = readFileSync(dataPath('banned_words.txt'), 'utf8')
  .split('\n')
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w && !w.startsWith('#'));

type GCfg = { name: string; doc: Record<string, unknown>; out?: unknown; error?: string };
type GLot = q.Lot;

function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  return {
    o,
    io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) },
    text: () => [...o.out, ...o.err].join('\n'),
  };
}

describe('qr_trace — cấu hình (fail-closed)', () => {
  it('golden validate_config: mọi biến thể khớp Python', () => {
    for (const c of G.config as GCfg[]) {
      if (c.error !== undefined) {
        expect(() => q.validateConfig(c.doc, GOLDEN), c.name).toThrow(q.QrError);
        try {
          q.validateConfig(c.doc, GOLDEN);
        } catch (e) {
          expect((e as Error).message, c.name).toBe(c.error);
        }
      } else {
        expect(q.validateConfig(c.doc, GOLDEN), c.name).toEqual(c.out);
      }
    }
  });

  it('tệp repo: GIẢ ĐỊNH, mốc 27/11/2026, 3 SKU mật ong, chưa có domain, vùng không chữ số', () => {
    const cfg = q.loadConfig();
    expect(cfg.status).toContain('GIẢ ĐỊNH');
    expect(cfg.plan_b_deadline).toBe('2026-11-27');
    expect(cfg.pilot_skus).toEqual([
      'mat-ong-sam-120ml-1hu',
      'mat-ong-sam-120ml-2hu',
      'mat-ong-sam-300ml',
    ]);
    expect(cfg.public_base_url).toBe('');
    expect(/\d/.test(cfg.region_text)).toBe(false);
  });

  it('người ký repo rỗng (external-dep)', () => {
    const doc = JSON.parse(readFileSync(dataPath('qr_signers.json'), 'utf8'));
    expect(doc.roles).toEqual({ gd_san_xuat: [], gd_vung_trong: [], phap_che_qa: [] });
    expect(doc.status).toContain('external-dep');
    const s = q.loadSigners();
    for (const r of q.ROLE_KEYS) expect(s[r].size).toBe(0);
  });

  it.each([
    ['missing', null],
    ['empty', ' \n'],
    ['broken', '{"status": '],
    ['obj_empty', '{}'],
    ['only_doc', '{"_doc": "x"}'],
    ['not_object', '[1]'],
    ['nan', TS_STRICTER.nan],
  ])('tệp cấu hình %s → QrError', (_k, raw) => {
    const p = raw === null ? join(TMP, 'nope.json') : write(raw);
    expect(() => q.loadConfig(p, GOLDEN)).toThrow(q.QrError);
  });

  it('readJsonDoc: thông điệp như production.read_json; BOM được nhận', () => {
    expect(() => q.readJsonDoc(join(TMP, 'nope.json'))).toThrow('thiếu file nope.json');
    const e = write(' \n');
    expect(() => q.readJsonDoc(e)).toThrow(/rỗng$/);
    expect(() => q.readJsonDoc(write('{"status": '))).toThrow('JSON hỏng: JSONDecodeError');
    expect(() => q.readJsonDoc(write('[1]'))).toThrow('root phải là object');
    expect(() => q.readJsonDoc(write('{"_doc": 1}'))).toThrow('không có dữ liệu (0 record)');
    const bad = join(TMP, 'bad.json');
    writeFileSync(bad, Buffer.from([0xff, 0x7b, 0x7d]));
    expect(() => q.readJsonDoc(bad)).toThrow('(UnicodeDecodeError)');
    expect(q.readJsonDoc(write(`﻿${JSON.stringify(CFG)}`)).status).toBe(CFG.status);
  });

  it('golden_map: thiếu/rỗng/0 SKU → QrError "golden: …"', () => {
    expect(() => q.goldenMap(join(TMP, 'nope.json'))).toThrow(/^golden: thiếu file/);
    expect(() => q.goldenMap(write('{"skus": []}'))).toThrow(/không có SKU nào/);
    expect(() => q.goldenMap(write('  '))).toThrow(/rỗng$/);
    expect(
      q.goldenMap(write('{"skus": [1, {"sku_key": 2}, {"sku_key": "a", "name": "A"}]}')),
    ).toEqual(new Map([['a', { sku_key: 'a', name: 'A' }]]));
  });
});

describe('qr_trace — người ký', () => {
  it('golden validate_signers khớp Python', () => {
    for (const c of G.signers as GCfg[]) {
      if (c.error !== undefined) {
        expect(() => q.validateSigners(c.doc), c.name).toThrow(c.error);
      } else {
        const got = Object.fromEntries(
          q.ROLE_KEYS.map((r) => [r, [...q.validateSigners(c.doc)[r]].sort(q.cpCmp)]),
        );
        expect(got, c.name).toEqual(c.out);
      }
    }
  });

  it.each([
    ['missing', null],
    ['empty', '  '],
    ['broken', '{'],
    ['obj_empty', '{}'],
    ['only_doc', '{"_doc": "x"}'],
  ])('tệp người ký %s → QrError', (_k, raw) => {
    const p = raw === null ? join(TMP, 'nope.json') : write(raw);
    expect(() => q.loadSigners(p)).toThrow(q.QrError);
  });

  it('chuẩn hóa NFD + hoa/thường + khoảng trắng; norm_name (security/auth) khớp golden', () => {
    const s = q.loadSigners(write(SIGNERS_DOC));
    const nfd = '  TRẦN   sản xuất '.normalize('NFD');
    expect(s.gd_san_xuat.has(normName(nfd))).toBe(true);
    expect(s.phap_che_qa.has(normName(nfd))).toBe(false);
    for (const [inp, want] of G.norm_name as [string, string][])
      expect(normName(inp), inp).toBe(want);
  });
});

describe('qr_trace — lời văn trang + guardrail (thuần)', () => {
  it('kênh qr là bí danh web (không lỗi config); kênh lạ → config', () => {
    const codes = (ch: string) =>
      new Set(checkPublish('x', { channel: ch }).violations.map((v) => v.code));
    expect(codes('qr').has('config')).toBe(false);
    expect(codes('kenh-la').has('config')).toBe(true);
  });

  it('golden page_text/stamp_text/sha/check/html khớp Python', () => {
    const cfg = G.page_cfg as q.QrConfig;
    for (const c of G.page as {
      lot: GLot;
      origins: q.Origin[];
      page: string;
      stamp: string;
      sha: string;
      check: string[];
      check_stamp: string[];
      html: string;
    }[]) {
      const prod = GOLDEN.get(c.lot.sku_key) as q.Product;
      const t = q.pageText(c.lot, c.origins, prod, cfg);
      expect(t).toBe(c.page);
      expect(q.stampText(c.lot, prod)).toBe(c.stamp);
      expect(q.textSha(t)).toBe(c.sha);
      expect(q.checkPage(t, c.lot.sku_key)).toEqual(c.check);
      expect(q.checkPage(c.stamp, c.lot.sku_key)).toEqual(c.check_stamp);
      expect(q.pageHtml(t, [['a'.repeat(64), 'jpg']])).toBe(c.html);
    }
  });

  it('lời văn tất định + sạch: không PII/tọa độ/Ngọc Linh/từ cấm/mã khoảnh', () => {
    const cfg = q.loadConfig();
    const origins: q.Origin[] = [
      { plot_log_id: 7, harvest: '2026-09-01', media: ['a'.repeat(64)] },
      { plot_log_id: 9, harvest: '2026-08-20', media: [] },
    ];
    const lot: q.Lot = {
      lot_code: LOT,
      sku_key: SKU,
      mfg_date: '2026-09-15',
      exp_date: '2036-03-15',
      intake_status: 'passed',
      source: 'sample',
    };
    const prod = GOLDEN.get(SKU) as q.Product;
    const t = q.pageText(lot, origins, prod, cfg);
    expect(t).toBe(q.pageText(lot, origins, prod, cfg));
    for (const s of [
      'Mật ong sâm 120ml (1 hũ)',
      `Lô: ${LOT}`,
      'Ngày sản xuất: 15/09/2026',
      'Hạn sử dụng: 15/03/2036',
      `Vùng nguyên liệu: ${cfg.region_text}`,
      'Thu hoạch: tháng 08/2026, tháng 09/2026',
      'Ảnh tư liệu vườn: 1 ảnh',
      q.SAMPLE_LINE,
    ])
      expect(t).toContain(s);
    expect(q.checkPage(t, SKU)).toEqual([]);
    expect(maskPii(t)).toBe(t);
    expect(q.COORD_RE.test(t)).toBe(false);
    const low = t.toLowerCase();
    expect(low).not.toContain('ngọc linh');
    expect(BANNED.filter((w) => low.includes(w))).toEqual([]);
    expect(low).not.toContain('plot');
    expect(t).not.toContain('#7');
    expect(q.pageText({ ...lot, source: 'manual' }, origins, prod, cfg)).not.toContain(
      q.SAMPLE_LINE,
    );
    expect(q.textSha(t)).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
  });

  it('TPBVSK có câu khuyến cáo chuẩn; bỏ dòng cuối → thieu_khuyen_cao', () => {
    const cfg = q.validateConfig({ ...CFG, pilot_skus: [SKU, 'savina-12v'] }, GOLDEN);
    const lot: q.Lot = {
      lot_code: LOT,
      sku_key: 'savina-12v',
      mfg_date: '2026-09-15',
      exp_date: '2036-03-15',
      intake_status: 'passed',
      source: 'manual',
    };
    const prod = GOLDEN.get('savina-12v') as q.Product;
    const t = q.pageText(lot, [], prod, cfg);
    const canon = q.canonical();
    expect(t).toContain(canon);
    expect(q.checkPage(t, 'savina-12v')).toEqual([]);
    const orig = q.tail.lines;
    q.tail.lines = () => [];
    try {
      const t2 = q.pageText(lot, [], prod, cfg);
      expect(t2).not.toContain(canon);
      expect(q.checkPage(t2, 'savina-12v')).toContain('thieu_khuyen_cao');
    } finally {
      q.tail.lines = orig;
    }
    // Python `_canonical`: `_load_rules(DATA_DIR)` lỗi (thiếu file / khuyến cáo rỗng) → QrError("guardrail: …").
    const broken = join(TMP, 'rules-broken');
    mkdirSync(broken, { recursive: true });
    try {
      setGuardrailDataDir(broken);
      expect(() => q.canonical()).toThrow(
        /^guardrail: file luật guardrail\/golden không dùng được/,
      );
      const rules = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8'));
      writeFileSync(
        join(broken, 'guardrail_rules.json'),
        JSON.stringify({ ...rules, disclaimer: { canonical: '  ' } }),
      );
      writeFileSync(
        join(broken, 'golden_skus.json'),
        readFileSync(dataPath('golden_skus.json'), 'utf8'),
      );
      expect(() => q.canonical()).toThrow(q.QrError);
    } finally {
      setGuardrailDataDir();
    }
  });

  it('golden check_page (guardrail kênh qr + pii + tọa độ)', () => {
    for (const [t, sku, want] of G.check_page as [string, string, string[]][]) {
      expect(q.checkPage(t, sku), t.slice(-30)).toEqual(want);
    }
  });

  it.each([
    ['Giúp chữa bệnh', 'tu_cam'],
    ['gọi 0905123456', 'pii'],
    ['liên hệ a@b.vn', 'pii'],
    ['15.0123, 107.9876', 'toa_do'],
    ['sâm Ngọc Linh', 'ngoc_linh_chua_xac_nhan'],
  ])('check_page bắt "%s" → %s', (extra, code) => {
    const cfg = q.loadConfig();
    const lot: q.Lot = {
      lot_code: LOT,
      sku_key: SKU,
      mfg_date: '2026-09-15',
      exp_date: '2036-03-15',
      intake_status: 'passed',
      source: 'manual',
    };
    const t = `${q.pageText(lot, [], GOLDEN.get(SKU) as q.Product, cfg)}${extra}\n`;
    expect(q.checkPage(t, SKU)).toContain(code);
  });

  it('mã ngẫu nhiên 128 bit, không dẫn xuất từ lô; không bắt đầu bằng "-"', () => {
    const codes = Array.from({ length: 100 }, () => q.newCode());
    expect(new Set(codes).size).toBe(100);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(c.toLowerCase()).not.toContain(LOT.toLowerCase());
    }
    const seq = [`-${'a'.repeat(21)}`, 'b'.repeat(22)];
    expect(q.newCode(() => seq.shift() as string)).toBe('b'.repeat(22));
    const src = readFileSync(new URL('./qr-trace.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/randomBytes\(16\)/);
    const gen = src.split('export function newCode')[1]?.split('\nexport ')[0] ?? '';
    expect(gen).not.toMatch(/lot/i);
  });

  it('HTML tĩnh: escape, không script/URL ngoài, noindex, chỉ ảnh sha hợp lệ', () => {
    const t = 'Tiêu đề\nSP <script>alert(1)</script>\nLô: X & Y\n';
    const h = q.pageHtml(t, [
      ['b'.repeat(64), 'jpg'],
      ['../x', 'jpg'],
      ['c'.repeat(64), 'exe'],
    ]);
    expect(h).not.toContain('<script');
    expect(h).toContain('&lt;script&gt;');
    expect(h).not.toContain('http');
    expect(h).toContain('<meta name="robots" content="noindex">');
    expect(h.split('<img').length - 1).toBe(1);
    expect(h).toContain(`../media/${'b'.repeat(64)}.jpg`);
    const r = q.revokedHtml('2026-12-01');
    expect(r).toContain(q.REVOKED);
    expect(r).toContain('01/12/2026');
    expect(r).not.toContain('<img');
  });

  it('golden page_html/revoked_html/paused_html', () => {
    for (const c of G.html as { text: string; media: [string, string][]; html: string }[]) {
      expect(q.pageHtml(c.text, c.media)).toBe(c.html);
    }
    for (const [d, h] of G.revoked as [string, string][]) expect(q.revokedHtml(d)).toBe(h);
    expect(q.pausedHtml()).toBe(G.paused);
  });

  it('golden _has_metadata (JPEG/PNG sạch, EXIF/XMP sau SOS/EOI, đuôi thừa, hỏng)', () => {
    for (const c of G.has_metadata as { name: string; b64: string; ext: string; out: boolean }[]) {
      expect(q.hasMetadata(Buffer.from(c.b64, 'base64'), c.ext), c.name).toBe(c.out);
    }
  });
});

describe('qr_trace — phương án B (thuần)', () => {
  const cfg = G.page_cfg as q.QrConfig;
  const signedOf = (s: Record<string, string[]>) =>
    new Map(Object.entries(s).map(([k, v]) => [k, new Set(v)]));

  it('golden plan_b_report khớp Python (trước/đúng/sau mốc, rỗng)', () => {
    for (const c of G.planb as {
      lots: q.PlanLot[];
      signed: Record<string, string[]>;
      today: string;
      out: string;
    }[]) {
      expect(q.planBReport(c.lots, signedOf(c.signed), c.today, cfg, GOLDEN), c.today).toBe(c.out);
    }
  });

  const lot = (over: Partial<q.PlanLot>): q.PlanLot => ({
    lot_code: LOT,
    sku_key: SKU,
    mfg_date: '2026-09-15',
    exp_date: '2036-03-15',
    intake_status: 'passed',
    source: 'manual',
    n_origins: 1,
    issued: false,
    ...over,
  });
  const LOTS = [
    lot({ lot_code: 'MAU-MO-A', source: 'sample', intake_status: 'pending', n_origins: 0 }),
    lot({ lot_code: 'LOT-MO-B' }),
    lot({ lot_code: 'LOT-MO-C', issued: true }),
  ];
  const SIGNED = signedOf({ 'LOT-MO-B': ['gd_san_xuat'], 'LOT-MO-C': [...q.ROLE_KEYS] });
  const planb = (day: string) => q.planBReport(LOTS, SIGNED, day, q.loadConfig(), GOLDEN);

  it('trước mốc: đếm ngày, chưa đề xuất, không lời văn tem', () => {
    const out = planb('2026-11-26');
    expect(out).toContain('còn 1 ngày');
    expect(out).not.toContain('ĐỀ XUẤT');
    expect(out).not.toContain('Lời văn tem');
    expect(out).not.toContain('Hạn sử dụng');
    expect(out).toContain('GĐ vùng trồng, Pháp chế/QA');
    expect(out).toBe(planb('2026-11-26'));
  });

  it.each(['2026-11-27', '2026-11-28'])('từ mốc %s: ĐỀ XUẤT tem không QR cho lô passed', (day) => {
    const out = planb(day);
    expect(out).toBe(planb(day));
    expect(out).toContain('ĐỀ XUẤT phương án B');
    expect(out).toContain('agent KHÔNG tự đổi tem');
    const [issued, todo] = out.split('Chưa phát hành:') as [string, string];
    expect(issued).toContain('LOT-MO-C');
    expect(todo).not.toContain('LOT-MO-C');
    const a = (todo.split('- lô MAU-MO-A')[1] ?? '').split('- lô')[0] as string;
    expect(todo).toContain('[MẪU]');
    expect(a).toContain('chưa đủ điều kiện in tem');
    const b = todo.split('- lô LOT-MO-B')[1] as string;
    expect(b).toContain('Lời văn tem KHÔNG QR (guardrail: OK)');
    expect(b).toContain('Hạn sử dụng: 15/03/2036');
    expect(b).not.toContain('Vùng nguyên liệu');
    expect(out).not.toContain('http');
    for (const n of Object.values(SIGN)) expect(out).not.toContain(n);
  });
});

describe('qr_trace — tiện ích kiểu Python (golden)', () => {
  it('date.fromisoformat (bản C 3.12)', () => {
    for (const [s, want] of G.fromisoformat as [string, string | null][]) {
      expect(q.pyDateFromIso(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('production._clean', () => {
    for (const [s, n, want] of G.clean as [string, number, string][])
      expect(q.clean(s, n)).toBe(want);
  });

  it('kiểu tham số argparse (--by/--lot/--note/--date/--log/--media/--code)', () => {
    const fns: Record<string, (s: string) => string> = q.argTypes;
    for (const [k, cases] of Object.entries(
      G.args as unknown as Record<string, [string, unknown, string | null][]>,
    )) {
      const fn = fns[k] as (s: string) => string;
      for (const [s, want, err] of cases) {
        if (err !== null) expect(() => fn(s), `${k} ${JSON.stringify(s)}`).toThrow(err);
        else expect(fn(s), `${k} ${JSON.stringify(s)}`).toBe(String(want));
      }
    }
    expect(() => q.argTypes.lot(TS_STRICTER.trailing_newline[0] as string)).toThrow();
    expect(() => q.argTypes.sha(TS_STRICTER.trailing_newline[1] as string)).toThrow();
    expect(() => q.argTypes.code(TS_STRICTER.trailing_newline[2] as string)).toThrow();
  });
});

describe('qr_trace — CLI không DB (usage exit 2, chặn TRƯỚC connect)', () => {
  const noConnect = () => {
    const calls: number[] = [];
    return {
      calls,
      connect: async () => {
        calls.push(1);
        throw new Error('không được connect');
      },
    };
  };

  it.each<[string | undefined, q.QrOpts, string[]?]>([
    ['link', { lot: LOT, log: '1' }],
    ['link', { lot: LOT, log: '1', by: '   ' }],
    ['unlink', { lot: LOT, log: '1' }],
    ['sign', { lot: LOT, role: 'gd_san_xuat' }],
    ['sign', { lot: LOT, role: 'gd_san_xuat', by: ' ' }],
    ['sign', { lot: LOT, role: 'tgd', by: 'A' }],
    ['issue', { lot: LOT }],
    ['issue', { lot: LOT, by: 'x'.repeat(101) }],
    ['revoke', { code: 'A'.repeat(22) }],
    ['revoke', { code: 'ngan', by: 'A' }],
    ['link', { lot: LOT, log: '1', media: ['xyz'], by: 'A' }],
    ['planb', { date: '27/11/2026' }],
    ['preview', { lot: LOT, by: 'A' }], // cờ không thuộc lệnh
    ['site', {}, ['thua']],
    [undefined, {}],
    ['xoa', {}],
  ])('%s %j → exit 2, không connect', async (cmd, o, rest) => {
    const nc = noConnect();
    const c = cap();
    expect(await q.qrTraceMain(cmd, o, { io: c.io, connect: nc.connect }, rest ?? [])).toBe(2);
    expect(nc.calls).toEqual([]);
    expect(c.o.err.join('\n')).toContain('error:');
  });

  it('sign: allowlist kiểm TRƯỚC connect (rỗng → external-dep; người ngoài/sai vai → từ chối)', async () => {
    const nc = noConnect();
    const c = cap();
    const argv = (by: string): q.QrOpts => ({ lot: LOT, role: 'phap_che_qa', by });
    expect(await q.qrTraceMain('sign', argv('Ai Đó'), { io: c.io, connect: nc.connect })).toBe(1);
    expect(c.text()).toContain('external-dep');
    const sf = write(SIGNERS_DOC);
    const d = { io: c.io, connect: nc.connect, signersFile: sf };
    expect(await q.qrTraceMain('sign', argv('Người Ngoài'), d)).toBe(1);
    // đúng người nhưng SAI vai → cũng từ chối trước connect
    expect(await q.qrTraceMain('sign', argv(SIGN.gd_san_xuat), d)).toBe(1);
    expect(c.text()).toContain('không thuộc danh sách');
    expect(c.text()).toContain('không connect');
    expect(nc.calls).toEqual([]);
  });

  it('cấu hình hỏng → exit 1, không connect, không ghi trang', async () => {
    const nc = noConnect();
    const c = cap();
    const out = join(TMP, 'o');
    let d: q.QrDeps = { io: c.io, connect: nc.connect, configFile: write('{}') };
    for (const [cmd, o] of [
      ['link', { lot: LOT, log: '1', by: 'A' }],
      ['preview', { lot: LOT }],
      ['issue', { lot: LOT, by: 'A' }],
      ['site', { out }],
      ['planb', {}],
    ] as [string, q.QrOpts][]) {
      expect(await q.qrTraceMain(cmd, o, d), cmd).toBe(1);
    }
    d = { ...d, configFile: write({ ...CFG, pilot_skus: [SKU, 'ruou-sam-chai-thuy-tinh-500ml'] }) };
    expect(await q.qrTraceMain('planb', {}, d)).toBe(1);
    expect(c.text()).toContain('không connect');
    expect(nc.calls).toEqual([]);
    expect(() => readFileSync(join(out, 'x'))).toThrow();
  });

  it('mô tả lệnh qr-trace liệt kê đủ 8 lệnh con', () => {
    const src = readFileSync(new URL('./qr-anchor.command.ts', import.meta.url), 'utf8');
    const desc = src.split("name: 'qr-trace'")[1]?.split('})')[0] ?? '';
    for (const c of ['link', 'unlink', 'preview', 'sign', 'issue', 'revoke', 'site', 'planb']) {
      expect(desc).toMatch(new RegExp(`(?<![a-z_-])${c}(?![a-z_-])`));
    }
  });

  it('mã nguồn KHÔNG insert/update/delete thẳng bảng QR/approvals/lot_origins', () => {
    const src = readFileSync(new URL('./qr-trace.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/insert\s+into\s+(approvals|qr_|lot_origins)/i);
    expect(src).not.toMatch(/(update|delete\s+from)\s+(qr_|lot_origins|approvals)/i);
  });
});
