import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { createPool } from '@samsam/core/db';
import { autoApprove, decide } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { saveDraft } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { checkPublish } from '@samsam/core/security/guardrail';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordConsent } from '../crm/crm.service.js';
import * as ims from '../image_video/image-studio.js';
import * as raster from '../image_video/raster.js';
import * as vs from '../image_video/video-studio.js';
import { pyDumps } from '../kd_price/deps.js';
import YT from './__fixtures__/mkt_youtube.golden.json' with { type: 'json' };
import * as mk from './mkt-koc.js';
import {
  type CliDeps,
  mktKocMain,
  mktUgcMain,
  mktYoutubeMain,
  seoSanMain,
} from './mkt-koc-ugc-seo.command.js';
import * as my from './mkt-youtube.js';
import * as ss from './seo-san.js';
import * as sw from './seo-web.js';

// Dịch phần DB của tests/test_mkt_koc.py, test_mkt_ugc.py, test_mkt_youtube.py (lưu nháp), test_seo_san.py,
// test_seo_web.py (submit). DB riêng `testDbName('mkt_koc_ugc_seo')` từ mẫu (KHÔNG BAO GIỜ `samsam`),
// xóa khi xong; mỗi ca làm sạch bảng động (truncate dưới replica). KOC/review/khách/Trends là dữ liệu MẪU.

const NAME = testDbName('mkt_koc_ugc_seo'); // t_mkt_koc_ugc_seo_<pid>_<rand> — chạy song song không giẫm nhau
const HONEY = 'mat-ong-sam-300ml';
const RUOU = 'ruou-sam-chai-thuy-tinh-500ml';
const HONEY_TEXT =
  'Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao Nội dung có sử dụng AI';
const REVIEWS = repoPath('tests/fixtures/mkt/review_shopee_MAU.csv');
const SALT = 'salt-test-v64-0123456789';
const LEAK = [
  '0901234567',
  'nguoimuagia@example.com',
  'NGUOI MUA GIA',
  'FAKEREV',
  'đau khớp',
  'gout',
  'thất vọng',
  'Giao chậm',
  'Rượu sâm biếu',
  'báo giá sỉ',
  'thơm ngon',
];
const RESET = [
  'approval_queue',
  'decisions',
  'agent_action_log',
  'content_drafts',
  'consents',
  'contacts',
  'social_mentions',
  'trends_related',
  'intel_imports',
  'market_rows',
  'market_snapshots',
  'report_outputs',
  'llm_usage',
];

const GR = JSON.parse(readFileSync(repoPath('data/guardrail_rules.json'), 'utf8'));
const AI: string = GR.labels.ai[0];
const AD: string = GR.labels.ad[0];
let HAS_SHARP = true;
try {
  await raster.sharp();
} catch {
  HAS_SHARP = false;
}
const RENDER =
  HAS_SHARP &&
  ims.fontsFor(`${AI} ${AD} MẪU B-roll Sương sớm vùng trồng Đóng gói quà quê`, {}) !== null;
const FF = vs.findFfmpeg(process.env); // mp4 thật chỉ khi có ffmpeg (FFMPEG_BIN/PATH)

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('mkt_koc_ugc_seo (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const replica = (sql: string) =>
    withTx(pool, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(sql);
    });
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const deps = (c: ReturnType<typeof cap>, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: c.io,
    env: { INTEL_HASH_SALT: SALT },
    connect: async () => ({ db: pool as Db, release: async () => {} }),
    wire: () => undefined,
    ...extra,
  });

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mkt-db-'));
    pool = createPool(await createDbFromTemplate(NAME), { max: 4 });
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
  });

  afterAll(async () => {
    settings.forceMode = null;
    await pool?.end();
    await dropDb(NAME);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    await replica(`truncate ${RESET.join(', ')} restart identity cascade`);
  });

  // ============================================================ mkt_koc
  async function draft(text = HONEY_TEXT, approve = true): Promise<string> {
    const g = checkPublish(text, { channel: 'tiktok', contentType: 'ads', sku: HONEY, isAi: true });
    const did = (await saveDraft(pool, {
      brief: 'brief MẪU',
      channel: 'tiktok',
      text,
      guardrail: g,
      createdBy: 'mkt lap',
      contentType: 'ads',
      sku: HONEY,
      isAi: true,
    })) as string;
    if (approve) await q("select approve_draft($1, 'duyet mkt', null)", [did]);
    return did;
  }

  it('koc: kit chỉ từ draft đã duyệt + hợp đồng đủ → mục koc_brief pending; chạy lại skip; phát hành chỉ bản đã duyệt + hợp đồng không đổi', async () => {
    const root = join(tmp, 'repo');
    mkdirSync(join(root, 'docs', 'legal'), { recursive: true });
    mkdirSync(join(root, 'tests', 'fixtures', 'mkt'), { recursive: true });
    const cp = join(root, 'docs', 'legal', 'mau-hop-dong-koc-NHAP.md');
    copyFileSync(repoPath('docs/legal/mau-hop-dong-koc-NHAP.md'), cp);
    copyFileSync(
      repoPath('tests/fixtures/mkt/hop-dong-koc-thieu-MAU.md'),
      join(root, 'tests', 'fixtures', 'mkt', 'hop-dong-koc-thieu-MAU.md'),
    );
    const reports = join(tmp, 'reports');
    await q(
      "update sku_master set self_declaration_ok = true, allowed_channels = '{shopee,tiktok}' where sku_key = $1",
      [HONEY],
    );
    const dOk = await draft();
    const dPend = await draft(HONEY_TEXT, false);
    const queue = () =>
      q(
        'select id::text as id, object_type, object_id, risk, status, payload from approval_queue order by id',
      );
    const kit = { kit: true, koc: 'KOC-MAU-01', sku: HONEY, by: 'mkt lap' };
    const extra = { root, outDir: reports };
    let c = cap();
    expect(await mktKocMain({ ...kit, draftIds: dPend }, deps(c, extra))).toBe(1);
    expect(c.out.join('\n')).toContain('KIT_CREATIVE_UNAPPROVED');
    c = cap();
    expect(await mktKocMain({ ...kit, koc: 'KOC-MAU-03', draftIds: dOk }, deps(c, extra))).toBe(1);
    expect(c.out.join('\n')).toContain('KIT_CONTRACT');
    expect(c.out.join('\n')).toContain('go_24h');
    expect(await queue()).toEqual([]);
    expect(await mktKocMain({ ...kit, draftIds: dOk, dryRun: true }, deps(cap(), extra))).toBe(0);
    expect(await queue()).toEqual([]);
    expect(await mktKocMain({ ...kit, draftIds: dOk }, deps(cap(), extra))).toBe(0);
    const rows = await queue();
    expect(rows).toHaveLength(1);
    const [row] = rows as {
      id: string;
      object_type: string;
      object_id: string;
      risk: string;
      status: string;
      payload: string;
    }[];
    expect([row?.object_type, row?.risk, row?.status]).toEqual(['koc_brief', 'medium', 'pending']);
    expect(row?.object_id.startsWith('koc-KOC-MAU-01-')).toBe(true);
    for (const s of ['#quangcao', 'AFF-KOC-MAU-01-', 'contract_sha256'])
      expect(row?.payload).toContain(s);
    c = cap();
    expect(await mktKocMain({ ...kit, draftIds: dOk }, deps(c, extra))).toBe(0); // chạy lại
    expect(c.out.join('\n')).toContain('[skip]');
    expect(await queue()).toHaveLength(1);
    const qid = (row as { id: string }).id;
    const rel = { release: qid, by: 'nguoi phat hanh' };
    c = cap();
    expect(await mktKocMain(rel, deps(c, extra))).toBe(1); // chưa duyệt
    expect(c.out.join('\n')).toContain('KIT_NOT_APPROVED');
    expect((await decide(pool, qid, 'mkt lap', 'approved'))[0]).toBe(false); // tự duyệt
    expect(await decide(pool, qid, 'GD Marketing', 'approved')).toEqual([true, null]);
    // sửa hợp đồng sau khi lập kit → chặn
    const orig = readFileSync(cp);
    writeFileSync(cp, Buffer.concat([orig, Buffer.from('\n\nPhụ lục 3. Bổ sung MẪU.\n')]));
    c = cap();
    expect(await mktKocMain(rel, deps(c, extra))).toBe(1);
    expect(c.out.join('\n')).toContain('KIT_CONTRACT_CHANGED');
    expect(existsSync(reports)).toBe(false);
    writeFileSync(cp, orig);
    c = cap();
    expect(await mktKocMain(rel, deps(c, extra))).toBe(0);
    const f = join(reports, `koc-kit-KOC-MAU-01-${qid}.md`);
    expect(readFileSync(f, 'utf8')).toBe(row?.payload);
    expect(c.out.join('\n')).toContain('gửi TAY');
    expect((await mk.release(pool, 99_999_999n)).code).toBe('KIT_NOT_APPROVED');
  });

  // ============================================================ mkt_ugc
  const ugcQ = (otype = 'ugc_reply') =>
    q(
      'select id::text as id, object_id, title, risk, status, payload, created_by from approval_queue where object_type = $1 order by id',
      [otype],
    ) as Promise<
      {
        id: string;
        object_id: string;
        title: string;
        risk: string;
        status: string;
        payload: string;
        created_by: string;
      }[]
    >;
  const refOf = async (lop: string) =>
    ((await ugcQ()).find((r) => r.title.includes(`[lop=${lop}]`)) as { object_id: string })
      .object_id;

  it('ugc: review → 6 mục NHÁP không chép nội dung khách; nạp lại skip; xin phép/tái sử dụng chỉ khi có consent marketing', async () => {
    const argv = { reviews: REVIEWS, channel: 'shopee', by: 'mxh lap' };
    let c = cap();
    expect(await mktUgcMain(argv, deps(c))).toBe(0);
    const rows = await ugcQ();
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect([r.risk, r.status, r.created_by]).toEqual(['medium', 'pending', 'mxh lap']);
      expect(r.object_id.startsWith('ugc-')).toBe(true);
      expect(r.object_id).toHaveLength(20);
      for (const s of LEAK) {
        expect(r.payload).not.toContain(s);
        expect(r.title).not.toContain(s);
      }
      expect(r.payload).toContain('người phụ trách đăng/gửi TAY');
    }
    for (const s of LEAK) expect(c.out.join('\n')).not.toContain(s);
    expect((await autoApprove(pool, (rows[0] as { id: string }).id))[0]).toBe(false); // không có luật
    c = cap();
    expect(await mktUgcMain(argv, deps(c))).toBe(0); // nạp lại → skip
    expect(c.out.join('\n')).toContain('skip 6');
    expect(await ugcQ()).toHaveLength(6);
    const khen = await refOf('khen');
    const claim = await refOf('claim_suc_khoe');
    const ruou = await refOf('sp_cam_qc');
    expect(await mktUgcMain({ reuseRequest: khen, by: 'mxh lap' }, deps(cap()))).toBe(0);
    const all = await ugcQ();
    expect(all).toHaveLength(7);
    expect(all.at(-1)?.title).toContain('xin_phep');
    for (const r of [claim, ruou]) {
      c = cap();
      expect(await mktUgcMain({ reuseRequest: r, by: 'mxh lap' }, deps(c))).toBe(1);
      expect(c.out.join('\n')).toContain('UGC_SENSITIVE');
    }
    c = cap();
    expect(await mktUgcMain({ reuseRequest: 'ugc-ffffffffffffffff', by: 'a' }, deps(c))).toBe(1);
    expect(c.out.join('\n')).toContain('UGC_UNKNOWN_REF');
    // tái sử dụng: không consent / consent rút / chỉ cskh → chặn, 0 ghi
    const c1 = String(
      await one(
        "insert into contacts (phone_hmac, phone_enc, source, created_by) values ($1, 'gAAAAAmau', 'manual', 'Lan') returning id",
        ['1'.padStart(64, '0')],
      ),
    );
    const total = async () => (await ugcQ('ugc_reuse')).length + (await ugcQ()).length;
    const n0 = await total();
    const reuse = { reuse: khen, contactId: c1, by: 'mxh lap' };
    c = cap();
    expect(await mktUgcMain(reuse, deps(c))).toBe(1);
    expect(c.out.join('\n')).toContain('UGC_NO_CONSENT');
    await recordConsent(
      pool,
      c1,
      'marketing',
      true,
      'form_giay',
      'Lan',
      'BB-MAU-01',
      'nhap-2026-10',
    );
    await recordConsent(pool, c1, 'marketing', false, 'form_giay', 'Lan');
    expect(await mktUgcMain(reuse, deps(cap()))).toBe(1);
    expect(await total()).toBe(n0);
    await recordConsent(pool, c1, 'cskh', true, 'form_giay', 'Lan', 'BB-MAU-02', 'nhap-2026-10');
    expect(await mktUgcMain(reuse, deps(cap()))).toBe(1);
    await recordConsent(
      pool,
      c1,
      'marketing',
      true,
      'form_giay',
      'Lan',
      'BB-MAU-03',
      'nhap-2026-10',
    );
    expect(await mktUgcMain(reuse, deps(cap()))).toBe(0);
    const ru = await ugcQ('ugc_reuse');
    expect(ru).toHaveLength(1);
    expect([ru[0]?.risk, ru[0]?.status, ru[0]?.object_id]).toEqual([
      'high',
      'pending',
      `reuse-${khen}-c${c1}`,
    ]);
    expect(ru[0]?.payload).toContain(`contact_id: ${c1}`);
    expect(ru[0]?.payload).not.toContain('gAAAAA');
    c = cap();
    expect(await mktUgcMain(reuse, deps(c))).toBe(0);
    expect(c.out.join('\n')).toContain('[skip]');
    // lớp nhạy cảm + có consent → vẫn chặn
    c = cap();
    expect(await mktUgcMain({ reuse: claim, contactId: c1, by: 'a' }, deps(c))).toBe(1);
    expect(c.out.join('\n')).toContain('UGC_SENSITIVE');
    expect(await ugcQ('ugc_reuse')).toHaveLength(1);
  });

  it('ugc: social_mentions chỉ nhãn (DPIA chưa ký) → mục theo kênh sở hữu, dry-run 0 ghi', async () => {
    const iid = await one(
      "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('social', 'MAU', 'sha-mau', 3) returning id",
    );
    for (const [ch, labels, sens, h] of [
      ['fanpage', ['khen'], false, 'a'],
      ['zalo_oa', ['hoi_suc_khoe'], true, 'b'],
      ['tiktok', ['khac'], false, 'c'],
    ] as const) {
      await q(
        "insert into social_mentions (import_id, channel, kind, posted_at, msg_hash, labels, sensitive) values ($1, $2, 'comment', '2026-10-05 10:00+07', $3, $4, $5)",
        [iid, ch, h.repeat(64), labels, sens],
      );
    }
    const argv = { mentions: true, since: '2026-10-01', by: 'mxh lap' };
    expect(await mktUgcMain({ ...argv, dryRun: true }, deps(cap()))).toBe(0);
    expect(await ugcQ()).toEqual([]);
    expect(await mktUgcMain(argv, deps(cap()))).toBe(0);
    const rows = await ugcQ();
    expect(rows).toHaveLength(2);
    const titles = rows.map((r) => r.title);
    expect(titles.some((t) => t.includes('[lop=khen] [kenh=facebook]'))).toBe(true);
    expect(titles.some((t) => t.includes('[lop=claim_suc_khoe] [kenh=zalo]'))).toBe(true);
    expect(rows.every((r) => r.payload.includes('social_mentions#'))).toBe(true);
    expect(await mktUgcMain({ ...argv, since: '2026-10-06' }, deps(cap()))).toBe(0);
    expect(await ugcQ()).toHaveLength(2);
  });

  // ============================================================ mkt_youtube
  it('youtube: gói đạt lưu nháp pending (agent:mkt12, video, prompt_version youtube_long@1)', async () => {
    const good = (YT.cases.find((c) => c.name === 'good') as (typeof YT.cases)[number]).queue;
    const ai = {
      chat: async (_a: string, _m: ChatMessage[]) => ({
        text: pyDumps(good[0]),
        model: 'fake/llm',
        provider: 'ollama' as const,
        tokensIn: 0,
        tokensOut: 0,
      }),
    };
    const BRIEF = 'Câu chuyện vùng trồng sâm và mùa quà Tết';
    const pkg = await my.writePackage(BRIEF, { ai });
    expect(pkg.ok).toBe(true);
    const did = await my.savePackage(pool, pkg, BRIEF);
    const [r] = await q(
      "select status, channel, content_type, created_by, is_ai, prompt_version, text, guardrail->>'ok' as ok from content_drafts where id = $1",
      [did],
    );
    expect([
      r?.status,
      r?.channel,
      r?.content_type,
      r?.created_by,
      r?.is_ai,
      r?.prompt_version,
    ]).toEqual(['pending', 'youtube', 'video', 'agent:mkt12', true, 'youtube_long@1']);
    expect(r?.text).toBe(pkg.text);
    expect(r?.ok).toBe('true');
    expect(await one('select count(*)::int from video_assets')).toBe(0);
  });

  const ytAi = () => {
    const good = (YT.cases.find((c) => c.name === 'good') as (typeof YT.cases)[number]).queue;
    return {
      chat: async (_a: string, _m: ChatMessage[]) => ({
        text: pyDumps(good[0]),
        model: 'fake/llm',
        provider: 'ollama' as const,
        tokensIn: 0,
        tokensOut: 0,
      }),
    };
  };
  const YT_BRIEF = 'Câu chuyện vùng trồng sâm và mùa quà Tết';

  it('youtube CLI --render: LƯU nháp TRƯỚC rồi dựng; thiếu B-roll → [short-fail] broll_thieu, exit 0', async () => {
    const c = cap();
    const empty = join(tmp, 'broll-trong');
    const rc = await mktYoutubeMain(
      { brief: YT_BRIEF, render: true, brollDir: empty, outDir: join(tmp, 'yt-o1') },
      { ...deps(c), ai: ytAi() },
    );
    expect(rc).toBe(0);
    const ok = c.out.findIndex((l) => /^\[ok\] nháp #\d+ pending/.test(l));
    expect(ok).toBeGreaterThanOrEqual(0);
    expect(c.out.slice(ok + 1)).toEqual(['[short-fail] broll_thieu']);
    expect(
      await one("select count(*)::int from content_drafts where created_by = 'agent:mkt12'"),
    ).toBe(1);
    expect(
      await one("select count(*)::int from agent_action_log where action = 'youtube_short_render'"),
    ).toBe(0);
  });

  it.skipIf(!FF || !RENDER)(
    'youtube: test_db_save_and_render_short — mp4 thật 9:16 có nhãn, không âm thanh/metadata, 1 dòng log',
    async () => {
      const pkg = await my.writePackage(YT_BRIEF, { ai: ytAi() });
      const did = (await my.savePackage(pool, pkg, YT_BRIEF)) as string;
      const bdir = join(tmp, 'broll');
      mkdirSync(bdir, { recursive: true });
      await vs.makeSampleBroll(join(bdir, 'a.png'));
      await vs.makeSampleBroll(join(bdir, 'b.jpg'), { exifGps: true });
      const out = join(tmp, 'yt-out');
      const [r] = await my.renderShorts(pkg, {
        brollDir: bdir,
        outDir: out,
        db: pool as Db,
        draftId: did,
      });
      expect(r?.ok, JSON.stringify(r)).toBe(true);
      const mp4 = r?.path as string;
      expect(basename(mp4)).toBe(
        `${createHash('sha256').update(readFileSync(mp4)).digest('hex')}.mp4`,
      );
      const side = JSON.parse(readFileSync(join(out, `${r?.sha256}.json`), 'utf8'));
      expect(side.privacyStatus).toBe('private');
      expect(side.labels).toEqual([AI, AD]);
      expect(side.duration_ms).toBeGreaterThanOrEqual(15000);
      expect(side.duration_ms).toBeLessThanOrEqual(45000);
      expect(side.broll.every((b: { license: string }) => b.license)).toBe(true);
      const [cfg] = vs.loadConfig();
      expect(r?.checks).toHaveLength(3);
      for (const ch of r?.checks ?? []) {
        expect(ch.label_ratio).toBeGreaterThanOrEqual(cfg?.extract_min_ratio as number);
      }
      const info = await vs.probeInfo(FF as string, mp4);
      expect(info).not.toContain('Audio:');
      expect(info.toLowerCase()).not.toContain('location');
      expect(info).not.toContain('creation_time');
      expect(info).not.toContain('Lavf');
      expect(
        await q(
          "select actor, object_id, detail from agent_action_log where action = 'youtube_short_render'",
        ),
      ).toEqual([
        {
          actor: 'agent:mkt12',
          object_id: did,
          detail: { sha256: r?.sha256, draft_id: Number(did) },
        },
      ]);
      expect(await one('select count(*)::int from video_assets')).toBe(0);
    },
  );

  // ============================================================ seo_san
  async function seedMarket(): Promise<void> {
    const snaps: [string, string][] = [
      ['Saphraton 20 viên cũ', '2026-10-01T01:00:00+00:00'],
      ['Saphraton 20 viên hộp giấy', '2026-10-05T01:00:00+00:00'],
    ];
    for (const [i, [title, ts]] of snaps.entries()) {
      const sid = await one(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', $1, $2, 2, $3) returning id",
        [`listing_${i}.csv`, String(i).padStart(64, '0'), ts],
      );
      for (const [rowNo, sku, t] of [
        [3, 'saphraton-20v', title],
        [2, 'saphraton-20v', `${title} (dòng 2)`],
        [4, RUOU, 'Rượu sâm'],
      ] as const) {
        await q(
          "insert into market_rows (snapshot_id, row_no, channel, export_kind, sku_key, title, raw) values ($1, $2, 'shopee', 'listing', $3, $4, '{}')",
          [sid, rowNo, sku, t],
        );
      }
    }
    const imports = [
      [['nhân sâm', 'top', 'nhân sâm cũ', '100', []]],
      [
        ['nhân sâm', 'top', 'nhân sâm tươi', '100', []],
        ['nhân sâm', 'top', 'rượu nhân sâm', '90', ['ruou']],
        ['quà biếu', 'rising', 'hộp quà sâm', 'Breakout', []],
      ],
    ] as const;
    for (const [i, rows] of imports.entries()) {
      const iid = await one(
        "insert into intel_imports (kind, file_name, file_sha256, row_count) values ('trend_related', $1, $2, $3) returning id",
        [`related_${i}.csv`, String(i + 7).padStart(64, '0'), rows.length],
      );
      for (const [seed, sec, qq, v, f] of rows) {
        await q(
          'insert into trends_related (import_id, seed, section, query, value, flags) values ($1, $2, $3, $4, $5, $6)',
          [iid, seed, sec, qq, v, f],
        );
      }
    }
  }

  it('seo_san: run tạo nháp listing pending (snapshot mới nhất, import mới nhất), chạy lại skipped; rượu refused', async () => {
    await seedMarket();
    expect(await ss.currentTitle(pool, 'saphraton-20v', 'shopee')).toBe(
      'Saphraton 20 viên hộp giấy (dòng 2)',
    );
    expect(new Set((await ss.loadRelated(pool)).map((r) => r.query))).toEqual(
      new Set(['nhân sâm tươi', 'rượu nhân sâm', 'hộp quà sâm']),
    );
    const rules = sw.loadRules();
    const items = await ss.run(pool, ['saphraton-20v', RUOU], ['shopee'], { dryRun: false, rules });
    expect(new Set(items.map((i) => `${i.sku}:${i.status}`))).toEqual(
      new Set(['saphraton-20v:created', `${RUOU}:refused`]),
    );
    const rows = await q(
      "select status, content_type, created_by, sku, channel, prompt_version, prompt_sha256, guardrail->>'ok' as ok, text from content_drafts",
    );
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, string>;
    expect([
      r.status,
      r.content_type,
      r.created_by,
      r.sku,
      r.channel,
      r.prompt_version,
      r.ok,
    ]).toEqual([
      'pending',
      'listing',
      'agent:MKT-11',
      'saphraton-20v',
      'shopee',
      'seo-san-v1',
      'true',
    ]);
    expect(r.prompt_sha256).toBe(ss.rulesSha256());
    expect(r.text).toContain('nhân sâm tươi');
    expect(r.text.toLowerCase()).not.toContain('rượu');
    const again = await ss.run(pool, ['saphraton-20v'], ['shopee'], { dryRun: false, rules });
    expect(again.map((i) => i.status)).toEqual(['skipped']);
    expect(await one('select count(*)::int from content_drafts')).toBe(1);
  });

  it('seo_san: --dry-run 0 INSERT; CLI ghi báo cáo theo ngày VN', async () => {
    await seedMarket();
    const rules = sw.loadRules();
    const items = await ss.run(pool, ['saphraton-20v', RUOU], ['shopee', 'tiktok'], {
      dryRun: true,
      rules,
    });
    expect(await one('select count(*)::int from content_drafts')).toBe(0);
    expect(items.every((i) => ['dry_run', 'refused'].includes(i.status))).toBe(true);
    expect(
      items.some(
        (i) => i.sku === 'saphraton-20v' && i.channel === 'shopee' && i.status === 'dry_run',
      ),
    ).toBe(true);
    const text = ss.render('2026-10-12', items, true);
    expect(text).toContain('--dry-run');
    expect(text).not.toContain('rượu nhân sâm');
    const out = join(tmp, 'seo-san');
    const c = cap();
    const late = new Date(Date.UTC(2026, 9, 12, 18, 0)); // 13/10 VN
    const rc = await seoSanMain(
      { run: true, dryRun: true, sku: 'saphraton-20v', channel: ['shopee'], outDir: out },
      deps(c, { now: () => late }),
    );
    expect(rc).toBe(0);
    expect(existsSync(join(out, 'seo-san-2026-10-13.md'))).toBe(true);
    expect(c.out.join('\n')).toContain('dry_run=1');
    expect(await one('select count(*)::int from content_drafts')).toBe(0);
  });

  // ============================================================ seo_web
  it('seo_web: submit → 1 mục marketing/seo_web_fix pending (payload không trích text vi phạm), lần 2 skipped', async () => {
    const d = join(tmp, 'crawl');
    mkdirSync(d, { recursive: true });
    const A = 'https://samsam.net.vn';
    writeFileSync(
      join(d, 'articles.jsonl'),
      `${[
        { title: 'T'.repeat(61), body: 'Bài viết bình thường', url: `${A}/vi/news/a1.html` },
        { title: '', body: 'Sâm giúp chữa bệnh', url: `${A}/vi/news/chua-benh.html` },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
    );
    const res = await sw.run({
      mode: 'from-crawl',
      dataDir: d,
      now: new Date(Date.UTC(2026, 9, 12, 2)),
    });
    const out = await sw.submitIssues(pool, res.day, 'from-crawl', res.issues);
    expect(out.status).toBe('created');
    const rows = await q(
      "select block, object_type, object_id, status, created_by, guardrail->>'ok' as ok, risk, payload from approval_queue",
    );
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, string>;
    expect([r.block, r.object_type, r.status, r.created_by, r.ok, r.risk]).toEqual([
      'marketing',
      'seo_web_fix',
      'pending',
      'agent:MKT-10',
      'true',
      'medium',
    ]);
    expect(r.object_id.startsWith('seo-web:2026-10-12:')).toBe(true);
    expect(r.object_id).toHaveLength(35);
    expect(r.payload).not.toContain('chữa');
    const again = await sw.submitIssues(pool, res.day, 'from-crawl', res.issues);
    expect(again.status).toBe('skipped');
    expect(await one('select count(*)::int from approval_queue')).toBe(1);
  });
});
