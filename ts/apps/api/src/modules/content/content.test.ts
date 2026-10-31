import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import type { Db } from '@samsam/core/ops/deps';
import { guardrailLines } from '@samsam/core/ops/store';
import { DATA_DIR, dataPath, REPO_ROOT } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import {
  CLAIM_VERBS,
  checkPublish,
  type ReadinessMap,
  readinessKey,
} from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import C from './__fixtures__/content.golden.json' with { type: 'json' };
import { type ContentDeps, contentMain } from './content.command.js';
import * as ct from './content.js';

// Dịch tests/test_content.py, tests/test_listing.py (phần không DB), CLI của tests/test_listing.py +
// tests/test_v13_c06_daily_ar.py. LLM = gateway GIẢ tất định (0 mạng, 0 key thật); guardrail chạy
// THẬT. Golden = hàm Python thật chạy trên cùng đầu vào (gen.py ở scratchpad).

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON thử nghiệm
type Any = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: bộ golden (tuple JSON)
type Row = any[];
const RULES = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8')) as Any;
const GOLDEN = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as Any;
const GOLD: Record<string, Any> = Object.fromEntries(GOLDEN.skus.map((s: Any) => [s.sku_key, s]));
const MANIFEST = JSON.parse(readFileSync(dataPath('prompts/manifest.json'), 'utf8')) as Any;
const CANON: string = RULES.disclaimer.canonical;
const AI: string = RULES.labels.ai[0];
const AD: string = RULES.labels.ad[0];
const LABEL = 'Nội dung có sử dụng AI';
const ALCOHOL = Object.keys(GOLD).filter((k) => GOLD[k]?.category === 'alcohol');
const LISTING_CH = ['shopee', 'tiktok', 'web'];
const HONEY = 'mat-ong-sam-300ml';
const SAFE_TEXT =
  'Sâm Sâm Quảng Nam — đặc sản quê hương, quà tặng sức khỏe.\n\nNội dung có sử dụng AI';
const ENV = {}; // không GUARDRAIL_LLM_MODEL → lớp LLM-check tắt (như conftest)

// ---------------------------------------------------------------- gateway giả

type Call = {
  agent: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  feature: string;
};
class RuntimeError extends Error {
  override name = 'RuntimeError';
}
function fakeAi(texts: string[] | ((agent: string) => string), raise?: Error) {
  const calls: Call[] = [];
  const ai = {
    chat: async (
      agent: string,
      messages: ChatMessage[],
      o: { feature: string; temperature?: number; maxTokens?: number },
    ) => {
      calls.push({
        agent,
        messages: structuredClone(messages),
        temperature: o.temperature,
        max_tokens: o.maxTokens,
        feature: o.feature,
      });
      if (raise) throw raise;
      const n = calls.filter((c) => c.agent === agent).length;
      const text =
        typeof texts === 'function'
          ? texts(agent)
          : (texts[Math.min(n, texts.length) - 1] as string);
      return { text, model: 'fake', provider: 'ollama' as const, tokensIn: 0, tokensOut: 0 };
    },
  };
  return { ai, calls, d: { ai, env: ENV } as ct.AiDeps };
}
const sysOf = (calls: Call[], i = 0) => calls[i]?.messages[0]?.content as string;
const lastUser = (calls: Call[], i: number) => calls[i]?.messages.at(-1)?.content as string;
const codes = (g: Any) => ((g.violations ?? []) as Any[]).map((v) => v.code);

// System prompt → "@system:<template>" như gen.py (golden không chép lại prompt dài mỗi lượt).
const SYS = new Map<string, string>();
for (const n of Object.keys(MANIFEST.templates)) {
  if (n.startsWith('content_')) SYS.set(ct.system(ct.loadTemplate(n)[0]), `@system:${n}`);
  else if (n.startsWith('listing_'))
    SYS.set(ct.system(ct.loadTemplate(n)[0], false), `@system:${n}`);
}
const marked = (calls: Call[]) =>
  calls.map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({ ...m, content: SYS.get(m.content as string) ?? m.content })),
  }));

const SOME = new Map([
  [readinessKey('savina-12v', 'facebook'), 'QC_DAY_DU'],
  [readinessKey(HONEY, 'shopee'), 'TP_THUONG'],
  [readinessKey('savina-12v', 'shopee'), 'MO_TA'],
]);
const rmOf = (v: unknown): ReadinessMap | null =>
  v === null || v === 'none'
    ? null
    : v === 'some'
      ? SOME
      : new Map((v as [string, string, string][]).map(([s, c, r]) => [readinessKey(s, c), r]));
const llmJson = (kw: Any = {}) =>
  JSON.stringify({
    hook: 'Quà biếu tinh tế',
    description: 'Vị ngọt dịu, sánh mịn.',
    bullets: ['Đóng hũ thủy tinh sạch'],
    keywords: ['mật ong sâm', 'quà biếu'],
    ...kw,
  });
const TP = new Map([[readinessKey(HONEY, 'shopee'), 'TP_THUONG']]);
const eligible = () =>
  Object.keys(GOLD).filter((k) => ct.precheck(k, 'shopee', 'listing') === null);

const TMP = mkdtempSync(join(tmpdir(), 'content-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  ct.paths.prompts = dataPath('prompts');
  ct.paths.listingRules = dataPath('listing_rules.json');
  ct.setContentDataDir();
  settings.forceMode = null;
});

// ================================================================ golden thuần

describe('golden thuần (khớp Python)', () => {
  it('template: text/version/sha; tên lạ → lỗi', () => {
    for (const [n, want] of Object.entries(C.templates)) expect(ct.loadTemplate(n)).toEqual(want);
    for (const [n, msg] of Object.entries(C.templates_bad)) {
      expect(() => ct.loadTemplate(n)).toThrow(msg as string);
    }
  });

  it('specLike: ký tự số mọi loại, nhãn khung, số chữ, ký tự chèn/homoglyph', () => {
    for (const [s, want] of C.spec_like as [string, boolean][])
      expect(ct.specLike(s), JSON.stringify(s)).toBe(want);
  });

  it('precheck ma trận SKU × kênh × loại × readiness', () => {
    for (const [rk, sku, ch, type, want] of C.precheck as [
      string,
      unknown,
      unknown,
      unknown,
      unknown,
    ][]) {
      const rm = rk === 'str' ? 'x' : rmOf(rk);
      expect(ct.precheck(sku, ch, type, rm), JSON.stringify([rk, sku, ch, type])).toEqual(want);
    }
  });

  it('refusedGuardrail / system / withRequired / listingFields / vnd / cutWords', () => {
    for (const [r, want] of C.refused_guardrail as [ct.Refusal, unknown][])
      expect(ct.refusedGuardrail(r)).toEqual(want);
    expect(ct.system(ct.loadTemplate('content_facebook')[0])).toBe(C.system.content_facebook);
    expect(ct.system(ct.loadTemplate('listing_shopee')[0], false)).toBe(C.system.listing_shopee);
    for (const [text, channel, contentType, sku, rm, want] of C.with_required as Row[]) {
      expect(ct.withRequired(text, { channel, contentType, sku, readiness: rmOf(rm) })).toBe(want);
    }
    for (const [k, want] of Object.entries(C.listing_fields))
      expect(ct.listingFields(k, 'shopee')).toEqual(want);
    for (const [v, want] of C.vnd as [number, string][]) expect(ct.vnd(v)).toBe(want);
    for (const [s, n, want] of C.cut_words as [string, number, string][])
      expect(ct.cutWords(s, n)).toBe(want);
  });

  it('parseLlm / cleanLlm / render', () => {
    // Khác Python có chủ đích: JSON có NaN (Python json nhận) → null = bỏ phần chữ LLM (khung thuần).
    const TS_STRICTER = new Set(
      (C.parse_llm as Row[])
        .filter(([s]) => typeof s === 'string' && s.includes('NaN'))
        .map(([s]) => s),
    );
    expect(TS_STRICTER.size).toBe(1);
    for (const [s, want] of C.parse_llm as [unknown, unknown][]) {
      expect(ct.parseLlm(s), String(s)).toEqual(TS_STRICTER.has(s) ? null : want);
    }
    const fields = ct.listingFields(HONEY, 'shopee');
    for (const c of C.clean_render as Any[]) {
      const part = ct.cleanLlm(c.obj, c.lim);
      expect(part).toEqual(c.part);
      expect(ct.render(fields, c.lim, ['Sâm Sâm'], part)).toBe(c.render);
      expect(ct.render(fields, c.lim, ['Sâm Sâm'], null)).toBe(c.render_none);
    }
  });

  it('draft(): kết quả + đúng messages/feature/tham số gửi gateway', async () => {
    for (const c of C.draft as Any[]) {
      const f = fakeAi(c.texts);
      const r = await ct.draft(
        c.brief,
        c.channel,
        { readiness: rmOf(c.readiness), sku: c.sku, contentType: c.content_type },
        f.d,
      );
      const tag = `${c.brief}/${c.channel}/${c.sku}/${c.content_type}`;
      expect(r, tag).toEqual(c.result);
      expect(marked(f.calls), tag).toEqual(c.calls);
    }
  });

  it('listing(): khung golden + chữ LLM lọc, mọi SKU × kênh sàn, lỗi gateway', async () => {
    for (const c of C.listing as Any[]) {
      const f = fakeAi(c.texts, c.raise ? new RuntimeError('down') : undefined);
      const r = await ct.listing(
        c.sku,
        c.channel,
        { readiness: rmOf(c.readiness), llm: c.llm },
        f.d,
      );
      const tag = `${c.sku}/${c.channel}/${JSON.stringify(c.readiness)}/${c.llm}`;
      expect(r, tag).toEqual(c.result);
      expect(marked(f.calls), tag).toEqual(c.calls);
    }
  });

  it('dailyKey / dailyBrief / dòng in CLI', () => {
    expect(Array.from({ length: 9 }, (_, i) => ct.dailyKey('2026-10-15', i + 1))).toEqual(
      C.daily_key,
    );
    for (const [c, want] of C.daily_brief as Row[]) expect(ct.dailyBrief(c)).toBe(want);
    for (const [it, want] of C.fmt_item as Row[]) expect(ct.fmtItem(it)).toBe(want);
    for (const [it, want] of C.fmt_daily as Row[]) expect(ct.fmtDaily(it)).toBe(want);
  });
});

// ================================================================ tests/test_content.py

describe('draft / draftMulti (test_content.py)', () => {
  it('draftMulti đủ kênh, mỗi kênh guardrail riêng', async () => {
    const f = fakeAi([SAFE_TEXT]);
    const res = await ct.draftMulti(
      'giới thiệu Saphraton',
      ['facebook', 'tiktok', 'blog', 'zalo'],
      {},
      f.d,
    );
    expect(new Set(Object.keys(res))).toEqual(new Set(['facebook', 'tiktok', 'blog', 'zalo']));
    for (const r of Object.values(res)) {
      expect(r.text).toBeTruthy();
      for (const k of ['ok', 'violations', 'matched_claims']) expect(k in r.guardrail).toBe(true);
      expect(r.guardrail.ok).toBe(true);
    }
    expect(f.calls.length).toBe(4);
  });

  it('tiktok: prompt có kịch bản/hook/overlay/CTA; kênh lạ → hint Facebook, giữ tên kênh', async () => {
    const f = fakeAi([SAFE_TEXT]);
    await ct.draftMulti('quay video giới thiệu', ['tiktok'], {}, f.d);
    for (const w of ['kịch bản', 'hook', 'overlay', 'CTA']) expect(sysOf(f.calls)).toContain(w);
    const g = fakeAi([SAFE_TEXT]);
    const res = await ct.draftMulti('x', ['kênh-lạ'], {}, g.d);
    expect(Object.keys(res)).toEqual(['kênh-lạ']);
    expect(sysOf(g.calls)).toContain('Facebook');
  });

  it('kênh trùng tự gộp; chuỗi → 1 kênh', async () => {
    const f = fakeAi([SAFE_TEXT]);
    const res = await ct.draftMulti('x', ['facebook', 'facebook', 'zalo'], {}, f.d);
    expect(Object.keys(res)).toEqual(['facebook', 'zalo']);
    expect(f.calls.length).toBe(2);
    expect(Object.keys(await ct.draftMulti('x', 'facebook', {}, f.d))).toEqual(['facebook']);
  });

  it('contract {text, guardrail, meta}; blog dùng template blog', async () => {
    const f = fakeAi([SAFE_TEXT]);
    const r = await ct.draft('x', 'blog', {}, f.d);
    expect(Object.keys(r).sort()).toEqual(['guardrail', 'meta', 'text']);
    expect(r.guardrail.ok).toBe(true);
    expect(sysOf(f.calls)).toContain('blog');
  });

  it('vi phạm → đúng 1 lượt viết lại có feedback', async () => {
    const f = fakeAi(['Saphraton chữa khỏi bệnh tiểu đường', SAFE_TEXT]);
    const r = await ct.draft('x', 'facebook', {}, f.d);
    expect(f.calls.length).toBe(2);
    expect([r.text, r.guardrail.ok]).toEqual([SAFE_TEXT, true]);
    expect(lastUser(f.calls, 1)).toContain('vi phạm guardrail');
  });

  it('đi qua guardrail ĐĂNG BÀI (checkPublish), không dùng check() chế độ chat', () => {
    const src = readFileSync(new URL('./content.ts', import.meta.url), 'utf8');
    expect(src).toContain('checkPublish');
    expect(src).not.toMatch(/(?<![\w.])check\(/);
  });

  it('prompt: câu khuyến cáo nguyên văn, nhãn AI, "Ngọc Linh" chỉ ở dòng CẤM', async () => {
    const f = fakeAi([SAFE_TEXT]);
    await ct.draft('x', 'facebook', {}, f.d);
    const s = sysOf(f.calls);
    expect(s).toContain(CANON);
    expect(s).not.toContain('Sản phẩm không phải là thuốc');
    expect(s).toContain(LABEL);
    const nl = s.split('\n').filter((ln) => ln.toLowerCase().includes('ngọc linh'));
    expect(nl.length).toBeGreaterThan(0);
    for (const ln of nl) expect(ln).toContain('Không dùng');
  });

  it('thiếu nhãn AI → code tự nối, không tốn lượt sửa; llm_check off', async () => {
    const bare = 'Sâm Sâm Quảng Nam — đặc sản quê hương.';
    const f = fakeAi([bare]);
    const r = await ct.draft('x', 'facebook', {}, f.d);
    expect(r.text).toBe(`${bare}\n\n${LABEL}`);
    expect(r.guardrail.ok).toBe(true);
    expect(f.calls.length).toBe(1);
    expect(r.guardrail.llm_check).toBe('off');
  });

  it('"Ngọc Linh" → feedback ngoc_linh_chua_xac_nhan ở lượt sửa, vẫn chặn', async () => {
    const f = fakeAi(['Sâm Ngọc Linh chính gốc']);
    const r = await ct.draft('x', 'facebook', {}, f.d);
    expect(f.calls.length).toBe(2);
    expect(lastUser(f.calls, 1)).toContain('ngoc_linh_chua_xac_nhan');
    expect(r.guardrail.ok).toBe(false);
    expect(codes(r.guardrail)).toContain('ngoc_linh_chua_xac_nhan');
  });

  it('blog kiểm như web (alias); kênh lạ → config', async () => {
    const f = fakeAi([`Savina 12 viên. ${CANON}.`]);
    const r = await ct.draft('x', 'blog', {}, f.d);
    expect(r.guardrail.ok).toBe(true);
    expect(((r.guardrail.warnings as Any[])[0] as Any).detail).toContain('web');
    const r2 = await ct.draft('x', 'kênh-lạ', {}, f.d);
    expect(r2.guardrail.ok).toBe(false);
    expect(codes(r2.guardrail)).toEqual(['config']);
    expect(sysOf(f.calls, f.calls.length - 1)).toContain('Facebook');
  });

  it('lớp LLM-check có hiệu lực trong luồng sinh (GUARDRAIL_LLM_MODEL)', async () => {
    const f = fakeAi((agent) =>
      agent === 'guardrail_llm'
        ? '{"flag": true, "reasons": [{"quote": "quà tặng sức khỏe", "why": "ẩn ý"}]}'
        : SAFE_TEXT,
    );
    const r = await ct.draft(
      'x',
      'facebook',
      {},
      { ai: f.ai, env: { GUARDRAIL_LLM_MODEL: 'google/gemini-test' } },
    );
    expect(r.guardrail.ok).toBe(false);
    expect(r.guardrail.llm_check).toBe('flag');
    expect(codes(r.guardrail)).toEqual(['llm_ngam_y_suc_khoe']);
    expect(f.calls.filter((c) => c.agent === 'guardrail_llm').length).toBe(2); // mỗi lượt 1 LLM-check
  });
});

// ================================================================ tests/test_listing.py (không DB)

describe('template + precheck (W61.2)', () => {
  it('manifest: sha khớp mọi template, version <tên>@1, chờ GĐ Marketing duyệt', () => {
    expect(new Set(Object.keys(MANIFEST.templates))).toEqual(
      new Set([
        'content_facebook',
        'content_zalo',
        'content_tiktok',
        'content_blog',
        'listing_shopee',
        'listing_tiktok',
        'listing_web',
        'image_background',
        'video_script',
        'livestream_script',
        'youtube_long',
      ]),
    );
    for (const [n, ent] of Object.entries(MANIFEST.templates) as [string, Any][]) {
      expect(ent.version).toBe(`${n}@1`);
      expect(ent.trang_thai).toBe('chờ GĐ Marketing duyệt');
      const [text, ver, sha] = ct.loadTemplate(n);
      expect([ver, sha]).toEqual([ent.version, ent.sha256]);
      expect(text).toBeTruthy();
    }
  });

  it('CRLF cùng sha; sửa 1 byte → "bump version"; thiếu file/tên lạ → lỗi', () => {
    const p = join(TMP, 'p');
    cpSync(dataPath('prompts'), p, { recursive: true });
    ct.paths.prompts = p;
    const f = join(p, 'content_zalo.md');
    const orig = readFileSync(f).toString('latin1').replaceAll('\r\n', '\n');
    writeFileSync(f, Buffer.from(orig.replaceAll('\n', '\r\n'), 'latin1'));
    expect(ct.loadTemplate('content_zalo')[2]).toBe(MANIFEST.templates.content_zalo.sha256);
    writeFileSync(f, Buffer.from(`${orig} `, 'latin1'));
    expect(() => ct.loadTemplate('content_zalo')).toThrow('bump version');
    expect(() => ct.loadTemplate('khong-co')).toThrow(ct.TemplateError);
    unlinkSync(join(p, 'listing_web.md'));
    expect(() => ct.loadTemplate('listing_web')).toThrow(ct.TemplateError);
  });

  it('channelHint là view của template', () => {
    for (const [ch, n] of Object.entries(ct.CONTENT_TEMPLATES))
      expect(ct.channelHint(ch)).toBe(ct.loadTemplate(n)[0]);
  });

  it('prompt chứa template + meta đúng version/sha mỗi kênh', async () => {
    for (const ch of ['facebook', 'zalo', 'tiktok', 'blog']) {
      const f = fakeAi([`Sâm Sâm Quảng Nam — quà tặng.\n\n${AI}`]);
      const r = await ct.draft('x', ch, {}, f.d);
      const n = ct.CONTENT_TEMPLATES[ch] as string;
      const [tmpl, , sha] = ct.loadTemplate(n);
      expect(sysOf(f.calls)).toContain(tmpl);
      expect(r.meta).toEqual({
        content_type: 'post',
        sku: null,
        is_ai: true,
        prompt_version: MANIFEST.templates[n].version,
        prompt_sha256: sha,
        refused: null,
      });
    }
  });

  it('rượu bị từ chối mọi kênh, 0 lời gọi LLM', async () => {
    const f = fakeAi(['x']);
    for (const ch of ['facebook', 'zalo', 'tiktok', 'blog']) {
      for (const sku of ALCOHOL) {
        const r = await ct.draft('giới thiệu', ch, { sku }, f.d);
        expect(r.meta.refused?.code).toBe('ruou');
        expect([r.text, r.guardrail.ok]).toEqual(['', false]);
        expect(codes(r.guardrail)).toContain('ruou_cam_quang_cao');
      }
    }
    const multi = await ct.draftMulti('b', ['facebook', 'zalo'], { sku: ALCOHOL[0] }, f.d);
    expect(new Set(Object.values(multi).map((r) => r.meta.refused?.code))).toEqual(
      new Set(['ruou']),
    );
    expect(f.calls).toEqual([]);
  });

  it('ads TPBVSK chưa XNQC → xnqc, 0 LLM; QC_DAY_DU → được sinh, code chèn khuyến cáo/nhãn QC/nhãn AI', async () => {
    const f = fakeAi(['Savina 12 viên hỗ trợ giảm ho.']);
    const r = await ct.draft('b', 'facebook', { sku: 'savina-12v', contentType: 'ads' }, f.d);
    expect(r.meta.refused?.code).toBe('xnqc');
    expect(f.calls).toEqual([]);
    expect(codes(r.guardrail)).toContain('sku_chua_xnqc');
    const qc = new Map([[readinessKey('savina-12v', 'facebook'), 'QC_DAY_DU']]);
    const r2 = await ct.draft(
      'b',
      'facebook',
      { sku: 'savina-12v', contentType: 'ads', readiness: qc },
      f.d,
    );
    expect(f.calls.length).toBe(1); // không tốn lượt sửa
    expect(r2.meta.refused).toBeNull();
    expect(r2.guardrail.ok).toBe(true);
    for (const piece of [`${CANON}.`, AD, AI]) expect(r2.text).toContain(piece);
    expect([r2.meta.content_type, r2.meta.sku]).toEqual(['ads', 'savina-12v']);
    const g = fakeAi(['Sâm Sâm Quảng Nam — quà tặng.']);
    const r3 = await ct.draft('b', 'zalo', {}, g.d);
    expect(r3.text).not.toContain(CANON);
    expect(r3.text.endsWith(AI)).toBe(true);
  });

  it('SKU lạ / kênh lạ / loại lạ / ảnh / video → từ chối 0 LLM', async () => {
    const f = fakeAi(['x']);
    expect((await ct.draft('b', 'facebook', { sku: 'khong-co' }, f.d)).meta.refused?.code).toBe(
      'sku_la',
    );
    expect((await ct.draft('b', 'insta', { sku: 'savina-12v' }, f.d)).meta.refused?.code).toBe(
      'kenh_la',
    );
    for (const t of ['la', 'image', 'video']) {
      expect((await ct.draft('b', 'facebook', { contentType: t }, f.d)).meta.refused?.code).toBe(
        'loai_la',
      );
    }
    expect(f.calls).toEqual([]);
  });
});

describe('listing (W61.3)', () => {
  it('listing_rules + content_types listing đúng cấu hình', () => {
    const lr = JSON.parse(readFileSync(dataPath('listing_rules.json'), 'utf8')) as Any;
    expect(lr._doc).toContain('GIẢ ĐỊNH — chờ xác minh Seller Center');
    expect(new Set(Object.keys(lr.channels))).toEqual(new Set(LISTING_CH));
    expect([lr.missing_price, lr.missing_attr, lr.brand_keywords]).toEqual([
      'Liên hệ',
      'Xem trên bao bì',
      ['Sâm Sâm'],
    ]);
    const t = RULES.content_types.listing;
    expect([t.public, t.ad]).toEqual([true, false]);
    expect(t.trang_thai).toContain('chờ Pháp chế');
  });

  const claimFree = (text: string) => {
    const low = text.replace(CANON, '').toLowerCase();
    return CLAIM_VERBS.filter((v) =>
      new RegExp(`(?<![\\p{L}\\p{N}_])${v}(?![\\p{L}\\p{N}_])`, 'u').test(low),
    );
  };

  it('7 SKU TPBVSK mức MO_TA: thông số khớp golden byte-by-byte, không lộ floor/promo, 0 LLM', async () => {
    const f = fakeAi(['x']);
    const elig = eligible();
    expect(elig.length).toBe(7);
    for (const k of elig) {
      const g = GOLD[k] as Any;
      const r = await ct.listing(k, 'shopee', {}, f.d);
      expect(r.ok, k).toBe(true);
      const fl = r.fields as ct.Fields;
      expect([fl.name, fl.pack_spec, fl.receipt_no]).toEqual([g.name, g.pack_spec, g.receipt_no]);
      const lines = r.text.split('\n');
      expect(lines).toContain(`Quy cách: ${g.pack_spec}`);
      expect(lines).toContain(`Số ĐKSP: ${g.receipt_no}`);
      const price = lines.filter((ln) => ln.startsWith('Giá: '));
      expect(price.length).toBe(1);
      expect(price[0]?.replace(/\D/g, '')).toBe(String(g.prices.shopee.list));
      for (const kind of ['floor', 'promo']) {
        const v = g.prices.shopee[kind];
        expect(r.text).not.toContain(String(v));
        expect(r.text).not.toContain(ct.vnd(v).slice(0, -2));
      }
      expect(lines).toContain('Hạn sử dụng: Xem trên bao bì');
      expect(claimFree(r.text), k).toEqual([]);
      expect(r.text).toContain(`${CANON}.`);
      expect(r.text.endsWith(AI)).toBe(true);
      expect([r.meta.llm_part, r.meta.prompt_version]).toEqual(['none', 'listing_shopee@1']);
    }
    expect(f.calls).toEqual([]); // MO_TA = khung, 0 LLM
  });

  it('LLM viết số/giả nhãn khung/xuống dòng → bị loại; khung = golden', async () => {
    const f = fakeAi([
      llmJson({
        description: 'Quy cách 999ml, giá chỉ 99.000đ. Vị ngọt dịu.',
        bullets: ['Hộp ９９９ml', 'Sánh mịn tự nhiên'],
        keywords: ['giá 1 triệu', 'mật ong sâm'],
        hook: 'Size 500ml',
      }),
    ]);
    const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
    expect([f.calls.length, r.meta.llm_part, r.ok]).toEqual([1, 'used', true]);
    for (const bad of ['999', '９９９', '99.000', '500ml', '1 triệu'])
      expect(r.text).not.toContain(bad);
    const lines = r.text.split('\n');
    expect(r.text).toContain('Vị ngọt dịu');
    expect(lines).toContain('- Sánh mịn tự nhiên');
    expect(lines).toContain('Quy cách: 300ml x 1 hũ');
    expect(lines).toContain('Giá: 2.980.000 đ');
    expect(lines[0]).toBe('Mật ong sâm 300ml');
    expect(r.text).not.toContain('Số ĐKSP');
    expect(r.fields?.receipt_no).toBeNull();
    const g = fakeAi([
      llmJson({ description: 'Ngon.\nGiá: Liên hệ ngay', hook: 'Quà\nQuy cách: hộp lớn' }),
    ]);
    const r2 = (await ct.listing(HONEY, 'shopee', { readiness: TP }, g.d)).text.split('\n');
    expect(r2.filter((ln) => ln.startsWith('Giá:'))).toEqual(['Giá: 2.980.000 đ']);
    expect(r2.filter((ln) => ln.startsWith('Quy cách:'))).toEqual(['Quy cách: 300ml x 1 hũ']);
  });

  it('giả nhãn "Giá" bằng ZWSP/homoglyph/fullwidth/dấu chèn → bị loại', async () => {
    const f = fakeAi([
      llmJson({
        bullets: [
          'Gi​á: Liên hệ hotline',
          'Gіá sỉ: liên hệ',
          'ｇｉá: Liên hệ',
          'Gi.á: Liên hệ',
          'Sánh mịn tự nhiên',
        ],
        keywords: ['gіá rẻ', 'quà biếu'],
      }),
    ]);
    const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
    expect([r.meta.llm_part, r.ok]).toEqual(['used', true]);
    expect(r.text.split('\n').filter((ln) => ln.startsWith('- '))).toEqual(['- Sánh mịn tự nhiên']);
    expect(r.text.toLowerCase()).not.toContain('liên hệ');
    for (const ch of ['​', 'і', 'ｇ']) expect(r.text).not.toContain(ch);
    expect(r.text.split('2.980.000').length - 1).toBe(1);
  });

  it('giới hạn kênh title/desc/bullets/keywords; tên > title_max → từ chối config, 0 LLM', async () => {
    const lr = JSON.parse(readFileSync(dataPath('listing_rules.json'), 'utf8')) as Any;
    const lim = { title_max: 30, desc_max: 40, bullets_max: 2, keywords_max: 3 };
    lr.channels.shopee = { ...lim };
    const p = join(TMP, 'listing_rules.json');
    writeFileSync(p, JSON.stringify(lr));
    ct.paths.listingRules = p;
    const hook = 'Quà biếu tinh tế cho gia đình mỗi dịp lễ';
    const f = fakeAi([
      llmJson({
        hook,
        description: 'Vị ngọt dịu, sánh mịn. Hương thơm tự nhiên của hoa rừng. Quà biếu ý nghĩa.',
        bullets: [
          'Đóng hũ thủy tinh sạch',
          'Sánh mịn tự nhiên',
          'Màu vàng óng',
          'Thơm hoa rừng',
          'Hợp làm quà',
        ],
        keywords: ['mật ong sâm', 'quà biếu', 'quà tết', 'đặc sản', 'mật ong'],
      }),
    ]);
    const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
    expect([f.calls.length, r.meta.llm_part, r.ok]).toEqual([1, 'used', true]);
    const lines = r.text.split('\n');
    const name = 'Mật ong sâm 300ml';
    const full = `${name} – ${hook}`;
    const title = lines[0] as string;
    expect(
      full.length > lim.title_max && lim.title_max >= title.length && title.length > name.length,
    ).toBe(true);
    expect(full.startsWith(title) && full[title.length] === ' ').toBe(true);
    expect(lines[2]).toBe('Vị ngọt dịu, sánh mịn.');
    expect(lines.filter((ln) => ln.startsWith('- ')).length).toBe(2);
    expect(
      lines
        .find((ln) => ln.startsWith('Từ khóa: '))
        ?.slice(9)
        .split(', '),
    ).toEqual([name, 'Sâm Sâm', 'mật ong sâm']);
    lr.channels.shopee.title_max = 10;
    writeFileSync(p, JSON.stringify(lr));
    const r2 = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
    expect([r2.refused?.code, r2.text, r2.ok, f.calls.length]).toEqual(['config', '', false, 1]);
  });

  it('rượu từ chối kể cả map sửa thành QC_DAY_DU; readiness CAM/SKU lạ/kênh lạ → 0 LLM', async () => {
    const f = fakeAi([llmJson()]);
    for (const ch of LISTING_CH) {
      for (const sku of ALCOHOL) {
        for (const rm of [null, new Map([[readinessKey(sku, ch), 'QC_DAY_DU']])]) {
          const r = await ct.listing(sku, ch, { readiness: rm }, f.d);
          expect([r.refused?.code, r.ok, r.text]).toEqual(['ruou', false, '']);
        }
      }
    }
    for (const [sku, ch, code] of [
      ['savina-12v', 'tiktok', 'readiness'],
      ['saphraton-40v', 'shopee', 'readiness'],
      ['mat-ong-sam-120ml-1hu', 'shopee', 'readiness'],
      ['khong-co-sku', 'shopee', 'sku_la'],
      ['savina-12v', 'facebook', 'kenh_la'],
    ] as const) {
      const r = await ct.listing(sku, ch, {}, f.d);
      expect(r.refused?.code, `${sku}/${ch}`).toBe(code);
      expect([r.text, r.guardrail.ok]).toEqual(['', false]);
      expect(guardrailLines(r.guardrail)[0]?.[0]).toBe('error');
    }
    expect((await ct.listing('savina-12v', 'tiktok', {}, f.d)).refused?.reason).toContain('CAM');
    expect(
      (await ct.listing('savina-12v', 'shopee', { readiness: new Map() }, f.d)).refused?.code,
    ).toBe('readiness');
    expect(f.calls).toEqual([]);
  });

  it('LLM rác → khung; lỗi gateway → khung; "Ngọc Linh" → 1 lượt sửa rồi bỏ phần LLM', async () => {
    for (const bad of ['không phải json', '{"hook": 1}', '```json\n[1, 2]\n```']) {
      const f = fakeAi([bad]);
      const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
      expect([f.calls.length, r.ok, r.meta.llm_part]).toEqual([1, true, 'dropped:parse']);
      expect(r.text.split('\n')).toContain('Quy cách: 300ml x 1 hũ');
    }
    const g = fakeAi([], new GatewayError('down'));
    const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, g.d);
    expect([r.ok, r.meta.llm_part]).toEqual([true, 'dropped:GatewayError']);
    const h = fakeAi([llmJson({ description: 'Mật ong từ vùng Ngọc Linh. Sâm Ngọc Linh thơm.' })]);
    const r2 = await ct.listing(HONEY, 'shopee', { readiness: TP }, h.d);
    expect(h.calls.length).toBe(2);
    expect(lastUser(h.calls, 1)).toContain('ngoc_linh_chua_xac_nhan');
    expect([r2.meta.llm_part, r2.ok, r2.text.includes('Ngọc Linh')]).toEqual([
      'dropped:guardrail',
      true,
      false,
    ]);
  });

  it('TP_THUONG llm=false → khung, 0 LLM; thiếu giá list → "Liên hệ" (không lộ floor)', async () => {
    const f = fakeAi([llmJson()]);
    const r = await ct.listing(HONEY, 'shopee', { readiness: TP, llm: false }, f.d);
    expect([r.ok, r.meta.llm_part, f.calls.length]).toEqual([true, 'none', 0]);
    const r2 = await ct.listing(
      'saphraton-40v',
      'shopee',
      { readiness: new Map([[readinessKey('saphraton-40v', 'shopee'), 'MO_TA']]) },
      f.d,
    );
    expect(r2.ok).toBe(true);
    expect(r2.text.split('\n')).toContain('Giá: Liên hệ');
    expect(r2.text).not.toContain('450');
  });

  it('cấu hình listing ad=true → chặn TPBVSK chưa XNQC (precheck + chính guardrail)', async () => {
    const f = fakeAi(['x']);
    const frame = (await ct.listing('savina-12v', 'shopee', {}, f.d)).text;
    const d = join(TMP, 'data');
    mkdirSync(d, { recursive: true });
    for (const n of [
      'banned_words.txt',
      'claims_whitelist.json',
      'golden_skus.json',
      'llm_gateway.json',
    ]) {
      cpSync(join(DATA_DIR, n), join(d, n));
    }
    const rules = structuredClone(RULES);
    rules.content_types.listing.ad = true;
    writeFileSync(join(d, 'guardrail_rules.json'), JSON.stringify(rules));
    ct.setContentDataDir(d);
    const r = await ct.listing('savina-12v', 'shopee', {}, f.d);
    expect(r.refused?.code).toBe('xnqc');
    expect(codes(r.guardrail)).toContain('sku_chua_xnqc');
    const g = checkPublish(frame, { channel: 'shopee', contentType: 'listing', sku: 'savina-12v' });
    expect(codes(g)).toContain('sku_chua_xnqc');
  });

  it('lớp LLM-check áp cho listing (chỉ lớp check, 0 lời gọi content)', async () => {
    const f = fakeAi(['{"flag": true, "reasons": [{"quote": "Savina", "why": "ẩn ý"}]}']);
    const r = await ct.listing(
      'savina-12v',
      'shopee',
      {},
      { ai: f.ai, env: { GUARDRAIL_LLM_MODEL: 'google/gemini-test' } },
    );
    expect([r.ok, r.guardrail.llm_check]).toEqual([false, 'flag']);
    expect(codes(r.guardrail)).toContain('llm_ngam_y_suc_khoe');
    expect(f.calls.map((c) => c.agent)).toEqual(['guardrail_llm']);
  });

  it('module không có đường đăng/duyệt/xếp lịch/gọi mạng ngoài gateway', () => {
    for (const f of ['./content.ts', './mkt-calendar.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/setStatus|approve_draft|schedule\(|\bfetch\(|node:https?|undici/);
    }
    expect(REPO_ROOT).toBeTruthy();
  });
});

// ================================================================ CLI (không DB)

const FAKE_DB = { query: () => Promise.reject(new Error('không được chạm DB')) } as unknown as Db;
function cli(over: Partial<ContentDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const f = fakeAi([SAFE_TEXT]);
  let connected = 0;
  const deps: ContentDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    env: ENV,
    connect: async () => {
      connected++;
      return { db: FAKE_DB, release: async () => {} };
    },
    wire: () => f.ai,
    ...over,
  };
  return { out, err, calls: f.calls, deps, connected: () => connected };
}

describe('CLI content (W61.4 + v13.6)', () => {
  beforeEach(() => {
    settings.forceMode = 'van_hanh';
  });

  it('tham số sai → exit 2 TRƯỚC mọi kết nối', async () => {
    for (const o of [
      { sku: ['all'], channel: ['shopee'] },
      { listing: true, sku: ['all'], channel: ['facebook'] },
      { listing: true, channel: ['shopee'] },
      { listing: true, sku: ['all'] },
      { listing: true, sku: ['all'], channel: ['shopee'], by: '  ' },
      { daily: true, sku: ['a'] },
      { daily: true, channel: ['web'] },
      { daily: true, by: 'x' },
      { daily: true, llm: false },
      { listing: true, sku: ['a'], channel: ['shopee'], date: '2026-10-15' },
      { daily: true, date: '15/10/2026' },
      { daily: true, date: '2026-02-30' },
      { daily: true, listing: true },
    ]) {
      const c = cli();
      expect(await contentMain(o, c.deps), JSON.stringify(o)).toBe(2);
      expect(c.connected()).toBe(0);
      expect(c.err.at(-1)).toMatch(/^python -m pipelines\.content: error: /);
    }
  });

  it('DB chết → exit 2, 0 lời gọi LLM (listing + daily)', async () => {
    for (const o of [
      { listing: true, sku: ['all'], channel: ['shopee'] },
      { daily: true, date: '2026-10-15' },
    ]) {
      const c = cli({ connect: async () => null });
      expect(await contentMain(o, c.deps)).toBe(2);
      expect(c.calls).toEqual([]);
      expect(c.err.join('\n')).toContain('không ghi được');
      expect(c.out).toEqual([]);
    }
  });

  it('listing: dòng in + exit 0/1 theo failed; --no-llm/--by truyền xuống batch', async () => {
    const items: ct.BatchItem[] = [
      { sku: 'a', channel: 'shopee', status: 'created', id: '1' },
      { sku: 'b', channel: 'shopee', status: 'skipped', id: '2' },
      { sku: 'c', channel: 'web', status: 'refused', code: 'ruou', reason: 'rượu' },
    ];
    const seen: Any[] = [];
    const c = cli({
      listingBatch: async (_db, skus, chs, o) => {
        seen.push({ skus, chs, o });
        return items;
      },
    });
    expect(
      await contentMain(
        { listing: true, sku: ['a'], channel: ['shopee'], by: ' Lan ', llm: false },
        c.deps,
      ),
    ).toBe(0);
    expect(seen[0]).toEqual({ skus: ['a'], chs: ['shopee'], o: { by: 'Lan', llm: false } });
    const out = c.out.join('\n');
    for (const s of [
      'a × shopee: created #1',
      'b × shopee: skipped #2',
      'c × web: refused ruou: rượu',
      'created 1, skipped 1, refused 1, failed 0',
    ]) {
      expect(out).toContain(s);
    }
    items.push({ sku: 'd', channel: 'tiktok', status: 'failed', codes: ['thieu_nhan_ai'] });
    expect(await contentMain({ listing: true, sku: ['all'], channel: ['shopee'] }, c.deps)).toBe(1);
    expect(c.out.join('\n')).toContain('d × tiktok: failed: thieu_nhan_ai');
    expect(seen[1].skus).toEqual(Object.keys(GOLD)); // 'all' = mọi SKU golden
    expect(seen[1].o).toEqual({ by: ct.DEFAULT_BY, llm: true });
  });

  it('listing tắt (sales-03 tat) → [rollout] exit 2, 0 LLM, không gọi batch', async () => {
    settings.forceMode = 'tat';
    const c = cli({ listingBatch: async () => expect.fail('không được chạy batch') });
    expect(await contentMain({ listing: true, sku: ['all'], channel: ['shopee'] }, c.deps)).toBe(2);
    expect(c.out[0]).toMatch(/^\[rollout\] listing: tính năng sales-03 đang tắt/);
    expect(c.calls).toEqual([]);
  });

  it('daily: THIẾU → exit 1 + dòng in; đủ → exit 0', async () => {
    const res: ct.DailyResult = {
      day: '2026-10-15',
      per_day: 3,
      live: 2,
      missing: 1,
      items: [
        {
          slot: 1,
          status: 'created',
          id: '7',
          kind: 'evergreen',
          ref: 'thuong-hieu',
          channel: 'facebook',
          sku: null,
        },
        { slot: 2, status: 'skipped', id: '5' },
      ],
      refused: [
        {
          kind: 'evergreen',
          ref: 'san-pham',
          channel: 'facebook',
          sku: null,
          pillar: 'p',
          publish_day: null,
          note: '',
          reason: 'thiếu SKU',
          code: 'readiness',
        },
      ],
      overflow: [
        {
          kind: 'campaign',
          ref: 'c-x',
          channel: 'zalo',
          sku: null,
          pillar: 'p',
          publish_day: '2026-10-17',
          note: '',
          reason: null,
        },
      ],
      reasons: ['chỉ 2/3 chủ đề hợp lệ'],
    };
    const c = cli({ dailyBatch: async () => res });
    expect(await contentMain({ daily: true, date: '2026-10-15' }, c.deps)).toBe(1);
    const out = c.out.join('\n');
    for (const s of [
      '# Nháp bài ngày 15/10/2026 — cần 3/ngày (PL01 Marketing)',
      '#1 evergreen:thuong-hieu × facebook: created #7',
      '#2 skipped (đã có nháp #5)',
      '[bị từ chối] evergreen:san-pham × facebook: readiness — thiếu SKU',
      '[vượt 3/ngày] chiến dịch c-x × zalo — GĐ Marketing quyết dời/thêm',
      '[THIẾU] 1/3 nháp: chỉ 2/3 chủ đề hợp lệ',
      '[done] 2/3',
    ]) {
      expect(out).toContain(s);
    }
    Object.assign(res, { live: 3, missing: 0, reasons: [] });
    expect(await contentMain({ daily: true, date: '2026-10-15' }, c.deps)).toBe(0);
    const d = cli({
      dailyBatch: async (_db, day) => ({ ...res, day }),
      now: () => new Date('2026-10-15T20:00:00Z'),
    });
    expect(await contentMain({ daily: true }, d.deps)).toBe(0);
    expect(d.out.at(-1)).toContain('ngày 2026-10-16'); // mặc định = hôm nay giờ VN
  });

  it('daily tắt (marketing-01.1 tat) → [blocked] exit 2, 0 LLM; lịch hỏng → exit 1', async () => {
    settings.forceMode = 'tat';
    const c = cli();
    expect(await contentMain({ daily: true, date: '2026-10-15' }, c.deps)).toBe(2);
    expect(c.calls).toEqual([]);
    expect(c.err[0]).toMatch(/^\[blocked\] nháp bài hằng ngày: tính năng marketing-01\.1 đang tắt/);
    settings.forceMode = 'van_hanh';
    const { CalendarError } = await import('./mkt-calendar.js');
    const e = cli({
      dailyBatch: async () => {
        throw new CalendarError('events rỗng');
      },
    });
    expect(await contentMain({ daily: true, date: '2026-10-15' }, e.deps)).toBe(1);
    expect(e.err[0]).toBe('[error] lịch mùa vụ: events rỗng');
  });
});

// ================================================================ fail-closed cấu hình + PII

describe('fail-closed: cấu hình hỏng → từ chối, 0 LLM; SĐT cá nhân trong bài → chặn', () => {
  const brokenDir = (name: string, mutate: (rules: Any) => unknown) => {
    const d = join(TMP, name);
    mkdirSync(d, { recursive: true });
    for (const n of ['banned_words.txt', 'claims_whitelist.json', 'golden_skus.json']) {
      cpSync(join(DATA_DIR, n), join(d, n));
    }
    writeFileSync(join(d, 'guardrail_rules.json'), JSON.stringify(mutate(structuredClone(RULES))));
    return d;
  };

  it('guardrail_rules hỏng (thiếu disclaimer / family rỗng alias) → precheck config, draft/listing từ chối, --sku all exit 2', async () => {
    for (const [name, mut] of [
      ['r1', (r: Any) => ({ ...r, disclaimer: {} })],
      [
        'r2',
        (r: Any) => {
          for (const f of Object.values(r.families) as Any[]) f.aliases = [];
          return r;
        },
      ],
      ['r3', () => []],
    ] as [string, (r: Any) => unknown][]) {
      ct.setContentDataDir(brokenDir(name, mut));
      const ref = ct.precheck('savina-12v', 'facebook', 'post');
      expect(ref?.code, name).toBe('config');
      expect(ref?.reason).toContain('file luật guardrail/golden không dùng được');
      const f = fakeAi([SAFE_TEXT]);
      expect((await ct.draft('b', 'facebook', { sku: 'savina-12v' }, f.d)).meta.refused?.code).toBe(
        'config',
      );
      expect((await ct.listing('savina-12v', 'shopee', {}, f.d)).refused?.code).toBe('config');
      expect(f.calls).toEqual([]);
      const c = cli();
      expect(await contentMain({ listing: true, sku: ['all'], channel: ['shopee'] }, c.deps)).toBe(
        2,
      );
      expect(c.err[0]).toMatch(/^\[error\] file luật guardrail\/golden không dùng được/);
      expect(c.connected()).toBe(0);
    }
  });

  it('listing_rules.json hỏng (thiếu/giới hạn < 1/missing_price rỗng) → listing config, 0 LLM', async () => {
    const lr = JSON.parse(readFileSync(dataPath('listing_rules.json'), 'utf8')) as Any;
    for (const [i, doc] of [
      null,
      { ...lr, channels: { ...lr.channels, shopee: { ...lr.channels.shopee, bullets_max: 0 } } },
      { ...lr, missing_price: ' ' },
      { ...lr, channels: {} },
    ].entries()) {
      const p = join(TMP, `lr${i}.json`);
      if (doc !== null) writeFileSync(p, JSON.stringify(doc));
      ct.paths.listingRules = p;
      const f = fakeAi([llmJson()]);
      const r = await ct.listing(HONEY, 'shopee', { readiness: TP }, f.d);
      expect([r.refused?.code, r.ok, f.calls.length], String(i)).toEqual(['config', false, 0]);
      expect(r.refused?.reason).toMatch(/^listing_rules\.json không dùng được \(/);
    }
  });

  it('LLM chèn SĐT cá nhân → guardrail đăng bài chặn pii_ca_nhan (không trả bài ok)', async () => {
    const f = fakeAi([`Liên hệ chị Lan 0912 345 678 để đặt quà.\n\n${AI}`]);
    const r = await ct.draft('x', 'facebook', {}, f.d);
    expect(r.guardrail.ok).toBe(false);
    expect(codes(r.guardrail)).toContain('pii_ca_nhan');
  });
});
