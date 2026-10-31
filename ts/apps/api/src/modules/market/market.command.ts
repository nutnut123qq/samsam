import { basename } from 'node:path';
import { Inject, Optional } from '@nestjs/common';
import { type Service, ServiceBindError, serviceDsn, servicePool } from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import { jobRun } from '@samsam/core/ops/job-runs';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { parseDay, vnFormat } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { isDict } from '@samsam/core/ops/py-json';
import { isDbError, pgErrName } from '@samsam/core/ops/tx';
import { blocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import pg, { type Pool, type PoolClient } from 'pg';
import {
  CHANNELS as API_CHANNELS,
  ApiError,
  apiBase,
  ConfigError,
  type Creds,
  DAYS_DEFAULT,
  DAYS_MAX,
  DataError,
  doRefresh,
  FEATURE,
  fetchRows,
  KEYS,
  loadStatusMap,
  loadTokens,
  REFRESH_MARGIN_S,
  type RefreshDeps,
  readCreds,
  request,
  rowsSha256,
  ScopeError,
  type StatusMap,
  TOKEN_FILE_VAR,
  tokenFile,
} from './market-api.js';
import {
  CHANNELS,
  KINDS,
  listOf,
  load,
  loadMapping,
  type Mapping,
  type Row,
  readExport,
  reconcile,
  report,
  specOf,
} from './market-csv.js';
import { isPyInt, truthy } from './py-json.js';
import { clean, MAX_PRINT_ERRS } from './table.js';

// Lệnh CLI thay `python -m ingest.market_csv` (`market-csv`) và `python -m ingest.market_api`
// (`market-api`) — cùng cờ, exit code, thông điệp chính. Exit: 0 ok/skip · 1 file/cấu hình/API/DB
// lỗi · 2 sai tham số / bị chặn (login dịch vụ, cổng loader HĐ 6.7, rollout tắt, thiếu key sàn).
// Không có job lịch (deploy/onprem/jobs.json không gọi 2 lệnh này).

export type CmdDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  mapFile?: string;
  statusFile?: string;
  /** Python `auth.bind_service("loader")` + connect (test truyền pool DB test). */
  openService?: (s: Service, env: Env) => Promise<Pool>;
  jobRun?: typeof jobRun;
  /** Giờ hiện tại (giây epoch) — `time.time()`. */
  now?: () => number;
  /** Gốc repo cho luật "kho token ngoài repo" (test). */
  repoRoot?: string;
  refresh?: RefreshDeps['refresh'];
  /** Quyết toán qua API (`--kind settlement`) — bản TS của `ingest.settlement_api` (nhóm settlement)
   * do bước tích hợp nối; chưa nối → [blocked] exit 2, 0 request. */
  settlement?: SettlementHooks | null;
};

/** Cửa nối `ingest.settlement_api` (precheck/run) vào `market-api --kind settlement`. */
export type SettlementHooks = {
  /** `sa.precheck` — TRƯỚC mọi request: → {ctx} | {rc} (đã in lý do). */
  precheck(
    channel: string,
    base: string,
    dryRun: boolean,
    log: (s: string) => void,
  ): Promise<{ ctx: unknown; rc: null } | { ctx: null; rc: number }>;
  /** `sa.run` → exit code. */
  run(
    args: { channel: string; window: [string, string]; dryRun: boolean },
    creds: Creds,
    base: string,
    ctx: unknown,
    log: (s: string) => void,
  ): Promise<number>;
};
export const SETTLEMENT_HOOKS = Symbol('SETTLEMENT_HOOKS');
export const SETTLEMENT_MAX_DAYS = 31;

/** `settlement_api.parse_window`. TS chặt hơn: chỉ YYYY-MM-DD / YYYYMMDD (Python còn nhận dạng tuần ISO). */
export function parseWindow(a: string, b: string): [string, string] | string {
  const iso = (s: string) => {
    const t = /^[0-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
    return parseDay(t) === null ? null : t;
  };
  const d0 = iso(a);
  const d1 = iso(b);
  if (d0 === null || d1 === null) return '--from/--to phải là YYYY-MM-DD';
  const n = Math.round((Date.parse(d1) - Date.parse(d0)) / 86_400_000);
  if (n < 0 || n + 1 > SETTLEMENT_MAX_DAYS) {
    return `--to ≥ --from và tối đa ${SETTLEMENT_MAX_DAYS} ngày`;
  }
  return [d0, d1];
}

// ---------------------------------------------------------------- DB chung

type Loader = { pool: Pool | null; bindWhy: string | null; hasDsn: boolean };

/** Python `auth.bind_service("loader")` rồi `psycopg.connect(DATABASE_URL)`. Chế độ thực: thiếu
 * `LOADER_DATABASE_URL` / login superuser-owner-sai role → lý do (exit 2). Dev thiếu cả hai biến →
 * không DSN (exit 1 "thiếu DATABASE_URL"). Không kết nối được → pool null. */
async function openLoader(d: CmdDeps, env: Env): Promise<Loader> {
  const sd = serviceDsn('loader', env);
  if (sd.error !== null) {
    return approvalEnforced(env)
      ? { pool: null, bindWhy: sd.error, hasDsn: false }
      : { pool: null, bindWhy: null, hasDsn: false };
  }
  let pool: Pool;
  try {
    pool = await (d.openService ?? servicePool)('loader', env);
  } catch (e) {
    if (e instanceof ServiceBindError) return { pool: null, bindWhy: e.message, hasDsn: true };
    throw e;
  }
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return { pool: null, bindWhy: null, hasDsn: true };
  }
  return { pool, bindWhy: null, hasDsn: true };
}

/** Lỗi DB khi nạp (đã rollback) → exit code | null (không phải lỗi DB → ném lại). */
function dbFail(e: unknown, skipMsg: string, log: (s: string) => void): number | null {
  const code = (e as { code?: unknown }).code;
  if (e instanceof pg.DatabaseError && code === '23505') {
    if (String(e.constraint ?? '').includes('file_sha256')) {
      log(skipMsg);
      return 0;
    }
    log('[err] lỗi DB, đã rollback: UniqueViolation');
    return 1;
  }
  if (e instanceof pg.DatabaseError && code === '42P01') {
    log('[err] thiếu bảng market_* / golden — chạy `python scripts/apply_schema.py` trước.');
    return 1;
  }
  if (isDbError(e)) {
    log(`[err] lỗi DB, đã rollback: ${pgErrName(e)}`);
    return 1;
  }
  return null;
}

type Loaded = { sid: string; mapped: number; alerts: Map<string, number> } | { skip: string };

/** 1 giao dịch: đã có sha → skip; còn lại snapshot + rows + reconcile → commit. */
async function loadTx(
  pool: Pool,
  rows: Row[],
  channel: string,
  kind: string,
  fname: string,
  sha: string,
  inactive: string[],
): Promise<Loaded> {
  const c: PoolClient = await pool.connect();
  try {
    await c.query('begin');
    const old = (
      await c.query(
        'select id, channel, export_kind from market_snapshots where file_sha256 = $1',
        [sha],
      )
    ).rows[0];
    if (old) {
      await c.query('rollback');
      return { skip: `#${old.id} ${old.channel}/${old.export_kind}` };
    }
    const [sid, mapped] = await load(c, rows, channel, kind, fname, sha);
    const alerts = await reconcile(c, sid, inactive);
    await c.query('commit');
    return { sid, mapped, alerts };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

function printAlerts(alerts: Map<string, number>, empty: string, log: (s: string) => void): number {
  const kept = alerts.get('kept_absent') ?? 0;
  const items = [...alerts]
    .filter(([k]) => k !== 'kept_absent')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  log(`[alerts] ${items.join(', ') || empty}`);
  return kept;
}

// ---------------------------------------------------------------- market-csv

export type CsvOpts = { file?: string; channel?: string; kind?: string; report?: boolean };

const choice = (v: string | undefined, xs: readonly string[]) => v === undefined || xs.includes(v);
const chooseMsg = (flag: string, v: string, xs: readonly string[]) =>
  `argument ${flag}: invalid choice: '${v}' (choose from ${xs.map((x) => `'${x}'`).join(', ')})`;

/** `python -m ingest.market_csv --file F --channel K --kind L | --report`. */
export async function marketCsvMain(o: CsvOpts, d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const usage = (msg: string) => {
    (d.err ?? console.error)(`market_csv: error: ${msg}`);
    return 2;
  };
  if (!choice(o.channel, CHANNELS))
    return usage(chooseMsg('--channel', o.channel as string, CHANNELS));
  if (!choice(o.kind, KINDS)) return usage(chooseMsg('--kind', o.kind as string, KINDS));
  const nOps = Number(o.file !== undefined) + Number(Boolean(o.report));
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--file | --report)');
  if (nOps === 0) return usage('cần --file ... hoặc --report');
  if (o.file !== undefined && (o.channel === undefined || o.kind === undefined)) {
    return usage('--file cần đủ --channel và --kind');
  }
  if (o.report && (o.channel || o.kind)) return usage('--channel/--kind chỉ dùng với --file');

  const [mapping, mapWhy] = loadMapping(d.mapFile);
  let rows: Row[] = [];
  let sha = '';
  if (o.file !== undefined) {
    if (mapping === null) {
      log(`[err] ${mapWhy}`);
      return 1;
    }
    const [rs, errs, h] = await readExport(o.file, o.channel as string, o.kind as string, mapping);
    if (errs.length) {
      for (const e of errs.slice(0, MAX_PRINT_ERRS)) log(`[err] ${e}`);
      if (errs.length > MAX_PRINT_ERRS)
        log(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
      log(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
      return 1;
    }
    rows = rs;
    sha = h as string;
  }
  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối login
  // superuser/owner/thiếu biến.
  const ld = await openLoader(d, env);
  if (ld.bindWhy !== null) {
    log(`[err] ${ld.bindWhy}`);
    return 2;
  }
  const pool = ld.pool;
  try {
    // v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) — chưa cấu hình + tính năng tắt
    // → không nạp (--report chỉ đọc: không chặn).
    if (o.file !== undefined) {
      const why = await loaderGate('market_csv', pool, undefined, log);
      if (why) {
        log(`[rollout] ${why}`);
        return 2;
      }
    }
    if (!ld.hasDsn) {
      log('[err] thiếu DATABASE_URL trong .env');
      return 1;
    }
    if (pool === null) {
      log('[err] không kết nối được Postgres: OperationalError');
      return 1;
    }
    if (o.report) {
      try {
        await report(pool, mapping, log);
        return 0;
      } catch (e) {
        const rc = dbFail(e, '', log);
        if (rc === null) throw e;
        return rc;
      }
    }
    const file = o.file as string;
    const ch = o.channel as string;
    const kind = o.kind as string;
    const inactive = listOf(specOf(mapping as Mapping, ch, kind), 'inactive_status');
    let r: Loaded;
    try {
      r = await loadTx(pool, rows, ch, kind, basename(file), sha, inactive);
    } catch (e) {
      const rc = dbFail(e, '[skip] file vừa được nạp song song — không ghi gì.', log);
      if (rc === null) throw e;
      return rc;
    }
    if ('skip' in r) {
      log(`[skip] file đã nạp: snapshot ${r.skip} — không ghi gì.`);
      return 0;
    }
    log(
      `[load] snapshot #${r.sid} ${ch}/${kind} ${clean(basename(file))}: ${rows.length} dòng, map golden ${r.mapped}`,
    );
    const kept = printAlerts(r.alerts, 'export order — không đối chiếu ở P1', log);
    if (kept) {
      log(
        `[warn] ${kept} cảnh báo ${ch}/${kind} không thấy item trong file — GIỮ MỞ (vắng ≠ đã sửa; xuất TOÀN BỘ sản phẩm, không lọc, để đóng)`,
      );
    }
    log('[done]');
    return 0;
  } finally {
    await pool?.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- market-api

export type ApiOpts = {
  channel?: string;
  kind?: string;
  refresh?: boolean;
  days?: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
};

/** `python -m ingest.market_api --channel K (--kind listing|order [--days N] | --kind settlement
 * --from --to [--dry-run] | --refresh)`. */
export async function marketApiMain(o: ApiOpts, d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const now = d.now ?? (() => Date.now() / 1000);
  const usage = (msg: string) => {
    (d.err ?? console.error)(`market_api: error: ${msg}`);
    return 2;
  };
  const kinds = ['listing', 'order', 'settlement', 'ads'];
  if (!choice(o.channel, API_CHANNELS)) {
    return usage(chooseMsg('--channel', o.channel as string, API_CHANNELS));
  }
  if (!choice(o.kind, kinds)) return usage(chooseMsg('--kind', o.kind as string, kinds));
  let days: number | null = null;
  if (o.days !== undefined) {
    const n = pyInt(o.days);
    if (n === null) return usage(`argument --days: invalid int value: '${o.days}'`);
    days = Number(n);
  }
  if (o.channel === undefined) return usage('the following arguments are required: --channel');
  const ch = o.channel;
  const refresh = Boolean(o.refresh);
  if (Boolean(o.kind) === refresh) return usage('chọn đúng 1: --kind hoặc --refresh');
  if (o.kind === 'ads') {
    return usage('ads chỉ qua file — `ingest.market_csv` (API quảng cáo = external-dep)');
  }
  if (days !== null && o.kind !== 'order') return usage('--days chỉ dùng với --kind order');
  let window: [string, string] | null = null;
  if (o.kind === 'settlement') {
    if (!(o.from && o.to)) return usage('--kind settlement cần --from và --to');
    const w = parseWindow(o.from, o.to);
    if (typeof w === 'string') return usage(w);
    window = w;
  } else if (o.from || o.to || o.dryRun) {
    return usage('--from/--to/--dry-run chỉ dùng với --kind settlement');
  }
  const nDays = days ?? DAYS_DEFAULT;
  if (nDays < 1 || nDays > DAYS_MAX) return usage(`--days phải trong 1..${DAYS_MAX}`);

  let tfile: string | null;
  let entry: Record<string, unknown> = {};
  try {
    tfile = tokenFile(env, d.repoRoot);
    const e0 = tfile ? loadTokens(tfile)[ch] : null;
    entry = isDict(e0) ? e0 : {};
    if (refresh && tfile === null) {
      throw new ConfigError(
        `--refresh cần ${TOKEN_FILE_VAR} (refresh_token xoay vòng phải được lưu)`,
      );
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log(`[err] ${e.message} — 0 request.`);
    return 2;
  }
  let creds: Creds;
  try {
    creds = readCreds(ch, entry.access_token ?? null, { refreshOnly: tfile !== null, env });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log(
      `[external-dep] ${e.message} — chưa có app key/token sàn (Partner Center, quyền chỉ đọc); 0 request, không connect DB.`,
    );
    return 2;
  }
  let base: string;
  try {
    base = apiBase(ch, null, null, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log(`[err] ${e.message}`);
    return 2;
  }
  let sctx: unknown = null;
  if (o.kind === 'settlement') {
    // r15: bảng ánh xạ chưa chốt / nguồn không phải API thật → chặn TRƯỚC mọi request (kể cả
    // refresh); --dry-run vẫn kéo để báo thiếu gì.
    if (!d.settlement) {
      log(
        `[blocked] ${ch}: quyết toán qua API (--kind settlement) chưa nối bản TS của ingest.settlement_api (nhóm settlement) — dùng \`python -m ingest.market_api --kind settlement\`. 0 request.`,
      );
      return 2;
    }
    const pc = await d.settlement.precheck(ch, base, Boolean(o.dryRun), log);
    if (pc.rc !== null) return pc.rc;
    sctx = pc.ctx;
  }
  // TS chặt hơn (nạp bằng login loader): chế độ thực thiếu LOADER_DATABASE_URL → chặn TRƯỚC mọi
  // request/refresh, không để kéo hết rồi mới exit 2.
  if (!refresh && o.kind !== 'settlement' && approvalEnforced(env)) {
    const sd = serviceDsn('loader', env);
    if (sd.error !== null) {
      log(`[err] ${sd.error}`);
      return 2;
    }
  }
  // r13: tính năng TẮT (sổ triển khai, HĐ 6.7) → 0 request ra sàn, không nạp.
  const why = await blocked(null, 'kéo dữ liệu API sàn chỉ đọc', FEATURE);
  if (why) return sayBlocked(why, log);
  const exp = entry.expire_at;
  if (
    tfile &&
    (refresh ||
      !truthy(entry.access_token) ||
      !isPyInt(exp) ||
      Number(exp) <= now() + REFRESH_MARGIN_S)
  ) {
    const tok = await doRefresh(ch, creds, tfile, refresh, { env, log, now, refresh: d.refresh });
    if (tok === null) return 1;
    creds[(KEYS[ch] as readonly string[])[3] as string] = tok;
  }
  if (refresh) return 0;
  const run = d.jobRun ?? jobRun;
  if (o.kind === 'settlement') {
    const hooks = d.settlement as SettlementHooks;
    const args = { channel: ch, window: window as [string, string], dryRun: Boolean(o.dryRun) };
    // dry-run: không đụng DB, kể cả sổ job_runs
    if (o.dryRun) return hooks.run(args, creds, base, sctx, log);
    return run(
      'ingest.settlement_api',
      async (r) => {
        const rc = await hooks.run(args, creds, base, sctx, log);
        r.ok = rc === 0;
        return rc;
      },
      env,
    );
  }
  let smap: StatusMap;
  try {
    smap = loadStatusMap(d.statusFile);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log(`[err] ${e.message}`);
    return 1;
  }
  const [mapping, mapWhy] = loadMapping(d.mapFile);
  if (mapping === null) {
    log(`[err] ${mapWhy}`);
    return 1;
  }
  const kind = o.kind as string;
  return run(
    'ingest.market_api',
    async (r) => {
      const rc = await ingest(ch, kind, nDays, creds, base, smap, mapping, d, env, log, now);
      r.ok = rc === 0;
      return rc;
    },
    env,
  );
}

/** `_ingest`: kéo hết (không connect) → sha → 1 giao dịch load + reconcile như market_csv. */
async function ingest(
  ch: string,
  kind: string,
  days: number,
  creds: Creds,
  base: string,
  smap: StatusMap,
  mapping: Mapping,
  d: CmdDeps,
  env: Env,
  log: (s: string) => void,
  now: () => number,
): Promise<number> {
  const call = (
    m: string,
    p: string,
    params: Record<string, unknown>,
    body?: Record<string, unknown> | null,
    pathParams?: Record<string, unknown>,
  ) => request(ch, m, p, params, body ?? null, { creds, base, pathParams, env });
  let rows: Row[];
  let sha: string;
  try {
    rows = await fetchRows(ch, kind, call, smap, days, now());
    if (!rows.length) {
      log(`[warn] API ${ch}/${kind} trả 0 dòng — không nạp gì.`);
      return 0;
    }
    sha = rowsSha256(ch, kind, rows);
  } catch (e) {
    if (e instanceof ApiError || e instanceof DataError || e instanceof ScopeError) {
      log(`[err] ${e.message} — không connect, không nạp gì.`);
      return 1;
    }
    throw e;
  }
  const fname = `api:${ch}:${kind}:${vnFormat(new Date(now() * 1000), '%Y%m%dT%H%M')}`;
  // TS chặt hơn Python (dùng DATABASE_URL): ghi staging bằng login dịch vụ nạp (svc_loader) như
  // market_csv — dev rơi về DATABASE_URL như Python.
  const ld = await openLoader(d, env);
  if (ld.bindWhy !== null) {
    log(`[err] ${ld.bindWhy}`);
    return 2;
  }
  if (!ld.hasDsn) {
    log('[err] thiếu DATABASE_URL trong .env');
    return 1;
  }
  if (ld.pool === null) {
    log('[err] không kết nối được Postgres: OperationalError');
    return 1;
  }
  const pool = ld.pool;
  try {
    const inactive = listOf(specOf(mapping, ch, kind), 'inactive_status');
    let r: Loaded;
    try {
      r = await loadTx(pool, rows, ch, kind, fname, sha, inactive);
    } catch (e) {
      const rc = dbFail(e, '[skip] dữ liệu vừa được nạp song song — không ghi gì.', log);
      if (rc === null) throw e;
      return rc;
    }
    if ('skip' in r) {
      log(`[skip] dữ liệu không đổi: snapshot ${r.skip} — không ghi gì.`);
      return 0;
    }
    log(
      `[load] snapshot #${r.sid} ${ch}/${kind} ${fname}: ${rows.length} dòng, map golden ${r.mapped}`,
    );
    const kept = printAlerts(r.alerts, 'order — không đối chiếu ở P1', log);
    if (kept) {
      log(
        `[warn] ${kept} cảnh báo ${ch}/${kind} không thấy item trong dữ liệu API — GIỮ MỞ (vắng ≠ đã sửa)`,
      );
    }
    log('[done]');
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- nest-commander

@Command({
  name: 'market-csv',
  description: 'Nạp file xuất Seller Center (chỉ đọc) / báo cáo cảnh báo sàn.',
})
export class MarketCsvCommand extends CommandRunner {
  async run(_a: string[], o: CsvOpts): Promise<void> {
    process.exitCode = await marketCsvMain(o);
  }
  @Option({ flags: '--file <path>', description: 'file .csv / .xlsx đã xuất' })
  parseFile(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <channel>', description: 'shopee | tiktok' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--kind <kind>', description: 'listing | order | ads' })
  parseKind(v: string): string {
    return v;
  }
  @Option({ flags: '--report', description: 'in cảnh báo open + snapshot mới nhất' })
  parseReport(): boolean {
    return true;
  }
}

@Command({
  name: 'market-api',
  description: 'Kéo listing/đơn qua API sàn CHỈ ĐỌC vào staging v3.3.',
})
export class MarketApiCommand extends CommandRunner {
  constructor(
    @Optional()
    @Inject(SETTLEMENT_HOOKS)
    private readonly settlement: SettlementHooks | null = null,
  ) {
    super();
  }
  async run(_a: string[], o: ApiOpts): Promise<void> {
    process.exitCode = await marketApiMain(o, { settlement: this.settlement });
  }
  @Option({ flags: '--channel <channel>', description: 'shopee | tiktok (bắt buộc)' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--kind <kind>', description: 'listing | order | settlement' })
  parseKind(v: string): string {
    return v;
  }
  @Option({
    flags: '--refresh',
    description: `refresh access token (kho ${TOKEN_FILE_VAR}) rồi thoát`,
  })
  parseRefresh(): boolean {
    return true;
  }
  @Option({
    flags: '--days <n>',
    description: `order: số ngày gần nhất 1..${DAYS_MAX} (mặc định ${DAYS_DEFAULT})`,
  })
  parseDays(v: string): string {
    return v;
  }
  @Option({ flags: '--from <date>', description: 'settlement: ngày đầu (giờ VN)' })
  parseFrom(v: string): string {
    return v;
  }
  @Option({
    flags: '--to <date>',
    description: 'settlement: ngày cuối, gồm cả ngày này (≤31 ngày)',
  })
  parseTo(v: string): string {
    return v;
  }
  @Option({
    flags: '--dry-run',
    description: 'settlement: kéo + báo trạng thái ánh xạ, KHÔNG ghi sổ',
  })
  parseDryRun(): boolean {
    return true;
  }
}

export const MARKET_COMMANDS = [MarketCsvCommand, MarketApiCommand];
