import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { isDict } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { cpHead, pyStrip } from '@samsam/core/security/py';
import {
  classifySocial,
  futureLimit,
  isoTs,
  kw,
  msgHash,
  newImport,
  PRE_MAX,
  parseTable,
  readPyJson,
  type SocialRules,
  text,
} from './intel-import.js';

// Port `ingest/social_vendor.py` (v10.3, WP16 nền P2 — "Ingest dữ liệu social listening từ nhà cung
// cấp, nếu TGĐ duyệt"). FAIL-CLOSED theo TGĐ: `data/social_vendor.json` thiếu / JSON hỏng /
// `vendor_approved_by_tgd` không phải đúng `true` JSON (kể cả "true" chuỗi, 1) / `approval_ref` rỗng
// → `[blocked]`, exit 2, KHÔNG đọc file, KHÔNG connect. File config CHỈ người thật đổi sau khi TGĐ
// duyệt hợp đồng + DPA. Ghi DUY NHẤT `intel_imports` + `social_mentions_vendor` — KHÔNG ghi
// `social_mentions` (kênh sở hữu: báo cáo intel tuần không trộn dữ liệu bên thứ ba). Không request
// mạng, không LLM, không trả lời. PII/nhãn/hash/excerpt TÁI DÙNG v7.2 (intel-import.ts).

export const CONFIG_FILE = dataPath('social_vendor.json');

export const V_REQUIRED = ['thoi_gian', 'nen_tang', 'noi_dung'];
export const V_OPTIONAL = ['ma_tin', 'id_tac_gia', 'loai'];
// Định danh tác giả/URL bài/cảm xúc của vendor: BỎ NGAY khi đọc (cột lạ khác → lỗi cả file).
export const V_DROP = [
  'ten_tac_gia',
  'link_tac_gia',
  'avatar',
  'so_nguoi_theo_doi',
  'email',
  'sdt',
  'url_bai',
  'cam_xuc_vendor',
];
export const PLATFORMS = ['facebook', 'tiktok', 'youtube', 'instagram', 'forum', 'news', 'khac'];
export const V_KINDS = ['post', 'comment', 'review'];

/** `check_approval` → null = TGĐ đã duyệt; ngược lại lý do chặn (fail-closed). */
export function checkApproval(path: string = CONFIG_FILE): string | null {
  const got = readPyJson(path);
  if ('err' in got) return `${basename(path)}: không đọc được (${got.err})`;
  const raw = got.v;
  if (!isDict(raw)) return `${basename(path)}: gốc phải là object`;
  if (raw.vendor_approved_by_tgd !== true) return 'vendor_approved_by_tgd chưa là true';
  const ref = raw.approval_ref;
  if (typeof ref !== 'string' || !pyStrip(ref)) return 'approval_ref rỗng';
  return null;
}

export type VendorRow = {
  row_no: number;
  platform: string;
  kind: string;
  posted_at: string;
  /** vật liệu hash dedup (chỉ RAM). */
  key: string;
  labels: string[];
  sensitive: boolean;
  excerpt: string | null;
};

/** `read_vendor` (thuần): export vendor → [rows, lỗi, sha]. Cột định danh tác giả bỏ NGAY. */
export async function readVendor(
  path: string,
  rules: SocialRules,
  now: Date = new Date(),
): Promise<[VendorRow[], string[], string | null]> {
  const [recs, errs0, sha] = await parseTable(path, V_REQUIRED, V_OPTIONAL, V_DROP);
  if (errs0.length) return [[], errs0, sha];
  const errs: string[] = [];
  const limit = futureLimit(now);
  const rows: VendorRow[] = [];
  for (const [n, r] of recs) {
    const bad: string[] = [];
    const ts = isoTs(r.thoi_gian);
    if (ts === null || ts.ms > limit) bad.push('thoi_gian');
    const plat = kw(r.nen_tang || '');
    if (!PLATFORMS.includes(plat)) bad.push('nen_tang');
    const kind = kw(r.loai || 'post');
    if (!V_KINDS.includes(kind)) bad.push('loai');
    const t = text(r.noi_dung, PRE_MAX); // che NGAY khi đọc
    if (!t) bad.push('noi_dung');
    if (bad.length || ts === null) {
      for (const c of bad) errs.push(`dòng ${n}: cột '${c}' không hợp lệ`);
      continue;
    }
    const labels = classifySocial(t, rules);
    const sensitive = labels.includes('hoi_suc_khoe');
    const key = r.ma_tin ? `id:${r.ma_tin}` : `u:${r.id_tac_gia || ''}|${r.thoi_gian}|${t}`;
    rows.push({
      row_no: n,
      platform: plat,
      kind,
      posted_at: ts.iso,
      key,
      labels,
      sensitive,
      excerpt: rules.dpia_signed === true && !sensitive ? cpHead(t, 200) : null,
    });
  }
  if (errs.length) return [[], errs, sha];
  return [rows, [], sha];
}

/** `load_vendor` → [import_id, mới, trùng] — không commit. Dedup `on conflict (msg_hash)`. */
export async function loadVendor(
  db: Db,
  rows: VendorRow[],
  salt: string,
  fileName: string,
  sha: string,
): Promise<[number, number, number]> {
  const iid = await newImport(db, 'social', 'vendor', fileName, sha, rows.length);
  let fresh = 0;
  for (const r of rows) {
    const { rows: got } = await db.query(
      'insert into social_mentions_vendor (import_id, platform, kind, posted_at, msg_hash, labels, sensitive, excerpt) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (msg_hash) do nothing returning id',
      [
        iid,
        r.platform,
        r.kind,
        r.posted_at,
        msgHash(salt, `vendor:${r.platform}`, r.key),
        r.labels,
        r.sensitive,
        r.excerpt,
      ],
    );
    if (got.length) fresh++;
  }
  return [iid, fresh, rows.length - fresh];
}
