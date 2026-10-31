import { readFileSync } from 'node:fs';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { repoPath } from '@samsam/core/paths';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { PII_RE } from '@samsam/core/security/pii';
import { describe, expect, it } from 'vitest';
import { section, validate as validateWatch } from '../sales_director/sales-watch.js';
import BQ from './__fixtures__/build_quote.golden.json' with { type: 'json' };
import CLS from './__fixtures__/classify.golden.json' with { type: 'json' };
import GATE from './__fixtures__/gate.golden.json' with { type: 'json' };
import MISC from './__fixtures__/kq_misc.golden.json' with { type: 'json' };
import HTML from './__fixtures__/render_html.golden.json' with { type: 'json' };
import SW from './__fixtures__/sales_watch.golden.json' with { type: 'json' };
import VM from './__fixtures__/validate_matrix.golden.json' with { type: 'json' };
import * as kq from './kd-quote.js';
import { canonical, isoDay } from './py.js';

// Dịch phần THUẦN của tests/test_kd_quote.py + tests/test_r12_dot3.py (approved_golden) và golden
// sinh từ hàm Python thật (agents/kd_quote.py) — ma trận, định giá/phân loại, báo giá, HTML, cổng.

const j = (p: string) => JSON.parse(readFileSync(repoPath(p), 'utf8'));
const GOLD = j('tests/fixtures/b2b/golden_MAU.json');
const MX = j('tests/fixtures/b2b/matrix_MAU.json');
const BOM = j('tests/fixtures/b2b/bom_MAU.json').combos;
const MX_REAL = j('data/b2b_pricing.json');
const SAMPLE_BOM = j('data/sample_bom.json').combos;
const GOLD_REAL = kq.readGolden(kq.GOLDEN_FILE)[0] as kq.Dict;
const DAY = '2026-10-12';
const H1 = 'mat-ong-sam-120ml-1hu';
type Case = {
  items: unknown;
  cogs: kq.CogsVersion[];
  matrix: unknown;
  golden: string;
  discount: number | null;
  result: unknown;
};
const mx = (m: unknown) => (m === 'MX' ? MX : m === 'MX_REAL' ? MX_REAL : m) as kq.Dict;
const gd = (g: string) => (g === 'GOLD' ? GOLD : GOLD_REAL);

describe('ma trận (validate_matrix)', () => {
  it('ma trận thật hợp lệ + GIẢ ĐỊNH, không key rượu', () => {
    expect(kq.validateMatrix(MX_REAL, GOLD_REAL, SAMPLE_BOM)).toEqual(VM.real);
    expect(VM.real).toEqual([]);
    expect(MX_REAL.finance_confirmed).toBeNull();
    expect(MX_REAL.sales_confirmed).toBeNull();
    expect(MX_REAL.status).toContain('GIẢ ĐỊNH');
    const g = kq.gidx(GOLD_REAL);
    const c = kq.cidx(SAMPLE_BOM);
    for (const k of Object.keys(MX_REAL.items)) expect(kq.isAlcoholKey(k, g, c), k).toBe(false);
    expect(kq.validateMatrix(MX, GOLD, BOM)).toEqual(VM.mau);
    expect(kq.validateMatrix([1], GOLD_REAL, SAMPLE_BOM)).toEqual(VM['not-object']);
    // golden mặc định = đọc data/golden_skus.json (như Python golden=None)
    expect(kq.validateMatrix(MX_REAL)).toEqual([]);
  });

  it.each(Object.entries(VM.muts))('golden lỗi %s', (_name, c) => {
    expect(kq.validateMatrix(c.doc, GOLD_REAL, SAMPLE_BOM)).toEqual(c.errs);
  });

  it('số thực viết dạng 5.0 = float như Python (không lọt kiểm int)', () => {
    const doc = parsePyJson(
      JSON.stringify(MX_REAL).replace('"discount_pct":5', '"discount_pct":5.0'),
    ) as kq.Dict;
    expect(kq.validateMatrix(doc, GOLD_REAL, SAMPLE_BOM)).toEqual([
      'tiers[0]: discount_pct nguyên 0..50',
    ]);
    const [m2] = kq.readMatrix(repoPath('data/b2b_pricing.json'));
    expect(m2).toEqual(MX_REAL);
  });

  it('readMatrix: thiếu / hỏng / không phải object → lý do, không ném', () => {
    expect(kq.readMatrix(repoPath('data/khong-co-file.json'))).toEqual([
      null,
      'thiếu file khong-co-file.json',
    ]);
    expect(kq.readMatrix(repoPath('tests/fixtures/du_an/to_chuc_MAU.csv'))[1]).toBe(
      'to_chuc_MAU.csv hỏng (JSONDecodeError)',
    );
  });

  it('TS_STRICTER: ngày xác nhận dạng tuần ISO bị từ chối (Python nhận) — fail-closed', () => {
    expect(isoDay('2026-10-01')).toBe('2026-10-01');
    expect(isoDay('20261001')).toBe('2026-10-01');
    for (const s of ['2026-W40-4', '2026-02-30', '2026-10-01 ', 5, null])
      expect(isoDay(s)).toBeNull();
  });
});

describe('định giá + phân loại (classify)', () => {
  it.each(Object.entries(CLS as Record<string, Case>))('golden %s', (_n, c) => {
    const r = kq.classify(c.items, mx(c.matrix), gd(c.golden), BOM, c.cogs, DAY, c.discount);
    expect(r).toEqual(c.result);
  });

  it('số đúng ca chuẩn + biên so CHƯA làm tròn (29.96% không lọt ngưỡng 30)', () => {
    const r = kq.classify([{ key: H1, qty: 20 }], MX, GOLD, BOM, CLS.exact.cogs, DAY);
    const ln = r.lines[0] as kq.Line;
    expect([ln.list_unit, ln.discount_pct, ln.unit, ln.amount]).toEqual([
      745000, 5, 707000, 14140000,
    ]);
    expect([r.total, r.cogs_total, r.margin_pct, r.within_matrix]).toEqual([
      14140000,
      6000000,
      '57.6',
      true,
    ]);
    expect(CLS['margin-495182'].result.within_matrix).toBe(false);
    expect(CLS['margin-495182'].result.margin_pct).toBe('30.0');
  });

  it('discount ngoài 0..100 → RangeError (Python ValueError)', () => {
    expect(() => kq.classify([{ key: H1, qty: 20 }], MX, GOLD, BOM, [], DAY, 101)).toThrow(
      RangeError,
    );
  });

  it('TS_STRICTER: số tiền vượt giới hạn tính chính xác → dừng (Python int không giới hạn)', () => {
    const g = {
      skus: [{ sku_key: 'x', category: 'food', prices: { shopee: { list: 10 ** 12, floor: 1 } } }],
    };
    const m = { ...MX, items: { x: { max_discount_pct: 5 } } };
    expect(() => kq.classify([{ key: 'x', qty: 90000 }], m, g, [], [], DAY)).toThrow(RangeError);
  });

  it('thuần: không import mạng/DB/AI Gateway (không đường gửi email)', () => {
    for (const f of ['kd-quote.ts', 'kd-catalog.ts', 'da-b2b.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(
        /node:(http|https|net|tls|dgram)|nodemailer|fetch\(|ai\/gateway|AiGateway|smtp|sendmail|@samsam\/core\/db/i,
      );
    }
  });
});

describe('báo giá (build_quote) + HTML + cổng', () => {
  it.each(Object.entries(BQ))('golden %s', (_n, c) => {
    const golden = gd(c.golden);
    const r = kq.classify(c.items, MX, golden, BOM, c.cogs as kq.CogsVersion[], DAY);
    const b = kq.buildQuote(c.req as kq.QuoteRequest, r, golden, DAY, MX);
    expect(b).toEqual(c.built);
    expect(b.payload ? kq.renderHtml(b.payload) : null).toBe(c.html);
    const gate = b.quote_no
      ? kq.gateQuote(b.payload, kq.alcoholNames(golden), kq.readinessMap(golden), [b.quote_no])
      : null;
    expect(gate).toEqual(c.gate);
  });

  it('báo giá: không PII người liên hệ, không giá vốn nội bộ, quote_no ổn định', () => {
    const c = BQ['pii-req'];
    for (const s of ['Nguoi Lien He Mau', '0901234567', 'lienhe.mau@example.com']) {
      expect(c.built.payload).not.toContain(s);
      expect(c.built.internal).not.toContain(s);
    }
    const p = BQ['mat-ong-real'].built;
    expect(p.quote_no).toMatch(/^BG-20261012-7-[0-9a-f]{8}$/);
    expect(p.payload).not.toContain('Ngọc Linh');
    expect(p.payload).not.toContain('300.000');
    expect(p.payload.toLowerCase()).not.toContain('biên');
    expect(p.internal).toContain('57.6%');
    expect(PII_RE.test(p.payload.replace(p.quote_no as string, ''))).toBe(false);
    expect(kq.disclaimer()).toBe(MISC.disclaimer);
    expect(BQ['tpbvsk-real'].built.payload).toContain(kq.disclaimer());
    expect(BQ['tu-cam'].gate).toContain('guardrail:tu_cam');
    expect(isAlcohol(p.payload)).toBe(false);
    expect(isAlcohol(kq.renderHtml(p.payload))).toBe(false);
  });

  it('báo giá có problems → không payload', () => {
    expect(BQ.ruou.built).toEqual({
      quote_no: null,
      payload: '',
      internal: '',
      problems: ['ruou_khong_bao_gia'],
    });
  });

  it.each(Object.entries(HTML))('render_html golden %s', (_n, c) => {
    expect(kq.renderHtml(c.payload)).toBe(c.html);
    expect(kq.titleOf(c.payload)).toBe(c.title);
    expect(kq.renderHtml(c.payload, 'Tiêu đề <x>')).toBe(c.html_t);
  });

  it('HTML tất định, escape, không tài nguyên ngoài; ảnh chỉ packshots/ tương đối', () => {
    const h = BQ['html-escape'].html as string;
    expect(h.toLowerCase()).not.toContain('<script');
    expect(h).toContain('&lt;script&gt;');
    expect(h).not.toMatch(/(src|href)="(https?:|\/\/)/i);
    const img = HTML.img.html;
    expect(img).toContain('<img src="packshots/mat-ong.png" alt="a">');
    expect(img).not.toContain('<img src="https');
  });

  it.each(Object.entries(GATE.cases))('cổng tài liệu golden %s', (_n, c) => {
    expect(kq.gateQuote(c.payload, GATE.names, kq.readinessMap(GOLD), c.ids)).toEqual(c.post);
    expect(
      kq.gateText(c.payload, GATE.names, {
        contentType: 'ads',
        readiness: kq.readinessMap(GOLD),
        ids: c.ids,
      }),
    ).toEqual(c.ads);
  });

  it('tên rượu + readiness map + tiện ích (vnd/md/canonical/sha/approved_golden)', () => {
    expect(kq.alcoholNames(GOLD)).toEqual(GATE.names);
    expect(kq.alcoholNames(GOLD_REAL)).toEqual(GATE.alcohol_names_real);
    expect(Object.fromEntries(kq.readinessMap(GOLD_REAL))).toEqual(GATE.readiness_real);
    expect(Object.fromEntries(kq.readinessMap(GOLD))).toEqual(GATE.readiness_mau);
    const g = kq.gidx(GOLD);
    const c = kq.cidx(BOM);
    for (const [k, v] of Object.entries(MISC.is_alcohol_key))
      expect(kq.isAlcoholKey(k, g, c), k).toBe(v);
    expect([null, 0, 5, 1000, 707000, 14140000, 1234567890123, -1500].map(kq.vnd)).toEqual(
      MISC.vnd,
    );
    expect([null, '', 'a  b\n c', 'x|y', '   t', 5].map(kq.md)).toEqual(MISC.md);
    expect(kq.quoteNo(7, CLS.exact.result as unknown as kq.Classified, DAY)).toBe(MISC.quote_no);
    expect(canonical({ b: [1, 'ă'], a: { z: null, é: true }, é: '\n"\\' })).toBe(MISC.canonical);
    expect(kq.matrixSha(MX_REAL)).toBe(MISC.matrix_sha_real);
    const prices: kq.GoldenPrices = new Map<string, Record<string, kq.PriceCell>>([
      [
        'a\u0000shopee',
        {
          list: { price: 100, approved: true, id: 1 },
          floor: { price: 50, approved: false, id: 2 },
        },
      ],
      [`${H1}\u0000shopee`, { list: { price: 745000, approved: true, id: 3 } }],
      [`${H1}\u0000web`, { floor: { price: 1, approved: true, id: 4 } }],
    ]);
    const golden = {
      x: 1,
      skus: [
        { sku_key: 'a', prices: { shopee: { list: 9 } } },
        { sku_key: H1 },
        'khong-dict',
        { sku_key: 'b' },
      ],
    };
    expect(kq.approvedGolden(golden, prices)).toEqual(MISC.approved_golden);
    // r12 L2: giá chưa duyệt không vào báo giá (không fallback giá JSON)
    const ag = kq.gidx(kq.approvedGolden(golden, prices));
    expect(kq.sumPrice([['a', 1]], ag, 'shopee', 'floor')).toBeNull();
    expect(kq.sumPrice([['b', 1]], ag, 'shopee', 'list')).toBeNull();
  });
});

describe('sales_watch (dùng chung với nhóm sales_director)', () => {
  const doc = () => j('data/sales_watch.json');
  const M: Record<string, ((d: kq.Dict) => void) | null> = {
    'khoa-la': (d) => {
      d.la = 1;
    },
    'max-per-run-0': (d) => {
      (d.lead_owner as kq.Dict).max_per_run = 0;
    },
    'staff-ten': (d) => {
      (d.lead_owner as kq.Dict).staff_codes = ['Nguyễn An'];
    },
    'staff-thuong': (d) => {
      (d.lead_owner as kq.Dict).staff_codes = ['nv01'];
    },
    'staff-trung': (d) => {
      (d.lead_owner as kq.Dict).staff_codes = ['NV01', 'NV01'];
    },
    'after-bool': (d) => {
      (d.quote_followup as kq.Dict).after_business_hours = true;
    },
    'thieu-max': (d) => {
      delete (d.quote_followup as kq.Dict).max_reminders;
    },
    'channels-rong': (d) => {
      (d.dealer_price as kq.Dict).channels = [];
    },
    'return-rong': (d) => {
      (d.order_watch as kq.Dict).return_status = {};
    },
    'confirmed-trong': (d) => {
      d.confirmed_by = '';
    },
    'status-thieu': (d) => {
      delete d.status;
    },
    'not-object': null,
  };
  it('quote_followup cấu hình thật + biến thể lỗi fail-closed (golden Python)', () => {
    expect(section('quote_followup')).toEqual(SW.ok);
    for (const [k, f] of Object.entries(M)) {
      let msg: string | null = null;
      try {
        if (f === null) validateWatch([1]);
        else {
          const d = doc();
          f(d);
          validateWatch(d);
        }
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, k).toBe((SW as Record<string, unknown>)[k]);
    }
  });
});
