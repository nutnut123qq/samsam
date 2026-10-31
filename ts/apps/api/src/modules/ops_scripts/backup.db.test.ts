import { createHash, randomBytes } from 'node:crypto';
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
import { createPool } from '@samsam/core/db';
import { pyDumps } from '@samsam/core/rollout/counters';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import {
  backupMain,
  CIPHER,
  findTool,
  MANIFEST_KEYS,
  MANIFEST_SUFFIX,
  OPENSSL_ENC,
  settings,
  snapshotCounts,
  validManifests,
} from './backup.js';
import { io, sha256File, spawnRun } from './common.js';
import { dbExists, runDrill } from './restore-drill.js';

// Dịch tests/test_db_backup.py (E2E) + tests/test_v15_fix_p87c.py (bằng chứng DB): pg_dump/pg_restore
// THẬT (công cụ PG ≥ major server — skip nếu máy không có) trên DB test riêng tạo từ mẫu. Mọi DB diễn
// tập do test tạo bị drop (kiểm cuối file). Không bao giờ DB `samsam`.

const HAS_DB = Boolean(process.env.TS_TEST_ADMIN_URL);
const RUN = randomBytes(3).toString('hex');
const DRILL_PREFIX = `samsam_drill_test_${RUN}_`;

describe.skipIf(!HAS_DB)('db_backup + lõi diễn tập khôi phục (pg_dump thật, DB test)', () => {
  const name = testDbName('ops_scripts');
  const root = mkdtempSync(join(tmpdir(), 'ops-bkdb-'));
  const logins: string[] = [];
  let dsn = '';
  let pool: pg.Pool;
  let hasTool = false;
  let k = 0;

  beforeAll(async () => {
    dsn = await createDbFromTemplate(name);
    pool = createPool(dsn);
    const n = Number(
      (await pool.query("select current_setting('server_version_num')::int as n")).rows[0].n,
    );
    hasTool = (await findTool('pg_dump', Math.floor(n / 10000), process.env, () => {})) !== null;
  });
  afterAll(async () => {
    await pool?.end();
    const admin = createPool(process.env.TS_TEST_ADMIN_URL as string);
    try {
      const left = await admin.query<{ datname: string }>(
        'select datname from pg_database where datname like $1',
        [`${DRILL_PREFIX.replaceAll('_', '\\_')}%`],
      );
      for (const r of left.rows)
        await adminQuery(`drop database if exists "${r.datname}" with (force)`);
    } finally {
      await admin.end();
    }
    await dropDb(name);
    for (const l of logins) await adminQuery(`drop role if exists ${l}`);
    rmSync(root, { recursive: true, force: true });
  });

  let clock = Date.now();
  let log: MockInstance<(...a: unknown[]) => void>;
  const bdir = () => join(root, `bk${k}`);
  const out = () => log.mock.calls.map((c) => String(c[0])).join('\n');
  afterEach(() => {
    vi.restoreAllMocks();
    settings.connectTimeoutMs = 10_000;
  });

  /** Mỗi test: thư mục riêng + giờ VN tăng 1 phút/lần gọi (tên file theo giây không đụng nhau). */
  function setup(): { env: Record<string, string | undefined>; d: string } {
    k++;
    vi.spyOn(io, 'now').mockImplementation(() => {
      clock += 60_000;
      return new Date(clock);
    });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env: Record<string, string | undefined> = {};
    for (const [key, v] of Object.entries(process.env)) {
      if (!/^(BACKUP_|DRILL_|PG_BIN$|DATABASE_URL$)/.test(key)) env[key] = v;
    }
    env.BACKUP_DIR = bdir();
    env.DATABASE_URL = dsn;
    return { env, d: bdir() };
  }

  const dumps = (d: string) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => /_vn\.dump/.test(f) && !f.endsWith(MANIFEST_SUFFIX))
          .sort()
      : [];
  const lastRec = (d: string) => {
    const lines = readFileSync(join(d, 'backup_runs.jsonl'), 'utf8').split('\n');
    return JSON.parse(lines.at(-2) as string);
  };
  const counts = async (url = dsn) => {
    const p = createPool(url, { max: 1 });
    const c = await p.connect();
    try {
      return await snapshotCounts(c);
    } finally {
      c.release();
      await p.end();
    }
  };
  const nEvidence = async () =>
    Number((await pool.query('select count(*) as n from file_output_evidence')).rows[0].n);

  it('backup → manifest/sha256/row_counts khớp live + đúng 1 bằng chứng DB (JSON sort key của bản ghi)', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    const before = await counts();
    expect(await backupMain(env)).toBe(0);
    const ms = readdirSync(d).filter((f) => f.endsWith(MANIFEST_SUFFIX));
    expect(ms).toHaveLength(1);
    const m = JSON.parse(readFileSync(join(d, ms[0] as string), 'utf8'));
    expect(Object.keys(m).sort()).toEqual([...MANIFEST_KEYS].sort());
    expect(m.created_at).toMatch(/\+07:00$/);
    expect(m.file).toMatch(/^\w+_\d{8}_\d{6}_vn\.dump$/);
    expect(sha256File(join(d, m.file))).toBe(m.sha256);
    expect(readFileSync(join(d, m.file)).subarray(0, 5).toString()).toBe('PGDMP');
    expect(m.row_counts).toEqual(before);
    expect(m.encrypted).toBe(false);
    expect(m.cipher).toBeNull();
    // v15 fix P8.7c: đúng 1 dòng bằng chứng SAU snapshot; ngoài sổ bằng chứng không đổi gì.
    const after = await counts();
    expect(after).toEqual({
      ...before,
      file_output_evidence: (before.file_output_evidence ?? 0) + 1,
    });
    const rec = lastRec(d);
    expect(rec.status).toBe('ok');
    const ev = await pool.query(
      'select output_key, content_sha256, ban_ghi from file_output_evidence order by id desc limit 1',
    );
    const text = pyDumps(rec, true);
    expect(ev.rows[0]).toEqual({
      output_key: `bk:${m.sha256}`,
      content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      ban_ghi: text,
    });
    const pw = new URL(dsn).password;
    for (const f of [join(d, ms[0] as string), join(d, 'backup_runs.jsonl')]) {
      const body = readFileSync(f, 'utf8');
      expect(body).not.toContain(dsn);
      if (pw) expect(body).not.toContain(pw);
    }
    expect(readdirSync(d).filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(out()).toContain('[evidence] đã ghi bằng chứng đầu ra vào DB');
  });

  it('host chết → exit 1, không file dump/manifest, lỗi đã che host', async () => {
    const { env, d } = setup();
    settings.connectTimeoutMs = 2000;
    env.DATABASE_URL = 'postgresql://u@10.255.255.1:5432/x';
    expect(await backupMain(env)).toBe(1);
    expect(dumps(d)).toEqual([]);
    const rec = lastRec(d);
    expect(rec.status).toBe('fail');
    expect(rec.error).not.toContain('10.255.255.1');
  });

  it('pg_dump major < server → exit 1, không dump/.partial', async () => {
    const { env, d } = setup();
    vi.spyOn(settings, 'toolMajor').mockResolvedValue([9, 'pg_dump 9.6']);
    expect(await backupMain(env)).toBe(1);
    expect(dumps(d)).toEqual([]);
    expect(readdirSync(d).filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(lastRec(d).error).toMatch(/major 9 < server/);
  });

  it('retention giữ 3 bản + offsite dir: hai bên khớp sha, file lạ/manifest hỏng giữ nguyên', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    const off = join(root, `off${k}`);
    env.BACKUP_KEEP = '3';
    env.BACKUP_OFFSITE = `dir:${off}`;
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'notes.txt'), 'giữ');
    const broken = join(d, 'samsam_v36_20200101_000000_vn.dump.manifest.json');
    writeFileSync(broken, '{');
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      expect(await backupMain(env)).toBe(0);
      names.push(dumps(d).at(-1) as string);
    }
    for (const dir of [d, off]) {
      expect(dumps(dir)).toEqual(names.slice(1).sort());
      const vm = validManifests(dir);
      expect(vm).toHaveLength(3);
      for (const { m } of vm) expect(sha256File(join(dir, m.file))).toBe(m.sha256);
    }
    expect(existsSync(join(d, 'notes.txt'))).toBe(true);
    expect(existsSync(broken)).toBe(true);
    expect(out()).toContain('[offsite] đã chép + kiểm sha256');
  });

  it('mã hóa: không còn bản rõ; openssl giải được; drill đúng khóa ok + DB tạm bị drop; sai khóa exit 1, không tạo DB', async (ctx) => {
    if (!hasTool || !settings.findOpenssl()) return ctx.skip();
    const { env, d } = setup();
    const pf = join(root, `pass${k}.txt`);
    writeFileSync(pf, 'dung-passphrase-test\n');
    env.BACKUP_PASSPHRASE_FILE = pf;
    expect(await backupMain(env)).toBe(0);
    expect(readdirSync(d).filter((f) => f.endsWith('_vn.dump'))).toEqual([]);
    for (const f of readdirSync(d))
      expect(readFileSync(join(d, f)).subarray(0, 5).toString()).not.toBe('PGDMP');
    const enc = readdirSync(d).find((f) => f.endsWith('.dump.enc')) as string;
    const m = JSON.parse(readFileSync(join(d, enc + MANIFEST_SUFFIX), 'utf8'));
    expect(m.encrypted).toBe(true);
    expect(m.cipher).toBe(CIPHER);
    expect(sha256File(join(d, enc))).toBe(m.sha256);
    const plain = join(root, `plain${k}.dump`);
    const r = await spawnRun(
      [
        settings.findOpenssl() as string,
        ...OPENSSL_ENC,
        '-d',
        '-pass',
        `file:${pf}`,
        '-in',
        join(d, enc),
        '-out',
        plain,
      ],
      { timeoutMs: 60_000 },
    );
    expect(r.code).toBe(0);
    expect(readFileSync(plain).subarray(0, 5).toString()).toBe('PGDMP');
    rmSync(plain);
    const t1 = `${DRILL_PREFIX}enc_ok`;
    const [c1, r1] = await runDrill({ targetDb: t1 }, d, dsn, null, env);
    expect(c1).toBe(0);
    expect(r1).toMatchObject({ status: 'ok', dropped: true });
    expect(await dbExists(dsn, t1)).toBe(false);
    const bad = join(root, `bad${k}.txt`);
    writeFileSync(bad, 'sai-passphrase-khac-hoan-toan\n');
    const t2 = `${DRILL_PREFIX}enc_bad`;
    const [c2, r2] = await runDrill({ targetDb: t2 }, d, dsn, null, {
      ...env,
      BACKUP_PASSPHRASE_FILE: bad,
    });
    expect(c2).toBe(1);
    expect(r2).toMatchObject({ status: 'fail', dropped: null });
    expect(await dbExists(dsn, t2)).toBe(false);
    expect(readdirSync(d).filter((f) => f.startsWith('drill_'))).toEqual([]);
  });

  it('offsite s3 → exit 3 (external-dep), bản local giữ, nhật ký offsite_fail', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    env.BACKUP_OFFSITE = 's3://b/p';
    expect(await backupMain(env)).toBe(3);
    expect(dumps(d)).toHaveLength(1);
    const rec = lastRec(d);
    expect(rec.status).toBe('offsite_fail');
    expect(rec.error).toContain('external-dep');
  });

  it('drill khớp hết bảng, in RTO, DB tạm bị drop', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    expect(await backupMain(env)).toBe(0);
    log.mockClear();
    const [code, rec] = await runDrill({}, d, dsn, null, env);
    expect(code).toBe(0);
    const n = Object.keys(await counts()).length;
    expect(out()).toContain(`${n}/${n} bảng khớp`);
    expect(out()).toContain('RTO');
    expect(rec).toMatchObject({ status: 'ok', dropped: true, tables_checked: n, mismatches: {} });
    expect(typeof rec.rto_seconds).toBe('number');
    expect(await dbExists(dsn, rec.drill_db)).toBe(false);
  });

  it.for(['samsam_v36', 'postgres', 'CURRENT'])(
    'drill từ chối đích %s (không gọi pg_restore)',
    async (target, ctx) => {
      if (!hasTool) return ctx.skip();
      const { env, d } = setup();
      expect(await backupMain(env)).toBe(0);
      const before = await counts();
      const run = vi.spyOn(io, 'run');
      const [code, rec] = await runDrill(
        { targetDb: target === 'CURRENT' ? name : target },
        d,
        dsn,
        null,
        env,
      );
      expect(code).toBe(2);
      expect(rec.status).toBe('refused');
      expect(run).not.toHaveBeenCalled();
      expect(await counts()).toEqual(before);
    },
  );

  it('drill từ chối DB diễn tập đã tồn tại (không drop nó)', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    expect(await backupMain(env)).toBe(0);
    const t = `${DRILL_PREFIX}preexisting`;
    await adminQuery(`create database "${t}"`);
    try {
      const [code, rec] = await runDrill({ targetDb: t }, d, dsn, null, env);
      expect(code).toBe(2);
      expect(rec.status).toBe('refused');
      expect(await dbExists(dsn, t)).toBe(true);
    } finally {
      await adminQuery(`drop database if exists "${t}" with (force)`);
    }
  });

  it('byte hỏng → FAIL sha256 trước khi tạo DB', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    expect(await backupMain(env)).toBe(0);
    const f = join(d, dumps(d)[0] as string);
    const b = readFileSync(f);
    b[b.length >> 1] = (b[b.length >> 1] as number) ^ 0xff;
    writeFileSync(f, b);
    const t = `${DRILL_PREFIX}corrupt`;
    const [code, rec] = await runDrill({ targetDb: t }, d, dsn, null, env);
    expect(code).toBe(1);
    expect(rec).toMatchObject({ status: 'fail', dropped: null });
    expect(rec.error).toContain('sha256');
    expect(await dbExists(dsn, t)).toBe(false);
  });

  it('bản mới nhất mất file → FAIL, KHÔNG lùi về bản cũ', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    expect(await backupMain(env)).toBe(0);
    expect(await backupMain(env)).toBe(0);
    const newest = (validManifests(d)[0] as { m: { file: string } }).m.file;
    rmSync(join(d, newest));
    const [code, rec] = await runDrill(
      { targetDb: `${DRILL_PREFIX}nofallback` },
      d,
      dsn,
      null,
      env,
    );
    expect(code).toBe(1);
    expect(rec.backup_file).toBe(newest);
    expect(rec.status).toBe('fail');
    expect(await dbExists(dsn, `${DRILL_PREFIX}nofallback`)).toBe(false);
  });

  it('manifest lệch số dòng → mismatch, DB tạm VẪN bị drop', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    expect(await backupMain(env)).toBe(0);
    const mp = join(d, readdirSync(d).find((f) => f.endsWith(MANIFEST_SUFFIX)) as string);
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    m.row_counts.products += 1;
    writeFileSync(mp, JSON.stringify(m));
    const t = `${DRILL_PREFIX}mismatch`;
    const [code, rec] = await runDrill({ targetDb: t }, d, dsn, null, env);
    expect(code).toBe(1);
    expect(rec).toMatchObject({ status: 'mismatch', dropped: true });
    expect(Object.keys(rec.mismatches)).toEqual(['products']);
    expect(await dbExists(dsn, t)).toBe(false);
  });

  it('dọn bản cũ lỗi (file bị khóa) → vẫn exit 0, offsite vẫn chạy, retention_error ghi cả local/offsite', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    const off = join(root, `off${k}`);
    env.BACKUP_KEEP = '1';
    env.BACKUP_OFFSITE = `dir:${off}`;
    expect(await backupMain(env)).toBe(0);
    const first = dumps(d);
    const real = io.unlink;
    vi.spyOn(io, 'unlink').mockImplementation((p) => {
      const base = p.split(/[\\/]/).pop() as string;
      if (base.includes('_vn.dump') && !base.endsWith('.partial')) {
        throw Object.assign(new Error('file đang bị khóa'), { code: 'EBUSY' });
      }
      real(p);
    });
    expect(await backupMain(env)).toBe(0);
    const lines = readFileSync(join(d, 'backup_runs.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const rec = lastRec(d);
    expect(rec).toMatchObject({ status: 'ok', offsite: 'dir' });
    for (const s of ['local', 'offsite', 'khóa']) expect(rec.retention_error).toContain(s);
    expect(dumps(d)).toHaveLength(2);
    expect(dumps(d)).toContain(first[0]);
    expect(dumps(off)).toEqual(dumps(d));
  });

  it.for(['pg_dump', 'openssl'])(
    'lỗi SAU khi .partial có dữ liệu (%s) → exit 1, không còn .partial/dump/manifest',
    async (stage, ctx) => {
      if (!hasTool) return ctx.skip();
      const { env, d } = setup();
      if (stage === 'openssl') {
        if (!settings.findOpenssl()) return ctx.skip();
        const pf = join(root, `pass${k}.txt`);
        writeFileSync(pf, 'dung-passphrase-test-dai\n');
        env.BACKUP_PASSPHRASE_FILE = pf;
      }
      const realRun = io.run;
      const seen: string[] = [];
      vi.spyOn(io, 'run').mockImplementation(async (argv, opts) => {
        if (stage === 'pg_dump' && argv.includes('-Fc')) {
          writeFileSync(opts.stdoutFile as string, 'PGDMP-du-lieu-dang-do');
          seen.push(opts.stdoutFile as string);
          return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') };
        }
        if (stage === 'openssl' && argv[1] === 'enc') {
          const o = argv[argv.indexOf('-out') + 1] as string;
          const i = argv[argv.indexOf('-in') + 1] as string;
          writeFileSync(o, 'Salted__dang-do');
          expect(i.endsWith('.partial')).toBe(true);
          expect(readFileSync(i).subarray(0, 5).toString()).toBe('PGDMP');
          seen.push(i, o);
          return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('bad') };
        }
        return realRun(argv, opts);
      });
      expect(await backupMain(env)).toBe(1);
      expect(seen.length).toBeGreaterThan(0);
      for (const p of seen) expect(existsSync(p), p).toBe(false);
      expect(readdirSync(d).filter((f) => f.endsWith('.partial'))).toEqual([]);
      expect(dumps(d)).toEqual([]);
      expect(readdirSync(d).filter((f) => f.endsWith(MANIFEST_SUFFIX))).toEqual([]);
      expect(lastRec(d).status).toBe('fail');
    },
  );

  it.for(['oserror', 'sha_mismatch'])(
    'offsite dir lỗi (%s) → exit 3, local nguyên vẹn, offsite không có bản hỏng',
    async (mode, ctx) => {
      if (!hasTool) return ctx.skip();
      const { env, d } = setup();
      const off = join(root, `off${k}`);
      env.BACKUP_OFFSITE = `dir:${off}`;
      vi.spyOn(io, 'copyFile').mockImplementation((_src, dst) => {
        writeFileSync(dst, 'ban-chep-hong');
        if (mode === 'oserror')
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      });
      expect(await backupMain(env)).toBe(3);
      const rec = lastRec(d);
      expect(rec).toMatchObject({ status: 'offsite_fail', offsite: null });
      const mp = readdirSync(d).find((f) => f.endsWith(MANIFEST_SUFFIX)) as string;
      const m = JSON.parse(readFileSync(join(d, mp), 'utf8'));
      expect(sha256File(join(d, m.file))).toBe(m.sha256);
      expect(dumps(off)).toEqual([]);
      expect(
        readdirSync(off).filter((f) => f.endsWith('.partial') || f.endsWith(MANIFEST_SUFFIX)),
      ).toEqual([]);
    },
  );

  it('có passphrase mà không có openssl → fail-closed exit 1, không ghi bản rõ', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const { env, d } = setup();
    const pf = join(root, `pass${k}.txt`);
    writeFileSync(pf, 'dung-passphrase-test-dai\n');
    env.BACKUP_PASSPHRASE_FILE = pf;
    vi.spyOn(settings, 'findOpenssl').mockReturnValue(null);
    expect(await backupMain(env)).toBe(1);
    for (const f of readdirSync(d))
      expect(readFileSync(join(d, f)).subarray(0, 5).toString()).not.toBe('PGDMP');
    expect(dumps(d)).toEqual([]);
    const rec = lastRec(d);
    expect(rec.status).toBe('fail');
    expect(rec.error).toContain('openssl');
  });

  it('P8.7c: login svc_backup → bằng chứng vào sổ; login người lỡ kiêm svc_backup → dump xong nhưng exit 4, 0 bằng chứng', async (ctx) => {
    if (!hasTool) return ctx.skip();
    const svc = `t_bk_svc_${process.pid}`;
    const human = `t_bk_hum_${process.pid}`;
    const pw = `p${randomBytes(8).toString('hex')}`;
    logins.push(svc, human);
    await adminQuery(`drop role if exists ${svc}`);
    await adminQuery(`drop role if exists ${human}`);
    await adminQuery(`create role ${svc} login password '${pw}' in role svc_backup`);
    await adminQuery(`create role ${human} login password '${pw}' in role svc_backup, app_human`);
    const as = (login: string) => {
      const u = new URL(dsn);
      u.username = login;
      u.password = pw;
      return u.toString();
    };
    let { env, d } = setup();
    env.DATABASE_URL = as(svc);
    let n0 = await nEvidence();
    expect(await backupMain(env)).toBe(0);
    expect(await nEvidence()).toBe(n0 + 1);
    ({ env, d } = setup());
    env.DATABASE_URL = as(human);
    n0 = await nEvidence();
    expect(await backupMain(env)).toBe(4);
    expect(lastRec(d).status).toBe('ok');
    expect(await nEvidence()).toBe(n0);
    expect(out()).toContain('[warn] backup xong nhưng CHƯA ghi được bằng chứng DB');
  });

  it('mất kết nối snapshot giữa lúc pg_dump chạy → exit 1 (không sập tiến trình), không còn .partial bản rõ, có dòng fail', async () => {
    // Python: psycopg.Error ở conn.rollback() → except → exit 1, finally xóa .partial, main ghi nhật ký.
    // TS cũ: client pg phát 'error' lúc rảnh không ai nghe → `Unhandled 'error' event` (57P01).
    const { env, d } = setup();
    const bin = join(root, `fakebin${k}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), '');
    env.PG_BIN = bin;
    const pf = join(root, `pass${k}.txt`);
    writeFileSync(pf, 'dung-passphrase-test-dai\n');
    env.BACKUP_PASSPHRASE_FILE = pf;
    env.BACKUP_REQUIRE_ENCRYPTION = '1';
    vi.spyOn(settings, 'findOpenssl').mockReturnValue('openssl-gia');
    vi.spyOn(settings, 'toolMajor').mockResolvedValue([99, 'pg_dump (gia) 99']);
    const killed: number[] = [];
    vi.spyOn(io, 'run').mockImplementation(async (argv, opts) => {
      expect(argv.includes('-Fc')).toBe(true); // openssl không được chạy
      writeFileSync(opts.stdoutFile as string, 'PGDMP-ban-ro-dang-ghi');
      const r = await pool.query<{ pid: number }>(
        "select pid from pg_stat_activity where datname = current_database() and state = 'idle in transaction' and pid <> pg_backend_pid()",
      );
      for (const { pid } of r.rows) {
        await pool.query('select pg_terminate_backend($1)', [pid]);
        killed.push(pid);
      }
      for (let i = 0; i < 50; i++) {
        const left = await pool.query('select 1 from pg_stat_activity where pid = any($1)', [
          killed,
        ]);
        if (!left.rowCount) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      await new Promise((res) => setTimeout(res, 500)); // FATAL tới client lúc nó đang rảnh
      writeFileSync(opts.stdoutFile as string, 'PGDMP-ban-ro-xong');
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    });
    expect(await backupMain(env)).toBe(1);
    expect(killed).toHaveLength(1);
    expect(readdirSync(d).filter((f) => f.endsWith('.partial'))).toEqual([]);
    for (const f of readdirSync(d))
      expect(readFileSync(join(d, f)).subarray(0, 5).toString()).not.toBe('PGDMP');
    expect(dumps(d)).toEqual([]);
    const lines = readFileSync(join(d, 'backup_runs.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ status: 'fail' });
    expect(lastRec(d).error).toMatch(/terminating connection/);
  });

  it('cuối file: không DB diễn tập nào của lần chạy này còn sót', async () => {
    const r = await pool.query('select datname from pg_database where datname like $1', [
      `${DRILL_PREFIX.replaceAll('_', '\\_')}%`,
    ]);
    expect(r.rows).toEqual([]);
  });
});
