import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  createPool,
  databaseUrl,
  type Service,
  ServiceBindError,
  servicePool,
} from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { jobRun } from '@samsam/core/ops/job-runs';
import { pyInt } from '@samsam/core/ops/py';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { connErrName, isDbError, pgErrName } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { EXIT_BLOCKED, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import type pg from 'pg';
import { clean, MAX_PRINT_ERRS, safe } from '../intel_import/table.js';
import { parseNow } from '../ra_kenh/ra-kenh.js';
import {
  CONFIG_FILE,
  ConfigError,
  fetch as fetchRows,
  loadConfig,
  NO_DATA,
  NOT_SET,
  opsFee,
  quarterRange,
  record,
  renderQuarter,
  renderYear,
  summarize,
  yearRange,
} from './rev-share.js';
import {
  CHANNELS,
  crossSource,
  type Fees,
  type Io,
  LockError,
  load,
  loadFees,
  loadMapping,
  lockOrders,
  overlaps,
  readSettlement,
  reconcile,
  report,
  type SettleRow,
  STD_IO,
  vnd,
} from './settlement-csv.js';

// Lệnh CLI thay `python -m ingest.settlement_csv` và `python -m agents.rev_share` — cùng cờ, exit code,
// thông điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ nối.
// Kiểm tham số ở đây (lỗi ném trong hàm parse của nest-commander thoát 0).
// Quyết toán qua API sàn (`ingest.settlement_api`) chạy trong lệnh `market-api --kind settlement` của
// nhóm market — xem `settlement-api.ts` (`parseWindow`/`precheck`/`run`).

const usageOf =
  (prog: string, io: Io) =>
  (msg: string): number => {
    io.err(`${prog}: error: ${msg}`);
    return 2;
  };

// ===================================================================== settlement-csv

export type SettlementCsvOpts = {
  file?: string;
  channel?: string;
  reconcile?: boolean;
  report?: boolean;
};

export type SettlementCsvDeps = {
  env?: Env;
  io?: Io;
  mapFile?: string;
  feesFile?: string;
  /** Python `auth.bind_service('loader')` — mặc định `servicePool` (pool riêng, lệnh tự `end()`). */
  service?: (svc: Service, env: Env) => Promise<pg.Pool>;
};

function printErrs(io: Io, errs: readonly string[]): void {
  for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
  if (errs.length > MAX_PRINT_ERRS) io.out(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
  io.out(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
}

/**
 * `python -m ingest.settlement_csv` — `--file F --channel K` | `--reconcile` | `--report`. Exit 0 ok
 * · 1 file/cấu hình/DB lỗi · 2 tham số sai / bị chặn (đơn đã có dòng từ API sàn; finance-01 TẮT →
 * dòng ĐÃ nạp, KHÔNG đối soát — chặn một phần).
 */
export async function settlementCsvMain(
  o: SettlementCsvOpts,
  d: SettlementCsvDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = usageOf('settlement_csv', io);
  if (o.channel !== undefined && !(CHANNELS as readonly string[]).includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: '${o.channel}' (choose from 'shopee', 'tiktok')`,
    );
  }
  const nOps = [o.file !== undefined, Boolean(o.reconcile), Boolean(o.report)].filter(
    Boolean,
  ).length;
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--file | --reconcile | --report)');
  if (nOps === 0) return usage('cần --file ... | --reconcile | --report');
  if ((o.file !== undefined) !== (o.channel !== undefined)) {
    return usage('--channel chỉ dùng và bắt buộc với --file');
  }

  let fees: Fees | null = null;
  let rows: SettleRow[] = [];
  let sha = '';
  if (!o.report) {
    const [f, why] = d.feesFile ? loadFees(d.feesFile) : loadFees();
    if (f === null) {
      io.out(`[err] ${why} — không connect.`);
      return 1;
    }
    fees = f;
  }
  if (o.file !== undefined) {
    const [mapping, why] = d.mapFile ? loadMapping(d.mapFile) : loadMapping();
    if (mapping === null) {
      io.out(`[err] ${why} — không connect.`);
      return 1;
    }
    const [rs, errs, s] = await readSettlement(o.file, o.channel as string, mapping);
    if (errs.length) {
      printErrs(io, errs);
      return 1;
    }
    rows = rs;
    sha = s as string;
  }

  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối login
  // superuser/owner/thiếu biến.
  let pool: pg.Pool;
  try {
    pool = await (d.service ?? servicePool)('loader', env);
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    if (approvalEnforced(env)) {
      io.out(`[err] ${e.message}`);
      return 2;
    }
    io.out('[err] thiếu DATABASE_URL trong .env');
    return 1;
  }
  let c: pg.PoolClient;
  try {
    c = await pool.connect();
  } catch (e) {
    await pool.end().catch(() => {});
    io.out(`[err] không kết nối được Postgres: ${connErrName(e)}`);
    return 1;
  }
  let n = 0;
  let rc = 0;
  let counts: Record<string, number> = {};
  let ov: { trung: number; lech: number; files: string[] } | undefined;
  const channel = o.channel as string;
  try {
    await c.query('begin');
    if (o.report) {
      await report(c, io);
      return 0;
    }
    if (o.reconcile) {
      try {
        counts = await reconcile(c, fees as Fees);
      } catch (e) {
        if (!(e instanceof RolloutBlocked)) throw e;
        await c.query('rollback');
        io.out(`[blocked] ${e.message} — không đối soát.`);
        return 2;
      }
      await c.query('commit');
      io.out(
        `[reconcile] ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`,
      );
      return 0;
    }
    const hashes = new Set(rows.map((r) => r.order_id_hash));
    try {
      await lockOrders(c, channel, hashes);
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      await c.query('rollback');
      io.out(`[err] ${e.message} — 0 dòng.`);
      return 1;
    }
    if (
      (await c.query('select 1 from settlement_rows where file_sha256 = $1 limit 1', [sha])).rows
        .length
    ) {
      await c.query('rollback'); // nhả khóa
      io.out('[skip] file quyết toán đã nạp — không ghi gì.');
      return 0;
    }
    const nCross = await crossSource(c, channel, hashes, 'csv');
    if (nCross) {
      await c.query('rollback');
      io.out(
        `[blocked] ${nCross} đơn đã có dòng quyết toán từ API sàn — không ` +
          'ghi chồng; người đối soát quyết. 0 dòng.',
      );
      return 2;
    }
    n = await load(c, rows, channel, basename(o.file as string), sha);
    try {
      counts = await reconcile(c, fees as Fees, sha);
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      // chỉ nạp, không đối soát — chặn MỘT PHẦN (r12 RB)
      io.out(`[blocked] ${e.message} — đã nạp dòng quyết toán, KHÔNG đối soát.`);
      counts = {};
      rc = EXIT_BLOCKED;
    }
    ov = (await overlaps(c, [channel]))[channel];
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (!isDbError(e)) throw e;
    const name = pgErrName(e);
    if (
      name === 'UniqueViolation' &&
      ((e as pg.DatabaseError).constraint ?? '').includes('file_sha256')
    ) {
      io.out('[skip] file vừa được nạp song song — không ghi gì.');
      return 0;
    }
    if (name === 'UndefinedTable') {
      io.out(
        '[err] thiếu bảng settlement_rows/recon_results/market_rows — ' +
          'chạy `python scripts/apply_schema.py` trước.',
      );
      return 1;
    }
    io.out(`[err] lỗi DB, đã rollback: ${name}`);
    return 1;
  } finally {
    // như Python conn.close(): giao dịch chưa commit (nhánh --report / trả sớm) bị hủy
    await c.query('rollback').catch(() => {});
    c.release();
    await pool.end().catch(() => {});
  }
  io.out(
    `[load] quyết toán ${channel} ${clean(basename(o.file as string), 80)}: ` +
      `${n} dòng; đối chiếu: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
  );
  if (ov) {
    io.out(
      `[warn] khoản xuất lại ở ≥2 file (chồng kỳ): trùng ${ov.trung}, lệch ${ov.lech} — ` +
        ov.files
          .slice(0, 20)
          .map((f) => safe(f, 80))
          .join(', ') +
        '. Trùng nguyên văn tính 1 lần; lệch giữ cả hai → đối soát' +
        ' quý BẤT THƯỜNG, không tính phí tới khi người đối soát xử' +
        ' lý.',
    );
  }
  if (counts.thieu_chung_tu) {
    io.out(
      `[warn] ${counts.thieu_chung_tu} dòng chưa thấy đơn sàn — ` +
        'nạp file đơn (`python -m ingest.market_csv --kind order`) rồi' +
        ' chạy `--reconcile`.',
    );
  }
  io.out('[done]');
  return rc;
}

@Command({
  name: 'settlement-csv',
  description: 'ACC-Recon: nạp file quyết toán sàn + đối soát (chỉ báo cáo, không bút toán).',
})
export class SettlementCsvCommand extends CommandRunner {
  async run(_args: string[], opts: SettlementCsvOpts): Promise<void> {
    process.exitCode = await settlementCsvMain(opts);
  }
  @Option({ flags: '--file <file>', description: 'file .csv / .xlsx quyết toán' })
  parseFile(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <channel>', description: 'shopee | tiktok (bắt buộc với --file)' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--reconcile', description: 'đối chiếu lại MỌI dòng đã nạp (file đơn tới sau)' })
  parseReconcile(): boolean {
    return true;
  }
  @Option({ flags: '--report', description: 'báo cáo theo kênh (không mã đơn/người mua)' })
  parseReport(): boolean {
    return true;
  }
}

// ===================================================================== rev-share

export type RevShareOpts = {
  quarter?: string;
  year?: string;
  now?: string;
  outDir?: string;
  record?: boolean;
  dryRun?: boolean;
};

export type RevShareDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<pg.Pool | null>;
  /** Mốc "bây giờ" khi không có `--now` (Python `main(argv, now)`). */
  now?: Date;
  configFile?: string;
  /** Nối cổng triển khai (báo cáo) trên pool của lệnh — mặc định `wireCore`. */
  wire?: (db: Db) => void;
};

async function connectDatabaseUrl(env: Env): Promise<pg.Pool | null> {
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(databaseUrl(env), {}, env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  return pool;
}

const money = (v: bigint | null): string => (v === null ? NO_DATA : vnd(v));

/**
 * `python -m agents.rev_share --quarter YYYY-Qn [--record | --dry-run]` | `--year N [--dry-run]`.
 * Exit 0 ok (kể cả thiếu dữ liệu) · 1 cấu hình hỏng / chưa chốt ngày ký (--year) · 2 tham số sai /
 * kỳ chưa đóng / trước ngày vận hành / DB down / lỗi DB / tính năng tắt.
 */
export async function revShareMain(o: RevShareOpts, d: RevShareDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = usageOf('rev_share', io);
  let year: number | null = null;
  if (o.year !== undefined) {
    const y = pyInt(o.year);
    if (y === null) return usage(`argument --year: invalid int value: '${o.year}'`);
    year = Number(y);
  }
  if ((o.quarter === undefined) === (year === null))
    return usage('cần đúng 1 trong --quarter | --year');
  if (o.record && o.dryRun) return usage('--record và --dry-run loại trừ nhau');
  if (o.record && year !== null) return usage('--record chỉ dùng với --quarter');
  let now: Date;
  try {
    now = o.now ? parseNow(o.now) : (d.now ?? new Date());
  } catch {
    return usage('--now sai định dạng ISO');
  }
  const cfgPath = d.configFile ?? CONFIG_FILE;
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig(cfgPath);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`[error] ${e.message} — không connect.`);
    return 1;
  }
  if (year !== null && cfg.sign === null) {
    io.err(
      `[error] ${NOT_SET} ngay_ky_hop_dong trong ${basename(cfgPath)} — năm hợp tác tính từ ngày ký` +
        ' hợp đồng (không dùng ngày vận hành/ngày dự kiến).',
    );
    return 1;
  }
  let label: string;
  let start: string;
  let end: string;
  try {
    if (o.quarter !== undefined) {
      label = o.quarter;
      [start, end] = quarterRange(o.quarter, now, cfg.start);
    } else {
      label = `nam-${year}`;
      [start, end] = yearRange(cfg.sign as string, year, now);
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message}`);
    return 2;
  }
  const pool = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (pool === null) {
    io.err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  let path: string | null = null;
  let rid: string | null = null;
  let net: bigint | null = null;
  let nNotes = 0;
  let c: pg.PoolClient | null = null;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(pool);
    c = await pool.connect();
    await c.query(o.record ? 'begin' : 'begin transaction read only');
    const [rows, undated] = await fetchRows(c, start, end, cfg.channels);
    const s = summarize(
      rows,
      cfg.channels,
      cfg.fee_cols,
      await overlaps(c, cfg.channels, start, end),
    );
    let text: string;
    let fee: bigint | null = null;
    if (o.quarter !== undefined) {
      const [f, why] = opsFee(s.total.net, cfg.rate, cfg.start, s.anomaly);
      fee = f;
      text = renderQuarter(label, start, end, s, undated, cfg, f, why, now);
    } else {
      text = renderYear(year as number, start, end, s, undated, cfg, now);
    }
    if (o.dryRun) {
      io.out(text);
      return 0;
    }
    // P8.4: quyết toán thật (rev_share không nhận file mẫu; settlement_rows không có đường mẫu).
    path = await writeReport(text, o.outDir ?? REPORTS_DIR, `doi-soat-${label}.md`, false);
    if (o.record) {
      // r12 F06-6: sha của ĐÚNG byte trên đĩa (writeReport có thể gắn nhãn giai đoạn).
      rid = await record(c, label, start, end, s, cfg.rate, fee, readFileSync(path, 'utf8'), cfg);
    }
    net = s.total.net;
    nNotes = s.notes.length;
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      io.err(`[blocked] ${e.message}`);
      return 2;
    }
    if (isDbError(e)) {
      io.err(`[error] lỗi DB: ${pgErrName(e)}`);
      return 2;
    }
    throw e;
  } finally {
    await c?.query('rollback').catch(() => {});
    c?.release();
    await pool.end().catch(() => {});
  }
  io.out(
    `[done] ${path} — ${label}: thuần ${money(net)}, ${nNotes} ghi chú` +
      (rid ? ` · revenue_quarters #${rid}` : ' · không ghi sổ'),
  );
  return 0;
}

@Command({
  name: 'rev-share',
  description:
    'Doanh thu thuần trực tuyến + biên bản đối soát quý (CHỈ ĐỌC; ghi duy nhất revenue_quarters khi --record)',
})
export class RevShareCommand extends CommandRunner {
  async run(_args: string[], opts: RevShareOpts): Promise<void> {
    // Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2) — như `__main__` của Python.
    process.exitCode = await jobRun('agents.rev_share', async (run) => {
      const rc = await revShareMain(opts);
      run.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--quarter <q>', description: 'YYYY-Qn' })
  parseQuarter(v: string): string {
    return v;
  }
  @Option({ flags: '--year <n>', description: 'năm hợp tác thứ N (1-based)' })
  parseYear(v: string): string {
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
