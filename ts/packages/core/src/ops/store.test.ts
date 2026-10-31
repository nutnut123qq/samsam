import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import G from './__fixtures__/store.golden.json' with { type: 'json' };
import type { Db } from './deps.js';
import {
  calendar,
  coerceDate,
  contentSha256,
  fmtGuardrail,
  guardrailLines,
  listDrafts,
  mdPlain,
  mergeSnapshot,
  oneline,
  readinessFromDb,
  saveDraft,
  schedule,
  setStatus,
  storeCli,
  verifyLog,
  verifyPublish,
} from './store.js';
import { installFakeDeps } from './testing.js';

const NO_DB = {
  query: () => {
    throw new Error('không được chạm DB');
  },
} as unknown as Db;

// KHÁC Python có chủ đích: `date.fromisoformat` (3.12) nhận cả dạng cơ bản/tuần ISO — TS chỉ nhận
// 'YYYY-MM-DD' (ngày lạ → "không hợp lệ", người nhập lại; chặt hơn, không xếp lịch sai ngày).
const TS_STRICTER = ['20261012', '2026-W42-1'];

describe('store golden (Python)', () => {
  it('sha256 / md_plain / guardrail_lines / fmt / oneline / coerce_date', () => {
    for (const c of G.sha) expect(contentSha256(c.in)).toBe(c.out);
    for (const c of G.md_plain) expect(mdPlain(c.in)).toBe(c.out);
    for (const c of G.lines) expect(guardrailLines(c.in), JSON.stringify(c.in)).toEqual(c.out);
    for (const c of G.fmt)
      expect(fmtGuardrail({ guardrail: c.in }), JSON.stringify(c.in)).toBe(c.out);
    for (const c of G.oneline) expect(oneline(c.in, c.n)).toBe(c.out);
    for (const c of G.coerce) {
      if (TS_STRICTER.includes(c.in)) expect(coerceDate(c.in)).toBeNull();
      else expect(coerceDate(c.in), c.in).toBe(c.out);
    }
  });
});

describe('store không DB', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('mergeSnapshot không bao giờ lỏng hơn luật/caller, không bao giờ "KHÔNG RÕ"', () => {
    const ok = { ok: true, violations: [] };
    expect(mergeSnapshot(ok, { ok: true }).ok).toBe(true);
    expect(mergeSnapshot(ok, null).ok).toBe(false); // caller không khai ok → chặn
    const m = mergeSnapshot(ok, { ok: false, violations: [{ code: 'tu_cam', detail: 'x' }] });
    expect(m.ok).toBe(false);
    expect(m.violations).toEqual([{ code: 'tu_cam', detail: '(snapshot lúc sinh) x' }]);
    const empty = mergeSnapshot(ok, { ok: false });
    expect((empty.violations as { code: string }[])[0]?.code).toBe('config');
    const llm = mergeSnapshot(ok, {
      ok: true,
      violations: [{ code: 'llm_claim', detail: 'd' }],
      llm_check: 'x'.repeat(150),
    });
    expect([llm.ok, (llm.llm_check as string).length]).toEqual([false, 100]);
  });

  it('saveDraft thiếu created_by → lỗi trước DB; setStatus/schedule đầu vào xấu → không chạm DB', async () => {
    await expect(
      saveDraft(NO_DB, { brief: 'b', channel: 'facebook', text: 't', guardrail: {} }),
    ).rejects.toThrow('save_draft: thiếu created_by');
    expect((await setStatus(NO_DB, 1, 'scheduled', 'Bà A'))[1]).toMatch(/không hợp lệ/);
    expect((await setStatus(NO_DB, 1, 'approved', ' '))[1]).toMatch(/thiếu tên người duyệt/);
    expect((await setStatus(NO_DB, 'x', 'approved', 'Bà A'))[1]).toBe("id 'x' không hợp lệ");
    expect((await schedule(NO_DB, 1, '2026-10-20', ''))[1]).toMatch(/thiếu tên người xếp lịch/);
    expect((await schedule(NO_DB, 1, '20/10/2026', 'Bà A'))[1]).toBe(
      "ngày '20/10/2026' không hợp lệ — định dạng YYYY-MM-DD",
    );
    expect((await schedule(NO_DB, 1, '2026-10-14', 'Bà A', '2026-10-15'))[1]).toBe(
      'ngày 2026-10-14 đã qua — chỉ xếp lịch từ hôm nay trở đi',
    );
    expect(await verifyPublish(NO_DB, 'x', 't')).toBe(false);
    expect(await readinessFromDb(null)).toBeNull();
  });

  it('CLI: đúng 1 thao tác, --by bắt buộc → exit 2 trước DB; đọc khi DB down → 0; ghi → 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn(async () => null);
    for (const o of [
      {},
      { pending: true, calendar: true },
      { approve: '1' },
      { schedule: ['1', '2026-10-20'] as [string, string] },
    ]) {
      expect(await storeCli(o, open)).toBe(2);
    }
    expect(open).not.toHaveBeenCalled();
    expect(await storeCli({ pending: true }, open)).toBe(0);
    expect(await storeCli({ verifyLog: true }, open)).toBe(2);
    expect(await storeCli({ approve: '1', by: 'Bà A' }, open)).toBe(2);
    log.mockRestore();
    err.mockRestore();
  });
});

const TEXT_OK = 'Quà biếu gia đình dịp Tết.\nNội dung có sử dụng AI';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('store (DB)', () => {
  const name = testDbName('ops_store');
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
  const save = (over: Partial<Parameters<typeof saveDraft>[1]> = {}) =>
    saveDraft(pool, {
      brief: ' brief ',
      channel: ' facebook ',
      text: TEXT_OK,
      guardrail: { ok: true, violations: [] },
      createdBy: 'agent:studio',
      ...over,
    });

  it('saveDraft: ghi draft + log draft_create cùng giao dịch; snapshot = luật chạy lại', async () => {
    const id = (await save()) as string;
    const d = (await pool.query('select * from content_drafts where id = $1', [id])).rows[0];
    expect([d.brief, d.channel, d.status, d.created_by, d.content_type, d.is_ai, d.block]).toEqual([
      'brief',
      'facebook',
      'pending',
      'agent:studio',
      'post',
      true,
      'marketing',
    ]);
    const log = (
      await pool.query(
        "select actor, detail from agent_action_log where action = 'draft_create' and object_id = $1",
        [id],
      )
    ).rows[0];
    expect(log.actor).toBe('agent:studio');
    expect(log.detail.content_sha256).toBe(contentSha256(TEXT_OK));
    // caller khai ok nhưng text vi phạm → snapshot lưu ok=false
    const bad = (await save({ text: 'Sâm chữa bệnh' })) as string;
    expect(
      (await pool.query('select guardrail from content_drafts where id = $1', [bad])).rows[0]
        .guardrail.ok,
    ).toBe(false);
    // tính năng TẮT → không sinh
    const st = installFakeDeps({}, { quick: null, featureOf: () => 'marketing-01' });
    st.stages['marketing-01'] = 'tat';
    await expect(save()).rejects.toThrow(/đang tắt/);
  });

  it('setStatus: approve chạy lại guardrail đăng bài trên text DB; người tạo không tự duyệt; one-way', async () => {
    const id = (await save()) as string;
    expect((await setStatus(pool, id, 'approved', 'AGENT:studio'))[1]).toMatch(
      /người tạo|không phải người/,
    );
    expect(await setStatus(pool, id, 'approved', ' Bà Duyệt ', 'ok')).toEqual([true, null]);
    expect((await setStatus(pool, id, 'rejected', 'Bà Khác'))[1]).toBe(
      `draft #${id} đã ở trạng thái 'approved' — chỉ duyệt từ pending`,
    );
    expect((await setStatus(pool, 987654, 'approved', 'Bà Duyệt'))[1]).toBe(
      'không tìm thấy draft #987654',
    );
    const bad = (await save({ text: 'Sâm chữa bệnh' })) as string;
    expect((await setStatus(pool, bad, 'approved', 'Bà Duyệt'))[1]).toMatch(
      /vi phạm guardrail \(ok != true\)/,
    );
    // snapshot "giả" ok (agent ghi thẳng) nhưng text vi phạm → kiểm lại bắt
    const forged = (
      await pool.query(
        "insert into content_drafts (brief, channel, text, guardrail, source, created_by) values ('b', 'facebook', 'Sâm chữa bệnh', '{\"ok\": true}', 'cli', 'agent:x') returning id",
      )
    ).rows[0].id;
    expect((await setStatus(pool, forged, 'approved', 'Bà Duyệt'))[1]).toBe(
      `draft #${forged} vi phạm guardrail khi kiểm lại text (1 vi phạm: tu_cam) — snapshot lúc lưu không khớp; phải reject hoặc viết lại`,
    );
    expect(await setStatus(pool, forged, 'rejected', 'Bà Duyệt')).toEqual([true, null]);
  });

  it('schedule + calendar + verifyPublish + verifyLog', async () => {
    const id = (await save()) as string;
    const today = '2026-10-15';
    expect((await schedule(pool, id, '2026-10-20', 'Bà Lịch', today))[1]).toMatch(
      /chỉ xếp lịch bài đã approved/,
    );
    expect((await setStatus(pool, id, 'approved', 'Bà Duyệt'))[0]).toBe(true);
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect(await schedule(pool, id, day, 'Bà Lịch')).toEqual([true, null]);
    const cal = await calendar(pool, 14);
    expect(cal.scheduled.map((d) => [d.id, d.scheduled_date])).toContainEqual([id, day]);
    expect(await verifyPublish(pool, id, TEXT_OK)).toBe(true);
    expect(await verifyPublish(pool, id, `${TEXT_OK} `)).toBe(false);
    const [n, probs] = await verifyLog(pool);
    expect([n > 0, probs]).toEqual([true, []]);
    // xếp lịch là biên DÙNG: chạy thử → chặn
    const st = installFakeDeps({}, { quick: null, featureOf: () => 'marketing-01' });
    st.stages['marketing-01'] = 'chay_thu';
    expect((await schedule(pool, id, day, 'Bà Lịch'))[1]).toMatch(
      /chạy thử.*đầu ra chỉ ghi nội bộ/,
    );
  });

  it('listDrafts + CLI --pending/--verify-log exit 0', async () => {
    expect((await listDrafts(pool, 'pending')).every((d) => d.status === 'pending')).toBe(true);
    expect(await listDrafts(pool, 'lạ')).toEqual([]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await storeCli({ pending: true }, async () => createPool(url))).toBe(0);
    expect(await storeCli({ verifyLog: true }, async () => createPool(url))).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^\[ok\] chuỗi nguyên vẹn/);
    log.mockRestore();
  });
});
