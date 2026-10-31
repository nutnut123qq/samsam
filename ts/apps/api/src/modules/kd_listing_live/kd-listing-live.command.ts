import { createPool, databaseUrl, ServiceBindError, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
} from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { parseDay, vnDate } from '@samsam/core/ops/period';
import { isPlainObject, isPrintable, readJson } from '@samsam/core/ops/py';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { pyStr } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool } from 'pg';
import { loadMapping } from './content-lite.js';
import * as kl from './kd-listing.js';
import * as kv from './kd-live.js';
import * as le from './listing-export.js';

// Lệnh CLI thay `python -m agents.kd_listing` / `agents.listing_export` / `agents.kd_live` — cùng cờ,
// exit code, thông điệp chính. Hàm `*Main` nhận deps để test (pool/AI/đồng hồ giả).

export type Io = { log?: (s: string) => void; err?: (s: string) => void };
export type CliDeps = Io & {
  env?: Env;
  /** Mở pool (mặc định: kd-listing --run = login dịch vụ `job`; còn lại = DATABASE_URL như Python
   * `connect()`). null = không kết nối được. */
  open?: (env: Env) => Promise<Pool | null>;
  /** Nối core trên pool của lệnh (mặc định `wireCore`) — test truyền null. */
  wire?: ((pool: Pool) => void) | null;
  jobRun?: typeof jobRun;
  clock?: () => Date;
  directorsDir?: string;
  mapPath?: string;
  /** kd-live: AI gateway (mặc định `wireCore(pool)` — Ollama nội bộ, không fallback cloud). */
  ai?: kv.Chat;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Python `market_csv._clean`: bỏ ký tự điều khiển (escape terminal), cắt `n` code point. */
const clean = (s: string, n: number): string =>
  Array.from(s)
    .slice(0, n)
    .map((c) => (isPrintable(c) ? c : '?'))
    .join('');

/** Python `ingest.lead_store.connect()`: DATABASE_URL → Pool | null (thiếu DSN / host chết). */
async function openDatabaseUrl(env: Env): Promise<Pool | null> {
  let pool: Pool | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
    return pool;
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
}

/** Login dịch vụ `job` (dev: rơi về DATABASE_URL); ServiceBindError nổi lên để in lý do. */
async function openJob(env: Env): Promise<Pool | null> {
  const pool = await servicePool('job', env);
  try {
    await pool.query('select 1');
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
}

// ------------------------------------------------------------ kd-listing

export type KdListingOpts = { run?: boolean; report?: boolean; dryRun?: boolean; outDir?: string };

async function kdListingInner(
  o: KdListingOpts,
  mapping: unknown,
  cfg: DirectorConfig,
  d: CliDeps,
): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  let pool: Pool | null;
  try {
    // Lượt ghi (job `listing_watch`) = login dịch vụ `job`; --report/--dry-run do người chạy = DATABASE_URL
    // như Python `connect()` (svc_job không có quyền ghi sổ `report_outputs`).
    pool = await (d.open ?? (o.run && !o.dryRun ? openJob : openDatabaseUrl))(env);
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    err(`[error] ${e.message}`);
    return 2;
  }
  if (pool === null) {
    err(NO_DB);
    return 2;
  }
  if (d.wire !== null) (d.wire ?? wireCore)(pool);
  try {
    const today = vnDate((d.clock ?? (() => new Date()))());
    const res = await kl.analyze(pool, mapping, today);
    const items = kl.toItems(res.findings, cfg);
    const seen = await kl.seenIds(pool, 'a4');
    const plan = kl.planOf(items, res.findings, seen);
    for (const ch of res.no_snapshot) log(`[warn] chưa có file listing ${ch}`);
    const nS1 = res.findings.filter((f) => f.severity === 'S1').length;
    log(`[A4] ${res.findings.length} phát hiện (S1 ${nS1}) · dòng chưa map ${res.unmapped}`);
    if (o.report) {
      // P8.4: listing sàn từ file xuất Seller Center (không cột mẫu).
      const path = await writeReport(
        kl.renderReport(res, today, plan),
        o.outDir ?? REPORTS_DIR,
        `catalog-sync-${today}.md`,
        false,
      );
      log(`[report] ${path}`);
    } else if (o.dryRun) {
      for (const f of res.findings) {
        log(`  [${f.severity}] ${kl.KIND_LABELS[f.kind]} — ${kl.where(f)}`);
      }
      log(
        `[dry-run] sẽ đẩy ${plan.new} mục mới · đã có ${plan.seen} · trùng cảnh báo sàn ${plan.dup} — KHÔNG ghi DB`,
      );
    } else {
      const n = await kl.enqueueNew(pool, items, cfg, seen, kl.AGENT);
      log(`[run] đẩy ${n} mục mới vào hàng duyệt khối ${kl.BLOCK}`);
    }
  } catch (e) {
    if (isDbError(e)) {
      err(`[error] lỗi DB: ${clean(dbMsg(e), 300)}`);
      return 2;
    }
    // Python: RolloutBlocked ở biên enqueue không được bắt → dừng, exit 1.
    if (e instanceof RolloutBlocked) {
      err(`[error] ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
  return 0;
}

/** `kd-listing --run [--dry-run] | --report [--out-dir D]`. Exit: 0 ok · 1 cấu hình lỗi · 2 DB down /
 * lỗi DB / tham số sai / cổng TẮT. */
export async function kdListingMain(o: KdListingOpts, d: CliDeps = {}): Promise<number> {
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  const nOps = Number(Boolean(o.run)) + Number(Boolean(o.report));
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--run | --report)');
  if (nOps === 0) return usage('cần --run hoặc --report');
  if (o.dryRun && !o.run) return usage('--dry-run chỉ đi với --run');
  // r19 (r12 RB): tắt → không đọc listing/in kế hoạch/đẩy mục, cả --dry-run.
  if (o.run) {
    const why = await blocked(null, 'rà listing sàn', kl.FEATURE);
    if (why) return sayBlocked(why, d.log ?? console.log);
  }
  const [mapping, mwhy] = loadMapping(d.mapPath);
  if (mwhy !== null) {
    err(`[error] ${mwhy}`);
    return 1;
  }
  let cfg: DirectorConfig;
  try {
    cfg = loadConfig(kl.BLOCK, d.directorsDir ?? DIRECTORS_DIR);
    if (!('listing_sync' in cfg.object_types) || !('market_alert_s1' in cfg.object_types)) {
      throw new DirectorConfigError('sales.json thiếu loại việc listing_sync/market_alert_s1');
    }
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    err(`[error] cấu hình lỗi: ${e.message}`);
    return 1;
  }
  if (!o.run || o.dryRun) return kdListingInner(o, mapping, cfg, d);
  // Ghi lần chạy vào job_runs (bản tin GĐ KD mục 6 + sức khỏe F17.2).
  return (d.jobRun ?? jobRun)(
    kl.JOB,
    async (r) => {
      const rc = await kdListingInner(o, mapping, cfg, d);
      r.ok = rc === 0;
      return rc;
    },
    d.env ?? process.env,
  );
}

// ------------------------------------------------------------ listing-export

export type ListingExportOpts = {
  websiteFeed?: boolean;
  sku?: string;
  channel?: string;
  out?: string;
  verify?: string;
};

/** `listing-export --sku K --channel shopee|tiktok --out DIR | --verify MANIFEST | --website-feed --out
 * DIR`. Exit: 0 ok · 1 từ chối/lệch · 2 tham số sai / DB down. */
export async function listingExportMain(o: ListingExportOpts, d: CliDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  if (o.channel !== undefined && !le.CHANNELS.includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: '${o.channel}' (choose from 'shopee', 'tiktok')`,
    );
  }
  if (o.websiteFeed && !o.out) return usage('--website-feed cần --out DIR');
  if (!o.websiteFeed && o.verify === undefined && !(o.sku && o.channel && o.out)) {
    return usage('cần --sku --channel --out, --verify MANIFEST hoặc --website-feed --out DIR');
  }
  const pool = await (d.open ?? openDatabaseUrl)(env);
  if (pool === null) {
    err('[error] không kết nối được Postgres');
    return 2;
  }
  if (d.wire !== null) (d.wire ?? wireCore)(pool);
  try {
    if (o.verify !== undefined) {
      let man: unknown;
      try {
        man = readJson(o.verify);
      } catch (e) {
        err(`[error] không đọc được manifest (${(e as { pyType?: string }).pyType ?? 'OSError'})`);
        return 1;
      }
      const bad =
        isPlainObject(man) && 'gia_phien_ban' in man
          ? await le.verifyFeed(pool, man, o.verify)
          : await le.verify(pool, o.verify, null, d.mapPath);
      for (const b of bad) log(`[LỆCH] ${b}`);
      log(bad.length ? `[done] ${bad.length} điểm lệch` : '[done] khớp bản đã duyệt');
      return bad.length ? 1 : 0;
    }
    if (o.websiteFeed) {
      const mp = await le.websiteFeed(pool, o.out as string);
      const man = readJson(mp) as Record<string, unknown>;
      log(
        `[done] ${mp.split(/[\\/]/).pop()} — ${man.ban_duoc}/${man.so_sku} SKU bán được trên web (còn lại ghi ly_do); agent không đẩy lên website`,
      );
      return 0;
    }
    const mp = await le.exportListing(
      pool,
      o.sku as string,
      o.channel as string,
      o.out as string,
      null,
      d.mapPath,
    );
    log(
      `[done] ${mp.split(/[\\/]/).pop()} — mapping CHƯA XÁC MINH với mẫu sàn; người tải lên Seller Center (agent không đăng)`,
    );
    return 0;
  } catch (e) {
    if (e instanceof le.ExportError) {
      err(`[từ chối] ${e.message} — không ghi tệp`);
      return 1;
    }
    // Python: lỗi DB/manifest hỏng không bắt → traceback exit 1.
    err(
      `[error] ${isDbError(e) ? `lỗi DB: ${clean(dbMsg(e), 300)}` : `${(e as Error).name}: ${(e as Error).message}`}`,
    );
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ------------------------------------------------------------ kd-live

export type KdLiveOpts = {
  channel?: string;
  cart?: string;
  day?: string;
  brief?: string;
  dryRun?: boolean;
};

/** `kd-live --channel K --cart sku1,sku2 --day YYYY-MM-DD --brief "..." [--dry-run]`. Exit: 0 ok · 1
 * từ chối/kịch bản vi phạm/lỗi LLM · 2 tham số sai / DB down / cổng TẮT. */
export async function kdLiveMain(o: KdLiveOpts, d: CliDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  const miss = (['channel', 'cart', 'day', 'brief'] as const).filter((k) => o[k] === undefined);
  if (miss.length) {
    return usage(`the following arguments are required: ${miss.map((k) => `--${k}`).join(', ')}`);
  }
  const day = o.day as string;
  // shortcut: chỉ nhận YYYY-MM-DD (Python 3.12 `fromisoformat` còn nhận YYYYMMDD / tuần ISO) — chặt hơn.
  if (parseDay(day) === null) return usage('--day phải YYYY-MM-DD');
  const cart = (o.cart as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!cart.every((s) => kv.SKU_RE.test(s))) return usage('--cart chỉ gồm mã SKU [a-z0-9-]');
  let rules: kv.Rules;
  try {
    rules = kv.loadRules();
  } catch (e) {
    err(`[error] cấu hình lỗi: ${(e as Error).message}`);
    return 1;
  }
  if (!rules.channels.includes(o.channel as string)) {
    return usage(`--channel phải thuộc ${pyStr(rules.channels)}`);
  }
  const pool = await (d.open ?? openDatabaseUrl)(env);
  if (pool === null) {
    err(NO_DB);
    return 2;
  }
  let res: kv.GenResult;
  try {
    const gw = d.wire === null ? null : wireCore(pool);
    // r12 L5: tính năng TẮT → chặn TRƯỚC lời gọi AI.
    const why = await blocked(pool, 'kịch bản livestream', kv.FEATURE);
    if (why) return sayBlocked(why, log);
    const ai = d.ai ?? gw;
    if (!ai) throw new RangeError('chưa có AI gateway');
    res = await kv.writeScript(pool, o.channel as string, cart, day, o.brief as string, {
      ai,
      dryRun: o.dryRun,
      rules,
    });
  } catch (e) {
    if (!(isDbError(e) || e instanceof RangeError)) throw e;
    const msg = isDbError(e) ? dbMsg(e) : (e as Error).message;
    err(`[error] ${(e as Error).name}: ${Array.from(msg).slice(0, 300).join('')}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
  if (res.error) {
    err(`[error] ${res.error}`);
    return 1;
  }
  if (!res.ok) {
    const r = res.refused as { code: string; reason: string };
    log(`[refuse] ${r.code}: ${r.reason} (LLM ${res.llm_calls} lời gọi)`);
    return 1;
  }
  log(res.text);
  log(
    `[ok] bỏ ${res.dropped.length} câu LLM (số/giá/rượu) · ${
      res.draft_id ? `nháp #${res.draft_id} pending — chờ người duyệt` : 'dry-run, KHÔNG lưu'
    } · model ${res.model || 'mặc định'}`,
  );
  return 0;
}

// ------------------------------------------------------------ nest-commander
// Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.

@Command({
  name: 'kd-listing',
  description:
    'KD-A4 — so listing đang chạy trên sàn với bản duyệt + golden → NHÁP hàng duyệt (agent KHÔNG sửa sàn)',
})
export class KdListingCommand extends CommandRunner {
  async run(_a: string[], o: KdListingOpts): Promise<void> {
    process.exitCode = await kdListingMain(o);
  }

  @Option({ flags: '--run', description: 'đẩy mục lệch mới vào hàng duyệt khối KD' })
  parseRun(): boolean {
    return true;
  }

  @Option({ flags: '--report', description: 'báo cáo catalog-sync-<ngày>.md → data/reports/' })
  parseReport(): boolean {
    return true;
  }

  @Option({ flags: '--dry-run', description: 'với --run: chỉ đọc, in kế hoạch' })
  parseDryRun(): boolean {
    return true;
  }

  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'listing-export',
  description:
    'sales-03 — xuất listing cho sàn / nguồn dữ liệu website từ mô tả chuẩn + giá ĐÃ duyệt (không đăng)',
})
export class ListingExportCommand extends CommandRunner {
  async run(_a: string[], o: ListingExportOpts): Promise<void> {
    process.exitCode = await listingExportMain(o);
  }

  @Option({ flags: '--website-feed' })
  parseWebsiteFeed(): boolean {
    return true;
  }

  @Option({ flags: '--sku <sku>' })
  parseSku(v: string): string {
    return v;
  }

  @Option({ flags: '--channel <channel>', description: 'shopee|tiktok' })
  parseChannel(v: string): string {
    return v;
  }

  @Option({ flags: '--out <dir>' })
  parseOut(v: string): string {
    return v;
  }

  @Option({ flags: '--verify <manifest>' })
  parseVerify(v: string): string {
    return v;
  }
}

@Command({
  name: 'kd-live',
  description:
    'KD-A9 — nháp kịch bản livestream (LLM lời dẫn, giỏ + giá do code) → content_drafts pending; không lên sóng',
})
export class KdLiveCommand extends CommandRunner {
  async run(_a: string[], o: KdLiveOpts): Promise<void> {
    process.exitCode = await kdLiveMain(o);
  }

  @Option({ flags: '--channel <channel>' })
  parseChannel(v: string): string {
    return v;
  }

  @Option({ flags: '--cart <skus>', description: 'sku1,sku2,... (thứ tự)' })
  parseCart(v: string): string {
    return v;
  }

  @Option({ flags: '--day <day>', description: 'ngày phiên YYYY-MM-DD' })
  parseDay(v: string): string {
    return v;
  }

  @Option({ flags: '--brief <text>' })
  parseBrief(v: string): string {
    return v;
  }

  @Option({ flags: '--dry-run', description: 'không lưu nháp' })
  parseDryRun(): boolean {
    return true;
  }
}

export const KD_LISTING_LIVE_COMMANDS = [KdListingCommand, ListingExportCommand, KdLiveCommand];
