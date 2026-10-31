import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { DirectorConfigError, submit } from '@samsam/core/ops/director';
import { addDays, vnDate, vnMidnight } from '@samsam/core/ops/period';
import { cpSlice, pyInt, squash } from '@samsam/core/ops/py';
import { isoDate, pyIsoUtc } from '@samsam/core/ops/py-date';
import { cpCmp, isPyInt, PyFloat, pyLoads, reprV } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import {
  callHuman,
  cliGate,
  cliIdentity,
  HumanDenied,
  HumanError,
} from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  ACTIVITY_VOCAB,
  type DbLease,
  DEFAULT_GAP_DAYS,
  flagsFor,
  type Io,
  STD_IO,
} from '../garden_zalo/garden.js';
import { pyOsName } from '../garden_zalo/garden-media.js';
import { plotOwners } from '../garden_zalo/garden-zalo.service.js';

// Port `agents/garden_director.py` (WP13 VT — Agent GĐ vùng trồng): bản tin tuần, nhắc lịch/gap,
// kiểm hash chain nhật ký, hồ sơ khoảnh (precheck + gỡ dữ liệu mẫu có người ký).
//  - Tất định, KHÔNG LLM, KHÔNG gọi mạng. Hàm thời gian nhận `now`/`until` — chỉ CLI đọc đồng hồ.
//    Ngày/cửa sổ tuần theo giờ VN (UTC+7 cố định).
//  - `plot_logs` nằm trong hash chain do trigger DB tính — agent chỉ ĐỌC + gọi `verify_plot_logs()`.
//  - Gỡ mẫu / nhận khoảnh CHỈ qua CLI `--purge-sample|--adopt-plot --by "<GĐ vùng trồng>"`:
//    `cliGate` khối farming, ghi qua function SECURITY DEFINER `garden_*_human` (danh tính theo
//    login). Agent/cron KHÔNG gọi `purgeSample`/`adoptPlot`.
//  - Lịch hoạt động `data/garden_schedule.json` là GIẢ ĐỊNH chờ GĐ vùng trồng chốt.
//  - Cờ keyword CHỈ quét `detail` — tên activity 'kiểm tra sâu bệnh' chứa chính keyword.
//  - Output KHÔNG chứa tọa độ/`location`/`area_m2`/người ghi; detail qua maskPii + cắt 120 ký tự.
//  - DB down: --bulletin/--remind/--precheck → `[warn] chưa nạp` exit 0; --verify/--purge-sample/
//    --adopt-plot → exit 2.
// KHÁC Python có chủ đích (chặt hơn/không traceback): JSON NaN/Infinity bị từ chối khi đọc lịch/kênh;
// tệp kênh nhắc không phải object → lỗi cấu hình (Python AttributeError traceback); cổng TẮT ở
// `writeReport` → `[rollout]` exit 2 (Python traceback); DirectorConfigError ở --submit → exit 1.

export const SCHEDULE_PATH = dataPath('garden_schedule.json');
export const REMIND_PATH = dataPath('garden_remind.json');
export const SAMPLE_LIKE = 'sample:%';
export const PURGE_ACTION = 'garden_sample_purge';
export const ADOPT_ACTION = 'garden_plot_adopt';
export const ADOPT_SOURCE = 'manual:adopted';
export const DETAIL_MAX = 120;
export const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

/** Python RuntimeError — CLI `[err]` exit 2 (DB từ chối nghiệp vụ giữa giao dịch gỡ mẫu). */
export class GardenRuntimeError extends Error {
  override name = 'RuntimeError';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);

const num = (v: unknown): number => Number(v);

// ---------------------------------------------------------------- hồ sơ khoảnh

export type Blocker =
  | { kind: 'plot_log'; id: number; plot_id: string; day: string; source: string }
  | { kind: 'garden_media'; id: number; plot_id: string };
export type Precheck = { plots: number; plot_logs: number; blockers: Blocker[] };

/** CHỈ ĐỌC. Số dòng mẫu + blocker: nhật ký KHÔNG-mẫu trỏ khoảnh mẫu (id, plot_id, ngày VN, source —
 * không detail/author) và ảnh `garden_media` trỏ khoảnh mẫu. */
export async function samplePrecheck(db: Db): Promise<Precheck> {
  const count = async (sql: string) => num((await db.query(sql, [SAMPLE_LIKE])).rows[0].n);
  const plots = await count('select count(*) as n from plots where source like $1');
  const logs = await count('select count(*) as n from plot_logs where source like $1');
  const blockers: Blocker[] = (
    await db.query(
      'select l.id, l.plot_id, l.ts, l.source from plot_logs l join plots p on p.id = l.plot_id' +
        ' where p.source like $1 and l.source not like $1 order by l.id',
      [SAMPLE_LIKE],
    )
  ).rows.map((r) => ({
    kind: 'plot_log' as const,
    id: num(r.id),
    plot_id: r.plot_id,
    day: vnDate(r.ts),
    source: r.source,
  }));
  for (const r of (
    await db.query(
      'select m.id, m.plot_id from garden_media m join plots p on p.id = m.plot_id' +
        ' where p.source like $1 order by m.id',
      [SAMPLE_LIKE],
    )
  ).rows) {
    blockers.push({ kind: 'garden_media', id: num(r.id), plot_id: r.plot_id });
  }
  return { plots, plot_logs: logs, blockers };
}

export type PurgeResult = { ok: boolean } & Precheck;

/** Gỡ TOÀN BỘ dữ liệu mẫu vườn — chỉ người thật (GĐ vùng trồng) qua CLI. `by` rỗng → RangeError (không
 * đụng DB). 1 giao dịch: precheck lại → có blocker thì KHÔNG xóa; không → function DB xóa (kiểm lại
 * blocker + số dòng khớp precheck, ghi `agent_action_log`). */
export async function purgeSample(
  db: Db,
  by: unknown,
  env: Env = process.env,
): Promise<PurgeResult> {
  const who = typeof by === 'string' ? pyStrip(by) : '';
  if (!who) throw new RangeError('thiếu --by (tên GĐ vùng trồng ký gỡ dữ liệu mẫu)');
  return withTx(db, async (c) => {
    const pre = await samplePrecheck(c);
    if (pre.blockers.length) return { ok: false, ...pre };
    let res: { ok: boolean; plots?: number; plot_logs?: number };
    try {
      res = (
        await callHuman(
          c,
          'select garden_purge_sample_human($1, $2, $3) as r',
          [who, pre.plots, pre.plot_logs],
          {
            by: who,
            block: 'farming',
            action: 'purge_sample',
            objectType: 'plots',
            objectId: 'sample',
            env,
          },
        )
      ).rows[0].r;
    } catch (e) {
      if (e instanceof HumanDenied) throw e;
      if (e instanceof HumanError) throw new GardenRuntimeError(e.message);
      throw e;
    }
    if (!res.ok) return { ok: false, ...(await samplePrecheck(c)) }; // blocker xuất hiện giữa chừng
    return { ok: true, plots: num(res.plots), plot_logs: num(res.plot_logs), blockers: [] };
  });
}

export type AdoptResult =
  | { ok: true; plot_id: string; from_source: string }
  | { ok: false; reason: string };

/** GĐ vùng trồng ký NHẬN khoảnh mẫu thành khoảnh thật — đường gỡ blocker 'nhật ký đã chain' (dòng
 * chain KHÔNG UPDATE/DELETE được). Chỉ đổi `plots.source` → ADOPT_SOURCE; thuộc tính khoảnh VẪN là
 * giá trị mẫu. `by` rỗng → RangeError (không đụng DB). */
export async function adoptPlot(
  db: Db,
  plotId: unknown,
  by: unknown,
  env: Env = process.env,
): Promise<AdoptResult> {
  const who = typeof by === 'string' ? pyStrip(by) : '';
  if (!who) throw new RangeError('thiếu --by (tên GĐ vùng trồng ký nhận khoảnh)');
  const pid = typeof plotId === 'string' ? pyStrip(plotId) : '';
  return withTx(db, async (c) => {
    const row = (await c.query('select source from plots where id = $1', [pid])).rows[0];
    if (row === undefined) return { ok: false, reason: `khoảnh ${pyRepr(pid)} không tồn tại` };
    if (!String(row.source).startsWith('sample:')) {
      return { ok: false, reason: `khoảnh ${pid} không phải khoảnh mẫu` };
    }
    const res = (
      await callHuman(c, 'select garden_adopt_plot_human($1, $2) as r', [pid, who], {
        by: who,
        block: 'farming',
        action: 'adopt_plot',
        objectType: 'plots',
        objectId: pid,
        env,
      })
    ).rows[0].r as { ok: boolean; reason?: string };
    if (!res.ok) return { ok: false, reason: String(res.reason) };
    return { ok: true, plot_id: pid, from_source: row.source };
  });
}

/** Kết quả `verify_plot_logs()` — rỗng = chuỗi nguyên vẹn. */
export async function verify(db: Db): Promise<[number, string][]> {
  const r = await db.query('select id, problem from verify_plot_logs() order by id, problem');
  return r.rows.map((x) => [num(x.id), x.problem]);
}

// ------------------------------------------------------------ nhắc lịch / gap

/** Lịch hoạt động sai cấu trúc/giá trị (CLI `[err]` exit 1) — Python ScheduleError(ValueError). */
export class ScheduleError extends RangeError {
  override name = 'ScheduleError';
}

export type Schedule = { gap_days?: number; activities?: Record<string, number> };

export const validDays = (v: unknown): v is number => isPyInt(v) && v >= 1 && v <= 366;

const pyTuple = (xs: readonly string[]) => `(${xs.map(pyRepr).join(', ')})`;

function decodeUtf8(raw: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); // BOM giữ = JSON hỏng
}

/** → [{gap_days, activities}, cảnh báo]. Thiếu / rỗng / `{}` / chỉ `_doc` (không activity) → lịch rỗng
 * + `gap_days` mặc định + cảnh báo "chưa có lịch". JSON hỏng / không phải object / key lạ / activity
 * ngoài vocab / số ngày không phải int 1..366 → RangeError (CLI `[err]` exit 1). */
export function loadSchedule(path: string = SCHEDULE_PATH): [Required<Schedule>, string[]] {
  const name = basename(path);
  const empty = { gap_days: DEFAULT_GAP_DAYS, activities: {} };
  const warn = [`chưa có lịch hoạt động định kỳ (${name}) — chỉ nhắc khoảnh chưa có nhật ký / gap`];
  if (!existsSync(path)) return [empty, warn];
  let raw: string;
  try {
    raw = decodeUtf8(readFileSync(path));
  } catch (e) {
    throw new RangeError(
      `không đọc được lịch ${name}: ${e instanceof TypeError ? 'UnicodeDecodeError' : pyOsName(e)}`,
    );
  }
  if (!pyStrip(raw)) return [empty, warn];
  let data: unknown;
  try {
    data = pyLoads(raw);
  } catch (e) {
    throw new RangeError(`lịch ${name} JSON hỏng: ${(e as Error).message}`);
  }
  if (!isObj(data)) throw new ScheduleError(`lịch ${name} phải là object JSON`);
  const unknown = Object.keys(data)
    .filter((k) => !k.startsWith('_') && k !== 'gap_days' && k !== 'activities')
    .sort(cpCmp);
  if (unknown.length) throw new RangeError(`lịch ${name} có key lạ: ${pyStr(unknown)}`);
  const gap = Object.hasOwn(data, 'gap_days') ? data.gap_days : DEFAULT_GAP_DAYS;
  if (!validDays(gap)) throw new RangeError(`gap_days phải là số nguyên 1..366: ${reprV(gap)}`);
  const acts = Object.hasOwn(data, 'activities') ? data.activities : {};
  if (!isObj(acts)) throw new ScheduleError('activities phải là object {hoạt động: số ngày}');
  for (const [act, days] of Object.entries(acts)) {
    if (!(ACTIVITY_VOCAB as readonly string[]).includes(act)) {
      throw new RangeError(`hoạt động '${act}' không thuộc vocab ${pyTuple(ACTIVITY_VOCAB)}`);
    }
    if (!validDays(days)) {
      throw new RangeError(`'${act}': số ngày phải là số nguyên 1..366: ${reprV(days)}`);
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(acts as Record<string, number>).sort(([a], [b]) => cpCmp(a, b)),
  );
  return [{ gap_days: gap, activities: sorted }, Object.keys(acts).length ? [] : warn];
}

export type Reminder = {
  type: 'no-logs' | 'gap' | 'overdue';
  plot: string;
  activity: string | null;
  last_ts: Date | null;
  days: number | null;
};

/** Khóa Map nhật ký gần nhất theo (khoảnh, hoạt động). */
export const actKey = (plot: string, activity: string): string => `${plot}\u0000${activity}`;

/** THUẦN. `lastAny[plot]` / `lastBy[actKey(plot, act)]` = ts nhật ký gần nhất. Sinh: 'no-logs'
 * (không sinh overdue kèm); 'gap' (now - last > gap_days, nghiêm ngặt); 'overdue' (activity trong
 * lịch chưa từng có hoặc quá chu kỳ). Sắp xếp tất định. */
export function reminders(
  plots: readonly string[],
  lastAny: ReadonlyMap<string, Date>,
  lastBy: ReadonlyMap<string, Date>,
  schedule: Schedule,
  now: Date,
): Reminder[] {
  const gap = (schedule.gap_days ?? DEFAULT_GAP_DAYS) * DAY_MS;
  const acts = schedule.activities ?? {};
  const out: Reminder[] = [];
  const days = (t: Date) => Math.floor((now.getTime() - t.getTime()) / DAY_MS);
  for (const pid of plots) {
    const last = lastAny.get(pid);
    if (last === undefined || last === null) {
      out.push({ type: 'no-logs', plot: pid, activity: null, last_ts: null, days: null });
      continue;
    }
    if (now.getTime() - last.getTime() > gap) {
      out.push({ type: 'gap', plot: pid, activity: null, last_ts: last, days: days(last) });
    }
    for (const [act, interval] of Object.entries(acts)) {
      const la = lastBy.get(actKey(pid, act)) ?? null;
      if (la === null || now.getTime() - la.getTime() > interval * DAY_MS) {
        out.push({
          type: 'overdue',
          plot: pid,
          activity: act,
          last_ts: la,
          days: la === null ? null : days(la),
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      cpCmp(a.type, b.type) || cpCmp(a.plot, b.plot) || cpCmp(a.activity ?? '', b.activity ?? ''),
  );
}

/** Literal timestamptz cho SQL đối chứng — CHỈ dùng với Date do code sinh. */
export const lit = (d: Date): string => `'${pyIsoUtc(d)}'::timestamptz`;

export function reminderSql(now: Date): [string, string, string] {
  const n = lit(now);
  return [
    "select id from plots where status = 'active' order by id",
    `select plot_id, max(ts) from plot_logs where ts < ${n} group by plot_id order by plot_id`,
    `select plot_id, activity, max(ts) from plot_logs where ts < ${n}` +
      ' group by plot_id, activity order by plot_id, activity',
  ];
}

const rowsArr = async (db: Db, sql: string, args?: unknown[]): Promise<unknown[][]> =>
  (await db.query({ text: sql, values: args, rowMode: 'array' })).rows as unknown[][];

/** Gom khoảnh active + nhật ký gần nhất trước `now` rồi gọi `reminders` thuần. */
export async function dueReminders(db: Db, schedule: Schedule, now: Date): Promise<Reminder[]> {
  const [qPlots, qAny, qAct] = reminderSql(now);
  const plots = (await rowsArr(db, qPlots)).map((r) => r[0] as string);
  const lastAny = new Map((await rowsArr(db, qAny)).map((r) => [r[0] as string, r[1] as Date]));
  const lastBy = new Map(
    (await rowsArr(db, qAct)).map((r) => [actKey(r[0] as string, r[1] as string), r[2] as Date]),
  );
  return reminders(plots, lastAny, lastBy, schedule, now);
}

// docx P2 (farming-02, PL01 Vùng trồng "nhắc khoảnh lâu không có nhật ký; báo giám đốc nếu vẫn bỏ
// trống"). Đợt hợp đồng C02: NHẮC NGƯỜI PHỤ TRÁCH KHOẢNH trước, rồi mới báo GĐ. Mỗi khoảnh bỏ trống →
// 1 dòng `garden_reminders` / ĐỢT (`dot_key` = mốc nhật ký gần nhất): người phụ trách = mã NV có
// `khoanh` chứa khoảnh trong data/garden_staff.json; kênh theo data/garden_remind.json (null = CHƯA
// CHỌN → `cho_kenh`; "thu_cong" = người nhắc theo `--reminders` rồi `--mark-reminded`). Agent KHÔNG
// gửi tin và KHÔNG bao giờ ghi "đã nhắc". Có nhật ký mới → đợt cũ đóng. Báo GĐ (farming/plot_log_gap,
// 1 mục/đợt) khi khoảnh VẪN bỏ trống (chưa có nhật ký / ≥ 2×gap_days) VÀ: không nhắc được — báo
// ngay kèm lý do; hoặc đã nhắc mà quá `leo_thang_sau_ngay` (null = gap_days, GIẢ ĐỊNH) vẫn trống;
// hoặc kênh thủ công mà quá hạn đó chưa ai nhắc.
export const GAP_TYPE = 'plot_log_gap';
export const GAP_AGENT = 'agent:garden_director';
export const WHY: Record<string, string> = {
  khong_nguoi_nhan: 'khoảnh CHƯA gán người phụ trách — không nhắc được',
  cho_kenh: 'CHƯA chọn kênh nhắc nhân viên (data/garden_remind.json) — không nhắc được',
  chua_nhac: 'kênh thủ công: quá hạn mà chưa ai đánh dấu đã nhắc',
  da_nhac: 'đã nhắc người phụ trách mà vẫn bỏ trống',
};

export type RemindCfg = { kenh: null | 'thu_cong'; leo_thang_sau_ngay: number | null };

/** → {kenh, leo_thang_sau_ngay}. Thiếu file → mặc định an toàn (chưa chọn kênh); hỏng / giá trị lạ →
 * RangeError (CLI exit 2 ở --submit). */
export function loadRemindCfg(path: string = REMIND_PATH): RemindCfg {
  const name = basename(path);
  let doc: unknown;
  try {
    const raw = readFileSync(path);
    let text: string;
    try {
      text = decodeUtf8(raw);
    } catch {
      throw new RangeError(`${name} hỏng (UnicodeDecodeError)`);
    }
    try {
      doc = pyLoads(text);
    } catch {
      throw new RangeError(`${name} hỏng (JSONDecodeError)`);
    }
  } catch (e) {
    if (e instanceof RangeError) throw e;
    if ((e as { code?: string }).code === 'ENOENT') return { kenh: null, leo_thang_sau_ngay: null };
    throw new RangeError(`${name} hỏng (${pyOsName(e)})`);
  }
  if (!isObj(doc)) throw new RangeError(`${name} hỏng (AttributeError)`);
  const k = doc.kenh ?? null;
  const d = doc.leo_thang_sau_ngay ?? null;
  if (k !== null && k !== 'thu_cong') {
    throw new RangeError(
      `kenh phải null|thu_cong (Zalo/ZNS chưa có — cần quyết định lưu user_id), có ${reprV(k)}`,
    );
  }
  if (d !== null && !(isPyInt(d) && d >= 1 && d <= 90)) {
    throw new RangeError('leo_thang_sau_ngay phải null hoặc 1..90');
  }
  return { kenh: k, leo_thang_sau_ngay: d as number | null };
}

/** Mốc đợt = ts nhật ký gần nhất (UTC, %Y%m%dT%H%M%S) | 'none'. */
export function mark(r: Pick<Reminder, 'last_ts'>): string {
  return r.last_ts ? r.last_ts.toISOString().slice(0, 19).replace(/[-:]/g, '') : 'none';
}

const emptyPlots = (rems: readonly Reminder[]) =>
  rems.filter((r) => r.type === 'no-logs' || r.type === 'gap');

/** Chèn 1 dòng nhắc / khoảnh / đợt (idempotent) + đóng đợt cũ khi khoảnh đã có nhật ký mới. Cổng
 * farming-02.1 TẮT → RolloutBlocked trước mọi ghi. → {new, closed}. */
export async function syncReminders(
  db: Db,
  rems: readonly Reminder[],
  owners: ReadonlyMap<string, readonly string[]>,
  cfg: RemindCfg,
): Promise<{ new: number; closed: number }> {
  await checkGenerate(db, 'farming-02.1', 'sổ nhắc nhật ký vườn');
  return withTx(db, async (c) => {
    const sample = new Set(
      (await c.query('select id from plots where source like $1', [SAMPLE_LIKE])).rows.map(
        (r) => r.id,
      ),
    );
    const live = new Set<string>();
    let created = 0;
    for (const r of emptyPlots(rems)) {
      const dot = mark(r);
      live.add(actKey(r.plot, dot));
      const who = owners.get(r.plot)?.[0] ?? null;
      const st = who === null ? 'khong_nguoi_nhan' : cfg.kenh === null ? 'cho_kenh' : 'cho_gui';
      const ins = await c.query(
        'insert into garden_reminders (plot_id, dot_key, kind, ma_nv, status, kenh, is_sample)' +
          ' values ($1, $2, $3, $4, $5, $6, $7) on conflict (plot_id, dot_key) do nothing',
        [r.plot, dot, r.type, who, st, cfg.kenh, sample.has(r.plot)],
      );
      created += ins.rowCount ?? 0;
    }
    let closed = 0;
    const open = await c.query(
      'select id, plot_id, dot_key from garden_reminders where closed_at is null',
    );
    for (const o of open.rows) {
      if (!live.has(actKey(o.plot_id, o.dot_key))) {
        const u = await c.query(
          'update garden_reminders set closed_at = now() where id = $1 and closed_at is null',
          [o.id],
        );
        closed += u.rowCount ?? 0;
      }
    }
    return { new: created, closed };
  });
}

/** Đồng bộ sổ nhắc rồi báo GĐ vùng trồng (farming/plot_log_gap, 1 mục/đợt) → số mục mới. */
export async function escalateGaps(
  db: Db,
  rems: readonly Reminder[],
  schedule: Schedule,
  owners: ReadonlyMap<string, readonly string[]> = new Map(),
  cfg: RemindCfg | null = null,
): Promise<number> {
  const c = cfg ?? loadRemindCfg();
  await syncReminders(db, rems, owners, c);
  const gap = schedule.gap_days ?? DEFAULT_GAP_DAYS;
  const lim = 2 * gap;
  const waitS = (c.leo_thang_sau_ngay || gap) * 86_400;
  let n = 0;
  for (const r of rems) {
    if (!(r.type === 'no-logs' || (r.type === 'gap' && (r.days ?? 0) >= lim))) continue;
    const mk = mark(r);
    // Tuổi đợt/lần nhắc tính bằng đồng hồ DB (cùng nguồn với created_at).
    const row = (
      await db.query(
        'select status, ma_nv, extract(epoch from now() - created_at) as age,' +
          ' extract(epoch from now() - reminded_at) as since_rem' +
          ' from garden_reminders where plot_id = $1 and dot_key = $2',
        [r.plot, mk],
      )
    ).rows[0];
    if (row === undefined) continue;
    const since = row.since_rem === null ? null : Number(row.since_rem);
    let why: string;
    if (row.status === 'khong_nguoi_nhan' || row.status === 'cho_kenh') why = row.status;
    else if (since !== null && since >= waitS) why = 'da_nhac';
    else if (since === null && Number(row.age) >= waitS) why = 'chua_nhac';
    else continue; // đang trong hạn nhắc — chưa báo GĐ
    const oid = `gap:${r.plot}:${mk}`;
    const dup = await db.query(
      'select 1 from approval_queue where object_type = $1 and object_id = $2',
      [GAP_TYPE, oid],
    );
    if (dup.rows.length) continue;
    const what =
      r.type === 'no-logs'
        ? 'chưa có nhật ký nào'
        : `${r.days} ngày chưa có nhật ký (ngưỡng ${lim})`;
    await submit(db, {
      block: 'farming',
      objectType: GAP_TYPE,
      objectId: oid,
      title: `Khoảnh ${r.plot} bỏ trống nhật ký`,
      payload:
        `Khoảnh ${r.plot}: ${what}. Nhắc người phụ trách (${row.ma_nv || 'chưa gán'}): ` +
        `${WHY[why]}. GĐ vùng trồng chỉ đạo ghi bù hoặc ghi lý do. Agent không sửa nhật ký, không gửi tin.`,
      createdBy: GAP_AGENT,
    });
    n++;
  }
  return n;
}

export type OpenReminder = {
  id: string;
  plot_id: string;
  dot_key: string;
  ma_nv: string | null;
  status: string;
  kenh: string | null;
  created_at: Date;
  reminded_at: Date | null;
};

export async function openReminders(db: Db): Promise<OpenReminder[]> {
  return (
    await db.query<OpenReminder>(
      'select id, plot_id, dot_key, ma_nv, status, kenh, created_at, reminded_at' +
        ' from garden_reminders where closed_at is null order by created_at, id',
    )
  ).rows;
}

/** Keyword cần chú ý — CHỈ quét detail (không quét tên activity). */
export const logFlags = (detail: unknown): string[] => flagsFor('', detail);

const vnDay = (ts: Date | null): string => (ts ? vnDate(ts) : 'chưa từng');

export function fmtReminder(r: Reminder): string {
  if (r.type === 'no-logs') return `[no-logs] ${r.plot}: chưa có nhật ký nào`;
  if (r.type === 'gap') {
    return `[gap] ${r.plot}: ${r.days} ngày chưa có nhật ký (gần nhất ${vnDay(r.last_ts)})`;
  }
  const tail = r.days === null ? '' : `, ${r.days} ngày trước`;
  return `[overdue] ${r.plot}: '${r.activity}' trễ lịch (gần nhất ${vnDay(r.last_ts)}${tail})`;
}

// ------------------------------------------------------------- bản tin tuần

/** Chuỗi ngày (kiểu CLI thật, strip) / Date → ngày VN 'YYYY-MM-DD'. Sai → RangeError. */
export function coerceUntil(until: unknown): string {
  if (until instanceof Date) return vnDate(until);
  if (typeof until === 'string') {
    const d = isoDate(pyStrip(until));
    if (d !== null) return d;
    throw new RangeError(`--until sai định dạng YYYY-MM-DD: ${pyRepr(until)}`);
  }
  throw new RangeError(`until không hợp lệ: ${reprV(until)}`);
}

/** `--until` mặc định = HÔM QUA giờ VN — kỳ chỉ gồm ngày ĐÃ HẾT (nhật ký ghi sau giờ sinh bản tin
 * trong chính ngày đó vẫn vào kỳ sau). */
export const defaultUntil = (now: Date): string => addDays(vnDate(now), -1);

/** Mask SĐT/email → gộp khoảng trắng (không vỡ dòng markdown) → cắt DETAIL_MAX ký tự. */
export function cleanDetail(detail: string | null | undefined): string {
  const text = squash(maskPii(detail || ''));
  return cpLen(text) <= DETAIL_MAX ? text : `${cpSlice(text, 0, DETAIL_MAX)}…`;
}

export const sqlBlock = (sqls: readonly string[]): string[] => [
  '',
  'SQL đối chứng:',
  '```sql',
  ...sqls.map((s) => `${s};`),
  '```',
  '',
];

function periodEnd(untilD: string): Date {
  return vnMidnight(addDays(untilD, 1));
}

/** v15.2 (P8.4): kỳ có nhật ký nguồn MẪU → true (không đếm là đầu ra thật của farming-02). */
export async function bulletinSample(db: Db, until: unknown, days = 7): Promise<boolean> {
  const end = periodEnd(coerceUntil(until));
  const r = await db.query(
    'select exists (select 1 from plot_logs where source like $1 and ts >= $2 and ts < $3) as x',
    [SAMPLE_LIKE, new Date(end.getTime() - days * DAY_MS), end],
  );
  return Boolean(r.rows[0].x);
}

/** Bản tin tuần markdown TẤT ĐỊNH cho GĐ vùng trồng — kỳ = `days` ngày VN kết thúc hết ngày `until`.
 * 6 mục, mỗi mục kèm SQL đối chứng tái lập con số. Không in location/area_m2/người ghi/tọa độ. */
export async function buildBulletin(
  db: Db,
  until: unknown,
  days: unknown = 7,
  schedule: Schedule | null = null,
): Promise<string> {
  const untilD = coerceUntil(until);
  if (!validDays(days)) throw new RangeError(`days phải là số nguyên 1..366: ${reprV(days)}`);
  const sch = schedule ?? loadSchedule()[0];
  const end = periodEnd(untilD);
  const start = new Date(end.getTime() - days * DAY_MS);
  const s = lit(start);
  const e = lit(end);
  // Nhật ký "mới trong kỳ" = ts trong kỳ HOẶC (dòng thật) GHI trong kỳ — ghi bù sổ giấy không lọt
  // giữa 2 bản tin. created_at dòng thật do trigger chain ép now(); dòng mẫu loại khỏi nhánh
  // created_at vì loader nạp lại mẫu mỗi lần.
  const inPeriod =
    `(ts >= ${s} and ts < ${e}) or (source not like 'sample:%'` +
    ` and created_at >= ${s} and created_at < ${e})`;
  const firstDay = addDays(untilD, -(days - 1));
  const out: string[] = [
    `# Bản tin vùng trồng — ${firstDay} → ${untilD} (${days} ngày, giờ VN)`,
    '',
    '_Tất định, không LLM. Không chứa tọa độ/vị trí/diện tích/người ghi. Mỗi mục có SQL đối chứng tái lập con số._',
    '',
  ];

  // (1) toàn vẹn nhật ký
  const q1 = [
    'select id, problem from verify_plot_logs() order by id, problem',
    'select count(*) from plot_logs where row_hash is not null',
  ];
  const problems = await rowsArr(db, q1[0] as string);
  const nChained = (await rowsArr(db, q1[1] as string))[0]?.[0];
  out.push('## 1. Toàn vẹn nhật ký (hash chain)', '');
  if (problems.length) {
    out.push(
      `**CẢNH BÁO: ${problems.length} vấn đề** — nhật ký có thể đã bị sửa/xóa ngoài hệ thống: ` +
        problems.map(([i, p]) => `#${i} (${p})`).join(', '),
    );
  } else {
    out.push(`OK — ${nChained} nhật ký đã chain, 0 vấn đề.`);
  }
  out.push(...sqlBlock(q1));

  // (2) dữ liệu mẫu còn lại
  const q2 = [
    "select (select count(*) from plots where source like 'sample:%') as plots," +
      " (select count(*) from plot_logs where source like 'sample:%') as plot_logs",
  ];
  const [nSp, nSl] = (await rowsArr(db, q2[0] as string))[0] as [string, string];
  out.push('## 2. Dữ liệu mẫu còn lại', '');
  out.push(
    `${nSp} khoảnh mẫu, ${nSl} nhật ký mẫu` +
      (Number(nSp) || Number(nSl)
        ? ' — chờ GĐ vùng trồng ký gỡ (`--precheck` rồi `--purge-sample --by`).'
        : ' — đã sạch.'),
  );
  out.push(...sqlBlock(q2));

  // (3) nhắc lịch / gap tại cuối ngày until (VN)
  const rems = await dueReminders(db, sch, end);
  out.push(
    `## 3. Nhắc lịch & gap (tính tại hết ngày ${untilD}, gap ${sch.gap_days ?? 'None'} ngày)`,
    '',
  );
  if (!sch.activities || !Object.keys(sch.activities).length) {
    out.push('_Chưa có lịch hoạt động định kỳ — chỉ nhắc no-logs/gap._');
  }
  out.push(...(rems.length ? rems.map((r) => `- ${fmtReminder(r)}`) : ['Không có nhắc.']));
  out.push(...sqlBlock(reminderSql(end)));

  // (4) nhật ký mới trong kỳ theo khoảnh
  const q4 = [
    "select plot_id, count(*) filter (where source like 'sample:%') as mau," +
      " count(*) filter (where source not like 'sample:%')" +
      ` as that from plot_logs where ${inPeriod} group by plot_id order by plot_id`,
  ];
  const rows4 = await rowsArr(db, q4[0] as string);
  out.push('## 4. Nhật ký mới trong kỳ (ngày hoạt động hoặc ngày ghi)', '');
  if (rows4.length) {
    out.push('| Khoảnh | Thật | Mẫu |', '|---|---:|---:|');
    out.push(...rows4.map(([p, mau, that]) => `| ${p} | ${that} | ${mau} |`));
  } else {
    out.push('Không có nhật ký nào trong kỳ.');
  }
  out.push(...sqlBlock(q4));

  // (5) cảnh báo keyword — CHỈ detail
  const q5 = [
    `select id, plot_id, ts, source, detail from plot_logs where (${inPeriod})` +
      ' and detail is not null order by ts, id',
  ];
  const flagged: string[] = [];
  for (const [i, p, ts, src, detail] of await rowsArr(db, q5[0] as string)) {
    const hits = logFlags(detail);
    if (hits.length) {
      const t = ts as Date;
      const tag = String(src).startsWith('sample:') ? ' (mẫu)' : t < start ? ' (ghi bù)' : '';
      flagged.push(
        `- #${i} ${p} ${vnDay(t)}${tag} — ${hits.join(', ')}: ${cleanDetail(detail as string)}`,
      );
    }
  }
  out.push('## 5. Cảnh báo từ khóa (chỉ quét chi tiết nhật ký)', '');
  out.push(...(flagged.length ? flagged : ['Không có cảnh báo.']));
  out.push(
    '',
    '_Lọc keyword `FLAG_KEYS` trên cột detail bằng Python (lower), không quét tên hoạt động._',
  );
  out.push(...sqlBlock(q5));

  // (6) ảnh/video mới — `garden_media` nhận cả video (mp4/mov) (v14.6)
  const q6 = [
    `select plot_id, count(*) from garden_media where created_at >= ${s} and created_at < ${e}` +
      ' group by plot_id order by plot_id',
  ];
  const rows6 = await rowsArr(db, q6[0] as string);
  out.push('## 6. Ảnh/video vườn mới (đã gỡ EXIF/GPS)', '');
  if (rows6.length) {
    out.push('| Khoảnh | Ảnh/video |', '|---|---:|');
    out.push(...rows6.map(([p, n]) => `| ${p} | ${n} |`));
  } else {
    out.push('Không có ảnh/video mới.');
  }
  out.push(...sqlBlock(q6));
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------- CLI

export type GardenDirectorOpts = {
  bulletin?: boolean;
  remind?: boolean;
  submit?: boolean;
  verify?: boolean;
  precheck?: boolean;
  purgeSample?: boolean;
  adoptPlot?: string;
  reminders?: boolean;
  markReminded?: string;
  by?: string;
  until?: string;
  days?: string;
  outDir?: string;
  schedule?: string;
};

export type GardenDirectorDeps = {
  connect?: () => Promise<DbLease | null>;
  io?: Io;
  now?: () => Date;
  env?: Env;
  /** {khoảnh: [mã NV]} — mặc định `plotOwners()` của data/garden_staff.json */
  owners?: () => Map<string, string[]>;
  remindPath?: string;
};

const PROG = 'garden-director';
const DB_DOWN = 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

function printPrecheck(pre: Precheck, io: Io): void {
  io.out(`[precheck] dữ liệu mẫu: ${pre.plots} khoảnh, ${pre.plot_logs} nhật ký`);
  if (!pre.blockers.length) {
    io.out('[precheck] không có blocker — GĐ vùng trồng có thể ký gỡ (--purge-sample --by)');
  }
  for (const b of pre.blockers) {
    if (b.kind === 'plot_log') {
      io.out(
        `[blocker] nhật ký #${b.id} (${b.source}, ${b.day}) trỏ khoảnh mẫu ${b.plot_id} — đã chain, ` +
          `KHÔNG chuyển/sửa được: GĐ vùng trồng ký nhận khoảnh (--adopt-plot ${b.plot_id} --by "<tên>")`,
      );
    } else {
      io.out(
        `[blocker] ảnh #${b.id} trỏ khoảnh mẫu ${b.plot_id} — chuyển garden_media.plot_id sang khoảnh ` +
          `thật hoặc nhận khoảnh (--adopt-plot ${b.plot_id} --by)`,
      );
    }
  }
}

/** `python -m agents.garden_director` → exit: 0 ok · 1 lỗi lịch/blocker/từ chối · 2 sai tham số /
 * DB down ở thao tác chặt / lỗi DB giữa gỡ mẫu. */
export async function gardenDirectorMain(
  o: GardenDirectorOpts,
  d: GardenDirectorDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const now = d.now ?? (() => new Date());
  const usage = (m: string) => {
    io.err(`${PROG}: error: ${m}`);
    return 2;
  };
  const days = o.days === undefined ? 7n : pyInt(o.days);
  if (days === null) return usage(`argument --days: invalid int value: '${o.days}'`);
  const markId = o.markReminded === undefined ? null : pyInt(o.markReminded);
  if (o.markReminded !== undefined && markId === null) {
    return usage(`argument --mark-reminded: invalid int value: '${o.markReminded}'`);
  }
  const ops = [
    o.bulletin,
    o.remind,
    o.verify,
    o.precheck,
    o.purgeSample,
    Boolean(o.adoptPlot),
    o.reminders,
    markId !== null && markId !== 0n,
  ];
  if (ops.filter(Boolean).length !== 1) {
    return usage(
      'chọn đúng 1 thao tác: --bulletin | --remind | --verify | --precheck | --purge-sample | ' +
        '--adopt-plot | --reminders | --mark-reminded',
    );
  }
  const by = pyStrip(o.by ?? '');
  if (markId !== null && !by) return usage('--mark-reminded cần --by "<tên người đã nhắc>"');
  if (o.submit && !o.remind) return usage('--submit chỉ đi với --remind');
  if (o.adoptPlot !== undefined && !pyStrip(o.adoptPlot))
    return usage('--adopt-plot cần mã khoảnh');
  if ((o.purgeSample || o.adoptPlot) && !by) {
    const op = o.purgeSample ? '--purge-sample' : '--adopt-plot';
    return usage(`${op} cần --by "<tên GĐ vùng trồng>" (người thật ký — agent không tự làm)`);
  }
  let until: string | null = null;
  if (o.bulletin) {
    try {
      until = o.until ? coerceUntil(o.until) : defaultUntil(now());
    } catch (e) {
      return usage((e as Error).message);
    }
    if (!validDays(Number(days))) return usage('--days phải trong 1..366');
  }
  let schedule: Required<Schedule> | null = null;
  if (o.bulletin || o.remind) {
    try {
      const [s, warns] = loadSchedule(o.schedule ?? SCHEDULE_PATH);
      schedule = s;
      for (const w of warns) io.out(`[warn] ${w}`);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      io.err(`[err] ${e.message}`);
      return 1;
    }
  }

  const strict = Boolean(o.verify || o.purgeSample || o.adoptPlot);
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    if (strict) {
      io.err(`[err] ${DB_DOWN}`);
      return 2;
    }
    io.out(`[warn] chưa nạp — ${DB_DOWN}`);
    return 0;
  }
  const db = lease.db;
  try {
    if (o.purgeSample || o.adoptPlot) {
      // v14.2: gỡ mẫu / nhận khoảnh = quyết định của GĐ vùng trồng được Bên B ủy quyền (khối farming).
      const why = await cliGate(
        db,
        o.by,
        'farming',
        o.purgeSample ? 'purge_sample' : 'adopt_plot',
        'plots',
        o.adoptPlot || 'sample',
        { env, warn: io.err },
      );
      if (why) {
        io.err(`[err] ${why} — không đổi gì`);
        return 1;
      }
    }
    if (o.verify) {
      const probs = await verify(db);
      for (const [i, p] of probs) io.out(`[verify] #${i}: ${p}`);
      if (probs.length) {
        io.out(`[verify] ${probs.length} vấn đề — nhật ký bị sửa/xóa ngoài hệ thống`);
        return 1;
      }
      io.out('[verify] OK — chuỗi nhật ký nguyên vẹn');
      return 0;
    }
    if (o.remind) {
      const sch = schedule as Required<Schedule>;
      const rems = await dueReminders(db, sch, now());
      for (const r of rems) io.out(fmtReminder(r));
      if (!rems.length) io.out('[remind] không có nhắc');
      if (o.submit) {
        let cfg: RemindCfg;
        let n: number;
        try {
          cfg = loadRemindCfg(d.remindPath);
          n = await escalateGaps(
            db,
            rems,
            sch,
            (d.owners ?? (() => plotOwners(undefined, io.out)))(),
            cfg,
          );
        } catch (e) {
          if (e instanceof RangeError) {
            io.err(`[err] ${e.message}`); // gồm RolloutBlocked (tắt)
            return 2;
          }
          if (e instanceof DirectorConfigError) {
            io.err(`[err] cấu hình khối: ${e.message}`);
            return 1;
          }
          throw e;
        }
        if (cfg.kenh === null) {
          io.out(
            '[blocked] chưa chọn kênh nhắc nhân viên (data/garden_remind.json kenh=null — D-KH-09): ' +
              'KHÔNG ai được nhắc; khoảnh bỏ trống báo thẳng GĐ',
          );
        }
        io.out(`[remind] báo GĐ vùng trồng: ${n} mục mới (plot_log_gap)`);
      }
      return 0;
    }
    if (o.reminders) {
      const rows = await openReminders(db);
      for (const r of rows) {
        const state = r.reminded_at ? 'đã nhắc' : r.status;
        io.out(
          `#${r.id} khoảnh ${r.plot_id} đợt ${r.dot_key} · người phụ trách ${r.ma_nv || '—'} · ` +
            `${state} · kênh ${r.kenh || 'chưa chọn'}`,
        );
      }
      io.out(`[reminders] ${rows.length} đợt đang mở`);
      return 0;
    }
    if (markId !== null) {
      const why = await cliIdentity(db, o.by, 'garden_reminder', String(markId), {
        action: 'mark_reminded',
        env,
      });
      if (why) {
        io.err(`[err] ${why} — không đổi gì`);
        return 1;
      }
      let ok: boolean;
      try {
        ok = (
          await callHuman(
            db,
            'select garden_reminder_done_human($1, $2) as ok',
            [String(markId), by],
            {
              by: o.by,
              block: 'farming',
              action: 'mark_reminded',
              objectType: 'garden_reminder',
              objectId: String(markId),
              env,
            },
          )
        ).rows[0].ok;
      } catch (e) {
        if (!(e instanceof HumanDenied)) throw e;
        io.err(`[err] DB từ chối: ${e.message} — không đổi gì`);
        return 1;
      }
      if (!ok) {
        io.err(
          `[err] #${markId} không ở trạng thái chờ nhắc thủ công (đã nhắc / đã đóng / chưa có kênh / ` +
            'chưa gán người) — không đổi gì',
        );
        return 1;
      }
      io.out(`[ok] #${markId} đã nhắc — ${by}`);
      return 0;
    }
    if (o.precheck) {
      printPrecheck(await samplePrecheck(db), io);
      return 0;
    }
    if (o.purgeSample) {
      let res: PurgeResult;
      try {
        res = await purgeSample(db, o.by, env);
      } catch (e) {
        if (!(e instanceof HumanDenied)) throw e;
        io.err(`[err] DB từ chối: ${e.message} — không đổi gì`);
        return 1;
      }
      if (!res.ok) {
        printPrecheck(res, io);
        io.err('[err] còn blocker — KHÔNG gỡ. Xử lý theo từng [blocker] ở trên rồi chạy lại.');
        return 1;
      }
      io.out(
        `[done] đã gỡ ${res.plots} khoảnh mẫu, ${res.plot_logs} nhật ký mẫu — ghi agent_action_log ` +
          `'${PURGE_ACTION}'`,
      );
      return 0;
    }
    if (o.adoptPlot) {
      let res: AdoptResult;
      try {
        res = await adoptPlot(db, o.adoptPlot, o.by, env);
      } catch (e) {
        if (!(e instanceof HumanDenied)) throw e;
        res = { ok: false, reason: `DB từ chối: ${e.message}` };
      }
      if (!res.ok) {
        io.err(`[err] ${res.reason} — không đổi gì`);
        return 1;
      }
      io.out(
        `[done] khoảnh ${res.plot_id} thành khoảnh thật (source ${ADOPT_SOURCE}) — ghi agent_action_log ` +
          `'${ADOPT_ACTION}'. Vị trí/diện tích/số cây vẫn là giá trị MẪU — cập nhật số thật.`,
      );
      return 0;
    }
    const u = until as string;
    const text = await buildBulletin(db, u, Number(days), schedule);
    const path = await writeReport(
      text,
      o.outDir ?? REPORTS_DIR,
      `garden-week-${u}.md`,
      await bulletinSample(db, u, Number(days)),
    );
    io.out(`[done] ${path}`);
    return 0;
  } catch (e) {
    if (e instanceof GardenRuntimeError) {
      io.err(`[err] ${e.message}`);
      return 2;
    }
    if (isDbError(e)) {
      const first = String((e as Error).message ?? '').split('\n')[0];
      io.err(
        `[err] lỗi DB ${pgErrName(e)}: ${first} — đã chạy \`python scripts/apply_schema.py\`?`,
      );
      return strict ? 2 : 1;
    }
    throw e;
  } finally {
    await lease.release();
  }
}
