import { Module } from '@nestjs/common';
import {
  GardenDirectorCommand,
  VtThoitietCommand,
  VtThuhoachCommand,
} from './garden-director.command.js';

// Nhóm garden_director: agent GĐ vùng trồng + VT thời tiết/sâu bệnh + VT thu hoạch. Chỉ có lệnh CLI /
// job lịch (Python không có REST/webhook) — đăng ký ở CliModule (bước tích hợp).
@Module({ providers: [GardenDirectorCommand, VtThoitietCommand, VtThuhoachCommand] })
export class GardenDirectorModule {}
