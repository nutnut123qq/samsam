import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import { inflateSync, constants as zc } from 'node:zlib';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { parseDay } from '@samsam/core/ops/period';
import { isDbError } from '@samsam/core/ops/tx';
import { REPO_ROOT } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { checkGenerate, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { pyStrip } from '@samsam/core/security/py';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { type DbLease, type Io, STD_IO } from './garden.js';

// Port `scripts/garden_media.py` (WP13 VT — kho tư liệu vườn, farming-04): ảnh → gỡ TOÀN BỘ
// EXIF/GPS (mã hóa lại từ pixel, không chép metadata nào) → lưu NGOÀI repo theo sha256 → dòng
// `garden_media`. Video .mp4/.m4v/.mov: nhánh riêng (magic bytes ISO-BMFF + remux ffmpeg bỏ
// metadata/track dữ liệu, quét lại dấu vị trí) — KHÔNG bao giờ qua bộ giải mã ảnh.
// KHÁC Python có chủ đích:
//  - Ảnh giải mã/mã hóa bằng sharp (libvips) thay Pillow: nhận đúng JPEG (kể cả MPO — chỉ khung 0)/
//    PNG/WEBP theo magic bytes TRƯỚC khi giải mã (SVG/HEIC/… không bao giờ vào bộ giải mã); bytes
//    ra khác Pillow nhưng cùng luật (0 EXIF/XMP/ICC/text, hướng ảnh áp vào pixel, RGBA → PNG).
//  - ffmpeg: env FFMPEG_BIN → PATH (không có `imageio-ffmpeg` của Python; không tìm ở thư mục hiện
//    hành). Không có → TỪ CHỐI video (fail-closed như Python).
//  - Không đọc `.env` (quy ước ts/); `--date` chỉ nhận YYYY-MM-DD (Python nhận thêm 20261012/tuần).

export const MB = 1024 * 1024;
/** Giới hạn (Python hằng module mà test monkeypatch). */
export const limits = {
  maxBytes: 25 * MB,
  maxVideoBytes: 200 * MB, // GIẢ ĐỊNH kỹ thuật — chưa ai chốt
  maxImagePixels: 89_478_485, // = Pillow MAX_IMAGE_PIXELS (vượt → từ chối như DecompressionBombWarning)
  ffmpegTimeoutMs: 300_000,
};
export const SOURCE = 'cli:garden_media';
export const VIDEO_EXTS: Readonly<Record<string, 'mp4' | 'mov'>> = {
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.mov': 'mov',
};
const MP4_BRANDS = [
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'M4VH',
  'M4VP',
];
const MOV_BRANDS = ['qt  '];
// Dấu vị trí trong hộp metadata MP4/MOV (iPhone ©xyz + mdta ISO6709, 3GPP loci) — chỉ hộp NGOÀI mdat.
const GPS_MARKERS = [
  Buffer.from([0xa9, 0x78, 0x79, 0x7a]),
  ...['loci', 'ISO6709', 'location'].map((s) => Buffer.from(s, 'latin1')),
];

/** Python ValueError — tệp bị từ chối (lý do rõ, không ghi gì). */
export class Rejected extends RangeError {}
/** Python RuntimeError — thiếu phụ thuộc ngoài (ffmpeg): từ chối, không lưu bản chưa gỡ. */
export class MissingDep extends Error {}

export type MediaInfo = {
  exif_removed: number;
  had_gps: boolean;
  width: number | null;
  height: number | null;
};

// ------------------------------------------------------------ ảnh

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ascii = (b: Buffer, a: number, z: number) => b.toString('latin1', a, z);

/** Định dạng theo magic bytes (tên kiểu Pillow) | null khi không nhận ra. */
function sniff(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (b.subarray(0, 8).equals(PNG_SIG)) return 'PNG';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'WEBP';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'GIF';
  if (ascii(b, 0, 2) === 'BM') return 'BMP';
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'TIFF';
  return null;
}

const TIFF_PREFIXES = ['MM\0*', 'II*\0', 'MM*\0', 'II\0*', 'MM\0+', 'II+\0']; // Pillow PREFIXES
const MAX_TEXT_CHUNK = MB; // = Pillow PngImagePlugin.MAX_TEXT_CHUNK
const MAX_TEXT_MEMORY = 64 * MB; // = Pillow PngImagePlugin.MAX_TEXT_MEMORY

/** Python `bytes.fromhex(str)` (cùng thông điệp lỗi): bỏ khoảng trắng ASCII giữa các cặp. */
function fromHex(s: string): Buffer {
  const bad = (i: number) =>
    new Rejected(`non-hexadecimal number found in fromhex() arg at position ${i}`);
  // Python kiểm ký tự ngoài ASCII TRƯỚC (vị trí tính theo code point)
  const na = s.search(/[\u0080-￿]/);
  if (na >= 0) throw bad(Array.from(s.slice(0, na)).length);
  const hex = (c: number) =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
  const out = Buffer.alloc(s.length >> 1);
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      i++;
      continue;
    }
    const hi = hex(c);
    if (hi < 0) throw bad(i);
    const lo = i + 1 < s.length ? hex(s.charCodeAt(i + 1)) : -1;
    if (lo < 0) throw bad(i + 1);
    out[n++] = hi * 16 + lo;
    i += 2;
  }
  return out.subarray(0, n);
}

/** Chunk PNG như Pillow `PngStream` sau `load()`: MỌI chunk tới IEND (kể cả SAU IDAT — libvips chỉ
 * đọc phần đầu), khóa sau đè khóa trước (dict). Chỉ giữ EXIF (eXIf / tEXt khóa 'exif'), 'Raw profile
 * type exif' (ImageMagick/exiftool) và XMP. zTXt/iTXt giải nén ≤ 1 MB như Pillow (chặn zip bomb). */
function pngInfo(b: Buffer): { exif?: Buffer; raw?: string; xmp?: string } {
  const info: { exif?: Buffer; raw?: string; xmp?: string } = {};
  let mem = 0;
  let idat = false;
  const inflate = (z: Buffer): Buffer | null => {
    try {
      return inflateSync(z, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: MAX_TEXT_CHUNK });
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE')
        throw new Rejected('Decompressed data too large for PngImagePlugin.MAX_TEXT_CHUNK');
      return null; // zlib.error → Pillow bỏ giá trị
    }
  };
  const text = (k: string, v: string) => {
    if (!k) return;
    mem += v.length;
    if (mem > MAX_TEXT_MEMORY)
      throw new Rejected(`Too much memory used in text chunks: ${mem}>MAX_TEXT_MEMORY`);
    if (k === 'Raw profile type exif') info.raw = v;
    else if (k === 'XML:com.adobe.xmp') info.xmp = v;
  };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let i = 8; i + 8 <= b.length; ) {
    const n = b.readUInt32BE(i);
    const type = ascii(b, i + 4, i + 8);
    if (!/^\w{4}$/.test(type) || type === 'IEND' || i + 8 + n > b.length) break;
    const d = b.subarray(i + 8, i + 8 + n);
    i += 12 + n;
    idat ||= type === 'IDAT';
    if (type === 'eXIf') info.exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), d]);
    if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) continue;
    const z = d.indexOf(0);
    const k = ascii(d, 0, z < 0 ? d.length : z);
    const v = z < 0 ? Buffer.alloc(0) : d.subarray(z + 1);
    if (type === 'tEXt') {
      if (k === 'exif') info.exif = Buffer.from(v); // Pillow giữ BYTES cho khóa 'exif'
      text(k, ascii(v, 0, v.length));
    } else if (type === 'zTXt') {
      // Pillow SyntaxError: trước IDAT → Image.open không nhận ảnh; sau IDAT → load() lỗi
      if (v.length && v[0] !== 0)
        throw new Rejected(
          `không mở được ảnh (${idat ? 'SyntaxError' : 'UnidentifiedImageError'})`,
        );
      const t = inflate(v.subarray(1));
      text(k, t ? ascii(t, 0, t.length) : '');
    } else if (type === 'iTXt' && z >= 0 && v.length >= 2) {
      const r = v.subarray(2);
      const z1 = r.indexOf(0);
      const z2 = z1 < 0 ? -1 : r.indexOf(0, z1 + 1);
      if (z2 < 0) continue;
      let t: Buffer | null = r.subarray(z2 + 1);
      if (v[0] !== 0) t = v[1] === 0 ? inflate(t) : null;
      if (t === null) continue;
      if (k === 'XML:com.adobe.xmp') info.xmp = ascii(t, 0, t.length); // Pillow info['xmp']
      try {
        utf8.decode(r.subarray(0, z1));
        utf8.decode(r.subarray(z1 + 1, z2));
        text(k, utf8.decode(t));
      } catch (e) {
        if (e instanceof Rejected) throw e;
      }
    }
  }
  return info;
}

/** Pillow `_exif_stats(img)` cho ảnh `src` (sharp `meta` của chính nó): EXIF như `img.getexif()` —
 * JPEG/WEBP lấy APP1/chunk EXIF; PNG đọc chunk như Pillow (eXIf, rồi 'Raw profile type exif' dạng
 * hex). PNG/WEBP có EXIF sai header TIFF → từ chối như Pillow (`getexif` ném khi strip/kiểm). JPEG
 * giữ lỏng: Pillow nuốt lỗi EXIF lúc mở (dò dpi) nên `getexif` sau đó trả rỗng — shortcut: JPEG có
 * dpi JFIF thì Pillow KHÔNG nuốt (từ chối) mà TS vẫn nhận (bản ra mã hóa lại sạch); cần khớp thì dò APP0. */
export function imageExifStats(src: Buffer, meta: Metadata): [number, boolean] {
  const p = src.subarray(0, 8).equals(PNG_SIG) ? pngInfo(src) : null;
  const exif = p
    ? (p.exif ?? (p.raw === undefined ? undefined : fromHex(p.raw.split('\n').slice(3).join(''))))
    : meta.exif;
  const xmp = p ? p.xmp : meta.xmp?.toString('latin1');
  let b = exif ?? Buffer.alloc(0);
  while (ascii(b, 0, 6) === 'Exif\0\0') b = b.subarray(6);
  if (b.length && meta.format !== 'jpeg') {
    const pre = ascii(b, 0, 4);
    if (!TIFF_PREFIXES.includes(pre)) throw new Rejected('không mở được ảnh (SyntaxError)');
    // struct.error của Pillow: header < 8 byte, hoặc BigTIFF (đọc offset 8 byte từ header 8 byte)
    if (b.length < 8 || pre.includes('+')) throw new Rejected('không mở được ảnh (error)');
  }
  return exifStats(exif, xmp);
}

/** [số thẻ EXIF gốc (IFD0 + Exif + GPS), có GPS?] — chỉ ĐẾM, không giữ/trả giá trị thẻ. Như Pillow
 * `getexif()`: thiếu thẻ Orientation mà XMP có `tiff:Orientation` → tính thêm 1 thẻ. */
export function exifStats(raw: Buffer | undefined, xmp?: string): [number, boolean] {
  const orient = xmp !== undefined && /tiff:Orientation(="|>)([0-9])/.test(xmp) ? 1 : 0;
  let b = raw ?? Buffer.alloc(0);
  while (ascii(b, 0, 6) === 'Exif\0\0') b = b.subarray(6);
  if (!b.length) return [orient, false];
  // EXIF hỏng: Pillow (JPEG) nuốt lỗi lúc mở → getexif rỗng, không xét XMP
  if (b.length < 8) return [0, false];
  const le = ascii(b, 0, 2) === 'II';
  if (!le && ascii(b, 0, 2) !== 'MM') return [0, false];
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const ifd = (off: number | undefined): Map<number, number> => {
    const m = new Map<number, number>();
    if (off === undefined || off + 2 > b.length) return m;
    const n = u16(off);
    for (let i = 0; i < n && off + 2 + 12 * (i + 1) <= b.length; i++) {
      const e = off + 2 + 12 * i;
      m.set(u16(e), u32(e + 8));
    }
    return m;
  };
  const ifd0 = ifd(u32(4));
  const sub = ifd0.has(0x8769) ? ifd(ifd0.get(0x8769)) : new Map();
  const gps = ifd0.has(0x8825) ? ifd(ifd0.get(0x8825)) : new Map();
  return [ifd0.size + gps.size + sub.size + (ifd0.has(0x0112) ? 0 : orient), gps.size > 0];
}

/** bytes ảnh gốc → [bytes sạch, 'jpg'|'png', info]. Từ chối (Rejected): rỗng / > 25 MB / không nhận
 * ra / định dạng ngoài JPEG-MPO-PNG-WEBP / quá nhiều pixel / không giải mã được. */
export async function stripImage(src: Buffer): Promise<[Buffer, 'jpg' | 'png', MediaInfo]> {
  if (!src.length) throw new Rejected('file rỗng');
  if (src.length > limits.maxBytes)
    throw new Rejected(`file > ${Math.floor(limits.maxBytes / MB)} MB`);
  const fmt = sniff(src);
  if (fmt === null) throw new Rejected('không mở được ảnh (UnidentifiedImageError)');
  if (!['JPEG', 'PNG', 'WEBP'].includes(fmt))
    throw new Rejected(`định dạng ${fmt} không hỗ trợ (chỉ JPEG/MPO/PNG/WEBP)`);
  const bomb = () => new Rejected('ảnh quá nhiều pixel (decompression bomb)');
  let meta: Metadata;
  try {
    meta = await sharp(src, { limitInputPixels: false }).metadata();
  } catch {
    throw new Rejected('không mở được ảnh (UnidentifiedImageError)');
  }
  if (meta.format !== fmt.toLowerCase())
    throw new Rejected('không mở được ảnh (UnidentifiedImageError)');
  if ((meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0) > limits.maxImagePixels)
    throw bomb();
  const [nTags, hadGps] = imageExifStats(src, meta);
  // Alpha như Pillow (mode RGBA/LA/PA hoặc P + transparency): PNG xám/RGB + tRNS KHÔNG tính là alpha
  // (sharp hasAlpha = true) → JPEG. Byte 25 = colour type của IHDR (chunk đầu tiên).
  const alpha = meta.hasAlpha === true && !(fmt === 'PNG' && (src[25] === 0 || src[25] === 2));
  // Mã hóa lại từ pixel: sharp mặc định KHÔNG chép EXIF/XMP/ICC/IPTC; autoOrient áp Orientation vào pixel.
  let pipe = sharp(src, { limitInputPixels: limits.maxImagePixels, failOn: 'warning' })
    .autoOrient()
    .toColourspace('srgb');
  pipe = alpha ? pipe.ensureAlpha().png() : pipe.removeAlpha().jpeg({ quality: 90 });
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await pipe.toBuffer({ resolveWithObject: true });
  } catch (e) {
    if (/pixel limit/i.test((e as Error).message)) throw bomb();
    throw new Rejected('không mở được ảnh (OSError)');
  }
  return [
    out.data,
    alpha ? 'png' : 'jpg',
    { exif_removed: nTags, had_gps: hadGps, width: out.info.width, height: out.info.height },
  ];
}

// ------------------------------------------------------------ video

/** Hộp cấp 1 ISO-BMFF → [type, start, end]. Kích thước sai/vượt file → Rejected (không đoán). */
export function boxes(data: Buffer): [string, number, number][] {
  const out: [string, number, number][] = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    if (n - i < 8) throw new Rejected('cấu trúc video hỏng (hộp cụt)');
    let size = data.readUInt32BE(i);
    let hdr = 8;
    if (size === 1) {
      if (n - i < 16) throw new Rejected('cấu trúc video hỏng (hộp cụt)');
      size = Number(data.readBigUInt64BE(i + 8));
      hdr = 16;
    } else if (size === 0) {
      size = n - i;
    }
    if (size < hdr || i + size > n) throw new Rejected('cấu trúc video hỏng (kích thước hộp)');
    out.push([ascii(data, i + 4, i + 8), i, i + size]);
    i += size;
  }
  return out;
}

/** 'mp4' | 'mov' theo magic (`ftyp` + brand) + cấu trúc hộp hợp lệ; khác → Rejected. */
export function videoContainer(data: Buffer): 'mp4' | 'mov' {
  if (data.length < 12 || ascii(data, 4, 8) !== 'ftyp')
    throw new Rejected('không phải video MP4/MOV (magic bytes)');
  const brand = ascii(data, 8, 12);
  let kind: 'mp4' | 'mov';
  if (MP4_BRANDS.includes(brand)) kind = 'mp4';
  else if (MOV_BRANDS.includes(brand)) kind = 'mov';
  else throw new Rejected('brand video không hỗ trợ (chỉ MP4/MOV)');
  boxes(data);
  return kind;
}

/** Có dấu vị trí trong các hộp NGOÀI mdat/free/skip? */
export function videoHasGps(data: Buffer): boolean {
  return boxes(data).some(
    ([t, a, b]) =>
      !['mdat', 'free', 'skip'].includes(t) &&
      GPS_MARKERS.some((m) => data.subarray(a, b).includes(m)),
  );
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** env FFMPEG_BIN → PATH → null. */
export function findFfmpeg(env: Env = process.env): string | null {
  const p = pyStrip(env.FFMPEG_BIN ?? '');
  if (p && isFile(p)) return p;
  const exts =
    process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE').split(';').filter(Boolean) : [''];
  for (const d of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const e of exts) if (isFile(join(d, `ffmpeg${e}`))) return join(d, `ffmpeg${e}`);
  }
  return null;
}

const execFileP = promisify(execFile);

/** Chạy ffmpeg → mã thoát. Không chạy được / quá hạn → Rejected (Python OSError/TimeoutExpired). */
async function runFfmpeg(ff: string, args: string[], timeoutMs: number): Promise<number> {
  try {
    await execFileP(ff, args, { timeout: timeoutMs, maxBuffer: 16 * MB, windowsHide: true });
    return 0;
  } catch (e) {
    const x = e as { code?: unknown; killed?: boolean; signal?: unknown };
    if (typeof x.code === 'number' && !x.killed) return x.code;
    const name = x.killed || x.signal ? 'TimeoutExpired' : pyOsName(e);
    throw new Rejected(`ffmpeg không chạy được (${name})`);
  }
}

/** Điểm thay cho test (Python monkeypatch `_find_ffmpeg` / `subprocess.run`). */
export const mediaDeps = { findFfmpeg, runFfmpeg };

/** bytes video gốc → [bytes đã gỡ metadata, 'mp4'|'mov', info]. Từ chối (Rejected): rỗng/quá cỡ/
 * magic sai/remux lỗi/còn dấu vị trí. Thiếu ffmpeg → MissingDep. Bản gốc (còn GPS) chỉ nằm trong
 * thư mục tạm, xóa ngay sau remux. */
export async function stripVideo(
  src: Buffer,
  o: { tmpDir?: string | null; env?: Env } = {},
): Promise<[Buffer, 'mp4' | 'mov', MediaInfo]> {
  if (!src.length) throw new Rejected('file rỗng');
  if (src.length > limits.maxVideoBytes)
    throw new Rejected(`video > ${Math.floor(limits.maxVideoBytes / MB)} MB`);
  const kind = videoContainer(src);
  const hadGps = videoHasGps(src);
  const ff = mediaDeps.findFfmpeg(o.env);
  if (!ff) {
    throw new MissingDep(
      'thiếu ffmpeg — TỪ CHỐI video vì không gỡ được metadata/GPS (external-dep: env FFMPEG_BIN ' +
        'hoặc ffmpeg trong PATH)',
    );
  }
  if (o.tmpDir) mkdirSync(o.tmpDir, { recursive: true });
  const td = mkdtempSync(join(o.tmpDir ?? tmpdir(), '.gm-'));
  let clean: Buffer;
  try {
    const inp = join(td, `in.${kind}`);
    const outp = join(td, `out.${kind}`);
    writeFileSync(inp, src);
    const rc = await mediaDeps.runFfmpeg(
      ff,
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        inp,
        '-map',
        '0:V',
        '-map',
        '0:a?',
        '-dn',
        '-sn',
        '-map_metadata',
        '-1',
        '-map_metadata:s',
        '-1',
        '-map_chapters',
        '-1',
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-flags:a',
        '+bitexact',
        '-c',
        'copy',
        '-f',
        kind,
        outp,
      ],
      limits.ffmpegTimeoutMs,
    );
    if (rc !== 0 || !isFile(outp)) {
      throw new Rejected(
        `không gỡ được metadata video (ffmpeg rc=${rc}) — file hỏng hoặc không có luồng hình`,
      );
    }
    clean = readFileSync(outp);
  } finally {
    rmSync(td, { recursive: true, force: true });
  }
  if (!clean.length || videoContainer(clean) !== kind || videoHasGps(clean))
    throw new Rejected('video sau khi gỡ vẫn còn dấu vị trí / sai cấu trúc — từ chối');
  return [clean, kind, { exif_removed: 0, had_gps: hadGps, width: null, height: null }];
}

/** Định tuyến theo đuôi khai báo: video → stripVideo (đuôi phải khớp container), còn lại → ảnh. */
export async function stripMedia(
  src: Buffer,
  extHint: string,
  o: { tmpDir?: string | null; env?: Env } = {},
): Promise<[Buffer, string, MediaInfo]> {
  const want = VIDEO_EXTS[extHint.toLowerCase()];
  if (want === undefined) return stripImage(src);
  const r = await stripVideo(src, o);
  if (r[1] !== want) throw new Rejected('đuôi file không khớp nội dung video');
  return r;
}

// ------------------------------------------------------------ kho + DB

/** Lưu theo nội dung `<kho>/<sha[:2]>/<sha>.<ext>` (ghi tạm + đổi tên) → [sha, path]; đã có → không ghi lại. */
export function store(clean: Buffer, ext: string, storeDir: string): [string, string] {
  const sha = createHash('sha256').update(clean).digest('hex');
  const d = join(storeDir, sha.slice(0, 2));
  const path = join(d, `${sha}.${ext}`);
  if (!existsSync(path)) {
    mkdirSync(d, { recursive: true });
    const tmp = join(d, `.${sha}.${process.pid}.tmp`);
    writeFileSync(tmp, clean);
    renameSync(tmp, path);
  }
  return [sha, path];
}

/** INSERT garden_media (on conflict do nothing) → true nếu dòng mới. */
export async function record(
  db: Db,
  sha: string,
  ext: string,
  nbytes: number,
  info: MediaInfo,
  plotId: string,
  takenOn: string,
  author: string,
  source: string = SOURCE,
): Promise<boolean> {
  const r = await db.query(
    'insert into garden_media (sha256, ext, bytes, width, height, plot_id, taken_on, author,' +
      ' exif_removed, had_gps, source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)' +
      ' on conflict (sha256) do nothing returning id',
    [
      sha,
      ext,
      nbytes,
      info.width,
      info.height,
      plotId,
      takenOn,
      author,
      info.exif_removed,
      info.had_gps,
      source,
    ],
  );
  return r.rows.length > 0;
}

/** Đường dẫn tuyệt đối sau khi giải symlink của phần đã tồn tại (Python `Path.resolve()`). */
function resolveReal(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Thư mục nằm TRONG repo (sau giải symlink/..; Windows không phân biệt hoa thường)? */
export function inRepo(p: string, root: string = REPO_ROOT): boolean {
  const rel = relative(resolveReal(root), resolveReal(p));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Tên lớp OSError Python tương ứng mã lỗi Node. */
export function pyOsName(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  if (c === 'ENOENT') return 'FileNotFoundError';
  if (c === 'EACCES' || c === 'EPERM') return 'PermissionError';
  if (c === 'EISDIR') return 'IsADirectoryError';
  return 'OSError';
}

// ------------------------------------------------------------ CLI `python scripts/garden_media.py`

export type GardenMediaOpts = {
  file?: string;
  plot?: string;
  date?: string;
  by?: string;
  store?: string;
};

/** exit: 0 ok · 1 khoảnh không có / tệp bị từ chối / lỗi DB · 2 sai tham số / kho thiếu-trong repo /
 * DB down (KHÔNG ghi file) / tính năng farming-04 TẮT. */
export async function gardenMediaMain(
  o: GardenMediaOpts,
  d: { connect?: () => Promise<DbLease | null>; io?: Io; env?: Env } = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`garden_media.py: error: ${m}`);
    return 2;
  };
  const missing = (['file', 'plot', 'date', 'by'] as const).filter((k) => o[k] === undefined);
  if (missing.length)
    return usage(
      `the following arguments are required: ${missing.map((k) => `--${k}`).join(', ')}`,
    );
  const by = pyStrip(o.by as string);
  const plot = pyStrip(o.plot as string);
  if (!by) return usage('--by không được rỗng');
  if (!plot) return usage('--plot không được rỗng');
  const takenOn = pyStrip(o.date as string);
  if (parseDay(takenOn) === null) return usage('--date sai định dạng YYYY-MM-DD');
  const storeDir = o.store || env.GARDEN_MEDIA_DIR;
  if (!storeDir) {
    io.err('[err] thiếu --store hoặc env GARDEN_MEDIA_DIR (thư mục kho NGOÀI repo)');
    return 2;
  }
  if (inRepo(storeDir)) {
    io.err(
      '[err] thư mục kho nằm TRONG repo — ảnh vườn không được vào git; chọn thư mục ngoài repo',
    );
    return 2;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err(
      '[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết) — không ghi file',
    );
    return 2;
  }
  const { db } = lease;
  try {
    // v13 vá review (F03): kho tư liệu vườn = farming-04; `tat` → không ghi file/dòng nào.
    try {
      await checkGenerate(db, 'farming-04', 'nạp kho ảnh vườn');
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      io.err(`[blocked] ${e.message}`);
      return 2;
    }
    const noPlot = () => {
      io.err(`[err] khoảnh '${plot}' không tồn tại trong bảng plots`);
      return 1;
    };
    if (!(await db.query('select 1 from plots where id = $1', [plot])).rows.length) return noPlot();
    const src = o.file as string;
    const video = Object.hasOwn(VIDEO_EXTS, extname(src).toLowerCase());
    let clean: Buffer;
    let ext: string;
    let info: MediaInfo;
    try {
      let regular = false;
      try {
        regular = !lstatSync(src).isSymbolicLink() && statSync(src).isFile();
      } catch {
        regular = false;
      }
      if (!regular) throw new Rejected('--file phải là file thường (không thư mục/symlink)');
      const limit = video ? limits.maxVideoBytes : limits.maxBytes;
      if (statSync(src).size > limit) throw new Rejected(`file > ${Math.floor(limit / MB)} MB`);
      [clean, ext, info] = await stripMedia(readFileSync(src), extname(src), {
        tmpDir: join(storeDir, '.tmp'),
        env,
      });
    } catch (e) {
      if (e instanceof Rejected || e instanceof MissingDep) {
        io.err(`[err] từ chối ${video ? 'video' : 'ảnh'}: ${e.message}`);
        return 1;
      }
      if (typeof (e as { code?: unknown })?.code === 'string') {
        // lỗi hệ thống tệp (Python OSError) — không có lỗi DB nào trong khối này
        io.err(`[err] không đọc được file ảnh (${pyOsName(e)})`);
        return 1;
      }
      throw e;
    }
    const [sha] = store(clean, ext, storeDir);
    let fresh: boolean;
    try {
      fresh = await record(db, sha, ext, clean.length, info, plot, takenOn, by);
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return noPlot();
      if (!isDbError(e)) throw e;
      io.err(`[err] lỗi DB ${pgErrName(e)} — đã chạy \`python scripts/apply_schema.py\`?`);
      return 1;
    }
    const what = video ? `video ${ext} đã gỡ metadata` : `gỡ ${info.exif_removed} thẻ EXIF`;
    io.out(
      `[done] ${sha.slice(0, 12)} — ${what}, có GPS: ${info.had_gps ? 'có' : 'không'}` +
        (fresh ? '' : ' (tệp đã có trong kho)'),
    );
    return 0;
  } finally {
    await lease.release();
  }
}
