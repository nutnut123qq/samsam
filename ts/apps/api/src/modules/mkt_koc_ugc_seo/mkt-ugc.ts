import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { vnMidnight } from '@samsam/core/ops/period';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { CsvError, CsvReader } from '@samsam/core/ops/py-csv';
import { cpCmp } from '@samsam/core/ops/py-json';
import { oneline } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { check, checkPublish } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import {
  casefold,
  cpLen,
  pyRepr,
  pySplit,
  pyStr,
  pyStrip,
  re,
  reEscape,
  stripAccents,
  W,
} from '@samsam/core/security/py';
import { canContact } from '../crm/crm.service.js';
import {
  classifySocial,
  loadSocialRules,
  msgHash,
  type SocialRules,
} from '../intel_import/intel-import.js';
import { type Dict, decodeUtf8Sig, sha256 } from './shared.js';

// v6.4 MKT-07 (marketing-05.2) — UGC/review → ĐỀ XUẤT trả lời + xin phép dùng lại (`agents/mkt_ugc.py`).
// Tất định (luật + template), KHÔNG LLM, KHÔNG mạng. Agent KHÔNG tự trả lời/đăng/nhắn khách: output
// DUY NHẤT là mục NHÁP `marketing/ugc_reply` (câu trả lời đề xuất / nháp xin phép) và `marketing/
// ugc_reuse` (CHỈ khi có consent `marketing`). Nội dung khách che PII ngay khi đọc, chỉ ở RAM — không
// ghi DB/không in; payload chỉ tham chiếu nguồn.

export const RULES_FILE = dataPath('ugc_rules.json');
export const CHANNELS_FILE = dataPath('channels.json');
export const CLASSES = [
  'ruou',
  'claim_suc_khoe',
  'nghi_hang_gia',
  'khieu_nai',
  'che',
  'khen',
  'hoi_gia',
  'khac',
];
export const SENSITIVE = ['ruou', 'claim_suc_khoe'];
export const TEMPLATE_KEYS = ['khen', 'che', 'khieu_nai', 'hoi_gia', 'xin_phep'];
export const REVIEW_FIELDS = ['ma_danh_gia', 'so_sao', 'noi_dung', 'thoi_gian'];
export const REVIEW_CHANNELS = ['shopee', 'tiktok'];
export const MENTION_CHANNEL: Record<string, string> = {
  fanpage: 'facebook',
  zalo_oa: 'zalo',
  tiktok: 'tiktok',
};
export const CODES = [
  'UGC_ECHO',
  'UGC_GUARDRAIL',
  'UGC_UNKNOWN_REF',
  'UGC_SENSITIVE',
  'UGC_NO_CONSENT',
];
export const MAX_BYTES = 5_000_000;
export const MAX_ROWS = 5_000;
export const MAX_TEXT = 5_000; // ký tự / review — chặn DoS guardrail trên text khách
export const FEATURE = 'marketing-05.2';
export const NOTE =
  'Agent KHÔNG tự trả lời/đăng/nhắn khách — người phụ trách đăng/gửi TAY sau khi duyệt. Không chép nội dung khách (chỉ tham chiếu nguồn).';
const REF_RE = /^ugc-[0-9a-f]{16}$/;
const LOP_RE = /\[lop=([a-z_]+)\]/;
const KENH_RE = /\[kenh=([a-z_]+)\]/;
const tuple = (xs: string[]) => `(${xs.map(pyRepr).join(', ')})`;
const pyList = (xs: unknown[]) =>
  `[${xs.map((x) => (typeof x === 'string' ? pyRepr(x) : pyStr(x))).join(', ')}]`;

export type UgcRules = {
  templates: Record<string, string>;
  health_terms: string[];
  review_columns: Record<string, { columns: Record<string, string>; drop: string[] }>;
  social?: SocialRules;
  counterfeit_terms?: string[];
};

/** ugc_rules.json / channels.json / social_rules.json thiếu hoặc hỏng (Python ValueError). */
export class UgcConfigError extends RangeError {}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && b.every((x) => a.includes(x));

/** `_norm`: NFC + casefold + gom trắng. */
export const norm = (s: string | null | undefined): string =>
  pySplit(casefold((s || '').normalize('NFC'))).join(' ');
const has = (term: string, hay: string): boolean =>
  re(`(?<![${W}])${reEscape(term)}(?![${W}])`).test(hay);

/** Fail-closed → {templates (gồm health/alcohol từ channels.json), health_terms, review_columns, social}. */
export function loadRules(
  path: string = RULES_FILE,
  channelsPath: string = CHANNELS_FILE,
  socialPath?: string,
): UgcRules {
  let raw: unknown;
  let ch: unknown;
  try {
    raw = readJson(path);
    const c = readJson(channelsPath);
    if (Array.isArray(c) || typeof c === 'string') throw new TypeError();
    if (!isPlainObject(c) || !Object.hasOwn(c, 'templates')) throw new RangeError('KeyError');
    ch = c.templates;
  } catch (e) {
    const t =
      e instanceof JsonFileError
        ? e.pyType
        : e instanceof TypeError
          ? 'TypeError'
          : e instanceof RangeError
            ? e.message
            : 'OSError';
    throw new UgcConfigError(`không đọc được luật UGC (${t})`);
  }
  const name = basename(path);
  const keys = isPlainObject(raw)
    ? Object.keys(raw).filter((k) => k !== 'counterfeit_terms')
    : null;
  if (!keys || !sameSet(keys, ['_doc', 'templates', 'health_terms', 'review_columns'])) {
    throw new UgcConfigError(`${name}: cần đúng key _doc, templates, health_terms, review_columns`);
  }
  const r = raw as Dict;
  const t = r.templates;
  if (
    !isPlainObject(t) ||
    !sameSet(Object.keys(t), TEMPLATE_KEYS) ||
    !Object.values(t).every((v) => typeof v === 'string' && pyStrip(v))
  ) {
    throw new UgcConfigError(`templates phải đủ ${tuple(TEMPLATE_KEYS)}, không rỗng`);
  }
  const reuse: Record<string, string> = {};
  for (const k of ['health', 'health_san', 'alcohol', 'alcohol_san']) {
    const v = isPlainObject(ch) ? ch[k] : undefined;
    if (typeof v !== 'string' || !pyStrip(v)) {
      throw new UgcConfigError(`channels.json thiếu template '${k}'`);
    }
    reuse[k] = v;
  }
  const terms = r.health_terms;
  if (
    !Array.isArray(terms) ||
    !terms.length ||
    !terms.every((x) => typeof x === 'string' && pyStrip(x))
  ) {
    throw new UgcConfigError('health_terms rỗng hoặc sai kiểu');
  }
  const cols = r.review_columns;
  if (!isPlainObject(cols) || !sameSet(Object.keys(cols), REVIEW_CHANNELS)) {
    throw new UgcConfigError(`review_columns phải đúng ${tuple(REVIEW_CHANNELS)}`);
  }
  for (const [c, spec] of Object.entries(cols)) {
    const ok =
      isPlainObject(spec) &&
      sameSet(Object.keys(spec), ['columns', 'drop']) &&
      isPlainObject(spec.columns) &&
      Object.values(spec.columns).every((v) => typeof v === 'string') &&
      [...(Object.values(spec.columns) as string[])].sort().join('\0') ===
        [...REVIEW_FIELDS].sort().join('\0') &&
      Array.isArray(spec.drop) &&
      spec.drop.every((x) => typeof x === 'string');
    if (!ok) {
      throw new UgcConfigError(
        `review_columns.${c}: columns phải map đủ ${tuple(REVIEW_FIELDS)} + drop list`,
      );
    }
  }
  const [social, errs] = socialPath ? loadSocialRules(socialPath) : loadSocialRules();
  if (social === null) throw new UgcConfigError(`social_rules.json: ${pyList(errs.slice(0, 2))}`);
  // docx P2: `counterfeit_terms` TÙY CHỌN (thiếu = không có lớp nghi_hang_gia — như trước).
  const fake = Object.hasOwn(r, 'counterfeit_terms') ? r.counterfeit_terms : [];
  if (!Array.isArray(fake) || !fake.every((x) => typeof x === 'string' && pyStrip(x))) {
    throw new UgcConfigError('counterfeit_terms phải là danh sách chữ');
  }
  return {
    templates: { ...(t as Record<string, string>), ...reuse },
    health_terms: [...(terms as string[])],
    review_columns: cols as UgcRules['review_columns'],
    social,
    counterfeit_terms: (fake as string[]).map(norm),
  };
}

// ---------------------------------------------------------------- thuần

/** → 1 lớp trong CLASSES. text đã che PII; labels = nhãn v7.2 có sẵn. Ưu tiên: ruou → claim_suc_khoe
 * → nghi_hang_gia → khieu_nai → che (nhãn/≤2 sao) → khen (nhãn/≥4 sao) → hoi_gia → khac. */
export function classify(
  text: string | null | undefined,
  stars: number | null | undefined,
  rules: Partial<UgcRules>,
  labels: readonly string[] = [],
): string {
  const labs = new Set(labels);
  const t = typeof text === 'string' && pyStrip(text) ? text : null;
  if (t) for (const l of classifySocial(t, rules.social as SocialRules)) labs.add(l);
  if (labs.has('hoi_ruou') || (t && isAlcohol(t))) return 'ruou';
  if (labs.has('hoi_suc_khoe') || (t && isHealthQuestion(t))) return 'claim_suc_khoe';
  if (
    t &&
    ((check(t).violations ?? []) as Dict[]).some(
      (v) => v.code === 'tu_cam' || v.code === 'claim_ngoai_cong_bo',
    )
  ) {
    return 'claim_suc_khoe';
  }
  // docx P2: khách nghi hàng giả/nhái → lớp riêng, trước khiếu nại.
  if (
    labs.has('nghi_hang_gia') ||
    (t &&
      (rules.counterfeit_terms ?? []).some((x) => has(x, norm(t)) || has(x, norm(stripAccents(t)))))
  ) {
    return 'nghi_hang_gia';
  }
  if (labs.has('khieu_nai')) return 'khieu_nai';
  if (labs.has('che') || (stars !== null && stars !== undefined && stars <= 2)) return 'che';
  if (labs.has('khen') || (stars !== null && stars !== undefined && stars >= 4)) return 'khen';
  if (labs.has('hoi_gia')) return 'hoi_gia';
  return 'khac';
}

/** Template theo lớp; sàn (`san`) dùng câu *_san. khac → null. */
export function draftReply(cls: string, rules: UgcRules, san: boolean): string | null {
  const t = rules.templates;
  if (cls === 'claim_suc_khoe') return t[san ? 'health_san' : 'health'] ?? null;
  if (cls === 'ruou') return t[san ? 'alcohol_san' : 'alcohol'] ?? null;
  if (cls === 'nghi_hang_gia') return t.khieu_nai ?? null; // xin lỗi + mời liên hệ (như khiếu nại)
  return TEMPLATE_KEYS.includes(cls) ? (t[cls] ?? null) : null;
}

/** Câu trả lời KHÔNG được chứa (bản fold) span vi phạm guardrail trong lời khách hay từ khóa sức khỏe
 * khách nói. Khách gõ không dấu → so trên bản bỏ dấu của câu trả lời. → [ok, cụm bị lặp]. */
export function noClaimEcho(
  reply: string,
  customer: string,
  terms: readonly string[],
): [boolean, string[]] {
  const r = norm(reply);
  const c = norm(customer);
  const rAscii = stripAccents(r);
  const cands = new Set<string>();
  for (const term of terms) {
    const tt = norm(term);
    if (tt && has(tt, c)) cands.add(tt);
    const ta = stripAccents(tt);
    if (ta && ta !== tt && has(ta, c)) cands.add(ta); // khách gõ không dấu
  }
  for (const v of (check(customer || '').violations ?? []) as unknown[]) {
    const sp = isPlainObject(v) ? norm(typeof v.span === 'string' ? v.span : '') : '';
    if (cpLen(sp) >= 2) cands.add(sp);
  }
  const hits = [...cands].sort(cpCmp).filter((t) => has(t, stripAccents(t) === t ? rAscii : r));
  return [!hits.length, hits];
}

export type Proposal = { lop: string; reply: string | null; code: string | null; why: string };

/** THUẦN → {lop, reply, code | null, why}. lop khac → reply null. */
export function propose(
  text: string | null | undefined,
  stars: number | null | undefined,
  channel: string,
  rules: UgcRules,
  o: { san: boolean; labels?: readonly string[] },
): Proposal {
  const cls = classify(text, stars, rules, o.labels ?? []);
  const reply = draftReply(cls, rules, o.san);
  if (reply === null) return { lop: cls, reply: null, code: null, why: 'không soạn' };
  if (text) {
    const [ok, hits] = noClaimEcho(reply, text, rules.health_terms);
    if (!ok) {
      return {
        lop: cls,
        reply,
        code: 'UGC_ECHO',
        why: `câu trả lời lặp lại ${hits.length} cụm của khách`,
      };
    }
  }
  const g = checkPublish(reply, { channel, contentType: 'post', isAi: false });
  if (g.ok !== true) {
    const cs = [...new Set(((g.violations ?? []) as Dict[]).map((v) => v.code))].sort();
    return {
      lop: cls,
      reply,
      code: 'UGC_GUARDRAIL',
      why: `câu trả lời không qua guardrail ${pyList(cs)}`,
    };
  }
  return { lop: cls, reply, code: null, why: 'đạt' };
}

export type ReviewRow = { row_no: number; ma: string; stars: number; text: string };

/** CSV bytes (utf-8-sig) → [rows, lỗi, sha256]. Cột drop bỏ ngay, cột lạ → chặn cả file; noi_dung
 * `maskPii` ngay khi đọc. Lỗi 'dòng N cột X: lý do' — KHÔNG in giá trị ô. */
export function readReviews(
  path: string,
  channel: string,
  rules: UgcRules,
): [ReviewRow[], string[], string | null] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    const t =
      code === 'ENOENT'
        ? 'FileNotFoundError'
        : code === 'EISDIR'
          ? 'IsADirectoryError'
          : code === 'EACCES' || code === 'EPERM'
            ? 'PermissionError'
            : 'OSError';
    return [[], [`không đọc được file (${t})`], null];
  }
  const sha = sha256(raw);
  if (raw.length > MAX_BYTES) return [[], [`file quá lớn (> ${MAX_BYTES} byte)`], sha];
  const text = decodeUtf8Sig(raw);
  if (text === null) return [[], ['file không phải UTF-8'], sha];
  let recs: string[][];
  try {
    recs = [...new CsvReader(text)];
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    return [[], ['file CSV hỏng (ô quá lớn hoặc sai định dạng)'], sha];
  }
  while (recs.length && !(recs[recs.length - 1] as string[]).some((c) => pyStrip(c))) recs.pop();
  if (!recs.length) return [[], ['file rỗng'], sha];
  const spec = rules.review_columns[channel] as { columns: Record<string, string>; drop: string[] };
  const head = (recs[0] as string[]).map(pyStrip);
  const errs: string[] = [];
  const idx: Record<string, number> = {};
  head.forEach((h, i) => {
    if (Object.hasOwn(spec.columns, h)) {
      const f = spec.columns[h] as string;
      if (Object.hasOwn(idx, f)) errs.push(`dòng 1 cột ${f}: trùng cột`);
      idx[f] = i;
    } else if (!spec.drop.includes(h)) {
      errs.push(`dòng 1 cột ${pyRepr(oneline(maskPii(h), 30))}: cột lạ — chặn cả file`);
    }
  });
  for (const f of REVIEW_FIELDS)
    if (!Object.hasOwn(idx, f)) errs.push(`dòng 1 cột ${f}: thiếu cột`);
  if (errs.length) return [[], errs, sha];
  if (recs.length - 1 > MAX_ROWS) return [[], [`quá ${MAX_ROWS} dòng dữ liệu`], sha];
  const rows: ReviewRow[] = [];
  const seen = new Set<string>();
  recs.slice(1).forEach((rec, k) => {
    const n = k + 2;
    if (!rec.some((c) => pyStrip(c))) return;
    if (rec.length !== head.length) {
      errs.push(`dòng ${n}: số cột ${rec.length} ≠ ${head.length}`);
      return;
    }
    const cell = (f: string) => rec[idx[f] as number] as string;
    const ma = pyStrip(cell('ma_danh_gia'));
    const sao = pyStrip(cell('so_sao'));
    const bad: [string, string][] = [];
    if (!ma || cpLen(ma) > 100) bad.push(['ma_danh_gia', 'rỗng hoặc quá 100 ký tự']);
    else if (seen.has(ma)) bad.push(['ma_danh_gia', 'trùng trong file']);
    if (!(/^[0-9]+$/.test(sao) && Number(sao) >= 1 && Number(sao) <= 5)) {
      bad.push(['so_sao', 'phải số nguyên 1..5']);
    }
    if (!pyStrip(cell('thoi_gian'))) bad.push(['thoi_gian', 'rỗng']);
    if (cpLen(cell('noi_dung')) > MAX_TEXT) bad.push(['noi_dung', `quá ${MAX_TEXT} ký tự`]);
    for (const [c, why] of bad) errs.push(`dòng ${n} cột ${c}: ${why}`);
    if (bad.length) return;
    seen.add(ma);
    rows.push({ row_no: n, ma, stars: Number(sao), text: maskPii(cell('noi_dung')) });
  });
  if (!errs.length && !rows.length) errs.push('file không có dòng dữ liệu');
  return errs.length ? [[], errs, sha] : [rows, [], sha];
}

// Lớp "ruou" hiện trong title/payload bằng mã trung tính: chính chữ đó khớp bộ lọc rượu →
// `guardrail.check(payload)` chặn → mục không duyệt được.
const SHOW: Record<string, string> = { ruou: 'sp_cam_qc' };
const UNSHOW: Record<string, string> = Object.fromEntries(
  Object.entries(SHOW).map(([k, v]) => [v, k]),
);
const show = (lop: string) => SHOW[lop] ?? lop;

export function renderReply(p: Proposal, channel: string, source: string): string {
  return [
    '# Đề xuất trả lời UGC (NHÁP — người đăng tay sau duyệt)',
    '',
    `- Lớp: ${show(p.lop)}`,
    `- Kênh: ${channel}`,
    `- Nguồn: ${source}`,
    '- Câu đề xuất:',
    '',
    `> ${p.reply}`,
    '',
    NOTE,
    '',
  ].join('\n');
}

export const title = (lop: string, channel: string, what = 'Đề xuất trả lời UGC'): string =>
  `${what} [lop=${show(lop)}] [kenh=${channel}]`;

// ---------------------------------------------------------------- DB

/** Đã có mục (mọi loại/trạng thái) cùng object_id → null; trùng đồng thời (23505) → null. */
async function submitOnce(
  db: Db,
  objectType: string,
  objectId: string,
  ttl: string,
  payload: string,
  by: string,
  dcfg: DirectorConfig | undefined,
): Promise<bigint | null> {
  const ex = await db.query(
    'select exists(select 1 from approval_queue where object_id = $1) as e',
    [objectId],
  );
  if (ex.rows[0]?.e) return null;
  try {
    return await submit(db, {
      block: 'marketing',
      objectType,
      objectId,
      title: ttl,
      payload,
      createdBy: by,
      ...(dcfg ? { cfg: dcfg } : {}),
    });
  } catch (e) {
    if (isDbError(e) && (e as { code?: string }).code === '23505') return null;
    throw e;
  }
}

export type Item = {
  key: string;
  source: string;
  text?: string | null;
  stars?: number | null;
  labels?: string[];
  channel?: string | null;
};
export type Stats = {
  lop: Record<string, number>;
  moi: (string | bigint)[];
  skip: number;
  chan: [string, string][];
  khong_soan: number;
};
export const emptyStats = (): Stats => ({
  lop: Object.fromEntries(CLASSES.map((c) => [c, 0])),
  moi: [],
  skip: 0,
  chan: [],
  khong_soan: 0,
});

/** items → thống kê; db null = dry-run (không ghi). Không in/không lưu nội dung khách. */
export async function processItems(
  items: Item[],
  channel: string,
  rules: UgcRules,
  o: { salt: string; san: boolean; db?: Db | null; by?: string; dcfg?: DirectorConfig },
): Promise<Stats> {
  const st = emptyStats();
  for (const it of items) {
    const p = propose(it.text, it.stars, channel, rules, { san: o.san, labels: it.labels ?? [] });
    st.lop[p.lop] = (st.lop[p.lop] ?? 0) + 1;
    if (p.reply === null) {
      st.khong_soan += 1;
      continue;
    }
    if (p.code) {
      st.chan.push([it.source, p.code]);
      continue;
    }
    const payload = renderReply(p, channel, it.source);
    if (check(payload).ok !== true) {
      st.chan.push([it.source, 'UGC_GUARDRAIL']);
      continue;
    }
    const oid = `ugc-${msgHash(o.salt, channel, it.key).slice(0, 16)}`;
    if (!o.db) {
      st.moi.push(oid);
      continue;
    }
    const qid = await submitOnce(
      o.db,
      'ugc_reply',
      oid,
      title(p.lop, channel),
      payload,
      o.by ?? '',
      o.dcfg,
    );
    if (qid === null) st.skip += 1;
    else st.moi.push(qid);
  }
  return st;
}

/** `social_mentions` từ ngày `since` (giờ VN) — CHỈ nhãn (DPIA chưa ký → không có text). */
export async function mentionItems(db: Db, since: string): Promise<Item[]> {
  const { rows } = await db.query(
    'select id::text as id, channel, labels, sensitive from social_mentions where posted_at >= $1 order by id',
    [vnMidnight(since)],
  );
  return rows.map((r) => ({
    key: `social_mentions#${r.id}`,
    channel: MENTION_CHANNEL[r.channel as string] ?? null,
    labels: [...((r.labels as string[] | null) ?? []), ...(r.sensitive ? ['hoi_suc_khoe'] : [])],
    text: null,
    stars: null,
    source: `\`social_mentions#${r.id}\``,
  }));
}

/** → [lớp, kênh] đọc từ title mục ugc_reply của REF; không thấy → [null, null]. */
export async function refItem(db: Db, ref: string): Promise<[string | null, string | null]> {
  if (!REF_RE.test(ref || '')) return [null, null];
  const { rows } = await db.query(
    "select title from approval_queue where block = 'marketing' and object_type = 'ugc_reply' and object_id = $1 order by id limit 1",
    [ref],
  );
  if (!rows[0]) return [null, null];
  const t = String(rows[0].title ?? '');
  const lm = LOP_RE.exec(t);
  const km = KENH_RE.exec(t);
  const lop = lm ? (UNSHOW[lm[1] as string] ?? (lm[1] as string)) : null;
  return [lop, km ? (km[1] as string) : null];
}

export type RefResult = { code: string | null; why?: string; qid?: bigint | null };
const unknownRef = (ref: string): RefResult => ({
  code: 'UGC_UNKNOWN_REF',
  why: `không có mục ugc_reply ${pyRepr(oneline(ref, 40))}`,
});

export async function reuseRequest(
  db: Db,
  ref: string,
  rules: UgcRules,
  o: { by: string; dcfg?: DirectorConfig },
): Promise<RefResult> {
  const [lop, ch] = await refItem(db, ref);
  if (lop === null || ch === null) return unknownRef(ref);
  if (SENSITIVE.includes(lop)) {
    return {
      code: 'UGC_SENSITIVE',
      why: `lớp ${lop} — không xin phép/không tái sử dụng UGC nhạy cảm`,
    };
  }
  const msg = rules.templates.xin_phep as string;
  const g = checkPublish(msg, { channel: ch, contentType: 'post', isAi: false });
  if (g.ok !== true) return { code: 'UGC_GUARDRAIL', why: 'template xin_phep không qua guardrail' };
  const payload = [
    '# Nháp tin xin phép dùng lại UGC (CHƯA GỬI)',
    '',
    `- Tham chiếu: \`${ref}\` · kênh ${ch}`,
    '- Tin nhắn đề xuất:',
    '',
    `> ${msg}`,
    '',
    'Chỉ tái sử dụng khi khách đồng ý VÀ đã ghi consent `marketing` qua `python -m ingest.crm --consent` — rồi lập `--reuse`.',
    NOTE,
    '',
  ].join('\n');
  const qid = await submitOnce(
    db,
    'ugc_reply',
    `xp-${ref}`,
    title('xin_phep', ch, 'Nháp xin phép dùng lại UGC'),
    payload,
    o.by,
    o.dcfg,
  );
  return { code: null, qid };
}

export async function reuse(
  db: Db,
  ref: string,
  contactId: bigint,
  o: { by: string; dcfg?: DirectorConfig },
): Promise<RefResult> {
  const [lop, ch] = await refItem(db, ref);
  if (lop === null || ch === null) return unknownRef(ref);
  if (SENSITIVE.includes(lop)) {
    return {
      code: 'UGC_SENSITIVE',
      why: `lớp ${lop} — UGC nhạy cảm không được tái sử dụng (kể cả khi có consent)`,
    };
  }
  if (!(await canContact(db, contactId, 'marketing'))) {
    return {
      code: 'UGC_NO_CONSENT',
      why: `contact_id ${contactId} không có consent marketing hiện hành (chưa có / đã rút)`,
    };
  }
  const payload = [
    '# Đề nghị tái sử dụng UGC (NHÁP)',
    '',
    `- Tham chiếu: \`${ref}\` · kênh ${ch} · lớp ${lop}`,
    `- contact_id: ${contactId} — consent \`marketing\` granted (view \`v_consent_current\` lúc lập)`,
    '',
    'Kiểm lại consent ngay trước khi đăng — khách rút thì KHÔNG dùng. Mục đích consent `marketing` có bao gồm tái sử dụng UGC hay không: chờ Pháp chế xác nhận (GAP DF-34).',
    NOTE,
    '',
  ].join('\n');
  const qid = await submitOnce(
    db,
    'ugc_reuse',
    `reuse-${ref}-c${contactId}`,
    title(lop, ch, 'Đề nghị tái sử dụng UGC'),
    payload,
    o.by,
    o.dcfg,
  );
  return { code: null, qid };
}

/** `_print_stats` → dòng in. */
export function statsLines(label: string, st: Stats, dry: boolean): string[] {
  const lops = Object.entries(st.lop)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const nw = dry
    ? `${st.moi.length} đề xuất (dry-run, không ghi)`
    : `mục mới ${st.moi.map((q) => `#${q}`).join(', ') || '(không)'}`;
  return [
    `[${label}] lớp: ${lops || '(không)'} · ${nw} · skip ${st.skip} · không soạn ${st.khong_soan} · chặn ${st.chan.length}`,
    ...st.chan.slice(0, 50).map(([src, code]) => `  - chặn ${code}: ${src}`),
    'Agent không tự trả lời/đăng — người phụ trách đăng tay sau duyệt.',
  ];
}
