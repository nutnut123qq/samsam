import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, loadConfig as loadDirector, submit } from '@samsam/core/ops/director';
import { contentSha256 } from '@samsam/core/ops/store';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/counters';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { callHuman } from '@samsam/core/security/auth';
import {
  cpHead,
  cpLen,
  pySplit,
  pyStr,
  pyStrip,
  pyTruthy,
  splitlines,
} from '@samsam/core/security/py';
import { KocConfigError, loadKocs } from '../mkt_koc_ugc_seo/mkt-koc.js';
import {
  bodyRows,
  byError,
  checkUrl,
  counter,
  csvRecords,
  type Dict,
  ExportError,
  hooks,
  isoDay,
  MAX_TEXT,
  normChannel,
  osErrName,
  readCsvFile,
  rules,
} from './ra-kenh.js';

// v14.5 marketing-04.2 (PL01 Marketing — KOC và đại lý affiliate: "kiểm tra bài đăng của đối
// tác") — port khối "v14.5 đối tác" của `agents/ra_kenh.py`. Nguồn = file xuất tay bài KOC/đại lý
// ĐÃ đăng. Tách hẳn khỏi luồng kênh SỞ HỮU (bảng `partner_post_scans`, loại việc
// `marketing/partner_post_review`):
//   - Kiểm TOÀN file trước khi connect; chỉ nhận MÃ đối tác (không tên/handle/SĐT — cột lạ bị từ
//     chối); mã phải có trong sổ KOC (`data/koc_sample.json`) hoặc sổ đại lý (`dealers`) — lạ →
//     theo chính sách `data/partner_policy.json` (GĐ Marketing chọn): "tu_choi_file" (MẶC ĐỊNH an
//     toàn khi CHƯA CHỌN/cấu hình lỗi) | "ghi_vi_pham" (vi phạm `doi_tac_chua_dang_ky` ≥ S2).
//   - Rà theo kênh: `checkPublish(contentType="koc", isSponsored=true, isAi=false)`.
//   - Đối chiếu bộ tài liệu chuẩn ĐÃ duyệt (kit KOC `marketing/koc_brief` khớp hash duyệt, hoặc
//     kit affiliate đại lý). Không có → `thieu_bo_tai_lieu`; SKU ngoài kit → `sku_ngoai_bo_tai_lieu`;
//     claim ngoài "Điểm được nói" → `ngoai_bo_tai_lieu`.
//   - Đợt theo (mã đối tác, URL): rà khác lần trước → 1 dòng sổ; vi phạm → 1 mục hàng duyệt (đợt
//     mới, kể cả bài quay lại bản cũ sau một lần sạch); trùng lần trước → bỏ qua.
//   - Không lưu text/URL đầy đủ (URL có thể chứa handle cá nhân) — sha256 + tên miền NỀN TẢNG.
//     Agent KHÔNG liên hệ đối tác, không gỡ/sửa bài.

export const PARTNER_AGENT = 'agent:mkt_doi_tac';
export const PARTNER_FEATURE = 'marketing-04.2';
export const OT_PARTNER = 'partner_post_review';
export const PARTNER_REQUIRED = ['ma_doi_tac', 'url', 'kenh', 'text', 'ngay_dang'];
export const PARTNER_OPTIONAL = ['sku'];
export const THIEU_KIT = 'thieu_bo_tai_lieu';
export const NGOAI_KIT = 'ngoai_bo_tai_lieu';
export const SKU_NGOAI_KIT = 'sku_ngoai_bo_tai_lieu';
export const PARTNER_POLICY_FILE = dataPath('partner_policy.json');
export const UNKNOWN_POLICIES = ['tu_choi_file', 'ghi_vi_pham'];
export const UNKNOWN_PARTNER = 'doi_tac_chua_dang_ky';
const PARTNER_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const KIT_HEAD_RE = /^# Kit KOC (KOC-MAU-\p{Nd}{2}) — `([^`\n]+)` × /u;
// Python `^### Bài #\d+ — `…`$` cờ MULTILINE (`$` chỉ trước `\n`, không trước `\r`).
const AFF_SKU_RE = /(?<=^|\n)### Bài #\p{Nd}+ — `([^`\n]+)`(?=\n|$)/gu;
const SLD = new Set(['com', 'net', 'org', 'edu', 'gov', 'co', 'ac']);
const DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;

export type PartnerRow = {
  line: number;
  partner: string;
  url: string;
  url_sha: string;
  host: string;
  channel: string;
  posted_on: string;
  sku: string | null;
  text: string;
  sha: string;
};

/** Tên miền NỀN TẢNG (bỏ subdomain): `chilan.blogspot.com` → `blogspot.com`, `abc.com.vn` giữ —
 * subdomain/đường dẫn có thể là handle cá nhân KOC. */
export function site(host: string): string {
  let h = host.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  const parts = h.split('.');
  const n =
    parts.length >= 3 &&
    cpLen(parts[parts.length - 1] as string) === 2 &&
    SLD.has(parts[parts.length - 2] as string)
      ? 3
      : 2;
  return parts.slice(-n).join('.');
}

/** `_iso_date(v, "ngay_dang")` → ngày | null (sai dạng / không có thật). */
function partnerDate(v: string): string | null {
  const s = pyStrip(v);
  return DATE_RE.test(s) ? isoDay(s) : null;
}

/** Đọc + kiểm TOÀN file bài đối tác TRƯỚC khi connect. Lỗi → ExportError (chỉ 'dòng N cột X: lý
 * do' — KHÔNG kèm giá trị ô). */
export function readPartnerExport(path: string): PartnerRow[] {
  const raw = readCsvFile(path);
  const r = rules();
  const recs = csvRecords(raw);
  if (!recs.length) throw new ExportError(['file rỗng']);
  const head = (recs[0] as string[]).map((h) => pyStrip(h).toLowerCase());
  const errs: string[] = [];
  if (head.some((h) => !h)) errs.push('dòng 1: có cột header rỗng');
  if ([...counter(head)].some(([h, k]) => h && k > 1)) errs.push('dòng 1: header trùng');
  const known = [...PARTNER_REQUIRED, ...PARTNER_OPTIONAL];
  const stray = head.filter((h) => h && !known.includes(h));
  if (stray.length) {
    errs.push(
      `dòng 1: ${stray.length} cột lạ — chỉ nhận ${pyStr(known)} (MÃ đối tác, không tên/handle/liên hệ cá nhân)`,
    );
  }
  const miss = PARTNER_REQUIRED.filter((c) => !head.includes(c));
  if (miss.length) errs.push(`dòng 1: thiếu cột bắt buộc ${pyStr(miss)}`);
  if (errs.length) throw new ExportError(errs);
  const body = bodyRows(recs);
  const out: PartnerRow[] = [];
  const seen = new Map<string, number>();
  for (const [n, row] of body) {
    if (row.length !== head.length) {
      errs.push(`dòng ${n}: số ô ${row.length} ≠ số cột ${head.length}`);
      continue;
    }
    const c = new Map(head.map((h, i) => [h, row[i] as string]));
    const bad = (col: string, why: string) => errs.push(`dòng ${n} cột ${col}: ${why}`);
    for (const [col, v] of c) if (v.includes('\x00')) bad(col, 'chứa ký tự NUL');
    const code = pyStrip(c.get('ma_doi_tac') as string);
    if (!PARTNER_RE.test(code)) {
      bad('ma_doi_tac', 'cần MÃ đối tác (A-Z 0-9 _ -, 2..40 ký tự) — không tên/handle');
    }
    const [url, host, uerr] = checkUrl(c.get('url') as string, 253);
    if (uerr) bad('url', uerr);
    else if (seen.has(url)) bad('url', `trùng URL với dòng ${seen.get(url)} (mơ hồ)`);
    if (!seen.has(url)) seen.set(url, n);
    const [ch, okCh] = normChannel(c.get('kenh') as string, r);
    if (!okCh) bad('kenh', `kênh không hợp lệ — nhận ${pyStr(r.channels)}`);
    const posted = partnerDate(c.get('ngay_dang') as string);
    if (posted === null) bad('ngay_dang', 'cần ngày YYYY-MM-DD hợp lệ');
    const sku = pyStrip(c.get('sku') ?? '') || null;
    if (sku !== null && !r.golden.has(sku)) bad('sku', 'SKU không có trong golden');
    const text = (c.get('text') as string).replaceAll('\r\n', '\n');
    if (!pyStrip(text)) bad('text', 'rỗng');
    else if (cpLen(text) > MAX_TEXT) bad('text', `dài quá ${MAX_TEXT} ký tự`);
    out.push({
      line: n,
      partner: code,
      url,
      url_sha: contentSha256(url),
      host: site(host),
      channel: ch,
      posted_on: posted as string,
      sku,
      text,
      sha: contentSha256(text),
    });
  }
  if (errs.length) throw new ExportError(errs);
  return out;
}

/** Các dòng '- …' của mục "## Điểm được nói" trong kit KOC đã duyệt. */
export function kitClaims(payload: string | null): Set<string> {
  const out = new Set<string>();
  let inside = false;
  for (const line of splitlines(payload || '')) {
    if (line.startsWith('## ')) inside = pyStrip(line) === '## Điểm được nói';
    else if (inside && line.startsWith('- ')) out.add(pyStrip(line.slice(2)));
  }
  return out;
}

/** Payload = đúng bản đã duyệt (hash `approvals`) — SO, không phát hành nên không qua cổng DÙNG. */
async function verified(db: Db, otype: string, oid: string, payload: string): Promise<boolean> {
  const r = await db.query('select verify_publish($1, $2, $3) as ok', [otype, oid, payload]);
  return r.rows[0]?.ok === true;
}

export type Kit = { skus: Set<string>; claims: Set<string> | null; refs: string[] };

/** CHỈ SELECT → {mã đối tác: kit} từ bộ tài liệu chuẩn ĐÃ duyệt. */
export async function partnerKits(db: Db): Promise<Map<string, Kit>> {
  const kits = new Map<string, Kit>();
  const briefs = await db.query<{ id: string; object_id: string; payload: string | null }>(
    "select id::text as id, object_id, payload from approval_queue where block = 'marketing' and object_type = 'koc_brief' and status = 'approved' order by id",
  );
  for (const q of briefs.rows) {
    const m = KIT_HEAD_RE.exec(q.payload || '');
    if (m === null || !(await verified(db, 'koc_brief', q.object_id, q.payload as string)))
      continue;
    const code = m[1] as string;
    const k = kits.get(code) ?? { skus: new Set(), claims: new Set(), refs: [] };
    kits.set(code, k);
    k.skus.add(m[2] as string);
    if (k.claims !== null) for (const c of kitClaims(q.payload)) k.claims.add(c);
    k.refs.push(`koc_brief#${q.id}`);
  }
  const aff = await db.query<{
    dealer_code: string;
    id: string;
    object_id: string;
    payload: string;
  }>(
    "select c.dealer_code, q.id::text as id, q.object_id, q.payload from affiliate_codes c join approval_queue q on q.id = c.queue_id where c.status = 'active' and q.object_type = 'affiliate_program' and q.status = 'approved' order by c.id",
  );
  for (const q of aff.rows) {
    if (!(await verified(db, 'affiliate_program', q.object_id, q.payload))) continue;
    const k = kits.get(q.dealer_code) ?? { skus: new Set(), claims: null, refs: [] };
    kits.set(q.dealer_code, k);
    k.claims = null; // kit đại lý không liệt kê claim
    for (const m of (q.payload ?? '').matchAll(AFF_SKU_RE)) k.skus.add(m[1] as string);
    k.refs.push(`affiliate_program#${q.id}`);
  }
  return kits;
}

export type Verdict = { codes: (string | null)[]; severity: 'S1' | 'S2' | null };

/** THUẦN: kết quả guardrail + kit đã duyệt (null = chưa có) → {codes, severity}. S1 = có vi phạm
 * critical; còn mã khác → S2. */
export function partnerVerdict(g: Dict, kit: Kit | null, sku: string | null): Verdict {
  const viols = (Array.isArray(g.violations) ? g.violations : []).filter(
    (v): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
  const codes: (string | null)[] = [
    ...new Set(viols.map((v) => (v.code === undefined ? null : (v.code as string)))),
  ];
  if (kit === null) codes.push(THIEU_KIT);
  else {
    if (sku !== null && kit.skus.size && !kit.skus.has(sku)) codes.push(SKU_NGOAI_KIT);
    if (kit.claims !== null) {
      const said = new Set<string>();
      for (const m of Array.isArray(g.matched_claims) ? g.matched_claims : []) {
        if (typeof m === 'object' && m !== null && (m as Dict).claim) {
          said.add((m as Dict).claim as string);
        }
      }
      const claims = kit.claims;
      if ([...said].some((c) => !claims.has(c))) codes.push(NGOAI_KIT);
    }
  }
  const crit = viols.some((v) => v.severity === 'critical');
  return { codes, severity: crit ? 'S1' : codes.length ? 'S2' : null };
}

export function partnerScan(
  row: { text: string; channel: string; sku: string | null },
  kit: Kit | null,
): Verdict {
  const g = hooks.checkPublish(row.text, {
    channel: row.channel,
    contentType: 'koc',
    sku: row.sku,
    isAi: false,
    isSponsored: true,
  });
  return partnerVerdict(g, kit, row.sku);
}

/** Mã đối tác lạ + chính sách tu_choi_file — 0 dòng nạp (Python ValueError). */
export class UnknownPartner extends RangeError {
  constructor(
    msg: string,
    public readonly warn: string | null,
  ) {
    super(msg);
  }
}

/** → [chính sách áp dụng, cảnh báo | null]. CHƯA CHỌN / file thiếu-hỏng / giá trị lạ / thiếu
 * người chọn → "tu_choi_file" (hành vi an toàn v14.5) kèm cảnh báo rõ — không tự chọn thay GĐ. */
export function unknownPartnerPolicy(path?: string | null): [string, string | null] {
  const p = path || PARTNER_POLICY_FILE;
  const name = basename(p);
  const safeDefault = UNKNOWN_POLICIES[0] as string;
  let doc: unknown;
  let buf: Buffer;
  try {
    buf = readFileSync(p);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return [safeDefault, `không có ${name} — dùng mặc định an toàn tu_choi_file`];
    }
    return [safeDefault, `${name} hỏng (${osErrName(e)}) — dùng mặc định an toàn tu_choi_file`];
  }
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf));
  } catch (e) {
    const t = e instanceof SyntaxError ? 'JSONDecodeError' : 'UnicodeDecodeError';
    return [safeDefault, `${name} hỏng (${t}) — dùng mặc định an toàn tu_choi_file`];
  }
  const isO = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
  const e = isO(doc) ? doc.ma_doi_tac_la : null;
  const pol = isO(e) ? e.chinh_sach : null;
  if (pol === null || pol === undefined) {
    return [
      safeDefault,
      `chính sách mã đối tác lạ CHƯA CHỌN (GĐ Marketing — ${name}) — đang dùng mặc định an toàn tu_choi_file`,
    ];
  }
  const o = e as Dict;
  const str = (v: unknown) => pySplit(pyTruthy(v) ? pyStr(v) : '').join(' ');
  const by = str(o.chon_boi);
  const ref = str(o.can_cu);
  if (
    typeof pol !== 'string' ||
    !UNKNOWN_POLICIES.includes(pol) ||
    byError(by) !== null ||
    !ref ||
    cpLen(ref) > 200
  ) {
    return [
      safeDefault,
      `${name}: chinh_sach lạ hoặc thiếu chon_boi (người)/can_cu — dùng mặc định an toàn tu_choi_file`,
    ];
  }
  return [pol, null];
}

/** {mã: is_sample} — KOC (sổ MẪU) + đại lý (`dealers`, nguồn dealer_regions.json = MẪU). Sổ KOC
 * hỏng → RangeError (fail-closed). */
export async function partnerRegistry(db: Db, kocFile?: string): Promise<Map<string, boolean>> {
  const reg = new Map<string, boolean>();
  try {
    for (const k of loadKocs(kocFile)) reg.set(k.code, true);
  } catch (e) {
    if (e instanceof KocConfigError) throw new RangeError(`sổ KOC: ${e.message}`);
    throw e;
  }
  const { rows } = await db.query<{ code: string; source: string }>(
    'select code, source from dealers',
  );
  for (const r of rows) if (!reg.has(r.code)) reg.set(r.code, r.source === 'dealer_regions.json');
  return reg;
}

export function partnerPayload(r: PartnerRow, v: Verdict, kit: Kit | null): string {
  const kitS = kit ? kit.refs.join(', ') : 'CHƯA có bộ tài liệu chuẩn đã duyệt cho đối tác này';
  const [y, m, d] = r.posted_on.split('-');
  return [
    `Rà bài đối tác (marketing-04.2) — đối tác ${r.partner}, kênh ${r.channel}, tên miền ${r.host}, ngày đăng ${d}/${m}/${y}`,
    `Mã URL (sha256 12 ký tự đầu): ${r.url_sha.slice(0, 12)} · mã nội dung: ${r.sha.slice(0, 12)} (sổ partner_post_scans)`,
    `Mức: ${v.severity} — mã: ${v.codes.map((c) => pyStr(c)).join(', ')}`,
    `Bộ tài liệu chuẩn đối chiếu: ${kitS}`,
    'Việc cần làm: GĐ marketing yêu cầu đối tác sửa/gỡ bài theo hợp đồng KOC/đại lý (URL đầy đủ tra trong file xuất tay theo mã URL). Agent KHÔNG liên hệ đối tác, KHÔNG gỡ/sửa bài; payload không chép đoạn vi phạm.',
  ].join('\n');
}

export type PartnerItem = {
  id: string;
  line: number;
  partner: string;
  host: string;
  url_sha: string;
  channel: string;
  severity: string | null;
  codes: (string | null)[];
  queue_id: string | null;
};
export type PartnerStats = {
  rows: number;
  new: number;
  skip: number;
  S1: number;
  S2: number;
  clean: number;
  tickets: number;
  items: PartnerItem[];
  policy: string;
  policy_warn: string | null;
  unknown: string[];
};

const sameCodes = (a: unknown, b: (string | null)[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Nạp lần rà bài đối tác → thống kê. Danh tính login ↔ `--by` kiểm ở DB TRƯỚC mọi ghi
 * (`human_actor`); tính năng tắt → RolloutBlocked (0 dòng); mã lạ theo `unknownPartnerPolicy`. */
export async function ingestPartner(
  db: Db,
  rows: PartnerRow[],
  o: {
    by: string;
    now: Date;
    dcfg?: DirectorConfig;
    policyPath?: string | null;
    kocFile?: string;
  },
): Promise<PartnerStats> {
  const err = byError(o.by);
  if (err) throw new RangeError(err);
  const by = pyStrip(o.by);
  // Vá review v15 (P10.1): danh tính login ↔ `--by` kiểm ở DB TRƯỚC mọi ghi — `director.submit` tự
  // commit mục hàng duyệt, kiểm muộn thì `--by` giả vẫn để lại mục `partner_post_review`.
  await callHuman(db, 'select human_actor($1, null)', [by], {
    by: o.by,
    block: null,
    action: 'partner_scan',
    objectType: 'partner_post_scan',
    objectId: '*',
  });
  if (!(o.now instanceof Date) || Number.isNaN(o.now.getTime())) {
    throw new RangeError('now phải là datetime có múi giờ');
  }
  await checkGenerate(db, PARTNER_FEATURE, 'rà bài đối tác');
  const dcfg = o.dcfg ?? loadDirector('marketing');
  const reg = await partnerRegistry(db, o.kocFile);
  const unknown = pySorted(new Set(rows.map((r) => r.partner).filter((p) => !reg.has(p))));
  const [policy, warn] = unknownPartnerPolicy(o.policyPath);
  if (unknown.length && policy === 'tu_choi_file') {
    throw new UnknownPartner(
      `${unknown.length} mã đối tác không có trong sổ KOC/đại lý — không nạp (chính sách tu_choi_file)`,
      warn,
    );
  }
  const kits = await partnerKits(db);
  const verdicts = rows.map((r) => {
    const v = partnerScan(r, kits.get(r.partner) ?? null);
    // ghi_vi_pham: mã chưa đăng ký
    return reg.has(r.partner)
      ? v
      : ({ codes: [...v.codes, UNKNOWN_PARTNER], severity: v.severity ?? 'S2' } as Verdict);
  });
  if (verdicts.some((v) => v.codes.includes('config'))) {
    throw new RangeError('guardrail cấu hình hỏng — không nạp (fail-closed)');
  }
  const st: PartnerStats = {
    rows: rows.length,
    new: 0,
    skip: 0,
    S1: 0,
    S2: 0,
    clean: 0,
    tickets: 0,
    items: [],
    policy,
    policy_warn: warn,
    unknown,
  };
  for (const [k, r] of rows.entries()) {
    const v = verdicts[k] as Verdict;
    const last = (
      await db.query<{ id: string; text_sha256: string; codes: string[] }>(
        'select id::text as id, text_sha256, codes from partner_post_scans where partner_code = $1 and url_sha256 = $2 order by id desc limit 1',
        [r.partner, r.url_sha],
      )
    ).rows[0];
    if (last && last.text_sha256 === r.sha && sameCodes(last.codes, v.codes)) {
      st.skip += 1;
      continue;
    }
    const kit = kits.get(r.partner) ?? null;
    const sample = reg.get(r.partner) ?? false;
    let qid: string | null = null;
    if (v.severity) {
      // oid xác định theo trạng thái TRƯỚC khi ghi → chạy lại sau sự cố giữa submit và insert tìm
      // lại đúng mục, không nhân bản.
      const oid = `partner_post:${r.partner}:${r.url_sha.slice(0, 16)}:${last ? last.id : 0}`;
      const found = (
        await db.query<{ id: string }>(
          'select id::text as id from approval_queue where object_type = $1 and object_id = $2',
          [OT_PARTNER, oid],
        )
      ).rows[0];
      if (found) qid = found.id;
      else {
        qid = String(
          await submit(db, {
            block: 'marketing',
            objectType: OT_PARTNER,
            objectId: oid,
            title: cpHead(
              `Bài đối tác ${r.partner} ${v.severity} trên ${r.channel} (${r.host})`,
              300,
            ),
            payload: partnerPayload(r, v, kit),
            createdBy: PARTNER_AGENT,
            cfg: dcfg,
            sample,
          }),
        );
        st.tickets += 1;
      }
    }
    // v15.4 (P10.1): ghi sổ qua function SECURITY DEFINER (danh tính theo login Postgres — nhập
    // liệu, không khối; login người không có INSERT trực tiếp `partner_post_scans`).
    const res = await callHuman<{ id: string }>(
      db,
      'select record_partner_scan_human($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)::text as id',
      [
        r.partner,
        r.url_sha,
        r.host,
        r.channel,
        r.posted_on,
        r.sku,
        r.sha,
        v.codes,
        v.severity,
        kit ? cpHead(kit.refs.join(', '), 200) : null,
        qid,
        sample,
        o.now,
        by,
      ],
      {
        by: o.by,
        block: null,
        action: 'partner_scan',
        objectType: 'partner_post_scan',
        objectId: r.partner,
      },
    );
    st.new += 1;
    if (v.severity) st[v.severity] += 1;
    else st.clean += 1;
    st.items.push({
      id: (res.rows[0] as { id: string }).id,
      line: r.line,
      partner: r.partner,
      host: r.host,
      url_sha: r.url_sha,
      channel: r.channel,
      severity: v.severity,
      codes: v.codes,
      queue_id: qid,
    });
  }
  return st;
}
