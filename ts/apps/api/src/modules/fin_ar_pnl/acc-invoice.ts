import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verify as aqVerify } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit as directorSubmit } from '@samsam/core/ops/director';
import { periodBounds } from '@samsam/core/ops/period';
import { pyOsName } from '@samsam/core/ops/py-json';
import { queueSample, REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { dataPath } from '@samsam/core/paths';
import { cpLen, pyStrip } from '@samsam/core/security/py';
import pg from 'pg';
import { MAX_FILE_BYTES, TableError } from '../intel_import/table.js';
import {
  type Cell,
  CHANNELS,
  fmtDay,
  isDict,
  loadPyJson,
  mapHeader,
  nextRow,
  nfc,
  openTable,
  orderHash,
  type PyJsonError,
  readTable,
  rowRecord,
  sha256hex,
  vnd,
} from './fin-common.js';

// Port `agents/acc_invoice.py` (v9.0 ACC-Invoice, WP12) — gom lô đơn sàn đạt mốc xuất hóa đơn của ngày
// D → file CSV NHÁP (format HĐĐT GIẢ ĐỊNH) + 1 mục `invoice_batch` vào hàng duyệt chung (khối
// finance). Agent KHÔNG có chữ ký số, KHÔNG phát hành, KHÔNG gửi, KHÔNG gọi API/mạng/LLM — kế toán
// nhập tay vào phần mềm HĐĐT SAU KHI lô được duyệt và `--verify-draft` pass.
// - Thông tin người mua (tên/MST/địa chỉ/email) CHỈ nằm trong file nháp
//   `data/reports/hoa-don-nhap/lo-<batch_key>.csv` (gitignored) — KHÔNG vào DB, payload, log, stdout.
// - `batch_key` = `<D>-<sha256(csv)[:12]>`; dòng lô + mục hàng duyệt ghi CÙNG 1 giao dịch (không dòng
//   mồ côi); `pg_try_advisory_lock` chặn 2 lần chạy song song.

export const CONFIG_FILE = dataPath('invoice_config.json');
export const MARKET_MAP_FILE = dataPath('market_csv_map.json');
export const DRAFT_DIR = join(REPORTS_DIR, 'hoa-don-nhap');
export const TRIGGERS = ['giao_thanh_cong', 'ban_giao_van_chuyen'];
export const KINDS = ['thuong', 'can_mst', 'dieu_chinh'] as const;
export type Kind = (typeof KINDS)[number];
export const REQ_FIELDS = ['order_id', 'buyer_name', 'tax_code', 'address', 'email'];
export const REQ_REQUIRED = ['order_id', 'buyer_name', 'tax_code'];
export const REQ_MAXLEN: [string, number][] = [
  ['buyer_name', 200],
  ['tax_code', 14],
  ['address', 300],
  ['email', 254],
];
export const CSV_FIELDS = [
  'lan_lap',
  'ma_tham_chieu',
  'ngay_lap',
  'kenh',
  'loai',
  'ten_nguoi_mua',
  'mst',
  'dia_chi',
  'email',
  'ten_hang',
  'so_luong',
  'don_gia',
  'thanh_tien',
  'lo_goc',
];
export const AGENT = 'agent:acc_invoice';
export const LOCK_KEY = 9_000_001; // pg advisory lock — 1 lần --batch tại 1 thời điểm
// [0-9] ASCII + fullmatch (Python: \d nhận chữ số Unicode, $ nhận trước xuống dòng).
export const MST_RE = /^[0-9]{10}(?:-[0-9]{3})?$/;
const SHA_LINE_RE = /(?:^|(?<=\n))csv_sha256: ([0-9a-f]{64})(?=\n|$)/;
const FORMULA_START = ['=', '+', '-', '@', '\t', '\r'];

const tup = (xs: readonly string[]): string => `(${xs.map((x) => `'${x}'`).join(', ')})`;

export type InvConfig = Record<string, unknown> & {
  invoice_trigger: string;
  confirmed_by: string | null;
  trigger_status: Record<string, Record<string, string[]>>;
  return_status: Record<string, string[]>;
  request_columns: Record<string, string>;
  csv_columns: string[];
  retail_buyer: string;
  cancel_status: Record<string, string[]>;
};

export type Buyer = {
  buyer_name: string;
  tax_code: string;
  address: string | null;
  email: string | null;
};
export type Item = { title: string | null; qty: number | null; price_vnd: number | null };
export type Order = {
  channel: string;
  order_id_hash: string;
  status: string | null;
  amount_vnd: number;
  items: Item[];
};
export type Invoiced = {
  channel: string;
  order_id_hash: string;
  kind: string;
  batch_key: string;
  status: string;
  amount_vnd: number;
};
export type Line = Order & {
  kind: Kind;
  buyer: Buyer | null;
  orig_kind: string | null;
  ref_batch_key: string | null;
};
export type Batch = {
  day: string;
  trigger: string;
  lines: Line[];
  excluded: { huy: number; chua_dat_moc: number; da_lap: number };
  unmatched_yeu_cau: number;
};

// ---------------------------------------------------------------- cấu hình

/** `_str_list`: list chuỗi khác rỗng (sau strip) — list rỗng cũng đạt (như Python `all([])`). */
const strList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && pyStrip(x) !== '');

/** Python `list(x)` cho giá trị JSON (list → bản sao, chuỗi → ký tự, dict → khóa); khác → null. */
function pyList(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return [...v];
  if (typeof v === 'string') return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  return null;
}

/** `load_config` → [cấu hình (+ `cancel_status` từ mapping market_csv), null] | [null, lý do]. */
export function loadConfig(
  path: string = CONFIG_FILE,
  marketMap: string = MARKET_MAP_FILE,
): [InvConfig | null, string | null] {
  let cfg: unknown;
  let mm: unknown;
  try {
    cfg = loadPyJson(path);
    mm = loadPyJson(marketMap);
  } catch (e) {
    return [null, `không đọc được cấu hình hóa đơn: ${(e as PyJsonError).pyType}`];
  }
  if (!isDict(cfg) || !TRIGGERS.includes(cfg.invoice_trigger as string)) {
    return [null, `invoice_trigger phải thuộc ${tup(TRIGGERS)}`];
  }
  const cb = cfg.confirmed_by ?? null;
  if (cb !== null && !(typeof cb === 'string' && pyStrip(cb))) {
    return [null, 'confirmed_by phải null hoặc tên người chốt'];
  }
  // TS chặt hơn: trigger_status/return_status không phải object → lỗi cấu hình (Python AttributeError).
  const tsAll = isDict(cfg.trigger_status) ? cfg.trigger_status : {};
  const rsAll = isDict(cfg.return_status) ? cfg.return_status : {};
  const cancel: Record<string, string[]> = {};
  for (const ch of CHANNELS) {
    const ts = tsAll[ch];
    if (!isDict(ts) || !TRIGGERS.every((t) => strList(ts[t]))) {
      return [null, `trigger_status.${ch} thiếu mốc ${tup(TRIGGERS)}`];
    }
    if (!strList(rsAll[ch])) return [null, `return_status.${ch} phải là list chuỗi`];
    const order = isDict(mm) && isDict(mm[ch]) ? mm[ch].order : undefined;
    const cs =
      isDict(order) && Object.hasOwn(order, 'cancel_status') ? pyList(order.cancel_status) : null;
    if (cs === null) return [null, `market_csv_map thiếu ${ch}/order/cancel_status`];
    cancel[ch] = cs as string[];
  }
  const rc = cfg.request_columns;
  if (
    !isDict(rc) ||
    Object.keys(rc).length !== REQ_FIELDS.length ||
    !REQ_FIELDS.every((f) => Object.hasOwn(rc, f)) ||
    !Object.values(rc).every((v) => typeof v === 'string' && pyStrip(v))
  ) {
    return [null, `request_columns phải đủ ${tup(REQ_FIELDS)}`];
  }
  const cols = cfg.csv_columns;
  if (
    !strList(cols) ||
    !cols.every((c) => CSV_FIELDS.includes(c)) ||
    cols.length !== new Set(cols).size ||
    !cols.includes('ma_tham_chieu')
  ) {
    return [null, `csv_columns phải ⊂ ${tup(CSV_FIELDS)}, không trùng`];
  }
  if (typeof cfg.retail_buyer !== 'string' || !pyStrip(cfg.retail_buyer)) {
    return [null, 'thiếu retail_buyer'];
  }
  return [{ ...cfg, cancel_status: cancel } as InvConfig, null];
}

// ---------------------------------------------------------------- file yêu cầu xuất hóa đơn (thuần)

/** Khóa (kênh, hash) của map yêu cầu. */
export const reqKey = (channel: string, hash: string): string => `${channel}|${hash}`;

/**
 * `read_yeu_cau` → [{`kênh|hash`: người mua}, lỗi]. Lỗi chỉ nêu số dòng + tên field — KHÔNG giá trị ô
 * (PII người mua).
 */
export async function readYeuCau(
  path: string,
  channel: string,
  cfg: Pick<InvConfig, 'request_columns'>,
): Promise<[Map<string, Buyer>, string[]]> {
  const [src, , err] = readTable(path);
  if (err !== null || src === null) return [new Map(), [err as string]];
  const rc = cfg.request_columns;
  const out = new Map<string, Buyer>();
  const seen = new Map<string, number>();
  let errs: string[] = [];
  try {
    const it = await openTable(src);
    const first = nextRow(it);
    if (first === null) return [new Map(), ['file rỗng']];
    let colOf: Record<string, number>;
    [colOf, errs] = mapHeader(
      first[1],
      Object.fromEntries(REQ_REQUIRED.map((f) => [f, rc[f] as string])),
      Object.fromEntries(
        REQ_FIELDS.filter((f) => !REQ_REQUIRED.includes(f)).map((f) => [f, rc[f] as string]),
      ),
      [],
      'yêu cầu xuất hóa đơn',
    );
    if (errs.length) return [new Map(), errs];
    const width = first[1].length;
    for (let r = it.next(); !r.done; r = it.next()) {
      const [rowNo, cells] = r.value;
      const [rec, extra] = rowRecord(cells, width, colOf);
      if (extra) {
        errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
        continue;
      }
      const get = (f: string): Cell => rec[f] ?? null;
      let bad = false;
      for (const f of REQ_REQUIRED) {
        if (get(f) === null) {
          errs.push(`dòng ${rowNo}: thiếu field '${f}'`);
          bad = true;
        }
      }
      for (const [f, n] of REQ_MAXLEN) {
        const v = get(f);
        if (v !== null && cpLen(v) > n) {
          errs.push(`dòng ${rowNo}: field '${f}' dài quá ${n}`);
          bad = true;
        }
      }
      const tax = get('tax_code');
      if (tax !== null && !MST_RE.test(tax)) {
        errs.push(`dòng ${rowNo}: field 'tax_code' không phải MST 10 hoặc 10-3 chữ số`);
        bad = true;
      }
      if (bad) continue;
      const key = reqKey(channel, orderHash(channel, get('order_id') as string));
      const prev = seen.get(key);
      if (prev !== undefined) {
        errs.push(`dòng ${rowNo}: mã đơn trùng dòng ${prev}`);
        continue;
      }
      seen.set(key, rowNo);
      out.set(key, {
        buyer_name: get('buyer_name') as string,
        tax_code: tax as string,
        address: get('address'),
        email: get('email'),
      });
    }
  } catch (e) {
    if (e instanceof TableError) return [new Map(), [e.message]];
    throw e;
  }
  if (!seen.size && !errs.length) return [new Map(), ['file chỉ có header, không có dòng dữ liệu']];
  return [errs.length ? new Map() : out, errs];
}

// ---------------------------------------------------------------- gom lô (thuần)

/**
 * orders: snapshot mới nhất mỗi kênh tới hết ngày D. yeuCau: {`kênh|hash`: người mua}. invoiced: dòng
 * `invoice_lines` thuộc lô pending/approved. → lô (chưa có batch_key). Phân loại: `thuong`/`can_mst`
 * (đạt mốc, chưa thuộc lô), `dieu_chinh` (đã thuộc lô APPROVED nay ở trạng thái trả hàng, chưa có
 * dòng điều chỉnh) → `ref_batch_key` lô gốc.
 */
export function buildBatch(
  orders: Order[],
  yeuCau: Map<string, Buyer>,
  invoiced: Invoiced[],
  cfg: Pick<InvConfig, 'invoice_trigger' | 'trigger_status' | 'return_status' | 'cancel_status'>,
  day: string,
): Batch {
  const trig = cfg.invoice_trigger;
  const billed = new Map<string, Invoiced>();
  const approved = new Map<string, Invoiced>();
  const adjusted = new Set<string>();
  for (const r of invoiced) {
    const key = reqKey(r.channel, r.order_id_hash);
    if (r.kind === 'dieu_chinh') {
      adjusted.add(key);
      continue;
    }
    billed.set(key, r);
    if (r.status === 'approved') approved.set(key, r);
  }
  const lines: Line[] = [];
  const excluded = { huy: 0, chua_dat_moc: 0, da_lap: 0 };
  const matched = new Set<string>();
  const nfcSet = (xs: string[] | undefined) => new Set((xs ?? []).map(nfc));
  for (const o of orders) {
    const ch = o.channel;
    const key = reqKey(ch, o.order_id_hash);
    const st = nfc(o.status || '');
    if (billed.has(key)) {
      const ap = approved.get(key);
      if (ap !== undefined && !adjusted.has(key) && nfcSet(cfg.return_status[ch]).has(st)) {
        // Người mua của HĐ điều chỉnh = người mua HĐ GỐC: không có trong DB (cố ý) → chỉ lấy từ
        // `--yeu-cau` nếu kế toán cấp lại; không thì CSV ghi "THEO HĐ GỐC" (KHÔNG retail_buyer).
        const buyer = yeuCau.get(key) ?? null;
        if (buyer !== null) matched.add(key);
        lines.push({
          ...o,
          kind: 'dieu_chinh',
          buyer,
          orig_kind: ap.kind,
          amount_vnd: ap.amount_vnd,
          ref_batch_key: ap.batch_key,
        });
      } else excluded.da_lap += 1;
      continue;
    }
    if (nfcSet(cfg.cancel_status[ch]).has(st)) {
      excluded.huy += 1;
      continue;
    }
    if (!nfcSet(cfg.trigger_status[ch]?.[trig]).has(st)) {
      excluded.chua_dat_moc += 1;
      continue;
    }
    const buyer = yeuCau.get(key) ?? null;
    if (buyer !== null) matched.add(key);
    lines.push({
      ...o,
      kind: buyer ? 'can_mst' : 'thuong',
      buyer,
      orig_kind: null,
      ref_batch_key: null,
    });
  }
  lines.sort(
    (a, b) =>
      (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0) ||
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      (a.order_id_hash < b.order_id_hash ? -1 : a.order_id_hash > b.order_id_hash ? 1 : 0),
  );
  let unmatched = 0;
  for (const k of yeuCau.keys()) if (!matched.has(k)) unmatched += 1;
  return { day, trigger: trig, lines, excluded, unmatched_yeu_cau: unmatched };
}

/** Ô CSV mở bằng Excel: chuỗi bắt đầu = + - @ tab CR → tiền tố ' (chống formula injection). */
export function cellSafe(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return FORMULA_START.some((p) => s.startsWith(p)) ? `'${s}` : s;
}

/** Ô người mua của dòng điều chỉnh khi không có `--yeu-cau`: trỏ về HĐ gốc (KHÔNG retail_buyer). */
function origMarker(ln: Line): string {
  let s = `THEO HĐ GỐC lô ${ln.ref_batch_key}`;
  if (ln.orig_kind === 'can_mst') s += ' — gốc cần MST: lấy tên/MST/địa chỉ từ HĐ gốc';
  return s;
}

/** Python `csv.writer` (excel: QUOTE_MINIMAL, `\r\n`). */
function csvRow(fields: string[]): string {
  if (fields.length === 1 && fields[0] === '') return '""\r\n';
  return `${fields.map((v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(',')}\r\n`;
}

/**
 * File NHÁP — 1 dòng / mặt hàng, cột `csv_columns` (format GIẢ ĐỊNH). Dòng `dieu_chinh`: số tiền ghi
 * DƯƠNG = giá trị điều chỉnh GIẢM theo HĐ gốc (quy ước dấu GIẢ ĐỊNH — chờ mẫu file nhập NCC HĐĐT).
 */
export function renderCsv(
  batch: Batch,
  cfg: Pick<InvConfig, 'csv_columns' | 'retail_buyer'>,
  attempt: number,
): Buffer {
  const cols = cfg.csv_columns;
  let out = csvRow(cols);
  for (const ln of batch.lines) {
    const b = ln.buyer;
    let name: string | null = b?.buyer_name ?? null;
    if (name === null) name = ln.kind === 'dieu_chinh' ? origMarker(ln) : cfg.retail_buyer;
    const items = ln.items.length ? ln.items : [{ title: null, qty: null, price_vnd: null }];
    for (const it of items) {
      const qty = it.qty ?? null;
      const price = it.price_vnd ?? null;
      const rec: Record<string, string | number | null> = {
        lan_lap: attempt,
        ma_tham_chieu: ln.order_id_hash,
        ngay_lap: batch.day,
        kenh: ln.channel,
        loai: ln.kind,
        ten_nguoi_mua: name,
        mst: b?.tax_code ?? null,
        dia_chi: b?.address ?? null,
        email: b?.email ?? null,
        ten_hang: it.title ?? null,
        so_luong: qty,
        don_gia: price,
        thanh_tien: qty !== null && price !== null ? qty * price : null,
        lo_goc: ln.ref_batch_key,
      };
      out += csvRow(cols.map((c) => cellSafe(rec[c])));
    }
  }
  return Buffer.from(out, 'utf8');
}

const countKinds = (ls: Line[]): Record<Kind, number> => ({
  thuong: ls.filter((x) => x.kind === 'thuong').length,
  can_mst: ls.filter((x) => x.kind === 'can_mst').length,
  dieu_chinh: ls.filter((x) => x.kind === 'dieu_chinh').length,
});

/** → [title, payload markdown] — KHÔNG thông tin người mua (chỉ hash rút gọn, kênh, số tiền, cờ). */
export function renderPayload(
  batch: Batch,
  batchKey: string,
  csvSha: string,
  cfg: Pick<InvConfig, 'confirmed_by'>,
  attempt: number,
): [string, string] {
  const ls = batch.lines;
  const n = countKinds(ls);
  const ex = batch.excluded;
  const who = cfg.confirmed_by;
  const L = [
    `# Lô hóa đơn NHÁP ${fmtDay(batch.day, '%d/%m/%Y')} — \`${batchKey}\``,
    '',
    `- Mốc lập hóa đơn: \`${batch.trigger}\` — ${who ? `đã chốt bởi ${who}` : 'GIẢ ĐỊNH, chưa tư vấn thuế chốt (hạn 25/10/2026)'}`,
    `- Lần lập trong ngày: ${attempt}`,
    `- Số dòng: ${ls.length} (thường ${n.thuong} · cần MST ${n.can_mst} · điều chỉnh ${n.dieu_chinh}) — tổng ${vnd(ls.reduce((s, x) => s + x.amount_vnd, 0))}`,
    `- Loại khỏi lô: đơn hủy ${ex.huy} · chưa đạt mốc ${ex.chua_dat_moc} · đã lập ở lô khác ${ex.da_lap}`,
    '',
    '## Dòng (mã tham chiếu rút gọn 8 ký tự)',
    '',
  ];
  for (const x of ls) {
    let flag =
      x.kind === 'thuong'
        ? ''
        : x.kind === 'can_mst'
          ? ' — cần MST'
          : ` — điều chỉnh — lô gốc \`${x.ref_batch_key}\``;
    if (x.kind === 'dieu_chinh') {
      if (x.orig_kind === 'can_mst') flag += ' — gốc cần MST';
      flag += x.buyer ? ' — người mua theo file yêu cầu' : ' — người mua THEO HĐ GỐC';
    }
    L.push(`- \`${x.order_id_hash.slice(0, 8)}\` ${x.channel} ${vnd(x.amount_vnd)}${flag}`);
  }
  if (n.dieu_chinh) {
    L.push(
      '',
      'Dòng điều chỉnh: số tiền ghi DƯƠNG = giá trị điều chỉnh GIẢM theo HĐ gốc (quy ước dấu GIẢ ĐỊNH — chờ mẫu file nhập của nhà cung cấp HĐĐT); người mua lấy đúng như HĐ gốc.',
    );
  }
  L.push(
    '',
    `csv_sha256: ${csvSha}`,
    '',
    'BẢN NHÁP — agent không ký số, không phát hành, không gửi. Kế toán chạy `python -m agents.acc_invoice --verify-draft <id> --file <file nháp>` trước khi nhập tay vào phần mềm HĐĐT.',
    '',
  );
  return [`Lô hóa đơn NHÁP ${batch.day} (${ls.length} dòng)`, L.join('\n')];
}

// ---------------------------------------------------------------- DB

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Đơn từ snapshot `order` MỚI NHẤT mỗi kênh nạp trước hết ngày D (giờ VN). */
export async function fetchOrders(db: Db, day: string): Promise<Order[]> {
  const [, end] = periodBounds('day', day);
  const snaps = await db.query(
    "select distinct on (channel) id::text as id, channel from market_snapshots where export_kind = 'order' and imported_at < $1 order by channel, imported_at desc, id desc",
    [end],
  );
  const out = new Map<string, Order>();
  for (const s of snaps.rows) {
    const { rows } = await db.query(
      'select order_id_hash, status, title, qty, price_vnd from market_rows where snapshot_id = $1 and order_id_hash is not null order by row_no',
      [s.id],
    );
    for (const r of rows) {
      const key = reqKey(s.channel, r.order_id_hash);
      let o = out.get(key);
      if (o === undefined) {
        o = {
          channel: s.channel,
          order_id_hash: r.order_id_hash,
          status: r.status,
          amount_vnd: 0,
          items: [],
        };
        out.set(key, o);
      }
      const qty = num(r.qty);
      const price = num(r.price_vnd);
      o.amount_vnd += (price || 0) * (qty || 0);
      o.items.push({ title: r.title, qty, price_vnd: price });
    }
  }
  return [...out.values()];
}

export async function fetchInvoiced(db: Db): Promise<Invoiced[]> {
  const { rows } = await db.query(
    "select l.channel, l.order_id_hash, l.kind, l.batch_key, q.status, l.amount_vnd from invoice_lines l join approval_queue q on q.object_type = 'invoice_batch' and q.object_id = l.batch_key where q.status in ('pending', 'approved') order by l.id",
  );
  return rows.map((r) => ({ ...r, amount_vnd: Number(r.amount_vnd) }) as Invoiced);
}

export type BatchResult =
  | { status: 'locked' }
  | { status: 'skip'; queue_id: string }
  | { status: 'empty'; batch: Batch }
  | {
      status: 'ok';
      queue_id: bigint;
      batch_key: string;
      batch: Batch;
      path: string;
      csv_sha256: string;
      attempt: number;
    };

/**
 * → {status: locked|skip|empty|ok, …}. Chạy trên 1 phiên riêng (advisory lock theo phiên): dòng lô +
 * mục hàng duyệt cùng 1 giao dịch; ghi file nháp SAU commit (lỗi ghi file → lỗi nổi lên, lô đã vào
 * hàng — CLI nhắc TỪ CHỐI rồi chạy lại).
 */
export async function runBatch(
  db: Db,
  day: string,
  cfg: InvConfig,
  o: { yeuCau?: Map<string, Buyer>; outDir?: string; dcfg?: DirectorConfig } = {},
): Promise<BatchResult> {
  const c = db instanceof pg.Pool ? await db.connect() : db;
  try {
    const got = await c.query('select pg_try_advisory_lock($1::bigint) as ok', [LOCK_KEY]);
    if (!got.rows[0]?.ok) return { status: 'locked' };
    try {
      return await runLocked(c, day, cfg, o.yeuCau ?? new Map(), o.outDir ?? DRAFT_DIR, o.dcfg);
    } finally {
      await c.query('select pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    if (c !== db) (c as pg.PoolClient).release();
  }
}

async function runLocked(
  c: Db,
  day: string,
  cfg: InvConfig,
  yeuCau: Map<string, Buyer>,
  outDir: string,
  dcfg: DirectorConfig | undefined,
): Promise<BatchResult> {
  const like = `${day}-%`;
  let res: Extract<BatchResult, { status: 'ok' }>;
  let data: Buffer;
  await c.query('begin');
  try {
    const pend = await c.query(
      "select id::text as id from approval_queue where object_type = 'invoice_batch' and status = 'pending' and object_id like $1 order by id limit 1",
      [like],
    );
    if (pend.rows[0]) {
      await c.query('commit');
      return { status: 'skip', queue_id: pend.rows[0].id };
    }
    const batch = buildBatch(await fetchOrders(c, day), yeuCau, await fetchInvoiced(c), cfg, day);
    if (!batch.lines.length) {
      await c.query('commit');
      return { status: 'empty', batch };
    }
    const cnt = await c.query(
      "select count(*)::int as n from approval_queue where object_type = 'invoice_batch' and object_id like $1",
      [like],
    );
    const attempt = 1 + cnt.rows[0].n;
    data = renderCsv(batch, cfg, attempt);
    const csvSha = sha256hex(data);
    const batchKey = `${day}-${csvSha.slice(0, 12)}`;
    for (const x of batch.lines) {
      await c.query(
        'insert into invoice_lines (batch_key, batch_date, channel, order_id_hash, kind, amount_vnd, ref_batch_key) values ($1, $2, $3, $4, $5, $6, $7)',
        [batchKey, day, x.channel, x.order_id_hash, x.kind, x.amount_vnd, x.ref_batch_key],
      );
    }
    const [title, payload] = renderPayload(batch, batchKey, csvSha, cfg, attempt);
    // dòng lô + mục hàng duyệt commit CÙNG lúc (không dòng mồ côi); tính năng TẮT → RolloutBlocked
    // từ enqueue → rollback toàn bộ.
    const qid = await directorSubmit(c, {
      block: 'finance',
      objectType: 'invoice_batch',
      objectId: batchKey,
      title,
      payload,
      createdBy: AGENT,
      cfg: dcfg,
    });
    await c.query('commit');
    res = {
      status: 'ok',
      queue_id: qid,
      batch_key: batchKey,
      batch,
      path: '',
      csv_sha256: csvSha,
      attempt,
    };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  }
  // P8.4: lô dựng từ đơn sàn đã nạp — sample theo cờ mục hàng duyệt vừa tạo (fail-closed). File ghi
  // nguyên byte (không đổi CRLF) → sha file == csv_sha256.
  res.path = await writeReport(
    data.toString('utf8'),
    outDir,
    `lo-${res.batch_key}.csv`,
    await queueSample(c, res.queue_id),
  );
  return res;
}

/**
 * Mục `invoice_batch` ĐÃ DUYỆT + payload đúng bản đã duyệt (+ cổng DÙNG) + sha256 file ==
 * `csv_sha256` trong payload → [true, ..]. Ngược lại fail-closed.
 */
export async function verifyDraft(
  db: Db,
  queueId: bigint,
  path: string,
): Promise<[boolean, string]> {
  const { rows } = await db.query(
    'select object_type, block, status, payload from approval_queue where id = $1',
    [queueId.toString()],
  );
  const row = rows[0];
  if (!row) return [false, `không thấy mục #${queueId}`];
  if (row.object_type !== 'invoice_batch' || row.block !== 'finance') {
    return [false, `mục #${queueId} không phải lô hóa đơn khối finance`];
  }
  if (row.status !== 'approved') {
    return [false, `mục #${queueId} đang '${row.status}' — chưa được duyệt`];
  }
  if (!(await aqVerify(db, queueId, row.payload))) {
    return [false, `mục #${queueId}: payload lệch bản đã duyệt`];
  }
  const m = SHA_LINE_RE.exec(row.payload);
  if (!m) return [false, `mục #${queueId}: payload thiếu csv_sha256`];
  let got: string;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return [false, 'file quá lớn'];
    got = sha256hex(readFileSync(path));
  } catch (e) {
    return [false, `không đọc được file: ${pyOsName(e)}`];
  }
  if (got !== m[1]) return [false, 'file nháp KHÁC bản đã duyệt (sha256 lệch) — không nhập'];
  return [true, `mục #${queueId} đã duyệt, file khớp csv_sha256`];
}

export const draftName = (p: string): string => basename(p);
