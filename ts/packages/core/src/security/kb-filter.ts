import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dataPath } from '../paths.js';
import { casefold, isAlnum, pySplit, pyStrip, re, reEscape, S, stripAccents, W } from './py.js';

// Port `pipelines/kb_filter.py` — phát hiện nội dung RƯỢU cho kênh chatbot khách (luật quảng cáo
// rượu ≥15 độ). 0 LLM, chỉ luật:
//  - cụm: `data/ruou_keywords.txt` (1 cụm/dòng, `#` comment — CHỜ PHÁP CHẾ DUYỆT) + `name` SKU
//    `category == "alcohol"` trong `data/golden_skus.json`;
//  - NFC + casefold; cụm CÓ dấu so trên text đó, cụm KHÔNG dấu so trên bản bỏ dấu;
//  - FAIL-CLOSED: keyword file thiếu/rỗng/chỉ comment → KbFilterError (không bao giờ "0 cụm =
//    không lọc gì"); golden thiếu/hỏng → chỉ dùng keyword file + cảnh báo.

/** Keyword file rượu không dùng được — fail-closed. */
export class KbFilterError extends Error {
  override name = 'KbFilterError';
}

const files = { keywords: dataPath('ruou_keywords.txt'), golden: dataPath('golden_skus.json') };
let cache: [RegExp | null, RegExp | null] | null = null;

/** Test đổi đường dẫn (như monkeypatch KEYWORDS_FILE/GOLDEN_FILE) — tự xóa cache. */
export function setKbFiles(p: Partial<typeof files>): void {
  Object.assign(files, p);
  cache = null;
}

export function resetCache(): void {
  cache = null;
}

const norm = (s: string): string => casefold(s.normalize('NFC'));

function readUtf8(file: string): string {
  // Python read_text(encoding="utf-8"): byte lỗi → UnicodeDecodeError; BOM giữ là '\ufeff'.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
}

function goldenAlcoholNames(): string[] {
  try {
    const data = JSON.parse(readUtf8(files.golden)) as { skus: unknown };
    if (!Array.isArray(data.skus)) throw new TypeError('skus');
    return data.skus
      .filter(
        (s): s is { name: string } =>
          !!s &&
          typeof s === 'object' &&
          !Array.isArray(s) &&
          s.category === 'alcohol' &&
          typeof s.name === 'string' &&
          pyStrip(s.name) !== '',
      )
      .map((s) => s.name);
  } catch (e) {
    console.warn(
      `[kb-filter] golden_skus.json không đọc được (${(e as Error).name}) — chỉ dùng ` +
        basename(files.keywords),
    );
    return [];
  }
}

function phrases(): string[] {
  const name = basename(files.keywords);
  let raw: string;
  try {
    raw = readUtf8(files.keywords);
  } catch (e) {
    throw new KbFilterError(`${name} không đọc được (${(e as Error).name})`);
  }
  const words = raw
    .split('\n')
    .map(pyStrip)
    .filter((w) => w && !w.startsWith('#'));
  if (!words.length) throw new KbFilterError(`${name} rỗng — fail-closed`);
  return [...words, ...goldenAlcoholNames()];
}

function compile(list: string[]): RegExp | null {
  const parts = [...new Set(list)]
    .sort((a, b) => [...b].length - [...a].length)
    .map((p) => {
      const body = pySplit(p).map(reEscape).join(`[${S}]+`);
      const chars = [...p];
      const pre = isAlnum(chars[0]) ? `(?<![${W}])` : '';
      const post = isAlnum(chars[chars.length - 1]) ? `(?![${W}])` : '';
      return pre + body + post;
    });
  return parts.length ? re(parts.join('|')) : null;
}

/** (cụm có dấu, cụm không dấu) — guardrail dùng để lấy span. Ném KbFilterError (fail-closed). */
export function patterns(): [RegExp | null, RegExp | null] {
  if (cache === null) {
    const ph = phrases().map(norm);
    cache = [
      compile(ph.filter((p) => stripAccents(p) !== p)),
      compile(ph.filter((p) => stripAccents(p) === p)),
    ];
  }
  return cache;
}

/** True nếu text nhắc rượu (keyword/SKU rượu). Không phải chuỗi / rỗng → false. */
export function isAlcohol(text: unknown): boolean {
  const [acc, asc] = patterns();
  if (typeof text !== 'string' || !text) return false;
  const t = norm(text);
  if (acc?.test(t)) return true;
  return asc?.test(stripAccents(t)) ?? false;
}
