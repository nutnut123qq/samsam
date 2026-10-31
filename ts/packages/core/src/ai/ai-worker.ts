import { type Env, pyStrip } from '../env.js';
import { internalUrl } from './net.js';
import type { FetchLike } from './providers.js';

// Client của AI worker Python (`ai_worker/`, mạng ai_private): OCR tại chỗ (paddle_local — bọc
// `ingest/ocr_worker.py`) + STT tại chỗ (whisper_local — `connectors/zalo_garden._stt_whisper_local`).
// Port phần STT provider của `connectors/zalo_garden.py` (`STT_HELP`, `stt_provider`): `none`/lạ →
// chặn kèm hướng dẫn, KHÔNG gửi audio. KHÁC Python có chủ đích: model whisper nằm ở máy AI worker
// nên `whisper_local` ở TS cần `AI_WORKER_URL` nội bộ (worker tự kiểm GARDEN_STT_MODEL_DIR/model.bin
// trước khi đọc audio → 503 blocked).

export const STT_HELP =
  'chưa cấu hình STT: BLOCKED — cần vendor STT trong nước + hợp ' +
  'đồng/DPA + key (Bên B/Pháp chế chọn), cắm vào ' +
  'connectors.zalo_garden.STT_PROVIDERS rồi đặt GARDEN_STT_PROVIDER; ' +
  'tạm thời người nghe ghi âm rồi ghi nhật ký tay ' +
  '(python -m agents.garden) và đóng nháp --done';
// name → chạy ở đâu (null = chưa có STT). Mọi mục đều trong nước (audio không rời server).
const STT_PROVIDERS: Record<string, 'ai_worker' | null> = {
  none: null,
  whisper_local: 'ai_worker',
};

/** Lỗi gọi AI worker (kết nối, HTTP lạ, kết quả hỏng) — caller exit 1. */
export class AiWorkerError extends Error {}
/** Worker/provider chưa cấu hình — KHÔNG gửi/đọc dữ liệu; caller exit 2 ([blocked]). */
export class AiWorkerBlocked extends AiWorkerError {}
/** Tài liệu/ghi âm lỗi có mô tả (Python DocError / RuntimeError STT) — thông điệp đã che PII. */
export class AiWorkerRejected extends AiWorkerError {}

/** Python `repr(str)` (nháy đơn, trừ khi có ' mà không có "; ký tự không in được → \x/\u/\U). */
export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '\\' || ch === q) out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch !== ' ' && /[\p{C}\p{Z}]/u.test(ch)) {
      out +=
        c < 0x100
          ? `\\x${c.toString(16).padStart(2, '0')}`
          : c < 0x10000
            ? `\\u${c.toString(16).padStart(4, '0')}`
            : `\\U${c.toString(16).padStart(8, '0')}`;
    } else out += ch;
  }
  return out + q;
}

/** `stt_provider`: [tên, lỗi|null]. Lỗi → người gọi KHÔNG gửi audio. */
export function sttProvider(env: Env = process.env): [string, string | null] {
  const name = pyStrip(env.GARDEN_STT_PROVIDER ?? '') || 'none';
  if (!Object.hasOwn(STT_PROVIDERS, name)) {
    return [
      name,
      `GARDEN_STT_PROVIDER=${pyRepr(Array.from(name).slice(0, 40).join(''))} chưa tích hợp — ${STT_HELP}`,
    ];
  }
  if (STT_PROVIDERS[name] === null) return [name, STT_HELP];
  const w = internalUrl(env.AI_WORKER_URL, 'AI_WORKER_URL');
  if (w.error !== null)
    return [name, `whisper_local cần AI worker nội bộ (${w.error}) — ${STT_HELP}`];
  return [name, null];
}

const timeoutMs = (env: Env) => {
  const s = Number(pyStrip(env.AI_WORKER_TIMEOUT_S ?? '') || '400');
  return Number.isFinite(s) && s > 0 ? s * 1000 : 400_000;
};

function workerUrl(env: Env): string {
  const w = internalUrl(env.AI_WORKER_URL, 'AI_WORKER_URL');
  if (w.error !== null) throw new AiWorkerBlocked(w.error);
  return w.url;
}

type Reply = { ok?: unknown; text?: unknown; error?: unknown; blocked?: unknown };

async function post(
  env: Env,
  route: '/ocr' | '/stt',
  data: Uint8Array,
  f: FetchLike,
): Promise<string> {
  const url = `${workerUrl(env)}${route}`;
  let res: Response;
  let j: Reply | null = null;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
      signal: AbortSignal.timeout(timeoutMs(env)),
      redirect: 'error',
    });
    j = (await res.json().catch(() => null)) as Reply | null;
  } catch (e) {
    throw new AiWorkerError(`AI worker không phản hồi (${(e as Error).name})`);
  }
  const err = typeof j?.error === 'string' ? j.error.slice(0, 300) : null;
  if (res.status === 503 && j?.blocked === true && err) throw new AiWorkerBlocked(err);
  if ((res.status === 200 || res.status === 400 || res.status === 413) && j?.ok === false && err) {
    throw new AiWorkerRejected(err);
  }
  if (res.status === 200 && j?.ok === true && typeof j.text === 'string') return j.text;
  throw new AiWorkerError(`AI worker trả kết quả hỏng (HTTP ${res.status})`);
}

/** OCR tại chỗ (paddle_local) → text; lỗi tài liệu → AiWorkerRejected (Python DocError). */
export function ocrViaWorker(
  file: Uint8Array,
  env: Env = process.env,
  f: FetchLike = fetch,
): Promise<string> {
  return post(env, '/ocr', file, f);
}

/** Chép lời TẠI CHỖ → NHÁP đã che PII (≤ 1000 ký tự); provider chưa cấu hình → AiWorkerBlocked, không gửi. */
export async function transcribe(
  audio: Uint8Array,
  env: Env = process.env,
  f: FetchLike = fetch,
): Promise<string> {
  const [, err] = sttProvider(env);
  if (err) throw new AiWorkerBlocked(err);
  return post(env, '/stt', audio, f);
}

/** `/readyz`: {ocr, stt} = null (sẵn sàng) | lý do chưa dùng được. Không gửi dữ liệu. */
export async function workerReady(
  env: Env = process.env,
  f: FetchLike = fetch,
): Promise<{ ocr: string | null; stt: string | null }> {
  try {
    const res = await f(`${workerUrl(env)}/readyz`, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const j = (await res.json()) as { ocr?: unknown; stt?: unknown };
    const v = (x: unknown) => (x === null ? null : typeof x === 'string' ? x : 'trạng thái lạ');
    if (res.ok) return { ocr: v(j.ocr), stt: v(j.stt) };
  } catch (e) {
    if (e instanceof AiWorkerBlocked) throw e;
  }
  throw new AiWorkerError('AI worker không phản hồi /readyz');
}
