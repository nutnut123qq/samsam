import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit } from '@samsam/core/ops/director';
import { addDays } from '@samsam/core/ops/period';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import {
  type Day,
  enqueueNew,
  fetchVersions,
  goldenPrices,
  key2,
  openV33Alerts,
  readinessMap,
  runningListings,
} from './deps.js';
import {
  AGENT,
  type Analysis,
  type Competitor,
  checkListingPrices,
  checkPromos,
  coerceDay,
  type DealerFinding,
  dealerItem,
  FEATURE_DEALER,
  FIN_BLOCK,
  FIN_OT,
  type Finding,
  financeItems,
  GOLDEN_CHANNELS,
  host,
  markDups,
  mergePlan,
  type NetRatio,
  OT_DEALER,
  type PlanRow,
  V33_DUP,
  type Watch,
} from './kd-price.js';

// Phần DB (CHỈ SELECT + đẩy hàng duyệt qua `director.submit`) của `agents/kd_price.py`. Module này
// KHÔNG có SQL ghi bảng nào khác hàng duyệt: không đổi giá/KM/listing, không ghi `dealer_price_obs`.

/** KM NỘI BỘ đã duyệt (`price_list` kind promo, approved_by có) còn hiệu lực trong cửa sổ — kiểm KỂ CẢ
 * khi không có CSV `--plan` (C08: không âm thầm bỏ kiểm khi đã có dữ liệu nội bộ). */
export async function internalPromos(db: Db, today: Day, horizonDays: number): Promise<PlanRow[]> {
  const horizon = addDays(today, horizonDays);
  const { rows } = await db.query(
    "select program_id, sku_key, channel, price_vnd::text as price, valid_from::text as vf, valid_to::text as vt, id::text as id from price_list where kind = 'promo' and approved_by is not null and valid_from <= $1 and (valid_to is null or valid_to > $2) order by id",
    [horizon, today],
  );
  return rows.map((r) => ({
    row_no: null,
    program_id: r.program_id || `PL-${r.id}`,
    channel: r.channel,
    sku_key: r.sku_key,
    kind: 'giam_gia',
    start: r.vf,
    end: r.vt ? addDays(r.vt, -1) : horizon,
    pct: null,
    price: Number(r.price),
    event: null,
    event_date: null,
    source: 'price_list',
  }));
}

export async function promotableSet(db: Db): Promise<Set<string>> {
  const { rows } = await db.query('select sku_key, channel from v_promotable');
  return new Set(rows.map((r) => key2(r.sku_key, r.channel)));
}

/** Giá đối thủ mới nhất mỗi (sku_key, kênh) — CHỈ cho báo cáo, không là input của luật nào. */
export async function competitorLatest(db: Db): Promise<Competitor[]> {
  const { rows } = await db.query(
    'select distinct on (sku_key, channel) sku_key, channel, competitor, price_vnd::text as p, promo_price_vnd::text as pp, observed_on::text as d from competitor_observations where sku_key is not null order by sku_key, channel, observed_on desc, id desc',
  );
  return rows.map((r) => [
    r.sku_key,
    r.channel,
    r.competitor,
    Number(r.p),
    r.pp === null ? null : Number(r.pp),
    r.d,
  ]);
}

/** CHỈ SELECT → {listing, promo, channels, competitor}. */
export async function analyze(
  db: Db,
  mapping: unknown,
  watch: Watch,
  netRatio: NetRatio,
  today: Day,
  planRows: PlanRow[] | null,
): Promise<Analysis> {
  const [rows, chans] = await runningListings(db, mapping);
  const prices = await goldenPrices(db, today);
  const readiness = await readinessMap(db);
  const cogs = await fetchVersions(db);
  const fl = checkListingPrices(rows, prices, cogs, netRatio, watch, today, readiness);
  const merged = mergePlan(planRows, await internalPromos(db, today, watch.lookahead_days));
  const fp = checkPromos(
    merged,
    prices,
    readiness,
    await promotableSet(db),
    cogs,
    netRatio,
    watch,
    today,
  );
  markDups(fl, await openV33Alerts(db, Object.values(V33_DUP)));
  return {
    listing: fl,
    promo: fp,
    channels: [...chans].sort(),
    // SKU nhóm CAM (rượu...) KHÔNG in sku_key — như `where`.
    competitor: (await competitorLatest(db)).map(
      ([s, ...rest]) =>
        [
          (readiness.get(key2(s as string, rest[0])) ?? 'CAM') === 'CAM' ? null : s,
          ...rest,
        ] as Competitor,
    ),
  };
}

/** Đẩy mục khối finance (`promo_loss`) chưa có (mọi status) → số mục mới. */
export async function enqueueFinance(db: Db, findings: Finding[]): Promise<number> {
  const { rows } = await db.query('select object_id from approval_queue where object_type = $1', [
    FIN_OT,
  ]);
  const seen = new Set(rows.map((r) => r.object_id as string));
  let n = 0;
  for (const it of financeItems(findings)) {
    if (seen.has(it.object_id)) continue;
    try {
      await submit(db, {
        block: FIN_BLOCK,
        objectType: it.object_type,
        objectId: it.object_id,
        title: it.title,
        payload: it.payload,
        createdBy: AGENT,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue;
      throw e;
    }
    seen.add(it.object_id);
    n++;
  }
  return n;
}

// ---------------------------------------------------- v14.4 giá đại lý (sales-06.1)

export type DealerResult = { findings: DealerFinding[]; unverifiable: number; checked: number };

/** CHỈ SELECT: quan sát không mẫu trong `lookback_days` có giá < giá sàn golden hiệu lực NGÀY quan sát
 * (kênh thuộc bảng giá golden → floor cùng kênh; kênh khác, vd cửa hàng → floor THẤP NHẤT của SKU).
 * Khóa `dp:<đại lý>:<sku>:<kênh>:<ngày>` (nhiều file cùng khóa → giá thấp nhất). Thiếu floor →
 * "không kiểm được" (đếm, không cảnh báo). */
export async function dealerFindings(
  db: Db,
  today0: Day,
  dp: { lookback_days: number },
): Promise<DealerResult> {
  const today = coerceDay(today0);
  const since = addDays(today, -dp.lookback_days);
  const obs = (
    await db.query(
      "select o.id::text as id, o.channel, o.dealer_code, o.sku_key, o.price_vnd::text as price, o.observed_on::text as day, o.source_url, m.category from dealer_price_obs o join sku_master m on m.sku_key = o.sku_key where o.source <> 'sample' and o.observed_on >= $1 and o.observed_on <= $2 order by o.observed_on, o.id",
      [since, today],
    )
  ).rows;
  if (!obs.length) return { findings: [], unverifiable: 0, checked: 0 };
  const floors = new Map<string, [string, number, Day, Day | null, boolean][]>();
  const skus = [...new Set(obs.map((o) => o.sku_key as string))].sort();
  for (const r of (
    await db.query(
      "select sku_key, channel, price_vnd::text as price, valid_from::text as vf, valid_to::text as vt, approved_by from price_list where kind = 'floor' and program_id is null and sku_key = any($1::text[]) order by valid_from, id",
      [skus],
    )
  ).rows) {
    const cur = floors.get(r.sku_key) ?? [];
    cur.push([r.channel, Number(r.price), r.vf, r.vt, r.approved_by !== null]);
    floors.set(r.sku_key, cur);
  }
  const best = new Map<string, DealerFinding>();
  let unver = 0;
  for (const o of obs) {
    const day = o.day as Day;
    const price = Number(o.price);
    const live = (floors.get(o.sku_key) ?? [])
      .filter(([, , vf, vt]) => vf <= day && (vt === null || vt > day))
      .map(([c, pr, , , ok]) => [c, pr, ok] as [string, number, boolean]);
    const same = GOLDEN_CHANNELS.includes(o.channel);
    const cand = same ? live.filter((x) => x[0] === o.channel) : live;
    if (!cand.length) {
      unver++;
      continue;
    }
    // Python `min(cand, key=giá)`: phần tử nhỏ nhất ĐẦU TIÊN (theo valid_from, id).
    const fl = cand.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (price >= fl[1]) continue;
    const k = `dp:${o.dealer_code}:${o.sku_key}:${o.channel}:${day}`;
    const cur = best.get(k);
    if (cur === undefined || price < cur.price) {
      best.set(k, {
        object_id: k,
        obs_id: Number(o.id),
        channel: o.channel,
        dealer: o.dealer_code,
        sku: o.sku_key,
        cam: o.category === 'alcohol',
        price,
        day,
        floor: fl[1],
        floor_channel: fl[0],
        floor_approved: fl[2],
        ref: same ? 'cùng kênh' : 'thấp nhất các kênh',
        host: host(o.source_url),
      });
    }
  }
  const fs = [...best.values()].sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? -1
        : 1
      : a.object_id < b.object_id
        ? -1
        : a.object_id > b.object_id
          ? 1
          : 0,
  );
  return { findings: fs, unverifiable: unver, checked: obs.length };
}

/** Cổng SINH sales-06.1 TRƯỚC mọi đọc; dry-run → không ghi. */
export async function dealerWatch(
  db: Db,
  today: Day,
  cfg: DirectorConfig,
  dp: { lookback_days: number },
  dryRun = false,
): Promise<DealerResult & { new: number; enqueued: number }> {
  await checkGenerate(db, FEATURE_DEALER, 'cảnh báo giá đại lý');
  const res = await dealerFindings(db, today, dp);
  const items = res.findings.map((f) => dealerItem(f, cfg));
  const { rows } = await db.query(
    'select object_type, object_id from approval_queue where object_type = $1',
    [OT_DEALER],
  );
  const seen = new Set(rows.map((r) => `${r.object_type}\0${r.object_id}`));
  const fresh = items.filter((it) => !seen.has(`${it.object_type}\0${it.object_id}`));
  const n = dryRun ? 0 : await enqueueNew(db, fresh, cfg, seen, AGENT);
  return { ...res, new: fresh.length, enqueued: n };
}
