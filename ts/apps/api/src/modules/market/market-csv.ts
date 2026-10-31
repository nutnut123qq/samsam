import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp, isDict, pyOsName } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { cpLen } from '@samsam/core/security/py';
import type pg from 'pg';
import { pyJson } from './py-json.js';
import {
  bytesIsSpace,
  type Cell,
  clean,
  MAX_FILE_BYTES,
  nfc,
  safe,
  suffixOf,
  TableError,
  type TableRow,
  table,
  toInt,
} from './table.js';

// Port `ingest/market_csv.py` (v3.3 connector sàn P1, CHỈ ĐỌC) — nạp file CSV/XLSX Quản lý MXH xuất tay
// từ Seller Center Shopee / TikTok Shop vào staging, đối chiếu golden bằng QUY TẮC (không LLM) và
// mở/đóng cảnh báo `market_alerts`.
// Ranh giới: ghi DUY NHẤT `market_snapshots`/`market_rows`/`market_alerts`; CHỈ ĐỌC golden
// (`sku_master`, `price_list`) — không ghi golden/`products`, không gọi sàn, không đổi giá/listing/tồn/
// đơn. PII: chỉ field allowlist được giữ; cột `drop` bỏ NGAY khi đọc; `order_id` → `order_id_hash` =
// sha256("kênh:mã đơn")[:16], giá trị gốc không giữ. Lỗi chỉ nêu số dòng/tên cột, không giá trị ô.

export const MAP_FILE = dataPath('market_csv_map.json');
export const CHANNELS = ['shopee', 'tiktok'] as const;
export const KINDS = ['listing', 'order', 'ads'] as const;
export const FIELDS = [
  'item_id',
  'seller_sku',
  'title',
  'price',
  'stock',
  'status',
  'ads_spend',
  'qty',
  'order_id',
  'sale_price',
  'voucher_code',
] as const;
// v5.4: mã voucher/affiliate trên dòng đơn (TÙY CHỌN, chỉ vào `raw`) — vượt → lỗi dòng.
export const VOUCHER_MAX = 64;
// field số → trần giá trị (cột bigint tiền VND / int số lượng).
export const NUM_MAX: Record<string, number> = {
  price: 10 ** 15,
  ads_spend: 10 ** 15,
  stock: 2 * 10 ** 9,
  qty: 2 * 10 ** 9,
  sale_price: 10 ** 15,
};
export const SEVERITY: Record<string, string> = {
  alcohol_listed: 'S1',
  tpbvsk_ads_no_xnqc: 'S1',
  price_mismatch: 'S2',
  item_unmapped: 'S2',
};
// golden_store.TODAY_VN
export const TODAY_VN = "(now() at time zone 'Asia/Ho_Chi_Minh')::date";

/** Dòng chuẩn hóa: `row_no` + field allowlist (`order_id` → `order_id_hash`). */
export type Row = Record<string, string | number | null>;
export type Mapping = Record<string, unknown>;
type Spec = Record<string, unknown> & { required: Record<string, unknown> };

/** `load_mapping` → [mapping | null, lỗi | null]. */
export function loadMapping(path: string = MAP_FILE): [Mapping | null, string | null] {
  try {
    const m = readJson(path);
    // shortcut: mapping không phải object → Python crash ở `.get`; TS coi như mapping rỗng (mọi
    // kênh/loại "mapping thiếu" → không nạp, fail-closed).
    return [isDict(m) ? m : {}, null];
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    return [null, `không đọc được mapping ${basename(path)}: ${e.pyType}`];
  }
}

const dictOf = (v: unknown): Record<string, unknown> => (isDict(v) ? v : {});

/** `(mapping.get(channel) or {}).get(kind)` — spec hợp lệ | null. */
export function specOf(mapping: Mapping, channel: string, kind: string): Spec | null {
  const spec = dictOf(mapping[channel])[kind];
  return isDict(spec) && isDict(spec.required) ? (spec as Spec) : null;
}

/** `spec.get(<khóa danh sách>, [])` → chuỗi (inactive_status / cancel_status / drop). */
export const listOf = (spec: unknown, key: string): string[] => {
  const v = dictOf(spec)[key];
  return Array.isArray(v) ? v.map(String) : [];
};

const orderHash = (channel: string, orderId: string): string =>
  createHash('sha256').update(`${channel}:${orderId}`, 'utf8').digest('hex').slice(0, 16);

/**
 * `read_export` — hàm thuần (không DB): → [rows, errors, sha256 bytes file | null]. errors ≠ [] →
 * rows = [] (không nạp nửa vời). Mỗi row CHỈ gồm field allowlist + `row_no` (số dòng trong file,
 * header = 1); `order_id` đã đổi thành `order_id_hash`.
 */
export async function readExport(
  path: string,
  channel: string,
  kind: string,
  mapping: Mapping,
): Promise<[Row[], string[], string | null]> {
  const suffix = suffixOf(path);
  if (suffix !== '.csv' && suffix !== '.xlsx') {
    return [[], [`đuôi '${suffix}' không hỗ trợ — chỉ .csv / .xlsx`], null];
  }
  const spec = specOf(mapping, channel, kind);
  if (spec === null) return [[], [`mapping thiếu ${channel}/${kind}`], null];
  let data: Buffer;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) {
      return [[], [`file > ${Math.floor(MAX_FILE_BYTES / 2 ** 20)}MB — tách file`], null];
    }
    data = readFileSync(path);
  } catch (e) {
    return [[], [`không đọc được file: ${pyOsName(e)}`], null];
  }
  const sha = createHash('sha256').update(data).digest('hex');
  if (!data.length || bytesIsSpace(data)) return [[], ['file rỗng'], sha];
  try {
    const [rows, errs] = parse(await table(data, suffix), channel, kind, spec);
    return [rows, errs, sha];
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
}

/** `_parse`: header → cột field; mọi dòng kiểm đủ trước khi trả (lỗi → [], lỗi). */
export function parse(
  tbl: Iterator<TableRow>,
  channel: string,
  kind: string,
  spec: Spec,
): [Row[], string[]] {
  const first = tbl.next();
  if (first.done) return [[], ['file rỗng']];
  const [hdrNo, header0] = first.value;
  const header: Cell[] = header0.map((h) => (h === null ? null : nfc(h)));
  const required = spec.required as Record<string, string>;
  const optional = dictOf(spec.optional) as Record<string, string>;
  // {**optional, **required}: required đè optional cùng field (giữ vị trí cũ như dict Python)
  const want = new Map<string, string>();
  for (const [f, h] of Object.entries(optional)) want.set(f, nfc(h));
  for (const [f, h] of Object.entries(required)) want.set(f, nfc(h));
  const drop = new Set(listOf(spec, 'drop').map(nfc));
  const byHeader = new Map<string, string>();
  for (const [f, h] of want) byHeader.set(h, f);
  const colOf = new Map<string, number>();
  const errs: string[] = [];
  const seen = new Set<string>();
  header.forEach((h, j) => {
    if (h === null) {
      errs.push(`header cột ${j + 1} trống`);
      return;
    }
    if (seen.has(h)) {
      errs.push(`header trùng: '${safe(h)}'`);
      return;
    }
    seen.add(h);
    const f = byHeader.get(h);
    if (f !== undefined) colOf.set(f, j);
    else if (!drop.has(h)) {
      errs.push(
        `cột lạ '${safe(h)}' (không thuộc required/optional/drop — thêm vào mapping sau khi xác minh)`,
      );
    }
  });
  const reqEntries = Object.entries(required);
  const missing = reqEntries.filter(([f]) => !colOf.has(f)).map(([, h]) => h);
  if (missing.length === reqEntries.length) {
    // Không cột bắt buộc nào khớp → dòng đầu nhiều khả năng là DỮ LIỆU (file thiếu header / sai loại
    // export) — KHÔNG in ô (có thể là tên/SĐT người mua), chỉ báo chung.
    return [
      [],
      [
        `dòng ${hdrNo} không khớp header ${channel}/${kind} nào (${header.length} cột, 0/${missing.length} cột bắt buộc) — sai kênh/loại export hoặc file thiếu dòng header`,
      ],
    ];
  }
  if (missing.length) {
    errs.push(`thiếu cột bắt buộc: ${missing.map((h) => `'${nfc(h)}'`).join(', ')}`);
  }
  if (errs.length) return [[], errs];

  const reqFields = new Set(Object.keys(required));
  const rows: Row[] = [];
  const width = header.length;
  let nBody = 0;
  for (let it = tbl.next(); !it.done; it = tbl.next()) {
    const [rowNo, cells] = it.value;
    nBody++;
    if (cells.slice(width).some((c) => c !== null)) {
      errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
      continue;
    }
    const rec = new Map<string, Cell>();
    for (const [f, j] of colOf) rec.set(f, j < cells.length ? (cells[j] as Cell) : null);
    const out: Row = { row_no: rowNo };
    let bad = false;
    for (const f of FIELDS) {
      const v = rec.get(f) ?? null;
      const cap = NUM_MAX[f];
      if (cap !== undefined) {
        if (v === null && !reqFields.has(f)) {
          out[f] = null;
          continue;
        }
        const n = toInt(v, cap);
        if (n === null) {
          errs.push(`dòng ${rowNo}: field '${f}' không phải số nguyên ≥ 0 hợp lệ`);
          bad = true;
        }
        out[f] = n;
      } else if (f === 'order_id') {
        if (kind !== 'order') continue;
        if (v === null) {
          errs.push(`dòng ${rowNo}: thiếu mã đơn`);
          bad = true;
          continue;
        }
        out.order_id_hash = orderHash(channel, v);
      } else if (f === 'voucher_code' && v !== null && cpLen(v) > VOUCHER_MAX) {
        errs.push(`dòng ${rowNo}: field '${f}' dài quá ${VOUCHER_MAX} ký tự`);
        bad = true;
      } else {
        out[f] = v;
      }
    }
    if ((out.item_id ?? null) === null && (out.seller_sku ?? null) === null) {
      errs.push(`dòng ${rowNo}: thiếu cả item_id lẫn seller_sku`);
      bad = true;
    }
    if (!bad) rows.push(out);
  }
  if (!nBody) return [[], ['file chỉ có header, không có dòng dữ liệu']];
  if (errs.length) return [[], errs];
  return [rows, []];
}

// ---------------------------------------------------------------- ánh xạ + đối chiếu (thuần)

export type Sku = {
  category: string | null;
  xnqc_status: string | null;
  shopee_item_id: string | null;
};
export type Skus = Map<string, Sku>;
/** {sku_key: [giá list golden đang mở, id price_list, approved_by]}. */
export type Prices = Map<string, [number, number, string | null]>;
export type Alert = {
  kind: string;
  itemId: string;
  sellerSku: string;
  sku: string | null;
  detail: Record<string, unknown>;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `map_sku` → [sku_key | null, ứng viên]. (1) seller_sku = sku_key; (2) shopee + item_id khớp ĐÚNG 1
 * `shopee_item_id`; khớp ≥ 2 (biến thể chung item) hoặc 0 → không map (agent không chọn). */
export function mapSku(row: Row, channel: string, skus: Skus): [string | null, string[]] {
  const ss = str(row.seller_sku);
  if (ss && skus.has(ss)) return [ss, []];
  const iid = row.item_id;
  if (channel === 'shopee' && iid) {
    const cands = [...skus].filter(([, s]) => s.shopee_item_id === iid).map(([k]) => k);
    cands.sort(cpCmp);
    if (cands.length === 1) return [cands[0] as string, []];
    return [null, cands];
  }
  return [null, []];
}

/** `_key` → [item_id | '', seller_sku | '']. */
export const keyOf = (row: Row): [string, string] => [
  str(row.item_id) || '',
  str(row.seller_sku) || '',
];

/**
 * `find_alerts` — hàm thuần: → cảnh báo theo khóa (kind, item_id, seller_sku), thứ tự xuất hiện.
 * Chỉ listing/ads. Detail = giá trị theo nguồn, không có "đề xuất".
 */
export function findAlerts(
  rows: Row[],
  channel: string,
  kind: string,
  skus: Skus,
  prices: Prices,
  inactive: string[],
): Map<string, Alert> {
  const out = new Map<string, Alert>();
  if (kind !== 'listing' && kind !== 'ads') return out;
  const put = (a: Alert) => out.set(JSON.stringify([a.kind, a.itemId, a.sellerSku]), a);
  const inactiveN = new Set(inactive.map(nfc));
  const spend = new Map<string, number>();
  for (const r of rows) {
    const [sku, cands] = mapSku(r, channel, skus);
    const [iid, ss] = keyOf(r);
    if (sku === null) {
      put({
        kind: 'item_unmapped',
        itemId: iid,
        sellerSku: ss,
        sku: null,
        detail: {
          item_id: r.item_id ?? null,
          seller_sku: r.seller_sku ?? null,
          title: r.title ?? null,
          candidates: cands,
          row_no: r.row_no ?? null,
        },
      });
      continue;
    }
    const s = skus.get(sku) as Sku;
    if (kind === 'listing') {
      const st = str(r.status);
      if (s.category === 'alcohol' && (st === null || !inactiveN.has(nfc(st)))) {
        put({
          kind: 'alcohol_listed',
          itemId: iid,
          sellerSku: ss,
          sku,
          detail: {
            sku_key: sku,
            status_san: r.status ?? null,
            price_san: r.price ?? null,
            title: r.title ?? null,
            row_no: r.row_no ?? null,
          },
        });
      }
      const g = prices.get(sku);
      if (g !== undefined && (r.price ?? null) !== g[0]) {
        put({
          kind: 'price_mismatch',
          itemId: iid,
          sellerSku: ss,
          sku,
          detail: {
            sku_key: sku,
            price_san: r.price ?? null,
            price_golden: g[0],
            price_id: g[1],
            golden_approved: g[2] !== null,
            approved_by: g[2],
            golden_note: g[2] ? 'giá golden đã duyệt' : 'giá golden CHƯA duyệt',
            row_no: r.row_no ?? null,
          },
        });
      }
    } else if (
      s.category === 'tpbvsk' &&
      s.xnqc_status !== 'approved' &&
      ((r.ads_spend as number | null) || 0) > 0
    ) {
      const k = JSON.stringify([iid, ss]);
      spend.set(k, (spend.get(k) ?? 0) + (r.ads_spend as number));
      put({
        kind: 'tpbvsk_ads_no_xnqc',
        itemId: iid,
        sellerSku: ss,
        sku,
        detail: { sku_key: sku, ads_spend_vnd: spend.get(k), xnqc_status: s.xnqc_status },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- DB

type Q = Pick<pg.ClientBase, 'query'> | Db;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** `_golden` → [skus, giá list golden đang mở của kênh]. Chỉ ĐỌC golden. */
export async function golden(db: Q, channel: string): Promise<[Skus, Prices]> {
  const skus: Skus = new Map();
  for (const r of (
    await db.query('select sku_key, category, xnqc_status, shopee_item_id from sku_master')
  ).rows) {
    skus.set(r.sku_key, {
      category: r.category,
      xnqc_status: r.xnqc_status,
      shopee_item_id: r.shopee_item_id,
    });
  }
  const prices: Prices = new Map();
  for (const r of (
    await db.query(
      'select sku_key, price_vnd, id, approved_by from price_list' +
        " where channel = $1 and kind = 'list' and program_id is null" +
        ` and valid_to is null and valid_from <= ${TODAY_VN}`,
      [channel],
    )
  ).rows) {
    prices.set(r.sku_key, [Number(r.price_vnd), Number(r.id), r.approved_by]);
  }
  return [skus, prices];
}

const ROW_COLS =
  'snapshot_id, row_no, channel, export_kind, item_id, seller_sku, sku_key, title, price_vnd,' +
  ' stock, status, ads_spend_vnd, qty, order_id_hash, raw';
const CHUNK = 500;

/** `load`: insert snapshot + rows (KHÔNG commit — `db` là client đang trong giao dịch). →
 * [snapshot_id, số dòng map golden]. */
export async function load(
  db: Q,
  rows: Row[],
  channel: string,
  kind: string,
  fileName: string,
  sha: string,
): Promise<[string, number]> {
  const [skus] = await golden(db, channel);
  const sid = String(
    (
      await db.query(
        'insert into market_snapshots (channel, export_kind, file_name, file_sha256, row_count)' +
          ' values ($1, $2, $3, $4, $5) returning id',
        [channel, kind, fileName, sha, rows.length],
      )
    ).rows[0].id,
  );
  let mapped = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const args: unknown[] = [];
    const vals: string[] = [];
    for (const r of rows.slice(i, i + CHUNK)) {
      const [sku] = mapSku(r, channel, skus);
      if (sku !== null) mapped++;
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (k !== 'row_no') raw[k] = v;
      const vs = [
        sid,
        r.row_no,
        channel,
        kind,
        r.item_id ?? null,
        r.seller_sku ?? null,
        sku,
        r.title ?? null,
        r.price ?? null,
        r.stock ?? null,
        r.status ?? null,
        r.ads_spend ?? null,
        r.qty ?? null,
        r.order_id_hash ?? null,
        pyJson(raw),
      ];
      const b = args.length;
      vals.push(
        `(${vs.map((_, j) => `$${b + j + 1}${j === vs.length - 1 ? '::jsonb' : ''}`).join(', ')})`,
      );
      args.push(...vs);
    }
    if (vals.length) {
      await db.query(`insert into market_rows (${ROW_COLS}) values ${vals.join(', ')}`, args);
    }
  }
  return [sid, mapped];
}

/**
 * `reconcile`: mở/đóng `market_alerts` theo snapshot (KHÔNG commit). Chỉ ĐỌC golden. → {kind: số
 * cảnh báo open từ snapshot, closed: số vừa đóng, kept_absent: cảnh báo open vắng mặt trong file}.
 */
export async function reconcile(
  db: Q,
  snapshotId: string,
  inactive: string[],
): Promise<Map<string, number>> {
  const snap = (
    await db.query('select channel, export_kind from market_snapshots where id = $1', [snapshotId])
  ).rows[0];
  const channel = snap.channel as string;
  const kind = snap.export_kind as string;
  const counts = new Map<string, number>();
  if (kind !== 'listing' && kind !== 'ads') return counts;
  const rows: Row[] = (
    await db.query(
      'select row_no, item_id, seller_sku, title, price_vnd, status, ads_spend_vnd from market_rows' +
        ' where snapshot_id = $1 order by row_no',
      [snapshotId],
    )
  ).rows.map((r) => ({
    row_no: r.row_no,
    item_id: r.item_id,
    seller_sku: r.seller_sku,
    title: r.title,
    price: num(r.price_vnd),
    status: r.status,
    ads_spend: num(r.ads_spend_vnd),
  }));
  const [skus, prices] = await golden(db, channel);
  const found = findAlerts(rows, channel, kind, skus, prices, inactive);
  for (const a of found.values()) {
    await db.query(
      'insert into market_alerts (kind, severity, channel, export_kind, item_id, seller_sku,' +
        ' sku_key, detail, snapshot_id) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)' +
        " on conflict (kind, channel, export_kind, (coalesce(item_id, ''))," +
        " (coalesce(seller_sku, ''))) do update set severity = excluded.severity," +
        ' sku_key = excluded.sku_key, detail = excluded.detail,' +
        ' snapshot_id = excluded.snapshot_id, updated_at = now(),' +
        " opened_at = case when market_alerts.status = 'closed'" +
        ' then now() else market_alerts.opened_at end,' +
        " status = 'open', closed_at = null",
      [
        a.kind,
        SEVERITY[a.kind],
        channel,
        kind,
        a.itemId || null,
        a.sellerSku || null,
        a.sku,
        pyJson(a.detail),
        snapshotId,
      ],
    );
    counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  }
  // Chỉ đóng khi item CÓ MẶT trong file mới mà hết lỗi (bằng chứng đã sửa: đã ẩn / giá khớp / chi phí
  // 0). Item VẮNG mặt (xuất 1 phần, lọc danh mục, thiếu trang) → giữ open — vắng ≠ đã sửa (fail-closed
  // với cảnh báo S1 pháp lý).
  const keys = [...found.values()];
  const present = [...new Set(rows.map((r) => JSON.stringify(keyOf(r))))]
    .map((k) => JSON.parse(k) as [string, string])
    .sort((a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]));
  const closed = await db.query(
    "update market_alerts a set status = 'closed', closed_at = now(), updated_at = now()" +
      " where a.status = 'open' and a.channel = $1 and a.export_kind = $2" +
      ' and exists (select 1 from unnest($3::text[], $4::text[]) as p(iid, ss)' +
      " where p.iid = coalesce(a.item_id, '') and p.ss = coalesce(a.seller_sku, ''))" +
      ' and not exists (select 1 from unnest($5::text[], $6::text[], $7::text[]) as k(kind, iid, ss)' +
      " where k.kind = a.kind and k.iid = coalesce(a.item_id, '') and k.ss = coalesce(a.seller_sku, ''))",
    [
      channel,
      kind,
      present.map((k) => k[0]),
      present.map((k) => k[1]),
      keys.map((k) => k.kind),
      keys.map((k) => k.itemId),
      keys.map((k) => k.sellerSku),
    ],
  );
  counts.set('closed', closed.rowCount ?? 0);
  // open còn lại không thuộc snapshot này = item vắng mặt trong file.
  const kept = await db.query(
    "select count(*) as n from market_alerts where status = 'open'" +
      ' and channel = $1 and export_kind = $2 and snapshot_id <> $3',
    [channel, kind, snapshotId],
  );
  counts.set('kept_absent', Number(kept.rows[0].n));
  return counts;
}

/** `--report`: cảnh báo open S1 trước S2, snapshot mới nhất mỗi (kênh, loại) + tuổi ngày, thiếu file
 * ads, đơn theo trạng thái (đơn hủy riêng). Không in mã đơn/hash. Giờ in theo TimeZone phiên DB (như
 * psycopg trả datetime theo phiên). */
export async function report(
  db: Q,
  mapping: Mapping | null,
  log: (s: string) => void = console.log,
): Promise<void> {
  const alerts = (
    await db.query(
      'select severity, kind, channel, export_kind, item_id, seller_sku, sku_key, detail,' +
        " to_char(opened_at, 'YYYY-MM-DD HH24:MI') as opened from market_alerts" +
        " where status = 'open' order by severity, kind, channel, item_id, seller_sku",
    )
  ).rows;
  log(
    `[report] ${alerts.length} cảnh báo sàn đang mở (agent không sửa sàn — MXH sửa sau khi GĐ bán hàng/Pháp chế duyệt):`,
  );
  for (const a of alerts) {
    log(
      `  [${a.severity}] ${a.kind} ${a.channel}/${a.export_kind} item=${clean(a.item_id)} ` +
        `seller_sku=${clean(a.seller_sku)} sku=${a.sku_key ?? 'None'} mở=${a.opened} ` +
        clean(pyJson(a.detail, { sep: [', ', ': '], sortKeys: true }), 2000),
    );
  }
  const snaps = (
    await db.query(
      'select distinct on (channel, export_kind) id, channel, export_kind, file_name, row_count,' +
        " to_char(imported_at, 'YYYY-MM-DD HH24:MI') as ts," +
        ` ${TODAY_VN} - (imported_at at time zone 'Asia/Ho_Chi_Minh')::date as age` +
        ' from market_snapshots order by channel, export_kind, imported_at desc, id desc',
    )
  ).rows;
  log(`[report] snapshot mới nhất: ${snaps.length}`);
  const latest = new Map<string, string>();
  for (const s of snaps) {
    latest.set(`${s.channel}/${s.export_kind}`, String(s.id));
    log(
      `  ${s.channel}/${s.export_kind} #${s.id} ${clean(s.file_name)} ${s.row_count} dòng, nạp ${s.ts} (${s.age} ngày trước)`,
    );
  }
  for (const ch of CHANNELS) {
    const listing = latest.get(`${ch}/listing`);
    if (listing !== undefined && !latest.has(`${ch}/ads`)) {
      log(
        `[warn] ${ch}: không đủ dữ liệu quảng cáo (có listing, chưa có file ads) — chưa kiểm được TPBVSK chạy ads`,
      );
    }
    if (listing !== undefined) {
      const nNop = (
        await db.query(
          'select count(*) as n from market_rows r where r.snapshot_id = $1' +
            ' and r.sku_key is not null and not exists (select 1 from price_list p' +
            " where p.sku_key = r.sku_key and p.channel = $2 and p.kind = 'list'" +
            ` and p.program_id is null and p.valid_to is null and p.valid_from <= ${TODAY_VN})`,
          [listing, ch],
        )
      ).rows[0].n;
      log(`  ${ch}: ${nNop} dòng listing đã map nhưng golden chưa có giá list để so`);
    }
    const order = latest.get(`${ch}/order`);
    if (order !== undefined) {
      const cancel = new Set(listOf(dictOf(dictOf(mapping)[ch]).order, 'cancel_status').map(nfc));
      const by = (
        await db.query(
          "select coalesce(status, '(trống)') as s, count(distinct order_id_hash) as o," +
            ' count(*) as n from market_rows where snapshot_id = $1 group by 1 order by 1',
          [order],
        )
      ).rows;
      const nCancel = by.reduce((t, r) => t + (cancel.has(nfc(r.s)) ? Number(r.o) : 0), 0);
      log(
        `  ${ch} đơn: hủy=${nCancel} đơn; theo trạng thái: ${by
          .map((r) => `${clean(r.s, 40)}=${r.o} đơn/${r.n} dòng`)
          .join(', ')}`,
      );
    }
  }
}
