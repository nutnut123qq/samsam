import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import G from './__fixtures__/director.golden.json' with { type: 'json' };
import {
  BLOCKS,
  type DigestItem,
  type DirectorConfig,
  digest,
  directorCli,
  loadAll,
  loadConfig,
  type QaRun,
  run,
  submit,
  validate,
} from './director.js';
import { installFakeDeps } from './testing.js';

type Out = { ok?: unknown; error?: string; msg?: string };
const DATE_KEYS = ['created_at', 'due_at', 'decided_at', 'ts'];
/** Golden (ISO) → Date cho các cột thời gian. */
function dates<T>(rows: Record<string, unknown>[] | null): T[] | null {
  if (rows === null) return null;
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        DATE_KEYS.includes(k) && typeof v === 'string' ? new Date(v) : v,
      ]),
    ),
  ) as T[];
}

describe('director golden (Python)', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('validate: thông điệp lỗi y hệt', () => {
    for (const c of G.validate) {
      // KHÁC Python (biểu diễn): JSON không phân biệt 24.0 với 24 → TS nhận due_soon_hours 24.0.
      if (JSON.stringify(c.cfg).includes('"due_soon_hours":24}')) continue;
      let got: Out;
      try {
        validate(c.cfg, 'sales');
        got = { ok: true };
      } catch (e) {
        got = { error: (e as Error).name, msg: (e as Error).message };
      }
      const want = c.out as Out;
      if (want.error) expect(got.msg, JSON.stringify(c.cfg).slice(0, 120)).toBe(want.msg);
      else expect(got.ok).toBe(true);
    }
  });

  it('digest: chỉ đếm ngày VN, che PII tiêu đề, extra trước "Người duyệt"', () => {
    for (const c of G.digests) {
      const md = digest(
        c.cfg as unknown as DirectorConfig,
        dates<DigestItem>(c.items as Record<string, unknown>[]) as DigestItem[],
        new Date(c.now),
        dates(c.overrides as Record<string, unknown>[]) as never,
        dates<QaRun>(c.qa as Record<string, unknown>[] | null),
        c.extra,
      );
      expect(md).toBe(c.out);
    }
  });

  it('9 khối thật hợp lệ, chưa có người thật', () => {
    const all = loadAll();
    expect(Object.keys(all)).toEqual([...BLOCKS]);
    for (const c of Object.values(all)) expect(c.approvers).toEqual([]);
    expect(() => loadConfig('nope')).toThrow('không có file nope.json');
  });

  it('CLI: dry-run không DB; sai tham số → 2; DB down → 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn(async () => null);
    expect(await directorCli({ all: true, dryRun: true }, open)).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toContain('[done] 9 khối hợp lệ (dry-run, không DB)');
    expect(await directorCli({}, open)).toBe(2);
    expect(await directorCli({ block: 'projects' }, open)).toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect(await directorCli({ block: 'finance' }, open)).toBe(2);
    expect(
      err.mock.calls.some((c) => String(c[0]).includes('GHI ĐÈ bản của `python -m agents.acc_ar')),
    ).toBe(true);
    log.mockRestore();
    err.mockRestore();
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('director (DB)', () => {
  const name = testDbName('ops_director');
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });

  it('submit: SLA + risk từ cấu hình; qa_suite đọc eval_runs (bỏ -dirty, bỏ giá trị caller)', async () => {
    installFakeDeps();
    const cfg = loadConfig('sales');
    await expect(
      submit(pool, {
        block: 'sales',
        objectType: 'nope',
        objectId: '1',
        title: 't',
        payload: 'p',
        createdBy: 'agent:x',
        cfg,
      }),
    ).rejects.toThrow(/không nhận loại việc 'nope'/);
    const id = await submit(pool, {
      block: 'sales',
      objectType: 'cskh_reply',
      objectId: 'c1',
      title: 'Trả lời',
      payload: 'Dạ shop xin gửi giá',
      createdBy: 'agent:kd_a1',
      qaStatus: 'pass',
      qaSuite: 'kd_a1',
      cfg,
    });
    const r = (
      await pool.query(
        'select risk, qa_status, due_at - created_at as sla from approval_queue where id = $1',
        [String(id)],
      )
    ).rows[0];
    expect([r.risk, r.qa_status, r.sla.hours ?? r.sla.days * 24]).toEqual(['medium', 'none', 72]);
  });

  it('run: expire → auto_approve (không luật = bỏ qua) → bản tin file; sample theo is_sample; TẮT → không ghi', async () => {
    const st = installFakeDeps(
      {},
      { reportFeature: (n) => (n.startsWith('director-') ? 'ceo-01' : null) },
    );
    const cfg = loadConfig('farming');
    await submit(pool, {
      block: 'farming',
      objectType: Object.keys(cfg.object_types)[0] as string,
      objectId: 'p1',
      title: 'Khoảnh KV-A01 bỏ trống',
      payload: 'nhắc nhật ký',
      createdBy: 'agent:vt',
      cfg,
      sample: true,
    });
    const out = mkdtempSync(join(tmpdir(), 'director-'));
    const now = new Date();
    const [path, text] = await run(pool, 'farming', { now, cfg, outDir: out });
    expect(existsSync(path) && readFileSync(path, 'utf8')).toBe(text);
    expect(text).toContain('| Đang chờ duyệt (tồn) | 1 |');
    expect(st.recorded.at(-1)).toMatchObject({ sample: true });
    st.quick = null;
    st.stages['ceo-01'] = 'tat';
    await expect(run(pool, 'farming', { now, cfg, outDir: out })).rejects.toThrow(/đang tắt/);
    st.stages['ceo-01'] = 'chay_thu';
    const [p2] = await run(pool, 'farming', { now, cfg, outDir: out });
    expect(readFileSync(p2, 'utf8').startsWith('> **CHẠY THỬ — KHÔNG GỬI.**')).toBe(true);
  });
});
