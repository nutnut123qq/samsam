import type { Db } from '@samsam/core/ops/deps';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { pyStrip } from '@samsam/core/security/py';
import {
  CHANNELS,
  cpCmp,
  fmtDay,
  monthBounds,
  type Overlap,
  overlaps,
  roundHalfUpFrac,
  safe,
  vnd,
} from './fin-common.js';

// Port `agents/fp_pnl.py` (v9.1 FP-COGS-PnL, WP12) — giá vốn theo SKU có ngày hiệu lực (người lập ≠
// người duyệt, chặn ở DB `approve_cogs`) + P&L SKU × kênh × tháng từ thực nhận quyết toán sàn. Tất
// định, KHÔNG LLM/mạng, KHÔNG gửi, KHÔNG bút toán. Ownership: ghi DUY NHẤT `cogs_versions` (INSERT
// dòng chưa duyệt; duyệt qua function `approve_cogs`); chỉ ĐỌC `settlement_rows`(view
// `v_settlement_khoan`) + `recon_results`, `market_rows`, `sku_master`. Báo cáo `pnl-<YYYY-MM>[-<kênh>].md`
// = BẢN NHÁP tới khi GĐ tài chính ký.
// shortcut: tiền VND là `number` (an toàn tới 2^53 ≈ 9e15 — trần 1 dòng 1e15); phép chia/làm tròn
// dùng BigInt chính xác. Python `Decimal` (28 chữ số) chỉ lệch khi phần lẻ trong 1e-13 quanh .5 —
// không xảy ra với mẫu số = tổng giá dòng đơn thật.

export const UNKNOWN_SKU = '(chưa rõ SKU)';
export const NO_COGS = 'chưa có giá vốn duyệt';
export const DRAFT_HEAD = 'BẢN NHÁP — chỉ thành chính thức khi GĐ tài chính ký';
export const MAX_BY = 100;
export const COST_CAP = 10 ** 12;
export const SKU_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FEATURE_PNL = 'finance-04.1';
// khoản sàn trừ (dương = sàn trừ, âm = sàn bù — đã chuẩn hóa ở v9.0)
export const DEDUCT = [
  'fixed_fee_vnd',
  'payment_fee_vnd',
  'service_fee_vnd',
  'shipping_fee_vnd',
  'voucher_seller_vnd',
  'affiliate_vnd',
] as const;

export type CogsVersion = {
  id: number;
  sku_key: string;
  cost_vnd: number;
  valid_from: string;
  approved_by: string | null;
};
export type SettleRow = {
  id?: number;
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
  /** Python `Decimal` 1 chữ số lẻ (vd "43.0", "-0.3") | null. */
  bien_gop_pct: string | null;
  nhan: string | null;
};
export type PnlResult = {
  month: string;
  channel: string | null;
  n_rows: number;
  thieu_ngay: number;
  thieu_chung_tu: number;
  hoan: number;
  tong_thuc_nhan: number;
  cells: Cell[];
  tong_lai_gop: number;
  loai: string[];
  chong_ky?: Record<string, Overlap>;
};

// ---------------------------------------------------------------- hàm thuần

/** Dòng ĐÃ duyệt có `valid_from` lớn nhất ≤ day (hòa → id lớn nhất); không có → null (KHÔNG suy, KHÔNG 0). */
export function cogsAt(versions: CogsVersion[], sku: string, day: string): number | null {
  let best: [string, number, number] | null = null;
  for (const v of versions) {
    if (v.sku_key !== sku || !pyStrip(v.approved_by ?? '')) continue;
    if (v.valid_from > day) continue;
    if (best === null || v.valid_from > best[0] || (v.valid_from === best[0] && v.id > best[1])) {
      best = [v.valid_from, v.id, v.cost_vnd];
    }
  }
  return best === null ? null : best[2];
}

/** Phân bổ tỉ lệ ROUND_HALF_UP, dư dồn phần tử cuối → tổng giữ chính xác; weights toàn 0 → chia đều. */
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) {
    if (total) throw new RangeError('allocate: không có phần tử để phân bổ');
    return [];
  }
  const ws = weights.some((w) => w) ? weights.map(BigInt) : weights.map(() => 1n);
  const s = ws.reduce((a, b) => a + b, 0n);
  const t = BigInt(total);
  const out = ws.slice(0, -1).map((w) => roundHalfUpFrac(t * w, s));
  return [...out, t - out.reduce((a, b) => a + b, 0n)].map(Number);
}

/** Biên gộp % = lãi × 100 / doanh thu, 1 chữ số lẻ ROUND_HALF_UP (chuỗi Decimal, giữ dấu "-0.0"). */
function bien(lai: number, dt: number): string | null {
  if (!dt) return null;
  // dấu như Decimal: 0 / số âm = "-0" (doanh thu ô có thể âm khi phần dư phân bổ dồn cuối)
  const neg = lai < 0 !== dt < 0;
  const a = BigInt(Math.abs(lai)) * 1000n;
  const b = BigInt(Math.abs(dt));
  const n = roundHalfUpFrac(a, b);
  return `${neg ? '-' : ''}${n / 10n}.${n % 10n}`;
}

type Acc = {
  sku_key: string;
  channel: string;
  doanh_thu: number;
  khau_tru_san: number;
  hoan: number;
  thuc_nhan: number;
  gia_von: number;
  thieu_gia_von: boolean;
  so_dong: number;
};

/**
 * rows = dòng quyết toán (+ nhãn đối soát), lines = dòng đơn sàn của snapshot `order` MỚI NHẤT chứa
 * mã đơn. `channel` lọc dòng quyết toán TRƯỚC khi tính → mọi số đếm theo đúng kênh. Mỗi dòng quyết
 * toán phân bổ theo trọng số `price × qty`; giá vốn = Σ qty × giá vốn đã duyệt tại `settled_on`. Ô
 * thiếu giá vốn → gia_von/lai_gop/bien None + nhãn; không thấy đơn / không map SKU → "(chưa rõ SKU)"
 * chỉ có thuc_nhan. GIẢ ĐỊNH thận trọng: dòng hoàn vẫn tính giá vốn theo qty đơn.
 */
export function pnl(
  rows: SettleRow[],
  lines: OrderLine[],
  versions: CogsVersion[],
  month: string,
  channel: string | null = null,
): PnlResult {
  const [start, end] = monthBounds(month);
  const rs = channel === null ? rows : rows.filter((r) => r.channel === channel);
  const byOrder = new Map<string, OrderLine[]>();
  for (const ln of [...lines].sort((a, b) => a.row_no - b.row_no)) {
    const k = `${ln.channel}|${ln.order_id_hash}`;
    const arr = byOrder.get(k) ?? [];
    arr.push(ln);
    byOrder.set(k, arr);
  }
  const cells = new Map<string, Acc>();
  const cell = (sku: string, ch: string): Acc => {
    const k = JSON.stringify([sku, ch]);
    let c = cells.get(k);
    if (c === undefined) {
      c = {
        sku_key: sku,
        channel: ch,
        doanh_thu: 0,
        khau_tru_san: 0,
        hoan: 0,
        thuc_nhan: 0,
        gia_von: 0,
        thieu_gia_von: false,
        so_dong: 0,
      };
      cells.set(k, c);
    }
    return c;
  };
  let nRows = 0;
  let thieuNgay = 0;
  let thieuChungTu = 0;
  let hoan = 0;
  let tongThucNhan = 0;
  for (const r of rs) {
    const day = r.settled_on;
    if (day === null || day === undefined) {
      thieuNgay += 1;
      continue;
    }
    if (!(start <= day && day < end)) continue;
    nRows += 1;
    tongThucNhan += r.payout_vnd;
    if (r.label === 'hoan') hoan += 1;
    const ls = byOrder.get(`${r.channel}|${r.order_id_hash}`);
    if (!ls?.length) {
      thieuChungTu += 1;
      const c = cell(UNKNOWN_SKU, r.channel);
      c.thuc_nhan += r.payout_vnd;
      c.so_dong += 1;
      continue;
    }
    const w = ls.map((ln) => ln.price_vnd * ln.qty);
    const parts = {
      doanh_thu: allocate(r.order_amount_vnd, w),
      khau_tru_san: allocate(
        DEDUCT.reduce((s, f) => s + r[f], 0),
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
      c.doanh_thu += parts.doanh_thu[i] as number;
      c.khau_tru_san += parts.khau_tru_san[i] as number;
      c.hoan += parts.hoan[i] as number;
      c.thuc_nhan += parts.thuc_nhan[i] as number;
      if (ln.qty) {
        const cost = cogsAt(versions, sku, day);
        if (cost === null) c.thieu_gia_von = true;
        else c.gia_von += ln.qty * cost;
      }
    });
  }
  const res: Cell[] = [];
  const loai = new Set<string>();
  let tongLai = 0;
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
    } else if (c.thieu_gia_von) {
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
    n_rows: nRows,
    thieu_ngay: thieuNgay,
    thieu_chung_tu: thieuChungTu,
    hoan,
    tong_thuc_nhan: tongThucNhan,
    cells: res,
    tong_lai_gop: tongLai,
    loai: [...loai].sort(cpCmp),
  };
}

const m = (v: number | null): string => (v === null ? '—' : vnd(v));

/** Markdown P&L — chỉ sku_key/kênh/số tiền (không mã đơn/hash/tên). Kênh lọc lấy từ `result`. */
export function render(result: PnlResult): string {
  const channel = result.channel;
  const cells = result.cells;
  const L = [
    `# P&L theo SKU × kênh — tháng ${fmtDay(result.month, '%m/%Y')}`,
    '',
    `**${DRAFT_HEAD}.**`,
    '',
    `Nguồn: thực nhận quyết toán sàn (\`settlement_rows\`, theo ngày quyết toán giờ VN) phân bổ theo dòng đơn sàn; giá vốn = dòng ĐÃ duyệt (\`cogs_versions\`) hiệu lực tại ngày quyết toán.${channel ? ` Lọc kênh: ${channel}.` : ''}`,
    '',
    '| SKU | Kênh | Doanh thu | Khấu trừ sàn | Hoàn | Thực nhận | Giá vốn | Lãi gộp | Biên gộp |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of cells) {
    const cost = c.nhan ? NO_COGS : m(c.gia_von);
    const b = c.bien_gop_pct === null ? '—' : `${c.bien_gop_pct}%`;
    L.push(
      `| \`${c.sku_key}\` | ${c.channel} | ${m(c.doanh_thu)} | ${m(c.khau_tru_san)} | ${m(c.hoan)} | ${vnd(c.thuc_nhan)} | ${cost} | ${m(c.lai_gop)} | ${b} |`,
    );
  }
  if (!cells.length) L.push('| (không có dòng quyết toán trong tháng) | | | | | | | | |');
  const tn = cells.reduce((s, c) => s + c.thuc_nhan, 0);
  const lai = cells.reduce((s, c) => s + (c.lai_gop ?? 0), 0);
  const loai = [...new Set(cells.filter((c) => c.nhan).map((c) => c.sku_key))].sort(cpCmp);
  L.push(
    '',
    `- Tổng thực nhận: ${vnd(tn)} (${result.n_rows} dòng quyết toán trong tháng${channel ? '' : ' — khớp tổng thực nhận ACC-Recon'})`,
    `- Tổng lãi gộp (chỉ ô có giá vốn duyệt): ${vnd(lai)}`,
    `- ${loai.length} SKU bị loại vì ${NO_COGS}: ${loai.length ? loai.map((s) => `\`${s}\``).join(', ') : '(không có)'}`,
    `- Dòng chưa thấy đơn sàn (vào ô ${UNKNOWN_SKU}): ${result.thieu_chung_tu}; dòng hoàn: ${result.hoan}`,
    `- Dòng thiếu ngày quyết toán (không vào tháng nào): ${result.thieu_ngay}`,
    '- GIẢ ĐỊNH thận trọng: dòng hoàn vẫn tính giá vốn theo số lượng đơn (hàng hoàn nhập kho lại chưa có nguồn).',
    '- Chưa có doanh thu đại lý/B2B (MISA — external-dep): P&L chỉ kênh sàn.',
  );
  for (const ch of Object.keys(result.chong_ky ?? {}).sort(cpCmp)) {
    const o = (result.chong_ky as Record<string, Overlap>)[ch] as Overlap;
    L.push(
      `- **BẤT THƯỜNG** ${ch}: khoản quyết toán xuất lại ở ≥2 file (chồng kỳ) — trùng nguyên văn ${o.trung} (tính 1 lần), lệch số ${o.lech} (giữ cả hai, chờ người đối soát): ${o.files.map((f) => safe(f, 80).replaceAll('|', '/')).join(', ')}`,
    );
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- DB

// Dòng đơn của snapshot `order` MỚI NHẤT chứa mã đơn — CÙNG quy tắc `settlement_csv._ORDER_SQL`.
const LINES_SQL =
  "with latest as (select distinct on (channel, order_id_hash) channel, order_id_hash, snapshot_id from market_rows where export_kind = 'order' and order_id_hash = any($1) order by channel, order_id_hash, snapshot_id desc)" +
  ' select m.channel, m.order_id_hash, m.row_no, m.sku_key, coalesce(m.qty, 0) as qty, coalesce(m.price_vnd, 0) as price_vnd from latest l' +
  " join market_rows m on m.snapshot_id = l.snapshot_id and m.channel = l.channel and m.order_id_hash = l.order_id_hash and m.export_kind = 'order'" +
  ' order by m.channel, m.order_id_hash, m.row_no';

export async function fetchVersions(db: Db): Promise<CogsVersion[]> {
  const { rows } = await db.query(
    'select id, sku_key, cost_vnd, valid_from::text as valid_from, approved_by from cogs_versions order by id',
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), cost_vnd: Number(r.cost_vnd) }) as CogsVersion);
}

/** Khoản quyết toán trong tháng (giờ VN) + dòng thiếu ngày — đọc view `v_settlement_khoan` (bản xuất
 * lại nguyên văn ở file khác tính 1 lần — cùng số với rev_share/BKS/view Bên A). */
export async function fetchRows(db: Db, month: string): Promise<SettleRow[]> {
  const [start, end] = monthBounds(month);
  const { rows } = await db.query(
    `select s.id, s.channel, s.order_id_hash, s.order_amount_vnd, ${DEDUCT.map((f) => `s.${f}`).join(', ')}, s.refund_vnd, s.payout_vnd, s.settled_on::text as settled_on, r.label` +
      ' from v_settlement_khoan s left join recon_results r on r.settlement_row_id = s.id' +
      ' where (s.settled_on >= $1 and s.settled_on < $2) or s.settled_on is null order by s.id',
    [start, end],
  );
  return rows.map((r) => {
    const o: Record<string, unknown> = { ...r, id: Number(r.id) };
    for (const k of ['order_amount_vnd', ...DEDUCT, 'refund_vnd', 'payout_vnd'])
      o[k] = Number(r[k]);
    return o as SettleRow;
  });
}

export async function fetchLines(db: Db, hashes: string[]): Promise<OrderLine[]> {
  if (!hashes.length) return [];
  const { rows } = await db.query(LINES_SQL, [[...new Set(hashes)].sort(cpCmp)]);
  return rows.map((r) => ({
    channel: r.channel,
    order_id_hash: r.order_id_hash,
    row_no: Number(r.row_no),
    sku_key: r.sku_key,
    qty: Number(r.qty),
    price_vnd: Number(r.price_vnd),
  }));
}

export async function compute(
  db: Db,
  month: string,
  channel: string | null = null,
): Promise<PnlResult> {
  const rows = await fetchRows(db, month);
  const lines = await fetchLines(
    db,
    rows.map((r) => r.order_id_hash),
  );
  const res = pnl(rows, lines, await fetchVersions(db), month, channel);
  const [start, end] = monthBounds(month);
  res.chong_ky = await overlaps(db, channel ? [channel] : CHANNELS, start, end);
  return res;
}

/** INSERT dòng chưa duyệt → id | null khi SKU không có trong sku_master. */
export async function addCogs(
  db: Db,
  sku: string,
  cost: number,
  validFrom: string,
  by: string,
  note: string | null = null,
): Promise<number | null> {
  if (!(await db.query('select 1 from sku_master where sku_key = $1', [sku])).rows.length)
    return null;
  const { rows } = await db.query(
    'insert into cogs_versions (sku_key, cost_vnd, valid_from, created_by, note) values ($1, $2, $3, $4, $5) returning id',
    [sku, cost, validFrom, by, note],
  );
  return Number(rows[0].id);
}

/** Gọi `approve_cogs` → [true, null] | [false, thông điệp tiếng Việt của function]. */
export async function approve(
  db: Db,
  cogsId: bigint,
  by: string,
  note: string | null = null,
): Promise<[boolean, string | null]> {
  try {
    await db.query('select approve_cogs($1, $2, $3)', [cogsId.toString(), by, note]);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, dbMsg(e)];
  }
  return [true, null];
}
