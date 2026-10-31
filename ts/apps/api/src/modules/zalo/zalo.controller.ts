import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { MAX_BODY } from './zalo.constants.js';
import { ZaloService } from './zalo.service.js';
import { loadsBytes } from './zalo.util.js';

// Webhook Zalo OA (Python `Handler.do_POST`): từ chối sớm khi CHƯA đọc body (chunked → 411,
// Content-Length > 1MB → 413) thì đóng kết nối (body sót không đầu độc request kế dưới keep-alive);
// Content-Length hỏng/âm do parser HTTP của Node trả 400 + đóng trước khi tới đây. Chữ ký
// `X-ZEvent-Signature` tính trên RAW body → cần raw: tự đọc stream khi body chưa bị parser đụng,
// hoặc `req.rawBody` (NestFactory.create(..., { rawBody: true })). ACK 200 TRƯỚC, xử lý chạy nền.

// Kiểu node:http (Express kế thừa) — repo không có @types/express.
type Request = IncomingMessage;
type Response = ServerResponse;
type Raw = Request & { rawBody?: unknown; _body?: unknown };

function reply(res: Response, code: number, obj: unknown, close = false): void {
  const body = JSON.stringify(obj);
  if (close) res.setHeader('Connection', 'close');
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** V8.1: GET không đọc body — framing báo có body (chunked / CL ≠ 0) → đóng kết nối. */
function closeIfBody(req: Request, res: Response): void {
  const te = String(req.headers['transfer-encoding'] ?? '').toLowerCase();
  const cl = req.headers['content-length'];
  if (te.includes('chunked') || (cl !== undefined && Number(cl) !== 0)) {
    res.setHeader('Connection', 'close');
  }
}

async function ready(zalo: ZaloService, req: Request, res: Response): Promise<void> {
  closeIfBody(req, res);
  const [ok, checks] = await zalo.readiness(zalo.configProblem());
  reply(res, ok ? 200 : 503, { ready: ok, checks });
}

@Controller()
export class ZaloController {
  constructor(@Inject(ZaloService) private readonly zalo: ZaloService) {}

  @Post('zalo-webhook')
  async webhook(@Req() req: Raw, @Res() res: Response): Promise<void> {
    if (
      String(req.headers['transfer-encoding'] ?? '')
        .toLowerCase()
        .includes('chunked')
    ) {
      return reply(res, 411, { error: 'length required' }, true);
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0) {
      return reply(res, 400, { error: 'bad content-length' }, true);
    }
    if (length > MAX_BODY) return reply(res, 413, { error: 'payload too large' }, true);
    // D5.1: DEPLOY bật mà thiếu secret/đường gửi/lớp kênh-RAG → không xử lý (Python: tiến trình
    // không chạy). Cùng luật, đọc live như /readyz — không có lúc readyz ok mà POST từ chối.
    if (this.zalo.configProblem()) return reply(res, 503, { error: 'not configured' }, true);
    let raw: Buffer;
    if (Buffer.isBuffer(req.rawBody)) {
      raw = req.rawBody;
    } else if (req._body || req.readableEnded) {
      // Parser JSON của Nest đã đọc body mà không giữ raw → không verify được chữ ký (fail-closed).
      console.error(
        '[error] zalo: thiếu raw body — tạo app với { rawBody: true } hoặc bodyParser: false',
      );
      return reply(res, 500, { error: 'raw body unavailable' });
    } else {
      raw = await readBody(req);
    }
    if (!this.zalo.verifySignature(raw, String(req.headers['x-zevent-signature'] ?? ''))) {
      return reply(res, 403, { error: 'bad signature' });
    }
    let ev: unknown;
    try {
      ev = loadsBytes(raw);
    } catch {
      return reply(res, 400, { error: 'bad json' });
    }
    reply(res, 200, { ok: true }); // ACK nhanh — trả lời async bên dưới
    this.zalo.dispatch(ev);
  }

  /** `/readyz` của webhook khi chạy chung tiến trình API (`/readyz` gốc là của login ui). */
  @Get('zalo-webhook/readyz')
  readyz(@Req() req: Request, @Res() res: Response): Promise<void> {
    return ready(this.zalo, req, res);
  }
}

/** `/healthz` + `/readyz` cho tiến trình webhook riêng (`zalo-webhook`, job webhook_health dò). */
@Controller()
export class ZaloHealthController {
  constructor(@Inject(ZaloService) private readonly zalo: ZaloService) {}

  @Get('healthz')
  healthz(@Req() req: Request, @Res() res: Response): void {
    closeIfBody(req, res);
    reply(res, 200, { status: 'up' });
  }

  @Get('readyz')
  readyz(@Req() req: Request, @Res() res: Response): Promise<void> {
    return ready(this.zalo, req, res);
  }
}
