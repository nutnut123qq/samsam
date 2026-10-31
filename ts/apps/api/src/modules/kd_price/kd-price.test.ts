import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@samsam/core/ops/director';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { dataPath, repoPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { describe, expect, it } from 'vitest';
import { section } from '../sales_director/sales-watch.js';
import G from './__fixtures__/kd_price.golden.json' with { type: 'json' };
import { payload as comboPayload, evaluate, loadCfg } from './combo-price.js';
import { loadDealerObs, readDealerFile, urlOk } from './dealer-price.js';
import {
  type CogsVersion,
  clean,
  evidenceSha,
  type GoldenPrices,
  key2,
  type ListingRow,
  type PriceCell,
  planOf,
  pyDate,
  pyDumps,
  type Ratio,
  ratio,
  refCode,
  toInt,
  vnd,
} from './deps.js';
import { type CmdDeps, comboPriceMain, dealerPriceMain, kdPriceMain } from './kd-price.command.js';
import {
  type Analysis,
  type Competitor,
  cell,
  checkListingPrices,
  checkPromos,
  type DealerFinding,
  dealerItem,
  type Finding,
  financeItems,
  host,
  loadNetRatio,
  loadWatch,
  markDups,
  mergePlan,
  objectType,
  type PlanRow,
  payloadOf,
  readPlan,
  renderReport,
  SEVERITY,
  seasonEvents,
  toItems,
  validateWatch,
  type Watch,
} from './kd-price.js';
import { loadCalendar, validate as validateCalendar } from './mkt-calendar.js';

// Dịch tests/test_kd_price.py (phần thuần + CLI không DB), phần thuần của tests/test_contract_c08_promo_loss.py,
// tests/test_contract_c09_combo_price.py, tests/test_r12_dot4.py (G1-L6) và sales-06.1 của
// tests/test_v14_p4_sales.py. Golden sinh từ hàm Python thật (__fixtures__/kd_price.golden.json); DB ở
// kd-price.db.test.ts.

type Any = Record<string, unknown>;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const b64 = (s: string) => Buffer.from(s, 'base64');
const WATCH = loadWatch(dataPath('price_watch.json'))[0] as Watch;
const CAL = loadCalendar();
const CFG = loadConfig('sales');
const NET = Object.fromEntries(Object.entries(G.net).map(([k, v]) => [k, ratio(v)]));
const gp = (rows: unknown[]): GoldenPrices => {
  const m: GoldenPrices = new Map();
  for (const [s, ch, cell] of rows as [string, string, Record<string, PriceCell>][])
    m.set(key2(s, ch), cell);
  return m;
};
const rd = (rows: unknown[]) =>
  new Map((rows as [string, string, string][]).map(([s, ch, v]) => [key2(s, ch), v]));
const prom = (rows: unknown[]) =>
  new Set((rows as [string, string][]).map(([s, ch]) => key2(s, ch)));
const net = (o: Record<string, string> | null) =>
  o === null ? null : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ratio(v)]));
const nonInfo = (fs: Finding[]) => fs.filter((f) => f.severity !== 'INFO');

/** Khác Python có chủ đích (TS chặt hơn = fail-closed) — tên ca + lý do. */
const TS_STRICTER: Record<string, string> = {
  'load_watch.nan':
    'JSON.parse từ chối NaN (Python json.loads nhận rồi validate báo thiếu status) — vẫn lỗi',
};

describe('tiện ích (golden)', () => {
  it('ref_code / vnd / evidence_sha / _to_int / _clean / _cell / _host / _date', () => {
    for (const [s, want] of G.ref_code) expect(refCode(s), String(s)).toBe(want);
    for (const [n, want] of G.vnd) expect(vnd(n as number | null)).toBe(want);
    for (const [ev, want] of G.evidence_sha) expect(evidenceSha(ev as Any)).toBe(want);
    for (const [s, want] of G.to_int) expect(toInt(s as string, 10 ** 15), String(s)).toBe(want);
    for (const [s, n, want] of G.clean) expect(clean(s, n as number)).toBe(want);
    for (const [s, n, want] of G.cell) expect(cell(s, n as number)).toBe(want);
    for (const [u, want] of G.host) expect(host(u), String(u)).toBe(want);
    for (const [s, want] of G.date) expect(pyDate(s), String(s)).toBe(want);
  });

  it('json.dumps ensure_ascii cho khóa sha combo', () => {
    const c = G.combo.full;
    const out = c.out as Any;
    expect(pyDumps([c.items, out.base, out.floor, out.cost, out.options], { ascii: true })).toBe(
      G.combo_sig_src,
    );
  });
});

describe('W53.1 cấu hình price_watch / fpa / lịch mùa', () => {
  it('cấu hình ship hợp lệ, GIẢ ĐỊNH, ≤ 49%, kênh ⊂ sàn; sales.json đủ loại việc risk high/B/96', () => {
    const raw = JSON.parse(readFileSync(dataPath('price_watch.json'), 'utf8'));
    expect(raw.confirmed_by).toBeNull();
    expect(raw._doc).toContain('GIẢ ĐỊNH');
    expect(validateWatch(raw)).toBeNull();
    for (const t of ['listing_sync', 'promo_change', 'price_change']) {
      const s = CFG.object_types[t] as Any;
      expect([s.risk, s.handoff, s.sla_hours]).toEqual(['high', 'B', 96]);
    }
  });

  it('validate_watch mọi biến thể khớp Python', () => {
    // Dựng lại biến thể từ file ship như Python `_cfg(**over)`.
    const base = parsePyJson(readFileSync(dataPath('price_watch.json'), 'utf8')) as Any;
    const over = (o: Any, drop: string[] = []) => {
      const d: Any = { ...base, ...o };
      for (const k of drop) delete d[k];
      return d;
    };
    const cases: Record<string, unknown> = {
      ship: base,
      list: [],
      rong_obj: {},
      chi_doc: { _doc: 'x' },
      cap_50: over({ max_discount_pct: { shopee: 50, tiktok: 40 } }),
      cap_49: over({ max_discount_pct: { shopee: 49, tiktok: 1 } }),
      kenh_la: over({ channels: ['shopee', 'lazada'] }),
      kenh_trung: over({ channels: ['shopee', 'shopee'] }),
      kenh_rong: over({ channels: [] }),
      lech_0: over({ list_deviation_pct: 0 }),
      lech_50: over({ list_deviation_pct: 50 }),
      key_la: over({ extra: 1, zz: 2, aa: 3 }),
      thieu_kenh_cap: over({ max_discount_pct: { shopee: 40 } }),
      lookahead_0: over({ lookahead_days: 0 }),
      lookahead_120: over({ lookahead_days: 120 }),
      loai_km_la: over({ promo_kinds: ['mua1tang1'] }),
      loai_km_trung: over({ promo_kinds: ['voucher', 'voucher'] }),
      thieu_status: over({}, ['status']),
      status_trang: over({ status: '  ' }),
      confirmed_rong: over({ confirmed_by: '' }),
      confirmed_so: over({ confirmed_by: 5 }),
      thieu_confirmed: over({}, ['confirmed_by']),
      confirmed_ten: over({ confirmed_by: 'GĐ bán hàng' }),
      stacked_11: over({ max_stacked_promos: 11 }),
      cap_khong_dict: over({ max_discount_pct: [40, 40] }),
    };
    for (const [k, doc] of Object.entries(cases)) {
      expect(validateWatch(doc), k).toBe((G.validate_watch as Any)[k]);
    }
    // Số thực 5.0 / bool KHÔNG phải số nguyên (Python isinstance int).
    const txt = readFileSync(dataPath('price_watch.json'), 'utf8');
    expect(
      validateWatch(
        parsePyJson(txt.replace('"list_deviation_pct": 5', '"list_deviation_pct": 5.0')),
      ),
    ).toBe(G.validate_watch_text.lech_float);
    expect(validateWatch(over({ list_deviation_pct: true }))).toBe(G.validate_watch_text.bool_so);
  });

  it('load_watch: file thiếu/rỗng/trắng/hỏng/không UTF-8/list → lỗi; BOM ok', () => {
    const dir = tmp('kdp-w-');
    for (const [name, c] of Object.entries(G.load_watch)) {
      const p = join(dir, `w_${name}.json`);
      if (c.data !== null) writeFileSync(p, b64(c.data));
      const [w, why] = loadWatch(p);
      expect(w !== null, name).toBe(c.ok);
      if (TS_STRICTER[`load_watch.${name}`])
        expect(why, name).toBe(`w_${name}.json JSON hỏng: JSONDecodeError`);
      else expect(why, name).toBe(c.why);
    }
  });

  it('net_ratio từ fpa_config.cash.net_ratio_default (Decimal(str(v)))', () => {
    for (const [name, c] of Object.entries(G.net_ratio)) {
      let p = dataPath('fpa_config.json');
      if (name !== 'ship') {
        p = join(tmp('kdp-fpa-'), 'fpa_config.json');
        if (c.text !== null) writeFileSync(p, c.text as string, 'utf8');
      }
      const [n, why] = loadNetRatio(['shopee', 'tiktok'], p);
      expect(
        n === null ? null : Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.s])),
        name,
      ).toEqual(c.net);
      expect(why, name).toBe(c.why);
    }
    // file không phải fpa (README) → không có mục cash
    expect(
      loadNetRatio(['shopee'], repoPath('tests', 'fixtures', 'kd_price', 'README.md'))[0],
    ).toBeNull();
  });

  it('lịch mùa: ngày sự kiện + biến thể hỏng + file', () => {
    expect(
      CAL.events.map((e) => [e.id, (G.calendar_events.find((x) => x[0] === e.id) ?? [])[1]]),
    ).toEqual(G.calendar_events);
    const base = parsePyJson(readFileSync(dataPath('marketing_calendar.json'), 'utf8')) as Any;
    const cl = () =>
      structuredClone(base) as Any & {
        events: Any[];
        campaigns: Any[];
        daily_posts: Any & { evergreen: Any[] };
      };
    const m = (f: (d: ReturnType<typeof cl>) => void) => {
      const d = cl();
      f(d);
      return d;
    };
    const ev0 = () => (base.events as Any[])[0] as Any;
    const c0 = () => (base.campaigns as Any[])[0] as Any;
    const e0 = () => ((base.daily_posts as Any).evergreen as Any[])[0] as Any;
    const cases: Record<string, unknown> = {
      list: [],
      rong: {},
      status_trang: m((d) => {
        d.status = ' ';
      }),
      thieu_lead: m((d) => {
        delete d.lead;
      }),
      publish_hour_24: m((d) => {
        (d.lead as Any).publish_hour = 24;
      }),
      publish_hour_bool: m((d) => {
        (d.lead as Any).publish_hour = true;
      }),
      ws_ge_we: m((d) => {
        (d.lead as Any).work_start_hour = 17;
        (d.lead as Any).work_end_hour = 8;
      }),
      nwd_khong_list: m((d) => {
        d.non_working_days = 'x';
      }),
      nwd_sai: m((d) => {
        d.non_working_days = ['2026-13-01'];
      }),
      nwd_dang: m((d) => {
        d.non_working_days = ['1/1/2026'];
      }),
      reminder_rong: m((d) => {
        d.reminder_days = [];
      }),
      reminder_61: m((d) => {
        d.reminder_days = [61];
      }),
      thieu_caps: m((d) => {
        delete d.review_caps;
      }),
      events_rong: m((d) => {
        d.events = [];
      }),
      event_khong_obj: m((d) => d.events.push(5 as never)),
      event_id_sai: m((d) => d.events.push({ ...ev0(), id: 'X Y' })),
      event_id_trung: m((d) => d.events.push({ ...ev0() })),
      event_kind_sai: m((d) => d.events.push({ ...ev0(), id: 'zz', kind: 'x' })),
      event_remind: m((d) => d.events.push({ ...ev0(), id: 'zz', remind: 1 })),
      event_ca_hai: m((d) => d.events.push({ ...ev0(), id: 'zz', lunar_new_year: 2027 })),
      event_tet_la: m((d) =>
        d.events.push({ id: 'zz', kind: 'tet', remind: true, lunar_new_year: 2031 }),
      ),
      event_ngoai: m((d) =>
        d.events.push({ id: 'zz', kind: 'sale', remind: true, date: '1999-01-01' }),
      ),
      event_offset: m((d) =>
        d.events.push({
          id: 'zz',
          kind: 'sale',
          remind: true,
          date: '2026-01-01',
          offset_days: 61,
        }),
      ),
      event_off_days: m((d) =>
        d.events.push({ id: 'zz', kind: 'sale', remind: true, date: '2026-01-01', off_days: [16] }),
      ),
      harvest_status: m((d) =>
        d.events.push({ id: 'zz', kind: 'harvest', remind: true, date: '2026-01-01' }),
      ),
      camps_rong: m((d) => {
        d.campaigns = [];
      }),
      camp_event_la: m((d) => d.campaigns.push({ ...c0(), id: 'zz', event: 'khong-co' })),
      camp_kenh_la: m((d) => d.campaigns.push({ ...c0(), id: 'zz', channels: ['lazada'] })),
      camp_fmt_la: m((d) => d.campaigns.push({ ...c0(), id: 'zz', formats: ['x'] })),
      camp_skus: m((d) => d.campaigns.push({ ...c0(), id: 'zz', skus: [''] })),
      camp_pillar: m((d) => d.campaigns.push({ ...c0(), id: 'zz', pillar: ' ' })),
      camp_offset: m((d) => d.campaigns.push({ ...c0(), id: 'zz', publish_offset_days: 1 })),
      daily_khong_obj: m((d) => {
        d.daily_posts = [] as never;
      }),
      daily_per_day: m((d) => {
        d.daily_posts.per_day = 10;
      }),
      daily_ev_rong: m((d) => {
        d.daily_posts.evergreen = [];
      }),
      daily_kenh: m((d) => d.daily_posts.evergreen.push({ ...e0(), id: 'zz', channel: 'shopee' })),
      daily_trung: m((d) => d.daily_posts.evergreen.push({ ...e0() })),
      khong_daily: m((d) => {
        delete (d as Any).daily_posts;
      }),
    };
    expect(Object.keys(cases).sort()).toEqual(Object.keys(G.calendar_validate).sort());
    for (const [k, doc] of Object.entries(cases)) {
      let got: string | null = null;
      try {
        validateCalendar(doc);
      } catch (e) {
        got = (e as Error).message;
      }
      expect(got, k).toBe((G.calendar_validate as Any)[k]);
    }
    const dir = tmp('kdp-cal-');
    for (const [name, c] of Object.entries(G.calendar_file)) {
      const p = join(dir, `cal_${name}.json`);
      if (c.data !== null) writeFileSync(p, b64(c.data));
      let got: string | null = null;
      try {
        loadCalendar(p);
      } catch (e) {
        got = (e as Error).message;
      }
      expect(got, name).toBe(c.err);
    }
  });
});

describe('W53.4 luật giá đang chạy (THUẦN)', () => {
  it('mọi ca khớp Python: phát hiện, mục hàng duyệt, payload', () => {
    for (const [name, c] of Object.entries(G.listing)) {
      const fs = checkListingPrices(
        c.rows as ListingRow[],
        gp(c.golden),
        c.cogs as CogsVersion[],
        NET,
        WATCH,
        G.today,
        rd(c.readiness),
      );
      expect(fs, name).toEqual(c.out);
      expect(toItems(fs, CFG), name).toEqual(c.items);
      expect(nonInfo(fs).map(payloadOf), name).toEqual(c.payloads);
    }
  });

  it('S1 dưới giá sàn kể cả floor chưa duyệt; biên âm; lệch niêm yết đúng biên nguyên; trần KM', () => {
    const k = (n: string) =>
      nonInfo(G.listing[n as keyof typeof G.listing].out as Finding[])
        .map((f) => f.kind)
        .sort();
    expect(k('below_floor_unapproved')).toEqual(['below_floor']);
    expect(k('at_floor')).toEqual([]);
    expect(k('neg_margin')).toEqual(['negative_margin']); // 200000 × 0.85 = 170000 < 170001
    expect(k('zero_margin')).toEqual([]);
    expect(k('cogs_unapproved')).toEqual([]); // giá vốn chưa duyệt KHÔNG suy 0
    expect(k('dev_at')).toEqual([]);
    expect(k('dev_over')).toEqual(['list_deviation']);
    expect(k('cap_over')).toEqual(['listing_promo_over_cap']);
    expect(k('cam')).toEqual([]); // nhóm CAM / chưa map SKU: không xét giá (việc của A4)
    expect(k('all_four')).toEqual([
      'below_floor',
      'list_deviation',
      'listing_promo_over_cap',
      'negative_margin',
    ]);
    expect(objectType({ severity: 'S1', kind: 'below_floor' })).toBe('market_alert_s1');
    for (const [kind, ot] of Object.entries(G.object_type))
      expect(objectType({ kind, severity: SEVERITY[kind] as string })).toBe(ot);
  });

  it('giá đối thủ không bao giờ là input của luật (không có tham số)', () => {
    for (const fn of [checkListingPrices, checkPromos]) {
      const params = fn.toString().slice(0, fn.toString().indexOf(')'));
      expect(params).not.toMatch(/competitor|doi_thu/);
    }
  });

  it('payload qua guardrail, NHÁP "KHÔNG tự đổi giá", số đề xuất từ golden', () => {
    const c = G.listing.all_four;
    for (const it of c.items) {
      expect(check(it.payload).ok, it.payload).toBe(true);
      expect(it.payload).toContain('KHÔNG tự đổi giá');
      expect(it.object_id.startsWith('a5:')).toBe(true);
    }
    const p = Object.fromEntries(
      (c.out as Finding[])
        .filter((f) => f.severity !== 'INFO')
        .map((f) => [f.kind, payloadOf(f)[1]]),
    );
    expect(p.below_floor).toContain('đưa giá bán về ≥ giá sàn 150.000 đ');
    expect(p.list_deviation).toContain('đưa về giá niêm yết 200.000 đ');
  });

  it('trùng cảnh báo v3.3 → chỉ báo cáo, không đẩy; plan_of đếm mới/đã có/trùng', () => {
    const fs = structuredClone(G.dups.findings) as Finding[];
    for (const f of fs) delete f.dup_alert;
    markDups(fs, new Map([[['price_mismatch', 'shopee', '77', 'S'].join('\0'), 42]]));
    expect(fs).toEqual(G.dups.findings);
    const items = toItems(fs, CFG);
    expect(items).toEqual(G.dups.items);
    expect(
      planOf(items, fs, new Set([`${items[0]?.object_type}\0${items[0]?.object_id}`])),
    ).toEqual(G.dups.plan);
  });
});

describe('W53.5 kế hoạch KM (CSV nhập tay)', () => {
  it('mọi ca đọc file khớp Python (dòng/lỗi), không lộ giá trị ô', () => {
    const dir = tmp('kdp-plan-');
    for (const [name, c] of Object.entries(G.read_plan)) {
      const p = join(dir, `${name}.csv`);
      writeFileSync(p, b64(c.data));
      const [rows, errs] = readPlan(p, WATCH.promo_kinds, (c as Any).no_calendar ? null : CAL);
      expect(rows, name).toEqual(c.rows);
      expect(errs, name).toEqual(c.errs);
      for (const e of errs) expect(e).not.toMatch(/XQZ_BI_MAT|2026-13-01|12\.5/);
    }
    const mau = G.read_plan.mau.rows as PlanRow[];
    expect(mau.length).toBe(8);
    const tet = mau.filter((r) => r.event === 'tet_2027');
    expect(tet[0]?.event_date).toBe('2027-02-06');
    expect([tet[0]?.price, tet[0]?.pct]).toEqual([180000, null]);
  });

  it('trần số dòng áp trong lúc đọc', () => {
    const dir = tmp('kdp-max-');
    for (const c of [G.plan_max_rows, G.plan_max_rows_ok]) {
      const p = join(dir, 'big.csv');
      writeFileSync(p, b64(c.data));
      expect(readPlan(p, WATCH.promo_kinds, CAL, c.max)[1]).toEqual(c.errs);
    }
  });
});

describe('W53.5 luật KM (THUẦN) + C08 KM lỗ', () => {
  it('mọi ca khớp Python: phát hiện, mục sales, mục finance, payload', () => {
    for (const [name, c] of Object.entries(G.promo)) {
      const fs = checkPromos(
        c.rows as PlanRow[],
        gp(c.golden),
        rd(c.readiness),
        prom(c.promotable),
        c.cogs as CogsVersion[],
        net(c.net) as Record<string, Ratio>,
        c.watch as unknown as Watch,
        c.today,
      );
      expect(fs, name).toEqual(c.out);
      expect(toItems(fs, CFG), name).toEqual(c.items);
      expect(financeItems(fs), name).toEqual(c.finance);
      expect(fs.map(payloadOf), name).toEqual(c.payloads);
    }
  });

  it('MẪU 12/10: rượu/TPBVSK chưa XNQC → S1 market_alert_s1, payload qua guardrail, không chữ rượu', () => {
    const items = G.promo.mau_1012.items;
    const banned = items.filter((it) => /KM1111-[DE]/.test(it.object_id));
    expect(banned.length).toBe(2);
    expect(new Set(banned.map((it) => it.object_type))).toEqual(new Set(['market_alert_s1']));
    for (const it of items) {
      expect(check(it.payload).ok, it.payload).toBe(true);
      expect(it.payload).not.toMatch(/ruou|rượu/);
    }
    // C08: thiếu giá vốn = INFO "không tính được biên" → KHÔNG vào hàng sales, CHỈ mục finance.
    const fs = G.promo.mau_1012.out as Finding[];
    expect(fs.some((f) => f.kind === 'promo_margin_unknown')).toBe(true);
    expect(items.length).toBe(fs.filter((f) => f.severity !== 'INFO').length);
  });

  it('cửa sổ bao-gồm: ngày cuối = hôm nay vẫn cảnh báo; biên lookahead 45', () => {
    expect(new Set((G.promo.edge_today_end.out as Finding[]).map((f) => f.label))).toEqual(
      new Set(['đang chạy']),
    );
    expect(G.promo.edge_ended.out).toEqual([]);
    expect(new Set((G.promo.edge_45.out as Finding[]).map((f) => f.label))).toEqual(
      new Set(['dự kiến T-45']),
    );
    expect(G.promo.edge_46.out).toEqual([]);
  });

  it('C08 thiếu giá vốn = không tính được (không im lặng); có giá vốn → biên âm', () => {
    expect((G.promo.c08_unknown.out as Finding[]).map((f) => f.kind)).toEqual([
      'promo_margin_unknown',
    ]);
    expect((G.promo.c08_neg.out as Finding[]).map((f) => f.kind)).toEqual([
      'promo_negative_margin',
    ]);
    // tỷ lệ thực nhận dạng chuỗi (như test Python) chỉ cần CÓ khóa kênh
    const c = G.promo.c08_unknown;
    const fs = checkPromos(
      c.rows as PlanRow[],
      gp(c.golden),
      rd(c.readiness),
      prom(c.promotable),
      [],
      { shopee: '0.85' },
      c.watch as unknown as Watch,
      c.today,
    );
    expect(fs.map((f) => f.kind)).toEqual(['promo_margin_unknown']);
    expect(financeItems(fs)[0]?.object_id.startsWith('fin:a5:')).toBe(true);
  });

  it('merge_plan: trùng (program_id, kênh, SKU) giữ dòng CSV', () => {
    expect(mergePlan(G.merge.plan as PlanRow[], G.merge.internal as PlanRow[])).toEqual(
      G.merge.out,
    );
    expect(mergePlan(null, G.merge.internal as PlanRow[])).toEqual(G.merge.out_none);
  });
});

describe('báo cáo price-watch', () => {
  it('khớp Python (S1 trước S2, nhóm CAM không in SKU, đối thủ chỉ ở mục tham khảo)', () => {
    const res = G.report.res as unknown as Analysis;
    res.competitor = (G.report.res.competitor as unknown[]).map((r) => r as Competitor);
    for (const [name, c] of Object.entries(G.report.cases)) {
      const txt = renderReport(
        res,
        WATCH,
        '2026-10-12',
        c.plan as PlanRow[] | null,
        c.with_cal ? CAL : null,
        c.info,
      );
      expect(txt, name).toBe(c.text);
    }
    const a = G.report.cases.full.text;
    expect(a.indexOf('## S1')).toBeLessThan(a.indexOf('## S2'));
    expect(a.split('## Tham khảo đối thủ')[0]).not.toMatch(/77\.777|77777/);
    expect(
      renderReport(
        { listing: [], promo: [], channels: [], competitor: [] },
        { ...WATCH, confirmed_by: 'Lan', lookahead_days: 1 },
        '2026-12-31',
        [],
        CAL,
      ),
    ).toBe(G.report_empty);
    expect(seasonEvents(CAL, '2026-10-01', 45)).toEqual(G.season);
  });
});

describe('sales-06.1 giá đại lý (THUẦN)', () => {
  const DP = section('dealer_price');

  it('cấu hình dealer_price khớp Python', () => {
    expect(DP).toEqual(G.dealer_cfg);
  });

  it('đọc file: kiểm TOÀN file, lỗi nêu số dòng + tên cột, không lộ giá trị ô', () => {
    const dir = tmp('kdp-dl-');
    for (const [name, c] of Object.entries(G.dealer_file)) {
      const p = join(dir, `${name}.csv`);
      writeFileSync(p, b64(c.data));
      const [rows, errs, sha] = readDealerFile(
        p,
        DP.channels as string[],
        ((c as Any).max_rows as number) ?? (DP.max_rows as number),
        G.dealer_today,
      );
      expect(rows, name).toEqual(c.rows);
      expect(errs, name).toEqual(c.errs);
      expect(sha, name).toBe(c.sha);
      for (const e of errs) expect(e).not.toMatch(/0912345678|Sâm A|an@example/);
    }
  });

  it('url_ok: https, có host, không khoảng trắng/điều khiển, không SĐT/email, ≤ 500', () => {
    for (const [u, want] of G.url_ok) expect(urlOk(u as string), String(u)).toBe(want);
  });

  it('mục hàng duyệt: nhóm rượu ẩn mã, chỉ tên miền nguồn, không tên đại lý, qua guardrail', () => {
    for (const { f, item } of G.dealer_item) {
      const it = dealerItem(f as DealerFinding, CFG);
      expect(it).toEqual(item);
      expect(check(it.payload).ok).toBe(true);
    }
    expect(G.dealer_item[1]?.item.payload).toContain('nhóm hạn chế');
    expect(G.dealer_item[1]?.item.payload).not.toMatch(/ruou/);
  });

  it('--by phải là NGƯỜI (agent:/system: bị từ chối TRƯỚC mọi truy vấn)', async () => {
    const db = { query: () => Promise.reject(new Error('không được chạm DB')) } as never;
    for (const by of ['agent:x', 'SYSTEM:job', ' ', 'a'.repeat(101), 'a\nb']) {
      await expect(loadDealerObs(db, [], '0'.repeat(64), by)).rejects.toThrow(/NGƯỜI/);
    }
    await expect(loadDealerObs(db, [], '0'.repeat(64), 'Lan', 'x')).rejects.toThrow(/source/);
  });
});

describe('C09 giá combo (THUẦN)', () => {
  it('evaluate + payload khớp Python; thiếu giá đã duyệt / nhóm hạn chế không đề xuất', () => {
    for (const [name, c] of Object.entries(G.combo)) {
      const r = evaluate(
        c.items as [string, number][],
        gp(c.golden),
        prom(c.promotable),
        c.cogs as CogsVersion[],
        net(c.net),
        c.cfg,
        'shopee',
        G.combo_today,
      );
      expect(r, name).toEqual(c.out);
      if (c.payload !== null && r.status === 'de_xuat') {
        const text = comboPayload('CB1', 'Hộp quà, Tết 2027', 'shopee', r, c.cfg);
        expect(text, name).toBe(c.payload);
        expect(check(text).ok, name).toBe(true);
      }
    }
    const full = G.combo.full.out as Any & { options: Any[] };
    expect(
      comboPayload('CB-2', 'Hộp', 'shopee', full as never, {
        status: '',
        chot_boi: 'GĐ Marketing',
      }),
    ).toBe(G.combo_payload_chot);
    expect(G.combo.chua_duyet.out.status).toBe('thieu_du_lieu');
    expect(G.combo.han_che.out.status).toBe('nhom_han_che');
  });

  it('load_cfg: ship hợp lệ; rỗng/sai kiểu/thiếu khóa/hỏng → lỗi', () => {
    for (const [name, c] of Object.entries(G.combo_cfg)) {
      let p = dataPath('combo_price.json');
      if (name !== 'ship') {
        p = join(tmp('kdp-cb-'), 'combo_price.json');
        if (!c.missing) writeFileSync(p, c.text as string, 'utf8');
      }
      let got: unknown = null;
      let err: string | null = null;
      try {
        got = loadCfg(p);
      } catch (e) {
        err = (e as Error).message;
      }
      expect(got, name).toEqual(c.out);
      expect(err, name).toBe(c.err);
    }
  });
});

// ---------------------------------------------------------------- CLI (không DB)

function cli(extra: Partial<CmdDeps> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const calls = { connect: 0, service: 0, job: 0 };
  const d: CmdDeps = {
    log: (s) => out.push(s),
    err: (s) => errs.push(s),
    connect: async () => {
      calls.connect++;
      return null;
    },
    openService: async () => {
      calls.service++;
      throw new Error('không được mở DB');
    },
    jobRun: (async (_n: string, body: (r: { ok: boolean; detail: null }) => Promise<number>) => {
      calls.job++;
      return body({ ok: true, detail: null });
    }) as never,
    wire: null,
    ...extra,
  };
  return { d, out, errs, calls };
}

describe('CLI tham số / cấu hình hỏng → thoát TRƯỚC connect', () => {
  it.each([
    [{}],
    [{ run: true, report: true }],
    [{ dryRun: true }],
    [{ report: true, dryRun: true }],
    [{ run: true, asOf: '2026-10-12' }],
    [{ report: true, asOf: '12/10/2026' }],
    [{ report: true, asOf: '2026-02-30' }],
    [{ dealerWatch: true, asOf: '2026-10-01' }],
    [{ dealerWatch: true, plan: 'x.csv' }],
    [{ dealerWatch: true, run: true }],
  ])('kd-price %j → exit 2', async (o) => {
    const c = cli();
    expect(await kdPriceMain(o, c.d)).toBe(2);
    expect(c.calls).toEqual({ connect: 0, service: 0, job: 0 });
  });

  it('price_watch.json hỏng → exit 1, không connect', async () => {
    const dir = tmp('kdp-cw-');
    writeFileSync(join(dir, 'w.json'), '{}');
    const c = cli({ paths: { watch: join(dir, 'w.json') } });
    expect(await kdPriceMain({ run: true, dryRun: true }, c.d)).toBe(1);
    expect(c.calls.connect).toBe(0);
    expect(c.errs.at(-1)).toBe('[error] 1 lỗi — không connect, không ghi gì.');
  });

  it('CSV kế hoạch hỏng → exit 1, không connect, không in giá trị ô', async () => {
    const dir = tmp('kdp-cp-');
    for (const [name, c] of Object.entries(G.read_plan)) {
      if (!c.errs.length || (c as Any).no_calendar) continue;
      const p = join(dir, `${name}.csv`);
      writeFileSync(p, b64(c.data));
      const k = cli();
      expect(await kdPriceMain({ report: true, plan: p, asOf: '2026-10-12' }, k.d), name).toBe(1);
      expect(k.calls.connect, name).toBe(0);
      const all = [...k.out, ...k.errs].join('\n');
      for (const s of ['XQZ_BI_MAT', '2026-13-01', '12.5']) expect(all, name).not.toContain(s);
      expect(k.errs.join('\n'), name).toContain('không connect');
    }
  });

  it('sales_watch.json hỏng → --dealer-watch --dry-run exit 1 trước connect', async () => {
    const dir = tmp('kdp-sw-');
    writeFileSync(join(dir, 'sw.json'), '{broken');
    const c = cli({ paths: { salesWatch: join(dir, 'sw.json') } });
    expect(await kdPriceMain({ dealerWatch: true, dryRun: true }, c.d)).toBe(1);
    expect(c.calls.service).toBe(0);
    expect(c.errs[0]).toMatch(/^\[error\] cấu hình lỗi: .* — không connect$/);
  });

  it('DB down → exit 2 (kd-price --run --dry-run, combo-price)', async () => {
    const c = cli();
    expect(await kdPriceMain({ run: true, dryRun: true }, c.d)).toBe(2);
    expect(c.calls.connect).toBe(1);
    expect(c.calls.job).toBe(0); // dry-run không ghi job_runs
    const k = cli();
    expect(await comboPriceMain({ dryRun: true }, k.d)).toBe(2);
    expect(k.errs).toEqual(['[error] không kết nối được Postgres']);
  });

  it('combo-price: --as-of sai → 2; cấu hình hỏng → 1 trước connect', async () => {
    const c = cli();
    expect(await comboPriceMain({ asOf: '2026-02-30' }, c.d)).toBe(2);
    const dir = tmp('kdp-cc-');
    writeFileSync(join(dir, 'combo_price.json'), '{"muc_giam_pct": []}');
    const k = cli({ paths: { combo: join(dir, 'combo_price.json') } });
    expect(await comboPriceMain({}, k.d)).toBe(1);
    expect(k.calls.connect).toBe(0);
  });

  it('dealer-price: thiếu --file/--by hoặc --by trắng → 2; file lỗi → 1 trước connect', async () => {
    for (const o of [{ file: 'x.csv' }, { by: 'Lan' }, { file: 'x.csv', by: '  ' }]) {
      const c = cli();
      expect(await dealerPriceMain(o, c.d), JSON.stringify(o)).toBe(2);
      expect(c.calls.service).toBe(0);
    }
    const dir = tmp('kdp-cd-');
    const p = join(dir, 'b.csv');
    writeFileSync(p, b64(G.dealer_file.sdt.data));
    const c = cli();
    expect(await dealerPriceMain({ file: p, by: 'Lan' }, c.d)).toBe(1);
    expect(c.calls.service).toBe(0);
    expect(c.errs.join('\n')).not.toContain('0912345678');
    expect(c.errs.at(-1)).toBe('[error] 1 lỗi — không connect, không nạp dòng nào.');
  });
});
