import { basename } from 'node:path';
import { connectDatabaseUrl, ServiceBindError, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError } from '@samsam/core/ops/director';
import { vnDate, vnFormat } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { oneline, readinessFromDb } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { cliIdentity, HumanDenied, HumanError } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import { dbCombos } from '../channels/b2b-form.service.js';
import type { DbLease } from '../channels/channels.command.js';
import { FOOTER as B2B_FOOTER, readCsv, SOURCES_FILE, STATUSES } from './da-b2b.js';
import {
  build as buildCatalog,
  CATALOG_TYPES,
  OBJECT_TYPE as OT_CATALOG,
  ProductionError,
  readBom,
} from './kd-catalog.js';
import {
  alcoholNames,
  approvedGolden,
  buildQuote,
  type Classified,
  classify,
  confirmed,
  FOOTER,
  GOLDEN_FILE,
  gateQuote,
  MATRIX_FILE,
  MAX_DISCOUNT,
  OT_MATRIX,
  OT_QUOTE,
  readGolden,
  readinessMap,
  readMatrix,
  renderHtml,
  validateMatrix,
  vnd,
} from './kd-quote.js';
import {
  catalogSubmit,
  exportApproved,
  FEATURE_FOLLOWUP,
  fetchRequest,
  fetchVersions,
  goldenPrices,
  handover,
  importRows,
  OUTCOME_LABELS,
  OUTCOMES,
  recordEvent,
  runFollowups,
  submitBatch,
  submitQuote,
  verifySend,
} from './kd-quote.service.js';
import { isoDay } from './py.js';

// Lệnh CLI thay `python -m agents.kd_quote` / `agents.da_b2b` / `agents.kd_catalog` — cùng cờ, exit
// code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ nối.
// Kiểm tham số ở đây (lỗi ném trong hàm parse của nest-commander thoát 0). Exit kd_quote/kd_catalog:
// 0 ok · 1 bị chặn (problems/cổng/không thấy/lệch hash/chưa duyệt/ma trận lỗi) · 2 tham số sai / DB
// down / lỗi DB / tính năng tắt.

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** `--followups`: login dịch vụ `job` (Python `auth.bind_service("job")`) — ServiceBindError = từ chối. */
  jobConnect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  now?: () => Date;
  matrixFile?: string;
  goldenFile?: string;
  sourcesFile?: string;
  watchFile?: string;
};

const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

async function defaultJob(env: Env): Promise<DbLease | null> {
  const pool = await servicePool('job', env);
  try {
    await pool.query('select 1');
  } catch {
    await pool.end().catch(() => {});
    return null;
  }
  return { db: pool, release: () => pool.end() };
}

/** Mở kết nối + nối core trên đó; lỗi DB khi chạy → `[error] lỗi DB` exit 2 (Python psycopg.Error). */
async function withDb(
  d: CliDeps,
  io: Io,
  open: () => Promise<DbLease | null>,
  fn: (db: Db) => Promise<number>,
): Promise<number> {
  const lease = await open();
  if (lease === null) {
    io.err(NO_DB);
    return 2;
  }
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    return await fn(lease.db);
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${dbMsg(e)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

// ===================================================================== kd_quote
export type KdQuoteOpts = {
  checkMatrix?: string | boolean;
  requests?: boolean;
  quote?: string;
  export?: string;
  verifySend?: string[];
  outcome?: string[];
  followups?: boolean;
  by?: string;
  discount?: string;
  date?: string;
  outDir?: string;
  out?: string;
  submit?: boolean;
  dryRun?: boolean;
};

function printResult(io: Io, res: Classified): void {
  for (const ln of res.lines) {
    io.out(
      `  ${ln.key} ×${ln.qty} · CK ${ln.discount_pct}% · đơn giá ${vnd(ln.unit)} · thành tiền ${vnd(ln.amount)}`,
    );
  }
  const m = res.margin_pct;
  io.out(
    `  tổng ${vnd(res.total)} · giá vốn duyệt ${vnd(res.cogs_total)} · biên ${m === null ? 'chưa tính được' : `${m}%`}`,
  );
  io.out(
    `  phân loại: ${res.within_matrix ? 'TRONG ma trận' : 'per_item'} · reasons: ${res.reasons.join(', ') || '(không)'} · problems: ${res.problems.join(', ') || '(không)'}`,
  );
}

function checkMatrixCmd(io: Io, path: string, goldenFile: string): number {
  const [doc, why] = readMatrix(path);
  if (doc === null) {
    io.err(`[error] ${why}`);
    return 1;
  }
  const errs = validateMatrix(doc, readGolden(goldenFile)[0]);
  for (const e of errs) io.err(`[err] ${e}`);
  if (errs.length) {
    io.err(`[error] ma trận lỗi (${errs.length})`);
    return 1;
  }
  const fc = confirmed(doc.finance_confirmed) ? 'đã' : 'CHƯA';
  const sc = confirmed(doc.sales_confirmed) ? 'đã' : 'CHƯA';
  io.out(
    `[ok] ma trận v${doc.version} hợp lệ · ${Object.keys(doc.items as object).length} mã · ${(doc.tiers as unknown[]).length} bậc · tài chính ${fc} xác nhận · GĐ bán hàng ${sc} xác nhận (${doc.status})`,
  );
  return 0;
}

type QuoteArgs = {
  rid: bigint;
  discount: number | null;
  day: string | null;
  outDir: string;
  submit: boolean;
  dryRun: boolean;
};

async function quoteCmd(db: Db, a: QuoteArgs, d: CliDeps, io: Io): Promise<number> {
  const req = await fetchRequest(db, a.rid);
  if (req === null) {
    io.err(`[warn] không thấy yêu cầu YC-${a.rid}`);
    return 1;
  }
  // r12 RB: sales-05 tắt → chặn TRƯỚC khi in/ghi 3 file báo giá.
  const why = await blocked(db, 'báo giá B2B', FEATURE_FOLLOWUP);
  if (why) return sayBlocked(why, io.out);
  const [golden0, w1] = readGolden(d.goldenFile ?? GOLDEN_FILE);
  const [matrix, w2] = readMatrix(d.matrixFile ?? MATRIX_FILE);
  if (golden0 === null || matrix === null) {
    io.err(`[error] ${w1 || w2}`);
    return 1;
  }
  const day = a.day ?? vnDate((d.now ?? (() => new Date()))());
  const golden = approvedGolden(golden0, await goldenPrices(db, day));
  const combos = await dbCombos(db);
  const versions = await fetchVersions(db);
  const res = classify(req.items, matrix, golden, combos, versions, day, a.discount);
  io.out(`[quote] YC-${req.id} (${res.lines.length} dòng hợp lệ):`);
  printResult(io, res);
  if (res.problems.length) {
    io.err(
      `[error] bị chặn: ${res.problems.join(', ')} — KHÔNG sinh báo giá, KHÔNG vào hàng duyệt (rượu: GĐ xử lý ngoài hệ thống khi Pháp chế xác nhận)`,
    );
    return 1;
  }
  const built = buildQuote(req, res, golden, day, matrix);
  const errs = gateQuote(built.payload, alcoholNames(golden), readinessMap(golden), [
    built.quote_no,
  ]);
  if (errs.length) {
    io.err(
      `[error] cổng tài liệu đối ngoại chặn: ${errs.join(', ')} — GĐ bán hàng soạn tay (vd tên tổ chức chứa từ cấm)`,
    );
    return 1;
  }
  const qno = built.quote_no as string;
  if (a.dryRun) {
    io.out(`[dry-run] ${qno} — không ghi file, không vào hàng duyệt`);
    return 0;
  }
  for (const [name, body] of [
    [`bao-gia-${qno}.md`, built.payload],
    [`bao-gia-${qno}.html`, renderHtml(built.payload)],
    [`bao-gia-${qno}-noi-bo.md`, built.internal],
  ] as const) {
    // P8.4: nháp dựng từ yêu cầu B2B thật (b2b_requests không cột mẫu).
    io.out(`[file] ${await writeReport(body, a.outDir, name, false)}`);
  }
  if (!a.submit) {
    io.out(`[done] ${qno} — NHÁP; thêm --submit để vào hàng duyệt`);
    return 0;
  }
  let ids: bigint[];
  try {
    ids = await submitQuote(db, req, built, res);
  } catch (e) {
    if (!isUnique(e)) throw e;
    ids = [];
  }
  if (!ids.length) {
    io.out(`[skip] ${qno} đã có mục pending/đã duyệt — không ghi thêm`);
    return 0;
  }
  const lane = res.within_matrix
    ? `${OT_MATRIX} (risk low — chỉ tự đạt khi auto_policy đã ký)`
    : `${OT_QUOTE} (risk high — GĐ bán hàng duyệt)`;
  io.out(
    `[done] ${qno} → mục #${ids[0]} ${lane}${ids.length > 1 ? `; tài chính rà biên mục #${ids[1]}` : ''}. ${FOOTER}`,
  );
  return 0;
}

const errName = (e: unknown) =>
  e instanceof HumanError ? e.name : e instanceof RangeError ? 'ValueError' : 'DatabaseError';

/** `python -m agents.kd_quote` — KD-A3 báo giá B2B quà Tết: NHÁP; agent không tự duyệt, không tự gửi. */
export async function kdQuoteMain(o: KdQuoteOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`kd_quote: error: ${msg}`);
    return 2;
  };
  const rid = o.quote === undefined ? null : pyInt(o.quote);
  if (rid === null && o.quote !== undefined)
    return usage(`argument --quote: invalid int value: '${o.quote}'`);
  const eid = o.export === undefined ? null : pyInt(o.export);
  if (eid === null && o.export !== undefined)
    return usage(`argument --export: invalid int value: '${o.export}'`);
  for (const [k, v] of [
    ['--verify-send', o.verifySend],
    ['--outcome', o.outcome],
  ] as const) {
    if (v !== undefined && v.length !== 2) return usage(`argument ${k}: expected 2 arguments`);
  }
  let discount: number | null = null;
  if (o.discount !== undefined) {
    if (!/^[0-9]{1,2}$/.test(o.discount) || Number(o.discount) > MAX_DISCOUNT) {
      return usage(`argument --discount: CK phải số nguyên 0..${MAX_DISCOUNT}`);
    }
    discount = Number(o.discount);
  }
  const day = o.date === undefined ? null : isoDay(o.date);
  if (o.date !== undefined && day === null)
    return usage('argument --date: ngày phải dạng YYYY-MM-DD');
  const nOps =
    Number(o.checkMatrix !== undefined) +
    Number(Boolean(o.requests)) +
    Number(rid !== null) +
    Number(eid !== null) +
    Number(o.verifySend !== undefined) +
    Number(o.outcome !== undefined) +
    Number(Boolean(o.followups));
  if (nOps !== 1) {
    return usage(
      'cần đúng 1 thao tác: --check-matrix | --requests | --quote | --export | --verify-send | --outcome | --followups',
    );
  }
  if (rid === null && (discount !== null || day || o.submit)) {
    return usage('--discount/--date/--submit chỉ dùng với --quote');
  }
  if (o.dryRun && rid === null && !o.followups)
    return usage('--dry-run chỉ dùng với --quote hoặc --followups');
  if (o.by !== undefined && o.outcome === undefined && o.verifySend === undefined) {
    return usage('--by chỉ dùng với --outcome / --verify-send');
  }
  let oqid: bigint | null = null;
  if (o.outcome !== undefined) {
    const [q, kq] = o.outcome as [string, string];
    if (!/^[0-9]{1,18}$/.test(q) || !OUTCOMES.includes(kq)) {
      return usage(`--outcome QID KQ — QID số, KQ ${OUTCOMES.join('|')}`);
    }
    if (!pyStrip(o.by ?? '')) return usage('--outcome cần --by <tên người>');
    oqid = BigInt(q);
  }
  let jobLease: DbLease | null | undefined;
  if (o.followups) {
    try {
      jobLease = await (d.jobConnect ?? (() => defaultJob(env)))();
    } catch (e) {
      if (!(e instanceof ServiceBindError)) throw e;
      io.out(`[err] ${e.message}`);
      return 2;
    }
  }
  if (o.submit && o.dryRun) return usage('--submit và --dry-run loại trừ nhau');
  if ((eid !== null) !== (o.out !== undefined))
    return usage('--export cần --out FILE (.md|.html) và ngược lại');
  let vqid: bigint | null = null;
  if (o.verifySend !== undefined) {
    vqid = pyInt(o.verifySend[0]);
    if (vqid === null) return usage('--verify-send QID phải là số');
  }
  if (o.checkMatrix !== undefined) {
    const path = typeof o.checkMatrix === 'string' ? o.checkMatrix : (d.matrixFile ?? MATRIX_FILE);
    return checkMatrixCmd(io, path, d.goldenFile ?? GOLDEN_FILE);
  }
  const open = o.followups
    ? async () => jobLease ?? null
    : (d.connect ?? (() => connectDatabaseUrl(env)));
  return withDb(d, io, open, async (db) => {
    if (o.requests) {
      const { rows } = await db.query(
        'select id::text as id, org_name, org_type, region, jsonb_array_length(items) as n, created_at from b2b_requests order by id',
      );
      for (const r of rows) {
        io.out(
          `  YC-${r.id} · ${oneline(maskPii(r.org_name), 60)} · ${r.org_type} · ${r.region} · ${r.n} dòng · ${vnFormat(r.created_at, '%d/%m/%Y')}`,
        );
      }
      io.out(`[done] ${rows.length} yêu cầu báo giá`);
      return 0;
    }
    if (rid !== null) {
      return quoteCmd(
        db,
        {
          rid,
          discount,
          day,
          outDir: o.outDir ?? REPORTS_DIR,
          submit: Boolean(o.submit),
          dryRun: Boolean(o.dryRun),
        },
        d,
        io,
      );
    }
    if (eid !== null) {
      const [ok, msg] = await exportApproved(db, eid, o.out as string);
      if (!ok) {
        io.err(`[warn] ${msg}`);
        return 1;
      }
      io.out(
        `[done] xuất bản ĐÃ DUYỆT mục #${eid} → ${msg} (GĐ bán hàng tự gửi; chạy --verify-send trước khi gửi)`,
      );
      return 0;
    }
    if (oqid !== null) {
      const kind = (o.outcome as string[])[1] as string;
      // v15.4 (P10.2): ghi kết quả khách báo = NHẬP LIỆU (không đổi giá/đơn) — kiểm danh tính người ghi.
      const why = await cliIdentity(db, o.by, 'b2b_quote', oqid, { action: 'outcome', env });
      if (why) {
        io.err(`[từ chối] ${why} — không ghi`);
        return 1;
      }
      try {
        await recordEvent(db, oqid, kind, o.by);
      } catch (e) {
        if (e instanceof HumanDenied) {
          io.err(`[từ chối] ${e.message} — không ghi`);
          return 1;
        }
        if (e instanceof RangeError) {
          io.err(`[warn] ${e.message} — không ghi`);
          return 1;
        }
        throw e;
      }
      io.out(`[ok] mục #${oqid}: ghi kết quả '${OUTCOME_LABELS[kind]}' — dừng nhắc chốt đơn`);
      return 0;
    }
    if (o.followups) {
      let res: { found: number; enqueued: number };
      try {
        res = await runFollowups(
          db,
          (d.now ?? (() => new Date()))(),
          Boolean(o.dryRun),
          d.watchFile,
        );
      } catch (e) {
        if (e instanceof RolloutBlocked) {
          io.err(`[rollout] ${e.message}`);
          return 2;
        }
        if (e instanceof RangeError || e instanceof DirectorConfigError) {
          io.err(`[error] cấu hình lỗi: ${e.message}`);
          return 1;
        }
        throw e;
      }
      io.out(
        `[${o.dryRun ? 'dry-run' : 'followups'}] báo giá cần nhắc ${res.found} · đẩy ${res.enqueued} mục nhắc${o.dryRun ? ' — KHÔNG ghi DB' : ''} (hệ thống không tự liên hệ khách)`,
      );
      return 0;
    }
    const q = vqid as bigint;
    if (o.by !== undefined) {
      // v15.4 (P10.2): `--by` ghi mốc đã gửi = NHẬP LIỆU — kiểm danh tính.
      const why = await cliIdentity(db, o.by, 'b2b_quote', q, { action: 'verify_send', env });
      if (why) {
        io.err(`[từ chối] ${why} — không ghi`);
        return 1;
      }
    }
    if (await verifySend(db, q, (o.verifySend as string[])[1] as string)) {
      try {
        await recordEvent(db, q, 'da_gui', o.by ?? null);
      } catch (e) {
        if (e instanceof HumanDenied) {
          io.err(`[từ chối] ${e.message} — KHỚP bản duyệt nhưng không ghi mốc gửi`);
          return 1;
        }
        if (!(e instanceof RangeError) && !isDbError(e)) throw e;
        io.err(
          `[warn] KHỚP nhưng không ghi được mốc gửi (${errName(e)}) — nhắc chốt đơn tính từ lúc duyệt`,
        );
      }
      io.out(`[ok] mục #${q}: KHỚP bản đã duyệt — GĐ bán hàng tự gửi`);
      return 0;
    }
    io.err(`[warn] mục #${q}: LỆCH — KHÔNG gửi (chưa duyệt / sai loại / file khác bản duyệt)`);
    return 1;
  });
}

// ===================================================================== da_b2b
export type DaB2bOpts = {
  import?: string;
  submitBatch?: boolean;
  handover?: string;
  list?: boolean;
  by?: string;
  limit?: string;
  status?: string;
};

/** `python -m agents.da_b2b` — DA-05 tổ chức tiềm năng mua quà Tết: không PII, hệ thống KHÔNG tự
 * liên hệ. Exit: 0 ok · 1 CSV lỗi / lô chưa duyệt / lệch hash · 2 tham số sai / DB down / lỗi DB. */
export async function daB2bMain(o: DaB2bOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`da_b2b: error: ${msg}`);
    return 2;
  };
  const hq = o.handover === undefined ? null : pyInt(o.handover);
  if (hq === null && o.handover !== undefined) {
    return usage(`argument --handover: invalid int value: '${o.handover}'`);
  }
  const limit = o.limit === undefined ? 50n : pyInt(o.limit);
  if (limit === null) return usage(`argument --limit: invalid int value: '${o.limit}'`);
  if (o.status !== undefined && !STATUSES.includes(o.status)) {
    return usage(
      `argument --status: invalid choice: '${o.status}' (choose from 'moi', 'cho_duyet', 'chuyen_sales')`,
    );
  }
  const nOps =
    Number(o.import !== undefined) +
    Number(Boolean(o.submitBatch)) +
    Number(hq !== null) +
    Number(Boolean(o.list));
  if (nOps !== 1)
    return usage('cần đúng 1 thao tác: --import | --submit-batch | --handover | --list');
  const by = pyStrip(o.by ?? '');
  if ((o.import !== undefined || hq !== null) && !by)
    return usage('--import/--handover cần --by <tên người>');
  if (limit < 1n || limit > 200n) return usage('--limit phải trong 1..200');
  let rows: ReturnType<typeof readCsv>[0] | null = null;
  if (o.import !== undefined) {
    const [rs, errs] = readCsv(o.import, d.sourcesFile ?? SOURCES_FILE);
    if (errs.length) {
      for (const e of errs.slice(0, 50)) io.err(`[err] ${e}`);
      io.err(`[error] ${errs.length} lỗi — KHÔNG nạp dòng nào`);
      return 1;
    }
    rows = rs;
  }
  return withDb(d, io, d.connect ?? (() => connectDatabaseUrl(env)), async (db) => {
    if (rows !== null) {
      const st = await importRows(db, rows, by, `manual:${basename(o.import as string)}`);
      io.out(`[done] inserted=${st.inserted} dup=${st.dup}`);
      return 0;
    }
    if (o.submitBatch) {
      const [qid, n] = await submitBatch(db, Number(limit));
      if (qid === null) io.out("[done] không có lô (0 tổ chức 'moi')");
      else
        io.out(
          `[done] lô ${n} tổ chức → mục #${qid} (PENDING — GĐ dự án/GĐ bán hàng duyệt). ${B2B_FOOTER}`,
        );
      return 0;
    }
    if (hq !== null) {
      // v15.4 (P10.2): chuyển lô = THỰC THI mục đã duyệt — kiểm danh tính người chạy.
      const why = await cliIdentity(db, by, 'approval_queue', hq, { action: 'handover', env });
      if (why) {
        io.err(`[từ chối] ${why} — không đổi gì`);
        return 1;
      }
      let res: [boolean, string, number];
      try {
        res = await handover(db, hq, by);
      } catch (e) {
        if (!(e instanceof HumanDenied)) throw e;
        io.err(`[từ chối] ${e.message} — không đổi gì`);
        return 1;
      }
      const [ok, msg] = res;
      (ok ? io.out : io.err)(
        `[${ok ? 'done' : 'warn'}] ${msg} (người chạy: ${oneline(maskPii(by), 60)})`,
      );
      return ok ? 0 : 1;
    }
    const got = o.status
      ? await db.query(
          'select id::text as id, org_name, org_type, region, status from org_prospects where status = $1 order by id',
          [o.status],
        )
      : await db.query(
          'select id::text as id, org_name, org_type, region, status from org_prospects order by id',
        );
    for (const r of got.rows) {
      io.out(
        `  #${r.id} ${oneline(maskPii(r.org_name), 60)} · ${r.org_type} · ${r.region} · ${r.status}`,
      );
    }
    io.out(`[done] ${got.rows.length} tổ chức`);
    return 0;
  });
}

// ===================================================================== kd_catalog
export type KdCatalogOpts = {
  build?: boolean;
  submit?: boolean;
  export?: string;
  verifySend?: string[];
  bom?: string;
  date?: string;
  outDir?: string;
  packshotDir?: string;
  out?: string;
};

/** `python -m agents.kd_catalog` — catalog quà Tết B2B: NHÁP; không rượu, không TPBVSK chưa XNQC;
 * agent không tự gửi. */
export async function kdCatalogMain(o: KdCatalogOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`kd_catalog: error: ${msg}`);
    return 2;
  };
  const eid = o.export === undefined ? null : pyInt(o.export);
  if (eid === null && o.export !== undefined)
    return usage(`argument --export: invalid int value: '${o.export}'`);
  if (o.verifySend !== undefined && o.verifySend.length !== 2) {
    return usage('argument --verify-send: expected 2 arguments');
  }
  const day0 = o.date === undefined ? null : isoDay(o.date);
  if (o.date !== undefined && day0 === null)
    return usage('argument --date: ngày phải dạng YYYY-MM-DD');
  const nOps =
    Number(Boolean(o.build)) +
    Number(Boolean(o.submit)) +
    Number(eid !== null) +
    Number(o.verifySend !== undefined);
  if (nOps !== 1)
    return usage('cần đúng 1 thao tác: --build | --submit | --export | --verify-send');
  const gen = Boolean(o.build || o.submit);
  if (!gen && (o.bom || day0 || o.packshotDir))
    return usage('--bom/--date/--packshot-dir chỉ dùng với --build/--submit');
  if ((eid !== null) !== (o.out !== undefined))
    return usage('--export cần --out FILE (.md|.html) và ngược lại');
  let vqid: bigint | null = null;
  if (o.verifySend !== undefined) {
    vqid = pyInt(o.verifySend[0]);
    if (vqid === null) return usage('--verify-send QID phải là số');
  }
  let combos: unknown[] | null = null;
  let golden0: Record<string, unknown> | null = null;
  let matrix: Record<string, unknown> | null = null;
  if (gen) {
    const [g, w1] = readGolden(d.goldenFile ?? GOLDEN_FILE);
    const [m, w2] = readMatrix(d.matrixFile ?? MATRIX_FILE);
    if (g === null || m === null) {
      io.err(`[error] ${w1 || w2}`);
      return 1;
    }
    [golden0, matrix] = [g, m];
    if (o.bom !== undefined) {
      try {
        combos = readBom(o.bom).combos as unknown[];
      } catch (e) {
        if (!(e instanceof ProductionError)) throw e;
        io.err(`[error] BOM: ${e.message}`);
        return 1;
      }
    }
  }
  // r12 L2: --build luôn cần DB (giá price_list đã duyệt + readiness view) kể cả khi combo đọc từ --bom.
  return withDb(d, io, d.connect ?? (() => connectDatabaseUrl(env)), async (db) => {
    if (gen) {
      const why = await blocked(db, 'catalog B2B', FEATURE_FOLLOWUP);
      if (why) return sayBlocked(why, io.out); // r12 RB: trước khi ghi file
      const cb = combos ?? (await dbCombos(db));
      const day = day0 ?? vnDate((d.now ?? (() => new Date()))());
      const golden = approvedGolden(
        golden0 as Record<string, unknown>,
        await goldenPrices(db, day),
      );
      const readiness = await readinessFromDb(db);
      const built = buildCatalog(golden, cb, matrix, {
        day,
        packshotDir: o.packshotDir ?? null,
        readiness,
      });
      const shown = built.excluded
        .filter((e) => e.code !== 'ruou')
        .map((e) => `${e.key}(${e.code})`);
      io.out(
        `[catalog] ${built.n_items} mục · loại ${built.excluded.length}: ${shown.join(', ') || '—'} · rượu loại ${built.excluded.filter((e) => e.code === 'ruou').length}`,
      );
      if (built.problems.length) {
        io.err(`[error] bị chặn: ${built.problems.join(', ')}`);
        return 1;
      }
      if (o.build) {
        for (const [ext, body] of [
          ['md', built.payload],
          ['html', renderHtml(built.payload)],
        ] as const) {
          // P8.4: dựng từ golden master đã nạp + BOM — không có đường mẫu riêng của catalog.
          io.out(
            `[file] ${await writeReport(body, o.outDir ?? REPORTS_DIR, `catalog-tet-${day}.${ext}`, false)}`,
          );
        }
        io.out('[done] NHÁP — --submit để vào hàng duyệt; HTML → In → Lưu PDF');
        return 0;
      }
      let qid: bigint | null;
      try {
        qid = await catalogSubmit(db, built, day);
      } catch (e) {
        if (!isUnique(e)) throw e;
        qid = null;
      }
      if (qid === null) {
        io.out('[skip] catalog cùng nội dung đã có mục pending/đã duyệt — không ghi thêm');
        return 0;
      }
      io.out(
        `[done] catalog → mục #${qid} \`${OT_CATALOG}\` (risk high — GĐ bán hàng duyệt; hệ thống không tự gửi)`,
      );
      return 0;
    }
    if (eid !== null) {
      const [ok, msg] = await exportApproved(db, eid, o.out as string, CATALOG_TYPES);
      if (!ok) {
        io.err(`[warn] ${msg}`);
        return 1;
      }
      io.out(`[done] xuất catalog ĐÃ DUYỆT mục #${eid} → ${msg}`);
      return 0;
    }
    if (
      await verifySend(db, vqid as bigint, (o.verifySend as string[])[1] as string, CATALOG_TYPES)
    ) {
      io.out(`[ok] mục #${vqid}: KHỚP bản đã duyệt — GĐ bán hàng tự gửi`);
      return 0;
    }
    io.err(`[warn] mục #${vqid}: LỆCH — KHÔNG gửi`);
    return 1;
  });
}

// ===================================================================== nest-commander
const collect2 = (v: string, prev: string[] | undefined) => [...(prev ?? []), v];

@Command({
  name: 'kd-quote',
  description: 'KD-A3 báo giá B2B quà Tết — NHÁP; agent không tự duyệt, không tự gửi',
})
export class KdQuoteCommand extends CommandRunner {
  async run(_args: string[], opts: KdQuoteOpts): Promise<void> {
    process.exitCode = await kdQuoteMain(opts);
  }
  @Option({
    flags: '--check-matrix [file]',
    description: 'kiểm ma trận báo giá (mặc định data/b2b_pricing.json)',
  })
  parseCheckMatrix(v: string): string {
    return v;
  }
  @Option({ flags: '--requests', description: 'liệt kê yêu cầu báo giá' })
  parseRequests(): boolean {
    return true;
  }
  @Option({ flags: '--quote <req_id>', description: 'lập báo giá cho yêu cầu' })
  parseQuote(v: string): string {
    return v;
  }
  @Option({ flags: '--export <qid>', description: 'xuất bản ĐÃ duyệt (cần --out)' })
  parseExport(v: string): string {
    return v;
  }
  @Option({
    flags: '--verify-send <qid_file...>',
    description: 'QID FILE — file sắp gửi khớp bản duyệt?',
  })
  parseVerifySend(v: string, prev?: string[]): string[] {
    return collect2(v, prev);
  }
  @Option({
    flags: '--outcome <qid_kq...>',
    description: `QID KQ — ghi kết quả báo giá đã duyệt: ${OUTCOMES.join('|')} (cần --by)`,
  })
  parseOutcome(v: string, prev?: string[]): string[] {
    return collect2(v, prev);
  }
  @Option({
    flags: '--followups',
    description: 'đẩy NHÁP nhắc chốt đơn B2B vào hàng duyệt (v14.4)',
  })
  parseFollowups(): boolean {
    return true;
  }
  @Option({
    flags: '--by <name>',
    description: 'tên NGƯỜI (bắt buộc với --outcome; tùy chọn với --verify-send)',
  })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--discount <pct>' })
  parseDiscount(v: string): string {
    return v;
  }
  @Option({ flags: '--date <d>' })
  parseDate(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--out <file>' })
  parseOut(v: string): string {
    return v;
  }
  @Option({ flags: '--submit' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'da-b2b',
  description: 'DA-05 tổ chức tiềm năng mua quà Tết — không PII, hệ thống KHÔNG tự liên hệ',
})
export class DaB2bCommand extends CommandRunner {
  async run(_args: string[], opts: DaB2bOpts): Promise<void> {
    process.exitCode = await daB2bMain(opts);
  }
  @Option({ flags: '--import <file>' })
  parseImport(v: string): string {
    return v;
  }
  @Option({ flags: '--submit-batch' })
  parseSubmitBatch(): boolean {
    return true;
  }
  @Option({ flags: '--handover <queue_id>' })
  parseHandover(v: string): string {
    return v;
  }
  @Option({ flags: '--list' })
  parseList(): boolean {
    return true;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--limit <n>' })
  parseLimit(v: string): string {
    return v;
  }
  @Option({ flags: '--status <status>' })
  parseStatus(v: string): string {
    return v;
  }
}

@Command({
  name: 'kd-catalog',
  description: 'Catalog quà Tết B2B — NHÁP; không rượu, không TPBVSK chưa XNQC; agent không tự gửi',
})
export class KdCatalogCommand extends CommandRunner {
  async run(_args: string[], opts: KdCatalogOpts): Promise<void> {
    process.exitCode = await kdCatalogMain(opts);
  }
  @Option({ flags: '--build' })
  parseBuild(): boolean {
    return true;
  }
  @Option({ flags: '--submit' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--export <qid>' })
  parseExport(v: string): string {
    return v;
  }
  @Option({ flags: '--verify-send <qid_file...>' })
  parseVerifySend(v: string, prev?: string[]): string[] {
    return collect2(v, prev);
  }
  @Option({
    flags: '--bom <file>',
    description: 'đọc combo từ file BOM (không DB) thay bom_combos',
  })
  parseBom(v: string): string {
    return v;
  }
  @Option({ flags: '--date <d>' })
  parseDate(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
  @Option({ flags: '--packshot-dir <dir>' })
  parsePackshotDir(v: string): string {
    return v;
  }
  @Option({ flags: '--out <file>' })
  parseOut(v: string): string {
    return v;
  }
}
