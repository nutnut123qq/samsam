import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { parseShift } from '../ops/period.js';
import G from './__fixtures__/rollout.golden.json' with { type: 'json' };
import GC from './__fixtures__/rollout_cli.golden.json' with { type: 'json' };
import {
  backupRow,
  businessDays,
  CRITERIA,
  catalog,
  checkBy,
  cleanNote,
  convRow,
  countSpec,
  type DossierRow,
  enforceEnabled,
  evaluate,
  evidenceStatus,
  type Feature,
  featureFor,
  featureForReport,
  fileRows,
  holidayWarning,
  isHuman,
  labelReport,
  literal,
  loadFeatures,
  loadShift,
  mode,
  needsReview,
  openExceptions,
  quickMode,
  recordReport,
  renderDossier,
  rolloutCli,
  SEVERE,
  type SevereEvent,
  setConnector,
  settings,
  splitMap,
  summary,
  useReason,
} from './rollout.js';

// Golden sinh bằng hàm Python thật (`pipelines/rollout.py`) trên đầu vào cố định — script ở
// scratchpad (gen_golden.py), không trong repo. TS phải ra y hệt.

const TMP = mkdtempSync(join(tmpdir(), 'rollout-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const REAL = loadFeatures();
const ORIG = { ...settings, env: { ...settings.env } };
const SHIFT = loadShift();
const D = (s: string | null): Date | null => (s === null ? null : new Date(s));
const b64 = (s: string) => Buffer.from(s, 'base64');

function file(name: string, body: Buffer | string): string {
  const p = join(TMP, name);
  writeFileSync(p, body);
  return p;
}

type Res = { ok?: unknown; err?: string; msg?: string };
function run(fn: () => unknown): Res {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).name, msg: (e as Error).message };
  }
}

// Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn = fail-closed): `check_by` gấp tiền tố bằng NFKC — tên dạng
// chữ toàn khổ 'ａｇｅｎｔ:' là agent (Python casefold không gấp → coi là người).
const TS_STRICTER_BY = new Set(['ａｇｅｎｔ:x']);

describe('rollout golden (Python) — danh mục', () => {
  it('literal Postgres = psycopg.sql.Literal', () => {
    for (const [v, want] of G.lit) expect(literal(v), JSON.stringify(v)).toBe(want);
  });

  it('count_spec danh mục thật = Python (DB so `is distinct from` khi --seed)', () => {
    const want = G.count_spec as Record<string, unknown>;
    expect(REAL.map((f) => f.id)).toEqual(Object.keys(want));
    for (const f of REAL) expect(countSpec(f, SHIFT), f.id).toEqual(want[f.id]);
  });

  it('count_spec mọi bảng có bộ đếm + bộ lọc, báo cáo, file, bảng lạ', () => {
    for (const [s, want] of G.count_spec_synth as [Record<string, unknown>, unknown][]) {
      expect(countSpec({ id: 'ceo-01', output_sources: [s] }, SHIFT), JSON.stringify(s)).toEqual(
        want,
      );
    }
    for (const [s, want] of G.needs_review as [Record<string, unknown>, boolean][]) {
      expect(needsReview(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('summary / splitMap danh mục thật', () => {
    const doc = JSON.parse(readFileSync(settings.featuresFile, 'utf8'));
    expect(summary(REAL, doc.so_tinh_nang_hd, doc.so_giai_doan_hd)).toEqual(G.summary);
    expect(splitMap(REAL)).toEqual(G.split_map);
    for (const [feats, c, p, want] of G.summary_cases as [
      Record<string, unknown>[],
      Record<string, number>,
      Record<string, number>,
      unknown,
    ][]) {
      expect(summary(feats, c, p)).toEqual(want);
    }
  });

  it('featureFor / featureForReport trên danh mục thật', () => {
    for (const [a, want] of G.feature_for as [Record<string, unknown>, string | null][]) {
      expect(featureFor(a), JSON.stringify(a)).toBe(want);
    }
    for (const [n, want] of G.feature_for_report as [string, string | null][]) {
      expect(featureForReport(n), n).toBe(want);
    }
  });

  it('loadFeatures: từ chối y hệt Python (thông điệp), nhận đúng tài liệu hợp lệ', () => {
    for (const [doc, want] of G.load_docs as [unknown, Res][]) {
      const p = file('f.json', JSON.stringify(doc));
      const got = run(() => loadFeatures(p).map((f) => f.id));
      if (want.err) {
        expect(got.err, JSON.stringify(want)).toBe('RangeError');
        expect(got.msg).toBe(want.msg);
      } else expect(got.ok).toEqual(want.ok);
    }
    for (const [raw, want] of G.load_raw as [string, Res][]) {
      const p = file('f.json', b64(raw));
      expect(run(() => loadFeatures(p)).msg, raw).toBe(want.msg);
    }
    expect(run(() => loadFeatures(join(TMP, 'missing.json'))).msg).toBe(
      (G.load_missing as Res).msg,
    );
  });

  it('loadShift', () => {
    for (const [raw, want] of G.shift as [string, Res][]) {
      const p = file('c.json', b64(raw));
      const got = run(() => loadShift(p));
      if (want.err) expect(got.msg, raw).toBe(want.msg);
      else {
        const s = got.ok as ReturnType<typeof parseShift>;
        const w = want.ok as {
          start_min: number;
          end_min: number;
          workdays: number[];
          holidays: string[];
        };
        expect([s.startMin, s.endMin, [...s.workdays].sort(), [...s.holidays].sort()]).toEqual([
          w.start_min,
          w.end_min,
          w.workdays,
          w.holidays,
        ]);
      }
    }
  });
});

describe('rollout golden (Python) — cổng, lịch, --by', () => {
  it('evaluate (cổng PL02 mục 1)', () => {
    for (const [args, want] of G.evaluate as [unknown[], unknown][]) {
      const [stage, days, outputs, severe, ...rest] = args as [
        string,
        number,
        number | null,
        number,
        ...number[],
      ];
      expect(evaluate(stage, days, outputs, severe, ...rest), JSON.stringify(args)).toEqual(want);
    }
  });

  it('businessDays theo ngày VN', () => {
    for (const [a, b, s, want] of G.business_days as [string, string, unknown, number][]) {
      expect(businessDays(new Date(a), new Date(b), s ?? SHIFT), `${a} ${b}`).toBe(want);
    }
    expect(() => businessDays('2026-10-12' as never, new Date(), SHIFT)).toThrow(TypeError);
  });

  it('checkBy / cleanNote / isHuman', () => {
    for (const [by, want] of G.check_by as [unknown, Res][]) {
      const got = run(() => checkBy(by));
      if (TS_STRICTER_BY.has(by as string)) {
        expect(want.ok, 'Python nhận').toBeDefined();
        expect(got.err).toBe('RangeError');
      } else if (want.err) expect(got.msg, String(by)).toBe(want.msg);
      else expect(got.ok, String(by)).toBe(want.ok);
    }
    for (const [n, want] of G.clean_note as [unknown, unknown][]) expect(cleanNote(n)).toBe(want);
    for (const [n, want] of G.is_human as [unknown, boolean][])
      expect(isHuman(n), String(n)).toBe(want);
  });

  it('labelReport / holidayWarning / enforceEnabled', () => {
    for (const [n, t, md, fid, want] of G.label_report as [
      string,
      string,
      string | null,
      string | null,
      string,
    ][]) {
      expect(labelReport(n, t, md, fid), `${n} ${md}`).toBe(want);
    }
    for (const [raw, want] of G.holiday_warning as [string | null, string | null][]) {
      const p = raw === null ? join(TMP, 'missing.json') : file('c.json', b64(raw));
      expect(holidayWarning(p)).toBe(want);
    }
    for (const [raw, want] of G.enforce_enabled as [string, boolean][]) {
      expect(enforceEnabled(file('e.json', b64(raw))), raw).toBe(want);
    }
    expect(enforceEnabled(join(TMP, 'missing.json'))).toBe(true);
  });

  it('SEVERE / CRITERIA / bằng chứng repo = Python', () => {
    expect(SEVERE).toEqual(G.severe);
    expect(CRITERIA.map((c) => [c[0], c[1], c[2], c[3].map((e) => [...e])])).toEqual(G.criteria);
    expect(CRITERIA.map((c) => evidenceStatus(c[3]))).toEqual(G.evidence_status_real);
  });
});

describe('rollout golden (Python) — nguồn file', () => {
  const ms = (r: unknown) =>
    Array.isArray(r)
      ? [r[0], r[1] instanceof Date ? r[1].getTime() : Date.parse(r[1] as string)]
      : r;
  afterEach(() => {
    settings.dataDir = ORIG.dataDir;
    settings.env = { ...ORIG.env };
  });

  it('convRow / backupRow', () => {
    for (const [rec, want] of G.conv_row as [Record<string, unknown>, unknown][]) {
      expect(ms(convRow(rec)), JSON.stringify(rec)).toEqual(ms(want));
    }
    for (const [rec, want] of G.backup_row as [Record<string, unknown>, unknown][]) {
      expect(ms(backupRow(rec)), JSON.stringify(rec)).toEqual(ms(want));
    }
  });

  it('fileRows convlog (+.1 xoay vòng) và backup_runs', () => {
    const dir = join(TMP, 'conv');
    mkdirSync(dir, { recursive: true });
    const c = G.file_rows_conv;
    writeFileSync(join(dir, 'conversations.jsonl'), b64(c.main));
    writeFileSync(join(dir, 'conversations.jsonl.1'), b64(c.side));
    settings.dataDir = dir;
    const norm = (rows: unknown[][]) =>
      rows.map(([k, ts, h, u, sha]) => [k, (ts as Date).getTime(), h, u, sha]);
    let [rows, bad, legacy] = fileRows(
      { file: 'conversations.jsonl' },
      new Date(c.since),
      new Date(c.now),
    );
    expect([norm(rows), bad, legacy]).toEqual([
      c.rows.map(([k, ts, h, u, sha]) => [k, Date.parse(ts as string), h, u, sha]),
      c.bad,
      c.legacy,
    ]);
    settings.env = { ...ORIG.env, BACKUP_DIR: '' };
    const bk = G.file_rows_backup;
    const bdir = join(TMP, 'bk');
    mkdirSync(bdir, { recursive: true });
    expect(() =>
      fileRows({ file: 'backup_runs.jsonl' }, new Date(bk.since), new Date(bk.now)),
    ).toThrow('BACKUP_DIR chưa cấu hình');
    settings.env = { ...ORIG.env, BACKUP_DIR: bdir };
    expect(() =>
      fileRows({ file: 'backup_runs.jsonl' }, new Date(bk.since), new Date(bk.now)),
    ).toThrow('không có file');
    writeFileSync(join(bdir, 'backup_runs.jsonl'), b64(bk.main));
    [rows, bad, legacy] = fileRows(
      { file: 'backup_runs.jsonl' },
      new Date(bk.since),
      new Date(bk.now),
    );
    expect([norm(rows), bad, legacy]).toEqual([
      bk.rows.map(([k, ts, h, u, sha]) => [k, Date.parse(ts as string), h, u, sha]),
      bk.bad,
      bk.legacy,
    ]);
  });
});

describe('rollout golden (Python) — hồ sơ', () => {
  it('renderDossier y hệt Python', () => {
    for (const c of G.dossier as Record<string, unknown>[]) {
      const rows = (c.rows as Record<string, unknown>[]).map((r) => ({
        ...r,
        since: D(r.since as string | null),
      })) as DossierRow[];
      const severe = (c.severe as Record<string, unknown>[]).map((e) => ({
        ...e,
        ts: new Date(e.ts as string),
      })) as SevereEvent[];
      const legacy = (c.legacy as Record<string, unknown>[]).map((r) => ({
        ...r,
        since: D(r.since as string | null),
      })) as never;
      const incidents =
        c.incidents === null
          ? null
          : (c.incidents as Record<string, unknown>[]).map((i) => ({
              ...i,
              detected_at: D(i.detected_at as string | null),
              responded: D(i.responded as string | null),
              fixed: D(i.fixed as string | null),
              resolved: D(i.resolved as string | null),
            }));
      const md = renderDossier(
        c.phase as string,
        rows,
        severe,
        c.n_reviewed as number,
        new Date(c.now as string),
        {
          legacy,
          warnings: c.warnings as string[],
          incidents: incidents as never,
          versions: c.versions as Record<string, string> | null,
          exceptions: c.exceptions as string[],
        },
      );
      expect(md).toBe(c.md);
    }
  });

  it('openExceptions danh mục thật', async () => {
    expect(await openExceptions(REAL)).toEqual(G.open_exceptions);
  });
});

describe('cưỡng chế không DB (Python test_rollout_enforce)', () => {
  afterEach(() => {
    settings.forceMode = null;
    settings.configFile = ORIG.configFile;
  });

  it('mode fail-closed khi không có DB; enforce false tường minh → vận hành', async () => {
    settings.configFile = file('on.json', '{"enforce": true, "workdays": [0,1,2,3,4]}');
    expect(quickMode()).toBeNull();
    expect(await mode(null, 'ceo-01')).toBe('chay_thu');
    expect(await mode(null, null)).toBe('chay_thu');
    expect(await useReason(null, 'ceo-01', 'x', true)).toMatch(/đang chạy thử .* không dùng$/);
    settings.configFile = file('off.json', '{"enforce": false, "workdays": [0,1,2,3,4]}');
    expect(await mode(null, 'ceo-01')).toBe('van_hanh');
    expect(await useReason(null, null, 'x', false)).toBeNull();
    settings.forceMode = 'tat';
    expect(await mode(null, 'ceo-01')).toBe('tat');
  });

  it('catalog() danh mục hỏng → null (featureFor không khớp gì)', () => {
    const real = settings.featuresFile;
    try {
      settings.featuresFile = file('bad.json', '{');
      expect(catalog()).toBeNull();
      expect(featureForReport('ceo-risk-x.md')).toBeNull();
    } finally {
      settings.featuresFile = real;
    }
    expect((catalog() as Feature[]).length).toBe(REAL.length);
  });
});

describe('biên sinh/duyệt/dùng + CLI wrapper (giai đoạn ép, không DB)', () => {
  afterEach(() => {
    settings.forceMode = null;
  });

  it('tắt → blocked/checkGenerate/decideReason chặn; cliEntry đổi RolloutBlocked thành exit 2', async () => {
    const { blocked, checkGenerate, cliEntry, decideReason, RolloutBlocked } = await import(
      './rollout.js'
    );
    settings.forceMode = 'tat';
    expect(await blocked(null, 'bản tin', 'ceo-01')).toBe(
      'bản tin: tính năng ceo-01 đang tắt — HĐ 6.7/PL02 mục 1 — không sinh đầu ra',
    );
    expect(await blocked(null, 'x', null, { report: 'ceo-risk-2026.md' })).toMatch(
      /báo cáo ceo-risk-2026.md/,
    );
    expect(await blocked(null, 'x', null, { report: 'khong-thuoc.md' })).toBeNull();
    expect(await blocked(null, 'x', null)).toBeNull(); // không thuộc danh mục → không chặn sinh
    await expect(checkGenerate(null, 'ceo-01', 'x')).rejects.toThrow(RolloutBlocked);
    expect(await decideReason(null, 'ceo-01', 'mục #1')).toMatch(
      /không duyệt mục của tính năng tắt$/,
    );
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      const main = cliEntry(async () => {
        await checkGenerate(null, 'ceo-01', 'lệnh');
        return 0;
      });
      expect(await main()).toBe(2);
    } finally {
      console.log = orig;
    }
    expect(logs[0]).toMatch(/^\[rollout\] lệnh: tính năng ceo-01 đang tắt/);
    settings.forceMode = 'co_nguoi_duyet';
    expect(await decideReason(null, 'ceo-01', 'x')).toBeNull();
    expect(await useReason(null, 'ceo-01', 'gửi', false)).toMatch(
      /chưa được NGƯỜI duyệt từng mục$/,
    );
    expect(await useReason(null, 'ceo-01', 'gửi', true)).toBeNull();
  });
});

describe('CLI không DB (Python test_cli_usage_errors / catalog_no_db / db_down_and_bad_config)', () => {
  const never = async (): Promise<null> => {
    throw new Error('không connect');
  };
  afterEach(() => {
    settings.featuresFile = ORIG.featuresFile;
  });

  it('--catalog in y hệt Python, không mở DB', async () => {
    const logs: string[] = [];
    expect(await rolloutCli({ catalog: true }, never, (s) => logs.push(s))).toBe(GC.catalog.code);
    expect(logs.map((l) => `${l}\n`).join('')).toBe(GC.catalog.out);
    expect(GC.catalog.out).toContain('tách sales-07 → sales-07.1, sales-07.2, sales-07.3');
  });

  it('lỗi tham số → 2 trước khi mở DB; DB down → 2; danh mục hỏng → 2 "cấu hình"', async () => {
    const BY = 'Quản lý AI MẪU';
    for (const o of [
      {},
      { seed: true, status: true },
      { promote: 'ceo-01' },
      { promote: 'ceo-01', by: 'agent:x' },
      { seed: true, by: ' ' },
      { severe: 'ceo-01', by: BY },
      { severe: 'ceo-01', reason: 'khac', by: BY },
      { promote: 'ceo-01', by: BY, reason: 'lo_pii' },
      { promote: 'ceo-01', by: BY, note: 'x' },
      { dossier: true },
      { status: true, phase: 'P1' },
      { status: true, out: 'x' },
      { dossier: true, phase: 'P3' },
      { catalog: true, status: true },
      { catalog: true, phase: 'P1' },
      { reviewOutput: 'ceo-03', by: BY, key: 'k' },
      { reviewOutput: 'ceo-03', by: BY, key: 'k', sha: 'a'.repeat(64), decision: 'ok' },
      { status: true, key: 'k' },
    ]) {
      const errs: string[] = [];
      expect(
        await rolloutCli(
          o,
          never,
          () => {},
          (s) => errs.push(s),
        ),
        JSON.stringify(o),
      ).toBe(2);
      expect(errs.length, JSON.stringify(o)).toBe(1);
    }
    const errs: string[] = [];
    const cli = () =>
      rolloutCli(
        { status: true },
        async () => null,
        () => {},
        (s) => errs.push(s),
      );
    expect(await cli()).toBe(2);
    expect(errs.at(-1)).toContain('DB không kết nối');
    settings.featuresFile = join(TMP, 'missing.json');
    expect(await cli()).toBe(2);
    expect(errs.at(-1)).toContain('cấu hình');
  });
});

describe('recordReport (Python test_report_record_db_down_report_still_written)', () => {
  afterEach(() => {
    settings.forceMode = null;
    setConnector(null);
  });

  it('ép giai đoạn / không thuộc danh mục → false, không mở DB; DB down → false + cảnh báo', async () => {
    const never = async (): Promise<null> => {
      throw new Error('không connect');
    };
    setConnector(never);
    settings.forceMode = 'van_hanh';
    expect(await recordReport('ceo-risk-2026-10-05.md', 'x')).toBe(false);
    settings.forceMode = null;
    expect(await recordReport('khong-thuoc-2026.md', 'x')).toBe(false);
    setConnector(async () => null);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => errs.push(s);
    try {
      expect(await recordReport('ceo-risk-2026-10-05.md', 'x')).toBe(false);
    } finally {
      console.error = orig;
    }
    expect(errs).toEqual([
      '[warn] báo cáo ceo-risk-2026-10-05.md: DB không kết nối được — không ghi sổ đầu ra (không được đếm)',
    ]);
  });
});
