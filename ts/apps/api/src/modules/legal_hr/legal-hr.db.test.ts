import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { decide } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { settings } from '@samsam/core/rollout/counters';
import { check } from '@samsam/core/security/guardrail';
import { adminQuery, createDbFromTemplate, dropDb, testDbName } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Io } from './common.js';
import { type PcHrOpts, pcHrMain } from './pc-hr.command.js';
import { type XnqcOpts, xnqcMain } from './xnqc.command.js';
import * as x from './xnqc.js';

// Dịch phần DB của tests/test_pc_hr.py (3 thao tác đẩy hàng duyệt legal_hr + chống trùng + log),
// tests/test_xnqc.py (CHECK/FK chặn ghi thẳng, luồng đủ trạng thái + golden KHÔNG đổi, đề xuất đồng bộ
// THAY THẾ mục lỗi thời / chờ người sửa golden, CLI list/remind/sync), tests/test_r12_dot4.py (nháp
// cùng nội dung → [skip] mục cũ), tests/test_v15_p10_human_authz.py::test_p10_1_xnqc_add_and_set_…
// + test_v14_p2_service_auth (danh tính theo login `*_human`, cliGate chế độ thực → authz_denied) và
// cổng TẮT (nháp không ghi; đồng bộ golden bị chặn nhưng sổ người vẫn ghi). DB riêng từ mẫu (KHÔNG
// BAO GIỜ `samsam`), xóa khi xong. Tên người là giả lập.

const NAME = testDbName('legal_hr');
const T = '2026-11-20';
const SHA: Record<string, string> = Object.fromEntries(
  ['verified', 'pending_review', 'rejected', 'cho_ocr'].map((k) => [
    k,
    createHash('sha256').update(k).digest('hex'),
  ]),
);
const GOLDEN_PATH = x.GOLDEN_FILE;
const GOLDEN_SHA = createHash('sha256').update(readFileSync(GOLDEN_PATH)).digest('hex');
const RESET = [
  'approval_queue',
  'decisions',
  'approvals',
  'agent_action_log',
  'xnqc_dossiers',
  'human_logins',
];
const HDR = 'ma_nv,ngay,gio_vao,gio_ra\n';
const GOOD =
  'NV001,2026-10-01,07:55,17:00\nNV001,2026-10-02,08:05,17:00\nNV001,2026-10-05,08:20,16:50\n' +
  'NV001,2026-10-06,08:00,\nNV001,2026-10-10,08:30:00,11:00\nnv-02,06/10/2026,08:00,17:00\n';
const CV_A =
  'Nguyễn Văn An — 0901 234 567 — an.nguyen@mail.test\n' +
  '3 năm vận hành gian hàng Shopee, chạy Shopee Ads, dùng Excel.\n';

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('legal_hr (DB)', () => {
  let pool: pg.Pool;
  let dsn: string;
  let tmp: string;
  let seq = 0;
  const roles: string[] = [];
  const extraPools: pg.Pool[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (table: string, where = 'true', p: unknown[] = []) =>
    Number((await q(`select count(*)::int as n from ${table} where ${where}`, p))[0]?.n);
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s) };
    return { out, err, io, text: () => out.join('\n') };
  };
  const lease = (db: Db) => async () => ({ db, release: async () => {} });
  const xnqc = (o: XnqcOpts, c = cap(), db: Db = pool, env: Record<string, string> = {}) =>
    xnqcMain(o, { io: c.io, env, connect: lease(db), wire: () => undefined, today: () => T });
  const pchr = (o: PcHrOpts, c = cap()) =>
    pcHrMain(o, {
      io: c.io,
      env: {},
      connect: lease(pool),
      wire: () => undefined,
      today: () => '2026-11-05',
    });
  const loginPool = async (tag: string, role: string): Promise<[pg.Pool, string]> => {
    const login = `t_lhr_${tag}_${process.pid}`;
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
  const syncItems = async () =>
    (await q(
      "select id::text as id, object_id, status, payload from approval_queue where object_type = 'golden_xnqc_sync' order by id",
    )) as { id: string; object_id: string; status: string; payload: string }[];
  const statusOf = async (id: string) =>
    (await q('select status from xnqc_dossiers where id = $1', [id]))[0]?.status;
  const skus = () => q('select * from sku_master order by sku_key');
  const goldenSha = () => createHash('sha256').update(readFileSync(GOLDEN_PATH)).digest('hex');

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'legal-hr-db-'));
    dsn = await createDbFromTemplate(NAME);
    pool = createPool(dsn, { max: 4 });
    wireCore(pool);
    settings.forceMode = 'van_hanh';
    for (const [st, sha] of Object.entries(SHA)) {
      await q(
        "insert into documents (sha256, filename, doc_type, text_source, status) values ($1, $2, 'giay_tiep_nhan', 'pdf_text', $3)",
        [sha, `scan-${st}.pdf`, st],
      );
    }
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
    settings.forceMode = 'van_hanh'; // như tests/conftest.py ép `_FORCE_MODE`
    await withTx(pool, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(`truncate ${RESET.join(', ')} restart identity cascade`);
    });
  });

  // ============================================================ pc_hr
  it('pc_hr: 3 thao tác → hàng duyệt legal_hr (medium, pending, agent:pc_hr) + chống trùng + log', async () => {
    let c = cap();
    expect(await pchr({ jd: 'nv_cskh' }, c)).toBe(0);
    expect(c.text()).toMatch(/\[submit\] hr_jd → mục hàng duyệt #\d+ \(khối legal_hr/);
    c = cap();
    expect(await pchr({ jd: 'nv_cskh' }, c)).toBe(0);
    expect(c.text()).toContain('[skip]');
    const rows = (otype: string) =>
      q(
        'select block, risk, status, created_by, object_id, payload, title from approval_queue where object_type = $1 order by id',
        [otype],
      );
    const jd = await rows('hr_jd');
    expect(jd).toHaveLength(1);
    expect([jd[0]?.block, jd[0]?.risk, jd[0]?.status, jd[0]?.created_by]).toEqual([
      'legal_hr',
      'medium',
      'pending',
      'agent:pc_hr',
    ]);
    expect(jd[0]?.object_id).toMatch(/^jd:nv_cskh:[0-9a-f]{12}$/);

    const d = join(tmp, `inbox${seq++}`);
    mkdirSync(d);
    writeFileSync(join(d, 'NguyenVanAn_0901234567.txt'), CV_A);
    writeFileSync(join(d, 'an_copy.md'), CV_A);
    writeFileSync(
      join(d, 'binh.txt'),
      'Trần Thị Bình, 0912345678. Kinh nghiệm TikTok Shop, livestream.\n',
    );
    writeFileSync(join(d, 'c.md'), '﻿Lê C. Thành thạo Google Sheets, quản lý gian hàng Lazada.\n');
    writeFileSync(join(d, 'rong.txt'), '');
    writeFileSync(join(d, 'bom_only.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x20, 0x20, 0x0a]));
    writeFileSync(join(d, 'cp1258.txt'), Buffer.from([0x54, 0x72, 0xe0, 0x6e, 0x20, 0xff]));
    writeFileSync(join(d, 'cv.pdf'), '%PDF-1.4');
    mkdirSync(join(d, 'sub'));
    expect(await pchr({ screen: true, jd: 'nv_van_hanh_san', dir: d })).toBe(0);
    const [sc] = await rows('hr_screening');
    expect([sc?.block, sc?.risk, sc?.status, sc?.created_by]).toEqual([
      'legal_hr',
      'medium',
      'pending',
      'agent:pc_hr',
    ]);
    for (const leak of ['Nguyễn', '0901', '@mail.test', 'NguyenVanAn']) {
      expect(sc?.payload).not.toContain(leak);
    }
    expect(sc?.title).toContain('6 hồ sơ');

    const f = join(tmp, `cc${seq++}.csv`);
    writeFileSync(f, HDR + GOOD);
    expect(await pchr({ attendance: f, month: '2026-10' })).toBe(0);
    const [att] = await rows('hr_attendance');
    expect(att?.object_id).toMatch(/^att:2026-10:[0-9a-f]{12}$/);
    expect(att?.payload).toContain('`NV001`');
    // enqueue ghi kèm dòng log (agent_action_log) cho từng mục
    expect(await n('agent_action_log', "actor = 'agent:pc_hr' and action = 'queue_enqueue'")).toBe(
      3,
    );
  });

  // ============================================================ xnqc — schema
  const ins = async (kw: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      sku_key: 'savigout-30v',
      loai_ho_so: 'maket',
      ten_ho_so: 'maket test',
      status: 'da_cap',
      so_giay: '01/2026',
      ngay_nop: '2026-10-01',
      ngay_cap: '2026-10-10',
      ngay_het_han: null,
      document_sha256: SHA.verified,
      updated_by: 'Phap Che Gia Lap',
      ...kw,
    };
    const cols = Object.keys(row);
    await pool.query(
      `insert into xnqc_dossiers (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  it.each([
    [{ so_giay: null }],
    [{ so_giay: '  ' }],
    [{ ngay_cap: null }],
    [{ document_sha256: null }],
    [{ updated_by: 'agent:x' }],
    [{ updated_by: '  System: y' }],
    [{ ngay_het_han: '2026-10-10' }],
    [{ status: 'da_nop', ngay_nop: null }],
  ])('CHECK chặn ghi thẳng da_cap thiếu người/số giấy/scan (%j)', async (kw) => {
    await expect(ins(kw)).rejects.toMatchObject({ code: '23514' });
  });

  it('FK SKU/scan + dòng hợp lệ (người + số giấy + scan)', async () => {
    await expect(ins({ sku_key: 'khong-co-sku' })).rejects.toMatchObject({ code: '23503' });
    await expect(ins({ document_sha256: 'f'.repeat(64) })).rejects.toMatchObject({
      code: '23503',
    });
    await ins();
    expect(await n('xnqc_dossiers')).toBe(1);
  });

  // ============================================================ xnqc — luồng
  it('luồng đủ trạng thái: chuyển sai/thiếu điều kiện không ghi; log từng bước; golden KHÔNG đổi', async () => {
    const before = await skus();
    const did = await x.add(pool, 'savigout-30v', 'maket', 'maket fanpage', 'Phap Che A');
    await expect(x.add(pool, 'khong-co', 'maket', 'x', 'Phap Che A')).rejects.toThrow(
      'SKU không có trong sku_master',
    );
    await expect(x.add(pool, 'savigout-30v', 'maket', 'x', 'agent:a1')).rejects.toThrow(RangeError);
    const st = (s: string, kw: Partial<x.SetOpts> & { by?: string } = {}) =>
      x.setStatus(pool, did, s, kw.by ?? 'Phap Che A', { ...kw, today: T });
    const cur = () => statusOf(did);

    expect(
      (
        await st('da_cap', {
          so_giay: '1',
          ngay_cap: '2026-11-01',
          doc_sha: SHA.verified,
        })
      )[0],
    ).toBe(false);
    expect(await cur()).toBe('chuan_bi');
    expect((await st('da_nop'))[0]).toBe(false); // thiếu ngày nộp
    expect((await st('da_nop', { ngay_nop: '2026-12-01' }))[0]).toBe(false); // tương lai
    expect((await st('da_nop', { ngay_nop: '2026-11-02' }))[0]).toBe(true);
    expect(await cur()).toBe('da_nop');
    expect((await st('bo_sung'))[0]).toBe(true);
    expect(await cur()).toBe('bo_sung');
    expect((await st('da_nop', { ngay_nop: '2026-11-10' }))[0]).toBe(true);
    const base = { so_giay: '123/2026/XNQC', ngay_cap: '2026-11-15' };
    const rejects: (Partial<x.SetOpts> & { by?: string })[] = [
      { ...base, doc_sha: SHA.verified, by: '' },
      { ...base, doc_sha: SHA.verified, by: 'agent:phap_che_a1' },
      { ngay_cap: '2026-11-15', doc_sha: SHA.verified },
      { ...base },
      { ...base, doc_sha: SHA.pending_review },
      { ...base, doc_sha: SHA.rejected },
      { ...base, doc_sha: SHA.cho_ocr },
      { ...base, doc_sha: 'e'.repeat(64) },
      { ...base, doc_sha: SHA.verified, ngay_cap: '2026-11-21' },
      { ...base, doc_sha: SHA.verified, ngay_het_han: '2026-11-15' },
    ];
    for (const kw of rejects) {
      const [ok, msg] = await st('da_cap', kw);
      expect(ok, JSON.stringify(kw)).toBe(false);
      expect(msg).toBeTruthy();
      expect(await cur()).toBe('da_nop');
    }
    const [ok, msg] = await st('da_cap', {
      ...base,
      doc_sha: SHA.verified,
      ngay_het_han: '2026-12-10',
    });
    expect(ok, msg).toBe(true);
    expect(await cur()).toBe('da_cap');
    expect((await st('da_nop', { ngay_nop: '2026-11-02' }))[0]).toBe(false); // da_cap → da_nop
    const items = await q(
      "select id::text as id, block, extract(epoch from due_at - created_at)::int as sla, payload, status from approval_queue where object_type = 'golden_xnqc_sync' and object_id = 'savigout-30v:approved'",
    );
    expect(items).toHaveLength(1);
    const it0 = items[0] as {
      id: string;
      block: string;
      sla: number;
      payload: string;
      status: string;
    };
    expect([it0.block, it0.sla, it0.status]).toEqual(['legal_hr', 72 * 3600, 'pending']);
    expect(check(it0.payload).ok).toBe(true);
    expect(it0.payload).toContain('none→approved');
    expect(it0.payload).toContain('Phap Che A');
    expect(await x.syncGolden(pool, T)).toEqual([]); // idempotent
    expect(await decide(pool, it0.id, 'Phap Che B', 'approved')).toEqual([true, null]);
    expect((await st('het_han'))[0]).toBe(true);
    expect(await cur()).toBe('het_han');
    for (const s of ['chuan_bi', 'da_nop', 'bo_sung', 'da_cap', 'het_han']) {
      expect((await st(s, { ngay_nop: '2026-11-02' }))[0]).toBe(false);
    }
    expect(await cur()).toBe('het_han');
    const logs = (await q(
      "select actor, detail from agent_action_log where action = 'xnqc_status' order by id",
    )) as { actor: string; detail: Record<string, unknown> }[];
    expect(logs.map((l) => [l.detail.from, l.detail.to])).toEqual([
      ['chuan_bi', 'da_nop'],
      ['da_nop', 'bo_sung'],
      ['bo_sung', 'da_nop'],
      ['da_nop', 'da_cap'],
      ['da_cap', 'het_han'],
    ]);
    for (const l of logs) {
      expect(l.actor).toBe('Phap Che A');
      expect(Object.keys(l.detail).sort()).toEqual(['from', 'id', 'to']);
    }
    expect(await n('agent_action_log', "action = 'xnqc_add'")).toBe(1);
    expect(await q('select * from verify_action_log()')).toEqual([]);
    // golden: file + sku_master KHÔNG đổi (agent chỉ đề xuất)
    expect(await skus()).toEqual(before);
    expect(goldenSha()).toBe(GOLDEN_SHA);
  });

  it('đồng bộ golden: mục cũ trái đích bị THAY THẾ (có cảnh báo), mục đã duyệt chờ người sửa golden không đề xuất lại', async () => {
    const by = 'Phap Che A';
    const set = (id: string, s: string, kw: Partial<x.SetOpts> = {}) =>
      x.setStatus(pool, id, s, by, { ...kw, today: T });
    const d1 = await x.add(pool, 'savigout-30v', 'maket', 'maket fanpage', by);
    expect((await set(d1, 'da_nop', { ngay_nop: '2026-11-02' }))[0]).toBe(true);
    expect(
      (
        await set(d1, 'da_cap', {
          so_giay: '1/2026',
          ngay_cap: '2026-11-15',
          doc_sha: SHA.verified,
        })
      )[0],
    ).toBe(true);
    let items = await syncItems();
    expect(items.map((i) => i.object_id)).toEqual([
      'savigout-30v:pending',
      'savigout-30v:approved',
    ]);
    const [a, b] = items.map((i) => i.id);
    expect(items[1]?.payload).toContain(`THAY THẾ mục #${a} — chỉ duyệt mục mới nhất`);
    expect(check(items[1]?.payload).ok).toBe(true);
    expect(
      (await x.syncNotes(pool, T)).some((m) =>
        m.startsWith(`mục #${a} savigout-30v→pending LỖI THỜI`),
      ),
    ).toBe(true);
    // het_han trong cửa sổ 72h: đích none = golden → mục GIỮ NGUYÊN thay cả 2 mục cũ
    expect((await set(d1, 'het_han'))[0]).toBe(true);
    items = await syncItems();
    const c = items[items.length - 1] as (typeof items)[number];
    expect([c.object_id, c.status]).toEqual(['savigout-30v:none', 'pending']);
    expect(c.payload).toContain('GIỮ NGUYÊN');
    expect(c.payload).toContain(`THAY THẾ mục #${a}, #${b}`);
    expect(check(c.payload).ok).toBe(true);
    expect(await x.syncGolden(pool, T)).toEqual([]);
    const notes = await x.syncNotes(pool, T);
    expect(notes.filter((m) => m.includes('LỖI THỜI'))).toHaveLength(2);
    // hồ sơ 2 nộp → đích pending; mục ':pending' cũ (#a) còn pending (unique) → '@<id thay>'
    const d2 = await x.add(pool, 'savigout-30v', 'maket', 'maket web', by);
    expect((await set(d2, 'da_nop', { ngay_nop: '2026-11-18' }))[0]).toBe(true);
    items = await syncItems();
    const e = items[items.length - 1] as (typeof items)[number];
    expect([e.object_id, e.status]).toEqual([`savigout-30v:pending@${c.id}`, 'pending']);
    expect(e.payload).toContain(`THAY THẾ mục #${b}, #${c.id}`);
    expect(await x.syncGolden(pool, T)).toEqual([]);
    // đã duyệt mà golden chưa sửa → KHÔNG đề xuất lại, nhắc chờ người sửa
    const d3 = await x.add(pool, 'savina-12v', 'maket', 'maket web', by);
    expect((await set(d3, 'da_nop', { ngay_nop: '2026-11-02' }))[0]).toBe(true);
    items = await syncItems();
    const f = items[items.length - 1] as (typeof items)[number];
    expect(f.object_id).toBe('savina-12v:pending');
    expect(await decide(pool, f.id, 'Phap Che B', 'approved')).toEqual([true, null]);
    const nItems = (await syncItems()).length;
    expect(await x.syncGolden(pool, T)).toEqual([]);
    expect((await syncItems()).length).toBe(nItems);
    const wait = `mục #${f.id} savina-12v→pending đã duyệt — chờ người sửa golden`;
    expect((await x.syncNotes(pool, T)).some((m) => m.startsWith(wait))).toBe(true);
    const k = cap();
    expect(await xnqc({ syncGolden: true, today: T }, k)).toBe(0);
    expect(k.text()).toContain(wait);
    expect(k.text()).toContain('LỖI THỜI');
    expect(k.text()).toContain('[ok] đề xuất đồng bộ golden mới: không có');
    expect((await syncItems()).length).toBe(nItems);
    expect(goldenSha()).toBe(GOLDEN_SHA);
  });

  it('CLI --add/--set/--remind/--list/--sync-golden', async () => {
    let c = cap();
    expect(
      await xnqc(
        { add: true, sku: 'savina-12v', loai: 'maket', ten: 'maket web', by: 'Phap Che A' },
        c,
      ),
    ).toBe(0);
    expect(c.text()).toMatch(/^\[ok\] hồ sơ #\d+ \(savina-12v, maket\) — chuan_bi$/);
    c = cap();
    expect(
      await xnqc({ add: true, sku: 'khong-co', loai: 'maket', ten: 'x', by: 'Phap Che A' }, c),
    ).toBe(1);
    expect(c.text()).toBe('[err] SKU không có trong sku_master');
    const did = String((await q('select max(id)::text as id from xnqc_dossiers'))[0]?.id);
    c = cap();
    expect(
      await xnqc(
        {
          set: did,
          status: 'da_cap',
          by: 'Phap Che A',
          soGiay: '1',
          ngayCap: '2026-11-01',
          docSha: SHA.verified,
        },
        c,
      ),
    ).toBe(1);
    expect(c.text()).toContain('[từ chối] không chuyển được chuan_bi → da_cap; hợp lệ: da_nop');
    c = cap();
    expect(await xnqc({ remind: true, today: '2026-11-16' }, c)).toBe(0);
    expect(c.text().split('SẮP HẠN').length - 1).toBe(8);
    expect(c.text()).toContain('còn 14 ngày');
    expect(c.out[0]).toBe('[xnqc] nhắc mốc ngày 16/11/2026 — 8 mục');
    c = cap();
    expect(await xnqc({ list: true }, c)).toBe(0);
    expect(c.text()).toContain('savina-12v maket [chuan_bi]');
    expect(c.text()).toContain('— số giấy —, nộp —, cấp —, hết hạn — — bởi Phap Che A');
    c = cap();
    expect(await xnqc({ syncGolden: true, today: '2026-11-16' }, c)).toBe(0);
    expect(c.text()).toContain('không có');
  });

  // ============================================================ danh tính theo login (v15.4)
  it('P10.1: --add/--set qua function *_human — login người đúng khối; --by giả / sai khối bị từ chối; chế độ thực không có người duyệt → cliGate chặn + authz_denied', async () => {
    const [legal, legalLogin] = await loginPool('legal', 'app_human');
    const [sales, salesLogin] = await loginPool('sales', 'app_human');
    await q(
      "insert into human_logins (db_login, person, blocks, granted_by) values ($1, 'Pháp Chế Giả', '{legal_hr}', 'test'), ($2, 'Bán Hàng Giả', '{sales}', 'test')",
      [legalLogin, salesLogin],
    );
    const add = { add: true, sku: 'savigout-30v', loai: 'maket', ten: 'maket p10' } as const;
    // --by giả: login của Pháp chế ghi tên người khác → DB từ chối (42501), 0 dòng
    let c = cap();
    expect(await xnqc({ ...add, by: 'Bán Hàng Giả' }, c, legal)).toBe(1);
    expect(c.text()).toMatch(/^\[err\] .*không phải người của login/);
    expect(await n('xnqc_dossiers')).toBe(0);
    c = cap();
    expect(await xnqc({ ...add, by: 'Pháp Chế Giả' }, c, legal)).toBe(0);
    const row = (await q('select id::text as id, updated_by from xnqc_dossiers'))[0] as {
      id: string;
      updated_by: string;
    };
    expect(row.updated_by).toBe('Pháp Chế Giả');
    // login KHÔNG được ghi thẳng bảng
    await expect(
      legal.query("update xnqc_dossiers set status = 'da_nop' where id = $1", [row.id]),
    ).rejects.toThrow(/permission denied/);
    const today = vnDate(new Date());
    const set = { set: row.id, status: 'da_nop', ngayNop: today } as const;
    const realToday = (o: XnqcOpts, k: ReturnType<typeof cap>, db: Db, env = {}) =>
      xnqcMain(o, { io: k.io, env, connect: lease(db), wire: () => undefined });
    // sai khối (dev): cliGate chỉ cảnh báo, DB `human_actor` từ chối khối legal_hr → không đổi
    c = cap();
    expect(await realToday({ ...set, by: 'Bán Hàng Giả' }, c, sales)).toBe(1);
    expect(c.text()).toMatch(/^\[từ chối\] DB từ chối: .*legal_hr/);
    expect(c.err.join('\n')).toContain('[warn] CHẾ ĐỘ DEV');
    expect(await statusOf(row.id)).toBe('chuan_bi');
    // chế độ thực: khối legal_hr chưa có người duyệt được ủy quyền → cliGate chặn TRƯỚC khi ghi
    const before = await n(
      'agent_action_log',
      "action = 'authz_denied' and object_type = 'xnqc_dossier' and object_id = $1",
      [row.id],
    );
    c = cap();
    expect(
      await realToday({ ...set, by: 'Pháp Chế Giả' }, c, legal, { APPROVAL_ENFORCE: '1' }),
    ).toBe(1);
    expect(c.text()).toMatch(/^\[từ chối\] /);
    expect(
      await n(
        'agent_action_log',
        "action = 'authz_denied' and object_type = 'xnqc_dossier' and object_id = $1",
        [row.id],
      ),
    ).toBe(before + 1);
    expect(await statusOf(row.id)).toBe('chuan_bi');
    // đúng người + đúng khối + login của chính họ → ghi qua function
    c = cap();
    expect(await realToday({ ...set, by: 'Pháp Chế Giả' }, c, legal)).toBe(0);
    expect(c.text()).toContain(`[ok] hồ sơ #${row.id}: chuan_bi → da_nop`);
    expect(await q('select status, updated_by from xnqc_dossiers where id = $1', [row.id])).toEqual(
      [{ status: 'da_nop', updated_by: 'Pháp Chế Giả' }],
    );
  });

  // ============================================================ nháp hồ sơ (legal_hr-02)
  it('--draft --submit: 1 mục xnqc_dossier (agent:xnqc, khối legal_hr); chạy lại cùng nội dung → [skip] mục cũ', async () => {
    const o = { draft: true, sku: 'savina-12v', loai: 'maket', ten: 'maket fb', submit: true };
    let c = cap();
    expect(await xnqc(o, c)).toBe(0);
    const rows = await q(
      "select id::text as id, block, risk, status, created_by, object_id, payload from approval_queue where object_type = 'xnqc_dossier'",
    );
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, string>;
    expect([r.block, r.risk, r.status, r.created_by]).toEqual([
      'legal_hr',
      'high',
      'pending',
      'agent:xnqc',
    ]);
    expect(r.object_id).toMatch(/^savina-12v:maket:[0-9a-f]{12}$/);
    expect(r.payload).toContain('8014/2021/ĐKSP');
    expect(c.out[c.out.length - 1]).toBe(`[ok] nháp hồ sơ → hàng duyệt legal_hr #${r.id}`);
    c = cap();
    expect(await xnqc(o, c)).toBe(0);
    expect(c.text()).toContain(
      `[skip] nháp hồ sơ cùng nội dung đã có mục chờ #${r.id} — không ghi thêm`,
    );
    expect(c.out[c.out.length - 1]).toBe(`[ok] nháp hồ sơ → hàng duyệt legal_hr #${r.id}`);
    expect(await n('approval_queue', "object_type = 'xnqc_dossier'")).toBe(1);
  });

  it('cổng TẮT: nháp không ghi (exit 1); đổi trạng thái sổ của NGƯỜI vẫn ghi nhưng đề xuất đồng bộ golden bị chặn', async () => {
    const did = await x.add(pool, 'savigout-30v', 'maket', 'maket tat', 'Phap Che A');
    settings.forceMode = 'tat';
    const c = cap();
    expect(
      await xnqc(
        { draft: true, sku: 'savina-12v', loai: 'maket', ten: 'nháp tắt', submit: true },
        c,
      ),
    ).toBe(1);
    expect(c.text()).toMatch(/^\[err\] .*legal_hr-02/);
    expect(await n('approval_queue')).toBe(0);
    const [ok, msg] = await x.setStatus(pool, did, 'da_nop', 'Phap Che A', {
      ngay_nop: '2026-11-02',
      today: T,
    });
    expect(ok).toBe(true);
    expect(msg).toBe(
      `hồ sơ #${did}: chuan_bi → da_nop; CHƯA đề xuất đồng bộ golden (RolloutBlocked)`,
    );
    expect(await statusOf(did)).toBe('da_nop');
    expect(await n('approval_queue')).toBe(0);
  });
});
