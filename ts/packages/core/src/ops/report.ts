import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../paths.js';
import { type Db, dep } from './deps.js';
import { rollingBounds, vnDate } from './period.js';
import { cpSlice } from './py.js';
import { isDbError } from './tx.js';

// Port `agents/report.py` (WS3) — agent báo cáo định kỳ ra FILE markdown (KHÔNG tự gửi) + `writeReport`
// dùng chung cho mọi báo cáo file của tính năng:
// - Ghi atomic (tmp + rename, BYTES utf-8 — không đổi \n thành \r\n).
// - Cổng triển khai (HĐ 6.7): tiền tố báo cáo của tính năng TẮT → `rollout.gateReport` ném, không ghi.
// - Tính năng chạy thử / chờ người duyệt → nhãn "CHẠY THỬ — KHÔNG GỬI" / "CHỜ NGƯỜI DUYỆT — CHƯA GỬI"
//   ngay trong nội dung (.md); ghi xong → sổ `report_outputs` (`rollout.recordReport`, sha = bản có
//   nhãn; `sample=true` = dữ liệu MẪU, không đếm).
// - Báo cáo định kỳ: số liệu DB lõi + convlog, render tất định (không LLM → không cần guardrail).
//   DB down/thiếu bảng → DEGRADED "[chưa nạp — <lỗi>]", vẫn ghi file. Nguồn toàn `sample:` → *(mẫu)*.
//   Số convlog (`collectChat`, `ingest.lead_store`) và mục 5 Marketing (`pipelines.mkt_metrics`) do
//   NHÓM KHÁC port → `generate` nhận hàm thu số qua tham số.

export const REPORTS_DIR = dataPath('reports');
export const DEFAULT_DAYS = 7;
export const RECENT_LEADS = 5;
// Keyword nhật ký vườn đáng chú ý (heuristic rẻ) — chỉ quét `detail`, không quét tên hoạt động.
export const FLAG_KEYS = ['sâu bệnh', 'rệp', 'bệnh', 'chết', 'héo', 'vàng lá', 'nấm', 'dịch'];

type Num = number | string | bigint;
export type Sources = Record<string, Num>;
export type DbReport =
  | { db_ok: false; db_error: string }
  | {
      db_ok: true;
      sales: {
        count: Num;
        revenue: Num;
        prev_count: Num;
        prev_revenue: Num;
        by_channel: [string, Num, Num][];
        by_status: Record<string, Num>;
        top: [string, Num, Num][];
        sources: Sources;
        sample: boolean;
      };
      leads: {
        new: Num;
        prev_new: Num;
        total: Num;
        pending: Num;
        by_intent: Record<string, Num>;
        by_channel: Record<string, Num>;
        recent: [Date, string, string, string | null][];
        sources: Sources;
        sample: boolean;
      };
      farm: {
        count: Num;
        by_plot: Record<string, Num>;
        by_activity: Record<string, Num>;
        flags: [Date, string, string, string | null][];
        plots: Num;
        trees: Num;
        log_sources: Sources;
        plot_sources: Sources;
        sample: boolean;
      };
    };
export type ChatStats = {
  total: number;
  answered: number;
  in_period: number;
  answered_period: number;
  by_channel: Record<'zalo' | 'messenger' | 'streamlit', number>;
  by_channel_period: Record<'zalo' | 'messenger' | 'streamlit', number>;
  bad_ts: number;
  skipped: number;
  excluded_not_live?: number;
};
type Rate = { decided: Num; rejected: Num; pending_end: Num; rate: number | null };
type RateBy = [string | string[], Rate][] | Record<string, Rate>;
type Hours = {
  n: number;
  median_h: number | null;
  p90_h: number | null;
  max_h: number | null;
  bad_ts?: number;
};
export type Marketing =
  | { ok: false; error?: string }
  | {
      ok: true;
      /** khóa (kênh, loại) → số; Python dict khóa tuple → mảng cặp (hoặc object khóa chuỗi). */
      drafts: RateBy;
      drafts_total: Rate;
      drafts_hours: Hours;
      queue: RateBy;
      queue_total: Rate;
      queue_hours: Hours;
      queue_expired: Num;
      by_agent: Record<string, number>;
      guardrail_codes: Record<string, number>;
      channels: {
        week: string;
        rows: {
          channel: string;
          reach: Num | null;
          engagement: Num | null;
          orders: Num | null;
          eng_rate: number | null;
          sample: boolean;
          cancelled?: Num | null;
          cancel_rate?: number | null;
        }[];
      };
    };
export type Report = {
  period: { days: number; since: Date; until: Date };
  generated_at: Date;
  db: DbReport;
  chat: ChatStats;
  marketing: Marketing | null;
};

/** → [since, until_excl] giờ VN (`rollingBounds`). */
export function periodBounds(days: number, until?: string | Date | null): [Date, Date] {
  return rollingBounds(days, until);
}

/** True khi bảng có dòng và MỌI nguồn đều 'sample:*' — section gắn *(mẫu)*. */
export function isSample(sources: Sources): boolean {
  const ks = Object.keys(sources);
  return ks.length > 0 && ks.every((s) => s.startsWith('sample:'));
}

const NOT_CANCELLED = " and status is distinct from 'cancelled'";

async function pairs(db: Db, sql: string, params: unknown[] = []): Promise<Record<string, Num>> {
  const { rows } = await db.query({ text: sql, values: params, rowMode: 'array' });
  return Object.fromEntries(rows.map((r: unknown[]) => [String(r[0]), r[1] as Num]));
}

/** Toàn bộ số liệu DB cho báo cáo. Lỗi DB → {db_ok: false} — caller render "[chưa nạp]". */
export async function collectDb(db: Db, since: Date, until: Date): Promise<DbReport> {
  const p = [since, until];
  const prev = [new Date(since.getTime() - (until.getTime() - since.getTime())), since];
  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query({ text: sql, values: params, rowMode: 'array' })).rows[0] as Num[];
  const all = async (sql: string, params: unknown[] = []) =>
    (await db.query({ text: sql, values: params, rowMode: 'array' })).rows as unknown[][];
  try {
    // v10.1: đơn `cancelled` KHÔNG tính vào Đơn hàng/Doanh thu/kênh/top — chỉ ở dòng Trạng thái.
    const [curCnt, curRev] = await one(
      `select count(*)::int, coalesce(sum(total_vnd),0) from orders where ts >= $1 and ts < $2${NOT_CANCELLED}`,
      p,
    );
    const [prevCnt, prevRev] = await one(
      `select count(*)::int, coalesce(sum(total_vnd),0) from orders where ts >= $1 and ts < $2${NOT_CANCELLED}`,
      prev,
    );
    const byChannel = (await all(
      `select channel, count(*)::int, coalesce(sum(total_vnd),0) from orders where ts >= $1 and ts < $2${NOT_CANCELLED} group by channel order by 2 desc`,
      p,
    )) as [string, Num, Num][];
    const byStatus = await pairs(
      db,
      'select status, count(*)::int from orders where ts >= $1 and ts < $2 group by status',
      p,
    );
    const top = (await all(
      "select coalesce(p.name, 'Ngoài catalog'), coalesce(sum(o.qty),0), coalesce(sum(o.total_vnd),0) from orders o left join products p on p.id = o.product_id where o.ts >= $1 and o.ts < $2 and o.status is distinct from 'cancelled' group by 1 order by 3 desc limit 5",
      p,
    )) as [string, Num, Num][];
    const orderSources = await pairs(
      db,
      'select source, count(*)::int from orders group by source',
    );
    const [leadNew] = await one('select count(*)::int from leads where ts >= $1 and ts < $2', p);
    const [leadPrev] = await one(
      'select count(*)::int from leads where ts >= $1 and ts < $2',
      prev,
    );
    const [leadTotal] = await one('select count(*)::int from leads');
    const [leadPending] = await one("select count(*)::int from leads where status = 'new'");
    const leadIntent = await pairs(
      db,
      'select intent, count(*)::int from leads where ts >= $1 and ts < $2 group by intent',
      p,
    );
    const leadChannel = await pairs(
      db,
      'select channel, count(*)::int from leads where ts >= $1 and ts < $2 group by channel',
      p,
    );
    const leadRecent = (await all(
      'select ts, channel, intent, question from leads where ts >= $1 and ts < $2 order by ts desc limit $3',
      [since, until, RECENT_LEADS],
    )) as [Date, string, string, string | null][];
    const leadSources = await pairs(db, 'select source, count(*)::int from leads group by source');
    const [logCnt] = await one('select count(*)::int from plot_logs where ts >= $1 and ts < $2', p);
    const byPlot = await pairs(
      db,
      'select plot_id, count(*)::int from plot_logs where ts >= $1 and ts < $2 group by plot_id order by 2 desc',
      p,
    );
    const byActivity = await pairs(
      db,
      'select activity, count(*)::int from plot_logs where ts >= $1 and ts < $2 group by activity order by 2 desc',
      p,
    );
    const logRows = (await all(
      'select ts, plot_id, activity, detail from plot_logs where ts >= $1 and ts < $2 order by ts',
      p,
    )) as [Date, string, string, string | null][];
    const [plotCnt, treeCnt] = await one(
      "select count(*)::int, coalesce(sum(tree_count),0) from plots where status = 'active'",
    );
    const logSources = await pairs(
      db,
      'select source, count(*)::int from plot_logs group by source',
    );
    const plotSources = await pairs(db, 'select source, count(*)::int from plots group by source');
    // Flag chỉ quét detail — tên hoạt động 'kiểm tra sâu bệnh' tự chứa 'sâu bệnh'.
    const flags = logRows.filter(([, , , d]) =>
      FLAG_KEYS.some((k) =>
        String(d ?? '')
          .toLowerCase()
          .includes(k),
      ),
    );
    return {
      db_ok: true,
      sales: {
        count: curCnt!,
        revenue: curRev!,
        prev_count: prevCnt!,
        prev_revenue: prevRev!,
        by_channel: byChannel,
        by_status: byStatus,
        top,
        sources: orderSources,
        sample: isSample(orderSources),
      },
      leads: {
        new: leadNew!,
        prev_new: leadPrev!,
        total: leadTotal!,
        pending: leadPending!,
        by_intent: leadIntent,
        by_channel: leadChannel,
        recent: leadRecent,
        sources: leadSources,
        sample: isSample(leadSources),
      },
      farm: {
        count: logCnt!,
        by_plot: byPlot,
        by_activity: byActivity,
        flags,
        plots: plotCnt!,
        trees: treeCnt!,
        log_sources: logSources,
        plot_sources: plotSources,
        sample: isSample({ ...logSources, ...plotSources }),
      },
    };
  } catch (e) {
    if (!isDbError(e)) throw e;
    return { db_ok: false, db_error: cpSlice(String(e.message).trim(), 0, 300) };
  }
}

/** 8820000 → '8.820.000 ₫' (kiểu VN, cắt phần lẻ như `int()`); null → '—'. */
export function fmtVnd(v: Num | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${group(v)} ₫`;
}

function group(v: Num): string {
  const s = typeof v === 'number' ? String(Math.trunc(v)) : String(v).split('.')[0]!;
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, '');
  const g = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return neg && digits !== '0' ? `-${g}` : g;
}

function dbErr(db: DbReport): string {
  const err = ('db_error' in db && db.db_error) || 'không rõ lỗi';
  if (err.includes('does not exist') || err.includes('UndefinedTable')) {
    return `${err} — thiếu bảng, chạy \`apply_schema\` + loader`;
  }
  return err;
}

const mark = (flag: boolean) => (flag ? ' *(mẫu)*' : '');
const kv = (d: Record<string, Num>) =>
  Object.keys(d)
    .sort()
    .map((k) => `${k}=${d[k]}`)
    .join(', ');

function srcLine(table: string, sources: Sources): string {
  const ks = Object.keys(sources);
  if (!ks.length) return `- \`${table}\`: 0 row`;
  const total = ks.reduce((a, k) => a + Number(sources[k]), 0);
  return `- \`${table}\`: ${total} row — ${kv(sources)}${mark(isSample(sources))}`;
}

/** Python `round(x)` (làm tròn về số chẵn). */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python `str(float)` cho số đã `round(…, 1)` (40.0 → "40.0"). */
function pyFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

const NO_DATA = '[chưa có dữ liệu]';
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${pyFloat(v)}%`;
const cellNum = (v: Num | null | undefined) =>
  v === null || v === undefined ? NO_DATA : String(v);
const pyKeyStr = (k: string | string[]) =>
  Array.isArray(k) ? `(${k.map((x) => `'${x}'`).join(', ')})` : k;

function rateRows(by: RateBy, total: Rate, head: string): string[] {
  const L = [
    `| ${head} | Trả lại / Đã quyết | Tỷ lệ trả lại | Còn chờ cuối kỳ |`,
    '|---|---|---|---|',
  ];
  const sorted = (Array.isArray(by) ? [...by] : Object.entries(by)).sort(([a], [b]) =>
    pyKeyStr(a) < pyKeyStr(b) ? -1 : pyKeyStr(a) > pyKeyStr(b) ? 1 : 0,
  );
  for (const [key, b] of sorted) {
    const name = Array.isArray(key) ? key.join(' · ') : key;
    L.push(`| ${name} | ${b.rejected}/${b.decided} | ${pct(b.rate)} | ${b.pending_end} |`);
  }
  L.push(
    `| **Tổng** | ${total.rejected}/${total.decided} | ${pct(total.rate)} | ${total.pending_end} |`,
  );
  return L;
}

function hoursLine(label: string, h: Hours): string {
  let line = !h.n
    ? `- ${label}: ${NO_DATA}`
    : `- ${label}: trung vị ${pyFloat(h.median_h as number)} giờ · p90 ${pyFloat(h.p90_h as number)} giờ · lâu nhất ${pyFloat(h.max_h as number)} giờ (n=${h.n})`;
  if (h.bad_ts) line += ` — loại ${h.bad_ts} mục mốc thời gian hỏng`;
  return line;
}

function counts(d: Record<string, number>): string {
  return Object.entries(d)
    .sort(([ka, va], [kb, vb]) => vb - va || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([k, v]) => `\`${k.replaceAll('`', "'")}\` ${v}`)
    .join(' · ');
}

/** Mục 5 — mọi số lấy từ `m` (code tính, không LLM). */
export function renderMarketing(m: Marketing | null | undefined): string[] {
  const L = ['## 5. Marketing', ''];
  if (!m || !m.ok) {
    const err = m && 'error' in m ? m.error : null;
    return [...L, `*[chưa nạp — ${err || 'chưa thu số marketing'}]*`, ''];
  }
  L.push(
    '**Tỷ lệ nháp bị trả lại** (nháp nội dung có quyết định trong kỳ; nháp còn chờ không vào mẫu số):',
    '',
    ...rateRows(m.drafts, m.drafts_total, 'Kênh · Loại'),
    '',
    '**Hàng chờ khối marketing** (theo loại việc):',
    '',
    ...rateRows(m.queue, m.queue_total, 'Loại việc'),
    '',
    `- Hết hạn không ai duyệt (không tính trả lại): ${m.queue_expired}`,
    '',
    '**Thời gian duyệt** (giờ, tạo → quyết định):',
    hoursLine('Nháp nội dung', m.drafts_hours),
    hoursLine('Hàng chờ khối marketing', m.queue_hours),
    '',
    `- Nháp tạo trong kỳ theo agent/người: ${counts(m.by_agent) || 'không có'}`,
    `- Vi phạm guardrail theo code (nháp tạo trong kỳ): ${counts(m.guardrail_codes) || 'không có'}`,
  );
  const ch = m.channels;
  L.push('', `**Hiệu quả kênh — tuần ${ch.week}** (số xuất tay \`manual_export\`):`, '');
  if (!ch.rows.length) {
    L.push(
      `- ${NO_DATA} — chưa nạp số kênh tuần này (\`python -m pipelines.cockpit --import FILE --by ...\`)`,
    );
  } else {
    L.push(
      '| Kênh | Tiếp cận | Tương tác | Đơn hoàn thành | Tỷ lệ tương tác | Đơn hủy | Tỷ lệ hủy |',
      '|---|---|---|---|---|---|---|',
    );
    for (const r of ch.rows) {
      const name = r.channel + (r.sample ? ' (MẪU)' : '');
      const er = r.eng_rate === null ? NO_DATA : `${pyFloat(r.eng_rate)}%`;
      const cr =
        r.cancel_rate === null || r.cancel_rate === undefined
          ? NO_DATA
          : `${pyFloat(r.cancel_rate)}%`;
      L.push(
        `| ${name} | ${cellNum(r.reach)} | ${cellNum(r.engagement)} | ${cellNum(r.orders)} | ${er} | ${cellNum(r.cancelled)} | ${cr} |`,
      );
    }
  }
  L.push('- Search Console/GA4, số kênh thật — chờ bàn giao (external-dep).', '');
  return L;
}

/** rep → markdown. Degraded (db_ok=false) → phần DB '[chưa nạp — <err>]', convlog vẫn đủ. */
export function render(rep: Report): string {
  const p = rep.period;
  const sinceS = vnDate(p.since);
  const endS = vnDate(new Date(p.until.getTime() - 1000));
  const genS = `${rep.generated_at.toISOString().slice(0, 19)}Z`;
  const db = rep.db;
  const chat = rep.chat;
  const L = [
    '# Báo cáo định kỳ — Sâm Sâm AI',
    '',
    `**Kỳ:** ${sinceS} → ${endS} (${p.days} ngày, giờ VN) · **Sinh lúc:** ${genS} · **Nguồn:** \`agents/report.py\``,
    '',
    '> **BẢN NHÁP — người duyệt trước khi gửi lãnh đạo.** Hệ thống KHÔNG tự gửi Zalo/email (human-gate C2.4). Mục *(mẫu)* = dữ liệu mẫu chờ công ty bàn giao (SOW §5.2), không phải số vận hành thật.',
    '',
  ];
  // --- 1. Bán hàng
  const sales = db.db_ok ? db.sales : null;
  L.push(`## 1. Bán hàng${mark(Boolean(sales?.sample))}`, '');
  if (sales === null) L.push(`*[chưa nạp — ${dbErr(db)}]*`, '');
  else {
    L.push(
      '| Chỉ số | Kỳ này | Kỳ trước |',
      '|---|---|---|',
      `| Đơn hàng | ${sales.count} | ${sales.prev_count} |`,
      `| Doanh thu | ${fmtVnd(sales.revenue)} | ${fmtVnd(sales.prev_revenue)} |`,
      '',
    );
    if (sales.by_channel.length) {
      L.push(
        `- Theo kênh: ${sales.by_channel.map(([ch, n, rev]) => `${ch} ${n} đơn / ${fmtVnd(rev)}`).join(' · ')}`,
      );
    }
    if (Object.keys(sales.by_status).length) L.push(`- Trạng thái: ${kv(sales.by_status)}`);
    if (sales.top.length) {
      L.push(
        `- Top doanh thu: ${sales.top.map(([n, q, rev]) => `${n} (${q} sp / ${fmtVnd(rev)})`).join('; ')}`,
      );
    }
    if (Number(sales.by_status.cancelled ?? 0))
      L.push('- Đơn `cancelled` không tính vào Đơn hàng/Doanh thu.');
    if (Object.keys(sales.sources).some((s) => s.startsWith('market:'))) {
      L.push(
        '- Đơn sàn (nạp từ file Seller Center): ngày đơn = ngày nạp file (giả định — file sàn chưa map ngày đặt).',
      );
    }
    if (Number(sales.count) === 0) L.push('- Không có đơn nào trong kỳ.');
    L.push('');
  }
  // --- 2. Leads
  const leads = db.db_ok ? db.leads : null;
  L.push(`## 2. Leads (kênh chat)${mark(Boolean(leads?.sample))}`, '');
  if (leads === null) L.push(`*[chưa nạp — ${dbErr(db)}]*`, '');
  else {
    L.push(
      `- Mới trong kỳ: **${leads.new}** (kỳ trước: ${leads.prev_new}) · Tổng: ${leads.total} · **Chờ xử lý (new): ${leads.pending}**`,
    );
    if (Object.keys(leads.by_intent).length) L.push(`- Intent: ${kv(leads.by_intent)}`);
    if (Object.keys(leads.by_channel).length) L.push(`- Kênh: ${kv(leads.by_channel)}`);
    if (leads.recent.length) {
      L.push('- Câu hỏi mới nhất trong kỳ:');
      for (const [ts, ch, intent, q] of leads.recent) {
        L.push(`  - \`${vnDate(ts)}\` [${ch}/${intent}] ${cpSlice(q || '', 0, 120)}`);
      }
    }
    L.push('');
  }
  // --- 3. Kênh chat (convlog — luôn có)
  const rateP = chat.in_period ? `${pyRound((100 * chat.answered_period) / chat.in_period)}%` : '—';
  const rateT = chat.total ? `${pyRound((100 * chat.answered) / chat.total)}%` : '—';
  const bp = chat.by_channel_period;
  L.push(
    '## 3. Kênh chat (convlog)',
    '',
    `- Tin nhắn trong kỳ: **${chat.in_period}** — tỉ lệ trả lời được: ${rateP} (${chat.answered_period}/${chat.in_period})`,
    `- Toàn thời gian: ${chat.total} tin, trả lời ${rateT} — Zalo/Messenger/Streamlit trong kỳ: ${bp.zalo}/${bp.messenger}/${bp.streamlit}`,
  );
  if (chat.skipped || chat.bad_ts) {
    L.push(
      `- Bỏ qua ${chat.skipped} dòng corrupt/_doc/io-error; ${chat.bad_ts} dòng ts hỏng (không tính vào kỳ)`,
    );
  }
  L.push('');
  // --- 4. Vùng trồng
  const farm = db.db_ok ? db.farm : null;
  L.push(`## 4. Vùng trồng${mark(Boolean(farm?.sample))}`, '');
  if (farm === null) L.push(`*[chưa nạp — ${dbErr(db)}]*`, '');
  else {
    L.push(
      `- Đang quản: ${farm.plots} khoảnh (≈${group(farm.trees)} cây)`,
      `- Nhật ký trong kỳ: **${farm.count}** hoạt động`,
    );
    const ins = (d: Record<string, Num>) =>
      Object.entries(d)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    if (Object.keys(farm.by_plot).length) L.push(`  - Theo khoảnh: ${ins(farm.by_plot)}`);
    if (Object.keys(farm.by_activity).length)
      L.push(`  - Theo hoạt động: ${ins(farm.by_activity)}`);
    for (const [ts, plot, act, detail] of farm.flags) {
      L.push(
        `- ⚠️ Cần chú ý: \`${vnDate(ts)}\` ${plot} — ${act}${detail ? `: ${cpSlice(detail, 0, 120)}` : ''}`,
      );
    }
    if (Number(farm.count) === 0) L.push('- Không có nhật ký nào trong kỳ.');
    L.push('');
  }
  // --- 5. Marketing
  L.push(...renderMarketing(rep.marketing));
  // --- 6. Nguồn dữ liệu
  L.push('## 6. Nguồn dữ liệu', '');
  if (db.db_ok) {
    L.push(
      srcLine('orders', db.sales.sources),
      srcLine('leads', db.leads.sources),
      srcLine('plot_logs', db.farm.log_sources),
      srcLine('plots', db.farm.plot_sources),
    );
  } else L.push(`- **DB:** không khả dụng — ${dbErr(db)}`);
  L.push(
    `- \`conversations.jsonl\`: ${chat.total} record (+${chat.skipped} bỏ qua)`,
    '- Mục Marketing: `content_drafts` (quyết định theo `reviewed_at`), `approval_queue` khối marketing (theo `decided_at`), `channel_snapshots` (manual_export, tuần đã đóng)',
    '',
    '---',
    '*Sinh tự động bởi agent báo cáo định kỳ (`python -m agents.report`). Kiểm chứng số liệu trước khi trích dẫn ra ngoài.*',
    '',
  );
  return L.join('\n');
}

/** `report-<since>_<end>.md` — tất định theo kỳ (chạy lại cùng kỳ → ghi đè). */
export function reportName(since: Date, until: Date): string {
  return `report-${vnDate(since)}_${vnDate(new Date(until.getTime() - 1000))}.md`;
}

/**
 * Ghi báo cáo file của tính năng → đường dẫn. Atomic tmp + rename, BYTES utf-8. Cổng TẮT → lỗi của
 * rollout nổi lên, không ghi. `sample` truyền tường minh theo provenance; `feature` = mã tính năng
 * khi tiền tố tên không thuộc `output_sources` (ceo-<kỳ>.md, hdtv-<kỳ>.md).
 */
export async function writeReport(
  text: string,
  outDir: string,
  name: string,
  sample: boolean | null = null,
  feature: string | null = null,
): Promise<string> {
  const ro = dep('rollout');
  const md = await ro.gateReport(name, feature);
  const body = ro.labelReport(name, text, md, feature);
  mkdirSync(outDir, { recursive: true });
  const final = join(outDir, name);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, Buffer.from(body, 'utf8'));
  renameSync(tmp, final);
  await ro.recordReport(name, body, sample, feature);
  return final;
}

/** Provenance báo cáo xuất từ 1 mục hàng duyệt = cờ `is_sample`; lỗi/không có → true (fail-closed). */
export async function queueSample(db: Db, qid: unknown): Promise<boolean> {
  try {
    const { rows } = await db.query('select is_sample from approval_queue where id = $1', [
      String(qid),
    ]);
    return rows[0] ? Boolean(rows[0].is_sample) : true;
  } catch {
    return true;
  }
}

/** Báo cáo định kỳ có mục dựng trên `sample:` hoặc DB không khả dụng → true. */
export function repSample(rep: Pick<Report, 'db'>): boolean {
  const db = rep.db;
  if (!db?.db_ok) return true;
  return db.sales.sample || db.leads.sample || db.farm.sample;
}

/** Báo cáo đã sinh, mới nhất trước (tên chứa kỳ → sắp tên giảm dần). */
export function listReports(outDir: string = REPORTS_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^report-.*\.md$/.test(n))
    .sort()
    .reverse()
    .map((n) => join(outDir, n));
}

export type Collectors = {
  /** `agents.report.collect_chat` (đọc convlog — port ở nhóm leads). */
  chat: (since: Date, until: Date) => ChatStats | Promise<ChatStats>;
  /** `pipelines.mkt_metrics.collect` (port ở nhóm marketing). */
  marketing: (db: Db, since: Date, until: Date) => Promise<Marketing>;
};

/** Mục 5: db null / lỗi DB → {ok: false} — chỉ mục 5 degraded. */
export async function collectMarketing(
  db: Db | null,
  since: Date,
  until: Date,
  collect: Collectors['marketing'],
): Promise<Marketing> {
  if (db === null) return { ok: false, error: 'không kết nối được Postgres' };
  try {
    return await collect(db, since, until);
  } catch (e) {
    if (!isDbError(e)) throw e;
    return { ok: false, error: cpSlice(String(e.message).trim(), 0, 300) };
  }
}

/** collect → render → ghi file → [path, rep]. `db` null = DB down → báo cáo degraded. */
export async function generate(opts: {
  days?: number;
  until?: string | Date | null;
  outDir?: string;
  db: Db | null;
  collectors: Collectors;
  now?: Date;
}): Promise<[string, Report]> {
  const days = opts.days ?? DEFAULT_DAYS;
  const [since, until] = periodBounds(days, opts.until ?? null);
  const dbRep: DbReport =
    opts.db !== null
      ? await collectDb(opts.db, since, until)
      : {
          db_ok: false,
          db_error: 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)',
        };
  const rep: Report = {
    period: { days, since, until },
    generated_at: opts.now ?? new Date(),
    db: dbRep,
    marketing: await collectMarketing(opts.db, since, until, opts.collectors.marketing),
    chat: await opts.collectors.chat(since, until),
  };
  const path = await writeReport(
    render(rep),
    opts.outDir ?? REPORTS_DIR,
    reportName(since, until),
    repSample(rep),
  );
  return [path, rep];
}

/** Dòng topline CLI như `python -m agents.report`. */
export function toplineLines(path: string, rep: Report): string[] {
  const p = rep.period;
  const m = rep.marketing;
  const traLai = m?.ok
    ? `tra-lai=${m.drafts_total.rejected}/${m.drafts_total.decided}`
    : 'tra-lai=[chưa nạp]';
  const out = [
    `[report] kỳ ${vnDate(p.since)} → ${vnDate(new Date(p.until.getTime() - 1000))} (${p.days} ngày)`,
  ];
  const db = rep.db;
  if (!db.db_ok) {
    out.push(`[warn] DB không khả dụng — báo cáo degraded: ${dbErr(db)}`);
    out.push(`[done] ${path} — convlog trong kỳ ${rep.chat.in_period} ${traLai}`);
    return out;
  }
  out.push(
    `[done] ${path} — đơn=${db.sales.count} doanh-thu=${fmtVnd(db.sales.revenue)} leads-mới=${db.leads.new} nhật-ký=${db.farm.count} convlog-kỳ=${rep.chat.in_period} ${traLai}`,
  );
  return out;
}
