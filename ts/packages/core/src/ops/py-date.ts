import { isDigit, pySplit, S } from '../security/py.js';
import { addDays, parseDay } from './period.js';

// Port `email.utils.parsedate_to_datetime` + `datetime.fromisoformat` + `date.fromisoformat` (bản C
// của Python 3.12.7) — dùng chung (`crawler.intel.parse_date`, mốc ngày cấu hình, sao lưu). Giờ "naive" → giờ VN (+07:00). Kết quả giữ đủ trường như datetime
// Python (micro giây, offset) để so golden bằng `pyStr`; ghi DB qua `toDate` (Date chỉ tới mili giây
// — shortcut: micro giây lẻ bị cắt khi lưu `published_at`, chỉ ảnh hưởng thứ tự trong cùng 1 ms).

export type PyDateTime = {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  us: number;
  /** offset so với UTC, micro giây; null = naive */
  offUs: number | null;
};

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TZ: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  AST: -400,
  ADT: -300,
  EST: -500,
  EDT: -400,
  CST: -600,
  CDT: -500,
  MST: -700,
  MDT: -600,
  PST: -800,
  PDT: -700,
};
const DAY_US = 86_400_000_000;

const INT_RE = new RegExp(`^[${S}]*([+-]?)(\\p{Nd}+(?:_\\p{Nd}+)*)[${S}]*$`, 'u');
const ND = /\p{Nd}/u;

/** Python `int(str)`: khoảng trắng hai đầu, dấu, chữ số Unicode (Nd), '_' giữa các chữ số. */
export function pyIntStr(s: string): bigint | null {
  const m = INT_RE.exec(s);
  if (!m) return null;
  let n = 0n;
  for (const ch of (m[2] as string).replace(/_/g, '')) {
    // Unicode bảo đảm chữ số Nd nằm thành dãy liền 10 mã (0..9) → giá trị = khoảng cách tới đầu dãy mod 10.
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (ND.test(String.fromCodePoint(start - 1))) start--;
    n = n * 10n + BigInt((cp - start) % 10);
  }
  return m[1] === '-' ? -n : n;
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Python `datetime(...)` + `timezone(...)`: ngoài miền → null (ValueError/OverflowError). */
function make(
  y: bigint,
  mo: bigint,
  d: bigint,
  h: bigint,
  mi: bigint,
  s: bigint,
  us: bigint,
  offUs: bigint | null,
): PyDateTime | null {
  if (offUs !== null && !(offUs > -BigInt(DAY_US) && offUs < BigInt(DAY_US))) return null;
  if (y < 1n || y > 9999n || mo < 1n || mo > 12n) return null;
  if (d < 1n || d > BigInt(daysInMonth(Number(y), Number(mo)))) return null;
  if (h < 0n || h > 23n || mi < 0n || mi > 59n || s < 0n || s > 59n || us < 0n || us > 999999n) {
    return null;
  }
  return {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h),
    mi: Number(mi),
    s: Number(s),
    us: Number(us),
    offUs: offUs === null ? null : Number(offUs),
  };
}

const lastChar = (s: string) => s.slice(-1);

/** `email._parseaddr._parsedate_tz` → [y, m, d, H, M, S, tz giây | null] hoặc null. */
function parsedateTz(
  input: string,
): [bigint, number, bigint, bigint, bigint, bigint, bigint | null] | null {
  if (!input) return null;
  let data = pySplit(input);
  if (!data.length) return null;
  const d0 = data[0] as string;
  if (d0.endsWith(',') || DAYS.includes(d0.toLowerCase())) data.shift();
  else {
    const i = d0.lastIndexOf(',');
    if (i >= 0) data[0] = d0.slice(i + 1);
  }
  if (data.length === 3) {
    const stuff = (data[0] as string).split('-');
    if (stuff.length === 3) data = [...stuff, ...data.slice(1)];
  }
  if (data.length === 4) {
    const s = data[3] as string;
    let i = s.indexOf('+');
    if (i === -1) i = s.indexOf('-');
    if (i > 0) data = [...data.slice(0, 3), s.slice(0, i), s.slice(i)];
    else data.push('');
  }
  if (data.length < 5) return null;
  let [dd, mm, yy, tm, tz] = data.slice(0, 5) as [string, string, string, string, string];
  if (!(dd && mm && yy)) return null;
  mm = mm.toLowerCase();
  if (!MONTHS.includes(mm)) {
    [dd, mm] = [mm, dd.toLowerCase()];
    if (!MONTHS.includes(mm)) return null;
  }
  let month = MONTHS.indexOf(mm) + 1;
  if (month > 12) month -= 12;
  if (lastChar(dd) === ',') dd = dd.slice(0, -1);
  if (yy.indexOf(':') > 0) [yy, tm] = [tm, yy];
  if (lastChar(yy) === ',') {
    yy = yy.slice(0, -1);
    if (!yy) return null;
  }
  if (!isDigit([...yy][0] ?? '')) [yy, tz] = [tz, yy];
  if (lastChar(tm) === ',') tm = tm.slice(0, -1);
  let parts = tm.split(':');
  let thh: string;
  let tmm: string;
  let tss = '0';
  if (parts.length === 2) [thh, tmm] = parts as [string, string];
  else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
  else if (parts.length === 1 && (parts[0] as string).includes('.')) {
    parts = (parts[0] as string).split('.');
    if (parts.length === 2) [thh, tmm] = parts as [string, string];
    else if (parts.length === 3) [thh, tmm, tss] = parts as [string, string, string];
    else return null;
  } else return null;
  const nums = [yy, dd, thh, tmm, tss].map(pyIntStr);
  if (nums.some((x) => x === null)) return null;
  let [y, day, h, mi, sec] = nums as bigint[];
  if ((y as bigint) < 100n) y = (y as bigint) > 68n ? (y as bigint) + 1900n : (y as bigint) + 2000n;
  let off: bigint | null = null;
  const tzu = tz.toUpperCase();
  if (Object.hasOwn(TZ, tzu)) off = BigInt(TZ[tzu] as number);
  else {
    off = pyIntStr(tz);
    if (off === 0n && tz.startsWith('-')) off = null;
  }
  if (off) {
    const sign = off < 0n ? -1n : 1n;
    const a = off < 0n ? -off : off;
    off = sign * ((a / 100n) * 3600n + (a % 100n) * 60n);
  }
  return [y as bigint, month, day as bigint, h as bigint, mi as bigint, sec as bigint, off];
}

/** `email.utils.parsedate_to_datetime` → datetime hoặc null (Python ném lỗi). */
export function parsedateToDatetime(s: string): PyDateTime | null {
  const t = parsedateTz(s);
  if (!t) return null;
  const [y, mo, d, h, mi, sec, tz] = t;
  return make(y, BigInt(mo), d, h, mi, sec, 0n, tz === null ? null : tz * 1_000_000n);
}

// ---------------------------------------------------------------- fromisoformat (C 3.12)

const isAsciiDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

function digits(s: string, at: number, n: number): number | null {
  const part = s.slice(at, at + n);
  if (part.length !== n || ![...part].every((c) => isAsciiDigit(c))) return null;
  return Number(part);
}

function findSep(s: string): number {
  const len = s.length;
  if (len === 7) return 7;
  if (s[4] === '-') {
    if (s[5] === 'W') {
      if (len < 8) return -1;
      if (len > 8 && s[8] === '-') {
        if (len === 9) return -1;
        if (len > 10 && isAsciiDigit(s[10])) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (s[4] === 'W') {
    let idx = 7;
    while (idx < len && isAsciiDigit(s[idx])) idx++;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

function ordinal(y: number, m: number, d: number): number {
  const y1 = y - 1;
  let days = y1 * 365 + Math.floor(y1 / 4) - Math.floor(y1 / 100) + Math.floor(y1 / 400);
  for (let k = 1; k < m; k++) days += daysInMonth(y, k);
  return days + d;
}

function isoToYmd(y: number, week: number, day: number): [number, number, number] | null {
  if (y < 1 || y > 9999) return null;
  if (!(week > 0 && week < 53)) {
    const first = ordinal(y, 1, 1) % 7;
    if (!(week === 53 && (first === 4 || (first === 3 && isLeap(y))))) return null;
  }
  if (!(day > 0 && day < 8)) return null;
  const firstWd = (ordinal(y, 1, 1) + 6) % 7;
  let monday = ordinal(y, 1, 1) - firstWd;
  if (firstWd > 3) monday += 7;
  let ord = monday + (week - 1) * 7 + (day - 1);
  // ordinal → y/m/d
  let yy = 1;
  while (ordinal(yy + 400, 1, 1) <= ord) yy += 400;
  while (ordinal(yy + 1, 1, 1) <= ord) yy++;
  ord -= ordinal(yy, 1, 1) - 1;
  let mm = 1;
  while (ord > daysInMonth(yy, mm)) ord -= daysInMonth(yy, mm++);
  return [yy, mm, ord];
}

function parseDatePart(s: string, len: number): [number, number, number] | null {
  let p = 0;
  const y = digits(s, p, 4);
  if (y === null) return null;
  p += 4;
  const sep = s[p] === '-';
  if (sep) p++;
  if (s[p] === 'W') {
    p++;
    const w = digits(s, p, 2);
    if (w === null) return null;
    p += 2;
    let day = 1;
    if (p < len) {
      if (sep && s[p++] !== '-') return null;
      const dd = digits(s, p, 1);
      if (dd === null) return null;
      day = dd;
    }
    return isoToYmd(y, w, day);
  }
  const mo = digits(s, p, 2);
  if (mo === null) return null;
  p += 2;
  if (sep && s[p++] !== '-') return null;
  const d = digits(s, p, 2);
  if (d === null) return null;
  return [y, mo, d];
}

/** C `parse_hh_mm_ss_ff` trên s[a:b] (s[b] = ký tự kế tiếp hoặc '' khi hết chuỗi). */
function hhmmss(s: string, a: number, b: number): [number, number[]] {
  const vals = [0, 0, 0, 0];
  let p = a;
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const v = digits(s, p, 2);
    if (v === null) return [-3, vals];
    vals[i] = v;
    p += 2;
    const c = s[p] ?? '';
    p++;
    if (i === 0) hasSep = c === ':';
    if (p >= b) return [c !== '' ? 1 : 0, vals];
    if (hasSep && c === ':') continue;
    if (c === '.' || c === ',') break;
    if (!hasSep) p--;
    else return [-4, vals];
  }
  const remain = b - p;
  const toParse = Math.min(remain, 6);
  const us = digits(s, p, toParse);
  if (us === null) return [-3, vals];
  vals[3] = toParse > 0 ? us * 10 ** (6 - toParse) : 0;
  p += toParse;
  while (isAsciiDigit(s[p])) p++;
  return [p < s.length ? 1 : 0, vals];
}

/** `datetime.fromisoformat` (C 3.12) → datetime hoặc null. */
export function fromIsoformat(s: string): PyDateTime | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: bản C làm việc trên byte — ký tự ngoài ASCII không bao giờ hợp lệ
  if (s.length < 7 || !/^[\x00-\x7f]*$/.test(s) || s.includes('\0')) return null;
  const len = s.length;
  const sep = findSep(s);
  if (sep < 0) return null;
  const date = parseDatePart(s, sep);
  if (!date) return null;
  let tm = [0, 0, 0, 0];
  let off: bigint | null = null;
  if (len > sep) {
    const a = sep + 1;
    let tz = a;
    while (tz < len && !'Z+-'.includes(s[tz] as string)) tz++;
    const [rv, vals] = hhmmss(s, a, tz);
    if (rv < 0) return null;
    tm = vals;
    if (tz >= len) {
      if (rv === 1) return null;
    } else if (s[tz] === 'Z') {
      if (tz + 1 !== len) return null;
      off = 0n;
    } else {
      const sign = s[tz] === '-' ? -1n : 1n;
      const [rv2, z] = hhmmss(s, tz + 1, len);
      if (rv2 !== 0) return null;
      off =
        sign *
        (BigInt((z[0] as number) * 3600 + (z[1] as number) * 60 + (z[2] as number)) * 1_000_000n +
          BigInt(z[3] as number));
    }
  }
  const [y, mo, d] = date;
  return make(
    BigInt(y),
    BigInt(mo),
    BigInt(d),
    BigInt(tm[0] as number),
    BigInt(tm[1] as number),
    BigInt(tm[2] as number),
    BigInt(tm[3] as number),
    off,
  );
}

// ---------------------------------------------------------------- tiện ích

/** Giờ "naive" coi là giờ VN (+07:00), micro giây. */
export const VN_US = 7 * 3600 * 1_000_000;

/** Mốc UTC tính bằng micro giây kể từ 1970-01-01 (BigInt — năm 1..9999 vượt 2^53 µs). */
export function utcMicros(dt: PyDateTime): bigint {
  const days = BigInt(ordinal(dt.y, dt.mo, dt.d) - ordinal(1970, 1, 1));
  const secs = days * 86400n + BigInt(dt.h * 3600 + dt.mi * 60 + dt.s);
  return secs * 1_000_000n + BigInt(dt.us) - BigInt(dt.offUs ?? VN_US);
}

export function toDate(dt: PyDateTime): Date {
  return new Date(Number(utcMicros(dt) / 1000n));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Python `str(datetime)`. */
export function pyStr(dt: PyDateTime): string {
  let out = `${pad(dt.y, 4)}-${pad(dt.mo)}-${pad(dt.d)} ${pad(dt.h)}:${pad(dt.mi)}:${pad(dt.s)}`;
  if (dt.us) out += `.${pad(dt.us, 6)}`;
  if (dt.offUs !== null) {
    let o = dt.offUs;
    const sign = o < 0 ? '-' : '+';
    o = Math.abs(o);
    const us = o % 1_000_000;
    const tot = Math.floor(o / 1_000_000);
    out += `${sign}${pad(Math.floor(tot / 3600))}:${pad(Math.floor((tot % 3600) / 60))}`;
    if (tot % 60 || us) out += `:${pad(tot % 60)}`;
    if (us) out += `.${pad(us, 6)}`;
  }
  return out;
}

const ISO_YMD = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{4})(\d{2})(\d{2})$/;
const ISO_WEEK = /^(\d{4})-W(\d{2})(?:-(\d))?$|^(\d{4})W(\d{2})(\d)?$/;

/** Năm ISO có tuần 53: 1/1 là thứ Năm, hoặc năm nhuận mà 1/1 là thứ Tư. */
function hasWeek53(y: number): boolean {
  const jan1 = (new Date(Date.UTC(y, 0, 1)).getUTCDay() + 6) % 7; // 0 = thứ Hai
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return jan1 === 3 || (leap && jan1 === 2);
}

/** Python 3.12 `date.fromisoformat(s)` → 'YYYY-MM-DD' | null (YYYY-MM-DD, YYYYMMDD, YYYY-Www[-D],
 * YYYYWww[D]; chữ số ASCII). */
export function isoDate(s: string): string | null {
  let m = ISO_YMD.exec(s);
  if (m) {
    const d = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[4]}-${m[5]}-${m[6]}`;
    return parseDay(d) === null ? null : d;
  }
  m = ISO_WEEK.exec(s);
  if (!m) return null;
  const y = Number(m[1] ?? m[4]);
  const w = Number(m[2] ?? m[5]);
  const dow = Number(m[3] ?? m[6] ?? 1);
  if (y < 1 || w < 1 || w > (hasWeek53(y) ? 53 : 52) || dow < 1 || dow > 7) return null;
  // Thứ Hai tuần 1 = thứ Hai của tuần chứa ngày 4/1.
  const jan4 = `${String(y).padStart(4, '0')}-01-04`;
  const jan4Dow = (new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7;
  return addDays(jan4, -jan4Dow + (w - 1) * 7 + (dow - 1));
}

/** Python `dt.astimezone(utc).isoformat()` (micro giây chỉ khi ≠ 0). */
export function pyIsoUtc(d: Date): string {
  const s = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const ms = d.getUTCMilliseconds();
  return `${s.slice(0, 19)}${ms ? `.${String(ms).padStart(3, '0')}000` : ''}+00:00`;
}
