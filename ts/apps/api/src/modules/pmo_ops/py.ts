import { readFileSync } from 'node:fs';
import { addDays, parseDay, VN_OFFSET_MS, weekday } from '@samsam/core/ops/period';
import { fromIsoformat, type PyDateTime, toDate } from '@samsam/core/ops/py-date';
import { pyOsName } from '@samsam/core/ops/py-json';
import { S } from '@samsam/core/security/py';

// Tiện ích khớp ngữ nghĩa Python cho nhóm pmo_ops — chỉ thứ core chưa có (`fromIsoformat`/`isoDate`/
// `pyFixed`/`pyOsName` lấy từ core ops/py-*).
export { isoDate } from '@samsam/core/ops/py-date';
export { pyFixed } from '@samsam/core/ops/py-json';
export { pyOsName };

const DAY_MS = 86_400_000;

/** Python `\S` (không phải str.isspace()). */
export const NON_WS = `[^${S}]`;

/** Python `(a - b).days` cho hai ngày 'YYYY-MM-DD'. */
export function dayDiff(a: string, b: string): number {
  return ((parseDay(a) as number) - (parseDay(b) as number)) / DAY_MS;
}

/** Python `date.isocalendar()` → [năm ISO, tuần ISO]. */
export function isoWeek(day: string): [number, number] {
  const thu = addDays(day, 3 - weekday(day)); // thứ Năm cùng tuần quyết định năm ISO
  const y = thu.slice(0, 4);
  return [Number(y), Math.floor(dayDiff(thu, `${y}-01-01`) / 7) + 1];
}

/** Python `datetime.fromisoformat(s)` → {date, aware} | null (C 3.12). shortcut: micro giây lẻ bị cắt
 * về mili giây (Date của JS) — chỉ ảnh hưởng thứ tự trong cùng 1 ms. */
export function fromIso(s: string): { date: Date; aware: boolean } | null {
  const dt: PyDateTime | null = fromIsoformat(s);
  if (dt === null) return null;
  return { date: toDate(dt), aware: dt.offUs !== null };
}

/** Python `dt.isoformat()` cho mốc UTC (giây chẵn → không phần lẻ) — `fact_sha`. */
export function isoUtc(d: Date): string {
  const s = d.toISOString();
  const ms = d.getUTCMilliseconds();
  return `${s.slice(0, 19)}${ms ? `.${String(ms).padStart(3, '0')}000` : ''}+00:00`;
}

/** 00:00 giờ VN của ngày → Date (Python `datetime.replace` trên mốc VN). */
export function vnAt(day: string): Date {
  return new Date((parseDay(day) as number) - VN_OFFSET_MS);
}

/** Lỗi đọc file mang tên loại lỗi Python (`type(e).__name__`). */
export class PyFileError extends Error {
  constructor(readonly pyType: string) {
    super(pyType);
  }
}

/** Python `Path(p).read_bytes().decode("utf-8")` (strict, giữ BOM) → chữ | PyFileError. */
export function readUtf8(path: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new PyFileError(pyOsName(e));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new PyFileError('UnicodeDecodeError');
  }
}

/** Python `json.loads(text)` → giá trị | PyFileError('JSONDecodeError'). KHÁC Python có chủ đích:
 * NaN/Infinity bị từ chối (chặt hơn = fail-closed). */
export function jsonLoads(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PyFileError('JSONDecodeError');
  }
}

/** Python `json.loads(bytes)`: dò mã hóa theo BOM/byte 0 (utf-8, utf-8-sig, utf-16). shortcut:
 * utf-32 (TextDecoder không hỗ trợ) → UnicodeDecodeError (chặt hơn). */
export function decodeJsonBytes(raw: Uint8Array): string {
  const b = raw;
  const startsWith = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  let enc = 'utf-8';
  let skip = 0;
  if (startsWith(0x00, 0x00, 0xfe, 0xff) || startsWith(0xff, 0xfe, 0x00, 0x00)) {
    throw new PyFileError('UnicodeDecodeError');
  }
  if (startsWith(0xfe, 0xff)) [enc, skip] = ['utf-16be', 2];
  else if (startsWith(0xff, 0xfe)) [enc, skip] = ['utf-16le', 2];
  else if (startsWith(0xef, 0xbb, 0xbf)) skip = 3;
  else if (b.length >= 4) {
    if (!b[0]) {
      if (!b[1]) throw new PyFileError('UnicodeDecodeError');
      enc = 'utf-16be';
    } else if (!b[1]) {
      if (!(b[2] || b[3])) throw new PyFileError('UnicodeDecodeError');
      enc = 'utf-16le';
    }
  } else if (b.length === 2) {
    if (!b[0]) enc = 'utf-16be';
    else if (!b[1]) enc = 'utf-16le';
  }
  try {
    return new TextDecoder(enc, { fatal: true, ignoreBOM: true }).decode(b.subarray(skip));
  } catch {
    throw new PyFileError('UnicodeDecodeError');
  }
}

/** Python `type(e).__name__` cho lỗi không phải lỗi DB (thông điệp không lộ chi tiết). */
export function errName(e: unknown): string {
  if (e instanceof PyFileError) return e.pyType;
  const n = (e as Error)?.name;
  return typeof n === 'string' && n ? n : 'Exception';
}
