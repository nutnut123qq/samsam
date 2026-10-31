import type { Db } from '@samsam/core/ops/deps';
import { addDays, periodBounds, vnDate, vnFormat } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { DATA_DIR } from '@samsam/core/paths';
import { casefold, pyStrip, reEscape } from '@samsam/core/security/py';
import {
  ALERT_LABELS,
  BLOCK,
  checkNow,
  code,
  collectAll,
  escalated,
  fmtVn,
  PERIODS,
  pendingItems,
  type SalesConfig,
  STATE_ORDER,
  type Stats,
  slaState,
  staleLeads,
  unanswered,
} from './sales-director.service.js';

// Bản tin GĐ Kinh doanh TMĐT (port phần bản tin của `agents/sales_director.py`): `gather` CHỈ
// SELECT + `renderBulletin` THUẦN, tất định — chỉ số đếm + `#id` + nhãn loại từ cấu hình; KHÔNG in
// câu hỏi khách, user_hash, title tự do, tên nhân viên, payload. KHÔNG LLM, KHÔNG tự gửi.
// v5.3: mục 6 "Catalog & giá (A4/A5)"; mục 5 đếm cả `promo_change`.

// v5.3 mục 6: agent luật A4/A5 đẩy mục `object_id` tiền tố a4:/a5:.
export const CATALOG_AGENTS: [string, string, string][] = [
  ['a4', 'agents.kd_listing', 'A4 Catalog/listing đa sàn'],
  ['a5', 'agents.kd_price', 'A5 Giá & khuyến mãi'],
];

export type QueueRow = {
  id: number;
  object_type: string;
  handoff_class: string;
  business_due_at: Date;
  state: string;
  escalated_at?: Date | null;
};
export type Catalog = {
  /** [tiền tố, loại việc, id mục pending] */
  pending: [string, string, number[]][];
  jobs: Record<string, [Date | null, boolean | null]> | null;
};
export type BulletinData = {
  period?: string;
  start: Date;
  end: Date;
  queue: QueueRow[];
  decided: Record<string, number>;
  alerts: [string, string, string | null, number][];
  n_leads: number;
  regions: [string, number][];
  stale_leads: number[];
  golden_pending: number;
  unanswered: number;
  cskh_deferred?: number;
  lead_deferred?: number;
  catalog?: Catalog | null;
};

/** day = ngày VN hôm qua; week = tuần ISO trước (giờ VN). */
export function periodOf(kind: string, now: Date): [Date, Date] {
  if (!PERIODS.includes(kind)) throw new RangeError(`period '${kind}' lạ — ('day', 'week')`);
  const d = vnDate(checkNow(now));
  return periodBounds(kind, addDays(d, kind === 'day' ? -1 : -7));
}

/** Đếm lead theo vùng (từ khóa tỉnh, biên từ 2 phía — 'huế' không ăn 'thuế'); không khớp →
 * 'chưa rõ vùng'. Chỉ trả SỐ. */
export function regionCounts(cfg: SalesConfig, questions: (string | null)[]): [string, number][] {
  const pats = Object.entries(cfg.regions).map(([name, kws]) => {
    const alt = kws.map((k) => reEscape(pyStrip(casefold(k.normalize('NFC'))))).join('|');
    return [name, new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'u')] as const;
  });
  const cnt = new Map<string, number>();
  for (const q of questions) {
    const s = casefold((q || '').normalize('NFC'));
    const n = pats.find(([, p]) => p.test(s))?.[0] ?? 'chưa rõ vùng';
    cnt.set(n, (cnt.get(n) ?? 0) + 1);
  }
  return [
    ...pats.map(([n]) => [n, cnt.get(n) ?? 0] as [string, number]),
    ['chưa rõ vùng', cnt.get('chưa rõ vùng') ?? 0],
  ];
}

/** v5.3 — CHỈ SELECT: mục pending khối KD của A4/A5 theo (tiền tố, loại việc) → [id], và lần chạy
 * gần nhất mỗi job từ `job_runs`. Role không đọc được `job_runs` (agent_writer — least privilege) →
 * `jobs` null ("không đọc được"), không crash. Gọi trên Pool/client không trong giao dịch (lỗi quyền
 * không làm hỏng giao dịch đang mở). */
export async function catalogStats(db: Db): Promise<Catalog> {
  const pend = new Map<string, [string, string, number[]]>();
  const { rows } = await db.query(
    "select split_part(object_id, ':', 1) as pre, object_type, id from approval_queue where block = $1 and status = 'pending' and object_id like any($2) order by id",
    [BLOCK, CATALOG_AGENTS.map(([p]) => `${p}:%`)],
  );
  for (const r of rows) {
    const key = `${r.pre}\u0000${r.object_type}`;
    const e = pend.get(key) ?? [r.pre, r.object_type, [] as number[]];
    e[2].push(Number(r.id));
    pend.set(key, e);
  }
  let jobs: Catalog['jobs'];
  try {
    const j = await db.query(
      'select distinct on (job) job, coalesce(finished_at, started_at) as ts, ok from job_runs where job = any($1) order by job, started_at desc, id desc',
      [CATALOG_AGENTS.map(([, job]) => job)],
    );
    jobs = Object.fromEntries(j.rows.map((r) => [r.job, [r.ts, r.ok]]));
  } catch (e) {
    if ((e as { code?: string }).code !== '42501') throw e;
    jobs = null;
  }
  return { pending: [...pend.values()], jobs };
}

/** CHỈ SELECT → số liệu bản tin (không câu hỏi/tên/payload). */
export async function gather(
  db: Db,
  now: Date,
  cfg: SalesConfig,
  periodKind = 'day',
  dataDir: string = DATA_DIR,
): Promise<BulletinData> {
  const [start, end] = periodOf(periodKind, now);
  const pend = (await pendingItems(db)).filter((p) =>
    Object.hasOwn(cfg.object_types, p.object_type),
  );
  const esc = await escalated(
    db,
    pend.map((p) => p.id),
  );
  const queue: QueueRow[] = pend.map((p) => {
    const st = slaState(p, cfg, now);
    return {
      id: p.id,
      object_type: p.object_type,
      handoff_class: st.handoff_class,
      business_due_at: st.business_due_at,
      state: st.state,
      escalated_at: esc.get(p.id) ?? null,
    };
  });
  const decided: Record<string, number> = {};
  for (const r of (
    await db.query(
      "select status, count(*)::int as n from approval_queue where block = $1 and status <> 'pending' and decided_at >= $2 and decided_at < $3 group by status",
      [BLOCK, start, end],
    )
  ).rows) {
    decided[r.status] = r.n;
  }
  const alerts = (
    await db.query(
      "select severity, kind, channel, count(*)::int as n from market_alerts where status = 'open' group by 1, 2, 3 order by 1, 2, 3",
    )
  ).rows.map(
    (r) => [r.severity, r.kind, r.channel, r.n] as [string, string, string | null, number],
  );
  const qs = (
    await db.query('select question from leads where ts >= $1 and ts < $2', [start, end])
  ).rows.map((r) => r.question as string | null);
  const golden = (
    await db.query(
      "select count(*)::int as n from golden_discrepancies where status = 'pending' and kind = any($1)",
      [cfg.sources.price_discrepancy_kinds],
    )
  ).rows[0].n as number;
  const st: Stats = {};
  const stale = await staleLeads(db, now, cfg);
  const nUn = unanswered(now, cfg, dataDir).reduce((a, u) => a + u.n, 0);
  const cskhDeferred = (await collectAll(db, now, cfg, dataDir, st))[1];
  return {
    period: periodKind,
    start,
    end,
    queue,
    decided,
    alerts,
    n_leads: qs.length,
    regions: regionCounts(cfg, qs),
    stale_leads: stale,
    golden_pending: golden,
    unanswered: nUn,
    cskh_deferred: cskhDeferred,
    lead_deferred: st.deferred ?? 0,
    catalog: await catalogStats(db),
  };
}

function stateText(q: QueueRow): string {
  if (q.state === 'overdue') {
    return q.escalated_at
      ? `quá hạn (đã leo thang lúc ${fmtVn(q.escalated_at)})`
      : 'quá hạn (chưa leo thang — chờ lần quét kế)';
  }
  return q.state === 'due_soon' ? 'sắp quá hạn' : 'đúng hạn';
}

function shiftText(cfg: SalesConfig): string {
  const s = cfg.business_hours;
  const names = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const days = [...s.workdays]
    .sort((a, b) => a - b)
    .map((d) => names[d])
    .join(', ');
  return `${s.start}–${s.end}, ${days}, ${(s.holidays ?? []).length} ngày lễ`;
}

const count = <T>(xs: T[], f: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return (k: string) => m.get(k) ?? 0;
};
const ids50 = (ids: number[]) =>
  ids
    .slice(0, 50)
    .map((i) => `#${i}`)
    .join(', ') + (ids.length > 50 ? ' …' : '');

/** THUẦN, tất định: cùng input → cùng chuỗi. */
export function renderBulletin(
  cfg: SalesConfig,
  data: BulletinData,
  now: Date,
  periodKind = 'day',
): string {
  const { start, end } = data;
  const last = new Date(end.getTime() - 86_400_000);
  const span =
    periodKind === 'day'
      ? `ngày ${vnFormat(start, '%d/%m/%Y')}`
      : `tuần ${vnFormat(start, '%d/%m')}–${vnFormat(last, '%d/%m/%Y')}`;
  const types = cfg.object_types;
  const label = (ot: string) => (types[ot] as { label: string }).label;
  const queue = [...data.queue].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      a.business_due_at.getTime() - b.business_due_at.getTime() ||
      a.id - b.id,
  );
  const nState = count(queue, (q) => q.state);
  const L = [
    `# Bản tin GĐ Kinh doanh TMĐT — ${span}`,
    '',
    `Agent: ${cfg.director_agent} · khối \`${BLOCK}\` · ảnh chụp hàng chờ lúc ${fmtVn(now)} (giờ VN)`,
    '',
    '## 1. Hàng chờ theo SLA giờ làm việc',
    '',
    '| Trạng thái | Số |',
    '|---|---|',
    `| Quá hạn | ${nState('overdue')} |`,
    `| Sắp quá hạn | ${nState('due_soon')} |`,
    `| Đúng hạn | ${nState('on_time')} |`,
    `| Tổng đang chờ | ${queue.length} |`,
    '',
  ];
  const qLines = queue.map(
    (q) =>
      `- #${q.id} · ${label(q.object_type)} · lớp ${q.handoff_class} · hạn ${fmtVn(q.business_due_at)} · ${stateText(q)}`,
  );
  L.push(...(qLines.length ? qLines : ['- (không có)']));
  const tgd = queue.filter(
    (q) =>
      q.state === 'overdue' && cfg.handoff_classes[q.handoff_class]?.escalate_to_role === 'tgd',
  );
  L.push('', '### Leo thang TGĐ (lớp B quá hạn)', '');
  const tLines = tgd.map((q) => `- #${q.id} · ${label(q.object_type)}`);
  L.push(...(tLines.length ? tLines : ['- (không có)']));
  const dec = data.decided;
  L.push(
    '',
    `## 2. Kết quả trong kỳ (${span})`,
    '',
    '| Kết quả | Số |',
    '|---|---|',
    `| Đã duyệt | ${dec.approved ?? 0} |`,
    `| Từ chối | ${dec.rejected ?? 0} |`,
    `| Hết hạn tuyệt đối (expired — KHÔNG tự duyệt) | ${dec.expired ?? 0} |`,
    '',
    '## 3. Cảnh báo sàn đang mở',
    '',
    '| Mức | Loại | Kênh | Số |',
    '|---|---|---|---|',
  );
  const aLines = data.alerts.map(
    ([sev, kind, ch, n]) => `| ${sev} | ${ALERT_LABELS[kind] ?? 'khác'} | ${code(ch)} | ${n} |`,
  );
  L.push(...(aLines.length ? aLines : ['| — | — | — | 0 |']));
  const nS: Record<string, number> = {};
  for (const [sev, , , n] of data.alerts) nS[sev] = (nS[sev] ?? 0) + n;
  L.push(
    '',
    `Tổng: S1 ${nS.S1 ?? 0} · S2 ${nS.S2 ?? 0}`,
    '',
    `## 4. Lead mới trong kỳ theo vùng (tổng ${data.n_leads})`,
    '',
    '| Vùng | Số lead |',
    '|---|---|',
  );
  L.push(...data.regions.map(([name, n]) => `| ${name} | ${n} |`));
  const stale = [...data.stale_leads].sort((a, b) => a - b);
  const hrs = cfg.sources.lead_stale_business_hours;
  L.push(
    '',
    `Lead \`new\` quá ${hrs} giờ làm việc chưa xử lý: ${stale.length}` +
      (stale.length ? ` — ${ids50(stale)}` : ''),
    `Câu chatbot chưa trả lời (${cfg.sources.convlog_lookback_hours} giờ qua): ${data.unanswered}`,
    `Nhóm khách chưa trả lời vượt trần ${cfg.sources.max_cskh_per_run} mục/lần chạy (chờ lần sau): ${data.cskh_deferred ?? 0}`,
    `Nhắc lead (\`lead_followup\`) đến hạn vượt trần ${cfg.lead_owner?.max_per_run ?? '?'} mục/lần chạy (chờ lần sau): ${data.lead_deferred ?? 0}`,
    '',
    '## 5. Giá chờ duyệt',
    '',
  );
  const price = queue.filter((q) =>
    ['price_review', 'price_change', 'promo_change'].includes(q.object_type),
  );
  L.push(
    `- Mục giá đang chờ trong hàng duyệt: ${price.length}` +
      (price.length ? ` — ${price.map((q) => `#${q.id}`).join(', ')}` : ''),
    `- Phiếu lệch golden (giá) đang pending: ${data.golden_pending}`,
    '',
  );
  L.push(...catalogLines(cfg, data.catalog));
  L.push('', '## Người duyệt', '', `- Vai trò duyệt: ${cfg.approver_roles.join(', ')}`);
  if (!cfg.approvers.length || !cfg.digest_recipients.length) {
    L.push('- Người duyệt/người nhận chưa cấu hình (external-dep)');
  }
  L.push(
    `- Ca làm việc GIẢ ĐỊNH: ${shiftText(cfg)} — GĐ KD chốt`,
    '',
    '---',
    '*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay cho GĐ Kinh doanh.*',
    '',
  );
  return L.join('\n');
}

/** Mục 6 (v5.3) — chỉ số đếm + #id + nhãn cấu hình (không sku_key/tiêu đề/payload/giá đối thủ).
 * Caller cũ không có `catalog` → chưa có số liệu. */
function catalogLines(cfg: SalesConfig, cat: Catalog | null | undefined): string[] {
  const L = ['## 6. Catalog & giá (A4/A5)', ''];
  if (!cat || typeof cat !== 'object') return [...L, '- (chưa có số liệu)'];
  const types = cfg.object_types;
  L.push('| Agent | Lần chạy gần nhất (giờ VN) | Kết quả |', '|---|---|---|');
  const jobs = cat.jobs;
  for (const [, job, name] of CATALOG_AGENTS) {
    if (jobs === null) {
      L.push(`| ${name} | không đọc được (role thiếu quyền job_runs) | — |`);
      continue;
    }
    const [ts, ok] = jobs[job] ?? [null, null];
    L.push(
      `| ${name} | ${ts ? fmtVn(ts) : 'chưa chạy'} | ${ts === null ? '—' : ok ? 'ok' : 'lỗi'} |`,
    );
  }
  L.push('', '| Agent | Loại việc | Mục chờ duyệt |', '|---|---|---|');
  const pend = [...(cat.pending ?? [])].sort((a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]));
  const rows: string[] = [];
  for (const [pre, , name] of CATALOG_AGENTS) {
    for (const [p, ot, raw] of pend) {
      if (p !== pre) continue;
      const ids = [...raw].sort((a, b) => a - b);
      const lb = Object.hasOwn(types, ot) ? (types[ot] as { label: string }).label : 'loại khác';
      rows.push(`| ${name} | ${lb} | ${ids.length} — ${ids50(ids)} |`);
    }
  }
  return [...L, ...(rows.length ? rows : ['| — | — | 0 |'])];
}

export function bulletinName(kind: string, start: Date): string {
  return `sales-director-${kind}-${vnFormat(start, '%Y-%m-%d')}.md`;
}
