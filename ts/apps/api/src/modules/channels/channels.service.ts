import { createHash, createHmac } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { isHealthQuestion } from '@samsam/core/ai/health';
import { type Env, pyStrip } from '@samsam/core/env';
import { type Db, dep } from '@samsam/core/ops/deps';
import * as director from '@samsam/core/ops/director';
import { cpLen, isPlainObject, readJson, squash } from '@samsam/core/ops/py';
import { isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName, RolloutBlocked, USABLE } from '@samsam/core/rollout/rollout';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii, PII_RE, scrubUser } from '@samsam/core/security/pii';
import {
  casefold,
  cpHead,
  D,
  finditer,
  pyReprValue,
  pySplit,
  pyStr,
  re,
  S,
  search,
  stripAccents,
  W,
} from '@samsam/core/security/py';

// Port `connectors/channels.py` (v5.1 WP07, KD-A1) — lớp kênh CSKH chung: Zalo, Messenger, Shopee,
// TikTok. Module THUẦN: không tự gửi gì ra ngoài, không gọi AI trực tiếp — câu trả lời RAG do
// caller truyền vào (`AnswerFn`, Python `api.rag.answer` import lười). Việc gửi là của adapter kênh
// (zalo/messenger); kênh sàn KHÔNG có adapter — chỉ CLI gợi ý để Quản lý MXH DÁN TAY trên Seller
// Center (chưa có API chat sàn — P2).
//
// Luồng 1 tin: `normalize` (kênh, user_hash có muối, text, ts) → `preRoute` (luật trước LLM, cùng
// cho 4 kênh: (1) câu đồng ý/rút đồng ý khớp TRỌN tin — chỉ zalo/messenger; (2) `isAlcohol` →
// template rượu; (3) `isHealthQuestion` → template sức khỏe; rượu đứng trước sức khỏe) → nếu không
// route: answer() → `formatReply` theo kênh (chat: y hệt Zalo cũ + nguồn; sàn: không nguồn, vi phạm
// `sanViolations` hoặc guardrail chặn → thay CẢ câu bằng `san_fallback`, không cắt-gọt).
//
// Ghi DB (chỉ kênh chat, SAU khi đã gửi trả lời; DB down → [warn], không ném): `recordHandoff` →
// `director.submit` loại `cskh_handoff` khối sales (payload cố định, KHÔNG câu hỏi/câu trả lời/
// user_id); `recordConsent` → bảng append-only `chat_consents` (chỉ khi khách gõ đồng ý TƯỜNG MINH).
// `user_hash` = HMAC-SHA256(muối env `CHANNEL_HASH_SALT`, "kênh:user_id")[:32]; thiếu muối → bỏ qua
// MỌI ghi (fail-closed: không có dòng = chưa đồng ý), không fallback hash không muối.
//
// `db: Db | null` thay Python `_connect()`: null = DB down / thiếu DSN (caller sở hữu pool).

export const settings = {
  configPath: dataPath('channels.json'),
  suitePath: dataPath('eval', 'suites', 'kd_a1.json'),
};

export const CHANNELS = ['zalo', 'messenger', 'shopee', 'tiktok'] as const;
export const CHAT_CHANNELS = ['zalo', 'messenger'];
export const SAN_CHANNELS = ['shopee', 'tiktok'];
export const MAX_INBOUND = 4000;
export const MAX_STDIN = 64_000;
export const MAX_BY_LEN = 100; // như ingest/golden_store.py
export const SALT_ENV = 'CHANNEL_HASH_SALT';
export const MIN_SALT_LEN = 16; // muối ngắn = dò ngược được → coi như thiếu
export const AGENT_ID = 'agent:kd_a1';
export const HANDOFF_TYPE = 'cskh_handoff';
// Mã lý do → nhãn ghi trong payload/title. KHÔNG ghi chữ 'alcohol'/'rượu': guardrail soi luật rượu
// trên payload → mục không đóng được.
export const HANDOFF_REASONS: Record<string, string> = {
  alcohol: 'san_pham_han_che',
  health: 'suc_khoe',
  no_data: 'thieu_du_lieu',
  guardrail: 'kiem_duyet',
  rollout: 'chua_van_hanh',
  // v13.7: quá hạn 30 giây (PL02 mục 2) → người trả lời.
  deadline: 'qua_han_tra_loi',
};
// v13.3 (HĐ 6.7): chatbot = tính năng sales-01; chưa vận hành → câu bot thành gợi ý `cskh_reply`.
export const CHATBOT_FEATURE = 'sales-01';
export const CHAT_FEATURE = 'sales-01';
export const SUGGEST_FEATURE = 'sales-02';
export const SUGGEST_TYPE = 'cskh_reply';
export const CONSENT_ACTIONS = ['prompted', 'granted', 'withdrawn'];
export const TEMPLATE_KEYS = [
  'alcohol',
  'alcohol_san',
  'health',
  'health_san',
  'consent_prompt',
  'consent_ack',
  'consent_withdrawn_ack',
  'consent_withdrawn_fail',
  'san_fallback',
  'san_handoff',
];
export const EVAL_REAL_KINDS = ['fact', 'fact_san', 'trap_san'];
export const EVAL_REAL_BUDGET_USD = 0.05;
export const SUGGEST_STAGES = ['chay_thu', 'co_nguoi_duyet', 'van_hanh'];

// Câu cố định của `api/rag.py` (NO_DATA) và `connectors/zalo.py` (FALLBACK, HANDOFF_TEXT) — bản TS
// của RAG/zalo phải dùng CHÍNH các hằng này (một bản duy nhất).
export const NO_DATA = 'Chưa đủ dữ liệu để trả lời.';
export const FALLBACK =
  'Sâm Sâm xin lỗi, câu trả lời tự động chưa đạt kiểm duyệt nội ' +
  'bộ. Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.';
export const HANDOFF_TEXT =
  'Sâm Sâm chưa đủ dữ liệu để trả lời câu này — nhân ' +
  'viên sẽ phản hồi sớm nhất. Quý khách cần gấp vui lòng ' +
  'gọi hotline 1800577732 để được hỗ trợ.';

// Đồng ý (sau bỏ dấu + casefold + bỏ dấu câu + bỏ từ lễ/xưng hô) phải còn ĐÚNG "dong y". Rút đồng ý
// nới hơn: tin ngắn ≤ 6 từ có phủ định/"rút"/"hủy" ĐỨNG TRƯỚC "dong y", không kết bằng từ hỏi.
const FILLER = new Set([
  'a',
  'da',
  'vang',
  'nhe',
  'nha',
  'minh',
  'toi',
  'em',
  'con',
  'chau',
  'roi',
]);
const NEG = new Set(['khong', 'ko', 'k', 'kg', 'khg', 'kh', 'hong', 'hok', 'khum']);
const WITHDRAW_VERBS = new Set(['rut', 'huy']);
const WITHDRAW_MAX_WORDS = 6;
const PUNCT_RE = re(`[^${W}${S}]|_`, 'g');

// --- Luật kênh sàn (chính sách Shopee/TikTok: không dẫn khách ra ngoài) ---
const NOT_W = `(?![${W}])`;
const URL_RE = re(`https?://|(?<![${W}])www\\.`, 'i');
// `(?<![\w-])` (không `\b`): chỉ bắt đầu ở ĐẦU 1 cụm [\w-] — `\b` cho phép bắt đầu sau mỗi '-' →
// "a-a-a-..." backtrack bậc hai (probe v5.1).
export const DOMAIN_RE = re(
  `(?<![${W}\\-])[${W}\\-]+\\.(?:com|vn|net|org|me|info|shop|store|online|site|io)${NOT_W}`,
  'i',
);
// Tổng đài 1800/1900 (không bắt đầu bằng 0 nên PII_RE không bắt).
const HOTLINE_RE = re(`(?<!${D})1[89]00(?:[ .\\-]?${D}){4,6}(?!${D})`);
const ZALO_RE = re(`(?<![${W}])zalo${NOT_W}`);
const FB_RE = re(`(?<![${W}])(?:facebook|fanpage|messenger|inbox page)${NOT_W}`);
// Địa chỉ cửa hàng (so trên bản bỏ dấu). "địa chỉ" trần KHÔNG tính — "địa chỉ nhận hàng" hợp lệ.
const ADDR_RE = re(
  `(?<![${W}])(?:showroom|cua hang tai|ghe cua hang` +
    `|dia chi[${S}]*(?::|cua hang|showroom|cong ty|van phong|shop))`,
);
const PII_G = new RegExp(PII_RE.source, `${PII_RE.flags}g`);

/** data/channels.json thiếu/hỏng/sai cấu trúc (Python ValueError). */
export class ChannelConfigError extends RangeError {
  override name = 'ChannelConfigError';
}

export type Channel = (typeof CHANNELS)[number];
export type Inbound = { channel: string; userHash: string | null; text: string; ts: string };
export type Route = { kind: string; text: string; handoff: string | null };
/** prefix: câu chào + chính sách ("" = không); block: KHÔNG gọi answer(); prompted: ghi 'prompted'. */
export type Gate = { prefix: string; block: boolean; prompted: boolean };
export type ChannelConfig = {
  policy_url: string;
  policy_version: string;
  require_consent_for_llm: boolean;
  templates: Record<string, string>;
} & Record<string, unknown>;
export type AnswerResult = { answer: string; sources?: string[] | null; handoff?: string | null };
/** Python `api.rag.answer(question, feature=...)` — bản TS do module RAG cung cấp. */
export type AnswerFn = (question: string, opts: { feature: string }) => Promise<AnswerResult>;
export type Reply = {
  answer: string;
  route: string | null;
  handoff: string | null;
  blocked: string[];
};
export type Meta = { guardrail_ok: unknown; handoff: string | null; blocked: string[] };

let cfgCache: [string, bigint, ChannelConfig] | null = null;

export function resetCache(): void {
  cfgCache = null;
}

export function warn(msg: string): void {
  console.log(`[warn] channels: ${msg}`);
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Đọc + validate `data/channels.json` (cache theo mtime). Lỗi → ChannelConfigError nêu rõ key. */
export function loadConfig(path: string = settings.configPath): ChannelConfig {
  const name = basename(path);
  let mtime: bigint;
  try {
    mtime = statSync(path, { bigint: true }).mtimeNs;
  } catch {
    throw new ChannelConfigError(`không có ${name}`);
  }
  if (cfgCache && cfgCache[0] === path && cfgCache[1] === mtime) return cfgCache[2];
  let cfg: unknown;
  try {
    cfg = readJson(path);
  } catch (e) {
    const t = (e as { pyType?: string }).pyType ?? 'OSError';
    throw new ChannelConfigError(`${name} hỏng: ${t === 'FileNotFoundError' ? 'OSError' : t}`);
  }
  if (!isPlainObject(cfg)) throw new ChannelConfigError(`${name}: không phải object JSON`);
  for (const k of ['policy_url', 'policy_version']) {
    const v = cfg[k];
    if (!isStr(v) || !pyStrip(v)) throw new ChannelConfigError(`${name}: thiếu '${k}'`);
  }
  if (typeof cfg.require_consent_for_llm !== 'boolean') {
    throw new ChannelConfigError(`${name}: 'require_consent_for_llm' phải true/false`);
  }
  const tpl = cfg.templates;
  if (!isPlainObject(tpl)) throw new ChannelConfigError(`${name}: thiếu 'templates'`);
  for (const k of TEMPLATE_KEYS) {
    const v = tpl[k];
    if (!isStr(v) || !pyStrip(v)) throw new ChannelConfigError(`${name}: thiếu template '${k}'`);
  }
  const prompt = tpl.consent_prompt as string;
  if (!prompt.includes('{policy_url}')) {
    throw new ChannelConfigError(`${name}: consent_prompt phải chứa {policy_url}`);
  }
  // replaceAll (không format): ngoặc nhọn khác trong text không crash.
  const out = {
    ...cfg,
    templates: {
      ...(tpl as Record<string, string>),
      consent_prompt: prompt.replaceAll('{policy_url}', pyStrip(cfg.policy_url as string)),
    },
  } as unknown as ChannelConfig;
  cfgCache = [path, mtime, out];
  return out;
}

export function template(key: string): string {
  const t = loadConfig().templates[key];
  if (t === undefined) throw new RangeError(`template lạ '${key}'`);
  return t;
}

function salt(env: Env): string {
  const s = pyStrip(env[SALT_ENV] ?? '');
  return cpLen(s) >= MIN_SALT_LEN ? s : '';
}

/** HMAC-SHA256(muối, "kênh:user_id") 32 hex. Thiếu/ngắn muối → null. */
export function userHash(channel: string, userId: string, env: Env = process.env): string | null {
  const s = salt(env);
  if (!s) return null;
  return createHmac('sha256', s).update(`${channel}:${userId}`, 'utf8').digest('hex').slice(0, 32);
}

/** Thời điểm UTC dạng `YYYY-MM-DDTHH:MM:SSZ` (Python `_iso`). */
export function isoTs(ts: Date = new Date()): string {
  return `${ts.toISOString().slice(0, 19)}Z`;
}

const pyTuple = (xs: readonly string[]) => `(${xs.map((x) => `'${x}'`).join(', ')})`;

function checkChannel(channel: string): void {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new RangeError(`kênh '${channel}' không hỗ trợ — ${pyTuple(CHANNELS)}`);
  }
}

/** Chuẩn hóa tin vào. Kênh lạ → RangeError; text NFC + strip + cắt MAX_INBOUND ký tự; ts ISO UTC. */
export function normalize(
  channel: string,
  userId: unknown,
  text: unknown,
  ts?: Date,
  env: Env = process.env,
): Inbound {
  checkChannel(channel);
  const t = cpHead(pyStrip((isStr(text) ? text : '').normalize('NFC')), MAX_INBOUND);
  return { channel, userHash: userHash(channel, pyStr(userId), env), text: t, ts: isoTs(ts) };
}

/** 'granted' | 'withdrawn' | null — đồng ý phải khớp TRỌN "đồng ý" (trừ từ lễ/xưng hô); rút đồng ý:
 * tin ngắn có phủ định/rút/hủy trước "đồng ý", không phải câu hỏi. */
export function parseConsent(text: unknown): 'granted' | 'withdrawn' | null {
  if (!isStr(text)) return null;
  const t = stripAccents(casefold(text.normalize('NFC')));
  const words = pySplit(t.replace(PUNCT_RE, ' ')).filter((w) => !FILLER.has(w));
  if (words.length === 2 && words[0] === 'dong' && words[1] === 'y') return 'granted';
  if (words.length < 3 || words.length > WITHDRAW_MAX_WORDS || NEG.has(words.at(-1) as string)) {
    return null;
  }
  for (let i = 1; i < words.length - 1; i++) {
    if (
      words[i] === 'dong' &&
      words[i + 1] === 'y' &&
      words.slice(0, i).some((w) => NEG.has(w) || WITHDRAW_VERBS.has(w))
    ) {
      return 'withdrawn';
    }
  }
  return null;
}

/** Luật trước LLM (thứ tự cố định). null = đi tiếp answer(). */
export function preRoute(inb: Inbound): Route | null {
  const san = SAN_CHANNELS.includes(inb.channel);
  if (!san) {
    const c = parseConsent(inb.text);
    if (c === 'granted')
      return { kind: 'consent_granted', text: template('consent_ack'), handoff: null };
    if (c === 'withdrawn') {
      return { kind: 'consent_withdrawn', text: template('consent_withdrawn_ack'), handoff: null };
    }
  }
  if (isAlcohol(inb.text)) {
    return { kind: 'alcohol', text: template(san ? 'alcohol_san' : 'alcohol'), handoff: 'alcohol' };
  }
  if (isHealthQuestion(inb.text)) {
    return { kind: 'health', text: template(san ? 'health_san' : 'health'), handoff: 'health' };
  }
  return null;
}

/** Mã vi phạm chính sách sàn trong `text` (rỗng = sạch): url, domain, phone, email, zalo, facebook,
 * dia_chi. */
export function sanViolations(text: unknown): string[] {
  if (!isStr(text) || !text) return [];
  const t = text.normalize('NFC');
  const plain = stripAccents(casefold(t));
  const out: string[] = [];
  if (search(URL_RE, t)) out.push('url');
  if (search(DOMAIN_RE, t)) out.push('domain');
  // SĐT: tái dùng maskPii (có bóc ngoặc — "(0235) 3699 899" mà PII_RE thô bỏ lọt); email bỏ trước
  // để tách mã. So "***" (maskPii đổi "(2)" → " 2 ").
  const emails = finditer(PII_RE, t).filter((m) => m[0].includes('@'));
  const rest = t.replaceAll('*', ' ').replace(PII_G, (m) => (m.includes('@') ? ' ' : m));
  if (maskPii(rest).includes('***') || search(HOTLINE_RE, t)) out.push('phone');
  if (emails.length) out.push('email');
  if (search(ZALO_RE, plain)) out.push('zalo');
  if (search(FB_RE, plain)) out.push('facebook');
  if (search(ADDR_RE, plain)) out.push('dia_chi');
  return out;
}

/** Kết quả answer() → [text gửi khách, meta]. Guardrail chạy ĐÚNG 1 lần trên câu gốc (trước khi
 * nối nguồn — slug URL không flag oan). */
export function formatReply(channel: string, res: AnswerResult): [string, Meta] {
  checkChannel(channel);
  const san = SAN_CHANNELS.includes(channel);
  const raw = res.answer;
  const sources = res.sources ?? [];
  const ok = dep('guardrailCheck')(raw).ok;
  const meta: Meta = { guardrail_ok: ok, handoff: null, blocked: [] };
  const hand = res.handoff;
  if (hand === 'alcohol' || hand === 'health') {
    // Lớp 2: answer() tự nhận ra rượu/sức khỏe (vd câu rewrite theo history) → vẫn template cố định.
    meta.handoff = hand;
    return [template(san ? `${hand}_san` : hand), meta];
  }
  if (!ok) {
    meta.handoff = 'guardrail';
    meta.blocked = ['guardrail'];
    return [san ? template('san_fallback') : FALLBACK, meta];
  }
  if (raw.includes(NO_DATA)) {
    meta.handoff = 'no_data';
    return [san ? template('san_handoff') : HANDOFF_TEXT, meta];
  }
  if (san) {
    const v = sanViolations(raw);
    if (v.length) {
      meta.blocked = v;
      return [template('san_fallback'), meta];
    }
    return [raw, meta];
  }
  return [sources.length ? `${raw}\nNguồn: ${sources[0]}` : raw, meta];
}

// --- DB: consent + handoff (chỉ kênh chat) -----------------------------------

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function ref(msgId: unknown): string | null {
  return msgId ? sha256(pyStr(msgId)).slice(0, 16) : null;
}

/** Python `type(e).__name__` của lỗi psycopg (chỉ tên lớp — không chi tiết/DSN). */
export function errName(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  if (code === '23505') return 'UniqueViolation';
  if (code === '23514') return 'CheckViolation';
  return pgErrName(e);
}

/** Tên lớp lỗi (Python `type(e).__name__`) — lớp con không tự đặt `name` vẫn ra tên lớp. */
export function pyType(e: unknown): string {
  return (e as object)?.constructor?.name ?? 'Exception';
}

/** 'none' | 'prompted' | 'granted' | 'withdrawn' — dòng mới nhất theo id. */
export async function consentState(db: Db, channel: string, uh: string): Promise<string> {
  const { rows } = await db.query<{ action: string }>(
    'select action from chat_consents where user_hash = $1 and channel = $2 order by id desc limit 1',
    [uh, channel],
  );
  return rows[0]?.action ?? 'none';
}

/** consentState an toàn: thiếu muối / DB down / lỗi → 'unknown'. */
async function state(inb: Inbound, db: Db | null): Promise<string> {
  if (inb.userHash === null || db === null) return 'unknown';
  try {
    return await consentState(db, inb.channel, inb.userHash);
  } catch (e) {
    if (!isDbError(e)) throw e;
    warn(`đọc chat_consents lỗi ${errName(e)}`);
    return 'unknown';
  }
}

/** Quyết tiền tố câu chào/chặn LLM cho tin KHÔNG khớp preRoute. Sàn: không consent. Cờ
 * `require_consent_for_llm` bật → chưa granted (kể cả không biết vì DB down/thiếu muối) = chặn
 * (fail-closed). Cờ tắt → tin đầu (none) có tiền tố + ghi prompted; không biết → [warn], trả lời
 * không tiền tố. Khách đã RÚT đồng ý → chặn LLM BẤT KỂ cờ (chỉ gửi câu chào). */
export async function consentGate(inb: Inbound, db: Db | null): Promise<Gate> {
  if (!CHAT_CHANNELS.includes(inb.channel)) return { prefix: '', block: false, prompted: false };
  const require = loadConfig().require_consent_for_llm;
  const st = await state(inb, db);
  if (st === 'granted') return { prefix: '', block: false, prompted: false };
  const prompt = template('consent_prompt');
  if (require || st === 'withdrawn')
    return { prefix: prompt, block: true, prompted: st === 'none' };
  if (st === 'unknown') {
    warn(
      `không xác định được đồng ý (${inb.channel}) — thiếu ${SALT_ENV} hoặc DB down; trả lời không tiền tố`,
    );
    return { prefix: '', block: false, prompted: false };
  }
  if (st === 'none') return { prefix: prompt, block: false, prompted: true };
  return { prefix: '', block: false, prompted: false };
}

/** Ghi 1 dòng append-only chat_consents → id | null (sàn / thiếu muối / DB down — warn, không ném). */
export async function recordConsent(
  inb: Inbound,
  action: string,
  msgId: string,
  db: Db | null,
): Promise<bigint | null> {
  if (!CONSENT_ACTIONS.includes(action)) {
    throw new RangeError(`action '${action}' không hợp lệ — ${pyTuple(CONSENT_ACTIONS)}`);
  }
  if (!CHAT_CHANNELS.includes(inb.channel)) return null;
  if (inb.userHash === null) {
    warn(`thiếu ${SALT_ENV} — không ghi đồng ý (${action})`);
    return null;
  }
  if (db === null) {
    warn(`DB down — không ghi đồng ý (${action})`);
    return null;
  }
  try {
    const { rows } = await db.query<{ id: string }>(
      'insert into chat_consents (user_hash, channel, action, policy_version, evidence_ref)' +
        ' values ($1, $2, $3, $4, $5) returning id',
      [inb.userHash, inb.channel, action, loadConfig().policy_version, ref(msgId)],
    );
    return BigInt(rows[0]?.id as string);
  } catch (e) {
    if (!isDbError(e)) throw e;
    warn(`ghi chat_consents lỗi ${errName(e)}`);
    return null;
  }
}

/** Payload CỐ ĐỊNH — không câu hỏi/câu trả lời/user_id/psid. */
export function handoffPayload(inb: Inbound, reason: string, msgId = '', slaHours = 2): string {
  return (
    `kênh=${inb.channel}; lý do=${HANDOFF_REASONS[reason]}; ` +
    `user_hash=${inb.userHash}; msg_ref=${ref(msgId) ?? '-'}; ` +
    `ts=${inb.ts}; sla=${Math.trunc(slaHours)}h`
  );
}

/** Tạo mục `cskh_handoff` (khối sales) → id | null. Sàn / thiếu muối / DB down / tính năng TẮT →
 * null + log, không ném. Đã có mục chờ cùng khách → id mục đó. r12 L3: caller chỉ được hứa "nhân
 * viên sẽ phản hồi" khi kết quả khác null. */
export async function recordHandoff(
  inb: Inbound,
  reason: string,
  msgId: string,
  db: Db | null,
): Promise<bigint | null> {
  if (!Object.hasOwn(HANDOFF_REASONS, reason)) {
    throw new RangeError(
      `lý do '${reason}' không hợp lệ — [${Object.keys(HANDOFF_REASONS)
        .sort()
        .map((k) => `'${k}'`)
        .join(', ')}]`,
    );
  }
  if (!CHAT_CHANNELS.includes(inb.channel)) return null;
  if (inb.userHash === null) {
    warn(`thiếu ${SALT_ENV} — không tạo mục handoff (${reason})`);
    return null;
  }
  let cfg: director.DirectorConfig;
  let sla: number;
  try {
    cfg = director.loadConfig('sales');
    const spec = cfg.object_types[HANDOFF_TYPE];
    if (spec === undefined) throw new RangeError('KeyError');
    sla = spec.sla_hours;
  } catch (e) {
    const n = e instanceof director.DirectorConfigError ? 'DirectorConfigError' : 'KeyError';
    warn(`cấu hình sales thiếu ${HANDOFF_TYPE} (${n})`);
    return null;
  }
  if (db === null) {
    warn(`DB down — không tạo mục handoff (${reason})`);
    return null;
  }
  const objectId = `${inb.channel}:${inb.userHash}`;
  try {
    return await director.submit(db, {
      block: 'sales',
      objectType: HANDOFF_TYPE,
      objectId,
      title: `Handoff ${HANDOFF_REASONS[reason]} — ${inb.channel}`,
      payload: handoffPayload(inb, reason, msgId, sla),
      createdBy: AGENT_ID,
      cfg,
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      console.log(
        `[handoff] ${inb.channel}: đã có mục chờ cho khách (uh=${inb.userHash.slice(0, 12)}) — không nhân đôi`,
      );
      try {
        const { rows } = await db.query<{ id: string }>(
          "select id from approval_queue where object_type = $1 and object_id = $2 and status = 'pending'",
          [HANDOFF_TYPE, objectId],
        );
        return rows[0] ? BigInt(rows[0].id) : null;
      } catch (e2) {
        if (isDbError(e2)) return null;
        throw e2;
      }
    }
    if (e instanceof RolloutBlocked) {
      // r12 L3: chatbot TẮT → không có người nhận việc.
      warn(`không tạo mục handoff (${reason}): ${e.message}`);
      return null;
    }
    if (isDbError(e)) {
      warn(`tạo mục handoff lỗi ${errName(e)}`);
      return null;
    }
    throw e;
  }
}

/** Giai đoạn triển khai của chatbot (HĐ 6.7). DB down / chưa vào sổ → 'chay_thu' (fail-closed). */
export async function chatbotMode(db: Db | null): Promise<string> {
  const ro = dep('rollout');
  return ro.quickMode() ?? (await ro.mode(db, CHATBOT_FEATURE));
}

/** Câu bot CHƯA gửi → mục `cskh_reply` khối sales (payload = câu sẽ gửi, đã che PII; không câu
 * hỏi/user_id) → id | null. Dòng "Nguồn: <url>" làm guardrail bắt oan slug → lưu câu gốc `raw`.
 * v15 (P9.4): che bằng `scrubUser` (SĐT/email + tên + địa chỉ); còn dấu hiệu PII chưa che chắc (hoặc
 * từ điển tên hỏng) → KHÔNG ghi (null + warn), khách vẫn có mục handoff. */
export async function recordSuggestion(
  inb: Inbound,
  text: string,
  msgId: string,
  db: Db | null,
  raw: string | null = null,
): Promise<bigint | null> {
  if (!CHAT_CHANNELS.includes(inb.channel) || inb.userHash === null) return null;
  let [payload, risky] = scrubUser(text);
  if (raw !== null && !dep('guardrailCheck')(payload).ok) [payload, risky] = scrubUser(raw);
  if (risky) {
    warn('câu gợi ý còn dấu hiệu PII chưa che — không lưu gợi ý');
    return null;
  }
  if (db === null) {
    warn('DB down — không lưu gợi ý trả lời');
    return null;
  }
  const r = ref(msgId || `${inb.ts}:${inb.text}`);
  try {
    return await director.submit(db, {
      block: 'sales',
      objectType: SUGGEST_TYPE,
      objectId: `${inb.channel}:${inb.userHash}:${r}`,
      title: `Gợi ý trả lời ${inb.channel} — msg_ref ${r}`,
      payload,
      createdBy: AGENT_ID,
    });
  } catch (e) {
    if (isDbError(e)) {
      warn(`lưu gợi ý trả lời lỗi ${errName(e)}`);
      return null;
    }
    if (e instanceof RangeError || e instanceof director.DirectorConfigError) {
      warn(`không lưu gợi ý trả lời: ${pyType(e)}`);
      return null;
    }
    throw e;
  }
}

// --- Hàm thuần dùng chung CLI sàn + eval ------------------------------------

/** preRoute → answer() → formatReply, KHÔNG gửi, KHÔNG history. persist → mục handoff (chỉ kênh
 * chat). Vá F1: mã tính năng theo KÊNH — sàn → sales-02, chat → sales-01. */
export async function respond(
  channel: string,
  userId: string,
  text: string,
  o: { answer: AnswerFn | null; persist?: boolean; db?: Db | null; env?: Env },
): Promise<Reply> {
  const inb = normalize(channel, userId, text, undefined, o.env);
  const route = preRoute(inb);
  let out: Reply;
  if (route !== null) {
    out = { answer: route.text, route: route.kind, handoff: route.handoff, blocked: [] };
  } else {
    // Python import lười `api.rag.answer`: thiếu → lỗi ở đúng chỗ gọi (CLI bắt → câu chuyển nhân viên).
    if (o.answer === null) throw new Error('answer() chưa nối (module RAG)');
    const feature = SAN_CHANNELS.includes(inb.channel) ? SUGGEST_FEATURE : CHAT_FEATURE;
    const [txt, meta] = formatReply(channel, await o.answer(inb.text, { feature }));
    out = { answer: txt, route: null, handoff: meta.handoff, blocked: meta.blocked };
  }
  if (o.persist && out.handoff) await recordHandoff(inb, out.handoff, '', o.db ?? null);
  return out;
}

/** Regex Python (`re.search` của bộ ca eval) → RegExp JS cùng nghĩa: `(?i)` đầu mẫu, `\d \w \s \b`
 * Unicode, `$` khớp trước '\n' cuối, escape thừa (`\ `, `\-`) của `re.escape`.
 * shortcut: chỉ cờ đầu mẫu `(?i)`; cờ khác/nhóm cờ giữa mẫu → RangeError, nâng khi bộ ca cần. */
export function pyRegex(src: string): RegExp {
  let flags = 'u';
  let s = src;
  const m = /^\(\?([a-zA-Z]+)\)/.exec(s);
  if (m) {
    if (m[1] !== 'i') throw new RangeError(`cờ regex '${m[1]}' chưa hỗ trợ`);
    flags += 'i';
    s = s.slice(m[0].length);
  }
  const cls: Record<string, [string, string]> = {
    d: [D, `[${D}]`],
    w: [W, `[${W}]`],
    s: [S, `[${S}]`],
    D: ['', `[^${D}]`],
    W: ['', `[^${W}]`],
    S: ['', `[^${S}]`],
  };
  let out = '';
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '\\') {
      const x = s[++i];
      if (x === undefined) throw new RangeError('regex kết thúc bằng \\');
      const k = cls[x];
      if (k) {
        if (inClass && !k[0]) throw new RangeError(`\\${x} trong lớp ký tự chưa hỗ trợ`);
        out += inClass ? k[0] : k[1];
      } else if (x === 'b' && !inClass) out += `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
      else if (x === 'B' && !inClass) out += `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))`;
      else if (x === 'A' && !inClass) out += '^';
      else if (x === 'Z' && !inClass) out += '$';
      else if ('^$\\.*+?()[]{}|/'.includes(x)) out += `\\${x}`;
      else if (x === '-') out += inClass ? '\\-' : '-';
      else if (/[0-9a-zA-Z]/.test(x)) out += `\\${x}`;
      else out += x;
    } else if (c === '[' && !inClass) {
      inClass = true;
      out += c;
      if (s[i + 1] === '^') out += s[++i];
      if (s[i + 1] === ']') {
        out += '\\]';
        i++;
      }
    } else if (c === ']' && inClass) {
      inClass = false;
      out += c;
    } else if (c === '$' && !inClass) out += '(?=\\n?$)';
    else out += c;
  }
  return new RegExp(out, flags);
}

type Case = Record<string, unknown> & { expect?: Record<string, unknown> | null };

/** Scorer `cskh`: mọi khóa expect phải đạt; ca kênh sàn tự kiểm thêm sanViolations == [].
 * content=false (lần chạy LLM thật): chỉ kiểm route/forbid_regex/vi phạm sàn. */
export function scoreCskh(
  c: Case,
  out: Record<string, unknown>,
  content = true,
): [boolean, string] {
  const exp = c.expect || {};
  // Python `str(out.get("answer", ""))`: khóa có mà None → 'None'.
  const ans = pyStr(out.answer === undefined ? '' : out.answer);
  const errs: string[] = [];
  const got = (k: string) => (out[k] === undefined ? null : out[k]);
  if ('route' in exp && got('route') !== exp.route) errs.push(`route=${pyReprValue(got('route'))}`);
  if (content && 'handoff' in exp && got('handoff') !== exp.handoff) {
    errs.push(`handoff=${pyReprValue(got('handoff'))}`);
  }
  if (content && 'text_regex' in exp && !pyRegex(String(exp.text_regex)).test(ans)) {
    errs.push('không khớp text_regex');
  }
  if ('forbid_regex' in exp && pyRegex(String(exp.forbid_regex)).test(ans)) {
    errs.push('khớp forbid_regex');
  }
  const calls = (out.llm_calls as number | undefined) ?? 0;
  if (content && 'max_llm_calls' in exp && calls > (exp.max_llm_calls as number)) {
    errs.push(`llm_calls=${pyStr(out.llm_calls ?? null)}`);
  }
  if (SAN_CHANNELS.includes(c.channel as string)) {
    const v = sanViolations(ans);
    if (v.length) errs.push(`vi phạm sàn [${v.map((x) => `'${x}'`).join(', ')}]`);
  }
  return [!errs.length, errs.join('; ')];
}

// --- Gợi ý chat sàn (sales-02, v14.3 — HĐ 6.7/PL02 mục 1) -------------------

const HANDOFF_RE = /^[a-z_]{1,40}$/;

/** Khóa tin buyer KHÔNG chứa tin: sha256(tin đã che PII, gộp khoảng trắng, casefold)[:32] — cùng
 * câu hỏi gợi ý lại = 1 đầu ra. */
export function suggestionRef(text: string): string {
  return sha256(casefold(squash(maskPii(pyStr(text))))).slice(0, 32);
}

/** 1 dòng `san_suggestions` → id | null (DB down / lỗi → [warn], không chặn việc in gợi ý). Không
 * lưu tin buyer. docx P1: câu gợi ý qua `scrubUser`; còn dấu hiệu PII / từ điển tên hỏng → KHÔNG
 * ghi (null + warn), gợi ý vẫn in. */
export async function recordSanSuggestion(
  db: Db | null,
  channel: string,
  text: string,
  out: { answer?: unknown; handoff?: unknown },
  stage: string,
  by: string,
): Promise<bigint | null> {
  if (db === null) {
    warn('DB down — gợi ý không được ghi (không đếm đầu ra)');
    return null;
  }
  const [scrubbed, risky] = scrubUser(pyStr(out.answer || ''));
  if (risky) {
    warn('gợi ý còn dấu hiệu PII chưa che — không ghi (không đếm đầu ra)');
    return null;
  }
  const answer = cpHead(pyStrip(scrubbed), MAX_INBOUND);
  if (!SAN_CHANNELS.includes(channel) || !SUGGEST_STAGES.includes(stage) || !answer) return null;
  const ok = Boolean(dep('guardrailCheck')(answer).ok) && !sanViolations(answer).length;
  const ho = isStr(out.handoff) && HANDOFF_RE.test(out.handoff) ? out.handoff : null;
  try {
    const { rows } = await db.query<{ id: string }>(
      'insert into san_suggestions (channel, msg_ref, answer, handoff, guardrail_ok, stage, created_by)' +
        ' values ($1, $2, $3, $4, $5, $6, $7) returning id',
      [channel, suggestionRef(text), answer, ho, ok, stage, cpHead(pyStrip(by), MAX_BY_LEN)],
    );
    return BigInt(rows[0]?.id as string);
  } catch (e) {
    if (!isDbError(e)) throw e;
    warn(`không ghi được gợi ý (${errName(e)}) — không đếm đầu ra`);
    return null;
  }
}

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** v13 vá review (F03): đọc giai đoạn `sales-02`. `tat` → không gọi AI, exit 2. Chưa vận hành (chạy
 * thử / DB down = fail-closed) → vẫn soạn để đánh giá nội bộ nhưng in nhãn KHÔNG dán gửi khách.
 * v14.3: có `by` (CLI luôn có) → ghi đầu ra `san_suggestions` để đếm. */
export async function suggest(
  db: Db | null,
  channel: string,
  text: string,
  by: string | null,
  o: { answer: AnswerFn | null; respondFn?: typeof respond; env?: Env; io?: Io },
): Promise<number> {
  const io = o.io ?? STD_IO;
  const ro = dep('rollout');
  const md = ro.quickMode() || (await ro.mode(db, SUGGEST_FEATURE));
  if (md === 'tat') {
    io.err(
      `[blocked] tính năng ${SUGGEST_FEATURE} (gợi ý chat sàn) đang TẮT — không soạn gợi ý (HĐ 6.7)`,
    );
    return 2;
  }
  let out: Reply;
  try {
    out = await (o.respondFn ?? respond)(channel, 'cli:mxh', text, {
      answer: o.answer,
      env: o.env,
    });
  } catch (e) {
    // gateway chặn/DB lỗi: vẫn có câu dán
    warn(`answer() lỗi ${pyType(e)} — dùng câu chuyển nhân viên`);
    out = { answer: template('san_handoff'), route: null, handoff: 'no_data', blocked: [] };
  }
  const sid = by ? await recordSanSuggestion(db, channel, text, out, md, by) : null;
  const usable = USABLE.includes(md);
  if (!usable) {
    io.out(
      `[CHẠY THỬ — CHỈ ĐÁNH GIÁ NỘI BỘ, chưa được dùng: KHÔNG dán gửi khách (${SUGGEST_FEATURE} chưa vận hành, HĐ 6.7)]`,
    );
  }
  io.out('[GỢI Ý — NHÁP, MXH đọc/sửa trước khi DÁN TAY trên Seller Center]');
  io.out(out.answer);
  if (out.handoff) io.out(`handoff=${out.handoff}`);
  if (out.blocked?.length) io.out(`blocked=${out.blocked.join(',')}`);
  if (sid !== null && usable) {
    io.out(`[đầu ra #${sid}] dán xong → channels --mark-sent ${sid} --by '<tên MXH>'`);
  } else if (sid !== null) {
    io.out(`[đầu ra #${sid}] ghi nội bộ (chạy thử) — không đánh dấu đã gửi được`);
  }
  return 0;
}

/** NGƯỜI MXH xác nhận đã dán gửi gợi ý #sid → `san_suggestion_uses`. Exit 0 ok/đã đánh dấu, 1 từ
 * chối, 2 DB down/lỗi DB. */
export async function markSent(
  db: Db | null,
  sid: bigint,
  by: string,
  io: Io = STD_IO,
): Promise<number> {
  if (db === null) {
    io.err('[FAIL] DB không kết nối được (DATABASE_URL)');
    return 2;
  }
  const who = pyStrip(by);
  try {
    const { rows } = await db.query<{ guardrail_ok: boolean; stage: string }>(
      'select guardrail_ok, stage from san_suggestions where id = $1',
      [String(sid)],
    );
    const row = rows[0];
    if (!row) {
      io.err(`[TỪ CHỐI] không có gợi ý #${sid}`);
      return 1;
    }
    const ro = dep('rollout');
    let why = await dep('auth').cliGate(
      db,
      by,
      'sales',
      'verify',
      'san_suggestion',
      String(sid),
      {},
    );
    if (why === null && !row.guardrail_ok) {
      why = 'gợi ý không qua guardrail/luật kênh sàn — không dùng';
    }
    if (why === null && !USABLE.includes(row.stage)) {
      why = 'gợi ý soạn lúc CHẠY THỬ — chỉ đánh giá nội bộ, không đánh dấu đã gửi (HĐ 6.7)';
    }
    if (why === null) {
      why = await ro.useReason(db, SUGGEST_FEATURE, `gợi ý #${sid}`, ro.isHuman(by));
    }
    if (why) {
      io.err(`[TỪ CHỐI] ${why}`);
      return 1;
    }
    const md = await ro.mode(db, SUGGEST_FEATURE);
    await db.query(
      'insert into san_suggestion_uses (suggestion_id, used_by, stage) values ($1, $2, $3)',
      [String(sid), who, md],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      io.err(`[skip] gợi ý #${sid} đã được đánh dấu trước đó`);
      return 0;
    }
    if (isDbError(e)) {
      io.err(`[FAIL] lỗi DB ${errName(e)}`);
      return 2;
    }
    throw e;
  }
  io.out(`[OK] gợi ý #${sid}: đã dán gửi — người: ${who}`);
  return 0;
}

/** `limit` ca loại fact/fact_san/trap_san (xen kẽ) với answer() THẬT. Không ghi eval_runs.
 * KHÁC Python có chủ đích: Python đòi OPENROUTER_API_KEY (answer() gọi OpenRouter); TS gọi qua AI
 * Gateway (Ollama nội bộ) → điều kiện "chạy thật" = module RAG đã nối answer(). */
export async function evalReal(
  db: Db | null,
  limit: number,
  o: { answer: AnswerFn | null; respondFn?: typeof respond; env?: Env; io?: Io },
): Promise<number> {
  const io = o.io ?? STD_IO;
  if (o.answer === null) {
    io.out(
      '[external-dep] thiếu answer() (module RAG chưa nối) — không chạy thật, không có kết quả',
    );
    return 1;
  }
  const suite = readJson(settings.suitePath) as { cases: Case[] };
  // Xen kẽ theo loại (fact, fact_san, trap_san, fact, ...) — `--limit` nhỏ vẫn có ca kênh sàn.
  const pools = EVAL_REAL_KINDS.map((k) => suite.cases.filter((c) => c.kind === k));
  const cases: Case[] = [];
  for (let i = 0; i < Math.max(...pools.map((p) => p.length)); i++) {
    for (const p of pools) if (i < p.length) cases.push(p[i] as Case);
  }
  cases.splice(limit);
  let start: Date | null = null;
  if (db !== null) start = (await db.query<{ now: Date }>('select now()')).rows[0]?.now ?? null;
  let nFail = 0;
  for (const c of cases) {
    let out: Record<string, unknown>;
    let ok: boolean;
    let detail: string;
    try {
      out = await (o.respondFn ?? respond)(String(c.channel), `eval-real:${c.id}`, String(c.text), {
        answer: o.answer,
        env: o.env,
      });
      [ok, detail] = scoreCskh(c, out, false);
    } catch (e) {
      // ca lỗi = FAIL, chạy tiếp
      out = { answer: '' };
      ok = false;
      detail = pyType(e);
    }
    if (!ok) nFail++;
    const ans = cpHead(maskPii(squash(pyStr(out.answer ?? ''))), 160);
    io.out(
      `[${ok ? 'PASS' : 'FAIL'}] ${c.id} (${c.kind}, ${c.channel}) handoff=${pyStr(out.handoff ?? null)}` +
        `${detail ? ` — ${detail}` : ''} | answer="${ans}"`,
    );
  }
  let cost: number | null = null;
  if (db !== null) {
    const { rows } = await db.query<{ cost: string; n: string }>(
      "select coalesce(sum(cost_usd), 0) as cost, count(*) as n from llm_usage where agent_id = 'chatbot' and ts >= $1",
      [start],
    );
    cost = Number(rows[0]?.cost ?? 0);
    io.out(
      `[cost] llm_usage agent chatbot: ${rows[0]?.n ?? 0} lời gọi, cost_usd=${cost.toFixed(6)} (trần ${EVAL_REAL_BUDGET_USD})`,
    );
  } else {
    io.out('[cost] DB down — không đọc được llm_usage');
  }
  const over = cost !== null && cost > EVAL_REAL_BUDGET_USD;
  io.out(
    `[done] eval thật ${cases.length - nFail}/${cases.length} PASS${over ? ' — VƯỢT TRẦN CHI PHÍ' : ''}`,
  );
  return nFail || over ? 1 : 0;
}

/** Lớp kênh gắn sẵn pool (login `svc_webhook`) cho adapter chat Zalo/Messenger (token
 * `ZALO_CHANNELS` của nhóm zalo — bước tích hợp: `useFactory: (pool) => chatChannels(pool)`). */
export function chatChannels(db: Db | null, env: Env = process.env) {
  return {
    normalize: (channel: string, userId: string, text: string) =>
      normalize(channel, userId, text, undefined, env),
    preRoute,
    consentGate: (inb: Inbound) => consentGate(inb, db),
    chatbotMode: () => chatbotMode(db),
    formatReply,
    recordHandoff: (inb: Inbound, reason: string, msgId: string) =>
      recordHandoff(inb, reason, msgId, db),
    recordConsent: (inb: Inbound, action: string, msgId: string) =>
      recordConsent(inb, action, msgId, db),
    recordSuggestion: (inb: Inbound, text: string, msgId: string, raw?: string) =>
      recordSuggestion(inb, text, msgId, db, raw ?? null),
    template,
  };
}
