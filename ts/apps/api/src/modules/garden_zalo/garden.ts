import { connectDatabaseUrl } from '@samsam/core/db';
import type { Db } from '@samsam/core/ops/deps';
import { pyInt } from '@samsam/core/ops/py';
import { FLAG_KEYS } from '@samsam/core/ops/report';
import { HumanDenied } from '@samsam/core/security/auth';
import { cpHead, pyReprValue, pyStr, pyStrip, stripCombining } from '@samsam/core/security/py';

// Port `agents/garden.py` (WS3 — agent nhật ký vùng trồng: form/chat → chuẩn hóa → cảnh báo).
//  - Ghi `plot_logs` (FK plots, unique (plot_id, ts, activity)); trigger DB nối hash chain.
//  - Chuẩn hóa hoạt động: gấp bỏ dấu → ACTIVITY_VOCAB / ALIASES; lạ vẫn ghi nguyên văn + cảnh báo.
//  - Nhật ký là thao tác NGƯỜI ghi tay — không LLM, không tự sinh (message là template viết tay).
//  - v14.3: đường ghi tay KHÔNG qua cổng rollout (dữ liệu gốc, không phải đầu ra AI); tắt
//    farming-01 (Zalo) không làm mất đường ghi tay.
// KHÁC Python có chủ đích: thời điểm in ra luôn theo UTC (Python in theo múi giờ của --ts mà vẫn
// ghi nhãn "UTC"); `--ts` dạng tuần ISO (2026-W41-5) bị từ chối (chặt hơn).

export const DEFAULT_GAP_DAYS = 14;
export const RECENT_LIMIT = 20;
export const SOURCE = 'manual:garden';

export const ACTIVITY_VOCAB = [
  'trồng',
  'tưới',
  'bón',
  'làm cỏ',
  'kiểm tra sâu bệnh',
  'phun thuốc sinh học',
  'thu hoạch',
  'ghi nhận',
] as const;

// Alias gấp-không-dấu → hoạt động chuẩn (gõ tắt, sai chính tả nhẹ vẫn chuẩn hóa được).
export const ALIASES: Readonly<Record<string, string>> = {
  tuoi: 'tưới',
  'tuoi nuoc': 'tưới',
  'tuoi phun suong': 'tưới',
  bon: 'bón',
  'bon phan': 'bón',
  'lam co': 'làm cỏ',
  co: 'làm cỏ',
  'sau benh': 'kiểm tra sâu bệnh',
  'kiem tra': 'kiểm tra sâu bệnh',
  'kiem tra sau benh': 'kiểm tra sâu bệnh',
  'phun thuoc': 'phun thuốc sinh học',
  'phun thuoc sinh hoc': 'phun thuốc sinh học',
  'thu hoach': 'thu hoạch',
  trong: 'trồng',
  'trong moi': 'trồng',
  'ghi nhan': 'ghi nhận',
  khac: 'ghi nhận',
};

const INSERT_SQL =
  'insert into plot_logs (plot_id, ts, activity, detail, author, source) ' +
  'values ($1, $2, $3, $4, $5, $6) returning id';

/** lower + strip + bỏ dấu (NFD, combining class ≠ 0; đ→d). */
export function fold(s: string | null | undefined): string {
  return stripCombining(pyStrip((s ?? '').toLowerCase()).normalize('NFD')).replaceAll('đ', 'd');
}

const FOLDED_VOCAB = new Map<string, string>(ACTIVITY_VOCAB.map((a) => [fold(a), a]));

/** [hoạt động, đã biết]. Gấp → vocab/alias → chuẩn; lạ → nguyên văn đã strip + false; rỗng → 'ghi nhận'. */
export function normalizeActivity(raw: unknown): [string, boolean] {
  if (typeof raw !== 'string' || !pyStrip(raw)) return ['ghi nhận', false];
  const f = fold(raw);
  const v = FOLDED_VOCAB.get(f);
  if (v !== undefined) return [v, true];
  if (Object.hasOwn(ALIASES, f)) return [ALIASES[f] as string, true];
  return [pyStrip(raw), false];
}

// `_parse_ts` = strptime "%Y-%m-%dT%H:%M:%SZ" (không bắt buộc 2 chữ số, không phân biệt hoa thường).
const STRPTIME_RE =
  /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])T(2[0-3]|[01]\d|\d):([0-5]\d|\d):(6[01]|[0-5]\d|\d)Z$/i;
// `date.fromisoformat` (YYYY-MM-DD | YYYYMMDD) + `datetime.fromisoformat` (ký tự phân cách bất kỳ,
// giờ HH[:MM[:SS[.f]]] hoặc dạng gọn, múi Z|±HH[:MM[:SS]]). shortcut: dạng tuần ISO không nhận.
const DATE_RE = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))$/u;
const DT_RE =
  /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?:.)(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?)?$/su;

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number | null {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const b = new Date(t);
  // Date.UTC coi năm 0–99 là 1900+ — năm ISO 4 chữ số < 100 không gặp ở nhật ký; vẫn kiểm vòng.
  return b.getUTCFullYear() === y && b.getUTCMonth() === mo - 1 && b.getUTCDate() === d ? t : null;
}

function tzOffsetMs(tz: string | undefined): number | null {
  if (!tz || tz === 'Z') return 0;
  const t = tz.replaceAll(':', '').replace(/[.,]\d+$/, '');
  const oh = Number(t.slice(1, 3));
  const om = Number(t.slice(3, 5) || 0);
  const os = Number(t.slice(5, 7) || 0);
  if (oh > 23 || om > 59 || os > 59) return null;
  return (tz[0] === '-' ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
}

/** Python `_coerce_ts`: Date / chuỗi ISO → Date (thời điểm tuyệt đối; không múi giờ → UTC) | null. */
export function coerceTs(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = pyStrip(v);
  if (!s) return null;
  let m = STRPTIME_RE.exec(s);
  if (m) {
    const [y, mo, d, h, mi, sec] = m.slice(1, 7).map((x) => Number(pyStrip(x as string))) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const t = utc(y, mo, d, h, mi, sec);
    if (t !== null) return new Date(t);
  }
  m = DATE_RE.exec(s);
  if (m) {
    const y = Number(m[1] ?? m[4]);
    const t = utc(y, Number(m[2] ?? m[5]), Number(m[3] ?? m[6]));
    return t === null ? null : new Date(t);
  }
  m = DT_RE.exec(s);
  if (!m) return null;
  const ms = Math.floor(Number(`0.${m[10] ?? '0'}`) * 1000);
  const t = utc(
    Number(m[1] ?? m[4]),
    Number(m[2] ?? m[5]),
    Number(m[3] ?? m[6]),
    Number(m[7]),
    Number(m[8] ?? 0),
    Number(m[9] ?? 0),
    ms,
  );
  const off = tzOffsetMs(m[11]);
  return t === null || off === null ? null : new Date(t - off);
}

/** Từ khóa FLAG_KEYS khớp trong `detail` (KHÔNG quét `activity` — vocab 'kiểm tra sâu bệnh' tự chứa
 * 'sâu bệnh' sẽ cờ MỌI nhật ký kiểm tra định kỳ; audit-bù v2.1). */
export function flagsFor(_activity: string, detail: unknown): string[] {
  const hay = (detail ? pyStr(detail) : '').toLowerCase();
  return FLAG_KEYS.filter((k) => hay.includes(k));
}

/** 'YYYY-MM-DD HH:MM' theo UTC. */
export const fmtUtc = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

function warnings(act: string, known: boolean, when: Date, detail: unknown): string[] {
  const w = known ? [] : [`hoạt động '${act}' chưa có trong vocab — ghi nguyên văn`];
  // Dung sai 1 ngày: UI ghép ngày local + giờ UTC → user VN sáng sớm tạo ts tương lai giả ≤ 7h.
  if (when.getTime() > Date.now() + 86_400_000)
    w.push('ts ở tương lai — kiểm tra lại ngày nhật ký');
  for (const k of flagsFor(act, detail)) w.push(`nhật ký có dấu hiệu cần chú ý: '${k}'`);
  return w;
}

const dbCode = (e: unknown): string | undefined => (e as { code?: string })?.code;

/** INSERT 1 nhật ký → [id | null, cảnh báo]. FK (23503) / trùng (23505) → cảnh báo, KHÔNG ném. */
export async function addLog(
  db: Db,
  plotId: string | null | undefined,
  ts: unknown,
  activity: unknown,
  detail: string | null = null,
  author: string | null = null,
  source: string = SOURCE,
): Promise<[bigint | null, string[]]> {
  const pid = pyStrip(plotId ?? '');
  if (!pid) return [null, ['thiếu --plot']];
  const when = coerceTs(ts);
  if (when === null)
    return [null, [`ts không hợp lệ: ${pyReprValue(ts)} (ISO YYYY-MM-DD[THH:MM:SS])`]];
  const [act, known] = normalizeActivity(activity);
  const warns = warnings(act, known, when, detail);
  try {
    const r = await db.query<{ id: string }>(INSERT_SQL, [
      pid,
      when,
      act,
      detail || null,
      author || null,
      source,
    ]);
    return [r.rows[0] ? BigInt(r.rows[0].id) : null, warns];
  } catch (e) {
    if (dbCode(e) === '23503')
      return [null, [`khoảnh '${pid}' không tồn tại trong bảng plots — thêm khoảnh trước`]];
    if (dbCode(e) === '23505')
      return [null, [`đã có nhật ký trùng: ${pid} ${fmtUtc(when)} '${act}'`]];
    throw e;
  }
}

/** r12 UI-01: ghi nhật ký NHẬP TAY bằng login Postgres RIÊNG của người (function
 * `plot_log_add_human` — người ghi = người của login, khối farming). 42501 → HumanDenied; lỗi dữ
 * liệu khác của DB → [null, [lý do]]. */
export async function addLogHuman(
  db: Db,
  plotId: string | null | undefined,
  ts: unknown,
  activity: unknown,
  detail: string | null,
  by: string,
): Promise<[bigint | null, string[]]> {
  const pid = pyStrip(plotId ?? '');
  if (!pid) return [null, ['thiếu khoảnh']];
  const when = coerceTs(ts);
  if (when === null) return [null, [`ts không hợp lệ: ${pyReprValue(ts)}`]];
  const [act, known] = normalizeActivity(activity);
  const warns = warnings(act, known, when, detail);
  try {
    const r = await db.query<{ id: string | null }>(
      'select plot_log_add_human($1, $2, $3, $4, $5) as id',
      [pid, when, act, detail || null, by],
    );
    const id = r.rows[0]?.id;
    return [id === null || id === undefined ? null : BigInt(id), warns];
  } catch (e) {
    if (dbCode(e) === '23505')
      return [null, [`đã có nhật ký trùng: ${pid} ${fmtUtc(when)} '${act}'`]];
    const code = dbCode(e);
    if (typeof code !== 'string') throw e; // không phải lỗi Postgres
    const why = cpHead((e as Error).message || (e as Error).name, 200);
    if (code === '42501') throw new HumanDenied(why);
    return [null, [`DB từ chối ghi: ${why}`]];
  }
}

/** [id, location] các khoảnh active (dữ liệu cho form chọn khoảnh). */
export async function activePlots(db: Db): Promise<[string, string][]> {
  const r = await db.query<{ id: string; loc: string }>(
    "select id, coalesce(location, '') as loc from plots where status = 'active' order by id",
  );
  return r.rows.map((x) => [x.id, x.loc]);
}

export type LogRow = {
  ts: Date;
  plot_id: string;
  activity: string;
  detail: string | null;
  author: string | null;
  source: string;
};

/** Nhật ký mới nhất trước. */
export async function recentLogs(db: Db, limit = RECENT_LIMIT): Promise<LogRow[]> {
  const r = await db.query<LogRow>(
    'select ts, plot_id, activity, detail, author, source from plot_logs ' +
      'order by ts desc, id desc limit $1',
    [limit],
  );
  return r.rows;
}

export type Anomaly = {
  type: 'no-logs' | 'gap' | 'keyword';
  plot: string;
  ts: Date | null;
  msg: string;
};

/** no-logs (khoảnh active chưa có nhật ký) · gap (max(ts) cũ hơn gapDays) · keyword (nhật ký trong
 * gapDays gần có FLAG_KEYS). */
export async function anomalyCheck(
  db: Db,
  gapDays = DEFAULT_GAP_DAYS,
  now: Date = new Date(),
): Promise<Anomaly[]> {
  const horizon = new Date(now.getTime() - gapDays * 86_400_000);
  const out: Anomaly[] = [];
  const last = new Map<string, Date>();
  const lr = await db.query<{ plot_id: string; mx: Date }>(
    'select plot_id, max(ts) as mx from plot_logs group by plot_id',
  );
  for (const x of lr.rows) last.set(x.plot_id, x.mx);
  for (const [pid] of await activePlots(db)) {
    const mx = last.get(pid);
    if (mx === undefined || mx === null) {
      out.push({ type: 'no-logs', plot: pid, ts: null, msg: `${pid}: chưa có nhật ký nào` });
    } else if (mx < horizon) {
      const days = Math.floor((now.getTime() - mx.getTime()) / 86_400_000);
      out.push({ type: 'gap', plot: pid, ts: mx, msg: `${pid}: không có nhật ký ${days} ngày` });
    }
  }
  const kr = await db.query<{ ts: Date; plot_id: string; activity: string; detail: string | null }>(
    'select ts, plot_id, activity, detail from plot_logs where ts >= $1 order by ts desc',
    [horizon],
  );
  for (const x of kr.rows) {
    const hits = flagsFor(x.activity, x.detail);
    if (hits.length) {
      out.push({
        type: 'keyword',
        plot: x.plot_id,
        ts: x.ts,
        msg: `${x.plot_id}: ${x.activity} — ${hits.join(', ')}`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ CLI `python -m agents.garden`

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };

export type GardenOpts = {
  check?: boolean;
  gapDays?: string;
  plot?: string;
  activity?: string;
  detail?: string;
  author?: string;
  ts?: string;
};

const DB_ERR = 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

/** `python -m agents.garden` → exit: 0 ok · 2 sai tham số / DB down khi ghi / không ghi được. */
export async function gardenMain(
  o: GardenOpts,
  d: { connect?: () => Promise<DbLease | null>; io?: Io; now?: () => Date } = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (m: string) => {
    io.err(`garden: error: ${m}`);
    return 2;
  };
  const gap = o.gapDays === undefined ? 14n : pyInt(o.gapDays);
  if (gap === null) return usage(`argument --gap-days: invalid int value: '${o.gapDays}'`);
  if (o.check && (o.plot || o.activity)) return usage('--check không đi với --plot/--activity');
  if (!o.check && (!o.plot || !o.activity))
    return usage('ghi nhật ký cần --plot và --activity (hoặc dùng --check)');
  const lease = await (d.connect ?? connectDatabaseUrl)();
  try {
    if (o.check) {
      if (lease === null) {
        io.out(`[warn] chưa nạp — ${DB_ERR}`);
        return 0;
      }
      const items = await anomalyCheck(lease.db, Number(gap));
      if (!items.length)
        io.out('[check] không có bất thường — mọi khoảnh active đều có nhật ký gần đây');
      for (const it of items) io.out(`[${it.type}] ${it.msg}`);
      return 0;
    }
    if (lease === null) {
      io.err(`[error] ${DB_ERR} — không ghi được`);
      return 2;
    }
    // Như Python: --ts chỉ kiểm ở nhánh ghi, SAU khi có kết nối (--check bỏ qua --ts)
    const ts = o.ts ? coerceTs(o.ts) : (d.now ?? (() => new Date()))();
    if (o.ts && ts === null) return usage('--ts sai định dạng ISO');
    const [lid, warns] = await addLog(
      lease.db,
      o.plot,
      ts,
      o.activity,
      o.detail ?? null,
      o.author ?? null,
    );
    for (const w of warns) io.out(`[warn] ${w}`);
    if (lid === null) return 2;
    io.out(`[done] nhật ký #${lid}: ${pyStrip(o.plot as string)} — ${fmtUtc(ts as Date)} UTC`);
    return 0;
  } finally {
    await lease?.release();
  }
}
