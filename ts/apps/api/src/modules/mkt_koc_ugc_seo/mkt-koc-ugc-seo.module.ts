import { Module } from '@nestjs/common';
import { MKT_KOC_UGC_SEO_COMMANDS } from './mkt-koc-ugc-seo.command.js';

// Nhóm mkt_koc_ugc_seo: `agents/mkt_koc.py` (marketing-04.1 kit KOC), `agents/mkt_ugc.py`
// (marketing-05.2 đề xuất trả lời UGC), `agents/mkt_youtube.py` (marketing-07.2 gói YouTube dài),
// `agents/seo_san.py` (marketing-07.1 SEO sàn), `agents/seo_web.py` (marketing-06.1 rà SEO web). Không
// controller: Python không có giao diện/webhook riêng (duyệt qua hàng duyệt chung / nháp content).
// Lệnh CLI: `mkt-koc`, `mkt-ugc`, `mkt-youtube`, `seo-san`, `seo-web`.
@Module({ providers: [...MKT_KOC_UGC_SEO_COMMANDS] })
export class MktKocUgcSeoModule {}
