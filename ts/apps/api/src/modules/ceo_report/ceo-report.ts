import { type AiGateway, GatewayError } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { type Db, dep } from '@samsam/core/ops/deps';
import { periodBounds, vnDate, vnFormat } from '@samsam/core/ops/period';
import { cpCmp } from '@samsam/core/ops/py-json';
import { loadRouting, ROUTING } from '@samsam/core/ops/red-alert';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { pgErrName, sp } from '@samsam/core/rollout/counters';
import { casefold, cpHead, cpLen, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  CEO_METRICS,
  closed,
  INTERNAL_CHANNEL,
  loadMetrics,
  type MetricSpec,
  type Metrics,
  metricSpec,
} from './cockpit.js';
import {
  absDec,
  adjusted,
  type Dec,
  dec,
  div,
  fixed,
  group,
  isFiniteDec,
  isIntegral,
  isZero,
  mulInt,
  quantizeHalfUp,
  sign,
  sub,
  toBigInt,
} from './dec.js';
import { isoWeek } from './mkt-metrics.js';

// Port `agents/ceo_report.py` (v8.0 W80.5–W80.7 + v8.1, WP10 — ceo-01) — báo cáo tuần/tháng 1 trang
// cho TGĐ (Agent Điều hành / Chief of Staff AI).
//  - Đọc `channel_snapshots` (do cockpit ghi) của kỳ ĐÃ ĐÓNG + kỳ trước (giờ VN). Cùng (kênh, metric)
//    có cả `manual_export` lẫn `api` → ưu tiên `manual_export`.
//  - MỌI con số do CODE điền từ snapshot; thiếu số → `[chưa có dữ liệu]` (KHÔNG hiện 0). Δ do code
//    tính; đánh giá theo chiều tốt của `data/metrics.json`. Nguồn `sample:` → `(MẪU)`.
//  - Preflight tuyến cảnh báo đỏ (KHÔNG gửi, KHÔNG ghi `red_alerts`): chưa có người nhận độc lập →
//    dòng ĐỎ đầu trang; có → chỉ đếm, không in tên.
//  - NHẬN XÉT: mặc định theo LUẬT (0 lời gọi LLM). `llm` → AI Gateway agent `cockpit` (feature
//    ceo-01), prompt chỉ có metric_id/tên/chiều tốt/xu hướng (KHÔNG số tuyệt đối); LLM chỉ được viết
//    placeholder `{metric_id:nhãn kỳ}`/`{metric_id:delta}`, `ground()` điền số. Văn bản còn chữ số /
//    `%` / trăm-nghìn-triệu-tỷ ngoài placeholder, link/HTML → bị loại, rơi về nhận xét theo luật.
//    GIỚI HẠN (như Python): số viết bằng chữ ("một", "hai"...) chưa bị chặn.
//  - Toàn trang qua guardrail trước khi ghi; không ok → vẫn ghi file kèm dòng cảnh báo đầu trang
//    và KHÔNG nộp duyệt.
//  - v8.1: 3 section do CODE dựng (Sổ quyết định / Rủi ro pháp lý / Audit outside-in — nhóm ceo_misc,
//    nối qua `setCeoSections`) chèn giữa "Thời gian duyệt" và "Nhận xét"; mỗi section đọc trong
//    savepoint, lỗi → 1 dòng "*(không đọc được: …)*", section khác vẫn ra. LLM KHÔNG thấy section.

export const NO_DATA = '[chưa có dữ liệu]';
export const LLM_AGENT = 'cockpit';
export const MAX_COMMENTARY = 1200;
export const FEATURE_WEEK = 'ceo-01'; // r12 G1-L4: báo cáo tuần tự động
const PLACEHOLDER_G = /\{([a-z][a-z0-9_.]{1,63}):([0-9A-Za-z-]{4,8})\}/g;
const NUMWORD_RE = /(?<![\p{L}\p{N}_])(trăm|nghìn|ngàn|triệu|tỷ|tỉ)(?![\p{L}\p{N}_])/u;
// Văn bản LLM vào trang TGĐ: cấm link/HTML/ảnh markdown (A03 — chèn nội dung).
const MARKUP_RE = /https?:|www\.|<[a-z/!]|\]\(|javascript:/iu;
const MAX_ADJ = 17; // |giá trị| < 1e18 — ngoài khoảng/NaN coi như số hỏng
export const RED_LINE =
  '**ĐỎ — chưa có người nhận cảnh báo độc lập** (data/red_alert_routing.json, external-dep: Pháp chế xác nhận)';
const SNAP_SQL =
  'select channel, metric_id, period_start::text as period_start, value::text as value, source, source_ref, captured_at from channel_snapshots where period_kind = $1 and period_start in ($2, $3) order by id';
const DAY_MS = 86_400_000;

/** Một dòng `channel_snapshots` như SELECT trả về (value = văn bản numeric). */
export type SnapIn = {
  channel: string;
  metric_id: string;
  period_start: string;
  value: string;
  source: string;
  source_ref: string | null;
  captured_at: Date | null;
};
export type Snap = {
  value: Dec;
  source: string;
  source_ref: string | null;
  captured_at: Date | null;
};
export type RepRow = {
  metric_id: string;
  channel: string;
  name: string;
  unit: string;
  better: string;
  key: string;
  section: 'ceo' | 'main';
  per_agent: boolean;
  cur: Snap | null;
  prev: Snap | null;
};
export type Rep = {
  kind: string;
  label: string;
  prev_label: string;
  start: Date;
  end: Date;
  prev_start: Date;
  rows: RepRow[];
  ignored: number;
  bad_values: number;
  preflight: { ok: boolean; n: number; problems: number };
  generated_at: Date;
  llm_used: boolean;
  llm_note: string | null;
  guardrail_violations: string[];
  sections: readonly (readonly string[])[] | null;
  commentary: string;
};
type Values = Record<string, Record<string, string>>;

// ---------------------------------------------------------------- định dạng

export function periodLabel(kind: string, start: Date | string): string {
  const d = vnDate(start);
  if (kind === 'week') {
    const [y, w] = isoWeek(d);
    return `${y}-W${String(w).padStart(2, '0')}`;
  }
  return d.slice(0, 7);
}

function decFmt(v: Dec, places: number): string {
  const q = quantizeHalfUp(v, places);
  const [whole, frac] = fixed(absDec(q)).split('.') as [string, string];
  return `${sign(q) < 0 ? '-' : ''}${group(BigInt(whole))},${frac}`;
}

/** Decimal → chuỗi VN (dấu nghìn '.', thập phân ','). */
export function fmtValue(v: Dec, unit: string): string {
  if (unit === 'VND') {
    const n = toBigInt(quantizeHalfUp(v, 0));
    return `${n < 0n ? '-' : ''}${group(n)} đ`;
  }
  if (unit === 'USD') return `${decFmt(v, 2)} USD`;
  if (unit === 'giờ') return `${decFmt(v, 1)} giờ`;
  if (isIntegral(v)) {
    const n = toBigInt(v);
    return `${n < 0n ? '-' : ''}${group(n)} ${unit}`;
  }
  return `${decFmt(v, 2)} ${unit}`;
}

export function fmtDelta(cur: Dec, prev: Dec, unit: string): string {
  const d = sub(cur, prev);
  const sg = sign(d) > 0 ? '+' : sign(d) < 0 ? '-' : '±';
  let out = `${sg}${fmtValue(absDec(d), unit)}`;
  if (!isZero(prev)) {
    const pct = mulInt(div(absDec(d), absDec(prev)), 100n);
    out += ` (${sg}${decFmt(pct, 1)}%)`;
  }
  return out;
}

export function assess(cur: Dec | null, prev: Dec | null, better: string): string {
  if (cur === null || prev === null || better === 'none') return '—';
  const d = sub(cur, prev);
  if (isZero(d)) return 'không đổi';
  return sign(d) > 0 === (better === 'up') ? 'tốt' : 'xấu';
}

export const cell = (s: unknown): string => pyStrip(pyStr(s).replace(/[|`\r\n]+/g, ' '));

const vnDay = (ts: unknown): string =>
  ts instanceof Date && !Number.isNaN(ts.getTime()) ? vnFormat(ts, '%d/%m/%Y') : '—';

// ---------------------------------------------------------------- build

const K = (...xs: string[]) => xs.join('\u0000');

/** → [{(metric, kênh, kỳ): snap}, số giá trị hỏng] — manual_export > api; NaN/khổng lồ bị bỏ + đếm. */
export function pick(snaps: readonly SnapIn[]): [Map<string, Snap>, number] {
  const out = new Map<string, Snap>();
  let bad = 0;
  for (const s of snaps) {
    const v = dec(s.value);
    if (!isFiniteDec(v) || (!isZero(v) && adjusted(v) > MAX_ADJ)) {
      bad++;
      continue;
    }
    const k = K(s.metric_id, s.channel, s.period_start);
    if (out.get(k)?.source === 'manual_export') continue;
    out.set(k, {
      value: v,
      source: s.source,
      source_ref: s.source_ref,
      captured_at: s.captured_at,
    });
  }
  return [out, bad];
}

function buildRows(
  metrics: Metrics,
  picked: Map<string, Snap>,
  curD: string,
  prevD: string,
): [RepRow[], number] {
  const seen = new Map<string, [string, string]>();
  for (const k of picked.keys()) {
    const [m, c] = k.split('\u0000') as [string, string];
    seen.set(K(m, c), [m, c]);
  }
  const rows: RepRow[] = [];
  const used = new Set<string>();
  const add = (mid: string, ch: string, spec: MetricSpec, name: string) => {
    used.add(K(mid, ch));
    rows.push({
      metric_id: mid,
      channel: ch,
      name,
      unit: spec.unit,
      better: spec.better,
      key: ch === INTERNAL_CHANNEL || ch === '—' ? mid : `${mid}.${ch}`,
      section: CEO_METRICS.includes(mid) ? 'ceo' : 'main',
      per_agent: !Object.hasOwn(metrics, mid),
      cur: picked.get(K(mid, ch, curD)) ?? null,
      prev: picked.get(K(mid, ch, prevD)) ?? null,
    });
  };
  const sortedSeen = [...seen.values()].sort(
    ([a1, a2], [b1, b2]) => cpCmp(a1, b1) || cpCmp(a2, b2),
  );
  for (const [mid, spec] of Object.entries(metrics)) {
    if (spec.kind === 'internal') {
      add(mid, INTERNAL_CHANNEL, spec, spec.name);
      if (spec.per_agent) {
        for (const [m2, c2] of sortedSeen) {
          if (
            m2.startsWith(`${mid}.`) &&
            c2 === INTERNAL_CHANNEL &&
            metricSpec(metrics, m2) === spec
          ) {
            add(m2, c2, spec, `${spec.name} — agent ${m2.slice(mid.length + 1)}`);
          }
        }
      }
    } else {
      const chans = spec.channels.filter((c) => seen.has(K(mid, c)));
      for (const c of chans) add(mid, c, spec, spec.name);
      if (!chans.length) add(mid, '—', spec, spec.name);
    }
  }
  let ignored = 0;
  for (const k of seen.keys()) if (!used.has(k)) ignored++;
  return [rows, ignored];
}

export type BuildOpts = {
  now?: Date | null;
  llm?: boolean;
  /** Đường dẫn `red_alert_routing.json` (null = file của repo). */
  routing?: string | null;
  metrics?: Metrics | null;
  sections?: readonly (readonly string[])[] | null;
  /** AI Gateway cho `llm` (thiếu → nhận xét LLM bị loại, rơi về luật). */
  ai?: Pick<AiGateway, 'chat'> | null;
};

/** → rep. Kỳ chưa đóng / kind lạ → RangeError (Python ValueError). Lỗi DB nổi lên caller. */
export async function build(
  db: Db,
  kind: string,
  ref: string | Date,
  o: BuildOpts = {},
): Promise<Rep> {
  if (kind !== 'week' && kind !== 'month') throw new RangeError('kind phải week|month');
  const [start, end] = closed(kind, ref, o.now);
  const [prevStart] = periodBounds(kind, new Date(start.getTime() - DAY_MS));
  const metrics = o.metrics ?? loadMetrics();
  const { rows: snaps } = await db.query(SNAP_SQL, [kind, vnDate(start), vnDate(prevStart)]);
  const [picked, bad] = pick(snaps as SnapIn[]);
  const [rows, ignored] = buildRows(metrics, picked, vnDate(start), vnDate(prevStart));
  const r = loadRouting(o.routing ?? ROUTING);
  const rep: Rep = {
    kind,
    label: periodLabel(kind, start),
    prev_label: periodLabel(kind, prevStart),
    start,
    end,
    prev_start: prevStart,
    rows,
    ignored,
    bad_values: bad,
    preflight: {
      ok: r.recipients.length > 0,
      n: r.recipients.length,
      problems: r.problems.length,
    },
    generated_at: o.now ?? new Date(),
    llm_used: false,
    llm_note: null,
    guardrail_violations: [],
    sections: o.sections ?? null,
    commentary: '',
  };
  if (o.llm) {
    const [text, why] = await llmCommentary(rep, o.ai ?? null);
    if (text === null) rep.llm_note = `Nhận xét LLM bị loại: ${why}`;
    else {
      rep.commentary = text;
      rep.llm_used = true;
    }
  }
  if (!rep.llm_used) rep.commentary = ruleCommentary(rep);
  return rep;
}

// ---------------------------------------------------------------- W80.7

/** {key: {nhãn kỳ này|nhãn kỳ trước|'delta': chuỗi đã định dạng}} — nguồn DUY NHẤT của số nhận xét. */
export function commentaryValues(rep: Rep): Values {
  const out: Values = {};
  for (const row of rep.rows) {
    if (row.per_agent) continue;
    const v: Record<string, string> = {};
    if (row.cur) v[rep.label] = fmtValue(row.cur.value, row.unit);
    if (row.prev) v[rep.prev_label] = fmtValue(row.prev.value, row.unit);
    if (row.cur && row.prev) v.delta = fmtDelta(row.cur.value, row.prev.value, row.unit);
    if (Object.keys(v).length) out[row.key] = v;
  }
  return out;
}

export function hasNumber(text: string): string[] {
  const reasons: string[] = [];
  // Mọi ký tự số Unicode (Nd chữ số, No ¹²½①, Nl Ⅻ).
  if (/\p{N}/u.test(text)) reasons.push('LLM tự viết số (chữ số ngoài placeholder)');
  const t = casefold(text.normalize('NFKC'));
  if (t.includes('%') || t.includes('‰')) {
    reasons.push('LLM tự viết số (ký hiệu % ngoài placeholder)');
  }
  if (NUMWORD_RE.test(t)) reasons.push('LLM tự viết số (trăm/nghìn/triệu/tỷ ngoài placeholder)');
  return reasons;
}

/** Template chỉ có placeholder → [văn bản đã điền số, []] hoặc [null, lý do]. Số CHỈ từ `values`. */
export function ground(
  template: unknown,
  values: Values,
  labels: readonly string[],
): [string | null, string[]] {
  if (typeof template !== 'string' || !pyStrip(template)) return [null, ['nhận xét rỗng']];
  if (cpLen(template) > 4 * MAX_COMMENTARY) {
    return [null, [`nhận xét dài quá ${MAX_COMMENTARY} ký tự`]];
  }
  const t = template.normalize('NFC');
  const allowed = new Set([...labels, 'delta']);
  const reasons: string[] = [];
  for (const m of t.matchAll(PLACEHOLDER_G)) {
    const [, mid, tok] = m as unknown as [string, string, string];
    if (!Object.hasOwn(values, mid)) reasons.push(`placeholder metric lạ/không có số: ${mid}`);
    else if (!allowed.has(tok)) reasons.push(`placeholder kỳ lạ: ${mid}:${tok}`);
    else if (!Object.hasOwn(values[mid] as object, tok)) {
      reasons.push(`placeholder thiếu giá trị: ${mid}:${tok}`);
    }
  }
  const rest = t.replace(PLACEHOLDER_G, ' ');
  reasons.push(...hasNumber(rest));
  if (rest.includes('{') || rest.includes('}')) reasons.push('placeholder sai cú pháp');
  if (MARKUP_RE.test(rest)) reasons.push('chứa link/HTML (không cho chèn vào trang TGĐ)');
  if (reasons.length) return [null, reasons];
  const filled = t.replace(
    PLACEHOLDER_G,
    (_m, mid: string, tok: string) => (values[mid] as Record<string, string>)[tok] as string,
  );
  if (cpLen(filled) > MAX_COMMENTARY) return [null, [`nhận xét dài quá ${MAX_COMMENTARY} ký tự`]];
  const g = dep('guardrailCheck')(filled);
  if (!g.ok) {
    const viols = Array.isArray(g.violations) ? g.violations : [];
    const kinds = [
      ...new Set(
        viols
          .filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
          .map((v) => pyStr((v as Record<string, unknown>).type)),
      ),
    ].sort(cpCmp);
    return [null, [`guardrail không ok (${kinds.join(', ') || '?'})`]];
  }
  return [filled, []];
}

/** Câu template theo luật (TẤT ĐỊNH) cho mọi metric có đủ 2 kỳ. */
export function ruleTemplates(rep: Rep): [string[], Values, [string, string]] {
  const curL = rep.label;
  const prevL = rep.prev_label;
  const values = commentaryValues(rep);
  const tpls: string[] = [];
  for (const row of rep.rows) {
    const k = row.key;
    if (row.per_agent || !Object.hasOwn(values[k] ?? {}, 'delta')) continue;
    const name = row.name + (row.channel === INTERNAL_CHANNEL ? '' : ` (kênh ${row.channel})`);
    if (hasNumber(name).length) continue;
    const cur = (row.cur as Snap).value;
    const prev = (row.prev as Snap).value;
    const d = sub(cur, prev);
    if (isZero(d)) {
      tpls.push(`${name} không đổi ở mức {${k}:${curL}}.`);
      continue;
    }
    const a = assess(cur, prev, row.better);
    const verdict = a === 'tốt' ? 'tốt' : a === 'xấu' ? 'cần xem' : 'để theo dõi';
    // "giảm" là động từ claim công dụng trong guardrail → dùng "hạ".
    const up = sign(d) > 0;
    tpls.push(
      `${name} ${up ? 'tăng' : 'hạ'} từ {${k}:${prevL}} ${up ? 'lên' : 'xuống'} {${k}:${curL}} ({${k}:delta}) — ${verdict}.`,
    );
  }
  return [tpls, values, [curL, prevL]];
}

export function ruleCommentary(rep: Rep): string {
  const [tpls, values, labels] = ruleTemplates(rep);
  const out = tpls.map((t) => {
    const [text, reasons] = ground(t, values, labels);
    return text !== null ? `- ${text}` : `- (câu bị loại: ${reasons.join('; ')})`;
  });
  return out.length ? out.join('\n') : '- Chưa đủ số liệu hai kỳ để so sánh — xem bảng.';
}

const BETTER_VI: Record<string, string> = {
  up: 'tăng là tốt',
  down: 'đi xuống là tốt',
  none: 'chỉ theo dõi',
};

/** Prompt KHÔNG chứa số tuyệt đối — chỉ key/tên/chiều tốt/xu hướng. */
export function llmPrompt(rep: Rep): ChatMessage[] {
  const curL = rep.label;
  const prevL = rep.prev_label;
  const values = commentaryValues(rep);
  const lines: string[] = [];
  for (const row of rep.rows) {
    const v = values[row.key];
    if (row.per_agent || !v) continue;
    let trend: string;
    if (Object.hasOwn(v, 'delta')) {
      const s = sign(sub((row.cur as Snap).value, (row.prev as Snap).value));
      trend = s > 0 ? 'tăng' : s < 0 ? 'đi xuống' : 'không đổi';
    } else trend = 'thiếu số một kỳ';
    lines.push(
      `- ${row.key} | ${row.name} | ${BETTER_VI[row.better]} | xu hướng: ${trend} | placeholder có: ${Object.keys(v).sort(cpCmp).join(', ')}`,
    );
  }
  const system =
    'Bạn viết phần NHẬN XÉT ngắn (tối đa 6 gạch đầu dòng, tiếng Việt) ' +
    'cho báo cáo điều hành gửi Tổng giám đốc. LUẬT BẮT BUỘC: KHÔNG viết ' +
    'bất kỳ chữ số, ký hiệu phần trăm hay từ chỉ số lượng nào. Muốn nhắc ' +
    'số thì CHỈ viết placeholder dạng {metric:kỳ} với kỳ là ' +
    `'${curL}' (kỳ này), '${prevL}' (kỳ trước) hoặc 'delta' (chênh ` +
    'lệch) — hệ thống tự điền số. Chỉ dùng metric và placeholder có ' +
    "trong danh sách. Không dùng chữ 'giảm' (viết 'đi xuống'/'hạ'). " +
    'Không nói về công dụng sức khỏe.';
  const user = `Danh sách chỉ số (key | tên | chiều tốt | xu hướng | placeholder có):\n${lines.join('\n')}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Gọi gateway agent `cockpit` → [văn bản đã điền, null] | [null, lý do]. */
export async function llmCommentary(
  rep: Rep,
  ai: Pick<AiGateway, 'chat'> | null,
): Promise<[string | null, string | null]> {
  let content: unknown;
  try {
    if (ai === null) throw new GatewayError('chưa nối AI Gateway');
    const resp: unknown = await ai.chat(LLM_AGENT, llmPrompt(rep), {
      temperature: 0,
      feature: FEATURE_WEEK,
    });
    if (typeof resp !== 'object' || resp === null || !('text' in resp)) {
      return [null, 'phản hồi LLM sai cấu trúc'];
    }
    content = (resp as { text: unknown }).text;
  } catch (e) {
    if (e instanceof GatewayError) return [null, `gateway lỗi (${e.name})`];
    throw e;
  }
  const [, values, labels] = ruleTemplates(rep);
  const [text, reasons] = ground(content, values, labels);
  return text === null ? [null, reasons.join('; ')] : [text, null];
}

// ---------------------------------------------------------------- render

const isSampleSnap = (s: Snap | null) => !!s && String(s.source_ref ?? '').startsWith('sample:');

/** P8.4: có số chụp nguồn `sample:` (cockpit --import --sample). */
export function repSample(rep: Pick<Rep, 'rows'>): boolean {
  return (rep.rows ?? []).some((r) => isSampleSnap(r.cur) || isSampleSnap(r.prev));
}

function table(rows: RepRow[]): string[] {
  const L = [
    '| Chỉ số | Kênh | Kỳ này | Kỳ trước | Δ | Đánh giá | Nguồn |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const c = r.cur;
    const p = r.prev;
    const cv = c ? c.value : null;
    const pv = p ? p.value : null;
    const src = c ?? p;
    const source =
      src === null
        ? '—'
        : `${src.source} · ${src.source_ref || '—'} · chụp ${vnDay(src.captured_at)}` +
          (isSampleSnap(c) || isSampleSnap(p) ? ' (MẪU)' : '');
    const cells = [
      `${r.name} (${r.metric_id})`,
      r.channel,
      cv !== null ? fmtValue(cv, r.unit) : NO_DATA,
      pv !== null ? fmtValue(pv, r.unit) : NO_DATA,
      c && p ? fmtDelta(c.value, p.value, r.unit) : '—',
      assess(cv, pv, r.better),
      source,
    ];
    L.push(`| ${cells.map(cell).join(' | ')} |`);
  }
  return L;
}

/** rep → markdown (THUẦN). */
export function render(rep: Rep): string {
  const kindVi = rep.kind === 'week' ? 'tuần' : 'tháng';
  const last = vnFormat(new Date(rep.end.getTime() - DAY_MS), '%d/%m/%Y');
  const L = [`# Báo cáo ${kindVi} ${rep.label} — TGĐ`, ''];
  if (rep.guardrail_violations?.length) {
    L.push(
      `> **CẢNH BÁO GUARDRAIL — trang có vi phạm (${rep.guardrail_violations.join(', ')}), KHÔNG nộp duyệt cho tới khi sửa.**`,
      '',
    );
  }
  const pf = rep.preflight;
  if (pf.ok) L.push(`Tuyến cảnh báo đỏ: ${pf.n} người nhận độc lập`);
  else L.push(RED_LINE + (pf.problems ? ` · vấn đề cấu hình: ${pf.problems}` : ''));
  L.push(
    '',
    `**Kỳ:** ${vnFormat(rep.start, '%d/%m/%Y')} → ${last} (giờ VN) · **Kỳ trước:** ${rep.prev_label} · **Sinh lúc:** ${vnFormat(rep.generated_at, '%d/%m/%Y %H:%M')} giờ VN`,
    '',
    `Mọi con số do code điền từ bảng \`channel_snapshots\` (chụp bởi \`pipelines.cockpit\`); thiếu số hiện \`${NO_DATA}\`, không hiện 0. Dòng *(MẪU)* là số liệu mẫu, không phải số vận hành thật.`,
    '',
    '## Số liệu điều hành',
    '',
    ...table(rep.rows.filter((r) => r.section === 'main')),
    '',
    '## Thời gian duyệt của TGĐ (khối ceo)',
    '',
    'Từ hàng chờ duyệt khối `ceo`: tạo → quyết định. Tuần không có quyết định thì không có số giờ (không ghi 0).',
    '',
    ...table(rep.rows.filter((r) => r.section === 'ceo')),
  );
  for (const sec of rep.sections ?? []) L.push('', ...sec);
  L.push(
    '',
    '## Nhận xét',
    '',
    rep.llm_used
      ? '*Nhận xét do LLM viết bằng placeholder, code điền số.*'
      : '*Nhận xét theo luật (tất định, không dùng LLM).*',
    '',
    rep.commentary || '- (không có)',
  );
  if (rep.llm_note) L.push('', `*${cell(rep.llm_note)}*`);
  if (rep.bad_values) {
    L.push(
      '',
      `*Bỏ qua ${rep.bad_values} số hỏng (NaN/ngoài khoảng) trong channel_snapshots — báo người quản trị DB.*`,
    );
  }
  if (rep.ignored) {
    L.push(
      '',
      `*Bỏ qua ${rep.ignored} chỉ số trong channel_snapshots không có trong data/metrics.json.*`,
    );
  }
  L.push(
    '',
    '---',
    '*BẢN NHÁP — chờ TGĐ ký; hệ thống KHÔNG tự gửi. Sinh bởi `python -m agents.ceo_report`.*',
    '',
  );
  return L.join('\n');
}

/** render + guardrail toàn trang → [markdown, ok]. Không ok → dòng cảnh báo đầu trang. */
export function finalize(rep: Rep): [string, boolean] {
  const text = render(rep);
  const g = dep('guardrailCheck')(text);
  if (g.ok) return [text, true];
  const viols = Array.isArray(g.violations) ? g.violations : [];
  const kinds = [
    ...new Set(
      viols
        .filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
        .map((v) => pyStr((v as Record<string, unknown>).type)),
    ),
  ].sort(cpCmp);
  rep.guardrail_violations = kinds.length ? kinds : ['?'];
  return [render(rep), false];
}

export const reportName = (rep: Pick<Rep, 'label'>): string => `ceo-${rep.label}.md`;

// ---------------------------------------------------------------- v8.1

export const SECTION_HEADS = [
  '## Tiến độ & Sổ quyết định',
  '## Rủi ro pháp lý mở',
  '## Audit outside-in (P1)',
] as const;

type Lines = readonly string[] | Promise<readonly string[]>;
/** 3 section v8.1 của nhóm ceo_misc (`agents.ceo_decisions/ceo_risk/ceo_audit .section`). */
export type CeoSections = {
  /** `ceo_decisions.section(db, today)` — `today` = ngày VN của `now`. */
  decisions: (db: Db, today: string) => Lines;
  risk: (db: Db, now: Date) => Lines;
  audit: (db: Db, now: Date) => Lines;
};

class SectionNotWired extends Error {
  override name = 'NotImplementedError';
}
const notWired = (what: string) => (): never => {
  throw new SectionNotWired(`chưa nối section ${what} (nhóm ceo_misc — setCeoSections)`);
};
let sectionFns: CeoSections = {
  decisions: notWired('sổ quyết định'),
  risk: notWired('rủi ro pháp lý'),
  audit: notWired('audit outside-in'),
};

/** Bước tích hợp: nhóm ceo_misc nối 3 section (chưa nối → section hiện "không đọc được"). */
export function setCeoSections(fns: Partial<CeoSections> | null): void {
  sectionFns =
    fns === null
      ? {
          decisions: notWired('sổ quyết định'),
          risk: notWired('rủi ro pháp lý'),
          audit: notWired('audit outside-in'),
        }
      : { ...sectionFns, ...fns };
}

/** Python `type(e).__name__` cho lỗi bắt được (RangeError = ValueError). */
function pyType(e: unknown): string {
  if (isDbError(e)) return pgErrName(e);
  const n = (e as Error)?.name ?? 'Exception';
  return n === 'RangeError' ? 'ValueError' : n === 'Error' ? 'Exception' : n;
}

/** 3 section v8.1, mỗi cái trong savepoint. Lỗi (DB/cấu hình/dữ liệu lạ) → 1 dòng "không đọc
 * được" (không crash, không im lặng); section khác vẫn ra. */
export async function computeSections(db: Db, now: Date): Promise<string[][]> {
  const fns = [
    (c: Db) => sectionFns.decisions(c, vnDate(now)),
    (c: Db) => sectionFns.risk(c, now),
    (c: Db) => sectionFns.audit(c, now),
  ];
  const out: string[][] = [];
  for (let i = 0; i < SECTION_HEADS.length; i++) {
    try {
      out.push([...(await sp(db, async () => [...(await (fns[i] as (c: Db) => Lines)(db))]))]);
    } catch (e) {
      const why0 = isDbError(e) ? dbMsg(e) : String((e as Error)?.message ?? e);
      const why = cpHead(cell(dep('maskPii')(`${pyType(e)}: ${why0}`)), 160);
      out.push([SECTION_HEADS[i] as string, '', `*(không đọc được: ${why})*`]);
    }
  }
  return out;
}

export function bulletinExtra(sections: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const sec of sections) out.push(...(out.length ? [''] : []), ...sec);
  return out;
}
