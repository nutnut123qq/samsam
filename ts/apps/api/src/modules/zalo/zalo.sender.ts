import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pyFloat } from '@samsam/core/ai/gateway';
import type { Env } from '@samsam/core/env';
import { cpSlice, isPlainObject, parseJsonBytes } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { pyTruthy } from '@samsam/core/security/py';
import { left, markLate } from './zalo.budget.js';
import {
  clock,
  deployOn,
  MAX_TEXT,
  MIN_CALL_S,
  OAUTH_URL,
  REFRESH_AHEAD_S,
  REFRESH_MIN_INTERVAL_S,
  REFRESH_TIMEOUT_S,
  SEND_TIMEOUT_S,
  SEND_URL,
} from './zalo.constants.js';
import { liveTransport } from './zalo.convlog.js';
import { uhash } from './zalo.util.js';

// Port phần token + gửi của connectors/zalo.py (V1.1–V2.3, v14.6). Token store
// data/zalo_tokens.json = source-of-truth sau refresh (env chỉ là seed); refresh_token ROTATE
// mỗi lần → persist ngay; KHÔNG log nội dung file/response oauth ở bất kỳ nhánh nào.

export type Tokens = Record<string, unknown>;
/** fetch (thêm `timeoutS` để test đọc được timeout đã dùng — fetch thật bỏ qua trường lạ). */
export type FetchFn = (
  url: string | URL,
  init: RequestInit & { timeoutS?: number },
) => Promise<Response>;

export type SenderConfig = {
  appId: string;
  appSecret: string;
  accessToken: string; // seed env ZALO_ACCESS_TOKEN
  refreshToken: string; // seed env ZALO_REFRESH_TOKEN
  tokenStore: string;
  env: Env;
};

export function senderConfig(env: Env = process.env, tokenStore?: string): SenderConfig {
  return {
    appId: env.ZALO_APP_ID ?? '',
    appSecret: env.ZALO_APP_SECRET ?? '',
    accessToken: env.ZALO_ACCESS_TOKEN ?? '',
    refreshToken: env.ZALO_REFRESH_TOKEN ?? '',
    tokenStore: tokenStore ?? dataPath('zalo_tokens.json'),
    env,
  };
}

/** Khóa async: chạy tuần tự; `waitFree(ms)` = chờ người đang giữ xong (Python acquire+release). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** true = khóa rảnh trong hạn; false = hết hạn mà còn bị giữ. */
  async waitFree(timeoutS: number | null): Promise<boolean> {
    const cur = this.tail;
    if (timeoutS === null) {
      await cur;
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), Math.max(0, timeoutS) * 1000);
    });
    try {
      return await Promise.race([cur.then(() => true as const), t]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
/** AbortSignal.timeout chỉ nhận số nguyên ms (giây lẻ của ngân sách → làm tròn). */
const abortAfter = (s: number) => AbortSignal.timeout(Math.max(0, Math.round(s * 1000)));

/** Body JSON của response (Python `r.json()`): không phải JSON → ValueError. */
async function jsonBody(r: Response): Promise<{ body: unknown; text: string }> {
  const text = await r.text();
  return { body: parseJsonBytes(Buffer.from(text, 'utf8')), text };
}

export class ZaloSender {
  /** V2.3: fallback in-memory CHỈ trong cửa sổ persist-fail; persist OK → xoá. */
  memTokens: Tokens = {};
  /** Lần attempt refresh gần nhất (ok hay không) — monotonic, -Inf = chưa từng (V7.2). */
  lastRefresh = Number.NEGATIVE_INFINITY;
  /** V2.2: mốc refresh THÀNH CÔNG gần nhất. */
  lastRefreshOk = Number.NEGATIVE_INFINITY;
  readonly tokenLock = new Mutex();

  constructor(
    readonly cfg: SenderConfig,
    readonly http: FetchFn = (url, init) => fetch(url, init),
  ) {
    // v15 fix P8.1: chỉ ĐÚNG hàm gửi này (transport thật) sinh provenance "live".
    this.sendText = liveTransport(this.sendText.bind(this));
  }

  readStore(): Tokens {
    try {
      const obj = parseJsonBytes(readFileSync(this.cfg.tokenStore));
      return isPlainObject(obj) ? obj : {};
    } catch {
      return {};
    }
  }

  /** Ghi atomic tmp + rename; file chứa token thật → 0600 ngoài Windows. */
  writeStore(obj: Tokens): void {
    const p = this.cfg.tokenStore;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  }

  private pick(key: string, seed: string): string {
    const m = this.memTokens[key];
    if (typeof m === 'string' && m) return m;
    const s = this.readStore()[key];
    return typeof s === 'string' && s ? s : seed;
  }

  /** mem → store → env seed. */
  currentAccessToken(): string {
    return this.pick('access_token', this.cfg.accessToken);
  }

  currentRefreshToken(): string {
    return this.pick('refresh_token', this.cfg.refreshToken);
  }

  /** expires_at (epoch giây) — mem → store → 0 khi không biết. */
  currentExpiresAt(): number {
    let exp = this.memTokens.expires_at;
    if (exp === undefined || exp === null) exp = this.readStore().expires_at;
    return pyFloat(exp) ?? 0;
  }

  /** V2.1: còn ≤ REFRESH_AHEAD_S → refresh chủ động; không biết (0) → false. */
  tokenExpiringSoon(): boolean {
    const exp = this.currentExpiresAt();
    return exp > 0 && clock.wall() > exp - REFRESH_AHEAD_S;
  }

  canRefresh(): boolean {
    return Boolean(this.currentRefreshToken() && this.cfg.appId && this.cfg.appSecret);
  }

  /**
   * Refresh qua oauth (grant_type=refresh_token, header `secret_key`). Dưới tokenLock để 2 lượt
   * không rotate song song. Mọi lỗi → warn + false, KHÔNG ném; persist-fail vẫn true (token
   * giữ trong mem tới restart).
   */
  refreshAccessToken(timeoutS: number = REFRESH_TIMEOUT_S): Promise<boolean> {
    return this.tokenLock.run(async () => {
      this.lastRefresh = clock.mono();
      const refreshTok = this.currentRefreshToken();
      const { appId, appSecret } = this.cfg;
      if (!(refreshTok && appId && appSecret)) {
        console.log(
          '[warn] zalo: refresh thiếu credential (ZALO_REFRESH_TOKEN/ZALO_APP_ID/ZALO_APP_SECRET)',
        );
        return false;
      }
      let r: Response;
      let body: unknown;
      try {
        r = await this.http(OAUTH_URL, {
          method: 'POST',
          headers: { secret_key: appSecret, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            app_id: appId,
            grant_type: 'refresh_token',
            refresh_token: refreshTok,
          }).toString(),
          redirect: 'manual',
          signal: abortAfter(timeoutS),
          timeoutS,
        });
        ({ body } = await jsonBody(r));
      } catch (e) {
        console.log(`[warn] zalo: refresh token lỗi ${errName(e)}`);
        return false;
      }
      const access = isPlainObject(body) ? body.access_token : undefined;
      if (r.status !== 200 || !pyTruthy(access)) {
        // Không log body — response oauth có thể chứa chi tiết nhạy cảm.
        console.log(`[warn] zalo: refresh token HTTP ${r.status}`);
        return false;
      }
      const b = body as Record<string, unknown>;
      const expiresIn = pyFloat(pyTruthy(b.expires_in) ? b.expires_in : 0) ?? 0;
      const newRefresh = b.refresh_token;
      const tokens: Tokens = {
        access_token: access,
        // Thiếu field thì giữ token đang có — tốt hơn ghi None làm mất hẳn đường refresh.
        refresh_token: typeof newRefresh === 'string' && newRefresh ? newRefresh : refreshTok,
        // expires_in thiếu/≤0 → 0 = "không biết" (ghi now() làm mọi send đều rotate).
        expires_at: expiresIn > 0 ? clock.wall() + expiresIn : 0,
      };
      try {
        this.writeStore(tokens);
        this.memTokens = {};
      } catch (e) {
        this.memTokens = tokens;
        console.log(
          `[warn] zalo: ghi token store lỗi ${errName(e)} — token đã rotate, chỉ giữ trong-process tới restart`,
        );
      }
      this.lastRefreshOk = clock.mono();
      return true;
    });
  }

  /** Refresh TRONG hạn chót: còn ≥ MIN_CALL_S + SEND_TIMEOUT_S, timeout = còn lại − phần gửi. */
  private refreshInBudget(): Promise<boolean> {
    const l = left();
    if (l === null) return this.refreshAccessToken();
    const budget = Math.min(REFRESH_TIMEOUT_S, l - SEND_TIMEOUT_S);
    if (budget < MIN_CALL_S) {
      markLate('lam_moi_token');
      return Promise.resolve(false);
    }
    return this.refreshAccessToken(budget);
  }

  /** Chờ refresh đang chạy ở lượt khác — tối đa ngân sách còn lại trừ phần gửi. */
  private async waitRefreshInFlight(): Promise<void> {
    const l = left();
    if (l === null) {
      await this.tokenLock.waitFree(null);
      return;
    }
    if (!(await this.tokenLock.waitFree(Math.max(0, l - SEND_TIMEOUT_S)))) markLate('cho_token');
  }

  /**
   * Gọi CS message API đúng 1 lần. true = đã gửi; false = API trả lỗi rõ (status≠200 / error≠0)
   * → đáng refresh + retry; null = lỗi transport/decode (không rõ tới Zalo chưa) → KHÔNG retry.
   */
  async sendOnce(
    userId: string,
    text: string,
    token: string,
    timeoutS: number | null = null,
  ): Promise<boolean | null> {
    try {
      const u = new URL(SEND_URL);
      u.searchParams.set('access_token', token);
      const r = await this.http(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { user_id: userId },
          message: { text: cpSlice(text, 0, MAX_TEXT) },
        }),
        redirect: 'manual',
        signal: abortAfter(timeoutS ?? SEND_TIMEOUT_S),
        timeoutS: timeoutS ?? SEND_TIMEOUT_S,
      });
      const { body, text: raw } = await jsonBody(r);
      const err = isPlainObject(body) ? body.error : undefined;
      // Python `body.get("error") == 0`: 0 / 0.0 / False đều bằng 0.
      const ok = r.status === 200 && (err === 0 || err === false);
      if (!ok) console.log(`[warn] zalo: send API trả ${r.status} ${cpSlice(raw, 0, 200)}`);
      return ok;
    } catch (e) {
      console.log(`[warn] zalo: send API lỗi ${errName(e)}`);
      return null;
    }
  }

  /**
   * DEPLOY tắt → dry-run (không chạm mạng, false). Token mem → store → env; chưa có / sắp hết
   * hạn + đủ credential → refresh trước (throttle theo attempt). API lỗi rõ + còn đường refresh →
   * retry ĐÚNG 1 lần (V2.2). Trong lượt có hạn chót, mọi bước chỉ dùng phần ngân sách còn lại.
   */
  async sendText(userId: string, text: string): Promise<boolean> {
    if (!deployOn(this.cfg.env)) {
      // Đợt hợp đồng G5: dev/staging KHÔNG gửi ra Zalo kể cả khi lỡ có token thật.
      console.log(`[dry-run] zalo: DEPLOY tắt — không gửi (uh=${uhash(userId)})`);
      return false;
    }
    let token = this.currentAccessToken();
    if (this.canRefresh() && (!token || this.tokenExpiringSoon())) {
      if (clock.mono() - this.lastRefresh > REFRESH_MIN_INTERVAL_S) await this.refreshInBudget();
      else await this.waitRefreshInFlight();
      token = this.currentAccessToken();
    }
    if (!token) {
      console.log(
        `[warn] zalo: chưa có access token (ZALO_ACCESS_TOKEN/token store) — không gửi (uh=${uhash(userId)})`,
      );
      return false;
    }
    // docx P1: lần gửi ĐẦU cũng chỉ dùng phần ngân sách còn lại.
    const l = left();
    if (l !== null && l < MIN_CALL_S) {
      markLate('gui');
      return false;
    }
    let res = await this.sendOnce(
      userId,
      text,
      token,
      l === null ? null : Math.min(SEND_TIMEOUT_S, l),
    );
    if (res === false && this.canRefresh()) {
      if (
        clock.mono() - this.lastRefresh > REFRESH_MIN_INTERVAL_S &&
        (await this.refreshInBudget())
      ) {
        res = await this.resend(userId, text);
      } else {
        // Attempt gần đây: lượt khác ĐANG refresh (chờ xong) hoặc vừa fail (khóa rảnh ngay).
        await this.waitRefreshInFlight();
        if (clock.mono() - this.lastRefreshOk <= REFRESH_MIN_INTERVAL_S) {
          res = await this.resend(userId, text);
        }
      }
    }
    return res === true;
  }

  private async resend(userId: string, text: string): Promise<boolean | null> {
    const l = left();
    if (l !== null && l < MIN_CALL_S) {
      markLate('gui_lai');
      return null;
    }
    return this.sendOnce(
      userId,
      text,
      this.currentAccessToken(),
      l === null ? null : Math.min(SEND_TIMEOUT_S, l),
    );
  }
}
