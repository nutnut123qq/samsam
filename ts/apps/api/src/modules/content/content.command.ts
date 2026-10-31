import type { AiGateway } from '@samsam/core/ai/gateway';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { DbLease } from '../channels/channels.command.js';
import {
  contentCfg,
  DEFAULT_BY,
  dailyBatch,
  dmyOf,
  fmtDaily,
  fmtItem,
  listingBatch,
} from './content.js';
import {
  CalendarError,
  type CalendarOpts,
  dateArg,
  type Io,
  mktCalendarMain,
  STD_IO,
} from './mkt-calendar.js';

// Lệnh CLI thay `python -m pipelines.content` (--listing / --daily) và `python -m
// pipelines.mkt_calendar` — cùng cờ, exit code, thông điệp chính. `*Main(opts, deps)` trả exit code
// (test gọi thẳng); lớp Command chỉ nối. Tham số sai → `<prog>: error: …` exit 2 TRƯỚC mọi kết nối
// DB (Python argparse). Job lịch `content_daily` = `content --daily` (DATABASE_URL = login job).

const PROG = 'python -m pipelines.content';
const LISTING_CHANNELS = ['shopee', 'tiktok', 'web'];
const NO_DB = 'không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)';

export type ContentOpts = {
  listing?: boolean;
  daily?: boolean;
  date?: string;
  sku?: string[];
  channel?: string[];
  by?: string;
  /** commander `--no-llm` → `llm: false`. */
  llm?: boolean;
};
export type ContentDeps = {
  io?: Io;
  env?: Env;
  now?: () => Date;
  /** Python `store._conn_or_none()` (DATABASE_URL) → null khi thiếu DSN / host chết. */
  connect?: () => Promise<DbLease | null>;
  /** Nối guardrail/cổng/gateway trên kết nối của lệnh (mặc định `wireCore`) → gateway. */
  wire?: (db: Db) => Pick<AiGateway, 'chat'>;
  /** Test thay (Python monkeypatch `content.listing_batch` / `content.daily_batch`). */
  listingBatch?: typeof listingBatch;
  dailyBatch?: typeof dailyBatch;
};

async function dailyMain(day: string, d: ContentDeps, io: Io): Promise<number> {
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(`[error] ${NO_DB} — không ghi được nháp`); // DB chết → exit 2, 0 lời gọi LLM
    return 2;
  }
  let res: Awaited<ReturnType<typeof dailyBatch>>;
  try {
    const ai = (d.wire ?? wireCore)(lease.db);
    res = await (d.dailyBatch ?? dailyBatch)(lease.db, day, {}, { ai, env: d.env });
  } catch (e) {
    if (e instanceof RolloutBlocked) {
      io.err(`[blocked] ${e.message}`);
      return 2;
    }
    if (e instanceof CalendarError) {
      io.err(`[error] lịch mùa vụ: ${e.message}`);
      return 1;
    }
    if (isDbError(e)) {
      io.err(`[error] lỗi DB: ${dbMsg(e)}`);
      return 2;
    }
    throw e;
  } finally {
    await lease.release().catch(() => {});
  }
  io.out(`# Nháp bài ngày ${dmyOf(day)} — cần ${res.per_day}/ngày (PL01 Marketing)`);
  for (const it of res.items) io.out(fmtDaily(it));
  for (const c of res.refused) {
    const sku = c.sku ? ` [${c.sku}]` : '';
    io.out(`[bị từ chối] ${c.kind}:${c.ref} × ${c.channel}${sku}: ${c.code} — ${c.reason}`);
  }
  for (const c of res.overflow) {
    io.out(
      `[vượt ${res.per_day}/ngày] chiến dịch ${c.ref} × ${c.channel} — GĐ Marketing quyết dời/thêm`,
    );
  }
  if (res.missing) {
    io.out(`[THIẾU] ${res.missing}/${res.per_day} nháp: ${res.reasons.join('; ')}`);
  }
  io.out(
    `[done] ${res.live}/${res.per_day} nháp sống cho ngày ${day} (pending — GĐ Marketing duyệt ở tab 'Duyệt & Lịch', người đăng tay; agent không đăng)`,
  );
  return res.missing ? 1 : 0;
}

/** `python -m pipelines.content` — NHÁP listing SKU × kênh / 3 nháp bài/ngày vào hàng duyệt
 * (pending) — agent KHÔNG đăng, KHÔNG sửa listing trên sàn. Exit 0 không có failed (daily: đủ nháp
 * sống) · 1 có failed / daily THIẾU / lịch hỏng · 2 tham số sai, DB không kết nối được (kiểm TRƯỚC
 * mọi lời gọi LLM) hoặc tính năng tắt. */
export async function contentMain(o: ContentOpts, d: ContentDeps = {}): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  if (o.listing && o.daily) return usage('argument --daily: not allowed with argument --listing');
  const skus = o.sku ?? [];
  const channels = o.channel ?? [];
  for (const ch of channels) {
    if (!LISTING_CHANNELS.includes(ch)) {
      return usage(
        `argument --channel: invalid choice: ${pyRepr(ch)} (choose from 'shopee', 'tiktok', 'web')`,
      );
    }
  }
  let day: string | null = null;
  if (o.date !== undefined) {
    day = dateArg(o.date);
    if (day === null) {
      const bad = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u.test(o.date)
        ? 'ngày không hợp lệ'
        : 'ngày phải YYYY-MM-DD';
      return usage(`argument --date: ${bad}: ${pyRepr(o.date)}`);
    }
  }
  const noLlm = o.llm === false;
  if (o.daily) {
    if (skus.length || channels.length || o.by !== undefined || noLlm) {
      return usage(
        `--daily không nhận --sku/--channel/--by/--no-llm (người tạo cố định ${DEFAULT_BY})`,
      );
    }
    return dailyMain(day ?? vnDate((d.now ?? (() => new Date()))()), d, io);
  }
  if (!o.listing) return usage('cần --listing hoặc --daily');
  if (day !== null) return usage('--date chỉ dùng với --daily');
  const by = o.by ?? DEFAULT_BY;
  if (!skus.length || !channels.length) return usage('cần ít nhất 1 --sku và 1 --channel');
  if (!pyStrip(by)) return usage('--by không được rỗng');
  let list = [...skus];
  if (list.includes('all')) {
    const [cfg, err] = contentCfg();
    if (cfg === null) {
      io.err(`[error] ${err}`);
      return 2;
    }
    list = [...list.filter((s) => s !== 'all'), ...cfg.golden.keys()];
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(d.env)))();
  if (lease === null) {
    io.err(`[error] ${NO_DB} — không ghi được nháp`); // ghi-tác-vụ: DB chết → exit 2, 0 LLM
    return 2;
  }
  let items: Awaited<ReturnType<typeof listingBatch>>;
  try {
    const ai = (d.wire ?? wireCore)(lease.db);
    // r12 RB: listing tắt → chặn trước mọi lời gọi LLM/ghi nháp.
    const why = await blocked(lease.db, 'listing', 'sales-03');
    if (why) return sayBlocked(why, io.out);
    try {
      items = await (d.listingBatch ?? listingBatch)(
        lease.db,
        list,
        channels,
        { by: pyStrip(by), llm: !noLlm },
        { ai, env: d.env },
      );
    } catch (e) {
      if (!isDbError(e)) throw e;
      io.err(`[error] lỗi DB: ${dbMsg(e)}`);
      return 2;
    }
  } finally {
    await lease.release().catch(() => {});
  }
  for (const it of items) io.out(fmtItem(it));
  const n = (k: string) => items.filter((it) => it.status === k).length;
  io.out(
    `[done] ${items.length} cặp — created ${n('created')}, skipped ${n('skipped')}, refused ${n('refused')}, failed ${n('failed')} (nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải lên sàn tay)`,
  );
  return n('failed') ? 1 : 0;
}

const collect = (v: string, prev: string[] | undefined) => [...(prev ?? []), v];

@Command({
  name: 'content',
  description:
    'Sinh NHÁP listing theo SKU × kênh / 3 nháp bài/ngày vào hàng duyệt (pending) — agent KHÔNG đăng, KHÔNG sửa listing trên sàn',
})
export class ContentCommand extends CommandRunner {
  async run(_args: string[], opts: ContentOpts): Promise<void> {
    process.exitCode = await contentMain(opts);
  }
  @Option({ flags: '--listing', description: 'sinh listing SKU × kênh' })
  parseListing(): boolean {
    return true;
  }
  @Option({ flags: '--daily', description: 'v13.6: soạn 3 nháp bài/ngày theo lịch mùa vụ' })
  parseDaily(): boolean {
    return true;
  }
  @Option({ flags: '--date <d>', description: '--daily: ngày YYYY-MM-DD (mặc định hôm nay VN)' })
  parseDate(v: string): string {
    return v;
  }
  @Option({ flags: '--sku <sku>', description: "sku_key golden, lặp được; 'all' = mọi SKU golden" })
  parseSku(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({ flags: '--channel <ch>', description: 'kênh listing (shopee|tiktok|web), lặp được' })
  parseChannel(v: string, prev?: string[]): string[] {
    return collect(v, prev);
  }
  @Option({
    flags: '--by <name>',
    description: `--listing: người/agent tạo nháp (mặc định ${DEFAULT_BY})`,
  })
  parseBy(v: string): string {
    return v;
  }
  // commander: `--no-llm` là phủ định của `llm` (mặc định true) — trả false khi có cờ.
  @Option({ flags: '--no-llm', description: '--listing: chỉ khung golden, không gọi LLM' })
  parseNoLlm(): boolean {
    return false;
  }
}

@Command({
  name: 'mkt-calendar',
  description: 'MKT-01 lịch mùa vụ ĐỀ XUẤT (không DB, không đăng bài)',
})
export class MktCalendarCommand extends CommandRunner {
  async run(_args: string[], opts: CalendarOpts): Promise<void> {
    process.exitCode = await mktCalendarMain(opts);
  }
  @Option({ flags: '--start <d>', description: 'YYYY-MM-DD (mặc định thứ Hai tuần này, giờ VN)' })
  parseStart(v: string): string {
    return v;
  }
  @Option({ flags: '--weeks <n>', description: 'số tuần 1..26 (mặc định 4)' })
  parseWeeks(v: string): string {
    return v;
  }
  @Option({ flags: '--by <kỳ>', description: 'week|month (mặc định week)' })
  parseBy(v: string): string {
    return v;
  }
  @Option({ flags: '--ics [path]', description: 'ghi .ics (mặc định data/reports/)' })
  parseIcs(v?: string): string | true {
    return v ?? true;
  }
  @Option({ flags: '--json', description: 'in kế hoạch dạng JSON' })
  parseJson(): boolean {
    return true;
  }
}
