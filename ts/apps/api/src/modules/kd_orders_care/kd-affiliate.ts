import { createHash, randomInt } from 'node:crypto';
import { verify as aqVerify } from '@samsam/core/ops/approval-queue';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { addDays, vnMidnight } from '@samsam/core/ops/period';
import { isPlainObject } from '@samsam/core/ops/py';
import { queueSample, REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { readinessFromDb } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { check, type ReadinessMap, readinessKey } from '@samsam/core/security/guardrail';
import { pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import {
  big,
  CATEGORIES,
  CONTENT_OK,
  commissionOf,
  commissionRate,
  cpCmp,
  type Dealer,
  type Draft,
  groupDots,
  KIT_TYPES,
  loadDrafts,
  loadMarketMapping,
  MAX_DRAFTS,
  pyListRepr,
} from './shared.js';

// Port `agents/kd_affiliate.py` (v5.4 KD-A8, WP07) — affiliate đại lý: mã/link + kit từ nội dung ĐÃ
// DUYỆT của Marketing, ghi nhận đơn qua mã, hoa hồng TẠM TÍNH. Tất định, KHÔNG LLM, KHÔNG mạng.
// Ranh giới: agent KHÔNG gửi kit, KHÔNG liên hệ đại lý, KHÔNG tạo voucher/coupon trên sàn/web.
// `issue` → 1 mã `pending` + 1 mục NHÁP `sales/affiliate_program` (`aff-<id>`) chờ GĐ bán hàng duyệt
// (mã và mục cùng 1 giao dịch); `release` (mục approved + `verify` khớp) → mã `active` + file kit
// (Quản lý MXH tạo voucher TAY rồi gửi TAY); `attribute` → `affiliate_attributions` (idempotent,
// cổng finance-03.2); `report` → bảng hoa hồng BẢN NHÁP (không phải lệnh chi).
// Mã: "SS" + 10 ký tự CSPRNG trên bảng 32 ký tự (không 0/O/1/I, ≈ 50 bit) — không chứa mã đại lý/
// ngày/số thứ tự. Mỗi (đại lý, kênh) tối đa 1 mã pending|active. Link chỉ kênh web (tham số
// `coupon` GIẢ ĐỊNH); sàn chỉ có MÃ. Hoa hồng: `commissionRate(dealer, category, online=true)` —
// rượu online = 0, đại lý không active = 0, nhóm lạ = 0; làm tròn nửa lên.

export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 10;
export const PREFIX = 'SS';
export const CODE_RE = /^SS[A-HJ-NP-Z2-9]{10}$/;
export const CHANNELS = ['shopee', 'tiktok', 'web'];
export const WEB_LINK = 'https://samsamngoclinh.com/?coupon='; // GIẢ ĐỊNH tham số
export const SAMPLE_SOURCE = 'dealer_regions.json';
export const CODES = [
  'AFF_DEALER',
  'AFF_RUOU_ONLINE',
  'AFF_CREATIVE_UNAPPROVED',
  'AFF_READINESS',
  'AFF_GUARDRAIL',
];
export const RELEASE_CODES = ['AFF_NOT_APPROVED', 'AFF_PAYLOAD_CHANGED'];
export const NEW_CODE_TRIES = 5;
export const DRAFT_NOTE =
  'BẢN NHÁP — hệ thống không gửi; Quản lý MXH tạo voucher/coupon và gửi TAY sau khi GĐ bán hàng duyệt';
export const REPORT_HEAD =
  'BẢN NHÁP — không phải lệnh chi; chính sách hoa hồng chưa ký (tỷ lệ MẪU)';
const OID_RE = /^aff-([1-9][0-9]{0,17})$/;
export const FEATURE_ATTR = 'finance-03.2';
export const JOB = 'agents.kd_affiliate';

/** Python `RuntimeError` (CLI bắt như Python). */
export class RuntimeError extends Error {
  override name = 'RuntimeError';
}

// ------------------------------------------------------------ thuần
export type Rand = { choice(seq: string): string };
const SECURE: Rand = { choice: (seq) => seq[randomInt(seq.length)] as string };

/** Mã affiliate ngẫu nhiên mật mã học (`rand` tiêm được để test). */
export function newCode(rand: Rand = SECURE): string {
  let s = PREFIX;
  for (let i = 0; i < CODE_LEN; i++) s += rand.choice(ALPHABET);
  return s;
}

/** Chỉ kênh web có link; sàn chỉ dùng MÃ (voucher MXH tạo tay). */
export const linkFor = (code: string, channel: string): string | null =>
  channel === 'web' ? `${WEB_LINK}${code}` : null;

const kitTypesRepr = `(${KIT_TYPES.map(pyRepr).join(', ')})`;

function draftWhy(d: unknown): string | null {
  if (!isPlainObject(d) || d.id === null || d.id === undefined) return 'draft không tồn tại';
  const i = pyStr(d.id);
  if (d.status !== 'approved') return `draft #${i} chưa duyệt (trạng thái ${pyStr(d.status)})`;
  if (!KIT_TYPES.includes(d.content_type as string)) {
    return `draft #${i} loại ${pyStr(d.content_type)} — cần ${kitTypesRepr}`;
  }
  if (d.verified !== true) return `draft #${i} không khớp bản đã duyệt (verify_publish)`;
  if (!d.sku) return `draft #${i} không gắn SKU`;
  return null;
}

export function renderKit(dealer: Dealer, channel: string, code: string, drafts: Draft[]): string {
  const sample = dealer.source === SAMPLE_SOURCE;
  const link = linkFor(code, channel);
  const L = [
    `# Kit affiliate đại lý ${pyStr(dealer.code)}${sample ? ' (ĐẠI LÝ MẪU)' : ''} × ${channel}`,
    '',
    `${DRAFT_NOTE}.`,
    '',
    '## Mã affiliate',
    '',
    `- Mã: ${code}`,
    link
      ? `- Link: ${link}`
      : '- Sàn chỉ dùng MÃ — Quản lý MXH tạo voucher tương ứng trong Seller Center (chưa phải voucher thật).',
    '',
    '## Nội dung đã duyệt (nguyên văn — không sửa khi đăng)',
    '',
  ];
  for (const d of drafts) {
    L.push(`### Bài #${pyStr(d.id)} — \`${pyStr(d.sku)}\``, '', pyStrip(String(d.text || '')), '');
  }
  L.push(
    '## Hoa hồng',
    '',
    '- Tạm tính theo chính sách hoa hồng CHƯA ký — chỉ để tham khảo, không phải cam kết chi.',
    '',
  );
  return L.join('\n');
}

export type Golden = Record<string, { category?: unknown }>;
export type KitResult = { code: string | null; reason: string; kit?: string; sha12?: string };

const goldenOf = (golden: Golden, sku: unknown) =>
  typeof sku === 'string' && Object.hasOwn(golden, sku) ? golden[sku] : undefined;

/** THUẦN → {code (MÃ CHẶN) | null, reason, kit, sha12}. `code` tham số là mã affiliate. */
export function buildKit(
  dealer: unknown,
  channel: string,
  code: string,
  drafts: unknown,
  golden: Golden,
  readiness: ReadinessMap | null,
): KitResult {
  if (!isPlainObject(dealer) || dealer.status !== 'active') {
    const st = isPlainObject(dealer) ? dealer.status : null;
    return { code: 'AFF_DEALER', reason: `đại lý không tồn tại / không active (${pyStr(st)})` };
  }
  if (!CHANNELS.includes(channel)) return { code: 'AFF_READINESS', reason: `kênh '${channel}' lạ` };
  const ds = (Array.isArray(drafts) ? drafts : []) as unknown[];
  for (const d of ds) {
    const g = isPlainObject(d) ? goldenOf(golden, d.sku) : undefined;
    if (isPlainObject(g) && g.category === 'alcohol') {
      return {
        code: 'AFF_RUOU_ONLINE',
        reason: `draft #${pyStr((d as Draft).id)} gắn SKU đồ uống có cồn — kênh online không có affiliate`,
      };
    }
  }
  if (!ds.length || ds.length > MAX_DRAFTS) {
    return { code: 'AFF_CREATIVE_UNAPPROVED', reason: `cần 1..${MAX_DRAFTS} draft đã duyệt` };
  }
  for (const d of ds) {
    const why = draftWhy(d);
    if (why) return { code: 'AFF_CREATIVE_UNAPPROVED', reason: why };
  }
  const ok = ds as Draft[];
  for (const d of ok) {
    // kênh web tra readiness 'web' (view sku_readiness)
    const g = goldenOf(golden, d.sku);
    const lvl =
      typeof d.sku === 'string' ? readiness?.get(readinessKey(d.sku, channel)) : undefined;
    if (!isPlainObject(g) || lvl === undefined || !CONTENT_OK.includes(lvl)) {
      return {
        code: 'AFF_READINESS',
        reason: `${pyStr(d.sku)} × ${channel}: readiness ${lvl || 'không có'}`,
      };
    }
  }
  const kit = renderKit(dealer, channel, code, ok);
  const g = check(kit);
  if (g.ok !== true) {
    const vs = new Set<string | null>();
    for (const v of g.violations ?? []) {
      if (isPlainObject(v)) vs.add(((v.code || v.type) as string | undefined) ?? null);
    }
    const sorted = [...vs].sort((a, b) => cpCmp(a ?? 'None', b ?? 'None'));
    return { code: 'AFF_GUARDRAIL', reason: `kit không qua guardrail ${pyListRepr(sorted)}` };
  }
  const sha = createHash('sha256').update(kit, 'utf8').digest('hex');
  return { code: null, reason: 'đạt', kit, sha12: sha.slice(0, 12) };
}

export type CommissionLine = {
  rate_pct: string;
  commission_vnd: bigint;
  flags: string[];
  status: 'tinh' | 'huy';
};

/** Tỷ lệ từ `commissionRate(..., online=true)` — không công thức thứ 2. */
export function commissionLine(
  dealer: unknown,
  category: unknown,
  amountVnd: bigint | number,
  codeStatus: string,
  cancelled: boolean,
): CommissionLine {
  const d: Dealer = isPlainObject(dealer) ? dealer : { status: 'ended' };
  const rate = commissionRate(d, category, true);
  const flags: string[] = [];
  if (category === 'alcohol') flags.push('ruou_online');
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) flags.push('thieu_sku');
  if ((Object.hasOwn(d, 'status') ? d.status : 'active') !== 'active') flags.push('dai_ly_ngung');
  if (codeStatus === 'pending' || codeStatus === 'void') flags.push('ma_chua_kich_hoat');
  else if (codeStatus === 'revoked') flags.push('ma_da_thu_hoi');
  if (cancelled) flags.push('huy');
  const paid = !cancelled && (codeStatus === 'active' || codeStatus === 'revoked');
  const amt = big(amountVnd);
  const com = paid ? commissionOf(amt > 0n ? amt : 0n, rate) : 0n;
  return { rate_pct: rate, commission_vnd: com, flags, status: cancelled ? 'huy' : 'tinh' };
}

// ------------------------------------------------------------ DB: phát hành mã
async function dealerOf(db: Db, code: string): Promise<Dealer | null> {
  const { rows } = await db.query(
    'select code, name, region, status, commission_default::text as commission_default, source from dealers where code = $1',
    [code],
  );
  return rows[0] ?? null;
}

async function freshCode(db: Db, rand: Rand = SECURE): Promise<string> {
  for (let i = 0; i < NEW_CODE_TRIES; i++) {
    const c = newCode(rand);
    const { rows } = await db.query(
      'select exists(select 1 from affiliate_codes where code = $1) as x',
      [c],
    );
    if (!rows[0]?.x) return c;
  }
  throw new RuntimeError(`sinh mã trùng ${NEW_CODE_TRIES} lần liên tiếp`);
}

export type IssueResult = KitResult & {
  skipped: boolean;
  aff_code?: string | null;
  aff_status?: string;
  qid: bigint | null;
};

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

export async function issue(
  db: Db,
  dealerCode: string,
  channel: string,
  draftIds: bigint[],
  o: { by: string; dryRun?: boolean; dcfg?: DirectorConfig; rand?: Rand },
): Promise<IssueResult> {
  const dealer = await dealerOf(db, dealerCode);
  if (dealer === null || dealer.status !== 'active') {
    return { ...buildKit(dealer, channel, '', [], {}, null), skipped: false, qid: null };
  }
  const old = (
    await db.query(
      "select code, status from affiliate_codes where dealer_code = $1 and channel = $2 and status in ('pending', 'active')",
      [dealerCode, channel],
    )
  ).rows[0];
  if (old !== undefined) {
    return {
      code: null,
      reason: 'đã có mã',
      skipped: true,
      aff_code: old.code,
      aff_status: old.status,
      qid: null,
    };
  }
  const golden: Golden = {};
  for (const r of (await db.query('select sku_key, category from sku_master')).rows) {
    golden[r.sku_key] = { category: r.category };
  }
  const rmap = (await readinessFromDb(db)) ?? new Map();
  const drafts = await loadDrafts(db, draftIds);
  const code = await freshCode(db, o.rand);
  const res = buildKit(dealer, channel, code, drafts, golden, rmap);
  if (res.code || o.dryRun) return { ...res, skipped: false, aff_code: code, qid: null };
  let qid: bigint;
  try {
    // Mã và mục hàng duyệt cùng 1 giao dịch — cùng sống/cùng mất.
    qid = await withTx(db, async (c) => {
      const { rows } = await c.query(
        'insert into affiliate_codes (code, dealer_code, channel, created_by) values ($1, $2, $3, $4) returning id::text as id',
        [code, dealerCode, channel, o.by],
      );
      const cid = String(rows[0]?.id);
      const q = await submit(c, {
        block: 'sales',
        objectType: 'affiliate_program',
        objectId: `aff-${cid}`,
        title: `Affiliate đại lý ${dealerCode} × ${channel}`,
        payload: res.kit as string,
        createdBy: o.by,
        ...(o.dcfg ? { cfg: o.dcfg } : {}),
      });
      await c.query('update affiliate_codes set queue_id = $1 where id = $2', [String(q), cid]);
      return q;
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    return {
      code: null,
      reason: 'đã có mã (ghi song song)',
      skipped: true,
      aff_code: null,
      qid: null,
    };
  }
  return { ...res, skipped: false, aff_code: code, qid };
}

export type ReleaseResult = {
  code: string | null;
  reason: string;
  path?: string;
  aff_code?: string;
};

/** Không gửi — chỉ kích hoạt mã + ghi file kit. */
export async function release(
  db: Db,
  qid: bigint,
  o: { by: string; outDir?: string },
): Promise<ReleaseResult> {
  const row = (
    await db.query(
      'select block, object_type, object_id, payload, status from approval_queue where id = $1',
      [String(qid)],
    )
  ).rows[0];
  const m = row ? OID_RE.exec(row.object_id ?? '') : null;
  if (row?.block !== 'sales' || row.object_type !== 'affiliate_program' || m === null) {
    return { code: 'AFF_NOT_APPROVED', reason: `mục #${qid} không phải chương trình affiliate` };
  }
  const { payload, status } = row as { payload: string | null; status: string };
  const c = (
    await db.query(
      'select id::text as id, code, dealer_code, status, queue_id::text as queue_id from affiliate_codes where id = $1',
      [m[1]],
    )
  ).rows[0];
  if (c === undefined || !(c.queue_id === null || c.queue_id === String(qid))) {
    return { code: 'AFF_NOT_APPROVED', reason: `mục #${qid} không có mã affiliate tương ứng` };
  }
  if (status === 'rejected' || status === 'expired') {
    await db.query(
      "update affiliate_codes set status = 'void', queue_id = $1 where id = $2 and status = 'pending'",
      [String(qid), c.id],
    );
    return { code: 'AFF_NOT_APPROVED', reason: `mục #${qid} ${status} — mã đã hủy (void)` };
  }
  if (status !== 'approved') {
    return { code: 'AFF_NOT_APPROVED', reason: `mục #${qid} trạng thái ${status} — chưa duyệt` };
  }
  if (c.status !== 'pending' && c.status !== 'active') {
    return { code: 'AFF_NOT_APPROVED', reason: `mã của mục #${qid} đang ${c.status}` };
  }
  const ok = (await aqVerify(db, qid, payload ?? '')) && (payload ?? '').includes(c.code);
  if (!ok) return { code: 'AFF_PAYLOAD_CHANGED', reason: `mục #${qid} không khớp bản đã duyệt` };
  await db.query(
    "update affiliate_codes set status = 'active', activated_at = now(), activated_by = $1, queue_id = $2 where id = $3 and status = 'pending'",
    [o.by, String(qid), c.id],
  );
  const path = await writeReport(
    payload as string,
    o.outDir ?? REPORTS_DIR,
    `affiliate-kit-${c.dealer_code}-${qid}.md`,
    await queueSample(db, qid),
  );
  return { code: null, reason: 'đạt', path, aff_code: c.code };
}

/** Chỉ thu hồi mã `active` → true nếu đã thu hồi. */
export async function revoke(db: Db, code: string, by: string): Promise<boolean> {
  const { rows } = await db.query(
    "update affiliate_codes set status = 'revoked', revoked_at = now(), revoked_by = $1 where code = $2 and status = 'active' returning id",
    [by, code],
  );
  return rows.length > 0;
}

// ------------------------------------------------------------ DB: ghi nhận đơn + báo cáo
// Mỗi (kênh, đơn, dòng): trạng thái/giá/SL từ snapshot đơn MỚI NHẤT; mã voucher từ dòng mới nhất CÓ
// mã (file export sau thiếu cột mã không xóa ghi nhận).
const ATTR_SQL = `
with o as (
  select r.id, r.channel, r.order_id_hash,
         coalesce(r.seller_sku, r.item_id) as line_key, r.sku_key,
         r.price_vnd, r.qty, r.status,
         upper(btrim(r.raw->>'voucher_code')) as vcode,
         s.imported_at
  from market_rows r join market_snapshots s on s.id = r.snapshot_id
  where r.export_kind = 'order' and r.order_id_hash is not null
    and coalesce(r.seller_sku, r.item_id) is not null
), l as (
  select distinct on (channel, order_id_hash, line_key) *
  from o order by channel, order_id_hash, line_key, imported_at desc, id desc
), v as (
  select distinct on (channel, order_id_hash, line_key)
         channel, order_id_hash, line_key, vcode
  from o where coalesce(vcode, '') <> ''
  order by channel, order_id_hash, line_key, imported_at desc, id desc
)
select l.id::text as id, l.channel, l.order_id_hash, l.line_key, l.sku_key, m.category,
       coalesce(l.price_vnd, 0)::text as price, coalesce(l.qty, 0) as qty, l.status, v.vcode,
       exists(select 1 from settlement_rows sr where sr.channel = l.channel
              and sr.order_id_hash = l.order_id_hash) as settled
from l join v using (channel, order_id_hash, line_key)
left join sku_master m on m.sku_key = l.sku_key
order by l.channel, l.order_id_hash, l.line_key
`;

const UPSERT_SQL = `
insert into affiliate_attributions as a (code_id, dealer_code, channel,
  order_id_hash, line_key, market_row_id, sku_key, category, qty, amount_vnd,
  rate_pct, commission_vnd, status, flags, settled)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (channel, order_id_hash, line_key) do update set
  code_id = excluded.code_id, dealer_code = excluded.dealer_code,
  market_row_id = excluded.market_row_id, sku_key = excluded.sku_key,
  category = excluded.category, qty = excluded.qty,
  amount_vnd = excluded.amount_vnd, rate_pct = excluded.rate_pct,
  commission_vnd = excluded.commission_vnd, status = excluded.status,
  flags = excluded.flags, settled = excluded.settled, updated_at = now()
where (a.code_id, a.dealer_code, a.market_row_id, a.sku_key, a.category,
       a.qty, a.amount_vnd, a.rate_pct, a.commission_vnd, a.status, a.flags,
       a.settled)
  is distinct from
      (excluded.code_id, excluded.dealer_code, excluded.market_row_id,
       excluded.sku_key, excluded.category, excluded.qty, excluded.amount_vnd,
       excluded.rate_pct, excluded.commission_vnd, excluded.status,
       excluded.flags, excluded.settled)
returning (xmax = 0) as ins
`;

/** `{shopee, tiktok}: trạng thái hủy` từ mapping (Python `_cancel_map`; thiếu kênh → lỗi). */
export function cancelMapAff(mapFile?: string): Record<string, string[]> {
  const [m, why] = loadMarketMapping(mapFile);
  if (m === null) throw new RangeError(why as string);
  const out: Record<string, string[]> = {};
  for (const ch of ['shopee', 'tiktok']) {
    const spec = m[ch];
    const order = isPlainObject(spec) ? spec.order : undefined;
    if (!isPlainObject(order)) throw new TypeError(`mapping thiếu ${ch}.order`);
    out[ch] = (order.cancel_status as string[] | null) || [];
  }
  return out;
}

export type AttrCounts = {
  new: number;
  updated: number;
  same: number;
  unknown_code: number;
  web_skipped: number;
};

/** Ghi nhận đơn sàn qua mã → affiliate_attributions (idempotent). finance-03.2 TẮT → RolloutBlocked,
 * không ghi. */
export async function attribute(
  db: Db,
  cancel: Record<string, Iterable<string>> | null = null,
  mapFile?: string,
): Promise<AttrCounts> {
  await checkGenerate(db, FEATURE_ATTR, 'ghi nhận đơn affiliate');
  const cm = new Map(
    Object.entries(cancel ?? cancelMapAff(mapFile)).map(([k, v]) => [k, new Set(v)]),
  );
  const res: AttrCounts = { new: 0, updated: 0, same: 0, unknown_code: 0, web_skipped: 0 };
  await withTx(db, async (c) => {
    const codes = new Map<string, Record<string, string>>();
    for (const r of (
      await c.query(
        'select id::text as id, code, dealer_code, channel, status from affiliate_codes',
      )
    ).rows) {
      codes.set(r.code, r);
    }
    const dealers = new Map<string, Dealer>();
    for (const r of (
      await c.query(
        'select code, status, commission_default::text as commission_default from dealers',
      )
    ).rows) {
      dealers.set(r.code, { status: r.status, commission_default: r.commission_default });
    }
    for (const r of (await c.query(ATTR_SQL)).rows) {
      const hit = codes.get(r.vcode);
      if (hit === undefined) {
        res.unknown_code++;
        continue;
      }
      if (hit.channel === 'web') {
        res.web_skipped++;
        continue;
      }
      if (hit.channel !== r.channel) {
        res.unknown_code++;
        continue;
      }
      const amount = big(r.price) * big(r.qty);
      const line = commissionLine(
        dealers.get(hit.dealer_code as string) ?? null,
        r.category,
        amount,
        hit.status as string,
        cm.get(r.channel)?.has(r.status) ?? false,
      );
      const { rows } = await c.query(UPSERT_SQL, [
        hit.id,
        hit.dealer_code,
        r.channel,
        r.order_id_hash,
        r.line_key,
        r.id,
        r.sku_key,
        r.category,
        r.qty,
        String(amount),
        line.rate_pct,
        String(line.commission_vnd),
        line.status,
        line.flags,
        r.settled,
      ]);
      if (rows[0] === undefined) res.same++;
      else if (rows[0].ins) res.new++;
      else res.updated++;
    }
  });
  return res;
}

export const vnd = (n: unknown): string => `${groupDots(big(n || 0))}đ`;

export type ReportRow = [string, string, unknown, unknown, boolean, string, string[] | null];

/** THUẦN — bảng hoa hồng từ dòng (đại lý, kênh, doanh số, hoa hồng, đã quyết toán, trạng thái, cờ).
 * Không in mã đơn/hash, không tên đại lý. */
export function renderReport(rows: ReportRow[], start: string, endExcl: string): string {
  type Agg = { n: number; amt: bigint; com: bigint; sett: bigint; flags: Map<string, number> };
  const agg = new Map<string, Agg>();
  for (const [dcode, ch, amt, com, settled, st, flags] of rows) {
    const k = `${dcode}\u0000${ch}`;
    let g = agg.get(k);
    if (g === undefined) {
      g = { n: 0, amt: 0n, com: 0n, sett: 0n, flags: new Map() };
      agg.set(k, g);
    }
    g.n++;
    g.amt += st === 'tinh' ? big(amt) : 0n;
    g.com += big(com);
    g.sett += settled ? big(com) : 0n;
    for (const f of flags ?? []) g.flags.set(f, (g.flags.get(f) ?? 0) + 1);
  }
  const L = [
    `# Hoa hồng affiliate đại lý ${start} → ${addDays(endExcl, -1)}`,
    '',
    `${REPORT_HEAD}.`,
    '',
    '| Đại lý | Kênh | Dòng | Doanh số (trừ hủy) | Hoa hồng tạm tính | Đã quyết toán sàn | Cờ |',
    '|---|---|---|---|---|---|---|',
  ];
  const keys = [...agg.keys()].sort((a, b) => {
    const [a1, a2] = a.split('\u0000') as [string, string];
    const [b1, b2] = b.split('\u0000') as [string, string];
    return cpCmp(a1, b1) || cpCmp(a2, b2);
  });
  for (const k of keys) {
    const g = agg.get(k) as Agg;
    const [dcode, ch] = k.split('\u0000');
    const fl = [...g.flags.keys()]
      .sort(cpCmp)
      .map((f) => `${f}×${g.flags.get(f)}`)
      .join(', ');
    L.push(
      `| ${dcode} | ${ch} | ${g.n} | ${vnd(g.amt)} | ${vnd(g.com)} | ${vnd(g.sett)} | ${fl || '-'} |`,
    );
  }
  if (!agg.size) L.push('| (không có dòng) | | | | | | |');
  L.push(
    '',
    "Ghi chú: 'đã quyết toán sàn' = đơn đã có trong file quyết toán (settlement), KHÔNG phải đã chi hoa hồng; phí affiliate sàn thu (AMS) không cộng vào đây. Rượu và đơn hủy = 0.",
    '',
  );
  return L.join('\n');
}

/** CHỈ ĐỌC. Kỳ theo `market_snapshots.imported_at` giờ VN [start, endExcl). */
export async function report(db: Db, start: string, endExcl: string): Promise<string> {
  const { rows } = await db.query({
    text:
      'select a.dealer_code, a.channel, a.amount_vnd, a.commission_vnd, a.settled, a.status, a.flags from affiliate_attributions a' +
      ' join market_rows r on r.id = a.market_row_id join market_snapshots s on s.id = r.snapshot_id' +
      ' where s.imported_at >= $1 and s.imported_at < $2',
    values: [vnMidnight(start), vnMidnight(endExcl)],
    rowMode: 'array',
  });
  return renderReport(rows as ReportRow[], start, endExcl);
}

/** `--draft-ids`: 1..MAX_DRAFTS id số dương (ASCII), không trùng → bigint[] | null. */
export function parseIds(s: string | null | undefined): bigint[] | null {
  const parts = (s ?? '').split(',').map(pyStrip);
  if (!parts.every((p) => /^[0-9]+$/.test(p))) return null;
  const ids = parts.map((p) => BigInt(p));
  const ok = ids.length >= 1 && ids.length <= MAX_DRAFTS && new Set(ids).size === ids.length;
  return ok && ids.every((i) => i > 0n) ? ids : null;
}
