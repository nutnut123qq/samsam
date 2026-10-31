import Anthropic from '@anthropic-ai/sdk';

// Nhà cung cấp của AI Gateway (chỉ gateway.ts gọi). Ollama nội bộ = mặc định; Claude chỉ khi
// `data/ai_policy.json` cho phép đúng tính năng (gateway kiểm trước). Gọi ĐÚNG 1 lần, không retry,
// không redirect, không tự chuyển nhà cung cấp khác.

export type Role = 'system' | 'user' | 'assistant';
export type ContentPart = { type: string; text?: unknown; [k: string]: unknown };
export type ChatMessage = { role: Role; content: string | ContentPart[]; [k: string]: unknown };

/** Kết quả nhà cung cấp sai dạng — gateway ghi lỗi + fail-closed. */
export class ProviderError extends Error {
  override name = 'ProviderError';
}
/** Đầu vào không gửi được (không phải lỗi nhà cung cấp — không ghi llm_usage). */
export class ProviderInputError extends Error {}

export type Usage = { tokensIn: number; tokensOut: number };
export type FetchLike = typeof fetch;

const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;

/** Nội dung → text (multimodal chỉ nhận phần `text`; phần khác = lỗi, không lặng lẽ bỏ). */
export function textOf(c: ChatMessage['content']): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) throw new ProviderInputError('nội dung message không phải text');
  return c
    .map((p) => {
      if (p?.type !== 'text' || typeof p.text !== 'string') {
        throw new ProviderInputError('chỉ gửi được nội dung text');
      }
      return p.text;
    })
    .join('\n');
}

function roleOf(m: ChatMessage): Role {
  if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') {
    throw new ProviderInputError('role message không hợp lệ');
  }
  return m.role;
}

async function postJson(
  f: FetchLike,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
  return res.json();
}

export type ChatCall = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  timeoutMs: number;
};

/** Ollama `/api/chat` (không stream; `think: false` — chatbot có hạn tổng 30 s). */
export async function ollamaChat(
  baseUrl: string,
  call: ChatCall,
  f: FetchLike = fetch,
): Promise<{ text: string } & Usage> {
  const options: Record<string, number> = {};
  if (call.temperature !== undefined) options.temperature = call.temperature;
  if (call.seed !== undefined) options.seed = call.seed;
  if (call.maxTokens !== undefined) options.num_predict = call.maxTokens;
  const messages = call.messages.map((m) => ({ role: roleOf(m), content: textOf(m.content) }));
  const j = (await postJson(
    f,
    `${baseUrl}/api/chat`,
    { model: call.model, messages, stream: false, think: false, options },
    call.timeoutMs,
  )) as {
    message?: { content?: unknown };
    prompt_eval_count?: unknown;
    eval_count?: unknown;
  } | null;
  const text = j?.message?.content;
  if (typeof text !== 'string') throw new ProviderError('kết quả chat sai dạng');
  return { text, tokensIn: count(j?.prompt_eval_count), tokensOut: count(j?.eval_count) };
}

/** Ollama `/api/embed` — kiểm đủ số vector + đúng số chiều (cột `embedding_v2 vector(1024)`). */
export async function ollamaEmbed(
  baseUrl: string,
  call: { model: string; input: string | string[]; dim: number; timeoutMs: number },
  f: FetchLike = fetch,
): Promise<{ embeddings: number[][] } & Usage> {
  const j = (await postJson(
    f,
    `${baseUrl}/api/embed`,
    { model: call.model, input: call.input },
    call.timeoutMs,
  )) as { embeddings?: unknown; prompt_eval_count?: unknown } | null;
  const want = Array.isArray(call.input) ? call.input.length : 1;
  const e = j?.embeddings;
  if (
    !Array.isArray(e) ||
    e.length !== want ||
    !e.every(
      (v) =>
        Array.isArray(v) &&
        v.length === call.dim &&
        v.every((x) => typeof x === 'number' && Number.isFinite(x)),
    )
  ) {
    throw new ProviderError('kết quả embedding sai dạng/số chiều');
  }
  return { embeddings: e as number[][], tokensIn: count(j?.prompt_eval_count), tokensOut: 0 };
}

export type AnthropicLike = {
  messages: {
    create(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  };
};
export type AnthropicFactory = (opts: {
  apiKey: string;
  baseURL: string;
  maxRetries: number;
  timeout: number;
}) => AnthropicLike;

// baseURL cố định: SDK mặc định đọc ANTHROPIC_BASE_URL — không để biến môi trường đổi đích gửi.
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const defaultAnthropic: AnthropicFactory = (o) =>
  new Anthropic(o) as unknown as AnthropicLike;

/** Claude Messages API — `maxRetries: 0`, 1 lời gọi. */
export async function claudeChat(
  apiKey: string,
  call: ChatCall & { maxTokens: number },
  factory: AnthropicFactory = defaultAnthropic,
): Promise<{ text: string } & Usage> {
  const system = call.messages
    .filter((m) => roleOf(m) === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n');
  const messages = call.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: roleOf(m), content: textOf(m.content) }));
  const client = factory({
    apiKey,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: 0,
    timeout: call.timeoutMs,
  });
  const body: Record<string, unknown> = { model: call.model, max_tokens: call.maxTokens, messages };
  if (system) body.system = system;
  if (call.temperature !== undefined) body.temperature = call.temperature;
  const r = (await client.messages.create(body, {
    signal: AbortSignal.timeout(call.timeoutMs),
  })) as {
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  if (!Array.isArray(r?.content)) throw new ProviderError('kết quả Claude sai dạng');
  const text = (r.content as { type?: unknown; text?: unknown }[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return { text, tokensIn: count(r.usage?.input_tokens), tokensOut: count(r.usage?.output_tokens) };
}
