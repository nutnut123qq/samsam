import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import {
  type DirectorConfig,
  DirectorConfigError,
  loadConfig as loadDirectorConfig,
} from '@samsam/core/ops/director';
import { vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { pgErrName, pyDumps } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { loadUsers } from '@samsam/core/security/auth';
import { pyRepr } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import {
  type DbLease,
  FPA_CONFIG_FILE,
  fmtDay,
  isDict,
  MAX_PRINT_ERRS,
  parseMonth,
  toSigned,
  vnd,
} from '../fin_ar_pnl/fin-common.js';
import { readGolden, validateGolden } from '../garden_director/scenario.js';
import { clean } from '../intel_import/table.js';
import * as cash from './fp-cash.js';
import * as ops from './fp-opscost.js';
import * as sc from './scenario.js';

// Lệnh CLI thay `python -m pipelines.scenario` / `agents.fp_cash` / `agents.fp_opscost` — cùng cờ,
// exit code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ
// nối. Tham số kiểm ở đây TRƯỚC connect/đọc nguồn (lỗi → exit 2 như argparse). Kết nối như Python
// `ingest.lead_store.connect()` (DATABASE_URL). KHÔNG nối core (`wireCore`) lên kết nối của lệnh: kết
// nối này đóng khi lệnh xong, còn cổng/sổ báo cáo (`writeReport`) tự lấy kết nối riêng như Python
// `rollout.connect()` — nối lên pool sắp đóng → cổng đọc "chạy thử" sai, sổ đầu ra không ghi.

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type CliDeps = {
  env?: Env;
  io?: Io;
  connect?: () => Promise<DbLease | null>;
  now?: () => Date;
  fpaConfig?: string;
  assumptionsFile?: string;
  goldenFile?: string;
  usersFile?: string;
  dcfg?: DirectorConfig;
  directorsDir?: string;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Python `type(e).__name__` cho lỗi bắt được ở CLI (RangeError = ValueError). */
function pyTypeName(e: unknown): string {
  if (isDbError(e))
    return (e as { code?: string }).code === '23505' ? 'UniqueViolation' : pgErrName(e);
  const n = (e as Error)?.constructor?.name ?? 'Error';
  return n === 'RangeError' ? 'ValueError' : n;
}

/** Lỗi hệ thống tệp (Python OSError). */
const isFsError = (e: unknown): boolean =>
  e instanceof Error &&
  typeof (e as { code?: unknown }).code === 'string' &&
  typeof (e as { syscall?: unknown }).syscall === 'string' &&
  'path' in e;

const usageOf =
  (io: Io, prog: string) =>
  (msg: string): number => {
    io.err(`${prog}: error: ${msg}`);
    return 2;
  };

// ===================================================================== scenario
export type ScenarioOpts = {
  sku?: string;
  channel?: string;
  weeks?: string;
  start?: string;
  json?: boolean;
  outDir?: string;
};

/** `python -m pipelines.scenario` → 0 OK · 1 lỗi dữ liệu / cổng tắt khi ghi báo cáo · 2 tham số sai. */
export async function scenarioMain(o: ScenarioOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'scenario');
  let weeks = 13;
  if (o.weeks !== undefined) {
    const n = pyInt(o.weeks);
    if (n === null) return usage('argument --weeks: phải là số nguyên');
    if (n < 1n || n > BigInt(sc.MAX_WEEKS)) {
      return usage(`argument --weeks: phải trong 1..${sc.MAX_WEEKS}`);
    }
    weeks = Number(n);
  }
  let start: string | null = null;
  if (o.start !== undefined) {
    start = sc.isoDate(o.start);
    if (start === null) return usage('argument --start: ngày phải dạng YYYY-MM-DD');
    if (!(sc.DATE_MIN <= start && start <= sc.DATE_MAX)) {
      return usage(`argument --start: ngày phải trong ${sc.DATE_MIN}..${sc.DATE_MAX}`);
    }
  }
  if (o.channel !== undefined && !sc.ALL_CHANNELS.includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: ${pyRepr(o.channel)} (choose from ${sc.ALL_CHANNELS.map(pyRepr).join(', ')})`,
    );
  }
  const missing = [o.sku === undefined && '--sku', o.channel === undefined && '--channel'].filter(
    Boolean,
  );
  if (missing.length) return usage(`the following arguments are required: ${missing.join(', ')}`);
  if (o.json && o.outDir) return usage('--out-dir không đi với --json');
  const skuKey = o.sku as string;
  const channel = o.channel as string;
  const fail = (msg: string) => {
    io.err(`[err] ${msg}`);
    return 1;
  };

  const [doc, why] = readGolden(d.goldenFile);
  if (doc === null) return fail(`golden: ${why}`);
  const errs = validateGolden(doc);
  if (errs.length) return fail(`golden không hợp lệ (${errs.length} lỗi), lỗi đầu: ${errs[0]}`);
  const sku = (doc.skus as unknown[]).find((s) => isDict(s) && s.sku_key === skuKey);
  if (sku === undefined) return fail(`SKU '${skuKey}' không có trong golden`);
  const day = start ?? vnDate((d.now ?? (() => new Date()))());
  let a: sc.Assumptions;
  let rows: sc.WeekRow[];
  try {
    a = sc.loadAssumptions(d.assumptionsFile);
    rows = sc.project(sku, channel, day, weeks, a);
  } catch (e) {
    if (e instanceof sc.ScenarioError) return fail(e.message);
    throw e;
  }
  const head = `${a.status}\nKhoảng thấp/cơ sở/cao — KHÔNG phải doanh số cam kết (đơn vị/tuần)`;
  if (o.json) {
    io.err(head);
    io.out(pyDumps(rows));
    return 0;
  }
  const lines = [
    head,
    `SKU ${skuKey} · kênh ${channel} · ${weeks} tuần`,
    'tuần | sự kiện | thấp | cơ sở | cao | ghi chú',
    ...rows.map(
      (r) =>
        `${r.week_start} | ${r.events.join(',') || '-'} | ${r.low} | ${r.base} | ${r.high} | ${r.note ?? ''}`,
    ),
  ];
  io.out(lines.join('\n'));
  if (o.outDir) {
    // docx P2 (intel-06, PL02 mục 1): ghi qua `writeReport` (cổng tắt + nhãn giai đoạn + sổ
    // `report_outputs`). sample=false: golden + giả định file (GIẢ ĐỊNH in ngay dòng đầu).
    let p: string;
    try {
      p = await writeReport(
        `${lines.join('\n')}\n`,
        o.outDir,
        `kich-ban-${skuKey}-${channel}-${day}.md`,
        false,
      );
    } catch (e) {
      if (e instanceof RolloutBlocked) return fail(e.message);
      throw e;
    }
    io.out(`[done] ${p}`);
  }
  return 0;
}

// ===================================================================== fp_cash
export type FpCashOpts = {
  forecast?: boolean;
  start?: string;
  opening?: string;
  json?: boolean;
  outDir?: string;
};

/** `python -m agents.fp_cash` → 0 ok (DB down vẫn chạy với tỷ lệ mặc định + [warn]) · 1 giả định/
 * golden/cấu hình lỗi · 2 tham số sai / cổng tắt. */
export async function fpCashMain(o: FpCashOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'fp_cash');
  if (!o.forecast) return usage('cần --forecast');
  let start: string | null = null;
  if (o.start !== undefined) {
    start = sc.isoDate(o.start);
    if (start === null) return usage('--start phải dạng YYYY-MM-DD');
    if (!(sc.DATE_MIN <= start && start <= sc.DATE_MAX)) {
      return usage(`--start phải trong ${sc.DATE_MIN}..${sc.DATE_MAX}`);
    }
  }
  let opening: number | null = null;
  if (o.opening !== undefined) {
    opening = toSigned(o.opening, cash.MONEY_CAP);
    if (opening === null) return usage('--opening phải là số nguyên VND');
  }
  const day = start ?? vnDate((d.now ?? (() => new Date()))());
  // r12 GATE-OUT: tắt → không in dự báo ra stdout (không chỉ chặn file) — TRƯỚC đọc nguồn/connect.
  const why = await blocked(null, 'dự báo dòng tiền', cash.FEATURE);
  if (why) return sayBlocked(why, io.out);
  let inp: cash.Inputs;
  try {
    inp = cash.loadInputs(d.fpaConfig ?? FPA_CONFIG_FILE, {
      assumptionsFile: d.assumptionsFile,
      goldenFile: d.goldenFile,
    });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.out(`[err] ${e.message} — không connect.`);
    return 1;
  }
  if (opening === null) opening = inp.cfg.opening_balance_vnd;

  let measured: cash.Measured = {};
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(
      `[warn] không kết nối được Postgres — tỷ lệ thực nhận dùng mặc định cấu hình (${cash.UNVERIFIED})`,
    );
  } else {
    try {
      measured = await cash.measure(lease.db, day);
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.err(
        `[warn] không đo được tỷ lệ thực nhận từ settlement (${dbMsg(e)}) — dùng mặc định (${cash.UNVERIFIED})`,
      );
    } finally {
      await lease.release().catch(() => {});
    }
  }
  let fc: cash.CashForecast;
  try {
    fc = cash.run(measured, day, opening, inp);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[err] ${pyTypeName(e)}: ${e.message}`);
    return 1;
  }
  io.out(o.json ? cash.toJson(fc) : cash.render(fc));
  if (o.outDir) {
    // docx P2 (finance-05.2, PL02 mục 1): ghi qua `writeReport` (cổng tắt + nhãn giai đoạn + sổ
    // `report_outputs`). Không đo được tỷ lệ thực nhận từ quyết toán thật (DB down/thiếu dữ liệu) →
    // cờ mẫu (không đếm).
    let p: string;
    try {
      p = await writeReport(
        cash.render(fc),
        o.outDir,
        `dong-tien-${day}.md`,
        Object.keys(measured).length === 0,
      );
    } catch (e) {
      if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
      throw e;
    }
    io.out(`[done] ${p}`);
  }
  return 0;
}

// ===================================================================== fp_opscost
export type FpOpscostOpts = {
  load?: string;
  report?: boolean;
  submitOverX?: boolean;
  status?: boolean;
  month?: string;
};

function printErrs(io: Io, errs: string[]): void {
  for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
  if (errs.length > MAX_PRINT_ERRS) io.out(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
  io.out(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
}

/** `python -m agents.fp_opscost` → 0 ok/skip · 1 file/cấu hình/DB lỗi · 2 tham số sai / DB down. */
export async function fpOpscostMain(o: FpOpscostOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = usageOf(io, 'fp_opscost');
  const nOps = [o.load !== undefined, o.report, o.submitOverX, o.status].filter(Boolean).length;
  if (nOps > 1) {
    return usage('chỉ 1 thao tác mỗi lần (--load | --report | --submit-over-x | --status)');
  }
  if (nOps === 0) return usage('cần --load | --report | --submit-over-x | --status');
  let month = '';
  if (o.load !== undefined) {
    if (o.month) return usage('--month không dùng với --load (tháng nằm trong file)');
  } else {
    const m = parseMonth(o.month);
    if (m === null) return usage('cần --month YYYY-MM (tháng 01..12)');
    month = m;
  }
  const [cfg, why] = ops.loadCfg(d.fpaConfig ?? FPA_CONFIG_FILE);
  if (cfg === null) {
    io.out(`[err] ${why} — không connect.`);
    return 1;
  }
  let dcfg: DirectorConfig | undefined;
  if (o.submitOverX) {
    try {
      dcfg = d.dcfg ?? loadDirectorConfig('finance', d.directorsDir);
    } catch (e) {
      if (!(e instanceof DirectorConfigError)) throw e;
      io.out(`[err] cấu hình khối finance: ${e.message} — không connect.`);
      return 1;
    }
  }
  let entries: ops.OpexRow[] = [];
  let sha = '';
  if (o.load !== undefined) {
    const [es, errs, s] = await ops.readOpex(o.load);
    if (errs.length) {
      printErrs(io, errs);
      return 1;
    }
    entries = es;
    sha = s as string;
  }

  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  const db = lease.db;
  const users = () => loadUsers(d.usersFile, d.env);
  try {
    if (o.load !== undefined) {
      const { rows } = await db.query('select 1 from opex_entries where file_sha256 = $1 limit 1', [
        sha,
      ]);
      if (rows.length) {
        io.out('[skip] file chi phí đã nạp — không ghi gì.');
        return 0;
      }
      const n = await ops.load(db, entries, basename(o.load), sha);
      io.out(`[load] ${n} dòng chi phí từ ${clean(basename(o.load), 80)}`);
      return 0;
    }
    if (o.submitOverX) {
      const [done, blk] = await ops.submitOverX(db, month, cfg, users(), dcfg);
      for (const [eid, qid] of done) {
        io.out(`[submit] khoản #${eid} → mục hàng duyệt #${qid} (opex_over_x, CHỜ TGĐ KÝ)`);
      }
      for (const eid of blk) io.out(`[chặn] khoản #${eid}: ${ops.WHY.bi_chan}`);
      io.out(`[submit] ${done.length} mục mới — agent không chi, không tắt key, không đổi limit.`);
      return 0;
    }
    const s = await ops.summary(db, month, cfg, users());
    if (o.report) {
      io.out(ops.renderReport(month, s.actuals, cfg, s.alerts, s.over));
      return 0;
    }
    io.out(
      `[status] khoản > ngưỡng X ${vnd(cfg.threshold_x_vnd)} tháng ${fmtDay(month, '%m/%Y')}:`,
    );
    for (const [e, st] of s.over) {
      io.out(
        `  khoản #${e.id} ${e.category}/${e.service} ${vnd(e.amount_vnd)}: ${st} — ${ops.WHY[s.why[String(e.id)] as string]}`,
      );
    }
    if (!s.over.length) io.out('  (không có)');
    return 0;
  } catch (e) {
    if (isDbError(e) && (e as { code?: string }).code === '23505') {
      const cname = (e as { constraint?: string }).constraint ?? '';
      if (o.load !== undefined && cname.includes('file_sha256')) {
        io.out('[skip] file vừa được nạp song song — không ghi gì.');
        return 0;
      }
      if (o.submitOverX && cname === 'approval_queue_pending_uq') {
        io.out('[skip] mục chờ TGĐ ký vừa được tạo song song — chạy lại để đẩy các khoản còn lại.');
        return 0;
      }
      io.err(`[error] UniqueViolation: ${dbMsg(e)}`);
      return 1;
    }
    // Python bắt (psycopg.Error, ValueError, OSError): RolloutBlocked (cổng tắt ở `enqueue`) là
    // ValueError → "[error] RolloutBlocked: RolloutBlocked", exit 1, không ghi gì.
    if (isFsError(e)) {
      io.err(`[error] ${pyOsName(e)}: ${pyOsName(e)}`);
      return 1;
    }
    if (isDbError(e)) {
      io.err(`[error] ${pyTypeName(e)}: ${dbMsg(e)}`);
      return 1;
    }
    if (e instanceof RangeError) {
      io.err(`[error] ${pyTypeName(e)}: ${pyTypeName(e)}`);
      return 1;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== nest-commander

@Command({
  name: 'scenario',
  description: 'Kịch bản mùa thấp/cơ sở/cao theo SKU × kênh × tuần (python -m pipelines.scenario)',
})
export class ScenarioCommand extends CommandRunner {
  async run(_args: string[], o: ScenarioOpts): Promise<void> {
    process.exitCode = await scenarioMain(o);
  }
  @Option({ flags: '--sku <sku>', description: 'sku_key trong golden' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <kenh>' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--weeks <n>', description: 'số tuần 1..104 (mặc định 13)' })
  parseWeeks(v: string): string {
    return v;
  }
  @Option({
    flags: '--start <date>',
    description: 'ngày bắt đầu (mặc định hôm nay giờ VN; tính theo thứ Hai)',
  })
  parseStart(v: string): string {
    return v;
  }
  @Option({ flags: '--json' })
  parseJson(): boolean {
    return true;
  }
  @Option({ flags: '--out-dir <dir>', description: 'ghi kich-ban-<sku>-<kênh>-<ngày>.md' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'fp-cash',
  description: 'FP-Cash: dòng tiền 13 tuần × thấp/cơ sở/cao trên scenario.project()',
})
export class FpCashCommand extends CommandRunner {
  async run(_args: string[], o: FpCashOpts): Promise<void> {
    process.exitCode = await fpCashMain(o);
  }
  @Option({ flags: '--forecast' })
  parseForecast(): boolean {
    return true;
  }
  @Option({
    flags: '--start <date>',
    description: 'ngày bắt đầu YYYY-MM-DD (mặc định hôm nay VN; làm tròn về thứ Hai)',
  })
  parseStart(v: string): string {
    return v;
  }
  @Option({ flags: '--opening <vnd>', description: 'số dư tiền đầu kỳ VND (thật — nếu có)' })
  parseOpening(v: string): string {
    return v;
  }
  @Option({ flags: '--json' })
  parseJson(): boolean {
    return true;
  }
  @Option({ flags: '--out-dir <dir>', description: 'ghi dong-tien-<ngày>.md qua writeReport' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'fp-opscost',
  description:
    'FP-OpsCost: chi phí AI + cloud/SaaS so trần tháng; khoản > ngưỡng X chờ TGĐ ký (agent chỉ cảnh báo)',
})
export class FpOpscostCommand extends CommandRunner {
  async run(_args: string[], o: FpOpscostOpts): Promise<void> {
    process.exitCode = await fpOpscostMain(o);
  }
  @Option({ flags: '--load <file>' })
  parseLoad(v: string): string {
    return v;
  }
  @Option({ flags: '--report' })
  parseReport(): boolean {
    return true;
  }
  @Option({ flags: '--submit-over-x' })
  parseSubmitOverX(): boolean {
    return true;
  }
  @Option({ flags: '--status' })
  parseStatus(): boolean {
    return true;
  }
  @Option({ flags: '--month <yyyy-mm>' })
  parseMonth(v: string): string {
    return v;
  }
}
