# Báo cáo bàn giao — hạ tầng AI Sâm Sâm (M30 + M31)

Nhánh `ai-infra`, nghiệm thu tổng ngày 15/10/2026 trên DB dựng mới từ đầu
(`samsam_final`). Bằng chứng: `evidence/final_*.log`; nhật ký chi tiết từng
version: `DONE.md`.

> **v12.0 (sau nghiệm thu tổng):** phạm vi căn cứ chuyển sang Hợp đồng hợp tác
> TEDO–Sâm Sâm (9 phòng ban). Phần ngoài phạm vi đã gỡ — xem mục 5. Bảng mục 1
> là kết quả ngày 15/10/2026 TRƯỚC khi gỡ.

## 1. Kết quả nghiệm thu tổng

| Hạng mục | Kết quả |
|---|---|
| Schema | 75 bảng, `apply_schema --roles` chạy 2 lần sạch |
| Nạp dữ liệu | core_store, golden_store, embed_store (868 chunk) |
| Full pytest | 4767 passed, 0 failed, 0 skipped (gồm diễn tập DR trên Docker) |
| Lint | `ruff check .` sạch |
| Bộ ca đánh giá | 25/25 suite hợp lệ; 14 suite tất định đều PASS |
| Red-team guardrail | PASS (ca lọt đều là known-gap đã ghi, chỉ lớp LLM-check bắt) |
| Chatbot `eval_qa` | 11/12 (Q5 mã số doanh nghiệp: bot nói "chưa đủ dữ liệu", không bịa) |
| DPIA/TIA | khớp bản đồ luồng dữ liệu (40 luồng) |
| Chuỗi hash | `agent_action_log` và nhật ký vườn nguyên vẹn |
| 11 agent giám đốc | `director --all --dry-run` hợp lệ |
| Giao diện Streamlit | chưa cấu hình đăng nhập thì chặn truy cập (đúng thiết kế); 7 tab mở không lỗi |

## 2. Đối chiếu gói việc WP00–WP21

"Code xong" = đã có module + test + tài liệu vận hành, chạy được local.
Cột cuối là phần nghiệm thu còn chờ công ty (chi tiết ở mục 3).

| WP | Version | Code | Còn chờ công ty |
|---|---|---|---|
| WP00 Khảo sát, kiến trúc, CR | — | không có code (phỏng vấn, CR) | phỏng vấn 11 trưởng khối, ký CR |
| WP01 Gateway LLM/PII, FinOps | v3.1 | xong | bảng giá token, cap tháng thật, xác minh ZDR từng model |
| WP02 Cloud, vận hành | v3.5, v3.6, v3.7, v3.10 | xong (local + Docker) | Postgres managed trong nước, object storage, server production, kênh cảnh báo |
| WP03 Khung điều phối, duyệt, log | v3.4, v4.0 | xong | SSO, người duyệt thật, ký `auto_policies` |
| WP04a Dữ liệu lõi | v3.2, v3.3 | xong | duyệt 34 dòng giá golden, file Seller Center thật |
| WP04b Số hóa tài liệu, kho tri thức | v3.8, v3.9 | xong | tài liệu thật, provider OCR, object-lock bản gốc |
| WP05 Guardrail v2, Pháp chế–Nhân sự | v3.0, v4.1–v4.4 | xong | Pháp chế duyệt từ cấm/nhãn/XNQC, ký DPIA |
| WP06 Harness nghiệm thu, QA | v4.5, v4.5i | xong | gán nhãn + đóng băng bộ ca, runner cho 8 suite khung |
| WP07 Kinh doanh TMĐT | v5.0–v5.4 | xong | người trực, đại lý thật, chính sách hoa hồng, kế hoạch KM |
| WP08 Marketing, media AI | v6.0–v6.5 | xong | tài khoản ads, key ảnh/video, B-roll có license, Search Console |
| WP09 Tình báo thị trường, kịch bản mùa | v7.0–v7.3 | xong | duyệt nguồn, người nhận cảnh báo đỏ, số bán baseline |
| WP10 Cockpit TGĐ/HĐTV/BKS (P1) | v8.0, v8.1 | xong | quyết định thật, tracker Pháp chế, role DB chỉ đọc |
| WP11 B2B quà Tết (phòng Dự án gỡ ở v12.0; DA-05 → sales, DA-01 → ceo) | v8.2, v8.3 | xong | ma trận chiết khấu, domain/TLS cho form, giá vốn |
| WP12 Tài chính | v9.0, v9.1 | xong | settlement thật, nhà cung cấp HĐĐT, `invoice_trigger`, `fpa_config` |
| WP13 Sản xuất, vùng trồng (P1) | v9.2, v9.3, v9.4 | xong | tồn kho thật, BOM, hồ sơ lô, nhà in tem QR |
| WP14 Điện–cơ khí (P1) | v9.5 | ĐÃ GỠ ở v12.0 (ngoài phạm vi HĐ) | — |
| WP15 Hypercare, đóng băng | v3.10 (công cụ freeze/DR) | công cụ xong | lịch trực 21/12–10/02, break-glass, diễn tập PITR |
| WP16 Agent P2 | v10.0–v10.3 | xong | API sàn, vendor social listening, chữ ký HĐTV/BKS, ZNS |
| WP17 Agent P3 | v11.0 | xong (v12.0 gỡ SX-A6, CK-A5) | giả định năng suất, nhật ký thu hoạch thật |
| WP18 Đào tạo, chuyển giao | tài liệu `docs/handover/` | SOP, runbook, playbook đã có | buổi đào tạo thực tế |
| WP19 PMO | — | không có code | steering, sổ rủi ro |
| WP20 Bảo hành | — | sau go-live | — |
| WP21 Dự phòng | — | — | — |

## 3. Phụ thuộc bên ngoài, gom theo người cấp

### TGĐ / HĐTV-BKS
- Chốt danh sách người duyệt thật từng khối, hiện `approvers: []` ở mọi khối.
- Tạo vai trò riêng cho tài chính, SX, vùng trồng, tình báo (hiện tạm map `tgd`).
- Chốt ma trận 6 vai trò × tab và danh sách user thật cho `users.json`.
- Chốt quota duyệt, lịch vắng người duyệt; duyệt JD/KPI, lương và phụ cấp trực.
- Duyệt lịch đóng băng 21/12–10/02 và danh sách người giữ quyền break-glass.
- Ghi quyết định thật vào `decision_log`; ký trang báo cáo tuần đầu tiên.
- Ký khoản chi vượt ngưỡng X; ký change request trước 25/10.
- Duyệt vendor social listening; ký ủy quyền gỡ/ẩn bài và lịch trực.
- Chốt tuyến dự phòng người trực handoff khối KD; quyết chuỗi leo thang MXH → Pháp chế → TGĐ.
- Duyệt mục `hdtv_pack`; HĐTV/BKS ký gói tháng/quý và biên bản audit; danh sách thành viên + login `bks_reader`.
- Neo head-hash vào bucket object-lock do HĐTV đứng tên, kèm người kiểm độc lập.

### Pháp chế
- Ký DPIA/TIA (luật sư rà, NĐ 356/2025); xác nhận 2 hợp đồng mẫu.
- Duyệt từ cấm, từ khóa rượu, bộ câu bẫy và nhãn bộ ca guardrail, câu khuyến cáo, nhãn AI/QC.
- Duyệt `ngoc_linh.identity` theo chỉ dẫn địa lý; nhãn red-team và tỷ lệ lọt chấp nhận.
- Xác nhận giấy tiếp nhận, XNQC, `sku_readiness`; xác nhận số ĐKSP Savigout (đang trùng Sapentol).
- Hồ sơ XNQC thật và maket cho content TPBVSK; cùng SX xác minh tự công bố mật ong.
- Quy cách nhãn AI trên ảnh/video; quyết các ca "mô tả hay quảng cáo" (listing chưa XNQC, báo giá B2B, trang QR).
- Điều kiện bán rượu B2B / hộp quà offline.
- Câu đồng ý, `policy_version`, TTL liên hệ; consent `marketing` có bao gồm tái dùng UGC không.
- Duyệt template Messenger, mẫu trả lời UGC, nguồn văn bản pháp luật, từ khóa cảnh báo đỏ.
- Xác nhận người nhận cảnh báo đỏ độc lập (`red_alert_routing.json` đang rỗng).
- Xác nhận bằng văn bản cho gửi dữ liệu qua LLM; xem điều khoản RSS từng tòa soạn.
- Tracker Pháp chế thật; duyệt ngưỡng rủi ro trong `ceo_risk.json`.

### Kinh doanh (GĐ bán hàng, sàn, đại lý)
- Duyệt 34 dòng giá golden; chốt giá rượu bình sứ, Saphraton 40v, Combo 2x20.
- Chốt giá sàn, trần KM, ngưỡng lệch; kế hoạch KM thật 11.11/12.12/Tết.
- Cùng tài chính chốt ma trận chiết khấu, biên, VAT, bao bì B2B; cử người gửi báo giá (hệ thống không gửi).
- Danh sách đại lý thật, hợp đồng và chính sách hoa hồng đã ký; voucher thật trên sàn.
- Số bán thật theo SKU × kênh × tuần làm baseline dự báo.
- Ca làm việc, lịch nghỉ lễ/Tết, người trực handoff.
- Chốt `care_rules.json`, `livestream_rules.json` (cùng Pháp chế).
- File Seller Center thật (listing/order/ads/KM) để xác minh mapping cột; giới hạn ký tự từng sàn.
- Danh sách đối thủ chính thức; GĐ bán hàng duyệt lô tổ chức mua quà (`org_prospect_batch`).

### Marketing (GĐ Marketing, MXH)
- Lịch chiến dịch thật; duyệt template prompt/ảnh/video, bộ nhận diện.
- Font, logo, packshot thật; B-roll, nhạc bản quyền, tư liệu video dài.
- Search Console/GA4, quyền sửa website; số reach/tương tác/đơn thật theo kênh.
- Chốt `seo_rules.json`, `trend_keywords.json`, `social_rules.json`.
- Tài khoản + API Meta/TikTok/Shopee Ads; KOC thật và hợp đồng; review thật.
- Export comment/inbox các kênh sở hữu; duyệt danh sách nguồn intel.
- Tài khoản livestream và kênh YouTube.

### Tài chính
- Duyệt giá vốn thật theo SKU (`cogs_versions`).
- Chốt `fpa_config` (biên, hệ số ads, trần, tỷ giá, chi cố định, độ trễ tiền sàn, số dư đầu kỳ).
- Hóa đơn cloud/SaaS thật; doanh thu đại lý/B2B, công nợ từ MISA.
- File settlement thật ≥2 tuần mỗi sàn, biểu phí sàn theo ngày hiệu lực.
- Tư vấn thuế chốt `invoice_trigger` (hạn 25/10/2026); nhà cung cấp HĐĐT, chữ ký số.
- Ký P&L, bản tin, biên bản đối soát, nghiệm thu WP12.
- Chốt bảng giá token, cap LLM tháng.

### Sản xuất / Vùng trồng
- Duyệt `sku_map`; bổ sung hạn dùng/khối lượng vào golden.
- Tồn kho thật theo kho; BOM hộp quà Tết, vật tư bao bì, MOQ/lead time.
- Hồ sơ lô thật, COA; GĐ SX chốt 4 mốc phân bổ và ký kiểm nhập.
- Tài liệu khoa học thật đã duyệt; chốt `harvest_assumptions.json`.
- Lịch canh tác, ảnh vườn, tọa độ khoảnh; nhật ký thu hoạch thật; ngưỡng thời tiết.
- GĐ vùng trồng quyết phương án B ngày 27/11.

### Hạ tầng-IT
(v12.6: theo HĐ, hệ thống lõi chạy trên server vật lý của Sâm Sâm — `deploy/onprem/README.md`; phương án cloud chỉ còn tham khảo.)
- Server vật lý + nơi đặt máy, UPS/nguồn dự phòng, đường truyền, IP tĩnh; tài khoản quản trị cao nhất (OS, Postgres superuser, tên miền, router) do Sâm Sâm giữ, cấp tài khoản vận hành cho Bên A.
- SSO nội bộ đứng tên Sâm Sâm nếu dùng `AUTH_MODE=proxy` (mặc định `AUTH_MODE=local` trong LAN; thay `--by` tự khai).
- Postgres tự quản trên server đó, PITR/WAL ra ổ/NAS ngoài server, ổ/NAS thứ hai cho `BACKUP_OFFSITE=dir:` + bản xoay vòng cất ngoài phòng máy, khóa mã hóa backup do Sâm Sâm giữ.
- Object-lock/neo ngoài cho `agent_action_log`, `plot_logs`, `audit_runs` và kho bản gốc OCR.
- Login DB thật, chạy `roles.sql` trên server, các role hẹp (`loader`, `market_sync`, `webhook`, `backup`, `ci`…).
- Docker + image `postgres:17-alpine` cho diễn tập DR, systemd timer backup/drill/báo cáo vận hành, Uptime Kuma + 1 monitor ngoài server (phát hiện sự cố ≤15 phút).
- Kênh gửi cảnh báo thật (SMTP/Telegram/Zalo) kèm người nhận.
- CI GitHub với secret, self-hosted runner trong nước; n8n ghi `eval_runs` qua HMAC; cron cho agent.
- pgvector ≥0.8 local + cloud.
- Secret thật: `CONTACT_VAULT_KEY` (backup tách DB), `CHANNEL_HASH_SALT`, `INTEL_HASH_SALT`.
- Domain/TLS/reverse proxy cho form B2B và trang QR.
- Meta app review, webhook Messenger; app key Shopee/TikTok; ZNS; key TTS/video/ảnh AI; OCR có phí.

### Khác
- Chủ khối ký `auto_policies` và nghiệm thu WP07, WP08, WP12, WP16, WP17.
- Công ty gán nhãn và đóng băng bộ ca từng agent; ≥100 ca đối kháng có nhãn người thật.
- `digest_recipients` của 9 khối.
- Vendor social listening, nguồn báo trả phí, API thời tiết, nhà in tem QR.
- Bảng sáp nhập 34 tỉnh chính thức.

## 4. Rủi ro phải chốt trước khi bật thật

- **Trước khi bật `auto_policy`:** `auto_approve_item` đang tin risk/qa/guardrail do agent tự khai; cần nguồn tin cậy trước.
- **Trước khi nối kênh gửi tin thật (KD-A7):** `verify_send` không ghi "đã gửi", không giới hạn tuổi bản duyệt → có thể gửi lặp; trần 2 tin/tháng đếm không khóa.
- **Trước khi chi hoa hồng (KD-A8):** hoa hồng đơn cũ bị tính lại theo tỷ lệ hiện tại của đại lý; cần chốt tỷ lệ tại thời điểm ghi nhận.
- **Trước khi mở Messenger/kênh mới cho khách:** ký DPIA/TIA.
- **Nhãn AI:** `agent_writer` ghi được `is_ai=false` → bài đó né nhãn AI khi duyệt (chờ quyết).
- **Khóa mã hóa CRM:** mất khóa là mất PII; phải backup khóa tách khỏi backup DB.
- **Quyền DB:** app local còn chạy DSN owner; chặn quyền chỉ hiệu lực khi chuyển DSN theo role.
- **Hash chain:** xóa dòng cuối chuỗi chỉ phát hiện được khi có neo ngoài (object-lock).
- **RPO ≤15 phút** cho leads/orders/consent chỉ đạt bằng PITR (pg_dump hằng ngày = RPO 24h).
- **OCR:** Google Vision (nước ngoài) cấm với tài liệu có PII.

## 5. v12.0 — gỡ phần ngoài phạm vi Hợp đồng hợp tác TEDO–Sâm Sâm

Căn cứ: HĐ Điều 1.3 + Phụ lục 01 mục 5 loại trừ cơ khí, chế tạo máy, xúc
tiến đầu tư; HĐ có đúng 9 phòng ban (ceo, sales, marketing, intel, finance,
production, farming, legal_hr, data_platform). `SOW_SamSam_AI_6-thang.md`
giữ làm lịch sử, không còn là căn cứ phạm vi.

| Hạng mục | Xử lý ở v12.0 |
|---|---|
| WP14 Điện–cơ khí: CK-A1 tra cứu tài liệu mật, CK-A2 sổ máy/bảo trì, năng lực đóng gói, CK-A5 bảo trì dự đoán | ĐÃ GỠ (module, dữ liệu mẫu, suite eval, 3 bảng + 1 view trong `schema.sql`, khối `mechanical`) |
| DA-02 gợi ý CR, DA-03 radar chương trình, DA-04 hồ sơ tham gia, DA-06 hồ sơ đối tác | ĐÃ GỠ (module, dữ liệu, bảng `programs`, khối `projects`, luồng DF-28) |
| SX-A6 concept R&D | ĐÃ GỠ (module, `rd_concepts.json`, luồng DF-40, id gateway `sx_rnd`); GIỮ kho tài liệu R&D `sx_tracuu` |
| DA-05 danh sách tổ chức mua quà Tết | CHUYỂN khối `sales` (tính năng «Báo giá B2B quà Tết») |
| DA-01 sổ mốc + bảng tuần | CHUYỂN khối `ceo` (tính năng «Theo dõi tiến độ, sổ quyết định»); gỡ các mốc của phần đã bỏ |

Sau gỡ: 71 bảng, 22 suite (8 khung), 38 luồng dữ liệu, 9 khối giám đốc.
Bảng cũ (`machines`, `maintenance_plans`, `incidents`, `programs`) KHÔNG bị
drop trên DB đang chạy — DB dựng mới sẽ không có; xóa trên DB cũ do người
quản trị quyết (có backup trước).
External-dep chỉ của phần đã gỡ (Kỹ sư trưởng, firewall luồng mật cơ khí,
data room/NDA, R&D concept, GĐ dự án) đã bỏ khỏi mục 3.
