import { type AiGateway, type CallOptions, GatewayError } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  DirectorConfigError,
  loadConfig as directorConfig,
  submit as directorSubmit,
} from '@samsam/core/ops/director';
import { cleanDetail } from '@samsam/core/ops/job-runs';
import { periodBounds, vnDate, vnFormat, vnMidnight } from '@samsam/core/ops/period';
import { isoDate } from '@samsam/core/ops/py-date';
import { pyFloatStr } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, EXIT_BLOCKED, sayBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { pyRepr, pyStrip, re, S, W } from '@samsam/core/security/py';
import { cleanText, loadSources, SOURCES_FILE } from '../intel_crawl/intel.js';
import { type OpenIntelAlert, openAlerts } from './intel-alert.js';
import { type DbLease, type Io, STD_IO } from './io.js';

// Port `scripts/intel_bulletin.py` (v7.1 W71.4/W71.5 — Summarizer & Bulletin intel, WP09): bản tin
// thị trường ngày/tuần từ `intel_items` + cảnh báo đỏ đang mở + sức khỏe nguồn; tùy chọn gợi ý chủ
// đề nội dung vào hàng duyệt chung.
// - Kỳ = `periodBounds(period, ref)` giờ VN; tin thuộc kỳ theo `fetched_at`. Nhóm theo TOPICS, trần
//   PER_TOPIC tin/chủ đề + "(+N tin nữa)".
// - PC-A8 chủ đề `phap_ly`: mỗi dòng tiêu đề + nguồn + ngày VN `YYYY-MM-DD` (thiếu published_at →
//   fetched_at + "(ngày thu)") + link; KHÔNG diễn giải pháp lý (0 tóm tắt AI, 0 gợi ý nội dung).
// - Khối "NỘI BỘ – trích nguồn": CHỈ để đọc, KHÔNG có đường sang hàng duyệt nội dung (module chỉ
//   ghi qua `director.submit` cho gợi ý).
// - Tóm tắt AI: CHỈ khi `--llm` VÀ `llm.enabled === true` trong data/intel_sources.json (mặc định
//   TẮT → 0 lời gọi gateway). Mỗi chủ đề 1 lời gọi agent 'intel' (feature intel-01.1), input CHỈ
//   tiêu đề + trích đã lưu (≤300 ký tự/tin, bỏ link, ≤10 tin). Đầu ra `cleanText` TRƯỚC rồi
//   guardrail ok mới dùng; vi phạm → BỎ + "[đã loại ...]". GatewayError → tắt AI phần còn lại.
// - `--suggest`: chủ đề ≥2 tin → 1 gợi ý TEMPLATE tất định (không trích tin, không tên/giá SKU),
//   guardrail ok mới `director.submit(..., 'intel_topic')` (risk medium — luật tự duyệt chỉ áp low).
//   Module KHÔNG gọi hàm duyệt; Quản lý MXH duyệt. Đã có mục cùng object_id → bỏ qua.
// - Đầu ra `data/reports/intel-bulletin-<period>-<YYYY-MM-DD>.md` — BẢN NHÁP, không tự gửi.

export const TOPICS = ['sam', 'tpbvsk', 'gioi_tre', 'quang_cao', 'doi_thu', 'phap_ly'] as const;
// Văn bản pháp luật KHÔNG phải chủ đề truyền thông, không được diễn giải: 0 tóm tắt, 0 gợi ý.
export const NO_CONTENT_TOPICS: ReadonlySet<string> = new Set(['phap_ly']);
export const LEGAL_FOOTER = 'Diễn giải/đổi rule: Pháp chế quyết — agent không kết luận.';
export const TOPIC_LABELS: Record<string, string> = {
  sam: 'Sâm & thị trường sâm',
  // Không viết đủ "bảo vệ sức khỏe": guardrail coi là claim công dụng.
  tpbvsk: 'TPBVSK — quy định & thị trường thực phẩm chức năng',
  gioi_tre: 'Giới trẻ & xu hướng tiêu dùng',
  quang_cao: 'Quảng cáo & người có ảnh hưởng',
  doi_thu: 'Đối thủ',
  phap_ly: 'Văn bản pháp luật',
};
// Góc nội dung TẤT ĐỊNH cho gợi ý — chung về thương hiệu/vùng trồng, không trích tin, không SKU.
export const ANGLES: Record<string, string> = {
  sam: 'câu chuyện vùng trồng Ngọc Linh, quy trình chăm sóc và truy xuất nguồn gốc',
  tpbvsk: 'hướng dẫn đọc nhãn và thông tin công bố sản phẩm trên bao bì',
  gioi_tre: 'quà tặng và phong cách sống của người trẻ',
  quang_cao: 'minh bạch thông tin quảng cáo, nội dung đúng quy định',
  doi_thu: 'điểm khác biệt về vùng trồng và quy trình của thương hiệu Sâm Sâm',
};
export const QUOTE_HEAD = 'NỘI BỘ – trích nguồn, KHÔNG dùng làm nội dung';
export const DROPPED = '[đã loại: tóm tắt vi phạm guardrail]';
export const FOOTER =
  '*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay; khối trích nguồn chỉ để đọc nội bộ.*';
export const PER_TOPIC = 20;
export const MAX_ROWS = 2000;
export const LLM_ITEMS = 10;
export const SEG_MAX = 300;
export const MIN_SUGGEST = 2;
export const SUGGEST_BY = 'agent:intel_bulletin';
export const FEATURE = 'intel-01.1';
export const SUGGEST_FEATURE = 'intel-01.2';
export const JOB = 'scripts.intel_bulletin';
export const SUM_PROMPT =
  'Tóm tắt nhóm tin thị trường sau trong 2-3 câu tiếng Việt, trung tính, CHỈ dựa trên tiêu đề và trích dẫn được cung cấp. Không nêu công dụng sức khỏe, không khuyến nghị mua bán.';

// Python `(?i)\b(?:https?://|www\.)\S*` (\b, \S Unicode).
const URL_RE = re(`(?<![${W}])(?:https?://|www\\.)[^${S}]*`, 'gi');
// Python `\bfail=([a-z0-9_,-]+)`.
const FAIL_RE = re(`(?<![${W}])fail=([a-z0-9_,-]+)`);
// Ký tự markdown/HTML trong text NGOÀI (tiêu đề RSS, tóm tắt AI) → escape: "![](https://...)" không
// thành ảnh/link tự tải khi mở bản tin (giữ nguyên từ ngữ, chỉ vô hiệu cú pháp).
const MD_RE = /([\\`[\]<>!])/g;
const SAFE_URL_RE = re(`^https?://[^${S}<>\`]+$`);

const ITEMS_SQL =
  'select id, title, snippet, url, source, published_at, fetched_at, topics, flags from intel_items' +
  ' where fetched_at >= $1 and fetched_at < $2 order by fetched_at desc, id desc limit $3';
const JOBS_SQL =
  "select started_at, ok, detail from job_runs where job = 'crawler.intel'" +
  ' and started_at >= $1 and started_at < $2 order by started_at desc';

export type Item = {
  id?: number | string;
  title: string | null;
  snippet?: string | null;
  url: string | null;
  source: string | null;
  published_at: Date | null;
  fetched_at: Date | null;
  topics?: string[] | null;
  flags?: string[] | null;
};
export type Suggested = [topic: string, qid: number, isNew: boolean];
export type BulletinData = {
  n_items: number;
  groups: Record<string, Item[]>;
  alerts: OpenIntelAlert[];
  jobs: { runs: number; failed: number; last_detail: string | null; fail_ids: string[] };
  sources: { ab: number; not_approved: number; errors: number };
  suggested: Suggested[];
};

export function md(s: unknown, n = 160): string {
  return oneline(s || '', n).replace(MD_RE, '\\$1');
}

export function link(url: unknown): string {
  const u = oneline(url || '', 300);
  return SAFE_URL_RE.test(u) ? `<${u}>` : md(u, 300);
}

const vnDay = (ts: Date | null | undefined): string => (ts ? vnFormat(ts, '%d/%m/%Y') : '?');
const dmy = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Đọc DB (chỉ SELECT) → dữ liệu thô cho `render`. */
export async function collect(
  db: Db,
  start: Date,
  end: Date,
  now: Date,
  sourcesFile: string = SOURCES_FILE,
): Promise<BulletinData> {
  const rows = (await db.query(ITEMS_SQL, [start, end, MAX_ROWS])).rows as Item[];
  const groups: Record<string, Item[]> = {};
  for (const t of TOPICS) groups[t] = rows.filter((d) => (d.topics ?? []).includes(t));
  const jobs = (await db.query(JOBS_SQL, [start, end])).rows as {
    ok: boolean | null;
    detail: string | null;
  }[];
  const alerts = await openAlerts(db, now);
  const failIds: string[] = [];
  for (const j of jobs) {
    const m = FAIL_RE.exec(j.detail || '');
    for (const sid of m ? (m[1] as string).split(',') : []) {
      if (sid && sid !== '-' && !failIds.includes(sid)) failIds.push(sid);
    }
  }
  const [cfg, errs] = loadSources(sourcesFile);
  const ab = (cfg?.sources ?? []).filter((s) => s.tier === 'A' || s.tier === 'B');
  return {
    n_items: rows.length,
    groups,
    alerts,
    jobs: {
      runs: jobs.length,
      failed: jobs.filter((j) => j.ok !== true).length,
      last_detail: jobs.length ? cleanDetail(jobs[0]?.detail) : null,
      fail_ids: failIds,
    },
    sources: {
      ab: ab.length,
      not_approved: ab.filter((s) => s.status !== 'duyet').length,
      errors: errs.length,
    },
    suggested: [],
  };
}

function quote(d: Item): string {
  const when = d.published_at || d.fetched_at;
  return `> - ${md(d.title)} — ${md(d.source, 40)} · ${vnDay(when)} · ${link(d.url)}`;
}

/** Dòng tin văn bản pháp luật: ngày ISO bắt buộc (thiếu published_at → fetched_at + "(ngày
 * thu)"), link http(s) — không diễn giải. */
function legalQuote(d: Item): string {
  const pub = d.published_at;
  const got = d.fetched_at;
  let day: string;
  if (pub) day = vnFormat(pub, '%Y-%m-%d');
  else if (got) day = `${vnFormat(got, '%Y-%m-%d')} (ngày thu)`;
  else day = '? (chưa rõ ngày)';
  return `> - ${md(d.title)} — ${md(d.source, 40)} · ${day} · ${link(d.url)}`;
}

/** THUẦN — bản tin markdown. `summaries` {chủ đề: text | null (bị guardrail loại)}; thiếu khóa =
 * không có tóm tắt AI. */
export function render(
  data: BulletinData,
  start: Date,
  end: Date,
  summaries: Record<string, string | null> = {},
  period = 'day',
): string {
  const first = vnDate(start);
  const last = vnDate(new Date(end.getTime() - 86_400_000));
  const kind = period === 'day' ? 'ngày' : period === 'week' ? 'tuần' : period;
  const L: string[] = [
    `# Bản tin thị trường (intel) — ${kind} ${dmy(first)}${last === first ? '' : `–${dmy(last)}`}`,
    '',
    `Kỳ giờ VN · ${data.n_items} tin mới · nguồn: bảng \`intel_items\` (tiêu đề + trích ≤300 ký tự + link, không toàn văn)`,
    '',
    '## Cảnh báo đỏ đang mở (chưa xác nhận)',
    '',
  ];
  for (const a of data.alerts.slice(0, 50)) {
    const esc = a.escalated ? 'ĐÃ LEO THANG' : 'chưa leo thang';
    const rcp = a.recipients.length
      ? a.recipients.join(', ')
      : 'CHƯA AI NHẬN (thiếu người nhận độc lập)';
    L.push(
      `- #${a.id} — ${pyFloatStr(a.age_h)} giờ — ${esc} — ${md(maskPii(a.title || ''), 120)} — ${rcp}`,
    );
  }
  if (data.alerts.length > 50) L.push(`- (+${data.alerts.length - 50} cảnh báo nữa)`);
  if (!data.alerts.length) L.push('- (không có)');
  L.push(
    '',
    'Xác nhận: `python -m pipelines.intel_alert --ack ID --by "Tên"`',
    '',
    '## Tin theo chủ đề',
    '',
  );
  TOPICS.forEach((t, i) => {
    const items = data.groups[t] ?? [];
    L.push(`### ${i + 1}. ${TOPIC_LABELS[t]} — ${items.length} tin`, '');
    if (Object.hasOwn(summaries, t)) {
      const s = summaries[t];
      L.push(s ? `Tóm tắt (AI, đã qua guardrail): ${md(s, 600)}` : DROPPED, '');
    }
    if (!items.length) {
      L.push('- (không có tin mới)', '');
      return;
    }
    L.push(`> **${QUOTE_HEAD}**`);
    const q = t === 'phap_ly' ? legalQuote : quote;
    for (const d of items.slice(0, PER_TOPIC)) L.push(q(d));
    if (items.length > PER_TOPIC) L.push(`> - (+${items.length - PER_TOPIC} tin nữa)`);
    if (t === 'phap_ly') L.push(`> ${LEGAL_FOOTER}`);
    L.push('');
  });
  if (data.suggested?.length) {
    L.push('## Gợi ý chủ đề nội dung (chờ Quản lý MXH duyệt)', '');
    for (const [t, qid, isNew] of data.suggested) {
      L.push(
        `- #${qid} \`intel_topic\` ${TOPIC_LABELS[t] ?? t} — ${isNew ? 'mới' : 'đã có'} — chờ Quản lý MXH duyệt`,
      );
    }
    L.push('');
  }
  const j = data.jobs;
  const s = data.sources;
  L.push(
    '## Nguồn lỗi / robots chặn',
    '',
    `- Lượt \`crawler.intel\` trong kỳ: ${j.runs} (lỗi ${j.failed})`,
    `- Nguồn lỗi trong kỳ: ${j.fail_ids.join(', ') || '(không có)'}`,
    `- Chi tiết lượt gần nhất: ${md(j.last_detail || '—', 300)}`,
    `- Nguồn A/B chưa duyệt: ${s.not_approved}/${s.ab}${s.errors ? ' · file nguồn LỖI' : ''}`,
    '',
    '---',
    FOOTER,
    '',
  );
  return L.join('\n');
}

export function segment(d: Pick<Item, 'title' | 'snippet'>): string {
  const raw = `${d.title || ''} — ${d.snippet || ''}`;
  return pyStrip(cleanText(raw, SEG_MAX).replace(URL_RE, ''));
}

export type ChatFn = (
  agentId: string,
  messages: ChatMessage[],
  opts: CallOptions,
) => Promise<{ text?: unknown } | null | undefined>;

/** Tóm tắt AI theo chủ đề → [{chủ đề: text|null}, số bị guardrail loại]. */
export async function summarize(
  groups: Record<string, Item[]>,
  chat: ChatFn,
  out: (s: string) => void,
): Promise<[Record<string, string | null>, number]> {
  const res: Record<string, string | null> = {};
  let nFail = 0;
  for (const t of TOPICS) {
    const items = groups[t] ?? [];
    if (!items.length || NO_CONTENT_TOPICS.has(t)) continue;
    const body = items
      .slice(0, LLM_ITEMS)
      .map((d) => `- ${segment(d)}`)
      .join('\n');
    const msgs: ChatMessage[] = [
      { role: 'system', content: SUM_PROMPT },
      { role: 'user', content: `Chủ đề: ${TOPIC_LABELS[t]}\n${body}` },
    ];
    let text: unknown;
    try {
      text = (await chat('intel', msgs, { feature: FEATURE, maxTokens: 300 }))?.text;
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      out(`[warn] LLM tắt phần còn lại (${e.name}) — bản tin tất định`);
      break;
    }
    // Làm sạch TRƯỚC rồi guardrail, dùng ĐÚNG chuỗi đã kiểm (entity "&#99;hữa" giải mã thành "chữa").
    const s = typeof text === 'string' ? cleanText(text) : '';
    if (!s) continue;
    if (guardrailCheck(s).ok === true) res[t] = s;
    else {
      res[t] = null;
      nFail++;
    }
  }
  return [res, nFail];
}

/** [title, payload] — TEMPLATE tất định, không trích tin. */
export function suggestion(
  topic: string,
  n: number,
  start: Date,
  end: Date,
  period: string,
  angles: Record<string, string> = ANGLES,
): [string, string] {
  const last = vnDate(new Date(end.getTime() - 86_400_000));
  const title = `Gợi ý chủ đề nội dung: ${TOPIC_LABELS[topic]}`;
  const kind = period === 'week' ? 'tuần' : 'ngày';
  const payload =
    `${title}. Kỳ ${kind} ${dmy(vnDate(start))}–${dmy(last)}: ${n} tin mới về chủ đề này. ` +
    `Góc nội dung đề xuất: ${angles[topic]}. Chỉ là gợi ý nội bộ từ bản tin thị trường (không trích tin gốc) — Quản lý MXH duyệt trước khi giao viết.`;
  return [title, payload];
}

/** Gợi ý → hàng duyệt chung (`intel_topic`). → [(chủ đề, id, mới?)]. */
export async function suggest(
  db: Db,
  period: string,
  start: Date,
  end: Date,
  groups: Record<string, Item[]>,
  out: (s: string) => void,
  angles: Record<string, string> = ANGLES,
): Promise<Suggested[]> {
  const cfg = directorConfig('intel');
  const res: Suggested[] = [];
  for (const t of TOPICS) {
    const n = (groups[t] ?? []).length;
    if (n < MIN_SUGGEST || NO_CONTENT_TOPICS.has(t)) continue;
    const [title, payload] = suggestion(t, n, start, end, period, angles);
    if (guardrailCheck(payload).ok !== true) {
      out(`[warn] gợi ý chủ đề ${t} vi phạm guardrail — bỏ`);
      continue;
    }
    const oid = `${period}-${vnFormat(start, '%Y%m%d')}-${t}`;
    const row = (
      await db.query(
        "select id from approval_queue where object_type = 'intel_topic' and object_id = $1 order by id desc limit 1",
        [oid],
      )
    ).rows[0];
    if (row) {
      res.push([t, Number(row.id), false]);
      continue;
    }
    let qid: bigint;
    try {
      qid = await directorSubmit(db, {
        block: 'intel',
        objectType: 'intel_topic',
        objectId: oid,
        title,
        payload,
        createdBy: SUGGEST_BY,
        cfg,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue; // tiến trình khác vừa đẩy cùng mục
      throw e;
    }
    res.push([t, Number(qid), true]);
  }
  return res;
}

// ---------------------------------------------------------------- CLI

export type BulletinOpts = { period?: string; date?: string; llm?: boolean; suggest?: boolean };
export type BulletinDeps = {
  io?: Io;
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  /** Nối core trên kết nối của lệnh → AiGateway (mặc định `wireCore`). */
  wire?: (db: Db) => unknown;
  /** Gateway GIẢ cho test (mặc định `ai.chat` của gateway từ `wire`). */
  chat?: ChatFn;
  clock?: () => Date;
  outDir?: string;
  sourcesFile?: string;
  angles?: Record<string, string>;
};

// datetime Python tối đa 9999-12-31 — cuối kỳ vượt → OverflowError (usage).
const MAX_END = vnMidnight('9999-12-31').getTime();

const osErrName = (e: unknown): string => {
  const code = (e as { code?: string }).code;
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'ENOTDIR') return 'NotADirectoryError';
  if (code === 'EEXIST') return 'FileExistsError';
  return 'OSError';
};

/** `python scripts/intel_bulletin.py` → exit code. Exit: 0 ok · 1 DB down/lỗi DB/cấu hình khối
 * lỗi/không ghi được file · 2 tham số sai / cổng triển khai TẮT. */
export async function intelBulletinMain(o: BulletinOpts, d: BulletinDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`intel_bulletin.py: error: ${m}`);
    return 2;
  };
  const period = o.period ?? 'day';
  if (period !== 'day' && period !== 'week') {
    return usage(
      `argument --period: invalid choice: ${pyRepr(period)} (choose from 'day', 'week')`,
    );
  }
  let day: string | null = null;
  if (o.date !== undefined) {
    day = isoDate(o.date);
    if (day === null) return usage('--date sai định dạng YYYY-MM-DD');
  }
  const now = (d.clock ?? (() => new Date()))();
  let start: Date;
  let end: Date;
  try {
    [start, end] = periodBounds(period, day ?? now);
  } catch {
    return usage('--date ngoài khoảng tính được kỳ');
  }
  if (!(end.getTime() <= MAX_END)) return usage('--date ngoài khoảng tính được kỳ');
  // r12 G1-L1/RB: bản tin (intel-01.1) và gợi ý chủ đề (intel-01.2) kiểm cổng RIÊNG, TRƯỚC khi
  // đọc/ghi — tắt 1 phần không làm mất phần kia.
  const bname = `intel-bulletin-${period}-${vnDate(start)}.md`;
  const blkB = await blocked(null, 'bản tin', null, { report: bname });
  const blkS = o.suggest ? await blocked(null, 'gợi ý chủ đề Marketing', SUGGEST_FEATURE) : null;
  if (blkB && (blkS || !o.suggest)) {
    for (const why of [blkB, blkS]) if (why) sayBlocked(why, io.out);
    return EXIT_BLOCKED;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.out('[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 1;
  }
  try {
    const db = lease.db;
    const gw = (d.wire ?? ((x: Db) => wireCore(x)))(db);
    let data: BulletinData;
    try {
      data = await collect(db, start, end, now, d.sourcesFile);
      if (o.suggest && !blkS) {
        data.suggested = await suggest(db, period, start, end, data.groups, io.out, d.angles);
      }
    } catch (e) {
      if (e instanceof DirectorConfigError) {
        io.out(`[err] cấu hình khối intel lỗi: ${e.message}`);
        return 1;
      }
      if (!isDbError(e)) throw e;
      io.out(
        `[err] lỗi DB: ${dbMsg(e) || e.name} (thiếu bảng → chạy \`python scripts/apply_schema.py\`)`,
      );
      return 1;
    }
    let summaries: Record<string, string | null> = {};
    let nFail = 0;
    if (o.llm && !blkB) {
      // r12: bản tin tắt → không gọi AI tóm tắt
      const [cfg] = loadSources(d.sourcesFile ?? SOURCES_FILE);
      if (cfg !== null && cfg.llm.enabled === true) {
        const chat: ChatFn =
          d.chat ??
          ((a, m, op) => {
            if (!gw || typeof (gw as AiGateway).chat !== 'function') {
              throw new GatewayError('AI Gateway chưa nối');
            }
            return (gw as AiGateway).chat(a, m, op);
          });
        [summaries, nFail] = await summarize(data.groups, chat, io.out);
      } else {
        io.out('[warn] LLM tắt — chờ Pháp chế xác nhận (bản tin tất định)');
      }
    }
    const text = render(data, start, end, summaries, period);
    const newSug = data.suggested.filter(([, , n]) => n).length;
    if (blkB) {
      io.out(
        `[done] gợi ý chủ đề: suggested_new=${newSug} suggested_total=${data.suggested.length}`,
      );
      return sayBlocked(blkB, io.out);
    }
    let path: string;
    try {
      // P8.4: tin thu thật (intel_items, không đường mẫu).
      path = await writeReport(text, d.outDir ?? REPORTS_DIR, bname, false);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== 'string' || !/^E[A-Z]+$/.test(code)) throw e; // Python: chỉ OSError
      io.out(`[err] không ghi được bản tin (${osErrName(e)})`);
      return 1;
    }
    const nSum = Object.values(summaries).filter((v) => v).length;
    io.out(
      `[done] ${path} items=${data.n_items} open_alerts=${data.alerts.length} suggested_new=${newSug} suggested_total=${data.suggested.length} llm_summaries=${nSum} llm_guardrail_fail=${nFail}`,
    );
    if (blkS) return sayBlocked(blkS, io.out);
    return 0;
  } finally {
    await lease.release().catch(() => {});
  }
}
