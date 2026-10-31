import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.js';
import { patterns as alcoholPatterns, isAlcohol, KbFilterError } from './kb-filter.js';
import { flattenParen, PII_RE } from './pii.js';
import {
  back,
  bisectLeft,
  bisectRight,
  casefold,
  casefoldChar,
  cpHead,
  cpIndexer,
  cpLen,
  D,
  END,
  finditer,
  LETTER,
  matchAt,
  pyLstrip,
  pyRepr,
  pyRstrip,
  pySplit,
  pyStr,
  pyStrip,
  pyTruthy,
  re,
  reEscape,
  S,
  S_NO_NL,
  search,
  splitlines,
  stripCombining,
  sub,
  W,
} from './py.js';

// Port `pipelines/guardrail.py` — guardrail pháp lý TPBVSK/rượu, chạy TRƯỚC khi mọi nội dung được
// hiển thị/đăng. Lớp: (1) từ cấm `data/banned_words.txt` (có dấu/không dấu, casefold, + bản "nén"
// bỏ ký tự chèn giữa 2 chữ + lách tách âm tiết/dấu câu/chữ cách rời/viên thuốc/hỏi-ngã/UT);
// (2) claim whitelist `data/claims_whitelist.json`; (3) rượu (`kb-filter` + rượu nói vòng); (4) chỉ
// `checkPublish`: XNQC/readiness, claim theo SKU, câu khuyến cáo, nhãn AI/quảng cáo, "Ngọc Linh",
// SĐT/email cá nhân, kênh chưa mở (cảnh báo). Severity/mode: `data/guardrail_rules.json` (bản dev —
// CHỜ PHÁP CHẾ DUYỆT). Không gọi LLM/mạng/DB. Không bao giờ ném lỗi: cấu hình thiếu/hỏng/lỗi nội
// bộ → ok=false + violation "config" (fail-closed).
// Offset start/end trả ra theo code point (như Python); nội bộ tính UTF-16.

export type Violation = {
  type: string;
  detail: string | null;
  span: string | null;
  code: string;
  severity: string;
  start: number | null;
  end: number | null;
};
export type GuardrailResult = {
  ok: boolean;
  violations: Violation[];
  matched_claims: { sku: string; claim: string }[];
  warnings: Violation[];
  skus: string[];
  required_labels: string[];
};
/** Map (sku_key, kênh-sau-alias) → mức view `sku_readiness`; khóa = `readinessKey(sku, kênh)`. */
export type ReadinessMap = Map<string, string>;
export const readinessKey = (sku: string, channel: string): string => `${sku}\u0000${channel}`;

// Động từ mở đầu một claim công dụng — clause chứa chúng mà không khớp claim đã duyệt → flag.
export const CLAIM_VERBS = [
  'hỗ trợ',
  'giúp',
  'giảm',
  'tăng cường',
  'bồi bổ',
  'điều hòa',
  'phòng ngừa',
  'cải thiện',
  'tốt cho',
  'ngăn ngừa',
  'bảo vệ',
];
// Disclaimer pháp lý BẮT BUỘC (chứa "thuốc"/"chữa bệnh" theo nghĩa phủ định) → banned span nằm
// trong đó được miễn. MỌI mục mở đầu bằng "không " (mục trần từng miễn luôn câu khẳng định).
export const SAFE_PHRASES = [
  'không phải là thuốc',
  'không có tác dụng thay thế thuốc chữa bệnh',
  'không có tác dụng thay thế thuốc',
  'không thay thế thuốc chữa bệnh',
  'không thay thế thuốc',
];
export const SAFE_PHRASES_EN = [
  'not a medicine',
  'not a substitute for medicine',
  'not replace medicine',
  'cannot replace medicine',
];
// Cụm đảo nghĩa đứng TRƯỚC disclaimer trong cùng clause → phủ định kép/câu tu từ → KHÔNG miễn.
export const NEGATION_FLIPS = ['không ai', 'ai bảo', 'ai nói', 'chẳng lẽ', 'đâu phải'];
export const SEVERITIES = ['critical', 'major', 'minor'];
export const READINESS_LEVELS = ['CAM', 'MO_TA', 'TP_THUONG', 'QC_DAY_DU'];

// Ký tự chèn giữa 2 CHỮ CÁI để lách ("th.uốc", ZWSP, soft hyphen, khoảng trắng hẹp, emoji…) và
// khoảng trắng giữa 2 chữ cái ĐƠN ("t h u ố c"). Giới hạn đã biết: nhiều từ viết cách chữ liền nhau.
const FILL_REST =
  '\\-_*\\u00ad\\u200b-\\u200d\\u2060\\ufeff\\u2000-\\u200a\\u202f\\u205f\\ufe0f\\u2600-\\u27bf\\u{1f300}-\\u{1faff}';
const FILL = `.${FILL_REST}`;
const SPACES = ' \\u00a0\\u2000-\\u200a\\u202f\\u205f\\u3000';
/** `_FILLER_RE`: ký tự chèn giữa 2 chữ cái ("th.uốc", ZWSP…) / khoảng trắng giữa 2 chữ cái đơn. */
export const FILLER_RE = re(
  `(?<=${LETTER})[${FILL}]+(?=${LETTER})` +
    `|(?<=(?<!${LETTER}|[${FILL}])${LETTER})[${SPACES}]+(?=${LETTER}(?!${LETTER}|[${FILL_REST}]))`,
);

// Homoglyph Kirin/Hy Lạp → Latin, 1 ký tự → 1 ký tự (áp SAU casefold).
const HOMOGLYPH: Record<string, string> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0442': 't',
  '\u043d': 'h',
  '\u043a': 'k',
  '\u043c': 'm',
  '\u0432': 'b',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u0455': 's',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u04cf': 'l',
  ɡ: 'g',
  '\u03b1': 'a',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03c5': 'u',
  '\u03bd': 'v',
  '\u03b9': 'i',
  '\u03ba': 'k',
  '\u03c7': 'x',
  '\u03b5': 'e',
};

function memo(fn: (c: string) => string): (c: string) => string {
  const cache = new Map<string, string>();
  return (c) => {
    let r = cache.get(c);
    if (r === undefined) {
      r = fn(c);
      // shortcut: kết quả khác độ dài UTF-16 giữ ký tự gốc (offset dùng chung với text gốc); chữ
      // astral có NFKC 1 ký tự BMP đã được `prep` đổi trước nên chỉ còn ca ngoài tiếng Việt.
      if (r.length !== c.length) r = c;
      if (cache.size < 65536) cache.set(c, r);
    }
    return r;
  };
}

/** NFKC 1 ký tự rồi casefold (rơi về lower), rồi homoglyph — giữ độ dài. */
const foldChar = memo((c0) => {
  const k = c0.normalize('NFKC');
  const ch = cpLen(k) === 1 ? k : c0;
  let f = casefoldChar(ch);
  if (cpLen(f) !== 1) {
    f = ch.toLowerCase();
    if (cpLen(f) !== 1) return ch; // "ß"/"ﬁ"/"İ": giữ nguyên
  }
  return HOMOGLYPH[f] ?? f;
});

const stripChar = memo((c) => {
  const base = stripCombining(c.normalize('NFKD')).replaceAll('đ', 'd');
  return base ? String.fromCodePoint(base.codePointAt(0) ?? 0) : c;
});

/** Dấu ngã → dấu hỏi (1 ký tự, giữ độ dài). */
export const hoiNga = memo((c) => {
  const d = c.normalize('NFD');
  if (!d.includes('\u0303')) return c;
  const r = d.replaceAll('\u0303', '\u0309').normalize('NFC');
  return cpLen(r) === 1 ? r : c;
});

const mapChars = (s: string, fn: (c: string) => string): string => {
  let out = '';
  for (const c of s) out += fn(c);
  return out;
};
/** casefold TỪNG ký tự, len(fold(s)) === len(s). */
export const fold = (s: string): string => mapChars(s, foldChar);
/** Bỏ dấu (đ→d) giữ nguyên độ dài. */
export const stripLen = (s: string): string => mapChars(s, stripChar);

const patCache = new Map<string, RegExp>();

/** Regex khớp nguyên cụm (biên từ), khoảng trắng linh hoạt. */
function pat(term: string, strip = false): RegExp {
  const key = `${strip ? 1 : 0}${term}`;
  let p = patCache.get(key);
  if (!p) {
    const t = strip ? stripLen(fold(term)) : fold(term);
    const body = pySplit(t).map(reEscape).join(`[${S}]+`);
    p = re(`(?<![${W}])${body}(?![${W}])`);
    if (patCache.size < 4096) patCache.set(key, p);
  }
  return p;
}

export type Txt = { low: string; stripped: string };
const txt = (s: string): Txt => {
  const low = fold(s);
  return { low, stripped: stripLen(low) };
};

export type Hit = { term: string; start: number; end: number };
const mEnd = (m: RegExpExecArray): number => m.index + m[0].length;
const SPACE_RUN = re(`[${S}]+`);

/** `_find_terms`: mọi cụm trong `terms` (có dấu lẫn biến thể không dấu); biến thể không dấu chỉ flag
 * khi span gốc cũng viết trần ('thuộc' không bị bắt nhầm 'thuốc'). */
export function findTerms(text: string, terms: readonly string[], pre?: Txt): Hit[] {
  const { low, stripped } = pre ?? txt(text);
  const hits: Hit[] = [];
  for (const term of terms) {
    const t = fold(term);
    const words = pySplit(t);
    if (!words.length) continue; // cụm rỗng → regex rỗng khớp mọi vị trí
    if (low.includes(words[0])) {
      for (const m of finditer(pat(t), low)) hits.push({ term, start: m.index, end: mEnd(m) });
    }
    if (!stripped.includes(stripLen(words[0]))) continue;
    for (const m of finditer(pat(t, true), stripped)) {
      const orig = low.slice(m.index, mEnd(m));
      if (sub(SPACE_RUN, ' ', orig) === t) continue; // trùng match có dấu
      if (stripLen(orig) !== orig) continue; // từ khác hẳn khi có dấu (thuộc ≠ thuốc)
      hits.push({ term, start: m.index, end: mEnd(m) });
    }
  }
  return hits;
}

export type Packed = [string | null, number[]];

/** `_compress`: bản nén bỏ ký tự chèn giữa 2 chữ cái + cmap (index nén → index text). */
export function compress(text: string): Packed {
  const runs = finditer(FILLER_RE, text);
  if (!runs.length) return [null, []];
  const drop = new Uint8Array(text.length);
  for (const m of runs) drop.fill(1, m.index, mEnd(m));
  let comp = '';
  const cmap: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!drop[i]) {
      comp += text[i];
      cmap.push(i);
    }
  }
  return [comp, cmap];
}

/** `_filler_hits`: hit trên bản nén, map về offset `text`; chỉ giữ hit có ≥1 ký tự bị bỏ. */
export function fillerHits(
  text: string,
  terms: readonly string[],
  packed: Packed = compress(text),
): Hit[] {
  const [comp, cmap] = packed;
  if (comp === null) return [];
  const out: Hit[] = [];
  for (const h of findTerms(comp, terms)) {
    const s = cmap[h.start];
    const e = cmap[h.end - 1] + 1;
    if (e - s !== h.end - h.start) out.push({ term: h.term, start: s, end: e });
  }
  return out;
}

// v13.1 (F07): lách từ cấm còn lọt — (A) cụm NHIỀU âm tiết chèn khoảng trắng trong âm tiết / dính
// liền; (B) cụm nhiều âm tiết bị dấu câu/emoji chia ("Khỏi. Bệnh.") và âm tiết đầu không đứng ngay
// sau một từ khác; (C) chuỗi chữ cái ĐƠN cách nhau → nối lại tìm như chuỗi con; + biểu tượng viên
// thuốc; (D) nhầm ngã/hỏi cho cụm ≥2 âm tiết; (E) "UT" viết HOA trong ngữ cảnh bệnh.
const PILL = '\u{1f48a}';
const HSP = `[${S_NO_NL}]`;
const SPACED_RUN_RE = re(
  `(?<!${LETTER})${LETTER}(?!${LETTER})(?:${HSP}+${LETTER}(?!${LETTER})){2,}`,
);
const splitCache = new Map<string, [RegExp, RegExp] | null>();

function splitPats(term: string): [RegExp, RegExp] | null {
  if (splitCache.has(term)) return splitCache.get(term) ?? null;
  const words = pySplit(fold(term));
  let r: [RegExp, RegExp] | null = null;
  if (words.length >= 2) {
    const intra = words.map((w) => Array.from(w, reEscape).join(`${HSP}{0,2}`));
    r = [
      re(`(?<![${W}])${intra.join(`${HSP}{0,3}`)}(?![${W}])`),
      re(
        `(?<![${W}]${HSP})(?<![${W}]${HSP}{2})(?<![${W}])` +
          `${words.map(reEscape).join(`[^${W}\\n]{1,4}`)}(?![${W}])`,
      ),
    ];
  }
  if (splitCache.size < 1024) splitCache.set(term, r);
  return r;
}

const UT_RE = re(`(?<![${W}])UT(?![${W}])`);
const UT_BEFORE_RE = re(
  `(?<![${W}])(?:khoi|chua|tri|bi|mac|benh|chong|phong|ngua|tieu diet|` +
    `di can|dieu tri)(?:[ \\t]+(?:han|het|duoc|luon|ca))?[ \\t]+${END}`,
);
const UT_AFTER_RE = re(
  `[ \\t]+(?:giai[ \\t]+doan|di[ \\t]+can|vu|gan|phoi|da[ \\t]+day|mau)(?![${W}])`,
);

function evasionHits(
  text: string,
  terms: readonly string[],
  pre: Txt,
  taken: [number, number][],
): [Hit, string][] {
  const low = pre.low;
  const used = new Uint8Array(text.length + 1);
  for (const [s, e] of taken) used.fill(1, s, e);
  const out: [Hit, string][] = [];
  const add = (term: string, s: number, e: number, how: string) => {
    if (!used.subarray(s, e).some((x) => x)) {
      out.push([{ term, start: s, end: e }, how]);
      used.fill(1, s, e);
    }
  };
  for (const term of terms) {
    const pats = splitPats(term);
    if (pats === null) continue;
    pats.forEach((p, i) => {
      const how = i === 0 ? ' (tách âm tiết)' : ' (chia bằng dấu câu)';
      for (const m of finditer(p, low)) add(term, m.index, mEnd(m), how);
    });
  }
  for (const m of finditer(SPACED_RUN_RE, low)) {
    const pos: number[] = [];
    for (let i = m.index; i < mEnd(m); i++) if (!SPACE_CH.test(low[i])) pos.push(i);
    const joined = pos.map((i) => low[i]).join('');
    const bare = stripLen(joined) === joined;
    for (const term of terms) {
      const t = pySplit(fold(term)).join('');
      for (const cand of bare ? new Set([t, stripLen(t)]) : [t]) {
        const k = cand ? joined.indexOf(cand) : -1;
        if (k >= 0) add(term, pos[k], pos[k + cand.length - 1] + 1, ' (chữ cách rời)');
      }
    }
  }
  for (let i = text.indexOf(PILL); i >= 0; i = text.indexOf(PILL, i + 1)) {
    add('thuốc', i, i + PILL.length, ' (biểu tượng viên thuốc)');
  }
  const hn = mapChars(low, hoiNga);
  if (hn !== low) {
    for (const term of terms) {
      const t = mapChars(fold(term), hoiNga);
      if (pySplit(t).length < 2) continue;
      for (const m of finditer(pat(t), hn)) add(term, m.index, mEnd(m), ' (nhầm dấu hỏi/ngã)');
    }
  }
  if (terms.includes('ung thư')) {
    const st = pre.stripped;
    for (const m of finditer(UT_RE, text)) {
      const s = m.index;
      const e = mEnd(m);
      if (search(UT_BEFORE_RE, st, back(st, s, 25), s) || matchAt(UT_AFTER_RE, st, e)) {
        add('ung thư', s, e, ' (viết tắt UT)');
      }
    }
  }
  return out;
}

const SPACE_CH = re(`^[${S}]$`);

// v14.1 (F): claim tách câu "rất tốt. Cho tim mạch của bạn" — "tốt" kết câu + câu sau mở bằng "cho"
// + đích sức khỏe → claim_ngoai_cong_bo.
const SPLIT_CLAIM_RE = re(
  `(?<![${W}])tốt(?:[ \\t]+(?:nhất|lắm|quá|hơn|lắm[ \\t]+luôn))?[ \\t]*` +
    '[.;:!…]+[ \\t]*cho[ \\t]+([^.,;:!?\\n]{1,120})',
);
const HEALTH_TARGETS = [
  'tim mạch',
  'tim',
  'gan',
  'thận',
  'phổi',
  'dạ dày',
  'xương khớp',
  'khớp',
  'huyết áp',
  'đường huyết',
  'mỡ máu',
  'trí não',
  'não',
  'giấc ngủ',
  'sinh lý',
  'tiêu hóa',
  'miễn dịch',
  'đề kháng',
  'mắt',
  'người bệnh',
  'bệnh nhân',
  'nội tiết',
  'thần kinh',
  'máu',
];
const HEALTH_TARGET_RE = re(`(?<![${W}])(?:${HEALTH_TARGETS.map(reEscape).join('|')})(?![${W}])`);

// Đợt hợp đồng (G2): claim NGẦM không động từ claim/từ cấm — (a) nhắm ĐỐI TƯỢNG bệnh/triệu chứng;
// (b) lời chứng KẾT QUẢ trên người dùng. Quét bản fold+bỏ dấu và bản nén. Chỉ ở check_publish.
// Miễn: câu khuyến cáo phủ định. shortcut: danh sách từ cố định — Pháp chế bổ sung; diễn đạt ngoài
// danh sách chỉ lớp LLM/người duyệt bắt (docs/handover/doi-chieu-docx.md).
const ISEP = `[${S}\\u00ad\\u200b-\\u200d\\u2060\\ufeff]`;
// Độ dài chuỗi `_ISEP + "+"` của Python (thứ tự nhánh sắp theo độ dài mẫu Python).
const PY_SEP_LEN = 36;

function alt(words: readonly string[], sep: string): string {
  const items = words.map((w) => {
    const parts = pySplit(w);
    const pyLen = parts.reduce((n, p) => n + p.length, 0) + (parts.length - 1) * PY_SEP_LEN;
    return { src: parts.map(reEscape).join(sep), pyLen };
  });
  items.sort((a, b) => b.pyLen - a.pyLen);
  return `(?:${items.map((x) => x.src).join('|')})`;
}

const AUD_W = [
  'nguoi',
  'nguoi dung',
  'ai',
  'ban',
  'cac ban',
  'khach',
  'khach hang',
  'quy khach',
  'benh nhan',
  'ong ba',
  'bo me',
  'cha me',
  'anh chi',
  'chi em',
  'nhung ai',
  'moi nguoi',
  'dan van phong',
];
const COND_W = [
  'bi',
  'mac',
  'hay',
  'hay bi',
  'thuong',
  'thuong bi',
  'thuong xuyen',
  'thuong xuyen bi',
  'dang',
  'dang bi',
  'dang mac',
  'co',
  'co benh',
  'gap',
  'dang gap',
  'gap van de ve',
  'dang gap van de ve',
  'co van de ve',
  'mong muon',
  'muon',
  'can',
  'dang can',
  'lo',
  'lo lang ve',
  'lo ngai ve',
  'kho',
];
const ACT_W = [
  'kiem soat',
  'on dinh',
  'duy tri',
  'dieu chinh',
  'ha',
  'het',
  'thoat khoi',
  'vuot qua',
  'cai thien',
  'giam',
  'chong',
  'ngua',
  'phong ngua',
];
// Từ mạnh: tên bệnh/chỉ số/triệu chứng rõ nghĩa sau khi bỏ dấu.
const HEALTH_W = (
  'tieu duong|dai thao duong|duong huyet|duong trong mau|huyet ap|cao huyet ap|huyet ap cao|' +
  'mo mau|cholesterol|gout|gut|axit uric|acid uric|ung thu|khoi u|u buou|tim mach|benh tim|' +
  'suy tim|dot quy|tai bien|xuong khop|dau khop|viem khop|thoai hoa|gan nhiem mo|men gan|' +
  'benh gan|suy than|soi than|benh than|da day|trao nguoc|mat ngu|kho ngu|ngu khong sau|' +
  'ngu khong ngon|met moi|suy nhuoc|suy giam tri nho|suy giam mien dich|hen suyen|benh tri|' +
  'yeu sinh ly|roi loan cuong|xuat tinh som|vo sinh|hiem muon|tram cam|roi loan lo au|dau dau|' +
  'dau nua dau|chong mat|hoa mat|thieu mau|beo phi|thua can|tao bon|roi loan tieu hoa|' +
  'benh man tinh|benh nen|parkinson|alzheimer|sa sut tri tue|benh|hoa tri|xa tri|sau phau thuat'
).split('|');
// Từ yếu (1 âm tiết/đa nghĩa khi bỏ dấu: ốm/ôm) — chỉ khi có điều kiện ("bị").
const WEAK_W = ['om', 'om yeu', 'cang thang', 'stress', 'suy yeu'];
const USE_W = ['dung', 'uong', 'su dung', 'an', 'xai'];
const RESULT_W = (
  'khac han|khac ro|khac biet ro|thay doi ro|do han|do nhieu|het|het han|giam han|giam ro|' +
  'cai thien|on dinh|hieu qua|khoe|khoe hon|khoe han|ngu ngon|nhe nguoi|tinh tao|bot han|' +
  'tien trien|ro ret'
).split('|');

const impliedCache = new Map<string, [RegExp, RegExp]>();

function impliedRes(s: string): [RegExp, RegExp] {
  let r = impliedCache.get(s);
  if (!r) {
    const [aud, cond, act, hl, weak] = [AUD_W, COND_W, ACT_W, HEALTH_W, WEAK_W].map((w) =>
      alt(w, s),
    );
    const gap = `(?:${ISEP}+[${W}]+){0,3}?`;
    const nb = `(?<![${W}])`;
    const na = `(?![${W}])`;
    r = [
      re(
        `${nb}${aud}(?:${gap}${s}${cond})?(?:${s}${act})?${s}${hl}${na}` +
          `|${nb}${aud}${gap}${s}${cond}(?:${s}${act})?${s}${weak}${na}`,
      ),
      re(
        `${nb}${alt(USE_W, s)}${na}[^.!?;\\n]{0,60}?${nb}` +
          `(?:cam${s}thay|nhan${s}thay|thay)(?:${s}ro)?${s}${alt(RESULT_W, s)}${na}`,
      ),
    ];
    impliedCache.set(s, r);
  }
  return r;
}

const SS = `[${S}]`;
const CAUTION_BEFORE = re(
  `(?:(?:khong|chua|tranh)${SS}+(?:nen${SS}+)?(?:dung|su${SS}+dung|uong|danh|phu${SS}+hop` +
    `|khuyen${SS}+dung)(?:${SS}+(?:cho|voi))?|chong${SS}+chi${SS}+dinh(?:${SS}+(?:cho|voi))?` +
    `|than${SS}+trong(?:${SS}+khi${SS}+dung)?(?:${SS}+(?:cho|voi))?)${SS}*:?${SS}*${END}`,
);
const CAUTION_AFTER = re(
  `^${SS}*,?${SS}*(?:(?:nen|can|phai|vui${SS}+long)${SS}+(?:hoi|tham${SS}+khao|xin)${SS}+y${SS}+kien` +
    `|(?:khong|chua)${SS}+(?:nen${SS}+)?(?:dung|su${SS}+dung|uong))`,
);
const ISEP_RUN = re(`${ISEP}+`);

function rfind(s: string, c: string, end: number): number {
  return end > 0 ? s.lastIndexOf(c, end - 1) : -1;
}

/** Không miễn theo HÌNH THỨC (vd dòng `Hỏi: …?`): nhãn/định dạng do caller viết không phải bằng
 * chứng câu đó an toàn. */
function impliedHealth(ls: string, sep: string): [number, number, string][] {
  const [audRe, resRe] = impliedRes(sep);
  const out: [number, number, string][] = [];
  for (const m of finditer(audRe, ls)) {
    const cs = Math.max(...[...'.!?;\n,'].map((c) => rfind(ls, c, m.index))) + 1;
    const found = [...'.!?;\n'].map((c) => ls.indexOf(c, mEnd(m))).filter((i) => i >= 0);
    const ce = found.length ? Math.min(...found) : ls.length;
    const before = sub(ISEP_RUN, ' ', ls.slice(cs, m.index));
    const after = sub(ISEP_RUN, ' ', ls.slice(mEnd(m), ce));
    if (search(CAUTION_BEFORE, before) || search(CAUTION_AFTER, after)) continue;
    out.push([m.index, mEnd(m), 'đối tượng bệnh/triệu chứng']);
  }
  for (const m of finditer(resRe, ls)) {
    out.push([m.index, mEnd(m), 'lời chứng kết quả trên người dùng']);
  }
  return out;
}

function impliedHealthHits(pre: Txt, packed: Packed): [number, number, string][] {
  const hits = impliedHealth(pre.stripped, `${ISEP}+`);
  const [comp, cmap] = packed;
  if (comp !== null) {
    for (const [s, e, why] of impliedHealth(txt(comp).stripped, `${ISEP}*`)) {
      hits.push([cmap[s], cmap[e - 1] + 1, why]);
    }
  }
  const uniq = new Map(hits.map((h) => [JSON.stringify(h), h]));
  return [...uniq.values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0),
  );
}

/** inside(s, e): [s,e) nằm trọn trong 1 span — bisect trên prefix-max end. */
function cover(spans: [number, number][]): (s: number, e: number) => boolean {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const starts = sorted.map((x) => x[0]);
  const maxend: number[] = [];
  let m = -1;
  for (const [, e] of sorted) {
    m = Math.max(m, e);
    maxend.push(m);
  }
  return (s, e) => {
    const i = bisectRight(starts, s);
    return i > 0 && maxend[i - 1] >= e;
  };
}

/** Giữ safe hit đúng dạng khuyến cáo: clause chứa nó không kết thúc bằng '?' và không có cụm đảo
 * nghĩa đứng TRƯỚC hit trong clause. */
function negatedHits(text: string, hits: Hit[], pre: Txt): Hit[] {
  const seps = finditer(SEP_RE, text).map((m) => m.index);
  const flipEnd = new Map<number, number>();
  for (const f of findTerms(text, NEGATION_FLIPS, pre)) {
    const k = bisectRight(seps, f.start);
    flipEnd.set(k, Math.min(flipEnd.get(k) ?? f.end, f.end));
  }
  return hits.filter((h) => {
    const j = bisectLeft(seps, h.end);
    if (j < seps.length && text[seps[j]] === '?') return false; // câu hỏi tu từ
    const k = bisectRight(seps, h.start);
    return !((flipEnd.get(k) ?? text.length + 1) <= h.start); // phủ định kép
  });
}

const SEP_RE = re('[.,;:!?\\n]');
const CLAUSE_RE = re('[^.,;:!?\\n]+');

/** Span các clause chứa động từ claim. */
function claimSpans(low: string): [number, number][] {
  return finditer(CLAUSE_RE, low)
    .filter((m) => CLAIM_VERBS.some((v) => pat(v).test(m[0])))
    .map((m): [number, number] => [m.index, mEnd(m)]);
}

// docx P1: rượu NÓI VÒNG không có từ khóa rượu — luật TỔ HỢP hẹp (≥ 2 tín hiệu) trên bản bỏ dấu.
const ALC_DEG = re(
  `(?<![${D}.,])(?:1[5-9]|[2-6]${D}|70)${SS}*(?:do|°)` +
    `(?!${SS}*c(?![a-z]))(?!${SS}*[${D}′'])(?![a-z0-9])`,
);
const ALC_DEG_NOT = re(`(?:nhiet do|duoi|tren|khoang|tu|den|[\\-–])${SS}*${END}`);
const ALC_CUE = re(
  `(?<![${W}])(?:ngâm|nhâm nhi|rót|chén|cụng ly|nâng ly|lên men|chai|bình)(?![${W}])`,
);
const ALC_CUE_ASC = re('(?<![a-z])(?:ngam|nham nhi|cung ly|nang ly|len men)(?![a-z])');
const ALC_POUR = re('(?<![a-z])rot(?![a-z])[^.!?;\\n]{0,30}?(?<![a-z])(?:chen|ly)(?![a-z])');
const ALC_HOST = re('(?<![a-z])(?:dai khach|moi khach|am bung|nham nhi|cung ly|nang ly)(?![a-z])');
const ALC_SOAK = re('(?<![a-z])ngam(?![a-z])');
const ALC_FERM = re('(?<![a-z])len men(?![a-z])');
const ALC_STRONG = re(`(?<![a-z])nong do${SS}+(?:manh|cao|nang)(?![a-z])`);

function alcoholIndirect(pre: Txt): [string, number, number] | null {
  const s = pre.stripped;
  for (const m of finditer(ALC_DEG, s)) {
    if (
      !search(ALC_DEG_NOT, s.slice(back(s, m.index, 14), m.index)) &&
      (ALC_CUE.test(pre.low) || ALC_CUE_ASC.test(s))
    ) {
      return ['độ cồn + ngâm/rót/chén/lên men', m.index, mEnd(m)];
    }
  }
  let m = search(ALC_POUR, s);
  if (m && ALC_SOAK.test(s) && ALC_HOST.test(s)) {
    return ['ngâm + rót chén/ly + mời/đãi/nhâm nhi', m.index, mEnd(m)];
  }
  m = search(ALC_STRONG, s);
  if (m && ALC_FERM.test(s)) return ['lên men + nồng độ mạnh/cao', m.index, mEnd(m)];
  return null;
}

function alcoholSpan(pre: Txt): [number, number] | null {
  const [acc, asc] = alcoholPatterns();
  const found = [acc && search(acc, pre.low), asc && search(asc, pre.stripped)].filter(
    (x): x is RegExpExecArray => !!x,
  );
  if (!found.length) return null;
  const m = found.reduce((a, b) => (b.index < a.index ? b : a));
  return [m.index, mEnd(m)];
}

const NOT_DIGIT = re(`[^${D}]`);

/** Khóa so `pii_allow`: email → casefold; số → chỉ chữ số, đầu 84 → 0. */
function contactKey(s: string): string {
  if (s.includes('@')) return casefold(s);
  const d = sub(NOT_DIGIT, '', s);
  return d.startsWith('84') ? `0${d.slice(2)}` : d;
}

// --- nạp cấu hình (Python lru_cache: nạp 1 lần / tiến trình; test gọi resetGuardrailCache) -------

let dataDir = DATA_DIR;
type Base = { banned: string[]; claims: Map<string, unknown>; error: string | null };
let baseCache: Base | null = null;
const rulesCache = new Map<string, [Rules, null] | [null, string]>(); // Python lru_cache theo thư mục
let contactsCache: Set<string> | null = null;

/** Chỉ test: đổi thư mục data (như monkeypatch DATA_DIR) — tự xóa cache. */
export function setGuardrailDataDir(dir?: string): void {
  dataDir = dir ?? DATA_DIR;
  resetGuardrailCache();
}

export function resetGuardrailCache(): void {
  baseCache = null;
  rulesCache.clear();
  contactsCache = null;
}

/** Lỗi mang tên lớp ngoại lệ Python tương ứng (thông điệp cấu hình hỏng giữ như Python). */
class PyError extends Error {
  constructor(pyName: string, msg = '') {
    super(msg);
    this.name = pyName;
  }
}

function readText(file: string): string {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    throw new PyError('FileNotFoundError');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new PyError('UnicodeDecodeError');
  }
}

function readJson(file: string): unknown {
  const s = readText(file);
  try {
    return JSON.parse(s);
  } catch {
    throw new PyError('JSONDecodeError');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Python `for x in v` trên giá trị JSON (chuỗi → từng ký tự, object → khóa). */
function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return Array.from(v);
  if (isObj(v)) return Object.keys(v);
  throw new PyError('TypeError');
}

function get(o: unknown, k: string): unknown {
  if (!isObj(o)) throw new PyError('TypeError');
  if (!(k in o)) throw new PyError('KeyError');
  return o[k];
}

function loadBase(): Base {
  if (baseCache) return baseCache;
  const banned = join(dataDir, 'banned_words.txt');
  const claimsP = join(dataDir, 'claims_whitelist.json');
  let r: Base;
  try {
    if (!existsSync(banned) || !existsSync(claimsP)) throw new PyError('FileNotFoundError');
    const words = splitlines(readText(banned))
      .filter((l) => pyStrip(l) && !l.startsWith('#'))
      .map((l) => fold(pyStrip(l)));
    const raw = readJson(claimsP);
    if (!isObj(raw)) throw new PyError('AttributeError');
    const claims = new Map<string, unknown>();
    for (const [k, v] of Object.entries(raw)) {
      if (isObj(v)) claims.set(k, 'approved_claims' in v ? v.approved_claims : []);
    }
    r = words.length
      ? { banned: words, claims, error: null }
      : {
          banned: [],
          claims: new Map(),
          error: `banned_words.txt rỗng — fail-closed trong ${dataDir}`,
        };
  } catch (e) {
    const name = (e as Error).name;
    r = {
      banned: [],
      claims: new Map(),
      error:
        name === 'FileNotFoundError'
          ? `thiếu file config trong ${dataDir}`
          : `file config hỏng (${name === 'JSONDecodeError' ? 'JSONDecodeError' : name}) trong ${dataDir}`,
    };
  }
  baseCache = r;
  return r;
}

export type Sku = Record<string, unknown>;
export type Family = { aliases: string[]; claims_keys: string[]; golden_skus: string[] };
/** Luật guardrail + golden ĐÃ kiểm (`_load_rules`). */
export type GuardrailRules = Rules;
type Rules = {
  rules: Record<string, unknown>;
  families: Map<string, Family>;
  famOf: Map<string, string>;
  golden: Map<string, Sku>;
  canonical: string;
  labelsAi: string[];
  labelsAd: string[];
  contentTypes: Record<string, unknown>;
  channels: unknown[];
  channelAlias: Record<string, unknown>;
  nlTerms: string[];
  nlIdentity: string[];
  nlConfirmed: Set<unknown>;
};

/** Python `_load_rules(data_dir)`: guardrail_rules.json + golden_skus.json ĐÃ kiểm (family/orphan/
 * khuyến cáo/nhãn/cụm Ngọc Linh — fail-closed) → [luật, null] | [null, lý do]. Cache theo thư mục. */
export function loadRules(dir: string = dataDir): [Rules, null] | [null, string] {
  const hit = rulesCache.get(dir);
  if (hit) return hit;
  let out: [Rules, null] | [null, string];
  try {
    const doc = readJson(join(dir, 'guardrail_rules.json'));
    const gold = readJson(join(dir, 'golden_skus.json'));
    const golden = new Map<string, Sku>();
    for (const s of pyIter(get(gold, 'skus'))) {
      const key = get(s, 'sku_key');
      if (typeof key === 'object' && key !== null) throw new PyError('TypeError');
      // Khóa giữ nguyên giá trị JSON như dict Python (số ≠ chuỗi khi tra) — chỉ kiểu khai báo là string.
      golden.set(key as string, s as Sku);
    }
    if (!golden.size) throw new PyError('ValueError', 'golden_skus.json 0 SKU');
    const families = new Map<string, Family>();
    const famOf = new Map<string, string>();
    const fams = get(doc, 'families');
    if (!isObj(fams)) throw new PyError('AttributeError');
    for (const [fam, d] of Object.entries(fams)) {
      const f: Family = {
        aliases: pyIter(get(d, 'aliases'))
          .map(pyStr)
          .filter((a) => pyStrip(a)),
        claims_keys: pyIter(get(d, 'claims_keys')).map(pyStr),
        golden_skus: pyIter(get(d, 'golden_skus')).map(pyStr),
      };
      families.set(fam, f);
      // alias rỗng → không bao giờ nhận ra SKU trong text → bỏ qua câm luật XNQC → fail-closed.
      if (f.golden_skus.length && !f.aliases.length) throw new PyError('ValueError');
      for (const k of f.golden_skus) {
        if (!golden.has(k)) throw new PyError('ValueError'); // golden cắt cụt
        if (famOf.has(k)) throw new PyError('ValueError'); // SKU thuộc 2 family
        famOf.set(k, fam);
      }
    }
    // Chiều ngược (golden ⊆ families): SKU TPBVSK/food không thuộc family nào → fail-closed.
    for (const [k, s] of golden) {
      if (isObj(s) && (s.category === 'tpbvsk' || s.category === 'food') && !famOf.has(k)) {
        throw new PyError('ValueError');
      }
    }
    const obj = (v: unknown) => {
      if (!isObj(v)) throw new PyError('TypeError');
      return { ...v };
    };
    const nl = get(doc, 'ngoc_linh');
    const cfg: Rules = {
      rules: obj(get(doc, 'rules')),
      families,
      famOf,
      golden,
      canonical: pyStr(get(get(doc, 'disclaimer'), 'canonical')),
      labelsAi: pyIter(get(get(doc, 'labels'), 'ai')).map(pyStr),
      labelsAd: pyIter(get(get(doc, 'labels'), 'ad')).map(pyStr),
      contentTypes: obj(get(doc, 'content_types')),
      channels: pyIter(get(doc, 'channels')),
      channelAlias: obj(get(doc, 'channel_alias')),
      nlTerms: pyIter(get(nl, 'terms'))
        .map(pyStr)
        .filter((x) => pyStrip(x)),
      nlIdentity: pyIter(get(nl, 'identity')).map(pyStr),
      nlConfirmed: new Set(pyIter(get(nl, 'confirmed_skus'))),
    };
    if (
      !pyStrip(cfg.canonical) ||
      !cfg.labelsAi.length ||
      !cfg.labelsAd.length ||
      !cfg.nlTerms.length
    ) {
      throw new PyError('ValueError');
    }
    out = [cfg, null];
  } catch (e) {
    const name = e instanceof PyError ? e.name : 'TypeError';
    out = [null, `file luật guardrail/golden không dùng được (${name}) trong ${dir}`];
  }
  if (rulesCache.size >= 4) rulesCache.clear();
  rulesCache.set(dir, out);
  return out;
}

/** Liên hệ CÔNG KHAI của công ty (`pii_allow`, data/llm_gateway.json); không đọc được → rỗng
 * (fail-closed: số công ty cũng bị chặn, không lọt số cá nhân). */
function publicContacts(): Set<string> {
  if (contactsCache) return contactsCache;
  let allow: unknown[] = [];
  try {
    const doc = readJson(join(dataDir, 'llm_gateway.json'));
    if (!isObj(doc)) throw new PyError('AttributeError');
    const v = doc.pii_allow;
    allow = pyTruthy(v) ? pyIter(v) : [];
  } catch {
    allow = [];
  }
  contactsCache = new Set(allow.filter((a): a is string => typeof a === 'string').map(contactKey));
  return contactsCache;
}

/** `_readiness_of`: soi gương CASE của view `sku_readiness` (docs/schema.sql) cho 1 SKU golden. */
export function readinessOf(s: unknown, channel: string): string {
  if (!isObj(s) || s.category === 'alcohol') return 'CAM';
  const allowed = s.allowed_channels;
  if (!Array.isArray(allowed) || !allowed.includes(channel)) return 'CAM';
  if (s.category === 'tpbvsk' && s.xnqc_status === 'approved') return 'QC_DAY_DU';
  if (s.category === 'tpbvsk') return 'MO_TA';
  if (s.category === 'food' && s.self_declaration_ok === true) return 'TP_THUONG';
  return 'CAM';
}

/** Mức được phép nói/bán của SKU × kênh từ golden file (không DB). SKU lạ / file lỗi → CAM. */
export function readiness(skuKey: string, channel: string): string {
  const [cfg, err] = loadRules();
  if (err || !cfg) return 'CAM';
  return readinessOf(cfg.golden.get(skuKey), channel);
}

function sevMode(rules: unknown, code: string): [string, string] {
  const r = isObj(rules) ? rules[code] : undefined;
  if (
    isObj(r) &&
    SEVERITIES.includes(r.severity as string) &&
    (r.mode === 'block' || r.mode === 'warn')
  ) {
    return [r.severity as string, r.mode];
  }
  return ['critical', 'block']; // code thiếu luật → fail-closed
}

const vdict = (
  code: string,
  severity: string,
  detail: string | null,
  span: string | null = null,
  start: number | null = null,
  end: number | null = null,
  type?: string,
): Violation => ({ type: type ?? code, detail, span, code, severity, start, end });

const result = (
  violations: Violation[],
  warnings: Violation[],
  matched: GuardrailResult['matched_claims'],
  skus: string[],
  labels: string[],
): GuardrailResult => ({
  ok: !violations.length,
  violations,
  matched_claims: matched,
  warnings,
  skus,
  required_labels: labels,
});

const configFail = (detail: string): GuardrailResult =>
  result([vdict('config', 'critical', detail, null, null, null, 'config')], [], [], [], []);

/** Astral có NFKC là 1 ký tự BMP (chữ/số toán học "𝐭𝐡𝐮𝐨𝐜") → ký tự đó, để fold giữ độ dài UTF-16
 * mà vẫn bắt như Python (Python đếm code point nên fold 1→1). */
function prep(s: string): string {
  if (!/[\u{10000}-\u{10ffff}]/u.test(s)) return s;
  let out = '';
  for (const c of s) {
    const k = c.length === 2 ? c.normalize('NFKC') : c;
    out += k.length === 1 ? k : c;
  }
  return out;
}

type Ctx = {
  channel: unknown;
  contentType: unknown;
  sku: unknown;
  isAi: unknown;
  isSponsored: unknown;
  readiness: unknown;
};

function run(text0: unknown, ctx: Ctx | null): GuardrailResult {
  const base = loadBase();
  if (base.error) return configFail(base.error);
  const [cfg, err] = loadRules();
  if (err || !cfg) return configFail(err ?? 'config');
  const { rules, golden } = cfg;
  const viols: Violation[] = [];
  const warns: Violation[] = [];

  const nfc = (typeof text0 === 'string' ? text0 : text0 == null ? '' : pyStr(text0)).normalize(
    'NFC',
  );
  const orig = Array.from(nfc);
  const text = prep(nfc);
  const cpi = cpIndexer(text);
  const spanOf = (s: number, e: number) => orig.slice(cpi(s), cpi(e)).join('');

  const flag = (
    code: string,
    detail: string,
    at?: [number, number] | null,
    type?: string,
    span?: string,
  ) => {
    const [sev, mode] = sevMode(rules, code);
    const v = at
      ? vdict(code, sev, detail, spanOf(at[0], at[1]), cpi(at[0]), cpi(at[1]), type)
      : vdict(code, sev, detail, span ?? null, null, null, type);
    (mode === 'warn' ? warns : viols).push(v);
  };

  let isPublic = false;
  let ad = false;
  let channel: string | null = null;
  let sku: string | null = null;
  let rmap: ReadinessMap | null = null;
  let ctype: Record<string, unknown> | null = null;
  if (ctx !== null) {
    let ch = ctx.channel;
    if (typeof ch === 'string' && Object.hasOwn(cfg.channelAlias, ch)) ch = cfg.channelAlias[ch];
    if (!cfg.channels.includes(ch)) {
      return configFail(`kênh lạ: ${pyRepr(cpHead(pyStr(ctx.channel), 40))}`);
    }
    const ct = ctx.contentType;
    const c =
      typeof ct === 'string' && Object.hasOwn(cfg.contentTypes, ct) ? cfg.contentTypes[ct] : null;
    if (!isObj(c)) return configFail(`loại nội dung lạ: ${pyRepr(cpHead(pyStr(ct), 40))}`);
    ctype = c;
    if (ctx.sku !== null && ctx.sku !== undefined) {
      if (typeof ctx.sku !== 'string' || !golden.has(ctx.sku)) {
        return configFail(`SKU lạ: ${pyRepr(cpHead(pyStr(ctx.sku), 60))}`);
      }
      sku = ctx.sku;
    }
    if (ctx.readiness !== null && ctx.readiness !== undefined) {
      if (
        !(ctx.readiness instanceof Map) ||
        ![...ctx.readiness.values()].every((r) => READINESS_LEVELS.includes(r))
      ) {
        return configFail('readiness không hợp lệ (không phải map sku×kênh -> mức sku_readiness)');
      }
      rmap = ctx.readiness as ReadinessMap;
    }
    isPublic = pyTruthy('public' in ctype ? ctype.public : true);
    ad = pyTruthy(ctype.ad) || pyTruthy(ctx.isSponsored);
    channel = ch as string;
  }
  if (!isPublic && !pyStrip(text)) return result([], [], [], [], []);

  const pre = txt(text);
  const low = pre.low;

  // SKU nhận diện qua alias family (thứ tự theo golden file).
  const famNames = [...cfg.families]
    .filter(([, d]) => findTerms(text, d.aliases, pre).length)
    .map(([f]) => f);
  const found = new Set(famNames.flatMap((f) => cfg.families.get(f)?.golden_skus ?? []));
  const skus = [...golden.keys()].filter((k) => found.has(k));

  // Pool claim. Chat/nội bộ: SKU được nhắc theo key claims_whitelist, không nhắc → toàn bộ.
  // Đăng bài: CHỈ claims của family thuộc SKU ngữ cảnh — không có SKU → pool rỗng.
  let ctxSkus: string[] = [];
  let pool: Map<string, unknown>;
  if (isPublic) {
    ctxSkus = [...golden.keys()].filter((k) => found.has(k) || k === sku);
    if (sku !== null && cfg.famOf.has(sku)) famNames.push(cfg.famOf.get(sku) as string);
    const keys = new Set(famNames.flatMap((f) => cfg.families.get(f)?.claims_keys ?? []));
    pool = new Map([...keys].sort().map((k) => [k, base.claims.get(k) ?? []]));
  } else {
    const mentioned = [...base.claims.keys()].filter(
      (k) => pat(k.replaceAll('-', ' ')).test(low) || pat(k).test(low),
    );
    pool = mentioned.length ? new Map(mentioned.map((k) => [k, base.claims.get(k)])) : base.claims;
  }

  // Lớp 2 trước: claim đã duyệt là "vùng an toàn" — từ cấm nằm trong claim đã công bố không flag.
  const claimHits: { sku: string; claim: string; start: number; end: number }[] = [];
  const matched: { sku: string; claim: string }[] = [];
  const LEAD = re(`^(hỗ trợ|giúp)[${S}]+`);
  for (const [k, claims] of pool) {
    for (const c of pyIter(claims)) {
      if (typeof c !== 'string') throw new PyError('TypeError');
      const cf = fold(c);
      const core = sub(LEAD, '', cf);
      for (const h of findTerms(text, core !== cf ? [c, core] : [c], pre)) {
        claimHits.push({ sku: k, claim: c, start: h.start, end: h.end });
        matched.push({ sku: k, claim: c });
      }
    }
  }

  const safeHits = negatedHits(
    text,
    findTerms(text, [...SAFE_PHRASES, ...SAFE_PHRASES_EN], pre),
    pre,
  );
  const exempt = cover([...claimHits, ...safeHits].map((h) => [h.start, h.end]));

  // Lớp 1: từ cấm (trừ span trong claim đã duyệt / khuyến cáo) — pass thường + ký tự chèn + lách.
  const packed = compress(text);
  const baseHits: [Hit, string][] = [
    ...findTerms(text, base.banned, pre).map((h): [Hit, string] => [h, '']),
    ...fillerHits(text, base.banned, packed).map((h): [Hit, string] => [h, ' (chèn ký tự)']),
  ];
  baseHits.push(
    ...evasionHits(
      text,
      base.banned,
      pre,
      baseHits.map(([h]) => [h.start, h.end]),
    ),
  );
  for (const [h, how] of baseHits) {
    if (exempt(h.start, h.end)) continue;
    flag('tu_cam', `từ/cụm cấm${how}: "${h.term}"`, [h.start, h.end], 'banned_word');
  }

  // Lớp 2: clause có động từ claim — trừ span đã khớp whitelist; phần dư vẫn chứa động từ claim →
  // công dụng không công bố ('giảm ho VÀ làm đẹp da' không còn lọt).
  const spans = claimHits
    .map((c): [number, number] => [c.start, c.end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const starts = spans.map((x) => x[0]);
  const maxlen = spans.reduce((m, [s, e]) => Math.max(m, e - s), 0);
  const claimClauses = claimSpans(low);
  for (const [start, end] of claimClauses) {
    let cur = start;
    const leftovers: string[] = [];
    let i = bisectLeft(starts, start - maxlen);
    while (i < spans.length && spans[i][0] < end) {
      const [ms, me] = spans[i];
      i++;
      if (me <= start) continue;
      if (ms > cur) leftovers.push(low.slice(cur, ms));
      cur = Math.max(cur, me);
    }
    if (cur < end) leftovers.push(low.slice(cur, end));
    if (leftovers.some((seg) => CLAIM_VERBS.some((v) => pat(v).test(seg)))) {
      const seg = text.slice(start, end);
      const s2 = start + seg.length - pyLstrip(seg).length;
      const e2 = end - (seg.length - pyRstrip(seg).length);
      flag(
        'claim_ngoai_cong_bo',
        'claim công dụng không nằm trong whitelist đã công bố',
        [s2, e2],
        'unverified_claim',
      );
    }
  }
  let splitClaim = false;
  for (const m of finditer(SPLIT_CLAIM_RE, low)) {
    const e1 = mEnd(m);
    const s1 = e1 - m[1].length;
    const tg = search(HEALTH_TARGET_RE, low, s1, e1);
    if (tg === null || exempt(tg.index, mEnd(tg)) || spans.some(([s, e]) => s < e1 && e > s1)) {
      continue;
    }
    splitClaim = true;
    const sp = pyRstrip(text.slice(m.index, e1));
    flag(
      'claim_ngoai_cong_bo',
      "claim công dụng tách câu ('tốt. Cho <cơ quan/chỉ số>') không nằm trong whitelist đã công bố",
      [m.index, m.index + sp.length],
      'unverified_claim',
    );
  }
  const implied = isPublic ? impliedHealthHits(pre, packed) : [];
  for (const [s, e, why] of implied) {
    flag(
      'ngam_y_suc_khoe',
      `claim sức khỏe ngầm (${why}) — không có trong hồ sơ công bố; người duyệt/Pháp chế phải xem`,
      [s, e],
      'unverified_claim',
    );
  }
  const hasClaim =
    claimHits.length > 0 || claimClauses.length > 0 || splitClaim || implied.length > 0;

  // Rượu: mọi chế độ trừ ghi chú nội bộ.
  if (ctx === null || isPublic) {
    let alc = false;
    let sp: [number, number] | null = null;
    try {
      alc = isAlcohol(nfc);
      // homoglyph/fullwidth ("ru<Kirin o>u") — quét bản fold (1-1 với text, span dùng chung).
      if (!alc && pre.low !== casefold(nfc)) alc = isAlcohol(pre.low);
      sp = alc ? alcoholSpan(pre) : null;
      if (!alc) {
        // Cùng lớp ký tự chèn ("r\u200bượu", "r.ượu"): quét bản nén, map span về text gốc.
        const [comp, cmap] = packed;
        if (comp !== null && isAlcohol(comp)) {
          alc = true;
          const cs = alcoholSpan(txt(comp));
          sp = cs ? [cmap[cs[0]], cmap[cs[1] - 1] + 1] : null;
        }
      }
    } catch (e) {
      if (!(e instanceof KbFilterError)) throw e;
      alc = false;
      sp = null;
      flag('config', `bộ lọc rượu không dùng được: ${e.message}`);
    }
    const ind = alc || !isPublic ? null : alcoholIndirect(pre);
    if (ind) {
      flag('ruou_cam_quang_cao', `rượu nói vòng (${ind[0]}) — cấm quảng cáo/khuyến mại rượu`, [
        ind[1],
        ind[2],
      ]);
    }
    if (alc) {
      flag('ruou_cam_quang_cao', 'nội dung nhắc rượu — cấm quảng cáo/khuyến mại rượu', sp);
    } else if (isPublic && sku && golden.get(sku)?.category === 'alcohol') {
      flag('ruou_cam_quang_cao', `SKU ${sku} là rượu — cấm quảng cáo/khuyến mại rượu`);
    }
  }

  const labels: string[] = [];
  if (isPublic && ctx !== null && channel !== null) {
    const ch = channel;
    const cat = (k: string) => golden.get(k)?.category;
    const tp = ctxSkus.filter((k) => cat(k) === 'tpbvsk');
    const food = ctxSkus.filter((k) => cat(k) === 'food');
    // TPBVSK chưa XNQC: có claim, hoặc là nội dung quảng cáo.
    for (const k of tp) {
      const r =
        rmap !== null ? (rmap.get(readinessKey(k, ch)) ?? 'CAM') : readinessOf(golden.get(k), ch);
      if (r !== 'QC_DAY_DU' && (hasClaim || ad)) {
        flag(
          'sku_chua_xnqc',
          `${k}: readiness ${r} trên kênh ${ch} — TPBVSK chưa có XNQC, không được quảng cáo/nêu công dụng`,
        );
      }
    }
    if (hasClaim) {
      for (const k of food) {
        flag(
          'claim_suc_khoe_tp_thuong',
          `${k}: thực phẩm thường không được nêu công dụng sức khỏe`,
        );
      }
      if (!ctxSkus.length) {
        flag('claim_khong_ro_sku', 'có claim sức khỏe nhưng không xác định được SKU');
      }
    }
    // Câu khuyến cáo chuẩn (có dấu, còn sống sau lọc phủ định kép).
    if (tp.length || hasClaim) {
      const dh = finditer(pat(cfg.canonical), low).map((m) => ({
        term: '',
        start: m.index,
        end: mEnd(m),
      }));
      if (!negatedHits(text, dh, pre).length) {
        flag('thieu_khuyen_cao', `thiếu câu khuyến cáo bắt buộc: "${cfg.canonical}"`);
      }
    }
    // Nhãn AI / nhãn quảng cáo.
    if (pyTruthy(ctx.isAi)) {
      labels.push(cfg.labelsAi[0]);
      if (!findTerms(text, cfg.labelsAi, pre).length) {
        flag('thieu_nhan_ai', `thiếu nhãn "${cfg.labelsAi[0]}"`);
      }
    }
    if (ad) {
      labels.push(cfg.labelsAd[0]);
      if (!findTerms(text, cfg.labelsAd, pre).length) {
        flag('thieu_nhan_quang_cao', `thiếu nhãn nhận diện quảng cáo (vd "${cfg.labelsAd[0]}")`);
      }
    }
    // "Ngọc Linh" — chỉ khi MỌI SKU ngữ cảnh đã được xác nhận.
    if (!(ctxSkus.length && ctxSkus.every((k) => cfg.nlConfirmed.has(k)))) {
      const ident = cover(findTerms(text, cfg.nlIdentity, pre).map((h) => [h.start, h.end]));
      for (const h of findTerms(text, cfg.nlTerms, pre)) {
        if (!ident(h.start, h.end)) {
          flag(
            'ngoc_linh_chua_xac_nhan',
            '"Ngọc Linh" chỉ dùng khi SKU có quyết định công nhận chỉ dẫn địa lý',
            [h.start, h.end],
          );
        }
      }
    }
    // r12 D2: SĐT/email cá nhân trong nội dung công khai → chặn; liên hệ công khai (pii_allow) giữ.
    // Quét thêm bản phẳng `flattenParen` ("(0912) 345 678"); cạn ngân sách → chặn.
    const allow = publicContacts();
    const piiMsg =
      'SĐT/email cá nhân trong nội dung công khai — chỉ dùng liên hệ công khai của công ty';
    const seen = new Set<string>();
    const cpo = cpIndexer(nfc);
    for (const m of finditer(PII_RE, nfc)) {
      const key = contactKey(m[0]);
      seen.add(key);
      if (!allow.has(key)) {
        const [sev, mode] = sevMode(rules, 'pii_ca_nhan');
        (mode === 'warn' ? warns : viols).push(
          vdict('pii_ca_nhan', sev, piiMsg, m[0], cpo(m.index), cpo(mEnd(m))),
        );
      }
    }
    const [flat, cut] = flattenParen(nfc);
    for (const m of finditer(PII_RE, flat)) {
      const key = contactKey(m[0]);
      if (!allow.has(key) && !seen.has(key)) {
        seen.add(key);
        flag('pii_ca_nhan', piiMsg, null, undefined, pyStrip(m[0]));
      }
    }
    if (cut) flag('pii_ca_nhan', `${piiMsg} (chuỗi ngoặc quá dài, không kiểm hết được)`);
    // Kênh ngoài allowed_channels (hiện trạng listing) → cảnh báo.
    for (const k of ctxSkus) {
      const s = golden.get(k) as Sku;
      const allowed = s.allowed_channels;
      if (s.category !== 'alcohol' && (!Array.isArray(allowed) || !allowed.includes(ch))) {
        flag('sku_chua_mo_kenh', `${k}: kênh ${ch} ngoài allowed_channels hiện tại`);
      }
    }
  }

  const seenClaims = new Set<string>();
  const uniq = matched.filter((m) => {
    const key = JSON.stringify([m.sku, m.claim]);
    if (seenClaims.has(key)) return false;
    seenClaims.add(key);
    return true;
  });
  return result(viols, warns, uniq, skus, labels);
}

function guarded(text: unknown, ctx: Ctx | null): GuardrailResult {
  try {
    return run(text, ctx);
  } catch (e) {
    return configFail(`guardrail lỗi nội bộ (${(e as Error)?.name ?? 'Exception'}) — fail-closed`);
  }
}

/** Chế độ chat / không rõ ngữ cảnh: từ cấm + claim whitelist + rượu. Không ném lỗi. */
export function check(text: unknown): GuardrailResult {
  return guarded(text, null);
}

export type PublishOpts = {
  channel: unknown;
  contentType?: unknown;
  sku?: unknown;
  /** Mặc định true (không khai = coi là AI, fail-closed). */
  isAi?: unknown;
  isSponsored?: unknown;
  /** Map từ view DB `sku_readiness` (caller đọc); null → soi gương golden file; thiếu key → CAM. */
  readiness?: ReadinessMap | null;
};

/** Chế độ đăng bài: luật `check` + XNQC/readiness, claim theo SKU, khuyến cáo, nhãn AI/quảng cáo,
 * "Ngọc Linh", SĐT/email cá nhân, kênh chưa mở (warning). `contentType="internal_note"`: chỉ luật
 * `check` trừ rượu. Kênh/loại/SKU lạ → ok=false + "config". Không ném lỗi. */
export function checkPublish(text: unknown, opts: PublishOpts): GuardrailResult {
  return guarded(text, {
    channel: opts.channel,
    contentType: opts.contentType === undefined ? 'post' : opts.contentType,
    sku: opts.sku ?? null,
    isAi: opts.isAi === undefined ? true : opts.isAi,
    isSponsored: opts.isSponsored ?? false,
    readiness: opts.readiness ?? null,
  });
}

/** Dict MỚI = `result` + 1 violation `code` (severity/mode theo guardrail_rules.json; code thiếu
 * luật → critical block). Không mutate input. `ok` mới = `result.ok === true` VÀ mode != block —
 * KHÔNG BAO GIỜ nâng ok lên true (lớp LLM/store chỉ được chặn thêm). Không ném lỗi. */
export function withViolation<T extends object>(
  res: T | unknown,
  code: string,
  detail: unknown,
  span: string | null = null,
  start: number | null = null,
  end: number | null = null,
): GuardrailResult & Record<string, unknown> {
  const b = isObj(res) ? res : {};
  const [cfg, err] = loadRules();
  const [sev, mode] = sevMode(err || !cfg ? {} : cfg.rules, code);
  const v = vdict(
    code,
    sev,
    detail === null || detail === undefined ? null : cpHead(pyStr(detail), 500),
    span,
    start,
    end,
  );
  const out: Record<string, unknown> = { ...b };
  const violations = Array.isArray(b.violations) ? [...b.violations] : [];
  const warnings = Array.isArray(b.warnings) ? [...b.warnings] : [];
  (mode === 'warn' ? warnings : violations).push(v);
  out.violations = violations;
  out.warnings = warnings;
  out.ok = b.ok === true && mode !== 'block';
  return out as GuardrailResult & Record<string, unknown>;
}
