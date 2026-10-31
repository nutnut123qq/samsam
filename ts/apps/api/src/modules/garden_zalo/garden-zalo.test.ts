import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import type pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GardenIntake } from '../zalo/zalo.deps.js';
import { uhash as zaloUhash } from '../zalo/zalo.util.js';
import golden from './__fixtures__/zalo_garden.golden.json' with { type: 'json' };
import { Rejected } from './garden-media.js';
import {
  audioKind,
  DB_DOWN,
  ERROR,
  FEATURE_OFF,
  fetchMedia,
  GardenZaloService,
  HELP,
  NO_FILE,
  NO_STORE,
  parseStaff,
  parseText,
  plotOwners,
  storeDir,
  UNSUPPORTED,
  uhash,
  zaloGardenMain,
} from './garden-zalo.service.js';

// Dịch tests/test_zalo_garden.py (phần không DB), test_contract_c02 (plot_owners), test_v13_review_fix
// (cổng TẮT), test_v13_c05/test_r13 (STT chặn trước connect). Golden từ connectors/zalo_garden.py.

const STAFF_UID = '1234567890123456789';
const CDN = 'https://photo-1.zdn.vn/a/b.jpg';
const tmp = mkdtempSync(join(tmpdir(), 'gz-zalo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const b64 = (s: string) => Buffer.from(s, 'base64');

describe('golden connectors/zalo_garden.py', () => {
  it('uhash = zalo.uhash', () => {
    for (const [s, h] of golden.uhash) {
      expect(uhash(s as string)).toBe(h);
      expect(zaloUhash(s as string)).toBe(h);
    }
  });
  it('parse_text', () => {
    for (const [s, want] of golden.parse)
      expect(parseText(s as string | null), String(s)).toEqual(want);
  });
  it('audio_kind theo magic bytes', () => {
    for (const [b, want] of golden.audio) {
      if (typeof want === 'string') expect(audioKind(b64(b as string))).toBe(want);
      else
        expect(() => audioKind(b64(b as string))).toThrow(
          new Rejected((want as { err: string }).err),
        );
    }
  });
  it('allowlist: hỏng / một dòng sai → cả tệp bị bỏ', () => {
    for (const [raw, want, tsStricter] of golden.staff) {
      let got: Record<string, string>;
      try {
        got = Object.fromEntries(parseStaff(b64(raw as string)));
      } catch {
        got = {};
      }
      // KHÁC có chủ đích: UTF-16 (Python json.loads(bytes) tự dò mã hóa) → TS coi là hỏng.
      const utf16 =
        tsStricter &&
        !b64(raw as string)
          .subarray(0, 3)
          .equals(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(got, raw as string).toEqual(utf16 ? {} : want);
    }
  });
  it('plot_owners', () => {
    for (const [raw, want] of golden.owners) {
      const p = join(tmp, 'owners.json');
      rmSync(p, { force: true });
      if (raw !== null) writeFileSync(p, b64(raw as string));
      const got = plotOwners(p, () => {});
      expect([...got], String(raw)).toEqual(Object.entries(want as object));
    }
  });
  it('fetch: chỉ https + host CDN Zalo (chặn SSRF), không gọi mạng khi từ chối', async () => {
    for (const [url, want] of golden.fetch_host) {
      const called: string[] = [];
      const f = async (u: string | URL | Request) => {
        called.push(String(u));
        return new Response('x', { status: 200 });
      };
      const got = await fetchMedia(url as string, 10, f as typeof fetch).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      expect(got, url as string).toBe(want);
      expect(called.length).toBe(want === 'ok' ? 1 : 0);
    }
  });
});

describe('fetchMedia: giới hạn', () => {
  const resp = (body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}) =>
    (async () => new Response(body, init)) as unknown as typeof fetch;
  it('ok / vượt trần (stream + content-length) / rỗng / HTTP ≠ 200 (kể cả redirect)', async () => {
    expect((await fetchMedia(CDN, 10, resp('abc'))).toString()).toBe('abc');
    await expect(fetchMedia(CDN, 2, resp('abc'))).rejects.toThrow('tệp quá lớn');
    await expect(
      fetchMedia(CDN, 10, resp('x', { headers: { 'content-length': '999' } })),
    ).rejects.toThrow('tệp quá lớn');
    await expect(fetchMedia(CDN, 10, resp(null))).rejects.toThrow('tệp rỗng');
    for (const status of [302, 404, 500]) {
      await expect(
        fetchMedia(CDN, 10, resp(null, { status, headers: { location: 'https://evil.com/' } })),
      ).rejects.toThrow(`HTTP ${status}`);
    }
  });
  it('không theo redirect; lỗi mạng bọc thành Rejected (không in URL)', async () => {
    let init: RequestInit | undefined;
    const spy = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response('x');
    }) as unknown as typeof fetch;
    await fetchMedia(CDN, 10, spy);
    expect(init?.redirect).toBe('manual');
    const boom = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      });
    }) as unknown as typeof fetch;
    const e = await fetchMedia(CDN, 10, boom).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Rejected);
    expect((e as Error).message).toBe('tải tệp lỗi ECONNREFUSED');
  });
});

describe('fetchMedia: hạn chờ TỪNG lần (httpx timeout=15), không phải hạn tổng', () => {
  // Review vòng 3: AbortSignal.timeout(15 s) cắt cả lúc tải thân → video tải > 15 s (vẫn chảy đều) bị
  // từ chối trong khi Python nhận. Kiểm thật bằng server 18 s ở probe review; ở đây hạn thu còn 150 ms.
  const slow = (gaps: number[], stall = false) =>
    (async (_u: string, init: RequestInit) => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i === gaps.length) {
            if (stall) return new Promise<void>(() => {}); // không bao giờ gửi tiếp
            c.close();
            return;
          }
          await new Promise((r) => setTimeout(r, gaps[i++]));
          c.enqueue(new Uint8Array([1, 2]));
        },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(body);
    }) as unknown as typeof fetch;

  it('chảy chậm nhưng đều (tổng > hạn, mỗi nhịp < hạn) → nhận đủ', async () => {
    const t0 = Date.now();
    const got = await fetchMedia(CDN, 100, slow([60, 60, 60, 60, 60, 60]), 150);
    expect(got.length).toBe(12);
    expect(Date.now() - t0).toBeGreaterThan(150);
  });
  it('đứng giữa chừng / không trả đầu phản hồi → Rejected ReadTimeout (không treo)', async () => {
    const e1 = await fetchMedia(CDN, 100, slow([10], true), 150).catch((x: Error) => x);
    expect(e1).toBeInstanceOf(Rejected);
    expect((e1 as Error).message).toBe('tải tệp lỗi ReadTimeout');
    let aborted = false;
    const hang = ((_u: string, init: RequestInit) =>
      new Promise<Response>(() => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
        });
      })) as unknown as typeof fetch;
    const e2 = await fetchMedia(CDN, 100, hang, 150).catch((x: Error) => x);
    expect((e2 as Error).message).toBe('tải tệp lỗi ReadTimeout');
    expect(aborted).toBe(true);
  });
});

describe('store_dir', () => {
  it('thiếu / khoảng trắng / trong repo → null', () => {
    const log: string[] = [];
    expect(storeDir({}, (s) => log.push(s))).toBeNull();
    expect(storeDir({ GARDEN_MEDIA_DIR: '   ' })).toBeNull();
    expect(
      storeDir({ GARDEN_MEDIA_DIR: join(REPO_ROOT, 'data', 'x') }, (s) => log.push(s)),
    ).toBeNull();
    expect(log).toEqual(['[warn] garden: GARDEN_MEDIA_DIR nằm trong repo — không lưu']);
    expect(storeDir({ GARDEN_MEDIA_DIR: join(tmp, 'kho') })).toBe(resolve(tmp, 'kho'));
  });
});

// ------------------------------------------------------------ dịch vụ (không DB thật)

type Logged = { log: string[]; svc: GardenZaloService; staff: string };
function rig(pool: unknown = null, env: Record<string, string> = {}, mono = () => 0): Logged {
  const staff = join(tmp, `staff_${Math.random().toString(36).slice(2)}.json`);
  const log: string[] = [];
  const svc = new GardenZaloService(pool as pg.Pool | null, {
    staffFile: staff,
    env: { NODE_ENV: 'test', ...env },
    log: (s) => log.push(s),
    mono,
    fetch: (async () => {
      throw new Error('không được tải');
    }) as unknown as typeof fetch,
  });
  return { log, svc, staff };
}
const writeStaff = (p: string, rows?: unknown[]) =>
  writeFileSync(
    p,
    JSON.stringify({ _doc: 'x', staff: rows ?? [{ user_hash: uhash(STAFF_UID), ma_nv: 'VT01' }] }),
  );

async function run(svc: GardenZaloService, event: string, msg: unknown): Promise<string> {
  const sent: [string, string][] = [];
  const r = await svc.handle(STAFF_UID, event, msg, 'm1', (u, t) => {
    sent.push([u, t]);
    return true;
  });
  expect(sent).toEqual([[STAFF_UID, r.text]]);
  expect(r.sent).toBe(true);
  return r.text;
}

/** Pool giả: connect() → client mà MỌI truy vấn = lỗi (biên phải chặn TRƯỚC khi đụng DB). */
const noQueryPool = (
  onQuery = (): never => {
    throw new Error('không được truy vấn');
  },
) => ({
  async connect() {
    return { query: async () => onQuery(), release() {} };
  },
});

describe('GardenZaloService (không DB)', () => {
  beforeEach(() => {
    settings.forceMode = 'van_hanh';
  });
  afterEach(() => {
    settings.forceMode = null;
  });

  it('khớp interface GardenIntake của module zalo', () => {
    const g: GardenIntake = rig().svc;
    expect(typeof g.handle).toBe('function');
  });

  it('allowlist: thiếu → null; nạp lại khi tệp đổi; xóa → null; mẫu hợp lệ', () => {
    const { svc, staff } = rig();
    expect(svc.staffCode(STAFF_UID)).toBeNull();
    writeStaff(staff);
    expect(svc.staffCode(STAFF_UID)).toBe('VT01');
    expect(svc.staffCode('khac')).toBeNull();
    expect(svc.staffCode('')).toBeNull();
    writeStaff(staff, [{ user_hash: uhash(STAFF_UID), ma_nv: 'VT-02-MOI' }]);
    const t = Date.now() / 1000 + 10;
    utimesSync(staff, t, t);
    expect(svc.staffCode(STAFF_UID)).toBe('VT-02-MOI');
    rmSync(staff);
    expect(svc.staffCode(STAFF_UID)).toBeNull();
    const sample = new GardenZaloService(null, { staffFile: dataPath('garden_staff.sample.json') });
    expect(sample.staffCode('0000000000000000000')).toBe('VT-MAU-01');
  });

  it('allowlist hỏng → không ai là nhân viên + cảnh báo', () => {
    const { svc, staff, log } = rig();
    writeFileSync(staff, '{');
    expect(svc.staffCode(STAFF_UID)).toBeNull();
    expect(log.join('\n')).toContain('không ai được nhận');
  });

  it('cảnh báo allowlist/plot_owners hỏng KHÔNG trích nội dung tệp (chỉ tên lỗi)', () => {
    // V8 JSON.parse trích một đoạn tệp vào thông điệp; Python JSONDecodeError chỉ có dòng/cột.
    const { svc, staff, log } = rig();
    writeFileSync(staff, '{"staff":[{"user_hash":"","ma_nv":VT-BI-MAT-01}]}');
    expect(svc.staffCode(STAFF_UID)).toBeNull();
    expect(log).toEqual([
      `[warn] garden: ${basename(staff)} hỏng (JSONDecodeError) — không ai được nhận là nhân viên vườn`,
    ]);
    const owners: string[] = [];
    plotOwners(staff, (x) => owners.push(x));
    writeFileSync(staff, Buffer.from([0xff, 0xfe, 0x7b]));
    plotOwners(staff, (x) => owners.push(x));
    expect(owners.join('\n')).not.toContain('BI-MAT');
    // byte UTF-8 hỏng: Python UnicodeDecodeError (trước đây TS in 'OSError' vì lỗi TextDecoder có `code`)
    expect(owners.map((x) => /\((\w+)\)/.exec(x)?.[1])).toEqual([
      'JSONDecodeError',
      'UnicodeDecodeError',
    ]);
  });

  it('cú pháp sai → HELP, không connect; tin không phải object → HELP', async () => {
    const pool = {
      connect: () => {
        throw new Error('không được connect');
      },
    };
    const { svc, staff } = rig(pool);
    writeStaff(staff);
    expect(await run(svc, 'user_send_text', { text: 'tưới' })).toBe(HELP);
    expect(await run(svc, 'user_send_text', {})).toBe(HELP);
    expect(await run(svc, 'user_send_text', 'khong-phai-dict')).toBe(HELP);
  });

  it('DB down → DB_DOWN', async () => {
    const { svc, staff } = rig({ connect: async () => Promise.reject(new Error('ECONNREFUSED')) });
    writeStaff(staff);
    expect(await run(svc, 'user_send_text', { text: 'KV-T01 tưới' })).toBe(DB_DOWN);
  });

  it('lỗi bất kỳ vẫn trả lời ERROR; log chỉ tên lỗi + uh=', async () => {
    const { svc, staff, log } = rig(
      noQueryPool(() => {
        throw new RangeError('STAFF_SECRET_DETAIL');
      }),
    );
    writeStaff(staff);
    settings.forceMode = null; // mode() đọc sổ → lỗi không phải DB → nổi lên
    expect(await run(svc, 'user_send_text', { text: 'KV-T01 tưới' })).toBe(ERROR);
    const out = log.join('\n');
    expect(out).toContain('RangeError');
    expect(out).not.toContain('STAFF_SECRET_DETAIL');
    expect(out).not.toContain(STAFF_UID);
    expect(out).toContain(`uh=${uhash(STAFF_UID)}`);
  });

  it('bị gỡ khỏi allowlist → ERROR; loại tin chưa nhận → UNSUPPORTED; video không tệp → NO_FILE', async () => {
    const { svc, staff } = rig(noQueryPool());
    expect(await run(svc, 'user_send_text', { text: 'KV-T01 tưới' })).toBe(ERROR);
    writeStaff(staff);
    for (const ev of ['user_send_sticker', 'user_send_file', 'user_send_location', 'user_send_gif'])
      expect(await run(svc, ev, {})).toBe(UNSUPPORTED);
    expect(await run(svc, 'user_send_video', {})).toBe(NO_FILE);
    expect(
      await run(svc, 'user_send_image', {
        attachments: [
          { type: 'image', payload: {} },
          'x',
          { type: 'audio', payload: { url: CDN } },
        ],
      }),
    ).toBe(NO_FILE);
  });

  it('ảnh: chưa cấu hình kho / kho trong repo → NO_STORE, không tải, không connect', async () => {
    const msg = { text: 'KV-T01', attachments: [{ type: 'image', payload: { url: CDN } }] };
    const pool = {
      connect: () => {
        throw new Error('không được connect');
      },
    };
    const a = rig(pool);
    writeStaff(a.staff);
    expect(await run(a.svc, 'user_send_image', msg)).toBe(NO_STORE);
    const b = rig(pool, { GARDEN_MEDIA_DIR: join(REPO_ROOT, 'data', 'kho') });
    writeStaff(b.staff);
    expect(await run(b.svc, 'user_send_image', msg)).toBe(NO_STORE);
  });

  it('tính năng TẮT (farming-01 chữ / farming-04 ảnh) → FEATURE_OFF, 0 truy vấn, 0 tải', async () => {
    settings.forceMode = 'tat';
    const { svc, staff, log } = rig(noQueryPool(), { GARDEN_MEDIA_DIR: join(tmp, 'kho-off') });
    writeStaff(staff);
    const t = await run(svc, 'user_send_text', { text: 'KV-T01 tưới 30 phút' });
    expect(t).toBe(FEATURE_OFF);
    expect(t).toContain('CHƯA ghi');
    expect(log.join('\n')).toMatch(/\[blocked\] garden: .*farming-01/);
    expect(
      await run(svc, 'user_send_image', {
        text: 'KV-T01',
        attachments: [{ type: 'image', payload: { url: CDN } }],
      }),
    ).toBe(FEATURE_OFF);
    expect(log.join('\n')).toMatch(/farming-04/);
    expect(
      await run(svc, 'user_send_voice', {
        attachments: [{ type: 'voice', payload: { url: CDN } }],
      }),
    ).toBe(FEATURE_OFF);
  });
});

// ------------------------------------------------------------ CLI zalo-garden

describe('CLI zalo-garden', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const noConnect = async () => {
    throw new Error('không được kết nối DB');
  };

  it('sai tham số → exit 2', async () => {
    for (const o of [
      {},
      { pending: true, hash: true },
      { done: '1' },
      { done: '1', log: '2' },
      { done: '1', log: '2', by: '  ' },
      { done: 'x' },
    ]) {
      expect(await zaloGardenMain(o, { connect: noConnect, io: io().io }), JSON.stringify(o)).toBe(
        2,
      );
    }
  });

  it('--hash đọc STDIN → user_hash; STDIN rỗng → exit 2', async () => {
    const c = io();
    expect(
      await zaloGardenMain({ hash: true }, { io: c.io, stdin: async () => `${STAFF_UID}\r` }),
    ).toBe(0);
    expect(c.out).toEqual([uhash(STAFF_UID)]);
    expect(await zaloGardenMain({ hash: true }, { io: io().io, stdin: async () => '' })).toBe(2);
  });

  it('DB down → exit 2', async () => {
    expect(
      await zaloGardenMain({ pending: true }, { connect: async () => null, io: io().io }),
    ).toBe(2);
  });

  it('--transcribe chưa có STT / provider lạ / whisper_local thiếu AI worker → [blocked] exit 2 TRƯỚC connect', async () => {
    for (const env of [
      {},
      { GARDEN_STT_PROVIDER: 'fpt-stt' },
      { GARDEN_STT_PROVIDER: 'whisper_local' },
    ]) {
      const c = io();
      expect(await zaloGardenMain({ transcribe: '1' }, { connect: noConnect, io: c.io, env })).toBe(
        2,
      );
      expect(c.err[0]).toMatch(/^\[blocked\]/);
      expect(c.err[0]).toContain('DPA');
    }
  });
});
