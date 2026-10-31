import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { cpLen } from '@samsam/core/ops/py';
import { CsvError, CsvReader, utf8ErrorStart } from '@samsam/core/ops/py-csv';
import { isDict, pyOsName } from '@samsam/core/ops/py-json';
import { urlsplit } from '@samsam/core/ops/py-url';
import { dataPath } from '@samsam/core/paths';
import { check } from '@samsam/core/security/guardrail';
import { isAlcohol } from '@samsam/core/security/kb-filter';
import { maskPii } from '@samsam/core/security/pii';
import { isSpace, pyStrip, S } from '@samsam/core/security/py';
import { norm, provinceOf } from '../channels/b2b-form.service.js';
import { pySortedStr } from './py.js';

// Port `agents/da_b2b.py` (v8.3 DA-05, v12.0 khối sales) — phần THUẦN: danh sách TỔ CHỨC tiềm năng
// mua quà Tết (không cột SĐT/email/tên người/địa chỉ). CSV NHẬP TAY kiểm TOÀN file trước connect;
// lỗi in số dòng + cột + lý do, KHÔNG in giá trị ô. Hệ thống KHÔNG tự liên hệ.

export { norm };
export const HEADER = ['org_name', 'org_type', 'region', 'website', 'source_url', 'fit_reason'];
export const ORG_TYPES = [
  'doanh_nghiep',
  'khach_san',
  'su_kien_hoi_nghi',
  'hiep_hoi',
  'co_quan',
  'khac',
];
export const STATUSES = ['moi', 'cho_duyet', 'chuyen_sales'];
export const MAX_BYTES = 1_000_000;
export const MAX_URL = 500;
export const BLOCK = 'sales';
export const LEGACY_BLOCK = 'projects'; // khối cũ trước v12.0 (đã gỡ)
export const OBJECT_TYPE = 'org_prospect_batch';
export const FOOTER = 'Hệ thống KHÔNG tự liên hệ — GĐ bán hàng/đại lý liên hệ sau khi duyệt.';
export const COLS = [
  'id',
  'dedup_key',
  'org_name',
  'org_type',
  'region',
  'website',
  'source_url',
  'fit_reason',
] as const;
export const SOURCES_FILE = dataPath('intel_sources.json');

export type OrgRow = {
  id?: unknown;
  dedup_key: string;
  org_name: string;
  org_type: string;
  region: string;
  website: string | null;
  source_url: string;
  fit_reason: string | null;
};

export function dedupKey(orgName: unknown, region: unknown): string {
  return `b2b:${createHash('sha256')
    .update(`${norm(orgName)}|${norm(region)}`, 'utf8')
    .digest('hex')}`;
}

// ------------------------------------------------ crawler.intel: nguồn tầng C (chỉ phần cần dùng)
// shortcut: port tối thiểu `load_sources`/`tier_c_hosts`/`is_blocked` của crawler/intel.py cho cổng
// tầng C — chuyển về module intel khi port crawler.
export const HARD_BLOCK = [
  'shopee.vn',
  'shopee.com',
  'shp.ee',
  'tiktok.com',
  'tiktokv.com',
  'lazada.vn',
  'lazada.com',
  'lzd.co',
  'tiki.vn',
  'sendo.vn',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'instagram.com',
  'threads.net',
  'x.com',
  'twitter.com',
  'zalo.me',
];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: `intel._CTRL_RE` — đúng tập ký tự điều khiển cần bỏ
const CTRL_RE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** `intel._clean`: bỏ ký tự điều khiển + gom khoảng trắng + cắt n (in an toàn). */
function clean(s: unknown, n: number): string {
  const t = pyStrip(
    String(s)
      .replace(CTRL_RE, ' ')
      .replace(new RegExp(`[${S}]+`, 'gu'), ' '),
  );
  return Array.from(t).slice(0, n).join('');
}

/** Python `urlsplit(u).hostname` (lỗi → RangeError). */
export function hostname(u: string): string | null {
  const net = urlsplit(u).netloc;
  const hi = net.slice(net.lastIndexOf('@') + 1);
  let h: string;
  const ob = hi.indexOf('[');
  if (ob >= 0) {
    const br = hi.slice(ob + 1);
    const cb = br.indexOf(']');
    h = cb >= 0 ? br.slice(0, cb) : br;
  } else {
    const c = hi.indexOf(':');
    h = c >= 0 ? hi.slice(0, c) : hi;
  }
  if (!h) return null;
  const p = h.indexOf('%');
  return p >= 0 ? h.slice(0, p).toLowerCase() + h.slice(p) : h.toLowerCase();
}

function normHost(h0: string): string {
  let h = pyStrip((h0 || '').normalize('NFKC'));
  if (h.includes('://')) h = urlsplit(h).netloc;
  h = h.slice(h.lastIndexOf('@') + 1);
  if (h.startsWith('[')) h = h.slice(1).split(']', 1)[0] as string;
  else if (h.split(':').length === 2) h = h.split(':', 1)[0] as string;
  return h.toLowerCase().replace(/\.+$/, '');
}

/** True nếu host (hoặc URL) thuộc HARD_BLOCK ∪ extra — khớp hậu tố theo nhãn, KHÔNG substring. */
export function isBlocked(host: string, extra: readonly string[] = []): boolean {
  const h = normHost(host);
  if (!h) return false;
  for (const d0 of [...HARD_BLOCK, ...extra]) {
    const d = normHost(d0);
    if (d && (h === d || h.endsWith(`.${d}`))) return true;
  }
  return false;
}

/** Host các nguồn tầng C (bỏ 'www.' để chặn cả domain). */
export function tierCHosts(cfg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(cfg.sources) ? cfg.sources : []) {
    if (isDict(s) && s.tier === 'C') {
      const h = normHost(typeof s.url === 'string' ? s.url : '');
      out.push(h.startsWith('www.') ? h.slice(4) : h);
    }
  }
  return out.filter((h) => h);
}

/** `intel.load_sources`: đọc + kiểm file nguồn. Fail-closed: lỗi bất kỳ → [null, errors]. */
export function loadSources(path: string): [Record<string, unknown> | null, string[]] {
  const name = basename(path);
  let cfg: unknown;
  try {
    cfg = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );
  } catch (e) {
    const t =
      e instanceof SyntaxError
        ? 'JSONDecodeError'
        : e instanceof TypeError
          ? 'UnicodeDecodeError'
          : pyOsName(e);
    return [null, [`${name}: không đọc được (${t})`]];
  }
  if (!isDict(cfg)) return [null, [`${name}: gốc phải là object`]];
  const errs: string[] = [];
  const topics = cfg.topics;
  if (!isDict(topics) || !Object.keys(topics).length) errs.push('topics: rỗng hoặc sai kiểu');
  else {
    for (const [t, ph] of Object.entries(topics)) {
      if (
        !Array.isArray(ph) ||
        !ph.length ||
        !ph.every((p) => typeof p === 'string' && pyStrip(p))
      ) {
        errs.push(`topics.${clean(t, 40)}: 0 cụm hoặc cụm rỗng`);
      }
    }
  }
  const llm = Object.hasOwn(cfg, 'llm') ? cfg.llm : { enabled: false };
  if (!isDict(llm) || typeof llm.enabled !== 'boolean')
    errs.push('llm.enabled: phải là true/false');
  let srcs = cfg.sources;
  if (!Array.isArray(srcs) || !srcs.length) {
    errs.push('sources: rỗng hoặc sai kiểu');
    srcs = [];
  }
  const seen = new Set<string>();
  for (const [i, s] of (srcs as unknown[]).entries()) {
    if (!isDict(s)) {
      errs.push(`sources[${i}]: phải là object`);
      continue;
    }
    let sid = s.id;
    if (typeof sid !== 'string' || !ID_RE.test(sid)) {
      errs.push(`sources[${i}].id: thiếu/sai dạng [a-z0-9_-]`);
      sid = `#${i}`;
    } else if (seen.has(sid)) errs.push(`${sid}.id: trùng`);
    seen.add(sid as string);
    if (!['A', 'B', 'C'].includes(s.tier as string)) errs.push(`${sid}.tier: phải là A|B|C`);
    let okUrl = false;
    try {
      if (typeof s.url === 'string') {
        const u = urlsplit(s.url);
        okUrl =
          ['http', 'https'].includes(u.scheme) && Boolean(hostname(s.url)) && cpLen(s.url) <= 2000;
      }
    } catch {
      okUrl = false;
    }
    if (!okUrl) errs.push(`${sid}.url: phải là http(s) có host`);
    if (!['rss', 'atom'].includes(s.kind as string)) errs.push(`${sid}.kind: phải là rss|atom`);
    if (!['cho_duyet', 'duyet'].includes(s.status as string)) {
      errs.push(`${sid}.status: phải là cho_duyet|duyet`);
    }
  }
  return errs.length ? [null, errs] : [cfg, []];
}

/** Host tầng C từ cấu hình nguồn; file hỏng → null (fail-closed). */
export function blockedHosts(path: string = SOURCES_FILE): string[] | null {
  const [cfg, errs] = loadSources(path);
  return errs.length || cfg === null ? null : tierCHosts(cfg);
}

export function urlErr(u: string, blocked: readonly string[]): string | null {
  if (cpLen(u) > MAX_URL || Array.from(u).some(isSpace)) return 'URL quá dài hoặc có khoảng trắng';
  let scheme: string;
  let host: string;
  try {
    scheme = urlsplit(u).scheme;
    host = hostname(u) ?? '';
  } catch {
    return 'URL hỏng';
  }
  if (!['http', 'https'].includes(scheme) || !host) return 'phải là URL http(s) có host';
  if (isBlocked(host, blocked)) return 'nguồn tầng C (MXH/sàn/trang cần đăng nhập) — không dùng';
  return null;
}

/** → [dòng hợp lệ, lỗi]. Có lỗi → dòng = []. Không in giá trị ô. */
export function readCsv(path: string, sourcesFile: string = SOURCES_FILE): [OrgRow[], string[]] {
  const name = basename(path);
  let raw: Buffer;
  try {
    if (statSync(path).size > MAX_BYTES) return [[], [`${name}: file > 1 MB`]];
    raw = readFileSync(path);
  } catch (e) {
    return [[], [`${name}: không đọc được (${pyOsName(e)})`]];
  }
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  const bad = utf8ErrorStart(raw.subarray(bom));
  if (bad >= 0) {
    // Python utf-8-sig: vị trí lỗi tính trên phần SAU BOM nhưng đếm "\n" trên bytes gốc.
    const ln = raw.subarray(0, bad).filter((b) => b === 0x0a).length + 1;
    return [[], [`dòng ${ln}: byte không phải UTF-8 — lưu lại file dạng CSV UTF-8`]];
  }
  const text = new TextDecoder('utf-8').decode(raw.subarray(bom));
  const blocked = blockedHosts(sourcesFile);
  if (blocked === null) {
    return [
      [],
      [
        'data/intel_sources.json hỏng — không kiểm được nguồn tầng C (MXH/sàn); sửa cấu hình rồi nạp lại',
      ],
    ];
  }
  const errs: string[] = [];
  const rows: OrgRow[] = [];
  const seen = new Map<string, number>();
  const rd = new CsvReader(text);
  const it = rd[Symbol.iterator]();
  try {
    const first = it.next();
    const header = first.done ? [] : first.value;
    if (header.length !== HEADER.length || !header.every((h, i) => pyStrip(h) === HEADER[i])) {
      return [[], [`dòng 1: header phải đúng ${HEADER.join(',')}`]];
    }
    for (let n = it.next(); !n.done; n = it.next()) {
      const rec = n.value;
      const ln = rd.lineNum;
      if (!rec.some((c) => pyStrip(c))) continue;
      if (rec.length !== HEADER.length) {
        errs.push(`dòng ${ln}: cần ${HEADER.length} cột, có ${rec.length}`);
        continue;
      }
      const r = Object.fromEntries(HEADER.map((h, i) => [h, pyStrip(rec[i] as string)])) as Record<
        string,
        string
      >;
      const badCells: [string, string][] = [];
      for (const [k, v] of Object.entries(r)) {
        if (v && maskPii(v) !== v)
          badCells.push([k, 'chứa SĐT/email — chỉ nhập thông tin tổ chức']);
      }
      const nl = cpLen(r.org_name as string);
      if (nl < 2 || nl > 200) badCells.push(['org_name', 'cần 2..200 ký tự']);
      if (!ORG_TYPES.includes(r.org_type as string)) {
        badCells.push(['org_type', `phải thuộc ${ORG_TYPES.join('|')}`]);
      }
      const prov = provinceOf(r.region);
      if (prov === null) badCells.push(['region', 'không nhận ra tỉnh/thành (hoặc mơ hồ)']);
      for (const k of ['website', 'source_url']) {
        if (!r[k]) {
          if (k === 'source_url') badCells.push([k, 'bắt buộc (nguồn công khai)']);
          continue;
        }
        const why = urlErr(r[k] as string, blocked);
        if (why) badCells.push([k, why]);
      }
      if (cpLen(r.fit_reason as string) > 300) badCells.push(['fit_reason', 'quá 300 ký tự']);
      if (isAlcohol(r.fit_reason)) badCells.push(['fit_reason', 'không gợi ý rượu']);
      // Ô vào payload lô; trượt guardrail → lô không duyệt được.
      const flagged = new Set(badCells.map(([k]) => k));
      for (const [k, v] of Object.entries(r)) {
        if (!v || flagged.has(k)) continue;
        const g = check(v);
        if (g.ok !== true) {
          const codes = pySortedStr(new Set((g.violations ?? []).map((x) => String(x.code))));
          badCells.push([
            k,
            `chứa từ/cụm guardrail chặn (${codes.join(', ')}; xem data/banned_words.txt) — ghi khác`,
          ]);
        }
      }
      if (badCells.length) {
        errs.push(...badCells.map(([k, why]) => `dòng ${ln} cột ${k}: ${why}`));
        continue;
      }
      const key = dedupKey(r.org_name, prov);
      if (seen.has(key)) {
        errs.push(
          `dòng ${ln} cột org_name: trùng tổ chức ở dòng ${seen.get(key)} (cùng tên chuẩn hóa + tỉnh)`,
        );
        continue;
      }
      seen.set(key, ln);
      rows.push({
        org_name: r.org_name as string,
        org_type: r.org_type as string,
        region: prov as string,
        website: r.website || null,
        source_url: r.source_url as string,
        fit_reason: r.fit_reason || null,
        dedup_key: key,
      });
    }
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    errs.push(`dòng ${rd.lineNum}: CSV hỏng (Error)`);
  }
  if (!rows.length && !errs.length) errs.push(`${name}: 0 dòng dữ liệu`);
  return [errs.length ? [] : rows, errs];
}

const md = (s: unknown) =>
  pyStrip(String(s || '').replace(new RegExp(`[${S}]+`, 'gu'), ' ')).replaceAll('|', '\\|') || '—';

/** Payload lô (tất định từ các cột tổ chức, thứ tự theo id). */
export function renderBatch(rows: OrgRow[]): string {
  const L = [
    `# Lô tổ chức tiềm năng mua quà Tết — ${rows.length} tổ chức`,
    '',
    'Nguồn: thông tin TỔ CHỨC công khai do người nhập tay — không có thông tin cá nhân. Duyệt = đồng ý chuyển danh sách cho GĐ bán hàng/đại lý.',
    '',
    '| # | Tổ chức | Loại | Tỉnh/thành | Website | Nguồn công khai | Lý do phù hợp | Mã |',
    '|---|---|---|---|---|---|---|---|',
  ];
  rows.forEach((r, i) => {
    L.push(
      `| ${i + 1} | ${md(r.org_name)} | ${r.org_type} | ${md(r.region)} | ${md(r.website)} | ${md(r.source_url)} | ${md(r.fit_reason)} | ${r.dedup_key.slice(4, 16)} |`,
    );
  });
  L.push('', FOOTER, '');
  return L.join('\n');
}
