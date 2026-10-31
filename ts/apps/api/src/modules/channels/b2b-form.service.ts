import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import type { Db } from '@samsam/core/ops/deps';
import { addDays, vnDate } from '@samsam/core/ops/period';
import { cpLen, isInt, isPlainObject, isPrintable, readJson, squash } from '@samsam/core/ops/py';
import { isDbError, withTx } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import { pySorted } from '@samsam/core/rollout/rollout';
import { callHuman } from '@samsam/core/security/auth';
import {
  normalizePhone,
  phoneLookup,
  seal,
  VaultKeyError,
  type VaultKeys,
} from '@samsam/core/security/fernet';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { PII_RE } from '@samsam/core/security/pii';
import {
  casefold,
  cpHead,
  pyStr,
  pyStrip,
  pyTruthy,
  re,
  reEscape,
  S,
  search,
  stripAccents,
  stripCombining,
  W,
} from '@samsam/core/security/py';
import { pyType } from './channels.service.js';

// Port `connectors/b2b_form.py` (v8.2 KD-A3, WP11) — form B2B nhận yêu cầu báo giá quà Tết (server
// HTTP RIÊNG `node:http`, TÁCH khỏi webhook Zalo/Messenger và khỏi app NestJS: mọi kiểm tra
// 411/413/415/429 chạy TRƯỚC khi đọc body — body parser của Nest đọc body trước). Mặc định TẮT.
// - `B2B_FORM_ENABLED` (env tiến trình) ∉ 1/true/yes → exit 2 TRƯỚC khi bind (chỉ bật sau khi DPIA
//   luồng form được ký). Khóa vault lỗi → exit 2 trước bind. Bind `B2B_FORM_HOST` (127.0.0.1) :
//   `B2B_FORM_PORT` (8791). Domain/TLS/reverse proxy = external-dep.
// - `GET /b2b` → `data/b2b_form.html` (HTML tĩnh, không script), danh sách sản phẩm = cùng tập catalog
//   (`eligible`: không rượu, không TPBVSK chưa XNQC), mọi giá trị qua escape HTML.
// - `POST /b2b`: chunked / thiếu Content-Length → 411; > 8 KB → 413 KHÔNG đọc body; Content-Type ≠
//   urlencoded → 415; rate-limit (in-memory, khóa HMAC(ip)) → 429 — đều TRƯỚC khi đọc body/DB; lỗi
//   đầu vào → 400 trang chung (KHÔNG echo input); honeypot → 200 trang chung, 0 ghi; DB/vault lỗi →
//   503; OK → 200 trang chung (KHÔNG hiện mã YC — mã chỉ ở log/CLI GĐ).
// - PII người liên hệ CHỈ vào `contacts` mã hóa Fernet (function `crm_add_contact_human`) + `consents`
//   mục đích `b2b` (nguồn `web`, `policy_version` NHÁP chờ Pháp chế); `b2b_requests` chỉ giữ
//   `contact_id` + `consent_id` (insert-only). Gửi lại y hệt cùng ngày → id cũ, 0 ghi.
// - SĐT trùng contact đã RÚT đồng ý b2b → trang chung (body y hệt OK, không oracle dò vault), 0 ghi.
// - Log stdout chỉ `[b2b_form] <status> ip=<hash8> yc=<id>` — không PII; lỗi giữa kết nối → stderr
//   chỉ hash IP + tên lớp lỗi; hash IP = HMAC muối ngẫu nhiên theo tiến trình (không dò ngược IP).
// - Chỉ NHẬN, không gửi gì ra ngoài, không LLM.

export const FORM_FILE = dataPath('b2b_form.html');
export const PROVINCES_FILE = dataPath('vn_provinces_2025.json');
export const GOLDEN_FILE = dataPath('golden_skus.json');
export const PATH = '/b2b';
export const DEFAULT_PORT = 8791;
export const MAX_FORM_BYTES = 8192;
export const MAX_FIELDS = 40;
export const MAX_LINES = 10;
export const MAX_QTY = 100_000;
export const POLICY_VERSION = 'b2b-v0-nhap';
export const BY = 'web:b2b_form';
export const SOURCE = 'b2b_form';
export const FORM_CT = 'application/x-www-form-urlencoded';
/** Khớp `agents/da_b2b.ORG_TYPES` (CHECK của `b2b_requests.org_type`). */
export const ORG_TYPES = [
  'doanh_nghiep',
  'khach_san',
  'su_kien_hoi_nghi',
  'hiep_hoi',
  'co_quan',
  'khac',
];
const BASE_FIELDS = new Set([
  'org_name',
  'org_type',
  'region',
  'contact_name',
  'phone',
  'email',
  'need_by',
  'consent',
  'policy_version',
  'website',
]);
const LINE_FIELD = /^(sku|qty)([1-9][0-9]{0,2})$/;
const EMAIL_RE = re(`^[^@${S}]{1,64}@[A-Za-z0-9\\-]{1,63}(?:\\.[A-Za-z0-9\\-]{1,63})+$`);
// Chữ số hex → chữ g..p: mã biên bản không bao giờ khớp mẫu SĐT (recordConsent từ chối evidence
// "giống SĐT").
const evTr = (s: string) => s.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)] as string);
// Muối ngẫu nhiên MỖI tiến trình cho hash IP (rate-limit + log): IPv4 chỉ 2^32 giá trị — sha256(ip)
// trần dò ngược được; HMAC muối không ghi đĩa → hash chỉ so được trong 1 lần chạy.
export const IP_SALT = randomBytes(16);

export const PAGE_OK =
  '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
  '<title>Đã nhận yêu cầu</title></head><body><h1>Đã nhận yêu cầu' +
  '</h1><p>GĐ bán hàng sẽ liên hệ. Hệ thống không tự gửi báo ' +
  'giá.</p></body></html>';
export const pageErr = (msg: string) =>
  '<!doctype html><html lang="vi"><head><meta charset="utf-8">' +
  '<title>Chưa gửi được</title></head><body><h1>Chưa gửi được yêu ' +
  `cầu</h1><p>${msg}</p><p><a href="/b2b">Quay lại form</a></p>` +
  '</body></html>';
export const MSG: Record<number, string> = {
  400:
    'Thông tin chưa hợp lệ — kiểm tra lại các ô bắt buộc, số điện ' +
    'thoại, tỉnh/thành, sản phẩm và ô đồng ý.',
  404: 'Không có trang này.',
  411: 'Thiếu độ dài nội dung.',
  413: 'Nội dung quá lớn.',
  415: 'Định dạng gửi không hỗ trợ.',
  429: 'Gửi quá nhiều lần — thử lại sau.',
  503: 'Hệ thống đang bận — thử lại sau.',
};

export function iphash(ip: string): string {
  return createHmac('sha256', IP_SALT).update(String(ip), 'utf8').digest('hex').slice(0, 16);
}

// ------------------------------------------------------------ thuần: tỉnh (ingest/crm.province_of)

const provNorm = (t: string) => squash(casefold(t.normalize('NFC')));
const altRe = (names: Iterable<string>) =>
  re(
    `(?<![${W}])(?:${[...names]
      .sort((a, b) => cpLen(b) - cpLen(a)) // tên dài khớp trước
      .map(reEscape)
      .join('|')})(?![${W}])`,
    'g',
  );
type ProvIdx = {
  names: Map<string, string>;
  acc: RegExp;
  plain: Map<string, string>;
  plainRe: RegExp;
};
let provCache: [string, ProvIdx] | null = null;

function provinceIndex(path: string = PROVINCES_FILE): ProvIdx {
  if (provCache?.[0] === path) return provCache[1];
  const doc = readJson(path) as { provinces: string[]; aliases: Record<string, string> };
  const provinces = doc.provinces;
  const name = path.split(/[\\/]/).at(-1);
  if (provinces.length !== 34 || new Set(provinces).size !== 34) {
    throw new RangeError(`${name}: provinces phải đúng 34 tên duy nhất`);
  }
  const names = new Map(provinces.map((p) => [provNorm(p), p]));
  for (const [alias, target] of Object.entries(doc.aliases)) {
    if (!provinces.includes(target)) throw new RangeError(`${name}: alias trỏ ngoài 34 tỉnh`);
    const k = provNorm(alias);
    if (!names.has(k)) names.set(k, target);
    if (names.get(k) !== target) throw new RangeError(`${name}: alias trùng trỏ 2 tỉnh`);
  }
  const plainAll = new Map<string, string | null>();
  for (const [n, p] of names) {
    const k = stripAccents(n);
    plainAll.set(k, (plainAll.has(k) ? plainAll.get(k) : p) === p ? p : null); // đụng → bỏ
  }
  const plain = new Map([...plainAll].filter((e): e is [string, string] => Boolean(e[1])));
  const idx = { names, acc: altRe(names.keys()), plain, plainRe: altRe(plain.keys()) };
  provCache = [path, idx];
  return idx;
}

/** Text tự do → 1 trong 34 tên tỉnh mới | null. Khớp CÓ DẤU với ranh giới từ; fallback không dấu
 * CHỈ khi text không có ký tự có dấu ("hoa huệ" ≠ Huế). >1 tỉnh khác nhau → null (mơ hồ). */
export function provinceOf(text: unknown): string | null {
  if (typeof text !== 'string' || !pyStrip(text)) return null;
  const t = provNorm(cpHead(text, 5000));
  const ix = provinceIndex();
  let found = new Set([...t.matchAll(ix.acc)].map((m) => ix.names.get(m[0]) as string));
  if (!found.size && stripAccents(t) === t) {
    found = new Set([...t.matchAll(ix.plainRe)].map((m) => ix.plain.get(m[0]) as string));
  }
  return found.size === 1 ? ([...found][0] as string) : null;
}

/** `agents/da_b2b.norm`: NFKC, casefold, bỏ dấu, đ→d, mọi cụm không phải chữ/số → 1 dấu cách. */
export function norm(s: unknown): string {
  const t = stripCombining(
    casefold(pyStr(s || '').normalize('NFKC'))
      .normalize('NFD')
      .replaceAll('đ', 'd'),
  );
  return pyStrip(t.replace(/[^\p{L}\p{N}]+/gu, ' '));
}

// ------------------------------------------------------------ thuần: catalog (agents/kd_catalog)

type Sku = Record<string, unknown> & { sku_key: string };
type Combo = Record<string, unknown> & { combo_key: string };
export type CatalogItem = {
  key: string;
  kind: 'sku' | 'combo';
  name: string;
  spec: string;
  parts: [string, number][];
  tp: boolean;
};

const isNum = (v: unknown, lo: number, hi: number) => isInt(v) && v >= lo && v <= hi;

/** `kd_catalog.eligible(golden, combos)` (readiness=None, channels=()) → (mục vào catalog, [{key,
 * code}] bị loại — KHÔNG tên). shortcut: chưa port nhánh `channels`/readiness DB (form không dùng),
 * nâng khi port kd_catalog — khi đó form dùng bản đó. */
export function eligible(
  golden: unknown,
  combos: unknown,
): [CatalogItem[], { key: string; code: string }[]] {
  const skus = isPlainObject(golden) && Array.isArray(golden.skus) ? golden.skus : [];
  const g = new Map<string, Sku>();
  for (const s of skus)
    if (isPlainObject(s) && typeof s.sku_key === 'string') g.set(s.sku_key, s as Sku);
  const c = new Map<string, Combo>();
  for (const cb of Array.isArray(combos) ? combos : []) {
    if (isPlainObject(cb) && typeof cb.combo_key === 'string') c.set(cb.combo_key, cb as Combo);
  }
  const nameOf = (o: Record<string, unknown>, k: string) => (o.name as string) || k;
  const items: CatalogItem[] = [];
  const excluded: { key: string; code: string }[] = [];
  const bad = new Map<string, string>();
  for (const [k, s] of g) {
    let code: string | null = null;
    if (s.category === 'alcohol' || isAlcohol(s.name || '') || isAlcohol(k.replaceAll('-', ' '))) {
      code = 'ruou';
    } else if (s.category === 'tpbvsk' && s.xnqc_status !== 'approved') code = 'tpbvsk_chua_xnqc';
    else if (s.category !== 'food' && s.category !== 'tpbvsk') code = 'loai_khong_ho_tro';
    if (code) {
      bad.set(k, code);
      excluded.push({ key: k, code });
      continue;
    }
    items.push({
      key: k,
      kind: 'sku',
      name: nameOf(s, k),
      spec: (s.pack_spec as string) || '—',
      parts: [[k, 1]],
      tp: s.category === 'tpbvsk',
    });
  }
  for (const k of pySorted(c.keys())) {
    const cb = c.get(k) as Combo;
    let parts: [string, number][] | null = [];
    for (const it of Array.isArray(cb.items) ? cb.items : []) {
      if (!(isPlainObject(it) && isNum(it.qty, 1, 10 ** 6))) {
        parts = null;
        break;
      }
      parts.push([it.sku_key as string, it.qty as number]);
    }
    if (parts !== null && !parts.length) parts = null;
    let code: string | null;
    if (isAlcohol(cb.name || '') || isAlcohol(k.replaceAll('-', ' '))) code = 'ruou';
    else if (parts === null || parts.some(([s]) => !g.has(s))) code = 'thanh_phan_khong_ro';
    else {
      const codes = pySorted(
        new Set(parts.filter(([s]) => bad.has(s)).map(([s]) => bad.get(s) as string)),
      );
      code = codes.includes('ruou') ? 'ruou' : (codes[0] ?? null);
    }
    if (code) {
      excluded.push({ key: k, code });
      continue;
    }
    const ps = parts as [string, number][];
    items.push({
      key: k,
      kind: 'combo',
      name: nameOf(cb, k),
      spec: ps.map(([s, q]) => `${nameOf(g.get(s) as Sku, s)} ×${q}`).join(' + '),
      parts: ps,
      tp: ps.some(([s]) => (g.get(s) as Sku).category === 'tpbvsk'),
    });
  }
  return [items, excluded];
}

/** Cùng tập catalog → [(key, tên)]. */
export function options(golden: unknown, combos: unknown): [string, string][] {
  return eligible(golden, combos)[0].map((it) => [it.key, it.name]);
}

/** Python `html.escape(s, quote=True)`. */
export function htmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

export function renderPage(opts: [string, string][], template?: string): string {
  const tpl =
    template ??
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(FORM_FILE));
  const o = opts
    .map(([k, n]) => `<option value="${htmlEscape(k)}">${htmlEscape(n)}</option>`)
    .join('');
  return tpl.replaceAll('<!--OPTIONS-->', () => o);
}

/** `golden_store.read_golden` → [doc, null] | [null, lý do]. Mọi biến thể "không có dữ liệu" trả lý
 * do để caller dừng TRƯỚC khi connect. */
export function readGolden(
  path: string = GOLDEN_FILE,
): [Record<string, unknown> | null, string | null] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return [null, `thiếu file ${path}`];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ BOM
  } catch {
    return [null, `${path} không phải UTF-8`];
  }
  if (!pyStrip(text)) return [null, `${path} rỗng`];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [null, `${path} JSON hỏng`];
  }
  if (!isPlainObject(doc) || !pyTruthy(doc.skus)) {
    return [null, `${path} không có SKU nào (0 record) — không nạp`];
  }
  return [doc, null];
}

/** `production.db_combos`: combo + thành phần từ `bom_combos`/`bom_items`. */
export async function dbCombos(db: Db): Promise<Record<string, unknown>[]> {
  const combos = new Map<string, Record<string, unknown>>();
  const r1 = await db.query(
    'select combo_key, name, channels, source, note from bom_combos order by combo_key',
  );
  for (const { combo_key, name, channels, source, note } of r1.rows) {
    const cb: Record<string, unknown> = { combo_key, name, channels, items: [], _source: source };
    if (note !== null) cb.note = note;
    combos.set(combo_key, cb);
  }
  const r2 = await db.query(
    'select combo_key, sku_key, qty from bom_items order by combo_key, sku_key',
  );
  for (const { combo_key, sku_key, qty } of r2.rows) {
    (combos.get(combo_key)?.items as unknown[] | undefined)?.push({ sku_key, qty });
  }
  return [...combos.values()];
}

// ------------------------------------------------------------ thuần: parse_form

class QsTooMany extends Error {}
class QsDecode extends Error {}

const utf8 = (b: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);

/** Python `urllib.parse.unquote_plus(s, errors='strict')` (3.12): giải %XX theo từng cụm ASCII. */
function unquotePlus(s0: string): string {
  const s = s0.replaceAll('+', ' ');
  if (!s.includes('%')) return s;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: cụm ASCII như Python `_asciire`
  return s.replace(/[\x00-\x7f]+/g, (run) => {
    const bits = run.split('%');
    const out: number[] = [...Buffer.from(bits[0] as string, 'latin1')];
    for (const item of bits.slice(1)) {
      if (/^[0-9a-fA-F]{2}/.test(item))
        out.push(Number.parseInt(item.slice(0, 2), 16), ...Buffer.from(item.slice(2), 'latin1'));
      else out.push(0x25, ...Buffer.from(item, 'latin1'));
    }
    try {
      return utf8(Uint8Array.from(out));
    } catch {
      throw new QsDecode();
    }
  });
}

/** Python `parse_qs(text, keep_blank_values=True, max_num_fields=40, separator='&', errors='strict')`. */
function parseQs(text: string): Map<string, string[]> {
  const q = new Map<string, string[]>();
  if (!text) return q;
  if (MAX_FIELDS < text.split('&').length) throw new QsTooMany(); // num_fields = 1 + count('&')
  for (const nv of text.split('&')) {
    if (!nv) continue;
    const i = nv.indexOf('=');
    const name = unquotePlus(i < 0 ? nv : nv.slice(0, i));
    const value = unquotePlus(i < 0 ? '' : nv.slice(i + 1));
    const cur = q.get(name);
    if (cur) cur.push(value);
    else q.set(name, [value]);
  }
  return q;
}

export type Form = {
  org_name: string;
  org_type: string;
  region: string;
  contact: { name: string; phone: string; email: string | null };
  items: { key: string; qty: number }[];
  need_by: string | null;
};

const ISO_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Python `date.fromisoformat` (YYYY-MM-DD, chữ số ASCII, ngày có thật) → chuỗi ngày | null. */
function isoDay(s: string): string | null {
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  const ok =
    y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  return ok ? s : null;
}

/** THUẦN → [form | null, mã]. Mã: ok | khong_utf8 | qua_nhieu_truong | truong_lap | truong_la | spam |
 * thieu_dong_y | ten_to_chuc | loai_to_chuc | tinh | ten_lien_he | sdt | email | so_dong |
 * ma_khong_hop_le (gồm key rượu — mã chung) | so_luong | dong_trung | ngay_can. Không chứa input. */
export function parseForm(
  body: Uint8Array,
  allowed: Set<string>,
  today: string,
): [Form | null, string] {
  let q: Map<string, string[]>;
  try {
    q = parseQs(utf8(body));
  } catch (e) {
    return [null, e instanceof QsTooMany ? 'qua_nhieu_truong' : 'khong_utf8'];
  }
  if ([...q.values()].some((v) => v.length !== 1)) return [null, 'truong_lap'];
  const f = new Map([...q].map(([k, v]) => [k, v[0] as string]));
  const get = (k: string) => f.get(k) ?? '';
  const idx = new Set<number>();
  for (const k of f.keys()) {
    const m = LINE_FIELD.exec(k);
    if (m) idx.add(Number(m[2]));
    else if (!BASE_FIELDS.has(k)) return [null, 'truong_la'];
  }
  if (pyStrip(get('website'))) return [null, 'spam'];
  if (f.get('consent') !== 'b2b' || f.get('policy_version') !== POLICY_VERSION) {
    return [null, 'thieu_dong_y'];
  }
  const org = squash(get('org_name'));
  if (cpLen(org) < 2 || cpLen(org) > 200 || !isPrintable(org) || search(PII_RE, org)) {
    return [null, 'ten_to_chuc'];
  }
  const orgType = f.get('org_type');
  if (orgType === undefined || !ORG_TYPES.includes(orgType)) return [null, 'loai_to_chuc'];
  const reg = get('region');
  const prov = cpLen(reg) <= 100 ? provinceOf(reg) : null;
  if (prov === null) return [null, 'tinh'];
  const cname = squash(get('contact_name'));
  if (cpLen(cname) < 1 || cpLen(cname) > 200 || !isPrintable(cname) || search(PII_RE, cname)) {
    return [null, 'ten_lien_he'];
  }
  let phone: string;
  try {
    phone = normalizePhone(get('phone'));
  } catch {
    return [null, 'sdt'];
  }
  const email = pyStrip(get('email'));
  if (email && (cpLen(email) > 254 || !EMAIL_RE.test(email))) return [null, 'email'];
  if ([...idx].some((i) => i > MAX_LINES)) return [null, 'so_dong'];
  const items: { key: string; qty: number }[] = [];
  const seen = new Set<string>();
  for (let i = 1; i <= MAX_LINES; i++) {
    const sku = pyStrip(get(`sku${i}`));
    const qv = pyStrip(get(`qty${i}`));
    if (!sku && !qv) continue;
    if (!allowed.has(sku)) return [null, 'ma_khong_hop_le'];
    if (!/^[0-9]{1,6}$/.test(qv) || Number(qv) < 1 || Number(qv) > MAX_QTY)
      return [null, 'so_luong'];
    if (seen.has(sku)) return [null, 'dong_trung'];
    seen.add(sku);
    items.push({ key: sku, qty: Number(qv) });
  }
  if (!items.length) return [null, 'so_dong'];
  let needBy: string | null = null;
  const nb = pyStrip(get('need_by'));
  if (nb) {
    if (!/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u.test(nb)) return [null, 'ngay_can'];
    needBy = isoDay(nb);
    if (needBy === null || needBy < today || needBy > addDays(today, 365))
      return [null, 'ngay_can'];
  }
  return [
    {
      org_name: org,
      org_type: orgType,
      region: prov,
      contact: { name: cname, phone, email: email || null },
      items,
      need_by: needBy,
    },
    'ok',
  ];
}

/** Python `json.dumps(x, separators=(',', ':'))` (ensure_ascii mặc định: escape mọi ký tự ngoài
 * U+0020..U+007E). */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** b2r:sha256(tên tổ chức chuẩn hóa | tỉnh | items canonical | ngày VN) — chống gửi trùng. */
export function requestKey(form: Pick<Form, 'org_name' | 'region' | 'items'>, day: string): string {
  const cmp = (a: string, b: string) => (a === b ? 0 : pySorted([a, b])[0] === a ? -1 : 1);
  const items = form.items
    .map((it) => [it.key, it.qty] as [string, number])
    .sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]);
  const raw = `${norm(form.org_name)}|${norm(form.region)}|${asciiJson(items)}|${day}`;
  return `b2r:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}

/** Cửa sổ trượt in-memory (không ghi đĩa): ≤ perIp lượt/IP + ≤ globalLimit lượt toàn server trong
 * windowS. Khóa = HMAC(ip)[:16]; chỉ lượt ĐƯỢC NHẬN mới ghi → số khóa ≤ globalLimit. */
export class RateLimiter {
  readonly ip = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    readonly perIp = 5,
    readonly globalLimit = 60,
    readonly windowS = 3600,
    readonly clock: () => number = () => performance.now() / 1000,
  ) {}

  allow(ip: string): boolean {
    const now = this.clock();
    const cut = now - this.windowS;
    const k = iphash(ip);
    this.all = this.all.filter((t) => t > cut);
    for (const [key, dq] of this.ip) {
      const kept = dq.filter((t) => t > cut);
      if (kept.length) this.ip.set(key, kept);
      else this.ip.delete(key);
    }
    if (this.all.length >= this.globalLimit) return false;
    const dq = this.ip.get(k);
    if (dq !== undefined && dq.length >= this.perIp) return false;
    this.ip.set(k, [...(dq ?? []), now]);
    this.all.push(now);
    return true;
  }
}

// ------------------------------------------------------------ DB (ingest/crm + intake)

const PURPOSES = ['cskh', 'marketing', 'dai_ly', 'b2b'];
const CONSENT_SOURCES = ['form_giay', 'zalo', 'web', 'dien_thoai', 'email', 'truc_tiep'];
const CONTACT_KEYS = ['phone', 'name', 'email', 'address', 'province', 'source'];
const MAX_FIELD: Record<string, number> = { name: 200, email: 254, address: 500 };
const SOURCE_RE = /^[a-z0-9_.:-]{1,50}$/;

function checkBy(by: unknown): string {
  const b = typeof by === 'string' ? pyStrip(by) : '';
  if (!b || cpLen(b) > 100 || !isPrintable(b)) {
    throw new RangeError('--by phải là tên người 1..100 ký tự in được');
  }
  return b;
}

/** `crm.add_contact` (không lead) → [contact_id, mới?]. Trùng SĐT (HMAC) → id cũ + false, KHÔNG ghi đè
 * PII cũ. Ghi qua `crm_add_contact_human` (danh tính theo login — `human_actor`). */
export async function addContact(
  db: Db,
  rec: Record<string, unknown>,
  keys: VaultKeys,
  by: string,
): Promise<[bigint, boolean]> {
  const who = checkBy(by);
  if (Object.keys(rec).some((k) => !CONTACT_KEYS.includes(k))) {
    throw new RangeError(`JSON liên hệ có key không hỗ trợ (chỉ nhận ${CONTACT_KEYS.join('/')})`);
  }
  let phone: string;
  try {
    phone = normalizePhone(rec.phone);
  } catch {
    throw new RangeError('SĐT không hợp lệ');
  }
  for (const [k, cap] of Object.entries(MAX_FIELD)) {
    const v = rec[k];
    if (v !== null && v !== undefined && (typeof v !== 'string' || cpLen(v) > cap)) {
      throw new RangeError(`field '${k}' phải là chuỗi ≤ ${cap} ký tự`);
    }
  }
  let province: string | null = null;
  if (rec.province !== null && rec.province !== undefined && rec.province !== '') {
    province = provinceOf(rec.province);
    if (province === null) {
      throw new RangeError('tỉnh/thành không nhận ra (34 tỉnh sau sáp nhập hoặc tên cũ)');
    }
  }
  const source = rec.source || 'manual';
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    throw new RangeError('source phải khớp [a-z0-9_.:-]{1,50}');
  }
  const f = keys.fernet;
  const { rows } = await callHuman<{ contact_id: string; is_new: boolean }>(
    db,
    'select * from crm_add_contact_human($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      phoneLookup(phone, keys.lookupKey),
      seal(f, phone),
      seal(f, rec.name),
      seal(f, rec.email),
      seal(f, rec.address),
      province,
      source,
      null,
      who,
    ],
    { by: who, block: null, action: 'add_contact', objectType: 'crm', objectId: 'contact' },
  );
  const r = rows[0] as { contact_id: string; is_new: boolean };
  return [BigInt(r.contact_id), r.is_new];
}

/** `crm.record_consent` (không đại lý) → id. Validate TRƯỚC khi ghi; vi phạm → RangeError, 0 dòng. */
export async function recordConsent(
  db: Db,
  contactId: bigint,
  purpose: string,
  granted: boolean,
  source: string,
  by: string,
  evidenceRef: string | null = null,
  policyVersion: string | null = null,
): Promise<bigint> {
  const who = checkBy(by);
  if (!PURPOSES.includes(purpose)) throw new RangeError(`purpose phải là ${PURPOSES.join('|')}`);
  if (!CONSENT_SOURCES.includes(source)) {
    throw new RangeError(`source phải là ${CONSENT_SOURCES.join('|')}`);
  }
  if (purpose === 'dai_ly')
    throw new RangeError('đồng ý dai_ly phải ghi ĐÍCH DANH đại lý (--dealer)');
  const ev = pyStrip(evidenceRef ?? '') || null;
  const pv = pyStrip(policyVersion ?? '') || null;
  if (ev !== null && (cpLen(ev) > 200 || !isPrintable(ev) || search(PII_RE, ev))) {
    throw new RangeError('evidence_ref phải là MÃ biên bản/scan ≤ 200 ký tự, không chứa SĐT/email');
  }
  if (pv !== null && (cpLen(pv) > 50 || !isPrintable(pv))) {
    throw new RangeError('policy_version ≤ 50 ký tự in được');
  }
  if (granted && (ev === null || pv === null)) {
    throw new RangeError('ghi đồng ý cần --evidence và --policy-version');
  }
  const { rows } = await callHuman<{ id: string }>(
    db,
    'select crm_record_consent_human($1, $2, $3, $4, $5, $6, $7, $8) as id',
    [String(contactId), purpose, granted, null, source, ev, pv, who],
    { by: who, block: 'sales', action: 'consent', objectType: 'crm', objectId: contactId },
  );
  return BigInt(rows[0]?.id as string);
}

async function existing(db: Db, key: string): Promise<bigint | null> {
  const { rows } = await db.query<{ id: string }>(
    'select id from b2b_requests where request_key = $1',
    [key],
  );
  return rows[0] ? BigInt(rows[0].id) : null;
}

class Dup extends Error {} // request_key vừa được ghi song song
class Withdrawn extends Error {} // SĐT thuộc contact đã RÚT đồng ý b2b

/** → [request_id, mới?]. Đã có request_key → id cũ, 0 ghi. Ngược lại 1 transaction: contact (vault) →
 * consent b2b → b2b_requests. Form KHÔNG xác minh SĐT (OTP = external-dep): SĐT trùng contact đã RÚT
 * đồng ý b2b → [null, false], rollback, 0 ghi — người lạ gõ SĐT người khác không lật được
 * `can_contact(b2b)` về true. */
export async function intake(
  db: Db,
  form: Form,
  keys: VaultKeys,
  today: string = vnDate(new Date()),
): Promise<[bigint | null, boolean]> {
  const key = requestKey(form, today);
  const rid = await existing(db, key);
  if (rid !== null) return [rid, false];
  const c = form.contact;
  try {
    const id = await withTx(db, async (tx) => {
      const [cid, isNew] = await addContact(
        tx,
        { phone: c.phone, name: c.name, email: c.email, province: form.region, source: SOURCE },
        keys,
        BY,
      );
      if (!isNew) {
        const w = await tx.query<{ granted: boolean }>(
          "select granted from v_consent_current where contact_id = $1 and purpose = 'b2b' and coalesce(recipient_dealer, '') = ''",
          [String(cid)],
        );
        if (w.rows[0]?.granted === false) throw new Withdrawn();
      }
      const consentId = await recordConsent(
        tx,
        cid,
        'b2b',
        true,
        'web',
        BY,
        `B2BF-${evTr(key.slice(4, 20))}`,
        POLICY_VERSION,
      );
      const { rows } = await tx.query<{ id: string }>(
        'insert into b2b_requests (request_key, org_name, org_type, region, items, need_by, contact_id, consent_id, source)' +
          ' values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) on conflict (request_key) do nothing returning id',
        [
          key,
          form.org_name,
          form.org_type,
          form.region,
          JSON.stringify(form.items),
          form.need_by,
          String(cid),
          String(consentId),
          SOURCE,
        ],
      );
      if (!rows[0]) throw new Dup();
      return BigInt(rows[0].id);
    });
    return [id, true];
  } catch (e) {
    if (e instanceof Dup) return [await existing(db, key), false];
    if (e instanceof Withdrawn) return [null, false];
    throw e;
  }
}

// ---------------------------------------------------------------- server

export type DbLease = { db: Db; release: () => Promise<void> };
export type IntakeFn = (
  db: Db,
  form: Form,
  keys: VaultKeys | null,
  today: string,
) => Promise<[bigint | null, boolean]>;
export type ServerOpts = {
  page: string;
  allowed: Iterable<string>;
  keys: VaultKeys | null;
  connect: () => Promise<DbLease | null>;
  limiter?: RateLimiter;
  today?: () => string;
  intake?: IntakeFn;
  log?: { out: (s: string) => void; err: (s: string) => void };
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** Python `urlsplit(path).path` (không chuẩn hóa `..`/%XX). */
function pathOf(url: string | undefined): string {
  return (url ?? '').replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, '').split(/[?#]/)[0] as string;
}

/** Python `headers.get_content_type()`. */
function contentType(v: string | undefined): string {
  if (v === undefined) return 'text/plain';
  const t = pyStrip(v.split(';')[0] as string).toLowerCase();
  return t.split('/').length === 2 ? t : 'text/plain';
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let done = false;
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('close', () => {
      if (!done) reject(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    });
  });
}

/** Tên lớp lỗi kiểu Python cho log (ConnectionResetError…) — không thông điệp/chi tiết. */
function excName(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'ConnectionResetError';
  if (code === 'ECONNABORTED') return 'ConnectionAbortedError';
  if (code === 'ETIMEDOUT' || code === 'ERR_HTTP_REQUEST_TIMEOUT') return 'TimeoutError';
  return pyType(e);
}

/** Server form B2B (chưa listen). Mọi phản hồi đóng kết nối (như HTTP/1.0 của BaseHTTPRequestHandler). */
export function makeServer(o: ServerOpts): http.Server {
  const page = Buffer.from(o.page, 'utf8');
  const allowed = new Set(o.allowed);
  const limiter = o.limiter ?? new RateLimiter();
  const today = o.today ?? (() => vnDate(new Date()));
  const doIntake: IntakeFn = o.intake ?? ((db, f, k, d) => intake(db, f, k as VaultKeys, d));
  const log = o.log ?? { out: (s) => console.log(s), err: (s) => console.error(s) };
  const ipOf = (req: http.IncomingMessage) => iphash(req.socket.remoteAddress ?? '').slice(0, 8);
  const handleError = (e: unknown, req: http.IncomingMessage) => {
    // Thay bản mặc định (in IP thô + traceback): chỉ hash IP + tên lớp lỗi.
    log.err(`[b2b_form] lỗi kết nối ip=${ipOf(req)} ${excName(e)}`);
    req.socket.destroy();
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: string, cache = true) => {
      const b = Buffer.from(body, 'utf8');
      res.writeHead(code, {
        Server: 'b2b-form',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(b.length),
        ...SEC_HEADERS,
        ...(cache ? { 'Cache-Control': 'no-store' } : {}),
        'Content-Security-Policy': CSP,
        Connection: 'close',
      });
      res.end(b);
    };
    const logLine = (code: number, yc: bigint | null = null) =>
      log.out(`[b2b_form] ${code} ip=${ipOf(req)} yc=${yc ?? '-'}`);
    const err = (code: number) => {
      logLine(code);
      send(code, pageErr(MSG[code] as string));
    };
    if (req.method === 'GET') {
      // không đọc body GET — kết nối luôn đóng sau phản hồi
      if (pathOf(req.url) !== PATH) return err(404);
      res.writeHead(200, {
        Server: 'b2b-form',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(page.length),
        ...SEC_HEADERS,
        'Content-Security-Policy': CSP,
        Connection: 'close',
      });
      res.end(page);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(501, { Server: 'b2b-form', 'Content-Length': '0', Connection: 'close' });
      res.end();
      return;
    }
    if (pathOf(req.url) !== PATH) return err(404);
    if (req.headers['transfer-encoding']) return err(411);
    const cl = req.headers['content-length'];
    if (cl === undefined) return err(411);
    if (!/^[0-9]{1,9}$/.test(pyStrip(cl))) return err(400);
    const length = Number(cl);
    if (length > MAX_FORM_BYTES) return err(413);
    if (contentType(req.headers['content-type']) !== FORM_CT) return err(415);
    if (!limiter.allow(req.socket.remoteAddress ?? '')) return err(429);
    const body = await readBody(req);
    if (body.length !== length) return err(400);
    const [form, code] = parseForm(body, allowed, today());
    if (code === 'spam') {
      logLine(200);
      return send(200, PAGE_OK);
    }
    if (form === null) return err(400);
    const lease = await o.connect();
    if (lease === null) return err(503);
    let rid: bigint | null;
    try {
      [rid] = await doIntake(lease.db, form, o.keys, today());
    } catch (e) {
      if (e instanceof RangeError) return err(400);
      if (isDbError(e) || e instanceof VaultKeyError) return err(503);
      throw e;
    } finally {
      await lease.release().catch(() => {}); // đóng conn không làm sập
    }
    logLine(200, rid);
    // Trang công khai KHÔNG hiện mã YC: nhận mới / gửi lại / SĐT đã rút đồng ý / spam cùng 1 body —
    // không thành oracle dò vault, không lộ id tuần tự. Mã YC chỉ ở log nội bộ + CLI GĐ.
    send(200, PAGE_OK);
  }

  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => handleError(e, req));
  });
  // Chặn client treo giữa chừng (slowloris) — Python `Handler.timeout = 10`.
  srv.headersTimeout = 10_000;
  srv.requestTimeout = 10_000;
  srv.setTimeout(10_000, (s) => s.destroy());
  srv.on('clientError', (e, socket) => {
    const ip = (socket as Socket).remoteAddress ?? '';
    log.err(`[b2b_form] lỗi kết nối ip=${iphash(ip).slice(0, 8)} ${excName(e)}`);
    if (socket.writable && (e as { code?: string }).code !== 'ECONNRESET') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else socket.destroy();
  });
  return srv;
}

export function enabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['1', 'true', 'yes'].includes(pyStrip(env.B2B_FORM_ENABLED ?? '').toLowerCase());
}
