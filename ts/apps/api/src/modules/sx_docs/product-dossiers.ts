import { readFileSync } from 'node:fs';
import { JsonFileError, readJson } from '@samsam/core/ops/py';
import { cpCmp } from '@samsam/core/ops/py-json';
import { dataPath } from '@samsam/core/paths';
import { casefold, pySplit, pyStr } from '@samsam/core/security/py';
import { type Io, pyStrip, STD_IO } from './shared.js';

// Port `ingest/product_dossiers.py` (đợt hoàn thiện 22/10/2026 — kiểm sổ HỒ SƠ GỐC sản phẩm, tính năng
// production-02 "Hồ sơ sản phẩm", PL01 "Hồ sơ gốc 14 sản phẩm (thành phần, quy cách, số công bố)").
// Sổ `data/product_dossiers.json` (`danh_muc_ho_so_goc` do Bên B điền — repo KHÔNG bịa). CHỈ KIỂM, không
// DB: cấu trúc từng hồ sơ (11 trường bắt buộc, `xac_nhan_boi` là NGƯỜI, `tep_sha256` 64 hex thường,
// hồ sơ `mau: true` không tính là thật), đối chiếu golden (mỗi SKU golden đúng 1 dòng `sku`, số công bố
// khớp), đủ số `so_ho_so_hop_dong`; thiếu → nêu ĐÍCH DANH SKU chưa gắn.
// Exit: 0 đủ + khớp · 1 sai cấu trúc/lệch · 2 CHƯA ĐỦ dữ liệu (BLOCKED — chờ Bên B).
// Giá trị JSON lạ (sku_keys là chuỗi/số, khóa không băm được) đi theo ngữ nghĩa Python (lặp ký tự chuỗi,
// TypeError → lỗi chương trình), không âm thầm bỏ qua.

export const DOSSIER_FILE = dataPath('product_dossiers.json');
export const GOLDEN_FILE = dataPath('golden_skus.json');
export const REQUIRED = [
  'ma_ho_so',
  'ten',
  'thanh_phan',
  'quy_cach',
  'so_cong_bo',
  'loai',
  'sku_keys',
  'xac_nhan_boi',
  'can_cu',
  'phien_ban',
  'tep_sha256',
];
export const LOAI = ['tpbvsk', 'food', 'alcohol'];

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const txt = (v: unknown): v is string => typeof v === 'string' && pyStrip(v) !== '';
const human = (v: unknown): boolean =>
  txt(v) && !['agent:', 'system:', 'auto_policy:'].some((p) => casefold(pyStrip(v)).startsWith(p));
const normNo = (v: unknown): string => casefold(pySplit(v ? pyStr(v) : '').join(' '));

/** Python `for x in v` của giá trị JSON truthy (`v or []`): list → phần tử, str → ký tự, dict → khóa. */
function pyIter(v: unknown): unknown[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isObj(v)) return Object.keys(v);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

/** Khóa dict Python (chỉ giá trị băm được: chuỗi/số/bool/None). */
function hashKey(v: unknown): string {
  if (Array.isArray(v) || isObj(v))
    throw new TypeError(`unhashable type: '${Array.isArray(v) ? 'list' : 'dict'}'`);
  if (typeof v === 'string') return `s:${v}`;
  if (v === null || v === undefined) return 'n:';
  if (typeof v === 'boolean') return `f:${v ? 1 : 0}`; // True == 1 trong dict Python
  return `f:${v}`;
}

/** Python `x in container` (list → ==, str → chuỗi con). */
function pyIn(x: unknown, container: unknown): boolean {
  if (typeof container === 'string') {
    if (typeof x !== 'string') throw new TypeError("'in <string>' requires string as left operand");
    return container.includes(x);
  }
  return pyIter(container).some((y) => y === x);
}

export type CheckResult = {
  errors: string[];
  missing: string[];
  dossiers: number;
  mapped: number;
  skus: number;
};

/** THUẦN → {errors, missing, dossiers, mapped, skus}. */
export function check(doc: J, goldenSkus: unknown[]): CheckResult {
  const errs: string[] = [];
  const miss: string[] = [];
  const gold = new Map<string, J>();
  for (const s of goldenSkus) {
    if (!isObj(s) || !Object.hasOwn(s, 'sku_key')) throw new TypeError("KeyError: 'sku_key'");
    gold.set(hashKey(s.sku_key), s);
  }
  const goldKeys = [...gold.values()].map((s) => s.sku_key);
  const items = doc.danh_muc_ho_so_goc;
  if (!Array.isArray(items)) {
    return {
      errors: ['danh_muc_ho_so_goc: phải là list'],
      missing: [],
      dossiers: 0,
      mapped: 0,
      skus: gold.size,
    };
  }
  const byId = new Map<string, J>();
  items.forEach((d, i) => {
    const w = `danh_muc_ho_so_goc[${i}]`;
    if (!isObj(d)) {
      errs.push(`${w}: phải là object`);
      return;
    }
    for (const k of REQUIRED) {
      const v = d[k];
      const asList = Array.isArray(v) && v.length > 0 && v.every(txt);
      let ok: boolean;
      if (k === 'sku_keys') ok = asList;
      else if (k === 'thanh_phan')
        ok = asList || txt(v); // chuỗi hoặc danh sách thành phần
      else if (k === 'tep_sha256') ok = typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
      else ok = txt(v);
      if (!ok) errs.push(`${w}.${k}: thiếu/rỗng`);
    }
    const mid = d.ma_ho_so;
    if (d.mau === true) {
      // fixture/thử: không bao giờ tính là thật
      errs.push(`${w}: hồ sơ MẪU (mau=true) — không tính là hồ sơ gốc thật`);
    } else if (txt(mid)) {
      if (byId.has(mid)) errs.push(`${w}.ma_ho_so: trùng ${mid}`);
      byId.set(mid, d);
    }
    if (!(LOAI as unknown[]).includes(d.loai)) errs.push(`${w}.loai: phải ∈ ${LOAI.join('|')}`);
    if (txt(d.xac_nhan_boi) && !human(d.xac_nhan_boi)) {
      errs.push(`${w}.xac_nhan_boi: phải là NGƯỜI (không agent:/system:)`);
    }
    for (const sk of pyIter(d.sku_keys)) {
      const g = gold.get(hashKey(sk));
      if (g === undefined) errs.push(`${w}.sku_keys: '${pyStr(sk)}' không có trong golden`);
      else if (normNo(g.receipt_no) && normNo(d.so_cong_bo) !== normNo(g.receipt_no)) {
        errs.push(`${w}: số công bố lệch golden của ${pyStr(sk)}`);
      }
    }
  });
  const rows = Array.isArray(doc.sku) ? doc.sku : [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = isObj(r) ? r.sku_key : null;
    const hk = hashKey(k);
    seen.set(hk, (seen.get(hk) ?? 0) + 1);
    const hs = isObj(r) ? r.ho_so_goc : null;
    const known = hs !== null && hs !== undefined && typeof hs === 'string' && byId.has(hs);
    if (hs !== null && hs !== undefined) {
      hashKey(hs); // Python: `hs not in by_id` cần giá trị băm được
      if (!known) errs.push(`sku[${pyStr(k)}].ho_so_goc: '${pyStr(hs)}' không có trong danh mục`);
    }
    if (known && !pyIn(k, byId.get(hs as string)?.sku_keys || [])) {
      errs.push(`sku[${pyStr(k)}]: gắn ${pyStr(hs)} nhưng hồ sơ không liệt kê SKU này`);
    }
  }
  for (const k of goldKeys) {
    if (seen.get(hashKey(k)) !== 1) errs.push(`sku: SKU golden '${pyStr(k)}' phải có đúng 1 dòng`);
  }
  const mappedRows = rows.filter(
    (r) => isObj(r) && typeof r.ho_so_goc === 'string' && byId.has(r.ho_so_goc),
  ) as J[];
  const mapped = mappedRows.length;
  let need = doc.so_ho_so_hop_dong;
  if (typeof need !== 'number' || !Number.isInteger(need) || need < 1) {
    errs.push('so_ho_so_hop_dong: phải là số nguyên ≥ 1');
    need = 0;
  }
  if (byId.size < (need as number)) {
    miss.push(
      `danh mục hồ sơ gốc: ${byId.size}/${need} (Bên B cung cấp tên, thành phần, quy cách, số công bố + căn cứ)`,
    );
  }
  if (mapped < gold.size) {
    const done = new Set(mappedRows.map((r) => hashKey(r.sku_key)));
    const left = goldKeys
      .filter((k) => !done.has(hashKey(k)))
      .map((k) => pyStr(k))
      .sort(cpCmp);
    miss.push(`SKU golden đã gắn hồ sơ gốc: ${mapped}/${gold.size} — chưa gắn: ${left.join(', ')}`);
  }
  return { errors: errs, missing: miss, dossiers: byId.size, mapped, skus: gold.size };
}

/** Python json: `14.0`/`1e1` là float → `isinstance(need, int)` sai. JSON.parse ra 14 (mất phân biệt) →
 * đọc chữ gốc (reviver `source`) của khóa GỐC `so_ho_so_hop_dong`. */
function needIsFloat(file: string): boolean {
  const hits: unknown[] = [];
  let root: unknown;
  JSON.parse(
    readFileSync(file, 'utf8'),
    function (this: unknown, k: string, v: unknown, c?: { source?: string }) {
      if (k === 'so_ho_so_hop_dong' && typeof v === 'number' && /[.eE]/.test(c?.source ?? '')) {
        hits.push(this);
      }
      if (k === '') root = v; // lần gọi CUỐI là gốc
      return v;
    },
  );
  return hits.includes(root);
}

export type DossiersOpts = { check?: boolean; file?: string; golden?: string };

/** `product-dossiers --check [--file F] [--golden G]` (Python `python -m ingest.product_dossiers`). */
export function productDossiersMain(o: DossiersOpts, io: Io = STD_IO): number {
  if (!o.check) {
    io.err('product-dossiers: error: the following arguments are required: --check');
    return 2;
  }
  let doc: unknown;
  let gold: unknown;
  let bad: string | null = null;
  try {
    doc = readJson(o.file ?? DOSSIER_FILE);
    const g = readJson(o.golden ?? GOLDEN_FILE);
    // Python `_load(golden)["skus"]`: không phải dict → TypeError, thiếu khóa → KeyError
    if (!isObj(g)) bad = 'TypeError';
    else if (!Object.hasOwn(g, 'skus')) bad = 'KeyError';
    else gold = g.skus;
  } catch (e) {
    if (!(e instanceof JsonFileError)) throw e;
    bad = e.pyType;
  }
  if (bad) {
    io.out(`[err] không đọc được sổ/golden (${bad})`);
    return 1;
  }
  if (!isObj(doc) || !Array.isArray(gold)) {
    io.out('[err] sổ/golden sai cấu trúc');
    return 1;
  }
  // float Python → giá trị không nguyên để `check` báo "phải là số nguyên ≥ 1" như Python
  const d = needIsFloat(o.file ?? DOSSIER_FILE) ? { ...doc, so_ho_so_hop_dong: Number.NaN } : doc;
  let r: CheckResult;
  try {
    r = check(d, gold);
  } catch (e) {
    // Python: KeyError/TypeError trong check (golden thiếu sku_key, khóa không băm được) = dừng exit 1
    if (!(e instanceof TypeError)) throw e;
    io.out('[err] sổ/golden sai cấu trúc (TypeError)');
    return 1;
  }
  for (const e of r.errors) io.out(`[err] ${e}`);
  for (const m of r.missing) io.out(`[blocked] ${m}`);
  io.out(
    `[done] hồ sơ ${r.dossiers} · SKU golden ${r.skus} · đã gắn ${r.mapped} · lỗi ${r.errors.length}`,
  );
  if (r.errors.length) return 1;
  return r.missing.length ? 2 : 0;
}
