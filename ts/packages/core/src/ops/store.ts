import { createHash } from 'node:crypto';
import pg from 'pg';
import { privilegedLogin } from '../db.js';
import { approvalEnforced, type Env, pyStrip } from '../env.js';
import { dataPath } from '../paths.js';
import { type Db, dep, type GuardrailResult, type PublishCtx } from './deps.js';
import { addDays, parseDay, vnDate, vnFormat } from './period.js';
import { isPlainObject, pyInt, readJson, squash } from './py.js';
import { dbMsg, isDbError, withTx } from './tx.js';

// Port `pipelines/store.py` (WS2) — hàng duyệt + lịch đăng nội dung (`content_drafts`).
// - Function DB là NGUỒN SỰ THẬT cho mọi chuyển trạng thái (`approve_draft` / `reject_draft` /
//   `schedule_draft`, SECURITY DEFINER) — module KHÔNG UPDATE bảng draft.
// - approve CHỈ khi guardrail ok: chạy LẠI guardrail CHẾ ĐỘ ĐĂNG BÀI (luật + lớp LLM nếu cấu hình)
//   trên text TỪ DB với ngữ cảnh đọc TỪ DÒNG DB; `is_ai` lúc duyệt luôn true (fail-closed).
// - `saveDraft` bắt buộc `created_by` + 1 dòng `agent_action_log` (`draft_create`) cùng giao dịch;
//   snapshot lưu không bao giờ lỏng hơn luật hay snapshot caller.
// - Cổng triển khai (HĐ 6.7): tính năng TẮT → không sinh/không duyệt; `schedule` (biên DÙNG) chặn
//   khi chạy thử/tắt, `co_nguoi_duyet` chỉ draft NGƯỜI duyệt. `verifyPublish` không gắn cổng.
// - Ủy quyền (F08): approve/reject/schedule qua `auth.authorize`; chế độ thực thêm login riêng.
// - Lịch đăng là KẾ HOẠCH cho người đăng tay — hệ thống KHÔNG tự đăng (human-gate C2.4).

export const CHANNELS = ['facebook', 'tiktok', 'blog', 'zalo'];
export const STATUSES = ['pending', 'approved', 'rejected'];
export const SOURCE_STUDIO = 'manual:studio';
export const SOURCE_CLI = 'cli';
export const DEFAULT_LIMIT = 50;
export const DEFAULT_DAYS = 14;
export const OBJECT_TYPE = 'content_draft';

export const COLS = [
  'id',
  'created_at',
  'brief',
  'channel',
  'text',
  'guardrail',
  'status',
  'reviewer',
  'reviewed_at',
  'review_note',
  'scheduled_date',
  'source',
  'created_by',
  'content_type',
  'sku',
  'is_ai',
  'prompt_version',
  'prompt_sha256',
] as const;
export type Draft = {
  id: string;
  created_at: Date | null;
  brief: string | null;
  channel: string | null;
  text: string | null;
  guardrail: unknown;
  status: string;
  reviewer: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  scheduled_date: string | null; // 'YYYY-MM-DD' (cast ::text — pg đọc `date` thành Date giờ máy)
  source: string | null;
  created_by: string | null;
  content_type: string | null;
  sku: string | null;
  is_ai: boolean | null;
  prompt_version: string | null;
  prompt_sha256: string | null;
};

const SELECT_SQL = `select ${COLS.map((c) => (c === 'scheduled_date' ? 'scheduled_date::text as scheduled_date' : c)).join(', ')} from content_drafts`;
const INSERT_SQL =
  'insert into content_drafts (brief, channel, text, guardrail, source, created_by, content_type, sku, is_ai, prompt_version, prompt_sha256, block) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id';
const LOG_SQL =
  'insert into agent_action_log (actor, action, object_type, object_id, detail) values ($1, $2, $3, $4, $5)';
const READINESS_SQL = 'select sku_key, channel, readiness from sku_readiness';

/** sha256 hex byte-exact UTF-8, không normalize — khớp PG `encode(sha256(convert_to(t,'UTF8')),'hex')`. */
export function contentSha256(text: string | null | undefined): string {
  return createHash('sha256')
    .update(Buffer.from(text ?? '', 'utf8'))
    .digest('hex');
}

/** Python `str(v)` cho giá trị JSON đơn giản trong thông điệp. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** Python `_oneline`: gộp khoảng trắng, cắt `n` ký tự kèm '…'. */
export function oneline(s: unknown, n = 60): string {
  const t = Array.from(squash(s === null || s === undefined ? '' : String(s)));
  return t.length <= n ? t.join('') : `${t.slice(0, n - 1).join('')}…`;
}

export function readinessKey(sku: string, channel: string): string {
  return `${sku}\u0000${channel}`;
}

/** Map readiness từ view `sku_readiness`; db null / lỗi → null (= soi gương golden, fail-closed). */
export async function readinessFromDb(db: Db | null): Promise<Map<string, string> | null> {
  if (db === null) return null;
  try {
    const { rows } = await db.query(READINESS_SQL);
    return new Map(
      rows.map((r) => [readinessKey(String(r.sku_key), String(r.channel)), String(r.readiness)]),
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    return null;
  }
}

function contentTypePublic(ct: unknown): boolean {
  // Python đọc qua `guardrail._load_rules`; file hỏng → bỏ qua (check_publish tự báo "config").
  try {
    const doc = readJson(dataPath('guardrail_rules.json'));
    const types = isPlainObject(doc) && isPlainObject(doc.content_types) ? doc.content_types : null;
    const c = types && typeof ct === 'string' ? types[ct] : null;
    return !(isPlainObject(c) && c.public === false);
  } catch {
    return true;
  }
}

/** Guardrail đăng bài theo ngữ cảnh draft. `llm=false` → chỉ luật (bước lưu). */
export async function publishCheck(
  db: Db | null,
  text: string,
  channel: string,
  opts: { llm: boolean; contentType?: string; sku?: string | null; isAi?: boolean },
): Promise<GuardrailResult> {
  const ctx: PublishCtx = {
    channel,
    content_type: opts.contentType ?? 'post',
    sku: opts.sku ?? null,
    is_ai: opts.isAi ?? true,
  };
  const rules = dep('checkPublish')(text, ctx);
  const skus = rules.skus;
  const rmap =
    (Array.isArray(skus) && skus.length > 0) || ctx.sku !== null ? await readinessFromDb(db) : null;
  let res: GuardrailResult;
  if (!opts.llm) {
    res = rmap === null ? rules : dep('checkPublish')(text, { ...ctx, readiness: rmap });
  } else {
    res = await dep('checkPublishLlm')(text, { ...ctx, readiness: rmap });
  }
  // Loại `public: false` (internal_note) bỏ qua luật đăng bài — không vào hàng duyệt ĐĂNG.
  if (!contentTypePublic(ctx.content_type)) {
    res = dep('withViolation')(
      res,
      'config',
      `loại nội dung '${ctx.content_type}' không công khai — không vào hàng duyệt đăng bài`,
    );
  }
  return res;
}

/**
 * Snapshot lưu = kết quả luật + violation `llm_*` của caller + `llm_check`/`llm_model`. ok = luật.ok
 * VÀ caller.ok === true — không bao giờ lỏng hơn bên nào; ok false mà không còn violation → chép
 * violation caller "(snapshot lúc sinh)" hoặc thêm `config` (UI không bao giờ "KHÔNG RÕ").
 */
export function mergeSnapshot(rules: GuardrailResult, caller: unknown): GuardrailResult {
  const wv = dep('withViolation');
  let out: GuardrailResult = { ...rules };
  const c = isPlainObject(caller) ? caller : {};
  const viols = Array.isArray(c.violations) ? c.violations : [];
  for (const v of viols) {
    const code = isPlainObject(v) ? v.code : null;
    if (typeof code === 'string' && code.startsWith('llm_')) {
      const vv = v as Record<string, unknown>;
      out = wv(out, code, vv.detail, vv.span, vv.start, vv.end);
    }
  }
  for (const k of ['llm_check', 'llm_model']) {
    if (typeof c[k] === 'string')
      out[k] = Array.from(c[k] as string)
        .slice(0, 100)
        .join('');
  }
  out.ok = out.ok === true && c.ok === true;
  const has = () => Array.isArray(out.violations) && out.violations.length > 0;
  if (out.ok === false && !has()) {
    for (const v of viols) {
      if (isPlainObject(v) && typeof v.code === 'string') {
        out = wv(
          out,
          Array.from(v.code).slice(0, 64).join(''),
          `(snapshot lúc sinh) ${v.detail || ''}`,
          v.span,
          v.start,
          v.end,
        );
      }
    }
    if (!has()) {
      out = wv(
        out,
        'config',
        'snapshot lúc sinh ok != true, không có chi tiết vi phạm — sinh/kiểm lại bài trước khi lưu',
      );
    }
  }
  return out;
}

function draftFeature(createdBy: unknown, contentType: unknown): string | null {
  return dep('rollout').featureFor({
    table: 'content_drafts',
    created_by: pyStrip(typeof createdBy === 'string' ? createdBy : ''),
    content_type: contentType,
  });
}

/** Khối sở hữu draft = phòng ban của tính năng; không thuộc danh mục → 'marketing'. */
export function draftBlock(cur: {
  created_by?: string | null;
  content_type?: string | null;
}): string {
  const fid = draftFeature(cur.created_by, cur.content_type || 'post');
  for (const f of dep('rollout').catalog() ?? []) {
    if (f.id === fid && f.phong_ban) return f.phong_ban;
  }
  return 'marketing';
}

type Via = { via?: string; role?: string | null; env?: Env };

async function authz(
  db: Db,
  cur: Draft,
  by: string,
  action: string,
  { via = 'cli', role = null, env = process.env }: Via,
): Promise<string | null> {
  const auth = dep('auth');
  const block = draftBlock(cur);
  const enforced = approvalEnforced(env);
  let { ok, why } = await auth.authorize(by, block, action, {
    createdBy: cur.created_by,
    role,
    via,
    dbLogin: enforced && via !== 'ui' ? await auth.sessionLogin(db) : null,
    env,
  });
  if (ok && enforced && via !== 'ui') {
    // v14.2: CLI chế độ thực không chạy bằng login superuser/owner.
    why = await privilegedLogin(db);
    ok = why === null;
  }
  if (ok) return null;
  await auth.denyLog(db, by, block, action, OBJECT_TYPE, String(cur.id), why, env);
  return `draft #${cur.id}: ${why}`;
}

export type SaveDraft = {
  brief: string | null;
  channel: string | null;
  text: string | null;
  guardrail: unknown;
  source?: string;
  createdBy?: string | null;
  contentType?: string;
  sku?: string | null;
  isAi?: boolean;
  promptVersion?: string | null;
  promptSha256?: string | null;
};

/** INSERT 1 draft + log `draft_create` cùng giao dịch → id. `createdBy` rỗng → lỗi trước DB. */
export async function saveDraft(db: Db, d: SaveDraft): Promise<string | null> {
  const by = pyStrip(d.createdBy ?? '');
  if (!by) throw new RangeError('save_draft: thiếu created_by (người/agent tạo)');
  const text = d.text || '';
  const ch = pyStrip(d.channel ?? '');
  const contentType = d.contentType ?? 'post';
  const sku = d.sku ?? null;
  const isAi = d.isAi !== false;
  const source = d.source ?? SOURCE_STUDIO;
  await dep('rollout').checkGenerate(db, draftFeature(by, contentType), `nháp ${contentType}`);
  const snap = mergeSnapshot(
    await publishCheck(db, text, ch, { llm: false, contentType, sku, isAi }),
    d.guardrail,
  );
  return withTx(db, async (c) => {
    const r = await c.query<{ id: string }>(INSERT_SQL, [
      pyStrip(d.brief ?? ''),
      ch,
      text,
      JSON.stringify(snap),
      source,
      by,
      contentType,
      sku,
      isAi,
      d.promptVersion ?? null,
      d.promptSha256 ?? null,
      // đợt an toàn S04: khối sở hữu ghi lúc tạo → DB kiểm khối khi duyệt/từ chối/xếp lịch.
      draftBlock({ created_by: by, content_type: contentType }),
    ]);
    const did = r.rows[0]?.id ?? null;
    if (did !== null) {
      await c.query(LOG_SQL, [
        by,
        'draft_create',
        OBJECT_TYPE,
        String(did),
        JSON.stringify({
          channel: ch,
          source,
          content_type: contentType,
          sku,
          prompt_version: d.promptVersion ?? null,
          content_sha256: contentSha256(text),
        }),
      ]);
    }
    return did;
  });
}

/** Mới nhất trước; status null → tất cả; status lạ → rỗng. */
export async function listDrafts(
  db: Db,
  status: string | null = null,
  limit = DEFAULT_LIMIT,
): Promise<Draft[]> {
  const r =
    status === null
      ? await db.query(`${SELECT_SQL} order by created_at desc, id desc limit $1`, [limit])
      : await db.query(
          `${SELECT_SQL} where status = $1 order by created_at desc, id desc limit $2`,
          [status, limit],
        );
  return r.rows as Draft[];
}

/** → draft | null. Lỗi DB NỔI LÊN (caller phân biệt "không có" với "DB chết"). */
export async function getDraft(db: Db, id: bigint): Promise<Draft | null> {
  const r = await db.query(`${SELECT_SQL} where id = $1`, [String(id)]);
  return (r.rows[0] as Draft | undefined) ?? null;
}

/** Python `store._same_person`: so khớp người `.strip().lower()` (function DB kiểm lại bằng
 * lower(btrim(.))). */
export function samePerson(a: unknown, b: unknown): boolean {
  const n = (x: unknown) => (typeof x === 'string' ? pyStrip(x).toLowerCase() : '');
  return n(a) === n(b);
}

/** pending → approved|rejected → [true, null] | [false, warn]. Không ném với đầu vào xấu. */
export async function setStatus(
  db: Db,
  draftId: unknown,
  status: string,
  reviewer: string | null | undefined,
  note: string | null = null,
  opts: Via = {},
): Promise<[boolean, string | null]> {
  const st = pyStrip(status ?? '');
  if (st !== 'approved' && st !== 'rejected') {
    return [false, `status đích '${st}' không hợp lệ — chỉ approved|rejected (one-way từ pending)`];
  }
  if (!pyStrip(reviewer ?? '')) return [false, 'thiếu tên người duyệt (--by) — bắt buộc cho audit'];
  const did = pyInt(draftId);
  if (did === null) return [false, `id '${pyStr(draftId)}' không hợp lệ`];
  let cur: Draft | null;
  try {
    cur = await getDraft(db, did);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, `lỗi DB khi đọc draft #${did}: ${dbMsg(e)}`];
  }
  if (cur === null) return [false, `không tìm thấy draft #${did}`];
  if (cur.status !== 'pending') {
    return [false, `draft #${did} đã ở trạng thái '${cur.status}' — chỉ duyệt từ pending`];
  }
  const who = reviewer as string;
  let sql: string;
  if (st === 'approved') {
    const why = await dep('rollout').decideReason(
      db,
      draftFeature(cur.created_by, cur.content_type || 'post'),
      `draft #${did}`,
    );
    if (why) return [false, why];
    const g = cur.guardrail;
    if (!(isPlainObject(g) && g.ok === true)) {
      return [
        false,
        `draft #${did} vi phạm guardrail (ok != true) — phải reject hoặc viết lại; không có duyệt-kèm-ghi-nhận`,
      ];
    }
    if (!pyStrip(cur.created_by ?? '')) {
      return [
        false,
        `draft #${did} không có người tạo (draft trước v3.4) — không duyệt được, reject rồi tạo lại`,
      ];
    }
    if (samePerson(cur.created_by, who)) {
      return [false, `bạn là người tạo draft #${did} — cần người khác duyệt`];
    }
    // v13.5: ủy quyền người duyệt khối TRƯỚC lời gọi LLM-check.
    const denied = await authz(db, cur, who, 'approve', opts);
    if (denied) return [false, denied];
    // Snapshot do agent ghi có thể giả ok:true — chạy LẠI guardrail ĐĂNG BÀI trên text thật trong DB.
    const recheck = await publishCheck(db, cur.text || '', cur.channel ?? '', {
      llm: true,
      contentType: cur.content_type || 'post',
      sku: cur.sku,
      isAi: true,
    });
    if (recheck.ok !== true) {
      const vs = (Array.isArray(recheck.violations) ? recheck.violations : []).filter(
        isPlainObject,
      );
      const codes = [...new Set(vs.map((v) => pyStr(v.code || v.type)))].join(', ') || '?';
      return [
        false,
        `draft #${did} vi phạm guardrail khi kiểm lại text (${vs.length} vi phạm: ${codes}) — snapshot lúc lưu không khớp; phải reject hoặc viết lại`,
      ];
    }
    sql = 'select approve_draft($1, $2, $3)';
  } else {
    const denied = await authz(db, cur, who, 'reject', opts);
    if (denied) return [false, denied];
    sql = 'select reject_draft($1, $2, $3)';
  }
  try {
    await db.query(sql, [String(did), pyStrip(who), note || null]);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, `draft #${did}: ${dbMsg(e)}`];
  }
  return [true, null];
}

/** 'YYYY-MM-DD' (bỏ khoảng trắng hai đầu) → ngày | null. */
export function coerceDate(v: unknown): string | null {
  if (v instanceof Date) return vnDate(v);
  if (typeof v !== 'string') return null;
  const s = pyStrip(v);
  return parseDay(s) === null ? null : s;
}

export function vnToday(): string {
  return vnDate(new Date());
}

/** Xếp lịch đăng (chỉ draft approved, ngày ≥ hôm nay giờ VN) → [ok, warn]. */
export async function schedule(
  db: Db,
  draftId: unknown,
  day: unknown,
  by: string | null | undefined,
  today: string | null = null,
  opts: Via = {},
): Promise<[boolean, string | null]> {
  if (!pyStrip(by ?? '')) return [false, 'thiếu tên người xếp lịch (--by) — bắt buộc cho audit'];
  const d = coerceDate(day);
  if (d === null) return [false, `ngày '${pyStr(day)}' không hợp lệ — định dạng YYYY-MM-DD`];
  const t = today ?? vnToday();
  if (d < t) return [false, `ngày ${d} đã qua — chỉ xếp lịch từ hôm nay trở đi`];
  const did = pyInt(draftId);
  if (did === null) return [false, `id '${pyStr(draftId)}' không hợp lệ`];
  let cur: Draft | null;
  try {
    cur = await getDraft(db, did);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, `lỗi DB khi đọc draft #${did}: ${dbMsg(e)}`];
  }
  if (cur === null) return [false, `không tìm thấy draft #${did}`];
  if (cur.status !== 'approved') {
    return [false, `draft #${did} đang '${cur.status}' — chỉ xếp lịch bài đã approved`];
  }
  const denied = await authz(db, cur, by as string, 'schedule', opts);
  if (denied) return [false, denied];
  const ro = dep('rollout');
  const why = await ro.useReason(
    db,
    draftFeature(cur.created_by, cur.content_type || 'post'),
    `xếp lịch đăng draft #${did}`,
    ro.isHuman(cur.reviewer),
  );
  if (why) return [false, why];
  try {
    await db.query('select schedule_draft($1, $2, $3)', [String(did), d, pyStrip(by as string)]);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, `draft #${did}: ${dbMsg(e)}`];
  }
  return [true, null];
}

/** Bản sắp đăng đúng bản đã duyệt? Lỗi DB/id xấu → false (fail-closed). */
export async function verifyPublish(db: Db, draftId: unknown, text: string): Promise<boolean> {
  const did = pyInt(draftId);
  if (did === null) return false;
  try {
    const r = await db.query('select verify_publish($1, $2, $3) as ok', [
      OBJECT_TYPE,
      String(did),
      text,
    ]);
    return r.rows[0]?.ok === true;
  } catch (e) {
    if (!isDbError(e)) throw e;
    return false;
  }
}

/** Kiểm hash chain `agent_action_log` → [số dòng, [[id, problem]]]; rỗng = nguyên vẹn. */
export async function verifyLog(db: Db): Promise<[number, [string, string][]]> {
  const n = Number((await db.query('select count(*)::int as n from agent_action_log')).rows[0].n);
  const { rows } = await db.query('select id, problem from verify_action_log()');
  return [n, rows.map((r) => [String(r.id), String(r.problem)])];
}

/** Lịch đăng `days` ngày tới: approved có ngày trong [today, today+days] + approved chưa có ngày. */
export async function calendar(
  db: Db,
  days = DEFAULT_DAYS,
  today: string | null = null,
): Promise<{ today: string; days: number; scheduled: Draft[]; unscheduled: Draft[] }> {
  // Python dùng ngày UTC (`datetime.now(timezone.utc).date()`) — giữ nguyên.
  const t = today ?? new Date().toISOString().slice(0, 10);
  const horizon = addDays(t, days);
  const scheduled = (
    await db.query(
      `${SELECT_SQL} where status = 'approved' and scheduled_date >= $1::date and scheduled_date <= $2::date order by scheduled_date, id`,
      [t, horizon],
    )
  ).rows as Draft[];
  const unscheduled = (
    await db.query(
      `${SELECT_SQL} where status = 'approved' and scheduled_date is null order by created_at desc, id desc`,
    )
  ).rows as Draft[];
  return { today: t, days, scheduled, unscheduled };
}

function vline(v: Record<string, unknown>): string {
  const sev = v.severity;
  const code = v.code || v.type || '?';
  let line = `${sev ? `[${pyStr(sev)}] ` : ''}${pyStr(code)} — ${v.detail ? pyStr(v.detail) : ''}`;
  if (v.span) {
    line += ` → "${pyStr(v.span)}"`;
    if (Number.isInteger(v.start) && Number.isInteger(v.end)) line += ` (${v.start}–${v.end})`;
  }
  return line;
}

const MD_SPECIAL_RE = /([\\`*_{}[\]()#+\-.!<>|~$:])/g;

/** Escape markdown cho dòng guardrail render trên web (WYSIWYS: không render link/ảnh/màu). */
export function mdPlain(s: unknown): string {
  return pyStr(s).replace(MD_SPECIAL_RE, '\\$1');
}

export type Level = 'success' | 'error' | 'warning' | 'info';

/** Formatter thuần cho UI: [[level, text]]. Không ném. */
export function guardrailLines(g: unknown): [Level, string][] {
  if (!isPlainObject(g)) return [['error', 'Guardrail: KHÔNG RÕ — snapshot không đọc được']];
  const viols = (Array.isArray(g.violations) ? g.violations : []).filter(isPlainObject);
  const out: [Level, string][] = [];
  if (g.ok === true && !viols.length) out.push(['success', 'Guardrail: PASS — không vi phạm']);
  else if (!viols.length)
    out.push(['error', 'Guardrail: KHÔNG RÕ — ok != true, không có chi tiết vi phạm']);
  for (const v of viols) out.push(['error', vline(v)]);
  for (const w of (Array.isArray(g.warnings) ? g.warnings : []).filter(isPlainObject)) {
    out.push(['warning', vline(w)]);
  }
  if (g.llm_check) {
    out.push([
      'info',
      `Lớp LLM-check: ${pyStr(g.llm_check)}${g.llm_model ? ` (${pyStr(g.llm_model)})` : ''}`,
    ]);
  }
  const labels = g.required_labels;
  if (Array.isArray(labels) && labels.length) {
    out.push(['info', `Nhãn bắt buộc: ${labels.map(pyStr).join('; ')}`]);
  }
  const mc = g.matched_claims;
  if (Array.isArray(mc) && mc.length) {
    out.push([
      'info',
      `Claim khớp whitelist: ${mc
        .filter(isPlainObject)
        .map((m) => `${pyStr(m.sku)}: ${pyStr(m.claim)}`)
        .join('; ')}`,
    ]);
  }
  return out;
}

export function fmtGuardrail(d: { guardrail?: unknown }): string {
  const g = d.guardrail;
  if (isPlainObject(g) && g.ok === true) return 'PASS';
  if (!isPlainObject(g) || !('ok' in g)) return 'KHÔNG RÕ';
  const v = g.violations;
  const n = v ? ((v as { length?: number }).length ?? 0) : 0;
  return n ? `VI PHẠM (${n})` : 'VI PHẠM';
}

function draftLine(d: Draft): string {
  const ts = d.created_at instanceof Date ? vnFormat(d.created_at, '%m-%d %H:%M') : '';
  return `  #${d.id} [${d.channel}] ${oneline(d.brief)} — guardrail ${fmtGuardrail(d)} ${ts}`;
}

export type StoreCliOpts = {
  pending?: boolean;
  approve?: string;
  reject?: string;
  schedule?: [string, string];
  calendar?: boolean;
  verifyLog?: boolean;
  by?: string;
  note?: string;
  days?: number;
};

/**
 * `python -m pipelines.store` (tham số đã tách) → exit code. `open` mở kết nối (null = DB down):
 * đọc → "chưa nạp" exit 0; ghi / kiểm log → exit 2.
 */
export async function storeCli(o: StoreCliOpts, open: () => Promise<Db | null>): Promise<number> {
  const nOps =
    [o.approve, o.reject, o.schedule].filter((x) => x !== undefined).length +
    Number(!!o.pending) +
    Number(!!o.calendar) +
    Number(!!o.verifyLog);
  const usage = (m: string) => {
    console.error(`[err] ${m}`);
    return 2;
  };
  if (nOps === 0) {
    return usage(
      'cần 1 thao tác: --pending | --calendar | --approve | --reject | --schedule | --verify-log',
    );
  }
  if (nOps > 1) return usage('chỉ 1 thao tác mỗi lần — tách lệnh');
  const by = pyStrip(o.by ?? '');
  if ((o.approve !== undefined || o.reject !== undefined) && !by) {
    return usage('--approve/--reject cần --by <tên người duyệt>');
  }
  if (o.schedule !== undefined && !by) return usage('--schedule cần --by <tên người xếp lịch>');
  if (by && !approvalEnforced()) console.error(`[warn] ${dep('auth').DEV_WARNING}`);
  const err = 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';
  const db = await open();
  try {
    if (o.pending || o.calendar) {
      if (db === null) {
        console.log(`[warn] chưa nạp — ${err}`);
        return 0;
      }
      if (o.pending) {
        const rows = await listDrafts(db, 'pending');
        if (!rows.length)
          console.log("[pending] hàng chờ trống — sinh draft ở Studio rồi 'Lưu vào hàng duyệt'");
        else {
          console.log(`[pending] ${rows.length} draft chờ duyệt:`);
          for (const d of rows) console.log(draftLine(d));
        }
        return 0;
      }
      const cal = await calendar(db, o.days ?? DEFAULT_DAYS);
      console.log(`[calendar] ${cal.today} → ${addDays(cal.today, cal.days)}:`);
      if (!cal.scheduled.length) console.log('  (trống — chưa có bài nào trong lịch)');
      for (const d of cal.scheduled) {
        console.log(`  ${d.scheduled_date}  #${d.id} [${d.channel}] ${oneline(d.brief)}`);
      }
      if (cal.unscheduled.length) {
        console.log(`[unscheduled] ${cal.unscheduled.length} draft đã duyệt chưa xếp lịch:`);
        for (const d of cal.unscheduled) console.log(draftLine(d));
      }
      return 0;
    }
    if (o.verifyLog) {
      if (db === null) {
        console.error(`[error] ${err} — không kiểm được`);
        return 2;
      }
      let n: number;
      let probs: [string, string][];
      try {
        [n, probs] = await verifyLog(db);
      } catch (e) {
        if (!isDbError(e)) throw e;
        console.error(`[error] lỗi DB khi kiểm log: ${dbMsg(e)}`);
        return 2;
      }
      if (!probs.length) {
        console.log(`[ok] chuỗi nguyên vẹn (${n} dòng)`);
        return 0;
      }
      console.log(`[FAIL] hash chain agent_action_log hỏng — ${probs.length} vấn đề / ${n} dòng:`);
      for (const [lid, prob] of probs) console.log(`  id=${lid} problem=${prob}`);
      return 1;
    }
    if (db === null) {
      console.error(`[error] ${err} — không ghi được`);
      return 2;
    }
    if (o.approve !== undefined || o.reject !== undefined) {
      const did = (o.approve ?? o.reject) as string;
      const st = o.approve !== undefined ? 'approved' : 'rejected';
      const [ok, warn] = await setStatus(db, did, st, o.by, o.note ?? null);
      if (!ok) {
        console.error(`[warn] ${warn}`);
        return 2;
      }
      console.log(`[done] draft #${did} → ${st} (người duyệt: ${by})`);
      return 0;
    }
    const [did, dayS] = o.schedule as [string, string];
    const [ok, warn] = await schedule(db, did, dayS, o.by);
    if (!ok) {
      console.error(`[warn] ${warn}`);
      return 2;
    }
    console.log(
      `[done] draft #${did} xếp lịch ${dayS} (người xếp: ${by}) — người đăng tay (hệ thống không tự đăng)`,
    );
    return 0;
  } finally {
    if (db instanceof pg.Pool) await db.end().catch(() => {});
  }
}
