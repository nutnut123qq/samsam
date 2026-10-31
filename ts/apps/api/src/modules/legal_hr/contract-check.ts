import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pyOsName } from '@samsam/core/ops/py-json';
import { REPORTS_DIR, writeReport } from '@samsam/core/ops/report';
import { RolloutBlocked } from '@samsam/core/rollout/rollout';
import { casefold, pyStrip, stripAccents } from '@samsam/core/security/py';
import { Command, CommandRunner, Option } from 'nest-commander';
import { suffixOf } from '../intel_import/table.js';
import { type Io, STD_IO } from './common.js';

// PC-A6 (v4.4 W44.4, legal_hr-05.1) — port `scripts/contract_check.py`: kiểm hợp đồng KOC/đại lý có
// đủ điều khoản bắt buộc. Luật thuần (KHÔNG LLM, không mạng): mỗi điều khoản = (nhãn, [nhóm]).
// Điều khoản "có" khi CÓ 1 đoạn (tách theo dòng trống) mà MỌI nhóm đều trúng. Nhóm chuỗi regex so
// trên text đã bỏ dấu + lower ("đ"→"d"). Bỏ dấu làm trùng chữ: "chưa"/"chữa" → "chua", "gỡ"/"gò" →
// "go" — regex đã né. Hai nhóm KHÔNG so trên bản bỏ dấu vì va chạm quá nhiều:
//   - "cấm": "cấm"/"cảm"/"cam kết" đều → "cam". Đoạn CÓ dấu → chỉ khớp `cấm|không được` trên text
//     còn dấu (NFC + casefold); đoạn gõ KHÔNG dấu → fallback `cam` + loại "cam kết" và các tổ hợp
//     "cảm" hay gặp. Đoạn trộn → không khớp = báo THIẾU (lệch về phía an toàn, người rà tay).
//   - nhãn AI: `\bai\b` trên bản bỏ dấu ăn đại từ "ai" ("bất kỳ ai") → khớp `AI` PHÂN BIỆT hoa thường
//     trên text gốc, hoặc "trí tuệ nhân tạo".
// Kết quả chỉ là KIỂM TỪ KHÓA — KHÔNG thay rà soát của Pháp chế/luật sư. KHÔNG in nội dung file
// (hợp đồng có thể chứa dữ liệu đối tác) — chỉ in id + nhãn điều khoản.
//
// `\b` của Python là ranh giới từ Unicode (\w = chữ/số Unicode + '_'); JS `\b` chỉ ASCII → thay
// bằng `WB` (vd "cấm漢" KHÔNG khớp `\bcấm\b` như Python).

export const MAX_BYTES = 1_000_000;
const EXTS = ['.md', '.txt'];
const W = '\\p{L}\\p{N}_';
const WB = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
/** Regex kiểu Python: `\b` → ranh giới từ Unicode, cờ `u`. */
const pyRe = (src: string): RegExp => new RegExp(src.replaceAll('\\b', WB), 'u');

const CAM_VI = pyRe('\\bcấm\\b|không được');
// Văn bản gõ không dấu: "cam" mơ hồ — loại "cam kết" + tổ hợp "cảm" hay gặp.
const CAM_ASCII = pyRe(
  '(?<!phan )(?<!tinh )(?<!nhay )(?<!truyen )(?<!thien )(?<!ac )' +
    '(?<!kha )(?<!giao )(?<!bieu )\\bcam\\b' +
    '(?! (?:ket|on|nhan|xuc|thay|giac|tinh|dong|hung|ung|quan|tu|phuc' +
    '|kich|nghi|nhiem)\\b)|khong duoc',
);
const AI_RAW = pyRe('\\bAI\\b');
const AI_ASC = pyRe('tri tue nhan tao');

/** Một đoạn: [gốc NFC, có dấu casefold, bỏ dấu lower]. */
type Para = [string, string, string];
type Group = string | ((p: Para) => boolean);

/** 'cấm'/'không được' — xem chú thích đầu tệp. */
function cam(p: Para): boolean {
  if (p[1] !== p[2]) return CAM_VI.test(p[1]); // đoạn có dấu
  return CAM_ASCII.test(p[2]);
}

/** Nhãn AI — 'AI' hoa trên text gốc (không ăn đại từ 'ai'). */
function ai(p: Para): boolean {
  return AI_RAW.test(p[0]) || AI_ASC.test(p[2]);
}

const COMMON: Record<string, [string, Group[]]> = {
  nhan_quang_cao: [
    'Gắn nhãn quảng cáo/hợp tác + nhãn nội dung AI',
    ['gan nhan|dan nhan', 'quang cao|hop tac', ai],
  ],
  go_24h: [
    'Gỡ/ẩn nội dung trong 24 giờ khi có yêu cầu',
    ['\\bgo\\b', '\\b24 ?(?:gio|h)\\b', 'yeu cau'],
  ],
  sku_duoc_phep: [
    'Chỉ SKU trong phụ lục, đúng maket đóng băng',
    ['\\bsku\\b', 'phu luc', 'maket|dong bang'],
  ],
  cam_claim_suc_khoe: [
    "Cấm claim chữa bệnh + câu khuyến cáo 'không phải là thuốc'",
    ['chua benh|dieu tri|khoi benh', cam, 'khong phai la thuoc'],
  ],
  cam_ruou: [
    'Cấm quảng cáo, khuyến mại rượu (Luật 44/2019 Đ5)',
    ['\\bruou\\b', cam, 'quang cao|khuyen mai'],
  ],
  bao_ve_dlcn: [
    'Bảo vệ dữ liệu cá nhân khách (Luật 91/2025)',
    ['du lieu ca nhan', 'khong (?:duoc )?(?:thu thap|su dung|chia se)'],
  ],
  gia_toi_thieu: ['Giá bán tối thiểu', ['gia (?:ban )?toi thieu', 'thap hon|duoi muc']],
  cham_dut: ['Chấm dứt/đơn phương chấm dứt khi vi phạm', ['cham dut', 'don phuong', 'vi pham']],
};

export const CLAUSES: Record<string, Record<string, [string, Group[]]>> = {
  koc: {
    ...COMMON,
    nghia_vu_nguoi_chuyen_tai: [
      'Nghĩa vụ người chuyển tải quảng cáo (kiểm tài liệu, đã dùng sản phẩm)',
      ['nguoi chuyen tai', 'kiem tra tai lieu', 'da (?:truc tiep )?su dung'],
    ],
  },
  dai_ly: {
    ...COMMON,
    cam_shop_trung_ten: [
      'Cấm mở shop/gian hàng trùng tên, gây nhầm lẫn',
      ['trung ten|gay nham lan', 'shop|gian hang', cam],
    ],
  },
};
export const KINDS = Object.keys(CLAUSES).sort();

/** Nhóm chuỗi → regex trên bản bỏ dấu; nhóm hàm giữ nguyên. */
function matcher(g: Group): (p: Para) => boolean {
  if (typeof g === 'function') return g;
  const r = pyRe(g);
  return (p) => r.test(p[2]);
}

const COMPILED: Record<string, [string, ((p: Para) => boolean)[]][]> = Object.fromEntries(
  Object.entries(CLAUSES).map(([k, v]) => [
    k,
    Object.entries(v).map(([cid, [, groups]]) => [cid, groups.map(matcher)]),
  ]),
);
const PARA_RE = /\n[ \t]*\n/;

/** 1 đoạn → [gốc NFC, có dấu casefold, bỏ dấu lower]. */
function para(raw: string): Para {
  const r = raw.normalize('NFC');
  return [r, casefold(r), stripAccents(r).toLowerCase()];
}

function compiled(kind: string): [string, ((p: Para) => boolean)[]][] {
  const c = COMPILED[kind];
  if (c === undefined) throw new RangeError(`KeyError: '${kind}'`);
  return c;
}

/** Đoạn `text` (text thô) thỏa đủ nhóm của điều khoản `cid`? */
export function satisfies(kind: string, cid: string, text: string): boolean {
  const hit = compiled(kind).find(([id]) => id === cid);
  if (hit === undefined) throw new RangeError(`KeyError: '${cid}'`);
  const p = para(text);
  return hit[1].every((g) => g(p));
}

function paragraphs(text: string): Para[] {
  const t = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return t
    .split(PARA_RE)
    .filter((p) => pyStrip(p) !== '')
    .map(para);
}

/** → id các điều khoản bắt buộc KHÔNG có đoạn nào thỏa đủ nhóm từ khóa (theo thứ tự khai báo).
 * kind sai → lỗi. */
export function missingClauses(text: string, kind: string): string[] {
  const ps = paragraphs(text);
  return compiled(kind)
    .filter(([, groups]) => !ps.some((p) => groups.every((g) => g(p))))
    .map(([cid]) => cid);
}

/** Lỗi đầu vào (usage, exit 2) — thông điệp KHÔNG chứa nội dung file. */
export class ContractInputError extends RangeError {}

/** Đọc + validate; lỗi → ContractInputError (exit 2). Không echo nội dung. */
export function readContract(path: string): string {
  if (!EXTS.includes(suffixOf(path))) throw new ContractInputError('chỉ nhận file .md hoặc .txt');
  let size: number;
  let raw: Buffer;
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new ContractInputError('file không tồn tại');
    size = st.size;
    if (size === 0) throw new ContractInputError('file rỗng (0 byte)');
    if (size > MAX_BYTES) throw new ContractInputError(`file quá lớn (> ${MAX_BYTES} byte)`);
    raw = readFileSync(path);
  } catch (e) {
    if (e instanceof ContractInputError) throw e;
    throw new ContractInputError(pyOsName(e)); // Python: type(OSError).__name__
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // utf-8-sig: bỏ 1 BOM đầu
  } catch {
    throw new ContractInputError('file không phải UTF-8');
  }
  if (!pyStrip(text)) throw new ContractInputError('file chỉ có khoảng trắng');
  return text;
}

export type ContractCheckOpts = { kind?: string; file?: string; outDir?: string };

/** Exit 0 đủ; 1 thiếu (in từng id thiếu); 2 usage (file không tồn tại / 0 byte / chỉ khoảng trắng /
 * đuôi khác .md|.txt / không UTF-8 / > 1MB / kind sai) hoặc báo cáo bị cổng TẮT chặn. */
export async function contractCheckMain(
  o: ContractCheckOpts,
  d: { io?: Io } = {},
): Promise<number> {
  const io = d.io ?? STD_IO;
  const usage = (msg: string) => {
    io.err(`contract_check: error: ${msg}`);
    return 2;
  };
  const miss0 = [o.kind === undefined && '--kind', o.file === undefined && '--file'].filter(
    Boolean,
  );
  if (o.kind !== undefined && !KINDS.includes(o.kind)) {
    return usage(
      `argument --kind: invalid choice: '${o.kind}' (choose from ${KINDS.map((k) => `'${k}'`).join(', ')})`,
    );
  }
  if (miss0.length) return usage(`the following arguments are required: ${miss0.join(', ')}`);
  const kind = o.kind as string;
  let text: string;
  try {
    text = readContract(o.file as string);
  } catch (e) {
    if (!(e instanceof ContractInputError)) throw e;
    io.err(`[err] ${e.message}`);
    return 2;
  }
  const miss = missingClauses(text, kind);
  const labels = CLAUSES[kind] as Record<string, [string, Group[]]>;
  let lines: string[];
  if (miss.length) {
    lines = [`[thiếu] ${miss.length} điều khoản bắt buộc (${kind}):`];
    lines.push(...miss.map((cid) => `  - ${cid}: ${labels[cid]?.[0]}`));
    lines.push('Kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư.');
  } else {
    lines = [
      `[ok] đủ ${Object.keys(labels).length} điều khoản bắt buộc (${kind}) theo kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư.`,
    ];
  }
  io.out(lines.join('\n'));
  if (o.outDir !== undefined) {
    // docx P2 (legal_hr-05.1, PL02 mục 1): báo cáo chỉ mang mã điều khoản + sha256 file (không chép
    // nội dung hợp đồng), qua `writeReport` (cổng TẮT → không ghi, nhãn CHẠY THỬ, sổ report_outputs).
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    const body = `# Kiểm hợp đồng mẫu ${kind}\n\nFile sha256 \`${sha}\`\n\n${lines.join('\n')}\n`;
    let p: string;
    try {
      p = await writeReport(body, o.outDir, `hd-mau-${kind}-${sha.slice(0, 8)}.md`, false);
    } catch (e) {
      if (!(e instanceof RolloutBlocked)) throw e;
      io.err(`[rollout] ${e.message}`);
      return 2;
    }
    io.out(`[done] ${p}`);
  }
  return miss.length ? 1 : 0;
}

@Command({
  name: 'contract-check',
  description: 'PC-A6 — kiểm hợp đồng KOC/đại lý có đủ điều khoản bắt buộc (kiểm từ khóa)',
})
export class ContractCheckCommand extends CommandRunner {
  async run(_args: string[], opts: ContractCheckOpts): Promise<void> {
    process.exitCode = await contractCheckMain(opts);
  }
  // Kiểm giá trị ở run(): lỗi ném trong hàm parse của nest-commander thoát 0.
  @Option({ flags: '--kind <kind>', description: 'koc | dai_ly' })
  parseKind(v: string): string {
    return v;
  }
  @Option({ flags: '--file <file>', description: 'hợp đồng .md/.txt' })
  parseFile(v: string): string {
    return v;
  }
  @Option({
    flags: '--out-dir <dir>',
    description: `ghi hd-mau-<loại>-<sha8>.md qua write_report (vd ${REPORTS_DIR})`,
  })
  parseOutDir(v: string): string {
    return v;
  }
}
