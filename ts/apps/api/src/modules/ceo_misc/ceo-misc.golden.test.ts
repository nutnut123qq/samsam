import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/ceo_misc.golden.json' with { type: 'json' };
import * as au from './ceo-audit.js';
import * as cd from './ceo-decisions.js';
import * as cp from './ceo-promo.js';
import * as cr from './ceo-risk.js';

// Golden: kết quả chạy hàm Python THẬT (agents/ceo_audit|ceo_decisions|ceo_promo|ceo_risk) trên đầu
// vào cố định — script sinh ở scratchpad (`ceo_misc_golden/gen.py`, DSN chết). TS phải khớp y hệt.
// Ngày Python `date` = chuỗi 'YYYY-MM-DD'; datetime = chuỗi ISO → Date ở TS.

type Any = Record<string, unknown>;
const tmp = mkdtempSync(join(tmpdir(), 'ceo-misc-golden-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const toDate = (v: unknown): Date | null => (typeof v === 'string' ? new Date(v) : null);
const errMsg = (e: string): string => e.slice(e.indexOf(': ') + 2);

// ------------------------------------------------------------------ ceo_audit

describe('golden ceo_audit', () => {
  const items = G.audit_items as au.AuditItem[];
  const checks = G.audit_checks as au.Check[];

  it('norm_title / _body / _first_line / rate', () => {
    for (const [s, want] of G.audit_norm_title) expect(au.normTitle(s), String(s)).toBe(want);
    for (const [t, b, f] of G.audit_body as string[][]) {
      expect(au.body(t), JSON.stringify(t)).toBe(b);
      expect(au.firstLine(t), JSON.stringify(t)).toBe(f);
    }
    for (const [k, n, want] of G.audit_rate as [number, number, string][]) {
      expect(au.rate(k, n), `${k}/${n}`).toBe(want);
    }
  });

  it('compliance / findings / check_lines', () => {
    for (const c of G.audit_compliance as { args: Any; out: unknown }[]) {
      const a = c.args as {
        items: au.AuditItem[];
        channels: string[];
        snapshots: Record<string, string> | null;
      };
      expect(au.compliance(a.items, a.channels, undefined, a.snapshots)).toEqual(c.out);
    }
    expect(au.findings(items)).toEqual(G.audit_findings);
    expect(au.checkLines([])).toEqual(G.audit_check_lines.empty);
    expect(au.checkLines(checks)).toEqual(G.audit_check_lines.limit5);
    expect(au.checkLines(checks, null)).toEqual(G.audit_check_lines.all);
  });

  it('render_section: trang TGĐ (#id) / file report (ref đã che) / không checks / rỗng', () => {
    const data: au.AuditData = {
      items,
      removed: [{ kind: 'post' }],
      before: [{}, {}],
      snapshots: { shopee: 'listing.csv' },
      price_alerts_open: 3,
      checks,
    };
    expect(au.renderSection(data)).toEqual(G.audit_render.default);
    expect(
      au.renderSection(data, null, 'ceo-audit-2026-10-12.md', true, 'ceo-gia-2026-10-12.md'),
    ).toEqual(G.audit_render.full);
    const { checks: _c, ...noCheck } = data;
    expect(au.renderSection(noCheck, 2, 'r.md')).toEqual(G.audit_render.nocheck);
    expect(
      au.renderSection({
        items: [],
        removed: [],
        before: [],
        snapshots: {},
        price_alerts_open: 0,
        checks: [],
      }),
    ).toEqual(G.audit_render.empty);
  });
});

// ------------------------------------------------------------------ ceo_decisions

const decisions = (G.dec_decisions as Any[]).map((d) => ({
  ...d,
  recorded_at: toDate(d.recorded_at),
})) as cd.Decision[];
const waitQ = (G.dec_waiting.queue as unknown[][]).map(
  ([i, ot, t, due]): cd.WaitQ => [String(i), ot as string, t as string | null, toDate(due)],
);
const waitRev = (G.dec_waiting.rev as unknown[][]).map(
  ([q, ts]): cd.WaitRev => [q as string, toDate(ts)],
);
const MS = G.dec_ms as cd.Milestone[];
const TODAY = '2026-10-20';

describe('golden ceo_decisions', () => {
  it('chains / overdue / late_milestones', () => {
    expect(cd.chains(G.dec_chains.rows as cd.DecRow[])).toEqual(G.dec_chains.out);
    expect(cd.overdue(decisions, TODAY).map((d) => d.id)).toEqual(G.dec_overdue);
    expect(cd.lateMilestones(MS, TODAY)).toEqual(G.dec_late);
  });

  it('--basis / markup / _txt / _pg', () => {
    for (const [s, want] of G.dec_basis as [string, { ok?: unknown[]; err?: string }][]) {
      if (want.ok) {
        const [k, id] = want.ok;
        expect(cd.basisArg(s), s).toEqual([k, id]);
      } else expect(() => cd.basisArg(s), s).toThrow(errMsg(want.err as string));
    }
    for (const [s, want] of G.dec_markup as [string, boolean][]) {
      expect(cd.MARKUP_RE.test(s), s).toBe(want);
    }
    for (const [s, n, t, p] of G.dec_txt as [string | null, number, string, string][]) {
      expect(cd.txt(s, n), String(s)).toBe(t);
      expect(cd.pgSafe(s, n), String(s)).toBe(p);
    }
  });

  it('wait_lines (đủ / không đọc được / rỗng)', () => {
    const full: cd.ReadData = {
      decisions,
      milestones: MS,
      waiting_queue: waitQ,
      waiting_rev: waitRev,
    };
    expect(cd.waitLines(full, TODAY)).toEqual(G.dec_wait_lines.full);
    expect(
      cd.waitLines(
        { decisions: [], milestones: [], waiting_queue: null, waiting_rev: null },
        TODAY,
      ),
    ).toEqual(G.dec_wait_lines.none);
    expect(
      cd.waitLines({ decisions: [], milestones: [], waiting_queue: [], waiting_rev: [] }, TODAY),
    ).toEqual(G.dec_wait_lines.empty);
  });

  it('render_section', () => {
    expect(
      cd.renderSection(
        { decisions, milestones: MS, waiting_queue: waitQ, waiting_rev: waitRev },
        TODAY,
      ),
    ).toEqual(G.dec_render.full);
    expect(cd.renderSection({ decisions, milestones: MS }, TODAY)).toEqual(G.dec_render.no_wait);
    expect(cd.renderSection({ decisions: [], milestones: [] }, TODAY)).toEqual(G.dec_render.empty);
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...(MS[0] as cd.Milestone),
      code: `M${i}`,
    }));
    expect(cd.renderSection({ decisions: [], milestones: many }, TODAY)).toEqual(
      G.dec_render.many_ms,
    );
  });
});

// ------------------------------------------------------------------ ceo_promo

const LISTS: cp.Lists = new Map(
  (G.promo_lists as [string, string, number][]).map(([s, c, v]) => [`${s}\u0000${c}`, v]),
);
type PCase = { running: cp.Promo[]; approved: cp.Promo[]; out: cp.CompareResult };
const CASES = G.promo_cases as unknown as Record<string, PCase>;

describe('golden ceo_promo', () => {
  it('compare_promos — mọi ca', () => {
    for (const [name, c] of Object.entries(CASES)) {
      expect(cp.comparePromos(c.running, c.approved, LISTS, G.promo_today), name).toEqual(c.out);
    }
  });

  it('_desc / _vnd', () => {
    for (const [p, lst, want] of G.promo_desc as [Partial<cp.Promo>, number | null, string][]) {
      expect(cp.desc(p, lst), JSON.stringify(p)).toBe(want);
    }
    for (const [x, want] of G.promo_vnd as [number | null, string][]) expect(cp.vnd(x)).toBe(want);
  });

  it('promo_item: khóa đợt/tiêu đề/payload (nhóm rượu ẩn mã, mã lạ, cắt 300 ký tự)', () => {
    const alcohol = new Set(G.promo_alcohol);
    for (const it of G.promo_items as Any[]) {
      let f: cp.PromoFinding;
      if (it.f) f = it.f as cp.PromoFinding;
      else {
        const c = CASES[it.case as string] as PCase;
        f = cp.comparePromos(c.running, c.approved, LISTS, G.promo_today).findings[
          it.f_index as number
        ] as cp.PromoFinding;
      }
      expect(
        cp.promoItem(f, LISTS, alcohol, it.plan_sha as string | null),
        String(it.case),
      ).toEqual(it.item);
    }
  });
});

// ------------------------------------------------------------------ ceo_risk

const toFacts = (f: Any): cr.Facts =>
  ({
    ...f,
    posts: ((f.posts ?? []) as Any[]).map((p) => ({ ...p, due_at: toDate(p.due_at) })),
  }) as cr.Facts;

describe('golden ceo_risk', () => {
  const CFG = cr.loadConfig();

  it('load_config đọc phap_che.json (không chép số) + ca fail-closed', () => {
    expect(CFG).toEqual(G.risk_cfg);
    for (const [name, c] of Object.entries(G.risk_config_cases) as [
      string,
      { content: string | null; ok?: unknown; err?: string },
    ][]) {
      const p = join(tmp, `${name}.json`);
      if (c.content !== null) writeFileSync(p, Buffer.from(c.content, 'utf8'));
      if (c.ok) expect(cr.loadConfig(p), name).toEqual(c.ok);
      else {
        expect(() => cr.loadConfig(p), name).toThrow(RangeError);
        expect(() => cr.loadConfig(p), name).toThrow(errMsg(c.err as string));
      }
    }
  });

  it('fee_marker / rank (nhiều mốc giờ) / rank ca nhỏ', () => {
    for (const [d, want] of G.risk_fee_marker as [number, string | null][]) {
      expect(cr.feeMarker(d, CFG.nhac_moc_ngay), String(d)).toBe(want);
    }
    const facts = toFacts(G.risk_facts as Any);
    for (const r of G.risk_rank as { now: string; out: unknown }[]) {
      expect(cr.rank(facts, new Date(r.now), CFG), r.now).toEqual(r.out);
    }
    for (const r of G.risk_rank_small as { facts: Any; now: string; out: unknown }[]) {
      expect(cr.rank(toFacts(r.facts), new Date(r.now), CFG), JSON.stringify(r.facts)).toEqual(
        r.out,
      );
    }
  });

  it('trend / render_section / risk_row', () => {
    const t = G.risk_trend as unknown as {
      cur: cr.Risk[];
      prev: cr.Risk[];
      out: cr.Trend;
      rev: cr.Trend;
      same: cr.Trend;
    };
    expect(cr.trend(t.cur, t.prev)).toEqual(t.out);
    expect(cr.trend(t.prev, t.cur)).toEqual(t.rev);
    expect(cr.trend(t.cur, t.cur)).toEqual(t.same);
    const now = new Date(G.risk_now);
    expect(cr.renderSection(t.cur, t.out, now)).toEqual(G.risk_render.default);
    expect(cr.renderSection(t.cur, t.out, now, null)).toEqual(G.risk_render.full);
    expect(cr.renderSection([], {}, new Date('2026-10-03T01:00:00+07:00'))).toEqual(
      G.risk_render.empty,
    );
    for (const [r, sym, want] of G.risk_rows as [cr.Risk, string, string][]) {
      expect(cr.riskRow(r, sym), r.code).toBe(want);
    }
  });
});
