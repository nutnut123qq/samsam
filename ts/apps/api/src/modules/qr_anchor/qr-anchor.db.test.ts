import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPool } from '@samsam/core/db';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLog } from '../garden_zalo/garden.js';
import G from './__fixtures__/qr_trace.golden.json' with { type: 'json' };
import * as an from './anchor.js';
import * as q from './qr-trace.js';

// Dịch phần DB thật của tests/test_qr_trace.py, test_v13_c09_anchor_legal.py, test_r13_batch_b.py,
// test_r13_fix4.py, test_r14_code_gaps.py (C2), test_r17_cong_tat.py (M3 anchor), test_v13_review_fix.py
// (F03 qr), test_v14_p3_rollout_edges.py (site tạm ngưng), test_v14_p6_ops.py (video), test_v14_p2
// (cổng chế độ thực). DB riêng tạo lại từ mẫu MỖI ca (testDbName('qr_anchor')), xóa khi xong — KHÔNG
// BAO GIỜ DB `samsam`. Danh tính người ký là FIXTURE (tệp qr_signers tạm), không phải người thật.
// Giai đoạn rollout: `settings.forceMode` (Python `_FORCE_MODE`; conftest mặc định 'van_hanh').

const LOT = 'LOT-MO-001';
const SKU = 'mat-ong-sam-120ml-1hu';
const SIGN = {
  gd_san_xuat: 'Trần Sản Xuất',
  gd_vung_trong: 'Lê Vùng Trồng',
  phap_che_qa: 'Phạm Pháp Chế',
} as const;
const PLOT_LOC = 'Trà My 15.0123, 107.9876';
const LOG_DETAIL = 'gọi 0905123456 a@b.vn';
const LOG_AUTHOR = 'Nguyễn Văn Vườn';
const MEDIA_AUTHOR = 'Lê Thị Ảnh';
const SECRETS = [
  PLOT_LOC,
  '15.0123',
  '107.9876',
  '0905123456',
  'a@b.vn',
  LOG_AUTHOR,
  MEDIA_AUTHOR,
  ...Object.values(SIGN),
  'KV-T01',
  'KV-T02',
];
const H1 = '2026-09-01T08:00:00+07:00';
const DEV = { NODE_ENV: 'test' };
const CFG = JSON.parse(readFileSync(dataPath('qr_config.json'), 'utf8'));
const OTS_CFG: an.AnchorConfig = {
  provider: 'opentimestamps',
  timeout_s: 5,
  calendars: ['https://cal-a.test', 'https://cal-b.test'],
};
const META = new Map(
  (G.has_metadata as { name: string; b64: string }[]).map((x) => [
    x.name,
    Buffer.from(x.b64, 'base64'),
  ]),
);
const CLEAN_JPG = META.get('jpg_clean') as Buffer;
const OTHER_JPG = META.get('jpg_clean2') as Buffer;

// r13: phản hồi calendar HỢP LỆ định dạng OTS (append 16 byte → sha256 → pending cal-b).
const CAL_RESP = Buffer.from(
  'f01011111111111111111111111111111111080083dfe30d2ef90c8e131268747470733a2f2f63616c2d622e74657374',
  'hex',
);
const vb = (b: Buffer): Buffer => Buffer.concat([an.putVaruint(b.length), b]);
const pending = (uri: string): Buffer =>
  Buffer.concat([Buffer.from([0]), an.ATT_PENDING, vb(vb(Buffer.from(uri)))]);
const bitcoin = (h: number): Buffer =>
  Buffer.concat([Buffer.from([0]), an.ATT_BITCOIN, vb(an.putVaruint(h))]);
const CAL = 'https://cal-b.test';
const NONCE = Buffer.alloc(16, 0x22);
const RESP = Buffer.concat([Buffer.from([0xf0]), vb(NONCE), Buffer.from([0x08]), pending(CAL)]);
const commitment = (digest: Buffer): Buffer =>
  createHash('sha256')
    .update(Buffer.concat([digest, NONCE]))
    .digest();
const btcBody = (h: number): Buffer => Buffer.concat([Buffer.from([0x08]), bitcoin(h)]);

type Call = [string, Buffer, number];
function fakePost(calls: Call[], fail: string[] = [], resp: Buffer = CAL_RESP): an.Post {
  return async (url, body, timeout) => {
    calls.push([url, body, timeout]);
    if (fail.some((f) => url.startsWith(f))) throw new an.UrlError('calendar giả lỗi');
    return resp;
  };
}
const noGet: an.Get = async () => {
  throw new Error('không được hỏi calendar');
};

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('qr_anchor (DB thật)', () => {
  let pool: pg.Pool;
  let name = '';
  const TMP = mkdtempSync(join(tmpdir(), 'qrdb-'));
  const SF = join(TMP, 'signers.json');
  writeFileSync(
    SF,
    JSON.stringify({
      status: 'fixture',
      roles: Object.fromEntries(Object.entries(SIGN).map(([r, n]) => [r, [n]])),
    }),
  );
  let buf: string[] = [];
  const io = { out: (s: string) => buf.push(s), err: (s: string) => buf.push(s) };
  /** Như capsys.readouterr(): lấy + xóa. */
  const out = (): string => {
    const t = buf.join('\n');
    buf = [];
    return t;
  };
  const lease = async () => ({ db: pool, release: async () => {} });
  let extra: q.QrDeps = {};
  const run = (cmd: string, o: q.QrOpts, more: q.QrDeps = {}) =>
    q.qrTraceMain(cmd, o, { io, env: DEV, connect: lease, signersFile: SF, ...extra, ...more });
  const one = async (sql: string, args: unknown[] = []) =>
    Object.values((await pool.query(sql, args)).rows[0] ?? {})[0];
  const count = async (t: string, where = 'true', args: unknown[] = []) =>
    Number(await one(`select count(*) from ${t} where ${where}`, args));
  const plot = (pid = 'KV-T01', source = 'manual') =>
    pool.query('insert into plots (id, location, source) values ($1, $2, $3)', [
      pid,
      PLOT_LOC,
      source,
    ]);
  async function harvest(ts: string, pid = 'KV-T01', activity = 'thu hoạch'): Promise<string> {
    const [lid, w] = await addLog(pool, pid, ts, activity, LOG_DETAIL, LOG_AUTHOR);
    expect(lid, w.join(';')).not.toBeNull();
    return String(lid);
  }
  async function mkLot(
    code = LOT,
    status = 'passed',
    mfg = '2026-09-15',
    exp = '2036-03-15',
    sku = SKU,
    source = 'manual',
  ) {
    await pool.query(
      'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, source)' +
        ' values ($1, $2, $3, $4, 100, $5)',
      [code, sku, mfg, exp, source],
    );
    if (status !== 'pending') {
      await pool.query("select record_lot_intake($1, $2, 'QA fixture')", [code, status]);
    }
  }
  /** Dòng garden_media (không cần tệp kho — link chỉ đối chiếu DB). */
  async function mediaRow(pid = 'KV-T01', sha = randomBytes(32).toString('hex'), ext = 'jpg') {
    await pool.query(
      'insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author)' +
        " values ($1, $2, 10, $3, '2026-09-01', $4)",
      [sha, ext, pid, MEDIA_AUTHOR],
    );
    return sha;
  }
  /** Ảnh ĐÃ gỡ metadata (golden strip_image Python) vào kho `<store>/<sha[:2]>/<sha>.jpg` + DB. */
  async function media(store: string, data = CLEAN_JPG, pid = 'KV-T01') {
    const sha = createHash('sha256').update(data).digest('hex');
    mkdirSync(join(store, sha.slice(0, 2)), { recursive: true });
    writeFileSync(join(store, sha.slice(0, 2), `${sha}.jpg`), data);
    return mediaRow(pid, sha);
  }
  async function ready(m: string[] = []): Promise<string> {
    await plot();
    const lid = await harvest(H1);
    await mkLot();
    const o: q.QrOpts = { lot: LOT, log: lid, by: 'GĐ SX fixture' };
    if (m.length) o.media = m;
    expect(await run('link', o)).toBe(0);
    return lid;
  }
  async function sign(roles: q.Role[] = [...q.ROLE_KEYS]) {
    for (const r of roles) expect(await run('sign', { lot: LOT, role: r, by: SIGN[r] }), r).toBe(0);
  }
  async function tamperChain(lid: string) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update plot_logs set detail = 'sửa lén' where id = $1", [lid]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await count('verify_plot_logs()')).toBeGreaterThan(0);
  }
  /** Sửa thẳng bỏ qua trigger (mô phỏng sửa lén) — superuser DB test. */
  async function replica(sql: string, args: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(sql, args);
      await c.query('commit');
    } finally {
      c.release();
    }
  }
  async function raises(sql: string, args: unknown[] = [], code = 'P0001', match?: string) {
    let err: unknown = null;
    try {
      await pool.query(sql, args);
    } catch (e) {
      err = e;
    }
    expect(err, sql).not.toBeNull();
    expect((err as { code?: string }).code, `${sql}: ${(err as Error).message}`).toBe(code);
    if (match) expect((err as Error).message).toContain(match);
  }
  const code = async () =>
    (await one('select code from qr_codes where revoked_at is null')) as string;
  const nowAsOf = () => an.dbNow(pool, '0 minutes');
  const lotState = async () => q.lotState(pool, LOT, q.loadConfig(), q.goldenMap());

  beforeAll(() => {
    settings.forceMode = 'van_hanh';
  });
  beforeEach(async () => {
    await pool?.end();
    if (name) await dropDb(name);
    name = testDbName('qr_anchor');
    pool = createPool(await createDbFromTemplate(name));
    settings.forceMode = 'van_hanh';
    buf = [];
    extra = {};
  });
  afterAll(async () => {
    await pool?.end();
    if (name) await dropDb(name);
    settings.forceMode = null;
    rmSync(TMP, { recursive: true, force: true });
  });

  // ================================================================ qr_trace

  it('function SECURITY DEFINER: app_human gọi được, agent_writer/public không; không INSERT thẳng', async () => {
    const fns = [
      'qr_lot_snapshot_sha(text)',
      'link_lot_origin(text,bigint,text[],text)',
      'unlink_lot_origin(text,bigint,text)',
      'sign_qr_lot(text,text,text,text,text)',
      'issue_qr(text,text,text,text)',
      'revoke_qr(text,text,text)',
    ];
    const secdef = await pool.query(
      'select proname, prosecdef from pg_proc where proname = any($1)',
      [fns.map((f) => f.split('(')[0])],
    );
    expect(secdef.rows.every((r) => r.prosecdef === true)).toBe(true);
    for (const f of fns) {
      const priv = "select has_function_privilege($1, $2, 'execute') as p";
      expect((await pool.query(priv, ['app_human', f])).rows[0].p, f).toBe(true);
      expect((await pool.query(priv, ['agent_writer', f])).rows[0].p, f).toBe(false);
      expect((await pool.query(priv, ['public', f])).rows[0].p, f).toBe(false);
    }
    for (const role of ['app_human', 'agent_writer']) {
      for (const t of ['approvals', 'qr_signatures', 'qr_codes', 'lot_origins']) {
        for (const p of ['insert', 'update', 'delete']) {
          const r = await pool.query('select has_table_privilege($1, $2, $3) as p', [role, t, p]);
          expect(r.rows[0].p, `${role} ${t} ${p}`).toBe(false);
        }
      }
    }
    await mkLot();
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role app_human');
      await expect(
        c.query("select sign_qr_lot($1, 'gd_san_xuat', 'A', $2)", [LOT, 'a'.repeat(64)]),
      ).rejects.toThrow('chưa có nguồn');
      await c.query('rollback');
    } finally {
      c.release();
    }
    expect(await count('verify_action_log()')).toBe(0);
  });

  it('link OK + mọi biến thể nhật ký/lô bị từ chối, không ghi, không lộ PII', async () => {
    const lid = await ready();
    expect(
      (
        await pool.query(
          'select lot_code, plot_log_id::text, media_sha256, linked_by from lot_origins',
        )
      ).rows,
    ).toEqual([{ lot_code: LOT, plot_log_id: lid, media_sha256: [], linked_by: 'GĐ SX fixture' }]);
    expect(
      (
        await pool.query(
          "select action, object_id, detail from agent_action_log where action like 'qr_%'",
        )
      ).rows,
    ).toEqual([
      { action: 'qr_lot_link', object_id: LOT, detail: { plot_log_id: Number(lid), media: 0 } },
    ]);
    const o = out();
    expect(o).not.toContain(PLOT_LOC);
    expect(o).not.toContain(LOG_AUTHOR);
    const n0 = await count('lot_origins');
    const sample = String(
      await one(
        "insert into plot_logs (plot_id, ts, activity, source) values ('KV-T01'," +
          " '2026-09-02T08:00:00+07', 'thu hoạch', 'sample:x') returning id",
      ),
    );
    expect(await one('select row_hash from plot_logs where id = $1', [sample])).toBeNull();
    const water = await harvest('2026-09-03T08:00:00+07:00', 'KV-T01', 'tưới');
    const late = await harvest('2026-09-16T00:30:00+07:00');
    const edge = await harvest('2026-09-15T00:30:00+07:00');
    await plot('KV-T02', 'sample:sample_plots.jsonl');
    const onSamplePlot = await harvest('2026-09-04T08:00:00+07:00', 'KV-T02');
    for (const [logId, why] of [
      [sample, 'mẫu / chưa chain'],
      [water, 'không phải'],
      [late, 'sau ngày sản xuất'],
      [onSamplePlot, 'khoảnh'],
      [lid, 'đã ánh xạ'],
      ['999999', 'không có nhật ký'],
    ] as [string, string][]) {
      expect(await run('link', { lot: LOT, log: logId, by: 'A' }), why).toBe(1);
      expect(out(), why).toContain(why);
    }
    expect(await count('lot_origins')).toBe(n0);
    // biên ngày giờ VN: 15/09 00:30 VN = 14/09 UTC → cùng ngày SX → nhận
    expect(await run('link', { lot: LOT, log: edge, by: 'A' })).toBe(0);
    await mkLot('LOT-MO-FAIL', 'failed');
    expect(await run('link', { lot: 'LOT-MO-FAIL', log: lid, by: 'A' })).toBe(1);
    expect(out()).toContain('failed');
    expect(await run('link', { lot: 'KHONG-CO', log: lid, by: 'A' })).toBe(1);
    await raises(
      "select link_lot_origin('KHONG-CO', $1, '{}', 'A')",
      [lid],
      'P0001',
      'không có lô',
    );
    // r12 G5-02: rỗng/agent/system bị chặn 42501 ở `human_actor`, kể cả login owner
    for (const bad of ['  ', 'agent:qr', 'system:job']) {
      await raises(
        "select link_lot_origin($1, $2, '{}', $3)",
        [LOT, lid, bad],
        '42501',
        'không hợp lệ',
      );
      await raises(
        'select unlink_lot_origin($1, $2, $3)',
        [LOT, lid, bad],
        '42501',
        'không hợp lệ',
      );
    }
    expect(await count('lot_origins', "linked_by ~* '^(agent|system):'")).toBe(0);
    // lô SKU ngoài pilot_skus → từ chối TRƯỚC khi gọi function
    await mkLot('LOT-SAP-001', 'passed', '2026-09-15', '2036-03-15', 'saphraton-20v');
    expect(await run('link', { lot: 'LOT-SAP-001', log: lid, by: 'A' })).toBe(1);
    expect(out()).toContain('ngoài pilot_skus');
    expect(await count('lot_origins', 'lot_code <> $1', [LOT])).toBe(0);
  });

  it('link: biến thể ảnh (tối đa 3, kho tư liệu, trùng) rồi 3 ảnh OK', async () => {
    await plot();
    await plot('KV-T03');
    const lid = await harvest(H1);
    await mkLot();
    const shas = [await mediaRow(), await mediaRow(), await mediaRow(), await mediaRow()];
    const other = await mediaRow('KV-T03');
    const s0 = shas[0] as string;
    for (const [m, why] of [
      [shas, 'tối đa 3'],
      [[other], 'kho tư liệu'],
      [['f'.repeat(64)], 'kho tư liệu'],
      [[s0, s0], 'trùng'],
    ] as [string[], string][]) {
      expect(await run('link', { lot: LOT, log: lid, by: 'A', media: m }), why).toBe(1);
      expect(out(), why).toContain(why);
    }
    expect(await count('lot_origins')).toBe(0);
    expect(await run('link', { lot: LOT, log: lid, by: 'A', media: shas.slice(0, 3) })).toBe(0);
    expect(Number(await one('select cardinality(media_sha256) from lot_origins'))).toBe(3);
  });

  it('link bị từ chối khi chuỗi nhật ký hỏng (dòng KHÁC dòng được link)', async () => {
    await plot();
    const good = await harvest(H1);
    const other = await harvest('2026-09-02T08:00:00+07:00', 'KV-T01', 'tưới');
    await mkLot();
    await tamperChain(other);
    expect(await run('link', { lot: LOT, log: good, by: 'A' })).toBe(1);
    expect(out()).toContain('chuỗi nhật ký');
    expect(await count('lot_origins')).toBe(0);
  });

  it('ký: 3 người khác nhau cùng bản chụp + lời văn; mọi biến thể sai bị DB từ chối', async () => {
    await ready();
    const st = await lotState();
    await sign(['gd_san_xuat', 'gd_vung_trong']);
    const nfd = '  trần   SẢN xuất '.normalize('NFD');
    await raises(
      "select sign_qr_lot($1, 'phap_che_qa', $2, $3)",
      [LOT, nfd, st.tsha],
      'P0001',
      'hai vai',
    );
    await raises(
      "select sign_qr_lot($1, 'gd_san_xuat', 'Người Khác', $2)",
      [LOT, st.tsha],
      'P0001',
      'đã ký',
    );
    await raises("select sign_qr_lot($1, 'tgd', 'X', $2)", [LOT, st.tsha], 'P0001', 'vai trò');
    await raises(
      "select sign_qr_lot($1, 'phap_che_qa', 'X', 'abc')",
      [LOT],
      'P0001',
      'text_sha256',
    );
    expect(await run('sign', { lot: LOT, role: 'gd_san_xuat', by: SIGN.gd_san_xuat })).toBe(1);
    expect(await count('qr_signatures')).toBe(2);
    await sign(['phap_che_qa']);
    expect(
      (
        await pool.query(
          'select role, signer, snapshot_sha256, text_sha256 from qr_signatures order by role',
        )
      ).rows,
    ).toEqual(
      [...q.ROLE_KEYS].sort().map((r) => ({
        role: r,
        signer: SIGN[r],
        snapshot_sha256: st.snap,
        text_sha256: st.tsha,
      })),
    );
    expect(await count('approvals', "object_type = 'qr_lot_sign'")).toBe(3);
    const want = createHash('sha256').update(`${st.snap}:${st.tsha}`).digest('hex');
    expect(
      await one(
        "select bool_and(content_sha256 = $1) from approvals where object_type = 'qr_lot_sign'",
        [want],
      ),
    ).toBe(true);
    expect(await count('agent_action_log', "action = 'qr_lot_sign'")).toBe(3);
    out();
    expect(await run('preview', { lot: LOT })).toBe(0);
    const o = out();
    expect(o).toContain('Còn thiếu: không');
    expect(o).toContain('guardrail kênh qr: OK');
    for (const s of SECRETS) expect(o, s).not.toContain(s);
    expect(await count('verify_action_log()')).toBe(0);
  });

  it('ký bị từ chối: lô chưa passed (CLI + DB), lời văn không qua guardrail', async () => {
    await plot();
    const lid = await harvest(H1);
    await mkLot(LOT, 'pending');
    expect(await run('link', { lot: LOT, log: lid, by: 'A' })).toBe(0);
    expect(await run('sign', { lot: LOT, role: 'gd_san_xuat', by: SIGN.gd_san_xuat })).toBe(1);
    expect(out()).toContain('passed');
    await raises(
      "select sign_qr_lot($1, 'gd_san_xuat', 'A', $2)",
      [LOT, 'a'.repeat(64)],
      'P0001',
      'passed',
    );
    await pool.query("select record_lot_intake($1, 'passed', 'QA')", [LOT]);
    const orig = q.tail.lines;
    q.tail.lines = (l, p) => [...orig(l, p), 'Giúp chữa bệnh'];
    try {
      expect(await run('sign', { lot: LOT, role: 'gd_san_xuat', by: SIGN.gd_san_xuat })).toBe(1);
    } finally {
      q.tail.lines = orig;
    }
    expect(out()).toContain('guardrail');
    expect(await count('qr_signatures')).toBe(0);
  });

  it.each(['relink', 'region'])('chữ ký cũ mất hiệu lực khi đổi (%s)', async (change) => {
    const lid = await ready();
    await sign(['gd_san_xuat', 'gd_vung_trong']);
    if (change === 'relink') {
      expect(await run('unlink', { lot: LOT, log: lid, by: 'A' })).toBe(0);
      const ex = await harvest('2026-09-05T08:00:00+07:00');
      expect(await run('link', { lot: LOT, log: ex, by: 'A' })).toBe(0);
    } else {
      const p = join(TMP, `c-${name}.json`);
      writeFileSync(p, JSON.stringify({ ...CFG, region_text: 'Quảng Nam' }));
      extra = { configFile: p };
    }
    out();
    expect(await run('preview', { lot: LOT })).toBe(0);
    const o = out();
    expect(o).toContain('Đã ký (bản hiện tại): chưa vai nào');
    expect(o).toContain('Còn thiếu: GĐ Sản xuất, GĐ vùng trồng, Pháp chế/QA');
    await sign(['phap_che_qa']);
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
    expect(await count('qr_codes')).toBe(0);
  });

  it('phát hành: đủ 3 chữ ký, mã ngẫu nhiên, 1 mã hiệu lực/lô, thu hồi + phát hành lại', async () => {
    const lid = await ready();
    await sign(['gd_san_xuat', 'gd_vung_trong']);
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1); // 2/3
    expect(out()).toContain('chưa đủ 3 chữ ký');
    expect(await count('qr_codes')).toBe(0);
    await sign(['phap_che_qa']);
    expect(await run('issue', { lot: LOT, by: 'Người phát hành' })).toBe(0);
    const o = out();
    const c1 = await code();
    expect(c1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(c1.toLowerCase()).not.toContain(LOT.toLowerCase());
    expect(o).toContain(`${c1}/`);
    expect(o).toContain('external-dep');
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1); // lần 2
    await raises(
      "select issue_qr($1, $2, $3, 'A')",
      [LOT, `x${LOT}abcdefghijklmn`, 'a'.repeat(64)],
      'P0001',
      'mã lô',
    );
    // lô đang có mã → không đổi ánh xạ
    expect(await run('unlink', { lot: LOT, log: lid, by: 'A' })).toBe(1);
    expect(out()).toContain('còn hiệu lực');
    // revoke thiếu --by → exit 2, mã vẫn hiệu lực
    expect(await run('revoke', { code: c1 })).toBe(2);
    expect(await code()).toBe(c1);
    expect(await run('revoke', { code: c1, by: 'GĐ fixture', reason: 'thử' })).toBe(0);
    expect(await run('revoke', { code: c1, by: 'GĐ fixture' })).toBe(1);
    expect(await run('revoke', { code: 'Z'.repeat(22), by: 'A' })).toBe(1);
    // phát hành lại (snapshot/lời văn không đổi → không cần ký lại) → mã MỚI
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    expect(await code()).not.toBe(c1);
    expect(await count('qr_codes')).toBe(2);
    expect(
      (
        await pool.query(
          "select action from agent_action_log where action in ('qr_issue', 'qr_revoke') order by id",
        )
      ).rows.map((r) => r.action),
    ).toEqual(['qr_issue', 'qr_revoke', 'qr_issue']);
    expect(await count('verify_action_log()')).toBe(0);
  });

  it('phát hành từ chối chữ ký giả signer_norm (2 vai cùng 1 người)', async () => {
    await ready();
    await sign(['gd_san_xuat', 'gd_vung_trong']);
    const st = await lotState();
    const aid = await one(
      'insert into approvals (object_type, object_id, content_sha256, decision, approved_by, note)' +
        " values ('qr_lot_sign', $1, $2, 'approved', 'TRẦN SẢN XUẤT', 'phap_che_qa') returning id",
      [LOT, 'c'.repeat(64)],
    );
    await pool.query(
      'insert into qr_signatures (lot_code, role, signer, signer_norm, snapshot_sha256,' +
        " text_sha256, approval_id) values ($1, 'phap_che_qa', ' TRẦN  SẢN XUẤT', 'gia-khac', $2, $3, $4)",
      [LOT, st.snap, st.tsha, aid],
    );
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
    expect(out()).toContain('3 người khác nhau');
    expect(await count('qr_codes')).toBe(0);
  });

  it.each(['pending', 'failed', 'no_origin', 'chain_broken', 'expired', 'guardrail'])(
    'phát hành bị từ chối: %s',
    async (kase) => {
      const lid = await ready();
      await sign();
      if (['pending', 'failed', 'no_origin', 'expired'].includes(kase)) {
        // superuser sửa thẳng trạng thái (mô phỏng dữ liệu xấu) — DB vẫn chặn
        const sql: Record<string, string> = {
          pending:
            "update production_lots set intake_status = 'pending', checked_by = null, checked_at = null",
          failed: "update production_lots set intake_status = 'failed'",
          no_origin: 'delete from lot_origins',
          expired: "update production_lots set mfg_date = '2020-01-01', exp_date = '2026-01-02'",
        };
        await replica(sql[kase] as string);
        expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
        const st = await lotState();
        const why: Record<string, string> = {
          pending: 'passed',
          failed: 'passed',
          no_origin: 'nguồn',
          expired: 'hết hạn',
        };
        await raises(
          "select issue_qr($1, $2, $3, 'A')",
          [LOT, 'Q'.repeat(22), st.tsha],
          'P0001',
          why[kase],
        );
      } else if (kase === 'chain_broken') {
        await tamperChain(lid);
        expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
        expect(out()).toContain('chuỗi nhật ký');
      } else {
        const orig = q.tail.lines;
        q.tail.lines = (l, p) => [...orig(l, p), 'gọi 0905123456'];
        try {
          expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
        } finally {
          q.tail.lines = orig;
        }
        expect(out()).toContain('pii');
      }
      expect(await count('qr_codes')).toBe(0);
    },
  );

  it('bảng QR append-only (trigger DB)', async () => {
    await ready();
    await sign();
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const c1 = await code();
    for (const sql of [
      "update qr_signatures set signer = 'x'",
      'delete from qr_signatures',
      'truncate qr_signatures',
      'delete from qr_codes',
      'truncate qr_codes cascade',
      "update qr_codes set lot_code = 'LOT-KHAC'",
      "update qr_codes set issued_by = 'x'",
    ]) {
      await raises(sql);
    }
    await pool.query("select revoke_qr($1, 'A')", [c1]);
    await raises("update qr_codes set revoked_by = 'B'", [], 'P0001', 'đã thu hồi');
    await raises(
      'update qr_codes set revoked_at = null, revoked_by = null',
      [],
      'P0001',
      'đã thu hồi',
    );
  });

  const files = (d: string): string[] => {
    const outF: string[] = [];
    const walk = (p: string) => {
      for (const n of readdirSync(p)) {
        const f = join(p, n);
        if (statSync(f).isDirectory()) walk(f);
        else outF.push(relative(d, f).replaceAll('\\', '/'));
      }
    };
    walk(d);
    return outF.sort();
  };

  it('site: trang + ảnh sạch, không bí mật; ảnh bị tráo / vùng đổi → giữ trang cũ; thu hồi', async () => {
    const store = join(TMP, `kho-${name}`);
    await plot();
    const sha = await media(store);
    const lid = await harvest(H1);
    await mkLot();
    expect(await run('link', { lot: LOT, log: lid, media: [sha], by: 'A' })).toBe(0);
    await sign();
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const c1 = await code();
    const site = join(TMP, `site-${name}`);
    // thiếu env kho ảnh → không ghi trang, exit 1
    expect(await run('site', { out: site })).toBe(1);
    expect(existsSync(join(site, c1, 'index.html'))).toBe(false);
    const env = { ...DEV, GARDEN_MEDIA_DIR: store };
    out();
    expect(await run('site', { out: site }, { env })).toBe(0);
    const page = readFileSync(join(site, c1, 'index.html'), 'utf8');
    for (const s of [
      'Mật ong sâm 120ml (1 hũ)',
      `Lô: ${LOT}`,
      '15/09/2026',
      '15/03/2036',
      CFG.region_text,
      `../media/${sha}.jpg`,
    ])
      expect(page).toContain(s);
    expect(existsSync(join(site, 'index.html'))).toBe(false);
    expect(files(site)).toEqual([`${c1}/index.html`, `media/${sha}.jpg`].sort());
    for (const f of files(site)) {
      const txt = readFileSync(join(site, f)).toString('utf8');
      for (const s of SECRETS) expect(txt, `${f} ${s}`).not.toContain(s);
    }
    const visible = page.replace(/<[^>]+>/g, '\n');
    expect(maskPii(visible)).toBe(visible);
    expect(q.COORD_RE.test(visible)).toBe(false);
    expect(page).not.toContain('<script');
    expect(page).not.toContain('http');
    expect(page.toLowerCase()).not.toContain('ngọc linh');
    const img = readFileSync(join(site, 'media', `${sha}.jpg`));
    expect(img.equals(CLEAN_JPG)).toBe(true);
    expect(img.includes(Buffer.from('Exif\x00\x00', 'latin1'))).toBe(false);
    expect(img.includes(Buffer.from('ns.adobe.com/xap'))).toBe(false);
    const o = out();
    for (const s of SECRETS) expect(o).not.toContain(s);
    // tệp ảnh trong kho bị tráo (sha lệch) → exit 1, không ghi lại trang
    const stored = join(store, sha.slice(0, 2), `${sha}.jpg`);
    const pageBytes = readFileSync(join(site, c1, 'index.html'));
    writeFileSync(stored, OTHER_JPG);
    writeFileSync(join(site, c1, 'index.html'), 'cu');
    expect(await run('site', { out: site }, { env })).toBe(1);
    expect(out()).toContain('lệch sha256');
    expect(readFileSync(join(site, c1, 'index.html'), 'utf8')).toBe('cu');
    writeFileSync(stored, CLEAN_JPG);
    expect(await run('site', { out: site }, { env })).toBe(0);
    expect(readFileSync(join(site, c1, 'index.html')).equals(pageBytes)).toBe(true);
    // đổi region_text sau phát hành → exit 1, trang cũ giữ nguyên
    const p = join(TMP, `c2-${name}.json`);
    writeFileSync(p, JSON.stringify({ ...CFG, region_text: 'Quảng Nam' }));
    expect(await run('site', { out: site }, { env, configFile: p })).toBe(1);
    expect(out()).toContain('thu hồi + ký lại');
    expect(readFileSync(join(site, c1, 'index.html')).equals(pageBytes)).toBe(true);
    // thu hồi có --by → trang "đã thu hồi", không còn lô/HSD/ảnh
    expect(await run('revoke', { code: c1, by: 'GĐ fixture' })).toBe(0);
    expect(await run('site', { out: site }, { env })).toBe(0);
    const rev = readFileSync(join(site, c1, 'index.html'), 'utf8');
    expect(rev).toContain('đã thu hồi');
    for (const s of [LOT, 'Hạn sử dụng', '<img', CFG.region_text]) expect(rev).not.toContain(s);
    expect(existsSync(join(site, 'media', `${sha}.jpg`))).toBe(false);
    expect(existsSync(join(site, 'index.html'))).toBe(false);
  });

  it('site: ảnh kho còn EXIF → exit 1, không ghi trang', async () => {
    const store = join(TMP, `kho-meta-${name}`);
    await plot();
    const raw = META.get('jpg_raw') as Buffer; // còn EXIF/GPS (chưa gỡ)
    const sha = await media(store, raw);
    const lid = await harvest(H1);
    await mkLot();
    expect(await run('link', { lot: LOT, log: lid, media: [sha], by: 'A' })).toBe(0);
    await sign();
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const site = join(TMP, `site-meta-${name}`);
    expect(await run('site', { out: site }, { env: { ...DEV, GARDEN_MEDIA_DIR: store } })).toBe(1);
    expect(out()).toContain('còn metadata EXIF/XMP');
    expect(existsSync(join(site, await code(), 'index.html'))).toBe(false);
  });

  it('planb: chỉ đọc, lô mẫu [MẪU] chưa đủ điều kiện, CHỈ tên vai', async () => {
    await ready();
    await sign(['gd_san_xuat']);
    await mkLot('MAU-MO120-260915', 'pending', '2026-09-15', '2028-03-15', SKU, 'sample');
    const tables = [
      'lot_origins',
      'qr_signatures',
      'qr_codes',
      'approvals',
      'agent_action_log',
      'production_lots',
    ];
    const before = await Promise.all(tables.map((t) => count(t)));
    out();
    expect(await run('planb', { date: '2026-11-27' })).toBe(0);
    const o = out();
    expect(await Promise.all(tables.map((t) => count(t)))).toEqual(before);
    expect(o).toContain('MAU-MO120-260915 [MẪU]');
    expect(o).toContain('chưa đủ điều kiện in tem');
    const seg = o.split(`- lô ${LOT}`)[1] as string;
    expect(seg).toContain('chữ ký vai GĐ vùng trồng, Pháp chế/QA');
    expect(seg).toContain('Lời văn tem KHÔNG QR (guardrail: OK)');
    for (const s of SECRETS) expect(o, s).not.toContain(s);
  });

  it('chế độ thực: --by tự khai (đúng allowlist) nhưng login không ánh xạ → từ chối + authz_denied', async () => {
    await ready();
    const env = { NODE_ENV: 'test', APPROVAL_ENFORCE: '1' };
    const d0 = await count('agent_action_log', "action = 'authz_denied'");
    expect(
      await run('sign', { lot: LOT, role: 'gd_san_xuat', by: SIGN.gd_san_xuat }, { env }),
    ).toBe(1);
    expect(await run('issue', { lot: LOT, by: SIGN.gd_san_xuat }, { env })).toBe(1);
    expect(await run('revoke', { code: 'A'.repeat(22), by: SIGN.gd_san_xuat }, { env })).toBe(1);
    expect(await count('qr_signatures')).toBe(0);
    expect(await count('agent_action_log', "action = 'authz_denied'")).toBe(d0 + 3);
  });

  // ---------------- rollout (HĐ 6.7) ----------------

  it('issue: tắt → không phát hành (farming-03.2); chạy thử → mã chỉ nội bộ, không URL', async () => {
    await ready();
    await sign();
    settings.forceMode = 'tat';
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(1);
    expect(out()).toContain('farming-03.2');
    expect(await count('qr_codes')).toBe(0);
    settings.forceMode = 'chay_thu';
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const o = out();
    expect(o.toLowerCase()).toContain('chạy thử');
    expect(o).not.toContain('URL:');
  });

  it('site: chưa vận hành → không xuất trang mã còn hiệu lực; thu hồi vẫn xuất; có người duyệt → xuất', async () => {
    await ready();
    await sign();
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const c1 = await code();
    const env = { ...DEV, GARDEN_MEDIA_DIR: join(TMP, 'kho-trong') };
    const site = join(TMP, `site-ro-${name}`);
    for (const md of ['chay_thu', 'tat']) {
      settings.forceMode = md;
      expect(await run('site', { out: site }, { env }), md).toBe(1);
      expect(existsSync(join(site, c1, 'index.html'))).toBe(false);
      expect(out()).toContain('farming-03.2');
    }
    expect(await run('revoke', { code: c1, by: 'GĐ fixture' })).toBe(0);
    expect(await run('site', { out: site }, { env })).toBe(0);
    expect(readFileSync(join(site, c1, 'index.html'), 'utf8')).toContain('đã thu hồi');
    settings.forceMode = 'co_nguoi_duyet';
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const c2 = await code();
    expect(await run('site', { out: site }, { env })).toBe(0);
    expect(existsSync(join(site, c2, 'index.html'))).toBe(true);
  });

  it('site: tắt/lùi chạy thử THAY trang đã công khai bằng "tạm ngưng" + gỡ ảnh', async () => {
    const store = join(TMP, `kho-p-${name}`);
    await plot();
    const sha = await media(store);
    const lid = await harvest(H1);
    await mkLot();
    expect(await run('link', { lot: LOT, log: lid, media: [sha], by: 'A' })).toBe(0);
    await sign();
    expect(await run('issue', { lot: LOT, by: 'A' })).toBe(0);
    const c1 = await code();
    const env = { ...DEV, GARDEN_MEDIA_DIR: store };
    const site = join(TMP, `site-p-${name}`);
    expect(await run('site', { out: site }, { env })).toBe(0);
    const page = join(site, c1, 'index.html');
    expect(readFileSync(page, 'utf8')).toContain(`Lô: ${LOT}`);
    expect(existsSync(join(site, 'media', `${sha}.jpg`))).toBe(true);
    for (const md of ['tat', 'chay_thu']) {
      settings.forceMode = md;
      expect(await run('site', { out: site }, { env })).toBe(1);
      const body = readFileSync(page, 'utf8');
      expect(body).not.toContain(LOT);
      expect(body).not.toContain('media');
      expect(body).toContain(q.PAUSED);
      expect(existsSync(join(site, 'media', `${sha}.jpg`))).toBe(false);
    }
    settings.forceMode = 'van_hanh';
    expect(await run('site', { out: site }, { env })).toBe(0);
    expect(readFileSync(page, 'utf8')).toContain(`Lô: ${LOT}`);
  });

  it('link: tắt (farming-03.1) → không ghi', async () => {
    settings.forceMode = 'tat';
    await plot();
    const lid = await harvest(H1);
    await mkLot();
    expect(await run('link', { lot: LOT, log: lid, by: 'A' })).toBe(1);
    expect(out()).toContain('farming-03.1');
    expect(await count('lot_origins')).toBe(0);
  });

  it('link: sha của VIDEO bị từ chối ngay (CLI + trigger DB); không media → nhận', async () => {
    await plot();
    const lid = await harvest(H1);
    await mkLot();
    const vid = 'ab'.repeat(32);
    await pool.query(
      'insert into garden_media (sha256, ext, bytes, plot_id, taken_on, author)' +
        " values ($1, 'mp4', 10, 'KV-T01', '2026-09-01', 'Người Quay Giả Lập')",
      [vid],
    );
    expect(await run('link', { lot: LOT, log: lid, media: [vid], by: 'GĐ SX fixture' })).toBe(1);
    expect(out()).toContain('video');
    expect(await count('lot_origins')).toBe(0);
    await raises("select link_lot_origin($1, $2, $3, 'A')", [LOT, lid, [vid]], '23514', 'video');
    expect(await run('link', { lot: LOT, log: lid, by: 'GĐ SX fixture' })).toBe(0);
  });

  // ================================================================ anchor

  async function issued(): Promise<string> {
    await ready();
    await sign();
    expect(await run('issue', { lot: LOT, by: 'Người phát hành' })).toBe(0);
    return (await one('select code from qr_codes')) as string;
  }
  const manifestSha = async (bid: string) =>
    (await one('select manifest_sha256 from anchor_batches where id = $1', [bid])) as string;

  it('build: lá không PII, sắp theo khóa, bỏ lô mẫu; gốc không đổi → no-op; collect tất định', async () => {
    const c1 = await issued();
    expect(await run('revoke', { code: c1, by: 'GĐ fixture' })).toBe(0);
    // Lô MẪU có chữ ký → không vào lá.
    await mkLot('LOT-MAU-01', 'passed', '2026-09-15', '2036-03-15', SKU, 'sample');
    const aid = await one(
      'insert into approvals (object_type, object_id, content_sha256, decision, approved_by)' +
        " values ('qr_lot_sign', 'LOT-MAU-01', $1, 'approved', 'x') returning id",
      ['c'.repeat(64)],
    );
    await pool.query(
      'insert into qr_signatures (lot_code, role, signer, signer_norm, snapshot_sha256,' +
        " text_sha256, approval_id) values ('LOT-MAU-01', 'gd_san_xuat', 'x', 'x', $1, $2, $3)",
      ['d'.repeat(64), 'e'.repeat(64), aid],
    );
    const now = await nowAsOf();
    const r = await an.build(pool, now);
    expect(r.new).toBe(true);
    expect(r.id).toBeTruthy();
    const leaves = (await one('select leaves from anchor_batches where id = $1', [
      r.id,
    ])) as an.Leaf[];
    expect(leaves.map((x) => x.k.split(':')[0]).sort()).toEqual([
      'plot_logs_head',
      'qr_issue',
      'qr_revoke',
      'qr_sig',
      'qr_sig',
      'qr_sig',
    ]);
    expect(leaves.map((x) => x.k)).toEqual([...leaves.map((x) => x.k)].sort(q.cpCmp));
    const blob = JSON.stringify(leaves);
    expect(blob).not.toContain('LOT-MAU-01');
    for (const s of SECRETS) expect(blob, s).not.toContain(s);
    expect((await an.build(pool, now)).new).toBe(false); // không đổi → no-op
    expect(await count('anchor_batches')).toBe(1);
    expect(JSON.parse(an.canon(await an.collect(pool, now)))).toEqual(leaves);
    // bản kê dựng lại từ DB = sha đã lưu (as_of đủ micro giây)
    const row = await an.batch(pool, r.id);
    expect(
      createHash('sha256')
        .update(an.manifest(row.as_of_us, row.leaves, row.merkle_root))
        .digest('hex'),
    ).toBe(row.manifest_sha256);
    expect(row.as_of_us).toBe(now.us);
  });

  it('build: 0 lá → "chưa có"; chuỗi hỏng → từ chối, không ghi', async () => {
    await expect(an.build(pool, await nowAsOf())).rejects.toThrow('chưa có');
    const lid = await ready();
    await tamperChain(lid);
    await expect(an.build(pool, await nowAsOf())).rejects.toThrow('chuỗi plot_logs');
    expect(await count('anchor_batches')).toBe(0);
  });

  it('verify: khớp; bảng append-only; sửa lén dữ liệu QR đã neo → bắt', async () => {
    const c1 = await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    expect(await an.verify(pool, bid)).toEqual([bid, []]);
    expect((await an.verify(pool, 'latest'))[1]).toEqual([]);
    await raises(
      'update anchor_batches set merkle_root = $1',
      ['0'.repeat(64)],
      'P0001',
      'append-only',
    );
    await raises('delete from anchor_batches', [], 'P0001', 'append-only');
    await replica('update qr_codes set text_sha256 = $1 where code = $2', ['f'.repeat(64), c1]);
    const probs = (await an.verify(pool, bid))[1];
    expect(probs.some((p) => p.includes(`qr_issue:${c1}`) && p.includes('đã đổi'))).toBe(true);
  });

  it('verify: lá đã lưu bị sửa → gốc Merkle + sha bản kê lệch; submit từ chối "LỆCH"', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    await replica(
      "update anchor_batches set leaves = jsonb_set(leaves, '{0,h}', to_jsonb($1::text)) where id = $2",
      ['a'.repeat(64), bid],
    );
    const probs = (await an.verify(pool, bid))[1];
    expect(probs.some((p) => p.includes('gốc Merkle'))).toBe(true);
    expect(probs.some((p) => p.includes('sha256 bản kê'))).toBe(true);
    await expect(an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([]))).rejects.toThrow(
      'LỆCH',
    );
  });

  it('submit provider none → AnchorBlocked, KHÔNG ghi gì', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    await expect(
      an.submit(pool, bid, { provider: 'none', calendars: [], timeout_s: 15 }),
    ).rejects.toThrow(an.AnchorBlocked);
    await expect(
      an.submit(pool, bid, { provider: 'none', calendars: [], timeout_s: 15 }),
    ).rejects.toThrow('CHƯA NEO');
    expect(await count('anchor_receipts')).toBe(0);
    expect(await an.receiptState(pool, bid)).toBe('chưa neo');
  });

  it('submit OTS: CHỈ digest 32 byte rời hệ thống, chuyển calendar, thử lại, no-op, export, verify', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    const sha = await manifestSha(bid);
    let calls: Call[] = [];
    let r = await an.submit(
      pool,
      bid,
      OTS_CFG,
      an.CREATED_BY,
      fakePost(calls, ['https://cal-a', 'https://cal-b']),
    );
    expect(r.status).toBe('loi');
    expect(calls.length).toBe(2);
    expect(await an.receiptState(pool, bid)).toContain('chưa neo');
    calls = [];
    r = await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost(calls, ['https://cal-a']));
    expect(r.status).toBe('da_gui');
    expect(r.calendar).toBe('https://cal-b.test');
    expect(calls.map((c) => c[0])).toEqual([
      'https://cal-a.test/digest',
      'https://cal-b.test/digest',
    ]);
    for (const [, body, t] of calls) {
      expect(body.equals(Buffer.from(sha, 'hex'))).toBe(true);
      expect(t).toBe(5);
    }
    const rec = (await one(
      "select receipt from anchor_receipts where status = 'da_gui'",
    )) as Buffer;
    expect(rec.equals(an.otsFile(Buffer.from(sha, 'hex'), CAL_RESP))).toBe(true);
    const state = await an.receiptState(pool, bid);
    expect(state).toContain('chờ xác nhận Bitcoin');
    expect(state).not.toContain('đã neo');
    calls = [];
    expect((await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost(calls))).new).toBe(false);
    expect(calls).toEqual([]);
    expect((await an.verify(pool, bid))[1]).toEqual([]);
    const outDir = join(TMP, `out-${name}`);
    const fs = await an.exportBatch(pool, bid, outDir);
    expect(fs.map((f) => f.split(/[\\/]/).pop())).toEqual([
      `anchor-${bid}.json`,
      `anchor-${bid}.json.ots`,
    ]);
    expect(
      createHash('sha256')
        .update(readFileSync(fs[0] as string))
        .digest('hex'),
    ).toBe(sha);
    expect(readFileSync(fs[1] as string).equals(rec)).toBe(true);
    const man = JSON.parse(readFileSync(fs[0] as string, 'utf8'));
    expect(man.merkle_root).toBe(an.merkleRoot(man.leaves.map((x: an.Leaf) => x.h)));
    await replica('update anchor_receipts set receipt = $1', [Buffer.alloc(40, 0x78)]);
    expect((await an.verify(pool, bid))[1].some((p) => p.includes('biên nhận'))).toBe(true);
  });

  it('cổng rollout: chưa vào sổ = chạy thử (không gửi); tắt → không gom; có người duyệt → chỉ người', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    settings.forceMode = null;
    const calls: Call[] = [];
    await expect(an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost(calls))).rejects.toThrow(
      'farming-06',
    );
    expect(calls).toEqual([]);
    settings.forceMode = 'tat';
    await expect(an.build(pool, await nowAsOf())).rejects.toThrow(RolloutBlocked);
    settings.forceMode = 'co_nguoi_duyet';
    await expect(an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost(calls))).rejects.toThrow(
      'NGƯỜI duyệt',
    );
    expect(calls).toEqual([]);
    const r = await an.submit(pool, bid, OTS_CFG, 'Quản lý AI', fakePost(calls));
    expect(r.status).toBe('da_gui');
    expect(calls.length).toBe(1);
  });

  it('upgrade: chưa gửi → chua_gui; pending → cho; Bitcoin → da_nang_cap append-only; lần 2 no-op', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    const sha = await manifestSha(bid);
    expect((await an.upgrade(pool, bid, OTS_CFG, noGet)).status).toBe('chua_gui');
    await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([], [], RESP));
    const c = commitment(Buffer.from(sha, 'hex'));
    const gets: string[] = [];
    let r = await an.upgrade(pool, bid, OTS_CFG, async (url) => {
      gets.push(url);
      return null; // 404 = calendar chưa có attestation
    });
    expect(r.status).toBe('cho');
    expect(gets).toEqual([`${CAL}/timestamp/${c.toString('hex')}`]);
    expect(await an.receiptState(pool, bid)).toContain('chờ xác nhận');
    r = await an.upgrade(pool, bid, OTS_CFG, async () => btcBody(850001));
    expect(r.status).toBe('da_nang_cap');
    expect(r.heights).toEqual([850001n]);
    expect(r.new).toBe(true);
    const st = await an.receiptState(pool, bid);
    expect(st).toContain('attestation Bitcoin');
    expect(st).toContain('CHƯA xác minh bên thứ ba');
    expect(
      (
        await pool.query('select status from anchor_receipts where batch_id = $1 order by id', [
          bid,
        ])
      ).rows.map((x) => x.status),
    ).toEqual(['da_gui', 'da_nang_cap']);
    expect((await an.verify(pool, bid))[1]).toEqual([]);
    expect((await an.upgrade(pool, bid, OTS_CFG, noGet)).new).toBe(false);
  });

  it('upgrade: calendar ngoài cấu hình → không hỏi; phản hồi calendar hỏng khi submit → loi', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    const evil = Buffer.concat([
      Buffer.from([0xf0]),
      vb(NONCE),
      Buffer.from([0x08]),
      pending('https://evil.example'),
    ]);
    await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([], [], evil));
    const r = await an.upgrade(pool, bid, OTS_CFG, noGet);
    expect(r.status).toBe('cho');
    expect(r.errors?.length).toBeGreaterThan(0);
  });

  it('submit: phản hồi calendar sai định dạng → loi', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    const r = await an.submit(
      pool,
      bid,
      OTS_CFG,
      an.CREATED_BY,
      fakePost([], [], Buffer.from('\xf0junk', 'latin1')),
    );
    expect(r.status).toBe('loi');
  });

  it.each(['tat', 'chay_thu', 'co_nguoi_duyet', null])(
    'upgrade bị chặn TRƯỚC HTTP/INSERT ở giai đoạn %s (job agent)',
    async (stage) => {
      await issued();
      const bid = (await an.build(pool, await nowAsOf())).id as string;
      await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([], [], RESP));
      const n0 = await count('anchor_receipts');
      settings.forceMode = stage; // null + chưa vào sổ → chạy thử (fail-closed)
      await expect(an.upgrade(pool, bid, OTS_CFG, noGet)).rejects.toThrow('nâng cấp biên nhận');
      expect(await count('anchor_receipts')).toBe(n0);
    },
  );

  it('upgrade CLI: tắt → exit 1, không mạng, giữ biên nhận; vận hành → da_nang_cap', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([], [], RESP));
    const cfgFile = join(TMP, `ots-${name}.json`);
    writeFileSync(
      cfgFile,
      JSON.stringify({
        provider: 'opentimestamps',
        opentimestamps: { calendars: OTS_CFG.calendars, timeout_s: 5 },
      }),
    );
    const n0 = await count('anchor_receipts');
    settings.forceMode = 'tat';
    const d: an.AnchorDeps = { io, env: DEV, connect: lease, configFile: cfgFile, get: noGet };
    out();
    expect(await an.anchorMain({ upgrade: bid }, d)).toBe(1);
    expect(out()).toContain('nâng cấp biên nhận');
    expect(await count('anchor_receipts')).toBe(n0);
    settings.forceMode = 'van_hanh';
    expect(await an.anchorMain({ upgrade: bid }, { ...d, get: async () => btcBody(850002) })).toBe(
      0,
    );
    const o = out();
    expect(o).toContain('khối [850002]');
    expect(o).toContain('CHƯA xác minh bên thứ ba');
    expect(await count('anchor_receipts')).toBe(n0 + 1);
  });

  async function submitted(): Promise<string> {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, fakePost([], [], RESP));
    return bid;
  }

  it('anchor_upgrade_human: 1 dòng da_nang_cap/lần gom, ghi nhật ký; người qua upgrade() ở có người duyệt', async () => {
    const bid = await submitted();
    const cal = await one('select calendar from anchor_receipts where batch_id = $1', [bid]);
    const rec = Buffer.concat([
      (await one("select receipt from anchor_receipts where batch_id = $1 and status = 'da_gui'", [
        bid,
      ])) as Buffer,
      Buffer.from([0]),
    ]);
    const sql = 'select receipt_id::text, created from anchor_upgrade_human($1, $2, $3, $4)';
    const a = (await pool.query(sql, [bid, cal, rec, 'Người Duyệt Neo'])).rows[0];
    const b = (await pool.query(sql, [bid, cal, rec, 'Người Duyệt Neo'])).rows[0];
    expect(b.receipt_id).toBe(a.receipt_id);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(
      await count('agent_action_log', "action = 'anchor_upgrade' and object_id = $1", [bid]),
    ).toBe(1);
  });

  it('upgrade người ở giai đoạn có người duyệt: job bị chặn, người được; lần 2 no-op', async () => {
    const bid = await submitted();
    settings.forceMode = 'co_nguoi_duyet';
    await expect(an.upgrade(pool, bid, OTS_CFG, noGet)).rejects.toThrow('người duyệt');
    const r = await an.upgrade(pool, bid, OTS_CFG, async () => btcBody(850003), 'Người Duyệt Neo');
    expect(r.status).toBe('da_nang_cap');
    expect(r.heights).toEqual([850003n]);
    expect(
      await one(
        "select created_by from anchor_receipts where batch_id = $1 and status = 'da_nang_cap'",
        [bid],
      ),
    ).toBe('Người Duyệt Neo');
    expect((await an.upgrade(pool, bid, OTS_CFG, noGet, 'Người Duyệt Neo')).new).toBe(false);
  });

  it('upgrade job: trigger chặn da_nang_cap thứ 2 (23505); lịch sử trùng cũ giữ + báo', async () => {
    const bid = await submitted();
    expect((await an.upgrade(pool, bid, OTS_CFG, async () => btcBody(850004))).new).toBe(true);
    await raises(
      'insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)' +
        " select batch_id, provider, status, calendar, receipt, 'agent:anchor' from anchor_receipts" +
        " where batch_id = $1 and status = 'da_nang_cap'",
      [bid],
      '23505',
    );
    expect(await count('anchor_receipts', "batch_id = $1 and status = 'da_nang_cap'", [bid])).toBe(
      1,
    );
    // lịch sử trước r14 có 2 da_nang_cap (FIXTURE khi tắt trigger)
    await pool.query('alter table anchor_receipts disable trigger anchor_receipts_upgrade_once');
    await pool.query(
      'insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)' +
        " select batch_id, provider, status, calendar, receipt, 'agent:anchor' from anchor_receipts" +
        " where batch_id = $1 and status = 'da_nang_cap'",
      [bid],
    );
    await pool.query('alter table anchor_receipts enable trigger anchor_receipts_upgrade_once');
    expect(await an.upgrade(pool, bid, OTS_CFG, noGet)).toEqual({
      id: bid,
      status: 'da_nang_cap',
      new: false,
      so_dong_nang_cap: 2,
    });
    expect(await count('anchor_receipts', "batch_id = $1 and status = 'da_nang_cap'", [bid])).toBe(
      2,
    );
  });

  it.each(['BadStatusLine', 'HTTPException', 'LineTooLong'])(
    'lỗi giao thức HTTP (%s) ở submit/upgrade → lỗi có kiểm soát, thử calendar kế',
    async (ename) => {
      await issued();
      const bid = (await an.build(pool, await nowAsOf())).id as string;
      const calls: string[] = [];
      let bad = ['https://cal-a', 'https://cal-b'];
      const exc = () => {
        const e = new Error('x');
        e.name = ename;
        return e;
      };
      const post: an.Post = async (u, body, t) => {
        calls.push(u);
        if (bad.some((b) => u.startsWith(b))) throw exc();
        return fakePost([])(u, body, t);
      };
      let r = await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, post);
      expect(r.status).toBe('loi');
      expect(r.errors).toEqual([`cal-a.test: ${ename}`, `cal-b.test: ${ename}`]);
      bad = ['https://cal-a'];
      calls.length = 0;
      r = await an.submit(pool, bid, OTS_CFG, an.CREATED_BY, post);
      expect(r.status).toBe('da_gui');
      expect(r.calendar).toBe('https://cal-b.test');
      expect(calls).toEqual(['https://cal-a.test/digest', 'https://cal-b.test/digest']);
      const u = await an.upgrade(pool, bid, OTS_CFG, async () => {
        throw exc();
      });
      expect(u.status).toBe('cho');
      expect(u.errors).toEqual([`cal-b.test: ${ename}`]);
    },
  );

  it('anchor --build chạy được bằng login dịch vụ job (svc_job) — job anchor_build', async () => {
    await issued();
    const login = `t_qrjob_${process.pid}`;
    const pw = `p${randomBytes(8).toString('hex')}`;
    await adminQuery(`drop role if exists ${login}`);
    await adminQuery(`create role ${login} login password '${pw}' in role svc_job`);
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = login;
    u.password = pw;
    u.pathname = `/${name}`;
    const job = createPool(u.toString());
    try {
      expect((await job.query('select session_user as s')).rows[0].s).toBe(login);
      const d: an.AnchorDeps = {
        io,
        env: DEV,
        connect: async () => ({ db: job, release: async () => {} }),
        lag: '0 minutes',
      };
      expect(await an.anchorMain({ build: true }, d)).toBe(0);
      expect(await one('select created_by from anchor_batches')).toBe(an.CREATED_BY);
      expect(await an.anchorMain({ verify: 'latest' }, d)).toBe(0);
    } finally {
      await job.end();
      await adminQuery(`drop role if exists ${login}`);
    }
  });

  it('anchor --submit --by <người> chế độ thực: login không ánh xạ → [từ chối] exit 1, 0 request', async () => {
    await issued();
    const bid = (await an.build(pool, await nowAsOf())).id as string;
    const cfgFile = join(TMP, `ots-h-${name}.json`);
    writeFileSync(
      cfgFile,
      JSON.stringify({
        provider: 'opentimestamps',
        opentimestamps: { calendars: OTS_CFG.calendars, timeout_s: 5 },
      }),
    );
    settings.forceMode = 'co_nguoi_duyet';
    const calls: Call[] = [];
    const d0 = await count('agent_action_log', "action = 'authz_denied'");
    const d: an.AnchorDeps = {
      io,
      env: { NODE_ENV: 'test', APPROVAL_ENFORCE: '1' },
      connect: lease,
      configFile: cfgFile,
      post: fakePost(calls),
      get: noGet,
    };
    out();
    expect(await an.anchorMain({ submit: bid, by: 'Quản lý AI' }, d)).toBe(1);
    expect(await an.anchorMain({ upgrade: bid, by: 'Quản lý AI' }, d)).toBe(1);
    expect(out()).toContain('[từ chối]');
    expect(calls).toEqual([]);
    expect(await count('anchor_receipts')).toBe(0);
    expect(await count('agent_action_log', "action = 'authz_denied'")).toBe(d0 + 2);
    // job (agent:anchor mặc định) ở giai đoạn có người duyệt → rollout chặn, exit 1
    expect(await an.anchorMain({ submit: bid }, d)).toBe(1);
    expect(out()).toContain('NGƯỜI duyệt');
    expect(calls).toEqual([]);
  });

  it('CLI anchor: --build (mới / không đổi / dry-run), --status, --verify, --export', async () => {
    await issued();
    // mốc gom lùi 5 phút (LAG) → bản ghi vừa tạo chưa vào; test đặt lag 0.
    const d: an.AnchorDeps = { io, env: DEV, connect: lease, lag: '0 minutes' };
    out();
    expect(await an.anchorMain({ build: true }, { ...d, lag: undefined })).toBe(1);
    expect(out()).toContain('chưa có nhật ký đã chain');
    expect(await an.anchorMain({ build: true, dryRun: true }, d)).toBe(0);
    expect(out()).toMatch(/\[ok\] lần gom #None \(dry-run\): \d+ lá, gốc [0-9a-f]{64}/);
    expect(await count('anchor_batches')).toBe(0);
    expect(await an.anchorMain({ build: true }, d)).toBe(0);
    let o = out();
    expect(o).toMatch(/\[ok\] lần gom #\d+ \(mới\)/);
    expect(o).toContain("[external-dep] provider 'none'");
    expect(await an.anchorMain({ build: true }, d)).toBe(0);
    expect(out()).toMatch(/\(không đổi\)/);
    expect(await an.anchorMain({ status: true }, d)).toBe(0);
    o = out();
    expect(o).toContain('provider: none');
    expect(o).toMatch(/ {2}#\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \d+ lá [0-9a-f]{16}… — chưa neo/);
    expect(await an.anchorMain({ verify: 'latest' }, d)).toBe(0);
    expect(out()).toMatch(/\[ok\] lần gom #\d+: khớp DB — chưa neo/);
    const outDir = join(TMP, `cli-out-${name}`);
    expect(await an.anchorMain({ export: 'latest', out: outDir }, d)).toBe(0);
    expect(out()).toContain('ots verify');
    expect(readdirSync(outDir)).toHaveLength(1);
    expect(await an.anchorMain({ verify: 'abc' }, d)).toBe(1);
    expect(out()).toContain("mã lần gom 'abc' sai");
    expect(await an.anchorMain({ verify: '999999999999999999999' }, d)).toBe(1);
    expect(out()).toContain('không có lần gom');
  });

  it('CLI anchor --build khi tắt → [err] exit 1 (Python ValueError), không ghi', async () => {
    await issued();
    settings.forceMode = 'tat';
    expect(await an.anchorMain({ build: true }, { io, env: DEV, connect: lease })).toBe(1);
    expect(out()).toContain('farming-06');
    expect(await count('anchor_batches')).toBe(0);
  });
});
