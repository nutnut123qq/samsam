import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Env } from '../env.js';
import { dataPath } from '../paths.js';
import { dmy, parseDay, pyRepr, utcMs, vnDate, vnFormat } from './period.js';
import { isPlainObject, isPrintable, type JsonFileError, readJson } from './py.js';

// Port `pipelines/freeze.py` — lịch đóng băng mùa cao điểm + break-glass (luật đóng băng chung,
// áp cho deploy F17.1 và bật lại agent F17.5). Hàm thuần: chỉ đọc lịch `data/freeze_calendar.json`
// + log break-glass (`BREAK_GLASS_LOG`), không ghi, không DB. Thời gian luôn là tham số.
// Lịch hỏng → FAIL-CLOSED: coi như đang đóng băng, chỉ hotfix/disable/restore, KHÔNG xét break-glass.

export const CALENDAR = dataPath('freeze_calendar.json');
export const FALLBACK_ALLOWED = ['hotfix', 'disable', 'restore'];
export const DEFAULT_BG_MAX_HOURS = 4;
export const OUTSIDE_FREEZE = 'ngoài khung đóng băng';
const ALLOWED_TEXT = 'chỉ hotfix/tắt agent/khôi phục';
const HOUR_MS = 3600_000;

export class FreezeConfigError extends Error {}

export type FreezeWindow = { name: string; start: string; end: string };
export type Calendar = {
  windows: FreezeWindow[];
  known_kinds: string[];
  allowed_in_freeze: string[];
  break_glass_max_hours: number;
  break_glass_holders: string[];
};
export type BgOpen = {
  action: 'open';
  opened_at: Date;
  expires_at: Date;
  by: string;
  reason: unknown;
  holder_verified: boolean;
};
export type BgClose = { action: 'close'; ts: Date; by: string; reason: unknown };
export type BgRecord = BgOpen | BgClose;

function day(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FreezeConfigError(`${field} phải dạng YYYY-MM-DD`);
  }
  if (parseDay(value) === null) throw new FreezeConfigError(`${field} không phải ngày hợp lệ`);
  return value;
}

function strList(cal: Record<string, unknown>, key: string, allowEmpty: boolean): string[] {
  const v = cal[key];
  if (
    !Array.isArray(v) ||
    (v.length === 0 && !allowEmpty) ||
    !v.every((x) => typeof x === 'string' && x.trim() !== '')
  ) {
    throw new FreezeConfigError(`'${key}' phải là list chuỗi${allowEmpty ? '' : ' không rỗng'}`);
  }
  return [...v];
}

/** Kiểm cấu trúc lịch → bản chuẩn hóa (idempotent). */
export function validateCalendar(cal: unknown): Calendar {
  if (!isPlainObject(cal)) throw new FreezeConfigError('lịch không phải object JSON');
  const wins = cal.windows;
  if (!Array.isArray(wins) || wins.length === 0) {
    throw new FreezeConfigError("'windows' thiếu hoặc rỗng");
  }
  const windows = wins.map((w, i) => {
    if (!isPlainObject(w) || typeof w.name !== 'string') {
      throw new FreezeConfigError(`windows[${i}] thiếu name`);
    }
    const start = day(w.start, `windows[${i}].start`);
    const end = day(w.end, `windows[${i}].end`);
    if (start > end) throw new FreezeConfigError(`windows[${i}] start > end`);
    return { name: w.name, start, end };
  });
  const known = strList(cal, 'known_kinds', false);
  const allowed = strList(cal, 'allowed_in_freeze', false);
  const stray = [...new Set(allowed.filter((k) => !known.includes(k)))].sort();
  if (stray.length) {
    throw new FreezeConfigError(
      `allowed_in_freeze có kind lạ: [${stray.map((s) => pyRepr(s)).join(', ')}]`,
    );
  }
  const holders = strList(cal, 'break_glass_holders', true);
  const hours = cal.break_glass_max_hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || !(hours > 0 && hours <= 24)) {
    throw new FreezeConfigError('break_glass_max_hours phải trong (0, 24]');
  }
  return {
    windows,
    known_kinds: known,
    allowed_in_freeze: allowed,
    break_glass_max_hours: hours,
    break_glass_holders: holders,
  };
}

export function loadCalendar(path: string = CALENDAR): Calendar {
  let cal: unknown;
  try {
    cal = readJson(path);
  } catch (e) {
    const t = (e as JsonFileError).pyType;
    if (t === 'FileNotFoundError')
      throw new FreezeConfigError(`không có file lịch ${basename(path)}`);
    throw new FreezeConfigError(`lịch ${basename(path)} hỏng: ${t}`);
  }
  return validateCalendar(cal);
}

function aware(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now phải là datetime có múi giờ');
  }
  return now;
}

function vnDay(when: unknown): string {
  try {
    return vnDate(when as string | Date);
  } catch {
    throw new TypeError('when phải là date hoặc datetime có múi giờ');
  }
}

export function frozenWindow(when: string | Date, calendar?: unknown): FreezeWindow | null {
  const d = vnDay(when);
  const cal =
    calendar !== undefined && calendar !== null ? validateCalendar(calendar) : loadCalendar();
  return cal.windows.find((w) => w.start <= d && d <= w.end) ?? null;
}

export function isFrozen(when: string | Date, calendar?: unknown): boolean {
  return frozenWindow(when, calendar) !== null;
}

// ---------- break-glass (reader; ghi ở scripts/break_glass.py) ----------

// KHÁC Python có chủ đích: `datetime.fromisoformat` nhận thêm dạng cơ bản (20261225T140000+0700) và
// mọi ký tự phân cách — TS chỉ nhận dạng mở rộng với 'T'/' ' → record lạ bị BỎ (chỉ GIẢM quyền).
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)$/;

/** ISO 8601 CÓ múi giờ → Date; không múi giờ / sai → null. */
export function parseAwareIso(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s = '0', frac = '', tz] = m.slice(1) as string[];
  if (parseDay(`${y}-${mo}-${d}`) === null || +h! > 23 || +mi! > 59 || +s > 59) return null;
  let off = 0;
  if (tz !== 'Z') {
    const t = (tz as string).replaceAll(':', '');
    const oh = +t.slice(1, 3);
    const om = +(t.slice(3, 5) || 0);
    const os = +(t.slice(5, 7) || 0);
    if (oh > 23 || om > 59 || os > 59) return null;
    off = (t[0] === '-' ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
  }
  const ms = Math.floor(+`0.${frac || '0'}` * 1000);
  return new Date(utcMs(+y!, +mo! - 1, +d!, +h!, +mi!, +s, ms) - off);
}

function parseRecord(obj: unknown): BgRecord | null {
  if (!isPlainObject(obj)) return null;
  const by = obj.by;
  // `by` không in được (ký tự điều khiển/ANSI — log sửa tay) → bỏ record: chỉ GIẢM quyền.
  if (typeof by !== 'string' || by.trim() === '' || !isPrintable(by)) return null;
  if (obj.action === 'open') {
    const opened = parseAwareIso(obj.opened_at);
    const expires = parseAwareIso(obj.expires_at);
    if (opened === null || expires === null) return null;
    return {
      action: 'open',
      opened_at: opened,
      expires_at: expires,
      by,
      reason: obj.reason ?? null,
      holder_verified: obj.holder_verified === true,
    };
  }
  if (obj.action === 'close') {
    const ts = parseAwareIso(obj.ts);
    if (ts === null) return null;
    return { action: 'close', ts, by, reason: obj.reason ?? null };
  }
  return null;
}

/** Record hợp lệ trong log (thứ tự file). `bad` nhận số dòng bị bỏ. File không có → []. */
export function parseBreakGlass(raw: Uint8Array, bad?: number[]): BgRecord[] {
  const out: BgRecord[] = [];
  const buf = Buffer.from(raw);
  let n = 0;
  let start = 0;
  while (start <= buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    n++;
    const line = buf.subarray(start, end);
    start = end + 1;
    // Python `bytes.strip()` = khoảng trắng ASCII.
    if (line.toString('latin1').replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '') === '') continue;
    let rec: BgRecord | null = null;
    try {
      // decode("utf-8", "replace"): byte lỗi → U+FFFD; BOM giữ lại (json.loads coi là hỏng).
      rec = parseRecord(JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(line)));
    } catch {
      rec = null;
    }
    if (rec === null) {
      bad?.push(n);
      continue;
    }
    out.push(rec);
  }
  return out;
}

export function loadBreakGlass(path: string | undefined, bad?: number[]): BgRecord[] {
  if (!path) return [];
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
  return parseBreakGlass(raw, bad);
}

/** Mọi cửa sổ còn hiệu lực tại `now` (expires đã cắt theo max_hours), hết hạn sớm trước. */
export function activeWindows(
  records: BgRecord[],
  now: Date,
  maxHours: number = DEFAULT_BG_MAX_HOURS,
): BgOpen[] {
  const t = aware(now).getTime();
  const closes = records.flatMap((r) => (r.action === 'close' ? [r.ts.getTime()] : []));
  const out: BgOpen[] = [];
  for (const r of records) {
    if (r.action !== 'open') continue;
    const opened = r.opened_at.getTime();
    const expires = Math.min(r.expires_at.getTime(), opened + maxHours * HOUR_MS);
    if (!(opened <= t && t < expires)) continue;
    if (closes.some((c) => opened <= c && c <= t)) continue;
    out.push({ ...r, expires_at: new Date(expires) });
  }
  return out.sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime());
}

export function activeBreakGlass(
  records: BgRecord[],
  now: Date,
  maxHours: number = DEFAULT_BG_MAX_HOURS,
): BgOpen | null {
  const w = activeWindows(records, now, maxHours);
  return w.at(-1) ?? null;
}

// ---------- quyết định ----------

/** [cho_phép, lý do] cho 1 thay đổi loại `changeKind` tại `now`. Kind lạ → RangeError. */
export function check(
  changeKind: string,
  now: Date,
  calendar?: unknown,
  windows?: BgRecord[],
  env: Env = process.env,
): [boolean, string] {
  const t = aware(now);
  let cal: Calendar;
  try {
    cal = calendar !== undefined && calendar !== null ? validateCalendar(calendar) : loadCalendar();
  } catch (e) {
    if (!(e instanceof FreezeConfigError)) throw e;
    if (FALLBACK_ALLOWED.includes(changeKind)) {
      return [
        true,
        `lịch đóng băng lỗi (${e.message}) — fail-closed, '${changeKind}' vẫn được phép`,
      ];
    }
    return [
      false,
      `lịch đóng băng lỗi (${e.message}) — fail-closed, coi như đang đóng băng: ${ALLOWED_TEXT}`,
    ];
  }
  if (!cal.known_kinds.includes(changeKind)) {
    throw new RangeError(
      `loại thay đổi lạ '${changeKind}' — dùng một trong [${cal.known_kinds.map((k) => pyRepr(k)).join(', ')}]`,
    );
  }
  const w = frozenWindow(t, cal);
  if (w === null) return [true, OUTSIDE_FREEZE];
  const span = `${dmy(w.start)}–${dmy(w.end)} (${w.name})`;
  if (cal.allowed_in_freeze.includes(changeKind)) {
    return [true, `đang đóng băng ${span} — '${changeKind}' được phép`];
  }
  const recs = windows ?? loadBreakGlass(env.BREAK_GLASS_LOG);
  const bg = activeBreakGlass(recs, t, cal.break_glass_max_hours);
  if (bg !== null) {
    const who = bg.holder_verified ? '' : ' (người CHƯA xác minh)';
    return [
      true,
      `đang đóng băng ${span} — BREAK-GLASS mở bởi ${bg.by}${who} tới ${vnFormat(bg.expires_at, '%H:%M %d/%m/%Y')}`,
    ];
  }
  return [false, `đang đóng băng ${span}: ${ALLOWED_TEXT} — '${changeKind}' bị chặn`];
}
