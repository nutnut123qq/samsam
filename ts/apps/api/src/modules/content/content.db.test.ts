import { readFileSync } from 'node:fs';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { addDays } from '@samsam/core/ops/period';
import { SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentMain } from './content.command.js';
import * as ct from './content.js';
import * as mc from './mkt-calendar.js';

// Dịch phần DB của tests/test_listing.py (batch idempotent) + tests/test_v13_c06_daily_ar.py (3 nháp
// bài/ngày). DB riêng `samsam_ts_content` tạo lại từ mẫu MỖI ca, xóa khi xong — KHÔNG BAO GIỜ DB
// `samsam`. LLM = gateway GIẢ tất định (0 mạng); guardrail + cổng triển khai + function DB THẬT.

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON thử nghiệm
type Any = Record<string, any>;
const NAME = 'samsam_ts_content';
const GOLDEN = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as Any;
const GOLD_KEYS: string[] = GOLDEN.skus.map((s: Any) => s.sku_key);
const HONEY = 'mat-ong-sam-300ml';
const LISTING_CH = ['shopee', 'tiktok', 'web'];
const SAFE =
  'Sâm Sâm Quảng Nam — đặc sản quê hương, món quà tặng ý nghĩa.\n\nNội dung có sử dụng AI';
const BAD = 'Sản phẩm chữa khỏi bệnh tiểu đường.\n\nNội dung có sử dụng AI';
const THU = '2026-10-15'; // thứ Năm — ngày làm việc
const llmJson = () =>
  JSON.stringify({
    hook: 'Quà biếu tinh tế',
    description: 'Vị ngọt dịu, sánh mịn.',
    bullets: ['Đóng hũ thủy tinh sạch'],
    keywords: ['mật ong sâm', 'quà biếu'],
  });

function fakeAi(...texts: string[]) {
  const calls: ChatMessage[][] = [];
  const ai = {
    chat: async (_agent: string, messages: ChatMessage[]) => {
      calls.push(structuredClone(messages));
      const text = texts[Math.min(calls.length, texts.length) - 1] as string;
      return { text, model: 'fake', provider: 'ollama' as const, tokensIn: 0, tokensOut: 0 };
    },
  };
  return { calls, d: { ai, env: {} } as ct.AiDeps };
}

/** Golden thật; `ready` → mật ong 300ml tự công bố + kênh facebook/zalo (TP_THUONG). */
function goldenDoc(ready: boolean): Any {
  const doc = structuredClone(GOLDEN);
  if (ready) {
    const s = doc.skus.find((x: Any) => x.sku_key === HONEY);
    s.self_declaration_ok = true;
    s.allowed_channels = ['shopee', 'facebook', 'zalo'];
  }
  return doc;
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('content (DB thật)', () => {
  let pool: pg.Pool;
  let dsn = '';
  const q = async (sql: string, args: unknown[] = []) =>
    (await pool.query(sql, args)).rows as Any[];
  const count = async () =>
    Number((await q('select count(*)::int as n from content_drafts'))[0]?.n);
  const drafts = (day = THU) =>
    q(
      "select left(brief, 21) as k, channel, sku, status, created_by, guardrail->>'ok' as ok from content_drafts where brief like $1 order by id",
      [`[daily ${day} #%`],
    );
  /** Như `gs.load(db, _golden(ready))` của Python: ghi mức readiness vào sku_master (view sku_readiness). */
  const honey = async (ready: boolean, channels: string[] = ['shopee', 'facebook', 'zalo']) => {
    if (!ready) return;
    await q(
      'update sku_master set self_declaration_ok = true, allowed_channels = $2 where sku_key = $1',
      [HONEY, channels],
    );
  };
  const inputs = (ready: boolean): mc.Inputs => {
    const [cal, , sla] = mc.loadInputs();
    return [cal, goldenDoc(ready), sla];
  };
  const realExisting = ct.hooks.existing;
  const realDailySql = ct.hooks.dailyExistingSql;

  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
    settings.forceMode = 'van_hanh';
  });
  afterEach(() => {
    ct.hooks.existing = realExisting;
    ct.hooks.dailyExistingSql = realDailySql;
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
    resetOpsDeps();
    settings.forceMode = null;
  });

  // ============================================================ listing batch (W61.4)

  it('batch idempotent theo (sku, kênh, prompt_version); bị từ chối thì soạn lại; đua → skipped', async () => {
    await honey(true, ['shopee']);
    const f = fakeAi(llmJson());
    const by = 'agent:mkt02';
    const r1 = await ct.listingBatch(pool, GOLD_KEYS, LISTING_CH, { by }, f.d);
    const created = r1.filter((r) => r.status === 'created');
    const elig = GOLD_KEYS.filter((k) => ct.precheck(k, 'shopee', 'listing') === null);
    expect(new Set(created.map((r) => `${r.sku}/${r.channel}`))).toEqual(
      new Set([...elig, HONEY].map((k) => `${k}/shopee`)),
    );
    expect(created.length).toBe(8);
    expect(new Set(r1.map((r) => r.status))).toEqual(new Set(['created', 'refused']));
    expect(r1.length).toBe(GOLD_KEYS.length * 3);
    expect(f.calls.length).toBe(1); // chỉ mật ong TP_THUONG gọi LLM
    expect(created.find((r) => r.sku === HONEY)?.llm_part).toBe('used');
    const n1 = await count();

    const r2 = await ct.listingBatch(pool, GOLD_KEYS, LISTING_CH, { by }, f.d);
    expect(r2.filter((r) => r.status === 'created')).toEqual([]);
    const skipped = r2.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBe(8);
    expect(f.calls.length).toBe(1);
    expect(new Set(skipped.map((r) => r.id))).toEqual(new Set(created.map((r) => r.id)));
    expect(await count()).toBe(n1);
    const rows = await q(
      'select status, content_type, sku, channel, prompt_version, is_ai, created_by, source from content_drafts order by id',
    );
    expect(rows.length).toBe(8);
    for (const r of rows) {
      expect([r.status, r.content_type, r.channel, r.is_ai, r.created_by, r.source]).toEqual([
        'pending',
        'listing',
        'shopee',
        true,
        'agent:mkt02',
        SOURCE_CLI,
      ]);
      expect(r.prompt_version).toBe(`listing_${r.channel}@1`);
      expect(GOLD_KEYS).toContain(r.sku);
    }

    const victim = created[0] as ct.BatchItem;
    await q("update content_drafts set status = 'rejected' where id = $1", [victim.id]);
    const r3 = await ct.listingBatch(pool, GOLD_KEYS, LISTING_CH, { by }, f.d);
    const again = r3.filter((r) => r.status === 'created');
    expect(again.map((r) => r.sku)).toEqual([victim.sku]);

    // Đua: SELECT bỏ sót (batch song song) → INSERT đụng index unique → skipped, không nhân bản.
    ct.hooks.existing = async (db, s, c, v) =>
      s === 'savina-12v' ? null : realExisting(db, s, c, v);
    const r4 = await ct.listingBatch(pool, ['savina-12v'], ['shopee'], { by }, f.d);
    expect(r4).toEqual([{ sku: 'savina-12v', channel: 'shopee', status: 'skipped', id: null }]);
  });

  it('guardrail không ok (lớp LLM-check cờ) → failed, KHÔNG ghi', async () => {
    const calls: string[] = [];
    const ai = {
      chat: async (agent: string) => {
        calls.push(agent);
        return {
          text: '{"flag": true, "reasons": []}',
          model: 'f',
          provider: 'ollama' as const,
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };
    const r = await ct.listingBatch(
      pool,
      ['savina-12v'],
      ['shopee'],
      { by: 'x' },
      {
        ai,
        env: { GUARDRAIL_LLM_MODEL: 'google/gemini-test' },
      },
    );
    expect(r[0]?.status).toBe('failed');
    expect(r[0]?.codes).toContain('llm_ngam_y_suc_khoe');
    expect(calls).toEqual(['guardrail_llm']);
    expect(await count()).toBe(0);
  });

  // ============================================================ 3 nháp bài/ngày (v13.6)

  it('3 nháp/ngày; chạy lại cùng ngày (retry/restart) 0 LLM, 0 nháp mới; ngày kế 3 nháp mới', async () => {
    await honey(true);
    const f = fakeAi(SAFE);
    const r1 = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d);
    expect([r1.live, r1.missing]).toEqual([3, 0]);
    expect(r1.items.map((it) => it.status)).toEqual(['created', 'created', 'created']);
    const rows = await drafts();
    expect(rows.map((r) => r.k)).toEqual([1, 2, 3].map((i) => `[daily 2026-10-15 #${i}]`));
    for (const r of rows)
      expect([r.status, r.created_by, r.ok]).toEqual(['pending', 'agent:mkt02', 'true']);
    expect(rows.some((r) => r.sku === HONEY)).toBe(true); // bài sản phẩm hợp lệ
    const nLlm = f.calls.length;
    for (let i = 0; i < 2; i++) {
      const r = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d);
      expect(r.items.map((it) => it.status)).toEqual(['skipped', 'skipped', 'skipped']);
      expect([r.live, r.missing]).toEqual([3, 0]);
    }
    expect(f.calls.length).toBe(nLlm);
    expect((await drafts()).length).toBe(3);
    const r = await ct.dailyBatch(pool, addDays(THU, 1), { inputs: inputs(true) }, f.d);
    expect(r.live).toBe(3);
    expect((await drafts()).length).toBe(3);
    expect((await drafts(addDays(THU, 1))).length).toBe(3);
  });

  it('thiếu chủ đề hợp lệ → báo THIẾU, không sinh bài SKU vi phạm cho đủ số', async () => {
    const f = fakeAi(SAFE);
    const r = await ct.dailyBatch(pool, THU, { inputs: inputs(false) }, f.d);
    expect([r.live, r.missing]).toEqual([2, 1]);
    expect(r.reasons[0]).toContain('2/3');
    expect(new Set(r.refused.map((c) => c.ref))).toEqual(new Set(['san-pham', 'qua-tang']));
    for (const row of await drafts()) expect(row.sku).toBeNull();
    expect(f.calls.length).toBe(2);
  });

  it('guardrail fail → failed, KHÔNG ghi; chạy lại với bài sạch → đủ 3', async () => {
    await honey(true);
    const r = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, fakeAi(BAD).d);
    expect(r.items.map((it) => it.status)).toEqual(['failed', 'failed', 'failed']);
    expect(r.missing).toBe(3);
    expect(await drafts()).toEqual([]);
    const r2 = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, fakeAi(SAFE).d);
    expect(r2.live).toBe(3);
    expect((await drafts()).length).toBe(3);
  });

  it('2 tiến trình song song: index unique chốt cuối; slot bị từ chối soạn lại được', async () => {
    await honey(true);
    const key = ct.dailyKey(THU, 1);
    const base = {
      guardrail: { ok: true },
      source: SOURCE_CLI,
      createdBy: 'agent:mkt02',
      contentType: 'post',
    };
    const did = await saveDraft(pool, {
      ...base,
      brief: `${key} a`,
      channel: 'facebook',
      text: SAFE,
    });
    await expect(
      saveDraft(pool, { ...base, brief: `${key} b`, channel: 'zalo', text: SAFE }),
    ).rejects.toMatchObject({
      code: '23505',
    });
    // Đua: lần kiểm trước LLM chưa thấy slot (giả lập) → INSERT đụng index → skipped, không nhân bản.
    ct.hooks.dailyExistingSql = realDailySql.replace('brief like $2', 'brief like $2 and false');
    const f = fakeAi(SAFE);
    const r = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d);
    ct.hooks.dailyExistingSql = realDailySql;
    expect(r.items[0]?.status).toBe('skipped');
    expect((await drafts()).length).toBe(3);
    expect(f.calls.length).toBe(3);
    await q("update content_drafts set status = 'rejected' where id = $1", [did]);
    const r2 = await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d);
    expect(r2.items.map((it) => it.status)).toEqual(['created', 'skipped', 'skipped']);
    expect((await drafts()).length).toBe(4);
    expect(r2.live).toBe(3);
  });

  it('tính năng tắt → RolloutBlocked TRƯỚC mọi lời gọi LLM, 0 nháp', async () => {
    await honey(true);
    settings.forceMode = 'tat';
    const f = fakeAi(SAFE);
    await expect(ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d)).rejects.toBeInstanceOf(
      RolloutBlocked,
    );
    expect(f.calls).toEqual([]);
    expect(await drafts()).toEqual([]);
  });

  it('payload gửi LLM không chứa khóa slot', async () => {
    await honey(true);
    const f = fakeAi(SAFE);
    await ct.dailyBatch(pool, THU, { inputs: inputs(true) }, f.d);
    const sent = JSON.stringify(f.calls);
    expect(sent).not.toContain('[daily');
    expect(sent).toContain('BRIEF: Bài thường ngày');
  });

  it('CLI đầu-cuối: --listing 1 cặp + --daily (DB thật, gateway giả)', async () => {
    const out: string[] = [];
    const f = fakeAi(SAFE);
    const deps = {
      io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) },
      env: {},
      connect: async () => {
        const p = createPool(dsn);
        return { db: p, release: () => p.end() };
      },
      wire: (db: pg.Pool) => {
        wireCore(db);
        return f.d.ai;
      },
    };
    expect(
      await contentMain(
        { listing: true, sku: ['savina-12v'], channel: ['shopee'], llm: false },
        deps as never,
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/^savina-12v × shopee: created #\d+$/);
    expect(await contentMain({ daily: true, date: THU }, deps as never)).toBe(1); // golden thật: THIẾU 1
    expect(out.join('\n')).toContain('[THIẾU] 1/3 nháp');
    wireCore(pool);
  });
});
