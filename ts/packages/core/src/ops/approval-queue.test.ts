import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import {
  approvalQueueCli,
  autoApprove,
  decide,
  enqueue,
  expireOverdue,
  override,
  pending,
  verify,
} from './approval-queue.js';
import type { Db } from './deps.js';
import { installFakeDeps } from './testing.js';

// Dịch tests/test_approval_queue.py + phần hàng duyệt của tests/test_director_framework.py — luật ở DB
// (enqueue_item/decide_item/override_qa/auto_approve_item/expire_overdue) được GỌI thật.

/** Db giả: mọi truy vấn ném — chứng minh bước bị chặn TRƯỚC khi chạm DB. */
const NO_DB = {
  query: () => {
    throw new Error('không được chạm DB');
  },
} as unknown as Db;

const base = (over: Partial<Parameters<typeof enqueue>[1]> = {}) => ({
  objectType: 'koc_brief',
  objectId: `o${Math.random().toString(36).slice(2, 10)}`,
  block: 'marketing',
  title: 'Brief KOC',
  payload: 'Nội dung brief sạch',
  risk: 'medium',
  createdBy: 'agent:mkt',
  slaHours: 48,
  ...over,
});

describe('approval-queue không DB', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('enqueue: created_by / payload rỗng → lỗi trước DB', async () => {
    await expect(enqueue(NO_DB, base({ createdBy: '  ' }))).rejects.toThrow(
      'enqueue: thiếu created_by',
    );
    await expect(enqueue(NO_DB, base({ payload: '\n\t ' }))).rejects.toThrow(
      'enqueue: payload rỗng',
    );
  });

  it('decide/override: đầu vào xấu → không chạm DB', async () => {
    expect(await decide(NO_DB, 1, 'Bà A', 'maybe')).toEqual([
      false,
      "quyết định 'maybe' không hợp lệ — approved|rejected",
    ]);
    expect(await decide(NO_DB, 1, ' ', 'approved')).toEqual([
      false,
      'thiếu tên người duyệt (--by)',
    ]);
    expect(await decide(NO_DB, 'x1', 'Bà A', 'approved')).toEqual([false, "id 'x1' không hợp lệ"]);
    expect(await decide(NO_DB, 1, 'agent:x', 'approved')).toEqual([
      false,
      "mục #1: 'agent:x' không phải người — agent/hệ thống KHÔNG được approve",
    ]);
    expect((await override(NO_DB, 'x', 'Bà A', 'lý do đủ dài'))[1]).toBe("id 'x' không hợp lệ");
    expect((await override(NO_DB, 1, 'Bà A', ' a \n b \t c '))[1]).toMatch(/≥ 10 ký tự/);
    expect(await verify(NO_DB, 'x', 't')).toBe(false);
  });

  it('CLI: sai tham số → exit 2 TRƯỚC khi mở DB; DB down → 2', async () => {
    const open = vi.fn(async () => null);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const o of [
      {},
      { pending: true, expire: true },
      { approve: '1' },
      { overrideQa: '1', by: 'Bà A' },
      { approve: 'abc', by: 'Bà A' },
      { approve: '1', reject: '2', by: 'Bà A' },
    ]) {
      expect(await approvalQueueCli(o, open), JSON.stringify(o)).toBe(2);
    }
    expect(open).not.toHaveBeenCalled();
    expect(await approvalQueueCli({ pending: true }, open)).toBe(2);
    err.mockRestore();
  });
});

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('approval-queue (DB)', () => {
  const name = testDbName('ops_aq');
  let pool: pg.Pool;
  let url: string;
  beforeAll(async () => {
    url = await createDbFromTemplate(name);
    pool = createPool(url);
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(() => {
    installFakeDeps();
  });
  const row = async (id: bigint) =>
    (await pool.query('select * from approval_queue where id = $1', [String(id)])).rows[0];

  it('enqueue TỰ tính guardrail (không nhận của caller); sample → is_sample', async () => {
    const id = await enqueue(pool, base({ payload: 'Sâm chữa bách bệnh' }));
    const r = await row(id);
    expect([r.status, r.guardrail.ok, r.is_sample, r.created_by]).toEqual([
      'pending',
      false,
      false,
      'agent:mkt',
    ]);
    expect(r.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const s = await enqueue(pool, base({ sample: true }));
    expect((await row(s)).is_sample).toBe(true);
  });

  it('decide approve: kiểm LẠI payload từ DB (snapshot giả ok không qua)', async () => {
    installFakeDeps({ guardrailCheck: () => ({ ok: true, violations: [] }) }); // agent "giả" ok lúc enqueue
    const id = await enqueue(pool, base({ payload: 'Sâm chữa bách bệnh' }));
    installFakeDeps();
    const [ok, msg] = await decide(pool, id, 'Bà Duyệt', 'approved');
    expect([ok, msg]).toEqual([
      false,
      `mục #${id} vi phạm guardrail khi kiểm lại (1 vi phạm) — phải reject hoặc viết lại`,
    ]);
    expect((await row(id)).status).toBe('pending');
    expect(await decide(pool, id, 'Bà Duyệt', 'rejected', 'viết lại')).toEqual([true, null]);
    expect((await row(id)).status).toBe('rejected');
  });

  it('decide: happy path; người tạo không tự duyệt; lỗi function DB → thông điệp tiếng Việt', async () => {
    const id = await enqueue(pool, base());
    expect((await decide(pool, id, ' agent:mkt ', 'approved'))[0]).toBe(false);
    expect(await decide(pool, id, ' Bà Duyệt ', 'approved', 'ok')).toEqual([true, null]);
    const r = await row(id);
    expect([r.status, r.lane, r.decided_by]).toEqual(['approved', 'per_item', 'Bà Duyệt']);
    expect(await decide(pool, id, 'Bà Khác', 'rejected')).toEqual([
      false,
      `mục #${id}: mục #${id} đã ở trạng thái approved, chỉ quyết từ pending`,
    ]);
    expect((await decide(pool, 987654321, 'Bà Duyệt', 'approved'))[1]).toBe(
      'không tìm thấy mục #987654321 trong hàng duyệt',
    );
    const human = await enqueue(pool, base({ createdBy: 'Ông Tạo' }));
    expect((await decide(pool, human, 'ông tạo', 'approved'))[1]).toMatch(/trùng người tạo/);
  });

  it('QA FAIL: override (lý do ≥10, người ≠ người tạo) rồi người khác duyệt; auto_approve fail-closed', async () => {
    const id = await enqueue(pool, base({ qaStatus: 'fail' }));
    expect((await decide(pool, id, 'Bà Duyệt', 'approved'))[1]).toMatch(/QA FAIL/);
    expect((await override(pool, id, 'agent:mkt', 'lý do override đủ dài'))[0]).toBe(false);
    expect(await override(pool, id, 'Ông QA', 'đã kiểm tay, ca fail là dữ liệu cũ')).toEqual([
      true,
      null,
    ]);
    const d = await pool.query('select kind, decided_by from decisions where queue_id = $1', [
      String(id),
    ]);
    expect(d.rows).toEqual([{ kind: 'override_qa', decided_by: 'Ông QA' }]);
    expect((await row(id)).status).toBe('pending'); // override KHÔNG duyệt
    expect(await decide(pool, id, 'Bà Duyệt', 'approved')).toEqual([true, null]);
    const low = await enqueue(pool, base({ risk: 'low', qaStatus: 'pass' }));
    const [ok, msg] = await autoApprove(pool, low);
    expect(ok).toBe(false);
    expect(msg).toMatch(new RegExp(`^mục #${low}: `));
    expect((await row(low)).status).toBe('pending');
    expect(await expireOverdue(pool)).toBeGreaterThanOrEqual(0);
  });

  it('pending: cắt 200 ký tự, full → đủ; lọc khối; cũ nhất trước', async () => {
    const long = 'x'.repeat(500);
    const id = await enqueue(
      pool,
      base({ block: 'farming', objectType: 'plot_log_gap', payload: long }),
    );
    const rows = await pending(pool, 'farming');
    expect(rows.map((r) => r.id)).toEqual([String(id)]);
    expect([rows[0]!.preview?.length, rows[0]!.guardrail_ok]).toEqual([200, true]);
    expect((await pending(pool, 'farming', { full: true }))[0]!.preview).toBe(long);
    expect((await pending(pool)).length).toBeGreaterThan(1);
  });

  it('cổng triển khai: TẮT → không enqueue/không duyệt; verify chặn chạy thử, nhận người duyệt ở co_nguoi_duyet', async () => {
    const st = installFakeDeps(
      {},
      { quick: null, featureOf: (a) => (a.block === 'intel' ? 'intel-02.1' : null) },
    );
    st.stages['intel-02.1'] = 'co_nguoi_duyet';
    const id = await enqueue(
      pool,
      base({ block: 'intel', objectType: 'intel_topic', payload: 'chủ đề sạch' }),
    );
    st.stages['intel-02.1'] = 'tat';
    await expect(
      enqueue(pool, base({ block: 'intel', objectType: 'intel_topic' })),
    ).rejects.toThrow(/đang tắt/);
    expect((await decide(pool, id, 'Bà Duyệt', 'approved'))[1]).toMatch(
      /không duyệt mục của tính năng tắt/,
    );
    st.stages['intel-02.1'] = 'co_nguoi_duyet';
    expect(await decide(pool, id, 'Bà Duyệt', 'approved')).toEqual([true, null]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await verify(pool, id, 'chủ đề sạch')).toBe(true);
    expect(await verify(pool, id, 'chủ đề đã sửa')).toBe(false);
    st.stages['intel-02.1'] = 'chay_thu';
    expect(await verify(pool, id, 'chủ đề sạch')).toBe(false);
    expect(err.mock.calls.at(-1)?.[0]).toMatch(/TỪ CHỐI DÙNG/);
    err.mockRestore();
  });

  it('CLI: --pending / --approve exit 0; quyết định bị từ chối exit 1', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = async () => createPool(url) as Db; // CLI tự đóng Pool như Python đóng conn
    expect(await approvalQueueCli({ pending: true, block: 'marketing' }, open)).toBe(0);
    const id = await enqueue(pool, base());
    expect(await approvalQueueCli({ approve: String(id), by: 'agent:x' }, open)).toBe(1);
    expect(await approvalQueueCli({ approve: String(id), by: 'Bà Duyệt' }, open)).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toBe(`[done] mục #${id} → approved (người duyệt: Bà Duyệt)`);
    expect(await approvalQueueCli({ expire: true }, open)).toBe(0);
    log.mockRestore();
    err.mockRestore();
  });
});
