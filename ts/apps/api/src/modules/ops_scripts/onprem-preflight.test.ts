import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICES } from '@samsam/core/db';
import { REPO_ROOT } from '@samsam/core/paths';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CIPHER, MANIFEST_SUFFIX } from './backup.js';
import {
  checkBackup,
  checkDb,
  checkServices,
  checkTimers,
  preflightDeps,
  preflightMain,
} from './onprem-preflight.js';

// Dịch tests/test_r13_batch_c.py + tests/test_r13_fix4.py (preflight): chưa cấu hình = CHƯA SẴN SÀNG
// không connect; sao lưu đo tệp THẬT (dump + manifest local + offsite khớp size/sha, mã hóa, tuổi, sổ);
// timer systemd; DB test: db + login dịch vụ (đúng role / superuser / sai role).

const root = mkdtempSync(join(tmpdir(), 'ops-pf-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
afterEach(() => vi.restoreAllMocks());
const quiet = () => {};
const rows = (r: readonly (readonly [string, string, string])[]) =>
  Object.fromEntries(r.map(([k, s, note]) => [k, [s, note]]));

describe('preflight chưa cấu hình', () => {
  it('không biến nào → exit 1, CHƯA SẴN SÀNG + CHUA_XAC_NHAN, không kết nối DB', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await preflightMain({}, {})).toBe(1);
    const out = String(log.mock.calls[0]?.[0]);
    expect(out).toContain('CHƯA SẴN SÀNG');
    expect(out).toContain('CHUA_XAC_NHAN');
    expect(out).toContain('| db | CHUA_DAT | thiếu DATABASE_URL |');
    for (const { envVar } of Object.values(SERVICES)) expect(out).toContain(`thiếu ${envVar}`);
    expect(out).toContain('| sao_luu:cau_hinh | CHUA_DAT | thiếu BACKUP_DIR |');
  });

  it('--out ghi đúng nội dung in ra; ngưỡng sai → exit 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = join(fresh(), 'pf.md');
    expect(await preflightMain({ out: f }, {})).toBe(1);
    expect(readFileSync(f, 'utf8')).toMatch(
      /^# Preflight on-prem — .* \(machine-id .*\) · \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\n/,
    );
    for (const o of [
      { minFreeGb: '-1' },
      { maxBackupAgeH: '0' },
      { maxBackupAgeH: '-3' },
      { minFreeGb: 'abc' },
    ]) {
      expect(await preflightMain(o, {})).toBe(2);
    }
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[err] ngưỡng không hợp lệ');
  });

  it('DATABASE_URL thiếu dbname tường minh → CHUA_DAT không connect', async () => {
    expect(await checkDb({ DATABASE_URL: 'postgresql://u@h:5432' })).toEqual([
      'CHUA_DAT',
      'DATABASE_URL thiếu dbname tường minh',
      null,
    ]);
  });
});

describe('sao lưu đo tệp THẬT', () => {
  it('r13 batch c: mã hóa bắt buộc, offsite cùng thiết bị, sổ + manifest tối giản KHÔNG đủ', () => {
    const t = fresh();
    const passf = join(t, 'khoa.txt');
    writeFileSync(passf, 'mot-khoa-thu-du-dai-123\n');
    const bdir = join(t, 'b');
    mkdirSync(bdir);
    const env = {
      BACKUP_DIR: bdir,
      BACKUP_PASSPHRASE_FILE: passf,
      BACKUP_REQUIRE_ENCRYPTION: '1',
      BACKUP_OFFSITE: `dir:${join(t, 'o')}`,
    };
    const now = new Date();
    let r = rows(checkBackup(env, 0, 26, now, quiet));
    expect(r['sao_luu:ma_hoa_bat_buoc']?.[0]).toBe('DAT');
    expect(r['sao_luu:offsite']?.[0]).toBe('CHUA_DAT'); // cùng thiết bị tmp
    expect(r['sao_luu:ban_gan_nhat']?.[0]).toBe('CHUA_DAT'); // chưa có bản nào
    writeFileSync(join(bdir, 'x.dump.enc'), 'x');
    writeFileSync(join(bdir, `x.dump.enc${MANIFEST_SUFFIX}`), JSON.stringify({ encrypted: true }));
    const rec: Record<string, unknown> = {
      ts: new Date(now.getTime() - 2 * 3600_000).toISOString(),
      status: 'ok',
      file: 'x.dump.enc',
      offsite: { dir: 'o' },
    };
    writeFileSync(join(bdir, 'backup_runs.jsonl'), `${JSON.stringify(rec)}\n`);
    r = rows(checkBackup(env, 0, 26, now, quiet));
    expect(r['sao_luu:ban_gan_nhat']?.[0]).toBe('CHUA_DAT');
    const name = 'db_20261024_080000_vn.dump.enc';
    const dump = Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(64)]);
    const man = {
      format: 1,
      created_at: new Date(now.getTime() - 2 * 3600_000).toISOString(),
      db_name: 'db',
      server_version: '17',
      pg_dump_version: '17',
      tool: 'local',
      file: name,
      size_bytes: dump.length,
      sha256: createHash('sha256').update(dump).digest('hex'),
      encrypted: true,
      cipher: CIPHER,
      row_counts: {},
    };
    mkdirSync(join(t, 'o'));
    for (const folder of [bdir, join(t, 'o')]) {
      writeFileSync(join(folder, name), dump);
      writeFileSync(join(folder, name + MANIFEST_SUFFIX), JSON.stringify(man));
    }
    Object.assign(rec, { file: name, offsite: 'dir' });
    writeFileSync(join(bdir, 'backup_runs.jsonl'), `${JSON.stringify(rec)}\n`);
    expect(rows(checkBackup(env, 0, 26, now, quiet))['sao_luu:ban_gan_nhat']?.[0]).toBe('DAT');
    expect(rows(checkBackup(env, 0, 1, now, quiet))['sao_luu:ban_gan_nhat']?.[0]).toBe('CHUA_DAT'); // quá tuổi
  });

  const NAME = 'fix4_db_20261024_080000_vn.dump.enc';
  const DUMP = Buffer.concat([Buffer.from('Salted__'), randomBytes(32)]);
  const BAD = Buffer.from(DUMP);
  BAD[7] = (BAD[7] as number) ^ 1;

  type Kw = {
    local?: boolean;
    localBytes?: Buffer;
    off?: boolean;
    offBytes?: Buffer;
    offManifest?: boolean;
    manifest?: Record<string, unknown>;
    ageH?: number;
    status?: string;
    offsiteCfg?: boolean;
    encrypted?: boolean;
  };
  function backup(kw: Kw) {
    const t = fresh();
    const now = new Date();
    const [b, o] = [join(t, 'b'), join(t, 'o')];
    mkdirSync(b);
    mkdirSync(o);
    const kf = join(t, 'khoa.txt');
    writeFileSync(kf, 'mot-khoa-thu-du-dai-123\n');
    const ageH = kw.ageH ?? 2;
    const at = new Date(now.getTime() - ageH * 3600_000).toISOString();
    const m = kw.manifest ?? {
      format: 1,
      created_at: at,
      db_name: 'fix4_db',
      server_version: '17',
      pg_dump_version: '17',
      tool: 'local',
      file: NAME,
      size_bytes: DUMP.length,
      sha256: createHash('sha256').update(DUMP).digest('hex'),
      encrypted: kw.encrypted ?? true,
      cipher: CIPHER,
      row_counts: {},
    };
    if (kw.local ?? true) writeFileSync(join(b, NAME), kw.localBytes ?? DUMP);
    writeFileSync(join(b, NAME + MANIFEST_SUFFIX), JSON.stringify(m));
    if (kw.off ?? true) writeFileSync(join(o, NAME), kw.offBytes ?? DUMP);
    if (kw.offManifest ?? true) writeFileSync(join(o, NAME + MANIFEST_SUFFIX), JSON.stringify(m));
    writeFileSync(
      join(b, 'backup_runs.jsonl'),
      `${JSON.stringify({ ts: at, status: kw.status ?? 'ok', file: NAME, sha256: createHash('sha256').update(DUMP).digest('hex'), offsite: 'dir' })}\n`,
    );
    const env: Record<string, string> = {
      BACKUP_DIR: b,
      BACKUP_PASSPHRASE_FILE: kf,
      BACKUP_REQUIRE_ENCRYPTION: '1',
    };
    if (kw.offsiteCfg ?? true) env.BACKUP_OFFSITE = `dir:${o}`;
    return { env, now };
  }

  it.for([
    [{}, 'DAT'],
    [{ local: false }, 'thiếu tệp dump'],
    [{ localBytes: BAD }, 'sha256 tệp dump lệch'],
    [{ localBytes: Buffer.concat([DUMP, Buffer.from('x')]) }, 'kích thước'],
    [{ off: false }, 'offsite: thiếu tệp dump'],
    [{ offBytes: BAD }, 'offsite: sha256'],
    [{ offManifest: false }, 'offsite: manifest'],
    [{ manifest: { encrypted: true } }, 'manifest local thiếu/hỏng'],
    [{ encrypted: false }, 'chưa mã hóa'],
    [{ ageH: -5 }, 'tương lai'],
    [{ status: 'fail' }, 'status=fail'],
    [{ offsiteCfg: false }, 'chưa cấu hình offsite'],
  ] as [Kw, string][])('r13-fix4 bản gần nhất %o → %s', ([kw, want]) => {
    // GIẢ LẬP khác thiết bị — không phải offsite thật.
    vi.spyOn(preflightDeps, 'sameDevice').mockReturnValue(false);
    const { env, now } = backup(kw);
    const [st, note] = rows(checkBackup(env, 0, 26, now, quiet))['sao_luu:ban_gan_nhat'] as [
      string,
      string,
    ];
    if (want === 'DAT') expect(st, note).toBe('DAT');
    else {
      expect(st).toBe('CHUA_DAT');
      expect(note).toContain(want);
    }
  });

  it('quá tuổi → "cách 3.0 giờ"', () => {
    vi.spyOn(preflightDeps, 'sameDevice').mockReturnValue(false);
    const { env, now } = backup({ ageH: 3 });
    const [st, note] = rows(checkBackup(env, 0, 1, now, quiet))['sao_luu:ban_gan_nhat'] as [
      string,
      string,
    ];
    expect(st).toBe('CHUA_DAT');
    expect(note).toContain('cách 3.0 giờ');
  });

  it('dung lượng trống dưới ngưỡng → thu_muc CHUA_DAT', () => {
    const { env, now } = backup({});
    const [st, note] = rows(checkBackup(env, 1e12, 26, now, quiet))['sao_luu:thu_muc'] as [
      string,
      string,
    ];
    expect(st).toBe('CHUA_DAT');
    expect(note).toMatch(/^tồn tại\+ghi được: True; trống \d+\.\d GB \(cần ≥ 1e\+12\)$/);
  });
});

describe('lịch systemd', () => {
  it('không phải Linux → KHONG_AP_DUNG', () => {
    expect(checkTimers('win32')).toEqual([
      'lich:systemd',
      'KHONG_AP_DUNG',
      'hệ điều hành Windows — không phải server systemd',
    ]);
  });

  it('Linux: đếm timer thiếu theo deploy/onprem/jobs.json', () => {
    const etc = fresh();
    const r = checkTimers('linux', etc);
    expect(r[1]).toBe('CHUA_DAT');
    expect(r[2]).toMatch(/^thiếu \d+ timer: /);
    const jobs = JSON.parse(
      readFileSync(join(REPO_ROOT, 'deploy', 'onprem', 'jobs.json'), 'utf8'),
    ).jobs;
    for (const k of Object.keys(jobs).filter((x) => !x.startsWith('_')))
      writeFileSync(join(etc, `samsam-job-${k}.timer`), '');
    expect(checkTimers('linux', etc)).toEqual(['lich:systemd', 'DAT', 'đủ timer']);
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('preflight trên DB test', () => {
  const name = testDbName('ops_pf');
  const login = `t_pf_job_${process.pid}`;
  const pw = `p${randomBytes(8).toString('hex')}`;
  let dsn = '';
  beforeAll(async () => {
    dsn = await createDbFromTemplate(name);
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password '${pw}' in role svc_job`);
  });
  afterAll(async () => {
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
  });

  it('db: kết nối được + major server; host chết → OperationalError', async () => {
    const [st, note, major] = await checkDb({ DATABASE_URL: dsn, PATH: process.env.PATH });
    expect(major).toBe(17);
    expect(note).toMatch(/^server PG 17; pg_dump: /);
    expect(['DAT', 'CHUA_DAT']).toContain(st);
    expect(await checkDb({ DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' })).toEqual([
      'CHUA_DAT',
      'không kết nối được (OperationalError)',
      null,
    ]);
  });

  it('dịch vụ: login riêng đúng role → DAT; superuser → CHUA_DAT; sai role → CHUA_DAT', async () => {
    const u = new URL(dsn);
    u.username = login;
    u.password = pw;
    const r = rows(
      await checkServices({
        JOB_DATABASE_URL: u.toString(),
        WEBHOOK_DATABASE_URL: u.toString(),
        LOADER_DATABASE_URL: dsn,
      }),
    );
    expect(r['dich_vu:job']).toEqual(['DAT', 'JOB_DATABASE_URL: login riêng thuộc svc_job']);
    expect(r['dich_vu:webhook']).toEqual([
      'CHUA_DAT',
      'WEBHOOK_DATABASE_URL: login không thuộc role svc_webhook',
    ]);
    expect(r['dich_vu:loader']?.[0]).toBe('CHUA_DAT');
    expect(r['dich_vu:loader']?.[1]).toMatch(/^LOADER_DATABASE_URL: login Postgres là SUPERUSER/);
    expect(r['dich_vu:backup']).toEqual(['CHUA_DAT', 'thiếu BACKUP_DATABASE_URL']);
    expect(r['dich_vu:ui']).toEqual(['CHUA_DAT', 'thiếu UI_DATABASE_URL']); // TS thêm: login web/API
  });
});
