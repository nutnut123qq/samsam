import { cpCmp } from '@samsam/core/ops/py-json';

// Tiện ích khớp ngữ nghĩa Python cho nhóm loaders (chỉ thứ core chưa có — PyFloat/pyLoads/isoDate/
// cpCmp ở core ops/py-*).

/** Tên kiểu Python của giá trị JSON (`type(v).__name__`) — cho thông điệp lỗi giống Python. */
export function pyType(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** Python `json.dumps(v, ensure_ascii=False, sort_keys=…)` (dấu phân cách `, ` `: `) cho giá trị JSON
 * thuần (số nguyên/chuỗi/bool/null — số thực in như JS). */
export function pyDumps(v: unknown, sortKeys = true): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyDumps(x, sortKeys)).join(', ')}]`;
  const o = v as Record<string, unknown>;
  const ks = Object.keys(o);
  if (sortKeys) ks.sort(cpCmp);
  return `{${ks.map((k) => `${JSON.stringify(k)}: ${pyDumps(o[k], sortKeys)}`).join(', ')}}`;
}

/** Python `datetime.isoformat()` của timestamptz psycopg đọc ra, từ dạng text Postgres (DateStyle ISO:
 * `2026-10-29 03:04:05.12+07`) → `2026-10-29T03:04:05.120000+07:00` (micro giây chỉ khi ≠ 0). */
export function pgTsToIso(s: string): string {
  const m =
    /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?([+-]\d\d)(?::(\d\d))?(?::(\d\d))?$/.exec(
      s,
    );
  if (!m) return s.replace(' ', 'T');
  const frac = m[3] && Number(m[3]) !== 0 ? `.${m[3].padEnd(6, '0')}` : '';
  return `${m[1]}T${m[2]}${frac}${m[4]}:${m[5] ?? '00'}${m[6] ? `:${m[6]}` : ''}`;
}
