import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dmy } from '@samsam/core/ops/period';
import { isDict, PyReadError, parsePyJson, pyOsName, readUtf8Sig } from '@samsam/core/ops/py-json';
import { type ReadinessMap, readinessKey, readinessOf } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { pyStrip } from '@samsam/core/security/py';
import {
  cidx,
  type Dict,
  disclaimer,
  gateText,
  gidx,
  md,
  type Part,
  partsOf,
  readinessMap,
  SLUG_RE,
  sha256,
  sumPrice,
  tpUnapproved,
  validateMatrix,
  vnd,
} from './kd-quote.js';
import { pySortedStr } from './py.js';

// Port `agents/kd_catalog.py` (v8.2 KD-A3) — catalog quà Tết (tài liệu chào hàng B2B) từ golden +
// BOM hộp quà + ma trận báo giá GIẢ ĐỊNH. Rượu → loại khỏi MỌI phần (excluded chỉ ghi key + mã, không
// tên); TPBVSK chưa XNQC → loại (catalog = quảng cáo). Text do TEMPLATE (không LLM) → cổng
// `checkPublish(contentType "ads", isAi false)`. Không đường gửi — GĐ bán hàng tự gửi bản đã KHỚP.

export const OBJECT_TYPE = 'b2b_catalog';
export const CATALOG_TYPES = [OBJECT_TYPE];
export const AGENT = 'agent:kd_catalog';
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_PNG = 10 * 1024 * 1024;
export const NO_PHOTO = '(ảnh: chờ packshot công ty cấp)';
export const REF_NOTE = 'Giá tham khảo — báo giá chính thức theo yêu cầu, hệ thống không tự gửi.';
export const MAX_BOM_BYTES = 5 * 1024 * 1024; // production.MAX_FILE_BYTES

export type CatItem = {
  key: string;
  kind: 'sku' | 'combo';
  name: string;
  spec: string;
  parts: Part[];
  tp: boolean;
};
export type Excluded = { key: string; code: string };

const nameOr = (s: Dict, k: string) => (s.name ? String(s.name) : k);
const strOr = (v: unknown) => (typeof v === 'string' ? v : '');

/** → [mục vào catalog, [{key, code}] bị loại — KHÔNG tên]. r12 L2: SKU mức CAM ở bất kỳ kênh nào
 * trong `channels` (view DB `sku_readiness`; null = soi gương golden, fail-closed) → `readiness_cam`. */
export function eligible(
  golden: unknown,
  combos: unknown,
  readiness: ReadinessMap | null = null,
  channels: readonly unknown[] = [],
): [CatItem[], Excluded[]] {
  const g = gidx(golden);
  const c = cidx(combos);
  const items: CatItem[] = [];
  const excluded: Excluded[] = [];
  const bad = new Map<string, string>();
  for (const [k, s] of g) {
    const lv = channels.map((ch) =>
      readiness !== null
        ? (readiness.get(readinessKey(k, String(ch))) ?? 'CAM')
        : readinessOf(s, ch as string),
    );
    let code: string;
    if (s.category === 'alcohol' || isAlcohol(strOr(s.name)) || isAlcohol(k.replaceAll('-', ' '))) {
      code = 'ruou';
    } else if (tpUnapproved(s)) code = 'tpbvsk_chua_xnqc';
    else if (s.category !== 'food' && s.category !== 'tpbvsk') code = 'loai_khong_ho_tro';
    else if (lv.includes('CAM')) code = 'readiness_cam';
    else {
      items.push({
        key: k,
        kind: 'sku',
        name: nameOr(s, k),
        spec: s.pack_spec ? String(s.pack_spec) : '—',
        parts: [[k, 1]],
        tp: s.category === 'tpbvsk',
      });
      continue;
    }
    bad.set(k, code);
    excluded.push({ key: k, code });
  }
  for (const k of pySortedStr(c.keys())) {
    const cb = c.get(k) as Dict;
    const parts = partsOf(k, new Map(), c);
    let code: string | null;
    if (isAlcohol(strOr(cb.name)) || isAlcohol(k.replaceAll('-', ' '))) code = 'ruou';
    else if (parts === null || parts.some(([s]) => !g.has(s as string)))
      code = 'thanh_phan_khong_ro';
    else {
      const codes = new Set(
        parts.filter(([s]) => bad.has(s as string)).map(([s]) => bad.get(s as string) as string),
      );
      code = codes.has('ruou') ? 'ruou' : codes.size ? (pySortedStr(codes)[0] as string) : null;
    }
    if (code) {
      excluded.push({ key: k, code });
      continue;
    }
    const ps = parts as Part[];
    items.push({
      key: k,
      kind: 'combo',
      name: nameOr(cb, k),
      spec: ps
        .map(([s, q]) => `${nameOr(g.get(s as string) as Dict, s as string)} ×${q}`)
        .join(' + '),
      parts: ps,
      tp: ps.some(([s]) => g.get(s as string)?.category === 'tpbvsk'),
    });
  }
  return [items, excluded];
}

/** sha256[:16] của `<dir>/<key>.png` nếu là PNG thật (magic) ≤ 10 MB; key không phải slug → null
 * (không đọc file ngoài thư mục). */
export function packshot(dir: string | null | undefined, key: unknown): string | null {
  if (dir === null || dir === undefined || typeof key !== 'string' || !SLUG_RE.test(key))
    return null;
  const p = join(dir, `${key}.png`);
  let data: Buffer;
  try {
    if (!statSync(p).isFile()) return null;
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(MAX_PNG + 1);
      let n = 0;
      for (let r = 1; r > 0 && n < buf.length; n += r)
        r = readSync(fd, buf, n, buf.length - n, null);
      data = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (data.length > MAX_PNG || !data.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export function excludedNames(golden: unknown, combos: unknown, excluded: Excluded[]): string[] {
  const g = gidx(golden);
  const c = cidx(combos);
  const out: string[] = [];
  for (const e of excluded) {
    const name = (g.get(e.key) ?? c.get(e.key) ?? {}).name;
    out.push(e.key, ...(name ? [name as string] : []));
  }
  return out;
}

export type CatalogBuilt = {
  payload: string;
  excluded: Excluded[];
  problems: string[];
  n_items: number;
  matrix_errors?: string[];
};

/** → {payload, excluded, problems, n_items}. THUẦN trừ đọc packshot. `golden` đã qua
 * `approvedGolden` (giá DB đã duyệt) ở caller; readiness xét ở kênh giá gốc của ma trận + web. */
export function build(
  golden: unknown,
  combos: unknown,
  matrix: unknown,
  o: { day: string; packshotDir?: string | null; readiness?: ReadinessMap | null },
): CatalogBuilt {
  const base0 = isDict(matrix) ? matrix.base : null;
  const chans = [...new Set([isDict(base0) ? base0.channel : null, 'web'].filter((x) => x))];
  const [items, excluded] = eligible(golden, combos, o.readiness ?? null, chans);
  const errs = validateMatrix(matrix, golden, combos);
  if (errs.length) {
    return { payload: '', excluded, problems: ['ma_tran_loi'], n_items: 0, matrix_errors: errs };
  }
  if (!items.length) return { payload: '', excluded, problems: ['khong_co_san_pham'], n_items: 0 };
  const mx = matrix as Dict;
  const g = gidx(golden);
  const shas: string[] = [];
  const base = mx.base as Dict;
  const r = mx.rounding_vnd as number;
  const L = [
    '# Catalog quà Tết — Sâm Sâm',
    '',
    'Quảng cáo',
    '',
    `- Ngày lập: ${dmy(o.day)}`,
    `- ${REF_NOTE}`,
    '',
    '## Sản phẩm',
  ];
  items.forEach((it, i) => {
    L.push('', `### ${i + 1}. ${md(it.name)}`, '');
    const sha = packshot(o.packshotDir, it.key);
    if (sha) {
      shas.push(sha);
      L.push(
        `![${md(it.name)}](packshots/${it.key}.png)`,
        '',
        `- Ảnh: packshots/${it.key}.png (sha256 ${sha})`,
      );
    } else L.push(`- ${NO_PHOTO}`);
    const lst = sumPrice(it.parts, g, base.channel, base.kind);
    L.push(`- Quy cách: ${md(it.spec)}`, `- Giá niêm yết: ${lst ? vnd(lst) : 'liên hệ báo giá'}`);
    const mitems = mx.items as Dict;
    const specM =
      Object.hasOwn(mitems, it.key) && mitems[it.key] !== null ? (mitems[it.key] as Dict) : null;
    if (specM === null || !lst) {
      L.push('- Giá theo số lượng: liên hệ báo giá');
      return;
    }
    L.push('', '| Số lượng | Chiết khấu | Đơn giá tham khảo |', '|---|---|---|');
    for (const t of mx.tiers as Dict[]) {
      const ck = Math.min(t.discount_pct as number, specM.max_discount_pct as number);
      const unit = Number((BigInt(lst) * BigInt(100 - ck)) / BigInt(100 * r)) * r;
      L.push(`| ${t.min_qty}–${t.max_qty} | ${ck}% | ${vnd(unit)} |`);
    }
  });
  if (items.some((it) => it.tp)) L.push('', `${disclaimer()}.`);
  L.push('', REF_NOTE, '');
  const payload = L.join('\n');
  const problems = gateText(payload, excludedNames(golden, combos, excluded), {
    contentType: 'ads',
    readiness: readinessMap(golden),
    ids: shas,
  });
  return { payload, excluded, problems, n_items: items.length };
}

export const objectId = (day: string, payload: string): string =>
  `catalog-tet-${day.replaceAll('-', '')}-${sha256(payload).slice(0, 8)}`;

export class ProductionError extends RangeError {}

/** `production.read_json(path, "combos")`: mọi biến thể "không có dữ liệu" (thiếu / rỗng / JSON
 * hỏng / không phải object / `{}` / chỉ `_doc`) → ProductionError; caller dừng TRƯỚC khi connect. */
export function readBom(path: string, listKey = 'combos'): Dict {
  const name = basename(path);
  let text: string;
  try {
    if (statSync(path).size > MAX_BOM_BYTES) throw new ProductionError(`${name} quá lớn`);
    text = readUtf8Sig(path);
  } catch (e) {
    if (e instanceof ProductionError) throw e;
    const t = e instanceof PyReadError ? e.pyType : pyOsName(e);
    throw new ProductionError(
      t === 'FileNotFoundError' ? `thiếu file ${name}` : `không đọc được ${name} (${t})`,
    );
  }
  if (!pyStrip(text)) throw new ProductionError(`${name} rỗng`);
  let doc: unknown;
  try {
    doc = parsePyJson(text);
  } catch {
    throw new ProductionError(`${name} JSON hỏng: JSONDecodeError`);
  }
  if (!isDict(doc)) throw new ProductionError(`${name}: root phải là object`);
  if (!Object.keys(doc).some((k) => k !== '_doc'))
    throw new ProductionError(`${name}: không có dữ liệu (0 record)`);
  const v = doc[listKey];
  if (listKey && (!Array.isArray(v) || !v.length)) {
    throw new ProductionError(`${name}: '${listKey}' phải là list không rỗng`);
  }
  return doc;
}
