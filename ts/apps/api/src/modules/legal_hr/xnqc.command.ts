import { readFileSync } from 'node:fs';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { dmy, vnDate } from '@samsam/core/ops/period';
import { pyOsName } from '@samsam/core/ops/py-json';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { cliGate, HumanDenied } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, isDigit, pyRepr } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import { byError, CONFIG, loadConfig as loadPhapChe, safe } from '../ra_kenh/ra-kenh.js';
import { type DbLease, type Io, STD_IO } from './common.js';
import {
  add,
  draft,
  LOAI,
  listDossiers,
  type RemindCfg,
  reminders,
  STATUSES,
  setStatus,
  syncGolden,
  syncNotes,
  tpbvskSkus,
  xDate,
} from './xnqc.js';

// Lệnh CLI thay `python -m agents.xnqc` — cùng cờ, exit code, thông điệp chính:
//   xnqc --add --sku K --loai maket --ten "maket fanpage" --by "<tên>"
//   xnqc --set ID --status da_nop --ngay-nop 2026-11-20 --by "<tên>"
//   xnqc --set ID --status da_cap --so-giay X --ngay-cap D --doc-sha SHA --by "<tên>" [--het-han D]
//   xnqc --list | --remind [--today D] | --sync-golden [--today D]
//   xnqc --draft --sku K --loai L --ten T [--maket FILE] [--submit]
// `--today` CHỈ cho `--remind`/`--sync-golden`; `--set`/`--add` dùng ngày thật (giờ VN) — chống đẩy
// "hôm nay" tới trước để ghi ngày cấp/nộp tương lai. `--set` (kể cả da_cap) = QUYẾT ĐỊNH của Pháp chế
// → `cliGate` khối legal_hr TRƯỚC khi ghi; DB kiểm lại danh tính theo login (`*_human`).
// Exit 0 ok · 1 bị từ chối (chuyển sai, thiếu điều kiện, SKU lạ, quyền) · 2 usage (ngày sai ISO, >1
// thao tác, `--by` không hợp lệ, `--today` với thao tác ghi — kiểm TRƯỚC connect) / cấu hình hỏng /
// DB không truy cập được.

export type XnqcOpts = {
  add?: boolean;
  set?: string;
  list?: boolean;
  remind?: boolean;
  syncGolden?: boolean;
  sku?: string;
  loai?: string;
  ten?: string;
  status?: string;
  by?: string;
  soGiay?: string;
  ngayNop?: string;
  ngayCap?: string;
  hetHan?: string;
  docSha?: string;
  today?: string;
  draft?: boolean;
  maket?: string;
  submit?: boolean;
};

export type XnqcDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  /** Ngày VN thật (test thay). */
  today?: () => string;
  goldenFile?: string;
  claimsFile?: string;
  draftFile?: string;
  directorsDir?: string;
  phapCheFile?: string;
};

const NO_DB = '[err] DB không truy cập được';
const choices = (xs: string[]) => xs.map(pyRepr).join(', ');

/** Python `type(e).__name__` cho lỗi bắt ở đỉnh (`psycopg.Error`, `ValueError`) | null (không bắt). */
function caughtName(e: unknown): string | null {
  if (isDbError(e)) return pgErrName(e);
  if (e instanceof RolloutBlocked) return 'RolloutBlocked';
  if (e instanceof HumanDenied) return 'HumanDenied';
  if (e instanceof RangeError) return 'ValueError';
  return null;
}

/** Python `Path(f).read_text(encoding="utf-8")[:5000]` (xuống dòng chuẩn hóa \n, BOM giữ nguyên). */
function readMaket(path: string): string {
  const raw = readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  return cpHead(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n'), 5000);
}

export async function xnqcMain(a: XnqcOpts, d: XnqcDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`xnqc: error: ${msg}`);
    return 2;
  };
  const connect = d.connect ?? (() => connectDatabaseUrl(env));
  const wire = d.wire ?? ((db: Db) => void wireCore(db));
  if (a.loai !== undefined && !LOAI.includes(a.loai)) {
    return usage(
      `argument --loai: invalid choice: ${pyRepr(a.loai)} (choose from ${choices(LOAI)})`,
    );
  }
  if (a.status !== undefined && !STATUSES.includes(a.status)) {
    return usage(
      `argument --status: invalid choice: ${pyRepr(a.status)} (choose from ${choices(STATUSES)})`,
    );
  }
  const nOps = [a.add, a.set !== undefined, a.list, a.remind, a.syncGolden, a.draft].filter(
    Boolean,
  ).length;
  if (nOps !== 1) {
    return usage(
      'chọn đúng 1 thao tác: --add | --set | --list | --remind | --sync-golden | --draft',
    );
  }
  if ((a.maket || a.submit) && !a.draft) return usage('--maket/--submit chỉ đi với --draft');
  if (a.draft) {
    if (!(a.sku && a.loai && a.ten)) return usage('--draft cần --sku --loai --ten');
    let maket: string | null = null;
    if (a.maket) {
      try {
        maket = readMaket(a.maket);
      } catch (e) {
        // KHÁC Python (sạch hơn): file không phải UTF-8 → usage exit 2 (Python vỡ traceback).
        const name = e instanceof TypeError ? 'UnicodeDecodeError' : pyOsName(e);
        return usage(`--maket không đọc được (${name})`);
      }
    }
    const lease = a.submit ? await connect() : null;
    if (a.submit && lease === null) {
      io.out(NO_DB);
      return 2;
    }
    let payload: string;
    let qid: bigint | null;
    try {
      if (lease) wire(lease.db);
      [payload, qid] = await draft(
        lease?.db ?? null,
        a.sku,
        a.loai,
        a.ten,
        maket,
        Boolean(a.submit),
        {
          io,
          goldenFile: d.goldenFile,
          claimsFile: d.claimsFile,
          draftFile: d.draftFile,
          directorsDir: d.directorsDir,
        },
      );
    } catch (e) {
      if (isDbError(e)) {
        io.out(`[err] lỗi DB: ${dbMsg(e)}`);
        return 2;
      }
      if (e instanceof RangeError) {
        io.out(`[err] ${e.message}`);
        return 1;
      }
      throw e;
    } finally {
      await lease?.release().catch(() => {});
    }
    io.out(payload);
    if (qid !== null) io.out(`[ok] nháp hồ sơ → hàng duyệt legal_hr #${qid}`);
    return 0;
  }
  if (a.today !== undefined && !(a.remind || a.syncGolden)) {
    // đẩy "hôm nay" tới trước = lách chặn ngày cấp/nộp tương lai
    return usage('--today chỉ đi với --remind/--sync-golden — --set/--add dùng ngày thật');
  }
  let today: string;
  try {
    today = xDate(a.today, '--today') ?? (d.today ?? (() => vnDate(new Date())))();
    for (const [v, w] of [
      [a.ngayNop, '--ngay-nop'],
      [a.ngayCap, '--ngay-cap'],
      [a.hetHan, '--het-han'],
    ] as const) {
      xDate(v, w);
    }
  } catch (e) {
    return usage((e as Error).message);
  }
  if (a.add || a.set !== undefined) {
    const err = byError(a.by);
    if (err) return usage(err);
  }
  if (a.add && !(a.sku && a.loai && a.ten)) return usage('--add cần --sku --loai --ten --by');
  const setId = a.set;
  if (setId !== undefined && (a.status === undefined || !setId || ![...setId].every(isDigit))) {
    return usage('--set cần ID số và --status');
  }
  let cfg: RemindCfg | null = null;
  let tp: string[] = [];
  if (a.remind) {
    try {
      cfg = loadPhapChe(d.phapCheFile ?? CONFIG);
      tp = tpbvskSkus(d.goldenFile);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      io.out(`[err] cấu hình: ${e.message}`);
      return 2;
    }
  }
  const lease = await connect();
  if (lease === null) {
    io.out(NO_DB);
    return 2;
  }
  const db = lease.db;
  try {
    wire(db);
    if (a.add) {
      let did: string;
      try {
        did = await add(db, a.sku as string, a.loai as string, a.ten, a.by as string, env);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        io.out(`[err] ${e.message}`);
        return 1;
      }
      io.out(`[ok] hồ sơ #${did} (${a.sku}, ${a.loai}) — chuan_bi`);
      return 0;
    }
    if (setId !== undefined) {
      // v14.2: đổi trạng thái hồ sơ (kể cả da_cap) = quyết định của Pháp chế được Bên B ủy quyền
      // (cliGate, khối legal_hr).
      const why = await cliGate(db, a.by, 'legal_hr', 'set_status', 'xnqc_dossier', setId, {
        env,
        warn: io.err,
      });
      if (why) {
        io.out(`[từ chối] ${why}`);
        return 1;
      }
      const [ok, msg] = await setStatus(db, setId, a.status as string, a.by as string, {
        so_giay: a.soGiay,
        ngay_nop: a.ngayNop,
        ngay_cap: a.ngayCap,
        ngay_het_han: a.hetHan,
        doc_sha: a.docSha,
        today,
        goldenFile: d.goldenFile,
        directorsDir: d.directorsDir,
        env,
      });
      io.out((ok ? '[ok] ' : '[từ chối] ') + msg);
      return ok ? 0 : 1;
    }
    if (a.list) {
      const rows = await listDossiers(db);
      io.out(`[xnqc] ${rows.length} hồ sơ`);
      for (const r of rows) {
        io.out(
          `#${r.id} ${r.sku_key} ${r.loai_ho_so} [${r.status}] ${cpHead(maskPii(safe(r.ten_ho_so)), 80)}` +
            ` — số giấy ${safe(r.so_giay || '—')}, nộp ${r.ngay_nop || '—'}, cấp ${r.ngay_cap || '—'},` +
            ` hết hạn ${r.ngay_het_han || '—'} — bởi ${safe(r.updated_by)}`,
        );
      }
      return 0;
    }
    if (a.remind) {
      const ms = reminders(await listDossiers(db), tp, cfg as RemindCfg, today);
      io.out(`[xnqc] nhắc mốc ngày ${dmy(today)} — ${ms.length} mục`);
      for (const m of ms) io.out(`- ${m}`);
      return 0;
    }
    const ids = await syncGolden(db, today, undefined, {
      goldenFile: d.goldenFile,
      directorsDir: d.directorsDir,
    });
    io.out(`[ok] đề xuất đồng bộ golden mới: ${ids.length ? `[${ids.join(', ')}]` : 'không có'}`);
    for (const m of await syncNotes(db, today, d.goldenFile)) io.out(`- ${m}`);
    return 0;
  } catch (e) {
    const name = caughtName(e);
    if (name === null) throw e;
    const msg = isDbError(e) ? dbMsg(e) : (e as Error).message;
    io.out(`[err] ${name}: ${cpHead(safe(maskPii(msg)), 200)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

@Command({
  name: 'xnqc',
  description:
    'PC-A1 sổ hồ sơ XNQC theo SKU + nhắc mốc + đề xuất đồng bộ golden. da_cap CHỈ do người (Pháp chế) xác nhận.',
})
export class XnqcCommand extends CommandRunner {
  async run(_args: string[], opts: XnqcOpts): Promise<void> {
    process.exitCode = await xnqcMain(opts);
  }
  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({ flags: '--add', description: 'thêm hồ sơ chuan_bi' })
  parseAdd(): boolean {
    return true;
  }
  @Option({ flags: '--set <id>', description: 'đổi trạng thái hồ sơ' })
  parseSet(v: string): string {
    return v;
  }
  @Option({ flags: '--list' })
  parseList(): boolean {
    return true;
  }
  @Option({ flags: '--remind', description: 'nhắc mốc đợt 2 + giấy sắp hết hạn' })
  parseRemind(): boolean {
    return true;
  }
  @Option({
    flags: '--sync-golden',
    description: 'đề xuất đồng bộ xnqc_status golden vào hàng duyệt',
  })
  parseSyncGolden(): boolean {
    return true;
  }
  @Option({ flags: '--sku <sku>' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--loai <loai>', description: LOAI.join(' | ') })
  parseLoai(v: string): string {
    return v;
  }
  @Option({ flags: '--ten <ten>' })
  parseTen(v: string): string {
    return v;
  }
  @Option({ flags: '--status <status>', description: STATUSES.join(' | ') })
  parseStatus(v: string): string {
    return v;
  }
  @Option({ flags: '--by <ten>', description: 'tên NGƯỜI (không agent:/system:)' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--so-giay <so>' })
  parseSoGiay(v: string): string {
    return v;
  }
  @Option({ flags: '--ngay-nop <d>' })
  parseNgayNop(v: string): string {
    return v;
  }
  @Option({ flags: '--ngay-cap <d>' })
  parseNgayCap(v: string): string {
    return v;
  }
  @Option({ flags: '--het-han <d>' })
  parseHetHan(v: string): string {
    return v;
  }
  @Option({ flags: '--doc-sha <sha>' })
  parseDocSha(v: string): string {
    return v;
  }
  @Option({
    flags: '--today <d>',
    description: 'ngày YYYY-MM-DD CHỈ cho --remind/--sync-golden (mặc định hôm nay giờ VN)',
  })
  parseToday(v: string): string {
    return v;
  }
  @Option({
    flags: '--draft',
    description: 'soạn NHÁP hồ sơ XNQC (--sku --loai --ten [--maket FILE] [--submit])',
  })
  parseDraft(): boolean {
    return true;
  }
  @Option({ flags: '--maket <file>', description: 'file .txt/.md maket/kịch bản (--draft)' })
  parseMaket(v: string): string {
    return v;
  }
  @Option({ flags: '--submit', description: '--draft: đẩy nháp vào hàng duyệt legal_hr' })
  parseSubmit(): boolean {
    return true;
  }
}
