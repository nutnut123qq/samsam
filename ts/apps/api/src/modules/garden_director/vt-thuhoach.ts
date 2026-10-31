import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError, submit as directorSubmit } from '@samsam/core/ops/director';
import { addDays, vnDate, vnMidnight } from '@samsam/core/ops/period';
import { cpSlice } from '@samsam/core/ops/py';
import { isoDate } from '@samsam/core/ops/py-date';
import { cpCmp, isPyInt, PyFloat, pyLoads, pyNum } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { pySplit, pyStr, pyStrip } from '@samsam/core/security/py';
import { ACTIVITY_VOCAB, type DbLease, type Io, STD_IO } from '../garden_zalo/garden.js';
import { pyOsName } from '../garden_zalo/garden-media.js';
import {
  ALL_CHANNELS,
  ASSUMPTIONS_FILE,
  type Assumptions,
  DATE_MAX,
  DATE_MIN,
  GOLDEN_FILE,
  LEVELS,
  type Level,
  type Levels,
  loadAssumptions as loadScenario,
  MAX_WEEKS,
  project,
  readGolden,
  round6,
  ScenarioError,
  type Sku,
  validateGolden,
  weekStart,
} from './scenario.js';

// Port `agents/vt_thuhoach.py` (v11.0 VT WP17) — dự báo thu hoạch theo khoảnh + sẵn hàng theo lô, LUÔN
// là khoảng thấp–cơ sở–cao kèm giả định và phần dữ liệu thiếu.
//  - Giả định năng suất `data/harvest_assumptions.json` (GIẢ ĐỊNH — GĐ vùng trồng chốt): fail-closed.
//  - `forecastHarvest` THUẦN: chỉ khoảnh `active`; quý thu hoạch = quý đầu tiên trong `quarters` quý
//    tới có năm(quý) − planted_year ≥ min_age_years; khoảnh đã có nhật ký "thu hoạch" → không dự báo
//    lại; tree_count/planted_year thiếu → "thiếu dữ liệu" (KHÔNG coi = 0); dòng mẫu → nhãn (MẪU).
//  - `availability` THUẦN: chỉ lô `passed` còn hạn; nhu cầu = Σ `project()` qua ALL_CHANNELS (KHÔNG
//    công thức thứ 2); hết hàng dạng khoảng; FEFO theo nhu cầu thấp → "rủi ro cận hạn"; SKU rượu KHÔNG
//    đưa vào bản này (payload qua guardrail) — chỉ đếm số SKU bị bỏ.
//  - `render` tất định: metadata model/seed/sha256 2 file giả định/as_of/generated (ngày THẬT lập).
//  - Không LLM, không mạng, không ngẫu nhiên. Đầu ra = file `vt-thu-hoach-<ngày VN>.md` + (`--submit`)
//    mục `pending` khối farming `harvest_forecast`. KHÔNG phải cam kết với khách/đại lý.
//  - Cổng farming-05.2 TẮT → chặn trước khi ghi báo cáo/submit (exit 2).

export const HARVEST_FILE = dataPath('harvest_assumptions.json');
export const AGENT = 'agent:VT';
export const BLOCK = 'farming';
export const OBJECT_TYPE = 'harvest_forecast';
export const MODEL = 'vt_thuhoach-rule-v1 + pipelines.scenario.project';
export const HARVEST = 'thu hoạch';
if (!(ACTIVITY_VOCAB as readonly string[]).includes(HARVEST))
  throw new Error('HARVEST ngoài vocab');
const SEP = '–';
export const DEFAULT_WEEKS = 13;
const KEYS = ['min_age_years', 'quarters', 'survival_rate', 'version', 'yield_g_per_tree'];
export const FOOTER =
  'Khoảng thấp–cơ sở–cao — KHÔNG phải cam kết với khách/đại lý; GĐ vùng trồng xác nhận trước khi chia sẻ.';

/** Giả định thu hoạch thiếu/hỏng — fail-closed (Python HarvestError(ValueError)). */
export class HarvestError extends RangeError {
  override name = 'HarvestError';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
const intIn = (v: unknown, lo: number, hi: number): v is number => isPyInt(v) && v >= lo && v <= hi;
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function levelsOf(row: unknown, where: string, loOpen: number, hi: number | null): Levels {
  if (!isObj(row) || Object.keys(row).length !== 3 || !LEVELS.every((l) => Object.hasOwn(row, l))) {
    throw new HarvestError(`${where}: phải là object low/base/high`);
  }
  const out = {} as Levels;
  for (const lv of LEVELS) {
    const v = typeof row[lv] === 'boolean' ? null : pyNum(row[lv]);
    if (v === null || !Number.isFinite(v) || v <= loOpen || (hi !== null && v > hi)) {
      throw new HarvestError(`${where}.${lv}: số ngoài khoảng hợp lệ`);
    }
    out[lv] = v;
  }
  if (!(out.low <= out.base && out.base <= out.high))
    throw new HarvestError(`${where}: phải low <= base <= high`);
  return out;
}

export type HarvestAssumptions = {
  version: string;
  min_age_years: number;
  quarters: number;
  yield: Levels;
  survival: Levels;
  sha256: string;
};

export function loadAssumptions(path: string = HARVEST_FILE): HarvestAssumptions {
  const name = basename(path);
  let raw: Buffer;
  let doc: unknown;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw new HarvestError(`thiếu file ${name}`);
    throw new HarvestError(`${name} hỏng (${pyOsName(e)})`);
  }
  try {
    doc = pyLoads(new TextDecoder('utf-8', { fatal: true }).decode(raw)); // utf-8-sig
  } catch (e) {
    // KHÁC Python: NaN/Infinity → JSONDecodeError (Python ValueError) — cùng bị chặn.
    throw new HarvestError(
      `${name} hỏng (${e instanceof SyntaxError ? 'JSONDecodeError' : 'UnicodeDecodeError'})`,
    );
  }
  const ks = isObj(doc)
    ? Object.keys(doc)
        .filter((k) => k !== '_doc')
        .sort()
    : null;
  if (!isObj(doc) || ks?.join(',') !== KEYS.join(',')) {
    throw new HarvestError(`${name}: khóa phải đúng ['${KEYS.join("', '")}']`);
  }
  if (typeof doc.version !== 'string' || !pyStrip(doc.version))
    throw new HarvestError('version rỗng');
  if (!intIn(doc.min_age_years, 1, 30)) throw new HarvestError('min_age_years phải int 1..30');
  if (!intIn(doc.quarters, 1, 8)) throw new HarvestError('quarters phải int 1..8');
  return {
    version: doc.version,
    min_age_years: doc.min_age_years,
    quarters: doc.quarters,
    yield: levelsOf(doc.yield_g_per_tree, 'yield_g_per_tree', 0, null),
    survival: levelsOf(doc.survival_rate, 'survival_rate', 0, 1),
    sha256: sha256(raw),
  };
}

// ---------- thuần ----------

function roundLv(x: number, lv: Level): number {
  const y = round6(x);
  return lv === 'low' ? Math.floor(y) : lv === 'high' ? Math.ceil(y) : Math.floor(y + 0.5);
}

/** Date → ngày VN; chuỗi ngày giữ nguyên. */
const vnDay = (ts: Date | string): string => (ts instanceof Date ? vnDate(ts) : ts);
const isSample = (src: unknown) => typeof src === 'string' && src.startsWith('sample:');

function quarters(today: string, n: number): [number, number][] {
  let y = Number(today.slice(0, 4));
  let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([y, q]);
    [y, q] = q === 4 ? [y + 1, 1] : [y, q + 1];
  }
  return out;
}

export type Plot = {
  id: string;
  tree_count?: unknown;
  planted_year?: unknown;
  status?: unknown;
  source?: unknown;
};
export type HarvestLog = {
  plot_id: string;
  ts: Date | string;
  activity?: unknown;
  source?: unknown;
};
export type HarvestRow = {
  plot_id: string;
  quarter: string | null;
  notes: string[];
  sample: boolean;
} & Record<Level, number | null>;

/** → số null khi không dự báo (đã thu hoạch / thiếu dữ liệu / chưa đủ tuổi). */
export function forecastHarvest(
  plots: readonly Plot[],
  logs: readonly HarvestLog[],
  a: HarvestAssumptions,
  now: Date,
): HarvestRow[] {
  const today = vnDate(now);
  const qs = quarters(today, a.quarters);
  const done = new Map<string, string>();
  const sampleLog = new Set<string>();
  for (const lg of logs) {
    if (lg.activity !== HARVEST) continue;
    const d = vnDay(lg.ts);
    if (d > today) continue;
    const prev = done.get(lg.plot_id);
    done.set(lg.plot_id, prev !== undefined && prev > d ? prev : d);
    if (isSample(lg.source)) sampleLog.add(lg.plot_id);
  }
  const out: HarvestRow[] = [];
  for (const p of [...plots].sort((x, y) => cpCmp(pyStr(x.id), pyStr(y.id)))) {
    if (p.status !== 'active') continue;
    const pid = p.id;
    const row: HarvestRow = {
      plot_id: pid,
      quarter: null,
      notes: [],
      sample: isSample(p.source) || sampleLog.has(pid),
      low: null,
      base: null,
      high: null,
    };
    out.push(row);
    const d = done.get(pid);
    if (d !== undefined) {
      row.notes.push(`đã thu hoạch ${d}`);
      continue;
    }
    const trees = p.tree_count ?? null;
    const year = p.planted_year ?? null;
    const miss = (
      [
        ['tree_count', trees, 0],
        ['planted_year', year, 1900],
      ] as const
    )
      .filter(([, v, lo]) => !intIn(v, lo, 10 ** 7))
      .map(([k]) => k);
    if (miss.length) {
      row.notes.push(`thiếu dữ liệu (${miss.join(', ')})`);
      continue;
    }
    const hit = qs.find(([y]) => y - (year as number) >= a.min_age_years);
    if (hit === undefined) {
      row.notes.push(`chưa đủ ${a.min_age_years} năm tuổi trong ${qs.length} quý tới`);
      continue;
    }
    row.quarter = `${hit[0]}-Q${hit[1]}`;
    for (const lv of LEVELS)
      row[lv] = roundLv(((trees as number) * a.yield[lv] * a.survival[lv]) / 1000, lv);
  }
  return out;
}

export type Lot = {
  lot_code: string;
  sku_key: string;
  mfg_date: string | null;
  exp_date: string;
  qty: number;
  intake_status: string;
  source?: unknown;
};

export type AvailRow = {
  sku_key: string;
  stock: number;
  usable: Lot[];
  pending: string[];
  expired: string[];
  demand: Levels | null;
  stockout: { earliest: number | null; latest: number | null } | null;
  near_expiry: Lot[];
  notes: string[];
  sample: boolean;
  restricted: boolean;
};

const firstWeek = (cum: readonly number[], stock: number): number | null => {
  const i = cum.findIndex((c) => c > 0 && c >= stock);
  return i < 0 ? null : i + 1;
};

/** Nhu cầu = Σ project qua mọi kênh; null khi thiếu giả định. */
export function availability(
  lots: readonly Lot[],
  skus: readonly unknown[],
  scen: Assumptions,
  now: Date,
  weeks: number = DEFAULT_WEEKS,
): AvailRow[] {
  const today = vnDate(now);
  const start = weekStart(today);
  const idx = new Map<string, Sku>();
  for (const s of skus) {
    if (isObj(s) && s.sku_key) idx.set(s.sku_key as string, s);
  }
  const bySku = new Map<string, Lot[]>();
  for (const lot of lots) bySku.set(lot.sku_key, [...(bySku.get(lot.sku_key) ?? []), lot]);
  const out: AvailRow[] = [];
  for (const key of [...bySku.keys()].sort(cpCmp)) {
    const sku = idx.get(key);
    const row: AvailRow = {
      sku_key: key,
      stock: 0,
      usable: [],
      pending: [],
      expired: [],
      demand: null,
      stockout: null,
      near_expiry: [],
      notes: [],
      sample: false,
      restricted: false,
    };
    out.push(row);
    if (sku !== undefined && sku.category === 'alcohol') {
      row.restricted = true;
      continue;
    }
    const group = [...(bySku.get(key) as Lot[])].sort(
      (x, y) => cpCmp(x.exp_date, y.exp_date) || cpCmp(x.lot_code, y.lot_code),
    );
    for (const lot of group) {
      if (lot.intake_status === 'pending') row.pending.push(lot.lot_code);
      else if (lot.intake_status !== 'passed') continue;
      else if (lot.exp_date <= today) row.expired.push(lot.lot_code);
      else {
        row.usable.push(lot);
        row.stock += lot.qty;
        row.sample ||= lot.source === 'sample';
      }
    }
    if (sku === undefined) {
      row.notes.push('SKU không có trong golden — không tính nhu cầu');
      continue;
    }
    const weekly = Object.fromEntries(
      LEVELS.map((lv) => [lv, new Array<number>(weeks).fill(0)]),
    ) as Record<Level, number[]>;
    try {
      for (const ch of ALL_CHANNELS) {
        project(sku, ch, start, weeks, scen).forEach((r, i) => {
          for (const lv of LEVELS) (weekly[lv][i] as number) += r[lv];
        });
      }
    } catch (e) {
      if (!(e instanceof ScenarioError)) throw e;
      row.notes.push('thiếu giả định số bán — không tính nhu cầu');
      continue;
    }
    const cum = Object.fromEntries(
      LEVELS.map((lv) => {
        let acc = 0;
        return [
          lv,
          weekly[lv].map((x) => {
            acc += x;
            return acc;
          }),
        ];
      }),
    ) as Record<Level, number[]>;
    row.demand = Object.fromEntries(LEVELS.map((lv) => [lv, cum[lv][weeks - 1]])) as Levels;
    row.stockout = {
      earliest: firstWeek(cum.high, row.stock),
      latest: firstWeek(cum.low, row.stock),
    };
    let acc = 0;
    for (const lot of row.usable) {
      // FEFO: hạn sớm dùng trước
      acc += lot.qty;
      const wk = firstWeek(cum.low, acc);
      const usedBy = addDays(start, 7 * (wk || weeks) - 1);
      if (lot.exp_date <= usedBy) row.near_expiry.push(lot);
    }
  }
  return out;
}

const cell = (d: Record<Level, number | null>) => LEVELS.map((lv) => String(d[lv])).join(SEP);

/** Mã khoảnh/lô/SKU từ DB (nhập tay) → 1 dòng, cắt ngắn: chặn chèn dòng giả vào payload hàng duyệt. */
const id = (v: unknown) => cpSlice(pySplit(pyStr(v)).join(' '), 0, 64);
const codes = (lots: readonly (string | Lot)[]) =>
  lots.map((x) => id(typeof x === 'string' ? x : x.lot_code)).join(', ');

export type RenderMeta = {
  as_of: string;
  generated: string;
  harvest_sha256: string;
  scenario_sha256: string;
  n_plots: number;
  n_logs: number;
  n_lots: number;
  weeks: number;
  start: string;
  status: string;
};

/** THUẦN, tất định. */
export function render(
  harvest: readonly HarvestRow[],
  avail: readonly AvailRow[],
  meta: RenderMeta,
): string {
  const L = [
    `# Dự báo thu hoạch & sẵn hàng theo lô — ${meta.as_of}`,
    '',
    '## Metadata',
    '',
    `- model: ${MODEL}`,
    '- seed: 0 (tất định — không lấy mẫu ngẫu nhiên)',
    `- harvest_assumptions_sha256: ${meta.harvest_sha256}`,
    `- scenario_assumptions_sha256: ${meta.scenario_sha256}`,
    `- as_of: ${meta.as_of}`,
    `- generated: ${meta.generated}`,
    `- dữ liệu dùng: ${meta.n_plots} khoảnh · ${meta.n_logs} nhật ký thu hoạch · ${meta.n_lots} lô`,
    `- giả định: ${meta.status}`,
    '',
    '## Dự báo thu hoạch theo khoảnh (kg củ tươi, thấp–cơ sở–cao)',
    '',
  ];
  for (const r of harvest) {
    const tag = r.sample ? ' (MẪU)' : '';
    if (r.low === null) L.push(`- ${id(r.plot_id)}${tag}: ${r.notes.join('; ')} — không ước lượng`);
    else L.push(`- ${id(r.plot_id)}${tag}: ${r.quarter} — ${cell(r)} kg`);
  }
  if (!harvest.length) L.push('- (không có khoảnh active)');
  L.push('', `## Sẵn hàng theo lô (${meta.weeks} tuần từ ${meta.start})`, '');
  const shown = avail.filter((r) => !r.restricted);
  for (const r of shown) {
    const tag = r.sample ? ' (MẪU)' : '';
    L.push(
      `- ${id(r.sku_key)}${tag}: tồn sẵn đã kiểm nhập ${r.stock}` +
        (r.usable.length ? ` (lô ${codes(r.usable)})` : ''),
    );
    L.push(...r.notes.map((n) => `  - ${n}`));
    if (r.demand !== null) {
      L.push(`  - nhu cầu ${meta.weeks} tuần: ${cell(r.demand)} đơn vị`);
      const so = r.stockout as NonNullable<AvailRow['stockout']>;
      if (so.earliest === null) {
        L.push(`  - hết hàng: đủ qua ${meta.weeks} tuần (cả nhu cầu cao)`);
      } else {
        const late = so.latest
          ? `tuần ${so.latest} (nhu cầu thấp)`
          : `sau ${meta.weeks} tuần (nhu cầu thấp)`;
        L.push(`  - hết hàng: tuần ${so.earliest} (nhu cầu cao) → ${late}`);
      }
    }
    for (const lot of r.near_expiry) {
      L.push(
        `  - rủi ro cận hạn: lô ${id(lot.lot_code)} (hạn ${lot.exp_date}) — FEFO theo nhu cầu thấp chưa dùng hết trước hạn`,
      );
    }
    if (r.pending.length) L.push(`  - chưa kiểm nhập — không tính sẵn: lô ${codes(r.pending)}`);
    if (r.expired.length) L.push(`  - hết hạn — không tính: lô ${codes(r.expired)}`);
  }
  if (!shown.length) L.push('- (không có lô)');
  const nRest = avail.filter((r) => r.restricted).length;
  if (nRest) {
    L.push(
      `- ${nRest} SKU nhóm hạn chế quảng bá không đưa vào bản này (xem dự báo kênh offline của KD-A10)`,
    );
  }
  L.push('', '---', FOOTER, '');
  return L.join('\n');
}

// ---------- DB ----------

export async function loadDb(db: Db): Promise<[Plot[], HarvestLog[], Lot[]]> {
  const plots = (
    await db.query('select id, tree_count, planted_year, status, source from plots order by id')
  ).rows as Plot[];
  const logs = (
    await db.query(
      'select plot_id, ts, activity, source from plot_logs where activity = $1 order by id',
      [HARVEST],
    )
  ).rows as HarvestLog[];
  // date → text: node-pg đổi `date` sang Date giờ máy (lệch ngày) — giữ dạng 'YYYY-MM-DD' như Python.
  // to_char (không ::text): ::text theo DateStyle của phiên ('01/11/2026') → so chuỗi FEFO sai.
  const lots = (
    await db.query(
      "select lot_code, sku_key, to_char(mfg_date, 'YYYY-MM-DD') as mfg_date," +
        " to_char(exp_date, 'YYYY-MM-DD') as exp_date, qty," +
        ' intake_status, source from production_lots order by lot_code',
    )
  ).rows.map((r) => ({ ...r, qty: Number(r.qty) })) as Lot[];
  return [plots, logs, lots];
}

/** Đẩy bản dự báo vào hàng duyệt farming; trùng (cùng kỳ + cùng nội dung) đang pending → bỏ qua. */
export async function submitForecast(
  db: Db,
  asOf: string,
  text: string,
): Promise<['skipped' | 'pending', bigint]> {
  const oid = `vt-harvest:${asOf}:${sha256(Buffer.from(text, 'utf8')).slice(0, 16)}`;
  const row = (
    await db.query(
      "select id from approval_queue where block = $1 and object_type = $2 and object_id = $3 and status = 'pending'" +
        ' order by id limit 1',
      [BLOCK, OBJECT_TYPE, oid],
    )
  ).rows[0];
  if (row) return ['skipped', BigInt(row.id)];
  const qid = await directorSubmit(db, {
    block: BLOCK,
    objectType: OBJECT_TYPE,
    objectId: oid,
    title: `Dự báo thu hoạch & sẵn hàng ${asOf}`,
    payload: text,
    createdBy: AGENT,
  });
  return ['pending', qid];
}

// ---------- CLI ----------

export type VtThuhoachOpts = { date?: string; weeks?: string; submit?: boolean };
export type VtThuhoachDeps = {
  connect?: () => Promise<DbLease | null>;
  io?: Io;
  env?: Env;
  /** mốc as_of (--date ghi đè) */
  now?: Date;
  /** ngày THẬT lập bản (test truyền cố định) — tách khỏi as_of để backdate không sai trường audit */
  generated?: string;
  harvestFile?: string;
  scenarioFile?: string;
  goldenFile?: string;
  reportsDir?: string;
};

const PROG = 'vt-thuhoach';

/** `python -m agents.vt_thuhoach` → exit: 0 ok · 1 lỗi giả định/guardrail/ghi · 2 usage / DB down /
 * cổng TẮT. */
export async function vtThuhoachMain(o: VtThuhoachOpts, d: VtThuhoachDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (m: string) => {
    io.err(`${PROG}: error: ${m}`);
    return 2;
  };
  let asOfDay: string | null = null;
  if (o.date !== undefined) {
    const day = isoDate(o.date);
    if (day === null) return usage('argument --date: ngày phải dạng YYYY-MM-DD');
    if (day < DATE_MIN || day > DATE_MAX) return usage('argument --date: ngày ngoài khoảng hợp lệ');
    asOfDay = day;
  }
  let weeks = DEFAULT_WEEKS;
  if (o.weeks !== undefined) {
    const s = pyStrip(o.weeks);
    if (!/^[+-]?\d+$/.test(s)) return usage('argument --weeks: phải là số nguyên');
    weeks = Number(s);
    if (weeks < 1 || weeks > MAX_WEEKS)
      return usage(`argument --weeks: phải trong 1..${MAX_WEEKS}`);
  }
  // --date: 12:00 giờ VN của ngày đó
  const now = asOfDay
    ? new Date(vnMidnight(asOfDay).getTime() + 12 * 3600_000)
    : (d.now ?? new Date());
  const generated = d.generated ?? vnDate(new Date());
  let ha: HarvestAssumptions;
  let sa: Assumptions;
  let scenSha: string;
  const scenFile = d.scenarioFile ?? ASSUMPTIONS_FILE;
  try {
    ha = loadAssumptions(d.harvestFile);
    sa = loadScenario(scenFile);
    scenSha = sha256(readFileSync(scenFile));
  } catch (e) {
    if (!(e instanceof RangeError) && typeof (e as { code?: unknown }).code !== 'string') throw e;
    io.err(`[err] giả định: ${(e as Error).message}`);
    return 1;
  }
  const [doc, why] = readGolden(d.goldenFile ?? GOLDEN_FILE);
  if (doc === null || validateGolden(doc).length) {
    io.err(`[err] golden không dùng được (${why || 'không hợp lệ'})`);
    return 1;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) {
    io.err('[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  try {
    // r12 RB: tắt → chặn trước khi ghi báo cáo/submit.
    const blockedWhy = await blocked(lease.db, 'dự báo thu hoạch', 'farming-05.2');
    if (blockedWhy) return sayBlocked(blockedWhy, io.out);
    const [plots, logs, lots] = await loadDb(lease.db);
    const asOf = vnDate(now);
    const harvest = forecastHarvest(plots, logs, ha, now);
    const avail = availability(lots, doc.skus as unknown[], sa, now, weeks);
    const text = render(harvest, avail, {
      as_of: asOf,
      generated,
      harvest_sha256: ha.sha256,
      scenario_sha256: scenSha,
      n_plots: plots.length,
      n_logs: logs.length,
      n_lots: lots.length,
      weeks,
      start: weekStart(asOf),
      status: cpSlice(pySplit(pyStr(sa.status)).join(' '), 0, 300),
    });
    const g = guardrailCheck(text);
    if (g.ok !== true) {
      io.err(`[err] bản dự báo không qua guardrail (${(g.violations ?? []).length} vi phạm)`);
      return 1;
    }
    // P8.4: khoảnh/nhật ký/lô MẪU (nhãn (MẪU)) → không đếm.
    const sample = [...harvest, ...avail].some((r) => r.sample);
    let path: string;
    try {
      path = await writeReport(
        text,
        d.reportsDir ?? REPORTS_DIR,
        `vt-thu-hoach-${asOf}.md`,
        sample,
      );
    } catch (e) {
      if (typeof (e as { syscall?: unknown }).syscall !== 'string') throw e; // OSError của fs
      io.err(`[err] không ghi được báo cáo (${pyOsName(e)})`);
      return 1;
    }
    io.out(text);
    io.out(`[write] ${path}`);
    if (o.submit) {
      const [st, qid] = await submitForecast(lease.db, asOf, text);
      io.out(`[submit] ${st} #${qid} (${BLOCK}/${OBJECT_TYPE})`);
    }
    return 0;
  } catch (e) {
    if (isDbError(e)) {
      io.err(`[warn] lỗi DB (${pgErrName(e)})`);
      return 2;
    }
    if (e instanceof DirectorConfigError) {
      io.err(`[err] cấu hình khối: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    await lease.release();
  }
}
