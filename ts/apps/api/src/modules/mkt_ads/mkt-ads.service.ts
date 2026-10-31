import type { Db } from '@samsam/core/ops/deps';
import {
  DIRECTORS_DIR,
  type DirectorConfig,
  DirectorConfigError,
  loadConfig,
  submit,
} from '@samsam/core/ops/director';
import { squash } from '@samsam/core/ops/py';
import { verifyPublish } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { checkGenerate } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck, readinessKey } from '@samsam/core/security/guardrail';
import { casefold, pyStr } from '@samsam/core/security/py';
import { FPA_CONFIG } from '../kd_price/deps.js';
import { CHANNELS } from '../sales_director/kd-forecast.deps.js';
import { type AdsCfg, fetchReadiness, propose as fpPropose, loadCfg } from './fp-ads.js';
import { compute, vnd } from './fp-pnl.js';
import {
  BUDGET_AGENT,
  buildProposal,
  type Cap,
  CREATIVE_TYPES,
  type Creative,
  type Ctx,
  type Day,
  type Eval,
  evaluate,
  FEATURE,
  ITEMS,
  MAX_CREATIVES,
  NOT_APPROVED,
  type Norm,
  normalizePlan,
  type PlanRow,
  PROPOSE_AGENT,
  type ProposalCfg,
  planSha,
  RESULT_OT,
  readResults,
  renderPlan,
  renderResult,
  validatePlan,
  codes as violationCodes,
} from './mkt-ads.js';

// Phần DB của `agents/mkt_ads.py`: trần FP&A, ngữ cảnh luật chặn, ghi `ad_test_plans` (insert-only) +
// 2 mục NHÁP hàng duyệt cùng `adtest-<id>` (marketing/ad_campaign + finance/budget_change), trạng
// thái phiếu (kiểm soát kép + khớp bản duyệt), nạp kết quả → mục `marketing/ad_result`. Bị từ chối
// → KHÔNG ghi gì. Agent KHÔNG chi tiền, KHÔNG gọi API quảng cáo.

export type Dcfg = Record<string, DirectorConfig>;
const N = (v: unknown): number => Number(v);

/** → [fp_ads cfg, {khối: cấu hình GĐ}, null] | [null, null, lỗi] — gọi TRƯỚC connect. */
export function loadCfgs(
  fpa: string = FPA_CONFIG,
  directorsDir: string = DIRECTORS_DIR,
): [AdsCfg, Dcfg, null] | [null, null, string] {
  const [cfg, why] = loadCfg(fpa);
  if (cfg === null) return [null, null, why];
  try {
    return [cfg, Object.fromEntries(ITEMS.map(([b]) => [b, loadConfig(b, directorsDir)])), null];
  } catch (e) {
    if (e instanceof DirectorConfigError) return [null, null, `cấu hình khối: ${e.message}`];
    throw e;
  }
}

/** Trần = `fp_ads.propose` trên P&L tháng tham chiếu (không chép công thức). Kênh ngoài cấu hình
 * ads → NGOAI_KENH_ADS; SKU × kênh không có ô → CHAN_CAM. */
export async function capFor(
  db: Db,
  sku: string,
  channel: string,
  month: Day,
  cfg: AdsCfg,
): Promise<Cap> {
  if (!cfg.channels.includes(channel)) return { code: 'NGOAI_KENH_ADS', budget_vnd: 0 };
  const props = fpPropose(
    (await compute(db, month)).cells,
    await fetchReadiness(db, cfg.channels),
    cfg,
  );
  const p = props.find((x) => x.sku_key === sku && x.channel === channel);
  return p ? { code: p.code, budget_vnd: p.budget_vnd } : { code: 'CHAN_CAM', budget_vnd: 0 };
}

export type Deps = {
  capFor?: typeof capFor;
  loadContext?: typeof loadContext;
};

/** Tổng `budget_vnd` các phiếu KHÁC (sha khác) cùng SKU × kênh đang giữ trần tháng: cùng
 * `cap_ref_month` HOẶC khung chạy chạm cùng tháng lịch (chặn đổi --month để lách). Phiếu `tu_choi`/
 * `het_han` trả trần lại; trạng thái khác vẫn tính — fail-closed. */
export async function allocatedVnd(db: Db, norm: Norm, month: Day): Promise<number> {
  const m0 = `${norm.start_date.slice(0, 8)}01`;
  const m1 = `${norm.end_date.slice(0, 8)}01`;
  const { rows } = await db.query(
    "select id, budget_vnd from ad_test_plans where sku_key = $1 and channel = $2 and plan_sha256 <> $3 and (cap_ref_month = $4 or (end_date >= $5 and start_date < $6::date + interval '1 month'))",
    [norm.sku_key, norm.channel, planSha(norm), month, m0, m1],
  );
  let sum = 0;
  for (const r of rows) {
    if (!['tu_choi', 'het_han'].includes(await planStatus(db, r.id))) sum += N(r.budget_vnd);
  }
  return sum;
}

export async function loadContext(
  db: Db,
  norm: Norm,
  month: Day,
  cfg: AdsCfg,
  today: Day,
  d: Deps = {},
): Promise<Omit<Ctx, 'today'>> {
  const g = await db.query<{ sku_key: string; category: string }>(
    'select sku_key, category from sku_master',
  );
  const golden = new Map(g.rows.map((r) => [r.sku_key, { category: r.category }]));
  const readiness = await fetchReadiness(db, CHANNELS);
  const creatives = new Map<number, Creative>();
  const c = await db.query(
    'select id, status, sku, content_type, text, is_ai from content_drafts where id = any($1)',
    [norm.creative_draft_ids],
  );
  for (const r of c.rows) {
    creatives.set(N(r.id), {
      status: r.status,
      sku: r.sku,
      content_type: r.content_type,
      text: r.text,
      is_ai: r.is_ai,
      verified: await verifyPublish(db, r.id, r.text),
    });
  }
  const dz = await db.query(
    "select exists(select 1 from xnqc_dossiers where sku_key = $1 and status = 'da_cap' and (ngay_het_han is null or ngay_het_han >= $2)) as ok",
    [norm.sku_key, today],
  );
  const cap = await (d.capFor ?? capFor)(db, norm.sku_key, norm.channel, month, cfg);
  return {
    golden,
    readiness,
    creatives,
    cap,
    dossier_ok: dz.rows[0]?.ok === true,
    allocated: await allocatedVnd(db, norm, month),
  };
}

const ROW_COLS =
  'id, plan_sha256, sku_key, channel, hypothesis, creative_draft_ids, budget_vnd, cap_vnd, allocated_vnd, cap_ref_month::text as cap_ref_month, start_date::text as start_date, end_date::text as end_date, success_metric, stop_rules, readiness, created_by';

export async function getPlan(db: Db, pid: number | bigint): Promise<PlanRow | null> {
  const { rows } = await db.query(`select ${ROW_COLS} from ad_test_plans where id = $1`, [
    String(pid),
  ]);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    id: N(r.id),
    creative_draft_ids: (r.creative_draft_ids as unknown[]).map(N),
    budget_vnd: N(r.budget_vnd),
    cap_vnd: N(r.cap_vnd),
    allocated_vnd: N(r.allocated_vnd),
  } as PlanRow;
}

async function itemExists(db: Db, objectType: string, objectId: string): Promise<boolean> {
  const { rows } = await db.query(
    'select exists(select 1 from approval_queue where object_type = $1 and object_id = $2) as ok',
    [objectType, objectId],
  );
  return rows[0]?.ok === true;
}

const isUnique = (e: unknown) => (e as { code?: unknown })?.code === '23505';

/** cho_duyet | da_duyet (CẢ 2 mục approved) | tu_choi | het_han | thieu_muc | lech_ban_duyet |
 * cung_nguoi_duyet — theo mục mới nhất mỗi loại. 2 mục approved bởi CÙNG 1 người (hoặc người lập)
 * → `cung_nguoi_duyet` (kiểm soát kép GĐ MKT + GĐ tài chính, fail-closed). `da_duyet` còn đòi bản
 * duyệt của CẢ 2 mục khớp sha256 phiếu dựng lại từ dòng `ad_test_plans` (verify_publish). */
export async function planStatus(db: Db, pid: number | bigint | string): Promise<string> {
  const oid = `adtest-${pid}`;
  const { rows } = await db.query<{ object_type: string; status: string; by: string }>(
    "select object_type, status, lower(btrim(coalesce(decided_by, ''))) as by from approval_queue where object_id = $1 and (block, object_type) in (('marketing', 'ad_campaign'), ('finance', 'budget_change')) order by id",
    [oid],
  );
  const st = new Map<string, string>();
  const who = new Map<string, string>();
  for (const r of rows) {
    st.set(r.object_type, r.status);
    who.set(r.object_type, r.by);
  }
  if (st.size < ITEMS.length) return 'thieu_muc';
  const vals = new Set(st.values());
  if (vals.has('rejected')) return 'tu_choi';
  if (vals.has('expired')) return 'het_han';
  if (vals.size !== 1 || !vals.has('approved')) return 'cho_duyet';
  const prow = await getPlan(db, pid as number);
  const author = casefold(squash(pyStr(prow?.created_by || '')));
  const ws = [...who.values()];
  if (
    new Set(ws).size < ITEMS.length ||
    ws.includes('') ||
    ws.some((w) => casefold(squash(w)) === author)
  ) {
    return 'cung_nguoi_duyet'; // P8.2: người lập không tự duyệt
  }
  let payload: string | null = null;
  try {
    payload = prow ? renderPlan(prow) : null;
  } catch {
    payload = null; // dòng jsonb sai khuôn (ghi tay) → fail-closed
  }
  for (const [, otype] of ITEMS) {
    if (payload === null) return 'lech_ban_duyet';
    const v = await db.query('select verify_publish($1, $2, $3) as ok', [otype, oid, payload]);
    if (v.rows[0]?.ok !== true) return 'lech_ban_duyet';
  }
  return 'da_duyet';
}

/** Đếm lại sau khóa vượt trần — thoát tx, không ghi. */
class OverCap extends Error {
  constructor(readonly alloc: number) {
    super('OverCap');
  }
}

export type SubmitRes = {
  code: string | null;
  reason: string;
  plan_id?: number | null;
  new_items?: bigint[];
  created?: boolean;
  cap?: number;
};

/** Bị từ chối → 0 ghi. Chạy lại cùng phiếu (cùng sha) → không tạo phiếu thứ 2, chỉ bổ sung mục thiếu. */
export async function submitPlan(
  db: Db,
  plan: unknown,
  o: { by: string; month: Day; cfg: AdsCfg; dcfg: Dcfg; today: Day; dryRun?: boolean },
  d: Deps = {},
): Promise<SubmitRes> {
  const [norm, why] = normalizePlan(plan, o.today);
  if (norm === null) return { code: 'ADS_INPUT', reason: why };
  const ctx = await (d.loadContext ?? loadContext)(db, norm, o.month, o.cfg, o.today, d);
  const [code, w] = validatePlan(plan, { ...ctx, today: o.today });
  if (code) return { code, reason: w };
  const sha = planSha(norm);
  const capVnd = (ctx.cap as Cap).budget_vnd;
  const readiness = ctx.readiness.get(readinessKey(norm.sku_key, norm.channel)) as string;
  const probe: PlanRow = {
    ...norm,
    id: 0,
    plan_sha256: sha,
    cap_vnd: capVnd,
    allocated_vnd: ctx.allocated ?? 0,
    cap_ref_month: o.month,
    readiness,
    created_by: o.by,
  };
  const g = guardrailCheck(renderPlan(probe));
  if (g.ok !== true) {
    return {
      code: 'ADS_INPUT',
      reason: `giả thuyết làm phiếu vi phạm guardrail ${pyStr(violationCodes(g))} — viết lại`,
    };
  }
  if (o.dryRun) {
    return {
      code: null,
      reason: 'đạt (dry-run, không ghi)',
      plan_id: null,
      new_items: [],
      created: false,
      cap: capVnd,
    };
  }
  const find = async () =>
    (await db.query<{ id: string }>('select id from ad_test_plans where plan_sha256 = $1', [sha]))
      .rows[0];
  let row = await find();
  let created = row === undefined;
  if (created) {
    try {
      row = await withTx(db, async (c) => {
        // khóa theo SKU × kênh tới commit: 2 phiếu song song không cùng thấy "còn trần" rồi cùng ghi
        await c.query('select pg_advisory_xact_lock(hashtext($1))', [
          `ad_test_plans:${norm.sku_key}:${norm.channel}`,
        ]);
        const alloc = await allocatedVnd(c, norm, o.month);
        if (alloc + norm.budget_vnd > capVnd) throw new OverCap(alloc);
        const r = await c.query<{ id: string }>(
          'insert into ad_test_plans (plan_sha256, sku_key, channel, hypothesis, creative_draft_ids, budget_vnd, cap_vnd, allocated_vnd, cap_ref_month, start_date, end_date, success_metric, stop_rules, readiness, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15) returning id',
          [
            sha,
            norm.sku_key,
            norm.channel,
            norm.hypothesis,
            norm.creative_draft_ids,
            norm.budget_vnd,
            capVnd,
            alloc,
            o.month,
            norm.start_date,
            norm.end_date,
            JSON.stringify(norm.success_metric),
            JSON.stringify(norm.stop_rules),
            readiness,
            o.by,
          ],
        );
        return r.rows[0];
      });
    } catch (e) {
      if (e instanceof OverCap) {
        return {
          code: 'ADS_OVER_CAP',
          reason: `ngân sách ${vnd(norm.budget_vnd)} + đã phân bổ ${vnd(e.alloc)} > trần ${vnd(capVnd)} (phiếu khác vừa ghi song song)`,
        };
      }
      if (!isUnique(e)) throw e; // tạo song song cùng phiếu
      created = false;
      row = await find();
    }
  }
  const pid = N(row?.id);
  const prow = (await getPlan(db, pid)) as PlanRow;
  const payload = renderPlan(prow);
  const title = `Phiếu thử nghiệm ads #${pid} — ${prow.sku_key} × ${prow.channel} — ${vnd(prow.budget_vnd)}`;
  const items: bigint[] = [];
  for (const [block, otype] of ITEMS) {
    const oid = `adtest-${pid}`;
    if (await itemExists(db, otype, oid)) continue;
    try {
      items.push(
        await submit(db, {
          block,
          objectType: otype,
          objectId: oid,
          title,
          payload,
          createdBy: otype === 'budget_change' ? BUDGET_AGENT : o.by,
          cfg: o.dcfg[block] as DirectorConfig,
        }),
      );
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }
  return { code: null, reason: 'đạt', plan_id: pid, new_items: items, created, cap: prow.cap_vnd };
}

// ---------------------------------------------------------------- agent TỰ đề xuất (marketing-03)

/** Nháp creative ĐÃ duyệt đúng SKU (mới nhất trước, tối đa 3). */
async function creativeIds(db: Db, sku: string): Promise<number[]> {
  const { rows } = await db.query(
    "select id from content_drafts where sku = $1 and status = 'approved' and content_type = any($2) order by id desc limit $3",
    [sku, CREATIVE_TYPES, MAX_CREATIVES],
  );
  return rows.map((r) => N(r.id));
}

async function agentPlanLive(db: Db, sku: string, ch: string, month: Day): Promise<number | null> {
  const { rows } = await db.query(
    'select id from ad_test_plans where sku_key = $1 and channel = $2 and cap_ref_month = $3 and created_by = $4 order by id',
    [sku, ch, month, PROPOSE_AGENT],
  );
  for (const r of rows) {
    if (!['tu_choi', 'het_han'].includes(await planStatus(db, r.id))) return N(r.id);
  }
  return null;
}

export type ProposeRow = {
  sku_key: string;
  channel: string;
  code: string;
  reason: string;
  plan_id: number | null;
  new_items: bigint[];
};

/** PL01 Marketing "Đề xuất quảng cáo nhỏ cho sản phẩm được phép": 1 dòng mỗi ô FP&A `DE_XUAT` (ô khác
 * không phải ứng viên) → cùng luật chặn `validatePlan`/`submitPlan`. Mỗi SKU × kênh × tháng trần tối
 * đa 1 đề xuất agent còn hiệu lực. Tính năng TẮT → RolloutBlocked trước mọi ghi. */
export async function propose(
  db: Db,
  o: { month: Day; cfg: AdsCfg; dcfg: Dcfg; pcfg: ProposalCfg; today: Day; dryRun?: boolean },
  d: Deps = {},
): Promise<ProposeRow[]> {
  if (!o.dryRun) await checkGenerate(db, FEATURE, 'đề xuất phiếu thử nghiệm ads');
  const props = fpPropose(
    (await compute(db, o.month)).cells,
    await fetchReadiness(db, o.cfg.channels),
    o.cfg,
  );
  const out: ProposeRow[] = [];
  for (const p of props) {
    if (p.code !== 'DE_XUAT') continue;
    const base = { sku_key: p.sku_key, channel: p.channel, plan_id: null, new_items: [] };
    const old = await agentPlanLive(db, p.sku_key, p.channel, o.month);
    if (old !== null) {
      out.push({
        ...base,
        code: 'DA_CO',
        plan_id: old,
        reason: `đã có đề xuất #${old} còn hiệu lực tháng trần`,
      });
      continue;
    }
    const ids = await creativeIds(db, p.sku_key);
    if (!ids.length) {
      out.push({
        ...base,
        code: 'THIEU_CREATIVE',
        reason: 'chưa có nháp ads/image ĐÃ duyệt cho SKU',
      });
      continue;
    }
    const plan = buildProposal(p, o.pcfg, o.month, o.today, ids);
    if (plan === null) {
      out.push({ ...base, code: 'THIEU_TRAN', reason: 'trần FP&A × tỷ lệ = 0đ' });
      continue;
    }
    const res = await submitPlan(db, plan, { ...o, by: PROPOSE_AGENT }, d);
    out.push({
      ...base,
      code: res.code || 'DE_XUAT',
      reason: res.reason,
      plan_id: res.plan_id ?? null,
      new_items: res.new_items ?? [],
    });
  }
  return out;
}

// ---------------------------------------------------------------- kết quả

export type ResultsRes = {
  code: string | null;
  reason?: string;
  errors?: string[];
  ev?: Eval;
  qid?: bigint | null;
  skipped?: boolean;
};

export async function submitResults(
  db: Db,
  pid: number,
  path: string,
  o: { by: string; dcfg: Dcfg; dryRun?: boolean },
): Promise<ResultsRes> {
  const prow = await getPlan(db, pid);
  if (prow === null) return { code: NOT_APPROVED, reason: `không có phiếu #${pid}` };
  const st = await planStatus(db, pid);
  if (st !== 'da_duyet') {
    return { code: NOT_APPROVED, reason: `phiếu #${pid} trạng thái ${st} — cần duyệt đủ 2 mục` };
  }
  const [rows, errs, sha] = readResults(path, prow);
  if (errs.length) return { code: 'ADS_RESULTS_FILE', errors: errs };
  const ev = evaluate(prow, rows);
  const oid = `adres-${pid}-${(sha as string).slice(0, 12)}`;
  // marketing-03.2: kết quả là ĐẦU RA RIÊNG `ad_result`; mục cũ cùng oid ở ad_campaign vẫn tính là đã có.
  if ((await itemExists(db, RESULT_OT, oid)) || (await itemExists(db, 'ad_campaign', oid))) {
    return { code: null, ev, qid: null, skipped: true };
  }
  if (o.dryRun) return { code: null, ev, qid: null, skipped: false };
  try {
    const qid = await submit(db, {
      block: 'marketing',
      objectType: RESULT_OT,
      objectId: oid,
      title: `Kết quả ads phiếu #${pid} — đề xuất ${ev.de_xuat}`,
      payload: renderResult(prow, ev, sha as string, rows.length),
      createdBy: o.by,
      cfg: o.dcfg.marketing as DirectorConfig,
    });
    return { code: null, ev, qid, skipped: false };
  } catch (e) {
    if (!isUnique(e)) throw e;
    return { code: null, ev, qid: null, skipped: true };
  }
}

/** `--status ID` → exit code. */
export async function printStatus(db: Db, pid: number, log: (s: string) => void): Promise<number> {
  const prow = await getPlan(db, pid);
  if (prow === null) {
    log(`[err] không có phiếu #${pid}`);
    return 1;
  }
  const st = await planStatus(db, pid);
  log(
    `[status] phiếu #${pid} \`${prow.sku_key}\` × ${prow.channel} ${vnd(prow.budget_vnd)} — ${st}`,
  );
  const { rows } = await db.query(
    'select id, block, object_type, status from approval_queue where object_id = $1 order by id',
    [`adtest-${pid}`],
  );
  for (const r of rows) log(`  mục #${r.id} ${r.block}/${r.object_type}: ${r.status}`);
  return 0;
}
