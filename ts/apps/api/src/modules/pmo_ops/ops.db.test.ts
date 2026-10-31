import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { settings } from '@samsam/core/rollout/counters';
import { setConnector } from '@samsam/core/rollout/rollout';
import { createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as hb from './health-bulletin.js';
import * as oi from './ops-incidents.js';
import * as om from './ops-monthly.js';

// Dịch phần DB của tests/test_ops_monthly.py + test_v13_c07_ops.py (sổ sự cố append-only, KPI chat
// bền qua xoay vòng convlog, xác nhận gửi CHỈ do người gửi) + kiểm câu SQL của bản tin sức khỏe trên
// schema thật. DB riêng dựng lại từ mẫu MỖI ca, xóa khi xong. Người trong test là tên GIẢ LẬP.

const SHIFT = { start: '00:00', end: '23:59', workdays: [0, 1, 2, 3, 4], holidays: [] };
const vn = (s: string) => new Date(`${s}+07:00`);
const H = 3600_000;
const NAME = testDbName('pmo_ops_om');

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('ops_incidents + ops_monthly + health (DB)', () => {
  let pool: pg.Pool;
  let dsn: string;
  let tmp: string;
  const extra: pg.Pool[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const lease = (db?: pg.Pool) => async () => ({ db: db ?? pool, release: async () => {} });
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-db-'));
  });
  beforeEach(async () => {
    for (const p of extra.splice(0)) await p.end();
    await pool?.end();
    await dropDb(NAME);
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    wireCore(pool);
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    for (const p of extra.splice(0)) await p.end();
    await pool?.end();
    await dropDb(NAME);
    settings.forceMode = null;
    setConnector(null);
    resetOpsDeps();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('sổ sự cố: che PII, từ chối agent/thời điểm sai/loại lạ, APPEND-ONLY; báo cáo tháng đọc sổ → PL02 mục 2', async () => {
    const now = new Date();
    const det = new Date(now.getTime() - 5 * H);
    const iid = await oi.openIncident(pool, {
      title: 'Chatbot lộ SĐT 0912 345 678',
      severity: 'nghiem_trong',
      source: 'kuma',
      ben: 'ben_a',
      detectedAt: det.toISOString(),
      occurredAt: new Date(det.getTime() - 10 * 60_000).toISOString(),
      by: 'Người Trực',
      now,
    });
    const title = (await q('select title from ops_incidents where id = $1', [iid]))[0]?.title;
    expect(title).not.toContain('0912');
    for (const kw of [
      { by: 'agent:bot' },
      { at: new Date(det.getTime() - 60_000).toISOString() },
      { at: new Date(now.getTime() + H).toISOString() },
    ]) {
      await expect(
        oi.addEvent(pool, iid, 'responded', { by: 'Người Trực', now, ...kw }),
      ).rejects.toBeInstanceOf(oi.IncidentError);
    }
    await expect(
      oi.addEvent(pool, iid, 'da_xong', { by: 'Người Trực', now }),
    ).rejects.toBeInstanceOf(oi.IncidentError);
    await oi.addEvent(pool, iid, 'responded', {
      by: 'Người Trực',
      at: new Date(det.getTime() + H).toISOString(),
      now,
    });
    await oi.addEvent(pool, iid, 'customer_resolved', { by: 'CSKH', now });
    await expect(
      oi.openIncident(pool, {
        title: 'x',
        severity: 'nhe',
        source: 's',
        ben: 'ben_a',
        detectedAt: det,
        by: 'Người',
        now,
      }),
    ).rejects.toBeInstanceOf(oi.IncidentError);
    for (const sql of [
      "update ops_incidents set severity = 'thuong'",
      'delete from ops_incident_events',
    ]) {
      await expect(pool.query(sql)).rejects.toThrow();
    }
    expect(Number((await q('select count(*) as n from ops_incident_events'))[0]?.n)).toBe(2);
    const [start, end] = om.monthBounds(
      new Date(det.getTime() + 7 * H).toISOString().slice(0, 7),
      now,
    );
    const out = await om.collectDb(pool, start, end);
    const [rows, notes] = om.incidentRows(out.incidents, SHIFT, now);
    const by = Object.fromEntries(rows.map((r) => [r[0], r[2]]));
    expect(by['Phát hiện sự cố hệ thống']).toMatch(/^100\.0% \(1\/1\)/);
    expect(by['Phản hồi lỗi nghiêm trọng']).toMatch(/^100\.0% \(1\/1\)/);
    expect(by['Phản hồi lỗi thường']).toContain('— (0/0)');
    expect(by['Sửa lỗi phát sinh']).toContain('chưa tới hạn 1');
    expect(notes[0]).toContain('xử lý khách/đối tác xong 1');
  });

  it('CLI sổ sự cố: --open/--event/--list (người thật, giờ VN)', async () => {
    const now = vn('2026-10-16T20:00:00');
    const d = {
      connect: lease(),
      now: () => now,
      shift: () => SHIFT,
      holidayWarning: () => 'lịch nghỉ chưa chốt',
    };
    let s = io();
    expect(
      await oi.opsIncidentsMain(
        {
          open: true,
          title: 'Webhook Zalo lỗi',
          severity: 'thuong',
          source: 'webhook_probe',
          ben: 'ben_a',
          detectedAt: '2026-10-16 16:00',
          by: 'Người Trực',
        },
        { ...d, io: s.io },
      ),
    ).toBe(0);
    const iid = /#(\d+)/.exec(s.out[0] ?? '')?.[1];
    expect(s.out[0]).toBe(`[done] đã ghi sự cố #${iid}`);
    s = io();
    expect(
      await oi.opsIncidentsMain(
        {
          event: iid,
          kind: 'responded',
          at: '2026-10-16T17:00',
          by: 'Người Trực',
          note: 'gọi 0912345678',
        },
        { ...d, io: s.io },
      ),
    ).toBe(0);
    expect(s.out[0]).toMatch(
      new RegExp(`^\\[done\\] sự cố #${iid}: ghi mốc responded \\(#\\d+\\)$`),
    );
    expect((await q('select note, by_name from ops_incident_events'))[0]).toEqual({
      note: 'gọi ***',
      by_name: 'Người Trực',
    });
    s = io();
    expect(await oi.opsIncidentsMain({ list: true, month: '2026-10' }, { ...d, io: s.io })).toBe(0);
    expect(s.out).toEqual([
      '[list] 1 sự cố phát hiện trong 10/2026',
      `  #${iid} thuong (ben_a): phát hiện unmeasured · phản hồi ok · sửa pending · xử lý khách chưa ghi`,
      '[warn] lịch nghỉ chưa chốt',
    ]);
  });

  it('collect_db: CHỈ SELECT, đếm đúng mốc giờ (bỏ bản leo thang/ngoài kỳ)', async () => {
    const start = vn('2026-10-01T00:00:00');
    const end = vn('2026-11-01T00:00:00');
    for (const [t, trg] of [
      ['red_alerts', 'red_alerts_stamp_ins'],
      ['red_alert_acks', 'red_alert_acks_stamp_ins'],
      ['approval_queue', 'approval_queue_guard_row'],
    ]) {
      await q(`alter table ${t} disable trigger ${trg}`);
    }
    const a = new Date(start.getTime() + 3 * 24 * H);
    const ids: string[] = [];
    for (const [ts, det] of [
      [a, '{}'],
      [a, '{}'],
      [a, '{"escalation_of": 1}'],
      [new Date(start.getTime() - H), '{}'],
    ] as const) {
      ids.push(
        (
          await q(
            "insert into red_alerts (ts, source_agent, title, detail) values ($1, 'x', 't', $2::jsonb) returning id::text as id",
            [ts, det],
          )
        )[0]?.id,
      );
    }
    await q(
      "insert into red_alert_acks (alert_id, acked_by, acked_at) values ($1, 'Người A', $2)",
      [ids[0], new Date(a.getTime() + H)],
    );
    for (const [url, first, closed, reason, codes, sev] of [
      ['https://x/1', a, new Date(a.getTime() + 2 * H), 'da_go', ['thieu_ban_duyet'], 'S2'],
      ['https://x/2', a, null, null, ['ruou_cam_quang_cao'], 'S1'],
      ['https://x/3', new Date(start.getTime() - 2 * 24 * H), null, null, ['sku_chua_xnqc'], 'S1'],
    ] as const) {
      await q(
        "insert into channel_posts (url, channel, content_type, is_ai, text, text_sha256, guardrail, codes, severity, first_detected_at, due_at, imported_by, scanned_at, closed_at, close_reason) values ($1, 'web', 'post', true, 'bài', $2, '{}', $3, $4, $5, $6, 'Người B', $5, $7, $8)",
        [
          url,
          '0'.repeat(64),
          codes,
          sev,
          first,
          new Date(first.getTime() + 24 * H),
          closed,
          reason,
        ],
      );
    }
    for (const [oid, st, dec] of [
      ['cskh:g1', 'approved', a],
      ['cskh:g2', 'expired', a],
      ['cskh:g3', 'pending', null],
      ['cskh:g4', 'rejected', new Date(start.getTime() - 24 * H)],
    ] as const) {
      await q(
        "insert into approval_queue (object_type, object_id, block, title, payload, content_sha256, risk, guardrail, created_by, due_at, status, decided_by, decided_at) values ('cskh_handoff', $1, 'sales', 't', 'p', $2, 'medium', '{}', 'agent:x', $3, $4, $5, $6)",
        [oid, '0'.repeat(64), a, st, dec ? 'Người C' : null, dec],
      );
    }
    for (const [ts, agent, cost, ok] of [
      [a, 'chatbot', 0.25, true],
      [a, 'chatbot', 0.5, false],
      [a, 'content', 1.0, true],
      [new Date(start.getTime() - 1000), 'chatbot', 9.0, true],
    ] as const) {
      await q(
        "insert into llm_usage (ts, agent_id, model, cost_usd, ok) values ($1, $2, 'm', $3, $4)",
        [ts, agent, cost, ok],
      );
    }
    const log: string[] = [];
    const spy = {
      query: (sql: string, p?: unknown[]) => {
        log.push(sql);
        return pool.query(sql, p);
      },
    } as unknown as pg.Pool;
    const out = await om.collectDb(spy, start, end);
    expect((out.alerts as om.AlertRow[]).map((r) => r[0])).toEqual(ids.slice(0, 2));
    const k = om.kpiAlerts(out.alerts as om.AlertRow[], vn('2026-11-02T00:00:00'));
    expect([k.ok, k.late, k.unacked]).toEqual([1, 1, [ids[1]]]);
    expect(om.kpiTakedown(out.takedown as om.TakedownRow[], vn('2026-11-02T00:00:00'))).toEqual({
      ok: 1,
      late: 1,
      pending: 0,
    });
    expect(out.posts).toEqual({ scans: 2, unapproved: 1, no_paper: 1 });
    expect((out.cskh as om.CskhRow[]).map((r) => r[0])).toEqual(['cskh:g1']);
    expect(out.cost).toEqual([
      ['content', 1, 1.0, 0],
      ['chatbot', 2, 0.75, 1],
    ]);
    expect(out.undelivered).toEqual(ids.slice(0, 2));
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((s) => s.trimStart().toLowerCase().startsWith('select'))).toBe(true);
  });

  it('collect_db: thiếu bảng → "missing" từng mục, kết nối vẫn dùng được', async () => {
    const sch = `t_b6_${process.pid}`;
    await q(`create schema ${sch}`);
    const p = createPool(dsn, { options: `-c search_path=${sch},pg_temp` });
    extra.push(p);
    const out = await om.collectDb(p, vn('2026-10-01T00:00:00'), vn('2026-11-01T00:00:00'));
    expect(Object.values(out).every((v) => v === om.MISSING)).toBe(true);
    expect((await p.query('select 1 as x')).rows[0]?.x).toBe(1);
    const hbOut = await hb.collect(p, hb.EXPECTED_JOBS);
    expect(hbOut).toEqual({
      db_ok: true,
      jobs: hb.MISSING,
      spend: hb.MISSING,
      llm_errors: hb.MISSING,
      pending: hb.MISSING,
    });
  });

  it('--snapshot: dữ kiện KHÔNG PII vào chat_kpi_live, chạy lại không nhân bản; KPI vẫn còn đầu tháng sau xoay vòng convlog', async () => {
    const base = {
      user_hash: 'h'.repeat(16),
      question: 'Anh Nguyễn Văn Mẫu 0912345678',
      provenance: 'live',
    };
    const early = [
      {
        ...base,
        ts: '2026-10-01T01:00:00Z',
        msg_id: 'm1',
        answered: true,
        reply_ms: 1200,
        channel: 'zalo',
      },
      {
        ...base,
        ts: '2026-10-01T02:00:00Z',
        msg_id: 'm2',
        answered: false,
        reply_ms: 31000,
        channel: 'zalo',
      },
    ];
    const late = [
      {
        ...base,
        ts: '2026-10-31T03:00:00Z',
        msg_id: 'm3',
        answered: true,
        reply_ms: 900,
        channel: 'messenger',
      },
    ];
    const write = (recs: object[]) =>
      writeFileSync(
        join(tmp, 'conversations.jsonl'),
        recs.map((r) => `${JSON.stringify(r)}\n`).join(''),
      );
    write([...early, ...late]);
    expect(await om.snapshot(pool, tmp)).toEqual([3, 3]);
    expect(await om.snapshot(pool, tmp)).toEqual([3, 0]);
    let s = io();
    expect(
      await om.opsMonthlyMain({ snapshot: true }, { io: s.io, connect: lease(), dataDir: tmp }),
    ).toBe(0);
    expect(s.out).toEqual(['[ok] chat_kpi_live: đọc 3 dữ kiện live, mới 0']);
    const dump = JSON.stringify(await q('select * from chat_kpi_live'));
    for (const bad of ['Mẫu', '0912', 'h'.repeat(16), '"m1"']) expect(dump).not.toContain(bad);
    write(late); // convlog xoay vòng: chỉ còn tin cuối tháng
    const [start, end] = om.monthBounds('2026-10', vn('2026-11-03T00:00:00'));
    const conv = om.readConvlog(tmp, start, end);
    expect(conv.questions.length).toBe(1);
    const merged = om.mergeChat(conv, (await om.collectDb(pool, start, end)).chat_facts);
    expect(merged.questions.length).toBe(3);
    expect([...merged.latencies].sort((a, b) => a - b)).toEqual([900, 1200, 31000]);
    expect((merged.earliest as Date).getTime()).toBeLessThanOrEqual(start.getTime() + 9 * H);
    // báo cáo tháng gộp sổ (DB sống) → exit 0, ghi số dòng sổ
    s = io();
    const rc = await om.opsMonthlyMain(
      { month: '2026-10', outDir: tmp },
      {
        io: s.io,
        connect: lease(),
        now: () => vn('2026-11-03T00:00:00'),
        dataDir: tmp,
        backupDir: null,
        workdays: () => SHIFT,
        holidayWarning: () => null,
        repoFacts: () => ({ head: null, modules: 1, tests: 1, handover: [] }),
      },
    );
    expect(rc, s.out.join('\n')).toBe(0);
    const md = readFileSync(join(tmp, 'van-hanh-2026-10.md'), 'utf8');
    expect(md).toContain('- Dữ kiện chat: 3 dòng từ `chat_kpi_live`');
    expect(md).not.toContain('DB không truy cập được');
  });

  it('docx vòng 2: dòng chat_kpi_facts cũ (không provenance) = UNKNOWN, KHÔNG vào KPI; bản live cùng khóa không bị che; snapshot không ghi bảng cũ', async () => {
    const dir = mkdtempSync(join(tmp, 'kpi-'));
    const START = vn('2026-10-01T00:00:00');
    const END = vn('2026-11-01T00:00:00');
    const qkey = (mid: string) => createHash('sha256').update(`convlog:${mid}`).digest('hex');
    const old = (mid: string, handled = true) =>
      q(
        "insert into chat_kpi_facts (qkey, ts, channel, is_question, handled_by_bot, group_oid, reply_ms) values ($1, '2026-10-05T03:00:00Z', 'zalo', true, $2, null, 900)",
        [qkey(mid), handled],
      );
    const conv = (recs: object[]) =>
      writeFileSync(
        join(dir, 'conversations.jsonl'),
        recs
          .map((r) =>
            JSON.stringify({
              user_hash: 'h'.repeat(16),
              question: 'giá bao nhiêu',
              channel: 'zalo',
              sent: true,
              reply_ms: 1000,
              ...r,
            }),
          )
          .map((l) => `${l}\n`)
          .join(''),
      );
    const kpi = async () => {
      const dbf = await om.collectDb(pool, START, END);
      return [om.mergeChat(om.readConvlog(dir, START, END), dbf.chat_facts), dbf] as const;
    };
    const report = async () =>
      om.render(
        await om.gather(START, END, END, om.loadAssets(), {
          connect: lease(),
          dataDir: dir,
          backupDir: null,
          workdays: () => SHIFT,
          holidayWarning: () => null,
          repoFacts: () => ({ head: null, modules: 1, tests: 1, handover: [] }),
        }),
      );
    for (let i = 0; i < 4; i++) await old(`mock0-${i}`);
    let [c, dbf] = await kpi();
    expect(c.questions).toEqual([]);
    expect(c.exists).toBe(false);
    expect(dbf.chat_unknown).toBe(4);
    let md = await report();
    expect(md).toContain('4 dữ kiện chụp trước bản lọc provenance');
    expect(md).toContain('không có convlog');
    // bản live cùng khóa với dòng cũ: không bị che, không đếm đôi
    await old('z7', false);
    conv([{ ts: '2026-10-07T02:00:00Z', msg_id: 'z7', answered: true, provenance: 'live' }]);
    expect(await om.snapshot(pool, dir)).toEqual([1, 1]);
    expect(Number((await q('select count(*) as n from chat_kpi_facts'))[0]?.n)).toBe(5); // không ghi bảng cũ
    for (const keep of [true, false]) {
      if (!keep) rmSync(join(dir, 'conversations.jsonl'));
      [c, dbf] = await kpi();
      expect(c.questions.length).toBe(1);
      expect(c.questions[0]?.[1]).toBe(true); // bản LIVE
      expect(dbf.chat_unknown).toBe(4);
    }
    await expect(pool.query('update chat_kpi_facts set handled_by_bot = true')).rejects.toThrow();
    await expect(pool.query('delete from chat_kpi_live')).rejects.toThrow(); // sổ append-only
    // dòng thiếu provenance trong convlog: không tin → KPI "— (0/0)", không chấm Đạt (sổ live tháng
    // này chỉ có z7 → dời sang tháng sau để kiểm riêng nhánh thiếu bằng chứng)
    START.setTime(vn('2026-12-01T00:00:00').getTime());
    END.setTime(vn('2027-01-01T00:00:00').getTime());
    conv([{ ts: '2026-12-08T02:00:00Z', msg_id: 'x2', answered: true }]);
    md = await report();
    const row = md.split(/\n/).find((l) => l.startsWith('| Câu hỏi khách xử lý')) ?? '';
    expect(row).toContain('— (0/0)');
    expect(row).not.toMatch(/Đạt|ĐẠT/);
    expect(md).toContain('1 dòng thiếu provenance');
  });

  it('--mark-sent: chỉ NGƯỜI gửi + đúng file; báo cáo tháng sau chấm hạn ngày 05', async () => {
    const now = () => vn('2026-11-03T09:00:00');
    const f = join(tmp, 'van-hanh-2026-10.md');
    writeFileSync(f, 'báo cáo');
    for (const o of [
      { markSent: '2026-10', file: f, by: 'agent:ops' },
      { markSent: '2026-10', file: join(tmp, 'x.md'), by: 'Người Gửi' },
      { markSent: '2026-11', file: f, by: 'Người Gửi' },
    ]) {
      expect(await om.opsMonthlyMain(o, { io: io().io, now, connect: lease() })).toBe(2);
    }
    const s = io();
    expect(
      await om.opsMonthlyMain(
        { markSent: '2026-10', file: f, by: 'Người Gửi' },
        { io: s.io, now, connect: lease() },
      ),
    ).toBe(0);
    expect(s.out[0]).toMatch(
      /^\[ok\] đã ghi xác nhận gửi báo cáo 10\/2026 \(sha256 [0-9a-f]{12}; giờ ghi do DB đặt\)$/,
    );
    const [start] = om.monthBounds('2026-11', now());
    const sent = (await om.collectDb(pool, start, vn('2026-12-01T00:00:00'))).report_sent as [
      Date,
      string,
      string,
    ];
    expect(sent[1]).toBe('Người Gửi');
    expect(sent[2]).toHaveLength(64);
    const row = om.sentRow(sent, start);
    expect(row[0]).toBe('Báo cáo vận hành tháng 10/2026 gửi Bên B');
    expect(om.sentRow([vn('2026-11-04T23:59:00'), 'A', 'a'.repeat(64)], start)[3]).toBe('Đạt');
    expect(om.sentRow([vn('2026-11-05T00:00:00'), 'A', 'a'.repeat(64)], start)[3]).toBe(
      'KHÔNG ĐẠT',
    );
    const none = om.sentRow([], start);
    expect(none[3]).toBe('—');
    expect(none[2]).toContain('chưa có xác nhận');
    const oct = await om.collectDb(pool, vn('2026-10-01T00:00:00'), vn('2026-11-01T00:00:00'));
    expect(oct.report_sent).toEqual([]); // tháng 9 chưa ai xác nhận gửi
  });

  it('bản tin sức khỏe: câu SQL chạy trên schema thật (job/chi phí tháng VN/lỗi 24h/hàng chờ)', async () => {
    await q(
      "insert into job_runs (job, started_at, finished_at, ok, detail, host) values ('agents.report', now() - interval '1 hour', now(), true, null, 'h'), ('job:backup', now() - interval '2 hour', now(), false, 'lỗi gọi 0912345678', 'h')",
    );
    await q(
      "insert into llm_usage (agent_id, model, cost_usd, ok) values ('chatbot', 'm', 0.5, true), ('chatbot', 'm', 0.25, false)",
    );
    const d = await hb.collect(pool, { 'agents.report': 192, 'job:backup': 26 });
    const jobs = d.jobs as hb.Jobs;
    expect(jobs.counts).toEqual([
      ['agents.report', 1, 0],
      ['job:backup', 0, 1],
    ]);
    expect(jobs.failed.map((r) => r[0])).toEqual(['job:backup']);
    expect(Object.keys(jobs.last_ok_hours)).toEqual(['agents.report']);
    expect(d.spend).toEqual({ chatbot: 0.75 });
    expect(d.llm_errors).toEqual([['chatbot', 1]]);
    expect(typeof d.pending).toBe('number');
    const g = await hb.gather({ DATABASE_URL: dsn, NODE_ENV: 'test' });
    expect(g.db_ok).toBe(true);
    const md = hb.render(d, '2026-10-11', { caps: { default: 5 }, retention: [] });
    expect(md).not.toContain('0912345678');
  });
});
