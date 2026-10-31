import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { cpLen, cpSlice, isPlainObject, pyInt, squash } from '@samsam/core/ops/py';
import { PyFloat, pyFloatStr, pyLoads } from '@samsam/core/ops/py-json';
import {
  type EscalateStats,
  MISSING,
  NOT_SENT,
  ESC_LABEL as RA_ESC_LABEL,
  ESC_PREFIX as RA_ESC_PREFIX,
  ESCALATE_AFTER_MS as RA_ESCALATE_AFTER_MS,
  raiseAlert,
  ack as redAlertAck,
  escalate as redAlertEscalate,
  type Sender,
} from '@samsam/core/ops/red-alert';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { catalog, mode } from '@samsam/core/rollout/rollout';
import { KbFilterError } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import { pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import { classify } from '../intel_crawl/intel.js';
import {
  type DbLease,
  defaultJob,
  type Io,
  type JobFn,
  pyIntList,
  pyRound1,
  STD_IO,
} from './io.js';

// Port `pipelines/intel_alert.py` (v7.1 W71.2 — Red Alert intel, WP09): luật TẤT ĐỊNH quét
// `intel_items` → cảnh báo đỏ + leo thang 2 giờ chưa xác nhận.
// - 5 luật CỨNG trong code (`RULES`), từ khóa trong `data/intel_alert_rules.json` (GIẢ ĐỊNH — chờ
//   Pháp chế/Quản lý MXH): brand_negative = brand ∧ negative; regulation = regulation ∧ (chủ đề
//   tpbvsk|quang_cao hoặc cờ ruou); competitor_penalty = chủ đề doi_thu ∧ penalty; counterfeit =
//   nhóm counterfeit ĐỨNG MỘT MÌNH (sâm giả/mạo danh Ngọc Linh không cần nhắc tên Sâm Sâm);
//   legal_doc (PC-A8) = nguồn ∈ legal_sources ∧ (chủ đề tpbvsk|quang_cao hoặc cờ ruou).
//   Khớp cụm qua `intel_crawl.classify` (có dấu/không dấu, "săm lốp" ≠ "sâm"). `loadRules`
//   FAIL-CLOSED: file thiếu/rỗng/hỏng/thiếu nhóm/nhóm rỗng/lookback lạ/legal_sources sai →
//   IntelAlertConfigError (KHÔNG quét "0 luật" im lặng).
// - `scan`: tin `fetched_at >= now - lookback_hours` chưa có cảnh báo → mỗi tin khớp ĐÚNG 1
//   `raiseAlert` (người nhận độc lập; thiếu → dòng vẫn ghi + route_error). `unrouted` = cảnh báo
//   CHƯA THÔNG BÁO được → `--run` exit 1. Unique index chặn báo trùng khi chạy song song → `dup`.
// - HĐ 6.7 (P8.3): luật thuộc tính năng ĐANG TẮT (danh mục `output_sources` red_alerts +
//   source_agent + rules_any) không sinh cảnh báo; tin chỉ khớp luật tính năng tắt → không ghi,
//   đếm `off`, KHÔNG đánh dấu (bật lại trong cửa sổ lookback thì lần quét sau báo).
// - `escalate`: dùng CHUNG `red_alert.escalate` lọc nguồn intel (cùng unique index với job leo
//   thang mọi nguồn). `ack`: NGƯỜI xác nhận cảnh báo gốc intel rồi giao `red_alert.ack` (đường
//   xác nhận chung — chặn agent:/system:, chế độ thực chỉ người nhận độc lập).
// - Không tự mở mạng, không gọi LLM: chỉ ghi DB qua `raiseAlert` (core gửi email tới người nhận
//   ĐỘC LẬP đã cấu hình — không ai khác).

export const RULES_FILE = dataPath('intel_alert_rules.json');
export const GROUPS = ['brand', 'negative', 'regulation', 'penalty', 'counterfeit'] as const;
export const RULES = [
  'brand_negative',
  'regulation',
  'competitor_penalty',
  'counterfeit',
  'legal_doc',
] as const;
export const REG_TOPICS = ['tpbvsk', 'quang_cao'];
const SRC_ID_RE = /^[a-z0-9_-]+$/;
export const SOURCE_AGENT = 'intel_red_alert';
// Hằng code — KHÔNG đọc từ file (cấu hình không nới được thời hạn leo thang).
export const ESCALATE_AFTER_MS = RA_ESCALATE_AFTER_MS;
export const ALERT_PREFIX = '[BÁO ĐỎ intel] ';
export const ESC_LABEL = RA_ESC_LABEL;
export const ESC_PREFIX = RA_ESC_PREFIX;
export const TITLE_MAX = 200;
export const BY_MAX = 100;
export const NOTE_MAX = 500;
export const BIGINT_MAX = 2n ** 63n - 1n;
export const JOB = 'pipelines.intel_alert';

const NEW_SQL =
  'select i.id, i.title, i.snippet, i.topics, i.flags, i.url, i.source,' +
  " to_json(i.published_at)#>>'{}' as published_iso, to_json(i.fetched_at)#>>'{}' as fetched_iso" +
  ' from intel_items i' +
  ' where i.fetched_at >= $1 and not exists (select 1 from red_alerts r' +
  " where r.source_agent = $2 and r.detail ? 'intel_item_id'" +
  " and r.detail->>'intel_item_id' = i.id::text) order by i.id";
const OPEN_SQL =
  "select r.id, r.ts, r.title, r.detail->>'url' as url, r.recipients," +
  ' r.route_error, exists (select 1 from red_alerts e' +
  " where e.source_agent = $1 and e.detail ? 'escalation_of'" +
  " and e.detail->>'escalation_of' = r.id::text) as escalated" +
  ' from red_alerts r where r.source_agent = $1' +
  " and r.detail ? 'intel_item_id'" +
  ' and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)' +
  ' order by r.ts, r.id';

/** File luật cảnh báo thiếu/hỏng — fail-closed, không quét. */
export class IntelAlertConfigError extends Error {
  override name = 'IntelAlertConfigError';
}

export type Rules = {
  groups: Record<string, string[]>;
  lookback_hours: number;
  legal_sources: ReadonlySet<string>;
  status: string;
};

/** Tên lỗi Python của `json.loads(Path(p).read_bytes().decode("utf-8"))`. */
function pyReadErr(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  return 'OSError';
}

/** → {groups, lookback_hours, legal_sources, status}. Mọi lỗi → IntelAlertConfigError.
 * KHÁC Python có chủ đích: NaN/Infinity trong JSON bị coi là JSON hỏng (chặt hơn, fail-closed). */
export function loadRules(path: string = RULES_FILE): Rules {
  const name = basename(path);
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new IntelAlertConfigError(`không có file ${name}`);
    }
    throw new IntelAlertConfigError(`${name} hỏng: ${pyReadErr(e)}`);
  }
  let cfg: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new IntelAlertConfigError(`${name} hỏng: UnicodeDecodeError`);
  }
  try {
    cfg = pyLoads(text);
  } catch {
    throw new IntelAlertConfigError(`${name} hỏng: JSONDecodeError`);
  }
  if (!isPlainObject(cfg)) throw new IntelAlertConfigError(`${name}: gốc phải là object`);
  const groups = cfg.groups;
  if (!isPlainObject(groups)) throw new IntelAlertConfigError(`${name}: thiếu 'groups'`);
  const out: Record<string, string[]> = {};
  for (const g of GROUPS) {
    const ph = groups[g];
    if (
      !Array.isArray(ph) ||
      !ph.length ||
      !ph.every((x) => typeof x === 'string' && pyStrip(x) !== '')
    ) {
      throw new IntelAlertConfigError(`${name}: groups.${g} thiếu/rỗng hoặc có cụm rỗng`);
    }
    out[g] = (ph as string[]).map(pyStrip);
  }
  const lb = cfg.lookback_hours;
  if (typeof lb !== 'number' || !Number.isInteger(lb) || lb < 1 || lb > 720) {
    // PyFloat (48.0) / bool / chuỗi → không phải int như Python
    throw new IntelAlertConfigError(`${name}: lookback_hours phải 1..720`);
  }
  const legal = cfg.legal_sources;
  if (
    !Array.isArray(legal) ||
    !legal.length ||
    !legal.every((x) => typeof x === 'string' && SRC_ID_RE.test(x))
  ) {
    throw new IntelAlertConfigError(
      `${name}: legal_sources phải là list id nguồn [a-z0-9_-] không rỗng`,
    );
  }
  const st = cfg.status;
  return {
    groups: out,
    lookback_hours: lb,
    legal_sources: new Set(legal as string[]),
    status: st instanceof PyFloat ? pyFloatStr(st.v) : pyStrTruthy(st),
  };
}

/** Python `str(v or "")`. */
function pyStrTruthy(v: unknown): string {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return '';
  if (Array.isArray(v) && !v.length) return '';
  if (isPlainObject(v) && !Object.keys(v).length) return '';
  return pyStr(v);
}

export type MatchItem = {
  title?: string | null;
  snippet?: string | null;
  topics?: readonly string[] | null;
  flags?: readonly string[] | null;
  source?: string | null;
};

/** THUẦN — tên luật khớp (thứ tự RULES). Không mở URL. */
export function match(item: MatchItem, rules: Pick<Rules, 'groups' | 'legal_sources'>): string[] {
  const [hitList, cflags] = classify(item.title || '', item.snippet || '', rules.groups);
  const hit = new Set(hitList);
  const topics = new Set(item.topics ?? []);
  const flags = new Set([...cflags, ...(item.flags ?? [])]);
  const reg = REG_TOPICS.some((t) => topics.has(t)) || flags.has('ruou');
  const out: string[] = [];
  if (hit.has('brand') && hit.has('negative')) out.push('brand_negative');
  if (hit.has('regulation') && reg) out.push('regulation');
  if (topics.has('doi_thu') && hit.has('penalty')) out.push('competitor_penalty');
  if (hit.has('counterfeit')) out.push('counterfeit');
  const src = item.source;
  if (typeof src === 'string' && (rules.legal_sources ?? new Set()).has(src) && reg) {
    out.push('legal_doc');
  }
  return out;
}

type FeatureLike = { id: string; output_sources: readonly Record<string, unknown>[] };
export type OffDeps = {
  catalog: () => readonly FeatureLike[] | null;
  mode: (db: Db | null, fid: string) => Promise<string>;
};
const OFF_DEPS: OffDeps = {
  catalog: () => catalog() as unknown as FeatureLike[] | null,
  mode: (db, fid) => mode(db, fid),
};

/** Luật của tính năng đang TẮT (HĐ 6.7) → không sinh cảnh báo. Luật không thuộc tính năng nào
 * trong danh mục → không chặn (như `rollout.checkGenerate`). */
export async function offRules(db: Db | null, d: OffDeps = OFF_DEPS): Promise<Set<string>> {
  const owner = new Map<string, Set<string>>();
  for (const f of d.catalog() ?? []) {
    for (const s of f.output_sources) {
      if (s.table === 'red_alerts' && s.source_agent === SOURCE_AGENT) {
        const ra = Array.isArray(s.rules_any) && s.rules_any.length ? s.rules_any : RULES;
        for (const r of ra as string[]) {
          if (!owner.has(r)) owner.set(r, new Set());
          (owner.get(r) as Set<string>).add(f.id);
        }
      }
    }
  }
  const off = new Set<string>();
  for (const fids of owner.values()) {
    for (const fid of fids) if ((await d.mode(db, fid)) === 'tat') off.add(fid);
  }
  const out = new Set<string>();
  for (const [r, fids] of owner) if ([...fids].some((f) => off.has(f))) out.add(r);
  return out;
}

export type ScanStats = {
  scanned: number;
  alerts: number;
  dup: number;
  unrouted: number;
  ids: number[];
  off: number;
};
export type AlertOpts = {
  routing?: unknown;
  /** undefined = gửi theo cấu hình kênh thư của env trong core red-alert (Python `red_alert._ENV`). */
  sender?: Sender | null;
  env?: Env;
};

/** Quét tin mới → cảnh báo đỏ. `off` = tin chỉ khớp luật của tính năng TẮT (không ghi). */
export async function scan(
  db: Db,
  now: Date,
  o: AlertOpts & { rules?: Rules; offDeps?: OffDeps; raise?: typeof raiseAlert } = {},
): Promise<ScanStats> {
  const rules = o.rules ?? loadRules();
  const since = new Date(now.getTime() - rules.lookback_hours * 3600_000);
  const { rows } = await db.query(NEW_SQL, [since, SOURCE_AGENT]);
  const off = rows.length ? await offRules(db, o.offDeps) : new Set<string>();
  const st: ScanStats = { scanned: rows.length, alerts: 0, dup: 0, unrouted: 0, ids: [], off: 0 };
  const raise = o.raise ?? raiseAlert;
  for (const r of rows) {
    let hits = match(
      { title: r.title, snippet: r.snippet, topics: r.topics, flags: r.flags, source: r.source },
      rules,
    );
    if (hits.length && off.size && hits.every((h) => off.has(h))) {
      st.off++; // P8.3: tính năng tắt → không sinh
      continue;
    }
    hits = hits.filter((h) => !off.has(h));
    if (!hits.length) continue;
    const iid = Number(r.id); // shortcut: id identity < 2^53
    let routed: boolean;
    try {
      [routed] = await raise(
        db,
        SOURCE_AGENT,
        ALERT_PREFIX + oneline(r.title, TITLE_MAX),
        {
          intel_item_id: iid,
          rules: hits,
          url: r.url,
          source: r.source,
          published_at: r.published_iso ?? null,
          fetched_at: r.fetched_iso ?? null,
        },
        o.routing ?? null,
        o.sender,
        o.env ?? process.env,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        st.dup++; // tiến trình khác vừa báo cùng tin
        continue;
      }
      throw e;
    }
    st.alerts++;
    if (!routed) st.unrouted++;
    const got = await db.query(
      "select id from red_alerts where source_agent = $1 and detail ? 'intel_item_id' and detail->>'intel_item_id' = $2",
      [SOURCE_AGENT, String(iid)],
    );
    st.ids.push(Number(got.rows[0].id));
  }
  return st;
}

/** Cảnh báo gốc intel quá 2 giờ chưa xác nhận → 1 bản leo thang (1 cấp). Dùng CHUNG
 * `red_alert.escalate` (lọc nguồn intel) — cùng luật, cùng unique index với job mọi nguồn. */
export function escalate(db: Db, now: Date, o: AlertOpts = {}): Promise<EscalateStats> {
  return redAlertEscalate(db, now, o.routing ?? null, o.sender, {
    source: SOURCE_AGENT,
    env: o.env,
  });
}

/** Người xác nhận cảnh báo gốc intel → [true, msg] | [false, lý do]. Không ném với đầu vào lỗi. */
export async function ack(
  db: Db,
  alertId: unknown,
  by: unknown,
  note: unknown = null,
  o: { env?: Env; routing?: unknown } = {},
): Promise<[boolean, string]> {
  const who = maskPii(cpSlice(squash(pyStr(by || '')), 0, BY_MAX + 1));
  if (!who) return [false, 'thiếu tên người xác nhận (--by)'];
  if (cpLen(who) > BY_MAX) return [false, `tên người xác nhận dài quá ${BY_MAX} ký tự`];
  const aid = pyInt(alertId) ?? 0n;
  if (!(aid >= 1n && aid <= BIGINT_MAX)) {
    return [false, `id '${oneline(pyStr(alertId || ''), 40)}' không hợp lệ`];
  }
  // Cắt TRƯỚC regex mask (chống DoS), cắt lại sau mask.
  const n = note
    ? cpSlice(maskPii(cpSlice(pyStrip(pyStr(note)), 0, NOTE_MAX * 2)), 0, NOTE_MAX) || null
    : null;
  const { rows } = await db.query('select source_agent, detail from red_alerts where id = $1', [
    String(aid),
  ]);
  if (!rows[0]) return [false, `không tìm thấy cảnh báo #${aid}`];
  const detail = isPlainObject(rows[0].detail) ? rows[0].detail : {};
  if (rows[0].source_agent !== SOURCE_AGENT) {
    return [false, `cảnh báo #${aid} không thuộc Red Alert intel`];
  }
  if ('escalation_of' in detail) {
    const root = 'escalation_root' in detail ? detail.escalation_root : detail.escalation_of;
    return [false, `#${aid} là bản leo thang — xác nhận id gốc #${pyStr(root)}`];
  }
  if (!('intel_item_id' in detail)) {
    return [false, `cảnh báo #${aid} không phải cảnh báo gốc intel`];
  }
  return redAlertAck(db, String(aid), who, n, { env: o.env, routing: o.routing });
}

export type OpenIntelAlert = {
  id: number;
  ts: Date;
  title: string;
  url: string | null;
  recipients: string[];
  route_error: string | null;
  escalated: boolean;
  age_h: number;
};

/** Cảnh báo gốc intel CHƯA xác nhận (cũ nhất trước), kèm `escalated`, `age_h`. */
export async function openAlerts(db: Db, now: Date): Promise<OpenIntelAlert[]> {
  const { rows } = await db.query(OPEN_SQL, [SOURCE_AGENT]);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: r.ts,
    title: r.title,
    url: r.url,
    recipients: [...(r.recipients ?? [])],
    route_error: r.route_error,
    escalated: Boolean(r.escalated),
    age_h: pyRound1((now.getTime() - (r.ts as Date).getTime()) / 3600_000),
  }));
}

export function printOpen(rows: OpenIntelAlert[], out: (s: string) => void): void {
  if (!rows.length) {
    out('[open] không có cảnh báo đỏ intel đang mở');
    return;
  }
  out(`[open] ${rows.length} cảnh báo đỏ intel chưa xác nhận:`);
  for (const d of rows) {
    const esc = d.escalated ? ' · ĐÃ LEO THANG' : '';
    const rcp = d.recipients.length
      ? d.recipients.join(', ')
      : `CHƯA AI NHẬN (${d.route_error || '?'})`;
    out(
      `  #${d.id} ${pyFloatStr(d.age_h)}h${esc} — ${oneline(maskPii(d.title || ''), 120)} — ${rcp}`,
    );
  }
}

/** `--run`: quét + leo thang → [exit, tóm tắt]. */
export async function runOnce(
  db: Db,
  rules: Rules,
  now: Date,
  out: (s: string) => void,
  o: AlertOpts & { offDeps?: OffDeps } = {},
): Promise<[number, string]> {
  const s = await scan(db, now, { ...o, rules });
  const e = await escalate(db, now, o);
  const unrouted = s.unrouted + e.unrouted;
  const summary =
    `scanned=${s.scanned} alerts=${s.alerts} dup=${s.dup} off=${s.off}` +
    ` escalated=${e.escalated} esc_dup=${e.dup} unrouted=${unrouted}`;
  out(`[done] ${summary} alert_ids=${pyIntList(s.ids)} escalated_of=${pyIntList(e.ids)}`);
  if (rules.status === 'gia_dinh') {
    out('[warn] bộ từ khóa cảnh báo là GIẢ ĐỊNH — chờ Pháp chế/Quản lý MXH duyệt');
  }
  if (unrouted) {
    out(
      `[RED-ALERT][warn] ${unrouted} cảnh báo đã ghi nhưng CHƯA thông báo được (${MISSING} hoặc ${NOT_SENT}) — fail-closed, exit 1`,
    );
    return [1, summary];
  }
  return [0, summary];
}

// ---------------------------------------------------------------- CLI

export type IntelAlertOpts = {
  run?: boolean;
  ack?: string;
  open?: boolean;
  by?: string;
  note?: string;
};
export type IntelAlertDeps = {
  io?: Io;
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/auth/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => unknown;
  clock?: () => Date;
  rulesFile?: string;
  job?: JobFn;
  alert?: AlertOpts & { offDeps?: OffDeps };
};

/** `python -m pipelines.intel_alert` (tham số đã tách) → exit code.
 * Exit: 0 ok · 1 luật hỏng / DB lỗi / có cảnh báo nhưng thiếu người nhận (fail-closed) / xác nhận
 * bị từ chối · 2 tham số sai. */
export async function intelAlertMain(o: IntelAlertOpts, d: IntelAlertDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`intel_alert: error: ${m}`);
    return 2;
  };
  const ops = (
    [
      ['--run', Boolean(o.run)],
      ['--ack', o.ack !== undefined],
      ['--open', Boolean(o.open)],
    ] as const
  ).filter(([, on]) => on);
  if (!ops.length) return usage('one of the arguments --run --ack --open is required');
  if (ops.length > 1) {
    return usage(`argument ${ops[1]?.[0]}: not allowed with argument ${ops[0]?.[0]}`);
  }
  if (o.ack !== undefined && pyInt(o.ack) === null) {
    return usage(`argument --ack: invalid int value: ${pyRepr(String(o.ack))}`);
  }
  if (o.ack !== undefined && !pyStrip(o.by ?? '')) return usage('--ack cần --by <tên người>');
  if (o.ack === undefined && (o.by !== undefined || o.note !== undefined)) {
    return usage('--by/--note chỉ dùng với --ack');
  }
  let rules: Rules | null = null;
  if (o.run) {
    try {
      rules = loadRules(d.rulesFile);
    } catch (e) {
      if (!(e instanceof IntelAlertConfigError)) throw e;
      io.out(`[err] luật cảnh báo hỏng: ${e.message} — không quét`);
      return 1;
    }
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.out('[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 1;
  }
  const db = lease.db;
  (d.wire ?? ((x: Db) => wireCore(x)))(db);
  const now = (d.clock ?? (() => new Date()))();
  try {
    if (o.open) {
      printOpen(await openAlerts(db, now), io.out);
      return 0;
    }
    if (o.ack !== undefined) {
      const [ok, msg] = await ack(db, pyInt(o.ack), o.by, o.note ?? null, {
        env,
        routing: d.alert?.routing,
      });
      io.out(`[${ok ? 'done' : 'warn'}] ${msg}`);
      return ok ? 0 : 1;
    }
    return await (d.job ?? defaultJob(env))(JOB, async (jr) => {
      const [rc, summary] = await runOnce(db, rules as Rules, now, io.out, { env, ...d.alert });
      jr.ok = rc === 0;
      jr.detail = summary;
      return rc;
    });
  } catch (e) {
    if (e instanceof KbFilterError) {
      io.out(`[err] bộ lọc rượu hỏng: ${e.message} — không quét`);
      return 1;
    }
    if (!isDbError(e)) throw e;
    const hint =
      (e as { code?: string }).code === '42P01' ? ' — chạy `python scripts/apply_schema.py`' : '';
    io.out(`[err] lỗi DB: ${dbMsg(e) || e.name}${hint}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
}
