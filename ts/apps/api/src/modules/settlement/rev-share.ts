import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay, vnFormat, vnMidnight } from '@samsam/core/ops/period';
import { isPlainObject, JsonFileError, parseJsonBytes } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { pyStr } from '@samsam/core/security/py';
import { clean } from '../intel_import/table.js';
import { safe } from '../ra_kenh/ra-kenh.js';
import {
  CHANNELS,
  type Dec,
  decCmp,
  decOf,
  decStr,
  mulRound,
  type Overlap,
  pyTuple,
  vnd,
  ymd,
} from './settlement-csv.js';

// Port `agents/rev_share.py` (v12.5 B5) — doanh thu thuần trực tuyến + biên bản đối soát quý (HĐ hợp
// tác Điều 7.3, 7.5, 8.3, 9; PL02 mục 4–5). Tất định, KHÔNG LLM/mạng, KHÔNG gửi.
//  - Thuần = Gộp − Phí sàn − Hủy − Hoàn theo ngày quyết toán trong kỳ (giờ VN), đọc view
//    `v_settlement_khoan` (khoản xuất lại nguyên văn tính 1 lần) + trạng thái đơn `orders` (market:%).
//  - THIẾU NGUỒN → "chưa có dữ liệu", KHÔNG suy, KHÔNG coi = 0. Hoàn > Gộp / Thuần âm / khoản ở ≥2
//    file trong kỳ → BẤT THƯỜNG, KHÔNG tính phí (người đối soát xử lý).
//  - Phí vận hành = round_half_up(Thuần × tỷ lệ) chỉ khi đã chốt tỷ lệ VÀ ngày bắt đầu vận hành; năm
//    hợp tác (`--year`) tính từ NGÀY KÝ hợp đồng (Điều 3.1), không từ ngày vận hành.
//  - XUNG ĐỘT LỢI ÍCH (Điều 7.6): mọi số chỉ là ĐỀ XUẤT; ô chữ ký để trống.
//  - CHỈ ĐỌC `settlement_rows`, `orders`; ghi DUY NHẤT `insert into revenue_quarters` khi `--record`
//    (append-only). Báo cáo/stdout KHÔNG mã đơn/hash/người mua; tên file qua che PII.
// Tiền: bigint (cột int8 trả về dạng chuỗi; tổng nhiều dòng có thể vượt 2^53).

export const CONFIG_FILE = dataPath('rev_share.json');
export const RUN_BY = 'agent:rev_share';
export const FEATURE = 'finance-06'; // v14.3 cổng giai đoạn (HĐ 6.7)
export const NO_DATA = 'chưa có dữ liệu';
export const NOT_SET = 'chưa chốt';
export const FEE_COLS = [
  'fixed_fee',
  'payment_fee',
  'service_fee',
  'shipping_fee',
  'voucher_seller',
  'affiliate',
] as const;
export type FeeCol = (typeof FEE_COLS)[number];
export const MONEY_KEYS = ['gross', 'fee', 'cancel', 'refund', 'net', 'payout'] as const;
export type MoneyKey = (typeof MONEY_KEYS)[number];
export const MAX_YEAR = 50;
const Q_RE = /^([0-9]{4})-Q([1-4])$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export const ROW_SQL =
  'select s.channel, s.file_name, s.order_amount_vnd, ' +
  FEE_COLS.map((c) => `s.${c}_vnd`).join(', ') +
  ', s.refund_vnd, s.payout_vnd, o.status from v_settlement_khoan s' +
  " left join orders o on o.id = s.channel || ':' || s.order_id_hash" +
  " and o.source like 'market:%' where s.settled_on >= $1 and" +
  ' s.settled_on < $2 and s.channel = any($3) order by s.id';
const UNDATED_SQL =
  'select channel, count(*) as n from v_settlement_khoan where settled_on is' +
  ' null and channel = any($1) group by channel order by channel';

/** `data/rev_share.json` hỏng — CLI exit 1 trước khi connect (Python ValueError → RangeError). */
export class ConfigError extends RangeError {
  override name = 'ConfigError';
}

// ------------------------------------------------------------------ cấu hình

export type Tier = { muc: number; tu_vnd: number | null; ty_le: Dec | null };
export type RevCfg = {
  start: string | null;
  sign: string | null;
  rate: Dec | null;
  channels: string[];
  fee_cols: FeeCol[];
  tiers: Tier[];
};

/** Python `fp_pnl.is_int`: số nguyên (không bool) trong [lo, hi]. shortcut: `1.0` JSON = số nguyên. */
export const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && lo <= v && v <= hi;

const ONE: Dec = { n: 1n, k: 0 };
const ZERO: Dec = { n: 0n, k: 0 };

/** Python `fp_pnl.frac`: số 0..1 (không bool) → [Dec, null] | [null, lý do]. */
export function frac(v: unknown, where: string): [Dec | null, string | null] {
  if (typeof v !== 'number') return [null, `${where}: phải là số 0..1`];
  // JSON `1e400` → Infinity (Python: Decimal('Infinity') → ngoài khoảng)
  const d = Number.isFinite(v) ? decOf(v) : null;
  if (d === null || decCmp(d, ZERO) < 0 || decCmp(d, ONE) > 0)
    return [null, `${where}: ngoài 0..1`];
  return [d, null];
}

function dateOrNone(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && DATE_RE.test(v) && parseDay(v) !== null) return v;
  throw new ConfigError(`${key}: null hoặc YYYY-MM-DD`);
}

/** list chuỗi KHÔNG trùng (theo `str()`), không rỗng, ⊂ `allowed`. */
function subsetList(v: unknown, allowed: readonly string[]): v is string[] {
  if (!Array.isArray(v) || !v.length) return false;
  if (new Set(v.map((x) => pyStr(x))).size !== v.length) return false;
  return v.every((x) => typeof x === 'string' && allowed.includes(x));
}

/** `load_config`: TS chặt hơn — phần tử không phải chuỗi (Python: lỗi so tập/crash) → ConfigError. */
export function loadConfig(path: string = CONFIG_FILE): RevCfg {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = parseJsonBytes(readFileSync(path));
  } catch (e) {
    const t = e instanceof JsonFileError ? e.pyType : pyOsName(e);
    throw new ConfigError(`không đọc được ${name}: ${t}`);
  }
  if (!isPlainObject(raw)) throw new ConfigError(`${name}: phải là object`);
  const start = dateOrNone(raw, 'ngay_bat_dau_van_hanh');
  const sign = dateOrNone(raw, 'ngay_ky_hop_dong');
  if (sign !== null && start !== null && start < sign) {
    throw new ConfigError('ngay_bat_dau_van_hanh trước ngay_ky_hop_dong');
  }
  let rate: Dec | null = null;
  if (raw.ty_le_phi_van_hanh !== null && raw.ty_le_phi_van_hanh !== undefined) {
    const [r, why] = frac(raw.ty_le_phi_van_hanh, 'ty_le_phi_van_hanh');
    if (why !== null) throw new ConfigError(why);
    rate = r;
  }
  const chans = raw.kenh_truc_tuyen;
  if (!subsetList(chans, CHANNELS)) {
    throw new ConfigError(`kenh_truc_tuyen: list không trùng ⊂ ${pyTuple(CHANNELS)}`);
  }
  const cols = raw.phi_san_cot;
  if (!subsetList(cols, FEE_COLS)) {
    throw new ConfigError(`phi_san_cot: list không trùng ⊂ ${pyTuple(FEE_COLS)}`);
  }
  const tiers = raw.muc_thuong;
  if (!Array.isArray(tiers)) throw new ConfigError('muc_thuong: phải là list');
  const outT: Tier[] = [];
  tiers.forEach((t, i) => {
    if (!isPlainObject(t) || !isIntIn(t.muc, 1, 99)) {
      throw new ConfigError(`muc_thuong[${i}]: thiếu muc (1..99)`);
    }
    const tu = t.tu_vnd ?? null;
    if (tu !== null && !isIntIn(tu, 0, 10 ** 15)) {
      throw new ConfigError(`muc_thuong[${i}].tu_vnd: null hoặc số ≥ 0`);
    }
    let tl: Dec | null = null;
    if (t.ty_le !== null && t.ty_le !== undefined) {
      const [d, why] = frac(t.ty_le, `muc_thuong[${i}].ty_le`);
      if (why !== null) throw new ConfigError(why);
      tl = d;
    }
    outT.push({ muc: t.muc, tu_vnd: tu as number | null, ty_le: tl });
  });
  if (new Set(outT.map((t) => t.muc)).size !== outT.length) {
    throw new ConfigError('muc_thuong: trùng muc');
  }
  return {
    start,
    sign,
    rate,
    channels: [...chans],
    fee_cols: FEE_COLS.filter((c) => cols.includes(c)),
    tiers: [...outT].sort((a, b) => a.muc - b.muc),
  };
}

// ------------------------------------------------------------------ kỳ

const checkYear = (y: number) => {
  if (y < 1 || y > 9999) throw new RangeError(`year ${y} is out of range`);
};

/**
 * 'YYYY-Qn' → [ngày đầu, ngày sau cuối] — cắt từ `start` nếu quý chứa ngày bắt đầu vận hành. Sai dạng
 * / chưa đóng (00:00 giờ VN ngày sau cuối) / cả quý trước `start` → RangeError (Python ValueError).
 */
export function quarterRange(
  label: unknown,
  now: Date,
  start: string | null = null,
): [string, string] {
  const m = typeof label === 'string' ? Q_RE.exec(label) : null;
  if (m === null) throw new RangeError('--quarter phải dạng YYYY-Qn (n = 1..4)');
  const y = Number(m[1]);
  const q = Number(m[2]);
  checkYear(y);
  let qs = ymd(y, 3 * q - 2, 1) as string;
  if (q === 4) checkYear(y + 1);
  const qe = (q === 4 ? ymd(y + 1, 1, 1) : ymd(y, 3 * q + 1, 1)) as string;
  if (vnMidnight(qe).getTime() > now.getTime()) {
    throw new RangeError(`quý ${label} chưa đóng (hết ${addDays(qe, -1)} giờ VN)`);
  }
  if (start !== null) {
    if (start >= qe) {
      throw new RangeError(`quý ${label} trước ngày bắt đầu vận hành thương mại ${start}`);
    }
    if (start > qs) qs = start;
  }
  return [qs, qe];
}

/** Cộng n năm; 29/02 → 01/03 năm thường (Python `_add_years`). */
function addYears(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const ny = y + n;
  checkYear(ny);
  return ymd(ny, m, day) ?? (ymd(ny, 3, 1) as string);
}

/**
 * Năm hợp tác thứ n (1-based) từ `start` = NGÀY KÝ hợp đồng (Điều 3.1) → [đầu, sau cuối]. n sai /
 * năm chưa đóng (00:00 giờ VN ngày sau cuối) → RangeError. Ký 29/02 → năm thường dùng 01/03.
 */
export function yearRange(start: string, n: unknown, now: Date): [string, string] {
  if (!isIntIn(n, 1, MAX_YEAR)) throw new RangeError(`--year phải là số 1..${MAX_YEAR}`);
  const ys = addYears(start, n - 1);
  const ye = addYears(start, n);
  if (vnMidnight(ye).getTime() > now.getTime()) {
    throw new RangeError(`năm hợp tác ${n} chưa đóng (hết ${addDays(ye, -1)} giờ VN)`);
  }
  return [ys, ye];
}

// ------------------------------------------------------------------ thuần

export type RevRow = {
  channel: string;
  file_name: string;
  order_amount: bigint;
  refund: bigint;
  payout: bigint;
  status: string | null;
} & Record<FeeCol, bigint>;

export type Figures = {
  n: number;
  n_cancelled: number;
  n_unknown: number;
  gross: bigint;
  fee: bigint;
  cancel: bigint | null;
  refund: bigint;
  net: bigint | null;
  payout: bigint;
  files: [string, number][];
};

/** `bks_recon._fname`: tên file trước khi in — chặn ký tự điều khiển, che PII, cắt 80, bỏ ` và |. */
export function fname(s: unknown): string {
  return clean(maskPii(safe(s)), 80)
    .replaceAll('`', "'")
    .replaceAll('|', '/');
}

/** Số 1 kênh từ dòng quyết toán (đã kèm `status` đơn; null = chưa thấy đơn trong `orders`). */
export function channelFigures(rows: readonly RevRow[], feeCols: readonly FeeCol[]): Figures {
  const canc = rows.filter((r) => r.status === 'cancelled');
  const unknown = rows.filter((r) => r.status === null).length;
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const gross = sum(rows.map((r) => r.order_amount));
  const fee = sum(rows.flatMap((r) => feeCols.map((c) => r[c])));
  const cancel = unknown ? null : sum(canc.map((r) => r.order_amount));
  const refund = sum(rows.filter((r) => r.status !== 'cancelled').map((r) => r.refund));
  const net = cancel === null ? null : gross - fee - cancel - refund;
  const counter = new Map<string, number>();
  for (const r of rows) {
    const k = fname(r.file_name);
    counter.set(k, (counter.get(k) ?? 0) + 1);
  }
  return {
    n: rows.length,
    n_cancelled: canc.length,
    n_unknown: unknown,
    gross,
    fee,
    cancel,
    refund,
    net,
    payout: sum(rows.map((r) => r.payout)),
    files: pySorted(counter.keys()).map((k) => [k, counter.get(k) as number]),
  };
}

export type Summary = {
  channels: Record<string, Figures | null>;
  total: Record<MoneyKey, bigint | null>;
  notes: string[];
  anomaly: boolean;
};

/**
 * → {channels: {kênh: số | null}, total: {khóa: số | null}, notes, anomaly}. `overlap` = `overlaps()`
 * của kỳ: kênh có khoản xuất lại ở ≥2 file → BẤT THƯỜNG (không tính phí) kèm tên file.
 */
export function summarize(
  rows: readonly RevRow[],
  channels: readonly string[],
  feeCols: readonly FeeCol[],
  overlap: Record<string, Overlap> | null = null,
): Summary {
  const out: Record<string, Figures | null> = {};
  const notes: string[] = [];
  const ov = overlap ?? {};
  for (const ch of channels) {
    const mine = rows.filter((r) => r.channel === ch);
    if (!mine.length) {
      out[ch] = null;
      notes.push(
        `${ch}: ${NO_DATA} — không có dòng quyết toán trong` +
          ' kỳ (chưa nạp file `ingest.settlement_csv` hoặc' +
          ' kênh không phát sinh — 2 bên xác nhận)',
      );
      continue;
    }
    const f = channelFigures(mine, feeCols);
    out[ch] = f;
    if (f.n_unknown) {
      notes.push(
        `${ch}: ${f.n_unknown} dòng quyết toán chưa có` +
          ' trạng thái đơn trong `orders` (nạp file đơn rồi' +
          ' chạy `python -m agents.kd_orders --sync`) → Hủy/' +
          `Thuần ${NO_DATA}`,
      );
    }
    if (f.refund > f.gross) {
      notes.push(
        `${ch}: BẤT THƯỜNG — Hoàn (${vnd(f.refund)}) >` +
          ` Gộp (${vnd(f.gross)}): hoàn của đơn kỳ trước` +
          ' hoặc lỗi file — cần giải trình (Điều 7.5)',
      );
    }
    if (f.net !== null && f.net < 0n) notes.push(`${ch}: BẤT THƯỜNG — Thuần âm (${vnd(f.net)})`);
  }
  for (const ch of channels) {
    const o = ov[ch];
    if (o && (o.trung || o.lech)) {
      notes.push(
        `${ch}: BẤT THƯỜNG — khoản quyết toán xuất lại ở ≥2 file` +
          ` (chồng kỳ): trùng nguyên văn ${o.trung} (đã tính 1` +
          ` lần), lệch số ${o.lech} (giữ cả hai, KHÔNG tự chọn` +
          ` file) — nguồn: ${o.files.map(fname).join(', ')}` +
          ' — người đối soát xác nhận/loại bản thừa (Điều 7.5)',
      );
    }
  }
  const total = {} as Record<MoneyKey, bigint | null>;
  for (const k of MONEY_KEYS) {
    const vals = Object.values(out).map((f) => (f === null ? null : f[k]));
    total[k] = vals.some((v) => v === null) ? null : (vals as bigint[]).reduce((a, b) => a + b, 0n);
  }
  return {
    channels: out,
    total,
    notes,
    anomaly: notes.some((n) => n.includes('BẤT THƯỜNG')),
  };
}

/** Phí vận hành quý → [số, null] | [null, lý do]. `anomaly` (có kênh BẤT THƯỜNG) → không tính phí. */
export function opsFee(
  net: bigint | null,
  rate: Dec | null,
  start: string | null,
  anomaly = false,
): [bigint | null, string | null] {
  if (rate === null) return [null, `${NOT_SET} tỷ lệ phí vận hành`];
  if (start === null) return [null, `${NOT_SET} ngày bắt đầu vận hành thương mại`];
  if (net === null) return [null, `doanh thu thuần ${NO_DATA}`];
  if (net < 0n) return [null, 'doanh thu thuần âm — 2 bên giải trình (Điều 7.5)'];
  if (anomaly) return [null, 'có kênh bất thường — 2 bên giải trình (Điều 7.5)'];
  return [mulRound(net, rate), null];
}

export type TierRow = {
  muc: number;
  tu_vnd: number | null;
  ty_le: Dec | null;
  dat: boolean | null;
  vuot: bigint | null;
  thuong: bigint | null;
  trang_thai: string;
};

/**
 * So doanh thu thuần năm với từng mức thưởng (PL02 mục 4). `anomaly` (kênh BẤT THƯỜNG) → không xét
 * đạt/thưởng (v13 vá review F01 — trước đây năm vẫn so mức trên số gấp đôi).
 */
export function tierRows(net: bigint | null, tiers: readonly Tier[], anomaly = false): TierRow[] {
  return tiers.map((t) => {
    const r: TierRow = {
      muc: t.muc,
      tu_vnd: t.tu_vnd,
      ty_le: t.ty_le,
      dat: null,
      vuot: null,
      thuong: null,
      trang_thai: '',
    };
    if (t.tu_vnd === null) r.trang_thai = `${NOT_SET} ngưỡng`;
    else if (anomaly) r.trang_thai = 'bất thường — chưa xét mức, 2 bên giải trình (Điều 7.5)';
    else if (net === null) r.trang_thai = NO_DATA;
    else {
      r.dat = net >= BigInt(t.tu_vnd);
      r.trang_thai = r.dat ? 'đạt' : 'chưa đạt';
      if (r.dat) {
        r.vuot = net - BigInt(t.tu_vnd);
        if (t.ty_le !== null) r.thuong = mulRound(r.vuot, t.ty_le);
      }
    }
    return r;
  });
}

// ------------------------------------------------------------------ DB

const ROW_COLS = ['order_amount', ...FEE_COLS, 'refund', 'payout'] as const;

/** CHỈ SELECT → [dòng quyết toán kèm trạng thái đơn, {kênh: số dòng không có ngày quyết toán}]. */
export async function fetch(
  c: Db,
  start: string,
  end: string,
  channels: readonly string[],
): Promise<[RevRow[], Record<string, number>]> {
  const r = await c.query(ROW_SQL, [start, end, [...channels]]);
  const rows = (r.rows as Record<string, unknown>[]).map((x) => {
    const row: Record<string, unknown> = {
      channel: x.channel,
      file_name: x.file_name,
      status: x.status ?? null,
    };
    for (const k of ROW_COLS) row[k] = BigInt(x[`${k}_vnd`] as string);
    return row as RevRow;
  });
  const undated: Record<string, number> = {};
  for (const u of (await c.query(UNDATED_SQL, [[...channels]])).rows as {
    channel: string;
    n: string;
  }[]) {
    undated[u.channel] = Number(u.n);
  }
  return [rows, undated];
}

/** JSON (jsonb) với bigint giữ nguyên chữ số, Dec thành số thập phân. */
export function bigJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(bigJson).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${JSON.stringify(k)}: ${bigJson(x)}`)
    .join(', ')}}`;
}

/**
 * Ghi 1 dòng `revenue_quarters` (append-only) + commit tường minh — `c` là client đang trong
 * transaction. finance-06 TẮT → RolloutBlocked (HĐ 6.7), không ghi.
 */
export async function record(
  c: Db,
  label: string,
  start: string,
  end: string,
  s: Summary,
  rate: Dec | null,
  fee: bigint | null,
  text: string,
  cfg: Pick<RevCfg, 'fee_cols' | 'start' | 'sign'>,
): Promise<string> {
  await checkGenerate(c, FEATURE, 'sổ đối soát quý');
  const t = s.total;
  const detail = bigJson({
    channels: s.channels,
    notes: s.notes,
    phi_san_cot: cfg.fee_cols,
    ngay_bat_dau_van_hanh: cfg.start,
    ngay_ky_hop_dong: cfg.sign,
  });
  const n = (v: bigint | null) => (v === null ? null : v.toString());
  const r = await c.query(
    'insert into revenue_quarters (quarter, period_start, period_end,' +
      ' gross_vnd, platform_fee_vnd, cancel_vnd, refund_vnd, net_vnd,' +
      ' payout_vnd, fee_rate, ops_fee_vnd, detail, report_sha256,' +
      ' recorded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,' +
      ' $12::jsonb, $13, $14) returning id',
    [
      label,
      start,
      end,
      n(t.gross),
      n(t.fee),
      n(t.cancel),
      n(t.refund),
      n(t.net),
      n(t.payout),
      rate === null ? null : decStr(rate),
      n(fee),
      detail,
      createHash('sha256').update(text, 'utf8').digest('hex'),
      RUN_BY,
    ],
  );
  await c.query('commit');
  return String(r.rows[0]?.id);
}

// ------------------------------------------------------------------ báo cáo

const m = (v: bigint | null): string => (v === null ? NO_DATA : vnd(v));

/** `f"{(rate * 100).normalize():f}%"` | "chưa chốt". */
export function pct(rate: Dec | null): string {
  return rate === null ? NOT_SET : `${decStr({ n: rate.n * 100n, k: rate.k })}%`;
}

function figuresTable(s: Summary, start: string, end: string): string[] {
  const last = addDays(end, -1);
  const out = [
    '| Kênh | Gộp | Phí sàn | Hủy | Hoàn | **Thuần** | Thực nhận trên file | Nguồn |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [ch, f] of Object.entries(s.channels)) {
    if (f === null) {
      out.push(
        `| ${ch} | ${NO_DATA} | ${NO_DATA} | ${NO_DATA} |` +
          ` ${NO_DATA} | **${NO_DATA}** | ${NO_DATA} | — |`,
      );
      continue;
    }
    const files = f.files.map(([n, k]) => `${n} (${k} dòng)`).join(', ');
    let src =
      '`v_settlement_khoan` (`settlement_rows`, bản xuất lại' +
      ` nguyên văn tính 1 lần) settled_on ${start} → ${last},` +
      ` ${f.n} khoản: ${files}; Hủy: \`orders\` (source market:${ch})` +
      ` ${f.n_cancelled} đơn hủy`;
    if (f.n_unknown) src += `, ${f.n_unknown} dòng chưa thấy đơn`;
    out.push(
      `| ${ch} | ${m(f.gross)} | ${m(f.fee)} |` +
        ` ${m(f.cancel)} | ${m(f.refund)} |` +
        ` **${m(f.net)}** | ${m(f.payout)} | ${src} |`,
    );
  }
  const t = s.total;
  out.push(
    `| **Tổng** | ${m(t.gross)} | ${m(t.fee)} |` +
      ` ${m(t.cancel)} | ${m(t.refund)} | **${m(t.net)}**` +
      ` | ${m(t.payout)} | Σ các kênh (thiếu 1 kênh → ${NO_DATA}) |`,
  );
  return out;
}

const WARN =
  '> **BẢN ĐỀ XUẤT do hệ thống lập** — chỉ có giá trị khi đại diện 2' +
  ' bên ký (HĐ hợp tác Điều 7.5, 8.3). Xung đột lợi ích (Điều 7.6):' +
  ' Bên A vận hành hệ thống và hưởng phí tính trên số này → Bên B kiểm' +
  ' và ký; người của Bên A không tự duyệt. Chênh lệch → bên quản lý số' +
  ' liệu giải trình bằng văn bản trong 05 ngày làm việc.';
const FORMULA =
  'Công thức: Thuần = Gộp − Phí sàn − Hủy − Hoàn. Hủy = Σ giá trị' +
  ' đơn của dòng quyết toán có đơn trạng thái hủy (hoàn của các' +
  ' dòng đó đã nằm trong Hủy, không trừ 2 lần). Thực nhận trên' +
  ' file (Σ `payout_vnd`) chỉ để đối chiếu.';

function head(cfg: RevCfg, period: string, now: Date): string[] {
  const cols = cfg.fee_cols.map((c) => `\`${c}_vnd\``).join(', ');
  return [
    WARN,
    '',
    '| Ô | Nội dung |',
    '|---|---|',
    `| Kỳ | ${period} |`,
    `| Ngày lập | ${vnFormat(now, '%Y-%m-%d %H:%M')} (giờ VN) |`,
    `| Kênh trực tuyến | ${cfg.channels.join(', ')} · website: chưa có nguồn (website bán hàng làm riêng sau) |`,
    `| Phí sàn gồm | ${cols} (GIẢ ĐỊNH — 2 bên chốt) |`,
    `| Ngày ký hợp đồng (mốc năm hợp tác) | ${cfg.sign ?? NOT_SET} |`,
    `| Ngày bắt đầu vận hành thương mại | ${cfg.start ?? NOT_SET} |`,
    '',
    '## Số liệu',
    '',
  ];
}

function notesBlock(s: Summary, undated: Record<string, number>): string[] {
  const notes = [
    ...s.notes,
    ...pySorted(Object.keys(undated)).map(
      (ch) =>
        `${ch}: ${undated[ch]} dòng quyết toán không có ngày quyết toán — không xếp` +
        ' được vào kỳ nào (KHÔNG tính)',
    ),
  ];
  return [
    '## Ghi chú / thiếu nguồn',
    '',
    ...(notes.length ? notes.map((n) => `- ${n}`) : ['- (không)']),
  ];
}

export function renderQuarter(
  label: string,
  start: string,
  end: string,
  s: Summary,
  undated: Record<string, number>,
  cfg: RevCfg,
  fee: bigint | null,
  feeWhy: string | null,
  now: Date,
): string {
  const period = `${label}: ${start} → ${addDays(end, -1)} (giờ VN, theo ngày quyết toán)`;
  const feeTxt = fee !== null ? vnd(fee) : `— (${feeWhy})`;
  return [
    `# Biên bản đối soát doanh thu thuần trực tuyến — quý ${label}`,
    '',
    ...head(cfg, period, now),
    ...figuresTable(s, start, end),
    '',
    FORMULA,
    '',
    '## Phí vận hành (Điều 9.3, PL02 mục 5)',
    '',
    '| Ô | Nội dung |',
    '|---|---|',
    `| Tỷ lệ phí vận hành | ${pct(cfg.rate)} |`,
    `| Phí vận hành (quy đổi sản phẩm) | ${feeTxt} |`,
    '',
    ...notesBlock(s, undated),
    '',
    '## Chênh lệch và giải trình (Điều 7.5)',
    '',
    '(2 bên ghi tay)',
    '',
    '## Ký xác nhận',
    '',
    '| Đại diện Bên A | Đại diện Bên B |',
    '|---|---|',
    '| (ký, ghi rõ họ tên) | (ký, ghi rõ họ tên) |',
    '| | |',
    '',
  ].join('\n');
}

export function renderYear(
  n: number,
  start: string,
  end: string,
  s: Summary,
  undated: Record<string, number>,
  cfg: RevCfg,
  now: Date,
): string {
  const period = `năm ${n}: ${start} → ${addDays(end, -1)} (giờ VN)`;
  const lines = [
    `# Doanh thu thuần trực tuyến — năm hợp tác thứ ${n}`,
    '',
    ...head(cfg, period, now),
    ...figuresTable(s, start, end),
    '',
    FORMULA,
    '',
    '## So mức thưởng (PL02 mục 4)',
    '',
    '| Mức | Ngưỡng/năm | Tỷ lệ trên phần vượt | Trạng thái | Phần vượt | Thưởng tạm tính |',
    '|---|---|---|---|---|---|',
  ];
  for (const t of tierRows(s.total.net, cfg.tiers, s.anomaly)) {
    const tu = t.tu_vnd === null ? NOT_SET : vnd(t.tu_vnd);
    const vuot = t.vuot === null ? '—' : vnd(t.vuot);
    const thuong = t.thuong === null ? '—' : vnd(t.thuong);
    lines.push(`| ${t.muc} | ${tu} | ${pct(t.ty_le)} | ${t.trang_thai} | ${vuot} | ${thuong} |`);
  }
  lines.push(
    '',
    'Cách cộng dồn giữa các mức chưa xác định (2 bên chốt); căn cứ chính thức là các biên bản đối soát quý đã ký.',
    '',
    ...notesBlock(s, undated),
    '',
  );
  return lines.join('\n');
}
