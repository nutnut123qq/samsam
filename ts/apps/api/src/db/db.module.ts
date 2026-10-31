import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Service, servicePool } from '@samsam/core/db';
import { wireCore } from '@samsam/core/ops/wire';
import type { Pool } from 'pg';

/** Token Pool của login dịch vụ tiến trình này (api: ui, worker: job, cli: theo lệnh). */
export const PG_POOL = Symbol('PG_POOL');
/** Token AI Gateway dùng chung (`AiGateway` trên PG_POOL, che PII + cổng triển khai thật). */
export const AI_GATEWAY = Symbol('AI_GATEWAY');

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({})
export class DbModule {
  /** Chế độ thực: login sai/thiếu biến → servicePool ném lỗi → tiến trình không khởi động (fail-closed). */
  static forRoot(service: Service): DynamicModule {
    return {
      module: DbModule,
      providers: [
        { provide: PG_POOL, useFactory: () => servicePool(service) },
        // Nối core (ops/deps: guardrail, PII, auth, rollout) MỘT lần lúc khởi động tiến trình.
        { provide: AI_GATEWAY, inject: [PG_POOL], useFactory: (pool: Pool) => wireCore(pool) },
        PoolCloser,
      ],
      exports: [PG_POOL, AI_GATEWAY],
    };
  }
}
