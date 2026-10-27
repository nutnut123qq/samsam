# Đối chiếu Hợp đồng TEDO–Sâm Sâm (HĐ + PL01–PL04) ↔ repo

**Checkpoint hiện hành: ĐỢT HOÀN THIỆN 22/10/2026 — nhánh
`codex/contract-finalization` từ `main` = `939aac9`, working tree CHƯA
commit/merge/push/deploy** (mục A ngay dưới). Các mục 0–4 phía sau là LỊCH SỬ
của đợt hợp đồng vòng 1–2 (20–21/10/2026, nay đã ở `939aac9`) — giữ nguyên để
truy vết, số/nhãn trong đó là trạng thái lúc đó. Bảng trạng thái duy nhất của
từng mục là `data/contract_features.json` + sổ rollout trong DB; gói quyết
định ở `docs/handover/dau-vao-va-quyet-dinh.md`.

Quy ước nguồn: chỉ ghi số điều/mục và tóm tắt kỹ thuật. Không chép toàn văn
HĐ/phụ lục, thông tin người ký, mã số, giá trị thương mại vào repo (repo
public). Bản trích đầy đủ nằm ngoài repo. **PL05 (mẫu biên bản nghiệm thu,
giao nhận, đối soát) CHƯA được cung cấp** — mọi mẫu do dev soạn
(`--dossier`, `rev_share`, `ops_monthly`) chỉ là dự thảo, không phải PL05 đã
được hai bên chấp nhận.

## A. Đợt hoàn thiện 22/10/2026 — phạm vi THEO DOCX

**Phạm vi (user chốt):** HĐ + PL01–PL04 (PL05 chưa được cung cấp). PL01 mục 1:
89 tính năng AI / 9 khối — ceo 9, sales 12, marketing 14, intel 11, finance
9, production 6, farming 9, legal_hr 10, data_platform 9; PL01 mục 2 + mục 6:
P1 80, P2 9. Nền tảng TMĐT (PL01 mục 3), truy xuất blockchain (mục 4) và
nghĩa vụ ngoài code theo dõi RIÊNG, không bù số AI. Danh mục 79 mục cũ (v13.0)
không còn là phạm vi chuẩn; "79 hay 89" không còn là blocker của tổng phạm vi.
Quyết định này KHÔNG thay đầu vào thương mại, người duyệt, vendor, chữ ký.

**Cách ánh xạ:** mỗi mục = 1 ĐẦU RA kiểm được có căn cứ chữ PL01 và nguồn đếm
riêng trong code. Dòng PL01 gom nhiều đầu ra → mục `<nhóm>.<n>` (cách ánh xạ
kỹ thuật — nội dung từng mục là ĐỀ XUẤT của Bên A, chờ hai bên chốt bằng biên
bản PL01 mục 9). Không chia theo file/agent/CLI cho đủ số. Kết quả khớp đúng
từng khối và P1/P2 với DOCX; cách khớp DUY NHẤT với P2 = 9 theo chữ PL01:
HĐTV · SEO sàn · YouTube dài · tra cứu R&D · tóm tắt R&D · cảnh báo thời tiết
· cảnh báo sâu bệnh · dự báo sản lượng · cập nhật văn bản pháp luật.
Mâu thuẫn còn lại: không có (khối/giai đoạn/tổng khớp); ranh giới từng mục vẫn
chờ hai bên chốt.

### A1. Ánh xạ dòng PL01 → mục (89 tính năng AI)

| Khối | Dòng PL01 | GĐ | ID | Đầu ra kiểm được | Nguồn đếm | Người duyệt | Module | Test | Trạng thái |
|---|---|---|---|---|---|---|---|---|---|
| ceo | Báo cáo tuần tự động | P1 | ceo-01 | Báo cáo tuần tự động | hàng duyệt `ceo/weekly_report` | Tổng giám đốc | `ceo_report.py`, `cockpit.py` | test_ceo_report.py, test_cockpit.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| ceo | Theo dõi tiến độ, sổ quyết định | P1 | ceo-02.1 | Theo dõi tiến độ (sổ mốc) | hàng duyệt `ceo/weekly_board`; hàng duyệt `ceo/milestone_change` | Tổng giám đốc | `da_pmo.py`, `ceo_decisions.py` | test_da_pmo.py, test_contract_c05_ceo_waiting.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| ceo | Theo dõi tiến độ, sổ quyết định | P1 | ceo-02.2 | Sổ quyết định TGĐ | bảng `decision_log` | Tổng giám đốc | `ceo_decisions.py` | test_ceo_decisions.py, test_contract_c05_ceo_waiting.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| ceo | Sổ rủi ro pháp lý | P1 | ceo-03 | Sổ rủi ro pháp lý | báo cáo `ceo-risk-` | Tổng giám đốc | `ceo_risk.py` | test_ceo_risk.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| ceo | Kiểm soát nội bộ | P1 | ceo-04.3 | So bài đăng/listing đang chạy với bản đã duyệt | báo cáo `ceo-audit-` | Tổng giám đốc | `ceo_audit.py` | test_ceo_audit.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| ceo | Kiểm soát nội bộ | P1 | ceo-04.4 | So giá (và mô tả) listing đang chạy với bản đã duyệt | báo cáo `ceo-gia-` | Tổng giám đốc | `ceo_audit.py` | test_contract_c06_ceo_audit_price.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| ceo | Kiểm soát nội bộ | P1 | ceo-04.5 | So voucher/khuyến mãi đang chạy với bản đã duyệt | hàng duyệt `ceo/promo_deviation` | Tổng giám đốc | `ceo_promo.py` | test_v14_p5_mkt_ceo_intel.py, test_v15_p7_jobs.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| ceo | Kiểm soát nội bộ | P1 | ceo-04.6 | Báo khi nhật ký bị sửa + đối soát độc lập BKS | bảng `audit_runs`; báo cáo `bks-audit-`; báo cáo `bks-recon-` | Tổng giám đốc | `bks_audit.py`, `store.py` | test_bks_audit.py, test_store.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| ceo | Báo cáo HĐTV (P2) | P2 | ceo-05 | Báo cáo HĐTV | hàng duyệt `ceo/hdtv_pack` | Tổng giám đốc | `hdtv_report.py` | test_hdtv_report.py, test_contract_c11_p2_jobs.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| sales | Chatbot chăm sóc khách | P1 | sales-01 | Chatbot chăm sóc khách (Zalo, Messenger) | bảng `file_output_evidence`; hàng duyệt `sales/cskh_handoff`; hàng duyệt `sales/cskh_reply`; hàng duyệt `sales/cskh_handoff` | Giám đốc bán hàng | `zalo.py`, `messenger.py` | test_zalo.py, test_messenger.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Chatbot chăm sóc khách | P1 | sales-09 | Chatbot trên website | — | Giám đốc bán hàng | — | — | BLOCKED_DECISION, UNVERIFIED_LIVE |
| sales | Gợi ý trả lời chat sàn | P1 | sales-02 | Gợi ý trả lời chat sàn | bảng `san_suggestions` | Giám đốc bán hàng | `channels.py` | test_channels.py, test_v14_p3_rollout_edges.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| sales | Listing đa sàn | P1 | sales-03 | Listing đa sàn | nháp `listing`; hàng duyệt `sales/listing_sync`; hàng duyệt `sales/market_alert_s1` | Giám đốc bán hàng | `kd_listing.py`, `content.py` | test_kd_listing.py, test_content.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Quản lý khách và đại lý | P1 | sales-04.1 | Người phụ trách khách trong ngày | bảng `leads`; hàng duyệt `sales/lead_followup` | Giám đốc bán hàng | `crm.py`, `sales_director.py` | test_crm.py, test_v14_p4_sales.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Quản lý khách và đại lý | P1 | sales-04.2 | Chuyển khách về đại lý gần nhất | bảng `agent_action_log`; bảng `consents` | Giám đốc bán hàng | `crm.py` | test_crm.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Báo giá B2B quà Tết | P1 | sales-05 | Báo giá B2B quà Tết | hàng duyệt `sales/b2b_quote`; hàng duyệt `sales/b2b_quote_matrix`; hàng duyệt `sales/b2b_catalog`; hàng duyệt `sales/org_prospect_batch`; hàng duyệt `finance/b2b_margin_review`; hàng duyệt `sales/b2b_followup` | Giám đốc bán hàng | `kd_quote.py`, `kd_catalog.py` | test_kd_quote.py, test_kd_catalog.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Giám sát giá và đơn hàng | P1 | sales-06.1 | Giám sát giá và phá giá | hàng duyệt `sales/price_change`; hàng duyệt `sales/price_review`; hàng duyệt `sales/market_alert_s1`; hàng duyệt `sales/market_alert_s1`; hàng duyệt `sales/market_alert_s2`; hàng duyệt `sales/dealer_price_alert` | Giám đốc bán hàng | `kd_price.py`, `sales_director.py` | test_kd_price.py, test_sales_director.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Giám sát giá và đơn hàng | P1 | sales-06.2 | Cảnh báo đơn trễ, hủy, hoàn bất thường | hàng duyệt `sales/order_anomaly` | Giám đốc bán hàng | `market_csv.py`, `kd_orders.py` | test_market_csv.py, test_kd_orders.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| sales | Livestream, sau bán, dự báo | P1 | sales-07.1 | Kịch bản và giỏ hàng livestream | nháp `livestream_script` | Giám đốc bán hàng | `kd_live.py` | test_kd_live.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| sales | Livestream, sau bán, dự báo | P1 | sales-07.2 | Sau bán: xin đánh giá | hàng duyệt `sales/care_review`; hàng duyệt `sales/care_rebuy` | Giám đốc bán hàng | `kd_care.py` | test_kd_care.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| sales | Livestream, sau bán, dự báo | P1 | sales-07.3 | Kịch bản bán mùa 11.11, 12.12, Tết | báo cáo `kd-forecast-` | Giám đốc bán hàng | `kd_forecast.py`, `scenario.py` | test_kd_forecast.py, test_scenario.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| marketing | Nội dung hằng ngày | P1 | marketing-01.1 | Soạn 3 bài mỗi ngày | nháp `post` | Giám đốc marketing | `content.py`, `mkt_calendar.py` | test_v13_c06_daily_ar.py, test_content.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| marketing | Nội dung hằng ngày | P1 | marketing-01.2 | Lịch mùa vụ (brief chiến dịch) | hàng duyệt `marketing/campaign_brief` | Giám đốc marketing | `mkt_director.py`, `mkt_calendar.py` | test_mkt_calendar.py, test_mkt_director.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| marketing | Ảnh và video AI | P1 | marketing-02.1 | Ảnh bối cảnh AI quanh ảnh sản phẩm thật | nháp `image`; bảng `image_assets` | Giám đốc marketing | `image_studio.py` | test_image_studio.py | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE |
| marketing | Ảnh và video AI | P1 | marketing-02.2 | Video 15–45 giây từ tư liệu thật | nháp `video`; bảng `video_assets` | Giám đốc marketing | `video_studio.py` | test_video_studio.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| marketing | Quảng cáo thử nghiệm | P1 | marketing-03.1 | Đề xuất quảng cáo thử nghiệm | hàng duyệt `marketing/ad_campaign`; hàng duyệt `finance/budget_change` | Giám đốc marketing | `mkt_ads.py` | test_docx_mkt03.py, test_mkt_ads.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | Quảng cáo thử nghiệm | P1 | marketing-03.2 | Theo dõi chi phí mỗi đơn, đề xuất giữ hay tắt | hàng duyệt `marketing/ad_result` | Giám đốc marketing | `mkt_ads.py` | test_mkt_ads.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | KOC và đại lý affiliate | P1 | marketing-04.1 | Bộ tài liệu chuẩn cho KOC/đại lý affiliate | hàng duyệt `marketing/koc_brief`; hàng duyệt `sales/affiliate_program` | Giám đốc marketing | `mkt_koc.py`, `kd_affiliate.py` | test_mkt_koc.py, test_kd_affiliate.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | KOC và đại lý affiliate | P1 | marketing-04.2 | Kiểm tra bài đăng của đối tác | hàng duyệt `marketing/partner_post_review` | Giám đốc marketing | `ra_kenh.py` | test_v14_p5_mkt_ceo_intel.py, test_ra_kenh.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | Bình luận, đánh giá | P1 | marketing-05.1 | Phân loại bình luận | bảng `social_mentions` | Giám đốc marketing | `intel_import.py` | test_intel_import.py | CODE_VERIFIED, BLOCKED_VENDOR, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | Bình luận, đánh giá | P1 | marketing-05.2 | Soạn nháp trả lời bình luận, đánh giá | hàng duyệt `marketing/ugc_reply`; hàng duyệt `marketing/ugc_reuse` | Giám đốc marketing | `mkt_ugc.py` | test_mkt_ugc.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| marketing | SEO và báo cáo kênh | P1 | marketing-06.1 | Chuẩn hóa trang sản phẩm trên web | hàng duyệt `marketing/seo_web_fix` | Giám đốc marketing | `seo_web.py` | test_seo_web.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| marketing | SEO và báo cáo kênh | P1 | marketing-06.2 | Báo cáo kênh | bảng `channel_snapshots` | Giám đốc marketing | `mkt_metrics.py`, `cockpit.py` | test_mkt_metrics.py, test_cockpit.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| marketing | SEO và báo cáo kênh | P2 | marketing-07.1 | SEO sàn | nháp `listing`; báo cáo `seo-san-` | Giám đốc marketing | `seo_san.py` | test_seo_san.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| marketing | SEO và báo cáo kênh | P2 | marketing-07.2 | YouTube dài | nháp `video` | Giám đốc marketing | `mkt_youtube.py` | test_mkt_youtube.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| intel | Bản tin thị trường | P1 | intel-01.1 | Bản tin thị trường 7h | báo cáo `intel-bulletin-` | Quản lý Marketing | `intel.py`, `intel_bulletin.py` | test_intel.py, test_intel_bulletin.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| intel | Bản tin thị trường | P1 | intel-01.2 | Gợi ý chủ đề cho Marketing | hàng duyệt `intel/intel_topic` | Quản lý Marketing | `intel_bulletin.py` | test_intel_bulletin.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| intel | Báo động đỏ | P1 | intel-02.1 | Báo động sâm giả, mạo danh Ngọc Linh | cảnh báo đỏ counterfeit | Quản lý Marketing | `intel_alert.py`, `red_alert.py` | test_intel_alert.py, test_red_alert.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| intel | Báo động đỏ | P1 | intel-02.2 | Báo động quy định mới | cảnh báo đỏ regulation/competitor_penalty | Quản lý Marketing | `intel_alert.py`, `red_alert.py` | test_intel_alert.py, test_red_alert.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| intel | Báo động đỏ | P1 | intel-02.3 | Báo động tin xấu về Sâm Sâm | cảnh báo đỏ brand_negative | Quản lý Marketing | `intel_alert.py`, `red_alert.py` | test_intel_alert.py, test_red_alert.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| intel | Theo dõi đối thủ | P1 | intel-03 | Theo dõi đối thủ | báo cáo `intel-doithu-` | Quản lý Marketing | `intel_import.py`, `intel_weekly.py` | test_intel_import.py, test_intel_weekly.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| intel | Xu hướng và từ khóa | P1 | intel-04.1 | Xu hướng Google Trends theo tuần | báo cáo `intel-trend-` | Quản lý Marketing | `intel_import.py`, `intel_weekly.py` | test_intel_import.py, test_intel_weekly.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| intel | Xu hướng và từ khóa | P1 | intel-04.2 | Gợi ý từ khóa an toàn pháp lý | hàng duyệt `intel/keyword_suggest` | Quản lý Marketing | `intel_weekly.py`, `intel_import.py` | test_intel_weekly.py, test_v14_p5_mkt_ceo_intel.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| intel | Giả lập khách hàng | P1 | intel-05.1 | Thử thông điệp trên khách hàng giả lập | bảng `sim_runs` | Quản lý Marketing | `persona_sim.py` | test_persona_sim.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| intel | Giả lập khách hàng | P1 | intel-05.2 | Thử giá combo | hàng duyệt `intel/combo_price_option` | Quản lý Marketing | `combo_price.py` | test_contract_c09_combo_price.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| intel | Kịch bản mùa | P1 | intel-06 | Kịch bản mùa | báo cáo `kich-ban-` | Quản lý Marketing | `scenario.py` | test_scenario.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| finance | Đối soát tiền sàn | P1 | finance-01 | Đối soát tiền sàn | bảng `recon_results` | Giám đốc tài chính | `settlement_csv.py`, `kd_orders.py` | test_settlement_csv.py, test_kd_orders.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| finance | Hóa đơn điện tử | P1 | finance-02 | Hóa đơn điện tử | hàng duyệt `finance/invoice_batch` | Giám đốc tài chính | `acc_invoice.py` | test_acc_invoice.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| finance | Công nợ, hoa hồng | P1 | finance-03.1 | Bảng tuổi nợ đại lý | báo cáo `director-finance-` | Giám đốc tài chính | `acc_ar.py` | test_acc_ar.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| finance | Công nợ, hoa hồng | P1 | finance-03.2 | Hoa hồng affiliate | bảng `affiliate_attributions` | Giám đốc tài chính | `kd_affiliate.py` | test_kd_affiliate.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| finance | Công nợ, hoa hồng | P1 | finance-03.3 | Nháp thư nhắc nợ | hàng duyệt `finance/ar_reminder` | Giám đốc tài chính | `acc_ar.py` | test_v13_c06_daily_ar.py, test_acc_ar.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| finance | Lãi lỗ theo kênh | P1 | finance-04.1 | Biên lợi nhuận từng sản phẩm, từng kênh | báo cáo `pnl-` | Giám đốc tài chính | `fp_pnl.py` | test_fp_pnl.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| finance | Lãi lỗ theo kênh | P1 | finance-04.2 | Chặn khuyến mãi bị lỗ | hàng duyệt `sales/promo_change`; hàng duyệt `finance/budget_change`; hàng duyệt `finance/promo_loss` | Giám đốc tài chính | `kd_price.py`, `fp_ads.py` | test_kd_price.py, test_fp_ads.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| finance | Chi phí và dòng tiền | P1 | finance-05.1 | So chi phí AI, quảng cáo với ngân sách | hàng duyệt `finance/opex_over_x` | Giám đốc tài chính | `fp_opscost.py`, `fin_director.py` | test_fp_opscost.py, test_fin_director.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| finance | Chi phí và dòng tiền | P1 | finance-05.2 | Dự báo dòng tiền 13 tuần | báo cáo `dong-tien-` | Giám đốc tài chính | `fp_cash.py` | test_fp_cash.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| production | Báo cáo sản xuất | P1 | production-01 | Báo cáo sản xuất | bảng `allocation_proposals`; báo cáo `sx-bantin-` | Giám đốc sản xuất | `production.py`, `inventory_csv.py` | test_production.py, test_inventory_csv.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| production | Hồ sơ sản phẩm | P1 | production-02 | Hồ sơ sản phẩm | bảng `golden_discrepancies` | Giám đốc sản xuất | `golden_store.py`, `core_store.py` | test_golden_store.py, test_core_store.py | CODE_PARTIAL, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| production | Đối soát nhãn | P1 | production-03 | Đối soát nhãn | hàng duyệt `production/label_check` | Giám đốc sản xuất | `sx_label.py` | test_sx_label.py | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE |
| production | Hồ sơ lô | P1 | production-04.3 | Hồ sơ lô, cảnh báo cận hạn | bảng `production_lots`; báo cáo `sx-canhan-` | Giám đốc sản xuất | `production.py`, `lot_certs.py` | test_production.py, test_contract_c03_lot_certs.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| production | Kho tài liệu R&D (P2) | P2 | production-05.1 | Tra cứu tài liệu R&D | báo cáo `sx-tracuu-` | Giám đốc sản xuất | `sx_tracuu.py` | test_sx_tracuu.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| production | Kho tài liệu R&D (P2) | P2 | production-05.2 | Tóm tắt tài liệu R&D | báo cáo `sx-tomtat-` | Giám đốc sản xuất | `sx_tracuu.py` | test_sx_tracuu.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| farming | Nhật ký vườn qua Zalo | P1 | farming-01 | Nhật ký vườn qua Zalo | bảng `plot_logs`; bảng `garden_voice_drafts` | Giám đốc vùng trồng | `garden.py`, `zalo_garden.py` | test_garden.py, test_zalo_garden.py | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE |
| farming | Nhắc ghi nhật ký | P1 | farming-02.1 | Nhắc người phụ trách khoảnh | bảng `garden_reminders` | Giám đốc vùng trồng | `garden_director.py`, `zalo_garden.py` | test_contract_c02_garden_remind.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| farming | Nhắc ghi nhật ký | P1 | farming-02.2 | Báo giám đốc khi vẫn bỏ trống | báo cáo `garden-week-`; hàng duyệt `farming/plot_log_gap` | Giám đốc vùng trồng | `garden_director.py`, `zalo_garden.py` | test_garden_director.py, test_contract_c02_garden_remind.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| farming | Truy xuất QR | P1 | farming-03.1 | Nối lô thu hoạch với lô sản xuất | bảng `lot_origins` | Giám đốc vùng trồng | `qr_trace.py` | test_qr_trace.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| farming | Truy xuất QR | P1 | farming-03.2 | Trang và tem QR cho khách quét | bảng `qr_codes` | Giám đốc vùng trồng | `qr_trace.py` | test_qr_trace.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| farming | Kho tư liệu vườn | P1 | farming-04 | Kho tư liệu vườn | bảng `garden_media`; bảng `garden_media_releases` | Giám đốc vùng trồng | `garden_media.py`, `garden_media_mkt.py` | test_garden_media.py, test_v13_c05_media.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| farming | Cảnh báo, dự báo (P2) | P2 | farming-05.3 | Cảnh báo thời tiết | hàng duyệt `farming/weather_digest` | Giám đốc vùng trồng | `vt_thoitiet.py` | test_vt_thoitiet.py, test_contract_c11_p2_jobs.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| farming | Cảnh báo, dự báo (P2) | P2 | farming-05.4 | Cảnh báo sâu bệnh | hàng duyệt `farming/pest_alert` | Giám đốc vùng trồng | `vt_thoitiet.py` | test_vt_thoitiet.py, test_contract_c11_p2_jobs.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| farming | Cảnh báo, dự báo (P2) | P2 | farming-05.2 | Dự báo sản lượng thu hoạch | hàng duyệt `farming/harvest_forecast` | Giám đốc vùng trồng | `vt_thuhoach.py` | test_vt_thuhoach.py, test_contract_c11_p2_jobs.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| legal_hr | Kiểm duyệt nội dung tự động | P1 | legal_hr-01 | Kiểm duyệt nội dung tự động | — | Chuyên viên pháp chế | `guardrail.py`, `guardrail_llm.py` | test_guardrail.py, test_guardrail_llm.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| legal_hr | Hồ sơ xác nhận quảng cáo | P1 | legal_hr-02 | Hồ sơ xác nhận quảng cáo | hàng duyệt `legal_hr/xnqc_dossier` | Chuyên viên pháp chế | `xnqc.py` | test_xnqc.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| legal_hr | Kho giấy tờ sản phẩm | P1 | legal_hr-03.2 | Xếp mức được phép quảng bá | hàng duyệt `legal_hr/golden_xnqc_sync` | Chuyên viên pháp chế | `xnqc.py`, `golden_store.py` | test_xnqc.py, test_golden_store.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| legal_hr | Quét kênh, gỡ bài | P1 | legal_hr-04 | Quét kênh, gỡ bài | hàng duyệt `legal_hr/channel_takedown`; hàng duyệt `data_platform/hosting_fix` | Chuyên viên pháp chế | `ra_kenh.py` | test_ra_kenh.py, test_contract_c12_channel_scan.py | CODE_VERIFIED, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| legal_hr | Hợp đồng, dữ liệu cá nhân | P1 | legal_hr-05.1 | Hợp đồng mẫu KOC, đại lý | báo cáo `hd-mau-` | Chuyên viên pháp chế | `contract_check.py` | test_contract_check.py, test_legal_docs.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| legal_hr | Hợp đồng, dữ liệu cá nhân | P1 | legal_hr-05.2 | Mẫu xin đồng ý của khách | — | Chuyên viên pháp chế | `crm.py`, `dpia_draft.py` | test_crm.py, test_dpia_draft.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| legal_hr | Nhân sự | P1 | legal_hr-06.1 | Mô tả công việc | hàng duyệt `legal_hr/hr_jd` | Chuyên viên pháp chế | `pc_hr.py` | test_pc_hr.py | CODE_VERIFIED, UNVERIFIED_LIVE |
| legal_hr | Nhân sự | P1 | legal_hr-06.2 | Sàng lọc hồ sơ | hàng duyệt `legal_hr/hr_screening` | Chuyên viên pháp chế | `pc_hr.py` | test_pc_hr.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| legal_hr | Nhân sự | P1 | legal_hr-06.3 | Chấm công | hàng duyệt `legal_hr/hr_attendance` | Chuyên viên pháp chế | `pc_hr.py` | test_pc_hr.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| legal_hr | Nhân sự | P2 | legal_hr-07 | Cập nhật văn bản pháp luật mới | cảnh báo đỏ legal_doc; hàng duyệt `legal_hr/legal_doc_review` | Chuyên viên pháp chế | `intel.py`, `intel_alert.py` | test_intel.py, test_intel_alert.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Kho dữ liệu chung | P1 | data_platform-01 | Kho dữ liệu chung | — | Quản lý AI | `schema.sql`, `roles.sql` | test_core_store.py, test_golden_store.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Số hóa giấy tờ | P1 | data_platform-02.1 | Đọc chữ tự động từ giấy tờ | bảng `document_fields` | Quản lý AI | `doc_intake.py` | test_doc_intake.py, test_v15_p12_policies.py | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Số hóa giấy tờ | P1 | data_platform-02.2 | Lưu bản gốc kèm mã kiểm tra | bảng `documents` | Quản lý AI | `doc_intake.py` | test_doc_intake.py, test_v15_p12_policies.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Kho tri thức cho chatbot | P1 | data_platform-03 | Kho tri thức cho chatbot | bảng `chunks`; bảng `chunks_internal` | Quản lý AI | `embed_store.py`, `kb_internal.py` | test_embed_store.py, test_kb_internal.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Cổng AI an toàn | P1 | data_platform-04 | Cổng AI an toàn | — | Quản lý AI | `llm_gateway.py`, `pii.py` | test_llm_gateway.py, test_v13_c01_pii_guardrail.py | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| data_platform | Kết nối dữ liệu sàn | P1 | data_platform-05 | Kết nối dữ liệu sàn (nhập file) | bảng `market_snapshots` | Quản lý AI | `market_csv.py` | test_market_csv.py, test_v15_p12_policies.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Vận hành hệ thống | P1 | data_platform-07.1 | Giám sát lỗi | báo cáo `health-` | Quản lý AI | `health_bulletin.py`, `job_runs.py` | test_health_bulletin.py, test_job_runs.py | CODE_PARTIAL, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Vận hành hệ thống | P1 | data_platform-07.2 | Backup hằng ngày | bảng `file_output_evidence` | Quản lý AI | `db_backup.py`, `db_restore_drill.py` | test_db_backup.py, test_dr_drill.py | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| data_platform | Vận hành hệ thống | P1 | data_platform-07.3 | Kiểm thử trước khi đưa thay đổi lên | bảng `eval_runs` | Quản lý AI | `deploy_gate.py`, `agent_eval.py` | test_deploy_gate.py, test_agent_eval.py | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |

### A2. Ngoài 89 (nền tảng TMĐT, blockchain, nghĩa vụ HĐ)

| ID | Phạm vi | GĐ | Tên | code_status | Trạng thái |
|---|---|---|---|---|---|
| sales-08 | nen_tang_tmdt | P1 | Website bán hàng | lam_rieng | BLOCKED_DECISION, UNVERIFIED_LIVE |
| data_platform-06 | nen_tang_tmdt | P2 | Kết nối API sàn chỉ đọc | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| farming-06 | truy_xuat_blockchain | P2 | Neo mã xác thực lên blockchain | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE |
| finance-06 | nghia_vu_hd | P1 | Doanh thu thuần trực tuyến + biên bản đối soát quý | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| data_platform-08 | nghia_vu_hd | P1 | Sổ triển khai 3 bước + hồ sơ nghiệm thu + báo cáo vận hành tháng | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE |
| ceo-90 | nghia_vu_hd | P1 | Nghĩa vụ hợp đồng ngoài phần mềm | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA |
| data_platform-90 | nghia_vu_hd | P1 | Hạ tầng độc lập trên server Bên B | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA |

Website bán hàng + chatbot website: thuộc HĐ, làm ở REPO RIÊNG (quyết định
15/10/2026). Repo lõi: `python -m agents.listing_export --website-feed --out
DIR` xuất nguồn dữ liệu (một bản mô tả đã duyệt + giá list kênh web ĐÃ duyệt
còn hiệu lực trong `price_list` — vá controller 22/10 F2: không fallback giá
golden JSON/kênh khác/floor/promo, đọc bảng giá lỗi → từ chối không ghi tệp;
rượu ẩn giá + không giỏ; manifest sha). Nhập ĐƠN web về `orders`/đối soát:
BLOCKED tới khi website có định dạng xuất đơn thật — không đoán định dạng.

### A3. ID cũ → ID mới (lịch sử giữ nguyên)

| ID cũ | Thay bằng | Lý do (căn cứ PL01) |
|---|---|---|
| ceo-04.1 | ceo-04.3, ceo-04.4, ceo-04.5, ceo-04.6 | PL01 Kiểm soát nội bộ liệt kê riêng bài đăng / giá / voucher — tách 3 đầu ra (giá: báo cáo riêng ceo-gia-); bks-recon về mục BKS |
| ceo-04.2 | ceo-04.6 | gộp đối soát độc lập BKS (trước ở ceo-04.1) vào mục BKS |
| marketing-01 | marketing-01.1, marketing-01.2 | tách 3 bài/ngày ↔ lịch mùa vụ (brief chiến dịch) — 2 đầu ra |
| marketing-03 | marketing-03.1, marketing-03.2 | tách đề xuất ↔ theo dõi chi phí mỗi đơn + giữ/tắt (ad_result) |
| marketing-05 | marketing-05.1, marketing-05.2 | tách phân loại (social_mentions) ↔ soạn nháp trả lời |
| intel-02 | intel-02.1, intel-02.2, intel-02.3 | tách theo nhóm tin PL01 (sâm giả/mạo danh; quy định mới; tin xấu) — đếm theo luật đầu của cảnh báo |
| intel-05 | intel-05.1, intel-05.2 | tách thử thông điệp ↔ giá combo |
| production-04.1 | production-04.3 | PL01 1 dòng 'Hồ sơ lô' — gộp với cận hạn (khối SX = 6) |
| production-04.2 | production-04.3 | gộp vào hồ sơ lô (production-04.3) |
| production-05 | production-05.1, production-05.2 | PL01 (P2) 'Tra cứu, tóm tắt' — 2 đầu ra (sx-tracuu-/sx-tomtat-) |
| farming-02 | farming-02.1, farming-02.2 | tách nhắc người phụ trách ↔ báo giám đốc |
| farming-05.1 | farming-05.3, farming-05.4 | tách thời tiết ↔ sâu bệnh (sâu bệnh không chờ nguồn dự báo) |
| legal_hr-03.1 | data_platform-02.2 | trùng đầu ra 'lưu bản gốc kèm mã kiểm tra' (Hạ tầng) — chuyển sang data_platform-02.2 |
| data_platform-02 | data_platform-02.1, data_platform-02.2 | tách đọc chữ ↔ lưu bản gốc kèm mã kiểm tra |

Dòng `feature_rollout`/`feature_rollout_events`/`output_reviews`/log của id cũ
GIỮ NGUYÊN trong DB (không sinh mới vì không còn trong danh mục). Mục mới vào
sổ bằng `rollout --seed` với mốc MỚI; chỉ kế thừa trạng thái TẮT của id cũ/nhóm
(`thay_the`), không kế thừa ngày chạy thử, duyệt hay nghiệm thu. Đếm cảnh báo
đỏ theo LUẬT ĐẦU của cảnh báo (1 cảnh báo ↔ 1 mục; trước đây `?|` đếm 1 cảnh
báo vào cả intel-02 lẫn legal_hr-07). Phép thử nâng cấp từ DB `939aac9` có lịch
sử: `evidence/contract_g4_upgrade.log`.

### A4. Thiếu sót code đã xử lý (probe trước/sau `evidence/contract_g4_probes_*.log`)

| Mục DOCX | Lỗi/thiếu (bản trước 939aac9) | Sau |
|---|---|---|
| Hạ tầng / Cổng AI an toàn "giới hạn chi phí từng tính năng, nút tắt khẩn" (data_platform-04) | trần + nút tắt chỉ theo agent gateway (1 agent dùng chung nhiều tính năng); feature vượt trần vẫn gọi, `feature` còn lọt vào payload provider | `chat/embed(feature=)` + `feature_caps_usd`/`kill_features`/`LLM_KILL_FEATURES` + `llm_usage.feature_id`; vượt trần/trần 0/không đọc được chi tiêu → chặn, 0 lời gọi; mọi lời gọi trong repo gắn tính năng (test AST). Mức trần GIẢ ĐỊNH — Quản lý AI chốt |
| KD / Chatbot "câu hỏi sức khỏe chuyển cho người thật" (sales-01) | 0/7 câu triệu chứng/dị ứng/tên thuốc bị chặn → tới dịch vụ AI ngoài | 7/7 chặn trước embed/chat; 4/4 câu bán hàng không bị chặn; vẫn là danh sách từ (D-PC-03) |
| Vùng trồng / Cảnh báo (P2) "sâu bệnh" (farming-05.4) | `--fetch` tắt → exit 2 TRƯỚC khi đọc nhật ký: cảnh báo sâu bệnh bị chặn bởi quyết định nguồn thời tiết | `vt_thoitiet --pests` (job `vt_pests`) → `farming/pest_alert`; DB down → exit 2 (không coi là "không có cờ") |
| Marketing / Bình luận "nghi hàng giả…" (marketing-05.1) | phân loại social không có nhãn nghi hàng giả | nhãn `nghi_hang_gia` (từ khóa ĐỀ XUẤT) + mkt_ugc nhận nhãn khi mention không có text |
| Marketing / Quảng cáo "theo dõi chi phí mỗi đơn; đề xuất giữ hay tắt" (marketing-03.2) | kết quả chung loại việc `ad_campaign` với đề xuất (không đếm/duyệt riêng) | loại việc `ad_result`; mục cũ cùng mã không nộp lại |
| Ban TGĐ / Kiểm soát nội bộ "so ... giá" (ceo-04.4) | kiểm giá là 1 đoạn trong báo cáo bài đăng | báo cáo riêng `ceo-gia-<ngày>.md` cùng lần chạy |
| SX / Kho tài liệu R&D (P2) "tra cứu, tóm tắt" (production-05.x) | 1 đầu ra cho cả hai | `sx-tracuu-` (trích nguyên văn) / `sx-tomtat-` (LLM đạt guardrail; lỗi → rơi về tra cứu) |
| SX / Hồ sơ sản phẩm "14 hồ sơ gốc (thành phần, quy cách, số công bố)" (production-02) | không có kiểm cấu trúc/đủ số; không trường thành phần | `python -m ingest.product_dossiers --check` (cấu trúc, người xác nhận, khớp số công bố golden, đủ 14) → hiện exit 2 BLOCKED 0/14 — không bịa dữ liệu |
| Nền tảng TMĐT 3a/3c "một bản mô tả, một bảng giá" (sales-08 làm riêng) | repo lõi không xuất nguồn dữ liệu website | `listing_export --website-feed` (rượu ẩn giá + không giỏ) |
| Tình báo / Bản tin tuần (job `intel_weekly`) | job lỗi quyền dưới login svc_job thật | quyền đọc CỘT tối thiểu `trends_weekly`/`social_mentions` (không `msg_hash`/`excerpt`); probe âm 6/6 vẫn chặn — `evidence/contract_g4_intel_weekly.log` |
| Hạ tầng / Vận hành "giám sát lỗi" (data_platform-07.1) | không có hướng dẫn giám sát ngoài máy | runbook mục 10.6 (probe độc lập chỉ stdlib từ máy riêng); máy giám sát thật = BLOCKED_INFRA |

### A5. Tích hợp ngoài — trạng thái thực tế (`evidence/contract_g4_integrations.log`)

| Tích hợp | Hiện trạng code | Thiếu gì · ai cung cấp | Mức bằng chứng |
|---|---|---|---|
| OCR (số hóa giấy tờ, đọc nhãn) | registry `none` → exit 2 BLOCKED; adapter nhà cung cấp CHƯA viết (đính chính r9) | chọn vendor trong nước + đặc tả API + DPA + key, rồi dev viết adapter · Bên B/Pháp chế | chỉ fail-closed |
| STT (ghi âm nhật ký vườn) | registry `none` → exit 2; adapter nhà cung cấp CHƯA viết (đính chính r9) | chọn vendor + đặc tả API + DPA + key, rồi dev viết adapter · Bên B | chỉ fail-closed |
| Ảnh AI (bối cảnh) | `IMAGE_PROVIDER=none` → exit 2; adapter nhà cung cấp CHƯA viết (đính chính r9) | chọn vendor + đặc tả API + hợp đồng + key, rồi dev viết adapter · Bên B | chỉ fail-closed |
| API Shopee/TikTok (P2) | adapter chỉ đọc theo tài liệu công khai, chưa sandbox | app key + sandbox · Bên B | unit giả lập (KHÔNG phải sandbox) |
| Fanpage Graph API (quét kênh) | không có adapter | page token + quyền · Bên B | — |
| Blockchain neo | provider `none` → CHƯA NEO; `--verify` chỉ đối chiếu NỘI BỘ | chọn chuỗi/phí/tài khoản · hai bên | không có biên nhận neo |
| Nhắc nhân viên vườn tự động | `kenh=null` → BLOCKED, báo GĐ | chọn kênh (D-KH-09) · GĐ vùng trồng | DB test |
| Nguồn thời tiết | `fetch.enabled=false` → exit 2 | duyệt nguồn/điều khoản · GĐ vùng trồng | chỉ fail-closed |
| SMTP cảnh báo đỏ | `--check-routing` exit 1 (thiếu người nhận + kênh) | người nhận độc lập + SMTP_* · Pháp chế/Bên B | — |
| Website riêng | nguồn dữ liệu `--website-feed` có; nhập đơn BLOCKED | repo/owner website + định dạng xuất đơn · Bên B | DB test |

Không chọn vendor, không ký DPA, không gọi endpoint chưa được phép; unit test
transport giả KHÔNG phải bằng chứng sandbox.

### A6. DR bằng Docker (máy dev) — `evidence/contract_g4_dr.log`

Docker 28.4.0 + `postgres:17-alpine` (khớp server 17.6), `pg_dump` 17: 3 ca
`test_dr_drill_real_ok`, `test_dr_drill_real_mismatch_still_cleans`,
`test_zz_no_dr_container_left` PASSED (0 skip; cùng `test_db_backup.py`: 77
passed). Restore vào container riêng (cổng `docker port`), manifest sai → phát
hiện LỆCH + vẫn dọn; DB nguồn chỉ thêm dòng sổ bằng chứng backup
(`file_output_evidence`, thiết kế) — không dòng nào do restore; không còn
container/volume do lượt này tạo. CLI thật: RTO 5,23 giây (gồm dựng server;
restore 2,28 giây), RPO 0,00 giờ, 99/99 bảng khớp — DB test ~620 KB, backup
CHƯA mã hóa, chưa offsite: số đo KHÔNG đại diện server Bên B; diễn tập Mốc C/D
trên server Bên B vẫn là nghĩa vụ chưa làm (VERIFIED_DEV_DR ≠ đã diễn tập).

### A7. Sự cố test chạm DB `samsam` + credential lịch sử

**Chứng minh được (từ evidence ngoài production):** vòng 1 (20/10/2026) các
lượt pytest chọn lọc chạy khi shell chưa đặt `DATABASE_URL` → fixture kết nối
DB `samsam` (danh sách 22 file ở mục 2b); fixture tạo schema tạm + ROLLBACK;
lần kiểm duy nhất lúc đó: 0 schema `t_*` sót lại. Từ vòng 2 có cổng
`tests/_db_guard.py` (vá thêm G1–G3 ngày 21/10); đợt này không kết nối
`samsam`. **Không chứng minh được:** tiến trình con CLI (kế thừa DSN) có COMMIT
dòng vào `public` của `samsam` hay không (`job_runs`, `red_alerts`,
`agent_action_log`…), quyền có bị đổi hay không — không có baseline/audit log
trước sự cố trong repo. Trạng thái: UNVERIFIED. Quản trị viên cần cung cấp:
bản backup `samsam` trước 20/10/2026 hoặc log Postgres (`log_statement`/
pgaudit) phiên 20/10, rồi chạy kiểm chỉ đọc ở mục 2b; xóa/sửa nếu có chỉ do DBA
Bên B quyết.

**Credential:** mật khẩu DB trong `.env` HIỆN VẪN TRÙNG giá trị đã lộ trong
lịch sử Git của repo public (`60d9acf^:evidence/v82_pytest.log`,
`…v82_pytest_vong1.log`; kiểm boolean 22/10/2026, không in giá trị). Release
sạch không xóa được rủi ro lịch sử. Checklist rotation (quản trị viên làm —
agent không đổi credential, không rewrite Git): runbook mục 10.7.

### A8. Trạng thái + giới hạn

Không mục nào `da_nghiem_thu` (96/96 `chua_nghiem_thu`); 0 mục có sổ rollout
trên server Bên B; không có chạy thử/người duyệt thật. Docker dev, DB test và
probe không thay server Bên B, thời gian chạy thử, người duyệt hay biên bản.
Bảng trạng thái từng mục: mục 4 (sinh lại từ danh mục đợt này).

### A9. Đợt an toàn + chuẩn bị nghiệm thu (22/10/2026, nhánh `codex/safety-acceptance` từ `16b33fc`, CHƯA commit)

Đính chính claim cũ: (1) "giá xuất sàn từ golden" (C04) là LỖI an toàn nghiệp
vụ — từ S03 tệp xuất shopee/tiktok chỉ dùng giá `list` ĐÃ duyệt còn hiệu lực
trong `price_list` (manifest + `--verify` mang id giá); (2) "`svc_ui` được tin
tên người do UI truyền" (P0c/R1–R2) là đường giả danh — từ S04 DB không còn
miễn trừ `svc_ui`, quyết định ở UI chế độ thực đi bằng login người; khối của
draft nội dung kiểm ở DB.

**S05 — điều kiện an toàn trước chạy thử ↔ cơ chế hiện có**

| Điều kiện (PL02 mục 2 / lỗi nghiêm trọng / PL01 mục 8) | Cơ chế | Kiểm (test/lệnh) | Trạng thái |
|---|---|---|---|
| 100% lời gọi AI qua cổng; che PII | `pipelines/llm_gateway.py` (mask PII mọi message/embed; `feature=` bắt buộc — test AST); F1: chat sàn tính sales-02 | `tests/test_llm_gateway.py`, `tests/test_fix_san_feature.py`, red-team 50 ca | CODE_VERIFIED (client giả) |
| Câu sức khỏe → chuyển người, không gọi AI | `is_health_question` trước LLM | `tests/test_contract_finalize.py` | CODE_VERIFIED; danh sách từ chờ Pháp chế (D-PC-03) |
| Không gửi tới provider chưa phép | `provider_only` allowlist, `allow_fallbacks=false`, `data_collection=deny`, rỗng = fail-closed | `tests/test_llm_gateway.py` | CODE_VERIFIED; chưa có key vận hành |
| Nội dung công khai: kiểm tự động + NGƯỜI duyệt đúng phiên bản | guardrail `check_publish`; `approve_draft` ký sha; `verify_publish`; S04: danh tính + khối gắn login | `tests/test_store.py`, `tests/test_safety_s04_identity.py` | CODE_VERIFIED (DB test, login thật) |
| Rượu, TPBVSK thiếu XNQC, nhãn AI, câu khuyến cáo, số liệu thiếu nguồn | guardrail codes + readiness SKU + `_unverified_number` | `tests/test_guardrail*.py`, eval guardrail 130/132 | CODE_VERIFIED; danh mục từ/claim chờ Pháp chế |
| Tính năng tắt/chưa đủ bước không lách cổng | `rollout.mode()` ở biên sinh/duyệt/dùng; DB đếm lại khi nâng | `tests/test_rollout_enforce.py`, `tests/test_docx_p0_rollout_gate.py` | CODE_VERIFIED |
| 1 lỗi nghiêm trọng ở giai đoạn có người duyệt → dừng, về chạy thử | `rollout --severe` (đếm lại từ đầu) | `tests/test_rollout.py::test_severe_rolls_back_to_trial_and_resets_clock` | CODE_VERIFIED; phát hiện lỗi là việc của người duyệt (không tự động) |
| Backup hằng ngày / offsite / mã hóa / người giữ khóa / phục hồi — trạng thái RIÊNG | `scripts/db_backup.py` (`BACKUP_OFFSITE`, `BACKUP_PASSPHRASE_FILE`), `db_restore_drill.py`, `dr_drill.py` | DR Docker dev 3/3 | CODE_VERIFIED dev; offsite/mã hóa/khóa CHƯA cấu hình; diễn tập server Bên B chưa — BLOCKED_INFRA (D-HT-01/06/08) |
| Giám sát ngoài máy phát hiện server chính ngừng | `scripts/webhook_probe.py` chạy từ máy NGOÀI (runbook 10.6) | `tests/test_contract_c01_webhook.py` | CODE_VERIFIED; máy giám sát chưa có — BLOCKED_INFRA (D-HT-07) |
| Credential lộ | `scripts/db_rotate_password.py` (S01) | `tests/test_safety_s01_rotation.py` (Docker tạm) | công cụ CODE_VERIFIED; rotation thật CHƯA ĐÓNG ở môi trường nào |

**A03 — PL02 mục 1 (nguyên văn đọc 22/10) ↔ test cơ chế (DB test, dữ liệu giả)**

| Điều khoản | Test | Ghi chú |
|---|---|---|
| 1a ≥5 ngày làm việc + 50 đầu ra, chỉ ghi nội bộ | `test_docx_p0_rollout_gate.py::test_p0a_human_cli_promotes_when_db_count_passes`, `::test_p0a_human_cli_blocked_with_db_reason` (49/50, 4/5, mẫu không tính), `test_rollout_enforce.py` (chạy thử chặn gửi/dùng) | DB tự đếm DISTINCT, bỏ `is_sample` |
| 1b ≥10 ngày có người duyệt, kiểm TỪNG mục trước khi dùng | `test_rollout.py::test_review_stage_needs_10_days_and_no_severe`, `test_v15_p8_outputs.py::test_p8_7_*`, `test_docx_p0_rollout_gate.py::test_p0a_report_review_then_promote_to_operation` | duyệt đúng sha phiên bản |
| 1b lỗi nghiêm trọng → tắt, về chạy thử | `test_rollout.py::test_severe_rolls_back_to_trial_and_resets_clock`, `test_p0a_blocked_wrong_block_forged_by_severe_and_no_counter` | |
| 1c đạt hai bước → vận hành trong phạm vi duyệt | `test_p0a_report_review_then_promote_to_operation` | |
| Gọi thẳng DB/function không vượt cổng | `test_p0a_direct_sql_inflated_evidence_blocked`, `test_p0b_*`, `test_safety_s04_identity.py` | |
| Dữ liệu mẫu/không rõ nguồn không tính | `test_v14_p3_rollout_edges.py::test_approval_queue_sample_flag_not_counted`, `test_v15_p8_outputs.py::test_p8_1_*` | dữ liệu thử nằm ở DB test — không vào hồ sơ server Bên B |

**A05 — chỉ số ↔ nguồn, kỳ đo, mẫu số, múi giờ, xử lý thiếu** (`scripts/ops_monthly.py`; kỳ = tháng lịch giờ VN Asia/Ho_Chi_Minh +07; không sự kiện → "— (0/0) không có mục tới hạn"; thiếu nguồn → "chưa có dữ liệu" — KHÔNG thành 100%; kiểm 22/10 trên DB test rỗng)

| Chỉ số | Nguồn | Mẫu số |
|---|---|---|
| Câu hỏi xử lý ≤2 giờ làm việc ≥90% | convlog live + `approval_queue` `cskh_handoff`, ca `directors/sales.json` | câu hỏi tới hạn trong tháng |
| Báo động đỏ xác nhận ≤2 giờ 100% (kể cả T7/CN/Tết) | `red_alerts` (bỏ bản leo thang) + `red_alert_acks` | cảnh báo gốc tới hạn |
| Gỡ bài ≤24 giờ 100% | `channel_posts` đợt vi phạm | đợt vi phạm tới hạn |
| 0 bài chưa duyệt; 0 quảng cáo rượu/TPBVSK thiếu giấy | `channel_posts` rà kênh sở hữu | lần rà trong tháng (không rà → chưa có dữ liệu; quảng cáo/KOC ngoài kênh sở hữu: chưa có dữ liệu) |
| Báo cáo gửi trước ngày 05 | `ops_monthly --mark-sent` (người gửi) | 1/tháng |
| 0 lỗi nghiêm trọng giai đoạn có người duyệt | `feature_rollout_events` severe | lần vào giai đoạn |
| 100% nội dung đăng qua kiểm tự động + người | `bks_audit --report`, `store --verify-log` | bài đăng |
| 100% lời gọi AI qua cổng | test AST + `llm_usage` | lời gọi |
| Backup 100% số ngày | `backup_runs.jsonl` | ngày trong kỳ |
| Diễn tập 30/11, 18/12, mỗi quý | `drill_runs.jsonl`, `dr_runs.jsonl` | mốc |
| Phát hiện ≤15 phút; phản hồi ≤3 giờ / ≤3 ngày LV; sửa ≤7 ngày | `ops_incidents` + `ops_incident_events` | sự cố trong kỳ (sổ trống ≠ không có sự cố) |
| Chatbot ≤30 giây | convlog `reply_ms` (live) | lượt trả lời |
| Hạ tầng PL01 mục 8 | `data/tai_san_hop_tac.json` (8 cột) | hạng mục |

Ma trận 96 mục + điều kiện READY_FOR_TRIAL: `docs/handover/ma-tran-nghiem-thu.md`
(0/96 sẵn sàng, 0/96 nghiệm thu). Hồ sơ sẵn sàng: `ho-so-san-sang-chay-thu.md`.
Mẫu DỰ THẢO: `mau-ho-so-nghiem-thu.md`. Sự cố DB: `su-co-db-samsam.md`.

### A10. Bảng việc còn lại (vòng r8, 22/10/2026) — phân loại theo bằng chứng thực

Loại: (1) thiếu code — tự làm; (2) có code, chưa kiểm tích hợp; (3) chờ đầu vào/quyết định; (4) chờ hạ tầng/nhà cung cấp; (5) chờ thời gian chạy thử/người thật. Rà 14 mục không `co_code` hoặc ngoài 89 AI.

**Đính chính vòng r9 (23/10/2026):** bản r8 ghi "không mục nào loại (1) — mỗi mục có code/adapter + preflight, phần thiếu nằm ngoài repo" là **SAI**. OCR (`ingest/doc_intake.py` `PROVIDERS = {"none": …}`), STT (`connectors/zalo_garden.py` `STT_PROVIDERS = {"none": …}`) và ảnh AI (`pipelines/image_studio.py` `PROVIDERS = {"none": …}`) mới có registry/chỗ cắm + đường từ chối an toàn — **CHƯA có adapter nhà cung cấp thật**. Bốn mục marketing-02.1, production-03, farming-01, data_platform-02.1 vì vậy là **loại (1) sau quyết định vendor** + loại (4) đồng thời: adapter chỉ viết được khi đã chọn vendor (không đoán endpoint). Phân biệt giữ nguyên: có adapter thật nhưng chưa sandbox = loại (2) (data_platform-06 `market_api`, farming-06 `anchor` OpenTimestamps); mới có registry `none` = chưa có adapter; repo website chưa được giao = chưa kiểm được code ở repo riêng; feed dữ liệu KHÔNG thay website/chatbot hoàn chỉnh. Không đổi `code_status`/`acceptance_status` (4 mục vẫn `mot_phan`, `chua_nghiem_thu`).

82 mục `co_code` còn lại: loại (5) + phụ thuộc chung (3)/(4) ở ma trận (`docs/handover/ma-tran-nghiem-thu.md`, E1–E3/B1–B3).

| ID | Căn cứ | Có trong repo | Thiếu chính xác | Loại | Chủ xử lý | Điều kiện đóng |
|---|---|---|---|---|---|---|
| sales-09 | PL01 mục 3d | — (repo riêng) | Đường dẫn repo + owner chatbot website; giao tiếp KB/guardrail | 3 | Bên B / owner website | Repo được giao + kiểm xuyên repo trên môi trường thật |
| sales-08 | PL01 mục 3a/3c | `listing_export --website-feed` (giá DB đã duyệt, rượu ẩn) | Repo website, định dạng xuất ĐƠN web (D-DL-10) | 3 | Bên B / owner website | Website đọc feed + nhập đơn về `orders` kiểm trên staging |
| marketing-02.1 | PL01 mục 2 Marketing | `image_studio`: dựng ảnh nháp ghép packshot thật, kiểm toàn vẹn pixel packshot, nhãn AI/QC, guardrail chữ, precheck + từ chối trước provider, lưu nháp; registry `PROVIDERS = {"none": _bg_none}` (nền gradient tất định); `--scene` khi provider none → exit 2 | **Code còn thiếu: adapter ảnh AI nhà cung cấp** (chưa viết). Phụ thuộc trước khi viết: chọn vendor, đặc tả API, điều khoản bản quyền/DPA, credential, trần chi phí | 1 (sau quyết định vendor) + 4 | QL AI Bên B chọn/cấp đầu vào; dev viết adapter | Adapter viết xong + contract test (lỗi/timeout/mapping, bọc kill/cap/usage như `llm_gateway`) → evidence sandbox/tích hợp thật với dữ liệu được phép |
| production-02 | PL01 mục 2 SX; PL04 | `product_dossiers --check` (exit 2) | 14 hồ sơ gốc + căn cứ | 3 | GĐ sản xuất | `--check` exit 0 |
| production-03 | PL01 mục 2 SX | `sx_label`: `--text` trích tất định + so golden/lô/listing + `--submit` hàng duyệt; `--image` kiểm định dạng, gọi registry OCR dùng chung của `doc_intake` (chỉ `none`) → exit 2 | **Code còn thiếu: adapter OCR dùng chung** (chưa viết; cùng adapter với data_platform-02.1). Phụ thuộc: chọn vendor OCR trong nước, đặc tả API, hợp đồng/DPA, credential | 1 (sau quyết định vendor) + 4 | QL AI + Pháp chế chọn/cấp đầu vào; dev viết adapter | Adapter OCR viết xong + contract test (lỗi/timeout/mapping) → evidence sandbox với ảnh nhãn được phép rồi tích hợp thật |
| farming-01 | PL01 mục 2 Vùng trồng | `zalo_garden`: chữ → `plot_logs` hash chain, ảnh/video → `garden_media` gỡ metadata; ghi âm kiểm magic bytes → `garden_voice_drafts` chờ người chép; registry `STT_PROVIDERS = {"none": (None, True)}`, `--transcribe` → exit 2 BLOCKED | **Code còn thiếu: adapter STT nhà cung cấp** (chưa viết). Phụ thuộc: chọn vendor STT trong nước, đặc tả API, DPA (giọng nói nhân viên), credential | 1 (sau quyết định vendor) + 4 | QL AI + Pháp chế chọn/cấp đầu vào; dev viết adapter | Adapter STT viết xong + contract test (lỗi/timeout/mapping) → evidence sandbox với ghi âm được phép rồi `--transcribe` tích hợp thật |
| data_platform-02.1 | PL01 mục 2 Hạ tầng | `doc_intake`: intake + sha256, lớp chữ có sẵn đọc được, scan/ảnh → `cho_ocr`, `--verify/--reject` người, `--reprocess-pending`; registry `PROVIDERS = {"none": (_ocr_none, True)}` (chặn provider nước ngoài) → exit 2 `[blocked]` | **Code còn thiếu: adapter OCR dùng chung** (chưa viết; cùng adapter với production-03). Phụ thuộc: chọn vendor OCR trong nước, đặc tả API, hợp đồng/DPA, credential; thêm chính sách `loader_gate` | 1 (sau quyết định vendor) + 4 + 3 | QL AI + Pháp chế chọn vendor, chủ khối chọn chính sách loader; dev viết adapter | Adapter OCR viết xong + contract test → evidence sandbox với tài liệu được phép; chính sách `loader_gate` điền |
| data_platform-07.1 | PL01 mục 2; PL02 mục 2 (≤15 phút) | `health_bulletin`, `webhook_probe` | Máy giám sát NGOÀI server + kênh báo | 4 | Bên B | Thử tắt webhook → máy ngoài báo ≤15 phút |
| data_platform-06 | PL01 mục 3b, 7 (P2) | `ingest/market_api.py`: adapter CHỈ ĐỌC Shopee/TikTok viết theo tài liệu công khai (ký request, allowlist endpoint) — mới chạy với server giả, chữ ký/endpoint CHƯA xác minh sandbox | App key/sandbox Shopee/TikTok (Bên B đứng tên app) | 2 + 4 | Bên B cấp; dev chỉnh adapter theo sandbox | Gọi sandbox thật, đối chiếu file xuất |
| farming-06 | PL01 mục 4b, 7 (P2) | `anchor`: adapter OpenTimestamps có code, mới kiểm với calendar giả; provider mặc định `none` | Chọn chuỗi/provider/phí, tháng neo (provider khác OpenTimestamps → phải viết adapter) | 2 + 3 | Hai bên | Biên nhận neo thật + `ots verify` bên thứ ba |
| finance-06 | PL02 mục 4–5 | `rev_share` | Phí/thưởng/ngày ký/ngày vận hành | 3 | Hai bên | Biên bản đối soát quý ký |
| data_platform-08 | PL02 mục 1 | `rollout`, `ops_monthly`, `acceptance` | Lịch nghỉ; server; người duyệt | 3 + 4 | Bên B | Sổ rollout chạy trên server Bên B |
| ceo-90 | HĐ + PL03/04 | sổ nghĩa vụ N01–N22 | PL05, ngày ký, xác nhận hai bên | 3 | Hai bên | Biên bản từng nghĩa vụ |
| data_platform-90 | PL01 mục 8 | runbook, `deploy/onprem`, DR dev | Server/UPS/offsite/monitor/tài khoản cao nhất | 4 | Bên B | Bàn giao hạ tầng + diễn tập khôi phục trên server |

Website: tìm trên máy dev (`D:\code`) không thấy repo website/chatbot Sâm Sâm — chưa có đường dẫn/quyền; KHÔNG xây vào repo lõi, KHÔNG đóng bằng `website-feed`.

### A11. Đợt r13 (24/10/2026) — 12 mục còn bị chặn: phần code có thể làm

| ID | Code trước | Code sau (r13) | Probe trước → sau (PASS/FAIL) | Mức | Ca P/F/N | Trạng thái nội bộ | Còn chặn bởi |
|---|---|---|---|---|---|---|---|
| production-03 | ảnh nhãn: OCR registry chỉ `none` (exit 2) | OCR tại chỗ `paddle_local` dùng chung doc_intake | a_ocr 2/8 → 10/0 | LOCAL | 10/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| data_platform-02.1 | scan → `cho_ocr` (provider none) | `paddle_local` + reprocess + `ocr_engine`, OCR rỗng không im lặng | a_ocr 2/8 → 10/0 | LOCAL | 12/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| farming-01 | STT registry `none` | `whisper_local` (faster-whisper cục bộ, PyAV, trần, timeout) | b_stt 1/7 → 8/0 | MOCK | 28/0/3 | **BỊ CHẶN** | EXTERNAL_INPUT |
| marketing-02.1 | nền ảnh `none` (gradient) | `openrouter_images` qua cổng llm_gateway | c_image_v2 10/3 → 13/0 | MOCK | 9/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| production-02 | `--check` chỉ số đếm | nêu đích danh SKU thiếu; bắt buộc phiên bản + sha tệp; hồ sơ mẫu không tính | d_dossier 1/4 → 5/0 | LOCAL | 11/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| data_platform-06 | không xử lý 429/5xx, không cổng tính năng | thử lại giới hạn + Retry-After; cổng data_platform-06 trước request | e_market_v2 2/3 → 5/0 | MOCK | 7/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| intel-05.1 | chỉ kiểm ≥3 model | lượt thật đòi ≥3 nhà cung cấp, chặn trước lời gọi | f_persona 3/1 → 4/0 | LOCAL | 7/0/0 | **BỊ CHẶN** | EXTERNAL_INPUT |
| farming-06 | biên nhận chỉ so tiền tố; không upgrade | phân tích cây .ots; submit bỏ phản hồi sai; `--upgrade` → `da_nang_cap` | g_anchor 0/5 → 5/0 | MOCK | 21/0/1 | **BỊ CHẶN** | EXTERNAL_INPUT |
| sales-08 | feed không có verify | `--verify` feed (sha + giá web đã duyệt + mô tả) | h_feed 1/3 → 4/0 | LOCAL | 7/0/1 | **BỊ CHẶN** | SEPARATE_REPO |
| sales-09 | không kênh chat website (repo riêng) | không đổi (không có hợp đồng giao tiếp) | — | LOCAL | 2/0/1 | **BỊ CHẶN** | SEPARATE_REPO |
| ceo-90 | gói kiểm N22 làm tay | `scripts/incident_compare.py` chỉ đọc, từ chối DB samsam | i_incident 0/5 → 5/0 | LOCAL | 7/0/1 | **BỊ CHẶN** | NON_SOFTWARE |
| data_platform-90 | không đo máy chủ; mã hóa/offsite tùy chọn | `scripts/onprem_preflight.py`; bắt buộc mã hóa; offsite khác thiết bị | j_onprem 0/4 → 4/0 | LOCAL | 5/0/1 | **BỊ CHẶN** | NON_SOFTWARE |

Tổng nội bộ 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN; chờ bên ngoài: `dau-vao-va-quyet-dinh.md` mục G; evidence `evidence/itacc_r13_docx12/`; hồ sơ `nghiem-thu-ky-thuat-noi-bo.md` mục 0-r13. Nghiệm thu hợp đồng 0/96 không đổi.

**Đính chính r13-fix4 (25/10/2026):** controller tái hiện 4 lỗi trong phần code r13 — OCR tự tải model khi thiếu `inference.pdiparams` (production-03, data_platform-02.1), ảnh AI hỏng ghi chi phí 0 (marketing-02.1), preflight báo backup ĐẠT khi không có dump/offsite (data_platform-90), `anchor --upgrade` bỏ cổng triển khai (farming-06). Đã vá + kiểm lại 6 mục (production-03 BỊ CHẶN 11/0/0, data_platform-02.1 BỊ CHẶN 13/0/0, marketing-02.1 BỊ CHẶN 11/0/0, data_platform-90 BỊ CHẶN 9/0/1, data_platform-07.2 ĐẠT 12/0/0, farming-06 BỊ CHẶN 24/0/1); tổng nội bộ vẫn 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN; 12 mục vẫn BỊ CHẶN như bảng trên. Evidence `evidence/itacc_r13_fix_4/`; hồ sơ `nghiem-thu-ky-thuat-noi-bo.md` mục 0.

## 0. Baseline và tiêu chí xong (G0)

| Mục | Giá trị |
|---|---|
| Nhánh / HEAD lúc bắt đầu | `main` = `dda008969feef0fcbec8b0ba6f5fab363c813806`, tạo `codex/contract-completion` |
| Untracked có sẵn (ngoài phạm vi, giữ nguyên) | `.agents/`, `founder/`, `lv2-market-top.png` |
| Fingerprint cây baseline | `git ls-files -s \| sha256sum` = `39fbb91f78e2df94…` (1066 file) |
| Nguồn yêu cầu | 5 DOCX (HĐ, PL01, PL02, PL03, PL04) — trích vào scratchpad ngoài repo |
| DB dùng để kiểm | `samsam_contract_g` (test), `samsam_contract_up` (nâng cấp) — KHÔNG phải `samsam` |

Đọc lại claim cũ: board/DONE có nhiều checkpoint lịch sử "chưa commit" —
trạng thái hiện tại lấy theo Git (`dda0089` đã ở `main`) và evidence mới nhất.
Mức bằng chứng hiện có trước đợt: unit/pytest + DB test cục bộ + Docker DR
trên máy dev; **0 mục có bằng chứng chạy trên server Bên B, 0 lần chạy thật với
khách/kênh thật** ngoài smoke LLM qua OpenRouter (`evidence/v31_live_smoke.log`).

**Tiêu chí xong — 5 mức, không gộp:**

| Mức | Đạt khi | Ai xác nhận |
|---|---|---|
| Code | hành vi có code + test hành vi + full pytest/ruff/gate xanh trên revision cuối, DB riêng | Bên A (dev) + reviewer |
| Tích hợp thật | adapter gọi được sandbox/endpoint thật với dữ liệu được phép, có evidence ghi riêng "sandbox"/"production" | Bên A + chủ dịch vụ |
| Triển khai | cài lặp lại được trên server Bên B, schema/roles ×2, login dịch vụ riêng, timer bật bởi người có quyền | Bên B (quản trị) + Bên A |
| Chạy thử | sổ rollout của ĐÚNG mục: ≥5 ngày làm việc + ≥50 đầu ra DISTINCT dữ liệu thật, sau đó ≥10 ngày làm việc có người duyệt từng đầu ra (PL02 mục 1a–b) | DB tự đếm (`rollout --status`), người duyệt Bên B |
| Nghiệm thu | biên bản giai đoạn theo PL05 có chữ ký hai bên, hoặc điều kiện "coi là đã nghiệm thu" PL02 mục 1đ có bằng chứng giao nhận + hết hạn không phản hồi | Đại diện hợp pháp hai bên |

Nhãn trạng thái dùng trong tài liệu: `MISSING_CODE`, `CODE_VERIFIED` (= có
code + test xanh trên DB thử, chưa phải chạy thật), `BLOCKED_DECISION`,
`BLOCKED_VENDOR`, `BLOCKED_INFRA_OR_DATA`, `UNVERIFIED_LIVE`,
`READY_FOR_TRIAL`, `TRIAL_IN_PROGRESS`, `HUMAN_REVIEW_IN_PROGRESS`,
`READY_FOR_ACCEPTANCE`, `OPERATIONALLY_ACCEPTED`. Một mục có thể mang nhiều
nhãn; **không mục nào hiện ở `READY_FOR_TRIAL` trở lên** (thiếu server Bên B,
người duyệt được ủy quyền, dữ liệu thật).

## 1. Phạm vi 89 tính năng (G1)

### 1.1 Sự thật về số

- HĐ Điều 2.1 + PL01 mục 1: 89 tính năng AI / 9 phòng ban. Số theo khối:
  ceo 9 · sales 12 · marketing 14 · intel 11 · finance 9 · production 6 ·
  farming 9 · legal_hr 10 · data_platform 9.
- PL01 mục 2 chỉ liệt kê **51 dòng nhóm** (ceo 5, sales 7, marketing 6, intel 6,
  finance 5, production 5, farming 5, legal_hr 6, data_platform 6) — mỗi dòng
  có thể là 1..n tính năng. Văn bản **không cho phép suy ra duy nhất 89 mục**.
- PL01 mục 6 + PL03 mục 1: P1 = 80 tính năng; P2 = "9 tính năng còn lại" +
  kết nối API sàn + truy xuất blockchain (hai hạng mục sau KHÔNG nằm trong 9).
  Dòng ghi "(P2)" ở mục 2: HĐTV; SEO sàn, YouTube dài; kho tài liệu R&D;
  cảnh báo/dự báo vùng trồng; cập nhật văn bản pháp luật → tách theo đầu ra
  được 7 mục, **thiếu 2 so với 9**.
- Catalog hiện tại: 86 mục = **79 tính năng AI** (do agent đợt v13 phân rã —
  KHÔNG phải số hợp đồng, KHÔNG phải việc user/hai bên đồng ý giảm) + 2 nền tảng
  TMĐT + 1 blockchain + 4 nghĩa vụ HĐ. Không dùng 86 thay 89.
- P1/P2 trong 79: 72 P1 (gồm sales-09 chatbot website làm riêng) / 7 P2.

### 1.2 Lệch theo khối và ứng viên phân rã (chờ hai bên chốt — PL01 mục 9)

Luật đề xuất giữ từ v13: chỉ tách khi chữ gốc liệt kê ĐẦU RA phân biệt mà
người duyệt xem riêng; không tách theo file/agent/CLI/test. Ứng viên dưới đây
đều có căn cứ chữ trong dòng PL01 tương ứng; **chưa áp vào catalog** vì có
nhiều cách tách hợp lệ cho cùng tổng — áp một cách là tự sửa phạm vi.

| Khối | HĐ / catalog | Ứng viên tách có căn cứ chữ (mỗi ứng viên +1) | Ứng viên gộp / không có căn cứ |
|---|---|---|---|
| ceo | 9 / 7 | ceo-03 sổ rủi ro pháp lý liệt kê 4 đối tượng (XNQC, hạn nộp hồ sơ, rủi ro rượu, chỉ dẫn địa lý); ceo-04.1 so 3 đối tượng (bài đăng, giá, voucher) | ceo-04.1 đang đếm cả đối soát BKS (`bks_recon`) — không có trong chữ dòng "Kiểm soát nội bộ" |
| sales | 12 / 12 | — | sales-09 (chatbot website) làm ở repo riêng nhưng vẫn tính trong 12; sales-05 đếm cả `org_prospect_batch`/`b2b_catalog`; sales-07.2 đếm `care_rebuy` (chữ chỉ "xin đánh giá") |
| marketing | 14 / 11 | marketing-05 (phân loại / soạn nháp trả lời); marketing-03 (đề xuất QC / theo dõi chi phí mỗi đơn / đề xuất giữ-tắt); marketing-06.2 (lượt xem / đơn / tỷ lệ hủy) | marketing-03 đếm 2 loại mục cho 1 kế hoạch QC; marketing-06.2 dùng chung bảng `channel_snapshots` với ceo-01 |
| intel | 11 / 8 | intel-02 (sâm giả / mạo danh / quy định mới / tin xấu); intel-03 (giá / KM / SP mới); intel-05 (thông điệp / giá combo) | — |
| finance | 9 / 9 | — | finance-04.2 đếm cả `budget_change` của QC (không thuộc "chặn KM lỗ"); finance-03.1 tiền tố báo cáo trùng `fin_director` |
| production | 6 / 6 | — | production-04.2 cắt từ cùng lần chạy bản tin với production-01 |
| farming | 9 / 7 | farming-01 (chữ / giọng nói / ảnh); farming-02 (nhắc nhân viên / báo giám đốc); farming-05 P2 (thời tiết / sâu bệnh / sản lượng) | farming-06 blockchain ngoài 89, không được đếm vào 9 |
| legal_hr | 10 / 11 | — | **thừa 1**: legal_hr-03.1 dùng cùng `doc_intake` với data_platform-02; 03.1+03.2 có thể là 1 mục "kho giấy tờ + mức quảng bá" |
| data_platform | 9 / 8 | data_platform-03 (KB chatbot / tách tài liệu nội bộ); data_platform-04 (che PII / giới hạn chi phí / nút tắt khẩn); data_platform-05 (đơn / listing / quảng cáo) | data_platform-06 (API sàn) ngoài 89 theo PL01 mục 6 — không đếm hai lần |

Tổng: cần +10 (ceo +2, marketing +3, intel +3, farming +2, data_platform +1,
legal_hr −1). P2 cần +2 trong các dòng có nhãn P2 (ví dụ farming-05 → 3 mục,
marketing-07 SEO sàn theo 2 sàn) — **đây là câu hỏi D-HB-01/02 ở gói quyết
định**, không phải kết luận.

Nếu đổi/tách ID: giữ id cũ + `nhom_goc`, mục tách vào sổ rollout với mốc MỚI
(không kế thừa ngày chạy thử/nghiệm thu của nhóm cũ), owner chạy lại
`python -m pipelines.rollout --seed` để DB đếm theo `count_spec` mới.

### 1.3 Chiều DOCX → code: hành vi còn thiếu (rà code 20/10/2026, 3 agent đọc độc lập)

Đã vá trong đợt (có test + probe, mục 2–3 dưới):
- intel-02: thêm luật `counterfeit` (tin sâm giả/mạo danh Ngọc Linh không nhắc
  tên Sâm Sâm vẫn báo) + "mạo danh" vào nhóm negative; job quét giờ nay thu
  RSS trước (trước đây chỉ thu 06:45 nên quét 60 phút đọc lại tin cũ).
- intel-03: báo độ phủ K5/TRIMICO/KGC mỗi tuần, thiếu → THIẾU.
- ceo-04.2: kiểm chuỗi nhật ký HẰNG NGÀY + cảnh báo đỏ (trước chỉ CLI tháng).
- ceo-01: job thứ Hai chụp số nội bộ tuần trước khi lập báo cáo.
- legal_hr-01: 3 known_gap red-team (mục 2).
- data_platform-02: OCR lại tài liệu `cho_ocr` khi có provider.

Còn thiếu sau VÒNG 1 (MISSING_CODE — lịch sử, đã xử lý ở vòng 2, bảng dưới):
1. sales-01: không có unit dịch vụ 24/7 cho webhook Zalo/Messenger.
2. farming-02: chưa nhắc NHÂN VIÊN (chỉ báo GĐ) — kênh gửi cần quyết định (D-KH-09).
3. production-04.1: chưa lưu số/tệp phiếu kiểm nghiệm của lô (chỉ pass/fail).
4. sales-03: chưa có một bản mô tả chuẩn dùng chung + file xuất cho sàn.
5. ceo-02.x: chưa liệt kê "việc chờ ký".
6. ceo-04.1: giá chỉ đếm cảnh báo đã mở; mô tả listing chưa so với bản duyệt.
7. farming-04: tư liệu vườn chưa cấp cho Marketing (không role/module đọc).
8. finance-04.2: chặn KM lỗ chỉ chạy khi có CSV kế hoạch; đang vào khối sales.
9. intel-05: chưa có phương án "giá combo".
10. production-01: bản tin chưa có tiến độ sản xuất.
11. ceo-05, farming-05.x (P2): chưa có lịch chạy.
12. legal_hr-04: quét kênh là CSV xuất tay, không crawler/lịch.

(Danh sách trên là kết luận VÒNG 1 — lịch sử.)

Vòng 2 (20/10/2026) — xử lý đủ 12 mục MISSING_CODE ở trên (tiêu chí xong
viết trước khi code, ghi tại đây). "Code xong" = có mã + test hành vi (đúng
quyền hoàn tất, sai quyền/sai dữ liệu bị chặn, chạy lại không nhân bản) trên
DB test; KHÔNG có nghĩa đã vận hành thật.

| Mã | Mục | Tiêu chí xong (viết trước) | Đã làm | Probe / test | Trạng thái | Còn chờ (cụ thể) |
|---|---|---|---|---|---|---|
| C01 | sales-01 | unit dịch vụ 24/7 có restart + secret ngoài repo + login dịch vụ; readiness phân biệt sống/sẵn sàng; dò định kỳ có cảnh báo; lỗi cấu hình → thoát ≠0 | `samsam-webhook-zalo/messenger.service` (Restart=always, StartLimit, EnvironmentFile `/etc/samsam/webhook.env`, NoNewPrivileges), `deploy/onprem/webhook-env.example` (chỉ tên biến), `/readyz` (cấu hình + DB login dịch vụ, không lộ DSN), job `webhook_health` 5 phút (`scripts/webhook_probe.py`, 1 cảnh báo đỏ/đợt) | `tests/test_contract_c01_webhook.py` — smoke khởi động THẬT 2 webhook: DB tốt → 200, DB chết → 503, DEPLOY=1 thiếu secret → exit 1; probe không theo redirect; cảnh báo không lặp | CODE_VERIFIED · UNVERIFIED_LIVE | bật 2 unit + secret OA/Meta + `WEBHOOK_DATABASE_URL` trên server Bên B; "có cấu hình 24/7" ≠ "đã chạy 24/7" |
| C02 | farming-02 | nhắc ĐÚNG người phụ trách khoảnh trước khi báo GĐ; chống nhắc trùng; nhật ký mới đóng đợt; không có người/kênh → BLOCKED rõ, không ghi "đã nhắc"; "đã nhắc" chỉ người ghi | sổ `garden_reminders` (1 dòng/khoảnh/đợt), người phụ trách = `khoanh` trong `garden_staff.json`, chính sách `data/garden_remind.json` (kenh null = BLOCKED; `thu_cong`), `--reminders`, `--mark-reminded ID --by` qua `garden_reminder_done_human`; báo GĐ chỉ khi không nhắc được / nhắc rồi quá hạn vẫn trống | `tests/test_contract_c02_garden_remind.py` (9) + test cũ chuyển DB thật; agent_writer không UPDATE được `reminded_*`, tên agent bị function từ chối | CODE_VERIFIED · BLOCKED_DECISION | GĐ vùng trồng chọn kênh (D-KH-09: Zalo/ZNS cần quyết định lưu user_id + chi phí) + điền khoảnh phụ trách |
| C03 | production-04.1 | lưu số + tệp phiếu gắn đúng lô, tệp ngoài repo, hash, người ghi, lịch sử phiên bản; sai lô/tệp hỏng/lệch hash/quyền bị chặn; lô cũ hiện THIẾU | sổ append-only `lot_test_certificates` + `lot_cert_record_human` (khối production), `pipelines/lot_certs.py` (magic bytes PDF/JPG/PNG, ≤20 MB GIẢ ĐỊNH, kho `LOT_CERT_DIR` ngoài repo theo hash), CLI `production cert` / `cert-verify`, mục bản tin "Phiếu kiểm nghiệm lô" | `tests/test_contract_c03_lot_certs.py` (phiên bản v1→v2 giữ bản cũ, cùng tệp ghi lại bị từ chối, sửa/xóa bị chặn, lệch hash/thiếu tệp/thiếu phiếu) | CODE_VERIFIED · BLOCKED_INFRA_OR_DATA | `LOT_CERT_DIR` trên server + phiếu thật Bên B |
| C04 | sales-03 | 1 mô tả chuẩn/SKU có phiên bản + duyệt; xuất theo sàn đúng giá đã duyệt; sửa sau duyệt phải duyệt lại; tệp xuất kiểm được hash; không đăng sàn | mô tả chuẩn = nháp `listing` kênh web ĐÃ duyệt (verify_publish); `agents/listing_export.py` xuất CSV + manifest (sha bản duyệt, phép bỏ dòng giá, giá list golden kênh đích, sha tệp), guardrail theo kênh đích, cổng rollout biên DÙNG; `--verify` | `tests/test_contract_c04_listing_export.py` (xuất/verify, tệp bị sửa, chưa duyệt, sửa sau duyệt, kênh CAM, chạy thử bị chặn) | CODE_VERIFIED · UNVERIFIED_LIVE | mẫu tải lên (mass upload) thật của Shopee/TikTok để chốt tiêu đề cột `data/listing_export_map.json` |
| C05 | ceo-02.x | danh sách chờ quyết định tách chờ ký, có nguồn/hạn/phụ trách/trạng thái; không suy "đã ký"; thiếu quyền → ghi rõ | cờ `project_milestones.sign_required` (từ `can_ky` trong milestones.json — không đoán theo chữ), mục "Việc chờ TGĐ quyết định / chờ ký" trong sổ quyết định + báo cáo tuần/HĐTV; svc_job + bks_reader đọc 3 cột định danh `revenue_quarters` | `tests/test_contract_c05_ceo_waiting.py` (seed cờ, quá hạn, xong-kèm-bằng-chứng mới hết, nguồn không đọc được hiện rõ, svc_job đọc được) | CODE_VERIFIED | mẫu PL05 + chữ ký thật (sổ không lưu chữ ký) |
| C06 | ceo-04.1 | so giá/mô tả đang chạy với ĐÚNG bản duyệt còn hiệu lực; khớp/lệch/không so được + nguồn + thời điểm; không sửa sàn | `ceo_audit` thêm so giá với giá `list` ĐÃ duyệt hiệu lực ngày chụp file; so mô tả khi file có cột mô tả; mục "Giá & mô tả listing đang chạy so bản đã duyệt" | `tests/test_contract_c06_ceo_audit_price.py` (khớp, lệch, giá chưa duyệt/hết hiệu lực → không so được, thiếu cột mô tả) | CODE_VERIFIED · BLOCKED_INFRA_OR_DATA | file xuất listing sàn có cột mô tả (hiện không có → "không so được") |
| C07 | farming-04 | Marketing lấy được ĐÚNG tư liệu đã cấp, đã gỡ GPS; quyền tối thiểu; thiếu/lệch hash/còn EXIF bị chặn; không lộ khoảnh | sổ `garden_media_releases` (cấp/thu hồi, chỉ người farming qua function), view `v_garden_media_marketing` (không khoảnh/tác giả/mẫu), `scripts/garden_media_mkt.py --list/--get` (kiểm sha + EXIF/GPS trước khi chép, cấm thư mục ra trong repo) | `tests/test_contract_c07_media_marketing.py` (chưa cấp/thu hồi bị chặn, tệp sửa/thiếu/còn EXIF bị chặn, app_human không đọc cột tác giả, không ghi thẳng sổ) | CODE_VERIFIED · UNVERIFIED_LIVE | kho `GARDEN_MEDIA_DIR` + ffmpeg + clip thật trên server |
| C08 | finance-04.2 | không bỏ kiểm khi đã có dữ liệu nội bộ; thiếu giá vốn = không tính được; đầu ra đúng khối finance + phối hợp sales; không đổi giá | `kd_price` kiểm thêm KM nội bộ đã duyệt (`price_list` promo) khi không có CSV; `promo_margin_unknown` mức INFO (như `no_cogs`); mục `finance/promo_loss` (GĐ tài chính) cho KM lỗ VÀ không tính được biên; KM lỗ vẫn có mục sales, không tính được biên KHÔNG vào hàng sales (suite `kd_a5` đóng băng coi thiếu giá vốn là thông tin — gate full lượt khám phá bắt khi bản đầu để S2) | `tests/test_contract_c08_promo_loss.py` + 4 test cũ lật có lý do (thiếu giá vốn trước đây im lặng; số mục hàng sales giữ như dda0089); `agent_eval --deterministic` exit 0 | CODE_VERIFIED · BLOCKED_DECISION | giá vốn đã duyệt + tỷ lệ thực nhận (D-KH-05) |
| C09 | intel-05 | phương án giá combo từ thành phần + giá/chi phí có nguồn; nêu giả định; kiểm sàn/biên/guardrail/nhóm hạn chế; không áp giá; chạy lại không nhân bản | `agents/combo_price.py` + `data/combo_price.json` (mức chiết khấu GIẢ ĐỊNH) → mục `intel/combo_price_option` | `tests/test_contract_c09_combo_price.py` (đạt/dưới sàn/lỗ/không tính được/thiếu dữ liệu/nhóm hạn chế, idempotent, rollout tắt) | CODE_VERIFIED · BLOCKED_DECISION | chủ khối chốt mức chiết khấu; thử trên khách giả lập vẫn chờ DPIA |
| C10 | production-01 | tiến độ từ nguồn thật; không suy % từ số lô; kế hoạch/thực tế/chậm/thiếu dữ liệu; nguồn ghi do người | `production_plans` + `production_plan_lots` (append-only, function người khối production), CLI `plan-add`/`plan-link`, mục "Tiến độ sản xuất" | `tests/test_contract_c10_production_progress.py` (chậm, xong, chưa tới khung, khác SKU/lô lạ/gắn trùng bị chặn, mẫu, không kế hoạch = THIẾU DỮ LIỆU) | CODE_VERIFIED · BLOCKED_INFRA_OR_DATA | kế hoạch sản xuất thật do GĐ sản xuất ghi |
| C11 | ceo-05, farming-05.x | job/timer cho luồng P2 có sẵn; chạy được qua wrapper; thiếu dữ liệu/nguồn báo rõ; chạy lại không nhân bản; không tự chuyển vận hành | job `hdtv_month` (`--month prev`, kỳ đã có mục → bỏ qua), `vt_weather`, `vt_harvest` + timer | `tests/test_contract_c11_p2_jobs.py` + `test_svc_job_can_read_job_sources` + chạy THẬT `pipelines.job_runs --run` trên DB test ×2 (`evidence/contract_g2_probes.log`): vt_harvest/hdtv_month exit 0 lần 2 không nhân bản; vt_weather exit 2 BLOCKED; lại bằng login svc_job THẬT ở phép thử nâng cấp (vt_harvest thiếu quyền plots → đã cấp) | CODE_VERIFIED · BLOCKED_DECISION (nguồn dự báo) | GĐ vùng trồng chọn/duyệt nguồn dự báo thời tiết (`fetch.enabled`); bật timer trên server |
| C12 | legal_hr-04 | tự thu từ nguồn ĐƯỢC PHÉP + chạy định kỳ; không coi đọc lại CSV là tự thu; tách thiếu adapter/đặc tả/credential; dữ liệu cũ/nguồn lỗi xử lý rõ; ticket đúng khối | `ra_kenh --scan-auto`: web từ `crawler.collect` (trang công khai Bên B, robots + ≥1s/host; crawl cũ > 7 ngày GIẢ ĐỊNH → không quét, exit 1), listing từ snapshot sàn mới nhất (không cộng thiếu bản duyệt); job `channel_scan`; svc_job quyền tối thiểu `channel_posts` | `tests/test_contract_c12_channel_scan.py` (ticket 24h, chạy lại 0 mới, nguồn cũ/hỏng, auto chỉ định danh agent, svc_job ghi được) | CODE_VERIFIED · BLOCKED_VENDOR (Fanpage) · UNVERIFIED_LIVE | Fanpage: Graph API + page token do Bên B cấp (thiếu adapter — không đoán endpoint) |


### 1.4 Chiều code → DOCX: mục không căn cứ / đếm trùng

Xem cột "Ứng viên gộp" ở 1.2. Thêm: ceo-04.1 ghi `promo_deviation` do
`agent:ceo_audit` nhưng module sinh là `ceo_promo`; `acc_ar.commission`
(hoa hồng đại lý) không mục nào trỏ tới; test alcohol/GI/hàng giả chỉ ở
`tests/test_docx_p2.py` mà catalog ceo-03/marketing-05 không liệt kê.

### 1.5 Website + chatbot website (nghĩa vụ HĐ, repo riêng)

Vẫn thuộc HĐ (PL01 mục 2 sales "Chatbot … website"; mục 3a website bán hàng).
Không xây ở repo này (quyết định user 15/10/2026). **Thiếu:** owner, repo,
tên miền, hosting, quyền truy cập (D-HB-08). Hợp đồng giao tiếp đề xuất
(chưa có code export/import ở repo này):

| Mặt giao tiếp | Đề xuất | Nguồn trong repo |
|---|---|---|
| Sản phẩm/giá | website ĐỌC `sku_master` + `price_list` đã duyệt (không bảng giá thứ hai); rượu sâm: ẩn giá + giỏ (PL01 mục 3a) | `ingest/golden_store.py`, `guardrail.readiness` |
| Đơn/đối soát | đơn website vào `orders` `channel='website'` hoặc file cùng cột `settlement_csv`; lệch tên kênh `web`/`website` trong comment schema cần thống nhất | `agents/kd_orders.py`, `ingest/settlement_csv.py` |
| Nội dung | mọi text đăng qua `guardrail.check_publish` (kênh web) + nhãn AI | `pipelines/guardrail.py` |
| Chatbot | cùng luật kênh `connectors/channels.py`: rượu → template, sức khỏe → chuyển người TRƯỚC LLM, PII che qua gateway, hạn 30 giây, handoff `cskh_handoff`, `rollout.mode` trước khi gửi khách | `connectors/channels.py`, `api/rag.py` |
| Log/KPI | convlog provenance `live` chỉ từ transport thật; KPI qua `chat_kpi_live` | `connectors/zalo.py`, `scripts/ops_monthly.py` |

## 2. An toàn (G2)

- Tái hiện trên baseline: `python scripts/redteam.py` → 50 ca, 3 known_gap
  major (`rt-ay-02`, `rt-ay-03`, `rt-llm-05`), 0 lọt khác. Nguyên nhân thật:
  không có động từ claim → luật lớp 2 bỏ qua; lớp LLM `GUARDRAIL_LLM_MODEL`
  **mặc định tắt** nên 3 câu ĐI QUA (không bị giữ).
- Vá: luật cục bộ `ngam_y_suc_khoe` (major, block) ở `check_publish` — đối
  tượng bệnh/triệu chứng + lời chứng kết quả; chi tiết, quét KB và giới hạn ở
  `docs/handover/phu-luc-d.md` mục 2c. Đổi code kỳ vọng 3 ca
  `llm_ngam_y_suc_khoe` → `ngam_y_suc_khoe` (ghi `code_cu`), giữ text/severity.
- Sau vá: 50/50 chặn đúng code, 0 known_gap; 20 biến thể (không dấu, trộn
  dấu, ZWSP, soft hyphen, homoglyph, chữ cách, tách câu, diễn đạt tương
  đương) chặn; 15 câu bán hàng/khuyến cáo không chặn
  (`tests/test_guardrail_implied.py`). **Giới hạn:** 50 ca dev chưa có nhãn
  Pháp chế; danh sách từ cố định; 0/50 không phải tỷ lệ lọt thực tế.
- Zalo: `send_text` dry-run khi `DEPLOY` tắt (trước đây dev/staging có token
  thật gửi được ra khách) — cùng luật với Messenger.
- **Rủi ro còn mở (nói rõ):** bộ lọc câu hỏi sức khỏe của chatbot
  (`llm_gateway._HEALTH_VI`) là danh sách từ — câu sức khỏe không chứa từ trong
  danh sách (ví dụ "mệt mỏi", "dị ứng", tên thuốc) vẫn tới OpenRouter (công ty
  Mỹ). Nới danh sách đổi hành vi trả lời claim đã công bố → quyết định Pháp
  chế/DPO (D-PC-03). Việc OpenRouter có là "dịch vụ AI ở nước ngoài" theo HĐ
  Điều 12.1 hay không chưa được ai xác định.
- **Đính chính vòng 2 (P1):** vòng 1 đã thêm ngoại lệ "dòng `Hỏi: …?` trong
  kịch bản livestream không áp luật đối tượng" — controller tái hiện câu
  `Hỏi: Món quà dành cho người hay mệt mỏi, ngủ không sâu giấc?` + nhãn QC/AI
  trên `livestream_script` → `ok=True, 0 vi phạm` (lọt). Đã BỎ ngoại lệ theo
  hình thức; `agents/kd_live.py` thay nguyên văn câu hỏi sức khỏe của khách
  (nhận diện bằng `is_health_question` — luồng đã kiểm) bằng dòng trung tính
  + template chuyển chuyên gia TRƯỚC khi gọi guardrail. Probe trước/sau
  (`evidence/contract_g2_probes.log`): ca controller + không dấu/HOA/ZWSP
  `ok=True` → bị chặn; claim nằm trong câu đáp vẫn chặn; `kd_a9` 8/8; red-team
  0/50 (chỉ nói về 50 ca dev chưa nhãn Pháp chế).
- Hồi quy giữ: R1/R2, không agent tự duyệt, người tạo không tự duyệt, PII
  trước AI, hạn 30 giây, không mẫu/UNKNOWN vào KPI — 106 probe chạy lại ở
  gate cuối (DONE.md mục đợt hợp đồng).
- **Phép thử nâng cấp vòng 2 bằng login THẬT** (`evidence/contract_g2_upgrade.log`,
  nền dda0089 VÀ snapshot vòng 1, DB riêng, schema/roles ×2): chạy mọi bước
  `deploy/onprem/jobs.json` bằng login `in role svc_job` (trừ crawl/backup/
  drill) lộ 4 job thiếu quyền đọc dưới login dịch vụ — CÓ TỪ dda0089, test
  fixture chạy bằng owner nên không bắt: `garden_remind` (plots), `vt_harvest`
  (plots số cây/năm trồng), `production_week/_month` (đề xuất phân bổ/BOM/tồn
  kho), `price_watch` (`v_promotable`, giá vốn, giá đối thủ). Đã cấp quyền
  ĐỌC tối thiểu (`docs/roles.sql` khối vòng 2, plots chỉ cột cần) vì C02/C03/
  C08/C10/C11 chạy qua đúng các job này; test
  `test_svc_job_can_read_job_sources`. **Còn lỗi, CHƯA vá (ngoài 12 mục):**
  job `intel_weekly` (`scripts/intel_weekly.py --out-dir`) vẫn
  `InsufficientPrivilege` dưới svc_job. Job `red_alert --deliver` (thiếu người
  nhận), `ra_kenh --scan-auto` (crawl cũ), `webhook_probe` (không có webhook),
  `anchor --build` (0 lá), `content --daily` (không LLM) exit 1/2 là đúng
  thiết kế fail-closed, không phải lỗi quyền.

## 2b. Cổng chặn test kết nối DB production (P0 vòng 2) + sự cố vòng 1

**Cơ chế** (`tests/_db_guard.py`, cài ở dòng đầu `tests/conftest.py`, trước
mọi import dự án; app production KHÔNG đổi): (1) bọc `psycopg.connect`/
`psycopg2.connect` — phân giải dbname thật bằng
`psycopg.conninfo.conninfo_to_dict(conninfo, **kwargs)` (URI, keyword DSN,
`?dbname=` trong query, kwargs ghi đè) → thiếu thì `PGDATABASE`; KHÔNG suy
từ user (vá 21/10 — thiếu DB đích tường minh → từ chối); `service`/`PGSERVICE`
hoặc DSN hỏng → từ chối; dbname ∈ {`samsam`} ∪
dbname của mọi `*DATABASE_URL` trong `.env` → từ chối TRƯỚC khi gọi driver;
(2) `load_dotenv` trong phiên test không bao giờ nạp biến DSN/`PG*`; (3) biến
DSN không đặt tường minh → đặt rỗng (tiến trình con không rơi về `.env`);
(4) `subprocess.Popen` kiểm môi trường HIỆU LỰC tại mỗi lần spawn — `env=`
truyền tay hoặc bản sao `os.environ` khi không truyền/`env=None` (thiếu DSN →
điền rỗng; DSN/`PGDATABASE` cấm, `PGSERVICE` → từ chối trước khi tạo tiến
trình) và argv (URI, `--dbname=`, `-d X`, conninfo keyword); (5) `DATABASE_URL`
tường minh (lượt integration/full) → preflight bắt buộc: lỗi kết nối/truy
vấn/quyền hoặc thiếu bảng lõi/role/golden → dừng phiên exit 4 (chỉ SELECT,
phiên read-only); không đặt `DATABASE_URL` = lượt unit, test cần DB tự skip,
không dùng làm gate. Không có cờ bypass; thông báo chỉ in dbname. So khớp theo dbname
đã phân giải — `samsam_contract_*` hợp lệ. Probe `tests/test_db_guard.py`
(22): mọi ca "DSN samsam" dùng driver GIẢ hoặc host chết `10.255.255.1` —
assert driver CHƯA được gọi; không bao giờ kết nối samsam thật.

**Đính chính 21/10/2026 — claim "cổng test đã chặn toàn bộ" ở checkpoint vòng 2
là SAI.** Controller tái hiện 3 lỗ (driver giả / tiến trình con chỉ in tên DB,
không kết nối samsam): (G1) `subprocess` không truyền `env`/`env=None` không
được kiểm — đổi `os.environ["DATABASE_URL"]` sang samsam sau `install()` rồi
spawn → con nhận DSN samsam, rc 0; (G2) thiếu dbname tường minh → suy từ
user/`PGUSER`/user OS → `psycopg.connect("")` tới driver; (G3) `preflight()`
nuốt mọi `psycopg.Error` → `None`, kể cả `UndefinedTable`/lỗi quyền/không kết
nối được. Đã vá cơ chế chung (mục (1), (4), (5) ở trên); probe trước/sau
`evidence/contract_g3_probe_{before,after}.log`: bản trước 14 FAIL / 25 ca,
bản sau 25/25 PASS; DB test rỗng thật → pytest exit 4
(`evidence/contract_g3_preflight.log`). `tests/test_db_guard.py` 22 → 41 ca.
**Giới hạn còn lại:** guard chỉ bọc `subprocess.Popen` (và `run`/`call`/
`check_output` dùng nó), `psycopg`/`psycopg2` — `os.system`/`os.exec*`/
`multiprocessing`/`asyncio` subprocess không qua cổng (repo test hiện không
dùng để mở DB); sự cố vòng 1 vẫn UNVERIFIED (dưới).

**Sự cố vòng 1 (ghi đúng, không kết luận "không ảnh hưởng"):** trước khi tạo
`samsam_contract_g`, các lượt pytest chọn lọc chạy khi shell chưa đặt
`DATABASE_URL` → conftest/import nạp `.env` → fixture kết nối DB `samsam`.
Đã chạy: `tests/test_redteam.py`, `test_handover_docs.py`,
`test_v13_c01_pii_guardrail.py`, `test_v14_p1_pii_guardrail.py`,
`test_guardrail_v2.py`, `test_guardrail_llm.py`, `test_guardrail.py`,
`test_content.py`, `test_listing.py`, `test_zalo.py`, `test_docx_p1.py`,
`test_messenger.py`, `test_v14_p6_ops.py`, `test_v15_fix_p81.py`,
`test_v15_p7_jobs.py`, `test_zalo_garden.py`, `test_intel_alert.py`,
`test_v13_c07_ops.py`, `test_intel.py`, `test_rollout.py`,
`test_intel_weekly.py`, `test_intel_import.py`. Khả năng ghi: fixture DB tạo
schema tạm + chạy `schema.sql`/`roles.sql` trong 1 transaction rồi ROLLBACK
(role cluster-level tạo trong tx cũng rollback); NHƯNG một số test spawn CLI
tiến trình con với DSN kế thừa — các tiến trình đó có thể đã COMMIT dòng vào
schema `public` của `samsam` (vd `job_runs`, `red_alerts`, `agent_action_log`).
Đã kiểm duy nhất: 0 schema `t_*` sót lại (truy vấn chỉ đọc lúc đó) — KHÔNG đủ
chứng minh dữ liệu/quyền không đổi, và không có baseline trước sự cố để đối
chiếu. Vòng 2 không kết nối `samsam` (kể cả chỉ đọc). Phương án kiểm (chờ user
quyết, chỉ đọc, user/DBA chạy): đếm + lấy `max(id)`/`max(ts)` các bảng có thể
bị ghi (`job_runs`, `red_alerts`, `red_alert_deliveries`, `agent_action_log`
+ `select * from verify_action_log()`, `approval_queue`, `intel_items`,
`channel_posts`) trong khung thời gian phiên 20/10/2026 trước khi tạo DB
riêng; dòng có `created_by`/`actor` dạng test (vd `agent:test`, tên MẪU) là
dấu hiệu; xóa/sửa nếu có chỉ do DBA Bên B quyết.

## 3. Tích hợp (G3) — tách mock / sandbox / thật

Mức: (a) chỉ `none`/tắt · (b) adapter giả chỉ trong test · (c) adapter thật,
chưa chạy endpoint thật · (d) đã có evidence sandbox/live.

| Dịch vụ | Mức | Thiếu: quyết định / adapter / credential / kiểm thật | Hành vi khi thiếu/lỗi | Lệnh kiểm sau khi mở khóa |
|---|---|---|---|---|
| OCR (`ingest/doc_intake.py`, `agents/sx_label.py`) | a | vendor trong nước + DPA / adapter (viết SAU khi chọn, theo tài liệu chính thức) / key / chưa | `cho_ocr`, exit 2 `[blocked]`; nước ngoài bị từ chối; đợt này có `--reprocess-pending` | `OCR_PROVIDER=<vendor> python -m ingest.doc_intake --reprocess-pending` trên 3 tài liệu được phép → `--pending` |
| STT (`connectors/zalo_garden.py`) | a | vendor + DPA / adapter / key / chưa | ghi âm giữ `cho_chep_loi`, `--transcribe` exit 2 không gửi audio | `python -m connectors.zalo_garden --transcribe ID` với 1 ghi âm được phép |
| Ảnh AI (`pipelines/image_studio.py`) | a | vendor + trần chi phí agent `image` / adapter / key / chưa | `--scene` exit 2; gradient không được ghi là ảnh AI | `IMAGE_PROVIDER=<vendor> … --scene` 1 packshot, kiểm nhãn AI + metadata |
| API sàn chỉ đọc (`ingest/market_api.py`) | c (chỉ server giả) | — / endpoint, chữ ký, field theo giả định docs công khai; chưa token refresh, chưa 429/backoff / app key sandbox / chưa | thiếu key → exit 2, 0 request | sandbox Shopee/TikTok do Bên B cấp → evidence riêng "sandbox" |
| Neo blockchain (`pipelines/anchor.py`) | c (provider `none`) | chuỗi/provider/phí (hai bên) / adapter OTS có, chưa upgrade/verify trong hệ thống / — / chưa gửi | `AnchorBlocked` exit 2, ghi "CHƯA NEO" | `--submit` → `--export` → bên thứ ba `ots upgrade`/`ots verify`; trạng thái: đã gom Merkle ≠ đã gửi digest ≠ có receipt calendar ≠ đã xác nhận on-chain |
| SMTP cảnh báo đỏ (`pipelines/red_alert.py`) | c (sender giả) | người nhận độc lập / — / SMTP / chưa gửi | cảnh báo vẫn ghi `route_error`, `--check-routing` exit 1 | `--check-routing` exit 0 rồi 1 cảnh báo thử tới hộp thư được phép |
| Zalo OA / Messenger | c (mock) | — / chữ ký Zalo theo docs công khai chưa xác minh / token OA, app secret / chưa | `DEPLOY` bật thiếu secret → từ chối serve; `DEPLOY` tắt → không gửi (Zalo: từ đợt này) | OA thử nghiệm + 1 người dùng nội bộ |
| Trang QR (`pipelines/qr_trace.py`) | a | tên miền + hosting / — / — / chưa | "tạm ngưng"; không xuất khi chưa cho dùng | `qr_trace site` + triển khai lên tên miền Bên B |
| LLM gateway (OpenRouter) | d | xác định Điều 12.1 (D-PC-03) | lỗi → `GatewayError`, chatbot chuyển người | đã có smoke |
| Website | — | owner/repo (D-HB-08) | — | — |

Không viết adapter đoán endpoint/field/chữ ký. Bảng so sánh vendor cho người
chọn: `dau-vao-va-quyet-dinh.md` mục V.

## 4. Nghiệm thu (G6) — trạng thái từng mục

Quy trình PL02 mục 1: chạy thử nội bộ (≥5 ngày làm việc, ≥50 đầu ra, chỉ ghi
nội bộ) → có người duyệt (≥10 ngày làm việc, kiểm từng mục) → vận hành; 1 lỗi
nghiêm trọng (PL02 mục 2 cuối: từ cấm, rượu công khai, TPBVSK chưa XNQC ở
QC/KOC/livestream, thiếu khuyến cáo, thiếu nhãn AI, lộ PII, số không nguồn) →
tắt, quay lại chạy thử (`rollout --severe`). Bộ đếm DB giữ nguyên điều kiện
DISTINCT/không mẫu/đúng phiên bản/người duyệt (v15 + đợt DOCX).

Theo dõi bàn giao giai đoạn (PL02 mục 1đ–e): ghi ở
`docs/handover/so-nghia-vu-hop-dong.md` — ngày Bên B THỰC nhận hồ sơ + bằng
chứng nhận, danh sách lỗi + ngày nhận, hạn sửa 7 ngày, đề nghị nghiệm thu lại.
"Coi là đã nghiệm thu" khi quá 30 ngày không phản hồi chỉ được ghi khi có
bằng chứng giao nhận và bằng chứng hết hạn; repo không tự tuyên bố hiệu lực
pháp lý và **không đổi `acceptance_status`**.

KPI tháng (PL02 mục 3) ↔ `scripts/ops_monthly.py`: thiếu mẫu số → "chưa có
dữ liệu", không ghi "đạt".

Bảng dưới SINH LẠI từ danh mục đợt hoàn thiện 22/10/2026 (code_status + blocker); **mọi mục
`acceptance_status = chua_nghiem_thu`; không mục nào có sổ rollout trên server
Bên B** (thiếu bằng chứng: server, người duyệt được ủy quyền, dữ liệu thật, đủ
ngày làm việc).

| Mục | Phạm vi | GĐ | Tên | code_status | Trạng thái | Ghi chú | Blocker (rút gọn) |
|---|---|---|---|---|---|---|---|
| ceo-01 | tinh nang ai | P1 | Báo cáo tuần tự động | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-02.1 | tinh nang ai | P1 | Theo dõi tiến độ (sổ mốc) | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-02.2 | tinh nang ai | P1 | Sổ quyết định TGĐ | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-03 | tinh nang ai | P1 | Sổ rủi ro pháp lý | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-04.3 | tinh nang ai | P1 | So bài đăng/listing đang chạy với bản đã duyệt | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | File bài đã đăng + listing Seller Center xuất tay thật (Quản lý MXH); approvers khối ceo (Bên B ủy quyền); lịch job `ceo_audit` có sẵn — Bên… |
| ceo-04.4 | tinh nang ai | P1 | So giá (và mô tả) listing đang chạy với bản đã duyệt | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: báo cáo giá riêng ceo-gia- | Listing Seller Center thật (mapping cột giá/sale_price chưa xác minh với file thật); file xuất listing chưa có cột mô tả → mô tả 'không so đ… |
| ceo-04.5 | tinh nang ai | P1 | So voucher/khuyến mãi đang chạy với bản đã duyệt | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | GĐ bán hàng cung cấp kế hoạch KM ĐÃ chốt (CSV định dạng kd_price --plan) hoặc duyệt giá KM golden (price_list kind promo); Quản lý MXH xuất … |
| ceo-04.6 | tinh nang ai | P1 | Báo khi nhật ký bị sửa + đối soát độc lập BKS | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-05 | tinh nang ai | P2 | Báo cáo HĐTV | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| sales-01 | tinh nang ai | P1 | Chatbot chăm sóc khách (Zalo, Messenger) | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: lọc câu sức khỏe thêm triệu chứng/thuốc | C01: có CẤU HÌNH chạy 24/7 nhưng CHƯA vận hành 24/7 — cần server Bên B bật 2 unit + secret OA/Meta + người nhận cảnh báo |
| sales-09 | tinh nang ai | P1 | Chatbot trên website | lam_rieng | BLOCKED_DECISION, UNVERIFIED_LIVE | — | Repo/owner website + chatbot website chưa xác định — không xây ở repo này (quyết định user 15/10/2026) |
| sales-02 | tinh nang ai | P1 | Gợi ý trả lời chat sàn | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Bên B ủy quyền người MXH được đánh dấu đã dán (`approvers` khối sales trong data/directors/sales.json + login `db_login`) — rỗng thì chế độ … |
| sales-03 | tinh nang ai | P1 | Listing đa sàn | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | C04: mô tả chuẩn = listing web ĐÃ duyệt; xuất CSV + manifest sha cho shopee/tiktok — tiêu đề cột data/listing_export_map.json CHƯA XÁC MINH … |
| sales-04.1 | tinh nang ai | P1 | Người phụ trách khách trong ngày | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B cấp danh sách MÃ nhân viên kinh doanh (data/sales_watch.json lead_owner.staff_codes rỗng — CLI chỉ kiểm mẫu mã); GĐ bán hàng chốt giờ … |
| sales-04.2 | tinh nang ai | P1 | Chuyển khách về đại lý gần nhất | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bảng vùng–đại lý thật (data/dealer_regions.json là MẪU) — Bên B cung cấp |
| sales-05 | tinh nang ai | P1 | Báo giá B2B quà Tết | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Form B2B mặc định TẮT (B2B_FORM_ENABLED — Bên B quyết bật khi có tên miền/hạ tầng); GĐ bán hàng chốt ngưỡng nhắc chốt đơn (sales_watch.json … |
| sales-06.1 | tinh nang ai | P1 | Giám sát giá và phá giá | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Nguồn giá đại lý TỰ ĐỘNG (API/crawl gian hàng đại lý) chưa có — Bên B cấp nguồn/quyền; hiện chỉ file quan sát tay (python -m ingest.dealer_p… |
| sales-06.2 | tinh nang ai | P1 | Cảnh báo đơn trễ, hủy, hoàn bất thường | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B xuất file Seller Center thật có cột ngày đặt/hạn giao (đơn TRỄ hiện 'chưa đo', không suy) + tên trạng thái hoàn/trả thật (sales_watch.… |
| sales-07.1 | tinh nang ai | P1 | Kịch bản và giỏ hàng livestream | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Tài khoản live sàn = external-dep (module không lên sóng) |
| sales-07.2 | tinh nang ai | P1 | Sau bán: xin đánh giá | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Gửi Zalo OA/ZNS do người làm tay (external-dep) |
| sales-07.3 | tinh nang ai | P1 | Kịch bản bán mùa 11.11, 12.12, Tết | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Giả định số bán data/scenario_assumptions.json chờ GĐ KD/TC chốt |
| marketing-01.1 | tinh nang ai | P1 | Soạn 3 bài mỗi ngày | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Trụ nội dung thường ngày + lịch chiến dịch GIẢ ĐỊNH (data/marketing_calendar.json — GĐ Marketing chốt); hiện 0 SKU đủ readiness bài đăng (TP… |
| marketing-01.2 | tinh nang ai | P1 | Lịch mùa vụ (brief chiến dịch) | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Lịch chiến dịch GIẢ ĐỊNH (data/marketing_calendar.json — GĐ Marketing chốt); approvers khối marketing rỗng |
| marketing-02.1 | tinh nang ai | P1 | Ảnh bối cảnh AI quanh ảnh sản phẩm thật | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE | ảnh AI: provider none | Provider sinh nền ảnh AI chỉ có 'none' (nền gradient) — cần vendor + hợp đồng/DPA + key (C05 ghi BLOCKED) |
| marketing-02.2 | tinh nang ai | P1 | Video 15–45 giây từ tư liệu thật | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-03.1 | tinh nang ai | P1 | Đề xuất quảng cáo thử nghiệm | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Tham số đề xuất `data/ads_proposal.json` (tỷ lệ trần, số ngày, chỉ tiêu thành công/dừng) CHƯA CHỐT — GĐ Marketing chốt (chot_boi + can_cu); … |
| marketing-03.2 | tinh nang ai | P1 | Theo dõi chi phí mỗi đơn, đề xuất giữ hay tắt | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: loại việc riêng ad_result | Số kết quả quảng cáo nhập file xuất tay (API nền tảng quảng cáo ngoài phạm vi, agent không chi tiền); cần phiếu đã duyệt đủ 2 mục |
| marketing-04.1 | tinh nang ai | P1 | Bộ tài liệu chuẩn cho KOC/đại lý affiliate | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | KOC thật + hợp đồng ký = external-dep (danh sách KOC đang MẪU) |
| marketing-04.2 | tinh nang ai | P1 | Kiểm tra bài đăng của đối tác | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B/GĐ marketing cung cấp file xuất bài KOC/đại lý ĐÃ đăng (chưa có nguồn tự động — API/crawl MXH của đối tác ngoài phạm vi); KOC thật + h… |
| marketing-05.1 | tinh nang ai | P1 | Phân loại bình luận | co_code | CODE_VERIFIED, BLOCKED_VENDOR, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: nhãn nghi_hang_gia | File export comment/inbox kênh sở hữu do Quản lý MXH xuất tay (chưa có nguồn tự động — Fanpage Graph API chờ Bên B cấp); từ khóa nhãn data/s… |
| marketing-05.2 | tinh nang ai | P1 | Soạn nháp trả lời bình luận, đánh giá | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-06.1 | tinh nang ai | P1 | Chuẩn hóa trang sản phẩm trên web | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-06.2 | tinh nang ai | P1 | Báo cáo kênh | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Số lượt xem kênh chỉ có từ file xuất tay (manual_export) — chưa có API kênh |
| marketing-07.1 | tinh nang ai | P2 | SEO sàn | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-07.2 | tinh nang ai | P2 | YouTube dài | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| intel-01.1 | tinh nang ai | P1 | Bản tin thị trường 7h | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Danh sách nguồn data/intel_sources.json chờ duyệt |
| intel-01.2 | tinh nang ai | P1 | Gợi ý chủ đề cho Marketing | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| intel-02.1 | tinh nang ai | P1 | Báo động sâm giả, mạo danh Ngọc Linh | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | đếm theo luật đầu của cảnh báo | Người nhận cảnh báo đỏ rỗng (data/red_alert_routing.json) — Pháp chế/Bên B cử người nhận độc lập + địa chỉ email + SMTP_* (v14.6 đã có leo t… |
| intel-02.2 | tinh nang ai | P1 | Báo động quy định mới | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | đếm theo luật đầu của cảnh báo | Người nhận cảnh báo đỏ rỗng (data/red_alert_routing.json) — Pháp chế/Bên B cử người nhận độc lập + địa chỉ email + SMTP_* (v14.6 đã có leo t… |
| intel-02.3 | tinh nang ai | P1 | Báo động tin xấu về Sâm Sâm | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | đếm theo luật đầu của cảnh báo | Người nhận cảnh báo đỏ rỗng (data/red_alert_routing.json) — Pháp chế/Bên B cử người nhận độc lập + địa chỉ email + SMTP_* (v14.6 đã có leo t… |
| intel-03 | tinh nang ai | P1 | Theo dõi đối thủ | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Dữ liệu đối thủ nhập tay (file) — chưa có nguồn tự động hợp lệ |
| intel-04.1 | tinh nang ai | P1 | Xu hướng Google Trends theo tuần | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | File Google Trends xuất tay |
| intel-04.2 | tinh nang ai | P1 | Gợi ý từ khóa an toàn pháp lý | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | File Google Trends related xuất tay (Quản lý MXH); Pháp chế duyệt bộ luật lọc (từ cấm/claim/sức khỏe/ rượu) — chưa có lớp LLM-check cho ẩn ý… |
| intel-05.1 | tinh nang ai | P1 | Thử thông điệp trên khách hàng giả lập | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | DPIA chưa ký (data/sim_config.json dpia_signed=false) → chỉ --dry-run; CHỈ người thật đổi cờ |
| intel-05.2 | tinh nang ai | P1 | Thử giá combo | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Mức chiết khấu data/combo_price.json GIẢ ĐỊNH (chủ khối chốt); thử phương án trên khách giả lập vẫn chờ DPIA ký |
| intel-06 | tinh nang ai | P1 | Kịch bản mùa | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Giả định data/scenario_assumptions.json chờ GĐ KD/TC chốt |
| finance-01 | tinh nang ai | P1 | Đối soát tiền sàn | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| finance-02 | tinh nang ai | P1 | Hóa đơn điện tử | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Phát hành trên hệ thống HĐĐT do kế toán làm tay (external-dep) |
| finance-03.1 | tinh nang ai | P1 | Bảng tuổi nợ đại lý | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Sổ công nợ nạp tay (file) — dữ liệu thật Bên B cung cấp |
| finance-03.2 | tinh nang ai | P1 | Hoa hồng affiliate | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Tỷ lệ hoa hồng cấu hình MẪU — GĐ tài chính chốt |
| finance-03.3 | tinh nang ai | P1 | Nháp thư nhắc nợ | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Sổ công nợ thật (dealer_ar nạp tay) + sổ đại lý `dealers` do Bên B cung cấp; người duyệt GĐ tài chính (approvers rỗng — C04); kế toán gửi th… |
| finance-04.1 | tinh nang ai | P1 | Biên lợi nhuận từng sản phẩm, từng kênh | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Giá vốn cần người duyệt (cogs_versions) — GĐ tài chính |
| finance-04.2 | tinh nang ai | P1 | Chặn khuyến mãi bị lỗ | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | giá vốn đã duyệt (cogs_versions) + tỷ lệ thực nhận fpa_config GIẢ ĐỊNH |
| finance-05.1 | tinh nang ai | P1 | So chi phí AI, quảng cáo với ngân sách | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Trần ngân sách cấu hình GIẢ ĐỊNH — GĐ tài chính chốt |
| finance-05.2 | tinh nang ai | P1 | Dự báo dòng tiền 13 tuần | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Số dư đầu kỳ thật + giả định data/fpa_config.json chờ GĐ tài chính |
| production-01 | tinh nang ai | P1 | Báo cáo sản xuất | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Mốc data/production_config.json GIẢ ĐỊNH; tồn kho nạp tay; chưa có kế hoạch sản xuất thật được ghi → bản tin hiện THIẾU DỮ LIỆU |
| production-02 | tinh nang ai | P1 | Hồ sơ sản phẩm | mot_phan | CODE_PARTIAL, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: kiểm sổ hồ sơ gốc (BLOCKED 0/14) | Bên B cung cấp danh mục 14 hồ sơ gốc (tên, thành phần, quy cách, số công bố + căn cứ) vào data/product_dossiers.json `danh_muc_ho_so_goc` — … |
| production-03 | tinh nang ai | P1 | Đối soát nhãn | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE | đọc ảnh nhãn cần OCR | Đọc ẢNH nhãn cần OCR trong nước — registry chỉ có 'none' (exit 2); cần vendor + hợp đồng/DPA + key |
| production-04.3 | tinh nang ai | P1 | Hồ sơ lô, cảnh báo cận hạn | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Kho LOT_CERT_DIR trên server + phiếu kiểm nghiệm thật (Bên B); near_expiry_days GIẢ ĐỊNH 90 — GĐ sản xuất chốt |
| production-05.1 | tinh nang ai | P2 | Tra cứu tài liệu R&D | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Tài liệu nội bộ do GĐ SX duyệt nạp (chưa có) |
| production-05.2 | tinh nang ai | P2 | Tóm tắt tài liệu R&D | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | đợt hoàn thiện: báo cáo tóm tắt riêng sx-tomtat- | Tài liệu nội bộ do GĐ SX duyệt nạp (chưa có); tóm tắt cần OpenRouter qua cổng AI (mặc định tắt `--llm`) — dữ liệu R&D nội bộ gửi dịch vụ AI … |
| farming-01 | tinh nang ai | P1 | Nhật ký vườn qua Zalo | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, UNVERIFIED_LIVE | STT chưa có vendor | Giọng nói chưa có STT (giữ nháp chờ người chép) — cần vendor STT trong nước + DPA |
| farming-02.1 | tinh nang ai | P1 | Nhắc người phụ trách khoảnh | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Kênh nhắc tự động chưa chọn (data/garden_remind.json kenh=null, D-KH-09 — Zalo/ZNS cần lưu user_id + chi phí); danh sách khoảnh phụ trách (`… |
| farming-02.2 | tinh nang ai | P1 | Báo giám đốc khi vẫn bỏ trống | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| farming-03.1 | tinh nang ai | P1 | Nối lô thu hoạch với lô sản xuất | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| farming-03.2 | tinh nang ai | P1 | Trang và tem QR cho khách quét | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Domain công khai cho trang QR chưa có; danh sách người ký data/qr_signers.json rỗng; nhà in tạo ảnh QR |
| farming-04 | tinh nang ai | P1 | Kho tư liệu vườn | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Video đã nhận ở code (C05 v13.4: magic bytes + remux ffmpeg gỡ metadata/GPS, thiếu ffmpeg → từ chối). Còn: event video Zalo OA + host CDN GI… |
| farming-05.3 | tinh nang ai | P2 | Cảnh báo thời tiết | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | nguồn dự báo thời tiết fetch.enabled=false (điều khoản nhà cung cấp chưa xác minh) → job exit 2 BLOCKED |
| farming-05.4 | tinh nang ai | P2 | Cảnh báo sâu bệnh | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: không chờ nguồn dự báo (job vt_pests) | Nhật ký vườn thật (nhân viên ghi qua Zalo/nhập tay); từ khóa cờ sâu bệnh = luật nhật ký hiện có (GĐ vùng trồng rà); bật timer vt_pests trên … |
| farming-05.2 | tinh nang ai | P2 | Dự báo sản lượng thu hoạch | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| legal_hr-01 | tinh nang ai | P1 | Kiểm duyệt nội dung tự động | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | P1 vòng 2: bỏ ngoại lệ livestream | Pháp chế chốt bộ ca red-team (label_status 'chờ Pháp chế duyệt nhãn') + danh sách từ cấm tiếng Anh v14.1; đợt hợp đồng 20/10/2026: 3 known_g… |
| legal_hr-02 | tinh nang ai | P1 | Hồ sơ xác nhận quảng cáo | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| legal_hr-03.2 | tinh nang ai | P1 | Xếp mức được phép quảng bá | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json — chủ khối/hai bên chọn chan_khi_tat/nap_ca_khi_tat; hiện: tính năn… |
| legal_hr-04 | tinh nang ai | P1 | Quét kênh, gỡ bài | co_code | CODE_VERIFIED, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C12: Fanpage cần Graph API (BLOCKED_VENDOR) | Fanpage: cần Graph API + page token do Bên B cấp — CHƯA có adapter (không đoán endpoint), vẫn CSV --file; web/listing đã tự thu — chưa chạy … |
| legal_hr-05.1 | tinh nang ai | P1 | Hợp đồng mẫu KOC, đại lý | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Hợp đồng mẫu là NHÁP — luật sư/Pháp chế rà |
| legal_hr-05.2 | tinh nang ai | P1 | Mẫu xin đồng ý của khách | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | DPIA chưa ký; mẫu văn bản đồng ý chờ Pháp chế |
| legal_hr-06.1 | tinh nang ai | P1 | Mô tả công việc | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Mẫu data/hr/jd_templates.json BẢN DEV SOẠN |
| legal_hr-06.2 | tinh nang ai | P1 | Sàng lọc hồ sơ | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Thời hạn lưu CV chưa chốt (C05 retention TTL null) |
| legal_hr-06.3 | tinh nang ai | P1 | Chấm công | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Luật ca data/hr/attendance_rules.json GIẢ ĐỊNH; thời hạn lưu chưa chốt |
| legal_hr-07 | tinh nang ai | P2 | Cập nhật văn bản pháp luật mới | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | URL nguồn văn bản tầng A chưa xác minh (Pháp chế duyệt data/intel_sources.json); bộ từ khóa legal_doc GIẢ ĐỊNH (data/intel_alert_rules.json … |
| data_platform-01 | tinh nang ai | P1 | Kho dữ liệu chung | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Server nội bộ Bên B chưa có bằng chứng (data_platform-90); Hạ tầng Bên B tạo login thật `in role svc_webhook/svc_job/svc_loader/svc_backup/b… |
| data_platform-02.1 | tinh nang ai | P1 | Đọc chữ tự động từ giấy tờ | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | OCR chưa có vendor | OCR registry chỉ có 'none' — cần vendor OCR trong nước + hợp đồng/DPA + key; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_… |
| data_platform-02.2 | tinh nang ai | P1 | Lưu bản gốc kèm mã kiểm tra | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json — chủ khối/hai bên chọn) |
| data_platform-03 | tinh nang ai | P1 | Kho tri thức cho chatbot | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B ủy quyền người duyệt tài liệu nội bộ (approvers khối data_platform đang rỗng) + login Postgres riêng của người đó (db_login trong user… |
| data_platform-04 | tinh nang ai | P1 | Cổng AI an toàn | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | đợt hoàn thiện: trần + nút tắt theo TÍNH NĂNG | Mức trần chi phí theo TÍNH NĂNG data/llm_gateway.json feature_caps_usd GIẢ ĐỊNH (= trần agent mặc định) — Quản lý AI (Bên B) chốt từng tính … |
| data_platform-05 | tinh nang ai | P1 | Kết nối dữ liệu sàn (nhập file) | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Mapping cột data/market_csv_map.json chưa xác minh với file thật; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json —… |
| data_platform-07.1 | tinh nang ai | P1 | Giám sát lỗi | mot_phan | CODE_PARTIAL, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | đợt hoàn thiện: runbook giám sát ngoài máy; máy giám sát chưa có | Máy giám sát NGOÀI server Bên B chưa có (BLOCKED_INFRA): cài trên máy riêng `python scripts/webhook_probe.py --url https://<server>/readyz -… |
| data_platform-07.2 | tinh nang ai | P1 | Backup hằng ngày | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Offsite/NAS + lịch chạy trên server Bên B chưa có bằng chứng |
| data_platform-07.3 | tinh nang ai | P1 | Kiểm thử trước khi đưa thay đổi lên | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | approvers cổng deploy rỗng — Bên B cử người duyệt; 22 suite chưa frozen; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate… |
| sales-08 | nen tang tmdt | P1 | Website bán hàng | lam_rieng | BLOCKED_DECISION, UNVERIFIED_LIVE | — | Repo/owner website chưa xác định — không xây ở repo này (quyết định user 15/10/2026) |
| data_platform-06 | nen tang tmdt | P2 | Kết nối API sàn chỉ đọc | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | BLOCKED — chưa có app key/sandbox Shopee Open Platform/TikTok Shop (Bên B cấp): chữ ký/endpoint/field/phân trang/rate limit CHƯA VERIFIED, c… |
| farming-06 | truy xuat blockchain | P2 | Neo mã xác thực lên blockchain | mot_phan | CODE_PARTIAL, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Hai bên chọn chuỗi/provider/phí/tài khoản neo (data/anchor_config.json provider 'none' = CHƯA NEO); chưa có biên nhận neo thật nào — adapter… |
| finance-06 | nghia vu hd | P1 | Doanh thu thuần trực tuyến + biên bản đối soát quý | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Tỷ lệ phí/mức thưởng/ngày ký/ngày vận hành null = chưa chốt (data/rev_share.json) |
| data_platform-08 | nghia vu hd | P1 | Sổ triển khai 3 bước + hồ sơ nghiệm thu + báo cáo vận hành tháng | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Lịch nghỉ data/rollout_config.json chưa chốt; danh mục 89 mục chưa chốt |
| ceo-90 | nghia vu hd | P1 | Nghĩa vụ hợp đồng ngoài phần mềm | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA | — | Sổ nghĩa vụ đã lập (docs/handover/so-nghia-vu-hop-dong.md, N01–N20 trạng thái de_xuat) — các nghĩa vụ chờ hai bên thực hiện/xác nhận; PL05 c… |
| data_platform-90 | nghia vu hd | P1 | Hạ tầng độc lập trên server Bên B | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA | — | Chưa có bằng chứng server vật lý/UPS/NAS-offsite/monitor độc lập/người giữ tài khoản cao nhất (F08) |

Đếm nhãn (một mục có thể nhiều nhãn): BLOCKED_DECISION 43, BLOCKED_INFRA_OR_DATA 45, BLOCKED_VENDOR 8, CODE_PARTIAL 8, CODE_VERIFIED 84, UNVERIFIED_LIVE 94. acceptance_status: chua_nghiem_thu 96.

Nhãn `CODE_PARTIAL` (đợt hoàn thiện; trước gọi MISSING_CODE) = mục `code_status: mot_phan` — adapter OCR/STT/ảnh AI chưa viết vì CHƯA chọn nhà cung cấp (không viết adapter đoán) [đính chính r9: adapter API sàn `market_api` và neo OpenTimestamps CÓ code, mới kiểm giả lập, chưa sandbox], kiểm hồ sơ gốc chờ dữ liệu Bên B, giám sát ngoài máy chờ máy giám sát (hạ tầng).

### A12. Đợt r14 (25/10/2026) — phần code còn thiếu bám DOCX

**Đính chính:** A11/r13-fix4 coi 12 mục "chỉ còn đầu vào ngoài code" — chưa đúng. r14 làm: C1 OCR tiến trình con
(production-03, data_platform-02.1), C2 người duyệt nâng cấp biên nhận neo (farming-06), C3a refresh token sàn theo tài liệu
chính thức (data_platform-06). Vẫn CHƯA có code: quyết toán qua API sàn (chờ Kế toán chốt ánh xạ escrow Shopee; tài liệu
finance TikTok). Website/chatbot website vẫn ở repo riêng. Kiểm lại: production-03 BỊ CHẶN 12/0/0, data_platform-02.1 BỊ CHẶN 14/0/0, farming-06 BỊ CHẶN 27/0/1, data_platform-06 BỊ CHẶN 9/0/0. Tổng nội bộ 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN; nghiệm thu hợp đồng 0/96.
Evidence `evidence/itacc_r14_code_gaps/`; hồ sơ `nghiem-thu-ky-thuat-noi-bo.md` mục 0; bảng chờ `dau-vao-va-quyet-dinh.md` mục H.

**Đính chính r14-fix2 (25/10/2026):** A12/r14 có 2 lỗi controller tái hiện — lỗi refresh/dữ liệu sàn in nguyên văn trường lỗi
(có thể là token/khóa) và migration không tạo được chỉ mục unique khi lịch sử neo hợp lệ đã có 2 `da_nang_cap` cùng lần gom.
Đã vá + kiểm lại farming-06, data_platform-06 (farming-06 BỊ CHẶN 27/0/1, data_platform-06 BỊ CHẶN 9/0/0); tổng nội bộ vẫn 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN. Evidence `evidence/itacc_r14_fix_2/`.

**Đợt r15 (25/10/2026) — đính chính + phần code còn thiếu:** r14/r14-fix2 ghi "TikTok finance chưa có tài liệu chính thức
bản hiện hành" — SAI (Partner Center có Get Statements 202309 / Get Transactions by Statement 202501). data_platform-06: đã viết
quyết toán qua API (Shopee + TikTok) theo tài liệu chính thức, ghi CÙNG sổ `settlement_rows`, nhưng ghi sổ BỊ CHẶN tới khi Kế
toán chốt bảng ánh xạ (`data/settlement_api_map.json`) và có API thật — luồng đang dùng vẫn là file CSV. farming-01: hạn STT bọc
cả nạp model. Kiểm lại data_platform-06 BỊ CHẶN 9/0/0, farming-01 BỊ CHẶN 28/0/3; tổng nội bộ vẫn 84 ĐẠT / 0 CHƯA KIỂM / 12 BỊ CHẶN. Website/chatbot website vẫn là code còn thiếu ở repo riêng. Evidence
`evidence/itacc_r15_remaining/`.

**Đợt r15-fix1 (26/10/2026) — vá 3 lỗi tiền của r15:** F1 CSV/API chạy đồng thời cùng đơn từng ghi cả hai nguồn (2 dòng,
view 180.000) → nay khóa (kênh, đơn) quanh kiểm + ghi ở cả hai đường, đúng 1 bên ghi; F2 trường tiền đã ánh xạ thiếu/null/
sai kiểu từng thành 0 và ghi → nay lỗi dữ liệu, 0 dòng cả lượt (vắng = 0 chỉ khi Kế toán quyết `khi_vang: "bang_0"`, cấm
cho order_amount/payout); F3 Shopee từng ghi số USD vào cột `*_vnd` → nay đồng tiền theo từng trường theo đặc tả
get_escrow_detail, không quy đổi. data_platform-06 vẫn BỊ CHẶN (bảng ánh xạ Kế toán + API thật); tổng nội bộ vẫn 84 ĐẠT /
0 CHƯA KIỂM / 12 BỊ CHẶN; nghiệm thu hợp đồng 0/96. Evidence `evidence/itacc_r15_fix_1/`.
