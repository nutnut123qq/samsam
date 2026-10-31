import type { Db } from '@samsam/core/ops/deps';
import { vnDate } from '@samsam/core/ops/period';
import { squash } from '@samsam/core/ops/py';
import { OBJECT_TYPE, verifyPublish } from '@samsam/core/ops/store';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, pyStr, pyTruthy, splitlines } from '@samsam/core/security/py';
import { CHANNELS as MARKET_CHANNELS } from '../market/market-csv.js';
import { fixed1, loadConfig as phapCheConfig, safe } from '../ra_kenh/ra-kenh.js';
import { cpCmp, tupleCmp } from './common.js';

// v8.1 W81.4 (WP10) — port `agents/ceo_audit.py`: Agent Kiểm soát nội bộ – Audit outside-in P1
// (ceo-04.3 bài đăng/listing, ceo-04.4 giá & mô tả listing).
// Câu hỏi: thứ ĐANG CHẠY ngoài kênh có đúng bản đã duyệt không?
//  (a) Bài đang đăng = dòng `channel_posts` mới nhất theo URL (file xuất tay v4.3). `close_reason =
//      'da_go'` → đã gỡ (ngoài mẫu số); không `draft_id` và ngày đăng trước `quy_trinh_duyet_tu`
//      (`data/phap_che.json`) → `truoc_quy_trinh` (ngoài mẫu số; ngày trống = bài mới, fail-closed).
//      Còn lại TÍNH LẠI tại lúc audit (KHÔNG tin `codes` đã lưu — bản duyệt có thể bị thu hồi sau đó):
//      `verifyPublish` true → `khop`; quyết định mới nhất của draft là approved nhưng sha256 lệch →
//      `lech_ban_duyet`; không draft / quyết định mới nhất không phải approved → `thieu_ban_duyet`.
//  (b) Listing sàn = snapshot `listing` mới nhất mỗi kênh → mọi `market_rows`: không map SKU →
//      `khong_xac_dinh_sku` (VÀO mẫu số — fail-closed); bản duyệt = nháp `content_drafts` loại
//      `listing` cùng SKU + kênh mà `verifyPublish` true; không có → `thieu_ban_duyet`; có → tiêu đề
//      listing so DÒNG ĐẦU bản duyệt (NFC + casefold + gộp khoảng trắng).
//  C06 (ceo-04.4): giá `list` ĐÃ DUYỆT còn hiệu lực TẠI NGÀY chụp file (giờ VN); mô tả chỉ khi file
//  có cột mô tả (`raw.description`).
// CHỈ ĐỌC: không ghi bảng nào, không mở ticket/cảnh báo, không sửa/gỡ bài, không đổi listing/giá.
// Section/report KHÔNG chép text bài, KHÔNG chép tiêu đề listing — chỉ kênh/mã/id; URL/item_id đã
// che PII CHỈ trong file report (section trang TGĐ/bản tin chỉ `#id` nội bộ). Không mạng, không LLM.

export const KHOP = 'khop';
export const LECH = 'lech_ban_duyet';
export const THIEU = 'thieu_ban_duyet';
export const NO_SKU = 'khong_xac_dinh_sku';
export const FINDINGS = [LECH, THIEU, NO_SKU] as const;
export const NO_DATA = 'chưa có dữ liệu quan sát (chỉ file xuất tay)';
export const SHOW = 5;
export const NOCMP = 'khong_so_duoc';
export const CHECK_CODES = [KHOP, LECH, NOCMP, THIEU] as const;
export const AUDIT_PREFIX = 'ceo-audit-';
export const PRICE_PREFIX = 'ceo-gia-';

const POSTS_SQL =
  'select distinct on (url) id::text as id, url, channel, posted_on::text as posted_on,' +
  ' draft_id::text as draft_id, text, close_reason from channel_posts order by url, id desc';
const DECISION_SQL =
  'select decision from approvals where object_type = $1 and object_id = $2 order by id desc limit 1';
const SNAP_SQL =
  "select distinct on (channel) id::text as id, channel, file_name, imported_at from market_snapshots where export_kind = 'listing' order by channel, imported_at desc, id desc";
const ROWS_SQL =
  "select r.id::text as id, r.snapshot_id::text as snapshot_id, r.row_no, r.channel, r.item_id, r.seller_sku, r.sku_key, r.title, r.price_vnd::text as price_vnd, r.raw ->> 'description' as descr from market_rows r where r.snapshot_id = any($1::bigint[]) order by r.channel, r.row_no, r.id";
const LISTING_SQL =
  "select id::text as id, text from content_drafts where content_type = 'listing' and sku = $1 and channel = $2 order by id";
const PRICE_SQL =
  "select price_vnd::text as price_vnd, id::text as id from price_list where sku_key = $1 and channel = $2 and kind = 'list' and program_id is null and approved_by is not null and valid_from <= $3::date and (valid_to is null or valid_to > $3::date) order by valid_from desc, id desc limit 1";

export type AuditItem = {
  kind: 'post' | 'listing';
  channel: string;
  ref: string;
  code: string;
  post_id?: number;
  sku?: string | null;
  row_id?: number;
};
export type PostRef = { kind: 'post'; channel: string; ref: string; post_id: number };
export type Check = {
  channel: string;
  row_id: number;
  observed: string;
  price: string;
  price_why: string;
  desc: string;
  desc_why: string;
};
export type AuditData = {
  items: AuditItem[];
  removed: unknown[];
  before: unknown[];
  snapshots: Record<string, string>;
  price_alerts_open: number;
  checks?: Check[];
};

// ------------------------------------------------------------------ thuần

/** Thân bản duyệt (bỏ dòng tiêu đề đầu) — so mô tả. */
export function body(text: string | null | undefined): string {
  const lines = splitlines(text || '');
  for (let i = 0; i < lines.length; i++) {
    if (squash(lines[i] as string)) return lines.slice(i + 1).join('\n');
  }
  return '';
}

/** NFC + casefold + gộp khoảng trắng — so tiêu đề listing. */
export function normTitle(s: unknown): string {
  const t = pyTruthy(s) ? pyStr(s) : ''; // Python `str(s or "")`
  return squash(casefold(t.normalize('NFC')));
}

export function firstLine(text: string | null | undefined): string {
  for (const line of splitlines(text || '')) if (squash(line)) return line;
  return '';
}

/** Tỷ lệ khớp/mẫu số dạng phần trăm; mẫu số 0 → '—' (KHÔNG 0%). Python `f"{round(x, 1):g}%"`. */
export function rate(khop: number, n: number): string {
  if (n === 0) return '—';
  return `${fixed1((khop * 100) / n).replace(/\.0$/, '')}%`.replace('.', ',');
}

export type Compliance = {
  channel: string;
  n: number;
  khop: number;
  rate: string;
  codes: Record<string, number>;
  note: string | null;
};

/** Theo kênh → tỷ lệ tuân thủ (THUẦN). `channels` thêm kênh luôn hiện; kênh sàn (`market`) chưa có
 * snapshot listing → note NO_DATA. */
export function compliance(
  items: readonly AuditItem[],
  channels: readonly string[] = [],
  market: readonly string[] = MARKET_CHANNELS,
  snapshots: Record<string, string> | null = null,
): Compliance[] {
  const snaps = snapshots ?? {};
  const chans = [...new Set([...items.map((i) => i.channel), ...channels, ...market])].sort(cpCmp);
  return chans.map((ch) => {
    const mine = items.filter((i) => i.channel === ch);
    const k = mine.filter((i) => i.code === KHOP).length;
    const codes = Object.fromEntries(
      FINDINGS.map((c) => [c, mine.filter((i) => i.code === c).length]),
    );
    let note: string | null = null;
    if (market.includes(ch) && !Object.hasOwn(snaps, ch)) {
      note = mine.length ? `listing: ${NO_DATA}` : NO_DATA;
    }
    return { channel: ch, n: mine.length, khop: k, rate: rate(k, mine.length), codes, note };
  });
}

/** Mục KHÔNG khớp (theo kênh, mã, loại, ref) — tất định. */
export function findings(items: readonly AuditItem[]): AuditItem[] {
  return items
    .filter((i) => i.code !== KHOP)
    .sort((a, b) =>
      tupleCmp(
        [a.channel, a.code, a.kind, pyStr(a.ref)],
        [b.channel, b.code, b.kind, pyStr(b.ref)],
      ),
    );
}

/** URL/mã từ file xuất tay → mã inline (`...`): che PII, bỏ ký tự điều khiển, không để URL tạo
 * link/markdown trong file report (OWASP A03). */
export const fullRef = (i: AuditItem): string =>
  `\`${maskPii(safe(i.ref)).replaceAll('`', "'").replaceAll('|', '/')}\``;

/** Mã NỘI BỘ cho trang TGĐ/bản tin: guardrail gập dấu nên slug URL / seller_sku trần bị coi là từ
 * cấm → trang trượt finalize. Chỉ #id DB — URL đầy đủ ở file report. */
export const idRef = (i: AuditItem): string =>
  i.kind === 'post' ? `#${i.post_id}` : `market_rows #${i.row_id}`;

/** C06 — giá & mô tả listing đang chạy so bản duyệt (THUẦN, tất định). */
export function checkLines(checks: readonly Check[], limit: number | null = SHOW): string[] {
  const L = ['', '### Giá & mô tả listing đang chạy so bản đã duyệt', ''];
  if (!checks.length) return [...L, '- chưa có dữ liệu quan sát (file listing sàn chưa nạp)'];
  for (const ch of [...new Set(checks.map((c) => c.channel))].sort(cpCmp)) {
    const mine = checks.filter((c) => c.channel === ch);
    const cnt = (k: string, f: 'price' | 'desc') => mine.filter((c) => c[f] === k).length;
    const obs = mine.map((c) => c.observed).sort(cpCmp)[mine.length - 1];
    L.push(
      `- ${ch} (quan sát ${obs}): giá ${CHECK_CODES.map((k) => `${k} ${cnt(k, 'price')}`).join(' · ')}` +
        ` | mô tả ${CHECK_CODES.map((k) => `${k} ${cnt(k, 'desc')}`).join(' · ')}`,
    );
  }
  const bad = checks
    .filter((c) => c.price === LECH || c.desc === LECH)
    .sort((a, b) => tupleCmp([a.channel, a.row_id], [b.channel, b.row_id]));
  for (const c of limit === null ? bad : bad.slice(0, limit)) {
    L.push(
      `- [${c.channel}] market_rows #${c.row_id} — giá ${c.price} (${c.price_why}) · mô tả ${c.desc}`,
    );
  }
  const nodesc = [...new Set(checks.filter((c) => c.desc === NOCMP).map((c) => c.desc_why))];
  for (const w of nodesc.sort(cpCmp)) L.push(`- Mô tả không so được: ${w}`);
  return L;
}

/** → dòng markdown "## Audit outside-in (P1)". CHỈ số + kênh/mã/id — không text bài, không tiêu đề
 * listing. `full` (CHỈ file ceo-audit-<ngày>.md, không qua finalize) → URL/item_id đã che PII; mặc
 * định (trang TGĐ, bản tin) → #id nội bộ. */
export function renderSection(
  data: AuditData,
  limit: number | null = SHOW,
  reportName = 'ceo-audit-<ngày>.md',
  full = false,
  priceReport: string | null = null,
): string[] {
  const ref = full ? fullRef : idRef;
  const comp = compliance(data.items, [], MARKET_CHANNELS, data.snapshots ?? null);
  const fs = findings(data.items);
  const n = comp.reduce((s, c) => s + c.n, 0);
  const k = comp.reduce((s, c) => s + c.khop, 0);
  const L = [
    '## Audit outside-in (P1)',
    '',
    `Bài/listing đang chạy so với bản đã duyệt: khớp ${k}/${n} (${rate(k, n)}) · đã gỡ (ngoài mẫu số): ${data.removed.length} · đăng trước quy trình duyệt (ngoài mẫu số): ${data.before.length} · cảnh báo giá sàn đang mở (price_mismatch): ${data.price_alerts_open}`,
    '',
    '| Kênh | Mẫu số | Khớp | Tỷ lệ tuân thủ | lech_ban_duyet | thieu_ban_duyet | khong_xac_dinh_sku | Ghi chú |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const c of comp) {
    L.push(
      `| ${c.channel} | ${c.n} | ${c.khop} | ${c.rate} | ${c.codes[LECH]} | ${c.codes[THIEU]} | ${c.codes[NO_SKU]} | ${c.note ?? ''} |`,
    );
  }
  const byCode = FINDINGS.map((c) => `${c} ${fs.filter((f) => f.code === c).length}`);
  L.push('', `Phát hiện theo mã: ${byCode.join(' · ')}`, '');
  const shown = limit === null ? fs : fs.slice(0, limit);
  if (shown.length)
    for (const f of shown) L.push(`- [${f.channel}] ${f.code} — ${f.kind} ${ref(f)}`);
  else L.push('- (không có phát hiện)');
  if (fs.length > shown.length) L.push(`- …và ${fs.length - shown.length} (xem ${reportName})`);
  if (priceReport) {
    // CLI: giá ở báo cáo riêng
    L.push('', `Giá & mô tả listing so bản đã duyệt: xem ${priceReport}`);
  } else if (data.checks !== undefined) {
    // `collect` luôn đặt (C06)
    L.push(...checkLines(data.checks, limit));
  }
  L.push(
    '',
    '*Tính lại tại lúc audit từ bài đang đăng (file xuất tay) + listing sàn (file Seller Center) so với bản duyệt (sha256 `approvals` / dòng đầu listing đã duyệt); giá so giá list ĐÃ DUYỆT còn hiệu lực ngày chụp file. GIỚI HẠN P1: mô tả chỉ so khi file xuất có cột mô tả (chưa có → không so được). Agent chỉ báo — không sửa/gỡ bài, không đổi listing/giá/voucher.*',
  );
  return L;
}

// ------------------------------------------------------------------ đọc (CHỈ SELECT)

type PostRow = {
  id: string;
  url: string;
  channel: string;
  posted_on: string | null;
  draft_id: string | null;
  text: string;
  close_reason: string | null;
};

async function postCode(db: Db, p: PostRow): Promise<string> {
  if (p.draft_id === null) return THIEU;
  if (await verifyPublish(db, p.draft_id, p.text)) return KHOP;
  const { rows } = await db.query<{ decision: string }>(DECISION_SQL, [OBJECT_TYPE, p.draft_id]);
  return rows[0] && rows[0].decision === 'approved' ? LECH : THIEU;
}

/** CHỈ SELECT → {items, removed, before, snapshots: {kênh: file}, price_alerts_open, checks}. */
export async function collect(
  db: Db,
  cfg: { quy_trinh_duyet_tu: string } | null = null,
): Promise<AuditData & { checks: Check[] }> {
  const start = (cfg ?? phapCheConfig()).quy_trinh_duyet_tu;
  const items: AuditItem[] = [];
  const removed: PostRef[] = [];
  const before: PostRef[] = [];
  for (const p of (await db.query<PostRow>(POSTS_SQL)).rows) {
    const ref: PostRef = { kind: 'post', channel: p.channel, ref: p.url, post_id: Number(p.id) };
    if (p.close_reason === 'da_go') removed.push(ref);
    else if (p.draft_id === null && p.posted_on !== null && p.posted_on < start) before.push(ref);
    else items.push({ ...ref, code: await postCode(db, p) });
  }
  const snaps = (
    await db.query<{ id: string; channel: string; file_name: string; imported_at: Date }>(SNAP_SQL)
  ).rows;
  const snapDay = new Map(snaps.map((s) => [s.id, vnDate(s.imported_at)]));
  const approved = new Map<string, Set<string> | null>();
  const bodies = new Map<string, Set<string> | null>();
  const checks: Check[] = [];
  const verified = async (sku: string, ch: string, part: (t: string) => string) => {
    const out = new Set<string>();
    const { rows } = await db.query<{ id: string; text: string }>(LISTING_SQL, [sku, ch]);
    for (const r of rows)
      if (await verifyPublish(db, r.id, r.text)) out.add(normTitle(part(r.text)));
    return out.size ? out : null;
  };
  if (snaps.length) {
    type MRow = {
      id: string;
      snapshot_id: string;
      row_no: number;
      channel: string;
      item_id: string | null;
      seller_sku: string | null;
      sku_key: string | null;
      title: string | null;
      price_vnd: string | null;
      descr: string | null;
    };
    const { rows } = await db.query<MRow>(ROWS_SQL, [snaps.map((s) => s.id)]);
    for (const m of rows) {
      const ref = [m.item_id, m.seller_sku].filter((x) => x).join(' · ');
      const it = {
        kind: 'listing' as const,
        channel: m.channel,
        ref: ref || `dòng ${m.row_no}`,
        sku: m.sku_key,
        row_id: Number(m.id),
      };
      if (m.sku_key === null) {
        items.push({ ...it, code: NO_SKU });
        continue;
      }
      const key = `${m.sku_key}\u0000${m.channel}`;
      if (!approved.has(key)) approved.set(key, await verified(m.sku_key, m.channel, firstLine));
      const titles = approved.get(key) ?? null;
      const code = titles === null ? THIEU : titles.has(normTitle(m.title)) ? KHOP : LECH;
      items.push({ ...it, code });
      const day = snapDay.get(m.snapshot_id) as string;
      const pr = (
        await db.query<{ price_vnd: string; id: string }>(PRICE_SQL, [m.sku_key, m.channel, day])
      ).rows[0];
      let pc: string;
      let why: string;
      if (m.price_vnd === null || pr === undefined) {
        pc = NOCMP;
        why = m.price_vnd === null ? 'file không có giá' : 'chưa có giá list ĐÃ DUYỆT hiệu lực';
      } else {
        pc = BigInt(m.price_vnd) === BigInt(pr.price_vnd) ? KHOP : LECH;
        why = `file ${m.price_vnd} / duyệt ${pr.price_vnd} (price_list #${pr.id})`;
      }
      if (!bodies.has(key)) bodies.set(key, await verified(m.sku_key, m.channel, body));
      const bs = bodies.get(key) ?? null;
      let dc: string;
      let dwhy: string;
      if (m.descr === null) {
        dc = NOCMP;
        dwhy = 'file xuất chưa có cột mô tả (nguồn chưa cấp)';
      } else if (bs === null) {
        dc = THIEU;
        dwhy = 'không có bản duyệt còn hiệu lực';
      } else {
        dc = bs.has(normTitle(m.descr)) ? KHOP : LECH;
        dwhy = '';
      }
      checks.push({
        channel: m.channel,
        row_id: Number(m.id),
        observed: day,
        price: pc,
        price_why: why,
        desc: dc,
        desc_why: dwhy,
      });
    }
  }
  const price = Number(
    (
      await db.query<{ n: string }>(
        "select count(*)::text as n from market_alerts where kind = 'price_mismatch' and status = 'open'",
      )
    ).rows[0]?.n ?? 0,
  );
  return {
    items,
    removed,
    before,
    snapshots: Object.fromEntries(snaps.map((s) => [s.channel, s.file_name])),
    price_alerts_open: price,
    checks,
  };
}

/** Section trang TGĐ/bản tin khối ceo (`ceo_report` nối qua `setCeoSections`). */
export async function section(db: Db, now: Date | null = null): Promise<string[]> {
  const day = vnDate(now ?? new Date());
  return renderSection(await collect(db), SHOW, `${AUDIT_PREFIX}${day}.md`);
}
