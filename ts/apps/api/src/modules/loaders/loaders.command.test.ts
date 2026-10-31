import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '@samsam/core/env';
import { resetOpsDeps } from '@samsam/core/ops/deps';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { settings } from '@samsam/core/rollout/rollout';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CmdDeps,
  coreStoreMain,
  type GoldenOpts,
  goldenStoreMain,
} from './loaders.command.js';

// Dịch phần CLI không cần DB: tests/test_golden_store.py (argparse exit 2 trước khi kết nối, file
// hỏng exit 1 không kết nối), tests/test_v15_p11_core_store.py P11.3 (nguồn hỏng → exit 1, không
// kết nối DB), tests/test_v15_p12_policies.py (cổng loader golden_store: chưa cấu hình + tính năng TẮT
// → exit 2 trước khi ghi; chan_khi_tat chặn; nap_ca_khi_tat đi tiếp), tests/test_v14_p2_service_auth
// (chế độ thực thiếu LOADER_DATABASE_URL → exit 2).

const TMP = mkdtempSync(join(tmpdir(), 'loaders-cli-'));
const DEAD: Env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u@127.0.0.1:9/x' };

/** Pool giả: đếm mọi lần chạm DB — ca "không kết nối" phải giữ 0. `select 1` (lượt kiểm kết nối của
 * cổng loader) trả lời được; `connect()` (bước ghi/đọc thật) luôn lỗi kết nối. */
function fakePool(): { pool: Pool; touched: string[] } {
  const touched: string[] = [];
  const pool = {
    connect: async () => {
      touched.push('connect');
      throw new Error('Connection refused');
    },
    query: async (sql: string) => {
      touched.push(sql);
      if (sql === 'select 1') return { rows: [{ x: 1 }], rowCount: 1 };
      throw new Error('Connection refused');
    },
    end: async () => {},
  } as unknown as Pool;
  return { pool, touched };
}

let out: string[] = [];
let errs: string[] = [];
let fake: ReturnType<typeof fakePool>;
const deps = (over: CmdDeps = {}): CmdDeps => ({
  env: DEAD,
  log: (s) => out.push(s),
  err: (s) => errs.push(s),
  openService: async () => fake.pool,
  openHuman: () => fake.pool,
  ...over,
});

beforeAll(() => {
  wireCore(null);
});
beforeEach(() => {
  out = [];
  errs = [];
  fake = fakePool();
  settings.forceMode = 'van_hanh';
});
afterAll(() => {
  settings.forceMode = null;
  resetOpsDeps();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- golden-store

describe('golden-store CLI — tham số (exit 2 trước khi kết nối)', () => {
  const CASES: GoldenOpts[] = [
    { approvePrice: '1' },
    { approvePrice: '1', by: '   ' },
    { approvePrice: '1', by: 'x'.repeat(101) },
    { approvePrice: '1', by: 'a\nb' },
    { approvePrice: '1', by: 'A', report: true },
    { report: true, file: 'data/golden_skus.json' },
    { approvePrice: '1', by: 'A', file: 'x.json' },
    { by: 'A' },
    { approvePrice: 'abc', by: 'A' },
  ];
  for (const o of CASES) {
    it(JSON.stringify(o), async () => {
      expect(await goldenStoreMain(o, deps())).toBe(2);
      expect(fake.touched).toEqual([]);
      expect(errs.join('\n')).toMatch(/^golden_store: error: /);
    });
  }
  it('--approve-price nhận số kiểu Python int() (" +7 ", "1_0")', async () => {
    // Vượt qua argparse → tới kết nối (pool giả từ chối) = exit 1, không phải 2.
    expect(await goldenStoreMain({ approvePrice: ' +7 ', by: 'A' }, deps())).toBe(1);
    expect(await goldenStoreMain({ approvePrice: '1_0', by: 'A' }, deps())).toBe(1);
    expect(out.join('\n')).toContain('không kết nối được Postgres');
  });
});

const BAD_FILES: Record<string, string> = {
  'empty.json': '',
  'blank.json': '  \n',
  'broken.json': '{"skus": [',
  'obj.json': '{}',
  'doc_only.json': '{"_doc": "chỉ comment"}',
  'skus_empty.json': '{"_doc": "x", "skus": []}',
};

describe('golden-store CLI — file hỏng / sai luật: exit 1, KHÔNG kết nối', () => {
  it('mọi biến thể "không có dữ liệu" → [warn] exit 1', async () => {
    const paths = [join(TMP, 'missing.json')];
    for (const [n, body] of Object.entries(BAD_FILES)) {
      writeFileSync(join(TMP, n), body);
      paths.push(join(TMP, n));
    }
    for (const p of paths) expect(await goldenStoreMain({ file: p }, deps()), p).toBe(1);
    expect(out.filter((l) => l.startsWith('[warn]'))).toHaveLength(paths.length);
    expect(out.every((l) => l.endsWith('— không connect, không ghi/xóa gì.'))).toBe(true);
    expect(fake.touched).toEqual([]);
  });

  it('--file "" = Path("") = "." → thiếu file .', async () => {
    expect(await goldenStoreMain({ file: '' }, deps())).toBe(1);
    expect(out).toEqual(['[warn] thiếu file . — không connect, không ghi/xóa gì.']);
  });

  it('file parse được nhưng sai luật → in từng lỗi + tổng, exit 1', async () => {
    const doc = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8'));
    doc.skus[0].prices.shopee.list = 999999;
    const p = join(TMP, 'rule.json');
    writeFileSync(p, JSON.stringify(doc));
    expect(await goldenStoreMain({ file: p }, deps())).toBe(1);
    expect(out.join('\n')).toContain('R1');
    expect(out.at(-1)).toMatch(/^\[err\] \d+ lỗi — không nạp gì\.$/);
    expect(fake.touched).toEqual([]);
  });

  it('TS_STRICTER: self_declaration_ok = 1 → lỗi trước khi kết nối', async () => {
    const doc = JSON.parse(readFileSync(dataPath('golden_skus.json'), 'utf8'));
    doc.skus[0].self_declaration_ok = 1;
    const p = join(TMP, 'sd.json');
    writeFileSync(p, JSON.stringify(doc));
    expect(await goldenStoreMain({ file: p }, deps())).toBe(1);
    expect(out.join('\n')).toContain('self_declaration_ok');
    expect(fake.touched).toEqual([]);
  });
});

describe('golden-store CLI — login dịch vụ + cổng loader (HĐ 6.7)', () => {
  it('chế độ thực thiếu LOADER_DATABASE_URL → exit 2, không kết nối', async () => {
    const env = { ...DEAD, APPROVAL_ENFORCE: '1' };
    expect(await goldenStoreMain({}, deps({ env }))).toBe(2);
    expect(out.join('\n')).toContain('LOADER_DATABASE_URL');
    expect(fake.touched).toEqual([]);
  });

  it('dev thiếu mọi DSN → cổng không đọc được giai đoạn → [rollout] exit 2', async () => {
    settings.forceMode = null;
    expect(await goldenStoreMain({}, deps({ env: { NODE_ENV: 'test' } }))).toBe(2);
    expect(out.join('\n')).toContain('không kết nối được DB');
  });

  const gateCfg = (policy: string | null) => {
    const d = JSON.parse(readFileSync(dataPath('loader_gate.json'), 'utf8'));
    Object.assign(
      d.loaders.golden_store,
      policy
        ? { chinh_sach: policy, chot_boi: 'Chủ Khối Giả Lập', can_cu: 'Biên bản giả lập số 1' }
        : { chinh_sach: null },
    );
    const f = join(TMP, `gate-${policy}.json`);
    writeFileSync(f, JSON.stringify(d));
    return f;
  };
  /** Chạy tới bước kết nối ghi đầu tiên: chỉ lượt 'select 1' của cổng được phép trước đó. */
  const reachedWrite = () => fake.touched.includes('connect');

  it('tính năng TẮT + chính sách CHƯA CẤU HÌNH → exit 2, không tới bước ghi', async () => {
    settings.forceMode = 'tat';
    expect(await goldenStoreMain({}, deps())).toBe(2);
    const text = out.join('\n');
    expect(text).toContain('CHƯA CẤU HÌNH');
    expect(text).toMatch(/\[rollout\] loader golden_store: .*KHÔNG nạp/);
    expect(reachedWrite()).toBe(false);
  });

  it('chan_khi_tat chặn; nap_ca_khi_tat vẫn nạp khi tắt; không tắt + chưa cấu hình → nạp', async () => {
    settings.forceMode = 'tat';
    expect(await goldenStoreMain({}, deps({ gateConfig: gateCfg('chan_khi_tat') }))).toBe(2);
    expect(reachedWrite()).toBe(false);
    out = [];
    expect(await goldenStoreMain({}, deps({ gateConfig: gateCfg('nap_ca_khi_tat') }))).toBe(1);
    expect(out.join('\n')).toContain('vẫn nạp theo chính sách');
    expect(reachedWrite()).toBe(true);
    fake = fakePool();
    out = [];
    settings.forceMode = 'chay_thu';
    expect(await goldenStoreMain({}, deps({ gateConfig: gateCfg(null) }))).toBe(1);
    expect(out.join('\n')).toContain('CHƯA CẤU HÌNH');
    expect(reachedWrite()).toBe(true);
  });

  it('--report / --approve-price là NGƯỜI: không qua cổng loader, thiếu DATABASE_URL → exit 1', async () => {
    settings.forceMode = 'tat';
    expect(await goldenStoreMain({ report: true }, deps({ env: { NODE_ENV: 'test' } }))).toBe(1);
    expect(out).toEqual(['[err] thiếu DATABASE_URL trong .env']);
  });
});

// ---------------------------------------------------------------- core-store

const P1 = {
  id: 'nv-p1',
  name: 'Sâm mẫu 1',
  price_vnd: 100000,
  description: 'mô tả',
  url: 'http://x/vi/shops/nv-p1.html',
  images: ['http://x/1.png'],
};
const P2 = {
  ...P1,
  id: 'nv-p2',
  name: 'Sâm mẫu 2',
  url: 'http://x/vi/shops/nv-p2.html',
  images: [],
};
const WL = {
  'sku-p1': {
    approved_claims: ['hỗ trợ bồi bổ'],
    source: 'http://x/vi/shops/nv-p1.html — trang SP',
  },
};
const jl = (...recs: unknown[]) => recs.map((r) => `${JSON.stringify(r)}\n`).join('');
const BAD_PRODUCTS: Record<string, string | null> = {
  missing: null,
  empty: '',
  doc_only: '{"_doc": "chỉ comment"}\n',
  brace: '{}\n',
  corrupt: '{"id": "nv-p1", "name": "cắt cụt',
  not_object: '[1, 2]\n',
  no_name: '{"id": "nv-p1"}\n',
  dup_id: jl(P1, { ...P1, name: 'khác' }),
};
const OTHER_CORRUPT: [string, string][] = [
  ['claims_whitelist.json', '{hỏng'],
  ['claims_whitelist.json', '[1]'],
  ['sample_orders.jsonl', '{}\n'],
  ['sample_plots.jsonl', '{"id": "KV"\n'],
  ['news.jsonl', '{}\n'],
];

function dataDir(name: string, over: Record<string, string | null> = {}): string {
  const d = join(TMP, name, 'data');
  mkdirSync(d, { recursive: true });
  const files: Record<string, string | null> = {
    'products.jsonl': jl(P1, P2),
    'claims_whitelist.json': JSON.stringify(WL),
    ...over,
  };
  for (const [f, body] of Object.entries(files)) if (body !== null) writeFileSync(join(d, f), body);
  return d;
}

describe('core-store CLI — nguồn hỏng: exit 1, KHÔNG kết nối DB (P11.3)', () => {
  const cases: [string, Record<string, string | null>][] = [
    ...Object.entries(BAD_PRODUCTS).map(
      ([k, v]) =>
        [`products ${k}`, { 'products.jsonl': v }] as [string, Record<string, string | null>],
    ),
    ...OTHER_CORRUPT.map(
      ([f, body], i) =>
        [`other${i} ${f}`, { [f]: body }] as [string, Record<string, string | null>],
    ),
  ];
  cases.forEach(([label, over], i) => {
    it(label, async () => {
      expect(await coreStoreMain(deps({ dataDir: dataDir(`bad${i}`, over) }))).toBe(1);
      expect(out.join('\n')).toContain('[err] file nguồn hỏng — không nạp gì:');
      expect(out.some((l) => l.startsWith('[load]'))).toBe(false);
      expect(fake.touched).toEqual([]);
    });
  });

  it('dev thiếu mọi DSN → "thiếu DATABASE_URL" exit 1; chế độ thực thiếu LOADER_DATABASE_URL → exit 2', async () => {
    expect(await coreStoreMain(deps({ env: { NODE_ENV: 'test' } }))).toBe(1);
    expect(out).toEqual(['[err] thiếu DATABASE_URL trong .env']);
    out = [];
    expect(await coreStoreMain(deps({ env: { ...DEAD, AUTH_MODE: 'local' } }))).toBe(2);
    expect(out.join('\n')).toContain('LOADER_DATABASE_URL');
    expect(fake.touched).toEqual([]);
  });

  it('nguồn tốt + DB không kết nối được → [load] rồi "không kết nối được Postgres" exit 1', async () => {
    expect(await coreStoreMain(deps({ dataDir: dataDir('good') }))).toBe(1);
    expect(out.filter((l) => l.startsWith('[load]'))).toEqual([
      '[load] products: 2 rows',
      '[load] claims_approved: 1 rows',
      '[load] assets: 1 rows',
    ]);
    expect(out.at(-1)).toBe('[err] không kết nối được Postgres: OperationalError');
  });
});
