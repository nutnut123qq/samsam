import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../db.js';
import { createDbFromTemplate, dropDb, testDbName } from '../testing/db.js';
import G from './__fixtures__/red_alert.golden.json' with { type: 'json' };
import {
  ack,
  backlogCfg,
  cap2Cfg,
  channelKind,
  checkRouting,
  deliverPending,
  ESC_PREFIX,
  escalate,
  isOffHours,
  loadRouting,
  message,
  offHoursCfg,
  openAlerts,
  raiseAlert,
  resolveAddress,
  type Sender,
  smtpSender,
  tierLines,
  tiers,
  validRecipients,
} from './red-alert.js';
import { installFakeDeps } from './testing.js';

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
// Bản TS → dạng golden Python (timedelta = giây, set = list đã sắp, time = 'HH:MM:SS').
const pyCap2 = (c: ReturnType<typeof cap2Cfg>[0]) =>
  c && { after: c.afterMin * 60, recipients: c.recipients };
const pyOff = (o: ReturnType<typeof offHoursCfg>[0]) =>
  o && {
    thu: [...o.thu].sort((a, b) => a - b),
    tu: hm(o.tu),
    den: hm(o.den),
    ngay_nghi: [...o.ngay_nghi].sort(),
    recipients: o.recipients,
  };

describe('red-alert golden (Python)', () => {
  beforeEach(() => {
    installFakeDeps();
  });

  it('lọc người nhận độc lập + cấu hình tồn/cấp 2/ngoài giờ', () => {
    for (const c of G.valid)
      expect(validRecipients(c.raw, c.excl), JSON.stringify(c.excl)).toEqual(c.out.ok);
    for (const c of G.backlog) expect(backlogCfg(c.raw), JSON.stringify(c.raw)).toEqual(c.out.ok);
    for (const c of G.cap2) {
      const [cfg, probs] = cap2Cfg(c.raw, ['tgd']);
      expect([pyCap2(cfg), probs], JSON.stringify(c.raw)).toEqual(c.out.ok);
    }
    for (const c of G.off) {
      const [cfg, probs] = offHoursCfg(c.raw, []);
      expect([pyOff(cfg), probs], JSON.stringify(c.raw)).toEqual(c.out.ok);
    }
    const [ocfg] = offHoursCfg(
      {
        gio_lam_viec: {
          thu: [0, 1, 2, 3, 4],
          tu: '08:00',
          den: '17:30',
          ngay_nghi: ['2026-10-13'],
        },
        nguoi_truc: [{ name: 'Bà C', role: 'bks', channel: 'email:c@x.vn' }],
      },
      [],
    );
    for (const c of G.off_now) expect(isOffHours(ocfg!, new Date(c.now)), c.now).toBe(c.out);
  });

  it('tiers + dòng in; địa chỉ; kênh; thư', () => {
    for (const c of G.tiers) {
      const t = tiers(c.routing);
      expect(t.problems).toEqual(c.tiers.problems);
      expect(tierLines(t)).toEqual(c.lines);
    }
    for (const c of G.addresses)
      expect(resolveAddress(c.channel, G.env), JSON.stringify(c.channel)).toBe(c.out);
    for (const c of G.kinds) expect(channelKind(c.channel)).toBe(c.out);
    for (const c of G.messages) expect(message(c.aid, c.title)).toEqual(c.out);
  });

  it('loadRouting: file thiếu/rỗng/hỏng/BOM/UTF-8 lỗi/{}/_doc → recipients [] + problems', () => {
    const d = mkdtempSync(join(tmpdir(), 'routing-'));
    for (const c of G.routing_files) {
      const p = join(d, `routing_${c.name}.json`);
      if (c.body !== null) writeFileSync(p, Buffer.from(c.body, 'base64'));
      expect(loadRouting(p), c.name).toEqual(c.out.ok);
    }
  });

  it('cấu hình repo: chưa có người nhận → --check-routing exit 1', () => {
    expect(loadRouting().recipients).toEqual([]);
    const [lines, rc] = checkRouting({});
    expect(rc).toBe(1);
    expect(lines.some((l) => l.startsWith('[FAIL] thiếu người nhận độc lập'))).toBe(true);
  });

  it('check-routing: có người nhận nhưng chưa cấu hình SMTP → exit 1; đủ → 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'routing-ok-'));
    const p = join(d, 'r.json');
    writeFileSync(
      p,
      JSON.stringify({ recipients: [{ name: 'Bà A', role: 'phap_che', channel: 'email:$RA_A' }] }),
    );
    expect(checkRouting({}, p)[1]).toBe(1);
    const env = { RED_ALERT_NOTIFY: 'email', SMTP_HOST: 'smtp.vi-du.vn', RA_A: 'a@vi-du.vn' };
    const [lines, rc] = checkRouting(env, p);
    expect(rc).toBe(0);
    expect(lines.at(-1)).toBe('[ok] 1 người nhận có kênh email gửi được');
  });

  it('smtpSender: chỉ bật khi RED_ALERT_NOTIFY=email + SMTP_HOST', () => {
    expect(smtpSender({})).toBeNull();
    expect(smtpSender({ RED_ALERT_NOTIFY: 'email' })).toBeNull();
    expect(smtpSender({ RED_ALERT_NOTIFY: 'zalo', SMTP_HOST: 'h' })).toBeNull();
    expect(typeof smtpSender({ RED_ALERT_NOTIFY: ' EMAIL ', SMTP_HOST: 'h' })).toBe('function');
    expect(() =>
      smtpSender({ RED_ALERT_NOTIFY: 'email', SMTP_HOST: 'h', SMTP_PORT: 'x' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------- DB thật (container test)

const GOOD = [{ name: 'Bà A', role: 'phap_che', channel: 'email:$RA_A' }];
const ENV = { RA_A: 'a@vi-du.vn' };

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('red-alert (DB)', () => {
  const name = testDbName('ops_redalert');
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(() => {
    installFakeDeps({ maskPii: (s) => s.replace(/0(?:[ .]?\d){9,10}/g, '<SĐT>') });
  });

  const sent: string[][] = [];
  const okSender: Sender = async (to, subject) => {
    sent.push([to, subject]);
  };
  const badSender: Sender = async () => {
    throw new Error('ECONNREFUSED');
  };

  async function root(src = 'agents.sales_director', title = 'SLA trễ', detail: unknown = null) {
    await raiseAlert(pool, src, title, detail, { recipients: [] }, null, ENV);
    const r = (await pool.query('select id, ts from red_alerts order by id desc limit 1')).rows[0];
    return [Number(r.id), r.ts as Date] as const;
  }

  it('không người nhận → vẫn ghi + route_error, false; title/detail đã che PII; log cùng tx', async () => {
    const [ok, msg] = await raiseAlert(
      pool,
      'agents.x',
      'Gọi 0912 345 678',
      { s: 'sđt 0912345678', n: 5 },
      {
        recipients: [{ name: 'TGĐ', role: 'tgd', channel: 'email:a@b.vn' }],
      },
    );
    expect(ok).toBe(false);
    expect(msg).toMatch(/thiếu người nhận độc lập/);
    const r = (await pool.query('select * from red_alerts order by id desc limit 1')).rows[0];
    expect([r.title, r.detail, r.recipients, r.route_error]).toEqual([
      'Gọi <SĐT>',
      { s: 'sđt <SĐT>', n: 5 },
      [],
      'thiếu người nhận độc lập (external-dep)',
    ]);
    const log = await pool.query(
      "select detail from agent_action_log where action = 'red_alert_raise' and object_id = $1",
      [String(r.id)],
    );
    expect(log.rows[0].detail).toEqual({ alert_id: Number(r.id), routed: false, n_recipients: 0 });
    await expect(raiseAlert(pool, ' ', 'x')).rejects.toThrow(/source_agent/);
    await expect(raiseAlert(pool, 'a', ' ')).rejects.toThrow(/title/);
  });

  it('có người nhận nhưng gửi lỗi → false "CHƯA thông báo"; nhật ký gửi không lưu địa chỉ', async () => {
    const [ok, msg] = await raiseAlert(
      pool,
      'agents.x',
      'đỏ',
      null,
      { recipients: GOOD },
      badSender,
      ENV,
    );
    expect([ok, msg.includes('CHƯA thông báo')]).toEqual([false, true]);
    const id = Number((await pool.query('select max(id) as id from red_alerts')).rows[0].id);
    const d = (await pool.query('select * from red_alert_deliveries where alert_id = $1', [id]))
      .rows;
    expect(d.map((x) => [x.recipient, x.role, x.channel, x.ok, x.error])).toEqual([
      ['Bà A', 'phap_che', 'email', false, 'gửi lỗi: Error'],
    ]);
    expect(JSON.stringify(d)).not.toContain('a@vi-du.vn');
    const [ok2] = await raiseAlert(
      pool,
      'agents.x',
      'đỏ 2',
      null,
      { recipients: GOOD },
      okSender,
      ENV,
    );
    expect(ok2).toBe(true);
    expect(sent.at(-1)?.[0]).toBe('a@vi-du.vn');
  });

  it('deliverPending: gửi bù, bỏ đã xác nhận, trần lượt gửi', async () => {
    const [aid, ts] = await root('agents.y', 'chưa gửi');
    const now = new Date(ts.getTime() + 60_000);
    let st = await deliverPending(pool, now, { recipients: [] }, okSender, ENV);
    expect(st.failed).toContain(aid);
    st = await deliverPending(pool, now, { recipients: GOOD }, badSender, ENV);
    expect(st.failed).toContain(aid);
    for (let i = 0; i < 5; i++)
      await deliverPending(pool, now, { recipients: GOOD }, badSender, ENV);
    st = await deliverPending(pool, now, { recipients: GOOD }, okSender, ENV);
    expect(st.capped).toContain(aid);
    const [aid2] = await root('agents.y', 'sẽ ack');
    expect((await ack(pool, aid2, 'Người Xác Nhận'))[0]).toBe(true);
    st = await deliverPending(pool, now, { recipients: GOOD }, okSender, ENV);
    expect([...st.sent, ...st.failed, ...st.capped]).not.toContain(aid2);
  });

  it('ack: người thật, id hợp lệ, không ack bản leo thang, không ack 2 lần', async () => {
    const [aid] = await root();
    expect((await ack(pool, aid, ''))[1]).toBe('thiếu tên người xác nhận (--by)');
    expect((await ack(pool, aid, 'agent:x'))[1]).toMatch(/người thật/);
    expect((await ack(pool, aid, 'x'.repeat(101)))[1]).toMatch(/dài quá 100/);
    expect((await ack(pool, 'abc', 'Bà A'))[1]).toBe("id 'abc' không hợp lệ");
    expect((await ack(pool, '9223372036854775808', 'Bà A'))[1]).toMatch(/không hợp lệ/);
    expect((await ack(pool, 99999999, 'Bà A'))[1]).toBe('không tìm thấy cảnh báo #99999999');
    expect(await ack(pool, aid, '  Bà   A ', 'ghi chú')).toEqual([
      true,
      `đã xác nhận cảnh báo #${aid} (người: Bà A)`,
    ]);
    expect((await ack(pool, aid, 'Bà B'))[1]).toBe(`cảnh báo #${aid} đã được xác nhận trước đó`);
  });

  it('escalate: mọi nguồn, đúng 1 lần sau 2 giờ đồng hồ; bản leo thang không ack được', async () => {
    const [a1, ts] = await root('agents.sales_director', 'SLA trễ khối KD');
    const [a2] = await root('agents.ra_kenh', 'S1 tiktok', {
      post_id: 9,
      url: 'https://tin.vi-du/1',
    });
    const [a3] = await root('agents.ra_kenh', 'S1 shopee');
    expect((await ack(pool, a3, 'Người Xác Nhận'))[0]).toBe(true);
    const before = await escalate(
      pool,
      new Date(ts.getTime() + 119 * 60_000),
      { recipients: [] },
      null,
    );
    expect(before.ids).not.toContain(a1);
    const later = new Date(ts.getTime() + 121 * 60_000);
    const st = await escalate(pool, later, { recipients: [] }, null, { env: ENV });
    expect(st.ids).toEqual(expect.arrayContaining([a1, a2]));
    expect(st.ids).not.toContain(a3);
    expect(st.unrouted).toBe(st.escalated);
    const esc = (
      await pool.query(
        "select source_agent, title, detail from red_alerts where detail->>'escalation_of' = any($1) order by id",
        [[String(a1), String(a2)]],
      )
    ).rows;
    expect(esc.map((r) => [r.source_agent, r.detail.escalation_of])).toEqual([
      ['agents.sales_director', a1],
      ['agents.ra_kenh', a2],
    ]);
    expect(esc.every((r) => r.title.startsWith(ESC_PREFIX))).toBe(true);
    expect(esc[1].detail.url).toBe('https://tin.vi-du/1');
    expect('post_id' in esc[1].detail).toBe(false);
    const again = await escalate(
      pool,
      new Date(ts.getTime() + 3 * 86_400_000),
      { recipients: [] },
      null,
    );
    expect(again.ids.filter((x) => [a1, a2].includes(x))).toEqual([]);
    const escId = Number(
      (
        await pool.query("select id from red_alerts where detail->>'escalation_of' = $1", [
          String(a1),
        ])
      ).rows[0].id,
    );
    expect((await ack(pool, escId, 'Bà A'))[1]).toBe(
      `#${escId} là bản leo thang — xác nhận id gốc #${a1}`,
    );
    const open = (await openAlerts(pool, later)).map((x) => x.id);
    expect(open).toContain(a1);
    expect(open).not.toContain(escId);
  });

  it('unique leo thang chung mọi nguồn → dup; dry-run không ghi gì', async () => {
    const [aid, ts] = await root('agents.z', 'gốc z');
    const later = new Date(ts.getTime() + 121 * 60_000);
    const n0 = Number((await pool.query('select count(*)::int as n from red_alerts')).rows[0].n);
    const dry = await escalate(pool, later, { recipients: [] }, null, {
      dryRun: true,
      source: 'agents.z',
    });
    expect(dry.ids).toEqual([aid]);
    expect(Number((await pool.query('select count(*)::int as n from red_alerts')).rows[0].n)).toBe(
      n0,
    );
    await pool.query(
      "insert into red_alerts (source_agent, title, detail) values ('agents.khac', 'đỏ', $1)",
      [JSON.stringify({ escalation_of: aid })],
    );
    await expect(
      pool.query(
        "insert into red_alerts (source_agent, title, detail) values ('agents.z', 'đỏ', $1)",
        [JSON.stringify({ escalation_of: aid })],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cấp 2 theo cấu hình: đúng 1 lần sau N phút kể từ cấp 1; ngoài giờ thêm người trực', async () => {
    const [aid, ts] = await root('agents.cap2', 'gốc cấp 2');
    const routing = {
      recipients: GOOD,
      cap2: {
        sau_phut: 30,
        recipients: [{ name: 'Ông C', role: 'bks', channel: 'email:c@vi-du.vn' }],
      },
      ngoai_gio: {
        gio_lam_viec: { thu: [], tu: '00:00', den: '00:01' },
        nguoi_truc: [{ name: 'Trực', role: 'bks', channel: 'email:t@vi-du.vn' }],
      },
    };
    const t1 = new Date(ts.getTime() + 121 * 60_000);
    const st1 = await escalate(pool, t1, routing, okSender, { source: 'agents.cap2', env: ENV });
    expect([st1.ids, st1.cap2_ids, st1.problems.length > 0]).toEqual([[aid], [], true]);
    const esc1 = (
      await pool.query("select ts from red_alerts where detail->>'escalation_of' = $1", [
        String(aid),
      ])
    ).rows[0];
    const t2 = new Date(esc1.ts.getTime() + 31 * 60_000);
    const routing2 = {
      ...routing,
      ngoai_gio: {
        ...routing.ngoai_gio,
        gio_lam_viec: { thu: [0, 1, 2, 3, 4, 5, 6], tu: '00:00', den: '00:01' },
      },
    };
    const st2 = await escalate(pool, t2, routing2, okSender, { source: 'agents.cap2', env: ENV });
    expect(st2.cap2_ids).toEqual([aid]);
    const c2 = (
      await pool.query(
        "select title, detail, recipients from red_alerts where detail->>'escalation_of' = $1",
        [`${aid}:cap2`],
      )
    ).rows[0];
    expect(c2.detail).toMatchObject({ escalation_root: aid, level: 2 });
    expect(c2.recipients).toEqual(['Ông C', 'Trực']);
    const st3 = await escalate(pool, new Date(t2.getTime() + 3600_000), routing2, okSender, {
      source: 'agents.cap2',
      env: ENV,
    });
    expect(st3.cap2_ids).toEqual([]);
    expect((await ack(pool, aid, 'Bà A'))[0]).toBe(true);
  });
});

// DB riêng: chưa có mốc bật leo thang (tồn tính theo mốc ghi ở lần --escalate thật đầu tiên).
describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('red-alert tồn khi bật leo thang (DB)', () => {
  const name = testDbName('ops_backlog');
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createPool(await createDbFromTemplate(name));
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(name);
  });
  beforeEach(() => {
    installFakeDeps();
  });

  // ts do trigger DB đặt (không lùi giờ được) — test tắt trigger bằng superuser như Python.
  async function aged(n: number, ts: Date, src = 'agents.sales_director'): Promise<number[]> {
    const c = await pool.connect();
    try {
      await c.query('alter table red_alerts disable trigger red_alerts_stamp_ins');
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = await c.query(
          "insert into red_alerts (ts, source_agent, title, detail, recipients, db_role) values ($1, $2, $3, '{}', '{}', session_user) returning id",
          [ts, src, `Sự cố ${i}`],
        );
        ids.push(Number(r.rows[0].id));
      }
      await c.query('alter table red_alerts enable trigger red_alerts_stamp_ins');
      return ids;
    } finally {
      c.release();
    }
  }
  const POL_LEO = {
    recipients: [],
    backlog: {
      chinh_sach: 'leo_thang_dan',
      quyet_boi: 'Người Bên B Giả Lập',
      can_cu: 'Biên bản giả lập',
    },
  };

  it('dry-run trước khi bật: không ghi gì, trang tồn đủ không trùng; chưa quyết → giữ tồn; leo_thang_dan → 50/lần cũ trước', async () => {
    const t0: Date = (await pool.query('select now() as t')).rows[0].t;
    const back = await aged(120, new Date(t0.getTime() - 3 * 3600_000));
    const fresh = await aged(3, new Date(t0.getTime() - 3600_000));
    const count =
      'select (select count(*)::int from red_alerts) a, (select count(*)::int from agent_action_log) b';
    const before = (await pool.query(count)).rows[0];
    const seen: number[] = [];
    let after = 0;
    let st!: Awaited<ReturnType<typeof escalate>>;
    for (let i = 0; i < 5; i++) {
      st = await escalate(pool, new Date(t0.getTime() + 60_000), POL_LEO, null, {
        dryRun: true,
        after,
      });
      expect(st.start).toBeNull();
      seen.push(...st.backlog.page);
      if (st.backlog.next_after === null) break;
      after = st.backlog.next_after;
    }
    expect((await pool.query(count)).rows[0]).toEqual(before);
    // Chưa bật: mọi cảnh báo quá hạn trước "mốc giả định = now" là tồn.
    expect(seen).toEqual(back);
    expect(st.backlog.escalated).toEqual(back.slice(0, 50)); // lần tới: cũ trước

    const now = new Date(t0.getTime() + 61 * 60_000);
    st = await escalate(pool, now, { recipients: [] }, null);
    expect(st.ids).toEqual(fresh);
    expect([st.backlog.total, st.backlog.held, st.backlog.escalated, st.backlog.policy]).toEqual([
      120,
      120,
      [],
      null,
    ]);
    const again = await escalate(
      pool,
      new Date(now.getTime() + 2 * 86_400_000),
      { recipients: [] },
      null,
    );
    expect([again.escalated, again.backlog.held]).toEqual([0, 120]);
    const n = (
      await pool.query(
        "select count(*)::int as n from agent_action_log where action = 'red_alert_escalation_start'",
      )
    ).rows[0].n;
    expect(n).toBe(1);

    const r1 = await escalate(pool, now, POL_LEO, null);
    expect(r1.backlog.escalated).toEqual(back.slice(0, 50));
    const r2 = await escalate(pool, now, POL_LEO, null);
    expect(r2.backlog.escalated).toEqual(back.slice(50, 100));
    expect(r2.backlog.held).toBe(20);
    const off = await escalate(
      pool,
      now,
      { ...POL_LEO, backlog: { ...POL_LEO.backlog, chinh_sach: 'khong_leo_thang' } },
      null,
    );
    expect(off.backlog.escalated).toEqual([]);
  });
});
