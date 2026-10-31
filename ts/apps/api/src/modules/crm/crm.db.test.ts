import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from '@samsam/core/db';
import { generateFernetKey } from '@samsam/core/fernet';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { dataPath } from '@samsam/core/paths';
import { HumanDenied, HumanError, setDirectorsDir } from '@samsam/core/security/auth';
import { PII_RE } from '@samsam/core/security/pii';
import { search } from '@samsam/core/security/py';
import { adminQuery, createDbFromTemplate, dbUrl, dropDb } from '@samsam/core/testing/db';
import type pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { section } from '../sales_director/sales-watch.js';
import { type CrmDeps, type CrmOpts, crmMain } from './crm.command.js';
import * as crm from './crm.service.js';
import * as ls from './lead-store.js';

// Dịch phần DB của tests/test_crm.py, test_v14_p4_sales.py (--owner) và test_v15_p10_human_authz.py
// (crm qua login người): DB riêng `samsam_ts_crm` tạo từ mẫu cho MỖI ca (như schema tạm + rollback
// của Python), xóa khi xong. Login tạm `in role <role>` tên có pid, drop ở afterAll. Người/SĐT/email
// GIẢ LẬP. Kết nối chính = superuser của container test (owner → `human_actor` nhận --by).

const NAME = 'samsam_ts_crm';
const PID = process.pid;
const PHONE = '0905123456';
const PERSON = {
  phone: '0905 123 456',
  name: 'Nguyễn Văn Mẫu',
  email: 'mau@example.com',
  address: '12 Lê Duẩn',
  province: 'Quảng Nam',
};
const PII_NEEDLES = ['0905123456', '905123456', 'Nguyễn', 'Mẫu', 'mau@example', 'Lê Duẩn'];
const SHIFT = { start: '08:00', end: '18:00', workdays: [0, 1, 2, 3, 4], holidays: [] };
/** Giờ VN tháng 10/2026 — 12/10 là thứ Hai. */
const t = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h - 7));
const newKeys = () => crm.loadVaultKey({ CONTACT_VAULT_KEY: generateFernetKey() });

describe.skipIf(!process.env.TS_TEST_ADMIN_URL)('crm (DB)', () => {
  let pool: pg.Pool;
  const extra: pg.Pool[] = [];
  const logins: string[] = [];
  beforeEach(async () => {
    await dropDb(NAME);
    pool = createPool(await createDbFromTemplate(NAME));
  });
  afterEach(async () => {
    for (const p of extra.splice(0)) await p.end().catch(() => {});
    await pool?.end();
    await dropDb(NAME);
  });
  afterAll(async () => {
    for (const l of logins) await adminQuery(`drop role if exists ${l}`);
  });

  const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[] = []) => {
    const r = (await pool.query({ text: sql, values: args, rowMode: 'array' })).rows[0];
    return r?.[0];
  };
  let nLead = 0;
  const lead = async (question: string, intent = 'order', status = 'new') =>
    BigInt(
      await one(
        "insert into leads (dedup_key, ts, channel, user_hash, question, intent, status, source) values ($1, now(), 'zalo', 'uhash-crm-test', $2, $3, $4, 'conversations.jsonl') returning id",
        [`t:${PID}:${nLead++}`, question, intent, status],
      ),
    );
  const dealers = () => crm.loadDealers(pool, crm.loadRegions(), 'Lan');
  const raises = async (sql: string, args: unknown[] = []) =>
    expect(pool.query(sql, args)).rejects.toThrow();

  /** Login tạm `in role <role>`; `person` → ánh xạ human_logins (khối `blocks`). */
  async function login(tag: string, role: string, person?: string, blocks = '{sales}') {
    const name = `t_crm_${tag}_${PID}`;
    const pw = `p${Math.random().toString(36).slice(2)}`;
    await adminQuery(`drop role if exists ${name}`);
    await adminQuery(
      `create role ${name} login password '${pw}' nosuperuser nocreatedb nocreaterole in role ${role}`,
    );
    if (!logins.includes(name)) logins.push(name);
    if (person) {
      await q(
        "insert into human_logins (db_login, person, blocks, granted_by) values ($1, $2, $3, 'test-crm')",
        [name, person, blocks],
      );
    }
    const u = new URL(dbUrl(NAME));
    u.username = name;
    u.password = pw;
    const p = createPool(u.toString());
    extra.push(p);
    return { name, pool: p, dsn: u.toString() };
  }

  type Out = { rc: number; out: string };
  async function cli(o: CrmOpts, d: Partial<CrmDeps> = {}, db: pg.Pool = pool): Promise<Out> {
    const out: string[] = [];
    const rc = await crmMain(o, {
      env: {},
      io: { out: (s) => out.push(s), err: (s) => out.push(s) },
      connect: async () => ({ db, release: async () => {} }),
      ...d,
    });
    return { rc, out: out.join('\n') };
  }
  const stdin = (v: unknown) => async (max: number) =>
    Buffer.from(JSON.stringify(v), 'utf8').subarray(0, max);

  it('schema: ciphertext CHECK, consents append-only, leads.status CHECK, agent_writer không đọc contacts', async () => {
    await raises(
      "insert into contacts (phone_hmac, phone_enc, source, created_by) values ($1, '0905123456', 'manual', 'x')",
      ['a'.repeat(64)],
    );
    await raises(
      "insert into contacts (phone_hmac, phone_enc, name_enc, source, created_by) values ($1, 'gAAAAAabc', 'Nguyễn', 'manual', 'x')",
      ['b'.repeat(64)],
    );
    await raises(
      "insert into contacts (phone_hmac, phone_enc, source, created_by) values ('0905123456', 'gAAAAAabc', 'manual', 'x')",
    );
    const cid = await one(
      "insert into contacts (phone_hmac, phone_enc, source, created_by) values ($1, 'gAAAAAabc', 'manual', 'x') returning id",
      ['c'.repeat(64)],
    );
    await q(
      "insert into dealers (code, name, region, source) values ('DLX', 'x', 'MIEN_TRUNG', 'manual')",
    );
    for (const sql of [
      "insert into consents (contact_id, purpose, granted, source, recorded_by) values ($1, 'dai_ly', false, 'web', 'x')",
      "insert into consents (contact_id, purpose, granted, recipient_dealer, source, recorded_by) values ($1, 'cskh', false, 'DLX', 'web', 'x')",
      "insert into consents (contact_id, purpose, granted, source, policy_version, recorded_by) values ($1, 'marketing', true, 'web', 'v1', 'x')",
    ]) {
      await raises(sql, [cid]);
    }
    await q(
      "insert into consents (contact_id, purpose, granted, source, recorded_by) values ($1, 'marketing', false, 'web', 'x')",
      [cid],
    );
    for (const sql of [
      'update consents set granted = true',
      'delete from consents',
      'truncate consents cascade',
    ]) {
      await expect(pool.query(sql)).rejects.toThrow(/append-only/);
    }
    const lid = await lead('giá bao nhiêu');
    await raises("update leads set status = 'bogus' where id = $1", [String(lid)]);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role agent_writer');
      await expect(c.query('select * from contacts')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('addContact: chỉ ciphertext, tra trùng HMAC (mọi dạng SĐT), không đè PII, log không PII', async () => {
    const keys = newKeys();
    const [cid, isNew] = await crm.addContact(pool, { ...PERSON }, keys, 'Lan');
    expect(isNew).toBe(true);
    const raw = (await q('select c::text as t from contacts c')).map((r) => r.t).join('\n');
    for (const n of PII_NEEDLES) expect([n, raw.includes(n)]).toEqual([n, false]);
    expect(await one('select province from contacts where id = $1', [String(cid)])).toBe('Đà Nẵng');
    const name0 = await one('select name_enc from contacts where id = $1', [String(cid)]);
    expect(crm.unseal(keys.fernet, name0)).toBe('Nguyễn Văn Mẫu');
    expect(
      await crm.addContact(pool, { phone: '+84905123456', name: 'Tên Khác' }, keys, 'Lan'),
    ).toEqual([cid, false]);
    for (const alt of ['+84 0905 123 456', '+84 (0) 905 123 456', '84 0905123456']) {
      expect(await crm.addContact(pool, { phone: alt }, keys, 'Lan')).toEqual([cid, false]);
    }
    expect(await q('select count(*)::int as n, max(name_enc) as m from contacts')).toEqual([
      { n: 1, m: name0 },
    ]);
    await expect(
      crm.addContact(pool, { phone: '0911222333' }, keys, 'Lan', 999999n),
    ).rejects.toBeInstanceOf(HumanError);
    expect(await one('select count(*)::int from contacts')).toBe(1);
    for (const bad of [
      { phone: PHONE, zalo_id: 'x' },
      { phone: PHONE, province: 'Atlantis' },
      { phone: PHONE, name: 'x'.repeat(201) },
      { phone: PHONE, source: 'Có Dấu' },
      { name: 'thiếu phone' },
    ]) {
      await expect(crm.addContact(pool, bad, keys, 'Lan')).rejects.toBeInstanceOf(RangeError);
    }
    const lid = await lead('đặt mua giao Đà Nẵng');
    expect(await crm.addContact(pool, { phone: PHONE }, keys, 'Lan', lid)).toEqual([cid, false]);
    expect(await one('select contact_id from leads where id = $1', [String(lid)])).toBe(
      String(cid),
    );
    await expect(crm.addContact(pool, { phone: '0911222333' }, keys, 'Lan', lid)).rejects.toThrow(
      'đã gắn contact khác',
    );
    expect(await one('select contact_id from leads where id = $1', [String(lid)])).toBe(
      String(cid),
    );
    expect(await one('select count(*)::int from contacts')).toBe(1);
    const logs = (await q('select detail::text as d from agent_action_log')).map((r) => r.d);
    expect(logs.length).toBeGreaterThan(0);
    for (const d of logs) {
      expect(search(PII_RE, d)).toBeNull();
      expect(d).not.toContain('gAAAAA');
      expect(d).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('đồng ý: mặc định false, theo dòng mới nhất (id), tách mục đích, dai_ly đích danh, sai → 0 dòng', async () => {
    await dealers();
    const keys = newKeys();
    const [cid] = await crm.addContact(pool, { ...PERSON }, keys, 'Lan');
    for (const p of crm.PURPOSES) {
      expect(await crm.canContact(pool, cid, p, p === 'dai_ly' ? 'DLM01' : null)).toBe(false);
    }
    const ev = 'BB-2026-001';
    const pv = 'v0-nhap';
    await crm.recordConsent(pool, cid, 'marketing', true, 'form_giay', 'Lan', ev, pv);
    expect(await crm.canContact(pool, cid, 'marketing')).toBe(true);
    await crm.recordConsent(pool, cid, 'marketing', false, 'dien_thoai', 'Lan');
    expect(await crm.canContact(pool, cid, 'marketing')).toBe(false);
    expect(
      await q(
        "select withdrawn_at is not null as w, granted_at from v_consent_current where contact_id = $1 and purpose = 'marketing'",
        [String(cid)],
      ),
    ).toEqual([{ w: true, granted_at: null }]);
    await crm.recordConsent(pool, cid, 'marketing', true, 'web', 'Lan', ev, pv);
    expect(await crm.canContact(pool, cid, 'marketing')).toBe(true);
    expect(await one("select count(*)::int from consents where purpose = 'marketing'")).toBe(3);
    await crm.recordConsent(pool, cid, 'dai_ly', true, 'form_giay', 'Lan', ev, pv, 'DLM01');
    expect(await crm.canContact(pool, cid, 'dai_ly', 'DLM01')).toBe(true);
    expect(await crm.canContact(pool, cid, 'dai_ly', 'DLM02')).toBe(false);
    expect(await crm.canContact(pool, cid, 'dai_ly')).toBe(false);
    await crm.recordConsent(pool, cid, 'cskh', true, 'zalo', 'Lan', ev, pv);
    await crm.recordConsent(pool, cid, 'marketing', false, 'web', 'Lan');
    expect(await crm.canContact(pool, cid, 'cskh')).toBe(true);
    expect(await crm.canContact(pool, cid, 'marketing')).toBe(false);
    await expect(crm.canContact(pool, cid, 'spam')).rejects.toBeInstanceOf(RangeError);
    // backdate: dòng grant ghi SAU nhưng ts cũ hơn — vẫn theo id
    await q(
      "insert into consents (contact_id, purpose, granted, source, evidence_ref, policy_version, recorded_by, ts) values ($1, 'marketing', true, 'web', 'BB-x', 'v0', 'Lan', now() - interval '30 days')",
      [String(cid)],
    );
    expect(await crm.canContact(pool, cid, 'marketing')).toBe(true);
    const n0 = await one('select count(*)::int from consents');
    const bad: [string, boolean, string, string | null, string | null, string | null][] = [
      ['spam', true, 'web', ev, pv, null],
      ['cskh', true, 'fax', ev, pv, null],
      ['dai_ly', true, 'web', ev, pv, null],
      ['cskh', false, 'web', null, null, 'DLM01'],
      ['cskh', true, 'web', null, 'v1', null],
      ['cskh', true, 'web', 'BB-1', null, null],
      ['cskh', true, 'web', '0905123456', 'v1', null],
      ['cskh', true, 'web', 'x'.repeat(201), 'v1', null],
      ['dai_ly', true, 'web', ev, pv, 'KHONGCO'],
    ];
    for (const [p, g, s, e, v, dl] of bad) {
      await expect(crm.recordConsent(pool, cid, p, g, s, 'Lan', e, v, dl)).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    await expect(
      crm.recordConsent(pool, 999999n, 'cskh', false, 'web', 'Lan'),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await one('select count(*)::int from consents')).toBe(n0);
  });

  it('loadDealers idempotent, giữ dòng manual', async () => {
    await q(
      "insert into dealers (code, name, region, status, commission_default, source) values ('DLM02', 'Sửa tay', 'MIEN_TRUNG', 'paused', 5, 'manual')",
    );
    const reg = crm.loadRegions();
    const r1 = await crm.loadDealers(pool, reg, 'Lan');
    expect([r1.new, r1.kept]).toEqual([reg.dealers.length - 1, 1]);
    const r2 = await crm.loadDealers(pool, reg, 'Lan');
    expect([r2.new, r2.updated]).toEqual([0, 0]);
    expect(await q("select name, status, source from dealers where code = 'DLM02'")).toEqual([
      { name: 'Sửa tay', status: 'paused', source: 'manual' },
    ]);
  });

  it('gán đại lý theo vùng + trạng thái chỉ tiến', async () => {
    await dealers();
    const lid = await lead('Tôi muốn làm đại lý ở Quảng Nam', 'partner');
    await expect(crm.assignLead(pool, lid, 'DLM03', 'Lan')).rejects.toBeInstanceOf(RangeError);
    expect(await one('select dealer_code from leads where id = $1', [String(lid)])).toBeNull();
    expect(await crm.assignLead(pool, lid, 'DLM01', 'Lan')).toBe('Đà Nẵng');
    expect(
      await q(
        'select province, dealer_code, assigned_by, assigned_at is not null as at from leads where id = $1',
        [String(lid)],
      ),
    ).toEqual([{ province: 'Đà Nẵng', dealer_code: 'DLM01', assigned_by: 'Lan', at: true }]);
    await expect(crm.assignLead(pool, lid, 'DLM02', 'Lan')).rejects.toThrow('tranh chấp');
    const nop = await lead('sâm tươi giá bao nhiêu', 'price');
    await expect(crm.assignLead(pool, nop, 'DLM01', 'Lan')).rejects.toThrow('--province');
    expect(await crm.assignLead(pool, nop, 'DLM03', 'Lan', 'Bình Dương')).toBe('TP. Hồ Chí Minh');
    await expect(crm.assignLead(pool, 999999n, 'DLM01', 'Lan')).rejects.toBeInstanceOf(RangeError);
    const lp = await lead('Tôi muốn làm đại lý ở Quảng Nam', 'partner');
    await q("update dealers set status = 'paused' where code = 'DLM02'");
    await expect(crm.assignLead(pool, lp, 'DLM02', 'Lan')).rejects.toThrow('đang paused');
    expect(await one('select dealer_code from leads where id = $1', [String(lp)])).toBeNull();
    await q("update dealers set status = 'active' where code = 'DLM02'");
    for (const st of ['contacted', 'qualified', 'won'])
      await crm.setLeadStatus(pool, lid, st, 'Lan');
    for (const st of ['new', 'lost']) {
      await expect(crm.setLeadStatus(pool, lid, st, 'Lan')).rejects.toBeInstanceOf(RangeError);
    }
    const l2 = await lead('giá sỉ');
    expect(await crm.setLeadStatus(pool, l2, 'qualified', 'Lan')).toBe('new');
    await expect(crm.setLeadStatus(pool, l2, 'contacted', 'Lan')).rejects.toThrow('không lùi');
    const l3 = await lead('giá sỉ');
    await crm.setLeadStatus(pool, l3, 'contacted', 'Lan');
    await crm.setLeadStatus(pool, l3, 'lost', 'Lan');
    await expect(crm.setLeadStatus(pool, l3, 'lost', 'Lan')).rejects.toThrow('đã kết thúc');
  });

  it('handoff (WP07 acceptance 1): PII CHỈ khi đồng ý dai_ly ĐÍCH DANH còn hiệu lực', async () => {
    await dealers();
    const keys = newKeys();
    const lid = await lead('đặt mua 3 hộp giao Đà Nẵng, sđt 0905 123 456');
    const [cid] = await crm.addContact(pool, { ...PERSON }, keys, 'Lan', lid);
    await crm.assignLead(pool, lid, 'DLM01', 'Lan');
    let p = await crm.handoffPayload(pool, lid, 'DLM01', keys, 'Lan');
    expect(Object.keys(p).filter((k) => ['phone', 'name', 'email', 'address'].includes(k))).toEqual(
      [],
    );
    expect(JSON.stringify(p)).not.toMatch(/0905123456|0905 123 456/);
    expect([p.province, p.intent]).toEqual(['Đà Nẵng', 'order']);
    await crm.recordConsent(pool, cid, 'dai_ly', true, 'form_giay', 'Lan', 'BB-1', 'v0', 'DLM01');
    p = await crm.handoffPayload(pool, lid, 'DLM01', keys, 'Lan');
    expect([p.phone, p.name, p.email, p.address]).toEqual([
      PHONE,
      'Nguyễn Văn Mẫu',
      'mau@example.com',
      '12 Lê Duẩn',
    ]);
    await expect(crm.handoffPayload(pool, lid, 'DLM02', keys, 'Lan')).rejects.toBeInstanceOf(
      RangeError,
    );
    await q("update dealers set status = 'paused' where code = 'DLM01'");
    const e = await crm.handoffPayload(pool, lid, 'DLM01', keys, 'Lan').catch((x) => x);
    expect(e).toBeInstanceOf(RangeError);
    expect(e.message).toContain('không active');
    for (const n of PII_NEEDLES) expect(e.message).not.toContain(n);
    await q("update dealers set status = 'active' where code = 'DLM01'");
    await crm.recordConsent(pool, cid, 'dai_ly', false, 'dien_thoai', 'Lan', null, null, 'DLM01');
    p = await crm.handoffPayload(pool, lid, 'DLM01', keys, 'Lan');
    expect('phone' in p || JSON.stringify(p).includes(PHONE)).toBe(false);
  });

  it('handoff: câu hỏi lead che cả tên/địa chỉ (gate v14 F02) khi chưa có đồng ý', async () => {
    await dealers();
    const lid = await lead(
      'Tôi là Nguyễn Văn Mẫu, giao cho chị Bích số 12 đường Ví Dụ Đà Nẵng, sđt 0905 123 456',
    );
    await crm.assignLead(pool, lid, 'DLM01', 'Lan');
    const p = await crm.handoffPayload(pool, lid, 'DLM01', newKeys(), 'Lan');
    const blob = JSON.stringify(p);
    for (const n of ['Nguyễn Văn Mẫu', 'Bích', 'Ví Dụ', '0905 123 456'])
      expect(blob).not.toContain(n);
    expect(Object.keys(p).filter((k) => ['phone', 'name', 'email', 'address'].includes(k))).toEqual(
      [],
    );
    expect(p.intent).toBe('order');
    expect(p.question).toContain('***');
  });

  it('report: không PII/HMAC/ciphertext/user_hash; đếm đồng ý; gợi ý đại lý theo vùng', async () => {
    await dealers();
    const keys = newKeys();
    const lid = await lead('đặt mua giao Đà Nẵng mau@example.com');
    await lead('làm đại lý ở Kon Tum', 'partner');
    await lead('giá bao nhiêu', 'price');
    const [cid] = await crm.addContact(pool, { ...PERSON }, keys, 'Lan', lid);
    await crm.recordConsent(pool, cid, 'marketing', true, 'web', 'Lan', 'BB', 'v0');
    const out = await crm.report(pool);
    for (const n of [...PII_NEEDLES, 'gAAAAA', 'phone_hmac', 'uhash-crm-test']) {
      expect([n, out.includes(n)]).toEqual([n, false]);
    }
    expect(search(PII_RE, out)).toBeNull();
    for (const s of ['Quảng Ngãi', 'DLM01, DLM02', 'marketing: 1 / 0', 'chưa xác định']) {
      expect(out).toContain(s);
    }
    expect(out).toContain('Liên hệ trong vault: 1');
  });

  it('CLI chuỗi thao tác trên DB: không PII ở stdout (trừ handoff có đồng ý), sai → exit 1/2', async () => {
    await dealers();
    const key = generateFernetKey();
    const lid = await lead('đặt mua giao Quảng Nam');
    let r = await cli(
      { addContact: '-', lead: String(lid), by: 'Lan' },
      { env: { CONTACT_VAULT_KEY: key }, stdin: stdin(PERSON) },
    );
    expect([r.rc, r.out]).toEqual([0, expect.stringContaining('[ok] contact #')]);
    for (const n of PII_NEEDLES) expect(r.out).not.toContain(n);
    const cid = await one('select contact_id from leads where id = $1', [String(lid)]);
    // đồng ý không cần khóa vault
    r = await cli({
      consent: String(cid),
      purpose: 'dai_ly',
      grant: true,
      source: 'form_giay',
      evidence: 'BB-9',
      policyVersion: 'v0',
      dealer: 'DLM01',
      by: 'Lan',
    });
    expect(r.rc, r.out).toBe(0);
    expect(r.out).toContain(`[ok] consent #`);
    expect(r.out).toContain('dai_ly/DLM01 ĐỒNG Ý');
    expect((await cli({ assign: String(lid), dealer: 'DLM01', by: 'Lan' })).rc).toBe(0);
    expect((await cli({ status: [String(lid), 'contacted'], by: 'Lan' })).rc).toBe(0);
    r = await cli({ status: [String(lid), 'new'], by: 'Lan' });
    expect([r.rc, r.out]).toEqual([1, expect.stringContaining('— không ghi.')]);
    r = await cli({ report: true });
    expect(r.rc).toBe(0);
    for (const n of PII_NEEDLES) expect(r.out).not.toContain(n);
    r = await cli({ handoff: String(lid), dealer: 'DLM01', by: 'Lan' }); // thiếu khóa
    expect(r.rc).toBe(2);
    r = await cli(
      { handoff: String(lid), dealer: 'DLM01', by: 'Lan' },
      { env: { CONTACT_VAULT_KEY: key } },
    );
    expect(r.rc).toBe(0);
    expect(r.out).toContain(PHONE);
    expect(JSON.parse(r.out.slice(r.out.indexOf('{'))).lead_id).toBe(Number(lid));
    r = await cli(
      { handoff: String(lid), dealer: 'DLM02', by: 'Lan' },
      { env: { CONTACT_VAULT_KEY: key } },
    );
    expect(r.rc).toBe(1);
    expect(
      (await q("select detail from agent_action_log where action = 'crm_handoff'")).map(
        (x) => x.detail.pii_included,
      ),
    ).toEqual([true]);
  });

  // ------------------------------------------------------------ sales-04.1 --owner

  it('assignOwner: mã NV + hạn 8 giờ làm việc + log không PII; từ chối đúng luật', async () => {
    const lid = await lead('giá hộp quà, gọi 0912345678', 'price');
    const due = await crm.assignOwner(pool, lid, 'NV01', 'Lan', { now: t(12, 16), shift: SHIFT });
    expect(due.getTime()).toBe(t(13, 14).getTime()); // T2 16:00 + 8 giờ (ca 08–18) → T3 14:00 VN
    expect(
      await q(
        'select owner_code, owner_due_at, owner_assigned_by, owner_assigned_at from leads where id = $1',
        [String(lid)],
      ),
    ).toEqual([
      {
        owner_code: 'NV01',
        owner_due_at: due,
        owner_assigned_by: 'Lan',
        owner_assigned_at: t(12, 16),
      },
    ]);
    const log = await q(
      "select actor, action, detail from agent_action_log where object_type = 'lead' and object_id = $1",
      [String(lid)],
    );
    expect(log.map((x) => [x.actor, x.action])).toEqual([['Lan', 'crm_owner']]);
    expect([log[0]?.detail.to, log[0]?.detail.from]).toEqual(['NV01', null]);
    expect(JSON.stringify(log[0]?.detail)).not.toMatch(/0912345678|giá hộp/);

    const won = await lead('giá', 'price', 'won');
    const o = { now: t(12, 10), shift: SHIFT };
    await expect(crm.assignOwner(pool, won, 'NV01', 'Lan', o)).rejects.toThrow('đã kết thúc');
    await expect(crm.assignOwner(pool, 10n ** 12n, 'NV01', 'Lan', o)).rejects.toThrow(
      'không có lead',
    );
    for (const bad of ['nv01', 'Nguyễn An', 'N', 'A'.repeat(21)]) {
      await expect(crm.assignOwner(pool, lid, bad, 'Lan', o)).rejects.toThrow('MÃ nhân viên');
    }
    await expect(crm.assignOwner(pool, lid, 'NV01', ' ', o)).rejects.toThrow('--by');
    const watch = {
      ...(section('lead_owner') as unknown as crm.LeadOwnerCfg),
      staff_codes: ['NV02'],
    };
    await expect(crm.assignOwner(pool, lid, 'NV01', 'Lan', { ...o, watch })).rejects.toThrow(
      'không có trong danh sách',
    );
    expect(await crm.assignOwner(pool, lid, 'NV02', 'Lan', { ...o, watch })).toBeInstanceOf(Date);
    await raises("update leads set owner_code = 'Nguyễn' where id = $1", [String(lid)]);
  });

  it('--owner chế độ thực + approvers khối sales rỗng → chặn, authz_denied, không gán', async () => {
    const lid = await lead('giá hộp quà', 'price');
    const tmp = mkdtempSync(join(tmpdir(), 'crm-users-'));
    const r = await cli(
      { owner: String(lid), staff: 'NV01', by: 'Lan' },
      { env: { APPROVAL_ENFORCE: '1', AUTH_USERS_FILE: join(tmp, 'khong-co.json') } },
    );
    expect(r.rc).toBe(1);
    expect(r.out).toContain('— không ghi.');
    expect(await one('select owner_code from leads where id = $1', [String(lid)])).toBeNull();
    expect(
      await q(
        "select actor, object_type, object_id, detail->>'block' as b, detail->>'action' as a from agent_action_log where action = 'authz_denied'",
      ),
    ).toEqual([
      { actor: 'Lan', object_type: 'crm', object_id: String(lid), b: 'sales', a: 'assign' },
    ]);
  });

  // ------------------------------------------------------------ v15.4 P10.1: login người

  it('mọi thao tác qua login NGƯỜI (human_logins + approvers khối sales); người khác / không ánh xạ → DB chặn', async () => {
    const P_SALES = 'Bán Hàng Giả Lập';
    const P_LEGAL = 'Pháp Chế Giả Lập';
    const sales = await login('sales', 'app_human', P_SALES, '{sales}');
    const legal = await login('legal', 'app_human', P_LEGAL, '{legal_hr}');
    const nomap = await login('nomap', 'app_human');
    const tmp = mkdtempSync(join(tmpdir(), 'crm-p10-'));
    const dirs = join(tmp, 'directors');
    mkdirSync(dirs);
    cpSync(dataPath('directors'), dirs, { recursive: true });
    for (const [blk, who] of [
      ['sales', P_SALES],
      ['legal_hr', P_LEGAL],
    ]) {
      const f = join(dirs, `${blk}.json`);
      const c = JSON.parse(readFileSync(f, 'utf8'));
      c.approvers = [who];
      writeFileSync(f, JSON.stringify(c));
    }
    const users = join(tmp, 'users.json');
    writeFileSync(
      users,
      JSON.stringify({
        [P_SALES.toLowerCase()]: { role: 'gd_ban_hang', db_login: sales.name },
        [P_LEGAL.toLowerCase()]: { role: 'phap_che', db_login: legal.name },
      }),
    );
    const env = { APPROVAL_ENFORCE: '1', AUTH_USERS_FILE: users };
    vi.stubEnv('APPROVAL_ENFORCE', '1'); // denyLog của callHuman đọc env tiến trình (như Python)
    setDirectorsDir(dirs);
    try {
      const runAs = (
        o: CrmOpts,
        who: pg.Pool,
        extraEnv: Record<string, string> = {},
        d: Partial<CrmDeps> = {},
      ) => cli(o, { env: { ...env, ...extraEnv }, directorsDir: dirs, ...d }, who);
      let r = await runAs({ loadDealers: true, by: P_LEGAL }, legal.pool);
      expect([r.rc, r.out]).toEqual([1, expect.stringContaining('ủy quyền')]);
      r = await runAs({ loadDealers: true, by: P_SALES }, sales.pool);
      expect([r.rc, r.out]).toEqual([0, expect.stringContaining('mới=')]);
      const lid = await one(
        "insert into leads (dedup_key, ts, channel, user_hash, question, intent, source) values ('p10:lead', now(), 'zalo', 'h', 'đặt 2 hộp giao Đà Nẵng', 'order', 'manual') returning id",
      );
      r = await runAs({ assign: lid, dealer: 'DLM01', by: P_SALES }, sales.pool);
      expect(r.rc, r.out).toBe(0);
      const venv = { CONTACT_VAULT_KEY: generateFernetKey() };
      r = await runAs({ addContact: '-', lead: lid, by: P_SALES }, sales.pool, venv, {
        stdin: stdin({ phone: '0905000111', name: 'Khách Giả P10' }),
      });
      expect(r.rc, r.out).toBe(0);
      const cid = await one('select contact_id from leads where id = $1', [lid]);
      r = await runAs(
        {
          consent: cid,
          purpose: 'dai_ly',
          dealer: 'DLM01',
          grant: true,
          source: 'form_giay',
          evidence: 'BB-P10',
          policyVersion: 'v1',
          by: P_SALES,
        },
        sales.pool,
      );
      expect(r.rc, r.out).toBe(0);
      r = await runAs({ handoff: lid, dealer: 'DLM01', by: P_SALES }, sales.pool, venv);
      expect([r.rc, r.out]).toEqual([0, expect.stringContaining('0905000111')]);
      r = await runAs({ status: [lid, 'contacted'], by: P_SALES }, sales.pool);
      expect(r.rc, r.out).toBe(0);
      r = await runAs({ owner: lid, staff: 'NV01', by: P_SALES }, sales.pool);
      expect(r.rc, r.out).toBe(0);
      r = await runAs({ report: true }, sales.pool);
      expect([r.rc, r.out]).toEqual([0, expect.stringContaining('Liên hệ trong vault: 1')]);
      expect(
        await q('select assigned_by, owner_assigned_by, status from leads where id = $1', [lid]),
      ).toEqual([{ assigned_by: P_SALES, owner_assigned_by: P_SALES, status: 'contacted' }]);
      expect(await one('select created_by from contacts where id = $1', [cid])).toBe(P_SALES);
      const acts = new Set(
        (await q('select action from agent_action_log where db_role = $1', [sales.name])).map(
          (x) => x.action,
        ),
      );
      for (const a of [
        'crm_dealer_load',
        'crm_assign',
        'crm_contact_add',
        'crm_consent',
        'crm_handoff',
        'crm_status',
        'crm_owner',
      ]) {
        expect([a, acts.has(a)]).toEqual([a, true]);
      }
      // nhập liệu bằng login người khác với --by của người khác → DB chặn + authz_denied
      const denied = async () =>
        Number(
          await one(
            "select count(*) from agent_action_log where action = 'authz_denied' and object_type = 'crm' and object_id = $1",
            [lid],
          ),
        );
      const before = await denied();
      r = await runAs({ status: [lid, 'qualified'], by: P_SALES }, legal.pool);
      expect([r.rc, r.out]).toEqual([1, expect.stringContaining('không phải người của login')]);
      expect(await denied()).toBe(before + 1);
      await expect(
        crm.setLeadStatus(nomap.pool, BigInt(lid), 'qualified', 'Ai Do'),
      ).rejects.toBeInstanceOf(HumanDenied);
      expect(await one('select status from leads where id = $1', [lid])).toBe('contacted');
      // login người KHÔNG đọc/ghi thẳng PII, không ghi thẳng sổ đại lý
      await expect(sales.pool.query('select * from contacts')).rejects.toThrow('permission denied');
      await expect(
        sales.pool.query(
          "insert into dealers (code, name, region, source) values ('X1', 'x', 'r', 'manual')",
        ),
      ).rejects.toThrow('permission denied');
    } finally {
      setDirectorsDir();
      vi.unstubAllEnvs();
    }
  });

  // ------------------------------------------------------------ lead-store

  const rec = (kw: Record<string, unknown>) =>
    JSON.stringify({
      ts: '2026-10-10T01:02:03Z',
      msg_id: 'm1',
      user_hash: 'abc123',
      question: 'Saphraton giá bao nhiêu?',
      answered: true,
      provenance: 'live',
      ...kw,
    });
  function convlog(): string {
    const d = mkdtempSync(join(tmpdir(), 'crm-conv-'));
    writeFileSync(
      join(d, 'conversations.jsonl'),
      [
        rec({}),
        rec({ msg_id: '', user_hash: 'u2', question: 'mua sâm ở đâu', ts: '2026-10-10T02:00:00Z' }),
        rec({ msg_id: 'm3', question: 'xin chào' }),
        rec({ msg_id: 'm4', provenance: 'mock', question: 'giá sỉ' }),
        '{hỏng',
      ].join('\n'),
    );
    return d;
  }

  it('lead-store: insert-only, chạy lại = trùng, leadStats; cổng TẮT → 0 dòng', async () => {
    const [rows] = ls.harvest(convlog());
    expect(await ls.applyLeads(pool, rows)).toEqual({ new: 2, dup: 0 });
    expect(await ls.applyLeads(pool, rows)).toEqual({ new: 0, dup: 2 });
    const st = await ls.leadStats(pool);
    expect(st && [st.total, st.by_channel, st.by_intent, st.by_status, st.recent.length]).toEqual([
      2,
      { zalo: 1, streamlit: 1 },
      { price: 1, order: 1 },
      { new: 2 },
      2,
    ]);
    await q('delete from leads');
    const catalog = (
      JSON.parse(readFileSync(dataPath('contract_features.json'), 'utf8')).features as {
        id: string;
      }[]
    ).map((f) => ({ id: f.id }));
    const out: string[] = [];
    const main = (quick: string, env: Record<string, string> = {}) => {
      installFakeDeps({}, { quick, catalog });
      out.length = 0;
      return ls.leadStoreMain({
        env,
        io: { out: (s) => out.push(s), err: (s) => out.push(s) },
        service: async () => createPool(dbUrl(NAME)),
        wire: () => {},
        dataDir: convlog(),
      });
    };
    expect(await main('tat')).toBe(2);
    expect(await one('select count(*)::int from leads')).toBe(0);
    expect(await main('van_hanh')).toBe(0);
    expect(out.at(-1)).toBe('[done] mới=2 trùng=0 — total leads=2 (streamlit=1, zalo=1)');
    expect(out.find((s) => s.startsWith('[scan]'))).toBe(
      "[scan] convlog: 3 record — lead=2, intent-miss=1, fields-miss=0, ts-bad=0, corrupt=1, _doc=0, io-error=0, dup-in-file=0 — thiếu ['conversations.jsonl.1']",
    );
    expect(await main('van_hanh')).toBe(0);
    expect(out.at(-1)).toBe('[done] mới=0 trùng=2 — total leads=2 (streamlit=1, zalo=1)');
    // chế độ thực: login loader riêng (svc_loader) nạp được leads
    const loader = await login('loader', 'svc_loader');
    await q('delete from leads');
    installFakeDeps({}, { quick: 'van_hanh', catalog });
    const rc = await ls.leadStoreMain({
      env: { APPROVAL_ENFORCE: '1', LOADER_DATABASE_URL: loader.dsn },
      io: { out: (s) => out.push(s), err: (s) => out.push(s) },
      wire: () => {},
      dataDir: convlog(),
    });
    expect([rc, out.at(-1)]).toEqual([
      0,
      '[done] mới=2 trùng=0 — total leads=2 (streamlit=1, zalo=1)',
    ]);
  });
});
