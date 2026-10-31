import { Module } from '@nestjs/common';
import {
  DocIntakeCommand,
  ProductDossiersCommand,
  SxLabelCommand,
  SxTracuuCommand,
} from './sx-docs.command.js';

// Nhóm sx_docs: `ingest/doc_intake.py` (data_platform-02.1/02.2), `agents/sx_label.py` (production-03),
// `agents/sx_tracuu.py` (production-05.1/05.2), `ingest/product_dossiers.py` (production-02). Không
// controller/service REST: Python không có giao diện/webhook cho các việc này (sx_tracuu CỐ Ý không lộ
// ra app/api — test cách ly của Python); quyết định người qua CLI + `cliGate` + function DB
// `doc_review_human`. Lệnh tự mở kết nối DATABASE_URL như Python (`lead_store.connect`), không cần
// PG_POOL — đăng ký trong CliModule (cli.ts). Không có job lịch (deploy/onprem/jobs.json không gọi).

/** Lệnh CLI của nhóm — bước tích hợp đưa vào CliModule. */
export const SX_DOCS_COMMANDS = [
  DocIntakeCommand,
  SxLabelCommand,
  SxTracuuCommand,
  ProductDossiersCommand,
];

@Module({ providers: SX_DOCS_COMMANDS })
export class SxDocsModule {}
