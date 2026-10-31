import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { addDays, vnDate, vnMidnight, weekday } from '@samsam/core/ops/period';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { featureFor } from '@samsam/core/rollout/rollout';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGolden, tetDate } from '../sales_director/kd-forecast.deps.js';
import M from './__fixtures__/mkt-calendar.golden.json' with { type: 'json' };
import { DAILY_KEY_LEN, DEFAULT_BY, dailyKey } from './content.js';
import * as mc from './mkt-calendar.js';

// Dịch tests/test_mkt_calendar.py + phần thuần "3 bài/ngày" của tests/test_v13_c06_daily_ar.py.
// Hàm thuần — không DB, không LLM, không đọc đồng hồ (CLI nhận `now` giả). Golden = chạy hàm Python
// thật (scratchpad gen.py) trên lịch/golden thật của repo.

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON thử nghiệm
type Any = Record<string, any>;
const LEAD: mc.Lead = {
  publish_hour: 9,
  approve_buffer_hours: 24,
  draft_review_hours: 48,
  work_start_hour: 8,
  work_end_hour: 17,
};
const NONE = new Set<string>();
const REQUIRED_EVENTS = ['20.10', '11.11', '20.11', '12.12', '24.12', '01.01', 'tet_2027'];
const real = (): Any => JSON.parse(readFileSync(mc.CALENDAR_FILE, 'utf8'));
const golden = (): Any => {
  const [doc, err] = readGolden();
  expect(err).toBeNull();
  return doc as Any;
};
const plan = (weeks = 26, start = '2026-10-12', cal?: mc.Calendar, g?: unknown) =>
  mc.build(cal ?? mc.loadCalendar(), g ?? golden(), start, weeks, 48);
const vn = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 7, mi));
const iso = (d: Date) => mc.vnIso(d);
const todMin = (d: Date) => (d.getTime() - vnMidnight(vnDate(d)).getTime()) / 60_000;
const TMP = mkdtempSync(join(tmpdir(), 'mktcal-'));
let nTmp = 0;
const tmpFile = (data: string | Buffer | null) => {
  const dir = join(TMP, `c${++nTmp}`); // thư mục riêng mỗi ca, tên file luôn cal.json
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'cal.json');
  if (data !== null) writeFileSync(p, data);
  return p;
};
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- W60.1 loader

describe('loader', () => {
  it('lịch thật: GIẢ ĐỊNH, đủ sự kiện, mùa thu hoạch GIẢ ĐỊNH, Tết theo lunar_new_year', () => {
    const cal = mc.loadCalendar() as Any;
    expect(cal.status).toContain('GIẢ ĐỊNH');
    const ids = new Set(cal.events.map((e: Any) => e.id));
    for (const e of REQUIRED_EVENTS) expect(ids.has(e)).toBe(true);
    const harvest = cal.events.filter((e: Any) => e.kind === 'harvest');
    expect(harvest.length).toBeGreaterThan(0);
    for (const h of harvest) expect(h.status).toContain('GIẢ ĐỊNH');
    const remind = new Set(cal.events.filter((e: Any) => e.remind).map((e: Any) => e.id));
    for (const e of ['11.11', '12.12', 'tet_2027']) expect(remind.has(e)).toBe(true);
    for (const ev of ['11.11', '12.12', 'tet_2027']) {
      expect(cal.campaigns.some((c: Any) => c.event === ev)).toBe(true);
    }
    const hIds = new Set(harvest.map((h: Any) => h.id));
    expect(
      cal.campaigns.some(
        (c: Any) =>
          hIds.has(c.event) && JSON.stringify(c.formats) === '["post"]' && c.skus.length === 0,
      ),
    ).toBe(true);
    const tet = cal.events.find((e: Any) => e.id === 'tet_2027');
    expect(tet.lunar_new_year).toBe(2027);
    expect('date' in tet).toBe(false);
    expect(cal.daily_posts.per_day).toBe(3); // số HĐ PL01
  });

  it('Tết lấy từ scenario.tet_date; năm lạ/bool → CalendarError; offset_days', () => {
    const tet = real().events.find((e: Any) => e.id === 'tet_2027');
    expect(mc.eventDate(tet)).toBe(tetDate(2027));
    expect(() => mc.eventDate({ id: 'tet_2031', kind: 'tet', lunar_new_year: 2031 })).toThrow(
      mc.CalendarError,
    );
    expect(() => mc.eventDate({ id: 'x', lunar_new_year: true })).toThrow(mc.CalendarError);
    expect(mc.eventDate({ id: 'x', date: '2026-11-11', offset_days: -2 })).toBe('2026-11-09');
  });

  it('không có hằng ngày Tết thứ hai trong mã TS; Tết qua tetDate', () => {
    const src = readFileSync(new URL('./mkt-calendar.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/2027-0?2-0?6|2027, *2, *6|"02-06"/);
    expect(src).toContain('tetDate(');
  });

  const ev = (c: Any, id: string) => c.events.find((e: Any) => e.id === id);
  const BROKEN: Record<string, (c: Any) => void> = {
    dup_event: (c) => c.events.push({ ...c.events[0] }),
    dup_campaign: (c) => c.campaigns.push({ ...c.campaigns[0] }),
    unknown_event: (c) => Object.assign(c.campaigns[0], { event: 'khong-co' }),
    unknown_channel: (c) => Object.assign(c.campaigns[0], { channels: ['shopee', 'lazada'] }),
    unknown_format: (c) => Object.assign(c.campaigns[0], { formats: ['post', 'banner'] }),
    positive_offset: (c) => Object.assign(c.campaigns[0], { publish_offset_days: 1 }),
    offset_too_far: (c) => Object.assign(c.campaigns[0], { publish_offset_days: -61 }),
    true_as_number: (c) => Object.assign(c.lead, { publish_hour: true }),
    nan: (c) => Object.assign(c.lead, { approve_buffer_hours: '__NAN__' }),
    negative: (c) => Object.assign(c.lead, { draft_review_hours: -1 }),
    hour_24: (c) => Object.assign(c.lead, { publish_hour: 24 }),
    work_hours_inverted: (c) => Object.assign(c.lead, { work_start_hour: 17, work_end_hour: 8 }),
    harvest_no_status: (c) => delete ev(c, 'harvest_2026').status,
    harvest_status_not_assumed: (c) => Object.assign(ev(c, 'harvest_2026'), { status: 'đã thu' }),
    date_and_lunar: (c) => Object.assign(ev(c, '11.11'), { lunar_new_year: 2027 }),
    neither_date: (c) => delete ev(c, '11.11').date,
    date_format: (c) => Object.assign(ev(c, '11.11'), { date: '2026/11/11' }),
    date_invalid: (c) => Object.assign(ev(c, '11.11'), { date: '2026-02-30' }),
    date_far: (c) => Object.assign(ev(c, '11.11'), { date: '9999-12-31' }),
    lunar_unknown: (c) => Object.assign(ev(c, 'tet_2027'), { lunar_new_year: 2031 }),
    bad_kind: (c) => Object.assign(ev(c, '11.11'), { kind: 'party' }),
    remind_not_bool: (c) => Object.assign(ev(c, '11.11'), { remind: 1 }),
    reminder_zero: (c) => Object.assign(c, { reminder_days: [14, 0] }),
    skus_bad: (c) => Object.assign(c.campaigns[0], { skus: 'all' }),
    no_pillar: (c) => Object.assign(c.campaigns[0], { pillar: ' ' }),
    nwd_bad: (c) => Object.assign(c, { non_working_days: ['01/01/2027'] }),
    cap_negative: (c) => Object.assign(c.review_caps, { gd_marketing_daily: -1 }),
    no_status: (c) => delete c.status,
    events_empty: (c) => Object.assign(c, { events: [] }),
    campaigns_empty: (c) => Object.assign(c, { campaigns: [] }),
    bad_id: (c) => Object.assign(c.campaigns[0], { id: 'C 1|x' }),
  };
  // Khác Python có chủ đích: JSON có NaN (Python json nhận) và JSON hỏng → "JSON hỏng: JSONDecodeError"
  // (JS không nhận NaN, không cho câu dòng/cột của Python) — vẫn CalendarError.
  const TS_STRICTER = new Set(['nan', 'file3']);

  it('mọi biến thể lịch sai luật → CalendarError đúng thông điệp Python', () => {
    const want = new Map(M.broken.map((b: Any) => [b.name, b.error]));
    expect(Object.keys(BROKEN).sort()).toEqual(
      M.broken.filter((b: Any) => !b.name.startsWith('file')).map((b: Any) => b.name),
    );
    for (const [name, mut] of Object.entries(BROKEN)) {
      const c = real();
      mut(c);
      const text = JSON.stringify(c).replace('"__NAN__"', 'NaN');
      let got: string | null = null;
      try {
        mc.loadCalendar(tmpFile(text));
      } catch (e) {
        expect(e).toBeInstanceOf(mc.CalendarError);
        got = (e as Error).message;
      }
      expect(got, name).not.toBeNull();
      if (TS_STRICTER.has(name)) expect(got).toBe('cal.json JSON hỏng: JSONDecodeError');
      else expect(got, name).toBe(want.get(name));
    }
  });

  it('file thiếu/rỗng/khoảng trắng/hỏng/{}/chỉ _doc/[]/không UTF-8/BOM → CalendarError', () => {
    for (const b of M.broken.filter((x: Any) => x.name.startsWith('file')) as Any[]) {
      const p = tmpFile(b.bytes_hex === null ? null : Buffer.from(b.bytes_hex, 'hex'));
      let got: string | null = null;
      try {
        mc.loadCalendar(p);
      } catch (e) {
        expect(e).toBeInstanceOf(mc.CalendarError);
        got = (e as Error).message;
      }
      if (TS_STRICTER.has(b.name)) expect(got).toBe('cal.json JSON hỏng: JSONDecodeError');
      else expect(got, b.name).toBe(b.error);
    }
  });

  it('daily_posts sai luật → CalendarError (fail-closed), thiếu daily_posts vẫn validate', () => {
    for (const b of M.bad_daily as Any[]) {
      const c = real();
      c.daily_posts = b.daily_posts;
      expect(() => mc.validate(c)).toThrow(b.error);
    }
    const c = real();
    delete c.daily_posts;
    mc.validate(c); // lịch khác vẫn chạy được
  });
});

// ---------------------------------------------------------------- W60.2 engine

describe('engine', () => {
  it('milestones khớp Python (11.11 CN→T6, 12.12 giữ T7, giờ sớm, nghỉ lễ, SLA biên)', () => {
    for (const c of M.milestones as Any[]) {
      const m = mc.milestones(c.day, c.lead, c.sla, new Set(c.nw));
      expect(mc.toJson(m)).toEqual(c.out);
    }
    const m = mc.milestones('2026-11-11', LEAD, 48, NONE);
    expect(m.draft).toEqual(vn(2026, 11, 6, 17)); // CN 08/11 → T6
    expect(() => mc.milestones('2026-11-11', LEAD, 0, NONE)).toThrow(mc.CalendarError);
    expect(() => mc.milestones('2026-11-11', LEAD, true, NONE)).toThrow(mc.CalendarError);
  });

  it('toWorkday: đầu vào múi giờ bất kỳ xét theo giờ VN, lễ, quá giờ, micro giây', () => {
    for (const c of M.to_workday as Any[]) {
      expect(iso(mc.toWorkday(new Date(c.in), LEAD, new Set(c.nw)))).toBe(c.out);
    }
  });

  it('toWorkday chỉ LÙI, luôn rơi vào giờ làm việc ngày làm việc', () => {
    const t = vn(2026, 12, 28).getTime();
    const nw = new Set(['2027-01-01']);
    for (let h = 0; h < 240; h++) {
      const x = new Date(t + h * 3_600_000 + 17 * 60_000);
      const y = mc.toWorkday(x, LEAD, nw);
      expect(y.getTime()).toBeLessThanOrEqual(x.getTime());
      expect(weekday(vnDate(y))).toBeLessThan(5);
      expect(nw.has(vnDate(y))).toBe(false);
      expect(todMin(y)).toBeGreaterThanOrEqual(8 * 60);
      expect(todMin(y)).toBeLessThanOrEqual(17 * 60);
    }
  });

  it('build() khớp Python từng kỳ (ô, SKU bị chặn, ô bỏ, nhắc, ngày nghỉ)', () => {
    const [cal, g, sla] = mc.loadInputs();
    expect(sla).toBe(M.sla);
    for (const [k, want] of Object.entries(M.plans)) {
      const [start, weeks] = k.split('/');
      expect(mc.toJson(mc.build(cal, g, start as string, Number(weeks), sla)), k).toEqual(want);
    }
  });

  it('tính chất trên lịch thật: brief ≤ nháp ≤ duyệt ≤ đăng, mốc trong giờ làm, Tết là ngày nghỉ', () => {
    const p = plan();
    const nw = new Set(p.non_working_days);
    expect(nw.has(tetDate(2027))).toBe(true); // off_days Tết
    expect(p.campaigns.length).toBeGreaterThan(0);
    for (const c of p.campaigns) {
      const m = c.milestones;
      expect(m.brief <= m.draft && m.draft <= m.approve && m.approve <= m.publish).toBe(true);
      for (const k of mc.MILESTONES) expect(iso(m[k]).endsWith('+07:00')).toBe(true);
      for (const k of ['brief', 'draft', 'approve'] as const) {
        expect(weekday(vnDate(m[k])), `${c.id} ${k}`).toBeLessThan(5);
        expect(nw.has(vnDate(m[k]))).toBe(false);
        expect(todMin(m[k])).toBeGreaterThanOrEqual(8 * 60);
        expect(todMin(m[k])).toBeLessThanOrEqual(17 * 60);
      }
    }
  });

  it('rượu KHÔNG BAO GIỜ vào ô nào, kể cả golden ghi allowed_channels shopee', () => {
    const p = plan();
    for (const c of p.campaigns) {
      for (const x of c.cells) expect(x.skus.some((k) => k.startsWith('ruou-sam-'))).toBe(false);
    }
    const listed = p.campaigns.find((c) => c.id === 'c-tet-2027-qua-bieu') as mc.PlanCampaign;
    const bl = listed.blocked.filter((b) => b.sku_key === 'ruou-sam-binh-su-do-500ml');
    expect(bl.length).toBeGreaterThan(0);
    for (const b of bl) expect(b.reason).toBe(mc.REASON_ALCOHOL);
    const auto = p.campaigns.find((c) => c.id === 'c-1111-2026') as mc.PlanCampaign;
    expect(
      new Set(auto.blocked.filter((b) => b.reason === mc.REASON_ALCOHOL).map((b) => b.sku_key)),
    ).toEqual(new Set(['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml']));
    const g = Object.fromEntries((golden().skus as Any[]).map((s) => [s.sku_key, s]));
    expect(g['ruou-sam-binh-su-do-500ml'].allowed_channels).toContain('shopee');
  });

  const fixtureCal = (channels: string[], formats: string[], skus: unknown = 'auto') => {
    const cal = real();
    cal.campaigns = [
      {
        id: 'c-fx',
        event: '11.11',
        publish_offset_days: 0,
        channels,
        formats,
        skus,
        pillar: 'fixture',
      },
    ];
    return mc.validate(cal);
  };

  it('readiness theo định dạng + ô bỏ/câu chuyện thương hiệu khớp Python', () => {
    for (const f of M.fixture_campaigns as Any[]) {
      const g = golden();
      if (f.approved_saphraton) {
        ((g.skus as Any[]).find((s) => s.sku_key === 'saphraton-20v') as Any).xnqc_status =
          'approved';
      }
      const p = mc.build(fixtureCal(f.channels, f.formats, f.skus), g, '2026-10-12', 26, 48);
      expect(mc.toJson(p)).toEqual(f.out);
    }
    const g = golden();
    ((g.skus as Any[]).find((s) => s.sku_key === 'saphraton-20v') as Any).xnqc_status = 'approved';
    const c = plan(
      26,
      '2026-10-12',
      fixtureCal(['shopee'], ['listing', 'ads', 'koc', 'livestream']),
      g,
    ).campaigns[0] as mc.PlanCampaign;
    const cells = new Map(c.cells.map((x) => [`${x.channel}/${x.format}`, x]));
    expect(cells.get('shopee/ads')?.skus).toContain('saphraton-20v');
    expect(cells.get('shopee/listing')?.skus).toContain('savigout-30v');
    for (const fmt of ['ads', 'koc', 'livestream']) {
      expect(cells.get(`shopee/${fmt}`)?.skus ?? []).not.toContain('savigout-30v');
      expect(
        c.blocked.some(
          (b) => b.sku_key === 'savigout-30v' && b.format === fmt && b.readiness === 'MO_TA',
        ),
      ).toBe(true);
    }
    for (const x of c.cells) expect(x.skus).not.toContain('saphraton-40v');
    const c2 = plan(
      26,
      '2026-10-12',
      fixtureCal(['shopee'], ['listing'], ['ruou-sam-chai-thuy-tinh-500ml', 'savigout-30v']),
      g,
    ).campaigns[0] as mc.PlanCampaign;
    expect(c2.cells[0]?.skus).toEqual(['savigout-30v']);
    expect(c2.blocked[0]?.reason).toBe(mc.REASON_ALCOHOL);
    const c3 = plan(
      26,
      '2026-10-12',
      fixtureCal(['tiktok'], ['listing', 'ads', 'post', 'livestream']),
    ).campaigns[0] as mc.PlanCampaign;
    expect(new Set(c3.cells.map((x) => x.format))).toEqual(new Set(['post', 'livestream']));
    for (const x of c3.cells) expect([x.note, x.skus.length]).toEqual([mc.BRAND_NOTE, 0]);
    expect(new Set(c3.dropped.map((x) => x.format))).toEqual(new Set(['listing', 'ads']));
    expect(() =>
      plan(26, '2026-10-12', fixtureCal(['shopee'], ['post'], ['khong-co-sku'])),
    ).toThrow(M.err_build_unknown_sku);
  });

  it('weeks ngoài 1..26 / bool, golden rỗng → CalendarError', () => {
    const cal = mc.loadCalendar();
    for (const [w, msg] of M.err_weeks as [unknown, string][]) {
      expect(() => mc.build(cal, golden(), '2026-10-12', w, 48)).toThrow(msg);
    }
    expect(() => mc.build(cal, { skus: [] }, '2026-10-12', 4, 48)).toThrow(M.err_no_golden);
  });

  it('nhắc 14/7/3 ngày trước sự kiện có remind', () => {
    const rem: Record<string, Record<number, string>> = {};
    for (const r of plan().reminders) rem[r.event] = { ...rem[r.event], [r.days_before]: r.day };
    for (const e of ['11.11', '12.12', 'tet_2027']) {
      expect(Object.keys(rem[e] ?? {}).sort()).toEqual(['14', '3', '7']);
    }
    expect(rem.tet_2027).toEqual({ 14: '2027-01-23', 7: '2027-01-30', 3: '2027-02-03' });
    expect(rem['11.11']?.[14]).toBe('2026-10-28');
    expect(rem['20.10']).toBeUndefined();
  });

  it('cửa sổ: ngày đăng ≥ start VÀ brief < end', () => {
    expect(plan(1, '2026-11-09').campaigns.map((c) => c.id)).toEqual([
      'c-1111-2026',
      'c-2011-2026',
    ]);
    expect(plan(1, '2026-11-12').campaigns.map((c) => c.id)).toEqual([
      'c-2011-2026',
      'c-harvest-2026',
    ]);
  });

  it('engine không import DB/LLM/mạng', () => {
    const src = readFileSync(new URL('./mkt-calendar.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '(pg|@samsam\/core\/db|@samsam\/core\/ai\/[^']*|node:http[s]?)'/);
  });
});

// ---------------------------------------------------------------- v13.6 3 bài/ngày (thuần)

describe('dailyCandidates', () => {
  const HONEY = 'mat-ong-sam-300ml';
  const goldenReady = (ready: boolean) => {
    const g = golden();
    if (ready) {
      const s = (g.skus as Any[]).find((x) => x.sku_key === HONEY) as Any;
      s.self_declaration_ok = true;
      s.allowed_channels = ['shopee', 'facebook', 'zalo'];
    }
    return g;
  };

  it('khớp Python mọi ngày (mốc nháp chiến dịch trước, trụ thường ngày xoay vòng)', () => {
    const [cal, , sla] = mc.loadInputs();
    for (const c of M.daily_candidates as Any[]) {
      expect(mc.toJson(mc.dailyCandidates(cal, goldenReady(c.ready), c.day, sla)), c.day).toEqual(
        c.out,
      );
    }
  });

  it('ô chiến dịch đúng ngày mốc NHÁP đứng trước; ngày khác chỉ trụ thường ngày', () => {
    const [cal, , sla] = mc.loadInputs();
    const dc = mc.dailyCandidates(cal, goldenReady(false), '2026-10-14', sla);
    const camp = dc.candidates.filter((c) => c.kind === 'campaign');
    expect(camp.map((c) => [c.ref, c.channel])).toEqual([
      ['c-2010-2026', 'facebook'],
      ['c-2010-2026', 'zalo'],
    ]);
    expect(dc.candidates.slice(0, 2)).toEqual(camp);
    for (const c of camp) expect(c.publish_day).toBe('2026-10-17');
    const dc2 = mc.dailyCandidates(cal, goldenReady(false), '2026-10-15', sla);
    for (const c of dc2.candidates) expect(c.kind).toBe('evergreen');
  });

  it('trụ gắn SKU không có SKU hợp lệ → lý do từ chối, KHÔNG lấy SKU khác cho đủ số', () => {
    const [cal, , sla] = mc.loadInputs();
    const ev = mc
      .dailyCandidates(cal, goldenReady(false), '2026-10-15', sla)
      .candidates.filter((c) => c.kind === 'evergreen');
    expect(new Set(ev.map((c) => c.ref))).toEqual(
      new Set(['thuong-hieu', 'san-pham', 'vung-trong', 'qua-tang']),
    );
    for (const c of ev) {
      expect(c.sku).toBeNull();
      if (c.ref === 'san-pham' || c.ref === 'qua-tang') expect(c.reason).toContain('thiếu SKU');
      else expect(c.reason).toBeNull();
    }
  });

  it('không bao giờ rượu; xoay vòng tất định theo ngày', () => {
    const [cal, , sla] = mc.loadInputs();
    const g = goldenReady(true);
    for (let k = 0; k < 10; k++) {
      for (const c of mc.dailyCandidates(cal, g, addDays('2026-10-15', k), sla).candidates) {
        expect(c.sku === null || !c.sku.startsWith('ruou')).toBe(true);
      }
    }
    const a = mc.dailyCandidates(cal, g, '2026-10-15', sla);
    expect(a).toEqual(mc.dailyCandidates(cal, g, '2026-10-15', sla));
    const b = mc.dailyCandidates(cal, g, '2026-10-16', sla);
    expect(a.candidates.map((c) => c.ref)).not.toEqual(b.candidates.map((c) => c.ref));
    expect(a.candidates.some((c) => c.sku === HONEY)).toBe(true);
  });

  it('thiếu daily_posts / SKU lạ trong trụ → CalendarError (không im lặng)', () => {
    const [cal, g, sla] = mc.loadInputs();
    const c1 = structuredClone(cal) as Any;
    delete c1.daily_posts;
    expect(() => mc.dailyCandidates(c1 as mc.Calendar, g, '2026-10-15', sla)).toThrow(
      M.err_no_daily,
    );
    const c2 = structuredClone(cal) as Any;
    c2.daily_posts.evergreen[0].skus = ['khong-co'];
    expect(() => mc.dailyCandidates(c2 as mc.Calendar, g, '2026-10-15', sla)).toThrow(
      M.err_unknown_sku,
    );
  });

  it('khóa slot cố định 21 ký tự; tính năng marketing-01.1', () => {
    expect(dailyKey('2026-10-15', 1)).toBe('[daily 2026-10-15 #1]');
    expect(dailyKey('2026-10-15', 9).length).toBe(DAILY_KEY_LEN);
    expect(() => dailyKey('2026-10-15', 10)).toThrow(RangeError);
    expect(
      featureFor({ table: 'content_drafts', created_by: DEFAULT_BY, content_type: 'post' }),
    ).toBe('marketing-01.1');
  });
});

// ---------------------------------------------------------------- W60.3 xuất

function parseIcs(text: string): Any[] {
  expect(text.endsWith('\r\n')).toBe(true);
  const raw = text.split('\r\n').slice(0, -1);
  for (const line of raw) {
    expect(line.includes('\n') || line.includes('\r')).toBe(false);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  }
  const lines: string[] = [];
  for (const line of raw) {
    if (line.startsWith(' ')) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  expect(lines[0]).toBe('BEGIN:VCALENDAR');
  expect(lines.at(-1)).toBe('END:VCALENDAR');
  const events: Any[] = [];
  let cur: Any | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      events.push(cur as Any);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      cur[line.slice(0, i).split(';')[0] as string] = line.slice(i + 1);
    }
  }
  return events;
}
const icsUnescape = (v: string) =>
  v.replace(/\\([\\;,nN])/g, (_, c) => ('nN'.includes(c) ? '\n' : c));
const NOW = new Date('2026-10-12T08:00:00+07:00');

describe('xuất markdown / .ics / CLI', () => {
  beforeAll(() => installFakeDeps());
  afterAll(() => resetOpsDeps());

  const run = async (o: mc.CalendarOpts, d: mc.CalendarDeps = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const rc = await mc.mktCalendarMain(o, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      now: () => NOW,
      ...d,
    });
    return { rc, out: out.length ? `${out.join('\n')}\n` : '', err };
  };
  const optsOf = (argv: string[]): mc.CalendarOpts => {
    const o: Any = {};
    for (let i = 0; i < argv.length; i++) {
      const k = (argv[i] as string).slice(2);
      if (k === 'json') o.json = true;
      else o[k] = argv[++i];
    }
    return o;
  };

  it('CLI markdown tuần/tháng + --json khớp Python từng byte; tham số sai → exit 2', async () => {
    for (const c of M.cli as Any[]) {
      const r = await run(optsOf(c.argv));
      expect(r.rc, c.argv.join(' ')).toBe(c.rc);
      if (c.rc === 0) expect(r.out).toBe(c.out);
      else expect(r.err.at(-1)).toBe((c.err as string).trimEnd().split('\n').at(-1));
    }
    const w = (await run({ start: '2026-10-12', weeks: '4' })).out;
    expect(w.split('\n')[0]).toContain('GIẢ ĐỊNH');
    expect(w.split('\n')[0]).toContain('ĐỀ XUẤT');
    const wk = w.split('## Tuần 2026-11-09')[1]?.split('\n## ')[0] ?? '';
    expect(wk).toContain('c-1111-2026');
    expect(wk).toContain('| shopee | listing |');
    expect(w).toContain('## SKU bị chặn kênh');
  });

  it('markdown kỳ không có gì', async () => {
    const p = plan(1, '2027-06-07');
    expect(mc.renderMarkdown(p, 'week')).toBe(M.md_empty);
    expect(() => mc.renderMarkdown(p, 'year')).toThrow(RangeError);
  });

  it('.ics hợp lệ, ổn định (cùng UID chạy lại), khớp Python từng byte', () => {
    const p = plan(18);
    const text = mc.renderIcs(p, NOW);
    expect(text).toBe(M.ics_18);
    const evs = parseIcs(text);
    expect(evs.length).toBe(4 * p.campaigns.length + p.reminders.length);
    for (const e of evs) {
      for (const k of ['UID', 'DTSTAMP', 'DTSTART', 'SUMMARY']) expect(k in e).toBe(true);
      expect(e.DTSTAMP).toBe('20261012T010000Z');
    }
    const uids = evs.map((e) => e.UID);
    expect(new Set(uids).size).toBe(uids.length);
    expect(evs.find((e) => e.UID === 'c-1111-2026-publish@samsam')?.DTSTART).toBe(
      '20261111T020000Z',
    );
    expect(mc.renderIcs(plan(18), NOW)).toBe(text);
  });

  it('.ics escape + gập dòng UTF-8 round-trip', () => {
    const p = plan(6);
    const c = p.campaigns[0] as mc.PlanCampaign;
    expect(c.id).toBe(M.ics_escape_campaign);
    c.event = 'sale, mùa; 1\\2\nx';
    c.pillar = 'Quà tặng sâm Ngọc Linh '.repeat(8);
    const text = mc.renderIcs(p, NOW);
    expect(text).toBe(M.ics_escape);
    const brief = parseIcs(text).find((e) => e.UID === `${c.id}-brief@samsam`) as Any;
    expect(icsUnescape(brief.SUMMARY)).toBe(`[MKT] brief: ${c.id} (sale, mùa; 1\\2\nx)`);
    expect(icsUnescape(brief.DESCRIPTION).startsWith(`${c.pillar}; `)).toBe(true);
    expect(brief.SUMMARY).toContain('(sale\\, mùa\\; 1\\\\2\\nx)');
    for (const k of ['SUMMARY', 'DESCRIPTION']) {
      expect(brief[k].replace(/\\[\\;,nN]/g, '')).not.toMatch(/[\\;,]/);
    }
  });

  it('--ics ghi file (đường chỉ định + mặc định data/reports qua writeReport)', async () => {
    const p = join(TMP, 'out', 'lich.ics');
    const r = await run({ start: '2026-10-12', weeks: '18', ics: p });
    expect(r.rc).toBe(0);
    const data = readFileSync(p);
    expect(data.subarray(0, 17).toString()).toBe('BEGIN:VCALENDAR\r\n');
    expect(parseIcs(data.toString('utf8')).length).toBeGreaterThan(0);
    expect(r.err.at(-1)).toBe(`[ok] .ics: ${p}`);
    const dir = join(TMP, 'reports');
    const r2 = await run({ start: '2026-10-12', ics: true }, { reportsDir: dir });
    expect(r2.err.at(-1)).toBe(`[ok] .ics: ${join(dir, 'mkt-calendar-2026-10-12.ics')}`);
  });

  it('lịch hỏng → exit 1, [err], không traceback; --start mặc định = thứ Hai tuần này', async () => {
    const r = await run({ start: '2026-10-12' }, { calFile: tmpFile('{"_doc": "x"}') });
    expect(r.rc).toBe(1);
    expect(r.err[0]?.startsWith('[err]')).toBe(true);
    const r2 = await run({ json: true });
    expect((JSON.parse(r2.out) as Any).start).toBe('2026-10-12'); // NOW = T2 12/10/2026
  });
});
