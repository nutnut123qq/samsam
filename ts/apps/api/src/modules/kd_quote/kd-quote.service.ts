import { closeSync, openSync, readSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { verify } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { submit as directorSubmit, loadConfig } from '@samsam/core/ops/director';
import { businessDeadline, dmy, vnFormat } from '@samsam/core/ops/period';
import { isPrintable } from '@samsam/core/ops/py';
import { parsePyJson } from '@samsam/core/ops/py-json';
import { queueSample, writeReport } from '@samsam/core/ops/report';
import { withTx } from '@samsam/core/ops/tx';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { callHuman, HumanDenied } from '@samsam/core/security/auth';
import { casefold, cpLen, pyStrip } from '@samsam/core/security/py';
import { section } from '../sales_director/sales-watch.js';
import { COLS, LEGACY_BLOCK, type OrgRow, OBJECT_TYPE as OT_BATCH, renderBatch } from './da-b2b.js';
import {
  AGENT as CATALOG_AGENT,
  type CatalogBuilt,
  OBJECT_TYPE as OT_CATALOG,
  objectId,
} from './kd-catalog.js';
import {
  AGENT,
  BLOCK,
  type Built,
  type Classified,
  type CogsVersion,
  FINANCE_REASONS,
  type GoldenPrices,
  MAX_SEND_BYTES,
  OT_MARGIN,
  OT_MATRIX,
  OT_QUOTE,
  QA_SUITE,
  QUOTE_TYPES,
  type QuoteRequest,
  renderHtml,
  sha256,
  typesRepr,
} from './kd-quote.js';

// Phần DB của `agents/kd_quote.py` (hàng duyệt báo giá, xuất/kiểm bản gửi, mốc gửi/kết quả qua
// function `b2b_quote_event_human`, nhắc chốt đơn sales-05), `agents/da_b2b.py` (nạp tổ chức, lô
// duyệt, chuyển sales qua `org_*_human`) và `agents/kd_catalog.py` (hàng duyệt catalog). Agent KHÔNG
// gửi email/tin nhắn; luật danh tính/khối/sha bản duyệt nằm ở DB và được GỌI lại.

export type Qid = bigint | number | string;
const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

// ------------------------------------------------------------ đọc nguồn
/** `kd_listing.golden_prices`: giá thường trực (program_id null) list/floor hiệu lực ngày `day`; nhiều
 * dòng mở (lỗi dữ liệu) → dòng valid_from/id mới nhất. */
export async function goldenPrices(db: Db, day: string): Promise<GoldenPrices> {
  const { rows } = await db.query(
    "select sku_key, channel, kind, price_vnd::text as price, id::text as id, approved_by from price_list where program_id is null and kind in ('list', 'floor') and valid_from <= $1 and (valid_to is null or valid_to > $1) order by valid_from, id",
    [day],
  );
  const out: GoldenPrices = new Map();
  for (const r of rows) {
    const k = `${r.sku_key}\u0000${r.channel}`;
    const cur = out.get(k) ?? {};
    cur[r.kind] = { price: Number(r.price), id: Number(r.id), approved: r.approved_by !== null };
    out.set(k, cur);
  }
  return out;
}

/** `fp_pnl.fetch_versions`. */
export async function fetchVersions(db: Db): Promise<CogsVersion[]> {
  const { rows } = await db.query(
    'select id::text as id, sku_key, cost_vnd::text as cost, valid_from::text as valid_from, approved_by from cogs_versions order by id',
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sku_key: r.sku_key,
    cost_vnd: Number(r.cost),
    valid_from: r.valid_from,
    approved_by: r.approved_by,
  }));
}

/** Yêu cầu báo giá (không cột liên hệ). `items` đọc nguyên văn jsonb (giữ int/float như Python). */
export async function fetchRequest(db: Db, rid: Qid): Promise<QuoteRequest | null> {
  const { rows } = await db.query(
    'select id::text as id, org_name, org_type, region, items::text as items, need_by::text as need_by, created_at from b2b_requests where id = $1',
    [String(rid)],
  );
  const r = rows[0];
  return r ? { ...r, items: parsePyJson(r.items) } : null;
}

// ------------------------------------------------------------ hàng duyệt báo giá
export const financeNeeded = (result: Classified): boolean =>
  result.reasons.some((r) => FINANCE_REASONS.includes(r));

/** Mục pending/approved của báo giá (cùng số) → id | null. */
export async function existing(db: Db, quoteNo: string): Promise<string | null> {
  const { rows } = await db.query(
    "select id::text as id from approval_queue where object_id = $1 and block = $2 and object_type = any($3) and status in ('pending', 'approved') order by id limit 1",
    [quoteNo, BLOCK, [...QUOTE_TYPES].sort()],
  );
  return rows[0]?.id ?? null;
}

/** problems rỗng → 1–2 mục hàng duyệt trong 1 giao dịch → [qid...]. Cùng số báo giá đang
 * pending/đã duyệt → [] (skip). */
export async function submitQuote(
  db: Db,
  request: QuoteRequest,
  built: Built,
  result: Classified,
  submitFn: typeof directorSubmit = directorSubmit,
): Promise<bigint[]> {
  if (built.problems.length || result.problems.length || !built.quote_no) {
    throw new RangeError('báo giá có problems — không vào hàng duyệt');
  }
  const qno = built.quote_no;
  if ((await existing(db, qno)) !== null) return [];
  const ot = result.within_matrix ? OT_MATRIX : OT_QUOTE;
  const title = `Báo giá B2B ${qno} (YC-${BigInt(String(request.id))}, ${result.lines.length} dòng)`;
  return withTx(db, async (c) => {
    const ids = [
      await submitFn(c, {
        block: BLOCK,
        objectType: ot,
        objectId: qno,
        title,
        payload: built.payload,
        createdBy: AGENT,
        qaSuite: QA_SUITE,
      }),
    ];
    if (financeNeeded(result)) {
      ids.push(
        await submitFn(c, {
          block: 'finance',
          objectType: OT_MARGIN,
          objectId: qno,
          title: `Rà biên báo giá B2B ${qno}`,
          payload: built.internal,
          createdBy: AGENT,
        }),
      );
    }
    return ids;
  });
}

type QueueRow = { block: string; object_type: string; status: string; payload: string };

async function queueRow(db: Db, qid: Qid): Promise<QueueRow | null> {
  const { rows } = await db.query(
    'select block, object_type, status, payload from approval_queue where id = $1',
    [String(qid)],
  );
  return (rows[0] as QueueRow | undefined) ?? null;
}

async function approvedPayload(db: Db, qid: Qid, types: string[]): Promise<string | null> {
  const r = await queueRow(db, qid);
  if (
    r === null ||
    r.block !== BLOCK ||
    !types.includes(r.object_type) ||
    r.status !== 'approved'
  ) {
    return null;
  }
  return r.payload;
}

/** Xuất bản ĐÃ duyệt: `.md` = payload nguyên văn, `.html` = `renderHtml(payload)`. Chưa duyệt / sai
 * loại / lệch hash → [false, lý do]. */
export async function exportApproved(
  db: Db,
  qid: Qid,
  out: string,
  types: string[] = QUOTE_TYPES,
): Promise<[boolean, string]> {
  const ext = extname(out).toLowerCase();
  if (ext !== '.md' && ext !== '.html') return [false, '--out phải là .md hoặc .html'];
  const payload = await approvedPayload(db, qid, types);
  if (payload === null) {
    return [false, `mục #${qid} không phải tài liệu ${typesRepr(types)} ĐÃ duyệt — KHÔNG xuất`];
  }
  if (!(await verify(db, qid, payload))) {
    return [false, `mục #${qid}: LỆCH bản duyệt (sha256) — KHÔNG xuất`];
  }
  const body = ext === '.md' ? payload : renderHtml(payload);
  const path = await writeReport(body, dirname(out), basename(out), await queueSample(db, qid));
  return [true, path];
}

/** Đọc ≤ n byte đầu của file (Python `fh.read(n)`). */
function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    let got = 0;
    for (let r = 1; r > 0 && got < n; got += r) r = readSync(fd, buf, got, n - got, null);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** File sắp gửi có đúng bản đã duyệt? (khớp sha256 bản duyệt). > 2 MB / không UTF-8 / sai khối-loại /
 * chưa duyệt / lệch → false. */
export async function verifySend(
  db: Db,
  qid: Qid,
  path: string,
  types: string[] = QUOTE_TYPES,
): Promise<boolean> {
  let data: Buffer;
  let text: string;
  try {
    data = readHead(path, MAX_SEND_BYTES + 1);
    if (data.length > MAX_SEND_BYTES) return false;
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return false;
  }
  const payload = await approvedPayload(db, qid, types);
  if (payload === null) return false;
  if (extname(path).toLowerCase() === '.html') {
    return (
      data.equals(Buffer.from(renderHtml(payload), 'utf8')) && (await verify(db, qid, payload))
    );
  }
  return verify(db, qid, text);
}

// ------------------------------------------------------- v14.4 nhắc chốt đơn (sales-05)
export const OT_FOLLOWUP = 'b2b_followup';
export const FEATURE_FOLLOWUP = 'sales-05';
export const OUTCOMES = ['chot', 'khong_chot', 'huy'];
export const OUTCOME_LABELS: Record<string, string> = {
  chot: 'đã chốt',
  khong_chot: 'không chốt',
  huy: 'hủy yêu cầu',
};
const QNO_RE = /^BG-[0-9]{8}-[0-9]{1,18}-[0-9a-f]{8}$/;

/** 1 dòng `b2b_quote_events` cho báo giá ĐÃ duyệt (sales, b2b_quote*) → id. Kết quả
 * (`chot|khong_chot|huy`) cần `by` người thật và chỉ ghi 1 lần; `da_gui` ghi mỗi lần gửi. Sai →
 * RangeError (Python ValueError). Ghi qua function `b2b_quote_event_human` (SECURITY DEFINER — DB kiểm
 * danh tính theo login, báo giá ĐÃ duyệt, 1 kết quả/báo giá, mốc gửi khớp sha bản duyệt mới nhất).
 * DB từ chối danh tính → HumanDenied. */
export async function recordEvent(
  db: Db,
  qid: Qid,
  kind: string,
  by: unknown = null,
  text: string | null = null,
): Promise<bigint> {
  if (kind !== 'da_gui' && !OUTCOMES.includes(kind)) {
    throw new RangeError(`kết quả phải là ${OUTCOMES.join('|')}`);
  }
  const who = typeof by === 'string' && pyStrip(by) ? pyStrip(by) : null;
  if (who !== null && (cpLen(who) > 100 || !isPrintable(who))) {
    throw new RangeError('--by phải là tên người 1..100 ký tự in được');
  }
  const outcome = OUTCOMES.includes(kind);
  if (outcome && (who === null || /^(agent|system):/.test(casefold(who)))) {
    throw new RangeError('ghi kết quả báo giá cần --by tên NGƯỜI');
  }
  const row = await queueRow(db, qid);
  if (
    row === null ||
    row.block !== BLOCK ||
    !QUOTE_TYPES.includes(row.object_type) ||
    row.status !== 'approved'
  ) {
    throw new RangeError(`mục #${qid} không phải báo giá B2B ĐÃ duyệt`);
  }
  if (outcome) {
    const { rows } = await db.query(
      'select kind from b2b_quote_events where queue_id = $1 and kind = any($2) order by id limit 1',
      [String(qid), OUTCOMES],
    );
    if (rows[0]) {
      throw new RangeError(
        `mục #${qid} đã ghi kết quả '${OUTCOME_LABELS[rows[0].kind]}' — không ghi đè`,
      );
    }
  }
  const t = kind === 'da_gui' ? (text ?? row.payload) : null;
  try {
    const r = await callHuman<{ id: string }>(
      db,
      'select b2b_quote_event_human($1, $2, $3, $4) as id',
      [String(qid), kind, t, who],
      {
        by: who,
        block: null,
        action: outcome ? 'outcome' : 'verify_send',
        objectType: 'b2b_quote',
        objectId: qid,
      },
    );
    return BigInt(r.rows[0]?.id as string);
  } catch (e) {
    // 2 người ghi song song: index unique một-kết-quả/báo-giá chặn.
    if (isUnique(e)) throw new RangeError(`mục #${qid} đã ghi kết quả — không ghi đè`);
    throw e;
  }
}

const tsKey = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS"Z"')`;
type Ts = { at: Date; k: string }; // k = Python `_utc(ts)` (µs, UTC) — so sánh/khóa ĐỢT chính xác µs
const maxTs = (xs: Ts[]): Ts => xs.reduce((a, b) => (b.k > a.k ? b : a));
const fmt = (d: Date) => vnFormat(d, '%d/%m/%Y %H:%M');
const safeNo = (qno: unknown) => (typeof qno === 'string' && QNO_RE.test(qno) ? qno : '(số lạ)');

export type FollowupItem = {
  object_type: string;
  object_id: string;
  title: string;
  payload: string;
};
export type FollowupCfg = { after_business_hours: number; max_reminders: number };

/** CHỈ ĐỌC → mục nhắc chốt đơn cần đẩy: báo giá ĐÃ duyệt chưa có kết quả sau N giờ làm việc tính từ
 * lần gửi gần nhất (chưa gửi → từ lúc duyệt). Theo ĐỢT: khóa `fu:<qid>:<mốc UTC>:<k>` — đang có
 * nhắc pending → không thêm; nhắc đã quyết → lần k+1 sau thêm N giờ, tối đa `max_reminders`. */
export async function followupItems(
  db: Db,
  now: Date,
  fu: FollowupCfg,
  shift: unknown,
): Promise<FollowupItem[]> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('now phải là datetime có múi giờ (aware)');
  }
  const quotes = (
    await db.query(
      `select id::text as id, object_id, decided_at, ${tsKey('decided_at')} as decided_k from approval_queue where block = $1 and object_type = any($2) and status = 'approved' order by id`,
      [BLOCK, [...QUOTE_TYPES].sort()],
    )
  ).rows;
  if (!quotes.length) return [];
  const ev = new Map<string, { kind: string; ts: Ts }[]>();
  for (const r of (
    await db.query(
      `select queue_id::text as qid, kind, created_at, ${tsKey('created_at')} as k from b2b_quote_events where queue_id = any($1::bigint[]) order by id`,
      [quotes.map((q) => q.id)],
    )
  ).rows) {
    const l = ev.get(r.qid) ?? [];
    l.push({ kind: r.kind, ts: { at: r.created_at, k: r.k } });
    ev.set(r.qid, l);
  }
  const rem = new Map<string, { st: string; dec: Ts | null }[]>();
  for (const r of (
    await db.query(
      `select object_id, status, decided_at, ${tsKey('decided_at')} as k from approval_queue where object_type = $1 and object_id like 'fu:%'`,
      [OT_FOLLOWUP],
    )
  ).rows) {
    const key = (r.object_id as string).slice(0, (r.object_id as string).lastIndexOf(':'));
    const l = rem.get(key) ?? [];
    l.push({ st: r.status, dec: r.decided_at === null ? null : { at: r.decided_at, k: r.k } });
    rem.set(key, l);
  }
  const out: FollowupItem[] = [];
  for (const q of quotes) {
    const evs = ev.get(q.id) ?? [];
    if (evs.some((e) => OUTCOMES.includes(e.kind)) || q.decided_at === null) continue;
    const decided: Ts = { at: q.decided_at, k: q.decided_k };
    const sent = evs.filter((e) => e.kind === 'da_gui').map((e) => e.ts);
    const base = maxTs([decided, ...sent]);
    const key = `fu:${q.id}:${base.k}`;
    const prev = rem.get(key) ?? [];
    if (prev.some((p) => p.st === 'pending') || prev.length >= fu.max_reminders) continue;
    const start = maxTs([base, ...prev.flatMap((p) => (p.dec ? [p.dec] : []))]);
    const due = businessDeadline(start.at, fu.after_business_hours, shift);
    if (now < due) continue;
    const k = prev.length + 1;
    const mode = sent.length
      ? `đã gửi lúc ${fmt((sent[sent.length - 1] as Ts).at)}`
      : `đã duyệt lúc ${fmt(decided.at)}, CHƯA xác nhận gửi (--verify-send)`;
    const no = safeNo(q.object_id);
    out.push({
      object_type: OT_FOLLOWUP,
      object_id: `${key}:${k}`,
      title: `Nhắc chốt báo giá ${no} (lần ${k})`,
      payload: `Nhắc chốt đơn B2B lần ${k}/${fu.max_reminders} — báo giá ${no} (mục #${q.id}) ${mode}; chưa ghi kết quả sau ${fu.after_business_hours} giờ làm việc (GIẢ ĐỊNH). Việc cần làm: GĐ bán hàng TỰ liên hệ tổ chức qua kênh đã gửi báo giá, rồi ghi kết quả \`python -m agents.kd_quote --outcome ${q.id} chot|khong_chot|huy --by <tên>\`. Mẫu lời nhắc (người gửi tự điền tên người nhận): 'Kính gửi Quý tổ chức, Sâm Sâm xin phép theo dõi báo giá số ${no}. Nếu Quý tổ chức cần điều chỉnh số lượng hoặc thông tin giao hàng, xin vui lòng phản hồi để chúng tôi cập nhật báo giá.' Hệ thống không tự liên hệ khách.`,
    });
  }
  return out;
}

/** Đẩy nhắc chốt đơn (tính năng tắt → RolloutBlocked trước khi đọc nguồn). */
export async function runFollowups(
  db: Db,
  now: Date,
  dryRun = false,
  watchFile?: string,
): Promise<{ found: number; enqueued: number }> {
  const fu = section('quote_followup', watchFile) as FollowupCfg;
  const cfg = loadConfig(BLOCK);
  if (!Object.hasOwn(cfg.object_types, OT_FOLLOWUP)) {
    throw new RangeError(`sales.json thiếu loại việc ${OT_FOLLOWUP}`);
  }
  await checkGenerate(db, FEATURE_FOLLOWUP, 'nhắc chốt đơn B2B');
  const items = await followupItems(db, now, fu, cfg.business_hours);
  let n = 0;
  if (!dryRun) {
    for (const it of items) {
      try {
        await directorSubmit(db, {
          block: BLOCK,
          objectType: it.object_type,
          objectId: it.object_id,
          title: it.title,
          payload: it.payload,
          createdBy: AGENT,
          cfg,
        });
      } catch (e) {
        if (isUnique(e)) continue;
        throw e;
      }
      n++;
    }
  }
  return { found: items.length, enqueued: n };
}

// ------------------------------------------------------------ da_b2b
export async function importRows(
  db: Db,
  rows: OrgRow[],
  by: string,
  source: string,
): Promise<{ inserted: number; dup: number }> {
  return withTx(db, async (c) => {
    const st = { inserted: 0, dup: 0 };
    for (const r of rows) {
      const res = await c.query(
        'insert into org_prospects (dedup_key, org_name, org_type, region, website, source_url, fit_reason, source, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (dedup_key) do nothing',
        [
          r.dedup_key,
          r.org_name,
          r.org_type,
          r.region,
          r.website,
          r.source_url,
          r.fit_reason,
          source,
          by,
        ],
      );
      if (res.rowCount === 1) st.inserted++;
      else st.dup++;
    }
    return st;
  });
}

/** Dòng `moi` → 1 mục hàng duyệt + dòng `cho_duyet`. → [qid, n]. Mỗi lô chỉ gồm dòng của MỘT người
 * nhập (người nhập dòng `moi` cũ nhất) và mục ghi `created_by` = người nhập đó → hàng duyệt chặn
 * người nhập tự duyệt lô của chính mình. */
export async function submitBatch(db: Db, limit = 50): Promise<[bigint | null, number]> {
  return withTx(db, async (c) => {
    const first = (
      await c.query("select created_by from org_prospects where status = 'moi' order by id limit 1")
    ).rows[0];
    if (!first) return [null, 0];
    const importer = first.created_by as string;
    const { rows } = await c.query(
      `select ${COLS.join(', ')} from org_prospects where status = 'moi' and created_by = $1 order by id limit $2 for update`,
      [importer, limit],
    );
    if (!rows.length) return [null, 0];
    const keys = rows.map((r) => r.dedup_key).join('');
    const oid = `b2b-batch:${sha256(keys).slice(0, 12)}`;
    const qid = await directorSubmit(c, {
      block: BLOCK,
      objectType: OT_BATCH,
      objectId: oid,
      title: `Lô ${rows.length} tổ chức tiềm năng mua quà Tết`,
      payload: renderBatch(rows as OrgRow[]),
      createdBy: importer,
    });
    await c.query(
      "update org_prospects set status = 'cho_duyet', batch_queue_id = $1 where id = any($2::bigint[])",
      [String(qid), rows.map((r) => String(r.id))],
    );
    return [qid, rows.length];
  });
}

/** → [ok, thông điệp, số dòng đổi]. Chỉ đổi khi người đã quyết. Đọc dòng lô + GHI qua function
 * `org_batch_rows_human`/`org_handover_human` (SECURITY DEFINER — DB tự kiểm lại mục đã quyết, sha
 * bản duyệt, thành viên lô; danh tính theo login). DB từ chối danh tính → HumanDenied (ném lên). */
export async function handover(db: Db, qid: Qid, by: string): Promise<[boolean, string, number]> {
  const row = (
    await db.query('select block, object_type, status from approval_queue where id = $1', [
      String(qid),
    ])
  ).rows[0];
  // v12.0: lô nộp trước v12.0 nằm ở khối `projects` (đã gỡ) — vẫn nhận để dòng 'cho_duyet' không kẹt.
  if (!row || ![BLOCK, LEGACY_BLOCK].includes(row.block) || row.object_type !== OT_BATCH) {
    return [false, `mục #${qid} không phải lô \`${OT_BATCH}\``, 0];
  }
  const o = { by, block: null, action: 'handover', objectType: 'approval_queue', objectId: qid };
  let text: string | null = null;
  if (row.status !== 'rejected' && row.status !== 'expired') {
    if (row.status !== 'approved') {
      return [false, `lô #${qid} đang '${row.status}' — chỉ chuyển khi NGƯỜI đã duyệt`, 0];
    }
    let rows: OrgRow[];
    try {
      rows = (
        await callHuman(db, 'select * from org_batch_rows_human($1, $2)', [String(qid), by], o)
      ).rows as OrgRow[];
    } catch (e) {
      if (e instanceof RangeError && !(e instanceof HumanDenied)) return [false, e.message, 0];
      throw e;
    }
    text = rows.length ? renderBatch(rows) : null;
    if (text === null || !(await verify(db, qid, text))) {
      return [false, `lô #${qid}: dữ liệu hiện tại LỆCH bản đã duyệt (sha256) — KHÔNG chuyển`, 0];
    }
  }
  let n: number;
  try {
    const r = await callHuman<{ n: number }>(
      db,
      'select org_handover_human($1, $2, $3) as n',
      [String(qid), text, by],
      o,
    );
    n = Number(r.rows[0]?.n);
  } catch (e) {
    if (e instanceof RangeError && !(e instanceof HumanDenied)) return [false, e.message, 0]; // DB từ chối nghiệp vụ
    throw e;
  }
  if (text === null) {
    // Lô kết thúc không duyệt → dòng về 'moi' để lập lô mới (submitBatch chỉ lấy 'moi').
    const why = row.status === 'rejected' ? 'bị từ chối' : 'hết hạn SLA';
    return [true, `lô #${qid} ${why} — ${n} dòng về 'moi'`, n];
  }
  return [true, `lô #${qid}: ${n} tổ chức → chuyen_sales`, n];
}

// ------------------------------------------------------------ kd_catalog
/** → qid | null (đã có mục pending/đã duyệt cùng nội dung). */
export async function catalogSubmit(
  db: Db,
  built: CatalogBuilt,
  day: string,
): Promise<bigint | null> {
  if (built.problems.length) throw new RangeError('catalog có problems — không vào hàng duyệt');
  const oid = objectId(day, built.payload);
  const { rows } = await db.query(
    "select id from approval_queue where object_type = $1 and object_id = $2 and status in ('pending', 'approved') limit 1",
    [OT_CATALOG, oid],
  );
  if (rows[0]) return null;
  return directorSubmit(db, {
    block: BLOCK,
    objectType: OT_CATALOG,
    objectId: oid,
    title: `Catalog quà Tết ${dmy(day)} (${built.n_items} mục)`,
    payload: built.payload,
    createdBy: CATALOG_AGENT,
  });
}
