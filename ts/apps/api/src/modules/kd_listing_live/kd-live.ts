import { createHash } from 'node:crypto';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { isHealthQuestion } from '@samsam/core/ai/health';
import type { ChatMessage } from '@samsam/core/ai/providers';
import type { Db } from '@samsam/core/ops/deps';
import { dmy, parseDay } from '@samsam/core/ops/period';
import { isInt, isPlainObject, readJson, squash } from '@samsam/core/ops/py';
import { readinessFromDb, SOURCE_CLI, saveDraft } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import {
  checkPublish,
  type GuardrailResult,
  type ReadinessMap,
} from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { cpHead, isSpace, pyRepr, pyStr, pyStrip, pyTruthy, S } from '@samsam/core/security/py';
import {
  feedback,
  loadTemplate,
  publishTexts,
  type Refusal,
  refusedGuardrail,
  specLike,
  system,
} from './content-lite.js';
import { vnd } from './kd-listing.js';

// Port `agents/kd_live.py` — v10.1 KD-A9 (WP16) kịch bản livestream NHÁP. LLM CHỈ viết lời dẫn từng
// SKU + hỏi-đáp bình luận (gateway agent `kd_livestream`); GIỎ + GIÁ do CODE dựng từ view
// `v_promotable` (giá `list` đã duyệt). Nháp vào `content_drafts` (pending) — người duyệt qua store;
// module KHÔNG có đường duyệt/đăng/lên sóng (tài khoản live = external-dep).
//  - Từ chối TRƯỚC LLM (0 lời gọi, 0 ghi DB) theo thứ tự: kenh_la | gio_hang | brief | sku_la | ruou |
//    khong_promotable | vuot_tran_phien (≥ max_sessions_per_week nháp chưa bị từ chối cùng tuần ISO).
//  - Sau LLM: câu chạm số/giá/quy cách → BỎ (`so_lieu`); câu nhắc rượu → BỎ (`ruou`); câu hỏi sức
//    khỏe → câu hỏi trung tính + câu đáp = `channels.json` templates.health NGUYÊN VĂN.
//  - Giỏ có TPBVSK → CODE nối câu khuyến cáo chuẩn; CODE nối nhãn QC + nhãn AI. Toàn văn qua
//    `checkPublish(livestream_script, isAi)` → vi phạm → 1 lượt sửa có feedback → còn → `kich_ban`.
//  - Ngày phiên ghi DÒNG ĐẦU `brief` của draft: `phien: YYYY-MM-DD kenh: K` (đếm trần phiên).

export const RULES_FILE = dataPath('livestream_rules.json');
export const CHANNELS_FILE = dataPath('channels.json');
export const TEMPLATE = 'livestream_script';
export const CONTENT_TYPE = 'livestream_script';
export const AGENT = 'kd_livestream';
export const CREATED_BY = 'agent:kd_a9';
export const FEATURE = 'sales-07.1';
export const MAX_BRIEF = 500;
export const MAX_LINE = 300;
export const MAX_LINES = 12;
export const CHANNEL_NAME: Record<string, string> = {
  shopee: 'Shopee Live',
  tiktok: 'TikTok Live',
  facebook: 'Facebook Live',
};
export const HEALTH_Q =
  '(Câu hỏi về sức khỏe của khách — không tư vấn trên live, chuyển chuyên gia)';
const FENCE_RE = new RegExp(`^\`\`\`(?:json)?[${S}]*([\\s\\S]*?)[${S}]*\`\`\`$`, 'u');
const PHIEN_RE = /^phien: ([0-9]{4}-[0-9]{2}-[0-9]{2}) kenh: [a-z]+/;
export const SKU_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CTRL = /^[\p{Cc}\p{Cf}]$/u;

export type Rules = {
  channels: string[];
  max_sessions_per_week: number;
  max_cart: number;
  duration_min: number;
};
export type LiveCtx = {
  skus: Map<string, { name: string; category: unknown }>;
  promotable: Map<string, number>;
  n_sessions: number;
  readiness?: ReadinessMap | null;
};
export type Dropped = { text: string; ly_do: string };
export type Chat = Pick<AiGateway, 'chat'>;
export type GenResult = {
  ok: boolean;
  refused: Refusal | null;
  error: string | null;
  text: string;
  cart: { sku_key: string; name: string; price_vnd: number }[];
  dropped: Dropped[];
  guardrail: (GuardrailResult & Record<string, unknown>) | null;
  llm_calls: number;
  prompt_version: string | null;
  prompt_sha256: string | null;
  /** TS thêm: model gateway trả (Python in `OR_CHAT_MODEL`). */
  model?: string;
  draft_id?: string | null;
};

/** Luật đã kiểm → Rules; lỗi → RangeError (Python ValueError, fail-closed). */
export function loadRules(path: string = RULES_FILE): Rules {
  let rules: Rules;
  try {
    const doc = readJson(path) as Record<string, unknown>;
    const need = (k: string) => {
      if (!isPlainObject(doc)) throw new TypeError('TypeError');
      if (!Object.hasOwn(doc, k)) throw new TypeError('KeyError');
      return doc[k];
    };
    const ch = need('channels');
    // shortcut: chỉ list (Python lặp được cả chuỗi) — chặt hơn = fail-closed.
    if (!Array.isArray(ch)) throw new TypeError('TypeError');
    rules = {
      channels: ch.map(pyStr),
      max_sessions_per_week: need('max_sessions_per_week') as number,
      max_cart: need('max_cart') as number,
      duration_min: need('duration_min') as number,
    };
  } catch (e) {
    const n = (e as { pyType?: string }).pyType ?? (e as Error).message;
    throw new RangeError(`livestream_rules.json không dùng được (${n})`);
  }
  for (const [k, hi] of [
    ['max_sessions_per_week', 14],
    ['max_cart', 30],
    ['duration_min', 600],
  ] as const) {
    const v = rules[k];
    if (!(isInt(v) && v >= 1 && v <= hi)) {
      throw new RangeError(`livestream_rules.json: ${k} phải 1..${hi}`);
    }
  }
  if (!rules.channels.length) throw new RangeError('livestream_rules.json: channels rỗng');
  return rules;
}

export function healthTemplate(path: string = CHANNELS_FILE): string {
  const doc = readJson(path) as Record<string, Record<string, unknown>>;
  const t = isPlainObject(doc) && isPlainObject(doc.templates) ? doc.templates.health : undefined;
  if (!(typeof t === 'string' && pyStrip(t))) {
    throw new RangeError('channels.json thiếu templates.health');
  }
  return t;
}

/** Python `date.isocalendar()[:2]` cho 'YYYY-MM-DD'. */
export function isoWeek(day: string): [number, number] {
  const t = new Date(`${day}T00:00:00Z`);
  const wd = (t.getUTCDay() + 6) % 7; // thứ Hai = 0
  const thu = new Date(t.getTime() + (3 - wd) * 86_400_000); // thứ Năm cùng tuần quyết năm ISO
  const y = thu.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  return [y, Math.floor((thu.getTime() - jan1) / 86_400_000 / 7) + 1];
}

// ------------------------------------------------------------ đọc DB

/** CHỈ SELECT → ngữ cảnh cho `generate`: skus, promotable (kênh), n_sessions (nháp livestream chưa
 * rejected cùng tuần ISO ngày phiên), readiness (view). */
export async function loadCtx(db: Db, channel: string, day: string): Promise<LiveCtx> {
  const skus = new Map(
    (await db.query('select sku_key, name, category from sku_master')).rows.map((r) => [
      r.sku_key as string,
      { name: r.name as string, category: r.category },
    ]),
  );
  const promotable = new Map(
    (
      await db.query(
        'select sku_key, price_vnd::text as price from v_promotable where channel = $1',
        [channel],
      )
    ).rows.map((r) => [r.sku_key as string, Number(r.price)]),
  );
  const wk = isoWeek(day).join('-');
  let n = 0;
  const { rows } = await db.query(
    "select brief from content_drafts where content_type = $1 and status <> 'rejected'",
    [CONTENT_TYPE],
  );
  for (const r of rows) {
    const m = PHIEN_RE.exec(r.brief ?? '');
    if (m && parseDay(m[1] as string) !== null && isoWeek(m[1] as string).join('-') === wk) n++;
  }
  return { skus, promotable, n_sessions: n, readiness: await readinessFromDb(db) };
}

// ------------------------------------------------------------ luật (THUẦN)

/** Từ chối rẻ TRƯỚC LLM → {code, reason} | null. */
export function precheck(
  channel: unknown,
  cart: unknown,
  brief: unknown,
  ctx: LiveCtx,
  rules: Rules,
): Refusal | null {
  if (!rules.channels.includes(channel as string)) {
    return {
      code: 'kenh_la',
      reason: `kênh ${pyRepr(cpHead(pyStr(channel), 30))} ngoài ${pyStr(rules.channels)}`,
    };
  }
  if (
    !Array.isArray(cart) ||
    !cart.length ||
    cart.length > rules.max_cart ||
    new Set(cart).size !== cart.length
  ) {
    return { code: 'gio_hang', reason: `giỏ phải 1..${rules.max_cart} SKU, không trùng` };
  }
  const b = pyStrip(pyTruthy(brief) ? String(brief) : '');
  if (!b || Array.from(b).length > MAX_BRIEF) {
    return { code: 'brief', reason: `brief rỗng hoặc dài hơn ${MAX_BRIEF} ký tự` };
  }
  const skus = ctx.skus;
  for (const k of cart) {
    if (!(typeof k === 'string' && skus.has(k))) {
      return { code: 'sku_la', reason: 'SKU không có trong golden' };
    }
  }
  const keys = cart as string[];
  const sk = (k: string) => skus.get(k) as { name: string; category: unknown };
  if (isAlcohol(b) || keys.some((k) => sk(k).category === 'alcohol' || isAlcohol(sk(k).name))) {
    return {
      code: 'ruou',
      reason: 'giỏ/brief có rượu — cấm quảng cáo/khuyến mại rượu (Luật 44/2019)',
    };
  }
  const bad = keys.filter((k) => !ctx.promotable.has(k));
  if (bad.length) {
    return {
      code: 'khong_promotable',
      reason: `${bad.join(', ')} chưa được quảng bá trên kênh ${pyStr(channel)} (readiness/giá chưa duyệt)`,
    };
  }
  if (ctx.n_sessions >= rules.max_sessions_per_week) {
    return {
      code: 'vuot_tran_phien',
      reason: `tuần này đã có ${ctx.n_sessions} phiên ≥ trần ${rules.max_sessions_per_week}`,
    };
  }
  return null;
}

/** JSON LLM (có thể trong khối ```json) → object | null. JSON.parse từ chối NaN/Infinity (Python
 * nhận) — chặt hơn = `kich_ban`, fail-closed. */
export function parse(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const s = pyStrip(text);
  const m = FENCE_RE.exec(s);
  let o: unknown;
  try {
    o = JSON.parse(m ? (m[1] as string) : s);
  } catch {
    return null;
  }
  return isPlainObject(o) ? o : null;
}

const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_LINES) : [];

/** Câu LLM sau khi làm sạch → giữ | null (đã ghi `dropped`). Bỏ ký tự điều khiển/vô hình Cc/Cf
 * (escape terminal khi CLI in kịch bản, ZWSP lách lọc — OWASP A03). */
function keep(s: unknown, dropped: Dropped[]): string | null {
  if (typeof s !== 'string') return null;
  const c = Array.from(s.normalize('NFC'))
    .filter((ch) => isSpace(ch) || !CTRL.test(ch))
    .join('');
  const t = cpHead(squash(c), MAX_LINE);
  if (!t) return null;
  if (specLike(t)) {
    dropped.push({ text: t, ly_do: 'so_lieu' });
    return null;
  }
  if (isAlcohol(t)) {
    dropped.push({ text: t, ly_do: 'ruou' });
    return null;
  }
  return t;
}

/** JSON LLM → [toàn văn kịch bản, câu bị bỏ] (CODE dựng giỏ/giá/khuyến cáo/nhãn). */
export function buildText(
  obj: Record<string, unknown>,
  channel: string,
  cart: string[],
  day: string,
  ctx: LiveCtx,
  health: string,
): [string, Dropped[]] {
  const [canon, ai, ad] = publishTexts();
  const dropped: Dropped[] = [];
  const bySku = new Map<string, string[]>();
  for (const it of Array.isArray(obj.san_pham) ? obj.san_pham : []) {
    if (isPlainObject(it) && cart.includes(it.sku as string) && !bySku.has(it.sku as string)) {
      bySku.set(it.sku as string, lines(it.loi_dan));
    }
  }
  const kept = (xs: unknown[]) =>
    xs.map((s) => keep(s, dropped)).filter((t): t is string => t !== null);
  const L = [
    `Kịch bản livestream ${CHANNEL_NAME[channel] ?? channel} — phiên ${dmy(day)} (NHÁP)`,
    '',
    '[Mở đầu]',
  ];
  L.push(...kept(lines(obj.mo_dau)), '', '[Giỏ hàng]');
  cart.forEach((k, i) => {
    const s = ctx.skus.get(k) as { name: string };
    L.push(`${i + 1}. ${s.name} — Giá: ${vnd(ctx.promotable.get(k) as number)}`);
    L.push(...kept(bySku.get(k) ?? []).map((t) => `   ${t}`));
  });
  const qa = Array.isArray(obj.hoi_dap)
    ? obj.hoi_dap.filter((x) => isPlainObject(x)).slice(0, MAX_LINES)
    : [];
  L.push('', '[Hỏi đáp bình luận]');
  for (const x of qa as Record<string, unknown>[]) {
    let q = keep(pyTruthy(x.hoi) ? x.hoi : '', dropped);
    if (!q) continue;
    let a: string | null;
    if (isHealthQuestion(q)) {
      // KHÔNG đưa nguyên văn câu hỏi sức khỏe của khách (đối tượng bệnh/triệu chứng) vào kịch bản
      // công khai — quyết bằng luồng đã kiểm, không nhờ guardrail miễn theo hình thức dòng "Hỏi:".
      q = HEALTH_Q;
      a = health;
    } else {
      a = keep(pyTruthy(x.dap) ? x.dap : '', dropped);
      if (!a) continue;
    }
    L.push(`Hỏi: ${q}`, `Đáp: ${a}`);
  }
  L.push('', '[Kết]', ...kept(lines(obj.ket)), '');
  if (canon && cart.some((k) => ctx.skus.get(k)?.category === 'tpbvsk')) L.push(`${canon}.`);
  L.push(...ad.slice(0, 1), ...ai.slice(0, 1));
  return [L.join('\n'), dropped];
}

export function messages(
  tmpl: string,
  channel: string,
  cart: string[],
  brief: string,
  ctx: LiveCtx,
  rules: Rules,
): ChatMessage[] {
  const products = cart
    .map((k) => `${(ctx.skus.get(k) as { name: string }).name} (mã ${k})`)
    .join('; ');
  // Thay chuỗi NGUYÊN VĂN (hàm thay thế: `$&` trong brief không bị hiểu là mẫu); brief CUỐI.
  const fmt = tmpl
    .replaceAll('{channel}', () => CHANNEL_NAME[channel] ?? channel)
    .replaceAll('{duration_min}', () => String(rules.duration_min))
    .replaceAll('{products}', () => products)
    .replaceAll('{brief}', () => squash(brief));
  return [
    { role: 'system', content: system(fmt, false) },
    { role: 'user', content: 'Trả về DUY NHẤT JSON đúng mẫu.' },
  ];
}

/** sha256 của `json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
export function msgsSha(msgs: ChatMessage[]): string {
  const sorted = msgs.map((m) =>
    Object.fromEntries(
      Object.keys(m)
        .sort()
        .map((k) => [k, m[k]]),
    ),
  );
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}

/** Không ghi DB → kết quả sinh (từ chối trước LLM: 0 lời gọi). */
export async function generate(
  channel: string,
  cart: string[],
  day: string,
  brief: string,
  ctx: LiveCtx,
  rules: Rules,
  ai: Chat,
): Promise<GenResult> {
  const out: GenResult = {
    ok: false,
    refused: null,
    error: null,
    text: '',
    cart: [],
    dropped: [],
    guardrail: null,
    llm_calls: 0,
    prompt_version: null,
    prompt_sha256: null,
  };
  const refuse = (
    code: string,
    reason: string,
    g: GenResult['guardrail'] = null,
    kw: Partial<GenResult> = {},
  ): GenResult => {
    const ref = { code, reason };
    return { ...out, ...kw, refused: ref, guardrail: g ?? refusedGuardrail(ref) };
  };
  const ref = precheck(channel, cart, brief, ctx, rules);
  if (ref) return refuse(ref.code, ref.reason);
  let tmpl: string;
  let ver: string;
  let health: string;
  try {
    [tmpl, ver] = loadTemplate(TEMPLATE);
    health = healthTemplate();
  } catch (e) {
    return refuse('config', cpHead(String((e as Error).message ?? e), 200));
  }
  const cartOut = cart.map((k) => ({
    sku_key: k,
    name: (ctx.skus.get(k) as { name: string }).name,
    price_vnd: ctx.promotable.get(k) as number,
  }));
  let msgs = messages(tmpl, channel, cart, brief, ctx, rules);
  for (const calls of [1, 2]) {
    // bản nháp + 1 lượt sửa có feedback
    const sha = msgsSha(msgs);
    let raw: string;
    let model: string | undefined;
    try {
      const r = await ai.chat(AGENT, msgs, {
        feature: FEATURE,
        temperature: 0.3,
        maxTokens: 1200,
      });
      raw = r.text;
      model = r.model;
    } catch (e) {
      // gateway fail-closed
      const err = e as Error;
      return {
        ...out,
        llm_calls: calls,
        error: `llm: ${err?.name ?? 'Error'}: ${cpHead(String(err?.message ?? e), 160)}`,
      };
    }
    const state: Partial<GenResult> = {
      llm_calls: calls,
      prompt_version: ver,
      prompt_sha256: sha,
      cart: cartOut,
      model,
    };
    const obj = parse(raw);
    if (obj === null) return refuse('kich_ban', 'LLM trả sai mẫu JSON', null, state);
    const [text, dropped] = buildText(obj, channel, cart, day, ctx, health);
    const g = checkPublish(text, {
      channel,
      contentType: CONTENT_TYPE,
      isAi: true,
      readiness: ctx.readiness ?? null,
    });
    Object.assign(state, { text, dropped });
    if (g.ok === true) return { ...out, ...state, ok: true, guardrail: g };
    if (calls === 2) {
      return refuse('kich_ban', 'kịch bản vi phạm guardrail sau 1 lượt sửa', g, state);
    }
    msgs = [
      ...msgs,
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `${feedback(g)} Không viết số/giá. Trả lại DUY NHẤT JSON đúng mẫu.`,
      },
    ];
  }
  throw new Error('unreachable');
}

/** `generate` trên ngữ cảnh DB → đạt (và không dryRun) → lưu nháp pending. Từ chối trước LLM: 0
 * lời gọi, 0 ghi DB. */
export async function writeScript(
  db: Db,
  channel: string,
  cart: string[],
  day: string,
  brief: string,
  o: { ai: Chat; dryRun?: boolean; rules?: Rules },
): Promise<GenResult> {
  const rules = o.rules ?? loadRules();
  const ctx = await loadCtx(db, channel, day);
  const res = await generate(channel, cart, day, brief, ctx, rules, o.ai);
  res.draft_id = null;
  if (res.ok && !o.dryRun) {
    res.draft_id = await saveDraft(db, {
      brief: `phien: ${day} kenh: ${channel}\n${squash(brief)}`,
      channel,
      text: res.text,
      guardrail: res.guardrail,
      source: SOURCE_CLI,
      createdBy: CREATED_BY,
      contentType: CONTENT_TYPE,
      isAi: true,
      promptVersion: res.prompt_version,
      promptSha256: res.prompt_sha256,
    });
  }
  return res;
}
