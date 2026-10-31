import { Module } from '@nestjs/common';
import { ApprovalWebModule } from '../approval/approval.module.js';
import { GardenController } from './garden.controller.js';

// Web tab "Nhật ký vườn" (REST /garden) — tách khỏi GardenZaloModule (lệnh CLI + intake Zalo) để
// AppModule không dựng GardenZaloService. Ghi bằng phiên người chung của ApprovalWebModule.
@Module({ imports: [ApprovalWebModule], controllers: [GardenController] })
export class GardenWebModule {}
