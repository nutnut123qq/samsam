import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { resetOpsDeps, setOpsDeps } from '@samsam/core/ops/deps';
import { addDays } from '@samsam/core/ops/period';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { settings } from '@samsam/core/rollout/counters';
import { opsRollout, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { adminQuery, createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLog, SOURCE as GARDEN_SOURCE } from '../garden_zalo/garden.js';
import B from './__fixtures__/bulletin.golden.json' with { type: 'json' };
import H from './__fixtures__/vt_thuhoach.golden.json' with { type: 'json' };
import * as gd from './garden-director.js';
import * as sc from './scenario.js';
import * as vt from './vt-thoitiet.js';
import * as vh from './vt-thuhoach.js';

// Dịch phần DB của tests/test_garden_director.py, test_contract_c02_garden_remind.py, test_docx_p2.py,
// test_v15_p8_outputs.py, test_v15_p10_human_authz.py, test_vt_thoitiet.py, test_contract_finalize.py,
// test_vt_thuhoach.py. DB riêng `samsam_ts_garden_director` tạo lại từ mẫu MỖI ca (mẫu có 3 khoảnh +
// 6 nhật ký mẫu như `_sample_domains()`), xóa khi xong. KHÔNG BAO GIỜ DB `samsam`.

const NAME = 'samsam_ts_garden_director';
const DEV = { NODE_ENV: 'test' }; // chế độ dev (không APPROVAL_ENFORCE)
const SCHED = { gap_days: 14, activities: { tưới: 7, bón: 60 } };
const T0 = new Date('2026-10-01T00:00:00Z');

function cap() {
  const o = { out: [] as string[], err: [] as string[] };
  return {
    o,
    io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s) },
    all: () => [...o.out, ...o.err].join('\n'),
  };
}

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('garden_director (DB thật)', () => {
  let pool: pg.Pool;
  let dsn = '';
  const TMP = mkdtempSync(join(tmpdir(), 'gddb-'));
  const lease = () => async () => ({ db: pool, release: async () => {} });
  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const n = async (sql: string, args: unknown[] = []) =>
    Number(Object.values((await pool.query(sql, args)).rows[0])[0]);
  const actions = (a: string) => n('select count(*) from agent_action_log where action = $1', [a]);
  const log = (plot: string, ts: string, act: string, detail: string, author = 'Bé') =>
    addLog(pool, plot, ts, act, detail, author);
  /** Như schema tạm Python (không có dữ liệu mẫu) — bỏ trigger bằng replica (superuser của DB test). */
  async function clearSamples() {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("delete from plot_logs where source like 'sample:%'");
      await c.query("delete from plots where source like 'sample:%'");
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  beforeAll(() => {
    installFakeDeps({ guardrailCheck: (t) => guardrailCheck(t) });
    settings.forceMode = 'van_hanh';
  });
  beforeEach(async () => {
    await pool?.end();
    await dropDb(NAME);
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn);
    settings.forceMode = 'van_hanh';
  });
  afterAll(async () => {
    await pool?.end();
    await dropDb(NAME);
    resetOpsDeps();
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ hồ sơ khoảnh

  it('gỡ mẫu bị từ chối khi có nhật ký thật đã chain trên khoảnh mẫu', async () => {
    const pre = await gd.samplePrecheck(pool);
    expect([pre.plots, pre.plot_logs > 0, pre.blockers]).toEqual([3, true, []]);
    const [lid] = await log('KV-A01', '2026-10-10T08:00:00Z', 'tưới', 'thật');
    const res = await gd.purgeSample(pool, 'Nguyễn GĐ', DEV);
    expect(res.ok).toBe(false);
    expect(res.blockers).toEqual([
      {
        kind: 'plot_log',
        id: Number(lid),
        plot_id: 'KV-A01',
        day: '2026-10-10',
        source: GARDEN_SOURCE,
      },
    ]);
    expect('detail' in (res.blockers[0] as object)).toBe(false);
    expect((await gd.samplePrecheck(pool)).plot_logs).toBe(pre.plot_logs);
    expect(await actions(gd.PURGE_ACTION)).toBe(0);
  });

  it('gỡ mẫu OK: ghi agent_action_log, chuỗi nguyên vẹn, nạp lại mẫu bị chặn', async () => {
    const pre = await gd.samplePrecheck(pool);
    const res = await gd.purgeSample(pool, '  Nguyễn GĐ  ', DEV);
    expect(res).toEqual({ ok: true, plots: pre.plots, plot_logs: pre.plot_logs, blockers: [] });
    for (const t of ['plots', 'plot_logs'])
      expect(await n(`select count(*) from ${t} where source like 'sample:%'`)).toBe(0);
    expect(
      await q(
        "select actor, object_type, detail from agent_action_log where action = 'garden_sample_purge'",
      ),
    ).toEqual([
      {
        actor: 'Nguyễn GĐ',
        object_type: 'plots',
        detail: { plots: pre.plots, plot_logs: pre.plot_logs },
      },
    ]);
    expect(await n('select count(*) from verify_action_log()')).toBe(0);
    await expect(
      pool.query(
        "insert into plot_logs (plot_id, ts, activity, source) values ('KV-X', now(), 'tưới', 'sample:x')",
      ),
    ).rejects.toThrow(/đã được gỡ/);
  });

  it('CLI --precheck chỉ đọc; --purge-sample có blocker → exit 1, không ghi', async () => {
    const before = await n('select count(*) from agent_action_log');
    const t = cap();
    expect(
      await gd.gardenDirectorMain({ precheck: true }, { connect: lease(), io: t.io, env: DEV }),
    ).toBe(0);
    expect(t.all()).toContain('3 khoảnh');
    expect(await n('select count(*) from agent_action_log')).toBe(before);
    await log('KV-A02', '2026-10-09', 'bón', 'x');
    const t2 = cap();
    expect(
      await gd.gardenDirectorMain(
        { purgeSample: true, by: 'GĐ' },
        { connect: lease(), io: t2.io, env: DEV },
      ),
    ).toBe(1);
    expect(t2.o.out.join('\n')).toContain('[blocker]');
    expect(t2.o.out.join('\n')).toContain('KHÔNG chuyển/sửa được');
    expect(t2.o.out.join('\n')).toContain('--adopt-plot KV-A02');
    expect(await actions(gd.PURGE_ACTION)).toBe(0);
  });

  it('nhận khoảnh gỡ blocker nhật ký đã chain → gỡ mẫu thành công; nhật ký thật + chuỗi nguyên vẹn', async () => {
    const pre = await gd.samplePrecheck(pool);
    const [lid] = await log('KV-A01', '2026-10-10T08:00:00Z', 'tưới', 'thật');
    await pool.query(
      "insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author) values ($1, 'jpg', 9, 'KV-B01', '2026-10-11', 'Bé')",
      ['e'.repeat(64)],
    );
    expect(new Set((await gd.purgeSample(pool, 'GĐ', DEV)).blockers.map((b) => b.kind))).toEqual(
      new Set(['plot_log', 'garden_media']),
    );
    expect(await gd.adoptPlot(pool, ' KV-A01 ', '  Nguyễn GĐ ', DEV)).toEqual({
      ok: true,
      plot_id: 'KV-A01',
      from_source: 'sample:sample_plots.jsonl',
    });
    expect(
      await q(
        'select actor, object_type, object_id, detail from agent_action_log where action = $1 order by id',
        [gd.ADOPT_ACTION],
      ),
    ).toEqual([
      {
        actor: 'Nguyễn GĐ',
        object_type: 'plots',
        object_id: 'KV-A01',
        detail: { from_source: 'sample:sample_plots.jsonl' },
      },
    ]);
    await pool.query("update garden_media set plot_id = 'KV-A01'"); // blocker ảnh: chuyển sang khoảnh thật
    expect((await gd.samplePrecheck(pool)).blockers).toEqual([]);
    const res = await gd.purgeSample(pool, 'Nguyễn GĐ', DEV);
    expect([res.ok, res.plots]).toEqual([true, pre.plots - 1]);
    expect(await q('select id, source from plot_logs')).toEqual([
      { id: String(lid), source: GARDEN_SOURCE },
    ]);
    expect(await q('select id, problem from verify_plot_logs()')).toEqual([]);
    expect(await n('select count(*) from verify_action_log()')).toBe(0);
  });

  it('nhận khoảnh: không tồn tại / không phải mẫu / thiếu --by → từ chối, không ghi', async () => {
    await pool.query("insert into plots (id, source) values ('KV-M1', 'manual')");
    expect((await gd.adoptPlot(pool, 'KV-ZZ', 'GĐ', DEV)).ok).toBe(false);
    expect(await gd.adoptPlot(pool, 'KV-M1', 'GĐ', DEV)).toEqual({
      ok: false,
      reason: 'khoảnh KV-M1 không phải khoảnh mẫu',
    });
    for (const by of [null, '', '  '])
      await expect(gd.adoptPlot(pool, 'KV-A01', by, DEV)).rejects.toThrow(/--by/);
    expect(await actions(gd.ADOPT_ACTION)).toBe(0);
    expect(await q("select source from plots where id = 'KV-M1'")).toEqual([{ source: 'manual' }]);
  });

  it('CLI --adopt-plot: khoảnh lạ exit 1; khoảnh mẫu exit 0 rồi --purge-sample exit 0', async () => {
    await log('KV-A02', '2026-10-09', 'bón', 'x');
    const t = cap();
    expect(
      await gd.gardenDirectorMain(
        { adoptPlot: 'KV-ZZ', by: 'GĐ' },
        { connect: lease(), io: t.io, env: DEV },
      ),
    ).toBe(1);
    expect(
      await gd.gardenDirectorMain(
        { adoptPlot: 'KV-A02', by: 'GĐ' },
        { connect: lease(), io: t.io, env: DEV },
      ),
    ).toBe(0);
    expect(t.o.out.join('\n')).toContain('giá trị MẪU');
    expect(
      await gd.gardenDirectorMain(
        { purgeSample: true, by: 'GĐ' },
        { connect: lease(), io: t.io, env: DEV },
      ),
    ).toBe(0);
  });

  // ------------------------------------------------------------ bản tin tuần

  it('bản tin khớp Python y hệt (cùng trạng thái DB) + riêng tư + tất định', async () => {
    expect(await gd.buildBulletin(pool, '2026-10-12', 7, null)).toBe(B.empty_default);
    for (const s of B.seed) await pool.query(s);
    const a = await gd.buildBulletin(pool, '2026-10-12', 7, SCHED);
    expect(a).toBe(B.main);
    expect(await gd.buildBulletin(pool, new Date('2026-10-12T05:00:00Z'), 7, SCHED)).toBe(a);
    expect(await gd.buildBulletin(pool, '2026-10-08', 3, { gap_days: 3 })).toBe(B.days3);
    expect(await gd.buildBulletin(pool, '2026-10-12', 7, null)).toBe(B.default_sched);
    expect(await gd.buildBulletin(pool, '2027-02-01', 1, { gap_days: 14, activities: {} })).toBe(
      B.far,
    );
    expect(await gd.samplePrecheck(pool)).toEqual(B.precheck);
    for (let i = 1; i <= 6; i++) expect(a).toMatch(new RegExp(`^## ${i}\\. `, 'm'));
    for (const bad of [
      'Trà My',
      'Nam Giang',
      'Nguyễn Văn Bí',
      '0901234567',
      'a.b@vd.vn',
      'area_m2',
      'location',
    ]) {
      expect(a).not.toContain(bad);
    }
    const sec5 = a.split('## 5.')[1]?.split('## 6.')[0] as string;
    expect(sec5).toContain('rệp');
    expect(sec5).not.toContain('định kỳ'); // 'kiểm tra sâu bệnh' (activity) không bị cờ
    const line = a.split('\n').find((l) => l.startsWith('- #') && l.includes('xxx')) as string;
    expect(Array.from(line.split(': ').slice(1).join(': ')).length).toBeLessThanOrEqual(
      gd.DETAIL_MAX + 1,
    );
  });

  it('số trong bản tin tái lập được bằng SQL đối chứng', async () => {
    for (const s of B.seed.slice(0, 3)) await pool.query(s);
    const text = await gd.buildBulletin(pool, '2026-10-12', 7, SCHED);
    const sqls = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].flatMap((m) =>
      (m[1] as string)
        .trim()
        .split(';\n')
        .map((s) => s.trim().replace(/;$/, '')),
    );
    expect(sqls.length).toBe(9);
    const arr = async (s: string) =>
      (await pool.query({ text: s, rowMode: 'array' })).rows as unknown[][];
    expect(await arr(sqls[0] as string)).toEqual([]);
    expect(text).toContain(`OK — ${(await arr(sqls[1] as string))[0]?.[0]} nhật ký đã chain`);
    const [sp, sl] = (await arr(sqls[2] as string))[0] as string[];
    expect(text).toContain(`${sp} khoảnh mẫu, ${sl} nhật ký mẫu`);
    const plots = (await arr(sqls[3] as string)).map((r) => r[0] as string);
    const lastAny = new Map(
      (await arr(sqls[4] as string)).map((r) => [r[0] as string, r[1] as Date]),
    );
    const lastBy = new Map(
      (await arr(sqls[5] as string)).map((r) => [
        gd.actKey(r[0] as string, r[1] as string),
        r[2] as Date,
      ]),
    );
    const rems = gd.reminders(plots, lastAny, lastBy, SCHED, new Date('2026-10-12T17:00:00Z'));
    expect(rems.length).toBeGreaterThan(0);
    for (const r of rems) expect(text).toContain(`- ${gd.fmtReminder(r)}`);
    for (const [p, mau, that] of await arr(sqls[6] as string))
      expect(text).toContain(`| ${p} | ${that} | ${mau} |`);
    for (const r of await arr(sqls[7] as string))
      if (gd.logFlags(r[4]).length) expect(text).toContain(`#${r[0]} `);
    expect(await arr(sqls[8] as string)).toEqual([['KV-A01', '1']]);
  });

  it('chuỗi bị sửa ngoài hệ thống → CẢNH BÁO trong bản tin; --verify exit 1', async () => {
    for (const s of B.seed.slice(0, 2)) await pool.query(s);
    const t = cap();
    expect(await gd.gardenDirectorMain({ verify: true }, { connect: lease(), io: t.io })).toBe(0);
    expect(await gd.gardenDirectorMain({ remind: true }, { connect: lease(), io: t.io })).toBe(0);
    expect(t.o.out.join('\n')).toContain('[verify] OK');
    expect(t.o.out.join('\n')).toContain('KV-B01');
    const lid = await n('select max(id) from plot_logs where row_hash is not null');
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update plot_logs set detail = 'sửa' where id = $1", [lid]);
      const text = await gd.buildBulletin(c, '2026-10-12', 7, SCHED);
      expect(text).toContain(`#${lid} (row_hash)`);
      expect(text).toContain('CẢNH BÁO');
      await c.query(
        'delete from plot_logs where id = (select min(id) from plot_logs where row_hash is not null)',
      );
      const t2 = cap();
      expect(
        await gd.gardenDirectorMain(
          { verify: true },
          { connect: async () => ({ db: c, release: async () => {} }), io: t2.io },
        ),
      ).toBe(1);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('CLI --bulletin ghi đúng 1 tệp, LF, không vị trí', async () => {
    for (const s of B.seed.slice(0, 3)) await pool.query(s);
    const out = mkdtempSync(join(TMP, 'b-'));
    const t = cap();
    expect(
      await gd.gardenDirectorMain(
        { bulletin: true, until: '2026-10-12', outDir: out },
        { connect: lease(), io: t.io },
      ),
    ).toBe(0);
    expect(readdirSync(out)).toEqual(['garden-week-2026-10-12.md']);
    expect(t.o.out.join('\n')).toContain(join(out, 'garden-week-2026-10-12.md'));
    const body = readFileSync(join(out, 'garden-week-2026-10-12.md'), 'utf8');
    expect(body).not.toContain('Trà My');
    expect(body).not.toContain('\r\n');
  });

  it('nhật ký ghi bù (ts tuần trước, created_at trong kỳ) vào mục 4/5 với nhãn (ghi bù)', async () => {
    const now = (await q('select now() as t'))[0].t as Date;
    const until = gd.coerceUntil(now);
    const [lid] = await log(
      'KV-A02',
      new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      'ghi nhận',
      'phát hiện rệp ở luống 3',
    );
    expect(lid).not.toBeNull();
    const text = await gd.buildBulletin(pool, until, 7, SCHED);
    const sec4 = text.split('## 4.')[1]?.split('## 5.')[0] as string;
    const sec5 = text.split('## 5.')[1]?.split('## 6.')[0] as string;
    const line = sec5.split('\n').find((l) => l.startsWith(`- #${lid} `)) as string;
    expect(line).toContain('(ghi bù)');
    expect(line).toContain('rệp');
    expect(sec4).toContain('| KV-A02 | 1 |');
  });

  it('nhật ký ghi SAU bản tin mặc định (hôm qua) vào bản tin tuần sau', async () => {
    const now = (await q('select now() as t'))[0].t as Date;
    const until = gd.defaultUntil(now);
    const a = await gd.buildBulletin(pool, until, 7, SCHED);
    const [lid] = await log('KV-A02', now.toISOString(), 'ghi nhận', 'phát hiện rệp ở luống 3');
    const b = await gd.buildBulletin(pool, addDays(until, 7), 7, SCHED);
    expect(a).not.toContain(`- #${lid} `);
    const sec5 = b.split('## 5.')[1]?.split('## 6.')[0] as string;
    expect(sec5.split('\n').some((l) => l.startsWith(`- #${lid} `) && l.includes('rệp'))).toBe(
      true,
    );
  });

  it('bulletinSample: kỳ có nhật ký MẪU → true (P8.4)', async () => {
    await pool.query("insert into plots (id, source) values ('P8-K1', 'sample:p8')");
    expect(await gd.bulletinSample(pool, '2030-01-09', 7)).toBe(false);
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('P8-K1', '2030-01-08T17:00:00Z', 'tưới', 'x', 'NV', 'sample:p8')",
    );
    expect(await gd.bulletinSample(pool, '2030-01-09', 7)).toBe(true);
  });

  // ------------------------------------------------------------ C02: nhắc người phụ trách

  const rem = (
    plot: string,
    last: Date | null = null,
    days: number | null = null,
  ): gd.Reminder => ({
    type: last === null ? 'no-logs' : 'gap',
    plot,
    activity: null,
    last_ts: last,
    days,
  });
  const rows = () =>
    q(
      'select plot_id, dot_key, ma_nv, status, kenh, closed_at is not null as closed from garden_reminders order by plot_id, dot_key',
    );
  const sent = () =>
    q(
      "select object_id, payload from approval_queue where object_type = 'plot_log_gap' order by id",
    );
  const MANUAL: gd.RemindCfg = { kenh: 'thu_cong', leo_thang_sau_ngay: 3 };

  it('đúng người phụ trách, không nhân bản, nhật ký mới đóng đợt', async () => {
    const owners = new Map([
      ['K1', ['VT-1']],
      ['K2', ['VT-2']],
    ]);
    const rems = [rem('K1', T0, 20), rem('K2', T0, 15), rem('K3')];
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    expect(await rows()).toEqual([
      {
        plot_id: 'K1',
        dot_key: '20261001T000000',
        ma_nv: 'VT-1',
        status: 'cho_gui',
        kenh: 'thu_cong',
        closed: false,
      },
      {
        plot_id: 'K2',
        dot_key: '20261001T000000',
        ma_nv: 'VT-2',
        status: 'cho_gui',
        kenh: 'thu_cong',
        closed: false,
      },
      {
        plot_id: 'K3',
        dot_key: 'none',
        ma_nv: null,
        status: 'khong_nguoi_nhan',
        kenh: 'thu_cong',
        closed: false,
      },
    ]);
    const s = await sent();
    expect(s.map((r) => r.object_id)).toEqual(['gap:K3:none']);
    expect(s[0]?.payload).toContain('CHƯA gán người');
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    expect((await rows()).length).toBe(3);
    expect((await sent()).length).toBe(1);
    await gd.escalateGaps(pool, [rem('K2', T0, 15), rem('K3')], { gap_days: 14 }, owners, MANUAL);
    expect((await rows()).map((r) => r.closed)).toEqual([true, false, false]);
    expect(new Set((await gd.openReminders(pool)).map((r) => r.plot_id))).toEqual(
      new Set(['K2', 'K3']),
    );
  });

  it('kênh thủ công: đã nhắc quá hạn mà vẫn trống → báo GĐ 1 lần/đợt', async () => {
    const rems = [rem('K1', T0, 30)];
    const owners = new Map([['K1', ['VT-1']]]);
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    expect(await sent()).toEqual([]);
    const rid = (await q('select id from garden_reminders'))[0].id;
    await pool.query("select garden_reminder_done_human($1, 'Tổ Trưởng A')", [rid]);
    await pool.query(
      "update garden_reminders set reminded_at = now() - interval '1 day' where id = $1",
      [rid],
    );
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    expect(await sent()).toEqual([]);
    await pool.query(
      "update garden_reminders set reminded_at = now() - interval '4 days' where id = $1",
      [rid],
    );
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    const s = await sent();
    expect(s.length).toBe(1);
    expect(s[0]?.payload).toContain('đã nhắc người phụ trách');
  });

  it('kênh thủ công: quá hạn chưa ai đánh dấu → báo GĐ', async () => {
    const rems = [rem('K1', T0, 30)];
    const owners = new Map([['K1', ['VT-1']]]);
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    expect(await sent()).toEqual([]);
    await pool.query("update garden_reminders set created_at = now() - interval '4 days'");
    await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, MANUAL);
    const s = await sent();
    expect(s.length).toBe(1);
    expect(s[0]?.payload).toContain('chưa ai đánh dấu');
  });

  it('"đã nhắc" chỉ người ghi qua function; agent/agent_writer bị chặn; lần 2 → false', async () => {
    await gd.syncReminders(pool, [rem('K1', T0, 20)], new Map([['K1', ['VT-1']]]), {
      kenh: 'thu_cong',
      leo_thang_sau_ngay: null,
    });
    const rid = (await q('select id from garden_reminders'))[0].id;
    await expect(
      pool.query("select garden_reminder_done_human($1, 'agent:x')", [rid]),
    ).rejects.toMatchObject({ code: '42501' });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role agent_writer');
      await expect(
        c.query(
          "update garden_reminders set reminded_at = now(), reminded_by = 'x' where id = $1",
          [rid],
        ),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('rollback');
    } finally {
      c.release();
    }
    const t = cap();
    expect(
      await gd.gardenDirectorMain(
        { markReminded: String(rid), by: 'Tổ Trưởng A' },
        { connect: lease(), io: t.io, env: DEV },
      ),
    ).toBe(0);
    expect(t.o.out.join('\n')).toContain(`[ok] #${rid} đã nhắc — Tổ Trưởng A`);
    expect(await q('select reminded_by from garden_reminders where id = $1', [rid])).toEqual([
      { reminded_by: 'Tổ Trưởng A' },
    ]);
    expect((await q("select garden_reminder_done_human($1, 'B') as ok", [rid]))[0].ok).toBe(false);
    const t2 = cap();
    expect(
      await gd.gardenDirectorMain(
        { markReminded: String(rid), by: 'B' },
        { connect: lease(), io: t2.io, env: DEV },
      ),
    ).toBe(1);
    expect(t2.o.err.join('\n')).toContain('không ở trạng thái chờ nhắc thủ công');
    const t3 = cap();
    expect(
      await gd.gardenDirectorMain(
        { markReminded: String(rid), by: 'agent:x' },
        { connect: lease(), io: t3.io, env: DEV },
      ),
    ).toBe(1);
  });

  it('chưa chọn kênh → cho_kenh, không ai được nhắc, báo GĐ kèm lý do', async () => {
    await gd.escalateGaps(pool, [rem('K1')], { gap_days: 14 }, new Map([['K1', ['VT-1']]]), {
      kenh: null,
      leo_thang_sau_ngay: null,
    });
    expect((await rows())[0]?.status).toBe('cho_kenh');
    expect(await n('select count(*) from garden_reminders where reminded_at is not null')).toBe(0);
    const rid = (await q('select id from garden_reminders'))[0].id;
    expect((await q("select garden_reminder_done_human($1, 'A') as ok", [rid]))[0].ok).toBe(false);
    expect((await sent())[0]?.payload).toContain('CHƯA chọn kênh');
  });

  it('docx P2: kênh null → khoảnh VẪN trống (chưa có / ≥ 2×gap) báo GĐ ngay; overdue không vào sổ', async () => {
    const t = new Date('2026-10-01T00:00:00Z');
    const rems: gd.Reminder[] = [
      rem('K1'),
      rem('K2', t, 20),
      rem('K3', t, 30),
      { type: 'overdue', plot: 'K4', activity: 'tưới', last_ts: t, days: 40 },
    ];
    const owners = new Map([
      ['K1', ['VT-1']],
      ['K2', ['VT-1']],
      ['K3', ['VT-2']],
    ]);
    expect(
      await gd.escalateGaps(pool, rems, { gap_days: 14 }, owners, {
        kenh: null,
        leo_thang_sau_ngay: null,
      }),
    ).toBe(2);
    const s = await q(
      'select block, object_type, object_id, created_by, payload from approval_queue order by id',
    );
    expect(s.map((r) => r.object_id)).toEqual(['gap:K1:none', 'gap:K3:20261001T000000']);
    expect(
      s.every(
        (r) =>
          r.block === 'farming' &&
          r.object_type === 'plot_log_gap' &&
          r.created_by === gd.GAP_AGENT,
      ),
    ).toBe(true);
    expect(s.every((r) => String(r.payload).includes('CHƯA chọn kênh'))).toBe(true);
    expect(await q('select plot_id, status from garden_reminders order by 1')).toEqual([
      { plot_id: 'K1', status: 'cho_kenh' },
      { plot_id: 'K2', status: 'cho_kenh' },
      { plot_id: 'K3', status: 'cho_kenh' },
    ]);
  });

  it('khoảnh mẫu → is_sample; cổng farming-02.1 TẮT → RolloutBlocked, 0 dòng', async () => {
    await pool.query("insert into plots (id, location, source) values ('KM', 'x', 'sample:test')");
    await gd.syncReminders(pool, [rem('KM')], new Map(), { kenh: null, leo_thang_sau_ngay: null });
    expect((await q('select is_sample from garden_reminders'))[0].is_sample).toBe(true);
    await pool.query('delete from garden_reminders');
    settings.forceMode = 'tat';
    await expect(
      gd.syncReminders(pool, [rem('K1')], new Map(), { kenh: null, leo_thang_sau_ngay: null }),
    ).rejects.toBeInstanceOf(RolloutBlocked);
    const t = cap();
    expect(
      await gd.gardenDirectorMain(
        { remind: true, submit: true },
        { connect: lease(), io: t.io, owners: () => new Map() },
      ),
    ).toBe(2);
    expect(t.o.err.join('\n')).toContain('farming-02.1');
    expect(await n('select count(*) from garden_reminders')).toBe(0);
  });

  it('CLI --remind --submit (kênh repo = null) → [blocked] + báo GĐ; --reminders liệt kê', async () => {
    const t = cap();
    expect(
      await gd.gardenDirectorMain(
        { remind: true, submit: true },
        { connect: lease(), io: t.io, owners: () => new Map([['KV-A01', ['VT-1']]]) },
      ),
    ).toBe(0);
    const out = t.o.out.join('\n');
    expect(out).toContain('[blocked] chưa chọn kênh');
    expect(out).toMatch(/\[remind\] báo GĐ vùng trồng: \d+ mục mới/);
    const t2 = cap();
    expect(await gd.gardenDirectorMain({ reminders: true }, { connect: lease(), io: t2.io })).toBe(
      0,
    );
    expect(t2.o.out.join('\n')).toMatch(/\[reminders\] \d+ đợt đang mở/);
  });

  // ------------------------------------------------------------ quyết định người qua *_human

  describe('login người riêng (app_human + human_logins)', () => {
    const tag = `${process.pid}_${randomBytes(3).toString('hex')}`;
    const L = {
      farm: [`t_gd_farm_${tag}`, randomBytes(12).toString('hex'), 'GĐ Vùng Trồng Giả', '{farming}'],
      sales: [`t_gd_sales_${tag}`, randomBytes(12).toString('hex'), 'Bán Hàng Giả', '{sales}'],
    } as const;
    const asUrl = (k: keyof typeof L) => {
      const u = new URL(dsn);
      u.username = L[k][0];
      u.password = L[k][1];
      return u.toString();
    };
    beforeAll(async () => {
      for (const [login, pw] of Object.values(L)) {
        await adminQuery(`drop role if exists ${login}`);
        await adminQuery(
          `create role ${login} login password '${pw}' nosuperuser nocreatedb nocreaterole in role app_human`,
        );
      }
    });
    afterAll(async () => {
      for (const [login] of Object.values(L)) await adminQuery(`drop role if exists ${login}`);
    });
    beforeEach(async () => {
      for (const [login, , person, blocks] of Object.values(L)) {
        await pool.query(
          "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, $3, 'test-ts')",
          [login, person, blocks],
        );
      }
    });
    const run = (k: keyof typeof L, o: gd.GardenDirectorOpts) => {
      const t = cap();
      return gd
        .gardenDirectorMain(o, { io: t.io, env: { NODE_ENV: 'test', DATABASE_URL: asUrl(k) } })
        .then((rc) => [rc, t.all()] as const);
    };

    it('nhận khoảnh / gỡ mẫu: người khối khác bị DB từ chối; GĐ vùng trồng của login ghi được', async () => {
      await pool.query(
        "insert into plots (id, source) values ('K-P10A', 'sample:p10'), ('K-P10B', 'sample:p10')",
      );
      const [rc1, out1] = await run('sales', { adoptPlot: 'K-P10A', by: L.sales[2] });
      expect(rc1, out1).toBe(1);
      expect(out1).toContain('DB từ chối');
      const [rc2, out2] = await run('farm', { adoptPlot: 'K-P10A', by: L.farm[2] });
      expect(rc2, out2).toBe(0);
      expect(await q("select source from plots where id = 'K-P10A'")).toEqual([
        { source: 'manual:adopted' },
      ]);
      const [rc3, out3] = await run('farm', { purgeSample: true, by: 'Người Khác' });
      expect(rc3, out3).toBe(1); // --by không phải người của login
      const [rc4, out4] = await run('farm', { purgeSample: true, by: L.farm[2] });
      expect(rc4, out4).toBe(0);
      expect(await q("select id from plots where source like 'sample:%'")).toEqual([]);
      expect(
        await q("select actor from agent_action_log where action = 'garden_sample_purge'"),
      ).toEqual([{ actor: L.farm[2] }]);
    });

    it('đánh dấu đã nhắc bằng login người: đúng người ghi; người khác → từ chối', async () => {
      await gd.syncReminders(pool, [rem('K1', T0, 20)], new Map([['K1', ['VT-1']]]), {
        kenh: 'thu_cong',
        leo_thang_sau_ngay: null,
      });
      const rid = String((await q('select id from garden_reminders'))[0].id);
      const [rc1] = await run('farm', { markReminded: rid, by: L.sales[2] });
      expect(rc1).toBe(1);
      const [rc2, out2] = await run('farm', { markReminded: rid, by: L.farm[2] });
      expect(rc2, out2).toBe(0);
      expect(await q('select reminded_by from garden_reminders')).toEqual([
        { reminded_by: L.farm[2] },
      ]);
    });
  });

  it('chế độ thực, approvers khối farming rỗng → cliGate chặn TRƯỚC khi ghi + authz_denied', async () => {
    const env = { NODE_ENV: 'test', APPROVAL_ENFORCE: '1' };
    for (const [o, oid] of [
      [{ purgeSample: true, by: 'Tên Tùy Ý' }, 'sample'],
      [{ adoptPlot: 'K-01', by: 'Tên Tùy Ý' }, 'K-01'],
    ] as const) {
      const before = await n(
        "select count(*) from agent_action_log where action = 'authz_denied' and object_type = 'plots' and object_id = $1",
        [oid],
      );
      const t = cap();
      expect(await gd.gardenDirectorMain(o, { connect: lease(), io: t.io, env })).toBe(1);
      expect(t.all()).toContain('Bên B ủy quyền');
      expect(
        await n(
          "select count(*) from agent_action_log where action = 'authz_denied' and object_type = 'plots' and object_id = $1",
          [oid],
        ),
      ).toBe(before + 1);
    }
    expect((await gd.samplePrecheck(pool)).plots).toBe(3);
  });

  // ------------------------------------------------------------ vt_thoitiet

  const NOWV = new Date('2026-10-14T02:00:00Z'); // 09:00 VN
  async function seedVt() {
    await clearSamples();
    for (const pid of ['KV-A01', 'KV-A02', 'KV-B01', 'KV-Z09']) {
      await pool.query(
        "insert into plots (id, location, area_m2, source) values ($1, 'Toạ độ 15.123,107.987', 500, 'test-v102')",
        [pid],
      );
    }
    const ins =
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ($1, $2, $3, $4, 'Người Ghi Giả', 'test-v102')";
    await pool.query(ins, [
      'KV-A01',
      new Date(NOWV.getTime() - 86_400_000),
      'kiểm tra sâu bệnh',
      'bình thường',
    ]);
    await pool.query(ins, [
      'KV-A02',
      new Date(NOWV.getTime() - 2 * 86_400_000),
      'kiểm tra sâu bệnh',
      'phát hiện sâu bệnh ở góc khoảnh',
    ]);
    await pool.query(ins, [
      'KV-B01',
      new Date(NOWV.getTime() - 30 * 86_400_000),
      'tưới',
      'phát hiện rệp',
    ]); // ngoài 7 ngày
  }
  const vtQueue = () =>
    q(
      'select block, object_type, object_id, status, risk, created_by, payload from approval_queue order by id',
    );
  const csv = (lines: string[]) => {
    const p = join(TMP, `w${randomBytes(4).toString('hex')}.csv`);
    writeFileSync(p, `${[vt.CSV_HEADER.join(','), ...lines].join('\n')}\n`);
    return p;
  };

  it('pestFlags: CHỈ detail, cửa sổ flag_days, giữ cụm dài', async () => {
    await seedVt();
    expect(await vt.pestFlags(pool, NOWV, 7)).toEqual([
      { plot: 'KV-A02', day: '2026-10-12', flag: 'sâu bệnh' },
    ]);
  });

  it('digest --submit → 1 mục PENDING farming/weather_digest; chạy lại → [skipped]; payload = tệp, không rò rỉ', async () => {
    await seedVt();
    const rd = mkdtempSync(join(TMP, 'r-'));
    const p = csv(['vung-a,2026-10-15,120,10,20', 'vung-b,2026-10-15,10,4.9,15']);
    const opts = { digest: true, fromCsv: p, date: '2026-10-14', submit: true };
    const t = cap();
    expect(
      await vt.vtThoitietMain(opts, { connect: lease(), io: t.io, reportsDir: rd }),
      t.all(),
    ).toBe(0);
    const qq = await vtQueue();
    expect(qq.length).toBe(1);
    expect(qq[0]).toMatchObject({
      block: 'farming',
      object_type: 'weather_digest',
      object_id: 'vt-digest:2026-10-14',
      status: 'pending',
      risk: 'medium',
      created_by: 'agent:VT',
    });
    const payload = qq[0]?.payload as string;
    expect(payload).toContain("khoảnh KV-A02: ghi nhận 'sâu bệnh'");
    expect(payload).not.toContain('KV-A01: ghi nhận');
    for (const leak of ['15.123', '107.987', 'Toạ độ', 'Người Ghi Giả', '500'])
      expect(payload).not.toContain(leak);
    expect(payload).toContain('KV-Z09: chưa gán vùng');
    expect(readFileSync(join(rd, 'vt-canh-bao-2026-10-14.md'), 'utf8')).toBe(payload);
    const t2 = cap();
    expect(await vt.vtThoitietMain(opts, { connect: lease(), io: t2.io, reportsDir: rd })).toBe(0);
    expect(t2.o.out.join('\n')).toContain('[skipped]');
    expect((await vtQueue()).length).toBe(1);
  });

  it('không cảnh báo, không cờ → không đẩy hàng duyệt', async () => {
    await clearSamples();
    await pool.query("insert into plots (id, source) values ('KV-A01', 't')");
    const t = cap();
    const rd = mkdtempSync(join(TMP, 'r-'));
    expect(
      await vt.vtThoitietMain(
        {
          digest: true,
          fromCsv: csv(['vung-a,2026-10-15,50,5,20']),
          date: '2026-10-14',
          submit: true,
        },
        { connect: lease(), io: t.io, reportsDir: rd },
      ),
    ).toBe(0);
    expect(await vtQueue()).toEqual([]);
    expect(t.o.out.join('\n')).toContain('không đẩy hàng duyệt');
  });

  it('--pests --submit (không chờ nguồn dự báo) → farming/pest_alert; chạy lại → [skipped]', async () => {
    await clearSamples();
    await pool.query("insert into plots (id, source) values ('KV-P1', 'test-p')");
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('KV-P1', $1, 'tưới', 'phát hiện sâu bệnh ở góc khoảnh', 'Người Ghi', 'test-p')",
      [new Date('2026-10-13T02:00:00Z')],
    );
    const t = cap();
    expect(
      await vt.vtThoitietMain(
        { digest: true, fetch: true, submit: true, date: '2026-10-14' },
        { connect: lease(), io: t.io },
      ),
    ).toBe(2);
    expect(
      await vt.vtThoitietMain(
        { pests: true, submit: true, date: '2026-10-14' },
        { connect: lease(), io: t.io },
      ),
    ).toBe(0);
    const qq = await q('select block, object_type, object_id, payload from approval_queue');
    expect(qq.map((r) => [r.block, r.object_type, r.object_id])).toEqual([
      ['farming', 'pest_alert', 'vt-pest:2026-10-14'],
    ]);
    expect(qq[0]?.payload).not.toContain('Người Ghi');
    expect(qq[0]?.payload).toContain('KV-P1');
    const t2 = cap();
    expect(
      await vt.vtThoitietMain(
        { pests: true, submit: true, date: '2026-10-14' },
        { connect: lease(), io: t2.io },
      ),
    ).toBe(0);
    expect(t2.o.out.join('\n')).toContain('[skipped]');
    expect(await n('select count(*) from approval_queue')).toBe(1);
  });

  // ------------------------------------------------------------ cổng triển khai THẬT theo tính năng

  /** Sổ `feature_rollout` của DB test: `fid` TẮT, tính năng chưa vào sổ = chạy thử (vẫn sinh). */
  async function withOff(fid: string, body: () => Promise<void>) {
    await pool.query(
      "insert into feature_rollout (feature_id, stage, updated_by) values ($1, 'tat', 'test-ts')",
      [fid],
    );
    setOpsDeps({ rollout: opsRollout });
    settings.forceMode = null;
    try {
      await body();
    } finally {
      installFakeDeps({ guardrailCheck: (t) => guardrailCheck(t) });
      settings.forceMode = 'van_hanh';
    }
  }

  it('farming-02.2 TẮT: --remind --submit → sổ nhắc vẫn ghi, báo GĐ bị chặn → exit 2, 0 mục', async () => {
    await clearSamples();
    await pool.query("insert into plots (id, status, source) values ('K1', 'active', 't')");
    await withOff('farming-02.2', async () => {
      const t = cap();
      expect(
        await gd.gardenDirectorMain(
          { remind: true, submit: true },
          { connect: lease(), io: t.io, owners: () => new Map([['K1', ['VT-1']]]) },
        ),
      ).toBe(2);
      expect(t.o.err.join('\n')).toContain('farming-02.2');
    });
    expect(await q('select plot_id, status from garden_reminders')).toEqual([
      { plot_id: 'K1', status: 'cho_kenh' },
    ]);
    expect(await n('select count(*) from approval_queue')).toBe(0);
  });

  it('farming-05.3 TẮT: digest --submit → tệp vẫn ghi (vt-canh-bao không có tiền tố báo cáo), hàng duyệt chặn', async () => {
    // Python: write_report không chặn (farming-05.3 chỉ có nguồn approval_queue) rồi RolloutBlocked
    // lọt khỏi main (traceback). TS: lọt tới cliEntry → [rollout] exit 2 (đã ghi ở header).
    await seedVt();
    const rd = mkdtempSync(join(TMP, 'r-'));
    const p = csv(['vung-a,2026-10-15,120,10,20']);
    await withOff('farming-05.3', async () => {
      await expect(
        vt.vtThoitietMain(
          { digest: true, fromCsv: p, date: '2026-10-14', submit: true },
          { connect: lease(), io: cap().io, reportsDir: rd },
        ),
      ).rejects.toBeInstanceOf(RolloutBlocked);
    });
    expect(readdirSync(rd)).toEqual(['vt-canh-bao-2026-10-14.md']);
    expect(await vtQueue()).toEqual([]);
  });

  it('farming-05.4 TẮT: --pests --submit → [err] (RolloutBlocked) exit 1, 0 mục', async () => {
    await clearSamples();
    await pool.query("insert into plots (id, source) values ('KV-P1', 'test-p')");
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, detail, author, source) values ('KV-P1', $1, 'tưới', 'phát hiện sâu bệnh', 'Người Ghi', 'test-p')",
      [new Date('2026-10-13T02:00:00Z')],
    );
    await withOff('farming-05.4', async () => {
      const t = cap();
      expect(
        await vt.vtThoitietMain(
          { pests: true, submit: true, date: '2026-10-14' },
          { connect: lease(), io: t.io },
        ),
      ).toBe(1);
      expect(t.o.out.join('\n')).toContain('[err] không đẩy được hàng duyệt (RolloutBlocked)');
    });
    expect(await n('select count(*) from approval_queue')).toBe(0);
  });

  // ------------------------------------------------------------ vt_thuhoach

  const NOWH = new Date('2026-10-14T05:00:00Z'); // 12:00 VN
  async function seedVh() {
    await clearSamples();
    for (const p of H.harvest.plots.slice(0, 3)) {
      await pool.query(
        'insert into plots (id, tree_count, planted_year, status, source) values ($1, $2, $3, $4, $5)',
        [p.id, p.tree_count, p.planted_year, p.status, p.source],
      );
    }
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, author, source) values ('KV-1', $1, 'tưới', 'nv01', 'manual:garden')",
      [new Date(NOWH.getTime() - 3 * 86_400_000)],
    );
    await pool.query(
      "insert into plot_logs (plot_id, ts, activity, author, source) values ('KV-3', $1, 'thu hoạch', 'nv01', $2)",
      [H.harvest.logs[0]?.ts, H.harvest.logs[0]?.source],
    );
    for (const lot of H.avail.main.lots.slice(0, 4)) {
      await pool.query(
        'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, intake_status, checked_by, source) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          lot.lot_code,
          lot.sku_key,
          lot.mfg_date,
          lot.exp_date,
          lot.qty,
          lot.intake_status,
          lot.intake_status === 'pending' ? null : 'QC MẪU',
          lot.source,
        ],
      );
    }
  }
  const hq = () =>
    q(
      'select block, object_type, status, created_by, risk, payload from approval_queue order by id',
    );

  it('--submit → 1 mục PENDING farming/harvest_forecast; chạy lại → skipped; tệp = payload', async () => {
    await seedVh();
    expect(await n('select count(*) from plot_logs where row_hash is not null')).toBe(1);
    const rd = mkdtempSync(join(TMP, 'h-'));
    const t = cap();
    expect(
      await vh.vtThuhoachMain(
        { submit: true },
        { connect: lease(), io: t.io, now: NOWH, generated: '2026-10-14', reportsDir: rd },
      ),
      t.all(),
    ).toBe(0);
    const qq = await hq();
    expect(qq.length).toBe(1);
    expect(qq[0]).toMatchObject({
      block: 'farming',
      object_type: 'harvest_forecast',
      status: 'pending',
      created_by: 'agent:VT',
      risk: 'medium',
    });
    const p = qq[0]?.payload as string;
    expect(p).toContain('KV-1: 2026-Q4 — ');
    expect(p).toContain('KV-3 (MẪU): đã thu hoạch');
    expect(p).toContain('chưa kiểm nhập — không tính sẵn: lô L-P');
    expect(p).toContain('dữ liệu dùng: 3 khoảnh · 1 nhật ký thu hoạch · 4 lô');
    expect(readFileSync(join(rd, 'vt-thu-hoach-2026-10-14.md'), 'utf8')).toBe(p);
    const t2 = cap();
    expect(
      await vh.vtThuhoachMain(
        { submit: true },
        { connect: lease(), io: t2.io, now: NOWH, generated: '2026-10-14', reportsDir: rd },
      ),
    ).toBe(0);
    expect(t2.o.out.join('\n')).toContain('skipped');
    expect((await hq()).length).toBe(1);
  });

  it('thiếu baseline SKU → exit 0, ghi "thiếu giả định số bán", không submit', async () => {
    await seedVh();
    const doc = JSON.parse(readFileSync(sc.ASSUMPTIONS_FILE, 'utf8'));
    delete doc.baseline_units_per_week['mat-ong-sam-120ml-1hu'];
    const sf = join(TMP, 's-nobase.json');
    writeFileSync(sf, JSON.stringify(doc));
    const rd = mkdtempSync(join(TMP, 'h-'));
    const t = cap();
    expect(
      await vh.vtThuhoachMain(
        {},
        {
          connect: lease(),
          io: t.io,
          now: NOWH,
          generated: '2026-10-14',
          reportsDir: rd,
          scenarioFile: sf,
        },
      ),
    ).toBe(0);
    expect(readFileSync(join(rd, 'vt-thu-hoach-2026-10-14.md'), 'utf8')).toContain(
      'thiếu giả định số bán',
    );
    expect(await hq()).toEqual([]);
  });

  it('--date backdate KHÔNG đè generated (ngày lập thật)', async () => {
    await seedVh();
    const rd = mkdtempSync(join(TMP, 'h-'));
    const t = cap();
    expect(
      await vh.vtThuhoachMain(
        { date: '2026-01-01', submit: true },
        { connect: lease(), io: t.io, generated: '2026-10-14', reportsDir: rd },
      ),
    ).toBe(0);
    const p = (await hq())[0]?.payload as string;
    expect(p).toContain('- as_of: 2026-01-01\n');
    expect(p).toContain('- generated: 2026-10-14\n');
  });

  it('loadDb: ngày lô luôn YYYY-MM-DD, không phụ thuộc DateStyle của phiên', async () => {
    await seedVh();
    const c = await pool.connect();
    try {
      await c.query("set datestyle = 'SQL, DMY'");
      const [, , lots] = await vh.loadDb(c);
      expect(lots.length).toBeGreaterThan(0);
      for (const l of lots) {
        expect(l.exp_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (l.mfg_date !== null) expect(l.mfg_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      await c.query('reset datestyle');
      c.release();
    }
  });

  it('cổng farming-05.2 TẮT → exit 2 trước khi ghi báo cáo/submit', async () => {
    settings.forceMode = 'tat';
    const rd = mkdtempSync(join(TMP, 'h-'));
    const t = cap();
    expect(
      await vh.vtThuhoachMain(
        { submit: true },
        { connect: lease(), io: t.io, now: NOWH, reportsDir: rd },
      ),
    ).toBe(2);
    expect(t.o.out.join('\n')).toContain('[rollout]');
    expect(t.o.out.join('\n')).toContain('farming-05.2');
    expect(readdirSync(rd)).toEqual([]);
    expect(await hq()).toEqual([]);
  });
});
