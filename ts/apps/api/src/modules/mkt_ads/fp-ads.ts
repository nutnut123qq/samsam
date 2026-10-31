import { createHash } from 'node:crypto';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { cpCmp } from '@samsam/core/ops/py-json';
import { readinessKey } from '@samsam/core/security/guardrail';
import { pyRepr } from '@samsam/core/security/py';
import { FPA_CONFIG, readConfig } from '../kd_price/deps.js';
import { CHANNELS } from '../sales_director/kd-forecast.deps.js';
import { cmpRat, type Dec, decRat, decStr, mulRat, rat, roundRat } from './dec.js';
import { type Cell, compute, frac, UNKNOWN_SKU, vnd } from './fp-pnl.js';

// Port `agents/fp_ads.py` (v9.1 FP-AdsBudget, WP12) — chấm biên gộp → ĐỀ XUẤT ngân sách quảng cáo
// theo SKU × kênh. Tất định, KHÔNG LLM/mạng. Output DUY NHẤT: 1 mục ĐỀ XUẤT `finance/budget_change`
// (risk high → auto_policy không bao giờ áp). Agent KHÔNG chi tiền, KHÔNG bật voucher, KHÔNG đổi giá,
// KHÔNG cài ngân sách trên nền tảng quảng cáo — Quản lý MXH cài tay sau khi người duyệt.

export const CODES = [
  'CHAN_CAM',
  'CHAN_XNQC',
  'CHO_DU_LIEU',
  'DUOI_NGUONG',
  'AM_BIEN',
  'DE_XUAT',
] as const;
export const CREATED_BY = 'agent:fp_ads';
export const NOTE =
  'ĐỀ XUẤT — agent không chi tiền, không bật voucher, không đổi giá, không cài ngân sách trên nền tảng; quản lý MXH cài tay sau khi duyệt.';

export type AdsCfg = { min_gross_margin_pct: Dec; budget_share_of_margin: Dec; channels: string[] };
/** readinessKey(sku, kênh) → mức view `sku_readiness`. */
export type Readiness = Map<string, string>;
export type Prop = {
  sku_key: string;
  channel: string;
  code: (typeof CODES)[number];
  budget_vnd: number;
  bien_gop_pct: Dec | null;
  lai_gop: number | null;
};

export const pyTuple = (xs: readonly string[]): string =>
  `(${xs.map(pyRepr).join(', ')}${xs.length === 1 ? ',' : ''})`;
export const ym = (m: string): string => m.slice(0, 7);
export const mY = (m: string): string => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

/** Mục `ads` của `data/fpa_config.json` (GIẢ ĐỊNH — chờ GĐ tài chính chốt) → [cfg, null] | [null, lý do]. */
export function loadCfg(path: string = FPA_CONFIG): [AdsCfg, null] | [null, string] {
  const [sec, why] = readConfig('ads', path);
  if (sec === null) return [null, why];
  const [mn, w1] = frac(sec.min_gross_margin_pct, 'ads.min_gross_margin_pct');
  if (mn === null) return [null, w1];
  const [share, w2] = frac(sec.budget_share_of_margin, 'ads.budget_share_of_margin');
  if (share === null) return [null, w2];
  const ch = sec.channels;
  if (
    !Array.isArray(ch) ||
    !ch.length ||
    new Set(ch.map((c) => JSON.stringify(c))).size !== ch.length ||
    !ch.every((c) => typeof c === 'string' && CHANNELS.includes(c))
  ) {
    return [null, `ads.channels: list kênh ⊂ ${pyTuple(CHANNELS)}, không trùng`];
  }
  return [{ min_gross_margin_pct: mn, budget_share_of_margin: share, channels: [...ch] }, null];
}

/** THUẦN: mỗi SKU × kênh cấu hình đúng 1 mã theo ưu tiên CHAN_CAM > CHAN_XNQC > CHO_DU_LIEU >
 * DUOI_NGUONG > AM_BIEN > DE_XUAT; SKU không có trong view = CAM (fail-closed). Sắp theo sku_key rồi
 * thứ tự kênh cấu hình. */
export function propose(
  cells: Pick<Cell, 'sku_key' | 'channel' | 'lai_gop' | 'bien_gop_pct'>[],
  readiness: Readiness,
  cfg: AdsCfg,
): Prop[] {
  const by = new Map<string, (typeof cells)[number]>();
  for (const c of cells)
    if (c.sku_key !== UNKNOWN_SKU) by.set(readinessKey(c.sku_key, c.channel), c);
  const floor = decRat({ ...cfg.min_gross_margin_pct, c: cfg.min_gross_margin_pct.c * 100n });
  const share = decRat(cfg.budget_share_of_margin);
  const skuOf = (k: string) => k.split('\u0000')[0] as string;
  const skus = [
    ...new Set([...[...readiness.keys()].map(skuOf), ...[...by.keys()].map(skuOf)]),
  ].sort(cpCmp);
  const out: Prop[] = [];
  for (const sku of skus) {
    for (const ch of cfg.channels) {
      const c = by.get(readinessKey(sku, ch));
      const lvl = readiness.get(readinessKey(sku, ch));
      const b = c ? c.bien_gop_pct : null;
      const lai = c ? c.lai_gop : null;
      let budget = 0;
      let code: Prop['code'];
      if (lvl === undefined || lvl === 'CAM') code = 'CHAN_CAM';
      else if (lvl === 'MO_TA') code = 'CHAN_XNQC';
      else if (b === null || lai === null) code = 'CHO_DU_LIEU';
      else if (cmpRat(decRat(b), floor) < 0) code = 'DUOI_NGUONG';
      else if (lai <= 0) code = 'AM_BIEN';
      else {
        code = 'DE_XUAT';
        budget = Number(roundRat(mulRat(rat(lai), share), 'half_up'));
      }
      out.push({
        sku_key: sku,
        channel: ch,
        code,
        budget_vnd: budget,
        bien_gop_pct: b,
        lai_gop: lai,
      });
    }
  }
  return out;
}

/** Payload markdown mục `budget_change` — SKU CHAN_CAM chỉ đếm (guardrail chặn mọi nhắc tới đồ uống có cồn). */
export function renderPayload(month: string, props: Prop[], cfg: AdsCfg): string {
  const cam = props.filter((p) => p.code === 'CHAN_CAM');
  const shown = props.filter((p) => p.code !== 'CHAN_CAM');
  const total = props.reduce((a, p) => a + p.budget_vnd, 0);
  const mn = { ...cfg.min_gross_margin_pct, c: cfg.min_gross_margin_pct.c * 100n };
  const L = [
    `# Đề xuất ngân sách quảng cáo theo biên gộp — P&L tháng ${mY(month)}`,
    '',
    `**${NOTE}**`,
    '',
    `Ngưỡng biên gộp tối thiểu ${decStr(mn)}%; ngân sách = lãi gộp tháng tham chiếu × ${decStr(cfg.budget_share_of_margin)} (GIẢ ĐỊNH \`data/fpa_config.json\` — chờ GĐ tài chính chốt).`,
    '',
    '| SKU | Kênh | Biên gộp | Lãi gộp | Ngân sách đề xuất | Mã |',
    '|---|---|---|---|---|---|',
  ];
  for (const p of shown) {
    const b = p.bien_gop_pct === null ? '—' : `${decStr(p.bien_gop_pct)}%`;
    const lai = p.lai_gop === null ? '—' : vnd(p.lai_gop);
    L.push(
      `| \`${p.sku_key}\` | ${p.channel} | ${b} | ${lai} | ${vnd(p.budget_vnd)} | ${p.code} |`,
    );
  }
  if (!shown.length) L.push('| (không có) | | | | | |');
  const nCamSku = new Set(cam.map((p) => p.sku_key)).size;
  L.push(
    '',
    `- ${cam.length} cặp SKU × kênh (${nCamSku} SKU) readiness CAM — ngân sách 0 (không liệt kê tên).`,
    '- CHAN_XNQC: TPBVSK chưa có xác nhận nội dung quảng cáo — 0.',
    '- CHO_DU_LIEU: thiếu giá vốn duyệt hoặc chưa có doanh thu tháng tham chiếu — không tính.',
    `- Tổng ngân sách đề xuất: ${vnd(total)}.`,
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------- DB

export async function fetchReadiness(db: Db, channels: readonly string[]): Promise<Readiness> {
  const { rows } = await db.query<{ sku_key: string; channel: string; readiness: string }>(
    'select sku_key, channel, readiness from sku_readiness where channel = any($1)',
    [[...channels]],
  );
  return new Map(rows.map((r) => [readinessKey(r.sku_key, r.channel), r.readiness]));
}

export async function pendingForMonth(db: Db, month: string): Promise<bigint | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from approval_queue where block = 'finance' and object_type = 'budget_change' and status = 'pending' and object_id like $1 order by id limit 1",
    [`ads-${ym(month)}-%`],
  );
  return rows[0] ? BigInt(rows[0].id) : null;
}

export type FpAdsDeps = { pendingForMonth?: typeof pendingForMonth };

/** → [id hàng duyệt | null nếu đã có mục chờ duyệt cùng tháng, props, payload]. */
export async function submitProposal(
  db: Db,
  month: string,
  cfg: AdsCfg,
  dcfg?: DirectorConfig,
  d: FpAdsDeps = {},
): Promise<[bigint | null, Prop[], string]> {
  if ((await (d.pendingForMonth ?? pendingForMonth)(db, month)) !== null) return [null, [], ''];
  const res = await compute(db, month);
  const props = propose(res.cells, await fetchReadiness(db, cfg.channels), cfg);
  const payload = renderPayload(month, props, cfg);
  const sha = createHash('sha256').update(payload, 'utf8').digest('hex');
  const qid = await submit(db, {
    block: 'finance',
    objectType: 'budget_change',
    objectId: `ads-${ym(month)}-${sha.slice(0, 12)}`,
    title: `Đề xuất ngân sách ads tháng ${mY(month)} — tổng ${vnd(props.reduce((a, p) => a + p.budget_vnd, 0))}`,
    payload,
    createdBy: CREATED_BY,
    ...(dcfg ? { cfg: dcfg } : {}),
  });
  return [qid, props, payload];
}
