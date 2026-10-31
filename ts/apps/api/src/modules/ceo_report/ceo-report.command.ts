import type { AiGateway } from '@samsam/core/ai/gateway';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError, run as directorRun, submit } from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { vnDate } from '@samsam/core/ops/period';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, checkGenerate, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { cpHead, pyRepr, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import { parseNow } from '../ra_kenh/ra-kenh.js';
import {
  build,
  bulletinExtra,
  cell,
  computeSections,
  FEATURE_WEEK,
  finalize,
  reportName,
  repSample,
} from './ceo-report.js';
import {
  CAPTURED_BY,
  closed,
  collectInternal,
  csvSourceRef,
  DATE_RE,
  FEATURE_COLLECT,
  fmtNum,
  isSampleName,
  lastClosedRef,
  loadMetrics,
  type Metrics,
  MetricsError,
  readCsv,
  store,
} from './cockpit.js';

// Lệnh CLI thay `python -m pipelines.cockpit` / `python -m agents.ceo_report` — cùng cờ, exit code,
// thông điệp chính. `cockpitMain`/`ceoReportMain` trả exit code (test gọi thẳng); lớp Command chỉ nối
// + ghi `job_runs` như `with job_run(...)` của Python. Tham số kiểm TRƯỚC connect (sai → exit 2 như
// argparse). Kết nối như `ingest.lead_store.connect()` (DATABASE_URL — job `ceo_weekly` chạy bằng
// login job lịch), rồi nối core trên pool đó (guardrail/cổng triển khai/AI Gateway).
// Exit cockpit: 0 ok · 1 file CSV lỗi / khác giá trị đã nạp / từ điển lỗi · 2 tham số sai / kỳ chưa
// đóng / DB down / cổng TẮT khi ghi số máy chụp.
// Exit ceo-report: 0 ok · 1 từ điển lỗi / nộp hàng chờ lỗi / trang vi phạm guardrail khi --submit ·
// 2 tham số sai / kỳ chưa đóng / DB down / cổng TẮT (ceo-01).

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `connect()` — mặc định DATABASE_URL; null = DB down. */
  connect?: () => Promise<DbLease | null>;
  /** Nối core trên kết nối của lệnh → AI Gateway (mặc định `wireCore`). */
  wire?: (db: Db) => Pick<AiGateway, 'chat'> | null;
  /** Python `main(argv, now)` — mốc "bây giờ" cố định cho test. */
  now?: Date | null;
  dataDir?: string;
  metricsPath?: string;
  routing?: string | null;
  directorsDir?: string;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

const usageOf =
  (io: Io, prog: string) =>
  (msg: string): number => {
    io.err(`${prog}: error: ${msg}`);
    return 2;
  };

/** Python `date.fromisoformat(s)` → 'YYYY-MM-DD'; sai → RangeError cùng thông điệp. TS CHẶT hơn
 * (fail-closed): chỉ nhận YYYY-MM-DD và YYYYMMDD — dạng tuần ISO Python nhận, TS từ chối. */
export function fromIsoDate(s: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (
    !m ||
    (s.length !== 8 && s.length !== 10) ||
    (s.length === 10 && (s[4] !== '-' || s[7] !== '-'))
  ) {
    throw new RangeError(`Invalid isoformat string: ${pyRepr(s)}`);
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) throw new RangeError(`year ${y} is out of range`);
  if (mo < 1 || mo > 12) throw new RangeError('month must be in 1..12');
  const dim = new Date(Date.UTC(2000, mo, 0)).getUTCDate();
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (d < 1 || d > (mo === 2 ? (leap ? 29 : 28) : dim)) {
    throw new RangeError('day is out of range for month');
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const PERIODS = ['week', 'month'];
const choiceErr = (v: string) =>
  `argument --period: invalid choice: ${pyRepr(v)} (choose from 'week', 'month')`;

// ===================================================================== cockpit
export type CockpitOpts = {
  metrics?: boolean;
  collect?: boolean;
  import?: string;
  period?: string;
  ref?: string;
  dryRun?: boolean;
  by?: string;
  sample?: boolean;
};

/** `python -m pipelines.cockpit` → exit code. */
export async function cockpitMain(o: CockpitOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'cockpit');
  if (o.period !== undefined && !PERIODS.includes(o.period)) return usage(choiceErr(o.period));
  const nOps = [o.metrics, o.collect, o.import !== undefined].filter(Boolean).length;
  if (nOps !== 1) return usage('chọn ĐÚNG 1 trong --metrics | --collect | --import');
  if (!o.collect && (o.period || o.ref || o.dryRun)) {
    return usage('--period/--ref/--dry-run chỉ dùng với --collect');
  }
  if (o.import === undefined && (o.by !== undefined || o.sample)) {
    return usage('--by/--sample chỉ dùng với --import');
  }
  if (o.import !== undefined && !pyStrip(o.by ?? '')) {
    return usage('--import cần --by "<người xuất file>"');
  }
  if (o.ref && !DATE_RE.test(o.ref)) return usage('--ref phải YYYY-MM-DD');
  const period = o.period || 'week';
  if (o.metrics) return cliMetrics(io, d);
  if (o.collect) return cliCollect({ ...o, period }, io, d);
  return cliImport(o as CockpitOpts & { import: string; by: string }, io, d);
}

function cliMetrics(io: Io, d: CliDeps): number {
  let m: Metrics;
  try {
    m = loadMetrics(d.metricsPath);
  } catch (e) {
    if (!(e instanceof MetricsError)) throw e;
    io.err(`[error] data/metrics.json: ${e.message}`);
    return 1;
  }
  const specs = Object.entries(m);
  const nInt = specs.filter(([, s]) => s.kind === 'internal').length;
  io.out(`[ok] ${specs.length} metric — internal ${nInt}, external ${specs.length - nInt}`);
  for (const [mid, s] of specs) {
    io.out(
      `  ${mid.padEnd(30)} ${s.kind.padEnd(8)} ${s.unit.padEnd(9)} better=${s.better} · ${s.name}`,
    );
  }
  return 0;
}

async function cliCollect(
  o: CockpitOpts & { period: string },
  io: Io,
  d: CliDeps,
): Promise<number> {
  const now = d.now ?? null;
  let ref: string;
  let start: Date;
  let metrics: Metrics;
  try {
    ref = o.ref ? fromIsoDate(o.ref) : lastClosedRef(o.period, now);
    [start] = closed(o.period, ref, now);
    metrics = loadMetrics(d.metricsPath);
  } catch (e) {
    if (e instanceof MetricsError) {
      io.err(`[error] data/metrics.json: ${e.message}`);
      return 1;
    }
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  const db = lease.db;
  (d.wire ?? wireCore)(db);
  let st: Awaited<ReturnType<typeof store>>;
  try {
    const [rows, errors] = await collectInternal(db, o.period, ref, {
      now,
      dataDir: d.dataDir,
      directorsDir: d.directorsDir,
    });
    io.out(
      `[cockpit] kỳ ${o.period} bắt đầu ${vnDate(start)} (giờ VN) — ${rows.length} số, ${errors.length} lỗi nguồn`,
    );
    for (const r of rows) {
      io.out(`  ${r.metric_id.padEnd(34)} ${fmtNum(r.value).padStart(14)}  ${r.source_ref}`);
    }
    for (const e of errors) io.out(`[warn] thiếu nguồn — ${e}`);
    if (o.dryRun) {
      io.out('[dry-run] không ghi channel_snapshots');
      return 0;
    }
    // v14.3 (HĐ 6.7): số do máy chụp là đầu ra của marketing-06.2 — tính năng TẮT → không ghi.
    // `--import` (số NGƯỜI xuất tay) không phải đầu ra AI → không chặn.
    try {
      await checkGenerate(db, FEATURE_COLLECT, 'chụp số cockpit');
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      io.err(`[blocked] ${e.message} — không ghi channel_snapshots`);
      return 2;
    }
    st = await store(db, rows, CAPTURED_BY, { metrics });
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${cpHead(dbMsg(e), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(
    `[done] inserted=${st.inserted} unchanged=${st.unchanged} conflict=${st.conflict}` +
      (st.unverified ? ` unverified=${st.unverified}` : ''),
  );
  if (st.unverified) {
    io.out(
      `[warn] ${st.unverified} số đã có trong sổ — role DB hiện tại không có SELECT channel_snapshots nên không so được giá trị; GIỮ bản cũ`,
    );
  }
  if (st.conflict) {
    io.out(
      `[warn] ${st.conflict} số khác bản đã chụp — GIỮ bản cũ, không ghi đè; báo người quản trị DB kiểm tra`,
    );
  }
  return 0;
}

async function cliImport(
  o: CockpitOpts & { import: string; by: string },
  io: Io,
  d: CliDeps,
): Promise<number> {
  // A08: nguồn gốc MẪU/thật không chỉ dựa vào trí nhớ người chạy — tên file và --sample phải khớp.
  if (isSampleName(o.import) && !o.sample) {
    io.err(
      '[error] tên file có dấu hiệu MẪU (mau/sample) nhưng thiếu --sample — không nạp số mẫu như số thật',
    );
    return 2;
  }
  if (o.sample && !isSampleName(o.import)) {
    io.err(
      "[error] --sample chỉ dùng cho file tên có 'MAU'/'sample' — file thật KHÔNG nạp với --sample",
    );
    return 2;
  }
  let metrics: Metrics;
  try {
    metrics = loadMetrics(d.metricsPath);
  } catch (e) {
    if (!(e instanceof MetricsError)) throw e;
    io.err(`[error] data/metrics.json: ${e.message}`);
    return 1;
  }
  const [rows, errors] = readCsv(o.import, metrics, { now: d.now });
  if (errors.length) {
    for (const e of errors.slice(0, 50)) io.err(`[error] ${e}`);
    if (errors.length > 50) io.err(`[error] ... và ${errors.length - 50} lỗi khác`);
    io.err('[fail] file lỗi — 0 dòng được nạp, chưa kết nối DB');
    return 1;
  }
  const ref = csvSourceRef(o.import, Boolean(o.sample));
  for (const r of rows) {
    r.source = 'manual_export';
    r.source_ref = ref;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  let st: Awaited<ReturnType<typeof store>>;
  try {
    st = await store(lease.db, rows, pyStrip(o.by), { metrics, atomic: true });
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${cpHead(dbMsg(e), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
  if (st.rolled_back) {
    if (st.conflict) {
      io.err(
        `[fail] ${st.conflict} dòng khác giá trị đã nạp — 0 dòng (không ghi đè số đã chụp; báo người quản trị DB)`,
      );
    } else {
      io.err(
        `[fail] ${st.unverified} dòng đã có trong sổ nhưng role DB hiện tại không có SELECT channel_snapshots để so giá trị (file y nguyên hay đã sửa số đều không phân biệt được) — 0 dòng, số mới KHÔNG được nạp (fail-closed; chạy lại bằng DSN có quyền SELECT sổ)`,
      );
    }
    return 1;
  }
  io.out(
    `[done] ${rows.length} dòng — inserted=${st.inserted} unchanged=${st.unchanged}` +
      (o.sample ? ' (MẪU)' : ''),
  );
  return 0;
}

// ===================================================================== ceo-report
export type CeoReportOpts = {
  period?: string;
  ref?: string;
  llm?: boolean;
  submit?: boolean;
  bulletin?: boolean;
  now?: string;
  outDir?: string;
};

/** `python -m agents.ceo_report` → exit code. */
export async function ceoReportMain(o: CeoReportOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'ceo-report');
  if (o.period !== undefined && !PERIODS.includes(o.period)) return usage(choiceErr(o.period));
  const outDir = o.outDir ?? REPORTS_DIR;
  if (o.bulletin) {
    if (o.submit || o.llm || o.period || o.ref) {
      return usage('--bulletin không đi với --submit/--llm/--period/--ref');
    }
    let now = d.now ?? null;
    if (o.now) {
      try {
        now = parseNow(o.now);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        return usage('--now sai định dạng ISO');
      }
    }
    return bulletin(now ?? new Date(), outDir, io, d);
  }
  if (o.now !== undefined) return usage('--now chỉ đi với --bulletin');
  const period = o.period || 'week';
  const now = d.now ?? null;
  let ref: string;
  try {
    ref = o.ref ? fromIsoDate(o.ref) : lastClosedRef(period, now);
    closed(period, ref, now);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  let metrics: Metrics;
  try {
    metrics = loadMetrics(d.metricsPath);
  } catch (e) {
    if (!(e instanceof MetricsError)) throw e;
    io.err(`[error] data/metrics.json: ${e.message}`);
    return 1;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  const db = lease.db;
  try {
    const ai = (d.wire ?? wireCore)(db);
    // r12 G1-L4: báo cáo TUẦN = đầu ra ceo-01 — cổng tắt TRƯỚC khi dựng/gọi LLM.
    const fid = period === 'week' ? FEATURE_WEEK : null;
    const why = await blocked(db, 'báo cáo tuần TGĐ', fid);
    if (why) return sayBlocked(why, io.out);
    let rep: Awaited<ReturnType<typeof build>>;
    try {
      const secs = await computeSections(db, now ?? new Date());
      rep = await build(db, period, ref, {
        now,
        llm: Boolean(o.llm),
        metrics,
        sections: secs,
        ai,
        routing: d.routing ?? null,
      });
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.err(`[error] lỗi DB: ${cpHead(dbMsg(e), 300)}`);
      return 2;
    }
    const [text, ok] = finalize(rep);
    const path = await writeReport(text, outDir, reportName(rep), repSample(rep), fid);
    const nData = rep.rows.filter((r) => r.cur !== null).length;
    io.out(
      `[done] ${path} — kỳ ${rep.label}, ${nData}/${rep.rows.length} chỉ số có số kỳ này` +
        (rep.preflight.ok ? '' : ' · ĐỎ: chưa có người nhận cảnh báo độc lập'),
    );
    if (rep.llm_note) io.out(`[warn] ${rep.llm_note}`);
    if (!ok) io.out(`[warn] guardrail vi phạm: ${rep.guardrail_violations.join(', ')}`);
    if (!o.submit) return 0;
    if (!ok) {
      io.err('[error] trang vi phạm guardrail — KHÔNG nộp');
      return 1;
    }
    const kindVi = period === 'week' ? 'tuần' : 'tháng';
    let qid: bigint;
    try {
      qid = await submit(db, {
        block: 'ceo',
        objectType: period === 'week' ? 'weekly_report' : 'monthly_report',
        objectId: rep.label,
        title: `Báo cáo ${kindVi} ${rep.label} — TGĐ`,
        payload: text,
        createdBy: 'agent:ceo_report',
      });
    } catch (e) {
      if (!isDbError(e) && !(e instanceof RangeError) && !(e instanceof DirectorConfigError)) {
        throw e;
      }
      const msg = isDbError(e) ? dbMsg(e) : (e as Error).message;
      io.err(`[error] không nộp được hàng chờ: ${cpHead(msg, 300)}`);
      return 1;
    }
    io.out(
      `[submit] mục #${qid} vào hàng chờ khối ceo (pending — TGĐ duyệt; hệ thống KHÔNG tự duyệt)`,
    );
    return 0;
  } finally {
    await lease.release().catch(() => {});
  }
}

async function bulletin(now: Date, outDir: string, io: Io, d: CliDeps): Promise<number> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  let path: string;
  try {
    (d.wire ?? wireCore)(lease.db);
    const secs = await computeSections(lease.db, now);
    [path] = await directorRun(lease.db, 'ceo', { now, outDir, extra: bulletinExtra(secs) });
  } catch (e) {
    if (!isDbError(e) && !(e instanceof DirectorConfigError)) throw e;
    const msg = isDbError(e) ? dbMsg(e) : (e as Error).message;
    io.err(`[error] bản tin khối ceo: ${cpHead(cell(msg), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(`[bulletin] ${path} — bản tin GĐ khối ceo + 3 section (BẢN NHÁP, không tự gửi)`);
  return 0;
}

// ===================================================================== nest-commander

@Command({
  name: 'cockpit',
  description:
    'Cockpit TGĐ — thu số liệu điều hành vào channel_snapshots (insert-only) (python -m pipelines.cockpit)',
})
export class CockpitCommand extends CommandRunner {
  async run(_args: string[], o: CockpitOpts): Promise<void> {
    process.exitCode = await jobRun('pipelines.cockpit', async (r) => {
      const rc = await cockpitMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--metrics', description: 'kiểm + in từ điển chỉ số' })
  parseMetrics(): boolean {
    return true;
  }
  @Option({ flags: '--collect', description: 'chụp số nội bộ của kỳ ĐÃ ĐÓNG' })
  parseCollect(): boolean {
    return true;
  }
  @Option({ flags: '--import <file>', description: 'nạp CSV manual_export số kênh ngoài' })
  parseImport(v: string): string {
    return v;
  }
  @Option({ flags: '--period <kind>', description: 'week|month (mặc định week)' })
  parsePeriod(v: string): string {
    return v;
  }
  @Option({ flags: '--ref <date>', description: 'YYYY-MM-DD (ngày VN)' })
  parseRef(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>', description: 'người xuất file (--import)' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--sample', description: "file MẪU → source_ref 'sample:'" })
  parseSample(): boolean {
    return true;
  }
}

@Command({
  name: 'ceo-report',
  description: 'Báo cáo tuần/tháng cho TGĐ (BẢN NHÁP — không tự gửi) (python -m agents.ceo_report)',
})
export class CeoReportCommand extends CommandRunner {
  async run(_args: string[], o: CeoReportOpts): Promise<void> {
    process.exitCode = await jobRun('agents.ceo_report', async (r) => {
      const rc = await ceoReportMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--period <kind>', description: 'week|month (mặc định week)' })
  parsePeriod(v: string): string {
    return v;
  }
  @Option({ flags: '--ref <date>', description: 'YYYY-MM-DD (ngày VN)' })
  parseRef(v: string): string {
    return v;
  }
  @Option({ flags: '--llm', description: "nhận xét qua AI Gateway agent 'cockpit' (mặc định TẮT)" })
  parseLlm(): boolean {
    return true;
  }
  @Option({ flags: '--submit', description: 'nộp trang vào hàng chờ khối ceo để TGĐ duyệt' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({
    flags: '--bulletin',
    description: 'bản tin GĐ khối ceo kèm 3 section v8.1 → data/reports/director-ceo-<ngày>.md',
  })
  parseBulletin(): boolean {
    return true;
  }
  @Option({ flags: '--now <iso>', description: 'ISO CHỈ cho --bulletin; thiếu múi giờ = giờ VN' })
  parseNow(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}
