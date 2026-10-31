import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Service, ServiceBindError, servicePool } from '@samsam/core/db';
import { approvalEnforced, type Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { jobRun } from '@samsam/core/ops/job-runs';
import { check as loaderGate } from '@samsam/core/ops/loader-gate';
import { cpSlice } from '@samsam/core/ops/py';
import { dbMsg, isDbError, withTx } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { DATA_DIR } from '@samsam/core/paths';
import { pyStrip } from '@samsam/core/security/py';
import pg from 'pg';
import {
  CHAT_CHANNELS,
  CONV_FILES,
  type ConvStats,
  channelOf,
  convKind,
  dedupKey,
  iterConvlog,
  parseTs,
  type Rec,
  SAMPLE_FLAGS,
} from '../sales_director/convlog.js';

// Port `ingest/lead_store.py` (WS2) — gom lead từ convlog (`data/conversations.jsonl` + `.1`) vào
// bảng `leads`.
//  - convlog là LOG xoay + purge 30 ngày, lead là fact suy ra một lần → insert-only `on conflict
//    (dedup_key) do nothing`, KHÔNG delete-by-source (entry convlog bị purge không kéo theo lead).
//  - File user-influenced → đọc BYTES + split `\n` tường minh, decode thay byte lỗi (dùng chung bản
//    đọc convlog của nhóm sales_director — `iterConvlog`, `channelOf`, `dedupKey`, `convKind`).
//  - Biên: file thiếu / 0-record / chỉ `_doc` / dòng JSON hỏng / không phải object / thiếu
//    question-ts-user_hash / ts sai ISO / không khớp intent → bỏ + đếm, exit 0, KHÔNG xóa leads có.
//  - docx P1: chỉ dòng `provenance: live` thành lead (mock/replay/thiếu provenance đếm riêng).
//  - `question`/`user_hash` đã che/băm ở convlog — bảng không lưu PII thêm; intent = keyword.
// Lệnh: `lead-store` (thay `python -m ingest.lead_store`) — login loader (`svc_loader`) + cổng tắt
// loader (`data/loader_gate.json`, tính năng sales-04.1) TRƯỚC khi đọc file; ghi 1 dòng `job_runs`.

export { CHAT_CHANNELS, CONV_FILES, channelOf, convKind, dedupKey, iterConvlog, SAMPLE_FLAGS };
export const CONNECT_TIMEOUT_S = 3;
// v5.1: route của câu trả lời đồng ý/rút đồng ý — không phải câu hỏi (KHÔNG gồm consent_required).
export const CONSENT_REPLY_ROUTES = [
  'consent_granted',
  'consent_withdrawn',
  'consent_withdrawn_fail',
];
export const LEAD_COLS = [
  'dedup_key',
  'ts',
  'channel',
  'user_hash',
  'question',
  'intent',
  'status',
  'source',
] as const;

// Intent thương mại — thứ tự là ưu tiên (khớp đầu thắng): "giá sỉ" → partner; "mua ở đâu" → order.
export const INTENTS: readonly [string, readonly string[]][] = [
  ['partner', ['đại lý', 'cộng tác', 'nhập hàng', 'sỉ', 'bán buôn', 'phân phối', 'số lượng lớn']],
  [
    'order',
    [
      'mua',
      'đặt hàng',
      'đặt mua',
      'đơn hàng',
      'ship',
      'giao hàng',
      'giao tận',
      'thanh toán',
      'chuyển khoản',
    ],
  ],
  ['price', ['giá', 'bao nhiêu', 'khuyến mãi', 'giảm giá', 'ưu đãi']],
  [
    'contact',
    [
      'showroom',
      'địa chỉ',
      'ở đâu',
      'văn phòng',
      'cửa hàng',
      'liên hệ',
      'tư vấn',
      'hotline',
      'điện thoại',
      'sđt',
    ],
  ],
];

export const INSERT_SQL =
  `insert into leads (${LEAD_COLS.join(', ')}) values (${LEAD_COLS.map((_, i) => `$${i + 1}`).join(', ')})` +
  ' on conflict (dedup_key) do nothing';

// Chống FP: "giá" trong cụm khác nghĩa — xóa SPAN cụm trước khi khớp key "giá" (không veto cả câu).
const PRICE_STOPS = ['đánh giá', 'định giá', 'giá trị'];
// "ở đâu" sau từ sinh học = hỏi phân bố cây — veto riêng key "ở đâu"; lười + chặn qua dấu câu cụm
// (chỉ nuốt span bio→'ở đâu' ĐẦU trong cùng cụm).
const WHERE_INFO_RE = /(?:mọc|trồng|phân bố|sinh sống)[^.?!,;]{0,60}?ở đâu/gu;

/** Intent thương mại theo keyword (khớp đầu theo thứ tự INTENTS); null = không phải lead. */
export function intentOf(question: string): string | null {
  const q = question.toLowerCase();
  let qPrice = q;
  for (const s of PRICE_STOPS) qPrice = qPrice.replaceAll(s, ' ');
  const qContact = q.replace(WHERE_INFO_RE, ' ');
  for (const [intent, keys] of INTENTS) {
    for (const k of keys) {
      if (!(k === 'giá' ? qPrice : q).includes(k)) continue;
      if (k === 'ở đâu' && !qContact.includes('ở đâu')) continue;
      return intent;
    }
  }
  return null;
}

export type LeadRow = {
  dedup_key: string;
  ts: Date;
  channel: string;
  user_hash: string;
  question: string;
  intent: string;
  status: 'new';
  source: 'conversations.jsonl';
};

const blank = (v: unknown) => typeof v !== 'string' || !pyStrip(v);

/** convlog record → [row, null] | [null, lý do]: 'fields' (thiếu/trống question·ts·user_hash),
 * 'ts' (sai ISO), 'intent' (không khớp intent thương mại). */
export function leadRow(rec: Rec): [LeadRow, null] | [null, string] {
  const tsValue = rec.ts;
  if (
    blank(rec.question) ||
    blank(rec.user_hash) ||
    tsValue === undefined ||
    tsValue === null ||
    tsValue === ''
  ) {
    return [null, 'fields'];
  }
  if (typeof tsValue !== 'string') return [null, 'ts'];
  const q = pyStrip(rec.question as string);
  const tsRaw = pyStrip(tsValue);
  if (!tsRaw) return [null, 'fields'];
  const ts = parseTs(tsRaw);
  if (ts === null) return [null, 'ts'];
  const intent = intentOf(q);
  if (intent === null) return [null, 'intent'];
  return [
    {
      dedup_key: dedupKey(rec),
      ts,
      channel: channelOf(rec),
      user_hash: pyStrip(rec.user_hash as string),
      question: cpSlice(q, 0, 500),
      intent,
      status: 'new',
      source: 'conversations.jsonl',
    },
    null,
  ];
}

export type HarvestStats = ConvStats & { missing: string[] };

/** Đọc convlog (+.1) → [rows đã dedup trong-file, stats]. Thiếu/0-record → rỗng, không ném. */
export function harvest(dataDir: string = DATA_DIR): [LeadRow[], HarvestStats] {
  const counts: ConvStats = {
    corrupt: 0,
    doc: 0,
    io_error: 0,
    fields: 0,
    ts: 0,
    intent: 0,
    dup_in_file: 0,
  };
  const missing: string[] = [];
  let records = 0;
  const rows: LeadRow[] = [];
  const seen = new Set<string>();
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    for (const rec of iterConvlog(path, counts, true)) {
      records++;
      const [row, why] = leadRow(rec);
      if (row === null) {
        counts[why] = (counts[why] ?? 0) + 1;
        continue;
      }
      if (seen.has(row.dedup_key)) {
        counts.dup_in_file = (counts.dup_in_file ?? 0) + 1;
        continue;
      }
      seen.add(row.dedup_key);
      rows.push(row);
    }
  }
  return [rows, Object.assign(counts, { missing, records }) as HarvestStats];
}

/** insert từng dòng `on conflict (dedup_key) do nothing` (1 giao dịch) → {new, dup}. KHÔNG delete. */
export async function applyLeads(db: Db, rows: LeadRow[]): Promise<{ new: number; dup: number }> {
  return withTx(db, async (c) => {
    let n = 0;
    let dup = 0;
    for (const r of rows) {
      const res = await c.query(
        INSERT_SQL,
        LEAD_COLS.map((k) => r[k]),
      );
      if (res.rowCount) n++;
      else dup++;
    }
    return { new: n, dup };
  });
}

export type LeadStats = {
  total: number;
  new_7d: number;
  by_channel: Record<string, number>;
  by_intent: Record<string, number>;
  by_status: Record<string, number>;
  recent: [Date, string, string, string, string, string][];
};

/** Số liệu dashboard từ bảng `leads`; null khi không có kết nối / DB lỗi / thiếu bảng. */
export async function leadStats(db: Db | null): Promise<LeadStats | null> {
  if (db === null) return null;
  const count = async (sql: string) => Number((await db.query(sql)).rows[0]?.count);
  const groups = async (col: string) =>
    Object.fromEntries(
      (await db.query(`select ${col} as k, count(*) from leads group by ${col}`)).rows.map((r) => [
        r.k,
        Number(r.count),
      ]),
    ) as Record<string, number>;
  try {
    const total = await count('select count(*) from leads');
    const new7d = await count("select count(*) from leads where ts > now() - interval '7 days'");
    const byChannel = await groups('channel');
    const byIntent = await groups('intent');
    const byStatus = await groups('status');
    const recent = (
      await db.query({
        text: 'select ts, channel, intent, question, user_hash, status from leads order by ts desc limit 20',
        rowMode: 'array',
      })
    ).rows as LeadStats['recent'];
    return {
      total,
      new_7d: new7d,
      by_channel: byChannel,
      by_intent: byIntent,
      by_status: byStatus,
      recent,
    };
  } catch {
    return null;
  }
}

export type ChannelStats = {
  total: number;
  answered: number;
  by_channel: Record<string, number>;
  skipped: number;
};

/** Số liệu kênh từ convlog (file — hiện được cả khi DB chưa nạp). Bỏ câu trả lời đồng ý. */
export function convlogStats(dataDir: string = DATA_DIR): ChannelStats {
  const s: ChannelStats = {
    total: 0,
    answered: 0,
    by_channel: { zalo: 0, messenger: 0, streamlit: 0 },
    skipped: 0,
  };
  const tmp: ConvStats = { corrupt: 0, doc: 0, io_error: 0 };
  for (const name of CONV_FILES) {
    const path = join(dataDir, name);
    if (!existsSync(path)) continue;
    for (const rec of iterConvlog(path, tmp)) {
      if (typeof rec.route === 'string' && CONSENT_REPLY_ROUTES.includes(rec.route)) continue;
      s.total++;
      if (rec.answered === true) s.answered++;
      const ch = channelOf(rec);
      s.by_channel[ch] = (s.by_channel[ch] ?? 0) + 1;
    }
  }
  s.skipped = (tmp.corrupt ?? 0) + (tmp.doc ?? 0) + (tmp.io_error ?? 0);
  return s;
}

// ===================================================================== CLI `lead-store`

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export type LeadStoreDeps = {
  env?: Env;
  io?: Io;
  dataDir?: string;
  gateFile?: string;
  /** Python `auth.bind_service('loader')` — mặc định `servicePool`. */
  service?: (svc: Service, env: Env) => Promise<pg.Pool>;
  /** Nối cổng triển khai trên Pool của lệnh (mặc định `wireCore`). */
  wire?: (db: Db | null) => void;
  jobRun?: typeof jobRun;
};

// psycopg.OperationalError: lỗi kết nối (không SQLSTATE) hoặc lớp 08 (connection exception).
const isConnError = (e: unknown) =>
  !(e instanceof pg.DatabaseError) || String((e as { code?: unknown }).code).startsWith('08');

/** `python -m ingest.lead_store` (không bọc job_run) → exit code. 0 ok/không có lead · 1 lỗi DB ·
 * 2 login loader bị từ chối / cổng loader chặn. */
export async function leadStoreMain(d: LeadStoreDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  let pool: pg.Pool | null = null;
  try {
    pool = await (d.service ?? servicePool)('loader', env);
  } catch (e) {
    // Python bind_service: dev thiếu biến → giữ nguyên; chế độ thực → từ chối.
    if (!(e instanceof ServiceBindError)) throw e;
    if (approvalEnforced(env)) {
      io.out(`[err] ${e.message}`);
      return 2;
    }
  }
  try {
    // Python loader_gate tự mở kết nối: host chết = không có kết nối → chặn (không rơi về chạy thử).
    if (pool !== null) {
      try {
        await pool.query('select 1');
      } catch {
        await pool.end().catch(() => {});
        pool = null;
      }
    }
    (d.wire ?? ((db: Db | null) => void wireCore(db)))(pool);
    const why = await loaderGate('lead_store', pool, d.gateFile, io.out);
    if (why) {
      io.out(`[rollout] ${why}`);
      return 2;
    }
    const [rows, st] = harvest(d.dataDir);
    io.out(
      `[scan] convlog: ${st.records} record — lead=${rows.length}, intent-miss=${st.intent}, ` +
        `fields-miss=${st.fields}, ts-bad=${st.ts}, corrupt=${st.corrupt}, _doc=${st.doc}, ` +
        `io-error=${st.io_error}, dup-in-file=${st.dup_in_file}` +
        (st.missing.length ? ` — thiếu [${st.missing.map((m) => `'${m}'`).join(', ')}]` : ''),
    );
    if (!rows.length) {
      io.out(
        '[warn] không có lead nào suy ra được — leads đang có giữ nguyên (insert-only, không xóa)',
      );
      return 0;
    }
    if (pool === null) {
      io.out('[err] thiếu DATABASE_URL trong .env');
      return 1;
    }
    let res: { new: number; dup: number };
    let total: number;
    let byChannel: { channel: string; count: string }[];
    try {
      res = await applyLeads(pool, rows);
      total = Number((await pool.query('select count(*) from leads')).rows[0]?.count);
      byChannel = (
        await pool.query('select channel, count(*) from leads group by channel order by channel')
      ).rows;
    } catch (e) {
      if (!isDbError(e)) throw e;
      if ((e as { code?: string }).code === '42P01') {
        io.out(
          `[err] thiếu bảng leads — chạy \`python scripts/apply_schema.py\` trước: ${dbMsg(e)}`,
        );
      } else if (isConnError(e)) io.out(`[err] không kết nối được Postgres: ${dbMsg(e)}`);
      else io.out(`[err] Postgres từ chối nạp leads: ${dbMsg(e)}`);
      return 1;
    }
    io.out(
      `[done] mới=${res.new} trùng=${res.dup} — total leads=${total} ` +
        `(${byChannel.map((r) => `${r.channel}=${r.count}`).join(', ')})`,
    );
    return 0;
  } finally {
    await pool?.end().catch(() => {});
  }
}

/** Python `__main__`: ghi lần chạy vào `job_runs` (bản tin sức khỏe F17.2), exit code giữ nguyên. */
export async function leadStoreJob(d: LeadStoreDeps = {}): Promise<number> {
  return (d.jobRun ?? jobRun)(
    'ingest.lead_store',
    async (run) => {
      const rc = await leadStoreMain(d);
      run.ok = rc === 0;
      return rc;
    },
    d.env ?? process.env,
  );
}
