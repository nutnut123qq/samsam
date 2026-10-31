import type { Db } from '@samsam/core/ops/deps';
import { cpCmp, PyFloat } from '@samsam/core/ops/py-json';
import { cogsAt, fetchVersions, NO_COGS } from '../kd_price/deps.js';
import { type Dec, decOf, quantize, rat, roundRat } from './dec.js';

// Phần `agents/fp_pnl.py` mà FP-AdsBudget + MKT-05 gọi lại: `vnd`, `parse_month`, `frac`,
// `allocate`, `pnl` (ô SKU × kênh) + `compute` (đọc DB). Ngày = chuỗi 'YYYY-MM-DD'.
// shortcut: bản riêng của nhóm mkt_ads (fp_pnl chưa có port dùng chung; `compute` bỏ `chong_ky` vì
// fp_ads/mkt_ads chỉ đọc `cells`) — khi nhóm FP&A port `agents/fp_pnl.py` thì import dùng chung.

export { NO_COGS };
export const UNKNOWN_SKU = '(chưa rõ SKU)';
// khoản sàn trừ (dương = sàn trừ, âm = sàn bù — đã chuẩn hóa ở v9.0)
export const DEDUCT = [
  'fixed_fee_vnd',
  'payment_fee_vnd',
  'service_fee_vnd',
  'shipping_fee_vnd',
  'voucher_seller_vnd',
  'affiliate_vnd',
] as const;
const MONTH_RE = /^([0-9]{4})-(0[1-9]|1[0-2])$/;

/** `fp_pnl.vnd`: `f"{int(n):,}".replace(",", ".") + "đ"`. */
export function vnd(n: number | bigint): string {
  const s = (typeof n === 'bigint' ? n : BigInt(Math.trunc(n))).toString();
  const neg = s.startsWith('-');
  const d = neg ? s.slice(1) : s;
  return `${neg ? '-' : ''}${d.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
}

/** 'YYYY-MM' → 'YYYY-MM-01'; sai → null (CLI exit 2). Khác Python có chủ đích: năm 0000 → null
 * (Python `date(0, …)` ném ValueError — traceback). */
export function parseMonth(s: unknown): string | null {
  const m = typeof s === 'string' ? MONTH_RE.exec(s) : null;
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-01` : null;
}

/** Ngày 1 tháng sau của ngày 1 tháng `m`. */
export function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12
    ? `${String(y + 1).padStart(4, '0')}-01-01`
    : `${m.slice(0, 5)}${String(mo + 1).padStart(2, '0')}-01`;
}

/** `fp_pnl.frac`: số 0..1 (không bool) → Decimal. */
export function frac(v: unknown, where: string): [Dec, null] | [null, string] {
  if (!(typeof v === 'number' || v instanceof PyFloat)) return [null, `${where}: phải là số 0..1`];
  const x = v instanceof PyFloat ? v.v : v;
  if (!(x >= 0 && x <= 1)) return [null, `${where}: ngoài 0..1`];
  return [decOf(v), null];
}

/** `fp_pnl.allocate`: chia `total` theo trọng số, làm tròn ROUND_HALF_UP, phần dư dồn phần tử cuối. */
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) {
    if (total) throw new RangeError('allocate: không có phần tử để phân bổ');
    return [];
  }
  const ws = weights.some((w) => w) ? weights : weights.map(() => 1);
  const s = ws.reduce((a, b) => a + BigInt(b), 0n);
  // Python: Decimal chia 0 → DivisionByZero (traceback); TS: lỗi ValueError-tương-đương (exit 1).
  if (s === 0n) throw new RangeError('allocate: tổng trọng số = 0');
  const out = ws
    .slice(0, -1)
    .map((w) => Number(roundRat(rat(BigInt(total) * BigInt(w), s), 'half_up')));
  return [...out, total - out.reduce((a, b) => a + b, 0)];
}

/** `fp_pnl._bien`: lãi × 100 / doanh thu, 1 chữ số thập phân ROUND_HALF_UP; doanh thu 0 → null. */
export function bien(lai: number, dt: number): Dec | null {
  if (!dt) return null;
  return quantize(rat(BigInt(lai) * 100n, BigInt(dt)), -1, 'half_up', lai < 0 !== dt < 0);
}

export type SettleRow = {
  id: number;
  channel: string;
  order_id_hash: string;
  order_amount_vnd: number;
  refund_vnd: number;
  payout_vnd: number;
  settled_on: string | null;
  label: string | null;
} & Record<(typeof DEDUCT)[number], number>;
export type OrderLine = {
  channel: string;
  order_id_hash: string;
  row_no: number;
  sku_key: string | null;
  qty: number;
  price_vnd: number;
};
export type Cell = {
  sku_key: string;
  channel: string;
  doanh_thu: number | null;
  khau_tru_san: number | null;
  hoan: number | null;
  thuc_nhan: number;
  gia_von: number | null;
  so_dong: number;
  lai_gop: number | null;
  bien_gop_pct: Dec | null;
  nhan: string | null;
};
export type Pnl = {
  month: string;
  channel: string | null;
  n_rows: number;
  thieu_ngay: number;
  thieu_chung_tu: number;
  hoan: number;
  tong_thuc_nhan: number;
  tong_lai_gop: number;
  loai: string[];
  cells: Cell[];
};

/** `fp_pnl.pnl` THUẦN: thực nhận quyết toán phân bổ theo dòng đơn sàn; giá vốn ĐÃ duyệt tại ngày
 * quyết toán. Ô (sku_key, kênh); SKU thiếu giá vốn → lãi/biên null + nhãn. */
export function pnl(
  rowsIn: SettleRow[],
  lines: OrderLine[],
  versions: Parameters<typeof cogsAt>[0],
  month: string,
  channel: string | null = null,
): Pnl {
  const start = month;
  const end = nextMonth(month);
  const rows = channel === null ? rowsIn : rowsIn.filter((r) => r.channel === channel);
  const byOrder = new Map<string, OrderLine[]>();
  for (const ln of [...lines].sort((a, b) => a.row_no - b.row_no)) {
    const k = `${ln.channel}\u0000${ln.order_id_hash}`;
    const arr = byOrder.get(k);
    if (arr) arr.push(ln);
    else byOrder.set(k, [ln]);
  }
  type Acc = Omit<Cell, 'lai_gop' | 'bien_gop_pct' | 'nhan'> & {
    doanh_thu: number;
    khau_tru_san: number;
    hoan: number;
    gia_von: number;
    thieu: boolean;
  };
  const cells = new Map<string, Acc>();
  const cell = (sku: string, ch: string): Acc => {
    const k = `${sku}\u0000${ch}`;
    let c = cells.get(k);
    if (!c) {
      c = {
        sku_key: sku,
        channel: ch,
        doanh_thu: 0,
        khau_tru_san: 0,
        hoan: 0,
        thuc_nhan: 0,
        gia_von: 0,
        so_dong: 0,
        thieu: false,
      };
      cells.set(k, c);
    }
    return c;
  };
  const out = { n_rows: 0, thieu_ngay: 0, thieu_chung_tu: 0, hoan: 0, tong_thuc_nhan: 0 };
  for (const r of rows) {
    const day = r.settled_on;
    if (day === null) {
      out.thieu_ngay += 1;
      continue;
    }
    if (!(start <= day && day < end)) continue;
    out.n_rows += 1;
    out.tong_thuc_nhan += r.payout_vnd;
    out.hoan += r.label === 'hoan' ? 1 : 0;
    const ls = byOrder.get(`${r.channel}\u0000${r.order_id_hash}`);
    if (!ls?.length) {
      out.thieu_chung_tu += 1;
      const c = cell(UNKNOWN_SKU, r.channel);
      c.thuc_nhan += r.payout_vnd;
      c.so_dong += 1;
      continue;
    }
    const w = ls.map((ln) => ln.price_vnd * ln.qty);
    const parts = {
      doanh_thu: allocate(r.order_amount_vnd, w),
      khau_tru_san: allocate(
        DEDUCT.reduce((a, f) => a + r[f], 0),
        w,
      ),
      hoan: allocate(r.refund_vnd, w),
      thuc_nhan: allocate(r.payout_vnd, w),
    };
    ls.forEach((ln, i) => {
      const sku = ln.sku_key || UNKNOWN_SKU;
      const c = cell(sku, r.channel);
      c.so_dong += 1;
      if (sku === UNKNOWN_SKU) {
        c.thuc_nhan += parts.thuc_nhan[i] as number;
        return;
      }
      for (const k of ['doanh_thu', 'khau_tru_san', 'hoan', 'thuc_nhan'] as const) {
        c[k] += parts[k][i] as number;
      }
      if (ln.qty) {
        const cost = cogsAt(versions, sku, day);
        if (cost === null) c.thieu = true;
        else c.gia_von += ln.qty * cost;
      }
    });
  }
  const loai = new Set<string>();
  let tongLai = 0;
  const res: Cell[] = [];
  const sorted = [...cells.values()].sort(
    (a, b) => cpCmp(a.sku_key, b.sku_key) || cpCmp(a.channel, b.channel),
  );
  for (const c of sorted) {
    const base = {
      sku_key: c.sku_key,
      channel: c.channel,
      thuc_nhan: c.thuc_nhan,
      so_dong: c.so_dong,
    };
    if (c.sku_key === UNKNOWN_SKU) {
      res.push({
        ...base,
        doanh_thu: null,
        khau_tru_san: null,
        hoan: null,
        gia_von: null,
        lai_gop: null,
        bien_gop_pct: null,
        nhan: null,
      });
    } else if (c.thieu) {
      loai.add(c.sku_key);
      res.push({
        ...base,
        doanh_thu: c.doanh_thu,
        khau_tru_san: c.khau_tru_san,
        hoan: c.hoan,
        gia_von: null,
        lai_gop: null,
        bien_gop_pct: null,
        nhan: NO_COGS,
      });
    } else {
      const lai = c.thuc_nhan - c.gia_von;
      tongLai += lai;
      res.push({
        ...base,
        doanh_thu: c.doanh_thu,
        khau_tru_san: c.khau_tru_san,
        hoan: c.hoan,
        gia_von: c.gia_von,
        lai_gop: lai,
        bien_gop_pct: bien(lai, c.doanh_thu),
        nhan: null,
      });
    }
  }
  return {
    month,
    channel,
    ...out,
    cells: res,
    tong_lai_gop: tongLai,
    loai: [...loai].sort(cpCmp),
  };
}

// ---------------------------------------------------------------- DB

const N = (v: unknown): number => Number(v ?? 0);

/** Khoản quyết toán trong tháng (giờ VN) + dòng thiếu ngày — view `v_settlement_khoan` (bản xuất lại
 * nguyên văn ở file khác tính 1 lần, cùng số với rev_share/BKS/view Bên A). */
export async function fetchRows(db: Db, month: string): Promise<SettleRow[]> {
  const cols = [
    'id',
    'channel',
    'order_id_hash',
    'order_amount_vnd',
    ...DEDUCT,
    'refund_vnd',
    'payout_vnd',
  ];
  const { rows } = await db.query(
    `select ${cols.map((c) => `s.${c}`).join(', ')}, s.settled_on::text as settled_on, r.label from v_settlement_khoan s left join recon_results r on r.settlement_row_id = s.id where (s.settled_on >= $1 and s.settled_on < $2) or s.settled_on is null order by s.id`,
    [month, nextMonth(month)],
  );
  return rows.map((r) => {
    const o: Record<string, unknown> = {
      id: N(r.id),
      channel: r.channel,
      order_id_hash: r.order_id_hash,
      settled_on: r.settled_on ?? null,
      label: r.label ?? null,
    };
    for (const c of ['order_amount_vnd', ...DEDUCT, 'refund_vnd', 'payout_vnd']) o[c] = N(r[c]);
    return o as SettleRow;
  });
}

// Dòng đơn của snapshot `order` MỚI NHẤT chứa mã đơn — CÙNG quy tắc `settlement_csv._ORDER_SQL`.
const LINES_SQL =
  "with latest as (select distinct on (channel, order_id_hash) channel, order_id_hash, snapshot_id from market_rows where export_kind = 'order' and order_id_hash = any($1) order by channel, order_id_hash, snapshot_id desc) select m.channel, m.order_id_hash, m.row_no, m.sku_key, coalesce(m.qty, 0) as qty, coalesce(m.price_vnd, 0) as price_vnd from latest l join market_rows m on m.snapshot_id = l.snapshot_id and m.channel = l.channel and m.order_id_hash = l.order_id_hash and m.export_kind = 'order' order by m.channel, m.order_id_hash, m.row_no";

export async function fetchLines(db: Db, hashes: string[]): Promise<OrderLine[]> {
  if (!hashes.length) return [];
  const { rows } = await db.query(LINES_SQL, [[...new Set(hashes)].sort(cpCmp)]);
  return rows.map((r) => ({
    channel: r.channel,
    order_id_hash: r.order_id_hash,
    row_no: N(r.row_no),
    sku_key: r.sku_key ?? null,
    qty: N(r.qty),
    price_vnd: N(r.price_vnd),
  }));
}

/** `fp_pnl.compute` (không `chong_ky`). */
export async function compute(db: Db, month: string, channel: string | null = null): Promise<Pnl> {
  const rows = await fetchRows(db, month);
  const lines = await fetchLines(
    db,
    rows.map((r) => r.order_id_hash),
  );
  return pnl(rows, lines, await fetchVersions(db), month, channel);
}
