import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { Env } from '@samsam/core/env';
import { connErrName, pgErrName } from '@samsam/core/ops/tx';
import { settings } from '@samsam/core/rollout/rollout';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CmdDeps,
  MarketApiCommand,
  marketApiMain,
  type SettlementHooks,
} from '../market/market.command.js';
import { MarketModule } from '../market/market.module.js';
import { fakeServer } from '../market/market.testing.js';
import {
  SP_ESCROW_DETAIL,
  SP_ESCROW_LIST,
  TT_STATEMENT_TX,
  TT_STATEMENTS,
} from './market-api-lite.js';
import { ConfigError, frac, loadConfig } from './rev-share.js';
import { settlementCsvMain } from './settlement.command.js';
import { SettlementModule } from './settlement.module.js';
import { sourceKind, write } from './settlement-api.js';
import { loadFees } from './settlement-csv.js';
import { settlementHooks } from './settlement-hooks.js';

// Bản vá review đối kháng nhóm settlement. Golden sinh bằng chạy Python THẬT (script ngoài repo
// `scratchpad/settlement/gen_review_golden.py`): `source_kind` với base lạ, số JSON tràn 1e400 (→ inf)
// ở biểu phí / rev_share.json, và E2E `python -m ingest.market_api --kind settlement [--dry-run]` qua
// server HTTP GIẢ 127.0.0.1 (không gọi sàn thật, không DB).
type J = Record<string, unknown>;
const G = JSON.parse(
  readFileSync(new URL('./__fixtures__/settlement-review.golden.json', import.meta.url), 'utf8'),
) as J;
const TMP = mkdtempSync(join(tmpdir(), 'settle-review-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const dbErr = (code: string) => Object.assign(new pg.DatabaseError('giả', 0, 'error'), { code });

describe('MAJOR: quyết toán API nối vào `market-api --kind settlement`', () => {
  beforeEach(() => {
    settings.forceMode = 'van_hanh'; // Python golden: rollout.blocked = nhánh DB down → không chặn
  });
  afterEach(() => {
    settings.forceMode = null;
  });

  it('SettlementModule (@Global) cấp SETTLEMENT_HOOKS cho MarketApiCommand của nhóm market', async () => {
    const mod = await Test.createTestingModule({
      imports: [SettlementModule, MarketModule],
    }).compile();
    const hooks = (mod.get(MarketApiCommand) as unknown as { settlement: SettlementHooks | null })
      .settlement;
    expect(hooks).not.toBeNull();
    // bảng ánh xạ của repo chưa chốt → [blocked] exit 2 TRƯỚC mọi request
    const lines: string[] = [];
    const r = await (hooks as SettlementHooks).precheck(
      'shopee',
      'https://partner.shopeemobile.com',
      false,
      (s) => lines.push(s),
    );
    expect(r).toEqual({ ctx: null, rc: 2 });
    expect(lines[0]).toMatch(/^\[blocked\] shopee: bảng ánh xạ quyết toán CHƯA dùng được/);
    await mod.close();
  });

  const TX_RE = /^\/finance\/202501\/statements\/([^/]+)\/statement_transactions$/;
  it.each((G.e2e as J[]).map((c) => [c.name as string, c]))(
    'E2E %s: stdout + exit code + số request y hệt Python, dry-run không ghi job_runs',
    async (_n, c) => {
      const routes = c.routes as J;
      const s = await fakeServer((_m, path, query) => {
        const one = (k: string) => query[k]?.[0] ?? '';
        let key = path;
        if (path === SP_ESCROW_LIST) key += `#${one('page_no')}`;
        else if (path === SP_ESCROW_DETAIL) key += `#${one('order_sn')}`;
        else if (path === TT_STATEMENTS) key += `#${one('page_token')}`;
        const m = TX_RE.exec(path);
        if (m) key = `${TT_STATEMENT_TX}#${m[1]}#${one('page_token')}`;
        return Object.hasOwn(routes, key) ? [200, routes[key]] : [404, { error: 'not_found' }];
      });
      try {
        let mapFile: string | undefined;
        const map = c.map as 'repo' | { doc?: unknown; text?: string };
        if (map !== 'repo') {
          const dir = join(TMP, c.name as string);
          mkdirSync(dir);
          mapFile = join(dir, 'settlement_api_map.json');
          writeFileSync(mapFile, map.text ?? JSON.stringify(map.doc));
        }
        const env: Env = {
          ...(G.e2e_creds as Env),
          SHOPEE_API_BASE: s.url,
          TIKTOK_API_BASE: s.url,
          DATABASE_URL: 'postgresql://fake@127.0.0.1:9/x',
        };
        const out: string[] = [];
        const jobs: string[] = [];
        const d: CmdDeps = {
          env,
          log: (l) => out.push(l),
          err: (l) => out.push(l),
          openService: async () => {
            throw new Error('connect không được gọi');
          },
          jobRun: (async (name: string) => {
            jobs.push(name);
            return 99;
          }) as unknown as CmdDeps['jobRun'],
          settlement: settlementHooks({ env, mapFile }),
        };
        const rc = await marketApiMain(
          {
            channel: c.channel as string,
            kind: 'settlement',
            from: '2026-10-01',
            to: '2026-10-07',
            dryRun: c.dry_run as boolean,
          },
          d,
        );
        expect(rc).toBe(c.rc);
        expect(out.map((l) => `${l}\n`).join('')).toBe(c.out);
        expect(s.requests.length).toBe(c.requests);
        expect(jobs).toEqual([]);
      } finally {
        await s.close();
      }
    },
  );
});

describe('MINOR: số JSON tràn (1e400 → Infinity) = ngoài khoảng như Python, không TypeError', () => {
  // Khác biệt ĐÃ BIẾT (shortcut của bản port, TS lỏng hơn): `1e-400` = float 0.0 — Python từ chối ở
  // chỗ đòi int (tolerance_vnd, tu_vnd), TS nhận 0 vì JSON.parse không phân biệt 0.0 với 0 (như `100.0`).
  const LOOSER = (text: string) => /"(tolerance_vnd|tu_vnd)": 1e-400/.test(text);
  it('loadFees (settlement_fees.json)', () => {
    for (const c of G.load_fees as J[]) {
      const p = join(TMP, 'settlement_fees.json');
      writeFileSync(p, c.text as string);
      const [fees, why] = loadFees(p);
      if (LOOSER(c.text as string)) {
        expect([fees !== null, why, c.ok]).toEqual([true, null, false]);
        continue;
      }
      expect(fees !== null, c.text as string).toBe(c.ok);
      expect(why, c.text as string).toBe(c.why);
    }
  });

  it('rev_share.json loadConfig + frac', () => {
    for (const c of G.rev_share_config as J[]) {
      const p = join(TMP, 'rev_share.json');
      writeFileSync(p, c.text as string);
      let got: J;
      try {
        loadConfig(p);
        got = { ok: true };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        got = { err: e.message };
      }
      if (LOOSER(c.text as string)) {
        expect([got, c.err]).toEqual([{ ok: true }, 'muc_thuong[1].tu_vnd: null hoặc số ≥ 0']);
        continue;
      }
      expect(got, c.text as string).toEqual('ok' in c ? { ok: true } : { err: c.err });
    }
    for (const [lit, why] of G.frac as [string, string][]) {
      expect(frac(JSON.parse(lit), 'x')).toEqual([null, why]);
    }
  });

  it('CLI settlement-csv: biểu phí 1e400 → [err] … — không connect, exit 1', async () => {
    const p = join(TMP, 'fees_inf.json');
    writeFileSync(
      p,
      (G.load_fees as J[]).find((c) => (c.text as string).includes('"fixed_fee_pct": 1e400'))
        ?.text as string,
    );
    const out: string[] = [];
    const rc = await settlementCsvMain(
      { reconcile: true },
      {
        feesFile: p,
        io: { out: (s) => out.push(s), err: (s) => out.push(s) },
        service: async () => {
          throw new Error('connect không được gọi');
        },
      },
    );
    expect(rc).toBe(1);
    expect(out).toEqual([
      '[err] fees_inf.json/shopee.fixed_fee_pct: ngoài 0..0.5 — không connect.',
    ]);
  });
});

describe('MINOR: sourceKind theo urllib.parse.urlsplit(base).hostname của Python', () => {
  // Khác biệt CÓ CHỦ ĐÍCH (TS chặt hơn): netloc có '[' → khong_ro. Python: ValueError của urlsplit
  // (traceback — want null) hoặc, với userinfo chứa IPv6 hợp lệ, vẫn lấy host sau '@' (api_live).
  const TS_STRICTER = new Set([
    'https://[partner.shopeemobile.com]',
    'https://[127.0.0.1]',
    'https://a[b]@partner.shopeemobile.com',
    'https://[partner.shopeemobile.com',
    'https://[::1]@partner.shopeemobile.com',
  ]);
  it('golden', () => {
    for (const [ch, base, want, envv] of G.source_kind as [
      string,
      string,
      string | null,
      string?,
    ][]) {
      const env = envv ? { TIKTOK_API_ENV: envv } : {};
      const got = sourceKind(ch, base, env);
      if (TS_STRICTER.has(base)) {
        expect(got, base).toBe('khong_ro');
        continue;
      }
      expect(got, `${ch} ${JSON.stringify(base)}`).toBe(want);
    }
  });
});

describe('MINOR: tên lỗi DB như psycopg', () => {
  it('connect: psycopg.connect chỉ ném OperationalError (hết hạn → ConnectionTimeout)', () => {
    for (const code of ['28P01', '3D000', '57P03', '53300', '08006']) {
      expect(connErrName(dbErr(code)), code).toBe('OperationalError');
    }
    expect(
      connErrName(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ).toBe('OperationalError');
    expect(connErrName(new Error('Connection terminated due to connection timeout'))).toBe(
      'ConnectionTimeout',
    );
    expect(connErrName(new Error('timeout exceeded when trying to connect'))).toBe(
      'ConnectionTimeout',
    );
  });

  it('truy vấn: SQLSTATE lạ → lớp gốc theo psycopg.errors.get_base_exception', () => {
    for (const [code, want] of G.base_exc as [string, string][]) {
      expect(pgErrName(dbErr(code)), code).toBe(want);
    }
    expect(pgErrName(dbErr('23505'))).toBe('UniqueViolation');
    expect(pgErrName(new Error('Connection terminated unexpectedly'))).toBe('OperationalError');
  });

  it('settlement-csv / settlement-api: không connect được (3D000) → OperationalError, exit 1', async () => {
    const pool = {
      connect: async () => {
        throw dbErr('3D000');
      },
      end: async () => {},
    } as unknown as pg.Pool;
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    expect(await settlementCsvMain({ report: true }, { io, service: async () => pool })).toBe(1);
    expect(out).toEqual(['[err] không kết nối được Postgres: OperationalError']);
    out.length = 0;
    const row = {
      row_no: 1,
      order_id_hash: '0123456789abcdef',
      settled_on: '2026-10-03',
      txn_type: null,
      order_amount: 1,
      fixed_fee: 0,
      payment_fee: 0,
      service_fee: 0,
      shipping_fee: 0,
      voucher_seller: 0,
      affiliate: 0,
      refund: 0,
      payout: 1,
    };
    const fees = {} as never;
    expect(
      await write('shopee', [row] as never, 'api_live', fees, '2026-10-01', '2026-10-07', {
        io,
        service: async () => pool,
      }),
    ).toBe(1);
    expect(out).toEqual(['[err] không kết nối được Postgres: OperationalError']);
  });
});
