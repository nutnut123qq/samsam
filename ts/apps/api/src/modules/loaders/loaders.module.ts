import { Module } from '@nestjs/common';
import { CoreStoreCommand, GoldenStoreCommand } from './loaders.command.js';

// Nhóm loaders (data_platform-01 "Kho dữ liệu chung", production-02 "Hồ sơ sản phẩm", legal_hr-03.2
// "Xếp mức được phép quảng bá"): `ingest/core_store.py` (lệnh `core-store` — nạp DB lõi WS1) và
// `ingest/golden_store.py` (lệnh `golden-store` — golden master, phiếu lệch, NGƯỜI duyệt giá).
// Không controller: không có giao diện/webhook riêng (phiếu lệch + giá chờ duyệt đọc qua `--report`;
// tab "Duyệt & Lịch" của web dùng `report`/`approvePrice` khi có guard Keycloak + kết nối người).
// Không job lịch. Hàm thuần `readGolden`/`validate`/`specOf` là bản chuẩn cho module khác import.
@Module({ providers: [CoreStoreCommand, GoldenStoreCommand] })
export class LoadersModule {}
