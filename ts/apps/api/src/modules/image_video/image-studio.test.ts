import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { checkPublish, readinessKey } from '@samsam/core/security/guardrail';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import G from './__fixtures__/image_video.golden.json' with { type: 'json' };
import * as ims from './image-studio.js';
import { imageStudioMain } from './image-video.command.js';
import type { Raw } from './raster.js';
import * as raster from './raster.js';
import { clean } from './terms.js';
import * as vs from './video-studio.js';

// Dịch tests/test_image_studio.py (v6.2 MKT-03) + phần ảnh của tests/test_v13_c05_media.py. Logic thuần
// so khớp golden do hàm Python THẬT sinh (`__fixtures__/image_video.golden.json`). Ghép ảnh: packshot MẪU
// tự sinh, provider AI GIẢ đăng ký vào `PROVIDERS` — 0 mạng, 0 key thật. Phần DB ở image-video.db.test.ts.

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON golden
type Any = any;
const g = G as Any;
const RULES = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8')) as Any;
const AI: string = RULES.labels.ai[0];
const AD: string = RULES.labels.ad[0];
const GOLDEN = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as Any;
const GOLD: Record<string, Any> = Object.fromEntries(GOLDEN.skus.map((s: Any) => [s.sku_key, s]));
const CFG = JSON.parse(readFileSync(dataPath('image_studio.json'), 'utf8')) as Any;
const FORMATS = Object.keys(CFG.formats);
const HONEY = 'mat-ong-sam-300ml';
const ALCOHOL = Object.keys(GOLD).filter((k) => GOLD[k].category === 'alcohol');
const TPBVSK = Object.keys(GOLD).filter((k) => GOLD[k].category === 'tpbvsk');
const SCENE = 'bàn gỗ, ánh nắng sớm, lá xanh';
const HEADLINE = 'Quà tặng từ núi rừng';
const RED = [255, 0, 0];
const ENV = {}; // không IMAGE_PROVIDER/PACKSHOT_DIR/IMAGE_OUT_DIR/IMAGE_FONT/GUARDRAIL_LLM_MODEL
const D = { ai: null, env: ENV };

const rmap = (xs: [string, string, string][] | null) =>
  xs === null ? null : new Map(xs.map(([s, c, v]) => [readinessKey(s, c), v]));
const R_OK = rmap([[HONEY, 'facebook', 'TP_THUONG']]);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const codesOf = (gr: Any): string[] => (gr?.violations ?? []).map((v: Any) => v.code);

const TMP = mkdtempSync(join(tmpdir(), 'image-studio-'));
let n = 0;
const fresh = (p: string) => join(TMP, `${p}-${++n}`);
const files = (d: string): string[] => {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
};

const HAS_FONT = ims.fontsFor(`${AI} ${AD} MẪU ${HEADLINE}`, {}) !== null;
let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}
// Python `NEED_FONT`: máy không có font đủ glyph tiếng Việt / thiếu sharp → bỏ qua phần vẽ ảnh.
const RENDER = HAS_FONT && HAS_SHARP;

let PK = '';
beforeAll(async () => {
  if (!RENDER) return;
  PK = fresh('pk');
  await ims.makeSamplePackshot(join(PK, `${HONEY}.png`), HONEY);
});
afterEach(() => {
  ims.paths.config = dataPath('image_studio.json');
  delete ims.PROVIDERS.fake;
  settings.forceMode = null;
  vi.restoreAllMocks();
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Nền AI giả TẤT ĐỊNH: màu đặc + khối đỏ vẽ ĐÈ đúng packshot_box (mô phỏng AI vẽ vào vùng sản phẩm). */
function fakeBg(_prompt: string | null, size: [number, number]): [Raw, Any] {
  const img = raster.newRaw(size[0], size[1], 3, [60, 90, 70]);
  const [cfg] = ims.loadConfig();
  for (const [name, wh] of cfg?.formats ?? []) {
    if (wh[0] === size[0] && wh[1] === size[1]) {
      const [x, y, w, h] = ims.px(cfg?.layout.get(name)?.packshot_box as ims.Box, size);
      raster.fillRect(img, x, y, w, h, RED);
    }
  }
  return [img, { model: 'fake-model' }];
}
function fakeProvider() {
  const calls: unknown[][] = [];
  ims.PROVIDERS.fake = async (...a: Parameters<ims.ProviderFn>) => {
    calls.push(a); // ghi ĐỦ đối số thật nhận được
    return fakeBg(...a);
  };
  return calls;
}

function compose(pk: string, out: string, kw: Any = {}) {
  const o = { fmt: '1:1', readiness: R_OK, packshotDir: pk, outDir: out, ...kw };
  const sku = 'sku' in o ? o.sku : HONEY;
  const ch = 'channel' in o ? o.channel : 'facebook';
  const hl = 'headline' in o ? o.headline : HEADLINE;
  return ims.compose(sku, ch, hl, o, D);
}

function tmpCfg(mutate: (d: Any) => void): string {
  const doc = structuredClone(CFG);
  mutate(doc);
  const p = join(fresh('cfg'), 'image_studio.json');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(doc));
  ims.paths.config = p;
  return p;
}

const pngChunks = (data: Buffer): string[] => {
  const out: string[] = [];
  let i = 8;
  while (i < data.length) {
    const len = data.readUInt32BE(i);
    out.push(data.toString('latin1', i + 4, i + 8));
    i += 12 + len;
  }
  return out;
};

const lsize = (fmt: string) =>
  Math.max(CFG.label.font_px_min, ims.pyRound(CFG.label.font_ratio * CFG.formats[fmt][1]));

/** (tỉ lệ, chiều cao px) pixel ĐÚNG màu chữ nhãn trong label_box — riêng tấm nền không đạt. */
function labelText(img: Raw, box: number[]): [number, number] {
  const [x, y, w, h] = box as [number, number, number, number];
  let cnt = 0;
  let top = -1;
  let bot = -1;
  const rgb = CFG.label.text_rgb;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const d = (j * img.width + i) * img.channels;
      if (img.data[d] === rgb[0] && img.data[d + 1] === rgb[1] && img.data[d + 2] === rgb[2]) {
        cnt++;
        if (top < 0) top = j;
        bot = j;
      }
    }
  }
  return [cnt / (w * h), top < 0 ? 0 : bot - top + 1];
}
const readPng = async (p: string) => raster.decode(readFileSync(p), 3);

// ============================================================== golden thuần (Python thật)

describe('golden thuần (Python image_studio/video_studio)', () => {
  it('_clean', () => {
    for (const [inp, want] of g.clean) expect(clean(inp), JSON.stringify(inp)).toBe(want);
  });
  it('check_scene (từ cấm/ký tự chèn/không dấu/sức khỏe/guardrail/độ dài)', () => {
    for (const [inp, want] of g.check_scene)
      expect(ims.checkScene(inp), JSON.stringify(inp)).toEqual(want);
  });
  it('background_prompt (template manifest + scene sạch)', () => {
    for (const [inp, want] of g.background_prompt) expect(ims.backgroundPrompt(inp)).toEqual(want);
  });
  it('_px theo 4 format', () => {
    const [cfg] = ims.loadConfig();
    for (const [name, wh, boxes] of g.px) {
      const lay = cfg?.layout.get(name) as Any;
      for (const k of Object.keys(boxes))
        expect(ims.px(lay[k], wh), `${name} ${k}`).toEqual(boxes[k]);
    }
  });
  it('precheck_image + precheck_video (mọi tổ hợp SKU × kênh × format × readiness)', () => {
    for (const [sku, ch, fmt, rm, wantImg, wantVid] of g.precheck) {
      const r = rmap(rm);
      const tag = JSON.stringify([sku, ch, fmt, rm]);
      expect(ims.precheckImage(sku, ch, fmt, r), tag).toEqual(wantImg);
      expect(vs.precheckVideo(sku, ch, fmt, r), tag).toEqual(wantVid);
    }
  });
  it('load_config (đột biến cấu hình → lý do y hệt Python)', () => {
    // Khác có chủ đích: chi tiết lỗi JSONDecodeError/FileNotFoundError (đường dẫn máy) — chỉ so tên lỗi.
    const PREFIX_ONLY = new Set(['badjson', 'missing']);
    // Khác có chủ đích: JSON của JS không phân biệt 1080.0 với 1080 (số nguyên) → TS nhận.
    const TS_ACCEPTS = new Set(['fmt_float']);
    const dir = fresh('imgcfg');
    mkdirSync(dir);
    for (const [name, [doc, err, got]] of Object.entries(g.image_config) as Any) {
      const p = join(dir, `${name}.json`);
      if (name === 'badjson') writeFileSync(p, '{hỏng');
      else if (name !== 'missing') writeFileSync(p, JSON.stringify(doc));
      const [cfg, e] = ims.loadConfig(p);
      if (TS_ACCEPTS.has(name)) {
        expect(e, name).toBeNull();
        continue;
      }
      if (PREFIX_ONLY.has(name)) {
        expect(e?.split(':')[0], name).toBe(err.split(':')[0]);
        continue;
      }
      expect(e, name).toBe(err);
      if (got)
        expect({ max_chars: cfg?.headline.max_chars, font_ratio: cfg?.label.font_ratio }).toEqual(
          got,
        );
    }
  });
  it('compose từ chối TRƯỚC font/packshot (headline, guardrail, scene, precheck)', async () => {
    for (const [kw, want] of g.compose_refuse) {
      const o: Any = { ...kw };
      if ('readiness' in o) o.readiness = rmap(o.readiness);
      const r = await compose(fresh('nopk'), fresh('o'), o);
      expect(r.refused, JSON.stringify(kw)).toEqual(want.refused);
      expect(r.text_layer).toBe(want.text_layer);
      expect(r.guardrail?.ok).toBe(want.g_ok);
      expect(codesOf(r.guardrail)).toEqual(want.g_codes);
      expect(r.path).toBeNull();
    }
  });
});

// ============================================================== cổng nền + prompt nền

describe('generate_background (cổng provider)', () => {
  it('provider lạ / sai kích thước / lỗi / không model → ImageProviderError; RGBA → RGB', async () => {
    const size: [number, number] = [200, 100];
    await expect(
      ims.generateBackground('p', size, { env: { IMAGE_PROVIDER: 'openai' } }),
    ).rejects.toThrow(/external-dep/);
    ims.PROVIDERS.bad = async () => [raster.newRaw(10, 10, 3), { model: 'm' }];
    await expect(ims.generateBackground('p', size, { provider: 'bad' })).rejects.toThrow(
      /sai kích thước/,
    );
    class RuntimeError extends Error {}
    ims.PROVIDERS.boom = async () => {
      throw new RuntimeError('timeout');
    };
    await expect(ims.generateBackground('p', size, { provider: 'boom' })).rejects.toThrow(
      /RuntimeError/,
    );
    ims.PROVIDERS.nomodel = async (_p, s) => [raster.newRaw(s[0], s[1], 3), {}];
    await expect(ims.generateBackground('p', size, { provider: 'nomodel' })).rejects.toThrow(
      /model/,
    );
    ims.PROVIDERS.rgba = async (_p, s) => [raster.newRaw(s[0], s[1], 4), { model: 'm' }];
    const [img, meta] = await ims.generateBackground('p', size, { provider: 'rgba' });
    expect(img.channels).toBe(3);
    expect(meta.ai_generated).toBe(true);
    for (const k of ['bad', 'boom', 'nomodel', 'rgba']) delete ims.PROVIDERS[k];
  });

  it.skipIf(!HAS_SHARP)('provider none: 0 mạng, tất định, không AI', async () => {
    const net = vi.spyOn(globalThis, 'fetch');
    const size: [number, number] = CFG.formats['1:1'];
    const [a, ma] = await ims.generateBackground(null, size, { env: {} });
    const [b, mb] = await ims.generateBackground('bỏ qua', size, {
      env: { IMAGE_PROVIDER: 'none' },
    });
    expect(a.data.equals(b.data)).toBe(true);
    expect([a.width, a.height]).toEqual(size);
    expect(ma).toEqual({ provider: 'none', model: 'none', ai_generated: false });
    expect(mb).toEqual(ma);
    expect(net).not.toHaveBeenCalled();
  });

  it('template image_background: manifest + guardrail + cấm người/chữ/logo/bao bì', () => {
    const man = JSON.parse(readFileSync(dataPath('prompts', 'manifest.json'), 'utf8')).templates
      .image_background;
    const raw = readFileSync(dataPath('prompts', 'image_background.md'));
    expect(man.sha256).toBe(
      sha(Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')),
    );
    expect(man.version).toBe('image_background@1');
    const [p, v, s] = ims.backgroundPrompt(SCENE);
    expect(p).toContain(SCENE);
    expect(p).not.toContain('{scene}');
    expect([v, s]).toEqual([man.version, man.sha256]);
    expect(ims.backgroundPrompt(null)[0]).toContain(CFG.default_scene);
  });

  it('check_scene kiểm ĐÚNG chuỗi vào prompt (ký tự điều khiển chèn giữa từ cấm)', () => {
    const traps = [
      'chai có lo\x01go lớn',
      'lo\x01go và nh\x7fãn',
      'y t\x01á và ống ng\x01he',
      'điều tr\x01ị cho người già',
      'thu\x7fốc bổ trên bàn',
      'bàn gỗ, bao\x1f bì giấy',
      'b\x01ác s\x7fĩ đứng cạnh',
    ];
    for (const s of traps) expect(ims.checkScene(s)?.code, s).toBe('prompt_cam');
    expect(ims.checkScene(`${SCENE}\x01\x7f`)).toBeNull();
    for (const s of [...traps, SCENE, 'đá xám\x01, sương sớm', 'khăn lụa\x7f đỏ']) {
      if (ims.checkScene(s) === null) expect(ims.backgroundPrompt(s)[0]).toContain(clean(s));
    }
  });
});

// ============================================================== compose (vẽ ảnh thật)

describe.skipIf(!RENDER)('compose (packshot thật dán sau cùng + nhãn AI)', () => {
  it('provider none: ok, không AI nhưng nhãn AI vẫn vẽ, 0 mạng', async () => {
    const net = vi.spyOn(globalThis, 'fetch');
    const r = await compose(PK, fresh('o'));
    expect(r.ok, JSON.stringify(r.refused)).toBe(true);
    const m = r.meta as Any;
    expect(m.ai_generated).toBe(false);
    expect(m.labels[0]).toBe(AI);
    expect(r.text_layer).toContain(AI);
    expect(m.background).toEqual({
      provider: 'none',
      model: 'none',
      prompt: null,
      prompt_sha256: null,
      prompt_version: null,
      template_sha256: null,
    });
    expect(net).not.toHaveBeenCalled();
  });

  it('provider CHỈ nhận (prompt, size) — không ảnh/bytes packshot', async () => {
    const calls = fakeProvider();
    const r = await compose(PK, fresh('o'), { provider: 'fake', scene: SCENE, fmt: '4:5' });
    expect(r.ok, JSON.stringify(r.refused)).toBe(true);
    expect(calls.length).toBe(1);
    const args = calls[0] as unknown[];
    expect(args.length).toBe(2);
    expect(typeof args[0]).toBe('string');
    expect(args[0]).toContain(SCENE);
    expect(args[1]).toEqual(CFG.formats['4:5']);
    expect(args.some((a) => Buffer.isBuffer(a) || raster.isRaw(a))).toBe(false);
  });

  it('nền AI vẽ đè ô packshot bị vô hiệu: pixel đặc giữ nguyên packshot', async () => {
    fakeProvider();
    const r = await compose(PK, fresh('o'), { provider: 'fake', scene: SCENE });
    expect(r.ok).toBe(true);
    const img = await readPng(r.path as string);
    const fitted = r.fitted as Raw;
    const [x, y] = r.packshot_xy as [number, number];
    expect(ims.verifyPackshot(img, fitted, [x, y])).toBe(true);
    let red = 0;
    let solidRed = 0;
    for (let j = 0; j < fitted.height; j++) {
      for (let i = 0; i < fitted.width; i++) {
        const d = ((y + j) * img.width + x + i) * 3;
        const isRed = img.data[d] === 255 && img.data[d + 1] === 0 && img.data[d + 2] === 0;
        if (isRed) red++;
        if (isRed && fitted.data[(j * fitted.width + i) * 4 + 3] === 255) solidRed++;
      }
    }
    expect(red).toBeGreaterThan(0); // nền giả đã vẽ đè ô packshot
    expect(solidRed).toBe(0);
    const m = r.meta as Any;
    expect(m.packshot.box).toEqual([x, y, fitted.width, fitted.height]);
    expect(m.packshot.fitted_sha256).toBe(sha(fitted.data));
    expect(r.packshot_sha256).toBe(sha(readFileSync(join(PK, `${HONEY}.png`))));
    expect('file_sha256' in m.packshot).toBe(false);
  });

  it('sửa 1 pixel packshot → verify false; ngoài khung / 0 pixel đặc → false', async () => {
    const r = await compose(PK, fresh('o'));
    const img = await readPng(r.path as string);
    const fitted = r.fitted as Raw;
    const xy = r.packshot_xy as [number, number];
    expect(ims.verifyPackshot(img, fitted, xy)).toBe(true);
    let k = 0;
    while (fitted.data[k * 4 + 3] !== 255) k++;
    const d = ((xy[1] + Math.floor(k / fitted.width)) * img.width + xy[0] + (k % fitted.width)) * 3;
    img.data[d] = ((img.data[d] as number) + 1) % 256;
    expect(ims.verifyPackshot(img, fitted, xy)).toBe(false);
    expect(ims.verifyPackshot(img, fitted, [img.width, 0])).toBe(false);
    expect(ims.verifyPackshot(img, raster.newRaw(5, 5, 4), [0, 0])).toBe(false);
    expect(ims.verifyPackshot(null, fitted, xy)).toBe(false);
  });

  it('lớp vẽ SAU khi dán packshot → packshot_lech, 0 file', async () => {
    const real = ims.hooks.pastePackshot;
    ims.hooks.pastePackshot = (canvas, fitted, xy) => {
      const c = real(canvas, fitted, xy);
      raster.fillRect(
        c,
        xy[0] + Math.floor(fitted.width / 3),
        xy[1] + Math.floor(fitted.height / 2),
        Math.floor(fitted.width / 6),
        20,
        [0, 0, 255],
      );
      return c;
    };
    try {
      const out = fresh('o');
      const r = await compose(PK, out);
      expect(r.ok).toBe(false);
      expect(r.refused?.code).toBe('packshot_lech');
      expect(r.path).toBeNull();
      expect(r.meta).toBeNull();
      expect(files(out)).toEqual([]); // không png/json/file tạm
    } finally {
      ims.hooks.pastePackshot = real;
    }
  });

  it('20 ảnh AI (4 format × 5 headline): nhãn AI + QC, meta model/prompt/ngày, có CHỮ nhãn', async () => {
    const calls = fakeProvider();
    const heads = [
      'Quà tặng từ núi rừng',
      'Mật ong sâm cho mùa Tết sum vầy',
      'Đặc sản Quảng Nam',
      'Ngọt dịu hương rừng',
      'Món quà gửi người thương',
    ];
    const scenes = [
      SCENE,
      'khăn lụa đỏ, hoa mai vàng',
      'đá xám, sương sớm',
      'giỏ mây, lá chuối',
      'nền giấy kraft, nhành thông',
    ];
    const out = fresh('o');
    const shas = new Set<string>();
    for (const fmt of FORMATS) {
      for (const [i, hl] of heads.entries()) {
        const r = await compose(PK, out, { provider: 'fake', fmt, headline: hl, scene: scenes[i] });
        expect(r.ok, `${fmt} ${hl} ${JSON.stringify(r.refused)}`).toBe(true);
        const m = r.meta as Any;
        shas.add(r.sha256 as string);
        expect(m.ai_generated).toBe(true);
        expect(m.labels[0]).toBe(AI);
        expect(m.labels).toContain(AD);
        expect(r.text_layer.split('\n')).toEqual([hl, ...m.labels]);
        expect(r.guardrail?.ok).toBe(true);
        expect(m.background.model).toBe('fake-model');
        expect(m.background.provider).toBe('fake');
        expect(m.background.prompt_version).toBe('image_background@1');
        expect(m.background.prompt_sha256).toBe(sha(Buffer.from(m.background.prompt, 'utf8')));
        expect(m.background.prompt).toContain(scenes[i]);
        expect(m.created_at).toMatch(/\+00:00$/);
        const side = JSON.parse(readFileSync(r.sidecar as string, 'utf8'));
        expect(side).toEqual(m);
        expect(side.file).toBe(`${r.sha256}.png`);
        const raw = readFileSync(r.sidecar as string, 'utf8');
        expect(raw).not.toContain(out);
        expect(raw).not.toMatch(/[A-Za-z]:[\\/]/); // không path máy
        const img = await readPng(r.path as string);
        expect([img.width, img.height]).toEqual(CFG.formats[fmt]);
        const [plain] = fakeBg(null, [img.width, img.height]);
        const [x, y, w, h] = m.label_box;
        expect(
          raster.changedRatio(raster.crop(img, x, y, w, h), raster.crop(plain, x, y, w, h)),
        ).toBeGreaterThanOrEqual(0.01);
        const [ratio, textH] = labelText(img, m.label_box);
        expect(ratio, `${fmt} ${ratio}`).toBeGreaterThanOrEqual(0.0005); // có CHỮ, không chỉ tấm nền
        // shortcut: Python đo khung mực Pillow ≥ cỡ chữ sàn; Pango đo khung mực sát hơn → ≥ 1 dòng chữ.
        expect(m.labels.length).toBe(2);
        expect(textH, fmt).toBeGreaterThanOrEqual(Math.floor(lsize(fmt) / 2));
        expect(ims.verifyPackshot(img, r.fitted, r.packshot_xy)).toBe(true);
      }
    }
    expect(shas.size).toBe(20);
    expect(calls.length).toBe(20);
  }, 120_000);

  it('đột biến bỏ CHỮ nhãn (giữ tấm nền) → kiểm pixel đúng màu chữ ra 0', async () => {
    fakeProvider();
    const real = ims.hooks.drawText;
    ims.hooks.drawText = (o, mask, x, y, rgba, text) => {
      if (text.includes(AI)) return;
      real(o, mask, x, y, rgba, text);
    };
    try {
      for (const fmt of FORMATS) {
        const r = await compose(PK, fresh('o'), { provider: 'fake', scene: SCENE, fmt });
        expect(r.ok).toBe(true);
        expect((r.meta as Any).labels[0]).toBe(AI); // meta "có"
        const img = await readPng(r.path as string);
        const box = (r.meta as Any).label_box;
        const [x, y, w, h] = box;
        const [plain] = fakeBg(null, [img.width, img.height]);
        expect(
          raster.changedRatio(raster.crop(img, x, y, w, h), raster.crop(plain, x, y, w, h)),
        ).toBeGreaterThanOrEqual(0.99);
        expect(labelText(img, box), fmt).toEqual([0, 0]);
      }
    } finally {
      ims.hooks.drawText = real;
    }
  });

  it('ảnh output KHÔNG EXIF/GPS/XMP (packshot mẫu có metadata)', async () => {
    const d = fresh('pk_exif');
    const src = await ims.makeSamplePackshot(join(d, `${HONEY}.png`), HONEY, [600, 800], {
      exifGps: true,
    });
    const raw = readFileSync(src);
    expect(raw.includes('eXIf') || raw.includes('Exif')).toBe(true); // mẫu thật có metadata
    expect(raw.includes('GPS') || raw.includes('xmpmeta')).toBe(true);
    const r = await compose(d, fresh('o'));
    expect(r.ok, JSON.stringify(r.refused)).toBe(true);
    const data = readFileSync(r.path as string);
    expect(data.includes('eXIf')).toBe(false);
    expect(data.includes('GPS')).toBe(false);
    expect(data.includes('xmp')).toBe(false);
    expect(new Set(pngChunks(data))).toEqual(new Set(['IHDR', 'IDAT', 'IEND']));
  });

  it.each(['none', 'fake'])(
    'rượu bị từ chối MỌI tổ hợp (provider %s), 0 provider, 0 file',
    async (prov) => {
      const calls = fakeProvider();
      const out = fresh('o');
      for (const sku of ALCOHOL) {
        for (const ch of ['facebook', 'shopee']) {
          for (const r0 of [null, rmap([[sku, ch, 'QC_DAY_DU']])]) {
            const r = await compose(PK, out, { sku, channel: ch, readiness: r0, provider: prov });
            expect(r.refused?.code, `${sku} ${ch}`).toBe('ruou');
            expect(r.ok).toBe(false);
            expect(codesOf(r.guardrail)).toContain('ruou_cam_quang_cao');
          }
        }
      }
      expect(ALCOHOL.length).toBe(2);
      expect(calls).toEqual([]);
      expect(files(out)).toEqual([]);
    },
  );

  it('TPBVSK cần maket XNQC (kể cả QC_DAY_DU), 0 provider', async () => {
    const calls = fakeProvider();
    const out = fresh('o');
    for (const r0 of [null, rmap([['sapentol-30v', 'facebook', 'QC_DAY_DU']])]) {
      const r = await compose(PK, out, {
        sku: 'sapentol-30v',
        fmt: 'banner',
        provider: 'fake',
        readiness: r0,
      });
      expect(r.refused?.code).toBe('maket_xnqc');
      expect(r.refused?.reason).toContain('creative TPBVSK phải dùng maket XNQC');
    }
    expect(TPBVSK.length).toBe(8);
    for (const sku of TPBVSK) {
      for (const ch of ['facebook', 'shopee']) {
        expect(ims.precheckImage(sku, ch, '1:1', rmap([[sku, ch, 'QC_DAY_DU']]))?.code).toBe(
          'maket_xnqc',
        );
        expect(ims.precheckImage(sku, ch, '1:1')?.code).toBe('maket_xnqc');
      }
    }
    expect(calls).toEqual([]);
    expect(files(out)).toEqual([]);
  });

  it('từ chối readiness/kênh/format/SKU, 0 provider, 0 file', async () => {
    const calls = fakeProvider();
    const out = fresh('o');
    const code = async (kw: Any) => {
      const r = await compose(PK, out, { provider: 'fake', ...kw });
      expect(r.ok).toBe(false);
      expect(r.path).toBeNull();
      return r.refused?.code;
    };
    expect(await code({ sku: 'mat-ong-sam-120ml-1hu', readiness: null })).toBe('readiness');
    expect(await code({ readiness: null })).toBe('readiness'); // golden: chưa tự công bố
    expect(await code({ readiness: rmap([[HONEY, 'shopee', 'TP_THUONG']]) })).toBe('readiness');
    expect(await code({ readiness: rmap([[HONEY, 'facebook', 'MO_TA']]) })).toBe('readiness');
    expect(
      await code({ channel: 'chatbot', readiness: rmap([[HONEY, 'chatbot', 'TP_THUONG']]) }),
    ).toBe('kenh_la');
    expect(await code({ channel: 'tivi' })).toBe('kenh_la');
    expect(await code({ fmt: '2:3' })).toBe('format_la');
    expect(await code({ sku: null })).toBe('sku_la');
    expect(await code({ sku: 'khong-co' })).toBe('sku_la');
    expect(await code({ readiness: [['x', 'y']] })).toBe('config');
    expect(calls).toEqual([]);
    expect(files(out)).toEqual([]);
  });

  it('headline: guardrail/dài/rỗng/rượu → headline (0 provider); chữ vô hình bị làm sạch', async () => {
    const calls = fakeProvider();
    const out = fresh('o');
    const r = await compose(PK, out, {
      provider: 'fake',
      headline: 'Sâm giúp chữa khỏi tiểu đường',
    });
    expect(r.refused?.code).toBe('headline');
    expect(codesOf(r.guardrail)).toContain('tu_cam');
    expect(r.text_layer.startsWith('Sâm giúp chữa khỏi tiểu đường\n')).toBe(true);
    const long = 'Quà '.repeat(Math.floor(CFG.headline.max_chars / 4) + 1);
    expect((await compose(PK, out, { headline: long })).refused?.code).toBe('headline');
    expect((await compose(PK, out, { headline: ' ​ ' })).refused?.code).toBe('headline');
    expect((await compose(PK, out, { headline: 'Rượu sâm biếu Tết' })).refused?.code).toBe(
      'headline',
    );
    expect(calls).toEqual([]);
    expect(files(out)).toEqual([]);
    const ok = await compose(PK, out, { headline: 'Quà​ tặng\n  núi rừng' });
    expect(ok.ok).toBe(true);
    expect(ok.guardrail?.ok).toBe(true);
    expect(ok.text_layer.split('\n')[0]).toBe('Quà tặng núi rừng');
    const gr = checkPublish(ok.text_layer, {
      channel: 'facebook',
      contentType: 'image',
      sku: HONEY,
      isAi: false,
      isSponsored: false,
      readiness: R_OK,
    });
    expect(gr.ok).toBe(true);
  });

  it('headline có markup Pango (<b>, &) vẽ như chữ thường', async () => {
    const r = await compose(PK, fresh('o'), { headline: 'Quà ngon <b>đẹp</b> & tốt' });
    expect(r.ok, JSON.stringify(r.refused)).toBe(true);
    expect((r.meta as Any).headline).toBe('Quà ngon <b>đẹp</b> & tốt');
  });

  it('mô tả nền cấm → prompt_cam TRƯỚC provider', async () => {
    const calls = fakeProvider();
    const out = fresh('o');
    const r = await compose(PK, out, { provider: 'fake', scene: 'bác sĩ áo blouse cầm sản phẩm' });
    expect(r.refused?.code).toBe('prompt_cam');
    expect(calls).toEqual([]);
    expect(files(out)).toEqual([]);
  });

  it('packshot thiếu / không PNG / hỏng / trong suốt / quá pixel (kiểm header TRƯỚC giải mã)', async () => {
    const out = fresh('o');
    expect((await compose(fresh('trong'), out)).refused?.code).toBe('packshot_thieu');
    const bad = fresh('bad');
    mkdirSync(bad);
    const sh = await raster.sharp();
    writeFileSync(
      join(bad, `${HONEY}.png`),
      await sh({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .toBuffer(),
    );
    let r = await compose(bad, out);
    expect(r.refused?.code).toBe('packshot_loi');
    expect(r.refused?.reason).toContain('JPEG');
    writeFileSync(join(bad, `${HONEY}.png`), Buffer.from('\x89PNG not an image at all', 'latin1'));
    expect((await compose(bad, out)).refused?.code).toBe('packshot_loi');
    writeFileSync(join(bad, `${HONEY}.png`), await raster.encodePng(raster.newRaw(80, 80, 4)));
    r = await compose(bad, out);
    expect(r.refused?.code).toBe('packshot_loi');
    expect(r.refused?.reason).toContain('pixel đặc');
    tmpCfg((d) => {
      d.packshot.max_pixels = 100;
    });
    const dec = vi.spyOn(ims.hooks, 'decode');
    r = await compose(PK, out);
    expect(r.refused?.code).toBe('packshot_loi');
    expect(r.refused?.reason).toContain('vượt');
    expect(dec).not.toHaveBeenCalled(); // không giải mã trước khi kiểm cỡ
    expect(files(out)).toEqual([]);
  });

  it('cùng tham số → cùng file, sidecar/PNG giữ nguyên (bytes + mtime); kênh khác cùng ảnh', async () => {
    const out = fresh('o');
    const a = await compose(PK, out);
    const side = a.sidecar as string;
    const png = a.path as string;
    const before = [readFileSync(side).toString('hex'), statSync(side).mtimeMs];
    const pbefore = [readFileSync(png).toString('hex'), statSync(png).mtimeMs];
    const b = await compose(PK, out);
    expect(b.ok).toBe(true);
    expect(b.sha256).toBe(a.sha256);
    expect(files(out)).toEqual([`${a.sha256}.json`, `${a.sha256}.png`].sort());
    expect([readFileSync(side).toString('hex'), statSync(side).mtimeMs]).toEqual(before);
    expect([readFileSync(png).toString('hex'), statSync(png).mtimeMs]).toEqual(pbefore);
    expect(b.meta).toEqual(a.meta);
    expect(sha(readFileSync(png))).toBe(a.sha256);
    const c = await compose(PK, out, {
      channel: 'shopee',
      readiness: rmap([[HONEY, 'shopee', 'TP_THUONG']]),
    });
    expect(c.ok).toBe(true);
    expect(c.sha256).toBe(a.sha256);
    expect([a.channel, c.channel]).toEqual(['facebook', 'shopee']);
    expect(c.meta).toEqual(a.meta);
    for (const k of ['sku', 'format', 'channel']) expect(k in (a.meta as Any)).toBe(false);
    expect([a.sku, a.format]).toEqual([HONEY, '1:1']);
    expect([readFileSync(side).toString('hex'), statSync(side).mtimeMs]).toEqual(before);
  });

  it('3 SKU cùng hình (bản sao byte / cùng pixel khác bytes) → 1 ảnh, 1 sidecar không lật', async () => {
    const d = fresh('twins');
    const A = 'mat-ong-sam-120ml-1hu';
    const B = 'mat-ong-sam-120ml-2hu';
    await ims.makeSamplePackshot(join(d, `${A}.png`), 'chung', [300, 400]);
    copyFileSync(join(d, `${A}.png`), join(d, `${B}.png`));
    const rgba = await raster.decode(readFileSync(join(d, `${A}.png`)), 4);
    const junk = { ...rgba, data: Buffer.from(rgba.data) };
    for (let i = 0; i < junk.data.length; i += 4)
      if (junk.data[i + 3] === 0) junk.data.fill(255, i, i + 3);
    const sh = await raster.sharp();
    writeFileSync(
      join(d, `${HONEY}.png`),
      await sh(junk.data, { raw: { width: junk.width, height: junk.height, channels: 4 } })
        .png({ compressionLevel: 1 })
        .toBuffer(),
    );
    const shas: Record<string, string> = {};
    for (const k of [A, B, HONEY]) shas[k] = sha(readFileSync(join(d, `${k}.png`)));
    expect(shas[A]).toBe(shas[B]);
    expect(shas[A]).not.toBe(shas[HONEY]);
    const rm = rmap([A, B, HONEY].map((k) => [k, 'facebook', 'TP_THUONG']));
    const out = fresh('o');
    const res: Record<string, Any> = {};
    let before: unknown[] = [];
    for (const k of [A, B, HONEY]) {
      res[k] = await compose(d, out, { sku: k, readiness: rm });
      expect(res[k].ok, k).toBe(true);
      const side = res[k].sidecar as string;
      if (k === A) before = [readFileSync(side).toString('hex'), statSync(side).mtimeMs];
      expect([readFileSync(side).toString('hex'), statSync(side).mtimeMs], k).toEqual(before);
    }
    const a = res[A];
    expect(new Set(Object.values(res).map((r) => r.sha256))).toEqual(new Set([a.sha256]));
    for (const r of Object.values(res)) expect(r.meta).toEqual(a.meta);
    for (const k of [A, B, HONEY])
      expect([res[k].sku, res[k].packshot_sha256]).toEqual([k, shas[k]]);
    expect(files(out)).toEqual([`${a.sha256}.json`, `${a.sha256}.png`]);
  });

  it('sidecar bị sửa tay (bỏ nhãn AI) / hỏng → KHÔNG tin, ghi lại bản đúng (A08)', async () => {
    const out = fresh('o');
    const a = await compose(PK, out);
    const side = a.sidecar as string;
    const m = a.meta as Any;
    writeFileSync(
      side,
      JSON.stringify({ ...m, labels: [AD], background: { ...m.background, model: 'x' } }),
    );
    const b = await compose(PK, out);
    expect(b.ok).toBe(true);
    expect((b.meta as Any).labels[0]).toBe(AI);
    expect((b.meta as Any).background.model).toBe('none');
    expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(b.meta);
    writeFileSync(side, '{hong');
    const c = await compose(PK, out);
    expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(c.meta);
  });

  it('PNG cùng tên bị ghi đè → ghi lại bản vừa kiểm', async () => {
    const out = fresh('o');
    const a = await compose(PK, out);
    const png = a.path as string;
    for (const bad of ['black', 'junk']) {
      writeFileSync(
        png,
        bad === 'black'
          ? await raster.encodePng(raster.newRaw(1080, 1080, 3))
          : Buffer.from('\x89PNG rac', 'latin1'),
      );
      expect(sha(readFileSync(png))).not.toBe(a.sha256);
      const b = await compose(PK, out);
      expect(b.ok).toBe(true);
      expect(b.path).toBe(a.path);
      expect(sha(readFileSync(png))).toBe(a.sha256);
      expect(ims.verifyPackshot(await readPng(png), b.fitted, b.packshot_xy)).toBe(true);
    }
    expect(files(out)).toEqual([`${a.sha256}.json`, `${a.sha256}.png`].sort());
  });
});

describe('cấu hình/font', () => {
  it('font không có → fontsFor null, compose từ chối font, 0 file', async () => {
    const p = tmpCfg((d) => {
      d.fonts = [join(TMP, 'khong-co.ttf')];
    });
    expect(ims.fontsFor('abc', {})).toBeNull();
    const out = fresh('o');
    const pk = RENDER ? PK : fresh('nopk');
    const r = await compose(pk, out);
    expect(r.refused?.code).toBe('font');
    expect(files(out)).toEqual([]);
    expect(p).toBeTruthy();
    ims.paths.config = dataPath('image_studio.json');
    expect(ims.fontsFor('', {})).toBeNull(); // ký tự PUA: không font nào có
  });

  it('label_box giao packshot_box → config, 0 file', async () => {
    tmpCfg((d) => {
      d.layout['1:1'].label_box = [20, 80, 60, 15];
    });
    const [cfg, err] = ims.loadConfig();
    expect(cfg).toBeNull();
    expect(err).toContain('giao packshot_box');
    const out = fresh('o');
    expect((await compose(fresh('pk'), out)).refused?.code).toBe('config');
    expect(files(out)).toEqual([]);
  });

  it('save_image từ chối kết quả không ok / thiếu ngữ cảnh dòng (trước DB)', async () => {
    const db = { query: () => Promise.reject(new Error('không được chạm DB')) } as Any;
    for (const bad of [null, { ok: false }, { ok: true, meta: null }]) {
      await expect(ims.saveImage(db, bad, { by: 'x' })).rejects.toThrow(RangeError);
    }
    await expect(
      ims.saveImage(db, { ok: true, meta: {}, sha256: 'a' }, { by: ' ' }),
    ).rejects.toThrow(/thiếu by/);
    await expect(
      ims.saveImage(db, { ok: true, meta: {}, sha256: 'a' }, { by: 'x' }),
    ).rejects.toThrow(/channel/);
    const full = {
      ok: true,
      meta: {},
      sha256: 'a',
      channel: 'facebook',
      sku: HONEY,
      format: '1:1',
      packshot_sha256: 'p',
    };
    for (const k of ['sku', 'format', 'packshot_sha256']) {
      for (const bad of [null, '']) {
        await expect(ims.saveImage(db, { ...full, [k]: bad }, { by: 'x' })).rejects.toThrow(k);
      }
    }
  });
});

// ============================================================== CLI

type Lines = { out: string[]; err: string[] };
const io = (): [Lines, { out: (s: string) => void; err: (s: string) => void }] => {
  const l: Lines = { out: [], err: [] };
  return [l, { out: (s) => l.out.push(s), err: (s) => l.err.push(s) }];
};
const failConnect = async () => {
  throw new Error('không được mở DB');
};
const fakeLease = () => ({ db: {} as Any, release: async () => {} });

describe('CLI image-studio', () => {
  it('sai tham số → exit 2', async () => {
    for (const o of [
      { sku: ['all'], channel: ['facebook'] },
      { sku: ['all'], channel: ['chatbot'], headline: 'x' },
      { sku: ['all'], channel: ['facebook'], format: ['2:3'], headline: 'x' },
      { channel: ['facebook'], headline: 'x' },
      { sku: ['all'], channel: ['facebook'], headline: 'x', by: '  ' },
    ]) {
      const [l, s] = io();
      expect(
        await imageStudioMain(o, { io: s, env: {}, connect: failConnect }),
        JSON.stringify(o),
      ).toBe(2);
      expect(l.err.join('\n')).toContain('error');
    }
  });

  it('IMAGE_PROVIDER lạ → exit 2 TRƯỚC DB, 0 file', async () => {
    const [l, s] = io();
    const out = fresh('o');
    const rc = await imageStudioMain(
      { sku: ['all'], channel: ['facebook'], headline: 'Quà' },
      { io: s, env: { IMAGE_PROVIDER: 'openai', IMAGE_OUT_DIR: out }, connect: failConnect },
    );
    expect(rc).toBe(2);
    expect(l.err.join('\n')).toContain('external-dep');
    expect(files(out)).toEqual([]);
  });

  it('--scene mà chưa có provider AI → [blocked] exit 2 TRƯỚC DB (v13.4)', async () => {
    const [l, s] = io();
    const rc = await imageStudioMain(
      { sku: [HONEY], channel: [CFG.channels[0]], headline: 'Quà', scene: 'bàn gỗ, lá sâm' },
      { io: s, env: {}, connect: failConnect },
    );
    expect(rc).toBe(2);
    expect(l.err.join('\n')).toContain('[blocked]');
    expect(l.err.join('\n')).toContain('IMAGE_PROVIDER');
  });

  it('DB chết → exit 2, 0 lời gọi provider, 0 file', async () => {
    const calls: unknown[] = [];
    const real = ims.PROVIDERS.none;
    ims.PROVIDERS.none = async (...a) => {
      calls.push(a);
      throw new Error('provider');
    };
    try {
      const [l, s] = io();
      const out = fresh('o');
      const rc = await imageStudioMain(
        { sku: ['all'], channel: ['facebook'], headline: 'Quà' },
        { io: s, env: { IMAGE_OUT_DIR: out }, connect: async () => null },
      );
      expect(rc).toBe(2);
      expect(calls).toEqual([]);
      expect(l.err.join('\n')).toContain('không ghi được');
      expect(files(out)).toEqual([]);
    } finally {
      ims.PROVIDERS.none = real as ims.ProviderFn;
    }
  });

  it('tính năng marketing-02.1 TẮT → [rollout] exit 2 TRƯỚC compose', async () => {
    settings.forceMode = 'tat';
    const [l, s] = io();
    let composed = 0;
    const rc = await imageStudioMain(
      { sku: [HONEY], channel: ['facebook'], headline: 'Quà' },
      {
        io: s,
        env: {},
        connect: async () => fakeLease(),
        wire: () => ({ chat: async () => Promise.reject(new Error('không gọi AI')) }) as Any,
        compose: async () => {
          composed++;
          throw new Error('không được dựng ảnh');
        },
      },
    );
    expect(rc).toBe(2);
    expect(composed).toBe(0);
    expect(l.out.join('\n')).toContain('[rollout]');
    expect(l.out.join('\n')).toContain('marketing-02.1');
  });

  it('dòng kết quả + exit code (created/skipped/refused/failed lỗi DB)', async () => {
    settings.forceMode = 'van_hanh';
    const plan: Record<string, Any> = {
      a: { ok: true, path: '/x/aa.png' },
      b: { ok: true, path: '/x/bb.png' },
      c: { ok: false, refused: { code: 'ruou', reason: 'rượu' } },
      d: { ok: true, path: '/x/dd.png' },
    };
    const saved: Record<string, Any> = {
      a: { status: 'created', draft_id: '1', asset_id: '9' },
      b: { status: 'skipped', draft_id: '2' },
    };
    const deps = (s: Any) => ({
      io: s,
      env: {},
      connect: async () => fakeLease(),
      wire: () => ({ chat: async () => ({}) }) as Any,
      readiness: async () => new Map(),
      compose: (async (sku: string) => plan[sku]) as Any,
      saveImage: (async (_db: unknown, res: Any) => {
        const k = (res.path as string).split('/').pop()?.[0] as string;
        if (k === 'd') throw Object.assign(new Error('mất kết nối'), { code: 'ECONNRESET' });
        return saved[k];
      }) as Any,
    });
    let [l, s] = io();
    expect(
      await imageStudioMain(
        { sku: ['a', 'b', 'c'], channel: ['facebook'], headline: 'x' },
        deps(s),
      ),
    ).toBe(0);
    let o = l.out.join('\n');
    expect(o).toContain('a × facebook × 1:1: created #1 aa.png');
    expect(o).toContain('b × facebook × 1:1: skipped bb.png');
    expect(o).toContain('c × facebook × 1:1: refused ruou: rượu');
    expect(o).toContain('created 1, skipped 1, refused 1, failed 0');
    [l, s] = io();
    expect(
      await imageStudioMain({ sku: ['d'], channel: ['facebook'], headline: 'x' }, deps(s)),
    ).toBe(1);
    o = l.out.join('\n');
    expect(o).toContain('d × facebook × 1:1: failed: lỗi DB');
  });

  it('dòng skipped nháp mồ côi', () => {
    expect(ims.line('h: ', { status: 'skipped', orphan_draft_id: '7', file: 'f.png' })).toBe(
      'h: skipped f.png (nháp mồ côi #7 do chạy song song — người reject)',
    );
  });

  it('module không có đường duyệt/đăng/mạng (chỉ openrouter.ts gọi mạng)', () => {
    for (const f of ['image-studio.ts', 'video-studio.ts', 'raster.ts', 'terms.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(
        /setStatus|approve_draft|schedule\(|fetch\(|node:https?|node:net|inpaint|shell: true/,
      );
    }
  });
});
