import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError, submit } from '@samsam/core/ops/director';
import { addDays, vnDate, vnMidnight } from '@samsam/core/ops/period';
import { csvRows } from '@samsam/core/ops/py-csv';
import { isoDate } from '@samsam/core/ops/py-date';
import { cpCmp, isPyInt, PyFloat, pyFloat, pyLoads, pyNum, reprV } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { pyStr, pyStrip } from '@samsam/core/security/py';
import { type DbLease, type Io, STD_IO } from '../garden_zalo/garden.js';
import { pyOsName } from '../garden_zalo/garden-media.js';
import {
  BlockedDomain,
  BudgetExhausted,
  type FetcherOpts,
  Fetcher as IntelFetcher,
  loadSources,
  type Resp,
  SOURCES_FILE,
  tierCHosts,
} from '../intel_crawl/intel.js';
import { logFlags } from './garden-director.js';

// Port `agents/vt_thoitiet.py` (v10.2 W102.4 — VT Agent Cảnh báo thời tiết & sâu bệnh, khối Vùng trồng).
//  - Cấu hình `data/weather_config.json` (GIẢ ĐỊNH — GĐ vùng trồng chốt ngưỡng + gán khoảnh→vùng):
//    tọa độ VÙNG làm tròn 0,1°; `loadConfig` fail-closed (ConfigError, exit 1).
//  - Nguồn dự báo: CSV nhập tay `area_code,day,rain_mm,tmin_c,tmax_c` (có lỗi → 0 xử lý, không
//    connect; lỗi in dòng+cột, KHÔNG in giá trị) hoặc `--fetch` CHỈ khi `fetch.enabled === true`
//    (mặc định false → exit 2): mỗi vùng 1 GET qua collector intel (robots, ≥1s/host, ngân sách, chặn
//    sàn/MXH/tầng C). Host nội bộ/IP trong url_template = lỗi cấu hình (chống SSRF).
//  - `evaluate`: mưa > ngưỡng → `mua_lon`; nhiệt thấp nhất < ngưỡng → `ret` (bằng ngưỡng KHÔNG báo).
//  - Sâu bệnh: `plot_logs` trong `flag_days` ngày → `logFlags(detail)` (CHỈ detail) → "cần đi kiểm tra".
//  - Digest TEMPLATE tất định: KHÔNG chẩn đoán/liều lượng/tọa độ/người ghi; qua guardrail.check ok
//    mới ghi file / đẩy hàng duyệt farming (`weather_digest`, `pest_alert` PENDING — GĐ duyệt = đã xem).
//    Agent không gửi/đăng gì, 0 LLM.
// KHÁC Python có chủ đích: url_template chỉ nhận {lat} {lon} {days} {{ }} (Python còn nhận định dạng
// `{lat:>8}`/`{lat!r}` khi đã có {lat}) — chặt hơn; host kiểm SSRF lấy bằng parser WHATWG (cùng
// parser với collector `intel_crawl` sẽ gửi request) nên `\@`, `0x7f.1`, `127.1`, `%31` cũng bị chặn
// (Python urlsplit nhận) — chặt hơn; `--date` = hết ngày VN tới 23:59:59.999 (JS Date chỉ tới ms,
// Python .999999) — nhật ký ghi trong khoảng dưới 1 ms cuối ngày lệch cửa sổ cờ.

export const CONFIG_FILE = dataPath('weather_config.json');
export const BLOCK = 'farming';
export const OBJECT_TYPE = 'weather_digest';
// Đợt hoàn thiện 22/10 (farming-05.4): cảnh báo SÂU BỆNH là đầu ra riêng, chỉ từ nhật ký vườn nội bộ.
export const PEST_OBJECT_TYPE = 'pest_alert';
export const CREATED_BY = 'agent:VT';
export const FETCH_SOURCE = 'vt_thoitiet';
export const CSV_HEADER = ['area_code', 'day', 'rain_mm', 'tmin_c', 'tmax_c'];
export const CSV_MAX = 1_000_000;
export const RAIN_RANGE: [number, number] = [0, 1000];
export const TEMP_RANGE: [number, number] = [-20, 50];
export const DEFAULT_MAX_REQ = 20;
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLOT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// Ký tự markdown/HTML trong mã khoảnh lấy từ DB → escape khi vào digest.
const MD_RE = /([\\`[\]<>!*_|])/g;
const LOCAL_SUFFIX = ['.localhost', '.local', '.internal', '.lan'];
export const KIND_TEXT: Record<string, string> = {
  mua_lon: 'kiểm tra thoát nước',
  ret: 'kiểm tra che chắn',
};
const DAY_MS = 86_400_000;

/** weather_config.json thiếu/hỏng — fail-closed. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}
/** Dữ liệu dự báo hỏng (JSON/mảng thiếu/độ dài lệch/giá trị lạ) — Python ValueError. */
export class SourceError extends RangeError {
  override name = 'SourceError';
}

export type Area = { code: string; name: string; lat: number; lon: number; plots: string[] };
export type WeatherConfig = {
  areas: Area[];
  thresholds: { rain_mm_day: number; tmin_c: number };
  fetch: { enabled: boolean; url_template: string; days: number };
  flag_days: number;
} & Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
const finite = (v: unknown): number | null => {
  const n = typeof v === 'boolean' ? null : pyNum(v);
  return n !== null && Number.isFinite(n) ? n : null;
};
const round01 = (v: number) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const inRange = (v: number | null, [lo, hi]: [number, number]) => v !== null && v >= lo && v <= hi;

/** Python `str.format(lat=, lon=, days=)` giới hạn ở {lat} {lon} {days} {{ }} → chuỗi | null (lạ). */
function formatTemplate(tpl: string, vals: Record<string, string>): string | null {
  let out = '';
  for (let i = 0; i < tpl.length; i++) {
    const c = tpl[i] as string;
    if (c === '{' && tpl[i + 1] === '{') {
      out += '{';
      i++;
    } else if (c === '}' && tpl[i + 1] === '}') {
      out += '}';
      i++;
    } else if (c === '{') {
      const j = tpl.indexOf('}', i);
      const name = j < 0 ? null : tpl.slice(i + 1, j);
      if (name === null || !Object.hasOwn(vals, name)) return null;
      out += vals[name];
      i = j;
    } else if (c === '}') return null;
    else out += c;
  }
  return out;
}

/** IP literal / localhost / hậu tố mạng nội bộ → true (chặn SSRF). */
export function internalHost(host: string): boolean {
  const h = host.replace(/^\.+|\.+$/g, '').toLowerCase();
  // h rỗng cũng không chứa '.' → true
  if (!h.includes('.') || h === 'localhost' || LOCAL_SUFFIX.some((s) => h.endsWith(s))) {
    return true;
  }
  return isIP(h) !== 0;
}

export const fmt1 = (v: number): string => {
  // Python f"{v:.1f}": nửa-chẵn khi ĐÚNG điểm giữa; JS toFixed lấy số lớn hơn. Số nhị phân chỉ đúng
  // điểm giữa ở 1 chữ số lẻ khi phần lẻ là .25/.75 (v×4 nguyên lẻ — nhân 4 là chính xác).
  const q = v * 4;
  if (Number.isInteger(q) && q % 2 !== 0) {
    let n = Math.floor(v * 10);
    if (n % 2 !== 0) n += 1;
    return (n / 10).toFixed(1);
  }
  return v.toFixed(1);
};

export function forecastUrl(cfg: WeatherConfig, area: Area): string {
  const f = cfg.fetch;
  return formatTemplate(f.url_template, {
    lat: fmt1(area.lat),
    lon: fmt1(area.lon),
    days: String(f.days),
  }) as string;
}

export function loadConfig(path: string = CONFIG_FILE): WeatherConfig {
  const name = basename(path);
  let cfg: unknown;
  try {
    const raw = readFileSync(path);
    cfg = pyLoads(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw new ConfigError(`không có file ${name}`);
    const t =
      e instanceof SyntaxError
        ? 'JSONDecodeError'
        : e instanceof TypeError
          ? 'UnicodeDecodeError'
          : pyOsName(e);
    throw new ConfigError(`${name} hỏng: ${t}`);
  }
  if (!isObj(cfg)) throw new ConfigError('gốc phải là object');
  const areas = cfg.areas;
  if (!Array.isArray(areas) || !areas.length) throw new ConfigError('areas rỗng/sai kiểu');
  const codes = new Set<string>();
  const plots = new Set<string>();
  const outAreas: Area[] = [];
  areas.forEach((a, i) => {
    if (!isObj(a)) throw new ConfigError(`areas[${i}] phải là object`);
    const c = a.code;
    if (typeof c !== 'string' || !CODE_RE.test(c) || codes.has(c)) {
      throw new ConfigError(`areas[${i}].code thiếu/sai dạng/trùng`);
    }
    codes.add(c);
    if (typeof a.name !== 'string' || !pyStrip(a.name))
      throw new ConfigError(`areas[${i}].name thiếu`);
    const ll: Record<string, number> = {};
    for (const [k, lim] of [
      ['lat', 90],
      ['lon', 180],
    ] as const) {
      const v = finite(a[k]);
      if (v === null || Math.abs(v) > lim || !round01(v)) {
        throw new ConfigError(`areas[${i}].${k} phải là số |v|≤${lim} đã làm tròn 0,1°`);
      }
      ll[k] = v;
    }
    const ps = a.plots;
    if (
      !Array.isArray(ps) ||
      !ps.every((x) => typeof x === 'string' && PLOT_RE.test(x)) ||
      ps.some((x) => plots.has(x)) ||
      new Set(ps).size !== ps.length
    ) {
      throw new ConfigError(`areas[${i}].plots sai/trùng khoảnh`);
    }
    for (const p of ps) plots.add(p);
    outAreas.push({
      ...a,
      code: c,
      name: a.name,
      lat: ll.lat as number,
      lon: ll.lon as number,
      plots: ps,
    });
  });
  const th = cfg.thresholds;
  const rain = isObj(th) ? finite(th.rain_mm_day) : null;
  const tmin = isObj(th) ? finite(th.tmin_c) : null;
  if (!isObj(th) || !inRange(rain, RAIN_RANGE) || !inRange(tmin, TEMP_RANGE)) {
    throw new ConfigError('thresholds.rain_mm_day/tmin_c thiếu/ngoài khoảng');
  }
  const f = cfg.fetch;
  if (
    !isObj(f) ||
    typeof f.enabled !== 'boolean' ||
    typeof f.url_template !== 'string' ||
    !f.url_template.startsWith('https://') ||
    !f.url_template.includes('{lat}') ||
    !f.url_template.includes('{lon}') ||
    !isPyInt(f.days) ||
    f.days < 1 ||
    f.days > 16
  ) {
    throw new ConfigError('fetch.enabled/url_template/days sai');
  }
  // placeholder lạ ({x}, {0}) → lỗi cấu hình, không crash lúc fetch
  const probe = formatTemplate(f.url_template, { lat: '0.0', lon: '0.0', days: '1' });
  if (probe === null) throw new ConfigError('fetch.url_template có placeholder lạ');
  // Host theo CÙNG parser với client TS (WHATWG — intel Fetcher): bỏ \t\n, '\' là '/', 0x7f.1 =
  // 127.0.0.1. urlsplit của Python lệch ở các mẫu đó → kiểm theo nơi request thật đi tới.
  let host: string;
  try {
    host = new URL(probe).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    throw new ConfigError('fetch.url_template có placeholder lạ'); // Python: urlsplit ValueError
  }
  if (internalHost(host)) {
    throw new ConfigError(
      'fetch.url_template phải là host công khai (không IP/localhost/mạng nội bộ — chống SSRF)',
    );
  }
  const fd = cfg.flag_days;
  if (!isPyInt(fd) || fd < 1 || fd > 60) throw new ConfigError('flag_days phải 1..60');
  return {
    ...cfg,
    areas: outAreas,
    thresholds: { ...th, rain_mm_day: rain as number, tmin_c: tmin as number },
    fetch: { ...f, enabled: f.enabled, url_template: f.url_template, days: f.days },
    flag_days: fd,
  };
}

export const md = (s: unknown): string => pyStr(s).replace(MD_RE, '\\$1');

export type WeatherRow = {
  area: string;
  day: string;
  rain_mm: number;
  tmin_c: number;
  tmax_c: number;
};

/** Python `str(v)` của giá trị JSON/CSV (PyFloat → `1.0`). */
const strOf = (v: unknown): string => (v instanceof PyFloat ? reprV(v) : pyStr(v));

/** Giá trị thô → row chuẩn; sai → SourceError(tên cột). */
function parseRow(
  area: string,
  day: unknown,
  rain: unknown,
  tmin: unknown,
  tmax: unknown,
): WeatherRow {
  const d = isoDate(pyStrip(strOf(day)));
  if (d === null) throw new SourceError('day');
  const vals: Record<string, number> = {};
  for (const [col, v, [lo, hi]] of [
    ['rain_mm', rain, RAIN_RANGE],
    ['tmin_c', tmin, TEMP_RANGE],
    ['tmax_c', tmax, TEMP_RANGE],
  ] as const) {
    const n = typeof v === 'boolean' ? null : pyNum(v);
    const x = n !== null ? n : typeof v === 'string' ? pyFloat(pyStrip(v)) : null;
    if (x === null || !Number.isFinite(x) || !(x >= lo && x <= hi)) throw new SourceError(col);
    vals[col] = x;
  }
  return {
    area,
    day: d,
    rain_mm: vals.rain_mm as number,
    tmin_c: vals.tmin_c as number,
    tmax_c: vals.tmax_c as number,
  };
}

/** CSV nhập tay → [rows, errors]. Có lỗi → rows rỗng, caller KHÔNG xử lý gì. */
export function readCsv(path: string, areaCodes: ReadonlySet<string>): [WeatherRow[], string[]] {
  const name = basename(path);
  let text: string;
  try {
    if (statSync(path).size > CSV_MAX) return [[], [`${name}: quá ${CSV_MAX} byte`]];
    const raw = readFileSync(path);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ BOM
    } catch {
      return [[], [`${name}: không phải UTF-8`]];
    }
  } catch (e) {
    return [[], [`${name}: không đọc được (${pyOsName(e)})`]];
  }
  const recs = csvRows(text);
  const head = recs[0] ?? [];
  if (head.length !== CSV_HEADER.length || head.some((h, i) => pyStrip(h) !== CSV_HEADER[i])) {
    return [[], [`dòng 1: header phải đúng ${CSV_HEADER.join(',')}`]];
  }
  const rows: WeatherRow[] = [];
  const errs: string[] = [];
  const seen = new Set<string>();
  recs.slice(1).forEach((rec, idx) => {
    const n = idx + 2;
    if (!rec.length || rec.every((c) => !pyStrip(c))) return;
    if (rec.length !== CSV_HEADER.length) {
      errs.push(`dòng ${n}: cần ${CSV_HEADER.length} cột`);
      return;
    }
    const area = pyStrip(rec[0] as string);
    if (!areaCodes.has(area)) {
      errs.push(`dòng ${n} cột area_code: vùng không có trong cấu hình`);
      return;
    }
    let row: WeatherRow;
    try {
      row = parseRow(area, rec[1], rec[2], rec[3], rec[4]);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      errs.push(`dòng ${n} cột ${e.message}: sai định dạng/ngoài khoảng`);
      return;
    }
    const key = `${area}\u0000${row.day}`;
    if (seen.has(key)) {
      errs.push(`dòng ${n}: trùng (area_code, day)`);
      return;
    }
    seen.add(key);
    rows.push(row);
  });
  return errs.length ? [[], errs] : [rows, errs];
}

/** JSON Open-Meteo daily → rows của 1 vùng. Hỏng → SourceError. */
export function parseOpenMeteo(body: Uint8Array, area: string): WeatherRow[] {
  const bad = (t: string) => new SourceError(`JSON dự báo hỏng (${t})`);
  let doc: unknown;
  try {
    doc = pyLoads(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch (e) {
    throw bad(e instanceof SyntaxError ? 'JSONDecodeError' : 'UnicodeDecodeError');
  }
  if (!isObj(doc)) throw bad('TypeError');
  if (!Object.hasOwn(doc, 'daily')) throw bad('KeyError');
  const daily = doc.daily;
  if (!isObj(daily)) throw bad('TypeError');
  const keys = ['time', 'precipitation_sum', 'temperature_2m_min', 'temperature_2m_max'];
  if (!keys.every((k) => Object.hasOwn(daily, k))) throw bad('KeyError');
  const days = daily.time;
  const cols = keys.slice(1).map((k) => daily[k]);
  if (!Array.isArray(days) || !cols.every((c) => Array.isArray(c) && c.length === days.length)) {
    throw new SourceError('mảng dự báo thiếu/độ dài lệch');
  }
  const out: WeatherRow[] = [];
  days.forEach((d, i) => {
    const vals = cols.map((c) => (c as unknown[])[i]);
    if (vals.some((v) => v === null)) return; // ngày chưa có số → bỏ ngày đó
    out.push(parseRow(area, d, vals[0], vals[1], vals[2]));
  });
  return out;
}

export type Alert = { area: string; day: string; kinds: string[]; value: Record<string, number> };

/** THUẦN → cảnh báo theo (vùng, ngày). */
export function evaluate(rows: readonly WeatherRow[], th: WeatherConfig['thresholds']): Alert[] {
  const out: Alert[] = [];
  const sorted = [...rows].sort((a, b) => cpCmp(a.area, b.area) || cpCmp(a.day, b.day));
  for (const r of sorted) {
    const kinds: string[] = [];
    const value: Record<string, number> = {};
    if (r.rain_mm > th.rain_mm_day) {
      kinds.push('mua_lon');
      value.rain_mm = r.rain_mm;
    }
    if (r.tmin_c < th.tmin_c) {
      kinds.push('ret');
      value.tmin_c = r.tmin_c;
    }
    if (kinds.length) out.push({ area: r.area, day: r.day, kinds, value });
  }
  return out;
}

// ---------------------------------------------------------------- fetch (collector intel)

// CÙNG lớp lỗi với collector thật (intel Fetcher ném) — bản sao riêng sẽ lọt qua instanceof.
export { BlockedDomain, BudgetExhausted };
export type FetchResult = Pick<Resp, 'status' | 'body'> | null;
/** Hợp đồng `crawler.intel.Fetcher.fetch(url, source)` — robots/độ trễ/ngân sách/chặn ở collector. */
export interface Fetcher {
  fetch(url: string, source: string): Promise<FetchResult>;
}

/** Mỗi vùng 1 GET qua Fetcher → [rows, mã vùng chưa có dự báo]. */
export async function fetchForecast(
  cfg: WeatherConfig,
  fetcher: Fetcher,
  log: (s: string) => void = console.log,
): Promise<[WeatherRow[], string[]]> {
  const rows: WeatherRow[] = [];
  const missing: string[] = [];
  for (let i = 0; i < cfg.areas.length; i++) {
    const a = cfg.areas[i] as Area;
    let r: FetchResult;
    try {
      r = await fetcher.fetch(forecastUrl(cfg, a), FETCH_SOURCE);
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        log('[warn] hết ngân sách --max-requests — vùng còn lại chưa có dự báo');
        missing.push(...cfg.areas.slice(i).map((x) => x.code));
        break;
      }
      if (!(e instanceof BlockedDomain)) throw e;
      r = null;
    }
    if (r === null || r.status !== 200 || r.body === null) {
      missing.push(a.code);
      continue;
    }
    try {
      rows.push(...parseOpenMeteo(r.body, a.code));
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      log(`[warn] vùng ${a.code}: ${e.message} — chưa có dự báo`);
      missing.push(a.code);
    }
  }
  return [rows, [...new Set(missing)]];
}

// ---------------------------------------------------------------- DB + digest

export type PestFlag = { plot: string; day: string; flag: string };

/** Nhật ký `days` ngày tới `now` → cờ CHỈ từ detail (không activity). */
export async function pestFlags(db: Db, now: Date, days: number): Promise<PestFlag[]> {
  const r = await db.query(
    'select plot_id, ts, detail from plot_logs where ts > $1 and ts <= $2 order by plot_id, ts',
    [new Date(now.getTime() - days * DAY_MS), now],
  );
  const out: PestFlag[] = [];
  for (const x of r.rows) {
    let fs = logFlags(x.detail);
    // 'bệnh' nằm trong 'sâu bệnh' → giữ cụm dài, 1 dòng/nhật ký
    fs = fs.filter((f) => !fs.some((g) => f !== g && g.includes(f)));
    if (fs.length) out.push({ plot: x.plot_id, day: vnDate(x.ts), flag: fs.join(', ') });
  }
  return out;
}

export async function activePlots(db: Db): Promise<string[]> {
  return (await db.query("select id from plots where status = 'active' order by id")).rows.map(
    (r) => r.id,
  );
}

export type DigestOpts = {
  areas?: readonly Area[];
  thresholds?: WeatherConfig['thresholds'] | null;
  missing?: readonly string[];
  unassigned?: readonly string[];
  logsLoaded?: boolean;
};

const FOOT = '*Agent không gửi/đăng gì; GĐ vùng trồng quyết định việc đi kiểm tra.*';

/** THUẦN — digest markdown từ template. KHÔNG tọa độ/vị trí/người ghi. */
export function buildDigest(
  alerts: readonly Alert[],
  flags: readonly PestFlag[],
  plotsByArea: ReadonlyMap<string, readonly string[]>,
  now: Date,
  o: DigestOpts = {},
): string {
  const names = new Map((o.areas ?? []).map((a) => [a.code, a.name]));
  const missing = o.missing ?? [];
  const th = o.thresholds;
  const L = [
    `# Cảnh báo thời tiết & sâu bệnh — ${vnDate(now)}`,
    '',
    'NỘI BỘ khối Vùng trồng — chỉ gợi ý "cần đi kiểm tra"; không chẩn đoán, không khuyến nghị xử lý. ' +
      'GĐ vùng trồng duyệt mục này = đã xem.',
    '',
  ];
  if (th) {
    L.push(
      `Ngưỡng GIẢ ĐỊNH (chờ GĐ vùng trồng chốt): mưa > ${fmt1(th.rain_mm_day)} mm/ngày, nhiệt độ ` +
        `thấp nhất < ${fmt1(th.tmin_c)} °C.`,
      '',
    );
  }
  L.push('## Thời tiết theo vùng', '');
  const byArea = new Map<string, Alert[]>();
  for (const a of alerts) byArea.set(a.area, [...(byArea.get(a.area) ?? []), a]);
  for (const [code, plots] of plotsByArea) {
    const ps = plots.join(', ') || '(chưa gán khoảnh)';
    L.push(`### ${names.get(code) ?? code} — khoảnh: ${ps}`);
    if (missing.includes(code)) L.push('- chưa có dự báo');
    for (const a of byArea.get(code) ?? []) {
      for (const k of a.kinds) {
        const v =
          k === 'mua_lon'
            ? `mưa ${fmt1(a.value.rain_mm as number)} mm`
            : `nhiệt độ thấp nhất ${fmt1(a.value.tmin_c as number)} °C`;
        L.push(`- ${a.day}: ${v} — cần đi ${KIND_TEXT[k]} tại khoảnh ${ps}`);
      }
    }
    if (!missing.includes(code) && !byArea.get(code)?.length) L.push('- không vượt ngưỡng');
    L.push('');
  }
  if (o.unassigned?.length) {
    L.push('## Khoảnh chưa gán vùng', '');
    L.push(...o.unassigned.map((p) => `- ${md(p)}: chưa gán vùng — chưa có cảnh báo thời tiết`));
    L.push('');
  }
  L.push('## Nhật ký vùng trồng cần chú ý', '');
  if (o.logsLoaded === false) L.push('- chưa nạp nhật ký (không kết nối được DB)');
  else if (!flags.length) L.push('- không có ghi nhận cần chú ý');
  for (const f of flags) {
    L.push(`- khoảnh ${md(f.plot)}: ghi nhận '${f.flag}' ngày ${f.day} — cần đi kiểm tra`);
  }
  L.push('', FOOT, '');
  return L.join('\n');
}

/** THUẦN — cảnh báo sâu bệnh từ cờ nhật ký (không tọa độ/người ghi). */
export function buildPestDigest(flags: readonly PestFlag[], now: Date): string {
  const L = [
    `# Cảnh báo sâu bệnh — ${vnDate(now)}`,
    '',
    'NỘI BỘ khối Vùng trồng — từ nhật ký vườn đã ghi; chỉ gợi ý "cần đi kiểm tra", không chẩn đoán, ' +
      'không khuyến nghị xử lý. GĐ vùng trồng duyệt mục này = đã xem.',
    '',
  ];
  L.push(
    ...flags.map(
      (f) => `- khoảnh ${md(f.plot)}: ghi nhận '${f.flag}' ngày ${f.day} — cần đi kiểm tra`,
    ),
  );
  L.push('', FOOT, '');
  return L.join('\n');
}

const isUnique = (e: unknown) => isDbError(e) && (e as { code?: string }).code === '23505';
/** Python `type(e).__name__` của lỗi submit (RolloutBlocked/ValueError là RangeError ở TS). */
const errName = (e: unknown): string =>
  isDbError(e)
    ? pgErrName(e)
    : e instanceof RolloutBlocked
      ? 'RolloutBlocked'
      : e instanceof DirectorConfigError
        ? e.name
        : 'ValueError';

export type VtDeps = {
  connect?: () => Promise<DbLease | null>;
  io?: Io;
  env?: Env;
  configFile?: string;
  reportsDir?: string;
  /** Python `main(transport=, sleep=, clock=)` — test truyền transport/đồng hồ giả. */
  fetchOpts?: Pick<FetcherOpts, 'transport' | 'sleep' | 'clock'>;
  sourcesFile?: string;
};

/** → exit: 0 xong/không có cờ · 1 lỗi ghi/guardrail · 2 không đọc được nhật ký (DB) — không coi là
 * 'không có cờ'. */
export async function runPests(
  now: Date,
  doSubmit: boolean,
  days: number,
  d: VtDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) {
    io.out('[err] không kết nối được Postgres — không đọc được nhật ký');
    return 2;
  }
  try {
    let flags: PestFlag[];
    try {
      flags = await pestFlags(lease.db, now, days);
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.out(`[err] lỗi DB khi đọc nhật ký (${pgErrName(e)})`);
      return 2;
    }
    const vnDay = vnDate(now);
    io.out(`[pests] ${vnDay}: ${flags.length} ghi nhận cần chú ý`);
    if (!flags.length || !doSubmit) return 0;
    const text = buildPestDigest(flags, now);
    if (guardrailCheck(text).ok !== true) {
      io.out('[err] cảnh báo sâu bệnh vi phạm guardrail — không ghi');
      return 1;
    }
    let qid: bigint;
    try {
      qid = await submit(lease.db, {
        block: BLOCK,
        objectType: PEST_OBJECT_TYPE,
        objectId: `vt-pest:${vnDay}`,
        title: `Cảnh báo sâu bệnh ${vnDay}`,
        payload: text,
        createdBy: CREATED_BY,
      });
    } catch (e) {
      if (isUnique(e)) {
        io.out(`[skipped] cảnh báo sâu bệnh ${vnDay} đã có mục`);
        return 0;
      }
      if (isDbError(e) || e instanceof DirectorConfigError || e instanceof RangeError) {
        io.out(`[err] không đẩy được hàng duyệt (${errName(e)})`);
        return 1;
      }
      throw e;
    }
    io.out(`[done] mục #${qid} PENDING khối farming (${PEST_OBJECT_TYPE})`);
    return 0;
  } finally {
    await lease.release();
  }
}

export type VtOpts = {
  digest?: boolean;
  pests?: boolean;
  fromCsv?: string;
  fetch?: boolean;
  maxRequests?: string;
  submit?: boolean;
  date?: string;
};

const PROG = 'vt-thoitiet';

/** `python -m agents.vt_thoitiet` → exit: 0 ok · 1 cấu hình/CSV lỗi, guardrail chặn, lỗi DB khi
 * submit · 2 tham số sai / fetch chưa bật / không đọc được nhật ký (--pests). */
export async function vtThoitietMain(o: VtOpts, d: VtDeps & { now?: Date } = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (m: string) => {
    io.err(`${PROG}: error: ${m}`);
    return 2;
  };
  const maxReq = o.maxRequests === undefined ? DEFAULT_MAX_REQ : Number(pyStrip(o.maxRequests));
  if (o.maxRequests !== undefined && !/^[+-]?\d+$/.test(pyStrip(o.maxRequests))) {
    return usage(`argument --max-requests: invalid int value: '${o.maxRequests}'`);
  }
  const srcs = [
    o.pests && '--pests',
    o.fromCsv !== undefined && '--from-csv',
    o.fetch && '--fetch',
  ].filter(Boolean) as string[];
  if (srcs.length === 0)
    return usage('one of the arguments --pests --from-csv --fetch is required');
  if (srcs.length > 1) return usage(`argument ${srcs[1]}: not allowed with argument ${srcs[0]}`);
  if (!o.pests && !o.digest) return usage('cần --digest (thời tiết) hoặc --pests (sâu bệnh)');
  if (!(maxReq >= 1 && maxReq <= 60)) return usage('--max-requests phải trong 1..60');
  let now = d.now;
  if (o.date) {
    const day = isoDate(o.date);
    try {
      if (day === null) throw new RangeError('date');
      now = new Date(vnMidnight(addDays(day, 1)).getTime() - 1); // hết ngày VN
    } catch {
      return usage('--date sai định dạng YYYY-MM-DD');
    }
  }
  const at = now ?? new Date();
  let cfg: WeatherConfig;
  try {
    cfg = loadConfig(d.configFile);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.out(`[err] weather_config.json: ${e.message}`);
    return 1;
  }
  if (o.pests) return runPests(at, Boolean(o.submit), cfg.flag_days, d);
  const codes = new Set(cfg.areas.map((x) => x.code));
  let rows: WeatherRow[];
  let missing: string[] = [];
  if (o.fromCsv !== undefined) {
    const [r, errs] = readCsv(o.fromCsv, codes);
    if (errs.length) {
      for (const e of errs.slice(0, 50)) io.out(`[err] ${e}`);
      io.out(`[err] CSV có ${errs.length} lỗi — không xử lý`);
      return 1;
    }
    rows = r;
  } else {
    if (cfg.fetch.enabled !== true) {
      io.out(
        '[warn] --fetch chưa bật — điều khoản nhà cung cấp dự báo chưa xác minh (dùng --from-csv)',
      );
      return 2;
    }
    const [icfg, ierrs] = loadSources(d.sourcesFile ?? SOURCES_FILE);
    if (icfg === null || ierrs.length) {
      io.out('[err] không đọc được danh sách chặn tầng C — không fetch');
      return 1;
    }
    const f = new IntelFetcher({
      ...d.fetchOpts,
      budget: maxReq,
      extraBlock: tierCHosts(icfg),
      log: io.out,
      env: d.env,
    });
    [rows, missing] = await fetchForecast(cfg, f, io.out);
  }
  const alerts = evaluate(rows, cfg.thresholds);
  const plotsByArea = new Map(cfg.areas.map((x) => [x.code, [...x.plots]]));
  const assigned = new Set(cfg.areas.flatMap((x) => x.plots));
  let flags: PestFlag[] = [];
  let unassigned: string[] = [];
  let loaded = false;
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  try {
    if (lease !== null) {
      try {
        flags = await pestFlags(lease.db, at, cfg.flag_days);
        unassigned = (await activePlots(lease.db)).filter((p) => !assigned.has(p));
        loaded = true;
      } catch (e) {
        if (!isDbError(e)) throw e;
        io.out(`[warn] chưa nạp nhật ký (lỗi DB ${pgErrName(e)})`);
      }
    } else {
      io.out('[warn] chưa nạp nhật ký (không kết nối được Postgres)');
    }
    const text = buildDigest(alerts, flags, plotsByArea, at, {
      areas: cfg.areas,
      thresholds: cfg.thresholds,
      missing,
      unassigned,
      logsLoaded: loaded,
    });
    if (guardrailCheck(text).ok !== true) {
      io.out('[err] digest vi phạm guardrail — không ghi');
      return 1;
    }
    const vnDay = vnDate(at);
    let p: string;
    try {
      // P8.4: cảnh báo thời tiết theo vùng (dữ liệu dự báo thật) — báo cáo không thuộc tính năng có sổ đếm.
      p = await writeReport(text, d.reportsDir ?? REPORTS_DIR, `vt-canh-bao-${vnDay}.md`, false);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== 'string' || !/^E[A-Z]+$/.test(code)) throw e; // OSError
      io.out(`[err] không ghi được digest (${pyOsName(e)})`);
      return 1;
    }
    io.out(
      `[done] ${p} alerts=${alerts.length} flags=${flags.length} missing=${missing.join(',') || '-'}`,
    );
    if (!o.submit) return 0;
    if (!loaded || lease === null) {
      io.out('[warn] --submit bỏ qua — chưa nạp nhật ký/DB down');
      return 0;
    }
    if (!alerts.length && !flags.length) {
      io.out('[ok] không có cảnh báo/cờ — không đẩy hàng duyệt');
      return 0;
    }
    let qid: bigint;
    try {
      qid = await submit(lease.db, {
        block: BLOCK,
        objectType: OBJECT_TYPE,
        objectId: `vt-digest:${vnDay}`,
        title: `Cảnh báo thời tiết & sâu bệnh ${vnDay}`,
        payload: text,
        createdBy: CREATED_BY,
      });
    } catch (e) {
      if (isUnique(e)) {
        io.out(`[skipped] digest ${vnDay} đã có mục đang chờ duyệt`);
        return 0;
      }
      if (isDbError(e) || e instanceof DirectorConfigError) {
        io.out(`[err] không đẩy được hàng duyệt (${errName(e)})`);
        return 1;
      }
      throw e;
    }
    io.out(`[done] mục #${qid} PENDING khối farming (GĐ duyệt = đã xem)`);
    return 0;
  } finally {
    await lease?.release();
  }
}
