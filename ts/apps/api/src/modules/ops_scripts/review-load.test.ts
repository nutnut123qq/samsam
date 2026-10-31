import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { dataPath } from '@samsam/core/paths';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  capFor,
  collect,
  loadQuota,
  type Quota,
  QuotaError,
  render,
  reviewLoadMain,
  type Stats,
} from './review-load.js';

// Dịch tests/test_review_load.py: quota (hỏng → lỗi), trần theo phase + ngày vắng, CLI exit 2 TRƯỚC
// connect, DB không tới được exit 1, SQL chỉ SELECT, render thuần, DB test: ngày theo giờ VN (session
// UTC), không in text/brief, tên người duyệt có ký tự điều khiển bị thay.

const QUOTA = loadQuota(dataPath('review_quota.json'));
const root = mkdtempSync(join(tmpdir(), 'ops-rl-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const write = (obj: unknown) => {
  const p = join(root, `q${n++}.json`);
  writeFileSync(p, Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  return p;
};
afterEach(() => vi.restoreAllMocks());
const phases = (...ph: unknown[]) => ({ status: 'de_xuat', phases: ph, absent_days: [] });

describe('quota', () => {
  const bad: [string, unknown][] = [
    ['json-hong', Buffer.from('{not json')],
    ['khong-utf8', Buffer.from([0xff, 0xfe])],
    ['khong-object', []],
    ['phases-rong', { phases: [] }],
    ['ngay-sai', phases({ from: '2026-13-01', to: null, daily_cap: 5 })],
    ['ngay-dinh-dang', phases({ from: '2026/10/01', to: null, daily_cap: 5 })],
    ['cap-am', phases({ from: '2026-10-01', to: null, daily_cap: -1 })],
    ['cap-str', phases({ from: '2026-10-01', to: null, daily_cap: '25' })],
    ['cap-bool', phases({ from: '2026-10-01', to: null, daily_cap: true })],
    [
      'cap-float',
      Buffer.from('{"phases": [{"from": "2026-10-01", "to": null, "daily_cap": 5.0}]}'),
    ],
    [
      'chong-bien',
      phases(
        { from: '2026-10-01', to: '2026-10-20', daily_cap: 5 },
        { from: '2026-10-20', to: null, daily_cap: 6 },
      ),
    ],
    [
      'chong-mo',
      phases(
        { from: '2026-10-01', to: null, daily_cap: 5 },
        { from: '2026-12-01', to: null, daily_cap: 6 },
      ),
    ],
    ['to-truoc-from', phases({ from: '2026-10-10', to: '2026-10-01', daily_cap: 5 })],
    [
      'absent-sai',
      { ...phases({ from: '2026-10-01', to: null, daily_cap: 5 }), absent_days: ['hôm nay'] },
    ],
  ];
  it.for(bad)('%s → QuotaError', ([, body]) => {
    expect(() => loadQuota(write(body))).toThrow(QuotaError);
  });

  it('tệp không có → QuotaError (FileNotFoundError)', () => {
    expect(() => loadQuota(join(root, 'khong-co.json'))).toThrow(
      'quota không đọc được: FileNotFoundError',
    );
  });

  it('quota repo là ĐỀ XUẤT 25/35/55', () => {
    expect(QUOTA.status).toBe('de_xuat');
    expect(QUOTA.phases.map((p) => p[2])).toEqual([25, 35, 55]);
  });

  it.for([
    ['2026-10-31', 25],
    ['2026-11-01', 35],
    ['2026-11-15', 35],
    ['2026-11-16', 55],
    ['2027-06-01', 55],
    ['2026-09-30', null],
  ] as const)('cap_for %s → %s', ([day, cap]) => {
    expect(capFor(day, QUOTA)).toBe(cap);
  });

  it('ngày vắng → trần 0', () => {
    const raw = JSON.parse(readFileSync(dataPath('review_quota.json'), 'utf8'));
    raw.absent_days = ['2026-10-12'];
    const q = loadQuota(write(raw));
    expect(capFor('2026-10-12', q)).toBe(0);
    expect(capFor('2026-10-13', q)).toBe(25);
  });
});

describe('CLI', () => {
  const noConnect = vi.fn(async () => {
    throw new Error('không được connect DB khi tham số sai');
  });

  it.for([
    { today: '2026-13-01' },
    { today: '12/10/2026' },
    { days: '0' },
    { days: '367' },
    { days: 'bay' },
    { today: '2026-09-01' },
  ])('%o → exit 2 trước connect', async (o) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await reviewLoadMain(o, { connect: noConnect })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^\[err\] /);
    expect(noConnect).not.toHaveBeenCalled();
  });

  it('quota hỏng → exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await reviewLoadMain(
        { quota: write(Buffer.from('{')), today: '2026-10-12' },
        { connect: noConnect },
      ),
    ).toBe(2);
  });

  it('DB không tới được → exit 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await reviewLoadMain({ today: '2026-10-12' }, { connect: async () => null })).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('DB không truy cập được');
  });

  it('thiếu bảng (UndefinedTable) → exit 1 kèm tên lỗi', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      query: async () => {
        throw Object.assign(new pg.DatabaseError('relation does not exist', 0, 'error'), {
          code: '42P01',
        });
      },
    };
    expect(
      await reviewLoadMain({ today: '2026-10-12' }, { connect: async () => db as never }),
    ).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toBe('[err] DB không truy cập được (UndefinedTable)');
  });

  it('host chết thật (DATABASE_URL không tới được) → exit 1, không treo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await reviewLoadMain(
        { today: '2026-10-12' },
        { env: { DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' } },
      ),
    ).toBe(1);
  });
});

const stats = (
  queueTotal = 0,
  tp: Stats['throughput'] = {},
  inflow: Stats['inflow'] = {},
  days = 7,
): Stats => ({
  today: '2026-10-12',
  days,
  start: '2026-10-06',
  queue: { vao_hang: queueTotal, tra_tac_gia: 0, khong_ro: 0 },
  queue_total: queueTotal,
  oldest_age_days: null,
  inflow,
  throughput: tp,
});

describe('render + collect chỉ đọc', () => {
  it('vắng / nháp vào nhanh / bằng trần', () => {
    const raw = JSON.parse(readFileSync(dataPath('review_quota.json'), 'utf8'));
    raw.absent_days = ['2026-10-12'];
    raw.status = 'chot';
    const q: Quota = loadQuota(write(raw));
    let out = render(stats(3), q, '2026-10-12');
    expect(out).toContain('người duyệt vắng');
    expect(out).toContain('không ai được duyệt thay');
    expect(out).not.toContain('ĐỀ XUẤT');
    out = render(stats(0, {}, { '2026-10-12': 26 * 7 }), QUOTA, '2026-10-12');
    expect(out).toContain('nháp vào nhanh hơn trần');
    expect(out).toContain('không hạ chuẩn');
    out = render(stats(25), QUOTA, '2026-10-12');
    expect(out).not.toContain('QUÁ TẢI');
    expect(out).toContain('Không có cảnh báo tải.');
  });

  it('collect chỉ chạy 3 câu SELECT', async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        return {
          rows: sql.includes("content_drafts where status = 'pending'")
            ? [{ g: 'vao_hang', n: '2', d: '2026-10-10' }]
            : [],
        };
      },
    };
    const s = await collect(db as never, '2026-10-12', 7);
    expect(sqls).toHaveLength(3);
    for (const q of sqls) {
      expect(q.trimStart().toLowerCase().startsWith('select')).toBe(true);
      for (const w of ['insert', 'update ', 'delete', 'drop', 'alter', 'truncate', 'set_status']) {
        expect(q.toLowerCase()).not.toContain(w);
      }
    }
    expect(s.queue_total).toBe(2);
    expect(s.oldest_age_days).toBe(2);
  });

  it('OWASP A09: tên có ANSI/xuống dòng → thay "?", trùng sau thay thì cộng dồn', async () => {
    const rows = [
      { d: '2026-10-11', who: '\x1b[31mA', n: '20' },
      { d: '2026-10-11', who: '\n[31mA', n: '7' },
    ];
    const db = {
      query: async (sql: string) => ({ rows: sql.includes('from approvals') ? rows : [] }),
    };
    const s = await collect(db as never, '2026-10-12', 7);
    expect(s.throughput).toEqual({ '2026-10-11': { '?[31mA': 27 } });
    const out = render(s, QUOTA, '2026-10-12');
    expect(out).not.toContain('\x1b');
    expect(out).toContain('QUÁ TẢI: ?[31mA 27');
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('review_load trên DB test (session UTC)', () => {
  const name = testDbName('ops_rload');
  let pool: pg.Pool;
  const SHA = 'a'.repeat(64);
  beforeAll(async () => {
    // Session TZ UTC (server prod thường UTC) → chỉ code đổi giờ VN mới đúng biên ngày.
    pool = createPool(await createDbFromTemplate(name), { options: '-c TimeZone=UTC' });
    // DB mẫu không có nháp/quyết định nào — kiểm để số đếm tuyệt đối bên dưới có nghĩa.
    const r = await pool.query(
      'select (select count(*) from content_drafts)::int as a, (select count(*) from approvals)::int as b',
    );
    expect(r.rows[0]).toEqual({ a: 0, b: 0 });
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });

  const draft = (ok: boolean | null, status = 'pending', created = '2026-10-12T02:00:00Z') =>
    pool.query(
      "insert into content_drafts (created_at, brief, channel, text, guardrail, status, source) values ($1, 'BRIEF_BI_MAT', 'facebook', 'TEXT_BI_MAT', $2::jsonb, $3, 'cli')",
      [
        created,
        JSON.stringify(
          ok === null
            ? { violations: [], matched_claims: [] }
            : { ok, violations: [], matched_claims: [] },
        ),
        status,
      ],
    );
  const appr = (who: string, at: string, decision = 'approved') =>
    pool.query(
      "insert into approvals (object_type, object_id, content_sha256, decision, approved_by, approved_at) values ('content_draft', '1', $1, $2, $3, $4)",
      [SHA, decision, who, at],
    );

  it('đếm theo NGÀY VN, không ghi gì, không in text/brief', async () => {
    for (let i = 0; i < 26; i++) {
      // 1 mục cũ: 17:30Z 07/10 = 00:30 VN 08/10 → tuổi 4 + inflow ngày 08 CHỈ đúng khi tính ngày VN.
      await draft(true, 'pending', i === 0 ? '2026-10-07T17:30:00Z' : undefined);
    }
    // Biên đầu cửa sổ (start 06/10 VN): 16:30Z 05/10 = 23:30 VN 05/10 (ngoài); 17:30Z 05/10 = 00:30 VN 06/10.
    await draft(true, 'approved', '2026-10-05T16:30:00Z');
    await draft(true, 'approved', '2026-10-05T17:30:00Z');
    for (let i = 0; i < 3; i++) await draft(false);
    await draft(null);
    for (const st of ['approved', 'approved', 'rejected', 'rejected']) await draft(true, st);
    for (let i = 0; i < 24; i++)
      await appr('REVIEWER_A', '2026-10-11T03:00:00Z', i % 5 === 0 ? 'rejected' : 'approved');
    await appr('  REVIEWER_A ', '2026-10-11T03:00:00Z'); // btrim gộp cùng người
    await appr('REVIEWER_A', '2026-10-11T16:30:00Z'); // 23:30 VN 11/10
    await appr('REVIEWER_A', '2026-10-11T17:30:00Z'); // 00:30 VN 12/10
    for (let i = 0; i < 5; i++) await appr('REVIEWER_B', '2026-10-10T04:00:00Z');
    await appr('REVIEWER_B', '2026-10-01T04:00:00Z');
    const count = async () =>
      (
        await pool.query(
          'select (select count(*) from content_drafts) as a, (select count(*) from approvals) as b',
        )
      ).rows[0];
    const before = await count();
    const s = await collect(pool, '2026-10-12', 7);
    expect(await count()).toEqual(before);
    expect(s.queue).toEqual({ vao_hang: 26, tra_tac_gia: 3, khong_ro: 1 });
    expect(s.queue_total).toBe(27);
    expect(s.oldest_age_days).toBe(4);
    expect(s.start).toBe('2026-10-06');
    expect(s.inflow).toEqual({ '2026-10-06': 1, '2026-10-08': 1, '2026-10-12': 33 });
    expect(s.throughput).toEqual({
      '2026-10-10': { REVIEWER_B: 5 },
      '2026-10-11': { REVIEWER_A: 26 },
      '2026-10-12': { REVIEWER_A: 1 },
    });
    const out = render(s, QUOTA, '2026-10-12');
    expect(out).toContain('QUÁ TẢI: hàng chờ 27 mục > trần 25/ngày — cần ≥ 2 ngày');
    expect(out).toContain('QUÁ TẢI: REVIEWER_A 26 quyết định ngày 2026-10-11 > trần 25');
    expect(out).toContain('rủi ro duyệt vội');
    expect(out).not.toContain('REVIEWER_B 5 quyết định');
    expect(out).not.toContain('nháp vào nhanh hơn trần');
    expect(out).toContain('Quota ĐỀ XUẤT, chưa TGĐ chốt');
    expect(out).toContain('trả tác giả 3');
    expect(out).toContain('KHÔNG RÕ 1');
    expect(out).not.toContain('BI_MAT');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(
      await reviewLoadMain({ today: '2026-10-12', days: '7' }, { connect: async () => pool }),
    ).toBe(0);
    const printed = write.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('cần ≥ 2 ngày');
    expect(printed).toContain('REVIEWER_A 26');
  });
});
