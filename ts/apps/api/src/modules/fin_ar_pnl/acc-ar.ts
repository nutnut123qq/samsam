import { basename } from 'node:path';
import type { Db } from '@samsam/core/ops/deps';
import {
  type DirectorConfig,
  run as directorRun,
  submit as directorSubmit,
  loadConfig as loadDirectorConfig,
} from '@samsam/core/ops/director';
import { addDays } from '@samsam/core/ops/period';
import { PyFloat } from '@samsam/core/ops/py-json';
import { REPORTS_DIR } from '@samsam/core/ops/report';
import { oneline } from '@samsam/core/ops/store';
import { withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { maskPii } from '@samsam/core/security/pii';
import { cpLen } from '@samsam/core/security/py';
import { clean, TableError } from '../intel_import/table.js';
import {
  type Cell,
  cpCmp,
  type Dec,
  dayDiff,
  decCmp,
  decOf,
  decStr,
  fmtDay,
  isDict,
  loadPyJson,
  mapHeader,
  mulRound,
  nextRow,
  openTable,
  type PyJsonError,
  pyJsonStr,
  readTable,
  rowRecord,
  sha256hex,
  strNone,
  toDate,
  toSigned,
  vnd,
} from './fin-common.js';

// Port `agents/acc_ar.py` (v9.0 ACC-AR, WP12; v13.6 nháp thư nhắc nợ) — công nợ đại lý: nạp tay sổ
// công nợ → tuổi nợ 0-30/31-60/61-90/>90 + quá hạn, hoa hồng theo cấu hình MẪU (BẢN NHÁP, không phải
// lệnh chi), cảnh báo nợ quá hạn vào bản tin GĐ tài chính; NHÁP thư nhắc nợ (`ar_reminder`) vào hàng
// duyệt khối finance — agent KHÔNG gửi. Tất định, KHÔNG LLM/mạng.
// Ownership: ghi `dealer_ar` (insert-only, idempotent theo sha256 file) + mục `ar_reminder` (qua
// `director.submit`); chỉ ĐỌC `sku_master.category`, `dealers.code/status`. Ngày = 'YYYY-MM-DD'.

export const CONFIG_FILE = dataPath('dealer_commission.json');
export const HEADER = [
  'dealer_code',
  'dealer_type',
  'kind',
  'doc_ref',
  'doc_date',
  'due_date',
  'amount_vnd',
  'sku_key',
  'channel',
] as const;
export const REQUIRED = ['dealer_code', 'dealer_type', 'kind', 'doc_date', 'amount_vnd'];
export const DEALER_TYPES = ['doanh_nghiep', 'ho_kinh_doanh', 'ca_nhan'];
export const AR_KINDS = ['so_du_dau', 'phat_sinh', 'thanh_toan', 'dieu_chinh'];
export const AR_CHANNELS = ['offline', 'online'];
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol'];
export const BUCKETS = ['0-30', '31-60', '61-90', '>90'] as const;
export type Bucket = (typeof BUCKETS)[number];
// fullmatch (JS `$` không nhận trước xuống dòng cuối như Python `$`).
export const CODE_RE = /^[A-Z0-9_-]{2,32}$/;
export const SKU_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_REF = 64;
export const AGENT = 'agent:acc_ar';
export const FIN_BLOCK = 'finance';
export const REMINDER_TYPE = 'ar_reminder';

const tup = (xs: readonly string[]): string => `(${xs.map((x) => `'${x}'`).join(', ')})`;

export type ArConfig = {
  term_days: number;
  rates_pct: Record<string, Dec>;
  zero_rules: { category: string; channel: string }[];
  tncn_types: string[];
};

export type ArEntry = {
  row_no: number;
  dealer_code: string;
  dealer_type: string;
  kind: string;
  doc_ref: string | null;
  doc_date: string;
  due_date: string | null;
  amount_vnd: number;
  sku_key: string | null;
  channel: string | null;
};

// ---------------------------------------------------------------- cấu hình

/** `load_config` → [cấu hình, null] | [null, lý do] (CLI exit 1 trước connect). */
export function loadConfig(path: string = CONFIG_FILE): [ArConfig | null, string | null] {
  const name = basename(path);
  let raw: unknown;
  try {
    raw = loadPyJson(path);
  } catch (e) {
    return [null, `không đọc được ${name}: ${(e as PyJsonError).pyType}`];
  }
  if (!isDict(raw)) return [null, `${name}: phải là object`];
  const t = raw.term_days;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 365) {
    return [null, `${name}.term_days: phải int 1..365`];
  }
  const rates = raw.rates_pct;
  if (
    !isDict(rates) ||
    Object.keys(rates).length !== CATEGORIES.length ||
    !CATEGORIES.every((c) => Object.hasOwn(rates, c))
  ) {
    return [null, `${name}.rates_pct: phải đủ ${tup(CATEGORIES)}`];
  }
  const outRates: Record<string, Dec> = {};
  for (const [k, v] of Object.entries(rates)) {
    if (!(typeof v === 'number' || v instanceof PyFloat)) {
      return [null, `${name}.rates_pct.${k}: phải là số`];
    }
    const d = decOf(v);
    if (decCmp(d, { coef: 0n, exp: 0 }) < 0 || decCmp(d, { coef: 5n, exp: -1 }) > 0) {
      return [null, `${name}.rates_pct.${k}: ngoài 0..0.5`];
    }
    outRates[k] = d;
  }
  const zr = raw.zero_rules;
  if (
    !Array.isArray(zr) ||
    !zr.every(
      (r) =>
        isDict(r) &&
        CATEGORIES.includes(r.category as string) &&
        AR_CHANNELS.includes(r.channel as string),
    )
  ) {
    return [null, `${name}.zero_rules: [{category, channel}]`];
  }
  const tn = raw.tncn_types;
  if (!Array.isArray(tn) || !tn.every((x) => DEALER_TYPES.includes(x as string))) {
    return [null, `${name}.tncn_types: ⊂ ${tup(DEALER_TYPES)}`];
  }
  return [
    {
      term_days: t,
      rates_pct: outRates,
      zero_rules: zr as ArConfig['zero_rules'],
      tncn_types: [...(tn as string[])],
    },
    null,
  ];
}

// ---------------------------------------------------------------- đọc file (thuần)

/** `read_ar` → [entries, lỗi, sha256 file]. Lỗi ≠ [] → entries = []. Lỗi chỉ nêu số dòng + field. */
export async function readAr(path: string): Promise<[ArEntry[], string[], string | null]> {
  const [src, sha, err] = readTable(path);
  if (err !== null || src === null) return [[], [err as string], sha];
  let errs: string[] = [];
  const rows: ArEntry[] = [];
  try {
    const it = await openTable(src);
    const first = nextRow(it);
    if (first === null) return [[], ['file rỗng'], sha];
    const opt = Object.fromEntries(HEADER.filter((f) => !REQUIRED.includes(f)).map((f) => [f, f]));
    let colOf: Record<string, number>;
    [colOf, errs] = mapHeader(
      first[1],
      Object.fromEntries(REQUIRED.map((f) => [f, f])),
      opt,
      [],
      'công nợ đại lý',
    );
    if (errs.length) return [[], errs, sha];
    const width = first[1].length;
    let nBody = 0;
    for (let r = it.next(); !r.done; r = it.next()) {
      const [rowNo, cells] = r.value;
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

/** `_row`: 1 dòng → entry | lỗi (thứ tự kiểm như Python). */
function parseRow(rec: Record<string, Cell>, rowNo: number): ArEntry | string[] {
  const errs: string[] = [];
  const bad = (f: string, why: string) => errs.push(`dòng ${rowNo}: field '${f}' ${why}`);
  for (const f of REQUIRED) if ((rec[f] ?? null) === null) bad(f, 'trống');
  if (errs.length) return errs;
  const code = rec.dealer_code as string;
  if (!CODE_RE.test(code)) bad('dealer_code', 'phải ^[A-Z0-9_-]{2,32}$ (mã, không tên)');
  const dtype = rec.dealer_type as string;
  if (!DEALER_TYPES.includes(dtype)) bad('dealer_type', `phải thuộc ${tup(DEALER_TYPES)}`);
  const kind = rec.kind as string;
  if (!AR_KINDS.includes(kind)) bad('kind', `phải thuộc ${tup(AR_KINDS)}`);
  const docDate = toDate(rec.doc_date);
  if (docDate === null) bad('doc_date', 'không phải ngày hợp lệ');
  const dueRaw = rec.due_date ?? null;
  const due = toDate(dueRaw);
  if (dueRaw !== null && due === null) bad('due_date', 'không phải ngày hợp lệ');
  if (due && docDate && due < docDate) bad('due_date', 'trước doc_date');
  const amt = toSigned(rec.amount_vnd);
  if (amt === null) bad('amount_vnd', 'không phải số nguyên VND hợp lệ');
  else if ((kind === 'so_du_dau' || kind === 'phat_sinh') && amt <= 0)
    bad('amount_vnd', `phải > 0 với kind ${kind}`);
  else if (kind === 'thanh_toan' && amt >= 0) bad('amount_vnd', 'phải < 0 với kind thanh_toan');
  else if (kind === 'dieu_chinh' && amt === 0) bad('amount_vnd', 'phải ≠ 0 với kind dieu_chinh');
  const sku = rec.sku_key ?? null;
  if (sku !== null && !SKU_RE.test(sku)) bad('sku_key', 'không phải mã SKU golden hợp lệ');
  const ch = rec.channel ?? null;
  if (ch !== null && !AR_CHANNELS.includes(ch))
    bad('channel', `phải trống hoặc ${tup(AR_CHANNELS)}`);
  const ref = rec.doc_ref ?? null;
  if (ref !== null && cpLen(ref) > MAX_REF) bad('doc_ref', `dài quá ${MAX_REF}`);
  if (errs.length) return errs;
  return {
    row_no: rowNo,
    dealer_code: code,
    dealer_type: dtype,
    kind,
    doc_ref: ref,
    doc_date: docDate as string,
    due_date: due,
    amount_vnd: amt as number,
    sku_key: sku,
    channel: ch,
  };
}

// ---------------------------------------------------------------- tuổi nợ + hoa hồng (thuần)

/** (as_of − doc_date).days ≤30 `0-30`, ≤60 `31-60`, ≤90 `61-90`, còn lại `>90`; tương lai → null. */
export function ageBucket(docDate: string, asOf: string): Bucket | null {
  const days = dayDiff(asOf, docDate);
  if (days < 0) return null;
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '>90';
}

export type OpenItem = { entry: ArEntry; con_lai: number; han: string; qua_han: boolean };
export type OpenDealer = { type: string; items: OpenItem[]; du_co: number };

/**
 * FIFO dùng chung cho `aging` và thư nhắc nợ → {dealer_code: {type, items, du_co}} (mã sắp tăng).
 * Khoản nợ = so_du_dau/phat_sinh/dieu_chinh dương; ghi có = thanh_toan + dieu_chinh âm, trừ FIFO
 * theo (doc_date, row_no); doc_date > as_of bỏ khỏi kỳ.
 */
export function openItems(
  entries: ArEntry[],
  asOf: string,
  termDays: number,
): Map<string, OpenDealer> {
  const by = new Map<string, { type: string; debits: ArEntry[]; credit: number }>();
  for (const e of entries) {
    if (e.doc_date > asOf) continue;
    let d = by.get(e.dealer_code);
    if (d === undefined) {
      d = { type: e.dealer_type, debits: [], credit: 0 };
      by.set(e.dealer_code, d);
    }
    if (e.amount_vnd > 0) d.debits.push(e);
    else d.credit += -e.amount_vnd;
  }
  const out = new Map<string, OpenDealer>();
  for (const code of [...by.keys()].sort(cpCmp)) {
    const d = by.get(code) as { type: string; debits: ArEntry[]; credit: number };
    let credit = d.credit;
    const items: OpenItem[] = [];
    const debits = [...d.debits].sort((a, b) =>
      a.doc_date !== b.doc_date
        ? a.doc_date < b.doc_date
          ? -1
          : 1
        : (a.row_no ?? 0) - (b.row_no ?? 0),
    );
    for (const e of debits) {
      let left = e.amount_vnd;
      const used = Math.min(left, credit);
      left -= used;
      credit -= used;
      if (!left) continue;
      const han = e.due_date || addDays(e.doc_date, termDays);
      items.push({ entry: e, con_lai: left, han, qua_han: asOf > han });
    }
    out.set(code, { type: d.type, items, du_co: credit });
  }
  return out;
}

export type AgingRow = {
  dealer_code: string;
  dealer_type: string;
  buckets: Record<Bucket, number>;
  qua_han_buckets: Record<Bucket, number>;
  qua_han: number;
  du_co: number;
  con_no: number;
};

const zeroBuckets = (): Record<Bucket, number> => ({ '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 });

/** → [{dealer_code, dealer_type, buckets, qua_han_buckets, qua_han, du_co, con_no}] theo mã. */
export function aging(entries: ArEntry[], asOf: string, termDays: number): AgingRow[] {
  const out: AgingRow[] = [];
  for (const [code, d] of openItems(entries, asOf, termDays)) {
    const buckets = zeroBuckets();
    const od = zeroBuckets();
    let overdue = 0;
    for (const it of d.items) {
      const b = ageBucket(it.entry.doc_date, asOf) as Bucket;
      buckets[b] += it.con_lai;
      if (it.qua_han) {
        overdue += it.con_lai;
        od[b] += it.con_lai;
      }
    }
    out.push({
      dealer_code: code,
      dealer_type: d.type,
      buckets,
      qua_han_buckets: od,
      qua_han: overdue,
      du_co: d.du_co,
      con_no: BUCKETS.reduce((s, k) => s + buckets[k], 0),
    });
  }
  return out;
}

export type CommissionLine = {
  dealer_code: string;
  category: string | null;
  channel: string | null;
  co_so: number;
  ty_le: Dec;
  hoa_hong: number;
  flags: string[];
};

/**
 * skus = {sku_key: category}. → [{dealer_code, category, channel, co_so, ty_le, hoa_hong, flags}] —
 * BẢN NHÁP, không phải lệnh chi. Cơ sở = phat_sinh + dieu_chinh trong [start, end) theo (đại lý,
 * nhóm hàng, kênh), sàn 0; khớp zero_rules → 0 (+ cờ `ruou_online`/`zero_rule`); không có golden →
 * 0 + `thieu_sku`; nhóm có zero_rule mà kênh trống → 0 + `thieu_kenh`; loại TNCN → cờ `tncn`.
 */
export function commission(
  entries: ArEntry[],
  skus: Record<string, string>,
  cfg: Pick<ArConfig, 'rates_pct' | 'zero_rules' | 'tncn_types'>,
  start: string,
  end: string,
): CommissionLine[] {
  const groups = new Map<
    string,
    { key: [string, string | null, string | null]; type: string; base: number }
  >();
  for (const e of entries) {
    if (e.kind !== 'phat_sinh' && e.kind !== 'dieu_chinh') continue;
    if (!(start <= e.doc_date && e.doc_date < end)) continue;
    const cat = e.sku_key && Object.hasOwn(skus, e.sku_key) ? (skus[e.sku_key] as string) : null;
    const k = JSON.stringify([e.dealer_code, cat, e.channel]);
    let g = groups.get(k);
    if (g === undefined) {
      g = { key: [e.dealer_code, cat, e.channel], type: e.dealer_type, base: 0 };
      groups.set(k, g);
    }
    g.base += e.amount_vnd;
  }
  // sorted(key=tuple(map(str, key))) — None → 'None', so theo code point
  const sortKey = (g: { key: [string, string | null, string | null] }) => g.key.map(strNone);
  const sorted = [...groups.values()].sort((a, b) => {
    const x = sortKey(a);
    const y = sortKey(b);
    for (let i = 0; i < 3; i++) {
      const c = cpCmp(x[i] as string, y[i] as string);
      if (c) return c;
    }
    return 0;
  });
  return sorted.map((g) => {
    const [code, cat, ch] = g.key;
    const base = Math.max(0, g.base);
    const flags: string[] = [];
    let rate: Dec = { coef: 0n, exp: 0 };
    if (cat === null) flags.push('thieu_sku');
    else if (cfg.zero_rules.some((r) => r.category === cat && r.channel === ch)) {
      flags.push(cat === 'alcohol' ? 'ruou_online' : 'zero_rule');
    } else if (ch === null && cfg.zero_rules.some((r) => r.category === cat)) {
      flags.push('thieu_kenh');
    } else rate = cfg.rates_pct[cat] as Dec;
    if (cfg.tncn_types.includes(g.type)) flags.push('tncn');
    return {
      dealer_code: code,
      category: cat,
      channel: ch,
      co_so: base,
      ty_le: rate,
      hoa_hong: Number(mulRound(BigInt(base), rate)),
      flags,
    };
  });
}

/** Dòng markdown cho bản tin GĐ tài chính (chỉ mã đại lý + số tiền, không chứng từ). */
export function overdueSection(rows: AgingRow[], asOf: string): string[] {
  const od = rows.filter((r) => r.qua_han > 0);
  const L = [`## Công nợ đại lý quá hạn (tính tới ${fmtDay(asOf, '%d/%m/%Y')})`, ''];
  if (!od.length) return [...L, '- (không có)'];
  // r12 F031-6: cột tuổi = tuổi (ngày chứng từ) của RIÊNG phần quá hạn, đủ 4 nhóm kể cả 0-30 →
  // mỗi dòng cộng khớp cột Quá hạn.
  L.push(
    `| Đại lý | Quá hạn | ${BUCKETS.join(' | ')} |`,
    `|---|---|${'---|'.repeat(BUCKETS.length)}`,
  );
  for (const r of [...od].sort((a, b) => b.qua_han - a.qua_han)) {
    const b = r.qua_han_buckets;
    L.push(
      `| \`${r.dealer_code}\` | ${vnd(r.qua_han)} | ${BUCKETS.map((k) => vnd(b[k])).join(' | ')} |`,
    );
  }
  L.push(
    '',
    `Tổng quá hạn: ${vnd(od.reduce((s, r) => s + r.qua_han, 0))} — nguồn: sổ công nợ nạp tay (\`dealer_ar\`); thư nhắc nợ do kế toán gửi tay, agent không gửi.`,
  );
  return L;
}

// ---------------------------------------------------------------- v13.6 nháp thư nhắc nợ (thuần)

const R_HEAD =
  'NHÁP THƯ NHẮC NỢ — chờ GĐ tài chính duyệt; kế toán điền placeholder và gửi tay. Agent KHÔNG gửi.';
const R_TABLE = '| Chứng từ | Ngày chứng từ | Hạn thanh toán | Số còn nợ | Quá hạn |';
const R_ASK =
  'Kính đề nghị quý đại lý thanh toán hoặc phản hồi đối chiếu trước ngày {{HAN_THANH_TOAN}}. Nếu đã thanh toán, xin bỏ qua thư này và gửi chứng từ để đối chiếu.';
const R_SIGN = '{{NGUOI_KY}} — Phòng kế toán Công ty TNHH Sâm Sâm';

/** `_txt`: chuỗi từ file nạp tay (doc_ref/file_name) → 1 dòng, che PII, ≤ n. */
function txt(s: string | null | undefined, n = 64): string {
  return s ? oneline(maskPii(clean(s, n)), n) : '(không số)';
}

export type Draft = {
  dealer_code: string;
  object_id: string;
  qua_han: number;
  body: string;
  title: string;
};
export type Skipped = { dealer_code: string; reason: string };

/**
 * Nháp thư nhắc nợ cho đại lý có khoản QUÁ HẠN tại `as_of` → {drafts, skipped}.
 * - Chỉ đại lý có trong sổ `dealers` (quan hệ đại lý — CRM v5.2); mã ngoài sổ → skipped, KHÔNG soạn.
 * - Không PII: tên/người nhận/người ký/hạn mới là placeholder `{{…}}`; chỉ mã đại lý + số + chứng từ.
 * - object_id = `ar:<mã>:<sha12 các khoản quá hạn>` — cùng trạng thái nợ → cùng id (idempotent).
 */
export function reminderDrafts(
  entries: ArEntry[],
  asOf: string,
  termDays: number,
  dealers: Record<string, string>,
  sources: Record<string, [string, string][]>,
): { drafts: Draft[]; skipped: Skipped[] } {
  const drafts: Draft[] = [];
  const skipped: Skipped[] = [];
  for (const [code, d] of openItems(entries, asOf, termDays)) {
    const od = d.items.filter((it) => it.qua_han);
    if (!od.length) continue;
    if (!Object.hasOwn(dealers, code)) {
      skipped.push({
        dealer_code: code,
        reason:
          'không có trong sổ đại lý `dealers` — không có căn cứ quan hệ để liên hệ, không soạn thư',
      });
      continue;
    }
    const total = od.reduce((s, it) => s + it.con_lai, 0);
    const conNo = d.items.reduce((s, it) => s + it.con_lai, 0);
    // json.dumps(..., ensure_ascii=False) — phân cách ", " như Python
    const key = `[${od
      .map(
        (it) =>
          `[${pyJsonStr(it.entry.doc_ref ?? null)}, "${it.entry.doc_date}", "${it.han}", ${it.con_lai}]`,
      )
      .join(', ')}]`;
    const oid = `ar:${code}:${sha256hex(Buffer.from(key, 'utf8')).slice(0, 12)}`;
    const uniq = new Map<string, [string, string]>();
    for (const [n, s] of sources[code] ?? []) uniq.set(JSON.stringify([n, s]), [n, s]);
    const files = [...uniq.values()]
      .sort((a, b) => cpCmp(a[0], b[0]) || cpCmp(a[1], b[1]))
      .map(([n, s]) => `${txt(n, 80)} (sha256 ${s.slice(0, 8)})`)
      .join(', ');
    const asOfDmy = fmtDay(asOf, '%d/%m/%Y');
    const L = [
      R_HEAD,
      '',
      `Kính gửi: {{TEN_DAI_LY}} (mã đại lý ${code})`,
      'Người nhận: {{NGUOI_LIEN_HE}}',
      '',
      `Theo sổ công nợ của Công ty TNHH Sâm Sâm tính tới ngày ${asOfDmy}, quý đại lý còn các khoản đã quá hạn thanh toán sau:`,
      '',
      R_TABLE,
      '|---|---|---|---|---|',
    ];
    for (const it of od) {
      const e = it.entry;
      L.push(
        `| ${txt(e.doc_ref)} | ${fmtDay(e.doc_date, '%d/%m/%Y')} | ${fmtDay(it.han, '%d/%m/%Y')} | ${vnd(it.con_lai)} | ${dayDiff(asOf, it.han)} ngày |`,
      );
    }
    L.push(
      '',
      `Tổng quá hạn: ${vnd(total)} (tổng còn nợ: ${vnd(conNo)}).`,
      '',
      R_ASK,
      '',
      'Trân trọng,',
      R_SIGN,
      '',
      '---',
      `Căn cứ (nội bộ, không gửi kèm): sổ công nợ \`dealer_ar\` nạp tay — file ${files || '(không rõ)'}; ghi có trừ FIFO theo ngày chứng từ; hạn = due_date hoặc ngày chứng từ + ${termDays} ngày (data/dealer_commission.json); trạng thái đại lý trong sổ: ${dealers[code]}. Nháp này thay nháp nhắc nợ cũ của cùng đại lý nếu còn chờ duyệt.`,
    );
    drafts.push({
      dealer_code: code,
      object_id: oid,
      qua_han: total,
      body: L.join('\n'),
      title: `Nháp thư nhắc nợ ${code} — quá hạn ${vnd(total)} (tính tới ${asOfDmy})`,
    });
  }
  return { drafts, skipped };
}

// ---------------------------------------------------------------- DB

const COLS = [
  'row_no',
  'dealer_code',
  'dealer_type',
  'kind',
  'doc_ref',
  'doc_date',
  'due_date',
  'amount_vnd',
  'sku_key',
  'channel',
] as const;

/** INSERT `dealer_ar` (cùng giao dịch) → số dòng. */
export async function load(
  db: Db,
  entries: ArEntry[],
  fileName: string,
  sha: string,
): Promise<number> {
  await withTx(db, async (c) => {
    for (const e of entries) {
      await c.query(
        `insert into dealer_ar (file_sha256, file_name, ${COLS.join(', ')}) values ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})`,
        [sha, fileName, ...COLS.map((k) => e[k])],
      );
    }
  });
  return entries.length;
}

export async function fetchEntries(db: Db): Promise<ArEntry[]> {
  const { rows } = await db.query(
    'select row_no, dealer_code, dealer_type, kind, doc_ref, doc_date::text as doc_date, due_date::text as due_date, amount_vnd, sku_key, channel from dealer_ar order by id',
  );
  return rows.map((r) => ({ ...r, amount_vnd: Number(r.amount_vnd) }) as ArEntry);
}

export async function fetchSkus(db: Db): Promise<Record<string, string>> {
  const { rows } = await db.query('select sku_key, category from sku_master');
  return Object.fromEntries(rows.map((r) => [r.sku_key, r.category]));
}

/** Sổ đại lý CRM v5.2 → {code: status} (chỉ mã + trạng thái, không đọc tên/contact). */
export async function fetchDealers(db: Db): Promise<Record<string, string>> {
  const { rows } = await db.query('select code, status from dealers');
  return Object.fromEntries(rows.map((r) => [r.code, r.status]));
}

export async function fetchSources(db: Db): Promise<Record<string, [string, string][]>> {
  const { rows } = await db.query(
    'select distinct dealer_code, file_name, file_sha256 from dealer_ar',
  );
  const out: Record<string, [string, string][]> = {};
  for (const r of rows) {
    const arr = out[r.dealer_code] ?? [];
    arr.push([r.file_name, r.file_sha256]);
    out[r.dealer_code] = arr;
  }
  return out;
}

const REMINDER_EXISTING_SQL =
  "select 1 from approval_queue where object_type = $1 and object_id = $2 and status in ('pending', 'approved', 'rejected') limit 1";

export type ReminderResult = {
  enqueued: { dealer_code: string; queue_id: bigint; qua_han: number }[];
  skipped: Skipped[];
  drafts: Draft[];
};

/**
 * Nháp thư nhắc nợ → hàng duyệt khối finance (`ar_reminder`, pending — GĐ tài chính duyệt, kế toán
 * gửi tay). Đã có cùng object_id ở pending/approved/rejected → skipped (expired thì soạn lại). Tính
 * năng `tat` → RolloutBlocked (từ `enqueue`) TRƯỚC khi ghi.
 */
export async function enqueueReminders(
  db: Db,
  asOf: string,
  termDays: number,
  o: { dcfg?: DirectorConfig; dryRun?: boolean } = {},
): Promise<ReminderResult> {
  const res = reminderDrafts(
    await fetchEntries(db),
    asOf,
    termDays,
    await fetchDealers(db),
    await fetchSources(db),
  );
  const out: ReminderResult = { enqueued: [], skipped: [...res.skipped], drafts: res.drafts };
  if (o.dryRun) return out;
  const cfg = o.dcfg ?? loadDirectorConfig(FIN_BLOCK);
  for (const d of res.drafts) {
    if ((await db.query(REMINDER_EXISTING_SQL, [REMINDER_TYPE, d.object_id])).rows.length) {
      out.skipped.push({
        dealer_code: d.dealer_code,
        reason: 'đã có nháp cùng trạng thái nợ trong hàng duyệt',
      });
      continue;
    }
    let qid: bigint;
    try {
      qid = await directorSubmit(db, {
        block: FIN_BLOCK,
        objectType: REMINDER_TYPE,
        objectId: d.object_id,
        title: d.title,
        payload: d.body,
        createdBy: AGENT,
        cfg,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      out.skipped.push({ dealer_code: d.dealer_code, reason: 'đã có (đua)' });
      continue;
    }
    out.enqueued.push({ dealer_code: d.dealer_code, queue_id: qid, qua_han: d.qua_han });
  }
  return out;
}

/** Nợ quá hạn → mục bổ sung bản tin GĐ tài chính → [path, rows]. */
export async function bulletin(
  db: Db,
  asOf: string,
  now: Date,
  o: { outDir?: string; cfg: ArConfig; dcfg?: DirectorConfig },
): Promise<[string, AgingRow[]]> {
  const rows = aging(await fetchEntries(db), asOf, o.cfg.term_days);
  const [path] = await directorRun(db, FIN_BLOCK, {
    now,
    cfg: o.dcfg,
    outDir: o.outDir ?? REPORTS_DIR,
    extra: overdueSection(rows, asOf),
  });
  return [path, rows];
}

/** Hiển thị tỷ lệ hoa hồng như Python `str(Decimal)`. */
export const rateStr = decStr;
