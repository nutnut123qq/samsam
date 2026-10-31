import { jobRun } from '@samsam/core/ops/job-runs';
import { cliEntry } from '@samsam/core/rollout/rollout';
import { Command, CommandRunner, Option } from 'nest-commander';
import { type DocIntakeOpts, docIntakeMain } from './doc-intake.js';
import { type DossiersOpts, productDossiersMain } from './product-dossiers.js';
import { type SxLabelOpts, sxLabelMain } from './sx-label.js';
import { type SxTracuuOpts, sxTracuuMain } from './sx-tracuu.js';

// Lệnh CLI thay `python -m ingest.doc_intake` / `agents.sx_label` / `agents.sx_tracuu` /
// `ingest.product_dossiers` — cùng cờ, exit code, thông điệp chính. Hàm `*Main(opts, deps)` trả exit
// code (test gọi thẳng); lớp Command chỉ nối. Tham số kiểm trong `*Main` (lỗi ném trong hàm parse của
// nest-commander thoát 0).

@Command({
  name: 'doc-intake',
  description:
    'Số hóa tài liệu (F15.1): intake · --pending · --verify/--reject SHA --by · --reprocess-pending',
})
export class DocIntakeCommand extends CommandRunner {
  async run(_a: string[], o: DocIntakeOpts): Promise<void> {
    process.exitCode = await cliEntry(docIntakeMain)(o);
  }
  @Option({ flags: '--pending', description: 'liệt kê tài liệu chờ xác nhận / chờ OCR' })
  parsePending(): boolean {
    return true;
  }
  @Option({ flags: '--verify <sha256>' })
  parseVerify(v: string): string {
    return v;
  }
  @Option({ flags: '--reject <sha256>' })
  parseReject(v: string): string {
    return v;
  }
  @Option({ flags: '--by <name>', description: 'tên người Pháp chế xác nhận' })
  parseBy(v: string): string {
    return v;
  }
  @Option({
    flags: '--reprocess-pending',
    description:
      'OCR lại tài liệu cho_ocr khi đã có provider trong nước (kết quả vẫn chờ Pháp chế --verify)',
  })
  parseReprocess(): boolean {
    return true;
  }
}

@Command({
  name: 'sx-label',
  description:
    'Đối soát nhãn: chữ trên nhãn ↔ golden, hồ sơ lô, listing → NHÁP hàng duyệt label_check (không LLM, không sửa gì)',
})
export class SxLabelCommand extends CommandRunner {
  async run(_a: string[], o: SxLabelOpts): Promise<void> {
    process.exitCode = await cliEntry(sxLabelMain)(o);
  }
  @Option({ flags: '--sku <sku_key>', description: 'sku_key trong golden' })
  parseSku(v: string): string {
    return v;
  }
  @Option({ flags: '--text <file>', description: 'file chữ trên nhãn (.txt, UTF-8)' })
  parseText(v: string): string {
    return v;
  }
  @Option({
    flags: '--image <file>',
    description: 'ảnh/PDF nhãn → OCR qua provider của doc_intake',
  })
  parseImage(v: string): string {
    return v;
  }
  @Option({ flags: '--submit', description: 'đẩy mục label_check vào hàng duyệt khối production' })
  parseSubmit(): boolean {
    return true;
  }
}

@Command({
  name: 'sx-tracuu',
  description: 'SX-A7 tra cứu khoa học nội bộ (NỘI BỘ – không dùng cho truyền thông)',
})
export class SxTracuuCommand extends CommandRunner {
  async run(_a: string[], o: SxTracuuOpts): Promise<void> {
    // Python `with job_run("agents.sx_tracuu")`: ok = rc == 0.
    process.exitCode = await jobRun('agents.sx_tracuu', async (run) => {
      const rc = await cliEntry(sxTracuuMain)(o);
      run.ok = rc === 0;
      return rc;
    });
  }
  @Option({ flags: '--ask <question>' })
  parseAsk(v: string): string {
    return v;
  }
  @Option({ flags: '--k <n>', description: 'số đoạn lấy về (1..20)' })
  parseK(v: string): string {
    return v;
  }
  @Option({ flags: '--llm', description: 'tổng hợp qua LLM (mặc định TẮT — trích đoạn)' })
  parseLlm(): boolean {
    return true;
  }
  @Option({
    flags: '--out',
    description:
      'ghi file data/reports/sx-tracuu-<ngày>-<sha8>.md (tóm tắt LLM đạt guardrail → sx-tomtat-…)',
  })
  parseOut(): boolean {
    return true;
  }
}

@Command({
  name: 'product-dossiers',
  description: 'kiểm sổ hồ sơ gốc sản phẩm (chỉ đọc file, không DB)',
})
export class ProductDossiersCommand extends CommandRunner {
  async run(_a: string[], o: DossiersOpts): Promise<void> {
    process.exitCode = productDossiersMain(o);
  }
  @Option({ flags: '--check' })
  parseCheck(): boolean {
    return true;
  }
  @Option({ flags: '--file <file>' })
  parseFile(v: string): string {
    return v;
  }
  @Option({ flags: '--golden <file>' })
  parseGolden(v: string): string {
    return v;
  }
}
