import type { Db } from '@samsam/core/ops/deps';
import { addDays } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { pyDumps } from '@samsam/core/rollout/counters';
import {
  type Dec,
  decCmp,
  FPA_CONFIG_FILE,
  fmtDay,
  frac,
  isDict,
  isIntIn,
  readConfig,
  vnd,
} from '../fin_ar_pnl/fin-common.js';
import { readGolden, validateGolden } from '../garden_director/scenario.js';
import { decInt, decStr, divInt, fmtFixed, mul, roundHalfUp } from './decimal.js';
import * as scenario from './scenario.js';

// Port `agents/fp_cash.py` (v9.1 FP-Cash, WP12) — dòng tiền 13 tuần × 3 kịch bản thấp/cơ sở/cao,
// DỰNG TRÊN engine kịch bản chung `scenario.project()` — KHÔNG có công thức bán hàng thứ 2 ở đây: số
// đơn vị mỗi tuần lấy nguyên từ engine (baseline × hệ số mùa, rượu × kênh online = 0 do engine),
// module này chỉ nhân đơn giá × tỷ lệ thực nhận, dời theo độ trễ tiền về, trừ chi cố định. Tất định,
// KHÔNG LLM/mạng, KHÔNG đề xuất vay/chuyển khoản/dời hạn thanh toán.
// Tỷ lệ thực nhận đo từ DB: Σ payout / Σ giá trị đơn của `v_settlement_khoan` 8 tuần trước tuần bắt
// đầu theo kênh; không đo được (Σ đơn = 0, DB down, ngoài 0..1) → mặc định cấu hình + "chưa xác minh".
// Cấu hình `data/fpa_config.json` mục `cash` (GIẢ ĐỊNH — chờ GĐ tài chính chốt).
// shortcut: tiền VND trả ra là `number` (tính bằng BigInt, kiểm ≤ 2^53 — vượt → RangeError, TS chặt
// hơn Python vốn dùng int vô hạn); nâng sang bigint khi có doanh số cỡ 9 triệu tỷ đồng.

export const FEATURE = 'finance-05.2';
export const LEVELS = scenario.LEVELS;
export const MONEY_CAP = 10 ** 13;
export const MEASURE_WEEKS = 8;
export const MAX_LAG = 8;
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const NO_OPENING = 'chưa có số dư đầu kỳ thật — số dư = dòng tiền ròng lũy kế từ 0';
export const UNVERIFIED = 'chưa xác minh';

type Lv = scenario.Level;
type Levels = scenario.Levels;

export type CashCfg = {
  weeks: number;
  payout_lag_weeks: Record<string, number>;
  net_ratio_default: Record<string, Dec>;
  offline_price_ratio: Dec;
  unit_price_vnd: Record<string, Record<string, number>>;
  fixed_outflows: { name: string; amount_vnd: number; every_weeks: number; first_week: number }[];
  one_off: { name: string; amount_vnd: number; week_start: string }[];
  min_balance_vnd: number;
  opening_balance_vnd: number | null;
};

// ---------------------------------------------------------------- cấu hình

const money = (v: unknown): v is number => isIntIn(v, -MONEY_CAP, MONEY_CAP);
const get = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;

/** `load_cfg(path)` → [cfg, null] | [null, lý do] (caller exit 1 TRƯỚC connect). */
export function loadCfg(path: string = FPA_CONFIG_FILE): [CashCfg, null] | [null, string] {
  const [c, why0] = readConfig('cash', path);
  if (c === null) return [null, why0 as string];
  const chans = scenario.ALL_CHANNELS;
  if (!isIntIn(get(c, 'weeks'), 1, scenario.MAX_WEEKS)) {
    return [null, `cash.weeks: int 1..${scenario.MAX_WEEKS}`];
  }
  const lag = get(c, 'payout_lag_weeks');
  if (
    !isDict(lag) ||
    !Object.entries(lag).every(([k, v]) => chans.includes(k) && isIntIn(v, 0, MAX_LAG))
  ) {
    return [null, `cash.payout_lag_weeks: {kênh: int 0..${MAX_LAG}}`];
  }
  const nr = get(c, 'net_ratio_default');
  if (!isDict(nr) || !Object.keys(nr).every((k) => chans.includes(k))) {
    return [null, 'cash.net_ratio_default: {kênh: 0..1}'];
  }
  const ratios: Record<string, Dec> = {};
  for (const [k, v] of Object.entries(nr)) {
    const [d, why] = frac(v, `cash.net_ratio_default.${k}`);
    if (why) return [null, why];
    ratios[k] = d as Dec;
  }
  const [opr, whyO] = frac(get(c, 'offline_price_ratio'), 'cash.offline_price_ratio');
  if (whyO) return [null, whyO];
  const up = Object.hasOwn(c, 'unit_price_vnd') ? c.unit_price_vnd : {};
  if (
    !isDict(up) ||
    !Object.values(up).every(
      (m) =>
        isDict(m) &&
        Object.entries(m).every(([ch, p]) => chans.includes(ch) && isIntIn(p, 1, MONEY_CAP)),
    )
  ) {
    return [null, 'cash.unit_price_vnd: {sku: {kênh: int > 0}}'];
  }
  const weeks = c.weeks as number;
  const fixed = Object.hasOwn(c, 'fixed_outflows') ? c.fixed_outflows : [];
  if (
    !Array.isArray(fixed) ||
    !fixed.every(
      (f) =>
        isDict(f) &&
        typeof f.name === 'string' &&
        NAME_RE.test(f.name) &&
        isIntIn(get(f, 'amount_vnd'), 1, MONEY_CAP) &&
        isIntIn(get(f, 'every_weeks'), 1, 52) &&
        isIntIn(get(f, 'first_week'), 0, weeks - 1),
    )
  ) {
    return [
      null,
      'cash.fixed_outflows: [{name, amount_vnd > 0, every_weeks 1..52, first_week 0..weeks-1}]',
    ];
  }
  const one = Object.hasOwn(c, 'one_off') ? c.one_off : [];
  if (!Array.isArray(one)) return [null, 'cash.one_off: phải là list'];
  const oneOff: CashCfg['one_off'] = [];
  for (const [i, o] of one.entries()) {
    // Python: o["week_start"] trên không-dict / thiếu khóa / sai kiểu → cùng thông điệp
    const d = isDict(o) ? scenario.isoDate(get(o, 'week_start')) : null;
    if (d === null) return [null, `cash.one_off[${i}].week_start: phải YYYY-MM-DD`];
    const o2 = o as Record<string, unknown>;
    if (
      !(
        typeof o2.name === 'string' &&
        NAME_RE.test(o2.name) &&
        isIntIn(get(o2, 'amount_vnd'), 1, MONEY_CAP)
      )
    ) {
      return [null, `cash.one_off[${i}]: cần name + amount_vnd > 0`];
    }
    oneOff.push({
      name: o2.name,
      amount_vnd: o2.amount_vnd as number,
      week_start: weekStartAny(d),
    });
  }
  const mb = Object.hasOwn(c, 'min_balance_vnd') ? c.min_balance_vnd : 0;
  const ob = get(c, 'opening_balance_vnd') ?? null;
  if (!money(mb) || !(ob === null || money(ob))) {
    return [null, 'cash.min_balance_vnd/opening_balance_vnd: số nguyên VND'];
  }
  return [
    {
      weeks,
      payout_lag_weeks: { ...(lag as Record<string, number>) },
      net_ratio_default: ratios,
      offline_price_ratio: opr as Dec,
      unit_price_vnd: up as Record<string, Record<string, number>>,
      fixed_outflows: fixed as CashCfg['fixed_outflows'],
      one_off: oneOff,
      min_balance_vnd: mb,
      opening_balance_vnd: ob as number | null,
    },
    null,
  ];
}

/** `scenario.week_start` cho MỌI ngày hợp lệ (one_off có thể ngoài khung 2000..2100). */
function weekStartAny(d: string): string {
  if (d >= '1000-01-08' && d <= '9999-12-24') return scenario.weekStart(d);
  // shortcut: ngày ngoài khung core/period không cộng được — giữ nguyên (không bao giờ trùng tuần
  // dự báo vì dự báo luôn trong 2000..2100).
  return d;
}

// ---------------------------------------------------------------- hàm thuần

/** Khóa (sku, kênh) của dict Python `{(sku, kênh): …}`. */
export const pk = (sku: string, ch: string): string => `${sku}\u0000${ch}`;
export type Prices = Map<string, number>;

/** `unit_prices`: giá `list` golden cho kênh online; offline = list shopee × offline_price_ratio
 * (GIẢ ĐỊNH); `unit_price_vnd` ghi đè. */
export function unitPrices(goldenSkus: Record<string, unknown>[], cfg: CashCfg): Prices {
  const out: Prices = new Map();
  for (const s of goldenSkus) {
    const k = s.sku_key as string;
    const prices = isDict(s.prices) ? s.prices : {};
    for (const [ch, p] of Object.entries(prices)) {
      if (isDict(p) && isIntIn(get(p, 'list'), 1, MONEY_CAP)) out.set(pk(k, ch), p.list as number);
    }
    const shp = out.get(pk(k, 'shopee'));
    if (shp !== undefined) {
      out.set(
        pk(k, scenario.OFFLINE),
        safe(roundHalfUp(mul(decInt(shp), cfg.offline_price_ratio))),
      );
    }
  }
  for (const [k, m] of Object.entries(cfg.unit_price_vnd)) {
    for (const [ch, p] of Object.entries(m)) out.set(pk(k, ch), p);
  }
  return out;
}

/** {kênh: (Σ payout, Σ giá trị đơn, số dòng)} — kết quả `measure`. */
export type Measured = Record<string, [bigint, bigint, number]>;
export type NetRatio = Record<string, { ratio: Dec; note: string }>;

/** `net_ratios`: mặc định cấu hình + "chưa xác minh"; kênh đo được (Σ đơn ≠ 0, tỷ lệ 0..1) → đo. */
export function netRatios(measured: Measured, cfg: CashCfg): NetRatio {
  const out: NetRatio = {};
  for (const [ch, d] of Object.entries(cfg.net_ratio_default)) {
    out[ch] = { ratio: d, note: `mặc định cấu hình — ${UNVERIFIED}` };
  }
  for (const [ch, [pay, order, n]] of Object.entries(measured)) {
    if (!order) continue;
    const r = divInt(pay, order);
    if (decCmp(r, decInt(0)) >= 0 && decCmp(r, decInt(1)) <= 0) {
      out[ch] = { ratio: r, note: `đo từ settlement ${n} dòng (${MEASURE_WEEKS} tuần trước)` };
    }
  }
  return out;
}

function outflow(i: number, wk: string, cfg: CashCfg): bigint {
  let total = 0n;
  for (const f of cfg.fixed_outflows) {
    if (i >= f.first_week && (i - f.first_week) % f.every_weeks === 0)
      total += BigInt(f.amount_vnd);
  }
  for (const o of cfg.one_off) if (o.week_start === wk) total += BigInt(o.amount_vnd);
  return total;
}

/** bigint → number, vượt 2^53 → RangeError (không làm tròn câm). */
function safe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('số tiền vượt 2^53 — không tính được chính xác');
  }
  return Number(n);
}

export type CashWeek = { week_start: string; in: Levels; out: number; close: Levels };
export type CashForecast = {
  start: string;
  weeks: CashWeek[];
  warn_weeks: string[];
  min_balance_vnd: number;
  pairs: number;
  thieu_gia: [string, string][];
  thieu_sku: [string, string][];
  opening: number | null;
  notes: string[];
};

/**
 * `forecast`: skus = {sku_key: dòng golden}. Mỗi SKU × kênh có baseline (và có đơn giá) →
 * `scenario.project(sku, kênh, start − lag tuần, weeks, a)`: đơn vị bán tuần i − lag → tiền về tuần i
 * = đơn vị × đơn giá × tỷ lệ thực nhận (ROUND_HALF_UP). Thiếu đơn giá → "thiếu giá — loại khỏi dự
 * báo" (KHÔNG coi là 0 im lặng); SKU không có trong golden → "thiếu SKU golden". Chi = cố định + một
 * lần (giống nhau ở 3 kịch bản). `opening` null → số dư = dòng tiền ròng lũy kế từ 0 + ghi chú.
 * Lỗi: RangeError (thiếu độ trễ / tỷ lệ cho kênh có baseline) | ScenarioError.
 */
export function forecast(
  skus: Record<string, scenario.Sku>,
  assumptions: unknown,
  prices: Prices,
  netRatio: NetRatio,
  cfg: CashCfg,
  start: string,
  opening: number | null,
  project: typeof scenario.project = scenario.project,
): CashForecast {
  const a = scenario.normAssumptions(assumptions);
  const base = a.baseline;
  const weeks = cfg.weeks;
  const w0 = scenario.weekStart(start);
  const ins = Array.from({ length: weeks }, () => ({ low: 0n, base: 0n, high: 0n }));
  const thieuGia: [string, string][] = [];
  const thieuSku: [string, string][] = [];
  let pairs = 0;
  for (const skuKey of Object.keys(base).sort(cpCmp)) {
    for (const ch of Object.keys(base[skuKey] as object).sort(cpCmp)) {
      if (!Object.hasOwn(skus, skuKey)) {
        thieuSku.push([skuKey, ch]);
        continue;
      }
      const price = prices.get(pk(skuKey, ch));
      if (price === undefined) {
        thieuGia.push([skuKey, ch]);
        continue;
      }
      if (!Object.hasOwn(cfg.payout_lag_weeks, ch) || !Object.hasOwn(netRatio, ch)) {
        throw new RangeError(`thiếu độ trễ tiền về / tỷ lệ thực nhận cho kênh ${ch}`);
      }
      const lag = cfg.payout_lag_weeks[ch] as number;
      const ratio = (netRatio[ch] as NetRatio[string]).ratio;
      // ngoài khung ngày → engine báo ScenarioError (không tràn)
      const units = project(skus[skuKey], ch, addDays(w0, -7 * lag), weeks, a);
      pairs += 1;
      units.forEach((u, i) => {
        const row = ins[i] as Record<Lv, bigint>;
        for (const lv of LEVELS) {
          // Decimal(u) * price * ratio (context 28 chữ số) → ROUND_HALF_UP về đồng
          row[lv] += roundHalfUp(mul(mul(decInt(u[lv]), decInt(price)), ratio));
        }
      });
    }
  }
  const bal = { low: 0n, base: 0n, high: 0n } as Record<Lv, bigint>;
  for (const lv of LEVELS) bal[lv] = BigInt(opening ?? 0);
  const rows: CashWeek[] = [];
  const warn: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const wk = addDays(w0, 7 * i);
    const out = outflow(i, wk, cfg);
    const inc = ins[i] as Record<Lv, bigint>;
    for (const lv of LEVELS) bal[lv] += inc[lv] - out;
    rows.push({
      week_start: wk,
      in: { low: safe(inc.low), base: safe(inc.base), high: safe(inc.high) },
      out: safe(out),
      close: { low: safe(bal.low), base: safe(bal.base), high: safe(bal.high) },
    });
    if (bal.low < BigInt(cfg.min_balance_vnd)) warn.push(wk);
  }
  const notes = Object.keys(netRatio)
    .sort(cpCmp)
    .map((ch) => {
      const r = netRatio[ch] as NetRatio[string];
      return `${ch}: tỷ lệ thực nhận ${fmtFixed(r.ratio, 4)} — ${r.note}`;
    });
  notes.push(
    ...Object.keys(cfg.payout_lag_weeks)
      .sort(cpCmp)
      .map(
        (ch) => `độ trễ tiền về ${ch}: ${cfg.payout_lag_weeks[ch]} tuần — GIẢ ĐỊNH, ${UNVERIFIED}`,
      ),
    `kịch bản bán (đơn vị/tuần): ${a.status} — \`data/scenario_assumptions.json\``,
    `đơn giá: giá \`list\` golden cho kênh online; offline = list shopee × ${decStr(cfg.offline_price_ratio)} (GIẢ ĐỊNH)`,
    'chi cố định + một lần, tỷ lệ/độ trễ mặc định: `data/fpa_config.json` mục cash — GIẢ ĐỊNH, chờ GĐ tài chính chốt',
  );
  if (opening === null) notes.push(NO_OPENING);
  return {
    start: w0,
    weeks: rows,
    warn_weeks: warn,
    min_balance_vnd: cfg.min_balance_vnd,
    pairs,
    thieu_gia: thieuGia,
    thieu_sku: thieuSku,
    opening,
    notes,
  };
}

export function render(fc: CashForecast): string {
  const L = [
    `# Dòng tiền ${fc.weeks.length} tuần từ ${fmtDay(fc.start, '%d/%m/%Y')} — khoảng thấp/cơ sở/cao`,
    '',
    '**Khoảng ước lượng trên giả định — KHÔNG phải cam kết; agent không đề xuất vay, chuyển khoản hay dời hạn thanh toán.**',
    '',
    '| Tuần | Thu thấp | Thu cơ sở | Thu cao | Chi | Số dư thấp | Số dư cơ sở | Số dư cao |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const w of fc.weeks) {
    const i = w.in;
    const c = w.close;
    const flag = fc.warn_weeks.includes(w.week_start) ? ' ⚠' : '';
    L.push(
      `| ${fmtDay(w.week_start, '%d/%m')}${flag} | ${vnd(i.low)} | ${vnd(i.base)} | ${vnd(i.high)} | ${vnd(w.out)} | ${vnd(c.low)} | ${vnd(c.base)} | ${vnd(c.high)} |`,
    );
  }
  const ww = fc.warn_weeks;
  L.push(
    '',
    `Cảnh báo — tuần âm ở kịch bản thấp (số dư < ${vnd(fc.min_balance_vnd)}): ${ww.length ? ww.map((w) => fmtDay(w, '%d/%m')).join(', ') : '(không có)'}`,
  );
  if (fc.thieu_gia.length) {
    L.push(
      `Thiếu giá — loại khỏi dự báo: ${fc.thieu_gia.map(([k, ch]) => `\`${k}\` × ${ch}`).join(', ')}`,
    );
  }
  if (fc.thieu_sku.length) {
    L.push(
      `Thiếu SKU golden — loại khỏi dự báo: ${fc.thieu_sku.map(([k, ch]) => `\`${k}\` × ${ch}`).join(', ')}`,
    );
  }
  L.push('', 'Giả định:', ...fc.notes.map((n) => `- ${n}`), '');
  return L.join('\n');
}

/** `to_json` — `json.dumps(fc, ensure_ascii=False)` (ngày → ISO). */
export const toJson = (fc: CashForecast): string => pyDumps(fc);

// ---------------------------------------------------------------- DB + đầu vào

/** `measure`: Σ payout / Σ giá trị đơn / số dòng của `v_settlement_khoan` 8 tuần trước tuần bắt đầu. */
export async function measure(db: Db, start: string): Promise<Measured> {
  const w0 = scenario.weekStart(start);
  const since = addDays(w0, -7 * MEASURE_WEEKS);
  const { rows } = await db.query<{ channel: string; p: string; o: string; n: string }>(
    'select channel, coalesce(sum(payout_vnd), 0)::text as p,' +
      ' coalesce(sum(order_amount_vnd), 0)::text as o, count(*)::text as n from v_settlement_khoan' +
      ' where settled_on >= $1::date and settled_on < $2::date group by channel',
    [since, w0],
  );
  const out: Measured = {};
  for (const r of rows) out[r.channel] = [BigInt(r.p), BigInt(r.o), Number(r.n)];
  return out;
}

export type Inputs = { cfg: CashCfg; a: scenario.Assumptions; golden: scenario.Sku[] };

/** `load_inputs` → {cfg, a, golden} | RangeError(lý do) — trước mọi connect. */
export function loadInputs(
  cfgPath: string = FPA_CONFIG_FILE,
  o: { assumptionsFile?: string; goldenFile?: string } = {},
): Inputs {
  const [cfg, why] = loadCfg(cfgPath);
  if (cfg === null) throw new RangeError(why);
  let a: scenario.Assumptions;
  try {
    a = scenario.loadAssumptions(o.assumptionsFile);
  } catch (e) {
    if (e instanceof scenario.ScenarioError)
      throw new RangeError(`giả định kịch bản: ${e.message}`);
    throw e;
  }
  const [doc, gwhy] = readGolden(o.goldenFile);
  if (doc === null) throw new RangeError(`golden: ${gwhy}`);
  const errs = validateGolden(doc);
  if (errs.length) throw new RangeError(`golden không hợp lệ (${errs.length} lỗi)`);
  return { cfg, a, golden: (doc.skus as unknown[]).filter(isDict) };
}

/** `run`: `measured` = kết quả `measure()` ({} khi DB down) → forecast. */
export function run(
  measured: Measured,
  start: string,
  opening: number | null,
  inp: Inputs,
): CashForecast {
  const skus: Record<string, scenario.Sku> = {};
  for (const s of inp.golden) skus[s.sku_key as string] = s;
  return forecast(
    skus,
    inp.a,
    unitPrices(inp.golden, inp.cfg),
    netRatios(measured, inp.cfg),
    inp.cfg,
    start,
    opening,
  );
}
