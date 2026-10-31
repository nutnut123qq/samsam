import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { createPool } from '@samsam/core/db';
import { autoApprove, decide } from '@samsam/core/ops/approval-queue';
import { run as directorRun, loadConfig } from '@samsam/core/ops/director';
import type { RunState } from '@samsam/core/ops/job-runs';
import { MISSING, raiseAlert } from '@samsam/core/ops/red-alert';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { featureFor, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ia from './intel-alert.js';
import * as ib from './intel-bulletin.js';
import * as lu from './legal-updates.js';
import * as ps from './persona-sim.js';

// Phần DB của tests/test_intel_alert.py, test_intel_bulletin.py, test_pc_a8.py, test_v15_p8_outputs.py
// (P8.3 luật tính năng tắt), test_v14_p6_ops.py (leo thang chỉ lọc intel), test_v13_c09_anchor_legal.py
// (legal_updates), test_persona_sim.py + test_v14_p3_rollout_edges.py (sim_runs). DB riêng dựng lại
// từ mẫu MỖI ca (như Python: schema tạm + ROLLBACK), xóa khi xong. Người nhận/người xác nhận là tên
// GIẢ LẬP; không gửi thư thật (sender giả), không gọi AI thật (chat giả).

type Obj = Record<string, unknown>;
const det = (r: unknown): Obj => ((r ?? {}) as Obj).detail as Obj;
const RECALL = 'Thu hồi lô sâm Sâm Sâm nghi giả mạo';
const GOOD_RCP = { name: 'Nguoi Nhan Gia Lap (test)', role: 'phap_che', channel: 'email' };
const ENV = {} as Record<string, string | undefined>;
const NOW = new Date('2026-10-12T09:00:00+07:00');
const DAY = '2026-10-12';
const T_SAM = 'Giá sâm Ngọc Linh tăng mạnh cuối năm';
const T_TP = 'Thị trường thực phẩm bảo vệ sức khỏe tăng trưởng';
const T_QC = 'Quảng cáo KOL bị siết';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('intel_alert nhóm (DB)', () => {
  let pool: pg.Pool;
  let name: string;
  let tmp: string;
  let rep: string;
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const n = async (table: string, where = 'true') =>
    Number(await one(`select count(*) from ${table} where ${where}`));
  const dbNow = async () => (await one('select now()')) as Date;
  const lease = () => async () => ({ db: pool, release: async () => {} });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const item = async (
    title: string,
    o: {
      topics?: string[];
      snippet?: string;
      flags?: string[];
      source?: string;
      fetched?: Date | string;
      daysAgo?: number;
    } = {},
  ): Promise<number> => {
    const url = `https://bao.example.vn/${randomUUID()}`;
    const fetched =
      o.fetched ?? (o.daysAgo !== undefined ? new Date(Date.now() - o.daysAgo * 86_400_000) : null);
    const id = await one(
      'insert into intel_items (url, domain, source, tier, title, snippet, published_at, fetched_at, content_sha256, topics, flags)' +
        " values ($1, 'bao.example.vn', $2, 'A', $3, $4, $5, coalesce($5::timestamptz, now()), $6, $7, $8) returning id",
      [
        url,
        o.source ?? 'fx71-a',
        title,
        o.snippet ?? '',
        fetched,
        randomUUID().replaceAll('-', ''),
        o.topics ?? ['sam'],
        o.flags ?? [],
      ],
    );
    return Number(id);
  };
  const alerts = async (where = 'true', p: unknown[] = []) =>
    q(
      `select id::int as id, title, detail, recipients, route_error from red_alerts where source_agent = 'intel_red_alert' and ${where} order by id`,
      p,
    );
  const stage = (fid: string, st: string) =>
    q(
      "insert into feature_rollout (feature_id, stage, updated_by) values ($1, $2, 'Test') on conflict (feature_id) do update set stage = excluded.stage",
      [fid, st],
    );
  const tsOf = async (aid: number) =>
    (await one('select ts from red_alerts where id = $1', [aid])) as Date;
  const plus = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
  type JobRec = [string, boolean, string | null];
  const fakeJob = (seen: JobRec[]) =>
    (async (job: string, body: (r: RunState) => Promise<unknown>) => {
      const r: RunState = { ok: true, detail: null };
      const res = await body(r);
      seen.push([job, r.ok, r.detail]);
      return res;
    }) as never;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ia-db-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    settings.forceMode = null;
  });
  beforeEach(async () => {
    name = testDbName('intel_alert');
    pool = createPool(await createDbFromTemplate(name));
    wireCore(pool);
    settings.forceMode = 'van_hanh';
    rep = join(tmp, randomUUID());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    settings.forceMode = null;
    await pool?.end();
    await dropDb(name);
  });

  // ------------------------------------------------------------ intel_alert

  it('quét → 1 cảnh báo/tin, thiếu người nhận vẫn ghi (fail-closed), leo thang 1 lần sau 2 giờ', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const iid = await item(RECALL);
    await item('Sâm Sâm ra mắt hộp quà Tết');
    const now = await dbNow();
    const s = await ia.scan(pool, now, { env: ENV });
    expect([s.alerts, s.unrouted, s.scanned]).toEqual([1, 1, 2]);
    const rows = await alerts();
    expect(rows.length).toBe(1);
    const [r] = rows as Obj[];
    expect(det(r).intel_item_id).toBe(iid);
    expect(det(r).rules).toEqual(['brand_negative']);
    expect(String(r?.title).startsWith(ia.ALERT_PREFIX) && String(r?.title).includes(RECALL)).toBe(
      true,
    );
    expect([r?.recipients, r?.route_error]).toEqual([[], MISSING]);
    expect(spy.mock.calls.flat().join('\n')).toContain('[RED-ALERT][warn]');
    const aid = r?.id as number;
    expect(s.ids).toEqual([aid]);
    expect((await ia.scan(pool, now, { env: ENV })).alerts).toBe(0);
    const ts = await tsOf(aid);
    expect((await ia.escalate(pool, plus(ts, 1.5), { env: ENV })).escalated).toBe(0);
    const e = await ia.escalate(pool, plus(ts, 2 + 1 / 60), { env: ENV });
    expect([e.escalated, e.ids]).toEqual([1, [aid]]);
    const esc = await alerts("detail ? 'escalation_of'");
    expect(esc.length).toBe(1);
    expect(det(esc[0]).escalation_of).toBe(aid);
    expect(String(esc[0]?.title)).toContain('CHƯA XÁC NHẬN');
    expect(esc[0]?.route_error).toBe(MISSING);
    expect((await ia.escalate(pool, plus(ts, 5), { env: ENV })).escalated).toBe(0);
    expect((await ia.scan(pool, now, { env: ENV })).alerts).toBe(0);
    const op = await ia.openAlerts(pool, plus(ts, 3));
    expect(op.map((d) => [d.id, d.escalated, d.age_h])).toEqual([[aid, true, 3.0]]);
    expect(await n('agent_action_log', "action = 'red_alert_raise'")).toBe(2);
  });

  it('người xác nhận chặn leo thang; xác nhận lần 2 bị từ chối', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await item(RECALL);
    await ia.scan(pool, await dbNow(), { env: ENV });
    const aid = (await alerts())[0]?.id as number;
    const ts = await tsOf(aid);
    const [ok, msg] = await ia.ack(pool, aid, '  Nguoi Xac Nhan Gia Lap  ', 'đã báo Pháp chế', {
      env: ENV,
    });
    expect(ok).toBe(true);
    expect(msg).toContain(`#${aid}`);
    expect(await q('select acked_by, note from red_alert_acks')).toEqual([
      { acked_by: 'Nguoi Xac Nhan Gia Lap', note: 'đã báo Pháp chế' },
    ]);
    expect((await ia.escalate(pool, plus(ts, 3), { env: ENV })).escalated).toBe(0);
    expect(await ia.openAlerts(pool, plus(ts, 3))).toEqual([]);
    const [ok2, msg2] = await ia.ack(pool, aid, 'Mai', null, { env: ENV });
    expect(ok2).toBe(false);
    expect(msg2).toContain('đã được xác nhận');
  });

  it('ack từ chối: bản leo thang (chỉ id gốc), nguồn khác, không phải gốc intel, không tồn tại', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await item(RECALL);
    await ia.scan(pool, await dbNow(), { env: ENV });
    const aid = (await alerts())[0]?.id as number;
    await ia.escalate(pool, plus(await tsOf(aid), 2 + 1 / 60), { env: ENV });
    const escId = (await alerts("detail ? 'escalation_of'"))[0]?.id as number;
    const other = Number(
      await one(
        "insert into red_alerts (source_agent, title) values ('agent:khac', 'đỏ') returning id",
      ),
    );
    const bare = Number(
      await one(
        "insert into red_alerts (source_agent, title) values ('intel_red_alert', 'đỏ') returning id",
      ),
    );
    const cases: [unknown, string][] = [
      [10 ** 9, 'không tìm thấy'],
      [escId, `xác nhận id gốc #${aid}`],
      [other, 'không thuộc'],
      [bare, 'không phải cảnh báo gốc intel'],
    ];
    for (const [id, want] of cases) {
      const [ok, msg] = await ia.ack(pool, id, 'Hoa', null, { env: ENV });
      expect(ok, String(id)).toBe(false);
      expect(msg).toContain(want);
    }
    expect(await n('red_alert_acks')).toBe(0);
  });

  it('người nhận hợp lệ → gửi (sender giả); tgd/ha_tang truyền tay vẫn bị lọc', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await item(RECALL);
    await item('Cảnh báo hàng giả mạo sâm Ngọc Linh bán trên mạng');
    const now = await dbNow();
    const sent: string[] = [];
    const sender = async (to: string) => {
      sent.push(to);
    };
    const rcp = { ...GOOD_RCP, channel: 'email:pc@vi-du.test' };
    const s = await ia.scan(pool, now, { routing: { recipients: [rcp] }, sender, env: ENV });
    expect([s.alerts, s.unrouted]).toEqual([2, 0]);
    expect(sent).toEqual(['pc@vi-du.test', 'pc@vi-du.test']);
    for (const r of await alerts())
      expect([r.recipients, r.route_error]).toEqual([[GOOD_RCP.name], null]);
    await item('Ngộ độc sau khi dùng sản phẩm Sâm Sâm không rõ nguồn gốc');
    const bad = {
      excluded_roles: [],
      recipients: [
        { ...rcp, role: 'tgd' },
        { ...rcp, role: 'ha_tang' },
      ],
    };
    const s2 = await ia.scan(pool, now, { routing: bad, sender, env: ENV });
    expect([s2.alerts, s2.unrouted, sent.length]).toEqual([1, 1, 2]);
    const last = (await alerts()).at(-1);
    expect([last?.recipients, last?.route_error]).toEqual([[], MISSING]);
  });

  it('ngoài lookback 48 giờ → không báo; tiến trình khác chèn trước → dup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = await item(RECALL);
    await q("update intel_items set fetched_at = now() - interval '49 hours' where id = $1", [old]);
    expect((await ia.scan(pool, await dbNow(), { env: ENV })).alerts).toBe(0);
    await item('Cảnh báo hàng giả mạo sâm Ngọc Linh bán trên mạng');
    const race = (async (...a: Parameters<typeof raiseAlert>) => {
      await raiseAlert(...a);
      return raiseAlert(...a);
    }) as typeof raiseAlert;
    const s = await ia.scan(pool, await dbNow(), { env: ENV, raise: race });
    expect([s.dup, s.alerts]).toEqual([1, 0]);
    expect((await alerts()).length).toBe(1);
  });

  it('CLI --run thiếu người nhận → exit 1 + job_runs ok=false; --open/--ack', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await item(RECALL);
    const seen: JobRec[] = [];
    const deps = (s: ReturnType<typeof io>) => ({
      io: s.io,
      env: ENV,
      connect: lease(),
      wire: () => {},
      job: fakeJob(seen),
    });
    let s = io();
    expect(await ia.intelAlertMain({ run: true }, deps(s))).toBe(1);
    const out = s.out.join('\n');
    expect(out).toContain('[RED-ALERT][warn]');
    expect(out).toContain('alerts=1');
    expect(out).toContain('GIẢ ĐỊNH');
    expect(seen.length).toBe(1);
    expect(seen[0]?.[0]).toBe('pipelines.intel_alert');
    expect(seen[0]?.[1]).toBe(false);
    expect(seen[0]?.[2]).toContain('alerts=1');
    expect(seen[0]?.[2]).toContain('unrouted=1');
    s = io();
    expect(await ia.intelAlertMain({ run: true }, deps(s))).toBe(0);
    s = io();
    expect(await ia.intelAlertMain({ open: true }, deps(s))).toBe(0);
    const aid = (await alerts())[0]?.id as number;
    expect(s.out.join('\n')).toContain(`#${aid}`);
    expect(s.out.join('\n')).toMatch(/h — /);
    s = io();
    expect(await ia.intelAlertMain({ ack: String(aid), by: 'Nguoi Gia Lap' }, deps(s))).toBe(0);
    expect(s.out[0]).toMatch(/^\[done\] /);
    s = io();
    expect(await ia.intelAlertMain({ ack: String(aid), by: 'Nguoi Gia Lap' }, deps(s))).toBe(1);
    expect(s.out[0]).toMatch(/^\[warn\] /);
    s = io();
    expect(await ia.intelAlertMain({ open: true }, deps(s))).toBe(0);
    expect(s.out[0]).toContain('không có cảnh báo');
  });

  it('CLI thiếu bảng → exit 1 kèm gợi ý apply_schema', async () => {
    await q('drop table red_alert_acks cascade');
    const s = io();
    expect(
      await ia.intelAlertMain(
        { open: true },
        { io: s.io, env: ENV, connect: lease(), wire: () => {} },
      ),
    ).toBe(1);
    expect(s.out[0]).toContain('apply_schema');
  });

  it('P8.3: luật của tính năng TẮT không sinh cảnh báo; bật lại → lần quét sau báo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    settings.forceMode = null;
    await stage('intel-02.3', 'tat');
    await stage('legal_hr-07', 'chay_thu');
    await item(RECALL); // brand_negative
    const leg = await item('Thông tư hướng dẫn ghi nhãn thực phẩm chức năng', {
      topics: ['phap_ly', 'tpbvsk'],
      source: 'cuc-attp-van-ban',
    });
    const now = await dbNow();
    let s = await ia.scan(pool, now, { env: ENV });
    expect([s.alerts, s.off]).toEqual([1, 1]);
    const rows = await alerts();
    expect(rows.length).toBe(1);
    expect(det(rows[0]).intel_item_id).toBe(leg);
    // 'regulation' (intel-02.2, đang chạy thử) + 'legal_doc' — không còn luật của tính năng tắt
    expect(det(rows[0]).rules).toEqual(['regulation', 'legal_doc']);
    await stage('intel-02.3', 'chay_thu');
    s = await ia.scan(pool, now, { env: ENV });
    expect([s.off, s.alerts]).toEqual([0, 1]);
  });

  it('PC-A8: legal_doc → đúng 1 cảnh báo, leo thang 2 giờ; 2 luật → 1 cảnh báo', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const iid = await item('Văn bản mới về ghi nhãn thực phẩm chức năng', {
      topics: ['phap_ly', 'tpbvsk'],
      source: 'cuc-attp-van-ban',
    });
    await item('Văn bản mới về thuế', { topics: ['phap_ly'], source: 'cuc-attp-van-ban' });
    await item('Thực phẩm chức năng bán chạy', {
      topics: ['tpbvsk'],
      source: 'vnexpress-suc-khoe',
    });
    const now = await dbNow();
    const s = await ia.scan(pool, now, { env: ENV });
    expect([s.scanned, s.alerts]).toEqual([3, 1]);
    const rows = await q(
      'select id::int as id, source_agent, detail, route_error from red_alerts order by id',
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_agent).toBe('intel_red_alert');
    expect(rows[0]?.detail).toMatchObject({
      intel_item_id: iid,
      rules: ['legal_doc'],
      source: 'cuc-attp-van-ban',
    });
    expect(rows[0]?.route_error).toBe(MISSING);
    expect((await ia.scan(pool, now, { env: ENV })).alerts).toBe(0);
    const ts = await tsOf(rows[0]?.id as number);
    expect((await ia.escalate(pool, plus(ts, 1 + 59 / 60), { env: ENV })).escalated).toBe(0);
    expect((await ia.escalate(pool, plus(ts, 2 + 1 / 60), { env: ENV })).ids).toEqual([
      rows[0]?.id,
    ]);
    expect((await ia.escalate(pool, plus(ts, 5), { env: ENV })).escalated).toBe(0);
    await item('Dự thảo nghị định về quảng cáo thực phẩm bảo vệ sức khỏe', {
      topics: ['phap_ly', 'tpbvsk', 'quang_cao'],
      source: 'cuc-attp-van-ban',
    });
    const s2 = await ia.scan(pool, await dbNow(), { env: ENV });
    expect(s2.alerts).toBe(1);
    expect(det((await alerts()).at(-1)).rules).toEqual(['regulation', 'legal_doc']);
    // detail.fetched_at = ISO kiểu Python isoformat (có múi giờ)
    expect(String(det((await alerts()).at(-1)).fetched_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/,
    );
  });

  it('v14.6: leo thang intel chỉ lọc nguồn intel (gốc nguồn khác không bị đụng)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await raiseAlert(pool, 'agent:khac', 'đỏ khác', null, null, null, ENV);
    await item(RECALL);
    await ia.scan(pool, await dbNow(), { env: ENV });
    const aid = (await alerts())[0]?.id as number;
    const later = plus(await tsOf(aid), 3);
    expect((await ia.escalate(pool, later, { env: ENV })).ids).toEqual([aid]);
    expect((await ia.escalate(pool, later, { env: ENV })).escalated).toBe(0);
    expect((await ia.openAlerts(pool, later)).map((d) => d.escalated)).toEqual([true]);
    expect(await n('red_alerts', "source_agent = 'agent:khac' and detail ? 'escalation_of'")).toBe(
      0,
    );
  });

  // ------------------------------------------------------------ intel_bulletin

  const llmOn = (): string => {
    const cfg = JSON.parse(readFileSync(dataPath('intel_sources.json'), 'utf8')) as Obj;
    (cfg.llm as Obj).enabled = true;
    const p = join(tmp, `src-${randomUUID()}.json`);
    writeFileSync(p, JSON.stringify(cfg));
    return p;
  };
  type Sent = [string, { role: string; content: unknown }[], Obj];
  const bulletin = async (
    o: ib.BulletinOpts,
    x: {
      chat?: ib.ChatFn;
      sourcesFile?: string;
      clock?: Date;
      angles?: Record<string, string>;
    } = {},
  ) => {
    const s = io();
    const outDir = rep;
    const rc = await ib.intelBulletinMain(o, {
      io: s.io,
      env: ENV,
      connect: lease(),
      wire: () => {},
      chat:
        x.chat ??
        (async () => {
          throw new Error('không được gọi AI');
        }),
      clock: () => x.clock ?? NOW,
      outDir,
      sourcesFile: x.sourcesFile,
      angles: x.angles,
    });
    return { rc, ...s, outDir };
  };
  const report = (period = 'day', start = DAY) =>
    readFileSync(join(rep, `intel-bulletin-${period}-${start}.md`), 'utf8');
  const at = (hhmm = '08:00', day = DAY) => `${day}T${hhmm}:00+07:00`;

  it('AI tắt (llm.enabled false) → 0 lời gọi, bản tin tất định đủ mục', async () => {
    await item(T_SAM, { fetched: at() });
    const calls: unknown[] = [];
    const r = await bulletin(
      { period: 'day', date: DAY, llm: true },
      {
        chat: async (...a) => {
          calls.push(a);
          return { text: 'x' };
        },
      },
    );
    expect(r.rc).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out.join('\n')).toContain('[warn] LLM tắt');
    expect(r.out.join('\n')).toContain('llm_guardrail_fail=0');
    const md = report();
    ib.TOPICS.forEach((t, i) => {
      expect(md).toContain(`### ${i + 1}. ${ib.TOPIC_LABELS[t]}`);
    });
    for (const x of [
      T_SAM,
      ib.QUOTE_HEAD,
      '## Cảnh báo đỏ đang mở',
      '## Nguồn lỗi / robots chặn',
      'BẢN NHÁP',
    ]) {
      expect(md).toContain(x);
    }
    expect(md).not.toContain('Tóm tắt (AI');
  });

  it('AI bật: guardrail loại tóm tắt bẩn (kể cả entity &#99;hữa), input không link, ≤300 ký tự/tin', async () => {
    const LONG = `Trích dẫn dài xem https://bao.example.vn/xyz ${'chữ '.repeat(80)}`.slice(0, 300);
    await item(T_SAM, { fetched: at(), snippet: LONG });
    await item(T_TP, { fetched: at(), topics: ['tpbvsk'] });
    await item(T_QC, { fetched: at(), topics: ['quang_cao'] });
    const replies = [
      'Thị trường sâm sôi động dịp cuối năm.',
      'Sản phẩm này chữa mất ngủ hiệu quả.',
      'Tóm tắt: &#99;hữa bệnh nhanh.',
    ];
    const sent: Sent[] = [];
    const r = await bulletin(
      { period: 'day', date: DAY, llm: true },
      {
        sourcesFile: llmOn(),
        chat: async (agent, msgs, opts) => {
          sent.push([agent, msgs as Sent[1], opts as Obj]);
          return { text: replies.shift() };
        },
      },
    );
    expect(r.rc).toBe(0);
    const out = r.out.join('\n');
    expect(out).toContain('llm_guardrail_fail=2');
    expect(out).toContain('llm_summaries=1');
    const md = report();
    expect(md).toContain('Thị trường sâm sôi động dịp cuối năm.');
    expect(md).not.toContain('chữa');
    expect(md).not.toContain('&#99;');
    expect(md.split(ib.DROPPED).length - 1).toBe(2);
    expect(sent.map((x) => x[0])).toEqual(['intel', 'intel', 'intel']);
    for (const [, msgs, opts] of sent) {
      expect(opts.maxTokens).toBe(300);
      expect(opts.feature).toBe('intel-01.1');
      const body = String(msgs.at(-1)?.content);
      expect(body).not.toContain('http');
      expect(body).not.toContain('www.');
      const segs = body
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2));
      expect(segs.length).toBeGreaterThan(0);
      for (const sg of segs) expect([...sg].length).toBeLessThanOrEqual(ib.SEG_MAX);
    }
  });

  it('GatewayError → tắt AI phần còn lại, bản tin vẫn ra', async () => {
    await item(T_SAM, { fetched: at() });
    await item(T_TP, { fetched: at(), topics: ['tpbvsk'] });
    let k = 0;
    const r = await bulletin(
      { period: 'day', date: DAY, llm: true },
      {
        sourcesFile: llmOn(),
        chat: async () => {
          k++;
          throw new GatewayBlocked('cap');
        },
      },
    );
    expect(r.rc).toBe(0);
    expect(k).toBe(1);
    expect(r.out.join('\n')).toContain('LLM tắt phần còn lại');
    const md = report();
    expect(md).toContain(T_SAM);
    expect(md).toContain(T_TP);
    expect(md).not.toContain('Tóm tắt (AI');
  });

  it('kỳ tuần theo giờ VN (biên 00:00 thứ Hai)', async () => {
    await item('Tin sâm tuần trước', { fetched: '2026-10-11T23:30:00+07:00' });
    await item('Tin sâm tuần này', { fetched: '2026-10-12T00:10:00+07:00' });
    expect((await bulletin({ period: 'week', date: DAY })).rc).toBe(0);
    let md = report('week', '2026-10-12');
    expect(md).toContain('Tin sâm tuần này');
    expect(md).not.toContain('Tin sâm tuần trước');
    expect(md).toContain('12/10/2026–18/10/2026');
    expect((await bulletin({ period: 'week', date: '2026-10-11' })).rc).toBe(0);
    md = report('week', '2026-10-05');
    expect(md).toContain('Tin sâm tuần trước');
    expect(md).not.toContain('Tin sâm tuần này');
  });

  it('sức khỏe nguồn (job crawler.intel lỗi) + cảnh báo đỏ đang mở trong bản tin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = new Date(NOW.getTime() - 2 * 3600_000);
    await q(
      "insert into job_runs (job, started_at, finished_at, ok, detail) values ('crawler.intel', $1, $1, false, 'fail=fx-src robots_deny=1 blocked=0')",
      [t],
    );
    await item(RECALL, { fetched: at() });
    await ia.scan(pool, NOW, { env: ENV });
    const aid = Number(await one('select id from red_alerts'));
    expect((await bulletin({ period: 'day', date: DAY })).rc).toBe(0);
    const md = report();
    const sec = md.split('## Nguồn lỗi / robots chặn')[1] as string;
    for (const x of ['fx-src', 'lỗi 1', 'robots_deny=1']) expect(sec).toContain(x);
    const al = (md.split('## Cảnh báo đỏ đang mở')[1] as string).split('## Tin theo')[0] as string;
    expect(al).toContain(`#${aid}`);
    expect(al).toContain('CHƯA AI NHẬN');
  });

  const topicRows = () =>
    q(
      "select id::int as id, block, status, risk, guardrail->>'ok' as g_ok, payload, title, created_by from approval_queue where object_type = 'intel_topic' order by id",
    );

  it('--suggest → hàng duyệt chung (medium, không tự duyệt), không trích tin/link/SKU, không trùng', async () => {
    const titles = [
      'Giá sâm Ngọc Linh tăng mạnh',
      'Sâm Hàn Quốc giảm giá',
      'TPBVSK tăng trưởng',
      'Thực phẩm chức năng nhập khẩu',
      'Giới trẻ chuộng trà sữa',
    ];
    const tps = ['sam', 'sam', 'tpbvsk', 'tpbvsk', 'gioi_tre'];
    for (const [i, t] of titles.entries())
      await item(t, { fetched: at(), topics: [tps[i] as string] });
    expect((await bulletin({ period: 'day', date: DAY, suggest: true })).rc).toBe(0);
    const rows = await topicRows();
    expect(rows.length).toBe(2);
    const golden = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8')) as {
      skus: Obj[];
    };
    const terms = golden.skus
      .flatMap((s) => [String(s.name), String(s.sku_key)])
      .map((x) => x.toLowerCase());
    for (const r of rows) {
      expect([r.block, r.status, r.risk, r.g_ok]).toEqual(['intel', 'pending', 'medium', 'true']);
      expect(r.created_by).toBe('agent:intel_bulletin');
      const low = String(r.payload).toLowerCase();
      expect(low).not.toContain('http');
      for (const t of titles) expect(low).not.toContain(t.toLowerCase());
      for (const g of terms) expect(low).not.toContain(g);
    }
    const md = report();
    for (const r of rows) expect(md).toContain(`#${r.id} \`intel_topic\``);
    expect(md.split('chờ Quản lý MXH duyệt').length - 1).toBeGreaterThanOrEqual(2);
    expect((await bulletin({ period: 'day', date: DAY, suggest: true })).rc).toBe(0);
    expect((await topicRows()).length).toBe(2);
    const [ok, msg] = await autoApprove(pool, rows[0]?.id);
    expect(ok).toBe(false);
    expect(msg).toBeTruthy();
    expect(await one('select status from approval_queue where id = $1', [rows[0]?.id])).toBe(
      'pending',
    );
    const due = (await one(
      "select min(due_at) from approval_queue where object_type = 'intel_topic'",
    )) as Date;
    const [, text] = await directorRun(pool, 'intel', {
      now: plus(due, -1),
      outDir: join(tmp, 'dir'),
    });
    expect(text.split('`intel_topic`').length - 1).toBe(2);
    expect(text).toContain('Vai trò duyệt: mxh');
    expect(text).toContain('| Đang chờ duyệt (tồn) | 2 |');
    expect(new Set((await topicRows()).map((r) => r.status))).toEqual(new Set(['pending']));
  });

  it('gợi ý vi phạm guardrail → bỏ, không vào hàng', async () => {
    for (const t of ['Giá sâm tăng', 'Sâm Hàn Quốc giảm giá']) await item(t, { fetched: at() });
    const angles = Object.fromEntries(ib.TOPICS.map((t) => [t, 'sản phẩm chữa bệnh']));
    const r = await bulletin({ period: 'day', date: DAY, suggest: true }, { angles });
    expect(r.rc).toBe(0);
    expect(await topicRows()).toEqual([]);
    expect(r.out.join('\n')).toContain('vi phạm guardrail');
  });

  it('không ghi được file bản tin (OSError) → exit 1, không traceback', async () => {
    await item(T_SAM, { fetched: at() });
    writeFileSync(rep, 'không phải thư mục');
    const r = await bulletin({ period: 'day', date: DAY });
    expect(r.rc).toBe(1);
    expect(r.out.at(-1)).toMatch(
      /^\[err\] không ghi được bản tin \((FileExistsError|NotADirectoryError|OSError)\)$/,
    );
  });

  it('cấu hình khối intel (người duyệt mxh, risk medium, SLA 48 giờ)', () => {
    const cfg = loadConfig('intel');
    expect(cfg.approver_roles).toEqual(['mxh']);
    expect(cfg.approvers).toEqual([]);
    expect(cfg.digest_recipients).toEqual([]);
    expect(cfg.object_types.intel_topic).toEqual({ sla_hours: 48, risk: 'medium' });
  });

  it('cách ly toàn luồng: chỉ red_alerts + 1 gợi ý intel_topic; 0 content_drafts/intel_items mới', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = await dbNow();
    await item(RECALL, { fetched: now });
    await item('Giá sâm Ngọc Linh tăng', { fetched: now });
    await item(T_TP, { fetched: now, topics: ['tpbvsk'] });
    const before = {
      cd: await n('content_drafts'),
      ii: await n('intel_items'),
      aq: await n('approval_queue'),
    };
    const seen: JobRec[] = [];
    expect(
      await ia.intelAlertMain(
        { run: true },
        { io: io().io, env: ENV, connect: lease(), wire: () => {}, job: fakeJob(seen) },
      ),
    ).toBe(1);
    const r = await bulletin(
      { period: 'day', llm: true, suggest: true },
      {
        sourcesFile: llmOn(),
        clock: now,
        chat: async () => ({ text: 'Thị trường sâm sôi động.' }),
      },
    );
    expect(r.rc).toBe(0);
    expect(await n('content_drafts')).toBe(before.cd);
    expect(await n('intel_items')).toBe(before.ii);
    expect(await n('approval_queue')).toBe(before.aq + 1);
    expect(await n('approval_queue', "object_type <> 'intel_topic'")).toBe(0);
    expect(await n('red_alerts')).toBe(1);
  });

  it('PC-A8: văn bản pháp luật — 0 tóm tắt AI, 0 gợi ý, mỗi dòng có ngày ISO + link', async () => {
    for (const t of [
      'Nghị định mới về thực phẩm chức năng',
      'Dự thảo thông tư quảng cáo thực phẩm',
      'Văn bản hợp nhất luật an toàn thực phẩm',
    ]) {
      await item(t, { fetched: at(), topics: ['phap_ly'], source: 'chinhphu-van-ban' });
    }
    const sent: unknown[] = [];
    const r = await bulletin(
      { period: 'day', date: DAY, llm: true, suggest: true },
      {
        sourcesFile: llmOn(),
        chat: async (...a) => {
          sent.push(a);
          return { text: 'tóm tắt' };
        },
      },
    );
    expect(r.rc).toBe(0);
    expect(await topicRows()).toEqual([]);
    expect(sent).toEqual([]);
    const sec = (report().split('Văn bản pháp luật — 3 tin')[1] as string).split(
      '## ',
    )[0] as string;
    const lines = sec.split('\n').filter((l) => l.startsWith('> - '));
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l).toMatch(/^> - .+ · \d{4}-\d{2}-\d{2}(?: \(ngày thu\))? · <https?:\/\/\S+>$/);
    }
    expect(sec).not.toContain('Tóm tắt (AI');
  });

  it('r12: bản tin TẮT nhưng gợi ý bật → gợi ý vẫn vào hàng, không ghi file, exit 2 (và ngược lại)', async () => {
    settings.forceMode = null;
    for (const t of ['Giá sâm tăng', 'Sâm Hàn Quốc giảm giá']) await item(t, { fetched: at() });
    await stage('intel-01.1', 'tat');
    await stage('intel-01.2', 'chay_thu');
    let r = await bulletin(
      { period: 'day', date: DAY, suggest: true, llm: true },
      { sourcesFile: llmOn() },
    );
    expect(r.rc).toBe(2);
    expect(r.out.at(-2)).toBe('[done] gợi ý chủ đề: suggested_new=1 suggested_total=1');
    expect(r.out.at(-1)).toMatch(/^\[rollout\] .*intel-01\.1/);
    expect(() => report()).toThrow();
    expect((await topicRows()).length).toBe(1);
    await stage('intel-01.1', 'chay_thu');
    await stage('intel-01.2', 'tat');
    // hàng duyệt append-only (không xóa) — gợi ý cũ giữ nguyên, lượt này KHÔNG đẩy thêm
    r = await bulletin({ period: 'day', date: DAY, suggest: true });
    expect(r.rc).toBe(2);
    expect(r.out.at(-1)).toMatch(/^\[rollout\] .*intel-01\.2/);
    // chạy thử → nhãn CHẠY THỬ trong nội dung, sổ report_outputs (sample=false)
    expect(report()).toContain('CHẠY THỬ — KHÔNG GỬI');
    expect(await n('report_outputs', "name = 'intel-bulletin-day-2026-10-12.md'")).toBeGreaterThan(
      0,
    );
    expect((await topicRows()).length).toBe(1);
    expect(r.out.join('\n')).toContain('suggested_new=0 suggested_total=0');
    expect(await n('report_outputs', 'is_sample')).toBe(0);
  });

  // ------------------------------------------------------------ legal_updates

  const legalItem = (
    title: string,
    o: { source?: string; topics?: string[]; daysAgo?: number } = {},
  ) =>
    item(title, {
      source: o.source ?? 'cuc-attp-van-ban',
      topics: o.topics ?? ['phap_ly', 'tpbvsk'],
      daysAgo: o.daysAgo ?? 0,
    });

  it('legal_hr-07 thuộc danh mục: approval_queue/legal_hr/legal_doc_review', () => {
    expect(
      featureFor({
        table: 'approval_queue',
        block: 'legal_hr',
        object_type: 'legal_doc_review',
        created_by: lu.CREATED_BY,
      }),
    ).toBe('legal_hr-07');
  });

  it('văn bản khớp legal_doc → 1 mục/tin, payload không diễn giải, người duyệt được, không đẩy lại', async () => {
    const hit = await legalItem('Nghị định quy định về thuốc và thực phẩm bảo vệ sức khỏe');
    await legalItem('Thông tư về lao động tiền lương', { topics: ['phap_ly'] });
    await legalItem('Tin tpbvsk từ báo', { source: 'vnexpress-suc-khoe' });
    await legalItem('Nghị định cũ về quảng cáo thực phẩm', {
      daysAgo: 40,
      topics: ['phap_ly', 'quang_cao'],
    });
    const st = await lu.submit(pool, await dbNow());
    expect([st.found, st.queued.length, st.left]).toEqual([1, 1, 0]);
    const row = (
      await q(
        "select block, object_type, object_id, title, payload, created_by, guardrail->>'ok' as g_ok, risk from approval_queue where id = $1",
        [st.queued[0]],
      )
    )[0] as Obj;
    expect([row.block, row.object_type, row.object_id]).toEqual([
      'legal_hr',
      'legal_doc_review',
      `intel:${hit}`,
    ]);
    expect(String(row.title)).toContain('thuốc');
    expect(String(row.payload)).not.toContain('thuốc');
    expect([row.created_by, row.g_ok, row.risk]).toEqual(['agent:legal_updates', 'true', 'medium']);
    expect(String(row.payload)).toContain('KHÔNG diễn giải');
    expect(String(row.payload)).toContain('bao.example.vn');
    const [okAgent] = await decide(pool, st.queued[0], 'agent:legal_updates', 'approved');
    expect(okAgent).toBe(false);
    const [ok, msg] = await decide(pool, st.queued[0], 'Chuyên viên pháp chế', 'approved');
    expect(ok, String(msg)).toBe(true);
    const st2 = await lu.submit(pool, await dbNow());
    expect([st2.found, st2.queued]).toEqual([0, []]);
  });

  it('--dry-run không ghi; TẮT → RolloutBlocked; trần --limit, dư → lần sau; CLI in tóm tắt', async () => {
    for (let i = 0; i < 3; i++) {
      await legalItem(`Dự thảo nghị định quảng cáo thực phẩm số ${i}`, {
        topics: ['phap_ly', 'quang_cao'],
      });
    }
    expect(await lu.submit(pool, await dbNow(), { dryRun: true })).toEqual({
      found: 3,
      queued: [],
      left: 0,
    });
    expect(await n('approval_queue')).toBe(0);
    settings.forceMode = 'tat';
    await expect(lu.submit(pool, await dbNow())).rejects.toBeInstanceOf(RolloutBlocked);
    settings.forceMode = 'van_hanh';
    const st = await lu.submit(pool, await dbNow(), { limit: 2 });
    expect([st.queued.length, st.left]).toEqual([2, 1]);
    const s = io();
    expect(
      await lu.legalUpdatesMain(
        { submit: true },
        { io: s.io, env: ENV, connect: lease(), wire: () => {} },
      ),
    ).toBe(0);
    const id3 = Number(
      await one("select max(id) from approval_queue where object_type = 'legal_doc_review'"),
    );
    expect(s.out).toEqual([
      `[ok] văn bản khớp chưa vào hàng: 1 · đã đẩy: 1 [${id3}] · còn lại lần sau: 0`,
    ]);
    const s2 = io();
    expect(
      await lu.legalUpdatesMain(
        { submit: true, dryRun: true },
        { io: s2.io, env: ENV, connect: lease(), wire: () => {} },
      ),
    ).toBe(0);
    expect(s2.out).toEqual([
      '[ok] (dry-run) văn bản khớp chưa vào hàng: 0 · đã đẩy: 0 [] · còn lại lần sau: 0',
    ]);
  });

  // ------------------------------------------------------------ persona_sim

  const CFG = ps.readJsonDoc(ps.CONFIG_FILE)[0] as Obj;
  const PERS = ps.readJsonDoc(ps.PERSONAS_FILE)[0] as Obj;
  const matrix = (runId: string) =>
    ps.runMatrix(CFG, PERS, CFG.options as Obj[], ps.fakeChat(CFG.options as Obj[]), '2026-10-12', {
      runId,
      dryRun: true,
    });

  it('sim_runs: 180 dòng đủ cột truy vết, 45 lời gọi, 1 đối chứng/lời gọi, trùng → unique', async () => {
    const [rows, nCalls] = await matrix('t-db-1');
    expect(await ps.writeRows(pool, rows)).toBe(180);
    expect(await n('sim_runs', "run_id = 't-db-1'")).toBe(180);
    expect(
      await n(
        'sim_runs',
        'model_version is null or provider is null or prompt_hash is null or seed is null or persona_set_hash is null',
      ),
    ).toBe(0);
    expect(
      Number(await one('select count(distinct (model, prompt_id, sample_idx)) from sim_runs')),
    ).toBe(nCalls);
    expect(nCalls).toBe(45);
    expect(await n('sim_runs', 'is_control')).toBe(45);
    await expect(ps.writeRows(pool, rows.slice(0, 1))).rejects.toMatchObject({ code: '23505' });
    expect(await n('sim_runs')).toBe(180);
  });

  it('sim_runs: điểm ngoài 0..10 → CHECK; intel-05.1 TẮT → RolloutBlocked, 0 dòng', async () => {
    const [rows] = await matrix('t-db-2');
    await expect(
      ps.writeRows(pool, [{ ...(rows[0] as ps.SimRow), score: 11 }]),
    ).rejects.toMatchObject({
      code: '23514',
    });
    settings.forceMode = null;
    await stage('intel-05.1', 'tat');
    await expect(ps.writeRows(pool, [])).rejects.toBeInstanceOf(RolloutBlocked);
    await expect(ps.writeRows(pool, rows)).rejects.toBeInstanceOf(RolloutBlocked);
    expect(await n('sim_runs')).toBe(0);
    const s = io();
    expect(
      await ps.personaSimMain({ dryRun: true }, { io: s.io, env: ENV, connect: lease() }),
    ).toBe(2);
    expect(s.err[0]).toMatch(/^\[blocked\] .*intel-05\.1/);
  });

  it('CLI --dry-run ghi 180 dòng thật (dry_run=true) rồi mới in báo cáo', async () => {
    const s = io();
    expect(
      await ps.personaSimMain({ dryRun: true }, { io: s.io, env: ENV, connect: lease() }),
    ).toBe(0);
    expect(await n('sim_runs')).toBe(180);
    expect(await n('sim_runs', 'not dry_run')).toBe(0);
    expect(s.out.at(-1)).toMatch(/^\[ok\] 180 dòng sim_runs \(45 lời gọi\) run_id=dry-/);
  });
});
