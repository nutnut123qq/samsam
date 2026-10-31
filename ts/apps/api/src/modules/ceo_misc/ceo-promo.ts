import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { addDays, dmy } from '@samsam/core/ops/period';
import { contentSha256 } from '@samsam/core/ops/store';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { readinessKey as key2 } from '@samsam/core/security/guardrail';
import { cpHead } from '@samsam/core/security/py';
import * as kl from '../kd_listing_live/kd-listing.js';
import type { PlanRow } from '../kd_price/kd-price.js';
import { NO_SKU } from './ceo-audit.js';
import { tupleCmp } from './common.js';

// v14.5 ceo-04.1 → đợt hoàn thiện 22/10: ceo-04.5 — port `agents/ceo_promo.py`: Kiểm soát nội bộ so
// KM/voucher ĐANG CHẠY với bản đã duyệt (PL01 mục 2 "mỗi ngày so bài đăng, giá, voucher đang chạy
// với bản đã duyệt"). Tách khỏi `ceo_audit` để section trang TGĐ vẫn không có đường ghi nào.
// ĐANG CHẠY = (1) listing sàn mới nhất mỗi kênh có giá bán thực (`sale_price`) < giá niêm yết +
// (2) file xuất KM/voucher (`--running`, cùng định dạng CSV kế hoạch `kd_price --plan`; chỉ dòng có
// ngày hôm nay nằm trong khoảng). BẢN ĐÃ DUYỆT = (a) kế hoạch KM GĐ bán hàng chốt (`--plan`; sha256
// file ghi trong payload) + (b) giá KM golden `price_list` kind='promo' ĐÃ duyệt hiệu lực hôm nay.
// So THUẦN (`comparePromos`). Lệch → mục `ceo/promo_deviation` (TGĐ/BKS) — khóa theo ĐỢT
// `km:<khóa lệch>:<bằng chứng>` (bằng chứng = snapshot listing / sha file): lệch đang chờ duyệt →
// không đẩy thêm; đã quyết mà file/snapshot MỚI vẫn lệch → đợt mới. Payload chỉ kênh/mã SKU (nhóm
// rượu ẩn)/số/nguồn — không tiêu đề listing. Agent KHÔNG đổi KM/giá, không gọi sàn. Tắt → exit 2.

export const FEATURE_PROMO = 'ceo-04.5';
export const OT_PROMO = 'promo_deviation';
export const PROMO_AGENT = 'agent:ceo_audit';
export const JOB = 'agents.ceo_promo';
export const KM_NGOAI = 'km_ngoai_ke_hoach';
export const KM_LOAI = 'km_khac_loai';
export const KM_SAU = 'km_sau_hon_duyet';
export const KM_HAN = 'km_qua_thoi_gian';
export const KM_KSD = 'km_khong_so_duoc';
export const PROMO_LABELS: Record<string, string> = {
  [KM_NGOAI]: 'KM đang chạy không có bản duyệt hiệu lực',
  [KM_LOAI]: 'KM đang chạy khác loại với bản duyệt',
  [KM_SAU]: 'giá sau KM thấp hơn mức bản duyệt cho phép',
  [KM_HAN]: 'KM chạy quá ngày kết thúc của bản duyệt',
  [KM_KSD]: 'không so được (thiếu giá list golden)',
  [NO_SKU]: 'listing có KM nhưng không xác định được SKU',
};

/** Dòng KM đang chạy (`src` listing|file) hoặc bản duyệt (`src` plan|golden). Ngày 'YYYY-MM-DD'. */
export type Promo = {
  src: string;
  channel: string;
  sku: string | null;
  /** null = không rõ (đang chạy) / mọi loại (bản duyệt). */
  kind: string | null;
  price: number | null;
  pct: number | null;
  start: string | null;
  /** null = không rõ / không hạn. */
  end: string | null;
  ref: string;
  evidence?: string;
};
export type PromoFinding = {
  channel: string;
  sku: string | null;
  src: string;
  ref: string;
  evidence: string;
  run: Promo;
  code: string;
  allowed: Promo[];
};
export type CompareResult = { findings: PromoFinding[]; ok: number; planned_idle: Promo[] };
/** {key2(sku, kênh): giá list}. */
export type Lists = Map<string, number>;

/** Python `Fraction` dương tối thiểu (d > 0). */
type Frac = { n: bigint; d: bigint };
const lt = (a: Frac, b: Frac): boolean => a.n * b.d < b.n * a.d;

/** Giá sau KM của 1 dòng (phân số) | null khi cần list mà thiếu. */
function priceOf(p: Partial<Promo>, lst: number | null | undefined): Frac | null {
  if (p.price !== null && p.price !== undefined) return { n: BigInt(p.price), d: 1n };
  if (p.pct !== null && p.pct !== undefined && lst) {
    return { n: BigInt(lst) * BigInt(100 - p.pct), d: 100n };
  }
  return null;
}

/** THUẦN. → {findings, ok, planned_idle}. */
export function comparePromos(
  running: readonly Promo[],
  approved: readonly Promo[],
  lists: Lists,
  today: string,
): CompareResult {
  const live = approved.filter(
    (a) => (a.start as string) <= today && (a.end === null || a.end >= today),
  );
  const findings: PromoFinding[] = [];
  let ok = 0;
  const used = new Set<Promo>();
  for (const r of running) {
    const base = {
      channel: r.channel,
      sku: r.sku,
      src: r.src,
      ref: r.ref,
      evidence: r.evidence as string,
      run: r,
    };
    if (r.sku === null) {
      findings.push({ ...base, code: NO_SKU, allowed: [] });
      continue;
    }
    let cands = live.filter((a) => a.channel === r.channel && a.sku === r.sku);
    for (const a of cands) used.add(a);
    if (!cands.length) {
      findings.push({ ...base, code: KM_NGOAI, allowed: [] });
      continue;
    }
    if (r.kind !== null) {
      const same = cands.filter((a) => a.kind === null || a.kind === r.kind);
      if (!same.length) {
        findings.push({ ...base, code: KM_LOAI, allowed: cands });
        continue;
      }
      cands = same;
    }
    const lst = lists.get(key2(r.sku, r.channel));
    const rp = priceOf(r, lst);
    const ap = cands.map((a) => priceOf(a, lst));
    const codes: string[] = [];
    if (rp === null || ap.some((x) => x === null)) codes.push(KM_KSD);
    else if (
      lt(
        rp,
        (ap as Frac[]).reduce((m, x) => (lt(x, m) ? x : m)),
      )
    )
      codes.push(KM_SAU);
    const ends = cands.map((a) => a.end);
    if (
      r.end !== null &&
      !ends.includes(null) &&
      r.end > ([...(ends as string[])].sort().pop() as string)
    ) {
      codes.push(KM_HAN);
    }
    if (!codes.length) ok += 1;
    for (const c of codes) findings.push({ ...base, code: c, allowed: cands });
  }
  const idle = live.filter((a) => !used.has(a));
  findings.sort((a, b) =>
    tupleCmp(
      [a.channel, a.sku ?? '', a.code, a.src, a.ref],
      [b.channel, b.sku ?? '', b.code, b.src, b.ref],
    ),
  );
  return { findings, ok, planned_idle: idle };
}

/** Dòng `kd_price.readPlan` → dạng chung của `comparePromos`. */
export function planRows(rows: readonly PlanRow[], src: string, evidence: string): Promo[] {
  return rows.map((r) => ({
    src,
    channel: r.channel,
    sku: r.sku_key,
    kind: r.kind,
    price: r.price,
    pct: r.pct,
    start: r.start,
    end: r.end,
    ref: `dòng ${r.row_no} chương trình ${r.program_id}`,
    evidence,
  }));
}

export type Sources = { running: Promo[]; golden: Promo[]; lists: Lists; alcohol: Set<string> };

/** CHỈ SELECT → {running listing, approved golden, lists, alcohol}. */
export async function promoSources(db: Db, mapping: unknown, today: string): Promise<Sources> {
  const [rows] = await kl.runningListings(db, mapping);
  const running: Promo[] = [];
  for (const m of rows) {
    const sp = m.sale_price ?? null;
    const lp = m.price_vnd;
    if (sp === null || lp === null || !(sp > 0 && sp < lp)) continue;
    const ref = [
      m.item_id ? kl.refCode(m.item_id) : null,
      m.seller_sku ? kl.refCode(m.seller_sku) : null,
    ]
      .filter((x) => x)
      .join(' · ');
    running.push({
      src: 'listing',
      channel: m.channel,
      sku: m.sku_key,
      kind: null,
      price: sp,
      pct: null,
      start: null,
      end: null,
      ref: `listing ${ref || `dòng ${m.row_no}`}`,
      evidence: `s${m.snapshot_id}`,
    });
  }
  const g = await db.query<{
    id: string;
    sku_key: string;
    channel: string;
    price_vnd: string;
    program_id: string;
    vf: string;
    vt: string | null;
  }>(
    "select id::text as id, sku_key, channel, price_vnd::text as price_vnd, program_id, valid_from::text as vf, valid_to::text as vt from price_list where kind = 'promo' and approved_by is not null and program_id is not null and valid_from <= $1::date and (valid_to is null or valid_to > $1::date) order by id",
    [today],
  );
  const golden: Promo[] = g.rows.map((r) => ({
    src: 'golden',
    channel: r.channel,
    sku: r.sku_key,
    kind: null,
    price: Number(r.price_vnd),
    pct: null,
    start: r.vf,
    end: r.vt ? addDays(r.vt, -1) : null,
    ref: `price_list #${r.id} chương trình ${kl.refCode(r.program_id)}`,
    evidence: 'g',
  }));
  const lists = kl.listPrices(await kl.goldenPrices(db, today));
  const alcohol = new Set(
    (
      await db.query<{ sku_key: string; category: string | null }>(
        'select sku_key, category from sku_master',
      )
    ).rows
      .filter((r) => r.category === 'alcohol')
      .map((r) => r.sku_key),
  );
  return { running, golden, lists, alcohol };
}

/** Python `f"{int(x):,}".replace(",", ".") + " đ"`; null → '—'. */
export function vnd(x: number | bigint | null | undefined): string {
  if (x === null || x === undefined) return '—';
  const n = typeof x === 'bigint' ? x : BigInt(Math.trunc(x));
  const s = (n < 0n ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0n ? '-' : ''}${s} đ`;
}

/** Mô tả 1 dòng KM (giá/chiết khấu + khoảng ngày) cho payload. */
export function desc(p: Partial<Promo>, lst: number | null | undefined): string {
  let s: string;
  if (p.price !== null && p.price !== undefined) s = `giá KM ${vnd(p.price)}`;
  else {
    s = `chiết khấu ${p.pct}%`;
    const pr = priceOf(p, lst);
    if (pr !== null) s += ` (≈ ${vnd(pr.n / pr.d)})`; // int(Fraction) — dương: cắt phần lẻ
  }
  if (p.start !== null && p.start !== undefined) {
    s += `, ${dmy(p.start)}–${p.end ? dmy(p.end) : 'không hạn'}`;
  }
  return s;
}

export type PromoItem = {
  object_type: string;
  base: string;
  object_id: string;
  title: string;
  payload: string;
};

export function promoItem(
  f: PromoFinding,
  lists: Lists,
  alcohol: ReadonlySet<string>,
  planSha: string | null,
): PromoItem {
  const sku =
    f.sku !== null && alcohol.has(f.sku)
      ? 'nhóm hạn chế'
      : f.sku
        ? kl.refCode(f.sku)
        : '(chưa map SKU)';
  const lst = f.sku === null ? undefined : lists.get(key2(f.sku, f.channel));
  const allowed =
    f.allowed.map((a) => `${a.ref} (${a.src}): ${desc(a, lst)}`).join('; ') || 'không có';
  const key = [f.code, f.channel, f.sku || '', f.src, f.ref, desc(f.run, lst), allowed].join('|');
  const base = contentSha256(key).slice(0, 16);
  const where = `kênh ${f.channel}, SKU ${sku}`;
  const plan = planSha
    ? ` Kế hoạch KM đối chiếu: sha256 ${planSha.slice(0, 12)}.`
    : ' Không có file kế hoạch KM (--plan) — chỉ đối chiếu giá KM golden đã duyệt.';
  const label = PROMO_LABELS[f.code] as string;
  return {
    object_type: OT_PROMO,
    base: `km:${base}:`,
    object_id: `km:${base}:${f.evidence}`,
    title: cpHead(`Kiểm soát KM — ${label} — ${where}`, 300),
    payload:
      `Kiểm soát nội bộ ceo-04.5 (NHÁP): ${where} — mã ${f.code} (${label}). Đang chạy (${f.src} ${f.ref}): ${desc(f.run, lst)}. Bản duyệt hiệu lực: ${allowed}. Giá list golden: ${vnd(lst)}.${plan}` +
      ' Việc cần làm: TGĐ/BKS yêu cầu GĐ bán hàng giải trình hoặc điều chỉnh trên Seller Center. Agent KHÔNG đổi KM/giá.',
  };
}

export type PromoCheck = CompareResult & {
  running: number;
  new: number;
  enqueued: number;
  items: PromoItem[];
};

/** So KM đang chạy ↔ bản duyệt → đẩy mục lệch theo đợt. Tắt → RolloutBlocked (0 ghi). */
export async function promoCheck(
  db: Db,
  today: string,
  o: {
    mapping: unknown;
    plan: readonly PlanRow[] | null;
    runningFile: readonly PlanRow[] | null;
    planSha: string | null;
    runningSha: string | null;
    cfg: DirectorConfig;
    dryRun?: boolean;
  },
): Promise<PromoCheck> {
  await checkGenerate(db, FEATURE_PROMO, 'so KM đang chạy');
  const src = await promoSources(db, o.mapping, today);
  // file: chỉ dòng ĐANG chạy
  const live = (o.runningFile ?? []).filter((r) => r.start <= today && today <= r.end);
  const running = [
    ...src.running,
    ...planRows(live, 'file', `f${(o.runningSha ?? '').slice(0, 12)}`),
  ];
  const approved = [...src.golden, ...planRows(o.plan ?? [], 'plan', 'p')];
  const res = comparePromos(running, approved, src.lists, today);
  const items = res.findings.map((f) => promoItem(f, src.lists, src.alcohol, o.planSha));
  const have = (
    await db.query<{ object_id: string; status: string }>(
      'select object_id, status from approval_queue where object_type = $1',
      [OT_PROMO],
    )
  ).rows;
  const exact = new Set(have.map((h) => h.object_id));
  // Python `o.rsplit(":", 1)[0] + ":"`
  const pending = new Set(
    have
      .filter((h) => h.status === 'pending')
      .map((h) => {
        const i = h.object_id.lastIndexOf(':');
        return `${i < 0 ? h.object_id : h.object_id.slice(0, i)}:`;
      }),
  );
  const fresh: PromoItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (exact.has(it.object_id) || pending.has(it.base) || seen.has(it.object_id)) continue;
    seen.add(it.object_id);
    fresh.push(it);
  }
  let n = 0;
  if (!o.dryRun) {
    for (const it of fresh) {
      try {
        await submit(db, {
          block: 'ceo',
          objectType: OT_PROMO,
          objectId: it.object_id,
          title: it.title,
          payload: it.payload,
          createdBy: PROMO_AGENT,
          cfg: o.cfg,
        });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') continue; // ghi song song: đã có
        throw e;
      }
      n += 1;
    }
  }
  return { ...res, running: running.length, new: fresh.length, enqueued: n, items };
}
