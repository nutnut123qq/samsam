import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module.js';

const READY_DB_TIMEOUT_MS = 2_000;

// Như connectors/zalo.py: /healthz = tiến trình sống; /readyz = DB của login dịch vụ trả `select 1`
// trong 2 giây. Không lộ DSN/secret/lỗi chi tiết — chỉ mã trạng thái (scripts/webhook_probe.py đọc `ready`).
@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('healthz')
  healthz() {
    return { status: 'up' };
  }

  @Get('readyz')
  async readyz() {
    let db = 'ok';
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.pool.query('select 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), READY_DB_TIMEOUT_MS);
        }),
      ]);
    } catch {
      db = 'loi';
    } finally {
      clearTimeout(timer);
    }
    const body = { ready: db === 'ok', checks: { db } };
    if (!body.ready) throw new ServiceUnavailableException(body);
    return body;
  }
}
