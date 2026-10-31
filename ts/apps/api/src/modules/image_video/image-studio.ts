import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cpLen, cpSlice, isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import {
  check,
  type ReadinessMap,
  readinessKey,
  readinessOf,
} from '@samsam/core/security/guardrail';
import { checkPublishLlm } from '@samsam/core/security/guardrail-llm';
import { pyRepr, pySplit, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  type AiDeps,
  contentCfg,
  type Guardrail,
  loadTemplate,
  precheck,
  publishTexts,
  type Refusal,
  refusedGuardrail,
  withRequired,
} from '../content/content.js';
import type { Font, Mask, Raw } from './raster.js';
import * as raster from './raster.js';
import { clean, codes, termHits, uniq } from './terms.js';

// Port `pipelines/image_studio.py` — MKT-03 "Agent Ảnh AI" (v6.2, WP08, tính năng marketing-02.1):
// ảnh marketing NHÁP ghép packshot THẬT.
// Bất biến (acceptance WP08: 100% asset AI có nhãn "Nội dung có sử dụng AI" + metadata model/prompt/
// ngày; QA không phát hiện ảnh nào bị AI sửa chữ trên nhãn):
// - AI KHÔNG chạm vùng nhãn — bằng CẤU TRÚC: provider nền chỉ nhận `(prompt, size)`, KHÔNG BAO GIỜ
//   nhận ảnh/bytes packshot. Thứ tự dựng: nền → tấm nhãn + chữ (ô không giao ô packshot) → packshot
//   dán SAU CÙNG bằng alpha của chính nó. Packshot chỉ THU NHỎ 1 lần (LANCZOS, giữ tỉ lệ) — bản thu
//   nhỏ (`fitted`) là chuẩn so: MỌI pixel alpha 255 khớp TUYỆT ĐỐI với file PNG ĐÃ GHI rồi đọc lại;
//   lệch 1 pixel → `packshot_lech`, xóa file tạm, không sidecar, không DB. Output chỉ PNG.
// - Nhãn AI (`labels.ai[0]`) LUÔN vẽ — kể cả nền tất định (provider `none`). `ai_generated` = true
//   CHỈ khi nền do provider AI. Loại `image` có `ad: true` → nhãn QC cũng vẽ. MỌI chữ trên ảnh nằm
//   trong `text_layer` và qua `checkPublishLlm`.
// - Ảnh output dựng MỚI từ pixel, PNG không EXIF/GPS/XMP/ICC.
// - Từ chối TRƯỚC khi gọi provider (0 file, 0 dòng DB), theo thứ tự: config | precheck content
//   (sku_la/kenh_la/loai_la/ruou) | maket_xnqc (MỌI SKU TPBVSK) | sku_la | kenh_la | readiness |
//   format_la | headline | prompt_cam | font | config/headline (không vừa ô) | packshot_thieu /
//   packshot_loi | provider.
// - Chỉ là NHÁP: `saveImage` ghi `content_drafts` (content_type 'image', pending) + `image_assets`.
//   Danh tính asset = (file_sha256, sku, channel, format). Sidecar mô tả FILE — không sku/kênh/
//   format/sha file packshot gốc. Module không có đường duyệt/đăng và không gọi mạng (provider
//   `openrouter_images` ở openrouter.ts, qua cổng AI).

export const CONTENT_TYPE = 'image';
export const DEFAULT_BY = 'agent:mkt03';
export const FEATURE = 'marketing-02.1';
export const TEMPLATE = 'image_background';
export const READY_LEVELS = ['TP_THUONG', 'QC_DAY_DU'];
export const SIDECAR_SCHEMA = 'image_asset@1';
export const MAKET_REASON = 'creative TPBVSK phải dùng maket XNQC';
export const MAX_SCENE = 300;
export const SKU_FILE_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Chỉ test đổi (Python monkeypatch `CONFIG`). */
export const paths = {
  config: dataPath('image_studio.json'),
  packshots: dataPath('packshots'),
  out: dataPath('image_assets'),
};

/** Provider nền lạ/lỗi/trả ảnh sai — compose từ chối `provider`. */
export class ImageProviderError extends Error {
  override name = 'ImageProviderError';
}

// ===================================================================== config

export type Box = [number, number, number, number];
export type ImageCfg = {
  channels: string[];
  formats: Map<string, [number, number]>;
  layout: Map<string, { packshot_box: Box; headline_box: Box; label_box: Box }>;
  label: {
    font_ratio: number;
    font_px_min: number;
    plate_rgba: number[];
    text_rgb: number[];
    padding_px: number;
  };
  headline: { max_chars: number; font_ratio: number; text_rgb: number[] };
  brand_colors: number[][];
  default_scene: string;
  fonts: string[];
  max_pixels: number;
  max_bytes: number;
  prompt_banned: string[];
};

/** Lỗi mang TÊN lớp ngoại lệ Python (thông điệp cấu hình hỏng in `Tên: chi tiết`). */
export class PyErr extends Error {
  constructor(
    readonly pyType: string,
    msg: string,
  ) {
    super(msg);
  }
}
const typeName = (v: unknown): string =>
  v === null || v === undefined
    ? 'NoneType'
    : typeof v === 'boolean'
      ? 'bool'
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? 'int'
          : 'float'
        : typeof v === 'string'
          ? 'str'
          : Array.isArray(v)
            ? 'list'
            : 'dict';

/** Python `o[k]` trên giá trị JSON (dict/list/…) → lỗi đúng TÊN ngoại lệ Python. */
export function key(o: unknown, k: string): unknown {
  if (isPlainObject(o)) {
    if (!Object.hasOwn(o, k)) throw new PyErr('KeyError', pyRepr(k));
    return o[k];
  }
  if (Array.isArray(o)) {
    throw new PyErr('TypeError', 'list indices must be integers or slices, not str');
  }
  if (typeof o === 'string')
    throw new PyErr('TypeError', "string indices must be integers, not 'str'");
  throw new PyErr('TypeError', `'${typeName(o)}' object is not subscriptable`);
}
/** shortcut: chỉ list là iterable (Python lặp được cả chuỗi/dict) — chặt hơn = fail-closed. */
export function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new PyErr('TypeError', `'${typeName(v)}' object is not iterable`);
  return v;
}
function items(v: unknown): [string, unknown][] {
  if (!isPlainObject(v)) {
    throw new PyErr('AttributeError', `'${typeName(v)}' object has no attribute 'items'`);
  }
  return Object.entries(v);
}
/** Python `int(v)` cho giá trị JSON. shortcut: chuỗi chỉ nhận số nguyên ASCII. */
export function toInt(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    if (/^[ \t\n\r\f\v]*[+-]?\d+[ \t\n\r\f\v]*$/.test(v)) return Number.parseInt(v.trim(), 10);
    throw new PyErr('ValueError', `invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new PyErr(
    'TypeError',
    `int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`,
  );
}
/** Python `float(v)` cho giá trị JSON. */
export function toFloat(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
    throw new PyErr('ValueError', `could not convert string to float: ${pyRepr(v)}`);
  }
  throw new PyErr(
    'TypeError',
    `float() argument must be a string or a real number, not '${typeName(v)}'`,
  );
}
const isIntV = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function rgb(v: unknown, n: number): number[] {
  if (!(Array.isArray(v) && v.length === n && v.every((x) => isIntV(x) && x >= 0 && x <= 255))) {
    throw new PyErr('ValueError', `màu phải là ${n} số nguyên 0..255`);
  }
  return v as number[];
}

function box(v: unknown): Box {
  if (!(Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number'))) {
    throw new PyErr('ValueError', 'box phải là [x, y, w, h] (phần trăm)');
  }
  const [x, y, w, h] = v as Box;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > 100 || y + h > 100) {
    throw new PyErr('ValueError', 'box ngoài khung 0..100%');
  }
  return [x, y, w, h];
}

const overlap = (a: Box, b: Box): boolean =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** Tên + chi tiết lỗi kiểu Python (`str(e)[:160]`). */
export function pyErrText(e: unknown, file: string): string {
  if (e instanceof PyErr) return `${e.pyType}: ${cpSlice(e.message, 0, 160)}`;
  if (e instanceof JsonFileError) {
    const detail =
      e.pyType === 'FileNotFoundError'
        ? `[Errno 2] No such file or directory: ${pyRepr(file)}`
        : 'JSON không đọc được';
    return `${e.pyType}: ${cpSlice(detail, 0, 160)}`;
  }
  return `${(e as Error)?.name ?? 'Exception'}: ${cpSlice(String((e as Error)?.message ?? e), 0, 160)}`;
}

/** `image_studio.load_config`: data/image_studio.json đã kiểm → [cfg, null] | [null, lý do].
 * headline_box/label_box giao packshot_box → lỗi (chữ/nhãn không được nằm trên vùng packshot). */
export function loadConfig(path: string = paths.config): [ImageCfg, null] | [null, string] {
  try {
    const doc = readJson(path);
    const formats = new Map<string, [number, number]>();
    const layout: ImageCfg['layout'] = new Map();
    for (const [name, wh] of items(key(doc, 'formats'))) {
      if (
        !(
          Array.isArray(wh) &&
          wh.length === 2 &&
          wh.every((v) => isIntV(v) && v >= 64 && v <= 4096)
        )
      ) {
        throw new PyErr('ValueError', `format ${name}: kích thước phải 64..4096`);
      }
      const lay = key(key(doc, 'layout'), name);
      const boxes = {
        packshot_box: box(key(lay, 'packshot_box')),
        headline_box: box(key(lay, 'headline_box')),
        label_box: box(key(lay, 'label_box')),
      };
      for (const k of ['headline_box', 'label_box'] as const) {
        if (overlap(boxes[k], boxes.packshot_box)) {
          throw new PyErr(
            'ValueError',
            `${k} giao packshot_box (format ${name}) — chữ/nhãn không được đè vùng packshot`,
          );
        }
      }
      formats.set(name, [wh[0] as number, wh[1] as number]);
      layout.set(name, boxes);
    }
    const lab = key(doc, 'label');
    const hl = key(doc, 'headline');
    const cfg: ImageCfg = {
      channels: list(key(doc, 'channels')).map(pyStr),
      formats,
      layout,
      label: {
        font_ratio: toFloat(key(lab, 'font_ratio')),
        font_px_min: toInt(key(lab, 'font_px_min')),
        plate_rgba: rgb(key(lab, 'plate_rgba'), 4),
        text_rgb: rgb(key(lab, 'text_rgb'), 3),
        padding_px: toInt(key(lab, 'padding_px')),
      },
      headline: {
        max_chars: toInt(key(hl, 'max_chars')),
        font_ratio: toFloat(key(hl, 'font_ratio')),
        text_rgb: rgb(key(hl, 'text_rgb'), 3),
      },
      brand_colors: list(key(doc, 'brand_colors')).map((c) => rgb(c, 3)),
      default_scene: pyStr(key(doc, 'default_scene')),
      fonts: list(key(doc, 'fonts')).map(pyStr),
      max_pixels: toInt(key(key(doc, 'packshot'), 'max_pixels')),
      max_bytes: toInt(key(key(doc, 'packshot'), 'max_bytes')),
      prompt_banned: list(key(doc, 'prompt_banned'))
        .map(pyStr)
        .filter((x) => pyStrip(x)),
    };
    if (
      !cfg.channels.length ||
      !formats.size ||
      cfg.brand_colors.length !== 2 ||
      !cfg.prompt_banned.length ||
      !pyStrip(cfg.default_scene) ||
      Math.min(cfg.label.font_px_min, cfg.headline.max_chars, cfg.max_pixels, cfg.max_bytes) < 1 ||
      cfg.label.font_ratio <= 0 ||
      cfg.headline.font_ratio <= 0 ||
      cfg.label.padding_px < 0
    ) {
      throw new PyErr('ValueError', 'thiếu kênh/format/màu/từ cấm hoặc giá trị ≤ 0');
    }
    return [cfg, null];
  } catch (e) {
    return [null, `image_studio.json không dùng được (${pyErrText(e, path)})`];
  }
}

/** Python `round()` (làm tròn nửa về số chẵn). */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** `_px`: box phần trăm → (x, y, w, h) pixel, tính theo 2 góc (2 ô kề nhau không giao vì làm tròn). */
export function px(b: Box, size: [number, number]): Box {
  const [W, H] = size;
  const x0 = pyRound((b[0] * W) / 100);
  const y0 = pyRound((b[1] * H) / 100);
  const x1 = pyRound(((b[0] + b[2]) * W) / 100);
  const y1 = pyRound(((b[1] + b[3]) * H) / 100);
  return [x0, y0, x1 - x0, y1 - y0];
}

// ============================================================ nền (provider)

/** Ảnh nền do provider trả + thông tin (phải có `model`). */
export type ProviderFn = (prompt: string | null, size: [number, number]) => Promise<[Raw, unknown]>;

/** Nền TẤT ĐỊNH: gradient dọc 2 màu thương hiệu (bản dev) — bỏ qua prompt, 0 mạng. */
async function bgNone(_prompt: string | null, size: [number, number]): Promise<[Raw, unknown]> {
  const [cfg, err] = loadConfig();
  if (cfg === null) throw new ImageProviderError(err);
  const [c0, c1] = cfg.brand_colors as [number[], number[]];
  const [W, H] = size;
  const img = raster.newRaw(W, H, 3);
  for (let y = 0; y < H; y++) {
    // Pillow linear_gradient("L") (256 hàng) thu về H hàng: tâm hàng → hàng nguồn
    const m = Math.max(0, Math.min(255, Math.round(((y + 0.5) * 256) / H - 0.5)));
    const row = [0, 1, 2].map((c) =>
      Math.floor(((c1[c] as number) * m + (c0[c] as number) * (255 - m) + 127) / 255),
    );
    for (let x = 0; x < W; x++) img.data.set(row, (y * W + x) * 3);
  }
  return [img, { model: 'none' }];
}

/** r13: nền AI qua OpenRouter Images API — mã mạng ở openrouter.ts (đăng ký lúc nạp module đó). */
async function bgOpenrouter(
  prompt: string | null,
  size: [number, number],
): Promise<[Raw, unknown]> {
  const orp = await import('./openrouter.js');
  return orp.background(prompt ?? '', size);
}

/** Tên → provider. Test thêm/xóa mục (Python monkeypatch `PROVIDERS`). */
export const PROVIDERS: Record<string, ProviderFn> = {
  none: bgNone,
  openrouter_images: bgOpenrouter,
};

/** `_provider_name`: tham số → env IMAGE_PROVIDER (đọc LÚC GỌI) → mặc định `none`. */
export function providerName(provider: string | null | undefined, env: Env = process.env): string {
  const name = provider ?? env.IMAGE_PROVIDER;
  return (name !== undefined && name !== null ? pyStrip(String(name)) : '') || 'none';
}

const errType = (e: unknown): string =>
  e instanceof Error
    ? e.constructor?.name && e.constructor.name !== 'Error'
      ? e.constructor.name
      : e.name
    : 'Exception';

/** `generate_background`: nền RGB đúng `size` + meta {provider, model, ai_generated}. Provider CHỈ
 * nhận (prompt, size). Tên lạ / lỗi / sai kích thước / không khai model → ImageProviderError
 * (fail-closed, không resize ngầm). */
export async function generateBackground(
  prompt: string | null,
  size: [number, number],
  o: { provider?: string | null; env?: Env } = {},
): Promise<[Raw, { provider: string; model: string; ai_generated: boolean }]> {
  const name = providerName(o.provider, o.env);
  const fn = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
  if (!fn) {
    throw new ImageProviderError(
      `chưa cắm provider ${pyRepr(cpSlice(name, 0, 40))} — API sinh ảnh là external-dep (key + hợp đồng); hỗ trợ: ${Object.keys(PROVIDERS).sort().join(', ')}`,
    );
  }
  const sz: [number, number] = [Math.trunc(size[0]), Math.trunc(size[1])];
  const ai = name !== 'none';
  let img: unknown;
  let info: unknown;
  try {
    [img, info] = await fn(ai ? prompt : null, sz);
  } catch (e) {
    if (e instanceof ImageProviderError) throw e;
    throw new ImageProviderError(`provider ${name} lỗi (${errType(e)})`, { cause: e });
  }
  if (!raster.isRaw(img) || img.width !== sz[0] || img.height !== sz[1]) {
    throw new ImageProviderError(
      `provider ${name} trả ảnh sai kích thước (cần ${sz[0]}x${sz[1]}) — không resize ngầm`,
    );
  }
  const model = isPlainObject(info) ? info.model : undefined;
  if (typeof model !== 'string' || !pyStrip(model)) {
    throw new ImageProviderError(`provider ${name} không khai model — không truy vết được`);
  }
  return [
    raster.toChannels(img, 3),
    { provider: name, model: cpSlice(pyStrip(model), 0, 100), ai_generated: ai },
  ];
}

// ===================================================================== scene / prompt

/** `check_scene`: mô tả nền do người nhập → {code: prompt_cam, reason} | null. Kiểm trên
 * `clean(scene)` — ĐÚNG chuỗi vào prompt. Chặn: từ `prompt_banned` (chuẩn hóa như guardrail),
 * câu nhắc sức khỏe/bệnh, `guardrail.check` không ok. Rỗng/null = dùng `default_scene`. */
export function checkScene(scene: unknown): Refusal | null {
  if (scene === null || scene === undefined || (typeof scene === 'string' && !pyStrip(scene))) {
    return null;
  }
  if (typeof scene !== 'string')
    return { code: 'prompt_cam', reason: 'mô tả nền không phải chuỗi' };
  const [cfg, err] = loadConfig();
  if (cfg === null) return { code: 'config', reason: err };
  // Kiểm ĐÚNG chuỗi sẽ vào prompt: bỏ cả Cc ("lo\x01go" không lọt kiểm rồi nối lại thành "logo").
  const s = clean(scene);
  if (cpLen(s) > MAX_SCENE) {
    return { code: 'prompt_cam', reason: `mô tả nền dài hơn ${MAX_SCENE} ký tự` };
  }
  const hits = termHits(s, cfg.prompt_banned);
  if (hits.length) {
    return {
      code: 'prompt_cam',
      reason: `mô tả nền có từ cấm (${uniq(hits).join(', ')}) — nền chỉ là bối cảnh: không người/y tế, không chữ/nhãn/logo/bao bì`,
    };
  }
  if (isHealthQuestion(s)) {
    return {
      code: 'prompt_cam',
      reason: 'mô tả nền nhắc sức khỏe/bệnh — nền không được gợi công dụng',
    };
  }
  const g = check(s);
  if (g.ok !== true) {
    return { code: 'prompt_cam', reason: `mô tả nền vi phạm guardrail (${codes(g)})` };
  }
  return null;
}

/** `background_prompt`: [prompt, version, template_sha256] từ template `image_background`
 * (manifest data/prompts — lệch sha → RangeError). `{scene}` thay bằng replaceAll; rỗng → mặc định. */
export function backgroundPrompt(scene: unknown): [string, string, string] {
  const [cfg, err] = loadConfig();
  if (cfg === null) throw new RangeError(err);
  const [tmpl, ver, sha] = loadTemplate(TEMPLATE);
  const s = clean(scene) || cfg.default_scene;
  return [tmpl.replaceAll('{scene}', () => s), ver, sha];
}

// ===================================================================== precheck

/** `content._level`: mức readiness (map view `sku_readiness`, null = soi gương golden). */
export function levelOf(sku: string, channel: string, readiness: ReadinessMap | null): string {
  if (readiness !== null) return pyStr(readiness.get(readinessKey(sku, channel)) ?? 'CAM');
  const [g] = contentCfg();
  return readinessOf(g?.golden.get(sku), channel);
}

/** `precheck_image`: từ chối rẻ (0 provider, 0 file) → {code, reason} | null. Tái dùng
 * `content.precheck` (rượu theo category TRƯỚC readiness); `xnqc` thay bằng `maket_xnqc` cho MỌI
 * SKU TPBVSK (kể cả QC_DAY_DU — creative TPBVSK chỉ dùng maket XNQC). */
export function precheckImage(
  sku: unknown,
  channel: unknown,
  fmt: unknown,
  readiness: unknown = null,
): Refusal | null {
  const [cfg, err] = loadConfig();
  if (cfg === null) return { code: 'config', reason: err };
  const ref = precheck(sku, channel, CONTENT_TYPE, readiness);
  if (ref && ref.code !== 'xnqc') return ref;
  if (sku === null || sku === undefined) {
    return { code: 'sku_la', reason: 'ảnh cần SKU có packshot (ảnh sản phẩm thật)' };
  }
  const [gcfg, gerr] = contentCfg();
  if (gcfg === null) return { code: 'config', reason: gerr };
  const s = sku as string;
  if (gcfg.golden.get(s)?.category === 'tpbvsk') {
    return {
      code: 'maket_xnqc',
      reason: `${s} là TPBVSK — ${MAKET_REASON} (hồ sơ XNQC chưa có — external-dep); agent không tạo biến thể ảnh`,
    };
  }
  if (typeof channel !== 'string' || !cfg.channels.includes(channel)) {
    return {
      code: 'kenh_la',
      reason: `kênh ${pyRepr(cpSlice(pyStr(channel), 0, 40))} không hỗ trợ cho ảnh (${cfg.channels.join(', ')})`,
    };
  }
  const level = levelOf(s, channel, readiness as ReadinessMap | null);
  if (!READY_LEVELS.includes(level)) {
    return {
      code: 'readiness',
      reason: `${s} mức ${level} trên kênh ${channel} — chưa đủ điều kiện ảnh quảng cáo (cần TP_THUONG/QC_DAY_DU: tự công bố đã xác minh + kênh trong allowed_channels)`,
    };
  }
  if (typeof fmt !== 'string' || !cfg.formats.has(fmt)) {
    return {
      code: 'format_la',
      reason: `format ${pyRepr(cpSlice(pyStr(fmt), 0, 20))} không có trong image_studio.json (${[...cfg.formats.keys()].join(', ')})`,
    };
  }
  return null;
}

// ===================================================================== font + chữ

/** `fonts_for`: font đầu tiên (env IMAGE_FONT rồi `fonts` của config) phủ đủ glyph MỌI ký tự
 * không-khoảng-trắng của `text` (NFC). Không font nào → null (compose từ chối `font`, không vẽ ô vuông). */
export function fontsFor(text: string, env: Env = process.env): Font | null {
  const [cfg] = loadConfig();
  const cands = [env.IMAGE_FONT ?? '', ...(cfg ? cfg.fonts : [])];
  for (const p of uniq(cands.filter((c) => c && pyStrip(c)).map(pyStrip))) {
    const font = raster.loadFont(p);
    if (font && raster.fontCovers(font, text)) return font;
  }
  return null;
}

/** Điểm thay của test (Python monkeypatch `_paste_packshot` / `ImageDraw.multiline_text` / `load`). */
export const hooks = {
  /** Dán packshot SAU CÙNG bằng alpha của chính nó — không lớp nào được vẽ sau bước này. */
  pastePackshot(canvas: Raw, fitted: Raw, xy: [number, number]): Raw {
    raster.pasteAlpha(canvas, fitted, xy[0], xy[1]);
    return canvas;
  },
  /** Vẽ 1 khối chữ (nhãn / headline / phụ đề) lên lớp RGBA. */
  drawText(
    overlay: Raw,
    mask: Mask,
    x: number,
    y: number,
    rgba: readonly number[],
    _text: string,
  ): void {
    raster.drawMask(overlay, mask, x, y, rgba);
  },
  decode: raster.decode,
};

type Renderer = (
  text: string,
  size: number,
  spacing: number,
  align: 'left' | 'centre',
) => Promise<Mask>;

function renderer(font: Font): Renderer {
  const cache = new Map<string, Mask>();
  return async (text, size, spacing, align) => {
    const k = `${size}|${spacing}|${align}|${text}`;
    let m = cache.get(k);
    if (!m) {
      m = await raster.renderText(font, text, size, spacing, align);
      cache.set(k, m);
    }
    return m;
  };
}

/** `_wrap`: ngắt dòng tham lam theo từ cho vừa `width`; 1 từ dài hơn → null. */
async function wrap(
  r: Renderer,
  text: string,
  size: number,
  width: number,
): Promise<string | null> {
  const lines: string[] = [];
  let cur = '';
  for (const w of pySplit(text)) {
    const cand = cur ? `${cur} ${w}` : w;
    if ((await r(cand, size, 0, 'left')).width <= width) {
      cur = cand;
      continue;
    }
    if (!cur || (await r(w, size, 0, 'left')).width > width) return null;
    lines.push(cur);
    cur = w;
  }
  lines.push(cur);
  return lines.join('\n');
}

export type Laid = { overlay: Raw; lbox: Box; hbox: Box; pbox: Box };

/** `_layout_text`: lớp chữ (RGBA trong suốt) → Laid | [code, reason]. Nhãn cỡ CỐ ĐỊNH
 * max(font_px_min, font_ratio×H) — không vừa → config; headline tự thu nhỏ tới cỡ nhãn, không vừa →
 * headline. */
export async function layoutText(
  font: Font,
  cfg: ImageCfg,
  fmt: string,
  headline: string,
  labels: string[],
): Promise<Laid | [string, string]> {
  const [W, H] = cfg.formats.get(fmt) as [number, number];
  const lay = cfg.layout.get(fmt) as NonNullable<ReturnType<ImageCfg['layout']['get']>>;
  const lab = cfg.label;
  const lbox = px(lay.label_box, [W, H]);
  const hbox = px(lay.headline_box, [W, H]);
  const pbox = px(lay.packshot_box, [W, H]);
  const overlay = raster.newRaw(W, H, 4);
  const r = renderer(font);
  const pad = lab.padding_px;
  const lsize = Math.max(lab.font_px_min, pyRound(lab.font_ratio * H));
  const sp = Math.max(2, Math.floor(lsize / 4));
  const ltext = labels.join('\n');
  const lmask = await r(ltext, lsize, sp, 'left');
  if (lmask.width > lbox[2] - 2 * pad || lmask.height > lbox[3] - 2 * pad) {
    return [
      'config',
      `nhãn cỡ ${lsize}px không vừa label_box format ${fmt} — sửa layout (không thu nhỏ nhãn)`,
    ];
  }
  let hmask: Mask | null = null;
  let htext = '';
  let hsize = Math.max(lsize, pyRound(cfg.headline.font_ratio * H));
  while (hsize >= lsize) {
    const t = await wrap(r, headline, hsize, hbox[2]);
    if (t !== null) {
      const m = await r(t, hsize, Math.max(2, Math.floor(hsize / 5)), 'centre');
      if (m.width <= hbox[2] && m.height <= hbox[3]) {
        hmask = m;
        htext = t;
        break;
      }
    }
    hsize -= Math.max(1, Math.floor(hsize / 10));
  }
  if (hmask === null) {
    return ['headline', `headline không vừa headline_box format ${fmt} (cỡ tối thiểu ${lsize}px)`];
  }
  const [x, y, w, h] = lbox;
  raster.fillRect(overlay, x, y, w, h, lab.plate_rgba);
  hooks.drawText(
    overlay,
    lmask,
    x + pad,
    y + Math.floor((h - lmask.height) / 2),
    [...lab.text_rgb, 255],
    ltext,
  );
  const [hx, hy, hw, hh] = hbox;
  hooks.drawText(
    overlay,
    hmask,
    hx + Math.floor((hw - hmask.width) / 2),
    hy + Math.floor((hh - hmask.height) / 2),
    [...cfg.headline.text_rgb, 255],
    htext,
  );
  return { overlay, lbox, hbox, pbox };
}

// ===================================================================== packshot

/** `_load_packshot` → [{img RGBA, file_sha256}, null] | [null, [code, reason]]. Kiểm byte + pixel
 * từ HEADER TRƯỚC khi giải (chống bomb); chỉ PNG. */
export async function loadPackshot(
  pdir: string,
  sku: string,
  cfg: ImageCfg,
): Promise<[{ img: Raw; file_sha256: string }, null] | [null, [string, string]]> {
  if (!SKU_FILE_RE.test(sku)) return [null, ['packshot_loi', 'sku_key không hợp lệ làm tên file']];
  const path = join(pdir, `${sku}.png`);
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return [
      null,
      [
        'packshot_thieu',
        `thiếu packshot ${sku}.png trong PACKSHOT_DIR — công ty cấp ảnh sản phẩm thật (PNG nền trong suốt)`,
      ],
    ];
  }
  let raw: Buffer;
  let img: Raw;
  try {
    if (statSync(path).size > cfg.max_bytes) {
      return [null, ['packshot_loi', `packshot ${sku} lớn hơn ${cfg.max_bytes} byte`]];
    }
    raw = readFileSync(path);
    let head: Awaited<ReturnType<typeof raster.probe>>;
    try {
      head = await raster.probe(raw);
    } catch (e) {
      if (e instanceof raster.RasterUnavailable) throw e;
      return [null, ['packshot_loi', `packshot ${sku} không đọc được (UnidentifiedImageError)`]];
    }
    if (head.format !== 'PNG') {
      return [null, ['packshot_loi', `packshot ${sku} không phải PNG (${head.format})`]];
    }
    if (head.width * head.height > cfg.max_pixels) {
      return [
        null,
        [
          'packshot_loi',
          `packshot ${sku} ${head.width}x${head.height} vượt ${cfg.max_pixels} pixel`,
        ],
      ];
    }
    img = await hooks.decode(raw, 4, cfg.max_pixels);
  } catch (e) {
    if (e instanceof raster.RasterUnavailable) throw e;
    return [null, ['packshot_loi', `packshot ${sku} không đọc được (OSError)`]];
  }
  return [{ img, file_sha256: sha256(raw) }, null];
}

/** `_fit_packshot`: chỉ THU NHỎ (không phóng) 1 lần LANCZOS giữ tỉ lệ cho vừa ô. RGB dưới alpha 0
 * chuẩn hóa về 0 — 2 file cùng hình khác "rác" vùng trong suốt ra cùng `fitted_sha256`. */
export async function fitPackshot(img: Raw, b: Box): Promise<Raw> {
  const { width: w, height: h } = img;
  const scale = Math.min(b[2] / w, b[3] / h, 1.0);
  let out = img;
  if (scale < 1.0) {
    out = await raster.resize(
      img,
      Math.max(1, Math.floor(w * scale)),
      Math.max(1, Math.floor(h * scale)),
    );
  } else {
    out = { ...img, data: Buffer.from(img.data) };
  }
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) out.data.fill(0, i, i + 3);
  }
  return out;
}

/** `_solid`: mặt nạ (0/255) pixel alpha 255 của packshot. */
export function solid(fitted: Raw): Uint8Array {
  const m = new Uint8Array(fitted.width * fitted.height);
  for (let i = 0; i < m.length; i++) m[i] = fitted.data[i * 4 + 3] === 255 ? 255 : 0;
  return m;
}

export const verifyPackshot = raster.verifyPackshot;

/** `_color_mask` (đếm): số pixel ĐÚNG màu `rgb` trong `box` — chỉ CHỮ nhãn (tô đặc) ra đúng màu này,
 * tấm nền bán trong suốt pha nền không bao giờ trùng tuyệt đối. */
export const colorCount = (img: Raw, b: readonly number[], rgbv: readonly number[]): number =>
  raster.nearCount(img, b, rgbv, 0);

// ===================================================================== compose

export const sha256 = (b: string | Uint8Array): string =>
  createHash('sha256').update(b).digest('hex');

/** Ghi nguyên tử: tệp tạm cùng thư mục + rename. */
export function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = join(
    join(path, '..'),
    `.tmp-${randomBytes(6).toString('hex')}${path.slice(path.lastIndexOf('.'))}`,
  );
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* đã rename */
    }
  }
}

/** `_same_sidecar`: sidecar trên đĩa giữ (trả bản đĩa) CHỈ khi mọi field trừ `created_at` trùng meta
 * vừa tính. Hỏng / sửa tay / lệch → null (caller ghi lại) — metadata truy vết không lấy từ file
 * chưa kiểm (OWASP A08). */
export function sameSidecar(
  path: string,
  meta: Record<string, unknown>,
): Record<string, unknown> | null {
  let d: unknown;
  try {
    d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  } catch {
    return null;
  }
  if (!(isPlainObject(d) && typeof d.created_at === 'string')) return null;
  const strip = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'created_at'));
  return isDeepStrictEqual(strip(d), strip(meta)) ? d : null;
}

export const isoNow = (now: Date = new Date()): string => `${now.toISOString().slice(0, 19)}+00:00`;

export type ImageMeta = Record<string, unknown> & {
  file: string;
  labels: string[];
  ai_generated: boolean;
  label_box: number[];
  packshot: { fitted_sha256: string; box: number[] };
  background: {
    provider: string;
    model: string;
    prompt: string | null;
    prompt_sha256: string | null;
    prompt_version: string | null;
    template_sha256: string | null;
  };
};

export type ComposeResult = {
  ok: boolean;
  refused: Refusal | null;
  path: string | null;
  sidecar: string | null;
  sha256: string | null;
  channel: string | null;
  sku: string | null;
  format: string | null;
  packshot_sha256: string | null;
  text_layer: string;
  draft_text: string;
  guardrail: Guardrail | null;
  meta: ImageMeta | null;
  fitted: Raw | null;
  packshot_xy: [number, number] | null;
};

export type ComposeOpts = {
  fmt?: string;
  scene?: unknown;
  readiness?: unknown;
  provider?: string | null;
  packshotDir?: string;
  outDir?: string;
};

/** Ngữ cảnh guardrail đăng bài: gateway (lớp LLM phụ) + env (IMAGE_PROVIDER/IMAGE_FONT/PACKSHOT_DIR…). */
export type StudioDeps = { ai: AiDeps['ai'] | null; env?: Env };

const fsErrName = (e: unknown): string => {
  const c = (e as { code?: string })?.code;
  return c === 'EACCES' || c === 'EPERM'
    ? 'PermissionError'
    : c === 'ENOENT'
      ? 'FileNotFoundError'
      : c === 'EEXIST'
        ? 'FileExistsError'
        : c === 'EISDIR'
          ? 'IsADirectoryError'
          : 'OSError';
};
/** Lỗi hệ thống tệp của Node (Python OSError). */
export function isFsError(e: unknown): boolean {
  const c = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && typeof c === 'string' && /^E[A-Z]+$/.test(c);
}
export { fsErrName };

/** `compose`: ghép 1 ảnh nháp. Từ chối → ok false + `refused` {code, reason}, 0 file. Thành công →
 * PNG `<out>/<sha256>.png` + sidecar `.json` (PNG cùng tên giữ CHỈ khi bytes đúng sha; sidecar giữ
 * khi trùng mọi field trừ created_at). `draft_text` = text_layer + dòng tên file (sha ràng ảnh vào
 * bản duyệt). `fitted`/`packshot_xy` = chuẩn so toàn vẹn. */
export async function compose(
  sku: unknown,
  channel: unknown,
  headline: unknown,
  o: ComposeOpts,
  d: StudioDeps,
): Promise<ComposeResult> {
  const env = d.env ?? process.env;
  const fmt = o.fmt ?? '1:1';
  const readiness = o.readiness ?? null;
  const out: ComposeResult = {
    ok: false,
    refused: null,
    path: null,
    sidecar: null,
    sha256: null,
    channel: null,
    sku: null,
    format: null,
    packshot_sha256: null,
    text_layer: '',
    draft_text: '',
    guardrail: null,
    meta: null,
    fitted: null,
    packshot_xy: null,
  };
  const refuse = (
    code: string,
    reason: string,
    g: Guardrail | null = null,
    kw: Partial<ComposeResult> = {},
  ) => {
    const ref = { code, reason };
    return { ...out, ...kw, refused: ref, guardrail: g ?? refusedGuardrail(ref) };
  };
  const [cfg, err] = loadConfig();
  if (cfg === null) return refuse('config', err);
  const pre = precheckImage(sku, channel, fmt, readiness);
  if (pre) return refuse(pre.code, pre.reason);
  const s = sku as string;
  const ch = channel as string;
  // (5) Chữ trên ảnh: headline + nhãn do CODE chèn — nhãn AI luôn đứng đầu nhóm nhãn.
  const hl = clean(headline);
  if (!hl) return refuse('headline', 'headline rỗng');
  if (cpLen(hl) > cfg.headline.max_chars) {
    return refuse('headline', `headline ${cpLen(hl)} ký tự > ${cfg.headline.max_chars}`);
  }
  const [, ai] = publishTexts();
  if (!ai.length) return refuse('config', 'guardrail_rules.json thiếu labels.ai');
  const rmap = readiness as ReadinessMap | null;
  const full = withRequired(hl, {
    channel: ch,
    contentType: CONTENT_TYPE,
    sku: s,
    readiness: rmap,
  });
  const pieces = full
    .slice(hl.length)
    .split('\n\n')
    .map(pyStrip)
    .filter((p) => p);
  const labels = [ai[0] as string, ...pieces.filter((p) => p !== ai[0])];
  const textLayer = [hl, ...labels].join('\n');
  const g = (await checkPublishLlm(
    textLayer,
    { channel: ch, contentType: CONTENT_TYPE, sku: s, isAi: true, readiness: rmap },
    { gateway: d.ai, env },
  )) as Guardrail;
  if (g.ok !== true) {
    return refuse('headline', `chữ trên ảnh vi phạm guardrail (${codes(g)})`, g, {
      text_layer: textLayer,
    });
  }
  const kw = { text_layer: textLayer };
  // (6) mô tả nền
  const sref = checkScene(o.scene ?? null);
  if (sref) return refuse(sref.code, sref.reason, null, kw);
  // (7) font phủ đủ glyph + bố cục chữ vừa ô
  const font = fontsFor(textLayer, env);
  if (font === null) {
    return refuse(
      'font',
      'không font nào (IMAGE_FONT / fonts trong image_studio.json) phủ đủ glyph chữ trên ảnh — không vẽ ô vuông',
      null,
      kw,
    );
  }
  try {
    const laid = await layoutText(font, cfg, fmt, hl, labels);
    if (Array.isArray(laid)) return refuse(laid[0], laid[1], null, kw);
    const { overlay, lbox, hbox, pbox } = laid;
    // (8) packshot thật — thu nhỏ vừa ô, phải có pixel đặc
    const pdir = o.packshotDir || env.PACKSHOT_DIR || paths.packshots;
    const [pk, perr] = await loadPackshot(pdir, s, cfg);
    if (pk === null) return refuse(perr[0], perr[1], null, kw);
    const fitted = await fitPackshot(pk.img, pbox);
    if (raster.solidCount(fitted) === 0) {
      return refuse(
        'packshot_loi',
        'packshot không có pixel đặc (alpha 255) — không kiểm được toàn vẹn nhãn',
        null,
        kw,
      );
    }
    const xy: [number, number] = [
      pbox[0] + Math.floor((pbox[2] - fitted.width) / 2),
      pbox[1] + Math.floor((pbox[3] - fitted.height) / 2),
    ];
    // (9) nền — provider CHỈ nhận (prompt, size)
    const [W, H] = cfg.formats.get(fmt) as [number, number];
    const name = providerName(o.provider, env);
    let prompt: string | null = null;
    let ver: string | null = null;
    let tsha: string | null = null;
    if (name !== 'none') {
      try {
        [prompt, ver, tsha] = backgroundPrompt(o.scene ?? null);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        return refuse('config', e.message, null, kw);
      }
    }
    let bg: Raw;
    let bmeta: { provider: string; model: string; ai_generated: boolean };
    try {
      [bg, bmeta] = await generateBackground(prompt, [W, H], { provider: name, env });
    } catch (e) {
      if (!(e instanceof ImageProviderError)) throw e;
      return refuse('provider', e.message, null, kw);
    }
    const canvas = hooks.pastePackshot(raster.compositeOver(bg, overlay), fitted, xy);
    // dựng mới từ pixel: không info/EXIF
    const final: Raw = {
      width: W,
      height: H,
      channels: 3,
      data: Buffer.from(raster.toChannels(canvas, 3).data),
    };
    const odir = o.outDir || env.IMAGE_OUT_DIR || paths.out;
    mkdirSync(odir, { recursive: true });
    const tmp = join(odir, `.tmp-${randomBytes(6).toString('hex')}.png`);
    let sha: string;
    let png: string;
    try {
      writeFileSync(tmp, await raster.encodePng(final));
      const data = readFileSync(tmp);
      const back = await raster.decode(data, 3);
      if (!raster.verifyPackshot(back, fitted, xy)) {
        return refuse(
          'packshot_lech',
          'vùng packshot trong ảnh đã ghi lệch pixel so với packshot gốc — loại ảnh (không lớp nào được vẽ đè nhãn sản phẩm)',
          null,
          kw,
        );
      }
      sha = sha256(data);
      png = join(odir, `${sha}.png`);
      // File cùng tên chỉ được giữ khi bytes đúng sha — tên không chứng minh nội dung.
      let same = false;
      try {
        same = sha256(readFileSync(png)) === sha;
      } catch {
        same = false;
      }
      if (!same) renameSync(tmp, png);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* đã rename */
      }
    }
    // Sidecar mô tả FILE: chỉ field cùng giá trị cho MỌI mục (SKU × kênh × format) ra đúng ảnh này.
    const side = join(odir, `${sha}.json`);
    let meta: ImageMeta = {
      schema: SIDECAR_SCHEMA,
      file: basename(png),
      asset_sha256: sha,
      size: [W, H],
      ai_generated: bmeta.ai_generated,
      labels,
      label_box: [...lbox],
      headline: hl,
      headline_box: [...hbox],
      packshot: {
        fitted_sha256: sha256(fitted.data),
        box: [xy[0], xy[1], fitted.width, fitted.height],
      },
      background: {
        provider: bmeta.provider,
        model: bmeta.model,
        prompt,
        prompt_sha256: prompt ? sha256(Buffer.from(prompt, 'utf8')) : null,
        prompt_version: ver,
        template_sha256: tsha,
      },
      created_at: isoNow(),
      guardrail_ok: true,
    };
    const kept = sameSidecar(side, meta);
    if (kept !== null) meta = kept as ImageMeta;
    else writeAtomic(side, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    return {
      ...out,
      ok: true,
      path: png,
      sidecar: side,
      sha256: sha,
      channel: ch,
      sku: s,
      format: fmt,
      packshot_sha256: pk.file_sha256,
      text_layer: textLayer,
      draft_text: `${textLayer}\n\nTệp ảnh: ${basename(png)}`,
      guardrail: g,
      meta,
      fitted,
      packshot_xy: xy,
    };
  } catch (e) {
    if (e instanceof raster.RasterUnavailable) return refuse('config', e.message, null, kw);
    throw e;
  }
}

// ===================================================================== lưu DB

const ASSET_SQL =
  'insert into image_assets (file_sha256, file_name, sku, channel, format, ai_generated, label_text, provider, model, prompt_sha256, prompt_version, packshot_sha256, draft_id, meta, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id';

export type SaveResult =
  | { status: 'created'; draft_id: string; asset_id: string }
  | { status: 'skipped'; draft_id: string }
  | { status: 'skipped'; orphan_draft_id: string | null };

/** `save_image`: lưu ảnh nháp (`res` = compose ok=true, khác → RangeError). Danh tính asset =
 * (file_sha256, sku, channel, format): đã có → skipped (kể cả nháp đã reject). Chưa có →
 * `saveDraft` (content_type 'image', pending, text = draft_text có tên file sha) rồi INSERT
 * `image_assets`. Unique lúc INSERT (2 tiến trình cùng mục) → skipped + `orphan_draft_id` — nháp
 * mồ côi để NGƯỜI reject (agent không có quyền xóa). */
export async function saveImage(
  db: Db,
  res: unknown,
  o: { by: string; source?: string },
): Promise<SaveResult> {
  const r = res as Partial<ComposeResult> | null;
  if (!(r && typeof r === 'object' && r.ok === true && isPlainObject(r.meta) && r.sha256)) {
    throw new RangeError('save_image: chỉ lưu kết quả compose ok=True');
  }
  const who = pyStrip(o.by ?? '');
  if (!who) throw new RangeError('save_image: thiếu by (người/agent tạo)');
  for (const k of ['channel', 'sku', 'format', 'packshot_sha256'] as const) {
    if (!(typeof r[k] === 'string' && r[k])) throw new RangeError(`save_image: thiếu ${k}`);
  }
  const [ch, sku, fmt] = [r.channel as string, r.sku as string, r.format as string];
  const m = r.meta as ImageMeta;
  const sha = r.sha256 as string;
  const bg = m.background;
  const { rows } = await db.query<{ draft_id: string }>(
    'select draft_id from image_assets where file_sha256 = $1 and sku = $2 and channel = $3 and format = $4',
    [sha, sku, ch, fmt],
  );
  if (rows.length) return { status: 'skipped', draft_id: String(rows[0]?.draft_id) };
  const did = await saveDraft(db, {
    brief: `image ${sku} ${ch} ${fmt}`,
    channel: ch,
    text: r.draft_text ?? '',
    guardrail: r.guardrail,
    source: o.source ?? SOURCE_CLI,
    createdBy: who,
    contentType: CONTENT_TYPE,
    sku,
    isAi: true,
    promptVersion: bg.prompt_version,
    promptSha256: bg.prompt_sha256,
  });
  try {
    const a = await db.query<{ id: string }>(ASSET_SQL, [
      sha,
      m.file,
      sku,
      ch,
      fmt,
      Boolean(m.ai_generated),
      m.labels.join('\n'),
      bg.provider,
      bg.model,
      bg.prompt_sha256,
      bg.prompt_version,
      r.packshot_sha256,
      did,
      JSON.stringify(m),
      who,
    ]);
    return { status: 'created', draft_id: String(did), asset_id: String(a.rows[0]?.id) };
  } catch (e) {
    if ((e as { code?: string })?.code === '23505')
      return { status: 'skipped', orphan_draft_id: did };
    throw e;
  }
}

// ===================================================================== mẫu packshot

/** `make_sample_packshot`: packshot MẪU (PNG RGBA nền trong suốt, thân + nắp + khối nhãn chữ "MẪU" +
 * mã SKU) cho test/eval — KHÔNG phải ảnh sản phẩm thật. Mọi pixel thân/nhãn là alpha 255 → so toàn
 * vẹn được. `exifGps`: nhúng EXIF (GPS) + XMP để test ảnh output không mang metadata. */
export async function makeSamplePackshot(
  path: string,
  sku: string,
  size: [number, number] = [600, 800],
  o: { exifGps?: boolean; env?: Env } = {},
): Promise<string> {
  const [W, H] = size;
  const img = raster.newRaw(W, H, 4);
  const body: Box = [
    Math.trunc(W * 0.18),
    Math.trunc(H * 0.16),
    Math.trunc(W * 0.82),
    Math.trunc(H * 0.97),
  ];
  const cap: Box = [
    Math.trunc(W * 0.36),
    Math.trunc(H * 0.03),
    Math.trunc(W * 0.64),
    Math.trunc(H * 0.17),
  ];
  // shortcut: thân chữ nhật (Pillow bo góc) — mẫu test, không phải ảnh thật.
  raster.fillRect(
    img,
    body[0],
    body[1],
    body[2] - body[0] + 1,
    body[3] - body[1] + 1,
    [122, 74, 32, 255],
  );
  raster.fillRect(img, cap[0], cap[1], cap[2] - cap[0] + 1, cap[3] - cap[1] + 1, [40, 40, 40, 255]);
  const [lx0, ly0, lx1, ly1] = [
    Math.trunc(W * 0.24),
    Math.trunc(H * 0.38),
    Math.trunc(W * 0.76),
    Math.trunc(H * 0.78),
  ];
  raster.fillRect(img, lx0, ly0, lx1 - lx0 + 1, ly1 - ly0 + 1, [250, 246, 232, 255]);
  const font = fontsFor(`MẪU ${sku}`, o.env);
  if (font) {
    const cx = Math.floor((lx0 + lx1) / 2);
    for (const [text, sz, color, cy] of [
      [
        'MẪU',
        Math.max(12, Math.floor(H / 10)),
        [200, 20, 20, 255],
        ly0 + Math.floor((ly1 - ly0) / 3),
      ],
      [
        sku,
        Math.max(10, Math.floor(H / 40)),
        [20, 20, 20, 255],
        ly0 + Math.floor((2 * (ly1 - ly0)) / 3),
      ],
    ] as [string, number, number[], number][]) {
      const m = await raster.renderText(font, text, sz, 0, 'left');
      // chữ vẽ đặc lên nhãn (alpha giữ 255 → pixel viền chữ vẫn là pixel đặc)
      raster.drawMask(img, m, cx - Math.floor(m.width / 2), cy - Math.floor(m.height / 2), color);
    }
  }
  mkdirSync(join(path, '..'), { recursive: true });
  let p = (await raster.sharp())(img.data, { raw: { width: W, height: H, channels: 4 } });
  if (o.exifGps) {
    p = p
      .withExif({
        IFD0: { ImageDescription: 'MAU packshot test GPS' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '15/1 30/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '108/1 0/1 0/1',
        },
      })
      .withXmp("<x:xmpmeta xmlns:x='adobe:ns:meta/'>GPS 15.5N 108E</x:xmpmeta>");
  }
  writeFileSync(path, await p.png().toBuffer());
  return path;
}

// ===================================================================== CLI (dòng kết quả)

export type Item =
  | { status: 'created'; draft_id: string; asset_id: string; file: string }
  | { status: 'skipped'; draft_id?: string; orphan_draft_id?: string | null; file: string }
  | { status: 'refused'; code: string; reason: string }
  | { status: 'failed'; reason: string };

/** `_line`: 1 dòng kết quả CLI. */
export function line(head: string, it: Item): string {
  if (it.status === 'created') return `${head}created #${it.draft_id} ${it.file}`;
  if (it.status === 'skipped') {
    const orphan = it.orphan_draft_id;
    return `${head}skipped ${it.file}${orphan !== undefined && orphan !== null ? ` (nháp mồ côi #${orphan} do chạy song song — người reject)` : ''}`;
  }
  if (it.status === 'refused') return `${head}refused ${it.code}: ${it.reason}`;
  return `${head}failed: ${it.reason}`;
}
