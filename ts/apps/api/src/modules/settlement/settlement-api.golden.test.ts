import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type Call,
  SP_ESCROW_DETAIL,
  SP_ESCROW_LIST,
  TT_STATEMENT_TX,
  TT_STATEMENTS,
} from './market-api-lite.js';
import {
  type ApiCfg,
  apiVnd,
  type Comp,
  type Comps,
  checkRows,
  fetchShopee,
  fetchTiktok,
  flatten,
  fromIsoDate,
  LIST,
  loadMap,
  MapError,
  parseWindow,
  type Rec,
  rowsSha,
  run,
  sourceKind,
  toRows,
  vnBounds,
} from './settlement-api.js';

// Golden sinh bằng chạy `ingest/settlement_api.py` THẬT trên đầu vào cố định (call giả trong tiến
// trình — không gọi sàn). TS phải ra y hệt (thông điệp/exit code/trạng thái thành phần).
type J = Record<string, unknown>;
// Đọc như `parsePy` của nhóm market (số thực → PyFloat): giữ phân biệt int/float y như Python.
const G = parsePyJson(
  readFileSync(new URL('./__fixtures__/settlement-api.golden.json', import.meta.url), 'utf8'),
) as J;
const TMP = mkdtempSync(join(tmpdir(), 'settle-api-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const toComps = (o: J): Comps =>
  new Map(Object.entries(o).map(([k, v]) => [k, (v === '<LIST>' ? LIST : v) as Comp]));
const fromComps = (m: Comps): J =>
  Object.fromEntries([...m].map(([k, v]) => [k, v === LIST ? '<LIST>' : v]));
const recJson = (r: Rec): J => ({ ...r, comps: fromComps(r.comps) });
const recOf = (o: J): Rec => ({ ...(o as unknown as Rec), comps: toComps(o.comps as J) });

/** Router giả như script golden: tra (path, page_no|order_sn|page_token, statement_id). */
function router(routes: J): { call: Call; calls: J[] } {
  const calls: J[] = [];
  const call: Call = (method, path, params, _body, pathParams) => {
    calls.push({ method, path, params: { ...params }, path_params: pathParams ?? null });
    let key = path;
    if (path === SP_ESCROW_LIST) key += `#${params.page_no}`;
    else if (path === SP_ESCROW_DETAIL) key += `#${params.order_sn}`;
    else if (path === TT_STATEMENTS) key += `#${params.page_token ?? ''}`;
    else if (path === TT_STATEMENT_TX) {
      key += `#${pathParams?.statement_id}#${params.page_token ?? ''}`;
    }
    if (Object.hasOwn(routes, key)) return structuredClone(routes[key]);
    if (Object.hasOwn(routes, `*${path}`)) return structuredClone(routes[`*${path}`]);
    throw new Error(`KeyError ${key}`);
  };
  return { call, calls };
}

// Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn = fail-closed sớm hơn): quyết định ánh xạ có `dau` là số thực.
const TS_STRICTER_MAP = (doc: string) => doc.includes('"dau": 1.0');

describe('settlement-api golden', () => {
  it('loadMap (chốt/chưa chốt, quyết định sai dạng → MapError)', () => {
    for (const c of G.load_map as J[]) {
      const p = join(TMP, 'settlement_api_map.json');
      writeFileSync(p, Buffer.from(c.doc_b64 as string, 'base64'));
      const res = c.res as J;
      const tag = `${c.channel} ${Buffer.from(c.doc_b64 as string, 'base64')
        .toString()
        .slice(0, 200)}`;
      const doc = Buffer.from(c.doc_b64 as string, 'base64').toString();
      if (TS_STRICTER_MAP(doc)) {
        // Python nhận `dau: 1.0` lúc nạp rồi hỏng ở check_rows (exit 1); TS chặn ngay (exit 1).
        expect(() => loadMap(c.channel as string, p), tag).toThrow("quyết định 'x?y' sai dạng");
      } else if ('ok' in res) {
        const r = loadMap(c.channel as string, p);
        expect([r.cfg, r.why], tag).toEqual(res.ok);
      } else {
        expect(() => loadMap(c.channel as string, p), tag).toThrow(MapError);
        try {
          loadMap(c.channel as string, p);
        } catch (e) {
          expect((e as Error).message, tag).toBe(res.msg);
        }
      }
    }
  });

  it('apiVnd', () => {
    for (const [v, res] of G.vnd as [unknown, J][]) {
      if ('ok' in res) expect(apiVnd(v, 'x', 't'), JSON.stringify(v)).toBe(res.ok);
      else
        expect(() => apiVnd(v, 'commission_fee', 't'), JSON.stringify(v)).toThrow(
          res.msg as string,
        );
    }
  });

  it('flatten', () => {
    for (const [d, want] of G.flatten as [J, J][]) {
      expect(fromComps(flatten(d, 't', new Set(['skip'])))).toEqual(want);
    }
  });

  it('fetchShopee / fetchTiktok (phân trang, trùng, kiểm field, trần trang)', async () => {
    for (const c of G.fetch as J[]) {
      const { call, calls } = router(c.routes as J);
      const fn = c.channel === 'shopee' ? fetchShopee : fetchTiktok;
      const res = c.res as J;
      let got: J;
      try {
        got = { ok: (await fn(call, c.d0 as string, c.d1 as string)).map(recJson) };
      } catch (e) {
        got = { err: (e as Error).name, msg: (e as Error).message };
      }
      expect(got, c.name as string).toEqual(res);
      expect(calls, c.name as string).toEqual(c.calls);
    }
  });

  it('toRows (dấu, LẠ, null chưa chốt, danh sách, tiền tệ theo từng trường, khi_vang)', () => {
    for (const c of G.to_rows as J[]) {
      const recs = (c.recs as J[]).map(recOf);
      const [rows, blocked, errs, st] = toRows(c.channel as string, recs, c.cfg as ApiCfg);
      expect([rows, blocked, errs, Object.fromEntries(st)], c.name as string).toEqual(c.res);
    }
  });

  it('rowsSha (sha nội dung chuẩn hóa, không theo row_no)', () => {
    for (const [ch, kind, rows, want] of G.rows_sha as [string, string, J[], string][]) {
      expect(rowsSha(ch, kind, rows as never)).toBe(want);
    }
  });

  it('parseWindow + fromIsoDate (Python 3.12 date.fromisoformat)', () => {
    for (const [a, b, want] of G.parse_window as [string, string, unknown][]) {
      expect(parseWindow(a, b), `${a} ${b}`).toEqual(want);
    }
    for (const [s, res] of G.fromiso as [string, J][]) {
      expect(fromIsoDate(s), s).toBe('ok' in res ? res.ok : null);
    }
  });

  it('sourceKind (TikTok chỉ api_live khi TIKTOK_API_ENV=live)', () => {
    for (const [ch, base, env, want] of G.source_kind as [
      string,
      string,
      string | null,
      string,
    ][]) {
      const e = env === null ? {} : { TIKTOK_API_ENV: env };
      expect(sourceKind(ch, base, e), `${ch} ${base} ${env}`).toBe(want);
    }
  });

  it('checkRows + vnBounds', () => {
    for (const [rows, want] of G.check_rows as [J[], string[]][]) {
      expect(checkRows(rows), JSON.stringify(rows).slice(0, 200)).toEqual(want);
    }
    for (const [a, b, want] of G.vn_bounds as [string, string, number[]][]) {
      expect(vnBounds(a, b)).toEqual(want);
    }
  });

  it('run — stdout + exit code y hệt Python (dry-run, chưa chốt, LẠ, lỗi dữ liệu, rỗng)', async () => {
    for (const c of G.run as J[]) {
      const p = join(TMP, `map_${c.name}.json`);
      writeFileSync(p, JSON.stringify(c.cfg_doc));
      const { cfg } = loadMap(c.channel as string, p);
      const { call } = router(c.routes as J);
      const lines: string[] = [];
      const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) };
      const rc = await run(
        {
          channel: c.channel as string,
          window: ['2026-10-01', '2026-10-07'],
          dryRun: c.dry_run as boolean,
        },
        call,
        cfg,
        null,
        c.kind as string,
        { io, mapFile: p },
      );
      expect(rc, c.name as string).toBe(c.rc);
      expect(lines.map((l) => `${l}\n`).join(''), c.name as string).toBe(c.out);
    }
  });
});
