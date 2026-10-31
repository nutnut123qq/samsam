import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, run as directorRun } from '@samsam/core/ops/director';
import { REPORTS_DIR } from '@samsam/core/ops/report';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import * as ar from './acc-ar.js';
import { FPA_CONFIG_FILE, fmtDay, readConfig, vnd } from './fin-common.js';
import { NO_COGS, type PnlResult, compute as pnlCompute } from './fp-pnl.js';

// Port `agents/fin_director.py` (v9.1 FIN-Director, WP12) — bản tin TUẦN cho GĐ tài chính: gom công nợ
// đại lý quá hạn (ACC-AR) + P&L tháng (FP-COGS-PnL) + chi phí vận hành so trần (FP-OpsCost) + dòng
// tiền 13 tuần (FP-Cash) + số đề xuất ngân sách ads chờ duyệt → `director.run(..., extra)` →
// `data/reports/director-finance-<ngày>.md`. KHÔNG gửi, KHÔNG LLM/mạng — chỉ gọi lại hàm của agent
// nhân viên. Mỗi mục lỗi dữ liệu → "(chưa có dữ liệu: <lý do ngắn>)", bản tin vẫn ra.
// Cùng tên file với `acc-ar --bulletin` (bản hằng ngày): bản tuần là SUPERSET — chạy sau ghi đè.
// Nguồn FP-OpsCost/FP-Cash thuộc nhóm fin_cash: bước tích hợp nối qua `setFinSources` (chưa nối →
// mục đó "(chưa có dữ liệu: …)" — fail-closed, không bịa số).

export const H_AR = '## Công nợ đại lý quá hạn';
export const H_ADS = '## Đề xuất ngân sách ads';
/** `fp_cash.NO_OPENING` (nhóm fin_cash). */
export const NO_OPENING = 'chưa có số dư đầu kỳ thật — số dư = dòng tiền ròng lũy kế từ 0';

export const hPnl = (month: string): string => `## P&L tháng ${fmtDay(month, '%m/%Y')}`;
export const hOps = (month: string): string =>
  `## Chi phí vận hành tháng ${fmtDay(month, '%m/%Y')}`;
export const hCash = (weeks: number): string => `## Dòng tiền ${weeks} tuần`;

export function nodata(heading: string, why: string): string[] {
  return [heading, '', `(chưa có dữ liệu: ${oneline(why, 120)})`];
}

// ---------------------------------------------------------------- nguồn nhóm fin_cash

/** `fp_opscost.load_cfg()` (đã kiểm). */
export type OpsCfg = { warn_pct: number; stop_pct: number; threshold_x_vnd: number } & Record<
  string,
  unknown
>;
/** `fp_opscost.summary(...)` — phần bản tin dùng. */
export type OpsSummary = {
  alerts: { scope: string; level: number; label: string; spent: number; budget: number }[];
  over: [unknown, string][];
};
/** `fp_cash.run(...)` — phần bản tin dùng (ngày 'YYYY-MM-DD'). */
export type CashForecast = {
  weeks: { week_start: string; close: { low: number; base: number; high: number } }[];
  warn_weeks: string[];
  min_balance_vnd: number;
  opening: number | null;
};

export type FinSources = {
  /** `fp_opscost.load_cfg` + `summary(conn, month, cfg, load_users())`; cấu hình lỗi → RangeError(lý do). */
  ops: (db: Db, month: string, fpaConfig: string) => Promise<{ cfg: OpsCfg; summary: OpsSummary }>;
  /** `fp_cash.load_inputs` + `run(measure(conn, as_of), …)`; lỗi giả định → RangeError(lý do). */
  cash: (db: Db, asOf: string, fpaConfig: string) => Promise<CashForecast>;
  /** `fp_cash.load_cfg()` hợp lệ → số tuần; lỗi → null (tiêu đề mặc định 13 tuần). */
  cashWeeks: (fpaConfig: string) => number | null;
};

const NOT_WIRED = 'chưa nối nguồn nhóm fin_cash (bước tích hợp)';

/** Mặc định khi chưa nối: đọc ĐÚNG mục cấu hình (thiếu mục → lý do như Python), còn lại fail-closed. */
const DEFAULT_SOURCES: FinSources = {
  ops: async (_db, _m, path) => {
    const [, why] = readConfig('opscost', path);
    throw new RangeError(why ?? `fp_opscost ${NOT_WIRED}`);
  },
  cash: async (_db, _d, path) => {
    const [, why] = readConfig('cash', path);
    throw new RangeError(why ?? `fp_cash ${NOT_WIRED}`);
  },
  cashWeeks: () => null,
};

let sources: FinSources = DEFAULT_SOURCES;

/** Bước tích hợp: nối hàm của nhóm fin_cash (null → mặc định fail-closed). */
export function setFinSources(s: Partial<FinSources> | null): void {
  sources = s === null ? DEFAULT_SOURCES : { ...DEFAULT_SOURCES, ...s };
}

// ---------------------------------------------------------------- mục bản tin (thuần)

export function pnlSection(
  res: Pick<PnlResult, 'month' | 'loai' | 'tong_thuc_nhan' | 'tong_lai_gop' | 'n_rows'>,
): string[] {
  const loai = res.loai;
  return [
    hPnl(res.month),
    '',
    `- Tổng thực nhận: ${vnd(res.tong_thuc_nhan)} (${res.n_rows} dòng quyết toán trong tháng)`,
    `- Tổng lãi gộp (chỉ ô có giá vốn duyệt): ${vnd(res.tong_lai_gop)}`,
    `- ${loai.length} SKU ${NO_COGS}: ${loai.length ? loai.map((s) => `\`${s}\``).join(', ') : '(không có)'}`,
    `- BẢN NHÁP — chi tiết: \`python -m agents.fp_pnl --pnl --month ${fmtDay(res.month, '%Y-%m')}\``,
  ];
}

export function opsSection(month: string, s: OpsSummary, cfg: OpsCfg): string[] {
  const L = [hOps(month), ''];
  if (s.alerts.length) {
    for (const a of s.alerts) {
      L.push(`- [${a.label} ${a.level}%] \`${a.scope}\`: ${vnd(a.spent)} / trần ${vnd(a.budget)}`);
    }
  } else L.push(`- Không phạm vi nào chạm ${cfg.warn_pct}%/${cfg.stop_pct}% trần`);
  const wait = s.over.filter(([, st]) => st === 'cho_tgd_ky').length;
  L.push(
    `- Khoản > ngưỡng X (${vnd(cfg.threshold_x_vnd)}) đang chờ TGĐ ký: ${wait}`,
    '- Trần/ngưỡng là GIẢ ĐỊNH (`data/fpa_config.json`) — agent không chi, không tắt key',
  );
  return L;
}

export function cashSection(fc: CashForecast): string[] {
  const weeks = fc.weeks;
  const warn = fc.warn_weeks;
  const lastW = weeks[weeks.length - 1] as CashForecast['weeks'][number];
  const last = lastW.close;
  const L = [
    hCash(weeks.length),
    '',
    `- Tuần đầu tiên số dư kịch bản thấp < ${vnd(fc.min_balance_vnd)}: ${warn.length ? fmtDay(warn[0] as string, '%d/%m/%Y') : '(không có)'}`,
    `- Số tuần âm ở kịch bản thấp: ${warn.length}/${weeks.length}`,
    `- Số dư cuối kỳ (tuần ${fmtDay(lastW.week_start, '%d/%m')}): thấp ${vnd(last.low)} · cơ sở ${vnd(last.base)} · cao ${vnd(last.high)}`,
  ];
  if (fc.opening === null) L.push(`- ${NO_OPENING}`);
  L.push('- Khoảng trên GIẢ ĐỊNH — chi tiết: `python -m agents.fp_cash --forecast`');
  return L;
}

export function adsSection(nPending: number): string[] {
  return [
    H_ADS,
    '',
    `- Mục \`budget_change\` đang chờ duyệt: ${nPending} — ĐỀ XUẤT, agent không chi tiền; duyệt qua \`python -m pipelines.approval_queue\``,
  ];
}

// ---------------------------------------------------------------- gom (DB)

/** Lỗi dữ liệu của 1 mục (Python `_ERRORS`: psycopg.Error, ValueError, KeyError, TypeError,
 * ScenarioError) → "(chưa có dữ liệu)"; lỗi khác nổi lên. */
async function safeSection(heading: string, fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (e) {
    if (!(isDbError(e) || e instanceof RangeError || e instanceof TypeError)) throw e;
    const why = isDbError(e) ? dbMsg(e) : (e as Error).message;
    return nodata(heading, why || (e as Error).constructor.name);
  }
}

export async function buildExtra(
  db: Db,
  asOf: string,
  o: { fpaConfig?: string; arConfig?: string; src?: FinSources } = {},
): Promise<string[]> {
  const month = `${asOf.slice(0, 7)}-01`;
  const fpa = o.fpaConfig ?? FPA_CONFIG_FILE;
  const src = o.src ?? sources;
  const arSec = async () => {
    const [cfg, why] = ar.loadConfig(o.arConfig);
    if (cfg === null) throw new RangeError(why as string);
    return ar.overdueSection(ar.aging(await ar.fetchEntries(db), asOf, cfg.term_days), asOf);
  };
  const pnlSec = async () => pnlSection(await pnlCompute(db, month));
  const opsSec = async () => {
    const { cfg, summary } = await src.ops(db, month, fpa);
    return opsSection(month, summary, cfg);
  };
  const cashSec = async () => cashSection(await src.cash(db, asOf, fpa));
  const weeks = src.cashWeeks(fpa) ?? 13;
  const adsSec = async () => {
    const { rows } = await db.query(
      "select count(*)::int as n from approval_queue where block = 'finance' and object_type = 'budget_change' and status = 'pending'",
    );
    return adsSection(rows[0].n);
  };
  const out: string[] = [];
  for (const [heading, fn] of [
    [H_AR, arSec],
    [hPnl(month), pnlSec],
    [hOps(month), opsSec],
    [hCash(weeks), cashSec],
    [H_ADS, adsSec],
  ] as [string, () => Promise<string[]>][]) {
    if (out.length) out.push('');
    out.push(...(await safeSection(heading, fn)));
  }
  return out;
}

/** → [path, text] — bản tin GĐ tài chính kèm 5 mục FP&A/kế toán. */
export async function weekly(
  db: Db,
  asOf: string,
  now: Date,
  o: {
    outDir?: string;
    dcfg?: DirectorConfig;
    fpaConfig?: string;
    arConfig?: string;
    src?: FinSources;
  } = {},
): Promise<[string, string]> {
  const extra = await buildExtra(db, asOf, o);
  return directorRun(db, 'finance', { now, cfg: o.dcfg, outDir: o.outDir ?? REPORTS_DIR, extra });
}
