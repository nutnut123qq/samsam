import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, loadConfig, submit } from '@samsam/core/ops/director';
import { addDays, vnDate, vnFormat, weekday } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { oneline } from '@samsam/core/ops/store';
import { maskPii } from '@samsam/core/security/pii';
import { weekStart } from '../sales_director/kd-forecast.deps.js';
import {
  type Campaign,
  capFor,
  type Day,
  fmt,
  MILESTONE_VN,
  MILESTONES,
  type Plan,
  type Quota,
  REASON_ALCOHOL,
} from './mkt-calendar.js';

// Port `agents/mkt_director.py` — MKT-00 Agent GĐ Marketing (v6.0, WP08): điều phối + cân tải duyệt.
// TẤT ĐỊNH, KHÔNG LLM. Brief chiến dịch vào hàng duyệt (KHÔNG tự duyệt), dự báo tải duyệt/ngày so
// quota → cảnh báo + ĐỀ XUẤT dời (KHÔNG tự dời lịch), bản tin tuần BẢN NHÁP (không tự gửi). Không
// agent nào đăng bài, hẹn lịch đăng, sinh nháp hay chi tiền.

export const BLOCK = 'marketing';
export const OBJECT_TYPE = 'campaign_brief';
export const AGENT = 'agent:MKT-00';
export const FEATURE = 'marketing-01.2';
export const SOURCES = 'data/marketing_calendar.json + data/golden_skus.json';
export const NO_AUTO = 'Chỉ đề xuất — lịch không bị dời tự động';
export const FOOTER =
  'Agent không duyệt, không đăng, không chi tiền — quyết định thuộc GĐ Marketing';
export const DB_MISSING = 'nguồn DB thiếu';
const WD = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const EXISTING_SQL =
  "select 1 from approval_queue where object_type = $1 and object_id = $2 and status in ('pending', 'approved', 'rejected') limit 1";
// Chỉ cột metadata (agent_writer không được đọc payload — least privilege): mục pending của khối +
// brief chiến dịch đã quyết (để biết đã có brief).
const QUEUE_SQL =
  "select id, object_type, object_id, title, status, due_at, is_sample from approval_queue where block = $1 and (status = 'pending' or (object_type = $2 and status in ('approved', 'rejected'))) order by due_at, id";

const vn = (ts: Date): string => vnFormat(ts, '%d/%m/%Y %H:%M');
const dm = (d: Day): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dmy = (d: Day): string => `${dm(d)}/${d.slice(0, 4)}`;

/** Brief tất định (không LLM). SKU rượu KHÔNG nêu tên (brief đi qua guardrail khi vào hàng — chỉ
 * đếm); danh sách đủ nằm ở bản tin GĐ. */
export function briefText(c: Campaign, status = ''): string {
  const m = c.milestones;
  const L = [
    `Brief chiến dịch ${c.id} — sự kiện ${c.event}`,
    `Trụ nội dung: ${c.pillar}`,
    `Ngày đăng: ${dmy(c.publish_day)}`,
    '',
    'Mốc (giờ VN):',
    ...MILESTONES.map((k) => `- ${MILESTONE_VN[k]}: ${vn(m[k])}`),
    '',
    'Ô kênh × định dạng:',
  ];
  for (const cell of c.cells) {
    L.push(
      `- ${cell.channel} / ${cell.format}: ${cell.skus.length ? cell.skus.join(', ') : cell.note}`,
    );
  }
  if (!c.cells.length) L.push('- (không còn ô nào đủ điều kiện)');
  const shown = c.blocked.filter((b) => b.reason !== REASON_ALCOHOL);
  const nOff = new Set(c.blocked.filter((b) => b.reason === REASON_ALCOHOL).map((b) => b.sku_key))
    .size;
  L.push('', 'SKU bị chặn kênh:');
  const seen = new Map<string, [string, string, string, string[]]>();
  for (const b of shown) {
    const k = JSON.stringify([b.sku_key, b.channel, b.reason]);
    const e = seen.get(k);
    if (e) e[3].push(b.format);
    else seen.set(k, [b.sku_key, b.channel, b.reason, [b.format]]);
  }
  for (const [k, ch, why, fm] of seen.values()) L.push(`- ${k} / ${ch} (${fm.join(', ')}): ${why}`);
  if (nOff) {
    L.push(
      `- ${nOff} SKU chỉ bán offline (luật kênh) — không đưa vào kênh online; chi tiết trong bản tin GĐ Marketing`,
    );
  }
  if (!shown.length && !nOff) L.push('- (không có)');
  L.push(
    '',
    `Nguồn: ${SOURCES}${status ? ` (${status})` : ''}`,
    'Lịch ĐỀ XUẤT — GĐ Marketing duyệt brief trước khi soạn nháp.',
  );
  return L.join('\n');
}

const isUnique = (e: unknown) => (e as { code?: unknown })?.code === '23505';

export type BriefRes = {
  enqueued: { id: string; queue_id: bigint }[];
  skipped: { id: string; reason: string }[];
};

/** Đẩy brief chiến dịch sắp tới (đăng > now, brief ≤ now + horizon) vào hàng duyệt — KHÔNG duyệt.
 * Idempotent: đã có pending/approved/rejected cùng `object_id` → bỏ qua. */
export async function enqueueBriefs(
  db: Db,
  plan: Plan,
  now: Date,
  horizonDays = 14,
  cfg?: DirectorConfig,
  d: { submit?: typeof submit } = {},
): Promise<BriefRes> {
  const c0 = cfg ?? loadConfig(BLOCK);
  const limit = now.getTime() + horizonDays * 86_400_000;
  const out: BriefRes = { enqueued: [], skipped: [] };
  for (const c of plan.campaigns) {
    const m = c.milestones;
    if (!(m.publish > now && m.brief.getTime() <= limit)) continue;
    if ((await db.query(EXISTING_SQL, [OBJECT_TYPE, c.id])).rows.length) {
      out.skipped.push({ id: c.id, reason: 'đã có trong hàng' });
      continue;
    }
    try {
      const qid = await (d.submit ?? submit)(db, {
        block: BLOCK,
        objectType: OBJECT_TYPE,
        objectId: c.id,
        title: `Brief chiến dịch ${c.id} — đăng ${dmy(c.publish_day)}`,
        payload: briefText(c, plan.status ?? ''),
        createdBy: AGENT,
        cfg: c0,
      });
      out.enqueued.push({ id: c.id, queue_id: qid });
    } catch (e) {
      // Đua với tiến trình khác — index pending_uq là chốt cuối.
      if (!isUnique(e)) throw e;
      out.skipped.push({ id: c.id, reason: 'đã có (đua)' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- cân tải

type Role = 'phap_che' | 'gd_marketing';
export type LoadDay = {
  day: Day;
  phap_che: number;
  gd_marketing: number;
  cap_phap_che: number | null;
  cap_gd: number;
};
export type Forecast = { days: LoadDay[]; warnings: string[]; suggestions: string[] };

function count(plan: Plan): [Map<Day, number>, Map<Day, number>, Map<string, [string, number][]>] {
  const pc = new Map<Day, number>();
  const gd = new Map<Day, number>();
  const who = new Map<string, [string, number][]>();
  const add = (k: string, v: [string, number]) => {
    const a = who.get(k);
    if (a) a.push(v);
    else who.set(k, [v]);
  };
  for (const c of plan.campaigns) {
    const n = c.cells.length;
    if (n) {
      const d = vnDate(c.milestones.approve);
      pc.set(d, (pc.get(d) ?? 0) + n);
      add(`phap_che|${d}`, [c.id, n]);
    }
    const d = vnDate(c.milestones.draft);
    gd.set(d, (gd.get(d) ?? 0) + 1);
    add(`gd_marketing|${d}`, [c.id, 1]);
  }
  return [pc, gd, who];
}

/** THUẦN: tải duyệt dự báo/ngày vs trần → cảnh báo + ĐỀ XUẤT dời (không sửa `plan`, không ghi). */
export function forecastLoad(
  plan: Plan,
  quota: Quota,
  gdCap: number,
  start: Day,
  days: number,
): Forecast {
  const [pc, gd, who] = count(plan);
  const nw = new Set(plan.non_working_days ?? []);
  const cap = (role: Role, d: Day) => (role === 'phap_che' ? capFor(d, quota) : gdCap);
  const load: Record<Role, Map<Day, number>> = { phap_che: pc, gd_marketing: gd };
  const moved: Record<Role, Map<Day, number>> = { phap_che: new Map(), gd_marketing: new Map() };
  const rows: LoadDay[] = [];
  const warns: string[] = [];
  const sugg: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    rows.push({
      day: d,
      phap_che: pc.get(d) ?? 0,
      gd_marketing: gd.get(d) ?? 0,
      cap_phap_che: capFor(d, quota),
      cap_gd: gdCap,
    });
    for (const role of ['phap_che', 'gd_marketing'] as const) {
      const n = load[role].get(d) ?? 0;
      const c = cap(role, d);
      if (n === 0) continue;
      if (c === null) {
        warns.push(`KHÔNG CÓ QUOTA ${role} ${d}: ${n} mục — không phase quota nào phủ ngày này`);
        continue;
      }
      if (n <= c) continue;
      warns.push(`VƯỢT QUOTA ${role} ${d}: ${n} mục > trần ${c}`);
      let excess = n - c;
      const cands = [...(who.get(`${role}|${d}`) ?? [])].sort(
        (a, b) => b[1] - a[1] || cpCmp(a[0], b[0]),
      );
      for (const [cid, k] of cands) {
        if (excess <= 0) break;
        let target: Day | null = null;
        for (let back = 1; back < 8; back++) {
          const t = addDays(d, -back);
          if (t < start || weekday(t) >= 5 || nw.has(t)) continue;
          const tc = cap(role, t);
          const used = (load[role].get(t) ?? 0) + (moved[role].get(t) ?? 0);
          if (tc !== null && used + k <= tc) {
            target = t;
            break;
          }
        }
        const label = role === 'phap_che' ? 'mốc duyệt' : 'mốc duyệt brief';
        if (target === null) {
          sugg.push(
            `ĐỀ XUẤT giảm số ô của ${cid} (${role} ${d}) — không còn ngày trống trong 7 ngày trước — GĐ Marketing quyết`,
          );
        } else {
          moved[role].set(target, (moved[role].get(target) ?? 0) + k);
          sugg.push(`ĐỀ XUẤT dời ${label} ${cid} sang ${target} (${role}) — GĐ Marketing quyết`);
        }
        excess -= k;
      }
    }
  }
  return { days: rows, warnings: warns, suggestions: sugg };
}

export function renderLoad(fc: Forecast): string {
  const L = ['| ngày | Pháp chế | trần | GĐ Marketing | trần |', '|---|---|---|---|---|'];
  for (const r of fc.days) {
    const cp = r.cap_phap_che === null ? '—' : r.cap_phap_che;
    L.push(
      `| ${WD[weekday(r.day)]} ${dm(r.day)} | ${r.phap_che} | ${cp} | ${r.gd_marketing} | ${r.cap_gd} |`,
    );
  }
  L.push('', 'Cảnh báo:');
  L.push(...(fc.warnings.length ? fc.warnings.map((w) => `- ${w}`) : ['- (không có)']));
  L.push('', 'Đề xuất:');
  L.push(...(fc.suggestions.length ? fc.suggestions.map((s) => `- ${s}`) : ['- (không có)']));
  L.push('', `*${NO_AUTO}.*`);
  return L.join('\n');
}

// ---------------------------------------------------------------- bản tin

export type QueueItem = {
  id?: unknown;
  object_type?: string;
  object_id?: string;
  title?: string | null;
  status?: string;
  due_at?: Date | null;
  is_sample?: boolean;
};

/** THUẦN. `items` = mục hàng duyệt khối marketing (pending + brief đã quyết); null = DB không đọc được. */
export function bulletin(plan: Plan, load: Forecast, items: QueueItem[] | null, now: Date): string {
  const today = vnDate(now);
  const wk = weekStart(today);
  const horizon = addDays(today, 28);
  const L = [
    `# Bản tin tuần GĐ Marketing — tuần ${dmy(wk)}`,
    '',
    `Agent: MKT-00 · giờ VN · lịch: ${plan.status} (ĐỀ XUẤT)`,
    '',
    '## 1. Chiến dịch 28 ngày tới',
    '',
  ];
  const upcoming = plan.campaigns.filter((c) => today <= c.publish_day && c.publish_day < horizon);
  if (upcoming.length) {
    L.push(
      '| chiến dịch | sự kiện | ô | brief | nháp | duyệt | đăng |',
      '|---|---|---|---|---|---|---|',
    );
    for (const c of upcoming) {
      const cells = c.cells.map((x) => `${x.channel}/${x.format}`).join(', ') || '—';
      L.push(
        `| ${c.id} | ${c.event} | ${cells} | ${MILESTONES.map((k) => fmt(c.milestones[k])).join(' | ')} |`,
      );
    }
  } else L.push('- (không có)');
  const wkEnd = addDays(wk, 7);
  const rem = plan.reminders.filter((r) => wk <= r.day && r.day < wkEnd);
  L.push('', 'Nhắc mốc trong tuần:');
  L.push(
    ...(rem.length
      ? rem.map((r) => `- còn ${r.days_before} ngày tới \`${r.event}\` (${dm(r.day)})`)
      : ['- (không có)']),
  );
  L.push('', '## 2. Việc trễ hạn', '');
  if (items === null) {
    L.push(`- ${DB_MISSING} — không đọc được hàng duyệt (chạy lại khi DB lên)`);
  } else {
    const late = items.filter((d) => d.status === 'pending' && d.due_at && d.due_at < now);
    for (const d of late) {
      L.push(
        `- #${d.id} \`${d.object_type}\` ${oneline(maskPii(d.title || ''), 80)} — hạn ${vn(d.due_at as Date)}`,
      );
    }
    const has = new Set(items.filter((d) => d.object_type === OBJECT_TYPE).map((d) => d.object_id));
    const miss = plan.campaigns.filter(
      (c) => c.milestones.brief < now && now < c.milestones.publish && !has.has(c.id),
    );
    for (const c of miss) {
      L.push(
        `- chiến dịch ${c.id}: đã qua mốc brief ${fmt(c.milestones.brief)} mà chưa có brief trong hàng duyệt`,
      );
    }
    if (!late.length && !miss.length) L.push('- (không có)');
  }
  L.push('', '## 3. Tải duyệt dự báo vs quota (14 ngày)', '', renderLoad(load));
  L.push('', '## 4. SKU bị chặn kênh', '');
  const agg = new Map<string, [string[], Set<string>]>();
  for (const c of plan.campaigns) {
    for (const b of c.blocked) {
      const key = [b.sku_key, b.channel, b.readiness, b.reason];
      const k = JSON.stringify(key);
      const e = agg.get(k);
      if (e) e[1].add(b.format);
      else agg.set(k, [key, new Set([b.format])]);
    }
  }
  if (agg.size) {
    L.push('| SKU | kênh | readiness | lý do | định dạng |', '|---|---|---|---|---|');
    const sorted = [...agg.values()].sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        const d = cpCmp(a[0][i] as string, b[0][i] as string);
        if (d) return d;
      }
      return 0;
    });
    for (const [[k, ch, r, why], fm] of sorted) {
      L.push(`| ${k} | ${ch} | ${r} | ${why} | ${[...fm].sort(cpCmp).join(', ')} |`);
    }
  } else L.push('- (không có)');
  L.push('', '---', `*${FOOTER}. BẢN NHÁP — hệ thống không tự gửi.*`, '');
  return L.join('\n');
}

/** Mục hàng duyệt khối marketing (chỉ cột metadata). */
export async function queueItems(db: Db): Promise<QueueItem[]> {
  const { rows } = await db.query(QUEUE_SQL, [BLOCK, OBJECT_TYPE]);
  return rows as QueueItem[];
}
