import { Controller, Get, Headers, Inject, Module } from '@nestjs/common';
import { pyRound } from '@samsam/core/ops/py-json';
import { DATA_DIR } from '@samsam/core/paths';
import { scrubUser } from '@samsam/core/security/pii';
import type { Pool } from 'pg';
import { PG_POOL } from '../../db/db.module.js';
import { webIdentity } from '../content/web-auth.js';
import { convlogStats, leadStats } from './lead-store.js';

// REST tab "Leads" (thay app/streamlit_app.py): số liệu kênh chat từ convlog (file — luôn có, kể cả
// khi DB chưa nạp) + bảng `leads` (login svc_ui đọc; DB lỗi/thiếu bảng → `leads: null`, web báo
// "Chưa có dữ liệu leads"). Read-only. TS chặt hơn: câu hỏi che PII lại lúc đọc (`scrubUser`,
// idempotent — câu đã che ở convlog lúc ghi).
// Module riêng (không gộp CrmModule): CrmModule chỉ chứa lệnh CLI, nạp ở CliModule không có PG_POOL.

export const LEADS_TAB = 'Leads';

@Controller('leads')
export class LeadsController {
  /** thư mục chứa convlog (test trỏ thư mục tạm) */
  dataDir = DATA_DIR;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async get(@Headers('authorization') auth: unknown) {
    await webIdentity(auth, LEADS_TAB);
    const conv = convlogStats(this.dataDir);
    const s = await leadStats(this.pool);
    return {
      conv: {
        ...conv,
        // Python `round(100 * answered / total)` (làm tròn về số chẵn) — "—" khi chưa có tin.
        rate: conv.total ? `${pyRound((100 * conv.answered) / conv.total, 0)}%` : '—',
      },
      leads: s && {
        ...s,
        recent: s.recent.map(([ts, channel, intent, question, userHash, status]) => ({
          ts: ts instanceof Date ? ts.toISOString() : String(ts),
          channel,
          intent,
          question: typeof question === 'string' ? scrubUser(question)[0] : '',
          user_hash: userHash,
          status,
        })),
      },
    };
  }
}

/** Gắn vào AppModule (API svc_ui). */
@Module({ controllers: [LeadsController] })
export class CrmWebModule {}
