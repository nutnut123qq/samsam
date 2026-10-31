import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, loadConfig, submit } from '@samsam/core/ops/director';
import { dmy } from '@samsam/core/ops/period';
import { pyInt } from '@samsam/core/ops/py';
import { cpCmp, isDict, pyOsName } from '@samsam/core/ops/py-json';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pgErrName } from '@samsam/core/rollout/counters';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { callHuman, HumanDenied } from '@samsam/core/security/auth';
import { checkPublish } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, cpLen, pyRepr, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import { byError, isoDay, safe } from '../ra_kenh/ra-kenh.js';
import { type Io, isUnique, STD_IO } from './common.js';

// v4.3 PC-A1 (WP05) — port `agents/xnqc.py`: sổ hồ sơ XNQC theo SKU + nhắc mốc + đề xuất đồng bộ
// golden + soạn NHÁP hồ sơ (legal_hr-02, legal_hr-03.2).
//
// Mỗi maket/kịch bản là 1 hồ sơ. Trạng thái chỉ đi theo `TRANSITIONS`; `da_cap` CHỈ do NGƯỜI (Pháp
// chế) xác nhận: `--by` là tên người + số giấy + ngày cấp (≤ hôm nay) + scan giấy trong `documents`
// đã được Pháp chế đối chiếu bản gốc (`status = 'verified'`). DB tự chặn thêm bằng CHECK. v15.4: ghi
// qua function SECURITY DEFINER `xnqc_add_human`/`xnqc_set_status_human` (danh tính theo login
// Postgres — `--by` phải là người của login; `--set` khối legal_hr; DB kiểm lại chuyển trạng thái +
// scan); mỗi lần đổi trạng thái DB ghi 1 dòng `agent_action_log` (`xnqc_status`) cùng giao dịch.
//
// Đồng bộ golden: `goldenTarget` (thuần) suy `xnqc_status` nên có của SKU từ hồ sơ; `syncGolden` so
// với `data/golden_skus.json` — lệch thì ĐỀ XUẤT vào hàng duyệt (`golden_xnqc_sync`, khối
// legal_hr). Agent KHÔNG ghi file golden, KHÔNG ghi `sku_master`/`price_list`. Hồ sơ đổi trong lúc
// mục cũ còn chờ → mục mới ghi "THAY THẾ mục #X — chỉ duyệt mục mới nhất". Agent KHÔNG tự quyết/rút
// mục. Nhắc mốc (thuần, `today` là tham số): SKU TPBVSK chưa có hồ sơ đang nộp/còn hiệu lực → CHƯA
// NỘP / SẮP HẠN / QUÁ HẠN đợt 2; giấy `da_cap` sắp/đã hết hạn (agent KHÔNG tự chuyển `het_han`).
//
// Ngày = chuỗi 'YYYY-MM-DD'; id = chuỗi số (bigint không mất chính xác).

export const AGENT = 'agent:phap_che_a1';
export const LOAI = ['maket', 'kich_ban_video', 'kich_ban_livestream', 'khac'];
export const STATUSES = ['chuan_bi', 'da_nop', 'bo_sung', 'da_cap', 'het_han'];
export const TRANSITIONS: Record<string, string[]> = {
  chuan_bi: ['da_nop'],
  da_nop: ['bo_sung', 'da_cap'],
  bo_sung: ['da_nop'],
  da_cap: ['het_han'],
  het_han: [],
};
export const SYNC_AFTER = ['da_nop', 'da_cap', 'het_han'];
export const MAX_TEN = 200;
const SHA_RE = /^[0-9a-f]{64}$/;
export const GOLDEN_FILE = dataPath('golden_skus.json');
export const DRAFT_FILE = dataPath('xnqc_draft.json');
export const CLAIMS_FILE = dataPath('claims_whitelist.json');
export const DRAFT_AGENT = 'agent:xnqc';

export const tupleRepr = (xs: readonly string[]): string => `(${xs.map(pyRepr).join(', ')})`;

export type Dossier = {
  id: string | number;
  sku_key: string;
  loai_ho_so?: string;
  ten_ho_so?: string;
  status: string;
  so_giay?: string | null;
  ngay_nop?: string | null;
  ngay_cap: string | null;
  ngay_het_han: string | null;
  document_sha256?: string | null;
  updated_by: string | null;
};

/** Python `_date`: chuỗi ISO / null → ngày | null. Sai → RangeError `<what>: cần ngày YYYY-MM-DD hợp lệ`. */
export function xDate(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? isoDay(pyStrip(v)) : null;
  if (d === null) throw new RangeError(`${what}: cần ngày YYYY-MM-DD hợp lệ`);
  return d;
}

export async function listDossiers(db: Db): Promise<Dossier[]> {
  const { rows } = await db.query<Dossier>(
    'select id::text as id, sku_key, loai_ho_so, ten_ho_so, status, so_giay,' +
      ' ngay_nop::text as ngay_nop, ngay_cap::text as ngay_cap, ngay_het_han::text as ngay_het_han,' +
      ' document_sha256, updated_by from xnqc_dossiers order by sku_key, id',
  );
  return rows;
}

type Dict = Record<string, unknown>;

/** `golden_store.read_golden` → [doc, null] | [null, lý do] (thiếu / không UTF-8 / rỗng / JSON hỏng
 * / `{}` / `skus: []`). shortcut: thông điệp JSON hỏng mang lỗi của JS (Python: lỗi `json`). */
export function readGolden(path: string = GOLDEN_FILE): [Dict | null, string | null] {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return [null, `thiếu file ${path}`];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (e) {
    return [null, `${path} không phải UTF-8: ${(e as Error).message}`];
  }
  if (!pyStrip(text)) return [null, `${path} rỗng`];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return [null, `${path} JSON hỏng: ${(e as Error).message}`];
  }
  if (!isDict(doc) || !pyTruthy(doc.skus)) {
    return [null, `${path} không có SKU nào (0 record) — không nạp`];
  }
  return [doc, null];
}

/** Python `for s in doc["skus"]` (list) — dạng khác: Python vỡ (TypeError/AttributeError). */
function skusOf(doc: Dict): Dict[] {
  if (!Array.isArray(doc.skus)) throw new TypeError("golden: 'skus' phải là list");
  return doc.skus as Dict[];
}

function skuKey(s: unknown): string {
  if (!isDict(s) || !Object.hasOwn(s, 'sku_key')) throw new TypeError("KeyError: 'sku_key'");
  return s.sku_key as string;
}

export function tpbvskSkus(path: string = GOLDEN_FILE): string[] {
  const [doc, err] = readGolden(path);
  if (err !== null || doc === null) throw new RangeError(err ?? 'golden');
  return skusOf(doc)
    .filter((s) => isDict(s) && s.category === 'tpbvsk')
    .map(skuKey);
}

/** Hồ sơ mới `chuan_bi` → id. Thiếu/sai tham số, SKU lạ → RangeError (Python ValueError). */
export async function add(
  db: Db,
  sku: string,
  loai: string,
  ten: string | null | undefined,
  by: string,
  env?: Env,
): Promise<string> {
  const err = byError(by);
  if (err) throw new RangeError(err);
  if (!LOAI.includes(loai)) throw new RangeError(`loại hồ sơ phải thuộc ${tupleRepr(LOAI)}`);
  const t = pyStrip(ten ?? '');
  if (!t || cpLen(t) > MAX_TEN) {
    throw new RangeError(`tên hồ sơ rỗng hoặc dài quá ${MAX_TEN} ký tự`);
  }
  const { rows } = await db.query('select 1 from sku_master where sku_key = $1', [sku]);
  if (!rows.length) throw new RangeError('SKU không có trong sku_master');
  // v15.4 (P10.1): ghi qua function SECURITY DEFINER (danh tính theo login — nhập liệu, không khối)
  // + log cùng giao dịch trong function.
  const r = await callHuman<{ id: string }>(
    db,
    'select xnqc_add_human($1, $2, $3, $4)::text as id',
    [sku, loai, t, pyStrip(by)],
    { by, block: null, action: 'add', objectType: 'xnqc_dossier', objectId: sku, env },
  );
  return r.rows[0]?.id as string;
}

export type SetOpts = {
  so_giay?: string | null;
  ngay_nop?: string | null;
  ngay_cap?: string | null;
  ngay_het_han?: string | null;
  doc_sha?: string | null;
  today: string;
  /** Đồng bộ golden sau commit (test đổi file golden / thư mục cấu hình GĐ khối). */
  goldenFile?: string;
  directorsDir?: string;
  env?: Env;
};

/** Tên lớp lỗi Python cho thông điệp (`type(e).__name__`). */
function errName(e: unknown): string {
  if (e instanceof RolloutBlocked) return 'RolloutBlocked';
  if (e instanceof HumanDenied) return 'HumanDenied';
  if (isDbError(e)) return pgErrName(e);
  return 'ValueError';
}

/** Chuyển trạng thái theo `TRANSITIONS` → [true, msg] | [false, lý do — không ghi gì]. Sang
 * da_nop/da_cap/het_han → tự `syncGolden` sau khi ghi. */
export async function setStatus(
  db: Db,
  dossierId: unknown,
  status: string,
  by: string,
  o: SetOpts,
): Promise<[boolean, string]> {
  const err = byError(by);
  if (err) return [false, err];
  if (!STATUSES.includes(status)) return [false, `trạng thái phải thuộc ${tupleRepr(STATUSES)}`];
  // Python `int(dossier_id)`. KHÁC Python (chặt hơn): chữ số Unicode ngoài ASCII → không hợp lệ.
  const did = pyInt(dossierId);
  if (did === null) return [false, `id hồ sơ '${cpHead(safe(dossierId), 20)}' không hợp lệ`];
  const id = did.toString();
  let nop: string | null;
  let cap: string | null;
  let het: string | null;
  try {
    nop = xDate(o.ngay_nop, 'ngay_nop');
    cap = xDate(o.ngay_cap, 'ngay_cap');
    het = xDate(o.ngay_het_han, 'ngay_het_han');
  } catch (e) {
    return [false, (e as Error).message];
  }
  const { rows } = await db.query<{ status: string }>(
    'select status from xnqc_dossiers where id = $1',
    [id],
  );
  if (!rows.length) return [false, `không tìm thấy hồ sơ #${id}`];
  const cur = rows[0]?.status as string;
  const allowed = TRANSITIONS[cur] ?? [];
  if (!allowed.includes(status)) {
    const ok = [...allowed].sort(cpCmp).join(', ') || '(không — trạng thái cuối)';
    return [false, `không chuyển được ${cur} → ${status}; hợp lệ: ${ok}`];
  }
  if (status === 'da_nop' && (nop === null || nop > o.today)) {
    return [false, 'da_nop cần --ngay-nop (không ở tương lai)'];
  }
  let sha: string | null = null;
  let so: string | null = null;
  if (status === 'da_cap') {
    so = pyStrip(o.so_giay ?? '') || null;
    if (so === null || cpLen(so) > 100) return [false, 'da_cap cần --so-giay (≤ 100 ký tự)'];
    if (cap === null || cap > o.today) return [false, 'da_cap cần --ngay-cap (không ở tương lai)'];
    if (het !== null && het <= cap) return [false, '--het-han phải sau --ngay-cap'];
    sha = pyStrip(o.doc_sha ?? '').toLowerCase();
    if (!SHA_RE.test(sha))
      return [false, 'da_cap cần --doc-sha (sha256 scan giấy trong documents)'];
    const d = await db.query<{ status: string }>('select status from documents where sha256 = $1', [
      sha,
    ]);
    if (!d.rows.length) return [false, 'scan giấy không có trong documents (nạp qua doc_intake)'];
    const ds = d.rows[0]?.status as string;
    if (ds !== 'verified') {
      return [
        false,
        `scan giấy đang '${ds}' — Pháp chế phải đối chiếu bản gốc (doc_intake --verify) trước`,
      ];
    }
  }
  try {
    // v15.4 (P10.1): ghi qua function SECURITY DEFINER — khối legal_hr theo login (`human_actor`),
    // DB kiểm lại chuyển trạng thái/scan.
    await callHuman(
      db,
      'select xnqc_set_status_human($1::bigint, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9)',
      [id, cur, status, pyStrip(by), so, nop, cap, het, sha || null],
      {
        by,
        block: 'legal_hr',
        action: 'set_status',
        objectType: 'xnqc_dossier',
        objectId: id,
        env: o.env,
      },
    );
  } catch (e) {
    if (e instanceof HumanDenied) return [false, `DB từ chối: ${e.message}`];
    if (e instanceof RangeError) {
      if (e.message.includes('vừa đổi trạng thái')) {
        return [false, `hồ sơ #${id} vừa đổi trạng thái — thử lại`];
      }
      return [false, `DB từ chối: ${cpHead(maskPii(e.message), 200)}`];
    }
    if (isDbError(e)) return [false, `DB từ chối: ${dbMsg(e)}`];
    throw e;
  }
  let msg = `hồ sơ #${id}: ${cur} → ${status}`;
  if (SYNC_AFTER.includes(status)) {
    try {
      const ids = await syncGolden(db, o.today, AGENT, o);
      msg += ids.length
        ? `; đề xuất đồng bộ golden mục [${ids.join(', ')}]`
        : '; golden không lệch / đã có đề xuất chờ duyệt';
    } catch (e) {
      if (!(e instanceof RangeError || isDbError(e))) throw e;
      msg += `; CHƯA đề xuất đồng bộ golden (${errName(e)})`;
    }
  }
  return [true, msg];
}

/** Giấy còn hiệu lực ở `today`: đã cấp (ngày cấp không sau `today` — dòng ghi thẳng DB với ngày cấp
 * tương lai KHÔNG tính) và chưa hết hạn. */
export function validCap(d: Dossier, today: string): boolean {
  return (
    d.status === 'da_cap' &&
    d.ngay_cap !== null &&
    d.ngay_cap <= today &&
    (d.ngay_het_han === null || d.ngay_het_han >= today)
  );
}

/** Hồ sơ của 1 SKU → `xnqc_status` golden nên có. THUẦN. */
export function goldenTarget(rows: Dossier[], today: string): string {
  if (rows.some((d) => validCap(d, today))) return 'approved';
  if (rows.some((d) => d.status === 'da_nop' || d.status === 'bo_sung')) return 'pending';
  return 'none';
}

/** [id mục, đích, trạng thái mục]. */
type SyncItem = [string, string, string];

/** Mục `golden_xnqc_sync` pending/approved theo SKU, cũ → mới (CHỈ SELECT) → {sku: [(id, đích,
 * status)]}. object_id `<sku>:<đích>` hoặc `<sku>:<đích>@<id mục bị thay>`. */
async function syncItems(db: Db): Promise<Map<string, SyncItem[]>> {
  const { rows } = await db.query<{ id: string; object_id: string; status: string }>(
    "select id::text as id, object_id, status from approval_queue where object_type = 'golden_xnqc_sync'" +
      " and status in ('pending', 'approved') order by id",
  );
  const out = new Map<string, SyncItem[]>();
  for (const r of rows) {
    const i = r.object_id.indexOf(':');
    const sku = i < 0 ? r.object_id : r.object_id.slice(0, i);
    const rest = i < 0 ? '' : r.object_id.slice(i + 1);
    const j = rest.indexOf('@');
    const xs = out.get(sku) ?? [];
    xs.push([r.id, j < 0 ? rest : rest.slice(0, j), r.status]);
    out.set(sku, xs);
  }
  return out;
}

type GoldenRow = [string, unknown, string, Dossier[], SyncItem[]];

/** → [(sku, golden hiện tại, đích theo hồ sơ, hồ sơ, mục đề xuất)]. */
async function goldenState(db: Db, today: string, goldenFile?: string): Promise<GoldenRow[]> {
  const [doc, err] = readGolden(goldenFile);
  if (err !== null || doc === null) throw new RangeError(err ?? 'golden');
  const bySku = new Map<string, Dossier[]>();
  for (const d of await listDossiers(db)) {
    bySku.set(d.sku_key, [...(bySku.get(d.sku_key) ?? []), d]);
  }
  const items = await syncItems(db);
  return skusOf(doc).map((s) => {
    const sku = skuKey(s);
    const rows = bySku.get(sku) ?? [];
    const cur = Object.hasOwn(s, 'xnqc_status') ? s.xnqc_status : 'none';
    return [sku, cur, goldenTarget(rows, today), rows, items.get(sku) ?? []];
  });
}

/** So `goldenTarget` với golden file → ĐỀ XUẤT vào hàng duyệt → id mục mới. Mục mới nhất
 * (pending/approved) của SKU luôn khớp đích hiện tại: đã khớp → bỏ qua; lệch → mục mới ghi "THAY THẾ
 * mục #X" cho mọi mục cũ trái đích (gồm mục đã duyệt mà golden chưa sửa). Đích = golden nhưng còn mục
 * cũ trái đích → mục "GIỮ NGUYÊN". Agent KHÔNG tự quyết/rút mục nào. */
export async function syncGolden(
  db: Db,
  today: string,
  createdBy: string = AGENT,
  o: { goldenFile?: string; directorsDir?: string; cfg?: DirectorConfig } = {},
): Promise<bigint[]> {
  const cfg = o.cfg ?? loadConfig('legal_hr', o.directorsDir);
  const ids: bigint[] = [];
  for (const [sku, cur, target, rows, mine] of await goldenState(db, today, o.goldenFile)) {
    const last = mine.length ? (mine[mine.length - 1] as SyncItem) : null;
    if (last ? last[1] === target : target === cur) continue;
    const stale = mine.filter((i) => i[2] === 'pending' && i[1] !== target);
    if (last && last[2] === 'approved' && last[1] !== cur) stale.push(last); // đã duyệt, golden chưa sửa
    let oid = `${sku}:${target}`;
    if (mine.some((i) => i[2] === 'pending' && i[1] === target)) oid += `@${last?.[0]}`;
    const cap = rows.filter((d) => validCap(d, today));
    const nop = rows.filter((d) => d.status === 'da_nop' || d.status === 'bo_sung');
    const basis = cap.length ? cap : nop.length ? nop : rows;
    const b = basis[basis.length - 1];
    const why = b
      ? `hồ sơ #${b.id} (${b.status}, xác nhận bởi ${safe(b.updated_by)})`
      : 'không có hồ sơ nào';
    const repl = stale.length
      ? ` THAY THẾ mục ${stale.map((i) => `#${i[0]}`).join(', ')} — chỉ duyệt mục mới nhất, KHÔNG sửa golden theo mục cũ.`
      : '';
    const c = pyStr(cur);
    let title: string;
    let payload: string;
    if (target === cur) {
      title = `Giữ XNQC golden: ${sku} ${c} (thay mục cũ)`;
      payload = `Đề xuất GIỮ NGUYÊN data/golden_skus.json: ${sku} xnqc_status ${c} theo ${why}.${repl} Agent không ghi file golden.`;
    } else {
      title = `Đồng bộ XNQC golden: ${sku} ${c}→${target}`;
      payload =
        `Đề xuất sửa data/golden_skus.json: ${sku} xnqc_status ${c}→${target} theo ${why}; sau khi duyệt, người phụ` +
        ` trách golden sửa file rồi chạy \`python -m ingest.golden_store\`.${repl} Agent không ghi file golden.`;
    }
    ids.push(
      await submit(db, {
        block: 'legal_hr',
        objectType: 'golden_xnqc_sync',
        objectId: oid,
        title,
        payload,
        createdBy,
        cfg,
      }),
    );
  }
  return ids;
}

/** CHỈ ĐỌC (SELECT + golden file) → dòng nhắc cho `--sync-golden` và báo cáo Pháp chế §1: mục
 * pending LỖI THỜI, mục đã duyệt chờ người sửa golden / đã duyệt nhưng lỗi thời, golden lệch chưa
 * có đề xuất. */
export async function syncNotes(db: Db, today: string, goldenFile?: string): Promise<string[]> {
  const out: string[] = [];
  for (const [sku, cur, target, , mine] of await goldenState(db, today, goldenFile)) {
    const c = pyStr(cur);
    for (const [qid, t, st] of mine) {
      if (st === 'pending' && t !== target) {
        out.push(
          `mục #${qid} ${sku}→${t} LỖI THỜI (hồ sơ hiện suy ra ${target}) — KHÔNG duyệt mục này`,
        );
      }
    }
    const last = mine[mine.length - 1];
    if (last && last[2] === 'approved' && last[1] !== cur) {
      const [qid, t] = last;
      out.push(
        t === target
          ? `mục #${qid} ${sku}→${t} đã duyệt — chờ người sửa golden (đang ${c}) rồi chạy python -m ingest.golden_store`
          : `mục #${qid} ${sku}→${t} đã duyệt nhưng LỖI THỜI (hồ sơ hiện suy ra ${target}) — KHÔNG sửa golden theo mục này`,
      );
    }
    if (target !== cur && !mine.some(([, t]) => t === target)) {
      out.push(
        `${sku}: golden ${c} lệch hồ sơ (${target}) — chưa có đề xuất, chạy python -m agents.xnqc --sync-golden`,
      );
    }
  }
  return out;
}

const days = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export type RemindCfg = {
  dot2_han_nop: string;
  nhac_truoc_ngay: number;
  het_han_canh_bao_ngay: number;
};

/** Nhắc mốc đợt 2 + giấy sắp/đã hết hạn. THUẦN. */
export function reminders(
  rows: Dossier[],
  tpbvsk: string[],
  cfg: RemindCfg,
  today: string,
): string[] {
  const han = cfg.dot2_han_nop;
  const lead = cfg.nhac_truoc_ngay;
  const n = days(han, today);
  const out: string[] = [];
  for (const sku of tpbvsk) {
    const mine = rows.filter((d) => d.sku_key === sku);
    if (mine.some((d) => validCap(d, today) || d.status === 'da_nop' || d.status === 'bo_sung')) {
      continue;
    }
    if (n < 0) {
      out.push(`QUÁ HẠN đợt 2 — ${sku}: hạn ${dmy(han)} đã qua ${-n} ngày, chưa nộp hồ sơ`);
    } else if (n <= lead) {
      out.push(`SẮP HẠN — ${sku}: hạn đợt 2 ${dmy(han)} còn ${n} ngày, chưa nộp hồ sơ`);
    } else {
      out.push(`CHƯA NỘP — ${sku}: hạn đợt 2 ${dmy(han)} còn ${n} ngày`);
    }
  }
  for (const d of rows) {
    const het = d.ngay_het_han;
    if (d.status !== 'da_cap' || het === null) continue;
    const left = days(het, today);
    if (left < 0) {
      out.push(
        `ĐÃ QUÁ HẠN — Pháp chế chuyển het_han: hồ sơ #${d.id} ${d.sku_key} hết hạn ${dmy(het)}`,
      );
    } else if (left <= cfg.het_han_canh_bao_ngay) {
      out.push(`SẮP HẾT HẠN — hồ sơ #${d.id} ${d.sku_key} hết hạn ${dmy(het)} còn ${left} ngày`);
    }
  }
  return out;
}

// ------------------------------------------------------- docx P2 soạn nháp (legal_hr-02)
// PL01 Pháp chế "Soạn hồ sơ xác nhận nội dung quảng cáo TPBVSK, theo dõi kết quả": `--draft` dựng
// NHÁP từ dữ liệu sẵn có (golden: tên, quy cách, số/ngày tiếp nhận công bố; claims đã công bố đúng
// SKU; maket người đưa vào) + danh mục thành phần `data/xnqc_draft.json` (GIẢ ĐỊNH chờ Pháp chế) →
// 1 mục hàng duyệt. Agent KHÔNG nộp, KHÔNG đổi trạng thái sổ.

/** Python `path.read_text(encoding="utf-8")` + `json.loads` (BOM = hỏng). */
function readJsonText(path: string): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    throw new RangeError(`${basename(path)} không đọc được (${pyOsName(e)})`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new RangeError(`${basename(path)} không đọc được (UnicodeDecodeError)`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RangeError(`${basename(path)} không đọc được (JSONDecodeError)`);
  }
}

export type DraftCfg = Dict & { thanh_phan: string[] };

export function loadDraftConfig(path: string = DRAFT_FILE): DraftCfg {
  const doc = readJsonText(path);
  const parts = isDict(doc) ? doc.thanh_phan : undefined;
  if (
    !(
      Array.isArray(parts) &&
      parts.length &&
      parts.every((x) => typeof x === 'string' && pyStrip(x) !== '')
    )
  ) {
    throw new RangeError(`${basename(path)}: thanh_phan phải là danh sách chữ`);
  }
  return doc as DraftCfg;
}

/** THUẦN → nội dung nháp hồ sơ (markdown, không PII). */
export function draftPayload(
  sku: Dict,
  loai: string,
  ten: string,
  claims: unknown[],
  cfg: Dict,
  maket: string | null | undefined,
): string {
  const duyet = cfg.trang_thai === 'da_duyet';
  const L = [
    `# NHÁP hồ sơ XNQC — ${safe(pyTruthy(sku.name) ? sku.name : sku.sku_key)}`,
    '',
    `- SKU: ${pyStr(sku.sku_key)} · loại hồ sơ: ${loai} · tên: ${safe(ten)}`,
    `- Quy cách: ${safe(pyTruthy(sku.pack_spec) ? sku.pack_spec : 'chưa có trong golden')}`,
    pyTruthy(sku.receipt_no)
      ? `- Số tiếp nhận bản công bố: ${safe(sku.receipt_no)} ngày ${safe(pyTruthy(sku.receipt_date) ? sku.receipt_date : '?')}`
      : '- Số tiếp nhận bản công bố: CHƯA CÓ trong golden — bổ sung',
    '',
    '## Nội dung được nêu (claims đã công bố đúng SKU)',
  ];
  L.push(...(claims.length ? claims.map((c) => `- ${safe(c)}`) : ['- (chưa có claim đã công bố)']));
  L.push(
    '',
    `## Thành phần hồ sơ cần chuẩn bị${duyet ? '' : ' (danh mục CHƯA được Pháp chế duyệt)'}`,
  );
  L.push(...(cfg.thanh_phan as unknown[]).map((x) => `- [ ] ${safe(x)}`));
  if (maket) L.push('', '## Maket / kịch bản đưa vào', '', pyStrip(maket));
  L.push(
    '',
    'Agent chỉ soạn nháp — Pháp chế rà, hoàn thiện, nộp; ghi sổ bằng `python -m agents.xnqc --add/--set ... --by <tên>`.',
  );
  return `${L.join('\n')}\n`;
}

/** Python `for c in claims` cho giá trị JSON (chuỗi → từng ký tự, object → khóa). */
function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

export type DraftOpts = {
  io?: Io;
  goldenFile?: string;
  claimsFile?: string;
  draftFile?: string;
  directorsDir?: string;
};

/** → [payload, id mục hàng duyệt | null khi chỉ in]. SKU phải là TPBVSK trong golden; maket qua
 * guardrail đăng bài (vi phạm → vẫn soạn nháp, ghi rõ để Pháp chế sửa — không phải bài đăng). Chạy
 * lại cùng nội dung = đã có mục chờ (unique pending) → bỏ qua, trả mục cũ. */
export async function draft(
  db: Db | null,
  sku: string,
  loai: string,
  ten: string,
  maket: string | null | undefined,
  doSubmit: boolean,
  o: DraftOpts = {},
): Promise<[string, bigint | null]> {
  const io = o.io ?? STD_IO;
  const [doc, err] = readGolden(o.goldenFile);
  if (err !== null || doc === null) throw new RangeError(err ?? 'golden');
  const list = Array.isArray(doc.skus) ? doc.skus : [];
  const s = list.find((x) => isDict(x) && x.sku_key === sku) as Dict | undefined;
  if (s === undefined || s.category !== 'tpbvsk') {
    throw new RangeError(`SKU '${sku}' không phải TPBVSK trong golden`);
  }
  const allClaims = readJsonText(o.claimsFile ?? CLAIMS_FILE);
  if (!isDict(allClaims))
    throw new TypeError("claims_whitelist: 'get' trên giá trị không phải dict");
  const cl = allClaims[sku];
  const ac = pyTruthy(cl) && isDict(cl) ? cl.approved_claims : undefined;
  const claims = pyTruthy(ac) ? pyIter(ac) : [];
  let payload = draftPayload(s, loai, ten, claims, loadDraftConfig(o.draftFile), maket);
  if (maket) {
    const v = checkPublish(maket, { channel: 'facebook', contentType: 'post', sku });
    const codes = [...new Set(v.violations.map((x) => x.code || x.type))].sort(cpCmp);
    payload += `\nGuardrail maket: ${codes.join(', ') || 'đạt'}\n`;
  }
  if (!doSubmit) return [payload, null];
  const oid = `${sku}:${loai}:${createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12)}`;
  const conn = db as Db;
  try {
    const qid = await submit(conn, {
      block: 'legal_hr',
      objectType: 'xnqc_dossier',
      objectId: oid,
      title: `Nháp hồ sơ XNQC ${sku} (${loai})`,
      payload,
      createdBy: DRAFT_AGENT,
      cfg: o.directorsDir === undefined ? undefined : loadConfig('legal_hr', o.directorsDir),
    });
    return [payload, qid];
  } catch (e) {
    if (!isUnique(e)) throw e;
    // r12 D4: chạy lại cùng nội dung = đã có mục chờ (unique pending) — bỏ qua, trả mục cũ.
    const { rows } = await conn.query<{ id: string }>(
      "select id::text as id from approval_queue where object_type = 'xnqc_dossier' and object_id = $1 and status = 'pending'",
      [oid],
    );
    const qid = rows[0] ? BigInt(rows[0].id) : null;
    io.out(
      `[skip] nháp hồ sơ cùng nội dung đã có mục chờ${qid !== null ? ` #${qid}` : ''} — không ghi thêm`,
    );
    return [payload, qid];
  }
}
