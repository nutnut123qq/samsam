import pg from 'pg';
import { privilegedLogin } from '../db.js';
import { approvalEnforced, type Env, pyStrip } from '../env.js';
import { type Db, dep } from './deps.js';
import { vnFormat } from './period.js';
import { pyInt, pySplit } from './py.js';
import { oneline, pyStr } from './store.js';
import { dbMsg, isDbError } from './tx.js';

// Port `pipelines/approval_queue.py` (v4.0 W40.3) — hàng duyệt dùng chung (`approval_queue`) cho MỌI
// loại object trừ `content_draft` (đường `store`).
// - DB là nguồn sự thật: mọi chuyển trạng thái qua function SECURITY DEFINER — `enqueue_item`,
//   `decide_item`, `auto_approve_item`, `override_qa`, `expire_overdue`. Module KHÔNG UPDATE bảng.
// - `enqueue` TỰ chạy guardrail(payload) — không nhận guardrail từ caller (agent không giả ok).
// - `decide` approve: đọc payload TỪ DB, chạy LẠI guardrail; không ok → không gọi function.
// - auto_policy chỉ khi có luật đã ký (mặc định không có → fail-closed). Quá SLA → expired.
// - Cổng triển khai (HĐ 6.7): tính năng TẮT → không enqueue/không duyệt; `verify` (cổng DÙNG chung)
//   chặn chạy thử/tắt/không thuộc danh mục, `co_nguoi_duyet` chỉ mục NGƯỜI duyệt từng mục.
// - Ủy quyền (F08): `decide`/`override` qua `auth.authorize`; chế độ thực đọc khối + người tạo TỪ DB,
//   CLI phải chạy bằng login riêng (không superuser/owner). Bị chặn → `authz_denied` vào log.

export const DECISIONS = ['approved', 'rejected'] as const;
export const PREVIEW = 200;

export type QueueItem = {
  id: string;
  object_type: string;
  object_id: string;
  block: string;
  title: string | null;
  preview: string | null;
  risk: string;
  qa_status: string;
  guardrail_ok: boolean;
  created_by: string;
  created_at: Date;
  due_at: Date | null;
  status: string;
};

type Meta = [string, string, string, string | null, string | null, string | null];

function featureOf(block: string, objectType: string, createdBy: string): string | null {
  return dep('rollout').featureFor({
    table: 'approval_queue',
    block,
    object_type: objectType,
    created_by: createdBy,
  });
}

export type EnqueueArgs = {
  objectType: string;
  objectId: string | number | bigint;
  block: string;
  title: string | null;
  payload: string;
  risk: string;
  createdBy: string;
  slaHours: number;
  qaStatus?: string;
  /** Mục dựng trên dữ liệu MẪU → cột provenance `is_sample` (bộ đếm đầu ra loại). */
  sample?: boolean;
};

/** Đẩy 1 mục vào hàng → id. Guardrail do module tự tính. */
export async function enqueue(db: Db, a: EnqueueArgs): Promise<bigint> {
  const by = pyStrip(a.createdBy ?? '');
  if (!by) throw new RangeError('enqueue: thiếu created_by (người/agent tạo)');
  if (!pyStrip(a.payload ?? '')) throw new RangeError('enqueue: payload rỗng');
  // HĐ 6.7: tính năng TẮT không sinh đầu ra (lỗi của rollout nổi lên). Chạy thử vẫn ghi.
  await dep('rollout').checkGenerate(
    db,
    featureOf(a.block, a.objectType, by),
    `hàng duyệt ${a.block}/${a.objectType}`,
  );
  const g = dep('guardrailCheck')(a.payload);
  const args: unknown[] = [
    a.objectType,
    String(a.objectId),
    a.block,
    a.title || '',
    a.payload,
    a.risk,
    JSON.stringify(g),
    a.qaStatus ?? 'none',
    by,
    a.slaHours,
  ];
  let sql = 'select enqueue_item($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) as id';
  if (a.sample) {
    sql = 'select enqueue_item($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) as id';
    args.push(true);
  }
  const { rows } = await db.query<{ id: string }>(sql, args);
  return BigInt(rows[0]!.id);
}

/** Gọi function quyết định → [true, kết quả] | [false, thông điệp lỗi của function]. */
async function call(
  db: Db,
  sql: string,
  params: unknown[],
  label: string,
): Promise<[boolean, string | null]> {
  try {
    const { rows } = await db.query(sql, params);
    const v = rows[0] ? Object.values(rows[0])[0] : null;
    return [true, v === null || v === undefined ? null : String(v)];
  } catch (e) {
    if (!isDbError(e)) throw e;
    return [false, `${label}: ${dbMsg(e)}`];
  }
}

function itemId(v: unknown): bigint | null {
  return pyInt(v);
}

type Who = { via?: string; role?: string | null; env?: Env };

/** Cổng ủy quyền cho mục hàng duyệt → lý do chặn | null. */
async function authz(
  db: Db,
  qid: bigint,
  by: string,
  action: string,
  { via = 'cli', role = null, env = process.env }: Who,
): Promise<string | null> {
  const auth = dep('auth');
  let block: string | null = null;
  let created: string | null = null;
  const enforced = approvalEnforced(env);
  if (enforced) {
    try {
      const { rows } = await db.query(
        'select block, created_by from approval_queue where id = $1',
        [String(qid)],
      );
      if (!rows[0]) return `không tìm thấy mục #${qid} trong hàng duyệt`;
      block = rows[0].block;
      created = rows[0].created_by;
    } catch (e) {
      if (!isDbError(e)) throw e;
      return `mục #${qid}: ${dbMsg(e)}`;
    }
  }
  let { ok, why } = await auth.authorize(by, block, action, {
    createdBy: created,
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
  await auth.denyLog(db, by, block, action, 'approval_queue', String(qid), why, env);
  return `mục #${qid}: ${why}`;
}

const META_SQL =
  'select block, object_type, created_by, status, lane, decided_by from approval_queue where id = $1';

/** Metadata cho cổng giai đoạn — chỉ đọc khi cưỡng chế cần DB; mục không có → bộ rỗng (fail-closed). */
async function meta(db: Db, qid: bigint): Promise<Meta | null> {
  if (dep('rollout').quickMode() === 'van_hanh') return null;
  const { rows } = await db.query(META_SQL, [String(qid)]);
  const r = rows[0];
  return r
    ? [r.block, r.object_type, r.created_by, r.status, r.lane, r.decided_by]
    : ['', '', '', null, null, null];
}

/** Lý do chặn DÙNG mục | null. */
export async function useReason(db: Db, m: Meta): Promise<string | null> {
  const ro = dep('rollout');
  const human = m[3] === 'approved' && m[4] === 'per_item' && ro.isHuman(m[5]);
  return ro.useReason(db, featureOf(m[0], m[1], m[2]), `mục ${m[0]}/${m[1]}`, human);
}

/** Người quyết từng mục (per_item) → [true, null] | [false, lý do]. */
export async function decide(
  db: Db,
  id: unknown,
  decider: string | null | undefined,
  decision: string,
  note: string | null = null,
  who: Who = {},
): Promise<[boolean, string | null]> {
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return [false, `quyết định '${decision}' không hợp lệ — approved|rejected`];
  }
  if (!pyStrip(decider ?? '')) return [false, 'thiếu tên người duyệt (--by)'];
  const qid = itemId(id);
  if (qid === null) return [false, `id '${pyStr(id)}' không hợp lệ`];
  const by = decider as string;
  const denied = await authz(db, qid, by, decision === 'approved' ? 'approve' : 'reject', who);
  if (denied) return [false, denied];
  if (decision === 'approved') {
    let payload: string | null;
    let m: Meta | null;
    try {
      // role không đọc được payload (agent_writer — chỉ cột metadata) → lỗi, không hỏng gì.
      const { rows } = await db.query('select payload from approval_queue where id = $1', [
        String(qid),
      ]);
      if (!rows[0]) return [false, `không tìm thấy mục #${qid} trong hàng duyệt`];
      payload = rows[0].payload;
      m = await meta(db, qid);
    } catch (e) {
      if (!isDbError(e)) throw e;
      return [false, `mục #${qid}: ${dbMsg(e)}`];
    }
    // HĐ 6.7: tính năng TẮT → mục chờ của nó không duyệt được.
    if (m !== null) {
      const why = await dep('rollout').decideReason(db, featureOf(m[0], m[1], m[2]), `mục #${qid}`);
      if (why) return [false, why];
    }
    // Snapshot guardrail lúc enqueue có thể cũ/giả — kiểm lại payload.
    const recheck = dep('guardrailCheck')(payload || '');
    if (!recheck.ok) {
      const n = Array.isArray(recheck.violations) ? recheck.violations.length : 0;
      return [
        false,
        `mục #${qid} vi phạm guardrail khi kiểm lại (${n} vi phạm) — phải reject hoặc viết lại`,
      ];
    }
  }
  const [ok, res] = await call(
    db,
    'select decide_item($1, $2, $3, $4)',
    [String(qid), pyStrip(by), decision, note || null],
    `mục #${qid}`,
  );
  return ok ? [true, null] : [false, res];
}

/** Ép trình bản QA FAIL (ghi decisions override_qa) — KHÔNG duyệt. */
export async function override(
  db: Db,
  id: unknown,
  by: string | null | undefined,
  reason: string | null | undefined,
  who: Who = {},
): Promise<[boolean, string | null]> {
  const qid = itemId(id);
  if (qid === null) return [false, `id '${pyStr(id)}' không hợp lệ`];
  const denied = await authz(db, qid, by ?? '', 'override_qa', who);
  if (denied) return [false, denied];
  // Đếm ký tự không phải khoảng trắng — lý do toàn \n/\t không phải lý do.
  if (Array.from(pySplit(reason ?? '').join('')).length < 10) {
    return [false, `mục #${qid}: lý do override_qa phải ≥ 10 ký tự (không tính khoảng trắng)`];
  }
  const [ok, res] = await call(
    db,
    'select override_qa($1, $2, $3)',
    [String(qid), pyStrip(by ?? ''), reason],
    `mục #${qid}`,
  );
  return ok ? [true, null] : [false, res];
}

/** Lane auto_policy — fail-closed khi không có luật đã ký. */
export async function autoApprove(db: Db, id: unknown): Promise<[boolean, string | null]> {
  const qid = itemId(id);
  if (qid === null) return [false, `id '${pyStr(id)}' không hợp lệ`];
  const [ok, res] = await call(db, 'select auto_approve_item($1)', [String(qid)], `mục #${qid}`);
  return ok ? [true, null] : [false, res];
}

/** Mục pending quá SLA → expired (không bao giờ approved) → số mục. */
export async function expireOverdue(db: Db, by = 'system:sla'): Promise<number> {
  const { rows } = await db.query<{ n: number }>('select expire_overdue($1) as n', [by]);
  return Number(rows[0]!.n);
}

/** Mục đang chờ (cũ nhất trước); payload cắt PREVIEW ký tự, `full` (UI người duyệt) → đủ. */
export async function pending(
  db: Db,
  block: string | null = null,
  { full = false }: { full?: boolean } = {},
): Promise<QueueItem[]> {
  const params: unknown[] = full ? [] : [PREVIEW];
  let sql =
    `select id, object_type, object_id, block, title, ${full ? 'payload' : 'left(payload, $1)'} as preview, risk, qa_status,` +
    " coalesce(guardrail->>'ok', '') = 'true' as guardrail_ok, created_by, created_at, due_at, status" +
    " from approval_queue where status = 'pending'";
  if (block) {
    params.push(block);
    sql += ` and block = $${params.length}`;
  }
  const { rows } = await db.query(`${sql} order by due_at, id`, params);
  return rows as QueueItem[];
}

/**
 * Bản sắp phát hành đúng bản đã duyệt của object mục này? Cổng DÙNG chung (--verify-send/--export/
 * áp dụng): chạy thử/tắt không lọt. Lỗi/không thấy → false (fail-closed).
 */
export async function verify(db: Db, id: unknown, text: string): Promise<boolean> {
  const qid = itemId(id);
  if (qid === null) return false;
  try {
    const { rows } = await db.query(
      'select object_type, object_id from approval_queue where id = $1',
      [String(qid)],
    );
    if (!rows[0]) return false;
    const m = await meta(db, qid);
    const why = m === null ? null : await useReason(db, m);
    if (why) {
      console.error(`[rollout] TỪ CHỐI DÙNG mục #${qid}: ${why}`);
      return false;
    }
    const r = await db.query('select verify_publish($1, $2, $3) as ok', [
      rows[0].object_type,
      rows[0].object_id,
      text,
    ]);
    return r.rows[0]?.ok === true;
  } catch (e) {
    if (!isDbError(e)) throw e;
    return false;
  }
}

export function itemLine(d: QueueItem): string {
  const g = d.guardrail_ok ? 'PASS' : 'VI PHẠM';
  const due = d.due_at ? vnFormat(d.due_at, '%m-%d %H:%M') : '';
  return (
    `  #${d.id} [${d.block}/${d.object_type}] ${oneline(dep('maskPii')(d.title || ''))} — rủi ro ${d.risk}, ` +
    `QA ${d.qa_status}, guardrail ${g}, tạo bởi ${d.created_by}, hạn ${due}`
  );
}

export type ApprovalCliOpts = {
  pending?: boolean;
  block?: string;
  approve?: string;
  reject?: string;
  overrideQa?: string;
  expire?: boolean;
  by?: string;
  note?: string;
  reason?: string;
};

/** `python -m pipelines.approval_queue` (tham số đã tách) → exit 0 ok · 1 bị từ chối · 2 sai/DB down. */
export async function approvalQueueCli(
  o: ApprovalCliOpts,
  open: () => Promise<Db | null>,
): Promise<number> {
  const usage = (m: string) => {
    console.error(`[err] ${m}`);
    return 2;
  };
  for (const k of ['approve', 'reject', 'overrideQa'] as const) {
    if (o[k] !== undefined && pyInt(o[k]) === null) return usage(`--${k} cần số nguyên ID`);
  }
  const nOps =
    [o.approve, o.reject, o.overrideQa].filter((x) => x !== undefined).length +
    Number(!!o.pending) +
    Number(!!o.expire);
  if (nOps === 0) {
    return usage('cần 1 thao tác: --pending | --approve | --reject | --override-qa | --expire');
  }
  if (nOps > 1) return usage('chỉ 1 thao tác mỗi lần — tách lệnh');
  const by = pyStrip(o.by ?? '');
  if ((o.approve ?? o.reject ?? o.overrideQa) !== undefined && !by) {
    return usage('--approve/--reject/--override-qa cần --by <tên người>');
  }
  if (o.overrideQa !== undefined && !pyStrip(o.reason ?? '')) {
    return usage('--override-qa cần --reason <lý do>');
  }
  if (by && !o.expire && !approvalEnforced()) console.error(`[warn] ${dep('auth').DEV_WARNING}`);
  const db = await open();
  if (db === null) {
    console.error('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  try {
    if (o.pending) {
      const rows = await pending(db, o.block ?? null);
      if (!rows.length) console.log('[pending] hàng duyệt chung trống');
      else {
        console.log(`[pending] ${rows.length} mục chờ duyệt:`);
        for (const d of rows) console.log(itemLine(d));
      }
      return 0;
    }
    if (o.expire) {
      const n = await expireOverdue(db, by || 'system:sla');
      console.log(`[done] ${n} mục quá SLA → expired (không tự duyệt)`);
      return 0;
    }
    if (o.overrideQa !== undefined) {
      const [ok, msg] = await override(db, o.overrideQa, by, o.reason ?? null);
      if (!ok) {
        console.error(`[warn] ${msg}`);
        return 1;
      }
      console.log(
        `[done] mục #${pyInt(o.overrideQa)}: ghi override_qa (người: ${by}) — vẫn cần người khác --approve`,
      );
      return 0;
    }
    const qid = (o.approve ?? o.reject) as string;
    const dec = o.approve !== undefined ? 'approved' : 'rejected';
    const [ok, msg] = await decide(db, qid, by, dec, o.note ?? null);
    if (!ok) {
      console.error(`[warn] ${msg}`);
      return 1;
    }
    console.log(`[done] mục #${pyInt(qid)} → ${dec} (người duyệt: ${by})`);
    return 0;
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(`[error] lỗi DB: ${dbMsg(e)}`);
    return 2;
  } finally {
    if (db instanceof pg.Pool) await db.end().catch(() => {});
  }
}
