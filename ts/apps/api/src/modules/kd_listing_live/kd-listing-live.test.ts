import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { loadConfig } from '@samsam/core/ops/director';
import { settings } from '@samsam/core/rollout/counters';
import { check, readinessKey as key2 } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import C from './__fixtures__/content.golden.json' with { type: 'json' };
import KL from './__fixtures__/kd_listing.golden.json' with { type: 'json' };
import KV from './__fixtures__/kd_live.golden.json' with { type: 'json' };
import LE from './__fixtures__/listing_export.golden.json' with { type: 'json' };
import * as ct from './content-lite.js';
import * as kl from './kd-listing.js';
import {
  type CliDeps,
  kdListingMain,
  kdLiveMain,
  listingExportMain,
} from './kd-listing-live.command.js';
import * as kv from './kd-live.js';
import * as le from './listing-export.js';

// Dịch phần THUẦN + CLI không DB của tests/test_kd_listing.py, test_contract_c04_listing_export.py,
// test_kd_live.py, test_r19_ngay_cong_som.py (cổng TẮT sớm), test_guardrail_implied.py (dòng sức khỏe
// trung tính). Kết quả so khớp golden sinh từ hàm Python thật (__fixtures__/*.golden.json).

type Pairs = [string, string, unknown][];
const pmap = <T>(p: unknown): Map<string, T> =>
  new Map((p as Pairs).map(([a, b, v]) => [key2(a, b), v as T]));
const rdOf = (p: unknown) => (p === null ? null : pmap<string>(p));
const CFG = loadConfig('sales');
const SRC = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, d: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

afterEach(() => {
  settings.forceMode = null;
});

// ------------------------------------------------------------ kd_listing

describe('kd_listing — thuần (golden Python)', () => {
  it('parse_draft / norm_title / ref_code / vnd / evidence_sha', () => {
    for (const [t, want] of KL.misc.parse_draft) expect([t, kl.parseDraft(t)]).toEqual([t, want]);
    for (const [t, want] of KL.misc.norm_title) expect([t, kl.normTitle(t)]).toEqual([t, want]);
    for (const [t, want] of KL.misc.ref_code) expect([t, kl.refCode(t)]).toEqual([t, want]);
    for (const [n, want] of KL.misc.vnd) expect(kl.vnd(n as number | null)).toBe(want);
    for (const [ev, want] of KL.misc.evidence_sha) {
      expect(kl.evidenceSha(ev as Record<string, unknown>)).toBe(want);
    }
  });

  const run = (c: (typeof KL.diff)[number]) => {
    const i = c.input;
    const skus = new Map(Object.entries(i.skus)) as kl.Skus;
    const res = kl.diffCatalog(
      i.rows as kl.ListingRow[],
      pmap<kl.Draft>(i.drafts),
      skus,
      pmap<string>(i.readiness),
      pmap<number>(i.prices),
      i.channels,
    );
    const v33 = new Map(
      i.v33.map(([k, ch, iid, ss, id]) => [[k, ch, iid, ss].join('\0'), id as number]),
    );
    kl.markDups(res.findings, v33);
    return res;
  };

  it.each(KL.diff.map((c) => [c.variant, c]))(
    'diff_catalog + mark_dups + to_items + báo cáo: %s',
    (_v, c) => {
      const res = run(c);
      expect(res).toEqual(c.result);
      const items = kl.toItems(res.findings, CFG);
      expect(items).toEqual(c.items);
      expect(res.findings.map((f) => kl.payloadOf(f))).toEqual(c.payloads);
      const seen = new Set(c.seen.map(([t, o]) => `${t}\0${o}`));
      const plan = kl.planOf(items, res.findings, seen);
      expect(plan).toEqual(c.plan);
      expect(kl.renderReport(res, '2026-10-12', plan)).toBe(c.report);
      expect(kl.renderReport(res, '2026-01-02')).toBe(c.report_noplan);
    },
  );

  it('payload qua guardrail, không chép tiêu đề listing, nhóm CAM không in SKU/rượu', () => {
    const c = KL.diff[0] as (typeof KL.diff)[number];
    const res = run(c);
    const items = kl.toItems(res.findings, CFG);
    expect(items.length).toBe(res.findings.length - 1); // 1 trùng cảnh báo sàn v3.3
    for (const it of items) {
      expect(check(it.payload).ok, it.payload).toBe(true);
      expect(it.object_id).toMatch(
        /^a4:[a-z_]+:shopee:(?:[A-Za-z0-9_.-]+|\(mã lạ\)):[0-9a-f]{12}$/,
      );
      for (const r of c.input.rows) {
        if (r.title && r.title.trim().length > 1) expect(it.payload).not.toContain(r.title.trim());
      }
    }
    const s1 = items.filter((it) => it.object_type === 'market_alert_s1');
    expect(s1.length).toBe(1);
    for (const it of s1) {
      const t = it.title + it.payload;
      for (const bad of ['ruou', 'Rượu', 'rượu', 'sam-f']) expect(t).not.toContain(bad);
    }
  });

  it('bằng chứng đổi = đợt mới (object_id khác); S1 không đổi', () => {
    const c = KL.diff[0] as (typeof KL.diff)[number];
    const a = run(c);
    const rows = c.input.rows.map((r) => (r.item_id === '1001' ? { ...r, price_vnd: 220000 } : r));
    const b = run({ ...c, input: { ...c.input, rows } } as typeof c);
    const ids = (r: kl.DiffResult, k: string) =>
      r.findings.filter((f) => f.kind === k).map((f) => f.object_id);
    expect(ids(a, 'price_drift')).not.toEqual(ids(b, 'price_drift'));
    expect(ids(a, 'unready_listed')).toEqual(ids(b, 'unready_listed'));
    expect(run(c).findings.map((f) => f.object_id)).toEqual(a.findings.map((f) => f.object_id));
  });

  it('module KHÔNG ghi SQL ngoài hàng duyệt, KHÔNG gọi mạng/LLM (W53.6)', () => {
    const src = SRC('./kd-listing.ts');
    expect(src).not.toMatch(
      /insert into|update |delete from|truncate|alter table|decide\(|auto_?approve|override\(|approve_?price|approve_?cogs/i,
    );
    expect(src).not.toMatch(/node:(http|https|net)|fetch\(|ai\/gateway|AiGateway/);
  });
});

// ------------------------------------------------------------ content (phần dùng chung)

describe('content — precheck / listing_fields / spec_like / prompt (golden Python)', () => {
  it('precheck mọi mã từ chối', () => {
    for (const c of C.precheck) {
      expect([
        c.sku,
        c.channel,
        c.content_type,
        ct.precheck(c.sku, c.channel, c.content_type, rdOf(c.readiness)),
      ]).toEqual([c.sku, c.channel, c.content_type, c.out]);
    }
  });

  it('listing_fields: tên/quy cách/ĐKSP (chỉ TPBVSK) từ golden', () => {
    for (const [k, want] of Object.entries(C.listing_fields))
      expect(ct.listingFields(k)).toEqual(want);
    const [cfg] = ct.contentCfg();
    expect([...(cfg?.golden.keys() ?? [])].sort()).toEqual(C.golden_keys);
  });

  it('spec_like: số mọi loại / nhãn khung / chèn ký tự lách', () => {
    for (const [s, want] of C.spec_like) expect([s, ct.specLike(s as string)]).toEqual([s, want]);
  });

  it('nhãn/khuyến cáo, template sha, system prompt, feedback, guardrail từ chối', () => {
    expect(ct.publishTexts()).toEqual(C.publish_texts);
    expect(ct.loadTemplate('livestream_script')).toEqual(C.template);
    expect(ct.system('FMT', false)).toBe(C.system_listing);
    expect(ct.system('FMT')).toBe(C.system_post);
    expect(
      ct.feedback({
        violations: [
          { code: 'tu_cam', span: 'chữa', detail: 'x' },
          { type: 'claim', detail: 'd' },
          { code: null, type: null, span: null, detail: null },
        ],
      }),
    ).toBe(C.feedback);
    expect(ct.refusedGuardrail({ code: 'ruou', reason: 'r' })).toEqual(C.refused);
    expect(ct.refusedGuardrail({ code: 'kenh_la', reason: 'k' })).toEqual(C.refused2);
    expect(() => ct.loadTemplate('khong-co')).toThrow(/không dùng được/);
  });

  it('cấu hình guardrail/golden hỏng → precheck "config" (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kll-cfg-'));
    try {
      writeFileSync(join(dir, 'guardrail_rules.json'), '{hỏng');
      const [cfg, err] = ct.contentCfg(dir);
      expect(cfg).toBeNull();
      expect(err).toMatch(/^file luật guardrail\/golden không dùng được \(JSONDecodeError\)/);
    } finally {
      ct.resetContentCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ listing_export

describe('listing_export — thuần (golden Python)', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'kll-le-'));
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('CSV utf-8-sig như csv.writer Python (nháy/xuống dòng/rỗng)', () => {
    const cols = le.loadMap().columns.shopee as Record<string, string>;
    expect(le.toCsv(LE.row, cols).toString('base64')).toBe(LE.csv.special);
    const plain = Object.fromEntries(le.FIELDS.map((k) => [k, 'x']));
    expect(le.toCsv(plain, cols).toString('base64')).toBe(LE.csv.plain);
    expect(le.toCsv({ ...LE.row, mo_ta: 'a\rb', quy_cach: "q'x" }, cols).toString('base64')).toBe(
      LE.csv.cr,
    );
  });

  it('bo_dong_gia: chỉ bỏ dòng bắt đầu "Giá:"', () => {
    for (const [t, want] of LE.describe) expect(le.describe(t as string)).toBe(want);
  });

  it('listing_export_map.json: đủ 6 cột mỗi kênh, hỏng → ExportError', () => {
    for (const [name, doc, want] of LE.maps as [
      string,
      unknown,
      { ok?: unknown; err?: string },
    ][]) {
      const p = join(TMP, `${name}.json`);
      writeFileSync(p, name === 'broken' ? '{broken' : JSON.stringify(doc));
      if (want.err !== undefined) {
        expect(() => le.loadMap(p), name).toThrow(le.ExportError);
        try {
          le.loadMap(p);
        } catch (e) {
          expect((e as Error).message, name).toBe(want.err);
        }
      } else {
        expect(le.loadMap(p), name).toEqual(want.ok);
      }
    }
    expect(Object.keys(le.loadMap().columns)).toEqual(['shopee', 'tiktok']);
  });
});

// ------------------------------------------------------------ kd_live

const ctxOf = (c: typeof KV.ctx): kv.LiveCtx => ({
  skus: new Map(Object.entries(c.skus)) as kv.LiveCtx['skus'],
  promotable: new Map(Object.entries(c.promotable)) as Map<string, number>,
  n_sessions: c.n_sessions,
  readiness: pmap<string>(c.readiness),
});

/** Python `json.dumps(v, ensure_ascii=False)` (dấu tách mặc định `, ` `: `) — chữ LLM giả như Python. */
const pyDumps = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(pyDumps).join(', ')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.entries(v)
          .map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`)
          .join(', ')}}`
      : JSON.stringify(v);

/** Gateway GIẢ tất định: trả lần lượt `queue` (phần tử cuối lặp lại); `raiseAt` = lời gọi thứ n lỗi. */
function fakeAi(queue: unknown[], raiseAt: number | null = null) {
  const calls: { agent: string; msgs: ChatMessage[]; opts: Record<string, unknown> }[] = [];
  const ai: kv.Chat = {
    chat: async (agent, msgs, opts) => {
      calls.push({ agent, msgs, opts: opts as Record<string, unknown> });
      if (raiseAt !== null && calls.length === raiseAt) throw new RuntimeError('gateway down');
      const q = queue[Math.min(calls.length, queue.length) - 1];
      return {
        text: typeof q === 'string' ? q : pyDumps(q),
        model: 'fake/llm',
        provider: 'ollama',
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  };
  return { ai, calls };
}
class RuntimeError extends Error {
  override name = 'RuntimeError';
}

describe('kd_live — thuần (golden Python)', () => {
  const rules = kv.loadRules();

  it('luật livestream + template manifest + health template', () => {
    expect(rules).toEqual(KV.rules);
    expect(readFileSync(kv.RULES_FILE, 'utf8')).toContain('GIẢ ĐỊNH');
    expect(kv.healthTemplate()).toBe(KV.health);
    expect(kv.HEALTH_Q).toBe(KV.health_q);
    const [tmpl, ver] = ct.loadTemplate('livestream_script');
    expect(ver).toBe('livestream_script@1');
    for (const ph of ['{channel}', '{products}', '{brief}', '{duration_min}'])
      expect(tmpl).toContain(ph);
    for (const [d, w] of KV.weeks) expect(kv.isoWeek(d as string)).toEqual(w);
  });

  it('luật livestream hỏng → RangeError (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kll-lr-'));
    try {
      const p = join(dir, 'r.json');
      for (const [doc, msg] of [
        ['{x', /không dùng được \(JSONDecodeError\)/],
        [JSON.stringify({ ...KV.rules, max_cart: 31 }), /max_cart phải 1..30/],
        [
          JSON.stringify({ ...KV.rules, max_sessions_per_week: true }),
          /max_sessions_per_week phải/,
        ],
        [JSON.stringify({ ...KV.rules, channels: [] }), /channels rỗng/],
        [JSON.stringify({ channels: ['x'] }), /không dùng được \(KeyError\)/],
      ] as const) {
        writeFileSync(p, doc);
        expect(() => kv.loadRules(p)).toThrow(msg);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('precheck: thứ tự mã từ chối trước LLM', () => {
    const base = {
      skus: new Map(
        Object.entries({
          'mat-ong-sam-120ml-1hu': { name: 'Mật ong sâm 120ml (1 hũ)', category: 'food' },
          'ruou-sam-chai-thuy-tinh-500ml': { name: 'Rượu sâm chai', category: 'alcohol' },
          'sapentol-30v': { name: 'Sapentol 30 viên', category: 'tpbvsk' },
          'ten-ruou': { name: 'Rượu ngâm', category: 'food' },
        }),
      ),
      promotable: new Map([
        ['mat-ong-sam-120ml-1hu', 1],
        ['ten-ruou', 2],
      ]),
    };
    for (const c of KV.precheck) {
      const ctx = { ...base, n_sessions: c.n_sessions } as kv.LiveCtx;
      expect([c.channel, c.cart, kv.precheck(c.channel, c.cart, c.brief, ctx, rules)]).toEqual([
        c.channel,
        c.cart,
        c.out,
      ]);
    }
  });

  it('parse: JSON thẳng / khối ```json / hỏng → null', () => {
    for (const [t, want] of KV.parse) expect([t, kv.parse(t)]).toEqual([t, want]);
    // TS_STRICTER: Python json.loads nhận NaN → dict; JSON.parse từ chối → `kich_ban` (fail-closed).
    expect(kv.parse('{"a": NaN}')).toBeNull();
  });

  it('build_text: giỏ+giá do code, bỏ câu số/giá/rượu, câu hỏi sức khỏe trung tính, nhãn', () => {
    const ctx = ctxOf(KV.ctx);
    for (const b of KV.builds) {
      const [text, dropped] = kv.buildText(
        b.obj as Record<string, unknown>,
        b.channel,
        b.cart,
        '2026-10-19',
        ctx,
        KV.health,
      );
      expect([b.name, text, dropped]).toEqual([b.name, b.text, b.dropped]);
    }
    const good = KV.builds[0] as (typeof KV.builds)[number];
    expect(good.text).not.toContain('tiểu đường');
    expect(good.text).toContain(`Hỏi: ${kv.HEALTH_Q}`);
    expect(good.text).toContain(`Đáp: ${KV.health}`);
  });

  it('messages + sha prompt (brief cuối, `$&` không bị hiểu là mẫu)', () => {
    const ctx = ctxOf(KV.ctx);
    const [tmpl] = ct.loadTemplate('livestream_script');
    const m = kv.messages(
      tmpl,
      'tiktok',
      ['mat-ong-sam-120ml-1hu', 'saphraton-20v'],
      '  Phiên  quà\nquê  ',
      ctx,
      rules,
    );
    expect(m).toEqual(KV.messages);
    expect(kv.msgsSha(m)).toBe(KV.msgs_sha);
    const d = kv.messages(tmpl, 'tiktok', ['mat-ong-sam-120ml-1hu'], 'giá $& $1', ctx, rules);
    expect(d[0]?.content).toContain('Brief của người lập: giá $& $1');
  });

  it.each(KV.gens.map((g, i) => [i, g]))(
    'generate (gateway giả) #%s khớp Python',
    async (_i, g) => {
      const ctx = ctxOf(KV.ctx);
      if (_i === 1) {
        ctx.readiness = new Map([
          [key2('mat-ong-sam-120ml-1hu', 'tiktok'), 'TP_THUONG'],
          [key2('saphraton-20v', 'tiktok'), 'QC_DAY_DU'],
        ]);
      }
      const { ai, calls } = fakeAi(g.queue, g.raise_at);
      const res = await kv.generate(g.channel, g.cart, '2026-10-19', g.brief, ctx, rules, ai);
      const { guardrail, model: _m, ...rest } = res;
      const want = g.res as Record<string, unknown>;
      expect(rest).toEqual({ ...want, guardrail: undefined });
      expect(
        guardrail === null
          ? null
          : {
              ok: guardrail.ok,
              codes: (guardrail.violations as { code: string }[]).map((v) => v.code),
            },
      ).toEqual(want.guardrail);
      expect(
        calls.map((c) => ({
          agent: c.agent,
          kw: {
            temperature: c.opts.temperature,
            max_tokens: c.opts.maxTokens,
            feature: c.opts.feature,
          },
          sha: kv.msgsSha(c.msgs),
          n: c.msgs.length,
          last: c.msgs.at(-1)?.content,
        })),
      ).toEqual(g.calls);
    },
  );

  it('module KHÔNG có đường duyệt/gửi', () => {
    expect(SRC('./kd-live.ts')).not.toMatch(/setStatus|approve|fetch\(|node:https?/);
  });
});

// ------------------------------------------------------------ CLI (không DB)

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

describe('CLI — tham số, cổng TẮT, DB down (không DB)', () => {
  const noDb =
    (calls: string[]): CliDeps['open'] =>
    async () => {
      calls.push('open');
      return null;
    };
  const job: CliDeps['jobRun'] = async (_n, body) => body({ ok: true, detail: null });

  it.each([
    [{}],
    [{ run: true, report: true }],
    [{ dryRun: true }],
    [{ report: true, dryRun: true }],
  ])('kd-listing sai tham số → exit 2 trước connect %j', async (o) => {
    const calls: string[] = [];
    const t = cap();
    expect(await kdListingMain(o, { ...t.d, open: noDb(calls), jobRun: job })).toBe(2);
    expect(calls).toEqual([]);
  });

  it('kd-listing cấu hình hỏng → exit 1 trước connect', async () => {
    const calls: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'kll-dir-'));
    try {
      const t = cap();
      settings.forceMode = 'van_hanh';
      writeFileSync(join(dir, 'm.json'), '{broken');
      expect(
        await kdListingMain(
          { run: true, dryRun: true },
          { ...t.d, open: noDb(calls), mapPath: join(dir, 'm.json') },
        ),
      ).toBe(1);
      expect(t.err.join('\n')).toMatch(/không đọc được mapping m\.json: JSONDecodeError/);
      writeFileSync(join(dir, 'sales.json'), '{broken');
      expect(
        await kdListingMain({ report: true }, { ...t.d, open: noDb(calls), directorsDir: dir }),
      ).toBe(1);
      expect(t.err.join('\n')).toMatch(/cấu hình lỗi/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([[{ run: true, dryRun: true }], [{ run: true }]])(
    'kd-listing TẮT → 1 dòng [rollout] sales-03, exit 2, không connect/job %j',
    async (o) => {
      settings.forceMode = 'tat';
      const calls: string[] = [];
      const t = cap();
      let jobs = 0;
      const rc = await kdListingMain(o, {
        ...t.d,
        open: noDb(calls),
        jobRun: async (n, b) => {
          jobs++;
          return job(n, b);
        },
      });
      expect(rc).toBe(2);
      expect(t.out).toHaveLength(1);
      expect(t.out[0]).toMatch(/^\[rollout\] .*sales-03/);
      expect([calls, jobs, t.err]).toEqual([[], 0, []]);
    },
  );

  it.each([['chay_thu'], ['van_hanh']])(
    'kd-listing %s: cổng không chặn → tới connect (DB down exit 2)',
    async (st) => {
      settings.forceMode = st;
      for (const o of [{ run: true, dryRun: true }, { run: true }]) {
        const calls: string[] = [];
        const t = cap();
        expect(await kdListingMain(o, { ...t.d, open: noDb(calls), jobRun: job })).toBe(2);
        expect(calls).toEqual(['open']);
        expect(t.out.join('\n')).not.toContain('[rollout]');
        expect(t.err.join('\n')).toContain('[error] không kết nối được Postgres');
      }
    },
  );

  it('listing-export sai tham số → exit 2; DB down → exit 2', async () => {
    const calls: string[] = [];
    for (const o of [
      {},
      { websiteFeed: true },
      { sku: 'x', channel: 'shopee' },
      { sku: 'x', channel: 'lazada', out: 'd' },
    ]) {
      const t = cap();
      expect(await listingExportMain(o, { ...t.d, open: noDb(calls) })).toBe(2);
    }
    expect(calls).toEqual([]);
    const t = cap();
    expect(
      await listingExportMain({ websiteFeed: true, out: 'd' }, { ...t.d, open: noDb(calls) }),
    ).toBe(2);
    expect(calls).toEqual(['open']);
  });

  it('kd-live sai tham số → exit 2 trước connect', async () => {
    const calls: string[] = [];
    const ok = { channel: 'tiktok', cart: 'mat-ong-sam-120ml-1hu', day: '2026-10-19', brief: 'x' };
    for (const o of [
      { ...ok, day: '19/10' },
      { ...ok, day: '2026-02-30' },
      { ...ok, channel: 'lazada' },
      { ...ok, cart: 'A;drop' },
      { channel: 'tiktok', cart: 'x', day: '2026-10-19' },
    ]) {
      const t = cap();
      expect(await kdLiveMain(o, { ...t.d, open: noDb(calls) })).toBe(2);
    }
    expect(calls).toEqual([]);
    const t = cap();
    expect(await kdLiveMain(ok, { ...t.d, open: noDb(calls) })).toBe(2);
    expect(t.err).toEqual([
      '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)',
    ]);
  });

  it('kd-listing DB chết (host không tới được) → exit 2 "[error]", không treo', async () => {
    settings.forceMode = 'van_hanh';
    const t = cap();
    const t0 = Date.now();
    const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@10.255.255.1:5432/x' };
    expect(await kdListingMain({ run: true, dryRun: true }, { ...t.d, env })).toBe(2);
    // lượt ghi: login dịch vụ `job` (dev rơi về DATABASE_URL) — cùng nhánh "không kết nối được"
    expect(await kdListingMain({ run: true }, { ...t.d, env, jobRun: job })).toBe(2);
    expect(t.err).toEqual([NO_DB, NO_DB]);
    expect(Date.now() - t0).toBeLessThan(40_000);
  }, 60_000);

  it('kd-live TẮT → [rollout] sales-07.1 exit 2, 0 lời gọi AI', async () => {
    settings.forceMode = 'tat';
    const t = cap();
    const { ai, calls } = fakeAi([{}]);
    let ended = 0;
    const pool = { end: async () => void ended++ } as never;
    const rc = await kdLiveMain(
      { channel: 'tiktok', cart: 'mat-ong-sam-120ml-1hu', day: '2026-10-19', brief: 'x' },
      { ...t.d, open: async () => pool, wire: null, ai },
    );
    expect(rc).toBe(2);
    expect(t.out).toHaveLength(1);
    expect(t.out[0]).toMatch(/^\[rollout\] .*sales-07\.1/);
    expect([calls.length, ended]).toEqual([0, 1]);
  });
});
