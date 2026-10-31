import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import * as aq from '@samsam/core/ops/approval-queue';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { run as directorRun, submit } from '@samsam/core/ops/director';
import { businessDeadline } from '@samsam/core/ops/period';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { withTx } from '@samsam/core/ops/tx';
import { opsRollout } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { adminQuery, createDbFromTemplate, dbUrl, dropDb } from '@samsam/core/testing/db';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentStock } from './kd-forecast.deps.js';
import { gather, renderBulletin } from './sales-director.bulletin.js';
import { salesDirectorMain } from './sales-director.command.js';
import {
  AGENT,
  collect,
  collectAll,
  cskhObjectId,
  enqueueNew,
  leadItems,
  loadSalesConfig,
  plan,
  run,
  type SalesConfig,
  SWEEP_BY,
  slaState,
  staleLeads,
  sweep,
  unanswered,
} from './sales-director.service.js';

// Dịch phần DB của tests/test_sales_director.py + lead_followup của tests/test_v14_p4_sales.py +
// P8.6 của tests/test_v15_p8_outputs.py. DB riêng `samsam_ts_sales_director` từ mẫu (KHÔNG BAO GIỜ
// `samsam`), xóa khi xong; mỗi test làm sạch bảng (truncate dưới replica). Quyền: client
// `set role agent_writer` / `app_human` như `set local role` của Python; lệnh CLI chạy bằng login
// tạm `in role svc_job` (login thật của job `sales_sla`). Người/tên trong test là giả lập.

const NAME = 'Nguyễn Văn An';
const PHONE = '0912345678';
const EMAIL = 'an@example.com';
const UHASH = 'uh_5f2c9a7e1b';
const PII = [NAME, PHONE, EMAIL, UHASH];
/** Giờ VN tháng 10/2026 (12 = thứ Hai). */
const t = (d: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, d, hh - 7, mm));
const H = 3_600_000;
const TABLES = [
  'approval_queue',
  'sla_escalations',
  'red_alerts',
  'agent_action_log',
  'decisions',
  'job_runs',
];
const RESET = [
  ...TABLES,
  'red_alert_deliveries',
  'red_alert_acks',
  'approvals',
  'market_alerts',
  'golden_discrepancies',
  'leads',
  'auto_policies',
  'inventory_snapshots',
  'feature_rollout',
];

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('sales_director (DB)', () => {
  const name = 'samsam_ts_sales_director';
  const login = `t_sd_job_${process.pid}`;
  let admin: Pool;
  let job: Pool;
  let jobUrl: string;
  let aw: PoolClient; // set role agent_writer
  let ah: PoolClient; // set role app_human
  let CFG: SalesConfig;

  beforeAll(async () => {
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
    const url = await createDbFromTemplate(name);
    admin = createPool(url, { max: 6 });
    aw = await admin.connect();
    await aw.query('set role agent_writer');
    ah = await admin.connect();
    await ah.query('set role app_human');
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`create role ${login} login password '${pw}' in role svc_job`);
    const u = new URL(dbUrl(name));
    u.username = login;
    u.password = pw;
    jobUrl = u.toString();
    job = createPool(jobUrl, { max: 2 });
    CFG = loadSalesConfig();
  });

  afterAll(async () => {
    resetOpsDeps();
    aw?.release();
    ah?.release();
    await job?.end();
    await admin?.end();
    await dropDb(name);
    await adminQuery(`drop role if exists ${login}`);
  });

  beforeEach(async () => {
    // guardrail THẬT ở biên enqueue; rollout/auth giả (dev, vận hành).
    installFakeDeps({ guardrailCheck: (x) => check(x) });
    await withTx(admin, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(`truncate ${RESET.join(', ')} restart identity cascade`);
    });
  });

  const val = async (sql: string, p?: unknown[]) => {
    const r = (await admin.query(sql, p)).rows[0];
    return r ? Object.values(r)[0] : undefined;
  };
  const count = async (table: string, where = 'true', p?: unknown[]) =>
    Number(await val(`select count(*) from ${table} where ${where}`, p));
  const replica = (sql: string, p?: unknown[]) =>
    withTx(admin, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(sql, p);
    });
  const verify = async () =>
    (await admin.query('select id, problem from verify_action_log()')).rows;
  const snapshot = async () =>
    Object.fromEntries(await Promise.all(TABLES.map(async (x) => [x, await count(x)])));

  const alert = async (
    kind: string,
    sev: string,
    status = 'open',
    sku = 'sam-hop-qua',
    item = 'it-1',
  ) =>
    Number(
      await val(
        "insert into market_alerts (kind, severity, channel, export_kind, item_id, seller_sku, sku_key, detail, status) values ($1, $2, 'shopee', 'product_list', $3, $4, $5, $6, $7) returning id",
        [
          kind,
          sev,
          item,
          `seller-${item}`,
          sku,
          JSON.stringify({ title: `${NAME} ${PHONE}` }),
          status,
        ],
      ),
    );
  const gd = async (kind: string, sku: string, status = 'pending') =>
    Number(
      await val(
        "insert into golden_discrepancies (kind, sku_key, detail, status, source) values ($1, $2, '{\"web\": 1}', $3, 'golden_store') returning id",
        [kind, sku, status],
      ),
    );
  const lead = async (key: string, ts: Date, question = 'giá hộp quà', status = 'new') =>
    Number(
      await val(
        "insert into leads (dedup_key, ts, channel, user_hash, question, intent, status, source) values ($1, $2, 'zalo', $3, $4, 'price', $5, 'conversations.jsonl') returning id",
        [key, ts, UHASH, question, status],
      ),
    );
  /** Như `crm.assign_owner`: hạn = gán + handle_within giờ làm việc (ghi thẳng dưới replica). */
  const assign = async (lid: number, staff: string, at: Date) => {
    const due = businessDeadline(at, 8, CFG.business_hours);
    await replica(
      "update leads set owner_code = $1, owner_due_at = $2, owner_assigned_by = 'Lan', owner_assigned_at = $3 where id = $4",
      [staff, due, at, lid],
    );
  };
  const convlog = (recs: object[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'sd-db-'));
    const lines = recs.map((r) => JSON.stringify(r));
    lines.splice(2, 0, '{corrupt json');
    writeFileSync(join(dir, 'conversations.jsonl'), `${lines.join('\n')}\n`);
    return dir;
  };
  const conv = (ts: string, answered: boolean, q: string, msgId: string, uh = UHASH) => ({
    ts,
    msg_id: msgId,
    user_hash: uh,
    question: q,
    answer: '',
    answered,
    provenance: 'live',
  });
  const convU = (ts: string, uh: string, msgId: string, q = '[non-text:sticker]') =>
    conv(ts, false, q, msgId, uh);
  /** Mục qua director.submit (agent_writer) rồi đặt created_at/due_at; due null → now()+100h. */
  const item = async (
    ot: string,
    oid: string,
    created: Date,
    due: Date | null = null,
    title = 'mục test',
  ) => {
    const qid = Number(
      await submit(aw, {
        block: 'sales',
        objectType: ot,
        objectId: oid,
        title,
        payload: 'Việc kiểm thử hàng duyệt khối kinh doanh',
        createdBy: AGENT,
        cfg: CFG,
      }),
    );
    if (due === null) {
      await replica(
        "update approval_queue set created_at = $1, due_at = now() + interval '100 hours' where id = $2",
        [created, qid],
      );
    } else {
      await replica('update approval_queue set created_at = $1, due_at = $2 where id = $3', [
        created,
        due,
        qid,
      ]);
    }
    return qid;
  };
  const decide = async (qid: number, dec: 'approved' | 'rejected', by = 'Hoa (test)') =>
    aq.decide(ah, qid, by, dec);
  const nodir = join(tmpdir(), 'khong-co-convlog-sd');

  // ---------------------------------------------------------------- W50.3 schema

  it('sla_escalations: insert idempotent, append-only, quyền cột', async () => {
    const qid = await item('price_review', 'gd:1', t(12, 8));
    const ins =
      "insert into sla_escalations (queue_id, block, handoff_class, assignee_role, escalate_to_role, business_due_at, red_alert, created_by) values ($1, 'sales', 'B', 'gd_ban_hang', 'tgd', $2, false, 'agent:sales_director') on conflict (queue_id) do nothing returning id";
    expect((await aw.query(ins, [qid, t(12, 12)])).rows).toHaveLength(1);
    expect((await aw.query(ins, [qid, t(12, 12)])).rows).toHaveLength(0);
    expect(await count('sla_escalations')).toBe(1);
    for (const sql of [
      'update sla_escalations set red_alert = true',
      'delete from sla_escalations',
      'truncate sla_escalations',
    ]) {
      await expect(admin.query(sql), sql).rejects.toMatchObject({ code: 'P0001' });
    }
    for (const sql of [
      'select detail from market_alerts',
      'select sku_key from market_alerts',
      'select user_hash from leads',
      'select detail from golden_discrepancies',
      'select payload from approval_queue',
      'select title from red_alerts',
      'select red_alert from sla_escalations',
      'update sla_escalations set red_alert = true',
    ]) {
      await expect(aw.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect((await ah.query('select red_alert from sla_escalations')).rows).toEqual([
      { red_alert: false },
    ]);
    await expect(admin.query(ins.replace("'B'", "'C'"), [qid, t(12, 12)])).rejects.toMatchObject({
      code: '23514',
    });
  });

  // ---------------------------------------------------------------- W50.4 nguồn

  it('collect + enqueue: 4 nguồn thật, idempotent, payload template (guardrail ok, không PII)', async () => {
    const ids = {
      s1: await alert('alcohol_listed', 'S1', 'open', 'ruou-sam-45', 'r1'),
      s2: await alert('price_mismatch', 'S2', 'open', 'sam-hop-qua', 'p1'),
      closed: await alert('item_unmapped', 'S2', 'closed', 'sam-hop-qua', 'c1'),
      gd: await gd('price_mismatch', 'sam-tuoi-1'),
      spec: await gd('spec_mismatch', 'sam-tuoi-2'),
      resolved: await gd('price_mismatch', 'sam-tuoi-3', 'resolved'),
    };
    const data = convlog([
      conv('2026-10-13T01:00:00Z', false, `Tôi là ${NAME}, gọi ${PHONE} hoặc ${EMAIL} nhé`, 'm-in'),
      conv('2026-10-09T00:00:00Z', false, 'câu cũ ngoài cửa sổ', 'm-old'),
      conv('2026-10-13T02:00:00Z', true, 'câu đã trả lời', 'm-ok'),
    ]);
    const now = t(13, 12);
    const srcStatus = async () =>
      Promise.all(
        ['market_alerts', 'golden_discrepancies', 'leads'].map(
          async (x) => (await admin.query(`select id, status from ${x} order by id`)).rows,
        ),
      );
    const before = await srcStatus();
    const items = await collect(aw, now, CFG, data);
    expect(items.map((i) => i.object_type).sort()).toEqual([
      'cskh_handoff',
      'market_alert_s1',
      'market_alert_s2',
      'price_review',
    ]);
    expect(await enqueueNew(aw, items, CFG)).toBe(4);
    expect(await collect(aw, now, CFG, data)).toEqual([]); // chạy lại → 0
    expect(await enqueueNew(aw, await collect(aw, now, CFG, data), CFG)).toBe(0);
    const rows = (
      await admin.query(
        'select id, object_type, object_id, risk, title, payload, extract(epoch from due_at - created_at)::int as gap, status, created_by from approval_queue order by id',
      )
    ).rows;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const spec = CFG.object_types[r.object_type];
      expect([r.risk, r.gap, r.status, r.created_by]).toEqual([
        spec?.risk,
        (spec?.sla_hours ?? 0) * 3600,
        'pending',
        AGENT,
      ]);
      expect(check(r.payload).ok, r.payload).toBe(true);
      for (const s of [...PII, 'ruou', 'rượu', 'alcohol', 'sam-', 'seller-', 'r1', 'Tôi là']) {
        expect(r.payload, `${r.object_type} ${s}`).not.toContain(s);
        expect(r.title, `${r.object_type} ${s}`).not.toContain(s);
      }
    }
    const got = Object.fromEntries(rows.map((r) => [r.object_type, [r.object_id, r.risk]]));
    expect(got.market_alert_s1[0]).toMatch(new RegExp(`^ma:${ids.s1}:\\d{8}T\\d{12}Z$`));
    expect(got.market_alert_s1[1]).toBe('high');
    // khóa đợt = micro giây của opened_at (như Python %f) — không mất độ chính xác qua Date
    const us = await val(
      "select to_char(opened_at at time zone 'UTC', 'US') from market_alerts where id = $1",
      [ids.s1],
    );
    expect(got.market_alert_s1[0].slice(-7, -1)).toBe(us);
    expect(got.market_alert_s2[0]).toMatch(new RegExp(`^ma:${ids.s2}:`));
    expect(got.market_alert_s2[1]).toBe('medium');
    expect(got.price_review).toEqual([`gd:${ids.gd}`, 'high']);
    expect(got.cskh_handoff).toEqual([
      cskhObjectId({ user_hash: UHASH }, new Date('2026-10-13T01:00:00Z')),
      'medium',
    ]);
    // mục đã từ chối không bị đẩy lại
    const s2 = rows.find((r) => r.object_type === 'market_alert_s2')?.id;
    expect(await decide(s2, 'rejected')).toEqual([true, null]);
    expect(await collect(aw, now, CFG, data)).toEqual([]);
    expect(await srcStatus()).toEqual(before); // nguồn không đổi
    expect(await verify()).toEqual([]);
  });

  for (const outcome of ['rejected', 'expired'] as const) {
    it(`market_alert mở lại CÙNG dòng = đợt mới (${outcome})`, async () => {
      const aid = await alert('alcohol_listed', 'S1', 'open', 'sam-hop-qua', 'rr');
      const first = await collect(aw, t(13, 9), CFG, nodir);
      expect(first.map((i) => i.object_type)).toEqual(['market_alert_s1']);
      await enqueueNew(aw, first, CFG);
      const qid = Number(
        await val('select id from approval_queue where object_id = $1', [first[0]?.object_id]),
      );
      if (outcome === 'rejected') expect((await decide(qid, 'rejected'))[0]).toBe(true);
      else {
        await replica('update approval_queue set due_at = $1 where id = $2', [t(1, 9), qid]);
        expect(await aq.expireOverdue(aw)).toBe(1);
      }
      expect(await collect(aw, t(13, 10), CFG, nodir)).toEqual([]); // cùng đợt
      await admin.query(
        "update market_alerts set status = 'closed', closed_at = now() where id = $1",
        [aid],
      );
      expect(await collect(aw, t(14, 9), CFG, nodir)).toEqual([]); // đang đóng
      await admin.query(
        "update market_alerts set status = 'open', closed_at = null, opened_at = opened_at + interval '1 day' where id = $1",
        [aid],
      );
      const again = await collect(aw, t(14, 10), CFG, nodir);
      expect(again.map((i) => i.object_type)).toEqual(['market_alert_s1']);
      expect(again[0]?.object_id).not.toBe(first[0]?.object_id);
      expect(again[0]?.object_id.startsWith(`ma:${aid}:`)).toBe(true);
      expect(await enqueueNew(aw, again, CFG)).toBe(1);
      expect(await collect(aw, t(14, 10), CFG, nodir)).toEqual([]);
      expect(
        (
          await admin.query('select risk, status from approval_queue where object_id = $1', [
            again[0]?.object_id,
          ])
        ).rows[0],
      ).toEqual({ risk: 'high', status: 'pending' });
    });
  }

  it('CSKH tràn: gom 1 nhóm/khách/ngày VN + trần mỗi lần chạy (phần vượt chờ lần sau)', async () => {
    const cap = CFG.sources.max_cskh_per_run;
    const recs: object[] = [];
    for (let h = 1; h < 4; h++)
      for (let m = 0; m < 20; m++)
        recs.push(
          convU(
            `2026-10-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`,
            'uh_spam',
            `s-${h}-${m}`,
          ),
        );
    recs.push(convU('2026-10-12T17:30:00Z', 'uh_spam', 's-next-1'));
    recs.push(convU('2026-10-12T18:00:00Z', 'uh_spam', 's-next-2'));
    for (let i = 0; i < cap + 5; i++)
      recs.push(convU('2026-10-12T05:00:00Z', `uh_${i}`, `u-${i}`, `hỏi giá ${i}`));
    const data = convlog(recs);
    const now = t(13, 12);
    const groups = unanswered(now, CFG, data);
    const spamIds = new Set([
      cskhObjectId({ user_hash: 'uh_spam' }, new Date('2026-10-12T01:00:00Z')),
      cskhObjectId({ user_hash: 'uh_spam' }, new Date('2026-10-12T18:00:00Z')),
    ]);
    expect(
      groups
        .filter((g) => spamIds.has(g.object_id))
        .map((g) => g.n)
        .sort((a, b) => a - b),
    ).toEqual([2, 60]);
    expect(groups).toHaveLength(cap + 5 + 2);
    const [items, deferred] = await collectAll(aw, now, CFG, data);
    expect([items.length, deferred]).toEqual([cap, 7]);
    expect(await enqueueNew(aw, items, CFG)).toBe(cap);
    const [items2, deferred2] = await collectAll(aw, now, CFG, data);
    expect([items2.length, deferred2]).toEqual([7, 0]);
    const p = await plan(aw, now, CFG, data);
    expect([p.cskh_deferred, p.enqueue]).toEqual([0, { cskh_handoff: 7 }]);
    expect(await count('approval_queue', "object_type = 'cskh_handoff'")).toBe(cap);
  });

  it('sweep: cskh gom 1 cảnh báo đỏ/loại, S1 1 cảnh báo/mục, idempotent', async () => {
    const cskh: number[] = [];
    for (let i = 0; i < 50; i++)
      cskh.push(await item('cskh_handoff', `cskh:${String(i).padStart(4, '0')}`, t(12, 8)));
    const s1 = [
      await item('market_alert_s1', 'ma:1:x', t(12, 8)),
      await item('market_alert_s1', 'ma:2:x', t(12, 8)),
    ];
    const p = await plan(aw, t(12, 10), CFG, nodir);
    expect([p.escalate, p.red_alerts]).toEqual([52, 3]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let r = await sweep(aw, t(12, 10), CFG);
    expect([r.escalated, r.red_alerts, r.errors]).toEqual([52, 3, 0]);
    r = await sweep(aw, t(12, 10), CFG);
    expect([r.escalated, r.red_alerts]).toEqual([0, 0]);
    err.mockRestore();
    expect(await count('sla_escalations')).toBe(52);
    const rows = (await admin.query('select title, detail from red_alerts order by id')).rows;
    expect(rows).toHaveLength(3);
    const agg = rows.filter((x) => 'queue_ids' in x.detail);
    expect(agg).toHaveLength(1);
    expect(agg[0].detail).toMatchObject({ n: 50, queue_ids: cskh, object_type: 'cskh_handoff' });
    expect(
      rows
        .filter((x) => 'queue_id' in x.detail)
        .map((x) => x.detail.queue_id)
        .sort(),
    ).toEqual(s1);
    expect(await verify()).toEqual([]);
  });

  it('lead quá N giờ làm việc → nhắc (kể cả ts cực cũ nhập tay)', async () => {
    const now = t(13, 12); // T3 12:00
    const old = await lead('k9', t(12, 13)); // 9 giờ làm việc
    const young = await lead('k7', t(12, 15), 'giá lẻ'); // 7 giờ làm việc
    await lead('kd', t(1, 9), 'đã liên hệ', 'contacted');
    const ancient = await lead('ka', new Date('0001-01-02T00:00:00Z'), 'giá');
    const got = await staleLeads(aw, now, CFG);
    expect(got).toContain(old);
    expect(got).toContain(ancient);
    expect(got).not.toContain(young);
    expect(got).toHaveLength(2);
  });

  // ---------------------------------------------------------------- W50.5 SLA

  it('lớp A quá SLA → leo thang + cảnh báo đỏ đúng 1 lần, mục vẫn pending', async () => {
    const qid = await item('market_alert_s1', 'ma:900', t(12, 8));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let r = await sweep(aw, t(12, 9, 59), CFG);
    expect([r.escalated, await count('sla_escalations')]).toEqual([0, 0]);
    r = await sweep(aw, t(12, 10), CFG);
    expect([r.escalated, r.red_alerts, r.errors]).toEqual([1, 1, 0]);
    r = await sweep(aw, t(12, 10), CFG);
    expect([r.escalated, r.red_alerts]).toEqual([0, 0]);
    err.mockRestore();
    const esc = (
      await admin.query(
        'select queue_id, handoff_class, assignee_role, escalate_to_role, business_due_at, red_alert, created_by from sla_escalations',
      )
    ).rows;
    expect(esc).toEqual([
      {
        queue_id: String(qid),
        handoff_class: 'A',
        assignee_role: 'mxh',
        escalate_to_role: 'gd_ban_hang',
        business_due_at: t(12, 10),
        red_alert: true,
        created_by: AGENT,
      },
    ]);
    const alerts = (
      await admin.query(
        'select source_agent, title, detail, recipients, route_error from red_alerts',
      )
    ).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source_agent).toBe('agents.sales_director');
    expect(alerts[0].title).toContain(`#${qid}`);
    expect(alerts[0].detail.queue_id).toBe(qid);
    expect(alerts[0].detail.business_due_at).toBe('2026-10-12T10:00:00+07:00');
    expect(alerts[0].recipients).toEqual([]);
    expect(alerts[0].route_error).toContain('thiếu người nhận');
    expect(await count('agent_action_log', "action = 'red_alert_raise'")).toBe(1);
    expect(await val('select status from approval_queue where id = $1', [qid])).toBe('pending');
    expect(await verify()).toEqual([]);
  });

  it('cuối tuần không tính giờ làm việc', async () => {
    const qid = await item(
      'cskh_handoff',
      'convlog:wk',
      t(16, 17, 59),
      new Date(Math.max(t(19, 17, 59).getTime(), Date.now() + 24 * H)),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const now of [t(17, 12), t(18, 12), t(19, 9, 58)]) {
      expect((await sweep(aw, now, CFG)).escalated, now.toISOString()).toBe(0);
    }
    expect((await sweep(aw, t(19, 9, 59), CFG)).escalated).toBe(1);
    err.mockRestore();
    expect(Number(await val('select queue_id from sla_escalations'))).toBe(qid);
  });

  it('lớp B quá SLA → leo thang TGĐ, KHÔNG cảnh báo đỏ', async () => {
    const qid = await item('price_review', 'gd:77', t(12, 8));
    expect((await sweep(aw, t(12, 11, 59), CFG)).escalated).toBe(0);
    const r = await sweep(aw, t(12, 12), CFG);
    expect([r.escalated, r.red_alerts]).toEqual([1, 0]);
    expect(
      (
        await admin.query(
          'select queue_id, handoff_class, escalate_to_role, red_alert from sla_escalations',
        )
      ).rows,
    ).toEqual([
      { queue_id: String(qid), handoff_class: 'B', escalate_to_role: 'tgd', red_alert: false },
    ]);
    expect(await count('red_alerts')).toBe(0);
  });

  it('cảnh báo đỏ lỗi → rollback cả dòng leo thang, lần sau thử lại', async () => {
    await item('market_alert_s1', 'ma:901', t(12, 8));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = async () => {
      throw new Error('kênh lỗi giả lập');
    };
    let r = await sweep(aw, t(12, 10), CFG, { raiseAlert: boom });
    expect([r.errors, r.escalated]).toEqual([1, 0]);
    expect(err.mock.calls.flat().join(' ')).toContain('rollback, lần quét sau thử lại');
    expect([await count('sla_escalations'), await count('red_alerts')]).toEqual([0, 0]);
    r = await sweep(aw, t(12, 10), CFG);
    expect([r.escalated, r.red_alerts, r.errors]).toEqual([1, 1, 0]);
    err.mockRestore();
    expect([await count('sla_escalations'), await count('red_alerts')]).toEqual([1, 1]);
  });

  it('quá hạn tuyệt đối → expired (KHÔNG bao giờ approved), người duyệt sau không đổi được', async () => {
    const qid = await item('b2b_quote', 'Q-old', t(5, 9), t(9, 9));
    const nAppr = await count('approvals');
    const r = await sweep(aw, t(12, 10), CFG);
    expect(r.expired).toBe(1);
    expect(
      (await admin.query('select status, decided_by from approval_queue where id = $1', [qid]))
        .rows[0],
    ).toEqual({
      status: 'expired',
      decided_by: SWEEP_BY,
    });
    expect(await count('decisions', "kind = 'expired' and queue_id = $1", [qid])).toBe(1);
    expect(await count('agent_action_log', "action = 'queue_expire'")).toBe(1);
    const [ok, msg] = await decide(qid, 'approved');
    expect(ok).toBe(false);
    expect(msg).toBeTruthy();
    expect(await val('select status from approval_queue where id = $1', [qid])).toBe('expired');
    expect(await count('approvals')).toBe(nAppr);
    expect(await verify()).toEqual([]);
  });

  it('hạn tuyệt đối tới TRƯỚC hạn giờ làm việc / expired bởi đường khác → vẫn leo thang 1 lần', async () => {
    const holiday = await item('market_alert_s1', 'ma:950:x', t(9, 17), t(10, 17));
    const other = await item('cskh_handoff', 'cskh:other', t(9, 8), t(10, 9));
    expect(await aq.expireOverdue(aw, 'system:sla')).toBe(2);
    const b = await item('price_review', 'gd:951', t(5, 8), t(8, 9));
    await item('price_review', 'gd:952', t(1, 8), t(2, 9));
    const now = t(11, 12);
    expect(
      slaState({ object_type: 'market_alert_s1', created_at: t(9, 17) }, CFG, now).state,
    ).not.toBe('overdue');
    const p = await plan(aw, now, CFG, nodir);
    expect([p.escalate, p.red_alerts]).toEqual([3, 2]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let r = await sweep(aw, now, CFG);
    expect([r.expired, r.escalated, r.red_alerts, r.errors]).toEqual([2, 3, 2, 0]);
    r = await sweep(aw, now, CFG);
    expect([r.escalated, r.red_alerts]).toEqual([0, 0]);
    err.mockRestore();
    const esc = Object.fromEntries(
      (await admin.query('select queue_id, red_alert from sla_escalations')).rows.map((x) => [
        Number(x.queue_id),
        x.red_alert,
      ]),
    );
    expect(esc).toEqual({ [holiday]: true, [other]: true, [b]: false });
    const rows = (await admin.query('select title, detail from red_alerts order by id')).rows;
    expect(rows.map((x) => x.detail.queue_id)).toEqual([holiday, other]);
    for (const x of rows) {
      expect(x.detail.reason).toBe('expired');
      expect(x.title).toContain('Hết hạn tuyệt đối');
    }
    for (const q of [holiday, other, b])
      expect(await val('select status from approval_queue where id = $1', [q])).toBe('expired');
    expect(await count('approvals')).toBe(0);
    expect(await verify()).toEqual([]);
  });

  it('S1 không bao giờ tự duyệt kể cả có auto_policy đã ký', async () => {
    const qid = await item('market_alert_s1', 'ma:902', t(12, 8));
    await admin.query(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('s1_test', 'market_alert_s1', 'low', true, 'Nguoi Ky Gia Lap (test)', now())",
    );
    const [ok, msg] = await aq.autoApprove(aw, qid);
    expect(ok).toBe(false);
    expect(msg).toContain('rủi ro high');
    await directorRun(aw, 'sales', {
      now: t(12, 9),
      cfg: CFG,
      outDir: mkdtempSync(join(tmpdir(), 'sd-dir-')),
    });
    expect(await val('select status from approval_queue where id = $1', [qid])).toBe('pending');
    expect(await count('approvals')).toBe(0);
  });

  // ---------------------------------------------------------------- W50.6 bản tin

  it('gather khớp SQL + bản tin không PII', async () => {
    const now = new Date('2026-10-13T06:59:00+07:00'); // kỳ day = 12/10
    await alert('alcohol_listed', 'S1', 'open', 'x', 'a1');
    await alert('price_mismatch', 'S2', 'open', 'x', 'a2');
    await alert('price_mismatch', 'S2', 'open', 'x', 'a3');
    await alert('item_unmapped', 'S2', 'closed', 'x', 'a4');
    await gd('price_mismatch', 'g1');
    await gd('missing_price', 'g2');
    await gd('spec_mismatch', 'g3');
    await lead('l1', new Date('2026-10-11T17:30:00Z'), `${NAME} ở Huế hỏi giá, gọi ${PHONE}`); // 12/10 00:30 VN
    await lead('l2', new Date('2026-10-11T16:59:00Z'), `Đà Nẵng ${EMAIL}`); // 11/10 23:59 VN
    await lead('l3', t(12, 15), 'tiền Thuế thế nào');
    const over = await item('market_alert_s1', 'ma:1', t(12, 8), null, `S1 ${NAME} ${PHONE}`);
    await item('price_review', 'gd:1', t(12, 17));
    await item('cskh_handoff', 'convlog:x', t(12, 9), null, `hỏi ${EMAIL}`);
    const done = await item('b2b_quote', 'Q-9', t(10, 9));
    expect((await decide(done, 'rejected', NAME))[0]).toBe(true);
    await replica('update approval_queue set decided_at = $1 where id = $2', [t(12, 11), done]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sweep(aw, now, CFG);
    err.mockRestore();
    const data = await gather(aw, now, CFG, 'day', nodir);
    expect(data.queue).toHaveLength(
      await count('approval_queue', "status = 'pending' and block = 'sales'"),
    );
    expect(data.queue).toHaveLength(3);
    expect(data.decided).toEqual({ rejected: 1 });
    const sum = (sev: string) =>
      data.alerts.filter(([s]) => s === sev).reduce((a, x) => a + x[3], 0);
    expect(sum('S1')).toBe(await count('market_alerts', "status = 'open' and severity = 'S1'"));
    expect(sum('S2')).toBe(2);
    expect(data.golden_pending).toBe(2);
    expect(data.n_leads).toBe(2); // l1 + l3, không l2
    const reg = Object.fromEntries(data.regions);
    expect([
      reg['Miền Trung – Tây Nguyên khác'],
      reg['chưa rõ vùng'],
      reg['Quảng Nam – Đà Nẵng'],
    ]).toEqual([1, 1, 0]);
    const st = data.queue.find((q) => q.id === over);
    expect(st?.state).toBe('overdue');
    expect(st?.escalated_at).toBeTruthy();
    expect(data.catalog?.jobs).toBeNull(); // agent_writer không đọc job_runs
    const text = renderBulletin(CFG, data, now, 'day');
    expect(renderBulletin(CFG, data, now, 'day')).toBe(text);
    for (const s of [...PII, 'Thuế', 'Huế hỏi']) expect(text, s).not.toContain(s);
    expect(text).toContain('BẢN NHÁP');
    expect(text).toContain('external-dep');
    expect(text).toContain(`#${over} · Xử lý cảnh báo sàn S1 · lớp A`);
    expect(text).toContain('Tổng: S1 1 · S2 2');
  });

  it('mục 6 catalog A4/A5: đếm pending + job_runs; agent_writer → "không đọc được"', async () => {
    const now = new Date('2026-10-13T06:59:00+07:00');
    const a4 = await item('listing_sync', 'a4:title_drift:shopee:1001:0123456789ab', t(12, 9));
    const a5 = await item('market_alert_s1', 'a5:promo_banned:shopee:KM1:0123456789ab', t(12, 9));
    await item('price_change', 'gd:other', t(12, 9));
    await admin.query(
      "insert into job_runs (job, started_at, finished_at, ok) values ('agents.kd_listing', $1, $2, true), ('agents.kd_listing', $3, $4, false)",
      [t(11, 8), t(11, 8, 1), t(12, 8), t(12, 8, 2)],
    );
    const data = await gather(admin, now, CFG, 'day', nodir);
    expect(data.catalog?.pending).toEqual([
      ['a4', 'listing_sync', [a4]],
      ['a5', 'market_alert_s1', [a5]],
    ]);
    expect(data.catalog?.jobs).toEqual({ 'agents.kd_listing': [t(12, 8, 2), false] });
    const sec =
      renderBulletin(CFG, data, now)
        .split('## 6. Catalog & giá (A4/A5)')[1]
        ?.split('## Người duyệt')[0] ?? '';
    expect(sec).toContain('| A4 Catalog/listing đa sàn | 12/10/2026 08:02 | lỗi |');
    expect(sec).toContain('| A5 Giá & khuyến mãi | chưa chạy | — |');
    expect(sec).toContain(`#${a4}`);
    for (const s of ['ruou', 'rượu', 'KM1', '1001', 'title_drift']) expect(sec, s).not.toContain(s);
    const d2 = await gather(aw, now, CFG, 'day', nodir);
    expect(d2.catalog?.jobs).toBeNull();
    expect(d2.catalog?.pending).toEqual(data.catalog?.pending);
    expect((await aw.query('select 1 as ok')).rows).toEqual([{ ok: 1 }]); // client vẫn dùng tiếp được
  });

  // ---------------------------------------------------------------- W50.7 dry-run + CLI

  it('dry-run KHÔNG ghi gì', async () => {
    await alert('alcohol_listed', 'S1', 'open', 'x', 'd1');
    await item('cskh_handoff', 'convlog:d', t(12, 8), t(15, 8));
    await item('b2b_quote', 'Q-d', t(8, 9), t(12, 9));
    const data = convlog([conv('2026-10-12T04:00:00Z', false, `gọi ${PHONE}`, 'm-d')]);
    const before = await snapshot();
    const p = await run(aw, t(12, 12), CFG, data, true);
    expect(await snapshot()).toEqual(before);
    expect(p).toMatchObject({
      dry_run: true,
      enqueue: { cskh_handoff: 1, market_alert_s1: 1 },
      expire: 1,
      escalate: 2,
      red_alerts: 1,
    });
  });

  it('CLI login svc_job: dry-run + bản tin in stdout, không PII, không ghi DB/file', async () => {
    await alert('alcohol_listed', 'S1', 'open', 'x', 'c1');
    await lead('lc', t(12, 10), `${NAME} ${PHONE} ${EMAIL}`);
    await item('cskh_handoff', 'convlog:c', t(12, 8), null, `${NAME} ${PHONE}`);
    const data = convlog([conv('2026-10-12T04:00:00Z', false, `${NAME} ${PHONE} ${EMAIL}`, 'm-c')]);
    const outDir = mkdtempSync(join(tmpdir(), 'sd-out-'));
    const out: string[] = [];
    const errs: string[] = [];
    const jobs: string[] = [];
    const before = await snapshot();
    const rc = await salesDirectorMain(
      { run: true, dryRun: true, bulletin: true, now: '2026-10-13T12:00+07:00', outDir },
      {
        log: (s) => out.push(s),
        err: (s) => errs.push(s),
        open: async () => createPool(jobUrl, { max: 2 }), // lệnh tự end() pool
        wire: null,
        dataDir: data,
        jobRun: (async () => {
          jobs.push('x');
          return 0;
        }) as never,
      },
    );
    const o = out.join('\n');
    expect([rc, jobs], errs.join('\n')).toEqual([0, []]);
    expect(o).toContain('[dry-run]');
    expect(o).toContain('BẢN NHÁP');
    for (const s of PII) {
      expect(o, s).not.toContain(s);
      expect(errs.join('\n'), s).not.toContain(s);
    }
    expect(await snapshot()).toEqual(before);
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('CLI login svc_job: --run --bulletin ghi hàng duyệt + leo thang + file bản tin, exit 0', async () => {
    await alert('alcohol_listed', 'S1', 'open', 'x', 'j1');
    await gd('price_mismatch', 'g1');
    await lead('lj', t(12, 9));
    const data = convlog([conv('2026-10-13T01:00:00Z', false, `gọi ${PHONE}`, 'm-j')]);
    const outDir = mkdtempSync(join(tmpdir(), 'sd-out-'));
    const out: string[] = [];
    const runs: boolean[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rc = await salesDirectorMain(
      { run: true, bulletin: true, outDir },
      {
        log: (s) => out.push(s),
        err: (s) => out.push(s),
        open: async () => createPool(jobUrl, { max: 2 }), // lệnh tự end() pool
        wire: null,
        dataDir: data,
        clock: () => t(13, 12),
        jobRun: (async (_n: string, body: (r: { ok: boolean }) => Promise<number>) => {
          const r = { ok: true };
          const v = await body(r);
          runs.push(r.ok);
          return v;
        }) as never,
      },
    );
    err.mockRestore();
    expect([rc, runs], out.join('\n')).toEqual([0, [true]]);
    expect(out[0]).toMatch(/^\[run\] đẩy 4 mục mới/);
    const types = (
      await admin.query('select object_type, created_by from approval_queue order by id')
    ).rows;
    expect(types.map((x) => x.object_type).sort()).toEqual([
      'cskh_handoff',
      'lead_followup',
      'market_alert_s1',
      'price_review',
    ]);
    expect(types.every((x) => x.created_by === AGENT)).toBe(true);
    const files = readdirSync(outDir);
    expect(files).toEqual(['sales-director-day-2026-10-12.md']);
    const body = readFileSync(join(outDir, files[0] as string), 'utf8');
    expect(body).toContain('# Bản tin GĐ Kinh doanh TMĐT — ngày 12/10/2026');
    expect(body).not.toContain(PHONE);
    expect(out.join('\n')).toContain('[bulletin] ');
    expect(await verify()).toEqual([]);
  });

  it('CSKH: pending nuốt tin dồn; đã quyết mà khách hỏi tiếp → đợt MỚI (decided_at muộn nhất)', async () => {
    const base = cskhObjectId({ user_hash: UHASH }, new Date('2026-10-12T02:00:00Z'));
    const recs: object[] = [convU('2026-10-12T02:00:00Z', UHASH, 'q-0900', 'hỏi giá')];
    const go = async (now: Date) => {
      const [items, deferred] = await collectAll(aw, now, CFG, convlog(recs));
      expect(deferred).toBe(0);
      return items;
    };
    const dec = async (qid: number, d: 'approved' | 'rejected', at: Date) => {
      expect(await decide(qid, d)).toEqual([true, null]);
      await replica('update approval_queue set decided_at = $1 where id = $2', [at, qid]);
    };
    let items = await go(t(12, 9, 30));
    expect(items.map((i) => i.object_id)).toEqual([base]);
    expect(await enqueueNew(aw, items, CFG)).toBe(1);
    const qid1 = Number(await val('select id from approval_queue where object_id = $1', [base]));
    for (let m = 5; m < 35; m++)
      for (const s of [0, 30])
        recs.push(
          convU(
            `2026-10-12T02:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`,
            UHASH,
            `st-${m}-${s}`,
          ),
        );
    expect(await go(t(12, 9, 50))).toEqual([]);
    await dec(qid1, 'approved', t(12, 10));
    expect(await go(t(12, 15))).toEqual([]); // mọi tin ≤ decided_at → đã xử lý
    recs.push(convU('2026-10-12T07:00:00Z', UHASH, 'q-1400', 'hỏi ship'));
    items = await go(t(12, 15));
    expect(items.map((i) => i.object_id)).toEqual([`${base}:20261012T070000Z`]);
    expect(items[0]?.payload).toContain('1 câu chatbot');
    expect(items[0]?.payload).toContain('12/10/2026 14:00');
    expect(await enqueueNew(aw, items, CFG)).toBe(1);
    expect(await go(t(12, 15))).toEqual([]); // idempotent
    const qid2 = Number(
      await val('select id from approval_queue where object_id = $1', [items[0]?.object_id]),
    );
    await dec(qid2, 'rejected', t(12, 15, 30));
    recs.push(convU('2026-10-12T09:00:00Z', UHASH, 'q-1600', 'hỏi lại'));
    expect((await go(t(12, 16, 30))).map((i) => i.object_id)).toEqual([`${base}:20261012T090000Z`]);
    expect(await count('approval_queue', "object_type = 'cskh_handoff'")).toBe(2);
  });

  it('CSKH chỉ từ dòng convlog live (mẫu/mock/thiếu provenance không sinh SLA thật)', async () => {
    const live = convU('2026-10-12T02:00:00Z', UHASH, 'q-live', 'hỏi giá');
    const mock = {
      ...convU('2026-10-12T02:01:00Z', 'b'.repeat(16), 'mock0-1', 'hỏi'),
      provenance: 'sample',
      is_sample: true,
    };
    const { provenance: _, ...old } = convU('2026-10-12T02:02:00Z', 'c'.repeat(16), 'old-1', 'hỏi');
    const [items] = await collectAll(aw, t(12, 9, 30), CFG, convlog([live, mock, old]));
    expect(items.filter((i) => i.object_type === 'cskh_handoff')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- v14.4 sales-04.1 lead_followup

  const leadItemsOf = async (now: Date) =>
    (await collect(aw, now, CFG, nodir)).filter((i) => i.object_type === 'lead_followup');

  it('lead chưa gán quá 4 giờ làm việc / đã gán quá hạn xử lý → mục theo ĐỢT', async () => {
    const a = await lead('a', t(12, 9));
    const b = await lead('b', t(12, 9));
    const young = await lead('y', t(12, 11));
    const done = await lead('d', t(12, 9), 'giá hộp', 'contacted');
    const old = await lead('o', new Date(t(12, 9).getTime() - 30 * 86_400_000));
    await assign(b, 'NV07', t(12, 10)); // hạn 8 giờ làm việc → T2 18:00
    let got = Object.fromEntries((await leadItemsOf(t(12, 14))).map((i) => [i.object_id, i]));
    expect(Object.keys(got)).toEqual([`lead:${a}:chua_gan`]);
    got = Object.fromEntries((await leadItemsOf(t(13, 9))).map((i) => [i.object_id, i]));
    const kb = `lead:${b}:20261012T030000000000Z`;
    expect(new Set(Object.keys(got))).toEqual(
      new Set([`lead:${a}:chua_gan`, `lead:${young}:chua_gan`, kb]),
    );
    expect(Object.keys(got).join(' ')).not.toMatch(new RegExp(`:(${done}|${old}):`));
    const pb = got[kb]?.payload ?? '';
    expect(pb).toContain('NV07');
    expect(pb).toContain('12/10/2026 18:00');
    expect(pb).not.toContain('13/10');
    for (const it of Object.values(got)) {
      expect(check(it.payload).ok).toBe(true);
      for (const s of [...PII, 'giá hộp']) {
        expect(it.payload).not.toContain(s);
        expect(it.title).not.toContain(s);
      }
    }
  });

  it('lead_followup: idempotent, gán lại = đợt mới, đã xử lý → hết', async () => {
    const lid = await lead('w', t(12, 9));
    const now = t(13, 9);
    expect(await enqueueNew(aw, await collect(aw, now, CFG, nodir), CFG)).toBe(1);
    expect(await leadItemsOf(now)).toEqual([]);
    const rows = (
      await admin.query(
        "select object_id, status, created_by from approval_queue where object_type = 'lead_followup'",
      )
    ).rows;
    expect(rows).toEqual([
      { object_id: `lead:${lid}:chua_gan`, status: 'pending', created_by: AGENT },
    ]);
    await assign(lid, 'NV01', t(13, 9));
    expect(await leadItemsOf(t(13, 16))).toEqual([]); // chưa quá hạn mới
    expect((await leadItemsOf(t(14, 9))).map((i) => i.object_id)).toEqual([
      `lead:${lid}:20261013T020000000000Z`,
    ]);
    await admin.query("update leads set status = 'contacted' where id = $1", [lid]);
    expect(await leadItemsOf(t(14, 9))).toEqual([]);
  });

  it('lead_followup: trần mỗi lần chạy + phần vượt được đếm, không mất mục (P8.6)', async () => {
    for (let i = 0; i < 5; i++) await lead(`c${i}`, t(12, 8));
    const cfg = {
      ...CFG,
      lead_owner: { ...(CFG.lead_owner as NonNullable<SalesConfig['lead_owner']>), max_per_run: 2 },
    };
    const st = {};
    expect(await leadItems(aw, t(13, 9), cfg, st)).toHaveLength(2);
    expect(st).toEqual({ deferred: 3 });
    expect((await plan(aw, t(13, 9), cfg, nodir)).lead_deferred).toBe(3);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: [number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const r = await run(aw, t(13, 9), cfg, nodir);
      if (!r.dry_run) got.push([r.enqueued, r.lead_deferred]);
    }
    err.mockRestore();
    expect(got).toEqual([
      [2, 3],
      [2, 1],
      [1, 0],
    ]);
    expect(await count('approval_queue', "object_type = 'lead_followup'")).toBe(5);
  });

  it('lead_followup quá 4 giờ làm việc → leo thang lớp B (TGĐ) như mục KD khác', async () => {
    await lead('e', t(12, 8));
    await enqueueNew(aw, await leadItemsOf(t(12, 13)), CFG);
    const created = (await val('select created_at from approval_queue')) as Date;
    const res = await sweep(aw, new Date(created.getTime() + 6 * 86_400_000), CFG);
    expect(res.escalated).toBe(1);
    expect(
      (await admin.query('select handoff_class, escalate_to_role from sla_escalations')).rows,
    ).toEqual([{ handoff_class: 'B', escalate_to_role: 'tgd' }]);
  });

  it('cổng rollout: sales-04.1 TẮT → không sinh lead_followup, CLI dừng exit 1', async () => {
    // rollout THẬT: danh mục data/contract_features.json (lead_followup của agent:sales_director →
    // sales-04.1) + sổ feature_rollout trên DB của lệnh.
    installFakeDeps({ guardrailCheck: (x) => check(x), rollout: opsRollout });
    await replica(
      "insert into feature_rollout (feature_id, stage, updated_by) values ('sales-04.1', 'tat', 'Người thử (test)')",
    );
    await lead('r', t(12, 9));
    const errs: string[] = [];
    const rc = await salesDirectorMain(
      { run: true },
      {
        log: () => {},
        err: (s) => errs.push(s),
        open: async () => createPool(jobUrl, { max: 2 }), // lệnh tự end() pool
        wire: null,
        dataDir: nodir,
        clock: () => t(13, 12),
        jobRun: (async (_n: string, body: (r: { ok: boolean }) => Promise<number>) =>
          body({ ok: true })) as never,
      },
    );
    expect(rc).toBe(1);
    expect(errs.join('\n')).toMatch(/sales-04\.1 .*tắt.*không sinh đầu ra/);
    expect(await count('approval_queue', "object_type = 'lead_followup'")).toBe(0);
  });

  // ---------------------------------------------------------------- kd_forecast: tồn kho

  it('currentStock: dòng mới nhất mỗi (sku, kho), kho cũ = stale, nguồn mẫu', async () => {
    const ins =
      "insert into inventory_snapshots (sku_key, kho, qty, captured_at, source, file_name, file_sha256, row_no) values ($1, $2, $3, $4, $5, 'f.csv', $6, $7)";
    await admin.query(ins, ['saphraton-20v', 'KHO-A', 10, '2026-10-01', 'manual_export', 'a1', 1]);
    await admin.query(ins, ['saphraton-20v', 'KHO-A', 7, '2026-10-05', 'manual_export', 'a2', 1]);
    await admin.query(ins, ['savina-12v', 'KHO-A', 4, '2026-10-01', 'manual_export', 'a1', 2]); // file cũ
    await admin.query(ins, ['saphraton-20v', 'KHO-B', 3, '2026-10-05', 'sample', 'b1', 1]);
    const s = await currentStock(job);
    expect(s).toEqual({
      'saphraton-20v': {
        qty: 10,
        kho: {
          'KHO-A': { qty: 7, captured_at: '2026-10-05', stale: false },
          'KHO-B': { qty: 3, captured_at: '2026-10-05', stale: false },
        },
        stale: [],
        sample: true,
      },
      'savina-12v': {
        qty: 4,
        kho: { 'KHO-A': { qty: 4, captured_at: '2026-10-01', stale: true } },
        stale: ['KHO-A'],
        sample: false,
      },
    });
  });
});
