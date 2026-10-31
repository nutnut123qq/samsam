import { Module } from '@nestjs/common';
import { EmbedStoreCommand, KbGapsCommand, KbInternalCommand } from './rag.command.js';
import { RagController } from './rag.controller.js';
import { RagService } from './rag.service.js';

/** Lệnh CLI của nhóm — đăng ký trong CliModule (cli.ts); tự mở pool loader, không cần PG_POOL. */
export const RAG_COMMANDS = [EmbedStoreCommand, KbInternalCommand, KbGapsCommand];

// RagService (chatbot RAG) dùng PG_POOL + AI_GATEWAY global của DbModule (api: svc_ui, webhook:
// svc_webhook — đều SELECT `chunks`, không `chunks_internal`). RagController: tab Chat (POST /chat)
// + Chưa trả lời (GET /chat/unanswered) của web.
@Module({ controllers: [RagController], providers: [RagService], exports: [RagService] })
export class RagModule {}
