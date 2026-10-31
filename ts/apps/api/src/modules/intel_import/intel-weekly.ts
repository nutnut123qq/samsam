import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { GatewayError } from '@samsam/core/ai/gateway';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { addDays, weekday } from '@samsam/core/ops/period';
import { cpCmp, isDict, PyFloat, pyFixed, pyFloatStr } from '@samsam/core/ops/py-json';
import { writeReport } from '@samsam/core/ops/report';
import { dataPath } from '@samsam/core/paths';
import { checkGenerate, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { check, checkPublish } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import {
  casefold,
  cpLen,
  pySplit,
  pyStr,
  pyStrip,
  pyTruthy,
  re,
  reEscape,
  W,
} from '@samsam/core/security/py';
import { competitorGaps, findSpikes, readPyJson, type TrendCfg } from './intel-import.js';
import { clean } from './table.js';

// Port `scripts/intel_weekly.py` (v7.2, WP09) — báo cáo tuần intel, CHỈ ĐỌC, TẤT ĐỊNH (khóa sắp xếp
// tường minh, không in giờ chạy). 4 mục: (1) Đối thủ — lệch giá/KM so giá `list` golden (mỗi số kèm
// obs#/nguồn và price_list#/đã duyệt hay chưa); (2) Trend — giá trị tuần mới nhất + tăng đột biến
// trong tuần + related RISING file mới nhất; (3) Social — CHỈ ĐẾM theo kênh × nhãn, không in nội
// dung bình luận; (4) Tin `intel_items` trong tuần theo chủ đề. `--out-dir` ghi 2 báo cáo đếm được
// (intel-03 `intel-doithu-`, intel-04.1 `intel-trend-`) qua `writeReport`. `--suggest-keywords`
// (intel-04.2) là đường ghi DUY NHẤT: 1 mục `intel/keyword_suggest` mỗi file Trends related.

export const EMPTY = '_chưa có dữ liệu tuần này_';
export const TABLES = [
  'intel_imports',
  'competitor_observations',
  'trends_weekly',
  'trends_related',
  'social_mentions',
  'intel_items',
  'price_list',
];
export const TITLES_PER_TOPIC = 5;
export const LLM_PROMPT =
  'Tóm tắt báo cáo tình báo thị trường tuần dưới đây trong tối đa 5 gạch đầu dòng tiếng Việt, trung tính, chỉ dựa trên số liệu có trong báo cáo, không đề xuất giá, không nói về công dụng sức khỏe.';

/** `_md`: text từ DB vào ô Markdown — bỏ ký tự điều khiển, cắt, chặn '|'. */
export const md = (s: unknown, n = 120): string => clean(s, n).replaceAll('|', '/');

/** `_vnd`: số nguyên → nhóm nghìn bằng '.'; null → '—'. */
export function vnd(n: number | bigint | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const s = BigInt(n).toString();
  const neg = s.startsWith('-');
  const d = neg ? s.slice(1) : s;
  return (neg ? '-' : '') + d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export type Week = { mon: string; sun: string; start: Date; end: Date };

/** `week_bounds`: tuần thứ Hai..Chủ nhật chứa `day` + [00:00 thứ Hai VN, +7 ngày). */
export function weekBounds(day: string): Week {
  const mon = addDays(day, -weekday(day));
  const start = new Date(`${mon}T00:00:00+07:00`);
  return {
    mon,
    sun: addDays(mon, 6),
    start,
    end: new Date(start.getTime() + 7 * 86_400_000),
  };
}

/** docx P2 (intel-03, PL01 "giá, khuyến mãi, SẢN PHẨM MỚI"): sản phẩm đối thủ LẦN ĐẦU được ghi nhận
 * trong tuần (theo file nhập tay — có thể là SP mới hoặc lần đầu được ghi; người kiểm). */
export async function newProducts(db: Db, mon: string): Promise<string[]> {
  const { rows } = await db.query(
    'select competitor, channel, product_name, min(observed_on)::text as d,' +
      ' min(source_ref) as s from competitor_observations group by 1, 2, 3' +
      ' having min(observed_on) between $1 and $2 order by min(observed_on), 1, 2, 3',
    [mon, addDays(mon, 6)],
  );
  const out = ['### Sản phẩm đối thủ lần đầu ghi nhận trong tuần', ''];
  const lines = rows.map(
    (r) =>
      `- ${r.d} · ${md(r.competitor, 60)} · ${r.channel} · ${md(r.product_name, 80)} (nguồn: ${md(r.s, 160)})`,
  );
  return [...out, ...(lines.length ? lines : [EMPTY]), ''];
}

// Đợt hợp đồng (PL01 Tình báo "giá, khuyến mãi, sản phẩm mới của K5, TRIMICO, KGC theo tuần"): 3 đối
// thủ do HỢP ĐỒNG nêu tên — đổi qua phụ lục, không phải cấu hình. Mỗi tuần báo rõ đối thủ nào THIẾU.
export const PL01_COMPETITORS = ['K5', 'TRIMICO', 'KGC'];

export async function coverage(db: Db, mon: string): Promise<string[]> {
  const { rows } = await db.query(
    'select competitor, count(*)::int as n, count(promo_price_vnd)::int as k' +
      ' from competitor_observations where observed_on between $1 and $2' +
      ' group by 1 order by 1',
    [mon, addDays(mon, 6)],
  );
  const out = ['### Độ phủ đối thủ theo PL01 (K5, TRIMICO, KGC)', ''];
  for (const name of PL01_COMPETITORS) {
    const pat = re(`(?<![${W}])${reEscape(casefold(name))}(?![${W}])`);
    const hit = rows.filter((r) => pat.test(casefold(pyStr(r.competitor))));
    const n = hit.reduce((a, r) => a + r.n, 0);
    const k = hit.reduce((a, r) => a + r.k, 0);
    out.push(
      n
        ? `- ${name}: ${n} quan sát giá, ${k} có giá KM`
        : `- ${name}: **THIẾU dữ liệu tuần này** — chưa có dòng trong file đối thủ nhập tay`,
    );
  }
  return [...out, ''];
}

export async function sectionCompetitor(db: Db, mon: string): Promise<string[]> {
  const gaps = await competitorGaps(db, mon);
  const out = ['## 1. Đối thủ — lệch giá/KM so giá golden (chỉ đọc)', ''];
  out.push(...(await coverage(db, mon)));
  if (!gaps.length) return [...out, EMPTY, '', ...(await newProducts(db, mon))];
  out.push(
    '| Ngày | Đối thủ | Kênh | Sản phẩm | SKU mình | Giá đối thủ (nguồn) | Giá KM | Golden (nguồn) | Lệch |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const g of gaps) {
    let gold: string;
    let gap: string;
    if (g.golden_ref) {
      gold = `${vnd(g.golden_vnd)} (${g.golden_ref} ${g.golden_channel}, ${g.golden_approved ? 'đã duyệt' : 'CHƯA duyệt'})`;
      const p = pyFixed((g.gap_pct as number) * 100, 1);
      gap = `${p.startsWith('-') ? '' : '+'}${p}%`;
    } else {
      gold = g.note as string;
      gap = '—';
    }
    out.push(
      `| ${g.observed_on} | ${md(g.competitor, 60)} | ${g.channel} | ${md(g.product_name, 80)} | ${md(g.sku_key, 60)} | ${vnd(g.price_vnd)} (${g.obs_ref}: ${md(g.source_ref, 160)}) | ${vnd(g.promo_price_vnd)} | ${gold} | ${gap} |`,
    );
  }
  return [
    ...out,
    '',
    'Ghi chú: số liệu đối thủ do người ghi tay — agent không cào sàn, không đề xuất giá.',
    '',
    ...(await newProducts(db, mon)),
  ];
}

type Group = { imp: number; series: [string, number][] };
const tupleCmp = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = cpCmp(a[i] as string, b[i] as string);
    if (d) return d;
  }
  return a.length - b.length;
};

export async function sectionTrend(
  db: Db,
  sun: string,
  mon: string,
  cfg: TrendCfg,
): Promise<string[]> {
  const out = ['## 2. Trend — Google Trends (file xuất tay)', ''];
  const groups = new Map<string, { key: [string, string, string]; g: Group }>();
  const { rows } = await db.query(
    'select import_id, query_id, keyword, geo, week::text as week, value' +
      ' from trends_weekly where week <= $1' +
      ' order by query_id, keyword, geo, week',
    [sun],
  );
  for (const r of rows) {
    const key: [string, string, string] = [r.query_id, r.keyword, r.geo];
    const id = JSON.stringify(key);
    let e = groups.get(id);
    if (!e) {
      e = { key, g: { imp: Number(r.import_id), series: [] } };
      groups.set(id, e);
    }
    e.g.imp = Math.max(e.g.imp, Number(r.import_id));
    e.g.series.push([r.week, Number(r.value)]);
  }
  const latest: string[] = [];
  for (const k of [...cfg.keywords.keys()].sort(cpCmp)) {
    const cands = [...groups.values()].filter((e) => e.key[1] === k);
    if (!cands.length) continue;
    // max((imp, key)): import mới nhất, hòa → khóa lớn nhất
    const best = cands.reduce((a, b) =>
      b.g.imp > a.g.imp || (b.g.imp === a.g.imp && tupleCmp(b.key, a.key) > 0) ? b : a,
    );
    const [week, val] = best.g.series[best.g.series.length - 1] as [string, number];
    latest.push(
      `- ${md(k, 60)} (${md(best.key[2], 40)}): ${val} — tuần ${week} [query_id ${best.key[0]}]`,
    );
  }
  const sp = cfg.spike;
  const spikes: string[] = [];
  for (const { key, g } of [...groups.values()].sort((a, b) => tupleCmp(a.key, b.key))) {
    const [qid, k, geo] = key;
    for (const s of findSpikes(g.series, sp.window_weeks, sp.ratio, sp.min_delta)) {
      if (mon <= s.week && s.week <= sun) {
        spikes.push(
          `- TĂNG ĐỘT BIẾN ${md(k, 60)} (${md(geo, 40)}) tuần ${s.week}: ${s.value} so trung vị ${s.medianStr} của ${sp.window_weeks} tuần trước [query_id ${qid}]`,
        );
      }
    }
  }
  const { rows: rel } = await db.query(
    'select r.seed, r.query, r.value, r.flags from trends_related r' +
      " where r.section = 'rising' and r.import_id = (select max(i.id)" +
      " from intel_imports i where i.kind = 'trend_related')" +
      ' order by r.id',
  );
  if (!(latest.length || spikes.length || rel.length)) return [...out, EMPTY, ''];
  out.push('Giá trị mới nhất (thang 0–100, chỉ so được trong cùng query_id):');
  out.push(...(latest.length ? latest : [EMPTY]));
  out.push('', 'Tăng đột biến trong tuần:', ...(spikes.length ? spikes : ['- không có']));
  out.push('', 'Truy vấn liên quan đang tăng (RISING, file mới nhất):');
  for (const r of rel) {
    const note = (r.flags as string[]).includes('ruou')
      ? ' (rượu — không dùng cho nhóm giới trẻ)'
      : '';
    out.push(`- [${md(r.seed, 40)}] ${md(r.query, 120)}: ${md(r.value, 20)}${note}`);
  }
  if (!rel.length) out.push('- không có');
  return [...out, ''];
}

export async function sectionSocial(db: Db, start: Date, end: Date): Promise<string[]> {
  const out = ['## 3. Social — kênh sở hữu (chỉ đếm, không trích nội dung)', ''];
  const { rows } = await db.query(
    'select channel, l, count(*)::int as n from social_mentions, unnest(labels) l' +
      ' where posted_at >= $1 and posted_at < $2 group by 1, 2 order by 1, 2',
    [start, end],
  );
  if (!rows.length) return [...out, EMPTY, ''];
  const sens = new Map<string, number>();
  for (const r of (
    await db.query(
      'select channel, count(*)::int as n from social_mentions where sensitive' +
        ' and posted_at >= $1 and posted_at < $2 group by 1 order by 1',
      [start, end],
    )
  ).rows) {
    sens.set(r.channel, r.n);
  }
  const tot = new Map<string, number>();
  for (const r of (
    await db.query(
      'select channel, count(*)::int as n from social_mentions' +
        ' where posted_at >= $1 and posted_at < $2 group by 1 order by 1',
      [start, end],
    )
  ).rows) {
    tot.set(r.channel, r.n);
  }
  out.push('| Kênh | Tổng tin | Theo nhãn | Nhạy cảm (hỏi sức khỏe) |', '|---|---|---|---|');
  for (const ch of [...tot.keys()].sort(cpCmp)) {
    const labs = rows
      .filter((r) => r.channel === ch)
      .map((r) => `${r.l}=${r.n}`)
      .join(', ');
    out.push(`| ${ch} | ${tot.get(ch)} | ${labs} | ${sens.get(ch) ?? 0} |`);
  }
  return [
    ...out,
    '',
    'Tin nhạy cảm chuyển người (CSKH/Pháp chế) — agent không trả lời tự động.',
    '',
  ];
}

export async function sectionNews(db: Db, start: Date, end: Date): Promise<string[]> {
  const out = ['## 4. Tin thị trường mới (intel_items) theo chủ đề', ''];
  const { rows: topics } = await db.query(
    'select t, count(*)::int as n from intel_items, unnest(topics) t' +
      ' where fetched_at >= $1 and fetched_at < $2 group by 1 order by 1',
    [start, end],
  );
  if (!topics.length) return [...out, EMPTY, ''];
  for (const { t, n } of topics) {
    out.push(`### ${md(t, 40)} (${n} tin)`);
    const { rows } = await db.query(
      'select title, url from intel_items where $1 = any(topics)' +
        ' and fetched_at >= $2 and fetched_at < $3' +
        ' order by fetched_at desc, id desc limit $4',
      [t, start, end, TITLES_PER_TOPIC],
    );
    for (const r of rows) out.push(`- ${md(r.title, 160)} — ${md(r.url, 300)}`);
    out.push('');
  }
  return out;
}

/** `render` → [báo cáo đầy đủ, phần được phép gửi LLM = mục 1+2+4 (KHÔNG mục social)]. */
export async function render(db: Db, day: string, cfg: TrendCfg): Promise<[string, string]> {
  const { mon, sun, start, end } = weekBounds(day);
  const head = [
    `# Báo cáo tuần intel ${mon} → ${sun}`,
    '',
    'Nguồn: file nhập tay (đối thủ, Google Trends, export kênh sở hữu) + collector RSS v7.0. Tầng P1-Shadow: chỉ đọc, không gửi ai.',
    '',
  ];
  const s1 = await sectionCompetitor(db, mon);
  const s2 = await sectionTrend(db, sun, mon, cfg);
  const s3 = await sectionSocial(db, start, end);
  const s4 = await sectionNews(db, start, end);
  return [[...head, ...s1, ...s2, ...s3, ...s4].join('\n'), [...s1, ...s2, ...s4].join('\n')];
}

// docx P2 (PL01 Tình báo thị trường; PL02 mục 1): `--out-dir` ghi 2 báo cáo riêng qua `writeReport`
// (cổng tắt + nhãn giai đoạn + sổ `report_outputs`), mỗi tính năng 1 tiền tố.
export const REPORTS: [string, string[], string][] = [
  ['intel-doithu-', ['competitor'], 'Đối thủ'],
  ['intel-trend-', ['trend_timeline', 'trend_related'], 'Trend'],
];

/** Provenance: có file nhập tay loại đó mang tên MẪU (quy ước v7.2 — `intel_imports` chưa có cột
 * provenance) → true (không đếm là thật). */
export async function importSample(db: Db, kinds: string[]): Promise<boolean> {
  const { rows } = await db.query(
    "select coalesce(bool_or(file_name ~* 'mau'), false) as s from intel_imports where kind = any($1)",
    [kinds],
  );
  return Boolean(rows[0]?.s);
}

/** `write_weekly` → [file đã ghi, lý do bị chặn]. r12 G1-L1: mỗi báo cáo kiểm cổng RIÊNG — intel-03
 * tắt không làm mất intel-trend của intel-04.1. */
export async function writeWeekly(
  db: Db,
  day: string,
  cfg: TrendCfg,
  outDir: string,
): Promise<[string[], string[]]> {
  const { mon, sun } = weekBounds(day);
  const secs: Record<string, string[]> = {
    'intel-doithu-': await sectionCompetitor(db, mon),
    'intel-trend-': await sectionTrend(db, sun, mon, cfg),
  };
  const out: string[] = [];
  const blocked: string[] = [];
  for (const [pre, kinds, title] of REPORTS) {
    const txt = [
      `# Báo cáo tuần intel — ${title} ${mon} → ${sun}`,
      '',
      'Nguồn: file nhập tay (chỉ đọc, không gửi ai).',
      '',
      ...(secs[pre] as string[]),
    ].join('\n');
    try {
      out.push(await writeReport(txt, outDir, `${pre}${mon}.md`, await importSample(db, kinds)));
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      blocked.push(e.message);
    }
  }
  return [out, blocked];
}

/** `summarize`: 1 lời gọi gateway agent 'intel' + guardrail. Lỗi → null + cảnh báo. */
export async function summarize(
  ai: Pick<AiGateway, 'chat'>,
  payload: string,
  warn: (s: string) => void,
): Promise<string | null> {
  let txt: unknown;
  try {
    const r = await ai.chat(
      'intel',
      [
        { role: 'system', content: LLM_PROMPT },
        { role: 'user', content: payload },
      ],
      { feature: 'intel-03', maxTokens: 400 },
    );
    txt = r?.text;
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    warn(`LLM lỗi (${e.name}) — bỏ tóm tắt`);
    return null;
  }
  if (txt === undefined || txt === null) {
    warn('LLM trả về rỗng — bỏ tóm tắt');
    return null;
  }
  const s = typeof txt === 'string' ? clean(txt, 2000) : '';
  if (!s) return null;
  if (check(s).ok !== true) {
    warn('tóm tắt LLM không qua guardrail — bỏ tóm tắt');
    return null;
  }
  return s;
}

// ------------------------------------------------------------------------- v14.5 từ khóa
// intel-04.2 (PL01 Tình báo thị trường — "gợi ý từ khóa an toàn về pháp lý"): truy vấn liên quan
// Google Trends (top + rising) của 1 file `trend_related` đã nạp (mặc định mới nhất) → lọc LUẬT,
// không LLM: tu_cam (guardrail từ cấm) · cong_dung (claim ngoài công bố) · ruou · suc_khoe · pii ·
// chi_dan_dia_ly ("Ngọc Linh" khi Pháp chế chưa xác nhận — luật `ngoc_linh_chua_xac_nhan` của
// checkPublish) → 1 mục `intel/keyword_suggest` mỗi file (`kw:<import_id>` — file mới = đợt mới):
// danh sách AN TOÀN (nguyên văn) + lý do loại theo dòng `trends_related #id` (KHÔNG chép từ khóa bị
// loại — payload phải qua guardrail để người duyệt). Gợi ý ≠ được dùng: Quản lý Marketing duyệt;
// agent không chạy quảng cáo/SEO.
// v15 P12.4 — thương hiệu/xuất xứ ĐỐI THỦ theo `data/keyword_competitors.json` (khớp theo từ, không
// phân biệt hoa/thường/dấu). Chưa duyệt (`chua_duyet` — mặc định repo) → nhóm "chờ quyết" (KHÔNG vào
// danh sách đề xuất); đã duyệt (`duyet_boi` NGƯỜI + `can_cu`) → `xu_ly` "loai" | "cho_nguoi_quyet".
// File thiếu/hỏng → không đề xuất gì (fail-closed). Danh sách đã duyệt đổi → đợt mới.
export const KW_FEATURE = 'intel-04.2';
export const KW_AGENT = 'agent:intel_keywords';
export const OT_KW = 'keyword_suggest';
export const KW_REASONS: Record<string, string> = {
  tu_cam: 'từ cấm',
  cong_dung: 'công dụng ngoài công bố',
  ruou: 'nhóm sản phẩm cấm quảng cáo',
  suc_khoe: 'ngữ cảnh bệnh/sức khỏe',
  pii: 'thông tin cá nhân',
  chi_dan_dia_ly: 'chỉ dẫn địa lý chưa được xác nhận',
  doi_thu: 'thương hiệu/xuất xứ đối thủ',
};
export const COMPETITORS_FILE = dataPath('keyword_competitors.json');
export const COMP_ACTIONS = ['loai', 'cho_nguoi_quyet'];

/** Guardrail/danh sách đối thủ hỏng khi lọc từ khóa — fail-closed, không đề xuất gì. */
export class KeywordConfigError extends RangeError {
  override name = 'KeywordConfigError';
}

const reason = (k: string): string =>
  Object.hasOwn(KW_REASONS, k) ? (KW_REASONS[k] as string) : k;

/** `keyword_reasons` (THUẦN): từ khóa → lý do loại (rỗng = an toàn). Guardrail hỏng → lỗi. */
export function keywordReasons(q: string): string[] {
  const out: string[] = [];
  if (maskPii(q) !== q) out.push('pii');
  for (const v of check(q).violations ?? []) {
    const c = pyStr(v.code || '');
    if (c === 'config') throw new KeywordConfigError('guardrail cấu hình hỏng');
    out.push(c.startsWith('claim') ? 'cong_dung' : c.startsWith('ruou') ? 'ruou' : c);
  }
  if (isAlcohol(q)) out.push('ruou');
  if (isHealthQuestion(q)) out.push('suc_khoe');
  // Từ khóa dùng cho SEO/quảng cáo = ngữ cảnh ĐĂNG: luật chỉ dẫn địa lý "Ngọc Linh" của
  // checkPublish (không gắn SKU) — chỉ lấy đúng mã đó.
  const pub = checkPublish(q, { channel: 'web', contentType: 'post', isAi: false });
  if ((pub.violations ?? []).some((v) => v.code === 'config')) {
    throw new KeywordConfigError('guardrail cấu hình hỏng');
  }
  if ((pub.violations ?? []).some((v) => v.code === 'ngoc_linh_chua_xac_nhan')) {
    out.push('chi_dan_dia_ly');
  }
  return [...new Set(out)];
}

/** `_fold_kw`: NFC + casefold + gộp khoảng trắng. */
export const foldKw = (q: string): string => pySplit(casefold(q.normalize('NFC'))).join(' ');

/** `_bare`: casefold + bỏ dấu (đ→d) + gộp khoảng trắng — để khớp từ đối thủ. */
export const bare = (q: string): string =>
  foldKw(q)
    .normalize('NFD')
    .replaceAll('đ', 'd')
    .replace(/\p{Mn}/gu, '');

export type Competitors = {
  approved: boolean;
  action: string | null;
  terms: [string, RegExp][];
  by: string | null;
  ref: string | null;
  sha: string;
};

/** Python `json.dumps([bare, act], ensure_ascii=False)` (dấu phân cách ", "). */
function pyDumpsPair(xs: string[], act: unknown): string {
  const s = (v: unknown) => (v === null || v === undefined ? 'null' : JSON.stringify(v));
  return `[[${xs.map((x) => JSON.stringify(x)).join(', ')}], ${s(act)}]`;
}

/** Python `str(v or "")` cho giá trị JSON. */
function strOr(v: unknown): string {
  if (v instanceof PyFloat) return v.v ? pyFloatStr(v.v) : '';
  return pyTruthy(v) ? pyStr(v) : '';
}

/** `load_competitors`: data/keyword_competitors.json → danh sách đối thủ. Lỗi → KeywordConfigError. */
export function loadCompetitors(path: string = COMPETITORS_FILE): Competitors {
  const name = basename(path);
  const got = readPyJson(path);
  if ('err' in got) {
    throw new KeywordConfigError(
      got.err === 'FileNotFoundError' ? `không có file ${name}` : `${name} hỏng: ${got.err}`,
    );
  }
  const doc = got.v;
  if (!isDict(doc)) throw new KeywordConfigError(`${name}: không phải object JSON`);
  const terms = doc.danh_sach;
  if (
    !Array.isArray(terms) ||
    !terms.length ||
    !terms.every((t) => typeof t === 'string' && cpLen(pyStrip(t)) >= 2 && cpLen(pyStrip(t)) <= 60)
  ) {
    throw new KeywordConfigError(`${name}: danh_sach cần list chuỗi 2..60 ký tự, không rỗng`);
  }
  const st = doc.trang_thai;
  if (st !== 'chua_duyet' && st !== 'da_duyet') {
    throw new KeywordConfigError(`${name}: trang_thai chua_duyet|da_duyet`);
  }
  const by = pySplit(strOr(doc.duyet_boi)).join(' ');
  const ref = pySplit(strOr(doc.can_cu)).join(' ');
  const act = doc.xu_ly;
  if (
    st === 'da_duyet' &&
    (!by ||
      casefold(by).startsWith('agent:') ||
      casefold(by).startsWith('system:') ||
      cpLen(by) > 100 ||
      !ref ||
      typeof act !== 'string' ||
      !COMP_ACTIONS.includes(act))
  ) {
    throw new KeywordConfigError(
      `${name}: da_duyet cần duyet_boi (người thật) + can_cu + xu_ly ${COMP_ACTIONS.join(' | ')}`,
    );
  }
  const list = [...new Set((terms as string[]).map(bare))].sort(cpCmp);
  const sha = createHash('sha256')
    .update(pyDumpsPair(list, act ?? null), 'utf8')
    .digest('hex');
  return {
    approved: st === 'da_duyet',
    action: st === 'da_duyet' ? (act as string) : null,
    terms: list.map((t) => [t, re(`(?<![${W}])${reEscape(t)}(?![${W}])`)]),
    by: by || null,
    ref: ref || null,
    sha,
  };
}

/** `competitor_hit` (THUẦN): từ khóa khớp từ đối thủ nào (dạng bỏ dấu) | null. */
export function competitorHit(q: string, comp: Competitors): string | null {
  const b = bare(q);
  return comp.terms.find(([, rx]) => rx.test(b))?.[0] ?? null;
}

export type SafeKw = [string, string | null, string, string, string];
export type KwResult = {
  import_id: number;
  file_name: string;
  safe: SafeKw[];
  excluded: [string, string[]][];
  cho_quyet: [string, string, string][];
  comp: Pick<Competitors, 'approved' | 'by' | 'sha'>;
};

/** `keyword_suggestions`: CHỈ SELECT → kết quả | null (chưa có file). `comp` null → đọc
 * `data/keyword_competitors.json` (lỗi → KeywordConfigError). */
export async function keywordSuggestions(
  db: Db,
  importId: number | null = null,
  comp: Competitors | null = null,
): Promise<KwResult | null> {
  const c = comp ?? loadCompetitors();
  let id = importId;
  if (id === null) {
    const { rows } = await db.query(
      "select max(id) as id from intel_imports where kind = 'trend_related'",
    );
    id = rows[0]?.id === null || rows[0]?.id === undefined ? null : Number(rows[0].id);
  }
  if (id === null) return null;
  const { rows: imp } = await db.query(
    "select id, file_name from intel_imports where id = $1 and kind = 'trend_related'",
    [id],
  );
  if (!imp[0]) return null;
  const safe: SafeKw[] = [];
  const excluded: [string, string[]][] = [];
  const pending: [string, string, string][] = [];
  const seen = new Set<string>();
  const { rows } = await db.query(
    'select id, seed, section, query, value from trends_related where import_id = $1 order by id',
    [id],
  );
  for (const r of rows) {
    const key = foldKw(r.query);
    if (seen.has(key)) continue;
    seen.add(key);
    let why = keywordReasons(r.query);
    const hit = competitorHit(r.query, c);
    if (hit && c.action === 'loai') why = [...why, 'doi_thu'];
    if (why.length) excluded.push([String(r.id), why]);
    else if (hit)
      pending.push([String(r.id), r.query, hit]); // chưa duyệt / người quyết từng từ
    else {
      const seedBad = keywordReasons(r.seed).length > 0 || competitorHit(r.seed, c) !== null;
      safe.push([String(r.id), seedBad ? null : r.seed, r.section, r.query, r.value]);
    }
  }
  return {
    import_id: Number(imp[0].id),
    file_name: imp[0].file_name,
    safe,
    excluded,
    cho_quyet: pending,
    comp: c,
  };
}

/** `render_keywords` (THUẦN) → payload mục hàng duyệt (KHÔNG chép từ khóa bị loại). */
export function renderKeywords(res: {
  import_id: number | string;
  file_name: string;
  safe: (readonly [unknown, string | null, string, string, string])[];
  excluded: (readonly [unknown, string[]])[];
  cho_quyet?: (readonly [unknown, string, string])[] | null;
  comp?: { approved?: boolean; by?: string | null } | null;
}): string {
  const L = [
    `Gợi ý từ khóa an toàn pháp lý (intel-04.2, NHÁP) — file Google Trends đã nạp #${res.import_id} (${md(res.file_name, 80)}): an toàn ${res.safe.length}, loại ${res.excluded.length}.`,
    '',
    'Từ khóa đề xuất (đã qua luật: không từ cấm, không công dụng ngoài công bố, không ngữ cảnh bệnh, không nhóm sản phẩm cấm quảng cáo, không thông tin cá nhân, không chỉ dẫn địa lý chưa xác nhận):',
  ];
  const safeLines = res.safe.map(
    ([, s, section, q, v]) =>
      `- ${md(q, 120)} — ${section} ${md(v, 20)}${s ? ` (gốc: ${md(s, 60)})` : ''}`,
  );
  L.push(...(safeLines.length ? safeLines : ['- (không có)']));
  const cnt = new Map<string, number>();
  for (const [, why] of res.excluded) for (const r of why) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const counts = [...cnt.entries()]
    .sort((a, b) => cpCmp(a[0], b[0]))
    .map(([k, n]) => `${reason(k)} ${n}`)
    .join(' · ');
  L.push('', `Lý do loại (theo số dòng): ${counts || 'không có'}`);
  for (const [rid, why] of res.excluded) {
    L.push(`- trends_related #${rid}: ${why.map(reason).join(', ')}`);
  }
  const pend = res.cho_quyet ?? [];
  const comp = res.comp ?? {};
  if (pend.length) {
    const head = !comp.approved
      ? 'danh sách thương hiệu/xuất xứ đối thủ CHƯA được Pháp chế/Marketing duyệt'
      : `xử lý cho_nguoi_quyet (danh sách duyệt bởi ${pyStr(comp.by)})`;
    L.push(
      '',
      `CHỜ QUYẾT — ${pend.length} từ khóa có thương hiệu/xuất xứ đối thủ (${head}): KHÔNG thuộc danh sách đề xuất, chưa được dùng tới khi người có thẩm quyền quyết:`,
    );
    for (const [rid, q, t] of pend) {
      L.push(`- ${md(q, 120)} — trends_related #${rid} (khớp: ${md(t, 40)})`);
    }
  }
  L.push(
    '',
    'Việc cần làm: Quản lý Marketing duyệt trước khi dùng cho SEO/quảng cáo; luật lọc là từ khóa tất định (chưa có lớp LLM-check — Pháp chế duyệt bộ luật). Agent không chạy quảng cáo/SEO.',
  );
  return L.join('\n');
}

export type SuggestResult = {
  res: KwResult | null;
  payload?: string;
  object_id?: string;
  qid: bigint | string | null;
  skipped: boolean;
};

/** `suggest_keywords`: cổng SINH → gợi ý → 1 mục hàng duyệt mỗi file (đã có → skip). Tắt →
 * RolloutBlocked (không ghi gì). */
export async function suggestKeywords(
  db: Db,
  importId: number | null,
  cfg: DirectorConfig,
  dryRun = false,
  comp: Competitors | null = null,
): Promise<SuggestResult> {
  await checkGenerate(db, KW_FEATURE, 'gợi ý từ khóa');
  const res = await keywordSuggestions(db, importId, comp);
  if (res === null) return { res: null, qid: null, skipped: false };
  const payload = renderKeywords(res);
  let oid = `kw:${res.import_id}`;
  if (res.comp.approved) oid += `:dt-${res.comp.sha.slice(0, 8)}`; // danh sách đã duyệt (đổi) = đợt mới
  const { rows: ex } = await db.query(
    'select id from approval_queue where object_type = $1 and object_id = $2',
    [OT_KW, oid],
  );
  const { rows: sm } = await db.query(
    "select exists(select 1 from intel_imports where id = $1 and file_name like '%MAU%') as s",
    [res.import_id],
  );
  const exists = ex[0] ? String(ex[0].id) : null;
  if (exists !== null || dryRun) {
    return { res, payload, object_id: oid, qid: exists, skipped: exists !== null };
  }
  const qid = await submit(db, {
    block: 'intel',
    objectType: OT_KW,
    objectId: oid,
    title: `Gợi ý từ khóa an toàn — file Trends #${res.import_id}`,
    payload,
    createdBy: KW_AGENT,
    cfg,
    sample: Boolean(sm[0]?.s),
  });
  return { res, payload, object_id: oid, qid, skipped: false };
}

/** Tuần ĐỦ gần nhất theo giờ VN: thứ Hai của tuần trước. */
export function defaultWeekDay(today: string): string {
  return addDays(today, -(weekday(today) + 7));
}
