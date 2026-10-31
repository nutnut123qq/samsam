import { basename } from 'node:path';
import {
  cpCmp,
  isDict,
  isPyInt,
  PyReadError,
  parsePyJson,
  readUtf8Sig,
} from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyStrip } from '@samsam/core/security/py';

// Port `agents/sales_watch.py` (v14.4 p4) — đọc + kiểm cấu hình `data/sales_watch.json` (GIẢ ĐỊNH,
// chờ GĐ bán hàng chốt) dùng chung cho sales-04.1 (`ingest.crm --owner` + mục `lead_followup` của
// sales_director), sales-05 (`kd_quote --followups`), sales-06.1 (`ingest.dealer_price` +
// `kd_price --dealer-watch`), sales-06.2 (`kd_orders --watch`).
// THUẦN (không DB/mạng). Fail-closed: file thiếu/hỏng/sai kiểu → RangeError (Python ValueError) nêu
// khóa lỗi (caller exit 1 TRƯỚC khi connect), không bao giờ "cấu hình rỗng = cho qua". Khóa lạ →
// lỗi (gõ nhầm tên khóa không âm thầm rơi về mặc định).

export const WATCH_FILE = dataPath('sales_watch.json');
export const STAFF_RE = /^[A-Z0-9_-]{2,20}$/;
export const CHANNEL_RE = /^[a-z0-9_]{2,20}$/;
type Range = [number, number] | null;
export const SECTIONS: Record<string, Record<string, Range>> = {
  lead_owner: {
    assign_within_business_hours: [1, 72],
    handle_within_business_hours: [1, 72],
    lookback_days: [1, 365],
    max_per_run: [1, 1000],
    staff_codes: null,
  },
  quote_followup: { after_business_hours: [1, 720], max_reminders: [1, 10] },
  dealer_price: { channels: null, lookback_days: [1, 365], max_rows: [1, 50000] },
  order_watch: {
    min_orders: [1, 100000],
    baseline_weeks: [1, 26],
    check_weeks: [1, 12],
    cancel_rate_max_pct: [1, 100],
    return_rate_max_pct: [1, 100],
    spike_ratio: [1, 20],
    return_status: null,
  },
};
const TOP = new Set(['_doc', 'status', 'confirmed_by', ...Object.keys(SECTIONS)]);

export type LeadOwner = {
  assign_within_business_hours: number;
  handle_within_business_hours: number;
  lookback_days: number;
  max_per_run: number;
  staff_codes: string[];
};
export type WatchDoc = Record<string, unknown> & { lead_owner: LeadOwner };

const cpSort = (xs: string[]) => [...xs].sort(cpCmp);
const pyList = (xs: string[]) => `[${xs.map(pyRepr).join(', ')}]`;
const intIn = (v: unknown, [lo, hi]: [number, number]) => isPyInt(v) && lo <= v && v <= hi;

/** Python `_str_list`: list chuỗi không rỗng, không khoảng trắng đầu/cuối, không trùng. */
function strList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === 'string' && pyStrip(x) !== '' && x === pyStrip(x)) &&
    new Set(v).size === v.length
  );
}

/** → doc | RangeError (thông điệp nêu khóa, không nêu giá trị). */
export function validate(doc: unknown): WatchDoc {
  if (!isDict(doc)) throw new RangeError('sales_watch.json phải là object JSON');
  const stray = cpSort(Object.keys(doc).filter((k) => !TOP.has(k)));
  if (stray.length) throw new RangeError(`sales_watch.json: khóa lạ ${pyList(stray)}`);
  if (typeof doc.status !== 'string' || !pyStrip(doc.status)) {
    throw new RangeError("sales_watch.json: thiếu 'status'");
  }
  const cb = Object.hasOwn(doc, 'confirmed_by') ? doc.confirmed_by : '';
  if (!(cb === null || (typeof cb === 'string' && pyStrip(cb)))) {
    throw new RangeError("sales_watch.json: 'confirmed_by' phải null hoặc tên người chốt");
  }
  for (const [sec, keys] of Object.entries(SECTIONS)) {
    const s = doc[sec];
    const want = Object.keys(keys);
    if (
      !isDict(s) ||
      Object.keys(s).length !== want.length ||
      !want.every((k) => Object.hasOwn(s, k))
    ) {
      throw new RangeError(
        `sales_watch.json: '${sec}' phải có đúng các khóa ${pyList(cpSort(want))}`,
      );
    }
    for (const [k, rng] of Object.entries(keys)) {
      if (rng !== null && !intIn(s[k], rng)) {
        throw new RangeError(`sales_watch.json: ${sec}.${k} phải số nguyên ${rng[0]}..${rng[1]}`);
      }
    }
  }
  const sec = (name: string) => doc[name] as Record<string, unknown>;
  const codes = sec('lead_owner').staff_codes;
  if (!strList(codes) || !codes.every((c) => STAFF_RE.test(c))) {
    throw new RangeError(
      'sales_watch.json: lead_owner.staff_codes phải list mã [A-Z0-9_-]{2,20} không trùng (KHÔNG ghi tên)',
    );
  }
  const ch = sec('dealer_price').channels;
  if (!strList(ch) || !ch.length || !ch.every((c) => CHANNEL_RE.test(c))) {
    throw new RangeError(
      'sales_watch.json: dealer_price.channels phải list mã kênh [a-z0-9_]{2,20} không trùng, không rỗng',
    );
  }
  const rs = sec('order_watch').return_status;
  if (
    !isDict(rs) ||
    !Object.keys(rs).length ||
    !Object.entries(rs).every(([k, v]) => CHANNEL_RE.test(k) && strList(v) && v.length > 0)
  ) {
    throw new RangeError(
      'sales_watch.json: order_watch.return_status phải {kênh: [trạng thái hoàn/trả]} không rỗng',
    );
  }
  return doc as WatchDoc;
}

export function load(path: string = WATCH_FILE): WatchDoc {
  let doc: unknown;
  try {
    doc = parsePyJson(readUtf8Sig(path));
  } catch (e) {
    const t = e instanceof PyReadError ? e.pyType : 'JSONDecodeError';
    throw new RangeError(`không đọc được ${basename(path)} (${t})`);
  }
  return validate(doc);
}

export function section<K extends string>(name: K, path?: string): Record<string, unknown> {
  return load(path)[name] as Record<string, unknown>;
}
