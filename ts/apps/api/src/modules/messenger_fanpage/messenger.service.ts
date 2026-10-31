import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { type Env, pyStrip } from '@samsam/core/env';
import { cpSlice, isPlainObject } from '@samsam/core/ops/py';
import { pyTruthy } from '@samsam/core/security/py';
import { MIN_SALT_LEN, SALT_ENV, userHash } from '../channels/channels.service.js';
import { left, setLate } from '../zalo/zalo.budget.js';
import { deployOn, MIN_CALL_S, NON_TEXT_TEXT, SEND_TIMEOUT_S } from '../zalo/zalo.constants.js';
import { liveTransport } from '../zalo/zalo.convlog.js';
import type { SendFn } from '../zalo/zalo.deps.js';
import type { FetchFn } from '../zalo/zalo.sender.js';
import { ZaloService } from '../zalo/zalo.service.js';
import { uhash } from '../zalo/zalo.util.js';

// Port connectors/messenger.py (v5.1 WP07, KD-A1) — Messenger (Facebook Page) webhook: nhận tin →
// ACK 200 nhanh → trả lời async qua CHUNG pipeline Zalo (`ZaloService.handleText(..., { channel:
// 'messenger', send })`: lock theo user, history, convlog chỉ user_hash + câu khách đã che PII,
// luật rượu/sức khỏe trước LLM, cổng triển khai sales-01, guardrail, handoff, đồng ý). Chỉ inbox
// reply — không đăng bài (C2.4).
// Bảo mật: POST phải có `X-Hub-Signature-256` = "sha256=" + HMAC-SHA256(MESSENGER_APP_SECRET, raw
// body) — KHÔNG bypass dev (thiếu secret/chữ ký sai/thiếu → 403, không parse). GET verify của Meta:
// `hub.mode=subscribe` + `hub.verify_token` khớp MESSENGER_VERIFY_TOKEN (rỗng → 403) → trả
// `hub.challenge` (chỉ chữ số). DEPLOY tắt → gửi KHÔNG chạm mạng, chỉ in [dry-run]; DEPLOY bật →
// Graph API, token ở header Bearer (không trong URL). Dedup theo `mid` vào cùng sqlite của Zalo
// (khóa tiền tố `msgr:`). Log chỉ `uhash`, không psid thô.

export const PATH = '/messenger-webhook';
export const GRAPH_VERSION = 'v21.0';
export const SEND_URL = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;
export const MAX_BODY = 1024 * 1024; // 1MB — event Messenger là JSON nhỏ
export const MAX_TEXT = 2000; // giới hạn text tin nhắn Messenger
export const KEY_PREFIX = 'messenger:';
export const DEFAULT_PORT = 8789;
export const REQUIRED_ENV = [
  'MESSENGER_APP_SECRET',
  'MESSENGER_PAGE_TOKEN',
  'MESSENGER_VERIFY_TOKEN',
] as const;
// Python `\d` (str) = chữ số Unicode → `\p{Nd}`; challenge chỉ ASCII (Python `.encode("ascii")`
// trên chữ số Unicode làm handler crash, mất response → TS trả 400 — chặt hơn có chủ đích).
export const PSID_RE = /^\p{Nd}{1,32}$/u;
export const CHALLENGE_RE = /^[0-9]{1,64}$/;

export const MESSENGER_OPTIONS = Symbol('MESSENGER_OPTIONS');
export type MessengerOptions = { env: Env; fetch: FetchFn };

/** `os.environ.get(key, "").strip()` */
export const envStr = (env: Env, key: string): string => pyStrip(env[key] ?? '');

/** DEPLOY bật mà thiếu secret/token/muối → thông điệp fatal; dev → null. */
export function startupError(env: Env = process.env): string | null {
  if (!deployOn(env)) return null;
  const missing: string[] = REQUIRED_ENV.filter((k) => !envStr(env, k));
  // Muối thiếu/ngắn (< MIN_SALT_LEN) = không băm được user → coi như thiếu (channels._salt).
  if (userHash('messenger', '', env) === null) missing.push(`${SALT_ENV} (≥${MIN_SALT_LEN} ký tự)`);
  if (missing.length) {
    return `[fatal] messenger: DEPLOY bật nhưng thiếu ${missing.join(', ')} — từ chối serve`;
  }
  return null;
}

/** X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(app secret, body). Thiếu secret hoặc header →
 * false (không có bypass dev). */
export function verifySignature(
  raw: Uint8Array,
  header: string | null | undefined,
  env: Env = process.env,
): boolean {
  const secret = envStr(env, 'MESSENGER_APP_SECRET');
  if (!secret || !header) return false;
  const expect = `sha256=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(raw).digest('hex')}`;
  // Python header.strip().encode("latin-1", "replace"): ký tự ngoài latin-1 → '?'.
  const got = Buffer.from(pyStrip(header).replace(/[\u{100}-\u{10ffff}]/gu, '?'), 'latin1');
  const want = Buffer.from(expect, 'latin1');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Python `for x in (v or [])` trên giá trị JSON: falsy → rỗng; chuỗi/dict → phần tử không phải
 * dict (bị bỏ); số/bool truthy → TypeError (Python ném, event dừng ở đó). */
function items(v: unknown): unknown[] {
  if (!pyTruthy(v)) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' || isPlainObject(v)) return [];
  throw new TypeError('event: trường không lặp được');
}

/** Python `(x or {}).get(...)`: truthy không phải dict → AttributeError. */
function obj(v: unknown): Record<string, unknown> {
  if (!pyTruthy(v)) return {};
  if (isPlainObject(v)) return v;
  throw new TypeError('event: trường không phải object');
}

@Injectable()
export class MessengerService implements OnModuleInit {
  readonly env: Env;
  private readonly http: FetchFn;
  /** Trần body POST (test hạ xuống). */
  maxBody = MAX_BODY;
  /** Lỗi cấu hình lúc khởi động (DEPLOY bật) — webhook từ chối xử lý POST. */
  configError: string | null = null;
  /** Transport gửi THẬT (v15 fix P8.1: chỉ hàm này sinh provenance "live"). Test thay được. */
  sendText: SendFn;

  constructor(
    @Inject(ZaloService) readonly zalo: ZaloService,
    @Optional() @Inject(MESSENGER_OPTIONS) opts: Partial<MessengerOptions> = {},
  ) {
    this.env = opts.env ?? process.env;
    this.http = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sendText = liveTransport(this.send.bind(this));
  }

  onModuleInit(): void {
    this.configError = startupError(this.env);
    if (this.configError) console.log(this.configError);
  }

  startupError(): string | null {
    return startupError(this.env);
  }

  verifySignature(raw: Uint8Array, header: string | null | undefined): boolean {
    return verifySignature(raw, header, this.env);
  }

  /** Gửi 1 tin qua Graph API. DEPLOY tắt → không gửi gì ra Meta. */
  private async send(userKey: string, text: string): Promise<boolean> {
    const uh = uhash(userKey);
    if (!deployOn(this.env)) {
      console.log(`[dry-run] messenger: DEPLOY tắt — không gửi (uh=${uh})`);
      return false;
    }
    const token = envStr(this.env, 'MESSENGER_PAGE_TOKEN');
    const psid = userKey.startsWith(KEY_PREFIX) ? userKey.slice(KEY_PREFIX.length) : userKey;
    if (!token || !PSID_RE.test(psid)) {
      console.log(`[warn] messenger: thiếu page token hoặc psid lạ — không gửi (uh=${uh})`);
      return false;
    }
    // v15.1: trong lượt trả lời có hạn chót TỔNG 30 giây, timeout gửi = min(SEND_TIMEOUT_S, còn
    // lại); còn < MIN_CALL_S → không gọi Graph API, ghi bước trễ để pipeline chuyển người lý do
    // `deadline`. Không có hạn chót (tin không phải chữ) → SEND_TIMEOUT_S.
    const l = left();
    if (l !== null && l < MIN_CALL_S) {
      setLate('gui');
      console.log(`[deadline] messenger: bỏ bước gui — không đủ ngân sách 30 giây (uh=${uh})`);
      return false;
    }
    const timeoutS = l === null ? SEND_TIMEOUT_S : Math.min(SEND_TIMEOUT_S, l);
    let r: Response;
    try {
      r = await this.http(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: { text: cpSlice(text, 0, MAX_TEXT) },
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutS * 1000),
        timeoutS,
      });
    } catch (e) {
      console.log(`[warn] messenger: send lỗi ${(e as Error)?.name ?? 'Error'} (uh=${uh})`);
      return false;
    }
    r.body?.cancel().catch(() => {});
    if (!(r.status >= 200 && r.status < 300)) {
      // Không in body — có thể lặp lại psid/chi tiết token.
      console.log(`[warn] messenger: send HTTP ${r.status} (uh=${uh})`);
      return false;
    }
    return true;
  }

  /** Tin không phải chữ (ảnh/file/sticker) → NON_TEXT_TEXT, cùng lock với text (không đảo thứ tự). */
  handleNonText(userKey: string): Promise<unknown> {
    return this.zalo.withUserLock(userKey, async () => this.sendText(userKey, NON_TEXT_TEXT));
  }

  /**
   * Event `object=page` → mỗi tin (không echo, mid chưa thấy) chạy nền → số tin đã dispatch.
   * Python ném giữa chừng (trường sai kiểu) sau khi đã khởi chạy các tin trước; TS log + trả số
   * đã khởi chạy (các tin sau bị bỏ y như Python).
   */
  dispatch(ev: unknown): number {
    if (!isPlainObject(ev) || ev.object !== 'page') return 0;
    let n = 0;
    try {
      for (const entry of items(ev.entry)) {
        if (!isPlainObject(entry)) continue;
        for (const m of items(entry.messaging)) {
          if (!isPlainObject(m)) continue;
          const msg = m.message;
          const psid = obj(m.sender).id;
          if (!isPlainObject(msg) || pyTruthy(msg.is_echo)) continue;
          const mid = msg.mid;
          if (!(typeof psid === 'string' && PSID_RE.test(psid) && typeof mid === 'string' && mid)) {
            continue;
          }
          const mid200 = cpSlice(mid, 0, 200);
          if (this.zalo.dedup(`msgr:${mid200}`)) continue;
          const key = KEY_PREFIX + psid;
          const text = msg.text;
          const send = this.sendText; // tra lúc dispatch — test thay sendText được
          const run =
            typeof text === 'string' && pyStrip(text)
              ? () =>
                  this.zalo.handleText(key, pyStrip(text), mid200, { channel: 'messenger', send })
              : () => this.handleNonText(key);
          run().catch((e) =>
            console.error(`[error] messenger: xử lý tin lỗi (${(e as Error)?.name ?? 'Error'})`),
          );
          n++;
        }
      }
    } catch (e) {
      console.log(`[warn] messenger: bỏ event không hợp lệ (${(e as Error).name})`);
    }
    return n;
  }
}
