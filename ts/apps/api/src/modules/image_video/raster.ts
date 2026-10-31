import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Sharp, SharpOptions } from 'sharp';

// Lớp pixel cho image_studio/video_studio (thay Pillow): ảnh = buffer RAW 8-bit (RGB/RGBA), giải/mã
// PNG/JPEG + thu nhỏ + vẽ chữ qua `sharp` (libvips + Pango/FreeType), phép ghép/so pixel viết tay ở
// đây để kiểm toàn vẹn packshot TUYỆT ĐỐI (không phụ thuộc thuật toán của thư viện).
// - `sharp` nạp LƯỜI: thiếu gói → `RasterUnavailable` (compose từ chối, không làm hỏng cả API).
//   shortcut: `sharp` hiện chỉ có trong node_modules nhờ Next.js (phụ thuộc tùy chọn) — bước tích hợp
//   khai `sharp` trong apps/api (deps_requests).
// - Font: kiểm glyph bằng bảng `cmap` của chính file TTF/OTF (Python so mask glyph thiếu U+E000) —
//   font không phủ đủ ký tự → bỏ, không vẽ ô vuông. Vẽ bằng Pango với `fontfile` + tên họ font đọc từ
//   bảng `name`. shortcut: số đo chữ = khung mực (ink) của Pango, khác `textbbox` Pillow vài px — bố
//   cục vẫn kiểm vừa ô theo đúng số đo đã vẽ.

export type Raw = { width: number; height: number; channels: 3 | 4; data: Buffer };

export class RasterUnavailable extends Error {
  override name = 'RasterUnavailable';
}

type SharpFn = (input?: Buffer | SharpOptions, opts?: SharpOptions) => Sharp;
let sharpFn: SharpFn | null = null;

export async function sharp(): Promise<SharpFn> {
  if (sharpFn) return sharpFn;
  try {
    const m = (await import('sharp')) as unknown as { default: SharpFn };
    sharpFn = m.default;
  } catch (e) {
    throw new RasterUnavailable(`thiếu thư viện ảnh sharp (${(e as Error).name})`);
  }
  return sharpFn;
}

export function newRaw(width: number, height: number, channels: 3 | 4, fill?: number[]): Raw {
  const data = Buffer.alloc(width * height * channels);
  if (fill?.some((v) => v !== 0)) {
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < channels; c++) data[i * channels + c] = fill[c] ?? 0;
    }
  }
  return { width, height, channels, data };
}

export function isRaw(v: unknown): v is Raw {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Raw;
  return (
    Number.isInteger(r.width) &&
    Number.isInteger(r.height) &&
    r.width > 0 &&
    r.height > 0 &&
    (r.channels === 3 || r.channels === 4) &&
    Buffer.isBuffer(r.data) &&
    r.data.length === r.width * r.height * r.channels
  );
}

/** Pillow `convert("RGB")` (bỏ alpha) / `convert("RGBA")` (alpha 255). */
export function toChannels(img: Raw, channels: 3 | 4): Raw {
  if (img.channels === channels) return img;
  const out = newRaw(img.width, img.height, channels);
  for (let i = 0; i < img.width * img.height; i++) {
    for (let c = 0; c < 3; c++)
      out.data[i * channels + c] = img.data[i * img.channels + c] as number;
    if (channels === 4) out.data[i * 4 + 3] = 255;
  }
  return out;
}

const FORMAT: Record<string, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  jpg: 'JPEG',
  webp: 'WEBP',
  gif: 'GIF',
  tiff: 'TIFF',
  svg: 'SVG',
  heif: 'HEIF',
  avif: 'AVIF',
};

/** Đọc HEADER (chưa giải pixel) → {format Pillow-style, width, height}; không nhận ra → ném. */
export async function probe(
  buf: Buffer,
): Promise<{ format: string; width: number; height: number }> {
  const m = await (await sharp())(buf).metadata();
  const f = String(m.format ?? '');
  return {
    format: FORMAT[f] ?? f.toUpperCase(),
    width: m.width ?? 0,
    height: m.height ?? 0,
  };
}

/** Giải ảnh → RAW 8-bit sRGB `channels` kênh (không xoay EXIF — Pillow cũng không). */
export async function decode(buf: Buffer, channels: 3 | 4, maxPixels?: number): Promise<Raw> {
  let p = (await sharp())(buf, maxPixels ? { limitInputPixels: maxPixels } : {}).toColourspace(
    'srgb',
  );
  p = channels === 4 ? p.ensureAlpha() : p.removeAlpha();
  const { data, info } = await p.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels, data };
}

/** Chỉ giữ chunk IHDR/IDAT/IEND (mọi chunk phụ — pHYs/tEXt/eXIf/iCCP… — bỏ; CRC từng chunk độc lập). */
export function stripPng(buf: Buffer): Buffer {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const end = i + 12 + len;
    if (keep.has(buf.toString('latin1', i + 4, i + 8))) parts.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

/** PNG lossless, KHÔNG metadata (không EXIF/XMP/ICC/pHYs — chỉ IHDR/IDAT/IEND như Pillow). */
export async function encodePng(img: Raw): Promise<Buffer> {
  return stripPng(
    await (await sharp())(img.data, {
      raw: { width: img.width, height: img.height, channels: img.channels },
    })
      .png({ compressionLevel: 6, adaptiveFiltering: false, palette: false })
      .toBuffer(),
  );
}

/** Thu nhỏ LANCZOS về đúng (w, h) (sharp tự nhân alpha trước khi lọc). */
export async function resize(img: Raw, w: number, h: number): Promise<Raw> {
  const { data, info } = await (await sharp())(img.data, {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: img.channels, data };
}

/** Pillow `ImageOps.fit(src, (W, H), LANCZOS)`: cắt phủ giữa khung. */
export async function coverFit(img: Raw, w: number, h: number): Promise<Raw> {
  const { data, info } = await (await sharp())(img.data, {
    raw: { width: img.width, height: img.height, channels: img.channels },
  })
    .resize(w, h, { kernel: 'lanczos3', fit: 'cover', position: 'centre' })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: img.channels, data };
}

/** Pillow `crop((x, y, x + w, y + h))` (vùng nằm trong ảnh). */
export function crop(img: Raw, x: number, y: number, w: number, h: number): Raw {
  const out = newRaw(w, h, img.channels);
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= img.height) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx < 0 || sx >= img.width) continue;
      img.data.copy(
        out.data,
        (j * w + i) * img.channels,
        (sy * img.width + sx) * img.channels,
        (sy * img.width + sx + 1) * img.channels,
      );
    }
  }
  return out;
}

const mix = (src: number, dst: number, a: number): number =>
  Math.floor((src * a + dst * (255 - a) + 127) / 255);

/** Dán `src` (RGBA) lên `dst` tại (x, y) theo alpha của chính nó: alpha 255 = giữ NGUYÊN RGB gốc. */
export function pasteAlpha(dst: Raw, src: Raw, x: number, y: number): void {
  const dc = dst.channels;
  for (let j = 0; j < src.height; j++) {
    const ty = y + j;
    if (ty < 0 || ty >= dst.height) continue;
    for (let i = 0; i < src.width; i++) {
      const tx = x + i;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (j * src.width + i) * 4;
      const a = src.data[s + 3] as number;
      if (a === 0) continue;
      const d = (ty * dst.width + tx) * dc;
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] =
          a === 255
            ? (src.data[s + c] as number)
            : mix(src.data[s + c] as number, dst.data[d + c] as number, a);
      }
    }
  }
}

/** Vẽ mặt nạ chữ (L) màu `rgba` lên lớp RGBA — như Pillow vẽ chữ: trộn cả 4 kênh theo độ phủ. */
export function drawMask(
  dst: Raw,
  mask: { width: number; height: number; data: Uint8Array },
  x: number,
  y: number,
  rgba: readonly number[],
): void {
  for (let j = 0; j < mask.height; j++) {
    const ty = y + j;
    if (ty < 0 || ty >= dst.height) continue;
    for (let i = 0; i < mask.width; i++) {
      const tx = x + i;
      if (tx < 0 || tx >= dst.width) continue;
      const m = mask.data[j * mask.width + i] as number;
      if (m === 0) continue;
      const d = (ty * dst.width + tx) * 4;
      for (let c = 0; c < 4; c++) {
        dst.data[d + c] =
          m === 255 ? (rgba[c] as number) : mix(rgba[c] as number, dst.data[d + c] as number, m);
      }
    }
  }
}

/** Tô hình chữ nhật (thay pixel, không trộn — Pillow `rectangle(fill=)` trên RGBA). */
export function fillRect(
  dst: Raw,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly number[],
): void {
  for (let j = Math.max(0, y); j < Math.min(dst.height, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(dst.width, x + w); i++) {
      const d = (j * dst.width + i) * dst.channels;
      for (let c = 0; c < dst.channels; c++) dst.data[d + c] = color[c] ?? 255;
    }
  }
}

/** Pillow `alpha_composite(bg RGBA đặc, overlay).convert("RGB")`. */
export function compositeOver(bg: Raw, overlay: Raw): Raw {
  const out = toChannels(bg, 3);
  const res = { ...out, data: Buffer.from(out.data) };
  pasteAlpha(res, overlay, 0, 0);
  return res;
}

/** Số pixel alpha 255 (pixel ĐẶC) của ảnh RGBA. */
export function solidCount(img: Raw): number {
  if (img.channels !== 4) return img.width * img.height;
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 255) n++;
  return n;
}

/** `image_studio.verify_packshot`: MỌI pixel alpha 255 của `fitted` khớp TUYỆT ĐỐI (RGB) với `img`
 * tại (x, y). 0 pixel đặc / lệch 1 pixel / ra ngoài khung / input hỏng → false. Thuần. */
export function verifyPackshot(img: unknown, fitted: unknown, box: unknown): boolean {
  if (!isRaw(img) || !isRaw(fitted) || fitted.channels !== 4 || !Array.isArray(box)) return false;
  const x = Math.trunc(Number(box[0]));
  const y = Math.trunc(Number(box[1]));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x + fitted.width > img.width || y + fitted.height > img.height)
    return false;
  let solid = 0;
  for (let j = 0; j < fitted.height; j++) {
    for (let i = 0; i < fitted.width; i++) {
      const s = (j * fitted.width + i) * 4;
      if (fitted.data[s + 3] !== 255) continue;
      solid++;
      const d = ((y + j) * img.width + (x + i)) * img.channels;
      for (let c = 0; c < 3; c++) if (img.data[d + c] !== fitted.data[s + c]) return false;
    }
  }
  return solid > 0;
}

/** Số pixel trong vùng (x, y, w, h) có mọi kênh |Δ| ≤ tol so với `rgb` (tol 0 = ĐÚNG màu). */
export function nearCount(
  img: Raw,
  box: readonly number[],
  rgb: readonly number[],
  tol: number,
): number {
  const [x, y, w, h] = box.map((v) => Math.trunc(v)) as [number, number, number, number];
  let n = 0;
  for (let j = Math.max(0, y); j < Math.min(img.height, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(img.width, x + w); i++) {
      const d = (j * img.width + i) * img.channels;
      let ok = true;
      for (let c = 0; c < 3; c++) {
        if (Math.abs((img.data[d + c] as number) - (rgb[c] as number)) > tol) {
          ok = false;
          break;
        }
      }
      if (ok) n++;
    }
  }
  return n;
}

/** `image_studio._changed_ratio`: tỉ lệ pixel khác nhau (bất kỳ kênh RGB) giữa 2 ảnh cùng cỡ. */
export function changedRatio(a: Raw, b: Raw): number {
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (let c = 0; c < 3; c++) {
      if (a.data[i * a.channels + c] !== b.data[i * b.channels + c]) {
        n++;
        break;
      }
    }
  }
  return n / (a.width * a.height);
}

// ================================================================ font (TTF/OTF cmap + name)

export type Font = { path: string; family: string; has: (cp: number) => boolean };
const MAX_FONT_BYTES = 64 * 1024 * 1024;

function readFile(path: string): Buffer | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_FONT_BYTES) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      return buf;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function tables(b: Buffer, at: number): Map<string, [number, number]> {
  const n = b.readUInt16BE(at + 4);
  const out = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const r = at + 12 + i * 16;
    out.set(b.toString('latin1', r, r + 4), [b.readUInt32BE(r + 8), b.readUInt32BE(r + 12)]);
  }
  return out;
}

function cmapLookup(b: Buffer, off: number): ((cp: number) => boolean) | null {
  const n = b.readUInt16BE(off + 2);
  const subs: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const r = off + 4 + i * 8;
    subs.push([b.readUInt16BE(r), b.readUInt16BE(r + 2), off + b.readUInt32BE(r + 4)]);
  }
  const pick = (fmt: number) =>
    subs.find(
      ([p, e, o]) =>
        (p === 3 || p === 0) && (fmt !== 4 || e !== 0 || p === 0) && b.readUInt16BE(o) === fmt,
    );
  const s12 = pick(12);
  if (s12) {
    const o = s12[2];
    const groups: [number, number, number][] = [];
    const ng = b.readUInt32BE(o + 12);
    for (let i = 0; i < ng; i++) {
      const g = o + 16 + i * 12;
      groups.push([b.readUInt32BE(g), b.readUInt32BE(g + 4), b.readUInt32BE(g + 8)]);
    }
    return (cp) => groups.some(([s, e, g]) => cp >= s && cp <= e && g + (cp - s) !== 0);
  }
  const s4 = pick(4);
  if (!s4) return null;
  const o = s4[2];
  const seg = b.readUInt16BE(o + 6) / 2;
  const ends = o + 14;
  const starts = ends + seg * 2 + 2;
  const deltas = starts + seg * 2;
  const ranges = deltas + seg * 2;
  return (cp) => {
    if (cp > 0xffff) return false;
    for (let i = 0; i < seg; i++) {
      const end = b.readUInt16BE(ends + i * 2);
      if (end < cp) continue;
      const start = b.readUInt16BE(starts + i * 2);
      if (start > cp) return false;
      const delta = b.readUInt16BE(deltas + i * 2);
      const ro = b.readUInt16BE(ranges + i * 2);
      if (ro === 0) return ((cp + delta) & 0xffff) !== 0;
      const at = ranges + i * 2 + ro + 2 * (cp - start);
      if (at + 2 > b.length) return false;
      const g = b.readUInt16BE(at);
      return g !== 0 && ((g + delta) & 0xffff) !== 0;
    }
    return false;
  };
}

function familyName(b: Buffer, off: number): string | null {
  const count = b.readUInt16BE(off + 2);
  const strings = off + b.readUInt16BE(off + 4);
  let best: [number, string] | null = null;
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const [pid, , lang, nid, len, so] = [0, 2, 4, 6, 8, 10].map((k) =>
      b.readUInt16BE(r + k),
    ) as number[];
    if (nid !== 1 && nid !== 16) continue;
    const raw = b.subarray(strings + (so as number), strings + (so as number) + (len as number));
    let s: string;
    if (pid === 3 || pid === 0) {
      s = Buffer.from(raw.subarray(0, raw.length & ~1))
        .swap16()
        .toString('utf16le');
    } else if (pid === 1) s = raw.toString('latin1');
    else continue;
    const rank = (nid === 16 ? 0 : 10) + (pid === 3 && lang === 0x409 ? 0 : pid === 3 ? 1 : 2);
    if (s.trim() && (best === null || rank < best[0])) best = [rank, s.trim()];
  }
  return best?.[1] ?? null;
}

const fontCache = new Map<string, Font | null>();

/** Đọc font (TTF/OTF; TTC lấy font đầu) → {họ font, bảng glyph} | null (hỏng/thiếu/không cmap). */
export function loadFont(path: string): Font | null {
  if (fontCache.has(path)) return fontCache.get(path) ?? null;
  let font: Font | null = null;
  const b = readFile(path);
  try {
    if (b && b.length >= 12) {
      const tag = b.toString('latin1', 0, 4);
      const at = tag === 'ttcf' ? b.readUInt32BE(12) : 0;
      const sig = b.readUInt32BE(at);
      if (sig === 0x00010000 || sig === 0x4f54544f || sig === 0x74727565) {
        const t = tables(b, at);
        const cm = t.get('cmap');
        const nm = t.get('name');
        const has = cm ? cmapLookup(b, cm[0]) : null;
        const family = nm ? familyName(b, nm[0]) : null;
        if (has && family && !/[<>&"]/.test(family)) font = { path, family, has };
      }
    }
  } catch {
    font = null; // bảng hỏng → coi như không có font
  }
  if (fontCache.size < 64) fontCache.set(path, font);
  return font;
}

/** Font phủ đủ glyph MỌI ký tự không-khoảng-trắng của `text` (NFC). */
export function fontCovers(font: Font, text: string): boolean {
  for (const ch of new Set(text.normalize('NFC'))) {
    if (/^\s$/u.test(ch)) continue;
    if (!font.has(ch.codePointAt(0) as number)) return false;
  }
  return true;
}

export type Mask = { width: number; height: number; data: Uint8Array };
const escapeMarkup = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Vẽ chữ (nhiều dòng `\n`) → mặt nạ L cắt sát khung mực. Chữ thoát markup Pango (`<`, `&` trong
 * headline không đổi được font/màu). */
export async function renderText(
  font: Font,
  text: string,
  size: number,
  spacing: number,
  align: 'left' | 'centre',
): Promise<Mask> {
  const { data, info } = await (await sharp())({
    text: {
      text: escapeMarkup(text),
      fontfile: font.path,
      font: `${font.family}, ${size}`,
      dpi: 72,
      spacing,
      align,
    },
  })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * ch] as number;
  return { width: info.width, height: info.height, data: out };
}
