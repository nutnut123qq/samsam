import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
import { REPO_ROOT } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import golden from './__fixtures__/garden_media.golden.json' with { type: 'json' };
import {
  findFfmpeg,
  gardenMediaMain,
  inRepo,
  limits,
  MissingDep,
  mediaDeps,
  Rejected,
  store,
  stripImage,
  stripMedia,
  stripVideo,
  videoContainer,
  videoHasGps,
} from './garden-media.js';
import { checkClean } from './garden-media-mkt.js';

// Dịch tests/test_garden_media.py + phần video của tests/test_v13_c05_media.py. Ảnh nguồn sinh bằng
// Pillow ở script golden (có GPS/XMP/text — tiền điều kiện để "0 GPS" không pass ảo).

const LEAKS = ['Exif\0\0', 'GPS', 'ns.adobe.com/xap', 'eXIf', 'tEXt', 'iTXt', 'Canon', 'EOS-R'];
const VLEAKS = ['\xa9xyz', 'ISO6709', 'location', '108.2022', 'KV-SECRET'];
const b64 = (s: string) => Buffer.from(s, 'base64');
const tmp = mkdtempSync(join(tmpdir(), 'gz-media-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function assertClean(out: Buffer) {
  const m = await sharp(out).metadata();
  expect(m.exif).toBeUndefined();
  expect(m.xmp).toBeUndefined();
  expect(m.icc).toBeUndefined();
  expect(m.comments ?? []).toEqual([]);
  for (const l of LEAKS) expect(out.includes(Buffer.from(l, 'latin1')), l).toBe(false);
}

describe('strip_image (golden Pillow)', () => {
  for (const [name, [src, want]] of Object.entries(golden.images)) {
    it(name, async () => {
      const w = want as { err?: string; ext?: string; info?: unknown };
      if (w.err) {
        await expect(stripImage(b64(src as string))).rejects.toThrow(new Rejected(w.err));
        return;
      }
      const [out, ext, info] = await stripImage(b64(src as string));
      expect([ext, info]).toEqual([w.ext, w.info]);
      await assertClean(out);
      const m = await sharp(out).metadata();
      expect(m.format).toBe(ext === 'png' ? 'png' : 'jpeg');
      if (ext === 'png') expect(m.channels).toBe(4);
    });
  }

  it('nguồn có GPS (tiền điều kiện) → had_gps + ≥7 thẻ', () => {
    const src = b64(golden.images.jpeg_gps_xmp_orient6[0] as string);
    expect(
      src.includes(Buffer.from('ns.adobe.com/xap')) && src.includes(Buffer.from('Canon')),
    ).toBe(true);
  });

  it('decompression bomb (giới hạn pixel) + quá cỡ', async () => {
    const src = b64(golden.bomb_src);
    const keep = { ...limits };
    try {
      for (const lim of ['10', '400'] as const) {
        limits.maxImagePixels = Number(lim);
        await expect(stripImage(src)).rejects.toThrow(new Rejected(golden.bomb[lim].err));
      }
      Object.assign(limits, keep);
      limits.maxBytes = 100;
      await expect(stripImage(src)).rejects.toThrow(
        new Rejected(golden.oversize_max_bytes_100.err),
      );
    } finally {
      Object.assign(limits, keep);
    }
  });

  it('SVG/HEIC không vào bộ giải mã (magic bytes trước)', async () => {
    await expect(
      stripImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toBeInstanceOf(Rejected);
    await expect(stripImage(b64(golden.boxes.heic[0] as string))).rejects.toBeInstanceOf(Rejected);
  });
});

// Review vòng 3: Pillow `getexif()` đọc cả EXIF trong chunk text 'Raw profile type exif' (ImageMagick/
// exiftool, kể cả nằm SAU IDAT) và Orientation trong XMP — trước đây TS chỉ xem sharp `exif` → cổng
// cấp tư liệu cho Marketing PASS ảnh còn GPS. Golden = scripts/garden_media_mkt.check_clean thật.
describe('check_clean (golden Pillow): ảnh còn EXIF/GPS ở mọi chỗ Pillow đọc → không cấp', () => {
  for (const [name, [src, ext, want]] of Object.entries(golden.check_clean)) {
    it(name, async () => {
      const p = checkClean(b64(src as string), ext as string);
      if (want === 'ok') await expect(p).resolves.toBeUndefined();
      else await expect(p).rejects.toThrow((want as { err: string }).err);
    });
  }
});

describe('video: hộp ISO-BMFF (golden)', () => {
  for (const [name, [src, cont, gps]] of Object.entries(golden.boxes)) {
    it(name, () => {
      const b = b64(src as string);
      if (typeof cont === 'string') expect(videoContainer(b)).toBe(cont);
      else expect(() => videoContainer(b)).toThrow(new Rejected((cont as { err: string }).err));
      if (typeof gps === 'boolean') expect(videoHasGps(b)).toBe(gps);
      else expect(() => videoHasGps(b)).toThrow(new Rejected((gps as { err: string }).err));
    });
  }

  it('magic/cấu trúc sai, quá cỡ, thiếu ffmpeg → từ chối (không ghi gì)', async () => {
    for (const k of ['empty', 'jpeg', 'heic', 'moov_overflow', 'cut'] as const)
      await expect(stripVideo(b64(golden.boxes[k][0] as string))).rejects.toBeInstanceOf(Rejected);
    const keep = limits.maxVideoBytes;
    limits.maxVideoBytes = 10;
    await expect(stripVideo(Buffer.alloc(11))).rejects.toThrow(/MB/);
    limits.maxVideoBytes = keep;
    const find = mediaDeps.findFfmpeg;
    mediaDeps.findFfmpeg = () => null;
    try {
      await expect(stripVideo(b64(golden.boxes.isom_free[0] as string))).rejects.toThrow(
        MissingDep,
      );
      await expect(stripVideo(b64(golden.boxes.isom_free[0] as string))).rejects.toThrow(/ffmpeg/);
    } finally {
      mediaDeps.findFfmpeg = find;
    }
  });
});

/** ffmpeg để SINH video mẫu (độc lập module đang test): PATH/FFMPEG_BIN hoặc imageio-ffmpeg của Python. */
function locateFfmpeg(): string | null {
  const f = findFfmpeg(process.env);
  if (f) return f;
  try {
    const p = execFileSync(
      'python',
      ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    ).trim();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const FF = locateFfmpeg();
const LAT = '+16.0544+108.2022';

function makeVideo(path: string, fmt: 'mov' | 'mp4', audioOnly = false): Buffer {
  const src = audioOnly ? [] : ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=32x32:rate=5'];
  src.push('-f', 'lavfi', '-i', 'sine=duration=1');
  const codec = audioOnly ? ['-c:a', 'aac'] : ['-c:v', 'libx264', '-c:a', 'aac', '-shortest'];
  const extra = fmt === 'mov' ? ['-movflags', 'use_metadata_tags'] : [];
  execFileSync(FF as string, [
    '-v',
    'error',
    '-y',
    ...src,
    ...codec,
    '-metadata',
    `location=${LAT}/`,
    '-metadata',
    `com.apple.quicktime.location.ISO6709=${LAT}+010.000/`,
    '-metadata',
    'title=KV-SECRET',
    ...extra,
    '-f',
    fmt,
    path,
  ]);
  return readFileSync(path);
}

describe.skipIf(!FF)('video: remux ffmpeg (cần ffmpeg)', () => {
  const env = { FFMPEG_BIN: FF ?? '' };
  let mov: Buffer;
  let mp4: Buffer;
  beforeAll(() => {
    mov = makeVideo(join(tmp, 'src.mov'), 'mov');
    mp4 = makeVideo(join(tmp, 'src.mp4'), 'mp4');
    expect(mov.includes(Buffer.from('ISO6709')) || mov.includes(Buffer.from('location'))).toBe(
      true,
    );
  });
  const vclean = (b: Buffer) => {
    for (const l of VLEAKS) expect(b.includes(Buffer.from(l, 'latin1')), l).toBe(false);
  };

  it('mov: gỡ vị trí, bản gốc tạm đã xóa', async () => {
    const td = join(tmp, 'v1', '.tmp');
    const [clean, ext, info] = await stripVideo(mov, { tmpDir: td, env });
    expect(ext).toBe('mov');
    expect(info).toEqual({ exif_removed: 0, had_gps: true, width: null, height: null });
    expect(videoContainer(clean)).toBe('mov');
    expect(videoHasGps(clean)).toBe(false);
    vclean(clean);
    expect(readdirSync(td)).toEqual([]);
  });

  it('mp4 + .M4V; đuôi phải khớp nội dung; video không vào nhánh ảnh', async () => {
    for (const hint of ['.mp4', '.M4V']) {
      const [clean, ext] = await stripMedia(mp4, hint, { tmpDir: join(tmp, 'v2'), env });
      expect(ext).toBe('mp4');
      vclean(clean);
    }
    await expect(stripMedia(mov, '.mp4', { tmpDir: join(tmp, 'v2'), env })).rejects.toThrow(
      /không khớp/,
    );
    await expect(stripMedia(mp4, '.mov', { tmpDir: join(tmp, 'v2'), env })).rejects.toThrow(
      /không khớp/,
    );
    await expect(stripMedia(mp4, '.jpg', { env })).rejects.toBeInstanceOf(Rejected);
  });

  it('không có luồng hình → từ chối', async () => {
    const audio = makeVideo(join(tmp, 'a.mp4'), 'mp4', true);
    await expect(stripVideo(audio, { tmpDir: join(tmp, 'v3'), env })).rejects.toThrow(/luồng hình/);
  });

  it('ffmpeg giữ lại metadata (bản lạ) → quét sau remux chặn', async () => {
    const run = mediaDeps.runFfmpeg;
    mediaDeps.runFfmpeg = async (_ff, args) => {
      writeFileSync(
        args[args.length - 1] as string,
        readFileSync(args[args.indexOf('-i') + 1] as string),
      );
      return 0;
    };
    try {
      await expect(stripVideo(mov, { tmpDir: join(tmp, 'v4'), env })).rejects.toThrow(/vị trí/);
    } finally {
      mediaDeps.runFfmpeg = run;
    }
  });
});

describe('kho + đường dẫn', () => {
  it('store theo nội dung, idempotent', async () => {
    const [out, ext] = await stripImage(b64(golden.images.jpeg_gps_xmp_orient6[0] as string));
    const d = join(tmp, 'store1');
    const a = store(out, ext, d);
    expect(store(out, ext, d)).toEqual(a);
    expect(a[1]).toBe(join(d, a[0].slice(0, 2), `${a[0]}.jpg`));
    expect(readdirSync(join(d, a[0].slice(0, 2)))).toEqual([`${a[0]}.jpg`]);
    expect(readFileSync(a[1]).equals(out)).toBe(true);
  });
  it('in_repo', () => {
    expect(inRepo(join(REPO_ROOT, 'data', 'x'))).toBe(true);
    expect(inRepo(join(REPO_ROOT, 'data', '..', 'x'))).toBe(true);
    expect(inRepo(REPO_ROOT.toUpperCase())).toBe(process.platform === 'win32');
    expect(inRepo(join(REPO_ROOT, '..', 'ngoai-repo'))).toBe(false);
    expect(inRepo(tmp)).toBe(false);
  });
});

describe('CLI garden-media', () => {
  const jpg = b64(golden.images.jpeg_gps_xmp_orient6[0] as string);
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const files = (d: string): string[] => {
    if (!existsSync(d)) return [];
    return readdirSync(d, { recursive: true, encoding: 'utf8' }).filter((p) =>
      statSync(join(d, p)).isFile(),
    );
  };
  const argv = (storeDir: string, over: Record<string, string> = {}) => {
    const file = join(tmp, over.name ?? 'IMG_2026_GPS.jpg');
    if (!existsSync(file)) writeFileSync(file, jpg);
    return { file, plot: 'KV-T01', date: '2026-10-12', by: 'Bé Na', store: storeDir, ...over };
  };
  const noConnect = async () => {
    throw new Error('connect() không được gọi');
  };
  afterEach(() => {
    settings.forceMode = null;
  });

  it('sai tham số → exit 2', async () => {
    for (const p of [{ by: '  ' }, { date: '12/10' }, { plot: ' ' }] as Record<string, string>[]) {
      const c = io();
      expect(
        await gardenMediaMain(argv(join(tmp, 's'), p), {
          connect: noConnect,
          io: c.io,
        }),
      ).toBe(2);
    }
    const c = io();
    expect(await gardenMediaMain({ file: 'x' }, { connect: noConnect, io: c.io })).toBe(2);
    expect(c.err[0]).toContain('--plot, --date, --by');
  });

  it('kho trong repo / thiếu kho → exit 2, không connect, không tạo thư mục', async () => {
    const inside = join(REPO_ROOT, 'data', 'tmp_garden_media_test');
    expect(await gardenMediaMain(argv(inside), { connect: noConnect, io: io().io })).toBe(2);
    expect(existsSync(inside)).toBe(false);
    expect(
      await gardenMediaMain(argv(join(REPO_ROOT, 'data', '..', 'x')), {
        connect: noConnect,
        io: io().io,
      }),
    ).toBe(2);
    const c = io();
    expect(
      await gardenMediaMain(
        { ...argv(''), store: undefined },
        { connect: noConnect, io: c.io, env: { GARDEN_MEDIA_DIR: '' } },
      ),
    ).toBe(2);
    expect(c.err[0]).toContain('GARDEN_MEDIA_DIR');
  });

  it('DB down (host chết thật) → exit 2, 0 file', async () => {
    const d = join(tmp, 'dead');
    const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@10.255.255.1:5432/x' };
    expect(await gardenMediaMain(argv(d), { io: io().io, env })).toBe(2);
    expect(files(d)).toEqual([]);
  }, 30_000);

  type Q = { sql: string; params: unknown[] };
  const fake = (plots: string[], calls: Q[] = []) => ({
    db: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes('feature_rollout')) return { rows: [] };
        if (sql.startsWith('select 1 from plots'))
          return { rows: plots.includes(params[0] as string) ? [{}] : [] };
        if (sql.startsWith('insert into garden_media'))
          return {
            rows: calls.filter((c) => c.sql.startsWith('insert')).length > 1 ? [] : [{ id: '1' }],
          };
        throw new Error(`no route ${sql}`);
      },
    },
    release: async () => {},
  });
  // biome-ignore lint/suspicious/noExplicitAny: fake lease
  const lease = (x: unknown) => async () => x as any;

  it('tính năng farming-04 TẮT → exit 2, không đọc DB khoảnh, 0 file', async () => {
    settings.forceMode = 'tat';
    const calls: Q[] = [];
    const d = join(tmp, 'off');
    const c = io();
    expect(
      await gardenMediaMain(argv(d), { connect: lease(fake(['KV-T01'], calls)), io: c.io }),
    ).toBe(2);
    expect(c.err[0]).toMatch(/^\[blocked\].*farming-04/);
    expect(calls).toEqual([]);
    expect(existsSync(d)).toBe(false);
  });

  it('end-to-end (DB giả): gỡ EXIF, không in tọa độ/tên tệp/người; nạp lại → 1 file', async () => {
    settings.forceMode = 'van_hanh';
    const calls: Q[] = [];
    const d = join(tmp, 'e2e');
    const c = io();
    const db = fake(['KV-T01'], calls);
    expect(await gardenMediaMain(argv(d), { connect: lease(db), io: c.io })).toBe(0);
    expect(c.out[0]).toMatch(/^\[done\] [0-9a-f]{12} — gỡ 10 thẻ EXIF, có GPS: có$/);
    for (const leak of ['37.29', '59.77', 'IMG_2026_GPS', tmp, 'Bé Na'])
      expect(c.out[0]).not.toContain(leak);
    const fs = files(d);
    expect(fs).toHaveLength(1);
    await assertClean(readFileSync(join(d, fs[0] as string)));
    const ins = calls.find((x) => x.sql.startsWith('insert'));
    expect(ins?.params.slice(1, 11)).toEqual([
      'jpg',
      statSync(join(d, fs[0] as string)).size,
      16,
      32,
      'KV-T01',
      '2026-10-12',
      'Bé Na',
      10,
      true,
      'cli:garden_media',
    ]);
    const c2 = io();
    expect(await gardenMediaMain(argv(d), { connect: lease(db), io: c2.io })).toBe(0);
    expect(c2.out[0]).toContain('đã có trong kho');
    expect(files(d)).toHaveLength(1);
  });

  it('lỗi DB khi ghi → tên lớp lỗi psycopg (không phải pg "error"), exit 1', async () => {
    settings.forceMode = 'van_hanh';
    const db = fake(['KV-T01']);
    const q = db.db.query;
    db.db.query = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('insert into garden_media'))
        throw Object.assign(
          new pg.DatabaseError('relation "garden_media" does not exist', 0, 'error'),
          {
            code: '42P01',
          },
        );
      return q(sql, params);
    };
    const c = io();
    expect(await gardenMediaMain(argv(join(tmp, 'dberr')), { connect: lease(db), io: c.io })).toBe(
      1,
    );
    expect(c.err).toEqual([
      '[err] lỗi DB UndefinedTable — đã chạy `python scripts/apply_schema.py`?',
    ]);
  });

  it('khoảnh không có / không phải ảnh / không phải file thường → exit 1, 0 file', async () => {
    settings.forceMode = 'van_hanh';
    const d = join(tmp, 'rej');
    expect(
      await gardenMediaMain(argv(d, { plot: 'KV-NONE' }), {
        connect: lease(fake([])),
        io: io().io,
      }),
    ).toBe(1);
    writeFileSync(join(tmp, 'x.jpg'), 'not an image');
    expect(
      await gardenMediaMain(argv(d, { name: 'x.jpg' }), {
        connect: lease(fake(['KV-T01'])),
        io: io().io,
      }),
    ).toBe(1);
    mkdirSync(join(tmp, 'thu_muc.mp4'), { recursive: true });
    const c = io();
    expect(
      await gardenMediaMain(argv(d, { name: 'thu_muc.mp4' }), {
        connect: lease(fake(['KV-T01'])),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err[0]).toContain('file thường');
    expect(files(d)).toEqual([]);
  });

  it('video thiếu ffmpeg → exit 1, 0 file', async () => {
    settings.forceMode = 'van_hanh';
    const find = mediaDeps.findFfmpeg;
    mediaDeps.findFfmpeg = () => null;
    try {
      writeFileSync(join(tmp, 'clip.mp4'), b64(golden.boxes.isom_free[0] as string));
      const d = join(tmp, 'noff');
      const c = io();
      expect(
        await gardenMediaMain(argv(d, { name: 'clip.mp4' }), {
          connect: lease(fake(['KV-T01'])),
          io: c.io,
        }),
      ).toBe(1);
      expect(c.err[0]).toContain('ffmpeg');
      expect(files(d)).toEqual([]);
    } finally {
      mediaDeps.findFfmpeg = find;
    }
  });
});
