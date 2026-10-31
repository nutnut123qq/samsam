import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, normalize, sep } from 'node:path';
import { createPool } from '@samsam/core/db';
import type { Env } from '@samsam/core/env';
import type { Db } from '@samsam/core/ops/deps';
import { dmy, vnDate } from '@samsam/core/ops/period';
import { cpLen, isPlainObject, isPrintable, pyInt, squash } from '@samsam/core/ops/py';
import { isDbError, pgErrName } from '@samsam/core/ops/tx';
import { dataPath } from '@samsam/core/paths';
import {
  checkGenerate,
  RolloutBlocked,
  isHuman as roIsHuman,
  useReason,
} from '@samsam/core/rollout/rollout';
import { cliGate, normName } from '@samsam/core/security/auth';
import { checkPublish, check as guardrailCheck, loadRules } from '@samsam/core/security/guardrail';
import { maskPii } from '@samsam/core/security/pii';
import { casefold, isDigit, pyStrip, stripCombining } from '@samsam/core/security/py';

// Port `pipelines/qr_trace.py` (v9.4 Lô + QR truy xuất — WP13 VT, thí điểm mật ong, 3 chữ ký,
// phương án B). Luồng NGƯỜI: mọi bước ghi cần `--by`, đi qua function DB SECURITY DEFINER
// (`link_lot_origin`/`unlink_lot_origin`/`sign_qr_lot`/`issue_qr`/`revoke_qr`) — module KHÔNG insert
// thẳng `approvals`/`lot_origins`/`qr_signatures`/`qr_codes`.
//   link    GĐ Sản xuất ánh xạ lô ↔ nhật ký `thu hoạch` ĐÃ CHAIN
//   preview lời văn trang + sha + guardrail kênh `qr` + vai đã ký/còn thiếu
//   sign    3 vai (GĐ SX, GĐ vùng trồng, Pháp chế/QA) — 3 người khác nhau — ký CÙNG bản chụp + lời văn
//   issue   mã ngẫu nhiên 128 bit (không suy ra được mã lô) — DB kiểm đủ 3 chữ ký
//   revoke  thu hồi mã → trang "đã thu hồi"
//   site    trang tĩnh `data/qr_site/<code>/index.html`; farming-03.2 chưa cho dùng (chạy thử/tắt,
//           HĐ 6.7) → mã còn hiệu lực KHÔNG xuất trang, trang đã xuất bị THAY bằng "tạm ngưng" +
//           gỡ ảnh không còn trang dùng. Thu hồi vẫn xuất.
//   planb   bản tin phương án B theo mốc cấu hình (tem không QR — GĐ quyết)
// Danh tính `--by` = TỰ KHAI + allowlist `data/qr_signers.json` (ship rỗng) + `cliGate`. Không sinh ảnh
// QR, không gửi, không in, không gọi LLM. Trang công khai: KHÔNG tọa độ/vị trí/mã khoảnh, KHÔNG
// tên/SĐT/email người — mọi lời văn qua `checkPublish(channel="qr")` + probe PII/tọa độ.
// Hàm thuần nhận `today` làm tham số — chỉ CLI đọc đồng hồ.

export const CONFIG_FILE = dataPath('qr_config.json');
export const SIGNERS_FILE = dataPath('qr_signers.json');
export const SITE_DIR = dataPath('qr_site');
export const GOLDEN_FILE = dataPath('golden_skus.json');

export const ROLES = {
  gd_san_xuat: 'GĐ Sản xuất',
  gd_vung_trong: 'GĐ vùng trồng',
  phap_che_qa: 'Pháp chế/QA',
} as const;
export type Role = keyof typeof ROLES;
export const ROLE_KEYS = Object.keys(ROLES) as Role[];
export const CHANNEL = 'qr';
export const MAX_REGION = 120;
export const CODE_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
/** Python `\d{1,3}[.,]\d{4,}` (`\d` Unicode). */
export const COORD_RE = /\p{Nd}{1,3}[.,]\p{Nd}{4,}/u;
export const TITLE = 'Truy xuất nguồn gốc sản phẩm';
export const SAMPLE_LINE = '[MẪU] dữ liệu mẫu — không dùng in tem';
export const REVOKED = 'Mã truy xuất này đã thu hồi';
export const PAUSED = 'Trang truy xuất của mã này đang tạm ngưng';
export const MEDIA_EXT = ['jpg', 'png'];
// production.py (LOT_RE / MAX_BY_LEN / MAX_NOTE_LEN / MAX_FILE_BYTES) + scenario.DATE_MIN/MAX.
export const LOT_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const MAX_BY_LEN = 100;
export const MAX_NOTE_LEN = 500;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2100-12-31';
// v13 vá review (F03): ánh xạ lô (farming-03.1) và mã/trang QR (farming-03.2) đọc giai đoạn HĐ 6.7.
export const FEATURE_LINK = 'farming-03.1';
export const FEATURE_QR = 'farming-03.2';
// v14.2: vai ký → khối (log từ chối); người được ký/phát hành/thu hồi = allowlist qr_signers.json.
const ROLE_BLOCK: Record<Role, string> = {
  gd_san_xuat: 'production',
  gd_vung_trong: 'farming',
  phap_che_qa: 'legal_hr',
};
const PROG = 'python -m pipelines.qr_trace';

/** Cấu hình/dữ liệu QR không dùng được — fail-closed (Python QrError(ValueError)). */
export class QrError extends RangeError {
  override name = 'QrError';
}

export type Io = { out: (s: string) => void; err: (s: string) => void };
export const STD_IO: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };
export type DbLease = { db: Db; release: () => Promise<void> };
export type Product = Record<string, unknown> & { name: string };
export type Golden = Map<string, Product>;
export type QrConfig = {
  status: string;
  pilot_skus: string[];
  region_text: string;
  plan_b_deadline: string; // 'YYYY-MM-DD'
  public_base_url: string;
};
export type Lot = {
  lot_code: string;
  sku_key: string;
  mfg_date: string; // 'YYYY-MM-DD'
  exp_date: string;
  intake_status: string;
  source?: string | null;
};
export type Origin = { plot_log_id: string | number; harvest: string; media: string[] };
export type Signers = Record<Role, Set<string>>;

// ------------------------------------------------------------------ tiện ích kiểu Python

/** Python `date.fromisoformat` (bản C 3.12): độ dài UTF-8 7/8/10, YYYY-MM-DD | YYYYMMDD | tuần ISO
 * `YYYY-Www[-D]` / `YYYYWww[D]`; ký tự thừa sau phần đã đọc bị BỎ QUA (như C) → 'YYYY-MM-DD' | null. */
export function pyDateFromIso(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const b = Buffer.from(s, 'utf8');
  if (![7, 8, 10].includes(b.length)) return null;
  let p = 0;
  const digits = (n: number): number | null => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = (b[p] ?? 0) - 0x30;
      p++;
      if (c < 0 || c > 9) return null;
      v = v * 10 + c;
    }
    return v;
  };
  const year = digits(4);
  if (year === null) return null;
  const sepUsed = b[p] === 0x2d;
  if (sepUsed) p++;
  if (b[p] === 0x57) {
    p++;
    const week = digits(2);
    if (week === null) return null;
    let day = 1;
    if (p < b.length) {
      if (sepUsed && b[p++] !== 0x2d) return null;
      const d = digits(1);
      if (d === null) return null;
      day = d;
    }
    return isoWeekToYmd(year, week, day);
  }
  const month = digits(2);
  if (month === null) return null;
  if (sepUsed && b[p++] !== 0x2d) return null;
  const day = digits(2);
  if (day === null) return null;
  return ymd(year, month, day);
}

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

function isoWeekToYmd(year: number, week: number, day: number): string | null {
  if (year < 1 || year > 9999) return null;
  const jan1 = new Date(Date.UTC(2000, 0, 1));
  jan1.setUTCFullYear(year);
  // Python ord % 7: 1/1/0001 = 1 (thứ Hai) → thứ Hai=1 … Chủ nhật=0 (= getUTCDay()).
  const firstWeekday = jan1.getUTCDay();
  if (week <= 0 || week >= 53) {
    if (!(week === 53 && (firstWeekday === 4 || (firstWeekday === 3 && isLeap(year))))) {
      return null;
    }
  }
  if (day <= 0 || day >= 8) return null;
  // thứ Hai của tuần 1 ISO = thứ Hai của tuần chứa ngày 4/1.
  const jan4 = new Date(jan1.getTime() + 3 * 86_400_000);
  const monday1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000;
  const t = new Date(monday1 + ((week - 1) * 7 + day - 1) * 86_400_000);
  const y = t.getUTCFullYear();
  if (y < 1 || y > 9999) return null;
  return ymd(y, t.getUTCMonth() + 1, t.getUTCDate());
}

/** `production._clean` (= market_csv._clean): ký tự không in được → '?', cắt n code point. */
export function clean(v: unknown, n = 80): string {
  const s = typeof v === 'string' ? v : String(v);
  return Array.from(s)
    .map((c) => (isPrintable(c) ? c : '?'))
    .slice(0, n)
    .join('');
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

/** So chuỗi theo code point (Python `sorted`). */
export function cpCmp(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d) return d;
  }
  return x.length - y.length;
}

/** Tên lỗi Python của lỗi đọc file Node (FileNotFoundError/PermissionError/...). */
export function osErrName(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'ENOTDIR') return 'NotADirectoryError';
  return 'OSError';
}

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `production.read_json(path, "")`: thiếu / rỗng / JSON hỏng / không phải object / `{}` / chỉ
 * `_doc` / quá 5 MB → QrError (caller dừng TRƯỚC khi connect). UTF-8 có BOM được nhận (utf-8-sig).
 * KHÁC Python có chủ đích: NaN/Infinity bị từ chối (JSON.parse) — chặt hơn. */
export function readJsonDoc(path: string): Record<string, unknown> {
  const name = basename(path);
  let raw: Buffer;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw new QrError(`${name} quá lớn`);
    raw = readFileSync(path);
  } catch (e) {
    if (e instanceof QrError) throw e;
    if ((e as { code?: string })?.code === 'ENOENT') throw new QrError(`thiếu file ${name}`);
    throw new QrError(`không đọc được ${name} (${osErrName(e)})`);
  }
  let text: string;
  try {
    text = DECODER.decode(raw);
  } catch {
    throw new QrError(`không đọc được ${name} (UnicodeDecodeError)`);
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  if (!pyStrip(text)) throw new QrError(`${name} rỗng`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new QrError(`${name} JSON hỏng: JSONDecodeError`);
  }
  if (!isPlainObject(doc)) throw new QrError(`${name}: root phải là object`);
  if (!Object.keys(doc).some((k) => k !== '_doc')) {
    throw new QrError(`${name}: không có dữ liệu (0 record)`);
  }
  return doc;
}

// ------------------------------------------------------------------ cấu hình (fail-closed TRƯỚC connect)

/** `golden_store.read_golden` + lọc SKU → Map sku_key → SKU. Không có dữ liệu → QrError. KHÁC Python:
 * thông điệp JSON hỏng/UTF-8 không kèm chi tiết parser Python. */
export function goldenMap(path: string = GOLDEN_FILE): Golden {
  const fail = (why: string): never => {
    throw new QrError(`golden: ${why}`);
  };
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) fail(`thiếu file ${path}`);
  let text = '';
  try {
    text = DECODER.decode(readFileSync(path));
  } catch {
    fail(`${path} không phải UTF-8`);
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  if (!pyStrip(text)) fail(`${path} rỗng`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    fail(`${path} JSON hỏng: ${(e as Error).message}`);
  }
  const skus = isPlainObject(doc) ? doc.skus : undefined;
  const truthy =
    Array.isArray(skus) || typeof skus === 'string'
      ? skus.length > 0
      : isPlainObject(skus)
        ? Object.keys(skus).length > 0
        : Boolean(skus);
  if (!truthy) fail(`${path} không có SKU nào (0 record) — không nạp`);
  const out: Golden = new Map();
  if (Array.isArray(skus)) {
    for (const s of skus) {
      if (isPlainObject(s) && typeof s.sku_key === 'string') out.set(s.sku_key, s as Product);
    }
  }
  return out;
}

/** Python `_fold`: casefold → NFD → bỏ dấu kết hợp → đ→d. */
function fold(s: string): string {
  return stripCombining(casefold(s).normalize('NFD')).replaceAll('đ', 'd');
}

export function validateConfig(doc: Record<string, unknown>, golden: Golden): QrConfig {
  const status = doc.status;
  if (typeof status !== 'string' || !pyStrip(status))
    throw new QrError("qr_config: thiếu 'status'");
  const skus = doc.pilot_skus;
  if (!Array.isArray(skus) || !skus.length || !skus.every((k) => typeof k === 'string')) {
    throw new QrError("qr_config: 'pilot_skus' phải là list chuỗi không rỗng");
  }
  const list = skus as string[];
  if (new Set(list).size !== list.length) throw new QrError("qr_config: 'pilot_skus' bị trùng");
  for (const k of list) {
    const g = golden.get(k);
    if (!g) throw new QrError(`qr_config: SKU ${clean(k, 60)} không có trong golden`);
    if (g.category === 'alcohol') throw new QrError(`qr_config: ${k} là rượu — không thí điểm QR`);
  }
  const region = doc.region_text;
  const r = typeof region === 'string' ? pyStrip(region) : '';
  if (typeof region !== 'string' || !(cpLen(r) > 0 && cpLen(r) <= MAX_REGION)) {
    throw new QrError(`qr_config: 'region_text' 1..${MAX_REGION} ký tự`);
  }
  if (Array.from(r).some(isDigit) || !isPrintable(r)) {
    throw new QrError(
      "qr_config: 'region_text' không được có chữ số/ký tự điều khiển (chặn tọa độ, số nhà)",
    );
  }
  if (squash(fold(r)).includes('ngoc linh')) {
    throw new QrError(
      "qr_config: 'region_text' không dùng 'Ngọc Linh' (chưa SKU nào có quyết định chỉ dẫn địa lý)",
    );
  }
  if (guardrailCheck(r).ok !== true) {
    throw new QrError("qr_config: 'region_text' không qua guardrail");
  }
  const deadline = pyDateFromIso(doc.plan_b_deadline);
  if (deadline === null) throw new QrError("qr_config: 'plan_b_deadline' phải là YYYY-MM-DD");
  const base = doc.public_base_url;
  if (typeof base !== 'string') throw new QrError("qr_config: 'public_base_url' phải là chuỗi");
  const u = pyStrip(base);
  if (
    u &&
    (!u.startsWith('https://') ||
      cpLen(u) <= 8 ||
      [...'?#<>"\' '].some((c) => u.includes(c)) ||
      !isPrintable(u))
  ) {
    throw new QrError("qr_config: 'public_base_url' rỗng hoặc https://... không query");
  }
  return {
    status: pyStrip(status),
    pilot_skus: [...list],
    region_text: r,
    plan_b_deadline: deadline,
    public_base_url: u.replace(/\/+$/, ''),
  };
}

export function loadConfig(path: string = CONFIG_FILE, golden?: Golden): QrConfig {
  return validateConfig(readJsonDoc(path), golden ?? goldenMap());
}

export function validateSigners(doc: Record<string, unknown>): Signers {
  const status = doc.status;
  if (typeof status !== 'string' || !pyStrip(status))
    throw new QrError("qr_signers: thiếu 'status'");
  const roles = doc.roles;
  const keys = isPlainObject(roles) ? Object.keys(roles) : null;
  if (
    !isPlainObject(roles) ||
    keys?.length !== ROLE_KEYS.length ||
    !ROLE_KEYS.every((r) => Object.hasOwn(roles, r))
  ) {
    throw new QrError(`qr_signers: 'roles' phải có đúng 3 vai ${ROLE_KEYS.join(', ')}`);
  }
  const out = {} as Signers;
  const owner = new Map<string, Role>();
  for (const role of ROLE_KEYS) {
    const names = roles[role];
    if (!Array.isArray(names)) throw new QrError(`qr_signers: ${role} phải là list`);
    out[role] = new Set();
    for (const n of names) {
      if (
        typeof n !== 'string' ||
        !pyStrip(n) ||
        cpLen(pyStrip(n)) > MAX_BY_LEN ||
        !isPrintable(n)
      ) {
        throw new QrError(`qr_signers: ${role} có tên không hợp lệ`);
      }
      const k = normName(n);
      const prev = owner.get(k);
      if (prev !== undefined && prev !== role) {
        throw new QrError(`qr_signers: 1 người không được nằm ở 2 vai (${prev} và ${role})`);
      }
      owner.set(k, role);
      out[role].add(k);
    }
  }
  return out;
}

export function loadSigners(path: string = SIGNERS_FILE): Signers {
  return validateSigners(readJsonDoc(path));
}

// ------------------------------------------------------------------ lời văn trang + guardrail (thuần)

/** `_canonical`: câu khuyến cáo chuẩn của luật guardrail ĐÃ kiểm (`_load_rules(DATA_DIR)`) → lỗi
 * cấu hình → QrError(`guardrail: <lý do>`). */
export function canonical(): string {
  const [cfg, why] = loadRules();
  if (cfg === null) throw new QrError(`guardrail: ${why}`);
  return cfg.canonical;
}

function lotLines(lot: Lot, product: Product): string[] {
  return [
    product.name,
    `Lô: ${lot.lot_code}`,
    `Ngày sản xuất: ${dmy(lot.mfg_date)}`,
    `Hạn sử dụng: ${dmy(lot.exp_date)}`,
  ];
}

/** Dòng cuối (mẫu + khuyến cáo TPBVSK) — tách riêng để test bỏ đi được (như Python monkeypatch). */
export const tail = {
  lines(lot: Lot, product: Product): string[] {
    const out = lot.source === 'sample' ? [SAMPLE_LINE] : [];
    if (product.category === 'tpbvsk') out.push(`${canonical()}.`);
    return out;
  },
};

/** Lời văn trang công khai (bản 3 vai ký) — tất định. Chỉ tên SKU, lô, NSX, HSD, vùng mức tỉnh,
 * tháng thu hoạch, số ảnh. KHÔNG mã/vị trí khoảnh, nội dung/tác giả nhật ký, tên người ký, giá. */
export function pageText(
  lot: Lot,
  origins: Origin[],
  product: Product,
  config: Pick<QrConfig, 'region_text'>,
): string {
  const lines = [TITLE, ...lotLines(lot, product)];
  lines.push(`Vùng nguyên liệu: ${config.region_text}`);
  const months = [...new Set(origins.map((o) => o.harvest.slice(0, 7)))].sort(cpCmp);
  if (months.length) {
    lines.push(
      `Thu hoạch: ${months.map((ym) => `tháng ${ym.slice(5, 7)}/${Number(ym.slice(0, 4))}`).join(', ')}`,
    );
  }
  const n = origins.reduce((a, o) => a + o.media.length, 0);
  if (n) lines.push(`Ảnh tư liệu vườn: ${n} ảnh`);
  return `${[...lines, ...tail.lines(lot, product)].join('\n')}\n`;
}

/** Lời văn tem KHÔNG QR (phương án B): tên SKU, lô, NSX, HSD. */
export function stampText(lot: Lot, product: Product): string {
  return `${[...lotLines(lot, product), ...tail.lines(lot, product)].join('\n')}\n`;
}

export function textSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** [] = được công khai. Guardrail kênh `qr` (luật web) + probe PII (maskPii đổi text → có SĐT/email)
 * + tọa độ thập phân. */
export function checkPage(text: string, sku: string): string[] {
  const r = checkPublish(text, { channel: CHANNEL, contentType: 'post', sku, isAi: false });
  const codes: string[] = [];
  if (r.ok !== true) {
    const set = new Set(r.violations.map((v) => v.code));
    codes.push(...(set.size ? [...set].sort(cpCmp) : ['guardrail']));
  }
  if (maskPii(text) !== text) codes.push('pii');
  if (COORD_RE.test(text)) codes.push('toa_do');
  return codes;
}

/** Mã công khai: 128 bit ngẫu nhiên — không dẫn xuất từ lô/thời gian. Không bắt đầu bằng '-'
 * (`revoke --code -x` bị đọc thành cờ). */
export function newCode(rand: () => string = () => randomBytes(16).toString('base64url')): string {
  for (;;) {
    const code = rand();
    if (!code.startsWith('-')) return code;
  }
}

const CSS =
  'body{font-family:system-ui,sans-serif;max-width:40rem;margin:0 auto;' +
  'padding:1rem;line-height:1.5;color:#222;background:#fff}' +
  'h1{font-size:1.3rem}h2{font-size:1.1rem}' +
  'img{max-width:100%;height:auto;margin:.5rem 0}';

function htmlDoc(body: string[]): string {
  return (
    '<!doctype html>\n<html lang="vi"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, ' +
    'initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>${htmlEscape(TITLE)}</title><style>${CSS}</style>` +
    `</head><body>\n${body.join('\n')}\n</body></html>\n`
  );
}

/** Trang tĩnh: 0 script, 0 URL ngoài; ảnh tham chiếu tương đối. */
export function pageHtml(text: string, media: [string, string][]): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  const body = [`<h1>${htmlEscape(lines[0] ?? '')}</h1>`, `<h2>${htmlEscape(lines[1] ?? '')}</h2>`];
  for (const x of lines.slice(2)) body.push(`<p>${htmlEscape(x)}</p>`);
  for (const [sha, ext] of media) {
    if (HEX64_RE.test(sha) && MEDIA_EXT.includes(ext)) {
      body.push(`<img src="../media/${sha}.${ext}" alt="Ảnh tư liệu vườn">`);
    }
  }
  return htmlDoc(body);
}

export function revokedHtml(day: string): string {
  return htmlDoc([
    `<h1>${htmlEscape(TITLE)}</h1>`,
    `<p>${REVOKED}.</p>`,
    `<p>Ngày thu hồi: ${dmy(day)}</p>`,
  ]);
}

/** Trang thay thế khi tính năng chưa được dùng — không lời văn lô. */
export function pausedHtml(): string {
  return htmlDoc([`<h1>${htmlEscape(TITLE)}</h1>`, `<p>${PAUSED}.</p>`]);
}

const EXIF_MARK = Buffer.from('Exif\x00\x00', 'latin1');
const XMP_MARK = Buffer.from('ns.adobe.com/xap', 'latin1');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_META = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

/** Ảnh còn khối metadata (EXIF/XMP/IPTC/comment/text)? Duyệt marker JPEG tới SOS / chunk PNG tới
 * IEND (không dò `GPS` 3 byte). Lớp 2: marker dài `Exif\0\0` / `ns.adobe.com/xap` ở BẤT KỲ đâu + byte
 * thừa sau EOI/IEND → true (bắt EXIF nhét sau SOS/EOI). Hỏng/định dạng khác → true. */
export function hasMetadata(data: Uint8Array, ext: string): boolean {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.indexOf(EXIF_MARK) >= 0 || buf.indexOf(XMP_MARK) >= 0) return true;
  const n = buf.length;
  if (ext === 'jpg') {
    if (n < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return true;
    let i = 2;
    while (i + 4 <= n) {
      if (buf[i] !== 0xff) return true;
      const m = buf[i + 1] as number;
      if (m === 0xd9 || m === 0xda) return !(n >= 2 && buf[n - 2] === 0xff && buf[n - 1] === 0xd9);
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if ((m >= 0xe1 && m <= 0xef && m !== 0xe2) || m === 0xfe) return true;
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return true;
  }
  if (ext === 'png') {
    if (n < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return true;
    let i = 8;
    while (i + 8 <= n) {
      const len = buf.readUInt32BE(i);
      const kind = buf.toString('latin1', i + 4, i + 8);
      if (PNG_META.has(kind)) return true;
      if (kind === 'IEND') return i + 12 + len !== n;
      i += 12 + len;
    }
    return true;
  }
  return true;
}

export type PlanLot = Lot & { n_origins: number; issued: boolean };

const dayNum = (d: string): number => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(2000, m - 1, dd));
  t.setUTCFullYear(y);
  return t.getTime() / 86_400_000;
};

/** Bản tin phương án B — tất định, CHỈ tên vai (không tên người). Trước mốc: đếm ngày. Từ mốc:
 * ĐỀ XUẤT tem không QR cho lô đã passed (GĐ vùng trồng quyết — agent KHÔNG tự đổi tem). */
export function planBReport(
  lots: PlanLot[],
  signedRoles: Map<string, Set<string>>,
  today: string,
  config: QrConfig,
  golden: Golden,
): string {
  const dl = config.plan_b_deadline;
  const past = today >= dl;
  const out = [
    `Bản tin phương án B — tem QR thí điểm (ngày ${dmy(today)})`,
    `Cấu hình: ${config.status}`,
  ];
  if (past) {
    out.push(
      `ĐỀ XUẤT phương án B (mốc ${dmy(dl)}) — GĐ vùng trồng quyết, báo Sales + Hạ tầng; agent KHÔNG tự đổi tem`,
    );
  } else {
    out.push(`Mốc phương án B ${dmy(dl)}: còn ${dayNum(dl) - dayNum(today)} ngày — chưa đề xuất`);
  }
  const sorted = [...lots].sort((a, b) => cpCmp(a.lot_code, b.lot_code));
  out.push('Đã phát hành mã QR:');
  const done = sorted.filter((x) => x.issued);
  if (done.length) for (const x of done) out.push(`- lô ${x.lot_code} (${x.sku_key})`);
  else out.push('- không có');
  out.push('Chưa phát hành:');
  const todo = sorted.filter((x) => !x.issued);
  if (!todo.length) out.push('- không có');
  for (const x of todo) {
    const product = golden.get(x.sku_key) ?? ({ name: x.sku_key } as Product);
    const miss: string[] = [];
    if (x.intake_status !== 'passed') miss.push('kiểm nhập passed');
    if (!x.n_origins) miss.push('nguồn vùng trồng đã chain');
    const roles = signedRoles.get(x.lot_code) ?? new Set<string>();
    const left = ROLE_KEYS.filter((r) => !roles.has(r)).map((r) => ROLES[r]);
    if (left.length) miss.push(`chữ ký vai ${left.join(', ')}`);
    const tag = x.source === 'sample' ? ' [MẪU]' : '';
    out.push(
      `- lô ${x.lot_code}${tag} — ${product.name}: còn thiếu ${miss.join('; ') || 'không (chờ phát hành)'}`,
    );
    if (!past) continue;
    if (x.intake_status !== 'passed') {
      out.push('    chưa đủ điều kiện in tem');
      continue;
    }
    const text = stampText(x, product);
    const bad = checkPage(text, x.sku_key);
    out.push(
      `    Lời văn tem KHÔNG QR (guardrail: ${bad.length ? `FAIL ${bad.join(', ')}` : 'OK'}):`,
    );
    for (const ln of text.replace(/\n+$/, '').split('\n')) out.push(`      ${ln}`);
  }
  return `${out.join('\n')}\n`;
}

/** `production.qr_payload`: điểm nối QR — chỉ lô đã kiểm nhập 'passed'. */
export function qrPayload(lot: Lot | null): Record<string, string> | null {
  if (lot?.intake_status !== 'passed') return null;
  return { lot_code: lot.lot_code, sku_key: lot.sku_key, exp_date: lot.exp_date };
}

// ------------------------------------------------------------------ DB

const ymdSql = (col: string): string => `to_char(${col}, 'YYYY-MM-DD')`;

export async function fetchLot(db: Db, lotCode: string): Promise<Lot | null> {
  const r = await db.query<Lot>(
    `select lot_code, sku_key, ${ymdSql('mfg_date')} as mfg_date, ${ymdSql('exp_date')} as exp_date,` +
      ' intake_status, source from production_lots where lot_code = $1',
    [lotCode],
  );
  return r.rows[0] ?? null;
}

export async function fetchOrigins(db: Db, lotCode: string): Promise<Origin[]> {
  const r = await db.query<Origin>(
    'select o.plot_log_id::text as plot_log_id,' +
      ` ${ymdSql("(g.ts at time zone 'Asia/Ho_Chi_Minh')::date")} as harvest,` +
      ' o.media_sha256 as media from lot_origins o join plot_logs g on g.id = o.plot_log_id' +
      ' where o.lot_code = $1 order by o.plot_log_id',
    [lotCode],
  );
  return r.rows.map((x) => ({ ...x, media: [...(x.media ?? [])] }));
}

export type LotState = {
  lot: Lot;
  origins: Origin[];
  text: string;
  tsha: string;
  snap: string;
  roles: Set<string>;
  active: string | null;
};

/** Lô + nguồn + lời văn + sha hiện tại. Lô không có / ngoài pilot_skus → QrError. */
export async function lotState(
  db: Db,
  lotCode: string,
  cfg: QrConfig,
  golden: Golden,
): Promise<LotState> {
  const lot = await fetchLot(db, lotCode);
  if (lot === null) throw new QrError(`không có lô ${lotCode}`);
  if (!cfg.pilot_skus.includes(lot.sku_key)) {
    throw new QrError(`lô ${lotCode}: SKU ${lot.sku_key} ngoài pilot_skus — không làm QR`);
  }
  const origins = await fetchOrigins(db, lotCode);
  const text = pageText(lot, origins, golden.get(lot.sku_key) as Product, cfg);
  const tsha = textSha(text);
  const snap = (await db.query<{ s: string }>('select qr_lot_snapshot_sha($1) as s', [lotCode]))
    .rows[0]?.s as string;
  const roles = new Set(
    (
      await db.query<{ role: string }>(
        'select role from qr_signatures where lot_code = $1 and snapshot_sha256 = $2 and' +
          ' text_sha256 = $3',
        [lotCode, snap, tsha],
      )
    ).rows.map((x) => x.role),
  );
  const active = (
    await db.query<{ code: string }>(
      'select code from qr_codes where lot_code = $1 and revoked_at is null',
      [lotCode],
    )
  ).rows[0];
  return { lot, origins, text, tsha, snap, roles, active: active ? active.code : null };
}

/** [(sha, ext, bytes)] — chỉ khi file kho khớp sha256 trong DB và không còn khối metadata. Thiếu
 * env/file / lệch → QrError (không phát hành thiếu: ảnh nằm trong bản đã ký). */
export async function mediaFiles(
  db: Db,
  origins: Origin[],
  mediaDir: string | undefined,
): Promise<[string, string, Buffer][]> {
  const shas = [...new Set(origins.flatMap((o) => o.media))].sort(cpCmp);
  if (!shas.length) return [];
  if (!mediaDir) throw new QrError('thiếu env GARDEN_MEDIA_DIR (kho ảnh ngoài repo)');
  const extOf = new Map(
    (
      await db.query<{ sha256: string; ext: string }>(
        'select sha256, ext from garden_media where sha256 = any($1)',
        [shas],
      )
    ).rows.map((x) => [x.sha256, x.ext]),
  );
  const out: [string, string, Buffer][] = [];
  for (const sha of shas) {
    const ext = extOf.get(sha);
    if (ext === undefined || !MEDIA_EXT.includes(ext)) {
      throw new QrError(`ảnh ${sha.slice(0, 12)} không có trong garden_media`);
    }
    let data: Buffer;
    try {
      data = readFileSync(join(mediaDir, sha.slice(0, 2), `${sha}.${ext}`));
    } catch (e) {
      throw new QrError(`thiếu file ảnh ${sha.slice(0, 12)} trong kho (${osErrName(e)})`);
    }
    if (createHash('sha256').update(data).digest('hex') !== sha) {
      throw new QrError(`file ảnh ${sha.slice(0, 12)} lệch sha256 (bị tráo?)`);
    }
    if (hasMetadata(data, ext))
      throw new QrError(`file ảnh ${sha.slice(0, 12)} còn metadata EXIF/XMP`);
    out.push([sha, ext, data]);
  }
  return out;
}

export function writeAtomic(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ------------------------------------------------------------------ CLI

/** `production._open`: `DATABASE_URL` → kết nối | null (in lý do `[err]` ra stdout). */
export async function openDatabaseUrl(env: Env, io: Io): Promise<DbLease | null> {
  const dsn = pyStrip(env.DATABASE_URL ?? '');
  if (!dsn) {
    io.out('[err] thiếu DATABASE_URL trong .env');
    return null;
  }
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(dsn, {}, env);
    await pool.query('select 1');
  } catch (e) {
    await pool?.end().catch(() => {});
    io.out(
      `[err] không kết nối được Postgres: ${isDbError(e) ? 'OperationalError' : (e as Error).name}`,
    );
    return null;
  }
  const p = pool;
  return { db: p, release: () => p.end() };
}

export type QrOpts = {
  lot?: string;
  log?: string;
  media?: string[];
  by?: string;
  role?: string;
  note?: string;
  code?: string;
  reason?: string;
  out?: string;
  date?: string;
};

export type QrDeps = {
  io?: Io;
  env?: Env;
  connect?: () => Promise<DbLease | null>;
  /** Ngày VN hôm nay 'YYYY-MM-DD' (chỉ CLI đọc đồng hồ). */
  today?: () => string;
  newCode?: () => string;
  configFile?: string;
  signersFile?: string;
  goldenFile?: string;
  siteDir?: string;
};

const COMMANDS = ['link', 'unlink', 'preview', 'sign', 'issue', 'revoke', 'site', 'planb'] as const;
const ALLOWED: Record<string, (keyof QrOpts)[]> = {
  link: ['lot', 'log', 'media', 'by'],
  unlink: ['lot', 'log', 'by'],
  preview: ['lot'],
  sign: ['lot', 'role', 'by', 'note'],
  issue: ['lot', 'by'],
  revoke: ['code', 'by', 'reason'],
  site: ['out'],
  planb: ['date'],
};
const REQUIRED: Record<string, (keyof QrOpts)[]> = {
  link: ['lot', 'log', 'by'],
  unlink: ['lot', 'log', 'by'],
  preview: ['lot'],
  sign: ['lot', 'role', 'by'],
  issue: ['lot', 'by'],
  revoke: ['code', 'by'],
  site: [],
  planb: [],
};
const FLAG: Record<keyof QrOpts, string> = {
  lot: '--lot',
  log: '--log',
  media: '--media',
  by: '--by',
  role: '--role',
  note: '--note',
  code: '--code',
  reason: '--reason',
  out: '--out',
  date: '--date',
};

class ArgError extends Error {}

// Kiểu argparse của Python: giá trị sai → `argument --x: <lý do>` exit 2 TRƯỚC khi connect.
export const argTypes = {
  by(s: string): string {
    const v = pyStrip(s);
    if (!v || cpLen(v) > MAX_BY_LEN || !isPrintable(v)) {
      throw new ArgError(`tên người không rỗng, tối đa ${MAX_BY_LEN} ký tự in được`);
    }
    return v;
  },
  note(s: string): string {
    const v = pyStrip(s);
    if (cpLen(v) > MAX_NOTE_LEN || !isPrintable(v)) {
      throw new ArgError(`note tối đa ${MAX_NOTE_LEN} ký tự in được`);
    }
    return v;
  },
  lot(s: string): string {
    if (!LOT_RE.test(s)) throw new ArgError(`mã lô phải khớp ${LOT_RE.source}`);
    return s;
  },
  date(s: string): string {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? pyDateFromIso(s) : null;
    if (d === null || d < DATE_MIN || d > DATE_MAX) {
      throw new ArgError(`ngày YYYY-MM-DD trong ${DATE_MIN}..${DATE_MAX}`);
    }
    return d;
  },
  log(s: string): string {
    const v = pyInt(s);
    if (v === null) throw new ArgError('id nhật ký là số nguyên');
    if (!(v > 0n && v < 2n ** 63n)) throw new ArgError('id nhật ký > 0');
    return v.toString();
  },
  sha(s: string): string {
    if (!HEX64_RE.test(s)) throw new ArgError('sha256 ảnh = 64 ký tự hex thường');
    return s;
  },
  code(s: string): string {
    if (!CODE_RE.test(s)) throw new ArgError('mã QR: 22..64 ký tự A-Za-z0-9_-');
    return s;
  },
};

type Parsed = {
  lot: string;
  log: string;
  media: string[] | null;
  by: string;
  role: Role;
  note: string | null;
  code: string;
  reason: string | null;
  out: string | null;
  date: string | null;
};

/** Kiểm tham số như argparse (thứ tự: giá trị sai → thiếu bắt buộc → cờ không thuộc lệnh). */
function parseArgs(cmd: string, o: QrOpts): Parsed {
  const p = {} as Parsed;
  const conv: Partial<Record<keyof QrOpts, (s: string) => string>> = {
    lot: argTypes.lot,
    log: argTypes.log,
    by: argTypes.by,
    note: argTypes.note,
    code: argTypes.code,
    reason: argTypes.note,
    date: argTypes.date,
  };
  for (const k of Object.keys(FLAG) as (keyof QrOpts)[]) {
    const v = o[k];
    if (v === undefined || !ALLOWED[cmd]?.includes(k)) continue;
    try {
      if (k === 'media') {
        p.media = (v as string[]).map(argTypes.sha);
      } else if (k === 'role') {
        if (!ROLE_KEYS.includes(v as Role)) {
          throw new ArgError(
            `invalid choice: '${v}' (choose from ${ROLE_KEYS.map((r) => `'${r}'`).join(', ')})`,
          );
        }
        p.role = v as Role;
      } else if (k === 'out') {
        p.out = v as string;
      } else {
        (p as Record<string, unknown>)[k] = (conv[k] as (s: string) => string)(v as string);
      }
    } catch (e) {
      if (e instanceof ArgError) throw new ArgError(`argument ${FLAG[k]}: ${e.message}`);
      throw e;
    }
  }
  const missing = (REQUIRED[cmd] ?? []).filter((k) => o[k] === undefined).map((k) => FLAG[k]);
  if (missing.length) {
    throw new ArgError(`the following arguments are required: ${missing.join(', ')}`);
  }
  const extra = (Object.keys(FLAG) as (keyof QrOpts)[]).filter(
    (k) => o[k] !== undefined && !ALLOWED[cmd]?.includes(k),
  );
  if (extra.length) {
    throw new ArgError(`unrecognized arguments: ${extra.map((k) => FLAG[k]).join(' ')}`);
  }
  p.media ??= null;
  p.note ??= null;
  p.reason ??= null;
  p.out ??= null;
  p.date ??= null;
  return p;
}

type Ctx = {
  io: Io;
  env: Env;
  connect: () => Promise<DbLease | null>;
  d: QrDeps;
};

function err(io: Io, msg: string): number {
  io.out(`[err] ${msg}`);
  return 1;
}

/** `production._db_call` + `qr_trace._db`: QrError → `[err] … — không ghi.`; lỗi DB → exit 1. */
async function dbCall(c: Ctx, fn: (db: Db) => Promise<number>): Promise<number> {
  const lease = await c.connect();
  if (lease === null) return 1;
  try {
    return await fn(lease.db);
  } catch (e) {
    if (e instanceof QrError) return err(c.io, `${e.message} — không ghi.`);
    if (isDbError(e)) {
      if ((e as { code?: string }).code === '42P01') {
        return err(c.io, 'thiếu bảng — chạy `python scripts/apply_schema.py` trước.');
      }
      return err(c.io, `lỗi DB, đã rollback: ${pgErrName(e)}`);
    }
    throw e;
  } finally {
    await lease.release();
  }
}

/** `production._decide`: function DB SECURITY DEFINER; RAISE → [null, lý do]. Lỗi DB khác nổi lên. */
async function callFn(db: Db, sql: string, params: unknown[]): Promise<[unknown, string | null]> {
  try {
    const r = await db.query<{ r: unknown }>(sql, params);
    return [r.rows[0]?.r ?? null, null];
  } catch (e) {
    if ((e as { code?: string })?.code === 'P0001') {
      return [null, clean((e as Error).message || 'bị từ chối', 200)];
    }
    throw e;
  }
}

async function genGate(db: Db, fid: string, what: string): Promise<void> {
  try {
    await checkGenerate(db, fid, what);
  } catch (e) {
    if (e instanceof RolloutBlocked) throw new QrError(e.message);
    throw e;
  }
}

function prepOrErr(c: Ctx): [QrConfig, Golden] | number {
  try {
    const golden = goldenMap(c.d.goldenFile);
    return [loadConfig(c.d.configFile, golden), golden];
  } catch (e) {
    if (e instanceof QrError) return err(c.io, `${e.message} — không connect.`);
    throw e;
  }
}

/** Quyết định người qua `cliGate`: `sign` đối chiếu người ký ĐÚNG vai, `issue`/`revoke` người ký của
 * 3 vai. Bị chặn → QrError. */
async function gate(
  c: Ctx,
  db: Db,
  by: string,
  action: string,
  objectType: string,
  oid: string,
  role: Role | null = null,
): Promise<void> {
  let signers: Signers;
  try {
    signers = loadSigners(c.d.signersFile);
  } catch (e) {
    if (!(e instanceof QrError)) throw e;
    // hỏng = rỗng → chế độ thực chặn
    signers = { gd_san_xuat: new Set(), gd_vung_trong: new Set(), phap_che_qa: new Set() };
  }
  const allow = role ? [...signers[role]] : ROLE_KEYS.flatMap((r) => [...signers[r]]);
  const why = await cliGate(db, by, role ? ROLE_BLOCK[role] : 'farming', action, objectType, oid, {
    allow,
    allowSrc: 'data/qr_signers.json',
    env: c.env,
    warn: c.io.err,
  });
  if (why) throw new QrError(why);
}

async function cmdLink(c: Ctx, a: Parsed, unlink: boolean): Promise<number> {
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  return dbCall(c, async (db) => {
    await lotState(db, a.lot, cfg, golden); // lô có + thuộc pilot
    // r12 G5-02: ánh xạ/gỡ = quyết định người khối farming; DB còn kiểm `human_actor`.
    const why = await cliGate(
      db,
      a.by,
      'farming',
      unlink ? 'unlink_origin' : 'link_origin',
      'production_lot',
      a.lot,
      { env: c.env, warn: c.io.err },
    );
    if (why) return err(c.io, `${why} — không ghi.`);
    const media = a.media ?? [];
    if (!unlink) {
      await genGate(db, FEATURE_LINK, `ánh xạ lô ${a.lot}`);
      // v14.6: trang QR chỉ phát hành ẢNH — sha video bị từ chối NGAY khi ánh xạ (DB cũng chặn).
      const vids = await db.query<{ sha256: string }>(
        'select sha256 from garden_media where sha256 = any($1) and not (ext = any($2))' +
          ' order by sha256',
        [media, MEDIA_EXT],
      );
      const v = vids.rows[0];
      if (v) {
        throw new QrError(
          `tư liệu ${v.sha256.slice(0, 12)} là video — trang QR chỉ nhận ảnh jpg/png`,
        );
      }
    }
    const [, why2] = unlink
      ? await callFn(db, 'select unlink_lot_origin($1, $2, $3) as r', [a.lot, a.log, a.by])
      : await callFn(db, 'select link_lot_origin($1, $2, $3, $4) as r', [
          a.lot,
          a.log,
          media,
          a.by,
        ]);
    if (why2 !== null) return err(c.io, `${why2} — không ghi.`);
    const verb = unlink ? 'gỡ ánh xạ' : 'ánh xạ';
    c.io.out(
      `[done] lô ${a.lot}: ${verb} nhật ký #${a.log}${unlink ? '' : ` (${media.length} ảnh)`}` +
        ` — người thực hiện: ${a.by}. Chữ ký cũ (nếu có) không còn tính — ký lại trên bản mới.`,
    );
    return 0;
  });
}

async function cmdPreview(c: Ctx, a: Parsed): Promise<number> {
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  return dbCall(c, async (db) => {
    const st = await lotState(db, a.lot, cfg, golden);
    const lot = st.lot;
    const bad = checkPage(st.text, lot.sku_key);
    const tag = lot.source === 'sample' ? ' [MẪU]' : '';
    c.io.out(
      `Lô ${lot.lot_code}${tag} — kiểm nhập: ${lot.intake_status} — nguồn đã chain: ` +
        `${st.origins.length} nhật ký thu hoạch`,
    );
    c.io.out('--- lời văn trang (3 vai ký trên đúng bản này) ---');
    c.io.out(st.text.replace(/\n$/, ''));
    c.io.out('---');
    c.io.out(`text_sha256: ${st.tsha}`);
    c.io.out(`snapshot_sha256: ${st.snap}`);
    c.io.out(`guardrail kênh qr: ${bad.length ? `FAIL ${bad.join(', ')}` : 'OK'}`);
    const done = ROLE_KEYS.filter((r) => st.roles.has(r)).map((r) => ROLES[r]);
    const left = ROLE_KEYS.filter((r) => !st.roles.has(r)).map((r) => ROLES[r]);
    c.io.out(`Đã ký (bản hiện tại): ${done.join(', ') || 'chưa vai nào'}`);
    c.io.out(`Còn thiếu: ${left.join(', ') || 'không'}`);
    c.io.out(`Mã còn hiệu lực: ${st.active ? `có (${st.active}/)` : 'chưa'}`);
    return 0;
  });
}

async function cmdSign(c: Ctx, a: Parsed): Promise<number> {
  let signers: Signers;
  try {
    signers = loadSigners(c.d.signersFile);
  } catch (e) {
    if (e instanceof QrError) return err(c.io, `${e.message} — không connect.`);
    throw e;
  }
  const label = ROLES[a.role];
  if (!signers[a.role].size) {
    return err(c.io, `chưa cấu hình người ký vai ${label} (external-dep SSO) — không connect.`);
  }
  if (!signers[a.role].has(normName(a.by))) {
    return err(
      c.io,
      `--by không thuộc danh sách người ký vai ${label} (data/qr_signers.json) — không connect.`,
    );
  }
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  return dbCall(c, async (db) => {
    await gate(c, db, a.by, 'sign', 'qr_lot', a.lot, a.role);
    const st = await lotState(db, a.lot, cfg, golden);
    if (qrPayload(st.lot) === null) throw new QrError(`lô ${a.lot} chưa kiểm nhập passed`);
    const bad = checkPage(st.text, st.lot.sku_key);
    if (bad.length) {
      throw new QrError(`lời văn trang không qua guardrail kênh qr (${bad.join(', ')})`);
    }
    const [row, why] = await callFn(db, 'select sign_qr_lot($1, $2, $3, $4, $5) as r', [
      a.lot,
      a.role,
      a.by,
      st.tsha,
      a.note,
    ]);
    if (why !== null) return err(c.io, `${why} — không ghi.`);
    c.io.out(`[done] lô ${a.lot}: vai ${label} đã ký (approvals #${row}) — người ký: ${a.by}`);
    return 0;
  });
}

async function cmdIssue(c: Ctx, a: Parsed): Promise<number> {
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  return dbCall(c, async (db) => {
    await gate(c, db, a.by, 'issue', 'qr_lot', a.lot);
    const st = await lotState(db, a.lot, cfg, golden);
    if (qrPayload(st.lot) === null) throw new QrError(`lô ${a.lot} chưa kiểm nhập passed`);
    const bad = checkPage(st.text, st.lot.sku_key);
    if (bad.length) {
      throw new QrError(`lời văn trang không qua guardrail kênh qr (${bad.join(', ')})`);
    }
    await genGate(db, FEATURE_QR, `phát hành mã QR lô ${a.lot}`);
    const hold = await useReason(db, FEATURE_QR, `mã QR lô ${a.lot}`, roIsHuman(a.by));
    const code = (c.d.newCode ?? newCode)();
    const [, why] = await callFn(db, 'select issue_qr($1, $2, $3, $4) as r', [
      a.lot,
      code,
      st.tsha,
      a.by,
    ]);
    if (why !== null) return err(c.io, `${why} — không phát hành.`);
    c.io.out(`[done] lô ${a.lot}: đã phát hành mã — người phát hành: ${a.by}`);
    if (hold) {
      c.io.out(
        `[chạy thử] mã chỉ ghi nội bộ — KHÔNG in tem/công khai; \`site\` không xuất trang tới khi được dùng (${hold})`,
      );
      return 0;
    }
    if (cfg.public_base_url) c.io.out(`URL: ${cfg.public_base_url}/${code}/`);
    else c.io.out(`chưa có domain công khai (external-dep) — đường dẫn ${code}/`);
    c.io.out(
      'ảnh QR: nhà in tạo từ URL (lib QR không có — external-dep). Chạy `site` để sinh trang.',
    );
    return 0;
  });
}

async function cmdRevoke(c: Ctx, a: Parsed): Promise<number> {
  return dbCall(c, async (db) => {
    await gate(c, db, a.by, 'revoke', 'qr_code', a.code.slice(0, 12));
    const [, why] = await callFn(db, 'select revoke_qr($1, $2, $3) as r', [a.code, a.by, a.reason]);
    if (why !== null) return err(c.io, `${why} — không ghi.`);
    c.io.out(
      `[done] đã thu hồi mã ${a.code} — người thu hồi: ${a.by}. Chạy \`site\` để cập nhật trang 'đã thu hồi'.`,
    );
    return 0;
  });
}

/** Python `str(Path(s))` (gần đúng): chuẩn hóa dấu phân cách, bỏ dấu phân cách cuối. */
function pathStr(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith(sep) && !/^[A-Za-z]:\\$/.test(n) ? n.slice(0, -1) : n;
}

async function cmdSite(c: Ctx, a: Parsed): Promise<number> {
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  const out = a.out ?? c.d.siteDir ?? SITE_DIR;
  const mediaDir = c.env.GARDEN_MEDIA_DIR;
  return dbCall(c, async (db) => {
    // mọi mã phát hành đã qua 3 chữ ký người (issue_qr kiểm) → duyệt từng mục bởi người.
    const hold = await useReason(db, FEATURE_QR, 'trang QR công khai', true);
    const rows = (
      await db.query<{
        code: string;
        lot_code: string;
        snapshot_sha256: string;
        text_sha256: string;
        revoked_day: string | null;
      }>(
        'select code, lot_code, snapshot_sha256, text_sha256,' +
          ` ${ymdSql("revoked_at at time zone 'Asia/Ho_Chi_Minh'")} as revoked_day` +
          ' from qr_codes order by issued_at, code',
      )
    ).rows;
    let nErr = 0;
    let nHold = 0;
    const pages: [string, string, [string, string, Buffer][]][] = [];
    const keep = new Set<string>();
    for (const r of rows) {
      const code = r.code;
      if (!CODE_RE.test(code)) {
        nErr++;
        c.io.out('[err] mã sai định dạng trong DB — bỏ qua');
        continue;
      }
      if (r.revoked_day !== null) {
        pages.push([code, revokedHtml(r.revoked_day), []]);
        continue;
      }
      if (hold) {
        nHold++;
        if (existsSync(join(out, code, 'index.html'))) pages.push([code, pausedHtml(), []]); // đã công khai
        continue;
      }
      let st: LotState;
      let media: [string, string, Buffer][];
      try {
        st = await lotState(db, r.lot_code, cfg, golden);
        if (st.tsha !== r.text_sha256 || st.snap !== r.snapshot_sha256) {
          throw new QrError('nội dung đổi sau khi ký — cần thu hồi + ký lại');
        }
        const bad = checkPage(st.text, st.lot.sku_key);
        if (bad.length) throw new QrError(`guardrail kênh qr FAIL (${bad.join(', ')})`);
        media = await mediaFiles(db, st.origins, mediaDir);
      } catch (e) {
        if (!(e instanceof QrError)) throw e;
        nErr++;
        c.io.out(`[err] mã ${code.slice(0, 6)}…: ${e.message} — không ghi trang này`);
        continue;
      }
      pages.push([
        code,
        pageHtml(
          st.text,
          media.map(([s, x]) => [s, x]),
        ),
        media,
      ]);
    }
    for (const [code, body, media] of pages) {
      for (const [sha, ext, data] of media) {
        writeAtomic(join(out, 'media', `${sha}.${ext}`), data);
        keep.add(`${sha}.${ext}`);
      }
      writeAtomic(join(out, code, 'index.html'), Buffer.from(body, 'utf8'));
    }
    if (nHold) c.io.out(`[blocked] ${nHold} mã còn hiệu lực KHÔNG xuất trang — ${hold}`);
    const mdir = join(out, 'media');
    let isDir = false;
    try {
      isDir = statSync(mdir).isDirectory();
    } catch {
      isDir = false;
    }
    if (nErr === 0 && isDir) {
      // gỡ ảnh không còn trang dùng (kể cả ảnh của trang bị tạm ngưng)
      for (const name of readdirSync(mdir)) {
        const f = join(mdir, name);
        const dot = name.indexOf('.');
        const stem = dot < 0 ? name : name.slice(0, dot);
        const ext = dot < 0 ? '' : name.slice(dot + 1);
        let isFile = false;
        try {
          isFile = statSync(f).isFile();
        } catch {
          isFile = false;
        }
        if (isFile && HEX64_RE.test(stem) && MEDIA_EXT.includes(ext) && !keep.has(name)) {
          unlinkSync(f);
        }
      }
    }
    c.io.out(`[done] ${pages.length} trang → ${pathStr(out)} (${nErr} lỗi)`);
    return nErr || nHold ? 1 : 0;
  });
}

async function cmdPlanb(c: Ctx, a: Parsed): Promise<number> {
  const prep = prepOrErr(c);
  if (typeof prep === 'number') return prep;
  const [cfg, golden] = prep;
  const day = a.date ?? (c.d.today ?? (() => vnDate(new Date())))();
  return dbCall(c, async (db) => {
    const codes = (
      await db.query<{ lot_code: string }>(
        'select lot_code from production_lots where sku_key = any($1) order by lot_code',
        [cfg.pilot_skus],
      )
    ).rows.map((x) => x.lot_code);
    const lots: PlanLot[] = [];
    const signed = new Map<string, Set<string>>();
    for (const code of codes) {
      const st = await lotState(db, code, cfg, golden);
      lots.push({ ...st.lot, n_origins: st.origins.length, issued: st.active !== null });
      signed.set(code, st.roles);
    }
    c.io.out(planBReport(lots, signed, day, cfg, golden).replace(/\n$/, ''));
    return 0;
  });
}

/** `python -m pipelines.qr_trace <lệnh> …` → exit: 0 OK; 1 từ chối nghiệp vụ / dữ liệu / DB lỗi;
 * 2 sai usage (trước khi connect). */
export async function qrTraceMain(
  cmd: string | undefined,
  o: QrOpts,
  d: QrDeps = {},
  rest: string[] = [],
): Promise<number> {
  const io = d.io ?? STD_IO;
  const env = d.env ?? process.env;
  const usage = (m: string): number => {
    io.err(`usage: ${PROG} {${COMMANDS.join(',')}} ...`);
    io.err(`${PROG}: error: ${m}`);
    return 2;
  };
  if (cmd === undefined) return usage('the following arguments are required: cmd');
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    return usage(
      `argument cmd: invalid choice: '${cmd}' (choose from ${COMMANDS.map((x) => `'${x}'`).join(', ')})`,
    );
  }
  let a: Parsed;
  try {
    a = parseArgs(cmd, o);
  } catch (e) {
    if (e instanceof ArgError) return usage(e.message);
    throw e;
  }
  if (rest.length) return usage(`unrecognized arguments: ${rest.join(' ')}`);
  const c: Ctx = { io, env, connect: d.connect ?? (() => openDatabaseUrl(env, io)), d };
  switch (cmd) {
    case 'link':
    case 'unlink':
      return cmdLink(c, a, cmd === 'unlink');
    case 'preview':
      return cmdPreview(c, a);
    case 'sign':
      return cmdSign(c, a);
    case 'issue':
      return cmdIssue(c, a);
    case 'revoke':
      return cmdRevoke(c, a);
    case 'site':
      return cmdSite(c, a);
    default:
      return cmdPlanb(c, a);
  }
}
