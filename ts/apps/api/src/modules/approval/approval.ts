import type { Env } from '@samsam/core/env';
import type { QueueItem } from '@samsam/core/ops/approval-queue';
import { dep } from '@samsam/core/ops/deps';
import { isPlainObject } from '@samsam/core/ops/py';
import {
  type Draft,
  draftBlock,
  fmtGuardrail,
  guardrailLines,
  type Level,
  oneline,
  samePerson,
} from '@samsam/core/ops/store';
import { approvalEnforced, authorize, canApprove } from '@samsam/core/security/auth';
import { pyStrip } from '@samsam/core/security/py';

// Logic tab "Duyệt & Lịch" (Python `app/streamlit_app.py`): khóa nút Duyệt/Từ chối theo đúng thứ tự
// điều kiện của Streamlit, chuỗi hiển thị giữ nguyên câu Python. Controller dùng CÙNG hàm này cho GET
// (hiện nút) và POST (chặn yêu cầu giả mạo nút đã khóa) — set_status/decide của core kiểm lại sau đó.
// KHÁC Python có chủ đích (chặt hơn): nội dung AI hiển thị kèm guardrail KIỂM LẠI lúc hiển thị
// (`guardrailCheck` trên đúng text), vi phạm → khóa Duyệt (core cũng từ chối khi duyệt).

export type Gate = { ok: boolean; why: string | null };
export type Who = { ident: string; role: string };

const NOW_VIOLATION = 'Guardrail kiểm lại lúc hiển thị: VI PHẠM — phải từ chối hoặc viết lại';

/** Guardrail chạy lại trên đúng chuỗi hiển thị → [ok, mã vi phạm]. */
export function recheck(text: string | null): { ok: boolean; codes: string[] } {
  const g = dep('guardrailCheck')(text ?? '');
  const vs = (Array.isArray(g.violations) ? g.violations : []).filter(isPlainObject);
  return {
    ok: g.ok === true,
    codes: [...new Set(vs.map((v) => String(v.code ?? v.type ?? '?')))],
  };
}

/** Python: `_why` (Duyệt) + `_can_rej`/`_rej_why` (Từ chối) của một draft content. */
export function draftGate(
  d: Pick<Draft, 'created_by' | 'content_type' | 'guardrail' | 'text'>,
  w: Who,
  env: Env = process.env,
): { approve: Gate; reject: Gate } {
  const gok = isPlainObject(d.guardrail) && d.guardrail.ok === true;
  const mine = samePerson(d.created_by, w.ident);
  let why: string | null = null;
  if (!gok) why = 'Guardrail vi phạm — phải từ chối hoặc viết lại';
  else if (!canApprove(w.role)) why = `Vai trò \`${w.role}\` không có quyền duyệt`;
  else if (mine) why = 'Bạn là người tạo draft — cần người khác duyệt';
  else if (!pyStrip(d.created_by ?? ''))
    why = 'Draft trước v3.4 không có người tạo — từ chối rồi tạo lại';
  else if (!recheck(d.text).ok) why = NOW_VIOLATION;
  let canRej = canApprove(w.role) || mine;
  let rejWhy: string | null = null;
  if (approvalEnforced(env)) {
    // v13.5 (F08): chế độ thực — người được Bên B ủy quyền đúng khối của draft.
    const blk = draftBlock(d);
    const o = { role: w.role, createdBy: d.created_by, via: 'ui', env };
    if (why === null) why = authorize(w.ident, blk, 'approve', o).why;
    const r = authorize(w.ident, blk, 'reject', o);
    canRej = r.ok;
    rejWhy = r.why;
  }
  return {
    approve: { ok: why === null, why },
    reject: {
      ok: canRej,
      why: canRej ? null : rejWhy || `Vai trò \`${w.role}\` không có quyền duyệt/từ chối`,
    },
  };
}

/** Python: nút Duyệt/Từ chối của mục hàng duyệt chung (`authorize` ở mọi chế độ). */
export function queueGate(
  q: Pick<QueueItem, 'block' | 'created_by' | 'guardrail_ok' | 'preview'>,
  w: Who,
  env: Env = process.env,
): { approve: Gate; reject: Gate } {
  const o = { role: w.role, createdBy: q.created_by, via: 'ui', env };
  let a: Gate = authorize(w.ident, q.block, 'approve', o);
  if (a.ok && !q.guardrail_ok) a = { ok: false, why: 'Guardrail vi phạm — chỉ từ chối' };
  if (a.ok && !recheck(q.preview).ok) a = { ok: false, why: NOW_VIOLATION };
  return { approve: a, reject: authorize(w.ident, q.block, 'reject', o) };
}

export type DraftView = {
  id: string;
  label: string;
  text: string;
  guardrail: [Level, string][];
  guardrailNow: { ok: boolean; codes: string[] };
  createdBy: string;
  approve: Gate;
  reject: Gate;
};

export function draftView(d: Draft, w: Who, env: Env = process.env): DraftView {
  const g = isPlainObject(d.guardrail) ? d.guardrail : {};
  return {
    id: d.id,
    label: `#${d.id} [${d.channel}] ${oneline(d.brief, 70)} — guardrail ${fmtGuardrail(d)}`,
    // Bản THÔ: duyệt ký sha256 của đúng chuỗi này (WYSIWYS) — web hiện dạng text, không markdown.
    text: d.text ?? '',
    guardrail: Object.keys(g).length ? guardrailLines(g) : [],
    guardrailNow: recheck(d.text),
    createdBy: `Tạo bởi: ${d.created_by || '—'}`,
    ...draftGate(d, w, env),
  };
}

export type QueueView = {
  id: string;
  label: string;
  text: string;
  meta: string;
  guardrailNow: { ok: boolean; codes: string[] };
  approve: Gate;
  reject: Gate;
};

export function queueView(q: QueueItem, w: Who, env: Env = process.env): QueueView {
  return {
    id: q.id,
    label: `#${q.id} [${q.block}/${q.object_type}] ${oneline(q.title ?? '', 70)}`,
    text: q.preview ?? '',
    meta:
      `Tạo bởi: ${q.created_by} · rủi ro ${q.risk} · QA ${q.qa_status} · guardrail ` +
      (q.guardrail_ok ? 'PASS' : 'VI PHẠM'),
    guardrailNow: recheck(q.preview),
    ...queueGate(q, w, env),
  };
}
