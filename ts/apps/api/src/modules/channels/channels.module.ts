import { Module } from '@nestjs/common';
import { B2bFormCommand, ChannelsCommand } from './channels.command.js';

// Nhóm channels: lớp kênh CSKH (`connectors/channels.py` → channels.service.ts, hàm thuần + ghi DB
// cho adapter zalo/messenger) + form B2B (`connectors/b2b_form.py` → b2b-form.service.ts, server
// `node:http` riêng cổng 8791, mặc định TẮT). Không có controller Nest: form B2B cần kiểm 411/413/
// 415/429 TRƯỚC khi đọc body (body parser của app Nest đọc trước). Lệnh CLI: `channels`, `b2b-form`.
// `RAG_ANSWER` (answer() của module RAG) do bước tích hợp cung cấp — thiếu thì lệnh vẫn chạy
// (fail-safe: câu chuyển nhân viên).
@Module({ providers: [ChannelsCommand, B2bFormCommand] })
export class ChannelsModule {}
