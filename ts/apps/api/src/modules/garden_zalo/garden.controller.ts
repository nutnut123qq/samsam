import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Env } from '@samsam/core/env';
import { isPlainObject } from '@samsam/core/ops/py';
import { coerceDate } from '@samsam/core/ops/store';
import { isDbError } from '@samsam/core/ops/tx';
import { approvalEnforced, HumanDenied } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { pyStrip } from '@samsam/core/security/py';
import type { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module.js';
import { PERSON_HEADER } from '../approval/approval.controller.js';
import { PERSON_ENV, PersonSessions } from '../approval/person-sessions.js';
import { webIdentity } from '../content/web-auth.js';
import {
  ACTIVITY_VOCAB,
  activePlots,
  addLogHuman,
  anomalyCheck,
  fmtUtc,
  recentLogs,
} from './garden.js';

// REST tab "Nhật ký vườn" (Python `app/streamlit_app.py` + `agents/garden.py`): ĐỌC khoảnh active /
// bất thường / nhật ký gần nhất bằng login UI dùng chung (svc_ui — chỉ các cột roles.sql r12 cấp);
// GHI nhật ký nhập tay CHỈ bằng phiên login Postgres riêng của người (`plot_log_add_human`: người ghi
// = người của login, khối farming — DB kiểm). Nhật ký do NGƯỜI nhập, không LLM.
// KHÁC Python có chủ đích (chặt hơn): chế độ dev cũng ghi bằng login người (Python dev ghi bằng conn
// UI + ô "Người ghi" tự gõ); chi tiết/hoạt động hiển thị qua `maskPii` (không hiện SĐT/email thô).

export const TAB = 'Nhật ký vườn';
export const OTHER = 'khác…';
// shortcut: trần chi tiết 2000 ký tự (Streamlit không giới hạn) — nới khi vườn cần ghi dài hơn.
const MAX_TEXT = 2000;

@Controller('garden')
export class GardenController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PersonSessions) private readonly sessions: PersonSessions,
    @Inject(PERSON_ENV) private readonly env: Env,
  ) {}

  @Get()
  async view(@Headers('authorization') auth: unknown, @Headers(PERSON_HEADER) handle: unknown) {
    const w = await webIdentity(auth, TAB, this.env);
    let plots: [string, string][];
    let anoms: Awaited<ReturnType<typeof anomalyCheck>>;
    let recent: Awaited<ReturnType<typeof recentLogs>>;
    try {
      plots = await activePlots(this.pool);
      anoms = await anomalyCheck(this.pool);
      recent = await recentLogs(this.pool);
    } catch (e) {
      if (isDbError(e)) throw new ServiceUnavailableException('Lỗi đọc DB — thử tải lại trang.');
      throw e;
    }
    return {
      ident: w.username,
      enforced: approvalEnforced(this.env),
      unlocked: (await this.sessions.get(handle, w.username)) !== null,
      plots: plots.map(([id, loc]) => ({ id, label: loc ? `${id} — ${loc}` : id })),
      activities: [...ACTIVITY_VOCAB, OTHER],
      // Mặc định ngày UTC — ts ghép giờ UTC; tránh ngày local VN+7 tạo ts tương lai giả (re-audit v2.4).
      today: new Date().toISOString().slice(0, 10),
      anomalies: anoms.map((a) => maskPii(a.msg)),
      recent: recent.map((r) => ({
        ts: fmtUtc(r.ts),
        plot: r.plot_id,
        activity: maskPii(r.activity),
        detail: maskPii(r.detail ?? ''),
        author: r.author ?? '',
        source: r.source,
      })),
    };
  }

  /** Ghi 1 nhật ký → {ok, message, warnings} (cảnh báo chuẩn hóa/bất thường như Python). */
  @Post('logs')
  @HttpCode(200)
  async add(
    @Headers('authorization') auth: unknown,
    @Headers(PERSON_HEADER) handle: unknown,
    @Body() raw: unknown,
  ) {
    const w = await webIdentity(auth, TAB, this.env);
    const b = isPlainObject(raw) ? raw : {};
    const str = (k: string): string => {
      const v = b[k] ?? '';
      if (typeof v !== 'string' || v.length > MAX_TEXT) {
        throw new BadRequestException(`${k} phải là chuỗi ≤ ${MAX_TEXT} ký tự`);
      }
      return v;
    };
    const plot = pyStrip(str('plot'));
    const pick = str('activity');
    const free = pick === OTHER ? str('activityFree') : '';
    const day = str('date');
    const detail = pyStrip(str('detail'));
    if (!plot) return { ok: false, message: 'Chưa có khoảnh active nào trong DB.', warnings: [] };
    const d = coerceDate(day);
    if (d === null) return { ok: false, message: 'Chọn ngày cho nhật ký.', warnings: [] };
    const act = pyStrip(free) || pick;
    // Ngày người chọn + giờ UTC hiện tại (Python `datetime.combine(d, now(utc).time(), utc)`).
    const ts = new Date(`${d}T${new Date().toISOString().slice(11)}`);
    const conn = await this.sessions.get(handle, w.username);
    let id: bigint | null = null;
    let warns: string[];
    if (conn === null) {
      warns = ['Chưa mở quyền bằng login Postgres riêng.'];
    } else {
      try {
        [id, warns] = await addLogHuman(conn, plot, ts, act, detail, w.username);
      } catch (e) {
        if (e instanceof HumanDenied) warns = [`Không có quyền ghi nhật ký vườn: ${e.message}`];
        else if (isDbError(e)) warns = ['Lỗi DB khi ghi — thử lại.'];
        else throw e;
      }
    }
    return id !== null
      ? { ok: true, message: `Đã ghi nhật ký #${id}: ${plot} — ${act}`, warnings: warns }
      : { ok: false, message: 'Không ghi được — xem cảnh báo.', warnings: warns };
  }
}
