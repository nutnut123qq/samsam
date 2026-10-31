import { type Service, ServiceBindError, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { jobRun } from '@samsam/core/ops/job-runs';
import { pyIntStr } from '@samsam/core/ops/py-date';
import { isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { isAlcohol, KbFilterError } from '@samsam/core/security/kb-filter';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool, PoolClient } from 'pg';
import { type CollectDeps, collectMain } from './collect.js';
import {
  type ChatFn,
  clean,
  DEFAULT_MAX_REQUESTS,
  emit,
  Fetcher,
  type FetcherOpts,
  type Health,
  JOB,
  loadSources,
  normHost,
  report,
  run,
  SOURCES_FILE,
  type Source,
  type SourcesCfg,
  tierCHosts,
} from './intel.js';

// Lệnh CLI thay `python -m crawler.intel` (+ `python -m crawler.collect`) — cùng cờ, exit code,
// thông điệp chính. Thứ tự kiểm (như Python): tham số (đúng 1 thao tác; --max-requests 1..200) →
// exit 2 → file nguồn lỗi → exit 1 → --source lạ → exit 2, --source tầng C → [blocked] exit 2 →
// bộ lọc rượu hỏng → exit 1 → kết nối DB (lỗi/thiếu DSN/thiếu bảng → exit 1, 0 request mạng) → mới
// ra mạng. `--run` không `--source`: chỉ nguồn `status == "duyet"`; `--source X` cho phép CHẠY THỬ
// nguồn `cho_duyet` ([warn]). Exit 1 nếu ≥1 nguồn được thử mà 0 nguồn thành công.

export type IntelOpts = {
  run?: boolean;
  report?: boolean;
  source?: string[];
  maxRequests?: string;
  sources?: string;
  llm?: boolean;
};

export type IntelDeps = {
  env?: Env;
  /** stdout (Python `print`) */
  log?: (s: string) => void;
  /** stderr (lỗi tham số kiểu argparse) */
  err?: (s: string) => void;
  /** Pool của job (mặc định login dịch vụ `job` — dev rơi về DATABASE_URL). */
  open?: (env: Env) => Promise<Pool>;
  /** Mạng + đồng hồ cho Fetcher (test: server/đồng hồ giả). */
  fetcher?: Pick<FetcherOpts, 'transport' | 'sleep' | 'clock' | 'gatewayFile'>;
  /** AI Gateway (mặc định `wireCore(pool)` khi cần LLM). */
  chat?: ChatFn;
  jobRun?: typeof jobRun;
};

const TABLE_MSG = '[err] chưa có bảng intel_items — chạy `python scripts/apply_schema.py`';

async function runCli(
  c: PoolClient,
  pool: Pool,
  cfg: SourcesCfg,
  o: IntelOpts,
  picked: string[],
  byId: Map<string, Source>,
  maxReq: number,
  d: IntelDeps,
  health: Health,
): Promise<number> {
  const log = d.log ?? console.log;
  let sources: Source[];
  if (picked.length) {
    sources = picked.map((s) => byId.get(s) as Source);
    for (const s of sources) {
      if (s.status !== 'duyet') log(`[warn] ${s.id}: nguồn chưa duyệt — chạy thử`);
    }
  } else {
    sources = cfg.sources.filter((s) => (s.tier === 'A' || s.tier === 'B') && s.status === 'duyet');
    if (!sources.length) {
      log(
        '[warn] 0 nguồn đã duyệt — không thu gì (BGĐ/Quản lý MXH duyệt danh sách; chạy thử: --source ID)',
      );
      return 0;
    }
  }
  let chat: ChatFn | null = null;
  if (o.llm) {
    if (cfg.llm.enabled === true) {
      chat =
        d.chat ??
        ((): ChatFn => {
          const g = wireCore(pool);
          return (a, m, op) => g.chat(a, m, op);
        })();
    } else log('[warn] LLM tắt — chờ Pháp chế xác nhận');
  }
  const f = new Fetcher({
    budget: maxReq,
    extraBlock: tierCHosts(cfg),
    log,
    env: d.env,
    ...d.fetcher,
  });
  try {
    return await run(c, cfg, sources, f, chat, log, health);
  } catch (e) {
    if (!(e instanceof KbFilterError)) throw e;
    log(`[err] bộ lọc rượu hỏng: ${e.message}`);
    return 1;
  } finally {
    f.close();
  }
}

/** `crawler-intel --run [--source ID …] [--max-requests N] [--sources PATH] [--llm]` | `--report`. */
export async function intelMain(o: IntelOpts, d: IntelDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const usage = (msg: string) => {
    err(`[err] ${msg}`);
    return 2;
  };
  let n = BigInt(DEFAULT_MAX_REQUESTS);
  if (o.maxRequests !== undefined) {
    const v = pyIntStr(o.maxRequests);
    if (v === null) return usage(`argument --max-requests: invalid int value: '${o.maxRequests}'`);
    n = v;
  }
  if (Number(Boolean(o.run)) + Number(Boolean(o.report)) !== 1) {
    return usage('cần đúng 1 thao tác: --run hoặc --report');
  }
  if (o.report && (o.source?.length || o.llm)) return usage('--source/--llm chỉ dùng với --run');
  if (n < 1n || n > 200n) return usage('--max-requests phải trong 1..200');
  const maxReq = Number(n);
  const [cfg, errs] = loadSources(o.sources ?? SOURCES_FILE);
  if (cfg === null) {
    for (const e of errs) log(`[err] ${e}`);
    return 1;
  }
  const byId = new Map(cfg.sources.map((s) => [s.id, s]));
  const picked = [...new Set(o.source ?? [])];
  for (const sid of picked) {
    if (!byId.has(sid)) return usage(`--source không tồn tại: ${clean(sid, 64)}`);
  }
  for (const sid of picked) {
    const s = byId.get(sid) as Source;
    if (s.tier === 'C') {
      emit(log, 'blocked', { source: sid, host: normHost(s.url), reason: 'tier_c' });
      return 2;
    }
  }
  try {
    isAlcohol('rượu'); // fail-closed TRƯỚC khi ra mạng
  } catch (e) {
    if (!(e instanceof KbFilterError)) throw e;
    log(`[err] bộ lọc rượu hỏng: ${e.message} — không thu tin`);
    return 1;
  }
  let pool: Pool;
  try {
    pool = await (d.open ?? ((e: Env) => servicePool('job' as Service, e)))(env);
  } catch (e) {
    log(
      e instanceof ServiceBindError ? `[err] ${e.message}` : '[err] thiếu DATABASE_URL trong .env',
    );
    return 1;
  }
  let c: PoolClient;
  try {
    c = await pool.connect();
  } catch {
    // psycopg.connect: mọi lỗi kết nối (mạng, xác thực, DB không có) đều là OperationalError.
    await pool.end().catch(() => {});
    log('[err] không kết nối được Postgres: OperationalError');
    return 1;
  }
  try {
    const t = await c.query<{ r: string | null }>("select to_regclass('intel_items')::text as r");
    if (t.rows[0]?.r == null) {
      log(TABLE_MSG);
      return 1;
    }
    if (o.report) {
      await report(c, log);
      return 0;
    }
    return await (d.jobRun ?? jobRun)(
      JOB,
      async (jr) => {
        const health: Health = {};
        const rc = await runCli(c, pool, cfg, o, picked, byId, maxReq, d, health);
        jr.ok = rc === 0;
        if (health.detail) jr.detail = health.detail;
        return rc;
      },
      env,
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    log(`[err] lỗi DB: ${pgErrName(e)}`);
    return 1;
  } finally {
    c.release();
    await pool.end().catch(() => {});
  }
}

@Command({
  name: 'crawler-intel',
  description:
    'Thu tin thị trường RSS/Atom tầng A/B → intel_items (robots, ≥1s/host, chặn tầng C/sàn/MXH)',
})
export class CrawlerIntelCommand extends CommandRunner {
  async run(_args: string[], o: IntelOpts): Promise<void> {
    process.exitCode = await intelMain(o);
  }

  @Option({ flags: '--run', description: 'thu tin tầng A/B' })
  parseRun(): boolean {
    return true;
  }

  @Option({ flags: '--report', description: 'tóm tắt intel_items' })
  parseReport(): boolean {
    return true;
  }

  @Option({
    flags: '--source <id>',
    description: 'chạy THỬ nguồn này (lặp được; cho phép cho_duyet)',
  })
  parseSource(v: string, prev: string[] = []): string[] {
    return [...prev, v];
  }

  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({
    flags: '--max-requests <n>',
    description: 'ngân sách TỔNG request (1..200, mặc định 60)',
  })
  parseMaxRequests(v: string): string {
    return v;
  }

  @Option({
    flags: '--sources <path>',
    description: 'file nguồn (mặc định data/intel_sources.json)',
  })
  parseSources(v: string): string {
    return v;
  }

  @Option({ flags: '--llm', description: 'tóm tắt LLM (chỉ khi llm.enabled = true)' })
  parseLlm(): boolean {
    return true;
  }
}

/** `crawler-collect` — crawl website công ty → data/*.jsonl. */
export async function collectCli(d: CollectDeps = {}): Promise<number> {
  return collectMain(d);
}

@Command({
  name: 'crawler-collect',
  description: 'Crawl dữ liệu public website Sâm Sâm → data/*.jsonl (≥1s/request)',
})
export class CrawlerCollectCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await collectCli();
  }
}

export const INTEL_CRAWL_COMMANDS = [CrawlerIntelCommand, CrawlerCollectCommand];
