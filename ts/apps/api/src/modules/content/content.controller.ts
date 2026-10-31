import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GatewayError } from '@samsam/core/ai/gateway';
import { cpLen, isPlainObject } from '@samsam/core/ops/py';
import { guardrailLines } from '@samsam/core/ops/store';
import { pyStrip } from '@samsam/core/security/py';
import {
  ContentService,
  NEED_PERSON,
  openDraft,
  present,
  studioOptions,
} from './content.service.js';
import { me } from './web-auth.js';

// REST Content Studio (thay tab Streamlit): GET /content/options, POST /content/draft,
// POST /content/listing (đã qua guardrail đăng bài, KHÔNG ghi DB — kèm dòng guardrail + token lưu),
// POST /content/check (luật đăng bài, không LLM), POST /content/save (lưu nháp đã ký vào hàng duyệt).
// GET /me: danh tính + tab theo vai trò cho thanh điều hướng của web (mọi vai trò).
// Lựa chọn kênh = đúng lựa chọn của Studio (kênh lạ → 400).

const DRAFT_CHANNELS = ['facebook', 'tiktok', 'zalo', 'blog'];
const LISTING_CHANNELS = ['shopee', 'tiktok', 'web'];
// shortcut: trần brief 4000 ký tự (Streamlit không giới hạn) — chặn lạm dụng chi phí ở biên tin cậy;
// nới khi GĐ Marketing cần brief dài hơn.
const MAX_BRIEF = 4000;
// shortcut: trần text "Check guardrail" 20000 ký tự (Streamlit không giới hạn) — luật regex chạy trên
// toàn văn; nới khi cần kiểm bài dài hơn.
const MAX_CHECK = 20000;

function channelsOf(v: unknown, allowed: string[]): string[] {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > allowed.length ||
    !v.every((c) => typeof c === 'string' && allowed.includes(c))
  ) {
    throw new BadRequestException(`channels phải là danh sách ⊆ ${allowed.join('|')}`);
  }
  return v as string[];
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Gateway bị chặn (kill-switch/trần/cổng tắt) hoặc nhà cung cấp lỗi → 503, không có bài.
    if (e instanceof GatewayError) throw new ServiceUnavailableException(e.message);
    throw e;
  }
}

@Controller()
export class WebController {
  @Get('me')
  async me(@Headers('authorization') auth: unknown) {
    return me(auth);
  }
}

@Controller('content')
export class ContentController {
  constructor(@Inject(ContentService) private readonly svc: ContentService) {}

  @Get('options')
  async options(@Headers('authorization') auth: unknown) {
    await this.svc.identity(auth);
    return studioOptions();
  }

  @Post('draft')
  @HttpCode(200)
  async draft(@Headers('authorization') auth: unknown, @Body() body: unknown) {
    const who = await this.svc.identity(auth);
    const b = isPlainObject(body) ? body : {};
    const brief = b.brief;
    if (typeof brief !== 'string' || !pyStrip(brief) || cpLen(brief) > MAX_BRIEF) {
      throw new BadRequestException(`brief rỗng hoặc dài hơn ${MAX_BRIEF} ký tự`);
    }
    const channels = channelsOf(b.channels, DRAFT_CHANNELS);
    const sku = b.sku ?? null;
    const contentType = b.contentType ?? 'post';
    if ((sku !== null && typeof sku !== 'string') || typeof contentType !== 'string') {
      throw new BadRequestException('sku/contentType phải là chuỗi');
    }
    const res = await guard(() => this.svc.drafts(brief, channels, sku, contentType));
    return { results: present(res, brief, who.sub, guardrailLines) };
  }

  @Post('listing')
  @HttpCode(200)
  async listing(@Headers('authorization') auth: unknown, @Body() body: unknown) {
    const who = await this.svc.identity(auth);
    const b = isPlainObject(body) ? body : {};
    if (typeof b.sku !== 'string' || !b.sku) throw new BadRequestException('cần sku');
    const channels = channelsOf(b.channels, LISTING_CHANNELS);
    const sku = b.sku;
    const res = await guard(() => this.svc.listings(sku, channels));
    // Streamlit: brief của nháp listing = "listing <sku>".
    return { results: present(res, `listing ${sku}`, who.sub, guardrailLines) };
  }

  @Post('check')
  @HttpCode(200)
  async check(@Headers('authorization') auth: unknown, @Body() body: unknown) {
    await this.svc.identity(auth);
    const b = isPlainObject(body) ? body : {};
    const { text, channel, contentType, isAi } = b;
    if (typeof text !== 'string' || !pyStrip(text) || cpLen(text) > MAX_CHECK) {
      throw new BadRequestException(`text rỗng hoặc dài hơn ${MAX_CHECK} ký tự`);
    }
    if (typeof channel !== 'string' || !DRAFT_CHANNELS.includes(channel)) {
      throw new BadRequestException(`channel phải ∈ ${DRAFT_CHANNELS.join('|')}`);
    }
    if (typeof contentType !== 'string' || typeof isAi !== 'boolean') {
      throw new BadRequestException('contentType phải là chuỗi, isAi là boolean');
    }
    const g = await this.svc.check(text, channel, contentType, isAi);
    return { guardrail: g, lines: guardrailLines(g) };
  }

  @Post('save')
  @HttpCode(200)
  async save(@Headers('authorization') auth: unknown, @Body() body: unknown) {
    const who = await this.svc.identity(auth);
    const tokens = isPlainObject(body) ? body.tokens : undefined;
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > DRAFT_CHANNELS.length) {
      throw new BadRequestException('tokens phải là danh sách nháp đã sinh');
    }
    // Kiểm hết TRƯỚC khi ghi: một token sai → không lưu bản nào.
    const drafts = tokens.map((t) => openDraft(t, who.sub));
    if (drafts.some((d) => d === null)) {
      throw new BadRequestException('nháp không khớp bản đã sinh (hết hạn/sửa) — sinh lại bài');
    }
    // Streamlit giữ nháp theo kênh (1 nháp/kênh) — gửi trùng kênh = nhân đôi nháp.
    if (new Set(drafts.map((d) => d?.channel)).size !== drafts.length) {
      throw new BadRequestException('mỗi kênh chỉ lưu một nháp');
    }
    const r = await this.svc.save(who, drafts as NonNullable<(typeof drafts)[number]>[]);
    if (r === null) throw new ConflictException(NEED_PERSON);
    return r;
  }
}
