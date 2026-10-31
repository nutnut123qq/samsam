import { Module } from '@nestjs/common';
import { CrmCommand, LeadStoreCommand } from './crm.command.js';

// Nhóm crm: `ingest/crm.py` (KD-A2 — kho liên hệ mã hóa, đồng ý theo mục đích, đại lý theo vùng,
// gán lead/người phụ trách, chuyển lead cho NGƯỜI) + `ingest/lead_store.py` (gom lead từ convlog).
// Lệnh CLI: `crm`, `lead-store`. Không controller: tab "Leads" của web cần guard Keycloak dùng chung
// (bước Web) — dùng `leadStats`/`convlogStats` (lead-store.ts).
@Module({ providers: [CrmCommand, LeadStoreCommand] })
export class CrmModule {}
