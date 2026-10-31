import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { type ReadinessMap, readinessKey } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Draft } from '../kd_orders_care/shared.js';
import G from './__fixtures__/mkt_koc.golden.json' with { type: 'json' };
import * as mk from './mkt-koc.js';
import { type CliDeps, mktKocMain } from './mkt-koc-ugc-seo.command.js';
import { missingClauses } from './shared.js';

// Dịch phần THUẦN + CLI không DB của tests/test_mkt_koc.py + cổng TẮT sớm (tests/test_r19_ngay_cong_som.py
// M2). Kết quả so khớp golden sinh từ hàm Python thật (__fixtures__/mkt_koc.golden.json). Phần DB ở
// mkt-koc-ugc-seo.db.test.ts.

// Python test đọc bằng `read_text` (newline phổ quát: CRLF → LF) — checkout Windows có thể là CRLF.
const readText = (rel: string) => readFileSync(repoPath(rel), 'utf8').replace(/\r\n?/g, '\n');
const CONTRACT = readText('docs/legal/mau-hop-dong-koc-NHAP.md');
const THIEU = readText('tests/fixtures/mkt/hop-dong-koc-thieu-MAU.md');
const ref = (t: string | null) => (t === '@CONTRACT' ? CONTRACT : t === '@THIEU' ? THIEU : t);
const rdOf = (p: unknown): ReadinessMap | null =>
  p === null
    ? null
    : new Map((p as [string, string, string][]).map(([a, b, v]) => [readinessKey(a, b), v]));
const tmp = mkdtempSync(join(tmpdir(), 'mkt-koc-'));

afterEach(() => {
  settings.forceMode = null;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('mkt_koc — danh sách KOC MẪU + hợp đồng (golden Python)', () => {
  it('koc_sample.json không PII, đúng 3 mã MẪU, KOC-MAU-03 trỏ hợp đồng thiếu', () => {
    const raw = readFileSync(repoPath('data/koc_sample.json'), 'utf8');
    expect(maskPii(raw)).toBe(raw);
    const doc = JSON.parse(raw);
    expect(doc._doc).toContain('MẪU');
    expect(doc._doc).toContain('không phải KOC thật');
    for (const k of doc.kocs) {
      for (const bad of ['phone', 'email', 'name', 'handle', 'sdt'])
        expect(k).not.toHaveProperty(bad);
      expect(k.contract_status).toBe('NHAP_MAU');
    }
    expect(mk.loadKocs()).toEqual(G.kocs);
    expect(mk.loadKocs().map((k) => k.code)).toEqual(['KOC-MAU-01', 'KOC-MAU-02', 'KOC-MAU-03']);
  });

  it.each(G.load.map((c, i) => [i, c]))('load_kocs fail-closed #%s', (i, c) => {
    const p = join(tmp, `k${i}.json`);
    rmSync(p, { force: true });
    if (c.doc !== null) writeFileSync(p, typeof c.doc === 'string' ? c.doc : JSON.stringify(c.doc));
    const out = c.out as { ok?: unknown; err?: string };
    if (out.err !== undefined) {
      expect(() => mk.loadKocs(p)).toThrow(mk.KocConfigError);
      expect(() => mk.loadKocs(p)).toThrow(out.err);
    } else expect(mk.loadKocs(p)).toEqual(out.ok);
  });

  it.each(['C:/a.md', 'C:a.md', '\\\\srv\\chia\\a.md', '/a.md', 'a\\..\\..\\b.md', '../a.md'])(
    'r20: luật contract_file Windows cho MỌI OS: %s',
    (cf) => {
      const p = join(tmp, 'posix.json');
      writeFileSync(
        p,
        JSON.stringify({
          _doc: 'x',
          kocs: [
            {
              code: 'KOC-MAU-01',
              platform: 'tiktok',
              niche: 'a',
              contract_file: cf,
              contract_status: 'NHAP_MAU',
            },
          ],
        }),
      );
      expect(() => mk.loadKocs(p)).toThrow(/contract_file/);
    },
  );

  it('load_contract: trong repo đọc được; ngoài repo / thiếu / sai đuôi → lỗi', () => {
    for (const c of G.contracts) {
      const [text, sha, err] = mk.loadContract(c.rel);
      expect([c.rel, text !== null, err]).toEqual([c.rel, c.has_text, c.err]);
      // sha = sha256 chữ (như Python) — đổi theo nội dung AGENTS.md và CRLF/LF của checkout nên không ghim golden
      expect(sha).toBe(text === null ? null : createHash('sha256').update(text).digest('hex'));
    }
  });

  it('missing_clauses (contract_check v4.4) khớp Python', () => {
    for (const c of G.clauses) {
      const t = ref(c.text) as string;
      expect(missingClauses(t, 'koc')).toEqual(c.koc);
      expect(missingClauses(t, 'dai_ly')).toEqual(c.dai_ly);
    }
  });

  it('_ids khớp Python', () => {
    for (const [s, want] of G.ids) {
      const got = mk.parseIds(s as string);
      expect([s, got === null ? null : got.map(Number)]).toEqual([s, want]);
    }
  });
});

describe('mkt_koc — build_kit thuần (golden Python)', () => {
  const golden = new Map<string, { category: unknown }>([
    ['mat-ong-sam-300ml', { category: 'food' }],
    ['savigout-30v', { category: 'tpbvsk' }],
    ...['saphraton-20v', 'saphraton-combo-2x20v', 'saphraton-40v', 'saphraton-80v'].map(
      (k) => [k, { category: 'tpbvsk' }] as [string, { category: unknown }],
    ),
    ...['ruou-sam-chai-thuy-tinh-500ml', 'ruou-sam-binh-su-do-500ml'].map(
      (k) => [k, { category: 'alcohol' }] as [string, { category: unknown }],
    ),
  ]);
  it.each(G.kits.map((c) => [c.name, c]))('%s', (_n, c) => {
    const res = mk.buildKit(c.koc as mk.Koc, c.sku, c.channel, c.drafts as Draft[], golden, {
      readiness: rdOf(c.readiness),
      contractText: ref(c.contract),
      contractErr: c.contract_err,
    });
    const want = Object.fromEntries(Object.entries(c.out).filter(([, v]) => v !== undefined));
    expect(res).toEqual(want);
  });

  it('kit đạt: brief nguyên văn, nhãn #quangcao + AI, link/mã PLACEHOLDER, sha hợp đồng, tất định', () => {
    const c = G.kits.find((k) => k.name === 'food_pass') as (typeof G.kits)[number];
    const kit = c.out.kit as string;
    expect(kit).toContain('#quangcao');
    expect(kit).toContain('Nội dung có sử dụng AI');
    expect(kit).toContain('{{LINK_AFFILIATE}}');
    expect(kit).toContain('AFF-KOC-MAU-01-mat-ong-sam-300ml-PLACEHOLDER');
    expect(kit).toContain(c.out.contract_sha as string);
  });
});

it('"0 đường chi tiền" (W64.6): mkt_koc/mkt_ugc không có http client/API quảng cáo/LLM', () => {
  for (const f of ['./mkt-koc.ts', './mkt-ugc.ts', './shared.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(src).not.toMatch(
      /graph\.facebook\.com|business-api\.tiktok\.com|ads\.google|node:https?|undici|fetch\(|nodemailer|AiGateway|\.chat\(/,
    );
  }
});

describe('mkt_koc — CLI không DB', () => {
  const noConnect =
    (calls: number[]): CliDeps['connect'] =>
    async () => {
      calls.push(1);
      return null;
    };
  const KIT = { kit: true, koc: 'KOC-MAU-01', sku: 'mat-ong-sam-300ml', draftIds: '1', by: 'Lan' };

  it.each([
    [{}],
    [{ list: true, kit: true }],
    [{ kit: true, koc: 'KOC-MAU-01' }],
    [{ kit: true, koc: 'KOC-MAU-99', sku: 'x', draftIds: '1', by: 'a' }],
    [{ kit: true, koc: 'KOC-MAU-01', sku: 'x', draftIds: '1,x', by: 'a' }],
    [{ kit: true, koc: 'KOC-MAU-01', sku: 'x', draftIds: '1', channel: 'facebook', by: 'a' }],
    [{ release: '1' }],
    [{ release: 'x', by: 'a' }],
  ])('usage sai → exit 2 TRƯỚC connect: %j', async (o) => {
    const calls: number[] = [];
    const c = cap();
    expect(await mktKocMain(o, { io: c.io, connect: noConnect(calls) })).toBe(2);
    expect(calls).toEqual([]);
    expect(c.err.join('\n')).toMatch(/^mkt_koc: error: /);
  });

  it('--list không cần DB: in trạng thái hợp đồng, KOC-MAU-03 THIẾU go_24h', async () => {
    const calls: number[] = [];
    const c = cap();
    expect(await mktKocMain({ list: true }, { io: c.io, connect: noConnect(calls) })).toBe(0);
    const out = c.out.join('\n');
    expect(out).toContain('KOC-MAU-03');
    expect(out).toContain('THIẾU go_24h');
    expect(out).toContain('Danh sách MẪU');
    expect(calls).toEqual([]);
  });

  it('koc_sample.json hỏng → [err] exit 1, không connect', async () => {
    const p = join(tmp, 'broken.json');
    writeFileSync(p, '{');
    const calls: number[] = [];
    const c = cap();
    expect(
      await mktKocMain({ list: true }, { io: c.io, kocFile: p, connect: noConnect(calls) }),
    ).toBe(1);
    expect(c.out[0]).toBe('[err] broken.json hỏng (JSONDecodeError) — không connect.');
    expect(calls).toEqual([]);
  });

  it.each([[{ ...KIT, dryRun: true }], [KIT]])(
    'marketing-04.1 TẮT → đúng 1 dòng [rollout] exit 2, không connect: %j',
    async (o) => {
      settings.forceMode = 'tat';
      const calls: number[] = [];
      const c = cap();
      expect(await mktKocMain(o, { io: c.io, connect: noConnect(calls) })).toBe(2);
      expect(c.out.length).toBe(1);
      expect(c.out[0]).toMatch(/^\[rollout\] .*marketing-04\.1/);
      expect(calls).toEqual([]);
    },
  );

  it.each(['chay_thu', 'van_hanh'])('giai đoạn %s: cổng không chặn — tới connect', async (st) => {
    settings.forceMode = st;
    const calls: number[] = [];
    const c = cap();
    expect(await mktKocMain(KIT, { io: c.io, connect: noConnect(calls) })).toBe(2);
    expect(calls).toEqual([1]);
    expect(c.out.join('\n')).not.toContain('[rollout]');
  });
});
