import { connectDatabaseUrl, type Service, ServiceBindError, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
} from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { vnDate } from '@samsam/core/ops/period';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool } from 'pg';
import type { DbLease } from '../garden_zalo/garden.js';
import { isoDay } from '../kd_quote/py.js';
import { WATCH_FILE as SALES_WATCH_FILE, section } from '../sales_director/sales-watch.js';
import { CFG_FILE as COMBO_FILE, submit as comboSubmit, loadCfg, propose } from './combo-price.js';
import {
  MAX_PRINT_ERRS as DEALER_MAX_ERRS,
  loadDealerObs,
  readDealerFile,
} from './dealer-price.js';
import { clean, enqueueNew, FPA_CONFIG, loadMapping, MAP_FILE, planOf, seenIds } from './deps.js';
import {
  AGENT,
  BLOCK,
  coerceDay,
  FIN_BLOCK,
  JOB,
  KIND_LABELS,
  loadNetRatio,
  loadWatch,
  MAX_PRINT_ERRS,
  type NetRatio,
  OT_DEALER,
  type PlanRow,
  readPlan,
  renderReport,
  toItems,
  type Watch,
  where,
} from './kd-price.js';
import { analyze, dealerWatch, enqueueFinance } from './kd-price.service.js';
import { CALENDAR_FILE, type Calendar, CalendarError, loadCalendar } from './mkt-calendar.js';

// Lệnh CLI thay `python -m agents.kd_price` (job `price_watch` / `dealer_price_watch`),
// `python -m agents.combo_price`, `python -m ingest.dealer_price` — cùng cờ, exit code, thông điệp
// chính. kd-price exit: 0 ok · 1 cấu hình/CSV lỗi (trước connect) · 2 DB down / lỗi DB / tham số sai.

export type Paths = {
  watch?: string;
  fpa?: string;
  mapping?: string;
  calendar?: string;
  combo?: string;
  directors?: string;
  salesWatch?: string;
};
export type CmdDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  paths?: Paths;
  /** Python `ingest.lead_store.connect()` (DATABASE_URL) — kd-price --run/--report, combo-price. */
  connect?: (env: Env) => Promise<DbLease | null>;
  /** Python `auth.bind_service(...)` + connect — dealer-watch (`job`), dealer-price (`loader`). */
  openService?: (s: Service, env: Env) => Promise<Pool>;
  /** Nối core trên pool của lệnh (mặc định `wireCore`) — test truyền null khi đã nối sẵn. */
  wire?: ((db: Db) => void) | null;
  jobRun?: typeof jobRun;
  clock?: () => Date;
};

const P = (d: CmdDeps) => ({
  watch: d.paths?.watch ?? dataPath('price_watch.json'),
  fpa: d.paths?.fpa ?? FPA_CONFIG,
  mapping: d.paths?.mapping ?? MAP_FILE,
  calendar: d.paths?.calendar ?? CALENDAR_FILE,
  combo: d.paths?.combo ?? COMBO_FILE,
  directors: d.paths?.directors ?? DIRECTORS_DIR,
  salesWatch: d.paths?.salesWatch ?? SALES_WATCH_FILE,
});
const today = (d: CmdDeps) => vnDate((d.clock ?? (() => new Date()))());
const doWire = (d: CmdDeps, db: Db) => {
  if (d.wire !== null) (d.wire ?? wireCore)(db as Pool);
};

/** Mở pool dịch vụ + thử kết nối → [pool | null (DB không tới được), lỗi ràng buộc | null]. */
async function openSvc(
  service: Service,
  d: CmdDeps,
  env: Env,
): Promise<[Pool | null, string | null]> {
  let pool: Pool;
  try {
    pool = await (d.openService ?? servicePool)(service, env);
  } catch (e) {
    if (e instanceof ServiceBindError) return [null, e.message];
    throw e;
  }
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return [null, null];
  }
  return [pool, null];
}

// ---------------------------------------------------------------- kd-price

export type KdPriceOpts = {
  run?: boolean;
  report?: boolean;
  dryRun?: boolean;
  plan?: string;
  asOf?: string;
  outDir?: string;
  dealerWatch?: boolean;
};

type Ctx = {
  mapping: unknown;
  watch: Watch;
  net: NetRatio;
  cfg: DirectorConfig;
  calendar: Calendar;
  plan: PlanRow[] | null;
  today: string | null;
};

/** Mọi cấu hình + CSV đọc TRƯỚC connect → [ctx, lỗi]. */
function loadCtx(o: KdPriceOpts, asOf: string | null, d: CmdDeps): [Ctx | null, string[]] {
  const p = P(d);
  const [mapping, w1] = loadMapping(p.mapping);
  if (w1 !== null) return [null, [w1]];
  const [watch, w2] = loadWatch(p.watch);
  if (watch === null) return [null, [w2]];
  const [net, w3] = loadNetRatio(watch.channels, p.fpa);
  if (net === null) return [null, [w3]];
  let cfg: DirectorConfig;
  try {
    cfg = loadConfig(BLOCK, p.directors);
    const need = ['market_alert_s1', 'price_change', 'promo_change'];
    if (!need.every((t) => Object.hasOwn(cfg.object_types, t))) {
      throw new DirectorConfigError(
        `sales.json thiếu loại việc {${need.map((t) => `'${t}'`).join(', ')}}`,
      );
    }
  } catch (e) {
    if (e instanceof DirectorConfigError) return [null, [`cấu hình lỗi: ${e.message}`]];
    throw e;
  }
  let calendar: Calendar;
  try {
    calendar = loadCalendar(p.calendar);
  } catch (e) {
    if (e instanceof CalendarError) return [null, [`lịch mùa lỗi: ${e.message}`]];
    throw e;
  }
  let plan: PlanRow[] | null = null;
  if (o.plan !== undefined) {
    const [rows, errs] = readPlan(o.plan, watch.promo_kinds, calendar);
    if (errs.length) return [null, errs];
    plan = rows;
  }
  return [{ mapping, watch, net, cfg, calendar, plan, today: asOf }, []];
}

async function priceInner(o: KdPriceOpts, ctx: Ctx, d: CmdDeps): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const lease = await (d.connect ?? connectDatabaseUrl)(env);
  if (lease === null) {
    err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  doWire(d, lease.db);
  try {
    const day = ctx.today ?? today(d);
    const res = await analyze(lease.db, ctx.mapping, ctx.watch, ctx.net, day, ctx.plan);
    const fs = [...res.listing, ...res.promo];
    const items = toItems(fs, ctx.cfg);
    const seen = await seenIds(lease.db, 'a5');
    const plan = planOf(items, fs, seen);
    if (ctx.plan === null) log('[info] chưa có kế hoạch KM (--plan) — chỉ kiểm giá đang chạy');
    const n1 = fs.filter((f) => f.severity === 'S1').length;
    const n2 = fs.filter((f) => f.severity === 'S2').length;
    log(
      `[A5] ngày ${day}: S1 ${n1} · S2 ${n2} · kênh có file listing: ${res.channels.join(', ') || 'chưa có'}`,
    );
    if (o.report) {
      const text = renderReport(res, ctx.watch, day, ctx.plan, ctx.calendar, plan);
      // P8.4: listing sàn file xuất + golden đã duyệt (không cột mẫu).
      const path = await writeReport(text, o.outDir ?? REPORTS_DIR, `price-watch-${day}.md`, false);
      log(`[report] ${path}`);
    } else if (o.dryRun) {
      for (const f of fs) {
        if (f.severity !== 'INFO') log(`  [${f.severity}] ${KIND_LABELS[f.kind]} — ${where(f)}`);
      }
      log(
        `[dry-run] sẽ đẩy ${plan.new} mục mới · đã có ${plan.seen} · trùng cảnh báo sàn ${plan.dup} — KHÔNG ghi DB`,
      );
    } else {
      const n = await enqueueNew(lease.db, items, ctx.cfg, seen, AGENT);
      const nf = await enqueueFinance(lease.db, fs);
      log(
        `[run] đẩy ${n} mục mới vào hàng duyệt khối ${BLOCK} · ${nf} mục KM lỗ/không tính được biên khối ${FIN_BLOCK}`,
      );
    }
  } catch (e) {
    if (isDbError(e)) {
      err(`[error] lỗi DB: ${clean(dbMsg(e), 300)}`);
      return 2;
    }
    // Python: RolloutBlocked (tính năng TẮT ở biên enqueue/báo cáo) không được bắt → dừng, exit 1.
    if (e instanceof RolloutBlocked) {
      err(`[error] ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  return 0;
}

async function dealerMain(asOf: string | null, dryRun: boolean, d: CmdDeps): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const p = P(d);
  let dp: Record<string, unknown>;
  let cfg: DirectorConfig;
  try {
    dp = section('dealer_price', p.salesWatch);
    cfg = loadConfig(BLOCK, p.directors);
    if (!Object.hasOwn(cfg.object_types, OT_DEALER)) {
      throw new DirectorConfigError(`sales.json thiếu loại việc ${OT_DEALER}`);
    }
  } catch (e) {
    if (e instanceof RangeError || e instanceof DirectorConfigError) {
      err(`[error] cấu hình lỗi: ${e.message} — không connect`);
      return 1;
    }
    throw e;
  }
  const day = asOf ?? today(d);
  const [pool, bindWhy] = await openSvc('job', d, env);
  if (bindWhy !== null) {
    log(`[err] ${bindWhy}`);
    return 2;
  }
  if (pool === null) {
    err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  doWire(d, pool);
  try {
    let r: Awaited<ReturnType<typeof dealerWatch>>;
    try {
      r = await dealerWatch(pool, day, cfg, dp as { lookback_days: number }, dryRun);
    } catch (e) {
      if (e instanceof RolloutBlocked) {
        err(`[rollout] ${e.message}`);
        return 2;
      }
      throw e;
    }
    log(
      `[${dryRun ? 'dry-run' : 'dealer-watch'}] ngày ${day}: ${r.checked} quan sát, dưới giá sàn ${r.findings.length} (mới ${r.new}), không kiểm được (thiếu giá sàn) ${r.unverifiable} · đẩy ${r.enqueued} mục${dryRun ? ' — KHÔNG ghi DB' : ''}`,
    );
    return 0;
  } catch (e) {
    if (isDbError(e)) {
      err(`[error] lỗi DB: ${clean(dbMsg(e), 300)}`);
      return 2;
    }
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
}

/** `kd-price --run [--dry-run] [--plan CSV] [--as-of NGÀY] | --report [...] [--out-dir D] |
 * --dealer-watch [--dry-run] [--as-of NGÀY]`. */
export async function kdPriceMain(o: KdPriceOpts, d: CmdDeps = {}): Promise<number> {
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  const nOps = [o.run, o.report, o.dealerWatch].filter(Boolean).length;
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--run | --report | --dealer-watch)');
  if (nOps === 0) return usage('cần --run, --report hoặc --dealer-watch');
  if (o.dryRun && !(o.run || o.dealerWatch))
    return usage('--dry-run chỉ đi với --run / --dealer-watch');
  if (o.dealerWatch && o.plan !== undefined) return usage('--plan không dùng với --dealer-watch');
  let asOf: string | null = null;
  if (o.asOf !== undefined) {
    if ((o.run || o.dealerWatch) && !o.dryRun) {
      return usage(
        '--as-of chỉ dùng với --report hoặc --run/--dealer-watch --dry-run (không ghi hàng duyệt theo ngày giả)',
      );
    }
    try {
      asOf = coerceDay(o.asOf);
    } catch {
      return usage('--as-of phải dạng YYYY-MM-DD');
    }
  }
  if (o.dealerWatch) return dealerMain(asOf, Boolean(o.dryRun), d);
  const [ctx, errs] = loadCtx(o, asOf, d);
  if (ctx === null) {
    for (const e of errs.slice(0, MAX_PRINT_ERRS)) err(`[error] ${e}`);
    if (errs.length > MAX_PRINT_ERRS)
      err(`[error] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
    err(`[error] ${errs.length} lỗi — không connect, không ghi gì.`);
    return 1;
  }
  if (!o.run || o.dryRun) return priceInner(o, ctx, d);
  // Ghi lần chạy vào job_runs (bản tin GĐ KD mục 6 + sức khỏe F17.2).
  return (d.jobRun ?? jobRun)(
    JOB,
    async (r) => {
      const rc = await priceInner(o, ctx, d);
      r.ok = rc === 0;
      return rc;
    },
    d.env ?? process.env,
  );
}

// ---------------------------------------------------------------- combo-price

export type ComboOpts = { asOf?: string; dryRun?: boolean };

/** `combo-price [--as-of YYYY-MM-DD] [--dry-run]`. */
export async function comboPriceMain(o: ComboOpts, d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const p = P(d);
  let asOf: string | null = null;
  if (o.asOf !== undefined) {
    asOf = isoDay(o.asOf);
    if (asOf === null) {
      err(`[err] argument --as-of: invalid fromisoformat value: '${o.asOf}'`);
      return 2;
    }
  }
  let cfg: ReturnType<typeof loadCfg>;
  try {
    cfg = loadCfg(p.combo);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    err(`[error] ${e.message}`);
    return 1;
  }
  const [net] = loadNetRatio(cfg.channels as string[], p.fpa);
  const day = asOf ?? today(d);
  const lease = await (d.connect ?? connectDatabaseUrl)(env);
  if (lease === null) {
    err('[error] không kết nối được Postgres');
    return 2;
  }
  doWire(d, lease.db);
  try {
    const recs = await propose(lease.db, day, cfg, net);
    for (const r of recs)
      log(`- ${r.combo} × ${r.channel}: ${r.status}${r.why ? ` (${r.why})` : ''}`);
    if (o.dryRun) {
      log('[dry-run] không ghi DB');
      return 0;
    }
    let n: number;
    try {
      n = await comboSubmit(lease.db, recs);
    } catch (e) {
      if (e instanceof RolloutBlocked) {
        err(`[rollout] ${e.message}`);
        return 2;
      }
      throw e;
    }
    log(`[done] ${n} mục combo_price_option mới (khối intel)`);
    return 0;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ---------------------------------------------------------------- dealer-price

export type DealerOpts = { file?: string; by?: string; sample?: boolean };

/** `dealer-price --file CSV --by <tên> [--sample]`. Exit: 0 ok/skip · 1 file/sổ lỗi, cấu hình lỗi ·
 * 2 tham số sai / DB down / cổng loader chặn. */
export async function dealerPriceMain(o: DealerOpts, d: CmdDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const miss = [o.file === undefined ? '--file' : null, o.by === undefined ? '--by' : null].filter(
    Boolean,
  );
  if (miss.length) {
    err(`[err] the following arguments are required: ${miss.join(', ')}`);
    return 2;
  }
  if (!pyStrip(o.by as string)) {
    err('[err] --by cần tên người quan sát');
    return 2;
  }
  let dp: Record<string, unknown>;
  try {
    dp = section('dealer_price', P(d).salesWatch);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    err(`[error] cấu hình lỗi: ${e.message} — không connect`);
    return 1;
  }
  const [rows, errs, sha] = readDealerFile(
    o.file as string,
    dp.channels as string[],
    dp.max_rows as number,
    today(d),
  );
  if (errs.length) {
    for (const e of errs.slice(0, DEALER_MAX_ERRS)) err(`[error] ${e}`);
    err(`[error] ${errs.length} lỗi — không connect, không nạp dòng nào.`);
    return 1;
  }
  // v14.2: loader chạy bằng login dịch vụ nạp file (svc_loader).
  const [pool, bindWhy] = await openSvc('loader', d, env);
  if (bindWhy !== null) {
    log(`[err] ${bindWhy}`);
    return 2;
  }
  if (pool !== null) doWire(d, pool);
  try {
    // v15 P12.1: chính sách cổng tắt loader — chưa cấu hình + tính năng tắt → không nạp.
    const why = await loaderGate('dealer_price', pool, undefined, log);
    if (why) {
      log(`[rollout] ${why}`);
      return 2;
    }
    if (pool === null) {
      err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
      return 2;
    }
    let r: { inserted: number; skipped_file: boolean };
    try {
      r = await loadDealerObs(
        pool,
        rows,
        sha as string,
        o.by,
        o.sample ? 'sample' : 'manual_export',
      );
    } catch (e) {
      if (isDbError(e)) {
        err(`[error] lỗi DB: ${clean(dbMsg(e) || (e as Error).name, 300)}`);
        return 2;
      }
      if (e instanceof RangeError) {
        err(`[error] ${e.message} — không nạp dòng nào`);
        return 1;
      }
      throw e;
    }
    log(
      r.skipped_file
        ? `[skip] file đã nạp (sha256 ${(sha as string).slice(0, 12)}) — không ghi thêm`
        : `[ok] nạp ${r.inserted} quan sát giá đại lý${o.sample ? ' (MẪU — không sinh cảnh báo)' : ''} — chạy \`python -m agents.kd_price --dealer-watch\` để so giá sàn`,
    );
    return 0;
  } finally {
    await pool?.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- nest-commander

// Kiểm giá trị ở main(): lỗi ném trong hàm parse của nest-commander thoát 0.
@Command({
  name: 'kd-price',
  description:
    'KD-A5 — giám sát giá + khuyến mãi theo giá sàn/list golden, biên, trần KM → NHÁP hàng duyệt (agent KHÔNG đổi giá)',
})
export class KdPriceCommand extends CommandRunner {
  async run(_a: string[], o: KdPriceOpts): Promise<void> {
    process.exitCode = await kdPriceMain(o);
  }
  @Option({ flags: '--run', description: 'đẩy phát hiện mới vào hàng duyệt khối KD' })
  parseRun(): boolean {
    return true;
  }
  @Option({ flags: '--report', description: 'báo cáo price-watch-<ngày>.md → data/reports/' })
  parseReport(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: 'với --run/--dealer-watch: chỉ đọc, in kế hoạch' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--plan <csv>', description: 'CSV kế hoạch khuyến mãi (nhập tay, utf-8)' })
  parsePlan(v: string): string {
    return v;
  }
  @Option({
    flags: '--as-of <day>',
    description: 'ngày kiểm YYYY-MM-DD (giờ VN) — chỉ với --report hoặc --dry-run',
  })
  parseAsOf(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({
    flags: '--dealer-watch',
    description:
      'so giá đại lý quan sát tay (nạp bằng `dealer-price`) với giá sàn golden → hàng duyệt (v14.4)',
  })
  parseDealerWatch(): boolean {
    return true;
  }
}

@Command({
  name: 'combo-price',
  description: 'intel-05.2 — phương án NHÁP giá combo (agent KHÔNG áp giá)',
})
export class ComboPriceCommand extends CommandRunner {
  async run(_a: string[], o: ComboOpts): Promise<void> {
    process.exitCode = await comboPriceMain(o);
  }
  @Option({ flags: '--as-of <day>' })
  parseAsOf(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'dealer-price',
  description: 'Nạp file giá ĐẠI LÝ quan sát tay (v14.4) — không đổi giá, không liên hệ đại lý',
})
export class DealerPriceCommand extends CommandRunner {
  async run(_a: string[], o: DealerOpts): Promise<void> {
    process.exitCode = await dealerPriceMain(o);
  }
  @Option({ flags: '--file <csv>' })
  parseFile(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>', description: 'tên NGƯỜI quan sát/nhập file' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--sample', description: 'đánh dấu dữ liệu MẪU (không sinh cảnh báo)' })
  parseSample(): boolean {
    return true;
  }
}

export const KD_PRICE_COMMANDS = [KdPriceCommand, ComboPriceCommand, DealerPriceCommand];
