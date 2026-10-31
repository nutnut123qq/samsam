import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '@samsam/core/paths';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  applyRetention,
  backupDeps,
  backupMain,
  checkPassfile,
  findTool,
  loadManifest,
  MANIFEST_SUFFIX,
  readConfig,
  resolveTool,
  settings,
  toolArgv,
  validManifests,
} from './backup.js';
import { CONNECT_TIMEOUT_S, io, pgEnv, scrub, UsageError } from './common.js';
import { decrypt, guardName, Refuse } from './restore-drill.js';

// Dịch tests/test_db_backup.py (phần unit) + tests/test_r13_batch_c.py (cờ r13). Không DB, không
// subprocess thật: `io.run`/`io.which` giả. E2E pg_dump thật ở backup.db.test.ts.

const root = mkdtempSync(join(tmpdir(), 'ops-bk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(root, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const exe = (s: string) => s + (process.platform === 'win32' ? '.exe' : '');
const posix = (p: string) => p.replaceAll('\\', '/');

afterEach(() => vi.restoreAllMocks());

describe('usage exit 2 TRƯỚC khi connect', () => {
  const cases: Record<string, string>[] = [
    {},
    { BACKUP_DIR: join(REPO_ROOT, 'backups') },
    { BACKUP_KEEP: '0' },
    { BACKUP_KEEP: '-1' },
    { BACKUP_KEEP: 'abc' },
    { BACKUP_OFFSITE: `dir:${join(REPO_ROOT, 'off')}` },
    { BACKUP_OFFSITE: 'ftp://x' },
    { BACKUP_PASSPHRASE_FILE: join(REPO_ROOT, 'AGENTS.md') },
    { BACKUP_REQUIRE_ENCRYPTION: '1' },
  ];
  it.each(cases.map((c, i) => [i, c] as const))('ca %i', async (_i, env) => {
    const run = vi.spyOn(backupDeps, 'runBackup').mockImplementation(() => {
      throw new Error('không được connect khi usage sai');
    });
    const full: Record<string, string> = Object.keys(env).length
      ? { BACKUP_DIR: join(fresh(), 'bk'), ...env }
      : {};
    full.DATABASE_URL = 'postgresql://u@10.255.255.1:5432/x';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await backupMain(full)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([s]) => String(s).startsWith('[usage] '))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'backups'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'off'))).toBe(false);
  });

  it('TS không nạp .env: thiếu BACKUP_DIR trong env tiến trình = usage (dù .env repo có gì)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = vi.spyOn(backupDeps, 'runBackup');
    expect(await backupMain({ DATABASE_URL: 'postgresql://u@h/x' })).toBe(2);
    expect(log).toHaveBeenCalledWith('[usage] thiếu BACKUP_DIR');
    expect(run).not.toHaveBeenCalled();
  });

  it('thiếu DATABASE_URL → exit 1 + dòng fail trong backup_runs.jsonl', async () => {
    const d = join(fresh(), 'bk');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await backupMain({ BACKUP_DIR: d })).toBe(1);
    const rec = JSON.parse(readFileSync(join(d, 'backup_runs.jsonl'), 'utf8').trim());
    expect(rec).toMatchObject({ status: 'fail', error: 'thiếu DATABASE_URL', file: null });
  });

  it('cấu hình hợp lệ → runBackup nhận cấu hình đã chuẩn hóa + nhật ký 1 dòng', async () => {
    const t = fresh();
    const pf = join(t, 'pass.txt');
    writeFileSync(pf, 'dung-passphrase-test-dai\n');
    const seen: unknown[] = [];
    vi.spyOn(backupDeps, 'runBackup').mockImplementation(async (cfg) => {
      seen.push(cfg);
      return [0, { status: 'ok' } as never];
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = {
      BACKUP_DIR: join(t, 'bk'),
      BACKUP_PASSPHRASE_FILE: pf,
      BACKUP_OFFSITE: `dir:${join(t, 'off')}`,
      BACKUP_KEEP: '5',
      DATABASE_URL: 'postgresql://u@10.255.255.1:5432/x',
    };
    expect(await backupMain(env)).toBe(0);
    expect(seen[0]).toMatchObject({ keep: 5, offsite: ['dir', expect.stringContaining('off')] });
    expect(readFileSync(join(t, 'bk', 'backup_runs.jsonl'), 'utf8')).toBe('{"status": "ok"}\n');
  });
});

describe('công cụ Postgres', () => {
  it('find_tool theo thứ tự PG_BIN → Debian → bộ cài Windows → PATH → docker -alpine → docker', async () => {
    const t = fresh();
    const pgbin = join(t, 'pgbin');
    mkdirSync(pgbin);
    writeFileSync(join(pgbin, exe('pg_dump')), '');
    const deb = join(t, 'deb');
    const base = join(t, 'PostgreSQL');
    for (const b of [deb, base]) {
      mkdirSync(join(b, '17', 'bin'), { recursive: true });
      writeFileSync(join(b, '17', 'bin', exe('pg_dump')), '');
    }
    const old = [settings.pgDebBase, settings.pgWinBase] as const;
    settings.pgDebBase = deb;
    settings.pgWinBase = base;
    onTestFinished(() => {
      [settings.pgDebBase, settings.pgWinBase] = old;
    });
    let onPath: string | null = '/usr/bin/pg_dump';
    const images = new Set(['postgres:16-alpine', 'postgres:16']);
    vi.spyOn(io, 'which').mockImplementation((name) => (name === 'docker' ? 'docker' : onPath));
    vi.spyOn(io, 'run').mockImplementation(async (argv) => ({
      code: argv.slice(1, 3).join(' ') === 'image inspect' && images.has(argv[3] as string) ? 0 : 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const quiet = () => {};
    expect(await findTool('pg_dump', 17, { PG_BIN: pgbin }, quiet)).toEqual([
      'native',
      posix(join(pgbin, exe('pg_dump'))),
    ]);
    expect(await findTool('pg_dump', 17, {}, quiet)).toEqual([
      'native',
      posix(join(deb, '17', 'bin', exe('pg_dump'))),
    ]);
    rmSync(join(deb, '17', 'bin', exe('pg_dump')));
    expect(await findTool('pg_dump', 17, {}, quiet)).toEqual([
      'native',
      posix(join(base, '17', 'bin', exe('pg_dump'))),
    ]);
    expect(await findTool('pg_dump', 16, {}, quiet)).toEqual(['native', '/usr/bin/pg_dump']);
    onPath = null;
    expect(await findTool('pg_dump', 16, {}, quiet)).toEqual(['docker', 'postgres:16-alpine']);
    images.delete('postgres:16-alpine');
    expect(await findTool('pg_dump', 16, {}, quiet)).toEqual(['docker', 'postgres:16']);
    images.clear();
    expect(await findTool('pg_dump', 16, {}, quiet)).toBeNull();
    // PG_BIN sai → cảnh báo rồi thử cách khác
    const warn: string[] = [];
    await findTool('pg_dump', 17, { PG_BIN: join(t, 'khong-co') }, (s) => warn.push(s));
    expect(warn[0]).toMatch(/^\[warn\] PG_BIN không có pg_dump/);
  });

  describe('resolveTool chọn đúng major server (r22: CI r21 pg_restore mới hơn → SET transaction_timeout)', () => {
    // PATH có pg_restore 17 (mới hơn server 16); docker có thể có postgres:16-alpine.
    const setup = () => {
      const t = fresh();
      const old = [settings.pgDebBase, settings.pgWinBase] as const;
      settings.pgDebBase = join(t, 'deb');
      settings.pgWinBase = join(t, 'win');
      onTestFinished(() => {
        [settings.pgDebBase, settings.pgWinBase] = old;
      });
      const st = {
        images: new Set(['postgres:16-alpine']),
        inspected: [] as string[],
        log: [] as string[],
      };
      vi.spyOn(io, 'which').mockImplementation((name) =>
        name === 'docker' ? 'docker' : `/usr/bin/${name}`,
      );
      vi.spyOn(io, 'run').mockImplementation(async (argv) => {
        st.inspected.push(argv[3] as string);
        return {
          code: st.images.has(argv[3] as string) ? 0 : 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      });
      const majors: Record<string, number> = {
        '/usr/bin/pg_restore': 17,
        'postgres:16-alpine': 16,
      };
      vi.spyOn(settings, 'toolMajor').mockImplementation(async (tool, name) => {
        const m = majors[tool[1]] ?? 18;
        return [m, `${name} ${m}`];
      });
      return { t, st, log: (s: string) => st.log.push(s) };
    };

    it('PATH mới hơn + docker đúng major → docker, không cảnh báo', async () => {
      const { st, log } = setup();
      expect(await resolveTool('pg_restore', 16, {}, log)).toEqual([
        ['docker', 'postgres:16-alpine'],
        'pg_restore 16',
      ]);
      expect(st.log).toEqual([]);
    });

    it('chỉ có PATH mới hơn → PATH + [warn]', async () => {
      const { st, log } = setup();
      st.images.clear();
      const [tool] = await resolveTool('pg_restore', 16, {}, log);
      expect(tool).toEqual(['native', '/usr/bin/pg_restore']);
      expect(st.log.join('\n')).toMatch(/^\[warn\].*major 17/);
    });

    it('cùng major trên PATH → không kiểm image docker (sinh lười)', async () => {
      const { st, log } = setup();
      vi.spyOn(settings, 'toolMajor').mockResolvedValue([16, 'pg_restore 16']);
      expect((await resolveTool('pg_restore', 16, {}, log))[0]).toEqual([
        'native',
        '/usr/bin/pg_restore',
      ]);
      expect(st.inspected).toEqual([]);
    });

    it('PG_BIN luôn thắng (khác major chỉ cảnh báo, thấp hơn server → lỗi)', async () => {
      const { t, st, log } = setup();
      const pgbin = join(t, 'pgbin');
      mkdirSync(pgbin);
      writeFileSync(join(pgbin, exe('pg_restore')), '');
      const [tool, text] = await resolveTool('pg_restore', 16, { PG_BIN: pgbin }, log);
      expect(tool).toEqual(['native', posix(join(pgbin, exe('pg_restore')))]);
      expect(text).toBe('pg_restore 18');
      expect(st.log.join('\n')).toMatch(/^\[warn\] PG_BIN/);
      expect(st.inspected).toEqual([]);
      vi.spyOn(settings, 'toolMajor').mockResolvedValue([15, '15']);
      await expect(resolveTool('pg_restore', 16, { PG_BIN: pgbin }, log)).rejects.toThrow(
        /major 15 < server 16/,
      );
    });

    it('không có ứng viên ≥ server → lỗi', async () => {
      const { st, log } = setup();
      vi.spyOn(settings, 'toolMajor').mockResolvedValue([15, '15']);
      await expect(resolveTool('pg_restore', 16, {}, log)).rejects.toThrow(/major 15 < server 16/);
      vi.spyOn(io, 'which').mockReturnValue(null);
      st.images.clear();
      await expect(resolveTool('pg_restore', 16, {}, log)).rejects.toThrow(
        /không tìm thấy pg_restore/,
      );
    });
  });

  it('argv docker không chứa mật khẩu; PG* qua env; host local → host.docker.internal', () => {
    const env = pgEnv('postgresql://usr:s3cretPW@localhost:5432/db1', null, {});
    const argv = toolArgv(['docker', 'postgres:17-alpine'], 'pg_dump', ['-Fc'], env);
    expect(argv).toContain('PGHOST=host.docker.internal');
    // r22: docker engine Linux (runner/on-prem) không tự có tên này
    const addHost = '--add-host=host.docker.internal:host-gateway';
    expect(argv).toContain(addHost);
    expect(argv.indexOf('postgres:17-alpine')).toBeGreaterThan(argv.indexOf(addHost));
    const remote = pgEnv('postgresql://u:p@db.example.vn:5432/db1', null, {});
    const remoteArgv = toolArgv(['docker', 'postgres:17-alpine'], 'pg_dump', ['-Fc'], remote);
    expect(remoteArgv.some((a) => a.startsWith('--add-host'))).toBe(false);
    expect(argv[argv.indexOf('PGPASSWORD') - 1]).toBe('-e');
    expect(argv.join(' ')).not.toContain('s3cretPW');
    expect(argv).not.toContain('usr');
    expect(env.PGPASSWORD).toBe('s3cretPW');
    expect(env.PGCONNECT_TIMEOUT).toBe(String(CONNECT_TIMEOUT_S));
    expect(toolArgv(['native', '/x/pg_dump'], 'pg_dump', ['-Fc'], env).join(' ')).not.toContain(
      's3cretPW',
    );
  });

  it('scrub che mật khẩu/user/host/DSN', () => {
    const dsn = 'postgresql://bkuser:s3cretPW@db.example.vn:5432/samsam';
    const out = scrub(`connection to "db.example.vn" user "bkuser" pw s3cretPW dsn ${dsn}`, dsn);
    for (const s of ['s3cretPW', 'bkuser', 'db.example.vn', 'postgresql://']) {
      expect(out).not.toContain(s);
    }
  });

  it('không có thư viện mạng trong backup (offsite chỉ thư mục; s3 = external-dep)', () => {
    const src = readFileSync(join(import.meta.dirname, 'backup.ts'), 'utf8');
    expect(src).not.toMatch(/node:https?|fetch\(|aws-sdk|undici/);
  });
});

function fakeManifest(d: string, name: string, created: string, db = 'samsam_v36') {
  writeFileSync(join(d, name), 'PGDMP');
  const m = {
    format: 1,
    created_at: created,
    db_name: db,
    server_version: '17',
    pg_dump_version: '17',
    tool: 'x',
    file: name,
    size_bytes: 5,
    sha256: '0',
    encrypted: false,
    cipher: null,
    row_counts: {},
  };
  writeFileSync(join(d, name + MANIFEST_SUFFIX), JSON.stringify(m));
}

describe('retention', () => {
  it('giữ N bản theo created_at (không theo mtime/tên); không đụng file lạ/manifest hỏng/.partial/jsonl', () => {
    const d = fresh();
    const days = ['2026-10-05', '2026-10-01', '2026-10-04', '2026-10-02', '2026-10-03'];
    for (const [i, day] of days.entries()) {
      fakeManifest(d, `samsam_v36_2026010${i}_000000_vn.dump`, `${day}T01:30:00+07:00`);
    }
    writeFileSync(join(d, 'notes.txt'), 'x');
    writeFileSync(join(d, 'samsam_v36_20250101_000000_vn.dump.manifest.json'), '{hỏng');
    writeFileSync(join(d, 'x_20250101_000000_vn.dump.partial'), 'x');
    writeFileSync(join(d, 'backup_runs.jsonl'), '{}\n');
    fakeManifest(d, 'other_20200101_000000_vn.dump', '2020-01-01T00:00:00+07:00', 'other');
    const [removed, errors] = applyRetention(d, 3, 'samsam_v36');
    expect(errors).toEqual([]);
    const kept = validManifests(d, 'samsam_v36')
      .map((x) => x.m.created_at.slice(0, 10))
      .sort();
    expect(kept).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
    expect(removed).toHaveLength(2);
    for (const f of [
      'notes.txt',
      'samsam_v36_20250101_000000_vn.dump.manifest.json',
      'x_20250101_000000_vn.dump.partial',
      'backup_runs.jsonl',
      'other_20200101_000000_vn.dump',
    ]) {
      expect(existsSync(join(d, f)), f).toBe(true);
    }
  });

  it('manifest trỏ `file` khác tên (../victim) → không hợp lệ, không xóa', () => {
    const d = fresh();
    fakeManifest(d, 'samsam_v36_20260101_000000_vn.dump', '2026-01-01T00:00:00+07:00');
    const mp = join(d, 'samsam_v36_20260101_000000_vn.dump.manifest.json');
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.file = '../victim.txt';
    writeFileSync(mp, JSON.stringify(m));
    expect(loadManifest(mp)).toBeNull();
    expect(applyRetention(d, 1, 'samsam_v36')).toEqual([[], []]);
  });

  it('xóa bản cũ lỗi (file bị khóa) → ghi lỗi, không dừng bản khác', () => {
    const d = fresh();
    for (const [i, day] of ['2026-10-01', '2026-10-02', '2026-10-03'].entries()) {
      fakeManifest(d, `samsam_v36_2026100${i}_000000_vn.dump`, `${day}T01:30:00+07:00`);
    }
    const real = io.unlink;
    vi.spyOn(io, 'unlink').mockImplementation((p) => {
      if (p.endsWith('20261000_000000_vn.dump')) {
        throw Object.assign(new Error('file đang bị khóa'), { code: 'EBUSY' });
      }
      real(p);
    });
    const [removed, errors] = applyRetention(d, 1, 'samsam_v36');
    expect(removed).toEqual(['samsam_v36_20261001_000000_vn.dump']);
    expect(errors).toEqual(['samsam_v36_20261000_000000_vn.dump: file đang bị khóa']);
  });
});

describe('passphrase (openssl chỉ dùng dòng đầu, dừng ở NUL)', () => {
  const weak = [
    Buffer.from('\n'),
    Buffer.from('\r\n'),
    Buffer.from('   \n'),
    Buffer.from('\ndung-passphrase-o-dong-hai\n'),
    Buffer.from('ngan-qua\n'),
    Buffer.alloc(0),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('MatKhauRatDaiVaManh2026\n', 'utf16le')]),
    Buffer.from('MatKhauRatDaiVaManh2026\n', 'utf16le').swap16(),
    Buffer.from('0123456789abcdef\x00tail\n', 'latin1'),
  ];
  it.each(weak.map((b, i) => [i, b] as const))(
    'yếu %i → main exit 2, drill từ chối trước openssl',
    async (_i, body) => {
      const t = fresh();
      const pf = join(t, 'pass.txt');
      writeFileSync(pf, body);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = vi.spyOn(backupDeps, 'runBackup');
      expect(
        await backupMain({
          BACKUP_DIR: join(t, 'bk'),
          BACKUP_PASSPHRASE_FILE: pf,
          DATABASE_URL: 'postgresql://u@h/x',
        }),
      ).toBe(2);
      expect(run).not.toHaveBeenCalled();
      const openssl = vi.spyOn(settings, 'findOpenssl').mockImplementation(() => {
        throw new Error('không được gọi openssl');
      });
      await expect(decrypt(join(t, 'x.enc'), pf, t)).rejects.toThrow(/dòng đầu/);
      expect(openssl).not.toHaveBeenCalled();
      expect(readdirSync(t).filter((f) => f.startsWith('drill_'))).toEqual([]);
    },
  );

  it('dòng đầu ≥ 16 byte (CRLF / không xuống dòng) → hợp lệ', () => {
    const pf = join(fresh(), 'p.txt');
    writeFileSync(pf, '0123456789abcdef\r\nbo-qua\n');
    expect(() => checkPassfile(pf)).not.toThrow();
    writeFileSync(pf, '0123456789abcdef');
    expect(() => checkPassfile(pf)).not.toThrow();
  });
});

describe('r13 — mã hóa bắt buộc + offsite khác thiết bị', () => {
  let t: string;
  beforeEach(() => {
    t = fresh();
  });

  it('BACKUP_REQUIRE_ENCRYPTION=1 thiếu tệp khóa → usage; offsite cùng thiết bị → cảnh báo / chặn khi bắt buộc', () => {
    expect(() =>
      readConfig({ BACKUP_DIR: join(t, 'b'), BACKUP_REQUIRE_ENCRYPTION: '1' }, () => {}),
    ).toThrow(/BACKUP_REQUIRE_ENCRYPTION/);
    const env: Record<string, string> = {
      BACKUP_DIR: join(t, 'b'),
      BACKUP_OFFSITE: `dir:${join(t, 'o')}`,
    };
    const logs: string[] = [];
    readConfig(env, (s) => logs.push(s));
    expect(logs.join('\n')).toContain('cùng thiết bị');
    env.BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE = '1';
    expect(() => readConfig(env, () => {})).toThrow(UsageError);
    expect(() => readConfig(env, () => {})).toThrow(/cùng thiết bị/);
  });
});

describe('guard tên DB diễn tập', () => {
  it('mẫu samsam_drill_*, khác DB đang dùng, không ký tự lạ', () => {
    expect(() => guardName('samsam_v36', ['postgresql://u@h/samsam_v36'])).toThrow(Refuse);
    expect(() => guardName('postgres', ['postgresql://u@h/samsam_v36'])).toThrow(Refuse);
    expect(() =>
      guardName('samsam_drill_x', [
        'postgresql://u@127.0.0.1/a',
        'postgresql://u@localhost/samsam_drill_x',
      ]),
    ).toThrow(Refuse);
    expect(() => guardName('samsam_drill_X; drop', ['postgresql://u@h/a'])).toThrow(Refuse);
    expect(() =>
      guardName('samsam_drill_20261012_010101_ab12', ['postgresql://u@h/samsam_v36']),
    ).not.toThrow();
  });
});
