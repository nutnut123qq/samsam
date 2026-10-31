import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/intel_import.golden.json' with { type: 'json' };
import * as ii from './intel-import.js';
import * as iw from './intel-weekly.js';
import * as sv from './social-vendor.js';
import { clean, safe, toInt } from './table.js';

// Golden của nhóm intel_import: kết quả chạy hàm Python THẬT (`ingest/intel_import.py`,
// `ingest/market_csv.py` helper, `ingest/social_vendor.py`, `scripts/intel_weekly.py`) trên đầu vào
// cố định (script sinh ở scratchpad, golden.py). TS phải khớp y hệt; khác biệt CÓ CHỦ ĐÍCH (TS chặt
// hơn = fail-closed) liệt kê ở TS_STRICTER.

const TS_STRICTER: Record<string, string> = {
  // json.loads của Python nhận NaN/Infinity rồi báo lỗi trường; TS từ chối đọc file (JSONDecodeError).
  'trend_config:nan': 'NaN trong JSON → lỗi đọc file thay vì lỗi trường (cùng fail-closed)',
};

const FIX = repoPath('tests/fixtures/intel_import');
const VFIX = repoPath('tests/fixtures/social_vendor');
const OWN = join(import.meta.dirname, '__fixtures__');
const TODAY = '2026-10-12';
const NOW = new Date('2026-10-12T12:00:00+07:00');
const tmp = mkdtempSync(join(tmpdir(), 'intel-import-'));
let seq = 0;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Case = {
  name: string;
  file?: string;
  b64?: string;
  gen?: string;
  fixture?: string;
  xlsx?: string;
  missing?: boolean;
  repo?: boolean;
  raw?: string | null;
};

/** Dựng lại tệp đầu vào của ca golden (cùng byte với Python). */
function fileOf(c: Case, fixDir = FIX): string {
  if (c.fixture) return join(fixDir, c.fixture);
  if (c.xlsx) return join(OWN, c.xlsx);
  // thư mục riêng mỗi ca: tên tệp giữ đúng tên Python (đuôi .csv/.xlsx quyết định cách đọc)
  const dir = join(tmp, String(seq++));
  mkdirSync(dir);
  const p = join(dir, c.file ?? 'f.json');
  let data: Buffer;
  if (c.gen === 'field_limit') {
    data = Buffer.concat([
      Buffer.from('doi_thu,kenh,ten_san_pham,gia_vnd,ngay_ghi,nguon\n'),
      Buffer.from(`"${'a'.repeat(131073)}"\n`),
    ]);
  } else if (c.gen === 'patho') {
    data = Buffer.from(`Week,quà tết: (Việt Nam),"${'a: ('.repeat(20000)}"\n2026-10-04,1,2\n`);
  } else if (c.raw !== undefined && c.raw !== null) data = Buffer.from(c.raw, 'utf8');
  else data = Buffer.from(c.b64 ?? '', 'base64');
  writeFileSync(p, data);
  return p;
}

const [CFG] = ii.loadTrendConfig();
const [RULES] = ii.loadSocialRules();
if (!CFG || !RULES) throw new Error('cấu hình repo hỏng');
const RULES_T: ii.SocialRules = { ...RULES, dpia_signed: true };

describe('helper market_csv/_text/_kw (golden)', () => {
  it('_text', () => {
    for (const [s, a, b] of G.text as [string | null, string, string][]) {
      expect([ii.text(s, 200), ii.text(s, 5)], JSON.stringify(s)?.slice(0, 40)).toEqual([a, b]);
    }
  });
  it('_kw', () => {
    for (const [s, k] of G.kw as [string, string][]) expect(ii.kw(s), s).toBe(k);
  });
  it('_clean/_safe', () => {
    for (const [s, a, b, c, d] of G.clean as [string | null, string, string, string, string][]) {
      expect([clean(s, 120), clean(s, 7), safe(s), safe(s, 5)], String(s)).toEqual([a, b, c, d]);
    }
  });
  it('_to_int', () => {
    for (const [s, a, b] of G.to_int as [string, number | null, number | null][]) {
      expect([toInt(s, ii.MAX_PRICE), toInt(s, 2 * 10 ** 9)], s).toEqual([a, b]);
    }
  });
  it('_iso_date / _iso_ts', () => {
    for (const [s, d] of G.iso_date as [string | null, string | null][]) {
      expect(ii.isoDate(s), String(s)).toBe(d);
    }
    for (const [s, t] of G.iso_ts as [string | null, string | null][]) {
      const got = ii.isoTs(s);
      expect(got?.iso ?? null, String(s)).toBe(t);
      if (t) expect(got?.ms).toBe(new Date(t).getTime());
    }
  });
});

describe('read_competitor (golden)', () => {
  for (const c of G.competitor as (Case & { rows: unknown[]; errs: string[]; sha: string })[]) {
    it(c.name, async () => {
      const [rows, errs, sha] = await ii.readCompetitor(fileOf(c), TODAY);
      expect(errs).toEqual(c.errs);
      expect(rows).toEqual(c.rows);
      if (!c.xlsx) expect(sha).toBe(c.sha);
    });
  }
});

describe('load_trend_config (golden)', () => {
  type Fl = { int: number } | { float: string };
  const val = (v: Fl): number => ('int' in v ? v.int : Number(v.float));
  for (const c of G.trend_config as (Case & {
    cfg: { anchor: string; keywords: Record<string, string>; spike: Record<string, Fl> } | null;
    errs: string[];
  })[]) {
    it(c.name, () => {
      const p =
        c.name === 'repo'
          ? ii.KEYWORDS_FILE
          : c.missing
            ? join(tmp, 'missing.json')
            : fileOf({ ...c, file: 'kw.json' });
      const [cfg, errs] = ii.loadTrendConfig(p);
      if (TS_STRICTER[`trend_config:${c.name}`]) {
        expect(cfg).toBeNull();
        expect(errs).toEqual(['kw.json: không đọc được (JSONDecodeError)']);
        return;
      }
      expect(errs).toEqual(c.errs);
      if (c.cfg === null) expect(cfg).toBeNull();
      else {
        expect(cfg?.anchor).toBe(c.cfg.anchor);
        expect(Object.fromEntries(cfg?.keywords ?? [])).toEqual(c.cfg.keywords);
        expect(cfg?.spike).toEqual({
          window_weeks: val(c.cfg.spike.window_weeks as Fl),
          ratio: val(c.cfg.spike.ratio as Fl),
          min_delta: val(c.cfg.spike.min_delta as Fl),
        });
      }
    });
  }
});

describe('find_spikes (golden)', () => {
  it('khớp từng chuỗi', () => {
    type Fl = { int: number } | { float: string };
    const n = (v: Fl) => ('int' in v ? v.int : Number(v.float));
    const s = (v: Fl) => ('int' in v ? String(v.int) : v.float);
    for (const c of G.spikes as {
      series: [number, number][];
      window: number;
      ratio: Fl;
      min_delta: Fl;
      out: [number, number, Fl][];
    }[]) {
      const got = ii.findSpikes(c.series, c.window, n(c.ratio), n(c.min_delta));
      expect(got.map((x) => [x.week, x.value, x.median, x.medianStr])).toEqual(
        c.out.map(([w, v, m]) => [w, v, n(m), s(m)]),
      );
    }
  });
});

describe('read_trend (golden)', () => {
  for (const c of G.trend as (Case & {
    kind: string | null;
    rows: unknown[];
    errs: string[];
    sha: string;
  })[]) {
    it(c.name, async () => {
      const [kind, rows, errs, sha] = await ii.readTrend(fileOf(c), CFG);
      expect([kind, errs]).toEqual([c.kind, c.errs]);
      expect(rows).toEqual(c.rows);
      expect(sha).toBe(c.sha);
    });
  }
});

describe('social rules / classify / msg_hash (golden)', () => {
  it('load_social_rules', () => {
    for (const c of G.social_rules as (Case & {
      dpia: boolean | null;
      labels: string[] | null;
      errs: string[];
    })[]) {
      const p = c.name === 'repo' ? ii.RULES_FILE : fileOf({ ...c, file: 'r.json' });
      const [r, errs] = ii.loadSocialRules(p);
      expect(errs, c.name).toEqual(c.errs);
      expect(r === null ? null : r.dpia_signed, c.name).toBe(c.dpia);
      expect(r === null ? null : [...r.labels.keys()].sort(), c.name).toEqual(c.labels);
    }
  });
  it('classify_social', () => {
    for (const [t, labs] of G.classify as [string, string[]][]) {
      expect(ii.classifySocial(t, RULES), t).toEqual(labs);
    }
  });
  it('msg_hash', () => {
    for (const [s, c, k, h] of G.msg_hash as string[][]) {
      expect(ii.msgHash(s as string, c as string, k as string)).toBe(h);
    }
  });
});

type ReadOut = { rows: unknown[]; errs: string[]; sha: string };
describe('read_social (golden)', () => {
  for (const c of G.social as (Case & { f: ReadOut; t: ReadOut })[]) {
    it(c.name, async () => {
      const p = fileOf(c);
      for (const [tag, rules] of [
        ['f', RULES],
        ['t', RULES_T],
      ] as const) {
        const [rows, errs, sha] = await ii.readSocial(p, 'fanpage', rules, NOW);
        expect(errs, tag).toEqual(c[tag].errs);
        expect(rows, tag).toEqual(c[tag].rows);
        expect(sha, tag).toBe(c[tag].sha);
      }
    });
  }
});

describe('social_vendor (golden)', () => {
  for (const c of G.vendor as (Case & { f: ReadOut; t: ReadOut })[]) {
    it(`read_vendor ${c.name}`, async () => {
      const p = fileOf(c, VFIX);
      for (const [tag, rules] of [
        ['f', RULES],
        ['t', RULES_T],
      ] as const) {
        const [rows, errs, sha] = await sv.readVendor(p, rules, NOW);
        expect(errs, tag).toEqual(c[tag].errs);
        expect(rows, tag).toEqual(c[tag].rows);
        expect(sha, tag).toBe(c[tag].sha);
      }
    });
  }
  it('check_approval', () => {
    for (const c of G.approval as (Case & { why: string | null })[]) {
      const p = c.repo
        ? sv.CONFIG_FILE
        : c.missing
          ? join(tmp, 'nope.json')
          : fileOf({ ...c, file: 'sv.json' });
      expect(sv.checkApproval(p), c.name).toBe(c.why);
    }
  });
});

describe('intel_weekly thuần (golden)', () => {
  it('keyword_reasons', () => {
    for (const [q, why] of G.kw_reasons as [string, string[]][]) {
      expect(iw.keywordReasons(q), q).toEqual(why);
    }
  });
  it('load_competitors + competitor_hit', () => {
    type C = {
      name: string;
      raw?: string | null;
      b64?: string | null;
      missing?: boolean;
      error?: string | null;
      comp?: {
        approved: boolean;
        action: string | null;
        by: string | null;
        ref: string | null;
        sha: string;
        terms: string[];
      };
      hits?: [string, string | null][];
    };
    for (const c of G.competitors as C[]) {
      const p =
        c.name === 'repo'
          ? iw.COMPETITORS_FILE
          : c.missing
            ? join(tmp, 'nope_kc.json')
            : fileOf({ name: c.name, file: 'kc.json', raw: c.raw, b64: c.b64 ?? undefined });
      if (c.comp === undefined) {
        expect(() => iw.loadCompetitors(p), c.name).toThrow(iw.KeywordConfigError);
        try {
          iw.loadCompetitors(p);
        } catch (e) {
          expect((e as Error).message, c.name).toBe(c.error);
        }
        continue;
      }
      const comp = iw.loadCompetitors(p);
      expect(
        {
          approved: comp.approved,
          action: comp.action,
          by: comp.by,
          ref: comp.ref,
          sha: comp.sha,
          terms: comp.terms.map(([t]) => t),
        },
        c.name,
      ).toEqual(c.comp);
      for (const [q, h] of c.hits ?? [])
        expect(iw.competitorHit(q, comp), `${c.name} ${q}`).toBe(h);
    }
  });
  it('render_keywords', () => {
    for (const c of G.render_keywords as unknown as {
      res: Parameters<typeof iw.renderKeywords>[0];
      out: string;
    }[]) {
      expect(iw.renderKeywords(c.res)).toBe(c.out);
    }
  });
  it('_md / _vnd / _fold_kw / _bare / week_bounds', () => {
    for (const [s, a, b] of G.md as [unknown, string, string][]) {
      expect([iw.md(s), iw.md(s, 5)]).toEqual([a, b]);
    }
    for (const [n, s] of G.vnd as [number | null, string][]) expect(iw.vnd(n)).toBe(s);
    for (const [q, f, b] of G.fold_bare as string[][]) {
      expect([iw.foldKw(q as string), iw.bare(q as string)]).toEqual([f, b]);
    }
    for (const [d, [mon, sun, start, end]] of G.week_bounds as [string, string[]][]) {
      const w = iw.weekBounds(d);
      expect([w.mon, w.sun, w.start.getTime(), w.end.getTime()]).toEqual([
        mon,
        sun,
        new Date(start as string).getTime(),
        new Date(end as string).getTime(),
      ]);
    }
  });
});
