import { readFileSync } from 'node:fs';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, parseDay, vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { isDict, parsePyJson, pyFixed } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName, pySorted } from '@samsam/core/rollout/counters';
import { pyReprValue } from '@samsam/core/security/py';
import { io, openDb } from './common.js';

// Port `scripts/review_load.py` (PC-A0, v4.4 W44.1) — mô hình tải người duyệt: hàng duyệt so với quota
// (`data/review_quota.json`, trần quyết định/ngày của MỖI người duyệt; `status` ≠ `chot` = ĐỀ XUẤT).
// CHỈ ĐỌC (SELECT `content_drafts` + `approvals`) rồi nhắc khi quá tải — KHÔNG gán người duyệt, KHÔNG
// đổi status, KHÔNG ghi DB. Hàng chờ tách theo `guardrail->'ok'`: true → vào hàng; false → trả tác giả
// (không tính quota); thiếu/khác kiểu → KHÔNG RÕ, tính VÀO hàng (fail-closed). Ngày luôn theo giờ
// Asia/Ho_Chi_Minh. Exit 2 = tham số/quota sai (TRƯỚC connect DB); 1 = DB không truy cập được; 0 còn
// lại. Không in `text`/`brief` của nháp.

export const DEFAULT_QUOTA = dataPath('review_quota.json');
export const MAX_DAYS = 366;
// biome-ignore lint/suspicious/noControlCharactersInRegex: thay ký tự điều khiển trong tên (OWASP A09)
const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Quota/tham số sai → exit 2 (Python `QuotaError(ValueError)`). */
export class QuotaError extends RangeError {
  override name = 'QuotaError';
}

export type Phase = readonly [from: string, to: string | null, cap: number];
export type Quota = { status: string; phases: Phase[]; absent: Set<string> };

// Mọi câu SQL bắt đầu bằng `select` (read-only — test kiểm). Ngày trả về dạng chữ 'YYYY-MM-DD'
// (`::text`) — tránh `pg` đổi `date` thành Date theo múi giờ máy.
const VN = "at time zone 'Asia/Ho_Chi_Minh'";
export const SQL_QUEUE =
  "select case when guardrail -> 'ok' = 'true'::jsonb then 'vao_hang'" +
  " when guardrail -> 'ok' = 'false'::jsonb then 'tra_tac_gia'" +
  " else 'khong_ro' end as g, count(*) as n," +
  ` min((created_at ${VN})::date)::text as d` +
  " from content_drafts where status = 'pending' group by 1";
export const SQL_INFLOW =
  `select (created_at ${VN})::date::text as d, count(*) as n from content_drafts` +
  ` where (created_at ${VN})::date between $1::date and $2::date group by 1`;
export const SQL_THROUGHPUT =
  `select (approved_at ${VN})::date::text as d, btrim(approved_by) as who,` +
  ' count(*) as n from approvals' +
  ` where (approved_at ${VN})::date between $1::date and $2::date` +
  ' group by 1, 2 order by 1, 2';

/** Python `_iso`: chuỗi `\d{4}-\d{2}-\d{2}` (Unicode `\d`) + `date.fromisoformat` (chỉ ASCII). */
export function isoDay(v: unknown, where: string): string {
  if (typeof v !== 'string' || !/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u.test(v)) {
    throw new QuotaError(`${where}: cần ngày YYYY-MM-DD, nhận ${pyReprValue(v ?? null)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || parseDay(v) === null) {
    throw new QuotaError(`${where}: ngày không hợp lệ ${pyReprValue(v)}`);
  }
  return v;
}

/** Đọc + kiểm quota. Lỗi bất kỳ → QuotaError. */
export function loadQuota(path: string): Quota {
  let raw: unknown;
  try {
    const buf = readFileSync(path);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new QuotaError('quota không đọc được: UnicodeDecodeError');
    }
    try {
      raw = parsePyJson(text); // số thực JSON (5.0) → PyFloat, không lẫn với số nguyên
    } catch {
      throw new QuotaError('quota không đọc được: JSONDecodeError');
    }
  } catch (e) {
    if (e instanceof QuotaError) throw e;
    const code = (e as { code?: string }).code;
    throw new QuotaError(
      `quota không đọc được: ${code === 'ENOENT' ? 'FileNotFoundError' : code === 'EISDIR' ? 'IsADirectoryError' : code === 'EACCES' || code === 'EPERM' ? 'PermissionError' : 'OSError'}`,
    );
  }
  if (!isDict(raw)) throw new QuotaError('quota phải là object JSON');
  const phases = raw.phases;
  if (!Array.isArray(phases) || !phases.length) {
    throw new QuotaError('quota.phases rỗng hoặc không phải list');
  }
  const out: Phase[] = phases.map((p, i) => {
    const where = `phases[${i}]`;
    if (!isDict(p)) throw new QuotaError(`${where} phải là object`);
    const start = isoDay(p.from, `${where}.from`);
    const end = p.to === null || p.to === undefined ? null : isoDay(p.to, `${where}.to`);
    if (end !== null && end < start) throw new QuotaError(`${where}: to < from`);
    const cap = p.daily_cap;
    // bool là int trong Python — True không phải trần; 5.0 (float JSON → PyFloat) cũng sai.
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) {
      throw new QuotaError(`${where}.daily_cap phải là số nguyên >= 0`);
    }
    return [start, end, cap] as const;
  });
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    const e1 = (out[i - 1] as Phase)[1];
    const s2 = (out[i] as Phase)[0];
    if (e1 === null || e1 >= s2) throw new QuotaError(`phases chồng nhau quanh ${s2}`);
  }
  const absent = raw.absent_days ?? [];
  if (!Array.isArray(absent)) throw new QuotaError('absent_days phải là list');
  const status = raw.status ?? '';
  return {
    status: typeof status === 'string' ? status : '',
    phases: out,
    absent: new Set(absent.map((d) => isoDay(d, 'absent_days'))),
  };
}

/** Trần quyết định/ngày của 1 người duyệt; ngày vắng → 0; không phase nào phủ → null. */
export function capFor(day: string, quota: Quota): number | null {
  if (quota.absent.has(day)) return 0;
  for (const [start, end, cap] of quota.phases) {
    if (start <= day && (end === null || day <= end)) return cap;
  }
  return null;
}

export type Stats = {
  today: string;
  days: number;
  start: string;
  queue: { vao_hang: number; tra_tac_gia: number; khong_ro: number };
  queue_total: number;
  oldest_age_days: number | null;
  inflow: Record<string, number>;
  throughput: Record<string, Record<string, number>>;
};

const dayDiff = (a: string, b: string) =>
  Math.round(((parseDay(a) as number) - (parseDay(b) as number)) / 86_400_000);

/** CHỈ SELECT → số liệu hàng chờ / nháp vào / quyết định theo ngày-người. */
export async function collect(db: Pick<Db, 'query'>, today: string, days: number): Promise<Stats> {
  const start = addDays(today, -(days - 1));
  const queue = { vao_hang: 0, tra_tac_gia: 0, khong_ro: 0 };
  let oldest = null as string | null;
  const q = await db.query<{ g: keyof typeof queue; n: string; d: string | null }>(SQL_QUEUE);
  for (const { g, n, d } of q.rows) {
    queue[g] = Number(n);
    if (g !== 'tra_tac_gia' && d !== null && (oldest === null || d < oldest)) oldest = d;
  }
  const inflow: Record<string, number> = {};
  for (const { d, n } of (await db.query<{ d: string; n: string }>(SQL_INFLOW, [start, today]))
    .rows) {
    inflow[d] = Number(n);
  }
  const tp: Record<string, Record<string, number>> = {};
  const r = await db.query<{ d: string; who: string; n: string }>(SQL_THROUGHPUT, [start, today]);
  for (const { d, who, n } of r.rows) {
    // Tên in ra terminal: thay ký tự điều khiển (chống chèn ANSI/dòng giả — OWASP A09); trùng sau thay
    // thì cộng dồn.
    const name = String(who).replace(CTRL_RE, '?');
    const day = tp[d] ?? {};
    tp[d] = day;
    day[name] = (day[name] ?? 0) + Number(n);
  }
  return {
    today,
    days,
    start,
    queue,
    queue_total: queue.vao_hang + queue.khong_ro,
    oldest_age_days: oldest === null ? null : dayDiff(today, oldest),
    inflow,
    throughput: tp,
  };
}

const sortedDays = (o: Record<string, unknown>) => Object.keys(o).sort();

export function warnings(stats: Stats, quota: Quota, today: string): string[] {
  const out: string[] = [];
  const cap = capFor(today, quota);
  const n = stats.queue_total;
  if (quota.absent.has(today) && n > 0) {
    out.push(
      `CẢNH BÁO: người duyệt vắng hôm nay — ${n} mục pending giữ nguyên, không ai được duyệt thay`,
    );
  } else if (cap !== null && n > cap) {
    const need = cap === 0 ? '∞ (trần 0)' : `≥ ${Math.ceil(n / cap)} ngày`;
    out.push(`QUÁ TẢI: hàng chờ ${n} mục > trần ${cap}/ngày — cần ${need} duyệt`);
  }
  for (const d of sortedDays(stats.throughput)) {
    const dcap = capFor(d, quota);
    const day = stats.throughput[d] as Record<string, number>;
    for (const who of pySorted(Object.keys(day))) {
      const k = day[who] as number;
      if (dcap !== null && k > dcap) {
        out.push(
          `QUÁ TẢI: ${who} ${k} quyết định ngày ${d} > trần ${dcap} — vượt trần, rủi ro duyệt vội`,
        );
      }
    }
  }
  const avg = Object.values(stats.inflow).reduce((a, b) => a + b, 0) / stats.days;
  if (cap !== null && avg > cap) {
    out.push(
      `CẢNH BÁO: nháp vào TB ${pyFixed(avg, 1)}/ngày > trần ${cap} — nháp vào nhanh hơn trần — giảm volume, không hạ chuẩn (§2)`,
    );
  }
  return out;
}

export function render(stats: Stats, quota: Quota, today: string): string {
  const cap = capFor(today, quota);
  const q = stats.queue;
  const lines = [`# Tải hàng duyệt — ${today} (cửa sổ ${stats.start}..${today}, giờ VN)`];
  if (quota.status !== 'chot') lines.push('Quota ĐỀ XUẤT, chưa TGĐ chốt (plan_legal_hr §2).');
  lines.push(`Trần hôm nay/người: ${cap === null ? 'không có phase' : cap}`);
  lines.push(
    `Hàng chờ: vào hàng ${q.vao_hang} · KHÔNG RÕ ${q.khong_ro} (tính vào hàng) · trả tác giả ${q.tra_tac_gia} (không tính quota) → tính quota ${stats.queue_total}`,
  );
  const age = stats.oldest_age_days;
  lines.push(`Mục chờ cũ nhất: ${age === null ? '—' : `${age} ngày`}`);
  const totalIn = Object.values(stats.inflow).reduce((a, b) => a + b, 0);
  lines.push(
    `Nháp vào: ${totalIn} trong ${stats.days} ngày (TB ${pyFixed(totalIn / stats.days, 1)}/ngày)`,
  );
  lines.push('Quyết định duyệt theo ngày/người:');
  if (!Object.keys(stats.throughput).length) lines.push('  (không có)');
  for (const d of sortedDays(stats.throughput)) {
    const day = stats.throughput[d] as Record<string, number>;
    for (const who of pySorted(Object.keys(day))) lines.push(`  ${d} ${who}: ${day[who]}`);
  }
  const warns = warnings(stats, quota, today);
  lines.push('');
  lines.push(...(warns.length ? warns : ['Không có cảnh báo tải.']));
  lines.push('(Chỉ nhắc — không phân việc, không đổi trạng thái; người duyệt quyết.)');
  return `${lines.join('\n')}\n`;
}

export type ReviewLoadOpts = { today?: string; days?: string; quota?: string };
export type ReviewLoadDeps = {
  env?: Env;
  connect?: (env: Env) => Promise<Pick<Db, 'query'> | null>;
};

/** `python scripts/review_load.py [--today YYYY-MM-DD] [--days N] [--quota PATH]` → exit code. */
export async function reviewLoadMain(
  o: ReviewLoadOpts = {},
  deps: ReviewLoadDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let today: string;
  let days: number;
  let quota: Quota;
  try {
    let d = 7;
    if (o.days !== undefined) {
      const v = pyInt(o.days);
      if (v === null) throw new QuotaError(`--days: invalid int value: ${pyReprValue(o.days)}`);
      d = Number(v);
    }
    today = o.today !== undefined ? isoDay(o.today, '--today') : vnDate(io.now());
    if (!(d >= 1 && d <= MAX_DAYS)) throw new QuotaError(`--days phải trong 1..${MAX_DAYS}`);
    days = d;
    quota = loadQuota(o.quota ?? DEFAULT_QUOTA);
    if (capFor(today, quota) === null) throw new QuotaError(`không phase quota nào phủ ${today}`);
  } catch (e) {
    if (!(e instanceof QuotaError)) throw e;
    console.error(`[err] ${e.message}`);
    return 2;
  }
  const db = await (deps.connect ?? openDb)(env);
  if (db === null) {
    console.error('[err] DB không truy cập được');
    return 1;
  }
  let stats: Stats;
  try {
    stats = await collect(db, today, days);
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(`[err] DB không truy cập được (${pgErrName(e)})`);
    return 1;
  } finally {
    if (!deps.connect) await (db as { end?: () => Promise<void> }).end?.().catch(() => {});
  }
  process.stdout.write(render(stats, quota, today));
  return 0;
}
