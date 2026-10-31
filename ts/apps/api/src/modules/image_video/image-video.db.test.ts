import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { publishCheck, saveDraft, setStatus } from '@samsam/core/ops/store';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { readinessKey } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as ims from './image-studio.js';
import { imageStudioMain } from './image-video.command.js';
import * as raster from './raster.js';
import * as vs from './video-studio.js';

// Dịch phần DB thật của tests/test_image_studio.py + tests/test_video_studio.py: bảng image_assets/
// video_assets (quyền agent_writer chỉ INSERT/SELECT, unique danh tính, check nhãn AI), save_image/
// save_video (created → skipped, đua → nháp mồ côi, cùng ảnh khác kênh = nháp riêng), cổng triển
// khai TẮT (không sinh nháp). DB riêng `samsam_ts_image_video` tạo từ mẫu, xóa khi xong — KHÔNG BAO
// GIỜ DB `samsam`. Guardrail + cổng triển khai + function DB THẬT; nền ảnh tất định (0 mạng).

// biome-ignore lint/suspicious/noExplicitAny: dữ liệu JSON thử nghiệm
type Any = any;
const NAME = 'samsam_ts_image_video';
const RULES = JSON.parse(readFileSync(dataPath('guardrail_rules.json'), 'utf8')) as Any;
const AI: string = RULES.labels.ai[0];
const AD: string = RULES.labels.ad[0];
const HONEY = 'mat-ong-sam-300ml';
const HEADLINE = 'Quà tặng từ núi rừng';
const TMP = mkdtempSync(join(tmpdir(), 'image-video-db-'));
let n = 0;
const fresh = (p: string) => join(TMP, `${p}-${++n}`);

let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}
const RENDER = HAS_SHARP && ims.fontsFor(`${AI} ${AD} MẪU ${HEADLINE}`, {}) !== null;
const R = (ch: string) => new Map([[readinessKey(HONEY, ch), 'TP_THUONG']]);

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('image_video (DB thật)', () => {
  let pool: pg.Pool;
  let PK = '';
  const q = async (sql: string, args: unknown[] = []) =>
    (await pool.query(sql, args)).rows as Any[];
  const count = async (t: string) => Number((await q(`select count(*)::int as n from ${t}`))[0]?.n);
  /** Python test_*_draft_approvable_by_human: NGƯỜI duyệt nháp qua store.set_status (guardrail kiểm
   * lại lúc duyệt) → approve_draft. Lớp LLM-check tắt (GUARDRAIL_LLM_MODEL rỗng) — 0 mạng. */
  async function approveAsHuman(id: string) {
    const keep = process.env.GUARDRAIL_LLM_MODEL;
    delete process.env.GUARDRAIL_LLM_MODEL;
    try {
      expect(await setStatus(pool, id, 'approved', 'Hoa')).toEqual([true, null]);
    } finally {
      if (keep !== undefined) process.env.GUARDRAIL_LLM_MODEL = keep;
    }
    const [d] = await q('select status, reviewer from content_drafts where id = $1', [id]);
    expect(d).toEqual({ status: 'approved', reviewer: 'Hoa' });
    const a = await q(
      "select decision, approved_by from approvals where object_type = 'content_draft' and object_id = $1",
      [id],
    );
    expect(a).toEqual([{ decision: 'approved', approved_by: 'Hoa' }]);
  }

  beforeAll(async () => {
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    // Mật ong 300ml tự công bố + kênh ảnh/video (view sku_readiness → TP_THUONG), như gs.load test Python.
    await q(
      'update sku_master set self_declaration_ok = true, allowed_channels = $2 where sku_key = $1',
      [HONEY, ['shopee', 'facebook', 'tiktok', 'zalo']],
    );
    if (RENDER) {
      PK = fresh('pk');
      await ims.makeSamplePackshot(join(PK, `${HONEY}.png`), HONEY);
    }
  });
  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    await q('delete from image_assets');
    await q('delete from video_assets');
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
    resetOpsDeps();
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  const INS =
    'insert into image_assets (file_sha256, file_name, sku, channel, format, ai_generated, label_text, provider, model, prompt_sha256, prompt_version, packshot_sha256, draft_id, meta, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id';
  const asset = (sha: string, did: string, o: Any = {}) => [
    sha,
    `${sha}.png`,
    o.sku ?? HONEY,
    o.ch ?? 'facebook',
    o.fmt ?? '1:1',
    o.ai ?? true,
    o.label ?? `${AI}\n${AD}`,
    'fake',
    'model' in o ? o.model : 'm',
    'psha' in o ? o.psha : 'p'.repeat(64),
    'image_background@1',
    'k'.repeat(64),
    did,
    JSON.stringify({ k: 1 }),
    'agent:mkt03',
  ];
  /** Chạy 1 câu dưới role agent_writer trong giao dịch riêng → mã SQLSTATE lỗi | null. */
  async function asWriter(sql: string, args: unknown[] = []): Promise<string | null> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role agent_writer');
      await c.query(sql, args);
      await c.query('commit');
      return null;
    } catch (e) {
      await c.query('rollback');
      return (e as { code?: string }).code ?? 'ERR';
    } finally {
      c.release();
    }
  }

  it('image_assets: agent_writer chỉ INSERT/SELECT, unique (sha, sku, kênh, format), check nhãn/model/prompt', async () => {
    const did = (await saveDraft(pool, {
      brief: 'image b',
      channel: 'facebook',
      text: `${HEADLINE}\n${AI}\n${AD}\n\nTệp ảnh: a.png`,
      guardrail: { ok: true },
      source: 'cli',
      createdBy: 'agent:mkt03',
      contentType: 'image',
      sku: HONEY,
    })) as string;
    expect(await asWriter(INS, asset('a'.repeat(64), did))).toBeNull();
    expect(await count('image_assets')).toBe(1);
    expect(await asWriter(INS, asset('a'.repeat(64), did))).toBe('23505'); // trùng danh tính
    expect(await asWriter(INS, asset('b'.repeat(64), did, { label: AD }))).toBe('23514'); // thiếu nhãn AI
    expect(await asWriter(INS, asset('c'.repeat(64), did, { model: null }))).toBe('23514'); // thiếu model
    expect(await asWriter(INS, asset('d'.repeat(64), did, { psha: null }))).toBe('23514'); // thiếu prompt
    expect(await asWriter("update image_assets set label_text = 'x'")).toBe('42501');
    expect(await asWriter('delete from image_assets')).toBe('42501');
    // Nền tất định (không AI): không bắt model/prompt.
    expect(
      await asWriter(
        INS,
        asset('e'.repeat(64), did, { ai: false, label: AI, model: null, psha: null }),
      ),
    ).toBeNull();
    expect(await count('image_assets')).toBe(2);
    for (const o of [{ ch: 'shopee' }, { sku: 'mat-ong-sam-120ml-1hu' }, { fmt: '4:5' }]) {
      expect(await asWriter(INS, asset('a'.repeat(64), did, o)), JSON.stringify(o)).toBeNull();
    }
    expect(await count('image_assets')).toBe(5);
    expect(await asWriter(INS, asset('a'.repeat(64), did, { sku: 'mat-ong-sam-120ml-1hu' }))).toBe(
      '23505',
    );
  });

  it.skipIf(!RENDER).each(['none', 'fake'])(
    'save_image (provider %s): created → skipped, nháp pending + log',
    async (prov) => {
      ims.PROVIDERS.fake = async (_p, size) => [
        raster.newRaw(size[0], size[1], 3, [60, 90, 70]),
        { model: 'fake-model' },
      ];
      try {
        const before = await count('content_drafts');
        const r = await ims.compose(
          HONEY,
          'facebook',
          HEADLINE,
          {
            readiness: R('facebook'),
            packshotDir: PK,
            outDir: fresh('o'),
            provider: prov,
            scene: prov === 'fake' ? 'bàn gỗ, lá xanh' : null,
          },
          { ai: null, env: {} },
        );
        expect(r.ok, JSON.stringify(r.refused)).toBe(true);
        const s1 = await ims.saveImage(pool, r, { by: 'agent:mkt03' });
        expect(s1.status).toBe('created');
        const did = (s1 as Any).draft_id;
        const [row] = await q(
          "select status, content_type, sku, channel, text, is_ai, created_by, source, prompt_version, prompt_sha256, guardrail->>'ok' as ok from content_drafts where id = $1",
          [did],
        );
        const m = r.meta as Any;
        const bg = m.background;
        expect([row.status, row.content_type, row.sku, row.channel]).toEqual([
          'pending',
          'image',
          HONEY,
          'facebook',
        ]);
        expect(row.text).toBe(r.draft_text);
        expect(row.text).toContain(AI);
        expect(row.text).toContain(`${r.sha256}.png`);
        expect([
          row.is_ai,
          row.created_by,
          row.source,
          row.prompt_version,
          row.prompt_sha256,
          row.ok,
        ]).toEqual([true, 'agent:mkt03', 'cli', bg.prompt_version, bg.prompt_sha256, 'true']);
        const a = await q(
          'select file_sha256, file_name, sku, channel, format, ai_generated, label_text, provider, model, prompt_sha256, prompt_version, packshot_sha256, draft_id::text, meta, created_by from image_assets',
        );
        expect(a).toEqual([
          {
            file_sha256: r.sha256,
            file_name: m.file,
            sku: HONEY,
            channel: 'facebook',
            format: '1:1',
            ai_generated: prov === 'fake',
            label_text: m.labels.join('\n'),
            provider: prov,
            model: bg.model,
            prompt_sha256: bg.prompt_sha256,
            prompt_version: bg.prompt_version,
            packshot_sha256: r.packshot_sha256,
            draft_id: did,
            meta: m,
            created_by: 'agent:mkt03',
          },
        ]);
        expect(await ims.saveImage(pool, r, { by: 'agent:mkt03' })).toEqual({
          status: 'skipped',
          draft_id: did,
        });
        expect(await count('content_drafts')).toBe(before + 1);
        expect(await count('image_assets')).toBe(1);
        const log = await q(
          "select actor, action, object_id from agent_action_log where action = 'draft_create' and object_id = $1",
          [did],
        );
        expect(log).toEqual([{ actor: 'agent:mkt03', action: 'draft_create', object_id: did }]);
      } finally {
        delete ims.PROVIDERS.fake;
      }
    },
  );

  it.skipIf(!RENDER)(
    'đua 2 tiến trình cùng mục → skipped + nháp mồ côi pending (agent không xóa)',
    async () => {
      const r = await ims.compose(
        HONEY,
        'facebook',
        HEADLINE,
        { readiness: R('facebook'), packshotDir: PK, outDir: fresh('o') },
        { ai: null, env: {} },
      );
      const first = (await ims.saveImage(pool, r, { by: 'agent:mkt03' })) as Any;
      const miss = {
        query: (sql: string, args?: unknown[]) =>
          sql.startsWith('select draft_id from image_assets')
            ? Promise.resolve({ rows: [] })
            : pool.query(sql, args),
        connect: () => pool.connect(),
      } as Any;
      const s = (await ims.saveImage(miss, r, { by: 'agent:mkt03' })) as Any;
      expect(s.status).toBe('skipped');
      expect(s.orphan_draft_id).not.toBe(first.draft_id);
      expect(await count('image_assets')).toBe(1);
      expect(
        (await q('select status from content_drafts where id = $1', [s.orphan_draft_id]))[0]
          ?.status,
      ).toBe('pending');
    },
  );

  it.skipIf(!RENDER)(
    'cùng ảnh 2 kênh → 2 nháp + 2 dòng; sidecar == meta mọi dòng; chạy lại → skipped',
    async () => {
      const out = fresh('o');
      const rmap = new Map([...R('facebook'), ...R('shopee')]);
      const run = async () => {
        const res = [];
        for (const ch of ['facebook', 'shopee']) {
          res.push(
            await ims.compose(
              HONEY,
              ch,
              HEADLINE,
              { readiness: rmap, packshotDir: PK, outDir: out },
              { ai: null, env: {} },
            ),
          );
        }
        const st = [];
        for (const r of res) st.push((await ims.saveImage(pool, r, { by: 'agent:mkt03' })) as Any);
        return [res, st] as const;
      };
      const [res, st] = await run();
      expect(st.map((s) => s.status)).toEqual(['created', 'created']);
      expect(res[0]?.sha256).toBe(res[1]?.sha256);
      const disk = JSON.parse(readFileSync(res[0]?.sidecar as string, 'utf8'));
      const rows = await q(
        'select a.channel, a.file_sha256, a.meta, d.channel as dch, d.status, d.id::text from image_assets a join content_drafts d on d.id = a.draft_id order by a.id',
      );
      expect(rows.map((r) => [r.channel, r.dch, r.status])).toEqual([
        ['facebook', 'facebook', 'pending'],
        ['shopee', 'shopee', 'pending'],
      ]);
      for (const r of rows) expect(r.meta).toEqual(disk); // jsonb: so theo giá trị
      expect('channel' in disk).toBe(false);
      expect(rows.map((r) => r.id)).toEqual(st.map((s) => s.draft_id));
      const [, st2] = await run();
      expect(st2).toEqual(st.map((s) => ({ status: 'skipped', draft_id: s.draft_id })));
      expect(await count('image_assets')).toBe(2);
    },
  );

  it.skipIf(!RENDER)(
    'nháp ảnh duyệt được: guardrail lúc duyệt (luật + readiness DB) không ngõ cụt nhãn AI/QC',
    async () => {
      const r = await ims.compose(
        HONEY,
        'facebook',
        HEADLINE,
        { readiness: R('facebook'), packshotDir: PK, outDir: fresh('o') },
        { ai: null, env: {} },
      );
      const g = await publishCheck(pool, r.draft_text, 'facebook', {
        llm: false,
        contentType: 'image',
        sku: HONEY,
        isAi: true,
      });
      expect(g.ok, JSON.stringify(g.violations)).toBe(true);
      const s = (await ims.saveImage(pool, r, { by: 'agent:mkt03' })) as Any;
      expect(s.status).toBe('created');
      await approveAsHuman(s.draft_id);
    },
  );

  it.skipIf(!RENDER)(
    'tính năng marketing-02.1 TẮT → saveImage chặn ở biên sinh; CLI exit 2, 0 nháp',
    async () => {
      const r = await ims.compose(
        HONEY,
        'facebook',
        HEADLINE,
        { readiness: R('facebook'), packshotDir: PK, outDir: fresh('o') },
        { ai: null, env: {} },
      );
      const before = await count('content_drafts');
      settings.forceMode = 'tat';
      await expect(ims.saveImage(pool, r, { by: 'agent:mkt03' })).rejects.toThrow(RolloutBlocked);
      const out: string[] = [];
      const rc = await imageStudioMain(
        { sku: [HONEY], channel: ['facebook'], headline: HEADLINE },
        {
          io: { out: (s) => out.push(s), err: (s) => out.push(s) },
          env: { PACKSHOT_DIR: PK, IMAGE_OUT_DIR: fresh('o') },
          connect: async () => ({ db: pool, release: async () => {} }),
        },
      );
      expect(rc).toBe(2);
      expect(out.join('\n')).toContain('[rollout]');
      expect(await count('content_drafts')).toBe(before);
      expect(await count('image_assets')).toBe(0);
    },
  );

  it.skipIf(!RENDER)('CLI thật (van_hanh): created rồi chạy lại skipped, exit 0', async () => {
    const env = { PACKSHOT_DIR: PK, IMAGE_OUT_DIR: fresh('o') };
    const lines: string[] = [];
    const deps = {
      io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) },
      env,
      connect: async () => ({ db: pool, release: async () => {} }),
    };
    expect(
      await imageStudioMain({ sku: [HONEY], channel: ['facebook'], headline: HEADLINE }, deps),
    ).toBe(0);
    expect(lines.join('\n')).toMatch(
      /mat-ong-sam-300ml × facebook × 1:1: created #\d+ [0-9a-f]{64}\.png/,
    );
    lines.length = 0;
    expect(
      await imageStudioMain({ sku: [HONEY], channel: ['facebook'], headline: HEADLINE }, deps),
    ).toBe(0);
    expect(lines.join('\n')).toContain('created 0, skipped 1, refused 0, failed 0');
  });

  it('save_video: created → skipped; cùng mp4 kênh khác → nháp riêng; video_assets check thời lượng/nhãn', async () => {
    const sha = 'f'.repeat(64);
    const meta = {
      schema: 'video_asset@1',
      file: `${sha}.mp4`,
      asset_sha256: sha,
      duration_ms: 24000,
      labels: [AI, AD],
      tts: { provider: 'none', voice: null },
    };
    const res = {
      ok: true,
      sha256: sha,
      sku: HONEY,
      channel: 'tiktok',
      format: '9:16',
      packshot_sha256: 'p'.repeat(64),
      draft_text: `Quà quê\n\n${AI}\n\n${AD}\n\nTệp video: ${sha}.mp4`,
      guardrail: { ok: true, violations: [] },
      meta,
      script: {
        model: 'fake/test-llm',
        prompt_sha256: 's'.repeat(64),
        prompt_version: 'video_script@1',
      },
    };
    const s1 = (await vs.saveVideo(pool, res, { by: 'agent:mkt04' })) as Any;
    expect(s1.status).toBe('created');
    const [row] = await q(
      'select status, content_type, sku, channel, text, is_ai, created_by, source, prompt_version, prompt_sha256 from content_drafts where id = $1',
      [s1.draft_id],
    );
    expect(row).toEqual({
      status: 'pending',
      content_type: 'video',
      sku: HONEY,
      channel: 'tiktok',
      text: res.draft_text,
      is_ai: true,
      created_by: 'agent:mkt04',
      source: 'cli',
      prompt_version: 'video_script@1',
      prompt_sha256: 's'.repeat(64),
    });
    const a = await q(
      'select file_sha256, sku, channel, format, duration_ms, label_text, script_model, tts_provider, draft_id::text, meta from video_assets',
    );
    expect(a).toEqual([
      {
        file_sha256: sha,
        sku: HONEY,
        channel: 'tiktok',
        format: '9:16',
        duration_ms: 24000,
        label_text: `${AI}\n${AD}`,
        script_model: 'fake/test-llm',
        tts_provider: 'none',
        draft_id: s1.draft_id,
        meta,
      },
    ]);
    expect(await vs.saveVideo(pool, res, { by: 'agent:mkt04' })).toEqual({
      status: 'skipped',
      draft_id: s1.draft_id,
    });
    const s3 = (await vs.saveVideo(
      pool,
      { ...res, channel: 'facebook' },
      { by: 'agent:mkt04' },
    )) as Any;
    expect(s3.status).toBe('created');
    expect(s3.draft_id).not.toBe(s1.draft_id);
    expect((await q('select channel from video_assets order by id')).map((r) => r.channel)).toEqual(
      ['tiktok', 'facebook'],
    );
    // check DB: thời lượng ngoài 15–45 s / thiếu nhãn AI → từ chối kể cả ghi tay
    const bad = await vs
      .saveVideo(
        pool,
        { ...res, sha256: 'e'.repeat(64), meta: { ...meta, duration_ms: 50000 } },
        { by: 'agent:mkt04' },
      )
      .catch((e) => e.code);
    expect(bad).toBe('23514');
  });

  it('nháp video duyệt được: caption thật của write_script (LLM giả) qua guardrail lúc duyệt', async () => {
    const scenes = [
      'Quà tặng từ núi rừng Quảng Nam',
      'Mật ong vàng óng từ vùng trồng sâm',
      'Gói trọn tấm lòng gửi người thân',
      'Đặc sản quê hương trong từng giọt',
      'Món quà tử tế cho dịp sum vầy',
    ].map((text) => ({ text, visual: 'packshot' }));
    const ai = {
      chat: async () => ({
        text: JSON.stringify({ scenes }),
        model: 'fake/test-llm',
        provider: 'ollama' as const,
        tokensIn: 0,
        tokensOut: 0,
      }),
    };
    const script = await vs.writeScript(
      HONEY,
      'tiktok',
      'Quà tặng từ núi rừng Quảng Nam',
      { readiness: R('tiktok') },
      { ai: ai as never, env: {} },
    );
    expect(script.ok, JSON.stringify(script.refused)).toBe(true);
    const sha = '9'.repeat(64);
    const s = (await vs.saveVideo(
      pool,
      {
        ok: true,
        sha256: sha,
        sku: HONEY,
        channel: 'tiktok',
        format: '9:16',
        packshot_sha256: 'p'.repeat(64),
        // như make_video: caption + dòng tên file
        draft_text: `${script.caption}\n\nTệp video: ${sha}.mp4`,
        guardrail: script.guardrail,
        meta: {
          schema: 'video_asset@1',
          file: `${sha}.mp4`,
          asset_sha256: sha,
          duration_ms: 24000,
          labels: [AI, AD],
          tts: { provider: 'none', voice: null },
        },
        script,
      },
      { by: 'agent:mkt04' },
    )) as Any;
    expect(s.status).toBe('created');
    await approveAsHuman(s.draft_id);
  });
});
