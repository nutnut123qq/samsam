import { createHash } from 'node:crypto';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  DirectorConfigError,
  loadConfig as directorConfig,
  submit as directorSubmit,
} from '@samsam/core/ops/director';
import { vnFormat } from '@samsam/core/ops/period';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { blocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { maskPii } from '@samsam/core/security/pii';
import { pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import { IntelAlertConfigError, loadRules, match, type Rules } from './intel-alert.js';
import { type DbLease, type Io, pyIntList, STD_IO } from './io.js';

// Port `pipelines/legal_updates.py` (v13.8 C09) — cập nhật văn bản pháp luật mới → hàng duyệt Pháp
// chế (PL01 "Nhân sự: … cập nhật văn bản pháp luật mới (P2)", tính năng legal_hr-07).
// NỐI PC-A8, không viết luật mới:
// - Nguồn: `intel_items` từ nguồn văn bản tầng A (`legal_sources` của data/intel_alert_rules.json).
//   Chọn tin bằng CHÍNH luật `legal_doc` của `intel_alert.match`. Cảnh báo đỏ PC-A8 giữ nguyên;
//   module này thêm bước NGƯỜI KIỂM.
// - Mỗi tin khớp, thu trong LOOKBACK_DAYS ngày, CHƯA từng vào hàng (MỌI trạng thái, khóa
//   `legal_doc_review` + `intel:<id>`) → 1 mục khối legal_hr qua `director.submit` (SLA/risk theo
//   data/directors/legal_hr.json; tính năng `tat` → không sinh). Trần `--limit` mỗi lần (tin cũ
//   trước); dư → lần chạy sau.
// - Payload TEMPLATE tất định: nguồn, link, ngày đăng/thu, sha256 tiêu đề, việc Pháp chế cần làm.
//   Tiêu đề văn bản nằm ở `title` của mục (đã che PII) — tiêu đề chính thức có thể chứa chữ
//   guardrail chặn ("thuốc"...) làm mục không duyệt được nếu đặt trong payload. KHÔNG diễn giải,
//   KHÔNG tự đổi guardrail/từ cấm/claim. Không mạng, không LLM, không gửi ai.

export const BLOCK = 'legal_hr';
export const OBJECT_TYPE = 'legal_doc_review';
export const CREATED_BY = 'agent:legal_updates';
export const FEATURE = 'legal_hr-07';
export const LOOKBACK_DAYS = 30;
export const LIMIT = 20;
export const TITLE_MAX = 150;

const SQL =
  'select i.id, i.title, i.snippet, i.topics, i.flags, i.url, i.source, i.published_at, i.fetched_at' +
  ' from intel_items i where i.source = any($1) and i.fetched_at >= $2' +
  ' and not exists (select 1 from approval_queue q where' +
  " q.object_type = $3 and q.object_id = 'intel:' || i.id::text)" +
  ' order by i.fetched_at, i.id';

export type LegalItem = {
  id: number | string;
  title: string | null;
  snippet?: string | null;
  topics?: string[] | null;
  flags?: string[] | null;
  url: string | null;
  source: string | null;
  published_at?: Date | null;
  fetched_at?: Date | null;
};

const day = (ts: Date | null | undefined): string => (ts ? vnFormat(ts, '%Y-%m-%d') : 'chưa rõ');

/** Template tất định — không diễn giải văn bản. */
export function payload(item: LegalItem): string {
  const tSha = createHash('sha256')
    .update(item.title || '', 'utf8')
    .digest('hex');
  return (
    '# Văn bản pháp luật mới — chờ Pháp chế kiểm\n\n' +
    `intel_item: ${pyStr(item.id)}\n` +
    `Nguồn: ${pyStr(item.source)} (tầng A, nguồn chính thức)\n` +
    `Link: ${pyStr(item.url)}\n` +
    `Ngày đăng: ${day(item.published_at)} · ngày thu: ${day(item.fetched_at)}\n` +
    `sha256 tiêu đề: ${tSha}\n\n` +
    'Pháp chế đọc bản gốc tại link và ghi kết luận khi duyệt: (a) không ảnh hưởng; (b) cần cập nhật luật kiểm duyệt/claim/hồ sơ — thay đổi đó làm qua quy trình riêng có người duyệt.\n' +
    'Agent KHÔNG diễn giải văn bản, KHÔNG tự đổi luật kiểm duyệt.\n'
  );
}

export async function candidates(db: Db, now: Date, rules?: Rules): Promise<LegalItem[]> {
  const r = rules ?? loadRules();
  // Python sorted(): theo code point (id nguồn là ASCII [a-z0-9_-]).
  const srcs = [...r.legal_sources].sort();
  const { rows } = await db.query(SQL, [
    srcs,
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
    OBJECT_TYPE,
  ]);
  return (rows as LegalItem[])
    .map((x) => ({ ...x, id: Number(x.id) }))
    .filter((it) => match(it, r).includes('legal_doc'));
}

export type SubmitStats = { found: number; queued: number[]; left: number };

export async function submit(
  db: Db,
  now: Date,
  o: { rules?: Rules; limit?: number; dryRun?: boolean } = {},
): Promise<SubmitStats> {
  const limit = o.limit ?? LIMIT;
  const items = await candidates(db, now, o.rules);
  const st: SubmitStats = {
    found: items.length,
    queued: [],
    left: Math.max(0, items.length - limit),
  };
  if (o.dryRun) return st;
  const cfg = directorConfig(BLOCK);
  for (const it of items.slice(0, limit)) {
    const title = `Văn bản mới: ${oneline(maskPii(it.title || ''), TITLE_MAX)}`;
    const qid = await directorSubmit(db, {
      block: BLOCK,
      objectType: OBJECT_TYPE,
      objectId: `intel:${it.id}`,
      title,
      payload: payload(it),
      createdBy: CREATED_BY,
      cfg,
    });
    st.queued.push(Number(qid));
  }
  return st;
}

// ---------------------------------------------------------------- CLI

export type LegalUpdatesOpts = { submit?: boolean; limit?: string; dryRun?: boolean };
export type LegalUpdatesDeps = {
  io?: Io;
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  wire?: (db: Db) => unknown;
  clock?: () => Date;
  rulesFile?: string;
};

/** `python -m pipelines.legal_updates --submit [--limit N] [--dry-run]` → exit code.
 * Exit: 0 ok · 1 luật hỏng / DB lỗi · 2 tham số sai / DB down / cổng triển khai TẮT. */
export async function legalUpdatesMain(
  o: LegalUpdatesOpts,
  d: LegalUpdatesDeps = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string) => {
    io.err(`legal_updates: error: ${m}`);
    return 2;
  };
  if (!o.submit) return usage('the following arguments are required: --submit');
  let limit = LIMIT;
  if (o.limit !== undefined) {
    const t = pyStrip(String(o.limit));
    if (!/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(t)) {
      return usage(`argument --limit: invalid int value: ${pyRepr(String(o.limit))}`);
    }
    limit = Number(t.replaceAll('_', ''));
  }
  if (!(limit >= 1 && limit <= 200)) return usage('--limit 1..200');
  // r19 (r12 RB): tắt → không đọc tin/đẩy mục, cả --dry-run.
  const why = await blocked(null, 'văn bản pháp luật mới', FEATURE);
  if (why) return sayBlocked(why, io.out);
  let rules: Rules;
  try {
    rules = loadRules(d.rulesFile);
  } catch (e) {
    if (!(e instanceof IntelAlertConfigError)) throw e;
    io.err(`[err] ${e.message}`);
    return 1;
  }
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[err] DB không kết nối được');
    return 2;
  }
  let st: SubmitStats;
  try {
    (d.wire ?? ((x: Db) => wireCore(x)))(lease.db);
    st = await submit(lease.db, (d.clock ?? (() => new Date()))(), {
      rules,
      limit,
      dryRun: Boolean(o.dryRun),
    });
  } catch (e) {
    // cấu hình/tắt: Python bắt (ValueError, DirectorConfigError) — RolloutBlocked là ValueError
    if (e instanceof RangeError || e instanceof DirectorConfigError) {
      io.err(`[err] ${e.message}`);
      return 1;
    }
    if (!isDbError(e)) throw e;
    io.err(`[err] DB: ${oneline(dbMsg(e) || e.name, 200)}`);
    return 1;
  } finally {
    await lease.release().catch(() => {});
  }
  const tag = o.dryRun ? ' (dry-run)' : '';
  io.out(
    `[ok]${tag} văn bản khớp chưa vào hàng: ${st.found} · đã đẩy: ${st.queued.length} ${pyIntList(st.queued)} · còn lại lần sau: ${st.left}`,
  );
  return 0;
}
