import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { casefold, isSpace, pySplit, pyStrip, re, stripAccents, W } from '@samsam/core/security/py';

// Phần TỐI THIỂU của module Python khác mà 5 agent nhóm này dùng: `scripts.contract_check`
// (missing_clauses/_read), `pipelines.image_studio._clean`. intel_import (muối/nhãn MXH) và
// video_studio (cấu hình/từ cấm/brief/B-roll/ffmpeg) import từ module intel_import/image_video.
// shortcut: bản sao contract_check (legal_hr đã port `contract-check.ts`, khác thông điệp lỗi đọc file)
// — nâng khi tích hợp gom về core.

export type Dict = Record<string, unknown>;
/** Python `\b` (biên từ Unicode) — JS `\b` chỉ ASCII. */
const WB = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
const pyRe = (src: string): RegExp => re(src.replaceAll('\\b', WB));
/** Python `sha256(s.encode()).hexdigest()`. */
export const sha256 = (s: string | Uint8Array): string =>
  createHash('sha256').update(s).digest('hex');

/** Python `utf-8-sig` decode strict → chữ | null (byte lỗi). */
export function decodeUtf8Sig(raw: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

// ===================================================================== image_studio._clean
const CC_CF = /[\p{Cc}\p{Cf}]/u;

/** `image_studio._clean`: NFC, bỏ ký tự điều khiển/vô hình (Cc/Cf trừ khoảng trắng), gộp trắng. */
export function cleanText(s: unknown): string {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const c of s.normalize('NFC')) if (isSpace(c) || !CC_CF.test(c)) out += c;
  return pySplit(out).join(' ');
}

// ===================================================================== scripts.contract_check
export const CONTRACT_MAX_BYTES = 1_000_000;
const CAM_VI = pyRe('\\bcấm\\b|không được');
// Văn bản gõ không dấu: "cam" mơ hồ — loại "cam kết" + tổ hợp "cảm" hay gặp.
const CAM_ASCII = pyRe(
  '(?<!phan )(?<!tinh )(?<!nhay )(?<!truyen )(?<!thien )(?<!ac )(?<!kha )(?<!giao )(?<!bieu )\\bcam\\b' +
    '(?! (?:ket|on|nhan|xuc|thay|giac|tinh|dong|hung|ung|quan|tu|phuc|kich|nghi|nhiem)\\b)|khong duoc',
);
const AI_RAW = pyRe('\\bAI\\b');
const AI_ASC = pyRe('tri tue nhan tao');
type Para = [string, string, string];
type Group = string | ((p: Para) => boolean);
const cam = (p: Para) => (p[1] !== p[2] ? CAM_VI.test(p[1]) : CAM_ASCII.test(p[2]));
const ai = (p: Para) => AI_RAW.test(p[0]) || AI_ASC.test(p[2]);

const COMMON: [string, Group[]][] = [
  ['nhan_quang_cao', ['gan nhan|dan nhan', 'quang cao|hop tac', ai]],
  ['go_24h', ['\\bgo\\b', '\\b24 ?(?:gio|h)\\b', 'yeu cau']],
  ['sku_duoc_phep', ['\\bsku\\b', 'phu luc', 'maket|dong bang']],
  ['cam_claim_suc_khoe', ['chua benh|dieu tri|khoi benh', cam, 'khong phai la thuoc']],
  ['cam_ruou', ['\\bruou\\b', cam, 'quang cao|khuyen mai']],
  ['bao_ve_dlcn', ['du lieu ca nhan', 'khong (?:duoc )?(?:thu thap|su dung|chia se)']],
  ['gia_toi_thieu', ['gia (?:ban )?toi thieu', 'thap hon|duoi muc']],
  ['cham_dut', ['cham dut', 'don phuong', 'vi pham']],
];
const CLAUSES: Record<string, [string, Group[]][]> = {
  koc: [
    ...COMMON,
    [
      'nghia_vu_nguoi_chuyen_tai',
      ['nguoi chuyen tai', 'kiem tra tai lieu', 'da (?:truc tiep )?su dung'],
    ],
  ],
  dai_ly: [...COMMON, ['cam_shop_trung_ten', ['trung ten|gay nham lan', 'shop|gian hang', cam]]],
};
const COMPILED = Object.fromEntries(
  Object.entries(CLAUSES).map(([k, v]) => [
    k,
    v.map(([cid, groups]) => {
      const ms = groups.map((g) => {
        if (typeof g !== 'string') return g;
        const r = pyRe(g);
        return (p: Para) => r.test(p[2]);
      });
      return [cid, ms] as const;
    }),
  ]),
);
const PARA_RE = /\n[ \t]*\n/;

/** 1 đoạn → (gốc NFC, có dấu casefold, bỏ dấu lower). */
function para(raw: string): Para {
  const n = raw.normalize('NFC');
  return [n, casefold(n), stripAccents(n).toLowerCase()];
}

/** `contract_check.missing_clauses`: id điều khoản bắt buộc KHÔNG có đoạn nào thỏa đủ nhóm từ khóa
 * (thứ tự khai báo). kind sai → lỗi. */
export function missingClauses(text: string, kind: string): string[] {
  const groups = COMPILED[kind];
  if (!groups) throw new RangeError(`KeyError: ${kind}`);
  const paras = text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split(PARA_RE)
    .filter((p) => pyStrip(p))
    .map(para);
  return groups.filter(([, gs]) => !paras.some((p) => gs.every((g) => g(p)))).map(([cid]) => cid);
}

/** Lỗi `contract_check._read` (Python ValueError — thông điệp không echo nội dung) hoặc OS. */
export class ContractReadError extends RangeError {}

/** `contract_check._read`: đọc + kiểm (.md/.txt, có, ≤ 1 MB, UTF-8, không chỉ khoảng trắng). */
export function readContractFile(path: string): string {
  if (!['.md', '.txt'].includes(extname(path).toLowerCase())) {
    throw new ContractReadError('chỉ nhận file .md hoặc .txt');
  }
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ContractReadError('file không tồn tại');
    size = st.size;
  } catch (e) {
    if (e instanceof ContractReadError) throw e;
    throw new ContractReadError('file không tồn tại');
  }
  if (size === 0) throw new ContractReadError('file rỗng (0 byte)');
  if (size > CONTRACT_MAX_BYTES) {
    throw new ContractReadError(`file quá lớn (> ${CONTRACT_MAX_BYTES} byte)`);
  }
  const text = decodeUtf8Sig(readFileSync(path));
  if (text === null) throw new ContractReadError('file không phải UTF-8');
  if (!pyStrip(text)) throw new ContractReadError('file chỉ có khoảng trắng');
  return text;
}

export type Refusal = { code: string; reason: string };
