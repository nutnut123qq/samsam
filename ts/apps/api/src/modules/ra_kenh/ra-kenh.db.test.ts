import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { loadConfig as loadDirector, submit } from '@samsam/core/ops/director';
import { contentSha256, saveDraft, verifyPublish } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath, repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { featureForReport, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { HumanDenied, setDirectorsDir } from '@samsam/core/security/auth';
import { check, checkPublish } from '@samsam/core/security/guardrail';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings as fbSettings } from '../messenger_fanpage/fanpage.js';
import * as pt from './partner.js';
import { type CliDeps, raKenhMain } from './ra-kenh.command.js';
import * as rk from './ra-kenh.js';

// Dịch phần DB của tests/test_ra_kenh.py (F1–F5 + P6–P8 E2E, đồng hồ 24h, red_alert S1, idempotent,
// kế thừa đợt, lệch bản duyệt, --mark-removed, báo cáo tuần chỉ SELECT), test_contract_c12 (tự thu
// web/listing, svc_job), test_r16_fanpage (Fanpage, kế thừa snapshot NGƯỜI), test_r17/r18/r19 (cổng
// TẮT trước mọi ghi, nguồn hỏng, ngày hỏng), test_v14_p5 + test_v15_p12 (đối tác), test_v15_p10 /
// fix_p102 (ghi qua function `*_human`, danh tính theo login). DB riêng `testDbName('ra_kenh')` từ mẫu
// (KHÔNG BAO GIỜ `samsam`), xóa khi xong; mỗi ca làm sạch bảng động. Tên người là giả lập.

const NAME = testDbName('ra_kenh');
const FIX = repoPath('tests/fixtures/ra_kenh');
const CFG = rk.loadConfig();
const U = {
  1: 'https://samsamngoclinh.com/',
  2: 'http://samsam.net.vn/',
  3: 'https://samsamngoclinh.com/product/savigout/',
  4: 'http://samsam.net.vn/vi/news/cam-nang-suc-khoe/savigout-xua-tan-noi-lo-benh-gout-10.html',
  5: 'https://samsam.net.vn/',
} as const;
const H_MS = 3600_000;
const T0 = new Date('2026-10-12T09:00:00+07:00');
const at = (h: number) => new Date(T0.getTime() + h * H_MS);
const H = 'url,kenh,is_ai,ngay_dang,draft_id,text\n';
const NEUTRAL =
  'Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem sản phẩm mới. Nội dung có sử dụng AI.';
const NO_AI_LABEL = 'Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem sản phẩm mới.';
const BAD = 'Sâm Sâm chữa khỏi bệnh tiểu đường cho người bị tiểu đường.';
const OK = 'Sâm Sâm ra mắt hộp quà Tết mới.';
const HUMAN = 'Quản lý MXH (test)';
const FB = 'https://facebook.com/samsam/posts/';
const PAGE = '1234567890';
const TOKEN = 'FBTOKEN_SECRET_r16xyz';
const RESET = [
  'channel_posts',
  'approval_queue',
  'decisions',
  'approvals',
  'red_alerts',
  'red_alert_deliveries',
  'agent_action_log',
  'content_drafts',
  'partner_post_scans',
  'market_rows',
  'market_snapshots',
  'report_outputs',
  'human_logins',
  'xnqc_dossiers',
];

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('ra_kenh (DB)', () => {
  let pool: pg.Pool;
  let dsn: string;
  let tmp: string;
  let seq = 0;
  const extraPools: pg.Pool[] = [];
  const roles: string[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (table: string, where = 'true') =>
    Number((await q(`select count(*)::int as n from ${table} where ${where}`))[0]?.n);
  const counts = async () =>
    [await n('channel_posts'), await n('approval_queue'), await n('red_alerts')] as const;
  const latest = async (url: string) =>
    (
      await q(
        'select id::text as id, codes, severity, first_detected_at, due_at, queue_id::text as queue_id,' +
          ' alert_id::text as alert_id, closed_at, close_reason from channel_posts where url = $1 order by id desc limit 1',
        [url],
      )
    )[0] as {
      id: string;
      codes: string[];
      severity: string | null;
      first_detected_at: Date | null;
      due_at: Date | null;
      queue_id: string | null;
      alert_id: string | null;
      closed_at: Date | null;
      close_reason: string | null;
    };
  const reasonOf = async (id: string) =>
    (await q('select close_reason from channel_posts where id = $1', [id]))[0]?.close_reason;
  const csv = (body: string, head = H) => {
    const p = join(tmp, `f${seq++}.csv`);
    writeFileSync(p, Buffer.from(head + body, 'utf8'));
    return p;
  };
  const load = (path: string, now: Date, by = HUMAN, db: Db = pool) =>
    rk.ingest(db, rk.readExport(path, CFG), CFG, { by, now });
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const deps = (c: ReturnType<typeof cap>, extra: Partial<CliDeps> = {}): CliDeps => ({
    io: c.io,
    env: {},
    connect: async () => ({ db: pool as Db, release: async () => {} }),
    wire: () => undefined,
    clock: () => T0,
    ...extra,
  });
  const draft = async (text = NEUTRAL, channel = 'facebook') => {
    const did = (await saveDraft(pool, {
      brief: 'brief test',
      channel,
      text,
      guardrail: check(text),
      createdBy: 'agent:mkt-test',
    })) as string;
    await q("select approve_draft($1, 'Phap Che Gia Lap', null)", [did]);
    return did;
  };
  const row = (url: string, channel: string, text: string, kw: Partial<rk.Row> = {}): rk.Row => ({
    line: null,
    url,
    channel,
    content_type: 'post',
    posted_on: null,
    is_ai: false,
    is_sponsored: false,
    sku: null,
    draft_id: null,
    text,
    sha: contentSha256(text),
    ...kw,
  });
  /** Login tạm `in role <role>` → pool riêng (role của cả cluster — tên có pid). */
  const loginPool = async (tag: string, role: string): Promise<[pg.Pool, string]> => {
    const login = `t_rk_${tag}_${process.pid}`;
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password 'pw_${tag}' in role ${role}`);
    roles.push(login);
    const u = new URL(dsn);
    u.username = login;
    u.password = `pw_${tag}`;
    const p = createPool(u.toString(), { max: 2 });
    extraPools.push(p);
    return [p, login];
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ra-kenh-db-'));
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn, { max: 4 });
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
  });

  afterAll(async () => {
    settings.forceMode = null;
    for (const p of extraPools) await p.end();
    await pool?.end();
    await dropDb(NAME);
    for (const r of roles) await adminQuery(`drop role if exists ${r}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    settings.forceMode = 'van_hanh';
    rk.hooks.link = null;
    rk.hooks.checkPublish = checkPublish as typeof rk.hooks.checkPublish;
    fbSettings.sleep = async () => {};
    await withTx(pool, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(`truncate ${RESET.join(', ')} restart identity cascade`);
    });
  });

  // ============================================================ kênh sở hữu (test_ra_kenh.py)
  it('E2E F1–F5 + P6–P8: đồng hồ 24h, S1 → red_alert, approve ≠ đóng, idempotent, kế thừa đợt, lệch bản duyệt, báo cáo chỉ SELECT, --mark-removed', async () => {
    let st = await load(join(FIX, 'f1_f5.csv'), T0);
    expect([st.new, st.S1, st.S2, st.tickets, st.alerts]).toEqual([5, 3, 2, 5, 3]);
    const queue = await q(
      'select object_type, block, payload, id::text as id, extract(epoch from due_at - created_at)::int as sla from approval_queue order by id',
    );
    expect(
      queue.filter((x) => x.object_type === 'channel_takedown' && x.block === 'legal_hr'),
    ).toHaveLength(4);
    expect(
      queue.filter((x) => x.object_type === 'hosting_fix' && x.block === 'data_platform'),
    ).toHaveLength(1);
    expect(queue.every((x) => x.sla === 24 * 3600)).toBe(true);
    const post: Record<number, Awaited<ReturnType<typeof latest>>> = {};
    for (const k of [1, 2, 3, 4, 5] as const) post[k] = await latest(U[k]);
    for (const [k, p] of Object.entries(post)) {
      expect((p.due_at as Date).getTime() - (p.first_detected_at as Date).getTime()).toBe(
        24 * H_MS,
      );
      expect(p.due_at).toEqual(new Date('2026-10-13T09:00:00+07:00'));
      expect(p.queue_id).not.toBeNull();
      expect(p.closed_at).toBeNull();
      expect(p.alert_id !== null, k).toBe(['1', '3', '4'].includes(k));
    }
    expect(post[5]?.codes).toEqual(['trang_mac_dinh_hosting']);
    expect(post[4]?.codes).not.toContain('thieu_ban_duyet');
    expect(post[2]?.codes).toEqual(['ngoc_linh_chua_xac_nhan', 'thieu_ban_duyet']);
    for (const c of ['ruou_cam_quang_cao', 'tu_cam', 'sku_chua_xnqc', 'thieu_khuyen_cao']) {
      expect(post[1]?.codes).toContain(c);
    }
    for (const c of ['sku_chua_xnqc', 'thieu_khuyen_cao', 'claim_ngoai_cong_bo']) {
      expect(post[3]?.codes).toContain(c);
    }
    const alerts = await q('select title, route_error, detail from red_alerts order by id');
    expect(alerts).toHaveLength(3);
    expect(alerts.every((a) => a.route_error)).toBe(true);
    expect(new Set(alerts.map((a) => String(a.detail.post_id)))).toEqual(
      new Set([post[1]?.id, post[3]?.id, post[4]?.id]),
    );
    for (const x of queue) {
      expect(check(x.payload).ok).toBe(true); // payload duyệt được: không chép vi phạm
      expect(x.payload).not.toContain('chữa');
      expect(x.payload).not.toContain('thuốc');
      expect(x.payload).toContain('agent không gỡ/sửa');
    }
    expect(await decide(pool, post[1]?.queue_id as string, 'Pháp chế A', 'approved')).toEqual([
      true,
      null,
    ]);
    expect((await latest(U[1])).closed_at).toBeNull(); // approve ≠ đóng
    // nạp lại y hệt → 0 mới
    let before = await counts();
    st = await load(join(FIX, 'f1_f5.csv'), at(1));
    expect([st.new, st.skip]).toEqual([0, 5]);
    expect(await counts()).toEqual(before);
    // F4 quét lại sau khi người sửa: hết từ cấm, đồng hồ KHÔNG reset
    st = await load(join(FIX, 'f4_quet_lai.csv'), at(3));
    expect([st.new, st.tickets, st.alerts]).toEqual([1, 0, 0]);
    const f4 = await latest(U[4]);
    expect(f4.codes).not.toContain('tu_cam');
    expect(f4.codes).toContain('sku_chua_xnqc');
    for (const k of ['first_detected_at', 'due_at', 'queue_id', 'alert_id'] as const) {
      expect(f4[k], k).toEqual(post[4]?.[k]);
    }
    expect(await reasonOf(post[4]?.id as string)).toBe('thay_ban_moi');
    // revert về text gốc → snapshot mới, mở lại tu_cam (vẫn cùng đợt)
    before = await counts();
    st = await load(join(FIX, 'f1_f5.csv'), at(3));
    expect(st.new).toBe(1);
    expect((await counts()).slice(1)).toEqual(before.slice(1));
    const f4b = await latest(U[4]);
    expect(f4b.codes).toContain('tu_cam');
    expect(f4b.due_at).toEqual(post[4]?.due_at);
    // P6–P8: đối chiếu bản duyệt
    const did = await draft();
    const pcsv = (p7: string) =>
      csv(
        `${[
          `${FB}6,facebook,0,,${did},${NEUTRAL}`,
          `${FB}7,facebook,0,,${did},${p7}`,
          `${FB}8,facebook,0,2026-10-13,,${NEUTRAL}`,
        ].join('\n')}\n`,
      );
    st = await load(pcsv(`${NEUTRAL}!`), at(3));
    const [p6, p7, p8] = [await latest(`${FB}6`), await latest(`${FB}7`), await latest(`${FB}8`)];
    expect([p6.severity, p6.queue_id]).toEqual([null, null]);
    expect(await verifyPublish(pool, did, `${NEUTRAL}!`)).toBe(false);
    expect([p7.codes, p7.severity]).toEqual([['lech_ban_duyet'], 'S2']);
    expect(p7.queue_id).not.toBeNull();
    expect(p7.alert_id).toBeNull();
    expect([p8.codes, p8.severity]).toEqual([['thieu_ban_duyet'], 'S2']);
    expect([st.tickets, st.alerts]).toEqual([2, 0]);
    st = await load(pcsv(NEUTRAL), at(3));
    expect(await reasonOf(p7.id)).toBe('da_sua');
    expect(
      await q(
        "select actor, detail->'ids' as ids from agent_action_log where action = 'channel_post_fixed'",
      ),
    ).toEqual([{ actor: HUMAN, ids: [Number(p7.id)] }]);
    // mục F3 bị Pháp chế reject, F5 expired → vi phạm VẪN mở
    expect(await decide(pool, post[3]?.queue_id as string, 'Pháp chế A', 'rejected')).toEqual([
      true,
      null,
    ]);
    await q(
      "update approval_queue set status = 'expired', decided_by = 'system:sla' where id = $1",
      [post[5]?.queue_id],
    );
    expect((await latest(U[3])).closed_at).toBeNull();
    expect((await latest(U[5])).closed_at).toBeNull();

    // ---- W43.5 báo cáo (chỉ SELECT)
    before = await counts();
    const noon = at(3);
    let rep = await rk.collectReport(pool, noon, 7);
    expect(await counts()).toEqual(before);
    const s1 = rep.open.filter((d) => d.severity === 'S1').map((d) => d.url);
    expect([...s1].sort()).toEqual([U[1], U[3], U[4]].sort());
    expect(rep.open.slice(0, 3).map((d) => d.severity)).toEqual(['S1', 'S1', 'S1']);
    expect(new Set(rep.open.filter((d) => d.severity === 'S2').map((d) => d.url))).toEqual(
      new Set([U[2], U[5], `${FB}8`]),
    );
    expect(rep.open.filter((d) => noon > d.due_at)).toEqual([]);
    expect(rep.closed.map((c) => c.reason)).toEqual(['da_sua']);
    let text = rk.renderReport(rep, noon);
    expect(text).toContain('đúng hạn 1, trễ 0');
    expect(text).toContain('### QUÁ 24H — 0');
    expect(text).toContain('CẢNH BÁO');
    expect(text).toContain(U[1]);
    expect(text).not.toContain('chữa');
    expect(text).not.toContain('thuốc');
    for (const h of ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.']) expect(text).toContain(h);
    expect(text).toContain('lech_ban_duyet: đang mở 0, phát hiện trong kỳ 1');
    expect(text).toContain('thieu_ban_duyet: đang mở 4, phát hiện trong kỳ 4');
    // --mark-removed qua CLI
    let c = cap();
    expect(await raKenhMain({ markRemoved: U[2], by: 'agent:x' }, deps(c))).toBe(2);
    expect((await latest(U[2])).closed_at).toBeNull();
    c = cap();
    expect(
      await raKenhMain({ markRemoved: U[2], by: 'Quản lý MXH' }, deps(c, { clock: () => at(4) })),
    ).toBe(0);
    const f2 = await latest(U[2]);
    expect(f2.close_reason).toBe('da_go');
    expect(f2.closed_at).toEqual(at(4));
    expect(await raKenhMain({ markRemoved: U[2], by: 'Quản lý MXH' }, deps(cap()))).toBe(1);
    expect(
      await raKenhMain(
        { markRemoved: 'https://samsam.net.vn/khong', by: 'Quản lý MXH' },
        deps(cap()),
      ),
    ).toBe(1);
    const due = post[1]?.due_at as Date;
    rep = await rk.collectReport(pool, due, 7); // biên: = due → chưa quá
    expect(rep.open.filter((d) => due > d.due_at)).toEqual([]);
    const after = new Date(due.getTime() + 1000);
    rep = await rk.collectReport(pool, after, 7);
    expect(new Set(rep.open.filter((d) => after > d.due_at).map((d) => d.url))).toEqual(
      new Set([U[1], U[3], U[4], U[5]]),
    ); // F2 đã da_go
    text = rk.renderReport(rep, after);
    expect(text).toContain('### QUÁ 24H — 4');
    expect(text).toContain('QUÁ 0.0 giờ');
    // CLI --report ghi file vào thư mục báo cáo (tmp)
    c = cap();
    const outDir = join(tmp, 'reports');
    expect(
      await raKenhMain({ report: true, now: '2026-10-13T09:00:01' }, deps(c, { outDir })),
    ).toBe(0);
    expect(c.out.join('\n')).toContain('QUÁ 24H — 4');
    expect(c.out.join('\n')).toContain('phap-che-tuan-2026-10-13.md');
  });

  it('mark_removed → hash chain nguyên vẹn; bài vẫn còn trong bản xuất → mở đợt mới', async () => {
    await load(join(FIX, 'f1_f5.csv'), T0);
    expect((await rk.markRemoved(pool, U[2], 'Quản lý MXH', T0))[0]).toBe(true);
    expect(
      await q(
        "select actor, object_type from agent_action_log where action = 'channel_post_removed'",
      ),
    ).toEqual([{ actor: 'Quản lý MXH', object_type: 'channel_post' }]);
    expect(await q('select * from verify_action_log()')).toEqual([]);
    expect((await rk.markRemoved(pool, U[2], 'agent:x', T0))[0]).toBe(false);
    const st = await load(join(FIX, 'f1_f5.csv'), at(30));
    expect([st.new, st.tickets]).toEqual([1, 1]);
    const p = await latest(U[2]);
    expect(p.first_detected_at).toEqual(at(30));
    expect(p.closed_at).toBeNull();
  });

  it('CLI --file in ra đã che PII; tiêu đề cảnh báo đỏ không chứa URL', async () => {
    const c = cap();
    const p = csv(
      'https://samsam.net.vn/a,web,0,2021-01-11,,Sâm chữa khỏi bệnh — gọi 0912 345 678\n',
    );
    expect(await raKenhMain({ file: p, by: 'Quản lý MXH' }, deps(c))).toBe(0);
    const out = c.out.join('\n');
    expect(out).toContain('mới 1');
    expect(out).toContain('red_alert mới 1');
    expect(out).not.toContain('0912 345 678');
    expect(out).toContain('13/10/2026 09:00');
    const [a] = await q("select title, detail->>'post_id' as pid from red_alerts");
    expect(a?.title).toBe(`S1 web: bài #${a?.pid}`);
    expect(a?.title).not.toContain('http');
  });

  it('sự cố giữa snapshot và mục hàng duyệt → nạp lại gắn lại, không trùng', async () => {
    rk.hooks.link = async () => {};
    await load(join(FIX, 'f4_quet_lai.csv'), T0);
    let p = await latest(U[4]);
    expect([p.queue_id, p.alert_id]).toEqual([null, null]);
    rk.hooks.link = null;
    let st = await load(join(FIX, 'f4_quet_lai.csv'), T0);
    expect([st.skip, st.tickets, st.alerts]).toEqual([1, 1, 1]);
    p = await latest(U[4]);
    expect(p.queue_id && p.alert_id).toBeTruthy();
    st = await load(join(FIX, 'f4_quet_lai.csv'), T0);
    expect([st.tickets, st.alerts]).toEqual([0, 0]);
    expect([await n('approval_queue'), await n('red_alerts')]).toEqual([1, 1]);
  });

  it('cùng text_sha256 KHÔNG đủ để bỏ qua: cột bài hoặc luật đổi → rà lại', async () => {
    const a = csv(`${FB}1,facebook,0,,,${NEUTRAL}\n${FB}2,facebook,0,2021-01-11,,${NEUTRAL}\n`);
    let st = await load(a, T0);
    expect([st.new, st.S2, st.tickets]).toEqual([2, 1, 1]);
    const p1 = await latest(`${FB}1`);
    expect(p1.codes).toEqual(['thieu_ban_duyet']);
    expect((await latest(`${FB}2`)).severity).toBeNull();
    const before = await counts();
    st = await load(a, at(1));
    expect([st.new, st.skip]).toEqual([0, 2]);
    expect(await counts()).toEqual(before);
    const did = await draft();
    st = await load(csv(`${FB}1,facebook,0,,${did},${NEUTRAL}\n`), at(2));
    expect([st.new, st.closed, st.tickets]).toEqual([1, 1, 0]);
    expect((await latest(`${FB}1`)).severity).toBeNull();
    expect(
      await q('select close_reason, closed_at from channel_posts where id = $1', [p1.id]),
    ).toEqual([{ close_reason: 'da_sua', closed_at: at(2) }]);
    expect(
      await q(
        "select detail->'ids' as ids from agent_action_log where action = 'channel_post_fixed'",
      ),
    ).toEqual([{ ids: [Number(p1.id)] }]);
    expect(await q('select * from verify_action_log()')).toEqual([]);
    // luật chặt hơn → bài từng sạch nay S1
    rk.hooks.checkPublish = (text, o) => {
      const g = checkPublish(text, o) as unknown as Record<string, unknown>;
      const v = {
        code: 'tu_cam',
        severity: 'critical',
        type: 'banned_word',
        detail: 'luật mới',
        span: String(text).slice(0, 3),
        start: 0,
        end: 3,
      };
      return { ...g, ok: false, violations: [...(g.violations as unknown[]), v] };
    };
    st = await load(a, at(3));
    expect([st.new, st.S1, st.tickets, st.alerts]).toEqual([2, 2, 2, 2]);
    const p2 = await latest(`${FB}2`);
    expect(p2.codes).toEqual(['tu_cam']);
    expect(p2.due_at).toEqual(at(27));
    st = await load(a, at(3));
    expect([st.new, st.skip, st.tickets, st.alerts]).toEqual([0, 2, 0, 0]);
  });

  it('hạ tầng ↔ nội dung trên cùng URL: đóng đợt cũ, mở đợt mới đúng khối', async () => {
    const url = 'https://samsam.net.vn/k';
    const ld = async (text: string, h: number) =>
      [await load(csv(`${url},web,0,,,${text}\n`), at(h)), await latest(url)] as const;
    const tickets = async () =>
      (await q('select object_type, block from approval_queue order by id')).map((r) => [
        r.object_type,
        r.block,
      ]);
    const [, p0] = await ld('Welcome to nginx!', 0);
    expect(p0.codes).toEqual(['trang_mac_dinh_hosting']);
    expect(await tickets()).toEqual([['hosting_fix', 'data_platform']]);
    let [st, p1] = await ld('Welcome to nginx! Sâm chữa khỏi bệnh gout', 1);
    expect(p1.severity).toBe('S1');
    expect(p1.codes).toContain('tu_cam');
    expect(p1.codes).toContain('trang_mac_dinh_hosting');
    expect(p1.due_at).toEqual(at(25));
    expect((await tickets()).at(-1)).toEqual(['channel_takedown', 'legal_hr']);
    expect([st.tickets, st.alerts]).toEqual([1, 1]);
    expect(p1.alert_id).not.toBeNull();
    expect(await reasonOf(p0.id)).toBe('thay_ban_moi');
    const [st2, p2] = await ld('Welcome to nginx!', 2);
    expect(p2.codes).toEqual(['trang_mac_dinh_hosting']);
    expect(p2.alert_id).toBeNull();
    expect(p2.due_at).toEqual(at(26));
    expect((await tickets()).at(-1)).toEqual(['hosting_fix', 'data_platform']);
    expect([st2.tickets, st2.closed]).toEqual([1, 1]);
    expect(await reasonOf(p1.id)).toBe('da_sua');
    [st, p1] = await ld('Sâm chữa khỏi bệnh gout', 3);
    expect(p1.codes).not.toContain('trang_mac_dinh_hosting');
    expect(p1.severity).toBe('S1');
    expect(p1.due_at).toEqual(at(27));
    expect(await reasonOf(p2.id)).toBe('da_sua');
    expect(await tickets()).toEqual([
      ['hosting_fix', 'data_platform'],
      ['channel_takedown', 'legal_hr'],
      ['hosting_fix', 'data_platform'],
      ['channel_takedown', 'legal_hr'],
    ]);
    expect(await n('red_alerts')).toBe(2);
  });

  it('leo thang S2 → S1 cùng đợt: kế thừa ticket, BẮN red_alert', async () => {
    const url = 'https://samsam.net.vn/s';
    await load(csv(`${url},web,0,,,${NEUTRAL}\n`), T0);
    const p = await latest(url);
    expect([p.codes, p.alert_id]).toEqual([['thieu_ban_duyet'], null]);
    const st = await load(csv(`${url},web,0,,,Sâm chữa khỏi bệnh gout\n`), at(2));
    const r = await latest(url);
    expect([st.tickets, st.alerts]).toEqual([0, 1]);
    expect(r.severity).toBe('S1');
    expect(r.alert_id).not.toBeNull();
    expect([r.queue_id, r.due_at]).toEqual([p.queue_id, p.due_at]);
  });

  // Review r3: đợt mở do Python ghi có mốc MICRO giây (psycopg `datetime`); Date JS chỉ tới mili giây
  // → kế thừa qua Date làm lệch first_detected_at = tách đợt (KPI gỡ bài 24h ops_monthly gom đợt
  // theo (url, first_detected_at) → đếm dư + "trễ" giả).
  const pyWave = async (url: string, fdt: string, due: string) =>
    (
      await q(
        "insert into channel_posts (url, channel, content_type, is_ai, text, text_sha256, guardrail, codes, severity, first_detected_at, due_at, imported_by, scanned_at) values ($1, 'facebook', 'post', true, $2, $3, '{}'::jsonb, '{tu_cam}', 'S1', $4, $5, 'MXH Python', $4) returning id::text as id",
        [url, BAD, contentSha256(BAD), fdt, due],
      )
    )[0]?.id as string;

  it('đợt mở do Python ghi (mốc micro giây) → TS kế thừa đúng từng micro giây: 1 đợt, không tách', async () => {
    const url = `${FB}py-micro`;
    const FDT = '2026-10-12 02:00:00.123456+00';
    const DUE = '2026-10-13 02:00:00.123456+00';
    await pyWave(url, FDT, DUE);
    const st = await rk.ingest(
      pool,
      [row(url, 'facebook', `${BAD} Nội dung có sử dụng AI.`, { is_ai: true })],
      CFG,
      { by: HUMAN, now: at(2) },
    );
    expect([st.new, st.S1, st.tickets, st.alerts]).toEqual([1, 1, 1, 1]);
    const got = await q(
      'select close_reason, first_detected_at = $2::timestamptz as f, due_at = $3::timestamptz as d from channel_posts where url = $1 order by id',
      [url, FDT, DUE],
    );
    expect(got).toEqual([
      { close_reason: 'thay_ban_moi', f: true, d: true },
      { close_reason: null, f: true, d: true },
    ]);
    const waves = await q(
      'select count(distinct (url, first_detected_at))::int as n from channel_posts where url = $1',
      [url],
    );
    expect(waves[0]?.n).toBe(1);
    const [a] = await q(
      "select (detail->>'due_at')::timestamptz = $2::timestamptz as same from red_alerts where source_agent = $1",
      [rk.AGENT, DUE],
    );
    expect(a?.same).toBe(true);
  });

  it('cảnh báo đỏ S1: detail.due_at = isoformat Python theo TimeZone phiên (giữ micro giây, bỏ phần lẻ 0)', async () => {
    const dcfg = {
      legal_hr: loadDirector('legal_hr'),
      data_platform: loadDirector('data_platform'),
    };
    const ids = [
      await pyWave(`${FB}tz-1`, '2026-10-12 02:00:00.123456+00', '2026-10-13 02:00:00.123456+00'),
      await pyWave(`${FB}tz-2`, '2026-10-12 02:00:00+00', '2026-10-13 02:00:00+00'),
    ];
    const st: rk.Stats = {
      rows: 0,
      new: 0,
      skip: 0,
      S1: 0,
      S2: 0,
      closed: 0,
      tickets: 0,
      alerts: 0,
      items: [],
    };
    const c = await pool.connect();
    try {
      await c.query("set time zone 'Asia/Ho_Chi_Minh'");
      for (const id of ids) await rk.link(c, id, dcfg, st);
    } finally {
      await c.query('reset time zone');
      c.release();
    }
    expect([st.tickets, st.alerts]).toEqual([2, 2]);
    const got = await q(
      "select detail->>'due_at' as d from red_alerts where source_agent = $1 order by (detail->>'post_id')::bigint",
      [rk.AGENT],
    );
    expect(got.map((r) => r.d)).toEqual([
      '2026-10-13T09:00:00.123456+07:00',
      '2026-10-13T09:00:00+07:00',
    ]);
  });

  it('URL đúng MAX_URL byte (CJK không nén) + S1 vào được index btree', async () => {
    const base = 'https://www.facebook.com/samsam/posts/';
    let url = base;
    for (let i = 0; i < Math.floor((rk.MAX_URL - base.length) / 3); i++) {
      url += String.fromCodePoint(0x4e00 + ((i * 7919) % 20000));
    }
    url += 'a'.repeat(rk.MAX_URL - Buffer.byteLength(url, 'utf8'));
    expect(Buffer.byteLength(url, 'utf8')).toBe(rk.MAX_URL);
    const st = await load(csv(`${url},facebook,0,,,Sâm chữa khỏi bệnh gout\n`), T0);
    expect([st.new, st.alerts]).toEqual([1, 1]);
    expect((await latest(url)).severity).toBe('S1');
    expect((await rk.markRemoved(pool, url, 'Quản lý MXH', T0))[0]).toBe(true);
  });

  // ============================================================ C12 tự thu + r16 Fanpage
  const crawl = (name: string, rows: unknown[], ageDays = 0, dir = join(tmp, `c${seq++}`)) => {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${name}.jsonl`);
    writeFileSync(f, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nkhong-phai-json\n`);
    const t = Date.now() / 1000 - ageDays * 86400;
    utimesSync(f, t, t);
    return dir;
  };

  it('C12: quét tự thu → ticket 24h, idempotent; auto chỉ với AUTO_BY; file cần người', async () => {
    const d = crawl('articles', [
      { title: 'Bài A', body: BAD, url: 'https://samsam.example/a', published_at: '2026-10-01' },
      { title: 'Bài B', body: OK, url: 'https://samsam.example/b', published_at: '2025-01-01' },
    ]);
    const [rows] = rk.webRows(new Date(), d);
    const NOW = new Date('2026-10-20T09:00:00+07:00');
    let st = await rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: NOW, auto: true });
    expect(st.new).toBe(2);
    expect(st.S1).toBeGreaterThanOrEqual(1);
    const [r] = await q(
      "select extract(epoch from due_at - first_detected_at)::int as s, imported_by from channel_posts where url = 'https://samsam.example/a'",
    );
    expect(r).toEqual({ s: 24 * 3600, imported_by: rk.AUTO_BY });
    expect(await n('approval_queue', "block = 'legal_hr'")).toBeGreaterThanOrEqual(1);
    st = await rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: NOW, auto: true });
    expect([st.new, st.skip]).toEqual([0, 2]);
    await expect(
      rk.ingest(pool, rows, CFG, { by: 'Người Thật', now: NOW, auto: true }),
    ).rejects.toThrow(RangeError);
    await expect(rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: NOW })).rejects.toThrow(
      RangeError,
    );
  });

  it('C12: listing từ snapshot MỚI NHẤT, không cộng thieu_ban_duyet', async () => {
    for (const [i, [fn, title]] of [
      ['cu.csv', 'cũ'],
      ['moi.csv', BAD],
    ].entries()) {
      const [s] = await q(
        "insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count, imported_at) values ('shopee', 'listing', $1, $2, 1, now() + $3 * interval '1 minute') returning id",
        [fn, String(i).repeat(64), i],
      );
      await q(
        "insert into market_rows (snapshot_id, row_no, channel, export_kind, item_id, title, raw) values ($1, 2, 'shopee', 'listing', 'IT9', $2, '{}')",
        [s?.id, title],
      );
    }
    const rows = await rk.listingRows(pool);
    expect(rows.map((r) => [r.url, r.text])).toEqual([['shopee:listing:IT9', BAD]]);
    const s = rk.scanRow(rows[0] as rk.Row, CFG);
    expect(s.codes).not.toContain('thieu_ban_duyet');
    expect(s.severity).toBe('S1');
  });

  it('C12/r16: login svc_job ghi được (tự thu web + Fanpage)', async () => {
    const [job] = await loginPool('job', 'svc_job');
    const d = crawl('articles', [{ title: 'Bài A', body: BAD, url: 'https://samsam.example/a' }]);
    const [rows] = rk.webRows(new Date(), d);
    const fb = row(`https://www.facebook.com/${PAGE}/posts/1`, 'facebook', BAD, {
      text_is_post: true,
    });
    const st = await rk.ingest(job, [...rows, fb], CFG, { by: rk.AUTO_BY, now: T0, auto: true });
    expect([st.new, st.S1]).toEqual([2, 2]);
    expect(await n('approval_queue', "object_type = 'channel_takedown'")).toBe(2);
  });

  const alternate = async (csvRow: rk.Row, autoRow: rk.Row, days = 4) => {
    const out: rk.Stats[] = [];
    for (let day = 0; day < days; day++) {
      const now = at(24 * day);
      out.push(
        day % 2 === 0
          ? await rk.ingest(pool, [csvRow], CFG, { by: HUMAN, now })
          : await rk.ingest(pool, [autoRow], CFG, { by: rk.AUTO_BY, now, auto: true }),
      );
    }
    return out;
  };
  const urlCounts = async (url: string) => {
    const ids = (await q('select id::text as id from channel_posts where url = $1', [url])).map(
      (r) => r.id,
    );
    const fixed = await n(
      'agent_action_log',
      `action = 'channel_post_fixed' and object_id = any('{${ids.join(',')}}')`,
    );
    const tickets = await n(
      'approval_queue',
      `object_type = 'channel_takedown' and object_id = any('{${ids.map((i) => `channel_post:${i}`).join(',')}}')`,
    );
    return [fixed, tickets];
  };

  for (const [channel, url] of [
    ['facebook', `https://www.facebook.com/${PAGE}/posts/78`],
    ['web', 'https://samsamngoclinh.com/bai-78/'],
  ] as const) {
    it(`r16 fix1a (${channel}): tự thu kế thừa nhãn AI của snapshot người — không đóng giả, không đếm lại hạn`, async () => {
      const csvRow = row(url, channel, NO_AI_LABEL, {
        line: 2,
        posted_on: '2026-10-01',
        is_ai: true,
      });
      const autoRow = row(url, channel, NO_AI_LABEL, { posted_on: '2026-10-01' });
      const st = await alternate(csvRow, autoRow);
      expect([st[0]?.new, st[0]?.S2]).toEqual([1, 1]);
      expect(st.slice(1).map((s) => [s.new, s.closed, s.tickets])).toEqual([
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]);
      const rows = await q(
        'select id::text as id, closed_at, first_detected_at, due_at from channel_posts where url = $1',
        [url],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closed_at).toBeNull();
      expect(rows[0]?.first_detected_at).toEqual(T0);
      expect(rows[0]?.due_at).toEqual(at(24));
      expect(
        await n(
          'agent_action_log',
          `action = 'channel_post_fixed' and object_id = '${rows[0]?.id}'`,
        ),
      ).toBe(0);
    });
  }

  it('r16 fix1b: tự thu kế thừa bản duyệt — không S2 thieu_ban_duyet + ticket', async () => {
    const did = await draft();
    const url = `https://www.facebook.com/${PAGE}/posts/77`;
    const csvRow = row(url, 'facebook', NEUTRAL, {
      line: 2,
      posted_on: '2026-10-12',
      is_ai: true,
      draft_id: did,
    });
    const autoRow = row(url, 'facebook', NEUTRAL, { posted_on: '2026-10-12' });
    const st = await alternate(csvRow, autoRow);
    expect(st.map((s) => [s.S1, s.S2, s.tickets])).toEqual(Array(4).fill([0, 0, 0]));
    expect(await n('channel_posts', `url = '${url}'`)).toBe(1);
    expect(await n('approval_queue', "object_type = 'channel_takedown'")).toBe(0);
  });

  it('r16 fix1: chưa có snapshot người → mặc định; snapshot agent không là nguồn kế thừa', async () => {
    const url = `https://www.facebook.com/${PAGE}/posts/79`;
    const r = row(url, 'facebook', NO_AI_LABEL, { posted_on: '2026-10-12' });
    let st = await rk.ingest(pool, [r], CFG, { by: rk.AUTO_BY, now: T0, auto: true });
    expect([st.new, st.items[0]?.codes]).toEqual([1, ['thieu_ban_duyet']]);
    st = await rk.ingest(pool, [r], CFG, { by: rk.AUTO_BY, now: at(24), auto: true });
    expect([st.new, st.skip]).toEqual([0, 1]);
  });

  for (const posted of ['2026-10-01', '2026-10-20']) {
    it(`r16 fix2a web tiêu đề + thân vs CSV thân có bản duyệt (${posted}) → 0 ticket, 0 đóng giả`, async () => {
      const did = await draft(NEUTRAL, 'blog');
      const url = 'https://samsamngoclinh.com/bai-fix2a/';
      const d = crawl('articles', [
        { title: 'Tuần mới vui vẻ', body: NEUTRAL, url, published_at: posted },
      ]);
      const [autoRows] = rk.webRows(new Date(), d);
      expect(autoRows[0]?.text).toBe(`Tuần mới vui vẻ  ${NEUTRAL}`);
      const csvRow = row(url, 'web', NEUTRAL, {
        line: 2,
        posted_on: posted,
        is_ai: true,
        draft_id: did,
      });
      const st = await alternate(csvRow, autoRows[0] as rk.Row);
      expect(st.map((s) => [s.S1, s.S2, s.tickets, s.closed])).toEqual(Array(4).fill([0, 0, 0, 0]));
      for (const s of st) if (s.items.length) expect(s.items[0]?.codes).toEqual([]);
      expect(await urlCounts(url)).toEqual([0, 0]);
    });
  }

  it('r16 fix2a web vi phạm THẬT ở cả hai đường: đợt giữ nguyên, 1 ticket', async () => {
    const url = 'https://samsamngoclinh.com/bai-fix2a-vp/';
    const d = crawl('articles', [
      { title: 'Tuần mới vui vẻ', body: NO_AI_LABEL, url, published_at: '2026-10-01' },
    ]);
    const [autoRows] = rk.webRows(new Date(), d);
    const csvRow = row(url, 'web', NO_AI_LABEL, { line: 2, posted_on: '2026-10-01', is_ai: true });
    const st = await alternate(csvRow, autoRows[0] as rk.Row);
    expect(st.filter((s) => s.new).length).toBeGreaterThan(0);
    expect(st.every((s) => s.closed === 0)).toBe(true);
    expect(
      new Set(st.filter((s) => s.items.length).map((s) => s.items[0]?.codes.join(','))).size,
    ).toBe(1);
    expect(
      await q(
        'select distinct first_detected_at, due_at from channel_posts where url = $1 and severity is not null',
        [url],
      ),
    ).toEqual([{ first_detected_at: T0, due_at: at(24) }]);
    expect(await urlCounts(url)).toEqual([0, 1]);
  });

  it('r16 fix2a web mang phán quyết thieu_ban_duyet của snapshot người', async () => {
    const url = 'https://samsamngoclinh.com/bai-fix2a-thieu/';
    const d = crawl('articles', [
      { title: 'Tuần mới vui vẻ', body: NEUTRAL, url, published_at: '2026-10-20' },
    ]);
    const [autoRows] = rk.webRows(new Date(), d);
    const csvRow = row(url, 'web', NEUTRAL, { line: 2, posted_on: '2026-10-20', is_ai: true });
    const st = await alternate(csvRow, autoRows[0] as rk.Row);
    expect(
      new Set(st.filter((s) => s.items.length).map((s) => s.items[0]?.codes.join(','))),
    ).toEqual(new Set(['thieu_ban_duyet']));
    expect(st.every((s) => s.closed === 0)).toBe(true);
    expect(await urlCounts(url)).toEqual([0, 1]);
  });

  it('r16 fix2b: cùng chữ hai đường + bản duyệt → sạch, 1 snapshot', async () => {
    const did = await draft();
    const url = `https://www.facebook.com/${PAGE}/posts/81`;
    const st = await alternate(
      row(url, 'facebook', NEUTRAL, {
        line: 2,
        posted_on: '2026-10-12',
        is_ai: true,
        draft_id: did,
      }),
      row(url, 'facebook', NEUTRAL, { posted_on: '2026-10-12' }),
    );
    expect(st.map((s) => [s.S2, s.tickets])).toEqual(Array(4).fill([0, 0]));
    expect(await n('channel_posts', `url = '${url}'`)).toBe(1);
  });

  // ---- Fanpage qua server giả
  type Srv = { url: string; requests: string[]; close: () => Promise<void> };
  const servers: Srv[] = [];
  const server = async (body: unknown, status = 200): Promise<Srv> => {
    const requests: string[] = [];
    const s = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const srv = {
      url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
      requests,
      close: () => new Promise<void>((r) => s.close(() => r())),
    };
    servers.push(srv);
    return srv;
  };
  afterEach(async () => {
    while (servers.length) await servers.pop()?.close();
  });
  const fbEnv = (s: Srv) => ({
    FANPAGE_PAGE_ID: PAGE,
    FANPAGE_READ_TOKEN: TOKEN,
    FANPAGE_API_BASE: s.url,
  });
  const fbPost = (i: number, text: string, link?: string) => ({
    id: `${PAGE}_${i}`,
    message: text,
    created_time: '2026-10-20T03:00:00+0000',
    permalink_url: link ?? `https://www.facebook.com/${PAGE}/posts/${i}`,
  });

  it('r16: Fanpage → ticket legal_hr, idempotent', async () => {
    const s = await server({ data: [fbPost(1, BAD), fbPost(2, OK)] });
    const [rows, , rc] = await rk.fanpageRows(pool, { env: fbEnv(s) });
    expect(rc).toBeNull();
    expect(rows).toHaveLength(2);
    const NOW = new Date('2026-10-27T09:00:00+07:00');
    let st = await rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: NOW, auto: true });
    expect([st.new, st.S1]).toEqual([2, 1]);
    const [r] = await q(
      'select channel, extract(epoch from due_at - first_detected_at)::int as s, imported_by from channel_posts where url = $1',
      [`https://www.facebook.com/${PAGE}/posts/1`],
    );
    expect(r).toEqual({ channel: 'facebook', s: 24 * 3600, imported_by: rk.AUTO_BY });
    expect(
      await n('approval_queue', "block = 'legal_hr' and object_type = 'channel_takedown'"),
    ).toBeGreaterThanOrEqual(1);
    st = await rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: NOW, auto: true });
    expect([st.new, st.skip]).toEqual([0, 2]);
  });

  it('r16 fix2c: Fanpage SỬA sau duyệt → lech_ban_duyet (phát hiện thật không mất)', async () => {
    const did = await draft();
    const url = `https://www.facebook.com/${PAGE}/posts/82`;
    let st = await rk.ingest(
      pool,
      [
        row(url, 'facebook', NEUTRAL, {
          line: 2,
          posted_on: '2026-10-12',
          is_ai: true,
          draft_id: did,
        }),
      ],
      CFG,
      { by: HUMAN, now: T0 },
    );
    expect(st.S2).toBe(0);
    const edited = `${NEUTRAL} Giảm giá 50% hôm nay.`;
    const s = await server({ data: [fbPost(82, edited, url)] });
    const [rows, , rc] = await rk.fanpageRows(null, { env: fbEnv(s) });
    expect(rc).toBeNull();
    expect(rows[0]?.text).toBe(edited);
    st = await rk.ingest(pool, rows, CFG, { by: rk.AUTO_BY, now: at(24), auto: true });
    expect(st.items[0]?.codes).toContain('lech_ban_duyet');
    expect(st.tickets).toBe(1);
  });

  it('r16 fix2 minor: chữ Fanpage giữ như CSV (khoảng trắng cuối) → xen kẽ 0 ticket', async () => {
    const text = `${NEUTRAL}\n#samsam\n`;
    const did = await draft(text);
    const url = `https://www.facebook.com/${PAGE}/posts/83`;
    const s = await server({ data: [fbPost(83, text, url)] });
    const [rows] = await rk.fanpageRows(null, { env: fbEnv(s) });
    const st = await alternate(
      row(url, 'facebook', text, { line: 2, posted_on: '2026-10-12', is_ai: true, draft_id: did }),
      rows[0] as rk.Row,
    );
    expect(st.map((x) => [x.S2, x.tickets, x.closed])).toEqual(Array(4).fill([0, 0, 0]));
    expect(await urlCounts(url)).toEqual([0, 0]);
  });

  // ============================================================ r17/r18/r19 cổng TẮT + nguồn hỏng
  const URL17 = 'https://samsam.net.vn/vi/news/r17-bai-thu.html';
  const state = async () => [
    await n('channel_posts'),
    await n('approval_queue'),
    await n('red_alerts'),
    await n('agent_action_log', "action = 'channel_post_fixed'"),
    await n('channel_posts', 'closed_at is null and severity is not null'),
  ];

  it('r17: TẮT → RolloutBlocked TRƯỚC mọi ghi ở cả đường file và tự thu', async () => {
    const st = await load(csv(`${URL17},web,0,2021-01-11,,${BAD}\n`), T0);
    expect([st.new, st.tickets]).toEqual([1, 1]);
    const before = await state();
    expect(before[4]).toBe(1);
    settings.forceMode = 'tat';
    await expect(load(csv(`${URL17},web,0,2021-01-11,,${NEUTRAL}\n`), at(1))).rejects.toThrow(
      RolloutBlocked,
    );
    await expect(load(csv(`${URL17},web,0,2021-01-11,,${NEUTRAL}\n`), at(1))).rejects.toThrow(
      'legal_hr-04',
    );
    const d = crawl('articles', [
      { title: 'T', body: NEUTRAL, url: URL17 },
      { title: 'T2', body: BAD, url: `${URL17}?b` },
    ]);
    const [web] = rk.webRows(T0, d);
    expect(web).toHaveLength(2);
    await expect(
      rk.ingest(pool, web, CFG, { by: rk.AUTO_BY, now: at(2), auto: true }),
    ).rejects.toThrow(RolloutBlocked);
    expect(await state()).toEqual(before);
  });

  it('r17: CLI --file / --scan-auto khi TẮT → exit 2, 0 dòng', async () => {
    settings.forceMode = 'tat';
    let c = cap();
    expect(
      await raKenhMain(
        { file: csv(`${URL17},web,0,2021-01-11,,${BAD}\n`), by: 'Quản lý MXH' },
        deps(c),
      ),
    ).toBe(2);
    expect(c.out.join('\n')).toContain('[rollout]');
    expect(c.out.join('\n')).toContain('legal_hr-04');
    const d = crawl('articles', [{ title: 'T', body: BAD, url: URL17 }]);
    c = cap();
    expect(
      await raKenhMain({ scanAuto: true }, deps(c, { webRows: (now) => rk.webRows(now, d) })),
    ).toBe(2);
    expect(c.out.join('\n')).toContain('[rollout]');
    expect(await state()).toEqual([0, 0, 0, 0, 0]);
  });

  it('r18: --scan-auto bỏ bài/dòng có NUL/surrogate, bài khác vẫn nạp (không [err])', async () => {
    const WEB = 'https://samsam.net.vn/vi/news/r18-';
    const FBP = `https://www.facebook.com/${PAGE}/posts/`;
    const d = join(tmp, `r18_${seq++}`);
    mkdirSync(d);
    const lone = (cp: number) => String.fromCharCode(cp);
    const recs = [
      { title: 'T', body: BAD, url: `${WEB}sach.html` },
      { title: 'T', body: 'a\x00b', url: `${WEB}nul-chu.html` },
      { title: 'T', body: `a${lone(0xd800)}b`, url: `${WEB}sur-chu.html` },
      { title: 'T', body: OK, url: `${WEB}nul-url\x00.html` },
      { title: 'T', body: OK, url: `${WEB}sur-url${lone(0xdc80)}.html` },
    ];
    writeFileSync(join(d, 'articles.jsonl'), `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const s = await server({
      data: [
        fbPost(1, BAD),
        fbPost(2, 'Sâm Sâm\x00 chữa khỏi bệnh'),
        fbPost(3, `Sâm Sâm ${lone(0xd800)} ra mắt`),
        fbPost(4, OK, `${FBP}4\x00`),
        fbPost(5, OK, `${FBP}5\n`),
        fbPost(6, OK, `${FBP}${lone(0xdc80)}6`),
      ],
    });
    const c = cap();
    expect(
      await raKenhMain(
        { scanAuto: true },
        deps(c, { env: fbEnv(s), webRows: (now) => rk.webRows(now, d) }),
      ),
    ).toBe(0);
    const out = c.out.join('\n');
    expect(out).not.toContain('[err]');
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('bỏ 5 bài');
    expect(out).toContain('bỏ 4 dòng');
    expect(new Set((await q('select url from channel_posts')).map((r) => r.url))).toEqual(
      new Set([`${WEB}sach.html`, `${FBP}1`]),
    );
    expect(await n('channel_posts', "severity = 'S1'")).toBe(2);
  });

  it('r19: --scan-auto ngày crawl không có thật → posted_on null, cả lượt vẫn chạy', async () => {
    const WEB = 'https://samsam.net.vn/vi/news/r19-';
    const d = crawl('articles', [
      { title: 'T', body: BAD, url: `${WEB}sach.html`, published_at: '2026-10-20T08:00:00+07:00' },
      { title: 'T', body: OK, url: `${WEB}thang13.html`, published_at: '2026-13-45' },
      { title: 'T', body: OK, url: `${WEB}zero.html`, published_at: '0000-00-00' },
      { title: 'T', body: OK, url: `${WEB}30-2.html`, published_at: '2026-02-30' },
    ]);
    const c = cap();
    expect(
      await raKenhMain({ scanAuto: true }, deps(c, { webRows: (now) => rk.webRows(now, d) })),
    ).toBe(0);
    expect(c.out.join('\n')).not.toContain('[err]');
    const got = Object.fromEntries(
      (await q('select url, posted_on::text as p from channel_posts')).map((r) => [r.url, r.p]),
    );
    expect(got[`${WEB}sach.html`]).toBe('2026-10-20');
    for (const k of ['thang13', 'zero', '30-2']) expect(got[`${WEB}${k}.html`]).toBeNull();
    expect(await n('channel_posts', "severity = 'S1'")).toBe(1);
  });

  // ============================================================ --mark-removed qua login người
  it('P10.2: mark_removed ghi qua function *_human — login người đúng khối; --by giả / sai khối → HumanDenied, 0 đổi', async () => {
    await load(join(FIX, 'f1_f5.csv'), T0);
    const [legal, legalLogin] = await loginPool('legal', 'app_human');
    const [sales, salesLogin] = await loginPool('sales', 'app_human');
    await q(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, 'Pháp Chế Giả', '{legal_hr}', 'test'), ($2, 'Bán Hàng Giả', '{sales}', 'test')",
      [legalLogin, salesLogin],
    );
    const snap = async () =>
      q(
        'select id, closed_at, close_reason, closed_by from channel_posts where url = $1 order by id',
        [U[2]],
      );
    const s0 = await snap();
    await expect(rk.markRemoved(legal, U[2], 'Bán Hàng Giả', T0)).rejects.toThrow(HumanDenied);
    await expect(rk.markRemoved(sales, U[2], 'Bán Hàng Giả', T0)).rejects.toThrow(HumanDenied);
    expect(await snap()).toEqual(s0);
    expect(await n('agent_action_log', "action = 'authz_denied'")).toBe(0); // dev: không ghi log từ chối
    await expect(legal.query('update channel_posts set closed_at = now()')).rejects.toThrow(
      /permission denied/,
    );
    // CLI chế độ thực không có người duyệt khối legal_hr → chặn (exit 1), 0 đổi
    let c = cap();
    expect(
      await raKenhMain(
        { markRemoved: U[2], by: 'Pháp Chế Giả' },
        deps(c, {
          env: { APPROVAL_ENFORCE: '1' },
          connect: async () => ({ db: legal as Db, release: async () => {} }),
        }),
      ),
    ).toBe(1);
    expect(await snap()).toEqual(s0);
    const [ok, msg] = await rk.markRemoved(legal, U[2], 'Pháp Chế Giả', T0);
    expect([ok, msg]).toEqual([true, 'đã ghi nhận gỡ — đóng 1 dòng (da_go)']);
    const got = await snap();
    expect(got[0]?.close_reason).toBe('da_go');
    expect(got[0]?.closed_by).toBe('Pháp Chế Giả');
    c = cap();
    expect(
      await raKenhMain(
        { markRemoved: U[2], by: 'Pháp Chế Giả' },
        deps(c, { connect: async () => ({ db: legal as Db, release: async () => {} }) }),
      ),
    ).toBe(1); // chạy lại: không có đợt mở
    expect(c.out.join('\n')).toContain('không có đợt');
  });

  it('P10.2 chế độ thực (test_v15_fix_p102): mỗi lần CLI --mark-removed bị chặn → 1 authz_denied; agent:/system: exit 2 trước connect', async () => {
    const url = 'https://www.facebook.com/samsam.gia/posts/p102000000001';
    await pyWave(url, '2026-10-12 02:00:00+00', '2026-10-13 02:00:00+00');
    const P = {
      legal: 'Pháp Chế P102',
      sales: 'Bán Hàng P102',
      lnb: 'Pháp Chế Khối Khác',
      nomap: 'Chưa Ủy Quyền',
    };
    const [legal, legalLogin] = await loginPool('rlegal', 'app_human');
    const [sales, salesLogin] = await loginPool('rsales', 'app_human');
    const [lnb, lnbLogin] = await loginPool('rlnb', 'app_human');
    const [nomap, nomapLogin] = await loginPool('rnomap', 'app_human');
    await q(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, '{legal_hr}', 'test'), ($3, $4, '{sales}', 'test'), ($5, $6, '{sales}', 'test')",
      [legalLogin, P.legal, salesLogin, P.sales, lnbLogin, P.lnb],
    );
    const users = join(tmp, `users${seq++}.json`);
    writeFileSync(
      users,
      JSON.stringify({
        [P.legal]: { role: 'phap_che', db_login: legalLogin },
        [P.sales]: { role: 'phap_che', db_login: salesLogin },
        [P.lnb]: { role: 'phap_che', db_login: lnbLogin },
        [P.nomap]: { role: 'phap_che', db_login: nomapLogin },
      }),
    );
    const dirs = join(tmp, `directors${seq++}`);
    mkdirSync(dirs);
    for (const b of ['legal_hr', 'data_platform']) {
      copyFileSync(dataPath(`directors/${b}.json`), join(dirs, `${b}.json`));
    }
    const approvers = (names: string[]) => {
      const f = join(dirs, 'legal_hr.json');
      writeFileSync(
        f,
        JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), approvers: names }),
      );
    };
    const env = { APPROVAL_ENFORCE: '1', AUTH_USERS_FILE: users };
    const cli = async (db: pg.Pool, by: string) => {
      const c = cap();
      const rc = await raKenhMain(
        { markRemoved: url, by },
        deps(c, { env, connect: async () => ({ db: db as Db, release: async () => {} }) }),
      );
      return [rc, c.out.join('\n')] as const;
    };
    const snap = () =>
      q('select id, closed_at, close_reason, closed_by from channel_posts where url = $1', [url]);
    const denied = () =>
      n(
        'agent_action_log',
        `action = 'authz_denied' and object_type = 'channel_post' and object_id = '${rk.urlSha12(url)}'`,
      );
    const s0 = await snap();
    setDirectorsDir(dirs);
    try {
      approvers([P.legal, P.lnb]);
      for (const [db, by] of [
        [sales, P.sales], // sai khối
        [sales, P.legal], // --by giả
        [lnb, P.lnb], // khối không thuộc login (DB từ chối)
        [nomap, P.nomap], // không thuộc người duyệt
      ] as const) {
        const [rc, out] = await cli(db, by);
        expect([by, rc], out).toEqual([by, 1]);
        expect(await snap()).toEqual(s0);
      }
      for (const by of ['agent:p102', 'system:cron']) {
        expect((await cli(legal, by))[0]).toBe(2); // chặn trước khi kết nối
      }
      approvers([]);
      expect((await cli(legal, P.legal))[0]).toBe(1);
      expect(await snap()).toEqual(s0);
      expect(await denied()).toBe(5);
      approvers([P.legal, P.lnb]);
      const [rc, out] = await cli(legal, P.legal);
      expect([rc, out.includes('đóng 1 dòng')], out).toEqual([0, true]);
    } finally {
      setDirectorsDir();
    }
    const got = await snap();
    expect([got[0]?.close_reason, got[0]?.closed_by]).toEqual(['da_go', P.legal]);
    expect(await denied()).toBe(5);
  });

  it('--report: báo cáo tuần KHÔNG thuộc tính năng nào trong danh mục → TẮT vẫn ghi (Python feature_for_report = None)', async () => {
    settings.forceMode = 'tat';
    expect(featureForReport(rk.reportName(T0))).toBeNull();
    const c = cap();
    const outDir = join(tmp, `rep${seq++}`);
    expect(
      await raKenhMain({ report: true, now: '2026-10-12T09:00:00' }, deps(c, { outDir })),
    ).toBe(0);
    expect(c.out.join('\n')).toContain('[ok] đã ghi data/reports/phap-che-tuan-2026-10-12.md');
  });

  // ============================================================ đối tác (marketing-04.2)
  const PHDR = 'ma_doi_tac,url,kenh,text,ngay_dang,sku\n';
  const URL1 = 'https://www.tiktok.com/@chi.lan.review/video/7300000000000000001';
  const URL2 = 'https://www.tiktok.com/@chi.lan.review/video/7300000000000000002';
  const BAD_TEXT = 'Sâm này chữa ung thư, uống là khỏi bệnh #quangcao';
  const OK_TEXT = 'Hộp quà Tết biếu gia đình rất sang #quangcao';
  const KIT_PAYLOAD =
    '# Kit KOC KOC-MAU-01 — `mat-ong-sam-300ml` × tiktok (NHÁP — chỉ phát hành bản đã duyệt)\n\n## Brief\n\nHộp quà Tết\n\n## Điểm được nói\n\n- Chỉ nội dung trong brief ở trên\n\n## Nhãn bắt buộc khi đăng\n\n- #quangcao\n';
  const NOWP = new Date('2026-10-14T09:00:00+07:00');
  const prow = (body: string) => pt.readPartnerExport(csv(body, PHDR));
  const approvedKit = async () => {
    const qid = await submit(pool, {
      block: 'marketing',
      objectType: 'koc_brief',
      objectId: 'koc-KOC-MAU-01-aaaaaaaaaaaa',
      title: 'Kit KOC KOC-MAU-01',
      payload: KIT_PAYLOAD,
      createdBy: 'agent:mkt_koc',
    });
    expect(await decide(pool, qid, 'GD Marketing', 'approved')).toEqual([true, null]);
    return String(qid);
  };
  const pqueue = () =>
    q(
      "select id::text as id, block, object_id, title, payload, status, created_by, is_sample, guardrail from approval_queue where object_type = 'partner_post_review' order by id",
    );
  const policy = (pol: string) => {
    const f = join(tmp, `pol${seq++}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        ma_doi_tac_la: {
          chinh_sach: pol,
          chon_boi: 'GĐ Marketing Giả Lập',
          can_cu: 'QĐ giả lập 1',
        },
      }),
    );
    return f;
  };
  const mixed = () =>
    prow(
      `KOC-MAU-02,${URL1},tiktok,"${OK_TEXT}",2026-10-13,\nKOL-NGOAI-99,${URL2},tiktok,"${OK_TEXT}",2026-10-13,\n`,
    );

  it('đối tác: mục theo ĐỢT, không PII/handle, payload duyệt được; nạp lại idempotent; sổ append-only', async () => {
    const kit = await approvedKit();
    const rows = prow(
      `KOC-MAU-01,${URL1},tiktok,"${BAD_TEXT}",2026-10-13,mat-ong-sam-300ml\nKOC-MAU-01,${URL2},tiktok,"${OK_TEXT}",2026-10-13,mat-ong-sam-300ml\n`,
    );
    const st = await pt.ingestPartner(pool, rows, { by: 'Lan MXH', now: NOWP });
    expect([st.new, st.S1, st.tickets]).toEqual([2, 1, 1]);
    const qs = await pqueue();
    expect(qs).toHaveLength(1);
    const x = qs[0] as Record<string, unknown>;
    expect([x.block, x.status, x.created_by, x.is_sample]).toEqual([
      'marketing',
      'pending',
      'agent:mkt_doi_tac',
      true,
    ]);
    expect(x.payload).toContain(`koc_brief#${kit}`);
    expect(x.payload).toContain('tu_cam');
    for (const leak of ['chi.lan', '@', '/video/', 'ung thư', 'khỏi bệnh']) {
      for (const k of ['payload', 'title', 'object_id'])
        expect(String(x[k]), `${k} ${leak}`).not.toContain(leak);
    }
    expect((x.guardrail as { ok: boolean }).ok).toBe(true);
    const scans = await q(
      'select partner_code, host, codes, severity, queue_id::text as queue_id, is_sample from partner_post_scans order by id',
    );
    expect(scans.map((s) => s.severity)).toEqual(['S1', null]);
    expect(scans[0]?.queue_id).toBe(x.id);
    expect(scans[1]?.queue_id).toBeNull();
    const st2 = await pt.ingestPartner(pool, rows, { by: 'Lan MXH', now: NOWP });
    expect([st2.new, st2.skip, st2.tickets]).toEqual([0, 2, 0]);
    expect(await pqueue()).toHaveLength(1);
    await expect(pool.query("update partner_post_scans set codes = '{}'")).rejects.toThrow();
  });

  it('đối tác: vi phạm → sạch → quay lại vi phạm = ĐỢT mới', async () => {
    await approvedKit();
    const bad = prow(`KOC-MAU-01,${URL1},tiktok,"${BAD_TEXT}",2026-10-13,\n`);
    const ok = prow(`KOC-MAU-01,${URL1},tiktok,"${OK_TEXT}",2026-10-13,\n`);
    for (const rows of [bad, ok, bad])
      await pt.ingestPartner(pool, rows, { by: 'Lan MXH', now: NOWP });
    expect(await pqueue()).toHaveLength(2);
    expect(await n('partner_post_scans')).toBe(3);
  });

  it('đối tác: chưa có kit → thieu_bo_tai_lieu; mã lạ (CHƯA CHỌN chính sách) → cả file lỗi, 0 dòng', async () => {
    const st = await pt.ingestPartner(
      pool,
      prow(`KOC-MAU-02,${URL1},tiktok,"${OK_TEXT}",2026-10-13,\n`),
      {
        by: 'Lan MXH',
        now: NOWP,
      },
    );
    expect(st.S2).toBe(1);
    expect((await pqueue())[0]?.payload).toContain('thieu_bo_tai_lieu');
    const unk = prow(`KOL-NGOAI-99,${URL2},tiktok,abc,2026-10-13,\n`);
    let err: unknown;
    try {
      await pt.ingestPartner(pool, unk, { by: 'Lan MXH', now: NOWP });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(pt.UnknownPartner);
    expect((err as Error).message).toContain('không có trong sổ');
    expect((err as pt.UnknownPartner).warn).toContain('CHƯA CHỌN');
    expect(await n('partner_post_scans', "partner_code = 'KOL-NGOAI-99'")).toBe(0);
    // tu_choi_file chọn tường minh → không cảnh báo
    try {
      await pt.ingestPartner(pool, mixed(), {
        by: 'Lan MXH',
        now: NOWP,
        policyPath: policy('tu_choi_file'),
      });
    } catch (e) {
      err = e;
    }
    expect((err as pt.UnknownPartner).warn).toBeNull();
    expect(await n('partner_post_scans')).toBe(1);
  });

  it('đối tác: ghi_vi_pham → mã lạ thành vi phạm doi_tac_chua_dang_ky ≥ S2, không cờ mẫu; idempotent', async () => {
    const f = policy('ghi_vi_pham');
    const st = await pt.ingestPartner(pool, mixed(), { by: 'Lan MXH', now: NOWP, policyPath: f });
    expect([st.unknown, st.policy_warn]).toEqual([['KOL-NGOAI-99'], null]);
    expect([st.new, st.S2, st.tickets]).toEqual([2, 2, 2]);
    const unk = (
      await q(
        'select partner_code, codes, severity, is_sample, queue_id from partner_post_scans order by id',
      )
    ).find((r) => r.partner_code === 'KOL-NGOAI-99');
    expect(unk?.codes).toContain(pt.UNKNOWN_PARTNER);
    expect([unk?.severity, unk?.is_sample]).toEqual(['S2', false]);
    expect(unk?.queue_id).not.toBeNull();
    const payload = (await pqueue()).find((r) =>
      String(r.object_id).includes('KOL-NGOAI-99'),
    )?.payload;
    expect(payload).toContain(pt.UNKNOWN_PARTNER);
    const st2 = await pt.ingestPartner(pool, mixed(), { by: 'Lan MXH', now: NOWP, policyPath: f });
    expect([st2.new, st2.skip, st2.tickets]).toEqual([0, 2, 0]);
  });

  it('đối tác: tính năng TẮT → RolloutBlocked, 0 dòng', async () => {
    settings.forceMode = 'tat';
    await expect(
      pt.ingestPartner(pool, prow(`KOC-MAU-01,${URL1},tiktok,"${BAD_TEXT}",2026-10-13,\n`), {
        by: 'Lan MXH',
        now: NOWP,
      }),
    ).rejects.toThrow(RolloutBlocked);
    expect(await n('partner_post_scans')).toBe(0);
    expect(await n('approval_queue')).toBe(0);
  });

  it('đối tác CLI: mã lạ + chính sách chưa chọn → exit 1, in rõ tu_choi_file + CHƯA CHỌN', async () => {
    const c = cap();
    const p = csv(`KOL-NGOAI-99,${URL2},tiktok,abc,2026-10-13,\n`, PHDR);
    expect(await raKenhMain({ partnerFile: p, by: 'Lan MXH' }, deps(c))).toBe(1);
    const out = c.out.join('\n');
    expect(out).toContain('tu_choi_file');
    expect(out).toContain('CHƯA CHỌN');
  });

  it('P10.1: --by giả (login người khác) → HumanDenied TRƯỚC mọi ghi (0 mục hàng duyệt, 0 dòng sổ)', async () => {
    const [mkt, mktLogin] = await loginPool('mkt', 'app_human');
    await q(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, 'Lan MXH', '{marketing}', 'test')",
      [mktLogin],
    );
    const rows = prow(`KOC-MAU-01,${URL1},tiktok,"${BAD_TEXT}",2026-10-13,\n`);
    await expect(pt.ingestPartner(mkt, rows, { by: 'Người Khác', now: NOWP })).rejects.toThrow(
      HumanDenied,
    );
    expect([await n('approval_queue'), await n('partner_post_scans')]).toEqual([0, 0]);
    const c = cap();
    expect(
      await raKenhMain(
        {
          partnerFile: csv(`KOC-MAU-01,${URL1},tiktok,"${BAD_TEXT}",2026-10-13,\n`, PHDR),
          by: 'Người Khác',
        },
        deps(c, { connect: async () => ({ db: mkt as Db, release: async () => {} }) }),
      ),
    ).toBe(1);
    expect([await n('approval_queue'), await n('partner_post_scans')]).toEqual([0, 0]);
    // đúng người của login → ghi được qua function SECURITY DEFINER (login không INSERT trực tiếp)
    const st = await pt.ingestPartner(mkt, rows, { by: 'Lan MXH', now: NOWP });
    expect([st.new, st.S1]).toEqual([1, 1]);
    expect((await q('select scanned_by from partner_post_scans'))[0]?.scanned_by).toBe('Lan MXH');
    await expect(
      mkt.query(
        "insert into partner_post_scans (partner_code, url_sha256, host, channel, text_sha256, scanned_by) values ('X', $1, 'a.vn', 'web', $1, 'Lan MXH')",
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow();
  });
});
