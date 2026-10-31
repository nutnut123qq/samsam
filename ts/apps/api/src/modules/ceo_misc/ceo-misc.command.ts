import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ServiceBindError } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig as loadDirector,
} from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { vnDate, vnFormat } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, cliEntry, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, cpLen, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type pg from 'pg';
import { coerceDay, type PlanRow, PROMO_KINDS, readPlan } from '../kd_price/kd-price.js';
import { type Calendar, CalendarError, loadCalendar } from '../kd_price/mkt-calendar.js';
import { loadMapping } from '../market/market-csv.js';
import { byError, parseNow, loadConfig as phapCheConfig, safe } from '../ra_kenh/ra-kenh.js';
import * as au from './ceo-audit.js';
import * as cd from './ceo-decisions.js';
import * as cp from './ceo-promo.js';
import * as cr from './ceo-risk.js';
import { cpCmp, dd, NO_DB, openDatabaseUrl, openJob, vnDay } from './common.js';

// Lệnh CLI thay `python -m agents.ceo_audit|ceo_decisions|ceo_promo|ceo_risk` — cùng cờ, exit code,
// thông điệp chính. Hàm `*Main` nhận deps để test (pool/đồng hồ/tệp giả). Kiểm tham số ở `*Main`
// (lỗi ném trong hàm parse của nest-commander thoát 0). Exit: 2 = sai tham số/bị chặn/DB down/lỗi
// DB, 1 = từ chối nghiệp vụ (decisions) / file kế hoạch hỏng (promo) / lỗi lạ.

export type CliDeps = {
  log?: (s: string) => void;
  err?: (s: string) => void;
  env?: Env;
  /** Mở pool (mặc định DATABASE_URL như Python `connect()`; ceo-promo = login dịch vụ `job`). */
  open?: (env: Env) => Promise<pg.Pool | null>;
  /** Nối core trên pool của lệnh (mặc định `wireCore`) — test truyền null. */
  wire?: ((pool: pg.Pool) => void) | null;
  clock?: () => Date;
  /** Đường dẫn cấu hình (test). */
  phapChe?: string;
  riskConfig?: string;
  riskCollect?: cr.CollectOpts;
  directorsDir?: string;
  mapPath?: string;
  calendarPath?: string;
};

type Io = { log: (s: string) => void; err: (s: string) => void };
const io = (d: CliDeps): Io => ({ log: d.log ?? console.log, err: d.err ?? console.error });
const usage = (d: Io, msg: string): number => {
  d.err(`[err] ${msg}`);
  return 2;
};
const now0 = (d: CliDeps): Date => (d.clock ?? (() => new Date()))();

/** Mở pool + nối core; null → đã in NO_DB. */
async function openPool(d: CliDeps, def = openDatabaseUrl): Promise<pg.Pool | null> {
  const pool = await (d.open ?? def)(d.env ?? process.env);
  if (pool !== null && d.wire !== null) (d.wire ?? wireCore)(pool);
  return pool;
}

/** Python `conn.read_only = True`: chạy `fn` trong giao dịch CHỈ ĐỌC (DB từ chối mọi lệnh ghi). */
async function readOnly<T>(pool: pg.Pool, fn: (c: pg.ClientBase) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin transaction read only');
    const r = await fn(c);
    await c.query('rollback');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ------------------------------------------------------------ ceo-audit

export type AuditOpts = { report?: boolean; now?: string; outDir?: string };

/** `ceo-audit --report [--now ISO] [--out-dir DIR]` → `ceo-audit-<ngày>.md` (ceo-04.3) +
 * `ceo-gia-<ngày>.md` (ceo-04.4). Exit: 0 ok (có phát hiện vẫn 0) · 2 tham số sai / cấu hình hỏng /
 * DB down / lỗi DB / cả hai tính năng TẮT (một tính năng tắt → vẫn ghi đầu ra kia, exit 2). */
export async function ceoAuditMain(o: AuditOpts, d: CliDeps = {}): Promise<number> {
  const w = io(d);
  if (!o.report) return usage(w, 'cần --report');
  let now: Date;
  try {
    now = o.now !== undefined ? parseNow(o.now) : now0(d);
  } catch {
    return usage(w, '--now sai định dạng ISO');
  }
  let cfg: { quy_trinh_duyet_tu: string };
  try {
    cfg = phapCheConfig(d.phapChe);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    w.err(`[error] cấu hình phap_che.json: ${e.message}`);
    return 2;
  }
  // r12 G1-L1/RB: 2 đầu ra của 2 tính năng (ceo-audit- = ceo-04.3, ceo-gia- = ceo-04.4) kiểm cổng
  // RIÊNG, TRƯỚC khi đọc/ghi — tắt 1 tính năng không làm mất đầu ra của tính năng kia.
  const day = vnDate(now);
  const name = `${au.AUDIT_PREFIX}${day}.md`;
  const pname = `${au.PRICE_PREFIX}${day}.md`;
  const blk: Record<string, string | null> = {
    [name]: await blocked(null, 'báo cáo', null, { report: name }),
    [pname]: await blocked(null, 'báo cáo', null, { report: pname }),
  };
  if (Object.values(blk).every((x) => x)) {
    for (const why of Object.values(blk)) sayBlocked(why as string, w.log);
    return 2;
  }
  const pool = await openPool(d);
  if (pool === null) {
    w.err(NO_DB);
    return 2;
  }
  try {
    let data: Awaited<ReturnType<typeof au.collect>>;
    try {
      data = await readOnly(pool, (c) => au.collect(c, cfg));
    } catch (e) {
      if (!isDbError(e)) throw e;
      w.err(`[error] lỗi DB: ${cpHead(safe(maskPii(dbMsg(e))), 300)}`);
      return 2;
    }
    const stamp = vnFormat(now, '%d/%m/%Y %H:%M');
    const files = Object.entries(data.snapshots).sort((a, b) => cpCmp(a[0], b[0]));
    const text = [
      `# Audit outside-in P1 — ${stamp} (giờ VN)`,
      '',
      ...au.renderSection(data, null, name, true, pname),
      '',
      '## File listing đã đối chiếu',
      '',
      ...files.map(([ch, f]) => `- ${ch}: ${safe(maskPii(f))}`),
      ...(files.length ? [] : ['- (chưa có file listing sàn)']),
      '',
      '---',
      '*BẢN NHÁP — agent chỉ đọc, không tự gửi.*',
      '',
    ].join('\n');
    const outDir = o.outDir ?? REPORTS_DIR;
    // P8.4: listing sàn + bài đã đăng (file xuất tay) + nháp đã duyệt — không có đường ghi mẫu.
    const path = blk[name] ? null : await writeReport(text, outDir, name, false);
    // Đợt hoàn thiện 22/10 (ceo-04.4): kiểm giá (C06) là ĐẦU RA RIÊNG, cùng nguồn, cùng lần chạy.
    const ptext = [
      `# Giá & mô tả listing đang chạy so bản đã duyệt — ${stamp} (giờ VN)`,
      ...au.checkLines(data.checks, null),
      '',
      '*Giá so giá list ĐÃ DUYỆT còn hiệu lực ngày chụp file listing; giá chưa duyệt/hết hiệu lực hoặc thiếu cột mô tả → không so được. Agent chỉ báo — không đổi giá/listing.*',
      '',
      '---',
      '*BẢN NHÁP — agent chỉ đọc, không tự gửi.*',
      '',
    ].join('\n');
    const ppath = blk[pname] ? null : await writeReport(ptext, outDir, pname, false);
    const fs = au.findings(data.items);
    if (path)
      w.log(`[done] ${path} — ${data.items.length} mục trong mẫu số, ${fs.length} phát hiện`);
    if (ppath) w.log(`[done] giá: ${ppath}`);
    for (const why of Object.values(blk)) if (why) sayBlocked(why, w.log);
    return Object.values(blk).some((x) => x) ? 2 : 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ------------------------------------------------------------ ceo-risk

export type RiskOpts = { report?: boolean; now?: string; outDir?: string };

/** `ceo-risk --report [--now ISO] [--out-dir DIR]` → `ceo-risk-<ngày>.md` (ceo-03). Exit: 0 ok · 2
 * tham số sai / cấu hình hỏng / DB down / lỗi DB / tính năng TẮT. */
export const ceoRiskMain = cliEntry(async (o: RiskOpts, d: CliDeps = {}): Promise<number> => {
  const w = io(d);
  if (!o.report) return usage(w, 'cần --report');
  let now: Date;
  try {
    now = o.now !== undefined ? parseNow(o.now) : now0(d);
  } catch {
    return usage(w, '--now sai định dạng ISO');
  }
  let cfg: cr.RiskCfg;
  try {
    cfg = cr.loadConfig(d.riskConfig, d.phapChe ?? null);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    w.err(`[error] cấu hình: ${e.message}`);
    return 2;
  }
  // r12 RB: ceo-03 tắt → chặn TRƯỚC khi đọc/ghi.
  const name = `${cr.REPORT_PREFIX}${vnDate(now)}.md`;
  const why = await blocked(null, 'sổ rủi ro', null, { report: name });
  if (why) return sayBlocked(why, w.log);
  const pool = await openPool(d);
  if (pool === null) {
    w.err(NO_DB);
    return 2;
  }
  try {
    let cur: cr.Risk[];
    let tr: cr.Trend;
    try {
      [cur, tr] = await readOnly(pool, (c) => cr.compute(c, now, cfg, d.riskCollect));
    } catch (e) {
      if (isDbError(e)) {
        w.err(`[error] lỗi DB: ${cpHead(cr.cell(dbMsg(e)), 300)}`);
        return 2;
      }
      if (e instanceof RangeError && !(e instanceof RolloutBlocked)) {
        w.err(`[error] cấu hình/dữ liệu: ${cpHead(cr.cell(e.message), 300)}`);
        return 2;
      }
      throw e;
    }
    const text = [
      `# Sổ rủi ro pháp lý mở — ${vnFormat(now, '%d/%m/%Y %H:%M')} (giờ VN)`,
      '',
      ...cr.renderSection(cur, tr, now, null),
      '',
      '---',
      '*BẢN NHÁP — agent chỉ đọc, không tự gửi.*',
      '',
    ].join('\n');
    // P8.4: hồ sơ XNQC + cảnh báo đỏ + bài đã đăng — không có đường mẫu.
    const path = await writeReport(text, o.outDir ?? REPORTS_DIR, name, false);
    const cnt = (k: string) => cur.filter((r) => r.level === k).length;
    w.log(`[done] ${path} — đỏ ${cnt('do')}, vàng ${cnt('vang')}, xanh ${cnt('xanh')}`);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
});

// ------------------------------------------------------------ ceo-decisions

export type DecisionsOpts = {
  propose?: boolean;
  record?: boolean;
  follow?: string;
  list?: boolean;
  days?: string;
  now?: string;
  topic?: string;
  decision?: string;
  by?: string;
  decidedBy?: string;
  basis?: string;
  note?: string;
  date?: string;
  due?: string;
  status?: string;
};

/** `ceo-decisions --propose [--days N] [--now ISO] | --record --topic T --decision D --by NGƯỜI
 * [--decided-by] [--basis] [--note] [--date] [--due] | --follow ID --status S --by NGƯỜI [--note] |
 * --list [--now ISO]`. Exit: 0 ok · 1 bị từ chối (căn cứ không có/chưa quyết, trùng, guardrail, ngày
 * tương lai, mục đã đóng) · 2 tham số sai / DB down / lỗi DB. KHÔNG qua cổng rollout (v14.3): dòng sổ
 * là quyết định NGƯỜI ghi. */
export async function ceoDecisionsMain(o: DecisionsOpts, d: CliDeps = {}): Promise<number> {
  const w = io(d);
  const nOps =
    Number(Boolean(o.propose)) +
    Number(Boolean(o.record)) +
    Number(o.follow !== undefined) +
    Number(Boolean(o.list));
  if (nOps !== 1) return usage(w, 'chọn đúng 1 thao tác: --propose | --record | --follow | --list');
  if (o.now !== undefined && !(o.propose || o.list)) {
    return usage(w, '--now chỉ đi với --propose/--list — thao tác ghi dùng giờ thật');
  }
  if (o.days !== undefined && !o.propose) return usage(w, '--days chỉ đi với --propose');
  let days = 30;
  if (o.days !== undefined) {
    const n = pyInt(o.days);
    if (n === null) return usage(w, `argument --days: invalid int value: '${o.days}'`);
    if (n < 1n || n > 366n) return usage(w, '--days phải 1..366');
    days = Number(n);
  }
  const recOnly = [o.topic, o.decision, o.decidedBy, o.basis, o.date, o.due];
  if (!o.record && recOnly.some((v) => v !== undefined)) {
    return usage(w, '--topic/--decision/--decided-by/--basis/--date/--due chỉ đi với --record');
  }
  if ((o.status !== undefined) !== (o.follow !== undefined)) {
    return usage(w, '--follow cần --status (và --status chỉ đi với --follow)');
  }
  if (o.status !== undefined && !cd.FOLLOW.includes(o.status)) {
    return usage(
      w,
      `argument --status: invalid choice: '${o.status}' (choose from 'dang_lam', 'xong', 'huy')`,
    );
  }
  let followId: string | null = null;
  if (o.follow !== undefined) {
    const n = pyInt(o.follow);
    if (n === null) return usage(w, `argument --follow: invalid int value: '${o.follow}'`);
    followId = n.toString();
  }
  let now: Date;
  try {
    now = o.now !== undefined ? parseNow(o.now) : now0(d);
  } catch {
    return usage(w, '--now sai định dạng ISO');
  }
  const today = vnDate(now);
  let basis: [string, string | null] = ['', null];
  let on: string | null = null;
  let due: string | null = null;
  if (o.record || o.follow !== undefined) {
    const e = byError(o.by);
    if (e) return usage(w, e);
    if (o.note !== undefined && cpLen(pyStrip(o.note)) > cd.MAX_NOTE) {
      return usage(w, `--note dài quá ${cd.MAX_NOTE} ký tự`);
    }
  }
  if (o.record) {
    if (o.decidedBy !== undefined) {
      const e = byError(o.decidedBy);
      if (e) return usage(w, `--decided-by: ${e}`);
    }
    for (const [v, flag, mx] of [
      [o.topic, '--topic', cd.MAX_TOPIC],
      [o.decision, '--decision', cd.MAX_DECISION],
    ] as const) {
      const t = pyStrip(v ?? '');
      if (!t || cpLen(t) > mx) return usage(w, `${flag} cần 1..${mx} ký tự`);
    }
    try {
      basis = cd.basisArg(o.basis || 'van_ban'); // Python `a.basis or "van_ban"`
      on = o.date ? cd.dateArg(o.date, '--date') : null;
      due = o.due ? cd.dateArg(o.due, '--due') : null;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return usage(w, e.message);
    }
    if (
      basis[0] === 'van_ban' &&
      (o.decidedBy === undefined || cpLen(pyStrip(o.note ?? '')) < cd.MIN_VAN_BAN_NOTE)
    ) {
      return usage(
        w,
        `căn cứ van_ban cần --decided-by và --note mô tả văn bản ≥ ${cd.MIN_VAN_BAN_NOTE} ký tự`,
      );
    }
  }
  if (o.follow !== undefined && o.status === 'xong' && !pyStrip(o.note ?? '')) {
    return usage(w, '--status xong cần --note (bằng chứng hoàn thành)');
  }
  const pool = await openPool(d);
  if (pool === null) {
    w.err(NO_DB);
    return 2;
  }
  try {
    if (o.propose) {
      const items = await cd.propose(pool, now, days);
      w.log(
        `[đề xuất] ${items.length} mục khối ceo đã quyết trong ${days} ngày chưa có trong sổ — agent KHÔNG tự ghi; NGƯỜI chạy lệnh --record:`,
      );
      for (const it of items) {
        w.log(
          `- approval_queue #${it.id} \`${it.object_type}\` ${it.status} — ${cd.txt(it.title, 80)} — người quyết ${cd.txt(it.decided_by, 60)} ngày ${dd(vnDay(it.decided_at))}`,
        );
        w.log(
          `    python -m agents.ceo_decisions --record --basis approval_queue:${it.id} --topic "..." --decision "..." --by "<tên người ghi>" [--due YYYY-MM-DD]`,
        );
      }
      return 0;
    }
    if (o.list) {
      cd.printList(await cd.read(pool), today, w.log);
      return 0;
    }
    if (o.record) {
      const rid = await cd.record(pool, {
        topic: o.topic,
        decision: o.decision,
        by: o.by as string,
        basisKind: basis[0],
        basisId: basis[1],
        decidedBy: o.decidedBy ?? null,
        note: o.note ?? null,
        decidedOn: on,
        due,
        today,
      });
      w.log(`[done] ghi quyết định #${rid} (người ghi: ${cd.txt(o.by, 60)})`);
      return 0;
    }
    const rid = await cd.follow(
      pool,
      followId as string,
      o.status as string,
      o.by as string,
      o.note,
    );
    w.log(`[done] cập nhật #${rid} → quyết định #${followId}: ${o.status}`);
    return 0;
  } catch (e) {
    if (e instanceof cd.Rejected) {
      w.err(`[từ chối] ${e.message}`);
      return 1;
    }
    if (isDbError(e)) {
      w.err(`[error] lỗi DB: ${cd.txt(dbMsg(e), 300)}`);
      return 2;
    }
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ------------------------------------------------------------ ceo-promo

export type PromoOpts = { plan?: string; running?: string; asOf?: string; dryRun?: boolean };

/** `ceo-promo [--plan CSV] [--running CSV] [--as-of YYYY-MM-DD] [--dry-run]` (ceo-04.5). Exit: 0 ok
 * (có lệch vẫn 0) · 1 file kế hoạch/KM không hợp lệ (trước connect) · 2 cấu hình hỏng / DB down /
 * lỗi DB / tính năng tắt / tham số sai. */
export async function ceoPromoMain(o: PromoOpts, d: CliDeps = {}): Promise<number> {
  const w = io(d);
  let asOf: string | null = null;
  if (o.asOf !== undefined) {
    try {
      asOf = coerceDay(o.asOf);
    } catch {
      return usage(w, 'argument --as-of: cần ngày YYYY-MM-DD');
    }
  }
  const [mapping, mwhy] = loadMapping(d.mapPath);
  if (mapping === null) {
    w.err(`[error] ${mwhy}`);
    return 2;
  }
  let cfg: DirectorConfig;
  let cal: Calendar;
  try {
    cfg = loadDirector('ceo', d.directorsDir ?? DIRECTORS_DIR);
    if (!Object.hasOwn(cfg.object_types, cp.OT_PROMO)) {
      throw new RangeError(`ceo.json thiếu loại việc ${cp.OT_PROMO}`);
    }
    cal = loadCalendar(d.calendarPath);
  } catch (e) {
    // TS chặt hơn có chủ đích: Python không bắt DirectorConfigError (traceback, exit 1) — ở đây
    // cấu hình khối hỏng cũng dừng TRƯỚC connect, exit 2 như docstring "cấu hình hỏng".
    if (
      !(e instanceof RangeError || e instanceof CalendarError || e instanceof DirectorConfigError)
    ) {
      throw e;
    }
    w.err(`[error] cấu hình lỗi: ${e.message} — không connect`);
    return 2;
  }
  const files: Record<string, [PlanRow[], string]> = {};
  for (const [flag, path] of [
    ['--plan', o.plan],
    ['--running', o.running],
  ] as const) {
    if (path === undefined) continue;
    const [rows, errs] = readPlan(path, PROMO_KINDS, cal);
    if (errs.length) {
      w.err(`[error] ${flag} không hợp lệ — 0 dòng:`);
      for (const e of errs.slice(0, 20)) w.err(`  - ${e}`);
      return 1;
    }
    files[flag] = [rows, createHash('sha256').update(readFileSync(path)).digest('hex')];
  }
  const today = asOf ?? vnDate(now0(d));
  let pool: pg.Pool | null;
  try {
    pool = await openPool(d, openJob);
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    w.log(`[err] ${e.message}`);
    return 2;
  }
  if (pool === null) {
    w.err(NO_DB);
    return 2;
  }
  const [plan, psha] = files['--plan'] ?? [null, null];
  const [run, rsha] = files['--running'] ?? [null, null];
  let r: cp.PromoCheck;
  try {
    r = await cp.promoCheck(pool, today, {
      mapping,
      plan,
      runningFile: run,
      planSha: psha,
      runningSha: rsha,
      cfg,
      dryRun: o.dryRun,
    });
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      w.err(`[rollout] ${e.message}`);
      return 2;
    }
    if (isDbError(e)) {
      w.err(`[error] lỗi DB: ${cpHead(safe(maskPii(dbMsg(e))), 300)}`);
      return 2;
    }
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
  const tag = o.dryRun ? 'dry-run' : 'promo';
  w.log(
    `[${tag}] ngày ${today}: ${r.running} KM đang chạy, khớp ${r.ok}, lệch ${r.findings.length} (mới ${r.new}), bản duyệt chưa thấy chạy ${r.planned_idle.length} · đẩy ${r.enqueued} mục${o.dryRun ? ' — KHÔNG ghi DB' : ''}`,
  );
  for (const it of r.items) w.log(`  - ${it.title}`);
  if (plan === null) w.log('[info] không có --plan — chỉ đối chiếu giá KM golden đã duyệt');
  return 0;
}

// ------------------------------------------------------------ nest-commander
// Kiểm giá trị ở `*Main`: lỗi ném trong hàm parse của nest-commander thoát 0.

/** Lỗi lạ (Python traceback) → in 1 dòng, exit 1 — không lộ DSN/chi tiết DB. */
async function guarded(job: string | null, fn: () => Promise<number>): Promise<number> {
  const body = async () => {
    try {
      return await fn();
    } catch (e) {
      console.error(
        `[error] ${(e as Error)?.name ?? 'Error'}: ${cpHead(safe(maskPii(String((e as Error)?.message ?? e))), 300)}`,
      );
      return 1;
    }
  };
  if (job === null) return body();
  // Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2) như `with job_run(...)` của Python.
  return jobRun(job, async (r) => {
    const rc = await body();
    r.ok = rc === 0;
    return rc;
  });
}

@Command({
  name: 'ceo-audit',
  description: 'Audit outside-in P1: bài/listing đang chạy so với bản đã duyệt (CHỈ ĐỌC)',
})
export class CeoAuditCommand extends CommandRunner {
  async run(_a: string[], o: AuditOpts): Promise<void> {
    process.exitCode = await guarded('agents.ceo_audit', () => ceoAuditMain(o));
  }

  @Option({ flags: '--report', description: 'ghi data/reports/ceo-audit-<ngày>.md' })
  parseReport(): boolean {
    return true;
  }

  @Option({ flags: '--now <iso>', description: 'ISO (ngày trên tên file); thiếu múi giờ = giờ VN' })
  parseNow(v: string): string {
    return v;
  }

  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'ceo-risk',
  description: 'Sổ rủi ro pháp lý mở (CHỈ ĐỌC tracker Pháp chế)',
})
export class CeoRiskCommand extends CommandRunner {
  async run(_a: string[], o: RiskOpts): Promise<void> {
    process.exitCode = await guarded('agents.ceo_risk', () => ceoRiskMain(o));
  }

  @Option({ flags: '--report', description: 'ghi data/reports/ceo-risk-<ngày>.md' })
  parseReport(): boolean {
    return true;
  }

  @Option({ flags: '--now <iso>', description: 'ISO; thiếu múi giờ = giờ VN (+07:00)' })
  parseNow(v: string): string {
    return v;
  }

  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'ceo-decisions',
  description:
    'Sổ quyết định TGĐ (append-only) — NGƯỜI ghi với --by; agent chỉ đề xuất (--propose)',
})
export class CeoDecisionsCommand extends CommandRunner {
  async run(_a: string[], o: DecisionsOpts): Promise<void> {
    process.exitCode = await guarded(null, () => ceoDecisionsMain(o));
  }

  @Option({ flags: '--propose', description: 'CHỈ ĐỌC: mục khối ceo đã quyết chưa có trong sổ' })
  parsePropose(): boolean {
    return true;
  }

  @Option({ flags: '--record', description: 'ghi 1 quyết định' })
  parseRecord(): boolean {
    return true;
  }

  @Option({ flags: '--follow <id>', description: 'cập nhật trạng thái thực hiện (dòng mới)' })
  parseFollow(v: string): string {
    return v;
  }

  @Option({ flags: '--list', description: 'in sổ + mốc trễ' })
  parseList(): boolean {
    return true;
  }

  @Option({ flags: '--days <n>', description: '--propose: số ngày nhìn lại 1..366 (mặc định 30)' })
  parseDays(v: string): string {
    return v;
  }

  @Option({ flags: '--now <iso>', description: 'ISO CHỈ cho --propose/--list' })
  parseNow(v: string): string {
    return v;
  }

  @Option({ flags: '--topic <t>' })
  parseTopic(v: string): string {
    return v;
  }

  @Option({ flags: '--decision <d>' })
  parseDecision(v: string): string {
    return v;
  }

  @Option({ flags: '--by <name>', description: 'tên NGƯỜI ghi (không agent:/system:)' })
  parseBy(v: string): string {
    return v;
  }

  @Option({ flags: '--decided-by <name>', description: 'tên NGƯỜI quyết (mặc định lấy từ căn cứ)' })
  parseDecidedBy(v: string): string {
    return v;
  }

  @Option({
    flags: '--basis <b>',
    description: 'approval_queue:ID|approvals:ID|decisions:ID|van_ban',
  })
  parseBasis(v: string): string {
    return v;
  }

  @Option({ flags: '--note <n>' })
  parseNote(v: string): string {
    return v;
  }

  @Option({ flags: '--date <d>', description: 'ngày quyết YYYY-MM-DD (không tương lai)' })
  parseDate(v: string): string {
    return v;
  }

  @Option({ flags: '--due <d>', description: 'hạn thực hiện YYYY-MM-DD' })
  parseDue(v: string): string {
    return v;
  }

  @Option({ flags: '--status <s>', description: 'dang_lam|xong|huy (với --follow)' })
  parseStatus(v: string): string {
    return v;
  }
}

@Command({
  name: 'ceo-promo',
  description:
    'ceo-04.5: so KM/voucher đang chạy với bản đã duyệt → mục ceo/promo_deviation (agent KHÔNG đổi KM/giá)',
})
export class CeoPromoCommand extends CommandRunner {
  async run(_a: string[], o: PromoOpts): Promise<void> {
    process.exitCode = await guarded(cp.JOB, () => ceoPromoMain(o));
  }

  @Option({
    flags: '--plan <csv>',
    description: 'kế hoạch KM ĐÃ duyệt (CSV định dạng kd-price --plan)',
  })
  parsePlan(v: string): string {
    return v;
  }

  @Option({
    flags: '--running <csv>',
    description: 'file xuất KM/voucher đang chạy (cùng định dạng)',
  })
  parseRunning(v: string): string {
    return v;
  }

  @Option({ flags: '--as-of <day>', description: 'ngày so (YYYY-MM-DD), mặc định hôm nay giờ VN' })
  parseAsOf(v: string): string {
    return v;
  }

  @Option({ flags: '--dry-run', description: 'chỉ đọc, không đẩy hàng duyệt' })
  parseDryRun(): boolean {
    return true;
  }
}

export const CEO_MISC_COMMANDS = [
  CeoAuditCommand,
  CeoRiskCommand,
  CeoDecisionsCommand,
  CeoPromoCommand,
];
