import { randomInt } from 'node:crypto';
import { createPool, databaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { type Db, dep } from '@samsam/core/ops/deps';
import { DirectorConfigError, submit } from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { addDays, vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import type { Sender } from '@samsam/core/ops/red-alert';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import pg from 'pg';
import { cell } from '../ceo_report/ceo-report.js';
import { parseNow } from '../ra_kenh/ra-kenh.js';
import { type Fees, loadFees } from '../settlement/settlement-csv.js';
import * as audit from './bks-audit.js';
import * as recon from './bks-recon.js';
import * as hdtv from './hdtv-report.js';

// Lệnh CLI thay `python -m agents.bks_audit` / `agents.bks_recon` / `agents.hdtv_report` — cùng cờ,
// exit code, thông điệp chính. `*Main` trả exit code (test gọi thẳng); lớp Command nối + ghi
// `job_runs` như `with job_run(...)` của Python. Tham số kiểm TRƯỚC connect (sai → exit 2 như
// argparse). Kết nối như `ingest.lead_store.connect()` (DATABASE_URL — job `chain_watch`/`hdtv_month`
// chạy bằng login job lịch), rồi nối core trên pool đó. Không `--record`/`--submit` → giao dịch
// READ ONLY (Python `conn.read_only = True`): DB từ chối mọi lệnh ghi.
// Exit bks-audit: 0 ok (có phát hiện vẫn 0) · 1 `--chain-alert` có phát hiện · 2 tham số / kỳ chưa
//   đóng / DB down / lỗi DB / cổng TẮT.
// Exit bks-recon: 0 ok (kể cả có lệch) · 1 cấu hình phí hỏng · 2 tham số / kỳ chưa đóng / DB down /
//   lỗi DB / cổng TẮT.
// Exit hdtv-report: 0 ok · 1 cấu hình hỏng / số không nguồn / guardrail chặn submit / nộp lỗi ·
//   2 tham số / kỳ chưa đóng / DB down / lỗi DB / cổng TẮT (ceo-05).

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `connect()` — mặc định DATABASE_URL; null = DB down. */
  connect?: () => Promise<DbLease | null>;
  /** Nối core trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  /** Python `main(argv, now)` — mốc "bây giờ" khi không có `--now`. */
  now?: Date | null;
  /** bks-recon: `data/settlement_fees.json`. */
  feesFile?: string;
  /** bks-recon: seed mặc định (Python `secrets.randbits(32)`). */
  randomSeed?: () => bigint;
  /** hdtv-report: `data/hdtv_report.json`. */
  configFile?: string;
  /** hdtv-report: thay section nhóm ceo_misc / danh sách mục (test). */
  build?: Pick<hdtv.BuildOpts, 'deps' | 'sections'>;
  /** bks-audit --chain-alert: tuyến cảnh báo đỏ (null = data/red_alert_routing.json) + kênh gửi
   * (null/undefined = SMTP theo `env` như Python). */
  routing?: unknown;
  sender?: Sender | null;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Python `ingest.lead_store.connect()`: DATABASE_URL → pool | null (thiếu/không tới được). */
export async function connectDatabaseUrl(env: Env = process.env): Promise<DbLease | null> {
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

const usageOf =
  (io: Io, prog: string) =>
  (msg: string): number => {
    io.err(`${prog}: error: ${msg}`);
    return 2;
  };

/** Một client cho cả lệnh; `readOnly` → `begin transaction read only`. Khi xong: rollback (như
 * `finally: conn.rollback()` của Python) + trả client. */
async function session(db: Db, readOnly: boolean): Promise<[pg.ClientBase, () => Promise<void>]> {
  const c = db instanceof pg.Pool ? await db.connect() : db;
  try {
    if (readOnly) await c.query('begin transaction read only');
  } catch (e) {
    if (c !== db) (c as pg.PoolClient).release();
    throw e;
  }
  return [
    c,
    async () => {
      await c.query('rollback').catch(() => {});
      if (c !== db) (c as pg.PoolClient).release();
    },
  ];
}

async function open(d: CliDeps, io: Io): Promise<DbLease | null> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) io.err(NO_DB);
  return lease;
}

function parseNowOpt(s: string | undefined, d: CliDeps): Date | null {
  if (!s) return d.now ?? new Date(); // Python `if a.now`: '' = không truyền
  try {
    return parseNow(s);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return null;
  }
}

// ===================================================================== bks-audit
export type BksAuditOpts = {
  report?: boolean;
  chainAlert?: boolean;
  month?: string;
  now?: string;
  outDir?: string;
  record?: boolean;
  dryRun?: boolean;
};

/** `python -m agents.bks_audit` → exit code. */
export async function bksAuditMain(o: BksAuditOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'bks-audit');
  if (o.record && o.dryRun) return usage('--record và --dry-run loại trừ nhau');
  if (o.chainAlert) {
    if (o.report || o.record || o.dryRun || o.month) {
      return usage('--chain-alert không đi cùng --report/--record/--dry-run/--month');
    }
    return chainMain(io, d);
  }
  if (!o.report) return usage('cần --report hoặc --chain-alert');
  const now = parseNowOpt(o.now, d);
  if (now === null) return usage('--now sai định dạng ISO');
  let label: string;
  let start: Date;
  let end: Date;
  try {
    [label, start, end] = audit.monthBounds(o.month, now);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  const lease = await open(d, io);
  if (lease === null) return 2;
  let path: string | null = null;
  let rid: string | null = null;
  let n = 0;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    const [c, done] = await session(lease.db, !o.record);
    try {
      const data = await audit.run(c, start, end);
      const text = audit.render(data, label, now);
      n = data.findings.length;
      if (o.dryRun) {
        io.out(text);
        return 0;
      }
      // P8.4: kiểm toán trên DB thật (chuỗi hash/duyệt/quyền) — không có đường dữ liệu mẫu.
      path = await writeReport(text, o.outDir ?? REPORTS_DIR, `bks-audit-${label}.md`, false);
      if (o.record) {
        rid = await audit.recordRun(
          c,
          audit.KIND,
          label,
          { heads: data.heads, by_code: audit.byCode(data.findings) },
          n,
          text,
          audit.RUN_BY,
        );
      }
    } finally {
      await done();
    }
  } catch (e) {
    if (isDbError(e)) {
      io.err(`[error] lỗi DB: ${audit.why(e)}`);
      return 2;
    }
    if (e instanceof RolloutBlocked) {
      io.err(`[blocked] ${e.message}`); // HĐ 6.7
      return 2;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(
    `[done] ${path} — kỳ ${label}, ${n} phát hiện${rid ? ` · audit_runs #${rid}` : ' · không ghi sổ'}`,
  );
  return 0;
}

async function chainMain(io: Io, d: CliDeps): Promise<number> {
  const lease = await open(d, io);
  if (lease === null) return 2;
  let r: audit.ChainResult;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    r = await audit.chainAlert(lease.db, d.routing ?? null, d.sender, d.env);
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${audit.why(e)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
  const n = r.findings.length;
  if (!n) {
    io.out('[done] chuỗi nhật ký nguyên vẹn (agent_action_log, plot_logs)');
    return 0;
  }
  const state = r.dup
    ? 'đã báo trước đó (cùng phát hiện)'
    : `cảnh báo đỏ #${r.alert_id}${r.routed ? '' : ' — CHƯA thông báo được người nhận'}`;
  io.err(`[ALERT] ${n} phát hiện chuỗi nhật ký · ${state}`);
  return 1;
}

// ===================================================================== bks-recon
export type BksReconOpts = {
  month?: string;
  seed?: string;
  now?: string;
  outDir?: string;
  record?: boolean;
  dryRun?: boolean;
};

const SEED_MAX = 2n ** 63n;

/** `python -m agents.bks_recon` → exit code. */
export async function bksReconMain(o: BksReconOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'bks-recon');
  if (o.month === undefined) return usage('the following arguments are required: --month');
  let seed0: bigint | null = null;
  if (o.seed !== undefined) {
    seed0 = pyInt(o.seed);
    if (seed0 === null) return usage(`argument --seed: invalid int value: '${o.seed}'`);
  }
  if (o.record && o.dryRun) return usage('--record và --dry-run loại trừ nhau');
  if (seed0 !== null && !(seed0 >= 0n && seed0 < SEED_MAX)) return usage('--seed phải ≥ 0');
  const now = parseNowOpt(o.now, d);
  if (now === null) return usage('--now sai định dạng ISO');
  let label: string;
  try {
    [label] = audit.monthBounds(o.month, now);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  const [fees, why] = loadFees(d.feesFile);
  if (fees === null) {
    io.err(`[error] ${why} — không connect.`);
    return 1;
  }
  const seed = seed0 ?? (d.randomSeed ?? (() => BigInt(randomInt(0, 2 ** 32))))();
  const lease = await open(d, io);
  if (lease === null) return 2;
  let data: recon.ReconData;
  let path: string | null = null;
  let rid: string | null = null;
  let n = 0;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    const [c, done] = await session(lease.db, !o.record);
    try {
      data = await recon.collect(c, `${label}-01`, seed, fees as Fees);
      const text = recon.render(data, now);
      n = recon.findingsOf(data).length;
      if (o.dryRun) {
        io.out(text);
        return 0;
      }
      path = await writeReport(
        text,
        o.outDir ?? REPORTS_DIR,
        `bks-recon-${label}.md`,
        data.sample_flag,
      );
      if (o.record) {
        rid = await audit.recordRun(
          c,
          recon.KIND,
          label,
          { seed, n_total: data.n_total, n_checked: data.n_checked },
          n,
          text,
          recon.RUN_BY,
          data.sample_flag,
        );
      }
    } finally {
      await done();
    }
  } catch (e) {
    if (isDbError(e)) {
      io.err(`[error] lỗi DB: ${audit.why(e)}`);
      return 2;
    }
    if (e instanceof RolloutBlocked) {
      io.err(`[blocked] ${e.message}`); // HĐ 6.7
      return 2;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(
    `[done] ${path} — tháng ${label}, ${n} khác biệt/phát hiện, seed ${seed}, kiểm ${data.n_checked}/${data.n_total} dòng${rid ? ` · audit_runs #${rid}` : ' · không ghi sổ'}`,
  );
  return 0;
}

// ===================================================================== hdtv-report
export type HdtvReportOpts = {
  month?: string;
  quarter?: string;
  now?: string;
  outDir?: string;
  submit?: boolean;
  record?: boolean;
};

/** `python -m agents.hdtv_report` → exit code. */
export async function hdtvReportMain(o: HdtvReportOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'hdtv-report');
  const nOps = Number(o.month !== undefined) + Number(o.quarter !== undefined);
  if (nOps !== 1) return usage('cần đúng 1 trong --month | --quarter');
  const now = parseNowOpt(o.now, d);
  if (now === null) return usage('--now sai định dạng ISO');
  let period = (o.month ?? o.quarter) as string;
  if (period === 'prev') {
    // Đợt hợp đồng C11: job tháng (`hdtv_month`) = tháng vừa ĐÓNG theo giờ VN.
    period = addDays(`${vnDate(now).slice(0, 8)}01`, -1).slice(0, 7);
  }
  try {
    hdtv.parsePeriod(period, now);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  let cfg: hdtv.HdtvConfig;
  try {
    cfg = hdtv.loadConfig(d.configFile);
  } catch (e) {
    if (!(e instanceof hdtv.ConfigError)) throw e;
    io.err(`[error] ${e.message}`);
    return 1;
  }
  const lease = await open(d, io);
  if (lease === null) return 2;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    const [c, done] = await session(lease.db, !(o.submit || o.record));
    try {
      return await hdtvRun(c, o, period, now, cfg, io, d);
    } finally {
      await done();
    }
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${cpHead(cell(maskPii(dbMsg(e))), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

async function hdtvRun(
  c: pg.ClientBase,
  o: HdtvReportOpts,
  period: string,
  now: Date,
  cfg: hdtv.HdtvConfig,
  io: Io,
  d: CliDeps,
): Promise<number> {
  // v14.3 (HĐ 6.7): ceo-05 TẮT → không dựng gói (không file/sổ/hàng).
  try {
    await dep('rollout').checkGenerate(c, hdtv.FEATURE, 'gói báo cáo HĐTV');
  } catch (e) {
    if (!(e instanceof RolloutBlocked)) throw e;
    io.err(`[blocked] ${e.message}`);
    return 2;
  }
  let pack: hdtv.Pack;
  let text: string;
  let ok: boolean;
  try {
    pack = await hdtv.build(c, period, now, { cfg, ...d.build });
    [text, ok] = hdtv.finalize(pack);
  } catch (e) {
    if (!(e instanceof hdtv.UngroundedNumber)) throw e;
    io.err(`[error] ${e.message}`);
    return 1;
  }
  // r12 G1-L4: tiền tố hdtv- không thuộc output_sources → ghi tường minh tính năng.
  const path = await writeReport(
    text,
    o.outDir ?? REPORTS_DIR,
    `hdtv-${period}.md`,
    pack.sample,
    hdtv.FEATURE,
  );
  io.out(
    `[done] ${path} — kỳ ${period}, ${pack.facts.length} fact có nguồn, ${pack.unreadable} mục không đọc được`,
  );
  if (!ok) io.out(`[warn] guardrail vi phạm: ${pack.guardrailViolations.join(', ')}`);
  if (o.record) {
    const rid = await audit.recordRun(
      c,
      'hdtv_pack',
      period,
      { facts: pack.facts.length, unreadable: pack.unreadable, guardrail_ok: ok },
      pack.unreadable,
      text,
      hdtv.RUN_BY,
      pack.sample,
    );
    io.out(`[record] audit_runs #${rid}`);
  }
  if (!o.submit) return 0;
  if (!ok) {
    io.err('[error] gói vi phạm guardrail — KHÔNG nộp');
    return 1;
  }
  const kindVi = pack.kind === 'month' ? 'tháng' : 'quý';
  const { rows: old } = await c.query<{ id: string; status: string }>(
    'select id, status from approval_queue where object_type = $1 and object_id = $2 order by id desc limit 1',
    [hdtv.OBJECT_TYPE, period],
  );
  if (old.length) {
    // C11: chạy lại lịch không nhân bản/không lỗi.
    io.out(`[skipped] kỳ ${period} đã có mục #${old[0].id} (${old[0].status}) — không nộp lại`);
    return 0;
  }
  let qid: bigint;
  try {
    qid = await submit(c, {
      block: 'ceo',
      objectType: hdtv.OBJECT_TYPE,
      objectId: period,
      title: `Gói báo cáo HĐTV ${kindVi} ${period}`,
      payload: text,
      createdBy: hdtv.RUN_BY,
      sample: pack.sample,
    });
  } catch (e) {
    if (!isDbError(e) && !(e instanceof RangeError) && !(e instanceof DirectorConfigError)) throw e;
    const msg = isDbError(e) ? dbMsg(e) : (e as Error).message;
    io.err(`[error] không nộp được hàng chờ: ${cpHead(cell(msg), 300)}`);
    return 1;
  }
  io.out(
    `[submit] mục #${qid} vào hàng chờ khối ceo (pending — TGĐ duyệt; hệ thống KHÔNG tự duyệt, KHÔNG tự gửi HĐTV)`,
  );
  return 0;
}

// ===================================================================== nest-commander

@Command({
  name: 'bks-audit',
  description:
    'Audit inside-out BKS (CHỈ ĐỌC; ghi duy nhất audit_runs khi --record) (python -m agents.bks_audit)',
})
export class BksAuditCommand extends CommandRunner {
  async run(_args: string[], o: BksAuditOpts): Promise<void> {
    process.exitCode = await jobRun('agents.bks_audit', async (r) => {
      const rc = await bksAuditMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--report' })
  parseReport(): boolean {
    return true;
  }
  @Option({
    flags: '--chain-alert',
    description:
      'chỉ kiểm chuỗi hash → cảnh báo đỏ nếu bị sửa (job chain_watch hằng ngày); exit 1 khi có phát hiện',
  })
  parseChainAlert(): boolean {
    return true;
  }
  @Option({ flags: '--month <m>', description: 'YYYY-MM (mặc định tháng vừa đóng)' })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--now <iso>', description: 'ISO; thiếu múi giờ = giờ VN' })
  parseNow(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--record', description: 'ghi 1 dòng audit_runs (neo đuôi chuỗi)' })
  parseRecord(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: 'in báo cáo ra stdout, không ghi file/DB' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'bks-recon',
  description:
    'Đối soát độc lập BKS (CHỈ ĐỌC; ghi duy nhất audit_runs khi --record) (python -m agents.bks_recon)',
})
export class BksReconCommand extends CommandRunner {
  async run(_args: string[], o: BksReconOpts): Promise<void> {
    process.exitCode = await jobRun('agents.bks_recon', async (r) => {
      const rc = await bksReconMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--month <m>', description: 'YYYY-MM' })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--seed <n>', description: 'seed lấy mẫu (mặc định ngẫu nhiên, ghi báo cáo)' })
  parseSeed(v: string): string {
    return v;
  }
  @Option({ flags: '--now <iso>', description: 'ISO; thiếu múi giờ = giờ VN' })
  parseNow(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--record' })
  parseRecord(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'hdtv-report',
  description:
    'Gói báo cáo HĐTV tháng/quý (BẢN NHÁP — không tự gửi) (python -m agents.hdtv_report)',
})
export class HdtvReportCommand extends CommandRunner {
  async run(_args: string[], o: HdtvReportOpts): Promise<void> {
    process.exitCode = await jobRun('agents.hdtv_report', async (r) => {
      const rc = await hdtvReportMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--month <m>', description: 'YYYY-MM | prev (tháng vừa đóng)' })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--quarter <q>', description: 'YYYY-Qn' })
  parseQuarter(v: string): string {
    return v;
  }
  @Option({ flags: '--now <iso>', description: 'ISO; thiếu múi giờ = giờ VN' })
  parseNow(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--submit', description: 'nộp gói vào hàng chờ khối ceo (TGĐ duyệt)' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--record', description: 'ghi 1 dòng audit_runs kind hdtv_pack' })
  parseRecord(): boolean {
    return true;
  }
}
