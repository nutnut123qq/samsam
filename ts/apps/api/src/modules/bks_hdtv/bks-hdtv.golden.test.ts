import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpCmp, parsePyJson } from '@samsam/core/ops/py-json';
import { afterAll, describe, expect, it } from 'vitest';
import { dec, decStr } from '../ceo_report/dec.js';
import { loadFees } from '../settlement/settlement-csv.js';
import GA from './__fixtures__/bks_audit.golden.json' with { type: 'json' };
import GR from './__fixtures__/bks_recon.golden.json' with { type: 'json' };
import GH from './__fixtures__/hdtv_report.golden.json' with { type: 'json' };
import * as A from './bks-audit.js';
import * as R from './bks-recon.js';
import * as H from './hdtv-report.js';

// Golden sinh bằng hàm Python THẬT (agents/bks_audit.py, bks_recon.py, hdtv_report.py) trên đầu
// vào cố định — script `bks_hdtv_golden.py` ở scratchpad của phiên (không trong repo), chạy với
// DATABASE_URL chết. Che PII thật (security/pii).
//
// KHÁC Python có chủ đích (TS chặt hơn = fail-closed):
//  - TS_STRICTER `monthBounds`: '0000-01' → "--month phải dạng YYYY-MM" (Python: "year 0 is out of
//    range") — cả hai RangeError/ValueError → exit 2.
//  - TS_STRICTER `loadConfig`: JSON có NaN/Infinity → JSONDecodeError (Python nhận rồi luật kiểu chặn).

const NOW = new Date('2026-10-14T09:00:00+07:00');

/** Giải mã giá trị golden: {__dt__} → Date, {__date__} → chuỗi ngày, {__dec__} → chuỗi. */
function jd(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jd);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__dt__ === 'string') return new Date(o.__dt__);
    if (typeof o.__date__ === 'string') return o.__date__;
    if (typeof o.__dec__ === 'string') return o.__dec__;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, jd(x)]));
  }
  return v;
}

type Res = { ok?: unknown; error?: string; msg?: string };

describe('bks_audit golden', () => {
  it('validHeads (jsonb → int/float như json.loads)', () => {
    for (const c of GA.valid_heads) expect(A.validHeads(parsePyJson(c.raw)), c.raw).toEqual(c.out);
  });

  it('norm', () => {
    for (const c of GA.norm) expect(A.norm(c.in)).toBe(c.out);
  });

  it('overrideLine che PII + bỏ ký tự markdown', () => {
    for (const c of GA.override_line) {
      expect(A.overrideLine(jd(c.in) as A.Override)).toBe(c.out);
    }
  });

  it('findingLine + byCode', () => {
    for (const c of GA.finding_line) expect(A.findingLine(c.in as A.Finding)).toBe(c.out);
    expect(A.byCode(GA.finding_line.map((c) => c.in as A.Finding))).toEqual(GA.by_code);
  });

  it('render', () => {
    for (const c of GA.render) {
      const x = jd(c.in) as { data: A.AuditData; label: string };
      expect(A.render(x.data, x.label, NOW)).toBe(c.out);
    }
  });

  it('fingerprint chain_alert = công thức Python', () => {
    for (const c of GA.fingerprint) expect(A.fingerprint(c.in as A.Finding[])).toBe(c.out);
  });

  it('monthBounds', () => {
    for (const c of GA.month_bounds) {
      const now = new Date(c.now);
      const out = c.out as Res;
      if (out.error) {
        expect(() => A.monthBounds(c.arg, now)).toThrow(RangeError);
        expect(() => A.monthBounds(c.arg, now)).toThrow(out.msg as string);
      } else {
        const [label, s, e] = A.monthBounds(c.arg, now);
        expect([label, s, e]).toEqual(jd(out.ok));
      }
    }
  });

  it('hằng số + SQL khớp Python', () => {
    const k = GA.constants;
    expect(A.CODES).toEqual(k.CODES);
    expect(A.APPEND_ONLY).toEqual(k.APPEND_ONLY);
    expect(A.FUNC_ONLY_INSERT).toEqual(k.FUNC_ONLY_INSERT);
    expect(A.WATCH_ROLES).toEqual(k.WATCH_ROLES);
    expect(A.READ_ONLY_ROLES).toEqual(k.READ_ONLY_ROLES);
    expect(A.BEN_A_READS).toEqual(k.BEN_A_READS);
    expect(A.PII_TABLES).toEqual(k.PII_TABLES);
    expect(A.READ_FUNCS).toEqual(k.READ_FUNCS);
    expect(A.ROLE_FUNCS).toEqual(k.ROLE_FUNCS);
    expect(A.APPROVAL_ACTIONS).toEqual(k.APPROVAL_ACTIONS);
    expect(A.KIND_FEATURE).toEqual(k.KIND_FEATURE);
    expect(A.FIRST_RUN).toBe(k.FIRST_RUN);
    expect(A.LIMIT_NOTE).toBe(k.LIMIT_NOTE);
    expect(A.CHAIN_CODES).toEqual(k.CHAIN_CODES);
    const s = k.SQL;
    expect([A.SQL_A, A.SQL_B, A.SQL_C, A.SQL_D, A.SQL_E]).toEqual([s.A, s.B, s.C, s.D, s.E]);
    expect([A.OVR_SQL, A.BASIS_SQL, A.PRIV_SQL, A.FUNC_SQL, A.MEMBER_SQL, A.SEL_SQL]).toEqual([
      s.OVR,
      s.BASIS,
      s.PRIV,
      s.FUNC,
      s.MEMBER,
      s.SEL,
    ]);
  });

  it('excess / excessRead', () => {
    for (const [role, table, priv, want] of GA.excess as [string, string, string, boolean][]) {
      const got = priv === 'SELECT' ? A.excessRead(role, table) : A.excess(role, table, priv);
      expect(got, `${role} ${table} ${priv}`).toBe(want);
    }
  });
});

// ---------------------------------------------------------------- bks_recon

const MONEY_KEYS = new Set(['order_amount', 'payout', 'value', 'thuc_nhan', 'doanh_thu']);

/** Số tiền của nguồn (Python int) → bigint như module. */
function toSrc(src: unknown): R.Src {
  const s = src as { month: string; channels: Record<string, Record<string, unknown>> };
  const channels: Record<string, R.ChanSrc> = {};
  for (const [ch, v] of Object.entries(s.channels)) {
    const o: Record<string, unknown> = { tol: v.tol };
    for (const k of ['Q', 'D', 'P', 'C']) {
      const x = v[k] as Record<string, unknown> | null;
      o[k] =
        x === null
          ? null
          : Object.fromEntries(
              Object.entries(x).map(([kk, vv]) => [
                kk,
                MONEY_KEYS.has(kk) && typeof vv === 'number' ? BigInt(vv) : vv,
              ]),
            );
    }
    channels[ch] = o as R.ChanSrc;
  }
  return { month: s.month, channels };
}

const unBig = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));

const ROW_MONEY = [
  'order_amount',
  'fixed_fee',
  'payment_fee',
  'service_fee',
  'shipping_fee',
  'voucher_seller',
  'affiliate',
  'refund',
  'payout',
];

describe('bks_recon golden', () => {
  it('pickSample = random.Random(seed).sample (MT19937, cả nhánh pool lẫn set)', () => {
    for (const c of GR.pick_sample) {
      expect(R.pickSample(c.ids, BigInt(c.seed), c.limit), `seed ${c.seed}`).toEqual(c.out);
    }
  });

  it('recheckRows', () => {
    const [fees] = loadFees();
    expect(fees).not.toBeNull();
    for (const c of GR.recheck_rows) {
      const rows = (c.in.rows as Record<string, unknown>[]).map((r) => {
        const o: Record<string, unknown> = { ...r };
        for (const k of ROW_MONEY) o[k] = BigInt(r[k] as number);
        const st = r.stored as { label: string; expected: number } | null;
        o.stored = st === null ? null : { label: st.label, expected: BigInt(st.expected) };
        return o as R.CheckRow;
      });
      const orders = new Map(
        (c.in.orders as [string, string, number][]).map(([a, b, t]) => [
          `${a}\u0000${b}`,
          BigInt(t),
        ]),
      );
      expect(R.recheckRows(rows, orders, fees as never)).toEqual(c.out);
    }
  });

  it('diffs (thiếu nguồn ≠ 0, biên dung sai)', () => {
    for (const c of GR.diffs) expect(unBig(R.diffs(toSrc(c.in)))).toEqual(c.out);
  });

  it('render', () => {
    for (const c of GR.render) {
      const d = c.in as unknown as Record<string, unknown>;
      const data: R.ReconData = {
        src: toSrc(d.src),
        row_findings: d.row_findings as R.RowFinding[],
        n_total: d.n_total as number,
        n_checked: d.n_checked as number,
        seed: BigInt(d.seed as number),
        sample_flag: d.sample_flag as boolean,
      };
      expect(R.render(data, NOW)).toBe(c.out);
    }
  });

  it('fname (không PII, không ký tự bảng)', () => {
    for (const c of GR.fname) expect(R.fname(c.in)).toBe(c.out);
  });

  it('hằng số + SQL khớp Python', () => {
    const k = GR.constants;
    expect(R.CODES).toEqual(k.CODES);
    expect(R.ROW_SQL).toBe(k.ROW_SQL);
    expect(R.CS_SQL).toBe(k.CS_SQL);
    expect(R.UNSETTLED_SQL).toBe(k.UNSETTLED_SQL);
    expect(R.SRC_NAME).toEqual(k.SRC_NAME);
  });
});

// ---------------------------------------------------------------- hdtv_report

const tmp = mkdtempSync(join(tmpdir(), 'hdtv-golden-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('hdtv_report golden', () => {
  it('parsePeriod', () => {
    for (const c of GH.parse_period) {
      const out = c.out as Res;
      if (out.error) {
        expect(() => H.parsePeriod(c.in, NOW), String(c.in)).toThrow(RangeError);
        expect(() => H.parsePeriod(c.in, NOW)).toThrow(out.msg as string);
      } else {
        const p = H.parsePeriod(c.in, NOW);
        expect({ ...p }).toEqual(jd(out.ok));
      }
    }
  });

  it('quarterValue', () => {
    for (const c of GH.quarter_value) {
      const vals = c.vals.map((v) => (v === null ? null : dec(v)));
      const [v, why] = H.quarterValue(c.agg, vals);
      expect([v === null ? null : decStr(v), why]).toEqual(c.out);
    }
  });

  it('numTokens + checkGrounded (\\d / \\b Unicode như Python)', () => {
    for (const c of GH.num_tokens) {
      expect([...H.numTokens(c.in)].sort(cpCmp)).toEqual(c.out);
    }
    for (const c of GH.check_grounded) expect(H.checkGrounded(c.text, c.facts)).toEqual(c.out);
  });

  it('Pack.lines đăng ký dòng có chữ số', () => {
    for (const c of GH.lines) {
      const p = new H.Pack({
        ...H.parsePeriod('2026-09', NOW),
        config: { quarter_agg: {} },
        generatedAt: NOW,
      });
      expect(p.lines(c.in, 'src')).toEqual(c.out);
      expect(p.facts).toEqual(c.facts);
    }
  });

  it('render (số không nguồn → UngroundedNumber)', () => {
    for (const c of GH.render) {
      const p = new H.Pack({
        ...H.parsePeriod(c.kind === 'month' ? '2026-09' : '2026-Q3', NOW),
        config: { quarter_agg: {} },
        generatedAt: NOW,
      });
      p.sections = c.sections;
      p.facts = [...c.facts];
      p.sample = c.sample;
      p.guardrailViolations = [...c.viol];
      const out = c.out as Res;
      if (out.error) {
        expect(() => H.render(p)).toThrow(H.UngroundedNumber);
        expect(() => H.render(p)).toThrow(out.msg as string);
      } else expect(H.render(p)).toBe(out.ok);
    }
  });

  it('loadConfig', () => {
    for (const [name, c] of Object.entries(GH.load_config)) {
      const path = join(tmp, name === 'missing' ? 'khong_co.json' : 'hdtv_report.json');
      if (c.body !== null) writeFileSync(path, Buffer.from(c.body, 'utf8'));
      const out = c.out as Res;
      if (out.error) {
        expect(() => H.loadConfig(path), name).toThrow(H.ConfigError);
        expect(() => H.loadConfig(path)).toThrow(out.msg as string);
      } else expect(H.loadConfig(path)).toEqual(out.ok);
    }
  });

  it('hằng số + SQL khớp Python', () => {
    expect([...H.SECTION_HEADS]).toEqual(GH.constants.SECTION_HEADS);
    expect(H.RUNS_SQL).toBe(GH.constants.RUNS_SQL);
  });
});
