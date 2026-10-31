import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { createGateway } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { check, readinessKey } from '@samsam/core/security/guardrail';
import { checkPublishLlm } from '@samsam/core/security/guardrail-llm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import G from './__fixtures__/image_video.golden.json' with { type: 'json' };
import * as ims from './image-studio.js';
import { videoStudioMain } from './image-video.command.js';
import type { Raw } from './raster.js';
import * as raster from './raster.js';
import * as vs from './video-studio.js';

// Dịch tests/test_video_studio.py (v6.3 MKT-04). Kịch bản: AI Gateway GIẢ (đếm lời gọi, 0 mạng) —
// golden do `write_script` Python THẬT sinh với cùng câu trả lời LLM giả (so messages gửi đi + kết
// quả). Dựng mp4 thật chỉ khi có ffmpeg (FFMPEG_BIN/PATH) + font + sharp. Phần DB ở
// image-video.db.test.ts.

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON golden
type Any = any;
const g = G as Any;
const RULES = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8')) as Any;
const AI: string = RULES.labels.ai[0];
const AD: string = RULES.labels.ad[0];
const GOLDEN = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as Any;
const GOLD: Record<string, Any> = Object.fromEntries(GOLDEN.skus.map((s: Any) => [s.sku_key, s]));
const HONEY = 'mat-ong-sam-300ml';
const R_OK = new Map([[readinessKey(HONEY, 'tiktok'), 'TP_THUONG']]);
const ALCOHOL = Object.keys(GOLD).filter((k) => GOLD[k].category === 'alcohol');
const TPBVSK = Object.keys(GOLD).filter((k) => GOLD[k].category === 'tpbvsk');
const BRIEF = 'Quà tặng từ núi rừng Quảng Nam';
const CLEAN = [
  'Núi rừng Quảng Nam xanh mướt',
  'Sương sớm phủ vùng trồng',
  'Ong làm mật bên hoa rừng',
  'Mật ong sóng sánh vàng óng',
  'Gói quà tặng người thân',
  'Hương vị đặc sản quê nhà',
  'Nắng sớm trên đồi xanh',
  'Chiếc hộp quà mộc mạc',
  'Ấm áp ngày sum vầy',
  'Quà quê gửi phương xa',
  'Thương hiệu Sâm Sâm Quảng Nam',
  'Món quà tử tế cho người thương',
];
const SCENES5 = [
  { text: 'Quà tặng từ núi rừng Quảng Nam', visual: 'packshot' },
  { text: 'Mật ong vàng óng từ vùng trồng sâm', visual: 'broll' },
  { text: 'Gói trọn tấm lòng gửi người thân', visual: 'packshot' },
  { text: 'Đặc sản quê hương trong từng giọt', visual: 'broll' },
  { text: 'Món quà tử tế cho dịp sum vầy', visual: 'packshot' },
];
const js = (scenes: unknown) => JSON.stringify({ scenes });
const cl = (ts: string[], visual = 'packshot') => ts.map((text) => ({ text, visual }));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** AI Gateway giả: trả lần lượt `answers` (lặp câu cuối), ghi (agent, messages, opts); Error → ném. */
function fakeLlm(...answers: (string | Error)[]) {
  const calls: [string, ChatMessage[], Any][] = [];
  const ai = {
    chat: async (agent: string, messages: ChatMessage[], opts: Any) => {
      calls.push([agent, structuredClone(messages), opts]);
      const a = answers[Math.min(calls.length, answers.length) - 1];
      if (a instanceof Error) throw a;
      return {
        text: a as string,
        model: 'fake/test-llm',
        provider: 'ollama' as const,
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  };
  return { calls, ai };
}

const TMP = mkdtempSync(join(tmpdir(), 'video-studio-'));
let n = 0;
const fresh = (p: string) => join(TMP, `${p}-${++n}`);
const files = (d: string): string[] => {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
};
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  vs.vhooks.compose = ims.compose;
  vs.vhooks.encode = REAL.encode;
  vs.vhooks.extractFrame = REAL.extractFrame;
  vs.vhooks.findFfmpeg = REAL.findFfmpeg;
  settings.forceMode = null;
});
const REAL = { ...vs.vhooks };

let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}
const FF = vs.findFfmpeg(process.env);
const RENDER =
  HAS_SHARP &&
  ims.fontsFor(`${AI} ${AD} MẪU ${BRIEF} ${SCENES5.map((s) => s.text).join('')}`, {}) !== null;
const ENV: Record<string, string> = FF ? { FFMPEG_BIN: FF } : {};

let PK = '';
beforeAll(async () => {
  PK = fresh('pk');
  mkdirSync(PK);
  if (RENDER) await ims.makeSamplePackshot(join(PK, `${HONEY}.png`), HONEY);
  else writeFileSync(join(PK, `${HONEY}.png`), 'x'); // chỉ để qua kiểm "có packshot"
});

const ws = (ai: Any, kw: Any = {}) =>
  vs.writeScript(
    kw.sku === undefined ? HONEY : kw.sku,
    kw.channel ?? 'tiktok',
    kw.brief ?? BRIEF,
    {
      fmt: kw.fmt,
      readiness: 'readiness' in kw ? kw.readiness : R_OK,
    },
    { ai, env: {} },
  );
const make = (pk: string, out: string, ai: Any, kw: Any = {}) =>
  vs.makeVideo(
    HONEY,
    kw.channel ?? 'tiktok',
    kw.brief ?? BRIEF,
    {
      fmt: kw.fmt ?? '9:16',
      readiness: R_OK,
      packshotDir: pk,
      brollDir: kw.brollDir ?? join(pk, '..', 'no-broll'),
      outDir: out,
    },
    { ai, env: { ...ENV, ...(kw.env ?? {}) } },
  );

// ============================================================== golden thuần (Python thật)

describe('golden thuần (Python video_studio)', () => {
  it('_banned (biến thể người y tế / trước-sau; "trước khi dùng" không cấm)', () => {
    const [cfg] = vs.loadConfig();
    for (const [t, want] of g.banned)
      expect(vs.banned(t, cfg?.script_banned ?? []), t).toEqual(want);
  });
  it('check_brief', () => {
    for (const [b, want] of g.check_brief)
      expect(vs.checkBrief(b), JSON.stringify(b)).toEqual(want);
  });
  it('_parse_scenes (JSON chặt, 1 lớp code-fence)', () => {
    for (const [t, want] of g.parse_scenes)
      expect(vs.parseScenes(t), JSON.stringify(t)).toEqual(want);
    // Khác có chủ đích (TS chặt hơn, fail-closed): Python `json.loads` nhận NaN/Infinity/-Infinity
    // (đã chạy: ra 1 cảnh), JSON.parse từ chối → null → từ chối `kich_ban`.
    const TS_STRICTER = ['NaN', 'Infinity', '-Infinity'].map(
      (v) => `{"scenes":[{"text":"a","visual":"packshot","n":${v}}]}`,
    );
    for (const t of TS_STRICTER) expect(vs.parseScenes(t), t).toBeNull();
  });
  it('_filter (so_lieu/dai/thua)', () => {
    const [cfg] = vs.loadConfig();
    for (const [sc, want] of g.filter)
      expect(vs.filterScenes(sc, cfg as vs.VideoCfg)).toEqual(want);
  });
  it('_duration_ms + _msgs_sha', () => {
    for (const [s, want] of g.duration) expect(vs.durationMs(s)).toBe(want);
    for (const [m, want] of g.msgs_sha) expect(vs.msgsSha(m)).toBe(want);
  });
  it('load_config (đột biến thời lượng/format/từ cấm → lý do y hệt Python)', () => {
    const base = JSON.parse(readFileSync(dataPath('video_studio.json'), 'utf8'));
    const dir = fresh('vcfg');
    mkdirSync(dir);
    for (const [name, [patch, err]] of Object.entries(g.video_config) as Any) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, name === 'list' ? '[]' : JSON.stringify({ ...base, ...patch }));
      expect(vs.loadConfig(p)[1], name).toBe(err);
    }
  });
  it('write_script: messages gửi LLM + kết quả y hệt Python (10 kịch bản LLM giả)', async () => {
    for (const [name, c] of Object.entries(g.write_script) as Any) {
      const f = fakeLlm(...c.answers);
      const r = await ws(f.ai);
      const { guardrail, ...rest } = r;
      expect(rest, name).toEqual(c.res);
      expect(guardrail?.ok, name).toBe(c.g_ok);
      expect(
        ((guardrail?.violations ?? []) as Any[]).map((v) => v.code),
        name,
      ).toEqual(c.g_codes);
      expect(f.calls.length, name).toBe(c.calls.length);
      for (const [i, pc] of c.calls.entries()) {
        const [agent, msgs, opts] = f.calls[i] as Any;
        expect(agent).toBe(pc.agent);
        expect(msgs, `${name} call ${i}`).toEqual(pc.messages);
        expect(opts).toEqual({
          feature: pc.kw.feature,
          temperature: pc.kw.temperature,
          maxTokens: pc.kw.max_tokens,
        });
      }
    }
  });
});

// ============================================================== từ chối trước LLM

describe('kịch bản (LLM giả)', () => {
  it.each(
    ALCOHOL.flatMap((sku) =>
      ['tiktok', 'facebook'].flatMap((ch) => [false, true].map((inj) => [sku, ch, inj])),
    ),
  )('rượu %s × %s (tiêm QC_DAY_DU=%s) → ruou, 0 LLM, 0 file', async (sku, ch, inject) => {
    const f = fakeLlm(js(SCENES5));
    const rm = inject ? new Map([[readinessKey(sku as string, ch as string), 'QC_DAY_DU']]) : null;
    const r = await ws(f.ai, { sku, channel: ch, readiness: rm });
    expect(r.refused?.code).toBe('ruou');
    expect(r.ok).toBe(false);
    const out = fresh('o');
    const m = await vs.makeVideo(
      sku,
      ch,
      BRIEF,
      { readiness: rm, packshotDir: PK, outDir: out },
      { ai: f.ai, env: {} },
    );
    expect(m.refused?.code).toBe('ruou');
    expect(f.calls).toEqual([]);
    expect(files(out)).toEqual([]);
  });

  it('TPBVSK cần maket XNQC, 0 LLM', async () => {
    const f = fakeLlm(js(SCENES5));
    for (const rm of [null, new Map([[readinessKey('sapentol-30v', 'tiktok'), 'QC_DAY_DU']])]) {
      const r = await ws(f.ai, {
        sku: 'sapentol-30v',
        brief: 'video TikTok Sapentol hook mới',
        readiness: rm,
      });
      expect(r.refused?.code).toBe('maket_xnqc');
      expect(r.refused?.reason).toContain('creative TPBVSK phải dùng maket XNQC');
    }
    expect(TPBVSK.length).toBe(8);
    for (const sku of TPBVSK)
      expect((await ws(f.ai, { sku, readiness: null })).refused?.code).toBe('maket_xnqc');
    expect(f.calls).toEqual([]);
  });

  it('readiness / kênh / format / SKU → 0 LLM', async () => {
    const f = fakeLlm(js(SCENES5));
    expect((await ws(f.ai, { sku: 'mat-ong-sam-120ml-1hu', readiness: null })).refused?.code).toBe(
      'readiness',
    );
    expect(
      (
        await ws(f.ai, {
          channel: 'zalo',
          readiness: new Map([[readinessKey(HONEY, 'zalo'), 'TP_THUONG']]),
        })
      ).refused?.code,
    ).toBe('kenh_la');
    expect((await ws(f.ai, { channel: 'zalo' })).refused?.code).toBe('kenh_la');
    expect((await ws(f.ai, { fmt: '4:5' })).refused?.code).toBe('format_la');
    expect((await ws(f.ai, { sku: null })).refused?.code).toBe('sku_la');
    expect(f.calls).toEqual([]);
  });

  it.each([
    'bác sĩ khuyên dùng mật ong sâm',
    'BÁC SĨ KHUYÊN DÙNG mật ong'.normalize('NFD'),
    'sâm chữa tiểu đường',
    'x'.repeat(501),
    '   ',
    'chuyên-gia gợi ý quà tặng',
    'Bác sỹ tin chọn mật ong',
    'Trước và sau khi dùng mật ong',
  ])('brief cấm %# → brief_cam, 0 LLM', async (brief) => {
    const f = fakeLlm(js(SCENES5));
    expect((await ws(f.ai, { brief })).refused?.code).toBe('brief_cam');
    expect(f.calls).toEqual([]);
  });

  it('brief 500 vs 501 ký tự', () => {
    expect(vs.checkBrief(`Quà ${'a'.repeat(496)}`)).toBeNull();
    expect(vs.checkBrief(`Quà ${'a'.repeat(497)}`)?.code).toBe('brief_cam');
  });

  it('"bác sĩ khuyên dùng" trong kịch bản → 1 lượt sửa, vẫn vi phạm → kich_ban, 0 file', async () => {
    const bad = js([
      { text: 'Bác sĩ khuyên dùng mỗi sáng', visual: 'packshot' },
      ...cl(CLEAN.slice(0, 3)),
    ]);
    let f = fakeLlm(bad);
    const r = await ws(f.ai);
    expect(r.refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(2);
    expect(r.refused?.reason).toContain('bác sĩ');
    expect(r.llm_calls).toBe(2);
    f = fakeLlm(bad);
    const out = fresh('o');
    const m = await make(PK, out, f.ai);
    expect(m.refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(2);
    expect(files(out)).toEqual([]);
  });

  it('vi phạm rồi sạch: feedback có từ cấm, lượt 2 ok', async () => {
    const f = fakeLlm(
      js([{ text: 'Bác sĩ khuyên dùng mỗi sáng', visual: 'broll' }, ...cl(CLEAN.slice(0, 3))]),
      js(SCENES5),
    );
    const r = await ws(f.ai);
    expect(r.ok).toBe(true);
    expect(f.calls.length).toBe(2);
    const fb = (f.calls[1] as Any)[1].at(-1);
    expect(fb.role).toBe('user');
    expect(fb.content).toContain('Trả lại DUY NHẤT JSON');
    expect(fb.content).toContain('bác sĩ');
    expect((f.calls[1] as Any)[1].at(-2).role).toBe('assistant');
    expect(r.scenes.map((s) => s.text)).toEqual(SCENES5.map((s) => s.text));
    expect(f.calls.every((c) => c[0] === 'mkt_video')).toBe(true);
  });

  it.each([
    ['Bác sỹ tin chọn', 'bác sỹ'],
    ['Dược sỹ tin chọn', 'dược sỹ'],
    ['Y sĩ gợi ý', 'y sĩ'],
    ['Y sỹ gợi ý', 'y sỹ'],
    ['Lương y gợi ý dùng', 'lương y'],
    ['Thầy thuốc gợi ý', 'thầy thuốc'],
    ['Trước và sau khi dùng', 'trước và sau'],
    ['So sánh trước khi dùng và sau khi dùng', 'so sánh trước'],
  ])('biến thể người y tế / trước-sau "%s" bị chặn', async (line, term) => {
    const f = fakeLlm(js([{ text: line, visual: 'broll' }, ...cl(CLEAN.slice(0, 3))]));
    const r = await ws(f.ai);
    expect(r.refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(2);
    expect(r.refused?.reason).toContain(term);
  });

  it('từ cấm trong câu BỊ BỎ (có số) vẫn tính vi phạm', async () => {
    const f = fakeLlm(
      js([{ text: 'Bác sĩ khuyên dùng 2 thìa', visual: 'broll' }, ...cl(CLEAN.slice(0, 3))]),
    );
    expect((await ws(f.ai)).refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(2);
  });

  it('caption vi phạm guardrail → kich_ban (guardrail ok=false có violations), 0 file', async () => {
    const bad = js([
      { text: 'Sâm giúp chữa khỏi tiểu đường', visual: 'broll' },
      ...cl(CLEAN.slice(0, 3)),
    ]);
    const f = fakeLlm(bad);
    const r = await ws(f.ai);
    expect(r.refused?.code).toBe('kich_ban');
    expect(r.refused?.reason).toContain('guardrail');
    expect(r.guardrail?.ok).toBe(false);
    const out = fresh('o');
    expect((await make(PK, out, fakeLlm(bad).ai)).refused?.code).toBe('kich_ban');
    expect(files(out)).toEqual([]);
  });

  it('câu số/giá bị bỏ, không chữ số trong cảnh/caption', async () => {
    const f = fakeLlm(
      js([
        ...cl(['Chỉ 350.000đ một hũ', 'Hũ 300ml', 'ba trăm nghìn', '１００%']),
        ...cl(CLEAN.slice(0, 3)),
      ]),
    );
    const r = await ws(f.ai);
    expect(r.ok).toBe(true);
    expect(f.calls.length).toBe(1);
    expect(r.scenes.map((s) => s.text)).toEqual(CLEAN.slice(0, 3));
    expect(r.dropped.map((d) => d.ly_do)).toEqual(['so_lieu', 'so_lieu', 'so_lieu', 'so_lieu']);
    expect(r.caption).not.toContain('350');
    expect(r.caption).not.toContain('300');
  });

  it('câu dài bị bỏ; còn < min_scenes → kich_ban (guardrail không ok); vượt max → thua', async () => {
    const long61 = `Núi rừng ${'x'.repeat(52)}`;
    let r = await ws(fakeLlm(js(cl([long61, ...CLEAN.slice(0, 3)]))).ai);
    expect(r.ok).toBe(true);
    expect(r.dropped).toEqual([{ text: long61, ly_do: 'dai' }]);
    const f = fakeLlm(js(cl(CLEAN.slice(0, 2))));
    r = await ws(f.ai);
    expect(r.refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(1);
    expect(r.refused?.reason).toContain('còn 2 cảnh');
    expect(r.guardrail?.ok).toBe(false);
    r = await ws(fakeLlm(js(cl(CLEAN))).ai);
    expect(r.ok).toBe(true);
    expect(r.scenes.length).toBe(10);
    expect(r.dropped.map((d) => d.ly_do)).toEqual(['thua', 'thua']);
  });

  it.each([
    'không phải JSON',
    '{"scenes": "x"}',
    '{"x": []}',
    '{"scenes": []}',
    '{"scenes": [{"text": "a", "visual": "người mẫu"}]}',
    '[]',
  ])('JSON sai mẫu %# → kich_ban sau 1 lời gọi', async (ans) => {
    const f = fakeLlm(ans);
    expect((await ws(f.ai)).refused?.code).toBe('kich_ban');
    expect(f.calls.length).toBe(1);
  });

  it('code-fence JSON được nhận', async () => {
    expect((await ws(fakeLlm(`\`\`\`json\n${js(SCENES5)}\n\`\`\``).ai)).ok).toBe(true);
  });

  it('gateway chặn (kill/trần) → error "llm: GatewayBlocked", 0 file', async () => {
    const f = fakeLlm(new GatewayBlocked("agent 'mkt_video' đang bị kill-switch"));
    const r = await ws(f.ai);
    expect(r.ok).toBe(false);
    expect(r.refused).toBeNull();
    expect(r.error?.startsWith('llm: GatewayBlocked')).toBe(true);
    expect(f.calls.length).toBe(1);
    const out = fresh('o');
    const m = await make(PK, out, f.ai);
    expect(m.error?.startsWith('llm')).toBe(true);
    expect(files(out)).toEqual([]);
  });

  it('gateway THẬT + LLM_KILL=mkt_video → "llm: GatewayBlocked" TRƯỚC mạng', async () => {
    // Python test_real_gateway_kill_switch: chat thật, `_client` không được tạo.
    let net = 0;
    const ai = createGateway(null, {
      env: { LLM_KILL: 'mkt_video' },
      fetch: async () => {
        net++;
        throw new Error('không được gọi mạng');
      },
      warn: () => {},
    });
    const r = await ws(ai);
    expect(r.error?.startsWith('llm: GatewayBlocked'), r.error ?? '').toBe(true);
    expect(net).toBe(0);
  });

  it('caption có nhãn AI + QC, qua guardrail đăng bài; model/prompt ghi lại', async () => {
    const r = await ws(fakeLlm(js(SCENES5)).ai);
    expect(r.ok).toBe(true);
    expect(r.caption).toContain(AI);
    expect(r.caption).toContain(AD);
    const gr = await checkPublishLlm(
      r.caption,
      { channel: 'tiktok', contentType: 'video', sku: HONEY, isAi: true, readiness: R_OK },
      { gateway: null, env: {} },
    );
    expect(gr.ok).toBe(true);
    expect(r.model).toBe('fake/test-llm');
    expect(r.prompt_version).toBe('video_script@1');
    expect(r.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('template video_script: manifest + placeholder + guardrail; trần mkt_video', () => {
    const man = JSON.parse(readFileSync(dataPath('prompts', 'manifest.json'), 'utf8')).templates
      .video_script;
    expect(man.trang_thai).toContain('chờ GĐ Marketing duyệt');
    const tmpl = readFileSync(dataPath('prompts', 'video_script.md'), 'utf8');
    for (const ph of ['{channel}', '{sku_name}', '{brief}']) expect(tmpl).toContain(ph);
    expect(check(tmpl).ok).toBe(true);
    const cap = JSON.parse(readFileSync(dataPath('llm_gateway.json'), 'utf8')).monthly_cap_usd;
    expect(cap.mkt_video).toBe(2.0);
  });

  it('TTS lạ → tts, 0 LLM, 0 file; chỉ có `none`', async () => {
    const f = fakeLlm(js(SCENES5));
    const r = await vs.writeScript(
      HONEY,
      'tiktok',
      BRIEF,
      { readiness: R_OK },
      { ai: f.ai, env: { TTS_PROVIDER: 'elevenlabs' } },
    );
    expect(r.refused?.code).toBe('tts');
    const out = fresh('o');
    const m = await make(PK, out, f.ai, { env: { TTS_PROVIDER: 'elevenlabs' } });
    expect(m.refused?.code).toBe('tts');
    expect(m.refused?.reason).toContain('external-dep');
    expect(f.calls).toEqual([]);
    expect(files(out)).toEqual([]);
    expect(vs.TTS_PROVIDERS).toEqual({ none: null });
  });

  it('thiếu packshot → packshot_thieu, 0 LLM', async () => {
    const f = fakeLlm(js(SCENES5));
    const out = fresh('o');
    expect((await make(fresh('empty'), out, f.ai)).refused?.code).toBe('packshot_thieu');
    expect(f.calls).toEqual([]);
    expect(files(out)).toEqual([]);
  });

  it('thiếu ffmpeg → ffmpeg_thieu, kịch bản vẫn trả về', async () => {
    const f = fakeLlm(js(SCENES5));
    vs.vhooks.findFfmpeg = () => null;
    const out = fresh('o');
    const r = await make(PK, out, f.ai);
    expect(r.refused?.code).toBe('ffmpeg_thieu');
    expect(r.refused?.reason).toContain('external-dep');
    // Khác có chủ đích: TS chỉ tìm FFMPEG_BIN → PATH (không gói imageio-ffmpeg) — thông điệp nói đúng.
    expect(r.refused?.reason).toContain('(FFMPEG_BIN / PATH)');
    expect(r.script?.ok).toBe(true);
    expect(f.calls.length).toBe(1);
    expect(files(out)).toEqual([]);
  });

  it('find_ffmpeg: FFMPEG_BIN có thật thắng; không có → PATH/null', () => {
    const exe = join(fresh('ff'), 'ffmpeg.exe');
    mkdirSync(join(exe, '..'));
    writeFileSync(exe, 'x');
    expect(vs.findFfmpeg({ FFMPEG_BIN: exe })).toBe(exe);
    expect(vs.findFfmpeg({ FFMPEG_BIN: join(TMP, 'khong-co'), PATH: '' })).toBeNull();
  });

  it('config thời lượng (golden vs mặc định)', () => {
    const [cfg, err] = vs.loadConfig();
    expect(err).toBeNull();
    expect(cfg?.channels).toEqual(['tiktok', 'facebook']);
    expect(
      (cfg as vs.VideoCfg).scene_s * ((cfg as vs.VideoCfg).min_scenes + 1),
    ).toBeGreaterThanOrEqual(15);
    expect(
      (cfg as vs.VideoCfg).scene_s * ((cfg as vs.VideoCfg).max_scenes + 1),
    ).toBeLessThanOrEqual(45);
  });
});

describe('thuần: label_visible / B-roll', () => {
  const rect = (bg: number[], fg: number[]): Raw => {
    const img = raster.newRaw(100, 50, 3, bg);
    raster.fillRect(img, 10, 10, 21, 21, fg);
    return img;
  };
  it('label_visible: dung sai, nguồn 0, khác cỡ, input hỏng', () => {
    const ref = rect([20, 20, 20], [255, 255, 255]);
    const box = [0, 0, 100, 50];
    const rgb = [255, 255, 255];
    expect(vs.labelVisible(ref, ref, box, rgb)).toBe(1);
    const soft = rect([20, 20, 20], [230, 240, 228]);
    expect(vs.labelVisible(soft, ref, box, rgb)).toBe(1); // dung sai 40
    expect(vs.labelVisible(soft, ref, box, rgb, 10)).toBe(0);
    const blank = raster.newRaw(100, 50, 3, [20, 20, 20]);
    expect(vs.labelVisible(blank, ref, box, rgb)).toBe(0);
    expect(vs.labelVisible(ref, blank, box, rgb)).toBe(0); // nguồn 0
    expect(vs.labelVisible(raster.newRaw(50, 25, 3), ref, box, rgb)).toBe(0);
    expect(vs.labelVisible(null, ref, box, rgb)).toBe(0);
  });

  it.skipIf(!HAS_SHARP)(
    'B-roll: thiếu license / sai đuôi / ảnh lỗi / quá cỡ / licenses hỏng / không thư mục',
    async () => {
      const br = fresh('br');
      await vs.makeSampleBroll(join(br, 'a.png'), { license: null });
      await vs.makeSampleBroll(join(br, 'b.jpg'), { license: '   ' });
      writeFileSync(join(br, 'c.mov'), Buffer.from([0]));
      const [icfg] = ims.loadConfig();
      const cfg = icfg as ims.ImageCfg;
      let [ok, skipped] = await vs.brolls(br, cfg);
      expect(ok).toEqual([]);
      expect(Object.fromEntries(skipped.map((s) => [s.file, s.ly_do]))).toEqual({
        'a.png': 'license',
        'b.jpg': 'license',
        'c.mov': 'dinh_dang',
      });
      const br2 = fresh('br2');
      await vs.makeSampleBroll(join(br2, 'a.jpg'));
      await vs.makeSampleBroll(join(br2, 'b.png'));
      writeFileSync(join(br2, 'c.png'), 'not a png');
      writeFileSync(
        join(br2, 'licenses.json'),
        JSON.stringify({ 'a.jpg': 'x', 'b.png': 'x', 'c.png': 'x' }),
      );
      [ok, skipped] = await vs.brolls(br2, cfg);
      expect(ok.map((b) => b.file)).toEqual(['a.jpg', 'b.png']);
      expect(skipped).toEqual([{ file: 'c.png', ly_do: 'anh_loi' }]);
      [ok, skipped] = await vs.brolls(br2, { ...cfg, max_pixels: 1000 });
      expect(ok).toEqual([]);
      expect(skipped.length).toBe(3);
      expect((await vs.brolls(br2, { ...cfg, max_bytes: 100 }))[0]).toEqual([]);
      writeFileSync(join(br2, 'licenses.json'), '{hỏng');
      expect((await vs.brolls(br2, cfg))[0]).toEqual([]);
      expect(await vs.brolls(join(TMP, 'khong-co'), cfg)).toEqual([[], []]);
    },
  );
});

// ============================================================== dựng khung (không mã hóa)

describe.skipIf(!RENDER)('dựng khung trước mã hóa (đột biến)', () => {
  it('B-roll không license → rơi về packshot (compose mọi cảnh + khung kết)', async () => {
    const br = fresh('br');
    await vs.makeSampleBroll(join(br, 'a.png'), { license: null });
    await vs.makeSampleBroll(join(br, 'b.jpg'), { license: '   ' });
    const texts: string[] = [];
    vs.vhooks.compose = (async (...a: Parameters<typeof ims.compose>) => {
      texts.push(a[2] as string);
      return ims.compose(...a);
    }) as typeof ims.compose;
    vs.vhooks.findFfmpeg = () => 'ffmpeg-gia';
    vs.vhooks.encode = async () => {
      throw new vs.RuntimeErr('dừng trước mã hóa (test)');
    };
    const out = fresh('o');
    const r = await make(PK, out, fakeLlm(js(SCENES5)).ai, { brollDir: br });
    expect(r.error).toBe('dừng trước mã hóa (test)');
    expect(texts).toEqual([...SCENES5.map((s) => s.text), GOLD[HONEY].name]);
    expect(files(out)).toEqual([]);
  });

  it('bỏ CHỮ nhãn AI (khung packshot + B-roll) → nhan_ai TRƯỚC mã hóa, 0 mp4', async () => {
    const real = ims.hooks.drawText;
    ims.hooks.drawText = (o, mask, x, y, rgba, text) => {
      if (text.includes(AI)) return;
      real(o, mask, x, y, rgba, text);
    };
    vs.vhooks.findFfmpeg = () => 'ffmpeg-gia';
    vs.vhooks.encode = async () => {
      throw new Error('không được mã hóa');
    };
    try {
      const br = fresh('br');
      await vs.makeSampleBroll(join(br, 'a.png'));
      for (const d of [br, fresh('none')]) {
        const out = fresh('o');
        const r = await make(PK, out, fakeLlm(js([SCENES5[1], ...SCENES5.slice(2)])).ai, {
          brollDir: d,
        });
        expect(r.refused?.code, JSON.stringify(r.refused)).toBe('nhan_ai');
        expect(files(out)).toEqual([]);
      }
    } finally {
      ims.hooks.drawText = real;
    }
  });

  it('khung packshot bị sửa 1 pixel SAU compose → packshot_lech, 0 file', async () => {
    vs.vhooks.compose = (async (...a: Parameters<typeof ims.compose>) => {
      const res = await ims.compose(...a);
      if (res.ok) {
        const img = await raster.decode(readFileSync(res.path as string), 3);
        const f = res.fitted as Raw;
        let k = 0;
        while (f.data[k * 4 + 3] !== 255) k++;
        const [x, y] = res.packshot_xy as [number, number];
        const d = ((y + Math.floor(k / f.width)) * img.width + x + (k % f.width)) * 3;
        img.data[d] = ((img.data[d] as number) + 1) % 256;
        writeFileSync(res.path as string, await raster.encodePng(img));
      }
      return res;
    }) as typeof ims.compose;
    vs.vhooks.findFfmpeg = () => 'ffmpeg-gia';
    vs.vhooks.encode = async () => {
      throw new Error('không được mã hóa');
    };
    const out = fresh('o');
    const r = await make(PK, out, fakeLlm(js(SCENES5)).ai);
    expect(r.refused?.code).toBe('packshot_lech');
    expect(files(out)).toEqual([]);
  });
});

// ============================================================== mã hóa mp4 thật (cần ffmpeg)

describe.skipIf(!RENDER || !FF)('mp4 thật (ffmpeg)', () => {
  const B: Any = {};
  beforeAll(async () => {
    const base = fresh('v63');
    B.pk = join(base, 'pk');
    await ims.makeSamplePackshot(join(B.pk, `${HONEY}.png`), HONEY);
    B.br = join(base, 'broll');
    await vs.makeSampleBroll(join(B.br, 'a_vuon.jpg'), { exifGps: true });
    await vs.makeSampleBroll(join(B.br, 'b_nui.png'));
    await vs.makeSampleBroll(join(B.br, 'c_khong_license.png'), { license: null });
    writeFileSync(join(B.br, 'd_clip.mp4'), Buffer.alloc(64));
    B.out = join(base, 'out');
    B.f = fakeLlm(js(SCENES5));
    const go = () =>
      vs.makeVideo(
        HONEY,
        'tiktok',
        BRIEF,
        { fmt: '9:16', readiness: R_OK, packshotDir: B.pk, brollDir: B.br, outDir: B.out },
        { ai: B.f.ai, env: ENV },
      );
    B.r1 = await go();
    B.side1 = B.r1.ok ? readFileSync(B.r1.sidecar) : null;
    B.r2 = await go();
    B.files2 = files(B.out);
    B.side2 = B.r2.ok ? readFileSync(B.r2.sidecar) : null;
  }, 600_000);

  it('video 9:16 hợp lệ: 24 s, không audio, sidecar đủ trường, B-roll có license', async () => {
    const r = B.r1;
    expect(r.ok, JSON.stringify([r.refused, r.error])).toBe(true);
    expect(r.path.endsWith('.mp4')).toBe(true);
    expect(sha(readFileSync(r.path))).toBe(r.sha256);
    const info = await vs.probeInfo(FF as string, r.path);
    expect(info).toContain('1080x1920');
    expect(info).not.toContain('Audio:');
    const m = r.meta;
    expect(m.duration_ms).toBe(4 * 6 * 1000);
    expect(vs.durationMs(info)).toBe(m.duration_ms);
    expect(JSON.parse(readFileSync(r.sidecar, 'utf8'))).toEqual(m);
    expect(m.schema).toBe('video_asset@1');
    expect(m.labels).toEqual([AI, AD]);
    expect(m.tts).toEqual({ provider: 'none', voice: null });
    expect(m.music).toBeNull();
    const br = m.scenes.filter((s: Any) => s.source === 'broll');
    expect(br.map((s: Any) => s.broll.file)).toEqual(['a_vuon.jpg', 'b_nui.png']);
    expect(br.every((s: Any) => s.broll.license === vs.SAMPLE_LICENSE)).toBe(true);
    expect(m.scenes.map((s: Any) => s.source)).toEqual([
      'packshot',
      'broll',
      'packshot',
      'broll',
      'packshot',
      'end_card',
    ]);
    expect(m.scenes.at(-1).subtitle).toBe(GOLD[HONEY].name);
    for (const s of m.scenes) expect(s.packshot === null).toBe(s.source === 'broll');
    expect(m.scenes.map((s: Any) => s.start_ms)).toEqual([0, 4000, 8000, 12000, 16000, 20000]);
    expect(m.script.model).toBe('fake/test-llm');
    expect(m.script.lines).toEqual(SCENES5.map((s) => s.text));
    expect(Object.fromEntries(m.broll_skipped.map((b: Any) => [b.file, b.ly_do]))).toEqual({
      'c_khong_license.png': 'license',
      'd_clip.mp4': 'dinh_dang',
    });
    expect(m.extract_check.map((c: Any) => c.t_ms)).toEqual([500, 14000, 23500]);
    expect(m.extract_check.every((c: Any) => c.label_ratio >= 0.5)).toBe(true);
    const raw = readFileSync(r.sidecar, 'utf8');
    for (const k of ['sku', 'channel', 'format', 'packshot_sha256', 'prompt_sha256'])
      expect(raw).not.toContain(`"${k}"`);
    expect(raw).not.toContain('\\\\');
    expect(r.packshot_sha256).toBe(sha(readFileSync(join(B.pk, `${HONEY}.png`))));
    expect(r.draft_text.endsWith(`Tệp video: ${r.sha256}.mp4`)).toBe(true);
    expect(r.draft_text).toContain(AI);
    expect(r.draft_text).toContain(AD);
  });

  it('mp4 không metadata vị trí/thiết bị', async () => {
    const data = readFileSync(B.r1.path);
    for (const needle of ['GPS', 'ISO6709', 'MAU-Camera', 'MAU-Model', 'Exif'])
      expect(data.includes(needle), needle).toBe(false);
    const r = await vs.runFf([
      FF as string,
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      B.r1.path,
      '-f',
      'ffmetadata',
      '-',
    ]);
    const meta = r.stdout.toString('utf8');
    expect(meta.startsWith(';FFMETADATA1')).toBe(true);
    for (const line of meta.toLowerCase().split('\n')) {
      for (const bad of ['location', 'creation_time', 'make', 'model', 'com.apple'])
        expect(line).not.toContain(bad);
    }
  });

  it('tất định: lần 2 cùng file, sidecar giữ nguyên bytes', () => {
    expect(B.r2.ok).toBe(true);
    expect(B.r2.sha256).toBe(B.r1.sha256);
    expect(B.files2).toEqual([`${B.r1.sha256}.json`, `${B.r1.sha256}.mp4`]);
    expect(B.side2.equals(B.side1)).toBe(true);
    expect(B.r2.meta).toEqual(B.r1.meta);
    expect(B.f.calls.length).toBe(2); // 1 lời gọi LLM / lần dựng
  });

  it('mp4 + sidecar bị sửa → ghi lại', async () => {
    const out = fresh('o');
    cpSync(B.out, out, { recursive: true });
    const s = B.r1.sha256;
    writeFileSync(
      join(out, `${s}.mp4`),
      Buffer.concat([readFileSync(join(out, `${s}.mp4`)), Buffer.from('tampered')]),
    );
    const d = JSON.parse(readFileSync(join(out, `${s}.json`), 'utf8'));
    d.labels = [];
    writeFileSync(join(out, `${s}.json`), JSON.stringify(d));
    const r = await vs.makeVideo(
      HONEY,
      'tiktok',
      BRIEF,
      { readiness: R_OK, packshotDir: B.pk, brollDir: B.br, outDir: out },
      { ai: fakeLlm(js(SCENES5)).ai, env: ENV },
    );
    expect(r.ok).toBe(true);
    expect(r.sha256).toBe(s);
    expect(sha(readFileSync(join(out, `${s}.mp4`)))).toBe(s);
    const back = JSON.parse(readFileSync(join(out, `${s}.json`), 'utf8'));
    expect(back.labels).toEqual([AI, AD]);
    expect(back).toEqual(r.meta);
    expect(files(out).filter((f) => f.startsWith(s))).toEqual([`${s}.json`, `${s}.mp4`]);
  }, 300_000);

  it('khung trích từ mp4 mất chữ nhãn → nhan_ai, xóa mp4, 0 sidecar, không sót thư mục tạm', async () => {
    vs.vhooks.extractFrame = async (ff, path, t) => {
      const img = await REAL.extractFrame(ff, path, t);
      const [cfg] = ims.loadConfig();
      const [x, y, w, h] = ims.px((cfg as ims.ImageCfg).layout.get('9:16')?.label_box as ims.Box, [
        img.width,
        img.height,
      ]);
      raster.fillRect(img, x, y, w + 1, h + 1, [0, 0, 0]);
      return img;
    };
    const out = fresh('o');
    const r = await vs.makeVideo(
      HONEY,
      'tiktok',
      BRIEF,
      { readiness: R_OK, packshotDir: B.pk, brollDir: B.br, outDir: out },
      { ai: fakeLlm(js(SCENES5)).ai, env: ENV },
    );
    expect(r.refused?.code).toBe('nhan_ai');
    expect(r.refused?.reason).toContain('label_ratio');
    expect(files(out)).toEqual([]);
  }, 300_000);
});

// ============================================================== save_video + CLI

describe('save_video + CLI video-studio', () => {
  it('save_video từ chối kết quả không ok / thiếu ngữ cảnh dòng', async () => {
    const db = { query: () => Promise.reject(new Error('không được chạm DB')) } as Any;
    for (const bad of [
      null,
      { ok: false },
      { ok: true, meta: null },
      { ok: true, meta: {}, sha256: 'a' },
    ]) {
      await expect(vs.saveVideo(db, bad, { by: 'x' })).rejects.toThrow(RangeError);
    }
    const full = {
      ok: true,
      meta: {},
      sha256: 'a',
      script: {},
      channel: 'tiktok',
      sku: HONEY,
      format: '9:16',
      packshot_sha256: 'p',
    };
    await expect(vs.saveVideo(db, full, { by: ' ' })).rejects.toThrow(RangeError);
    for (const k of ['channel', 'sku', 'format', 'packshot_sha256']) {
      for (const bad of [null, ''])
        await expect(vs.saveVideo(db, { ...full, [k]: bad }, { by: 'x' })).rejects.toThrow(k);
    }
  });

  type Lines = { out: string[]; err: string[] };
  const io = (): [Lines, Any] => {
    const l: Lines = { out: [], err: [] };
    return [l, { out: (s: string) => l.out.push(s), err: (s: string) => l.err.push(s) }];
  };
  const failConnect = async () => {
    throw new Error('không được mở DB');
  };
  const lease = () => ({ db: {} as Any, release: async () => {} });

  it('sai tham số → exit 2', async () => {
    for (const o of [
      { sku: ['all'], channel: ['tiktok'] },
      { sku: ['all'], channel: ['zalo'], brief: 'x' },
      { sku: ['all'], channel: ['tiktok'], format: ['4:5'], brief: 'x' },
      { channel: ['tiktok'], brief: 'x' },
    ]) {
      const [, s] = io();
      expect(
        await videoStudioMain(o, { io: s, env: {}, connect: failConnect }),
        JSON.stringify(o),
      ).toBe(2);
    }
  });

  it.each(['tts', 'ffmpeg', 'image'])('preflight %s → exit 2 TRƯỚC DB và LLM', async (setup) => {
    const env: Record<string, string> = { FFMPEG_BIN: '' };
    let ff: (e: Any) => string | null = () => 'ffmpeg-gia';
    if (setup === 'tts') env.TTS_PROVIDER = 'x';
    if (setup === 'ffmpeg') ff = () => null;
    if (setup === 'image') env.IMAGE_PROVIDER = 'openai';
    const [l, s] = io();
    const rc = await videoStudioMain(
      { sku: ['all'], channel: ['tiktok'], brief: BRIEF },
      { io: s, env, connect: failConnect, findFfmpeg: ff },
    );
    expect(rc).toBe(2);
    expect(l.err.join('\n')).toContain('external-dep');
  });

  it('DB chết → exit 2, 0 LLM', async () => {
    const [l, s] = io();
    let made = 0;
    const rc = await videoStudioMain(
      { sku: ['all'], channel: ['tiktok'], brief: BRIEF },
      {
        io: s,
        env: {},
        connect: async () => null,
        findFfmpeg: () => 'ff',
        makeVideo: (async () => {
          made++;
        }) as Any,
      },
    );
    expect(rc).toBe(2);
    expect(made).toBe(0);
    expect(l.err.join('\n')).toContain('không ghi được');
  });

  it('tính năng marketing-02.2 TẮT → [rollout] exit 2, 0 LLM/0 dựng', async () => {
    settings.forceMode = 'tat';
    const [l, s] = io();
    let made = 0;
    const rc = await videoStudioMain(
      { sku: [HONEY], channel: ['tiktok'], brief: BRIEF },
      {
        io: s,
        env: {},
        connect: async () => lease(),
        wire: () => ({}) as Any,
        findFfmpeg: () => 'ff',
        makeVideo: (async () => {
          made++;
        }) as Any,
      },
    );
    expect(rc).toBe(2);
    expect(made).toBe(0);
    expect(l.out.join('\n')).toContain('[rollout]');
    expect(l.out.join('\n')).toContain('marketing-02.2');
  });

  it('dòng kết quả + exit code (created/skipped/refused/failed DB/failed LLM)', async () => {
    settings.forceMode = 'van_hanh';
    const plan: Record<string, Any> = {
      a: { ok: true, error: null, path: '/x/aa.mp4' },
      b: { ok: true, error: null, path: '/x/bb.mp4' },
      c: { ok: false, error: null, refused: { code: 'ruou', reason: 'rượu' } },
      d: { ok: true, error: null, path: '/x/dd.mp4' },
      e: { ok: false, error: 'llm: GatewayBlocked: kill', refused: null },
    };
    const saved: Record<string, Any> = {
      a: { status: 'created', draft_id: '1', asset_id: '9' },
      b: { status: 'skipped', draft_id: '2' },
    };
    const deps = (s: Any) => ({
      io: s,
      env: {},
      connect: async () => lease(),
      wire: () => ({}) as Any,
      findFfmpeg: () => 'ff',
      readiness: async () => new Map(),
      makeVideo: (async (sku: string) => plan[sku]) as Any,
      saveVideo: (async (_db: unknown, res: Any) => {
        const k = (res.path as string).split('/').pop()?.[0] as string;
        if (k === 'd') throw Object.assign(new Error('mất kết nối'), { code: 'ECONNRESET' });
        return saved[k];
      }) as Any,
    });
    let [l, s] = io();
    expect(
      await videoStudioMain({ sku: ['a', 'b', 'c'], channel: ['tiktok'], brief: 'x' }, deps(s)),
    ).toBe(0);
    let o = l.out.join('\n');
    expect(o).toContain('a × tiktok × 9:16: created #1 aa.mp4');
    expect(o).toContain('b × tiktok × 9:16: skipped bb.mp4');
    expect(o).toContain('c × tiktok × 9:16: refused ruou: rượu');
    expect(o).toContain('created 1, skipped 1, refused 1, failed 0');
    [l, s] = io();
    expect(
      await videoStudioMain({ sku: ['d', 'e'], channel: ['tiktok'], brief: 'x' }, deps(s)),
    ).toBe(1);
    o = l.out.join('\n');
    expect(o).toContain('d × tiktok × 9:16: failed: lỗi DB');
    expect(o).toContain('e × tiktok × 9:16: failed: llm: GatewayBlocked');
  });

  it('module video: ffmpeg không shell, bỏ metadata + âm thanh; không clone giọng', () => {
    const src = readFileSync(new URL('./video-studio.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(
      /setStatus|approve_draft|fetch\(|shell: true|clone|speaker_wav|reference_audio/,
    );
    expect(src).toContain('shell: false');
    expect(src).toContain("'-map_metadata'");
    expect(src).toContain("'-an'");
  });
});
