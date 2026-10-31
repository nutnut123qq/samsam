import { readFileSync } from 'node:fs';
import {
  createPool,
  DbConfigError,
  ServiceBindError,
  serviceDsn,
  servicePool,
} from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, vnDate } from '@samsam/core/ops/period';
import { isPrintable } from '@samsam/core/ops/py';
import { writeReport } from '@samsam/core/ops/report';
import { connErrName, isDbError, pgErrName } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import {
  blocked,
  decideReason,
  EXIT_BLOCKED,
  RolloutBlocked,
  sayBlocked,
} from '@samsam/core/rollout/rollout';
import {
  callHuman,
  cliGate,
  cliIdentity,
  HumanDenied,
  HumanError,
} from '@samsam/core/security/auth';
import { cpHead, cpLen, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner } from 'nest-commander';
import type pg from 'pg';
import {
  ASSUMPTIONS_FILE,
  type Assumptions,
  DATE_MAX,
  DATE_MIN,
  GOLDEN_FILE,
  loadAssumptions,
  ScenarioError,
  weekStart,
} from '../garden_director/scenario.js';
import { clean } from '../market/table.js';
import {
  currentStock,
  fileLabel,
  type GoldenMap,
  goldenMap,
  SOURCES as INV_SOURCES,
  isoDay,
  load as loadInventory,
  MAX_PRINT_ERRS,
  pyOsName,
  readInventory,
  STALE_NOTE,
} from './inventory-csv.js';
import {
  CertError,
  certDir,
  record as recordCert,
  sniff,
  verify as verifyCerts,
} from './lot-certs.js';
import {
  BUILDABLE_NOTE,
  type BulletinData,
  buildable,
  CONFIG_FILE,
  type Cutoff,
  checkBom,
  cmpCp,
  type Demands,
  DISCLAIMER,
  demandFor,
  FEATURE_ALLOC,
  FEATURE_NEAR,
  LOT_RE,
  LOT_RE_SRC,
  loadConfig,
  MAX_BY_LEN,
  MAX_NOTE_LEN,
  NO_NEW_PRODUCTION,
  type PlanRow,
  type ProductionConfig,
  ProductionError,
  planRows,
  RUN_RE,
  readJson,
  renderBulletin,
  runIdFor,
  splitFefo,
  validateLots,
} from './production.js';
import {
  type Combo,
  collect,
  dbCombos,
  decideRun,
  intake,
  type LotIn,
  loadBom,
  loadLots,
  saveProposals,
  stripMeta,
} from './production.service.js';

// Lệnh CLI thay `python -m pipelines.production` (lệnh con allocate/approve/reject/bom/lots/intake/
// cert/plan-add/plan-link/cert-verify/bulletin) và `python -m ingest.inventory_csv` — cùng cờ, exit
// code, thông điệp chính. `productionMain(argv)`/`inventoryCsvMain(argv)` nhận argv thô như Python
// `main(argv)` (bộ phân tích kiểu argparse bên dưới: lệnh con, `--x=v`, viết tắt tiền tố duy nhất,
// nhóm loại trừ, lỗi → `error:` exit 2 TRƯỚC mọi kết nối). Exit: 0 OK / [skip]; 1 dữ liệu/DB lỗi /
// bị chặn khi ghi; 2 sai usage / bản tin bị cổng tắt chặn / loader bị từ chối.
// DB: `DATABASE_URL` như Python `_open()` (lệnh người chạy bằng login của người đó — runbook mục 9);
// job lịch `production_week`/`production_month` chạy bằng login `svc_job` (job runner đặt
// DATABASE_URL); `inventory-csv` bằng login dịch vụ `loader` (Python `auth.bind_service`).

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type Lease = { pool: pg.Pool; release: () => Promise<void> };

export type ProdDeps = {
  env?: Env;
  io?: Io;
  /** Python `_open()` (DATABASE_URL) → lease | null (đã in [err]). */
  connect?: (env: Env, io: Io) => Promise<Lease | null>;
  /** Nối core (guardrail/cổng triển khai/báo cáo) trên pool của lệnh — mặc định `wireCore`. */
  wire?: (db: Db) => void;
  now?: () => Date;
  configFile?: string;
  goldenFile?: string;
  assumptionsFile?: string;
};

// ===================================================================== argparse tối thiểu

type Parsed = Record<string, unknown>;
type OptSpec = {
  flag: string;
  dest?: string;
  flagOnly?: boolean;
  required?: boolean;
  /** Python `type=`: ném ArgError(thông điệp) khi sai. */
  type?: (s: string) => unknown;
  choices?: readonly string[];
  def?: unknown;
};
type SubSpec = { opts: OptSpec[]; mutex?: { flags: string[]; required: boolean } };

class ArgError extends Error {}

const destOf = (o: OptSpec) => o.dest ?? o.flag.replace(/^--/, '').replaceAll('-', '_');
const NEG_NUM = /^-\d+$|^-\d*\.\d+$/;
const looksOpt = (t: string) => t.startsWith('-') && t !== '-' && !NEG_NUM.test(t);
const pyRepr = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** argparse của 1 lệnh con → giá trị theo `dest` (mặc định đã điền). */
function parseSub(spec: SubSpec, argv: string[]): Parsed {
  const out: Parsed = {};
  for (const o of spec.opts) out[destOf(o)] = o.flagOnly ? false : (o.def ?? null);
  const seen = new Set<string>();
  const extras: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok === '--') {
      extras.push(...argv.slice(i + 1));
      break;
    }
    if (!looksOpt(tok)) {
      extras.push(tok);
      continue;
    }
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    let o = spec.opts.find((x) => x.flag === name);
    if (!o && name.startsWith('--') && name.length > 2) {
      const cands = spec.opts.filter((x) => x.flag.startsWith(name));
      if (cands.length > 1) {
        throw new ArgError(
          `ambiguous option: ${name} could match ${cands.map((x) => x.flag).join(', ')}`,
        );
      }
      o = cands[0];
    }
    if (!o) {
      extras.push(tok);
      continue;
    }
    const arg = `argument ${o.flag}`;
    if (spec.mutex?.flags.includes(o.flag)) {
      const other = spec.mutex.flags.find((f) => f !== o?.flag && seen.has(f));
      if (other) throw new ArgError(`${arg}: not allowed with argument ${other}`);
    }
    seen.add(o.flag);
    if (o.flagOnly) {
      if (eq >= 0)
        throw new ArgError(`${arg}: ignored explicit argument ${pyRepr(tok.slice(eq + 1))}`);
      out[destOf(o)] = true;
      continue;
    }
    let v: string;
    if (eq >= 0) v = tok.slice(eq + 1);
    else {
      const nxt = argv[i + 1];
      if (nxt === undefined || looksOpt(nxt)) throw new ArgError(`${arg}: expected one argument`);
      v = nxt;
      i++;
    }
    if (o.choices && !o.choices.includes(v)) {
      throw new ArgError(
        `${arg}: invalid choice: ${pyRepr(v)} (choose from ${o.choices.map(pyRepr).join(', ')})`,
      );
    }
    try {
      out[destOf(o)] = o.type ? o.type(v) : v;
    } catch (e) {
      if (e instanceof ArgError) throw new ArgError(`${arg}: ${e.message}`);
      throw e;
    }
  }
  const req = spec.opts.filter((o) => o.required && !seen.has(o.flag)).map((o) => o.flag);
  if (req.length) throw new ArgError(`the following arguments are required: ${req.join(', ')}`);
  if (spec.mutex?.required && !spec.mutex.flags.some((f) => seen.has(f))) {
    throw new ArgError(`one of the arguments ${spec.mutex.flags.join(' ')} is required`);
  }
  if (extras.length) throw new ArgError(`unrecognized arguments: ${extras.join(' ')}`);
  return out;
}

// ---- kiểu tham số (Python `_date_arg/_by_arg/_note_arg/_run_arg/_lot_arg`)

function dateArg(s: string): string {
  const d = isoDay(s);
  if (d === null || d < DATE_MIN || d > DATE_MAX) {
    throw new ArgError(`ngày YYYY-MM-DD trong ${DATE_MIN}..${DATE_MAX}`);
  }
  return d;
}
function byArg(s: string): string {
  const v = pyStrip(s);
  if (!v || cpLen(v) > MAX_BY_LEN || !isPrintable(v)) {
    throw new ArgError(`tên người không rỗng, tối đa ${MAX_BY_LEN} ký tự in được`);
  }
  return v;
}
function noteArg(s: string): string {
  const v = pyStrip(s);
  if (cpLen(v) > MAX_NOTE_LEN || !isPrintable(v)) {
    throw new ArgError(`note tối đa ${MAX_NOTE_LEN} ký tự in được`);
  }
  return v;
}
function runArg(s: string): string {
  if (!RUN_RE.test(s)) throw new ArgError('run_id là 12 ký tự hex');
  return s;
}
function lotArg(s: string): string {
  if (!LOT_RE.test(s)) throw new ArgError(`mã lô phải khớp ${LOT_RE_SRC}`);
  return s;
}
function intArg(s: string): number {
  // Python int(): khoảng trắng 2 đầu, dấu, '_' giữa chữ số.
  const t = pyStrip(s);
  if (!/^[+-]?\d+(?:_\d+)*$/.test(t)) throw new ArgError(`invalid int value: ${pyRepr(s)}`);
  return Number(t.replaceAll('_', ''));
}

const BY: OptSpec = { flag: '--by', required: true, type: byArg };
const NOTE: OptSpec = { flag: '--note', type: noteArg };
const SOURCE: OptSpec = { flag: '--source', choices: ['manual', 'sample'], def: 'manual' };
const SUBS: Record<string, SubSpec> = {
  allocate: {
    opts: [
      { flag: '--cutoff', required: true },
      { flag: '--start', type: dateArg },
    ],
  },
  approve: { opts: [{ flag: '--run', required: true, type: runArg }, BY, NOTE] },
  reject: { opts: [{ flag: '--run', required: true, type: runArg }, BY, NOTE] },
  bom: {
    opts: [{ flag: '--load' }, { flag: '--check', flagOnly: true }, SOURCE],
    mutex: { flags: ['--load', '--check'], required: true },
  },
  lots: { opts: [{ flag: '--load', required: true }, SOURCE] },
  intake: {
    opts: [
      { flag: '--lot', required: true, type: lotArg },
      { flag: '--result', required: true, choices: ['passed', 'failed'] },
      BY,
      NOTE,
    ],
  },
  cert: {
    opts: [
      { flag: '--lot', required: true, type: lotArg },
      { flag: '--file', required: true },
      { flag: '--cert-no', required: true },
      { flag: '--lab' },
      { flag: '--issued', type: dateArg },
      NOTE,
      BY,
    ],
  },
  'plan-add': {
    opts: [
      { flag: '--code', required: true, type: lotArg },
      { flag: '--sku', required: true },
      { flag: '--qty', required: true, type: intArg },
      { flag: '--start', required: true, type: dateArg },
      { flag: '--due', required: true, type: dateArg },
      NOTE,
      { flag: '--sample', flagOnly: true },
      BY,
    ],
  },
  'plan-link': {
    opts: [
      { flag: '--plan', required: true, type: lotArg },
      { flag: '--lot', required: true, type: lotArg },
      BY,
    ],
  },
  'cert-verify': { opts: [{ flag: '--lot', type: lotArg }] },
  bulletin: {
    opts: [
      { flag: '--date', type: dateArg },
      { flag: '--period', choices: ['week', 'month'], def: 'week' },
      { flag: '--out-dir' },
    ],
  },
};
const PROG = 'production';

/** → [lệnh, tham số] | exit code (đã in lỗi usage ra stderr). */
function parseArgs(argv: string[], io: Io): [string, Parsed] | number {
  const cmds = Object.keys(SUBS);
  const usage = (where: string, msg: string) => {
    io.err(`usage: ${where} [-h] ...`);
    io.err(`${where}: error: ${msg}`);
    return 2;
  };
  const first = argv[0];
  if (first === '-h' || first === '--help') {
    io.out(`usage: ${PROG} {${cmds.join(',')}} ...`);
    return 0;
  }
  if (first === undefined || looksOpt(first)) {
    return usage(PROG, 'the following arguments are required: cmd');
  }
  if (!Object.hasOwn(SUBS, first)) {
    return usage(
      PROG,
      `argument cmd: invalid choice: ${pyRepr(first)} (choose from ${cmds.map(pyRepr).join(', ')})`,
    );
  }
  const rest = argv.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    io.out(
      `usage: ${PROG} ${first} ${(SUBS[first] as SubSpec).opts.map((o) => `[${o.flag}]`).join(' ')}`,
    );
    return 0;
  }
  try {
    const a = parseSub(SUBS[first] as SubSpec, rest);
    if (first === 'bom' && a.check && a.source !== 'manual') {
      return usage(PROG, '--source chỉ dùng với bom --load');
    }
    return [first, a];
  } catch (e) {
    if (e instanceof ArgError) return usage(`${PROG} ${first}`, e.message);
    throw e;
  }
}

// ===================================================================== DB + tiện ích

/** Python `_open()`: DATABASE_URL → pool | null (đã in [err]). */
export async function openDatabaseUrl(env: Env, io: Io): Promise<Lease | null> {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    io.out('[err] thiếu DATABASE_URL trong .env');
    return null;
  }
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(dsn, {}, env);
    await pool.query('select 1');
  } catch (e) {
    await pool?.end().catch(() => {});
    io.out(
      `[err] không kết nối được Postgres: ${e instanceof DbConfigError ? e.message : connErrName(e)}`,
    );
    return null;
  }
  const p = pool;
  return { pool: p, release: () => p.end() };
}

type Ctx = { env: Env; io: Io; d: ProdDeps; now: () => Date };
const err = (io: Io, msg: string): number => {
  io.out(`[err] ${msg}`);
  return 1;
};
const rollback = (c: pg.ClientBase) => c.query('rollback').catch(() => {});

/** Python `_db_call`: chạy fn(client) trên 1 kết nối; lỗi DB → rollback + [err] exit 1. */
async function dbCall(x: Ctx, fn: (c: pg.PoolClient) => Promise<number>): Promise<number> {
  const lease = await (x.d.connect ?? openDatabaseUrl)(x.env, x.io);
  if (lease === null) return 1;
  try {
    (x.d.wire ?? ((db: Db) => void wireCore(db)))(lease.pool);
    const c = await lease.pool.connect();
    try {
      return await fn(c);
    } catch (e) {
      await rollback(c);
      if ((e as { code?: string }).code === '42P01') {
        return err(x.io, 'thiếu bảng — chạy `python scripts/apply_schema.py` trước.');
      }
      if (isDbError(e)) return err(x.io, `lỗi DB, đã rollback: ${pgErrName(e)}`);
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    if (isDbError(e)) return err(x.io, `lỗi DB, đã rollback: ${pgErrName(e)}`);
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
}

/** Python `_golden()` → [map, bytes thô, lý do]. */
function readGoldenFile(path: string): [GoldenMap | null, Buffer | null, string | null] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return [null, null, `không đọc được golden (${pyOsName(e)})`];
  }
  const [skus, why] = goldenMap(path);
  return [skus, raw, why];
}

const printLines = (io: Io, text: string) => {
  // Python print(text, end="") — text kết thúc bằng '\n'.
  if (text) io.out(text.endsWith('\n') ? text.slice(0, -1) : text);
};

// ===================================================================== lệnh con

async function cmdAllocate(x: Ctx, a: Parsed): Promise<number> {
  const { io } = x;
  const [golden, goldenRaw, why] = readGoldenFile(x.d.goldenFile ?? GOLDEN_FILE);
  if (golden === null) return err(io, `golden: ${why} — không connect.`);
  let cfg: ProductionConfig;
  let cutoff: Cutoff;
  let assume: Assumptions;
  let aRaw: Buffer;
  let start: string;
  const demands: Record<string, Demands> = {};
  try {
    cfg = loadConfig(x.d.configFile ?? CONFIG_FILE);
    const found = cfg.cutoffs.find((c) => c.id === a.cutoff);
    if (!found) {
      return err(
        io,
        `không có mốc '${a.cutoff}' trong config (${cfg.cutoffs.map((c) => c.id).join(', ')})`,
      );
    }
    cutoff = found;
    const af = x.d.assumptionsFile ?? ASSUMPTIONS_FILE;
    assume = loadAssumptions(af);
    aRaw = readFileSync(af);
    start = (a.start as string | null) ?? vnDate(x.now());
    for (const [k, s] of golden) demands[k] = demandFor(s, start, cutoff.covers_until, assume);
  } catch (e) {
    if (
      e instanceof ProductionError ||
      e instanceof ScenarioError ||
      (e as { code?: unknown })?.code !== undefined
    ) {
      return err(io, `${(e as Error).message} — không connect.`);
    }
    throw e;
  }
  const startWeek = weekStart(start);
  return dbCall(x, async (c) => {
    const stock = await currentStock(c);
    const rid = runIdFor(cutoff, startWeek, stock, assume.status, aRaw, goldenRaw as Buffer);
    const rows = planRows([...golden.values()], stock, demands);
    const old = Number(
      (await c.query('select count(*) as n from allocation_proposals where run_id = $1', [rid]))
        .rows[0]?.n,
    );
    let n = 0;
    if (!old) {
      await c.query('begin');
      try {
        n = await saveProposals(c, rid, cutoff, startWeek, rows);
      } catch (e) {
        if (!(e instanceof RolloutBlocked)) throw e;
        await rollback(c);
        return err(io, `${e.message} — không ghi.`);
      }
      await c.query('commit');
    }
    printPlan(io, rid, cutoff, startWeek, rows, assume.status, cfg, old, n);
    return 0;
  });
}

function printPlan(
  io: Io,
  rid: string,
  cutoff: Cutoff,
  startWeek: string,
  rows: PlanRow[],
  aStatus: string,
  cfg: ProductionConfig,
  old: number,
  n: number,
): void {
  io.out(`Giả định kịch bản: ${aStatus} · Cấu hình mốc: ${cfg.status}`);
  io.out(DISCLAIMER);
  if (rows.some((r) => r.sample)) {
    io.out("[MẪU] tồn kho từ dữ liệu mẫu (source='sample') — chưa phải số thật");
  }
  io.out(`Mốc ${cutoff.id} (${cutoff.date}, nhu cầu tới ${cutoff.covers_until}): ${cutoff.label}`);
  io.out(`${NO_NEW_PRODUCTION}. Tuần bắt đầu ${startWeek} · run ${rid}`);
  if (old) io.out(`[skip] run đã có (${old} dòng) — không ghi thêm.`);
  else {
    io.out(
      `[draft] ${n} dòng pending trong allocation_proposals — chờ duyệt: approve/reject --run ${rid} --by <tên>`,
    );
  }
  io.out('SKU | kênh | thấp | cơ sở | cao | đề xuất | ghi chú');
  for (const r of rows) {
    io.out(
      `${r.sku_key} | ${r.channel} | ${r.demand_low} | ${r.demand_base} | ${r.demand_high} | ${r.proposed_qty} | ${r.note ?? ''}`,
    );
  }
  const warn = new Map<string, [string | number, string]>();
  for (const r of rows) {
    if (r.flag) warn.set(r.sku_key, [r.stock_total === null ? 'chưa có' : r.stock_total, r.flag]);
  }
  io.out(`Cảnh báo thiếu (${warn.size} SKU):`);
  for (const k of [...warn.keys()].sort(cmpCp)) {
    const [st, flag] = warn.get(k) as [string | number, string];
    io.out(`- ${k}: tồn ${st} — ${flag}`);
  }
  const stale = [
    ...new Set(rows.flatMap((r) => r.stale.map((k) => JSON.stringify([r.sku_key, k])))),
  ]
    .map((s) => JSON.parse(s) as [string, string])
    .sort((p, q) => cmpCp(p[0], q[0]) || cmpCp(p[1], q[1]));
  if (stale.length) {
    io.out(
      `Cảnh báo ${STALE_NOTE} (${stale.length} SKU×kho — file kho mới nhất không có dòng này; hết hàng phải ghi qty 0):`,
    );
    for (const [sku, kho] of stale) io.out(`- ${sku} @ ${clean(kho, 80)}`);
  }
}

async function cmdDecide(x: Ctx, a: Parsed, decision: 'approved' | 'rejected'): Promise<number> {
  const run = a.run as string;
  const by = a.by as string;
  return dbCall(x, async (c) => {
    // v14.2: GĐ sản xuất được Bên B ủy quyền (cliGate) — `--by` tự khai không còn là danh tính ở
    // chế độ thực.
    let why = await cliGate(
      c,
      by,
      'production',
      decision === 'approved' ? 'approve' : 'reject',
      'allocation_run',
      run,
      { env: x.env, warn: x.io.err },
    );
    if (why) return err(x.io, `${why} — không ghi.`);
    if (decision === 'approved') {
      // v14.3 (HĐ 6.7): đề xuất của tính năng TẮT không được duyệt (kể cả run sinh trước khi tắt);
      // từ chối vẫn được (dọn hàng).
      why = await decideReason(c, FEATURE_ALLOC, `run phân bổ ${run}`);
      if (why) return err(x.io, `${why} — không ghi.`);
    }
    await c.query('begin');
    const [ok, msg] = await decideRun(c, run, decision, by, (a.note as string | null) ?? null);
    if (!ok) {
      await rollback(c);
      return err(x.io, `${msg} — không ghi.`);
    }
    await c.query('commit');
    x.io.out(
      `[done] ${msg} — người quyết định: ${by}. Không chuyển kho (thực hiện tay theo quyết định).`,
    );
    return 0;
  });
}

async function cmdBom(x: Ctx, a: Parsed): Promise<number> {
  const { io } = x;
  const [golden, , why] = readGoldenFile(x.d.goldenFile ?? GOLDEN_FILE);
  if (golden === null) return err(io, `golden: ${why} — không connect.`);
  if (a.load !== null) {
    let doc: Record<string, unknown>;
    try {
      doc = readJson(a.load as string, 'combos');
    } catch (e) {
      if (!(e instanceof ProductionError)) throw e;
      return err(io, `${e.message} — không connect, không nạp gì.`);
    }
    const errs = checkBom(doc.combos, golden);
    if (errs.length) {
      for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
      return err(io, `${errs.length} lỗi BOM — không connect, không nạp gì.`);
    }
    return dbCall(x, async (c) => {
      await c.query('begin');
      const [done, skipped] = await loadBom(c, doc.combos as Combo[], a.source as string);
      await c.query('commit');
      const tag = a.source === 'sample' ? ' [MẪU]' : '';
      io.out(
        `[load]${tag} ${done} combo ghi (items thay toàn bộ)` +
          (skipped ? `, ${skipped} combo manual giữ nguyên` : ''),
      );
      return 0;
    });
  }
  return dbCall(x, async (c) => {
    const combos = await dbCombos(c);
    if (!combos.length) {
      io.out('chưa có combo nào trong bom_combos — nạp bằng bom --load');
      return 0;
    }
    const errs = checkBom(stripMeta(combos), golden);
    const stock = new Map([...(await currentStock(c))].map(([k, v]) => [k, v.qty]));
    const sample = combos.some((cb) => cb._source === 'sample');
    io.out(
      `${sample ? '[MẪU] ' : ''}${combos.length} combo — số combo làm được ${BUILDABLE_NOTE}:`,
    );
    for (const cb of combos) {
      // Chuỗi đọc từ DB (không CHECK slug) → clean chặn mã điều khiển.
      const [n, miss] = buildable(cb.items, stock);
      const extra = miss.length ? ` (chưa có số tồn: ${clean(miss.join(', '), 300)})` : '';
      io.out(`- ${clean(cb.combo_key, 80)} [${clean(cb.channels.join(', '), 120)}]: ${n}${extra}`);
    }
    for (const e of errs) io.out(`[err] ${clean(e, 300)}`);
    if (errs.length) return err(io, `${errs.length} lỗi BOM theo golden hiện tại.`);
    io.out('[ok] BOM khớp luật kênh golden hiện tại.');
    return 0;
  });
}

async function cmdLots(x: Ctx, a: Parsed): Promise<number> {
  const { io } = x;
  const [golden, , why] = readGoldenFile(x.d.goldenFile ?? GOLDEN_FILE);
  if (golden === null) return err(io, `golden: ${why} — không connect.`);
  let doc: Record<string, unknown>;
  try {
    doc = readJson(a.load as string, 'lots');
  } catch (e) {
    if (!(e instanceof ProductionError)) throw e;
    return err(io, `${e.message} — không connect, không nạp gì.`);
  }
  const errs = validateLots(doc.lots, golden, vnDate(x.now()));
  if (errs.length) {
    for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
    return err(io, `${errs.length} lỗi hồ sơ lô — không connect, không nạp gì.`);
  }
  return dbCall(x, async (c) => {
    await c.query('begin');
    const [created, old] = await loadLots(c, doc.lots as LotIn[], a.source as string);
    await c.query('commit');
    const tag = a.source === 'sample' ? ' [MẪU]' : '';
    io.out(`[load]${tag} ${created} lô mới (pending — chờ người kiểm nhập)`);
    if (old) io.out(`[skip] ${old} lô đã có — không ghi đè.`);
    return 0;
  });
}

async function cmdIntake(x: Ctx, a: Parsed): Promise<number> {
  const lot = a.lot as string;
  const by = a.by as string;
  return dbCall(x, async (c) => {
    const why = await cliGate(c, by, 'production', 'intake', 'production_lot', lot, {
      env: x.env,
      warn: x.io.err,
    });
    if (why) return err(x.io, `${why} — không ghi.`);
    await c.query('begin');
    const [ok, msg] = await intake(
      c,
      lot,
      a.result as 'passed' | 'failed',
      by,
      (a.note as string | null) ?? null,
    );
    if (!ok) {
      await rollback(c);
      return err(x.io, `${msg} — không ghi.`);
    }
    await c.query('commit');
    x.io.out(`[done] ${msg} — người kiểm nhập: ${by}`);
    return 0;
  });
}

async function cmdCert(x: Ctx, a: Parsed): Promise<number> {
  const lot = a.lot as string;
  const by = a.by as string;
  try {
    certDir(x.env);
    sniff(a.file as string);
  } catch (e) {
    if (!(e instanceof CertError)) throw e;
    return err(x.io, `${e.message} — không ghi.`);
  }
  return dbCall(x, async (c) => {
    const why = await cliIdentity(c, by, 'production_lot', lot, {
      action: 'lot_cert_record',
      env: x.env,
    });
    if (why) return err(x.io, `${why} — không ghi.`);
    let ver: number;
    await c.query('begin');
    try {
      ver = await recordCert(c, lot, a.file as string, a.cert_no, by, {
        lab: (a.lab as string | null) ?? null,
        issued: (a.issued as string | null) ?? null,
        note: (a.note as string | null) ?? null,
        env: x.env,
      });
    } catch (e) {
      // Python bắt (CertError, HumanDenied, ValueError) — HumanError = ValueError của call_human.
      if (!(e instanceof RangeError)) throw e;
      await rollback(c);
      return err(x.io, `${e.message} — không ghi.`);
    }
    await c.query('commit');
    x.io.out(
      `[done] lô ${lot}: phiếu ${pyStrip(a.cert_no as string)} phiên bản ${ver} — người ghi: ${by}`,
    );
    return 0;
  });
}

/** Tên lớp lỗi như Python `type(e).__name__` ở `cmd_plan`. */
function pyErrName(e: unknown): string {
  if (e instanceof HumanDenied) return 'HumanDenied';
  if (e instanceof HumanError) return 'ValueError';
  return pgErrName(e);
}

async function cmdPlan(x: Ctx, cmd: string, a: Parsed): Promise<number> {
  if (cmd === 'plan-add' && ((a.qty as number) <= 0 || (a.due as string) < (a.start as string))) {
    return err(x.io, '--qty phải > 0 và --due ≥ --start — không ghi.');
  }
  const by = a.by as string;
  const action = cmd.replace('-', '_');
  const oid = (cmd === 'plan-add' ? a.code : a.plan) as string;
  return dbCall(x, async (c) => {
    const why = await cliIdentity(c, by, 'production_plan', oid, { action, env: x.env });
    if (why) return err(x.io, `${why} — không ghi.`);
    const [sql, prm] =
      cmd === 'plan-add'
        ? [
            'select production_plan_add_human($1, $2, $3, $4, $5, $6, $7, $8)',
            [a.code, a.sku, a.qty, a.start, a.due, a.note ?? null, Boolean(a.sample), by],
          ]
        : ['select production_plan_link_human($1, $2, $3)', [a.plan, a.lot, by]];
    await c.query('begin');
    try {
      await callHuman(c, sql, prm, {
        by,
        block: 'production',
        action,
        objectType: 'production_plan',
        objectId: oid,
        env: x.env,
      });
    } catch (e) {
      if (!(e instanceof HumanError || isDbError(e))) throw e;
      await rollback(c);
      return err(x.io, `${pyErrName(e)}: ${cpHead((e as Error).message, 200)} — không ghi.`);
    }
    await c.query('commit');
    x.io.out(`[done] ${cmd} ${oid} — người ghi: ${by}`);
    return 0;
  });
}

async function cmdCertVerify(x: Ctx, a: Parsed): Promise<number> {
  try {
    certDir(x.env);
  } catch (e) {
    if (!(e instanceof CertError)) throw e;
    return err(x.io, e.message);
  }
  return dbCall(x, async (c) => {
    const rows = await verifyCerts(c, null, (a.lot as string | null) ?? null, x.env);
    let bad = 0;
    for (const r of rows) {
      if (r.state !== 'ok') bad++;
      x.io.out(
        `[${r.state}] ${r.lot} (${r.intake})${r.version ? ` · ${r.cert_no} v${r.version}` : ''}`,
      );
    }
    x.io.out(`[done] ${rows.length} lô, ${bad} lô thiếu/lỗi phiếu`);
    return bad ? 1 : 0;
  });
}

async function cmdBulletin(x: Ctx, a: Parsed): Promise<number> {
  let cfg: ProductionConfig;
  try {
    cfg = loadConfig(x.d.configFile ?? CONFIG_FILE);
  } catch (e) {
    if (!(e instanceof ProductionError)) throw e;
    return err(x.io, `config: ${e.message} — không connect.`);
  }
  const [golden, , why] = readGoldenFile(x.d.goldenFile ?? GOLDEN_FILE);
  const day = (a.date as string | null) ?? vnDate(x.now());
  const period = a.period as string;
  return dbCall(x, async (c) => {
    // r12 G1-L1/GATE-OUT: bản tin (production-01) và cận hạn (production-04.3) là 2 tính năng — tắt
    // cái nào chỉ ẩn/không ghi phần đó, phần kia vẫn chạy; có phần bị chặn → exit 2.
    const blk = {
      bantin: await blocked(c, 'bản tin sản xuất', FEATURE_ALLOC),
      canhan: await blocked(c, 'cảnh báo cận hạn', FEATURE_NEAR),
    };
    if (blk.bantin && blk.canhan) {
      sayBlocked(blk.bantin, x.io.out);
      sayBlocked(blk.canhan, x.io.out);
      return EXIT_BLOCKED;
    }
    const near = cfg.near_expiry_days;
    const data: BulletinData = await collect(
      c,
      golden,
      why,
      addDays(day, near),
      addDays(day, -near),
    );
    data.date = day;
    data.period = period;
    let text = renderBulletin(data, x.now(), cfg);
    const [bantin, canhan] = splitFefo(text);
    if (blk.canhan) text = bantin;
    printLines(x.io, blk.bantin ? canhan : text);
    let rc = 0;
    if (a.out_dir) {
      const skip = new Set(
        Object.entries(blk)
          .filter(([, w]) => w)
          .map(([k]) => k),
      );
      rc = await writeBulletin(text, data, a.out_dir as string, day, period, skip, x.io);
    }
    for (const w of [blk.bantin, blk.canhan]) if (w) rc = sayBlocked(w, x.io.out);
    return rc;
  });
}

/**
 * docx P2 (PL01 Sản xuất "báo cáo tuần, tháng…", "cảnh báo hàng cận hạn"; PL02 mục 1): ghi qua
 * `writeReport` (cổng tắt + nhãn giai đoạn + sổ `report_outputs`): `sx-bantin-<tuan|thang>-<ngày>.md`
 * (production-01) và `sx-canhan-<ngày>.md` = mục cận hạn (production-04.3). Có dữ liệu
 * source='sample' → cờ mẫu (không đếm). `skip` = phần bị cổng chặn (mỗi file kiểm RIÊNG).
 */
export async function writeBulletin(
  text: string,
  data: Pick<BulletinData, 'sample'>,
  outDir: string,
  day: string,
  period: string,
  skip: ReadonlySet<string> = new Set(),
  io: Io = STD_IO,
): Promise<number> {
  const smp = Boolean(data.sample);
  const [, fefo] = splitFefo(text);
  const tag = period === 'month' ? 'thang' : 'tuan';
  let rc = 0;
  for (const [key, t, name] of [
    ['bantin', text, `sx-bantin-${tag}-${day}.md`],
    ['canhan', fefo, `sx-canhan-${day}.md`],
  ] as const) {
    if (skip.has(key) || !t) continue;
    try {
      io.out(`[done] ${await writeReport(t, outDir, name, smp)}`);
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      rc = sayBlocked(e.message, io.out);
    }
  }
  return rc;
}

/** `python -m pipelines.production <lệnh> …` → exit code. */
export async function productionMain(argv: string[], d: ProdDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const p = parseArgs(argv, io);
  if (typeof p === 'number') return p;
  const [cmd, a] = p;
  const x: Ctx = { env: d.env ?? process.env, io, d, now: d.now ?? (() => new Date()) };
  switch (cmd) {
    case 'allocate':
      return cmdAllocate(x, a);
    case 'approve':
      return cmdDecide(x, a, 'approved');
    case 'reject':
      return cmdDecide(x, a, 'rejected');
    case 'bom':
      return cmdBom(x, a);
    case 'lots':
      return cmdLots(x, a);
    case 'intake':
      return cmdIntake(x, a);
    case 'cert':
      return cmdCert(x, a);
    case 'cert-verify':
      return cmdCertVerify(x, a);
    case 'plan-add':
    case 'plan-link':
      return cmdPlan(x, cmd, a);
    default:
      return cmdBulletin(x, a);
  }
}

// ===================================================================== inventory_csv

export type InvDeps = {
  env?: Env;
  io?: Io;
  /** Python `auth.bind_service("loader")` + connect — mặc định `servicePool('loader')`. */
  connectLoader?: (env: Env) => Promise<Lease>;
  now?: () => Date;
  goldenFile?: string;
};

const INV_SPEC: SubSpec = {
  opts: [
    { flag: '--file', required: true },
    { flag: '--source', choices: INV_SOURCES, def: 'manual_export' },
  ],
};

async function defaultLoader(env: Env): Promise<Lease> {
  const pool = await servicePool('loader', env);
  return { pool, release: () => pool.end() };
}

/** `python -m ingest.inventory_csv --file F [--source manual_export|sample]` → exit code. */
export async function inventoryCsvMain(argv: string[], d: InvDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const prog = 'inventory-csv';
  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(`usage: ${prog} [-h] --file FILE [--source {${INV_SOURCES.join(',')}}]`);
    return 0;
  }
  let a: Parsed;
  try {
    a = parseSub(INV_SPEC, argv);
  } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    io.err(`usage: ${prog} [-h] --file FILE [--source {${INV_SOURCES.join(',')}}]`);
    io.err(`${prog}: error: ${e.message}`);
    return 2;
  }
  const [golden, why] = goldenMap(d.goldenFile ?? GOLDEN_FILE);
  if (golden === null) {
    io.out(`[err] golden: ${why} — không connect, không nạp gì.`);
    return 1;
  }
  const file = a.file as string;
  const [rows, errs, sha] = await readInventory(
    file,
    golden,
    vnDate((d.now ?? (() => new Date()))()),
  );
  if (errs.length) {
    for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
    if (errs.length > MAX_PRINT_ERRS)
      io.out(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
    io.out(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
    return 1;
  }
  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối
  // login superuser/owner/thiếu biến.
  let lease: Lease;
  if (d.connectLoader) lease = await d.connectLoader(env);
  else {
    const sd = serviceDsn('loader', env);
    if (sd.error !== null) {
      if (approvalEnforced(env)) {
        io.out(`[err] ${sd.error}`);
        return 2;
      }
      io.out('[err] thiếu DATABASE_URL trong .env');
      return 1;
    }
    try {
      lease = await defaultLoader(env);
    } catch (e) {
      if (e instanceof ServiceBindError) {
        io.out(`[err] ${e.message}`);
        return 2;
      }
      if (e instanceof DbConfigError) {
        io.out(`[err] không kết nối được Postgres: ${e.message}`);
        return 1;
      }
      throw e;
    }
  }
  const name = fileLabel(file);
  let n: number;
  try {
    let c: pg.PoolClient;
    try {
      c = await lease.pool.connect();
    } catch (e) {
      io.out(`[err] không kết nối được Postgres: ${connErrName(e)}`);
      return 1;
    }
    try {
      const old = Number(
        (
          await c.query('select count(*) as n from inventory_snapshots where file_sha256 = $1', [
            sha,
          ])
        ).rows[0]?.n,
      );
      if (old) {
        io.out(`[skip] file đã nạp (${old} dòng) — không ghi gì.`);
        return 0;
      }
      await c.query('begin');
      n = await loadInventory(c, rows, a.source as string, name, sha as string);
      await c.query('commit');
    } catch (e) {
      await rollback(c);
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        if (((e as { constraint?: string }).constraint ?? '').includes('file_sha256')) {
          io.out('[skip] file vừa được nạp song song — không ghi gì.');
          return 0;
        }
        io.out('[err] lỗi DB, đã rollback: UniqueViolation');
        return 1;
      }
      if (code === '42P01') {
        io.out(
          '[err] thiếu bảng inventory_snapshots — chạy `python scripts/apply_schema.py` trước.',
        );
        return 1;
      }
      if (isDbError(e)) {
        io.out(`[err] lỗi DB, đã rollback: ${pgErrName(e)}`);
        return 1;
      }
      throw e;
    } finally {
      c.release();
    }
  } finally {
    await lease.release().catch(() => {});
  }
  const tag = a.source === 'sample' ? ' [MẪU]' : '';
  const khos = new Set(rows.map((r) => r.kho)).size;
  const skus = new Set(rows.map((r) => r.sku_key)).size;
  io.out(
    `[load]${tag} ${name}: ${n} dòng tồn (${khos} kho, ${skus} SKU) — chỉ ghi snapshot, không sửa tồn/chuyển kho.`,
  );
  io.out('[done]');
  return 0;
}

// ===================================================================== nest-commander

// argv thô sau tên lệnh (allowUnknownOptions: commander dồn cờ lạ vào args theo đúng thứ tự) — kiểm
// bằng bộ phân tích kiểu argparse ở trên (lỗi parse của nest-commander thoát 0).
@Command({
  name: 'production',
  arguments: '[argv...]',
  description:
    'Sản xuất P1: phân bổ tồn (đề xuất), BOM, hồ sơ lô, phiếu kiểm nghiệm, kế hoạch, bản tin — không chuyển kho, không lệnh sản xuất',
  allowUnknownOptions: true,
})
export class ProductionCommand extends CommandRunner {
  async run(argv: string[]): Promise<void> {
    process.exitCode = await productionMain(argv);
  }
}

@Command({
  name: 'inventory-csv',
  arguments: '[argv...]',
  description: 'Nạp file tồn kho thành phẩm xuất tay (chỉ đọc file, không sửa tồn)',
  allowUnknownOptions: true,
})
export class InventoryCsvCommand extends CommandRunner {
  async run(argv: string[]): Promise<void> {
    process.exitCode = await inventoryCsvMain(argv);
  }
}
