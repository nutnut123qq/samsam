import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { addDays, dmy, periodBounds, vnDate } from '@samsam/core/ops/period';
import { cpSlice, isPlainObject } from '@samsam/core/ops/py';
import { withTx } from '@samsam/core/ops/tx';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { pyStrip, pyTruthy } from '@samsam/core/security/py';
import { big, clean, cpCmp, loadMarketMapping, nfc } from './shared.js';

// Port `agents/kd_orders.py` (v10.1 KD-A6, WP16) — đơn sàn → bảng lõi `orders` + file đối soát doanh
// thu thực nhận; v14.4 sales-06.2 `--watch` cảnh báo tỷ lệ hủy/hoàn bất thường. LUẬT tất định, KHÔNG
// LLM, KHÔNG gọi sàn/mạng, KHÔNG gửi.
// - `sync` CHỈ ĐỌC `market_snapshots`/`market_rows` (export `order`) và CHỈ GHI `orders`. Đơn sàn id
//   `"<kênh>:<order_id_hash>"`, source `market:<kênh>`; upsert chỉ đè row source `market:%` (row
//   manual/sample/core_store KHÔNG bị đè) và KHÔNG đổi `ts`. Không PII (file sàn đã bỏ cột người mua,
//   mã đơn chỉ còn hash). GIẢ ĐỊNH: file export chưa có cột ngày đặt → `ts` = `imported_at` snapshot
//   ĐẦU TIÊN thấy đơn; trạng thái = dòng ĐẦU của đơn; thuộc `cancel_status` → `cancelled`.
// - `reconRows`/`writeCsv` CHỈ ĐỌC → CSV cho kế toán (không ghi DB, không bút toán).
// - `watch`: tuần ĐÃ ĐÓNG (giờ VN) có ≥ min_orders đơn mà tỷ lệ hủy/hoàn > ngưỡng hoặc ≥ spike_ratio ×
//   nền → mục `order_anomaly` khối sales, theo ĐỢT (khóa `ow:<kênh>:<loại>:<tuần>:<số đơn xấu>`).
//   Đơn TRỄ "chưa đo" (file chưa có cột ngày đặt/hạn giao — KHÔNG suy). Agent không xử lý đơn.
// Print/log chỉ đếm + `order_id_hash[:8]` — không in hash đủ 16 ký tự.

export const JOB = 'agents.kd_orders';
export const SOURCE_PREFIX = 'market:';
export const MAX_NOTE = 200;
export const MAX_STATUS = 40;
export const CSV_FIELDS = [
  'channel',
  'order_ref',
  'status',
  'total_vnd',
  'order_amount_vnd',
  'platform_fee_vnd',
  'shipping_fee_vnd',
  'voucher_seller_vnd',
  'affiliate_vnd',
  'refund_vnd',
  'payout_vnd',
  'label',
] as const;
export const MONEY_FIELDS = CSV_FIELDS.slice(3, 11);
export const LABELS = ['khop', 'lech', 'thieu_chung_tu', 'hoan', 'chua_quyet_toan', 'thieu_don'];
const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'];

// ------------------------------------------------------------ đơn (THUẦN)
export type MarketRow = {
  channel: string | null;
  order_id_hash: string | null;
  status: string | null;
  qty: number | null;
  price_vnd: number | string | bigint | null;
  sku_key: string | null;
};
export type Order = {
  id: string;
  channel: string;
  qty: number;
  total_vnd: bigint;
  status: string;
  product_id: null;
  source: string;
  note: string | null;
};

/** Python `for s in v` cho giá trị JSON (None/số → TypeError như Python). */
function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isPlainObject(v)) return Object.keys(v);
  throw new TypeError(`'${v === null ? 'NoneType' : typeof v}' object is not iterable`);
}

/** THUẦN, tất định. Dòng `market_rows` order của 1 snapshot (theo row_no) → đơn gom theo (kênh,
 * order_id_hash); tổng = Σ giá × SL. Dòng thiếu hash/kênh bị bỏ (caller đếm). */
export function buildOrders(
  rows: MarketRow[],
  cancelStatus: Record<string, unknown> | null,
): Order[] {
  const out = new Map<string, Order & { skus: Set<string> }>();
  for (const r of rows) {
    const h = r.order_id_hash;
    const ch = r.channel;
    if (!h || !ch) continue;
    const key = `${ch}\u0000${h}`;
    let o = out.get(key);
    if (o === undefined) {
      const st = r.status;
      const spec = cancelStatus ?? {};
      const cancels = new Set(pyIter(Object.hasOwn(spec, ch) ? spec[ch] : []).map(nfc));
      let status: string;
      if (st !== null && st !== undefined && cancels.has(nfc(st))) status = 'cancelled';
      else status = st ? pyStrip(clean(st, MAX_STATUS)) : 'new';
      o = {
        id: `${ch}:${h}`,
        channel: ch,
        qty: 0,
        total_vnd: 0n,
        status: status || 'new',
        product_id: null,
        source: `${SOURCE_PREFIX}${ch}`,
        note: null,
        skus: new Set(),
      };
      out.set(key, o);
    }
    o.qty += r.qty || 0;
    o.total_vnd += big(r.price_vnd || 0) * big(r.qty || 0);
    if (r.sku_key) o.skus.add(r.sku_key);
  }
  return [...out.values()].map(({ skus, ...o }) => ({
    ...o,
    note: skus.size ? cpSlice([...skus].sort(cpCmp).join(','), 0, MAX_NOTE) : null,
  }));
}

const UPSERT_SQL =
  'insert into orders (id, ts, channel, product_id, qty, total_vnd, status, note, source) values ($1, $2, $3, null, $4, $5, $6, $7, $8)' +
  ' on conflict (id) do update set status = excluded.status, qty = excluded.qty, total_vnd = excluded.total_vnd,' +
  " note = excluded.note where orders.source like 'market:%' and (orders.status, orders.qty, orders.total_vnd, orders.note)" +
  ' is distinct from (excluded.status, excluded.qty, excluded.total_vnd, excluded.note)';

export type SyncCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  protected: number;
  skipped: number;
  snapshots: number;
};

/** `{kênh: cancel_status}` từ mapping (Python `(spec.get("order") or {}).get("cancel_status", [])`). */
export function cancelMap(mapping: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ch, spec] of Object.entries(mapping)) {
    if (!isPlainObject(spec)) continue;
    const od = pyTruthy(spec.order) ? spec.order : {};
    if (!isPlainObject(od)) throw new TypeError(`mapping ${ch}.order không phải object`);
    out[ch] = Object.hasOwn(od, 'cancel_status') ? od.cancel_status : [];
  }
  return out;
}

/** Đơn sàn → `orders` (1 transaction). Snapshot sau thắng; `ts` = imported_at snapshot ĐẦU TIÊN
 * thấy đơn (không cập nhật khi upsert). Mapping lỗi → RangeError (Python ValueError). */
export async function sync(
  db: Db,
  snapshotIds: bigint[] | null = null,
  dryRun = false,
  mapFile?: string,
): Promise<SyncCounts> {
  const [mapping, why] = loadMarketMapping(mapFile);
  if (mapping === null) throw new RangeError(why as string);
  const cancel = cancelMap(mapping);
  const merged = new Map<string, Order>();
  const firstTs = new Map<string, Date>();
  let skipped = 0;
  let sql = "select id::text as id, imported_at from market_snapshots where export_kind = 'order'";
  const params: unknown[] = [];
  if (snapshotIds !== null) {
    sql += ' and id = any($1::bigint[])';
    params.push(snapshotIds.map(String));
  }
  const snaps = (await db.query(`${sql} order by imported_at, id`, params)).rows;
  for (const s of snaps) {
    const { rows } = await db.query<MarketRow>(
      "select channel, order_id_hash, status, qty, price_vnd, sku_key from market_rows where snapshot_id = $1 and export_kind = 'order' order by row_no",
      [s.id],
    );
    skipped += rows.filter((r) => !r.order_id_hash).length;
    for (const o of buildOrders(rows, cancel)) {
      if (!firstTs.has(o.id)) firstTs.set(o.id, s.imported_at);
      merged.set(o.id, o);
    }
  }
  const counts: SyncCounts = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    protected: 0,
    skipped,
    snapshots: snaps.length,
  };
  const existing = new Map<string, Record<string, unknown>>();
  if (merged.size) {
    const { rows } = await db.query(
      'select id, source, status, qty, total_vnd, note from orders where id = any($1::text[])',
      [[...merged.keys()]],
    );
    for (const r of rows) existing.set(r.id, r);
  }
  const todo: unknown[][] = [];
  for (const oid of [...merged.keys()].sort(cpCmp)) {
    const o = merged.get(oid) as Order;
    const cur = existing.get(oid);
    if (cur === undefined) counts.inserted++;
    else if (!String(cur.source).startsWith(SOURCE_PREFIX)) {
      counts.protected++;
      continue;
    } else if (
      cur.status === o.status &&
      cur.qty === o.qty &&
      cur.total_vnd !== null &&
      big(cur.total_vnd) === o.total_vnd &&
      cur.note === o.note
    ) {
      counts.unchanged++;
      continue;
    } else counts.updated++;
    todo.push([
      oid,
      firstTs.get(oid),
      o.channel,
      o.qty,
      String(o.total_vnd),
      o.status,
      o.note,
      o.source,
    ]);
  }
  if (dryRun) return counts;
  await withTx(db, async (c) => {
    for (const p of todo) await c.query(UPSERT_SQL, p);
  });
  return counts;
}

// ------------------------------------------------------------ v14.4 đơn bất thường
export const FEATURE_WATCH = 'sales-06.2';
export const OT_ANOMALY = 'order_anomaly';
export const AGENT = 'agent:kd_orders';
export const WATCH_KINDS: Record<string, string> = { cancel: 'hủy', return: 'hoàn/trả' };
export const LATE_NOTE =
  'Đơn trễ: CHƯA ĐO — file xuất Seller Center chưa có cột ngày đặt/hạn giao (không suy từ ngày nạp file).';

export type OrderWatch = {
  min_orders: number;
  baseline_weeks: number;
  check_weeks: number;
  cancel_rate_max_pct: number;
  return_rate_max_pct: number;
  spike_ratio: number;
  return_status: Record<string, string[]>;
};
export type WeekCount = { n: number; cancel: number; return: number };
/** Khóa đếm (kênh, ngày đầu tuần VN). */
export const ck = (ch: string, wk: string): string => `${ch}\u0000${wk}`;
export type Finding = {
  channel: string;
  kind: 'cancel' | 'return';
  week: string;
  n: number;
  bad: number;
  cap: number;
  n_base: number;
  bad_base: number;
  over: boolean;
  spike: boolean;
  object_id: string;
};

/** `Decimal(bad*100/n).quantize(0.1, ROUND_HALF_UP)` + '%' (số nguyên chính xác); n = 0 → '—'. */
export function pct(bad: number, n: number): string {
  if (!n) return '—';
  const b = BigInt(bad);
  const d = BigInt(n);
  const q = (2n * b * 1000n + d) / (2n * d);
  return `${q / 10n}.${q % 10n}%`;
}

/** CHỈ SELECT → {(kênh, ngày đầu tuần VN): {n, cancel, return}} cho đơn sàn thật từ `since`. */
export async function weekCounts(
  db: Db,
  since: Date,
  returnStatus: Record<string, string[]>,
): Promise<Map<string, WeekCount>> {
  const rs = new Map(Object.entries(returnStatus).map(([ch, v]) => [ch, new Set(v.map(nfc))]));
  const out = new Map<string, WeekCount>();
  const { rows } = await db.query(
    "select channel, ts, status from orders where source like 'market:%' and ts >= $1",
    [since],
  );
  for (const r of rows) {
    const k = ck(r.channel, vnDate(periodBounds('week', r.ts)[0]));
    let c = out.get(k);
    if (c === undefined) {
      c = { n: 0, cancel: 0, return: 0 };
      out.set(k, c);
    }
    c.n++;
    const st = nfc(r.status || '');
    if (st === 'cancelled') c.cancel++;
    else if (rs.get(r.channel)?.has(st)) c.return++;
  }
  return out;
}

/** THUẦN, tất định → phát hiện trên các tuần ĐÃ ĐÓNG gần nhất. */
export function anomalies(
  counts: Map<string, WeekCount>,
  today: string,
  ow: OrderWatch,
): Finding[] {
  const w0 = vnDate(periodBounds('week', today)[0]);
  const chans = [...new Set([...counts.keys()].map((k) => k.split('\u0000')[0] as string))].sort(
    cpCmp,
  );
  const out: Finding[] = [];
  for (let i = 1; i <= ow.check_weeks; i++) {
    const wk = addDays(w0, -7 * i);
    for (const ch of chans) {
      const c = counts.get(ck(ch, wk));
      if (!c || c.n < ow.min_orders) continue;
      const base: WeekCount[] = [];
      for (let j = 1; j <= ow.baseline_weeks; j++) {
        const b = counts.get(ck(ch, addDays(wk, -7 * j)));
        if (b) base.push(b);
      }
      const nb = base.reduce((s, b) => s + b.n, 0);
      for (const [kind, cap] of [
        ['cancel', ow.cancel_rate_max_pct],
        ['return', ow.return_rate_max_pct],
      ] as const) {
        const bad = c[kind];
        const n = c.n;
        const bb = base.reduce((s, b) => s + b[kind], 0);
        if (bad === 0) continue;
        const over = bad * 100 > n * cap;
        const spike = nb >= ow.min_orders && bb > 0 && bad * nb >= ow.spike_ratio * bb * n;
        if (!(over || spike)) continue;
        out.push({
          channel: ch,
          kind,
          week: wk,
          n,
          bad,
          cap,
          n_base: nb,
          bad_base: bb,
          over,
          spike,
          object_id: `ow:${ch}:${kind}:${wk}:${bad}`,
        });
      }
    }
  }
  return out.sort(
    (a, b) => cpCmp(a.week, b.week) || cpCmp(a.channel, b.channel) || cpCmp(a.kind, b.kind),
  );
}

/** Bỏ phát hiện đã có mục pending cùng (kênh, loại, tuần) hoặc đã quyết với số đơn xấu ≥ hiện tại. */
export async function newOnly(db: Db, fs: Finding[]): Promise<Finding[]> {
  const pend = new Set<string>();
  const decided = new Map<string, number>();
  const { rows } = await db.query(
    "select object_id, status from approval_queue where object_type = $1 and object_id like 'ow:%'",
    [OT_ANOMALY],
  );
  for (const r of rows) {
    const oid = String(r.object_id);
    const at = oid.lastIndexOf(':');
    const head = at < 0 ? '' : oid.slice(0, at);
    const n = oid.slice(at + 1);
    if (r.status === 'pending') pend.add(head);
    else if (/^[0-9]+$/.test(n)) decided.set(head, Math.max(decided.get(head) ?? 0, Number(n)));
  }
  return fs.filter((f) => {
    const head = f.object_id.slice(0, f.object_id.lastIndexOf(':'));
    return !(pend.has(head) || (decided.get(head) ?? -1) >= f.bad);
  });
}

export function anomalyItem(
  f: Finding,
  ow: OrderWatch,
  label: string,
): { object_type: string; object_id: string; title: string; payload: string } {
  const kind = WATCH_KINDS[f.kind] as string;
  const why: string[] = [];
  if (f.over) why.push(`vượt ngưỡng ${f.cap}%`);
  if (f.spike) why.push(`≥ ${ow.spike_ratio} lần tỷ lệ nền`);
  const where = `kênh ${f.channel}, tuần ${dmy(f.week).slice(0, 5)}–${dmy(addDays(f.week, 6))}`;
  return {
    object_type: OT_ANOMALY,
    object_id: f.object_id,
    title: `${label} — đơn ${kind}, ${where}`,
    payload:
      `Cảnh báo đơn ${kind} bất thường (A6, NHÁP): ${where}. Số liệu: ${f.n} đơn, ${kind} ${f.bad}` +
      ` (${pct(f.bad, f.n)}); nền ${ow.baseline_weeks} tuần trước ${f.n_base} đơn, ${kind} ${f.bad_base}` +
      ` (${pct(f.bad_base, f.n_base)}). Lý do: ${why.join('; ')} (ngưỡng GIẢ ĐỊNH). Ghi chú: ngày đơn =` +
      ` ngày nạp file đầu tiên (GIẢ ĐỊNH). ${LATE_NOTE} Việc cần làm: GĐ bán hàng rà lý do trên Seller` +
      ' Center và quyết xử lý. Agent không xử lý đơn, không liên hệ khách.',
  };
}

export type WatchResult = { findings: Finding[]; new: number; enqueued: number; weeks: string[] };

/** Cổng SINH sales-06.2 → đếm → phát hiện mới → `director.submit` (dry-run: không ghi). */
export async function watch(
  db: Db,
  today: string,
  ow: OrderWatch,
  cfg: DirectorConfig,
  dryRun = false,
): Promise<WatchResult> {
  await checkGenerate(db, FEATURE_WATCH, 'cảnh báo đơn bất thường');
  const w0 = periodBounds('week', today)[0];
  const since = new Date(w0.getTime() - 7 * (ow.check_weeks + ow.baseline_weeks) * 86_400_000);
  const counts = await weekCounts(db, since, ow.return_status);
  const fs = anomalies(counts, today, ow);
  const fresh = await newOnly(db, fs);
  const label = String((cfg.object_types[OT_ANOMALY] as { label?: unknown }).label);
  let n = 0;
  if (!dryRun) {
    for (const f of fresh) {
      const it = anomalyItem(f, ow, label);
      try {
        await submit(db, {
          block: 'sales',
          objectType: OT_ANOMALY,
          objectId: it.object_id,
          title: it.title,
          payload: it.payload,
          createdBy: AGENT,
          cfg,
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') continue;
        throw e;
      }
      n++;
    }
  }
  const weeks = [...new Set([...counts.keys()].map((k) => k.split('\u0000')[1] as string))].sort(
    cpCmp,
  );
  return { findings: fs, new: fresh.length, enqueued: n, weeks };
}

// ------------------------------------------------------------ đối soát
export type ReconRow = Record<(typeof CSV_FIELDS)[number], string | bigint | null>;
type Sett = Record<string, bigint | string | null>;

const MONEY_SETT = [
  'order_amount_vnd',
  'platform_fee_vnd',
  'shipping_fee_vnd',
  'voucher_seller_vnd',
  'affiliate_vnd',
  'refund_vnd',
  'payout_vnd',
] as const;

/** THUẦN — phần tính của `recon_rows` trên kết quả 3 câu SELECT (xem `reconRows`). */
export function reconFromRows(
  sett: unknown[][],
  ids: string[],
  period: [string, string, string, unknown][],
  since: string,
  until: string,
): ReconRow[] {
  const by = new Map<string, Sett>();
  for (const r of sett) {
    const [ch, h, amount, fixed, pay, svc, ship, voucher, aff, refund, payout, settledOn, label] =
      r;
    by.set(`${ch}\u0000${h}`, {
      ch: String(ch),
      h: String(h),
      order_amount_vnd: big(amount),
      platform_fee_vnd: big(fixed) + big(pay) + big(svc),
      shipping_fee_vnd: big(ship),
      voucher_seller_vnd: big(voucher),
      affiliate_vnd: big(aff),
      refund_vnd: big(refund),
      payout_vnd: big(payout),
      settled_on: (settledOn as string | null) ?? null,
      label: (label as string | null) ?? null,
    });
  }
  const known = new Set(
    ids.map((oid) => {
      const at = oid.indexOf(':');
      return at < 0 ? `${oid}\u0000` : `${oid.slice(0, at)}\u0000${oid.slice(at + 1)}`;
    }),
  );
  const out: ReconRow[] = [];
  for (const [oid, ch, status, total] of period) {
    const at = oid.indexOf(':');
    const h = at < 0 ? '' : oid.slice(at + 1);
    const s = by.get(`${ch}\u0000${h}`);
    const row = {
      channel: ch,
      order_ref: cpSlice(h, 0, 8),
      status,
      total_vnd: total === null || total === undefined ? null : big(total),
    } as ReconRow;
    for (const k of MONEY_SETT) row[k] = s === undefined ? null : (s[k] as bigint);
    // settlement chưa được đối chiếu (thiếu recon_results) → coi như chưa quyết toán xong.
    row.label = s === undefined ? 'chua_quyet_toan' : s.label || 'chua_quyet_toan';
    out.push(row);
  }
  for (const [key, s] of by) {
    const on = s.settled_on as string | null;
    if (known.has(key) || on === null || !(since <= on && on <= until)) continue;
    const row = {
      channel: s.ch,
      order_ref: cpSlice(s.h as string, 0, 8),
      status: '',
      total_vnd: null,
    } as ReconRow;
    for (const k of MONEY_SETT) row[k] = s[k] as bigint;
    row.label = 'thieu_don';
    out.push(row);
  }
  return out.sort(
    (a, b) =>
      cpCmp(String(a.channel), String(b.channel)) ||
      cpCmp(String(a.order_ref), String(b.order_ref)) ||
      cpCmp(String(a.label), String(b.label)),
  );
}

/** Đơn sàn (`ts` ∈ [since, until] giờ VN) + settlement MỚI NHẤT của đơn + nhãn `recon_results`
 * (chưa có → `chua_quyet_toan`); settlement trong kỳ không có đơn → `thieu_don`. CHỈ SELECT. */
export async function reconRows(db: Db, since: string, until: string): Promise<ReconRow[]> {
  const start = periodBounds('day', since)[0];
  const end = periodBounds('day', until)[1];
  const sett = await db.query({
    text:
      'select distinct on (s.channel, s.order_id_hash) s.channel, s.order_id_hash, s.order_amount_vnd, s.fixed_fee_vnd,' +
      ' s.payment_fee_vnd, s.service_fee_vnd, s.shipping_fee_vnd, s.voucher_seller_vnd, s.affiliate_vnd, s.refund_vnd,' +
      ' s.payout_vnd, s.settled_on::text, r.label from settlement_rows s left join recon_results r on r.settlement_row_id = s.id' +
      ' order by s.channel, s.order_id_hash, s.imported_at desc, s.id desc',
    rowMode: 'array',
  });
  const ids = (await db.query("select id from orders where source like 'market:%'")).rows.map((r) =>
    String(r.id),
  );
  const period = await db.query({
    text: "select id, channel, status, total_vnd from orders where source like 'market:%' and ts >= $1 and ts < $2",
    values: [start, end],
    rowMode: 'array',
  });
  return reconFromRows(
    sett.rows,
    ids,
    period.rows as [string, string, string, unknown][],
    since,
    until,
  );
}

/** Ô CSV: số giữ nguyên; chuỗi (trạng thái từ file sàn) chặn công thức bảng tính bằng tiền tố '. */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) return String(v);
  const s = clean(v, 120);
  return FORMULA_START.some((p) => s.startsWith(p)) ? `'${s}` : s;
}

/** Hàng TỔNG theo kênh — CODE cộng (ô rỗng = 0). */
export function totals(rows: ReconRow[]): ReconRow[] {
  const by = new Map<string, ReconRow>();
  for (const r of rows) {
    const ch = String(r.channel);
    let t = by.get(ch);
    if (t === undefined) {
      t = { channel: ch, order_ref: 'TONG', status: '', label: '' } as ReconRow;
      for (const k of MONEY_FIELDS) t[k] = 0n;
      by.set(ch, t);
    }
    for (const k of MONEY_FIELDS) t[k] = (t[k] as bigint) + big(r[k] || 0);
  }
  return [...by.keys()].sort(cpCmp).map((k) => by.get(k) as ReconRow);
}

/** Python `csv.writer` QUOTE_MINIMAL (ô có `,`/`"`/xuống dòng → bọc ngoặc kép). */
const csvField = (s: string): string => (/[,"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** CSV đối soát: BOM utf-8-sig, `\n`, header + dòng + TỔNG theo kênh. */
export function renderCsv(rows: ReconRow[]): Buffer {
  const lines = [CSV_FIELDS.join(',')];
  for (const r of [...rows, ...totals(rows)]) {
    lines.push(CSV_FIELDS.map((k) => csvField(cell(r[k]))).join(','));
  }
  return Buffer.from(`﻿${lines.join('\n')}\n`, 'utf8');
}

/** `doi-soat-<since>-<until>.csv` atomic (tmp + rename, BYTES) — cùng dữ liệu → byte-giống nhau. */
export function writeCsv(rows: ReconRow[], outDir: string, since: string, until: string): string {
  mkdirSync(outDir, { recursive: true });
  const final = join(outDir, `doi-soat-${since}-${until}.csv`);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, renderCsv(rows));
  renameSync(tmp, final);
  return final;
}
