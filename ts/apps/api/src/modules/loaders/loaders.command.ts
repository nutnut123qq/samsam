import { basename, normalize } from 'node:path';
import {
  createPool,
  type Service,
  ServiceBindError,
  serviceDsn,
  servicePool,
} from '@samsam/core/db';
import { approvalEnforced, type Env, pyStrip } from '@samsam/core/env';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { cpLen, isPrintable, pyInt } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { cliGate } from '@samsam/core/security/auth';
import { Command, CommandRunner, Option } from 'nest-commander';
import pg, { type Pool, type PoolClient } from 'pg';
import {
  applyRows,
  collectRows,
  DATA_DIR,
  DOMAIN_ORDER,
  type Domain,
  dropSampleGarden,
  keptPlots,
  SourceError,
  sampleGardenPurged,
} from './core-store.js';
import {
  applyDiscrepancies,
  approvePrice,
  type Doc,
  GOLDEN_FILE,
  type LoadStats,
  load,
  loadProblems,
  MAX_BY_LEN,
  readGolden,
  report,
  validate,
} from './golden-store.js';
import { pyDumps } from './py.js';

// Lệnh CLI thay `python -m ingest.core_store` (`core-store`) và `python -m ingest.golden_store`
// (`golden-store`) — cùng cờ, exit code, thông điệp chính. Exit: 0 ok · 1 file nguồn hỏng / DB lỗi /
// người duyệt bị chặn / duyệt bị từ chối · 2 sai tham số, login dịch vụ bị từ chối (chế độ thực),
// cổng loader HĐ 6.7 (golden). Không có job lịch (deploy/onprem/jobs.json không gọi 2 lệnh này).
// Nạp file = login dịch vụ `loader` (LOADER_DATABASE_URL, svc_loader); `--report`/`--approve-price`
// = NGƯỜI (DATABASE_URL là login PostgreSQL của chính người đó).

export type CmdDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  /** core_store: thư mục `data/` (test). */
  dataDir?: string;
  /** golden_store: file mặc định khi không có `--file` (test). */
  goldenFile?: string;
  /** `data/loader_gate.json` (test). */
  gateConfig?: string;
  /** Python `auth.bind_service("loader")` — test truyền pool DB test. */
  openService?: (s: Service, env: Env) => Promise<Pool>;
  /** Kết nối NGƯỜI (`DATABASE_URL`) cho --report/--approve-price — test truyền pool DB test. */
  openHuman?: (env: Env) => Pool;
};

type Loader = { pool: Pool | null; bindWhy: string | null; hasDsn: boolean };

/** Python `auth.bind_service("loader")` (+ golden: lượt kết nối của `loader_gate`). Chế độ thực: thiếu
 * `LOADER_DATABASE_URL` / login superuser-owner-sai role → lý do (exit 2). Dev thiếu cả hai biến →
 * không DSN. `ping` không kết nối được → pool null. */
async function openLoader(d: CmdDeps, env: Env, ping: boolean): Promise<Loader> {
  const sd = serviceDsn('loader', env);
  if (sd.error !== null) {
    return { pool: null, bindWhy: approvalEnforced(env) ? sd.error : null, hasDsn: false };
  }
  let pool: Pool;
  try {
    pool = await (d.openService ?? servicePool)('loader', env);
  } catch (e) {
    if (e instanceof ServiceBindError) return { pool: null, bindWhy: e.message, hasDsn: true };
    throw e;
  }
  if (ping) {
    try {
      await pool.query('select 1');
    } catch {
      await pool.end().catch(() => {});
      return { pool: null, bindWhy: null, hasDsn: true };
    }
  }
  return { pool, bindWhy: null, hasDsn: true };
}

const code = (e: unknown) => (e as { code?: unknown }).code;
/** Lỗi kết nối (không phải lỗi SQL) = psycopg OperationalError. */
const connLost = (e: unknown) => isDbError(e) && !(e instanceof pg.DatabaseError);

// ---------------------------------------------------------------- core-store

/** `python -m ingest.core_store` → in số row nạp + tổng từng bảng. */
export async function coreStoreMain(d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối
  // login superuser/owner/thiếu biến.
  const ld = await openLoader(d, env, false);
  if (ld.bindWhy !== null) {
    log(`[err] ${ld.bindWhy}`);
    return 2;
  }
  if (!ld.hasDsn || ld.pool === null) {
    log('[err] thiếu DATABASE_URL trong .env');
    return 1;
  }
  const pool = ld.pool;
  try {
    let domains: Domain[];
    try {
      domains = collectRows(d.dataDir ?? DATA_DIR, log);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      log(`[err] file nguồn hỏng — không nạp gì: ${e.message}`);
      return 1;
    }
    const loaded = new Map(domains.map(([t, , r]) => [t, r.length]));
    for (const t of DOMAIN_ORDER) if (loaded.has(t)) log(`[load] ${t}: ${loaded.get(t)} rows`);

    let c: PoolClient;
    try {
      c = await pool.connect();
    } catch {
      log('[err] không kết nối được Postgres: OperationalError');
      return 1;
    }
    const totals: string[] = [];
    try {
      await c.query('begin');
      if (await sampleGardenPurged(c)) {
        log(
          '[skip] plots/plot_logs mẫu: GĐ vùng trồng đã gỡ dữ liệu mẫu (garden_sample_purge) — không nạp lại',
        );
        domains = dropSampleGarden(domains);
      }
      const counts = await applyRows(c, domains);
      for (const [kind, pid, detail] of counts.product_events ?? []) {
        log(
          `[${kind}] products: ${pid} ${pyDumps(detail)}${kind === 'retired' ? ' — giữ, không xóa' : ''}`,
        );
      }
      for (const [pid, nLogs, nMedia] of await keptPlots(c, domains)) {
        log(`[keep] plots: ${pid} (${nLogs} nhật ký đã chain, ${nMedia} ảnh) — không xóa`);
      }
      const present = new Set(domains.map(([t]) => t));
      for (const t of DOMAIN_ORDER) {
        if (!present.has(t)) continue;
        totals.push(`${t}=${(await c.query(`select count(*) as n from ${t}`)).rows[0].n}`);
      }
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      if (code(e) === '42P01' || code(e) === '42703') {
        log(
          `[err] thiếu bảng lõi — chạy \`python scripts/apply_schema.py\` trước: ${(e as Error).message}`,
        );
        return 1;
      }
      if (connLost(e)) {
        log('[err] không kết nối được Postgres: OperationalError');
        return 1;
      }
      // Python: lỗi DB khác → traceback (exit 1, đã rollback); TS báo có kiểm soát.
      if (isDbError(e)) {
        log(`[err] lỗi DB, đã rollback: ${(e as Error).message}`);
        return 1;
      }
      throw e;
    } finally {
      c.release();
    }
    log(`[done] totals: ${totals.join(', ')}`);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- golden-store

export type GoldenOpts = { file?: string; report?: boolean; approvePrice?: string; by?: string };

/** `python -m ingest.golden_store [--file PATH] | --report | --approve-price ID --by TÊN`. */
export async function goldenStoreMain(o: GoldenOpts, d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const usage = (msg: string) => {
    (d.err ?? console.error)(`golden_store: error: ${msg}`);
    return 2;
  };
  let priceId: bigint | null = null;
  if (o.approvePrice !== undefined) {
    priceId = pyInt(o.approvePrice);
    if (priceId === null) {
      return usage(`argument --approve-price: invalid int value: '${o.approvePrice}'`);
    }
  }
  const nOps = Number(o.file !== undefined) + Number(Boolean(o.report)) + Number(priceId !== null);
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--file | --report | --approve-price)');
  const by = pyStrip(o.by ?? '');
  if (priceId !== null) {
    if (!by) return usage('--approve-price cần --by <tên người duyệt> không rỗng');
    if (cpLen(by) > MAX_BY_LEN || !isPrintable(by)) {
      return usage(`--by tối đa ${MAX_BY_LEN} ký tự in được`);
    }
  } else if (o.by !== undefined) {
    return usage('--by chỉ dùng với --approve-price');
  }

  let doc: Doc | null = null;
  let source = '';
  let pool: Pool | null;
  if (!o.report && priceId === null) {
    // Python `Path('')` = '.'; str(Path) chuẩn hóa dấu tách như normalize.
    const path = o.file === undefined ? (d.goldenFile ?? GOLDEN_FILE) : normalize(o.file);
    const [got, why] = readGolden(path);
    if (got === null) {
      log(`[warn] ${why} — không connect, không ghi/xóa gì.`);
      return 1;
    }
    let errs = validate(got);
    if (!errs.length) errs = loadProblems(got); // TS chặt hơn (xem golden-store.ts)
    if (errs.length) {
      for (const e of errs) log(`[err] ${e}`);
      log(`[err] ${errs.length} lỗi — không nạp gì.`);
      return 1;
    }
    doc = got;
    source = basename(path);
    // v14.2: nạp file = login dịch vụ (LOADER_DATABASE_URL, svc_loader); --approve-price/--report là
    // người → DSN của người.
    const ld = await openLoader(d, env, true);
    if (ld.bindWhy !== null) {
      log(`[err] ${ld.bindWhy}`);
      return 2;
    }
    pool = ld.pool;
    // v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) — chưa cấu hình + tính năng tắt
    // → không nạp. Không kết nối được DB → chặn (không đoán giai đoạn).
    let gate: string | null;
    try {
      gate = await loaderGate('golden_store', pool, d.gateConfig, log);
    } catch (e) {
      await pool?.end().catch(() => {});
      throw e;
    }
    if (gate) {
      await pool?.end().catch(() => {});
      log(`[rollout] ${gate}`);
      return 2;
    }
    if (!ld.hasDsn) {
      log('[err] thiếu DATABASE_URL trong .env');
      return 1;
    }
  } else {
    if (!pyStrip(env.DATABASE_URL ?? '')) {
      log('[err] thiếu DATABASE_URL trong .env');
      return 1;
    }
    pool = d.openHuman ? d.openHuman(env) : createPool(pyStrip(env.DATABASE_URL ?? ''), {}, env);
  }
  if (pool === null) {
    log('[err] không kết nối được Postgres: OperationalError');
    return 1;
  }
  try {
    return await goldenRun(pool, o, priceId, by, doc, source, env, log, d.err);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function goldenRun(
  pool: Pool,
  o: GoldenOpts,
  priceId: bigint | null,
  by: string,
  doc: Doc | null,
  source: string,
  env: Env,
  log: (s: string) => void,
  err?: (s: string) => void,
): Promise<number> {
  let c: PoolClient;
  try {
    c = await pool.connect();
  } catch {
    log('[err] không kết nối được Postgres: OperationalError');
    return 1;
  }
  let stats: LoadStats;
  let disc: Record<string, number>;
  const totals: string[] = [];
  try {
    if (o.report) {
      await report(c, log);
      return 0;
    }
    if (priceId !== null) {
      // v14.2: GĐ bán hàng được Bên B ủy quyền (cliGate — mọi `--by` quyết định).
      const why = await cliGate(c, by, 'sales', 'approve_price', 'price_list', String(priceId), {
        env,
        warn: err,
      });
      if (why) {
        log(`[err] ${why} — không ghi.`);
        return 1;
      }
      await c.query('begin');
      const [ok, msg] = await approvePrice(c, priceId, by, env);
      if (!ok) {
        await c.query('rollback');
        log(`[err] ${msg} — không ghi.`);
        return 1;
      }
      await c.query('commit');
      log(`[done] ${msg} — người duyệt: ${by}`);
      return 0;
    }
    await c.query('begin');
    stats = await load(c, doc as Doc, source);
    disc = await applyDiscrepancies(c);
    await c.query('commit');
    for (const t of ['sku_master', 'sku_map', 'price_list', 'golden_discrepancies']) {
      totals.push(`${t}=${(await c.query(`select count(*) as n from ${t}`)).rows[0].n}`);
    }
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (code(e) === '42P01') {
      log(
        `[err] thiếu bảng golden — chạy \`python scripts/apply_schema.py\` trước: ${(e as Error).message}`,
      );
      return 1;
    }
    if (isDbError(e)) {
      log(`[err] lỗi DB, đã rollback: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  } finally {
    c.release();
  }
  log(
    `[load] ${Object.entries(stats)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  log(
    `[disc] ${Object.entries(disc)
      .sort(([a], [b]) => cpCmp(a, b))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  log(`[done] totals: ${totals.join(', ')}`);
  return 0;
}

// ---------------------------------------------------------------- nest-commander

@Command({
  name: 'core-store',
  description: 'Nạp DB lõi WS1 từ data/ (products/claims/plots/plot_logs/orders/assets).',
})
export class CoreStoreCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await coreStoreMain();
  }
}

@Command({
  name: 'golden-store',
  description: 'Nạp golden master / báo phiếu lệch / duyệt giá.',
})
export class GoldenStoreCommand extends CommandRunner {
  async run(_a: string[], o: GoldenOpts): Promise<void> {
    process.exitCode = await goldenStoreMain(o);
  }
  @Option({ flags: '--file <path>', description: 'file golden (mặc định data/golden_skus.json)' })
  parseFile(v: string): string {
    return v;
  }
  @Option({ flags: '--report', description: 'in phiếu lệch pending + giá chờ duyệt' })
  parseReport(): boolean {
    return true;
  }
  @Option({
    flags: '--approve-price <id>',
    description: 'duyệt 1 dòng giá — CHỈ người thật chạy',
  })
  parseApprovePrice(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>', description: 'tên người duyệt (bắt buộc với --approve-price)' })
  parseBy(v: string): string {
    return v;
  }
}

export const LOADERS_COMMANDS = [CoreStoreCommand, GoldenStoreCommand];
