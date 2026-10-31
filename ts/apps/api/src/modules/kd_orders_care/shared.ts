import type { Db } from '@samsam/core/ops/deps';
import { isPrintable, JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp, PyFloat } from '@samsam/core/ops/py-json';
import { verifyPublish } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyStrip } from '@samsam/core/security/py';

// Phần TỐI THIỂU của module Python khác mà 3 agent nhóm này dùng (chưa có bản TS ở core):
// `ingest.market_csv._clean/load_mapping`, `ingest.crm.can_contact/commission_rate` + hằng,
// `agents.mkt_koc.KIT_TYPES/MAX_DRAFTS/load_drafts`, `pipelines.mkt_calendar.CONTENT_OK`,
// `ingest.settlement_csv.round_half_up`. shortcut: bản sao hẹp, khi nhóm crm/market_csv/mkt_koc có
// bản TS thì import từ đó và xóa ở đây.

export { cpCmp };
export const MARKET_MAP_FILE = dataPath('market_csv_map.json');

/** `market_csv._clean`: bỏ ký tự điều khiển (escape terminal) → '?', cắt `n` code point. */
export function clean(s: unknown, n = 120): string {
  let out = '';
  let i = 0;
  for (const c of String(s)) {
    if (i++ >= n) break;
    out += isPrintable(c) ? c : '?';
  }
  return out;
}

/** `market_csv.load_mapping` → [mapping | null, lý do]. */
export function loadMarketMapping(
  path: string = MARKET_MAP_FILE,
): [Record<string, unknown> | null, string | null] {
  try {
    return [readJson(path) as Record<string, unknown>, null];
  } catch (e) {
    const t = e instanceof JsonFileError ? e.pyType : 'OSError';
    const name = path.split(/[\\/]/).pop();
    return [null, `không đọc được mapping ${name}: ${t}`];
  }
}

/** `unicodedata.normalize("NFC", str(s)).strip()`. */
export const nfc = (s: unknown): string => pyStrip(String(s).normalize('NFC'));

// ------------------------------------------------------------ crm (đồng ý + hoa hồng)
export const PURPOSES = ['cskh', 'marketing', 'dai_ly', 'b2b'];
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol']; // khớp sku_master.category
export const MAX_BY_LEN = 100;
export const DEALER_CODE_RE = /^[A-Z0-9_-]{2,20}$/;

/** `crm.can_contact`: true CHỈ khi dòng đồng ý mới nhất của (khách, mục đích, đại lý) là granted.
 * Chưa có dòng / `dai_ly` không đích danh → false. DB lỗi → ném (caller quyết). */
export async function canContact(
  db: Db,
  contactId: number | string | bigint,
  purpose: string,
  dealerCode: string | null = null,
): Promise<boolean> {
  if (!PURPOSES.includes(purpose)) throw new RangeError(`purpose phải là ${PURPOSES.join('|')}`);
  if (purpose === 'dai_ly' && !dealerCode) return false;
  const { rows } = await db.query(
    "select granted from v_consent_current where contact_id = $1 and purpose = $2 and coalesce(recipient_dealer, '') = $3",
    [String(contactId), purpose, dealerCode || ''],
  );
  return rows[0]?.granted === true;
}

export type Dealer = Record<string, unknown> & { status?: unknown; commission_default?: unknown };

/** Python `str(Decimal(str(v or 0)))` cho `commission_default` (numeric từ pg là chuỗi). */
function decStr(v: unknown): string {
  if (v instanceof PyFloat) v = v.v;
  if (v === null || v === undefined || v === '' || v === false) return '0';
  const s = String(v);
  if (!/^\d+(?:\.\d+)?$/.test(s)) throw new RangeError(`commission_default không hợp lệ: ${s}`);
  return Number(s) === 0 ? '0' : s; // Decimal('0.00') là falsy → `or 0` → '0'
}

/** `crm.commission_rate` → % dạng chuỗi Decimal. Rượu online = 0; nhóm lạ/None = 0 (fail-closed);
 * đại lý không active = 0. */
export function commissionRate(dealer: Dealer, category: unknown, online: boolean): string {
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return '0';
  if (category === 'alcohol' && online) return '0';
  if ((Object.hasOwn(dealer, 'status') ? dealer.status : 'active') !== 'active') return '0';
  return decStr(dealer.commission_default);
}

/** `round_half_up(Decimal(amount) * rate / 100)` — số học nguyên chính xác (amount ≥ 0). */
export function commissionOf(amount: bigint, rate: string): bigint {
  const [i, f = ''] = rate.split('.');
  const num = BigInt(`${i}${f}`);
  const den = 100n * 10n ** BigInt(f.length);
  return (2n * amount * num + den) / (2n * den);
}

// ------------------------------------------------------------ mkt_koc / mkt_calendar
export const KIT_TYPES = ['post', 'ads', 'koc', 'image'];
export const MAX_DRAFTS = 5;
export const CONTENT_OK = ['TP_THUONG', 'QC_DAY_DU'];

export type Draft = {
  id: number | string;
  status: unknown;
  sku?: unknown;
  content_type?: unknown;
  text?: unknown;
  is_ai?: unknown;
  guardrail?: unknown;
  verified?: unknown;
};

/** `mkt_koc.load_drafts`: draft theo thứ tự id yêu cầu; không có → status `khong_ton_tai`;
 * `verified` = bản đang lưu khớp bản đã duyệt (`verify_publish`). */
export async function loadDrafts(db: Db, ids: bigint[]): Promise<Draft[]> {
  const { rows } = await db.query(
    'select id::text as id, status, sku, content_type, text, is_ai, guardrail from content_drafts where id = any($1::bigint[])',
    [ids.map(String)],
  );
  const by = new Map(rows.map((r) => [String(r.id), r]));
  const out: Draft[] = [];
  for (const i of ids) {
    const r = by.get(String(i));
    if (r === undefined) {
      out.push({ id: Number(i), status: 'khong_ton_tai' });
      continue;
    }
    out.push({
      id: Number(i),
      status: r.status,
      sku: r.sku,
      content_type: r.content_type,
      text: r.text,
      is_ai: r.is_ai,
      guardrail: r.guardrail,
      verified: await verifyPublish(db, i, r.text as string),
    });
  }
  return out;
}

// ------------------------------------------------------------ tiện ích Python
/** Python `repr` của list chuỗi/None (`sorted(..., key=str)` đã sắp sẵn). */
export const pyListRepr = (xs: (string | null)[]): string =>
  `[${xs.map((x) => (x === null ? 'None' : pyRepr(x))).join(', ')}]`;

/** Python `f"{n:,}".replace(",", ".")`. */
export function groupDots(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return neg ? `-${s}` : s;
}

/** Python `str(v)` của bigint/number (ô CSV, thông điệp). */
export const big = (v: unknown): bigint =>
  typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
