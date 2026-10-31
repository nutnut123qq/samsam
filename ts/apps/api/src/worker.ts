import 'reflect-metadata';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServiceBindError } from '@samsam/core/db';
import { EXIT_SERVICE, type JobSpec, runScheduled, SCHEDULE_TZ } from '@samsam/core/ops/job-runs';
import type { Job, Queue } from 'bullmq';
import { DbModule } from './db/db.module.js';
import { jobStepRunner, loadWorkerJobs, selectJobs, syncSchedulers } from './jobs.js';

// Worker BullMQ thay systemd timer (deploy/onprem/jobs.json): mỗi job = 1 job scheduler giờ VN; lượt
// chạy = core `runScheduled` (khóa advisory chống chạy chồng → exit 75, 1 dòng `job_runs`
// `job:<tên>`, login dịch vụ theo job) với bước = lệnh CLI TS (jobs.ts). Login DB dịch vụ `job`
// (svc_job) như pipelines.job_runs; lịch/biến sai → exit 78 như Python.
// KHÔNG bật cùng một job ở cả systemd lẫn BullMQ (khóa advisory không loại trừ khóa tệp Python) —
// chuyển dần bằng WORKER_JOBS.
const JOB_QUEUE = 'samsam-jobs';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('[err] thiếu REDIS_URL');
  process.exit(EXIT_SERVICE);
}

let jobs: Record<string, JobSpec>;
try {
  jobs = selectJobs(loadWorkerJobs(), process.env.WORKER_JOBS);
} catch (e) {
  console.error(`[err] lịch job: ${(e as Error).message}`);
  process.exit(EXIT_SERVICE);
}
const runner = jobStepRunner();

@Injectable()
class JobScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(JOB_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    const names = await syncSchedulers(this.queue, jobs);
    console.log(`[worker] lịch BullMQ ${SCHEDULE_TZ}: ${names.length} job — ${names.join(', ')}`);
  }
}

// Mỗi job một lượt độc lập như timer systemd (song song giữa các job, chồng cùng job do khóa chặn).
// maxStalledCount 0: worker chết giữa lượt → lượt đó lỗi, KHÔNG chạy lại (Python không retry).
@Processor(JOB_QUEUE, { concurrency: 64, maxStalledCount: 0 })
class JobProcessor extends WorkerHost {
  async process(job: Job): Promise<number> {
    if (!Object.hasOwn(jobs, job.name)) {
      console.log(`[worker] job '${job.name}' không bật trong WORKER_JOBS — bỏ`);
      return 0;
    }
    const rc = await runScheduled(job.name, { jobs, runner });
    if (rc !== 0) throw new Error(`job '${job.name}' exit ${rc}`);
    return rc;
  }
}

@Module({
  imports: [
    DbModule.forRoot('job'),
    BullModule.forRoot({ connection: { url: redisUrl } }),
    // Lịch sử thật nằm ở `job_runs` — Redis chỉ giữ ít lượt gần nhất (không phình theo năm).
    BullModule.registerQueue({
      name: JOB_QUEUE,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
    }),
  ],
  providers: [JobScheduler, JobProcessor],
})
class WorkerModule {}

try {
  const app = await NestFactory.createApplicationContext(WorkerModule, { abortOnError: false });
  app.enableShutdownHooks();
} catch (e) {
  if (!(e instanceof ServiceBindError)) throw e;
  console.error(`[err] ${e.message}`);
  process.exit(EXIT_SERVICE);
}
