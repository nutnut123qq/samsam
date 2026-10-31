import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { REPO_ROOT } from '@samsam/core/paths';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io } from './common.js';
import {
  ACTOR,
  loadConfig,
  purgeItem,
  RetentionError,
  retentionDeps,
  retentionMain,
} from './retention-purge.js';

// Dịch tests/test_v13_c05_media.py (phần hạn lưu): cấu hình (không bịa TTL), TTL null = không xóa +
// không DB, cấu hình hỏng exit 2; DB test: log COMMIT trước khi xóa, log lỗi = 0 xóa, kho trong repo bị
// từ chối, ảnh gắn lô QR + ảnh mới giữ lại, ghi âm chỉ xóa nháp đã chép lời.

const root = mkdtempSync(join(tmpdir(), 'ops-ret-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
afterEach(() => vi.restoreAllMocks());

const items = (ttl = 30) =>
  Object.fromEntries(loadConfig().map((it) => [it.id, { ...it, ttl_days: ttl }]));

describe('cấu hình hạn lưu', () => {
  it('tệp repo hợp lệ, có owner, KHÔNG bịa TTL (mọi mục null tới khi người có thẩm quyền chốt)', () => {
    const its = loadConfig();
    expect(new Set(its.map((i) => i.id))).toEqual(
      new Set(['hr_cv', 'hr_attendance', 'garden_media', 'garden_voice']),
    );
    for (const it of its) {
      expect(it.owner).toBeTruthy();
      expect(it.ttl_days, it.id).toBeNull();
    }
  });

  it.for([
    { muc: [] },
    { muc: [{ id: 'a', ttl_days: 0, kho: { loai: 'khong_luu_ban_sao' } }] },
    { muc: [{ id: 'a', ttl_days: true, kho: { loai: 'khong_luu_ban_sao' } }] },
    { muc: [{ id: 'a', ttl_days: '30', kho: { loai: 'khong_luu_ban_sao' } }] },
    { muc: [{ id: 'a', ttl_days: null, kho: { loai: 'x' } }] },
    { muc: [{ id: 'a', ttl_days: 5, kho: { loai: 'thu_muc', env: 'E' } }] },
    {
      muc: [
        { id: 'a', ttl_days: null, kho: { loai: 'khong_luu_ban_sao' } },
        { id: 'a', ttl_days: null, kho: { loai: 'khong_luu_ban_sao' } },
      ],
    },
  ])('hỏng %# → RetentionError', (bad) => {
    const p = join(fresh(), 'r.json');
    writeFileSync(p, JSON.stringify(bad));
    expect(() => loadConfig(p)).toThrow(RetentionError);
  });

  it('mọi TTL null → in 4 cảnh báo CHƯA CHỐT + [blocked], exit 0, KHÔNG connect DB', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const connect = vi.fn(async () => {
      throw new Error('không được connect');
    });
    expect(await retentionMain({}, { connect })).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out.match(/CHƯA CHỐT/g)).toHaveLength(4);
    expect(out).toContain('[blocked]');
    expect(connect).not.toHaveBeenCalled();
  });

  it('cấu hình hỏng → exit 2, không connect', async () => {
    const p = join(fresh(), 'r.json');
    writeFileSync(p, '{');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const connect = vi.fn();
    expect(await retentionMain({}, { config: p, connect })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^\[err\] .* — không xóa gì$/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('có TTL nhưng DB không kết nối được → exit 2, 0 xóa (cần ghi log trước khi xóa)', async () => {
    const t = fresh();
    const cfg = join(t, 'r.json');
    const inbox = join(t, 'hr');
    mkdirSync(inbox);
    const f = join(inbox, 'a.txt');
    writeFileSync(f, 'cv');
    utimesSync(f, new Date(0), new Date(0));
    writeFileSync(
      cfg,
      JSON.stringify({
        muc: [
          {
            id: 'hr_cv',
            ttl_days: 30,
            kho: { loai: 'thu_muc', env: 'HR_INBOX_DIR', duoi: ['.txt'] },
          },
        ],
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await retentionMain(
        {},
        { config: cfg, env: { HR_INBOX_DIR: inbox }, connect: async () => null },
      ),
    ).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('không kết nối được Postgres');
    expect(existsSync(f)).toBe(true);
  });
});

const old = (p: string, days: number) => {
  const t = new Date(Date.now() - days * 86_400_000);
  utimesSync(p, t, t);
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
/** Python `garden_media.store`: `<kho>/<sha[:2]>/<sha>.<ext>`. */
function storeFile(base: string, body: string, ext: string): string {
  const s = sha(body);
  mkdirSync(join(base, s.slice(0, 2)), { recursive: true });
  writeFileSync(join(base, s.slice(0, 2), `${s}.${ext}`), body);
  return s;
}
const filesIn = (d: string): string[] =>
  existsSync(d)
    ? readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name.replace(/\.[^.]+$/, ''))
        .sort()
    : [];

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('retention_purge trên DB test', () => {
  const name = testDbName('ops_ret');
  let pool: pg.Pool;
  const plot = `KV-T${process.pid}${randomBytes(2).toString('hex')}`;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
    await pool.query("insert into plots (id, location, source) values ($1, 'Trà My', 'manual')", [
      plot,
    ]);
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });

  it('CV thư mục: dry-run chỉ đếm; chạy thật ghi log (không tên file/PII) TRƯỚC rồi mới xóa; bỏ đuôi lạ + thư mục con', async () => {
    const inbox = join(fresh(), 'hr');
    mkdirSync(join(inbox, 'sub'), { recursive: true });
    const [oldF, newF] = [join(inbox, 'a.txt'), join(inbox, 'b.md')];
    for (const f of [oldF, newF, join(inbox, 'c.pdf'), join(inbox, 'sub', 'd.txt')]) {
      writeFileSync(f, 'CV Nguyễn Văn Mẫu 0905123456');
    }
    for (const f of [oldF, join(inbox, 'c.pdf'), join(inbox, 'sub', 'd.txt')]) old(f, 40);
    const env = { HR_INBOX_DIR: inbox };
    const it = items().hr_cv as never;
    expect((await purgeItem(pool, it, new Date(), true, env)).n).toBe(1);
    expect(existsSync(oldF)).toBe(true);
    const r = await purgeItem(pool, it, new Date(), false, env);
    expect([r.n, r.deleted, r.failed]).toEqual([1, 1, 0]);
    expect(existsSync(oldF)).toBe(false);
    expect(existsSync(newF)).toBe(true);
    expect(existsSync(join(inbox, 'c.pdf'))).toBe(true);
    expect(existsSync(join(inbox, 'sub', 'd.txt'))).toBe(true);
    const { rows } = await pool.query(
      "select action, object_id, detail from agent_action_log where actor = $1 and object_id = 'hr_cv' order by id",
      [ACTOR],
    );
    expect(rows).toHaveLength(1);
    expect([rows[0].action, rows[0].object_id, rows[0].detail.n, rows[0].detail.ttl_days]).toEqual([
      'retention_purge',
      'hr_cv',
      1,
      30,
    ]);
    const blob = JSON.stringify(rows[0].detail);
    expect(blob).not.toContain('a.txt');
    expect(blob).not.toContain('Nguyễn');
    expect(rows[0].detail.sha12).toEqual([sha('CV Nguyễn Văn Mẫu 0905123456').slice(0, 12)]);
  });

  it('ghi log lỗi → nổi lỗi, KHÔNG xóa file nào', async () => {
    const inbox = join(fresh(), 'hr');
    mkdirSync(inbox);
    const f = join(inbox, 'a.txt');
    writeFileSync(f, 'cv');
    old(f, 40);
    vi.spyOn(retentionDeps, 'log').mockRejectedValue(
      Object.assign(new Error('no'), { code: '42501' }),
    );
    await expect(
      purgeItem(pool, items().hr_cv as never, new Date(), false, { HR_INBOX_DIR: inbox }),
    ).rejects.toThrow('no');
    expect(existsSync(f)).toBe(true);
  });

  it('kho nằm trong repo → RetentionError "trong repo" (kể cả dry-run)', async () => {
    await expect(
      purgeItem(pool, items().garden_media as never, new Date(), true, {
        GARDEN_MEDIA_DIR: join(REPO_ROOT, 'data'),
      }),
    ).rejects.toThrow(/trong repo/);
  });

  it('ảnh vườn: chỉ xóa ảnh quá hạn KHÔNG gắn lô QR; ảnh mới + ảnh gắn lô giữ; metadata DB giữ nguyên', async () => {
    const store = join(fresh(), 'kho');
    const shas: Record<string, string> = {};
    for (const [nm, age] of [
      ['old', 40],
      ['linked', 40],
      ['new', 1],
    ] as const) {
      const s = storeFile(store, `${nm}-${plot}`, 'jpg');
      shas[nm] = s;
      await pool.query(
        "insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author, created_at) values ($1, 'jpg', 3, $2, '2026-09-01', 'a', now() - $3::int * interval '1 day')",
        [s, plot, age],
      );
    }
    const lot = `LOT-${plot}`;
    await pool.query(
      "insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, source) values ($1, 'x', '2026-09-01', '2027-09-01', 1, 'manual')",
      [lot],
    );
    const lid = (
      await pool.query(
        "insert into plot_logs (plot_id, ts, activity, source) values ($1, now(), 'thu hoạch', 'manual') returning id",
        [plot],
      )
    ).rows[0].id;
    await pool.query(
      "insert into lot_origins (lot_code, plot_log_id, media_sha256, linked_by) values ($1, $2, $3, 'A')",
      [lot, lid, [shas.linked]],
    );
    const before = Number((await pool.query('select count(*) as n from garden_media')).rows[0].n);
    const r = await purgeItem(pool, items().garden_media as never, new Date(), false, {
      GARDEN_MEDIA_DIR: store,
    });
    expect([r.n, r.deleted]).toEqual([1, 1]);
    expect(filesIn(store)).toEqual([shas.linked, shas.new].sort());
    expect(Number((await pool.query('select count(*) as n from garden_media')).rows[0].n)).toBe(
      before,
    );
  });

  it('ghi âm: chỉ xóa nháp ĐÃ chép lời; nháp chưa chép quá hạn → cảnh báo, không xóa', async () => {
    const store = join(fresh(), 'kho');
    const lid = (
      await pool.query(
        "insert into plot_logs (plot_id, ts, activity, source) values ($1, now(), 'tưới', 'manual') returning id",
        [plot],
      )
    ).rows[0].id;
    const rows: Record<string, string> = {};
    for (const [nm, done] of [
      ['da', true],
      ['chua', false],
    ] as const) {
      const s = storeFile(join(store, 'audio'), `voice-${nm}-${plot}`, 'aac');
      rows[nm] = s;
      await pool.query(
        "insert into garden_voice_drafts (sha256, ext, bytes, staff_code, status, plot_log_id, closed_by, closed_at, received_at) values ($1, 'aac', 5, 'VT01', $2, $3, $4, $5, now() - interval '40 days')",
        [
          s,
          done ? 'da_chep_loi' : 'cho_chep_loi',
          done ? lid : null,
          done ? 'A' : null,
          done ? new Date() : null,
        ],
      );
    }
    const r = await purgeItem(pool, items().garden_voice as never, new Date(), false, {
      GARDEN_MEDIA_DIR: store,
    });
    expect([r.deleted, r.pending_voice]).toEqual([1, 1]);
    expect(filesIn(join(store, 'audio'))).toEqual([rows.chua]);
  });

  it('main: xóa lỗi từng file → log retention_purge_failed + exit 1; dry-run in "sẽ xóa"', async () => {
    const t = fresh();
    const inbox = join(t, 'hr');
    mkdirSync(inbox);
    for (const x of ['a.txt', 'b.txt']) {
      writeFileSync(join(inbox, x), `cv-${x}-${plot}`);
      old(join(inbox, x), 40);
    }
    const cfg = join(t, 'r.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        muc: [
          {
            id: 'cv_test',
            ttl_days: 30,
            kho: { loai: 'thu_muc', env: 'HR_INBOX_DIR', duoi: ['.TXT'] },
          },
        ],
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = { config: cfg, env: { HR_INBOX_DIR: inbox }, connect: async () => pool };
    expect(await retentionMain({ dryRun: true }, deps)).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      '[cv_test] sẽ xóa 2/2 file quá 30 ngày',
    );
    const real = io.unlink;
    vi.spyOn(io, 'unlink').mockImplementation((p) => {
      if (p.endsWith('b.txt'))
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      real(p);
    });
    expect(await retentionMain({}, deps)).toBe(1);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(
      '[cv_test] đã xóa 1/2 file quá 30 ngày, lỗi 1',
    );
    const acts = (
      await pool.query(
        "select action, detail from agent_action_log where actor = $1 and object_id = 'cv_test' order by id",
        [ACTOR],
      )
    ).rows;
    expect(acts.map((a) => [a.action, a.detail.n])).toEqual([
      ['retention_purge', 2],
      ['retention_purge_failed', 1],
    ]);
    expect(existsSync(join(inbox, 'b.txt'))).toBe(true);
  });
});
