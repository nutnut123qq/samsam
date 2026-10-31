import { basename } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { createPool, ServiceBindError, serviceDsn, servicePool } from '@samsam/core/db';
import { approvalEnforced, type Env, pyStrip } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, DirectorConfigError, loadConfig } from '@samsam/core/ops/director';
import { pyInt } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { isDbError } from '@samsam/core/ops/tx';
import { createGateway, wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { checkGenerate, featureFor, RolloutBlocked } from '@samsam/core/rollout/rollout';
import { isAlcohol, KbFilterError } from '@samsam/core/security/kb-filter';
import { cpLen, pyRepr } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type pg from 'pg';
import { loadSources, SOURCES_FILE } from '../intel_crawl/intel.js';
import * as ii from './intel-import.js';
import * as iw from './intel-weekly.js';
import * as sv from './social-vendor.js';
import { MAX_PRINT_ERRS, safe } from './table.js';

// Lệnh CLI thay `python -m ingest.intel_import`, `python -m ingest.social_vendor`,
// `python scripts/intel_weekly.py` — cùng cờ, exit code, thông điệp chính. `*Main(opts, deps)` trả
// exit code (test gọi thẳng); lớp Command chỉ nối. Tham số sai → `<prog>: error: …` exit 2 TRƯỚC mọi
// kết nối DB (Python argparse). Muối `INTEL_HASH_SALT` + DSN đọc từ MÔI TRƯỜNG tiến trình (TS không
// nạp `.env`).

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Giờ thật (test thay). */
  clock?: () => Date;
  /** Pool tới DSN (test đếm số lần "connect"). */
  pool?: (dsn: string, env: Env, readOnly: boolean) => pg.Pool;
  keywordsFile?: string;
  rulesFile?: string;
  configFile?: string;
  sourcesFile?: string;
  competitorsFile?: string;
  /** Nối guardrail/cổng triển khai trên pool của lệnh (mặc định `wireCore`). */
  wire?: (db: Db) => unknown;
  /** AI Gateway cho `--llm` (mặc định `createGateway` trên pool ghi được của DATABASE_URL). */
  gateway?: Pick<AiGateway, 'chat'>;
};

const defaultPool = (dsn: string, env: Env, readOnly: boolean): pg.Pool =>
  createPool(
    dsn,
    {
      connectionTimeoutMillis: 10_000,
      // Python `conn.read_only = True`: mọi giao dịch của báo cáo là READ ONLY
      ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
    },
    env,
  );

// Tên lớp lỗi psycopg theo SQLSTATE (thông điệp `[err] lỗi DB: <Tên>` như Python).
const PG_NAMES: Record<string, string> = {
  '23505': 'UniqueViolation',
  '23514': 'CheckViolation',
  '23503': 'ForeignKeyViolation',
  '23502': 'NotNullViolation',
  '22001': 'StringDataRightTruncation',
  '22003': 'NumericValueOutOfRange',
  '22P02': 'InvalidTextRepresentation',
  '22007': 'InvalidDatetimeFormat',
  '22008': 'DatetimeFieldOverflow',
  '25006': 'ReadOnlySqlTransaction',
};
export function pgName(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(PG_NAMES, code)
    ? (PG_NAMES[code] as string)
    : pgErrName(e);
}

function printErrs(io: Io, errs: string[]): void {
  for (const e of errs.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
  if (errs.length > MAX_PRINT_ERRS) {
    io.out(`[err] ... và ${errs.length - MAX_PRINT_ERRS} lỗi khác`);
  }
  io.out(`[err] ${errs.length} lỗi — không connect, không nạp gì.`);
}

/** Bộ lọc rượu hỏng → fail-closed (exit 1). */
function alcoholFilterBroken(io: Io): boolean {
  try {
    isAlcohol('rượu');
    return false;
  } catch (e) {
    if (!(e instanceof KbFilterError)) throw e;
    io.out(`[err] bộ lọc rượu hỏng: ${e.message}`);
    return true;
  }
}

async function connectOr(
  pool: pg.Pool,
  io: Io,
  prefix = 'không kết nối được Postgres',
): Promise<pg.PoolClient | null> {
  try {
    return await pool.connect();
  } catch (e) {
    io.out(`[err] ${prefix}: ${pgName(e)}`);
    return null;
  }
}

// ======================================================================== intel_import

const TARGET: Record<string, string> = {
  competitor: 'competitor_observations',
  trend_timeline: 'trends_weekly',
  trend_related: 'trends_related',
  social: 'social_mentions',
};

export type IntelImportOpts = {
  competitor?: string;
  trend?: string;
  social?: string;
  seed?: string;
  channel?: string;
};

/** `python -m ingest.intel_import` — nạp file intel nhập tay (đối thủ / Google Trends / comment
 * kênh sở hữu), không request mạng. */
export async function intelImportMain(o: IntelImportOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const now = (d.clock ?? (() => new Date()))();
  const usage = (m: string) => {
    io.err(`intel_import: error: ${m}`);
    return 2;
  };
  if (o.channel !== undefined && !ii.S_CHANNELS.includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: ${pyRepr(o.channel)} (choose from 'fanpage', 'zalo_oa', 'tiktok')`,
    );
  }
  const ops = (['competitor', 'trend', 'social'] as const).filter((k) => o[k] !== undefined);
  if (ops.length !== 1) return usage('cần đúng 1 thao tác: --competitor | --trend | --social');
  if (o.seed !== undefined && o.trend === undefined) return usage('--seed chỉ dùng với --trend');
  if (o.channel !== undefined && o.social === undefined) {
    return usage('--channel chỉ dùng với --social');
  }
  if (o.social !== undefined && o.channel === undefined) {
    return usage('--social cần --channel fanpage|zalo_oa|tiktok');
  }
  if (alcoholFilterBroken(io)) return 1;

  const path = o[ops[0] as 'competitor' | 'trend' | 'social'] as string;
  let kind: string | null;
  let rows: unknown[];
  let errs: string[];
  let sha: string | null;
  let cfg: ii.TrendCfg | null = null;
  if (o.competitor !== undefined) {
    kind = 'competitor';
    [rows, errs, sha] = await ii.readCompetitor(path, ii.todayVn(now));
  } else if (o.trend !== undefined) {
    const [c, ce] = ii.loadTrendConfig(d.keywordsFile ?? ii.KEYWORDS_FILE);
    if (c === null) {
      for (const e of ce) io.out(`[err] ${e}`);
      return 1;
    }
    cfg = c;
    [kind, rows, errs, sha] = await ii.readTrend(path, cfg);
    if (!errs.length && kind === 'trend_related') {
      if (o.seed === undefined) return usage('file relatedQueries cần --seed <từ khóa gốc>');
      if (!cfg.keywords.has(ii.kw(o.seed))) {
        return usage('--seed không có trong trend_keywords.json');
      }
    } else if (!errs.length && o.seed !== undefined) {
      return usage('--seed chỉ dùng với file relatedQueries');
    }
  } else {
    kind = 'social';
    const [rules, re] = ii.loadSocialRules(d.rulesFile ?? ii.RULES_FILE);
    if (rules === null) {
      for (const e of re) io.out(`[err] ${e}`);
      return 1;
    }
    [rows, errs, sha] = await ii.readSocial(path, o.channel as string, rules, now);
  }
  if (errs.length) {
    printErrs(io, errs);
    return 1;
  }

  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối
  // login superuser/owner/thiếu biến (Python `auth.bind_service("loader")`).
  let pool: pg.Pool | null = null;
  if (approvalEnforced(env)) {
    try {
      pool = await servicePool('loader', env);
    } catch (e) {
      if (!(e instanceof ServiceBindError)) throw e;
      io.out(`[err] ${e.message}`);
      return 2;
    }
  }
  try {
    let salt = '';
    if (kind === 'social') {
      salt = env.INTEL_HASH_SALT ?? '';
      if (cpLen(salt) < ii.SALT_MIN) {
        io.out(
          `[err] thiếu INTEL_HASH_SALT (≥${ii.SALT_MIN} ký tự) trong .env — không nạp social.`,
        );
        return 1;
      }
    }
    if (pool === null) {
      const dsn = serviceDsn('loader', env).dsn;
      if (!dsn) {
        io.out('[err] thiếu DATABASE_URL trong .env');
        return 1;
      }
      pool = (d.pool ?? defaultPool)(dsn, env, false);
    }
    const client = await connectOr(pool, io);
    if (client === null) return 1;
    const fname = safe(basename(path), 200); // che SĐT/email nếu tên file có
    let iid: number | null = null;
    let extra = '';
    try {
      await client.query('begin');
      const reg = await client.query(
        'select to_regclass($1)::text as a, to_regclass($2)::text as b',
        ['intel_imports', TARGET[kind as string]],
      );
      if (reg.rows[0]?.a === null || reg.rows[0]?.b === null) {
        await client.query('rollback');
        io.out('[err] thiếu bảng v7.2 — chạy `python scripts/apply_schema.py` trước.');
        return 1;
      }
      const old = await client.query('select id, kind from intel_imports where file_sha256 = $1', [
        sha,
      ]);
      if (old.rows[0]) {
        await client.query('rollback');
        io.out(
          `[skip] file đã nạp: import #${old.rows[0].id} (${old.rows[0].kind}) — không ghi gì.`,
        );
        return 0;
      }
      if (kind === 'competitor') {
        const [id, le] = await ii.loadCompetitor(
          client,
          rows as ii.CompRow[],
          fname,
          sha as string,
        );
        if (le.length) {
          await client.query('rollback');
          for (const e of le.slice(0, MAX_PRINT_ERRS)) io.out(`[err] ${e}`);
          io.out(`[err] ${le.length} lỗi — đã rollback, không nạp gì.`);
          return 1;
        }
        iid = id;
      } else if (kind === 'trend_timeline') {
        iid = await ii.loadTrendTimeline(
          client,
          rows as ii.TimelineRow[],
          cfg as ii.TrendCfg,
          fname,
          sha as string,
        );
      } else if (kind === 'trend_related') {
        iid = await ii.loadTrendRelated(
          client,
          rows as ii.RelatedRow[],
          ii.kw(o.seed as string),
          fname,
          sha as string,
        );
      } else {
        // Đợt hoàn thiện 22/10: nhãn phân loại = đầu ra marketing-05.1 — tính năng TẮT (HĐ 6.7)
        // → không sinh (không ghi gì).
        try {
          await checkGenerate(
            client,
            featureFor({ table: 'social_mentions' }),
            'phân loại bình luận kênh sở hữu',
          );
        } catch (e) {
          if (!(e instanceof RolloutBlocked)) throw e;
          await client.query('rollback');
          io.out(`[blocked] ${e.message}`);
          return 2;
        }
        const [id, fresh, dup] = await ii.loadSocial(
          client,
          rows as ii.SocialRow[],
          o.channel as string,
          salt,
          fname,
          sha as string,
        );
        iid = id;
        extra = ` new=${fresh} dup=${dup}`;
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      if (!isDbError(e)) throw e;
      const code = (e as { code?: unknown }).code;
      if (code === '23505') {
        if (String((e as { constraint?: unknown }).constraint ?? '').includes('file_sha256')) {
          io.out('[skip] file vừa được nạp song song — không ghi gì.');
          return 0;
        }
        io.out(`[err] lỗi DB, đã rollback: ${pgName(e)}`);
        return 1;
      }
      if (code === '42P01') {
        io.out('[err] thiếu bảng — chạy `python scripts/apply_schema.py` trước.');
        return 1;
      }
      io.out(`[err] lỗi DB, đã rollback: ${pgName(e)}`);
      return 1;
    } finally {
      client.release();
    }
    const n =
      kind === 'trend_timeline'
        ? new Set((rows as ii.TimelineRow[]).map((r) => r.week)).size
        : rows.length;
    io.out(`[load] ${kind} #${iid} ${fname}: ${n} dòng${extra}`);
    if (kind === 'trend_timeline') {
      const sp = (cfg as ii.TrendCfg).spike;
      const tl = rows as ii.TimelineRow[];
      for (const k of [...new Set(tl.map((r) => r.keyword))].sort(cpCmp)) {
        const series = tl
          .filter((r) => r.keyword === k)
          .map((r) => [r.week, r.value] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
        for (const s of ii.findSpikes(series, sp.window_weeks, sp.ratio, sp.min_delta)) {
          io.out(`[spike] ${k} tuần ${s.week}: ${s.value} (trung vị ${s.medianStr})`);
        }
      }
    }
    io.out('[done]');
    return 0;
  } finally {
    await pool?.end();
  }
}

// ======================================================================== social_vendor

/** `python -m ingest.social_vendor --file F` — cổng nạp social listening NHÀ CUNG CẤP (TGĐ duyệt). */
export async function socialVendorMain(o: { file?: string }, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const now = (d.clock ?? (() => new Date()))();
  if (o.file === undefined) {
    io.err('social_vendor: error: the following arguments are required: --file');
    return 2;
  }
  const why = sv.checkApproval(d.configFile ?? sv.CONFIG_FILE);
  if (why) {
    io.out(
      `[blocked] nhà cung cấp chưa được TGĐ duyệt — không nạp (${why}). Cần hợp đồng + DPA + TGĐ duyệt; người thật cập nhật data/social_vendor.json.`,
    );
    return 2;
  }
  if (alcoholFilterBroken(io)) return 1;
  const [rules, re] = ii.loadSocialRules(d.rulesFile ?? ii.RULES_FILE);
  if (rules === null) {
    for (const e of re) io.out(`[err] ${e}`);
    return 1;
  }
  const [rows, errs, sha] = await sv.readVendor(o.file, rules, now);
  if (errs.length) {
    printErrs(io, errs);
    return 1;
  }
  const salt = env.INTEL_HASH_SALT ?? '';
  if (cpLen(salt) < ii.SALT_MIN) {
    io.out(`[err] thiếu INTEL_HASH_SALT (≥${ii.SALT_MIN} ký tự) trong .env — không nạp.`);
    return 1;
  }
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    io.out('[err] thiếu DATABASE_URL trong .env');
    return 1;
  }
  const pool = (d.pool ?? defaultPool)(dsn, env, false);
  try {
    const client = await connectOr(pool, io);
    if (client === null) return 1;
    const fname = safe(basename(o.file), 200); // che SĐT/email nếu tên file có
    let res: [number, number, number];
    try {
      await client.query('begin');
      const reg = await client.query(
        "select to_regclass('intel_imports')::text as a, to_regclass('social_mentions_vendor')::text as b",
      );
      if (reg.rows[0]?.a === null || reg.rows[0]?.b === null) {
        await client.query('rollback');
        io.out('[err] thiếu bảng v10.3 — chạy `python scripts/apply_schema.py` trước.');
        return 1;
      }
      const old = await client.query('select id, kind from intel_imports where file_sha256 = $1', [
        sha,
      ]);
      if (old.rows[0]) {
        await client.query('rollback');
        io.out(
          `[skip] file đã nạp: import #${old.rows[0].id} (${old.rows[0].kind}) — không ghi gì.`,
        );
        return 0;
      }
      res = await sv.loadVendor(client, rows, salt, fname, sha as string);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      if (!isDbError(e)) throw e;
      if (
        (e as { code?: unknown }).code === '23505' &&
        String((e as { constraint?: unknown }).constraint ?? '').includes('file_sha256')
      ) {
        io.out('[skip] file vừa được nạp song song — không ghi gì.');
        return 0;
      }
      io.out(`[err] lỗi DB, đã rollback: ${pgName(e)}`);
      return 1;
    } finally {
      client.release();
    }
    io.out(`[load] vendor #${res[0]} ${fname}: ${rows.length} dòng new=${res[1]} dup=${res[2]}`);
    io.out('[done]');
    return 0;
  } finally {
    await pool.end();
  }
}

// ======================================================================== intel_weekly

export type IntelWeeklyOpts = {
  week?: string;
  llm?: boolean;
  suggestKeywords?: boolean;
  import?: string;
  dryRun?: boolean;
  outDir?: string;
};

/** `python scripts/intel_weekly.py` — báo cáo tuần intel (chỉ đọc) / `--suggest-keywords`. */
export async function intelWeeklyMain(o: IntelWeeklyOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const now = (d.clock ?? (() => new Date()))();
  const usage = (m: string) => {
    io.err(`intel_weekly.py: error: ${m}`);
    return 2;
  };
  let importId: number | null = null;
  if (o.import !== undefined) {
    const v = pyInt(o.import);
    if (v === null) return usage(`argument --import: invalid int value: ${pyRepr(o.import)}`);
    importId = Number(v);
  }
  if (o.suggestKeywords) {
    if (o.week !== undefined || o.llm || o.outDir) {
      return usage('--suggest-keywords không đi với --week/--llm/--out-dir');
    }
    return keywordsMain(importId, Boolean(o.dryRun), d, io, env);
  }
  if (o.import !== undefined || o.dryRun) {
    return usage('--import/--dry-run chỉ đi với --suggest-keywords');
  }
  let day: string;
  if (o.week !== undefined) {
    const w = ii.isoDate(o.week);
    if (w === null) return usage('--week phải là ngày YYYY-MM-DD hợp lệ');
    day = w;
  } else day = iw.defaultWeekDay(ii.todayVn(now));
  const [cfg, ce] = ii.loadTrendConfig(d.keywordsFile ?? ii.KEYWORDS_FILE);
  if (cfg === null) {
    for (const e of ce) io.out(`[err] ${e}`);
    return 1;
  }
  const warn = (m: string) => io.err(`[warn] ${m}`);
  let useLlm = false;
  if (o.llm) {
    const [src] = loadSources(d.sourcesFile ?? SOURCES_FILE);
    if (src === null || src.llm?.enabled !== true) {
      warn('llm.enabled chưa bật (chờ Pháp chế) — không gọi LLM');
    } else useLlm = true;
  }
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    io.out('[err] thiếu DATABASE_URL trong .env');
    return 1;
  }
  const pool = (d.pool ?? defaultPool)(dsn, env, true);
  let full = '';
  let payload = '';
  let paths: string[] = [];
  let blocked: string[] = [];
  try {
    const client = await connectOr(pool, io);
    if (client === null) return 1;
    try {
      const missing: string[] = [];
      for (const t of iw.TABLES) {
        const { rows } = await client.query('select to_regclass($1)::text as r', [t]);
        if (rows[0]?.r === null) missing.push(t);
      }
      if (missing.length) {
        io.out(`[err] thiếu bảng ${missing.join(', ')} — chạy \`python scripts/apply_schema.py\``);
        return 1;
      }
      [full, payload] = await iw.render(client, day, cfg);
      if (o.outDir) [paths, blocked] = await iw.writeWeekly(client, day, cfg, o.outDir);
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.out(`[err] lỗi DB: ${pgName(e)}`);
      return 1;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  io.out(full);
  for (const p of paths) io.out(`[done] ${p}`);
  if (blocked.length) {
    // r12 G1-L1: báo TỪNG phần bị chặn, không báo thành công
    for (const w of blocked) io.out(`[rollout] ${w}`);
    return 2;
  }
  if (useLlm) {
    let gw = d.gateway ?? null;
    let llmPool: pg.Pool | null = null;
    if (gw === null) {
      // Gateway ghi `llm_usage` + đọc chi tiêu trên kết nối GHI ĐƯỢC (Python: kết nối riêng).
      llmPool = (d.pool ?? defaultPool)(dsn, env, false);
      gw = createGateway(llmPool);
    }
    try {
      const s = await iw.summarize(gw, payload, warn);
      if (s) {
        io.out('\n## Tóm tắt (LLM, đã qua guardrail — chỉ tham khảo)\n');
        io.out(s);
      }
    } finally {
      await llmPool?.end();
    }
  }
  return 0;
}

async function keywordsMain(
  importId: number | null,
  dryRun: boolean,
  d: CliDeps,
  io: Io,
  env: Env,
): Promise<number> {
  let cfg: DirectorConfig;
  try {
    cfg = loadConfig('intel');
    if (!Object.hasOwn(cfg.object_types, iw.OT_KW)) {
      throw new RangeError(`intel.json thiếu loại việc ${iw.OT_KW}`);
    }
  } catch (e) {
    if (!(e instanceof DirectorConfigError || e instanceof RangeError)) throw e;
    io.out(`[err] cấu hình lỗi: ${e.message} — không connect`);
    return 1;
  }
  // Python `auth.bind_service("job")` + `lead_store.connect()`.
  let pool: pg.Pool;
  try {
    pool = await servicePool('job', env);
  } catch (e) {
    if (!(e instanceof ServiceBindError)) throw e;
    io.out(approvalEnforced(env) ? `[err] ${e.message}` : '[err] không kết nối được Postgres');
    return 2;
  }
  let r: iw.SuggestResult;
  try {
    try {
      await pool.query('select 1');
    } catch {
      io.out('[err] không kết nối được Postgres');
      return 2;
    }
    (d.wire ?? ((db: Db) => wireCore(db)))(pool);
    const comp = d.competitorsFile ? iw.loadCompetitors(d.competitorsFile) : null;
    r = await iw.suggestKeywords(pool, importId, cfg, dryRun, comp);
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      io.out(`[rollout] ${e.message}`);
      return 2;
    }
    if (e instanceof iw.KeywordConfigError) {
      io.out(`[err] ${e.message} — không đề xuất (fail-closed)`);
      return 1;
    }
    if (isDbError(e)) {
      io.out(`[err] lỗi DB: ${pgName(e)}`);
      return 2;
    }
    throw e;
  } finally {
    await pool.end();
  }
  if (r.res === null) {
    io.out(
      '[info] không có file Google Trends related (trend_related) phù hợp (--import) — không có gì để gợi ý',
    );
    return 0;
  }
  io.out(r.payload as string);
  const pend = r.res.cho_quyet;
  if (pend.length) {
    io.out(
      `[cho-quyet] ${pend.length} từ khóa thương hiệu/xuất xứ đối thủ chờ Pháp chế/Marketing quyết (data/keyword_competitors.json) — không tự cho qua`,
    );
  }
  if (dryRun) {
    io.out(
      `[dry-run] ${r.object_id} — KHÔNG ghi DB${r.skipped ? ' (đã có trong hàng duyệt)' : ''}`,
    );
  } else if (r.skipped) io.out(`[skip] ${r.object_id} đã có mục #${r.qid}`);
  else io.out(`[ok] mục hàng duyệt #${r.qid} (${iw.OT_KW}, chờ Quản lý Marketing)`);
  return 0;
}

// ======================================================================== nest-commander

@Command({
  name: 'intel-import',
  description:
    'Nạp file intel nhập tay (đối thủ / Google Trends / comment kênh sở hữu) — không request mạng.',
})
export class IntelImportCommand extends CommandRunner {
  async run(_a: string[], o: IntelImportOpts): Promise<void> {
    process.exitCode = await intelImportMain(o);
  }
  @Option({ flags: '--competitor <F>', description: 'CSV/XLSX giá đối thủ ghi tay' })
  parseCompetitor(v: string): string {
    return v;
  }
  @Option({
    flags: '--trend <F>',
    description: 'Google Trends xuất tay (multiTimeline / relatedQueries)',
  })
  parseTrend(v: string): string {
    return v;
  }
  @Option({ flags: '--social <F>', description: 'export comment/inbox kênh SỞ HỮU' })
  parseSocial(v: string): string {
    return v;
  }
  @Option({ flags: '--seed <KW>', description: 'từ khóa gốc của file relatedQueries' })
  parseSeed(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <C>', description: 'kênh của --social (fanpage|zalo_oa|tiktok)' })
  parseChannel(v: string): string {
    return v;
  }
}

@Command({
  name: 'social-vendor',
  description: 'Nạp file social listening của nhà cung cấp (cổng TGĐ duyệt) — không request mạng.',
})
export class SocialVendorCommand extends CommandRunner {
  async run(_a: string[], o: { file?: string }): Promise<void> {
    process.exitCode = await socialVendorMain(o);
  }
  @Option({ flags: '--file <F>', description: 'CSV/XLSX export của nhà cung cấp' })
  parseFile(v: string): string {
    return v;
  }
}

@Command({
  name: 'intel-weekly',
  description:
    'Báo cáo tuần intel (chỉ đọc, tất định) / --suggest-keywords gợi ý từ khóa an toàn pháp lý.',
})
export class IntelWeeklyCommand extends CommandRunner {
  async run(_a: string[], o: IntelWeeklyOpts): Promise<void> {
    process.exitCode = await intelWeeklyMain(o);
  }
  @Option({ flags: '--week <YYYY-MM-DD>', description: 'ngày bất kỳ trong tuần cần báo cáo' })
  parseWeek(v: string): string {
    return v;
  }
  @Option({ flags: '--llm', description: 'tóm tắt LLM (chỉ khi llm.enabled = true)' })
  parseLlm(): boolean {
    return true;
  }
  @Option({
    flags: '--suggest-keywords',
    description:
      'v14.5 gợi ý từ khóa an toàn pháp lý từ file Trends related → hàng duyệt intel (keyword_suggest)',
  })
  parseSuggest(): boolean {
    return true;
  }
  @Option({
    flags: '--import <ID>',
    description: 'id intel_imports (trend_related) — mặc định mới nhất; chỉ với --suggest-keywords',
  })
  parseImport(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run', description: '--suggest-keywords: in gợi ý, không ghi DB' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({
    flags: '--out-dir <DIR>',
    description:
      'docx P2: ghi intel-doithu-<thứ Hai>.md (intel-03) + intel-trend-<thứ Hai>.md (intel-04.1) qua writeReport',
  })
  parseOutDir(v: string): string {
    return v;
  }
}

export const INTEL_IMPORT_COMMANDS = [IntelImportCommand, SocialVendorCommand, IntelWeeklyCommand];
