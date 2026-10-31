import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import G from './__fixtures__/report.golden.json' with { type: 'json' };
import {
  type ChatStats,
  collectDb,
  fmtVnd,
  generate,
  listReports,
  type Marketing,
  periodBounds,
  queueSample,
  type Report,
  render,
  reportName,
  repSample,
  writeReport,
} from './report.js';
import { installFakeDeps } from './testing.js';

const d = (v: unknown) => new Date(v as string);
/** rep golden (JSON) → Report TS (Date cho mốc thời gian, tuple giữ nguyên). */
function toRep(r: Record<string, any>): Report {
  const db = r.db;
  if (db.db_ok) {
    db.leads.recent = db.leads.recent.map((x: unknown[]) => [d(x[0]), ...x.slice(1)]);
    db.farm.flags = db.farm.flags.map((x: unknown[]) => [d(x[0]), ...x.slice(1)]);
  }
  return {
    period: { days: r.period.days, since: d(r.period.since), until: d(r.period.until) },
    generated_at: d(r.generated_at),
    db,
    chat: r.chat,
    marketing: r.marketing as Marketing | null,
  };
}

const CHAT: ChatStats = {
  total: 1,
  answered: 1,
  in_period: 1,
  answered_period: 1,
  by_channel: { zalo: 1, messenger: 0, streamlit: 0 },
  by_channel_period: { zalo: 1, messenger: 0, streamlit: 0 },
  bad_ts: 0,
  skipped: 0,
};

describe('report golden (Python)', () => {
  it('render: đủ mục, *(mẫu)*, degraded "[chưa nạp]", mục 5 từ dict', () => {
    for (const c of G.renders) expect(render(toRep(structuredClone(c.rep)))).toBe(c.out);
  });

  it('fmtVnd / reportName / periodBounds', () => {
    for (const c of G.vnd) expect(fmtVnd(c.in)).toBe(c.out);
    expect(fmtVnd('6720000.00')).toBe('6.720.000 ₫'); // numeric từ pg là chuỗi
    for (const c of G.names) expect(reportName(d(c.since), d(c.until))).toBe(c.out);
    expect(periodBounds(7, '2026-10-10').map((x) => x.toISOString())).toEqual([
      '2026-10-03T17:00:00.000Z',
      '2026-10-10T17:00:00.000Z',
    ]);
  });
});

describe('writeReport', () => {
  it('atomic ghi đè, BYTES utf-8 (LF giữ nguyên), không .tmp sót; sổ đầu ra + nhãn CHẠY THỬ; TẮT → không ghi', async () => {
    const st = installFakeDeps(
      {},
      { reportFeature: (n) => (n.startsWith('intel-') ? 'intel-04.1' : null) },
    );
    const out = mkdtempSync(join(tmpdir(), 'report-'));
    const p = await writeReport('a\nb\n', out, 'report-x.md', true);
    await writeReport('c\nd\n', out, 'report-x.md', true);
    expect(readFileSync(p).toString('utf8')).toBe('c\nd\n');
    expect(readdirSync(out)).toEqual(['report-x.md']);
    expect(st.recorded.at(-1)).toEqual({
      name: 'report-x.md',
      text: 'c\nd\n',
      sample: true,
      fid: null,
    });
    st.quick = null;
    st.stages['intel-04.1'] = 'chay_thu';
    const p2 = await writeReport('nội dung', out, 'intel-doithu-2026-W40.md', false);
    expect(readFileSync(p2, 'utf8')).toBe(
      '> **CHẠY THỬ — KHÔNG GỬI.** Tính năng intel-04.1\n\nnội dung',
    );
    expect(st.recorded.at(-1)?.text).toBe(readFileSync(p2, 'utf8')); // sha của bản CÓ nhãn
    st.stages['intel-04.1'] = 'tat';
    await expect(writeReport('x', out, 'intel-doithu-2026-W41.md', false)).rejects.toThrow(
      /đang tắt/,
    );
    expect(readdirSync(out).sort()).toEqual(['intel-doithu-2026-W40.md', 'report-x.md']);
  });

  it('listReports: mới nhất trước, chỉ report-*.md; thư mục không có → []', () => {
    const out = mkdtempSync(join(tmpdir(), 'reports-'));
    for (const n of [
      'report-2026-10-04_2026-10-10.md',
      'report-2026-10-11_2026-10-17.md',
      'director-x.md',
    ]) {
      writeFileSync(join(out, n), '');
    }
    expect(listReports(out).map((p) => p.slice(out.length + 1))).toEqual([
      'report-2026-10-11_2026-10-17.md',
      'report-2026-10-04_2026-10-10.md',
    ]);
    expect(listReports(join(out, 'none'))).toEqual([]);
  });

  it('repSample: DB down / có mục mẫu → true', () => {
    expect(repSample({ db: { db_ok: false, db_error: 'x' } })).toBe(true);
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('report (DB)', () => {
  const name = testDbName('ops_report');
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(() => {
    installFakeDeps();
  });

  it('collectDb trên DB mẫu (core_store): đủ 3 nhóm, nhãn mẫu theo nguồn sample:', async () => {
    const [s, u] = periodBounds(3650, '2027-12-31');
    const db = await collectDb(pool, s, u);
    expect(db.db_ok).toBe(true);
    if (!db.db_ok) return;
    expect(Number(db.sales.count)).toBeGreaterThan(0);
    expect(db.sales.sample).toBe(
      Object.keys(db.sales.sources).every((k) => k.startsWith('sample:')),
    );
    expect(
      db.farm.flags.every(([, , , det]) =>
        /sâu bệnh|rệp|bệnh|chết|héo|vàng lá|nấm|dịch/.test(String(det).toLowerCase()),
      ),
    ).toBe(true);
    expect(
      render({
        period: { days: 3650, since: s, until: u },
        generated_at: new Date(),
        db,
        chat: CHAT,
        marketing: null,
      }),
    ).toContain('## 1. Bán hàng');
  });

  it('collectDb lỗi DB → degraded, không ném; generate DB down vẫn ghi file', async () => {
    const dead = createPool('postgresql://u@127.0.0.1:9/nope', { connectionTimeoutMillis: 1000 });
    const db = await collectDb(dead, new Date(0), new Date());
    expect(db.db_ok).toBe(false);
    await dead.end();
    const out = mkdtempSync(join(tmpdir(), 'gen-'));
    const [path, rep] = await generate({
      days: 7,
      until: '2026-10-10',
      outDir: out,
      db: null,
      collectors: { chat: () => CHAT, marketing: async () => ({ ok: false }) },
    });
    expect(path.endsWith('report-2026-10-04_2026-10-10.md')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(
      '*[chưa nạp — không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)]*',
    );
    expect(rep.marketing).toEqual({ ok: false, error: 'không kết nối được Postgres' });
    const [p2, r2] = await generate({
      until: '2026-10-10',
      outDir: out,
      db: pool,
      collectors: {
        chat: () => CHAT,
        marketing: async () => {
          const e = new Error('relation "content_drafts" does not exist') as Error & {
            code: string;
          };
          e.code = 'ECONNRESET';
          throw e;
        },
      },
    });
    expect(p2).toBe(path); // cùng kỳ → cùng tên, ghi đè
    expect(r2.db.db_ok).toBe(true);
    expect(r2.marketing).toMatchObject({ ok: false });
  });

  it('queueSample: mục mẫu / không có mục / lỗi → true (fail-closed)', async () => {
    expect(await queueSample(pool, 987654)).toBe(true);
    expect(await queueSample(pool, 'x')).toBe(true);
  });
});
