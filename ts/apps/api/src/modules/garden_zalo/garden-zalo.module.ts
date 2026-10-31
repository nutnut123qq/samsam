import { Module } from '@nestjs/common';
import {
  GardenCommand,
  GardenMediaCommand,
  GardenMediaMktCommand,
  ZaloGardenCommand,
} from './garden-zalo.command.js';
import { GardenZaloService } from './garden-zalo.service.js';

// Nhóm garden_zalo: nhật ký vườn qua Zalo (intake cho adapter zalo — bước tích hợp cung cấp
// `{ provide: ZALO_GARDEN, useExisting: GardenZaloService }`), agent nhật ký vùng trồng, kho tư liệu
// vườn + cấp cho Marketing. Không controller: webhook thuộc module zalo; tab web "Nhật ký vườn" cần
// controller có xác thực Keycloak + phiên login người (bước web) — dùng hàm của `garden.ts`.
@Module({
  providers: [
    GardenZaloService,
    ZaloGardenCommand,
    GardenCommand,
    GardenMediaCommand,
    GardenMediaMktCommand,
  ],
  exports: [GardenZaloService],
})
export class GardenZaloModule {}
