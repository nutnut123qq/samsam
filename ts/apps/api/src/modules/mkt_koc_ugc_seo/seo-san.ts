import { readFileSync } from 'node:fs';
import type { Db } from '@samsam/core/ops/deps';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { readinessFromDb, SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { checkPublish, type ReadinessMap } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { casefold, cpLen, pySplit, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  contentCfg,
  precheck,
  publishTexts,
  type Refusal,
} from '../kd_listing_live/content-lite.js';
import { loadRules, RULES_PATH, type SeoRules } from './seo-web.js';
import { type Dict, sha256 } from './shared.js';

// v6.5 MKT-11 (marketing-07.1) — SEO sàn (`agents/seo_san.py`): gợi ý từ khóa tiêu đề/thuộc tính
// listing Shopee/TikTok Shop từ listing hiện tại (`market_rows`) + Google Trends xuất tay
// (`trends_related`) → nháp listing `pending`. KHÔNG sửa sàn, KHÔNG gọi API sàn, 0 LLM, 0 mạng.
// Từ khóa rượu/vi phạm guardrail bị loại kèm code; toàn văn cuối qua `check_publish` lần nữa.

export const AGENT = 'agent:MKT-11';
export const PROMPT_VERSION = 'seo-san-v1';
export const CHANNELS = ['shopee', 'tiktok'];
export const FEATURE = 'marketing-07.1';
export const JOB = 'agents.seo_san';
const PCT_RE = /^\+?([0-9]{1,9})%$/;

const key = (s: string) => pyStrip(casefold(s.normalize('NFC')));

/** sha256 file luật (CRLF→LF — checkout Windows/Linux cùng giá trị). */
export function rulesSha256(path: string = RULES_PATH): string {
  return sha256(
    Buffer.from(readFileSync(path).toString('latin1').replaceAll('\r\n', '\n'), 'latin1'),
  );
}

export type Limits = {
  title_max: number;
  desc_max: number;
  bullets_max: number;
  keywords_max: number;
};
export type ListingRules = {
  channels: Record<string, Limits>;
  missing_price: string;
  missing_attr: string;
  brand_keywords: string[];
};

/** Python `int(v)` cho giá trị JSON (bool → 0/1, float → cắt, chuỗi số) | lỗi mang TÊN lỗi Python:
 * chuỗi không phải số → ValueError, None/list/dict → TypeError. */
function pyIntOf(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError('OverflowError');
    return Math.trunc(v);
  }
  if (typeof v !== 'string') throw new RangeError('TypeError');
  if (!/^[+-]?\d+(?:_\d+)*$/.test(pyStrip(v))) throw new RangeError('ValueError');
  return Number(pyStrip(v).replaceAll('_', ''));
}

/** Python `o[k]` trên giá trị JSON: không phải dict → TypeError, thiếu khóa → KeyError. */
function item(o: unknown, k: string): unknown {
  if (!isPlainObject(o)) throw new RangeError('TypeError');
  if (!Object.hasOwn(o, k)) throw new RangeError('KeyError');
  return o[k];
}

/** Python `for x in v` trên giá trị JSON: list → phần tử, str → từng ký tự, dict → khóa; khác → TypeError. */
function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isPlainObject(v)) return Object.keys(v);
  throw new RangeError('TypeError');
}

/** `content._listing_rules`: data/listing_rules.json đã kiểm → [rules, null] | [null, lý do (tên lỗi
 * Python)]. */
export function listingRules(
  path: string = dataPath('listing_rules.json'),
): [ListingRules, null] | [null, string] {
  try {
    const doc = readJson(path);
    const channels = item(doc, 'channels');
    if (!isPlainObject(channels)) throw new RangeError('AttributeError'); // `.items()`
    const chans: Record<string, Limits> = {};
    for (const [ch, d] of Object.entries(channels)) {
      const lim = Object.fromEntries(
        ['title_max', 'desc_max', 'bullets_max', 'keywords_max'].map((k) => [
          k,
          pyIntOf(item(d, k)),
        ]),
      ) as Limits;
      if (Math.min(...Object.values(lim)) < 1) throw new RangeError(`giới hạn kênh ${ch} < 1`);
      chans[ch] = lim;
    }
    const missingPrice = pyStr(item(doc, 'missing_price'));
    const missingAttr = pyStr(item(doc, 'missing_attr'));
    const rules: ListingRules = {
      channels: chans,
      missing_price: missingPrice,
      missing_attr: missingAttr,
      brand_keywords: pyIter(item(doc, 'brand_keywords'))
        .map(pyStr)
        .filter((x) => pyStrip(x)),
    };
    if (
      !Object.keys(chans).length ||
      !pyStrip(rules.missing_price) ||
      !pyStrip(rules.missing_attr)
    ) {
      throw new RangeError('thiếu kênh / missing_price / missing_attr');
    }
    return [rules, null];
  } catch (e) {
    const t =
      e instanceof JsonFileError
        ? e.pyType
        : e instanceof RangeError && /^[A-Z][A-Za-z]+Error$/.test(e.message)
          ? e.message
          : 'ValueError';
    return [null, `listing_rules.json không dùng được (${t})`];
  }
}

export type Related = {
  seed: unknown;
  section: unknown;
  query: unknown;
  value: unknown;
  flags: unknown;
};
type Rank = [number, number, string];

/** top (value số giảm dần) → rising (Breakout, +% giảm dần) → query.
 * shortcut: `isdigit()` của Python nhận cả chữ số không ASCII — ở đây chỉ 0-9 (Trends xuất tay luôn ASCII). */
function rank(row: Related): Rank {
  const v = pyStrip(pyStr(row.value || '')).replaceAll(',', '');
  const q = key(row.query as string);
  if (row.section === 'top') return [0, /^[0-9]+$/.test(v) ? -Number(v) : 1, q];
  if (casefold(v) === 'breakout') return [1, -(10 ** 12), q];
  const m = PCT_RE.exec(v);
  return [1, m ? -Number(m[1]) : 1, q];
}
const cmpRank = (a: Rank, b: Rank) => a[0] - b[0] || a[1] - b[1] || cpCmp(a[2], b[2]);

function codes(res: { violations?: unknown }): string[] {
  const vs = (Array.isArray(res.violations) ? res.violations : []).filter(isPlainObject);
  return [...new Set(vs.map((v) => pyStr(v.code || v.type || '?')))].sort(cpCmp);
}

/** `content._with_required`: nối TẤT ĐỊNH câu khuyến cáo / nhãn QC / nhãn AI mà `check_publish` báo
 * thiếu — không tốn lượt sửa LLM. */
export function withRequired(
  text: string,
  o: { channel: string; contentType: string; sku: string | null; readiness: ReadinessMap | null },
): string {
  const res = checkPublish(text, { ...o, isAi: true });
  const cs = new Set(((res.violations ?? []) as Dict[]).map((v) => v.code));
  const [canon, ai, ad] = publishTexts();
  for (const [code, piece] of [
    ['thieu_khuyen_cao', canon && `${canon}.`],
    ['thieu_nhan_quang_cao', ad[0] ?? ''],
    ['thieu_nhan_ai', ai[0] ?? ''],
  ] as const) {
    if (cs.has(code) && piece) text = `${text}\n\n${piece}`;
  }
  return text;
}

function publish(text: string, sku: string, channel: string, readiness: ReadinessMap | null) {
  const full = withRequired(text, { channel, contentType: 'listing', sku, readiness });
  const res = checkPublish(full, { channel, contentType: 'listing', sku, isAi: true, readiness });
  return { text: full, guardrail: res as Dict };
}

export type Suggestion = {
  sku: string;
  channel: string;
  refused: Refusal | null;
  failed: { codes: string[] } | null;
  title: string | null;
  base_title: string | null;
  title_reason: string | null;
  added: string[];
  keywords: string[];
  rejected: { query: string; codes: string[] }[];
  already: string[];
  text: string | null;
  guardrail: Dict | null;
};

/** THUẦN (0 DB/mạng): precheck (rượu/readiness/SKU/kênh lạ) → ứng viên theo seed → loại rượu +
 * vi phạm guardrail (kèm code) → xếp tất định → bỏ từ đã có trong tiêu đề gốc → nối khi còn vừa
 * `title_max` → toàn văn qua `check_publish`, không ok → `failed`. */
export function suggest(
  sku: string,
  channel: string,
  currentTitle: unknown,
  related: unknown[],
  o: { rules: SeoRules; listingRules: ListingRules; readiness?: ReadinessMap | null },
): Suggestion {
  const rd = o.readiness ?? null;
  const out: Suggestion = {
    sku,
    channel,
    refused: null,
    failed: null,
    title: null,
    base_title: null,
    title_reason: null,
    added: [],
    keywords: [],
    rejected: [],
    already: [],
    text: null,
    guardrail: null,
  };
  const ref = precheck(sku, channel, 'listing', rd);
  if (ref) {
    out.refused = ref;
    return out;
  }
  const san = o.rules.san;
  const lim = o.listingRules.channels[channel] as Limits;
  const seeds = new Set(
    [
      ...san.default_seeds,
      ...(Object.hasOwn(san.sku_seeds, sku) ? (san.sku_seeds[sku] as string[]) : []),
    ].map(key),
  );
  const cands: (Related & { query: string })[] = [];
  const seen = new Set<string>();
  for (const r of related ?? []) {
    const q0 = isPlainObject(r) ? r.query : null;
    if (typeof q0 !== 'string' || !pyStrip(q0)) continue;
    const rr = r as Related;
    if (!seeds.has(key(pyStr(rr.seed || '')))) continue;
    const q = pySplit(q0).join(' ');
    if (seen.has(key(q))) continue;
    seen.add(key(q));
    const flags = rr.flags || [];
    if ((Array.isArray(flags) && flags.includes('ruou')) || isAlcohol(q)) {
      out.rejected.push({ query: q, codes: ['ruou'] });
      continue;
    }
    const res = publish(`Từ khóa: ${q}`, sku, channel, rd).guardrail;
    if (res.ok !== true) {
      out.rejected.push({ query: q, codes: codes(res) });
      continue;
    }
    cands.push({ ...rr, query: q });
  }
  const ranked = cands.map((c) => [rank(c), c] as const).sort((a, b) => cmpRank(a[0], b[0]));
  out.rejected.sort((a, b) => cpCmp(key(a.query), key(b.query)));

  const [cfg] = contentCfg();
  const name = pyStr(cfg?.golden.get(sku)?.name);
  const cur = typeof currentTitle === 'string' ? pySplit(currentTitle).join(' ') : '';
  let base: string;
  let reason: string;
  if (!cur) [base, reason] = [name, 'chưa có listing trên sàn — dùng tên golden'];
  else if (cpLen(cur) > lim.title_max) {
    [base, reason] = [
      name,
      `tiêu đề hiện tại ${cpLen(cur)} ký tự > title_max ${lim.title_max} — dùng tên golden`,
    ];
  } else [base, reason] = [cur, 'tiêu đề hiện tại trên sàn'];
  let title = base;
  const kws: string[] = [];
  for (const [, c] of ranked) {
    const q = c.query;
    if (key(base).includes(key(q))) {
      out.already.push(q);
      continue;
    }
    kws.push(q);
    const cand = `${title}${san.title_sep}${q}`;
    if (cpLen(cand) <= lim.title_max) {
      title = cand;
      out.added.push(q);
    }
  }
  const keywords: string[] = [];
  const kseen = new Set<string>();
  for (const k of [...o.listingRules.brand_keywords, ...kws]) {
    if (!kseen.has(key(k))) {
      kseen.add(key(k));
      keywords.push(k);
    }
  }
  out.keywords = keywords.slice(0, lim.keywords_max);
  const pub = publish(`${title}\nTừ khóa: ${out.keywords.join(', ')}`, sku, channel, rd);
  Object.assign(out, {
    title,
    base_title: base,
    title_reason: reason,
    text: pub.text,
    guardrail: pub.guardrail,
  });
  if (pub.guardrail.ok !== true) out.failed = { codes: codes(pub.guardrail) };
  return out;
}

// ---------------------------------------------------------------- DB

const RELATED_SQL =
  'select tr.seed, tr.section, tr.query, tr.value, tr.flags from trends_related tr where tr.import_id = (select max(t2.import_id) from trends_related t2 where t2.seed = tr.seed) order by tr.id';
const TITLE_SQL =
  "select r.title from market_rows r where r.snapshot_id = (select s.id from market_snapshots s where s.channel = $1 and s.export_kind = 'listing' order by s.imported_at desc, s.id desc limit 1) and r.sku_key = $2 and r.title is not null order by r.row_no limit 1";
const EXISTING_SQL =
  "select id::text as id from content_drafts where content_type = 'listing' and sku = $1 and channel = $2 and prompt_version = $3 and status <> 'rejected' order by id limit 1";

export async function loadRelated(db: Db): Promise<Related[]> {
  const { rows } = await db.query(RELATED_SQL);
  return rows.map((r) => ({
    seed: r.seed,
    section: r.section,
    query: r.query,
    value: r.value,
    flags: [...((r.flags as string[] | null) ?? [])],
  }));
}

export async function currentTitle(db: Db, sku: string, channel: string): Promise<string | null> {
  const { rows } = await db.query(TITLE_SQL, [channel, sku]);
  return rows[0] ? (rows[0].title as string) : null;
}

async function existing(db: Db, sku: string, channel: string): Promise<string | null> {
  const { rows } = await db.query(EXISTING_SQL, [sku, channel, PROMPT_VERSION]);
  return rows[0] ? (rows[0].id as string) : null;
}

export type RunItem = Dict & {
  sku: string;
  channel: string;
  status: string;
  suggestion: Suggestion;
  id?: string | null;
};

/** → [{sku, channel, status, ...}] created|skipped|dry_run|refused|failed. Chỉ ghi nháp pending qua
 * `saveDraft`. */
export async function run(
  db: Db,
  skus: string[],
  channels: string[],
  o: { dryRun: boolean; rules?: SeoRules; readiness?: ReadinessMap | null },
): Promise<RunItem[]> {
  const rules = o.rules ?? loadRules();
  const [lrules, err] = listingRules();
  if (lrules === null) throw new RangeError(err);
  const rd =
    o.readiness === undefined || o.readiness === null ? await readinessFromDb(db) : o.readiness;
  const related = await loadRelated(db);
  const sha = rulesSha256();
  const out: RunItem[] = [];
  for (const sku of new Set(skus)) {
    for (const ch of new Set(channels)) {
      const s = suggest(sku, ch, await currentTitle(db, sku, ch), related, {
        rules,
        listingRules: lrules,
        readiness: rd,
      });
      const item = { sku, channel: ch, suggestion: s };
      if (s.refused) {
        out.push({ ...item, status: 'refused', ...s.refused });
        continue;
      }
      if (s.failed) {
        out.push({ ...item, status: 'failed', ...s.failed });
        continue;
      }
      if (o.dryRun) {
        out.push({ ...item, status: 'dry_run' });
        continue;
      }
      let did = await existing(db, sku, ch);
      if (did !== null) {
        out.push({ ...item, status: 'skipped', id: did });
        continue;
      }
      try {
        did = await saveDraft(db, {
          brief: `seo-san ${sku} ${ch}`,
          channel: ch,
          text: s.text,
          guardrail: s.guardrail,
          source: SOURCE_CLI,
          createdBy: AGENT,
          contentType: 'listing',
          sku,
          isAi: true,
          promptVersion: PROMPT_VERSION,
          promptSha256: sha,
        });
      } catch (e) {
        if (isDbError(e) && (e as { code?: string }).code === '23505') {
          out.push({ ...item, status: 'skipped', id: await existing(db, sku, ch) });
          continue;
        }
        throw e;
      }
      out.push({ ...item, status: 'created', id: did });
    }
  }
  return out;
}

const cell = (v: unknown) =>
  (v === null || v === undefined ? '' : pyStr(v)).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function render(day: string, items: RunItem[], dryRun: boolean): string {
  const L = [
    `# Gợi ý SEO tiêu đề listing sàn — ${day}`,
    '',
    `> **BẢN NHÁP** — gợi ý thành nháp listing \`pending\` (người duyệt rồi sửa TAY trên Seller Center). Agent KHÔNG sửa sàn/không gọi API sàn. Giới hạn ký tự \`data/listing_rules.json\` và seed \`data/seo_rules.json\` là GIẢ ĐỊNH; Google Trends xuất tay.${dryRun ? ' **Chạy thử (--dry-run): không ghi DB.**' : ''}`,
    '',
    '| SKU | Kênh | Trạng thái | Tiêu đề đề xuất | Từ khóa thêm | Bị loại (code) |',
    '|---|---|---|---|---|---|',
  ];
  for (const it of items) {
    const s = it.suggestion;
    let st = it.status + (it.id ? ` #${it.id}` : '');
    if (it.status === 'refused') st += ` \`${pyStr(it.code)}\``;
    else if (it.status === 'failed')
      st += ` ${(it.codes as string[]).map((c) => `\`${c}\``).join(', ')}`;
    const rej = new Map<string, number>();
    for (const r of s.rejected) for (const c of r.codes) rej.set(c, (rej.get(c) ?? 0) + 1);
    const rejs = [...rej.keys()].sort(cpCmp).map((k) => `${k}×${rej.get(k)}`);
    L.push(
      `| ${it.sku} | ${it.channel} | ${st} | ${cell(s.title)} | ${cell(s.added.join(', '))} | ${cell(rejs.join(', '))} |`,
    );
  }
  L.push('', '---', '*Sinh tự động bởi `python -m agents.seo_san` — 0 LLM.*', '');
  return L.join('\n');
}
