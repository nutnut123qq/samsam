import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as aq from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
  submit,
} from '@samsam/core/ops/director';
import {
  businessDeadline,
  businessMinutes,
  MAX_SCAN_DAYS,
  parseShift,
  vnDate,
  vnFormat,
} from '@samsam/core/ops/period';
import {
  cpCmp,
  isDict,
  isPyInt,
  PyFloat,
  parsePyJson,
  pyFloatStr,
  pyNum,
} from '@samsam/core/ops/py-json';
import { raiseAlert } from '@samsam/core/ops/red-alert';
import { DATA_DIR } from '@samsam/core/paths';
import { ROLES } from '@samsam/core/security/auth';
import { pyRepr, pyReprValue, pyStrip } from '@samsam/core/security/py';
import pg from 'pg';
import { CONV_FILES, channelOf, dedupKey, iterConvlog, parseTs, type Rec } from './convlog.js';
import { type LeadOwner, STAFF_RE, section } from './sales-watch.js';

// Port `agents/sales_director.py` (v5.0 WP07, khối `sales`, luồng F03c "Handoff A/B, SLA,
// escalation") — agent GĐ Kinh doanh TMĐT trên khung v4.0 (`ops/director` + `approval_queue` +
// `red_alert`).
// - Cấu hình `data/directors/sales.json` = luật v4.0 (core `loadConfig`) + luật riêng khối KD:
//   mọi loại việc có `handoff` A|B + `label`; lớp A = 2, B = 4 giờ LÀM VIỆC (khóa cứng WP07); role ⊂
//   ROLES; `market_alert_s1` risk PHẢI high; `sla_hours` ≥ thời lượng đồng hồ tệ nhất của SLA lớp đó.
// - `collect` (THUẦN đọc) 4 nguồn thật → mục hàng duyệt theo ĐỢT (`ma:<id>:<opened_at UTC>`,
//   `gd:<id>`, `cskh:<nhóm khách/ngày>[:<ts đầu đợt>]`, `lead:<id>:chua_gan|<owner_assigned_at>`),
//   idempotent theo (object_type, object_id) ở BẤT KỲ status; payload/title dựng từ TEMPLATE — KHÔNG
//   câu hỏi khách, tiêu đề listing, sku_key, detail.
// - `sweep`: expire tuyệt đối (không bao giờ approved) → leo thang mục chưa leo thang (quá SLA giờ
//   làm việc hoặc đã quá `due_at`) → `sla_escalations`; lớp A kèm cảnh báo đỏ cùng giao dịch.
//   Agent KHÔNG gọi hàm duyệt/tự duyệt/ép QA.
// - Mọi hàm thời gian nhận `now`; chỉ CLI đọc đồng hồ.

export const BLOCK = 'sales';
export const AGENT = 'agent:sales_director';
export const JOB = 'agents.sales_director';
export const SWEEP_BY = 'system:sla:sales';
export const CLASS_HOURS: Record<string, number> = { A: 2, B: 4 }; // WP07: A 2h, B 4h làm việc
export const SOURCE_TYPES = [
  'cskh_handoff',
  'market_alert_s1',
  'market_alert_s2',
  'price_review',
  'lead_followup',
];
export const PERIODS = ['day', 'week'];
// Nhãn mã cảnh báo sàn trong payload — KHÔNG đưa mã thô (vd chứa từ khóa rượu → guardrail chặn
// approve vĩnh viễn).
export const ALERT_LABELS: Record<string, string> = {
  alcohol_listed: 'listing thuộc nhóm hàng cấm bán online',
  price_mismatch: 'lệch giá niêm yết so với bảng giá',
  tpbvsk_ads_no_xnqc: 'quảng cáo TPBVSK chưa có XNQC',
  item_unmapped: 'sản phẩm trên sàn chưa map SKU',
};
export const PRICE_LABELS: Record<string, string> = {
  price_mismatch: 'lệch giá golden so với kênh bán',
  missing_price: 'thiếu giá trong bảng giá golden',
};
export const STATE_ORDER = ['overdue', 'due_soon', 'on_time'];
// Lớp A cảnh báo đỏ TỪNG mục (pháp lý, nguồn do hệ thống sinh); lớp A khác (cskh_* — đầu vào khách
// kiểm soát) gom 1 cảnh báo/loại/lần quét.
export const RED_PER_ITEM = new Set(['market_alert_s1']);
export const EXPIRED_LOOKBACK_MS = 7 * 86_400_000; // mục quá due_at chưa leo thang
export const MAX_ALERT_IDS = 100; // queue_ids trong 1 cảnh báo gộp
const CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
// Khóa ĐỢT theo micro giây như Python `%Y%m%dT%H%M%S%fZ` — Date của JS chỉ tới mili giây.
const US_KEY = `'YYYYMMDD"T"HH24MISSUS"Z"'`;
const PENDING_SQL =
  "select id, object_type, created_at, due_at from approval_queue where block = $1 and status = 'pending' order by id";
const CAND_SQL =
  'select a.id, a.object_type, a.created_at, a.due_at, a.status from approval_queue a where a.block = $1' +
  " and (a.status = 'pending' or (a.status = 'expired' and a.due_at >= $2)) and not exists" +
  ' (select 1 from sla_escalations e where e.queue_id = a.id) order by a.id';
const ESC_SQL =
  'insert into sla_escalations (queue_id, block, handoff_class, assignee_role, escalate_to_role,' +
  ' business_due_at, red_alert, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)' +
  ' on conflict (queue_id) do nothing returning id';

// ---------------------------------------------------------------- cấu hình

export type HandoffClass = {
  business_hours: number;
  assignee_role: string;
  escalate_to_role: string;
  red_alert: boolean;
  due_soon_minutes: number;
};
export type TypeSpec = { sla_hours: number; risk: string; handoff: string; label: string };
export type SalesConfig = DirectorConfig & {
  object_types: Record<string, TypeSpec>;
  handoff_classes: Record<string, HandoffClass>;
  business_hours: { start: string; end: string; workdays: number[]; holidays?: string[] };
  sources: {
    convlog_lookback_hours: number;
    lead_stale_business_hours: number;
    max_cskh_per_run: number;
    price_discrepancy_kinds: string[];
  };
  regions: Record<string, string[]>;
  lead_owner?: LeadOwner;
};

const intIn = (v: unknown, lo: number, hi: number) => isPyInt(v) && lo <= v && v <= hi;
const nonblank = (v: unknown): v is string => typeof v === 'string' && pyStrip(v) !== '';
const pyList = (xs: string[]) => `[${xs.map(pyRepr).join(', ')}]`;
const repr = (v: unknown) => (v instanceof PyFloat ? pyFloatStr(v.v) : pyReprValue(v));
const pyStrNum = (v: unknown) => (v instanceof PyFloat ? pyFloatStr(v.v) : String(v));
/** Python `format(x, 'g')` cho số giờ (1e-4 ≤ x < 1e6). */
const fmtG = (x: number) => String(Number(x.toPrecision(6)));

/** Thời lượng ĐỒNG HỒ tệ nhất (giờ) để đủ `hours` giờ làm việc, quét mốc 15 phút trên 1 tuần không
 * lễ (vd A 2h: T6 18:00 → T2 10:00 = 64h). KHÔNG tính lễ — mục hết hạn tuyệt đối trước hạn giờ làm
 * việc (Tết) vẫn được `sweep` leo thang (lý do `expired`). */
export function worstClockHours(shift: unknown, hours: number): number {
  const s = { ...parseShift(shift), holidays: new Set<string>() };
  const t0 = Date.parse('2026-01-05T00:00:00+07:00'); // thứ Hai
  let worst = 0;
  for (let i = 0; i < 7 * 96; i++) {
    const t = new Date(t0 + i * 15 * 60_000);
    worst = Math.max(worst, businessDeadline(t, hours, s).getTime() - t.getTime());
  }
  return worst / 3_600_000;
}

/** Luật riêng khối KD (sau luật v4.0) trên bản đọc `parsePyJson` (int ≠ float như Python). */
export function validateSales(cfg: Record<string, unknown>): void {
  const err = (msg: string) => new DirectorConfigError(`${BLOCK}: ${msg}`);
  const classes = cfg.handoff_classes;
  const ck = Object.keys(CLASS_HOURS);
  if (
    !isDict(classes) ||
    Object.keys(classes).length !== ck.length ||
    !ck.every((k) => Object.hasOwn(classes, k))
  ) {
    throw err("'handoff_classes' phải có đúng 2 lớp A, B");
  }
  for (const [k, c] of Object.entries(classes)) {
    const want = CLASS_HOURS[k] as number;
    if (!isDict(c) || pyNum(c.business_hours) !== want) {
      throw err(
        `lớp ${k}: business_hours phải = ${want} (khóa theo WP07 — đổi phải sửa code + test)`,
      );
    }
    for (const r of ['assignee_role', 'escalate_to_role']) {
      if (!(ROLES as readonly unknown[]).includes(c[r])) {
        throw err(`lớp ${k}: ${r} ${repr(c[r])} không thuộc (${ROLES.map(pyRepr).join(', ')})`);
      }
    }
    if (typeof c.red_alert !== 'boolean') throw err(`lớp ${k}: red_alert phải true|false`);
    if (!intIn(c.due_soon_minutes, 1, 600)) throw err(`lớp ${k}: due_soon_minutes phải 1..600`);
  }
  if ((classes.A as Record<string, unknown>).red_alert !== true) {
    throw err('lớp A quá hạn PHẢI bật cảnh báo đỏ (WP07)');
  }
  try {
    parseShift(cfg.business_hours);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw err(`business_hours: ${e.message}`);
  }
  const types = cfg.object_types as Record<string, Record<string, unknown>>;
  const missing = SOURCE_TYPES.filter((t) => !Object.hasOwn(types, t));
  if (missing.length) throw err(`thiếu loại việc nguồn ${pyList(missing)}`);
  const worst: Record<string, number> = {};
  for (const [k, h] of Object.entries(CLASS_HOURS))
    worst[k] = worstClockHours(cfg.business_hours, h);
  for (const [t, spec] of Object.entries(types)) {
    const h = spec.handoff;
    if (typeof h !== 'string' || !Object.hasOwn(CLASS_HOURS, h))
      throw err(`${t}: handoff phải A|B`);
    if (!nonblank(spec.label)) throw err(`${t}: thiếu label`);
    if ((pyNum(spec.sla_hours) ?? 0) < (worst[h] as number)) {
      throw err(
        `${t}: sla_hours ${pyStrNum(spec.sla_hours)} < ${fmtG(worst[h] as number)} giờ đồng hồ tệ nhất` +
          ` của SLA lớp ${h} — mục sẽ expired trước khi kịp leo thang`,
      );
    }
  }
  if (types.market_alert_s1?.risk !== 'high') {
    throw err('market_alert_s1 risk PHẢI high (S1 không vào lane tự duyệt)');
  }
  const src = cfg.sources;
  if (
    !isDict(src) ||
    !intIn(src.convlog_lookback_hours, 1, 720) ||
    !intIn(src.lead_stale_business_hours, 1, 720)
  ) {
    throw err('sources: convlog_lookback_hours/lead_stale_business_hours phải 1..720');
  }
  if (!intIn(src.max_cskh_per_run, 1, 1000)) {
    throw err(
      'sources.max_cskh_per_run phải 1..1000 (trần mục CSKH mới mỗi lần chạy — chống spam kênh inbound)',
    );
  }
  const kinds = src.price_discrepancy_kinds;
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every(nonblank)) {
    throw err('sources.price_discrepancy_kinds phải là list chuỗi');
  }
  const regions = cfg.regions;
  if (
    !isDict(regions) ||
    !Object.keys(regions).length ||
    !Object.entries(regions).every(
      ([n, kw]) => nonblank(n) && Array.isArray(kw) && kw.length > 0 && kw.every(nonblank),
    )
  ) {
    throw err('regions phải là {tên vùng: [từ khóa tỉnh không rỗng]}');
  }
}

/** Cấu hình khối KD → cfg | DirectorConfigError (kèm `lead_owner` từ `data/sales_watch.json`). */
export function loadSalesConfig(baseDir: string = DIRECTORS_DIR, watchPath?: string): SalesConfig {
  const cfg = loadConfig(BLOCK, baseDir) as SalesConfig; // luật v4.0 (lỗi nổi lên như Python)
  // Đọc lại chữ file bằng parsePyJson: core gộp int/float như JSON.parse, luật KD thì phân biệt.
  validateSales(
    parsePyJson(readFileSync(join(baseDir, `${BLOCK}.json`), 'utf8')) as Record<string, unknown>,
  );
  try {
    cfg.lead_owner = section('lead_owner', watchPath) as LeadOwner;
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new DirectorConfigError(`${BLOCK}: ${e.message}`);
  }
  return cfg;
}

export type Route = {
  object_type: string;
  handoff: string;
  risk: string;
  label: string;
  assignee_role: string;
  escalate_to_role: string;
  red_alert: boolean;
  auto_eligible: boolean;
};

/** Loại việc → lớp handoff, rủi ro, người nhận, leo thang. */
export function route(cfg: SalesConfig, objectType: string): Route {
  const spec = Object.hasOwn(cfg.object_types, objectType)
    ? cfg.object_types[objectType]
    : undefined;
  if (spec === undefined) throw new RangeError(`khối ${BLOCK} không có loại việc '${objectType}'`);
  const cls = cfg.handoff_classes[spec.handoff] as HandoffClass;
  return {
    object_type: objectType,
    handoff: spec.handoff,
    risk: spec.risk,
    label: spec.label,
    assignee_role: cls.assignee_role,
    escalate_to_role: cls.escalate_to_role,
    red_alert: cls.red_alert,
    // auto_policy chỉ áp risk low (DB chặn cứng) — medium/high luôn cần người duyệt.
    auto_eligible: spec.risk === 'low',
  };
}

export function alertType(severity: string): string {
  if (severity === 'S1') return 'market_alert_s1';
  if (severity === 'S2') return 'market_alert_s2';
  throw new RangeError(`severity '${severity}' lạ — S1|S2`);
}

/** Python `_check_now`: JS không có datetime naive — chỉ chặn giá trị không phải thời điểm. */
export function checkNow(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('now phải là datetime có múi giờ (aware)');
  }
  return now;
}

export type SlaState = {
  handoff_class: string;
  business_due_at: Date;
  state: 'on_time' | 'due_soon' | 'overdue';
  assignee_role: string;
  escalate_to_role: string;
  red_alert: boolean;
};

/** THUẦN: hạn giờ làm việc + trạng thái on_time|due_soon|overdue. */
export function slaState(
  item: { object_type: string; created_at: Date },
  cfg: SalesConfig,
  now: Date,
): SlaState {
  checkNow(now);
  const r = route(cfg, item.object_type);
  const cls = cfg.handoff_classes[r.handoff] as HandoffClass;
  const due = businessDeadline(item.created_at, cls.business_hours, cfg.business_hours);
  let state: SlaState['state'];
  if (now >= due) state = 'overdue';
  else if (businessMinutes(now, due, cfg.business_hours) <= cls.due_soon_minutes)
    state = 'due_soon';
  else state = 'on_time';
  return {
    handoff_class: r.handoff,
    business_due_at: due,
    state,
    assignee_role: r.assignee_role,
    escalate_to_role: r.escalate_to_role,
    red_alert: r.red_alert,
  };
}

// ---------------------------------------------------------------- nguồn việc

export const fmtVn = (ts: Date | null | undefined): string =>
  ts ? vnFormat(ts, '%d/%m/%Y %H:%M') : '—';

/** Mã kênh/loại file từ DB → chỉ [a-z0-9_.-] (không lọt free text). */
export function code(v: unknown): string {
  const s = typeof v === 'string' ? pyStrip(v).toLowerCase() : '';
  return CODE_RE.test(s) ? s : 'khác';
}

export const ref = (objectId: string): string =>
  createHash('sha1').update(objectId, 'utf8').digest('hex').slice(0, 10);

/** `%Y%m%dT%H%M%SZ` theo UTC. */
const utcSecKey = (d: Date) =>
  `${d.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;

/** Khóa NHÓM khách/ngày VN: `cskh:<sha1(user_hash|ngày)[:16]>`; entry thiếu `user_hash` → theo
 * từng entry (`dedupKey`). Đợt sau trong nhóm (câu hỏi mới SAU khi mục trước đã quyết) thêm
 * `:<ts đầu đợt UTC>` (`collectAll`). */
export function cskhObjectId(rec: Rec, ts: Date): string {
  const uh = rec.user_hash;
  if (!nonblank(uh)) return dedupKey(rec);
  const raw = `${pyStrip(uh)}|${vnDate(ts)}`;
  return `cskh:${createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

export type CskhGroup = {
  object_id: string;
  channel: string;
  ts: Date;
  n: number;
  recs: [Date, string][];
};

/** Entry convlog `answered === false` (live) có ts trong [now - lookback, now] (dedup theo
 * `dedupKey`) → nhóm theo `cskhObjectId`, cũ nhất trước. KHÔNG mang câu hỏi/user_hash. */
export function unanswered(now: Date, cfg: SalesConfig, dataDir: string): CskhGroup[] {
  const since = now.getTime() - cfg.sources.convlog_lookback_hours * 3_600_000;
  const groups = new Map<string, CskhGroup>();
  const seen = new Set<string>();
  const stats = { corrupt: 0, doc: 0, io_error: 0 };
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    // docx P1: chỉ câu khách THẬT (mock/demo/dòng thiếu provenance không sinh mục CSKH/SLA thật).
    for (const rec of iterConvlog(path, stats, true)) {
      if (rec.answered !== false) continue;
      const ts = parseTs(rec.ts);
      if (ts === null || !(since <= ts.getTime() && ts <= now)) continue;
      const key = dedupKey(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      const oid = cskhObjectId(rec, ts);
      const ch = channelOf(rec);
      const g = groups.get(oid);
      if (g === undefined) {
        groups.set(oid, { object_id: oid, channel: ch, ts, n: 1, recs: [[ts, ch]] });
      } else {
        g.n++;
        g.recs.push([ts, ch]);
        if (ts < g.ts) {
          g.ts = ts;
          g.channel = ch;
        }
      }
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.recs.sort((a, b) => a[0].getTime() - b[0].getTime()); // ổn định như sorted
  return out.sort((a, b) => a.ts.getTime() - b.ts.getTime() || cpCmp(a.object_id, b.object_id));
}

/** Khóa nhóm `cskh:<16hex>` → [còn mục pending?, decided_at muộn nhất] trên MỌI đợt của nhóm. */
async function cskhState(db: Db): Promise<Map<string, [boolean, Date | null]>> {
  const state = new Map<string, [boolean, Date | null]>();
  const { rows } = await db.query(
    "select object_id, status, decided_at from approval_queue where object_type = 'cskh_handoff' and object_id like $1",
    ['cskh:%'],
  );
  for (const r of rows) {
    const base = (r.object_id as string).split(':').slice(0, 2).join(':');
    let [pend, last] = state.get(base) ?? [false, null];
    if (r.status === 'pending') pend = true;
    else if (r.decided_at !== null && (last === null || r.decided_at > last)) last = r.decided_at;
    state.set(base, [pend, last]);
  }
  return state;
}

export type Item = { object_type: string; object_id: string; title: string; payload: string };
export type Stats = { deferred?: number };

/** THUẦN đọc → mục SẼ đẩy vào hàng duyệt (chưa có ở bất kỳ status). */
export async function collect(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  dataDir: string = DATA_DIR,
): Promise<Item[]> {
  return (await collectAll(db, now, cfg, dataDir))[0];
}

/** Python `_collect` → [mục sẽ đẩy, số nhóm CSKH mới vượt trần]. v15.2 (P8.6): `stats.deferred` ←
 * số `lead_followup` đến hạn vượt trần (chờ lần sau). */
export async function collectAll(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  dataDir: string = DATA_DIR,
  stats?: Stats,
): Promise<[Item[], number]> {
  checkNow(now);
  const seen = new Set<string>();
  const k = (t: string, o: string) => `${t}\u0000${o}`;
  for (const r of (
    await db.query(
      'select object_type, object_id from approval_queue where object_type = any($1)',
      [SOURCE_TYPES],
    )
  ).rows) {
    seen.add(k(r.object_type, r.object_id));
  }
  const types = cfg.object_types;
  const items: Item[] = [];
  const add = (ot: string, oid: string, title: string, payload: string) => {
    if (seen.has(k(ot, oid))) return;
    seen.add(k(ot, oid));
    items.push({
      object_type: ot,
      object_id: oid,
      title: `${(types[ot] as TypeSpec).label} — ${title}`,
      payload,
    });
  };
  // Theo ĐỢT: market_csv reopen cùng dòng và đặt `opened_at` mới; khóa chuẩn hóa UTC.
  const ma = await db.query(
    `select id, kind, severity, channel, export_kind, opened_at, to_char(opened_at at time zone 'UTC', ${US_KEY}) as opened_key from market_alerts where status = 'open' order by id`,
  );
  for (const r of ma.rows) {
    const aid = String(r.id);
    add(
      alertType(r.severity),
      `ma:${aid}:${r.opened_key}`,
      `cảnh báo #${aid}`,
      `Cảnh báo sàn ${r.severity} #${aid}: ${ALERT_LABELS[r.kind] ?? 'cảnh báo sàn khác'} — kênh ` +
        `${code(r.channel)}, file xuất ${code(r.export_kind)}, mở lúc ${fmtVn(r.opened_at)}` +
        ' (giờ VN). Việc cần làm: Quản lý MXH/sàn kiểm tra listing trên Seller Center, xử lý theo' +
        ' SOP mục 4d; cảnh báo đóng khi file xuất kế tiếp không còn lỗi. Agent không tự sửa sàn.',
    );
  }
  const gd = await db.query(
    "select id, kind, created_at from golden_discrepancies where status = 'pending' and kind = any($1) order by id",
    [cfg.sources.price_discrepancy_kinds],
  );
  for (const r of gd.rows) {
    const gid = String(r.id);
    add(
      'price_review',
      `gd:${gid}`,
      `phiếu #${gid}`,
      `Phiếu lệch golden #${gid}: ${PRICE_LABELS[r.kind] ?? 'lệch dữ liệu giá'} — tạo lúc ` +
        `${fmtVn(r.created_at)} (giờ VN). Việc cần làm: GĐ bán hàng đối chiếu giá theo từng nguồn` +
        ' trong phiếu và quyết giá đúng; agent không chọn giá.',
    );
  }
  for (const it of await leadItems(db, now, cfg, stats)) {
    add(it.object_type, it.object_id, it.title, it.payload);
  }
  const cap = cfg.sources.max_cskh_per_run;
  let nCskh = 0;
  let deferred = 0;
  const cskh = await cskhState(db);
  for (const u of unanswered(now, cfg, dataDir)) {
    let oid = u.object_id;
    let recs = u.recs;
    if (oid.startsWith('cskh:')) {
      // Còn mục pending → tin mới (sticker dồn) đã nằm trong mục đó. Đã quyết hết → chỉ câu SAU lần
      // quyết muộn nhất mở ĐỢT mới.
      const [pend, last] = cskh.get(oid) ?? [false, null];
      if (pend) continue;
      recs = recs.filter((r) => last === null || r[0] > last);
      if (!recs.length) continue;
      if (last !== null) oid = `${oid}:${utcSecKey((recs[0] as [Date, string])[0])}`;
    }
    if (seen.has(k('cskh_handoff', oid))) continue;
    if (nCskh >= cap) {
      deferred++;
      continue;
    }
    nCskh++;
    const rf = ref(oid);
    const [t0, ch0] = recs[0] as [Date, string];
    add(
      'cskh_handoff',
      oid,
      `mã ${rf}`,
      `Khách hỏi qua kênh ${ch0} từ ${fmtVn(t0)} (giờ VN), ${recs.length} câu chatbot chưa trả lời` +
        ` (không có dữ liệu hoặc chuyển người). Mã tham chiếu ${rf}. Việc cần làm: nhân viên CSKH mở` +
        " tab 'Chưa trả lời' đọc câu hỏi gốc (đã che SĐT/email) và liên hệ lại khách qua kênh gốc.",
    );
  }
  return [items, deferred];
}

const INTENT_LABELS: Record<string, string> = {
  partner: 'hợp tác/đại lý',
  order: 'đặt hàng',
  price: 'hỏi giá',
  contact: 'liên hệ',
};

function staff(c: unknown): string {
  return typeof c === 'string' && STAFF_RE.test(c) ? c : '(mã lạ)';
}

/** v14.4 sales-04.1 (CHỈ ĐỌC) → mục `lead_followup` chưa có trong hàng duyệt (mọi status), tối đa
 * `max_per_run`. Thiếu `lead_owner` (cfg dựng tay) → []. `stats.deferred` = số mục ĐÃ ĐẾN HẠN vượt
 * trần lần này (chờ lần sau). */
export async function leadItems(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  stats?: Stats,
): Promise<Item[]> {
  checkNow(now);
  if (stats) stats.deferred = 0;
  const lo = cfg.lead_owner;
  if (!lo) return [];
  const since = new Date(now.getTime() - lo.lookback_days * 86_400_000);
  const seen = new Set<string>(
    (
      await db.query("select object_id from approval_queue where object_type = 'lead_followup'")
    ).rows.map((r) => r.object_id as string),
  );
  const out: Item[] = [];
  const { rows } = await db.query(
    'select id, ts, channel, intent, owner_code, owner_due_at, owner_assigned_at,' +
      ` to_char(owner_assigned_at at time zone 'UTC', ${US_KEY}) as assigned_key from leads` +
      " where status = 'new' and (ts >= $1 or owner_assigned_at >= $1) order by ts, id",
    [since],
  );
  for (const r of rows) {
    const lid = String(r.id);
    let due: Date = r.owner_due_at;
    let oid: string;
    let what: string;
    let todo: string;
    if (r.owner_code === null || r.owner_assigned_at === null || r.owner_due_at === null) {
      due = businessDeadline(r.ts, lo.assign_within_business_hours, cfg.business_hours);
      oid = `lead:${lid}:chua_gan`;
      what = 'CHƯA có người phụ trách';
      todo = `GĐ bán hàng gán người phụ trách (\`python -m ingest.crm --owner ${lid} --staff <mã NV> --by <tên>\`)`;
    } else {
      oid = `lead:${lid}:${r.assigned_key}`;
      what = `người phụ trách mã ${staff(r.owner_code)} chưa xử lý (lead vẫn ở trạng thái mới)`;
      todo =
        'GĐ bán hàng nhắc người phụ trách hoặc gán người khác; người phụ trách cập nhật trạng thái' +
        ' lead sau khi liên hệ';
    }
    if (now < due || seen.has(oid)) continue;
    seen.add(oid);
    if (out.length >= lo.max_per_run) {
      if (stats) stats.deferred = (stats.deferred ?? 0) + 1; // chờ lần sau (đếm, không đẩy)
      continue;
    }
    out.push({
      object_type: 'lead_followup',
      object_id: oid,
      title: `lead #${lid}`,
      payload:
        `Lead #${lid} (kênh ${code(r.channel)}, ý định ${INTENT_LABELS[r.intent] ?? 'khác'}) — ` +
        `${what}; hạn ${fmtVn(due)} (giờ VN, giờ làm việc GIẢ ĐỊNH). Việc cần làm: ${todo}. Hệ` +
        ' thống không tự liên hệ khách.',
    });
  }
  return out;
}

/** Đẩy qua `director.submit` (SLA/risk từ cấu hình) → số mục mới. */
export async function enqueueNew(db: Db, items: Item[], cfg: SalesConfig): Promise<number> {
  let n = 0;
  for (const it of items) {
    try {
      await submit(db, {
        block: BLOCK,
        objectType: it.object_type,
        objectId: it.object_id,
        title: it.title,
        payload: it.payload,
        createdBy: AGENT,
        cfg,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue; // mục pending cùng object vừa được đẩy song song
      throw e;
    }
    n++;
  }
  return n;
}

/** id lead `new` quá `lead_stale_business_hours` giờ làm việc → nhắc. */
export async function staleLeads(db: Db, now: Date, cfg: SalesConfig): Promise<number[]> {
  checkNow(now);
  const hours = cfg.sources.lead_stale_business_hours;
  const { rows } = await db.query("select id, ts from leads where status = 'new' order by id");
  // So với HẠN (quét tiến từ ts, có trần) — lead `ts` rất cũ không kéo vòng quét theo tuổi lead.
  // Hạn luôn ≤ ts + MAX_SCAN_DAYS → ts cũ hơn trần quét chắc chắn quá hạn (không gọi lịch: core
  // period chưa nhận năm < 100 — lead nhập tay năm 0001 như test Python).
  const old = now.getTime() - (MAX_SCAN_DAYS + 1) * 86_400_000;
  return rows
    .filter((r) => r.ts.getTime() < old || now >= businessDeadline(r.ts, hours, cfg.business_hours))
    .map((r) => Number(r.id));
}

// ---------------------------------------------------------------- SLA sweep

export type QItem = {
  id: number;
  object_type: string;
  created_at: Date;
  due_at: Date;
  status?: string;
};
type Over = [QItem, SlaState & { reason: string }];

export async function pendingItems(db: Db): Promise<QItem[]> {
  return (await db.query(PENDING_SQL, [BLOCK])).rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function escalated(db: Db, ids: number[]): Promise<Map<number, Date>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    'select queue_id, created_at from sla_escalations where queue_id = any($1)',
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.queue_id), r.created_at as Date]));
}

/** Mục khối KD CHƯA leo thang cần leo thang: `expired` = đã quá `due_at` (pending sắp bị expire,
 * hoặc đã expired trong 7 ngày — bởi bất kỳ ai), `sla` = pending quá SLA giờ làm việc. */
async function overdue(db: Db, now: Date, cfg: SalesConfig): Promise<Over[]> {
  const since = new Date(now.getTime() - EXPIRED_LOOKBACK_MS);
  const out: Over[] = [];
  for (const r of (await db.query(CAND_SQL, [BLOCK, since])).rows) {
    const p: QItem = { ...r, id: Number(r.id) };
    // Pending quá due_at ngoài cửa sổ: sweep expire trước rồi SQL loại — plan phải loại y hệt.
    if (!Object.hasOwn(cfg.object_types, p.object_type) || p.due_at < since) continue;
    const st = slaState(p, cfg, now);
    let reason: string;
    if (p.status === 'expired' || p.due_at <= now) reason = 'expired';
    else if (st.state === 'overdue') reason = 'sla';
    else continue;
    out.push([p, { ...st, reason }]);
  }
  return out;
}

/** Lô leo thang (1 lô = 1 commit, ≤ 1 cảnh báo đỏ): lớp B và S1 → mỗi mục 1 lô; lớp A khác (đầu
 * vào khách) → 1 lô/loại — spam N tin ≠ N cảnh báo. */
export function batches(over: Over[]): Over[][] {
  const out: Over[][] = [];
  const agg = new Map<string, Over[]>();
  for (const x of over) {
    const [p, st] = x;
    if (st.red_alert && !RED_PER_ITEM.has(p.object_type)) {
      const a = agg.get(p.object_type) ?? [];
      a.push(x);
      agg.set(p.object_type, a);
    } else out.push([x]);
  }
  return [...out, ...agg.values()];
}

/** isoformat của Python cho thời điểm giờ VN (micro giây chỉ khi ≠ 0). */
function isoVn(d: Date): string {
  const ms = d.getTime() % 1000;
  return `${vnFormat(d, '%Y-%m-%dT%H:%M:%S')}${ms ? `.${String(ms).padStart(3, '0')}000` : ''}+07:00`;
}

/** [title, detail] cảnh báo đỏ cho các mục vừa leo thang của 1 lô. */
export function alertOf(fresh: Over[], cfg: SalesConfig): [string, Record<string, unknown>] {
  const [p, st] = fresh[0] as Over;
  const cls = st.handoff_class;
  if (fresh.length === 1) {
    const what = st.reason === 'expired' ? 'Hết hạn tuyệt đối chưa ai xử lý' : 'Quá SLA';
    return [
      `${what} loại ${cls} — mục #${p.id}`,
      {
        queue_id: p.id,
        object_type: p.object_type,
        reason: st.reason,
        business_due_at: isoVn(st.business_due_at),
      },
    ];
  }
  const ids = fresh.map(([q]) => q.id);
  const reasons: Record<string, number> = {};
  for (const [, s] of fresh) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  const label = (cfg.object_types[p.object_type] as TypeSpec).label;
  return [
    `Quá SLA loại ${cls} — ${ids.length} mục ${label}`,
    {
      object_type: p.object_type,
      n: ids.length,
      queue_ids: ids.slice(0, MAX_ALERT_IDS),
      reasons: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => cpCmp(a, b))),
    },
  ];
}

export type SweepResult = {
  expired: number;
  escalated: number;
  red_alerts: number;
  errors: number;
};
export type SweepDeps = { raiseAlert?: typeof raiseAlert };

/** expire tuyệt đối → leo thang mục chưa leo thang theo lô (idempotent). */
export async function sweep(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  deps: SweepDeps = {},
): Promise<SweepResult> {
  checkNow(now);
  const raise = deps.raiseAlert ?? raiseAlert;
  const res: SweepResult = {
    expired: await aq.expireOverdue(db, SWEEP_BY),
    escalated: 0,
    red_alerts: 0,
    errors: 0,
  };
  for (const batch of batches(await overdue(db, now, cfg))) {
    const c = db instanceof pg.Pool ? await db.connect() : db;
    try {
      await c.query('begin');
      const fresh: Over[] = [];
      for (const x of batch) {
        const [p, st] = x;
        const r = await c.query(ESC_SQL, [
          p.id,
          BLOCK,
          st.handoff_class,
          st.assignee_role,
          st.escalate_to_role,
          st.business_due_at,
          st.red_alert,
          AGENT,
        ]);
        if (r.rows.length) fresh.push(x);
      }
      if (fresh.length && (batch[0] as Over)[1].red_alert) {
        // raise_alert commit CẢ dòng leo thang lẫn cảnh báo đỏ (như Python commit conn chia sẻ): nó
        // `begin` trên giao dịch đang mở (Postgres chỉ cảnh báo) rồi `commit` cả cụm; lỗi giữa
        // chừng → nó rollback cả cụm.
        await raise(c, JOB, ...alertOf(fresh, cfg));
        res.red_alerts++;
      }
      await c.query('commit'); // đã commit trong raise_alert → chỉ cảnh báo "không có giao dịch"
      res.escalated += fresh.length;
    } catch (e) {
      // 1 lô lỗi không chặn lô khác
      await c.query('rollback').catch(() => {});
      res.errors += batch.length;
      console.error(
        `[warn] leo thang ${batch.length} mục (từ #${(batch[0] as Over)[0].id}) lỗi` +
          ` (${(e as Error)?.name ?? 'Error'}) — rollback, lần quét sau thử lại`,
      );
    } finally {
      if (c !== db) (c as pg.PoolClient).release();
    }
  }
  return res;
}

export type PlanResult = {
  dry_run: true;
  enqueue: Record<string, number>;
  cskh_deferred: number;
  lead_deferred: number;
  expire: number;
  escalate: number;
  red_alerts: number;
  stale_leads: number;
};
export type RunResult = SweepResult & {
  dry_run: false;
  enqueued: number;
  cskh_deferred: number;
  lead_deferred: number;
  stale_leads: number;
};

/** Dry-run: CHỈ ĐỌC — số mục sẽ đẩy/expire/leo thang (cùng ứng viên + cùng gom lô với `sweep`). */
export async function plan(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  dataDir: string = DATA_DIR,
): Promise<PlanResult> {
  const st: Stats = {};
  const [items, deferred] = await collectAll(db, now, cfg, dataDir, st);
  const nExp = (
    await db.query(
      "select count(*)::int as n from approval_queue where status = 'pending' and due_at <= $1",
      [now],
    )
  ).rows[0].n as number;
  const over = await overdue(db, now, cfg);
  const enq: Record<string, number> = {};
  for (const i of items) enq[i.object_type] = (enq[i.object_type] ?? 0) + 1;
  return {
    dry_run: true,
    enqueue: Object.fromEntries(Object.entries(enq).sort(([a], [b]) => cpCmp(a, b))),
    cskh_deferred: deferred,
    lead_deferred: st.deferred ?? 0,
    expire: nExp,
    escalate: over.length,
    red_alerts: batches(over).filter((b) => (b[0] as Over)[1].red_alert).length,
    stale_leads: (await staleLeads(db, now, cfg)).length,
  };
}

/** collect → enqueue → sweep (dryRun: chỉ `plan`). */
export async function run(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  dataDir: string = DATA_DIR,
  dryRun = false,
  deps: SweepDeps = {},
): Promise<PlanResult | RunResult> {
  if (dryRun) return plan(db, now, cfg, dataDir);
  const st: Stats = {};
  const [items, deferred] = await collectAll(db, now, cfg, dataDir, st);
  const n = await enqueueNew(db, items, cfg);
  const res = await sweep(db, now, cfg, deps);
  return {
    ...res,
    dry_run: false,
    enqueued: n,
    cskh_deferred: deferred,
    lead_deferred: st.deferred ?? 0,
    stale_leads: (await staleLeads(db, now, cfg)).length,
  };
}
