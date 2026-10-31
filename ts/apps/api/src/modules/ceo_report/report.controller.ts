import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { Env } from '@samsam/core/env';
import { isPlainObject } from '@samsam/core/ops/py';
import { generate, listReports } from '@samsam/core/ops/report';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import type { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module.js';
import { PERSON_ENV } from '../approval/person-sessions.js';
import { webIdentity } from '../content/web-auth.js';
import { collectChat } from './cockpit.js';
import { collect } from './mkt-metrics.js';

// REST tab "Báo cáo" (Python `app/streamlit_app.py` + `agents/report.py`): sinh báo cáo định kỳ
// (bán hàng + leads + kênh chat + nhật ký vườn + marketing) ra `data/reports/report-*.md` và xem
// báo cáo đã sinh. Báo cáo là BẢN NHÁP: duyệt + gửi lãnh đạo do NGƯỜI — hệ thống KHÔNG tự gửi (C2.4).
// DB lỗi → vẫn sinh bản DEGRADED (phần convlog file-based vẫn có). Số do code tổng hợp, không LLM.
// Đọc bằng PG_POOL (svc_ui) như Streamlit dùng kết nối của UI. KHÁC Python có chủ đích: nội dung
// trả web qua `maskPii`; đường dẫn trả về là tương đối `data/reports/<tên>` (không lộ đường máy chủ).

export const TAB = 'Báo cáo';
export const REPORT_DIRS = Symbol('REPORT_DIRS');
export type ReportDirs = { out: string; data: string };
export const DAYS = [7, 14, 30];

@Controller('reports')
export class ReportController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REPORT_DIRS) private readonly dirs: ReportDirs,
    @Inject(PERSON_ENV) private readonly env: Env,
  ) {}

  /** Báo cáo đã sinh, mới nhất trước (chỉ tên tệp). */
  @Get()
  async list(@Headers('authorization') auth: unknown) {
    await webIdentity(auth, TAB, this.env);
    return { files: listReports(this.dirs.out).map((p) => basename(p)) };
  }

  /** Nội dung 1 báo cáo — tên phải nằm trong danh sách thư mục (không đường dẫn tự do). */
  @Get(':name')
  async read(@Headers('authorization') auth: unknown, @Param('name') name: string) {
    await webIdentity(auth, TAB, this.env);
    if (!listReports(this.dirs.out).some((p) => basename(p) === name)) {
      throw new NotFoundException(`không có báo cáo ${name}`);
    }
    return { name, text: maskPii(readFileSync(join(this.dirs.out, name), 'utf8')) };
  }

  @Post('generate')
  @HttpCode(200)
  async gen(@Headers('authorization') auth: unknown, @Body() b: unknown) {
    await webIdentity(auth, TAB, this.env);
    const days = isPlainObject(b) ? b.days : undefined;
    if (typeof days !== 'number' || !DAYS.includes(days)) {
      throw new BadRequestException(`days phải là ${DAYS.join('|')}`);
    }
    let path: string;
    let dbOk: boolean;
    try {
      const [p, rep] = await generate({
        days,
        outDir: this.dirs.out,
        db: this.pool,
        collectors: { chat: (s, e) => collectChat(this.dirs.data, s, e), marketing: collect },
      });
      path = p;
      dbOk = rep.db.db_ok;
    } catch (e) {
      // HĐ 6.7: tính năng TẮT → không ghi báo cáo.
      if (e instanceof RolloutBlocked) throw new ConflictException(e.message);
      throw e;
    }
    const shown = `data/reports/${basename(path)}`;
    return {
      name: basename(path),
      dbOk,
      message: dbOk
        ? `Đã ghi ${shown}`
        : `Đã ghi báo cáo DEGRADED — không kết nối được DB, phần DB đánh dấu [chưa nạp]: ${shown}`,
    };
  }
}
