import { basename } from 'node:path';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import * as aq from '@samsam/core/ops/approval-queue';
import { type Db, dep } from '@samsam/core/ops/deps';
import { submit } from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { dmy, vnDate } from '@samsam/core/ops/period';
import { cpSlice, pyInt } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError, withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import {
  callHuman,
  cliGate,
  cliIdentity,
  HumanDenied,
  HumanError,
} from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { pyStrip, pyTruthy } from '@samsam/core/security/py';
import type { DbLease } from '../channels/channels.command.js';
import { dayDiff, isoDate, isoWeek, jsonLoads, NON_WS, PyFileError, readUtf8 } from './py.js';

// Port `agents/da_pmo.py` (v8.3 DA-01, khối ceo — tính năng ceo-02.1 "Theo dõi tiến độ"): sổ mốc
// `project_milestones` + bảng tuần. `--seed` chỉ thêm mốc chưa có (sửa tay trên DB không bị đè);
// `--set-status` = QUYẾT ĐỊNH của người (cliGate + function `milestone_set_status_human`); đổi hạn KHÔNG
// sửa thẳng DB: `--propose-due` → hàng duyệt `milestone_change` (created_by = NGƯỜI đề xuất → không tự
// duyệt được) → `--apply-due` (cliIdentity + kiểm sha bản duyệt + `milestone_apply_due_human`).
// `--board` dựng bảng THUẦN (TRỄ, nhắc T-7/T-2, mốc chưa có ngày); `--submit` chạy guardrail TRƯỚC.
// Không mạng, không LLM. Exit: 0 ok · 1 bị từ chối · 2 tham số sai / DB down / lỗi DB / tính năng tắt.

export const MILESTONES_FILE = dataPath('projects', 'milestones.json');
export const SOURCE = 'data/projects/milestones.json';
export const STATUSES = ['chua_bat_dau', 'dang_lam', 'xong', 'tam_dung'];
export const CODE_RE = /^[A-Z][A-Z0-9_.-]{1,31}$/;
export const BLOCK = 'ceo';
export const LEGACY_BLOCK = 'projects'; // khối cũ trước v12.0 (đã gỡ)
export const CREATED_BY = 'agent:da_pmo';
export const FEATURE = 'ceo-02.1';
export const JOB = 'agents.da_pmo';
export const COLS = [
  'code',
  'title',
  'wp',
  'owner_role',
  'due_date',
  'gate',
  'evidence',
  'status',
] as const;
export const UNDATED_KEYS = ['title', 'owner_role', 'han_theo_hd', 'blocker'];
// `\S`/`\d` như Python (Unicode); `(?P=c)` → `\k<c>`.
export const PAYLOAD_RE = new RegExp(
  `^# Đề xuất đổi hạn mốc (?<c>${NON_WS}+)\\n\\ncode: \\k<c>\\nold_due: ` +
    '(?<old>\\p{Nd}{4}-\\p{Nd}{2}-\\p{Nd}{2})\\nnew_due: (?<new>\\p{Nd}{4}-\\p{Nd}{2}-\\p{Nd}{2})\\n' +
    'by: (?<by>[^\\n]+)\\n\\nĐổi hạn chỉ có hiệu lực sau khi người duyệt ' +
    '\\(agent không tự đổi\\)\\.\\n$',
  'u',
);

export type Milestone = Record<string, unknown> & {
  code: string;
  title: string;
  owner_role: string;
  gate: string;
  due_date: string; // 'YYYY-MM-DD'
};
export type Undated = Record<string, unknown> & { code: string };
export type BoardRow = {
  code: string;
  title: unknown;
  owner_role: unknown;
  due_date: string;
  gate: unknown;
  evidence?: unknown;
  status: string;
  wp?: unknown;
};

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonblank = (v: unknown): v is string => typeof v === 'string' && pyStrip(v) !== '';

/** Python `doc["milestones"]` trên giá trị JSON → tên lỗi khi không lấy được. */
function subscript(doc: unknown, key: string): unknown {
  if (isDict(doc)) {
    if (!Object.hasOwn(doc, key)) throw new PyFileError('KeyError');
    return doc[key];
  }
  throw new PyFileError('TypeError');
}

/** `data/projects/milestones.json` → mốc đã kiểm (due_date 'YYYY-MM-DD'). Sai → RangeError (ValueError). */
export function loadMilestones(path: string = MILESTONES_FILE): Milestone[] {
  let items: unknown;
  try {
    items = subscript(jsonLoads(readUtf8(path)), 'milestones');
  } catch (e) {
    if (!(e instanceof PyFileError)) throw e;
    throw new RangeError(`${basename(path)}: không đọc được (${e.pyType})`);
  }
  const out: Milestone[] = [];
  const seen = new Set<string>();
  (Array.isArray(items) ? items : []).forEach((m, i) => {
    if (!isDict(m) || typeof m.code !== 'string' || !CODE_RE.test(m.code) || seen.has(m.code)) {
      throw new RangeError(`milestones[${i}].code: thiếu/sai/trùng`);
    }
    for (const k of ['title', 'owner_role', 'gate', 'due_date']) {
      if (!nonblank(m[k])) throw new RangeError(`${m.code}.${k}: thiếu`);
    }
    const due = isoDate(m.due_date as string);
    if (due === null) throw new RangeError(`${m.code}.due_date: cần YYYY-MM-DD`);
    if (Object.hasOwn(m, 'can_ky') && typeof m.can_ky !== 'boolean') {
      throw new RangeError(`${m.code}.can_ky: phải true/false`);
    }
    seen.add(m.code);
    out.push({ ...(m as Milestone), due_date: due });
  });
  if (!out.length) throw new RangeError(`${basename(path)}: 0 mốc`);
  return out;
}

/** Mốc HĐ chưa có ngày (`moc_chua_co_ngay`, tùy chọn). Sai dạng / trùng mã với mốc có ngày →
 * RangeError (bảng tuần không âm thầm bỏ mốc). */
export function loadUndated(path: string = MILESTONES_FILE): Undated[] {
  let doc: unknown;
  let items: unknown;
  try {
    doc = jsonLoads(readUtf8(path));
    if (!isDict(doc)) throw new PyFileError('AttributeError'); // Python `doc.get` trên list/str/None
    items = Object.hasOwn(doc, 'moc_chua_co_ngay') ? doc.moc_chua_co_ngay : [];
  } catch (e) {
    if (!(e instanceof PyFileError)) throw e;
    throw new RangeError(`${basename(path)}: không đọc được (${e.pyType})`);
  }
  // Python `{m.get("code") for m in doc.get("milestones") or () if isinstance(m, dict)}` (ngoài try:
  // milestones không lặp được → TypeError nổi lên như Python).
  const ms = (doc as Record<string, unknown>).milestones;
  const dated = new Set<unknown>();
  if (pyTruthy(ms)) {
    if (typeof ms === 'number' || typeof ms === 'boolean') {
      throw new TypeError(`'${typeof ms === 'number' ? 'int' : 'bool'}' object is not iterable`);
    }
    for (const m of Array.isArray(ms) ? ms : []) if (isDict(m)) dated.add(m.code ?? null);
  }
  if (!Array.isArray(items)) throw new RangeError('moc_chua_co_ngay: phải là list');
  const out: Undated[] = [];
  const seen = new Set<string>();
  items.forEach((m, i) => {
    const code = isDict(m) ? m.code : null;
    if (typeof code !== 'string' || !CODE_RE.test(code) || seen.has(code) || dated.has(code)) {
      throw new RangeError(`moc_chua_co_ngay[${i}].code: thiếu/sai/trùng`);
    }
    for (const k of UNDATED_KEYS) {
      if (!nonblank((m as Record<string, unknown>)[k])) throw new RangeError(`${code}.${k}: thiếu`);
    }
    seen.add(code);
    out.push(m as Undated);
  });
  return out;
}

export type SeedStats = { inserted: number; existing: number; drift: string[] };

/** Nạp mốc chưa có (`on conflict do nothing` — sửa tay trên DB KHÔNG bị đè); [lệch] = mốc đã có mà
 * title/hạn/gate khác file. Cùng một giao dịch như Python (lỗi giữa chừng → không ghi gì). */
export async function seed(db: Db, items: Milestone[], dryRun = false): Promise<SeedStats> {
  const st: SeedStats = { inserted: 0, existing: 0, drift: [] };
  await withTx(db, async (q) => {
    for (const m of items) {
      const { rows } = await q.query<{ title: string; due: string; gate: string }>(
        'select title, due_date::text as due, gate from project_milestones where code = $1',
        [m.code],
      );
      const old = rows[0];
      if (old && (old.title !== m.title || old.due !== m.due_date || old.gate !== m.gate)) {
        st.drift.push(m.code);
      }
      if (dryRun) {
        if (old) st.existing++;
        else st.inserted++;
        continue;
      }
      const ins = await q.query(
        "insert into project_milestones (code, title, wp, owner_role, due_date, gate, source, updated_by, sign_required) values ($1, $2, $3, $4, $5, $6, $7, 'seed', $8) on conflict (code) do nothing",
        [
          m.code,
          m.title,
          m.wp ?? null,
          m.owner_role,
          m.due_date,
          m.gate,
          SOURCE,
          Boolean(m.can_ky),
        ],
      );
      if (ins.rowCount === 1) st.inserted++;
      else {
        st.existing++;
        // Đợt hợp đồng C05: cờ "mốc cần văn bản ký" theo file (chỉ cờ này — không đè trạng
        // thái/bằng chứng người đã ghi).
        await q.query(
          'update project_milestones set sign_required = $1 where code = $2 and sign_required <> $1',
          [Boolean(m.can_ky), m.code],
        );
      }
    }
  });
  return st;
}

/** Python `_md`: che PII, gộp 1 dòng, cắt `n`, thoát '|'; rỗng → '—'. */
function md(s: unknown, n = 120): string {
  return oneline(maskPii(pyTruthy(s) ? String(s) : ''), n).replaceAll('|', '\\|') || '—';
}

/** Python `date.isocalendar()` → 'YYYY-Www'. */
export function weekId(day: string): string {
  const [y, w] = isoWeek(day);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** Bảng tuần markdown (thuần). `undated` = mốc HĐ chưa có ngày. */
export function renderBoard(
  rowsIn: readonly BoardRow[],
  today: string,
  undated: readonly Undated[] = [],
): string {
  const rows = [...rowsIn].sort((a, b) =>
    a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : cpCmp(a.code, b.code),
  );
  const late = rows.filter((r) => r.due_date < today && r.status !== 'xong');
  const lateCodes = new Set(late.map((r) => r.code));
  const L: string[] = [
    `# Bảng tiến độ triển khai — tuần ${weekId(today)} (ngày ${dmy(today)})`,
    '',
    '| Mã | Việc | Owner | Hạn | Gate | Evidence | Trạng thái |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const st = lateCodes.has(r.code) ? `**TRỄ** (${r.status})` : r.status;
    L.push(
      `| ${r.code} | ${md(r.title)} | ${md(r.owner_role)} | ${dmy(r.due_date)} | ${md(r.gate, 160)} | ` +
        `${pyTruthy(r.evidence) ? md(r.evidence) : 'chưa có'} | ${st} |`,
    );
  }
  L.push('', '## Mốc trễ', '');
  if (late.length) {
    for (const r of late) {
      L.push(
        `- **TRỄ** ${r.code} — hạn ${dmy(r.due_date)} (trễ ${dayDiff(today, r.due_date)} ngày, ${r.status})`,
      );
    }
  } else L.push('- (không có)');
  L.push('', '## Nhắc hạn hôm nay', '');
  const rem: string[] = [];
  for (const r of rows) {
    const left = dayDiff(r.due_date, today);
    if (r.status !== 'xong' && (left === 7 || left === 2)) {
      rem.push(`- T-${left}: ${r.code} — hạn ${dmy(r.due_date)}`);
    }
  }
  L.push(...(rem.length ? rem : ['- (không có)']));
  if (undated.length) {
    L.push(
      '',
      '## Mốc chưa có ngày (chờ ngày ký / hai bên chốt)',
      '',
      '| Mã | Việc | Owner | Hạn theo HĐ | Blocker |',
      '|---|---|---|---|---|',
    );
    for (const u of undated) {
      L.push(
        `| ${u.code} | ${md(u.title)} | ${md(u.owner_role)} | ${md(u.han_theo_hd)} | ${md(u.blocker, 160)} |`,
      );
    }
  }
  L.push(
    '',
    '---',
    '*BẢN NHÁP — agent không tự gửi; TGĐ chốt trạng thái/hạn (đổi hạn qua hàng duyệt).*',
    '',
  );
  return L.join('\n');
}

export function changePayload(code: string, oldDue: string, newDue: string, by: string): string {
  return (
    `# Đề xuất đổi hạn mốc ${code}\n\ncode: ${code}\nold_due: ${oldDue}\nnew_due: ${newDue}` +
    `\nby: ${by}\n\nĐổi hạn chỉ có hiệu lực sau khi người duyệt (agent không tự đổi).\n`
  );
}

/**
 * Áp hạn của mục `milestone_change` ĐÃ duyệt → [ok, thông điệp]. Kiểm đọc ở đây (thông điệp rõ + cổng
 * rollout biên DÙNG `aq.verify`), GHI qua `milestone_apply_due_human` (SECURITY DEFINER — DB tự kiểm lại
 * mục đã duyệt, sha bản duyệt, hạn cũ; danh tính theo login). DB từ chối danh tính → HumanDenied.
 */
export async function applyDue(db: Db, qid: bigint, by: string): Promise<[boolean, string]> {
  const { rows } = await db.query<{
    block: string;
    object_type: string;
    status: string;
    payload: string | null;
    object_id: string;
  }>('select block, object_type, status, payload, object_id from approval_queue where id = $1', [
    String(qid),
  ]);
  const row = rows[0];
  // v12.0: đề xuất nộp trước v12.0 nằm ở khối `projects` (đã gỡ) — vẫn áp dụng được sau khi duyệt.
  if (
    !row ||
    ![BLOCK, LEGACY_BLOCK].includes(row.block) ||
    row.object_type !== 'milestone_change'
  ) {
    return [false, `mục #${qid} không phải \`milestone_change\` khối ceo`];
  }
  if (row.status !== 'approved') {
    return [false, `mục #${qid} đang '${row.status}' — chỉ áp dụng khi đã duyệt`];
  }
  const m = PAYLOAD_RE.exec(row.payload ?? '');
  if (m?.groups === undefined) {
    return [false, `mục #${qid}: payload sai định dạng — không áp dụng`];
  }
  const g = m.groups as { c: string; old: string; new: string; by: string };
  const oldDue = isoDate(g.old);
  const newDue = isoDate(g.new);
  if (oldDue === null || newDue === null) {
    return [false, `mục #${qid}: ngày trong payload sai lịch`];
  }
  const rebuilt = changePayload(g.c, oldDue, newDue, g.by);
  if (row.object_id !== `milestone:${g.c}` || !(await aq.verify(db, qid, rebuilt))) {
    return [false, `mục #${qid}: LỆCH bản duyệt (sha256) — không áp dụng`];
  }
  let res: unknown;
  try {
    const r = await callHuman(
      db,
      'select milestone_apply_due_human($1, $2) as r',
      [String(qid), by],
      {
        by,
        block: null,
        action: 'apply_due',
        objectType: 'approval_queue',
        objectId: String(qid),
      },
    );
    res = r.rows[0]?.r;
  } catch (e) {
    if (e instanceof HumanDenied) throw e;
    if (e instanceof HumanError) return [false, e.message]; // DB từ chối nghiệp vụ (stale…)
    throw e;
  }
  if (res === 'noop') return [true, `${g.c}: hạn đã là ${dmy(newDue)} — không đổi (no-op)`];
  return [true, `${g.c}: hạn ${dmy(oldDue)} → ${dmy(newDue)} (mục #${qid})`];
}

// =============================================================== CLI

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type DaPmoOpts = {
  seed?: boolean;
  dryRun?: boolean;
  setStatus?: string;
  status?: string;
  evidence?: string;
  board?: boolean;
  date?: string;
  outDir?: string;
  submit?: boolean;
  proposeDue?: string;
  due?: string;
  applyDue?: string;
  by?: string;
};

export type DaPmoDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => void;
  jobRun?: typeof jobRun;
  now?: () => Date;
  milestonesFile?: string;
};

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

async function board(db: Db, o: DaPmoOpts, today: string, io: Io, file: string): Promise<number> {
  // r12 RB: bảng tuần là đầu ra của ceo-02.1 — tắt thì chặn TRƯỚC khi đọc/ghi file/đẩy hàng duyệt.
  const why = await blocked(db, 'bảng tiến độ tuần', FEATURE);
  if (why) return sayBlocked(why, io.out);
  const { rows } = await db.query<BoardRow>(
    `select code, title, wp, owner_role, due_date::text as due_date, gate, evidence, status from project_milestones order by due_date, code`,
  );
  let undated: Undated[];
  try {
    undated = loadUndated(file);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err(`[error] ${e.message} — không dựng bảng thiếu mốc`);
    return 1;
  }
  const text = renderBoard(rows, today, undated);
  // P8.4: sổ mốc dự án (người ghi) — không có đường mẫu.
  const path = await writeReport(text, o.outDir ?? REPORTS_DIR, `da-pmo-board-${today}.md`, false);
  io.out(`[done] ${rows.length} mốc → ${path}`);
  if (!o.submit) return 0;
  // Mục trượt guardrail không duyệt được (decide kiểm lại) — chặn sớm.
  const g = dep('guardrailCheck')(text) as { ok?: unknown; violations?: unknown };
  if (g.ok !== true) {
    const vs = Array.isArray(g.violations) ? (g.violations as Record<string, unknown>[]) : [];
    const hits = [
      ...new Set(vs.map((v) => `${String(v.code ?? 'None')} "${oneline(v.span ?? '', 40)}"`)),
    ].sort(cpCmp);
    io.err(
      `[warn] bảng trượt guardrail (${hits.join(', ')}) — mục sẽ KHÔNG duyệt được; sửa title/gate/evidence mốc rồi chạy lại — KHÔNG đẩy`,
    );
    return 1;
  }
  const wk = weekId(today);
  let qid: bigint;
  try {
    qid = await submit(db, {
      block: BLOCK,
      objectType: 'weekly_board',
      objectId: `board:${wk}`,
      title: `Bảng tiến độ triển khai ${wk}`,
      payload: text,
      createdBy: CREATED_BY,
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    io.err(`[warn] bảng ${wk} đã có mục đang chờ duyệt`);
    return 1;
  }
  io.out(`[done] đã đẩy mục #${qid} (PENDING) — TGĐ duyệt`);
  return 0;
}

async function setStatus(db: Db, code: string, o: DaPmoOpts, by: string, io: Io, env: Env) {
  // v15.4 (P10.2): đổi trạng thái mốc (kể cả `xong` = nghiệm thu mốc, căn cứ báo cáo HĐTV) =
  // QUYẾT ĐỊNH của người được Bên B ủy quyền khối ceo.
  const why = await cliGate(db, by, BLOCK, 'set_status', 'project_milestone', code, {
    env,
    warn: io.err,
  });
  if (why) {
    io.err(`[từ chối] ${why} — không ghi`);
    return 1;
  }
  const ev = o.evidence ? cpSlice(maskPii(pyStrip(o.evidence)), 0, 500) : null;
  let res: unknown;
  try {
    // v15 fix P10.2: ghi qua function SECURITY DEFINER (DB kiểm lại danh tính theo login + khối ceo
    // + tồn tại + `xong` cần evidence; trùng = no-op).
    const r = await callHuman(
      db,
      'select milestone_set_status_human($1, $2, $3, $4) as r',
      [code, o.status, ev, by],
      {
        by,
        block: BLOCK,
        action: 'set_status',
        objectType: 'project_milestone',
        objectId: code,
        env,
      },
    );
    res = r.rows[0]?.r;
  } catch (e) {
    if (e instanceof HumanDenied) {
      io.err(`[từ chối] ${e.message} — không ghi`);
      return 1;
    }
    if (e instanceof HumanError) {
      io.err(`[warn] ${oneline(e.message, 200)} — không ghi`);
      return 1;
    }
    throw e;
  }
  if (res === 'noop') io.out(`[done] ${code} đã ở ${o.status} — không đổi (no-op)`);
  else io.out(`[done] ${code} → ${o.status}`);
  return 0;
}

async function proposeDue(db: Db, code: string, due: string, by: string, io: Io) {
  const { rows } = await db.query<{ due: string }>(
    'select due_date::text as due from project_milestones where code = $1',
    [code],
  );
  if (!rows[0]) {
    io.err(`[warn] không có mốc ${oneline(code, 40)}`);
    return 1;
  }
  const old = rows[0].due;
  if (old === due) {
    io.err('[warn] hạn mới trùng hạn hiện tại — không đề xuất');
    return 1;
  }
  const who = oneline(maskPii(by), 100);
  let qid: bigint;
  try {
    // created_by = người đề xuất (không phải agent) — decide_item chặn người duyệt trùng người tạo.
    qid = await submit(db, {
      block: BLOCK,
      objectType: 'milestone_change',
      objectId: `milestone:${code}`,
      title: `Đổi hạn ${code}: ${dmy(old)} → ${dmy(due)}`,
      payload: changePayload(code, old, due, who),
      createdBy: who,
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    io.err(`[warn] mốc ${code} đã có đề xuất đang chờ`);
    return 1;
  }
  io.out(`[done] đề xuất mục #${qid} (PENDING) — hạn CHƯA đổi`);
  return 0;
}

async function main(o: DaPmoOpts, d: DaPmoDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`da_pmo: error: ${msg}`);
    return 2;
  };
  // argparse: kiểu/choices trước, rồi luật tổ hợp — mọi lỗi tham số exit 2 TRƯỚC connect.
  if (o.status !== undefined && !STATUSES.includes(o.status)) {
    return usage(
      `argument --status: invalid choice: '${o.status}' (choose from ${STATUSES.map((s) => `'${s}'`).join(', ')})`,
    );
  }
  const date = o.date === undefined ? undefined : isoDate(o.date);
  if (date === null) return usage('argument --date: ngày phải dạng YYYY-MM-DD');
  const due = o.due === undefined ? undefined : isoDate(o.due);
  if (due === null) return usage('argument --due: ngày phải dạng YYYY-MM-DD');
  const qid = o.applyDue === undefined ? undefined : pyInt(o.applyDue);
  if (qid === null) return usage(`argument --apply-due: invalid int value: '${o.applyDue}'`);
  const nOps =
    Number(Boolean(o.seed)) +
    Number(Boolean(o.board)) +
    Number(o.setStatus !== undefined) +
    Number(o.proposeDue !== undefined) +
    Number(qid !== undefined);
  if (nOps !== 1) {
    return usage(
      'cần đúng 1 thao tác: --seed | --set-status | --board | --propose-due | --apply-due',
    );
  }
  const by = pyStrip(o.by ?? '');
  if ((o.setStatus || o.proposeDue || qid !== undefined) && !by) {
    return usage('--set-status/--propose-due/--apply-due cần --by <tên>');
  }
  if ((o.setStatus === undefined) !== (o.status === undefined)) {
    return usage('--set-status cần --status (và --status chỉ đi với --set-status)');
  }
  if (o.evidence && o.setStatus === undefined) return usage('--evidence chỉ dùng với --set-status');
  if (o.proposeDue !== undefined && due === undefined) {
    return usage('--propose-due cần --due YYYY-MM-DD');
  }
  if ((o.dryRun && !o.seed) || (o.submit && !o.board)) {
    return usage('--dry-run chỉ với --seed; --submit chỉ với --board');
  }
  if (o.status === 'xong' && !pyStrip(o.evidence ?? '')) {
    io.err("[warn] status 'xong' cần --evidence (link/biên bản) — không ghi");
    return 1;
  }
  const file = d.milestonesFile ?? MILESTONES_FILE;
  let items: Milestone[] = [];
  if (o.seed) {
    try {
      items = loadMilestones(file);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      io.err(`[error] ${e.message}`);
      return 1;
    }
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  const db = lease.db;
  try {
    (d.wire ?? ((x: Db) => void wireCore(x)))(db);
    if (o.seed) {
      const st = await seed(db, items, Boolean(o.dryRun));
      io.out(
        `[done] ${o.dryRun ? 'would_insert' : 'inserted'}=${st.inserted} existing=${st.existing}` +
          (o.dryRun ? ' (dry-run, không ghi)' : ''),
      );
      for (const code of st.drift) {
        io.err(
          `[lệch] ${code}: DB giữ bản cũ (title/hạn/gate khác file) — TGĐ sửa tay; hạn đổi qua --propose-due`,
        );
      }
      return 0;
    }
    if (o.board) {
      const today = date ?? vnDate(d.now?.() ?? new Date());
      return await (d.jobRun ?? jobRun)(
        JOB,
        async (run) => {
          const rc = await board(db, o, today, io, file);
          run.ok = rc === 0;
          return rc;
        },
        env,
      );
    }
    if (o.setStatus !== undefined) return await setStatus(db, o.setStatus, o, by, io, env);
    if (o.proposeDue !== undefined)
      return await proposeDue(db, o.proposeDue, due as string, by, io);
    // v15.4 (P10.2): áp hạn = THỰC THI mục đã duyệt (quyết định nằm ở decide_item); chỉ kiểm danh
    // tính người chạy.
    const q = qid as bigint;
    const why = await cliIdentity(db, by, 'approval_queue', String(q), {
      action: 'apply_due',
      env,
    });
    if (why) {
      io.err(`[từ chối] ${why} — không ghi`);
      return 1;
    }
    let res: [boolean, string];
    try {
      res = await applyDue(db, q, by);
    } catch (e) {
      if (!(e instanceof HumanDenied)) throw e;
      io.err(`[từ chối] ${e.message} — không ghi`);
      return 1;
    }
    const [ok, msg] = res;
    if (ok) io.out(`[done] ${msg}`);
    else io.err(`[warn] ${msg}`);
    return ok ? 0 : 1;
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${dbMsg(e)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

/** `python -m agents.da_pmo` — RolloutBlocked lọt tới đỉnh → `[rollout] lý do`, exit 2 (cli_entry). */
export async function daPmoMain(o: DaPmoOpts, d: DaPmoDeps = {}): Promise<number> {
  try {
    return await main(o, d);
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, (d.io ?? STD_IO).out);
    throw e;
  }
}
