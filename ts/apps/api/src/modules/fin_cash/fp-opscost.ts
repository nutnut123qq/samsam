import { createHash } from 'node:crypto';
import type { Db } from '@samsam/core/ops/deps';
import { type DirectorConfig, submit as directorSubmit } from '@samsam/core/ops/director';
import { periodBounds } from '@samsam/core/ops/period';
import { cpLen, isPrintable } from '@samsam/core/ops/py';
import { cpCmp, PyFloat, pyFloatStr } from '@samsam/core/ops/py-json';
import { withTx } from '@samsam/core/ops/tx';
import { pyRepr, pyStrip } from '@samsam/core/security/py';
import {
  FPA_CONFIG_FILE,
  fmtDay,
  isDict,
  isIntIn,
  mapHeader,
  nextRow,
  openTable,
  parseDec,
  parseMonth,
  readConfig,
  readTable,
  rowRecord,
  vnd,
} from '../fin_ar_pnl/fin-common.js';
import { type Cell, clean, TableError, toInt } from '../intel_import/table.js';
import { type Dec, decInt, divInt, fmtFixed, mul, roundHalfUp } from './decimal.js';

// Port `agents/fp_opscost.py` (v9.1 FP-OpsCost, WP12) — chi phí vận hành: chi phí AI theo agent
// (bảng `llm_usage`, USD → VND theo tỷ giá cấu hình) + chi phí cloud/SaaS/ads/khác nhập tay từ CSV →
// so trần tháng, cảnh báo mức 80% và 100%; khoản chi > ngưỡng X chỉ "được chi" khi TGĐ ký trong hàng
// duyệt. Tất định, KHÔNG LLM/mạng.
// Ranh giới: agent CHỈ cảnh báo + đẩy mục chờ TGĐ ký (`opex_over_x`, risk high — `auto_policies`
// không áp). KHÔNG chi tiền, KHÔNG gọi API nhà cung cấp, KHÔNG tắt key, KHÔNG đổi hạn mức cổng LLM.
// Ownership: ghi DUY NHẤT `opex_entries` (insert-only, idempotent theo sha256 file); chỉ ĐỌC
// `llm_usage` + `approval_queue`.
// File nạp (`--load F`, .csv/.xlsx, header CỐ ĐỊNH, thứ tự tùy ý): month, category, service,
// amount_vnd, doc_ref. Kiểm TOÀN file TRƯỚC connect; lỗi chỉ nêu số dòng + tên field (KHÔNG giá trị ô).
// Cấu hình `data/fpa_config.json` mục `opscost` (GIẢ ĐỊNH — chờ GĐ tài chính chốt).

export const FEATURE = 'finance-05.1';
export const HEADER = ['month', 'category', 'service', 'amount_vnd', 'doc_ref'] as const;
export const REQUIRED = ['month', 'category', 'service', 'amount_vnd'] as const;
export const CATEGORIES = ['cloud', 'saas', 'ads', 'khac'] as const;
export const SCOPES = ['ai', ...CATEGORIES, 'tong'];
export const STATUSES = ['trong_nguong', 'duoc_chi', 'cho_tgd_ky'] as const;
export const MONEY_CAP = 10 ** 13;
export const MAX_REF = 64;
export const CREATED_BY = 'agent:fp_opscost';
const SERVICE_RE = /^[a-z0-9][a-z0-9_.-]{1,39}$/;
const AI_SCOPE_RE = /^ai:[a-z0-9][a-z0-9_.:-]{0,63}$/;
export const NOTE_X =
  'CHỜ TGĐ KÝ — agent không chi, không tắt key, không đổi limit. Chỉ "được chi" khi người có vai trò `tgd` duyệt đúng mục này (per_item).';

export type OpsCfg = {
  usd_vnd: number;
  budget_vnd: Record<string, number>;
  warn_pct: number;
  stop_pct: number;
  threshold_x_vnd: number;
};

// ---------------------------------------------------------------- cấu hình

/** `load_cfg(path)` → [cfg, null] | [null, lý do] (caller exit 1 TRƯỚC connect). */
export function loadCfg(path: string = FPA_CONFIG_FILE): [OpsCfg, null] | [null, string] {
  const [sec, why0] = readConfig('opscost', path);
  if (sec === null) return [null, why0 as string];
  const rate = sec.usd_vnd;
  if (!isIntIn(rate, 1, 10 ** 6)) return [null, 'opscost.usd_vnd: phải int 1..1000000'];
  const b = sec.budget_vnd;
  if (!isDict(b)) return [null, 'opscost.budget_vnd: phải là object {scope: VND}'];
  for (const [k, v] of Object.entries(b)) {
    if (!(SCOPES.includes(k) || AI_SCOPE_RE.test(k))) {
      return [null, `opscost.budget_vnd: scope lạ '${clean(k, 40)}'`];
    }
    if (!isIntIn(v, 1, MONEY_CAP)) return [null, `opscost.budget_vnd.${k}: phải int > 0`];
  }
  const warn = Object.hasOwn(sec, 'warn_pct') ? sec.warn_pct : 80;
  const stop = Object.hasOwn(sec, 'stop_pct') ? sec.stop_pct : 100;
  if (!isIntIn(warn, 1, 1000) || !isIntIn(stop, 1, 1000) || warn >= stop) {
    return [null, 'opscost.warn_pct/stop_pct: int 1..1000, warn < stop'];
  }
  const x = sec.threshold_x_vnd;
  if (!isIntIn(x, 1, MONEY_CAP)) return [null, 'opscost.threshold_x_vnd: phải int > 0'];
  return [
    {
      usd_vnd: rate,
      budget_vnd: { ...(b as Record<string, number>) },
      warn_pct: warn,
      stop_pct: stop,
      threshold_x_vnd: x,
    },
    null,
  ];
}

// ---------------------------------------------------------------- đọc file (thuần)

export type OpexRow = {
  row_no: number;
  month: string;
  category: string;
  service: string;
  amount_vnd: number;
  doc_ref: string | null;
};

/** `read_opex` → [entries, lỗi, sha256 file]. Lỗi ≠ [] → entries = []. */
export async function readOpex(path: string): Promise<[OpexRow[], string[], string | null]> {
  const [src, sha, err] = readTable(path);
  if (err !== null || src === null) return [[], [err as string], sha];
  const rows: OpexRow[] = [];
  const errs: string[] = [];
  try {
    const it = await openTable(src);
    const first = nextRow(it);
    if (first === null) return [[], ['file rỗng'], sha];
    const optional = Object.fromEntries(
      HEADER.filter((f) => !(REQUIRED as readonly string[]).includes(f)).map((f) => [f, f]),
    );
    const [colOf, herrs] = mapHeader(
      first[1],
      Object.fromEntries(REQUIRED.map((f) => [f, f])),
      optional,
      [],
      'chi phí vận hành',
    );
    if (herrs.length) return [[], herrs, sha];
    const width = first[1].length;
    let nBody = 0;
    for (let r = nextRow(it); r !== null; r = nextRow(it)) {
      const [rowNo, cells] = r;
      nBody += 1;
      const [rec, extra] = rowRecord(cells, width, colOf);
      if (extra) {
        errs.push(`dòng ${rowNo}: thừa ô ngoài header`);
        continue;
      }
      const e = parseRow(rec, rowNo);
      if (Array.isArray(e)) errs.push(...e);
      else rows.push(e);
    }
    if (!nBody) return [[], ['file chỉ có header, không có dòng dữ liệu'], sha];
  } catch (e) {
    if (e instanceof TableError) return [[], [e.message], sha];
    throw e;
  }
  return [errs.length ? [] : rows, errs, sha];
}

function parseRow(rec: Record<string, Cell>, rowNo: number): OpexRow | string[] {
  const errs: string[] = [];
  const bad = (f: string, why: string) => errs.push(`dòng ${rowNo}: field '${f}' ${why}`);
  for (const f of REQUIRED) if (rec[f] === null || rec[f] === undefined) bad(f, 'trống');
  if (errs.length) return errs;
  const month = parseMonth(rec.month);
  if (month === null) bad('month', 'phải dạng YYYY-MM');
  const category = rec.category as string;
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    bad('category', `phải thuộc (${CATEGORIES.map(pyRepr).join(', ')})`);
  }
  const service = rec.service as string;
  if (!SERVICE_RE.test(service)) {
    bad('service', 'phải mã ^[a-z0-9][a-z0-9_.-]{1,39}$ (không dấu cách)');
  }
  const amt = toInt(rec.amount_vnd, MONEY_CAP);
  if (!amt) bad('amount_vnd', 'phải là số nguyên VND > 0');
  const ref = rec.doc_ref ?? null;
  if (ref !== null && (cpLen(ref) > MAX_REF || !isPrintable(ref))) {
    bad('doc_ref', `dài quá ${MAX_REF} hoặc có ký tự điều khiển`);
  }
  if (errs.length) return errs;
  return {
    row_no: rowNo,
    month: month as string,
    category,
    service,
    amount_vnd: amt as number,
    doc_ref: ref,
  };
}

// ---------------------------------------------------------------- tính (thuần)

/** Số tiền USD: Decimal (chuỗi từ DB/`str(Decimal)`), số JSON (int/float) → Decimal(str(usd)). */
export type Usd = string | number | PyFloat | Dec;

function usdDec(v: Usd): Dec {
  if (typeof v === 'object' && 'coef' in v) return v;
  if (v instanceof PyFloat) return parseDec(pyFloatStr(v.v));
  if (typeof v === 'number') return parseDec(Number.isInteger(v) ? String(v) : pyFloatStr(v));
  return parseDec(pyStrip(v));
}

/** `ai_vnd` = ROUND_HALF_UP(Decimal(str(usd)) × tỷ giá). */
export function aiVnd(spendUsd: Usd, usdVnd: number): number {
  return Number(roundHalfUp(mul(usdDec(spendUsd), decInt(usdVnd))));
}

export type OpexEntry = {
  id: string | number;
  file_sha256: string;
  row_no: number;
  month: string;
  category: string;
  service: string;
  amount_vnd: number;
};

/** `actuals`: ai_usd = {agent_id: USD}, opex = dòng tháng → {scope: VND} (`ai:<agent>`, `ai`,
 * category, `tong`). */
export function actuals(
  aiUsd: Record<string, Usd>,
  opex: Pick<OpexEntry, 'category' | 'amount_vnd'>[],
  usdVnd: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of Object.keys(aiUsd).sort(cpCmp)) {
    out[`ai:${a}`] = aiVnd(aiUsd[a] as Usd, usdVnd);
  }
  out.ai = Object.values(out).reduce((s, v) => s + v, 0);
  for (const c of CATEGORIES) {
    out[c] = opex.filter((e) => e.category === c).reduce((s, e) => s + e.amount_vnd, 0);
  }
  out.tong = out.ai + CATEGORIES.reduce((s, c) => s + (out[c] as number), 0);
  return out;
}

export type Alert = { scope: string; level: number; label: string; spent: number; budget: number };

/** Mỗi scope có trần ĐÚNG ≤ 1 cảnh báo, mức cao nhất đạt (so số nguyên `spent×100 ≥ budget×pct`). */
export function budgetAlerts(
  acts: Record<string, number>,
  budgets: Record<string, number>,
  warnPct: number,
  stopPct: number,
): Alert[] {
  const out: Alert[] = [];
  for (const scope of Object.keys(budgets).sort(cpCmp)) {
    const budget = budgets[scope] as number;
    const spent = Object.hasOwn(acts, scope) ? (acts[scope] as number) : 0;
    const s100 = BigInt(spent) * 100n;
    let lvl: number;
    let label: string;
    if (s100 >= BigInt(budget) * BigInt(stopPct)) [lvl, label] = [stopPct, 'VƯỢT TRẦN'];
    else if (s100 >= BigInt(budget) * BigInt(warnPct)) [lvl, label] = [warnPct, 'CẢNH BÁO'];
    else continue;
    out.push({ scope, level: lvl, label, spent, budget });
  }
  return out;
}

/** object_id mục `opex_over_x` = khóa tự nhiên (sha file + số dòng), KHÔNG id tự tăng: dựng lại
 * `opex_entries` (nạp lại / thứ tự khác / id bị đốt) làm id lệch → chữ ký TGĐ trỏ sang khoản khác. */
export const opexKey = (e: Pick<OpexEntry, 'file_sha256' | 'row_no'>): string =>
  `opex-${e.file_sha256.slice(0, 16)}-${e.row_no}`;

// Lý do `cho_tgd_ky` (in ở --status); `chua_co`/`khac_vai_tro` → --submit-over-x đẩy 1 mục pending
// mới; `bi_chan` = mục pending KHÔNG hợp lệ chiếm unique pending của khóa này — người duyệt reject.
export const WHY: Record<string, string> = {
  tgd_ky: 'TGĐ đã ký',
  cho_ky: 'đang chờ TGĐ ký',
  khac_vai_tro: 'đã duyệt bởi vai trò khác — cần TGĐ (chạy --submit-over-x để đẩy lại)',
  bi_chan:
    'mục chờ duyệt KHÔNG hợp lệ (khác khối/agent/nội dung) đang chặn — người duyệt reject mục đó',
  chua_co: 'chưa có mục chờ TGĐ ký (hoặc đã bị từ chối/hết hạn)',
};

/** Mục hàng duyệt `opex_over_x` (cột `fetch_items`). */
export type QueueRow = {
  id?: unknown;
  object_type: string | null;
  object_id: string | null;
  block: string | null;
  created_by: string | null;
  content_sha256: string | null;
  status: string | null;
  lane: string | null;
  decided_by: string | null;
};
/** username_lower → {role} (`pipelines.auth.load_users`). */
export type Users = ReadonlyMap<string, { role: string }>;

type OverEntry = Pick<OpexEntry, 'file_sha256' | 'row_no' | 'month' | 'category' | 'service'> & {
  amount_vnd: number;
};

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Mục do CHÍNH agent này đẩy cho đúng khoản + đúng nội dung (payload dựng lại từ khoản hiện tại) —
 * mục agent/khối khác hoặc payload khác không bao giờ tính (A08). */
function mine(it: QueueRow, e: OverEntry): boolean {
  return (
    it.object_type === 'opex_over_x' &&
    it.object_id === opexKey(e) &&
    it.block === 'finance' &&
    it.created_by === CREATED_BY &&
    it.content_sha256 === sha256(renderOverX(e))
  );
}

/** → [trạng thái, mã lý do `WHY` | null khi trong ngưỡng]. Fail-closed: chỉ `duoc_chi` khi mục CỦA
 * agent này, approved, lane per_item, người quyết có vai trò `tgd`. */
export function verdict(
  e: OverEntry,
  items: QueueRow[],
  users: Users,
  x: number,
): [string, string | null] {
  if (e.amount_vnd <= x) return ['trong_nguong', null];
  const oid = opexKey(e);
  const same = items.filter((it) => it.object_type === 'opex_over_x' && it.object_id === oid);
  const my = same.filter((it) => mine(it, e));
  for (const it of my) {
    const who = pyStrip(it.decided_by ?? '').toLowerCase();
    if (
      it.status === 'approved' &&
      it.lane === 'per_item' &&
      who &&
      users.get(who)?.role === 'tgd'
    ) {
      return ['duoc_chi', 'tgd_ky'];
    }
  }
  if (my.some((it) => it.status === 'pending')) return ['cho_tgd_ky', 'cho_ky'];
  if (same.some((it) => it.status === 'pending')) return ['cho_tgd_ky', 'bi_chan'];
  if (my.some((it) => it.status === 'approved')) return ['cho_tgd_ky', 'khac_vai_tro'];
  return ['cho_tgd_ky', 'chua_co'];
}

export const spendStatus = (e: OverEntry, items: QueueRow[], users: Users, x: number): string =>
  verdict(e, items, users, x)[0];

/** `Decimal(spent)*100/Decimal(budget)` làm tròn 0.1 (nửa-chẵn như `quantize`) + "%". */
export function pct(spent: number, budget: number): string {
  return `${fmtFixed(divInt(BigInt(spent) * 100n, BigInt(budget)), 1)}%`;
}

export function renderReport(
  month: string,
  acts: Record<string, number>,
  cfg: OpsCfg,
  alerts: Alert[],
  over: [unknown, string][],
): string {
  const b = cfg.budget_vnd;
  const scopes = [
    ...new Set([...Object.keys(b), ...Object.keys(acts).filter((k) => acts[k])]),
  ].sort(cpCmp);
  const L = [
    `# Chi phí vận hành tháng ${fmtDay(month, '%m/%Y')} — so trần (GIẢ ĐỊNH)`,
    '',
    `Tỷ giá quy đổi chi phí AI ${vnd(cfg.usd_vnd)}/USD; cảnh báo ${cfg.warn_pct}% / ${cfg.stop_pct}% trần; ngưỡng X ${vnd(cfg.threshold_x_vnd)} — \`data/fpa_config.json\` chờ GĐ tài chính chốt.`,
    '',
    '| Phạm vi | Thực chi | Trần | % trần |',
    '|---|---|---|---|',
  ];
  for (const s of scopes) {
    const spent = Object.hasOwn(acts, s) ? (acts[s] as number) : 0;
    const budget = Object.hasOwn(b, s) ? (b[s] as number) : null;
    L.push(
      `| \`${s}\` | ${vnd(spent)} | ${budget !== null ? `${vnd(budget)} | ${pct(spent, budget)} |` : 'chưa có trần | — |'}`,
    );
  }
  L.push('', 'Cảnh báo:');
  const al = alerts.map(
    (a) => `- [${a.label} ${a.level}%] \`${a.scope}\`: ${vnd(a.spent)} / trần ${vnd(a.budget)}`,
  );
  L.push(...(al.length ? al : ['- (không có)']));
  const wait = over.filter(([, st]) => st === 'cho_tgd_ky').length;
  const ok = over.filter(([, st]) => st === 'duoc_chi').length;
  L.push(
    '',
    `Khoản > ngưỡng X: ${over.length} — đang chờ TGĐ ký: ${wait}, được chi: ${ok}.`,
    '',
    'Agent chỉ cảnh báo — không chi, không tắt key, không đổi hạn mức; người quyết theo quy trình tài chính.',
    '',
  );
  return L.join('\n');
}

/** Payload mục `opex_over_x` — CHỈ nội dung khoản (hash = chữ ký TGĐ gắn với khoản): không id tự
 * tăng, không ngưỡng X (X ở tiêu đề mục). Byte phải y hệt Python (cùng DB, chữ ký dùng chung). */
export function renderOverX(e: OverEntry): string {
  return [
    '# Khoản chi vượt ngưỡng X — chờ TGĐ ký',
    '',
    `- Tháng: ${fmtDay(e.month, '%m/%Y')}`,
    `- Nhóm: \`${e.category}\` · dịch vụ \`${e.service}\``,
    `- Số tiền: ${vnd(e.amount_vnd)}`,
    '- Chữ ký gắn với đúng dòng file chi phí đã nạp + nội dung trên; nội dung đổi → phải ký lại.',
    '',
    `**${NOTE_X}**`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- DB

/** Ghi `opex_entries` (một giao dịch — lỗi giữa chừng không để lại dòng nào). */
export async function load(
  db: Db,
  entries: OpexRow[],
  fileName: string,
  sha: string,
): Promise<number> {
  await withTx(db, async (c) => {
    for (const e of entries) {
      await c.query(
        'insert into opex_entries (file_sha256, file_name, row_no, month, category, service,' +
          ' amount_vnd, doc_ref) values ($1, $2, $3, $4::date, $5, $6, $7, $8)',
        [sha, fileName, e.row_no, e.month, e.category, e.service, e.amount_vnd, e.doc_ref],
      );
    }
  });
  return entries.length;
}

/** {agent_id: USD (chuỗi Decimal)} của tháng — biên tháng theo giờ VN (period_bounds). */
export async function fetchAiUsd(db: Db, month: string): Promise<Record<string, string>> {
  const [start, end] = periodBounds('month', month);
  const { rows } = await db.query<{ agent_id: string; usd: string }>(
    'select agent_id, coalesce(sum(cost_usd), 0)::text as usd from llm_usage where' +
      ' ts >= $1 and ts < $2 group by agent_id',
    [start, end],
  );
  return Object.fromEntries(rows.map((r) => [r.agent_id, r.usd]));
}

export async function fetchOpex(db: Db, month: string): Promise<OpexEntry[]> {
  const { rows } = await db.query(
    'select id::text as id, file_sha256, row_no, month::text as month, category, service,' +
      ' amount_vnd::text as amount_vnd from opex_entries where month = $1::date order by id',
    [month],
  );
  return rows.map((r) => ({ ...r, amount_vnd: Number(r.amount_vnd) }) as OpexEntry);
}

/** MỌI mục `opex_over_x` (kể cả khối/agent khác — để `verdict` nhận ra mục lạ đang chiếm unique
 * pending); chỉ mục của agent này mới được tính. */
export async function fetchItems(db: Db): Promise<QueueRow[]> {
  const { rows } = await db.query<QueueRow>(
    'select id::text as id, object_type, object_id, block, created_by, content_sha256, status,' +
      " lane, decided_by from approval_queue where object_type = 'opex_over_x' order by id",
  );
  return rows;
}

export type Summary = {
  actuals: Record<string, number>;
  co_nguon: Set<string>;
  over: [OpexEntry, string][];
  why: Record<string, string | null>;
  alerts: Alert[];
};

/** → {actuals, co_nguon, alerts, over: [(entry, status)], why: {entry id: mã lý do}} — dùng chung
 * report/status/fin_director. */
export async function summary(
  db: Db,
  month: string,
  cfg: OpsCfg,
  users: Users,
  src: {
    fetchOpex?: typeof fetchOpex;
    fetchAiUsd?: typeof fetchAiUsd;
    fetchItems?: typeof fetchItems;
  } = {},
): Promise<Summary> {
  const opex = await (src.fetchOpex ?? fetchOpex)(db, month);
  const aiUsd = await (src.fetchAiUsd ?? fetchAiUsd)(db, month);
  const acts = actuals(aiUsd, opex, cfg.usd_vnd);
  const items = await (src.fetchItems ?? fetchItems)(db);
  const x = cfg.threshold_x_vnd;
  const vs = opex
    .filter((e) => e.amount_vnd > x)
    .map((e) => [e, ...verdict(e, items, users, x)] as const);
  // r12 G1-L3: phạm vi có ≥ 1 dòng nguồn trong tháng (0 dòng ≠ chi 0đ).
  const agents = Object.keys(aiUsd);
  const src0 = new Set<string>([
    ...agents.map((a) => `ai:${a}`),
    ...(agents.length ? ['ai'] : []),
    ...opex.map((e) => e.category),
  ]);
  if (src0.size) src0.add('tong');
  return {
    actuals: acts,
    co_nguon: src0,
    over: vs.map(([e, st]) => [e, st]),
    why: Object.fromEntries(vs.map(([e, , why]) => [String(e.id), why])),
    alerts: budgetAlerts(acts, cfg.budget_vnd, cfg.warn_pct, cfg.stop_pct),
  };
}

/**
 * Mỗi khoản > X chưa có chữ ký TGĐ hợp lệ và chưa có mục pending hợp lệ (lý do `chua_co` /
 * `khac_vai_tro`) → 1 mục `opex_over_x` mới. Mục approved bởi vai trò khác / auto_policy KHÔNG chặn
 * đẩy lại (nếu chặn, khoản kẹt `cho_tgd_ky` vĩnh viễn). → [[entry id, queue id]], [entry id bị mục
 * lạ chặn]. Cổng rollout `tat` → RolloutBlocked từ `enqueue` (không ghi).
 */
export async function submitOverX(
  db: Db,
  month: string,
  cfg: OpsCfg,
  users: Users,
  dcfg?: DirectorConfig,
): Promise<[[string, bigint][], string[]]> {
  const x = cfg.threshold_x_vnd;
  const items = await fetchItems(db);
  const todo: OpexEntry[] = [];
  const blocked: string[] = [];
  for (const e of await fetchOpex(db, month)) {
    if (e.amount_vnd <= x) continue;
    const why = verdict(e, items, users, x)[1];
    if (why === 'chua_co' || why === 'khac_vai_tro') todo.push(e);
    else if (why === 'bi_chan') blocked.push(String(e.id));
  }
  const out: [string, bigint][] = [];
  for (const e of todo) {
    const title = `Khoản chi vượt ngưỡng X ${vnd(x)}: ${e.category}/${e.service} ${vnd(e.amount_vnd)}`;
    const qid = await directorSubmit(db, {
      block: 'finance',
      objectType: 'opex_over_x',
      objectId: opexKey(e),
      title,
      payload: renderOverX(e),
      createdBy: CREATED_BY,
      cfg: dcfg,
    });
    out.push([String(e.id), qid]);
  }
  return [out, blocked];
}
