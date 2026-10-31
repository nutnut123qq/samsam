import { Command, CommandRunner, Option } from 'nest-commander';
import { type GardenOpts, gardenMain } from './garden.js';
import { type GardenMediaOpts, gardenMediaMain } from './garden-media.js';
import { gardenMediaMktMain, type MktOpts } from './garden-media-mkt.js';
import { type ZaloGardenOpts, zaloGardenMain } from './garden-zalo.service.js';

// Lệnh CLI thay Python (kiểm tham số trong *Main — lỗi parse của nest-commander thoát 0):
//   zalo-garden      ← python -m connectors.zalo_garden
//   garden           ← python -m agents.garden
//   garden-media     ← python scripts/garden_media.py
//   garden-media-mkt ← python scripts/garden_media_mkt.py
// DB: DATABASE_URL như Python (`lead_store.connect()`): login của người chạy lệnh (runbook mục 9).

@Command({
  name: 'zalo-garden',
  description: 'Nhật ký vườn qua Zalo — tiện ích allowlist + nháp ghi âm',
})
export class ZaloGardenCommand extends CommandRunner {
  async run(_a: string[], o: ZaloGardenOpts): Promise<void> {
    process.exitCode = await zaloGardenMain(o);
  }
  @Option({ flags: '--hash', description: 'đọc user_id Zalo từ STDIN → in user_hash' })
  parseHash(): boolean {
    return true;
  }
  @Option({ flags: '--pending', description: 'liệt kê ghi âm chờ chép lời' })
  parsePending(): boolean {
    return true;
  }
  @Option({ flags: '--done <id>', description: 'đóng nháp ghi âm đã chép thành nhật ký' })
  parseDone(x: string): string {
    return x;
  }
  @Option({ flags: '--log <id>', description: 'id plot_logs đã ghi từ ghi âm (đi với --done)' })
  parseLog(x: string): string {
    return x;
  }
  @Option({ flags: '--by <name>', description: 'người chép lời' })
  parseBy(x: string): string {
    return x;
  }
  @Option({
    flags: '--transcribe <id>',
    description: 'chép lời nháp ghi âm qua STT tại chỗ — in NHÁP',
  })
  parseTranscribe(x: string): string {
    return x;
  }
}

@Command({
  name: 'garden',
  description: 'Agent nhật ký vùng trồng — người ghi tay, hệ thống chuẩn hóa + cảnh báo',
})
export class GardenCommand extends CommandRunner {
  async run(_a: string[], o: GardenOpts): Promise<void> {
    process.exitCode = await gardenMain(o);
  }
  @Option({ flags: '--check', description: 'in danh sách bất thường, không ghi gì' })
  parseCheck(): boolean {
    return true;
  }
  @Option({ flags: '--gap-days <n>' })
  parseGapDays(x: string): string {
    return x;
  }
  @Option({ flags: '--plot <id>', description: 'mã khoảnh, vd KV-A01' })
  parsePlot(x: string): string {
    return x;
  }
  @Option({ flags: '--activity <a>', description: 'hoạt động (tưới/bón/...)' })
  parseActivity(x: string): string {
    return x;
  }
  @Option({ flags: '--detail <s>' })
  parseDetail(x: string): string {
    return x;
  }
  @Option({ flags: '--author <s>' })
  parseAuthor(x: string): string {
    return x;
  }
  @Option({ flags: '--ts <iso>', description: 'ISO YYYY-MM-DD[THH:MM:SSZ] (mặc định now)' })
  parseTs(x: string): string {
    return x;
  }
}

@Command({
  name: 'garden-media',
  description: 'Nạp ảnh/video vườn vào kho — gỡ EXIF/GPS, lưu ngoài repo',
})
export class GardenMediaCommand extends CommandRunner {
  async run(_a: string[], o: GardenMediaOpts): Promise<void> {
    process.exitCode = await gardenMediaMain(o);
  }
  @Option({ flags: '--file <path>', description: 'ảnh JPEG/PNG/WEBP hoặc video .mp4/.m4v/.mov' })
  parseFile(x: string): string {
    return x;
  }
  @Option({ flags: '--plot <id>', description: 'mã khoảnh, vd KV-A01' })
  parsePlot(x: string): string {
    return x;
  }
  @Option({ flags: '--date <day>', description: 'ngày chụp YYYY-MM-DD' })
  parseDate(x: string): string {
    return x;
  }
  @Option({ flags: '--by <name>', description: 'người chụp/nộp ảnh' })
  parseBy(x: string): string {
    return x;
  }
  @Option({
    flags: '--store <dir>',
    description: 'thư mục kho NGOÀI repo (mặc định env GARDEN_MEDIA_DIR)',
  })
  parseStore(x: string): string {
    return x;
  }
}

@Command({
  name: 'garden-media-mkt',
  description: 'Cấp/thu hồi tư liệu vườn cho Marketing (farming-04)',
})
export class GardenMediaMktCommand extends CommandRunner {
  async run(_a: string[], o: MktOpts): Promise<void> {
    process.exitCode = await gardenMediaMktMain(o);
  }
  @Option({ flags: '--release <sha>' })
  parseRelease(x: string): string {
    return x;
  }
  @Option({ flags: '--revoke <sha>' })
  parseRevoke(x: string): string {
    return x;
  }
  @Option({ flags: '--list' })
  parseList(): boolean {
    return true;
  }
  @Option({ flags: '--get <sha>' })
  parseGet(x: string): string {
    return x;
  }
  @Option({ flags: '--by <name>' })
  parseBy(x: string): string {
    return x;
  }
  @Option({ flags: '--note <s>' })
  parseNote(x: string): string {
    return x;
  }
  @Option({ flags: '--out <dir>' })
  parseOut(x: string): string {
    return x;
  }
  @Option({ flags: '--store <dir>' })
  parseStore(x: string): string {
    return x;
  }
}
