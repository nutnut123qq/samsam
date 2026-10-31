import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { addDays, dmy, parseDay } from '@samsam/core/ops/period';
import { csvRows } from '@samsam/core/ops/py-csv';
import { cpCmp, isDict, isPyInt, PyFloat, pyOsName } from '@samsam/core/ops/py-json';
import { oneline } from '@samsam/core/ops/store';
import { checkPublish, type ReadinessMap, readinessKey } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, cpLen, pyRepr, pyStr, pyStrip } from '@samsam/core/security/py';
import { dayDiff, readStrictJson } from '../kd_price/deps.js';
import { CHANNELS } from '../sales_director/kd-forecast.deps.js';
import {
  cmpRat,
  type Dec,
  decOf,
  decParse,
  decRat,
  decStr,
  quantize,
  type Rat,
  rat,
  truncRat,
} from './dec.js';
import { pyTuple } from './fp-ads.js';
import { vnd } from './fp-pnl.js';

// Port phần THUẦN của `agents/mkt_ads.py` (v6.4 MKT-05, WP08) — phiếu THỬ NGHIỆM quảng cáo + đề xuất
// dừng/tiếp từ file kết quả xuất tay. Tất định, KHÔNG LLM, KHÔNG mạng. Agent KHÔNG chi tiền, KHÔNG
// gọi API quảng cáo, KHÔNG cài chiến dịch. Ánh xạ chính sách kênh → readiness đang chạy:
//   offline_only = category `alcohol` (xét TRƯỚC readiness) · listing_only = readiness `MO_TA`
//   CAM = readiness CAM còn lại (kể cả SKU không có trong view) · online_ok = TP_THUONG | QC_DAY_DU.
// Ngày = chuỗi 'YYYY-MM-DD' (Python `date`).

export const REJECT_CODES = [
  'ADS_INPUT',
  'ADS_OFFLINE_ONLY',
  'ADS_LISTING_ONLY',
  'ADS_CAM',
  'ADS_XNQC_DOSSIER',
  'ADS_CREATIVE_UNAPPROVED',
  'ADS_NO_CAP',
  'ADS_OVER_CAP',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];
export const NOT_APPROVED = 'ADS_PLAN_NOT_APPROVED';
export const PLAN_KEYS = [
  'sku_key',
  'channel',
  'hypothesis',
  'creative_draft_ids',
  'budget_vnd',
  'start_date',
  'end_date',
  'success_metric',
  'stop_rules',
];
export const METRICS = ['ctr', 'cpc', 'cpa', 'don_hang'];
export const OPS = ['>=', '<='];
export const CREATIVE_TYPES = ['ads', 'image'];
export const CONTENT_OK = ['TP_THUONG', 'QC_DAY_DU'];
export const MAX_DAYS = 30;
export const MAX_CREATIVES = 3;
export const MAX_STOP_RULES = 10;
export const BUDGET_CAP = 10 ** 12;
export const MAX_PLAN_BYTES = 64_000;
export const MAX_CSV_BYTES = 5_000_000;
export const MAX_CSV_ROWS = 10_000;
/** Python `csv.field_size_limit()` mặc định. */
export const CSV_FIELD_LIMIT = 131_072;
export const RESULT_COLS = ['ngay', 'bien_the', 'hien_thi', 'click', 'chi_phi_vnd', 'don_hang'];
export const DECISIONS = ['dung', 'dat_muc_tieu', 'tiep', 'chua_du_lieu'] as const;
export const ITEMS: readonly (readonly [string, string])[] = [
  ['marketing', 'ad_campaign'],
  ['finance', 'budget_change'],
];
export const RESULT_OT = 'ad_result'; // marketing-03.2 (kết quả + giữ/tắt)
// v15.2 (P8.2): mục `finance/budget_change` của phiếu ads mang agent id RIÊNG (không phải tên người
// lập, không trùng `agent:fp_ads` của finance-04.2) để rollout quy đúng marketing-03. Người lập vẫn
// không tự duyệt được: mục marketing giữ created_by = người lập (DB chặn) + `planStatus` coi người
// lập duyệt mục ngân sách = `cung_nguoi_duyet`.
export const BUDGET_AGENT = 'agent:mkt05_budget';
export const PROPOSE_AGENT = 'agent:mkt05';
export const FEATURE = 'marketing-03.1'; // đề xuất phiếu (03.2 = ad_result)
export const RESULT_FEATURE = 'marketing-03.2';
export const NOTE =
  'ĐỀ XUẤT — agent không chi tiền, không gọi API quảng cáo; Quản lý MXH cài tay sau khi GĐ Marketing + GĐ tài chính duyệt.';
export const RES_NOTE =
  'ĐỀ XUẤT dừng/tiếp — người quyết; agent không chi tiền, không đổi ngân sách trên nền tảng. Muốn chi thêm phải lập phiếu mới qua trần FP&A.';
export const FLAG_OVER = 'CHI VƯỢT PHIẾU';
export const FLAG_SPENT = 'HẾT NGÂN SÁCH PHIẾU';
export const PROP_KEYS = [
  'chot_boi',
  'can_cu',
  'ty_le_tran',
  'so_ngay_chay',
  'bat_dau_sau_ngay',
  'success_metric',
  'stop_rules',
];

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SKU_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;

export type Day = string;
export type Rule = { metric: string; op: string } & Record<string, string>;
export type Norm = {
  sku_key: string;
  channel: string;
  hypothesis: string;
  creative_draft_ids: number[];
  budget_vnd: number;
  start_date: Day;
  end_date: Day;
  success_metric: Rule;
  stop_rules: Rule[];
};
export type Creative = {
  status?: unknown;
  sku?: unknown;
  content_type?: unknown;
  text?: unknown;
  is_ai?: unknown;
  verified?: unknown;
};
export type Cap = { code: string | null; budget_vnd: number };
export type Ctx = {
  golden: Map<string, { category: unknown }>;
  readiness: ReadinessMap;
  creatives: Map<number, Creative>;
  cap: Cap | null;
  today: Day;
  dossier_ok?: boolean;
  allocated?: number;
};

/** Python `_is_int` (int, không bool). Khác Python có chủ đích: số nguyên > 2^53 bị từ chối (JS mất
 * chính xác — chặt hơn, fail-closed). */
const isInt = (v: unknown): v is number => isPyInt(v) && Number.isSafeInteger(v);

/** Số JSON dương (int/float, không bool) → Decimal; sai → null. */
function num(v: unknown): Dec | null {
  if (!(typeof v === 'number' || v instanceof PyFloat)) return null;
  const x = v instanceof PyFloat ? v.v : v;
  if (!Number.isFinite(x)) return null;
  const d = decOf(v);
  return !d.neg && d.c > 0n ? d : null;
}

/** 'YYYY-MM-DD' hợp lệ → ngày | null. */
export const pyDate = (v: unknown): Day | null =>
  typeof v === 'string' && DATE_RE.test(v) && parseDay(v) !== null ? v : null;

function rule(r: unknown, key: string, where: string): [Rule, null] | [null, string] {
  const keys = isDict(r) ? Object.keys(r) : null;
  if (keys === null || keys.length !== 3 || !['metric', 'op', key].every((k) => keys.includes(k))) {
    return [null, `${where}: cần object {metric, op, ${key}}`];
  }
  const o = r as Record<string, unknown>;
  if (typeof o.metric !== 'string' || !METRICS.includes(o.metric)) {
    return [null, `${where}.metric phải ${METRICS.join('|')}`];
  }
  if (typeof o.op !== 'string' || !OPS.includes(o.op)) {
    return [null, `${where}.op phải ${OPS.join('|')}`];
  }
  const n = num(o[key]);
  if (n === null) return [null, `${where}.${key} phải là số > 0`];
  return [{ metric: o.metric, op: o.op, [key]: decStr(n) } as Rule, null];
}

/** Kiểm + chuẩn hóa phiếu (THUẦN) → [norm, null] | [null, lý do]. */
export function normalizePlan(plan: unknown, today: Day): [Norm, null] | [null, string] {
  if (!isDict(plan)) return [null, 'phiếu phải là object JSON'];
  const stray = Object.keys(plan)
    .filter((k) => !PLAN_KEYS.includes(k) && k !== '_doc')
    .sort(cpCmp);
  if (stray.length) return [null, `key lạ: ${pyStr(stray.slice(0, 5).map((k) => cpHead(k, 30)))}`];
  const miss = PLAN_KEYS.filter((k) => !Object.hasOwn(plan, k));
  if (miss.length) return [null, `thiếu field: ${pyStr(miss)}`];
  const sku = plan.sku_key;
  const ch = plan.channel;
  if (typeof sku !== 'string' || !SKU_RE.test(sku)) return [null, 'sku_key phải slug a-z0-9-'];
  if (typeof ch !== 'string' || !CHANNELS.includes(ch)) {
    return [null, `channel phải ∈ ${pyTuple(CHANNELS)}`];
  }
  const hyp = plan.hypothesis;
  if (typeof hyp !== 'string' || !(cpLen(pyStrip(hyp)) >= 10 && cpLen(pyStrip(hyp)) <= 500)) {
    return [null, 'hypothesis phải 10..500 ký tự'];
  }
  const ids = plan.creative_draft_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > MAX_CREATIVES ||
    !ids.every((i) => isInt(i) && i > 0) ||
    new Set(ids).size !== ids.length
  ) {
    return [null, `creative_draft_ids phải 1..${MAX_CREATIVES} id draft số dương, không trùng`];
  }
  const bud = plan.budget_vnd;
  if (!isInt(bud) || !(bud > 0 && bud <= BUDGET_CAP)) {
    return [null, 'budget_vnd phải số nguyên đồng > 0'];
  }
  const start = pyDate(plan.start_date);
  const end = pyDate(plan.end_date);
  if (start === null || end === null) return [null, 'start_date/end_date phải YYYY-MM-DD hợp lệ'];
  if (start < today) return [null, `start_date trước hôm nay (${today}, giờ VN)`];
  if (end < start || dayDiff(end, start) > MAX_DAYS) {
    return [null, `thời gian phải 0..${MAX_DAYS} ngày (end ≥ start)`];
  }
  const [sm, w1] = rule(plan.success_metric, 'target', 'success_metric');
  if (sm === null) return [null, w1];
  const rules = plan.stop_rules;
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_STOP_RULES) {
    return [null, `stop_rules phải 1..${MAX_STOP_RULES} điều kiện`];
  }
  const stops: Rule[] = [];
  for (const [i, r] of rules.entries()) {
    const [s, why] = rule(r, 'value', `stop_rules[${i}]`);
    if (s === null) return [null, why];
    stops.push(s);
  }
  return [
    {
      sku_key: sku,
      channel: ch,
      hypothesis: pyStrip(hyp),
      creative_draft_ids: [...(ids as number[])],
      budget_vnd: bud,
      start_date: start,
      end_date: end,
      success_metric: sm,
      stop_rules: stops,
    },
    null,
  ];
}

/** Python `json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`; chuỗi có
 * surrogate lẻ → lỗi như `.encode("utf-8")` của Python (UnicodeEncodeError). */
function canon(v: unknown): string {
  if (typeof v === 'string') {
    if (/\p{Cs}/u.test(v)) throw new RangeError('UnicodeEncodeError');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(cpCmp)
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** sha256 JSON chuẩn hóa — chạy lại cùng phiếu = cùng sha = không tạo phiếu thứ 2. */
export const planSha = (norm: Norm): string =>
  createHash('sha256').update(canon(norm), 'utf8').digest('hex');

function creativeWhy(
  i: number,
  c: Creative | undefined,
  norm: Norm,
  readiness: ReadinessMap,
): string | null {
  if (!isDict(c)) return `draft #${i} không tồn tại`;
  if (c.status !== 'approved') return `draft #${i} chưa duyệt (trạng thái ${pyStr(c.status)})`;
  if (c.sku !== norm.sku_key) return `draft #${i} gắn SKU khác SKU phiếu`;
  if (typeof c.content_type !== 'string' || !CREATIVE_TYPES.includes(c.content_type)) {
    return `draft #${i} loại ${pyStr(c.content_type)} — cần ads|image`;
  }
  if (c.verified !== true) return `draft #${i} không khớp bản đã duyệt (verify_publish)`;
  const g = checkPublish(typeof c.text === 'string' && c.text ? c.text : '', {
    channel: norm.channel,
    contentType: 'ads',
    sku: norm.sku_key,
    isAi: c.is_ai !== false,
    isSponsored: true,
    readiness,
  });
  if (g.ok !== true)
    return `draft #${i} không qua guardrail quảng cáo kênh phiếu ${pyStr(codes(g))}`;
  return null;
}

/** Mã vi phạm guardrail (set → sorted). */
export function codes(g: Record<string, unknown>): string[] {
  const vs = Array.isArray(g.violations) ? g.violations : [];
  return [...new Set(vs.filter(isDict).map((v) => v.code as string))].sort(cpCmp);
}

/** THUẦN. → [mã | null, lý do] theo thứ tự ưu tiên `REJECT_CODES`. `allocated` = tổng ngân sách
 * phiếu KHÁC đang giữ trần cùng SKU × kênh × tháng — trần là trần THÁNG, chẻ phiếu nhỏ vẫn cộng dồn. */
export function validatePlan(plan: unknown, x: Ctx): [RejectCode | null, string] {
  const [norm, why] = normalizePlan(plan, x.today);
  if (norm === null) return ['ADS_INPUT', why];
  const { sku_key: sku, channel: ch } = norm;
  const g = x.golden.get(sku);
  if (isDict(g) && g.category === 'alcohol') {
    return ['ADS_OFFLINE_ONLY', 'SKU nhóm offline_only (đồ uống có cồn) — không quảng cáo online'];
  }
  const lvl = x.readiness.get(readinessKey(sku, ch));
  if (lvl === 'MO_TA') {
    return [
      'ADS_LISTING_ONLY',
      `${sku} × ${ch}: listing_only (TPBVSK chưa XNQC) — chỉ mô tả, không ads`,
    ];
  }
  if (lvl === undefined || !CONTENT_OK.includes(lvl) || !isDict(g)) {
    return ['ADS_CAM', `${sku} × ${ch}: readiness ${lvl || 'không có'}`];
  }
  if (g.category === 'tpbvsk' && !x.dossier_ok) {
    return [
      'ADS_XNQC_DOSSIER',
      `${sku}: không có hồ sơ XNQC da_cap còn hạn trong sổ xnqc_dossiers`,
    ];
  }
  for (const i of norm.creative_draft_ids) {
    const w = creativeWhy(i, x.creatives.get(i), norm, x.readiness);
    if (w) return ['ADS_CREATIVE_UNAPPROVED', w];
  }
  const cap = x.cap;
  if (!isDict(cap) || cap.code !== 'DE_XUAT') {
    const code = isDict(cap) ? pyStr(cap.code) : 'không có';
    return ['ADS_NO_CAP', `${sku} × ${ch}: FP&A không có trần ngân sách (mã ${code})`];
  }
  const allocated = x.allocated ?? 0;
  if (norm.budget_vnd + allocated > cap.budget_vnd) {
    const extra = allocated
      ? ` + đã phân bổ ${vnd(allocated)} (phiếu khác cùng SKU × kênh × tháng, chưa từ chối/hết hạn)`
      : '';
    return [
      'ADS_OVER_CAP',
      `ngân sách ${vnd(norm.budget_vnd)}${extra} > trần ${vnd(cap.budget_vnd)}`,
    ];
  }
  return [null, 'đạt'];
}

// ---------------------------------------------------------------- kết quả chạy ads (file xuất tay)

const INT_RE = /^(?:[0-9]+|[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*)$/;

/** Số nguyên ≥ 0, phân cách nghìn CÙNG ký tự (1.234.567) — '12.5' → null (không đoán). Khác Python
 * có chủ đích: > 2^53 → null (chặt hơn). */
export function intCell(raw: string | null | undefined): number | null {
  const s = pyStrip(raw ?? '');
  if (!INT_RE.test(s)) return null; // [0-9] ASCII = `isascii()` + `\d` của Python
  const n = Number(s.replaceAll('.', '').replaceAll(',', ''));
  return Number.isSafeInteger(n) ? n : null;
}

export type ResultRow = {
  row_no: number;
  ngay: Day;
  bien_the: number;
  hien_thi: number;
  click: number;
  chi_phi_vnd: number;
  don_hang: number;
};
export type PlanWindow = { creative_draft_ids: number[]; start_date: Day; end_date: Day };

/** CSV bytes (utf-8-sig) → [rows, lỗi, sha256 file]. Lỗi dạng 'dòng N cột X: lý do' — KHÔNG in giá
 * trị ô. Có lỗi → rows rỗng (chặn cả file). */
export function readResults(
  path: string,
  plan: PlanWindow,
): [ResultRow[], string[], string | null] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e) {
    return [[], [`không đọc được file (${pyOsName(e)})`], null];
  }
  const sha = createHash('sha256').update(raw).digest('hex');
  if (raw.length > MAX_CSV_BYTES) return [[], [`file quá lớn (> ${MAX_CSV_BYTES} byte)`], sha];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return [[], ['file không phải UTF-8'], sha];
  }
  const recs = csvRows(text);
  // Python `csv.Error` khi ô > field_size_limit — không traceback.
  if (recs.some((r) => r.some((c) => c.length > CSV_FIELD_LIMIT && cpLen(c) > CSV_FIELD_LIMIT))) {
    return [[], ['file CSV hỏng (ô quá lớn hoặc sai định dạng)'], sha];
  }
  const blank = (r: string[]) => !r.some((c) => pyStrip(c));
  while (recs.length && blank(recs[recs.length - 1] as string[])) recs.pop();
  if (!recs.length) return [[], ['file rỗng'], sha];
  const head = (recs[0] as string[]).map(pyStrip);
  const errs: string[] = [];
  for (const h of head) {
    if (!RESULT_COLS.includes(h)) {
      errs.push(`dòng 1 cột ${pyRepr(oneline(maskPii(h), 30))}: cột lạ — chặn cả file`);
    }
  }
  for (const c of RESULT_COLS) {
    if (head.filter((h) => h === c).length !== 1)
      errs.push(`dòng 1 cột ${c}: thiếu hoặc trùng cột`);
  }
  if (errs.length) return [[], errs, sha];
  if (recs.length - 1 > MAX_CSV_ROWS) return [[], [`quá ${MAX_CSV_ROWS} dòng dữ liệu`], sha];
  const ids = new Set(plan.creative_draft_ids);
  const rows: ResultRow[] = [];
  recs.slice(1).forEach((rec, k) => {
    const n = k + 2;
    if (blank(rec)) return;
    if (rec.length !== head.length) {
      errs.push(`dòng ${n}: số cột ${rec.length} ≠ ${head.length}`);
      return;
    }
    const cell = Object.fromEntries(head.map((h, i) => [h, rec[i] as string]));
    const row: Record<string, unknown> = { row_no: n };
    const bad: [string, string][] = [];
    const d = pyDate(pyStrip(cell.ngay as string));
    if (d === null) bad.push(['ngay', 'không phải ngày YYYY-MM-DD']);
    else if (!(plan.start_date <= d && d <= plan.end_date))
      bad.push(['ngay', 'ngoài thời gian phiếu']);
    row.ngay = d;
    for (const c of RESULT_COLS.slice(1)) {
      const v = intCell(cell[c]);
      if (v === null) bad.push([c, 'không phải số nguyên ≥ 0']);
      row[c] = v;
    }
    if (row.bien_the !== null && !ids.has(row.bien_the as number)) {
      bad.push(['bien_the', 'không thuộc creative_draft_ids của phiếu']);
    }
    if (
      row.click !== null &&
      row.hien_thi !== null &&
      (row.click as number) > (row.hien_thi as number)
    ) {
      bad.push(['click', 'click > hien_thi']);
    }
    for (const [c, why] of bad) errs.push(`dòng ${n} cột ${c}: ${why}`);
    if (!bad.length) rows.push(row as ResultRow);
  });
  if (!errs.length && !rows.length) errs.push('file không có dòng dữ liệu');
  return errs.length ? [[], errs, sha] : [rows, [], sha];
}

export type Agg = { hien_thi: number; click: number; chi_phi_vnd: number; don_hang: number };
export type Metrics = Agg & { ctr: Rat | null; cpc: Rat | null; cpa: Rat | null };
export type Eval = {
  tong: Metrics;
  bien_the: Map<number, Metrics>;
  stop_hits: Rule[];
  dat_muc_tieu: boolean;
  co: string[];
  de_xuat: (typeof DECISIONS)[number];
};
export type EvalPlan = PlanWindow & {
  budget_vnd: number;
  success_metric: Record<string, unknown>;
  stop_rules: Record<string, unknown>[];
};

const AGG_COLS = ['hien_thi', 'click', 'chi_phi_vnd', 'don_hang'] as const;
const ratio = (a: number, b: number): Rat | null => (b ? rat(a, b) : null);
const metrics = (a: Agg): Metrics => ({
  ...a,
  ctr: ratio(a.click, a.hien_thi),
  cpc: ratio(a.chi_phi_vnd, a.click),
  cpa: ratio(a.chi_phi_vnd, a.don_hang),
});

/** `Decimal(str(v))` của giá trị luật (chuỗi đã chuẩn hóa; số khi dòng DB ghi tay). */
function ruleRat(v: unknown): Rat {
  const d =
    typeof v === 'number' || v instanceof PyFloat
      ? decOf(v)
      : typeof v === 'string'
        ? decParse(v)
        : null;
  if (d === null) throw new RangeError('InvalidOperation');
  return decRat(d);
}

function metricRat(m: Metrics, metric: unknown): Rat | null {
  const v = (m as Record<string, unknown>)[metric as string];
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? rat(v) : (v as Rat);
}

function hit(m: Metrics, r: Record<string, unknown>, key: string): boolean {
  const v = metricRat(m, r.metric);
  if (v === null) return false;
  const c = cmpRat(v, ruleRat(r[key]));
  return r.op === '>=' ? c >= 0 : c <= 0;
}

/** THUẦN: tổng + theo biến thể + điều kiện dừng chạm + đề xuất ∈ DECISIONS (KHÔNG có nhánh nâng
 * ngân sách — muốn chi thêm = lập phiếu mới qua trần). */
export function evaluate(plan: EvalPlan, rows: ResultRow[]): Eval {
  const zero = (): Agg => ({ hien_thi: 0, click: 0, chi_phi_vnd: 0, don_hang: 0 });
  const tot = zero();
  const per = new Map(plan.creative_draft_ids.map((i) => [i, zero()]));
  for (const r of rows) {
    const p = per.get(r.bien_the);
    if (!p) throw new RangeError(`KeyError: ${r.bien_the}`);
    for (const c of AGG_COLS) {
      tot[c] += r[c];
      p[c] += r[c];
    }
  }
  const m = metrics(tot);
  const hits = plan.stop_rules.filter((r) => hit(m, r, 'value')) as Rule[];
  const flags: string[] = [];
  if (tot.chi_phi_vnd > plan.budget_vnd) flags.push(FLAG_OVER);
  else if (tot.chi_phi_vnd === plan.budget_vnd) flags.push(FLAG_SPENT);
  const dat = hit(m, plan.success_metric, 'target');
  const dx =
    hits.length || flags.length
      ? 'dung'
      : tot.hien_thi === 0
        ? 'chua_du_lieu'
        : dat
          ? 'dat_muc_tieu'
          : 'tiep';
  return {
    tong: m,
    bien_the: new Map([...per].map(([i, a]) => [i, metrics(a)])),
    stop_hits: hits,
    dat_muc_tieu: dat,
    co: flags,
    de_xuat: dx,
  };
}

// ---------------------------------------------------------------- payload

/** `_fmt`: ctr → % 2 chữ số (làm tròn Decimal mặc định HALF_EVEN), don_hang → số nguyên, còn lại → VND. */
export function fmtMetric(v: Rat | string | number | null, metric: unknown): string {
  if (v === null) return '—';
  const r = typeof v === 'object' ? v : ruleRat(v);
  if (metric === 'ctr') return `${decStr(quantize({ n: r.n * 100n, d: r.d }, -2, 'half_even'))}%`;
  if (metric === 'don_hang') return String(truncRat(r));
  const q = quantize(r, 0, 'half_even');
  return vnd(q.neg ? -q.c : q.c);
}

const ruleTxt = (r: Record<string, unknown>, key: string): string =>
  `${pyStr(r.metric)} ${pyStr(r.op)} ${fmtMetric(r[key] as string, r.metric)}`;

export type PlanRow = {
  id: number;
  plan_sha256: string;
  sku_key: string;
  channel: string;
  hypothesis: string;
  creative_draft_ids: number[];
  budget_vnd: number;
  cap_vnd: number;
  allocated_vnd: number;
  cap_ref_month: Day;
  start_date: Day;
  end_date: Day;
  success_metric: Record<string, unknown>;
  stop_rules: Record<string, unknown>[];
  readiness: string;
  created_by: string;
};

/** Payload markdown 2 mục hàng duyệt — dựng từ DÒNG DB (tất định). */
export function renderPlan(row: PlanRow): string {
  return [
    `# Phiếu thử nghiệm ads #${row.id} (NHÁP)`,
    '',
    `**${NOTE}**`,
    '',
    `- SKU: \`${row.sku_key}\` · kênh ads: ${row.channel} · readiness ${row.readiness}`,
    `- Giả thuyết: ${oneline(row.hypothesis, 500)}`,
    `- Biến thể creative (content_drafts đã duyệt): ${row.creative_draft_ids.map((i) => `#${i}`).join(', ')}`,
    `- Ngân sách đề xuất: ${vnd(row.budget_vnd)} (trần FP&A ${vnd(row.cap_vnd)} theo P&L tháng ${row.cap_ref_month.slice(5, 7)}/${row.cap_ref_month.slice(0, 4)} — cấu hình fpa_config GIẢ ĐỊNH; phiếu khác cùng SKU × kênh × tháng đã giữ ${vnd(row.allocated_vnd)} lúc lập)`,
    `- Thời gian: ${dmy(row.start_date)} → ${dmy(row.end_date)}`,
    `- Chỉ số thành công: ${ruleTxt(row.success_metric, 'target')}`,
    `- Điều kiện dừng (bất kỳ): ${row.stop_rules.map((r) => ruleTxt(r, 'value')).join('; ')}`,
    `- plan_sha256: \`${row.plan_sha256}\` · người lập: ${row.created_by}`,
    '',
    `Duyệt đủ 2 mục (marketing/ad_campaign + finance/budget_change cùng \`adtest-${row.id}\`) phiếu mới được cài.`,
    '',
  ].join('\n');
}

export function renderResult(
  row: { id: number; budget_vnd: number; success_metric: Record<string, unknown> },
  ev: Eval,
  fileSha: string,
  nRows: number,
): string {
  const t = ev.tong;
  const f = fmtMetric;
  const L = [
    `# Kết quả thử nghiệm ads — phiếu #${row.id} (NHÁP)`,
    '',
    `**${RES_NOTE}**`,
    '',
    `- Đề xuất: **${ev.de_xuat}**${ev.co.length ? ` — ${ev.co.join(', ')}` : ''}`,
    `- File kết quả sha256 \`${fileSha.slice(0, 12)}\` · ${nRows} dòng`,
    `- Tổng: hiển thị ${t.hien_thi}, click ${t.click}, chi ${vnd(t.chi_phi_vnd)} / ngân sách phiếu ${vnd(row.budget_vnd)}, đơn ${t.don_hang}`,
    `- CTR ${f(t.ctr, 'ctr')} · CPC ${f(t.cpc, 'cpc')} · CPA ${f(t.cpa, 'cpa')}`,
    `- Chỉ số thành công ${ruleTxt(row.success_metric, 'target')}: ${ev.dat_muc_tieu ? 'ĐẠT' : 'chưa đạt'}`,
    `- Điều kiện dừng chạm: ${ev.stop_hits.map((r) => ruleTxt(r, 'value')).join('; ') || '(không)'}`,
    '',
    '| Biến thể | Hiển thị | Click | Chi | Đơn | CTR | CPC | CPA |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [i, m] of ev.bien_the) {
    L.push(
      `| #${i} | ${m.hien_thi} | ${m.click} | ${vnd(m.chi_phi_vnd)} | ${m.don_hang} | ${f(m.ctr, 'ctr')} | ${f(m.cpc, 'cpc')} | ${f(m.cpa, 'cpa')} |`,
    );
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- docx vòng 2: agent TỰ đề xuất

export type ProposalCfg = {
  chot_boi: string;
  can_cu: string;
  ty_le_tran: number | PyFloat;
  so_ngay_chay: number;
  bat_dau_sau_ngay: number;
  success_metric: unknown;
  stop_rules: unknown;
};

/** `data/ads_proposal.json` → [cfg, null] | [null, lý do BLOCKED]. Thiếu/null/sai = chưa chốt. */
export function loadProposalCfg(path: string): [ProposalCfg, null] | [null, string] {
  const [doc, err] = readStrictJson(path);
  if (err !== null) return [null, `ads_proposal.json không đọc được (${err})`];
  const keys = isDict(doc) ? Object.keys(doc).filter((k) => k !== '_doc') : null;
  if (
    keys === null ||
    keys.length !== PROP_KEYS.length ||
    !PROP_KEYS.every((k) => keys.includes(k))
  ) {
    return [null, `ads_proposal.json cần đúng key ${pyTuple(PROP_KEYS)}`];
  }
  const d = doc as Record<string, unknown>;
  const miss = PROP_KEYS.filter((k) => d[k] === null);
  if (miss.length) return [null, `tham số đề xuất CHƯA CHỐT (GĐ Marketing): ${miss.join(', ')}`];
  const human = (v: unknown) => {
    if (typeof v !== 'string' || !pyStrip(v)) return false;
    const l = pyStrip(v).toLowerCase();
    return !l.startsWith('agent:') && !l.startsWith('system:');
  };
  if (!human(d.chot_boi) || !human(d.can_cu))
    return [null, 'chot_boi/can_cu phải là người + căn cứ'];
  const r = d.ty_le_tran;
  const rv = r instanceof PyFloat ? r.v : r;
  if (
    !(typeof r === 'number' || r instanceof PyFloat) ||
    !((rv as number) > 0 && (rv as number) <= 1)
  ) {
    return [null, 'ty_le_tran phải trong (0, 1]'];
  }
  const sn = d.so_ngay_chay;
  const bd = d.bat_dau_sau_ngay;
  if (!(isInt(sn) && sn >= 1 && sn <= MAX_DAYS + 1) || !(isInt(bd) && bd >= 0 && bd <= 30)) {
    return [null, 'so_ngay_chay 1..31, bat_dau_sau_ngay 0..30'];
  }
  return [d as ProposalCfg, null];
}

/** Python `f"{x:.0%}"`: x × 100 (số thực) làm tròn half-even trên giá trị nhị phân đúng. */
export function pct0(x: number): string {
  const v = x * 100;
  const f = Math.floor(v);
  const diff = v - f;
  const k = diff > 0.5 || (diff === 0.5 && f % 2 !== 0) ? f + 1 : f;
  return `${k}%`;
}

export type ProposalPlan = Record<string, unknown> & { budget_vnd: number };

/** Phiếu agent dựng từ ô FP&A DE_XUAT (THUẦN) → phiếu | null khi trần × tỷ lệ = 0đ. */
export function buildProposal(
  p: { sku_key: string; channel: string; budget_vnd: number },
  pcfg: ProposalCfg,
  month: Day,
  today: Day,
  ids: number[],
): ProposalPlan | null {
  const ty = pcfg.ty_le_tran;
  const share = decRat(decOf(ty));
  const budget = Number(truncRat({ n: BigInt(p.budget_vnd) * share.n, d: share.d }));
  if (budget <= 0) return null;
  const start = addDays(today, pcfg.bat_dau_sau_ngay);
  const tyNum = ty instanceof PyFloat ? ty.v : ty;
  return {
    sku_key: p.sku_key,
    channel: p.channel,
    hypothesis: `Đề xuất của agent (${PROPOSE_AGENT}): thử quảng cáo nhỏ ${p.sku_key} trên ${p.channel}, đo chi phí mỗi đơn. Nguồn: trần FP&A tháng ${month.slice(0, 7)} ${vnd(p.budget_vnd)}, ngân sách ${pct0(tyNum)} trần theo ads_proposal.json (chốt bởi ${pcfg.chot_boi}); creative đã duyệt ${ids.map((i) => `#${i}`).join(', ')}.`,
    creative_draft_ids: ids,
    budget_vnd: budget,
    start_date: start,
    end_date: addDays(start, pcfg.so_ngay_chay - 1),
    success_metric: pcfg.success_metric,
    stop_rules: pcfg.stop_rules,
  };
}
