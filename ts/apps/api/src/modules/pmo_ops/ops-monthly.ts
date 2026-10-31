import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cleanDetail } from '@samsam/core/ops/job-runs';
import { addDays, businessDeadline, periodBounds, vnDate, vnFormat } from '@samsam/core/ops/period';
import { cpLen, cpSlice, squash } from '@samsam/core/ops/py';
import { cpCmp, readUtf8Sig } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { DATA_DIR, dataPath, REPO_ROOT } from '@samsam/core/paths';
import { pgErrName, pyDumps } from '@samsam/core/rollout/counters';
import { blocked, holidayWarning, loadShift, sayBlocked } from '@samsam/core/rollout/rollout';
import { isHuman } from '@samsam/core/security/auth';
import { pyStrip, pyTruthy } from '@samsam/core/security/py';
import type { DbLease } from '../channels/channels.command.js';
import { CONV_FILES, dedupKey, iterConvlog, parseTs, type Rec } from '../sales_director/convlog.js';
import { cskhObjectId, loadSalesConfig } from '../sales_director/sales-director.service.js';
import * as oi from './ops-incidents.js';
import { errName, fromIso, isoDate, isoUtc, pyFixed, vnAt } from './py.js';

// Port `scripts/ops_monthly.py` (v12.6 B6, data_platform-08) — báo cáo vận hành tháng gửi Bên B
// (PL02 mục 3 "trước ngày 05 hằng tháng" + tiêu chí kỹ thuật PL02 mục 2 + tài sản hợp tác PL04 mục 3).
// CHỈ ĐỌC (SELECT + đọc file), 0 LLM, KHÔNG gửi đi — người Bên A gửi file. Mỗi số kèm NGUỒN; thiếu
// nguồn → "chưa có dữ liệu" (không suy, không điền 0); mẫu số 0 → "—". `--snapshot` chụp dữ kiện chat
// KHÔNG PII vào `chat_kpi_live` (convlog chỉ giữ 30 ngày); `--mark-sent` = NGƯỜI GỬI xác nhận (1 dòng
// `agent_action_log` kèm sha256 file). Tháng tương lai / sai định dạng / danh mục tài sản hỏng → exit 2
// TRƯỚC connect, không ghi file; DB down → vẫn ghi báo cáo "chưa có dữ liệu", exit 1.

export const ASSETS = dataPath('tai_san_hop_tac.json');
export const INVENTORY_KEYS = ['vi_tri', 'phien_ban', 'chu_quan', 'quyen_truy_cap'];
export const UNCONFIRMED = 'chưa xác nhận';
export const MISSING = 'missing';
export const NO_DATA = 'chưa có dữ liệu';
export const CSKH_HOURS = 2; // PL02 mục 3: 02 giờ làm việc
export const CSKH_TARGET = 90.0; // ≥ 90%
export const ALERT_ACK_MS = 2 * 3600_000; // 02 giờ đồng hồ, kể cả cuối tuần/Tết
export const CHAT_LIMIT_MS = 30_000; // PL02 mục 2: phản hồi tự động ≤ 30 giây
export const DRILL_MOCS = ['2026-11-30', '2026-12-18']; // sau đó mỗi quý
export const UNAPPROVED = ['thieu_ban_duyet', 'lech_ban_duyet'];
export const NO_PAPER_AD = ['ruou_cam_quang_cao', 'sku_chua_xnqc'];
export const DONE_REASONS = ['da_sua', 'da_go'];
export const SCOPE_OK = 'Đạt trong phạm vi đã rà';
export const CODE_DIRS = [
  'agents',
  'app',
  'connectors',
  'crawler',
  'ingest',
  'pipelines',
  'scripts',
];
export const CONSENT_REPLY_ROUTES = [
  'consent_granted',
  'consent_withdrawn',
  'consent_withdrawn_fail',
];
export const FEATURE = 'data_platform-08';
const ASSET_KEYS = ['hang_muc', 'mo_ta', 'noi_luu', 'ben_quan_ly'];
// Python `(\d{4})-(0[1-9]|1[0-2])` — `\d` Unicode (int() nhận chữ số Unicode).
const MONTH_RE = /^(\p{Nd}{4})-(0[1-9]|1[0-2])$/u;

/** Tham số/cấu hình sai — exit 2, không connect, không ghi file. */
export class UsageError extends RangeError {
  override name = 'UsageError';
}

/** Python `int()` trên chuỗi chữ số Unicode (Nd: mỗi dải bắt đầu bằng chữ số 0). */
function ndInt(s: string): number {
  let n = 0;
  for (const c of s) {
    let cp = c.codePointAt(0) as number;
    const self = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) cp--;
    n = n * 10 + ((self - cp) % 10);
  }
  return n;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const ym = (d: Date) => vnFormat(d, '%Y-%m');

// ------------------------------------------------------------------ đầu vào

/** 'YYYY-MM' → [đầu tháng, đầu tháng sau) giờ VN. Sai/tương lai → UsageError. */
export function monthBounds(month: unknown, now: Date): [Date, Date] {
  const m = typeof month === 'string' ? MONTH_RE.exec(pyStrip(month)) : null;
  // KHÁC Python có chủ đích: năm 0000 (Python ValueError → traceback) → UsageError exit 2.
  const y = m ? ndInt(m[1] as string) : 0;
  if (m === null || y < 1) throw new UsageError('--month cần dạng YYYY-MM');
  const [start, end] = periodBounds('month', `${String(y).padStart(4, '0')}-${m[2]}-01`);
  if (start > now) throw new UsageError(`tháng ${month} chưa bắt đầu`);
  return [start, end];
}

export type Assets = {
  cap_nhat: string;
  items: Record<string, string>[];
  excluded: string[];
  trang_thai: string;
  quyen_cao_nhat: string;
};

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonblank = (v: unknown): v is string => typeof v === 'string' && pyStrip(v) !== '';
const orUnconfirmed = (v: unknown) => (nonblank(v) ? pyStrip(v) : UNCONFIRMED);

/** Danh mục tài sản PL04 → đã kiểm. Thiếu/hỏng/rỗng → UsageError. */
export function loadAssets(path: string = ASSETS): Assets {
  const name = basename(path);
  let doc: unknown;
  try {
    doc = JSON.parse(readUtf8Sig(path));
  } catch (e) {
    const t = (e as { pyType?: string }).pyType;
    if (t === 'FileNotFoundError') throw new UsageError(`không có ${name}`);
    throw new UsageError(`${name} hỏng: ${t ?? 'JSONDecodeError'}`);
  }
  if (!isDict(doc)) throw new UsageError('danh mục tài sản: không phải object JSON');
  // Python `date.fromisoformat(str(v))`: chỉ chuỗi/số mới có thể ra ngày (str(list) không bao giờ).
  const raw = doc.cap_nhat;
  const upd = typeof raw === 'string' || typeof raw === 'number' ? isoDate(String(raw)) : null;
  if (upd === null) throw new UsageError('cap_nhat: cần ngày YYYY-MM-DD');
  const items = doc.hang_muc;
  if (
    !Array.isArray(items) ||
    !items.length ||
    !items.every((i) => isDict(i) && ASSET_KEYS.every((k) => nonblank(i[k])))
  ) {
    throw new UsageError(`hang_muc: cần list không rỗng, mỗi mục đủ ${ASSET_KEYS.join(', ')}`);
  }
  const excl = Object.hasOwn(doc, 'khong_thuoc_tai_san_hop_tac')
    ? doc.khong_thuoc_tai_san_hop_tac
    : [];
  if (!Array.isArray(excl) || !excl.every(nonblank)) {
    throw new UsageError('khong_thuoc_tai_san_hop_tac: cần list chuỗi');
  }
  // v14.6 (PL01 mục 8b–c, PL04 mục 3): 4 cột kiểm kê — thiếu/rỗng/sai kiểu → "chưa xác nhận".
  const out = (items as Record<string, unknown>[]).map((i) => {
    const r: Record<string, string> = {};
    for (const k of ASSET_KEYS) r[k] = pyStrip(i[k] as string);
    for (const k of INVENTORY_KEYS) r[k] = orUnconfirmed(i[k]);
    return r;
  });
  return {
    cap_nhat: upd,
    items: out,
    excluded: (excl as string[]).map(pyStrip),
    trang_thai: orUnconfirmed(doc.trang_thai),
    quyen_cao_nhat: orUnconfirmed(doc.nguoi_giu_quyen_cao_nhat),
  };
}

// ------------------------------------------------------------------ DB

export type AlertRow = [string | number, Date, Date | null];
export type TakedownRow = [string, Date, Date, Date | null, string | null];
export type CskhRow = [string, string, Date];
export type CostRow = [string, number, number, number];
/** (qkey sha256, ts, channel, is_question, handled_by_bot, group_oid, reply_ms) — KHÔNG PII. */
export type Fact = [
  string,
  Date,
  string | null,
  boolean,
  boolean | null,
  string | null,
  number | null,
];
export type Posts = { scans: number; unapproved: number; no_paper: number };
export type SentRow = [Date, string, string] | [];

const num = (v: unknown) => Number(v);

async function qAlerts(db: Db, start: Date, end: Date): Promise<AlertRow[]> {
  const { rows } = await db.query(
    "select r.id, r.ts, a.acked_at from red_alerts r left join red_alert_acks a on a.alert_id = r.id where not (r.detail ? 'escalation_of') and r.ts >= $1 and r.ts < $2 order by r.id",
    [start, end],
  );
  return rows.map((r) => [String(r.id), r.ts, r.acked_at]);
}

async function qTakedown(db: Db, start: Date, end: Date): Promise<TakedownRow[]> {
  const { rows } = await db.query(
    'select distinct on (url, first_detected_at) url, first_detected_at, due_at, closed_at, close_reason from channel_posts where severity is not null and first_detected_at >= $1 and first_detected_at < $2 order by url, first_detected_at, id desc',
    [start, end],
  );
  return rows.map((r) => [r.url, r.first_detected_at, r.due_at, r.closed_at, r.close_reason]);
}

async function qPosts(db: Db, start: Date, end: Date): Promise<Posts> {
  const scans = await db.query(
    'select count(*) as n from channel_posts where scanned_at >= $1 and scanned_at < $2',
    [start, end],
  );
  const n = async (codes: string[]) =>
    num(
      (
        await db.query(
          'select count(distinct url) as n from channel_posts where codes && $1 and scanned_at >= $2 and scanned_at < $3',
          [codes, start, end],
        )
      ).rows[0]?.n,
    );
  return {
    scans: num(scans.rows[0]?.n),
    unapproved: await n(UNAPPROVED),
    no_paper: await n(NO_PAPER_AD),
  };
}

async function qCskh(db: Db, start: Date): Promise<CskhRow[]> {
  // Mục tạo trước tháng vẫn có thể là mục xử lý câu hỏi trong tháng.
  const { rows } = await db.query(
    "select object_id, status, decided_at from approval_queue where object_type = 'cskh_handoff' and status in ('approved', 'rejected') and decided_at >= $1",
    [start],
  );
  return rows.map((r) => [r.object_id, r.status, r.decided_at]);
}

async function qCost(db: Db, start: Date, end: Date): Promise<CostRow[]> {
  const { rows } = await db.query(
    'select agent_id, count(*) as n, coalesce(sum(cost_usd), 0) as cost, count(*) filter (where not ok) as err from llm_usage where ts >= $1 and ts < $2 group by agent_id order by 3 desc, 1',
    [start, end],
  );
  return rows.map((r) => [r.agent_id, num(r.n), num(r.cost), num(r.err)]);
}

/** docx vòng 2: CHỈ dữ kiện có bằng chứng live (`chat_kpi_live`); bản mới nhất mỗi khóa. */
async function qChatFacts(db: Db, start: Date, end: Date): Promise<Fact[]> {
  const { rows } = await db.query(
    'select distinct on (qkey) qkey, ts, channel, is_question, handled_by_bot, group_oid, reply_ms from chat_kpi_live where ts >= $1 and ts < $2 order by qkey, captured_at desc',
    [start, end],
  );
  return rows.map((r) => [
    r.qkey,
    r.ts,
    r.channel,
    r.is_question,
    r.handled_by_bot,
    r.group_oid,
    r.reply_ms === null ? null : num(r.reply_ms),
  ]);
}

/** `chat_kpi_facts` (chụp trước bản lọc provenance) chưa có bản live cùng khóa = UNKNOWN. */
async function qChatUnknown(db: Db, start: Date, end: Date): Promise<number> {
  const { rows } = await db.query(
    'select count(*) as n from chat_kpi_facts f where f.ts >= $1 and f.ts < $2 and not exists (select 1 from chat_kpi_live l where l.qkey = f.qkey)',
    [start, end],
  );
  return num(rows[0]?.n);
}

/** Cảnh báo GỐC trong tháng chưa có lần gửi ok tới ai. */
async function qDeliveries(db: Db, start: Date, end: Date): Promise<string[]> {
  const { rows } = await db.query(
    "select r.id from red_alerts r where not (r.detail ? 'escalation_of') and r.ts >= $1 and r.ts < $2 and not exists (select 1 from red_alert_deliveries d where d.alert_id = r.id and d.ok) order by r.id",
    [start, end],
  );
  return rows.map((r) => String(r.id));
}

/** Xác nhận gửi bản báo cáo THÁNG TRƯỚC (hạn trước ngày 05 tháng này). */
async function qReportSent(db: Db, start: Date): Promise<SentRow> {
  const prev = addDays(vnDate(start), -1).slice(0, 7);
  const { rows } = await db.query(
    "select ts, actor, detail->>'file_sha256' as sha from agent_action_log where action = 'ops_report_sent' and object_type = 'ops_monthly' and object_id = $1 order by ts, id limit 1",
    [prev],
  );
  return rows[0] ? [rows[0].ts, rows[0].actor, rows[0].sha] : [];
}

const DB_SECTIONS: [string, (db: Db, s: Date, e: Date) => Promise<unknown>][] = [
  ['alerts', qAlerts],
  ['takedown', qTakedown],
  ['posts', qPosts],
  ['cskh', (db, s) => qCskh(db, s)],
  ['cost', qCost],
  ['chat_facts', qChatFacts],
  ['chat_unknown', qChatUnknown],
  ['incidents', oi.load],
  ['undelivered', qDeliveries],
  ['report_sent', (db, s) => qReportSent(db, s)],
];

/** CHỈ SELECT. Lỗi từng mục không làm hỏng mục khác (mỗi câu tự giao dịch trên pool). */
export async function collectDb(db: Db, start: Date, end: Date): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, fn] of DB_SECTIONS) {
    try {
      out[key] = await fn(db, start, end);
    } catch (e) {
      if (!isDbError(e)) throw e;
      out[key] = (e as { code?: string }).code === '42P01' ? MISSING : { error: pgErrName(e) };
    }
  }
  return out;
}

// ------------------------------------------------------------------ file

/** 1 bản ghi convlog → dữ kiện KPI KHÔNG PII | null khi không liên quan. Không mang câu hỏi/câu trả
 * lời/user_hash/msg_id thô. */
export function chatFact(rec: Rec, ts: Date): Fact | null {
  // PL02 ≤30 giây đo `reply_ms` (nhận tin → gửi xong, v12.4); `latency_ms` chỉ đo answer() → không dùng.
  // shortcut: JSON `1.0` (float Python → bỏ) bị JS đọc thành số nguyên — writer chỉ ghi int.
  const l = rec.reply_ms;
  const lat = typeof l === 'number' && Number.isInteger(l) && l >= 0 ? l : null;
  const ans = rec.answered;
  // `None` = chào/đồng ý/không áp dụng — không phải câu hỏi.
  const isQ =
    (ans === true || ans === false) && !CONSENT_REPLY_ROUTES.includes(rec.route as string);
  if (!isQ && lat === null) return null;
  // Bot trả lời nhưng gửi lỗi (`sent` False) = khách chưa nhận → không tính "đã xử lý".
  const ok = isQ ? ans === true && rec.sent !== false : null;
  const ch = rec.channel;
  const qkey = createHash('sha256').update(dedupKey(rec), 'utf8').digest('hex');
  return [
    qkey,
    ts,
    typeof ch === 'string' ? ch : null,
    isQ,
    ok,
    isQ ? cskhObjectId(rec, ts) : null,
    lat,
  ];
}

type ConvStats = Record<string, number>;

/** → [có file, mốc sớm nhất, {qkey: fact}] từ convlog (dedup theo khóa, chỉ dòng live). */
function iterFacts(
  dataDir: string,
  stats: ConvStats,
  start: Date | null = null,
  end: Date | null = null,
): [boolean, Date | null, Map<string, Fact>] {
  const facts = new Map<string, Fact>();
  let exists = false;
  let earliest = null as Date | null;
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    exists = true;
    // docx P1: KPI vận hành chỉ từ câu THẬT; dòng thử nghiệm/thiếu provenance đếm riêng ở `stats`.
    for (const rec of iterConvlog(path, stats, true)) {
      const ts = parseTs(rec.ts);
      if (ts === null) continue;
      if (earliest === null || ts < earliest) earliest = ts;
      if (start !== null && end !== null && !(start <= ts && ts < end)) continue;
      const f = chatFact(rec, ts);
      if (f !== null && !facts.has(f[0])) facts.set(f[0], f);
    }
  }
  return [exists, earliest, facts];
}

export type Question = [Date, boolean | null, string | null];
export type Conv = {
  exists: boolean;
  earliest: Date | null;
  questions: Question[];
  latencies: number[];
  stats?: ConvStats;
  facts?: Map<string, Fact>;
  snapshot_rows?: number;
};

/** facts → (questions [(ts, ok, group_oid)], latencies [ms]) theo (ts, qkey). */
function derive(facts: Iterable<Fact>): [Question[], number[]] {
  const fs = [...facts].sort((a, b) => a[1].getTime() - b[1].getTime() || cpCmp(a[0], b[0]));
  return [
    fs.filter((f) => f[3]).map((f) => [f[1], f[4], f[5]]),
    fs.filter((f) => f[6] !== null).map((f) => f[6] as number),
  ];
}

/** Convlog → câu hỏi + độ trễ trong tháng (không mang nội dung khách). */
export function readConvlog(dataDir: string, start: Date, end: Date): Conv {
  const stats: ConvStats = { corrupt: 0, doc: 0, io_error: 0 };
  const [exists, earliest, facts] = iterFacts(dataDir, stats, start, end);
  const [questions, latencies] = derive(facts.values());
  return { exists, earliest, questions, latencies, stats, facts };
}

/** Gộp dữ kiện chat đã chụp (`chat_kpi_live`) với convlog theo khóa — convlog đã xoay vòng thì vẫn
 * còn đầu tháng từ bảng. */
export function mergeChat(conv: Conv, dbFacts: unknown): Conv {
  if (!Array.isArray(dbFacts) || !dbFacts.length) return { ...conv, snapshot_rows: 0 };
  const facts = new Map<string, Fact>();
  for (const f of dbFacts as Fact[]) facts.set(f[0], f);
  for (const [k, f] of conv.facts ?? []) facts.set(k, f);
  const [questions, latencies] = derive(facts.values());
  let snapMin = (dbFacts as Fact[])[0]?.[1] as Date;
  for (const f of dbFacts as Fact[]) if (f[1] < snapMin) snapMin = f[1];
  const earliest = conv.earliest === null || snapMin < conv.earliest ? snapMin : conv.earliest;
  return {
    ...conv,
    exists: true,
    earliest,
    questions,
    latencies,
    facts,
    snapshot_rows: dbFacts.length,
  };
}

/** sha256 nội dung 1 dữ kiện (khóa + mọi trường) — bản live khác nội dung dòng cũ cùng khóa vẫn
 * được lưu riêng. Python `json.dumps([...], ensure_ascii=False)`. */
export function factSha(f: Fact): string {
  const doc = [f[0], isoUtc(f[1]), ...f.slice(2)];
  return createHash('sha256').update(pyDumps(doc), 'utf8').digest('hex');
}

/** Chụp dữ kiện chat CÓ bằng chứng live trong convlog hiện có vào sổ `chat_kpi_live` (on conflict do
 * nothing — chạy lại không nhân bản) → [đọc, mới]. docx vòng 2: KHÔNG ghi `chat_kpi_facts` nữa. */
export async function snapshot(db: Db, dataDir: string = DATA_DIR): Promise<[number, number]> {
  const [, , facts] = iterFacts(dataDir, { corrupt: 0, doc: 0, io_error: 0 });
  let added = 0;
  await withTx(db, async (c) => {
    for (const f of facts.values()) {
      const r = await c.query(
        "insert into chat_kpi_live (qkey, fact_sha256, ts, channel, is_question, handled_by_bot, group_oid, reply_ms, evidence) values ($1, $2, $3, $4, $5, $6, $7, $8, 'convlog_live') on conflict do nothing",
        [f[0], factSha(f), ...f.slice(1)],
      );
      added += r.rowCount ?? 0;
    }
  });
  return [facts.size, added];
}

/** `$BACKUP_DIR` (expanduser) | null khi chưa cấu hình. */
export function backupDir(env: Env = process.env): string | null {
  const v = env.BACKUP_DIR;
  if (!v) return null;
  return v === '~' || v.startsWith('~/') || v.startsWith('~\\') ? homedir() + v.slice(1) : v;
}

export type Run = { ts: Date; status: unknown; offsite: unknown };

/** `<BACKUP_DIR>/<name>` → [{ts có múi giờ, status, offsite}] | null khi chưa cấu hình/không có file. */
export function readRuns(bdir: string | null, name: string): Run[] | null {
  if (bdir === null || !existsSync(join(bdir, name))) return null;
  const out: Run[] = [];
  for (const rec of iterConvlog(join(bdir, name), { corrupt: 0, doc: 0, io_error: 0 })) {
    // Python `datetime.fromisoformat(str(ts))`: chuỗi khác không bao giờ ra mốc CÓ múi giờ.
    const r = typeof rec.ts === 'string' ? fromIso(rec.ts) : null;
    if (r === null || !r.aware) continue;
    out.push({ ts: r.date, status: rec.status ?? null, offsite: rec.offsite ?? null });
  }
  return out;
}

export type RepoFacts = { head: string | null; modules: number; tests: number; handover: string[] };

function walkPy(dir: string): number {
  let n = 0;
  let ents: string[];
  try {
    ents = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return 0;
  }
  for (const rel of ents) {
    const parts = rel.split(/[\\/]/);
    const nm = parts[parts.length - 1] as string;
    if (!nm.endsWith('.py') || nm === '__init__.py' || parts.includes('__pycache__')) continue;
    try {
      if (statSync(join(dir, rel)).isFile()) n++;
    } catch {
      /* file biến mất giữa chừng */
    }
  }
  return n;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const listNames = (p: string) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** Dữ kiện tự động của kho mã nguồn (commit HEAD, số module Python, số file test, tài liệu bàn giao). */
export function repoFacts(root: string = REPO_ROOT): RepoFacts {
  let head: string | null = null;
  try {
    head =
      pyStrip(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          timeout: 10_000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ) || null;
  } catch {
    head = null;
  }
  const modules = CODE_DIRS.filter((d) => isDir(join(root, d))).reduce(
    (n, d) => n + walkPy(join(root, d)),
    0,
  );
  const tests = listNames(join(root, 'tests')).filter(
    (f) => f.startsWith('test_') && f.endsWith('.py'),
  ).length;
  const handover = listNames(join(root, 'docs', 'handover'))
    .filter((f) => f.endsWith('.md'))
    .sort(cpCmp);
  return { head, modules, tests, handover };
}

// ------------------------------------------------------------------ tính KPI

export type Cskh = { ok: number; late: number; pending: number; bot: number; handoff: number };

/** THUẦN. Bot trả lời = ok; chuyển người = ok khi nhóm có quyết định trong [ts, ts + 2 giờ làm việc]. */
export function kpiCskh(
  questions: readonly Question[],
  decisions: readonly CskhRow[],
  shift: unknown,
  now: Date,
): Cskh {
  const byGroup = new Map<string, Date[]>();
  for (const [oid, , decidedAt] of decisions) {
    // đợt sau của nhóm = `cskh:<16hex>:<ts UTC>` (sales_director).
    const base = oid.startsWith('cskh:') ? oid.split(':').slice(0, 2).join(':') : oid;
    byGroup.set(base, [...(byGroup.get(base) ?? []), decidedAt]);
  }
  const r: Cskh = { ok: 0, late: 0, pending: 0, bot: 0, handoff: 0 };
  for (const [ts, answered, oid] of questions) {
    if (answered === true) {
      r.ok++;
      r.bot++;
      continue;
    }
    r.handoff++;
    const due = businessDeadline(ts, CSKH_HOURS, shift);
    if ((byGroup.get(oid as string) ?? []).some((d) => ts <= d && d <= due)) r.ok++;
    else if (now < due) r.pending++;
    else r.late++;
  }
  return r;
}

export type AlertKpi = { ok: number; late: number; pending: number; unacked: (string | number)[] };

export function kpiAlerts(rows: readonly AlertRow[], now: Date): AlertKpi {
  const r: AlertKpi = { ok: 0, late: 0, pending: 0, unacked: [] };
  for (const [aid, ts, ackedAt] of rows) {
    if (ackedAt !== null && ackedAt.getTime() - ts.getTime() <= ALERT_ACK_MS) r.ok++;
    else if (ackedAt === null && now.getTime() - ts.getTime() < ALERT_ACK_MS) r.pending++;
    else {
      r.late++;
      if (ackedAt === null) r.unacked.push(aid);
    }
  }
  return r;
}

export function kpiTakedown(
  rows: readonly TakedownRow[],
  now: Date,
): { ok: number; late: number; pending: number } {
  const r = { ok: 0, late: 0, pending: 0 };
  for (const [, , due, closedAt, reason] of rows) {
    if (closedAt !== null && DONE_REASONS.includes(reason as string) && closedAt <= due) r.ok++;
    else if (closedAt === null && now < due) r.pending++;
    else r.late++;
  }
  return r;
}

/** Nearest-rank p95; rỗng → null. */
export function p95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] as number;
}

export type BackupDays = { days: number; ok: number; offsite: number; missing: string[] };

/** Ngày VN đã qua trong tháng (hôm nay chưa tính) → ngày có bản ok. */
export function backupDays(runs: readonly Run[], start: Date, end: Date, now: Date): BackupDays {
  const a = addDays(vnDate(end), -1);
  const b = addDays(vnDate(now), -1);
  const last = [a, b].sort()[0] as string;
  const days: string[] = [];
  for (let d = vnDate(start); d <= last; d = addDays(d, 1)) days.push(d);
  const ok = new Set(runs.filter((r) => r.status === 'ok').map((r) => vnDate(r.ts)));
  const off = new Set(
    runs.filter((r) => r.status === 'ok' && pyTruthy(r.offsite)).map((r) => vnDate(r.ts)),
  );
  return {
    days: days.length,
    ok: days.filter((x) => ok.has(x)).length,
    offsite: days.filter((x) => off.has(x)).length,
    missing: days.filter((x) => !ok.has(x)),
  };
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export type DrillStatus = { marks: [string, string][]; month_runs: [string, unknown][] };

/** Mốc diễn tập PL02 → [(nhãn, trạng thái)] + lần chạy trong tháng. */
export function drillStatus(runs: readonly Run[], start: Date, end: Date, now: Date): DrillStatus {
  const okDays = runs
    .filter((r) => r.status === 'ok')
    .map((r) => vnDate(r.ts))
    .sort();
  // ngày CUỐI của tháng báo cáo (`end` là 00:00 đầu tháng sau — loại trừ)
  const today = vnDate(now);
  const mEnd = addDays(vnDate(end), -1);
  const marks: [string, string][] = [];
  let prev = '0000-00-00';
  for (const moc of DRILL_MOCS) {
    if (addDays(moc, -60) > mEnd) break;
    const hit = okDays.filter((d) => prev < d && d <= moc);
    const st = hit.length
      ? `đạt (${dmy(hit[hit.length - 1] as string)})`
      : today <= moc
        ? 'chưa tới hạn'
        : 'KHÔNG ĐẠT';
    marks.push([`mốc ${dmy(moc)}`, st]);
    prev = moc;
  }
  const mStart = vnDate(start);
  if (mStart > (DRILL_MOCS[DRILL_MOCS.length - 1] as string)) {
    const y = Number(mStart.slice(0, 4));
    const q = Math.floor((Number(mStart.slice(5, 7)) - 1) / 3);
    const yy = String(y).padStart(4, '0');
    const qStart = `${yy}-${pad2(3 * q + 1)}-01`;
    const qEnd =
      q === 3 ? `${String(y + 1).padStart(4, '0')}-01-01` : `${yy}-${pad2(3 * q + 4)}-01`;
    const hit = okDays.filter((d) => qStart <= d && d < qEnd && d <= mEnd);
    const st = hit.length
      ? `đạt (${dmy(hit[hit.length - 1] as string)})`
      : today < qEnd
        ? 'chưa có lần đạt — hạn cuối quý'
        : 'KHÔNG ĐẠT';
    marks.push([`quý ${q + 1}/${y}`, st]);
  }
  const monthRuns: [string, unknown][] = runs
    .filter((r) => start <= r.ts && r.ts < end)
    .map((r) => [vnDate(r.ts), r.status] as [string, unknown]);
  monthRuns.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : cpCmp(String(a[1]), String(b[1])),
  );
  return { marks, month_runs: monthRuns };
}

// ------------------------------------------------------------------ render

const pct = (ok: number, total: number) =>
  total === 0 ? '—' : `${pyFixed((100 * ok) / total, 1)}%`;

function verdictPct(ok: number, total: number, target: number): string {
  if (total === 0) return '— (không có mục tới hạn)';
  return (100 * ok) / total >= target ? 'Đạt' : 'KHÔNG ĐẠT';
}

function state(val: unknown, table: string): string | null {
  if (val === null || val === undefined) return `${NO_DATA} (DB không truy cập được)`;
  if (val === MISSING) return `${NO_DATA} (chưa có bảng \`${table}\`)`;
  if (isDict(val) && Object.hasOwn(val, 'error')) {
    return `${NO_DATA} (lỗi đọc \`${table}\`: ${String(val.error)})`;
  }
  return null;
}

/** Chuỗi từ DB/cấu hình vào markdown: che PII/secret, bỏ xuống dòng/'|'. */
export function cell(v: unknown): string {
  const s = cleanDetail(v) ?? '';
  return cpSlice(squash(s.replaceAll('|', '/')), 0, 300);
}

const vn = (ts: Date) => vnFormat(ts, '%d/%m/%Y %H:%M');

/** KPI "Báo cáo vận hành gửi Bên B trước ngày 05": bằng chứng = người gửi xác nhận (`--mark-sent`)
 * cho bản THÁNG TRƯỚC; hạn = 00:00 ngày 05 tháng này (giờ VN). Không có xác nhận → không chấm. */
export function sentRow(sent: unknown, start: Date): string[] {
  const s0 = vnDate(start);
  const prev = addDays(s0, -1);
  const due = vnAt(`${s0.slice(0, 8)}05`);
  const label = `Báo cáo vận hành tháng ${prev.slice(5, 7)}/${prev.slice(0, 4)} gửi Bên B`;
  const src = '`agent_action_log` `ops_report_sent` (người gửi xác nhận)';
  const msg = state(sent, 'agent_action_log');
  if (msg) return [label, 'Trước ngày 05', msg, '—', 'Bên A', src];
  if (!pyTruthy(sent)) {
    return [
      label,
      'Trước ngày 05',
      'chưa có xác nhận gửi (người gửi chạy `--mark-sent`)',
      '—',
      'Bên A',
      src,
    ];
  }
  const [ts, actor, sha] = sent as [Date, unknown, unknown];
  return [
    label,
    'Trước ngày 05',
    `gửi ${vn(ts)} — ${cell(actor)} xác nhận, sha256 ${cpSlice(cell(sha), 0, 12)}`,
    ts < due ? 'Đạt' : 'KHÔNG ĐẠT',
    'Bên A',
    src,
  ];
}

/** Mục sổ sự cố → (dòng bảng PL02 mục 2, ghi chú). */
export function incidentRows(inc: unknown, shift: unknown, now: Date): [string[][], string[]] {
  const src = '`ops_incidents` + `ops_incident_events`';
  const labels: [string, string, 'detect' | 'respond' | 'fix', string | null][] = [
    ['Phát hiện sự cố hệ thống', '≤ 15 phút', 'detect', null],
    ['Phản hồi lỗi nghiêm trọng', '≤ 03 giờ', 'respond', 'nghiem_trong'],
    ['Phản hồi lỗi thường', '≤ 03 ngày làm việc', 'respond', 'thuong'],
    ['Sửa lỗi phát sinh', '≤ 07 ngày', 'fix', null],
  ];
  const msg = state(inc, 'ops_incidents');
  if (msg) return [labels.map(([a, b]) => [a, b, msg, src]), []];
  if (shift === null || shift === undefined) {
    return [labels.map(([a, b]) => [a, b, `${NO_DATA} (lịch ngày làm việc lỗi)`, src]), []];
  }
  const data = inc as oi.Loaded;
  const rows = oi.evaluate(data.incidents, data.events, shift, now);
  if (!rows.length) {
    const empty =
      'sổ sự cố không có sự cố phát hiện trong tháng (không phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi)';
    return [labels.map(([a, b]) => [a, b, empty, src]), []];
  }
  const out = labels.map(([a, b, key, sev]) => {
    const c = oi.summarize(rows, key, sev);
    const tot = c.ok + c.late;
    let txt = `${pct(c.ok, tot)} (${c.ok}/${tot}); chưa tới hạn ${c.pending}`;
    if (c.unmeasured) txt += `; chưa đo (thiếu lúc xảy ra) ${c.unmeasured}`;
    return [a, b, txt, src];
  });
  const done = rows.filter((r) => r.customer_resolved_at !== null).length;
  return [
    out,
    [
      `- Sổ sự cố: ${rows.length} sự cố; xử lý khách/đối tác xong ${done} (đếm RIÊNG — không thay phản hồi/sửa kỹ thuật).`,
    ],
  ];
}

export type Facts = {
  start: Date;
  end: Date;
  now: Date;
  assets: Assets;
  repo: RepoFacts;
  conv: Conv;
  shift: unknown;
  shift_error?: string;
  backups: Run[] | null;
  drills: Run[] | null;
  db_ok: boolean;
  db?: Record<string, unknown> | null;
  workdays?: unknown;
  workdays_error?: string;
  holiday_warning?: string | null;
};

/** THUẦN từ facts → markdown. Không chép nội dung khách/URL bài. */
export function render(f: Facts): string {
  const { start, end, now } = f;
  const db = f.db ?? {};
  const ok = Boolean(f.db_ok);
  const get = (k: string) => (ok ? db[k] : null);
  const due = `${vnDate(end).slice(0, 8)}05`;
  const L: string[] = [
    `# Báo cáo vận hành tháng ${vnFormat(start, '%m/%Y')}`,
    '',
    `_Sinh lúc ${vn(now)} giờ VN. Hạn gửi Bên B: trước ngày ${dmy(due)} (PL02 mục 3). Số do code tính từ bảng/file nêu ở cột Nguồn, không dùng LLM; báo cáo chỉ đọc, không tự gửi._`,
    '',
  ];
  if (now < end) L.push(`> **THÁNG CHƯA ĐÓNG** — số tạm tính tới ${vn(now)}.`, '');
  if (!ok) L.push(`> **DB không truy cập được** — mọi mục lấy từ DB ghi "${NO_DATA}".`, '');

  // ---- (1) KPI vận hành
  const rows: string[][] = [];
  const notes: string[] = [];
  const conv = f.conv;
  const cs = get('cskh');
  let src =
    'convlog `conversations.jsonl` + `approval_queue` (`cskh_handoff`), ca `data/directors/sales.json`';
  const cskhLabel = 'Câu hỏi khách xử lý trong 2 giờ làm việc';
  const csMsg = state(cs, 'approval_queue');
  if (!conv.exists) {
    rows.push([cskhLabel, '≥ 90%', `${NO_DATA} (không có convlog)`, '—', 'Bên B', src]);
  } else if (f.shift_error) {
    rows.push([
      cskhLabel,
      '≥ 90%',
      `${NO_DATA} (ca làm việc lỗi: ${f.shift_error})`,
      '—',
      'Bên B',
      src,
    ]);
  } else if (csMsg) {
    rows.push([cskhLabel, '≥ 90%', csMsg, '—', 'Bên B', src]);
  } else {
    const k = kpiCskh(conv.questions, cs as CskhRow[], f.shift, now);
    const tot = k.ok + k.late;
    rows.push([
      cskhLabel,
      '≥ 90%',
      `${pct(k.ok, tot)} (${k.ok}/${tot})`,
      verdictPct(k.ok, tot, CSKH_TARGET),
      'Bên B',
      src,
    ]);
    notes.push(
      `- Câu hỏi khách: bot trả lời ${k.bot}, chuyển người ${k.handoff} (trễ ${k.late}, chưa tới hạn ${k.pending}).`,
    );
    if (conv.earliest !== null && conv.earliest > start) {
      notes.push(
        `- Convlog chỉ còn từ ${vn(conv.earliest)} (giữ 30 ngày; sổ \`chat_kpi_live\` cũng không có sớm hơn) — câu hỏi trước mốc này không tính.`,
      );
    }
  }

  const al = get('alerts');
  src = '`red_alerts` (bỏ bản leo thang) + `red_alert_acks`';
  const alLabel = 'Báo động đỏ xác nhận trong 2 giờ';
  const alMsg = state(al, 'red_alerts');
  if (alMsg) rows.push([alLabel, '100%', alMsg, '—', 'Bên B', src]);
  else {
    const list = al as AlertRow[];
    const k = kpiAlerts(list, now);
    const tot = k.ok + k.late;
    rows.push([
      alLabel,
      '100%',
      `${pct(k.ok, tot)} (${k.ok}/${tot})`,
      verdictPct(k.ok, tot, 100.0),
      'Bên B',
      src,
    ]);
    notes.push(
      `- Báo động đỏ: ${list.length} cảnh báo gốc, đúng hạn ${k.ok}, trễ/chưa xác nhận ${k.late}, chưa tới hạn ${k.pending}` +
        (k.unacked.length ? `; chưa xác nhận: #${k.unacked.join(', #')}` : '') +
        '.',
    );
  }

  const td = get('takedown');
  src = '`channel_posts` (đợt vi phạm, `agents.ra_kenh`)';
  const tdLabel = 'Lệnh gỡ bài vi phạm xong trong 24 giờ';
  const tdMsg = state(td, 'channel_posts');
  if (tdMsg) rows.push([tdLabel, '100%', tdMsg, '—', 'Bên B', src]);
  else {
    const list = td as TakedownRow[];
    const k = kpiTakedown(list, now);
    const tot = k.ok + k.late;
    rows.push([
      tdLabel,
      '100%',
      `${pct(k.ok, tot)} (${k.ok}/${tot})`,
      verdictPct(k.ok, tot, 100.0),
      'Bên B',
      src,
    ]);
    notes.push(
      `- Gỡ/sửa bài: ${list.length} đợt vi phạm phát hiện trong tháng, xong đúng hạn ${k.ok}, trễ ${k.late}, chưa tới hạn ${k.pending}.`,
    );
  }

  const po = get('posts');
  src = '`channel_posts` (rà kênh sở hữu trong tháng)';
  for (const [label, key, codes] of [
    ['Bài đăng chưa được duyệt', 'unapproved', UNAPPROVED],
    ['Rượu/TPBVSK chưa đủ giấy lên quảng cáo', 'no_paper', NO_PAPER_AD],
  ] as const) {
    const resp = 'Hai Bên';
    const poMsg = state(po, 'channel_posts');
    if (poMsg) rows.push([label, '0', poMsg, '—', resp, src]);
    else if ((po as Posts).scans === 0) {
      rows.push([label, '0', `${NO_DATA} (không có lần rà kênh nào trong tháng)`, '—', resp, src]);
    } else {
      // v13.7: 0 URL vi phạm chỉ nói về các file kênh SỞ HỮU đã rà — không phải toàn kênh sạch.
      const n = (po as Posts)[key];
      rows.push([
        label,
        '0',
        `${n} URL (${codes.join('/')}) — phạm vi: ${(po as Posts).scans} lượt rà kênh sở hữu`,
        n === 0 ? SCOPE_OK : 'KHÔNG ĐẠT',
        resp,
        src,
      ]);
    }
  }
  rows.push(sentRow(get('report_sent'), start));
  L.push(
    '## 1. KPI vận hành hằng tháng (PL02 mục 3)',
    '',
    '| Chỉ tiêu | Yêu cầu | Kết quả | Đánh giá | Bên chịu trách nhiệm | Nguồn |',
    '|---|---|---|---|---|---|',
  );
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  L.push('', ...notes);
  L.push(
    `- Quảng cáo trả phí/KOC/livestream ngoài kênh sở hữu: ${NO_DATA} (chỉ rà file xuất kênh sở hữu) — hai chỉ tiêu bài đăng/quảng cáo KHÔNG được coi là đạt cho phần này.`,
  );
  const und = get('undelivered');
  const undMsg = state(und, 'red_alert_deliveries');
  if (undMsg) L.push(`- Gửi cảnh báo đỏ: ${undMsg}.`);
  else if (pyTruthy(und)) {
    const ids = und as unknown[];
    L.push(
      `- Cảnh báo đỏ CHƯA gửi được tới người nhận nào (\`red_alert_deliveries\`): ${ids.length} — #${ids
        .slice(0, 20)
        .map(String)
        .join(', #')}.`,
    );
  } else {
    L.push('- Cảnh báo đỏ gốc trong tháng: đều có lần gửi thành công (`red_alert_deliveries`).');
  }
  if (conv.snapshot_rows) {
    L.push(
      `- Dữ kiện chat: ${conv.snapshot_rows} dòng từ \`chat_kpi_live\` (chụp hằng ngày) gộp convlog.`,
    );
  }
  const unk = get('chat_unknown');
  if (typeof unk === 'number' && unk) {
    // docx vòng 2: dữ kiện chụp trước bản lọc provenance — UNKNOWN.
    L.push(
      `- \`chat_kpi_facts\`: ${unk} dữ kiện chụp trước bản lọc provenance, chưa có bằng chứng live cùng khóa — KHÔNG tính KPI vận hành (chưa xác minh).`,
    );
  }
  const st = conv.stats ?? {};
  if (st.thu_nghiem || st.thieu_provenance) {
    // docx P1: thống kê THỬ NGHIỆM tách khỏi KPI vận hành.
    L.push(
      `- Convlog không tính KPI vận hành: ${st.thu_nghiem ?? 0} dòng thử nghiệm (mock/replay/demo/mẫu), ${st.thieu_provenance ?? 0} dòng thiếu provenance (ghi trước bản vá v15 — không suy ngược).`,
    );
  }

  // ---- (2) tiêu chí kỹ thuật
  L.push(
    '',
    '## 2. Tiêu chí kỹ thuật (PL02 mục 2)',
    '',
    '| Chỉ tiêu | Yêu cầu | Kết quả | Nguồn |',
    '|---|---|---|---|',
  );
  const bk = f.backups;
  if (bk === null) {
    L.push(
      `| Backup dữ liệu thành công | 100% số ngày | ${NO_DATA} (chưa cấu hình \`BACKUP_DIR\` hoặc chưa có nhật ký) | \`backup_runs.jsonl\` |`,
    );
  } else {
    const b = backupDays(bk, start, end, now);
    L.push(
      `| Backup dữ liệu thành công | 100% số ngày | ${b.ok}/${b.days} ngày (${pct(b.ok, b.days)}); có bản sao ngoài ${b.offsite} ngày | \`$BACKUP_DIR/backup_runs.jsonl\` |`,
    );
  }
  const dr = f.drills;
  if (dr === null) {
    L.push(
      `| Diễn tập khôi phục | 30/11/2026, 18/12/2026, sau đó mỗi quý | ${NO_DATA} (chưa có nhật ký diễn tập) | \`drill_runs.jsonl\`, \`dr_runs.jsonl\` |`,
    );
  } else {
    const d = drillStatus(dr, start, end, now);
    const res = d.marks.map(([a, b]) => `${a}: ${b}`).join('; ') || 'chưa tới mốc';
    L.push(
      `| Diễn tập khôi phục | 30/11/2026, 18/12/2026, sau đó mỗi quý | ${res}; trong tháng ${d.month_runs.length} lần | \`$BACKUP_DIR/drill_runs.jsonl\`, \`dr_runs.jsonl\` |`,
    );
  }
  const lats = conv.latencies;
  if (!lats.length) {
    L.push(
      '| Phản hồi tự động của chatbot | ≤ 30 giây | chưa đo (không có `reply_ms` trong convlog tháng — bản ghi trước v12.4 không đo) | convlog |',
    );
  } else {
    const slow = lats.filter((x) => x > CHAT_LIMIT_MS).length;
    L.push(
      `| Phản hồi tự động của chatbot | ≤ 30 giây | p95 ${pyFixed((p95(lats) as number) / 1000, 1)} giây; > 30 giây ${slow}/${lats.length} (${pct(slow, lats.length)}) | convlog \`reply_ms\` |`,
    );
  }
  const co = get('cost');
  const coMsg = state(co, 'llm_usage');
  if (coMsg) {
    L.push(
      `| Chi phí AI tháng | trong trần \`data/llm_gateway.json\` | ${coMsg} | \`llm_usage\` |`,
    );
  } else {
    const list = co as CostRow[];
    let tot = 0;
    let calls = 0;
    for (const [, n, c] of list) {
      tot += Number(c);
      calls += Number(n);
    }
    L.push(
      `| Chi phí AI tháng | trong trần \`data/llm_gateway.json\` | ${pyFixed(tot, 4)} USD / ${calls} lời gọi | \`llm_usage\` |`,
    );
  }
  const [incRows, incNotes] = incidentRows(get('incidents'), f.workdays, now);
  for (const [a, b, c, d] of incRows) L.push(`| ${a} | ${b} | ${c} | ${d} |`);
  L.push('', ...incNotes);
  if (f.holiday_warning) L.push(`- ${f.holiday_warning}`);
  if (bk !== null) {
    const b = backupDays(bk, start, end, now);
    if (b.missing.length) {
      L.push(
        `- Ngày không có backup thành công: ${b.missing.map((x) => `${x.slice(8, 10)}/${x.slice(5, 7)}`).join(', ')}.`,
      );
    }
  }
  if (dr !== null) {
    for (const [day, s] of drillStatus(dr, start, end, now).month_runs) {
      L.push(`- Diễn tập ${dmy(day)}: ${pyStrOf(s)}.`);
    }
  }
  if (Array.isArray(co)) {
    for (const [agent, n, cost, err] of (co as CostRow[]).slice(0, 10)) {
      L.push(`- AI \`${cell(agent)}\`: ${pyFixed(Number(cost), 4)} USD, ${n} lời gọi, lỗi ${err}.`);
    }
  }

  // ---- (3) tài sản hợp tác
  const a = f.assets;
  const rf = f.repo;
  L.push(
    '',
    '## 3. Danh mục tài sản hợp tác (PL04 mục 3)',
    '',
    `_Nguồn: \`data/tai_san_hop_tac.json\` (cập nhật ${dmy(a.cap_nhat)}; trạng thái kiểm kê: ${cell(a.trang_thai ?? UNCONFIRMED)})._`,
    '',
    `Người giữ quyền cao nhất: ${cell(a.quyen_cao_nhat ?? UNCONFIRMED)}.`,
    '',
    '| Hạng mục | Mô tả | Nơi lưu giữ | Bên quản lý | Vị trí | Phiên bản | Chủ quản | Quyền truy cập |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const i of a.items) {
    L.push(
      `| ${[...ASSET_KEYS, ...INVENTORY_KEYS].map((k) => cell(i[k] ?? UNCONFIRMED)).join(' | ')} |`,
    );
  }
  if (a.excluded.length) {
    L.push(
      '',
      `Không thuộc tài sản hợp tác (tài sản riêng Bên B): ${a.excluded.map(cell).join(', ')}.`,
    );
  }
  L.push(
    '',
    'Dữ kiện tự động của kho mã nguồn:',
    `- Commit hiện tại: \`${rf.head || 'không đọc được'}\``,
    `- Số module Python: ${rf.modules}; số file test: ${rf.tests}`,
    `- Tài liệu bàn giao \`docs/handover/\`: ${rf.handover.join(', ') || '(không có)'}`,
  );
  return `${L.join('\n')}\n`;
}

/** Python `str(v)` cho trạng thái lần diễn tập (giá trị JSON). */
function pyStrOf(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

// ------------------------------------------------------------------ chạy

export type GatherDeps = {
  connect?: () => Promise<DbLease | null>;
  dataDir?: string;
  backupDir?: string | null;
  /** `load_sales_config()["business_hours"]` (ca CSKH). */
  salesShift?: () => unknown;
  /** `rollout.load_shift()` (ngày làm việc của sổ sự cố). */
  workdays?: () => unknown;
  holidayWarning?: () => string | null;
  repoFacts?: () => RepoFacts;
};

export async function gather(
  start: Date,
  end: Date,
  now: Date,
  assets: Assets,
  d: GatherDeps = {},
): Promise<Facts> {
  const f: Facts = {
    start,
    end,
    now,
    assets,
    conv: readConvlog(d.dataDir ?? DATA_DIR, start, end),
    repo: (d.repoFacts ?? repoFacts)(),
    shift: null,
    backups: null,
    drills: null,
    db_ok: false,
  };
  try {
    f.shift = (d.salesShift ?? (() => loadSalesConfig().business_hours))();
  } catch (e) {
    f.shift = null;
    f.shift_error = errName(e);
  }
  const bdir = d.backupDir === undefined ? backupDir() : d.backupDir;
  f.backups = readRuns(bdir, 'backup_runs.jsonl');
  const logs = ['drill_runs.jsonl', 'dr_runs.jsonl'].map((n) => readRuns(bdir, n));
  f.drills = logs.every((x) => x === null) ? null : logs.flatMap((x) => x ?? []);
  const lease = await (d.connect ?? (() => connectDatabaseUrl()))();
  f.db_ok = lease !== null;
  if (lease !== null) {
    try {
      f.db = await collectDb(lease.db, start, end);
    } finally {
      await lease.release().catch(() => {});
    }
    f.conv = mergeChat(f.conv, f.db.chat_facts);
  }
  try {
    f.workdays = (d.workdays ?? (() => loadShift()))();
    f.holiday_warning = (d.holidayWarning ?? (() => holidayWarning()))();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    f.workdays = null;
    f.workdays_error = e.message;
  }
  return f;
}

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type OpsMonthlyOpts = {
  month?: string;
  snapshot?: boolean;
  markSent?: string;
  file?: string;
  by?: string;
  outDir?: string;
};

export type OpsMonthlyDeps = GatherDeps & {
  env?: Env;
  io?: Io;
  now?: () => Date;
  assetsFile?: string;
};

async function cliSnapshot(d: OpsMonthlyDeps, io: Io): Promise<number> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.out('[err] DB không truy cập được — chưa chụp KPI chat');
    return 1;
  }
  let res: [number, number];
  try {
    res = await snapshot(lease.db, d.dataDir ?? DATA_DIR);
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.out(`[err] lỗi DB khi chụp KPI chat: ${pgErrName(e)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(`[ok] chat_kpi_live: đọc ${res[0]} dữ kiện live, mới ${res[1]}`);
  return 0;
}

/** Người gửi xác nhận đã gửi bản báo cáo tháng → 1 dòng hash chain. */
async function cliMarkSent(
  o: OpsMonthlyOpts,
  d: OpsMonthlyDeps,
  io: Io,
  now: Date,
): Promise<number> {
  const m = MONTH_RE.exec(pyStrip(o.markSent ?? ''));
  const by = squash(o.by ?? '');
  const y = m ? ndInt(m[1] as string) : 0;
  if (m === null || y < 1) {
    io.out('[usage] --mark-sent cần YYYY-MM');
    return 2;
  }
  const [start, end] = periodBounds('month', `${String(y).padStart(4, '0')}-${m[2]}-01`);
  if (end > now) {
    io.out('[usage] tháng chưa đóng — chưa thể gửi báo cáo tháng này');
    return 2;
  }
  if (!by || cpLen(by) > 100 || !isHuman(by)) {
    io.out('[usage] --by phải là tên NGƯỜI đã gửi (không agent:/system:)');
    return 2;
  }
  const want = `van-hanh-${ym(start)}.md`;
  let isFile = false;
  try {
    isFile = o.file !== undefined && statSync(o.file).isFile();
  } catch {
    isFile = false;
  }
  if (o.file === undefined || basename(o.file) !== want || !isFile) {
    io.out(`[usage] --file phải là bản đã gửi \`${want}\``);
    return 2;
  }
  const sha = createHash('sha256')
    .update(readFileSync(o.file as string))
    .digest('hex');
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.out('[err] DB không truy cập được — chưa ghi xác nhận');
    return 1;
  }
  try {
    await lease.db.query(
      "insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, 'ops_report_sent', 'ops_monthly', $2, $3)",
      [cleanDetail(by), ym(start), JSON.stringify({ file_sha256: sha, confirmed_by_sender: true })],
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.out(`[err] lỗi DB: ${pgErrName(e)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(
    `[ok] đã ghi xác nhận gửi báo cáo ${vnFormat(start, '%m/%Y')} (sha256 ${sha.slice(0, 12)}; giờ ghi do DB đặt)`,
  );
  return 0;
}

/** `python scripts/ops_monthly.py --month YYYY-MM|prev [--out-dir DIR]` · `--snapshot` ·
 * `--mark-sent YYYY-MM --file F --by "<tên>"`. */
export async function opsMonthlyMain(o: OpsMonthlyOpts, d: OpsMonthlyDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const ops = [o.month !== undefined, Boolean(o.snapshot), o.markSent !== undefined].filter(
    Boolean,
  ).length;
  if (ops !== 1) {
    io.err(
      `ops_monthly: error: ${ops ? 'chỉ một trong --month, --snapshot, --mark-sent' : 'one of the arguments --month --snapshot --mark-sent is required'}`,
    );
    return 2;
  }
  const now = d.now?.() ?? new Date();
  if (o.snapshot) return cliSnapshot(d, io);
  if (o.markSent !== undefined) return cliMarkSent(o, d, io, now);
  let month = o.month as string;
  if (pyStrip(month) === 'prev') month = addDays(`${vnDate(now).slice(0, 8)}01`, -1).slice(0, 7);
  let start: Date;
  let end: Date;
  let assets: Assets;
  try {
    [start, end] = monthBounds(month, now);
    assets = loadAssets(d.assetsFile ?? ASSETS);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.out(`[usage] ${e.message}`);
    return 2;
  }
  const name = `van-hanh-${ym(start)}.md`;
  // KHÁC Python có chủ đích (r19): tính năng TẮT → `[rollout]` exit 2 TRƯỚC connect/đọc nguồn/ghi
  // (Python đọc DB rồi mới traceback ở write_report).
  const why = await blocked(null, 'báo cáo vận hành tháng', null, { report: name });
  if (why) return sayBlocked(why, io.out);
  const f = await gather(start, end, now, assets, {
    ...d,
    connect: d.connect ?? (() => connectDatabaseUrl(d.env)),
  });
  // P8.4: DB không khả dụng → báo cáo degraded, KHÔNG đếm là đầu ra thật.
  const path = await writeReport(render(f), o.outDir ?? REPORTS_DIR, name, !f.db_ok);
  io.out(`[ok] ${path}`);
  if (!f.db_ok) {
    io.out("[err] DB không truy cập được — mục DB ghi 'chưa có dữ liệu'");
    return 1;
  }
  return 0;
}
