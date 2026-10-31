import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFernetKey } from '@samsam/core/fernet';
import { businessDeadline } from '@samsam/core/ops/period';
import { installFakeDeps } from '@samsam/core/ops/testing';
import { dataPath } from '@samsam/core/paths';
import { PII_RE } from '@samsam/core/security/pii';
import { search } from '@samsam/core/security/py';
import { describe, expect, it } from 'vitest';
import G from './__fixtures__/crm.golden.json' with { type: 'json' };
import { type CrmDeps, type CrmOpts, crmMain } from './crm.command.js';
import * as crm from './crm.service.js';
import * as ls from './lead-store.js';

// Dịch tests/test_crm.py + tests/test_lead_store.py (+ phần CLI không DB của test_v14_p4_sales.py):
// logic thuần so golden sinh từ hàm Python thật (scratchpad, không trong repo); CLI kiểm tham số /
// khóa vault / JSON liên hệ / file vùng TRƯỚC connect (exit 2, không ghi); lead-store: cổng loader
// TẮT chặn trước khi đọc file, insert-only. Người/SĐT/email là GIẢ LẬP.

const PHONE = '0905123456';
const PERSON = {
  phone: '0905 123 456',
  name: 'Nguyễn Văn Mẫu',
  email: 'mau@example.com',
  address: '12 Lê Duẩn',
  province: 'Quảng Nam',
};
const TMP = mkdtempSync(join(tmpdir(), 'crm-'));
const newKeys = () => crm.loadVaultKey({ CONTACT_VAULT_KEY: generateFernetKey() });
const iso = (d: Date) => d.toISOString().replace('.000Z', '+00:00');
const rowJson = (r: ls.LeadRow) => ({ ...r, ts: iso(r.ts) });

type PyRes = { ok?: unknown; err?: string; msg?: string };
function run<T>(fn: () => T): PyRes {
  try {
    return { ok: fn() };
  } catch (e) {
    const t = e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'ValueError' : '?';
    return { err: t, msg: (e as Error).message };
  }
}

let nDir = 0;
function convDir(main: string | null, rot: string | null): string {
  const d = join(TMP, `conv${nDir++}`);
  mkdirSync(d);
  if (main !== null) writeFileSync(join(d, 'conversations.jsonl'), Buffer.from(main, 'latin1'));
  if (rot !== null) writeFileSync(join(d, 'conversations.jsonl.1'), Buffer.from(rot, 'latin1'));
  return d;
}

// ================================================================ golden lead_store

describe('lead_store golden (Python)', () => {
  it('intentOf: ưu tiên, chống FP "giá"/"ở đâu", recall giữ', () => {
    for (const [q, want] of G.intent_of) expect([q, ls.intentOf(q as string)]).toEqual([q, want]);
  });

  it('channelOf / dedupKey / convKind / leadRow mọi biến thể record', () => {
    for (const c of G.records) {
      const r = c.rec as Record<string, unknown>;
      const [row, why] = ls.leadRow(r);
      expect([
        ls.channelOf(r),
        ls.dedupKey(r),
        ls.convKind(r),
        [row === null ? null : rowJson(row), why],
      ]).toEqual([c.channel_of, c.dedup_key, c.conv_kind, c.lead_row]);
    }
  });

  it('harvest: thiếu / rỗng / chỉ _doc / hỏng / .1 / byte lỗi / BOM / provenance', () => {
    for (const [name, c] of Object.entries(G.harvest)) {
      const [rows, stats] = ls.harvest(convDir(c.main, c.rot));
      expect([name, rows.map(rowJson), stats]).toEqual([name, c.rows, c.stats]);
    }
  });

  it('convlogStats: answered strict, bỏ trả lời đồng ý, kênh messenger', () => {
    for (const [name, c] of Object.entries(G.convlog_stats)) {
      expect([name, ls.convlogStats(convDir(c.main, c.rot))]).toEqual([name, c.stats]);
    }
  });
});

// ================================================================ golden crm

describe('crm golden (Python)', () => {
  it('provinceOf + 34 tỉnh', () => {
    for (const [t, want] of G.province_of) expect([t, crm.provinceOf(t)]).toEqual([t, want]);
    expect(crm.provinces()).toEqual(G.provinces);
  });

  it('checkBy / normPhone (lỗi không echo số)', () => {
    for (const [b, want] of G.check_by) expect([b, run(() => crm.checkBy(b))]).toEqual([b, want]);
    for (const [p, want] of G.normalize_phone) {
      const got = run(() => crm.normPhone(p));
      expect([p, got]).toEqual([p, want]);
      if (got.err) expect(got.msg).not.toMatch(/\d{3,}/);
    }
  });

  it('commissionRate', () => {
    // KHÁC có chủ đích: chuỗi số = cột numeric từ pg (Python nhận Decimal — Decimal('0.00') falsy → 0);
    // Python chỉ thấy chuỗi khi JSON ghi chuỗi (loadRegions vốn từ chối).
    const TS_DIFFERENT = new Map([['0.00', '0']]);
    for (const [d, c, o, want] of G.commission_rate) {
      const cd = (d as Record<string, unknown>).commission_default;
      const exp = typeof cd === 'string' ? (TS_DIFFERENT.get(cd) ?? want) : want;
      expect(crm.commissionRate(d as crm.Dealer, c, o as boolean)).toBe(exp);
    }
  });

  it('loadRegions: file repo + mọi biến thể hỏng → lỗi y hệt', () => {
    for (const [name, c] of Object.entries(G.load_regions) as [string, Record<string, unknown>][]) {
      const p = join(TMP, `${name}.json`);
      if ('doc' in c) writeFileSync(p, JSON.stringify(c.doc));
      else if ('raw' in c) writeFileSync(p, Buffer.from(c.raw as string, 'latin1'));
      const path = name === 'missing' ? join(TMP, 'khong-co.json') : p;
      expect([name, run(() => crm.loadRegions(path))]).toEqual([name, c.res]);
    }
  });

  it('hạn xử lý --owner = 8 giờ làm việc ca sales', () => {
    const shift = { start: '08:00', end: '18:00', workdays: [0, 1, 2, 3, 4], holidays: [] };
    for (const [now, due] of G.owner_due) {
      expect(businessDeadline(new Date(now as string), 8, shift).getTime()).toBe(
        new Date(due as string).getTime(),
      );
    }
  });
});

// ================================================================ vault / tỉnh / vùng

describe('vault', () => {
  it('phoneLookup = HMAC có khóa (không sha256 trần), tất định', () => {
    const k1 = newKeys().lookupKey;
    const k2 = newKeys().lookupKey;
    const h1 = crm.phoneLookup(PHONE, k1);
    expect(h1).not.toBe(crm.phoneLookup(PHONE, k2));
    expect(h1).not.toBe(createHash('sha256').update(PHONE).digest('hex'));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(crm.phoneLookup(PHONE, k1)).toBe(h1);
  });

  it('loadVaultKey từ chối thiếu/sai — thông điệp không chứa giá trị', () => {
    for (const env of [
      {},
      { CONTACT_VAULT_KEY: '' },
      { CONTACT_VAULT_KEY: '   ' },
      { CONTACT_VAULT_KEY: 'not-a-key' },
      { CONTACT_VAULT_KEY: 'khóa-có-dấu' },
    ]) {
      let err: unknown;
      try {
        crm.loadVaultKey(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(crm.VaultKeyError);
      expect((err as Error).message).not.toMatch(/not-a-key|khóa-có-dấu/);
    }
  });

  it('seal/unseal khứ hồi; sai khóa → VaultKeyError', () => {
    const f = newKeys().fernet;
    const tok = crm.seal(f, 'Nguyễn Văn Mẫu — 12 Lê Duẩn') as string;
    expect(tok.startsWith('gAAAAA') && !tok.includes('Nguyễn')).toBe(true);
    expect(crm.unseal(f, tok)).toBe('Nguyễn Văn Mẫu — 12 Lê Duẩn');
    expect([crm.seal(f, null), crm.seal(f, '  ')]).toEqual([null, null]);
    expect(() => crm.unseal(newKeys().fernet, tok)).toThrow(crm.VaultKeyError);
  });
});

// 63 tỉnh CŨ → tỉnh mới (GIẢ ĐỊNH NQ 202/2025/QH15) — viết độc lập với file data.
const OLD63: Record<string, string> = {
  'An Giang': 'An Giang',
  'Bà Rịa - Vũng Tàu': 'TP. Hồ Chí Minh',
  'Bạc Liêu': 'Cà Mau',
  'Bắc Giang': 'Bắc Ninh',
  'Bắc Kạn': 'Thái Nguyên',
  'Bắc Ninh': 'Bắc Ninh',
  'Bến Tre': 'Vĩnh Long',
  'Bình Dương': 'TP. Hồ Chí Minh',
  'Bình Định': 'Gia Lai',
  'Bình Phước': 'Đồng Nai',
  'Bình Thuận': 'Lâm Đồng',
  'Cà Mau': 'Cà Mau',
  'Cao Bằng': 'Cao Bằng',
  'Cần Thơ': 'Cần Thơ',
  'Đà Nẵng': 'Đà Nẵng',
  'Đắk Lắk': 'Đắk Lắk',
  'Đắk Nông': 'Lâm Đồng',
  'Điện Biên': 'Điện Biên',
  'Đồng Nai': 'Đồng Nai',
  'Đồng Tháp': 'Đồng Tháp',
  'Gia Lai': 'Gia Lai',
  'Hà Giang': 'Tuyên Quang',
  'Hà Nam': 'Ninh Bình',
  'Hà Nội': 'Hà Nội',
  'Hà Tĩnh': 'Hà Tĩnh',
  'Hải Dương': 'Hải Phòng',
  'Hải Phòng': 'Hải Phòng',
  'Hậu Giang': 'Cần Thơ',
  'Hòa Bình': 'Phú Thọ',
  'Hưng Yên': 'Hưng Yên',
  'Khánh Hòa': 'Khánh Hòa',
  'Kiên Giang': 'An Giang',
  'Kon Tum': 'Quảng Ngãi',
  'Lai Châu': 'Lai Châu',
  'Lâm Đồng': 'Lâm Đồng',
  'Lạng Sơn': 'Lạng Sơn',
  'Lào Cai': 'Lào Cai',
  'Long An': 'Tây Ninh',
  'Nam Định': 'Ninh Bình',
  'Nghệ An': 'Nghệ An',
  'Ninh Bình': 'Ninh Bình',
  'Ninh Thuận': 'Khánh Hòa',
  'Phú Thọ': 'Phú Thọ',
  'Phú Yên': 'Đắk Lắk',
  'Quảng Bình': 'Quảng Trị',
  'Quảng Nam': 'Đà Nẵng',
  'Quảng Ngãi': 'Quảng Ngãi',
  'Quảng Ninh': 'Quảng Ninh',
  'Quảng Trị': 'Quảng Trị',
  'Sóc Trăng': 'Cần Thơ',
  'Sơn La': 'Sơn La',
  'Tây Ninh': 'Tây Ninh',
  'Thái Bình': 'Hưng Yên',
  'Thái Nguyên': 'Thái Nguyên',
  'Thanh Hóa': 'Thanh Hóa',
  'Thừa Thiên Huế': 'Huế',
  'Tiền Giang': 'Đồng Tháp',
  'TP. Hồ Chí Minh': 'TP. Hồ Chí Minh',
  'Trà Vinh': 'Vĩnh Long',
  'Tuyên Quang': 'Tuyên Quang',
  'Vĩnh Long': 'Vĩnh Long',
  'Vĩnh Phúc': 'Phú Thọ',
  'Yên Bái': 'Lào Cai',
};

describe('tỉnh / vùng', () => {
  it('file 34 tỉnh GIẢ ĐỊNH + alias trỏ trong 34; 63 tỉnh cũ → tỉnh mới', () => {
    const doc = JSON.parse(readFileSync(crm.PROVINCES_FILE, 'utf8'));
    expect(doc.status).toBe('gia_dinh');
    expect(doc._doc).toContain('GIẢ ĐỊNH');
    expect(new Set(doc.provinces).size).toBe(34);
    const provs = new Set(doc.provinces);
    expect(Object.values(doc.aliases).every((v) => provs.has(v))).toBe(true);
    expect(Object.keys(OLD63)).toHaveLength(63);
    expect(new Set(Object.values(OLD63))).toEqual(provs);
    for (const [old, want] of Object.entries(OLD63)) {
      expect([old, crm.provinceOf(`đại lý ở ${old}`)]).toEqual([old, want]);
    }
  });

  it('bảng vùng repo: mỗi tỉnh đúng 1 vùng, DLM01/DLM02 phụ trách Đà Nẵng, MẪU không PII', () => {
    const reg = crm.loadRegions();
    expect(new Set(Object.keys(reg.province_region))).toEqual(new Set(crm.provinces()));
    const counts = new Map<string, number>();
    for (const ps of Object.values(reg.regions))
      for (const p of ps) counts.set(p, (counts.get(p) ?? 0) + 1);
    expect(new Set(counts.values())).toEqual(new Set([1]));
    expect(reg.dealers.length).toBeGreaterThanOrEqual(3);
    const dn = reg.province_region['Đà Nẵng'];
    const inDn = reg.dealers.filter((d) => d.region === dn).map((d) => d.code);
    expect(inDn).toEqual(expect.arrayContaining(['DLM01', 'DLM02']));
    expect(reg.dealers.some((d) => d.region !== dn)).toBe(true);
    const raw = readFileSync(crm.REGIONS_FILE, 'utf8');
    expect(JSON.parse(raw).status).toBe('mau');
    expect(search(PII_RE, raw)).toBeNull();
  });
});

// ================================================================ CLI (không DB)

type Out = { rc: number; out: string; err: string; connects: number };
async function cli(o: CrmOpts, d: Partial<CrmDeps> = {}): Promise<Out> {
  const out: string[] = [];
  const err: string[] = [];
  let connects = 0;
  const rc = await crmMain(o, {
    env: { CONTACT_VAULT_KEY: generateFernetKey() },
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    connect: async () => {
      connects++;
      return null;
    },
    ...d,
  });
  return { rc, out: out.join('\n'), err: err.join('\n'), connects };
}
const stdin = (v: unknown) => async (max: number) =>
  (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v), 'utf8')).subarray(0, max);

describe('CLI crm — chặn TRƯỚC connect', () => {
  it('--add-contact thiếu khóa vault → exit 2, nêu CONTACT_VAULT_KEY', async () => {
    const r = await cli(
      { addContact: '-', by: 'Lan' },
      { env: { CONTACT_VAULT_KEY: '' }, stdin: stdin(PERSON) },
    );
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.out).toContain('[err]');
    expect(r.out).toContain('CONTACT_VAULT_KEY');
  });

  it('SĐT sai → exit 2, không echo PII', async () => {
    const r = await cli(
      { addContact: '-', by: 'Lan' },
      { stdin: stdin({ ...PERSON, phone: '0905-12x-9876543' }) },
    );
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.out).not.toMatch(/9876543|Nguyễn/);
  });

  it('JSON hỏng / list / không UTF-8 / quá lớn → exit 2', async () => {
    for (const raw of [
      Buffer.from('{'),
      Buffer.from('[1]'),
      Buffer.from([0xff, 0xfe]),
      Buffer.alloc(70000, 'x'),
    ]) {
      const r = await cli({ addContact: '-', by: 'Lan' }, { stdin: stdin(raw) });
      expect([r.rc, r.connects]).toEqual([2, 0]);
    }
  });

  it('file liên hệ TRONG repo → từ chối; file NGOÀI repo → đọc được (tới connect)', async () => {
    let r = await cli({ addContact: dataPath('dealer_regions.json'), by: 'Lan' });
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.out).toContain('NGOÀI repo');
    const f = join(TMP, 'lien-he.json');
    writeFileSync(f, `﻿${JSON.stringify(PERSON)}`);
    r = await cli({ addContact: f, by: 'Lan' });
    expect([r.rc, r.connects]).toEqual([1, 1]);
    expect(r.out).toContain('DB không truy cập được');
    expect(r.out).not.toMatch(/0905|Nguyễn/);
    r = await cli({ addContact: join(TMP, 'khong-co.json'), by: 'Lan' });
    expect([r.rc, r.out]).toEqual([
      2,
      '[err] không đọc được file (FileNotFoundError) — không ghi gì.',
    ]);
  });

  const USAGE: [string, CrmOpts][] = [
    ['2-ops', { report: true, assign: '1', dealer: 'DLM01', by: 'Lan' }],
    ['status-bogus', { status: ['1', 'bogus'], by: 'Lan' }],
    ['status-lead-x', { status: ['x', 'won'], by: 'Lan' }],
    ['status-lead-sup2', { status: ['²', 'won'], by: 'Lan' }],
    ['status-1-arg', { status: ['1'], by: 'Lan' }],
    ['by-rong', { status: ['1', 'won'], by: '' }],
    ['by-101', { status: ['1', 'won'], by: 'a'.repeat(101) }],
    ['by-ctrl', { status: ['1', 'won'], by: 'Lan\x07' }],
    ['by-thieu', { status: ['1', 'won'] }],
    [
      'dai-ly-no-dealer',
      {
        consent: '1',
        purpose: 'dai_ly',
        grant: true,
        source: 'form_giay',
        evidence: 'BB-1',
        policyVersion: 'v1',
        by: 'Lan',
      },
    ],
    [
      'grant-no-evidence',
      { consent: '1', purpose: 'marketing', grant: true, source: 'form_giay', by: 'Lan' },
    ],
    [
      'cskh-dealer',
      { consent: '1', purpose: 'cskh', withdraw: true, source: 'web', dealer: 'DLM01', by: 'Lan' },
    ],
    ['no-grant-withdraw', { consent: '1', purpose: 'cskh', source: 'web', by: 'Lan' }],
    [
      'grant+withdraw',
      { consent: '1', purpose: 'cskh', grant: true, withdraw: true, source: 'web', by: 'Lan' },
    ],
    ['purpose-la', { consent: '1', purpose: 'spam', withdraw: true, source: 'web', by: 'Lan' }],
    ['source-la', { consent: '1', purpose: 'cskh', withdraw: true, source: 'fax', by: 'Lan' }],
    ['consent-x', { consent: 'x', purpose: 'cskh', withdraw: true, source: 'web', by: 'Lan' }],
    ['assign-no-dealer', { assign: '1', by: 'Lan' }],
    ['dealer-sai-mau', { assign: '1', dealer: '0905123456 x', by: 'Lan' }],
    ['report-by', { report: true, by: 'Lan' }],
    ['report-lead', { report: true, lead: '3' }],
    ['report-province', { report: true, province: 'Huế' }],
    ['report-purpose', { report: true, purpose: 'cskh' }],
    ['no-op', {}],
    ['owner-no-staff', { owner: '5', by: 'Lan' }],
    ['staff-no-owner', { status: ['5', 'new'], staff: 'NV01', by: 'Lan' }],
    ['handoff-no-dealer', { handoff: '5', by: 'Lan' }],
  ];
  it.each(USAGE)('tham số sai %s → exit 2, không connect', async (_n, o) => {
    const r = await cli(o);
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.err).toMatch(/^crm: error: /);
  });

  it('--owner với TÊN thay mã nhân viên → exit 2 trước connect', async () => {
    const r = await cli({ owner: '5', staff: 'Nguyen An', by: 'Lan' });
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.out).toContain('MÃ nhân viên');
  });

  it('file vùng hỏng (--load-dealers PATH) → exit 2 trước connect', async () => {
    const p = join(TMP, 'vung-hong.json');
    writeFileSync(p, '{');
    const r = await cli({ loadDealers: p, by: 'Lan' });
    expect([r.rc, r.connects]).toEqual([2, 0]);
    expect(r.out).toBe('[err] vung-hong.json: không đọc được (JSONDecodeError) — không ghi gì.');
  });

  it('DB không truy cập được → exit 1 (report)', async () => {
    const r = await cli({ report: true }, { env: { CONTACT_VAULT_KEY: '' } });
    expect([r.rc, r.connects]).toEqual([1, 1]);
    expect(r.out).toContain('DB không truy cập được');
  });

  it('report() chỉ SELECT', async () => {
    const sql: string[] = [];
    const fake = {
      query: async (q: string | { text: string }) => {
        sql.push(typeof q === 'string' ? q : q.text);
        return { rows: [] };
      },
    };
    const out = await crm.report(fake as never);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((s) => /^\s*(select|with)\b/i.test(s))).toBe(true);
    expect(out).toContain('CRM');
  });

  it('module crm không gọi mạng/LLM (agent không tự liên hệ khách/đại lý)', () => {
    for (const f of ['crm.service.ts', 'crm.command.ts', 'lead-store.ts']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      expect([f, /\bfetch\(|node:https?|AI_GATEWAY|\.chat\(|\.embed\(/.test(src)]).toEqual([
        f,
        false,
      ]);
    }
  });
});

// ================================================================ lead-store (không DB)

describe('lead-store', () => {
  it('applyLeads chỉ insert … on conflict do nothing (KHÔNG delete), chạy lại = trùng', async () => {
    const ops: string[] = [];
    let seen = false;
    const fake = {
      query: async (sql: string) => {
        ops.push(sql);
        if (sql === 'begin' || sql === 'commit') return { rowCount: null };
        const n = seen ? 0 : 1;
        seen = true;
        return { rowCount: n };
      },
    };
    const [row] = ls.leadRow(G.records[0]?.rec as Record<string, unknown>);
    expect(await ls.applyLeads(fake as never, [row as ls.LeadRow])).toEqual({ new: 1, dup: 0 });
    expect(await ls.applyLeads(fake as never, [row as ls.LeadRow])).toEqual({ new: 0, dup: 1 });
    const body = ops.filter((s) => s !== 'begin' && s !== 'commit');
    expect(body.every((s) => s.includes('insert into leads'))).toBe(true);
    expect(body.every((s) => s.includes('on conflict (dedup_key) do nothing'))).toBe(true);
    expect(ops.some((s) => /delete/i.test(s))).toBe(false);
  });

  it('leadStats: không kết nối / DB lỗi → null', async () => {
    expect(await ls.leadStats(null)).toBeNull();
    const broken = {
      query: async () => {
        throw new Error('offline');
      },
    };
    expect(await ls.leadStats(broken as never)).toBeNull();
  });

  const LIVE = `${JSON.stringify({
    ts: '2026-10-10T01:02:03Z',
    msg_id: 'm1',
    user_hash: 'abc',
    question: 'giá bao nhiêu',
    provenance: 'live',
  })}\n`;
  type LsOut = { rc: number; out: string[]; queries: string[] };
  // cổng loader kiểm mã tính năng có trong danh mục thật (data/contract_features.json)
  const CATALOG = (
    JSON.parse(readFileSync(dataPath('contract_features.json'), 'utf8')).features as {
      id: string;
    }[]
  ).map((f) => ({ id: f.id }));
  const fake = (quick: string | null) => installFakeDeps({}, { quick, catalog: CATALOG });
  async function lsRun(d: ls.LeadStoreDeps, quick: string | null = 'van_hanh'): Promise<LsOut> {
    fake(quick);
    const out: string[] = [];
    const queries: string[] = [];
    const pool = {
      query: async (q: string) => {
        queries.push(q);
        return { rows: [] };
      },
      end: async () => {},
    };
    const rc = await ls.leadStoreMain({
      io: { out: (s) => out.push(s), err: (s) => out.push(s) },
      service: async () => pool as never,
      wire: () => {},
      dataDir: convDir(LIVE, null),
      env: {},
      ...d,
    });
    return { rc, out, queries };
  }

  it('cổng rollout TẮT (sales-04.1) → exit 2 TRƯỚC khi đọc convlog/ghi', async () => {
    const r = await lsRun({}, 'tat');
    expect(r.rc).toBe(2);
    expect(r.out.some((s) => s.startsWith('[rollout] loader lead_store:'))).toBe(true);
    expect(r.out.some((s) => s.startsWith('[scan]'))).toBe(false);
    expect(r.queries).toEqual(['select 1']);
  });

  it('không có DB để đọc giai đoạn tính năng → chặn (exit 2)', async () => {
    const dead = {
      query: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      end: async () => {},
    };
    const r = await lsRun({ service: async () => dead as never }, null);
    expect(r.rc).toBe(2);
    expect(r.out.join('\n')).toContain('không kết nối được DB');
    expect(r.out.some((s) => s.startsWith('[scan]'))).toBe(false);
  });

  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2 (bind_service)', async () => {
    const out: string[] = [];
    const rc = await ls.leadStoreMain({
      env: { APPROVAL_ENFORCE: '1', DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' },
      io: { out: (s) => out.push(s), err: (s) => out.push(s) },
      wire: () => {},
    });
    expect(rc).toBe(2);
    expect(out.join('\n')).toContain('LOADER_DATABASE_URL');
  });

  it('không có lead → exit 0, leads giữ nguyên (không ghi)', async () => {
    const r = await lsRun({ dataDir: convDir('{"_doc": "x"}\n', null) });
    expect(r.rc).toBe(0);
    expect(r.out.at(-1)).toContain('[warn] không có lead nào');
    expect(r.queries).toEqual(['select 1']);
  });

  it('leadStoreJob ghi job_runs `ingest.lead_store`, ok theo exit code', async () => {
    fake('tat');
    const runs: [string, boolean][] = [];
    const rc = await ls.leadStoreJob({
      io: { out: () => {}, err: () => {} },
      service: async () => ({ query: async () => ({ rows: [] }), end: async () => {} }) as never,
      wire: () => {},
      jobRun: (async (
        name: string,
        body: (r: { ok: boolean; detail: null }) => Promise<number>,
      ) => {
        const st = { ok: true, detail: null };
        const v = await body(st);
        runs.push([name, st.ok]);
        return v;
      }) as never,
    });
    expect([rc, runs]).toEqual([2, [['ingest.lead_store', false]]]);
  });
});
