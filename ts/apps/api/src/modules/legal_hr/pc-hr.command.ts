import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
  submit,
} from '@samsam/core/ops/director';
import { addDays, vnDate } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, cliEntry, sayBlocked } from '@samsam/core/rollout/rollout';
import { check } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { Command, CommandRunner, Option } from 'nest-commander';
import { MAX_PRINT_ERRS, parseMonth } from '../fin_ar_pnl/fin-common.js';
import { clean } from '../intel_import/table.js';
import { type DbLease, type Io, isUnique, STD_IO } from './common.js';
import {
  BLOCK,
  CREATED_BY,
  fmtDay,
  HrConfigError,
  insideRepo,
  loadPosition,
  loadRules,
  monthEnd,
  type Position,
  positionSha,
  type Rules,
  rank,
  readAttendance,
  readCvs,
  renderAttendance,
  renderJd,
  renderScreening,
  sha12,
  summarize,
} from './pc-hr.js';

// Lệnh CLI thay `python -m agents.pc_hr` — cùng cờ, exit code, thông điệp chính:
//   pc-hr --jd <vi_tri> [--dry-run]
//   pc-hr --screen --jd <vi_tri> [--dir D] [--dry-run]     (mặc định env HR_INBOX_DIR, NGOÀI repo)
//   pc-hr --attendance F --month YYYY-MM [--dry-run]
// Exit: 0 ok / đã có mục chờ · 1 file/cấu hình/guardrail lỗi · 2 tham số sai / DB down / tính năng
// TẮT. Tham số sai → `pc_hr: error: …` TRƯỚC mọi kết nối (Python argparse). Mỗi lệnh con là 1 tính
// năng (legal_hr-06.1/06.2/06.3) — TẮT → chặn trước khi đọc CV/file. `--dry-run`: in payload,
// không connect DB. Agent chỉ đề xuất → hàng duyệt khối legal_hr (không tự duyệt/gửi).

export type PcHrOpts = {
  jd?: string;
  screen?: boolean;
  dir?: string;
  attendance?: string;
  month?: string;
  dryRun?: boolean;
};

type GuardrailLike = { ok?: unknown; violations?: unknown };

export type PcHrDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  /** Ngày VN hôm nay (Python `_today`, test thay). */
  today?: () => string;
  /** Python `guardrail_check` (test thay). */
  guardrail?: (text: string) => GuardrailLike;
  jdFile?: string;
  rulesFile?: string;
  directorsDir?: string;
};

const FEATURE = { jd: 'legal_hr-06.1', screen: 'legal_hr-06.2', attendance: 'legal_hr-06.3' };

function printErrs(io: Io, errs: string[]): void {
  for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
  if (errs.length > MAX_PRINT_ERRS) io.out(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
  io.out(`[err] ${errs.length} lỗi — không connect, không ghi gì.`);
}

async function main(o: PcHrOpts, d: PcHrDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`pc_hr: error: ${msg}`);
    return 2;
  };
  const today = (d.today ?? (() => vnDate(new Date())))();
  let op: 'jd' | 'screen' | 'attendance';
  if (o.attendance !== undefined) {
    if (o.screen || o.jd) return usage('--attendance không dùng chung với --jd/--screen');
    op = 'attendance';
  } else if (o.screen) {
    if (!o.jd) return usage('--screen cần --jd <vi_tri>');
    op = 'screen';
  } else if (o.jd) {
    op = 'jd';
  } else {
    return usage('cần --jd VI_TRI | --screen --jd VI_TRI | --attendance FILE --month YYYY-MM');
  }
  if (op !== 'attendance' && o.month) return usage('--month chỉ dùng với --attendance');
  if (op !== 'screen' && o.dir !== undefined) return usage('--dir chỉ dùng với --screen');
  let month: string | null = null;
  if (op === 'attendance') {
    month = parseMonth(o.month);
    if (month === null) return usage('cần --month YYYY-MM (tháng 01..12)');
    if (month > today) return usage(`tháng ${fmtDay(month, '%m/%Y')} chưa bắt đầu`);
  }
  let cvDir: string | null = null;
  if (op === 'screen') {
    cvDir = o.dir !== undefined ? o.dir : env.HR_INBOX_DIR ? env.HR_INBOX_DIR : null;
    if (cvDir === null) return usage('cần --dir hoặc env HR_INBOX_DIR (thư mục CV ngoài repo)');
    if (insideRepo(cvDir)) {
      return usage(
        'thư mục CV nằm TRONG repo — CV có dữ liệu cá nhân, đặt ngoài repo (HR_INBOX_DIR)',
      );
    }
  }

  // r12 RB: mỗi lệnh con là 1 tính năng — tắt → chặn trước khi đọc CV/file.
  const why = await blocked(null, 'nhân sự PC-HR', FEATURE[op]);
  if (why) return sayBlocked(why, io.out);
  let dcfg: DirectorConfig;
  let rules: Rules | null = null;
  let pos: Position | null = null;
  try {
    dcfg = loadConfig(BLOCK, d.directorsDir);
    if (op === 'attendance') rules = loadRules(d.rulesFile);
    else pos = loadPosition(o.jd as string, d.jdFile);
  } catch (e) {
    if (!(e instanceof HrConfigError || e instanceof DirectorConfigError)) throw e;
    io.out(`[err] cấu hình: ${e.message} — không connect.`);
    return 1;
  }

  let payload: string;
  let otype: string;
  let oid: string;
  let title: string;
  if (op === 'jd') {
    const p = pos as Position;
    payload = renderJd(p);
    otype = 'hr_jd';
    oid = `jd:${p.key}:${sha12(payload)}`;
    title = `Nháp mô tả công việc: ${p.raw.ten}`;
  } else if (op === 'screen') {
    const p = pos as Position;
    const [cands, skipped, err0] = readCvs(cvDir as string);
    const err = err0 === null && !cands.length ? 'không có hồ sơ .txt/.md nào trong thư mục' : err0;
    if (err) {
      io.out(`[err] ${err} — không connect.`);
      return 1;
    }
    const ranked = rank(p, cands);
    for (const c of ranked) {
      const names = c.files.map((n) => clean(maskPii(n), 80)).join(', ');
      io.out(`[map] ${c.ma} ← ${names}  (chỉ hiện trên máy người chạy)`);
    }
    payload = renderScreening(p, ranked, skipped);
    const key = sha12(
      ranked
        .map((c) => c.ma)
        .sort(cpCmp)
        .join('\n') + positionSha(p),
    );
    otype = 'hr_screening';
    oid = `screen:${p.key}:${key}`;
    title = `Sàng lọc hồ sơ ${p.raw.ten}: ${ranked.length} hồ sơ (xếp hạng, không tự loại)`;
  } else {
    const m = month as string;
    const [rows, errs, sha] = await readAttendance(o.attendance as string, m, today);
    if (errs.length) {
      printErrs(io, errs);
      return 1;
    }
    const end = monthEnd(m);
    const yday = addDays(today, -1);
    // biome-ignore lint/complexity/useMathMinMax: ngày dạng chuỗi 'YYYY-MM-DD' — Math.min ra NaN
    const until = end < yday ? end : yday;
    const stats = summarize(rows, m, rules as Rules, until);
    payload = renderAttendance(m, stats, rules as Rules, until, sha as string);
    otype = 'hr_attendance';
    oid = `att:${fmtDay(m, '%Y-%m')}:${(sha as string).slice(0, 12)}`;
    title = `Chấm công ${fmtDay(m, '%m/%Y')}: ${stats.size} mã NV (tổng hợp, chờ duyệt)`;
  }

  // Guardrail TRƯỚC khi đẩy: vi phạm → exit 1, không đẩy.
  const g = (d.guardrail ?? check)(payload);
  if (!g.ok) {
    const vs = Array.isArray(g.violations) ? (g.violations as Record<string, unknown>[]) : [];
    const kinds = [...new Set(vs.map((v) => String(v.type ?? '?')))].sort(cpCmp);
    io.out(`[err] nội dung không qua guardrail (${kinds.join(', ')}) — sửa mẫu, không đẩy.`);
    return 1;
  }
  if (o.dryRun) {
    io.out(payload);
    io.out(`[dry-run] ${otype} \`${oid}\` — không connect, không ghi gì.`);
    return 0;
  }

  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  let qid: bigint;
  try {
    (d.wire ?? ((db: Db) => void wireCore(db)))(lease.db);
    qid = await submit(lease.db, {
      block: BLOCK,
      objectType: otype,
      objectId: oid,
      title,
      payload,
      createdBy: CREATED_BY,
      cfg: dcfg,
    });
  } catch (e) {
    if (isUnique(e)) {
      io.out(`[skip] đã có mục ${otype} \`${oid}\` đang chờ duyệt — không đẩy trùng.`);
      return 0;
    }
    if (isDbError(e)) {
      io.err(`[error] DB: ${dbMsg(e)}`);
      return 2;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(
    `[submit] ${otype} → mục hàng duyệt #${qid} (khối ${BLOCK}, chờ Chuyên viên pháp chế duyệt — agent không tự duyệt/gửi)`,
  );
  return 0;
}

/** RolloutBlocked lọt tới đỉnh (vd khi đẩy hàng duyệt) → `[rollout] lý do`, exit 2 (Python `cli_entry`). */
export const pcHrMain = cliEntry(main);

@Command({
  name: 'pc-hr',
  description:
    'PC-HR: nháp mô tả công việc, xếp hạng hồ sơ, tổng hợp chấm công → hàng duyệt khối legal_hr (agent chỉ đề xuất)',
})
export class PcHrCommand extends CommandRunner {
  async run(_args: string[], opts: PcHrOpts): Promise<void> {
    process.exitCode = await pcHrMain(opts);
  }
  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({ flags: '--jd <vi_tri>' })
  parseJd(v: string): string {
    return v;
  }
  @Option({ flags: '--screen' })
  parseScreen(): boolean {
    return true;
  }
  @Option({ flags: '--dir <thu_muc_cv>' })
  parseDir(v: string): string {
    return v;
  }
  @Option({ flags: '--attendance <file>' })
  parseAttendance(v: string): string {
    return v;
  }
  @Option({ flags: '--month <yyyy_mm>', description: 'YYYY-MM (với --attendance)' })
  parseMonth(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}
