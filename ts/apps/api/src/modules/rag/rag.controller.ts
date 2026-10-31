import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
} from '@nestjs/common';
import { GatewayBlocked } from '@samsam/core/ai/gateway';
import { cpLen, cpSlice, isPlainObject } from '@samsam/core/ops/py';
import { dataPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { pyStrip } from '@samsam/core/security/py';
import { webIdentity } from '../content/web-auth.js';
import { FALLBACK, HANDOFF_TEXT } from '../zalo/zalo.constants.js';
import { ConvLog, logQuestion, tsNow, unanswered } from '../zalo/zalo.convlog.js';
import { uiHash } from '../zalo/zalo.util.js';
import { type Answer, NO_DATA, RagService } from './rag.service.js';

// REST tab "Chat Sâm Sâm" + "Chưa trả lời" (thay app/streamlit_app.py):
//  - POST /chat: answer() → guardrail.check() TRƯỚC khi hiển thị (vi phạm → FALLBACK, NO_DATA →
//    HANDOFF_TEXT) → ghi convlog như kênh Zalo (provenance "demo" — không bao giờ là đầu ra chatbot
//    thật). History do client giữ (Streamlit giữ trong session) — server chỉ nhận đúng dạng
//    {role user|assistant, content} ≤ 8 lượt (role khác sẽ thành tin system gửi AI) và trả lại
//    history mới theo semantics zalo: chỉ lượt hợp lệ, lưu RAW, bỏ lượt flag/gateway/rượu/sức khỏe.
//  - GET /chat/unanswered: queue câu `answered:false` của convlog, mới nhất trước. TS chặt hơn:
//    câu hỏi che PII lại lúc đọc (`scrubUser`, idempotent) — dòng cũ ghi trước khi có bộ che
//    không lộ PII thô; chỉ trả ts/câu hỏi/user_hash.

export const CHAT_TAB = 'Chat Sâm Sâm';
export const UNANSWERED_TAB = 'Chưa trả lời';
// shortcut: trần câu hỏi 2000 ký tự (= giới hạn text Zalo; Streamlit không giới hạn) — chặn lạm
// dụng chi phí ở biên tin cậy; nới khi cần.
export const MAX_QUESTION = 2000;
const HIST_MAX = 8; // 4 lượt Q&A gần nhất — như deque(maxlen=8)
const MAX_HIST_TEXT = 4000;
const SESSION_RE = /^[0-9a-f]{8}$/;
export const NO_SOURCE_CAPTION =
  "Không có nguồn — chưa đủ dữ liệu, đã chuyển nhân viên (xem tab 'Chưa trả lời').";
const NO_HISTORY = new Set(['gateway', 'alcohol', 'health']);

type Turn = { role: 'user' | 'assistant'; content: string };

function historyOf(v: unknown): Turn[] {
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) ||
    v.length > HIST_MAX ||
    !v.every(
      (m) =>
        isPlainObject(m) &&
        Object.keys(m).length === 2 &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        cpLen(m.content) <= MAX_HIST_TEXT,
    )
  ) {
    throw new BadRequestException(
      `history phải là ≤ ${HIST_MAX} lượt {role user|assistant, content}`,
    );
  }
  return v.map((m) => ({ role: m.role, content: m.content }));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

@Controller('chat')
export class RagController {
  /** convlog chung với connector Zalo/Messenger (test trỏ thư mục tạm) */
  convLogPath = dataPath('conversations.jsonl');
  warn: (m: string) => void = (m) => console.error(m);
  private log: ConvLog | null = null;

  constructor(@Inject(RagService) private readonly rag: RagService) {}

  @Post()
  @HttpCode(200)
  async chat(@Headers('authorization') auth: unknown, @Body() body: unknown) {
    await webIdentity(auth, CHAT_TAB);
    const b = isPlainObject(body) ? body : {};
    const q = b.question;
    if (typeof q !== 'string' || !pyStrip(q) || cpLen(q) > MAX_QUESTION) {
      throw new BadRequestException(`câu hỏi rỗng hoặc dài hơn ${MAX_QUESTION} ký tự`);
    }
    const history = historyOf(b.history);
    // user_hash kênh UI theo phiên chat (Python `_ui_hash`: uuid4().hex[:8] mỗi session).
    const session =
      typeof b.session === 'string' && SESSION_RE.test(b.session)
        ? b.session
        : randomBytes(4).toString('hex');

    const t0 = performance.now();
    let r: Answer;
    try {
      r = await this.rag.answer(q, history.length ? history : null);
    } catch (e) {
      // Gateway chặn có chủ đích → chuyển nhân viên, không gọi AI; lỗi DB/provider KHÔNG hiện
      // traceback/DSN cho người dùng — câu vào hàng 'Chưa trả lời'. Log chỉ tên loại lỗi.
      const blocked = e instanceof GatewayBlocked;
      this.warn(
        blocked
          ? `[warn] chat web: gateway blocked (${(e as Error).name}) -> handoff`
          : `[warn] chat web: loi tra cuu (${(e as Error)?.name ?? typeof e}) -> handoff`,
      );
      r = { answer: NO_DATA, sources: [], handoff: blocked ? 'gateway' : 'loi_he_thong' };
    }
    const latencyMs = Math.floor(performance.now() - t0);

    // Invariant: mọi text AI trước khi hiển thị phải qua guardrail.check() — như reply Zalo.
    const g = check(r.answer);
    const noData = r.answer.includes(NO_DATA);
    const display = !g.ok ? FALLBACK : noData ? HANDOFF_TEXT : r.answer;
    let caption: string | null = null;
    if (g.ok) {
      if (noData) caption = NO_SOURCE_CAPTION;
      else if (r.sources.length) caption = 'Nguồn:';
    }
    const next =
      g.ok && !NO_HISTORY.has(r.handoff ?? '')
        ? [
            ...history,
            { role: 'user', content: q },
            { role: 'assistant', content: r.answer },
          ].slice(-HIST_MAX)
        : history;

    try {
      this.log ??= new ConvLog(this.convLogPath, () => null);
      await this.log.log({
        ts: tsNow(),
        msg_id: '',
        user_hash: uiHash({ convlog_uid: session }),
        question: logQuestion(q),
        answer: cpSlice(str(logQuestion(display)), 0, 500),
        sources: r.sources,
        guardrail_ok: g.ok,
        latency_ms: latencyMs,
        answered: !noData,
        // null chứ không phải false — kênh UI không có send API (sent:false = gửi lỗi).
        sent: null,
        // demo nội bộ — không bao giờ là đầu ra chatbot thật (bộ đếm chỉ tính "live").
        provenance: 'demo',
        is_sample: true,
        ...(g.ok ? {} : { flagged_text: cpSlice(str(logQuestion(r.answer)), 0, 500) }),
      });
    } catch (e) {
      this.warn(`[warn] convlog web: ${(e as Error)?.name ?? typeof e}`); // log không chặn hiển thị
    }

    return {
      display,
      caption,
      // Nguồn chỉ kèm lượt hợp lệ có dữ liệu (lượt flag hiện FALLBACK trần).
      sources: g.ok && !noData ? r.sources : [],
      history: next,
      session,
    };
  }

  @Get('unanswered')
  async unanswered(@Headers('authorization') auth: unknown) {
    await webIdentity(auth, UNANSWERED_TAB);
    const rows = unanswered(this.convLogPath)
      .reverse()
      .map((e) => ({
        ts: str(e.ts),
        question: str(logQuestion(e.question)),
        user_hash: str(e.user_hash),
      }));
    return { rows };
  }
}
