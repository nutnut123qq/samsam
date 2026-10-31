import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { repoPath } from '@samsam/core/paths';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type CliDeps,
  intelImportMain,
  intelWeeklyMain,
  socialVendorMain,
} from './intel-import.command.js';
import * as ii from './intel-import.js';
import * as iw from './intel-weekly.js';
import * as sv from './social-vendor.js';

// Dịch phần KHÔNG DB của tests/test_intel_import.py (CLI argparse/exit code/không connect, muối,
// PII, nhãn), tests/test_social_vendor.py (cổng TGĐ fail-closed trước mọi đọc/connect), tests/
// test_intel_weekly.py + test_v14_p5_mkt_ceo_intel.py (CLI usage, tuần mặc định, payload qua
// guardrail) và kiểm TĨNH cách ly (không mạng, không hàng duyệt nội dung, chỉ ghi bảng của mình).
// "Connect" = gọi factory pool (spy đếm) — test không bao giờ tới DB thật.

const FIX = repoPath('tests/fixtures/intel_import');
const VFIX = repoPath('tests/fixtures/social_vendor');
const COMP = join(FIX, 'competitor_MAU.csv');
const TL = join(FIX, 'multiTimeline_MAU.csv');
const REL = join(FIX, 'relatedQueries_MAU.csv');
const SOC = join(FIX, 'social_fanpage_MAU.csv');
const SALT = 'salt-test-MAU-0123456789';
const DEAD = 'postgresql://u@127.0.0.1:9/khong_ton_tai';
const tmp = mkdtempSync(join(tmpdir(), 'intel-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cap = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

/** Factory pool đếm số lần "connect": trỏ host chết (lỡ connect thì lỗi, không chạm DB nào). */
function spyPool() {
  const s = { n: 0 };
  const pool = (_dsn: string, env: Env): pg.Pool => {
    s.n++;
    return createPool(DEAD, { connectionTimeoutMillis: 2000 }, env);
  };
  return { s, pool };
}

async function run(
  argv: Parameters<typeof intelImportMain>[0],
  env: Env = { DATABASE_URL: DEAD, INTEL_HASH_SALT: SALT },
  extra: Partial<CliDeps> = {},
) {
  const c = cap();
  const p = spyPool();
  const rc = await intelImportMain(argv, {
    io: c.io,
    env,
    pool: p.pool,
    clock: () => new Date('2026-10-12T12:00:00+07:00'),
    ...extra,
  });
  return { rc, n: p.s.n, out: c.out.join('\n'), err: c.err.join('\n') };
}

describe('intel_import CLI (không DB)', () => {
  it.each([
    [{}],
    [{ competitor: COMP, trend: TL }],
    [{ competitor: COMP, seed: 'nhân sâm' }],
    [{ competitor: COMP, channel: 'fanpage' }],
    [{ social: SOC }],
    [{ social: SOC, channel: 'facebook' }],
    [{ trend: REL }],
    [{ trend: REL, seed: 'từ khóa lạ' }],
    [{ trend: TL, seed: 'nhân sâm' }],
  ])('usage → exit 2, không connect %#', async (argv) => {
    const r = await run(argv);
    expect([r.rc, r.n]).toEqual([2, 0]);
    expect(r.err).toMatch(/^intel_import: error: /);
  });

  it.each([
    [{ competitor: join(FIX, 'competitor_bad_gia_MAU.csv') }],
    [{ trend: join(FIX, 'multiTimeline_no_anchor_MAU.csv') }],
    [{ trend: join(FIX, 'multiTimeline_daily_MAU.csv') }],
    [{ social: join(FIX, 'social_bad_cot_la_MAU.csv'), channel: 'fanpage' }],
    [{ social: join(FIX, 'social_bad_thoi_gian_MAU.csv'), channel: 'fanpage' }],
  ])('file hỏng → exit 1, không connect, không in giá trị ô %#', async (argv) => {
    const r = await run(argv);
    expect([r.rc, r.n]).toEqual([1, 0]);
    expect(r.out).toContain('không connect');
    expect(r.out).not.toContain('abc123xyz');
  });

  it('social thiếu/ngắn muối → exit 1 trước connect', async () => {
    const argv = { social: SOC, channel: 'fanpage' };
    const a = await run(argv, { DATABASE_URL: DEAD });
    const b = await run(argv, { DATABASE_URL: DEAD, INTEL_HASH_SALT: 'ngan' });
    expect([a.rc, a.n, b.rc, b.n]).toEqual([1, 0, 1, 0]);
    expect(a.out).toContain('INTEL_HASH_SALT');
  });

  it('muối đủ → qua cổng, tới bước connect (host chết → exit 1)', async () => {
    const r = await run({ social: SOC, channel: 'fanpage' });
    expect([r.rc, r.n]).toEqual([1, 1]);
    expect(r.out).toContain('[err] không kết nối được Postgres: OperationalError');
  });

  it('connect lỗi → exit 1; thiếu DSN → exit 1, không connect', async () => {
    expect((await run({ competitor: COMP })).rc).toBe(1);
    const r = await run({ competitor: COMP }, {});
    expect([r.rc, r.n]).toEqual([1, 0]);
    expect(r.out).toContain('thiếu DATABASE_URL');
  });

  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2 (bind_service loader), không connect', async () => {
    const r = await run({ competitor: COMP }, { APPROVAL_ENFORCE: '1', DATABASE_URL: DEAD });
    expect([r.rc, r.n]).toEqual([2, 0]);
    expect(r.out).toContain('LOADER_DATABASE_URL');
  });

  it('LOADER_DATABASE_URL (dev) được ưu tiên hơn DATABASE_URL', async () => {
    const seen: string[] = [];
    const c = cap();
    const rc = await intelImportMain(
      { competitor: COMP },
      {
        io: c.io,
        env: { LOADER_DATABASE_URL: DEAD, DATABASE_URL: 'postgresql://x@127.0.0.1:9/khac' },
        pool: (dsn, env) => {
          seen.push(dsn);
          return createPool(dsn, { connectionTimeoutMillis: 2000 }, env);
        },
      },
    );
    expect([rc, seen]).toEqual([1, [DEAD]]);
  });

  it('cấu hình trend_keywords hỏng → exit 1 (fail-closed), không connect', async () => {
    const p = join(tmp, 'kw.json');
    writeFileSync(p, '{');
    const r = await run({ trend: TL }, undefined, { keywordsFile: p });
    expect([r.rc, r.n]).toEqual([1, 0]);
    expect(r.out).toContain('kw.json: không đọc được (JSONDecodeError)');
  });

  it('read_social: cột định danh bỏ NGAY; dữ liệu đã đọc không còn PII', async () => {
    const p = join(tmp, 's_MAU.csv');
    writeFileSync(
      p,
      'thoi_gian,noi_dung,ten_nguoi_dung,sdt,email,link_profile,avatar,id_nguoi_dung\n' +
        '2026-10-05 08:00,Sâm ngon gọi 0912 345 678,Tên Giả MAU,0905000111,x@example.com,' +
        'https://fb.example/u1,https://img.example/a.png,uid-MAU-1\n',
    );
    const [rows, errs] = await ii.readSocial(
      p,
      'fanpage',
      ii.loadSocialRules()[0] as ii.SocialRules,
    );
    expect(errs).toEqual([]);
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ['excerpt', 'key', 'kind', 'labels', 'posted_at', 'row_no', 'sensitive'].sort(),
    );
    const dump = JSON.stringify(rows.map(({ key: _k, ...r }) => r));
    for (const s of ['Tên Giả MAU', '0905000111', 'x@example.com', 'uid-MAU-1', '0912 345 678']) {
      expect(dump).not.toContain(s);
    }
    // vật liệu hash (chỉ RAM) cũng đã che SĐT nội dung
    expect((rows[0] as ii.SocialRow).key).not.toContain('0912 345 678');
  });
});

describe('social_vendor CLI (không DB)', () => {
  const APPROVED = { vendor_approved_by_tgd: true, approval_ref: 'BB-TEST-01', vendor_name: 'V' };
  const cfgFile = (body: unknown): string => {
    const p = join(tmp, `sv_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };
  async function vrun(file: string | undefined, configFile: string, env?: Env) {
    const c = cap();
    const p = spyPool();
    const rc = await socialVendorMain(
      { file },
      {
        io: c.io,
        env: env ?? { DATABASE_URL: DEAD, INTEL_HASH_SALT: SALT },
        pool: p.pool,
        configFile,
        clock: () => new Date('2026-10-12T12:00:00+07:00'),
      },
    );
    return { rc, n: p.s.n, out: c.out.join('\n'), err: c.err.join('\n') };
  }

  it('cấu hình repo mặc định CHẶN: exit 2, không đọc file, không connect', async () => {
    const raw = readFileSync(sv.CONFIG_FILE, 'utf8');
    expect(raw).toContain('"vendor_approved_by_tgd": false');
    expect(JSON.parse(raw)._doc).toContain('CHỈ người thật');
    // tệp không tồn tại: nếu module đọc file trước cổng thì đã ra exit 1
    const r = await vrun(join(tmp, 'khong_ton_tai.csv'), sv.CONFIG_FILE);
    expect([r.rc, r.n]).toEqual([2, 0]);
    expect(r.out).toContain('[blocked] nhà cung cấp chưa được TGĐ duyệt');
  });

  it.each([
    ['thieu-file', null],
    ['json-hong', '{'],
    ['goc-list', '[]'],
    ['chuoi-true', { ...APPROVED, vendor_approved_by_tgd: 'true' }],
    ['so-1', { ...APPROVED, vendor_approved_by_tgd: 1 }],
    ['ref-rong', { ...APPROVED, approval_ref: '' }],
    ['ref-trang', { ...APPROVED, approval_ref: '   ' }],
    ['ref-null', { ...APPROVED, approval_ref: null }],
    ['thieu-key', { approval_ref: 'BB', vendor_name: 'V' }],
  ])('chưa duyệt (%s) → exit 2, không đọc, không connect', async (_n, body) => {
    const cfg = body === null ? join(tmp, 'missing_sv.json') : cfgFile(body);
    const r = await vrun(join(tmp, 'khong_ton_tai.csv'), cfg);
    expect([r.rc, r.n]).toEqual([2, 0]);
    expect(r.out).toContain('[blocked]');
  });

  it('duyệt đúng → qua cổng', () => {
    expect(sv.checkApproval(cfgFile(APPROVED))).toBeNull();
  });

  it.each([
    [join(VFIX, 'vendor_bad_column.csv'), 'cột lạ'],
    [join(VFIX, 'vendor_bad_platform.csv'), 'nen_tang'],
  ])('file hỏng → exit 1, không connect, không in định danh (%s)', async (f, needle) => {
    const r = await vrun(f, cfgFile(APPROVED));
    expect([r.rc, r.n]).toEqual([1, 0]);
    expect(r.out).toContain(needle);
    expect(r.out).not.toContain('nguoidanggia');
  });

  it('thiếu muối → exit 1, không connect; thiếu --file → exit 2', async () => {
    const r = await vrun(join(VFIX, 'vendor_export.csv'), cfgFile(APPROVED), {
      DATABASE_URL: DEAD,
      INTEL_HASH_SALT: 'short',
    });
    expect([r.rc, r.n]).toEqual([1, 0]);
    expect(r.out).toContain('INTEL_HASH_SALT');
    expect((await vrun(undefined, cfgFile(APPROVED))).rc).toBe(2);
  });
});

describe('intel_weekly CLI (không DB)', () => {
  async function wrun(o: Parameters<typeof intelWeeklyMain>[0], env: Env = { DATABASE_URL: DEAD }) {
    const c = cap();
    const p = spyPool();
    const rc = await intelWeeklyMain(o, { io: c.io, env, pool: p.pool });
    return { rc, n: p.s.n, out: c.out.join('\n'), err: c.err.join('\n') };
  }

  it.each([
    [{ import: '3' }],
    [{ dryRun: true }],
    [{ suggestKeywords: true, week: '2026-10-08' }],
    [{ suggestKeywords: true, llm: true }],
    [{ suggestKeywords: true, outDir: 'x' }],
    [{ suggestKeywords: true, import: 'abc' }],
    [{ week: '2026-13-40' }],
  ])('usage → exit 2, không connect %#', async (o) => {
    const r = await wrun(o);
    expect([r.rc, r.n]).toEqual([2, 0]);
    expect(r.err).toMatch(/^intel_weekly\.py: error: /);
  });

  it('thiếu DATABASE_URL → exit 1; host chết → exit 1', async () => {
    expect((await wrun({ week: '2026-10-08' }, {})).rc).toBe(1);
    const r = await wrun({ week: '2026-10-08' });
    expect([r.rc, r.n]).toEqual([1, 1]);
  });

  it('tuần mặc định = tuần ĐỦ gần nhất theo giờ VN', () => {
    // thứ Tư 14/10/2026 (giờ VN) → tuần 05/10–11/10
    const today = ii.todayVn(new Date('2026-10-13T18:30:00Z'));
    expect(today).toBe('2026-10-14');
    const w = iw.weekBounds(iw.defaultWeekDay(today));
    expect([w.mon, w.sun]).toEqual(['2026-10-05', '2026-10-11']);
  });

  it('payload gợi ý từ khóa qua guardrail, không chép từ khóa bị loại', async () => {
    const { check } = await import('@samsam/core/security/guardrail');
    const text = iw.renderKeywords({
      import_id: 7,
      file_name: 'related_MAU.csv',
      safe: [
        [1, 'sâm ngọc linh', 'rising', 'hộp quà sâm', '+250%'],
        [2, null, 'top', 'sâm ngọc linh giá', '100'],
      ],
      excluded: [
        [3, ['tu_cam', 'suc_khoe']],
        [4, ['ruou']],
        [5, ['cong_dung']],
        [6, ['pii']],
      ],
    });
    expect(check(text).ok).toBe(true);
    expect(text).toContain('hộp quà sâm');
    expect(text).toContain('trends_related #3');
    expect(text).not.toContain('rượu');
    expect(text).not.toContain('chữa');
  });

  it('danh sách đối thủ của repo CHƯA duyệt → khớp theo từ, không chuỗi con', () => {
    const c = iw.loadCompetitors();
    expect([c.approved, c.action, c.by]).toEqual([false, null, null]);
    expect(iw.competitorHit('Nhân Sâm Hàn Quốc', c)).toBe('han quoc');
    expect(iw.competitorHit('hồng sâm', c)).toBeNull();
    expect(iw.competitorHit('mỹ phẩm sâm', c)).toBeNull();
  });
});

// ------------------------------------------------------------------ tĩnh (cách ly)

const SRC = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8');
const MODS = [
  'intel-import.ts',
  'social-vendor.ts',
  'intel-weekly.ts',
  'table.ts',
  'intel-import.command.ts',
];

describe('cách ly tĩnh', () => {
  it('không có đường mạng / thư viện Trends không chính thức', () => {
    for (const f of MODS) {
      const s = SRC(f);
      expect(s, f).not.toMatch(
        /from 'node:(http|https|net|tls|dgram)'|\bfetch\(|pytrends|trends\.google/,
      );
    }
  });

  it('không đường sang nháp nội dung/kênh; chỉ ghi bảng của nhóm', () => {
    for (const f of MODS) {
      const s = SRC(f);
      expect(s, f).not.toMatch(
        /content_drafts|ops\/store|saveDraft|modules\/(zalo|messenger|channels)/,
      );
    }
    const hits = (s: string) =>
      new Set(
        [...s.matchAll(/(insert into|update|delete from) +([a-z_]+)/gi)].map((m) =>
          (m[2] as string).toLowerCase(),
        ),
      );
    const own = hits(SRC('intel-import.ts'));
    expect([...own].sort()).toEqual(
      [
        'competitor_observations',
        'intel_imports',
        'social_mentions',
        'trends_related',
        'trends_weekly',
      ].sort(),
    );
    // không bao giờ ghi golden
    expect(SRC('intel-import.ts')).not.toMatch(
      /(insert into|update|delete from) +(sku_master|price_list|products)/i,
    );
    // vendor: CHỈ social_mentions_vendor (+ intel_imports qua newImport), KHÔNG social_mentions kênh sở hữu
    expect([...hits(SRC('social-vendor.ts'))]).toEqual(['social_mentions_vendor']);
    // báo cáo tuần: không câu ghi nào (đường ghi duy nhất = submit hàng duyệt intel)
    expect(hits(SRC('intel-weekly.ts')).size).toBe(0);
  });

  it('báo cáo tuần mở kết nối READ ONLY', () => {
    const s = SRC('intel-import.command.ts');
    expect(s).toContain('default_transaction_read_only=on');
    expect(s).toMatch(/defaultPool\)\(dsn, env, true\)/);
  });
});
