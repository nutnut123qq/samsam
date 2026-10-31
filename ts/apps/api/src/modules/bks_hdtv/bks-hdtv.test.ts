import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, dep, resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { type FakeState, installFakeDeps } from '@samsam/core/ops/testing';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import ts from 'typescript';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as A from './bks-audit.js';
import {
  bksAuditMain,
  bksReconMain,
  type CliDeps,
  hdtvReportMain,
  type Io,
} from './bks-hdtv.command.js';
import * as H from './hdtv-report.js';

// Dịch phần KHÔNG cần DB của tests/test_bks_audit.py, test_bks_recon.py, test_hdtv_report.py,
// test_v14_p3_rollout_edges.py: tham số sai → exit 2 TRƯỚC connect, DB down → 2 không ghi file,
// cấu hình hỏng → 1 trước connect, guard CHỈ-ĐỌC (đúng 1 đường ghi `insert into audit_runs`),
// grounding fail-closed của gói HĐTV, cổng rollout TẮT (sổ lần chạy/gói HĐTV không ghi).

const NOW = new Date('2026-10-14T09:00:00+07:00');
const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'bks-hdtv-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function capture(): Io & { o: string[]; e: string[] } {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, out: (s) => o.push(s), err: (s) => e.push(s) };
}

const noConnect: CliDeps['connect'] = async () => {
  throw new Error('không được connect');
};

/** Rollout giả: tính năng `tat` → RolloutBlocked (lớp thật) ở cả biên sinh lẫn báo cáo. */
function fakeRollout(stages: Record<string, string> = {}): FakeState {
  const st = installFakeDeps(
    {},
    {
      quick: null,
      stages: { 'ceo-04.6': 'van_hanh', 'ceo-05': 'van_hanh', ...stages },
      reportFeature: (n) => (n.startsWith('bks-') ? 'ceo-04.6' : null),
    },
  );
  const base = dep('rollout');
  const wrap =
    <T extends unknown[], R>(fn: (...a: T) => Promise<R> | R) =>
    async (...a: T): Promise<R> => {
      try {
        return await fn(...a);
      } catch (e) {
        throw new RolloutBlocked((e as Error).message);
      }
    };
  setOpsDeps({
    rollout: {
      ...base,
      checkGenerate: wrap(base.checkGenerate),
      gateReport: wrap(base.gateReport),
    },
  });
  return st;
}

type Q = { text: string; values: unknown[] };
/** DB giả ghi mọi câu SQL; `answer` trả dòng (mảng — rowMode array — hoặc object). */
function fakeDb(answer: (q: Q) => unknown[] = () => []): { db: Db; log: Q[] } {
  const log: Q[] = [];
  const db = {
    query: async (q: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const x =
        typeof q === 'string'
          ? { text: q, values: values ?? [] }
          : { text: q.text, values: q.values ?? [] };
      log.push(x);
      const rows = answer(x);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
  return { db, log };
}

beforeEach(() => {
  fakeRollout();
});
afterEach(() => resetOpsDeps());

// ------------------------------------------------------------------ CLI trước connect

describe('bks-audit CLI', () => {
  const cases: [string, Parameters<typeof bksAuditMain>[0]][] = [
    ['--report --dry-run --record', { report: true, dryRun: true, record: true }],
    ['(trống)', {}],
    ['--report --now x', { report: true, now: 'x' }],
    ['--chain-alert --report', { chainAlert: true, report: true }],
    ['--chain-alert --month', { chainAlert: true, month: '2026-09' }],
  ];
  for (const [name, o] of cases) {
    it(`tham số sai → exit 2 trước connect: ${name}`, async () => {
      const io = capture();
      expect(await bksAuditMain(o, { io, connect: noConnect, now: NOW })).toBe(2);
      expect(io.e.join('\n')).toMatch(/^bks-audit: error: /);
    });
  }
  for (const month of ['2026-10', '2026-13', '2026-9']) {
    it(`kỳ chưa đóng/sai ${month} → exit 2 trước connect`, async () => {
      const io = capture();
      expect(
        await bksAuditMain({ report: true, month }, { io, connect: noConnect, now: NOW }),
      ).toBe(2);
      expect(io.e[0]).toMatch(/^\[error\] /);
    });
  }
  it('DB down → exit 2, không ghi file', async () => {
    const io = capture();
    const out = join(tmp, 'audit-down');
    const rc = await bksAuditMain(
      { report: true, outDir: out },
      { io, connect: async () => null, now: NOW },
    );
    expect(rc).toBe(2);
    expect(io.e[0]).toContain('không kết nối');
    expect(existsSync(out)).toBe(false);
  });
  it('--chain-alert DB down → exit 2', async () => {
    const io = capture();
    expect(await bksAuditMain({ chainAlert: true }, { io, connect: async () => null })).toBe(2);
  });
});

// r22 A3: fp hex có dãy giống SĐT (84 + ≥8 số) → raiseAlert che khi lưu; khóa chống lặp vẫn phải khớp.
describe('chainAlert: fp bị che khi lưu vẫn chống lặp', () => {
  const FP = '4d5775af4d885d729cb5638f43f38b85828d0397554326314dc04ffa15f91e43';
  const FP_MASKED = '4d5775af4d885d729cb5638f43f38b85828d***dc04ffa15f91e43';
  /** DB giả: 1 phát hiện cố định; `stored` = detail.fp của red_alerts — so như SQL (= / in). */
  const world = (stored: string[]) =>
    fakeDb(({ text, values }) => {
      if (text.includes('from verify_action_log()')) return [[18, 'row_hash lệch']];
      if (text.startsWith('select count(*), max(id)')) return [[0, null]];
      if (text.includes("detail ->> 'fp'"))
        return stored.some((s) => values.slice(1).includes(s)) ? [[1]] : [];
      if (text.startsWith('insert into red_alerts')) {
        stored.push(JSON.parse(values[2] as string).fp);
        return [{ id: String(stored.length) }];
      }
      if (text.startsWith('select max(id) from red_alerts')) return [[stored.length]];
      return [];
    }).db;

  it('3 lần chạy → 1 cảnh báo; dòng cũ đã che → không mở thêm', async () => {
    setOpsDeps({ maskPii }); // maskPii THẬT như wireCore — fake identity che mất lỗi
    expect(
      A.fingerprint([
        { code: 'chuoi_bi_sua', table: 'agent_action_log', id: 18, problem: 'row_hash lệch' },
      ]),
    ).toBe(FP);
    const stored: string[] = [];
    const db = world(stored);
    const rs: A.ChainResult[] = [];
    for (let i = 0; i < 3; i++) rs.push(await A.chainAlert(db, {}));
    expect(rs.map((r) => r.dup)).toEqual([false, true, true]);
    expect(stored).toEqual([FP_MASKED]);
    const old = [FP_MASKED];
    expect((await A.chainAlert(world(old), {})).dup).toBe(true);
    expect(old).toEqual([FP_MASKED]);
  });
});

describe('bks-recon CLI', () => {
  const cases: [string, Parameters<typeof bksReconMain>[0]][] = [
    ['(trống)', {}],
    ['--record --dry-run', { month: '2026-09', record: true, dryRun: true }],
    ['--seed -1', { month: '2026-09', seed: '-1' }],
    ['--seed 2^63', { month: '2026-09', seed: String(2n ** 63n) }],
    ['--seed x', { month: '2026-09', seed: 'x' }],
    ['--now x', { month: '2026-09', now: 'x' }],
  ];
  for (const [name, o] of cases) {
    it(`tham số sai → exit 2 trước connect: ${name}`, async () => {
      const io = capture();
      expect(await bksReconMain(o, { io, connect: noConnect, now: NOW })).toBe(2);
    });
  }
  it('kỳ chưa đóng → 2; phí hỏng → 1 (không connect); DB down → 2 không file', async () => {
    let io = capture();
    expect(await bksReconMain({ month: '2026-10' }, { io, connect: noConnect, now: NOW })).toBe(2);
    const bad = join(tmp, 'fees.json');
    writeFileSync(bad, '{"shopee": {}}');
    io = capture();
    expect(
      await bksReconMain({ month: '2026-09' }, { io, connect: noConnect, now: NOW, feesFile: bad }),
    ).toBe(1);
    expect(io.e[0]).toMatch(/— không connect\.$/);
    io = capture();
    const out = join(tmp, 'recon-down');
    expect(
      await bksReconMain(
        { month: '2026-09', outDir: out },
        { io, connect: async () => null, now: NOW },
      ),
    ).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe('hdtv-report CLI', () => {
  for (const o of [
    { month: '2026-10' },
    { quarter: '2026-Q4' },
    { quarter: '2026-Q5' },
    { month: '2026-13' },
  ]) {
    it(`kỳ chưa đóng/sai ${JSON.stringify(o)} → exit 2 trước connect`, async () => {
      const io = capture();
      expect(await hdtvReportMain(o, { io, connect: noConnect, now: NOW })).toBe(2);
    });
  }
  for (const o of [{}, { month: '2026-09', quarter: '2026-Q3' }, { now: 'x' }]) {
    it(`tham số sai ${JSON.stringify(o)} → exit 2`, async () => {
      const io = capture();
      expect(await hdtvReportMain(o, { io, connect: noConnect, now: NOW })).toBe(2);
    });
  }
  it('cấu hình hỏng → 1 trước connect; DB down → 2', async () => {
    const bad = join(tmp, 'hdtv.json');
    writeFileSync(bad, '{"quarter_agg": {"sales.gmv_vnd": "avg"}}');
    let io = capture();
    expect(
      await hdtvReportMain(
        { month: '2026-09' },
        { io, connect: noConnect, now: NOW, configFile: bad },
      ),
    ).toBe(1);
    io = capture();
    const out = join(tmp, 'hdtv-down');
    expect(
      await hdtvReportMain(
        { month: '2026-09', outDir: out },
        { io, connect: async () => null, now: NOW },
      ),
    ).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});

describe("--now '' = không truyền (Python `if a.now`) → chạy tiếp tới connect", () => {
  const down: CliDeps = { connect: async () => null, now: NOW };
  const runs: [string, (io: Io) => Promise<number>][] = [
    ['bks-audit', (io) => bksAuditMain({ report: true, now: '' }, { ...down, io })],
    ['bks-recon', (io) => bksReconMain({ month: '2026-09', now: '' }, { ...down, io })],
    ['hdtv-report', (io) => hdtvReportMain({ month: '2026-09', now: '' }, { ...down, io })],
  ];
  for (const [name, run] of runs) {
    it(name, async () => {
      const io = capture();
      expect(await run(io)).toBe(2);
      expect(io.e.join('\n')).toContain('không kết nối');
      expect(io.e.join('\n')).not.toContain('--now');
    });
  }
});

// Python test_cli_dead_host_subprocess: DATABASE_URL host chết qua `connectDatabaseUrl` THẬT (không
// giả `connect`) → exit 2 + "không kết nối", không treo, không ghi file.
describe('DB down thật (host chết)', () => {
  const env = { DATABASE_URL: 'postgresql://u@10.255.255.1:5432/x' };
  it('bks-audit --report', { timeout: 30_000 }, async () => {
    const io = capture();
    const out = join(tmp, 'dead-audit');
    expect(await bksAuditMain({ report: true, outDir: out }, { io, env, now: NOW })).toBe(2);
    expect(io.e.join('\n')).toContain('không kết nối');
    expect(existsSync(out)).toBe(false);
  });
  it('hdtv-report --month', { timeout: 30_000 }, async () => {
    const io = capture();
    const out = join(tmp, 'dead-hdtv');
    expect(await hdtvReportMain({ month: '2026-09', outDir: out }, { io, env, now: NOW })).toBe(2);
    expect(io.e.join('\n')).toContain('không kết nối');
    expect(existsSync(out)).toBe(false);
  });
});

// ------------------------------------------------------------------ gói HĐTV (DB giả)

/** 7 mục giả (mục i trả `lines(i)`), không đọc DB. */
function fakeSections(lines: (i: number, pack: H.Pack) => string[]): [string, H.SectionFn][] {
  return H.SECTION_HEADS.map((head, i) => [
    `sec_${i}`,
    async (_db, pack) => (i === 0 ? [head, ''] : [head, '', ...lines(i, pack)]),
  ]);
}

describe('hdtv build/render (DB giả)', () => {
  it('số literal trong template mục → render ném UngroundedNumber (fail-closed)', async () => {
    const { db } = fakeDb();
    const secs = fakeSections((i, p) =>
      i === 6 ? ['- Tỷ lệ tuân thủ 987654 điểm'] : [`- ${p.fact(i * 11, 'src')} việc`],
    );
    const pack = await H.build(db, '2026-09', NOW, { cfg: { quarter_agg: {} }, sections: secs });
    expect(() => H.render(pack)).toThrow(H.UngroundedNumber);
    expect(() => H.render(pack)).toThrow('987654');
  });

  it('mục lỗi → 1 dòng "không đọc được", fact của mục hỏng không tính, mục khác vẫn ra', async () => {
    const { db } = fakeDb();
    const secs = fakeSections((i, p) => {
      if (i === 3) {
        p.fact('424242', 'src');
        throw new RangeError('data/fpa_config.json: hỏng 0905123456');
      }
      return [`- ${p.fact(i, 'src')} việc`];
    });
    const pack = await H.build(db, '2026-09', NOW, { cfg: { quarter_agg: {} }, sections: secs });
    expect(pack.unreadable).toBe(1);
    expect(pack.facts.some((f) => f.text === '424242')).toBe(false);
    const [text, ok] = H.finalize(pack);
    expect(ok).toBe(true);
    expect(text.split('không đọc được').length - 1).toBe(1);
    expect(text).toContain('*(không đọc được: ValueError: data/fpa_config.json: hỏng');
    expect(text).not.toContain('0905123456');
    expect(text).toContain('- 6 việc');
  });

  it('guardrail vi phạm → dòng CẢNH BÁO đầu trang, ok=false', async () => {
    setOpsDeps({ guardrailCheck: () => ({ ok: false, violations: [{ type: 'banned_word' }] }) });
    const { db } = fakeDb();
    const pack = await H.build(db, '2026-09', NOW, {
      cfg: { quarter_agg: {} },
      sections: fakeSections(() => ['- (không có)']),
    });
    const [text, ok] = H.finalize(pack);
    expect(ok).toBe(false);
    expect(text).toContain('CẢNH BÁO GUARDRAIL');
    expect(text).toContain('banned_word');
  });
});

// ------------------------------------------------------------------ cổng rollout TẮT (sổ lần chạy)

describe('recordRun — cổng triển khai', () => {
  it('ceo-04.6 TẮT → RolloutBlocked, không INSERT (inside_out lẫn recon)', async () => {
    fakeRollout({ 'ceo-04.6': 'tat' });
    const { db, log } = fakeDb();
    for (const kind of ['inside_out', 'recon']) {
      await expect(A.recordRun(db, kind, '2026-09', {}, 0, 'x', 'agent:bks_audit')).rejects.toThrow(
        RolloutBlocked,
      );
    }
    expect(log).toEqual([]);
  });
  it('chạy thử → ghi, cờ is_sample theo provenance; params bigint giữ nguyên chữ số', async () => {
    fakeRollout({ 'ceo-04.6': 'chay_thu' });
    const { db, log } = fakeDb((q) => (q.text.startsWith('insert') ? [{ id: '7' }] : []));
    const rid = await A.recordRun(
      db,
      'recon',
      '2026-09',
      { seed: 2n ** 63n - 1n, n_total: 3 },
      0,
      'x',
      'agent:bks_recon',
      true,
    );
    expect(rid).toBe('7');
    expect(log[0]?.text).toMatch(/^insert into audit_runs /);
    expect(log[0]?.values[2]).toBe('{"seed":9223372036854775807,"n_total":3}');
    expect(log[0]?.values[6]).toBe(true);
    expect(log[1]?.text).toBe('commit');
  });
  it('hdtv-report: ceo-05 TẮT → [blocked] exit 2, không file/sổ/hàng', async () => {
    fakeRollout({ 'ceo-05': 'tat' });
    const { db, log } = fakeDb();
    const io = capture();
    const out = join(tmp, 'hdtv-off');
    const rc = await hdtvReportMain(
      { month: '2026-09', outDir: out, record: true, submit: true },
      { io, connect: async () => ({ db, release: async () => {} }), wire: () => {}, now: NOW },
    );
    expect(rc).toBe(2);
    expect(io.e.join('\n')).toContain('[blocked]');
    expect(existsSync(out)).toBe(false);
    expect(log.filter((q) => /insert|enqueue_item/i.test(q.text))).toEqual([]);
  });
});

// ------------------------------------------------------------------ guard CHỈ-ĐỌC (W100.7)

const MODULES = ['bks-audit.ts', 'bks-recon.ts', 'hdtv-report.ts', 'bks-hdtv.command.ts'];
const PLACEHOLDER = '_X_';
const TBL = '(?:\\w+\\.)?(?:\\w+|"[^"]+"|\\{\\w*\\}|%(?:\\(\\w+\\))?s|\\$\\d+|_X_)';
const BARE_TAIL_RE = /\b(?:update(?:\s+only)?|truncate(?:\s+table)?)\s+$/i;
const WRITE_RE = new RegExp(
  `\\b(insert\\s+into\\b(?:\\s+${TBL})?|update\\s+(?:only\\s+)?${TBL}\\s+set|delete\\s+from|truncate\\s+(?:table\\s+)?${TBL}|(?:alter|drop|create)\\s+(?:or\\s+replace\\s+)?(?:table|role|function|schema|index|trigger|view|sequence|policy)\\b|grant\\s+[\\w ,()]+\\s+(?:on|to)\\b)`,
  'gi',
);
// Không gọi đường ghi/quyết định khác: loader nạp file, duyệt/đổi trạng thái, AI Gateway.
const FORBIDDEN_IMPORTS: [RegExp, RegExp][] = [
  [/settlement-csv|market-csv|core-store|golden-store/, /^(load|reconcile)$/],
  [/ops\/store$/, /^(setStatus|saveDraft|schedule)$/],
  [/ops\/approval-queue$/, /./],
  [/^@samsam\/core\/ai\//, /./],
];

/** Chuỗi hằng trong mã (phần nội suy `${…}` → `_X_`), đã gộp khoảng trắng. */
function sqlStrings(src: string): string[] {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text + n.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join(''));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function importViolations(src: string): string[] {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.ES2022, true);
  const bad: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text.replace(/\.js$/, '');
    const names: string[] = [];
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) {
      for (const e of b.elements) names.push((e.propertyName ?? e.name).text);
    } else if (b) names.push('*');
    if (st.importClause?.name) names.push('default');
    for (const [mod, name] of FORBIDDEN_IMPORTS) {
      if (mod.test(from)) bad.push(...names.filter((x) => name.test(x)).map((x) => `${from}:${x}`));
    }
  }
  return bad;
}

function writeHits(src: string): string[] {
  const strs = sqlStrings(src);
  const hits: string[] = [];
  for (const s of strs) {
    for (const m of s.replace(/\s+/g, ' ').matchAll(WRITE_RE)) hits.push(m[0]);
    const t = BARE_TAIL_RE.exec(s);
    if (t) hits.push(t[0]);
  }
  return hits.filter((h) => !/^insert into audit_runs$/i.test(h.replace(/\s+/g, ' ')));
}

describe('guard chỉ-đọc (W100.7)', () => {
  const srcs = MODULES.map((m) => readFileSync(join(HERE, m), 'utf8'));

  it('chỉ đúng 1 đường ghi `insert into audit_runs`; không loader/duyệt/AI', () => {
    for (const [i, src] of srcs.entries()) {
      expect(writeHits(src), MODULES[i]).toEqual([]);
      expect(importViolations(src), MODULES[i]).toEqual([]);
      expect(src, MODULES[i]).not.toMatch(/\.chat\(|\.embed\(/);
    }
    const all = srcs.flatMap(sqlStrings).map((s) => s.replace(/\s+/g, ' ').toLowerCase());
    expect(all.filter((s) => s.includes('insert into audit_runs')).length).toBe(1);
  });

  // `#{` → `${` (mã nguồn giả có nội suy template).
  const tpl = (x: string): string => x.replaceAll('#{', '$' + '{');
  const injects = [
    'const X = "update approvals set decision = 1";',
    'const X = "delete from agent_action_log";',
    tpl('const X = `truncate #{t} approvals`;'),
    'const X = "grant select on approvals to x";',
    'const X = "insert into approvals values (1)";',
    "import { setStatus } from '@samsam/core/ops/store';",
    "import { load } from '../market/market-csv.js';",
    "import { reconcile } from '../settlement/settlement-csv.js';",
    "import { enqueue } from '@samsam/core/ops/approval-queue';",
    "import { AiGateway } from '@samsam/core/ai/gateway';",
    tpl('const X = `insert into #{t} (a) values (1)`;'),
    tpl('const X = `update #{t} set a = 1`;'),
    'const X = "update public.approvals set a=1";',
    'const X = "insert into public.approvals (a) values (1)";',
    'const X = "insert into audit_runs_x (a) values (1)";',
    "const X = 'update ' + t + ' set a=1';",
    'const X = \'update "approvals" set a=1\';',
    "const X = 'truncate table ' + t;",
    'const X = "update $1 set a = 1";',
  ];
  for (const inj of injects) {
    it(`đột biến bị bắt: ${inj}`, () => {
      const bad = `${srcs[1]}\n${inj}\n`;
      expect(writeHits(bad).length + importViolations(bad).length).toBeGreaterThan(0);
    });
  }
});

describe('override_line (OWASP A03)', () => {
  it('lý do/tên do người nhập không tạo link/HTML/bảng; SĐT bị che', () => {
    const line = A.overrideLine({
      id: 1,
      queue_id: 2,
      block: 'ceo',
      object_type: null,
      created_at: new Date('2026-09-01T00:00:00+07:00'),
      by: 'Mai <b>|</b>',
      reason: 'gọi 0905123456 [x](http://e.vn) `code` ![a](b)',
      q_created_by: null,
      q_decided_by: null,
      q_status: null,
    });
    expect(line).not.toContain('0905123456');
    for (const bad of ['](', '<b>', '`', '|']) expect(line).not.toContain(bad);
  });
});

describe('module NestJS', () => {
  it('đăng ký đủ 3 lệnh, không controller', async () => {
    const { BksHdtvModule } = await import('./bks-hdtv.module.js');
    const providers = Reflect.getMetadata?.('providers', BksHdtvModule) as unknown[] | undefined;
    if (providers) expect(providers.length).toBe(3);
    expect(readdirSync(HERE).some((f) => f.endsWith('.controller.ts'))).toBe(false);
  });
});
