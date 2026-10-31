import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { loadsBytes } from '../zalo/zalo.util.js';
import { CHALLENGE_RE, envStr, MessengerService } from './messenger.service.js';

// Webhook Messenger (Python `Handler`): POST từ chối sớm khi CHƯA đọc body (chunked / thiếu
// Content-Length → 411, > MAX_BODY → 413) rồi đóng kết nối (body sót không đầu độc request kế dưới
// keep-alive); Content-Length hỏng/âm do parser HTTP của Node trả 400 + đóng trước khi tới đây.
// Chữ ký tính trên RAW body → tự đọc stream khi body chưa bị parser đụng, hoặc `req.rawBody`
// (NestFactory.create(..., { rawBody: true })). ACK 200 TRƯỚC, xử lý chạy nền. Không log path/query
// (chứa verify_token).

type Request = IncomingMessage & { rawBody?: unknown; _body?: unknown; originalUrl?: string };
type Response = ServerResponse;

function reply(res: Response, code: number, body: string, ctype: string, close = false): void {
  if (close) res.setHeader('Connection', 'close');
  res.statusCode = code;
  res.setHeader('Content-Type', ctype);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

const json = (res: Response, code: number, obj: unknown, close = false) =>
  reply(res, code, JSON.stringify(obj), 'application/json', close);

function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** GET không đọc body — framing báo có body (chunked / Content-Length ≠ 0) → đóng kết nối. */
function closeIfBody(req: Request, res: Response): void {
  const te = String(req.headers['transfer-encoding'] ?? '').toLowerCase();
  const cl = req.headers['content-length'];
  if (te.includes('chunked') || (cl !== undefined && Number(cl) !== 0)) {
    res.setHeader('Connection', 'close');
  }
}

/** Python `parse_qs(...)[k][0]`: giá trị rỗng bị bỏ (keep_blank_values=False), lấy giá trị đầu. */
function qparam(q: URLSearchParams, k: string): string {
  return q.getAll(k).find((v) => v !== '') ?? '';
}

async function ready(svc: MessengerService, req: Request, res: Response): Promise<void> {
  closeIfBody(req, res);
  const [ok, checks] = await svc.zalo.readiness(svc.startupError());
  json(res, ok ? 200 : 503, { ready: ok, checks });
}

@Controller()
export class MessengerController {
  constructor(@Inject(MessengerService) private readonly svc: MessengerService) {}

  /** GET verify của Meta: chỉ `hub.mode=subscribe` + verify_token khớp → trả challenge (chữ số). */
  @Get('messenger-webhook')
  verify(@Req() req: Request, @Res() res: Response): void {
    closeIfBody(req, res);
    const q = new URL(req.originalUrl ?? req.url ?? '/', 'http://x').searchParams;
    const mode = qparam(q, 'hub.mode');
    const token = Buffer.from(qparam(q, 'hub.verify_token'), 'utf8');
    const challenge = qparam(q, 'hub.challenge');
    const expect = Buffer.from(envStr(this.svc.env, 'MESSENGER_VERIFY_TOKEN'), 'utf8');
    const match = token.length === expect.length && timingSafeEqual(token, expect);
    if (!(expect.length && mode === 'subscribe' && match)) json(res, 403, { error: 'forbidden' });
    else if (!CHALLENGE_RE.test(challenge)) json(res, 400, { error: 'bad challenge' });
    else reply(res, 200, challenge, 'text/plain');
  }

  @Post('messenger-webhook')
  async webhook(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (
      String(req.headers['transfer-encoding'] ?? '')
        .toLowerCase()
        .includes('chunked')
    ) {
      return json(res, 411, { error: 'length required' }, true);
    }
    const cl = req.headers['content-length'];
    if (cl === undefined) return json(res, 411, { error: 'bad content-length' }, true);
    const length = Number(cl);
    if (!Number.isSafeInteger(length) || length < 0) {
      return json(res, 400, { error: 'bad content-length' }, true);
    }
    if (length > this.svc.maxBody) return json(res, 413, { error: 'payload too large' }, true);
    // DEPLOY bật mà thiếu secret/token/muối → không xử lý (Python: tiến trình không chạy).
    if (this.svc.configError) return json(res, 503, { error: 'not configured' }, true);
    let raw: Buffer;
    if (Buffer.isBuffer(req.rawBody)) {
      raw = req.rawBody;
    } else if (req._body || req.readableEnded) {
      // Parser JSON của Nest đã đọc body mà không giữ raw → không verify được chữ ký (fail-closed).
      console.error(
        '[error] messenger: thiếu raw body — tạo app với { rawBody: true } hoặc bodyParser: false',
      );
      return json(res, 500, { error: 'raw body unavailable' });
    } else {
      raw = await readBody(req);
    }
    const sig = req.headers['x-hub-signature-256'];
    if (!this.svc.verifySignature(raw, typeof sig === 'string' ? sig : null)) {
      return json(res, 403, { error: 'bad signature' });
    }
    let ev: unknown;
    try {
      ev = loadsBytes(raw);
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    json(res, 200, { ok: true }); // ACK nhanh — trả lời async
    this.svc.dispatch(ev);
  }

  /** `/readyz` của webhook khi chạy chung tiến trình API (`/readyz` gốc là của login ui). */
  @Get('messenger-webhook/readyz')
  readyz(@Req() req: Request, @Res() res: Response): Promise<void> {
    return ready(this.svc, req, res);
  }
}

/** `/healthz` + `/readyz` cho tiến trình webhook riêng (`messenger-webhook`, job webhook_health dò). */
@Controller()
export class MessengerHealthController {
  constructor(@Inject(MessengerService) private readonly svc: MessengerService) {}

  @Get('healthz')
  healthz(@Req() req: Request, @Res() res: Response): void {
    closeIfBody(req, res);
    json(res, 200, { status: 'up' });
  }

  @Get('readyz')
  readyz(@Req() req: Request, @Res() res: Response): Promise<void> {
    return ready(this.svc, req, res);
  }
}
