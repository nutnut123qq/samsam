import { readFileSync } from 'node:fs';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DIRECTORS_DIR, DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { vnDate } from '@samsam/core/ops/period';
import { parsePyJson, pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, cliEntry, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool } from 'pg';
import type { DbLease } from '../garden_zalo/garden.js';
import { FPA_CONFIG } from '../kd_price/deps.js';
import { reprV } from '../kd_price/mkt-calendar.js';
import { weekStart } from '../sales_director/kd-forecast.deps.js';
import { CODES, type FpAdsDeps, loadCfg, submitProposal, ym } from './fp-ads.js';
import { parseMonth, vnd } from './fp-pnl.js';
import {
  FEATURE,
  loadProposalCfg,
  MAX_PLAN_BYTES,
  normalizePlan,
  RESULT_FEATURE,
} from './mkt-ads.js';
import {
  loadCfgs,
  printStatus,
  propose,
  type Deps as SvcDeps,
  submitPlan,
  submitResults,
} from './mkt-ads.service.js';
import {
  at,
  build,
  CALENDAR_FILE,
  CalendarError,
  dateArg,
  loadInputs,
  loadQuota,
  MAX_WEEKS,
  type Quota,
  QuotaError,
} from './mkt-calendar.js';
import {
  FEATURE as BRIEF_FEATURE,
  briefText,
  bulletin,
  DB_MISSING,
  enqueueBriefs,
  forecastLoad,
  OBJECT_TYPE,
  queueItems,
  renderLoad,
} from './mkt-director.js';

// Lệnh CLI thay `python -m agents.mkt_ads` / `agents.fp_ads` / `agents.mkt_director` — cùng cờ,
// exit code, thông điệp chính. Python dùng `ingest.lead_store.connect()` (DATABASE_URL) cho cả 3.
//   mkt-ads      0 ok/skip · 1 bị từ chối / cấu hình / DB lỗi · 2 usage / BLOCKED / DB down / cổng TẮT
//   fp-ads       0 ok/skip · 1 cấu hình / DB lỗi · 2 tham số sai / DB down
//   mkt-director 0 OK · 1 lịch/golden/cấu hình hỏng · 2 usage / quota hỏng / DB down (--briefs) / TẮT

export const PROPOSAL_FILE = dataPath('ads_proposal.json');
export const DEFAULT_QUOTA = dataPath('review_quota.json');

export type CmdDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  connect?: (env: Env) => Promise<DbLease | null>;
  /** Nối core trên pool của lệnh (mặc định `wireCore`) — test truyền null khi đã nối sẵn. */
  wire?: ((db: Db) => void) | null;
  paths?: {
    fpa?: string;
    directors?: string;
    proposal?: string;
    calendar?: string;
    golden?: string;
    quota?: string;
  };
  /** Python `main(today=)` — mặc định ngày VN hiện tại. */
  today?: string;
  clock?: () => Date;
  svc?: SvcDeps;
  fpAds?: FpAdsDeps;
};

const io = (d: CmdDeps) => ({ log: d.log ?? console.log, err: d.err ?? console.error });
const doWire = (d: CmdDeps, db: Db) => {
  if (d.wire !== null) (d.wire ?? wireCore)(db as Pool);
};
const DB_DOWN = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Python `type(e).__name__` cho lỗi bắt ở CLI (psycopg / ValueError / OSError). */
function pyErrType(e: unknown): string {
  if (isDbError(e)) return pgErrName(e);
  const n = (e as object)?.constructor?.name ?? 'Exception';
  return n === 'RangeError' ? 'ValueError' : n === 'Error' ? pyOsName(e) : n;
}
const caught = (e: unknown) =>
  isDbError(e) || e instanceof RangeError || typeof (e as { code?: unknown })?.code === 'string';

function intArg(v: string | undefined, flag: string): [number | null, string | null] {
  if (v === undefined) return [null, null];
  const s = pyStrip(v);
  if (!/^[+-]?[0-9]+$/.test(s) || !Number.isSafeInteger(Number(s))) {
    return [null, `argument ${flag}: invalid int value: ${reprV(v)}`];
  }
  return [Number(s), null];
}

const prevMonth = (today: string): string => {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1
    ? `${String(y - 1).padStart(4, '0')}-12-01`
    : `${today.slice(0, 5)}${String(m - 1).padStart(2, '0')}-01`;
};

// ---------------------------------------------------------------- mkt-ads

export type MktAdsOpts = {
  plan?: string;
  status?: string;
  results?: string;
  planId?: string;
  by?: string;
  month?: string;
  dryRun?: boolean;
  propose?: boolean;
};

/** `_read_plan`: file JSON UTF-8 (BOM được bỏ) ≤ 64 KB → [phiếu, null] | [null, lý do]. */
function readPlan(path: string): [unknown, null] | [null, string] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return [null, `không đọc được file phiếu (${pyOsName(e)})`];
  }
  if (raw.length > MAX_PLAN_BYTES) return [null, `file phiếu quá lớn (> ${MAX_PLAN_BYTES} byte)`];
  try {
    return [parsePyJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)), null];
  } catch {
    return [null, 'file phiếu không phải JSON UTF-8'];
  }
}

export async function mktAdsMain(o: MktAdsOpts, d: CmdDeps = {}): Promise<number> {
  const { log, err } = io(d);
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    err(`mkt-ads: error: ${m}`);
    return 2;
  };
  const nOps =
    [o.plan, o.status, o.results].filter((x) => x !== undefined).length + (o.propose ? 1 : 0);
  if (nOps !== 1) return usage('cần đúng 1 thao tác: --plan | --status | --results | --propose');
  const [status, w1] = intArg(o.status, '--status');
  if (w1) return usage(w1);
  const [planId, w2] = intArg(o.planId, '--plan-id');
  if (w2) return usage(w2);
  if (o.propose && o.by) return usage('--propose do agent lập (agent:mkt05) — không nhận --by');
  const by = pyStrip(o.by ?? '');
  if ((o.plan !== undefined || o.results !== undefined) && !by) {
    return usage('--plan/--results cần --by <tên người lập>');
  }
  if (o.results !== undefined && planId === null) return usage('--results cần --plan-id N');
  const today = d.today ?? vnDate((d.clock ?? (() => new Date()))());
  let month = prevMonth(today);
  if (o.month !== undefined) {
    const m = parseMonth(o.month);
    if (m === null) return usage('--month phải dạng YYYY-MM');
    month = m;
  }
  const reject = (code: string, why: string) => {
    log(`[từ chối] ${code}: ${why} — không ghi gì.`);
    return 1;
  };
  let plan: unknown = null;
  if (o.plan !== undefined) {
    const [p, why] = readPlan(o.plan);
    const w = why ?? normalizePlan(p, today)[1];
    if (w) return reject('ADS_INPUT', w);
    plan = p;
  }
  const [cfg, dcfg, why] = loadCfgs(
    d.paths?.fpa ?? FPA_CONFIG,
    d.paths?.directors ?? DIRECTORS_DIR,
  );
  if (cfg === null) {
    log(`[err] ${why} — không connect.`);
    return 1;
  }
  let pcfg = null;
  if (o.propose) {
    const [pc, pw] = loadProposalCfg(d.paths?.proposal ?? PROPOSAL_FILE);
    if (pc === null) {
      log(`[BLOCKED] ${pw} — agent không đề xuất, không tự điền số.`);
      return 2;
    }
    pcfg = pc;
  }
  const lease = await (d.connect ?? connectDatabaseUrl)(env);
  if (lease === null) {
    err(DB_DOWN);
    return 2;
  }
  doWire(d, lease.db);
  const db = lease.db;
  try {
    if (!o.dryRun && status === null) {
      // r12 RB: phiếu/đề xuất = 03.1, kết quả = 03.2 — tắt → exit 2 rõ lý do, trước mọi ghi.
      const w = await blocked(
        db,
        'phiếu thử nghiệm ads',
        o.results !== undefined ? RESULT_FEATURE : FEATURE,
      );
      if (w) return sayBlocked(w, log);
    }
    if (status !== null) return await printStatus(db, status, log);
    if (pcfg !== null) {
      const rows = await propose(db, { month, cfg, dcfg, pcfg, today, dryRun: o.dryRun }, d.svc);
      for (const r of rows) {
        const q = r.new_items.map((x) => `#${x}`).join(', ') || '-';
        log(
          `[${r.code}] ${r.sku_key} × ${r.channel}: ${r.reason} (phiếu ${r.plan_id || '-'}, mục ${q})`,
        );
      }
      if (!rows.length)
        log(`[THIẾU] FP&A không có ô SKU × kênh DE_XUAT tháng ${ym(month)} — không đề xuất`);
      return 0;
    }
    if (o.plan !== undefined) {
      const res = await submitPlan(
        db,
        plan,
        { by, month, cfg, dcfg, today, dryRun: o.dryRun },
        d.svc,
      );
      if (res.code) return reject(res.code, res.reason);
      if (o.dryRun) {
        log(`[dry-run] phiếu đạt mọi luật chặn (trần ${vnd(res.cap ?? 0)}) — không ghi.`);
        return 0;
      }
      const items = (res.new_items ?? []).map((q) => `#${q}`).join(', ') || '(không)';
      log(
        `[plan] phiếu #${res.plan_id} (${res.created ? 'mới' : 'đã có — chỉ bổ sung mục thiếu'}) · mục hàng duyệt mới: ${items} — CHỜ GĐ Marketing + GĐ tài chính duyệt; agent không chi tiền.`,
      );
      return 0;
    }
    const res = await submitResults(db, planId as number, o.results as string, {
      by,
      dcfg,
      dryRun: o.dryRun,
    });
    if (res.code === 'ADS_RESULTS_FILE') {
      const errs = res.errors ?? [];
      log(`[err] file kết quả lỗi (${errs.length}) — chặn cả file, không ghi:`);
      for (const e of errs.slice(0, 50)) log(`  - ${e}`);
      return 1;
    }
    if (res.code) return reject(res.code, res.reason ?? '');
    const ev = res.ev;
    const flags = ev?.co.length ? ` [${ev.co.join(', ')}]` : '';
    if (res.skipped) log(`[skip] file kết quả này đã nạp cho phiếu #${planId} — không tạo thêm.`);
    else if (res.qid === null)
      log(`[dry-run] phiếu #${planId}: đề xuất ${ev?.de_xuat}${flags} — không ghi.`);
    else
      log(
        `[results] mục hàng duyệt #${res.qid} — đề xuất ${ev?.de_xuat}${flags} (CHỜ NGƯỜI QUYẾT).`,
      );
    return 0;
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, log);
    if (!caught(e)) throw e;
    const msg = isDbError(e) ? dbMsg(e) : pyErrType(e);
    err(`[error] ${pyErrType(e)}: ${maskPii(msg)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ---------------------------------------------------------------- fp-ads

export type FpAdsOpts = { propose?: boolean; month?: string };

export async function fpAdsMain(o: FpAdsOpts, d: CmdDeps = {}): Promise<number> {
  const { log, err } = io(d);
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    err(`fp-ads: error: ${m}`);
    return 2;
  };
  if (!o.propose) return usage('cần --propose --month YYYY-MM');
  const month = parseMonth(o.month);
  if (month === null) return usage('--month phải dạng YYYY-MM (tháng 01..12)');
  const [cfg, why] = loadCfg(d.paths?.fpa ?? FPA_CONFIG);
  if (cfg === null) {
    log(`[err] ${why} — không connect.`);
    return 1;
  }
  let dcfg: ReturnType<typeof loadConfig>;
  try {
    dcfg = loadConfig('finance', d.paths?.directors ?? DIRECTORS_DIR);
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    log(`[err] cấu hình khối finance: ${e.message} — không connect.`);
    return 1;
  }
  const lease = await (d.connect ?? connectDatabaseUrl)(env);
  if (lease === null) {
    err(DB_DOWN);
    return 2;
  }
  doWire(d, lease.db);
  try {
    const [qid, props] = await submitProposal(lease.db, month, cfg, dcfg, d.fpAds);
    if (qid === null) {
      log(`[skip] đã có đề xuất ngân sách ads tháng ${ym(month)} đang chờ duyệt — không tạo thêm.`);
      return 0;
    }
    const n = CODES.map((c) => `${c}=${props.filter((p) => p.code === c).length}`).join(', ');
    log(`[propose] mục hàng duyệt #${qid} (budget_change, CHỜ NGƯỜI DUYỆT) — ${n}`);
    log(
      `[propose] tổng đề xuất ${vnd(props.reduce((a, p) => a + p.budget_vnd, 0))} — agent không chi tiền, không cài ngân sách.`,
    );
    return 0;
  } catch (e) {
    if ((e as { code?: unknown })?.code === '23505') {
      log(`[skip] đề xuất ads tháng ${ym(month)} vừa được tạo song song — không tạo thêm.`);
      return 0;
    }
    if (!caught(e)) throw e;
    // Python không bắt RolloutBlocked riêng ở lệnh này (ValueError) → exit 1.
    err(`[error] ${pyErrType(e)}: ${isDbError(e) ? dbMsg(e) : pyErrType(e)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ---------------------------------------------------------------- mkt-director

export type MktDirectorOpts = {
  briefs?: boolean;
  load?: boolean;
  bulletin?: boolean;
  today?: string;
  horizonDays?: string;
  days?: string;
  quota?: string;
  outDir?: string;
  dryRun?: boolean;
};

function rangeArg(
  v: string | undefined,
  def: number,
  lo: number,
  hi: number,
  flag: string,
): [number, string | null] {
  if (v === undefined) return [def, null];
  const s = pyStrip(v);
  if (!/^[+-]?[0-9]+$/.test(s)) return [def, `argument ${flag}: phải là số: ${reprV(v)}`];
  const n = Number(s);
  return n >= lo && n <= hi ? [n, null] : [def, `argument ${flag}: phải trong ${lo}..${hi}`];
}

async function mktDirectorInner(o: MktDirectorOpts, d: CmdDeps = {}): Promise<number> {
  const { log, err } = io(d);
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    err(`mkt-director: error: ${m}`);
    return 2;
  };
  const modes = [o.briefs, o.load, o.bulletin].filter(Boolean).length;
  if (modes !== 1) return usage('cần đúng 1 trong --briefs | --load | --bulletin');
  let todayArg: string | null = null;
  if (o.today !== undefined) {
    const [t, w] = dateArg(o.today);
    if (t === null) return usage(`argument --today: ${w}`);
    todayArg = t;
  }
  const [horizon, w1] = rangeArg(o.horizonDays, 14, 1, 60, '--horizon-days');
  if (w1) return usage(w1);
  const [days, w2] = rangeArg(o.days, 28, 1, 90, '--days');
  if (w2) return usage(w2);
  const now = todayArg !== null ? at(todayArg, 0) : (d.clock ?? (() => new Date()))();
  const today = vnDate(now);
  let quota: Quota | null = null;
  if (o.load || o.bulletin) {
    try {
      quota = loadQuota(o.quota ?? d.paths?.quota ?? DEFAULT_QUOTA); // quota hỏng → 2 trước khi đọc lịch
    } catch (e) {
      if (!(e instanceof QuotaError)) throw e;
      err(`[err] quota: ${e.message}`);
      return 2;
    }
  }
  const weeks = o.briefs
    ? Math.min(MAX_WEEKS, Math.floor((horizon + 60) / 7) + 1)
    : o.load
      ? Math.min(MAX_WEEKS, Math.floor((days + 14) / 7) + 1)
      : 6;
  let cal: ReturnType<typeof loadInputs>[0];
  let plan: ReturnType<typeof build>;
  try {
    const [c, golden, sla] = loadInputs(
      d.paths?.calendar ?? CALENDAR_FILE,
      d.paths?.golden,
      d.paths?.directors ?? DIRECTORS_DIR,
    );
    cal = c;
    plan = build(c, golden, o.bulletin ? weekStart(today) : today, weeks, sla);
  } catch (e) {
    if (!(e instanceof CalendarError)) throw e;
    err(`[err] ${e.message}`);
    return 1;
  }
  const gdCap = (cal.review_caps as { gd_marketing_daily: number }).gd_marketing_daily;
  if (o.load) {
    const fc = forecastLoad(plan, quota as Quota, gdCap, today, days);
    log(
      `# Tải duyệt dự báo ${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)} + ${days} ngày (lịch: ${plan.status}; quota: ${(quota as Quota).status})\n`,
    );
    log(renderLoad(fc));
    return 0;
  }
  if (o.briefs) {
    // r12 RB: brief chiến dịch = đầu ra marketing-01.2 — tắt thì chặn TRƯỚC khi in/đẩy.
    const why = await blocked(null, 'brief chiến dịch', BRIEF_FEATURE);
    if (why) return sayBlocked(why, log);
    if (o.dryRun) {
      const limit = now.getTime() + horizon * 86_400_000;
      const sel = plan.campaigns.filter(
        (c) => c.milestones.publish > now && c.milestones.brief.getTime() <= limit,
      );
      for (const c of sel) {
        log(`--- [dry-run] sẽ đẩy ${OBJECT_TYPE} ${c.id} ---`);
        log(briefText(c, plan.status));
      }
      log(`[dry-run] ${sel.length} brief — không connect DB`);
      return 0;
    }
    const lease = await (d.connect ?? connectDatabaseUrl)(env);
    if (lease === null) {
      err('[err] DB không kết nối được');
      return 2;
    }
    doWire(d, lease.db);
    let res: Awaited<ReturnType<typeof enqueueBriefs>>;
    try {
      res = await enqueueBriefs(lease.db, plan, now, horizon);
    } catch (e) {
      if (!isDbError(e)) throw e;
      err(`[err] DB lỗi: ${dbMsg(e)}`);
      return 2;
    } finally {
      await lease.release().catch(() => {});
    }
    for (const x of res.enqueued)
      log(`[ok] ${x.id} → hàng duyệt #${x.queue_id} (pending — GĐ Marketing duyệt)`);
    for (const x of res.skipped) log(`[skip] ${x.id}: ${x.reason}`);
    log(`${res.enqueued.length} đẩy mới, ${res.skipped.length} bỏ qua`);
    return 0;
  }
  // --bulletin
  const fc = forecastLoad(plan, quota as Quota, gdCap, today, 14);
  let items: Awaited<ReturnType<typeof queueItems>> | null = null;
  const lease = await (d.connect ?? connectDatabaseUrl)(env);
  if (lease !== null) {
    doWire(d, lease.db);
    try {
      items = await queueItems(lease.db);
    } catch (e) {
      if (!isDbError(e)) throw e;
      err(`[warn] DB lỗi: ${dbMsg(e)} — ${DB_MISSING}`);
      items = null;
    }
  }
  try {
    const text = bulletin(plan, fc, items, now);
    // P8.4: hàng duyệt khối marketing + lịch — mục MẪU trong hàng → sample.
    const path = await writeReport(
      text,
      o.outDir ?? REPORTS_DIR,
      `mkt-week-${weekStart(today)}.md`,
      (items ?? []).some((i) => Boolean(i.is_sample)),
    );
    log(`[ok] bản tin: ${path}`);
    return 0;
  } finally {
    await lease?.release().catch(() => {});
  }
}

/** r12 RB: RolloutBlocked lọt tới đỉnh → '[rollout] lý do', exit 2 (không traceback). */
export const mktDirectorMain = cliEntry(mktDirectorInner);

// ---------------------------------------------------------------- nest-commander

// Kiểm giá trị ở main(): lỗi ném trong hàm parse của nest-commander thoát 0.
@Command({
  name: 'mkt-ads',
  description:
    'MKT-05 phiếu thử nghiệm ads — NHÁP vào hàng duyệt (agent không chi tiền, không gọi API quảng cáo)',
})
export class MktAdsCommand extends CommandRunner {
  async run(_a: string[], o: MktAdsOpts): Promise<void> {
    process.exitCode = await mktAdsMain(o);
  }
  @Option({ flags: '--plan <file>', description: 'FILE.json phiếu thử nghiệm' })
  parsePlan(v: string): string {
    return v;
  }
  @Option({ flags: '--status <id>' })
  parseStatus(v: string): string {
    return v;
  }
  @Option({ flags: '--results <file>', description: 'FILE.csv kết quả xuất tay' })
  parseResults(v: string): string {
    return v;
  }
  @Option({ flags: '--plan-id <n>' })
  parsePlanId(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>', description: 'người lập (free-text — SSO external-dep)' })
  parseBy(v: string): string {
    return v;
  }
  @Option({
    flags: '--month <ym>',
    description: 'tháng P&L tham chiếu trần YYYY-MM (mặc định tháng trước, giờ VN)',
  })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({
    flags: '--propose',
    description:
      'agent TỰ đề xuất phiếu từ trần FP&A + creative đã duyệt + data/ads_proposal.json (marketing-03)',
  })
  parsePropose(): boolean {
    return true;
  }
}

@Command({
  name: 'fp-ads',
  description: 'FP-AdsBudget: ĐỀ XUẤT ngân sách ads theo biên gộp vào hàng duyệt (không chi tiền)',
})
export class FpAdsCommand extends CommandRunner {
  async run(_a: string[], o: FpAdsOpts): Promise<void> {
    process.exitCode = await fpAdsMain(o);
  }
  @Option({ flags: '--propose' })
  parsePropose(): boolean {
    return true;
  }
  @Option({ flags: '--month <ym>', description: 'tháng tham chiếu P&L YYYY-MM' })
  parseMonth(v: string): string {
    return v;
  }
}

@Command({
  name: 'mkt-director',
  description:
    'MKT-00 GĐ Marketing — brief vào hàng duyệt, cân tải, bản tin tuần (không duyệt, không đăng, không chi tiền)',
})
export class MktDirectorCommand extends CommandRunner {
  async run(_a: string[], o: MktDirectorOpts): Promise<void> {
    process.exitCode = await mktDirectorMain(o);
  }
  @Option({ flags: '--briefs' })
  parseBriefs(): boolean {
    return true;
  }
  @Option({ flags: '--load' })
  parseLoad(): boolean {
    return true;
  }
  @Option({ flags: '--bulletin' })
  parseBulletin(): boolean {
    return true;
  }
  @Option({ flags: '--today <day>' })
  parseToday(v: string): string {
    return v;
  }
  @Option({ flags: '--horizon-days <n>' })
  parseHorizonDays(v: string): string {
    return v;
  }
  @Option({ flags: '--days <n>' })
  parseDays(v: string): string {
    return v;
  }
  @Option({ flags: '--quota <file>' })
  parseQuota(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

export const MKT_ADS_COMMANDS = [MktAdsCommand, FpAdsCommand, MktDirectorCommand];
