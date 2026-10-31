import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { DATA_DIR, dataPath } from '@samsam/core/paths';
import {
  FILLER_RE,
  fold,
  type GuardrailResult,
  type GuardrailRules,
  readiness as goldenReadiness,
  loadRules,
  type ReadinessMap,
  readinessKey,
  resetGuardrailCache,
  withViolation,
} from '@samsam/core/security/guardrail';
import { pyRepr, pyStr, pyStrip, pyTruthy, re, S, sub, W } from '@samsam/core/security/py';

// Phần `pipelines/content.py` (+ `ingest/market_csv.py`) mà kd_listing/listing_export/kd_live gọi:
// cấu hình guardrail+golden (`_cfg`), `_listing_rules`, `precheck`, `listing_fields`, `_spec_like`,
// `_publish_texts`, `load_template`, `_system`, `_feedback`, `_refused_guardrail`.
// shortcut: bản riêng của nhóm kd_listing_live (pipelines/content chưa có port dùng chung — nhóm
// content có bản đầy đủ) — gom về một port `content` khi tách module dùng chung. Cấu hình guardrail +
// golden và `_FILLER_RE` lấy từ core.

export type Sku = Record<string, unknown>;
export type Golden = Map<string, Sku>;
export type ContentCfg = GuardrailRules;
export type Refusal = { code: string; reason: string };

export const LISTING_LEVELS = ['MO_TA', 'TP_THUONG', 'QC_DAY_DU'];
// Mã từ chối precheck → code violation guardrail tương ứng (mã khác giữ nguyên làm code).
const REFUSAL_CODE: Record<string, string> = { ruou: 'ruou_cam_quang_cao', xnqc: 'sku_chua_xnqc' };

/** Lỗi mang tên lớp ngoại lệ Python (thông điệp cấu hình hỏng in tên này). */
class PyErr extends Error {
  constructor(name: string) {
    super(name);
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

/** `content._cfg()` = `guardrail._load_rules(DATA_DIR)` (bản core: luật + golden ĐÃ kiểm). */
export const contentCfg = (dir: string = DATA_DIR): [ContentCfg, null] | [null, string] =>
  loadRules(dir);

/** Test: xóa cache cấu hình (Python `_load_rules` cache theo thư mục). */
export const resetContentCache = (): void => resetGuardrailCache();

/** Python `int(v)` cho giá trị JSON (bool → 0/1, float → cắt, chuỗi số) | lỗi ValueError/TypeError. */
function pyIntOf(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const t = pyStrip(v);
    if (/^[+-]?\d+(?:_\d+)*$/.test(t)) return Number(t.replaceAll('_', ''));
    throw new PyErr('ValueError');
  }
  throw new PyErr('TypeError');
}

/** `content._listing_rules()`: data/listing_rules.json đã kiểm → [kênh hợp lệ, null] | [null, lý do]. */
export function listingRules(
  path: string = dataPath('listing_rules.json'),
): [{ channels: string[] }, null] | [null, string] {
  try {
    const doc = readJson(path);
    const chans: string[] = [];
    for (const [ch, d] of Object.entries(obj(key(doc, 'channels')))) {
      const lim = ['title_max', 'desc_max', 'bullets_max', 'keywords_max'].map((k) =>
        pyIntOf(key(d, k)),
      );
      if (Math.min(...lim) < 1) throw new PyErr('ValueError');
      chans.push(ch);
    }
    const mp = pyStr(key(doc, 'missing_price'));
    const ma = pyStr(key(doc, 'missing_attr'));
    list(key(doc, 'brand_keywords'));
    if (!chans.length || !pyStrip(mp) || !pyStrip(ma)) throw new PyErr('ValueError');
    return [{ channels: chans }, null];
  } catch (e) {
    return [null, `listing_rules.json không dùng được (${errName(e)})`];
  }
}

const head = (v: unknown, n: number): string => Array.from(pyStr(v)).slice(0, n).join('');

/** `content.precheck`: từ chối TRƯỚC khi gọi LLM/ghi DB → {code, reason} | null. Rượu kiểm theo
 * category golden TRƯỚC readiness (map bị sửa thành QC_DAY_DU vẫn từ chối). */
export function precheck(
  sku: unknown,
  channel: unknown,
  contentType: unknown,
  readiness: ReadinessMap | null = null,
): Refusal | null {
  const [cfg, err] = contentCfg();
  if (err !== null || cfg === null) return { code: 'config', reason: err ?? 'config' };
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
    if (rerr !== null || rules === null) return { code: 'config', reason: rerr ?? 'config' };
    okCh = typeof ch === 'string' && rules.channels.includes(ch);
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
  const g = cfg.golden.get(s) as Sku;
  if (g.category === 'alcohol' && ctype.public !== false) {
    return {
      code: 'ruou',
      reason: `${s} là rượu — cấm quảng cáo/khuyến mại rượu (Luật 44/2019), không sinh nội dung/listing online`,
    };
  }
  const level =
    readiness !== null
      ? (readiness.get(readinessKey(s, String(ch))) ?? 'CAM')
      : goldenReadiness(s, String(ch));
  if (listing && !LISTING_LEVELS.includes(level)) {
    return {
      code: 'readiness',
      reason: `${s} mức ${level} trên kênh ${String(ch)} — chưa đủ điều kiện listing (golden allowed_channels / XNQC / tự công bố)`,
    };
  }
  if (ctype.ad && g.category === 'tpbvsk' && level !== 'QC_DAY_DU') {
    return {
      code: 'xnqc',
      reason: `${s} mức ${level} trên kênh ${String(ch)} — TPBVSK chưa có XNQC, không được làm nội dung quảng cáo`,
    };
  }
  return null;
}

/** `content.listing_fields` (phần xuất sàn dùng): tên, quy cách, số ĐKSP (chỉ TPBVSK) từ golden. */
export function listingFields(sku: string): {
  name: string;
  pack_spec: string | null;
  receipt_no: string | null;
} {
  const [cfg, err] = contentCfg();
  const g = cfg?.golden.get(sku);
  if (err !== null || !g || !Object.hasOwn(g, 'name')) throw new PyErr('KeyError');
  const opt = (v: unknown) => (v === undefined || v === null ? null : pyStr(v));
  return {
    name: pyStr(g.name),
    pack_spec: opt(g.pack_spec),
    receipt_no: g.category === 'tpbvsk' ? opt(g.receipt_no) : null,
  };
}

// ------------------------------------------------------------ chữ LLM chạm thông số

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

/** `content._spec_like`: câu LLM chạm thông số → true (bị loại). Ký tự số mọi loại hoặc khớp nhãn
 * khung/số viết bằng chữ/đơn vị, trên bản chuẩn hóa CÙNG guardrail và bản bỏ ký tự chèn.
 * shortcut: `isnumeric` của Python còn nhận chữ Hán số (五, 百…) — `\p{N}` của JS không; nâng khi có
 * nguồn câu ngoài tiếng Việt. */
export function specLike(s: string): boolean {
  if (NUMERIC.test(s)) return true;
  const t = fold(s.replace(CF_G, '').normalize('NFC')).normalize('NFC');
  return SPEC_RE.test(t) || SPEC_RE.test(sub(FILLER_RE, '', t));
}

// ------------------------------------------------------------ prompt / nhãn

/** `content._publish_texts`: (câu khuyến cáo chuẩn, nhãn AI, nhãn QC); file hỏng → ('', [], []). */
export function publishTexts(dir: string = DATA_DIR): [string, string[], string[]] {
  try {
    const doc = readJson(join(dir, 'guardrail_rules.json'));
    const canon = pyStrip(pyStr(key(key(doc, 'disclaimer'), 'canonical')));
    const labels = key(doc, 'labels');
    const ai = list(key(labels, 'ai'))
      .map(pyStr)
      .filter((x) => pyStrip(x));
    const ad = list(key(labels, 'ad'))
      .map(pyStr)
      .filter((x) => pyStrip(x));
    return [canon, ai, ad];
  } catch {
    return ['', [], []];
  }
}

/** `content.load_template`: [text, version, sha256] của `data/prompts/<name>.md`; sha tính sau
 * CRLF→LF, lệch manifest / thiếu file → RangeError (Python ValueError). */
export function loadTemplate(
  name: string,
  dir: string = dataPath('prompts'),
): [string, string, string] {
  let ver: string;
  let want: string;
  let raw: Buffer;
  try {
    const ent = key(key(readJson(join(dir, 'manifest.json')), 'templates'), name);
    ver = pyStr(key(ent, 'version'));
    want = pyStr(key(ent, 'sha256'));
    raw = readFileSync(join(dir, `${name}.md`));
  } catch (e) {
    const n = e instanceof JsonFileError || e instanceof PyErr ? errName(e) : 'FileNotFoundError';
    throw new RangeError(`template ${pyRepr(name)} không dùng được (${n})`);
  }
  const data = Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
  const sha = createHash('sha256').update(data).digest('hex');
  if (sha !== want) {
    throw new RangeError(
      `template ${pyRepr(name)} lệch sha256 manifest — template đổi mà chưa bump version`,
    );
  }
  return [pyStrip(new TextDecoder('utf-8', { fatal: true }).decode(data)), ver, sha];
}

/** `content._whitelist_block`: claims whitelist → đoạn nhét vào system prompt. */
function whitelistBlock(dir: string = DATA_DIR): string {
  const raw = JSON.parse(readFileSync(join(dir, 'claims_whitelist.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const lines: string[] = [];
  for (const [sku, v] of Object.entries(raw)) {
    if (!isPlainObject(v)) continue;
    const claims = Array.isArray(v.approved_claims) ? v.approved_claims : [];
    lines.push(
      claims.length
        ? `- ${sku}: ${claims.map(pyStr).join('; ')}`
        : `- ${sku}: CHƯA CÓ công dụng công bố — không được nêu công dụng`,
    );
  }
  return lines.join('\n');
}

/** `content._system`: system prompt. `priceRule=false` (listing/livestream) bỏ dòng "Liên hệ" — giá
 * do CODE dựng, câu đó chỉ xúi LLM tự viết giá. */
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
export function feedback(result: { violations?: unknown }): string {
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

/** `content._refused_guardrail`: kết quả guardrail ok=false mang mã từ chối. */
export function refusedGuardrail(ref: Refusal): GuardrailResult & Record<string, unknown> {
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

// ------------------------------------------------------------ ingest/market_csv (phần dùng chung)

export const MARKET_CHANNELS = ['shopee', 'tiktok'];
const INT_RE = /^(?:[0-9]+|[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*)$/;
const STRIP_RE = re(`[${S}₫]|(?:VND|vnđ|đ)(?=\\n?$)`, 'gi');

/** `market_csv._to_int`: số nguyên VND ("159000" | nhóm 3 chữ số cùng 1 dấu tách) ≤ `cap` | null. */
export function toInt(s: string | null | undefined, cap: number): number | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(STRIP_RE, '');
  if (Array.from(t).length > 25 || !INT_RE.test(t)) return null;
  const n = BigInt(t.replaceAll('.', '').replaceAll(',', ''));
  return n <= BigInt(cap) ? Number(n) : null;
}

/** `market_csv.load_mapping` → [mapping, null] | [null, lý do]. */
export function loadMapping(
  path: string = dataPath('market_csv_map.json'),
): [unknown, null] | [null, string] {
  try {
    return [readJson(path), null];
  } catch (e) {
    const n = e instanceof JsonFileError ? e.pyType : 'OSError';
    return [null, `không đọc được mapping ${path.split(/[\\/]/).pop()}: ${n}`];
  }
}
