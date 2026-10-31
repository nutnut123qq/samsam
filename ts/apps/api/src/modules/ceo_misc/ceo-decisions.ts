import type { Db } from '@samsam/core/ops/deps';
import { addDays } from '@samsam/core/ops/period';
import { oneline, samePerson } from '@samsam/core/ops/store';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import pg from 'pg';
import { byError, pageSafe, safe } from '../ra_kenh/ra-kenh.js';
import { cpCmp, dayDiff, dd, isoDate, savepoint, tupleCmp, vnDay } from './common.js';

// v8.1 W81.2 (WP10) — port `agents/ceo_decisions.py`: Agent Tiến độ & Sổ quyết định của TGĐ
// (ceo-02.2; mục chờ ký C05 cho ceo-02.1).
//  - Sổ `decision_log` APPEND-ONLY: 1 dòng `quyet_dinh` = 1 quyết định; theo dõi = dòng `cap_nhat`
//    mới (trạng thái hiện tại = dòng mới nhất theo id của chuỗi). KHÔNG UPDATE.
//  - NGƯỜI ghi (`--record`/`--follow` với `--by` tên người — luật `byError`: rỗng / ký tự điều khiển
//    / 'agent:'/'system:' / > 100 ký tự → exit 2 TRƯỚC khi connect; DB CHECK chặn thêm lớp nữa).
//    Agent CHỈ ĐỀ XUẤT (`--propose`, chỉ đọc).
//  - v14.3 (HĐ 6.7): `--record`/`--follow` KHÔNG qua cổng `rollout` — dòng sổ là quyết định NGƯỜI
//    ghi, không phải đầu ra AI; tắt ceo-02.2 không được chặn TGĐ ghi quyết định.
//  - Căn cứ phải TỒN TẠI: `approval_queue:ID` (phải approved|rejected — người quyết mặc định =
//    `decided_by` của mục, `--decided-by` khác → từ chối), `approvals:ID`, `decisions:ID`, hoặc
//    `van_ban` (`--note` ≥ 10 ký tự + `--decided-by` bắt buộc). 1 căn cứ → 1 mục.
//  - topic/decision/note qua guardrail TRƯỚC khi ghi rồi lưu bản đã che PII.
//  - `--date` không ở tương lai; ghi dùng giờ thật — `--now` CHỈ cho `--propose`/`--list`.
//  - `lateMilestones` CÙNG luật "TRỄ" của `agents.da_pmo.render_board`. Không mạng, không LLM.

export const OPEN = ['mo', 'dang_lam'];
export const FOLLOW = ['dang_lam', 'xong', 'huy'];
export const SYS_BASIS = ['approval_queue', 'approvals', 'decisions'];
export const MAX_TOPIC = 200;
export const MAX_DECISION = 2000;
export const MAX_NOTE = 500;
export const MIN_VAN_BAN_NOTE = 10;
export const SHOW = 5;
// Chủ đề vào trang TGĐ (markdown): cấm link/HTML/ảnh (OWASP A03), cùng luật nhận xét LLM ceo_report.
export const MARKUP_RE = /https?:|www\.|<[a-z/!]|\]\(|javascript:|`/iu;
export const COLS = [
  'id',
  'entry_kind',
  'parent_id',
  'decided_on',
  'topic',
  'decision',
  'decided_by',
  'basis_kind',
  'basis_id',
  'due_date',
  'follow_status',
  'note',
  'recorded_by',
  'recorded_at',
] as const;
// Đợt hợp đồng C05 (PL01 Ban TGĐ "việc nào chờ ký"): 3 nguồn có cấu trúc.
export const WAIT_Q_SQL =
  "select id::text as id, object_type, title, due_at from approval_queue where block = 'ceo' and status = 'pending' order by due_at nulls last, id";
export const WAIT_REV_SQL =
  'select quarter, max(recorded_at) as ts from revenue_quarters group by quarter order by quarter';
const BASIS_SQL: Record<string, string> = {
  approval_queue:
    'select status as s, decided_by as who, decided_at as at from approval_queue where id = $1',
  approvals:
    'select decision as s, approved_by as who, approved_at as at from approvals where id = $1',
  decisions: 'select kind as s, decided_by as who, created_at as at from decisions where id = $1',
};
const PROPOSE_SQL =
  "select q.id::text as id, q.object_type, q.title, q.status, q.decided_by, q.decided_at from approval_queue q where q.block = 'ceo' and q.status in ('approved', 'rejected') and q.decided_at > $1 and q.decided_at <= $2 and not exists (select 1 from decision_log d where d.entry_kind = 'quyet_dinh' and d.basis_kind = 'approval_queue' and d.basis_id = q.id) order by q.decided_at, q.id";
const INSERT_SQL =
  'insert into decision_log (entry_kind, parent_id, decided_on, topic, decision, decided_by, basis_kind, basis_id, due_date, follow_status, note, recorded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text as id';

export type DecRow = {
  id: number;
  entry_kind: string;
  parent_id: number | null;
  decided_on?: string | null;
  topic?: string | null;
  decision?: string | null;
  decided_by?: string | null;
  basis_kind?: string | null;
  basis_id?: string | null;
  due_date?: string | null;
  follow_status: string;
  note?: string | null;
  recorded_by?: string | null;
  recorded_at?: Date | null;
};
export type Chain = DecRow & { status: string | null };
export type Decision = {
  id: number;
  topic?: string | null;
  decided_by?: string | null;
  due_date?: string | null;
  status?: string | null;
  recorded_at?: Date | null;
} & Record<string, unknown>;
export type Milestone = {
  code: string;
  title: string;
  owner_role?: string | null;
  due_date: string;
  status: string;
  sign_required?: boolean | null;
};
/** (id, object_type, title, due_at) — hàng duyệt khối ceo pending. */
export type WaitQ = [string, string, string | null, Date | null];
/** (quarter, ghi số lúc). */
export type WaitRev = [string, Date | null];
export type ReadData = {
  decisions: Decision[];
  milestones: Milestone[];
  waiting_queue?: WaitQ[] | null;
  waiting_rev?: WaitRev[] | null;
};

/** Chuỗi từ DB vào trang/terminal: che PII, bỏ ký tự điều khiển, 1 dòng. */
export const txt = (s: unknown, n: number): string =>
  oneline(safe(maskPii(pyTruthy(s) ? pyStr(s) : '')), n) || '—';

export const pgSafe = (s: unknown, n: number): string => pageSafe(txt(s, n));

// ------------------------------------------------------------------ thuần

/** Chuỗi 1 quyết định → `follow_status` của dòng mới nhất theo id. THUẦN. */
export function currentStatus(
  rows: readonly { id: number; follow_status: string }[],
): string | null {
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.id > a.id ? b : a)).follow_status;
}

/** Mọi dòng `decision_log` → dòng `quyet_dinh` (theo id) kèm `status` hiện tại. THUẦN. */
export function chains(rows: readonly DecRow[]): Chain[] {
  const by = new Map<number, DecRow[]>();
  for (const r of rows) if (r.entry_kind === 'quyet_dinh') by.set(r.id, [r]);
  for (const r of rows) {
    if (r.entry_kind === 'cap_nhat' && r.parent_id !== null && by.has(r.parent_id)) {
      by.get(r.parent_id)?.push(r);
    }
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ch]) => ({ ...(ch[0] as DecRow), status: currentStatus(ch) }));
}

/** Quyết định quá hạn thực hiện: hạn < hôm nay (giờ VN) và trạng thái còn mở/đang làm. THUẦN. */
export function overdue<T extends Decision>(decisions: readonly T[], today: string): T[] {
  return decisions.filter(
    (d) =>
      d.due_date !== null &&
      d.due_date !== undefined &&
      d.due_date < today &&
      OPEN.includes(d.status as string),
  );
}

/** Mốc trễ — CÙNG luật `agents.da_pmo.render_board`: `due_date < today and status <> 'xong'`,
 * thứ tự (hạn, mã). THUẦN. */
export function lateMilestones(rows: readonly Milestone[], today: string): Milestone[] {
  return [...rows]
    .sort((a, b) => tupleCmp([a.due_date, a.code], [b.due_date, b.code]))
    .filter((r) => r.due_date < today && r.status !== 'xong');
}

/** C05 — việc chờ TGĐ QUYẾT (hàng duyệt khối ceo pending) tách với CHỜ KÝ (mốc `sign_required` chưa
 * xong; đối soát quý đã ghi số — sổ không lưu chữ ký nên luôn "chưa có bằng chứng ký"). null = không
 * đọc được (thiếu quyền/bảng) — ghi rõ, không im. */
export function waitLines(data: ReadData, today: string): string[] {
  const L = ['', '### Việc chờ TGĐ quyết định / chờ ký', ''];
  const q = data.waiting_queue;
  L.push('Chờ quyết định (hàng duyệt khối ceo — nguồn `approval_queue`):');
  if (q === null || q === undefined) L.push('- (không đọc được — thiếu quyền/bảng)');
  else {
    for (const [i, ot, title, due] of q.slice(0, SHOW)) {
      const d = vnDay(due);
      const late = d && d < today ? `, QUÁ HẠN ${dayDiff(today, d)} ngày` : '';
      L.push(`- #${i} ${pgSafe(ot, 40)} · ${pgSafe(title, 80)} — hạn ${d ? dd(d) : '—'}${late}`);
    }
    if (q.length > SHOW) L.push(`- …và ${q.length - SHOW} mục khác`);
    if (!q.length) L.push('- (không có)');
  }
  const ms = (data.milestones ?? []).filter((r) => r.sign_required && r.status !== 'xong');
  L.push('Chờ ký (mốc cần văn bản ký, chưa xong kèm bằng chứng — nguồn `project_milestones`):');
  const msl = ms
    .slice(0, SHOW)
    .map(
      (r) =>
        `- ${pgSafe(r.code, 40)} · ${pgSafe(r.title, 80)} — hạn ${dd(r.due_date)}` +
        (r.due_date < today ? ` (TRỄ ${dayDiff(today, r.due_date)} ngày)` : '') +
        `, phụ trách ${pgSafe(r.owner_role, 40)}, ${r.status}`,
    );
  L.push(...(msl.length ? msl : ['- (không có)']));
  const rev = data.waiting_rev;
  L.push(
    'Chờ ký biên bản đối soát quý (số đề xuất đã ghi; sổ KHÔNG lưu chữ ký — nguồn `revenue_quarters`):',
  );
  if (rev === null || rev === undefined) L.push('- (không đọc được — thiếu quyền/bảng)');
  else {
    const rl = rev.map(
      ([qq, ts]) =>
        `- ${pgSafe(qq, 10)} — ghi số ${dd(vnDay(ts))}, chưa có bằng chứng ký (mẫu PL05 chưa có)`,
    );
    L.push(...(rl.length ? rl : ['- (không có)']));
  }
  return L;
}

/** data {decisions: `chains(...)`, milestones} → markdown "## Tiến độ & Sổ quyết định". Mọi số do
 * code đếm. */
export function renderSection(data: ReadData, today: string): string[] {
  const dec = data.decisions ?? [];
  const od = overdue(dec, today);
  const nOpen = dec.filter((d) => OPEN.includes(d.status as string)).length;
  const since = addDays(today, -7);
  const recent = dec.filter((d) => {
    const v = vnDay(d.recorded_at);
    return v !== null && since < v && v <= today;
  }).length;
  const L = [
    '## Tiến độ & Sổ quyết định',
    '',
    `Quyết định đang theo dõi (mở/đang làm): ${nOpen} · quá hạn thực hiện: ${od.length} · ghi trong 7 ngày: ${recent}`,
    '',
    '### Quyết định quá hạn thực hiện',
    '',
  ];
  const pick = [...od].sort((a, b) => b.id - a.id).slice(0, SHOW);
  // Chuỗi DB vào trang qua pageSafe: chữ trần gập-dấu thành từ cấm / cắt 80 ký tự làm hở cụm khuyến
  // cáo → cả trang TGĐ trượt guardrail.
  const pl = pick.map(
    (d) =>
      `- #${d.id} ${pgSafe(d.topic, 80)} — người quyết ${pgSafe(d.decided_by, 60)} — hạn ${dd(d.due_date)} (trễ ${dayDiff(today, d.due_date as string)} ngày, ${d.status})`,
  );
  L.push(...(pl.length ? pl : ['- (không có)']));
  if (od.length > SHOW) L.push(`- …và ${od.length - SHOW} quyết định khác`);
  const late = lateMilestones(data.milestones ?? [], today);
  L.push('', '### Mốc trễ (sổ mốc tiến độ)', '');
  const ll = late
    .slice(0, SHOW)
    .map(
      (r) =>
        `- **TRỄ** ${pgSafe(r.code, 40)} — hạn ${dd(r.due_date)} (trễ ${dayDiff(today, r.due_date)} ngày, owner ${pgSafe(r.owner_role, 40)}, ${r.status})`,
    );
  L.push(...(ll.length ? ll : ['- (không có)']));
  if (late.length > SHOW) L.push(`- …và ${late.length - SHOW} mốc khác`);
  if ('waiting_queue' in data) L.push(...waitLines(data, today)); // `read` luôn đặt (C05)
  L.push(
    '',
    '*Sổ quyết định do NGƯỜI ghi (`python -m agents.ceo_decisions --record --by`); agent chỉ đề xuất. Mốc trễ từ `project_milestones` (cùng luật bảng tiến độ DA-01).*',
  );
  return L;
}

// ------------------------------------------------------------------ DB đọc

/** Đọc trong savepoint; thiếu quyền/bảng → null (ghi rõ trên trang). */
export async function tryRead<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await savepoint(db, fn);
  } catch (e) {
    if (isDbError(e)) return null;
    throw e;
  }
}

/** CHỈ SELECT → {decisions: chains, milestones, waiting_queue, waiting_rev}. */
export async function read(db: Db): Promise<ReadData> {
  const { rows } = await db.query(
    'select id::text as id, entry_kind, parent_id::text as parent_id, decided_on::text as decided_on, topic, decision, decided_by, basis_kind, basis_id::text as basis_id, due_date::text as due_date, follow_status, note, recorded_by, recorded_at from decision_log order by id',
  );
  const dec = rows.map((r) => ({
    ...r,
    id: Number(r.id),
    parent_id: r.parent_id === null ? null : Number(r.parent_id),
  })) as DecRow[];
  const ms = (
    await db.query<Milestone>(
      'select code, title, owner_role, due_date::text as due_date, status, sign_required from project_milestones order by due_date, code',
    )
  ).rows;
  return {
    decisions: chains(dec),
    milestones: ms,
    waiting_queue: await tryRead(db, async () =>
      (
        await db.query<{
          id: string;
          object_type: string;
          title: string | null;
          due_at: Date | null;
        }>(WAIT_Q_SQL)
      ).rows.map((r): WaitQ => [r.id, r.object_type, r.title, r.due_at]),
    ),
    waiting_rev: await tryRead(db, async () =>
      (await db.query<{ quarter: string; ts: Date | null }>(WAIT_REV_SQL)).rows.map(
        (r): WaitRev => [r.quarter, r.ts],
      ),
    ),
  };
}

/** Section trang TGĐ + bản tin khối ceo (`ceo_report` nối qua `setCeoSections`). */
export async function section(db: Db, today: string): Promise<string[]> {
  return renderSection(await read(db), today);
}

export type Proposal = {
  id: string;
  object_type: string;
  title: string | null;
  status: string;
  decided_by: string | null;
  decided_at: Date;
};

/** CHỈ SELECT: mục khối ceo đã approved/rejected trong `days` ngày tới `now` mà chưa có trong sổ. */
export async function propose(db: Db, now: Date, days: number): Promise<Proposal[]> {
  const from = new Date(now.getTime() - days * 86_400_000);
  return (await db.query<Proposal>(PROPOSE_SQL, [from, now])).rows;
}

// ------------------------------------------------------------------ DB ghi

/** Bị từ chối nghiệp vụ (exit 1) — không ghi dòng nào. */
export class Rejected extends Error {
  override name = 'Rejected';
}

function guard(...parts: (string | null | undefined)[]): void {
  for (const p of parts) {
    if (!p) continue;
    const g = guardrailCheck(p);
    if (g.ok !== true) {
      const kinds = [
        ...new Set(
          (g.violations ?? [])
            .filter((v) => v && typeof v === 'object')
            .map((v) => pyStr((v as { code?: unknown }).code || (v as { type?: unknown }).type)),
        ),
      ].sort(cpCmp);
      throw new Rejected(
        `trượt guardrail (${(kinds.length ? kinds : ['?']).join(', ')}) — sửa lời văn rồi ghi lại (trang TGĐ chép nội dung này)`,
      );
    }
  }
}

/** Python `with conn.transaction(): …; conn.commit()` — Pool: giao dịch riêng; client: savepoint. */
const tx = <T>(db: Db, fn: (c: Db) => Promise<T>): Promise<T> =>
  db instanceof pg.Pool ? withTx(db, fn) : savepoint(db, () => fn(db));

export type RecordArgs = {
  topic: string | null | undefined;
  decision: string | null | undefined;
  by: string;
  basisKind: string;
  basisId?: string | null;
  decidedBy?: string | null;
  note?: string | null;
  decidedOn?: string | null;
  due?: string | null;
  today: string;
};

/** Ghi 1 mục `quyet_dinh` → id. Từ chối nghiệp vụ → `Rejected` (0 dòng); lỗi DB nổi lên. */
export async function record(db: Db, a: RecordArgs): Promise<string> {
  for (const who of [a.by, a.decidedBy]) {
    if (who !== null && who !== undefined) {
      const err = byError(who);
      if (err) throw new Rejected(err);
    }
  }
  const topic = pyStrip(a.topic ?? '');
  const decision = pyStrip(a.decision ?? '');
  const note = pyStrip(a.note ?? '') || null;
  const decidedBy = a.decidedBy ?? null;
  const basisId = a.basisId ?? null;
  if (!(cpLen(topic) >= 1 && cpLen(topic) <= MAX_TOPIC)) {
    throw new Rejected(`--topic cần 1..${MAX_TOPIC} ký tự`);
  }
  if (!(cpLen(decision) >= 1 && cpLen(decision) <= MAX_DECISION)) {
    throw new Rejected(`--decision cần 1..${MAX_DECISION} ký tự`);
  }
  if (note !== null && cpLen(note) > MAX_NOTE)
    throw new Rejected(`--note dài quá ${MAX_NOTE} ký tự`);
  if (MARKUP_RE.test(topic)) {
    throw new Rejected('--topic không được chứa link/HTML/markdown (trang TGĐ chép chủ đề)');
  }
  if (decidedBy !== null && MARKUP_RE.test(decidedBy)) {
    throw new Rejected(
      '--decided-by không được chứa link/HTML/markdown (trang TGĐ chép người quyết)',
    );
  }
  guard(topic, decision, note);
  let who: string | null;
  let when: Date | null = null;
  if (a.basisKind === 'van_ban') {
    if (basisId !== null) throw new Rejected('căn cứ van_ban không kèm id');
    if (cpLen(note ?? '') < MIN_VAN_BAN_NOTE) {
      throw new Rejected(`căn cứ van_ban cần --note mô tả văn bản ≥ ${MIN_VAN_BAN_NOTE} ký tự`);
    }
    if (decidedBy === null) throw new Rejected('căn cứ van_ban cần --decided-by (người quyết)');
    who = decidedBy;
  } else if (SYS_BASIS.includes(a.basisKind)) {
    const row = (
      await db.query<{ s: string; who: string | null; at: Date | null }>(
        BASIS_SQL[a.basisKind] as string,
        [basisId],
      )
    ).rows[0];
    if (row === undefined) throw new Rejected(`không có ${a.basisKind} #${basisId}`);
    if (a.basisKind === 'approval_queue' && !['approved', 'rejected'].includes(row.s)) {
      throw new Rejected(
        `mục approval_queue #${basisId} đang '${row.s}' — chỉ ghi mục đã quyết (approved/rejected)`,
      );
    }
    who = row.who;
    when = row.at;
    if (decidedBy !== null && !samePerson(decidedBy, who)) {
      throw new Rejected(
        `--decided-by khác người đã quyết trên ${a.basisKind} #${basisId} (${txt(who, 60)})`,
      );
    }
    if (byError(who)) {
      throw new Rejected(
        `${a.basisKind} #${basisId} không có người quyết hợp lệ (agent/system) — không phải quyết định của người`,
      );
    }
    const dup = (
      await db.query<{ id: string }>(
        "select id::text as id from decision_log where entry_kind = 'quyet_dinh' and basis_kind = $1 and basis_id = $2",
        [a.basisKind, basisId],
      )
    ).rows[0];
    if (dup) throw new Rejected(`căn cứ ${a.basisKind}:${basisId} đã ghi (#${dup.id})`);
  } else {
    throw new Rejected('căn cứ phải approval_queue:ID|approvals:ID|decisions:ID|van_ban');
  }
  const on = a.decidedOn || vnDay(when) || a.today;
  if (on > a.today) throw new Rejected(`ngày quyết ${dd(on)} ở tương lai`);
  if (a.due && a.due < on) throw new Rejected(`hạn ${dd(a.due)} trước ngày quyết ${dd(on)}`);
  try {
    return await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(INSERT_SQL, [
        'quyet_dinh',
        null,
        on,
        maskPii(topic),
        maskPii(decision),
        pyStrip(who as string),
        a.basisKind,
        basisId,
        a.due ?? null,
        'mo',
        note ? maskPii(note) : null,
        pyStrip(a.by),
      ]);
      return (rows[0] as { id: string }).id;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new Rejected(`căn cứ ${a.basisKind}:${basisId} đã ghi (ghi song song)`);
    }
    throw e;
  }
}

/** Thêm dòng `cap_nhat` cho mục `quyet_dinh` CHƯA đóng → id dòng mới. */
export async function follow(
  db: Db,
  decisionId: string,
  status: string,
  by: string,
  noteIn: string | null = null,
): Promise<string> {
  const err = byError(by);
  if (err) throw new Rejected(err);
  if (!FOLLOW.includes(status))
    throw new Rejected(`--status phải thuộc ('dang_lam', 'xong', 'huy')`);
  const note = pyStrip(noteIn ?? '') || null;
  if (status === 'xong' && !note) throw new Rejected('xong cần --note (bằng chứng hoàn thành)');
  if (note !== null && cpLen(note) > MAX_NOTE)
    throw new Rejected(`--note dài quá ${MAX_NOTE} ký tự`);
  guard(note);
  return tx(db, async (c) => {
    const root = (
      await c.query<{ entry_kind: string }>(
        'select entry_kind from decision_log where id = $1 for update',
        [decisionId],
      )
    ).rows[0];
    if (root === undefined || root.entry_kind !== 'quyet_dinh') {
      throw new Rejected(`không có quyết định #${decisionId}`);
    }
    const chain = (
      await c.query<{ id: string; follow_status: string }>(
        'select id::text as id, follow_status from decision_log where id = $1 or parent_id = $1',
        [decisionId],
      )
    ).rows.map((r) => ({ id: Number(r.id), follow_status: r.follow_status }));
    const cur = currentStatus(chain);
    if (!OPEN.includes(cur as string)) {
      throw new Rejected(`quyết định #${decisionId} đã đóng (${cur}) — không cập nhật nữa`);
    }
    const { rows } = await c.query<{ id: string }>(INSERT_SQL, [
      'cap_nhat',
      decisionId,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      status,
      note ? maskPii(note) : null,
      pyStrip(by),
    ]);
    return (rows[0] as { id: string }).id;
  });
}

// ------------------------------------------------------------------ CLI helper

/** `--basis` → [loại, id | null]. Sai → RangeError (thông điệp Python). id = chuỗi số chuẩn hóa. */
export function basisArg(s: string | null | undefined): [string, string | null] {
  const t = pyStrip(s ?? '');
  if (t === 'van_ban') return [t, null];
  const i = t.indexOf(':');
  const kind = i < 0 ? t : t.slice(0, i);
  const rest = i < 0 ? '' : t.slice(i + 1);
  if (
    SYS_BASIS.includes(kind) &&
    i >= 0 &&
    /^[0-9]+$/.test(rest) &&
    rest.length <= 18 &&
    BigInt(rest) > 0n
  ) {
    return [kind, BigInt(rest).toString()];
  }
  throw new RangeError('--basis phải approval_queue:ID|approvals:ID|decisions:ID|van_ban');
}

export const dateArg = (s: string, what: string): string => isoDate(s, what);

/** In sổ + mốc trễ + việc chờ quyết/chờ ký (`--list`). */
export function printList(data: ReadData, today: string, log: (s: string) => void): void {
  const dec = data.decisions as Chain[];
  const od = new Set(overdue(dec, today).map((d) => d.id));
  log(`[sổ quyết định] ${dec.length} mục — ngày ${dd(today)} (giờ VN)`);
  for (const d of dec) {
    const basis = `${d.basis_kind}${d.basis_id ? `:${d.basis_id}` : ''}`;
    log(
      `- #${d.id} [${d.status}${od.has(d.id) ? ' QUÁ HẠN' : ''}] ${dd(d.decided_on)} ${txt(d.topic, 80)} — quyết: ${txt(d.decision, 120)} — người quyết ${txt(d.decided_by, 60)} — căn cứ ${basis} — hạn ${dd(d.due_date)}`,
    );
  }
  const late = lateMilestones(data.milestones, today);
  log(`[mốc trễ] ${late.length}`);
  for (const r of late) {
    log(
      `- TRỄ ${txt(r.code, 40)} — hạn ${dd(r.due_date)} (trễ ${dayDiff(today, r.due_date)} ngày, owner ${txt(r.owner_role, 40)}, ${r.status})`,
    );
  }
  // r12 G1-L5: việc chờ quyết/chờ ký (PL01 "việc nào chờ ký").
  for (const ln of waitLines(data, today)) if (ln) log(ln);
}
