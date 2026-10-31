import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import type { ChatMessage } from '@samsam/core/ai/providers';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  cpLen,
  cpSlice,
  isPlainObject,
  JsonFileError,
  pySplit,
  readJson,
} from '@samsam/core/ops/py';
import { readinessFromDb, SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { DATA_DIR, dataPath } from '@samsam/core/paths';
import { checkGenerate, featureFor } from '@samsam/core/rollout/rollout';
import {
  checkPublish,
  FILLER_RE,
  fold,
  type GuardrailRules,
  loadRules,
  type ReadinessMap,
  readinessKey,
  readinessOf,
  setGuardrailDataDir,
  withViolation,
} from '@samsam/core/security/guardrail';
import { checkPublishLlm } from '@samsam/core/security/guardrail-llm';
import {
  casefold,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  re,
  S,
  sub,
  W,
} from '@samsam/core/security/py';
import { DAILY_MAX, dailyCandidates, type Inputs, loadInputs } from './mkt-calendar.js';

// Port `pipelines/content.py` — pipeline sinh nội dung đa kênh + listing sàn theo SKU (MKT-02) +
// v13.6 "3 nháp bài/ngày" (PL01 Marketing).
// - LLM qua AI Gateway (`ai.chat('content', …, { feature })` — che PII + trần + cổng triển khai).
//   System prompt chứa brand voice + claims whitelist (chỉ được viết công dụng trong whitelist).
// - Output BẮT BUỘC qua guardrail CHẾ ĐỘ ĐĂNG BÀI (`checkPublishLlm` = luật `checkPublish` + lớp LLM
//   phụ khi có GUARDRAIL_LLM_MODEL) trước khi trả về — không bao giờ trả text chưa kiểm.
// - Nhãn AI / nhãn QC / câu khuyến cáo do CODE chèn (đọc `guardrail_rules.json`), không trông LLM.
// - Template theo kênh `data/prompts/<tên>.md`, version + sha256 ở manifest — lệch sha → lỗi.
// - precheck (thuần, 0 LLM, không ghi DB): SKU lạ / kênh lạ / rượu / TPBVSK chưa XNQC cho loại `ad`
//   / listing ở mức CAM → từ chối kèm lý do, KHÔNG gọi LLM.
// - Listing: tên/quy cách/số ĐKSP/giá list của kênh/hạn dùng do CODE dựng từ golden — KHÔNG BAO GIỜ
//   giá floor/promo; chữ LLM chỉ khi TP_THUONG/QC_DAY_DU, mọi câu/mục chạm thông số bị loại.
// - Agent KHÔNG đăng, KHÔNG sửa listing trên sàn: chỉ nháp `pending` qua `saveDraft` (idempotent).
// - `readiness`: Map `readinessKey(sku, kênh)` → mức của view `sku_readiness`; null = soi gương
//   golden file (fail-closed); map thiếu key = CAM.

export const CONTENT_TEMPLATES: Record<string, string> = {
  facebook: 'content_facebook',
  tiktok: 'content_tiktok',
  zalo: 'content_zalo',
  blog: 'content_blog',
};
export const LISTING_LEVELS = ['MO_TA', 'TP_THUONG', 'QC_DAY_DU'];
export const LLM_LEVELS = ['TP_THUONG', 'QC_DAY_DU'];
export const DEFAULT_BY = 'agent:mkt02';
// Mã từ chối precheck → code violation guardrail tương ứng (mã khác giữ nguyên làm code — code
// thiếu luật = critical block).
const REFUSAL_CODE: Record<string, string> = { ruou: 'ruou_cam_quang_cao', xnqc: 'sku_chua_xnqc' };

/** Chỉ test đổi (Python monkeypatch `PROMPTS_DIR` / `LISTING_RULES`). */
export const paths = {
  prompts: dataPath('prompts'),
  listingRules: dataPath('listing_rules.json'),
  claims: dataPath('claims_whitelist.json'),
};
let dataDir = DATA_DIR;

export type Sku = Record<string, unknown>;
export type Refusal = { code: string; reason: string };
export type Guardrail = Record<string, unknown> & { ok?: unknown; violations?: unknown };
export type AiDeps = { ai: Pick<AiGateway, 'chat'>; env?: Env };

/** Lỗi mang tên lớp ngoại lệ Python (thông điệp cấu hình hỏng in tên này; `llm:<tên>` ở daily). */
class PyErr extends Error {
  constructor(name: string, msg = name) {
    super(msg);
    this.name = name;
  }
}
const errName = (e: unknown): string =>
  e instanceof JsonFileError ? e.pyType : e instanceof PyErr ? e.name : 'TypeError';
const obj = (v: unknown): Record<string, unknown> => {
  if (!isPlainObject(v)) throw new PyErr('TypeError');
  return v;
};
const key = (v: unknown, k: string): unknown => {
  const o = obj(v);
  if (!Object.hasOwn(o, k)) throw new PyErr('KeyError');
  return o[k];
};
// shortcut: chỉ list là iterable (Python lặp được cả chuỗi/dict) — chặt hơn = fail-closed.
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new PyErr('TypeError');
  return v;
};

// ------------------------------------------------------------------ cấu hình

export type ContentCfg = GuardrailRules;

/** Test: đổi thư mục data CÙNG guardrail (Python monkeypatch `guardrail.DATA_DIR`) — xóa cache. */
export function setContentDataDir(dir?: string): void {
  dataDir = dir ?? DATA_DIR;
  setGuardrailDataDir(dir);
}

/** `content._cfg()` = `guardrail._load_rules(DATA_DIR)` (bản core: luật + golden ĐÃ kiểm). */
export const contentCfg = (): [ContentCfg, null] | [null, string] => loadRules(dataDir);

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
const LIMIT_KEYS = ['title_max', 'desc_max', 'bullets_max', 'keywords_max'] as const;

/** Python `int(v)` cho giá trị JSON (bool → 0/1, float → cắt, chuỗi số) | ValueError/TypeError. */
function pyIntOf(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PyErr(Number.isNaN(v) ? 'ValueError' : 'OverflowError');
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const t = pyStrip(v);
    if (/^[+-]?\d+(?:_\d+)*$/.test(t)) return Number(t.replaceAll('_', ''));
    throw new PyErr('ValueError');
  }
  throw new PyErr('TypeError');
}

/** `content._listing_rules()`: data/listing_rules.json đã kiểm → [rules, null] | [null, lý do]. */
export function listingRules(): [ListingRules, null] | [null, string] {
  try {
    const doc = readJson(paths.listingRules);
    const chans: Record<string, Limits> = {};
    for (const [ch, d] of Object.entries(obj(key(doc, 'channels')))) {
      const lim = Object.fromEntries(LIMIT_KEYS.map((k) => [k, pyIntOf(key(d, k))])) as Limits;
      if (Math.min(...Object.values(lim)) < 1) throw new PyErr('ValueError');
      chans[ch] = lim;
    }
    const rules: ListingRules = {
      channels: chans,
      missing_price: pyStr(key(doc, 'missing_price')),
      missing_attr: pyStr(key(doc, 'missing_attr')),
      brand_keywords: list(key(doc, 'brand_keywords'))
        .map(pyStr)
        .filter((x) => pyStrip(x)),
    };
    if (
      !Object.keys(chans).length ||
      !pyStrip(rules.missing_price) ||
      !pyStrip(rules.missing_attr)
    ) {
      throw new PyErr('ValueError');
    }
    return [rules, null];
  } catch (e) {
    return [null, `listing_rules.json không dùng được (${errName(e)})`];
  }
}

// ------------------------------------------------------------------ template / prompt

/** `content.load_template`: [text, version, sha256] của `data/prompts/<name>.md`; sha tính sau
 * CRLF→LF, lệch manifest / thiếu file / tên lạ → lỗi tên `ValueError` (RangeError). */
export function loadTemplate(name: string): [string, string, string] {
  let ver: string;
  let want: string;
  let raw: Buffer;
  try {
    const ent = key(key(readJson(join(paths.prompts, 'manifest.json')), 'templates'), name);
    ver = pyStr(key(ent, 'version'));
    want = pyStr(key(ent, 'sha256'));
    raw = readFileSync(join(paths.prompts, `${name}.md`));
  } catch (e) {
    const n = e instanceof JsonFileError || e instanceof PyErr ? errName(e) : 'FileNotFoundError';
    throw new TemplateError(`template ${pyRepr(name)} không dùng được (${n})`);
  }
  const data = Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  const sha = createHash('sha256').update(data).digest('hex');
  if (sha !== want) {
    throw new TemplateError(
      `template ${pyRepr(name)} lệch sha256 manifest — template đổi mà chưa bump version`,
    );
  }
  return [pyStrip(new TextDecoder('utf-8', { fatal: true }).decode(data)), ver, sha];
}

/** Template không dùng được (Python ValueError). */
export class TemplateError extends RangeError {
  override name = 'ValueError';
}

/** View đọc từ template (Python `CHANNEL_HINT`, tính lười thay vì lúc import). */
export const channelHint = (ch: string): string => loadTemplate(CONTENT_TEMPLATES[ch] as string)[0];

/** `content._whitelist_block`: claims whitelist → đoạn nhét vào system prompt (file hỏng → ném). */
function whitelistBlock(): string {
  const raw = JSON.parse(readFileSync(paths.claims, 'utf8')) as Record<string, unknown>;
  const lines: string[] = [];
  for (const [sku, v] of Object.entries(raw)) {
    if (!isPlainObject(v)) continue;
    const claims = pyTruthy(v.approved_claims) ? (v.approved_claims as unknown[]) : [];
    lines.push(
      claims.length
        ? `- ${sku}: ${claims.map(pyStr).join('; ')}`
        : `- ${sku}: CHƯA CÓ công dụng công bố — không được nêu công dụng`,
    );
  }
  return lines.join('\n');
}

/** `content._publish_texts`: (câu khuyến cáo chuẩn, nhãn AI, nhãn QC); file hỏng → ('', [], []) —
 * guardrail tự fail-closed "config" ở bước check. */
export function publishTexts(): [string, string[], string[]] {
  try {
    const doc = readJson(join(dataDir, 'guardrail_rules.json'));
    const canon = pyStrip(pyStr(key(key(doc, 'disclaimer'), 'canonical')));
    const labels = key(doc, 'labels');
    const pick = (k: string) =>
      list(key(labels, k))
        .map(pyStr)
        .filter((x) => pyStrip(x));
    return [canon, pick('ai'), pick('ad')];
  } catch {
    return ['', [], []];
  }
}

/** `content._system`: system prompt. Listing (`priceRule=false`) bỏ dòng "Liên hệ" — giá do CODE
 * dựng từ golden, câu đó chỉ xúi LLM tự viết giá (fix nghiệm thu v6.1). */
export function system(fmt: string, priceRule = true): string {
  const [canon, ai] = publishTexts();
  const price = priceRule
    ? '- Không bịa giá — sản phẩm không có giá công khai thì ghi "Liên hệ".'
    : '- KHÔNG viết giá, quy cách, khối lượng, hạn dùng hay bất kỳ con số nào (kể cả viết bằng chữ) — hệ thống tự điền.';
  const aiLabel = ai[0] ?? 'Nội dung có sử dụng AI';
  return `Bạn là copywriter của Công ty TNHH Sâm Sâm (Quảng Nam). Giọng
điệu: tự hào đặc sản quê hương, tử tế, không phóng đại. Viết ${fmt}.

LUẬT TPBVSK — vi phạm là bài bị loại:
- CHỈ được nêu công dụng nằm trong whitelist dưới đây của ĐÚNG sản phẩm,
  dùng gần nguyên văn:
${whitelistBlock()}
- Câu trang trí TUYỆT ĐỐI không chứa động từ claim (giúp/hỗ trợ/bồi bổ/
  giảm/tăng cường/cải thiện/tốt cho/phòng ngừa) — những từ đó chỉ xuất
  hiện trong cụm claim whitelist. Mở bài/kết bài chỉ kể chuyện thương
  hiệu, đặc sản quê hương, quà tặng.
- Sản phẩm không có claim -> chỉ giới thiệu, không nêu công dụng.
- Khi nêu công dụng hoặc nhắc sản phẩm TPBVSK, kết bài bằng câu khuyến
  cáo NGUYÊN VĂN (không sửa chữ nào): "${canon}."
- Không dùng tên vùng chỉ dẫn địa lý "Ngọc Linh" (không dùng — chờ Pháp
  chế xác nhận quyền sử dụng chỉ dẫn địa lý cho từng sản phẩm).
- Bài đăng có nhãn "${aiLabel}" ở cuối (hệ thống tự thêm nếu thiếu).
- TUYỆT ĐỐI cấm các từ dùng theo nghĩa khẳng định: chữa, điều trị, thuốc,
  khỏi bệnh, trị bệnh, đặc trị, thần dược, tiêu diệt, chống ung thư.
${price}
- TRƯỚC KHI XUẤT: rà từng câu — câu nào chứa động từ claim (giúp, hỗ trợ,
  giảm, bồi bổ, tăng cường, cải thiện, tốt cho, phòng ngừa, góp phần) mà
  không phải cụm claim whitelist nguyên văn thì VIẾT LẠI câu đó.
`;
}

/** `content._feedback`: phản hồi vi phạm guardrail cho lượt sửa LLM. */
export function feedback(result: Guardrail): string {
  const vs = (Array.isArray(result.violations) ? result.violations : []) as Record<
    string,
    unknown
  >[];
  const or = (a: unknown, b: unknown) => (pyTruthy(a) ? a : b);
  const detail = vs
    .map((v) => `${pyStr(or(v.code, v.type))}: ${pyStr(or(v.span, v.detail))}`)
    .join('; ');
  return `Bài vi phạm guardrail: ${detail}. Viết lại — chỉ dùng claim whitelist nguyên văn, câu trang trí không chứa động từ claim.`;
}

// ------------------------------------------------------------------ chữ LLM chạm thông số

// Phần chữ LLM của listing KHÔNG được chạm thông số: nhãn khung, số viết bằng chữ (số nhỏ chỉ khi
// đi kèm đơn vị — "một món quà" vẫn giữ), đơn vị đo. Ngoại lệ hẹp: "giá trị", "đánh giá", "tỉ mỉ".
const SPEC_RE = re(
  `(?<![${W}])(?:(?<!đánh )giá(?! trị)|quy cách|số đksp|đksp|số đăng ký` +
    `|hạn sử dụng|hạn dùng|hsd|nsx|khối lượng|trọng lượng|dung tích` +
    `|mươi|trăm|nghìn|ngàn|triệu|tỷ|tỉ(?! mỉ)|chục|rưỡi|mười` +
    `|gram|gam|kg|mg|ml|lít|lit|vnd|vnđ` +
    `|(?:một|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|nửa|đôi)[${S}]+` +
    `(?:hũ|lọ|chai|hộp|gói|viên|củ|túi|ống|đồng|năm|tháng|ngày|tuần` +
    `|lạng|cân|cặp))(?![${W}])`,
);
const NUMERIC = /\p{N}/u;
const CF_G = /\p{Cf}/gu;

/** `content._spec_like`: câu LLM chạm thông số → true (bị loại). Ký tự số MỌI loại Unicode hoặc khớp
 * SPEC_RE trên bản chuẩn hóa CÙNG guardrail (bỏ Cf, NFC, fold, NFC) VÀ bản bỏ ký tự chèn.
 * shortcut: `isnumeric` của Python còn nhận chữ Hán số (五, 百…) — `\p{N}` của JS không; nâng khi có
 * nguồn câu ngoài tiếng Việt. */
export function specLike(s: string): boolean {
  if (NUMERIC.test(s)) return true;
  const t = fold(s.replace(CF_G, '').normalize('NFC')).normalize('NFC');
  return SPEC_RE.test(t) || SPEC_RE.test(sub(FILLER_RE, '', t));
}

// ------------------------------------------------------------------ precheck

const head = (v: unknown, n: number): string => cpSlice(pyStr(v), 0, n);

function levelOf(cfg: ContentCfg, sku: string, channel: string, rmap: ReadinessMap | null): string {
  return rmap !== null
    ? pyStr(rmap.get(readinessKey(sku, channel)) ?? 'CAM')
    : readinessOf(cfg.golden.get(sku), channel);
}

/** `content.precheck`: từ chối TRƯỚC khi gọi LLM/ghi DB → {code, reason} | null (được sinh). Code:
 * config | loai_la | sku_la | kenh_la | ruou | readiness | xnqc. Rượu kiểm theo category golden
 * TRƯỚC readiness (map bị sửa thành QC_DAY_DU vẫn từ chối). */
export function precheck(
  sku: unknown,
  channel: unknown,
  contentType: unknown,
  readiness: unknown = null,
): Refusal | null {
  const [cfg, err] = contentCfg();
  if (cfg === null) return { code: 'config', reason: err };
  const ctype =
    typeof contentType === 'string' && Object.hasOwn(cfg.contentTypes, contentType)
      ? cfg.contentTypes[contentType]
      : null;
  if (!isPlainObject(ctype)) {
    return { code: 'loai_la', reason: `loại nội dung lạ: ${pyRepr(head(contentType, 40))}` };
  }
  if (readiness !== null && !(readiness instanceof Map)) {
    return { code: 'config', reason: 'readiness không phải map' };
  }
  if (sku !== null && (typeof sku !== 'string' || !cfg.golden.has(sku))) {
    return { code: 'sku_la', reason: `SKU ${pyRepr(head(sku, 60))} không có trong golden` };
  }
  const listing = contentType === 'listing';
  let ch = channel;
  let okCh: boolean;
  if (listing) {
    const [rules, rerr] = listingRules();
    if (rules === null) return { code: 'config', reason: rerr };
    okCh = typeof ch === 'string' && Object.hasOwn(rules.channels, ch);
  } else {
    if (typeof ch === 'string' && Object.hasOwn(cfg.channelAlias, ch)) ch = cfg.channelAlias[ch];
    okCh = cfg.channels.includes(ch);
  }
  if (!okCh) {
    return {
      code: 'kenh_la',
      reason: `kênh ${pyRepr(head(ch, 40))} không hỗ trợ cho ${pyStr(contentType)}`,
    };
  }
  if (sku === null) return listing ? { code: 'sku_la', reason: 'listing cần SKU' } : null;
  const s = sku as string;
  const c = String(ch);
  const g = cfg.golden.get(s) as Sku;
  if (g.category === 'alcohol' && pyTruthy(Object.hasOwn(ctype, 'public') ? ctype.public : true)) {
    return {
      code: 'ruou',
      reason: `${s} là rượu — cấm quảng cáo/khuyến mại rượu (Luật 44/2019), không sinh nội dung/listing online`,
    };
  }
  const level = levelOf(cfg, s, c, readiness as ReadinessMap | null);
  if (listing && !LISTING_LEVELS.includes(level)) {
    return {
      code: 'readiness',
      reason: `${s} mức ${level} trên kênh ${c} — chưa đủ điều kiện listing (golden allowed_channels / XNQC / tự công bố)`,
    };
  }
  if (pyTruthy(ctype.ad) && g.category === 'tpbvsk' && level !== 'QC_DAY_DU') {
    return {
      code: 'xnqc',
      reason: `${s} mức ${level} trên kênh ${c} — TPBVSK chưa có XNQC, không được làm nội dung quảng cáo`,
    };
  }
  return null;
}

/** `content._refused_guardrail`: kết quả guardrail ok=false mang mã từ chối. */
export function refusedGuardrail(ref: Refusal): Guardrail {
  const base = {
    ok: false,
    violations: [],
    matched_claims: [],
    warnings: [],
    skus: [],
    required_labels: [],
  };
  return withViolation(
    base,
    REFUSAL_CODE[ref.code] ?? ref.code,
    `từ chối (${ref.code}): ${ref.reason}`,
  );
}

type Ctx = {
  channel: unknown;
  contentType: string;
  sku: string | null;
  readiness: ReadinessMap | null;
};
const publishOpts = (c: Ctx) => ({
  channel: c.channel,
  contentType: c.contentType,
  sku: c.sku,
  isAi: true,
  readiness: c.readiness,
});

/** `content._with_required`: nối TẤT ĐỊNH câu khuyến cáo / nhãn QC / nhãn AI mà `checkPublish` báo
 * thiếu — không tốn lượt sửa LLM. */
export function withRequired(text: string, c: Ctx): string {
  const res = checkPublish(text, publishOpts(c));
  const codes = new Set((res.violations ?? []).map((v) => v.code));
  const [canon, ai, ad] = publishTexts();
  const pieces: [string, string | undefined][] = [
    ['thieu_khuyen_cao', canon ? `${canon}.` : undefined],
    ['thieu_nhan_quang_cao', ad[0]],
    ['thieu_nhan_ai', ai[0]],
  ];
  let out = text;
  for (const [code, piece] of pieces) if (codes.has(code) && piece) out = `${out}\n\n${piece}`;
  return out;
}

/** Mã tính năng sở hữu nháp loại này (trần/nút tắt chi phí theo tính năng): theo nguồn đầu ra
 * content_drafts của danh mục; loại chưa có mục riêng → nội dung hằng ngày (marketing-01.1). */
export const featureOfType = (contentType: string): string =>
  featureFor({ table: 'content_drafts', created_by: DEFAULT_BY, content_type: contentType }) ??
  'marketing-01.1';

// ------------------------------------------------------------------ draft

export type DraftMeta = {
  content_type: string;
  sku: string | null;
  is_ai: true;
  prompt_version: string | null;
  prompt_sha256: string | null;
  refused: Refusal | null;
  llm_part?: string;
};
export type DraftResult = { text: string; guardrail: Guardrail; meta: DraftMeta };
export type DraftOpts = {
  readiness?: ReadinessMap | null;
  sku?: string | null;
  contentType?: string;
};

const refusedDraft = (meta: DraftMeta, ref: Refusal): DraftResult => ({
  text: '',
  guardrail: refusedGuardrail(ref),
  meta: { ...meta, refused: ref },
});

/** Sinh draft theo brief → guardrail đăng bài (kênh/loại/SKU, readiness DB nếu caller truyền) →
 * {text, guardrail, meta}. Gắn SKU hoặc loại khác `post` → precheck trước (từ chối = 0 LLM). Lỗi
 * gateway/template nổi lên (caller quyết). */
export async function draft(
  brief: string,
  channel: string = 'facebook',
  o: DraftOpts,
  d: AiDeps,
): Promise<DraftResult> {
  const readiness = o.readiness ?? null;
  const sku = o.sku ?? null;
  const contentType = o.contentType ?? 'post';
  const tname = Object.hasOwn(CONTENT_TEMPLATES, channel)
    ? (CONTENT_TEMPLATES[channel] as string)
    : 'content_facebook';
  const [fmt, ver, sha] = loadTemplate(tname);
  const meta: DraftMeta = {
    content_type: contentType,
    sku,
    is_ai: true,
    prompt_version: ver,
    prompt_sha256: sha,
    refused: null,
  };
  // v6.2/v6.3: nháp ảnh/video PHẢI có file (packshot thật ghép + nhãn AI) — draft() chỉ sinh chữ.
  if (contentType === 'image') {
    return refusedDraft(meta, {
      code: 'loai_la',
      reason:
        'ảnh đi qua pipelines.image_studio (ghép packshot thật) — draft() không sinh nháp ảnh',
    });
  }
  if (contentType === 'video') {
    return refusedDraft(meta, {
      code: 'loai_la',
      reason:
        'video đi qua pipelines.video_studio (dựng từ packshot thật) — draft() không sinh nháp video',
    });
  }
  if (sku !== null || contentType !== 'post') {
    const ref = precheck(sku, channel, contentType, readiness);
    if (ref) return refusedDraft(meta, ref);
  }
  let user = `BRIEF: ${brief}`;
  if (sku !== null) {
    const [cfg] = contentCfg();
    user += `\nSẢN PHẨM: ${pyStr(cfg?.golden.get(sku)?.name)} (mã ${sku})`;
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: system(fmt) },
    { role: 'user', content: user },
  ];
  const ctx: Ctx = { channel, contentType, sku, readiness };
  let text = '';
  let result: Guardrail = {};
  for (let i = 0; i < 2; i++) {
    // draft → check; vi phạm → 1 lượt sửa có feedback
    const resp = await d.ai.chat('content', messages, {
      feature: featureOfType(contentType),
      temperature: 0.3,
      maxTokens: 600,
    });
    text = withRequired(pyStrip(resp.text ?? ''), ctx);
    result = await checkPublishLlm(text, publishOpts(ctx), { gateway: d.ai, env: d.env });
    if (pyTruthy(result.ok)) break;
    messages.push(
      { role: 'assistant', content: text },
      { role: 'user', content: feedback(result) },
    );
  }
  return { text, guardrail: result, meta };
}

/** Draft cho nhiều kênh → {kênh: kết quả}. Mỗi kênh qua `draft()` riêng — guardrail độc lập từng
 * bài. Kênh lạ vẫn được draft (hint facebook). Trùng kênh tự gộp (giữ thứ tự). */
export async function draftMulti(
  brief: string,
  channels: string | string[],
  o: DraftOpts,
  d: AiDeps,
): Promise<Record<string, DraftResult>> {
  const out: Record<string, DraftResult> = {};
  for (const ch of new Set(typeof channels === 'string' ? [channels] : channels)) {
    out[ch] = await draft(brief, ch, o, d);
  }
  return out;
}

// ------------------------------------------------------------------ listing

export type Fields = {
  name: string;
  pack_spec: unknown;
  receipt_no: unknown;
  price: string;
  han_dung: string;
};

export function vnd(v: number | bigint): string {
  return `${BigInt(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

/** Thông số listing render từ golden — KHÔNG đi qua LLM. Giá = `list` của kênh (không bao giờ
 * floor/promo); thiếu → missing_price. Số ĐKSP chỉ TPBVSK. Hạn dùng: golden chưa có field → missing_attr. */
export function listingFields(sku: string, channel: string): Fields {
  const [cfg] = contentCfg();
  const [rules] = listingRules();
  const g = cfg?.golden.get(sku);
  if (!g || !rules) throw new PyErr('KeyError', String(sku));
  const prices = pyTruthy(g.prices) ? (g.prices as Record<string, unknown>) : {};
  const p = isPlainObject(prices) && Object.hasOwn(prices, channel) ? prices[channel] : undefined;
  const lp = isPlainObject(p) ? p.list : undefined;
  // shortcut: JSON.parse không phân biệt 1000 và 1000.0 (Python float → "Liên hệ"); golden thật
  // chỉ có số nguyên — nâng khi golden nhận số thực.
  const okPrice = typeof lp === 'number' && Number.isSafeInteger(lp) && lp > 0;
  const opt = (v: unknown) => (v === undefined ? null : v);
  return {
    name: g.name as string,
    pack_spec: opt(g.pack_spec),
    receipt_no: g.category === 'tpbvsk' ? opt(g.receipt_no) : null,
    price: okPrice ? vnd(lp) : rules.missing_price,
    han_dung: rules.missing_attr,
  };
}

const oneLine = (s: unknown): string => (typeof s === 'string' ? pySplit(s).join(' ') : '');
const DASH_TAIL = ' ,;:–-';

/** Cắt theo từ để len ≤ n (bỏ dấu nối thừa ở cuối). */
export function cutWords(s: string, n: number): string {
  if (cpLen(s) <= n) return s;
  const a = cpSlice(s, 0, n + 1);
  const i = a.lastIndexOf(' ');
  let t = cpSlice(i >= 0 ? a.slice(0, i) : a, 0, n);
  while (t && DASH_TAIL.includes(t.slice(-1))) t = t.slice(0, -1);
  return t;
}

export type LlmPart = { hook: string; description: string; bullets: string[]; keywords: string[] };
const FENCE_RE = re(`^\`\`\`(?:json)?[${S}]*([\\s\\S]*?)[${S}]*\`\`\`$`);

/** JSON chặt {"hook": str, "description": str, "bullets": [str], "keywords": [str]} (bỏ 1 lớp
 * code-fence). Sai shape → null. Khác Python có chủ đích: NaN/Infinity (Python json nhận) → null. */
export function parseLlm(content: unknown): LlmPart | null {
  if (typeof content !== 'string') return null;
  let s = pyStrip(content);
  const m = FENCE_RE.exec(s);
  if (m) s = m[1] as string;
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (
    !isPlainObject(o) ||
    typeof o.hook !== 'string' ||
    typeof o.description !== 'string' ||
    !Array.isArray(o.bullets) ||
    !Array.isArray(o.keywords) ||
    !o.bullets.every((x) => typeof x === 'string') ||
    !o.keywords.every((x) => typeof x === 'string')
  ) {
    return null;
  }
  return o as unknown as LlmPart;
}

const SENT_RE = re(`(?<=[.!?…])[${S}]+`);

/** Phần LLM sau lọc: gộp khoảng trắng về 1 dòng (không giả được dòng 'Giá:'/'Quy cách:' của khung),
 * loại câu/bullet/từ khóa/hook chạm thông số, cắt theo giới hạn kênh. */
export function cleanLlm(o: LlmPart, lim: Limits): LlmPart {
  const hook = oneLine(o.hook);
  const desc: string[] = [];
  let total = 0;
  for (const sent of oneLine(o.description).split(SENT_RE)) {
    if (!sent || specLike(sent)) continue;
    if (total + cpLen(sent) + 1 > lim.desc_max) break;
    desc.push(sent);
    total += cpLen(sent) + 1;
  }
  return {
    hook: specLike(hook) ? '' : hook,
    description: desc.join(' '),
    bullets: o.bullets
      .map(oneLine)
      .filter((b) => b && !specLike(b))
      .slice(0, lim.bullets_max),
    keywords: o.keywords.map(oneLine).filter((k) => k && !specLike(k)),
  };
}

/** Khung listing (code, số liệu golden) + phần chữ LLM đã lọc (nếu có). */
export function render(
  fields: Fields,
  lim: Limits,
  brandKw: string[],
  part: LlmPart | null,
): string {
  const p = part ?? { hook: '', description: '', bullets: [], keywords: [] };
  let title = fields.name;
  if (p.hook) {
    const hooked = cutWords(`${title} – ${p.hook}`, lim.title_max);
    if (cpLen(hooked) > cpLen(title) + 3) title = hooked;
  }
  const out = [title];
  if (p.description) out.push('', p.description);
  if (p.bullets.length) out.push('', 'Đặc điểm nổi bật:', ...p.bullets.map((b) => `- ${b}`));
  out.push('', 'Thông tin sản phẩm:', `Tên sản phẩm: ${fields.name}`);
  if (pyTruthy(fields.pack_spec)) out.push(`Quy cách: ${pyStr(fields.pack_spec)}`);
  if (pyTruthy(fields.receipt_no)) out.push(`Số ĐKSP: ${pyStr(fields.receipt_no)}`);
  out.push(`Giá: ${fields.price}`, `Hạn sử dụng: ${fields.han_dung}`);
  const seen = new Set<string>();
  const kws: string[] = [];
  for (const k of [fields.name, ...brandKw, ...p.keywords]) {
    const kk = casefold(k.normalize('NFC'));
    if (!seen.has(kk)) {
      seen.add(kk);
      kws.push(k);
    }
  }
  out.push('', `Từ khóa: ${kws.slice(0, lim.keywords_max).join(', ')}`);
  return out.join('\n');
}

function listingMessages(fmt: string, fields: Fields, sku: string, level: string): ChatMessage[] {
  const kind =
    level === 'TP_THUONG'
      ? 'thực phẩm thường — KHÔNG nêu bất kỳ công dụng sức khỏe nào, chỉ cảm quan/nguồn gốc/cách dùng chung'
      : 'TPBVSK đã có XNQC — chỉ claim whitelist nguyên văn';
  return [
    { role: 'system', content: system(fmt, false) },
    { role: 'user', content: `SẢN PHẨM: ${fields.name} (mã ${sku}) — ${kind}.` },
  ];
}

export type ListingResult = {
  ok: boolean;
  refused: Refusal | null;
  text: string;
  fields: Fields | null;
  guardrail: Guardrail;
  meta: DraftMeta;
};

/** Listing chuẩn theo kênh cho 1 SKU → {ok, refused, text, fields, guardrail, meta}
 * (meta.llm_part ∈ none|used|dropped:<lý do>). Từ chối (precheck) = 0 LLM, text rỗng. */
export async function listing(
  sku: string,
  channel: string,
  o: { readiness?: ReadinessMap | null; llm?: boolean },
  d: AiDeps,
): Promise<ListingResult> {
  const readiness = o.readiness ?? null;
  const meta: DraftMeta = {
    content_type: 'listing',
    sku,
    is_ai: true,
    prompt_version: null,
    prompt_sha256: null,
    refused: null,
    llm_part: 'none',
  };
  let ref = precheck(sku, channel, 'listing', readiness);
  let fields: Fields | null = null;
  let fmt = '';
  let lim: Limits | null = null;
  let rules: ListingRules | null = null;
  if (ref === null) {
    [fmt, meta.prompt_version, meta.prompt_sha256] = loadTemplate(`listing_${channel}`);
    [rules] = listingRules();
    lim = (rules as ListingRules).channels[channel] as Limits;
    fields = listingFields(sku, channel);
    if (cpLen(fields.name) > lim.title_max) {
      ref = {
        code: 'config',
        reason: `tên SKU dài hơn title_max ${lim.title_max} của kênh ${channel} — sửa golden/listing_rules`,
      };
    }
  }
  if (ref !== null) {
    return {
      ok: false,
      refused: ref,
      text: '',
      fields,
      guardrail: refusedGuardrail(ref),
      meta: { ...meta, refused: ref },
    };
  }
  const [cfg] = contentCfg();
  const level = levelOf(cfg as ContentCfg, sku, channel, readiness);
  const ctx: Ctx = { channel, contentType: 'listing', sku, readiness };
  const f = fields as Fields;
  const l = lim as Limits;
  const finish = async (part: LlmPart | null): Promise<[string, Guardrail]> => {
    const text = withRequired(render(f, l, (rules as ListingRules).brand_keywords, part), ctx);
    return [text, await checkPublishLlm(text, publishOpts(ctx), { gateway: d.ai, env: d.env })];
  };
  if (o.llm !== false && LLM_LEVELS.includes(level)) {
    const messages = listingMessages(fmt, f, sku, level);
    for (let i = 0; i < 2; i++) {
      // 1 lượt sửa có feedback
      let content: string;
      try {
        const resp = await d.ai.chat('content', messages, {
          feature: 'sales-03',
          temperature: 0.3,
          maxTokens: 700,
        });
        content = resp.text;
      } catch (e) {
        meta.llm_part = `dropped:${(e as Error)?.name ?? 'Exception'}`; // lỗi LLM → khung thuần
        break;
      }
      const parsed = parseLlm(content);
      if (parsed === null) {
        meta.llm_part = 'dropped:parse';
        break;
      }
      const [text, res] = await finish(cleanLlm(parsed, l));
      if (res.ok === true) {
        meta.llm_part = 'used';
        return { ok: true, refused: null, text, fields: f, guardrail: res, meta };
      }
      meta.llm_part = 'dropped:guardrail';
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: `${feedback(res)} Trả lại DUY NHẤT JSON đúng mẫu.` },
      );
    }
  }
  const [text, res] = await finish(null);
  return { ok: res.ok === true, refused: null, text, fields: f, guardrail: res, meta };
}

const EXISTING_SQL =
  "select id from content_drafts where content_type = 'listing' and sku = $1 and channel = $2 and prompt_version = $3 and status <> 'rejected' order by id limit 1";

/** Chỉ test đổi (Python monkeypatch `_existing` giả lập batch song song). */
export const hooks = {
  existing: async (db: Db, sku: string, ch: string, ver: string): Promise<string | null> => {
    const { rows } = await db.query<{ id: string }>(EXISTING_SQL, [sku, ch, ver]);
    return rows[0]?.id ?? null;
  },
  dailyExistingSql:
    "select left(brief, 21) as k, id from content_drafts where created_by = $1 and content_type = 'post' and status <> 'rejected' and brief like $2",
};

const isUnique = (e: unknown) => (e as { code?: string })?.code === '23505';
const codesOf = (g: Guardrail) =>
  (Array.isArray(g.violations) ? g.violations : []).map((v) =>
    pyStr((v as { code?: unknown }).code),
  );

export type BatchItem = {
  sku: string;
  channel: string;
  status: 'created' | 'skipped' | 'refused' | 'failed';
  id?: string | null;
  code?: string;
  reason?: string;
  codes?: string[];
  llm_part?: string;
};

/** Listing cho mọi cặp (sku, kênh): created (+id) | skipped (+id — đã có nháp listing sống cùng
 * sku/kênh/prompt_version, kiểm TRƯỚC khi gọi LLM; 23505 lúc INSERT do batch song song cũng =
 * skipped) | refused (+code/reason) | failed (+codes — guardrail không ok, KHÔNG ghi). Chỉ ghi nháp
 * pending qua `saveDraft` (source cli). */
export async function listingBatch(
  db: Db,
  skus: string[],
  channels: string[],
  o: { by: string; readiness?: ReadinessMap | null; llm?: boolean },
  d: AiDeps,
): Promise<BatchItem[]> {
  const readiness = o.readiness ?? (await readinessFromDb(db));
  const out: BatchItem[] = [];
  for (const sku of new Set(skus)) {
    for (const ch of new Set(channels)) {
      const item = { sku, channel: ch };
      const ref = precheck(sku, ch, 'listing', readiness);
      if (ref) {
        out.push({ ...item, status: 'refused', ...ref });
        continue;
      }
      const [, ver] = loadTemplate(`listing_${ch}`);
      let did = await hooks.existing(db, sku, ch, ver);
      if (did !== null) {
        out.push({ ...item, status: 'skipped', id: did });
        continue;
      }
      const r = await listing(sku, ch, { readiness, llm: o.llm }, d);
      if (r.refused) {
        out.push({ ...item, status: 'refused', ...r.refused });
        continue;
      }
      if (r.guardrail.ok !== true) {
        out.push({ ...item, status: 'failed', codes: codesOf(r.guardrail) });
        continue;
      }
      const m = r.meta;
      try {
        did = await saveDraft(db, {
          brief: `listing ${sku} ${ch}`,
          channel: ch,
          text: r.text,
          guardrail: r.guardrail,
          source: SOURCE_CLI,
          createdBy: o.by,
          contentType: 'listing',
          sku,
          isAi: true,
          promptVersion: m.prompt_version,
          promptSha256: m.prompt_sha256,
        });
      } catch (e) {
        if (!isUnique(e)) throw e;
        out.push({ ...item, status: 'skipped', id: await hooks.existing(db, sku, ch, ver) });
        continue;
      }
      out.push({ ...item, status: 'created', id: did, llm_part: m.llm_part });
    }
  }
  return out;
}

// ------------------------------------------------------------------ v13.6 3 nháp bài/ngày

// Khóa slot ở ĐẦU brief: "[daily YYYY-MM-DD #N]" (21 ký tự, N 1..9). Index unique
// `content_drafts_daily_key_idx` trên left(brief, 21) của nháp sống (≠ rejected) do DEFAULT_BY tạo →
// retry/restart/2 tiến trình song song không nhân bản; bản bị từ chối thì slot soạn lại được.
export const DAILY_KEY_LEN = 21;
export const DAILY_WHAT = 'nháp bài hằng ngày';

export function dailyKey(day: string, slot: number): string {
  const k = `[daily ${day} #${Math.trunc(slot)}]`;
  if (cpLen(k) !== DAILY_KEY_LEN) throw new RangeError(`slot phải 1..${DAILY_MAX}`);
  return k;
}

type Cand = ReturnType<typeof dailyCandidates>['candidates'][number];
export const dmyOf = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export function dailyBrief(
  c: Pick<Cand, 'kind' | 'ref' | 'pillar' | 'publish_day' | 'note'>,
): string {
  const s =
    c.kind === 'campaign'
      ? `Chiến dịch ${c.ref} — ${c.pillar}. Bài đăng ngày ${dmyOf(c.publish_day as string)}.`
      : `Bài thường ngày (${c.ref}) — ${c.pillar}.`;
  return s + (pyTruthy(c.note) ? ` (${c.note})` : '');
}

export type DailyItem = {
  slot: number;
  status: 'created' | 'skipped' | 'refused' | 'failed';
  id?: string | null;
  kind?: string;
  ref?: string;
  channel?: string;
  sku?: string | null;
  code?: string;
  reason?: string;
  codes?: string[];
};
export type DailyResult = {
  day: string;
  per_day: number;
  items: DailyItem[];
  refused: (Cand & Refusal)[];
  overflow: Cand[];
  live: number;
  missing: number;
  reasons: string[];
};

/** Soạn tối đa `per_day` (HĐ: 3) nháp bài cho ngày VN `day` theo lịch mùa vụ.
 * - Tính năng (content_drafts/agent:mkt02/post) đang `tat` → RolloutBlocked TRƯỚC mọi lời gọi LLM.
 * - Ứng viên lọc bằng precheck (readiness DB, fail-closed) — bị từ chối thì ghi `refused`, KHÔNG soạn
 *   nội dung vi phạm cho đủ số. Ứng viên hợp lệ thứ i → slot i.
 * - Slot đã có nháp sống → skipped, 0 LLM. Guardrail không ok / lỗi LLM → failed, KHÔNG ghi.
 * - `live` = slot có nháp sống; `missing` = per_day − live (không đếm quota duyệt làm "đã đủ"). */
export async function dailyBatch(
  db: Db,
  day: string,
  o: { readiness?: ReadinessMap | null; inputs?: Inputs },
  d: AiDeps,
): Promise<DailyResult> {
  const by = DEFAULT_BY;
  const fid = featureFor({ table: 'content_drafts', created_by: by, content_type: 'post' });
  await checkGenerate(db, fid, DAILY_WHAT);
  const [cal, golden, sla] = o.inputs ?? loadInputs();
  const dc = dailyCandidates(cal, golden, day, sla);
  const n = dc.per_day;
  const readiness = o.readiness ?? (await readinessFromDb(db));
  const valid: Cand[] = [];
  const refused: (Cand & Refusal)[] = [];
  for (const c of dc.candidates) {
    const ref = c.reason
      ? { code: 'readiness', reason: c.reason }
      : precheck(c.sku, c.channel, 'post', readiness);
    if (ref) refused.push({ ...c, ...ref });
    else valid.push(c);
  }
  const overflow = valid.slice(n).filter((c) => c.kind === 'campaign');
  const existing = new Map(
    (
      await db.query<{ k: string; id: string }>(hooks.dailyExistingSql, [by, `[daily ${day} #%`])
    ).rows.map((r) => [r.k, r.id]),
  );
  const items: DailyItem[] = [];
  for (let i = 1; i <= n; i++) {
    const k = dailyKey(day, i);
    if (existing.has(k)) {
      items.push({ slot: i, status: 'skipped', id: existing.get(k) });
      continue;
    }
    if (i > valid.length) continue;
    const c = valid[i - 1] as Cand;
    const it = { slot: i, kind: c.kind, ref: c.ref, channel: c.channel, sku: c.sku };
    const brief = dailyBrief(c);
    let r: DraftResult;
    try {
      r = await draft(brief, c.channel, { readiness, sku: c.sku, contentType: 'post' }, d);
    } catch (e) {
      if (isDbError(e)) throw e;
      // gateway chặn/lỗi → failed (chạy lại được)
      items.push({ ...it, status: 'failed', codes: [`llm:${(e as Error)?.name ?? 'Exception'}`] });
      continue;
    }
    if (r.meta.refused) {
      items.push({ ...it, status: 'refused', ...r.meta.refused });
      continue;
    }
    if (r.guardrail.ok !== true) {
      items.push({ ...it, status: 'failed', codes: codesOf(r.guardrail) });
      continue;
    }
    let did: string | null;
    try {
      did = await saveDraft(db, {
        brief: `${k} ${brief}`,
        channel: c.channel,
        text: r.text,
        guardrail: r.guardrail,
        source: SOURCE_CLI,
        createdBy: by,
        contentType: 'post',
        sku: c.sku,
        isAi: true,
        promptVersion: r.meta.prompt_version,
        promptSha256: r.meta.prompt_sha256,
      });
    } catch (e) {
      if (!isUnique(e)) throw e;
      const { rows } = await db.query<{ id: string }>(hooks.dailyExistingSql, [
        by,
        `${k.slice(0, -1)}%`,
      ]);
      items.push({ ...it, status: 'skipped', id: rows[0]?.id ?? null });
      continue;
    }
    items.push({ ...it, status: 'created', id: did });
  }
  const live = items.filter((x) => x.status === 'created' || x.status === 'skipped').length;
  const reasons: string[] = [];
  if (valid.length < n) {
    reasons.push(
      `chỉ ${valid.length}/${n} chủ đề hợp lệ theo lịch mùa vụ — xem danh sách bị từ chối`,
    );
  }
  const nFail = items.filter((x) => x.status === 'failed' || x.status === 'refused').length;
  if (nFail) reasons.push(`${nFail} slot soạn không đạt (guardrail/LLM) — chạy lại để soạn lại`);
  return {
    day,
    per_day: n,
    items,
    refused,
    overflow,
    live,
    missing: n - live,
    reasons: n - live ? reasons : [],
  };
}

// ------------------------------------------------------------------ dòng in CLI

const idStr = (v: unknown) => pyStr(v);

export function fmtDaily(it: DailyItem): string {
  let head = `#${it.slot} `;
  if (it.status === 'skipped') return `${head}skipped (đã có nháp #${idStr(it.id)})`;
  head += `${it.kind}:${it.ref} × ${it.channel}`;
  head += it.sku ? ` [${it.sku}]: ` : ': ';
  if (it.status === 'created') return `${head}created #${idStr(it.id)}`;
  if (it.status === 'refused') return `${head}refused ${it.code}: ${it.reason}`;
  return `${head}failed: ${(it.codes?.length ? it.codes : ['?']).join(', ')}`;
}

export function fmtItem(it: BatchItem): string {
  const head = `${it.sku} × ${it.channel}: `;
  if (it.status === 'created' || it.status === 'skipped')
    return `${head}${it.status} #${idStr(it.id)}`;
  if (it.status === 'refused') return `${head}refused ${it.code}: ${it.reason}`;
  return `${head}failed: ${(it.codes?.length ? it.codes : ['?']).join(', ')}`;
}
