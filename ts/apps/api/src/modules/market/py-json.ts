import { cpCmp, PyFloat, pyFloatStr } from '@samsam/core/ops/py-json';

// JSON kiểu Python cho nhóm market: `json.dumps` (dấu phân cách / sort_keys / ensure_ascii) và
// `json.loads` phân biệt int / float / int lớn (luật `isinstance(v, int)` của connector API sàn).

type DumpOpts = { sep?: [string, string]; sortKeys?: boolean; ascii?: boolean };

/**
 * Python `json.dumps(v, separators=sep, sort_keys=…, ensure_ascii=…)` cho giá trị JSON (+ `PyFloat`,
 * bigint). Mặc định gọn `(",", ":")`, không sort, không ascii. `ensure_ascii` thoát mọi ký tự ngoài
 * ' '..'~' (kể cả DEL) dạng `\uXXXX` chữ thường như Python.
 */
export function pyJson(v: unknown, o: DumpOpts = {}): string {
  const [item, kv] = o.sep ?? [',', ':'];
  const s = (x: string) => {
    const j = JSON.stringify(x);
    return o.ascii
      ? j.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      : j;
  };
  const go = (x: unknown): string => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'string') return s(x);
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number') return Number.isFinite(x) ? String(x) : pyFloatStr(x);
    if (x instanceof PyFloat) {
      const r = pyFloatStr(x.v);
      return r === 'nan' ? 'NaN' : r === 'inf' ? 'Infinity' : r === '-inf' ? '-Infinity' : r;
    }
    if (Array.isArray(x)) return `[${x.map(go).join(item)}]`;
    const ks = Object.keys(x as object);
    if (o.sortKeys) ks.sort(cpCmp);
    return `{${ks.map((k) => `${s(k)}${kv}${go((x as Record<string, unknown>)[k])}`).join(item)}}`;
  };
  return go(v);
}

type Ctx = { source?: string } | undefined;

/**
 * Python `json.loads` → giá trị JS: số viết dạng thực (`.`/`e`) → `PyFloat`; số nguyên ngoài vùng an
 * toàn của JS → bigint (giữ đủ chữ số như int Python). Lỗi cú pháp → ném SyntaxError. KHÁC Python:
 * NaN/Infinity bị từ chối (chặt hơn = fail-closed).
 */
export function parsePy(text: string): unknown {
  const reviver = (_k: string, v: unknown, ctx: Ctx) => {
    if (typeof v !== 'number' || ctx?.source === undefined) return v;
    if (/[.eE]/.test(ctx.source)) return new PyFloat(v);
    return Number.isSafeInteger(v) ? v : BigInt(ctx.source);
  };
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/** Python `isinstance(v, int) and not isinstance(v, bool)` cho giá trị đọc bằng `parsePy`. */
export const isPyInt = (v: unknown): v is number | bigint =>
  (typeof v === 'number' && Number.isInteger(v)) || typeof v === 'bigint';

/** Python `bool(v)` cho giá trị đọc bằng `parsePy` (0.0 / 0n là sai). */
export function truthy(v: unknown): boolean {
  if (v instanceof PyFloat) return v.v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python `str(v)` cho giá trị tham số query (`urlencode`/chữ ký TikTok). */
export function pyQueryStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof PyFloat) return pyFloatStr(v.v);
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  return pyJson(v, { sep: [', ', ': '] });
}
