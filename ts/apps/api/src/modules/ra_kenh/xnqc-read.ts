import { readFileSync, statSync } from 'node:fs';
import type { Db } from '@samsam/core/ops/deps';
import { dmy } from '@samsam/core/ops/period';
import { dataPath } from '@samsam/core/paths';
import { pyStrip } from '@samsam/core/security/py';

// Phần CHỈ ĐỌC của `agents/xnqc.py` mà báo cáo Pháp chế tuần (`ra_kenh --report`) dùng:
// `list_dossiers`, `tpbvsk_skus`, `golden_target`, `_valid_cap`, `_sync_items`, `sync_notes`,
// `reminders`. shortcut: bản sao tối thiểu trong nhóm ra_kenh (nhóm xnqc chưa port) — khi port
// `agents/xnqc.py` thì import từ đó và xóa tệp này. Không ghi gì.

export const STATUSES = ['chuan_bi', 'da_nop', 'bo_sung', 'da_cap', 'het_han'];
export const GOLDEN_FILE = dataPath('golden_skus.json');

export type Dossier = {
  id: string;
  sku_key: string;
  loai_ho_so: string;
  ten_ho_so: string;
  status: string;
  so_giay: string | null;
  ngay_nop: string | null;
  ngay_cap: string | null;
  ngay_het_han: string | null;
  document_sha256: string | null;
  updated_by: string | null;
};

export async function listDossiers(db: Db): Promise<Dossier[]> {
  const { rows } = await db.query<Dossier>(
    'select id::text as id, sku_key, loai_ho_so, ten_ho_so, status, so_giay,' +
      ' ngay_nop::text as ngay_nop, ngay_cap::text as ngay_cap, ngay_het_han::text as ngay_het_han,' +
      ' document_sha256, updated_by from xnqc_dossiers order by sku_key, id',
  );
  return rows;
}

type GoldenSku = { sku_key: string; category?: unknown; xnqc_status?: unknown };

/** `golden_store.read_golden` (thiếu/không UTF-8/rỗng/JSON hỏng/0 SKU → lỗi) → danh sách SKU. */
function goldenSkus(path: string = GOLDEN_FILE): GoldenSku[] {
  let ok = false;
  try {
    ok = statSync(path).isFile();
  } catch {}
  if (!ok) throw new RangeError(`thiếu file ${path}`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new RangeError(`${path} không phải UTF-8`);
  }
  if (!pyStrip(text)) throw new RangeError(`${path} rỗng`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new RangeError(`${path} JSON hỏng`);
  }
  const skus = (doc as { skus?: unknown } | null)?.skus;
  if (
    typeof doc !== 'object' ||
    doc === null ||
    Array.isArray(doc) ||
    !Array.isArray(skus) ||
    !skus.length
  ) {
    throw new RangeError(`${path} không có SKU nào (0 record) — không nạp`);
  }
  return skus as GoldenSku[];
}

export function tpbvskSkus(path?: string): string[] {
  return goldenSkus(path)
    .filter((s) => s.category === 'tpbvsk')
    .map((s) => s.sku_key);
}

/** Giấy còn hiệu lực ở `today` (ngày cấp không sau `today`, chưa hết hạn). */
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
  if (rows.some((d) => ['da_nop', 'bo_sung'].includes(d.status))) return 'pending';
  return 'none';
}

type SyncItem = [string, string, string];

/** Mục `golden_xnqc_sync` pending/approved theo SKU, cũ → mới → {sku: [(id, đích, status)]}. */
async function syncItems(db: Db): Promise<Map<string, SyncItem[]>> {
  const { rows } = await db.query<{ id: string; object_id: string; status: string }>(
    "select id::text as id, object_id, status from approval_queue where object_type = 'golden_xnqc_sync' and status in ('pending', 'approved') order by id",
  );
  const out = new Map<string, SyncItem[]>();
  for (const r of rows) {
    const i = r.object_id.indexOf(':');
    const sku = i < 0 ? r.object_id : r.object_id.slice(0, i);
    const rest = i < 0 ? '' : r.object_id.slice(i + 1);
    const target = rest.split('@')[0] as string;
    const xs = out.get(sku) ?? [];
    xs.push([r.id, target, r.status]);
    out.set(sku, xs);
  }
  return out;
}

/** CHỈ ĐỌC → dòng nhắc cho báo cáo Pháp chế §1: mục pending LỖI THỜI, mục đã duyệt chờ người sửa
 * golden / lỗi thời, golden lệch chưa có đề xuất. */
export async function syncNotes(db: Db, today: string, golden?: string): Promise<string[]> {
  const skus = goldenSkus(golden);
  const bySku = new Map<string, Dossier[]>();
  for (const d of await listDossiers(db)) {
    bySku.set(d.sku_key, [...(bySku.get(d.sku_key) ?? []), d]);
  }
  const items = await syncItems(db);
  const out: string[] = [];
  for (const s of skus) {
    const sku = s.sku_key;
    const cur = (s.xnqc_status ?? 'none') as string;
    const target = goldenTarget(bySku.get(sku) ?? [], today);
    const mine = items.get(sku) ?? [];
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
          ? `mục #${qid} ${sku}→${t} đã duyệt — chờ người sửa golden (đang ${cur}) rồi chạy python -m ingest.golden_store`
          : `mục #${qid} ${sku}→${t} đã duyệt nhưng LỖI THỜI (hồ sơ hiện suy ra ${target}) — KHÔNG sửa golden theo mục này`,
      );
    }
    if (target !== cur && !mine.some(([, t]) => t === target)) {
      out.push(
        `${sku}: golden ${cur} lệch hồ sơ (${target}) — chưa có đề xuất, chạy python -m agents.xnqc --sync-golden`,
      );
    }
  }
  return out;
}

const days = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Nhắc mốc đợt 2 + giấy sắp/đã hết hạn. THUẦN. */
export function reminders(
  rows: Dossier[],
  tpbvsk: string[],
  cfg: { dot2_han_nop: string; nhac_truoc_ngay: number; het_han_canh_bao_ngay: number },
  today: string,
): string[] {
  const han = cfg.dot2_han_nop;
  const lead = cfg.nhac_truoc_ngay;
  const n = days(han, today);
  const out: string[] = [];
  for (const sku of tpbvsk) {
    const mine = rows.filter((d) => d.sku_key === sku);
    if (mine.some((d) => validCap(d, today) || ['da_nop', 'bo_sung'].includes(d.status))) continue;
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
