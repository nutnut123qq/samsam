import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { DATA_DIR as REPO_DATA, repoPath } from '@samsam/core/paths';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyRows,
  articleAssetRow,
  COLS,
  claimRows,
  collectRows,
  DOMAIN_ORDER,
  type Domain,
  dropSampleGarden,
  imageAssetRows,
  iterJsonl,
  KeyErr,
  langOf,
  orderRow,
  PLOTS_DELETE_SQL,
  PLOTS_UPSERT_SUFFIX,
  PRODUCTS_RETIRE_SQL,
  PRODUCTS_UPSERT_SQL,
  PyTypeErr,
  plotLogRow,
  plotRow,
  productRow,
  type Row,
  SourceError,
  urlSegment,
} from './core-store.js';
import { pgTsToIso } from './py.js';

// Dịch tests/test_core_store.py (phần thuần + apply_rows trên conn giả) và phần thuần của
// tests/test_v15_p11_core_store.py (P11.3 nguồn hỏng → SourceError). Golden sinh bằng chạy hàm Python
// THẬT (scratchpad loaders_golden/gen_core.py, DSN chết): lang_of/url_segment/iter_jsonl/*_row/
// claim_rows/collect_rows trên thư mục tạm/SQL/drop_sample_garden.
//
// TS_STRICTER (Python nhận ở bước đọc rồi hỏng muộn hơn — lúc ghi DB hoặc traceback; TS SourceError
// trước khi kết nối, không ghi gì):
//   S_images_str      `images` là chuỗi — Python tạo 1 asset cho MỖI ký tự.
//   S_claims_str      `approved_claims` là chuỗi — Python tạo 1 claim cho MỖI ký tự.
//   S_nan / nan       NaN trong JSON — Python nhận (DB lỗi khi ghi bigint).
//   S_invalid_utf8 / invalid_utf8  byte không phải UTF-8 — Python UnicodeDecodeError (traceback).
//   S_url_list        `url` là list — Python AttributeError (traceback).
//   S_desc_obj        object ở cột text — psycopg không ghi được (traceback); node-pg sẽ ghi JSON.
//   S_lone_surrogate  surrogate lẻ — Python UnicodeEncodeError lúc ghi; node-pg thay bằng U+FFFD.
//   S_nul             NUL trong chuỗi — psycopg DataError lúc ghi (traceback).
//   S_wl_source_list  `source` của claim là list — psycopg không ghi list vào cột text.

type Res = { ok?: unknown; error?: string; msg?: string };
const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/core_store.golden.json', import.meta.url), 'utf8'),
) as Record<string, unknown> & {
  lang_of: [string, string][];
  url_segment: [string, string][];
  iter_jsonl: Record<string, Res & { bytes_b64: string }>;
  product_mappers: Record<string, { rec: string; product_row: Res; image_asset_rows: Res }>;
  article_asset_row: Record<string, { rec: string; res: Res }>;
  plot_row: Record<string, { rec: string; res: Res }>;
  plot_log_row: Record<string, { rec: string; res: Res }>;
  order_row: Record<string, { rec: string; res: Res }>;
  claim_rows: Record<string, { entry: string; res: Res }>;
  claim_seg: Record<string, string>;
  collect_rows: Record<
    string,
    Res & { stdout: string; files: Record<string, string | { b64: string }> }
  >;
  DOMAIN_ORDER: string[];
  COLS: Record<string, string[]>;
  PRODUCTS_UPSERT_SQL: string;
  PRODUCTS_RETIRE_SQL: string;
  PLOTS_DELETE_SQL: string;
  PLOTS_UPSERT_SUFFIX: string;
  drop_sample_garden: [string, string, unknown][];
};

const TMP = mkdtempSync(join(tmpdir(), 'loaders-core-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Kết quả TS dạng golden: {ok} | {error, msg} (KeyErr/PyTypeErr = KeyError/TypeError Python). */
function run(fn: () => unknown): Res {
  try {
    return { ok: fn() };
  } catch (e) {
    if (e instanceof SourceError) return { error: 'SourceError', msg: e.message };
    if (e instanceof KeyErr) return { error: 'KeyError', msg: e.message };
    if (e instanceof PyTypeErr) return { error: 'TypeError', msg: e.message };
    throw e;
  }
}
/** Thông điệp lỗi JSON của Python ≠ JS: so tới dấu '(' của phần chi tiết. */
const jsonMsg = (m: string | undefined) =>
  (m ?? '').replace(/(JSON hỏng|\.json hỏng) \(.*$/s, '$1 (…)');
const sameErr = (ts: Res, py: Res) => {
  expect(ts.error).toBe(py.error === 'AttributeError' ? 'TypeError' : py.error);
  expect(jsonMsg(ts.msg)).toBe(jsonMsg(py.msg));
};

describe('core_store — golden Python', () => {
  it('lang_of / url_segment', () => {
    for (const [u, want] of G.lang_of) expect(langOf(u), u).toBe(want);
    for (const [u, want] of G.url_segment) expect(urlSegment(u), u).toBe(want);
  });

  it('iter_jsonl: universal newline, strip Python, _doc, dòng hỏng có số dòng', () => {
    const stricter: Record<string, string> = {
      nan: 'NaN',
      invalid_utf8: 'không phải UTF-8',
    };
    for (const [name, c] of Object.entries(G.iter_jsonl)) {
      const p = join(TMP, 'f.jsonl');
      writeFileSync(p, Buffer.from(c.bytes_b64, 'base64'));
      const got = run(() => iterJsonl(p));
      if (name in stricter) {
        expect(got.error, name).toBe('SourceError');
        continue;
      }
      if (c.error) sameErr(got, c);
      else expect(got, name).toEqual({ ok: c.ok });
    }
  });

  it('product_row / image_asset_rows (KeyError, TypeError như Python)', () => {
    for (const [name, c] of Object.entries(G.product_mappers)) {
      const rec = JSON.parse(c.rec);
      for (const [fn, want] of [
        [productRow, c.product_row],
        [imageAssetRows, c.image_asset_rows],
      ] as const) {
        const got = run(() => fn(rec));
        if (want.error) sameErr(got, want);
        else expect(got, `${name} ${fn.name}`).toEqual({ ok: want.ok });
      }
    }
  });

  it('article/plot/plot_log/order row', () => {
    const cases: [
      Record<string, { rec: string; res: Res }>,
      (r: Record<string, unknown>) => Row,
    ][] = [
      [G.article_asset_row, (r) => articleAssetRow(r, 'news.jsonl')],
      [G.plot_row, (r) => plotRow(r, 'sample:sample_plots.jsonl')],
      [G.plot_log_row, (r) => plotLogRow(r, 'sample:x')],
      [G.order_row, (r) => orderRow(r, 'sample:sample_orders.jsonl')],
    ];
    for (const [table, fn] of cases) {
      for (const [name, c] of Object.entries(table)) {
        const got = run(() => fn(JSON.parse(c.rec)));
        if (c.res.error) sameErr(got, c.res);
        else expect(got, name).toEqual({ ok: c.res.ok });
      }
    }
    // orders không lưu PII khách: field khách trong record mẫu bị rớt.
    const full = (G.order_row.full as { res: { ok: Row } }).res.ok;
    expect(Object.keys(full).sort()).toEqual([...COLS.orders].sort());
  });

  it('claim_rows: link best-effort qua URL (\\S Unicode của Python), lỗi kiểu như Python', () => {
    const seg = new Map(Object.entries(G.claim_seg));
    for (const [name, c] of Object.entries(G.claim_rows)) {
      const got = run(() => claimRows('sku-x', JSON.parse(c.entry), seg));
      if (c.res.error) sameErr(got, c.res);
      else expect(got, name).toEqual({ ok: c.res.ok });
    }
  });

  it('collect_rows trên thư mục tạm: domain, cảnh báo, SourceError', () => {
    const stricter = new Set([
      'S_images_str',
      'S_claims_str',
      'S_nan',
      'S_invalid_utf8',
      'S_url_list',
      'S_desc_obj',
      'S_lone_surrogate',
      'S_nul',
      'S_wl_source_list',
    ]);
    let n = 0;
    for (const [name, c] of Object.entries(G.collect_rows)) {
      const root = join(TMP, `c${n++}`);
      const dir = join(root, 'data');
      mkdirSync(dir, { recursive: true });
      for (const [f, body] of Object.entries(c.files)) {
        writeFileSync(
          join(dir, f),
          typeof body === 'string' ? body : Buffer.from(body.b64, 'base64'),
        );
      }
      const out: string[] = [];
      const got = run(() => collectRows(dir, (s) => out.push(s)));
      const norm = (s: string) => s.split(root).join('<DIR>').replaceAll('\\', '/');
      if (stricter.has(name)) {
        expect(got.error, name).toBe('SourceError');
        continue;
      }
      expect(out.map((l) => `${norm(l)}\n`).join(''), name).toBe(c.stdout);
      if (c.error) {
        expect(got.error, name).toBe(c.error);
        expect(jsonMsg(norm(got.msg ?? '')), name).toBe(jsonMsg(c.msg));
      } else {
        expect(got, name).toEqual({ ok: c.ok });
      }
    }
  });

  it('hằng số + SQL khớp Python (%(c)s/%s → $n, %% → %)', () => {
    expect(DOMAIN_ORDER).toEqual(G.DOMAIN_ORDER);
    expect(COLS).toEqual(G.COLS);
    const named = (sql: string, cols: readonly string[]) =>
      sql.replace(/%\((\w+)\)s/g, (_, c) => `$${cols.indexOf(c) + 1}`).replaceAll('%%', '%');
    let i = 0;
    const seq = (sql: string) => {
      i = 0;
      return sql.replace(/%s/g, () => `$${++i}`).replaceAll('%%', '%');
    };
    expect(PRODUCTS_UPSERT_SQL).toBe(named(G.PRODUCTS_UPSERT_SQL, COLS.products));
    expect(PRODUCTS_RETIRE_SQL).toBe(seq(G.PRODUCTS_RETIRE_SQL));
    expect(PLOTS_DELETE_SQL).toBe(seq(G.PLOTS_DELETE_SQL));
    expect(PLOTS_UPSERT_SUFFIX).toBe(G.PLOTS_UPSERT_SUFFIX);
    expect(
      dropSampleGarden([
        ['plots', 'sample:a', []],
        ['plot_logs', 'sample:b', []],
        ['orders', 'sample:c', []],
        ['plots', 'manual.jsonl', []],
        ['products', 'products.jsonl', []],
      ]),
    ).toEqual(G.drop_sample_garden);
  });
});

// ---------------------------------------------------------------- dịch test_core_store.py

const PROD = {
  id: 'nv-saphraton-48',
  name: 'SAPHRATON',
  price_vnd: 1000000,
  description: '...',
  url: 'http://x/vi/shops/saphraton-48.html',
  images: ['http://x/a.png', 'http://x/b.png'],
};

describe('core_store — thuần (tests/test_core_store.py)', () => {
  it('iter_jsonl bỏ _doc và dòng trống', () => {
    const p = join(TMP, 'f2.jsonl');
    writeFileSync(p, '{"_doc": "comment"}\n{"id": "a"}\n\n{"id": "b"}\n');
    expect(iterJsonl(p).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('product_row: trường + lang; giá null giữ null (không bịa giá)', () => {
    const row = productRow(PROD);
    expect([row.id, row.price_vnd, row.lang, row.source]).toEqual([
      'nv-saphraton-48',
      1000000,
      'vi',
      'products.jsonl',
    ]);
    expect(productRow({ ...PROD, id: 'wc-1', url: 'http://x/en/product/a/' }).lang).toBe('en');
    expect(productRow({ ...PROD, price_vnd: null }).price_vnd).toBeNull();
  });

  it('image_asset_rows + article_asset_row', () => {
    expect(imageAssetRows(PROD).map((a) => a.id)).toEqual([
      'nv-saphraton-48#img0',
      'nv-saphraton-48#img1',
    ]);
    expect(imageAssetRows({ ...PROD, images: null })).toEqual([]);
    const art = articleAssetRow({ id: 'nv-x', title: 'Bài', url: 'http://x/a' }, 'news.jsonl');
    expect([art.kind, art.source]).toEqual(['article', 'news.jsonl']);
  });

  it('collect_rows trên data/ thật: đủ domain, số theo gate board', () => {
    const doms = new Map(collectRows(REPO_DATA, () => {}).map(([t, s, r]) => [t, [s, r] as const]));
    expect(new Set(doms.keys())).toEqual(new Set(DOMAIN_ORDER));
    const rows = (t: string) => (doms.get(t as never)?.[1] ?? []) as Row[];
    expect(rows('products').length).toBeGreaterThanOrEqual(27);
    expect(new Set(rows('claims_approved').map((r) => r.sku_key)).size).toBe(10);
    expect(rows('assets').length).toBeGreaterThanOrEqual(140);
    expect(rows('plots')).toHaveLength(3);
    expect(rows('plot_logs').length).toBeGreaterThanOrEqual(5);
    expect(rows('orders').length).toBeGreaterThanOrEqual(5);
  });

  it('file mẫu đủ trường bắt buộc; plot_logs.plot_id trỏ plots trong file mẫu (FK)', () => {
    for (const [f, keys] of [
      ['sample_plots.jsonl', ['id', 'location', 'tree_count']],
      ['sample_plot_logs.jsonl', ['plot_id', 'ts', 'activity']],
      ['sample_orders.jsonl', ['id', 'ts', 'channel']],
    ] as const) {
      const recs = iterJsonl(join(REPO_DATA, f));
      expect(recs.length, f).toBeGreaterThan(0);
      for (const r of recs)
        for (const k of keys) expect(Object.hasOwn(r, k), `${f} ${k}`).toBe(true);
    }
    const plotIds = new Set(iterJsonl(join(REPO_DATA, 'sample_plots.jsonl')).map((r) => r.id));
    for (const r of iterJsonl(join(REPO_DATA, 'sample_plot_logs.jsonl'))) {
      expect(plotIds.has(r.plot_id)).toBe(true);
    }
  });

  it('schema.sql có 6 bảng lõi + chunks', () => {
    const sql = readFileSync(repoPath('docs', 'schema.sql'), 'utf8');
    for (const t of [...DOMAIN_ORDER, 'chunks']) {
      expect(new RegExp(`create table if not exists ${t}\\b`).test(sql), t).toBe(true);
    }
  });

  it('pgTsToIso = datetime.isoformat() của psycopg', () => {
    expect(pgTsToIso('2026-10-29 03:04:05+00')).toBe('2026-10-29T03:04:05+00:00');
    expect(pgTsToIso('2026-10-29 03:04:05.12+07')).toBe('2026-10-29T03:04:05.120000+07:00');
    expect(pgTsToIso('2026-10-29 03:04:05.123456-05:30')).toBe('2026-10-29T03:04:05.123456-05:30');
  });
});

// ---------------------------------------------------------------- apply_rows trên conn giả

/** Conn giả ghi mọi câu SQL (Python `_FakeConn`): select trả 0 dòng. */
function fakeDb(): { db: Db; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;
  return { db, sqls };
}

describe('core_store — apply_rows (conn giả)', () => {
  it('không domain → không câu lệnh nào (đặc biệt không delete)', async () => {
    const { db, sqls } = fakeDb();
    await applyRows(db, []);
    expect(sqls).toEqual([]);
  });

  it('delete-by-source bảng CON trước, products KHÔNG bị delete; ghi cha trước; không đụng chunks', async () => {
    const { db, sqls } = fakeDb();
    const one = (t: keyof typeof COLS) =>
      [Object.fromEntries(COLS[t].map((c) => [c, 'x']))] as Row[];
    const domains: Domain[] = [
      ['products', 'products.jsonl', one('products')],
      ['claims_approved', 'claims_whitelist.json', one('claims_approved')],
      ['plots', 'sample:plots.jsonl', one('plots')],
      ['plot_logs', 'sample:plot_logs.jsonl', one('plot_logs')],
      ['orders', 'sample:orders.jsonl', one('orders')],
      ['assets', 'multi', one('assets')],
    ];
    await applyRows(db, domains);
    const deletes = sqls.filter((s) => s.startsWith('delete'));
    expect(deletes).toHaveLength(5);
    expect(deletes[0]?.startsWith('delete from assets')).toBe(true);
    expect(deletes.every((d) => d.includes('where source'))).toBe(true);
    expect(sqls.some((s) => s.includes('delete from products'))).toBe(false);
    const last = sqls.map((s) => s.startsWith('delete')).lastIndexOf(true);
    const inserts = sqls.slice(last + 1).filter((s) => s.startsWith('insert'));
    expect(inserts).toHaveLength(6);
    expect(inserts[0]?.startsWith('insert into products')).toBe(true);
    expect(inserts[0]).toContain('on conflict (id) do update');
    expect(inserts[1]?.startsWith('insert into claims_approved')).toBe(true);
    expect(sqls.every((s) => !s.includes('chunks'))).toBe(true);
  });
});
