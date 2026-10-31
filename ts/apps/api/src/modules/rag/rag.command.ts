import { GatewayError } from '@samsam/core/ai/gateway';
import { createPool, databaseUrl, type Service, servicePool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { wireCore } from '@samsam/core/ops/wire';
import { DATA_DIR } from '@samsam/core/paths';
import { cliGate } from '@samsam/core/security/auth';
import { KbFilterError } from '@samsam/core/security/kb-filter';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Pool } from 'pg';
import { backfill, SourceError, sync } from './embed-store.js';
import { kbGapsMain } from './kb-gaps.js';
import { ingestDoc, type KbOpts, parseKbArgs } from './kb-internal.js';
import type { Ai } from './rag.service.js';

// Lệnh CLI thay `python -m ingest.embed_store` / `python -m ingest.kb_internal` /
// `python scripts/kb_gaps.py` — cùng cờ, exit code, thông điệp chính.
// KHÁC Python có chủ đích: embed-store/kb-internal mặc định SONG SONG (chỉ điền `embedding_v2` cho
// row Python khớp; doc chưa khớp → [blocked] exit 2); delete+insert như Python chỉ với `--cutover`
// (đã tắt RAG Python — docs/rewrite/KE_HOACH.md mục 5).

/** Phụ thuộc của lệnh — test thay env/pool/AI giả (mặc định: tiến trình thật). */
export type CliDeps = {
  env?: Env;
  log?: (s: string) => void;
  err?: (s: string) => void;
  dataDir?: string;
  /** Pool login dịch vụ (Python auth.bind_service) */
  servicePool?: (s: Service, env: Env) => Promise<Pool>;
  /** gateway dùng thay gateway thật trên pool loader (test: nhà cung cấp giả) */
  ai?: (pool: Pool) => Ai;
};

const errText = (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`;

/** Mở pool loader + nối core + cổng loader → [pool, ai] | exit code. */
async function loaderSetup(
  name: 'embed_store' | 'kb_internal',
  d: CliDeps,
): Promise<[Pool, Ai, string] | number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  let pool: Pool;
  // v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader) — chế độ thực từ chối
  // login superuser/owner/thiếu biến.
  try {
    pool = await (d.servicePool ?? servicePool)('loader', env);
  } catch (e) {
    log(`[err] ${(e as Error).message}`);
    return 2;
  }
  const gw = wireCore(pool);
  const ai = d.ai ? d.ai(pool) : gw;
  // v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) — chưa cấu hình + tính năng tắt
  // → không nạp.
  const why = await loaderGate(name, pool, undefined, log);
  if (why) {
    log(`[rollout] ${why}`);
    await pool.end();
    return 2;
  }
  let model: string;
  try {
    model = gw.policy().local.embed_model;
  } catch (e) {
    log(`[err] ${errText(e)} — không ghi DB`);
    await pool.end();
    return 1;
  }
  return [pool, ai, model];
}

const CUTOVER_HINT = '--cutover CHỈ khi đã tắt RAG Python (docs/rewrite/KE_HOACH.md mục 5)';

/** `embed-store [--cutover]` (Python `python -m ingest.embed_store`). */
export async function embedStoreMain(
  d: CliDeps = {},
  o: { cutover?: boolean } = {},
): Promise<number> {
  const log = d.log ?? console.log;
  const s = await loaderSetup('embed_store', d);
  if (typeof s === 'number') return s;
  const [pool, ai, model] = s;
  try {
    if (!o.cutover) {
      const b = await backfill(pool, ai, { dataDir: d.dataDir ?? DATA_DIR, model, log });
      const t = (
        await pool.query<{ n: number; v: number }>(
          'select count(*)::int as n, count(embedding_v2)::int as v from chunks',
        )
      ).rows[0];
      log(
        `[done] song song: điền embedding_v2 ${b.filled} doc (${b.updated} chunk) / đủ sẵn ${b.kept}` +
          ` / lệch bản Python ${b.blocked.length} doc — embed ${b.embedded_chunks} chunk,` +
          ` ${b.embed_calls} lời gọi embed (embedding_v2: ${t.v}/${t.n})`,
      );
      if (b.updated < b.embedded_chunks) {
        log(
          `[warn] ${b.embedded_chunks - b.updated} chunk đổi giữa chừng (Python nạp lại) — chạy lại`,
        );
      }
      if (b.blocked.length) {
        const more = b.blocked.length > 5 ? ', …' : '';
        log(
          `[blocked] ${b.blocked.length} doc mới/đổi so với bản Python (${b.blocked.slice(0, 5).join(', ')}${more})` +
            ` — không ghi: chạy python -m ingest.embed_store trước; ${CUTOVER_HINT}`,
        );
        return 2;
      }
      return 0;
    }
    const st = await sync(pool, ai, { dataDir: d.dataDir ?? DATA_DIR, model, log });
    const nDb = (await pool.query<{ n: number }>('select count(*)::int as n from chunks')).rows[0]
      .n;
    log(
      `[done] mới ${st.new} / đổi ${st.changed} / giữ ${st.kept} / xóa ${st.deleted} doc — embed` +
        ` ${st.embedded_chunks} chunk, ${st.embed_calls} lời gọi embed (table total: ${nDb})`,
    );
    return 0;
  } catch (e) {
    if (e instanceof SourceError || e instanceof KbFilterError || e instanceof GatewayError) {
      log(`[err] ${errText(e)} — không ghi DB`);
    } else {
      log(`[err] ${(e as Error).name} — không ghi DB`); // không in chi tiết lỗi DB/DSN
    }
    return 1;
  } finally {
    await pool.end();
  }
}

/** `kb-internal --file F --collection internal:<phong> --approved-by "<trưởng phòng>" [--doc-id]
 * [--cutover]`. */
export async function kbInternalMain(o: KbOpts, d: CliDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const a = parseKbArgs(o);
  if ('error' in a) {
    err(`[err] ${a.error}`);
    return 2;
  }
  // v14 vá review: người duyệt qua cổng TRƯỚC khi đổi sang loader — kết nối này là login của người
  // (khớp `db_login` ở chế độ thực).
  let dsn: string;
  try {
    dsn = databaseUrl(env);
  } catch {
    log('[err] thiếu DATABASE_URL');
    return 1;
  }
  const hpool = createPool(dsn, {}, env);
  let why: string | null;
  try {
    why = await cliGate(
      hpool,
      a.approvedBy,
      'data_platform',
      'approve',
      'chunks_internal',
      `${a.collection}/${a.docId}`,
      { env },
    );
  } finally {
    await hpool.end();
  }
  if (why) {
    log(`[err] ${why} — không nạp.`);
    return 1;
  }
  const s = await loaderSetup('kb_internal', d);
  if (typeof s === 'number') return s;
  const [pool, ai, model] = s;
  try {
    const r = await ingestDoc(
      pool,
      ai,
      {
        collection: a.collection,
        docId: a.docId,
        title: a.title,
        sourceRef: a.sourceRef,
        text: a.text,
        approvedBy: a.approvedBy,
        model,
        cutover: o.cutover,
      },
      log,
    );
    const at = `${a.collection} / ${a.docId}`;
    if (r.status === 'missing' || r.status === 'mismatch') {
      const what =
        r.status === 'missing' ? 'chưa có bản do Python nạp' : 'nội dung khác bản Python';
      log(
        `[blocked] ${at}: ${what} — không ghi: nạp bằng python -m ingest.kb_internal trước; ${CUTOVER_HINT}`,
      );
      return 2;
    }
    const state = {
      unchanged: 'không đổi (0 embed)',
      loaded: 'đã nạp',
      backfilled: 'điền embedding_v2 (bản Python giữ nguyên)',
    }[r.status];
    log(`[kb-internal] ${at}: ${state} — ${r.chunks} chunk, version ${r.version}`);
    return 0;
  } catch (e) {
    log(`[err] ${(e as Error).name} — không nạp`); // không in nội dung file / chi tiết DB
    return 1;
  } finally {
    await pool.end();
  }
}

@Command({ name: 'embed-store', description: 'Đồng bộ data/*.jsonl vào bảng chunks (incremental)' })
export class EmbedStoreCommand extends CommandRunner {
  async run(_args: string[], o: { cutover?: boolean }): Promise<void> {
    process.exitCode = await embedStoreMain({}, o);
  }

  @Option({
    flags: '--cutover',
    description: 'delete+insert như Python — CHỈ khi đã tắt RAG Python',
  })
  parseCutover(): boolean {
    return true;
  }
}

@Command({ name: 'kb-internal', description: 'Nạp tài liệu nội bộ ĐÃ DUYỆT vào chunks_internal' })
export class KbInternalCommand extends CommandRunner {
  async run(_args: string[], o: KbOpts): Promise<void> {
    process.exitCode = await kbInternalMain(o);
  }

  // Kiểm giá trị ở run() (parseKbArgs): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({ flags: '--file <file>' })
  parseFile(v: string): string {
    return v;
  }

  @Option({ flags: '--collection <collection>' })
  parseCollection(v: string): string {
    return v;
  }

  @Option({ flags: '--approved-by <name>' })
  parseApprovedBy(v: string): string {
    return v;
  }

  @Option({ flags: '--doc-id <slug>' })
  parseDocId(v: string): string {
    return v;
  }

  @Option({
    flags: '--cutover',
    description: 'delete+insert như Python — CHỈ khi đã tắt RAG Python',
  })
  parseCutover(): boolean {
    return true;
  }
}

@Command({ name: 'kb-gaps', description: 'Báo cáo câu NO_DATA lặp lại để bổ sung KB (0 LLM)' })
export class KbGapsCommand extends CommandRunner {
  async run(_args: string[], o: { min?: string; out?: string }): Promise<void> {
    process.exitCode = kbGapsMain(o);
  }

  @Option({ flags: '--min <n>' })
  parseMin(v: string): string {
    return v;
  }

  @Option({ flags: '--out <file>' })
  parseOut(v: string): string {
    return v;
  }
}
