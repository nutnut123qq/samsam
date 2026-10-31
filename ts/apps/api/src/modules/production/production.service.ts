import type { Db } from '@samsam/core/ops/deps';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { clean } from '../market/table.js';
import { currentStock, type GoldenMap, type Stock } from './inventory-csv.js';
import { latest } from './lot-certs.js';
import {
  ALLOC_TABLES,
  type BomItem,
  type BulletinData,
  type Cutoff,
  checkBom,
  cmpCp,
  FEATURE_ALLOC,
  type PlanProgress,
  type PlanRow,
  shortage,
} from './production.js';

// Phần DB của `pipelines/production.py`: ghi NHÁP phân bổ (cổng SINH production-01), quyết định của
// NGƯỜI qua function DB SECURITY DEFINER `decide_allocation_run` / `record_lot_intake` (ghi
// `approvals` + `agent_action_log` hash chain — module KHÔNG insert thẳng `approvals`), nạp BOM/lô,
// `collect` chỉ SQL (0 LLM, không ghi gì) cho bản tin. Hàm nhận `db` (Pool/client) — caller lo giao
// dịch (Python: không commit trong hàm, caller commit).

/** Ghi NHÁP pending. production-01 TẮT → RolloutBlocked (HĐ 6.7), không ghi; dòng dựng trên tồn kho
 * MẪU → cờ provenance `is_sample` (bộ đếm đầu ra loại). */
export async function saveProposals(
  db: Db,
  runId: string,
  cutoff: Pick<Cutoff, 'id' | 'date'>,
  startWeek: string,
  rows: Pick<
    PlanRow,
    | 'sku_key'
    | 'channel'
    | 'stock_total'
    | 'demand_low'
    | 'demand_base'
    | 'demand_high'
    | 'proposed_qty'
    | 'note'
    | 'sample'
  >[],
): Promise<number> {
  await checkGenerate(db, FEATURE_ALLOC, 'đề xuất phân bổ tồn');
  let n = 0;
  for (const r of rows) {
    const res = await db.query(
      'insert into allocation_proposals (run_id, cutoff_id, cutoff_date, start_week, sku_key,' +
        ' channel, stock_total, demand_low, demand_base, demand_high, proposed_qty, note,' +
        ' is_sample) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)' +
        ' on conflict (run_id, sku_key, channel) do nothing',
      [
        runId,
        cutoff.id,
        cutoff.date,
        startWeek,
        r.sku_key,
        r.channel,
        r.stock_total,
        r.demand_low,
        r.demand_base,
        r.demand_high,
        r.proposed_qty,
        r.note,
        Boolean(r.sample),
      ],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/** Gọi function DB SECURITY DEFINER — lỗi nghiệp vụ (RAISE, P0001) → [null, lý do]; lỗi khác nổi lên.
 * Gọi trên client trong giao dịch: P0001 làm hỏng giao dịch → caller rollback (Python: savepoint rồi
 * caller cũng rollback — cùng kết quả: không ghi gì). */
async function decideCall<R extends Record<string, unknown>>(
  db: Db,
  sql: string,
  args: unknown[],
): Promise<[R | null, string | null]> {
  try {
    const { rows } = await db.query<R>(sql, args);
    return [rows[0] ?? null, null];
  } catch (e) {
    if ((e as { code?: string }).code !== 'P0001') throw e;
    return [null, clean((e as Error).message || 'bị từ chối', 200)];
  }
}

/** NGƯỜI duyệt/từ chối cả 1 run phân bổ qua `decide_allocation_run`. Không đụng
 * `inventory_snapshots` (duyệt ≠ chuyển kho). */
export async function decideRun(
  db: Db,
  runId: string,
  decision: 'approved' | 'rejected',
  by: string,
  note: string | null = null,
): Promise<[boolean, string]> {
  const [row, why] = await decideCall<{ out_approval_id: string; out_rows: number }>(
    db,
    'select out_approval_id, out_rows from decide_allocation_run($1, $2, $3, $4)',
    [runId, decision, by, note],
  );
  if (row === null) return [false, why ?? 'bị từ chối'];
  return [
    true,
    `run ${runId}: ${row.out_rows} dòng → ${decision} (approvals #${row.out_approval_id})`,
  ];
}

export type Combo = {
  combo_key: string;
  name: string;
  channels: string[];
  items: BomItem[];
  note?: string | null;
  _source?: string;
};

/** Upsert combo + thay toàn bộ items của combo trong file. Bản `manual` không bị nạp `sample` đè.
 * → [combo ghi, combo bỏ qua]. */
export async function loadBom(db: Db, combos: Combo[], source: string): Promise<[number, number]> {
  let done = 0;
  let skipped = 0;
  for (const c of combos) {
    const got = await db.query(
      'insert into bom_combos (combo_key, name, channels, source, note) values ($1, $2, $3, $4, $5)' +
        ' on conflict (combo_key) do update set name = excluded.name, channels = excluded.channels,' +
        ' source = excluded.source, note = excluded.note, updated_at = now()' +
        " where not (bom_combos.source = 'manual' and excluded.source = 'sample') returning combo_key",
      [c.combo_key, c.name, [...c.channels], source, c.note ?? null],
    );
    if (!got.rows.length) {
      skipped++;
      continue;
    }
    await db.query('delete from bom_items where combo_key = $1', [c.combo_key]);
    for (const it of c.items) {
      await db.query('insert into bom_items (combo_key, sku_key, qty) values ($1, $2, $3)', [
        c.combo_key,
        it.sku_key,
        it.qty,
      ]);
    }
    done++;
  }
  return [done, skipped];
}

export async function dbCombos(db: Db): Promise<Combo[]> {
  const combos = new Map<string, Combo>();
  const a = await db.query<{
    combo_key: string;
    name: string;
    channels: string[];
    source: string;
    note: string | null;
  }>('select combo_key, name, channels, source, note from bom_combos order by combo_key');
  for (const r of a.rows) {
    const c: Combo = {
      combo_key: r.combo_key,
      name: r.name,
      channels: r.channels,
      items: [],
      _source: r.source,
    };
    if (r.note !== null) c.note = r.note;
    combos.set(r.combo_key, c);
  }
  const b = await db.query<{ combo_key: string; sku_key: string; qty: number }>(
    'select combo_key, sku_key, qty from bom_items order by combo_key, sku_key',
  );
  for (const r of b.rows) combos.get(r.combo_key)?.items.push({ sku_key: r.sku_key, qty: r.qty });
  return [...combos.values()];
}

export const stripMeta = (combos: Combo[]): Record<string, unknown>[] =>
  combos.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))));

export type LotIn = {
  lot_code: string;
  sku_key: string;
  mfg_date: string;
  exp_date: string;
  qty: number;
  note?: string | null;
};

/** Insert lô mới; lô đã có KHÔNG bị ghi đè. → [mới, đã có]. */
export async function loadLots(db: Db, lots: LotIn[], source: string): Promise<[number, number]> {
  let created = 0;
  for (const lot of lots) {
    const r = await db.query(
      'insert into production_lots (lot_code, sku_key, mfg_date, exp_date, qty, source, note)' +
        ' values ($1, $2, $3, $4, $5, $6, $7) on conflict (lot_code) do nothing',
      [lot.lot_code, lot.sku_key, lot.mfg_date, lot.exp_date, lot.qty, source, lot.note ?? null],
    );
    created += r.rowCount ?? 0;
  }
  return [created, lots.length - created];
}

/** NGƯỜI kiểm nhập 1 lô qua `record_lot_intake`: chỉ từ pending. */
export async function intake(
  db: Db,
  lotCode: string,
  result: 'passed' | 'failed',
  by: string,
  note: string | null = null,
): Promise<[boolean, string]> {
  const [row, why] = await decideCall<{ id: string }>(
    db,
    'select record_lot_intake($1, $2, $3, $4) as id',
    [lotCode, result, by, note],
  );
  if (row === null) return [false, why ?? 'bị từ chối'];
  return [true, `lô ${lotCode} → ${result} (approvals #${row.id})`];
}

export type Collected = Required<
  Pick<
    BulletinData,
    | 'missing_tables'
    | 'shortages'
    | 'no_stock'
    | 'stale_stock'
    | 'lots_pending'
    | 'bom_errors'
    | 'pending'
    | 'sample'
    | 'near_expiry'
  >
> & {
  plans: PlanProgress[] | null;
  certs: BulletinData['certs'];
  date?: string;
  period?: string;
};

async function one<T>(db: Db, sql: string, args: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, args);
  return Object.values(rows[0] ?? {})[0] as T;
}

/**
 * Chỉ SQL (0 LLM) → data cho `renderBulletin`. Không ghi gì. `nearUntil` (v12.3): lô passed có HSD ≤
 * ngày này (null → bỏ qua); `nearFrom`: HSD ≥ ngày này — lô hết hạn đã lâu không nằm mãi trong bản
 * tin (null → không chặn dưới).
 */
export async function collect(
  db: Db,
  golden: GoldenMap | null,
  goldenWhy: string | null = null,
  nearUntil: string | null = null,
  nearFrom: string | null = null,
): Promise<Collected> {
  const missing: string[] = [];
  for (const t of ALLOC_TABLES) {
    if (await one<boolean>(db, 'select to_regclass($1) is null', [t])) missing.push(t);
  }
  const data: Collected = {
    missing_tables: missing,
    shortages: [],
    no_stock: [],
    stale_stock: [],
    lots_pending: [],
    bom_errors: [],
    pending: [],
    sample: false,
    near_expiry: [],
    certs: null,
    plans: null,
  };
  for (const t of ['inventory_snapshots', 'bom_combos', 'production_lots'] as const) {
    // tên bảng là hằng trong mã (không từ input)
    if (
      !missing.includes(t) &&
      (await one<boolean>(db, `select exists (select 1 from ${t} where source = 'sample')`))
    ) {
      data.sample = true;
    }
  }
  const stock: Stock = missing.includes('inventory_snapshots') ? new Map() : await currentStock(db);
  for (const [sku, s] of stock) for (const kho of s.stale) data.stale_stock.push([sku, kho]);
  data.stale_stock.sort((a, b) => cmpCp(a[0], b[0]) || cmpCp(a[1], b[1]));
  if (!missing.includes('allocation_proposals')) {
    const { rows } = await db.query<{
      cutoff_id: string;
      cutoff_date: string;
      run_id: string;
      status: string;
      sku_key: string;
      run_stock: number | null;
      lo: string;
      ba: string;
      hi: string;
    }>(
      'with latest as (select distinct on (cutoff_id) cutoff_id, run_id from allocation_proposals' +
        ' order by cutoff_id, created_at desc, id desc)' +
        ' select p.cutoff_id, min(p.cutoff_date)::text as cutoff_date, p.run_id,' +
        ' min(p.status) as status, p.sku_key, min(p.stock_total) as run_stock,' +
        ' sum(p.demand_low) as lo, sum(p.demand_base) as ba, sum(p.demand_high) as hi' +
        ' from allocation_proposals p join latest l on l.run_id = p.run_id' +
        ' and l.cutoff_id = p.cutoff_id group by p.cutoff_id, p.run_id, p.sku_key',
    );
    for (const r of rows) {
      const sums = { low: Number(r.lo), base: Number(r.ba), high: Number(r.hi) };
      const [level, text] = shortage(r.run_stock, sums);
      if (r.run_stock === null) {
        if (!data.no_stock.includes(r.sku_key)) data.no_stock.push(r.sku_key);
      } else if (level) {
        data.shortages.push({
          cutoff_id: r.cutoff_id,
          cutoff_date: r.cutoff_date,
          run_id: r.run_id,
          status: r.status,
          sku_key: r.sku_key,
          stock_total: r.run_stock,
          ...sums,
          flag: text,
        });
      }
    }
    const pend = await db.query<{ run_id: string; created: Date }>(
      "select run_id, min(created_at) as created from allocation_proposals where status = 'pending'" +
        ' group by run_id',
    );
    for (const r of pend.rows) {
      data.pending.push({ kind: 'phân bổ', id: r.run_id, created_at: r.created });
    }
  }
  if (!missing.includes('production_lots')) {
    const lots = await db.query<{
      lot_code: string;
      sku_key: string;
      mfg_date: string;
      exp_date: string;
      qty: number;
      created_at: Date;
    }>(
      'select lot_code, sku_key, mfg_date::text as mfg_date, exp_date::text as exp_date, qty,' +
        " created_at from production_lots where intake_status = 'pending'",
    );
    for (const r of lots.rows) {
      data.lots_pending.push({ ...r });
      data.pending.push({ kind: 'lô', id: r.lot_code, created_at: r.created_at });
    }
    if (nearUntil !== null) {
      const near = await db.query<{
        lot_code: string;
        sku_key: string;
        exp_date: string;
        qty: number;
      }>(
        'select lot_code, sku_key, exp_date::text as exp_date, qty from production_lots' +
          " where intake_status = 'passed' and exp_date <= $1 and ($2::date is null" +
          ' or exp_date >= $2) order by exp_date, lot_code',
        [nearUntil, nearFrom],
      );
      for (const r of near.rows) {
        const total = stock.get(r.sku_key)?.qty ?? null;
        if (total === 0) continue; // SKU hết tồn — không còn hàng cận hạn
        data.near_expiry.push({ ...r, stock: total });
      }
    }
  }
  if (
    !missing.includes('production_lots') &&
    (await one<boolean>(db, "select to_regclass('production_plans') is not null"))
  ) {
    const { rows } = await db.query<{
      plan_code: string;
      sku_key: string;
      qty_plan: number;
      start_date: string;
      due_date: string;
      is_sample: boolean;
      ok: string;
      wait: string;
      bad: string;
      lot_smp: boolean;
    }>(
      'select p.plan_code, p.sku_key, p.qty_plan, p.start_date::text as start_date,' +
        ' p.due_date::text as due_date, p.is_sample,' +
        " coalesce(sum(l.qty) filter (where l.intake_status = 'passed'), 0) as ok," +
        " coalesce(sum(l.qty) filter (where l.intake_status = 'pending'), 0) as wait," +
        " coalesce(sum(l.qty) filter (where l.intake_status = 'failed'), 0) as bad," +
        " coalesce(bool_or(l.source = 'sample'), false) as lot_smp" +
        ' from production_plans p left join production_plan_lots pl' +
        ' on pl.plan_code = p.plan_code left join production_lots l' +
        ' on l.lot_code = pl.lot_code group by p.plan_code order by p.due_date, p.plan_code',
    );
    data.plans = rows.map((r) => [
      r.plan_code,
      r.sku_key,
      r.qty_plan,
      r.start_date,
      r.due_date,
      r.is_sample,
      Number(r.ok),
      Number(r.wait),
      Number(r.bad),
      r.lot_smp,
    ]);
    if (data.plans.some((r) => r[5] || r[9])) data.sample = true;
  }
  // Đợt hợp đồng C03: phiếu kiểm nghiệm mới nhất mỗi lô chờ/đạt (chỉ DB — bản tin không đọc kho
  // tệp; kiểm tệp/hash = `cert-verify`).
  if (
    !missing.includes('production_lots') &&
    (await one<boolean>(db, "select to_regclass('lot_test_certificates') is not null"))
  ) {
    data.certs = await latest(db);
  }
  if (!missing.includes('bom_combos') && !missing.includes('bom_items')) {
    const combos = await dbCombos(db);
    if (combos.length && golden === null) {
      data.bom_errors.push(`golden không đọc được: ${goldenWhy}`);
    } else if (combos.length) {
      data.bom_errors = checkBom(stripMeta(combos), golden as GoldenMap);
    }
  }
  return data;
}
