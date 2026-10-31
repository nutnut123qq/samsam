import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadConfig } from '@samsam/core/ops/director';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { dataPath, repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import { check, readinessKey } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import FADS from './__fixtures__/fp_ads.golden.json' with { type: 'json' };
import FPNL from './__fixtures__/fp_pnl.golden.json' with { type: 'json' };
import MADS from './__fixtures__/mkt_ads.golden.json' with { type: 'json' };
import { type Dec, decParse, decStr, type Rat } from './dec.js';
import { type AdsCfg, loadCfg, propose, renderPayload } from './fp-ads.js';
import { allocate, bien, parseMonth, pnl, vnd } from './fp-pnl.js';
import { type CmdDeps, fpAdsMain, mktAdsMain } from './mkt-ads.command.js';
import {
  BUDGET_AGENT,
  buildProposal,
  type Eval,
  evaluate,
  FEATURE,
  FLAG_OVER,
  FLAG_SPENT,
  fmtMetric,
  loadProposalCfg,
  type Metrics,
  normalizePlan,
  type PlanRow,
  PROPOSE_AGENT,
  type ProposalCfg,
  planSha,
  REJECT_CODES,
  readResults,
  renderPlan,
  renderResult,
  validatePlan,
} from './mkt-ads.js';

// Dịch phần THUẦN + CLI không DB của tests/test_fp_ads.py, tests/test_mkt_ads.py,
// tests/test_docx_mkt03.py (load_proposal_cfg, --propose BLOCKED), các ca pnl/allocate của
// tests/test_fp_pnl.py, test_ad_result_is_own_output của tests/test_contract_finalize.py. Logic thuần
// so khớp golden sinh từ hàm Python THẬT (`__fixtures__/*.golden.json`).
//
// TS_STRICTER (khác Python có chủ đích, fail-closed):
// - số nguyên > 2^53 (id creative, ô CSV) → từ chối như "không phải số" (Python nhận, JS mất chính xác);
//   ô CSV > 4300 chữ số: Python ValueError traceback-bắt-ở-CLI (exit 1) — TS báo lỗi ô (exit 1).
// - file phiếu JSON có NaN/Infinity: Python nhận (rồi chặn ở luật số > 0), TS → "không phải JSON".
// - parse_month năm 0000: Python ValueError, TS → null (exit 2).

const TMP = mkdtempSync(join(tmpdir(), 'mkt-ads-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let nf = 0;
const tfile = (b: Buffer | string, ext = '.json') => {
  const p = join(TMP, `f${nf++}${ext}`);
  writeFileSync(p, b);
  return p;
};
const b64 = (s: string) => Buffer.from(s, 'base64');

/** Python `ser` của script golden: Decimal → {dec}, Date → {ms}, Map → [[k, v]]. */
function ser(v: unknown): unknown {
  if (v instanceof Date) return { ms: v.getTime() };
  if (v instanceof Map) return [...v].map(([k, x]) => [k, ser(x)]);
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('c' in o && 'e' in o && 'neg' in o) return { dec: decStr(o as Dec) };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, ser(x)]));
  }
  return v;
}
const dec = (x: unknown): Dec | null =>
  x === null ? null : (decParse((x as { dec: string }).dec ?? (x as string)) as Dec);
const rd = (xs: unknown[][]) =>
  new Map(xs.map(([k, ch, v]) => [readinessKey(k as string, ch as string), v as string]));
const cfgOf = (c: {
  min_gross_margin_pct: string;
  budget_share_of_margin: string;
  channels: string[];
}): AdsCfg => ({
  min_gross_margin_pct: decParse(c.min_gross_margin_pct) as Dec,
  budget_share_of_margin: decParse(c.budget_share_of_margin) as Dec,
  channels: c.channels,
});

// ------------------------------------------------------------------ fp_pnl (golden)

describe('fp_pnl phần dùng chung (golden)', () => {
  it('allocate: tổng khớp, ROUND_HALF_UP, dư dồn cuối', () => {
    for (const [t, w, out] of FPNL.allocate as [number, number[], number[]][]) {
      expect(allocate(t, w), JSON.stringify([t, w])).toEqual(out);
    }
    expect(() => allocate(3, [])).toThrow(RangeError);
  });
  it('vnd / parse_month / bien', () => {
    for (const [n, s] of FPNL.vnd as [number, string][]) expect(vnd(n)).toBe(s);
    for (const [s, out] of FPNL.parse_month as [unknown, string | null][])
      expect(parseMonth(s), String(s)).toBe(out);
    for (const [a, b, out] of FPNL.bien as [number, number, { dec: string } | null][]) {
      expect(ser(bien(a, b)), `${a}/${b}`).toEqual(out);
    }
  });
  it('pnl: ô SKU × kênh, thiếu giá vốn = null (không phải 0), lọc kênh cùng phạm vi đếm', () => {
    for (const c of FPNL.pnl as Record<string, unknown>[]) {
      type P = Parameters<typeof pnl>;
      const out = pnl(
        c.rows as P[0],
        c.lines as P[1],
        c.versions as P[2],
        c.month as string,
        c.channel as string | null,
      );
      expect(ser(out)).toEqual(c.out);
    }
  });
});

// ------------------------------------------------------------------ fp_ads

describe('fp_ads (golden + test_fp_ads.py)', () => {
  it('cấu hình GIẢ ĐỊNH + validate (golden load_cfg)', () => {
    const raw = readFileSync(dataPath('fpa_config.json'), 'utf8');
    expect(raw).toContain('GIẢ ĐỊNH');
    expect(JSON.parse(raw).confirmed_by).toBeNull();
    const [cfg, why] = loadCfg();
    expect(why).toBeNull();
    expect(decStr((cfg as AdsCfg).min_gross_margin_pct)).toBe('0.3');
    for (const [content, out, w] of FADS.load_cfg as [string, unknown, string | null][]) {
      const p = tfile(content);
      const [c, why2] = loadCfg(p);
      // tên file tạm khác nhau giữa 2 lần sinh — thay bằng tên file của ca này
      const exp = w?.replace(/f[0-9.]+\.json/, basename(p)) ?? null;
      expect([ser(c), why2], content.slice(0, 80)).toEqual([out, exp]);
    }
  });
  it('propose: thứ tự ưu tiên mã, ngưỡng đọc từ cfg, payload (golden)', () => {
    for (const c of FADS.propose as Record<string, unknown>[]) {
      const cells = (c.cells as Record<string, unknown>[]).map((x) => ({
        sku_key: x.sku_key as string,
        channel: x.channel as string,
        lai_gop: x.lai_gop as number | null,
        bien_gop_pct: dec(x.bien_gop_pct),
      }));
      const cfg = cfgOf(c.cfg as never);
      const props = propose(cells, rd(c.readiness as unknown[][]), cfg);
      expect(ser(props)).toEqual(c.out);
      const month = (c.payload as string).includes('01/2027') ? '2027-01-01' : '2026-10-01';
      expect(renderPayload(month, props, cfg)).toBe(c.payload);
    }
  });
  it('payload không nêu tên SKU bị CAM (rượu), ghi rõ agent không chi tiền, qua guardrail', () => {
    const c = (FADS.propose as Record<string, unknown>[]).find((x) =>
      (x.payload as string).includes('savina-12v'),
    ) as Record<string, unknown>;
    const text = c.payload as string;
    expect(text).not.toMatch(/rượu|ruou|alcohol/i);
    expect(text).toContain('1 cặp SKU × kênh (1 SKU) readiness CAM');
    expect(text).toContain('agent không chi tiền');
    expect(check(text).ok).toBe(true);
    // ô "(chưa rõ SKU)" không bao giờ thành đề xuất
    expect(
      propose(
        [{ sku_key: '(chưa rõ SKU)', channel: 'shopee', lai_gop: 1, bien_gop_pct: decParse('90') }],
        new Map(),
        cfgOf({ min_gross_margin_pct: '0.3', budget_share_of_margin: '0.2', channels: ['shopee'] }),
      ),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------ mkt_ads

const TODAY = MADS.today;
const ALCOHOL = ['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml'];

function ctxOf(c: Record<string, unknown>) {
  return {
    golden: new Map(Object.entries(c.golden as Record<string, { category: unknown }>)),
    readiness: rd(c.readiness as unknown[][]),
    creatives: new Map(
      Object.entries(c.creatives as Record<string, Record<string, unknown>>).map(([k, v]) => [
        Number(k),
        v,
      ]),
    ),
    cap: c.cap as never,
    today: TODAY,
    dossier_ok: c.dossier_ok as boolean,
    allocated: c.allocated as number,
  };
}

const serM = (m: Metrics) => ({
  hien_thi: m.hien_thi,
  click: m.click,
  chi_phi_vnd: m.chi_phi_vnd,
  don_hang: m.don_hang,
  ctr: fmtMetric(m.ctr, 'ctr'),
  cpc: fmtMetric(m.cpc, 'cpc'),
  cpa: fmtMetric(m.cpa, 'cpa'),
});
const serEv = (ev: Eval) => ({
  tong: serM(ev.tong),
  bien_the: [...ev.bien_the].map(([i, m]) => [i, serM(m)]),
  stop_hits: ev.stop_hits,
  dat_muc_tieu: ev.dat_muc_tieu,
  co: ev.co,
  de_xuat: ev.de_xuat,
});

describe('mkt_ads luật chặn (golden + test_mkt_ads.py)', () => {
  it('mã từ chối cố định thứ tự', () => {
    expect(REJECT_CODES).toEqual([
      'ADS_INPUT',
      'ADS_OFFLINE_ONLY',
      'ADS_LISTING_ONLY',
      'ADS_CAM',
      'ADS_XNQC_DOSSIER',
      'ADS_CREATIVE_UNAPPROVED',
      'ADS_NO_CAP',
      'ADS_OVER_CAP',
    ]);
  });
  it('normalize_plan + plan_sha (golden: mọi biến thể đầu vào sai → lý do; _doc bỏ qua)', () => {
    for (const [text, norm, why, sha] of MADS.normalize as [
      string,
      unknown,
      string | null,
      string | null,
    ][]) {
      const [n, w] = normalizePlan(parsePyJson(text), TODAY);
      expect([ser(n), w], text.slice(0, 120)).toEqual([norm, why]);
      if (n) expect(planSha(n)).toBe(sha);
    }
  });
  it('plan_sha ổn định (cùng phiếu = cùng sha, đổi ngân sách = sha khác)', () => {
    const base = MADS.normalize[0]?.[0] as string;
    const n1 = normalizePlan(parsePyJson(base), TODAY)[0];
    const withDoc = { ...(JSON.parse(base) as object), _doc: 'x' };
    const n2 = normalizePlan(parsePyJson(JSON.stringify(withDoc)), TODAY)[0];
    const n3 = normalizePlan({ ...(parsePyJson(base) as object), budget_vnd: 299_999 }, TODAY)[0];
    expect(n1 && n2 && planSha(n1) === planSha(n2)).toBe(true);
    expect(n1 && n3 && planSha(n1) !== planSha(n3)).toBe(true);
    // surrogate lẻ: Python `.encode("utf-8")` ném UnicodeEncodeError (ValueError) → TS ném RangeError
    const bad = normalizePlan(
      { ...(parsePyJson(base) as object), hypothesis: 'Giả thuyết \ud800 đủ dài' },
      TODAY,
    )[0];
    expect(() => planSha(bad as never)).toThrow(RangeError);
  });
  it('validate_plan (golden): offline_only trước readiness, listing_only, CAM fail-closed, XNQC, creative, trần', () => {
    for (const c of MADS.validate as Record<string, unknown>[]) {
      const [code, why] = validatePlan(parsePyJson(c.plan as string), ctxOf(c));
      expect([code, why], c.plan as string).toEqual([c.code, c.why]);
    }
  });
  it('rượu: lý do không nêu sku_key (payload/log không lộ tên)', () => {
    for (const c of MADS.validate as Record<string, unknown>[]) {
      if (c.code !== 'ADS_OFFLINE_ONLY') continue;
      for (const k of ALCOHOL) expect(c.why as string).not.toContain(k);
    }
    expect(
      (MADS.validate as Record<string, unknown>[]).filter((c) => c.code === 'ADS_OFFLINE_ONLY')
        .length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('mkt_ads kết quả (golden + test_mkt_ads.py)', () => {
  it('evaluate + render_result: dừng/đạt/tiếp/chưa dữ liệu, cờ chi vượt; KHÔNG nhánh tăng ngân sách', () => {
    for (const c of MADS.evaluate as Record<string, unknown>[]) {
      const ev = evaluate(c.plan as never, c.rows as never);
      expect(serEv(ev)).toEqual(c.ev);
      const text = renderResult(c.plan as never, ev, 'ab'.repeat(32), (c.rows as unknown[]).length);
      expect(text).toBe(c.render);
      expect(text.toLowerCase()).not.toContain('tăng ngân sách');
    }
    const flags = (MADS.evaluate as { ev: { co: string[] } }[]).flatMap((c) => c.ev.co);
    expect(flags).toContain(FLAG_OVER);
    expect(flags).toContain(FLAG_SPENT);
    const over = (MADS.evaluate as { render: string; ev: { co: string[] } }[]).find((c) =>
      c.ev.co.includes(FLAG_OVER),
    );
    expect(check(over?.render).ok).toBe(true);
  });
  it('_fmt (golden: ctr %, VND làm tròn HALF_EVEN như Decimal)', () => {
    for (const [v, metric, out] of MADS.fmt as [string | null, string, string][]) {
      expect(fmtMetric(v, metric), `${v} ${metric}`).toBe(out);
    }
    const third: Rat = { n: 1n, d: 3n };
    expect(fmtMetric(third, 'ctr')).toBe('33.33%');
  });
  it('render_plan (golden)', () => {
    for (const [row, text] of MADS.render_plan as [PlanRow, string][])
      expect(renderPlan(row)).toBe(text);
  });
  it('read_results (golden): cột lạ chặn cả file, lỗi nêu dòng/cột KHÔNG nêu giá trị ô, ô quá field limit', () => {
    for (const c of MADS.read_results as Record<string, unknown>[]) {
      let raw: Buffer;
      if (c.gen) {
        const [pre, unit, n, suf] = c.gen as [string, string, number, string];
        raw = Buffer.concat([
          b64(pre),
          Buffer.from(b64(unit).toString('latin1').repeat(n), 'latin1'),
          b64(suf),
        ]);
      } else raw = b64(c.b64 as string);
      const [rows, errs, sha] = readResults(tfile(raw, '.csv'), c.plan as never);
      expect([rows, errs, sha], (c.errs as string[]).slice(0, 3).join('|')).toEqual([
        c.rows,
        c.errs,
        c.sha,
      ]);
      const joined = errs.join('\n');
      for (const secret of ['0909123456', '0909 123 456', '0912345678', '12.5'])
        expect(joined).not.toContain(secret);
    }
  });
  it('TS_STRICTER: ô số nguyên > 2^53 → lỗi ô (Python nhận / ValueError khi > 4300 chữ số)', () => {
    const p = tfile(
      'ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang\n2026-11-03,101,99999999999999999999,1,1,1\n',
      '.csv',
    );
    const [rows, errs] = readResults(p, {
      creative_draft_ids: [101],
      start_date: '2026-11-02',
      end_date: '2026-11-22',
    });
    expect(rows).toEqual([]);
    expect(errs).toEqual(['dòng 2 cột hien_thi: không phải số nguyên ≥ 0']);
  });
});

describe('marketing-03 agent tự đề xuất (test_docx_mkt03.py, phần thuần)', () => {
  it('load_proposal_cfg: file repo CHƯA CHỐT → BLOCKED; tham số sai → chặn (golden)', () => {
    const [cfg, why] = loadProposalCfg(dataPath('ads_proposal.json'));
    expect(cfg).toBeNull();
    expect(why).toContain('CHƯA CHỐT');
    for (const [content, ok, w] of MADS.proposal_cfg as [string, boolean, string | null][]) {
      const [c, why2] = loadProposalCfg(tfile(b64(content)));
      expect([c !== null, why2], b64(content).toString('utf8').slice(0, 80)).toEqual([ok, w]);
    }
  });
  it('dựng phiếu từ ô FP&A DE_XUAT: ngân sách = trần × tỷ lệ (cắt), ngày bắt đầu/kết thúc, giả thuyết (golden)', () => {
    for (const c of MADS.proposal as Record<string, unknown>[]) {
      const pc = c.pcfg as Record<string, unknown>;
      const plan = buildProposal(
        c.p as never,
        pc as unknown as ProposalCfg,
        '2026-10-01',
        TODAY,
        c.ids as number[],
      );
      expect(plan, JSON.stringify(c.p)).toEqual(c.plan);
      if (plan) {
        expect(plan.hypothesis).toContain(PROPOSE_AGENT);
        expect(plan.hypothesis).toContain('trần FP&A');
        expect(plan.hypothesis).toContain('ads_proposal');
      }
    }
  });
  it('mã tính năng + agent id ngân sách riêng (P8.2)', () => {
    expect(FEATURE).toBe('marketing-03.1');
    expect(BUDGET_AGENT.startsWith('agent:')).toBe(true);
    const feats = JSON.parse(readFileSync(dataPath('contract_features.json'), 'utf8'));
    const all = (feats.features ?? feats) as { id: string; agent_ids?: string[] }[];
    const m3 = all.find((f) => f.id === 'marketing-03.1');
    expect(m3?.agent_ids ?? []).toContain(BUDGET_AGENT);
    expect(all.some((f) => f.id === 'marketing-03.2')).toBe(true);
  });
});

describe('cấu hình khối + "0 đường chi tiền" (test_mkt_ads.py W64.6, test_fp_ads.py)', () => {
  it('director marketing/finance: ad_campaign/ad_result/budget_change risk high, approvers rỗng', () => {
    const cfg = loadConfig('marketing');
    const t = cfg.object_types;
    expect(Object.keys(t).sort()).toEqual(
      [
        'ad_campaign',
        'listing_copy',
        'koc_brief',
        'campaign_brief',
        'ugc_reply',
        'ugc_reuse',
        'seo_web_fix',
        'partner_post_review',
        'ad_result',
      ].sort(),
    );
    expect(t.ugc_reply).toEqual({ sla_hours: 24, risk: 'medium' });
    expect(t.ugc_reuse).toEqual({ sla_hours: 72, risk: 'high' });
    expect(t.ad_campaign?.risk).toBe('high');
    expect(cfg.approvers).toEqual([]);
    expect(loadConfig('finance').object_types.budget_change?.risk).toBe('high');
  });
  it('module không gọi mạng / API quảng cáo / AI gateway / chi tiền', () => {
    for (const f of [
      'dec.ts',
      'fp-pnl.ts',
      'fp-ads.ts',
      'mkt-ads.ts',
      'mkt-ads.service.ts',
      'mkt-ads.command.ts',
      'mkt-director.ts',
      'mkt-calendar.ts',
    ]) {
      const src = readFileSync(
        repoPath('ts', 'apps', 'api', 'src', 'modules', 'mkt_ads', f),
        'utf8',
      );
      expect(src, f).not.toMatch(
        /graph\.facebook\.com|business-api\.tiktok\.com|ads\.google|facebook_business|tiktok_business|googleads|node:https?|node:net|node:dgram|undici|fetch\(|nodemailer|@samsam\/core\/ai\/|AI_GATEWAY|\.chat\(|\.embed\(/,
      );
    }
  });
});

// ------------------------------------------------------------------ CLI không DB

describe('CLI không DB — usage/từ chối TRƯỚC connect', () => {
  afterEach(() => {
    settings.forceMode = null;
  });
  const run = async (main: typeof mktAdsMain, o: Record<string, unknown>, extra: CmdDeps = {}) => {
    const out: string[] = [];
    const errs: string[] = [];
    let calls = 0;
    const code = await main(o as never, {
      log: (s) => out.push(s),
      err: (s) => errs.push(s),
      connect: async () => {
        calls++;
        return null;
      },
      wire: null,
      today: TODAY,
      ...extra,
    });
    return { code, out: out.join('\n'), err: errs.join('\n'), calls };
  };

  it('mkt-ads usage sai → exit 2, không connect', async () => {
    for (const o of [
      { plan: 'x.json', status: '1' },
      {},
      { plan: 'x.json' },
      { results: 'x.csv', by: 'a' },
      { status: '1', month: '13' },
      { plan: 'x.json', by: '  ' },
      { status: 'abc' },
      { propose: true, by: 'ai đó' },
    ]) {
      const r = await run(mktAdsMain, o);
      expect([r.code, r.calls], JSON.stringify(o)).toEqual([2, 0]);
    }
  });
  it('mkt-ads phiếu sai → [từ chối] ADS_INPUT exit 1, không connect', async () => {
    const plan = JSON.parse(MADS.normalize[0]?.[0] as string);
    let r = await run(mktAdsMain, {
      plan: tfile(JSON.stringify({ ...plan, budget_vnd: -1 })),
      by: 'a',
    });
    expect([r.code, r.calls]).toEqual([1, 0]);
    expect(r.out).toContain('ADS_INPUT');
    r = await run(mktAdsMain, { plan: tfile('{'), by: 'a' });
    expect([r.code, r.calls]).toEqual([1, 0]);
    expect(r.out).toContain('file phiếu không phải JSON UTF-8');
    r = await run(mktAdsMain, { plan: tfile(`{"a": "${'x'.repeat(64_001)}"}`), by: 'a' });
    expect(r.out).toContain('file phiếu quá lớn');
    r = await run(mktAdsMain, { plan: join(TMP, 'khong-co.json'), by: 'a' });
    expect(r.out).toContain('không đọc được file phiếu (FileNotFoundError)');
  });
  it('mkt-ads --propose: tham số CHƯA CHỐT → [BLOCKED] exit 2, không connect', async () => {
    const r = await run(mktAdsMain, { propose: true });
    expect([r.code, r.calls]).toEqual([2, 0]);
    expect(r.out).toContain('[BLOCKED]');
  });
  it('mkt-ads cấu hình FP&A hỏng → exit 1 "không connect"', async () => {
    const r = await run(mktAdsMain, { status: '1' }, { paths: { fpa: tfile('{') } });
    expect([r.code, r.calls]).toEqual([1, 0]);
    expect(r.out).toContain('không connect');
  });
  it('mkt-ads DB down → exit 2', async () => {
    const r = await run(mktAdsMain, { status: '1' });
    expect([r.code, r.calls]).toEqual([2, 1]);
    expect(r.err).toContain('không kết nối được Postgres');
  });
  it('fp-ads usage sai → exit 2; cấu hình hỏng → exit 1; cả hai không connect', async () => {
    for (const o of [{ propose: true }, { propose: true, month: '2026-13' }, {}]) {
      const r = await run(fpAdsMain as never, o);
      expect([r.code, r.calls], JSON.stringify(o)).toEqual([2, 0]);
    }
    const r = await run(
      fpAdsMain as never,
      { propose: true, month: '2026-10' },
      { paths: { fpa: tfile('{') } },
    );
    expect([r.code, r.calls]).toEqual([1, 0]);
    expect(r.out).toContain('không connect');
  });
});
