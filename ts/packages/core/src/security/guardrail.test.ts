import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPath } from '../paths.js';
import golden from './__fixtures__/guardrail.golden.json' with { type: 'json' };
import { decodeArg, pyDumps, sameAsGolden } from './golden.js';
import {
  check,
  checkPublish,
  type GuardrailResult,
  type PublishOpts,
  readiness,
  readinessKey,
  setGuardrailDataDir,
  withViolation,
} from './guardrail.js';
import { setKbFiles } from './kb-filter.js';

// Golden: đầu vào = mọi lời gọi guardrail.check/check_publish/readiness trong test Python
// (test_guardrail*, test_v13_c01/test_v14_p1 pii_guardrail, test_r12fix_d2_l3, test_kb_filter, …)
// + toàn bộ data/eval/redteam.jsonl; đầu ra = hàm Python THẬT, cấu hình data/ mặc định.
type Case = { fn: string; args: unknown[]; kwargs: Record<string, unknown>; out: unknown };

function opts(kw: Record<string, unknown>): PublishOpts {
  const o: PublishOpts = { channel: kw.channel };
  if ('content_type' in kw) o.contentType = kw.content_type;
  if ('sku' in kw) o.sku = kw.sku;
  if ('is_ai' in kw) o.isAi = kw.is_ai;
  if ('is_sponsored' in kw) o.isSponsored = kw.is_sponsored;
  if ('readiness' in kw) {
    const r = kw.readiness as { __readiness__?: [string, string, string][] } | null;
    o.readiness = (
      r && typeof r === 'object' && '__readiness__' in r
        ? new Map((r.__readiness__ ?? []).map(([s, c, l]) => [readinessKey(s, c), l]))
        : r
    ) as PublishOpts['readiness'];
  }
  return o;
}

function call(c: Case): unknown {
  const a = c.args.map(decodeArg);
  if (c.fn === 'check') return check(a[0]);
  if (c.fn === 'readiness') return readiness(a[0] as string, a[1] as string);
  return checkPublish(a[0], opts(c.kwargs));
}

describe('guardrail ↔ Python (golden)', () => {
  it.each(['check', 'check_publish', 'readiness'])('%s khớp từng ca (ok/violations/…)', (fn) => {
    const cases = (golden as Case[]).filter((c) => c.fn === fn);
    expect(cases.length).toBeGreaterThan(fn === 'readiness' ? 3 : 100);
    const bad = cases
      .map((c) => ({ c, got: call(c) }))
      .filter(({ c, got }) => !sameAsGolden(got, c.out));
    expect(
      bad.slice(0, 3).map(({ c, got }) => ({
        args: JSON.stringify(c.args).slice(0, 200),
        kw: c.kwargs,
        got: pyDumps(got).slice(0, 600),
        want: pyDumps(c.out).slice(0, 600),
      })),
    ).toEqual([]);
  });

  it('red-team: mọi ca có nhãn chặn đều bị chặn (ok=false)', () => {
    const lines = readFileSync(dataPath('eval/redteam.jsonl'), 'utf8').split('\n').filter(Boolean);
    let n = 0;
    for (const line of lines) {
      const d = JSON.parse(line);
      if (!d.text || d.known_gap || !d.code) continue;
      const r = checkPublish(d.text, opts(d.ctx ?? { channel: 'facebook', content_type: 'post' }));
      expect(
        r.violations.map((v) => v.code),
        d.id,
      ).toContain(d.code);
      n++;
    }
    expect(n).toBeGreaterThan(20);
  });
});

const AI = ' Nội dung có sử dụng AI.';
const codes = (r: GuardrailResult, k: 'violations' | 'warnings' = 'violations') =>
  r[k].map((v) => v.code);

describe('withViolation: chỉ CHẶN THÊM, không mutate, không ném lỗi', () => {
  it('thêm block → ok=false; code thiếu luật → critical; rác → ok=false', () => {
    const ok = checkPublish(`Quà biếu gia đình.${AI}`, { channel: 'web' });
    expect(ok.ok).toBe(true);
    const snap = structuredClone(ok);
    const out = withViolation(ok, 'llm_ngam_y_suc_khoe', 'ẩn ý', 'Quà', 0, 3);
    expect(ok).toEqual(snap);
    expect(out).not.toBe(ok);
    expect(out.ok).toBe(false);
    const v = out.violations.at(-1);
    expect(v && [v.severity, v.span, v.start, v.end, v.type]).toEqual([
      'major',
      'Quà',
      0,
      3,
      'llm_ngam_y_suc_khoe',
    ]);
    const bad = checkPublish(`Savina chữa ho.${AI}`, { channel: 'web' });
    const out2 = withViolation(bad, 'llm_check_unavailable', 'lỗi');
    expect(out2.ok).toBe(false);
    expect(out2.violations.slice(0, bad.violations.length)).toEqual(bad.violations);
    expect(withViolation(ok, 'khong_co_luat', 'x').violations.at(-1)?.severity).toBe('critical');
    for (const junk of [null, 'x', { ok: 'true' }, { ok: 1, violations: 'x' }]) {
      const r = withViolation(junk, 'llm_check_unavailable', 'x');
      expect(r.ok).toBe(false);
      expect(r.violations.at(-1)?.code).toBe('llm_check_unavailable');
    }
    expect(withViolation(ok, 'x', 'a'.repeat(600)).violations.at(-1)?.detail).toHaveLength(500);
  });
});

describe('readiness map từ view DB (v4.2)', () => {
  const text = `Savigout hỗ trợ giảm acid uric. Thực phẩm này không phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh.${AI}`;
  it('thiếu key = CAM; QC_DAY_DU qua; alias kênh trước khi tra; giá trị lạ → config', () => {
    const r1 = checkPublish(text, { channel: 'web', readiness: new Map() });
    expect(codes(r1)).toContain('sku_chua_xnqc');
    const full = new Map([[readinessKey('savigout-30v', 'web'), 'QC_DAY_DU']]);
    expect(codes(checkPublish(text, { channel: 'blog', readiness: full }))).not.toContain(
      'sku_chua_xnqc',
    );
    for (const bad of [new Map([[readinessKey('savigout-30v', 'web'), 'XX']]), { a: 1 }, 'x']) {
      const r = checkPublish(text, { channel: 'web', readiness: bad as PublishOpts['readiness'] });
      expect(r.ok).toBe(false);
      expect(codes(r)).toEqual(['config']);
    }
  });
});

describe('guardrail fail-closed khi cấu hình thiếu/hỏng (Python tmp_data)', () => {
  const FILES = [
    'banned_words.txt',
    'claims_whitelist.json',
    'golden_skus.json',
    'guardrail_rules.json',
    'llm_gateway.json',
  ];
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grd-'));
    for (const f of FILES) copyFileSync(dataPath(f), join(dir, f));
    setGuardrailDataDir(dir);
  });
  afterEach(() => {
    setGuardrailDataDir();
    setKbFiles({ keywords: dataPath('ruou_keywords.txt') });
    rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => setGuardrailDataDir());

  const rules = () => JSON.parse(readFileSync(join(dir, 'guardrail_rules.json'), 'utf8'));
  type Rules = {
    families: Record<string, { aliases: string[]; golden_skus: string[] }>;
    ngoc_linh: { terms: string[] };
    rules: Record<string, { mode: string }>;
  };
  const writeRules = (mut: (d: Rules) => void) => {
    const d = rules();
    mut(d);
    writeFileSync(join(dir, 'guardrail_rules.json'), JSON.stringify(d));
    setGuardrailDataDir(dir);
  };
  const expectConfig = (r: GuardrailResult, part: string) => {
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['config']);
    expect(r.violations[0].detail).toContain(part);
  };

  it.each(FILES.slice(0, 4))('thiếu %s → config, không ném lỗi', (f) => {
    rmSync(join(dir, f));
    setGuardrailDataDir(dir);
    expectConfig(
      check('xin chào'),
      f.endsWith('.txt') || f.startsWith('claims') ? 'thiếu file config' : 'FileNotFoundError',
    );
    expectConfig(checkPublish('xin chào', { channel: 'web' }), 'trong');
  });

  it('banned rỗng / chỉ comment → fail-closed; JSON hỏng → config', () => {
    writeFileSync(join(dir, 'banned_words.txt'), '# chỉ comment\n\n');
    setGuardrailDataDir(dir);
    expectConfig(check('thuốc'), 'banned_words.txt rỗng — fail-closed');
    copyFileSync(dataPath('banned_words.txt'), join(dir, 'banned_words.txt'));
    writeFileSync(join(dir, 'guardrail_rules.json'), '{hỏng');
    setGuardrailDataDir(dir);
    expectConfig(check('xin chào'), 'file luật guardrail/golden không dùng được (JSONDecodeError)');
  });

  it('family có SKU mà alias rỗng / SKU mồ côi / golden 0 SKU / thiếu cụm Ngọc Linh → config', () => {
    writeRules((d) => {
      d.families.savigout.aliases = [' '];
    });
    expectConfig(check('x'), '(ValueError)');
    writeRules((d) => {
      d.families.savigout.golden_skus = [];
    });
    expectConfig(check('x'), '(ValueError)');
    writeRules((d) => {
      d.ngoc_linh.terms = ['  '];
    });
    expectConfig(check('x'), '(ValueError)');
    copyFileSync(dataPath('guardrail_rules.json'), join(dir, 'guardrail_rules.json'));
    writeFileSync(join(dir, 'golden_skus.json'), JSON.stringify({ skus: [] }));
    setGuardrailDataDir(dir);
    expectConfig(check('x'), '(ValueError)');
  });

  it('code thiếu luật → critical block; mode warn → vào warnings, ok giữ', () => {
    writeRules((d) => {
      delete d.rules.tu_cam;
      d.rules.llm_check_unavailable.mode = 'warn';
    });
    const r = check('Sản phẩm là thuốc');
    expect(r.ok).toBe(false);
    expect(r.violations[0].severity).toBe('critical');
    const ok = checkPublish(`Quà biếu gia đình.${AI}`, { channel: 'web' });
    const out = withViolation(ok, 'llm_check_unavailable', 'timeout');
    expect(out.ok).toBe(true);
    expect(codes(out, 'warnings')).toEqual(['llm_check_unavailable']);
    const blocked = { ok: false, violations: [{ code: 'tu_cam' }], warnings: [] };
    expect(withViolation(blocked, 'llm_check_unavailable', 'x').ok).toBe(false);
  });

  it('bộ lọc rượu hỏng → violation config, không ném lỗi', () => {
    setKbFiles({ keywords: join(dir, 'khong_co.txt') });
    const r = check('xin chào');
    expect(r.ok).toBe(false);
    expect(r.violations[0].detail).toContain('bộ lọc rượu không dùng được');
  });

  it('claim whitelist sai kiểu → lỗi nội bộ fail-closed, không ném', () => {
    writeFileSync(
      join(dir, 'claims_whitelist.json'),
      JSON.stringify({ savina: { approved_claims: [1] } }),
    );
    setGuardrailDataDir(dir);
    expectConfig(check('xin chào'), 'guardrail lỗi nội bộ (TypeError) — fail-closed');
  });
});

describe('guardrail: offset theo code point, đầu vào lạ', () => {
  it('emoji trước từ cấm: start/end như Python (code point)', () => {
    const r = check('\u{1f33f}\u{1f33f} thuốc');
    const v = r.violations.find((x) => x.code === 'tu_cam');
    expect([v?.start, v?.end, v?.span]).toEqual([3, 8, 'thuốc']);
  });

  it('chữ toán học astral (𝐭𝐡𝐮ố𝐜) bị bắt như Python', () => {
    const r = check('Sản phẩm là \u{1d42d}\u{1d421}\u{1d42e}ố\u{1d41c}');
    expect(codes(r)).toContain('tu_cam');
    expect(r.violations[0].span).toBe('\u{1d42d}\u{1d421}\u{1d42e}ố\u{1d41c}');
  });

  it('không phải chuỗi / rỗng / dài bệnh lý', () => {
    expect(check(null).ok).toBe(true);
    expect(check(12345).ok).toBe(true);
    const t0 = performance.now();
    check('người '.repeat(6000));
    checkPublish('('.repeat(20_000), { channel: 'web' });
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});
