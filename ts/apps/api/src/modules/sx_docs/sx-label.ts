import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { connectDatabaseUrl } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import {
  type DirectorConfig,
  DirectorConfigError,
  submit as directorSubmit,
  loadConfig as loadDirector,
} from '@samsam/core/ops/director';
import { vnDate } from '@samsam/core/ops/period';
import { cpCmp, pyOsName } from '@samsam/core/ops/py-json';
import { dbMsg, isDbError } from '@samsam/core/ops/tx';
import { wireCore } from '@samsam/core/ops/wire';
import { dataPath } from '@samsam/core/paths';
import { pyDumps } from '@samsam/core/rollout/counters';
import { RolloutBlocked, sayBlocked } from '@samsam/core/rollout/rollout';
import { check as guardrailCheck } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { cpLen, D, END, pyStr, re, S, stripCombining, W } from '@samsam/core/security/py';
import { listingSnapshots, refCode } from '../kd_listing_live/kd-listing.js';
import { clean } from '../market/table.js';
import { DocError, extractText, IMAGE_EXTS, PDF_EXT, PROVIDERS } from './doc-intake.js';
import {
  type DbLease,
  type Io,
  isFsError,
  isoDate,
  ndInt,
  pyName,
  pyStrip,
  pySuffix,
  STD_IO,
  validDate,
} from './shared.js';

// Port `agents/sx_label.py` (v12.3 SX — đối soát nhãn, tính năng production-03, khối `production`,
// loại việc `label_check`). Luật TẤT ĐỊNH, KHÔNG LLM, KHÔNG gọi sàn, KHÔNG sửa golden/listing/lô:
// chữ trên nhãn (.txt, hoặc ảnh/PDF → OCR qua provider của doc_intake) → trích tên/ĐKSP/số tự công bố/
// quy cách/NSX-HSD/mã lô/cụm bắt buộc (`data/label_rules.json` GIẢ ĐỊNH) → so golden (`sku_master`),
// hồ sơ lô (`production_lots`) và listing mới nhất mỗi kênh → danh sách lệch. Agent CHỈ ĐỀ XUẤT:
// `--submit` đẩy 1 mục `label_check` qua `director.submit`; GĐ sản xuất duyệt, người sửa.
// An toàn: không lưu/in nguyên văn nhãn (chỉ field regex + sha256); payload dựng TEMPLATE; SKU nhóm hạn
// chế chỉ ghi mã tra cứu `H-<sha8>`; payload trượt guardrail → bản rút gọn. Idempotent theo ĐỢT:
// object_id `sxlabel:<sku|mã tra cứu>:<sha12 nhãn>:<sha8 phát hiện>` — đã có ở BẤT KỲ status → không đẩy.
// Ngày là chuỗi ISO 'YYYY-MM-DD' (Python datetime.date) — so/sắp xếp theo chuỗi tương đương.

export const RULES_FILE = dataPath('label_rules.json');
export const BLOCK = 'production';
export const OBJECT_TYPE = 'label_check';
export const AGENT = 'agent:sx_label';
export const CATEGORIES = ['tpbvsk', 'food', 'alcohol'] as const;
export const REG_KINDS = ['dksp', 'tu_cong_bo'] as const;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const NO_AUTO =
  'Agent CHỈ ĐỀ XUẤT — không tự sửa nhãn, hồ sơ, golden hay ' +
  'listing; người sửa sau khi GĐ sản xuất duyệt.';
export const OCR_HELP =
  'chưa cấu hình OCR: đặt OCR_PROVIDER=<provider trong nước đã cắm ' +
  'vào ingest.doc_intake.PROVIDERS> (external-dep, cần hợp đồng + ' +
  'DPA), hoặc chép chữ trên nhãn ra file .txt rồi dùng --text';

export const SLUG_RE = re(`^[a-z0-9]+(?:[_-][a-z0-9]+)*${END}`);
const LOT_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
// Python `\b` (Unicode) quanh từ khóa bắt đầu/kết thúc bằng chữ = (?<!\w) / (?!\w).
const NW_B = `(?<![${W}])`;
const NW_A = `(?![${W}])`;
const DATE = `(${D}{1,2})[${S}]*[/.-][${S}]*(${D}{1,2})[${S}]*[/.-][${S}]*(${D}{4}|${D}{2})(?!${D})`;
const NSX_KW = `${NW_B}(?:nsx|ngay[${S}]+san[${S}]+xuat|ngay[${S}]+sx|mfg|mfd)${NW_A}`;
const HSD_KW = `${NW_B}(?:hsd|han[${S}]+su[${S}]+dung|han[${S}]+dung|exp)${NW_A}`;
const NSX_RE = re(`${NSX_KW}[^${D}\\n]{0,20}?${DATE}`, 'g');
const HSD_RE = re(`${HSD_KW}[^${D}\\n]{0,20}?${DATE}`, 'g');
const HSD_SPAN_RE = re(`${HSD_KW}[^${D}\\n]{0,20}?(${D}{1,3})[${S}]*(thang|nam)${NW_A}`, 'g');
export const DKSP_RE = re(
  `(?<!${D})(${D}{1,6})[${S}]*/[${S}]*(${D}{4})[${S}]*/[${S}]*dksp(?![a-z])`,
  'g',
);
const TCB_RE = re(`${NW_B}cong[${S}]+bo${NW_A}[^${D}\\n]{0,15}?(${D}[a-z0-9/.-]{1,40})`, 'g');
const QTY_RE = re(`(?<![${D}.,])(${D}{1,6})[${S}]*(vien|v|ml)(?![a-z])`, 'g');
const LOT_KW_RE = re(
  `${NW_B}(?:so[${S}]+lo|lo[${S}]+sx|lo[${S}]+san[${S}]+xuat|lot(?:[${S}]+no)?|batch(?:[${S}]+no)?)` +
    `${NW_A}[${S}]*[:.#]?[${S}]*([a-z0-9][a-z0-9-]{2,31})`,
  'g',
);
// `ingest.golden_store._SPEC_RE` (quy cách đầu tiên 'số + viên|v|ml').
const SPEC_RE = re(`(${D}+)[${S}]*(viên|v|ml)${NW_A}`, 'i');

/** Cấu hình/tệp nhãn không dùng được — fail-closed (Python ValueError). */
export class LabelError extends RangeError {}
/** OCR chưa cấu hình / provider bị từ chối → exit 2 kèm hướng dẫn. */
export class OcrUnavailable extends Error {}

// ---------------------------------------------------------------- chuẩn hóa

/** Bỏ dấu + chữ thường, GIỮ dấu câu (cho regex số/ngày/mã). */
export function low(s: string | null | undefined): string {
  const t = (s ?? '')
    .normalize('NFC')
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'd')
    .replaceAll('Ð', 'd');
  return stripCombining(t.normalize('NFKD')).toLowerCase();
}

/** `low` + mọi ký tự không phải a-z0-9 thành 1 khoảng trắng, có viền khoảng trắng 2 đầu → so cụm theo
 * ranh giới từ bằng `includes`. */
export function flat(s: string | null | undefined): string {
  const parts = low(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return ` ${parts.join(' ')} `;
}

function has(phrase: string, textFlat: string): boolean {
  const p = flat(phrase);
  return p.trim() !== '' && textFlat.includes(p);
}

function date(d: string, m: string, y: string): string | null {
  const year = ndInt(y) + (cpLen(y) === 2 ? 2000 : 0);
  const [mm, dd] = [ndInt(m), ndInt(d)];
  return validDate(year, mm, dd) ? isoDate(year, mm, dd) : null; // 31/02, tháng 13...
}

const qty = (n: string, unit: string) => `${ndInt(n)} ${unit === 'ml' ? 'ml' : 'viên'}`;
const dksp = (n: string, y: string) => `${ndInt(n)}/${y}/ĐKSP`;

export type Sku = {
  sku_key: string;
  name: string | null;
  category: string | null;
  pack_spec: string | null;
  receipt_no: string | null;
};

export function restricted(sku: Partial<Sku>): boolean {
  return (
    sku.category === 'alcohol' ||
    isAlcohol(`${pyStr(sku.sku_key ?? '')} ${pyStr(sku.name === undefined ? '' : sku.name)}`)
  );
}

/** sku_key, hoặc mã tra cứu `H-<sha8>` cho SKU nhóm hạn chế. */
export function skuRef(sku: Sku): string {
  if (restricted(sku)) {
    return `H-${createHash('sha256').update(sku.sku_key, 'utf8').digest('hex').slice(0, 8)}`;
  }
  return sku.sku_key;
}

/** `ingest.golden_store.spec_of`: quy cách đầu tiên → '12 viên' / '120 ml'; không có → null. */
export function specOf(text: string | null | undefined): string | null {
  const m = SPEC_RE.exec(text ?? '');
  if (!m) return null;
  return `${ndInt(m[1])} ${m[2].toLowerCase() === 'ml' ? 'ml' : 'viên'}`;
}

// ---------------------------------------------------------------- cấu hình

type Item = { id: string; phrase: string; label: string };
export type Rules = {
  status: string;
  required: Record<string, Item[]>;
  markers: Record<string, string[]>;
  registration: Record<string, string | null>;
  name_ignore: Set<string>;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sameSet = (a: string[], b: readonly string[]) =>
  a.length === new Set(a).size && a.length === b.length && b.every((x) => a.includes(x));
const CAT_TUPLE = `(${CATEGORIES.map((c) => `'${c}'`).join(', ')})`;
const REG_TUPLE = `(${REG_KINDS.map((c) => `'${c}'`).join(', ')})`;

export function validateRules(doc: unknown): Rules {
  if (!isObj(doc) || !Object.keys(doc).some((k) => k !== '_doc')) {
    throw new LabelError('label_rules: không có dữ liệu');
  }
  const status = doc.status;
  if (typeof status !== 'string' || !pyStrip(status)) {
    throw new LabelError("label_rules: thiếu 'status'");
  }
  const req = doc.required;
  const mk = doc.markers;
  const reg = doc.registration;
  if (!isObj(req) || !sameSet(Object.keys(req), CATEGORIES)) {
    throw new LabelError(`label_rules.required: phải có đủ ${CAT_TUPLE}`);
  }
  if (
    !isObj(reg) ||
    !sameSet(Object.keys(reg), CATEGORIES) ||
    Object.values(reg).some((v) => v !== null && !(REG_KINDS as readonly unknown[]).includes(v))
  ) {
    throw new LabelError(`label_rules.registration: mỗi category là ${REG_TUPLE} hoặc null`);
  }
  if (
    !isObj(mk) ||
    !Object.keys(mk).every((k) => (CATEGORIES as readonly string[]).includes(k)) ||
    Object.values(mk).some(
      (v) => !Array.isArray(v) || !v.every((x) => typeof x === 'string' && flat(x).trim() !== ''),
    )
  ) {
    throw new LabelError('label_rules.markers: {category: [cụm không rỗng]}');
  }
  const ignore = Object.hasOwn(doc, 'name_ignore') ? doc.name_ignore : [];
  if (!Array.isArray(ignore) || !ignore.every((x) => typeof x === 'string')) {
    throw new LabelError('label_rules.name_ignore: phải là list chuỗi');
  }
  for (const [cat, items] of Object.entries(req)) {
    if (!Array.isArray(items)) throw new LabelError(`label_rules.required.${cat}: phải là list`);
    const ids = new Set<string>();
    items.forEach((it, i) => {
      const where = `label_rules.required.${cat}[${i}]`;
      if (!isObj(it)) throw new LabelError(`${where}: phải là object`);
      const { id: rid, phrase: ph, label: lb } = it;
      if (typeof rid !== 'string' || !SLUG_RE.test(rid) || ids.has(rid)) {
        throw new LabelError(`${where}.id: slug, không trùng`);
      }
      ids.add(rid);
      if (typeof ph !== 'string' || !flat(ph).trim()) throw new LabelError(`${where}.phrase: rỗng`);
      if (typeof lb !== 'string' || !pyStrip(lb) || cpLen(lb) > 120) {
        throw new LabelError(`${where}.label: rỗng hoặc > 120 ký tự`);
      }
      // label đi vào hàng duyệt → phải sạch guardrail ngay từ config.
      if (!guardrailCheck(lb).ok) {
        throw new LabelError(`${where}.label: trượt guardrail — viết mô tả trung tính`);
      }
    });
  }
  return {
    status: pyStrip(status),
    required: req as Record<string, Item[]>,
    markers: mk as Record<string, string[]>,
    registration: reg as Record<string, string | null>,
    name_ignore: new Set((ignore as string[]).map((x) => flat(x).trim())),
  };
}

export function loadRules(path: string = RULES_FILE): Rules {
  const name = pyName(path);
  let doc: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    doc = JSON.parse(text);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw new LabelError(`thiếu file ${name}`);
    const t = isFsError(e)
      ? pyOsName(e)
      : e instanceof SyntaxError
        ? 'JSONDecodeError'
        : 'UnicodeDecodeError';
    throw new LabelError(`không đọc được ${name} (${t})`);
  }
  return validateRules(doc);
}

// ---------------------------------------------------------------- trích (THUẦN)

export type Fields = {
  flat: string;
  dksp: string[];
  tu_cong_bo: string[];
  qty: string[];
  nsx: string[];
  hsd: string[];
  hsd_months: number[];
  lots: string[];
};

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort(cpCmp);

/** Chữ trên nhãn → field trích tất định. Không giữ nguyên văn nhãn. */
export function extract(text: string): Fields {
  const lo = low(text);
  const dates = (rx: RegExp) =>
    uniqSorted(
      [...lo.matchAll(rx)].map((m) => date(m[1], m[2], m[3])).filter((d): d is string => !!d),
    );
  const span = [
    ...new Set([...lo.matchAll(HSD_SPAN_RE)].map((m) => ndInt(m[1]) * (m[2] === 'nam' ? 12 : 1))),
  ].sort((a, b) => a - b);
  const lots = uniqSorted(
    [...lo.matchAll(LOT_KW_RE)]
      .map((m) => m[1].toUpperCase())
      .filter((c) => LOT_RE.test(c) && /[0-9]/.test(c)),
  );
  return {
    flat: flat(text),
    dksp: uniqSorted([...lo.matchAll(DKSP_RE)].map((m) => dksp(m[1], m[2]))),
    tu_cong_bo: uniqSorted([...lo.matchAll(TCB_RE)].map((m) => m[1].toUpperCase())),
    qty: uniqSorted([...lo.matchAll(QTY_RE)].map((m) => qty(m[1], m[2]))),
    nsx: dates(NSX_RE),
    hsd: dates(HSD_RE),
    hsd_months: span,
    lots,
  };
}

/** Từ chữ (≥ 2 ký tự, không số) của tên golden phải có trên nhãn. */
export function nameTokens(name: string, ignore: Set<string>): string[] {
  const out: string[] = [];
  for (const t of flat(name).split(' ').filter(Boolean)) {
    if (t.length >= 2 && !/[0-9]/.test(t) && !ignore.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- so (THUẦN)

const fmt = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const list = (xs: string[]) => (xs.length ? xs.join(', ') : '(không đọc được)');
const minS = (xs: string[]) => [...xs].sort()[0];
const maxS = (xs: string[]) => [...xs].sort()[xs.length - 1];

export type Finding = { kind: string; msg: string };
export type Listing = { channel: string; item_id: unknown; title: string | null };
export type Lot = {
  sku_key: string;
  mfg_date: string;
  exp_date: string;
  intake_status: string | null;
};

/** → [{kind, msg}] — msg là TEMPLATE an toàn (số/ngày/mã + mô tả trong config), không chép chữ tự do
 * của nhãn/listing. `lots` = {mã lô: hồ sơ} cho mã lô đọc được trên nhãn. */
export function compare(
  fields: Fields,
  sku: Sku,
  rules: Rules,
  listings: Listing[],
  lots: Record<string, Lot>,
  today: string,
): Finding[] {
  const out: Finding[] = [];
  const cat = sku.category;
  const tf = fields.flat;
  const hidden = restricted(sku);
  const add = (kind: string, msg: string) => out.push({ kind, msg });
  // 1. tên
  const miss = nameTokens(sku.name || '', rules.name_ignore).filter((t) => !tf.includes(` ${t} `));
  if (miss.length) {
    add(
      'ten_thieu_tu',
      hidden
        ? `tên trên nhãn thiếu ${miss.length} từ của tên golden`
        : `tên trên nhãn thiếu từ của tên golden: ${miss.join(', ')}`,
    );
  }
  // 2. nhóm sản phẩm (marker của category khác) — tên nhóm rượu không vào hàng duyệt (guardrail chặn)
  const group = (c: string | null) => (c === 'alcohol' ? 'nhóm hạn chế' : `nhóm ${pyStr(c)}`);
  for (const mcat of Object.keys(rules.markers).sort(cpCmp)) {
    if (mcat !== cat && rules.markers[mcat].some((p) => has(p, tf))) {
      add('nhom_lech', `nhãn có dấu hiệu ${group(mcat)} nhưng golden thuộc ${group(cat)}`);
    }
  }
  // 3. cụm bắt buộc
  const req = cat !== null && Object.hasOwn(rules.required, cat) ? rules.required[cat] : [];
  for (const it of req) {
    if (!has(it.phrase, tf)) add('bat_buoc_thieu', `nhãn thiếu: ${it.label}`);
  }
  // 4. số đăng ký
  const reg =
    cat !== null && Object.hasOwn(rules.registration, cat) ? rules.registration[cat] : null;
  if (reg === 'dksp') {
    let golden: string | null = null;
    const g = new RegExp(DKSP_RE.source, 'u').exec(low(sku.receipt_no || ''));
    if (g) golden = dksp(g[1], g[2]);
    if (golden === null) {
      add(
        'dang_ky_golden_thieu',
        `golden chưa có số ĐKSP hợp lệ — chưa đối chiếu được (nhãn ghi: ${list(fields.dksp)})`,
      );
    } else if (!fields.dksp.length) {
      add('dang_ky_thieu', `nhãn không có số ĐKSP (golden ${golden})`);
    } else if (!(fields.dksp.length === 1 && fields.dksp[0] === golden)) {
      add('dang_ky_lech', `số ĐKSP: nhãn ghi ${list(fields.dksp)}; golden ${golden}`);
    }
  } else if (reg === 'tu_cong_bo' && !fields.tu_cong_bo.length) {
    add('dang_ky_thieu', 'nhãn không có số tự công bố');
  }
  // 5. quy cách (golden pack_spec: số đầu tiên + viên|ml là TỔNG)
  const gspec = specOf(sku.pack_spec);
  if (gspec && !fields.qty.includes(gspec)) {
    add('quy_cach_lech', `quy cách: nhãn ghi ${list(fields.qty)}; golden ${gspec}`);
  }
  // 6. NSX/HSD
  const { nsx, hsd } = fields;
  if (!hsd.length && !fields.hsd_months.length) {
    add('hsd_thieu', 'nhãn không đọc được HSD (ngày hoặc số tháng)');
  }
  if (nsx.length > 1 || hsd.length > 1) {
    add(
      'ngay_nhieu',
      `nhãn có nhiều NSX/HSD khác nhau: NSX ${list(nsx.map(fmt))}; HSD ${list(hsd.map(fmt))}`,
    );
  }
  if (nsx.length && hsd.length && minS(hsd) <= maxS(nsx)) {
    add('hsd_truoc_nsx', `HSD ${fmt(minS(hsd))} không sau NSX ${fmt(maxS(nsx))}`);
  }
  if (hsd.length && minS(hsd) < today) {
    add('het_han', `HSD trên nhãn ${fmt(minS(hsd))} đã qua (hôm nay ${fmt(today)})`);
  }
  // 7. hồ sơ lô
  for (const code of fields.lots) {
    const lot = Object.hasOwn(lots, code) ? lots[code] : undefined;
    if (lot === undefined) {
      add('lo_khong_ho_so', `mã lô ${code} trên nhãn chưa có hồ sơ lô`);
      continue;
    }
    if (lot.sku_key !== sku.sku_key) {
      add('lo_khac_sku', `mã lô ${code} thuộc SKU khác trong hồ sơ lô`);
      continue;
    }
    if (lot.intake_status !== 'passed') {
      add(
        'lo_chua_kiem',
        `mã lô ${code}: hồ sơ lô chưa kiểm nhập đạt (${pyStr(lot.intake_status)})`,
      );
    }
    if (nsx.length && !nsx.includes(lot.mfg_date)) {
      add(
        'lo_nsx_lech',
        `mã lô ${code}: NSX nhãn ${list(nsx.map(fmt))}; hồ sơ lô ${fmt(lot.mfg_date)}`,
      );
    }
    if (hsd.length && !hsd.includes(lot.exp_date)) {
      add(
        'lo_hsd_lech',
        `mã lô ${code}: HSD nhãn ${list(hsd.map(fmt))}; hồ sơ lô ${fmt(lot.exp_date)}`,
      );
    }
  }
  // 8. listing mới nhất mỗi kênh
  for (const r of listings) {
    const lspec = specOf(r.title);
    if (lspec && fields.qty.length && !fields.qty.includes(lspec)) {
      add(
        'listing_quy_cach_lech',
        `listing ${pyStr(r.channel)} mã ${refCode(r.item_id)} ghi ${lspec}; nhãn ghi ${list(fields.qty)}`,
      );
    }
  }
  return out;
}

const sha = (obj: unknown) => createHash('sha256').update(pyDumps(obj, true), 'utf8').digest('hex');

/** → [object_id, title, payload] dựng từ TEMPLATE. Payload trượt guardrail → bản rút gọn (số đếm + mã),
 * không đẩy chữ bẩn. */
export function payloadOf(
  sku: Sku,
  findings: Finding[],
  textSha: string,
): [string, string, string] {
  const ref = skuRef(sku);
  const oid = `sxlabel:${ref}:${textSha.slice(0, 12)}:${sha(findings).slice(0, 8)}`;
  const title = `Đối soát nhãn — SKU ${ref}: ${findings.length} điểm lệch`;
  const head = `Đối soát nhãn (SX, NHÁP) — SKU ${ref}; nguồn nhãn sha256 ${textSha.slice(0, 12)}.`;
  let payload = [head, ...findings.map((f) => `- ${f.msg}`), NO_AUTO].join('\n');
  if (!guardrailCheck(payload).ok) {
    payload =
      `Đối soát nhãn (SX, NHÁP) — SKU ${ref}; nguồn nhãn sha256 ${textSha.slice(0, 12)}; ` +
      `${findings.length} điểm lệch (chi tiết bị ẩn vì không qua guardrail — người duyệt chạy lại ` +
      `python -m agents.sx_label với cùng file nhãn).\n${NO_AUTO}`;
  }
  return [oid, title, payload];
}

// ---------------------------------------------------------------- đọc nhãn

export function readTextFile(path: string): string {
  const name = pyName(path);
  let raw: Buffer;
  try {
    if (statSync(path).size > MAX_TEXT_BYTES) throw new LabelError(`${name} quá lớn (> 1 MB)`);
    raw = readFileSync(path);
  } catch (e) {
    if (e instanceof LabelError) throw e;
    if ((e as { code?: string }).code === 'ENOENT') throw new LabelError(`không thấy file ${name}`);
    throw new LabelError(`không đọc được ${name} (${pyOsName(e)})`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ BOM đầu
  } catch {
    throw new LabelError(`không đọc được ${name} (UnicodeDecodeError)`);
  }
  if (!pyStrip(text)) throw new LabelError(`${name} rỗng`);
  return text.normalize('NFC');
}

export async function readImage(path: string, provider: string, env: Env): Promise<string> {
  const ext = pySuffix(pyName(path)).toLowerCase();
  const accepted = [...IMAGE_EXTS, PDF_EXT];
  if (!accepted.includes(ext)) {
    throw new LabelError(
      `đuôi ${ext || '(không có)'} không nhận — dùng ${[...IMAGE_EXTS, '.pdf'].join(', ')}`,
    );
  }
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new OcrUnavailable(`OCR_PROVIDER=${provider} chưa hỗ trợ — ${OCR_HELP}`);
  }
  if (!PROVIDERS[provider][1]) {
    throw new OcrUnavailable(`provider OCR nước ngoài bị từ chối (luật doc_intake) — ${OCR_HELP}`);
  }
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new LabelError(`không thấy file ${pyName(path)}`);
  if (ext !== PDF_EXT && provider === 'none') throw new OcrUnavailable(OCR_HELP);
  let text: string;
  let src: string;
  try {
    [text, , src] = await extractText(path, provider, null, env);
  } catch (e) {
    if (e instanceof DocError) throw new LabelError(e.message);
    throw e;
  }
  if (src === 'none') {
    if (provider === 'none') throw new OcrUnavailable(`PDF không có lớp chữ — ${OCR_HELP}`);
    throw new LabelError('OCR không ra chữ — chụp lại ảnh rõ hơn');
  }
  return text;
}

// ---------------------------------------------------------------- DB (SELECT)

export async function goldenSku(db: Db, key: string): Promise<Sku | null> {
  const { rows } = await db.query<Sku>(
    'select sku_key, name, category, pack_spec, receipt_no from sku_master where sku_key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function latestListings(db: Db, key: string): Promise<Listing[]> {
  const snaps = await listingSnapshots(db);
  if (!snaps.size) return [];
  const { rows } = await db.query<Listing>(
    'select channel, item_id, title from market_rows' +
      ' where snapshot_id = any($1::bigint[]) and sku_key = $2 order by channel, row_no',
    [[...snaps.values()], key],
  );
  return rows;
}

export async function lotRecords(db: Db, codes: string[]): Promise<Record<string, Lot>> {
  if (!codes.length) return {};
  const { rows } = await db.query<Lot & { lot_code: string }>(
    'select lot_code, sku_key, mfg_date::text as mfg_date, exp_date::text as exp_date,' +
      ' intake_status from production_lots where lot_code = any($1)',
    [codes],
  );
  const out: Record<string, Lot> = {};
  for (const r of rows) {
    out[r.lot_code] = {
      sku_key: r.sku_key,
      mfg_date: r.mfg_date,
      exp_date: r.exp_date,
      intake_status: r.intake_status,
    };
  }
  return out;
}

export async function alreadyQueued(db: Db, oid: string): Promise<boolean> {
  const { rows } = await db.query<{ e: boolean }>(
    'select exists (select 1 from approval_queue where object_type = $1 and object_id = $2) as e',
    [OBJECT_TYPE, oid],
  );
  return rows[0].e;
}

// ---------------------------------------------------------------- CLI

export type SxLabelOpts = { sku?: string; text?: string; image?: string; submit?: boolean };
export type SxLabelDeps = {
  env?: Env;
  io?: Io;
  connect?: () => Promise<DbLease | null>;
  wire?: (db: Db) => void;
  rulesFile?: string;
  now?: () => Date;
};

const PROG = 'sx-label';

async function runDb(
  a: { sku: string; submit: boolean },
  text: string,
  rules: Rules,
  cfg: DirectorConfig,
  d: SxLabelDeps,
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const lease = await (d.connect ?? (() => connectDatabaseUrl(env)))();
  if (lease === null) {
    io.err('[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc host chết)');
    return 2;
  }
  const db = lease.db;
  try {
    (d.wire ?? ((x: Db) => void wireCore(x)))(db);
    const sku = await goldenSku(db, a.sku);
    if (sku === null) {
      io.err(
        `[error] SKU ${clean(a.sku)} không có trong golden (sku_master) — chạy python -m ingest.golden_store`,
      );
      return 1;
    }
    const fields = extract(text);
    const today = vnDate((d.now ?? (() => new Date()))());
    const findings = compare(
      fields,
      sku,
      rules,
      await latestListings(db, sku.sku_key),
      await lotRecords(db, fields.lots),
      today,
    );
    const textSha = createHash('sha256').update(text, 'utf8').digest('hex');
    const ref = skuRef(sku);
    io.out(`[label] luật nhãn: ${rules.status}`);
    if (ref !== sku.sku_key) {
      io.out(
        `[label] SKU ${sku.sku_key} → mã tra cứu ${ref} (nhóm hạn chế — hàng duyệt chỉ ghi mã này)`,
      );
    }
    io.out(
      `[label] nhãn sha256 ${textSha.slice(0, 12)} · trích: ĐKSP ${list(fields.dksp)} · quy cách ` +
        `${list(fields.qty)} · NSX ${list(fields.nsx.map(fmt))} · HSD ${list(fields.hsd.map(fmt))}` +
        ` · lô ${list(fields.lots)}`,
    );
    for (const f of findings) io.out(`  - [${f.kind}] ${f.msg}`);
    if (!findings.length) {
      io.out('[ok] không thấy lệch so với golden/hồ sơ lô/listing — không đẩy hàng duyệt');
      return 0;
    }
    const [oid, title, payload] = payloadOf(sku, findings, textSha);
    if (!a.submit) {
      io.out(
        `[dry] ${findings.length} điểm lệch — thêm --submit để đẩy mục ${OBJECT_TYPE} khối ${BLOCK} (không ghi DB)`,
      );
      return 0;
    }
    if (await alreadyQueued(db, oid)) {
      io.out(`[skip] đợt này đã có trong hàng duyệt (${oid})`);
      return 0;
    }
    const qid = await directorSubmit(db, {
      block: BLOCK,
      objectType: OBJECT_TYPE,
      objectId: oid,
      title,
      payload,
      createdBy: AGENT,
      cfg,
    });
    io.out(`[submit] hàng duyệt #${qid} (${OBJECT_TYPE}, khối ${BLOCK}) — chờ GĐ sản xuất duyệt`);
    return 0;
  } catch (e) {
    // KHÁC Python có chủ đích: cổng TẮT ở biên sinh (enqueue) → `[rollout]` exit 2 thay traceback
    if (e instanceof RolloutBlocked) return sayBlocked(e.message, io.out);
    if (!isDbError(e)) throw e;
    io.err(`[error] lỗi DB: ${clean(dbMsg(e), 300)}`);
    return 2;
  } finally {
    await lease.release().catch(() => {});
  }
}

/** `sx-label --sku K --text F | --image F [--submit]` (Python `python -m agents.sx_label`). Exit: 0 ok
 * (kể cả có lệch) · 1 tệp/cấu hình/SKU lỗi · 2 sai usage, OCR chưa cấu hình, DB down/lỗi DB. */
export async function sxLabelMain(o: SxLabelOpts, d: SxLabelDeps = {}): Promise<number> {
  const env = d.env ?? process.env;
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`${PROG}: error: ${msg}`);
    return 2;
  };
  // thứ tự lỗi như argparse: loại trừ nhau → thiếu --sku → thiếu nguồn nhãn
  if (o.text !== undefined && o.image !== undefined) {
    return usage('argument --image: not allowed with argument --text');
  }
  if (o.sku === undefined) return usage('the following arguments are required: --sku');
  if (o.text === undefined && o.image === undefined) {
    return usage('one of the arguments --text --image is required');
  }
  if (!SLUG_RE.test(o.sku) || cpLen(o.sku) > 64) return usage('--sku phải là slug a-z0-9-_');
  let rules: Rules;
  let cfg: DirectorConfig;
  let text: string;
  try {
    rules = loadRules(d.rulesFile ?? RULES_FILE);
    cfg = loadDirector(BLOCK);
    if (!Object.hasOwn(cfg.object_types, OBJECT_TYPE)) {
      throw new DirectorConfigError(`${BLOCK}.json thiếu loại việc ${OBJECT_TYPE}`);
    }
    text =
      o.text !== undefined
        ? readTextFile(o.text)
        : await readImage(o.image as string, pyStrip(env.OCR_PROVIDER ?? '') || 'none', env);
  } catch (e) {
    if (e instanceof OcrUnavailable) {
      io.err(`[error] ${e.message}`);
      return 2;
    }
    if (e instanceof LabelError || e instanceof DirectorConfigError) {
      io.err(`[error] ${e.message} — không connect`);
      return 1;
    }
    throw e;
  }
  return runDb({ sku: o.sku, submit: Boolean(o.submit) }, text, rules, cfg, d);
}
