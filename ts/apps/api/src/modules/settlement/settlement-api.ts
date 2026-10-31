import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type Service, ServiceBindError, servicePool } from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import { addDays, parseDay, vnDate, vnMidnight } from '@samsam/core/ops/period';
import { isDict, PyFloat, parsePyJson, pyFloatStr, pyOsName } from '@samsam/core/ops/py-json';
import { connErrName, isDbError, pgErrName } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { EXIT_BLOCKED, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { cpLen, pyStr, pyStrip } from '@samsam/core/security/py';
import type pg from 'pg';
import { clean, MAX_PRINT_ERRS } from '../intel_import/table.js';
import { urlsplit } from '../market/market-api.js';
import {
  type Call,
  DataError,
  id,
  isFetchError,
  LOCAL_HOSTS,
  list,
  obj,
  PAGE_SIZE,
  pages,
  SP_ESCROW_DETAIL,
  SP_ESCROW_LIST,
  str,
  TT_STATEMENT_TX,
  TT_STATEMENTS,
} from './market-api-lite.js';
import {
  crossSource,
  type Fees,
  type Io,
  LockError,
  load,
  loadFees,
  lockOrders,
  MONEY,
  MONEY_CAP,
  type MoneyKey,
  orderHash,
  overlaps,
  reconcile,
  STD_IO,
  TXN_TYPE_MAX,
  ymd,
} from './settlement-csv.js';

// Port `ingest/settlement_api.py` (r15 data_platform-06) — quyết toán qua API sàn CHỈ ĐỌC → CÙNG sổ
// `settlement_rows` của settlement-csv (validation, chống trùng, đối chiếu finance-01, view
// `v_settlement_khoan` dùng chung — KHÔNG có hệ quyết toán thứ hai). Gọi qua lệnh của nhóm market
// (`market-api --channel shopee|tiktok --kind settlement --from --to [--dry-run]`): lệnh đó ký/refresh/
// thử lại và truyền `call` vào `run`.
//  - ÁNH XẠ = QUYẾT ĐỊNH KẾ TOÁN (`data/settlement_api_map.json`): chưa chốt / thiếu người-căn cứ /
//    thành phần LẠ hoặc null có trong dữ liệu / loại giao dịch chưa quyết → BLOCKED (exit 2) TRƯỚC khi
//    ghi; `--dry-run` liệt kê trạng thái từng thành phần (tên trường, không giá trị), không đụng DB.
//  - Nguồn: CHỈ `api_live` được ghi sổ (sandbox/server giả chỉ `--dry-run`); TikTok sandbox và thật
//    CÙNG host → chỉ `api_live` khi người vận hành khai `TIKTOK_API_ENV=live`.
//  - Ghi: kéo hết + kiểm hết rồi mới connect; 1 transaction khóa (kênh, đơn) → đã nạp? → nguồn khác
//    (CSV) → load(api_live) + reconcile + overlaps → commit. `file_sha256` = sha256 NỘI DUNG dòng
//    chuẩn hóa → cùng dữ liệu = `[skip]`.
//  - r15-fix1 F2: thành phần đã ánh xạ vào cột mà thiếu/null/("" TikTok)/sai kiểu = LỖI, không phải 0
//    (trừ `khi_vang: bang_0` do Kế toán quyết, cấm cho order_amount/payout). F3: Shopee ghi một
//    trường chỉ khi đồng tiền của ĐÚNG trường đó là VND. Không quy đổi tỷ giá.

export const MAP_FILE = dataPath('settlement_api_map.json');
export const MAX_DAYS = 31;
export const COLS = MONEY; // order_amount, 7 khoản trừ, payout
export const LIVE_HOSTS: Record<string, string[]> = {
  shopee: ['partner.shopeemobile.com'],
  tiktok: ['open-api.tiktokglobalshop.com'],
};
export const SANDBOX_HOSTS: Record<string, string[]> = {
  shopee: ['openplatform.sandbox.test-stable.shopee.sg'],
  tiktok: [],
};
export const TT_ORDER_FIELDS = ['order_id', 'adjustment_order_id', 'associated_order_id'] as const;
export const TT_IDENTITY = new Set([
  'id',
  'type',
  'order_create_time',
  'adjustment_id',
  'reserve_id',
  'reserve_status',
  'estimated_release_time',
  ...TT_ORDER_FIELDS,
]);
export const SP_CURRENCY = ['pri_currency', 'aff_currency'] as const;
// Thành phần đã ánh xạ mà VẮNG: null/"loi" (mặc định) = lỗi dữ liệu; "bang_0" = Kế toán quyết rõ vắng
// tính 0 (chỉ cột không bắt buộc).
export const KHI_VANG = [null, 'loi', 'bang_0'] as const;
export const REQUIRED_COLS = ['order_amount', 'payout'] as const;
const AMT_RE = /^-?[0-9]{1,15}(?:\.0{1,6})?$/;
const SID_RE = /^[0-9]{1,30}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
export const MAX_SHOW = 60;

/** Bảng ánh xạ hỏng dạng — message chỉ nêu khóa, không giá trị. */
export class MapError extends Error {
  override name = 'MapError';
}

// ---------------------------------------------------------------- ngày ISO (Python 3.12)

const DAY_MS = 86_400_000;

/** Ngày → số ngày từ 1970-01-01 (lịch Gregory đón trước, năm ≥ 1). */
function dayNo(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round(t.getTime() / DAY_MS);
}

function dayStrOf(n: number): string | null {
  const t = new Date(n * DAY_MS);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Python 3.12 `date.fromisoformat(s)` (bản C): độ dài UTF-8 7/8/10; `YYYY-MM-DD`, `YYYYMMDD`,
 * `YYYY-Www[-D]`, `YYYYWww[D]` (đuôi thừa sau ngày bị bỏ qua như CPython) → 'YYYY-MM-DD' | null.
 */
export function fromIsoDate(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  if (/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const b = Buffer.from(s, 'utf8');
  const len = b.length;
  if (len !== 7 && len !== 8 && len !== 10) return null;
  let p = 0;
  const at = (i: number) => (i < len ? (b[i] as number) : 0);
  const digits = (n: number): number | null => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = at(p + k);
      if (c < 0x30 || c > 0x39) return null;
      v = v * 10 + (c - 0x30);
    }
    p += n;
    return v;
  };
  const year = digits(4);
  if (year === null) return null;
  const sep = at(p) === 0x2d;
  if (sep) p++;
  if (at(p) === 0x57) {
    p++;
    const week = digits(2);
    if (week === null) return null;
    let day = 1;
    if (p < len) {
      if (sep && at(p++) !== 0x2d) return null;
      const d = digits(1);
      if (d === null) return null;
      day = d;
    }
    if (year < 1) return null;
    if (week <= 0 || week >= 53) {
      let ok = false;
      if (week === 53) {
        const first = (new Date(dayNo(year, 1, 1) * DAY_MS).getUTCDay() + 6) % 7; // thứ Hai = 0
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        ok = first === 3 || (first === 2 && leap);
      }
      if (!ok) return null;
    }
    if (day <= 0 || day >= 8) return null;
    // Thứ Hai của tuần ISO 1 = thứ Hai của tuần chứa ngày 4/1.
    const jan4 = dayNo(year, 1, 4);
    const monday1 = jan4 - ((new Date(jan4 * DAY_MS).getUTCDay() + 6) % 7);
    return dayStrOf(monday1 + (week - 1) * 7 + day - 1);
  }
  const month = digits(2);
  if (month === null) return null;
  if (sep && at(p++) !== 0x2d) return null;
  const day = digits(2);
  if (day === null) return null;
  return ymd(year, month, day);
}

const daysBetween = (a: string, b: string): number =>
  Math.round(((parseDay(b) as number) - (parseDay(a) as number)) / DAY_MS);

// ---------------------------------------------------------------- nguồn

/** Nguồn dữ liệu theo host của base URL: api_live | api_sandbox | api_local | khong_ro. */
export function sourceKind(channel: string, base: string, env: Env = process.env): string {
  // Python `urllib.parse.urlsplit(base).hostname`: KHÔNG giải mã %xx, '\' không tách host (khác WHATWG
  // `new URL`). Netloc có '[': Python ném ValueError (trong [] không phải IPv6) hoặc host là IPv6 —
  // không bao giờ khớp danh sách host → TS khong_ro (chặt hơn ở chỗ Python crash).
  let host = '';
  try {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: urlsplit lstrip C0 + khoảng trắng
    const netloc = urlsplit(base.replace(/^[\x00-\x20]+/, '')).netloc;
    if (!netloc.includes('[')) {
      host = ((netloc.split('@').at(-1) as string).split(':')[0] as string).toLowerCase();
    }
  } catch {
    host = '';
  }
  if (LOCAL_HOSTS.includes(host)) return 'api_local';
  if ((SANDBOX_HOSTS[channel] ?? []).includes(host)) return 'api_sandbox';
  if ((LIVE_HOSTS[channel] ?? []).includes(host)) {
    if (channel === 'tiktok' && pyStrip(env.TIKTOK_API_ENV ?? '') !== 'live') return 'khong_ro';
    return 'api_live';
  }
  return 'khong_ro';
}

// ---------------------------------------------------------------- ánh xạ

export type Decision = Record<string, unknown> | null;
export type ApiCfg = {
  thanh_phan: Record<string, Decision>;
  loai_giao_dich: Record<string, Decision>;
  tien_te_shop?: unknown;
};

const PREFIXES = ['agent:', 'system:', 'auto_policy:'];

/** Người thật chốt (không rỗng, không `agent:`/`system:`/`auto_policy:` sau NFKC + lower). */
function isPerson(v: unknown): boolean {
  if (typeof v !== 'string' || !pyStrip(v)) return false;
  const s = pyStrip(v.normalize('NFKC')).toLowerCase();
  return !PREFIXES.some((p) => s.startsWith(p));
}

const subset = (d: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(d).every((k) => keys.includes(k));

function decision(name: string, d: unknown, tiktokType = false): void {
  if (d === null) return;
  if (!isDict(d)) {
    throw new MapError(`quyết định '${clean(name, 80)}' phải là object/null`);
  }
  if (d.bo_qua === true && Object.keys(d).length <= 2 && subset(d, ['bo_qua', 'ghi_chu'])) return;
  if (tiktokType) {
    const t = d.txn_type;
    if (
      (TT_ORDER_FIELDS as readonly unknown[]).includes(d.ma_don) &&
      subset(d, ['ma_don', 'txn_type', 'ghi_chu']) &&
      (t === null ||
        t === undefined ||
        (typeof t === 'string' && pyStrip(t) !== '' && cpLen(t) <= 64))
    ) {
      return;
    }
  } else if (
    (COLS as readonly unknown[]).includes(d.cot) &&
    (d.dau === 1 || d.dau === -1) &&
    subset(d, ['cot', 'dau', 'ghi_chu', 'khi_vang']) &&
    (d.khi_vang === undefined || (KHI_VANG as readonly unknown[]).includes(d.khi_vang))
  ) {
    // r15-fix1 F2: cột bắt buộc không được lấp bằng 0 khi vắng.
    if (d.khi_vang === 'bang_0' && (REQUIRED_COLS as readonly unknown[]).includes(d.cot)) {
      throw new MapError(
        `quyết định '${clean(name, 80)}': khi_vang bang_0 không dùng được cho cột bắt buộc ${d.cot}`,
      );
    }
    return;
  }
  throw new MapError(`quyết định '${clean(name, 80)}' sai dạng`);
}

/**
 * `load_map` → {cfg: mục của kênh, why: lý do CHƯA được dùng để ghi sổ ([] = đã chốt hợp lệ)}.
 * Tệp/khóa sai dạng → MapError.
 */
export function loadMap(channel: string, path: string = MAP_FILE): { cfg: ApiCfg; why: string[] } {
  const name = basename(path);
  // Đọc giữ kiểu int/float như Python (`"dau": 1.0` là float). TS chặt hơn: Python nhận `dau` 1.0 lúc
  // nạp rồi mới hỏng ở `check_rows` (tổng thành float, exit 1) — TS chặn ngay "sai dạng" (exit 1).
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new MapError(`${name}: không đọc được (${pyOsName(e)})`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new MapError(`${name}: không đọc được (UnicodeDecodeError)`);
  }
  let doc: unknown;
  try {
    doc = parsePyJson(text);
  } catch {
    throw new MapError(`${name}: không đọc được (JSONDecodeError)`);
  }
  const sec = isDict(doc) ? doc[channel] : undefined;
  if (!isDict(sec)) throw new MapError(`${name}: thiếu mục kênh ${channel}`);
  const tp = Object.hasOwn(sec, 'thanh_phan') ? sec.thanh_phan : {};
  const lg = channel === 'tiktok' && Object.hasOwn(sec, 'loai_giao_dich') ? sec.loai_giao_dich : {};
  if (!isDict(tp) || !isDict(lg)) {
    throw new MapError(`${name}/${channel}: thanh_phan/loai_giao_dich phải là object`);
  }
  for (const [k, d] of Object.entries(tp)) decision(k, d);
  for (const [k, d] of Object.entries(lg)) decision(k, d, true);
  // r15-fix1 F3: đơn vị tiền shop Shopee khi response không có mã — null/vắng = chưa xác nhận.
  const shop = sec.tien_te_shop ?? null;
  if (
    Object.hasOwn(sec, 'tien_te_shop') &&
    (channel !== 'shopee' || (shop !== null && shop !== 'VND'))
  ) {
    throw new MapError(`${name}/${channel}: tien_te_shop chỉ dùng cho shopee, giá trị null|"VND"`);
  }
  const why: string[] = [];
  const st = sec.trang_thai;
  if (st !== 'chua_chot' && st !== 'da_chot') {
    throw new MapError(`${name}/${channel}: trang_thai phải là chua_chot|da_chot`);
  }
  if (st !== 'da_chot') why.push('trang_thai = chua_chot (Kế toán chưa chốt bảng ánh xạ)');
  if (!isPerson(sec.duyet_boi)) why.push('thiếu duyet_boi (người chốt — không phải agent/system)');
  if (!(typeof sec.can_cu === 'string' && pyStrip(sec.can_cu))) {
    why.push('thiếu can_cu (văn bản/biên bản chốt)');
  }
  const nc = sec.ngay_chot;
  if (fromIsoDate(nc === null || nc === undefined || nc === '' ? '' : nc) === null) {
    why.push('thiếu/sai ngay_chot (YYYY-MM-DD)');
  }
  const decs = [...Object.values(tp), ...Object.values(lg)];
  const nNull = decs.filter((d) => d === null).length;
  if (nNull) why.push(`${nNull} quyết định còn trống (null)`);
  const used = new Set(
    Object.values(tp)
      .filter((d) => isDict(d) && Object.hasOwn(d, 'cot'))
      .map((d) => (d as Record<string, unknown>).cot),
  );
  for (const need of ['order_amount', 'payout']) {
    if (!used.has(need)) why.push(`chưa có thành phần nào ghi vào cột ${need}`);
  }
  if (
    channel === 'tiktok' &&
    !Object.values(lg).some((d) => isDict(d) && Object.hasOwn(d, 'ma_don'))
  ) {
    why.push('chưa có loại giao dịch nào được ghi (loai_giao_dich)');
  }
  return {
    cfg: {
      thanh_phan: tp as Record<string, Decision>,
      loai_giao_dich: lg as Record<string, Decision>,
      tien_te_shop: shop,
    },
    why,
  };
}

// ---------------------------------------------------------------- kéo + chuẩn hóa

/**
 * `_vnd`: số tiền API → số nguyên VND. "" (chỉ khoảng trắng) → null (vắng). Lẻ/sai kiểu/vượt trần →
 * DataError (chỉ nêu tên trường).
 */
export function apiVnd(v: unknown, name: string, where: string): number | null {
  let n: number | bigint | null = null;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') n = Number.isInteger(v) ? v : null;
  else if (v instanceof PyFloat) n = Number.isInteger(v.v) ? v.v : null;
  else if (typeof v === 'string') {
    const t = pyStrip(v);
    if (t === '') return null;
    if (AMT_RE.test(t)) n = Number(t.split('.')[0]);
  }
  const over =
    typeof n === 'bigint'
      ? (n < 0n ? -n : n) > BigInt(MONEY_CAP)
      : n !== null && Math.abs(n) > MONEY_CAP;
  if (n === null || over) {
    throw new DataError(
      `${where}: thành phần '${clean(name, 80)}' không phải số nguyên VND hợp lệ`,
    );
  }
  return Number(n) === 0 ? 0 : Number(n);
}

/** Python `str(v)` cho giá trị phản hồi (số thực `PyFloat` → `1.0`). */
const pyStrV = (v: unknown): string =>
  v instanceof PyFloat ? pyFloatStr(v.v) : typeof v === 'bigint' ? v.toString() : pyStr(v);

/** Đánh dấu danh sách object không rỗng (chỉ được `bo_qua`). */
export const LIST: unique symbol = Symbol('danh sách');
export type Comp = string | number | bigint | boolean | null | PyFloat | typeof LIST;
export type Comps = Map<string, Comp>;

/**
 * `_flatten`: object lồng → {tên dạng a.b.c: giá trị THÔ | LIST}. KHÔNG đổi số ở đây — thiếu/null/
 * sai kiểu chỉ phán được khi biết trường có được ánh xạ hay không (`toRows`). List chỉ có giá trị
 * vô hướng → bỏ. `skip` = khóa cấp đầu bỏ qua (mã định danh).
 */
export function flatten(
  d: Record<string, unknown>,
  where: string,
  skip: ReadonlySet<string> = new Set(),
  prefix = '',
): Comps {
  const out: Comps = new Map();
  for (const [k, v] of Object.entries(d)) {
    if (!prefix && skip.has(k)) continue;
    const name = prefix + k;
    if (isDict(v)) {
      for (const [kk, vv] of flatten(v, where, skip, `${name}.`)) out.set(kk, vv);
    } else if (Array.isArray(v)) {
      if (v.some((x) => isDict(x))) out.set(`${name}[]`, LIST);
    } else {
      out.set(name, v as Comp);
    }
  }
  return out;
}

/** Vắng = khóa không có / null; TikTok (số dạng chuỗi) thêm "" (rỗng). */
function absent(channel: string, v: Comp | undefined): boolean {
  return (
    v === null ||
    v === undefined ||
    (channel === 'tiktok' && typeof v === 'string' && pyStrip(v) === '')
  );
}

/** Giá trị TRÔNG như số tiền ở trường KHÔNG ánh xạ vào cột: Shopee số; TikTok mọi chuỗi không rỗng. */
function moneyLike(channel: string, v: Comp | undefined): boolean {
  if (v === LIST) return true;
  if (typeof v === 'boolean' || v === null || v === undefined) return false;
  if (typeof v === 'number' || typeof v === 'bigint' || v instanceof PyFloat) return true;
  return channel === 'tiktok' && typeof v === 'string' && pyStrip(v) !== '';
}

/**
 * Đơn vị tiền của trường Shopee `name` theo đặc tả get_escrow_detail: `*_pri` → `pri_currency`;
 * trường thường → `aff_currency`. Response không có cả hai mã → `tien_te_shop` (null = không xác định).
 */
function spCurrency(name: string, cur: Record<string, unknown> | null, shop: unknown): unknown {
  if (!cur || !Object.keys(cur).length) return shop;
  return cur[name.endsWith('_pri') ? 'pri_currency' : 'aff_currency'] ?? null;
}

/** [đầu ngày d0, đầu ngày sau d1) giờ VN → Unix giây. */
export function vnBounds(d0: string, d1: string): [number, number] {
  return [vnMidnight(d0).getTime() / 1000, vnMidnight(addDays(d1, 1)).getTime() / 1000];
}

/**
 * `_vn_date`: Unix giây (int > 0; float/bool → lỗi) → ngày giờ VN. TS chặt hơn: mốc ngoài năm 1..9999
 * (kể cả bigint) → DataError (Python: lỗi tràn không bắt → traceback).
 */
function vnDateTs(ts: unknown, field: string, where: string): string {
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) {
    throw new DataError(`${where}: field '${field}' thiếu/sai kiểu`);
  }
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime()) || ts > 253402300799 - 7 * 3600) {
    throw new DataError(`${where}: field '${field}' thiếu/sai kiểu`);
  }
  return vnDate(d);
}

export type Rec = {
  order: string | null;
  type: string | null;
  settled_on: string | null;
  cur?: Record<string, unknown>;
  ids?: Record<string, string | null>;
  comps: Comps;
};

/** Shopee: escrow list (theo release_time) → escrow detail từng đơn → order_income. */
export async function fetchShopee(call: Call, d0: string, d1: string): Promise<Rec[]> {
  const w = 'shopee quyết toán';
  const [t0, t1] = vnBounds(d0, d1);
  const seen = new Map<string, [number | null, string]>();
  let pn = 1;
  await pages<number>(
    async (cur) => {
      pn = cur || 1;
      return obj(
        await call('GET', SP_ESCROW_LIST, {
          release_time_from: t0,
          release_time_to: t1 - 1,
          page_size: PAGE_SIZE,
          page_no: pn,
        }),
        'response',
        w,
      );
    },
    (r) => {
      if (typeof r.more !== 'boolean') throw new DataError(`${w}: thiếu/sai field 'more'`);
      return r.more ? pn + 1 : null;
    },
    (r) => {
      for (const e of list(r, 'escrow_list', w)) {
        const sn = id(e.order_sn, 'order_sn', w);
        const pay = apiVnd(e.payout_amount, 'payout_amount', w);
        const rel = vnDateTs(e.escrow_release_time, 'escrow_release_time', w);
        const prev = seen.get(sn);
        if (prev === undefined) seen.set(sn, [pay, rel]);
        else if (prev[0] !== pay || prev[1] !== rel) {
          throw new DataError(
            `${w}: cùng 1 đơn xuất hiện 2 lần với số/ngày KHÁC nhau trong 1 lượt — không tự chọn bản`,
          );
        }
      }
    },
  );
  const recs: Rec[] = [];
  for (const [sn, [, rel]] of seen) {
    const resp = obj(await call('GET', SP_ESCROW_DETAIL, { order_sn: sn }), 'response', w);
    if (id(resp.order_sn, 'order_sn', w) !== sn) {
      throw new DataError(`${w}: escrow detail trả đơn khác đơn đã hỏi`);
    }
    const inc = obj(resp, 'order_income', w);
    // r15-fix1 F3: mã tiền tệ là siêu dữ liệu của từng trường tiền, không phải thành phần.
    const cur: Record<string, unknown> = {};
    for (const k of SP_CURRENCY) if (Object.hasOwn(inc, k)) cur[k] = inc[k];
    recs.push({
      order: sn,
      type: null,
      settled_on: rel,
      cur,
      comps: flatten(inc, w, new Set(SP_CURRENCY)),
    });
  }
  return recs;
}

async function ttPages(
  call: Call,
  path: string,
  params: Record<string, unknown>,
  w: string,
  body: (d: Record<string, unknown>) => void,
  pathParams: Record<string, string> | null = null,
): Promise<void> {
  await pages<string>(
    async (tok) => {
      const p: Record<string, unknown> = { ...params, page_size: PAGE_SIZE };
      if (tok) p.page_token = tok;
      return obj(await call('GET', path, p, undefined, pathParams), 'data', w);
    },
    (d) => {
      const t = d.next_page_token;
      if (t !== null && t !== undefined && typeof t !== 'string') {
        throw new DataError(`${w}: next_page_token sai kiểu`);
      }
      return (t as string | null | undefined) || null;
    },
    body,
  );
}

function vndCurrency(d: Record<string, unknown>, w: string): void {
  if (d.currency !== 'VND') {
    throw new DataError(`${w}: currency khác VND — sổ quyết toán chỉ nhận VND`);
  }
}

const numOf = (v: unknown): number | bigint | undefined =>
  typeof v === 'boolean'
    ? Number(v)
    : typeof v === 'number' || typeof v === 'bigint'
      ? v
      : v instanceof PyFloat
        ? v.v
        : undefined;

/** Python `==` giữa giá trị phản hồi: số (bool/int/float) so theo giá trị (`1 == 1.0 == True`). */
function sameComp(a: Comp | undefined, b: Comp | undefined): boolean {
  if (a === b) return true;
  const x = numOf(a);
  const y = numOf(b);
  if (x === undefined || y === undefined) return false;
  if (typeof x === 'bigint' || typeof y === 'bigint') {
    const ix = typeof x === 'bigint' ? x : Number.isInteger(x) ? BigInt(x) : null;
    const iy = typeof y === 'bigint' ? y : Number.isInteger(y) ? BigInt(y) : null;
    return ix !== null && ix === iy;
  }
  return x === y;
}

function sameRec(a: Rec, b: Rec): boolean {
  if (a.type !== b.type || a.settled_on !== b.settled_on || a.order !== b.order) return false;
  for (const f of TT_ORDER_FIELDS) if (a.ids?.[f] !== b.ids?.[f]) return false;
  if (a.comps.size !== b.comps.size) return false;
  for (const [k, v] of a.comps) {
    if (!b.comps.has(k) || !sameComp(v, b.comps.get(k))) return false;
  }
  return true;
}

/** TikTok: statements (theo statement_time) → giao dịch từng statement (ORDER/RESERVE/điều chỉnh). */
export async function fetchTiktok(call: Call, d0: string, d1: string): Promise<Rec[]> {
  const w = 'tiktok quyết toán';
  const [t0, t1] = vnBounds(d0, d1);
  const stmts = new Map<string, string>();
  await ttPages(
    call,
    TT_STATEMENTS,
    { statement_time_ge: t0, statement_time_lt: t1, sort_field: 'statement_time' },
    w,
    (d) => {
      for (const s of list(d, 'statements', w)) {
        const sid = s.id;
        if (typeof sid !== 'string' || !SID_RE.test(sid)) {
          throw new DataError(`${w}: statement id sai dạng`);
        }
        vndCurrency(s, w);
        const day = vnDateTs(s.statement_time, 'statement_time', w);
        if (!stmts.has(sid)) stmts.set(sid, day);
      }
    },
  );
  const recs: Rec[] = [];
  const seen = new Map<string, Rec>();
  for (const [sid, day] of stmts) {
    await ttPages(
      call,
      TT_STATEMENT_TX,
      { sort_field: 'order_create_time' },
      w,
      (d) => {
        vndCurrency(d, w);
        for (const t of list(d, 'transactions', w)) {
          const tid = id(t.id, 'id', w);
          const typ = str(t.type, 'type', w, 64);
          if (typ === null) throw new DataError(`${w}: giao dịch thiếu 'type'`);
          const ids: Record<string, string | null> = {};
          for (const f of TT_ORDER_FIELDS) ids[f] = str(t[f], f, w, 64);
          const rec: Rec = {
            order: null,
            type: typ,
            settled_on: day,
            ids,
            comps: flatten(t, w, TT_IDENTITY),
          };
          const prev = seen.get(tid);
          if (prev === undefined) {
            seen.set(tid, rec);
            recs.push(rec);
          } else if (!sameRec(prev, rec)) {
            throw new DataError(
              `${w}: cùng 1 giao dịch xuất hiện 2 lần với nội dung KHÁC nhau — không tự chọn`,
            );
          }
        }
      },
      { statement_id: sid },
    );
  }
  return recs;
}

function status(dec: Decision): string {
  if (dec === null) return 'CHƯA CHỐT';
  if (dec.bo_qua) return 'bỏ qua';
  if (Object.hasOwn(dec, 'ma_don')) return `ghi dòng, mã đơn từ ${pyStr(dec.ma_don)}`;
  return (
    `cột ${pyStr(dec.cot)} (${dec.dau === 1 ? '+' : '−'})` +
    (dec.khi_vang === 'bang_0' ? '; vắng = 0' : '')
  );
}

export type ApiRow = {
  order_id_hash: string;
  txn_type: string | null;
  settled_on: string | null;
  row_no: number;
} & Record<MoneyKey, number | null>;

const cpCmp = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
};

/**
 * `to_rows` → [rows chuẩn settlement_rows, BLOCKED (cần quyết định), lỗi dữ liệu, {tên thành phần/loại:
 * trạng thái}]. rows chỉ dùng khi 2 danh sách rỗng; cột = null (độc) khi một thành phần ánh xạ vào nó
 * vắng/sai kiểu/sai đơn vị → `write` từ chối dòng có null.
 */
export function toRows(
  channel: string,
  recs: readonly Rec[],
  cfg: ApiCfg,
): [ApiRow[], string[], string[], Map<string, string>] {
  const tp = cfg.thanh_phan;
  const lg = cfg.loai_giao_dich;
  const blocked: string[] = [];
  const errs: string[] = [];
  const st = new Map<string, string>();
  const keyed = new Map<string, [string, string | null, ApiRow]>();
  const units = new Set<string>();
  for (const r of recs) {
    let txnType: string | null = null;
    let oid: string | null;
    if (channel === 'tiktok') {
      const typ = r.type as string;
      const known = Object.hasOwn(lg, typ);
      const dec = known ? (lg[typ] ?? null) : null;
      st.set(`loại ${typ}`, known ? status(dec) : 'LẠ — chưa có trong ánh xạ');
      if (dec === null) {
        blocked.push(`loại giao dịch '${clean(typ, 64)}' ${known ? 'chưa chốt' : 'LẠ'}`);
        continue;
      }
      if (dec.bo_qua) continue;
      oid = r.ids?.[dec.ma_don as string] ?? null;
      if (!oid) {
        errs.push(`giao dịch loại '${clean(typ, 64)}' thiếu ${pyStr(dec.ma_don)}`);
        continue;
      }
      txnType = (dec.txn_type as string | null | undefined) ?? null;
    } else {
      oid = r.order;
      const cur = r.cur ?? {};
      const parts = SP_CURRENCY.filter((k) => Object.hasOwn(cur, k)).map(
        (k) => `${k}=${clean(pyStrV(cur[k]), 8)}`,
      );
      units.add(
        parts.join(', ') || `không có mã → tien_te_shop=${pyStr(cfg.tien_te_shop ?? null)}`,
      );
    }
    const sums = Object.fromEntries(COLS.map((c) => [c, 0])) as Record<MoneyKey, number | null>;
    const comps = r.comps;
    for (const [name, v] of comps) {
      if (!Object.hasOwn(tp, name)) {
        if (moneyLike(channel, v)) {
          st.set(name, 'LẠ — chưa có trong ánh xạ');
          blocked.push(`thành phần '${clean(name, 80)}' LẠ`);
        }
        continue; // chuỗi/null không ánh xạ: không phải tiền
      }
      const dec = tp[name] ?? null;
      st.set(name, status(dec));
      if (dec === null) {
        if (moneyLike(channel, v)) blocked.push(`thành phần '${clean(name, 80)}' chưa chốt`);
      } else if (dec.bo_qua) {
        // bỏ qua
      } else if (v === LIST) {
        blocked.push(`thành phần '${clean(name, 80)}' là danh sách — chỉ được bo_qua`);
      }
    }
    for (const [name, dec] of Object.entries(tp)) {
      if (!(isDict(dec) && Object.hasOwn(dec, 'cot'))) continue;
      const col = dec.cot as MoneyKey;
      const v = comps.get(name);
      const nm = clean(name, 80);
      if (v === LIST) {
        sums[col] = null; // đã chặn ở trên
        continue;
      }
      if (absent(channel, v)) {
        if (!st.has(name)) st.set(name, `${status(dec)} — VẮNG trong dữ liệu`);
        if (dec.khi_vang === 'bang_0') continue;
        errs.push(
          `thành phần '${nm}' (cột ${col}) thiếu/null — không coi là 0 (khi_vang chưa quyết)`,
        );
        sums[col] = null;
        continue;
      }
      let n: number | null;
      try {
        n = apiVnd(v, name, 'quyết toán');
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        n = null;
      }
      if (n === null) {
        errs.push(`thành phần '${nm}' (cột ${col}) sai kiểu — không phải số nguyên VND`);
        sums[col] = null;
        continue;
      }
      if (channel === 'shopee') {
        const c = spCurrency(name, r.cur ?? null, cfg.tien_te_shop ?? null);
        if (c === null || c === undefined) {
          const k = name.endsWith('_pri') ? 'primary' : 'affiliate';
          const why =
            r.cur && Object.keys(r.cur).length
              ? `response có mã tiền nhưng thiếu/null mã tiền ${k}`
              : 'response không có mã; tien_te_shop chưa xác nhận';
          blocked.push(`thành phần '${nm}': không xác định được đơn vị tiền (${why})`);
          sums[col] = null;
          continue;
        }
        if (c !== 'VND') {
          errs.push(
            `thành phần '${nm}': đơn vị tiền '${clean(pyStrV(c), 8)}' không phải VND — sổ chỉ ` +
              'nhận VND, không quy đổi tỷ giá',
          );
          sums[col] = null;
          continue;
        }
      }
      const cur = sums[col];
      if (cur !== null) sums[col] = cur + (dec.dau as number) * n;
    }
    const h = orderHash(channel, oid as string);
    const key = txnType === null ? `${h}|N` : `${h}|S${txnType}`;
    if (keyed.has(key)) {
      blocked.push(
        '≥2 giao dịch cùng đơn + cùng txn_type trong 1 lượt — ' +
          'cần nhãn txn_type riêng theo loại (Kế toán)',
      );
      continue;
    }
    if (
      (['order_amount', 'refund'] as const).some((c) => sums[c] !== null && (sums[c] as number) < 0)
    ) {
      errs.push('cột order_amount/refund âm sau ánh xạ (1 dòng)');
    }
    if (Object.values(sums).some((x) => x !== null && Math.abs(x) > MONEY_CAP)) {
      errs.push('số tiền vượt trần sau ánh xạ (1 dòng)');
    }
    for (const c of COLS) if (sums[c] === 0) sums[c] = 0; // -0 → 0
    keyed.set(key, [
      h,
      txnType,
      { order_id_hash: h, txn_type: txnType, settled_on: r.settled_on, row_no: 0, ...sums },
    ]);
  }
  if (units.size) st.set('(đơn vị tiền)', pySorted(units).join('; '));
  const rows = [...keyed.values()]
    .sort((a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1] ?? '', b[1] ?? ''))
    .map((x) => x[2]);
  rows.forEach((row, i) => {
    row.row_no = i + 2; // row_no ≥ 2 như file (dòng 1 = header)
  });
  return [rows, pySorted(new Set(blocked)), pySorted(new Set(errs)), st];
}

/** Python `json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`. */
function compactJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map(compactJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${pySorted(Object.keys(o))
    .map((k) => `${JSON.stringify(k)}:${compactJson(o[k])}`)
    .join(',')}}`;
}

/** sha256 NỘI DUNG dòng chuẩn hóa (không theo cửa sổ/tên/request id) — cùng dữ liệu = cùng sha. */
export function rowsSha(channel: string, kind: string, rows: readonly ApiRow[]): string {
  const blob = compactJson({
    channel,
    source_kind: kind,
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'row_no'))),
  });
  return createHash('sha256').update(blob, 'utf8').digest('hex');
}

/**
 * `check_rows` (chốt cuối trước ghi): mọi cột tiền là số nguyên hợp lệ — null (thành phần vắng/sai
 * kiểu/sai đơn vị ở `toRows`), không phải số, vượt trần → lỗi; hash đơn/ngày/txn_type đúng dạng.
 * Lỗi chỉ nêu dòng + tên cột. Ngày biểu diễn bằng chuỗi 'YYYY-MM-DD' (Python: `date`) → kiểm dạng.
 */
export function checkRows(rows: readonly Record<string, unknown>[]): string[] {
  const errs: string[] = [];
  rows.forEach((r, idx) => {
    const i = idx + 1;
    for (const c of COLS) {
      const v = r[c];
      if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > MONEY_CAP) {
        errs.push(`dòng ${i}: cột ${c} thiếu/không phải số nguyên VND`);
      }
    }
    if (
      (['order_amount', 'refund'] as const).some(
        (c) => typeof r[c] === 'number' && Number.isInteger(r[c]) && (r[c] as number) < 0,
      )
    ) {
      errs.push(`dòng ${i}: cột order_amount/refund âm`);
    }
    if (!(typeof r.order_id_hash === 'string' && HASH_RE.test(r.order_id_hash))) {
      errs.push(`dòng ${i}: order_id_hash sai dạng`);
    }
    const so = r.settled_on;
    if (so !== null && so !== undefined && !(typeof so === 'string' && parseDay(so) !== null)) {
      errs.push(`dòng ${i}: settled_on sai kiểu`);
    }
    const t = r.txn_type;
    if (
      t !== null &&
      t !== undefined &&
      !(typeof t === 'string' && cpLen(t) > 0 && cpLen(t) <= TXN_TYPE_MAX)
    ) {
      errs.push(`dòng ${i}: txn_type sai dạng`);
    }
  });
  return errs;
}

// ---------------------------------------------------------------- CLI (qua market-api)

/** `--from/--to` → [d0, d1] | lỗi (≤ MAX_DAYS ngày, d1 ≥ d0). */
export function parseWindow(sFrom: string, sTo: string): [string, string] | string {
  const d0 = fromIsoDate(sFrom);
  const d1 = fromIsoDate(sTo);
  if (d0 === null || d1 === null) return '--from/--to phải là YYYY-MM-DD';
  if (d1 < d0 || daysBetween(d0, d1) + 1 > MAX_DAYS) {
    return `--to ≥ --from và tối đa ${MAX_DAYS} ngày`;
  }
  return [d0, d1];
}

export type ApiDeps = {
  env?: Env;
  io?: Io;
  mapFile?: string;
  feesFile?: string;
  /** Python `auth.bind_service('loader')` — mặc định `servicePool`. */
  service?: (svc: Service, env: Env) => Promise<pg.Pool>;
};

export type Precheck =
  | { cfg: ApiCfg; fees: Fees | null; kind: string; rc: null }
  | { cfg: null; fees: null; kind: null; rc: number };

/**
 * TRƯỚC mọi request (lệnh market-api gọi trước cổng triển khai/refresh): bảng ánh xạ hỏng → exit 1;
 * chưa chốt → `[blocked]` exit 2; nguồn không phải API thật → exit 2 (trừ --dry-run); biểu phí hỏng → 1.
 */
export function precheck(
  channel: string,
  base: string,
  dryRun: boolean,
  d: ApiDeps = {},
): Precheck {
  const io = d.io ?? STD_IO;
  const path = d.mapFile ?? MAP_FILE;
  let loaded: { cfg: ApiCfg; why: string[] };
  try {
    loaded = loadMap(channel, path);
  } catch (e) {
    if (!(e instanceof MapError)) throw e;
    io.out(`[err] bảng ánh xạ quyết toán: ${e.message} — 0 request.`);
    return { cfg: null, fees: null, kind: null, rc: 1 };
  }
  const kind = sourceKind(channel, base, d.env);
  if (dryRun) return { cfg: loaded.cfg, fees: null, kind, rc: null };
  if (loaded.why.length) {
    io.out(
      `[blocked] ${channel}: bảng ánh xạ quyết toán CHƯA dùng được để ghi ` +
        `sổ — ${loaded.why.join('; ')} (${basename(path)}, Kế toán chốt). 0 ` +
        'request, 0 dòng. Xem dữ liệu: thêm --dry-run.',
    );
    return { cfg: null, fees: null, kind: null, rc: 2 };
  }
  if (kind !== 'api_live') {
    io.out(
      `[blocked] ${channel}: nguồn ${kind} — chỉ API THẬT được ghi sổ quyết ` +
        'toán; sandbox/server giả chạy --dry-run. 0 request.',
    );
    return { cfg: null, fees: null, kind: null, rc: 2 };
  }
  const [fees, fwhy] = d.feesFile ? loadFees(d.feesFile) : loadFees();
  if (fees === null) {
    io.out(`[err] ${fwhy} — 0 request.`);
    return { cfg: null, fees: null, kind: null, rc: 1 };
  }
  return { cfg: loaded.cfg, fees, kind, rc: null };
}

export type RunOpts = { channel: string; window: [string, string]; dryRun: boolean };

/** Kéo + chuẩn hóa + (dry-run báo trạng thái | ghi sổ). `call` = request đã ký của lệnh market-api. */
export async function run(
  o: RunOpts,
  call: Call,
  cfg: ApiCfg,
  fees: Fees | null,
  kind: string,
  d: ApiDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const [d0, d1] = o.window;
  let recs: Rec[];
  try {
    recs = await (o.channel === 'shopee' ? fetchShopee : fetchTiktok)(call, d0, d1);
  } catch (e) {
    if (!isFetchError(e)) throw e;
    io.out(`[err] ${e.message} — không connect, không nạp gì.`);
    return 1;
  }
  const [rows, blocked, errs, st] = toRows(o.channel, recs, cfg);
  let why: string[] = [];
  if (o.dryRun) {
    why = loadMap(o.channel, d.mapFile ?? MAP_FILE).why;
    io.out(
      `[dry-run] ${o.channel}: ${recs.length} giao dịch → ${rows.length} dòng ` +
        `quyết toán (nguồn ${kind}) — KHÔNG ghi sổ, không kết nối DB.`,
    );
    io.out(`  bảng ánh xạ: ${why.length ? `CHƯA CHỐT — ${why.join('; ')}` : 'đã chốt'}`);
    io.out(`  thành phần/loại có trong dữ liệu (${st.size}):`);
    for (const name of pySorted(st.keys()).slice(0, MAX_SHOW)) {
      io.out(`    - ${clean(name, 90)}: ${st.get(name)}`);
    }
    if (st.size > MAX_SHOW) io.out(`    ... còn ${st.size - MAX_SHOW}`);
  }
  for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
  for (const b of blocked.slice(0, MAX_PRINT_ERRS)) io.out(`[blocked] ${b}`);
  if (errs.length) {
    io.out('[err] dữ liệu sàn không nạp được — 0 dòng.');
    return 1;
  }
  if (blocked.length) {
    io.out('[blocked] cần quyết định của Kế toán trong bảng ánh xạ — 0 dòng.');
    return 2;
  }
  if (o.dryRun) return why.length ? 2 : 0;
  if (!rows.length) {
    io.out(`[warn] ${o.channel}: 0 dòng quyết toán trong cửa sổ — không nạp gì.`);
    return 0;
  }
  return write(o.channel, rows, kind, fees as Fees, d0, d1, d);
}

/** Ghi sổ (CHỈ api_live): khóa (kênh, đơn) → đã nạp? → nguồn khác (CSV) → load + reconcile → commit. */
export async function write(
  channel: string,
  rows: readonly ApiRow[],
  kind: string,
  fees: Fees,
  d0: string,
  d1: string,
  d: ApiDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const bad = checkRows(rows as readonly Record<string, unknown>[]);
  if (bad.length) {
    for (const e of bad.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
    io.out('[err] dòng quyết toán không hợp lệ — không connect, 0 dòng.');
    return 1;
  }
  let pool: pg.Pool;
  try {
    pool = await (d.service ?? servicePool)('loader', env);
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    // Python bind_service: chế độ thực → từ chối (exit 2); dev thiếu biến → "thiếu DATABASE_URL" (1).
    if (approvalEnforced(env)) {
      io.out(`[err] ${e.message}`);
      return 2;
    }
    io.out('[err] thiếu DATABASE_URL');
    return 1;
  }
  const sha = rowsSha(channel, kind, rows);
  const fname = `api-${channel}-quyet-toan-${d0.replaceAll('-', '')}-${d1.replaceAll('-', '')}`;
  let c: pg.PoolClient;
  try {
    c = await pool.connect();
  } catch (e) {
    await pool.end().catch(() => {});
    io.out(`[err] không kết nối được Postgres: ${connErrName(e)}`);
    return 1;
  }
  let counts: Record<string, number> = {};
  let rc = 0;
  let ov: { trung: number; lech: number } | undefined;
  try {
    await c.query('begin');
    const hashes = new Set(rows.map((r) => r.order_id_hash));
    try {
      // r15-fix1 F1: khóa (kênh, đơn) TRƯỚC kiểm đã nạp/nguồn khác/INSERT
      await lockOrders(c, channel, hashes);
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      await c.query('rollback');
      io.out(`[err] ${e.message} — 0 dòng.`);
      return 1;
    }
    if (
      (await c.query('select 1 from settlement_rows where file_sha256 = $1 limit 1', [sha])).rows
        .length
    ) {
      await c.query('rollback'); // nhả khóa
      io.out('[skip] dữ liệu quyết toán không đổi (đã nạp) — không ghi gì.');
      return 0;
    }
    const n = await crossSource(c, channel, hashes, kind);
    if (n) {
      await c.query('rollback');
      io.out(
        `[blocked] ${n} đơn đã có dòng quyết toán từ NGUỒN KHÁC (file ` +
          'CSV) — không ghi chồng; người đối soát quyết. 0 dòng.',
      );
      return 2;
    }
    await load(c, rows, channel, fname, sha, kind);
    try {
      counts = await reconcile(c, fees, sha);
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      io.out(`[blocked] ${e.message} — nạp dòng quyết toán, KHÔNG đối soát.`);
      counts = {};
      rc = EXIT_BLOCKED; // như settlement-csv
    }
    ov = (await overlaps(c, [channel]))[channel];
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (!isDbError(e)) throw e;
    if (pgErrName(e) === 'UniqueViolation') {
      if (((e as pg.DatabaseError).constraint ?? '').includes('file_sha256')) {
        io.out('[skip] dữ liệu vừa được nạp song song — không ghi gì.');
        return 0;
      }
      io.out(`[err] lỗi DB, đã rollback: ${pgErrName(e)}`);
      return 1;
    }
    io.out(`[err] lỗi DB, đã rollback — 0 dòng: ${pgErrName(e)}`);
    return 1;
  } finally {
    // như Python conn.close(): giao dịch chưa commit (nhánh --report / trả sớm) bị hủy
    await c.query('rollback').catch(() => {});
    c.release();
    await pool.end().catch(() => {});
  }
  io.out(
    `[load] quyết toán ${channel} ${fname} (nguồn ${kind}): ${rows.length} dòng;` +
      ` đối chiếu: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
  );
  if (ov) {
    io.out(
      `[warn] khoản xuất lại ở ≥2 lần nạp: trùng ${ov.trung}, lệch ` +
        `${ov.lech} — lệch giữ cả hai, chờ người đối soát.`,
    );
  }
  io.out('[done]');
  return rc;
}
