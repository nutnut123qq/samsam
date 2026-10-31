import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Env } from '@samsam/core/env';
import { decide, pending, type QueueItem } from '@samsam/core/ops/approval-queue';
import { isPlainObject } from '@samsam/core/ops/py';
import {
  calendar,
  type Draft,
  getDraft,
  listDrafts,
  oneline,
  schedule,
  setStatus,
  vnToday,
} from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import {
  approvalEnforced,
  canSchedule,
  DEV_WARNING,
  decidableBlocks,
} from '@samsam/core/security/auth';
import { pyStrip } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module.js';
import { webIdentity } from '../content/web-auth.js';
import { draftGate, draftView, queueGate, queueView } from './approval.js';
import { noDbLogin, PERSON_ENV, PersonOpenError, PersonSessions } from './person-sessions.js';

// REST tab "Duyệt & Lịch" (Python `app/streamlit_app.py`): hàng duyệt content (draft pending), lịch
// đăng 14 ngày, hàng duyệt chung 9 khối (khối mà người được quyết — `decidableBlocks`). ĐỌC bằng
// login UI dùng chung (PG_POOL = svc_ui); QUYẾT ĐỊNH chỉ bằng phiên login Postgres RIÊNG của người
// (`PersonSessions`, header `x-person-session`) — không bao giờ bằng svc_ui. Hệ thống KHÔNG tự đăng
// (lịch là kế hoạch cho người đăng tay — C2.4).

export const TAB = 'Duyệt & Lịch';
export const PERSON_HEADER = 'x-person-session';
const NOT_UNLOCKED = 'Chưa mở quyền quyết định bằng login Postgres của bạn (form phía trên).';
const DB_READ = 'Lỗi đọc DB — thử tải lại trang.';
// shortcut: trần ghi chú 2000 ký tự (Streamlit không giới hạn) — chặn lạm dụng ở biên tin cậy.
const MAX_NOTE = 2000;

type Outcome = { ok: boolean; message: string };

const body = (b: unknown): Record<string, unknown> => (isPlainObject(b) ? b : {});

function idOf(v: string): string {
  if (!/^[0-9]{1,18}$/.test(v)) throw new BadRequestException(`id '${v}' không hợp lệ`);
  return v;
}

function decisionOf(b: Record<string, unknown>): ['approved' | 'rejected', string | null] {
  const d = b.decision;
  if (d !== 'approved' && d !== 'rejected') {
    throw new BadRequestException('decision phải là approved|rejected');
  }
  const note = b.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) {
    throw new BadRequestException(`note phải là chuỗi ≤ ${MAX_NOTE} ký tự`);
  }
  return [d, note || null];
}

async function read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isDbError(e)) throw new ServiceUnavailableException(DB_READ);
    throw e;
  }
}

const QUEUE_ONE_SQL =
  'select id, object_type, object_id, block, title, payload as preview, risk, qa_status,' +
  " coalesce(guardrail->>'ok', '') = 'true' as guardrail_ok, created_by, created_at, due_at, status" +
  " from approval_queue where id = $1 and status = 'pending'";

@Controller('approval')
export class ApprovalController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PersonSessions) private readonly sessions: PersonSessions,
    @Inject(PERSON_ENV) private readonly env: Env,
  ) {}

  private async who(auth: unknown) {
    const w = await webIdentity(auth, TAB, this.env);
    return { ...w, role: w.role ?? '' }; // đã qua cổng tab → role khác null
  }

  @Get()
  async view(@Headers('authorization') auth: unknown, @Headers(PERSON_HEADER) handle: unknown) {
    const w = await this.who(auth);
    const me = { ident: w.username, role: w.role };
    const enforced = approvalEnforced(this.env);
    const [drafts, cal] = await read(() =>
      Promise.all([listDrafts(this.pool, 'pending'), calendar(this.pool, 14)]),
    );
    const sched = canSchedule(w.role);
    let calInfo: string | null = null;
    if (cal.unscheduled.length && !sched) {
      calInfo = `Vai trò \`${w.role}\` không có quyền xếp lịch — ${cal.unscheduled.length} bài đã duyệt đang chờ.`;
    } else if (!cal.unscheduled.length) {
      calInfo = 'Không có bài approved nào đang chờ xếp lịch.';
    }
    // v13.5 (F08): hàng duyệt chung — chỉ khối mà vai trò là người duyệt (chế độ thực: có tên trong
    // approvers của khối).
    const blocks = decidableBlocks(w.username, w.role, this.env);
    let items: QueueItem[] = [];
    let queueInfo: string | null = null;
    if (!blocks.length) {
      queueInfo =
        `\`${w.username}\` (vai trò \`${w.role}\`) chưa được ủy quyền duyệt khối nào — Bên B ủy ` +
        'quyền bằng văn bản rồi quản trị điền `approvers` trong data/directors/<khối>.json (không tự điền).';
    } else {
      try {
        for (const b of blocks) items.push(...(await pending(this.pool, b, { full: true })));
      } catch (e) {
        if (!isDbError(e)) throw e;
        items = [];
        queueInfo = 'Lỗi đọc hàng duyệt chung — thử tải lại trang.';
      }
      if (!items.length && queueInfo === null)
        queueInfo = `Không có mục chờ ở khối: ${blocks.join(', ')}`;
    }
    return {
      ident: w.username,
      role: w.role,
      enforced,
      devWarning: enforced ? null : DEV_WARNING,
      person: await this.personState(handle, w.username),
      drafts: drafts.map((d) => draftView(d, me, this.env)),
      calendar: {
        canSchedule: sched,
        info: calInfo,
        today: vnToday(),
        unscheduled: sched
          ? cal.unscheduled.map((d) => ({
              id: d.id,
              label: `#${d.id} [${d.channel}] ${oneline(d.brief)}`,
            }))
          : [],
        scheduled: cal.scheduled.map((d) => ({
          date: String(d.scheduled_date),
          channel: d.channel,
          draft: `#${d.id}`,
          brief: d.brief,
          reviewer: d.reviewer || '',
        })),
      },
      queue: { blocks, info: queueInfo, items: items.map((q) => queueView(q, me, this.env)) },
    };
  }

  private async personState(handle: unknown, ident: string) {
    const dbLogin = this.sessions.dbLogin(ident);
    return {
      unlocked: (await this.sessions.get(handle, ident)) !== null,
      dbLogin,
      problem: dbLogin ? null : noDbLogin(ident),
    };
  }

  @Get('person')
  async personStatus(
    @Headers('authorization') auth: unknown,
    @Headers(PERSON_HEADER) handle: unknown,
  ) {
    const w = await this.who(auth);
    return this.personState(handle, w.username);
  }

  /** "Mở quyền quyết định": mật khẩu Postgres CỦA NGƯỜI → mã phiên (không lưu mật khẩu). */
  @Post('person')
  @HttpCode(200)
  async unlock(@Headers('authorization') auth: unknown, @Body() b: unknown) {
    const w = await this.who(auth);
    try {
      const s = await this.sessions.open(w.username, body(b).password);
      return { handle: s.handle, person: s.person };
    } catch (e) {
      if (e instanceof PersonOpenError) throw new ForbiddenException(e.message);
      throw e;
    }
  }

  /** "Khóa quyền": đóng phiên người (POST — client web chỉ gọi GET/POST). */
  @Post('person/close')
  @HttpCode(200)
  async lock(@Headers('authorization') auth: unknown, @Headers(PERSON_HEADER) handle: unknown) {
    const w = await this.who(auth);
    await this.sessions.close(handle, w.username);
    return { closed: true };
  }

  @Post('drafts/:id/decide')
  @HttpCode(200)
  async decideDraft(
    @Headers('authorization') auth: unknown,
    @Headers(PERSON_HEADER) handle: unknown,
    @Param('id') rawId: string,
    @Body() b: unknown,
  ): Promise<Outcome> {
    const w = await this.who(auth);
    const id = idOf(rawId);
    const [decision, note] = decisionOf(body(b));
    const d: Draft | null = await read(() => getDraft(this.pool, BigInt(id)));
    if (d === null) throw new NotFoundException(`không tìm thấy draft #${id}`);
    const g = draftGate(d, { ident: w.username, role: w.role }, this.env)[
      decision === 'approved' ? 'approve' : 'reject'
    ];
    if (!g.ok) throw new ForbiddenException(g.why);
    const conn = await this.sessions.get(handle, w.username);
    if (conn === null) return { ok: false, message: NOT_UNLOCKED };
    const [ok, warn] = await setStatus(conn, id, decision, w.username, note, {
      via: 'ui',
      role: w.role,
      env: this.env,
    });
    return ok ? { ok, message: `Draft #${id} → ${decision}` } : { ok, message: warn ?? '' };
  }

  @Post('drafts/:id/schedule')
  @HttpCode(200)
  async scheduleDraft(
    @Headers('authorization') auth: unknown,
    @Headers(PERSON_HEADER) handle: unknown,
    @Param('id') rawId: string,
    @Body() b: unknown,
  ): Promise<Outcome> {
    const w = await this.who(auth);
    const id = idOf(rawId);
    const day = body(b).date;
    if (typeof day !== 'string' || !pyStrip(day)) throw new BadRequestException('Chọn ngày đăng.');
    if (!canSchedule(w.role)) {
      throw new ForbiddenException(`Vai trò \`${w.role}\` không có quyền xếp lịch`);
    }
    const conn = await this.sessions.get(handle, w.username);
    if (conn === null) return { ok: false, message: NOT_UNLOCKED };
    const [ok, warn] = await schedule(conn, id, day, w.username, null, {
      via: 'ui',
      role: w.role,
      env: this.env,
    });
    return ok
      ? { ok, message: `Draft #${id} xếp lịch ${pyStrip(day)} — người đăng tay.` }
      : { ok, message: warn ?? '' };
  }

  @Post('queue/:id/decide')
  @HttpCode(200)
  async decideQueue(
    @Headers('authorization') auth: unknown,
    @Headers(PERSON_HEADER) handle: unknown,
    @Param('id') rawId: string,
    @Body() b: unknown,
  ): Promise<Outcome> {
    const w = await this.who(auth);
    const id = idOf(rawId);
    const [decision, note] = decisionOf(body(b));
    const { rows } = await read(() => this.pool.query<QueueItem>(QUEUE_ONE_SQL, [id]));
    const q = rows[0];
    if (!q) throw new NotFoundException(`không tìm thấy mục #${id} đang chờ duyệt`);
    if (!decidableBlocks(w.username, w.role, this.env).includes(q.block)) {
      throw new ForbiddenException(
        `\`${w.username}\` (vai trò \`${w.role}\`) chưa được ủy quyền duyệt khối ${q.block}`,
      );
    }
    const g = queueGate(q, { ident: w.username, role: w.role }, this.env)[
      decision === 'approved' ? 'approve' : 'reject'
    ];
    if (!g.ok) throw new ForbiddenException(g.why);
    const conn = await this.sessions.get(handle, w.username);
    if (conn === null) return { ok: false, message: NOT_UNLOCKED };
    const [ok, warn] = await decide(conn, id, w.username, decision, note, {
      via: 'ui',
      role: w.role,
      env: this.env,
    });
    return ok ? { ok, message: `Mục #${id} → ${decision}` } : { ok, message: warn ?? '' };
  }
}
