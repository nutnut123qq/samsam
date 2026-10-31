import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { checkPublish, type ReadinessMap, readinessKey } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import F from './__fixtures__/seo_fix.golden.json' with { type: 'json' };
import G from './__fixtures__/seo_san.golden.json' with { type: 'json' };
import { seoSanMain } from './mkt-koc-ugc-seo.command.js';
import * as ss from './seo-san.js';
import { loadRules } from './seo-web.js';

// Dịch phần THUẦN + CLI không DB của tests/test_seo_san.py + cổng TẮT sớm (test_r19_ngay_cong_som.py
// M2). `suggest` so khớp golden sinh từ hàm Python thật (Trends MẪU bịa). Phần DB ở *.db.test.ts.

const RULES = loadRules();
const [LR] = ss.listingRules();
const rdOf = (p: unknown): ReadinessMap | null =>
  p === null
    ? null
    : new Map((p as [string, string, string][]).map(([a, b, v]) => [readinessKey(a, b), v]));
const sg = (c: (typeof G.cases)[number]) => {
  const s = ss.suggest(c.sku, c.channel, c.title, c.related, {
    rules: RULES,
    listingRules: LR as ss.ListingRules,
    readiness: rdOf(c.readiness),
  });
  const g = s.guardrail as { ok?: unknown; violations?: { code?: string; type?: string }[] } | null;
  return {
    ...s,
    guardrail:
      g === null
        ? null
        : {
            ok: g.ok,
            codes: [...new Set((g.violations ?? []).map((v) => v.code || v.type || '?'))].sort(),
          },
  };
};
const byName = (n: string) => G.cases.find((c) => c.name === n) as (typeof G.cases)[number];

afterEach(() => {
  settings.forceMode = null;
});

describe('seo_san — suggest thuần (golden Python)', () => {
  it.each(G.cases.map((c) => [c.name, c]))('%s', (_n, c) => {
    expect(sg(c)).toEqual(c.out);
  });

  it('rượu: SKU rượu từ chối 0 từ khóa; từ khóa rượu bị loại cho mọi SKU', () => {
    for (const n of ['ruou_shopee', 'ruou_tiktok']) {
      const s = sg(byName(n));
      expect(s.refused?.code).toBe('ruou');
      expect([s.keywords, s.title, s.text]).toEqual([[], null, null]);
    }
    for (const n of ['def', 'savina', 'sapentol']) {
      const s = sg(byName(n));
      const rej = Object.fromEntries(s.rejected.map((r) => [r.query, r.codes]));
      expect(rej['rượu nhân sâm']).toEqual(['ruou']);
      expect(rej['trà sâm buổi tối']).toEqual(['ruou']);
      expect((s.text as string).toLowerCase()).not.toContain('rượu');
      expect(isAlcohol(s.title)).toBe(false);
      expect(s.keywords.some((k) => isAlcohol(k))).toBe(false);
      expect(rej['sâm ngọc linh']).toContain('ngoc_linh_chua_xac_nhan');
      expect(rej['sâm chữa ung thư']).toContain('tu_cam');
    }
  });

  it('tất định: chạy lại / đảo thứ tự related cho cùng kết quả; toàn văn qua check_publish', () => {
    expect(sg(byName('def'))).toEqual(sg(byName('rev')));
    const s = sg(byName('def'));
    const g = checkPublish(s.text, {
      channel: 'shopee',
      contentType: 'listing',
      sku: 'saphraton-20v',
      isAi: true,
    });
    expect(g.ok).toBe(true);
    expect(sg(byName('violating')).failed?.codes).toContain('tu_cam');
  });

  it('render báo cáo + sha luật (CRLF→LF) khớp Python', () => {
    const items = G.render_items.map((it) => ({
      ...it,
      suggestion: { ...it.suggestion } as unknown as ss.Suggestion,
    })) as ss.RunItem[];
    expect(ss.render('2026-10-12', items, false)).toBe(G.render.run);
    expect(ss.render('2026-10-13', items, true)).toBe(G.render.dry);
    expect(ss.rulesSha256()).toBe(G.rules_sha);
  });

  it('module không có đường gọi LLM/ghi sàn', () => {
    const src = readFileSync(new URL('./seo-san.ts', import.meta.url), 'utf8');
    for (const bad of ['ai.chat', 'AiGateway', 'fetch(', '.post(', '.put('])
      expect(src).not.toContain(bad);
  });
});

describe('seo_san — CLI không DB', () => {
  function cap() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  }
  const connect = (calls: number[]) => async () => {
    calls.push(1);
    return null;
  };

  it('thiếu --run / kênh lạ → exit 2, không connect', async () => {
    const calls: number[] = [];
    expect(await seoSanMain({}, { io: cap().io, connect: connect(calls) })).toBe(2);
    expect(
      await seoSanMain(
        { run: true, channel: ['lazada'] },
        { io: cap().io, connect: connect(calls) },
      ),
    ).toBe(2);
    expect(calls).toEqual([]);
  });

  it.each([[{ run: true, dryRun: true }], [{ run: true }]])(
    'marketing-07.1 TẮT → 1 dòng [rollout] exit 2, không connect/báo cáo: %j',
    async (o) => {
      settings.forceMode = 'tat';
      const calls: number[] = [];
      const c = cap();
      expect(await seoSanMain(o, { io: c.io, connect: connect(calls), outDir: '/khong/ghi' })).toBe(
        2,
      );
      expect(c.out).toHaveLength(1);
      expect(c.out[0]).toMatch(/^\[rollout\] .*marketing-07\.1/);
      expect(calls).toEqual([]);
    },
  );

  it.each(['chay_thu', 'van_hanh'])('giai đoạn %s: tới connect (DB down → exit 2)', async (st) => {
    settings.forceMode = st;
    const calls: number[] = [];
    const c = cap();
    expect(await seoSanMain({ run: true }, { io: c.io, connect: connect(calls) })).toBe(2);
    expect(calls).toEqual([1]);
  });
});

describe('seo_san — lỗi cấu hình / lỗi chạy như Python', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'seo-san-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it.each(F.listing_rules.map((c) => [c.name, c]))('content._listing_rules %s', (_n, c) => {
    const p = join(tmp, `${c.name}.json`);
    writeFileSync(p, c.raw !== null ? Buffer.from(c.raw, 'hex') : JSON.stringify(c.doc));
    expect(ss.listingRules(p)).toEqual([c.rules, c.err]);
  });

  it('listing_rules.json không có → FileNotFoundError', () => {
    expect(ss.listingRules(join(tmp, 'khong-co.json'))).toEqual([null, F.listing_missing.err]);
  });

  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const failing = (e: unknown) => ({
    connect: async () => ({
      db: {
        query: async () => {
          throw e;
        },
      } as unknown as Db,
      release: async () => {},
    }),
    wire: () => undefined,
  });

  it('RolloutBlocked/ValueError trong run → "[error] <tên Python>: <thông điệp>" exit 1', async () => {
    settings.forceMode = 'van_hanh';
    for (const [e, line] of [
      [
        new RolloutBlocked('marketing-07.1 đang tắt'),
        '[error] RolloutBlocked: marketing-07.1 đang tắt',
      ],
      [new RangeError('x'.repeat(250)), `[error] ValueError: ${'x'.repeat(200)}`],
    ] as const) {
      const c = cap();
      expect(
        await seoSanMain({ run: true, sku: 'mat-ong-sam-300ml' }, { io: c.io, ...failing(e) }),
      ).toBe(1);
      expect(c.err).toEqual([line]);
    }
  });

  it('OSError trong run KHÔNG bắt (Python chỉ bắt psycopg.Error/ValueError)', async () => {
    settings.forceMode = 'van_hanh';
    const e = Object.assign(new Error('EACCES'), { code: 'EACCES', syscall: 'open', path: 'x' });
    await expect(
      seoSanMain({ run: true, sku: 'mat-ong-sam-300ml' }, { io: cap().io, ...failing(e) }),
    ).rejects.toBe(e);
  });
});
