import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  connectDatabaseUrl,
  type Service,
  ServiceBindError,
  serviceDsn,
  servicePool,
} from '@samsam/core/db';
import { approvalEnforced, type Env, pyStrip } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DIRECTORS_DIR, DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { addDays, parseDay, vnDate } from '@samsam/core/ops/period';
import { cpLen, pyInt } from '@samsam/core/ops/py';
import { parsePyJson, pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { DbLease } from '../channels/channels.command.js';
import { isoDay } from '../kd_quote/py.js';
import { section } from '../sales_director/sales-watch.js';
import * as ka from './kd-affiliate.js';
import * as kc from './kd-care.js';
import * as ko from './kd-orders.js';
import { clean, DEALER_CODE_RE, MAX_BY_LEN, MAX_DRAFTS } from './shared.js';

// Lệnh CLI thay `python -m agents.kd_orders` / `agents.kd_care` / `agents.kd_affiliate` — cùng cờ,
// exit code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command
// chỉ nối. Kiểm tham số ở đây (lỗi ném trong hàm parse của nest-commander thoát 0); tham số sai →
// `<prog>: error: …` exit 2 TRƯỚC mọi kết nối DB (Python argparse).

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** kd_orders: login dịch vụ (Python `auth.bind_service`) — ServiceBindError = từ chối (chế độ thực). */
  service?: (svc: Service) => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  now?: () => Date;
  /** kd_care --record: đọc stdin (mặc định process.stdin). */
  stdin?: () => Promise<Buffer>;
  jobRun?: typeof jobRun;
  watchFile?: string;
  mapFile?: string;
  rulesFile?: string;
  directorsDir?: string;
  /** kd_affiliate --release: thư mục ghi kit (Python test đổi `REPORTS_DIR`). */
  outDir?: string;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Python `bind_service` + `connect()`: dev thiếu DSN / host chết → null; chế độ thực sai login → ném. */
async function defaultService(svc: Service, env: Env): Promise<DbLease | null> {
  let pool: Awaited<ReturnType<typeof servicePool>>;
  try {
    pool = await servicePool(svc, env);
  } catch (e) {
    if (e instanceof ServiceBindError && approvalEnforced(env)) throw e;
    return null;
  }
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  return { db: pool, release: () => pool.end() };
}

async function open(
  d: CliDeps,
  io: Io,
  get: () => Promise<DbLease | null>,
): Promise<DbLease | null | number> {
  try {
    const lease = await get();
    if (lease === null) io.err(NO_DB);
    else (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    return lease;
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    io.out(`[err] ${e.message}`);
    return 2;
  }
}

async function readStdin(max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    n += (c as Buffer).length;
    if (n > max) break;
  }
  return Buffer.concat(chunks);
}

const utf8 = (b: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);

// ===================================================================== kd_orders
export type KdOrdersOpts = {
  sync?: boolean;
  snapshot?: string;
  dryRun?: boolean;
  recon?: boolean;
  since?: string;
  until?: string;
  outDir?: string;
  report?: boolean;
  watch?: boolean;
  asOf?: string;
};

async function ordersWatch(
  o: KdOrdersOpts,
  asOf: string | null,
  d: CliDeps,
  io: Io,
): Promise<number> {
  let ow: ko.OrderWatch;
  let cfg: ReturnType<typeof loadConfig>;
  try {
    ow = section('order_watch', d.watchFile) as unknown as ko.OrderWatch;
    cfg = loadConfig('sales', d.directorsDir ?? DIRECTORS_DIR);
    if (!Object.hasOwn(cfg.object_types, ko.OT_ANOMALY)) {
      throw new DirectorConfigError(`sales.json thiếu loại việc ${ko.OT_ANOMALY}`);
    }
  } catch (e) {
    if (!(e instanceof RangeError || e instanceof DirectorConfigError)) throw e;
    io.err(`[error] cấu hình lỗi: ${e.message} — không connect`);
    return 1;
  }
  const today = asOf ?? vnDate((d.now ?? (() => new Date()))());
  const env = d.env ?? process.env;
  const lease = await open(d, io, () => (d.service ?? ((s) => defaultService(s, env)))('job'));
  if (typeof lease === 'number' || lease === null) return typeof lease === 'number' ? lease : 2;
  try {
    let r: ko.WatchResult;
    try {
      r = await ko.watch(lease.db, today, ow, cfg, Boolean(o.dryRun));
    } catch (e) {
      if (e instanceof RolloutBlocked) {
        io.err(`[rollout] ${e.message}`);
        return 2;
      }
      throw e;
    }
    for (const f of r.findings) {
      io.out(
        `  [${f.channel}] tuần ${f.week}: đơn ${ko.WATCH_KINDS[f.kind]} ${f.bad}/${f.n} (${ko.pct(f.bad, f.n)})`,
      );
    }
    io.out(
      `[${o.dryRun ? 'dry-run' : 'watch'}] ngày ${today}: bất thường ${r.findings.length} (mới ${r.new}) · đẩy ${r.enqueued} mục${o.dryRun ? ' — KHÔNG ghi DB' : ''}`,
    );
    io.out(`[info] ${ko.LATE_NOTE}`);
    return 0;
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${clean(dbMsg(e), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

async function ordersInner(
  o: KdOrdersOpts,
  snap: bigint | null,
  since: string | null,
  until: string | null,
  d: CliDeps,
  io: Io,
): Promise<number> {
  const env = d.env ?? process.env;
  const lease = await open(d, io, () => (d.service ?? ((s) => defaultService(s, env)))('loader'));
  if (typeof lease === 'number' || lease === null) return typeof lease === 'number' ? lease : 2;
  try {
    if (o.sync) {
      const res = await ko.sync(
        lease.db,
        snap === null ? null : [snap],
        Boolean(o.dryRun),
        d.mapFile,
      );
      io.out(
        `[${o.dryRun ? 'dry-run' : 'sync'}] ${res.snapshots} snapshot đơn: thêm ${res.inserted}, cập nhật ${res.updated}, không đổi ${res.unchanged}, giữ nguyên row không phải sàn ${res.protected}, bỏ dòng thiếu mã đơn ${res.skipped}${o.dryRun ? ' — KHÔNG ghi DB' : ''}`,
      );
      return 0;
    }
    const s = since as string;
    const u = until as string;
    const rows = await ko.reconRows(lease.db, s, u);
    let path: string;
    try {
      path = ko.writeCsv(rows, o.outDir ?? REPORTS_DIR, s, u);
    } catch (e) {
      io.err(`[error] ghi file đối soát lỗi (${pyOsName(e)})`);
      return 1;
    }
    const n = ko.LABELS.map((k) => `${k} ${rows.filter((r) => r.label === k).length}`).join(', ');
    io.out(
      `[recon] ${rows.length} dòng (${n}) → ${basename(path)} (BÁO CÁO cho kế toán — không bút toán)`,
    );
    return 0;
  } catch (e) {
    let name: string;
    let msg: string;
    if (isDbError(e)) [name, msg] = [pgErrName(e), dbMsg(e)];
    else if (e instanceof RangeError) [name, msg] = ['ValueError', e.message];
    else throw e;
    io.err(`[error] ${name}: ${clean(msg, 300)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}

/** `python -m agents.kd_orders` — KD-A6 đơn sàn → orders lõi + file đối soát + cảnh báo hủy/hoàn.
 * Exit: 0 ok · 1 cấu hình/DB lỗi · 2 tham số sai / DB không kết nối / tính năng tắt. */
export async function kdOrdersMain(o: KdOrdersOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`kd_orders: error: ${msg}`);
    return 2;
  };
  const snap = o.snapshot === undefined ? null : pyInt(o.snapshot);
  if (o.snapshot !== undefined && snap === null) {
    return usage(`argument --snapshot: invalid int value: '${o.snapshot}'`);
  }
  const nOps = [o.sync, o.recon, o.report, o.watch].filter(Boolean).length;
  // v14.2 bind_service: chế độ thực thiếu biến login dịch vụ → từ chối trước mọi việc khác. Kiểm
  // login (superuser/owner/sai role) ở lúc mở kết nối — SAU kiểm tham số (Python: trước), cùng exit 2.
  const sv = serviceDsn(o.watch ? 'job' : 'loader', env);
  if (sv.error !== null && approvalEnforced(env)) {
    io.out(`[err] ${sv.error}`);
    return 2;
  }
  if (nOps > 1) return usage('chỉ được 1 thao tác mỗi lần (--sync | --recon | --watch)');
  if (nOps === 0 || o.report) return usage('cần --sync, --watch hoặc --recon --since D --until D');
  if (snap !== null && !o.sync) return usage('--snapshot chỉ đi với --sync');
  if (o.dryRun && !(o.sync || o.watch)) return usage('--dry-run chỉ đi với --sync / --watch');
  let asOf: string | null = null;
  if (o.asOf !== undefined) {
    if (!(o.watch && o.dryRun)) {
      return usage('--as-of chỉ dùng với --watch --dry-run (không ghi hàng duyệt theo ngày giả)');
    }
    asOf = isoDay(o.asOf);
    if (asOf === null) return usage('--as-of phải dạng YYYY-MM-DD');
  }
  if (o.watch) return ordersWatch(o, asOf, d, io);
  if (snap !== null && snap <= 0n) return usage('--snapshot phải là số dương');
  let since: string | null = null;
  let until: string | null = null;
  if (o.recon) {
    if (!(o.since && o.until)) return usage('--recon cần --since và --until');
    since = isoDay(o.since);
    if (since === null) return usage('--since phải dạng YYYY-MM-DD');
    until = isoDay(o.until);
    if (until === null) return usage('--until phải dạng YYYY-MM-DD');
    if (since > until) return usage('--since phải ≤ --until');
  } else if (o.since || o.until) return usage('--since/--until chỉ đi với --recon');
  if (!o.sync || o.dryRun) return ordersInner(o, snap, since, until, d, io);
  return (d.jobRun ?? jobRun)(
    ko.JOB,
    async (r) => {
      const rc = await ordersInner(o, snap, since, until, d, io);
      r.ok = rc === 0;
      return rc;
    },
    env,
  );
}

// ===================================================================== kd_care
export type KdCareOpts = {
  record?: boolean;
  by?: string;
  plan?: boolean;
  run?: boolean;
  dryRun?: boolean;
  verifySend?: string[];
};

function printPlan(io: Io, res: kc.Selection, tag: string): void {
  for (const it of res.items) {
    const t = it.gui_luc;
    const v = new Date(t.getTime() + 7 * 3_600_000).toISOString();
    io.out(
      `  [${it.object_type}] khách #${it.contact_id} lần mua #${it.purchase_id} gửi lúc ${v.slice(8, 10)}/${v.slice(5, 7)} ${v.slice(11, 16)}`,
    );
  }
  const reasons = new Map<string, number>();
  for (const s of res.skipped) {
    const k = `${s.kind}:${s.ly_do}`;
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  const txt = [...reasons.keys()]
    .sort()
    .map((k) => `${k} ${reasons.get(k)}`)
    .join(', ');
  io.out(`[${tag}] ${res.items.length} nháp · bỏ qua ${txt || '0'}`);
}

async function careInner(
  o: KdCareOpts,
  rules: kc.Rules,
  cfg: ReturnType<typeof loadConfig>,
  now: Date,
  d: CliDeps,
  io: Io,
): Promise<number> {
  let rec: unknown;
  if (o.record) {
    try {
      const raw = await (d.stdin ?? (() => readStdin(kc.MAX_INPUT_BYTES)))();
      if (raw.length > kc.MAX_INPUT_BYTES) throw new PyErr('ValueError');
      let text: string;
      try {
        text = utf8(raw);
      } catch {
        throw new PyErr('UnicodeDecodeError');
      }
      try {
        rec = parsePyJson(text);
      } catch {
        throw new PyErr('JSONDecodeError');
      }
    } catch (e) {
      if (!(e instanceof PyErr)) throw e;
      io.err(`[error] input JSON không hợp lệ (${e.message})`);
      return 1;
    }
  }
  let text = '';
  if (o.verifySend) {
    let why: string | null = null;
    try {
      const raw = readFileSync(o.verifySend[1] as string);
      try {
        text = utf8(raw);
      } catch {
        why = 'UnicodeDecodeError';
      }
    } catch (e) {
      why = pyOsName(e);
    }
    if (why !== null) {
      io.err(`[error] không đọc được file (${why})`);
      return 1;
    }
  }
  const env = d.env ?? process.env;
  const lease = await open(d, io, d.connect ?? (() => connectDatabaseUrl(env)));
  if (typeof lease === 'number' || lease === null) return 2;
  try {
    if (o.record) {
      const pid = await kc.record(lease.db, rec, o.by);
      io.out(`[ok] ghi lần mua #${pid} (khách #${(rec as { contact_id: number }).contact_id})`);
    } else if (o.verifySend) {
      const id = o.verifySend[0] as string;
      const [ok, why] = await kc.verifySend(lease.db, id, text, now, rules);
      io.out(`[${ok ? 'ok' : 'fail'}] mục #${id}: ${why}${ok ? '' : ' — KHÔNG gửi'}`);
      return ok ? 0 : 1;
    } else if (o.plan) {
      printPlan(io, await kc.plan(lease.db, now, rules), 'plan');
    } else {
      const res = await kc.run(lease.db, now, Boolean(o.dryRun), rules, cfg);
      printPlan(io, res, o.dryRun ? 'dry-run' : 'run');
      if (!o.dryRun) {
        io.out(
          `[run] đẩy ${res.new} nháp mới vào hàng duyệt khối ${kc.BLOCK} — hệ thống KHÔNG gửi`,
        );
      }
    }
  } catch (e) {
    if (isDbError(e)) {
      io.err(`[error] lỗi DB: ${dbMsg(e).slice(0, 300)}`);
      return 1;
    }
    if (e instanceof RangeError || e instanceof TypeError) {
      io.err(`[error] ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  return 0;
}

class PyErr extends Error {}

/** `python -m agents.kd_care` — KD-A7 nháp tin chăm sóc lại / xin đánh giá CHỈ cho khách có đồng ý
 * (hệ thống KHÔNG gửi). Exit: 0 ok · 1 cấu hình/DB lỗi / verify fail · 2 tham số sai / DB không kết
 * nối / tính năng tắt. */
export async function kdCareMain(o: KdCareOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`kd_care: error: ${msg}`);
    return 2;
  };
  if (o.verifySend !== undefined && o.verifySend.length !== 2) {
    return usage('argument --verify-send: expected 2 arguments');
  }
  const nOps = [o.record, o.plan, o.run, o.verifySend !== undefined].filter(Boolean).length;
  if (nOps > 1) return usage('chỉ 1 thao tác mỗi lần (--record | --plan | --run | --verify-send)');
  if (nOps === 0) return usage('cần --record | --plan | --run | --verify-send ID FILE');
  if (o.dryRun && !o.run) return usage('--dry-run chỉ đi với --run');
  if (o.record) {
    try {
      kc.checkBy(o.by);
    } catch (e) {
      return usage((e as Error).message);
    }
  } else if (o.by) return usage('--by chỉ đi với --record');
  // r19 (r12 RB): tắt → không đọc nguồn/in kế hoạch/đẩy nháp, cả --dry-run.
  if (o.run || o.plan) {
    const why = await blocked(null, 'nháp chăm sóc sau bán', kc.FEATURE);
    if (why) return sayBlocked(why, io.out);
  }
  let rules: kc.Rules;
  let cfg: ReturnType<typeof loadConfig>;
  try {
    rules = kc.loadRules(d.rulesFile);
    cfg = loadConfig(kc.BLOCK, d.directorsDir ?? DIRECTORS_DIR);
    if (!Object.values(kc.TYPES).every((t) => Object.hasOwn(cfg.object_types, t))) {
      throw new DirectorConfigError('sales.json thiếu loại việc care_rebuy/care_review');
    }
  } catch (e) {
    if (!(e instanceof kc.CareRulesError || e instanceof DirectorConfigError)) throw e;
    io.err(`[error] cấu hình lỗi: ${e.message}`);
    return 1;
  }
  const now = (d.now ?? (() => new Date()))();
  if (!o.run || o.dryRun) return careInner(o, rules, cfg, now, d, io);
  return (d.jobRun ?? jobRun)(
    kc.JOB,
    async (r) => {
      const rc = await careInner(o, rules, cfg, now, d, io);
      r.ok = rc === 0;
      return rc;
    },
    env,
  );
}

// ===================================================================== kd_affiliate
export type KdAffiliateOpts = {
  issue?: boolean;
  release?: string;
  revoke?: string;
  attribute?: boolean;
  report?: boolean;
  dealer?: string;
  channel?: string;
  draftIds?: string;
  by?: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
};

/** Lỗi CLI bắt như Python `(psycopg.Error, ValueError, OSError, RuntimeError)` → [tên, thông điệp]. */
function affErr(e: unknown): [string, string] | null {
  // Lỗi tệp của Node có `path` (ghi kit) — lỗi mạng tới Postgres thì không (→ nhánh DB).
  if ((e as { path?: unknown }).path !== undefined) return [pyOsName(e), (e as Error).message];
  if (isDbError(e)) return [pgErrName(e), dbMsg(e)];
  if (e instanceof RolloutBlocked) return ['RolloutBlocked', e.message];
  if (e instanceof ka.RuntimeError) return ['RuntimeError', e.message];
  if (e instanceof RangeError) return ['ValueError', e.message];
  return null;
}

/** `python -m agents.kd_affiliate` — KD-A8 affiliate đại lý: mã + kit NHÁP vào hàng duyệt, ghi nhận
 * đơn qua mã, hoa hồng BẢN NHÁP (không gửi gì). Exit: 0 ok/skip · 1 bị chặn (in mã) / DB lỗi · 2
 * tham số sai / DB không kết nối. */
export async function kdAffiliateMain(o: KdAffiliateOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`kd_affiliate: error: ${msg}`);
    return 2;
  };
  const rel = o.release === undefined ? null : pyInt(o.release);
  if (o.release !== undefined && rel === null) {
    return usage(`argument --release: invalid int value: '${o.release}'`);
  }
  if (o.channel !== undefined && !ka.CHANNELS.includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: '${o.channel}' (choose from 'shopee', 'tiktok', 'web')`,
    );
  }
  const nOps = [o.issue, rel !== null, o.revoke !== undefined, o.attribute, o.report].filter(
    Boolean,
  ).length;
  if (nOps !== 1) {
    return usage('cần đúng 1 thao tác: --issue | --release | --revoke | --attribute | --report');
  }
  const by = pyStrip(o.by ?? '');
  if ((o.issue || rel !== null || o.revoke !== undefined) && (!by || cpLen(by) > MAX_BY_LEN)) {
    return usage(`--issue/--release/--revoke cần --by <tên người> (≤ ${MAX_BY_LEN} ký tự)`);
  }
  let ids: bigint[] | null = null;
  if (o.issue) {
    if (!o.dealer || !DEALER_CODE_RE.test(o.dealer))
      return usage('--issue cần --dealer <mã đại lý>');
    if (!o.channel) return usage(`--issue cần --channel ${ka.CHANNELS.join('|')}`);
    ids = ka.parseIds(o.draftIds);
    if (ids === null) return usage(`--draft-ids phải 1..${MAX_DRAFTS} id số, cách dấu phẩy`);
  }
  let code: string | null = null;
  if (o.revoke !== undefined) {
    code = pyStrip(o.revoke).toUpperCase();
    if (!ka.CODE_RE.test(code)) return usage('--revoke: mã sai mẫu SS + 10 ký tự');
  }
  let start = '';
  let end = '';
  if (o.report) {
    const s = o.from === undefined ? null : isoDay(o.from);
    if (s === null) return usage('--from phải dạng YYYY-MM-DD');
    const t = o.to === undefined ? null : isoDay(o.to);
    if (t === null) return usage('--to phải dạng YYYY-MM-DD');
    const days = ((parseDay(t) as number) - (parseDay(s) as number)) / 86_400_000;
    if (t < s || days > 3660) return usage('--to phải ≥ --from và kỳ ≤ 3660 ngày');
    [start, end] = [s, t];
  }
  let dcfg: ReturnType<typeof loadConfig> | undefined;
  if (o.issue) {
    try {
      dcfg = loadConfig('sales', d.directorsDir ?? DIRECTORS_DIR);
    } catch (e) {
      if (!(e instanceof DirectorConfigError)) throw e;
      io.out(`[err] cấu hình khối sales: ${e.message} — không connect.`);
      return 1;
    }
  }
  const lease = await open(d, io, d.connect ?? (() => connectDatabaseUrl(env)));
  if (typeof lease === 'number' || lease === null) return 2;
  const block = (c: string, why: string) => {
    io.out(`[chặn] ${c}: ${maskPii(why)}`);
    return 1;
  };
  const db = lease.db;
  try {
    if (o.issue) {
      const res = await ka.issue(db, o.dealer as string, o.channel as string, ids as bigint[], {
        by,
        dryRun: Boolean(o.dryRun),
        ...(dcfg ? { dcfg } : {}),
      });
      if (res.code) return block(res.code, `${res.reason} — không ghi gì.`);
      if (res.skipped) {
        io.out(
          `[skip] ${o.dealer} × ${o.channel} đã có mã ${res.aff_code || '(đang ghi)'} (${res.aff_status ?? 'pending'}) — không sinh mã mới.`,
        );
      } else if (o.dryRun) {
        io.out(res.kit as string);
        io.out('[dry-run] kit đạt mọi luật chặn — không ghi (mã trên chỉ minh họa, không giữ).');
      } else {
        io.out(
          `[issue] mã ${res.aff_code} (pending) + mục hàng duyệt #${res.qid} (affiliate_program, CHỜ GĐ bán hàng duyệt) — agent không gửi/liên hệ đại lý.`,
        );
      }
      return 0;
    }
    if (rel !== null) {
      const res = await ka.release(db, rel, { by, ...(d.outDir ? { outDir: d.outDir } : {}) });
      if (res.code) return block(res.code, res.reason);
      io.out(
        `[release] mã ${res.aff_code} active, kit → ${res.path} (phát hành bởi ${by}) — Quản lý MXH tạo voucher/coupon và gửi TAY; hệ thống không gửi.`,
      );
      return 0;
    }
    if (code !== null) {
      if (!(await ka.revoke(db, code, by))) {
        io.out(`[err] mã ${code} không ở trạng thái active — không thu hồi.`);
        return 1;
      }
      io.out(`[revoke] mã ${code} đã thu hồi bởi ${by} — nhớ tắt voucher TAY trên sàn/web.`);
      return 0;
    }
    if (o.attribute) {
      const r = await ka.attribute(db, null, d.mapFile);
      io.out(
        `[attribute] mới ${r.new} · cập nhật ${r.updated} · không đổi ${r.same} · mã không khớp ${r.unknown_code} · mã web (chưa có nguồn đơn) ${r.web_skipped}`,
      );
      return 0;
    }
    io.out(await ka.report(db, start, addDays(end, 1)));
    return 0;
  } catch (e) {
    const info = affErr(e);
    if (info === null) throw e;
    io.err(`[error] ${info[0]}: ${maskPii(info[1])}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== nest-commander
const collect = (v: string, prev: string[] | undefined) => [...(prev ?? []), v];

@Command({
  name: 'kd-orders',
  description: 'KD-A6 — đơn sàn → orders lõi + file đối soát (không gửi, không bút toán)',
})
export class KdOrdersCommand extends CommandRunner {
  async run(_args: string[], opts: KdOrdersOpts): Promise<void> {
    process.exitCode = await kdOrdersMain(opts);
  }
  @Option({ flags: '--sync', description: 'đưa đơn sàn (market_rows) vào orders' })
  parseSync(): boolean {
    return true;
  }
  @Option({ flags: '--snapshot <id>', description: 'chỉ snapshot ID này' })
  parseSnapshot(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run', description: 'với --sync/--watch: chỉ đếm, không ghi' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--recon', description: 'xuất file đối soát doi-soat-<since>-<until>.csv' })
  parseRecon(): boolean {
    return true;
  }
  @Option({ flags: '--since <d>' })
  parseSince(v: string): string {
    return v;
  }
  @Option({ flags: '--until <d>' })
  parseUntil(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--report', description: '(không hỗ trợ — dùng --recon)' })
  parseReport(): boolean {
    return true;
  }
  @Option({
    flags: '--watch',
    description: 'cảnh báo tỷ lệ hủy/hoàn bất thường tuần đã đóng → hàng duyệt khối sales (v14.4)',
  })
  parseWatch(): boolean {
    return true;
  }
  @Option({ flags: '--as-of <d>', description: '(với --watch --dry-run) ngày giả' })
  parseAsOf(v: string): string {
    return v;
  }
}

@Command({
  name: 'kd-care',
  description:
    'KD-A7 — nháp tin chăm sóc lại / xin đánh giá CHỈ cho khách có đồng ý (hệ thống KHÔNG gửi)',
})
export class KdCareCommand extends CommandRunner {
  async run(_args: string[], opts: KdCareOpts): Promise<void> {
    process.exitCode = await kdCareMain(opts);
  }
  @Option({ flags: '--record', description: 'ghi 1 lần mua từ stdin JSON (cần --by)' })
  parseRecord(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>', description: 'tên NGƯỜI ghi' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--plan', description: 'chỉ đọc, in kế hoạch' })
  parsePlan(): boolean {
    return true;
  }
  @Option({ flags: '--run', description: 'đẩy nháp mới vào hàng duyệt khối sales' })
  parseRun(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: 'với --run: không ghi DB' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({
    flags: '--verify-send <id_file...>',
    description: 'ID FILE — kiểm trước khi NGƯỜI gửi',
  })
  parseVerifySend(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
}

@Command({
  name: 'kd-affiliate',
  description:
    'KD-A8 affiliate đại lý — mã + kit NHÁP vào hàng duyệt, ghi nhận đơn qua mã, hoa hồng BẢN NHÁP (không gửi gì)',
})
export class KdAffiliateCommand extends CommandRunner {
  // Python `__main__` bọc MỌI lần chạy bằng job_run("agents.kd_affiliate").
  async run(_args: string[], opts: KdAffiliateOpts): Promise<void> {
    process.exitCode = await jobRun(ka.JOB, async (r) => {
      const rc = await kdAffiliateMain(opts);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--issue' })
  parseIssue(): boolean {
    return true;
  }
  @Option({ flags: '--release <qid>' })
  parseRelease(v: string): string {
    return v;
  }
  @Option({ flags: '--revoke <code>' })
  parseRevoke(v: string): string {
    return v;
  }
  @Option({ flags: '--attribute' })
  parseAttribute(): boolean {
    return true;
  }
  @Option({ flags: '--report' })
  parseReport(): boolean {
    return true;
  }
  @Option({ flags: '--dealer <code>' })
  parseDealer(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <channel>', description: 'shopee|tiktok|web' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--draft-ids <ids>' })
  parseDraftIds(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--from <d>' })
  parseFrom(v: string): string {
    return v;
  }
  @Option({ flags: '--to <d>' })
  parseTo(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

export const KD_ORDERS_CARE_COMMANDS = [KdOrdersCommand, KdCareCommand, KdAffiliateCommand];
