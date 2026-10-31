import { basename } from 'node:path';
import type { AiGateway } from '@samsam/core/ai/gateway';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
} from '@samsam/core/ops/director';
import { jobRun } from '@samsam/core/ops/job-runs';
import { vnDate } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { readinessFromDb } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { pgErrName } from '@samsam/core/rollout/counters';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen, pyRepr, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { DbLease } from '../channels/channels.command.js';
import { SALT_MIN } from '../intel_import/intel-import.js';
import { contentCfg } from '../kd_listing_live/content-lite.js';
import { pySortedStr } from '../kd_quote/py.js';
import * as koc from './mkt-koc.js';
import * as ugc from './mkt-ugc.js';
import * as yt from './mkt-youtube.js';
import * as san from './seo-san.js';
import * as web from './seo-web.js';
import { missingClauses } from './shared.js';

// Lệnh CLI thay `python -m agents.mkt_koc|mkt_ugc|mkt_youtube|seo_san|seo_web` — cùng cờ, exit
// code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit code (test gọi thẳng); lớp Command chỉ
// nối. Kiểm tham số trong hàm (lỗi ném ở parse của nest-commander thoát 0); tham số sai →
// `<prog>: error: …` exit 2 TRƯỚC mọi kết nối DB (Python argparse). Cổng triển khai TẮT → 1 dòng
// `[rollout] …` exit 2 TRƯỚC connect/đọc nguồn/in/ghi.

export type Io = { out: (s: string) => void; err: (s: string) => void };
const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
const NO_DB = '[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

export type CliDeps = {
  env?: Env;
  io?: Io;
  /** Python `lead_store.connect()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng triển khai/AI trên kết nối của lệnh (mặc định `wireCore`). */
  wire?: (db: Db | null) => Pick<AiGateway, 'chat'> | undefined;
  now?: () => Date;
  jobRun?: typeof jobRun;
  /** Thư mục báo cáo/kit mặc định (Python test đổi `REPORTS_DIR`). */
  outDir?: string;
  /** Gốc repo cho file hợp đồng KOC (Python test đổi `ROOT`). */
  root?: string;
  kocFile?: string;
  directorsDir?: string;
  ugcRules?: () => ugc.UgcRules;
  /** youtube: AI Gateway (mặc định gateway của `wire`). */
  ai?: Pick<AiGateway, 'chat'>;
  /** seo_web: thư mục jsonl crawl (mặc định data/). */
  dataDir?: string;
  seoRulesFile?: string;
  /** seo_web --fetch: collector (mặc định `OwnFetcher` trên Fetcher intel — test tiêm transport giả). */
  fetcherFactory?: (budget: number) => web.Fetcher | Promise<web.Fetcher>;
};

const defaultWire = (db: Db | null) => wireCore(db);

async function openDb(d: CliDeps, io: Io): Promise<DbLease | null> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) io.err(NO_DB);
  else (d.wire ?? defaultWire)(lease.db);
  return lease;
}

/** Python `type(e).__name__` của lỗi bắt bằng `except (psycopg.Error, ValueError[, OSError])` →
 * [tên, là lỗi DB] | null (lỗi khác không bắt). `RolloutBlocked` là ValueError con — giữ tên riêng. */
function pyErr(e: unknown, os = true): [string, boolean] | null {
  // lỗi fs (có `path`) TRƯỚC isDbError — core coi mọi `code` E… (vd EACCES) là lỗi kết nối DB.
  if (e instanceof Error && (e as { path?: unknown }).path !== undefined) {
    return os ? [pyOsName(e), false] : null;
  }
  if (isDbError(e)) return [pgErrName(e), true];
  if (e instanceof RolloutBlocked) return ['RolloutBlocked', false];
  if (e instanceof RangeError) return ['ValueError', false];
  return null;
}

/** mkt_koc/mkt_ugc: `[error] <tên>: <_db_msg nếu lỗi DB, khác: tên loại>` (Python không in thông điệp). */
function kocUgcErr(e: unknown, io: Io): number {
  const info = pyErr(e);
  if (info === null) throw e;
  const [n, db] = info;
  io.err(`[error] ${n}: ${maskPii(db ? dbMsg(e) : n)}`);
  return 1;
}

// ===================================================================== mkt_koc
export type KocOpts = {
  list?: boolean;
  kit?: boolean;
  release?: string;
  koc?: string;
  sku?: string;
  channel?: string;
  draftIds?: string;
  by?: string;
  dryRun?: boolean;
};

/** `python -m agents.mkt_koc` — MKT-06 kit KOC/affiliate từ nội dung đã duyệt (NHÁP vào hàng duyệt,
 * không gửi, không liên hệ KOC). Exit: 0 ok/skip · 1 bị chặn (in mã)/cấu hình/DB lỗi · 2 usage/DB down. */
export async function mktKocMain(o: KocOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`mkt_koc: error: ${msg}`);
    return 2;
  };
  const rel = o.release === undefined ? null : pyInt(o.release);
  if (o.release !== undefined && rel === null) {
    return usage(`argument --release: invalid int value: ${pyRepr(o.release)}`);
  }
  if ([o.list, o.kit, rel !== null].filter(Boolean).length !== 1) {
    return usage('cần đúng 1 thao tác: --list | --kit | --release');
  }
  const by = pyStrip(o.by ?? '');
  if ((o.kit || rel !== null) && !by) return usage('--kit/--release cần --by <tên người>');
  let kocs: Map<string, koc.Koc>;
  try {
    kocs = new Map(koc.loadKocs(d.kocFile).map((k) => [k.code, k]));
  } catch (e) {
    if (!(e instanceof koc.KocConfigError)) throw e;
    io.out(`[err] ${e.message} — không connect.`);
    return 1;
  }
  if (o.list) {
    for (const k of kocs.values()) {
      const [text, , err] = koc.loadContract(k.contract_file, d.root);
      const miss = text !== null ? missingClauses(text, 'koc') : null;
      const st =
        text === null
          ? err
          : !miss?.length
            ? 'đủ điều khoản (kiểm từ khóa)'
            : `THIẾU ${miss.join(', ')}`;
      io.out(`- ${k.code} [${k.platform}] ${k.niche} — hợp đồng ${k.contract_status}: ${st}`);
    }
    io.out('Danh sách MẪU — không phải KOC thật; agent không liên hệ KOC.');
    return 0;
  }
  let k: koc.Koc | undefined;
  let ids: bigint[] | null = null;
  let channel = '';
  if (o.kit) {
    k = kocs.get(o.koc ?? '');
    if (k === undefined) {
      return usage(`--koc phải một trong [${pySortedStr(kocs.keys()).map(pyRepr).join(', ')}]`);
    }
    if (!o.sku) return usage('--kit cần --sku');
    ids = koc.parseIds(o.draftIds);
    if (ids === null) return usage(`--draft-ids phải 1..${koc.MAX_DRAFTS} id số, cách dấu phẩy`);
    channel = o.channel || k.platform;
    if (channel !== k.platform) return usage(`--channel phải trùng nền tảng KOC (${k.platform})`);
    // r19 (r12 RB): tắt → không dựng kit/đẩy mục, cả --dry-run.
    const why = await blocked(null, 'kit KOC', koc.FEATURE);
    if (why) return sayBlocked(why, io.out);
  }
  let dcfg: DirectorConfig;
  try {
    dcfg = loadConfig('marketing', d.directorsDir ?? DIRECTORS_DIR);
  } catch (e) {
    if (!(e instanceof DirectorConfigError)) throw e;
    io.out(`[err] cấu hình khối marketing: ${e.message} — không connect.`);
    return 1;
  }
  const lease = await openDb(d, io);
  if (lease === null) return 2;
  const stop = (code: string, why: string) => {
    io.out(`[chặn] ${code}: ${maskPii(why)} — không ghi gì.`);
    return 1;
  };
  try {
    if (rel !== null) {
      const res = await koc.release(lease.db, rel, {
        ...(d.outDir ? { outDir: d.outDir } : {}),
        ...(d.root ? { root: d.root } : {}),
      });
      if (res.code) return stop(res.code, res.reason);
      io.out(
        `[release] kit mục #${rel} → ${res.path} (phát hành bởi ${by}) — người phụ trách gửi TAY cho KOC; hệ thống không gửi.`,
      );
      return 0;
    }
    const kk = k as koc.Koc;
    const res = await koc.submitKit(lease.db, kk, o.sku as string, channel, ids as bigint[], {
      by,
      dcfg,
      dryRun: Boolean(o.dryRun),
      ...(d.root ? { root: d.root } : {}),
    });
    if (res.code) return stop(res.code, res.reason);
    if (o.dryRun) io.out(`[dry-run] kit ${kk.code} × \`${o.sku}\` đạt mọi luật chặn — không ghi.`);
    else if (res.skipped) {
      io.out(`[skip] kit ${res.object_id} đã có trong hàng duyệt — không tạo thêm.`);
    } else {
      io.out(
        `[kit] mục hàng duyệt #${res.qid} (koc_brief, CHỜ GĐ Marketing duyệt) — agent không gửi/liên hệ KOC.`,
      );
    }
    return 0;
  } catch (e) {
    return kocUgcErr(e, io);
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== mkt_ugc
export type UgcOpts = {
  reviews?: string;
  channel?: string;
  mentions?: boolean;
  since?: string;
  reuseRequest?: string;
  reuse?: string;
  contactId?: string;
  by?: string;
  dryRun?: boolean;
};

/** Python `_since`: 'YYYY-MM-DD' (\d Unicode như Python) có thật → chuỗi ISO | null. */
export function sinceArg(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u.test(s)) return null;
  // date.fromisoformat chỉ nhận chữ số ASCII
  if (!/^[0-9-]+$/.test(s)) return null;
  const [y, m, dd] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, dd));
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === dd
    ? s
    : null;
}

/** `python -m agents.mkt_ugc` — MKT-07 UGC/review → ĐỀ XUẤT trả lời + xin phép dùng lại (NHÁP — không
 * tự trả lời/đăng/nhắn khách). Exit: 0 ok/skip · 1 bị chặn/cấu hình/DB lỗi · 2 usage/DB down. */
export async function mktUgcMain(o: UgcOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (msg: string) => {
    io.err(`mkt_ugc: error: ${msg}`);
    return 2;
  };
  if (o.channel !== undefined && !ugc.REVIEW_CHANNELS.includes(o.channel)) {
    return usage(
      `argument --channel: invalid choice: ${pyRepr(o.channel)} (choose from 'shopee', 'tiktok')`,
    );
  }
  const cid = o.contactId === undefined ? null : pyInt(o.contactId);
  if (o.contactId !== undefined && cid === null) {
    return usage(`argument --contact-id: invalid int value: ${pyRepr(o.contactId)}`);
  }
  const nOps = [
    o.reviews !== undefined,
    o.mentions,
    o.reuseRequest !== undefined,
    o.reuse !== undefined,
  ].filter(Boolean).length;
  if (nOps !== 1) {
    return usage('cần đúng 1 thao tác: --reviews | --mentions | --reuse-request | --reuse');
  }
  const by = pyStrip(o.by ?? '');
  if (!by) return usage('cần --by <tên người lập>');
  if (o.reviews !== undefined && o.channel === undefined) {
    return usage('--reviews cần --channel shopee|tiktok');
  }
  const since = sinceArg(o.since);
  if (o.mentions && since === null) return usage('--mentions cần --since YYYY-MM-DD');
  if (o.reuse !== undefined && (cid === null || cid <= 0n)) {
    return usage('--reuse cần --contact-id N (số dương)');
  }
  // r19 (r12 RB): mọi thao tác sinh ugc_reply/ugc_reuse — tắt → không đọc nguồn/in/đẩy mục, cả --dry-run.
  const why = await blocked(null, 'đề xuất UGC', ugc.FEATURE);
  if (why) return sayBlocked(why, io.out);
  let rules: ugc.UgcRules;
  let dcfg: DirectorConfig;
  try {
    rules = (d.ugcRules ?? (() => ugc.loadRules()))();
    dcfg = loadConfig('marketing', d.directorsDir ?? DIRECTORS_DIR);
  } catch (e) {
    if (!(e instanceof ugc.UgcConfigError || e instanceof DirectorConfigError)) throw e;
    io.out(`[err] cấu hình: ${e.message} — không connect.`);
    return 1;
  }
  const salt = env.INTEL_HASH_SALT ?? '';
  if ((o.reviews !== undefined || o.mentions) && cpLen(salt) < SALT_MIN) {
    io.out(`[err] thiếu INTEL_HASH_SALT (≥${SALT_MIN} ký tự) — không connect.`);
    return 1;
  }
  let items: ugc.Item[] = [];
  const channel = o.channel as string;
  if (o.reviews !== undefined) {
    const [rows, errs, sha] = ugc.readReviews(o.reviews, channel, rules);
    if (errs.length) {
      io.out(`[err] file review lỗi (${errs.length}) — chặn cả file, không ghi:`);
      for (const e of errs.slice(0, 50)) io.out(`  - ${e}`);
      return 1;
    }
    items = rows.map((r) => ({
      key: r.ma,
      text: r.text,
      stars: r.stars,
      source: `file review sha256 \`${(sha as string).slice(0, 12)}\` dòng ${r.row_no}`,
    }));
    if (o.dryRun) {
      const st = await ugc.processItems(items, channel, rules, { salt, san: true });
      for (const l of ugc.statsLines('reviews', st, true)) io.out(l);
      return 0;
    }
  }
  const lease = await openDb(d, io);
  if (lease === null) return 2;
  const db = lease.db;
  try {
    if (o.reviews !== undefined) {
      const st = await ugc.processItems(items, channel, rules, { salt, san: true, db, by, dcfg });
      for (const l of ugc.statsLines('reviews', st, false)) io.out(l);
      return 0;
    }
    if (o.mentions) {
      const all = await ugc.mentionItems(db, since as string);
      const st = ugc.emptyStats();
      const chans = pySortedStr(new Set(all.map((i) => i.channel).filter((c): c is string => !!c)));
      for (const ch of chans) {
        const part = await ugc.processItems(
          all.filter((i) => i.channel === ch),
          ch,
          rules,
          { salt, san: false, db: o.dryRun ? null : db, by, dcfg },
        );
        for (const [k2, v] of Object.entries(part.lop)) st.lop[k2] = (st.lop[k2] ?? 0) + v;
        st.moi.push(...part.moi);
        st.chan.push(...part.chan);
        st.skip += part.skip;
        st.khong_soan += part.khong_soan;
      }
      for (const l of ugc.statsLines('mentions', st, Boolean(o.dryRun))) io.out(l);
      return 0;
    }
    const res =
      o.reuseRequest !== undefined
        ? await ugc.reuseRequest(db, o.reuseRequest, rules, { by, dcfg })
        : await ugc.reuse(db, o.reuse as string, cid as bigint, { by, dcfg });
    if (res.code) {
      io.out(`[chặn] ${res.code}: ${res.why} — không ghi gì.`);
      return 1;
    }
    if (res.qid === null || res.qid === undefined) {
      io.out('[skip] đã có mục này trong hàng duyệt — không tạo thêm.');
    } else {
      io.out(`[done] mục hàng duyệt #${res.qid} (NHÁP, chờ duyệt) — agent không gửi/không đăng.`);
    }
    return 0;
  } catch (e) {
    return kocUgcErr(e, io);
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== mkt_youtube
export type YoutubeOpts = {
  brief?: string;
  render?: boolean;
  dryRun?: boolean;
  brollDir?: string;
  outDir?: string;
};

/** `python -m agents.mkt_youtube` — MKT-12 nháp gói video YouTube dài + Shorts xem trước (chế độ riêng
 * tư; không đăng). `--render`: LƯU nháp TRƯỚC rồi mới dựng Shorts (thiếu B-roll/ffmpeg → `[short-fail]`,
 * gói vẫn lưu, exit 0). Exit: 0 ok · 1 từ chối/lỗi · 2 tham số sai / DB down. */
export async function mktYoutubeMain(o: YoutubeOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`mkt_youtube: error: ${msg}`);
    return 2;
  };
  if (o.brief === undefined) return usage('the following arguments are required: --brief');
  if (o.render && o.dryRun) return usage('--render không đi với --dry-run');
  // r12 D1: tính năng TẮT → chặn TRƯỚC lời gọi AI (kể cả --dry-run).
  const why = await blocked(null, 'gói video YouTube', yt.FEATURE);
  if (why) return sayBlocked(why, io.out);
  const connect = d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env));
  let lease: DbLease | null = null;
  if (!o.dryRun) {
    lease = await connect();
    if (lease === null) {
      io.err(NO_DB);
      return 2;
    }
  }
  // dry-run: không ghi nháp, nhưng AI Gateway vẫn cần DB để đọc chi tiêu/ghi llm_usage (như Python
  // gateway tự kết nối); không kết nối được → gateway chặn (fail-closed).
  const gwLease = lease === null && !d.ai ? await connect() : null;
  const gw = (d.wire ?? defaultWire)((lease ?? gwLease)?.db ?? null);
  const ai = d.ai ?? (gw as Pick<AiGateway, 'chat'>);
  try {
    const rmap = lease ? await readinessFromDb(lease.db) : null;
    const pkg = await yt.writePackage(o.brief, { ai, readiness: rmap });
    if (pkg.error) {
      io.err(`[error] ${pkg.error}`);
      return 1;
    }
    if (!pkg.ok) {
      const r = pkg.refused as { code: string; reason: string };
      io.out(`[refuse] ${r.code}: ${r.reason} (LLM ${pkg.llm_calls} lời gọi)`);
      return 1;
    }
    io.out(pkg.text);
    if (o.dryRun) {
      io.out('[dry-run] KHÔNG lưu nháp, không dựng Shorts');
      return 0;
    }
    const db = (lease as DbLease).db;
    const did = await yt.savePackage(db, pkg, o.brief);
    io.out(`[ok] nháp #${did} pending (YouTube, chế độ ${yt.PRIVACY}) — chờ người duyệt`);
    if (o.render) {
      const shorts = await yt.renderShorts(pkg, {
        ...(o.brollDir ? { brollDir: o.brollDir } : {}),
        ...(o.outDir ? { outDir: o.outDir } : {}),
        db,
        draftId: did,
        env: d.env ?? process.env,
      });
      for (const r of shorts) {
        io.out(
          r.ok ? `[short] ${basename(r.path as string)}` : `[short-fail] ${r.refused || r.error}`,
        );
      }
    }
    return 0;
  } catch (e) {
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${Array.from(dbMsg(e)).slice(0, 300).join('')}`);
    return 1;
  } finally {
    await lease?.release().catch(() => {});
    await gwLease?.release().catch(() => {});
  }
}

// ===================================================================== seo_san
export type SeoSanOpts = {
  run?: boolean;
  dryRun?: boolean;
  sku?: string;
  channel?: string[];
  outDir?: string;
};

/** `python -m agents.seo_san` — gợi ý từ khóa tiêu đề listing sàn (Trends xuất tay) → nháp listing
 * pending, không sửa sàn. Exit: 0 ok · 1 có `failed`/lỗi luật/DB lỗi · 2 tham số sai/DB down. */
export async function seoSanMain(o: SeoSanOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`seo_san: error: ${msg}`);
    return 2;
  };
  for (const c of o.channel ?? []) {
    if (!san.CHANNELS.includes(c)) {
      return usage(
        `argument --channel: invalid choice: ${pyRepr(c)} (choose from 'shopee', 'tiktok')`,
      );
    }
  }
  if (!o.run) return usage('cần --run');
  // r19 (r12 RB): tắt → không ghi nháp/báo cáo seo-san- (cả --dry-run).
  const why = await blocked(null, 'SEO sàn', san.FEATURE);
  if (why) return sayBlocked(why, io.out);
  let rules: web.SeoRules;
  try {
    rules = web.loadRules(d.seoRulesFile);
  } catch (e) {
    if (!(e instanceof web.SeoRulesError)) throw e;
    io.err(`[error] seo_rules.json: ${e.message}`);
    return 1;
  }
  const [cfg, err] = contentCfg();
  if (cfg === null) {
    io.err(`[error] cấu hình guardrail/golden: ${err}`);
    return 1;
  }
  const sku = o.sku ?? 'all';
  const skus = sku === 'all' ? pySortedStr(cfg.golden.keys()) : [sku];
  const channels = o.channel?.length ? o.channel : [...san.CHANNELS];
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) {
    io.err('[error] không kết nối được Postgres');
    return 2;
  }
  (d.wire ?? defaultWire)(lease.db);
  try {
    let items: san.RunItem[];
    try {
      items = await san.run(lease.db, skus, channels, { dryRun: Boolean(o.dryRun), rules });
    } catch (e) {
      // Python seo_san bắt `(psycopg.Error, ValueError)` — OSError KHÔNG bắt (traceback).
      const info = pyErr(e, false);
      if (info === null) throw e;
      const msg = info[1] ? dbMsg(e) : (e as Error).message;
      io.err(`[error] ${info[0]}: ${Array.from(msg).slice(0, 200).join('')}`);
      return 1;
    }
    const day = vnDate((d.now ?? (() => new Date()))());
    // P8.4: --dry-run không ghi nháp listing → báo cáo không phải đầu ra thật của marketing-07.1.
    const path = await writeReport(
      san.render(day, items, Boolean(o.dryRun)),
      o.outDir ?? d.outDir ?? REPORTS_DIR,
      `seo-san-${day}.md`,
      Boolean(o.dryRun),
    );
    const cnt = new Map<string, number>();
    for (const it of items) cnt.set(it.status, (cnt.get(it.status) ?? 0) + 1);
    io.out(
      `[done] ${path} — ${pySortedStr(cnt.keys())
        .map((k) => `${k}=${cnt.get(k)}`)
        .join(' ')}`,
    );
    return cnt.get('failed') ? 1 : 0;
  } finally {
    await lease.release().catch(() => {});
  }
}

// ===================================================================== seo_web
export type SeoWebOpts = {
  fromCrawl?: boolean;
  fetch?: boolean;
  maxRequests?: string;
  submit?: boolean;
  outDir?: string;
};

/** `python -m agents.seo_web` — rà SEO website công ty (chỉ đọc) → báo cáo + nháp đề xuất sửa vào
 * hàng duyệt khối marketing. Exit: 0 ok · 1 lỗi luật/DB/payload không qua guardrail · 2 tham số sai. */
export async function seoWebMain(o: SeoWebOpts, d: CliDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`seo_web: error: ${msg}`);
    return 2;
  };
  const maxReq = o.maxRequests === undefined ? null : pyInt(o.maxRequests);
  if (o.maxRequests !== undefined && maxReq === null) {
    return usage(`argument --max-requests: invalid int value: ${pyRepr(o.maxRequests)}`);
  }
  if (o.fromCrawl && o.fetch) return usage('chỉ chọn 1 chế độ: --from-crawl HOẶC --fetch');
  if (maxReq !== null) {
    if (!o.fetch) return usage('--max-requests chỉ đi với --fetch');
    if (maxReq < 1n || maxReq > 200n) return usage('--max-requests phải 1..200');
  }
  let rules: web.SeoRules;
  try {
    rules = web.loadRules(d.seoRulesFile);
  } catch (e) {
    if (!(e instanceof web.SeoRulesError)) throw e;
    io.err(`[error] seo_rules.json: ${e.message}`);
    return 1;
  }
  const mode = o.fetch ? 'fetch' : 'from-crawl';
  // r12 RB: tắt → chặn TRƯỚC khi crawl/ghi báo cáo/submit.
  const why = await blocked(null, 'rà SEO web', web.FEATURE);
  if (why) return sayBlocked(why, io.out);
  let res: web.RunResult;
  let path: string;
  try {
    res = await web.run({
      mode,
      rules,
      maxRequests: maxReq === null ? null : Number(maxReq),
      ...(d.dataDir ? { dataDir: d.dataDir } : {}),
      // Python `OwnFetcher(own_hosts, budget=n)` — log [req]/[blocked] ra stdout như Fetcher Python.
      fetcherFactory:
        d.fetcherFactory ??
        ((b) => web.ownFetcher(rules.web.own_hosts, { budget: b, log: io.out })),
      now: (d.now ?? (() => new Date()))(),
    });
    // P8.4: rà site công khai của công ty (crawl/fetch thật).
    path = await writeReport(
      res.text,
      o.outDir ?? d.outDir ?? REPORTS_DIR,
      `seo-web-${res.day}.md`,
      false,
    );
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
    throw e;
  }
  io.out(`[done] ${path} — ${mode} vấn đề=${res.issues.length} requests=${res.stats.requests}`);
  if (!o.submit) return 0;
  if (!res.issues.length) {
    io.out('[skip] không có vấn đề — không submit');
    return 0;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env ?? process.env)))();
  if (lease === null) {
    io.err('[error] không kết nối được Postgres — chưa submit');
    return 1;
  }
  (d.wire ?? defaultWire)(lease.db);
  let out: web.SubmitOut;
  try {
    out = await web.submitIssues(lease.db, res.day, mode, res.issues);
  } catch (e) {
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB (${pgErrName(e)}) — chưa submit`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
  if (out.status === 'refused') {
    io.err(
      `[error] payload không qua guardrail ([${(out.codes ?? []).map(pyRepr).join(', ')}]) — không submit`,
    );
    return 1;
  }
  io.out(
    `[submit] ${out.status} ${out.object_id}${out.id !== undefined ? ` → mục #${out.id}` : ''}`,
  );
  return 0;
}

// ===================================================================== nest-commander

@Command({
  name: 'mkt-koc',
  description:
    'MKT-06 kit KOC/affiliate từ nội dung đã duyệt — NHÁP vào hàng duyệt (không gửi, không liên hệ KOC)',
})
export class MktKocCommand extends CommandRunner {
  async run(_a: string[], o: KocOpts): Promise<void> {
    process.exitCode = await mktKocMain(o);
  }
  @Option({ flags: '--list' })
  parseList(): boolean {
    return true;
  }
  @Option({ flags: '--kit' })
  parseKit(): boolean {
    return true;
  }
  @Option({ flags: '--release <qid>' })
  parseRelease(v: string): string {
    return v;
  }
  @Option({ flags: '--koc <code>' })
  parseKoc(v: string): string {
    return v;
  }
  @Option({ flags: '--sku <sku>' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <ch>' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--draft-ids <ids>' })
  parseDraftIds(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'mkt-ugc',
  description:
    'MKT-07 UGC/review → ĐỀ XUẤT trả lời + xin phép dùng lại (NHÁP — không tự trả lời/đăng/nhắn khách)',
})
export class MktUgcCommand extends CommandRunner {
  async run(_a: string[], o: UgcOpts): Promise<void> {
    process.exitCode = await mktUgcMain(o);
  }
  @Option({ flags: '--reviews <file>' })
  parseReviews(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <ch>', description: 'shopee|tiktok' })
  parseChannel(v: string): string {
    return v;
  }
  @Option({ flags: '--mentions' })
  parseMentions(): boolean {
    return true;
  }
  @Option({ flags: '--since <d>' })
  parseSince(v: string): string {
    return v;
  }
  @Option({ flags: '--reuse-request <ref>' })
  parseReuseRequest(v: string): string {
    return v;
  }
  @Option({ flags: '--reuse <ref>' })
  parseReuse(v: string): string {
    return v;
  }
  @Option({ flags: '--contact-id <n>' })
  parseContactId(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--dry-run' })
  parseDryRun(): boolean {
    return true;
  }
}

@Command({
  name: 'mkt-youtube',
  description:
    'MKT-12 — nháp gói video YouTube dài + Shorts xem trước (chế độ riêng tư; không đăng)',
})
export class MktYoutubeCommand extends CommandRunner {
  async run(_a: string[], o: YoutubeOpts): Promise<void> {
    process.exitCode = await mktYoutubeMain(o);
  }
  @Option({ flags: '--brief <text>' })
  parseBrief(v: string): string {
    return v;
  }
  @Option({
    flags: '--render',
    description: 'dựng Shorts xem trước từ B-roll có license',
  })
  parseRender(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: 'không lưu nháp, không dựng' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--broll-dir <dir>' })
  parseBrollDir(v: string): string {
    return v;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'seo-san',
  description:
    'Gợi ý từ khóa tiêu đề listing sàn (Trends xuất tay) → nháp listing pending — không sửa sàn',
})
export class SeoSanCommand extends CommandRunner {
  // Python `__main__` bọc MỌI lần chạy bằng job_run("agents.seo_san").
  async run(_a: string[], o: SeoSanOpts): Promise<void> {
    process.exitCode = await jobRun(san.JOB, async (r) => {
      const rc = await seoSanMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--run', description: 'chạy gợi ý' })
  parseRun(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: 'không ghi nháp (0 INSERT)' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--sku <sku>', description: 'all | sku_key' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--channel <ch>', description: 'kênh (lặp được; mặc định shopee + tiktok)' })
  parseChannel(v: string, prev?: string[]): string[] {
    return [...(prev ?? []), v];
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

@Command({
  name: 'seo-web',
  description:
    'Rà SEO website công ty (chỉ đọc) → báo cáo + nháp đề xuất sửa vào hàng duyệt khối marketing',
})
export class SeoWebCommand extends CommandRunner {
  // Python `__main__` bọc MỌI lần chạy bằng job_run("agents.seo_web").
  async run(_a: string[], o: SeoWebOpts): Promise<void> {
    process.exitCode = await jobRun(web.JOB, async (r) => {
      const rc = await seoWebMain(o);
      r.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--from-crawl', description: 'dùng dữ liệu đã crawl (mặc định, 0 request)' })
  parseFromCrawl(): boolean {
    return true;
  }
  @Option({ flags: '--fetch', description: 'GET trang qua collector (robots + ≥1s/host)' })
  parseFetch(): boolean {
    return true;
  }
  @Option({ flags: '--max-requests <n>', description: 'ngân sách request cho --fetch (1..200)' })
  parseMaxRequests(v: string): string {
    return v;
  }
  @Option({ flags: '--submit', description: 'đẩy 1 mục đề xuất vào hàng duyệt khối marketing' })
  parseSubmit(): boolean {
    return true;
  }
  @Option({ flags: '--out-dir <dir>' })
  parseOutDir(v: string): string {
    return v;
  }
}

export const MKT_KOC_UGC_SEO_COMMANDS = [
  MktKocCommand,
  MktUgcCommand,
  MktYoutubeCommand,
  SeoSanCommand,
  SeoWebCommand,
];
