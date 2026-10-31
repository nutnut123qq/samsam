import { GatewayBlocked, GatewayError } from '@samsam/core/ai/gateway';
import type { Env } from '@samsam/core/env';
import { isPlainObject } from '@samsam/core/ops/py';
import { pyStrip } from '@samsam/core/security/py';
import { ImageProviderError } from './image-studio.js';
import type { Raw } from './raster.js';
import * as raster from './raster.js';

// Port `pipelines/image_provider_openrouter.py` — r13 marketing-02.1: adapter nền AI OpenRouter
// Images API cho image_studio (provider `openrouter_images`). Tách khỏi image_studio để module ghép ảnh
// giữ bất biến "không có đường mạng"; đường mạng DUY NHẤT là `background` dưới đây, chỉ chạy SAU cổng
// AI (kill agent/tính năng, trần tháng agent `image` + tính năng marketing-02.1, chi tiêu không đọc
// được → chặn, rollout TẮT → chặn, whitelist provider) — TRƯỚC mọi request. Model phải đặt tường minh
// IMAGE_MODEL (chọn vendor/model = quyết định ngoài).
// POST {BASE}/images {model, prompt, size "WxH", output_format, n, provider} → {"data": [{"b64_json",
// "media_type"}], "usage": {"cost": USD}}; 502 = không hoàn tất, KHÔNG tính phí; tối đa 1 lần thử lại
// khi 429/502/503. Provider CHỈ nhận prompt nền + kích thước (packshot ghép tại chỗ).
// shortcut: AI Gateway TS (core/ai/gateway) chưa có API ảnh — cổng `gate`/`record` mặc định CHẶN
// (GatewayBlocked, 0 request, không gọi cloud ngoài data/ai_policy.json); bước tích hợp nối
// `setOpenrouterDeps({ gate, record })` khi core có cổng ảnh (core_requests).

export const IMAGE_AGENT = 'image';
export const IMAGE_FEATURE = 'marketing-02.1';
export const IMAGE_TIMEOUT_S = 120;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_RETRY_STATUS = [429, 502, 503]; // 502/503 không tính phí; tối đa 1 lần thử lại
export const BASE_URL = 'https://openrouter.ai/api/v1';
const COST_FALLBACK_USD = 0.25;

/** Kết quả cổng (Python `gw._gate` → cfg): whitelist provider + mức phí dự phòng ảnh. */
export type ImageGate = { providerOnly: string[]; imageCostFallbackUsd?: number | null };
export type OrDeps = {
  env: Env;
  /** Python `gw._gate(agent, feature)`: chặn → GatewayError/GatewayBlocked (0 request). */
  gate: (agent: string, feature: string) => Promise<ImageGate>;
  /** Python `gw._record(...)` → dòng `llm_usage`. */
  record: (
    agent: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    cost: number,
    ok: boolean,
    error: string | null,
    feature: string,
  ) => Promise<void>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_DEPS: OrDeps = {
  env: process.env,
  gate: async () => {
    throw new GatewayBlocked(
      `agent '${IMAGE_AGENT}': AI Gateway TS chưa có cổng ảnh — không gọi API sinh ảnh (data/ai_policy.json)`,
    );
  },
  // Cổng và ghi chi phí đi CẶP (Python gắn cứng cả hai vào gw): chưa nối ghi → chặn, không no-op.
  record: async () => {
    throw new ImageProviderError(
      `agent '${IMAGE_AGENT}': chưa nối ghi chi phí llm_usage — không gọi API sinh ảnh`,
    );
  },
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
let deps: OrDeps = DEFAULT_DEPS;

type DepsOver = Partial<Omit<OrDeps, 'gate' | 'record'>> &
  (Pick<OrDeps, 'gate' | 'record'> | { gate?: undefined; record?: undefined });

/** Nối cổng/ghi chi phí/HTTP (bước tích hợp; test truyền bản giả). Không tham số → mặc định.
 * `gate` và `record` phải nối CÙNG LÚC: chỉ nối cổng mà thiếu ghi = gọi cloud không ghi `llm_usage`,
 * trần tháng agent `image`/marketing-02.1 bị vượt câm → từ chối (giữ nguyên deps cũ). */
export function setOpenrouterDeps(over?: DepsOver): void {
  if (over && (over.gate === undefined) !== (over.record === undefined)) {
    throw new TypeError('setOpenrouterDeps: phải nối gate VÀ record cùng lúc');
  }
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

const errName = (e: unknown): string =>
  e instanceof Error ? (e.name === 'Error' ? e.constructor.name : e.name) : 'Exception';

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** `background`: (prompt, size) → [ảnh RGB, {model}]. Lỗi → ImageProviderError (fail-closed). */
export async function background(
  prompt: string,
  size: [number, number],
): Promise<[Raw, { model: string }]> {
  const d = deps;
  const model = pyStrip(d.env.IMAGE_MODEL ?? '');
  if (!model) {
    throw new ImageProviderError(
      'IMAGE_MODEL chưa đặt — chọn model sinh ảnh là quyết định ngoài (vendor/điều khoản/DPA)',
    );
  }
  const key = pyStrip(d.env.OPENROUTER_API_KEY ?? '');
  if (!key) throw new ImageProviderError('thiếu OPENROUTER_API_KEY');
  let cfg: ImageGate;
  try {
    cfg = await d.gate(IMAGE_AGENT, IMAGE_FEATURE); // kill/trần/rollout/whitelist
  } catch (e) {
    if (e instanceof GatewayError)
      throw new ImageProviderError(`cổng chi phí/tắt chặn: ${e.message}`);
    throw e;
  }
  const body = {
    model,
    prompt,
    size: `${size[0]}x${size[1]}`,
    output_format: 'png',
    n: 1,
    provider: { only: [...cfg.providerOnly], allow_fallbacks: false },
  };
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await d.fetch(`${BASE_URL}/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_S * 1000),
      });
    } catch (e) {
      await d.record(IMAGE_AGENT, model, 0, 0, 0, false, `http ${errName(e)}`, IMAGE_FEATURE);
      throw new ImageProviderError(`lỗi kết nối (${errName(e)})`);
    }
    if (!IMAGE_RETRY_STATUS.includes(resp.status) || attempt) break;
    const ra = resp.headers.get('retry-after') ?? '';
    await resp.body?.cancel().catch(() => {});
    await d.sleep(/^\d+$/.test(ra) ? Math.min(Number(ra), 10) * 1000 : 2000);
  }
  const r = resp as Response;
  if (r.status !== 200) {
    await r.body?.cancel().catch(() => {});
    await d.record(IMAGE_AGENT, model, 0, 0, 0, false, `http ${r.status}`, IMAGE_FEATURE);
    throw new ImageProviderError(`API sinh ảnh trả HTTP ${r.status}`);
  }
  // r13-fix4 F2: HTTP 200 = provider đã sinh ảnh/tính phí → ghi chi phí ĐÚNG 1 lần TRƯỚC khi giải
  // mã/kiểm ảnh, kể cả ảnh hỏng. Không đọc được `usage.cost` hợp lệ → mức dự phòng (fail-closed FinOps).
  let doc: unknown = null;
  try {
    doc = JSON.parse(await r.text());
  } catch {
    doc = null;
  }
  const u = isPlainObject(doc) ? doc.usage : null;
  const usage = isPlainObject(u) ? u : {};
  let cost = usage.cost;
  if (!(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) {
    const fb = cfg.imageCostFallbackUsd;
    cost = typeof fb === 'number' && fb ? fb : COST_FALLBACK_USD;
  }
  let img: Raw | null = null;
  let err: string | null = null;
  let label: string | null = null;
  let raw: Buffer | null = null;
  // Python doc["data"][0]["b64_json"] + b64decode(validate=True) → tên lỗi tương ứng.
  let bad: string | null = null;
  if (!isPlainObject(doc)) bad = 'TypeError';
  else if (!Object.hasOwn(doc, 'data')) bad = 'KeyError';
  else {
    const data = doc.data;
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!Array.isArray(data) && !isPlainObject(data)) bad = 'TypeError';
    else if (isPlainObject(data)) bad = 'KeyError';
    else if (first === undefined) bad = 'IndexError';
    else if (!isPlainObject(first)) bad = 'TypeError';
    else if (!Object.hasOwn(first, 'b64_json')) bad = 'KeyError';
    else if (typeof first.b64_json !== 'string') bad = 'TypeError';
    else if (first.b64_json.length % 4 !== 0 || !B64_RE.test(first.b64_json)) bad = 'Error';
    else raw = Buffer.from(first.b64_json, 'base64');
  }
  if (bad !== null || raw === null) {
    err = 'response API sinh ảnh sai định dạng';
    label = `response hỏng ${bad}`;
  } else if (raw.length > IMAGE_MAX_BYTES) {
    err = 'ảnh trả về quá lớn';
    label = 'ảnh quá lớn';
  } else {
    let format = '';
    try {
      format = (await raster.probe(raw)).format;
      img = await raster.decode(raw, 3);
    } catch (e) {
      if (e instanceof raster.RasterUnavailable) throw new ImageProviderError(e.message);
      const n = format ? 'OSError' : 'UnidentifiedImageError';
      err = `ảnh trả về hỏng (${n})`;
      label = `ảnh hỏng ${n}`;
    }
    if (err === null && !['PNG', 'JPEG', 'WEBP'].includes(format)) {
      err = `ảnh trả về định dạng ${format}`;
      label = err;
    }
  }
  const tok = [usage.prompt_tokens, usage.completion_tokens].map((v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0,
  ) as [number, number];
  await d.record(
    IMAGE_AGENT,
    model,
    tok[0],
    tok[1],
    cost as number,
    err === null,
    label,
    IMAGE_FEATURE,
  );
  if (err !== null) throw new ImageProviderError(err);
  return [img as Raw, { model }];
}
