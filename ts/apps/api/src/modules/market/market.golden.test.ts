import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PyFloat } from '@samsam/core/ops/py-json';
import { afterAll, describe, expect, it } from 'vitest';
import { parseWindow } from './market.command.js';
import { fakeServer } from './market.testing.js';
import {
  apiBase,
  type Doc,
  errCode,
  fetchRows,
  idOf,
  loadStatusMap,
  loadTokens,
  numOf,
  refreshToken,
  request,
  rowsSha256,
  saveTokens,
  signShopee,
  signTiktok,
  strOf,
} from './market-api.js';
import {
  findAlerts,
  loadMapping,
  type Mapping,
  mapSku,
  type Prices,
  type Row,
  readExport,
  type Skus,
} from './market-csv.js';
import { parsePy } from './py-json.js';
import { cellOf, clean, safe, toInt } from './table.js';

// Golden sinh bằng chạy hàm Python THẬT (scratchpad golden_market/gen.py, DSN chết) trên đầu vào cố
// định: ingest/market_csv.py (_to_int/_cell/_clean/_safe/read_export CSV+XLSX/map_sku/find_alerts) và
// ingest/market_api.py (ký, _num/_id/_str, fetch qua call giả, _err_code, api_base, _request/
// refresh_token bắt request, load_status_map/load_tokens, save_tokens) + settlement_api.parse_window.
// Đọc bằng `parsePy` để giữ int/float như Python (236000.0 ≠ 236000).

type G = Record<string, unknown>;
const G = parsePy(
  readFileSync(new URL('./__fixtures__/market.golden.json', import.meta.url), 'utf8'),
) as G;
const arr = (k: string) => G[k] as unknown[][];
const objs = (k: string) => G[k] as G[];
const MAP = loadMapping()[0] as Mapping;
const TMP = mkdtempSync(join(tmpdir(), 'market-golden-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const num = (v: unknown) => (v instanceof PyFloat ? v.v : v);
const res = (fn: () => unknown) => {
  try {
    return { ok: fn() };
  } catch (e) {
    return { err: (e as Error).message };
  }
};

// KHÁC Python có chủ đích (TS chặt hơn / thư viện khác) — tên ca + lý do:
const TS_DIFF: Record<string, string> = {
  // exceljs bỏ qua <dimension>; openpyxl ghi số nguyên lớn hơn 2^53 vẫn giữ chính xác (không có ca).
  parse_window_isoweek: 'Python nhận dạng tuần ISO (2026-W40-4); TS chỉ YYYY-MM-DD / YYYYMMDD',
  // Không có ca (cần tài nguyên lớn/mạng) — ghi để không bị coi là tương đương:
  xlsx_not_streamed:
    'openpyxl read_only dừng ở dòng 100001 ("file > N dòng", exit 1); exceljs load cả workbook — XLSX hàng triệu dòng < 50 MB làm hết RAM thay vì exit 1 (0 ghi DB)',
  http_proxy_env:
    'urllib theo HTTPS_PROXY/HTTP_PROXY/NO_PROXY; node:http bỏ qua → cần proxy mới ra được sàn thì TS báo lỗi mạng',
  token_lock_file:
    'Python flock `<kho>.lock`; TS khóa pid ở `<kho>.ts.lock` — không loại trừ chéo Python↔TS (đừng refresh cùng kho từ hai bản)',
  loader_login_api:
    'Python _ingest nạp bằng DATABASE_URL; TS bằng login loader — chế độ thực thiếu LOADER_DATABASE_URL → exit 2 trước mọi request',
};

describe('market golden — market_csv', () => {
  it('_to_int', () => {
    for (const [s, cap, want] of arr('to_int')) {
      expect(toInt(s as string, Number(cap)), String(s)).toBe(want);
    }
  });
  it('_cell / _clean / _safe', () => {
    for (const [v, want] of arr('cell')) {
      const input = v === '__date__' ? new Date(Date.UTC(2026, 9, 1, 8, 5, 3)) : num(v);
      expect(cellOf(input), String(v)).toBe(want);
    }
    for (const [s, n, want] of arr('clean')) expect(clean(s, Number(n))).toBe(want);
    for (const [s, want] of arr('safe')) expect(safe(s)).toBe(want);
  });
  it('read_export CSV (fixture repo + ca biên)', async () => {
    for (const c of objs('read_export')) {
      const dir = mkdtempSync(join(TMP, 'csv-'));
      const p = join(dir, c.name as string);
      writeFileSync(p, Buffer.from(c.data as string, 'base64'));
      const [rows, errs, sha] = await readExport(p, c.channel as string, c.kind as string, MAP);
      expect({ rows, errs, sha }, c.name as string).toEqual({
        rows: c.rows,
        errs: c.errs,
        sha: c.sha,
      });
    }
  });
  it('read_export XLSX (openpyxl ghi → exceljs đọc ra cùng dòng/lỗi)', async () => {
    for (const c of objs('read_export_xlsx')) {
      const dir = mkdtempSync(join(TMP, 'x-'));
      const p = join(dir, c.name as string);
      writeFileSync(p, Buffer.from(c.data as string, 'base64'));
      const [rows, errs] = await readExport(p, 'shopee', c.kind as string, MAP);
      expect({ rows, errs }, c.name as string).toEqual({ rows: c.rows, errs: c.errs });
    }
  });
  const skus: Skus = new Map(Object.entries(G.skus as Record<string, never>));
  const prices: Prices = new Map(
    Object.entries(G.prices as Record<string, unknown[]>).map(([k, v]) => [
      k,
      [Number(v[0]), Number(v[1]), v[2] as string | null],
    ]),
  );
  it('map_sku', () => {
    for (const [row, ch, want] of arr('map_sku')) {
      expect(mapSku(row as Row, ch as string, skus)).toEqual(want);
    }
  });
  it('find_alerts (thứ tự + detail theo nguồn)', () => {
    for (const c of objs('find_alerts')) {
      const got = findAlerts(
        c.rows as Row[],
        'shopee',
        c.kind as string,
        skus,
        prices,
        c.inactive as string[],
      );
      const out = [...got.values()].map((a) => [a.kind, a.itemId, a.sellerSku, a.sku, a.detail]);
      expect(out, c.name as string).toEqual(c.out);
    }
  });
});

describe('market golden — market_api', () => {
  it('chữ ký shopee/tiktok', () => {
    for (const [k, pid, path, ts, tok, shop, want] of arr('sign_shopee')) {
      expect(
        signShopee(
          k as string,
          pid as string,
          path as string,
          Number(ts),
          tok as string,
          shop as string,
        ),
      ).toBe(want);
    }
    for (const [sec, path, q, body, want] of arr('sign_tiktok')) {
      expect(
        signTiktok(sec as string, path as string, q as Record<string, string>, body as string),
      ).toBe(want);
    }
  });
  it('_num / _id / _str', () => {
    for (const [v, f, want] of arr('num'))
      expect(
        res(() => numOf(v, f as string, 'w')),
        String(v),
      ).toEqual(want);
    for (const [v, want] of arr('id'))
      expect(
        res(() => idOf(v, 'item_id', 'w')),
        String(v),
      ).toEqual(want);
    for (const [v, w300, w3] of arr('str')) {
      expect(
        res(() => strOf(v, 'title', 'w')),
        String(v),
      ).toEqual(w300);
      expect(
        res(() => strOf(v, 'title', 'w', 3)),
        String(v),
      ).toEqual(w3);
    }
  });
  it('_err_code', () => {
    for (const [code, creds, extra, want] of arr('err_code')) {
      expect(
        errCode(code, creds as Record<string, unknown>, ...(extra as unknown[])),
        String(code),
      ).toBe(want);
    }
  });
  it('api_base', () => {
    for (const [raw, want] of arr('api_base')) {
      const env = raw === null ? {} : { SHOPEE_API_BASE: raw as string };
      expect(
        res(() => apiBase('shopee', null, null, env)),
        String(raw),
      ).toEqual(want);
    }
  });
  it('fetch qua call giả: cùng chuỗi lời gọi, cùng dòng, cùng sha', async () => {
    const smap = loadStatusMap();
    for (const c of objs('fetch')) {
      const calls = [...(c.calls as unknown[][])];
      const call = async (
        m: string,
        p: string,
        params: Record<string, unknown>,
        body?: unknown,
      ) => {
        const want = calls.shift() as unknown[];
        expect([m, p, params, body ?? null], c.name as string).toEqual(want.slice(0, 4));
        return want[4] as Doc;
      };
      const out = await fetchRows(
        c.channel as string,
        c.kind as string,
        call,
        smap,
        Number(c.days),
        1700000000.9,
      ).then(
        (rows) => ({ rows, sha: rowsSha256(c.channel as string, c.kind as string, rows) }),
        (e: Error) => ({ err: e.message }),
      );
      const want = 'err' in c ? { err: c.err } : { rows: c.rows, sha: c.sha };
      expect(out, c.name as string).toEqual(want);
      expect(calls, `${c.name}: hết lời gọi`).toEqual([]);
    }
  });
  it('_request: cùng URL/query/header/body tới server, cùng kết quả', async () => {
    const creds = G.creds as Record<string, string>;
    for (const c of objs('request')) {
      const doc = c.doc;
      const srv = await fakeServer(() => [200, doc]);
      try {
        const [ch, m, p, params, body] = c.args as [string, string, string, G, G | undefined];
        const kw = c.kw as { path_params?: G };
        const out = await request(ch, m, p, params, body ?? null, {
          creds,
          base: srv.url,
          timestamp: 1700000000,
          pathParams: kw.path_params,
        }).then(
          (ok) => ({ ok }),
          (e: Error) => ({ err: `${e.name}: ${e.message}` }),
        );
        expect(out, JSON.stringify(c.args)).toEqual(c.out);
        const sent = c.sent as G | null;
        if (sent === null) {
          expect(srv.requests).toEqual([]);
          continue;
        }
        const r = srv.requests[0] as (typeof srv.requests)[number];
        expect(r.method).toBe(sent.method);
        expect(r.rawUrl).toBe((sent.url as string).replace('http://127.0.0.1:9', ''));
        expect(r.body).toBe(sent.data ?? '');
        for (const [k, v] of Object.entries(sent.headers as Record<string, string>)) {
          if (k !== 'host' && k !== 'user-agent' && k !== 'content-length' && k !== 'connection') {
            expect(r.headers[k], k).toBe(v);
          }
        }
      } finally {
        await srv.close();
      }
    }
  });
  it('refresh_token: cùng request, cùng kết quả/lỗi (1 lần, không thử lại)', async () => {
    for (const c of objs('refresh')) {
      const srv = await fakeServer(() => [200, c.doc]);
      try {
        const out = await refreshToken(
          c.channel as string,
          c.creds as Record<string, string>,
          c.refresh,
          srv.url,
          { timestamp: 1700000000 },
        ).then(
          (ok) => ({ ok }),
          (e: Error) => ({ err: `${e.name}: ${e.message}` }),
        );
        expect(out, JSON.stringify(c.doc)).toEqual(c.out);
        const sent = c.sent as G | null;
        expect(srv.requests.length).toBe(sent === null ? 0 : 1);
        if (sent !== null) {
          const r = srv.requests[0] as (typeof srv.requests)[number];
          expect(r.method).toBe(sent.method);
          expect(r.rawUrl).toBe((sent.url as string).replace('http://127.0.0.1:9', ''));
          expect(r.body).toBe(sent.data ?? '');
        }
      } finally {
        await srv.close();
      }
    }
  });
  it('load_status_map / load_tokens: cùng tên lỗi Python', () => {
    expect(loadStatusMap()).toEqual(G.status_map_ok);
    for (const c of objs('status_map_err')) {
      const p = join(mkdtempSync(join(TMP, 'sm-')), `sm_${c.name}.json`);
      if (c.data !== null) writeFileSync(p, Buffer.from(c.data as string, 'base64'));
      const got = res(() => loadStatusMap(p));
      expect('ok' in got ? 'ok' : got.err, c.name as string).toBe(c.err);
    }
    for (const c of objs('tokens_err')) {
      const p = join(mkdtempSync(join(TMP, 'tk-')), `tk_${c.name}.json`);
      if (c.data !== null) writeFileSync(p, Buffer.from(c.data as string, 'base64'));
      expect(
        res(() => loadTokens(p)),
        c.name as string,
      ).toEqual(c.res);
    }
  });
  it('save_tokens: cùng byte (sort_keys, ensure_ascii, phân cách mặc định)', () => {
    const s = G.save_tokens as G;
    const p = join(mkdtempSync(join(TMP, 'save-')), 'kho.json');
    saveTokens(p, s.doc as Record<string, unknown>);
    expect(readFileSync(p).toString('base64')).toBe(s.bytes);
  });
  it('settlement_api.parse_window (kiểm tham số --kind settlement)', () => {
    for (const [a, b, want] of arr('parse_window')) {
      expect(parseWindow(a as string, b as string), `${a} ${b}`).toEqual(want);
    }
    expect(parseWindow('2026-W40-4', '2026-10-02'), TS_DIFF.parse_window_isoweek).toBe(
      '--from/--to phải là YYYY-MM-DD',
    );
  });
});
