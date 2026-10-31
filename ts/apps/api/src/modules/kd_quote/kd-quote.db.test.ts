import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { generateFernetKey } from '@samsam/core/fernet';
import { autoApprove, decide, enqueue, expireOverdue } from '@samsam/core/ops/approval-queue';
import {
  run as directorRun,
  submit as directorSubmit,
  loadConfig,
} from '@samsam/core/ops/director';
import { businessDeadline } from '@samsam/core/ops/period';
import { wireCore } from '@samsam/core/ops/wire';
import { repoPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { HumanDenied } from '@samsam/core/security/auth';
import { loadVaultKey, type VaultKeys } from '@samsam/core/security/fernet';
import { check } from '@samsam/core/security/guardrail';
import { PII_RE } from '@samsam/core/security/pii';
import { adminQuery, createDbFromTemplate, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Form, intake } from '../channels/b2b-form.service.js';
import { FOOTER as B2B_FOOTER, dedupKey } from './da-b2b.js';
import {
  type DaB2bOpts,
  daB2bMain,
  type KdCatalogOpts,
  type KdQuoteOpts,
  kdCatalogMain,
  kdQuoteMain,
} from './kd-quote.command.js';
import * as kq from './kd-quote.js';
import * as svc from './kd-quote.service.js';

// Dịch phần DB của tests/test_kd_quote.py, test_da_b2b.py, test_kd_catalog.py, test_v14_p4_sales.py
// (sales-05 nhắc chốt đơn / mốc gửi / kết quả), test_rollout_enforce.py (biên DÙNG), test_v15_fix_p102.py
// (ghi qua *_human theo login). DB riêng `samsam_ts_kd_quote` dựng lại từ mẫu MỖI ca (như Python:
// schema tạm + ROLLBACK), xóa khi xong. Người trong test là tên GIẢ LẬP.

const NAME = 'samsam_ts_kd_quote';
const FX = repoPath('tests/fixtures/b2b');
const GOLD_FILE = join(FX, 'golden_MAU.json');
const MX_FILE = join(FX, 'matrix_MAU.json');
const BOM_FILE = join(FX, 'bom_MAU.json');
const GOLD = JSON.parse(readFileSync(GOLD_FILE, 'utf8'));
const MX = JSON.parse(readFileSync(MX_FILE, 'utf8'));
const MAU_CSV = repoPath('tests/fixtures/du_an/to_chuc_MAU.csv');
const H1 = 'mat-ong-sam-120ml-1hu';
const APPROVER = 'GD Ban Hang Gia Lap (test)';
const FIN = 'Tai Chinh Gia Lap (test)';
const PHONE = '0901234567';
const CNAME = 'Nguoi Lien He Mau';
const EMAIL = 'lienhe.mau@example.com';
const QNO = 'BG-20261012-7-abcdef12';
const SHIFT = loadConfig('sales').business_hours;
const PID = process.pid;

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('kd_quote (DB)', () => {
  let pool: pg.Pool;
  let tmp: string;
  let DAY: string;
  const keys: VaultKeys = loadVaultKey({ CONTACT_VAULT_KEY: generateFernetKey() });
  const logins: string[] = [];
  const extra: pg.Pool[] = [];

  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = []) =>
    Object.values((await q(sql, p))[0] ?? {})[0];
  const n = async (sql: string, p: unknown[] = []) =>
    Number(await one(`select count(*) ${sql}`, p));
  const lease = (db?: () => pg.Pool) => async () => ({
    db: (db ?? (() => pool))(),
    release: async () => {},
  });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };
  const deps = (s: ReturnType<typeof io>, db?: () => pg.Pool) => ({
    io: s.io,
    connect: lease(db),
    jobConnect: lease(db),
    wire: () => {},
    goldenFile: GOLD_FILE,
    matrixFile: MX_FILE,
  });
  const quote = async (o: KdQuoteOpts, db?: () => pg.Pool) => {
    const s = io();
    return { rc: await kdQuoteMain(o, deps(s, db)), ...s };
  };
  const b2b = async (o: DaB2bOpts, db?: () => pg.Pool) => {
    const s = io();
    return { rc: await daB2bMain(o, deps(s, db)), ...s };
  };
  const catalog = async (o: KdCatalogOpts) => {
    const s = io();
    return { rc: await kdCatalogMain(o, deps(s)), ...s };
  };
  const items = async () =>
    q(
      'select id::text as id, block, object_type, risk, status, qa_status, created_by, lane from approval_queue order by id',
    );

  // Login tạm `in role <role>` (role của cả cluster — tên có pid); `person` → ánh xạ human_logins.
  async function login(
    tag: string,
    role: string,
    person?: string,
    blocks = '{sales}',
  ): Promise<pg.Pool> {
    const name = `t_kdq_${tag}_${PID}`;
    const pw = `p${Math.random().toString(36).slice(2)}`;
    if (!logins.includes(name)) {
      await adminQuery(`drop role if exists ${name}`);
      await adminQuery(`create role ${name} login password '${pw}' in role ${role}`);
      logins.push(name);
    } else await adminQuery(`alter role ${name} password '${pw}'`);
    if (person) {
      await q(
        "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, $3, 'Chu Khoi Gia Lap (test)')",
        [name, person, blocks],
      );
    }
    const u = new URL(process.env.TS_TEST_ADMIN_URL as string);
    u.username = name;
    u.password = pw;
    u.pathname = `/${NAME}`;
    const p = createPool(u.toString());
    extra.push(p);
    return p;
  }

  async function cogs(sku: string, cost: number, approve = true): Promise<void> {
    const id = await one(
      "insert into cogs_versions (sku_key, cost_vnd, valid_from, created_by) values ($1, $2, '2026-01-01', 'GD San Xuat Gia Lap (test)') returning id",
      [sku, cost],
    );
    if (approve)
      await q('update cogs_versions set approved_by = $1, approved_at = now() where id = $2', [
        FIN,
        id,
      ]);
  }

  async function request(its: unknown[], org = 'Công ty MẪU B2B', phone = PHONE): Promise<string> {
    const form = {
      org_name: org,
      org_type: 'doanh_nghiep',
      region: 'Đà Nẵng',
      contact: { name: CNAME, phone, email: EMAIL },
      items: its,
      need_by: null,
    } as unknown as Form;
    const [rid, isNew] = await intake(pool, form, keys, DAY);
    expect(isNew).toBe(true);
    return String(rid);
  }

  async function approvedQuote(qno = QNO): Promise<string> {
    const qid = await directorSubmit(pool, {
      block: 'sales',
      objectType: 'b2b_quote',
      objectId: qno,
      title: `Báo giá ${qno}`,
      payload: `# Báo giá ${qno}\n\nTổng 1.000.000đ.\n`,
      createdBy: 'agent:kd_quote',
    });
    const [ok, msg] = await decide(pool, qid, 'Lan', 'approved');
    expect(ok, msg ?? '').toBe(true);
    return String(qid);
  }

  async function replica(sql: string, p: unknown[] = []): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('set session_replication_role = replica');
      await c.query(sql, p);
      await c.query('set session_replication_role = origin');
    } finally {
      c.release();
    }
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kdq-db-'));
  });
  beforeEach(async () => {
    for (const p of extra.splice(0)) await p.end();
    await pool?.end();
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
    wireCore(pool);
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    // r12 L2: báo giá chỉ đọc giá price_list ĐÃ duyệt — người (giả lập) duyệt giá golden đã nạp.
    await q(
      "update price_list set approved_by = 'GĐ Bán Hàng Giả Lập (test)', approved_at = now() where channel = 'shopee' and kind in ('list', 'floor') and approved_by is null and valid_to is null",
    );
    DAY = (await one('select max(valid_from)::text from price_list')) as string;
  });
  afterAll(async () => {
    settings.forceMode = null;
    for (const p of extra) await p.end();
    await pool?.end();
    await dropDb(NAME);
    for (const l of logins) await adminQuery(`drop role if exists ${l}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ báo giá
  it('trong ma trận → lane low pending (qa pass); 3 file không PII; chỉ tự đạt khi auto_policy ký; chạy lại skip', async () => {
    await cogs(H1, 300000);
    const rid = await request([{ key: H1, qty: 20 }]);
    await q(
      "insert into eval_runs (commit_sha, agent, n_total, n_pass, pass_rate, passed) values ($1, 'kd_a3', 18, 18, 1.0, true)",
      ['a'.repeat(40)],
    );
    const out = join(tmp, 'q1');
    let r = await quote({ quote: rid, submit: true, date: DAY, outDir: out });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.out.join('\n')).toContain('b2b_quote_matrix');
    expect(r.out.join('\n')).toContain('[done]');
    const it0 = (await items())[0];
    expect([
      it0.block,
      it0.object_type,
      it0.risk,
      it0.status,
      it0.qa_status,
      it0.created_by,
    ]).toEqual(['sales', 'b2b_quote_matrix', 'low', 'pending', 'pass', 'agent:kd_quote']);
    const files = readdirSync(out);
    expect(files.length).toBe(3);
    expect(files.some((f) => f.endsWith('-noi-bo.md'))).toBe(true);
    for (const f of files) {
      const body = readFileSync(join(out, f), 'utf8');
      for (const x of [PHONE, CNAME, EMAIL]) expect(body).not.toContain(x);
    }
    await directorRun(pool, 'sales', { outDir: join(tmp, 'rep') });
    expect((await items())[0]?.status).toBe('pending'); // không có luật đã ký → không tự duyệt
    await q(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('b2b_matrix_auto', 'b2b_quote_matrix', 'low', true, 'Chu Khoi Gia Lap (test)', now())",
    );
    await directorRun(pool, 'sales', { outDir: join(tmp, 'rep') });
    const it1 = (await items())[0];
    expect([it1?.status, it1?.lane]).toEqual(['approved', 'auto_policy']);
    r = await quote({ quote: rid, submit: true, date: DAY, outDir: out });
    expect(r.rc).toBe(0);
    expect(r.out.join('\n')).toContain('[skip]');
    expect((await items()).length).toBe(1);
  });

  it('ngoài ma trận (CK 10) → b2b_quote risk high; auto_policy không áp risk high', async () => {
    await cogs(H1, 300000);
    const rid = await request([{ key: H1, qty: 20 }]);
    const r = await quote({ quote: rid, submit: true, discount: '10', date: DAY, outDir: tmp });
    expect(r.rc, r.err.join('\n')).toBe(0);
    const [it0] = await items();
    expect([it0?.block, it0?.object_type, it0?.risk, it0?.status]).toEqual([
      'sales',
      'b2b_quote',
      'high',
      'pending',
    ]);
    await q(
      "insert into auto_policies (id, object_type, max_risk, enabled, signed_by, signed_at) values ('b2b_q_auto', 'b2b_quote', 'low', true, 'Chu Khoi Gia Lap (test)', now())",
    );
    const [ok, msg] = await autoApprove(pool, it0?.id);
    expect(ok).toBe(false);
    expect(msg).toContain('rủi ro high');
    await directorRun(pool, 'sales', { outDir: join(tmp, 'rep') });
    expect((await items())[0]?.status).toBe('pending');
  });

  it('biên dưới ngưỡng → 2 mục CÙNG giao dịch (lỗi mục 2 → 0 mục); chạy lại → []', async () => {
    await cogs(H1, 600000);
    const rid = await request([{ key: H1, qty: 20 }]);
    const req = (await svc.fetchRequest(pool, rid)) as kq.QuoteRequest;
    const res = kq.classify(req.items, MX, GOLD, [], await svc.fetchVersions(pool), DAY);
    expect(res.reasons).toEqual(['bien_duoi_nguong']);
    const built = kq.buildQuote(req, res, GOLD, DAY, MX);
    const flaky: typeof directorSubmit = async (db, a) => {
      if (a.block === 'finance') throw new Error('lỗi giả ở mục 2');
      return directorSubmit(db, a);
    };
    await expect(svc.submitQuote(pool, req, built, res, flaky)).rejects.toThrow('lỗi giả');
    expect(await items()).toEqual([]);
    const ids = await svc.submitQuote(pool, req, built, res);
    expect(ids.length).toBe(2);
    expect((await items()).map((r) => [r.block, r.object_type, r.risk])).toEqual([
      ['sales', 'b2b_quote', 'high'],
      ['finance', 'b2b_margin_review', 'high'],
    ]);
    const fin = (await one("select payload from approval_queue where block = 'finance'")) as string;
    expect(fin).toContain('bien_duoi_nguong');
    expect(fin).toContain('KHÔNG gửi khách');
    expect(await svc.submitQuote(pool, req, built, res)).toEqual([]);
    expect((await items()).length).toBe(2);
  });

  it('thiếu giá vốn ĐÃ duyệt → thêm mục tài chính rà biên', async () => {
    await cogs(H1, 300000, false);
    const rid = await request([{ key: H1, qty: 20 }]);
    const r = await quote({ quote: rid, submit: true, date: DAY, outDir: tmp });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect((await items()).map((x) => [x.block, x.object_type])).toEqual([
      ['sales', 'b2b_quote'],
      ['finance', 'b2b_margin_review'],
    ]);
  });

  it('yêu cầu có rượu → exit 1, KHÔNG báo giá, 0 mục, 0 file', async () => {
    const rid = await request([{ key: H1, qty: 20 }]);
    const row = (
      await q('select contact_id, consent_id from b2b_requests where id = $1', [rid])
    )[0];
    const bad = await one(
      "insert into b2b_requests (request_key, org_name, org_type, region, items, contact_id, consent_id, source) values ($1, 'Công ty MẪU Y', 'doanh_nghiep', 'Đà Nẵng', $2::jsonb, $3, $4, 'test') returning id",
      [
        `b2r:${'f'.repeat(64)}`,
        JSON.stringify([
          { key: H1, qty: 20 },
          { key: 'ruou-sam-chai-thuy-tinh-500ml', qty: 10 },
        ]),
        row?.contact_id,
        row?.consent_id,
      ],
    );
    const out = join(tmp, 'ruou');
    const r = await quote({ quote: String(bad), submit: true, date: DAY, outDir: out });
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toContain('ruou_khong_bao_gia');
    expect(await items()).toEqual([]);
    expect(() => readdirSync(out)).toThrow();
  });

  it('không thấy yêu cầu → exit 1; --requests không lộ SĐT/tên/email người liên hệ', async () => {
    expect((await quote({ quote: '999999999', dryRun: true })).rc).toBe(1);
    await request([{ key: H1, qty: 20 }]);
    const r = await quote({ requests: true });
    expect(r.rc).toBe(0);
    const out = r.out.join('\n');
    expect(out).toContain('Công ty MẪU B2B');
    expect(out).toContain('1 yêu cầu');
    for (const x of [PHONE, CNAME, EMAIL]) expect(out).not.toContain(x);
  });

  it('--export / --verify-send: chỉ bản ĐÃ duyệt, KHỚP sha256; sửa/thêm byte/quá lớn/không UTF-8/sai loại → 1', async () => {
    await cogs(H1, 300000);
    const rid = await request([{ key: H1, qty: 20 }]);
    const d = join(tmp, 'd');
    expect((await quote({ quote: rid, submit: true, date: DAY, outDir: d })).rc).toBe(0);
    const qid = (await items())[0]?.id as string;
    const md = join(tmp, 'bg.md');
    const ht = join(tmp, 'bg.html');
    expect((await quote({ export: qid, out: md })).rc).toBe(1); // pending
    const draft = join(d, readdirSync(d).find((f) => /^bao-gia-.*[0-9a-f]\.md$/.test(f)) as string);
    expect((await quote({ verifySend: [qid, draft] })).rc).toBe(1);
    const [ok, msg] = await decide(pool, qid, APPROVER, 'approved');
    expect(ok, msg ?? '').toBe(true);
    expect((await quote({ export: qid, out: md })).rc).toBe(0);
    expect((await quote({ export: qid, out: ht })).rc).toBe(0);
    expect((await quote({ verifySend: [qid, md] })).rc).toBe(0);
    const r = await quote({ verifySend: [qid, ht] });
    expect(r.rc).toBe(0);
    expect(r.out.join('\n')).toContain('KHỚP bản đã duyệt');
    expect(readFileSync(md)).toEqual(readFileSync(draft)); // nháp == bản duyệt
    for (const f of [md, ht]) {
      const data = readFileSync(f);
      const bad = join(tmp, `x${f.endsWith('.md') ? '.md' : '.html'}`);
      writeFileSync(bad, Buffer.from(data.toString('utf8').replace('707.000', '706.000')));
      expect((await quote({ verifySend: [qid, bad] })).rc).toBe(1);
      writeFileSync(bad, Buffer.concat([data, Buffer.from(' ')]));
      expect((await quote({ verifySend: [qid, bad] })).rc).toBe(1);
    }
    const big = join(tmp, 'big.md');
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    expect((await quote({ verifySend: [qid, big] })).rc).toBe(1);
    const nu = join(tmp, 'nu.md');
    writeFileSync(nu, Buffer.concat([readFileSync(md), Buffer.from([0xff])]));
    expect((await quote({ verifySend: [qid, nu] })).rc).toBe(1);
    expect((await quote({ export: qid, out: join(tmp, 'x.pdf') })).rc).toBe(1);
    // mục khác loại đã duyệt (khối ceo) → sai loại
    const pq = await enqueue(pool, {
      objectType: 'change_request',
      objectId: 'p-1',
      block: 'ceo',
      title: 'Hồ sơ',
      payload: 'Hồ sơ mẫu',
      risk: 'high',
      createdBy: 'agent:test',
      slaHours: 72,
    });
    expect((await decide(pool, pq, APPROVER, 'approved'))[0]).toBe(true);
    const pf = join(tmp, 'p.md');
    writeFileSync(pf, 'Hồ sơ mẫu');
    expect((await quote({ verifySend: [String(pq), pf] })).rc).toBe(1);
    expect((await quote({ export: String(pq), out: join(tmp, 'p2.md') })).rc).toBe(1);
    expect((await quote({ verifySend: ['999999999', md] })).rc).toBe(1);
  });

  it('bị từ chối → không gửi, không xuất được', async () => {
    await cogs(H1, 300000);
    const rid = await request([{ key: H1, qty: 20 }]);
    const d = join(tmp, 'rj');
    expect((await quote({ quote: rid, submit: true, date: DAY, outDir: d })).rc).toBe(0);
    const qid = (await items())[0]?.id as string;
    expect((await decide(pool, qid, APPROVER, 'rejected'))[0]).toBe(true);
    const draft = join(d, readdirSync(d).find((f) => /^bao-gia-.*[0-9a-f]\.md$/.test(f)) as string);
    expect((await quote({ verifySend: [qid, draft] })).rc).toBe(1);
    expect((await quote({ export: qid, out: join(tmp, 'r.md') })).rc).toBe(1);
  });

  it('biên DÙNG HĐ 6.7: chạy thử → không xuất / không KHỚP dù đã duyệt; vận hành → được', async () => {
    const qid = await approvedQuote();
    const payload = (await one('select payload from approval_queue where id = $1', [
      qid,
    ])) as string;
    const f = join(tmp, 'use.md');
    writeFileSync(f, payload);
    settings.forceMode = 'chay_thu';
    expect(await svc.verifySend(pool, qid, f)).toBe(false);
    expect((await svc.exportApproved(pool, qid, join(tmp, 'o1.md')))[0]).toBe(false);
    settings.forceMode = 'van_hanh';
    expect(await svc.verifySend(pool, qid, f)).toBe(true);
    expect((await svc.exportApproved(pool, qid, join(tmp, 'o2.md')))[0]).toBe(true);
  });

  it('cổng TẮT (sales-05): --quote / catalog --build / --followups → [rollout] exit 2, 0 file, 0 mục', async () => {
    await cogs(H1, 300000);
    const rid = await request([{ key: H1, qty: 20 }]);
    settings.forceMode = 'tat';
    const out = join(tmp, 'tat');
    let r = await quote({ quote: rid, submit: true, date: DAY, outDir: out });
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('[rollout]');
    const c = await catalog({ build: true, bom: BOM_FILE, date: DAY, outDir: out });
    expect(c.rc).toBe(2);
    expect(c.out.join('\n')).toContain('[rollout]');
    r = await quote({ followups: true });
    expect(r.rc).toBe(2);
    expect(r.err.join('\n')).toContain('[rollout]');
    expect(() => readdirSync(out)).toThrow();
    expect(await items()).toEqual([]);
  });

  // ------------------------------------------------------------ sales-05 mốc gửi / kết quả / nhắc
  it('record_event: chỉ báo giá ĐÃ duyệt; kết quả cần tên NGƯỜI; mốc gửi không cần tên', async () => {
    const pend = await directorSubmit(pool, {
      block: 'sales',
      objectType: 'b2b_quote',
      objectId: 'BG-20261012-8-abcdef12',
      title: 't',
      payload: '# Báo giá\n',
      createdBy: 'agent:kd_quote',
    });
    await expect(svc.recordEvent(pool, pend, 'chot', 'Lan')).rejects.toThrow('ĐÃ duyệt');
    const qid = await approvedQuote();
    for (const by of [null, ' ', 'agent:kd_quote', 'System:x']) {
      await expect(svc.recordEvent(pool, qid, 'chot', by)).rejects.toThrow('NGƯỜI');
    }
    await expect(svc.recordEvent(pool, qid, 'thang', 'Lan')).rejects.toThrow('kết quả phải');
    await expect(svc.recordEvent(pool, qid, 'chot', 'x'.repeat(101))).rejects.toThrow('1..100');
    expect(await svc.recordEvent(pool, qid, 'da_gui')).toBeGreaterThan(0n);
  });

  it('CLI --verify-send ghi mốc da_gui; --outcome ghi 1 lần, không ghi đè', async () => {
    const qid = await approvedQuote();
    const payload = (await one('select payload from approval_queue where id = $1', [
      qid,
    ])) as string;
    const f = join(tmp, 'bg.md');
    writeFileSync(f, payload);
    expect((await quote({ verifySend: [qid, f], by: 'Lan' })).rc).toBe(0);
    expect(await q('select kind, recorded_by from b2b_quote_events')).toEqual([
      { kind: 'da_gui', recorded_by: 'Lan' },
    ]);
    writeFileSync(f, 'khac');
    expect((await quote({ verifySend: [qid, f] })).rc).toBe(1);
    expect(await n('from b2b_quote_events')).toBe(1);
    const ok = await quote({ outcome: [qid, 'chot'], by: 'Lan' });
    expect(ok.rc).toBe(0);
    expect(ok.out.join('\n')).toContain('đã chốt');
    const again = await quote({ outcome: [qid, 'huy'], by: 'Lan' });
    expect(again.rc).toBe(1);
    expect(again.err.join('\n')).toContain('không ghi đè');
  });

  const fu = (now: Date, cfg = { after_business_hours: 24, max_reminders: 2 }) =>
    svc.followupItems(pool, now, cfg, SHIFT);
  const utcKey = async (sql: string, id: string) =>
    one(
      `select to_char(${sql} at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS"Z"') from approval_queue a where a.id = $1`,
      [id],
    );
  const days = (d: Date, k: number) => new Date(d.getTime() + k * 86400_000);

  it('nhắc chốt đơn: sau N giờ làm việc → NHÁP; đang pending không thêm; đợt k+1 sau quyết; tối đa max_reminders', async () => {
    const qid = await approvedQuote();
    const base = (await one('select decided_at from approval_queue where id = $1', [qid])) as Date;
    const due = businessDeadline(base, 24, SHIFT);
    expect(await fu(new Date(due.getTime() - 60_000))).toEqual([]);
    const got = await fu(due);
    expect(got.length).toBe(1);
    const key = `fu:${qid}:${await utcKey('a.decided_at', qid)}`;
    const it0 = got[0] as svc.FollowupItem;
    expect(it0.object_id).toBe(`${key}:1`);
    expect(it0.payload).toContain(QNO);
    expect(it0.payload).toContain('CHƯA xác nhận gửi');
    expect(check(it0.payload).ok).toBe(true);
    const sub = (x: svc.FollowupItem) =>
      directorSubmit(pool, {
        block: 'sales',
        objectType: 'b2b_followup',
        objectId: x.object_id,
        title: x.title,
        payload: x.payload,
        createdBy: 'agent:kd_quote',
      });
    const r1 = await sub(it0);
    expect(await fu(days(due, 30))).toEqual([]); // đang pending
    expect((await decide(pool, r1, 'Lan', 'approved'))[0]).toBe(true);
    const dec = (await one('select decided_at from approval_queue where id = $1', [
      String(r1),
    ])) as Date;
    const nxt = await fu(businessDeadline(dec, 24, SHIFT));
    expect(nxt.map((x) => x.object_id)).toEqual([`${key}:2`]);
    const r2 = await sub(nxt[0] as svc.FollowupItem);
    expect((await decide(pool, r2, 'Lan', 'rejected'))[0]).toBe(true);
    expect(await fu(days(due, 60))).toEqual([]); // max_reminders 2
  });

  it('nhắc chốt đơn: đã gửi → mốc mới; đã ghi kết quả → dừng; b2b_quote_events append-only', async () => {
    const qid = await approvedQuote();
    const base = (await one('select decided_at from approval_queue where id = $1', [qid])) as Date;
    const sent = days(base, 3);
    await q(
      "insert into b2b_quote_events (queue_id, quote_no, kind, created_at) values ($1, $2, 'da_gui', $3)",
      [qid, QNO, sent],
    );
    const due = businessDeadline(sent, 24, SHIFT);
    expect(await fu(new Date(due.getTime() - 60_000))).toEqual([]);
    const it0 = (await fu(due))[0] as svc.FollowupItem;
    const sk = await one(
      `select to_char(created_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS"Z"') from b2b_quote_events where queue_id = $1`,
      [qid],
    );
    expect(it0.object_id).toBe(`fu:${qid}:${sk}:1`);
    expect(it0.payload).toContain('đã gửi lúc');
    await svc.recordEvent(pool, qid, 'khong_chot', 'Lan');
    await expect(svc.recordEvent(pool, qid, 'chot', 'Mai')).rejects.toThrow('đã ghi kết quả');
    expect(await fu(days(due, 10))).toEqual([]);
    await expect(q('delete from b2b_quote_events')).rejects.toThrow();
  });

  it('run_followups bằng login dịch vụ svc_job: dry-run 0 ghi, đẩy 1, chạy lại 0; tính năng TẮT → RolloutBlocked', async () => {
    const qid = await approvedQuote();
    const now = businessDeadline(
      (await one('select decided_at from approval_queue where id = $1', [qid])) as Date,
      24,
      SHIFT,
    );
    const job = await login('job', 'svc_job');
    expect(await svc.runFollowups(job, now, true)).toEqual({ found: 1, enqueued: 0 });
    expect(await n("from approval_queue where object_type = 'b2b_followup'")).toBe(0);
    expect((await svc.runFollowups(job, now)).enqueued).toBe(1);
    expect((await svc.runFollowups(job, now)).enqueued).toBe(0);
    const row = (
      await q("select created_by, status from approval_queue where object_type = 'b2b_followup'")
    )[0];
    expect(row).toEqual({ created_by: 'agent:kd_quote', status: 'pending' });
    settings.forceMode = 'tat';
    await expect(svc.runFollowups(job, days(now, 30))).rejects.toBeInstanceOf(RolloutBlocked);
    expect(await n("from approval_queue where object_type = 'b2b_followup'")).toBe(1);
    settings.forceMode = 'van_hanh';
    const r = await quote({ followups: true, dryRun: true }, () => job);
    expect(r.rc).toBe(0);
    expect(r.out[0]).toMatch(/^\[dry-run\] báo giá cần nhắc \d+ · đẩy 0 mục nhắc — KHÔNG ghi DB/);
  });

  it('*_human theo login (P10.2): chỉ NGƯỜI của chính login ghi mốc gửi/kết quả; khác người / chưa ánh xạ → từ chối, 0 ghi', async () => {
    const text = '# Báo giá giả P102\n\nHộp quà Tết 2 hộp — 1.000.000 đ\n';
    const qid = String(
      await directorSubmit(pool, {
        block: 'sales',
        objectType: 'b2b_quote',
        objectId: 'BG-20261018-1-a1020001',
        title: 't',
        payload: text,
        createdBy: 'agent:kd_quote',
      }),
    );
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    const md = join(tmp, 'p102.md');
    writeFileSync(md, text);
    const bad = join(tmp, 'p102-sua.md');
    writeFileSync(bad, `${text}giảm thêm 50%\n`);
    const sales = await login('sales', 'app_human', 'Lan Ban Hang (test)');
    const nomap = await login('nomap', 'app_human');
    const ev = async () =>
      q('select kind, recorded_by from b2b_quote_events where queue_id = $1 order by id', [qid]);
    for (const [db, by] of [
      [sales, 'agent:p102'],
      [sales, 'Ceo Gia Lap (test)'],
      [nomap, 'Khong Anh Xa (test)'],
    ] as const) {
      const v = await quote({ verifySend: [qid, md], by }, () => db);
      expect(v.rc, by).toBe(1);
      expect(v.err.join('\n')).toContain('[từ chối]');
      const o = await quote({ outcome: [qid, 'chot'], by }, () => db);
      expect(o.rc, by).toBe(1);
      expect(o.err.join('\n')).toContain('[từ chối]');
      expect(await ev()).toEqual([]);
    }
    expect(
      (await quote({ verifySend: [qid, bad], by: 'Lan Ban Hang (test)' }, () => sales)).rc,
    ).toBe(1);
    const ok = await quote({ verifySend: [qid, md], by: 'Lan Ban Hang (test)' }, () => sales);
    expect(ok.rc, ok.err.join('\n')).toBe(0);
    expect(ok.err.join('\n')).not.toContain('không ghi được');
    expect(await ev()).toEqual([{ kind: 'da_gui', recorded_by: 'Lan Ban Hang (test)' }]);
    expect(
      (await quote({ outcome: [qid, 'chot'], by: 'Lan Ban Hang (test)' }, () => sales)).rc,
    ).toBe(0);
    for (const k of ['chot', 'huy']) {
      const r = await quote({ outcome: [qid, k], by: 'Lan Ban Hang (test)' }, () => sales);
      expect(r.rc).toBe(1);
      expect(r.err.join('\n')).toContain('đã ghi kết quả');
    }
    await expect(
      svc.recordEvent(nomap, qid, 'da_gui', 'Khong Anh Xa (test)'),
    ).rejects.toBeInstanceOf(HumanDenied);
    await expect(
      sales.query(
        "insert into b2b_quote_events (queue_id, quote_no, kind, recorded_by) values ($1, 'BG-x', 'da_gui', 'Ceo')",
        [qid],
      ),
    ).rejects.toThrow('permission denied');
  });

  // ------------------------------------------------------------ da_b2b
  const batch = async (limit = '15') => {
    expect((await b2b({ import: MAU_CSV, by: 'Người nhập MẪU' })).rc).toBe(0);
    expect((await b2b({ submitBatch: true, limit })).rc).toBe(0);
    return String(
      await one("select max(id) from approval_queue where object_type = 'org_prospect_batch'"),
    );
  };
  const nOrg = (where = 'true', p: unknown[] = []) => n(`from org_prospects where ${where}`, p);
  const nBatch = () => n("from approval_queue where object_type = 'org_prospect_batch'");

  it('nạp ×2 idempotent, không PII, nguồn manual:<file>', async () => {
    let r = await b2b({ import: MAU_CSV, by: 'MẪU' });
    expect(r.rc).toBe(0);
    expect(r.out.join('\n')).toContain('inserted=16');
    r = await b2b({ import: MAU_CSV, by: 'MẪU' });
    expect(r.out.join('\n')).toContain('inserted=0 dup=16');
    expect(await nOrg()).toBe(16);
    const cols = (
      await q(
        "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'org_prospects' and data_type = 'text'",
      )
    )
      .map((x) => x.column_name as string)
      .filter((c) => c !== 'dedup_key');
    expect(cols.length).toBeGreaterThanOrEqual(8);
    expect(await nOrg("dedup_key !~ '^b2b:[0-9a-f]{64}$'")).toBe(0);
    let hits = 0;
    for (const row of await q(`select ${cols.join(', ')} from org_prospects`)) {
      for (const v of Object.values(row)) if (PII_RE.test(String(v ?? ''))) hits++;
    }
    expect(hits).toBe(0);
    expect(await q('select distinct source, status from org_prospects')).toEqual([
      { source: 'manual:to_chuc_MAU.csv', status: 'moi' },
    ]);
    r = await b2b({ list: true, status: 'moi' });
    expect(r.out.join('\n')).toContain('[done] 16 tổ chức');
  });

  it('lô → 1 mục pending (created_by = người nhập); chỉ chuyển chuyen_sales khi NGƯỜI duyệt', async () => {
    const qid = await batch();
    const row = (
      await q(
        'select block, object_type, status, created_by, payload from approval_queue where id = $1',
        [qid],
      )
    )[0];
    expect([row?.block, row?.object_type, row?.status, row?.created_by]).toEqual([
      'sales',
      'org_prospect_batch',
      'pending',
      'Người nhập MẪU',
    ]);
    expect(row?.payload).toContain(B2B_FOOTER);
    expect(row?.payload).toContain('15 tổ chức');
    expect(await nBatch()).toBe(1);
    expect(await nOrg("status = 'cho_duyet' and batch_queue_id = $1", [qid])).toBe(15);
    expect(await nOrg("status = 'moi'")).toBe(1);
    expect((await b2b({ handover: qid, by: 'X' })).rc).toBe(1);
    expect(await nOrg("status = 'chuyen_sales'")).toBe(0);
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    let r = await b2b({ handover: qid, by: 'X' });
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(r.out.join('\n')).toContain('15 tổ chức → chuyen_sales');
    expect(await nOrg("status = 'chuyen_sales' and handed_at is not null")).toBe(15);
    r = await b2b({ handover: qid, by: 'X' });
    expect(r.rc).toBe(0);
    expect(r.out.join('\n')).toContain('0 tổ chức');
    expect((await b2b({ submitBatch: true })).rc).toBe(0);
    r = await b2b({ submitBatch: true });
    expect(r.out.join('\n')).toContain('không có lô');
    expect(await nBatch()).toBe(2);
  });

  it('người nhập không tự duyệt lô của mình', async () => {
    const qid = await batch();
    expect((await decide(pool, qid, 'Người nhập MẪU', 'approved'))[0]).toBe(false);
    expect(await one('select status from approval_queue where id = $1', [qid])).toBe('pending');
  });

  it('lô không bao giờ trộn người nhập (mỗi lô 1 người nhập)', async () => {
    expect((await b2b({ import: MAU_CSV, by: 'A MẪU' })).rc).toBe(0);
    await q(
      "update org_prospects set created_by = 'B MẪU' where id in (select id from org_prospects order by id desc limit 3)",
    );
    expect((await b2b({ submitBatch: true })).rc).toBe(0);
    expect((await b2b({ submitBatch: true })).rc).toBe(0);
    const rows = await q(
      "select created_by from approval_queue where object_type = 'org_prospect_batch' order by id",
    );
    expect(rows.map((r) => r.created_by)).toEqual(['A MẪU', 'B MẪU']);
    expect(await nOrg("status = 'cho_duyet'")).toBe(16);
  });

  it('sửa dữ liệu sau duyệt → LỆCH sha → 0 dòng đổi', async () => {
    const qid = await batch();
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    await q(
      "update org_prospects set fit_reason = 'MẪU — sửa sau duyệt' where id = (select min(id) from org_prospects)",
    );
    const r = await b2b({ handover: qid, by: 'X' });
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toContain('LỆCH');
    expect(await nOrg("status = 'chuyen_sales'")).toBe(0);
    expect(await nOrg("status = 'cho_duyet'")).toBe(15);
  });

  it('lô bị từ chối / hết hạn SLA → dòng về moi, lập lô mới được', async () => {
    let qid = await batch();
    expect((await decide(pool, qid, APPROVER, 'rejected'))[0]).toBe(true);
    expect((await b2b({ handover: qid, by: 'X' })).rc).toBe(0);
    expect(await nOrg("status = 'moi' and batch_queue_id is null")).toBe(16);
    expect((await b2b({ handover: qid, by: 'X' })).rc).toBe(0);
    expect(await nOrg("status = 'moi'")).toBe(16);
    expect((await b2b({ submitBatch: true, limit: '15' })).rc).toBe(0);
    qid = String(await one('select max(id) from approval_queue'));
    await replica("update approval_queue set due_at = now() - interval '1 h' where id = $1", [qid]);
    expect(await expireOverdue(pool)).toBe(1);
    const r = await b2b({ handover: qid, by: 'X' });
    expect(r.out.join('\n')).toContain("hết hạn SLA — 15 dòng về 'moi'");
    expect(await nOrg("status = 'moi' and batch_queue_id is null")).toBe(16);
    expect((await b2b({ submitBatch: true, limit: '15' })).rc).toBe(0);
    const q2 = String(await one('select max(id) from approval_queue'));
    expect(q2).not.toBe(qid);
    expect((await decide(pool, q2, APPROVER, 'approved'))[0]).toBe(true);
    expect((await b2b({ handover: q2, by: 'X' })).rc).toBe(0);
    expect(await nOrg("status = 'chuyen_sales'")).toBe(15);
  });

  it('handover: mục sai loại / không có → 1; lô cũ khối projects không kẹt', async () => {
    const cq = await directorSubmit(pool, {
      block: 'sales',
      objectType: 'b2b_quote',
      objectId: 'quote:mau000000002',
      title: 'Báo giá MẪU',
      payload: '# Báo giá MẪU\n',
      createdBy: 'agent:kd_quote',
    });
    expect((await b2b({ handover: String(cq), by: 'X' })).rc).toBe(1);
    expect((await b2b({ handover: '999999', by: 'X' })).rc).toBe(1);
    const qid = await batch();
    await replica("update approval_queue set block = 'projects' where id = $1", [qid]);
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    expect((await b2b({ handover: qid, by: 'X' })).rc).toBe(0);
    expect(await nOrg("status = 'chuyen_sales'")).toBe(15);
    expect((await b2b({ submitBatch: true })).rc).toBe(0);
    const q2 = String(await one('select max(id) from approval_queue'));
    await replica("update approval_queue set block = 'projects' where id = $1", [q2]);
    expect((await decide(pool, q2, APPROVER, 'rejected'))[0]).toBe(true);
    expect((await b2b({ handover: q2, by: 'X' })).rc).toBe(0);
    expect(await nOrg("status = 'moi' and batch_queue_id is null")).toBe(1);
  });

  it('handover qua org_*_human theo login: người đã ánh xạ → chuyển; login chưa ánh xạ → [từ chối]', async () => {
    const qid = await batch();
    expect((await decide(pool, qid, APPROVER, 'approved'))[0]).toBe(true);
    const nomap = await login('nomap2', 'app_human');
    let r = await b2b({ handover: qid, by: 'Khong Anh Xa (test)' }, () => nomap);
    expect(r.rc).toBe(1);
    expect(r.err.join('\n')).toContain('[từ chối]');
    expect(await nOrg("status = 'chuyen_sales'")).toBe(0);
    const sales = await login('sales2', 'app_human', 'Lan Ban Hang (test)');
    r = await b2b({ handover: qid, by: 'Lan Ban Hang (test)' }, () => sales);
    expect(r.rc, r.err.join('\n')).toBe(0);
    expect(await nOrg("status = 'chuyen_sales'")).toBe(15);
    expect(dedupKey('Khách sạn MẪU A', 'Đà Nẵng')).toMatch(/^b2b:/);
  });

  // ------------------------------------------------------------ kd_catalog
  it('catalog: hàng duyệt b2b_catalog risk high; chạy lại skip; chỉ xuất/khớp bản ĐÃ duyệt; không dùng như báo giá', async () => {
    // r12 L2: readiness view DB — giả lập SKU MẪU đã đủ điều kiện (phạm vi ca cũ).
    await q(
      "update sku_master set allowed_channels = '{shopee,web}', self_declaration_ok = true where category = 'food'",
    );
    await q(
      "update sku_master set allowed_channels = '{shopee,web}', xnqc_status = 'approved' where sku_key = 'savina-12v'",
    );
    let r = await catalog({ submit: true, bom: BOM_FILE, date: DAY });
    expect(r.rc, r.err.join('\n')).toBe(0);
    const rows = await q(
      'select id::text as id, block, object_type, risk, status, payload from approval_queue',
    );
    expect(rows.length).toBe(1);
    const row = rows[0] as Record<string, string>;
    expect([row.block, row.object_type, row.risk, row.status]).toEqual([
      'sales',
      'b2b_catalog',
      'high',
      'pending',
    ]);
    for (const x of [
      'ruou-sam-chai-thuy-tinh-500ml',
      'Rượu',
      'hop-qua-cao-cap-mau',
      'hop-sum-vay-mau',
      'Saphraton 80',
    ]) {
      expect(row.payload.toLowerCase()).not.toContain(x.toLowerCase());
    }
    r = await catalog({ submit: true, bom: BOM_FILE, date: DAY });
    expect(r.out.join('\n')).toContain('[skip]');
    const out = join(tmp, 'c.html');
    expect((await catalog({ export: row.id, out })).rc).toBe(1);
    expect((await decide(pool, row.id, APPROVER, 'approved'))[0]).toBe(true);
    expect((await catalog({ export: row.id, out })).rc).toBe(0);
    expect((await catalog({ verifySend: [row.id, out] })).rc).toBe(0);
    const data = readFileSync(out);
    writeFileSync(out, Buffer.from(data.toString('utf8').replace(/(\d)\.000đ/, '$1.001đ')));
    expect((await catalog({ verifySend: [row.id, out] })).rc).toBe(1);
    writeFileSync(out, data);
    expect((await quote({ verifySend: [row.id, out] })).rc).toBe(1); // catalog không phải báo giá
  });
});
