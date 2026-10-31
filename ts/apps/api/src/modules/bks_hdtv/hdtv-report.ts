import { basename } from 'node:path';
import { type Db, dep } from '@samsam/core/ops/deps';
import { periodBounds, vnDate, vnFormat } from '@samsam/core/ops/period';
import { isPlainObject, JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { oneline } from '@samsam/core/ops/store';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { rowsOf, sp } from '@samsam/core/rollout/counters';
import { loadUsers } from '@samsam/core/security/auth';
import { maskPii } from '@samsam/core/security/pii';
import { cpHead, pyStr, pyStrip } from '@samsam/core/security/py';
import { section as decisionsSection } from '../ceo_misc/ceo-decisions.js';
import { section as riskSection } from '../ceo_misc/ceo-risk.js';
import {
  cell,
  build as ceoBuild,
  fmtDelta,
  fmtValue,
  type Rep,
  type RepRow,
  type Snap,
} from '../ceo_report/ceo-report.js';
import { loadMetrics } from '../ceo_report/cockpit.js';
import { add, type Dec, dec } from '../ceo_report/dec.js';
import { monthBounds, vnd } from '../fin_ar_pnl/fin-common.js';
import { DRAFT_HEAD, compute as pnlCompute } from '../fin_ar_pnl/fp-pnl.js';
import {
  loadCfg as opsLoadCfg,
  pct as opsPct,
  summary as opsSummary,
} from '../fin_cash/fp-opscost.js';
import { safe } from '../ra_kenh/ra-kenh.js';
import { checkOverrides, findingLine, LIMIT_NOTE, overrideLine, pyErrType } from './bks-audit.js';

// Port `agents/hdtv_report.py` (v10.0 W100.6, WP16 — ceo-05) — gói báo cáo HĐTV tháng/quý (Agent
// Điều hành, khối `ceo`): markdown, MỌI số do code điền + có nguồn.
//  - Kỳ `YYYY-MM` | `YYYY-Qn` (quý = 3 tháng liên tiếp); mỗi tháng cắt theo giờ VN. Kỳ chưa đóng →
//    RangeError (ValueError) → exit 2.
//  - 7 mục cố định, mỗi mục đọc trong savepoint (lỗi → 1 dòng "*(không đọc được: …)*", mục khác vẫn
//    ra): Chỉ số cockpit (quý: 3 cột tháng + cột quý theo `data/hdtv_report.json` `quarter_agg`
//    {metric: sum|last} — `sum` thiếu ≥1 tháng / `last` thiếu tháng cuối → `[chưa đủ dữ liệu]`, KHÔNG
//    cộng thiếu); Tiến độ & Sổ quyết định; Rủi ro pháp lý mở; Chi so ngân sách vận hành; P&L tóm tắt
//    (BẢN NHÁP); Ép trình QA (override_qa); Kiểm soát BKS (chưa chạy → "chưa chạy — không kiểm chứng
//    được", KHÔNG "không vi phạm").
//  - GROUNDING: số chỉ vào trang qua `Pack.fact(text, source)` (hoặc `Pack.lines` đăng ký nguyên dòng
//    section tái dùng). `render` quét mọi token số — token không thuộc fact nào (trừ ngày/giờ, nhãn kỳ,
//    `#id`) → `UngroundedNumber` (fail-closed, KHÔNG ghi trang).
//  - Toàn trang qua guardrail; không ok → dòng CẢNH BÁO đầu trang + chặn `--submit`. Nguồn `sample:`
//    / file `*_MAU` → `(MẪU)`. Không LLM, không mạng.

export const CONFIG_FILE = dataPath('hdtv_report.json');
export const RUN_BY = 'agent:hdtv_report';
export const OBJECT_TYPE = 'hdtv_pack';
export const FEATURE = 'ceo-05'; // v14.3 cổng giai đoạn (HĐ 6.7)
export const NO_DATA = '[chưa có dữ liệu]';
export const NOT_ENOUGH = '[chưa đủ dữ liệu]';
export const NOT_RUN = 'chưa chạy — không kiểm chứng được';
export const AGGS = ['sum', 'last'];
export const BKS_KINDS: readonly (readonly [string, string])[] = [
  ['inside_out', 'Audit inside-out'],
  ['recon', 'Đối soát độc lập'],
];
export const SECTION_HEADS = [
  '## Chỉ số cockpit',
  '## Tiến độ & Sổ quyết định',
  '## Rủi ro pháp lý mở',
  '## Chi so ngân sách vận hành',
  '## P&L tóm tắt',
  '## Ép trình QA (override_qa)',
  '## Kiểm soát BKS',
] as const;
const PERIOD_RE = /^([0-9]{4})-(?:(0[1-9]|1[0-2])|Q([1-4]))$/;
const METRIC_RE = /^[a-z][a-z0-9_.]{1,63}$/;
// Python `\d` Unicode (Nd), `\b` theo `\w` Unicode.
const D = '\\p{Nd}';
const W = '[\\p{L}\\p{N}_]';
const NUM_SRC = `${D}[${D}.,]*`;
const numRe = (): RegExp => new RegExp(NUM_SRC, 'gu');
// Token số được phép KHÔNG cần fact: ngày/giờ, nhãn kỳ, #id nội bộ.
const ALLOWED_RE = new RegExp(
  `${D}{2}/${D}{2}/${D}{4}|${D}{4}-${D}{2}-${D}{2}|(?<!${W})${D}{2}:${D}{2}(?!${W})|(?<!${W})${D}{4}-(?:Q[1-4]|${D}{2})(?!${W})|#${D}+`,
  'gu',
);
const DAY_MS = 86_400_000;

/** data/hdtv_report.json thiếu/hỏng. */
export class ConfigError extends RangeError {
  override name = 'ConfigError';
}

/** Số trên trang không có fact/nguồn — fail-closed. */
export class UngroundedNumber extends RangeError {
  override name = 'UngroundedNumber';
}

// ------------------------------------------------------------------ thuần

export type Period = {
  label: string;
  kind: 'month' | 'quarter';
  /** Ngày 1 mỗi tháng 'YYYY-MM-01'. */
  months: string[];
  start: Date;
  end: Date;
};

/** 'YYYY-MM' | 'YYYY-Qn' → kỳ. Sai dạng / kỳ chưa đóng (end > now, giờ VN) → RangeError. */
export function parsePeriod(s: unknown, now?: Date | null): Period {
  const m = typeof s === 'string' ? PERIOD_RE.exec(s) : null;
  if (m === null) throw new RangeError('kỳ phải dạng YYYY-MM hoặc YYYY-Qn (n = 1..4)');
  const y = Number(m[1]);
  if (y < 1) throw new RangeError(`year ${y} is out of range`);
  const ym = (mo: number) => `${m[1]}-${String(mo).padStart(2, '0')}-01`;
  const months = m[2] ? [ym(Number(m[2]))] : [0, 1, 2].map((i) => ym(3 * Number(m[3]) - 2 + i));
  const start = periodBounds('month', months[0] as string)[0];
  const end = periodBounds('month', months[months.length - 1] as string)[1];
  const n = now ?? new Date();
  if (end.getTime() > n.getTime()) {
    throw new RangeError(
      `kỳ ${s} chưa đóng (hết ${vnDate(new Date(end.getTime() - DAY_MS))} giờ VN)`,
    );
  }
  return { label: s as string, kind: m[2] ? 'month' : 'quarter', months, start, end };
}

export type HdtvConfig = { quarter_agg: Record<string, string> };

/** `data/hdtv_report.json` → cấu hình đã kiểm; thiếu/hỏng → ConfigError (exit 1 trước connect).
 * TS chặt hơn: NaN/Infinity trong JSON → JSONDecodeError (Python `json.loads` nhận). */
export function loadConfig(path: string = CONFIG_FILE): HdtvConfig {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    throw new ConfigError(`không đọc được ${name}: ${e.pyType}`);
  }
  const agg = isPlainObject(raw) ? raw.quarter_agg : undefined;
  if (!isPlainObject(agg)) throw new ConfigError(`${name}: thiếu object quarter_agg`);
  for (const [k, v] of Object.entries(agg)) {
    if (!METRIC_RE.test(k) || !(typeof v === 'string' && AGGS.includes(v))) {
      throw new ConfigError(
        `${name}: quarter_agg mục sai ('${oneline(safe(k), 40)}' phải sum|last)`,
      );
    }
  }
  return { quarter_agg: { ...(agg as Record<string, string>) } };
}

/** 3 giá trị tháng (null = thiếu) → [giá trị | null, nhãn]. `sum` cần đủ; `last` cần tháng cuối;
 * không khai → '—'. */
export function quarterValue(
  agg: string | null | undefined,
  vals: readonly (Dec | null)[],
): [Dec | null, string | null] {
  if (agg === null || agg === undefined) return [null, '—'];
  if (agg === 'sum') {
    if (vals.some((v) => v === null)) return [null, NOT_ENOUGH];
    return [vals.reduce<Dec>((a, v) => add(a, v as Dec), dec(0)), null];
  }
  const last = vals[vals.length - 1] ?? null;
  if (last === null) return [null, NOT_ENOUGH];
  return [last, null];
}

const rstripDots = (t: string): string => t.replace(/[.,]+$/u, '');

/** Token số trên văn bản (bỏ ngày/giờ/nhãn kỳ/#id). */
export function numTokens(text: string): Set<string> {
  const t = text.replace(ALLOWED_RE, ' ');
  return new Set([...t.matchAll(numRe())].map((m) => rstripDots(m[0])));
}

export type Fact = { text: string; source: string };
export type PackInit = Period & { config: HdtvConfig; generatedAt: Date };

/** Gói + `fact()` đăng ký số kèm nguồn. */
export class Pack {
  readonly label: string;
  readonly kind: 'month' | 'quarter';
  readonly months: string[];
  readonly start: Date;
  readonly end: Date;
  readonly config: HdtvConfig;
  readonly generatedAt: Date;
  facts: Fact[] = [];
  sections: string[][] = [];
  sample = false;
  key: Record<string, unknown> = {};
  guardrailViolations: string[] = [];
  unreadable = 0;

  constructor(p: PackInit) {
    this.label = p.label;
    this.kind = p.kind;
    this.months = p.months;
    this.start = p.start;
    this.end = p.end;
    this.config = p.config;
    this.generatedAt = p.generatedAt;
  }

  fact(text: unknown, source: unknown): string {
    const t = typeof text === 'bigint' ? String(text) : pyStr(text);
    if (!source || !pyStrip(String(source))) throw new UngroundedNumber('fact thiếu nguồn');
    this.facts.push({ text: t, source: String(source) });
    return t;
  }

  /** Dòng section tái dùng (code dựng) → đăng ký dòng có chữ số. */
  lines(lines: readonly unknown[], source: string): string[] {
    const out = lines.map((x) => pyStr(x));
    for (const x of out)
      if (new RegExp(NUM_SRC, 'u').test(x.replace(ALLOWED_RE, ' '))) this.fact(x, source);
    return out;
  }
}

// ------------------------------------------------------------------ mục

const mlabel = (m: string): string => m.slice(0, 7);

function snapSrc(snap: Snap): [string, boolean] {
  const ref = snap.source_ref ? String(snap.source_ref) : '—';
  return [`${snap.source} · ${cell(ref)}`, ref.startsWith('sample:')];
}

/** Tên + mã chỉ số (mã có thể chứa chữ số, vd `p90`) — nguồn từ điển. */
function mname(pack: Pack, r: { name: string; metric_id: string }): string {
  return pack.lines(
    [`${r.name} (${r.metric_id})`],
    'fn:pipelines.cockpit.load_metrics (data/metrics.json)',
  )[0] as string;
}

const row = (cells: readonly string[]): string => `| ${cells.map((x) => cell(x)).join(' | ')} |`;

export type SectionFn = (db: Db, pack: Pack, now: Date) => Promise<string[]>;

export async function secCockpit(db: Db, pack: Pack, now: Date): Promise<string[]> {
  const metrics = loadMetrics();
  const agg = pack.config.quarter_agg;
  const reps: Rep[] = [];
  for (const m of pack.months) reps.push(await ceoBuild(db, 'month', m, { now, metrics }));
  const keys: string[] = [];
  const rows = new Map<string, { row: RepRow; vals: (Snap | null)[] }>();
  reps.forEach((rep, i) => {
    for (const r of rep.rows) {
      if (r.per_agent) continue;
      const k = `${r.metric_id}\u0000${r.channel}`;
      if (!rows.has(k)) {
        keys.push(k);
        rows.set(k, { row: r, vals: reps.map(() => null) });
      }
      (rows.get(k) as { vals: (Snap | null)[] }).vals[i] = r.cur;
    }
  });
  const L: string[] = [SECTION_HEADS[0], ''];
  const srcFn = 'fn:agents.ceo_report.build';
  if (pack.kind === 'month') {
    L.push('| Chỉ số | Kênh | Kỳ này | Kỳ trước | Δ | Nguồn |', '|---|---|---|---|---|---|');
    for (const k of keys) {
      const r = (rows.get(k) as { row: RepRow }).row;
      const c = r.cur;
      const p = r.prev;
      const src = `db:channel_snapshots ${r.metric_id}/${r.channel}`;
      const cur = c ? pack.fact(fmtValue(c.value, r.unit), src) : NO_DATA;
      const prev = p ? pack.fact(fmtValue(p.value, r.unit), src) : NO_DATA;
      const dl = c && p ? pack.fact(fmtDelta(c.value, p.value, r.unit), srcFn) : '—';
      const sn = c ?? p;
      let srcs = '—';
      if (sn) {
        const [s, sample] = snapSrc(sn);
        pack.sample = pack.sample || sample;
        srcs = pack.fact(s + (sample ? ' (MẪU)' : ''), src);
      }
      L.push(row([mname(pack, r), r.channel, cur, prev, dl, srcs]));
    }
    return L;
  }
  const heads = pack.months.map(mlabel);
  L.push(
    `| Chỉ số | Kênh | ${heads.join(' | ')} | Quý | Cách gộp |`,
    `|---|---|${'---|'.repeat(heads.length)}---|---|`,
  );
  for (const k of keys) {
    const { row: r, vals } = rows.get(k) as { row: RepRow; vals: (Snap | null)[] };
    const src = `db:channel_snapshots ${r.metric_id}/${r.channel}`;
    const cells: string[] = [];
    for (const v of vals) {
      if (v === null) {
        cells.push(NO_DATA);
        continue;
      }
      pack.sample = pack.sample || snapSrc(v)[1];
      cells.push(pack.fact(fmtValue(v.value, r.unit), src));
    }
    const how = Object.hasOwn(agg, r.metric_id) ? (agg[r.metric_id] as string) : null;
    const [qv, why] = quarterValue(
      how,
      vals.map((v) => (v === null ? null : v.value)),
    );
    const qcell =
      qv === null
        ? (why as string)
        : pack.fact(fmtValue(qv, r.unit), `fn:agents.hdtv_report.quarter_value (${how}) ${src}`);
    L.push(row([mname(pack, r), r.channel, ...cells, qcell, how || 'không khai']));
  }
  return L;
}

/** Section nhóm ceo_misc (`ceo_decisions.section` / `ceo_risk.section`) — test thay được. */
export type HdtvDeps = {
  decisions: (db: Db, lastDay: string) => Promise<readonly string[]>;
  risk: (db: Db, asOf: Date) => Promise<readonly string[]>;
};
const DEFAULT_DEPS: HdtvDeps = { decisions: decisionsSection, risk: riskSection };

export function secDecisions(deps: HdtvDeps): SectionFn {
  return async (db, pack) => {
    const last = vnDate(new Date(pack.end.getTime() - DAY_MS));
    return pack.lines(await deps.decisions(db, last), 'fn:agents.ceo_decisions.section');
  };
}

export function secRisk(deps: HdtvDeps): SectionFn {
  return async (db, pack, now) => {
    const asOf = new Date(Math.min(pack.end.getTime() - 1000, now.getTime()));
    return pack.lines(await deps.risk(db, asOf), 'fn:agents.ceo_risk.section');
  };
}

export async function secOpscost(db: Db, pack: Pack): Promise<string[]> {
  const [cfg, why] = opsLoadCfg();
  if (cfg === null) throw new RangeError(`data/fpa_config.json: ${why}`);
  const users = loadUsers();
  const budget = cfg.budget_vnd;
  const srcCfg = 'fn:agents.fp_opscost.load_cfg (data/fpa_config.json)';
  const L: string[] = [
    SECTION_HEADS[3],
    '',
    '| Tháng | Phạm vi | Thực chi | Trần | % trần |',
    '|---|---|---|---|---|',
  ];
  const tail: string[] = [];
  for (const m of pack.months) {
    const s = await opsSummary(db, m, cfg, users);
    const acts = s.actuals;
    const src = `fn:agents.fp_opscost.summary ${mlabel(m)}`;
    const scopes = new Set([
      ...Object.keys(budget),
      ...Object.entries(acts)
        .filter(([, v]) => v)
        .map(([k]) => k),
    ]);
    for (const scope of [...scopes].sort(cpCmp)) {
      const b = Object.hasOwn(budget, scope) ? (budget[scope] as number) : null;
      if (!s.co_nguon.has(scope)) {
        // r12 G1-L3: 0 dòng nguồn chi → không hiện "0đ / 0.0%".
        L.push(
          `| ${mlabel(m)} | \`${scope}\` | ${NO_DATA} | ` +
            (b ? `${pack.fact(vnd(b), srcCfg)} | ${NO_DATA} |` : 'chưa có trần | — |'),
        );
        continue;
      }
      const spent = acts[scope] ?? 0;
      L.push(
        `| ${mlabel(m)} | \`${scope}\` | ${pack.fact(vnd(spent), src)} | ` +
          (b
            ? `${pack.fact(vnd(b), srcCfg)} | ${pack.fact(opsPct(spent, b), src)} |`
            : 'chưa có trần | — |'),
      );
    }
    const wait = s.over.filter(([, st]) => st === 'cho_tgd_ky').length;
    tail.push(
      `- ${mlabel(m)}: cảnh báo trần ${pack.fact(s.alerts.length, src)} · khoản vượt ngưỡng X ${pack.fact(s.over.length, src)} (chờ TGĐ ký ${pack.fact(wait, src)})`,
    );
  }
  return [
    ...L,
    '',
    ...tail,
    '',
    '*Trần + ngưỡng X: `data/fpa_config.json` (GIẢ ĐỊNH — chờ GĐ tài chính chốt). Agent chỉ báo, không chi/không tắt key.*',
  ];
}

export const MAU_SQL =
  "select coalesce(bool_or(file_name like '%%\\_MAU%%'), false) from settlement_rows where settled_on >= %s and settled_on < %s";

export async function secPnl(db: Db, pack: Pack): Promise<string[]> {
  const L: string[] = [
    SECTION_HEADS[4],
    '',
    `**${DRAFT_HEAD}.**`,
    '',
    '| Tháng | Kênh | Doanh thu | Thực nhận | Lãi gộp (ô đủ giá vốn) |',
    '|---|---|---|---|---|',
  ];
  let totals = 0;
  let complete = true;
  for (const m of pack.months) {
    const res = await pnlCompute(db, m);
    const [start, end] = monthBounds(m);
    const mau = Boolean((await rowsOf(db, MAU_SQL, [start, end]))[0]?.[0]);
    pack.sample = pack.sample || mau;
    const src = `fn:agents.fp_pnl.compute ${mlabel(m)}`;
    if (!res.n_rows) {
      complete = false;
      L.push(`| ${mlabel(m)} | — | ${NO_DATA} | ${NO_DATA} | — |`);
      continue;
    }
    totals += res.tong_thuc_nhan;
    const by = new Map<string, [number, number, number | null]>();
    for (const c of res.cells) {
      const t = by.get(c.channel) ?? [0, 0, null];
      t[0] += c.doanh_thu ?? 0;
      t[1] += c.thuc_nhan;
      if (c.lai_gop !== null) t[2] = (t[2] ?? 0) + c.lai_gop; // ô thiếu giá vốn: không cộng
      by.set(c.channel, t);
    }
    for (const [ch, [dt, tn, lg]] of [...by.entries()].sort((x, y) => cpCmp(x[0], y[0]))) {
      L.push(
        `| ${mlabel(m)} | ${ch}${mau ? ' (MẪU)' : ''} | ${pack.fact(vnd(dt), src)} | ${pack.fact(vnd(tn), src)} | ` +
          (lg === null ? '—' : pack.fact(vnd(lg), src)) +
          ' |',
      );
    }
    if (res.loai.length) {
      L.push(
        `| ${mlabel(m)} | (ô thiếu giá vốn duyệt) | ${pack.fact(res.loai.length, src)} SKU | | |`,
      );
    }
  }
  const tot = complete
    ? pack.fact(vnd(totals), 'db:settlement_rows Σ payout_vnd (fn:agents.fp_pnl.compute)')
    : NOT_ENOUGH;
  pack.key.tong_thuc_nhan = complete ? totals : null;
  return [...L, '', `Tổng thực nhận quyết toán kỳ: ${tot}`];
}

export async function secOverrides(db: Db, pack: Pack): Promise<string[]> {
  const res = await checkOverrides(db, pack.start, pack.end);
  const ovr = res.overrides;
  pack.key.override_qa = ovr.length;
  const src = 'db:decisions kind override_qa (fn:agents.bks_audit.';
  const L: string[] = [
    SECTION_HEADS[5],
    '',
    `Số lần ép trình bản QA FAIL trong kỳ: ${pack.fact(ovr.length, `${src}check_overrides)`)}`,
    '',
  ];
  L.push(
    ...(ovr.length
      ? ovr.map((o) => pack.lines([overrideLine(o)], `db:decisions#${o.id}`)[0] as string)
      : ['- (không có)']),
  );
  const bad = res.findings.filter((f) => f.code !== 'can_cu_sai');
  if (bad.length) {
    L.push('', 'Bất thường:');
    L.push(...pack.lines(bad.map(findingLine), 'fn:agents.bks_audit.check_overrides'));
  }
  return L;
}

export const RUNS_SQL =
  'select distinct on (kind) kind, id, created_at, findings, report_sha256, period_label from audit_runs where kind = any(%s) and created_at >= %s order by kind, id desc';

export async function secBks(db: Db, pack: Pack): Promise<string[]> {
  const runs = new Map<string, unknown[]>();
  for (const r of await rowsOf(db, RUNS_SQL, [BKS_KINDS.map(([k]) => k), pack.start])) {
    runs.set(String(r[0]), r);
  }
  const L: string[] = [SECTION_HEADS[6], ''];
  for (const [kind, name] of BKS_KINDS) {
    const r = runs.get(kind);
    if (r === undefined) {
      L.push(`- ${name}: ${NOT_RUN}`);
      continue;
    }
    const [, rid, ts, n, sha, lbl] = r;
    const src = `audit_runs#${rid}`;
    L.push(
      `- ${name}: chạy ${vnFormat(ts as Date, '%d/%m/%Y')} (kỳ ${cell(lbl)}) · ${pack.fact(n, src)} phát hiện · mã băm báo cáo ${pack.fact(String(sha).slice(0, 12), src)} (audit_runs #${rid})`,
    );
  }
  return [...L, '', `*${LIMIT_NOTE}*`];
}

/** 7 mục theo thứ tự `SECTION_HEADS` + tên hàm Python (dòng "không đọc được"). */
export function sections(deps: HdtvDeps = DEFAULT_DEPS): [string, SectionFn][] {
  return [
    ['sec_cockpit', secCockpit],
    ['sec_decisions', secDecisions(deps)],
    ['sec_risk', secRisk(deps)],
    ['sec_opscost', secOpscost],
    ['sec_pnl', secPnl],
    ['sec_overrides', secOverrides],
    ['sec_bks', secBks],
  ];
}

export type BuildOpts = {
  cfg?: HdtvConfig | null;
  deps?: HdtvDeps;
  /** Thay danh sách mục (test đột biến). */
  sections?: [string, SectionFn][];
};

/** → Pack. Kỳ sai/chưa đóng → RangeError. Mỗi mục trong savepoint: lỗi → 1 dòng "không đọc được"
 * (fact của mục hỏng không tính), mục khác vẫn ra. */
export async function build(db: Db, period: string, now: Date, o: BuildOpts = {}): Promise<Pack> {
  const per = parsePeriod(period, now);
  const pack = new Pack({ ...per, config: o.cfg ?? loadConfig(), generatedAt: now });
  const secs = o.sections ?? sections(o.deps);
  for (let i = 0; i < SECTION_HEADS.length; i++) {
    const [fname, fn] = secs[i] as [string, SectionFn];
    const nFacts = pack.facts.length;
    try {
      pack.sections.push(await sp(db, () => fn(db, pack, now)));
    } catch (e) {
      pack.facts.length = nFacts; // fact của mục hỏng không tính
      const w0 = isDbError(e) ? dbMsg(e) : String((e as Error)?.message ?? e);
      const why = cpHead(cell(maskPii(safe(`${pyErrType(e)}: ${w0}`))), 160);
      pack.unreadable += 1;
      pack.sections.push([
        SECTION_HEADS[i] as string,
        '',
        pack.lines([`*(không đọc được: ${why})*`], `fn:agents.hdtv_report.${fname}`)[0] as string,
      ]);
    }
  }
  return pack;
}

// ------------------------------------------------------------------ render

/** Token số trên trang KHÔNG thuộc fact nào có nguồn → danh sách (sắp theo code point). */
export function checkGrounded(text: string, facts: readonly Fact[]): string[] {
  const known = new Set<string>();
  for (const f of facts) {
    if (!pyStrip(String(f.source ?? ''))) continue;
    for (const t of numTokens(f.text)) known.add(t);
    for (const m of f.text.matchAll(numRe())) known.add(rstripDots(m[0]));
  }
  return [...numTokens(text)].filter((t) => !known.has(t)).sort(cpCmp);
}

/** Pack → markdown. Số không có fact → UngroundedNumber (fail-closed). */
export function render(pack: Pack): string {
  const kindVi = pack.kind === 'month' ? 'tháng' : 'quý';
  const last = new Date(pack.end.getTime() - DAY_MS);
  const mau = pack.sample ? ' (MẪU)' : '';
  const L = [`# Gói báo cáo HĐTV — ${kindVi} ${pack.label}${mau}`, ''];
  if (pack.guardrailViolations.length) {
    L.push(
      `> **CẢNH BÁO GUARDRAIL — trang có vi phạm (${pack.guardrailViolations.join(', ')}), KHÔNG nộp duyệt cho tới khi sửa.**`,
      '',
    );
  }
  L.push(
    `**Kỳ:** ${vnFormat(pack.start, '%d/%m/%Y')} → ${vnFormat(last, '%d/%m/%Y')} (giờ VN) · **Sinh lúc:** ${vnFormat(pack.generatedAt, '%d/%m/%Y %H:%M')} giờ VN`,
    '',
    'Mọi con số do code điền từ DB/cấu hình và có nguồn (danh sách fact đi kèm bản dựng); thiếu số hiện `[chưa có dữ liệu]`, không hiện số không. Dòng *(MẪU)* là số liệu mẫu, không phải số vận hành thật.',
  );
  for (const sec of pack.sections) L.push('', ...sec);
  L.push(
    '',
    '---',
    '*BẢN NHÁP — chờ TGĐ duyệt rồi trình HĐTV; chữ ký HĐTV/BKS là external-dep. Hệ thống KHÔNG tự duyệt, KHÔNG tự gửi. Sinh bởi `python -m agents.hdtv_report`.*',
    '',
  );
  const text = L.join('\n');
  const bad = checkGrounded(text, pack.facts);
  if (bad.length) {
    throw new UngroundedNumber(`số không có nguồn trên trang: ${bad.slice(0, 10).join(', ')}`);
  }
  return text;
}

/** → [trang, guardrail ok]. Không ok → render lại có dòng CẢNH BÁO đầu trang (vẫn ghi file). */
export function finalize(pack: Pack): [string, boolean] {
  const text = render(pack);
  const g = dep('guardrailCheck')(text);
  if (g.ok) return [text, true];
  const viols = Array.isArray(g.violations) ? g.violations : [];
  const kinds = [
    ...new Set(
      viols
        .filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
        .map((v) => pyStr((v as Record<string, unknown>).type)),
    ),
  ].sort(cpCmp);
  pack.guardrailViolations = kinds.length ? kinds : ['?'];
  return [render(pack), false];
}
