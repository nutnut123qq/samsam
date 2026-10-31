import { createHash } from 'node:crypto';
import type { Env } from '@samsam/core/env';
import { type Db, dep } from '@samsam/core/ops/deps';
import { vnFormat } from '@samsam/core/ops/period';
import { squash } from '@samsam/core/ops/py';
import { cpCmp, isDict, isPyInt, parsePyJson } from '@samsam/core/ops/py-json';
import { raiseAlert, type Sender } from '@samsam/core/ops/red-alert';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { pgErrName, rowsOf, sp } from '@samsam/core/rollout/counters';
import { maskPii } from '@samsam/core/security/pii';
import { closed, lastClosedRef } from '../ceo_report/cockpit.js';
import { parseMonth } from '../fin_ar_pnl/fin-common.js';
import { safe } from '../ra_kenh/ra-kenh.js';

// Port `agents/bks_audit.py` (v10.0 W100.2–W100.4, WP16 — ceo-04.6) — Audit inside-out của Ban kiểm
// soát (BKS): dữ liệu kiểm soát BÊN TRONG hệ thống có còn nguyên vẹn và nhất quán không?
//  - `checkChains`: `verify_action_log()` + `verify_plot_logs()` (mỗi cái trong savepoint; lỗi DB →
//    `khong_kiem_duoc`, KHÔNG coi là nguyên vẹn); problem → `chuoi_bi_sua`. NEO ĐUÔI `heads` {bảng:
//    {max_id, row_hash, n}} ghi vào `audit_runs.params.heads` khi `--record`; lần sau so dòng neo cũ
//    còn đúng `row_hash` + số dòng không giảm — lệch → `mat_duoi_chuoi`. Lần đầu → ghi chú.
//    GIỚI HẠN: superuser xóa cả `audit_runs` thì neo nội bộ mất (neo ngoài = external-dep).
//  - `checkApprovals`: TÍNH LẠI, không tin cột status — draft lệch bản duyệt, mục hàng duyệt lệch
//    sha/không có dòng `approvals` của CHÍNH mục, `approvals` không có log của function duyệt
//    (`duyet_ngoai_function`), người duyệt = người tạo (`tu_duyet`), QA FAIL approved không override.
//  - `checkOverrides`: MỌI override_qa trong kỳ + bất thường (tự trình/tự ép tự duyệt/dồn dập/căn cứ sai).
//  - `checkPrivileges`: catalog `has_*_privilege` — role theo dõi có quyền vượt → `quyen_vuot`.
// CHỈ ĐỌC mọi bảng nghiệp vụ; đường ghi DUY NHẤT `insert into audit_runs` (`--record`) + cảnh báo đỏ
// của `--chain-alert`. Báo cáo chỉ `#id`/bảng/khối — không text/payload; tên người + lý do override
// qua che PII + 1 dòng + bỏ ký tự markdown. Không LLM, không mạng.

export const RUN_BY = 'agent:bks_audit';
export const KIND = 'inside_out';
// (bảng, function kiểm, điều kiện dòng đã chain)
export const CHAINS: readonly (readonly [string, string, string])[] = [
  ['agent_action_log', 'verify_action_log', ''],
  ['plot_logs', 'verify_plot_logs', ' where row_hash is not null'],
];
// Action log do function SECURITY DEFINER ghi cùng `insert into approvals` (docs/schema.sql).
export const APPROVAL_ACTIONS = [
  'draft_approve',
  'draft_reject',
  'queue_approve',
  'queue_reject',
  'queue_auto_approve',
  'alloc_approve',
  'alloc_reject',
  'lot_intake',
  'qr_lot_sign',
  'cogs_approve',
];
export const APPEND_ONLY = [
  'approvals',
  'agent_action_log',
  'decisions',
  'decision_log',
  'audit_runs',
  'plot_logs',
  'settlement_rows',
  'order_history',
  // v14.3: sổ đầu ra báo cáo + gợi ý chat sàn / lần dùng.
  'report_outputs',
  'san_suggestions',
  'san_suggestion_uses',
  // v15.2 (P8.7): sổ người duyệt từng đầu ra.
  'output_reviews',
  // v15 fix P8.7c: bằng chứng đầu ra nguồn file (chỉ function).
  'file_output_evidence',
  // Đợt hợp đồng C03: phiếu kiểm nghiệm lô (chỉ function người).
  'lot_test_certificates',
  // Đợt hợp đồng C10: kế hoạch sản xuất + gắn lô.
  'production_plans',
  'production_plan_lots',
  // Đợt hợp đồng C07: sổ cấp tư liệu vườn cho Marketing.
  'garden_media_releases',
];
// Sổ chỉ ghi qua function SECURITY DEFINER — INSERT trực tiếp = vượt.
export const FUNC_ONLY_INSERT = ['approvals', 'file_output_evidence'];
// v14.2: + Bên A (chỉ đọc số tổng hợp) + 4 login dịch vụ (docs/roles.sql).
export const WATCH_ROLES = [
  'agent_writer',
  'app_human',
  'bks_reader',
  'ben_a_reader',
  'svc_webhook',
  'svc_job',
  'svc_loader',
  'svc_backup',
];
// Role CHỈ ĐỌC: bất kỳ quyền ghi nào = vượt.
export const READ_ONLY_ROLES = ['ben_a_reader', 'svc_backup'];
// Bên A chỉ đọc đúng các bảng/view số tổng hợp (v12.5 B5).
export const BEN_A_READS = ['revenue_quarters', 'v_ben_a_settlement_daily', 'v_ben_a_orders_daily'];
// Bảng PII (ciphertext + đồng ý) — chỉ owner/CLI người + backup đọc.
export const PII_TABLES = ['contacts', 'consents'];
// Function SECURITY DEFINER bks_reader ĐƯỢC chạy (chỉ đọc); mọi SECDEF khác chạy được → quyen_vuot.
export const READ_FUNCS = ['verify_action_log', 'verify_plot_logs', 'verify_publish'];
// v15 fix P8.7c: function ghi DUY NHẤT role chỉ đọc được chạy — dịch vụ backup ghi bằng chứng đầu ra.
export const ROLE_FUNCS: Record<string, readonly string[]> = {
  svc_backup: ['file_output_evidence_backup'],
};
export const CODES = [
  'chuoi_bi_sua',
  'mat_duoi_chuoi',
  'khong_kiem_duoc',
  'noi_dung_lech_ban_duyet',
  'duyet_ngoai_function',
  'tu_duyet',
  'qa_fail_khong_override',
  'override_tu_trinh',
  'tu_ep_tu_duyet',
  'override_don_dap',
  'can_cu_sai',
  'quyen_vuot',
];
export const FIRST_RUN = 'chưa có neo trước — lần audit đầu (đuôi chuỗi chưa đối chiếu)';
export const LIMIT_NOTE =
  'Neo đuôi chuỗi chỉ là neo NỘI BỘ (`audit_runs.params.heads`): superuser xóa cả sổ `audit_runs` thì neo mất — neo object-lock ngoài + bộ kiểm chứng độc lập trong tài khoản cloud do HĐTV đứng tên là external-dep.';
const HEX64 = /^[0-9a-f]{64}$/;
const NORM = (c: string): string => `lower(btrim(regexp_replace(${c}, '\\s+', ' ', 'g')))`;

export type Head = { max_id: number | null; row_hash: string | null; n: number };
export type Heads = Record<string, Head>;
/** Một phát hiện (khóa như dict Python — chỉ khóa có mặt). */
export type Finding = {
  code: string;
  table?: string | null;
  id?: number | null;
  problem?: string;
  detail?: string;
  object_type?: string | null;
  block?: string | null;
  queue_id?: number | null;
  ids?: number[];
  n?: number;
  role?: string;
  priv?: string;
};
export type Override = {
  id: number;
  queue_id: number;
  block: string | null;
  object_type: string | null;
  created_at: Date | null;
  by: string | null;
  reason: string | null;
  q_created_by: string | null;
  q_decided_by: string | null;
  q_status: string | null;
};

/** Python `" ".join(str(s or "").split()).lower()`. */
export const norm = (s: unknown): string =>
  squash(s === null || s === undefined || s === '' ? '' : String(s)).toLowerCase();

/** Python `type(e).__name__` của lỗi bắt được (lỗi DB → tên lớp psycopg). */
export function pyErrType(e: unknown): string {
  if (isDbError(e)) return pgErrName(e);
  const n = (e as Error)?.name ?? 'Exception';
  return n === 'RangeError' ? 'ValueError' : n === 'Error' ? 'Exception' : n;
}

/** Python `_why`: "<Tên lỗi>: <thông điệp>" đã che PII, 1 dòng ≤ 120 ký tự (không DSN/detail). */
export function why(e: unknown): string {
  const msg = isDbError(e) ? dbMsg(e) : String((e as Error)?.message ?? e);
  return oneline(maskPii(safe(`${pyErrType(e)}: ${msg}`)), 120);
}

/** Đọc trong savepoint — lỗi (thiếu quyền/bảng) không làm hỏng tx của caller. */
export const rows = (db: Db, sql: string, params: readonly unknown[] = []): Promise<unknown[][]> =>
  sp(db, () => rowsOf(db, sql, params));

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ------------------------------------------------------------- W100.2 chuỗi

/** params.heads đã lưu (đã parse giữ int/float như Python) → {bảng: head} hợp lệ (bỏ mục hỏng);
 * không phải dict → null. */
export function validHeads(raw: unknown): Heads | null {
  if (!isDict(raw)) return null;
  const out: Heads = {};
  for (const [table] of CHAINS) {
    const h = raw[table];
    if (!isDict(h)) continue;
    const mx = h.max_id ?? null;
    const rh = h.row_hash ?? null;
    const n = h.n;
    if (
      isPyInt(n) &&
      n >= 0 &&
      (mx === null || isPyInt(mx)) &&
      (rh === null || (typeof rh === 'string' && HEX64.test(rh)))
    ) {
      out[table] = { max_id: mx as number | null, row_hash: rh as string | null, n };
    }
  }
  return out;
}

/** Neo của lần audit inside-out MỚI NHẤT; chưa có → null. Đọc jsonb dạng chữ để giữ int ≠ float
 * như `json.loads` của psycopg (max_id 1.0 = hỏng). */
export async function latestHeads(db: Db): Promise<Heads | null> {
  const r = await rows(
    db,
    "select (params -> 'heads')::text from audit_runs where kind = %s order by id desc limit 1",
    [KIND],
  );
  if (!r.length) return null;
  const t = r[0][0];
  return validHeads(typeof t === 'string' ? parsePyJson(t) : null);
}

/** → [heads, findings]. Mỗi bảng: verify + đọc head trong savepoint riêng; lỗi → `khong_kiem_duoc`
 * (không bao giờ "nguyên vẹn" khi không kiểm được). */
export async function checkChains(db: Db, prevHeads: Heads | null): Promise<[Heads, Finding[]]> {
  const heads: Heads = {};
  const findings: Finding[] = [];
  for (const [table, fn, where] of CHAINS) {
    try {
      const probs = await rows(db, `select id, problem from ${fn}() order by id`);
      for (const [i, p] of probs) {
        findings.push({ code: 'chuoi_bi_sua', table, id: num(i), problem: String(p) });
      }
    } catch (e) {
      if (!isDbError(e)) throw e;
      findings.push({ code: 'khong_kiem_duoc', table, detail: `${fn}(): ${why(e)}` });
    }
    let cur: unknown[][];
    let n: number;
    const prev0 = prevHeads?.[table];
    try {
      const [cnt, mx] = (await rows(db, `select count(*), max(id) from ${table}${where}`))[0];
      let rh: string | null = null;
      if (mx !== null && mx !== undefined) {
        const r = await rows(db, `select row_hash from ${table} where id = %s`, [mx]);
        rh = strOrNull(r[0]?.[0]);
      }
      n = num(cnt);
      heads[table] = { max_id: numOrNull(mx), row_hash: rh, n };
      if (prev0 === undefined || prev0.max_id === null) continue;
      cur = await rows(db, `select row_hash from ${table} where id = %s`, [prev0.max_id]);
    } catch (e) {
      if (!isDbError(e)) throw e;
      findings.push({ code: 'khong_kiem_duoc', table, detail: `đầu chuỗi: ${why(e)}` });
      continue;
    }
    const prev = prev0 as Head;
    const problems: string[] = [];
    if (!cur.length) problems.push('dong_neo_mat');
    else if (cur[0][0] !== prev.row_hash) problems.push('row_hash_khac');
    if (n < prev.n) problems.push('so_dong_giam');
    if (problems.length) {
      findings.push({
        code: 'mat_duoi_chuoi',
        table,
        id: prev.max_id,
        problem: problems.join(','),
      });
    }
  }
  return [heads, findings];
}

// ---------------------------------------------------------- W100.3 duyệt

export const SQL_A =
  "select id from content_drafts where status = 'approved' and not coalesce(verify_publish('content_draft', id::text, text), false) order by id";
export const SQL_B =
  "select q.id, q.object_type, q.block from approval_queue q where q.status = 'approved' and (encode(sha256(convert_to(q.payload, 'UTF8')), 'hex') is distinct from q.content_sha256 or not exists (select 1 from approvals a where a.object_type = q.object_type and a.object_id = q.object_id and a.decision = 'approved' and a.content_sha256 = q.content_sha256 and a.approved_at <= q.decided_at)) order by q.id";
export const SQL_C =
  "select a.id, a.object_type from approvals a where not exists (select 1 from agent_action_log l where l.action = any(%s) and l.detail ->> 'approval_id' = a.id::text and l.object_id = a.object_id and l.actor = a.approved_by and l.db_role = a.db_role and l.ts = a.approved_at) order by a.id";
export const SQL_D =
  "select 'content_drafts', d.id, null::text from approvals a join content_drafts d on a.object_type = 'content_draft' and a.object_id = d.id::text where a.decision = 'approved' and " +
  `${NORM('a.approved_by')} = ${NORM('d.created_by')}` +
  " union all select 'approval_queue', q.id, q.block from approval_queue q where q.status = 'approved' and " +
  `${NORM('q.decided_by')} = ${NORM('q.created_by')}` +
  " union all select 'cogs_versions', c.id, null from cogs_versions c where c.approved_by is not null and " +
  `${NORM('c.approved_by')} = ${NORM('c.created_by')} order by 1, 2`;
export const SQL_E =
  "select q.id, q.object_type, q.block from approval_queue q where q.status = 'approved' and q.qa_status = 'fail' and not exists (select 1 from decisions d where d.queue_id = q.id and d.kind = 'override_qa') order by q.id";

/** 5 phép kiểm, mỗi phép trong savepoint (lỗi → `khong_kiem_duoc`). */
export async function checkApprovals(db: Db): Promise<Finding[]> {
  const out: Finding[] = [];
  const checks: [string, string, unknown[], (r: unknown[]) => Finding][] = [
    [
      'content_drafts',
      SQL_A,
      [],
      (r) => ({ code: 'noi_dung_lech_ban_duyet', table: 'content_drafts', id: num(r[0]) }),
    ],
    [
      'approval_queue',
      SQL_B,
      [],
      (r) => ({
        code: 'noi_dung_lech_ban_duyet',
        table: 'approval_queue',
        id: num(r[0]),
        object_type: strOrNull(r[1]),
        block: strOrNull(r[2]),
      }),
    ],
    [
      'approvals',
      SQL_C,
      [APPROVAL_ACTIONS],
      (r) => ({
        code: 'duyet_ngoai_function',
        table: 'approvals',
        id: num(r[0]),
        object_type: strOrNull(r[1]),
      }),
    ],
    [
      'tu_duyet',
      SQL_D,
      [],
      (r) => ({ code: 'tu_duyet', table: String(r[0]), id: num(r[1]), block: strOrNull(r[2]) }),
    ],
    [
      'approval_queue',
      SQL_E,
      [],
      (r) => ({
        code: 'qa_fail_khong_override',
        table: 'approval_queue',
        id: num(r[0]),
        object_type: strOrNull(r[1]),
        block: strOrNull(r[2]),
      }),
    ],
  ];
  for (const [what, sql, params, mk] of checks) {
    try {
      out.push(...(await rows(db, sql, params)).map(mk));
    } catch (e) {
      if (!isDbError(e)) throw e;
      out.push({ code: 'khong_kiem_duoc', table: what, detail: why(e) });
    }
  }
  return out;
}

// ------------------------------------------------ W100.4 override + quyền

export const OVR_SQL =
  "select d.id, d.queue_id, q.block, q.object_type, d.created_at, d.decided_by, d.reason, q.created_by, q.decided_by, q.status from decisions d join approval_queue q on q.id = d.queue_id where d.kind = 'override_qa' and d.created_at >= %s and d.created_at < %s order by d.id";
export const BASIS_SQL =
  "select l.id, l.basis_id from decision_log l left join approval_queue q on q.id = l.basis_id where l.entry_kind = 'quyet_dinh' and l.basis_kind = 'approval_queue' and (q.id is null or q.status not in ('approved', 'rejected')) order by l.id";

/** → {overrides: mọi override_qa trong kỳ [start, end), findings}. */
export async function checkOverrides(
  db: Db,
  start: Date,
  end: Date,
  maxPerPerson = 3,
): Promise<{ overrides: Override[]; findings: Finding[] }> {
  const findings: Finding[] = [];
  let ovr: Override[] | null;
  try {
    ovr = (await rows(db, OVR_SQL, [start, end])).map((r) => ({
      id: num(r[0]),
      queue_id: num(r[1]),
      block: strOrNull(r[2]),
      object_type: strOrNull(r[3]),
      created_at: r[4] instanceof Date ? r[4] : null,
      by: strOrNull(r[5]),
      reason: strOrNull(r[6]),
      q_created_by: strOrNull(r[7]),
      q_decided_by: strOrNull(r[8]),
      q_status: strOrNull(r[9]),
    }));
  } catch (e) {
    if (!isDbError(e)) throw e;
    ovr = null;
    findings.push({ code: 'khong_kiem_duoc', table: 'decisions', detail: why(e) });
  }
  const list = ovr ?? [];
  for (const o of list) {
    if (norm(o.by) === norm(o.q_created_by)) {
      findings.push({
        code: 'override_tu_trinh',
        table: 'decisions',
        id: o.id,
        queue_id: o.queue_id,
        block: o.block,
      });
    }
    if (o.q_status === 'approved' && norm(o.by) === norm(o.q_decided_by)) {
      findings.push({
        code: 'tu_ep_tu_duyet',
        table: 'decisions',
        id: o.id,
        queue_id: o.queue_id,
        block: o.block,
      });
    }
  }
  const per = new Map<string, number>();
  for (const o of list) per.set(norm(o.by), (per.get(norm(o.by)) ?? 0) + 1);
  for (const [who, n] of [...per.entries()].sort((a, b) => cpCmp(a[0], b[0]) || a[1] - b[1])) {
    if (n > maxPerPerson) {
      const ids = list.filter((o) => norm(o.by) === who).map((o) => o.id);
      findings.push({ code: 'override_don_dap', table: 'decisions', id: ids[0], ids, n });
    }
  }
  try {
    for (const [i, b] of await rows(db, BASIS_SQL)) {
      findings.push({
        code: 'can_cu_sai',
        table: 'decision_log',
        id: num(i),
        queue_id: numOrNull(b),
      });
    }
  } catch (e) {
    if (!isDbError(e)) throw e;
    findings.push({ code: 'khong_kiem_duoc', table: 'decision_log', detail: why(e) });
  }
  return { overrides: list, findings };
}

export const PRIV_SQL =
  "select c.relname, p.priv from pg_class c cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv) where c.relnamespace = current_schema()::regnamespace and c.relkind in ('r', 'p') and case when p.priv in ('INSERT', 'UPDATE') then has_any_column_privilege(%s, c.oid, p.priv) else has_table_privilege(%s, c.oid, p.priv) end order by 1, 2";
export const FUNC_SQL =
  "select p.oid::regprocedure::text from pg_proc p where p.pronamespace = current_schema()::regnamespace and p.prosecdef and p.proname <> all(%s) and has_function_privilege(%s, p.oid, 'EXECUTE') order by 1";
export const MEMBER_SQL =
  "select a.rolname, b.rolname from pg_roles a join pg_roles b on a.oid <> b.oid where a.rolname = any(%s) and b.rolname = any(%s) and pg_has_role(a.oid, b.oid, 'USAGE')";
export const SEL_SQL =
  "select c.relname from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relkind in ('r', 'p', 'v', 'm') and (has_table_privilege(%s, c.oid, 'SELECT') or has_any_column_privilege(%s, c.oid, 'SELECT')) order by 1";

export function excess(role: string, table: string, priv: string): boolean {
  if (role === 'bks_reader') {
    // v15.4 (P10.3): + INSERT sổ đầu ra báo cáo BKS (append-only).
    return !(priv === 'INSERT' && (table === 'audit_runs' || table === 'report_outputs'));
  }
  if (READ_ONLY_ROLES.includes(role)) return true;
  if (role === 'svc_loader' && table === 'plot_logs' && priv === 'DELETE') {
    // Nạp lại nhật ký MẪU chưa chain (core_store); trigger `plot_logs_guard` chặn xóa dòng đã chain.
    return false;
  }
  return (
    (APPEND_ONLY.includes(table) && priv !== 'INSERT') ||
    (FUNC_ONLY_INSERT.includes(table) && priv === 'INSERT')
  );
}

/** v14.2: SELECT vượt — Bên A ngoài số tổng hợp; mọi role (trừ backup) đọc bảng PII. */
export function excessRead(role: string, table: string): boolean {
  if (role === 'ben_a_reader') return !BEN_A_READS.includes(table);
  return role !== 'svc_backup' && PII_TABLES.includes(table);
}

const K = (...xs: string[]): string => xs.join('\u0000');

/** Quyền vượt của các role theo dõi (catalog — không cần quyền đặc biệt). Kế thừa → báo ở role gốc. */
export async function checkPrivileges(db: Db): Promise<Finding[]> {
  const raw = new Set<string>();
  let member: [string, string][];
  try {
    const roles = (
      await rows(db, 'select rolname from pg_roles where rolname = any(%s) order by 1', [
        WATCH_ROLES,
      ])
    ).map((r) => String(r[0]));
    member = (await rows(db, MEMBER_SQL, [roles, roles])).map((r) => [String(r[0]), String(r[1])]);
    for (const role of roles) {
      for (const [t, p] of await rows(db, PRIV_SQL, [role, role])) {
        if (excess(role, String(t), String(p))) raw.add(K(role, String(t), String(p)));
      }
      for (const [t] of await rows(db, SEL_SQL, [role, role])) {
        if (excessRead(role, String(t))) raw.add(K(role, String(t), 'SELECT'));
      }
      if (role === 'bks_reader' || READ_ONLY_ROLES.includes(role)) {
        for (const [f] of await rows(db, FUNC_SQL, [
          [...READ_FUNCS, ...(ROLE_FUNCS[role] ?? [])],
          role,
        ])) {
          raw.add(K(role, `function ${String(f)}`, 'EXECUTE'));
        }
      }
    }
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [{ code: 'khong_kiem_duoc', table: 'pg_catalog', detail: why(e) }];
  }
  const out: Finding[] = [];
  const sorted = [...raw]
    .map((k) => k.split('\u0000') as [string, string, string])
    .sort((a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]) || cpCmp(a[2], b[2]));
  for (const [role, t, p] of sorted) {
    if (member.some(([r, m]) => r === role && raw.has(K(m, t, p)))) continue; // kế thừa
    out.push({ code: 'quyen_vuot', role, table: t, priv: p });
  }
  return out;
}

// ------------------------------------------------------------ chạy + báo cáo

export type AuditData = {
  prev_heads: Heads | null;
  heads: Heads;
  findings: Finding[];
  overrides: Override[];
};

export async function run(db: Db, start: Date, end: Date): Promise<AuditData> {
  const prev = await latestHeads(db);
  const [heads, chainF] = await checkChains(db, prev);
  const ovr = await checkOverrides(db, start, end);
  const findings = [
    ...chainF,
    ...(await checkApprovals(db)),
    ...ovr.findings,
    ...(await checkPrivileges(db)),
  ];
  return { prev_heads: prev, heads, findings, overrides: ovr.overrides };
}

export function byCode(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CODES) out[c] = findings.filter((f) => f.code === c).length;
  return out;
}

const vn = (ts: Date | null | undefined): string => (ts ? vnFormat(ts, '%d/%m/%Y') : '—');

const MD: Record<string, string> = {
  '`': "'",
  '|': '/',
  '[': '(',
  ']': ')',
  '<': '‹',
  '>': '›',
  '*': '·',
  _: ' ',
};

/** Chuỗi do NGƯỜI nhập (tên, lý do) vào báo cáo markdown: che PII, 1 dòng, bỏ ký tự markdown/HTML
 * (không tạo link/ảnh/bảng — OWASP A03). */
export function person(s: unknown, n = 60): string {
  return oneline(maskPii(safe(s)), n).replace(/[`|[\]<>*_]/g, (c) => MD[c] as string);
}

/** 1 dòng override_qa: #id, #mục, khối, ngày VN, người + lý do đã che. */
export function overrideLine(o: Override): string {
  return `- #${o.id} · mục #${o.queue_id} · khối ${o.block} · ${vn(o.created_at)} · người quyết: ${person(o.by)} · lý do: ${person(o.reason, 160)}`;
}

/** Python `str(v)` (None → 'None'). */
const pyS = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v));

const truthy = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '' && v !== 0 && v !== false;

export function findingLine(f: Finding): string {
  const parts = [`[${f.code}]`];
  if ('role' in f) parts.push(`role ${f.role} có ${f.priv} trên ${f.table}`);
  else {
    parts.push(Object.hasOwn(f, 'table') ? pyS(f.table) : '?');
    if (f.id !== null && f.id !== undefined) parts.push(`#${f.id}`);
  }
  for (const k of ['object_type', 'block'] as const) {
    if (truthy(f[k])) parts.push(`${k} ${safe(f[k])}`);
  }
  if (f.queue_id !== null && f.queue_id !== undefined) parts.push(`mục #${f.queue_id}`);
  if (truthy(f.problem)) parts.push(`— ${f.problem}`);
  if (f.ids?.length) parts.push(`— ${f.n} lần (#${f.ids.join(', #')})`);
  if (truthy(f.detail)) parts.push(`— ${f.detail}`);
  return `- ${parts.join(' ')}`;
}

export function render(data: AuditData, label: string, now: Date): string {
  const counts = byCode(data.findings);
  const L = [
    `# Audit inside-out BKS — kỳ ${label}`,
    '',
    `Sinh lúc ${vnFormat(now, '%d/%m/%Y %H:%M')} giờ VN bởi \`${RUN_BY}\` (sổ lần chạy MÁY — KHÔNG phải chữ ký Ban kiểm soát). Chỉ đọc: hệ thống không sửa/xóa/duyệt gì.`,
    '',
    '## Tổng theo mã',
    '',
    '| Mã | Số phát hiện |',
    '|---|---|',
  ];
  for (const [c, n] of Object.entries(counts)) L.push(`| ${c} | ${n} |`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  L.push('', `Tổng: ${total} phát hiện.`, '', '## Chuỗi hash + neo đuôi', '');
  for (const [table] of CHAINS) {
    const h = data.heads[table];
    if (h === undefined) {
      L.push(`- ${table}: không đọc được đầu chuỗi`);
      continue;
    }
    if (h.max_id === null) {
      L.push(`- ${table}: 0 dòng đã chain (chuỗi rỗng)`);
      continue;
    }
    L.push(
      `- ${table}: ${h.n} dòng đã chain · đầu #${h.max_id} · băm đầu ${(h.row_hash || '—').slice(0, 12)}`,
    );
  }
  if (data.prev_heads === null) L.push(`- ${FIRST_RUN}`);
  else L.push('- Đối chiếu neo của lần audit inside-out ghi sổ gần nhất (`audit_runs`).');
  L.push('', '## Chi tiết phát hiện', '');
  L.push(...(data.findings.length ? data.findings.map(findingLine) : ['- (không có phát hiện)']));
  L.push('', '## Ép trình QA (override_qa) trong kỳ', '');
  L.push(
    ...(data.overrides.length
      ? data.overrides.map(overrideLine)
      : ['- (không có override_qa trong kỳ)']),
  );
  L.push(
    '',
    '## Giới hạn',
    '',
    `- ${LIMIT_NOTE}`,
    '- Audit tính lại tại lúc chạy từ DB; nội dung bài/payload KHÔNG chép ra báo cáo (chỉ #id, bảng, khối).',
    '',
    '---',
    '*BẢN NHÁP — chờ BKS ký (external-dep); hệ thống không tự gửi.*',
    '',
  );
  return L.join('\n');
}

// Đợt hợp đồng (PL01 Ban TGĐ — Kiểm soát nội bộ "báo khi nhật ký bị sửa"; HĐ Điều 7.2): kiểm chuỗi
// HẰNG NGÀY (job `chain_watch`) → cảnh báo đỏ tới người nhận ĐỘC LẬP. Chỉ đọc + đúng 1 đường ghi
// `raiseAlert`. KHÔNG qua cổng rollout: báo can thiệp nhật ký là kiểm soát an toàn, không phải đầu
// ra AI (tắt ceo-04.6 không được làm im cảnh báo này).
export const CHAIN_AGENT = 'bks_chain_watch';
export const CHAIN_CODES = ['chuoi_bi_sua', 'mat_duoi_chuoi', 'khong_kiem_duoc'];

/** Dấu vân tay sha256 của tập phát hiện — cùng công thức Python (`code|table|id|problem|detail`). */
export function fingerprint(found: readonly Finding[]): string {
  const key = found
    .map((f) => `${f.code}|${pyS(f.table)}|${pyS(f.id)}|${f.problem || f.detail || ''}`)
    .sort(cpCmp);
  return createHash('sha256').update(key.join('\n'), 'utf8').digest('hex');
}

export type ChainResult = {
  findings: Finding[];
  alert_id: number | null;
  dup: boolean;
  routed: boolean | null;
};

/** Cùng tập phát hiện (dấu vân tay) đã báo → không báo lặp mỗi ngày (`dup`).
 * `sender` null/undefined = SMTP theo env (Python `**({"sender": sender} if sender else {})` →
 * `_ENV`), KHÔNG phải "không có kênh". */
export async function chainAlert(
  db: Db,
  routing: unknown = null,
  sender?: Sender | null,
  env: Env = process.env,
): Promise<ChainResult> {
  let prev: Heads | null;
  let pre: Finding[] = [];
  try {
    prev = await latestHeads(db);
  } catch (e) {
    if (!isDbError(e)) throw e;
    prev = null;
    pre = [{ code: 'khong_kiem_duoc', table: 'audit_runs', detail: `neo đuôi: ${why(e)}` }];
  }
  const [, found0] = await checkChains(db, prev);
  const found = [...pre, ...found0];
  const out: ChainResult = { findings: found, alert_id: null, dup: false, routed: null };
  if (!found.length) return out;
  const fp = fingerprint(found);
  if (
    (
      await rows(
        db,
        // raiseAlert che PII cả fp hex (~2% có dãy giống SĐT) → so cả bản đã che (maskPii THẬT).
        "select 1 from red_alerts where source_agent = %s and detail ->> 'fp' in (%s, %s) limit 1",
        [CHAIN_AGENT, fp, maskPii(fp)],
      )
    ).length
  ) {
    out.dup = true;
    return out;
  }
  const by: Record<string, number> = {};
  for (const k of CHAIN_CODES) by[k] = found.filter((f) => f.code === k).length;
  const [routed] = await raiseAlert(
    db,
    CHAIN_AGENT,
    `Nhật ký hệ thống: chuỗi hash bị sửa/mất đuôi/không kiểm được (${found.length} phát hiện)`,
    {
      fp,
      by_code: by,
      tables: [...new Set(found.map((f) => pyS(f.table)))].sort(cpCmp),
      ids: found
        .filter((f) => truthy(f.id))
        .map((f) => f.id as number)
        .slice(0, 20),
    },
    routing,
    sender ?? undefined,
    env,
  );
  out.routed = routed;
  out.alert_id = numOrNull(
    (await rows(db, 'select max(id) from red_alerts where source_agent = %s', [CHAIN_AGENT]))[0][0],
  );
  return out;
}

// v14.3: loại lần chạy → tính năng danh mục (cổng giai đoạn HĐ 6.7).
export const KIND_FEATURE: Record<string, string> = {
  inside_out: 'ceo-04.6',
  recon: 'ceo-04.6',
  hdtv_pack: 'ceo-05',
};

/** JSON cho jsonb — bigint giữ nguyên chữ số (JSON.stringify không nhận bigint). */
export function jsonText(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `\u0000big:${x}` : x)).replace(
    /"\\u0000big:(-?\d+)"/g,
    '$1',
  );
}

/**
 * Ghi 1 dòng `audit_runs` (sha256 = bản báo cáo) + commit tường minh (client có thể đang mở tx).
 * v14.3: tính năng của `kind` TẮT → RolloutBlocked, không ghi; `sample` = báo cáo dựng trên số MẪU →
 * cờ provenance `is_sample` (không đếm đầu ra). → id dòng (chuỗi số).
 */
export async function recordRun(
  db: Db,
  kind: string,
  label: string,
  params: unknown,
  findings: number,
  text: string,
  runBy: string,
  sample = false,
): Promise<string> {
  await dep('rollout').checkGenerate(
    db,
    KIND_FEATURE[kind] ?? null,
    `sổ lần chạy kiểm soát (${kind})`,
  );
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  const { rows: r } = await db.query<{ id: string }>(
    'insert into audit_runs (kind, period_label, params, findings, report_sha256, run_by, is_sample) values ($1, $2, $3::jsonb, $4, $5, $6, $7) returning id',
    [kind, label, jsonText(params), findings, sha, runBy, Boolean(sample)],
  );
  await db.query('commit');
  return String(r[0].id);
}

/** --month (hoặc tháng vừa đóng) → [nhãn, start, end]; sai/chưa đóng → RangeError (ValueError).
 * TS chặt hơn: năm 0000 → "--month phải dạng YYYY-MM" (Python: "year 0 is out of range"). */
export function monthBounds(monthArg: string | null | undefined, now: Date): [string, Date, Date] {
  let m: string;
  if (monthArg === null || monthArg === undefined) {
    m = `${lastClosedRef('month', now).slice(0, 7)}-01`;
  } else {
    const p = parseMonth(monthArg);
    if (p === null) throw new RangeError('--month phải dạng YYYY-MM');
    m = p;
  }
  const [start, end] = closed('month', m, now);
  return [m.slice(0, 7), start, end];
}
