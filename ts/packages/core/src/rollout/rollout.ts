import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type pg from 'pg';
import { createPool, PRIV_LOGIN_SQL } from '../db.js';
import { pyStrip } from '../env.js';
import { type Db, dep, type OpsDeps } from '../ops/deps.js';
import { BLOCKS } from '../ops/director.js';
import { vnFormat } from '../ops/period.js';
import { isPlainObject, parseJsonBytes } from '../ops/py.js';
import { REPORTS_DIR, writeReport } from '../ops/report.js';
import { oneline, pyStr } from '../ops/store.js';
import { dbMsg, isDbError, withTx } from '../ops/tx.js';
import { REPO_ROOT } from '../paths.js';
import { HumanDenied, HumanError } from '../security/auth.js';
import { maskPii } from '../security/pii.js';
import { cpHead, pyTruthy } from '../security/py.js';
import * as acceptance from './acceptance.js';
import {
  businessDays,
  CODE_STATES,
  CRITERIA,
  checkBy,
  cleanNote,
  type Evidence,
  evaluate,
  HD_TOTAL,
  loadFeatures,
  loadShift,
  lst,
  PHASES,
  RolloutError,
  SEVERE,
  STAGE_LABEL,
  STAGES,
  splitMap,
  summary,
  tup,
} from './catalog.js';
import {
  countSpec as countSpecOf,
  type Feature,
  isHuman,
  needsReview,
  type OutputFacts,
  outputFacts,
  outputRows,
  pgErrName,
  pySorted,
  rowsOf,
  type Source,
  settings,
  sp,
} from './counters.js';

// Port `pipelines/rollout.py` — sổ triển khai 3 bước + hồ sơ đề nghị nghiệm thu (HĐ hợp tác
// TEDO–Sâm Sâm, PL02 mục 1; HĐ 6.7):
// - `mode(db, fid)` là nguồn DUY NHẤT của giai đoạn: chưa vào sổ / bảng thiếu / DB down / không
//   thuộc tính năng → `chay_thu` (fail-closed). `rollout_config.json` `enforce: false` TƯỜNG MINH
//   mới tắt cưỡng chế. Biên SINH chặn khi `tat`; biên DUYỆT chặn khi `tat`; biên DÙNG chặn khi
//   `chay_thu`/`tat`, `co_nguoi_duyet` chỉ mục NGƯỜI duyệt từng mục.
// - Ghi sổ (`seed` đường owner; nâng/lùi/tắt qua `rollout_transition_human`; duyệt đầu ra qua
//   `output_review_human`) — DB tự kiểm danh tính/khối/cổng PL02 (đếm lại bằng `count_spec`),
//   TS không tự đếm thay DB. Số TS đếm chỉ để báo lỗi sớm.
// Hàm của nhóm khác qua `ops/deps` (`auth.denyLog`, `auth.cliGate` — bước tích hợp nối).

export * from './catalog.js';
export * from './counters.js';

export const FAIL_CLOSED = 'chay_thu';
export const USABLE = ['co_nguoi_duyet', 'van_hanh'];
export const EXIT_BLOCKED = 2; // r12 RB: CLI bị cổng tắt chặn
export const DECISIONS = ['approved', 'rejected'];
const SHA_RE = /^[0-9a-f]{64}$/;

/** Biên sinh/quyết/dùng đầu ra bị chặn theo giai đoạn (HĐ 6.7). Python ValueError → RangeError. */
export class RolloutBlocked extends RangeError {
  override name = 'RolloutBlocked'; // Python `type(e).__name__`
}
// DB từ chối danh tính/ủy quyền (42501) — CÙNG lớp với security/auth (Python `auth.HumanDenied`).
export { HumanDenied, HumanError };

// ------------------------------------------------------------ kết nối riêng (Python `connect()`)

/** Kết nối mượn: `release` trả lại (pool riêng → end; pool dùng chung của tiến trình → no-op). */
export type DbLease = { db: Db; release: () => Promise<void> };
let connector: () => Promise<DbLease | null> = defaultConnect;

/** Bước tích hợp: cho rollout dùng pool của tiến trình (api/worker/cli) khi cần tự đọc sổ. */
export function setConnector(fn: (() => Promise<DbLease | null>) | null): void {
  connector = fn ?? defaultConnect;
}

/** Python `ingest.lead_store.connect()`: `DATABASE_URL` → kết nối | null (không có/không tới được). */
async function defaultConnect(): Promise<DbLease | null> {
  const dsn = pyStrip(settings.env.DATABASE_URL ?? '');
  if (!dsn) return null;
  let pool: pg.Pool | undefined;
  try {
    pool = createPool(dsn, {}, settings.env);
    await pool.query('select 1');
  } catch {
    await pool?.end().catch(() => {});
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

// ------------------------------------------------------------ cưỡng chế

/** Chỉ `"enforce": false` TƯỜNG MINH mới tắt; file lỗi/thiếu → bật. */
export function enforceEnabled(path?: string | null): boolean {
  let cfg: unknown;
  try {
    cfg = parseJsonBytes(readFileSync(path || settings.configFile));
  } catch {
    return true;
  }
  return !(isPlainObject(cfg) && cfg.enforce === false);
}

/** Giai đoạn biết được KHÔNG cần DB (ép test / cưỡng chế tắt) | null. */
export function quickMode(): string | null {
  if (settings.forceMode !== null) return settings.forceMode;
  return enforceEnabled() ? null : 'van_hanh';
}

/** Giai đoạn hiện hành — nguồn DUY NHẤT cho mọi biên. Đọc trong savepoint: lỗi không làm hỏng tx
 * của client chia sẻ; lỗi DB → `chay_thu`. */
export async function mode(db: Db | null, fid: string | null | undefined): Promise<string> {
  const q = quickMode();
  if (q !== null) return q;
  if (db === null || !fid) return FAIL_CLOSED;
  let row: unknown[] | undefined;
  try {
    row = (
      await sp(db, () =>
        rowsOf(db, 'select stage from feature_rollout where feature_id = %s', [fid]),
      )
    )[0];
  } catch (e) {
    if (!isDbError(e)) throw e;
    return FAIL_CLOSED;
  }
  return row && (STAGES as readonly unknown[]).includes(row[0]) ? (row[0] as string) : FAIL_CLOSED;
}

let catCache: [string, bigint, Feature[]] | null = null;

/** Danh mục đã kiểm (cache theo đường dẫn + mtime) | null khi thiếu/hỏng. */
export function catalog(): Feature[] | null {
  const p = settings.featuresFile;
  let mt: bigint;
  try {
    mt = statSync(p, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
  if (catCache && catCache[0] === p && catCache[1] === mt) return catCache[2];
  let feats: Feature[];
  try {
    feats = loadFeatures(p);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
  catCache = [p, mt, feats];
  return feats;
}

function srcHit(src: Source, attrs: Record<string, unknown>, skip: string[] = []): boolean {
  return Object.entries(src).every(
    ([k, v]) => k === 'rules_any' || skip.includes(k) || attrs[k] === v,
  );
}

/** Tính năng sở hữu 1 đầu ra theo `output_sources` (key của nguồn là ràng buộc, key thiếu = mọi
 * giá trị). 0 hoặc >1 mục khớp → null. Khối cũ ngoài BLOCKS → khớp bỏ qua khối nếu duy nhất. */
export function featureFor(attrs: Record<string, unknown>): string | null {
  const feats = catalog() ?? [];
  const hit = (skip?: string[]) =>
    new Set(
      feats.filter((f) => f.output_sources.some((s) => srcHit(s, attrs, skip))).map((f) => f.id),
    );
  let hits = hit();
  if (!hits.size && 'block' in attrs && !(BLOCKS as readonly unknown[]).includes(attrs.block)) {
    hits = hit(['block']);
  }
  return hits.size === 1 ? ([...hits][0] as string) : null;
}

/** Báo cáo `data/reports/<tiền tố>…` → tính năng (tiền tố dài nhất). */
export function featureForReport(name: string): string | null {
  let best: [string, string] | null = null;
  for (const f of catalog() ?? []) {
    for (const s of f.output_sources) {
      const p = s.report;
      if (typeof p === 'string' && p && String(name).startsWith(p)) {
        if (best === null || p.length > best[0].length) best = [p, f.id];
      }
    }
  }
  return best ? best[1] : null;
}

function why(fid: string | null | undefined, md: string, what: string): string {
  return `${what}: tính năng ${fid || '(không thuộc danh mục)'} đang ${STAGE_LABEL[md]} — HĐ 6.7/PL02 mục 1`;
}

/** Biên SINH: tính năng `tat` → RolloutBlocked. Chạy thử vẫn sinh; không thuộc danh mục → không chặn. */
export async function checkGenerate(
  db: Db | null,
  fid: string | null | undefined,
  what: string,
): Promise<void> {
  if (fid !== null && fid !== undefined && (await mode(db, fid)) === 'tat') {
    throw new RolloutBlocked(`${why(fid, 'tat', what)} — không sinh đầu ra`);
  }
}

/**
 * r12 RB/G1-L1: kiểm cổng SINH SỚM — trước mọi side effect → lý do chặn | null. Tính năng = `fid`
 * tường minh, hoặc suy từ tiền tố báo cáo `report` / thuộc tính `output_sources`. Không có `db`
 * mà cần đọc sổ → tự mở kết nối (dry-run vẫn đọc sổ).
 */
export async function blocked(
  db: Db | null,
  what: string,
  fid: string | null = null,
  opts: { report?: string | null; attrs?: Record<string, unknown> } = {},
): Promise<string | null> {
  if (fid === null && opts.report !== undefined && opts.report !== null) {
    if (db === null) {
      const [f, md] = await reportStage(opts.report);
      return md === 'tat' ? `${why(f, 'tat', `báo cáo ${opts.report}`)} — không sinh đầu ra` : null;
    }
    fid = featureForReport(opts.report);
  } else if (fid === null && opts.attrs && Object.keys(opts.attrs).length) {
    fid = featureFor(opts.attrs);
  }
  const lease = db === null && fid !== null && quickMode() === null ? await connector() : null;
  try {
    await checkGenerate(lease ? lease.db : db, fid, what);
  } catch (e) {
    if (e instanceof RolloutBlocked) return e.message;
    throw e;
  } finally {
    await lease?.release();
  }
  return null;
}

/** In lý do chặn (stdout, có mã tính năng) → EXIT_BLOCKED. */
export function sayBlocked(reason: string, log: (s: string) => void = console.log): number {
  log(`[rollout] ${reason}`);
  return EXIT_BLOCKED;
}

/** Bọc `main` CLI: RolloutBlocked lọt tới đỉnh → `[rollout] lý do`, exit 2. Lỗi khác KHÔNG bắt. */
export function cliEntry<A extends unknown[]>(
  main: (...a: A) => Promise<number>,
): (...a: A) => Promise<number> {
  return async (...a: A) => {
    try {
      return await main(...a);
    } catch (e) {
      if (e instanceof RolloutBlocked) return sayBlocked(e.message);
      throw e;
    }
  };
}

/** Biên DUYỆT: mục của tính năng `tat` không được duyệt (từ chối vẫn được — dọn hàng). */
export async function decideReason(
  db: Db | null,
  fid: string | null | undefined,
  what: string,
): Promise<string | null> {
  if (fid !== null && fid !== undefined && (await mode(db, fid)) === 'tat') {
    return `${why(fid, 'tat', what)} — không duyệt mục của tính năng tắt`;
  }
  return null;
}

/** Biên DÙNG (gửi khách / xuất / áp dụng / xếp lịch) → lý do chặn | null. */
export async function useReason(
  db: Db | null,
  fid: string | null | undefined,
  what: string,
  humanReviewed: boolean,
): Promise<string | null> {
  const md = await mode(db, fid);
  if (!USABLE.includes(md)) return `${why(fid, md, what)} — đầu ra chỉ ghi nội bộ, không dùng`;
  if (md === 'co_nguoi_duyet' && !humanReviewed) {
    return `${why(fid, md, what)} — mục chưa được NGƯỜI duyệt từng mục`;
  }
  return null;
}

/** (tính năng, giai đoạn) của báo cáo file theo tiền tố — null khi không thuộc danh mục. DB down →
 * `chay_thu` (fail-closed). `fid` tường minh cho báo cáo mà tiền tố không nằm trong danh mục. */
export async function reportStage(
  name: string,
  fid: string | null = null,
): Promise<[string | null, string | null]> {
  const q = quickMode();
  const f = fid || featureForReport(name);
  if (f === null) return [null, null];
  if (q !== null) return [f, q];
  const lease = await connector();
  try {
    return [f, await mode(lease ? lease.db : null, f)];
  } finally {
    await lease?.release();
  }
}

/** Biên sinh báo cáo file: tiền tố thuộc tính năng `tat` → RolloutBlocked. → giai đoạn | null. */
export async function gateReport(name: string, fid: string | null = null): Promise<string | null> {
  const [f, md] = await reportStage(name, fid);
  if (md === 'tat') {
    throw new RolloutBlocked(`${why(f, 'tat', `báo cáo ${name}`)} — không sinh đầu ra`);
  }
  return md;
}

// v15.2 (P8.5): báo cáo file của tính năng chưa cho dùng mang nhãn NGAY TRONG nội dung.
export const REPORT_LABELS: Record<string, string> = {
  chay_thu:
    '> **CHẠY THỬ — KHÔNG GỬI.** Tính năng {fid} đang chạy thử nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không gửi/không dùng ra ngoài.',
  co_nguoi_duyet:
    '> **CHỜ NGƯỜI DUYỆT — CHƯA GỬI.** Tính năng {fid} đang chạy có người duyệt: sinh ra ≠ đã duyệt; chỉ dùng sau khi người được ủy quyền duyệt đúng phiên bản này (`python -m pipelines.rollout --review-output`).',
};

/** Chèn nhãn giai đoạn vào đầu báo cáo .md của tính năng đang chạy thử/có người duyệt; đuôi khác giữ nguyên. */
export function labelReport(
  name: string,
  text: string,
  md: string | null,
  fid: string | null = null,
): string {
  const lab = md !== null && Object.hasOwn(REPORT_LABELS, md) ? REPORT_LABELS[md] : undefined;
  if (lab === undefined || !String(name).endsWith('.md')) return text;
  const f = fid || featureForReport(name) || '?';
  return `${lab.replace('{fid}', f)}\n\n${text || ''}`;
}

// Nhãn MẪU chuẩn của báo cáo dựng trên dữ liệu mẫu — chỉ LOẠI THÊM (fail-closed).
const REPORT_SAMPLE_RE = /[([]MẪU[)\]]/;

/**
 * v14.3 (F04): báo cáo file của TÍNH NĂNG → 1 dòng `report_outputs` (tên, sha256 nội dung,
 * `is_sample` = cờ caller HOẶC nhãn MẪU). → true khi đã ghi. Không thuộc danh mục / test ép giai
 * đoạn → false, không mở DB. DB down / thiếu quyền → cảnh báo stderr, false (báo cáo vẫn ghi —
 * chỉ không được ĐẾM).
 */
export async function recordReport(
  name: string,
  text: string,
  sample: boolean | null = null,
  fid: string | null = null,
): Promise<boolean> {
  if (settings.forceMode !== null) return false;
  const f = fid || featureForReport(name);
  if (f === null) return false;
  const isSample = Boolean(sample) || REPORT_SAMPLE_RE.test(text || '');
  const sha = createHash('sha256')
    .update(text || '', 'utf8')
    .digest('hex');
  const lease = await connector();
  if (lease === null) {
    console.error(
      `[warn] báo cáo ${name}: DB không kết nối được — không ghi sổ đầu ra (không được đếm)`,
    );
    return false;
  }
  try {
    await rowsOf(
      lease.db,
      'insert into report_outputs (feature_id, name, sha256, is_sample) values (%s, %s, %s, %s)',
      [f, name, sha, isSample],
    );
    return true;
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(
      `[warn] báo cáo ${name}: không ghi được sổ đầu ra (${pgErrName(e)}) — không được đếm`,
    );
    return false;
  } finally {
    await lease.release();
  }
}

/** Lịch nghỉ chưa chốt → cảnh báo (không bịa ngày nghỉ). */
export function holidayWarning(path?: string | null): string | null {
  let hol: unknown = null;
  try {
    const cfg = parseJsonBytes(readFileSync(path || settings.configFile));
    hol = isPlainObject(cfg) ? cfg.holidays : null;
  } catch {
    hol = null;
  }
  if (pyTruthy(hol)) return null;
  return (
    'CẢNH BÁO: lịch nghỉ lễ/Tết chưa chốt (`data/rollout_config.json` holidays rỗng) — ngày làm ' +
    'việc đang tính T2–T6 kể cả ngày lễ; chờ Hành chính Sâm Sâm chốt, KHÔNG tự điền.'
  );
}

// ------------------------------------------------------------ DB: function `*_human`

type HumanCtx = {
  by: unknown;
  block: string | null;
  action: string;
  objectType: string;
  objectId: string;
};

/**
 * Python `auth.call_human`: gọi function ghi `*_human` → hàng. DB từ chối quyền (42501) →
 * `authz_denied` (sau khi trả savepoint — không làm hỏng/commit việc dở của caller) + HumanDenied.
 * Function từ chối nghiệp vụ (`raise exception`, P0001) → RangeError(thông điệp, không DETAIL).
 */
export async function callHuman(
  db: Db,
  sql: string,
  args: unknown[],
  ctx: HumanCtx,
): Promise<unknown[][]> {
  try {
    return await sp(db, () => rowsOf(db, sql, args));
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = cpHead(dbMsg(e), 300);
    if (code === '42501') {
      await dep('auth').denyLog(
        db,
        ctx.by,
        ctx.block,
        ctx.action,
        ctx.objectType,
        ctx.objectId,
        msg,
      );
      throw new HumanDenied(msg);
    }
    if (code === 'P0001') throw new HumanError(msg);
    throw e;
  }
}

const blockOf = (fid: string): string => fid.split('-')[0] as string;

export function featureOf(feats: Feature[], fid: string): Feature {
  const f = feats.find((x) => x.id === fid);
  if (!f) throw new RolloutError(`${fid}: không có trong danh mục contract_features`);
  return f;
}

export type Facts = OutputFacts & {
  days: number;
  severe: number;
  target: string | null;
  why: string[];
};

async function countSevere(db: Db, fid: string, since: Date): Promise<number> {
  const r = await rowsOf(
    db,
    "select count(*) from feature_rollout_events where feature_id = %s and kind = 'severe' and ts >= %s",
    [fid, since],
  );
  return Number(r[0]?.[0] ?? 0);
}

const DB_KEYS = ['outputs', 'out_days', 'human', 'unapproved', 'unreviewed'] as const;

/** docx P0: số DB đếm lại (`rollout_recount_human` — cùng `count_spec` function chuyển giai đoạn
 * dùng) | null (chưa có function / không gọi được / chưa có bộ đếm / giai đoạn vừa đổi). */
async function dbRecount(
  db: Db,
  fid: string,
  stage: string,
): Promise<Record<string, number> | null> {
  let r: unknown;
  try {
    r = (await sp(db, () => rowsOf(db, 'select rollout_recount_human(%s)', [fid])))[0]?.[0];
  } catch {
    return null; // conn giả / DB cũ / thiếu quyền
  }
  if (
    !isPlainObject(r) ||
    !pyTruthy(r.has_spec) ||
    !pyTruthy(r.sql_sources) ||
    r.stage !== stage ||
    !DB_KEYS.every((k) => Number.isInteger(r[k]))
  ) {
    return null;
  }
  return r as Record<string, number>;
}

/** Số liệu cổng của 1 tính năng ở giai đoạn `stage` từ mốc `since`. */
export async function facts(
  db: Db,
  f: Feature,
  stage: string,
  since: Date,
  now: Date,
  shift: unknown,
): Promise<Facts> {
  const days = businessDays(since, now, shift);
  const o = await outputFacts(db, f, since, now, shift);
  if (o.uncounted.length) {
    const r = await dbRecount(db, f.id, stage);
    if (r) {
      // Login NGƯỜI không SELECT được bảng nguồn → số DB đếm lại (DB vẫn là bên quyết).
      for (const k of DB_KEYS) (o as Record<string, unknown>)[k] = r[k];
      o.counted_by = 'db';
    }
  }
  const severe = await countSevere(db, f.id, since);
  const [target, w] = evaluate(
    stage,
    days,
    o.outputs,
    severe,
    o.out_days,
    o.human,
    o.unapproved,
    o.unreviewed,
  );
  return { days, ...o, severe, target, why: w };
}

async function event(
  c: Db,
  fid: string,
  kind: string,
  frm: string | null,
  to: string,
  by: string,
  now: Date,
  evidence: unknown = null,
): Promise<void> {
  await rowsOf(
    c,
    'insert into feature_rollout_events (ts, feature_id, kind, from_stage, to_stage, severe_code,' +
      ' note, evidence, by_person) values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)',
    [now, fid, kind, frm, to, null, null, JSON.stringify(evidence || {}), by],
  );
}

/** v15.4 (P10.1): nâng/lùi/tắt qua `rollout_transition_human` — DB khóa dòng, kiểm giai đoạn hiện
 * hành = `frm`, chuyển hợp lệ, danh tính theo login, cổng PL02 tự đếm lại; TS không ghi thẳng sổ. */
async function transition(
  c: Db,
  fid: string,
  kind: string,
  frm: string,
  to: string,
  by: string,
  now: Date,
  o: { code?: string | null; note?: string | null; evidence?: unknown } = {},
): Promise<void> {
  try {
    await callHuman(
      c,
      'select rollout_transition_human(%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)',
      [
        fid,
        kind,
        frm,
        to,
        by,
        o.code ?? null,
        o.note ?? null,
        JSON.stringify(o.evidence || {}),
        now,
      ],
      { by, block: blockOf(fid), action: kind, objectType: 'feature_rollout', objectId: fid },
    );
  } catch (e) {
    if (e instanceof RangeError) throw new RolloutError(e.message);
    throw e;
  }
}

/** Giai đoạn hiện hành (CHỈ ĐỌC — khóa dòng nằm trong function ghi). */
async function locked(c: Db, fid: string): Promise<[string, Date]> {
  const r = await rowsOf(
    c,
    'select stage, stage_since from feature_rollout where feature_id = %s',
    [fid],
  );
  if (!r[0]) throw new RolloutError(`${fid}: chưa vào sổ triển khai (chạy --seed)`);
  return r[0] as [string, Date];
}

/**
 * Đưa tính năng `co_code` chưa có vào `chay_thu` (bắt đầu đếm). Có rồi → giữ nguyên mốc, chỉ đồng
 * bộ lại `count_spec` khi đổi (đường OWNER — app_human/svc không ghi được `feature_rollout`).
 * Mục tách: mốc MỚI, nhóm cũ `tat` → `tat`; id cũ bị thay: chỉ kế thừa TẮT. Idempotent.
 */
export async function seed(
  db: Db,
  feats: Feature[],
  by: unknown,
  now: Date | null = null,
  shift: unknown = null,
): Promise<{ inserted: number; existing: number; skipped: number }> {
  const who = checkBy(by);
  const t = now ?? new Date();
  const sh = shift ?? loadShift(settings.configFile);
  const st = { inserted: 0, existing: 0, skipped: 0 };
  await withTx(db, async (c) => {
    for (const f of feats) {
      if (f.code_status !== 'co_code') {
        st.skipped++;
        continue;
      }
      let stage = 'chay_thu';
      let ev: Record<string, unknown> | null = null;
      if (f.nhom_goc) {
        const g = (
          await rowsOf(c, 'select stage from feature_rollout where feature_id = %s', [f.nhom_goc])
        )[0];
        ev = { nhom_goc: f.nhom_goc, stage_nhom_goc: g ? g[0] : null };
        if (g && g[0] === 'tat') stage = 'tat'; // nhóm đã tắt → không tự bật lại
      }
      if (f.thay_the?.length) {
        const old = new Map(
          (
            await rowsOf(
              c,
              'select feature_id, stage from feature_rollout where feature_id = any(%s::text[])',
              [f.thay_the],
            )
          ).map((r) => [r[0] as string, r[1] as string]),
        );
        ev = {
          ...(ev ?? {}),
          thay_the: Object.fromEntries(f.thay_the.map((o) => [o, old.get(o) ?? null])),
        };
        if ([...old.values()].includes('tat')) stage = 'tat';
      }
      const row = (
        await rowsOf(
          c,
          'insert into feature_rollout (feature_id, stage, stage_since, updated_by, updated_at,' +
            ' count_spec) values (%s, %s, %s, %s, %s, %s::jsonb) on conflict (feature_id) do update' +
            ' set count_spec = excluded.count_spec where feature_rollout.count_spec is distinct' +
            ' from excluded.count_spec returning (xmax = 0)',
          [f.id, stage, t, who, t, JSON.stringify(countSpecOf(f, sh))],
        )
      )[0];
      if (row?.[0] === true) {
        await event(c, f.id, 'seed', null, stage, who, t, ev);
        st.inserted++;
      } else st.existing++;
    }
  });
  return st;
}

/** Nâng 1 bước nếu đủ cổng → {from, to, facts}. Chưa đủ → RolloutError (không ghi gì). */
export async function promote(
  db: Db,
  feats: Feature[],
  fid: string,
  by: unknown,
  shift: unknown,
  now: Date | null = null,
): Promise<{ from: string; to: string; facts: Facts }> {
  const who = checkBy(by);
  const t = now ?? new Date();
  const f = featureOf(feats, fid);
  if (f.code_status !== 'co_code') {
    throw new RolloutError(
      `${fid}: code_status=${f.code_status} — chưa đủ code để triển khai (chỉ co_code)`,
    );
  }
  return withTx(db, async (c) => {
    const [stage, since] = await locked(c, fid);
    const fx = await facts(c, f, stage, since, t, shift);
    if (fx.target === null || fx.why.length) {
      throw new RolloutError(`${fid} (${STAGE_LABEL[stage]}) chưa đủ cổng: ${fx.why.join('; ')}`);
    }
    const evidence: Record<string, unknown> = {};
    for (const k of [
      'days',
      'outputs',
      'out_days',
      'human',
      'unapproved',
      'unreviewed',
      'severe',
    ]) {
      evidence[k] = (fx as Record<string, unknown>)[k];
    }
    evidence.since = since.toISOString();
    await transition(c, fid, 'promote', stage, fx.target, who, t, { evidence });
    return { from: stage, to: fx.target, facts: fx };
  });
}

/** Lỗi nghiêm trọng PL02 mục 2 → lùi `chay_thu` (mốc đếm lại); đang `tat` thì giữ `tat`. */
export async function recordSevere(
  db: Db,
  fid: string,
  code: string,
  by: unknown,
  note: unknown = null,
  now: Date | null = null,
): Promise<{ from: string; to: string }> {
  const who = checkBy(by);
  const t = now ?? new Date();
  if (!Object.hasOwn(SEVERE, code)) {
    throw new RangeError(`--reason phải ∈ ${lst(pySorted(Object.keys(SEVERE)))}`);
  }
  return withTx(db, async (c) => {
    const [stage] = await locked(c, fid);
    const to = stage === 'tat' ? 'tat' : 'chay_thu';
    await transition(c, fid, 'severe', stage, to, who, t, { code, note: cleanNote(note) });
    return { from: stage, to };
  });
}

export async function disable(
  db: Db,
  fid: string,
  by: unknown,
  note: unknown = null,
  now: Date | null = null,
): Promise<{ from: string; to: string }> {
  const who = checkBy(by);
  const t = now ?? new Date();
  return withTx(db, async (c) => {
    const [stage] = await locked(c, fid);
    if (stage === 'tat') throw new RolloutError(`${fid}: đã tắt`);
    await transition(c, fid, 'disable', stage, 'tat', who, t, { note: cleanNote(note) });
    return { from: stage, to: 'tat' };
  });
}

// ------------------------------------------------------------ duyệt từng đầu ra (v15.2 P8.7)

export type Pending = {
  key: string;
  ts: Date;
  sha: string | null;
  review: [string, string] | null;
};

/** v15 fix P8.7b: login NGƯỜI (không superuser/owner, có EXECUTE `output_pending_human`) → liệt
 * kê/kiểm sớm qua function DB. Owner/dev, login dịch vụ, schema thiếu function → bộ đếm TS. */
async function dbListing(db: Db): Promise<boolean> {
  try {
    // Python `auth.privileged_login` khác None (superuser/owner/không kiểm được) → bộ đếm TS.
    const row = (await sp(db, () => db.query(PRIV_LOGIN_SQL))).rows[0];
    if (!row || row.rolsuper || row.exists) return false;
    const r = await sp(db, () =>
      rowsOf(db, "select has_function_privilege(%s, 'EXECUTE')", [
        'output_pending_human(text, text)',
      ]),
    );
    return Boolean(r[0]?.[0]);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return false;
  }
}

/** Đầu ra cần duyệt theo bộ đếm DB (`output_pending_human` — CÙNG `count_spec` mà
 * `output_review_human` kiểm). 42501 → `authz_denied` + RolloutError. `by` null = người của login. */
async function pendingDb(
  db: Db,
  fid: string,
  by: string | null,
  action: string,
): Promise<Pending[]> {
  let rows: unknown[][];
  try {
    rows = await callHuman(
      db,
      'select o_key, o_ts, o_sha, o_quyet_dinh, o_nguoi_duyet from output_pending_human(%s, %s)',
      [fid, by],
      { by: by || '', block: blockOf(fid), action, objectType: 'output_review', objectId: fid },
    );
  } catch (e) {
    if (e instanceof RangeError) throw new RolloutError(e.message);
    throw e;
  }
  return rows.map(([k, ts, hh, d, who]) => ({
    key: k as string,
    ts: ts as Date,
    sha: hh as string | null,
    review: d !== null && d !== undefined ? [d as string, who as string] : null,
  }));
}

function fileNote(f: Feature): string {
  const fs = f.output_sources.filter((s) => 'file' in s && needsReview(s)).map((s) => s.file);
  return fs.length
    ? ` — nguồn file (${fs.join(', ')}) trên máy ứng dụng DB không đọc được, CHƯA có bản chụp tin cậy trong DB: không duyệt nguồn file qua sổ này`
    : '';
}

/** Đầu ra trong cửa sổ giai đoạn hiện hành cần duyệt qua `output_reviews` (cũ trước). Chỉ đọc. */
export async function pendingOutputs(
  db: Db,
  feats: Feature[],
  fid: string,
  now: Date | null = null,
  by: string | null = null,
): Promise<Pending[]> {
  const t = now ?? new Date();
  const f = featureOf(feats, fid);
  if (await dbListing(db)) return pendingDb(db, fid, by, 'list');
  const [, since] = await locked(db, fid);
  const [merged] = await outputRows(db, f, since, t);
  return [...merged]
    .filter(([, o]) => o.needs_review)
    .sort(([ka, a], [kb, b]) => a.ts.getTime() - b.ts.getTime() || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([key, o]) => ({ key, ts: o.ts, sha: o.sha, review: o.review }));
}

/**
 * v15.2 (P8.7): NGƯỜI duyệt 1 đầu ra trên đúng phiên bản → id dòng `output_reviews`. Kiểm sớm
 * (khóa thuộc tính năng trong giai đoạn hiện hành, cần duyệt, sha = phiên bản hiện hành) chỉ để
 * báo lỗi; DB TỰ kiểm lại bằng `count_spec` trong `output_review_human` (danh tính theo login).
 */
export async function reviewOutput(
  db: Db,
  feats: Feature[],
  fid: string,
  key: string,
  sha: unknown,
  decision: string,
  by: unknown,
  note: unknown = null,
  now: Date | null = null,
): Promise<bigint> {
  const who = checkBy(by);
  const t = now ?? new Date();
  if (!DECISIONS.includes(decision)) throw new RangeError(`--decision phải ∈ ${tup(DECISIONS)}`);
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new RangeError('--sha phải là sha256 hex 64 ký tự');
  }
  const f = featureOf(feats, fid);
  const act = decision === 'approved' ? 'approve' : 'reject';
  return withTx(db, async (c) => {
    let o: { sha: string | null } | undefined;
    if (await dbListing(c)) {
      o = (await pendingDb(c, fid, who, act)).find((r) => r.key === key);
      if (o === undefined) {
        throw new RolloutError(
          `${fid}: '${oneline(String(key), 80)}' không phải đầu ra nguồn bảng/báo cáo cần duyệt qua sổ này của tính năng trong giai đoạn hiện hành (khóa không tồn tại / sai tính năng hoặc nguồn / mẫu / có bước duyệt riêng)${fileNote(f)}`,
        );
      }
    } else {
      const [, since] = await locked(c, fid);
      const [merged, , unc] = await outputRows(c, f, since, t);
      const m = merged.get(key);
      if (m === undefined) {
        throw new RolloutError(
          `${fid}: '${oneline(String(key), 80)}' không phải đầu ra của tính năng trong giai đoạn hiện hành${unc.length ? ` (nguồn chưa đọc được: ${unc.join('; ')})` : ''}`,
        );
      }
      if (!m.needs_review) {
        throw new RolloutError(
          `${fid}: đầu ra ${key} có bước duyệt riêng (hàng duyệt/nháp) — duyệt ở đó`,
        );
      }
      o = m;
    }
    if (o.sha !== sha) {
      throw new RolloutError(
        `${fid}: sha không khớp phiên bản hiện hành của ${key} — nội dung đã đổi, đọc lại (\`--outputs\`) rồi duyệt`,
      );
    }
    let row: unknown[][];
    try {
      row = await callHuman(
        c,
        'select output_review_human(%s, %s, %s, %s, %s, %s)',
        [fid, key, sha, decision, who, cleanNote(note)],
        {
          by: who,
          block: blockOf(fid),
          action: act,
          objectType: 'output_review',
          objectId: `${fid}:${key}`,
        },
      );
    } catch (e) {
      if (e instanceof RangeError) throw new RolloutError(e.message);
      throw e;
    }
    return BigInt(String(row[0]?.[0]));
  });
}

// ------------------------------------------------------------ trạng thái sổ

export type StatusRow = {
  feature: Feature;
  stage: string | null;
  since: Date | null;
  facts: Facts | null;
};

/** Mỗi tính năng danh mục + trạng thái sổ (null = chưa vào sổ). */
export async function statusRows(
  db: Db,
  feats: Feature[],
  shift: unknown,
  now: Date | null = null,
): Promise<StatusRow[]> {
  const t = now ?? new Date();
  const cur = new Map(
    (await rowsOf(db, 'select feature_id, stage, stage_since from feature_rollout', [])).map(
      (r) => [r[0] as string, [r[1] as string, r[2] as Date] as const],
    ),
  );
  const out: StatusRow[] = [];
  for (const f of feats) {
    const c = cur.get(f.id);
    if (c === undefined) out.push({ feature: f, stage: null, since: null, facts: null });
    else {
      out.push({
        feature: f,
        stage: c[0],
        since: c[1],
        facts: await facts(db, f, c[0], c[1], t, shift),
      });
    }
  }
  return out;
}

export type LegacyRow = { id: string; stage: string; since: Date | null; tach_thanh: string[] };

/** Dòng sổ có id KHÔNG còn trong danh mục (id nhóm v12 đã tách) — lịch sử giữ nguyên. */
export async function legacyRows(db: Db, feats: Feature[]): Promise<LegacyRow[]> {
  const ids = new Set(feats.map((f) => f.id));
  const sm = splitMap(feats);
  return (
    await rowsOf(
      db,
      'select feature_id, stage, stage_since from feature_rollout order by feature_id',
      [],
    )
  )
    .filter((r) => !ids.has(r[0] as string))
    .map((r) => ({
      id: r[0] as string,
      stage: r[1] as string,
      since: r[2] as Date,
      tach_thanh: sm[r[0] as string] ?? [],
    }));
}

export type SevereEvent = {
  ts: Date;
  feature_id: string;
  severe_code: string;
  from_stage: string | null;
  note: string | null;
  by_person: string;
};

export async function severeEvents(db: Db, fids: Iterable<string>): Promise<SevereEvent[]> {
  const cols = ['ts', 'feature_id', 'severe_code', 'from_stage', 'note', 'by_person'];
  return (
    await rowsOf(
      db,
      `select ${cols.join(', ')} from feature_rollout_events where kind = 'severe' and feature_id = any(%s::text[]) order by ts, id`,
      [[...fids]],
    )
  ).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])) as SevereEvent);
}

/** Số lần nâng lên `co_nguoi_duyet` (tính năng đã qua giai đoạn đó). */
export async function reviewedCount(db: Db, fids: Iterable<string>): Promise<number> {
  const r = await rowsOf(
    db,
    "select count(*) from feature_rollout_events where kind = 'promote' and to_stage = 'co_nguoi_duyet' and feature_id = any(%s::text[])",
    [[...fids]],
  );
  return Number(r[0]?.[0] ?? 0);
}

// ------------------------------------------------------------ hồ sơ

export function evidenceStatus(ev: Evidence, root: string = REPO_ROOT): string {
  if (!ev.length) return 'chưa có bằng chứng';
  const missing: string[] = [];
  for (const [rel, needle] of ev) {
    let ok: boolean;
    try {
      const p = join(root, rel);
      ok =
        statSync(p).isFile() &&
        (needle === null || readFileSync(p).toString('utf8').includes(needle));
    } catch {
      ok = false;
    }
    if (!ok) missing.push(rel);
  }
  if (missing.length) return `chưa có bằng chứng (thiếu ${missing.join(', ')})`;
  return 'có lệnh trong repo — chạy và đính kèm kết quả';
}

const cell = (s: unknown): string => oneline(pyStr(s), 160).replaceAll('|', '/');
const d = (ts: Date | null | undefined): string => (ts ? vnFormat(ts, '%d/%m/%Y') : '—');
const tsf = (ts: Date | null | undefined): string => (ts ? vnFormat(ts, '%d/%m/%Y %H:%M') : '—');

function legacyLine(r: LegacyRow): string {
  const to = r.tach_thanh.join(', ') || 'không còn trong danh mục';
  return `${r.id} (${STAGE_LABEL[r.stage] ?? r.stage} từ ${d(r.since)}) → ${to}`;
}

export type Incident = {
  id: unknown;
  severity: string;
  detected_at: Date | null;
  ben: string;
  title: string;
  responded: Date | null;
  fixed: Date | null;
  resolved: Date | null;
};

export type DossierRow = {
  feature: Record<string, unknown>;
  stage: string | null;
  since: Date | null;
  facts: {
    days: number;
    outputs: number | null;
    out_days: number;
    severe: number;
    target: string | null;
    why: string[];
  } | null;
};

/** Markdown hồ sơ đề nghị nghiệm thu — THUẦN (đầu vào đã đọc DB). Tiêu đề DỰ THẢO (PL05 chưa có). */
export function renderDossier(
  phase: string,
  rows: DossierRow[],
  severe: SevereEvent[],
  nReviewed: number,
  now: Date,
  o: {
    root?: string;
    legacy?: LegacyRow[];
    warnings?: string[];
    incidents?: Incident[] | null;
    versions?: Record<string, string> | null;
    exceptions?: string[];
  } = {},
): string {
  const root = o.root ?? REPO_ROOT;
  const legacy = o.legacy ?? [];
  const warnings = o.warnings ?? [];
  const incidents = o.incidents === undefined ? null : o.incidents;
  const L: string[] = [
    `# Hồ sơ đề nghị nghiệm thu ${phase} — DỰ THẢO do hệ thống dựng (PL05 chưa có — không phải biên bản)`,
    '',
    `Ngày lập: ${d(now)} (giờ VN). Căn cứ: Hợp đồng hợp tác TEDO–Sâm Sâm, PL02 mục 1d (hồ sơ) + mục 2 (tiêu chí kỹ thuật).`,
    '',
    `Lưu ý: danh mục là BẢN ĐỀ XUẤT tách từ nhóm PL01 mục 2 (mục \`<nhóm>.<n>\` = tách từ nhóm), CHƯA được hai bên chốt — danh mục ${HD_TOTAL} tính năng chính thức chờ biên bản. Không suy tỷ lệ hoàn thành từ số dòng.`,
    '',
    `## 1. Danh sách tính năng (${rows.length} mục)`,
    '',
    '| Mã | Phòng ban | Tính năng | Code | Giai đoạn triển khai | Từ ngày | Ngày làm việc | Đầu ra | Lỗi NT |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const f = r.feature;
    const fx = r.facts;
    let tail: string;
    if (r.stage === null || fx === null) tail = 'chưa vào sổ | — | — | — | —';
    else {
      const out = fx.outputs === null ? 'không đếm được' : `${fx.outputs} (${fx.out_days} ngày)`;
      tail = `${STAGE_LABEL[r.stage]} | ${d(r.since)} | ${fx.days} | ${out} | ${fx.severe}`;
    }
    L.push(`| ${f.id} | ${f.phong_ban} | ${cell(f.ten)} | ${f.code_status} | ${tail} |`);
  }
  L.push(
    '',
    'Nguồn: `data/contract_features.json`, bảng `feature_rollout`, `feature_rollout_events`; đầu ra = mục DISTINCT ở `output_sources` của đúng tính năng (hàng duyệt / nháp nội dung, guardrail đạt, không mẫu) từ lúc vào giai đoạn — (N ngày) = số ngày làm việc khác nhau có đầu ra.',
    '',
  );
  L.push(...warnings.map((w) => `> ${w}`), ...(warnings.length ? [''] : []));
  if (legacy.length) {
    L.push(
      'ID nhóm cũ (v12) còn trong sổ — lịch sử giữ nguyên, mục tách đếm lại từ mốc riêng:',
      '',
    );
    L.push(...legacy.map((r) => `- ${legacyLine(r)}`), '');
  }
  L.push('## 2. Kết quả chạy thử (cổng PL02 mục 1a–c)', '');
  for (const r of rows) {
    const f = r.feature;
    const fx = r.facts;
    if (r.stage === null || fx === null) continue;
    if (fx.target === null) L.push(`- \`${f.id}\` vận hành.`);
    else if (fx.why.length) {
      L.push(
        `- \`${f.id}\` ${STAGE_LABEL[r.stage]}: CHƯA đủ điều kiện nâng — ${fx.why.join('; ')}.`,
      );
    } else {
      L.push(
        `- \`${f.id}\` ${STAGE_LABEL[r.stage]}: đủ điều kiện nâng lên ${STAGE_LABEL[fx.target]} (chờ người duyệt ghi \`--promote\`).`,
      );
    }
  }
  if (!rows.some((r) => r.stage)) L.push('- Chưa tính năng nào vào sổ triển khai.');
  L.push('', '## 3. Nhật ký lỗi nghiêm trọng (PL02 mục 2)', '');
  if (severe.length) {
    L.push(
      '| Thời điểm | Mã | Lỗi | Giai đoạn lúc lỗi | Ghi chú | Người ghi |',
      '|---|---|---|---|---|---|',
    );
    for (const e of severe) {
      const lab =
        e.from_stage !== null && Object.hasOwn(STAGE_LABEL, e.from_stage)
          ? STAGE_LABEL[e.from_stage]
          : '—';
      L.push(
        `| ${tsf(e.ts)} | ${e.feature_id} | ${Object.hasOwn(SEVERE, e.severe_code) ? SEVERE[e.severe_code] : '?'} | ${lab} | ${cell(maskPii(e.note || '—'))} | ${cell(maskPii(e.by_person))} |`,
      );
    }
  } else L.push('Chưa ghi nhận lỗi nghiêm trọng nào.');
  L.push(
    '',
    'Nguồn: bảng `feature_rollout_events` (kind `severe`, append-only).',
    '',
    '## 3b. Nhật ký sự cố vận hành (lỗi, mức độ, xử lý, kiểm lại)',
    '',
  );
  if (incidents === null) {
    L.push('Không đọc được sổ `ops_incidents` — CHƯA CÓ DỮ LIỆU (không suy ra 0 sự cố).');
  } else if (!incidents.length) {
    L.push(
      "Sổ `ops_incidents` chưa có sự cố nào được ghi — không phải bằng chứng 'không có sự cố' khi hệ thống chưa vận hành thật.",
    );
  } else {
    L.push(
      '| # | Mức | Phát hiện | Phản hồi | Sửa xong | Khách xong | Bên | Tiêu đề |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const i of incidents) {
      L.push(
        `| ${pyStr(i.id)} | ${i.severity} | ${tsf(i.detected_at)} | ${tsf(i.responded)} | ${tsf(i.fixed)} | ${tsf(i.resolved)} | ${i.ben} | ${cell(maskPii(i.title))} |`,
      );
    }
  }
  L.push(
    '',
    '## 4. Tiêu chí kỹ thuật (PL02 mục 2)',
    '',
    '| Chỉ tiêu | Yêu cầu | Lệnh / bằng chứng | Trạng thái |',
    '|---|---|---|---|',
  );
  const nRevSev = severe.filter((e) => e.from_stage === 'co_nguoi_duyet').length;
  CRITERIA.forEach(([name, req, cmd0, ev], i) => {
    let cmd = cmd0;
    let st: string;
    if (i === 0) {
      cmd = 'bảng `feature_rollout_events`';
      st =
        nReviewed === 0
          ? 'chưa có tính năng nào qua giai đoạn có người duyệt'
          : `${nRevSev} lỗi ghi nhận (${nReviewed} lần vào giai đoạn có người duyệt)`;
    } else st = evidenceStatus(ev, root);
    L.push(`| ${name} | ${req} | ${cell(cmd || '—')} | ${st} |`);
  });
  L.push('', '## 6. Phiên bản bàn giao (mã nguồn, schema, cấu hình, tài sản)', '');
  const vs = Object.entries(o.versions ?? {}).map(([k, v]) => `- ${k}: \`${v}\``);
  L.push(...(vs.length ? vs : ['- chưa xác định']));
  L.push('', '## 7. Ngoại lệ / blocker còn mở', '');
  const ex = (o.exceptions ?? []).map((e) => `- ${e}`);
  L.push(...(ex.length ? ex : ['- (không có dữ liệu)']));
  L.push(
    '',
    '## 8. Ký nhận',
    '',
    'Bên B ký biên bản hoặc gửi danh sách lỗi trong 30 ngày kể từ ngày NHẬN bàn giao có bằng chứng nhận (PL02 mục 1đ) — không tính từ ngày tạo tệp này. Hồ sơ này chỉ là đề xuất của hệ thống — không thay chữ ký; mẫu biên bản theo PL05 (chưa có).',
    '',
    '| Đại diện Bên A | Đại diện Bên B |',
    '|---|---|',
    '|  |  |',
    '',
  );
  return L.join('\n');
}

/** Sổ sự cố vận hành + mốc phản hồi/sửa/khách xong (sự kiện ĐẦU mỗi loại). null = không đọc được. */
export async function incidentRows(db: Db): Promise<Incident[] | null> {
  let rs: unknown[][];
  try {
    rs = await sp(db, () =>
      rowsOf(
        db,
        "select i.id, i.severity, i.detected_at, i.ben_trach_nhiem, i.title, min(e.at) filter (where e.kind = 'responded')," +
          " min(e.at) filter (where e.kind = 'fixed'), min(e.at) filter (where e.kind = 'customer_resolved')" +
          ' from ops_incidents i left join ops_incident_events e on e.incident_id = i.id group by i.id order by i.id',
        [],
      ),
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    return null;
  }
  return rs.map((r) => ({
    id: r[0],
    severity: r[1] as string,
    detected_at: r[2] as Date,
    ben: r[3] as string,
    title: r[4] as string,
    responded: r[5] as Date | null,
    fixed: r[6] as Date | null,
    resolved: r[7] as Date | null,
  }));
}

/** Commit Git + sha256 schema/roles/danh mục + trạng thái sổ tài sản. */
export function handoverVersions(root: string = REPO_ROOT): Record<string, string> {
  const out: Record<string, string> = {};
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  const r = git(['rev-parse', 'HEAD']);
  if (r.error) out.commit = 'chưa xác định';
  else {
    const dirty = pyStrip(git(['status', '--porcelain', '--untracked-files=no']).stdout ?? '');
    out.commit =
      (pyStrip(r.stdout ?? '') || 'chưa xác định') + (dirty ? ' (+ thay đổi CHƯA commit)' : '');
  }
  for (const rel of ['docs/schema.sql', 'docs/roles.sql', 'data/contract_features.json']) {
    let v: string;
    try {
      v = createHash('sha256')
        .update(readFileSync(join(root, rel)))
        .digest('hex');
    } catch {
      v = 'thiếu tệp';
    }
    out[`sha256 ${rel}`] = v;
  }
  try {
    const ts = parseJsonBytes(readFileSync(join(root, 'data', 'tai_san_hop_tac.json')));
    out['sổ tài sản hợp tác'] = pyStr(isPlainObject(ts) ? (ts.trang_thai ?? null) : null);
  } catch {
    out['sổ tài sản hợp tác'] = 'không đọc được';
  }
  return out;
}

/** Blocker chung + số mục chưa sẵn sàng (acceptance). */
export async function openExceptions(feats: Feature[]): Promise<string[]> {
  const rs = await acceptance.rows(feats);
  const s = acceptance.summary(rs);
  const out = [
    `${s.ready_for_trial}/${s.mau_so} mục đủ điều kiện chạy thử; ${s.da_nghiem_thu}/${s.mau_so} đã nghiệm thu (docs/handover/ma-tran-nghiem-thu.md)`,
  ];
  for (const [k, v] of Object.entries(acceptance.envState())) if (v) out.push(`${k}: ${v}`);
  out.push(
    'Credential DB từng lộ: rotation theo từng môi trường — đối chiếu sổ nghĩa vụ + runbook 10.7 (`scripts/db_rotate_password.py --verify`); tại 22/10/2026 chưa đóng ở môi trường nào',
    'Sự cố test chạm DB samsam 20/10/2026: UNVERIFIED (docs/handover/su-co-db-samsam.md)',
  );
  return out;
}

export async function dossier(
  db: Db,
  feats: Feature[],
  phase: string,
  shift: unknown,
  now: Date | null = null,
): Promise<string> {
  if (!PHASES.includes(phase)) throw new RangeError(`--phase phải ∈ ${tup(PHASES)}`);
  const t = now ?? new Date();
  const ids = new Set(feats.filter((f) => f.giai_doan === phase).map((f) => f.id));
  const rows = (await statusRows(db, feats, shift, t)).filter((r) => ids.has(r.feature.id));
  const w = holidayWarning();
  return renderDossier(phase, rows, await severeEvents(db, ids), await reviewedCount(db, ids), t, {
    legacy: await legacyRows(db, feats),
    warnings: w ? [w] : [],
    incidents: await incidentRows(db),
    versions: handoverVersions(),
    exceptions: await openExceptions(feats),
  });
}

/** Bản nối cho `ops/deps` (`wireCore` ở ops/wire nối sẵn). */
export const opsRollout: OpsDeps['rollout'] = {
  checkGenerate,
  decideReason,
  useReason,
  featureFor,
  quickMode,
  mode,
  catalog,
  isHuman,
  gateReport,
  labelReport,
  recordReport,
};

// ------------------------------------------------------------ CLI

export type RolloutCliOpts = {
  seed?: boolean;
  status?: boolean;
  promote?: string;
  severe?: string;
  disable?: string;
  dossier?: boolean;
  catalog?: boolean;
  outputs?: string;
  reviewOutput?: string;
  key?: string;
  sha?: string;
  decision?: string;
  by?: string;
  reason?: string;
  note?: string;
  phase?: string;
  out?: string;
};

function statusLine(r: StatusRow): string {
  const f = r.feature;
  const fx = r.facts;
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - Array.from(s).length));
  const head = `${pad(f.id, 18)} ${pad(oneline(f.ten, 40), 40)}`;
  if (r.stage === null || fx === null) return `${head} — ${f.code_status}, chưa vào sổ`;
  const out =
    fx.outputs === null ? '?' : `${fx.outputs} (${fx.out_days} ngày, ${fx.human} người duyệt)`;
  const gate =
    fx.target === null
      ? 'vận hành'
      : !fx.why.length
        ? `ĐỦ cổng → ${STAGE_LABEL[fx.target]}`
        : fx.why.join('; ');
  return `${head} ${STAGE_LABEL[r.stage]} từ ${d(r.since)} · ${fx.days} ngày LV · ${out} đầu ra · ${gate}`;
}

function printCatalog(feats: Feature[], path: string, log: (s: string) => void): void {
  const doc = parseJsonBytes(readFileSync(path)) as Record<string, Record<string, number>>;
  const tong = summary(
    feats,
    doc.so_tinh_nang_hd as Record<string, number>,
    doc.so_giai_doan_hd as Record<string, number>,
  );
  log('Danh mục yêu cầu HĐ — BẢN ĐỀ XUẤT, chờ hai bên chốt');
  for (const k of [...BLOCKS, ...PHASES, 'tong']) {
    const t = tong[k] as { hd: number; de_xuat: number; trang_thai: string };
    log(
      `${k.padEnd(14)} HĐ ${String(t.hd).padStart(2)} · đề xuất ${String(t.de_xuat).padStart(2)} · ${t.trang_thai}`,
    );
  }
  log(
    `ngoài 89: ${Object.entries(tong.ngoai_89 as Record<string, number>)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  log(
    `code_status: ${CODE_STATES.map((c) => `${c} ${feats.filter((f) => f.code_status === c).length}`).join(', ')}`,
  );
  for (const [g, ids] of Object.entries(splitMap(feats))) log(`tách ${g} → ${ids.join(', ')}`);
}

/**
 * `python -m pipelines.rollout` (tham số đã tách) → exit code: 0 ok · 1 bị từ chối (chưa đủ cổng /
 * không có trong sổ / cổng người) · 2 tham số sai / cấu hình lỗi / DB down. `open` mở kết nối (null
 * = DB down). Quyết định (promote/severe/disable/review-output) qua `auth.cliGate` (ops/deps).
 */
export async function rolloutCli(
  o: RolloutCliOpts,
  open: () => Promise<DbLease | null>,
  log: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): Promise<number> {
  const usage = (m: string) => {
    err(`[err] ${m}`);
    return 2;
  };
  const ops = [
    o.seed,
    o.status,
    o.promote,
    o.severe,
    o.disable,
    o.dossier,
    o.catalog,
    o.outputs,
    o.reviewOutput,
  ];
  const n = ops.filter((v) => v !== undefined && v !== false).length;
  if (n !== 1) {
    return usage(
      'cần đúng 1 thao tác: --seed | --status | --promote | --severe | --disable | --dossier | --catalog | --outputs | --review-output',
    );
  }
  if (o.decision !== undefined && !DECISIONS.includes(o.decision)) {
    return usage(`--decision phải ∈ ${tup(DECISIONS)}`);
  }
  if (o.reason !== undefined && !Object.hasOwn(SEVERE, o.reason)) {
    return usage(`--reason phải ∈ ${lst(pySorted(Object.keys(SEVERE)))}`);
  }
  if (o.phase !== undefined && !PHASES.includes(o.phase))
    return usage(`--phase phải ∈ ${tup(PHASES)}`);
  const writes = o.seed || o.promote || o.severe || o.disable || o.reviewOutput;
  if (writes) {
    try {
      checkBy(o.by);
    } catch (e) {
      return usage((e as Error).message);
    }
  }
  if (o.severe && !o.reason) return usage('--severe cần --reason <mã lỗi PL02 mục 2>');
  if (o.reason && !o.severe) return usage('--reason chỉ dùng với --severe');
  if (o.note !== undefined && !(o.severe || o.disable || o.reviewOutput)) {
    return usage('--note chỉ dùng với --severe/--disable/--review-output');
  }
  const rev = [o.key, o.sha, o.decision];
  if (o.reviewOutput && rev.includes(undefined))
    return usage('--review-output cần --key, --sha, --decision');
  if (!o.reviewOutput && rev.some((v) => v !== undefined)) {
    return usage('--key/--sha/--decision chỉ dùng với --review-output');
  }
  if (o.dossier && !o.phase) return usage('--dossier cần --phase P1|P2');
  if ((o.phase || o.out) && !o.dossier) return usage('--phase/--out chỉ dùng với --dossier');
  let feats: Feature[];
  let shift: unknown;
  try {
    feats = loadFeatures(settings.featuresFile);
    shift = loadShift(settings.configFile);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    err(`[FAIL] cấu hình: ${e.message}`);
    return 2;
  }
  if (o.catalog) {
    printCatalog(feats, settings.featuresFile, log);
    return 0;
  }
  const lease = await open();
  if (lease === null) {
    err('[FAIL] DB không kết nối được (DATABASE_URL)');
    return 2;
  }
  const db = lease.db;
  try {
    const fid = o.promote || o.severe || o.disable || o.reviewOutput;
    if (fid) {
      // v14.2: nâng/lùi/tắt = quyết định của người được Bên B ủy quyền cho phòng ban của tính năng.
      const act = o.promote
        ? 'promote'
        : o.severe
          ? 'severe'
          : o.disable
            ? 'disable'
            : o.decision === 'approved'
              ? 'approve'
              : 'reject';
      const f = feats.find(
        (x) => x.id === fid && (BLOCKS as readonly string[]).includes(x.phong_ban),
      );
      const blk = f ? f.phong_ban : 'data_platform';
      const why2 = await dep('auth').cliGate(
        db,
        o.by,
        blk,
        act,
        o.reviewOutput ? 'output_review' : 'feature_rollout',
        o.reviewOutput ? `${fid}:${o.key}` : fid,
        {},
      );
      if (why2) {
        err(`[TỪ CHỐI] ${why2}`);
        return 1;
      }
    }
    if (o.seed) {
      const st = await seed(db, feats, o.by);
      log(
        `[OK] vào sổ ${st.inserted} · có sẵn ${st.existing} · bỏ qua (chưa co_code) ${st.skipped}`,
      );
    } else if (o.status) {
      for (const r of await statusRows(db, feats, shift)) log(statusLine(r));
      const w = holidayWarning();
      if (w) log(w);
      for (const r of await legacyRows(db, feats)) {
        log(`[id nhóm cũ] ${legacyLine(r)} — lịch sử giữ nguyên, mục tách đếm lại từ mốc riêng`);
      }
    } else if (o.promote) {
      const r = await promote(db, feats, o.promote, o.by, shift);
      log(`[OK] ${o.promote}: ${STAGE_LABEL[r.from]} → ${STAGE_LABEL[r.to]}`);
    } else if (o.severe) {
      const r = await recordSevere(db, o.severe, o.reason as string, o.by, o.note ?? null);
      log(
        `[OK] ${o.severe}: ghi lỗi nghiêm trọng '${SEVERE[o.reason as string]}' — ${STAGE_LABEL[r.from]} → ${STAGE_LABEL[r.to]}`,
      );
    } else if (o.disable) {
      const r = await disable(db, o.disable, o.by, o.note ?? null);
      log(`[OK] ${o.disable}: ${STAGE_LABEL[r.from]} → tắt`);
    } else if (o.outputs) {
      const rows = await pendingOutputs(db, feats, o.outputs, null, o.by ?? null);
      for (const p of rows) {
        const st = p.review === null ? 'CHƯA DUYỆT' : `${p.review[0]} bởi ${maskPii(p.review[1])}`;
        log(`${p.key}\t${d(p.ts)}\tsha=${p.sha}\t${st}`);
      }
      const nn = rows.filter((p) => p.review === null).length;
      log(`[OK] ${o.outputs}: ${rows.length} đầu ra cần người duyệt từng mục, ${nn} chưa duyệt`);
    } else if (o.reviewOutput) {
      const rid = await reviewOutput(
        db,
        feats,
        o.reviewOutput,
        o.key as string,
        o.sha,
        o.decision as string,
        o.by,
        o.note ?? null,
      );
      log(`[OK] ${o.reviewOutput}: ${o.key} → ${o.decision} (sổ output_reviews #${rid})`);
    } else {
      const text = await dossier(db, feats, o.phase as string, shift);
      let path: string;
      if (o.out) {
        const p = resolve(o.out);
        path = await writeReport(text, dirname(p), basename(p), false);
      } else {
        path = await writeReport(
          text,
          REPORTS_DIR,
          `nghiem-thu-${o.phase}-${vnFormat(new Date(), '%Y-%m-%d')}.md`,
          false,
        );
      }
      log(`[OK] hồ sơ → ${path}`);
    }
  } catch (e) {
    if (e instanceof RolloutError) {
      err(`[TỪ CHỐI] ${e.message}`);
      return 1;
    }
    if (e instanceof RangeError) {
      err(`[FAIL] ${e.message}`);
      return 2;
    }
    if (isDbError(e)) {
      err(`[FAIL] lỗi DB: ${dbMsg(e)}`);
      return 2;
    }
    throw e;
  } finally {
    await lease.release();
  }
  return 0;
}
