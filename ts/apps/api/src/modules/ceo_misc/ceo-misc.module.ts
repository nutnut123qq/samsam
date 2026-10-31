import { Module, type OnModuleInit } from '@nestjs/common';
import { setCeoSections } from '../ceo_report/ceo-report.js';
import * as au from './ceo-audit.js';
import * as cd from './ceo-decisions.js';
import { CEO_MISC_COMMANDS } from './ceo-misc.command.js';
import * as cr from './ceo-risk.js';

// Nhóm ceo_misc: `agents/ceo_audit.py` (ceo-04.3/ceo-04.4 — audit outside-in, báo cáo
// `ceo-audit-`/`ceo-gia-`), `agents/ceo_decisions.py` (ceo-02.2 sổ quyết định TGĐ + C05 việc chờ
// ký của ceo-02.1), `agents/ceo_promo.py` (ceo-04.5 KM/voucher đang chạy → `ceo/promo_deviation`),
// `agents/ceo_risk.py` (ceo-03 sổ rủi ro pháp lý). Không controller: không giao diện/webhook riêng
// (báo cáo file + hàng duyệt chung; sổ quyết định do NGƯỜI ghi qua CLI). Lệnh CLI: `ceo-audit`,
// `ceo-decisions`, `ceo-promo`, `ceo-risk`. Job lịch (deploy/onprem/jobs.json): `ceo_audit` →
// `ceo-audit --report`, `ceo_promo` → `ceo-promo`.

/** 3 section v8.1 cho trang TGĐ/bản tin khối ceo (`ceo_report.computeSections`). */
export const CEO_SECTIONS = {
  decisions: cd.section,
  risk: cr.section,
  audit: (db: Parameters<typeof au.section>[0], now: Date) => au.section(db, now),
};

/** Nối 3 section vào `ceo_report` (gọi một lần mỗi tiến trình — module tự gọi lúc khởi động). */
export function wireCeoSections(): void {
  setCeoSections(CEO_SECTIONS);
}

@Module({ providers: [...CEO_MISC_COMMANDS] })
export class CeoMiscModule implements OnModuleInit {
  onModuleInit(): void {
    wireCeoSections();
  }
}
