import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { submit as directorSubmit } from '@samsam/core/ops/director';
import { isDict, isPyInt } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { pyStr, pyTruthy } from '@samsam/core/security/py';
import {
  type CogsVersion,
  cogsAt,
  type Day,
  fetchVersions,
  type GoldenPrices,
  goldenPrices,
  grp,
  key2,
  pyDumps,
  type Ratio,
  readStrictJson,
} from './deps.js';

// Port `agents/combo_price.py` (đợt hợp đồng C09 — intel-05.2, PL01 Tình báo "thử ... giá combo để loại
// phương án yếu trước khi chi tiền"): phương án NHÁP giá combo từ thành phần `bom_items` + giá
// list/floor ĐÃ DUYỆT + giá vốn ĐÃ DUYỆT + tỷ lệ thực nhận (GIẢ ĐỊNH) + mức giảm `data/combo_price.json`
// (GIẢ ĐỊNH). Thành phần nhóm hạn chế → không đề xuất; thiếu giá list đã duyệt → không bịa giá. Nội
// dung mục qua guardrail TRƯỚC khi vào hàng duyệt. Agent KHÔNG áp giá, KHÔNG đổi KM. Rollout TẮT →
// không sinh.

export const CFG_FILE = dataPath('combo_price.json');
export const FEATURE = 'intel-05.2';
export const BLOCK = 'intel';
export const OT = 'combo_price_option';
export const AGENT = 'agent:combo_price';

export type ComboCfg = {
  pcts: number[];
  step: number;
  channels: unknown[];
  status: string;
  chot_boi: unknown;
};

/** → cấu hình | RangeError (Python ValueError) — caller exit 1.
 * Khác Python có chủ đích (chặt hơn): `lam_tron_vnd: true` Python coi là số 1 (bool ⊂ int), TS từ chối. */
export function loadCfg(path: string = CFG_FILE): ComboCfg {
  const name = basename(path);
  const [d, err] = readStrictJson(path);
  if (err !== null) throw new RangeError(`${name} hỏng (${err})`);
  // Python `d["muc_giam_pct"]` trên list/số/null → TypeError, thiếu khóa → KeyError.
  if (!isDict(d)) throw new RangeError(`${name} hỏng (TypeError)`);
  for (const k of ['muc_giam_pct', 'lam_tron_vnd', 'channels']) {
    if (!Object.hasOwn(d, k)) throw new RangeError(`${name} hỏng (KeyError)`);
  }
  const pcts = d.muc_giam_pct;
  const step = d.lam_tron_vnd;
  const chs = d.channels;
  if (
    !(
      Array.isArray(pcts) &&
      pcts.length &&
      pcts.every((p) => isPyInt(p) && p > 0 && p < 90) &&
      isPyInt(step) &&
      step > 0 &&
      Array.isArray(chs) &&
      chs.length
    )
  ) {
    throw new RangeError('combo_price.json: muc_giam_pct/lam_tron_vnd/channels sai');
  }
  return {
    pcts: [...new Set(pcts as number[])].sort((a, b) => a - b),
    step: step as number,
    channels: chs,
    status: pyTruthy(d.status) ? pyStr(d.status) : '',
    chot_boi: Object.hasOwn(d, 'chot_boi') ? d.chot_boi : null,
  };
}

/** r12 G1-L6: (sku, kênh) được phép nói/bán theo READINESS (TP_THUONG/QC_DAY_DU) — KHÔNG dùng
 * `v_promotable` (view đó còn đòi giá list đã duyệt → SKU chỉ thiếu giá bị gắn nhầm `nhom_han_che`). */
export async function allowedSet(db: Db): Promise<Set<string>> {
  const { rows } = await db.query(
    "select sku_key, channel from sku_readiness where readiness in ('TP_THUONG', 'QC_DAY_DU')",
  );
  return new Set(rows.map((r) => key2(r.sku_key, r.channel)));
}

export type Option = { pct: number; price: number; status: string };
export type Evaluated =
  | { status: 'nhom_han_che' }
  | { status: 'thieu_du_lieu'; why: string }
  | {
      status: 'de_xuat';
      base: number;
      floor: number | null;
      cost: number | null;
      options: Option[];
    };

/** THUẦN. items [(sku, qty)] → {status, base, floor, cost, options}. Giá = tổng list × (1 − %), làm tròn
 * xuống bội số `step`; `duoi_san` | `lo` | `khong_tinh_duoc` (thiếu giá vốn/floor/tỷ lệ — không kết luận
 * không lỗ) | `dat`. */
export function evaluate(
  items: [string, number][],
  prices: GoldenPrices,
  promotable: Set<string>,
  cogs: CogsVersion[],
  net: Record<string, Ratio> | null,
  cfg: Pick<ComboCfg, 'pcts' | 'step'>,
  ch: string,
  today: Day,
): Evaluated {
  if (items.some(([sku]) => !promotable.has(key2(sku, ch)))) return { status: 'nhom_han_che' };
  let base = 0;
  let floor: number | null = 0;
  let cost: number | null = 0;
  for (const [sku, q] of items) {
    const g = prices.get(key2(sku, ch)) ?? {};
    const lst = g.list;
    if (!lst?.approved)
      return { status: 'thieu_du_lieu', why: `thiếu giá list ĐÃ DUYỆT của ${sku}` };
    base += q * lst.price;
    const fl = g.floor;
    floor = floor === null || !fl || !fl.approved ? null : floor + q * fl.price;
    const c = cogsAt(cogs, sku, today);
    cost = cost === null || c === null ? null : cost + q * c;
  }
  const r = net && Object.hasOwn(net, ch) ? (net[ch] as Ratio) : null;
  const options = cfg.pcts.map((p) => {
    const price = Number(
      ((BigInt(base) * BigInt(100 - p)) / 100n / BigInt(cfg.step)) * BigInt(cfg.step),
    );
    let st: string;
    if (floor !== null && price < floor) st = 'duoi_san';
    else if (cost === null || r === null || floor === null) st = 'khong_tinh_duoc';
    else if (Number((BigInt(price) * r.n) / r.d) - cost < 0) st = 'lo';
    else st = 'dat';
    return { pct: p, price, status: st };
  });
  return { status: 'de_xuat', base, floor, cost, options };
}

const dots = (s: string) => s.replaceAll(',', '.');

/** Nội dung mục (chuỗi Python: `.replace(",", ".")` áp CẢ câu đầu gồm mã + tên combo). */
export function payload(
  key: string,
  name: string,
  ch: string,
  r: Extract<Evaluated, { status: 'de_xuat' }>,
  cfg: Pick<ComboCfg, 'status' | 'chot_boi'>,
): string {
  const L = [
    dots(
      `Phương án NHÁP giá combo ${key} (${name}) trên kênh ${ch} — agent KHÔNG áp giá. Tổng giá list ĐÃ DUYỆT các thành phần: ${grp(r.base)} đ`,
    ) +
      (r.floor !== null ? dots(`; tổng giá sàn: ${grp(r.floor)} đ`) : '; thiếu giá sàn đã duyệt') +
      (r.cost !== null ? '' : '; thiếu giá vốn đã duyệt (biên không tính được)') +
      '.',
  ];
  for (const o of r.options)
    L.push(dots(`- Chiết khấu ${o.pct}% → ${grp(o.price)} đ: ${o.status}`));
  L.push(
    `Giả định mức chiết khấu: data/combo_price.json (${cfg.status}; người chốt: ${pyTruthy(cfg.chot_boi) ? pyStr(cfg.chot_boi) : 'chưa có'}). Nguồn: bom_items, price_list (đã duyệt), cogs_versions (đã duyệt), fpa_config.`,
  );
  return L.join('\n');
}

export type ComboRec = {
  combo: string;
  channel: string;
  status: string;
  why: string | null;
  sample: boolean;
  item?: { object_id: string; title: string; payload: string };
};

/** CHỈ SELECT → [{combo, channel, status, item?}]. Khóa sha theo dữ liệu đầu vào — chạy lại không nhân
 * bản; đầu vào đổi → đợt mới. */
export async function propose(
  db: Db,
  today: Day,
  cfg: ComboCfg,
  net: Record<string, Ratio> | null,
  o: { prices?: GoldenPrices; promotable?: Set<string>; cogs?: CogsVersion[] } = {},
): Promise<ComboRec[]> {
  const prices = o.prices ?? (await goldenPrices(db, today));
  const promotable = o.promotable ?? (await allowedSet(db));
  const cogs = o.cogs ?? (await fetchVersions(db));
  const out: ComboRec[] = [];
  const combos = (
    await db.query('select combo_key, name, channels, source from bom_combos order by combo_key')
  ).rows;
  for (const c of combos) {
    const items = (
      await db.query('select sku_key, qty from bom_items where combo_key = $1 order by sku_key', [
        c.combo_key,
      ])
    ).rows.map((r) => [r.sku_key, Number(r.qty)] as [string, number]);
    for (const ch of cfg.channels.filter((x) =>
      (c.channels as unknown[]).includes(x),
    ) as string[]) {
      const r = evaluate(items, prices, promotable, cogs, net, cfg, ch, today);
      const rec: ComboRec = {
        combo: c.combo_key,
        channel: ch,
        status: r.status,
        why: r.status === 'thieu_du_lieu' ? r.why : null,
        sample: c.source === 'sample',
      };
      if (r.status === 'de_xuat') {
        const sig = createHash('sha256')
          .update(pyDumps([items, r.base, r.floor, r.cost, r.options], { ascii: true }), 'utf8')
          .digest('hex')
          .slice(0, 12);
        const text = payload(c.combo_key, c.name, ch, r, cfg);
        if (guardrailCheck(text).ok !== true) {
          rec.status = 'guardrail';
          rec.why = 'payload';
        } else {
          rec.item = {
            object_id: `cb:${c.combo_key}:${ch}:${sig}`,
            title: `Giá combo ${c.combo_key} (${ch}) — phương án nháp`,
            payload: text,
          };
        }
      }
      out.push(rec);
    }
  }
  return out;
}

/** Cổng SINH intel-05.2 → đẩy mục chưa có (mọi status) → số mục mới. */
export async function submit(db: Db, recs: ComboRec[]): Promise<number> {
  await checkGenerate(db, FEATURE, 'phương án giá combo');
  const { rows } = await db.query('select object_id from approval_queue where object_type = $1', [
    OT,
  ]);
  const seen = new Set(rows.map((r) => r.object_id as string));
  let n = 0;
  for (const r of recs) {
    const it = r.item;
    if (!it || seen.has(it.object_id)) continue;
    await directorSubmit(db, {
      block: BLOCK,
      objectType: OT,
      objectId: it.object_id,
      title: it.title,
      payload: it.payload,
      createdBy: AGENT,
      sample: r.sample,
    });
    seen.add(it.object_id);
    n++;
  }
  return n;
}
