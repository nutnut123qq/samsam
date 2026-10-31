import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import pg from 'pg';
import { pyStrip } from '../env.js';
import type { Db } from '../ops/deps.js';
import { parseShift, type Shift, utcMs, vnDate, weekday } from '../ops/period.js';
import { foldPrefix, isPlainObject } from '../ops/py.js';
import { isDbError, pgErrName } from '../ops/tx.js';
import { dataPath } from '../paths.js';

// Port bộ đếm đầu ra của `pipelines/rollout.py` (v13.3 F04 … v15 fix P8.7c): mỗi nguồn
// `output_sources` → câu SQL trả từng đầu ra DISTINCT (khóa có tiền tố nguồn, thời điểm tạo đầu
// tiên trong cửa sổ, có NGƯỜI duyệt từng mục?, duyệt/dùng thiếu người?, sha phiên bản). Câu SQL
// giữ NGUYÊN văn bản Python (placeholder `%s`, `%%`) vì `count_spec` ghi vào DB để function
// `rollout_transition_human` TỰ đếm lại — lệch 1 ký tự là `--seed` ghi đè bộ đếm khác Python.

export type Source = Record<string, unknown>;
/** Một dòng danh mục ĐÃ kiểm (`loadFeatures`). */
export type Feature = {
  id: string;
  phong_ban: string;
  pham_vi: string;
  ten: string;
  giai_doan: string;
  code_status: string;
  acceptance_status: string;
  modules: string[];
  agent_ids: string[];
  output_sources: Source[];
  blocker: string | null;
  nhom_goc?: string;
  thay_the?: string[];
} & Record<string, unknown>;

/** Đường dẫn/cờ module (Python: biến module mà test monkeypatch). Chỉ test đổi. */
export const settings = {
  featuresFile: dataPath('contract_features.json'),
  configFile: dataPath('rollout_config.json'),
  dataDir: dataPath(),
  /** CHỈ test: ép giai đoạn (Python `_FORCE_MODE`). Production luôn null — không env/cờ nào đổi. */
  forceMode: null as string | null,
  env: process.env as Record<string, string | undefined>,
};

/** Python `sorted()` cho chuỗi (theo code point, không theo UTF-16). */
export const pySorted = (xs: Iterable<string>): string[] =>
  [...xs].sort((a, b) => {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
      if (d) return d;
    }
    return x.length - y.length;
  });

/** Python `json.dumps(v, ensure_ascii=False[, sort_keys=True])` (dấu phân cách ', ' và ': ').
 * shortcut: số thực theo `String()` của JS (1e16 ≠ '1e+16' Python) — chỉ ảnh hưởng sha bản ghi
 * nguồn file (DB không duyệt được nguồn file); nâng khi nguồn file được duyệt qua sổ. */
export function pyDumps(v: unknown, sortKeys = false): string {
  if (Array.isArray(v)) return `[${v.map((x) => pyDumps(x, sortKeys)).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    return `{${(sortKeys ? pySorted(keys) : keys)
      .map((k) => `${JSON.stringify(k)}: ${pyDumps((v as Record<string, unknown>)[k], sortKeys)}`)
      .join(', ')}}`;
  }
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}

/** Tên người thật: không rỗng, không tiền tố agent:/system:. */
export function isHuman(name: unknown): boolean {
  const s = typeof name === 'string' ? foldPrefix(pyStrip(name)) : '';
  return s !== '' && !s.startsWith('agent:') && !s.startsWith('system:');
}

// ------------------------------------------------------------ DB tiện ích

/**
 * Python `with conn.transaction():` trên conn chia sẻ = SAVEPOINT: lỗi câu đọc không làm hỏng tx
 * của caller. Pool → chạy thẳng (mỗi câu tự commit). Client ngoài tx → `savepoint` báo 25P01 →
 * chạy thẳng (không có tx nào để hỏng).
 */
export async function sp<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (db instanceof pg.Pool) return fn();
  try {
    await db.query('savepoint rollout_sp');
  } catch (e) {
    if ((e as { code?: string }).code === '25P01') return fn();
    throw e;
  }
  try {
    const r = await fn();
    await db.query('release savepoint rollout_sp');
    return r;
  } catch (e) {
    await db.query('rollback to savepoint rollout_sp');
    await db.query('release savepoint rollout_sp');
    throw e;
  }
}

/** Python `%s`/`%%` → `$n`/`%` của pg. */
export function toPg(sql: string, params: readonly unknown[]): { text: string; values: unknown[] } {
  let i = 0;
  const text = sql.replace(/%%|%s/g, (m) => (m === '%%' ? '%' : `$${++i}`));
  if (i !== params.length) throw new Error('số tham số câu SQL lệch');
  return { text, values: [...params] };
}

export async function rowsOf(
  db: Db,
  sql: string,
  params: readonly unknown[],
): Promise<unknown[][]> {
  const r = await db.query({ ...toPg(sql, params), rowMode: 'array' });
  return r.rows as unknown[][];
}

/** Tên lớp lỗi psycopg — bản chuẩn ở `ops/tx` (giữ export cho caller cũ). */
export { pgErrName };

// ------------------------------------------------------------ bộ đếm SQL

// Người duyệt thật: không rỗng, không 'agent:'/'system:' (cùng luật check_by).
const h = (c: string): string =>
  `(btrim(coalesce(${c}, '')) <> '' and lower(btrim(${c})) not like 'agent:%%' and lower(btrim(${c})) not like 'system:%%')`;
// Quy ước tên CŨ (trước cờ `is_sample` v14.3): chỉ LOẠI THÊM — không bao giờ biến mẫu thành thật.
export const SAMPLE_ID_RE = '(^|[^a-z0-9])(sample|mau)([^a-z0-9]|$)';

type Win = unknown; // Date (chạy) | WIN_A/WIN_B (dựng count_spec)
type Counter = [string, (s: Source, a: Win, b: Win) => unknown[]];
const COUNTERS: Record<string, Counter> = {
  approval_queue: [
    "select 'aq:' || block || '/' || object_type || '/' || object_id," +
      ' min(created_at),' +
      " bool_or(status = 'approved' and lane = 'per_item' and " +
      h('decided_by') +
      '),' +
      " bool_or(status = 'approved' and not (lane is not distinct from" +
      " 'per_item' and " +
      h('decided_by') +
      ')), null::text' +
      ' from approval_queue where block = %s and object_type = %s' +
      ' and (%s::text is null or created_by = %s)' +
      ' and created_at >= %s and created_at <= %s' +
      " and coalesce(guardrail->>'ok', '') = 'true' and not is_sample" +
      " and object_id !~* %s and title not like '%%MẪU%%'" +
      ' group by block, object_type, object_id',
    (s, a, b) => [
      s.block,
      s.object_type,
      s.created_by ?? null,
      s.created_by ?? null,
      a,
      b,
      SAMPLE_ID_RE,
    ],
  ],
  content_drafts: [
    "select 'cd:' || md5(text), min(created_at)," +
      " bool_or(status = 'approved' and " +
      h('reviewer') +
      "), bool_or(status = 'approved' and not " +
      h('reviewer') +
      '),' +
      ' null::text from content_drafts where created_by = %s and content_type = %s' +
      ' and created_at >= %s and created_at <= %s' +
      " and coalesce(guardrail->>'ok', '') = 'true'" +
      " and coalesce(source, '') not ilike 'sample%%'" +
      " and brief not like '%%MẪU%%' group by md5(text)",
    (s, a, b) => [s.created_by, s.content_type, a, b],
  ],
};

/** Bộ đếm bảng riêng (v14.3): `ts` thời điểm tạo, `key` khóa tự nhiên DISTINCT, `sample` điều kiện
 * MẪU theo cột provenance, `human`/`unapp` = NGƯỜI quyết từng mục / quyết thiếu người (không có
 * = bảng không có bước người → cần sổ `output_reviews`), `where` lọc cố định, `filters` khóa danh
 * mục → điều kiện. */
export type TableSpec = {
  ts: string;
  key: string;
  where?: string;
  sample?: string;
  human?: string;
  unapp?: string;
  join?: string;
  sha?: string;
  nosample?: string;
  filters?: Record<string, string>;
};
const SRC_SAMPLE = "coalesce(t.source, '') ilike 'sample%%'";
// v15.2 (P8.7): sha256 nội dung các dòng của 1 khóa (dòng đổi → sha đổi → duyệt cũ hết hiệu lực).
const ROW_SHA =
  "encode(sha256(convert_to(string_agg(row_to_json(t)::text, E'\\n' order by row_to_json(t)::text), 'UTF8')), 'hex')";
const LOT_SAMPLE =
  "exists (select 1 from production_lots l where l.lot_code = t.lot_code and l.source = 'sample')";
const DRAFT_JOIN = 'join content_drafts d on d.id = t.draft_id';
const DRAFT_OK = "coalesce(d.guardrail->>'ok', '') = 'true'";
export const TABLES: Record<string, TableSpec> = {
  decision_log: {
    ts: 't.recorded_at',
    key: "'dl:' || t.id",
    where: "t.entry_kind = 'quyet_dinh'",
    human: h('t.recorded_by'),
    nosample: 'NGƯỜI ghi (--by, CHECK chặn agent/system)',
  },
  audit_runs: {
    ts: 't.created_at',
    key: "'ar:' || t.kind || '/' || t.period_label || '/' || t.report_sha256",
    sample: 't.is_sample',
    filters: { kind: 't.kind = %s' },
  },
  leads: {
    ts: 't.created_at',
    key: "'ld:' || t.dedup_key",
    human: h('t.assigned_by'),
    nosample: 'gom từ convlog thật / nhập tay (source conversations.jsonl|manual)',
  },
  consents: {
    ts: 't.ts',
    key: "'cn:' || t.id",
    human: h('t.recorded_by'),
    nosample: 'NGƯỜI ghi bằng chứng đồng ý (evidence_ref)',
    // docx P2 (sales-04.2): chỉ đồng ý chuyển ĐẠI LÝ đã cấp.
    filters: { purpose: 't.purpose = %s', granted: 't.granted::text = %s' },
  },
  // docx P2 (sales-04.2): lần chuyển = nhật ký `crm_handoff` NGƯỜI ghi qua `crm_handoff_human`.
  agent_action_log: {
    ts: 't.ts',
    key: "'al:' || t.action || '/' || t.object_id || '/' || coalesce(t.detail->>'dealer', '')",
    human: h('t.actor'),
    nosample: 'NGƯỜI chuyển lead đã đồng ý (crm_handoff_human)',
    // r12 L1: lần chuyển khi khách CHƯA đồng ý dai_ly không phải đầu ra.
    where: "(t.action <> 'crm_handoff' or t.detail->>'pii_included' = 'true')",
    filters: { action: 't.action = %s' },
  },
  image_assets: {
    ts: 't.created_at',
    key: "'cd:' || md5(d.text)",
    join: DRAFT_JOIN,
    where: DRAFT_OK,
    sample: "coalesce(d.source, '') ilike 'sample%%'",
    human: `d.status = 'approved' and ${h('d.reviewer')}`,
    unapp: `d.status = 'approved' and not ${h('d.reviewer')}`,
  },
  video_assets: {
    ts: 't.created_at',
    key: "'cd:' || md5(d.text)",
    join: DRAFT_JOIN,
    where: DRAFT_OK,
    sample: "coalesce(d.source, '') ilike 'sample%%'",
    human: `d.status = 'approved' and ${h('d.reviewer')}`,
    unapp: `d.status = 'approved' and not ${h('d.reviewer')}`,
  },
  channel_snapshots: {
    ts: 't.captured_at',
    key: "'cs:' || t.channel || '/' || t.metric_id || '/' || t.period_kind || '/' || t.period_start || '/' || t.source",
    sample: "coalesce(t.source_ref, '') ilike 'sample:%%'",
    human: h('t.captured_by'),
  },
  red_alerts: {
    ts: 't.ts',
    key: "'ra:' || coalesce(t.detail->>'intel_item_id', t.id::text)",
    where: "not (t.detail ? 'escalation_of')",
    human: `exists (select 1 from red_alert_acks k where k.alert_id = t.id and ${h('k.acked_by')})`,
    nosample: 'cảnh báo sinh từ tin thật đã thu',
    // Đợt hoàn thiện 22/10: 1 cảnh báo khớp nhiều luật chỉ thuộc MỤC của luật ĐẦU.
    filters: {
      source_agent: 't.source_agent = %s',
      rules_any: "t.detail->'rules'->>0 = any(%s::text[])",
    },
  },
  // marketing-05.1: 1 bình luận/tin kênh sở hữu đã gắn nhãn = 1 đầu ra (khóa theo id dòng).
  social_mentions: {
    ts: 'i.imported_at',
    key: "'sm:' || t.id",
    join: 'join intel_imports i on i.id = t.import_id',
    nosample: 'file comment/inbox kênh sở hữu do người xuất tay',
  },
  sim_runs: { ts: 't.created_at', key: "'sr:' || t.run_id", sample: 't.dry_run' },
  recon_results: {
    ts: 't.reconciled_at',
    key: "'rr:' || t.settlement_row_id",
    nosample: 'file quyết toán thật do kế toán xuất (settlement_rows không có cột mẫu)',
  },
  affiliate_attributions: {
    ts: 't.updated_at',
    key: "'aa:' || t.channel || '/' || t.order_id_hash || '/' || t.line_key",
    nosample: 'đơn sàn nạp từ file xuất Seller Center',
  },
  allocation_proposals: {
    ts: 't.created_at',
    key: "'ap:' || t.cutoff_id || '/' || t.sku_key || '/' || t.channel",
    sample: 't.is_sample',
    human: `t.status = 'approved' and ${h('t.decided_by')}`,
    unapp: `t.status = 'approved' and not ${h('t.decided_by')}`,
  },
  golden_discrepancies: {
    ts: 't.created_at',
    key: "'gd:' || t.id",
    human: `t.status = 'resolved' and ${h('t.resolved_by')}`,
    unapp: `t.status = 'resolved' and not ${h('t.resolved_by')}`,
    nosample: 'so golden master với dữ liệu sản phẩm đã nạp',
  },
  production_lots: {
    ts: 't.created_at',
    key: "'pl:' || t.lot_code",
    sample: "t.source = 'sample'",
    human: `t.intake_status = 'passed' and ${h('t.checked_by')}`,
    unapp: `t.intake_status = 'passed' and not ${h('t.checked_by')}`,
  },
  plot_logs: {
    ts: 't.created_at',
    key: "'lg:' || t.id",
    sample: SRC_SAMPLE,
    human: h('t.author'),
    filters: { source: 't.source = %s' },
  },
  // farming-02: 1 khoảnh × 1 đợt bỏ trống = 1 lần nhắc; NGƯỜI = người đánh dấu đã nhắc.
  garden_reminders: {
    ts: 't.created_at',
    key: "'gr:' || t.plot_id || '/' || t.dot_key",
    sample: 't.is_sample',
    human: `t.reminded_at is not null and ${h('t.reminded_by')}`,
  },
  // farming-04: 1 tư liệu × 1 lần NGƯỜI cấp cho Marketing.
  garden_media_releases: {
    ts: 't.at',
    key: "'gmr:' || t.sha256 || '/' || t.id",
    human: `t.action = 'cap' and ${h('t.by_person')}`,
    nosample: 'người khối farming cấp tư liệu đã gỡ GPS cho Marketing',
    filters: { action: 't.action = %s' },
  },
  garden_voice_drafts: {
    ts: 't.received_at',
    key: "'gv:' || t.sha256",
    human: `t.status = 'da_chep_loi' and ${h('t.closed_by')}`,
    nosample: 'ghi âm nhân viên gửi qua Zalo',
  },
  lot_origins: {
    ts: 't.linked_at',
    key: "'lo:' || t.lot_code || '/' || t.plot_log_id",
    sample: LOT_SAMPLE,
    human: h('t.linked_by'),
    unapp: `not ${h('t.linked_by')}`,
  },
  qr_codes: {
    ts: 't.issued_at',
    key: "'qr:' || t.code",
    sample: LOT_SAMPLE,
    human: h('t.issued_by'),
    unapp: `not ${h('t.issued_by')}`,
  },
  garden_media: {
    ts: 't.created_at',
    key: "'gm:' || t.sha256",
    human: h('t.author'),
    nosample: 'ảnh/video nhân viên nạp (gỡ EXIF), không có lô mẫu',
  },
  documents: {
    ts: 't.created_at',
    key: "'dc:' || t.sha256",
    human: `t.status = 'verified' and ${h('t.verified_by')}`,
    unapp: `t.status = 'verified' and not ${h('t.verified_by')}`,
    nosample: 'bản scan/PDF gốc do người đưa vào thư mục intake',
  },
  document_fields: {
    ts: 'd.created_at',
    key: "'df:' || t.sha256 || '/' || t.field",
    join: 'join documents d on d.sha256 = t.sha256',
    human: `t.verified and d.status = 'verified' and ${h('d.verified_by')}`,
    nosample: 'trích từ tài liệu gốc (documents)',
  },
  chunks: {
    ts: 't.ingested_at',
    key: "'ck:' || t.doc_id",
    nosample: 'KB công khai crawl từ site công ty',
  },
  chunks_internal: {
    ts: 't.ingested_at',
    key: "'ci:' || t.collection || '/' || t.doc_id",
    human: h('t.approved_by'),
    nosample: 'tài liệu nội bộ trưởng phòng duyệt (approved_by)',
  },
  market_snapshots: {
    ts: 't.imported_at',
    key: "'ms:' || t.file_sha256",
    nosample: 'file xuất Seller Center (bảng không có cột mẫu)',
  },
  eval_runs: {
    ts: 't.ts',
    key: "'ev:' || t.agent || '/' || t.commit_sha || '/' || coalesce(t.suite_sha256, '')",
    nosample: 'lần chạy bộ ca kiểm thử (không phải dữ liệu khách)',
  },
  anchor_batches: {
    ts: 't.created_at',
    key: "'ab:' || t.manifest_sha256",
    human: h('t.created_by'),
    nosample: '`anchor --build` loại sẵn lô/khoảnh mẫu khỏi lá',
  },
  revenue_quarters: {
    ts: 't.recorded_at',
    key: "'rq:' || t.quarter || '/' || t.report_sha256",
    human: h('t.recorded_by'),
    nosample: 'số quyết toán thật (rev_share không nhận file mẫu)',
  },
  feature_rollout_events: {
    // `seed` = vào sổ hàng loạt (1 lệnh → N dòng), không phải đầu ra.
    ts: 't.ts',
    key: "'fe:' || t.id",
    where: "t.kind <> 'seed'",
    human: h('t.by_person'),
    nosample: 'NGƯỜI ghi sổ triển khai',
  },
  san_suggestions: {
    ts: 't.created_at',
    key: "'ss:' || t.channel || '/' || t.msg_ref",
    where: 't.guardrail_ok',
    human: `exists (select 1 from san_suggestion_uses u where u.suggestion_id = t.id and ${h('u.used_by')})`,
    nosample: 'tin buyer thật MXH dán qua STDIN',
  },
  // v15 fix P8.7c + docx P0: bằng chứng đầu ra nguồn FILE do ĐƯỜNG DỊCH VỤ ghi vào DB (backup →
  // svc_backup; conversations → webhook svc_webhook). Phiên bản = bản ghi MỚI NHẤT của khóa; câu
  // bot gửi khách không có người duyệt từng mục → dùng thiếu người.
  file_output_evidence: {
    ts: 't.captured_at',
    key: 't.output_key',
    sample: 't.is_sample',
    unapp: "t.nguon = 'conversations'",
    sha: '(array_agg(t.content_sha256 order by t.captured_at desc, t.id desc))[1]',
    filters: { source: 't.nguon = %s' },
  },
};
// v15.2 (P8.7): cột 5 = sha256 phiên bản MỚI NHẤT của báo cáo.
const REPORT_SQL =
  "select 'rp:' || name, min(created_at), false, false," +
  ' (array_agg(sha256 order by created_at desc, id desc))[1]' +
  ' from report_outputs' +
  ' where feature_id = %s and left(name, length(%s)) = %s' +
  ' and created_at >= %s and created_at <= %s and not is_sample' +
  ' group by name';

/** SQL đếm 1 nguồn bảng riêng | null (bảng chưa có bộ đếm). */
export function tableSql(src: Source, a: Win, b: Win): [string, unknown[]] | null {
  const t = src.table as string;
  const spec = Object.hasOwn(TABLES, t) ? TABLES[t] : undefined;
  if (spec === undefined) return null;
  const conds = [`${spec.ts} >= %s`, `${spec.ts} <= %s`];
  const params: unknown[] = [a, b];
  if (spec.where) conds.push(`(${spec.where})`);
  if (spec.sample) conds.push(`not coalesce((${spec.sample}), false)`);
  for (const [k, cond] of Object.entries(spec.filters ?? {})) {
    if (k in src) {
      conds.push(cond);
      params.push(src[k]);
    }
  }
  const sql =
    `select ${spec.key}, min(${spec.ts}),` +
    ` bool_or(coalesce((${spec.human || 'false'}), false)),` +
    ` bool_or(coalesce((${spec.unapp || 'false'}), false)),` +
    ` ${spec.sha ?? ROW_SHA}` +
    ` from ${t} t ${spec.join ?? ''}` +
    ` where ${conds.join(' and ')} group by 1`;
  return [sql, params];
}

export function sourceSql(
  f: { id: string },
  s: Source,
  a: Win,
  b: Win,
): [string, unknown[]] | null {
  const t = s.table as string;
  const c = Object.hasOwn(COUNTERS, t) ? COUNTERS[t] : undefined;
  if (c !== undefined) return [c[0], c[1](s, a, b)];
  if ('report' in s) return [REPORT_SQL, [f.id, s.report, s.report, a, b]];
  if ('table' in s) return tableSql(s, a, b);
  return null; // `file`: đọc ở fileRows
}

// --- literal Postgres như `psycopg.sql.Literal(v).as_string()` (không kết nối)

const ARR_QUOTE = /[ \t\n\r\f\v{},"\\]|^$|^null$/i;

function quoteStr(s: string): string {
  const q = `'${s.replaceAll("'", "''")}'`;
  return s.includes('\\') ? ` E${q.replaceAll('\\', '\\\\')}` : q;
}

export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const els = v.map((x) => {
      const s = String(x);
      return ARR_QUOTE.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s;
    });
    return quoteStr(`{${els.join(',')}}`);
  }
  return quoteStr(String(v));
}

const WIN_A = Symbol('since');
const WIN_B = Symbol('now');

/** Vá review v15 (P8.7/P10.1): câu đếm 1 nguồn ở dạng DB tự chạy được — CHÍNH câu `sourceSql`,
 * cửa sổ thành `$1`/`$2`, tham số khác thành literal (`%%` → `%`). */
export function dbSql(f: { id: string }, s: Source): string | null {
  const q = sourceSql(f, s, WIN_A, WIN_B);
  if (q === null) return null;
  const ps = [...q[1]];
  let i = 0;
  const out = q[0].replace(/%%|%s/g, (m) => {
    if (m === '%%') return '%';
    if (i >= ps.length) throw new RangeError(`${f.id}: số tham số câu đếm lệch`);
    const p = ps[i++];
    return p === WIN_A ? '$1' : p === WIN_B ? '$2' : literal(p);
  });
  if (i !== ps.length) throw new RangeError(`${f.id}: số tham số câu đếm lệch`);
  return out;
}

export type CountSpec = {
  sql: { q: string; review: boolean }[];
  file: number;
  workdays: number[];
  holidays: string[];
};

/** Bộ đếm ghi vào sổ DB (`feature_rollout.count_spec`, đường OWNER `--seed`) để
 * `rollout_transition_human` TỰ đếm lại. Nguồn file (DB không đọc được) chỉ đếm số lượng. */
export function countSpec(f: { id: string; output_sources?: Source[] }, shift: unknown): CountSpec {
  const sh = parseShift(shift);
  const qs: { q: string; review: boolean }[] = [];
  let files = 0;
  for (const s of f.output_sources ?? []) {
    if ('file' in s) {
      files += Number(Object.hasOwn(FILES, s.file as string));
      continue;
    }
    const q = dbSql(f, s);
    if (q !== null) qs.push({ q, review: needsReview(s) });
  }
  return {
    sql: qs,
    file: files,
    workdays: [...sh.workdays].sort((x, y) => x - y),
    holidays: [...sh.holidays].sort(),
  };
}

/** v15.2 (P8.7): nguồn KHÔNG có bước người duyệt từng mục riêng → chỉ duyệt qua `output_reviews`. */
export function needsReview(s: Source): boolean {
  if ('report' in s) return true;
  if ('file' in s) {
    const f = s.file as string;
    return Object.hasOwn(FILES, f) && Boolean(FILES[f]?.review);
  }
  if (s.table === 'file_output_evidence') return s.source !== 'conversations';
  const t = s.table as string;
  const spec = Object.hasOwn(TABLES, t) ? TABLES[t] : undefined;
  return spec !== undefined && !spec.human;
}

export function srcLabel(s: Source): string {
  return Object.entries(s)
    .filter(([k]) => k !== 'rules_any')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

// ------------------------------------------------ v15.2 (P8.1) nguồn file

/** Nguồn file không đọc được (thiếu/chưa cấu hình/lỗi IO) → uncounted. */
export class Unreadable extends Error {}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?(?:([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,]\d{1,6})?)?)?$/;

/**
 * ISO 8601 có múi giờ ('Z' nhận) → Date | null (Python `datetime.fromisoformat` aware).
 * shortcut: chỉ dạng mở rộng `YYYY-MM-DD[T ]HH:MM[:SS[.f]]±HH[:]MM` (dạng ghi bởi isoformat của
 * Python); dạng rút gọn/tuần Python nhận thì TS coi là hỏng (ít đầu ra hơn = fail-closed).
 */
export function aware(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(pyStrip(v).replaceAll('Z', '+00:00'));
  if (!m?.[8]) return null;
  const [y, mo, d, hh, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as number[];
  const ss = Number(m[6] ?? 0);
  const ms = Math.floor(Number((m[7] ?? '0').padEnd(6, '0')) / 1000);
  const t = utcMs(y as number, (mo as number) - 1, d, hh, mi, ss, ms);
  const back = new Date(t);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== (mo as number) - 1 ||
    back.getUTCDate() !== d ||
    (hh as number) > 23 ||
    (mi as number) > 59 ||
    ss > 59
  ) {
    return null;
  }
  const oh = Number(m[9]);
  const om = Number(m[10]);
  if (oh > 23 || om > 59) return null;
  const off = (oh * 60 + om) * 60_000 + Number(m[11] ?? 0) * 1000;
  return new Date(t - (m[8] === '-' ? -off : off));
}

function recSha(rec: unknown): string {
  return createHash('sha256').update(pyDumps(rec, true), 'utf8').digest('hex');
}

// v15 fix P8.1: cờ mẫu trên dòng convlog — giá trị khác None/False (và 0: Python `in (None,
// False)` so bằng ==) → không bao giờ là đầu ra thật.
const CONV_SAMPLE_FLAGS = ['is_sample', 'dry_run', 'replay', 'mock', 'test'];
const falsyFlag = (v: unknown) => v === undefined || v === null || v === false || v === 0;

type RowHit = null | 'bad' | ['legacy', Date] | [string, Date];

/** convlog (sales-01) → đầu ra = câu bot ĐÃ GỬI khách thật (zalo/messenger, answered/sent/
 * guardrail đạt, có msg_id). Provenance BẮT BUỘC `live` (đặt từ nơi ghi); bản ghi cũ thiếu
 * provenance → ('legacy', ts) chỉ báo ở uncounted; ts hỏng của dòng thật → 'bad'. */
export function convRow(rec: Record<string, unknown>): RowHit {
  const ch = rec.channel;
  const mid = rec.msg_id;
  if (
    !(
      (ch === 'zalo' || ch === 'messenger') &&
      rec.answered === true &&
      rec.sent === true &&
      rec.guardrail_ok === true &&
      typeof mid === 'string' &&
      pyStrip(mid)
    )
  ) {
    return null;
  }
  if (!Object.hasOwn(rec, 'provenance')) {
    const ts = aware(rec.ts);
    return ts === null ? null : ['legacy', ts];
  }
  if (rec.provenance !== 'live' || CONV_SAMPLE_FLAGS.some((k) => !falsyFlag(rec[k]))) return null;
  const ts = aware(rec.ts);
  return ts === null ? 'bad' : [`cv:${ch}/${pyStrip(mid)}`, ts];
}

const DUMP_RE = /^[A-Za-z0-9_.-]+_\p{Nd}{8}_\p{Nd}{6}_vn\.dump(\.enc)?$/u;

/** backup_runs (data_platform-07.2) → lần backup `ok` có dump đúng khuôn tên + sha256. */
export function backupRow(rec: Record<string, unknown>): RowHit {
  const sha = rec.sha256;
  const fn = rec.file;
  // Server đích là Linux: `Path(fn).name` tách theo '/'.
  if (
    !(
      rec.status === 'ok' &&
      typeof sha === 'string' &&
      /^[0-9a-f]{64}$/.test(sha) &&
      typeof fn === 'string' &&
      DUMP_RE.test(posix.basename(fn))
    )
  ) {
    return null;
  }
  const ts = aware(rec.ts);
  return ts === null ? 'bad' : [`bk:${sha}`, ts];
}

type FileSpec = {
  paths: () => string[];
  row: (r: Record<string, unknown>) => RowHit;
  una: boolean;
  review: boolean;
};
// file → (đường dẫn [bắt buộc cuối, phụ trước], hàm dòng, `una` dùng thiếu người, `review` cần sổ).
export const FILES: Record<string, FileSpec> = {
  'conversations.jsonl': {
    paths: () => [
      `${settings.dataDir}/conversations.jsonl.1`,
      `${settings.dataDir}/conversations.jsonl`,
    ],
    row: convRow,
    una: true,
    review: false,
  },
  'backup_runs.jsonl': {
    paths: () => {
      const d = pyStrip(settings.env.BACKUP_DIR ?? '');
      if (!d) throw new Unreadable('BACKUP_DIR chưa cấu hình');
      return [`${d}/backup_runs.jsonl`];
    },
    row: backupRow,
    una: false,
    review: true,
  },
};

export type OutRow = [string, Date, boolean, boolean, string | null];

const ASCII_WS = /^[ \t\n\r\v\f]*$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Đọc nguồn file → [đầu ra, số dòng hỏng, số dòng cũ thiếu provenance trong cửa sổ]. Đọc BYTES +
 * tách `\n` (không splitlines — U+2028 trong câu khách). File CHÍNH thiếu / lỗi IO → Unreadable;
 * file phụ (`.1`) thiếu → bỏ qua. Dòng không phải JSON object / đầu ra ts hỏng → `bad`.
 */
export function fileRows(s: Source, a: Date, b: Date): [OutRow[], number, number] {
  const f = s.file as string;
  const spec = Object.hasOwn(FILES, f) ? FILES[f] : undefined;
  if (spec === undefined) throw new Unreadable('chưa có bộ đếm');
  const paths = spec.paths();
  const out = new Map<string, [Date, string]>();
  let bad = 0;
  let legacy = 0;
  paths.forEach((p, i) => {
    let raw: Buffer;
    try {
      raw = readFileSync(p);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        if (i === paths.length - 1) throw new Unreadable('không có file');
        return;
      }
      const name =
        code === 'EISDIR'
          ? 'IsADirectoryError'
          : code === 'EACCES' || code === 'EPERM'
            ? 'PermissionError'
            : 'OSError';
      throw new Unreadable(`lỗi đọc ${name}`);
    }
    let start = 0;
    while (start <= raw.length) {
      let end = raw.indexOf(0x0a, start);
      if (end === -1) end = raw.length;
      const line = raw.subarray(start, end);
      start = end + 1;
      if (ASCII_WS.test(line.toString('latin1'))) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(UTF8.decode(line));
      } catch {
        bad++;
        continue;
      }
      if (!isPlainObject(rec)) {
        bad++;
        continue;
      }
      const got = spec.row(rec);
      if (got === null) continue;
      if (got === 'bad') {
        bad++;
        continue;
      }
      if (got[0] === 'legacy') {
        if (a <= got[1] && got[1] <= b) legacy++;
        continue;
      }
      const [key, ts] = got;
      if (!(a <= ts && ts <= b)) continue;
      const sha = recSha(rec);
      const o = out.get(key);
      if (o === undefined || ts < o[0]) out.set(key, [ts, sha]); // trùng khóa (ghi lại/xoay vòng) = 1
    }
  });
  return [[...out].map(([k, [ts, sha]]) => [k, ts, false, spec.una, sha]), bad, legacy];
}

// ------------------------------------------- v15.2 (P8.7) duyệt từng đầu ra

/** {(khóa, sha): [quyết định, người]} — quyết định MỚI NHẤT mỗi phiên bản. Lỗi → {} (chưa ai duyệt). */
async function reviews(db: Db, fid: string): Promise<Map<string, [string, string]>> {
  let rows: unknown[][];
  try {
    rows = await sp(db, () =>
      rowsOf(
        db,
        'select distinct on (output_key, content_sha256) output_key, content_sha256, decision,' +
          ' reviewed_by from output_reviews where feature_id = %s order by output_key,' +
          ' content_sha256, ts desc, id desc',
        [fid],
      ),
    );
  } catch (e) {
    if (!isDbError(e)) throw e;
    return new Map();
  }
  return new Map(rows.map(([k, hh, d, by]) => [`${k}\u0000${hh}`, [d as string, by as string]]));
}

export type OutputInfo = {
  ts: Date;
  human: boolean;
  unapproved: boolean;
  sha: string | null;
  needs_review: boolean;
  review: [string, string] | null;
};

/**
 * Từng đầu ra DISTINCT của tính năng trong [since, now] → [{khóa: info}, đếm được?, uncounted].
 * Mỗi nguồn đọc trong savepoint: lỗi (bảng thiếu, login thiếu quyền) → nguồn đó vào `uncounted`
 * (fail-closed: thiếu nguồn = ít đầu ra hơn, không bao giờ nhiều hơn).
 */
export async function outputRows(
  db: Db,
  f: { id: string; output_sources?: Source[] },
  since: Date,
  now: Date,
): Promise<[Map<string, OutputInfo>, boolean, string[]]> {
  const merged = new Map<string, OutputInfo>();
  const uncounted: string[] = [];
  let counted = false;
  for (const s of f.output_sources ?? []) {
    let got: OutRow[];
    if ('file' in s) {
      let bad: number;
      let legacy: number;
      try {
        [got, bad, legacy] = fileRows(s, since, now);
      } catch (e) {
        if (!(e instanceof Unreadable)) throw e;
        uncounted.push(`${srcLabel(s)} (không đọc được: ${e.message})`);
        continue;
      }
      if (bad) uncounted.push(`${srcLabel(s)} (${bad} dòng hỏng — bỏ qua, không đếm)`);
      if (legacy) {
        uncounted.push(
          `${srcLabel(s)} (${legacy} dòng thiếu provenance — bản ghi cũ, không công nhận là đầu ra thật)`,
        );
      }
    } else {
      const q = sourceSql(f, s, since, now);
      if (q === null) {
        uncounted.push(srcLabel(s));
        continue;
      }
      try {
        got = (await sp(db, () => rowsOf(db, q[0], q[1]))) as OutRow[];
      } catch (e) {
        if (!isDbError(e)) throw e;
        uncounted.push(`${srcLabel(s)} (không đọc được: ${pgErrName(e)})`);
        continue;
      }
    }
    counted = true;
    const need = needsReview(s);
    for (const [key, ts, hum, una, sha] of got) {
      const o = merged.get(key);
      if (o === undefined) {
        merged.set(key, {
          ts,
          human: Boolean(hum),
          unapproved: Boolean(una),
          sha,
          needs_review: need,
          review: null,
        });
      } else {
        // khóa trùng giữa 2 nguồn cùng tính năng = 1 đầu ra
        if (ts < o.ts) o.ts = ts;
        o.human ||= Boolean(hum);
        o.unapproved ||= Boolean(una);
        o.sha = o.sha || sha;
        o.needs_review &&= need;
      }
    }
  }
  if ([...merged.values()].some((o) => o.needs_review)) {
    const rev = await reviews(db, f.id);
    for (const [key, o] of merged) {
      if (!o.needs_review) continue;
      const r = rev.get(`${key}\u0000${o.sha}`) ?? null;
      o.review = r;
      if (r && r[0] === 'approved' && isHuman(r[1])) o.human = true;
    }
  }
  return [merged, counted, uncounted];
}

export type OutputFacts = {
  outputs: number | null;
  out_days: number;
  human: number;
  unapproved: number;
  unreviewed: number;
  uncounted: string[];
  counted_by?: string;
};

/** Đầu ra THẬT của đúng tính năng trong [since, now] (F04). `outputs` null = không đếm được. */
export async function outputFacts(
  db: Db,
  f: { id: string; output_sources?: Source[] },
  since: Date,
  now: Date,
  shift: unknown,
): Promise<OutputFacts> {
  const [merged, counted, uncounted] = await outputRows(db, f, since, now);
  const rows = [...merged.values()];
  const sh: Shift = parseShift(shift);
  const days = new Set(
    rows.map((r) => vnDate(r.ts)).filter((d) => sh.workdays.has(weekday(d)) && !sh.holidays.has(d)),
  );
  return {
    outputs: counted ? rows.length : null,
    out_days: days.size,
    human: rows.filter((r) => r.human).length,
    unapproved: rows.filter((r) => r.unapproved).length,
    unreviewed: rows.filter((r) => r.needs_review && r.review === null).length,
    uncounted,
  };
}
