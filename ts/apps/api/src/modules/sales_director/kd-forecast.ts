import { type Service, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { jobRun } from '@samsam/core/ops/job-runs';
import { addDays, parseDay, vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { isDict, pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError } from '@samsam/core/ops/tx';
import { blocked, cliEntry, sayBlocked } from '@samsam/core/rollout/rollout';
import type { Pool } from 'pg';
import {
  ALL_CHANNELS,
  type Assumptions,
  currentStock,
  DATE_MAX,
  DATE_MIN,
  LEVELS,
  type Levels,
  loadAssumptions,
  MAX_WEEKS,
  NOTE_NO_STOCK,
  project,
  readGolden,
  ScenarioError,
  type Sku,
  STALE_NOTE,
  type StockEntry,
  shortage,
  validateGolden,
  weekStart,
} from './kd-forecast.deps.js';

// Port `agents/kd_forecast.py` (v5.4 KD-A10, WP07, sales-07.3) — dự báo mùa theo SKU × kênh, LUÔN
// là khoảng thấp–cơ sở–cao, đối chiếu tồn kho → cảnh báo THIẾU / RỦI RO / THỪA.
// KHÔNG engine thứ 2: mỗi SKU × ALL_CHANNELS gọi `project()` (engine kịch bản dùng chung) rồi cộng;
// thiếu = `shortage()`, THỪA khi tồn > tổng kịch bản cao. SKU không có dòng tồn → "chưa có số tồn"
// (KHÔNG = 0); kho cũ → STALE_NOTE; tồn từ file mẫu → (MẪU). `forecast`/`render` THUẦN; không LLM,
// không mạng, không ghi DB.

export const DEFAULT_WEEKS = 13;
export const JOB = 'agents.kd_forecast';
const SEP = '–'; // en dash: ô dự báo luôn "thấp–cơ sở–cao"

const cell = (d: Levels) => LEVELS.map((lv) => String(d[lv])).join(SEP);

export type ForecastRow = {
  sku_key: string;
  category: unknown;
  channels: Record<string, Levels>;
  notes: Record<string, string>;
  sums: Levels;
  stock: number | null;
  level: string | null;
  warn: string | null;
  excess: number;
  stale: string[];
  sample: boolean;
  reconciled: boolean;
};

/** THUẦN. stock = `currentStock()` | null (chưa đối chiếu được). ScenarioError khi giả định thiếu. */
export function forecast(
  skus: Sku[],
  stock: Record<string, StockEntry> | null,
  start: string,
  weeks: number,
  assumptions: Assumptions,
): ForecastRow[] {
  return skus.map((sku) => {
    const key = sku.sku_key;
    const chans: Record<string, Levels> = {};
    const notes: Record<string, string> = {};
    const sums: Levels = { low: 0, base: 0, high: 0 };
    for (const ch of ALL_CHANNELS) {
      const rows = project(sku, ch, start, weeks, assumptions);
      const c = { low: 0, base: 0, high: 0 };
      for (const r of rows) for (const lv of LEVELS) c[lv] += r[lv];
      chans[ch] = c;
      const note = rows.find((r) => r.note)?.note;
      if (note) notes[ch] = note;
      for (const lv of LEVELS) sums[lv] += c[lv];
    }
    const st = stock !== null && Object.hasOwn(stock, key) ? stock[key] : undefined;
    const qty = st ? st.qty : null;
    const [level, warn] = shortage(qty, sums);
    const excess = qty !== null && qty > sums.high;
    return {
      sku_key: key,
      category: Object.hasOwn(sku, 'category') ? sku.category : null,
      channels: chans,
      notes,
      sums,
      stock: qty,
      level,
      warn,
      excess: excess ? (qty as number) - sums.high : 0,
      stale: st ? [...st.stale] : [],
      sample: Boolean(st?.sample),
      reconciled: stock !== null,
    };
  });
}

export function render(
  rows: ForecastRow[],
  start: string,
  weeks: number,
  status?: string | null,
): string {
  const end = addDays(start, 7 * weeks - 1);
  const L = [`# Dự báo mùa SKU × kênh — ${start} → ${end} (${weeks} tuần)`, ''];
  if (status) L.push(status, '');
  L.push(
    'Khoảng thấp–cơ sở–cao (đơn vị, cộng cả kỳ) — KHÔNG phải doanh số cam kết; giả định số bán chưa phải số thật.',
    '',
    `| SKU | ${ALL_CHANNELS.join(' | ')} | Tổng |`,
    `${'|---'.repeat(ALL_CHANNELS.length + 2)}|`,
  );
  for (const r of rows) {
    const cells = ALL_CHANNELS.map((ch) => cell(r.channels[ch] as Levels));
    L.push(`| ${r.sku_key} | ${cells.join(' | ')} | ${cell(r.sums)} |`);
  }
  L.push('', '## Đối chiếu tồn', '');
  for (const r of rows) {
    const k = r.sku_key;
    if (!r.reconciled) {
      L.push(`- ${k}: không đối chiếu được tồn`);
      continue;
    }
    if (r.stock === null) {
      L.push(`- ${k}: ${NOTE_NO_STOCK}`);
      continue;
    }
    const tag = r.sample ? ' (MẪU)' : '';
    const msgs = [r.warn, r.excess ? `THỪA: dư ${r.excess} so với kịch bản cao` : null].filter(
      (m): m is string => Boolean(m),
    );
    L.push(`- ${k}: tồn ${r.stock}${tag} — ${msgs.join('; ') || 'đủ cho cả kịch bản cao'}`);
    if (r.stale.length) L.push(`  - ${STALE_NOTE} (kho: ${r.stale.join(', ')})`);
  }
  const notes = rows.flatMap((r) => Object.entries(r.notes).map(([ch, n]) => [r.sku_key, ch, n]));
  if (notes.length) {
    L.push('', '## Ghi chú engine kịch bản', '');
    L.push(...notes.map(([k, ch, n]) => `- ${k} × ${ch}: ${n}`));
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI

export type ForecastOpts = { start?: string; weeks?: string; sku?: string; write?: boolean };
export type ForecastDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => Date;
  reportsDir?: string;
  /** Pool đọc tồn (mặc định login job — dev rơi về DATABASE_URL). */
  open?: (env: Env) => Promise<Pool>;
  stock?: (db: Db) => Promise<Record<string, StockEntry>>;
  goldenFile?: string;
  assumptionsFile?: string;
};

/** argparse `--weeks` / `--start` → giá trị | thông điệp lỗi (exit 2). */
function parseArgs(o: ForecastOpts): { start: string | null; weeks: number } | string {
  let weeks = DEFAULT_WEEKS;
  if (o.weeks !== undefined) {
    const n = pyInt(o.weeks);
    if (n === null) return 'argument --weeks: phải là số nguyên';
    if (n < 1n || n > BigInt(MAX_WEEKS)) return `argument --weeks: phải trong 1..${MAX_WEEKS}`;
    weeks = Number(n);
  }
  let start: string | null = null;
  if (o.start !== undefined) {
    // shortcut: chỉ YYYY-MM-DD (Python 3.11+ còn nhận YYYYMMDD / tuần ISO) — chặt hơn (exit 2).
    if (parseDay(o.start) === null) return 'argument --start: ngày phải dạng YYYY-MM-DD';
    if (!(DATE_MIN <= o.start && o.start <= DATE_MAX)) {
      return 'argument --start: ngày ngoài khoảng hợp lệ';
    }
    start = o.start;
  }
  return { start, weeks };
}

async function forecastMain(o: ForecastOpts, d: ForecastDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const a = parseArgs(o);
  if (typeof a === 'string') {
    err(`[err] ${a}`);
    return 2;
  }
  // r12 RB: tắt → không in/ghi dự báo (chặn trước khi đọc dữ liệu).
  const why = await blocked(null, 'dự báo mùa', 'sales-07.3');
  if (why) return sayBlocked(why, log);
  const start = weekStart(a.start ?? vnDate((d.now ?? (() => new Date()))()));
  const [doc, gwhy] = readGolden(d.goldenFile);
  if (doc === null) {
    err(`[err] golden: ${gwhy}`);
    return 1;
  }
  const errs = validateGolden(doc);
  if (errs.length) {
    err(`[err] golden không hợp lệ (${errs.length} lỗi), lỗi đầu: ${errs[0]}`);
    return 1;
  }
  const skus = (doc.skus as unknown[]).filter(
    (s): s is Sku => isDict(s) && (o.sku === undefined || s.sku_key === o.sku),
  );
  if (!skus.length) {
    err(`[err] SKU '${o.sku ?? 'None'}' không có trong golden`);
    return 1;
  }
  let assumptions: Assumptions;
  try {
    assumptions = loadAssumptions(d.assumptionsFile);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    err(`[err] giả định: ${e.message}`);
    return 1;
  }
  let stock: Record<string, StockEntry> | null = null;
  let rc = 0;
  let pool: Pool | null = null;
  try {
    pool = await (d.open ?? ((e: Env) => servicePool('job' as Service, e)))(env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    pool = null;
  }
  if (pool === null) {
    err('[warn] không đối chiếu được tồn (không kết nối được Postgres)');
    rc = 1;
  } else {
    try {
      stock = await (d.stock ?? currentStock)(pool);
    } catch (e) {
      if (!isDbError(e)) throw e;
      err(`[warn] không đối chiếu được tồn (${(e as Error).name})`);
      rc = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  }
  let rows: ForecastRow[];
  try {
    rows = forecast(skus, stock, start, a.weeks, assumptions);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    err(`[err] ${e.message}`);
    return 1;
  }
  const text = render(rows, start, a.weeks, assumptions.status);
  log(text);
  if (o.write) {
    let p: string;
    try {
      // P8.4: tồn nạp từ file MẪU → không đếm là đầu ra thật.
      p = await writeReport(
        text,
        d.reportsDir ?? REPORTS_DIR,
        `kd-forecast-${start}.md`,
        rows.some((r) => r.sample),
      );
    } catch (e) {
      const c = (e as { code?: unknown }).code;
      if (typeof c !== 'string' || !/^E[A-Z]+$/.test(c)) throw e; // chỉ lỗi OS (Python OSError)
      err(`[err] không ghi được báo cáo (${pyOsName(e)})`);
      return 1;
    }
    log(`[write] ${p}`);
  }
  return rc;
}

/** `kd-forecast [--start YYYY-MM-DD] [--weeks 1..104] [--sku X] [--write]` — luôn ghi `job_runs`
 * (Python `__main__` bọc `job_run("agents.kd_forecast")`); RolloutBlocked lọt → exit 2. */
export async function kdForecastMain(o: ForecastOpts, d: ForecastDeps = {}): Promise<number> {
  const main = cliEntry(forecastMain);
  return jobRun(
    JOB,
    async (run) => {
      const rc = await main(o, d);
      run.ok = rc === 0;
      return rc;
    },
    d.env ?? process.env,
  );
}
