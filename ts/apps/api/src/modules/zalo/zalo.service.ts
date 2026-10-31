import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { approvalEnforced, type Env } from '@samsam/core/env';
import { cpSlice, isPlainObject } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { pyRepr, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { sendLate, withBudget } from './zalo.budget.js';
import {
  clock,
  DEFAULT_PORT,
  deployOn,
  ERROR_FALLBACK,
  HANDOFF_TEXT,
  HIST_MAX_USERS,
  HOLD_TEXT,
  NO_HANDOFF_TEXT,
  NO_HANDOFF_TEXTS,
  NON_TEXT_TEXT,
  WELCOME_TEXT,
} from './zalo.constants.js';
import { ConvLog, type Entry, logQuestion, provenance, tsNow, unanswered } from './zalo.convlog.js';
import { SeenDb } from './zalo.dedup.js';
import {
  type AnswerResult,
  type ChatChannels,
  type ChatMsg,
  type ChatRag,
  DeadlineExceeded,
  type GardenIntake,
  type Gate,
  type Inbound,
  isDeadline,
  type ReplyMeta,
  type SendFn,
  UNWIRED_CHANNELS,
  UNWIRED_GARDEN,
  UNWIRED_RAG,
  type WebhookDeps,
  ZALO_CHANNELS,
  ZALO_DB,
  ZALO_GARDEN,
  ZALO_OPTIONS,
  ZALO_RAG,
} from './zalo.deps.js';
import { type FetchFn, senderConfig, ZaloSender } from './zalo.sender.js';
import { uhash, verifySignature } from './zalo.util.js';

// Port connectors/zalo.py: webhook Zalo OA → ACK 200 nhanh → trả lời async qua send API.
// Pipeline: lớp kênh (luật trước LLM, đồng ý) → cổng triển khai (chatbot_mode) → answer() trong
// hạn chót 30 giây → guardrail (format_reply) → gửi → convlog → ghi DB SAU khi gửi (DB down chỉ
// warn, khách không câm). Câu hứa "nhân viên sẽ phản hồi" CHỈ khi đã ghi được mục cskh_handoff.
// Chỉ inbox reply — không đường nào đăng bài/listing (C2.4).

export type ZaloOptions = {
  env: Env;
  seenDb: string;
  convLog: string;
  tokenStore: string;
  fetch: FetchFn;
};
export type ReplyOut = Record<string, unknown> & { sent: unknown; text: string };
type TurnOpts = { channel?: string; send?: SendFn | null; tRecv?: number | null };

const STRIPES = 64;
const ms = (t0: number) => Math.trunc((clock.mono() - t0) * 1000);

/** Python `repr(e)` của exception một tham số. */
function errRepr(e: unknown): string {
  if (e instanceof Error) return `${e.name}(${pyRepr(e.message)})`;
  return pyRepr(String(e));
}

/** Python `(x or {})` rồi `.get` — giá trị truthy không phải dict làm Python ném → bỏ event. */
function obj(v: unknown): Record<string, unknown> {
  if (!pyTruthy(v)) return {};
  if (isPlainObject(v)) return v;
  throw new TypeError('event: trường không phải object');
}

/** Trường chuỗi của event: falsy → ''; truthy không phải chuỗi → bỏ event (Python ném ở
 * `.strip()`/`staff_code` → thread chết, cũng không xử lý). */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!pyTruthy(v)) return '';
  throw new TypeError('event: trường không phải chuỗi');
}

/**
 * DEPLOY bật mà lớp kênh/RAG chưa nối (lỗi tích hợp — Python luôn import được) → mọi khách chỉ
 * nhận hotline trong khi probe im lặng → từ chối serve như thiếu cấu hình. Dev → null.
 */
export function wiringError(env: Env, deps: WebhookDeps): string | null {
  if (!deployOn(env)) return null;
  const { channels, rag } = deps;
  if (!channels || channels === UNWIRED_CHANNELS || !rag || rag === UNWIRED_RAG) {
    return (
      '[fatal] zalo: DEPLOY bật nhưng chưa nối lớp kênh/RAG (ZALO_CHANNELS/ZALO_RAG) — ' +
      'từ chối serve'
    );
  }
  return null;
}

@Injectable()
export class ZaloService implements OnModuleInit {
  oaSecret: string;
  readonly port: number;
  readonly sender: ZaloSender;
  readonly convlog: ConvLog;
  readonly seen: SeenDb;
  /** user_id → tối đa 4 cặp Q&A gần nhất (D4.1); Map giữ thứ tự = LRU (evict user cũ nhất). */
  readonly histories = new Map<string, ChatMsg[]>();
  histMaxUsers = HIST_MAX_USERS;
  /** Transport gửi mặc định (live). Test thay bằng hàm giả → provenance "sample". */
  sendText: SendFn;
  private readonly stripes: Promise<void>[] = Array.from({ length: STRIPES }, () =>
    Promise.resolve(),
  );

  constructor(
    @Optional() @Inject(ZALO_DB) private readonly pool: Pool | null = null,
    @Optional() @Inject(ZALO_CHANNELS) readonly channels: ChatChannels = UNWIRED_CHANNELS,
    @Optional() @Inject(ZALO_RAG) readonly rag: ChatRag = UNWIRED_RAG,
    @Optional() @Inject(ZALO_GARDEN) readonly garden: GardenIntake = UNWIRED_GARDEN,
    @Optional() @Inject(ZALO_OPTIONS) opts: Partial<ZaloOptions> = {},
  ) {
    const env = opts.env ?? process.env;
    // V1.2 — 2 secret tách riêng: OA secret verify webhook; app secret gọi oauth refresh.
    this.oaSecret = env.ZALO_OA_SECRET ?? '';
    this.port = Number(env.ZALO_WEBHOOK_PORT || DEFAULT_PORT);
    this.sender = new ZaloSender(senderConfig(env, opts.tokenStore), opts.fetch);
    this.sendText = this.sender.sendText;
    this.convlog = new ConvLog(opts.convLog ?? dataPath('conversations.jsonl'), () => this.pool);
    this.seen = new SeenDb(opts.seenDb ?? dataPath('zalo_seen.db'));
  }

  get env(): Env {
    return this.sender.cfg.env;
  }

  /** Chạy chung API (Python `main()`): in lỗi cấu hình + purge convlog lúc boot (D5.11). */
  onModuleInit(): void {
    const err = this.configProblem();
    if (err) console.log(err);
    this.convlog.bootPurge();
  }

  /**
   * Lỗi cấu hình HIỆN HÀNH — POST và /readyz dùng chung, đọc live mỗi lần (token store sửa tay có
   * hiệu lực ngay, như systemd restart lại `main()` ở Python): `_startup_error` + chưa nối lớp
   * kênh/RAG khi DEPLOY bật.
   */
  configProblem(): string | null {
    return this.startupError() ?? wiringError(this.env, { channels: this.channels, rag: this.rag });
  }

  verifySignature(raw: Uint8Array, header: string): boolean {
    return verifySignature(raw, header, this.oaSecret);
  }

  /**
   * DEPLOY bật → từ chối serve khi thiếu ZALO_OA_SECRET (nhận request giả mạo) HOẶC không có đường
   * send nào (thiếu access token lẫn bộ refresh — ACK 200 mà reply không bao giờ tới). Dev → null.
   * TS chặt hơn (review cuối): chế độ thực (APPROVAL_ENFORCE/AUTH_MODE local|proxy/NODE_ENV=
   * production) mà thiếu secret cũng từ chối dù DEPLOY tắt — `verifySignature` bỏ qua khi không có
   * secret, ai cũng giả được tin khách (convlog/leads/hàng duyệt, tốn GPU).
   */
  startupError(): string | null {
    const real = approvalEnforced(this.env) || pyStrip(this.env.NODE_ENV ?? '') === 'production';
    if (!this.oaSecret && real && !deployOn(this.env)) {
      return (
        '[fatal] zalo: chế độ thực nhưng thiếu ZALO_OA_SECRET — ' +
        'webhook không verify signature được, từ chối serve'
      );
    }
    if (!deployOn(this.env)) return null;
    if (!this.oaSecret) {
      return (
        '[fatal] zalo: DEPLOY bật nhưng thiếu ZALO_OA_SECRET — ' +
        'webhook không verify signature được, từ chối serve'
      );
    }
    if (!this.sender.currentAccessToken() && !this.sender.canRefresh()) {
      return (
        '[fatal] zalo: DEPLOY bật nhưng không có đường send — ' +
        'thiếu ZALO_ACCESS_TOKEN và đồng thời thiếu bộ ' +
        'ZALO_REFRESH_TOKEN+ZALO_APP_ID+ZALO_APP_SECRET, ' +
        'từ chối serve'
      );
    }
    return null;
  }

  /** `/readyz` (C01): cấu hình + DB login webhook `select 1` trong 2 giây; chỉ mã trạng thái. */
  async readiness(configError: string | null): Promise<[boolean, Record<string, string>]> {
    const checks: Record<string, string> = { config: configError === null ? 'ok' : 'loi' };
    if (this.pool === null) {
      checks.db = 'chua_cau_hinh';
    } else {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.pool.query('select 1'),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('timeout')), 2000);
          }),
        ]);
        checks.db = 'ok';
      } catch {
        checks.db = 'loi';
      } finally {
        clearTimeout(timer);
      }
    }
    return [Object.values(checks).every((v) => v === 'ok'), checks];
  }

  dedup(eventId: string): boolean {
    return this.seen.dedup(eventId);
  }

  unanswered(): Entry[] {
    return unanswered(this.convlog.path);
  }

  /** Lock theo user qua striping (D5.5): cùng user → tuần tự; user khác → song song. */
  async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    let h = 0;
    for (const c of userId) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
    const i = h % STRIPES;
    const prev = this.stripes[i] as Promise<void>;
    let release!: () => void;
    this.stripes[i] = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** History của user: get-or-create + đánh dấu mới dùng nhất; đầy → evict user cũ nhất. */
  history(userId: string): ChatMsg[] {
    let h = this.histories.get(userId);
    if (h === undefined) {
      if (this.histories.size >= this.histMaxUsers) {
        const oldest = this.histories.keys().next().value;
        if (oldest !== undefined) this.histories.delete(oldest);
      }
      h = [];
    } else {
      this.histories.delete(userId);
    }
    this.histories.set(userId, h);
    return h;
  }

  private pushHistory(userId: string, q: string, a: string): void {
    const h = this.history(userId);
    h.push({ role: 'user', content: q }, { role: 'assistant', content: a });
    if (h.length > 8) h.splice(0, h.length - 8); // deque(maxlen=8)
  }

  /** Điểm vào webhook: mốc nhận đo TRƯỚC lock → reply_ms tính cả chờ lượt trước cùng user. */
  handleText(
    userId: string,
    question: string,
    msgId = '',
    opts: { channel?: string; send?: SendFn | null } = {},
  ): Promise<ReplyOut> {
    const tRecv = clock.mono();
    return this.withUserLock(userId, () => this.reply(userId, question, msgId, { ...opts, tRecv }));
  }

  /** v14.6: hạn chót TỔNG (nhận + CHAT_BUDGET_S) cho mọi lời gửi của lượt. */
  reply(userId: string, question: string, msgId = '', opts: TurnOpts = {}): Promise<ReplyOut> {
    const tRecv = opts.tRecv ?? clock.mono();
    return withBudget(tRecv + this.rag.CHAT_BUDGET_S, () =>
      this.replyTurn(userId, question, msgId, { ...opts, tRecv }),
    );
  }

  /** v13.7: answer() chờ tối đa tới `deadline`; hết hạn → DeadlineExceeded, kết quả muộn bị bỏ. */
  private async answerWithin(
    question: string,
    history: ChatMsg[],
    deadline: number,
  ): Promise<AnswerResult> {
    const leftS = deadline - clock.mono();
    if (leftS <= 0) throw new DeadlineExceeded('cho_lock');
    const deadlineEpochMs = clock.wall() * 1000 + leftS * 1000;
    const work = Promise.resolve().then(() =>
      this.rag.answer(
        question,
        history.length ? { history, deadline, deadlineEpochMs } : { deadline, deadlineEpochMs },
      ),
    );
    work.catch(() => {}); // kết quả/lỗi về muộn bị bỏ
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new DeadlineExceeded('tra_loi')), leftS * 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async replyTurn(
    userId: string,
    question: string,
    msgId = '',
    opts: TurnOpts = {},
  ): Promise<ReplyOut> {
    const channel = opts.channel ?? 'zalo';
    const send = opts.send ?? this.sendText; // tra lúc gọi — test thay sendText được
    const t0 = clock.mono();
    const tRecv = opts.tRecv ?? t0;
    const ch = this.channels;
    // v13.7: hạn chót trả lời = nhận tin + 30 giây − phần dành cho gửi.
    const deadline = tRecv + this.rag.CHAT_BUDGET_S - this.rag.SEND_RESERVE_S;
    let inb: Inbound | null = null;
    let route: ReturnType<ChatChannels['preRoute']> = null;
    let gate: Gate | null = null;
    let md = 'van_hanh';
    let res: AnswerResult | null = null;
    try {
      inb = ch.normalize(channel, userId, question);
      route = ch.preRoute(inb);
      if (route === null) gate = await ch.consentGate(inb);
      // v13.3: giai đoạn triển khai đọc TRƯỚC answer() — tắt = 0 lời gọi AI.
      if (route === null && !gate?.block) md = await ch.chatbotMode();
      if (route === null && !gate?.block && md !== 'tat') {
        res = await this.answerWithin(question, [...this.history(userId)], deadline);
      }
    } catch (e) {
      // Catch-all có chủ đích (D4.4): mọi crash → log + fallback, không chết câm mất vết câu hỏi.
      const stage = isDeadline(e) ? e.stage : null;
      const late = stage !== null;
      let fallback = late
        ? NO_HANDOFF_TEXT
        : e instanceof GatewayBlocked
          ? HANDOFF_TEXT
          : ERROR_FALLBACK;
      if (late) {
        console.log(
          `[deadline] ${channel}: quá 30 giây (${stage}) -> chuyển người (uh=${uhash(userId)})`,
        );
      }
      let recorded = false;
      if (fallback === HANDOFF_TEXT) {
        // r12 L3: gateway chặn — HANDOFF_TEXT hứa nhân viên → ghi handoff TRƯỚC.
        [fallback, recorded] =
          inb !== null
            ? await this.promiseOrHotline(inb, 'rollout', msgId, fallback)
            : [NO_HANDOFF_TEXT, false];
      }
      const sent = await send(userId, fallback);
      const slate = sendLate(sent);
      await this.convlog.log({
        ts: tsNow(),
        msg_id: msgId,
        user_hash: uhash(userId),
        question: logQuestion(question),
        answer: '',
        sources: [],
        // null — guardrail chưa chạy (False sẽ đếm nhầm crash vào "violation").
        guardrail_ok: null,
        latency_ms: ms(t0),
        reply_ms: ms(tRecv),
        answered: false,
        sent,
        error: late
          ? `deadline:${stage}`
          : slate
            ? `deadline:${slate}`
            : cpSlice(errRepr(e), 0, 300),
        channel,
        ...provenance(send),
      });
      if ((late || slate) && !recorded && inb !== null) {
        await ch.recordHandoff(inb, 'deadline', msgId);
      }
      return { sent, text: fallback, sources: [], ...(late ? { deadline: stage } : {}) };
    }
    const g = gate as Gate;
    const ib = inb as Inbound;
    if (route !== null) {
      return this.replyFixed(userId, question, msgId, ib, route.kind, route.text, send, t0, {
        handoff: route.handoff,
        tRecv,
      });
    }
    if (g.block) {
      // require_consent_for_llm bật + chưa đồng ý: chỉ câu chào, 0 LLM.
      return this.replyFixed(userId, question, msgId, ib, 'consent_required', g.prefix, send, t0, {
        prompted: g.prompted,
        tRecv,
      });
    }
    if (md !== 'van_hanh') {
      return this.replyHeld(
        userId,
        question,
        msgId,
        ib,
        md,
        md === 'tat' ? null : res,
        g,
        send,
        t0,
        tRecv,
      );
    }
    const r = res as AnswerResult;
    const latencyMs = ms(t0);
    const raw = r.answer;
    // Guardrail TRƯỚC khi nối nguồn (slug URL không flag oan) — trong channels.formatReply.
    let [text, meta] = await ch.formatReply(channel, r);
    const guardrailOk = meta.guardrail_ok;
    if (!guardrailOk) {
      console.log(`[warn] zalo: reply bị guardrail chặn -> fallback (uh=${uhash(userId)})`);
    } else {
      if (meta.handoff === 'no_data') {
        console.log(`[handoff] zalo: NO_DATA -> handoff (uh=${uhash(userId)})`);
      }
      // Lượt hợp lệ (kể cả NO_DATA) mới vào history; câu bị flag / rượu / sức khỏe thì không.
      if (meta.handoff !== 'alcohol' && meta.handoff !== 'health') {
        this.pushHistory(userId, question, raw);
      }
    }
    const reason = guardrailOk ? meta.handoff : null;
    if (reason) [text] = await this.promiseOrHotline(ib, reason, msgId, text);
    if (g.prefix) text = `${g.prefix}\n\n${text}`;
    const sent = await send(userId, text);
    const slate = sendLate(sent);
    const entry: Entry = {
      ts: tsNow(),
      msg_id: msgId,
      user_hash: uhash(userId),
      question: logQuestion(question),
      answer: cpSlice(logQuestion(text) as string, 0, 500),
      sources: r.sources ?? [],
      guardrail_ok: guardrailOk,
      latency_ms: latencyMs,
      reply_ms: ms(tRecv),
      // `includes`: rag cũng coi NO_DATA-là-chuỗi-con là không có dữ liệu.
      answered: !raw.includes(this.rag.NO_DATA) && !slate,
      sent, // gửi lỗi khác "đã xử lý" — giữ riêng để đối soát
      channel,
      ...provenance(send), // v15 fix P8.1: chỉ transport thật = "live"
    };
    if (!guardrailOk) entry.flagged_text = cpSlice(logQuestion(raw) as string, 0, 500);
    if (slate) entry.error = `deadline:${slate}`;
    await this.convlog.log(entry);
    // Ghi DB SAU khi đã gửi — DB down chỉ warn, khách không câm.
    const lateReason =
      (!guardrailOk ? meta.handoff : null) || (slate && !reason ? 'deadline' : null);
    if (lateReason) await ch.recordHandoff(ib, lateReason, msgId);
    // `prompted` chỉ khi câu chào ĐÃ tới khách.
    if (g.prompted && sent) await ch.recordConsent(ib, 'prompted', msgId);
    return { sent, text, sources: r.sources ?? [] };
  }

  /** r12 L3: ghi cskh_handoff TRƯỚC khi chọn câu — ghi được → câu hứa; không → câu hotline. */
  private async promiseOrHotline(
    inb: Inbound,
    reason: string,
    msgId: string,
    text: string,
  ): Promise<[string, boolean]> {
    const id = await this.channels.recordHandoff(inb, reason, msgId);
    if (id !== null && id !== undefined) return [text, true];
    return [NO_HANDOFF_TEXTS[reason] ?? NO_HANDOFF_TEXT, false];
  }

  /**
   * v13.3 (HĐ 6.7): chatbot chạy thử/có người duyệt/tắt → câu bot KHÔNG tới khách; khách nhận
   * HOLD_TEXT (rượu/sức khỏe lớp 2 → template); câu bot đạt guardrail → gợi ý cskh_reply ghi SAU
   * khi gửi (v14.6 — DB chậm không ăn ngân sách 30 giây). Không vào history.
   */
  private async replyHeld(
    userId: string,
    question: string,
    msgId: string,
    inb: Inbound,
    md: string,
    res: AnswerResult | null,
    gate: Gate,
    send: SendFn,
    t0: number,
    tRecv: number,
  ): Promise<ReplyOut> {
    let meta: ReplyMeta | null = null;
    let bot: string | null = null;
    let text = HOLD_TEXT;
    if (res !== null) {
      [bot, meta] = await this.channels.formatReply(inb.channel, res);
      if (meta.handoff === 'alcohol' || meta.handoff === 'health') text = bot; // template cố định
    }
    [text] = await this.promiseOrHotline(inb, meta?.handoff || 'rollout', msgId, text);
    if (gate.prefix) text = `${gate.prefix}\n\n${text}`;
    console.log(
      `[rollout] ${inb.channel}: chatbot ${md} — không gửi câu bot (uh=${uhash(userId)})`,
    );
    const sent = await send(userId, text);
    const slate = sendLate(sent);
    let sid: unknown = null;
    if (meta?.guardrail_ok && !meta.handoff && res !== null) {
      sid = await this.channels.recordSuggestion(inb, bot as string, msgId, res.answer);
    }
    await this.convlog.log({
      ts: tsNow(),
      msg_id: msgId,
      user_hash: uhash(userId),
      question: logQuestion(question),
      answer: cpSlice(logQuestion(text) as string, 0, 500), // text ĐÃ GỬI
      sources: [],
      guardrail_ok: meta ? meta.guardrail_ok : null,
      latency_ms: ms(t0),
      reply_ms: ms(tRecv),
      answered: false, // chờ người — vào unanswered()
      sent,
      rollout: md,
      suggestion_id: sid ?? null,
      channel: inb.channel,
      ...provenance(send),
      ...(slate ? { error: `deadline:${slate}` } : {}),
    });
    if (gate.prompted && sent) await this.channels.recordConsent(inb, 'prompted', msgId);
    return { sent, text, sources: [], rollout: md };
  }

  /** v5.1: text cố định của lớp kênh (template rượu/sức khỏe, ack đồng ý, câu chào) — 0 answer(). */
  private async replyFixed(
    userId: string,
    question: string,
    msgId: string,
    inb: Inbound,
    kind0: string,
    text0: string,
    send: SendFn,
    t0: number,
    o: { handoff?: string | null; prompted?: boolean; tRecv?: number },
  ): Promise<ReplyOut> {
    let kind = kind0;
    let text = text0;
    const ch = this.channels;
    console.log(`[route] ${inb.channel}: ${kind} (uh=${uhash(userId)})`);
    if (kind === 'consent_withdrawn') {
      this.histories.delete(userId); // rút đồng ý → bỏ ngữ cảnh hội thoại in-memory
      // GHI TRƯỚC rồi mới chọn câu: không ghi được → KHÔNG gửi câu cam kết "đã ngừng xử lý".
      const rid = await ch.recordConsent(inb, 'withdrawn', msgId);
      if (rid === null || rid === undefined) {
        kind = 'consent_withdrawn_fail';
        text = ch.template('consent_withdrawn_fail');
      }
    }
    if (o.handoff) [text] = await this.promiseOrHotline(inb, o.handoff, msgId, text);
    const sent = await send(userId, text);
    const slate = sendLate(sent);
    await this.convlog.log({
      ts: tsNow(),
      msg_id: msgId,
      user_hash: uhash(userId),
      question: logQuestion(question),
      answer: cpSlice(logQuestion(text) as string, 0, 500),
      sources: [],
      guardrail_ok: null,
      latency_ms: ms(t0),
      reply_ms: ms(o.tRecv ?? t0),
      // rượu/sức khỏe = cần người (queue); đồng ý/câu chào = không áp dụng
      answered: o.handoff || slate ? false : null,
      sent,
      route: kind,
      channel: inb.channel,
      ...provenance(send),
      ...(slate ? { error: `deadline:${slate}` } : {}),
    });
    if (slate && !o.handoff) await ch.recordHandoff(inb, 'deadline', msgId);
    if (kind === 'consent_granted') await ch.recordConsent(inb, 'granted', msgId);
    else if (o.prompted && sent) await ch.recordConsent(inb, 'prompted', msgId);
    return { sent, text, sources: [] };
  }

  /** V1.4: ảnh/file/sticker → NON_TEXT_TEXT (khách không câm); convlog answered:false. */
  private async replyNonText(userId: string, event: string, msgId = ''): Promise<ReplyOut> {
    const t0 = clock.mono();
    const send = this.sendText;
    const sent = await send(userId, NON_TEXT_TEXT);
    await this.convlog.log({
      ts: tsNow(),
      msg_id: msgId,
      user_hash: uhash(userId),
      question: `[non-text:${cpSlice(event, 0, 50)}]`,
      answer: cpSlice(NON_TEXT_TEXT, 0, 500),
      sources: [],
      guardrail_ok: null,
      latency_ms: ms(t0),
      answered: false,
      sent,
      ...provenance(send),
    });
    return { sent, text: NON_TEXT_TEXT, sources: [] };
  }

  handleNonText(userId: string, event: string, msgId = ''): Promise<ReplyOut> {
    return this.withUserLock(userId, () => this.replyNonText(userId, event, msgId));
  }

  /** v12.4: tin nhân viên vườn → intake nhật ký vườn (cùng lock — đúng thứ tự). */
  handleGarden(
    userId: string,
    event: string,
    msg: Record<string, unknown>,
    msgId = '',
  ): Promise<Record<string, unknown>> {
    return this.withUserLock(userId, async () =>
      this.garden.handle(userId, event, msg, msgId, this.sendText),
    );
  }

  handleFollow(userId: string): Promise<ReplyOut> {
    return this.withUserLock(userId, () => this.replyFollow(userId));
  }

  /** V2.5: follow → WELCOME_TEXT; convlog answered:null (không vào queue "Chưa trả lời"). */
  private async replyFollow(userId: string): Promise<ReplyOut> {
    const t0 = clock.mono();
    const send = this.sendText;
    const sent = await send(userId, WELCOME_TEXT);
    await this.convlog.log({
      ts: tsNow(),
      msg_id: '',
      user_hash: uhash(userId),
      question: '[event:follow]',
      answer: cpSlice(WELCOME_TEXT, 0, 500),
      sources: [],
      guardrail_ok: null,
      latency_ms: ms(t0),
      answered: null,
      sent,
      ...provenance(send),
    });
    return { sent, text: WELCOME_TEXT, sources: [] };
  }

  /**
   * Định tuyến event SAU khi đã ACK 200 (Python `do_POST`): follow → welcome (dedup
   * `follow:<uid>` 7 ngày); `user_send_*` của nhân viên vườn → intake vườn; text → chatbot;
   * loại khác → NON_TEXT_TEXT; event khác → bỏ. Xử lý chạy nền, không chặn ACK.
   */
  dispatch(ev: unknown): void {
    let key: string;
    let target: () => Promise<unknown>;
    try {
      if (!isPlainObject(ev)) return;
      const event = str(ev.event_name);
      if (event === 'follow') {
        // uid ở follower.id theo spec; fallback sender.id. Key prefix 'follow:' (V8.2).
        const uid = str(obj(ev.follower).id) || str(obj(ev.sender).id);
        if (!uid) return;
        key = `follow:${uid}`;
        target = () => this.handleFollow(uid);
      } else if (event.startsWith('user_send')) {
        const msg = obj(ev.message);
        const uid = str(obj(ev.sender).id);
        // Python `msg.get("msg_id") or ""` rồi f"{uid}:{mid}" — msg_id kiểu số vẫn trả lời.
        const mid = pyTruthy(msg.msg_id) ? pyStr(msg.msg_id) : '';
        if (uid && this.garden.staffCode(uid)) {
          // v12.4: nhân viên vườn → intake nhật ký vườn, KHÔNG chatbot khách/convlog.
          target = () => this.handleGarden(uid, event, msg, mid);
        } else if (event === 'user_send_text') {
          const text = pyStrip(str(msg.text));
          if (!text || !uid) return;
          target = () => this.handleText(uid, text, mid);
        } else {
          if (!uid) return;
          target = () => this.handleNonText(uid, event, mid);
        }
        const ts = Object.hasOwn(ev, 'timestamp') ? pyStr(ev.timestamp) : '';
        key = `${uid}:${mid || ts}`;
      } else {
        return;
      }
    } catch (e) {
      console.log(`[warn] zalo: bỏ event không hợp lệ (${(e as Error).name})`);
      return;
    }
    // Lỗi hạ tầng (sqlite hỏng / khóa quá 5 giây) ≠ event không hợp lệ — báo [error] cho vận hành.
    let dup: boolean;
    try {
      dup = this.dedup(key);
    } catch (e) {
      console.error(`[error] zalo: dedup lỗi (${(e as Error).name}: ${(e as Error).message})`);
      return;
    }
    if (dup) return;
    target().catch((e) => console.error(`[error] zalo: xử lý tin lỗi (${(e as Error).name})`));
  }
}
