import { createHash } from 'node:crypto';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { dmy } from '@samsam/core/ops/period';
import { isPlainObject, pyInt, squash } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { readinessKey as key2 } from '@samsam/core/security/guardrail';
import { casefold, pyStr, pyStrip } from '@samsam/core/security/py';
import { MARKET_CHANNELS, toInt } from './content-lite.js';

// Port `agents/kd_listing.py` — v5.3 KD-A4 catalog & listing đa sàn (WP07, khối `sales`). LUẬT tất
// định, KHÔNG LLM, KHÔNG gọi sàn, KHÔNG sửa listing/giá: so listing ĐANG CHẠY trên sàn (snapshot
// `listing` mới nhất mỗi kênh của `ingest.market_csv`) với nháp listing ĐÃ DUYỆT
// (`content_drafts.content_type='listing'`) + golden → danh sách lệch → mục NHÁP vào hàng duyệt khối
// KD. Người sửa trên Seller Center là Quản lý MXH SAU KHI GĐ bán hàng duyệt.
//
// Loại phát hiện (`diffCatalog`, thuần): unready_listed S1 (listing đang bán map SKU readiness CAM
// → `market_alert_s1`); title_drift / price_drift / draft_stale / no_approved_draft /
// missing_listing S2 (→ `listing_sync`). Dòng không map SKU → chỉ đếm. Kênh chưa có snapshot →
// `[warn]`, KHÔNG sinh missing_listing (vắng file ≠ thiếu listing). Status lạ/None = đang bán.
//
// Ghi DB DUY NHẤT qua `director.submit` (guardrail do hàng duyệt tự chạy). `object_id` theo ĐỢT:
// `a4:<loại>:<kênh>:<item_id|sku>:<sha256(bằng chứng)[:12]>` — đã có ở BẤT KỲ status → không đẩy lại.
// Trùng `market_alerts` OPEN `alcohol_listed` cùng (kênh, item_id, seller_sku) → chỉ báo cáo, không
// enqueue. Payload/title từ TEMPLATE — KHÔNG chép tiêu đề/mô tả listing; nhóm CAM KHÔNG in sku_key.

export const BLOCK = 'sales';
export const AGENT = 'agent:kd_listing';
export const JOB = 'agents.kd_listing';
export const FEATURE = 'sales-03';
export const LISTABLE = ['MO_TA', 'TP_THUONG', 'QC_DAY_DU'];
export const SEVERITY: Record<string, string> = {
  unready_listed: 'S1',
  title_drift: 'S2',
  price_drift: 'S2',
  draft_stale: 'S2',
  no_approved_draft: 'S2',
  missing_listing: 'S2',
};
export const KIND_LABELS: Record<string, string> = {
  unready_listed: 'listing thuộc nhóm không được bán/quảng bá online',
  title_drift: 'tiêu đề trên sàn khác bản đã duyệt',
  price_drift: 'giá niêm yết trên sàn khác bản đã duyệt',
  draft_stale: 'bản listing đã duyệt có giá cũ so với bảng giá golden',
  no_approved_draft: 'listing đang bán chưa có bản listing đã duyệt',
  missing_listing: 'SKU đủ điều kiện nhưng chưa có listing đang bán',
};
// Cảnh báo v3.3 trùng nghĩa → không nhân đôi việc.
export const V33_DUP: Record<string, string> = { unready_listed: 'alcohol_listed' };
const NO_AUTO = 'Agent không tự sửa sàn, không tự duyệt.';
const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export type Day = string;
export type ListingRow = {
  snapshot_id?: number;
  channel: string;
  row_no?: number;
  item_id: string | null;
  seller_sku: string | null;
  sku_key: string | null;
  title?: string | null;
  price_vnd: number | null;
  status?: string | null;
  sale_price?: number | null;
};
export type Draft = { id: number; title: string | null; price: number | null };
/** Khóa `key2(sku, kênh)`. */
export type Drafts = Map<string, Draft>;
export type Skus = Map<string, { category: unknown }>;
export type PriceCell = { price: number; id: number; approved: boolean };
export type GoldenPrices = Map<string, Record<string, PriceCell>>;
export type Finding = {
  kind: string;
  severity: string;
  channel: string;
  item_id: string | null;
  seller_sku: string | null;
  sku_key: string | null;
  evidence: Record<string, unknown>;
  object_id: string;
  dup_alert?: number;
};
export type DiffResult = { findings: Finding[]; unmapped: number; no_snapshot: string[] };
export type Item = { object_type: string; object_id: string; title: string; payload: string };
export type Plan = { new: number; seen: number; dup: number };

// ------------------------------------------------------------ tiện ích

/** Python `f"{n:,}"` (số nguyên). */
const grp = (n: number): string => {
  const s = String(Math.abs(Math.trunc(n)));
  return (n < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const vnd = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${grp(n).replaceAll(',', '.')} đ`;

/** Mã sàn từ file (item_id/seller_sku) trước khi vào payload: chỉ [A-Za-z0-9_.-] ≤ 40 ký tự, khác
 * → '(mã lạ)' (không lọt chữ tự do). */
export const refCode = (s: unknown): string =>
  typeof s === 'string' && ITEM_RE.test(s) ? s : '(mã lạ)';

/** NFC + gộp khoảng trắng + casefold — chỉ khác hoa/thường/khoảng trắng không tính là lệch. */
export const normTitle = (s: unknown): string =>
  typeof s === 'string' ? casefold(squash(s.normalize('NFC'))) : '';

/** Python `json.dumps(v, ensure_ascii=False, sort_keys=True)` cho giá trị JSON thuần. */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  const o = v as Record<string, unknown>;
  const ks = Object.keys(o).sort(cpCmp);
  return `{${ks.map((k) => `${JSON.stringify(k)}: ${pyDumps(o[k])}`).join(', ')}}`;
}

export const evidenceSha = (ev: Record<string, unknown>): string =>
  createHash('sha256').update(pyDumps(ev), 'utf8').digest('hex').slice(0, 12);

/** Nháp listing → [tiêu đề = dòng đầu, giá dòng `Giá:` VND | null]. `Giá: Liên hệ` / thiếu dòng /
 * số hỏng → giá null. */
export function parseDraft(text: unknown): [string | null, number | null] {
  if (typeof text !== 'string') return [null, null];
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const title = pyStrip(lines[0] as string) || null;
  let price: number | null = null;
  for (const ln of lines.slice(1)) {
    const s = pyStrip(ln);
    if (s.startsWith('Giá:')) {
      price = toInt(pyStrip(s.slice(4)) || null, 10 ** 15);
      break;
    }
  }
  return [title, price];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------ đọc DB (SELECT)

/** {kênh: snapshot_id} — snapshot `listing` mới nhất mỗi kênh. */
export async function listingSnapshots(db: Db): Promise<Map<string, string>> {
  const { rows } = await db.query(
    "select distinct on (channel) id::text as id, channel from market_snapshots where export_kind = 'listing' order by channel, imported_at desc, id desc",
  );
  return new Map(rows.map((r) => [r.channel as string, r.id as string]));
}

/** → [dòng ĐANG BÁN của snapshot listing mới nhất mỗi kênh, tập kênh có snapshot]. Status ∈
 * `inactive_status` của mapping → bỏ; status lạ/None = đang bán (fail-closed). `sale_price` từ `raw`.
 * shortcut: `int()` của Python nhận cả chữ số Unicode — TS chỉ chữ số ASCII (loader ghi ASCII). */
export async function runningListings(
  db: Db,
  mapping: unknown,
): Promise<[ListingRow[], Set<string>]> {
  const snaps = await listingSnapshots(db);
  if (!snaps.size) return [[], new Set()];
  const { rows } = await db.query(
    "select snapshot_id::text as sid, channel, row_no, item_id, seller_sku, sku_key, title, price_vnd::text as price, status, raw->>'sale_price' as sale from market_rows where snapshot_id = any($1::bigint[]) order by channel, row_no",
    [[...snaps.values()]],
  );
  const m = isPlainObject(mapping) ? mapping : {};
  const out: ListingRow[] = [];
  for (const r of rows) {
    const ch = isPlainObject(m[r.channel]) ? (m[r.channel] as Record<string, unknown>) : {};
    const lst = isPlainObject(ch.listing) ? ch.listing : {};
    const inactive = new Set(
      (Array.isArray(lst.inactive_status) ? lst.inactive_status : []).map((s) =>
        pyStrip(pyStr(s).normalize('NFC')),
      ),
    );
    if (r.status !== null && inactive.has(pyStrip(String(r.status).normalize('NFC')))) continue;
    const sp = r.sale === null ? null : pyInt(r.sale);
    out.push({
      snapshot_id: Number(r.sid),
      channel: r.channel,
      row_no: r.row_no,
      item_id: r.item_id,
      seller_sku: r.seller_sku,
      sku_key: r.sku_key,
      title: r.title,
      price_vnd: num(r.price),
      status: r.status,
      sale_price: sp === null ? null : Number(sp),
    });
  }
  return [out, new Set(snaps.keys())];
}

/** Bản listing ĐÃ DUYỆT mới nhất mỗi (sku, kênh) theo (reviewed_at, id). */
export async function approvedDrafts(db: Db): Promise<Drafts> {
  const { rows } = await db.query(
    "select distinct on (sku, channel) id::text as id, sku, channel, text from content_drafts where content_type = 'listing' and status = 'approved' and sku is not null order by sku, channel, reviewed_at desc nulls last, id desc",
  );
  const out: Drafts = new Map();
  for (const r of rows) {
    const [title, price] = parseDraft(r.text);
    out.set(key2(r.sku, r.channel), { id: Number(r.id), title, price });
  }
  return out;
}

export async function goldenSkus(db: Db): Promise<Skus> {
  const { rows } = await db.query('select sku_key, category from sku_master order by sku_key');
  return new Map(rows.map((r) => [r.sku_key as string, { category: r.category }]));
}

export async function readinessMap(db: Db): Promise<Map<string, string>> {
  const { rows } = await db.query('select sku_key, channel, readiness from sku_readiness');
  return new Map(rows.map((r) => [key2(r.sku_key, r.channel), r.readiness as string]));
}

/** Giá thường trực (program_id null) `list`/`floor` hiệu lực ngày `day`; nhiều dòng mở (lỗi dữ
 * liệu) → dòng valid_from/id mới nhất. `approved` = đã có người duyệt. */
export async function goldenPrices(db: Db, day: Day): Promise<GoldenPrices> {
  const { rows } = await db.query(
    "select sku_key, channel, kind, price_vnd::text as price, id::text as id, approved_by from price_list where program_id is null and kind in ('list', 'floor') and valid_from <= $1 and (valid_to is null or valid_to > $1) order by valid_from, id",
    [day],
  );
  const out: GoldenPrices = new Map();
  for (const r of rows) {
    const k = key2(r.sku_key, r.channel);
    const cur = out.get(k) ?? {};
    cur[r.kind] = { price: Number(r.price), id: Number(r.id), approved: r.approved_by !== null };
    out.set(k, cur);
  }
  return out;
}

/** {(sku, kênh): giá list} từ `goldenPrices`. */
export function listPrices(prices: GoldenPrices): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of prices) if (v.list) out.set(k, v.list.price);
  return out;
}

const alertKey = (kind: string, ch: string, iid: string, ss: string) =>
  [kind, ch, iid, ss].join('\0');

/** {(kind, kênh, item_id, seller_sku): id} cảnh báo v3.3 đang mở. */
export async function openV33Alerts(db: Db, kinds: string[]): Promise<Map<string, number>> {
  const { rows } = await db.query(
    "select id::text as id, kind, channel, item_id, seller_sku from market_alerts where status = 'open' and export_kind = 'listing' and kind = any($1::text[]) order by id",
    [kinds],
  );
  return new Map(
    rows.map((r) => [
      alertKey(r.kind, r.channel, r.item_id ?? '', r.seller_sku ?? ''),
      Number(r.id),
    ]),
  );
}

export const itemKey = (it: { object_type: string; object_id: string }): string =>
  `${it.object_type}\0${it.object_id}`;

/** (object_type, object_id) đã có trong hàng duyệt Ở BẤT KỲ status. */
export async function seenIds(db: Db, prefix: string): Promise<Set<string>> {
  const { rows } = await db.query(
    'select object_type, object_id from approval_queue where object_id like $1',
    [`${prefix}:%`],
  );
  return new Set(rows.map((r) => itemKey(r)));
}

// ------------------------------------------------------------ luật (THUẦN)

function finding(
  kind: string,
  ch: string,
  row: ListingRow | null,
  sku: string | null,
  evidence: Record<string, unknown>,
): Finding {
  const iid = row?.item_id ?? null;
  const ss = row?.seller_sku ?? null;
  const key = iid || ss || sku || '-';
  return {
    kind,
    severity: SEVERITY[kind] as string,
    channel: ch,
    item_id: iid,
    seller_sku: ss,
    sku_key: sku,
    evidence,
    object_id: `a4:${kind}:${ch}:${refCode(key)}:${evidenceSha({ sku, ...evidence })}`,
  };
}

const cmpTuple = (a: string[], b: string[]): number => {
  for (let i = 0; i < a.length; i++) {
    const d = cpCmp(a[i] as string, b[i] as string);
    if (d) return d;
  }
  return 0;
};
const split2 = (k: string) => k.split('\0') as [string, string];

/** THUẦN, tất định → {findings, unmapped, no_snapshot}. `prices` = {(sku, kênh): giá list golden};
 * `channels` = kênh CÓ snapshot listing; readiness thiếu key = CAM. */
export function diffCatalog(
  listings: ListingRow[],
  drafts: Drafts,
  skus: Skus,
  readiness: Map<string, string>,
  prices: Map<string, number>,
  channels: Iterable<string>,
): DiffResult {
  const findings: Finding[] = [];
  const chans = new Set(channels);
  let unmapped = 0;
  const running = new Set<string>();
  const alcohol = (sku: string) => skus.get(sku)?.category === 'alcohol';
  for (const r of listings) {
    const ch = r.channel;
    const sku = r.sku_key ?? null;
    if (sku === null) {
      unmapped++;
      continue;
    }
    running.add(key2(sku, ch));
    const lv = readiness.get(key2(sku, ch)) ?? 'CAM';
    if (alcohol(sku) || lv === 'CAM') {
      findings.push(finding('unready_listed', ch, r, sku, { readiness: 'CAM' }));
      continue;
    }
    const d = drafts.get(key2(sku, ch));
    if (d === undefined) {
      findings.push(finding('no_approved_draft', ch, r, sku, { price_san: r.price_vnd ?? null }));
      continue;
    }
    if (normTitle(r.title) !== normTitle(d.title)) {
      findings.push(
        finding('title_drift', ch, r, sku, {
          draft_id: d.id,
          title_san_sha: evidenceSha({ t: normTitle(r.title) }),
        }),
      );
    }
    if (d.price !== null && (r.price_vnd ?? null) !== d.price) {
      findings.push(
        finding('price_drift', ch, r, sku, {
          draft_id: d.id,
          price_san: r.price_vnd ?? null,
          price_draft: d.price,
        }),
      );
    }
  }
  // Bản duyệt cũ: xét MỌI bản duyệt của SKU đủ điều kiện listing (kể cả chưa lên sàn / kênh web) —
  // đăng bản cũ = sai giá golden.
  const draftKeys = [...drafts.keys()].map(split2).sort(cmpTuple);
  for (const [sku, ch] of draftKeys) {
    const d = drafts.get(key2(sku, ch)) as Draft;
    if (!LISTABLE.includes(readiness.get(key2(sku, ch)) as string) || alcohol(sku)) continue;
    const g = prices.get(key2(sku, ch)) ?? null;
    if (d.price !== g) {
      findings.push(
        finding('draft_stale', ch, null, sku, {
          draft_id: d.id,
          price_draft: d.price,
          price_golden: g,
        }),
      );
    }
  }
  const skuKeys = [...skus.keys()].sort(cpCmp);
  for (const ch of [...chans].sort(cpCmp)) {
    for (const sku of skuKeys) {
      const lv = readiness.get(key2(sku, ch));
      if (
        lv !== undefined &&
        LISTABLE.includes(lv) &&
        !alcohol(sku) &&
        !running.has(key2(sku, ch))
      ) {
        findings.push(finding('missing_listing', ch, null, sku, { readiness: lv }));
      }
    }
  }
  const sortKey = (f: Finding) => [f.severity, f.kind, f.channel, f.item_id || '', f.sku_key || ''];
  findings.sort((a, b) => cmpTuple(sortKey(a), sortKey(b)));
  return {
    findings,
    unmapped,
    no_snapshot: MARKET_CHANNELS.filter((c) => !chans.has(c)).sort(cpCmp),
  };
}

/** Gắn `dup_alert` = id cảnh báo v3.3 đang mở cùng nghĩa (không đẩy). */
export function markDups(findings: Finding[], v33: Map<string, number>): void {
  for (const f of findings) {
    const k = V33_DUP[f.kind];
    if (k) {
      const aid = v33.get(alertKey(k, f.channel, f.item_id || '', f.seller_sku || ''));
      if (aid !== undefined) f.dup_alert = aid;
    }
  }
}

export const objectType = (f: Finding): string =>
  f.severity === 'S1' ? 'market_alert_s1' : 'listing_sync';

/** Vị trí trong payload: mã sàn; SKU chỉ in khi KHÔNG thuộc nhóm CAM. */
export function where(f: Finding): string {
  const parts = [`kênh ${f.channel}`];
  if (f.item_id) parts.push(`mã sản phẩm sàn ${refCode(f.item_id)}`);
  if (f.kind !== 'unready_listed' && f.sku_key) parts.push(`SKU ${refCode(f.sku_key)}`);
  return parts.join(', ');
}

/** [title, payload] từ TEMPLATE — không chép tiêu đề/mô tả listing. */
export function payloadOf(f: Finding): [string, string] {
  const ev = f.evidence;
  const label = KIND_LABELS[f.kind] as string;
  const w = where(f);
  const p = (v: unknown) => vnd(v as number | null);
  let body: string;
  if (f.kind === 'unready_listed') {
    body = `Cảnh báo sàn S1 (A4 catalog): ${label} — ${w}; mức sẵn sàng golden CAM. Việc cần làm: Quản lý MXH ẩn listing trên Seller Center sau khi GĐ bán hàng/Pháp chế xác nhận.`;
  } else if (f.kind === 'title_drift') {
    body = `Lệch listing (A4, NHÁP): ${label} — ${w}; bản duyệt là nháp listing #${ev.draft_id}. Việc cần làm: MXH sửa tiêu đề trên Seller Center theo bản duyệt SAU KHI GĐ bán hàng duyệt mục này.`;
  } else if (f.kind === 'price_drift') {
    body = `Lệch listing (A4, NHÁP): ${label} — ${w}; giá trên sàn ${p(ev.price_san)}, giá bản duyệt ${p(ev.price_draft)} (nháp listing #${ev.draft_id}). Việc cần làm: MXH sửa trên Seller Center SAU KHI GĐ bán hàng duyệt mục này.`;
  } else if (f.kind === 'draft_stale') {
    body = `Lệch listing (A4, NHÁP): ${label} — ${w}; giá trong bản duyệt ${p(ev.price_draft)} (nháp listing #${ev.draft_id}), giá list golden đang mở ${p(ev.price_golden)}. Việc cần làm: sinh lại nháp listing (MKT-02, SOP mục 4 'Sinh listing hàng loạt') để Pháp chế/GĐ bán hàng duyệt lại.`;
  } else if (f.kind === 'no_approved_draft') {
    body = `Lệch listing (A4, NHÁP): ${label} — ${w}; giá trên sàn ${p(ev.price_san)}. Việc cần làm: sinh nháp listing (MKT-02, SOP mục 4 'Sinh listing hàng loạt') để duyệt, rồi MXH đối chiếu listing trên Seller Center.`;
  } else {
    body = `Lệch listing (A4, NHÁP): ${label} — ${w}; mức sẵn sàng ${pyStr(ev.readiness)}. Việc cần làm: GĐ bán hàng quyết có mở listing không; nếu mở, MXH đăng tay theo bản listing đã duyệt.`;
  }
  return [`${label} — ${w}`, `${body} ${NO_AUTO}`];
}

/** Phát hiện → mục sẽ đẩy (bỏ mục trùng cảnh báo v3.3). */
export function toItems(findings: Finding[], cfg: DirectorConfig): Item[] {
  const out: Item[] = [];
  for (const f of findings) {
    if (f.dup_alert !== undefined) continue;
    const ot = objectType(f);
    const [title, payload] = payloadOf(f);
    const label = pyStr((cfg.object_types[ot] as Record<string, unknown>).label);
    out.push({ object_type: ot, object_id: f.object_id, title: `${label} — ${title}`, payload });
  }
  return out;
}

/** Đẩy qua `director.submit` mục chưa có (mọi status) → số mục mới. */
export async function enqueueNew(
  db: Db,
  items: Item[],
  cfg: DirectorConfig,
  seen: Set<string>,
  agent: string,
): Promise<number> {
  let n = 0;
  for (const it of items) {
    if (seen.has(itemKey(it))) continue;
    try {
      await submit(db, {
        block: BLOCK,
        objectType: it.object_type,
        objectId: it.object_id,
        title: it.title,
        payload: it.payload,
        createdBy: agent,
        cfg,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue; // cùng mục vừa được đẩy song song
      throw e;
    }
    seen.add(itemKey(it));
    n++;
  }
  return n;
}

// ------------------------------------------------------------ báo cáo

/** THUẦN, tất định. Không in tiêu đề listing; nhóm CAM không in SKU. */
export function renderReport(res: DiffResult, today: Day, plan: Plan | null = null): string {
  const fs = res.findings;
  const L = [
    `# Đồng bộ catalog/listing đa sàn (A4) — ${dmy(today)}`,
    '',
    'Agent CHỈ ĐỌC: so listing đang chạy (file Seller Center mới nhất mỗi kênh) với bản listing đã duyệt + golden. Agent KHÔNG sửa sàn — mọi việc là NHÁP trong hàng duyệt khối KD.',
    '',
  ];
  for (const ch of res.no_snapshot) {
    L.push(`- [warn] chưa có file listing ${ch} — không kiểm thiếu listing kênh này`);
  }
  L.push(`- Dòng listing chưa map SKU (đã là cảnh báo sàn v3.3): ${res.unmapped}`);
  if (plan !== null) {
    L.push(
      `- Sẽ đẩy mục mới: ${plan.new} · đã có trong hàng duyệt: ${plan.seen} · trùng cảnh báo sàn: ${plan.dup}`,
    );
  }
  for (const sev of ['S1', 'S2']) {
    const part = fs.filter((f) => f.severity === sev);
    L.push('', `## ${sev} (${part.length})`, '');
    for (const f of part) {
      const dup = f.dup_alert !== undefined ? ` (đã có cảnh báo sàn #${f.dup_alert})` : '';
      L.push(`- ${KIND_LABELS[f.kind]} — ${where(f)}${dup}`);
    }
    if (!part.length) L.push('- (không có)');
  }
  L.push('', '---', '*BẢN NHÁP — hệ thống không tự gửi, không tự sửa sàn.*', '');
  return L.join('\n');
}

// ------------------------------------------------------------ chạy

/** CHỈ SELECT → kết quả `diffCatalog` + `dup_alert`. */
export async function analyze(db: Db, mapping: unknown, today: Day): Promise<DiffResult> {
  const [rows, chans] = await runningListings(db, mapping);
  const res = diffCatalog(
    rows,
    await approvedDrafts(db),
    await goldenSkus(db),
    await readinessMap(db),
    listPrices(await goldenPrices(db, today)),
    chans,
  );
  markDups(res.findings, await openV33Alerts(db, Object.values(V33_DUP)));
  return res;
}

export function planOf(items: Item[], findings: Finding[], seen: Set<string>): Plan {
  const s = items.filter((i) => seen.has(itemKey(i))).length;
  return {
    new: items.length - s,
    seen: s,
    dup: findings.filter((f) => f.dup_alert !== undefined).length,
  };
}
