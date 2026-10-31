import pg from 'pg';
import { dataPath } from '../paths.js';
import {
  BLOCKS,
  DirectorConfigError,
  loadBlockConfig,
  validateBlockConfig,
} from '../security/auth.js';
import * as aq from './approval-queue.js';
import { type Db, dep } from './deps.js';
import { jobRun } from './job-runs.js';
import { dmy, periodBounds, pyRepr, vnFormat } from './period.js';
import { REPORTS_DIR, writeReport } from './report.js';
import { oneline } from './store.js';
import { dbMsg, isDbError } from './tx.js';

// Port `pipelines/director.py` (v4.0 W40.6) — mẫu agent giám đốc khối: gom việc của agent nhân viên
// vào hàng duyệt chung → bản tin markdown cho GĐ khối.
// - Cấu hình `data/directors/<khối>.json` cho 9 khối; `approvers`/`digest_recipients` rỗng = người
//   thật chưa cấp (external-dep); `object_types` {loại: {sla_hours 1..720, risk}} (cấm content_draft).
// - `submit`: SLA + risk lấy từ CẤU HÌNH (agent không tự đặt); `qaSuite` → qa_status từ `eval_runs`
//   (bỏ giá trị caller — agent không tự khai pass).
// - `run`: expire → thử auto_approve (không luật = bỏ qua, fail-closed ở DB) → bản tin → file
//   `data/reports/director-<khối>-<ngày VN>.md`. KHÔNG tự gửi.

export const DIRECTORS_DIR = dataPath('directors');
// Cấu hình khối: bản DUY NHẤT ở security/auth (Python director.validate/load_config — auth dùng lại).
export { BLOCKS, DirectorConfigError } from '../security/auth.js';
export const RISKS = ['low', 'medium', 'high'];
const ITEM_SQL =
  'select id, object_type, object_id, title, risk, qa_status, status, created_by, created_at, due_at, decided_by, decided_at, lane' +
  " from approval_queue where block = $1 and (status = 'pending' or decided_at >= $2 or created_at >= $2) order by id";
const QA_SQL =
  'select agent, suite_version, passed, n_pass, n_total, failed_cases, commit_sha, ts from eval_runs' +
  ' where owner_block = $1 and ts >= $2 and ts < $3 order by ts, id';
const OVERRIDE_SQL =
  'select d.queue_id, d.decided_by, d.created_at from decisions d join approval_queue a on a.id = d.queue_id' +
  " where a.block = $1 and d.kind = 'override_qa' and d.created_at >= $2 and d.created_at < $3 order by d.id";

const pyList = (xs: unknown[]) => `[${xs.map((x) => pyRepr(x)).join(', ')}]`;

export type DirectorConfig = {
  block: string;
  name: string;
  director_agent: string;
  approver_roles: string[];
  approvers: string[];
  digest_recipients: string[];
  object_types: Record<string, { sla_hours: number; risk: string } & Record<string, unknown>>;
  due_soon_hours: number;
} & Record<string, unknown>;

export const validate = validateBlockConfig as (cfg: unknown, block: string) => DirectorConfig;

export const loadConfig = (block: string, baseDir: string = DIRECTORS_DIR): DirectorConfig =>
  loadBlockConfig(block, baseDir) as DirectorConfig;

export function loadAll(baseDir: string = DIRECTORS_DIR): Record<string, DirectorConfig> {
  return Object.fromEntries(BLOCKS.map((b) => [b, loadConfig(b, baseDir)]));
}

/** 'pass' | 'fail' | 'none' theo run eval mới nhất của agent — bỏ run `<sha>-dirty`. */
export async function qaStatusLatest(db: Db, agent: string): Promise<'pass' | 'fail' | 'none'> {
  const { rows } = await db.query(
    "select passed from eval_runs where agent = $1 and commit_sha not like '%-dirty' order by ts desc, id desc limit 1",
    [agent],
  );
  if (!rows[0]) return 'none';
  return rows[0].passed ? 'pass' : 'fail';
}

/** Agent nhân viên đẩy việc → id hàng duyệt. SLA/risk từ cấu hình; loại lạ → lỗi trước DB. */
export async function submit(
  db: Db,
  a: {
    block: string;
    objectType: string;
    objectId: string | number | bigint;
    title: string | null;
    payload: string;
    createdBy: string;
    qaStatus?: string;
    cfg?: DirectorConfig;
    qaSuite?: string | null;
    sample?: boolean;
  },
): Promise<bigint> {
  const cfg = a.cfg ?? loadConfig(a.block);
  const spec = cfg.object_types[a.objectType];
  if (spec === undefined) {
    throw new RangeError(
      `khối ${a.block} không nhận loại việc '${a.objectType}' — có: ${pyList(Object.keys(cfg.object_types).sort())}`,
    );
  }
  const qa = a.qaSuite ? await qaStatusLatest(db, a.qaSuite) : (a.qaStatus ?? 'none');
  return aq.enqueue(db, {
    objectType: a.objectType,
    objectId: a.objectId,
    block: a.block,
    title: a.title,
    payload: a.payload,
    risk: spec.risk,
    createdBy: a.createdBy,
    slaHours: spec.sla_hours,
    qaStatus: qa,
    sample: a.sample ?? false,
  });
}

export type DigestItem = {
  id: string | number;
  object_type: string;
  title?: string | null;
  status: string;
  created_at?: Date | null;
  due_at?: Date | null;
  decided_at?: Date | null;
} & Record<string, unknown>;
export type Override = { queue_id: string | number; decided_by: string; created_at: Date };
export type QaRun = {
  agent: string;
  suite_version?: unknown;
  passed?: boolean;
  n_pass?: unknown;
  n_total?: unknown;
  failed_cases?: unknown[] | null;
  commit_sha?: string | null;
  ts?: Date | null;
};

const inRange = (ts: Date | null | undefined, a: Date, b: Date) =>
  ts instanceof Date && a.getTime() <= ts.getTime() && ts.getTime() < b.getTime();
const fmtVn = (ts: Date | null | undefined) => (ts ? vnFormat(ts, '%d/%m %H:%M') : '—');
const line = (d: DigestItem) =>
  `#${d.id} \`${d.object_type}\` ${oneline(dep('maskPii')(d.title || ''), 70)}`;
const py = (v: unknown) => (v === null || v === undefined ? 'None' : String(v));

function qaLine(r: QaRun): string {
  const fails = (r.failed_cases || []).map((x) => String(x));
  const more = fails.length > 10 ? ` (+${fails.length - 10})` : '';
  const tail = fails.length ? ` — ca FAIL: ${fails.slice(0, 10).join(', ')}${more}` : '';
  return (
    `- \`${r.agent}\` v${py(r.suite_version)} ${r.passed ? 'PASS' : 'FAIL'} ` +
    `${py(r.n_pass)}/${py(r.n_total)} · commit ${(r.commit_sha || '').slice(0, 7)}${tail}`
  );
}

/**
 * Bản tin markdown (THUẦN). `qaRuns` null = không đọc được eval_runs. `extra` = dòng markdown của
 * agent khối chèn ngay trước "## Người duyệt"; rỗng → y hệt bản không extra.
 */
export function digest(
  cfg: DirectorConfig,
  items: DigestItem[],
  now: Date,
  overrides: Override[] = [],
  qaRuns: QaRun[] | null = [],
  extra: readonly string[] = [],
): string {
  const [start, end] = periodBounds('day', now);
  const soon = now.getTime() + cfg.due_soon_hours * 3600_000;
  const pend = items.filter((d) => d.status === 'pending');
  const newToday = items.filter((d) => inRange(d.created_at, start, end));
  const done = Object.fromEntries(
    ['approved', 'rejected', 'expired'].map((s) => [
      s,
      items.filter((d) => d.status === s && inRange(d.decided_at, start, end)),
    ]),
  ) as Record<string, DigestItem[]>;
  const dueSoon = pend.filter(
    (d) => d.due_at && now.getTime() < d.due_at.getTime() && d.due_at.getTime() <= soon,
  );
  const ovr = overrides.filter((o) => inRange(o.created_at, start, end));
  const day = dmy(vnFormat(start, '%Y-%m-%d'));
  const none = ['- (không có)'];
  const L = [
    `# Bản tin GĐ ${cfg.name} — ${day}`,
    '',
    `Agent: ${cfg.director_agent} · khối \`${cfg.block}\` · giờ VN`,
    '',
    '## Số liệu trong ngày',
    '',
    '| Chỉ số | Số |',
    '|---|---|',
    `| Mới vào hàng | ${newToday.length} |`,
    `| Đang chờ duyệt (tồn) | ${pend.length} |`,
    `| Đã duyệt | ${done.approved!.length} |`,
    `| Từ chối | ${done.rejected!.length} |`,
    `| Hết hạn SLA (expired) | ${done.expired!.length} |`,
    '',
    `## Sắp quá hạn (≤ ${cfg.due_soon_hours} giờ)`,
    '',
  ];
  const s1 = dueSoon.map((d) => `- ${line(d)} — hạn ${fmtVn(d.due_at)}`);
  L.push(
    ...(s1.length ? s1 : none),
    '',
    '## Hết hạn hôm nay (không ai duyệt — KHÔNG tự duyệt)',
    '',
  );
  const s2 = done.expired!.map((d) => `- ${line(d)} — hạn ${fmtVn(d.due_at)}`);
  L.push(...(s2.length ? s2 : none), '', '## Override QA hôm nay (ép trình bản QA FAIL)', '');
  const s3 = ovr.map(
    (o) => `- mục #${o.queue_id} — bởi ${o.decided_by} lúc ${fmtVn(o.created_at)}`,
  );
  L.push(...(s3.length ? s3 : none), '', '## Nghiệm thu QA hôm nay', '');
  if (qaRuns === null) L.push('- (không đọc được eval_runs — lỗi/quyền DB)');
  else {
    const qa = qaRuns.filter((r) => inRange(r.ts, start, end)).map(qaLine);
    L.push(...(qa.length ? qa : none));
  }
  if (extra.length) L.push('', ...extra);
  L.push('', '## Người duyệt', '', `- Vai trò duyệt: ${cfg.approver_roles.join(', ')}`);
  if (!cfg.approvers.length) L.push('- Người duyệt chưa cấu hình (external-dep)');
  if (!cfg.digest_recipients.length) L.push('- Người nhận bản tin chưa cấu hình (external-dep)');
  L.push(
    '',
    '---',
    '*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay cho GĐ khối.*',
    '',
  );
  return L.join('\n');
}

/** expire → auto_approve (nếu có luật) → digest → file. → [path, text]. */
export async function run(
  db: Db,
  block: string,
  opts: { now?: Date; cfg?: DirectorConfig; outDir?: string; extra?: readonly string[] } = {},
): Promise<[string, string]> {
  const cfg = opts.cfg ?? loadConfig(block);
  const now = opts.now ?? new Date();
  await aq.expireOverdue(db);
  const cand = await db.query(
    "select id from approval_queue where block = $1 and status = 'pending' and risk = 'low' and qa_status = 'pass' order by id",
    [block],
  );
  for (const r of cand.rows) await aq.autoApprove(db, r.id); // không luật → [false, msg]: bỏ qua
  const [start, end] = periodBounds('day', now);
  const items = (await db.query(ITEM_SQL, [block, start])).rows as DigestItem[];
  const overrides = (await db.query(OVERRIDE_SQL, [block, start, end])).rows as Override[];
  let qaRuns: QaRun[] | null;
  try {
    // DB cũ/role thiếu quyền eval_runs không làm hỏng bản tin.
    qaRuns = (await db.query(QA_SQL, [block, start, end])).rows as QaRun[];
  } catch (e) {
    if (!isDbError(e)) throw e;
    qaRuns = null;
  }
  const text = digest(cfg, items, now, overrides, qaRuns, opts.extra ?? []);
  // P8.4: bản tin có mục hàng duyệt MẪU trong phạm vi → sample (không đếm là đầu ra thật).
  const sample = (
    await db.query(
      "select exists (select 1 from approval_queue where block = $1 and is_sample and (status = 'pending' or decided_at >= $2 or created_at >= $2)) as s",
      [block, start],
    )
  ).rows[0].s;
  const path = await writeReport(
    text,
    opts.outDir ?? REPORTS_DIR,
    `director-${block}-${vnFormat(start, '%Y-%m-%d')}.md`,
    Boolean(sample),
  );
  return [path, text];
}

/** `python -m pipelines.director` → exit 0 ok · 1 cấu hình lỗi · 2 DB down / tham số sai. */
export async function directorCli(
  o: { block?: string; all?: boolean; dryRun?: boolean },
  open: () => Promise<Db | null>,
): Promise<number> {
  return jobRun('pipelines.director', async (jr) => {
    const rc = await directorMain(o, open);
    jr.ok = rc === 0;
    return rc;
  });
}

async function directorMain(
  o: { block?: string; all?: boolean; dryRun?: boolean },
  open: () => Promise<Db | null>,
): Promise<number> {
  if (Boolean(o.all) === (o.block !== undefined)) {
    console.error('[err] cần đúng 1: --block K | --all');
    return 2;
  }
  if (o.block !== undefined && !(BLOCKS as readonly string[]).includes(o.block)) {
    console.error(`[err] --block phải là một trong: ${BLOCKS.join(', ')}`);
    return 2;
  }
  const blocks = o.all ? [...BLOCKS] : [o.block as string];
  let cfgs: Record<string, DirectorConfig>;
  try {
    cfgs = Object.fromEntries(blocks.map((b) => [b, loadConfig(b)]));
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    console.error(`[error] cấu hình lỗi: ${e.message}`);
    return 1;
  }
  if (o.dryRun) {
    for (const [b, c] of Object.entries(cfgs)) {
      const appr = c.approvers.length
        ? `${c.approvers.length} người`
        : 'chưa cấu hình (external-dep)';
      console.log(
        `[ok] ${b} — ${c.name} · ${Object.keys(c.object_types).length} loại việc · vai trò duyệt ${c.approver_roles.join(',')} · người duyệt ${appr}`,
      );
    }
    console.log(`[done] ${Object.keys(cfgs).length} khối hợp lệ (dry-run, không DB)`);
    return 0;
  }
  if (blocks.includes('finance')) {
    // Cùng file director-finance-<ngày>.md với acc_ar --bulletin (rename ghi đè).
    console.error(
      "[warn] khối finance: bản tin này GHI ĐÈ bản của `python -m agents.acc_ar --bulletin` (mất mục 'Công nợ đại lý quá hạn') — dùng lệnh acc_ar thay, hoặc chạy lại nó sau lệnh này.",
    );
  }
  if (blocks.includes('ceo')) {
    console.error(
      '[warn] khối ceo: bản tin này GHI ĐÈ bản của `python -m agents.ceo_report --bulletin` (mất 3 mục Tiến độ & Sổ quyết định / Rủi ro pháp lý / Audit outside-in) — dùng lệnh ceo_report thay, hoặc chạy lại nó sau lệnh này.',
    );
  }
  const db = await open();
  if (db === null) {
    console.error('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  try {
    for (const [b, c] of Object.entries(cfgs)) {
      const [path] = await run(db, b, { cfg: c });
      console.log(`[done] ${b} → ${path}`);
    }
  } catch (e) {
    if (!isDbError(e)) throw e;
    console.error(`[error] lỗi DB: ${dbMsg(e)}`);
    return 2;
  } finally {
    if (db instanceof pg.Pool) await db.end().catch(() => {});
  }
  return 0;
}
