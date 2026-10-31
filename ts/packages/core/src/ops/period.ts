// Port `pipelines/period.py` — kỳ báo cáo theo giờ Việt Nam (nguồn DUY NHẤT cắt kỳ ngày/tuần/tháng
// cho báo cáo + bản tin GĐ khối) và giờ làm việc VN cho SLA.
//
// Biểu diễn: ngày VN = chuỗi 'YYYY-MM-DD' (Python `date`); mốc thời gian = `Date` (luôn là một
// thời điểm tuyệt đối — JS không có datetime "naive", nên nhánh ValueError naive của Python không
// tồn tại; chuỗi không phải ngày → lỗi như kiểu sai).
// VN = UTC+7 cố định (không DST).

export const VN_OFFSET_MS = 7 * 3600_000;
export const KINDS = ['day', 'week', 'month'] as const;
export type Kind = (typeof KINDS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `Date.UTC` nhưng năm 0–99 KHÔNG bị đổi thành 1900+ (Python date/datetime nhận năm 1..9999):
 * dời 400 năm (= 146097 ngày, chu kỳ lịch Gregory) rồi trừ lại — giữ nguyên cách tràn giờ/ngày. */
export function utcMs(y: number, mo0: number, d = 1, h = 0, mi = 0, s = 0, ms = 0): number {
  return y >= 0 && y < 100
    ? Date.UTC(y + 400, mo0, d, h, mi, s, ms) - 146_097 * DAY_MS
    : Date.UTC(y, mo0, d, h, mi, s, ms);
}

/** 'YYYY-MM-DD' hợp lệ (lịch Gregory, như `date.fromisoformat` dạng 10 ký tự) → ms UTC 00:00. */
export function parseDay(s: string): number | null {
  if (!DAY_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = utcMs(y, m - 1, d);
  const back = new Date(t);
  if (
    y < 1 ||
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  )
    return null;
  return t;
}

function dayStr(utcMidnightMs: number): string {
  return new Date(utcMidnightMs).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = parseDay(day);
  if (t === null) throw new RangeError(`ngày '${day}' không hợp lệ`);
  return dayStr(t + n * DAY_MS);
}

/** 0 = thứ Hai … 6 = Chủ nhật (Python `weekday()`). */
export function weekday(day: string): number {
  const t = parseDay(day);
  if (t === null) throw new RangeError(`ngày '${day}' không hợp lệ`);
  return (new Date(t).getUTCDay() + 6) % 7;
}

/** 00:00 giờ VN của ngày `day`. */
export function vnMidnight(day: string): Date {
  const t = parseDay(day);
  if (t === null) throw new RangeError(`ngày '${day}' không hợp lệ`);
  return new Date(t - VN_OFFSET_MS);
}

function isDate(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** Ngày VN của `ref` (ngày giữ nguyên; Date đổi sang +07). */
export function vnDate(ref: string | Date): string {
  if (isDate(ref)) return dayStr(Math.floor((ref.getTime() + VN_OFFSET_MS) / DAY_MS) * DAY_MS);
  if (typeof ref === 'string' && parseDay(ref) !== null) return ref;
  throw new TypeError('ref phải là date hoặc datetime có múi giờ');
}

/** strftime tối thiểu theo giờ VN: %Y %m %d %H %M %S %%. */
export function vnFormat(d: Date, fmt: string): string {
  const v = new Date(d.getTime() + VN_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const map: Record<string, string> = {
    Y: p(v.getUTCFullYear(), 4),
    m: p(v.getUTCMonth() + 1),
    d: p(v.getUTCDate()),
    H: p(v.getUTCHours()),
    M: p(v.getUTCMinutes()),
    S: p(v.getUTCSeconds()),
    '%': '%',
  };
  return fmt.replace(/%([YmdHMS%])/g, (_, k: string) => map[k] as string);
}

/** Ngày 'YYYY-MM-DD' → 'DD/MM/YYYY'. */
export function dmy(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function periodBounds(kind: string, ref: string | Date): [Date, Date] {
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(`kind '${kind}' lạ — dùng một trong ('day', 'week', 'month')`);
  }
  const d = vnDate(ref);
  let start: string;
  let end: string;
  if (kind === 'day') {
    start = d;
    end = addDays(d, 1);
  } else if (kind === 'week') {
    start = addDays(d, -weekday(d));
    end = addDays(start, 7);
  } else {
    const [y, m] = d.split('-').map(Number) as [number, number];
    start = `${d.slice(0, 7)}-01`;
    end = m === 12 ? `${p4(y + 1)}-01-01` : `${p4(y)}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return [vnMidnight(start), vnMidnight(end)];
}

function p4(y: number): string {
  return String(y).padStart(4, '0');
}

/** Kỳ trượt N ngày: until ngày → hết ngày đó giờ VN (exclusive); undefined → now; Date giữ nguyên. */
export function rollingBounds(days: number, until?: string | Date | null): [Date, Date] {
  let end: Date;
  if (until === undefined || until === null) end = new Date();
  else if (isDate(until)) end = until;
  else if (typeof until === 'string' && parseDay(until) !== null)
    end = vnMidnight(addDays(until, 1));
  else throw new TypeError('until phải là date, datetime có múi giờ hoặc None');
  return [new Date(end.getTime() - days * DAY_MS), end];
}

// ---------------------------------------------------------------------------
// v5.0 W50.1 — giờ làm việc VN cho SLA handoff (WP07). Ngoài ca đồng hồ SLA DỪNG, bắt đầu lại từ
// đầu ca kế tiếp. shift = {"start": "HH:MM", "end": "HH:MM", "workdays": [0..6],
// "holidays": ["YYYY-MM-DD", ...]} (0 = thứ Hai). Không hỗ trợ ca qua đêm. Vòng quét ngày có trần
// MAX_SCAN_DAYS — lịch mà mọi ngày đều nghỉ → lỗi, không lặp vô hạn.
// ---------------------------------------------------------------------------

export const MAX_SCAN_DAYS = 400;
export const MAX_HOLIDAYS = 366;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type Shift = {
  startMin: number;
  endMin: number;
  workdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
};

function hhmm(v: unknown, key: string): number {
  const m = typeof v === 'string' ? HHMM_RE.exec(v) : null;
  if (!m) throw new RangeError(`ca làm việc: '${key}' phải dạng HH:MM (00:00–23:59)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function isShift(v: unknown): v is Shift {
  return typeof v === 'object' && v !== null && 'startMin' in v;
}

/** Kiểm + chuẩn hóa ca. Sai → RangeError (Python ValueError). Ca đã chuẩn hóa → trả nguyên. */
export function parseShift(cfg: unknown): Shift {
  if (isShift(cfg)) return cfg;
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
    throw new RangeError('ca làm việc phải là object JSON');
  }
  const c = cfg as Record<string, unknown>;
  const start = hhmm(c.start, 'start');
  const end = hhmm(c.end, 'end');
  if (end <= start) {
    throw new RangeError("ca làm việc: 'end' phải sau 'start' cùng ngày (không hỗ trợ ca qua đêm)");
  }
  const wd = c.workdays;
  if (
    !Array.isArray(wd) ||
    wd.length === 0 ||
    !wd.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6) ||
    new Set(wd).size !== wd.length
  ) {
    throw new RangeError(
      "ca làm việc: 'workdays' phải là list ≥1 số 0..6 không trùng (0 = thứ Hai)",
    );
  }
  const hol = c.holidays === undefined ? [] : c.holidays;
  if (!Array.isArray(hol) || hol.length > MAX_HOLIDAYS) {
    throw new RangeError(`ca làm việc: 'holidays' phải là list ≤ ${MAX_HOLIDAYS} ngày`);
  }
  const days = new Set<string>();
  for (const h of hol) {
    if (typeof h !== 'string' || parseDay(h) === null) {
      throw new RangeError(`ca làm việc: ngày nghỉ ${pyRepr(h)} sai định dạng YYYY-MM-DD`);
    }
    days.add(h);
  }
  return { startMin: start, endMin: end, workdays: new Set(wd as number[]), holidays: days };
}

/** `repr()` của Python cho giá trị JSON đơn giản (thông điệp lỗi). */
export function pyRepr(v: unknown): string {
  if (typeof v === 'string') return `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

function aware(ts: unknown, name: string): Date {
  if (!isDate(ts)) throw new TypeError(`${name} phải là datetime có múi giờ`);
  return ts;
}

function window(day: string, s: Shift): [number, number] | null {
  if (!s.workdays.has(weekday(day)) || s.holidays.has(day)) return null;
  const base = vnMidnight(day).getTime();
  return [base + s.startMin * 60_000, base + s.endMin * 60_000];
}

/** `start` + N giờ LÀM VIỆC (start ngoài ca → đếm từ đầu ca kế tiếp). */
export function businessDeadline(start: Date, hours: number, shift: unknown): Date {
  const s = parseShift(shift);
  const cur = aware(start, 'start').getTime();
  if (typeof hours !== 'number' || !(hours >= 0)) throw new RangeError('hours phải là số ≥ 0');
  // Python timedelta làm tròn tới micro giây.
  let left = Math.round(hours * 3600e6) / 1000;
  let d = vnDate(start);
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const w = window(d, s);
    if (w !== null) {
      const begin = Math.max(cur, w[0]);
      if (begin < w[1]) {
        if (left <= w[1] - begin) return new Date(begin + left);
        left -= w[1] - begin;
      }
    }
    d = addDays(d, 1);
  }
  throw new RangeError(
    `không tìm được giờ làm việc trong ${MAX_SCAN_DAYS} ngày — kiểm tra workdays/holidays`,
  );
}

/** Số phút làm việc trong [a, b) (b <= a → 0). */
export function businessMinutes(a: Date, b: Date, shift: unknown): number {
  const s = parseShift(shift);
  const ta = aware(a, 'a').getTime();
  const tb = aware(b, 'b').getTime();
  if (tb <= ta) return 0;
  let total = 0;
  const last = vnDate(b);
  for (let d = vnDate(a); d <= last; d = addDays(d, 1)) {
    const w = window(d, s);
    if (w !== null) {
      const lo = Math.max(ta, w[0]);
      const hi = Math.min(tb, w[1]);
      if (hi > lo) total += hi - lo;
    }
  }
  return Math.floor(total / 60_000);
}
