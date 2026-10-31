import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  type DirectorConfig,
  DirectorConfigError,
  loadConfig as loadDirectorConfig,
} from '@samsam/core/ops/director';
import { vnDate, vnMidnight } from '@samsam/core/ops/period';
import { isPrintable, pyInt } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { cliGate } from '@samsam/core/security/auth';
import { cpLen, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import { clean, toInt } from '../intel_import/table.js';
import { isoDay } from '../kd_quote/py.js';
import * as ar from './acc-ar.js';
import * as inv from './acc-invoice.js';
import {
  CHANNELS,
  cpCmp,
  type DbLease,
  decStr,
  FPA_CONFIG_FILE,
  fmtDay,
  isDict,
  loadPyJson,
  MAX_PRINT_ERRS,
  nextDay,
  type PyJsonError,
  parseMonth,
  vnd,
} from './fin-common.js';
import * as fd from './fin-director.js';
import * as fp from './fp-pnl.js';

// Lệnh CLI thay `python -m agents.acc_ar` / `agents.acc_invoice` / `agents.fp_pnl` /
// `agents.fin_director` — cùng cờ, exit code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit code
// (test gọi thẳng); lớp Command chỉ nối. Tham số kiểm ở đây, TRƯỚC connect (lỗi → exit 2 như argparse).
// Kết nối như Python `ingest.lead_store.connect()` (DATABASE_URL) — DB down → exit 2.

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type CliDeps = {
  env?: Env;
  io?: Io;
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  now?: () => Date;
  arConfig?: string;
  invConfig?: string;
  marketMap?: string;
  fpaConfig?: string;
  reportsDir?: string;
  draftDir?: string;
  dcfg?: DirectorConfig;
  src?: fd.FinSources;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** Lỗi hệ thống tệp (Python OSError) — tách khỏi lỗi kết nối DB (cũng có mã `E…`). */
const isFsError = (e: unknown): boolean =>
  e instanceof Error &&
  typeof (e as { code?: unknown }).code === 'string' &&
  typeof (e as { syscall?: unknown }).syscall === 'string' &&
  'path' in e;

/** `[error] <Tên lỗi Python>: <thông điệp>` — DB: thông điệp function; OS/cấu hình: tên lỗi. */
function errLine(e: unknown): string | null {
  if (isFsError(e)) return `[error] ${pyOsName(e)}: ${pyOsName(e)}`;
  if (isDbError(e)) return `[error] ${pgErrName(e)}: ${dbMsg(e)}`;
  return null;
}

/** Python `date.fromisoformat` cho cờ CLI (TS chặt hơn: không nhận dạng tuần ISO). */
const dayArg = (s: string): string | null => isoDay(s);

async function withLease(
  d: CliDeps,
  io: Io,
  fn: (db: Db) => Promise<number>,
  onError: (e: unknown) => number | null,
): Promise<number> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    return await fn(lease.db);
  } catch (e) {
    const rc = onError(e);
    if (rc === null) throw e;
    return rc;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== acc_ar
export type AccArOpts = {
  load?: string;
  aging?: boolean;
  commission?: boolean;
  bulletin?: boolean;
  reminders?: boolean;
  dryRun?: boolean;
  asOf?: string;
  from?: string;
  to?: string;
};

function printReminders(io: Io, res: ar.ReminderResult, asOf: string, dryRun: boolean): number {
  if (dryRun) {
    for (const d of res.drafts) {
      io.out(`--- [dry-run] ${ar.REMINDER_TYPE} ${d.object_id} ---`);
      io.out(d.body);
    }
  }
  for (const x of res.enqueued) {
    io.out(
      `[reminder] ${x.dealer_code} quá hạn ${vnd(x.qua_han)} → hàng duyệt #${x.queue_id} (pending — GĐ tài chính duyệt; kế toán gửi tay)`,
    );
  }
  for (const x of res.skipped) io.out(`[skip] ${x.dealer_code}: ${x.reason}`);
  const n = dryRun ? res.drafts.length : res.enqueued.length;
  io.out(
    `[reminders] tính tới ${asOf}: ${n} nháp${dryRun ? ' (dry-run, không ghi)' : ' mới'}, ${res.skipped.length} bỏ qua — agent KHÔNG gửi thư`,
  );
  return 0;
}

/** `python -m agents.acc_ar` → 0 ok/skip · 1 file/cấu hình/DB lỗi · 2 tham số sai / DB down / tắt. */
export async function accArMain(o: AccArOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`acc_ar: error: ${msg}`);
    return 2;
  };
  const nOps = [o.load !== undefined, o.aging, o.commission, o.bulletin, o.reminders].filter(
    Boolean,
  ).length;
  if (nOps > 1) {
    return usage(
      'chỉ 1 thao tác mỗi lần (--load | --aging | --commission | --bulletin | --reminders)',
    );
  }
  if (nOps === 0) return usage('cần --load | --aging | --commission | --bulletin | --reminders');
  if (o.dryRun && !o.reminders) return usage('--dry-run chỉ dùng với --reminders');
  const dates: Record<string, string | null> = {};
  for (const [k, flag] of [
    ['asOf', '--as-of'],
    ['from', '--from'],
    ['to', '--to'],
  ] as const) {
    const v = o[k];
    dates[k] = v === undefined ? null : dayArg(v);
    if (v !== undefined && dates[k] === null) return usage(`${flag} phải dạng YYYY-MM-DD`);
  }
  if (o.asOf && !(o.aging || o.bulletin || o.reminders)) {
    return usage('--as-of chỉ dùng với --aging/--bulletin/--reminders');
  }
  const dFrom = dates.from as string | null;
  const dTo = dates.to as string | null;
  if (o.commission) {
    if (dFrom === null || dTo === null) return usage('--commission cần --from và --to');
    if (dFrom > dTo) return usage('--from sau --to');
  } else if (dFrom || dTo) return usage('--from/--to chỉ dùng với --commission');
  const now = (d.now ?? (() => new Date()))();
  const asOf = (dates.asOf as string | null) ?? vnDate(now);

  const [cfg, why] = ar.loadConfig(d.arConfig);
  if (cfg === null) {
    io.out(`[err] ${why} — không connect.`);
    return 1;
  }
  let entries: ar.ArEntry[] = [];
  let sha = '';
  if (o.load !== undefined) {
    const [es, errs, s] = await ar.readAr(o.load);
    if (errs.length) {
      for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
      io.out(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
      return 1;
    }
    entries = es;
    sha = s as string;
  }
  return withLease(
    d,
    io,
    async (db) => {
      if (o.load !== undefined) {
        const ex = await db.query('select 1 from dealer_ar where file_sha256 = $1 limit 1', [sha]);
        if (ex.rows.length) {
          io.out('[skip] file công nợ đã nạp — không ghi gì.');
          return 0;
        }
        const name = basename(o.load);
        const n = await ar.load(db, entries, name, sha);
        io.out(`[load] ${n} dòng công nợ từ ${clean(name, 80)}`);
        return 0;
      }
      if (o.bulletin) {
        const [path, rows] = await ar.bulletin(db, asOf, now, {
          cfg,
          outDir: d.reportsDir,
          dcfg: d.dcfg,
        });
        const nOd = rows.filter((r) => r.qua_han > 0).length;
        io.out(`[bulletin] ${nOd} đại lý quá hạn → ${basename(path)} (BẢN NHÁP, không tự gửi)`);
        return 0;
      }
      if (o.reminders) {
        const res = await ar.enqueueReminders(db, asOf, cfg.term_days, {
          dryRun: Boolean(o.dryRun),
          dcfg: d.dcfg,
        });
        return printReminders(io, res, asOf, Boolean(o.dryRun));
      }
      if (o.aging) {
        const rows = ar.aging(await ar.fetchEntries(db), asOf, cfg.term_days);
        io.out(`[aging] tuổi nợ tính tới ${asOf} — ${rows.length} đại lý:`);
        for (const r of rows) {
          const b = r.buckets;
          io.out(
            `  ${r.dealer_code}: còn nợ ${vnd(r.con_no)} (${ar.BUCKETS.map((k) => `${k} ${vnd(b[k])}`).join(', ')}); quá hạn ${vnd(r.qua_han)}${r.du_co ? `; dư có ${vnd(r.du_co)}` : ''}`,
          );
        }
        return 0;
      }
      const lines = ar.commission(
        await ar.fetchEntries(db),
        await ar.fetchSkus(db),
        cfg,
        dFrom as string,
        nextDay(dTo as string),
      );
      io.out(
        `[commission] BẢN NHÁP — không phải lệnh chi; kỳ ${dFrom} → ${dTo} (tính cả ngày cuối), chính sách MẪU chưa ký:`,
      );
      for (const x of lines) {
        io.out(
          `  ${x.dealer_code} ${x.category || '?'}/${x.channel || '?'}: cơ sở ${vnd(x.co_so)} × ${decStr(x.ty_le)} = ${vnd(x.hoa_hong)}${x.flags.length ? ` [${x.flags.join(', ')}]` : ''}`,
        );
      }
      io.out(`  tổng hoa hồng nháp: ${vnd(lines.reduce((s, x) => s + x.hoa_hong, 0))}`);
      return 0;
    },
    (e) => {
      if (e instanceof RolloutBlocked) {
        io.err(`[blocked] ${e.message}`);
        return 2;
      }
      const line = errLine(e);
      if (line !== null) {
        io.err(line);
        return 1;
      }
      if (e instanceof DirectorConfigError) {
        io.err('[error] DirectorConfigError: DirectorConfigError');
        return 1;
      }
      return null;
    },
  );
}

// ===================================================================== acc_invoice
export type AccInvoiceOpts = {
  batch?: boolean;
  day?: string;
  yeuCau?: string;
  channel?: string;
  verifyDraft?: string;
  file?: string;
};

/** `python -m agents.acc_invoice` → 0 ok/skip · 1 file/cấu hình lỗi, đang chạy, verify fail · 2 tham
 * số sai / DB down. */
export async function accInvoiceMain(o: AccInvoiceOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`acc_invoice: error: ${msg}`);
    return 2;
  };
  const qid = o.verifyDraft === undefined ? null : pyInt(o.verifyDraft);
  if (o.verifyDraft !== undefined && qid === null) {
    return usage(`argument --verify-draft: invalid int value: '${o.verifyDraft}'`);
  }
  if (o.channel !== undefined && !(CHANNELS as readonly string[]).includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: '${o.channel}' (choose from 'shopee', 'tiktok')`,
    );
  }
  const nOps = Number(Boolean(o.batch)) + Number(qid !== null);
  if (nOps > 1) return usage('chỉ 1 thao tác mỗi lần (--batch | --verify-draft)');
  if (nOps === 0) return usage('cần --batch hoặc --verify-draft QUEUE_ID --file F');
  if ((qid !== null) !== (o.file !== undefined))
    return usage('--verify-draft và --file đi cùng nhau');
  if ((o.yeuCau !== undefined) !== (o.channel !== undefined)) {
    return usage('--yeu-cau và --channel đi cùng nhau');
  }
  if (qid !== null && (o.day || o.yeuCau !== undefined)) {
    return usage('--day/--yeu-cau chỉ dùng với --batch');
  }
  const now = (d.now ?? (() => new Date()))();
  let day = '';
  if (o.batch) {
    const v = o.day ? dayArg(o.day) : vnDate(now);
    if (v === null) return usage('--day phải dạng YYYY-MM-DD');
    day = v;
  }
  let cfg: inv.InvConfig | null = null;
  let yeuCau = new Map<string, inv.Buyer>();
  if (o.batch) {
    const [c, why] = inv.loadConfig(d.invConfig, d.marketMap);
    if (c === null) {
      io.out(`[err] ${why} — không connect.`);
      return 1;
    }
    cfg = c;
    if (o.yeuCau !== undefined) {
      const [got, errs] = await inv.readYeuCau(o.yeuCau, o.channel as string, cfg);
      if (errs.length) {
        for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
        io.out(`[err] ${errs.length} lỗi file yêu cầu — không connect, không ghi gì.`);
        return 1;
      }
      yeuCau = got;
    }
  }
  let res: inv.BatchResult | null = null;
  const rc = await withLease(
    d,
    io,
    async (db) => {
      if (qid !== null) {
        const [ok, msg] = await inv.verifyDraft(db, qid, o.file as string);
        io.out(`[${ok ? 'ok' : 'fail'}] ${msg}`);
        return ok ? 0 : 1;
      }
      res = await inv.runBatch(db, day, cfg as inv.InvConfig, {
        yeuCau,
        outDir: d.draftDir,
        dcfg: d.dcfg,
      });
      return -1;
    },
    (e) => {
      if (isFsError(e)) {
        // lô đã vào hàng nhưng ghi file nháp lỗi → không có bản để nhập
        io.err(
          `[error] ghi file nháp lỗi (${pyOsName(e)}) — lô đã vào hàng duyệt: TỪ CHỐI mục đó rồi chạy lại --batch`,
        );
        return 1;
      }
      if (isDbError(e)) {
        io.err(`[error] ${pgErrName(e)}: ${dbMsg(e)}`);
        return 1;
      }
      if (e instanceof DirectorConfigError || e instanceof RangeError) {
        // Python ValueError (gồm RolloutBlocked — tính năng TẮT: lô rollback, 0 dòng)
        const name = e.constructor.name === 'RangeError' ? 'ValueError' : e.constructor.name;
        io.err(`[error] ${name}: ${e.message}`);
        return 1;
      }
      return null;
    },
  );
  if (rc !== -1) return rc;
  const r = res as unknown as inv.BatchResult;
  if (r.status === 'locked') {
    io.out('[err] đang có 1 lần --batch khác chạy (advisory lock) — thử lại sau.');
    return 1;
  }
  if (r.status === 'skip') {
    io.out(
      `[skip] ngày ${day} đã có lô chờ duyệt #${r.queue_id} — duyệt/từ chối xong mới lập lô mới.`,
    );
    return 0;
  }
  const ex = r.batch.excluded;
  if (r.status === 'empty') {
    io.out(
      `[ok] ${day}: không có đơn cần lập hóa đơn (hủy ${ex.huy}, chưa đạt mốc ${ex.chua_dat_moc}, đã lập ${ex.da_lap}) — 0 mục vào hàng.`,
    );
    return 0;
  }
  const ls = r.batch.lines;
  const n = (k: string) => ls.filter((x) => x.kind === k).length;
  io.out(
    `[ok] lô ${r.batch_key}: ${ls.length} dòng (thường ${n('thuong')}, cần MST ${n('can_mst')}, điều chỉnh ${n('dieu_chinh')}); loại: hủy ${ex.huy}, chưa đạt mốc ${ex.chua_dat_moc}, đã lập ${ex.da_lap} → hàng duyệt #${r.queue_id} (finance, chờ người duyệt)`,
  );
  if (r.batch.unmatched_yeu_cau) {
    io.out(`[warn] ${r.batch.unmatched_yeu_cau} yêu cầu xuất HĐ không khớp đơn nào trong lô`);
  }
  io.out(
    `[file] nháp: ${basename(r.path)} (thư mục hoa-don-nhap, gitignored — chứa thông tin người mua, KHÔNG gửi đi)`,
  );
  io.out('[done] BẢN NHÁP — agent không ký số, không phát hành.');
  return 0;
}

// ===================================================================== fp_pnl
export type FpPnlOpts = {
  cogsAdd?: boolean;
  cogsApprove?: string;
  cogsList?: boolean;
  pnl?: boolean;
  sku?: string;
  cost?: string;
  from?: string;
  by?: string;
  note?: string;
  month?: string;
  channel?: string;
};

/** `python -m agents.fp_pnl` → 0 ok · 1 dữ liệu/DB lỗi, duyệt bị từ chối · 2 tham số sai / DB down / tắt. */
export async function fpPnlMain(o: FpPnlOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`fp_pnl: error: ${msg}`);
    return 2;
  };
  const cid = o.cogsApprove === undefined ? null : pyInt(o.cogsApprove);
  if (o.cogsApprove !== undefined && cid === null) {
    return usage(`argument --cogs-approve: invalid int value: '${o.cogsApprove}'`);
  }
  if (o.channel !== undefined && !(CHANNELS as readonly string[]).includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: '${o.channel}' (choose from 'shopee', 'tiktok')`,
    );
  }
  const nOps = [o.cogsAdd, cid !== null, o.cogsList, o.pnl].filter(Boolean).length;
  if (nOps > 1) {
    return usage('chỉ 1 thao tác mỗi lần (--cogs-add | --cogs-approve | --cogs-list | --pnl)');
  }
  if (nOps === 0) return usage('cần --cogs-add | --cogs-approve ID | --cogs-list | --pnl');
  if ((o.sku || o.cost || o.from) && !o.cogsAdd) {
    return usage('--sku/--cost/--from chỉ dùng với --cogs-add');
  }
  if (o.by && !(o.cogsAdd || cid !== null)) {
    return usage('--by chỉ dùng với --cogs-add/--cogs-approve');
  }
  if ((o.month || o.channel) && !o.pnl) return usage('--month/--channel chỉ dùng với --pnl');
  const note = pyStrip(o.note ?? '') || null;
  if (note && (cpLen(note) > 200 || !isPrintable(note))) {
    return usage('--note tối đa 200 ký tự in được');
  }
  const byOf = (s: string | undefined): string | null => {
    const by = pyStrip(s ?? '');
    return !by || cpLen(by) > fp.MAX_BY || !isPrintable(by) ? null : by;
  };
  const BY_ERR = `--by cần tên người (1..${fp.MAX_BY} ký tự in được)`;
  let by = '';
  let cost = 0;
  let validFrom = '';
  if (o.cogsAdd) {
    if (!o.sku || !fp.SKU_RE.test(o.sku))
      return usage('--sku phải là sku_key golden (vd savina-12v)');
    const c = toInt(o.cost, fp.COST_CAP);
    if (!c) return usage('--cost phải là số nguyên VND > 0');
    cost = c;
    const vf = dayArg(o.from ?? '');
    if (vf === null) return usage('--from phải dạng YYYY-MM-DD');
    validFrom = vf;
    const b = byOf(o.by);
    if (b === null) return usage(BY_ERR);
    by = b;
  }
  if (cid !== null) {
    const b = byOf(o.by);
    if (b === null) return usage(BY_ERR);
    by = b;
  }
  let month = '';
  if (o.pnl) {
    const m = parseMonth(o.month);
    if (m === null) return usage('--pnl cần --month YYYY-MM (tháng 01..12)');
    month = m;
  }
  const now = (d.now ?? (() => new Date()))();
  return withLease(
    d,
    io,
    async (db) => {
      if (o.cogsAdd) {
        const id = await fp.addCogs(db, o.sku as string, cost, validFrom, by, note);
        if (id === null) {
          io.out(`[err] SKU '${o.sku}' không có trong sku_master — nạp golden trước.`);
          return 1;
        }
        io.out(
          `[cogs-add] giá vốn #${id}: ${o.sku} ${vnd(cost)} từ ${validFrom} — CHỜ DUYỆT (người duyệt phải khác người lập).`,
        );
        return 0;
      }
      if (cid !== null) {
        // v14.2: GĐ tài chính được Bên B ủy quyền (cliGate) — function `approve_cogs` vẫn chặn người
        // lập tự duyệt ở DB.
        const why = await cliGate(db, by, 'finance', 'approve', 'cogs_versions', cid.toString(), {
          env: d.env,
        });
        if (why) {
          io.out(`[err] giá vốn #${cid}: ${why}`);
          return 1;
        }
        const [ok, msg] = await fp.approve(db, cid, by, note);
        if (!ok) {
          io.out(`[err] giá vốn #${cid}: ${msg}`);
          return 1;
        }
        io.out(`[cogs-approve] giá vốn #${cid} đã duyệt.`);
        return 0;
      }
      if (o.cogsList) {
        const vs = await fp.fetchVersions(db);
        const today = vnDate(now);
        io.out(`[cogs-list] giá vốn ĐÃ duyệt hiệu lực ngày ${today} + dòng chờ duyệt:`);
        for (const sku of [...new Set(vs.map((v) => v.sku_key))].sort(cpCmp)) {
          const c = fp.cogsAt(vs, sku, today);
          io.out(`  ${sku}: ${c !== null ? vnd(c) : fp.NO_COGS}`);
        }
        for (const v of vs) {
          if (!pyStrip(v.approved_by ?? '')) {
            io.out(`  [chờ duyệt] #${v.id} ${v.sku_key} ${vnd(v.cost_vnd)} từ ${v.valid_from}`);
          }
        }
        return 0;
      }
      // r12 RB: P&L tắt → chặn trước khi tính/in/ghi báo cáo.
      const why = await blocked(db, 'P&L', fp.FEATURE_PNL);
      if (why) return sayBlocked(why, io.out);
      const res = await fp.compute(db, month, o.channel ?? null);
      const text = fp.render(res);
      // Lọc kênh → file riêng: KHÔNG đè bản P&L toàn kênh GĐ tài chính ký. P8.4: nguồn là file xuất
      // thật + giá vốn người duyệt → sample=false.
      const suffix = o.channel ? `-${o.channel}` : '';
      const path = await writeReport(
        text,
        d.reportsDir ?? REPORTS_DIR,
        `pnl-${fmtDay(month, '%Y-%m')}${suffix}.md`,
        false,
      );
      io.out(text);
      io.out(`[pnl] → ${basename(path)} (BẢN NHÁP, không tự gửi)`);
      return 0;
    },
    (e) => {
      if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
      const line = errLine(e);
      if (line === null) return null;
      io.err(line);
      return 1;
    },
  );
}

// ===================================================================== fin_director
export type FinDirectorOpts = { weekly?: boolean; asOf?: string };

/** `python -m agents.fin_director` → 0 ok · 1 cấu hình lỗi / ghi file lỗi · 2 tham số sai / DB down. */
export async function finDirectorMain(o: FinDirectorOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`fin_director: error: ${msg}`);
    return 2;
  };
  if (!o.weekly) return usage('cần --weekly');
  let now = (d.now ?? (() => new Date()))();
  let asOf = vnDate(now);
  if (o.asOf !== undefined) {
    const v = dayArg(o.asOf);
    if (v === null) return usage('--as-of phải dạng YYYY-MM-DD');
    if (v !== asOf) now = new Date(vnMidnight(v).getTime() + 12 * 3600_000);
    asOf = v;
  }
  const fpa = d.fpaConfig ?? FPA_CONFIG_FILE;
  try {
    if (!isDict(loadPyJson(fpa))) {
      io.out(`[err] ${basename(fpa)} hỏng (TypeError) — không connect.`);
      return 1;
    }
  } catch (e) {
    io.out(`[err] ${basename(fpa)} hỏng (${(e as PyJsonError).pyType}) — không connect.`);
    return 1;
  }
  let dcfg: DirectorConfig;
  try {
    dcfg = d.dcfg ?? loadDirectorConfig('finance');
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    io.out(`[err] cấu hình khối finance: ${e.message} — không connect.`);
    return 1;
  }
  return withLease(
    d,
    io,
    async (db) => {
      const [path, text] = await fd.weekly(db, asOf, now, {
        outDir: d.reportsDir,
        dcfg,
        fpaConfig: fpa,
        arConfig: d.arConfig,
        src: d.src,
      });
      const nNodata = text.split('(chưa có dữ liệu:').length - 1;
      io.out(
        `[weekly] bản tin GĐ tài chính tính tới ${asOf} → ${basename(path)} (BẢN NHÁP, không tự gửi; ${nNodata} mục chưa có dữ liệu)`,
      );
      return 0;
    },
    (e) => {
      // TS chặt hơn: báo cáo bị cổng TẮT chặn → `[rollout]` exit 2 (Python: traceback).
      if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
      const line = errLine(e);
      if (line === null) return null;
      io.err(line);
      return 1;
    },
  );
}

// ===================================================================== lớp Command (nest-commander)

@Command({
  name: 'acc-ar',
  description:
    'ACC-AR: công nợ đại lý, tuổi nợ, hoa hồng (BẢN NHÁP), cảnh báo quá hạn vào bản tin GĐ tài chính',
})
export class AccArCommand extends CommandRunner {
  async run(_args: string[], o: AccArOpts): Promise<void> {
    process.exitCode = await accArMain(o);
  }
  @Option({ flags: '--load <file>' })
  parseLoad(v: string): string {
    return v;
  }
  @Option({ flags: '--aging' })
  parseAging(): boolean {
    return true;
  }
  @Option({ flags: '--commission' })
  parseCommission(): boolean {
    return true;
  }
  @Option({ flags: '--bulletin' })
  parseBulletin(): boolean {
    return true;
  }
  @Option({
    flags: '--reminders',
    description: 'v13.6: nháp thư nhắc nợ quá hạn → hàng duyệt finance (không gửi)',
  })
  parseReminders(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: '--reminders: chỉ in nháp, không ghi hàng duyệt' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--as-of <date>', description: 'ngày chốt YYYY-MM-DD (mặc định hôm nay VN)' })
  parseAsOf(v: string): string {
    return v;
  }
  @Option({ flags: '--from <date>' })
  parseFrom(v: string): string {
    return v;
  }
  @Option({ flags: '--to <date>', description: 'tính cả ngày này' })
  parseTo(v: string): string {
    return v;
  }
}

@Command({
  name: 'acc-invoice',
  description:
    'ACC-Invoice: lô hóa đơn NHÁP → hàng duyệt (không ký số, không phát hành, không gửi)',
})
export class AccInvoiceCommand extends CommandRunner {
  async run(_args: string[], o: AccInvoiceOpts): Promise<void> {
    process.exitCode = await accInvoiceMain(o);
  }
  @Option({ flags: '--batch', description: 'gom lô ngày D vào hàng duyệt' })
  parseBatch(): boolean {
    return true;
  }
  @Option({ flags: '--day <date>', description: 'ngày lô YYYY-MM-DD (mặc định hôm nay VN)' })
  parseDay(v: string): string {
    return v;
  }
  @Option({ flags: '--yeu-cau <file>', description: 'file yêu cầu xuất hóa đơn (cần --channel)' })
  parseYeuCau(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <kenh>' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--verify-draft <queue_id>' })
  parseVerifyDraft(v: string): string {
    return v;
  }
  @Option({ flags: '--file <file>', description: 'file nháp cần kiểm' })
  parseFile(v: string): string {
    return v;
  }
}

@Command({
  name: 'fp-pnl',
  description: 'FP-COGS-PnL: giá vốn (người lập ≠ người duyệt) + P&L SKU × kênh × tháng (BẢN NHÁP)',
})
export class FpPnlCommand extends CommandRunner {
  async run(_args: string[], o: FpPnlOpts): Promise<void> {
    process.exitCode = await fpPnlMain(o);
  }
  @Option({ flags: '--cogs-add' })
  parseCogsAdd(): boolean {
    return true;
  }
  @Option({ flags: '--cogs-approve <id>' })
  parseCogsApprove(v: string): string {
    return v;
  }
  @Option({ flags: '--cogs-list' })
  parseCogsList(): boolean {
    return true;
  }
  @Option({ flags: '--pnl' })
  parsePnl(): boolean {
    return true;
  }
  @Option({ flags: '--sku <sku>' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--cost <vnd>', description: 'giá vốn VND / đơn vị (số nguyên > 0)' })
  parseCost(v: string): string {
    return v;
  }
  @Option({ flags: '--from <date>', description: 'hiệu lực từ YYYY-MM-DD' })
  parseFrom(v: string): string {
    return v;
  }
  @Option({
    flags: '--by <name>',
    description: 'người lập (--cogs-add) / người duyệt (--cogs-approve)',
  })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--note <text>' })
  parseNote(v: string): string {
    return v;
  }
  @Option({ flags: '--month <yyyy-mm>' })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <kenh>' })
  parseChannel(v: string): string {
    return v;
  }
}

@Command({
  name: 'fin-director',
  description: 'FIN-Director: bản tin tuần GĐ tài chính (BẢN NHÁP, không tự gửi)',
})
export class FinDirectorCommand extends CommandRunner {
  async run(_args: string[], o: FinDirectorOpts): Promise<void> {
    process.exitCode = await finDirectorMain(o);
  }
  @Option({ flags: '--weekly' })
  parseWeekly(): boolean {
    return true;
  }
  @Option({ flags: '--as-of <date>', description: 'ngày chốt YYYY-MM-DD (mặc định hôm nay VN)' })
  parseAsOf(v: string): string {
    return v;
  }
}
