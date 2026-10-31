import { Command, CommandRunner, Option } from 'nest-commander';
import { type AnchorOpts, anchorMain } from './anchor.js';
import { type QrOpts, qrTraceMain } from './qr-trace.js';

// Lệnh CLI thay Python (kiểm tham số trong *Main — lỗi parse của nest-commander thoát 0):
//   qr-trace <link|unlink|preview|sign|issue|revoke|site|planb> ← python -m pipelines.qr_trace
//   anchor --build|--submit|--verify|--export|--status|--upgrade ← python -m pipelines.anchor
// DB: DATABASE_URL như Python (`production._open` / `lead_store.connect`) = login của người chạy lệnh;
// quyết định `--by` (sign/issue/revoke/link/unlink, anchor --submit/--upgrade --by <người>) đi qua
// `cliGate` + function SECURITY DEFINER (danh tính theo login ở DB). Job `anchor_build` chạy bằng
// login dịch vụ job (runScheduled đặt DATABASE_URL = JOB_DATABASE_URL).

@Command({
  name: 'qr-trace',
  arguments: '[cmd] [rest...]',
  description:
    'Lô + QR truy xuất (thí điểm mật ong): ánh xạ nguồn, 3 chữ ký, phát hành/thu hồi mã, trang tĩnh, ' +
    'phương án B — không sinh ảnh QR, không gửi, không in. Lệnh: link, unlink, preview, sign, issue, ' +
    'revoke, site, planb',
})
export class QrTraceCommand extends CommandRunner {
  async run(params: string[], o: QrOpts): Promise<void> {
    process.exitCode = await qrTraceMain(params[0], o, {}, params.slice(1));
  }
  @Option({ flags: '--lot <lot>', description: 'mã lô (link/unlink/preview/sign/issue)' })
  parseLot(x: string): string {
    return x;
  }
  @Option({ flags: '--log <id>', description: 'id nhật ký plot_logs (link/unlink)' })
  parseLog(x: string): string {
    return x;
  }
  @Option({ flags: '--media <sha...>', description: '≤3 ảnh garden_media (link)' })
  parseMedia(x: string, prev?: string[]): string[] {
    return [...(prev ?? []), x];
  }
  @Option({ flags: '--by <name>', description: 'tên người thực hiện / ký / phát hành / thu hồi' })
  parseBy(x: string): string {
    return x;
  }
  @Option({
    flags: '--role <role>',
    description: 'sign: gd_san_xuat | gd_vung_trong | phap_che_qa',
  })
  parseRole(x: string): string {
    return x;
  }
  @Option({ flags: '--note <text>', description: 'sign: ghi chú' })
  parseNote(x: string): string {
    return x;
  }
  @Option({ flags: '--code <code>', description: 'revoke: mã QR' })
  parseCode(x: string): string {
    return x;
  }
  @Option({ flags: '--reason <text>', description: 'revoke: lý do' })
  parseReason(x: string): string {
    return x;
  }
  @Option({ flags: '--out <dir>', description: 'site: mặc định data/qr_site/' })
  parseOut(x: string): string {
    return x;
  }
  @Option({ flags: '--date <day>', description: 'planb: YYYY-MM-DD' })
  parseDate(x: string): string {
    return x;
  }
}

@Command({
  name: 'anchor',
  description:
    'v13.8 C09 — neo mã xác thực chuỗi truy xuất (farming-06): gom gốc Merkle, gửi digest, đối chiếu',
})
export class AnchorCommand extends CommandRunner {
  async run(_p: string[], o: AnchorOpts): Promise<void> {
    process.exitCode = await anchorMain(o);
  }
  @Option({ flags: '--build', description: 'gom 1 lần gốc Merkle → anchor_batches' })
  parseBuild(): boolean {
    return true;
  }
  @Option({ flags: '--dry-run', description: '--build: chỉ tính, không ghi' })
  parseDryRun(): boolean {
    return true;
  }
  @Option({ flags: '--submit <ref>', description: 'ID|latest — gửi digest ra provider' })
  parseSubmit(x: string): string {
    return x;
  }
  @Option({ flags: '--verify <ref>', description: 'ID|latest — đối chiếu nội bộ' })
  parseVerify(x: string): string {
    return x;
  }
  @Option({ flags: '--export <ref>', description: 'ID|latest — bản kê + .ots (cần --out)' })
  parseExport(x: string): string {
    return x;
  }
  @Option({ flags: '--out <dir>', description: 'thư mục --export' })
  parseOut(x: string): string {
    return x;
  }
  @Option({ flags: '--status', description: '20 lần gom gần nhất + trạng thái neo' })
  parseStatus(): boolean {
    return true;
  }
  @Option({ flags: '--upgrade <ref>', description: 'ID|latest — hỏi calendar attestation Bitcoin' })
  parseUpgrade(x: string): string {
    return x;
  }
  @Option({ flags: '--by <name>', description: 'người quyết định (mặc định agent:anchor)' })
  parseBy(x: string): string {
    return x;
  }
}
