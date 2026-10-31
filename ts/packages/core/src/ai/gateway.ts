import { z } from 'zod';
import { readJsonFile } from '../config.js';
import type { Queryable } from '../db.js';
import { type Env, pyStrip } from '../env.js';
import { dataPath } from '../paths.js';
import { internalUrl } from './net.js';
import {
  type AnthropicFactory,
  type ChatMessage,
  claudeChat,
  defaultAnthropic,
  type FetchLike,
  ollamaChat,
  ollamaEmbed,
  ProviderInputError,
} from './providers.js';
import { casefold, hasAlpha } from './text.js';

// Port `pipelines/llm_gateway.py` (v3.1 → đợt 22/10) — cổng DUY NHẤT cho mọi lời gọi AI của bản TS.
//   - `chat/embed(agentId, ..., { feature })`: feature (mã tính năng danh mục) BẮT BUỘC (Python:
//     test AST bắt mọi lời gọi truyền feature) — sai/thiếu → GatewayError.
//   - Kill-switch agent (`kill` + LLM_KILL) và tính năng (`kill_features` + LLM_KILL_FEATURES);
//     trần tháng agent (`monthly_cap_usd`) + tính năng (`feature_caps_usd`) theo tổng
//     `llm_usage.cost_usd` từ 00:00 ngày 1 GIỜ VN; trần ≤ 0 = tắt; không đọc được chi tiêu = CHẶN.
//   - Tính năng TẮT ở sổ triển khai (HĐ 6.7, `rollout.mode` = 'tat') → chặn trước khi gọi AI.
//   - Mọi content (system/history/user, embedding) che PII trước khi gửi — giữ liên hệ CÔNG KHAI
//     của công ty trong `pii_allow`.
//   - Ghi `llm_usage` 1 dòng/lời gọi (ok và lỗi); ghi lỗi → chỉ cảnh báo, kết quả vẫn trả.
// KHÁC Python có chủ đích (viết lại — KE_HOACH mục 2): nhà cung cấp = Ollama nội bộ (mặc định) /
// Claude chỉ khi `data/ai_policy.json` cho phép đúng tính năng (thay OpenRouter + `provider_only`);
// thiếu/hỏng `llm_gateway.json` → GatewayError (Python: {} rồi chặn ở whitelist rỗng — cùng kết cục).

export class GatewayError extends Error {
  override name = 'GatewayError';
}
/** Bị chặn có chủ đích (kill-switch, trần, rollout tắt, chính sách cloud) — chatbot chuyển người. */
export class GatewayBlocked extends GatewayError {
  override name = 'GatewayBlocked';
}

export const WARN_RATIO = 0.8;
const AGENT_RE = /^[a-z0-9_-]{1,64}$/;
const FEATURE_RE = /^[a-z_]+-[0-9]{2}(?:\.[0-9]{1,2})?$/;
// Tháng tính theo giờ VN: mốc 00:00 ngày 1 local → timestamptz (cùng câu Python `_SPEND_SQL`).
export const SPEND_SQL =
  'select coalesce(sum(cost_usd), 0) as spend from llm_usage where agent_id = $1' +
  " and ts >= (date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')" +
  " at time zone 'Asia/Ho_Chi_Minh')";
export const FEATURE_SPEND_SQL = SPEND_SQL.replace('where agent_id = $1', 'where feature_id = $1');
const INSERT_SQL =
  'insert into llm_usage (agent_id, model, tokens_in, tokens_out, cost_usd, ok, error, feature_id)' +
  ' values ($1, $2, $3, $4, $5, $6, $7, $8)';
// Model đám mây của Ollama (`…:cloud`, `…-cloud`) chạy ở ollama.com — không phải nội bộ.
const OLLAMA_CLOUD_RE = /(?:^|[:-])cloud$/i;
const NOT_HUMAN_RE = /^(?:agent|system|auto_policy):/;

export const DATA_CLASSES = ['xanh', 'vang', 'do'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export type Provider = 'ollama' | 'claude';

const Price = z.object({ in: z.number().min(0), out: z.number().min(0) });
type Price = z.infer<typeof Price>;
const PolicySchema = z.object({
  local: z.object({
    provider: z.literal('ollama'),
    chat_model: z.string().min(1),
    embed_model: z.string().min(1),
    embed_dim: z.number().int().positive(),
    timeout_s: z.number().positive(),
  }),
  cloud: z.object({
    provider: z.literal('claude'),
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    price_usd_per_1m: Price.nullable(),
  }),
  prices_usd_per_1m: z.record(z.string(), Price),
  features: z.record(
    z.string(),
    z.object({
      cloud: z.boolean(),
      approved_by: z.string().nullish(),
      approved_until: z.string().nullish(),
      data_classes: z.array(z.enum(DATA_CLASSES)).nullish(),
    }),
  ),
});
export type AiPolicy = z.infer<typeof PolicySchema>;

type Obj = Record<string, unknown>;
export type GatewayConfig = {
  kill: Set<string>;
  monthly_cap_usd: Obj;
  kill_features: Set<string>;
  feature_caps_usd: Obj;
  pii_allow: unknown;
  prices_usd_per_1m: Obj;
};

/** Hàm của security/pii + rollout — bản thật ghép sẵn ở `createGateway` (ops/wire). */
export type GatewayDeps = {
  /** login dịch vụ (agent_writer: SELECT/INSERT cột llm_usage + SELECT feature_rollout); null = không có DB → chặn */
  pool: Queryable | null;
  /** `pipelines.pii._mask_pii` */
  maskPii: (text: string) => string;
  /** `pipelines.pii.mask_identity(text, addr)` */
  maskIdentity: (text: string, addr: readonly string[]) => string;
  /** `pipelines.pii._PII_RE` */
  piiRe: RegExp;
  /** `pipelines.rollout.mode(conn, feature_id)` — 'tat' | 'chay_thu' | …; DB lỗi → 'chay_thu' */
  rolloutMode: (q: Queryable | null, featureId: string) => Promise<string>;
  env?: Env;
  files?: { gateway?: string; policy?: string };
  fetch?: FetchLike;
  anthropic?: AnthropicFactory;
  warn?: (msg: string) => void;
  now?: () => Date;
};

export type CallOptions = {
  feature: string;
  /** mặc định 'ollama'; 'claude' chỉ khi ai_policy.json cho phép đúng tính năng */
  provider?: Provider;
  /** lớp dữ liệu gửi đi — bắt buộc khi provider 'claude' */
  dataClass?: DataClass;
  /** model Ollama khác mặc định (cloud: model theo chính sách, không đổi được) */
  model?: string;
  temperature?: number;
  /** Ollama `options.seed` (Python truyền `seed=` cho nhà cung cấp); Claude không có seed → bỏ qua */
  seed?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** hạn tuyệt đối (epoch ms), vd hạn tổng 30 s của chatbot */
  deadline?: number;
};
export type ChatResult = {
  text: string;
  model: string;
  provider: Provider;
  tokensIn: number;
  tokensOut: number;
};
export type EmbedResult = {
  embeddings: number[][];
  model: string;
  provider: Provider;
  tokensIn: number;
};

/** Python `float(v)` cho giá trị JSON/biến môi trường; không phải số → null. */
export function pyFloat(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const s = pyStrip(v);
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
  if (m) return m[2].toLowerCase() === 'nan' ? Number.NaN : m[1] === '-' ? -Infinity : Infinity;
  const D = '\\d(?:_?\\d)*';
  if (!new RegExp(`^[+-]?(?:${D}(?:\\.(?:${D})?)?|\\.${D})(?:[eE][+-]?${D})?$`).test(s))
    return null;
  return Number(s.replace(/_/g, ''));
}

const envList = (v: string | undefined) => (v ?? '').split(',').map(pyStrip).filter(Boolean);

function strSet(v: unknown, what: string): Set<string> {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return new Set();
  if (!Array.isArray(v)) throw new GatewayError(`config ${what} không phải danh sách`);
  return new Set(v.filter((x): x is string => typeof x === 'string'));
}

function objOf(v: unknown, what: string): Obj {
  if (v === undefined || v === null || v === false) return {};
  if (typeof v !== 'object' || Array.isArray(v))
    throw new GatewayError(`config ${what} không phải object`);
  return { ...(v as Obj) };
}

const own = (o: Obj, k: string) => (Object.hasOwn(o, k) ? o[k] : o.default);

/** `_norm_contact`: email → casefold; còn lại → chỉ chữ số (Python `\D` = mọi số thập phân Unicode). */
export function normContact(s: string): string {
  return s.includes('@') ? casefold(s) : s.replace(/\P{Nd}/gu, '');
}
const isAddr = (x: string) => !x.includes('@') && hasAlpha(x);

/** `_allow`: liên hệ công khai (SĐT/email) của công ty, đã chuẩn hóa. */
export function allowSet(piiAllow: unknown): Set<string> {
  const l = Array.isArray(piiAllow) ? piiAllow : [];
  return new Set(
    l.filter((x): x is string => typeof x === 'string' && x !== '' && !isAddr(x)).map(normContact),
  );
}
/** `_allow_addr`: mục có chữ (không '@') = địa chỉ công khai của công ty. */
export function allowAddr(piiAllow: unknown): string[] {
  const l = Array.isArray(piiAllow) ? piiAllow : [];
  return l.filter((x): x is string => typeof x === 'string' && pyStrip(x) !== '' && isAddr(x));
}

type MaskDeps = Pick<GatewayDeps, 'maskPii' | 'maskIdentity' | 'piiRe'>;
const NUL = String.fromCharCode(0); // placeholder NUL…NUL giữ liên hệ công khai (như Python)
const PLACEHOLDER_RE = new RegExp(`${NUL}([a-j]+)${NUL}`, 'g');

/** `_mask`: che PII nhưng GIỮ liên hệ công khai của công ty (placeholder không chứa số/sep/@). */
export function maskText(
  text: string,
  allow: Set<string>,
  addr: readonly string[],
  d: MaskDeps,
): string {
  let t = d.maskIdentity(text, addr);
  if (allow.size === 0) return d.maskPii(t);
  t = t.replaceAll(NUL, ''); // NUL user gõ không giả được placeholder
  const keep: string[] = [];
  const re = new RegExp(
    d.piiRe.source,
    d.piiRe.flags.includes('g') ? d.piiRe.flags : `${d.piiRe.flags}g`,
  );
  const held = t.replace(re, (m: string) => {
    if (!allow.has(normContact(m))) return m;
    keep.push(m);
    const idx = [...String(keep.length - 1)]
      .map((c) => String.fromCharCode(0x61 + Number(c)))
      .join('');
    return `${NUL}${idx}${NUL}`;
  });
  return d
    .maskPii(held)
    .replace(
      PLACEHOLDER_RE,
      (_m, g: string) => keep[Number([...g].map((c) => c.charCodeAt(0) - 0x61).join(''))],
    );
}

function maskContent(
  c: ChatMessage['content'],
  allow: Set<string>,
  addr: readonly string[],
  d: MaskDeps,
) {
  if (typeof c === 'string') return maskText(c, allow, addr, d);
  if (Array.isArray(c)) {
    return c.map((p) =>
      p && typeof p === 'object' && typeof p.text === 'string'
        ? { ...p, text: maskText(p.text, allow, addr, d) }
        : p,
    );
  }
  return c;
}

/** `_cost`: model chưa có giá → giá ĐẮT nhất đã biết + cảnh báo (ghi 0 làm trần mất tác dụng). */
export function costOf(
  prices: Obj,
  model: string,
  tin: number,
  tout: number,
  warn: (m: string) => void,
): number {
  const num = (v: unknown) => pyFloat(v ?? 0) ?? 0;
  const priced = (p: unknown): p is Obj =>
    !!p && typeof p === 'object' && Object.keys(p).length > 0;
  let price = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (!priced(price)) {
    let best: Obj = {};
    let bestV = Number.NEGATIVE_INFINITY;
    for (const p of Object.values(prices)) {
      if (!p || typeof p !== 'object') continue;
      const v = num((p as Obj).in) + num((p as Obj).out);
      if (v > bestV) [best, bestV] = [p as Obj, v];
    }
    price = best;
    warn(`model ${model} chưa có giá trong config — tính theo giá cao nhất`);
  }
  const p = price as Obj;
  return (tin * num(p.in) + tout * num(p.out)) / 1e6;
}

/** Ngày YYYY-MM-DD theo giờ VN. */
export function vnDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
}

const validDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Lý do KHÔNG được gọi cloud cho tính năng này (null = được). Mặc định mọi tính năng: không. */
export function cloudProblem(
  policy: AiPolicy,
  feature: string,
  dataClass: unknown,
  today: string,
): string | null {
  const f = Object.hasOwn(policy.features, feature) ? policy.features[feature] : undefined;
  if (f?.cloud !== true)
    return `tính năng '${feature}' không được phép gọi cloud (data/ai_policy.json)`;
  const by = pyStrip(f.approved_by ?? '');
  if (!by || NOT_HUMAN_RE.test(casefold(by.normalize('NFKC')))) {
    return `tính năng '${feature}': cloud thiếu người phê duyệt (approved_by)`;
  }
  const until = f.approved_until ?? '';
  if (!validDate(until))
    return `tính năng '${feature}': cloud thiếu/sai hạn phê duyệt (approved_until)`;
  if (until < today) return `tính năng '${feature}': phê duyệt cloud đã hết hạn ${until}`;
  const classes = f.data_classes ?? [];
  if (classes.length === 0)
    return `tính năng '${feature}': cloud chưa khai lớp dữ liệu (data_classes)`;
  if (typeof dataClass !== 'string' || !(classes as string[]).includes(dataClass)) {
    return `tính năng '${feature}': lớp dữ liệu '${String(dataClass ?? '')}' không nằm trong phê duyệt cloud`;
  }
  if (!policy.cloud.price_usd_per_1m)
    return 'model cloud chưa có giá (cloud.price_usd_per_1m) — trần chi phí không áp được';
  return null;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

export class AiGateway {
  private readonly env: Env;
  private readonly warn: (m: string) => void;
  constructor(private readonly deps: GatewayDeps) {
    this.env = deps.env ?? process.env;
    this.warn = deps.warn ?? ((m) => console.log(`[llm-gateway] ${m}`));
  }

  /** `_config`: data/llm_gateway.json + override env. Thiếu/hỏng → GatewayError (fail-closed). */
  config(): GatewayConfig {
    let raw: unknown;
    try {
      raw = readJsonFile(this.deps.files?.gateway ?? dataPath('llm_gateway.json'));
    } catch (e) {
      throw new GatewayError(`config ${(e as Error).message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError('config llm_gateway.json không phải object');
    }
    const cfg = raw as Obj;
    const kill = strSet(cfg.kill, 'kill');
    for (const a of envList(this.env.LLM_KILL)) kill.add(a);
    const caps = objOf(cfg.monthly_cap_usd, 'monthly_cap_usd');
    if (this.env.LLM_CAP_DEFAULT_USD) {
      const v = pyFloat(this.env.LLM_CAP_DEFAULT_USD);
      if (v === null) throw new GatewayError('LLM_CAP_DEFAULT_USD không phải số');
      caps.default = v;
    }
    if (!Object.hasOwn(caps, 'default')) caps.default = 5.0;
    const killFeatures = strSet(cfg.kill_features, 'kill_features');
    for (const a of envList(this.env.LLM_KILL_FEATURES)) killFeatures.add(a);
    const fcaps = objOf(cfg.feature_caps_usd, 'feature_caps_usd');
    if (!Object.hasOwn(fcaps, 'default')) fcaps.default = caps.default;
    return {
      kill,
      monthly_cap_usd: caps,
      kill_features: killFeatures,
      feature_caps_usd: fcaps,
      pii_allow: cfg.pii_allow,
      prices_usd_per_1m: objOf(cfg.prices_usd_per_1m, 'prices_usd_per_1m'),
    };
  }

  /** data/ai_policy.json — thiếu/hỏng/sai cấu trúc → GatewayError (không gọi AI). */
  policy(): AiPolicy {
    try {
      return readJsonFile(this.deps.files?.policy ?? dataPath('ai_policy.json'), PolicySchema);
    } catch (e) {
      throw new GatewayError(`chính sách AI: ${(e as Error).message}`);
    }
  }

  /** `_month_spend`: null = không đọc được (gate chặn). */
  private async monthSpend(key: string, sql: string): Promise<number | null> {
    if (!this.deps.pool) return null;
    try {
      const r = await this.deps.pool.query(sql, [key]);
      const v = Number(r.rows[0]?.spend);
      if (!Number.isFinite(v)) throw new TypeError('spend không phải số');
      return v;
    } catch (e) {
      this.warn(`không đọc được spend (${errName(e)}) — chặn lời gọi`);
      return null;
    }
  }

  private async record(
    agentId: string,
    model: string,
    tin: number,
    tout: number,
    cost: number,
    ok: boolean,
    error: string | null,
    feature: string,
  ): Promise<void> {
    if (!this.deps.pool) {
      this.warn('không có DATABASE_URL — bỏ ghi llm_usage');
      return;
    }
    try {
      await this.deps.pool.query(INSERT_SQL, [agentId, model, tin, tout, cost, ok, error, feature]);
    } catch (e) {
      this.warn(`ghi llm_usage lỗi (${errName(e)}) — lời gọi vẫn trả kết quả`);
    }
  }

  /** `_gate` + `_gate_feature` (+ chính sách nhà cung cấp ở chỗ whitelist provider của Python). */
  private async gate(agentId: unknown, opts: CallOptions, kind: 'chat' | 'embed') {
    if (typeof agentId !== 'string' || !AGENT_RE.test(agentId))
      throw new GatewayError('agent_id không hợp lệ');
    const feature = opts?.feature;
    if (typeof feature !== 'string' || !FEATURE_RE.test(feature)) {
      throw new GatewayError('feature (mã tính năng danh mục) không hợp lệ');
    }
    const cfg = this.config();
    const policy = this.policy();
    const provider = opts.provider ?? 'ollama';
    if (provider !== 'ollama' && provider !== 'claude')
      throw new GatewayError('nhà cung cấp AI không hợp lệ');
    if (provider === 'claude') {
      if (kind === 'embed')
        throw new GatewayError('cloud (claude) không có embedding — chỉ Ollama nội bộ');
      if (opts.model !== undefined)
        throw new GatewayError('model cloud chỉ theo data/ai_policy.json');
      const why = cloudProblem(
        policy,
        feature,
        opts.dataClass,
        vnDate(this.deps.now?.() ?? new Date()),
      );
      if (why) throw new GatewayBlocked(why);
    }
    if (cfg.kill.has(agentId)) throw new GatewayBlocked(`agent '${agentId}' đang bị kill-switch`);
    const cap = pyFloat(own(cfg.monthly_cap_usd, agentId));
    if (cap === null) throw new GatewayError(`trần chi phí của '${agentId}' không phải số`);
    // v13.1 (FinOps): cap <= 0 = agent TẮT — chặn TRƯỚC khi đọc DB.
    if (!(cap > 0)) throw new GatewayBlocked(`agent '${agentId}' có trần 0 USD — đang tắt`);
    const spend = await this.monthSpend(agentId, SPEND_SQL);
    if (spend === null) {
      throw new GatewayBlocked(
        `agent '${agentId}': không đọc được chi tiêu tháng — chặn (fail-closed)`,
      );
    }
    if (spend >= cap) {
      throw new GatewayBlocked(
        `agent '${agentId}' vượt trần tháng ${spend.toFixed(4)}/${cap.toFixed(2)} USD`,
      );
    }
    if (spend >= WARN_RATIO * cap) {
      this.warn(`agent '${agentId}' đã dùng ${spend.toFixed(4)}/${cap.toFixed(2)} USD (>=80%)`);
    }
    await this.gateFeature(cfg, feature);
    return { cfg, policy, provider, feature };
  }

  private async gateFeature(cfg: GatewayConfig, feature: string): Promise<void> {
    if (cfg.kill_features.has(feature))
      throw new GatewayBlocked(`tính năng '${feature}' đang bị nút tắt khẩn`);
    // r12 D1: tính năng TẮT trong sổ triển khai (HĐ 6.7) → chặn TRƯỚC khi gọi provider.
    if ((await this.deps.rolloutMode(this.deps.pool, feature)) === 'tat') {
      throw new GatewayBlocked(
        `tính năng '${feature}' đang TẮT (sổ triển khai, HĐ 6.7) — không gọi AI`,
      );
    }
    const cap = pyFloat(own(cfg.feature_caps_usd, feature));
    if (cap === null) throw new GatewayError(`trần chi phí tính năng '${feature}' không phải số`);
    if (!(cap > 0)) throw new GatewayBlocked(`tính năng '${feature}' có trần 0 USD — đang tắt`);
    const spend = await this.monthSpend(feature, FEATURE_SPEND_SQL);
    if (spend === null) {
      throw new GatewayBlocked(
        `tính năng '${feature}': không đọc được chi tiêu tháng — chặn (fail-closed)`,
      );
    }
    if (spend >= cap) {
      throw new GatewayBlocked(
        `tính năng '${feature}' vượt trần tháng ${spend.toFixed(4)}/${cap.toFixed(2)} USD`,
      );
    }
    if (spend >= WARN_RATIO * cap) {
      this.warn(`tính năng '${feature}' đã dùng ${spend.toFixed(4)}/${cap.toFixed(2)} USD (>=80%)`);
    }
  }

  private timeoutMs(opts: CallOptions, policy: AiPolicy): number {
    let ms = opts.timeoutMs ?? policy.local.timeout_s * 1000;
    if (opts.deadline !== undefined)
      ms = Math.min(ms, opts.deadline - (this.deps.now?.() ?? new Date()).getTime());
    if (!(ms > 0)) throw new GatewayError('hết hạn trước khi gọi AI (deadline) — không gọi');
    return ms;
  }

  private ollamaUrl(): string {
    const r = internalUrl(this.env.OLLAMA_URL, 'OLLAMA_URL');
    if (r.error !== null) throw new GatewayError(r.error);
    return r.url;
  }

  /** `_call`: gọi đúng 1 lần; lỗi nhà cung cấp → ghi usage lỗi + GatewayError (fail-closed). */
  private async call<T extends { tokensIn: number; tokensOut: number }>(
    agentId: string,
    model: string,
    prices: Obj,
    feature: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let r: T;
    try {
      r = await fn();
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      if (e instanceof ProviderInputError) throw new GatewayError(e.message);
      const name = errName(e);
      const err = Array.from(
        this.deps.maskPii(`${name}: ${e instanceof Error ? e.message : String(e)}`),
      )
        .slice(0, 300)
        .join('');
      await this.record(agentId, model, 0, 0, 0, false, err, feature);
      throw new GatewayError(`LLM provider lỗi (${name}) — fail-closed`, { cause: e });
    }
    await this.record(
      agentId,
      model,
      r.tokensIn,
      r.tokensOut,
      costOf(prices, model, r.tokensIn, r.tokensOut, this.warn),
      true,
      null,
      feature,
    );
    return r;
  }

  private prices(cfg: GatewayConfig, policy: AiPolicy): Obj {
    const p: Obj = { ...cfg.prices_usd_per_1m, ...policy.prices_usd_per_1m };
    if (policy.cloud.price_usd_per_1m)
      p[policy.cloud.model] = policy.cloud.price_usd_per_1m as Price;
    return p;
  }

  private localModel(model: string | undefined, fallback: string): string {
    const m = model ?? fallback;
    if (typeof m !== 'string' || !m) throw new GatewayError('model không hợp lệ');
    if (OLLAMA_CLOUD_RE.test(m))
      throw new GatewayBlocked(`model '${m}' là model đám mây của Ollama — chỉ model nội bộ`);
    return m;
  }

  async chat(agentId: string, messages: ChatMessage[], opts: CallOptions): Promise<ChatResult> {
    const { cfg, policy, provider, feature } = await this.gate(agentId, opts, 'chat');
    const allow = allowSet(cfg.pii_allow);
    const addr = allowAddr(cfg.pii_allow);
    if (!Array.isArray(messages)) throw new GatewayError('messages không phải danh sách');
    const msgs = messages.map((m) => ({
      ...m,
      content: maskContent(m.content, allow, addr, this.deps),
    }));
    const prices = this.prices(cfg, policy);
    if (provider === 'claude') {
      const model = policy.cloud.model;
      const timeoutMs = this.timeoutMs(opts, policy);
      return this.call(agentId, model, prices, feature, async () => {
        const key = pyStrip(this.env.ANTHROPIC_API_KEY ?? '');
        if (!key) throw new GatewayError('thiếu ANTHROPIC_API_KEY');
        const r = await claudeChat(
          key,
          {
            model,
            messages: msgs,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens ?? policy.cloud.max_tokens,
            timeoutMs,
          },
          this.deps.anthropic ?? defaultAnthropic,
        );
        return { ...r, model, provider };
      });
    }
    const model = this.localModel(opts.model, policy.local.chat_model);
    const timeoutMs = this.timeoutMs(opts, policy);
    return this.call(agentId, model, prices, feature, async () => {
      const r = await ollamaChat(
        this.ollamaUrl(),
        {
          model,
          messages: msgs,
          temperature: opts.temperature,
          seed: opts.seed,
          maxTokens: opts.maxTokens,
          timeoutMs,
        },
        this.deps.fetch,
      );
      return { ...r, model, provider };
    });
  }

  async embed(agentId: string, input: string | string[], opts: CallOptions): Promise<EmbedResult> {
    const { cfg, policy, provider, feature } = await this.gate(agentId, opts, 'embed');
    const allow = allowSet(cfg.pii_allow);
    const addr = allowAddr(cfg.pii_allow);
    const one = (t: unknown) => {
      if (typeof t !== 'string') throw new GatewayError('input embedding không phải text');
      return maskText(t, allow, addr, this.deps);
    };
    const inp = Array.isArray(input) ? input.map(one) : one(input);
    const model = this.localModel(opts.model, policy.local.embed_model);
    const timeoutMs = this.timeoutMs(opts, policy);
    const r = await this.call(agentId, model, this.prices(cfg, policy), feature, () =>
      ollamaEmbed(
        this.ollamaUrl(),
        { model, input: inp, dim: policy.local.embed_dim, timeoutMs },
        this.deps.fetch,
      ),
    );
    return { embeddings: r.embeddings, model, provider, tokensIn: r.tokensIn };
  }
}
