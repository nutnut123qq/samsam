import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import { vnDate, vnFormat } from '@samsam/core/ops/period';
import { JsonFileError, readJson } from '@samsam/core/ops/py';
import { isDict, isPyInt, PyReadError, parsePyJson, readUtf8Sig } from '@samsam/core/ops/py-json';
import { loadRouting } from '@samsam/core/ops/red-alert';
import { dataPath, REPO_ROOT } from '@samsam/core/paths';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, pyReprValue, pyStr, pyStrip, pyTruthy } from '@samsam/core/security/py';
import { type Dossier, GOLDEN_FILE, readGolden, tpbvskSkus, validCap } from '../legal_hr/xnqc.js';
import { pageSafe, loadConfig as phapCheConfig, safe } from '../ra_kenh/ra-kenh.js';
import { cpCmp, dayDiff, dd, isoDate, tupleCmp } from './common.js';

// v8.1 W81.3 (WP10) — port `agents/ceo_risk.py`: Agent Sổ rủi ro pháp lý mở (cockpit TGĐ, ceo-03).
//  - CHỈ ĐỌC tracker của Pháp chế (không bảng mới, không nhập tay song song — tính lại mỗi lần):
//    hồ sơ `xnqc_dossiers` + SKU TPBVSK golden, bài kênh vi phạm đang mở `channel_posts`, cảnh báo
//    đỏ gốc chưa xác nhận `red_alerts`/`red_alert_acks`, DPIA (`data/sim_config.json` `dpia_signed`
//    + tổng `gaps` của `data/data_flow_map.json`), tuyến cảnh báo đỏ (chỉ đếm người nhận).
//  - `collect(db, asOf)` AS-OF: bài vi phạm mở tại `asOf` = dòng mới nhất theo URL trong các dòng
//    `scanned_at <= asOf` còn mức và chưa đóng trước `asOf`; cảnh báo gốc `ts <= asOf` chưa có ack
//    `<= asOf` (bản leo thang KHÔNG tính). GIỚI HẠN: hồ sơ XNQC chưa có lịch sử trạng thái → as-of
//    chỉ lọc theo ngày tạo, trạng thái là hiện tại.
//  - `rank(facts, now, cfg)` THUẦN, TẤT ĐỊNH: mức `do|vang|xanh` theo `data/ceo_risk.json` (BẢN DEV
//    SOẠN chờ Pháp chế duyệt) + hạn đợt 2/ngưỡng giấy của `data/phap_che.json`. Mã SKU TPBVSK chưa
//    nộp là `XNQC-CHO-NOP:<sku>` — KHÔNG dùng chữ không dấu "CHUA" (guardrail gập dấu = "chữa").
//  - Owner là VAI TRÒ (không tên người); không chép text bài. Agent KHÔNG tư vấn pháp lý, KHÔNG đổi
//    mức thay Pháp chế. Không mạng, không LLM.

export const CONFIG = dataPath('ceo_risk.json');
export const SIM_CONFIG = dataPath('sim_config.json');
export const FLOW_MAP = dataPath('data_flow_map.json');
export const GUARDRAIL_RULES = dataPath('guardrail_rules.json');
export const LEVELS: Record<string, number> = { do: 0, vang: 1, xanh: 2 };
export const LEVEL_VI: Record<string, string> = { do: 'ĐỎ', vang: 'VÀNG', xanh: 'XANH' };
export const SHOW = 8;
export const WEEK_MS = 7 * 86_400_000;
export const OWNER = 'phap_che';
export const REPORT_PREFIX = 'ceo-risk-';
const POSTS_SQL =
  'select url, channel, severity, due_at from (select distinct on (url) url, channel, severity, due_at, closed_at from channel_posts where scanned_at <= $1 order by url, id desc) p where severity is not null and (closed_at is null or closed_at > $1) order by url';
const ALERTS_SQL =
  "select r.id::text as id from red_alerts r where not (r.detail ? 'escalation_of') and r.ts <= $1 and not exists (select 1 from red_alert_acks a where a.alert_id = r.id and a.acked_at <= $1) order by r.id";
const DOSSIER_SQL =
  'select id::text as id, sku_key, status, ngay_nop::text as ngay_nop, ngay_cap::text as ngay_cap, ngay_het_han::text as ngay_het_han from xnqc_dossiers where created_at <= $1 order by sku_key, id';

// ------------------------------------------------------------------ cấu hình

/** data/ceo_risk.json thiếu/hỏng — fail-closed (Python ConfigError ⊂ ValueError). */
export class ConfigError extends RangeError {}

export type RiskCfg = {
  xnqc_phi_moc: string;
  xnqc_phi_text: string;
  xnqc_phi_nguon_url: string;
  nhac_moc_ngay: number[];
  do_khi_con_ngay: number;
  dot2_han_nop: string;
  het_han_canh_bao_ngay: number;
};

/** data/ceo_risk.json (+ hạn đợt 2/ngưỡng giấy từ data/phap_che.json) → cấu hình đã kiểm.
 * Thiếu/hỏng/`{}`/chỉ `_doc`/ngày sai/list rỗng/số thực → RangeError (fail-closed). */
export function loadConfig(path: string = CONFIG, phapChe: string | null = null): RiskCfg {
  const name = basename(path);
  let doc: unknown;
  try {
    doc = parsePyJson(readUtf8Sig(path));
  } catch (e) {
    const t = e instanceof PyReadError ? e.pyType : 'JSONDecodeError';
    if (t === 'FileNotFoundError') throw new RangeError(`không có file ${name}`);
    throw new RangeError(`${name} hỏng: ${t}`);
  }
  if (!isDict(doc)) throw new ConfigError(`${name}: không phải object JSON`);
  const cfg = { xnqc_phi_moc: isoDate(doc.xnqc_phi_moc, 'xnqc_phi_moc') } as RiskCfg;
  for (const k of ['xnqc_phi_text', 'xnqc_phi_nguon_url'] as const) {
    const v = doc[k];
    if (typeof v !== 'string' || !pyStrip(v)) throw new RangeError(`${k}: cần chuỗi không rỗng`);
    cfg[k] = pyStrip(v);
  }
  if (
    !cfg.xnqc_phi_nguon_url.startsWith('https://') &&
    !cfg.xnqc_phi_nguon_url.startsWith('http://')
  ) {
    throw new RangeError('xnqc_phi_nguon_url: cần URL http(s)');
  }
  const marks = doc.nhac_moc_ngay;
  if (!Array.isArray(marks) || !marks.length || !marks.every((m) => isPyInt(m) && m > 0)) {
    throw new RangeError('nhac_moc_ngay: cần list số nguyên > 0 không rỗng');
  }
  cfg.nhac_moc_ngay = [...new Set(marks as number[])].sort((a, b) => b - a);
  const v = doc.do_khi_con_ngay;
  if (!isPyInt(v) || v < 0) throw new RangeError('do_khi_con_ngay: cần số nguyên ≥ 0');
  cfg.do_khi_con_ngay = v;
  const pc = phapChe === null ? phapCheConfig() : phapCheConfig(phapChe);
  cfg.dot2_han_nop = pc.dot2_han_nop;
  cfg.het_han_canh_bao_ngay = pc.het_han_canh_bao_ngay;
  return cfg;
}

// Port tối thiểu `scripts/dpia_draft.load_map` (chỉ để đếm `gaps` — cùng luật kiểm, fail-closed).
// shortcut: bản sao trong nhóm (dpia_draft là công cụ Python giữ lại) — gom vào core khi tích hợp.
const MAP_DATE_RE = /^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u;
const MAP_ID_RE = /^DF-\p{Nd}{2,3}$/u;
const STR_FIELDS = [
  'name',
  'data',
  'subjects',
  'purpose',
  'storage',
  'retention',
  'recipients',
  'legal_basis',
];
const LIST_FIELDS = ['safeguards', 'gaps'];
const CLASSES = ['do', 'vang', 'xanh'];

/** Python `MapError` (⊂ ValueError). */
export class MapError extends RangeError {}

/** Bản đồ luồng dữ liệu đã kiểm → danh sách flow. Lỗi → MapError '<id>.<field>: ...'. */
export function loadFlowMap(
  path: string = FLOW_MAP,
  root: string = REPO_ROOT,
): Record<string, unknown>[] {
  let m: unknown;
  try {
    m = readJson(path); // Python decode("utf-8"): BOM = hỏng
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    throw new MapError(`map không đọc được: ${e.pyType}`);
  }
  if (!isDict(m)) throw new MapError('map phải là object JSON');
  if (typeof m.version !== 'string' || !MAP_DATE_RE.test(m.version)) {
    throw new MapError('version: cần ngày YYYY-MM-DD');
  }
  const flows = m.flows;
  if (!Array.isArray(flows) || !flows.length) throw new MapError('flows rỗng hoặc không phải list');
  const seen = new Set<string>();
  flows.forEach((f, i) => {
    if (!isDict(f)) throw new MapError(`flows[${i}]: phải là object`);
    const fid = f.id;
    if (typeof fid !== 'string' || !MAP_ID_RE.test(fid)) {
      throw new MapError(`flows[${i}].id: cần dạng DF-xx, nhận ${pyReprValue(fid ?? null)}`);
    }
    if (seen.has(fid)) throw new MapError(`${fid}.id: trùng`);
    seen.add(fid);
    for (const k of STR_FIELDS) {
      const v = f[k];
      if (typeof v !== 'string' || !pyStrip(v)) throw new MapError(`${fid}.${k}: thiếu hoặc rỗng`);
    }
    for (const k of LIST_FIELDS) {
      const v = f[k];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && pyStrip(x))) {
        throw new MapError(`${fid}.${k}: phải là list chuỗi`);
      }
    }
    if (!CLASSES.includes(f.class as string)) {
      throw new MapError(`${fid}.class: phải thuộc ['do', 'vang', 'xanh']`);
    }
    if (typeof f.cross_border !== 'boolean')
      throw new MapError(`${fid}.cross_border: phải là bool`);
    const mods = f.modules;
    if (!Array.isArray(mods) || !mods.length) throw new MapError(`${fid}.modules: rỗng`);
    for (const mod of mods) {
      if (
        typeof mod !== 'string' ||
        mod.includes('\\') ||
        mod.startsWith('/') ||
        mod.split('/').includes('..') ||
        mod.includes(':')
      ) {
        throw new MapError(
          `${fid}.modules: đường dẫn posix tương đối không hợp lệ ${pyReprValue(mod ?? null)}`,
        );
      }
      if (!statSync(join(root, mod), { throwIfNoEntry: false })?.isFile()) {
        throw new MapError(`${fid}.modules: không tồn tại ${mod}`);
      }
    }
  });
  return flows as Record<string, unknown>[];
}

export type DpiaFiles = { sim?: string; flowMap?: string; root?: string };

/** → [DPIA đã ký, tổng `gaps` bản đồ luồng]. File hỏng → RangeError. */
export function dpiaFacts(f: DpiaFiles = {}): [boolean, number] {
  const p = f.sim ?? SIM_CONFIG;
  let sim: unknown;
  try {
    sim = readJson(p);
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    throw new RangeError(`${basename(p)} hỏng: ${e.pyType}`);
  }
  const signed = isDict(sim) && sim.dpia_signed === true;
  const gaps = loadFlowMap(f.flowMap, f.root).reduce((s, x) => s + (x.gaps as unknown[]).length, 0);
  return [signed, gaps];
}

export type GiFacts = {
  alcohol: [string, string[]][];
  gi_named: string[];
  gi_confirmed: string[];
  gi_identity: boolean;
};

/** docx P2 (ceo-03, PL01 "Sổ rủi ro pháp lý: … rủi ro rượu, chỉ dẫn địa lý"): đọc golden (SKU rượu +
 * kênh mở bán, SKU mang tên "Ngọc Linh") và `guardrail_rules.json` `ngoc_linh` — chỉ đọc file. */
export function alcoholGiFacts(
  golden: string = GOLDEN_FILE,
  rules: string = GUARDRAIL_RULES,
): GiFacts {
  const [doc, err] = readGolden(golden);
  if (err !== null || doc === null) throw new RangeError(err ?? 'golden');
  let nl: unknown;
  let why: string | null = null;
  try {
    const raw = readJson(rules);
    // Python `doc["ngoc_linh"]`: không phải dict → TypeError, thiếu khóa → KeyError
    if (!isDict(raw)) why = 'TypeError';
    else if (!Object.hasOwn(raw, 'ngoc_linh')) why = 'KeyError';
    else nl = raw.ngoc_linh;
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    why = e.pyType;
  }
  if (why !== null) throw new RangeError(`${basename(rules)} hỏng: ${why}`);
  // Python: `nl.get(...)` trên giá trị không phải dict → AttributeError (không bắt — dừng).
  if (!isDict(nl)) throw new TypeError(`'${typeof nl}' object has no attribute 'get'`);
  // shortcut: `skus` không phải list → coi như rỗng (golden_store đã kiểm list khi nạp).
  const skus = (Array.isArray(doc.skus) ? doc.skus : []).filter(isDict);
  const chansOf = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[]) : typeof v === 'string' && v ? Array.from(v) : [];
  return {
    alcohol: skus
      .filter((s) => s.category === 'alcohol')
      .map((s): [string, string[]] => [s.sku_key as string, chansOf(s.allowed_channels)])
      .sort((a, b) => cpCmp(a[0], b[0])),
    gi_named: skus
      .filter((s) => casefold(pyTruthy(s.name) ? pyStr(s.name) : '').includes('ngọc linh'))
      .map((s) => s.sku_key as string)
      .sort(cpCmp),
    gi_confirmed: (Array.isArray(nl.confirmed_skus) ? (nl.confirmed_skus as string[]) : []).sort(
      cpCmp,
    ),
    gi_identity: pyTruthy(nl.identity),
  };
}

// ------------------------------------------------------------------ đọc

export type RiskDossier = Pick<
  Dossier,
  'sku_key' | 'status' | 'ngay_nop' | 'ngay_cap' | 'ngay_het_han'
> & { id: number };
export type RiskPost = { url: string; channel: string; severity: string; due_at: Date | null };
export type Facts = {
  as_of?: Date;
  dossiers?: RiskDossier[];
  tpbvsk?: string[];
  posts?: RiskPost[];
  alerts?: unknown[];
  dpia_signed?: boolean;
  gaps?: number;
  recipients?: number;
} & Partial<GiFacts>;

export type CollectOpts = { routing?: string | null; files?: DpiaFiles; golden?: string };

/** CHỈ SELECT (+ đọc file cấu hình) → facts as-of cho `rank`. */
export async function collect(db: Db, asOf: Date, o: CollectOpts = {}): Promise<Facts> {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new RangeError('as_of phải là datetime có múi giờ');
  }
  const dossiers = (await db.query<RiskDossier & { id: string }>(DOSSIER_SQL, [asOf])).rows.map(
    (r) => ({ ...r, id: Number(r.id) }),
  );
  const posts = (await db.query<RiskPost>(POSTS_SQL, [asOf])).rows;
  const alerts = (await db.query<{ id: string }>(ALERTS_SQL, [asOf])).rows.map((r) => r.id);
  const [signed, gaps] = dpiaFacts(o.files);
  return {
    as_of: asOf,
    dossiers,
    tpbvsk: tpbvskSkus(o.golden),
    posts,
    alerts,
    dpia_signed: signed,
    gaps,
    recipients: loadRouting(o.routing ?? undefined).recipients.length,
    ...alcoholGiFacts(o.golden),
  };
}

// ------------------------------------------------------------------ thuần

export type Risk = {
  code: string;
  level: string;
  title: string;
  owner_role: string;
  due: string | null;
  days_left: number | null;
  marker: string | null;
  source: string | null;
};

function risk(
  code: string,
  level: string,
  title: string,
  o: Partial<Pick<Risk, 'due' | 'days_left' | 'marker' | 'source'>> & { owner?: string } = {},
): Risk {
  return {
    code,
    level,
    title,
    owner_role: o.owner ?? OWNER,
    due: o.due ?? null,
    days_left: o.days_left ?? null,
    marker: o.marker ?? null,
    source: o.source ?? null,
  };
}

/** Ngày tới mốc phí → 'T-30'/'T-14'/'T-7' (mốc nhỏ nhất ≥ days), quá → 'QUÁ MỐC PHÍ', xa hơn mọi mốc
 * → null. */
export function feeMarker(days: number, marks: readonly number[]): string | null {
  if (days < 0) return 'QUÁ MỐC PHÍ';
  const hit = marks.filter((m) => days <= m);
  return hit.length ? `T-${Math.min(...hit)}` : null;
}

const minDay = (a: string, b: string) => (a <= b ? a : b);
const isOpenNop = (d: RiskDossier) => d.status === 'da_nop' || d.status === 'bo_sung';
const cap = (d: RiskDossier, today: string) => validCap(d as Dossier, today);

/** facts → rủi ro xếp hạng (THUẦN, tất định — thứ tự đầu vào không ảnh hưởng). */
export function rank(facts: Facts, now: Date, cfg: RiskCfg): Risk[] {
  const today = vnDate(now);
  const out: Risk[] = [];
  const bySku = new Map<string, RiskDossier[]>();
  for (const d of facts.dossiers ?? []) bySku.set(d.sku_key, [...(bySku.get(d.sku_key) ?? []), d]);
  const fee = cfg.xnqc_phi_moc;
  const dot2 = cfg.dot2_han_nop;
  for (const sku of [...new Set(facts.tpbvsk ?? [])].sort(cpCmp)) {
    const mine = bySku.get(sku) ?? [];
    if (mine.some((d) => cap(d, today) || isOpenNop(d))) continue;
    const toFee = dayDiff(fee, today);
    const toDot2 = dayDiff(dot2, today);
    const left = Math.min(toFee, toDot2);
    out.push(
      risk(
        `XNQC-CHO-NOP:${sku}`,
        left <= cfg.do_khi_con_ngay ? 'do' : 'vang',
        `SKU TPBVSK ${sku} chưa nộp hồ sơ XNQC — hạn đợt 2 ${dd(dot2)}, mốc phí ${dd(fee)}: ${cfg.xnqc_phi_text}`,
        {
          due: minDay(fee, dot2),
          days_left: left,
          marker: feeMarker(toFee, cfg.nhac_moc_ngay),
          source: cfg.xnqc_phi_nguon_url,
        },
      ),
    );
  }
  for (const sku of [...bySku.keys()].sort(cpCmp)) {
    const mine = bySku.get(sku) as RiskDossier[];
    if (mine.some(isOpenNop) && !mine.some((d) => cap(d, today))) {
      out.push(risk(`XNQC-CHO-CAP:${sku}`, 'xanh', `SKU ${sku} đã nộp hồ sơ XNQC, chờ cấp giấy`));
    }
  }
  for (const d of [...(facts.dossiers ?? [])].sort((a, b) => a.id - b.id)) {
    const het = d.ngay_het_han;
    if (d.status !== 'da_cap' || het === null || het === undefined) continue;
    const left = dayDiff(het, today);
    let level: string;
    let what: string;
    if (left < 0) {
      level = 'do';
      what = `đã hết hạn ${dd(het)}`;
    } else if (left <= cfg.het_han_canh_bao_ngay) {
      level = 'vang';
      what = `sắp hết hạn ${dd(het)} (còn ${left} ngày)`;
    } else continue;
    out.push(
      risk(`XNQC-HET-HAN:${d.id}`, level, `Giấy XNQC hồ sơ #${d.id} (${d.sku_key}) ${what}`, {
        due: het,
        days_left: left,
      }),
    );
  }
  const chans = new Map<string, RiskPost[]>();
  for (const p of facts.posts ?? []) chans.set(p.channel, [...(chans.get(p.channel) ?? []), p]);
  for (const ch of [...chans.keys()].sort(cpCmp)) {
    const ps = chans.get(ch) as RiskPost[];
    const s1 = ps.filter((p) => p.severity === 'S1').length;
    const over = ps.filter((p) => p.due_at !== null && p.due_at < now).length;
    const dues = ps.filter((p) => p.due_at !== null).map((p) => (p.due_at as Date).getTime());
    const due = dues.length ? vnDate(new Date(Math.min(...dues))) : null;
    out.push(
      risk(
        `KENH:${ch}`,
        s1 || over ? 'do' : 'vang',
        `Bài vi phạm đang mở kênh ${ch}: S1 ${s1}, S2 ${ps.length - s1}, quá 24h ${over}`,
        { due, days_left: due ? dayDiff(due, today) : null },
      ),
    );
  }
  const nAlerts = (facts.alerts ?? []).length;
  if (nAlerts) {
    out.push(
      risk('CANH-BAO-DO', 'do', `${nAlerts} cảnh báo đỏ gốc chưa có người xác nhận`, {
        owner: 'phap_che/bks',
      }),
    );
  }
  if (!facts.dpia_signed) {
    out.push(
      risk(
        'DPIA',
        'do',
        `DPIA/TIA chưa ký — ${facts.gaps ?? 0} rủi ro tồn dư trong bản đồ luồng dữ liệu`,
      ),
    );
  } else if (facts.gaps) {
    out.push(
      risk(
        'DPIA',
        'vang',
        `DPIA đã ký, còn ${facts.gaps} rủi ro tồn dư trong bản đồ luồng dữ liệu`,
      ),
    );
  }
  // docx P2 (ceo-03): rủi ro rượu + chỉ dẫn địa lý (PL01). SKU nhóm hạn chế chỉ ghi mã tra cứu
  // H-<sha8> (như sx_label) — chữ/mã nhắc thẳng nhóm hàng làm ô trang TGĐ trượt guardrail.
  for (const [sku, cs] of facts.alcohol ?? []) {
    if (cs.length) {
      const ref = `H-${createHash('sha256').update(sku, 'utf8').digest('hex').slice(0, 8)}`;
      out.push(
        risk(
          `NHOM-HAN-CHE:${ref}`,
          'vang',
          `SKU nhóm hạn chế quảng cáo (mã tra cứu ${ref}) đang mở bán trên ${cs.join(', ')} — cấm quảng cáo/khuyến mại; web ẩn giá + giỏ (PL01 mục 3a); kiểm giấy phép bán`,
        ),
      );
    }
  }
  const confirmed = new Set(facts.gi_confirmed ?? []);
  const unconf = [...new Set(facts.gi_named ?? [])].filter((s) => !confirmed.has(s)).sort(cpCmp);
  if (
    Object.hasOwn(facts, 'gi_confirmed') &&
    facts.gi_confirmed !== undefined &&
    (unconf.length || !pyTruthy(facts.gi_confirmed))
  ) {
    out.push(
      risk(
        'CDDL-NGOC-LINH',
        'vang',
        `Chỉ dẫn địa lý 'Ngọc Linh': ${(facts.gi_confirmed ?? []).length} SKU đã xác nhận quyền sử dụng, ${unconf.length} SKU mang tên 'Ngọc Linh' chưa xác nhận (confirmed_skus)` +
          (facts.gi_identity ? '' : '; chưa khai tên pháp nhân/thương hiệu được phép (identity)') +
          " — nội dung công khai nêu 'Ngọc Linh' bị guardrail chặn",
      ),
    );
  }
  if (!facts.recipients) {
    out.push(
      risk(
        'TUYEN-CANH-BAO',
        'do',
        'Chưa có người nhận cảnh báo đỏ độc lập (data/red_alert_routing.json)',
      ),
    );
  }
  return out.sort((a, b) =>
    tupleCmp(
      [LEVELS[a.level], a.days_left === null ? 1 : 0, a.days_left ?? 0, a.code],
      [LEVELS[b.level], b.days_left === null ? 1 : 0, b.days_left ?? 0, b.code],
    ),
  );
}

export type Trend = { codes: Record<string, string>; gone: number };

/** So 2 lần `rank` → {codes: {code: 'mới'|'↑'|'↓'|'='}, gone: số mã tuần trước có mà nay hết}. */
export function trend(cur: readonly Risk[], prev: readonly Risk[]): Trend {
  const before = new Map(prev.map((r) => [r.code, LEVELS[r.level] as number]));
  const codes: Record<string, string> = {};
  for (const r of cur) {
    const b = before.get(r.code);
    const lv = LEVELS[r.level] as number;
    codes[r.code] = b === undefined ? 'mới' : lv < b ? '↑' : lv > b ? '↓' : '=';
  }
  const nowCodes = new Set(cur.map((r) => r.code));
  return { codes, gone: [...before.keys()].filter((c) => !nowCodes.has(c)).length };
}

/** Ô bảng / thông điệp: che PII, bỏ ký tự điều khiển, không vỡ bảng. */
export const cell = (s: unknown): string =>
  safe(maskPii(pyStr(s)))
    .replaceAll('|', '/')
    .replaceAll('\n', ' ');

export function riskRow(r: Risk, sym = '—'): string {
  let title = r.title + (r.marker ? ` — ${r.marker}` : '');
  if (r.source) title += ` (nguồn: ${r.source})`;
  // Mỗi ô qua pageSafe: sku_key/kênh/URL nguồn có thể chứa chữ trần gập-dấu thành từ cấm.
  const cells = [LEVEL_VI[r.level], r.code, title, r.owner_role, dd(r.due), sym];
  return `| ${cells.map((x) => pageSafe(cell(x))).join(' | ')} |`;
}

/** → markdown "## Rủi ro pháp lý mở". Mọi số do code đếm. */
export function renderSection(
  ranked: readonly Risk[],
  tr: Partial<Trend>,
  now: Date,
  limit: number | null = SHOW,
): string[] {
  const cnt = (k: string) => ranked.filter((r) => r.level === k).length;
  const since = vnFormat(new Date(now.getTime() - WEEK_MS), '%d/%m/%Y');
  const L = [
    '## Rủi ro pháp lý mở',
    '',
    `Đỏ ${cnt('do')} · Vàng ${cnt('vang')} · Xanh ${cnt('xanh')} · đã hết trong tuần: ${tr.gone ?? 0} (so với ${since})`,
    '',
  ];
  if (!ranked.length) L.push('- (không có rủi ro mở)');
  else {
    L.push('| Mức | Mã | Rủi ro | Owner (vai trò) | Hạn | Xu hướng |', '|---|---|---|---|---|---|');
    const shown = limit === null ? ranked : ranked.slice(0, limit);
    for (const r of shown) L.push(riskRow(r, tr.codes?.[r.code] ?? '—'));
    if (ranked.length > shown.length) {
      L.push(
        `\n…và ${ranked.length - shown.length} rủi ro khác (xem \`python -m agents.ceo_risk --report\`)`,
      );
    }
  }
  L.push(
    '',
    '*Tính lại mỗi lần từ tracker Pháp chế (hồ sơ XNQC, bài kênh vi phạm, cảnh báo đỏ, DPIA, tuyến cảnh báo) — không nhập tay song song. Hồ sơ XNQC chưa có lịch sử trạng thái: xu hướng hồ sơ theo trạng thái hiện tại. Mức theo luật data/ceo_risk.json (BẢN DEV SOẠN, chờ Pháp chế duyệt) — agent không tư vấn pháp lý.*',
  );
  return L;
}

export async function compute(
  db: Db,
  now: Date,
  cfg: RiskCfg | null = null,
  o: CollectOpts = {},
): Promise<[Risk[], Trend]> {
  const c = cfg ?? loadConfig();
  const cur = rank(await collect(db, now, o), now, c);
  const prevAt = new Date(now.getTime() - WEEK_MS);
  const prev = rank(await collect(db, prevAt, o), prevAt, c);
  return [cur, trend(cur, prev)];
}

/** Section trang TGĐ/bản tin khối ceo (`ceo_report` nối qua `setCeoSections`). */
export async function section(db: Db, now: Date): Promise<string[]> {
  const [cur, tr] = await compute(db, now);
  return renderSection(cur, tr, now);
}
