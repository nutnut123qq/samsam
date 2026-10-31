import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '@samsam/core/paths';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { settings as bkSettings, MANIFEST_SUFFIX } from './backup.js';
import { io, type RunOpts, sha256File } from './common.js';
import {
  DEFAULT_PGDATA,
  drDeps,
  drMain,
  imageVolumes,
  leftovers,
  PREFIX,
  rpoSeconds,
} from './dr-drill.js';
import { drillDeps, runDrill } from './restore-drill.js';

// Dịch tests/test_dr_drill.py (unit — `io.run` giả cho mọi lệnh docker, không docker thật) +
// test_vector_eval `leftovers(prefix)`. E2E docker thật: dr-drill.docker.test.ts (bật bằng
// TS_TEST_DR_DOCKER=1 — cần image postgres:<major>-alpine có sẵn + pg_dump).

const NAME_RE = /^samsam-dr-\d{8}_\d{6}-[0-9a-f]{4}$/;
const CREATED = new Date('2026-10-11T01:30:00+07:00');
const H = 3600_000;
const root = mkdtempSync(join(tmpdir(), 'ops-dr-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function manifest(d: string): string {
  const name = 'samsam_v36_20261011_013000_vn.dump';
  writeFileSync(join(d, name), 'PGDMP');
  const m = {
    format: 1,
    created_at: '2026-10-11T01:30:00+07:00',
    db_name: 'samsam_v36',
    server_version: '17.6',
    pg_dump_version: '17',
    tool: 'x',
    file: name,
    size_bytes: 5,
    sha256: '0',
    encrypted: false,
    cipher: null,
    row_counts: { products: 1 },
  };
  const p = join(d, name + MANIFEST_SUFFIX);
  writeFileSync(p, JSON.stringify(m));
  return p;
}

/** Giả `io.run` cho lệnh docker; ghi lại argv + env. */
class FakeDocker {
  calls: string[][] = [];
  envs: (Record<string, string | undefined> | undefined)[] = [];
  versionRc = 0;
  imageRc = 0;
  psAfterRm = '';
  leftover = '';
  removed = false;
  imageVols = '{"/var/lib/postgresql/data":{}}';
  vols = '';
  volLeft = false;
  psOverride: ((argv: string[]) => string | null) | null = null;

  run = async (argv: readonly string[], opts: RunOpts) => {
    const a = [...argv];
    this.calls.push(a);
    this.envs.push(opts.env);
    const sub = a.slice(1, 3);
    let out = '';
    let rc = 0;
    if (sub[0] === 'version') {
      rc = this.versionRc;
      out = '28.4.0';
    } else if (sub[0] === 'image' && sub[1] === 'inspect') {
      rc = this.imageRc;
      if (a.includes('-f')) out = this.imageVols;
    } else if (sub[0] === 'inspect') {
      [rc, out] = this.removed ? [1, ''] : [0, this.vols];
    } else if (sub[0] === 'volume' && sub[1] === 'ls') {
      out = this.volLeft || !this.removed ? this.vols : '';
    } else if (sub[0] === 'port') {
      out = '127.0.0.1:55999\n';
    } else if (sub[0] === 'rm') {
      this.removed = true;
    } else if (sub[0] === 'ps') {
      out = this.psOverride?.(a) ?? (this.removed ? this.psAfterRm : this.leftover);
    }
    return { code: rc, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
  };

  ops(): string[] {
    return this.calls.map((c) => c.slice(1, 3).join(' '));
  }
}

let bdir: string;
let fake: FakeDocker;
let seen: { server?: string | null };
let log: MockInstance<(...a: unknown[]) => void>;
let dir = 0;
const env = () => ({ BACKUP_DIR: bdir, PATH: process.env.PATH });
const last = () => {
  const lines = readFileSync(join(bdir, 'dr_runs.jsonl'), 'utf8').split('\n');
  return JSON.parse(lines.at(-2) as string);
};
const out = () => log.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  bdir = join(root, `bk${dir++}`);
  mkdirSync(bdir);
  manifest(bdir);
  fake = new FakeDocker();
  seen = {};
  vi.spyOn(io, 'which').mockImplementation((n) => (n === 'docker' ? 'docker' : null));
  vi.spyOn(io, 'run').mockImplementation(fake.run);
  vi.spyOn(drDeps, 'waitReady').mockResolvedValue(undefined);
  vi.spyOn(drDeps, 'runDrill').mockImplementation(async (_a, _b, _dsn, server) => {
    seen.server = server;
    return [0, { status: 'ok', rto_seconds: 1.5, tables_checked: 1, mismatches: {} } as never];
  });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('rpo + argv docker an toàn', () => {
  it('rpo_seconds thuần theo `now`; created_at thiếu múi giờ → lỗi', () => {
    const m = { created_at: '2026-10-11T01:30:00+07:00' };
    expect(rpoSeconds(m, new Date(CREATED.getTime() + 30 * H))).toBe(30 * 3600);
    expect(rpoSeconds(m, CREATED)).toBe(0);
    expect(() => rpoSeconds({ created_at: '2026-10-11T01:30:00' }, CREATED)).toThrow(RangeError);
  });

  it('docker run: --rm -d --pull never, cổng 127.0.0.1, mật khẩu chỉ qua env, tmpfs, rm -f -v, nhật ký không bí mật', async () => {
    expect(await drMain({}, new Date(CREATED.getTime() + 2 * H), env())).toBe(0);
    const runs = fake.calls.filter((c) => c[1] === 'run');
    expect(runs).toHaveLength(1);
    const run = runs[0] as string[];
    const renv = fake.envs[fake.calls.indexOf(run)] as Record<string, string>;
    const pw = renv.POSTGRES_PASSWORD as string;
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(run).toContain('--rm');
    expect(run).toContain('-d');
    expect(run[run.indexOf('--pull') + 1]).toBe('never');
    expect(run[run.indexOf('-p') + 1]).toBe('127.0.0.1::5432');
    expect(run[run.indexOf('-e') + 1]).toBe('POSTGRES_PASSWORD');
    expect(run.some((x) => x.includes('POSTGRES_PASSWORD='))).toBe(false);
    expect(run.at(-1)).toBe('postgres:17-alpine');
    expect(run[run.indexOf('--tmpfs') + 1]).toBe('/var/lib/postgresql/data');
    const name = run[run.indexOf('--name') + 1] as string;
    expect(name).toMatch(NAME_RE);
    expect(run.join(' ')).not.toContain(pw);
    expect(fake.ops()).not.toContain('pull');
    expect(fake.envs.filter((e) => e && 'POSTGRES_PASSWORD' in e)).toHaveLength(1);
    expect(seen.server).toContain('55999');
    expect(seen.server).toContain(pw);
    expect(fake.calls[fake.ops().indexOf('rm -f')]?.slice(1)).toEqual(['rm', '-f', '-v', name]);
    const body = readFileSync(join(bdir, 'dr_runs.jsonl'), 'utf8');
    for (const s of [pw, '55999', 'postgresql://', 'password']) expect(body).not.toContain(s);
    const rec = last();
    expect(rec).toMatchObject({
      status: 'ok',
      container: name,
      container_removed: true,
      rpo_seconds: 7200,
      rpo_max_hours: 24,
      restore_rto_seconds: 1.5,
    });
    for (const k of ['ts', 'backup_file', 'image', 'rto_seconds', 'tables_checked', 'mismatches']) {
      expect(rec).toHaveProperty(k);
    }
    expect(out()).toContain('RTO');
    expect(out()).toContain('RPO 2.00h');
    expect(out()).not.toContain(pw);
  });
});

describe('external-dep + dọn container', () => {
  it.for(['no_cli', 'daemon_down', 'no_image'])(
    '%s → exit 3, không docker run/pull/rm',
    async (mode) => {
      if (mode === 'no_cli') vi.spyOn(io, 'which').mockReturnValue(null);
      else if (mode === 'daemon_down') fake.versionRc = 1;
      else fake.imageRc = 1;
      expect(await drMain({}, CREATED, env())).toBe(3);
      expect(fake.calls.every((c) => !['run', 'pull', 'rm'].includes(c[1] as string))).toBe(true);
      expect(last()).toMatchObject({ status: 'khong_chay', container: null });
      expect(out()).toContain('[external-dep]');
    },
  );

  it('lõi diễn tập lỗi nghiệp vụ → exit 1 + vẫn rm -f', async () => {
    vi.spyOn(drDeps, 'runDrill').mockRejectedValue(
      Object.assign(new Error('boom'), { name: 'RuntimeError' }),
    );
    expect(await drMain({}, CREATED, env())).toBe(1);
    expect(last().status).toBe('fail');
    expect(fake.ops()).toContain('rm -f');
  });

  it.for([new TypeError('lạ'), new RangeError('lạ')])(
    'lỗi lập trình/ValueError nổi lên nhưng container VẪN bị dọn',
    async (exc) => {
      vi.spyOn(drDeps, 'runDrill').mockRejectedValue(exc);
      await expect(drMain({}, CREATED, env())).rejects.toBe(exc);
      expect(fake.ops()).toContain('rm -f');
    },
  );

  it('container còn sau rm → cleanup_failed + ALERT, exit 1', async () => {
    fake.psOverride = () => {
      if (!fake.removed) return null;
      const run = fake.calls.find((c) => c[1] === 'run') as string[];
      return `${run[run.indexOf('--name') + 1]}\n`;
    };
    expect(await drMain({}, CREATED, env())).toBe(1);
    expect(last()).toMatchObject({ status: 'cleanup_failed', container_removed: false });
    expect(out()).toContain('[ALERT] container DR');
  });

  it('volume của container còn sau rm → cleanup_failed + ALERT nêu volume', async () => {
    fake.vols = 'anonvol123';
    fake.volLeft = true;
    expect(await drMain({}, CREATED, env())).toBe(1);
    expect(last()).toMatchObject({ status: 'cleanup_failed', container_removed: false });
    expect(out()).toContain('anonvol123');
    expect(out()).toContain('docker volume rm');
  });

  it('có volume nhưng rm -v đã xóa → ok', async () => {
    fake.vols = 'anonvol123';
    expect(await drMain({}, CREATED, env())).toBe(0);
    expect(last().container_removed).toBe(true);
    expect(fake.ops()).toContain('volume ls');
  });

  it('image_volumes: đọc VOLUME của image, hỏng/rỗng → PGDATA mặc định', async () => {
    expect(await imageVolumes('postgres:17-alpine')).toEqual(['/var/lib/postgresql/data']);
    fake.imageVols = '{"/var/lib/postgresql":{}}';
    expect(await imageVolumes('postgres:18-alpine')).toEqual(['/var/lib/postgresql']);
    for (const bad of ['', 'null', '{}', 'rác']) {
      fake.imageVols = bad;
      expect(await imageVolumes('x')).toEqual([DEFAULT_PGDATA]);
    }
    fake.imageVols = '{"/a":{}}';
    fake.imageRc = 1;
    expect(await imageVolumes('x')).toEqual([DEFAULT_PGDATA]);
  });

  it('container sót từ lần trước → [warn] liệt kê, KHÔNG tự xóa', async () => {
    fake.leftover = 'samsam-dr-20260101_000000-abcd\nother\n';
    expect(await drMain({}, CREATED, env())).toBe(0);
    expect(out()).toMatch(/\[warn\].*samsam-dr-20260101_000000-abcd/);
    const rms = fake.calls.filter((c) => c[1] === 'rm');
    expect(rms).toHaveLength(1);
    expect(rms[0]).not.toContain('samsam-dr-20260101_000000-abcd');
  });

  it('leftovers(prefix) mặc định DR, vector_eval dùng tiền tố riêng', async () => {
    vi.spyOn(io, 'run').mockResolvedValue({
      code: 0,
      stdout: Buffer.from('samsam-dr-1\nsamsam-vec-2\n'),
      stderr: Buffer.alloc(0),
    });
    expect(PREFIX).toBe('samsam-dr-');
    expect(await leftovers()).toEqual(['samsam-dr-1']);
    expect(await leftovers('samsam-vec-')).toEqual(['samsam-vec-2']);
  });
});

describe('RPO + usage', () => {
  it('RPO vượt mục tiêu → rpo_breach exit 1, container vẫn dọn', async () => {
    expect(await drMain({}, new Date(CREATED.getTime() + 30 * H), env())).toBe(1);
    expect(last()).toMatchObject({
      status: 'rpo_breach',
      rpo_seconds: 108000,
      container_removed: true,
    });
  });

  it('DR_RPO_MAX_HOURS được tôn trọng', async () => {
    expect(
      await drMain({}, new Date(CREATED.getTime() + 30 * H), { ...env(), DR_RPO_MAX_HOURS: '36' }),
    ).toBe(0);
    expect(last().rpo_max_hours).toBe(36);
  });

  it.for([
    ['DR_RPO_MAX_HOURS', '0'],
    ['DR_RPO_MAX_HOURS', '-1'],
    ['DR_RPO_MAX_HOURS', 'abc'],
    ['DR_RPO_MAX_HOURS', 'nan'],
    ['DR_RPO_MAX_HOURS', 'inf'],
    ['DR_READY_TIMEOUT_S', '0'],
  ])('%s=%s → usage exit 2 TRƯỚC docker, không nhật ký', async ([k, v]) => {
    expect(await drMain({}, CREATED, { ...env(), [k as string]: v })).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(() => readFileSync(join(bdir, 'dr_runs.jsonl'))).toThrow();
  });

  it('DR_IMAGE (TS thêm cho DB pgvector): image có sẵn dùng thay mặc định; sai dạng → usage exit 2', async () => {
    expect(
      await drMain({}, CREATED, { ...env(), DR_IMAGE: 'pgvector/pgvector:0.8.6-pg17-trixie' }),
    ).toBe(0);
    const run = fake.calls.find((c) => c[1] === 'run') as string[];
    expect(run.at(-1)).toBe('pgvector/pgvector:0.8.6-pg17-trixie');
    expect(run[run.indexOf('--pull') + 1]).toBe('never');
    expect(last().image).toBe('pgvector/pgvector:0.8.6-pg17-trixie');
    fake.calls = [];
    for (const bad of ['--privileged', 'a b', 'x;rm', 'UPPER/x']) {
      expect(await drMain({}, CREATED, { ...env(), DR_IMAGE: bad })).toBe(2);
    }
    expect(fake.calls).toEqual([]);
  });

  it('BACKUP_DIR trong repo / không tồn tại → exit 2, không docker, không tạo thư mục', async () => {
    expect(await drMain({}, CREATED, { BACKUP_DIR: join(REPO_ROOT, 'backups') })).toBe(2);
    expect(await drMain({}, CREATED, { BACKUP_DIR: join(root, 'khong-co') })).toBe(2);
    expect(out()).toContain('[usage] BACKUP_DIR không tồn tại');
    expect(fake.calls).toEqual([]);
  });
});

describe('lõi diễn tập (run_drill) khôi phục vào server diễn tập', () => {
  it('drill_server=X: MỌI kết nối + pg_restore tới X, không tới server thật hay DRILL_DATABASE_URL', async () => {
    const mp = manifest(bdir);
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.sha256 = sha256File(join(bdir, m.file));
    writeFileSync(mp, JSON.stringify(m));
    const live = 'postgresql://u@livehost:5433/samsam_v36';
    const drill = 'postgresql://postgres:pw@127.0.0.1:55999/postgres';
    const hit: string[] = [];
    const hostOf = (u: string) => {
      const x = new URL(u);
      return `${x.hostname}:${x.port}`;
    };
    vi.spyOn(drillDeps, 'dbExists').mockImplementation(async (u) => {
      hit.push(hostOf(u));
      return false;
    });
    vi.spyOn(drillDeps, 'createDb').mockImplementation(async (u) => {
      hit.push(hostOf(u));
      return 17;
    });
    vi.spyOn(drillDeps, 'dropDb').mockImplementation(async (u) => {
      hit.push(hostOf(u));
    });
    vi.spyOn(drillDeps, 'countTables').mockImplementation(async (u) => {
      hit.push(hostOf(u));
      return { products: 1 };
    });
    vi.spyOn(io, 'which').mockImplementation((n) => (n === 'pg_restore' ? '/x/pg_restore' : null));
    vi.spyOn(bkSettings, 'toolMajor').mockResolvedValue([17, 'pg_restore 17']);
    const envs: Record<string, string | undefined>[] = [];
    vi.spyOn(io, 'run').mockImplementation(async (_argv, opts) => {
      envs.push(opts.env ?? {});
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    const [code, rec] = await runDrill({}, bdir, live, drill, {
      DRILL_DATABASE_URL: 'postgresql://u@drillenv:6001/postgres',
    });
    expect(code, JSON.stringify(rec)).toBe(0);
    expect(rec.status).toBe('ok');
    expect(new Set(hit)).toEqual(new Set(['127.0.0.1:55999']));
    expect(envs.map((e) => [e.PGHOST, e.PGPORT])).toEqual([['127.0.0.1', '55999']]);
    expect(envs[0]?.PGDATABASE).toBe(rec.drill_db);
  });
});
