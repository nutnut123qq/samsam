import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG_FILE, loadConfig, quarterRange, yearRange } from './rev-share.js';
import { revShareMain, settlementCsvMain } from './settlement.command.js';
import { MAP_FILE as API_MAP_FILE, checkRows, loadMap, precheck, write } from './settlement-api.js';
import {
  CHANNELS,
  DEDUCT,
  decStr,
  type Fees,
  FIELDS,
  LOCK_BUCKETS,
  LockError,
  loadFees,
  loadMapping,
  lockKey,
  lockOrders,
  MONEY,
  orderHash,
  readSettlement,
  reconcileRow,
} from './settlement-csv.js';

// Dịch phần KHÔNG cần DB của tests/test_settlement_csv.py, test_r15_settlement_api.py,
// test_rev_share.py, test_settlement_overlap.py: cấu hình GIẢ ĐỊNH, parse fixture, CLI chặn TRƯỚC
// connect (exit code), khóa (kênh, đơn) bị chặn khi không trong transaction READ COMMITTED.
// Dữ liệu TỔNG HỢP: mã đơn `FAKESET*`, tên/SĐT/địa chỉ người mua GIẢ — không được lọt ra rows/stdout.

const FIX = repoPath('tests', 'fixtures', 'finance');
const SETTLE = join(FIX, 'settlement_shopee_MAU.csv');
const PII = [
  'nguoimuagia',
  'NGUOI NHAN GIA',
  'DUONG GIA LAP',
  'GHI CHU GIA',
  'VDGIA',
  'FAKESET',
  '090000000',
];
const hasPii = (s: string) => PII.some((p) => s.includes(p));
const EXPECT = { khop: 9, lech: 3, thieu_chung_tu: 2, hoan: 2 };
const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/settlement-csv.golden.json', import.meta.url), 'utf8'),
) as { orders_fixture: { rows: { order_id_hash: string; price: number; qty: number }[] } };
const TMP = mkdtempSync(join(tmpdir(), 'settle-unit-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function cap() {
  const lines: string[] = [];
  return {
    lines,
    io: { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) },
    text: () => lines.join('\n'),
  };
}
/** Login dịch vụ giả: gọi tới = connect (test chặn trước connect → mảng rỗng). */
function noConnect() {
  const calls: string[] = [];
  const service = async (svc: string) => {
    calls.push(svc);
    throw new Error('không được connect');
  };
  return { calls, service: service as never };
}
function copy(name: string, f: (t: string) => string): string {
  const p = join(TMP, name);
  writeFileSync(p, f(readFileSync(SETTLE, 'utf8')));
  return p;
}

describe('cấu hình GIẢ ĐỊNH', () => {
  it('mapping/biểu phí đánh dấu giả định; header không trùng; bỏ cột người mua', () => {
    const rawMap = readFileSync(repoPath('data', 'settlement_map.json'), 'utf8');
    const rawFees = readFileSync(repoPath('data', 'settlement_fees.json'), 'utf8');
    expect(rawMap).toContain('TÊN CỘT GIẢ ĐỊNH');
    expect(rawMap).toContain('chưa xác minh');
    expect(rawFees).toContain('BIỂU PHÍ GIẢ ĐỊNH');
    const [m, why] = loadMapping();
    expect(why).toBeNull();
    for (const ch of CHANNELS) {
      const spec = m?.[ch];
      const heads = [
        ...Object.values(spec?.required ?? {}),
        ...Object.values(spec?.optional ?? {}),
        ...(spec?.drop ?? []),
      ];
      expect(heads.length).toBe(new Set(heads).size);
      expect((spec?.drop ?? []).length).toBeGreaterThanOrEqual(4);
    }
    const [f] = loadFees();
    expect(decStr((f as Fees).shopee?.fixed_fee_pct as never)).toBe('0.04');
  });

  it('bảng ánh xạ API của repo: CHƯA CHỐT, mọi quyết định null, chưa có người/căn cứ', () => {
    for (const ch of CHANNELS) {
      const { cfg, why } = loadMap(ch);
      expect(why.some((w) => w.includes('chua_chot'))).toBe(true);
      expect(Object.keys(cfg.thanh_phan).length).toBeGreaterThan(0);
      expect(Object.values(cfg.thanh_phan).every((v) => v === null)).toBe(true);
      expect(Object.values(cfg.loai_giao_dich).every((v) => v === null)).toBe(true);
    }
    const raw = JSON.parse(readFileSync(API_MAP_FILE, 'utf8'));
    for (const ch of CHANNELS) {
      expect(raw[ch].duyet_boi).toBeNull();
      expect(raw[ch].can_cu).toBeNull();
      expect(raw[ch].tien_te_shop ?? null).toBeNull();
    }
  });

  it('rev_share.json: ngày/tỷ lệ/mức thưởng chưa chốt (null), _doc ghi GIẢ ĐỊNH', () => {
    const cfg = loadConfig();
    expect(cfg.start).toBeNull();
    expect(cfg.sign).toBeNull();
    expect(cfg.rate).toBeNull();
    expect(cfg.channels).toEqual(['shopee', 'tiktok']);
    expect(cfg.fee_cols).toEqual([
      'fixed_fee',
      'payment_fee',
      'service_fee',
      'shipping_fee',
      'voucher_seller',
      'affiliate',
    ]);
    expect(cfg.tiers.map((t) => t.muc)).toEqual([1, 2, 3]);
    expect(cfg.tiers.every((t) => t.tu_vnd === null && t.ty_le === null)).toBe(true);
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    expect(raw._doc).toContain('GIẢ ĐỊNH');
    expect(raw._doc).toContain('chờ');
    expect(() => loadConfig(join(TMP, 'khong_co.json'))).toThrow('không đọc được khong_co.json');
  });
});

describe('parse thuần (fixture)', () => {
  it('16 dòng, chỉ field chuẩn, không PII; dấu khoản trừ chuẩn hóa', async () => {
    const [rows, errs, sha] = await readSettlement(SETTLE, 'shopee', loadMapping()[0]);
    expect(errs).toEqual([]);
    expect(rows).toHaveLength(16);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const allowed = new Set([...FIELDS.filter((f) => f !== 'order_id'), 'row_no', 'order_id_hash']);
    for (const r of rows) {
      expect(new Set(Object.keys(r))).toEqual(allowed);
      expect(hasPii(JSON.stringify(r))).toBe(false);
    }
    const r1 = rows[0] as (typeof rows)[0];
    expect([r1.order_amount, r1.fixed_fee, r1.payout]).toEqual([318000, 12720, 279840]);
    expect(r1.settled_on).toBe('2026-10-02'); // DD/MM/YYYY
    expect(rows[1]?.settled_on).toBe('2026-10-03'); // ISO
    expect(rows[1]?.shipping_fee).toBe(15000);
    expect(rows.map((r) => r.row_no)).toEqual(Array.from({ length: 16 }, (_, i) => i + 2));
  });

  it('hash mã đơn cùng công thức market_csv (đơn sàn fixture chứa FAKESET0001)', async () => {
    const [rows] = await readSettlement(SETTLE, 'shopee', loadMapping()[0]);
    const first = rows.find((r) => r.row_no === 2)?.order_id_hash as string;
    expect(G.orders_fixture.rows.some((o) => o.order_id_hash === first)).toBe(true);
    expect(first).toBe(orderHash('shopee', 'FAKESET0001'));
    expect(orderHash('tiktok', 'X1')).toBe(
      createHash('sha256').update('tiktok:X1').digest('hex').slice(0, 16),
    );
  });

  it('lỗi file chỉ nêu dòng + field, KHÔNG giá trị ô', async () => {
    const m = loadMapping()[0];
    let [rows, errs] = await readSettlement(
      copy('s2.csv', (t) => t.replace(',-12.720,', ',"12,5",')),
      'shopee',
      m,
    );
    expect(rows).toEqual([]);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.startsWith("dòng 2: field 'fixed_fee'")).toBe(true);
    expect(errs[0]).not.toContain('12,5');
    [rows, errs] = await readSettlement(
      copy('t.csv', (t) => t.replace('02/10/2026', '32/10/2026')),
      'shopee',
      m,
    );
    expect(errs[0]).toContain("dòng 2: field 'settled_on'");
    expect(errs[0]).not.toContain('32/10');
  });

  it('phân bố nhãn đối chiếu fixture = 9 khớp / 3 lệch / 2 thiếu chứng từ / 2 hoàn', async () => {
    const [rows] = await readSettlement(SETTLE, 'shopee', loadMapping()[0]);
    const tot = new Map<string, bigint>();
    for (const o of G.orders_fixture.rows) {
      tot.set(o.order_id_hash, (tot.get(o.order_id_hash) ?? 0n) + BigInt(o.price * o.qty));
    }
    const fees = (loadFees()[0] as Fees).shopee as Fees[string];
    const got: Record<string, number> = {};
    for (const r of rows) {
      const [lb] = reconcileRow(r, tot.get(r.order_id_hash) ?? null, fees);
      got[lb] = (got[lb] ?? 0) + 1;
    }
    expect(got).toEqual(EXPECT);
    // kỳ vọng = giá trị đơn − mọi khoản trừ (hoàn của đơn hủy không bị trừ 2 lần ở rev_share)
    expect(DEDUCT).toContain('refund');
    expect(MONEY[0]).toBe('order_amount');
  });
});

describe('CLI settlement-csv — chặn TRƯỚC connect', () => {
  it('file lỗi → exit 1, 0 connect, không lộ PII', async () => {
    const nc = noConnect();
    let c = cap();
    const bad = copy('ren.csv', (t) => t.replace('Phí cố định', 'Fixed fee'));
    expect(
      await settlementCsvMain({ file: bad, channel: 'shopee' }, { io: c.io, service: nc.service }),
    ).toBe(1);
    expect(c.text()).toContain('thiếu cột bắt buộc');
    expect(c.text()).toContain('cột lạ');
    expect(c.text()).toContain('không connect, không nạp gì');
    c = cap();
    const dup = copy('dup.csv', (t) => t.replace('FAKESET0002', 'FAKESET0001'));
    expect(
      await settlementCsvMain({ file: dup, channel: 'shopee' }, { io: c.io, service: nc.service }),
    ).toBe(1);
    expect(hasPii(c.text())).toBe(false);
    expect(nc.calls).toEqual([]);
  });

  it('biểu phí hỏng → exit 1 trước connect (cả --reconcile lẫn --file)', async () => {
    const nc = noConnect();
    const bad = join(TMP, 'fees.json');
    writeFileSync(bad, '{');
    const c = cap();
    const d = { io: c.io, service: nc.service, feesFile: bad };
    expect(await settlementCsvMain({ reconcile: true }, d)).toBe(1);
    expect(await settlementCsvMain({ file: SETTLE, channel: 'shopee' }, d)).toBe(1);
    expect(c.text()).toContain('không đọc được fees.json');
    expect(nc.calls).toEqual([]);
  });

  it.each([
    [{ file: 'x.csv', channel: 'shopee', report: true }],
    [{ reconcile: true, report: true }],
    [{ file: 'x.csv' }],
    [{ report: true, channel: 'shopee' }],
    [{}],
    [{ file: 'x.csv', channel: 'lazada' }],
  ])('tham số sai %j → exit 2, 0 connect', async (o) => {
    const nc = noConnect();
    const c = cap();
    expect(await settlementCsvMain(o, { io: c.io, service: nc.service })).toBe(2);
    expect(nc.calls).toEqual([]);
  });

  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2 (không rơi về DATABASE_URL)', async () => {
    const c = cap();
    const env = { APPROVAL_ENFORCE: '1', DATABASE_URL: 'postgresql://x@127.0.0.1:9/khong_dung' };
    expect(await settlementCsvMain({ report: true }, { io: c.io, env })).toBe(2);
    expect(c.text()).toContain('LOADER_DATABASE_URL');
    const c2 = cap();
    expect(await settlementCsvMain({ report: true }, { io: c2.io, env: {} })).toBe(1);
    expect(c2.text()).toContain('thiếu DATABASE_URL');
  });
});

describe('settlement-api — chặn TRƯỚC request/connect', () => {
  const SP_MAP = {
    trang_thai: 'da_chot',
    duyet_boi: 'Kế toán trưởng (GIẢ — test)',
    can_cu: 'FIXTURE test — không phải bảng thật',
    ngay_chot: '2026-10-25',
    tien_te_shop: 'VND',
    thanh_phan: {
      escrow_amount: { cot: 'payout', dau: 1 },
      order_original_price: { cot: 'order_amount', dau: 1 },
    },
  };
  const mapFile = (doc: unknown) => {
    const p = join(TMP, `amap_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(doc));
    return p;
  };

  it('bảng ánh xạ của repo chưa chốt → [blocked] exit 2 (precheck — trước mọi request)', () => {
    const c = cap();
    const r = precheck('shopee', 'https://partner.shopeemobile.com', false, { io: c.io });
    expect(r.rc).toBe(2);
    expect(c.text()).toContain('[blocked]');
    expect(c.text()).toContain('chua_chot');
    expect(c.text()).toContain('settlement_api_map.json');
  });

  it('nguồn server giả/sandbox không được ghi sổ; --dry-run thì được kéo', () => {
    const p = mapFile({ shopee: SP_MAP, tiktok: SP_MAP });
    const c = cap();
    expect(precheck('shopee', 'http://127.0.0.1:5000', false, { io: c.io, mapFile: p }).rc).toBe(2);
    expect(c.text()).toContain('nguồn api_local');
    const dry = precheck('shopee', 'http://127.0.0.1:5000', true, { io: c.io, mapFile: p });
    expect(dry.rc).toBeNull();
    expect(dry.kind).toBe('api_local');
    const live = precheck('shopee', 'https://partner.shopeemobile.com', false, { mapFile: p });
    expect(live.rc).toBeNull();
    expect(live.fees).not.toBeNull();
  });

  it('bảng ánh xạ hỏng dạng → [err] exit 1', () => {
    const c = cap();
    const p = mapFile({ shopee: { ...SP_MAP, thanh_phan: { x: 'payout' } } });
    expect(
      precheck('shopee', 'https://partner.shopeemobile.com', true, { io: c.io, mapFile: p }).rc,
    ).toBe(1);
    expect(c.text()).toContain('[err] bảng ánh xạ quyết toán:');
  });

  it('1 dòng có cột null → cả lô từ chối, KHÔNG connect (r15-fix1 F2)', async () => {
    const good = [0, 1, 2].map((i) => ({
      order_id_hash: orderHash('shopee', `G${i}`),
      txn_type: null,
      row_no: i + 2,
      settled_on: '2026-10-03',
      ...Object.fromEntries(MONEY.map((m) => [m, 0])),
      order_amount: 1,
      payout: 1 as number | null,
    }));
    (good[1] as { payout: number | null }).payout = null;
    const nc = noConnect();
    const c = cap();
    expect(
      await write('shopee', good as never, 'api_live', {}, '2026-10-01', '2026-10-07', {
        io: c.io,
        service: nc.service,
      }),
    ).toBe(1);
    expect(c.text()).toContain('dòng 2: cột payout');
    expect(nc.calls).toEqual([]);
    expect(checkRows([good[0] as never])).toEqual([]);
    // Biểu diễn ngày là chuỗi 'YYYY-MM-DD' (Python: date) — chuỗi sai dạng vẫn bị chặn.
    expect(checkRows([{ ...(good[0] as object), settled_on: '03/10/2026' }])).toEqual([
      'dòng 1: settled_on sai kiểu',
    ]);
  });

  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2; dev thiếu DSN → exit 1', async () => {
    const row = {
      order_id_hash: orderHash('tiktok', 'R1'),
      txn_type: 'ORDER',
      row_no: 2,
      settled_on: '2026-10-03',
      ...Object.fromEntries(MONEY.map((m) => [m, 0])),
      order_amount: 100,
      payout: 90,
    };
    const c = cap();
    expect(
      await write('tiktok', [row as never], 'api_live', {}, '2026-10-01', '2026-10-07', {
        io: c.io,
        env: { APPROVAL_ENFORCE: '1' },
      }),
    ).toBe(2);
    const c2 = cap();
    expect(
      await write('tiktok', [row as never], 'api_live', {}, '2026-10-01', '2026-10-07', {
        io: c2.io,
        env: {},
      }),
    ).toBe(1);
    expect(c2.text()).toBe('[err] thiếu DATABASE_URL');
  });
});

describe('lockOrders — trần ngăn, thứ tự tăng dần, chặn autocommit/REPEATABLE READ', () => {
  class RecConn {
    sql: [string, unknown[] | undefined][] = [];
    constructor(
      readonly iso = 'read committed',
      readonly autocommit = false,
    ) {}
    async query(sql: string, params?: unknown[]) {
      this.sql.push([sql, params]);
      return { rows: [{ iso: this.iso }] };
    }
  }

  it('3000 đơn → ≤ 256 khóa, không trùng, theo ngăn tăng dần; kênh khác → khóa khác', async () => {
    const c = new RecConn();
    const hs = new Set(Array.from({ length: 3000 }, (_, i) => orderHash('tiktok', `O${i}`)));
    await lockOrders(c as never, 'tiktok', hs);
    const keys = c.sql.filter(([s]) => s.includes('advisory')).map(([, p]) => (p as string[])[0]);
    expect(keys.length).toBeLessThanOrEqual(LOCK_BUCKETS);
    expect(new Set(keys).size).toBe(keys.length);
    const buckets = [...new Set([...hs].map((h) => Number(BigInt(`0x${h}`) % 256n)))].sort(
      (a, b) => a - b,
    );
    expect(keys).toEqual(buckets.map((b) => String(lockKey('tiktok', b))));
    expect(lockKey('tiktok', 1)).not.toBe(lockKey('shopee', 1));
  });

  it.each([
    ['repeatable read', false],
    ['read committed', true],
  ])('iso=%s autocommit=%s → LockError, 0 khóa', async (iso, auto) => {
    const c = new RecConn(iso, auto);
    await expect(lockOrders(c as never, 'tiktok', ['ab'.repeat(8)])).rejects.toThrow(LockError);
    expect(c.sql.some(([s]) => s.includes('advisory'))).toBe(false);
  });
});

describe('CLI rev-share — chặn TRƯỚC connect', () => {
  const NOW = new Date('2026-10-14T09:00:00+07:00');
  const cfgFile = (over: Record<string, unknown>) => {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    const p = join(TMP, `rs_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ ...raw, ...over }));
    return p;
  };
  const failConnect = async () => {
    throw new Error('connect');
  };

  it('--year cần ngày ký hợp đồng (kể cả khi đã có ngày vận hành) → exit 1', async () => {
    const c = cap();
    expect(await revShareMain({ year: '1' }, { io: c.io, now: NOW, connect: failConnect })).toBe(1);
    expect(c.text()).toContain('chưa chốt ngay_ky_hop_dong');
    const p = cfgFile({ ngay_bat_dau_van_hanh: '2025-01-01' });
    expect(
      await revShareMain(
        { year: '1' },
        { io: c.io, now: NOW, connect: failConnect, configFile: p },
      ),
    ).toBe(1);
  });

  it('kỳ chưa đóng / sai dạng / trước vận hành / cấu hình hỏng / tham số sai', async () => {
    const d = { io: cap().io, now: NOW, connect: failConnect };
    expect(await revShareMain({ quarter: '2026-Q4' }, d)).toBe(2);
    expect(await revShareMain({ quarter: '2026-9' }, d)).toBe(2);
    expect(
      await revShareMain(
        { quarter: '2026-Q3' },
        { ...d, configFile: cfgFile({ ngay_bat_dau_van_hanh: '2026-11-01' }) },
      ),
    ).toBe(2);
    expect(
      await revShareMain(
        { year: '1' },
        { ...d, configFile: cfgFile({ ngay_ky_hop_dong: '2025-12-01' }) },
      ),
    ).toBe(2);
    expect(
      await revShareMain(
        { quarter: '2026-Q3' },
        { ...d, configFile: cfgFile({ ty_le_phi_van_hanh: 7 }) },
      ),
    ).toBe(1);
    for (const o of [
      {},
      { quarter: '2026-Q3', year: '1' },
      { quarter: '2026-Q3', record: true, dryRun: true },
      { year: '1', record: true },
      { quarter: '2026-Q3', now: 'hôm qua' },
      { year: 'một' },
    ]) {
      expect(await revShareMain(o, d), JSON.stringify(o)).toBe(2);
    }
  });

  it('DB down → exit 2, không ghi file', async () => {
    const out = mkdtempSync(join(TMP, 'out-'));
    const c = cap();
    expect(
      await revShareMain(
        { quarter: '2026-Q3', outDir: out },
        { io: c.io, now: NOW, connect: async () => null },
      ),
    ).toBe(2);
    expect(c.text()).toContain('không kết nối được Postgres');
    expect(readdirSync(out)).toEqual([]);
  });

  it('phí quý vẫn cắt theo ngày vận hành; năm hợp tác theo ngày ký; 29/02 liền mạch', () => {
    const cfg = loadConfig(
      cfgFile({ ngay_ky_hop_dong: '2026-01-05', ngay_bat_dau_van_hanh: '2026-08-20' }),
    );
    expect(quarterRange('2026-Q3', NOW, cfg.start)).toEqual(['2026-08-20', '2026-10-01']);
    expect(() => quarterRange('2026-Q2', NOW, cfg.start)).toThrow('trước ngày bắt đầu');
    const far = new Date('2040-01-01T00:00:00+07:00');
    const spans = [1, 2, 3, 4, 5].map((n) => yearRange('2028-02-29', n, far));
    expect(spans[0]).toEqual(['2028-02-29', '2029-03-01']);
    expect(spans[3]).toEqual(['2031-03-01', '2032-02-29']);
    for (let i = 1; i < spans.length; i++) expect(spans[i - 1]?.[1]).toBe(spans[i]?.[0]);
  });
});
