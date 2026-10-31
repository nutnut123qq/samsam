import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { REPO_ROOT } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import media from './__fixtures__/garden_media.golden.json' with { type: 'json' };
import { addLog, anomalyCheck, gardenMain, SOURCE as MANUAL } from './garden.js';
import { findFfmpeg, gardenMediaMain, record, store, stripImage } from './garden-media.js';
import { gardenMediaMktMain, get, MediaError } from './garden-media-mkt.js';
import {
  FEATURE_OFF,
  GardenZaloService,
  MAX_ATTACH,
  MAX_DETAIL,
  NEED_PLOT,
  NO_STORE,
  uhash,
  zaloGardenMain,
} from './garden-zalo.service.js';

// Dịch phần DB của tests/test_zalo_garden.py, test_garden_media.py, test_garden_chain.py (add_log qua
// hash chain), test_v13_c05_media.py (Zalo vườn video/ghi âm, --transcribe mock), test_contract_c07
// (cấp tư liệu cho Marketing). DB riêng `testDbName('garden_zalo')` tạo từ mẫu, xóa khi xong.

const NAME = testDbName('garden_zalo');
const STAFF_UID = '1234567890123456789';
const CDN = 'https://photo-1.zdn.vn/a/b.jpg';
const AUDIO = 'https://voice-2.zadn.vn/v/x.aac';
const ADTS = Buffer.concat([
  Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]),
  Buffer.alloc(16),
]);
const JPG = Buffer.from(media.images.jpeg_gps_xmp_orient6[0] as string, 'base64');

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('garden_zalo (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  const lease = () => async () => ({ db: pool, release: async () => {} });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    p: unknown[] = [],
  ) => (await pool.query<T>(sql, p)).rows;
  const count = async (sql: string) =>
    Number((await q<{ n: string }>(`select count(*) as n ${sql}`))[0]?.n);

  beforeAll(async () => {
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    tmp = mkdtempSync(join(tmpdir(), 'gz-db-'));
    settings.forceMode = null; // sổ triển khai thật của DB test (chưa vào sổ → chạy thử: vẫn ghi)
    await q("insert into plots (id, location, source) values ('KV-T01', 'Trà My', 'manual')");
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------- dịch vụ Zalo vườn
  type Rig = {
    svc: GardenZaloService;
    log: string[];
    urls: string[];
    kho: string;
    t: { mono: number; now: Date };
  };
  function rig(data: Buffer | null = null, env: Record<string, string> = {}): Rig {
    const staff = join(tmp, `staff_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      staff,
      JSON.stringify({ staff: [{ user_hash: uhash(STAFF_UID), ma_nv: 'VT01' }] }),
    );
    const kho = join(tmp, `kho_${Math.random().toString(36).slice(2)}`);
    const log: string[] = [];
    const urls: string[] = [];
    const t = { mono: 1_000_000, now: new Date() };
    const svc = new GardenZaloService(pool, {
      staffFile: staff,
      env: { NODE_ENV: 'test', GARDEN_MEDIA_DIR: kho, ...env },
      log: (s) => log.push(s),
      mono: () => t.mono,
      now: () => t.now,
      fetch: (async (u: string) => {
        urls.push(u);
        if (data === null) throw new Error('không được tải');
        return new Response(data);
      }) as unknown as typeof fetch,
    });
    return { svc, log, urls, kho, t };
  }
  async function run(svc: GardenZaloService, event: string, msg: unknown): Promise<string> {
    const sent: string[] = [];
    const r = await svc.handle(STAFF_UID, event, msg, 'm1', (_u, x) => {
      sent.push(x);
      return true;
    });
    expect(sent).toEqual([r.text]);
    return r.text;
  }
  const img = (text?: string, n = 1, url = CDN) => ({
    attachments: Array.from({ length: n }, () => ({ type: 'image', payload: { url } })),
    ...(text === undefined ? {} : { text }),
  });
  const voice = (text?: string, typ = 'audio') => ({
    attachments: [{ type: typ, payload: { url: AUDIO } }],
    ...(text === undefined ? {} : { text }),
  });
  const files = (d: string): string[] =>
    existsSync(d)
      ? readdirSync(d, { recursive: true, encoding: 'utf8' }).filter((p) =>
          statSync(join(d, p)).isFile(),
        )
      : [];

  describe('chữ → plot_logs (hash chain)', () => {
    beforeEach(async () => {
      await q('delete from garden_voice_drafts');
    });

    it('ghi nhật ký có chain, che PII, author/source đúng, nhớ khoảnh', async () => {
      const r = rig();
      const out = await run(r.svc, 'user_send_text', {
        text: 'kv-t01 tưới 30 phút, gọi 0912345678 nếu cần',
      });
      expect(out).toMatch(/^Đã ghi nhật ký #\d+: KV-T01 — tưới\.$/);
      const [row] = await q<{
        plot_id: string;
        activity: string;
        detail: string;
        author: string;
        source: string;
        row_hash: string;
      }>(
        "select plot_id, activity, detail, author, source, row_hash from plot_logs where source = 'zalo:garden' order by id desc limit 1",
      );
      expect([row?.plot_id, row?.activity, row?.author, row?.source]).toEqual([
        'KV-T01',
        'tưới',
        'zalo:VT01',
        'zalo:garden',
      ]);
      expect(row?.detail).toContain('30 phút');
      expect(row?.detail).not.toContain('0912345678');
      expect(row?.row_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await q('select * from verify_plot_logs()')).toEqual([]);
      expect(r.svc.recentPlot(uhash(STAFF_UID))).toBe('KV-T01');
      const printed = r.log.join('\n');
      expect(printed).not.toContain(STAFF_UID);
      expect(printed).toContain('uh=');
    });

    it('chi tiết cắt 1000 ký tự; dấu hiệu → ghi chú; khoảnh lạ → không ghi', async () => {
      const r = rig();
      r.t.now = new Date(Date.now() - 60_000);
      await run(r.svc, 'user_send_text', { text: `KV-T01 ghi nhận ${'a'.repeat(5000)}` });
      const [x] = await q<{ n: number }>(
        "select length(detail) as n from plot_logs where source = 'zalo:garden' order by id desc limit 1",
      );
      expect(x?.n).toBe(MAX_DETAIL);
      r.t.now = new Date(Date.now() - 120_000);
      expect(
        await run(r.svc, 'user_send_text', { text: 'KV-T01 kiểm tra sâu bệnh có rệp' }),
      ).toContain('dấu hiệu cần chú ý');
      const before = await count("from plot_logs where source = 'zalo:garden'");
      const r2 = rig();
      const out = await run(r2.svc, 'user_send_text', { text: 'KV-ZZ9 tưới' });
      expect(out).toContain("Không tìm thấy khoảnh 'KV-ZZ9'");
      expect(out).toContain('Cú pháp');
      expect(await count("from plot_logs where source = 'zalo:garden'")).toBe(before);
      expect(r2.svc.recentPlot(uhash(STAFF_UID))).toBeNull();
    });

    it('trùng (cùng ts + hoạt động) → CHƯA ghi', async () => {
      const r = rig();
      r.t.now = new Date(Date.UTC(2026, 9, 15, 1));
      expect(await run(r.svc, 'user_send_text', { text: 'KV-T01 tưới' })).toMatch(/^Đã/);
      const out = await run(r.svc, 'user_send_text', { text: 'KV-T01 tưới' });
      expect(out.startsWith('CHƯA ghi:') && out.includes('trùng')).toBe(true);
    });
  });

  describe('ảnh → garden_media', () => {
    it('khoảnh ở chú thích: lưu bản sạch, đúng author/source/had_gps', async () => {
      const r = rig(JPG);
      const out = await run(r.svc, 'user_send_image', img('kv-t01 lá vàng'));
      expect(out.startsWith('Đã lưu 1/1 ảnh cho khoảnh KV-T01')).toBe(true);
      expect(r.urls).toEqual([CDN]);
      const [row] = await q<{
        sha256: string;
        plot_id: string;
        author: string;
        source: string;
        had_gps: boolean;
      }>(
        "select sha256, plot_id, author, source, had_gps from garden_media where source = 'zalo:garden' order by id desc limit 1",
      );
      expect([row?.plot_id, row?.author, row?.source, row?.had_gps]).toEqual([
        'KV-T01',
        'zalo:VT01',
        'zalo:garden',
        true,
      ]);
      const f = join(r.kho, String(row?.sha256).slice(0, 2), `${row?.sha256}.jpg`);
      expect(readFileSync(f).includes(Buffer.from('GPS'))).toBe(false);
      expect((await sharp(f).metadata()).exif).toBeUndefined();
    });

    it('dùng khoảnh của tin chữ gần nhất; trần MAX_ATTACH; cùng nội dung → 1 dòng', async () => {
      const png = Buffer.from(media.images.png_rgba_exif_text[0] as string, 'base64');
      const r = rig(png);
      r.t.now = new Date(Date.now() - 300_000);
      await run(r.svc, 'user_send_text', { text: 'KV-T01 kiểm tra sâu bệnh' });
      const before = await count('from garden_media');
      const out = await run(r.svc, 'user_send_image', img(undefined, 7));
      expect(out.startsWith(`Đã lưu ${MAX_ATTACH}/${MAX_ATTACH} ảnh`)).toBe(true);
      expect(r.urls).toHaveLength(MAX_ATTACH);
      expect(await count('from garden_media')).toBe(before + 1);
    });

    it('chưa biết khoảnh (không chú thích / khoảnh lạ / quá 2 giờ) → NEED_PLOT, không tải', async () => {
      const r = rig();
      expect(await run(r.svc, 'user_send_image', img())).toBe(NEED_PLOT);
      expect(await run(r.svc, 'user_send_image', img('KV-ZZ9 lá'))).toBe(NEED_PLOT);
      r.svc.lastPlot.set(uhash(STAFF_UID), ['KV-T01', r.t.mono - 2 * 3600_000 - 1]);
      expect(await run(r.svc, 'user_send_image', img())).toBe(NEED_PLOT);
      expect(r.urls).toEqual([]);
      expect(existsSync(r.kho)).toBe(false);
    });

    it('bytes không phải ảnh / URL ngoài CDN → CHƯA lưu, không in URL', async () => {
      const r = rig(Buffer.from('not an image'));
      const before = await count('from garden_media');
      expect(await run(r.svc, 'user_send_image', img('KV-T01'))).toMatch(/^CHƯA lưu được tệp/);
      expect(r.log.join('\n')).not.toContain(CDN);
      expect(await run(r.svc, 'user_send_image', img('KV-T01', 1, 'https://evil.com/a'))).toMatch(
        /^CHƯA lưu được tệp/,
      );
      expect(r.urls).toEqual([CDN]);
      expect(await count('from garden_media')).toBe(before);
    });
  });

  it('sổ triển khai THẬT farming-01/04 = tat → FEATURE_OFF chữ/ảnh/ghi âm, 0 dòng, 0 tải', async () => {
    // Trước đây chỉ kiểm qua settings.forceMode='tat'; ở đây đọc đúng bảng feature_rollout của DB.
    await q(
      "insert into feature_rollout (feature_id, stage, updated_by) values ('farming-01', 'tat', 'Tester'), ('farming-04', 'tat', 'Tester')",
    );
    try {
      const r = rig(JPG);
      const before = await count("from plot_logs where source = 'zalo:garden'");
      const media0 = await count('from garden_media');
      const drafts0 = await count('from garden_voice_drafts');
      expect(await run(r.svc, 'user_send_text', { text: 'KV-T01 bón phân' })).toBe(FEATURE_OFF);
      expect(await run(r.svc, 'user_send_image', img('KV-T01'))).toBe(FEATURE_OFF);
      expect(await run(r.svc, 'user_send_audio', voice('KV-T01'))).toBe(FEATURE_OFF);
      expect(r.urls).toEqual([]);
      expect(existsSync(r.kho)).toBe(false);
      expect(await count("from plot_logs where source = 'zalo:garden'")).toBe(before);
      expect(await count('from garden_media')).toBe(media0);
      expect(await count('from garden_voice_drafts')).toBe(drafts0);
    } finally {
      await q("delete from feature_rollout where feature_id in ('farming-01', 'farming-04')");
    }
  });

  describe('ghi âm → garden_voice_drafts', () => {
    beforeEach(async () => {
      await q('delete from garden_voice_drafts');
    });

    it('nháp chờ chép lời, KHÔNG gửi audio đi STT; gửi lại cùng tệp → không thêm dòng', async () => {
      const r = rig(ADTS, { GARDEN_STT_PROVIDER: 'some-stt' });
      const out = await run(r.svc, 'user_send_audio', voice());
      expect(out).toContain('chờ người chép lời');
      expect(out).not.toContain('khoảnh');
      const [row] = await q<{
        sha256: string;
        ext: string;
        bytes: string;
        staff_code: string;
        plot_id: string | null;
        status: string;
      }>('select sha256, ext, bytes, staff_code, plot_id, status from garden_voice_drafts');
      expect([row?.ext, Number(row?.bytes), row?.staff_code, row?.plot_id, row?.status]).toEqual([
        'aac',
        ADTS.length,
        'VT01',
        null,
        'cho_chep_loi',
      ]);
      const sha = row?.sha256 as string;
      expect(readFileSync(join(r.kho, 'audio', sha.slice(0, 2), `${sha}.aac`)).equals(ADTS)).toBe(
        true,
      );
      expect(r.log.join('\n')).toContain('chưa tích hợp');
      expect(r.urls).toEqual([AUDIO]); // chỉ tải từ CDN Zalo, không gọi gì khác
      await run(r.svc, 'user_send_voice', voice(undefined, 'voice'));
      expect(await count('from garden_voice_drafts')).toBe(1);
    });

    it('có khoảnh ở chú thích; kho thiếu → NO_STORE; không đúng magic → không lưu; đuôi theo nội dung', async () => {
      const a = rig(ADTS, { GARDEN_MEDIA_DIR: '' });
      expect(await run(a.svc, 'user_send_audio', voice('KV-T01'))).toBe(NO_STORE);
      const b = rig(Buffer.concat([ADTS, Buffer.from('2')]));
      expect(await run(b.svc, 'user_send_audio', voice('KV-T01'))).toContain('(khoảnh KV-T01)');
      expect(await q('select plot_id, ext from garden_voice_drafts')).toEqual([
        { plot_id: 'KV-T01', ext: 'aac' },
      ]);
      const c = rig(Buffer.from('MZ\x90\x00PE-exe', 'latin1'));
      expect(await run(c.svc, 'user_send_audio', voice())).toMatch(/^CHƯA lưu được tệp/);
      expect(existsSync(join(c.kho, 'audio'))).toBe(false);
      expect(await count('from garden_voice_drafts')).toBe(1);
    });

    it('CHECK của bảng: đóng nháp thiếu nhật ký / đuôi lạ → DB từ chối', async () => {
      await q(
        "insert into garden_voice_drafts (sha256, ext, bytes, staff_code) values ($1, 'aac', 1, 'VT01')",
        ['a'.repeat(64)],
      );
      await expect(
        q("update garden_voice_drafts set status = 'da_chep_loi'"),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        q(
          "insert into garden_voice_drafts (sha256, ext, bytes, staff_code) values ($1, 'exe', 1, 'x')",
          ['b'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('CLI --pending / --done (nhật ký phải tồn tại, nháp phải đang chờ)', async () => {
      const [{ id: did } = { id: '' }] = await q<{ id: string }>(
        "insert into garden_voice_drafts (sha256, ext, bytes, staff_code, plot_id) values ($1, 'aac', 3, 'VT01', 'KV-T01') returning id",
        ['c'.repeat(64)],
      );
      let c = io();
      expect(await zaloGardenMain({ pending: true }, { connect: lease(), io: c.io, env: {} })).toBe(
        0,
      );
      expect(c.out[0]).toMatch(
        new RegExp(
          `^#${did} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC VT01 KV-T01 cccccccccccc\\.aac$`,
        ),
      );
      expect(c.out).toContain('[pending] 1 ghi âm chờ chép lời');
      expect(c.out.at(-1)).toMatch(/^\[blocked\] STT chưa cấu hình/);
      const [{ id: lid } = { id: '' }] = await q<{ id: string }>(
        "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('KV-T01', now(), 'tưới', 'chép từ ghi âm', 'Người chép', $1) returning id",
        [MANUAL],
      );
      const done = (d: string, l: string, by: string) =>
        zaloGardenMain({ done: d, log: l, by }, { connect: lease(), io: io().io, env: {} });
      expect(await done(did, String(Number(lid) + 999), 'Người chép')).toBe(1);
      expect(await done(String(Number(did) + 999), lid, 'Người chép')).toBe(1);
      expect(await done(did, lid, ' Người chép ')).toBe(0);
      const [row] = await q<{
        status: string;
        plot_log_id: string;
        closed_by: string;
        closed: boolean;
      }>(
        'select status, plot_log_id, closed_by, closed_at is not null as closed from garden_voice_drafts where id = $1',
        [did],
      );
      expect(row).toEqual({
        status: 'da_chep_loi',
        plot_log_id: lid,
        closed_by: 'Người chép',
        closed: true,
      });
      expect(await done(did, lid, 'Khác')).toBe(1);
      c = io();
      expect(await zaloGardenMain({ pending: true }, { connect: lease(), io: c.io, env: {} })).toBe(
        0,
      );
      expect(c.out).toEqual(['[pending] 0 ghi âm chờ chép lời']);
    });

    it('CLI --transcribe qua AI worker GIẢ: in NHÁP đã che PII, không đóng nháp; tệp bị tráo → exit 1', async () => {
      const r = rig(ADTS);
      await run(r.svc, 'user_send_voice', voice('KV-T01', 'voice'));
      const [{ id, sha256: sha } = { id: '', sha256: '' }] = await q<{
        id: string;
        sha256: string;
      }>('select id, sha256 from garden_voice_drafts');
      const seen: Buffer[] = [];
      const worker = (async (u: string, init: RequestInit) => {
        expect(u).toBe('http://127.0.0.1:8790/stt');
        seen.push(Buffer.from(init.body as Uint8Array));
        return Response.json({ ok: true, text: 'KV-T01 tưới 30 phút, gọi 0905123456' });
      }) as unknown as typeof fetch;
      const env = {
        GARDEN_STT_PROVIDER: 'whisper_local',
        AI_WORKER_URL: 'http://127.0.0.1:8790',
        GARDEN_MEDIA_DIR: r.kho,
      };
      const c = io();
      expect(
        await zaloGardenMain(
          { transcribe: id },
          { connect: lease(), io: c.io, env, fetch: worker },
        ),
      ).toBe(0);
      expect(seen.map((b) => b.equals(ADTS))).toEqual([true]);
      expect(c.out[0]).toContain('NHÁP');
      expect(c.out[0]).toContain('tưới 30 phút');
      expect(c.out[0]).not.toContain('0905123456');
      expect(
        (await q<{ status: string }>('select status from garden_voice_drafts'))[0]?.status,
      ).toBe('cho_chep_loi');
      writeFileSync(join(r.kho, 'audio', sha.slice(0, 2), `${sha}.aac`), 'x');
      const e = io();
      expect(
        await zaloGardenMain(
          { transcribe: id },
          { connect: lease(), io: e.io, env, fetch: worker },
        ),
      ).toBe(1);
      expect(e.err[0]).toContain('lệch sha256');
      expect(seen).toHaveLength(1);
      expect(
        await zaloGardenMain(
          { transcribe: '999999' },
          { connect: lease(), io: io().io, env, fetch: worker },
        ),
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------- video qua Zalo (cần ffmpeg)
  const FF = (() => {
    const f = findFfmpeg(process.env);
    if (f) return f;
    try {
      const p = execFileSync(
        'python',
        ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
        { encoding: 'utf8', timeout: 30_000 },
      ).trim();
      return p && existsSync(p) ? p : null;
    } catch {
      return null;
    }
  })();
  it.skipIf(!FF)(
    'video Zalo: lưu bản đã gỡ vị trí (không qua nhánh ảnh), thư mục tạm sạch',
    async () => {
      const src = join(tmp, 'z.mov');
      execFileSync(FF as string, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=32x32:rate=5',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-shortest',
        '-metadata',
        'location=+16.0544+108.2022/',
        '-movflags',
        'use_metadata_tags',
        '-f',
        'mov',
        src,
      ]);
      const mov = readFileSync(src);
      const r = rig(mov, { FFMPEG_BIN: FF as string });
      const msg = {
        text: 'KV-T01 vườn sau mưa',
        attachments: [{ type: 'video', payload: { url: 'https://video-1.zdn.vn/v/clip.mp4' } }],
      };
      expect(await run(r.svc, 'user_send_video', msg)).toMatch(
        /^Đã lưu 1\/1 video cho khoảnh KV-T01/,
      );
      const [row] = await q<{ sha256: string; ext: string; source: string; author: string }>(
        "select sha256, ext, source, author from garden_media where ext = 'mov'",
      );
      expect([row?.ext, row?.source, row?.author]).toEqual(['mov', 'zalo:garden', 'zalo:VT01']);
      const f = readFileSync(join(r.kho, String(row?.sha256).slice(0, 2), `${row?.sha256}.mov`));
      for (const l of ['location', '108.2022', 'ISO6709'])
        expect(f.includes(Buffer.from(l)), l).toBe(false);
      expect(readdirSync(join(r.kho, '.tmp'))).toEqual([]);
      expect(await run(r.svc, 'user_send_video', { attachments: msg.attachments })).toBe(NEED_PLOT);
    },
  );

  // ---------------------------------------------------------- agents.garden qua chain
  it('add_log ghi qua hash chain; anomaly_check đọc DB thật; CLI garden', async () => {
    const [lid, warns] = await addLog(pool, 'KV-T01', '2026-10-10', 'tuoi', 'sáng', 'Bé');
    expect(lid).not.toBeNull();
    expect(warns).toEqual([]);
    const [row] = await q<{ row_hash: string; source: string; activity: string }>(
      'select row_hash, source, activity from plot_logs where id = $1',
      [String(lid)],
    );
    expect(row?.source).toBe(MANUAL);
    expect(row?.activity).toBe('tưới');
    expect(row?.row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await q('select * from verify_plot_logs()')).toEqual([]);
    const items = await anomalyCheck(pool, 14, new Date(Date.UTC(2027, 0, 1)));
    expect(items.some((i) => i.type === 'gap' && i.plot === 'KV-T01')).toBe(true);
    const c = io();
    expect(
      await gardenMain(
        { plot: 'KV-T01', activity: 'bón', ts: '2026-10-11T03:00:00Z', author: 'Bé' },
        { connect: lease(), io: c.io },
      ),
    ).toBe(0);
    expect(c.out.at(-1)).toMatch(/^\[done\] nhật ký #\d+: KV-T01 — 2026-10-11 03:00 UTC$/);
    expect(
      await gardenMain({ plot: 'KV-NONE', activity: 'bón' }, { connect: lease(), io: io().io }),
    ).toBe(2);
    const k = io();
    expect(await gardenMain({ check: true }, { connect: lease(), io: k.io })).toBe(0);
  });

  // ---------------------------------------------------------- garden_media CLI + record
  it('garden-media CLI end-to-end: 1 tệp sạch + 1 dòng, nạp lại không nhân bản; khoảnh lạ → 0 tệp', async () => {
    const d = join(tmp, 'cli-store');
    const file = join(tmp, 'IMG_2026_GPS.jpg');
    // ảnh khác các test Zalo (kho theo nội dung — cùng ảnh = cùng dòng)
    writeFileSync(file, Buffer.from(media.images.jpeg_gps_orient1[0] as string, 'base64'));
    const argv = { file, plot: 'KV-T01', date: '2026-10-12', by: 'Bé Na', store: d };
    const c = io();
    expect(
      await gardenMediaMain(argv, { connect: lease(), io: c.io, env: { NODE_ENV: 'test' } }),
    ).toBe(0);
    expect(c.out[0]).toMatch(/có GPS: có$/);
    for (const leak of ['37.29', 'IMG_2026_GPS', tmp, 'Bé Na'])
      expect(c.out[0]).not.toContain(leak);
    const fs = files(d);
    expect(fs).toHaveLength(1);
    const sha = createHash('sha256')
      .update(readFileSync(join(d, fs[0] as string)))
      .digest('hex');
    const [row] = await q<{
      plot_id: string;
      day: string;
      author: string;
      had_gps: boolean;
      exif_removed: number;
      bytes: string;
    }>(
      'select plot_id, taken_on::text as day, author, had_gps, exif_removed, bytes from garden_media where sha256 = $1',
      [sha],
    );
    expect(row).toEqual({
      plot_id: 'KV-T01',
      day: '2026-10-12',
      author: 'Bé Na',
      had_gps: true,
      exif_removed: 10,
      bytes: String(statSync(join(d, fs[0] as string)).size),
    });
    const c2 = io();
    expect(
      await gardenMediaMain(argv, { connect: lease(), io: c2.io, env: { NODE_ENV: 'test' } }),
    ).toBe(0);
    expect(c2.out[0]).toContain('đã có trong kho');
    expect(await count(`from garden_media where sha256 = '${sha}'`)).toBe(1);
    const d2 = join(tmp, 'cli-store2');
    expect(
      await gardenMediaMain(
        { ...argv, plot: 'KV-NONE', store: d2 },
        { connect: lease(), io: io().io, env: { NODE_ENV: 'test' } },
      ),
    ).toBe(1);
    expect(files(d2)).toEqual([]);
    const info = { width: 1, height: 1, exif_removed: 0, had_gps: false };
    await expect(
      record(pool, 'd'.repeat(64), 'jpg', 5, info, 'KV-NONE', '2026-10-12', 'Bé'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  // ---------------------------------------------------------- cấp tư liệu cho Marketing
  describe('garden_media_mkt (farming-04 → Marketing)', () => {
    async function mediaRow(
      data: Buffer,
      ext: string,
      kho: string,
      source = 'cli:garden_media',
    ): Promise<string> {
      const [sha] = store(data, ext, kho);
      await q(
        "insert into plots (id, location, source) values ('KV-C7', 'x', 'manual') on conflict do nothing",
      );
      await q(
        "insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author, source) values ($1, $2, $3, 'KV-C7', '2026-10-01', 'Ky thuat', $4)",
        [sha, ext, data.length, source],
      );
      return sha;
    }
    const rel = async (sha: string, action = 'cap', by = 'GĐ Vùng Trồng') =>
      (
        await q<{ ok: boolean }>('select garden_media_release_human($1, $2, $3, null) as ok', [
          sha,
          action,
          by,
        ])
      )[0]?.ok;
    const plain = (rgb: [number, number, number]) =>
      sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: rgb[0], g: rgb[1], b: rgb[2] },
        },
      })
        .png()
        .toBuffer();

    it('cấp → lấy được; không ghi lặp; view không có khoảnh/tác giả; thu hồi → không lấy được', async () => {
      const kho = join(tmp, 'mkt-kho');
      const out = join(tmp, 'mkt-out');
      const [clean, ext] = await stripImage(await plain([10, 120, 30]));
      const sha = await mediaRow(clean, ext, kho);
      await expect(get(pool, sha, out, kho)).rejects.toThrow(/chưa được cấp/);
      expect(await rel(sha)).toBe(true);
      expect(await rel(sha)).toBe(false);
      const r = await pool.query('select * from v_garden_media_marketing where sha256 = $1', [sha]);
      expect(r.rows).toHaveLength(1);
      const cols = r.fields.map((f) => f.name);
      expect(cols).not.toContain('plot_id');
      expect(cols).not.toContain('author');
      const dst = await get(pool, sha, out, kho);
      expect(readFileSync(dst).equals(clean)).toBe(true);
      const c = io();
      expect(await gardenMediaMktMain({ list: true }, { connect: lease(), io: c.io })).toBe(0);
      expect(c.out).toContainEqual(
        expect.stringMatching(
          new RegExp(`^${sha} ${ext} ${clean.length}B chụp 2026-10-01 cấp \\d{4}-\\d{2}-\\d{2}$`),
        ),
      );
      expect(await rel(sha, 'thu_hoi')).toBe(true);
      await expect(get(pool, sha, join(tmp, 'mkt-out2'), kho)).rejects.toThrow(/chưa được cấp/);
    });

    it('thư mục ra trong repo / tệp bị tráo / thiếu tệp / còn EXIF → từ chối, không chép gì', async () => {
      const kho = join(tmp, 'mkt-kho2');
      const out = join(tmp, 'mkt-out3');
      const [clean, ext] = await stripImage(await plain([1, 2, 3]));
      const sha = await mediaRow(clean, ext, kho);
      await rel(sha);
      await expect(get(pool, sha, join(REPO_ROOT, 'data', 'x'), kho)).rejects.toThrow(/trong repo/);
      const f = join(kho, sha.slice(0, 2), `${sha}.${ext}`);
      writeFileSync(f, Buffer.concat([clean, Buffer.from('x')]));
      await expect(get(pool, sha, out, kho)).rejects.toThrow(/lệch sha256/);
      rmSync(f);
      await expect(get(pool, sha, out, kho)).rejects.toThrow(/thiếu tệp/);
      const dirty = Buffer.from(media.images.jpeg_make_only[0] as string, 'base64'); // ghi sai quy trình
      const sha2 = await mediaRow(dirty, 'jpg', kho);
      await rel(sha2);
      await expect(get(pool, sha2, out, kho)).rejects.toThrow(MediaError);
      await expect(get(pool, sha2, out, kho)).rejects.toThrow(/EXIF/);
      // Review vòng 3: EXIF+GPS trong chunk 'Raw profile type exif' (Pillow đọc, sharp metadata không)
      const raw = Buffer.from(
        media.check_clean.png_rgba_rawprofile_ztxt_gps[0] as string,
        'base64',
      );
      const sha3 = await mediaRow(raw, 'png', kho);
      await rel(sha3);
      await expect(get(pool, sha3, out, kho)).rejects.toThrow('ảnh còn thẻ EXIF/GPS — không cấp');
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
      expect(existsSync(join(REPO_ROOT, 'data', 'x'))).toBe(false);
    });

    it('tư liệu mẫu ẩn; agent không quyết; app_human chỉ thấy view; sổ append-only', async () => {
      const [clean, ext] = await stripImage(await plain([9, 9, 9]));
      const sha = await mediaRow(clean, ext, join(tmp, 'mkt-kho3'), 'sample:test');
      await rel(sha);
      expect(await count(`from v_garden_media_marketing where sha256 = '${sha}'`)).toBe(0);
      await expect(rel(sha, 'thu_hoi', 'agent:mkt')).rejects.toThrow();
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role app_human');
        await c.query('select sha256 from v_garden_media_marketing');
        await c.query('savepoint s');
        await expect(c.query('select author from garden_media')).rejects.toMatchObject({
          code: '42501',
        });
        await c.query('rollback to savepoint s');
        await expect(
          c.query(
            "insert into garden_media_releases (sha256, action, by_person) values ($1, 'cap', 'x')",
            [sha],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.query('rollback');
        c.release();
      }
      await expect(q('delete from garden_media_releases')).rejects.toThrow();
    });

    it('CLI: sai tham số exit 2; cấp/thu hồi qua cổng người (agent → từ chối exit 1); không ghi lặp', async () => {
      const [clean, ext] = await stripImage(await plain([7, 70, 7]));
      const sha = await mediaRow(clean, ext, join(tmp, 'mkt-kho4'));
      const noConnect = async () => {
        throw new Error('không được connect');
      };
      for (const o of [
        {},
        { release: sha, revoke: sha, by: 'A' },
        { release: sha },
        { get: sha },
        { list: true, get: sha },
      ]) {
        expect(
          await gardenMediaMktMain(o, { connect: noConnect, io: io().io, env: {} }),
          JSON.stringify(o),
        ).toBe(2);
      }
      const e = io();
      expect(
        await gardenMediaMktMain(
          { release: sha, by: 'agent:mkt' },
          { connect: lease(), io: e.io, env: {} },
        ),
      ).toBe(1);
      expect(e.err.at(-1)).toMatch(/^\[từ chối\]/);
      const c = io();
      expect(
        await gardenMediaMktMain(
          { release: ` ${sha.toUpperCase()} `, by: 'GĐ Vùng Trồng' },
          { connect: lease(), io: c.io, env: {} },
        ),
      ).toBe(0);
      expect(c.out.at(-1)).toBe(`[done] ${sha.slice(0, 12)} đã cập nhật`);
      const c2 = io();
      expect(
        await gardenMediaMktMain(
          { release: sha, by: 'GĐ Vùng Trồng' },
          { connect: lease(), io: c2.io, env: {} },
        ),
      ).toBe(0);
      expect(c2.out.at(-1)).toContain('không ghi lặp');
      const g = io();
      const out = join(tmp, 'mkt-cli-out');
      expect(
        await gardenMediaMktMain(
          { get: sha, out, store: join(tmp, 'mkt-kho4') },
          { connect: lease(), io: g.io, env: {} },
        ),
      ).toBe(0);
      expect(g.out.at(-1)).toBe(`[done] ${sha.slice(0, 12)} → ${sha}.${ext}`);
      expect(
        await gardenMediaMktMain(
          { revoke: 'f'.repeat(64), by: 'GĐ Vùng Trồng' },
          { connect: lease(), io: io().io, env: {} },
        ),
      ).toBe(1);
    });
  });
});
