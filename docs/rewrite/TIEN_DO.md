# Tiến độ viết lại sang TypeScript (NestJS/Next.js) — 30/10/2026

Đối chiếu bản TS (`ts/`) với 96 mục `data/contract_features.json`. Kế hoạch: [KE_HOACH.md](KE_HOACH.md),
bàn giao: [BAN_GIAO.md](BAN_GIAO.md). Chưa commit.

Việc viết lại chạy 3 lượt: lượt 1–2 dừng giữa chừng; lượt 3 chạy lại một lần sau khi phiên chết
(trạng thái được trích từ journal, không làm lại phần đã có tệp).

## Tóm tắt

- 34/34 nhóm module đã port và qua review đối kháng: 19 PASS, 15 FIX (rag, zalo, garden_zalo,
  garden_director, mkt_koc_ugc_seo, image_video, ra_kenh, intel_crawl, settlement, market, fin_cash,
  production, sx_docs, bks_hdtv, ops_scripts) — cả 15 đã sửa ở lượt 3, 0 BLOCKER còn mở.
- Tích hợp xong 3 bước (core, đăng ký 107 lệnh CLI + lịch BullMQ 34 job, kiểm toàn bộ). Web Next.js có
  đủ 7 tab thay Streamlit. Review cuối (bảo mật / egress AI / độ phủ) xong, các lỗi chặn đã sửa.
- 96 mục: **83 Đủ, 8 Một phần, 1 Giữ Python, 4 không phải code, 0 chưa có**.
- Kiểm cuối (coordinator chạy lại 30/10 chiều): `biome ci`, `tsc` 3 project, `vitest` toàn bộ (5941 pass,
  0 fail, 9 skip vì thiếu môi trường), `ruff` và pytest unit Python đều xanh. 2 test flaky đã sửa.

Cách đọc bảng:
- **TS = Đủ**: mọi module Python của mục có bản TS, đã qua review, test xanh với DB test + nhà cung cấp
  giả. Chặn ngoài giống hệt Python (thiếu key/người duyệt/dữ liệu Bên B) không tính là thiếu.
- **Một phần**: còn phần chưa có ở TS hoặc phần giữ Python. **Giữ Python**: không viết lại theo
  KE_HOACH mục 3. **—**: `lam_rieng`/`ngoai_code`.
- **Python** = `code_status` trong danh mục (`mot_phan` ở đó là giới hạn của chính bản Python).
- **Module TS** = `ts/apps/api/src/modules/<thư mục>`; `core` = `ts/packages/core`.
- **Lệnh TS** = `node_modules/.bin/tsx apps/api/src/cli.ts <lệnh> <cờ như Python>` (chạy ở `ts/`).
  Lịch: `cli.ts job-runs --run <tên>` hoặc worker BullMQ (`WORKER_JOBS`).

## Kết quả kiểm cuối (30/10, chạy lại tuần tự trên máy dev)

| Kiểm | Lệnh (trong `ts/`) | Kết quả |
|---|---|---|
| Lint/format | `biome ci .` | exit 0 — 534 tệp, 0 lỗi, 36 cảnh báo (`noNonNullAssertion`…, không làm đỏ) |
| Typecheck core | `tsc -p packages/core` | exit 0 |
| Typecheck API | `tsc -p apps/api` | exit 0 |
| Typecheck web | `tsc -p apps/web` | exit 0 (khi chưa có `.next/`) |
| Test toàn bộ | `vitest run` theo 38 nhóm thư mục (1 luồng, nạp `db.env` → DB test `samsam-ts-db`) | exit 0 cả 38 nhóm — 195 tệp; test: **5941 pass, 0 fail**, 9 skip (5950) |
| Python | `ruff check . --extend-exclude .agents --extend-exclude founder`; `pytest tests/test_data_flow_map.py tests/test_ci_workflow.py tests/test_dpia_draft.py tests/test_legal_docs.py` (không `DATABASE_URL`) | ruff sạch; 111 pass |

- Đã sửa 2 test flaky (chỉ sửa test, mã nguồn không đổi):
  - `packages/core/src/rollout/rollout.db.test.ts`: cửa sổ đếm `created_at <= until` lấy `until = new Date()` ở
    máy host, còn dòng vừa ghi mang `now()` của container DB (nhanh hơn ~2 ms) → rơi ra ngoài cửa sổ. Test giờ lấy
    `until` bằng `select now()` của DB. Chạy riêng 3 lần: 24/24.
  - `packages/core/src/ops/job-runs.test.ts` ("khóa tự nhả khi kết nối chết"): server hủy backend bất đồng bộ nên
    khóa advisory chưa nhả ngay. Test giờ chờ theo điều kiện (tối đa ~5 s). Chạy riêng 3 lần: 12/12.
  - Sau sửa, chạy lại cả nhóm `packages/core`: 292/292; 37 nhóm còn lại xanh trong cùng lượt toàn bộ.
- 9 skip: dựng mp4 thật cần ffmpeg (6), dr-drill Docker thật (3, cần `TS_TEST_DR_DOCKER=1`).
- Sau khi chạy: không còn DB test nào sót ngoài `samsam_ts_tpl`.

## Tổng theo khối

| Khối | Số mục | Đủ | Một phần | Giữ Python | Không phải code |
|---|---|---|---|---|---|
| ceo | 10 | 8 | 1 | 0 | 1 |
| sales | 13 | 11 | 0 | 0 | 2 |
| marketing | 14 | 13 | 1 | 0 | 0 |
| intel | 11 | 10 | 1 | 0 | 0 |
| finance | 10 | 10 | 0 | 0 | 0 |
| production | 6 | 6 | 0 | 0 | 0 |
| farming | 10 | 9 | 1 | 0 | 0 |
| legal_hr | 10 | 9 | 1 | 0 | 0 |
| data_platform | 12 | 7 | 3 | 1 | 1 |
| **Tổng** | **96** | **83** | **8** | **1** | **4** |

## Bảng 96 mục theo khối

### ceo (10 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| ceo-01 | Báo cáo tuần tự động | P1 | co_code | Một phần | `ceo_report` | `ceo-report`, `cockpit` | 3 section v8.1 (sổ quyết định/rủi ro/audit) chỉ nối ở CLI/worker, API chưa nối |
| ceo-02.1 | Theo dõi tiến độ (sổ mốc) | P1 | co_code | Đủ | `pmo_ops`, `ceo_misc` | `da-pmo`, `ceo-decisions` | phần da_pmo ở pmo_ops, phần ceo_decisions ở ceo_misc |
| ceo-02.2 | Sổ quyết định TGĐ | P1 | co_code | Đủ | `ceo_misc` | `ceo-decisions` |  |
| ceo-03 | Sổ rủi ro pháp lý | P1 | co_code | Đủ | `ceo_misc` | `ceo-risk` |  |
| ceo-04.3 | So bài đăng/listing đang chạy với bản đã duyệt | P1 | co_code | Đủ | `ceo_misc` | `ceo-audit` |  |
| ceo-04.4 | So giá (và mô tả) listing đang chạy với bản đã duyệt | P1 | co_code | Đủ | `ceo_misc` | `ceo-audit` |  |
| ceo-04.5 | So voucher/khuyến mãi đang chạy với bản đã duyệt | P1 | co_code | Đủ | `ceo_misc` | `ceo-promo` |  |
| ceo-04.6 | Báo khi nhật ký bị sửa + đối soát độc lập BKS | P1 | co_code | Đủ | `bks_hdtv`, core | `bks-audit`, `store`, `bks-recon` | nhật ký `store` ở core |
| ceo-05 | Báo cáo HĐTV | P2 | co_code | Đủ | `bks_hdtv` | `hdtv-report` |  |
| ceo-90 | Nghĩa vụ hợp đồng ngoài phần mềm | P1 | ngoai_code | — | — | — | ngoài code (sổ nghĩa vụ) |

### sales (13 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| sales-01 | Chatbot chăm sóc khách (Zalo, Messenger) | P1 | co_code | Đủ | `zalo`, `messenger_fanpage`, `channels`, `rag`, `sales_director` | `zalo-webhook`, `messenger-webhook`, `channels`, `sales-director`, `webhook-probe` | nối kênh/RAG ở `wiring.ts` + tab Chat web; chưa chạy Ollama/BGE-M3 thật, phải `embed-store --cutover` |
| sales-09 | Chatbot trên website | P1 | lam_rieng | — | — | — | làm riêng (repo website) |
| sales-02 | Gợi ý trả lời chat sàn | P1 | co_code | Đủ | `channels` | `channels` |  |
| sales-03 | Listing đa sàn | P1 | co_code | Đủ | `kd_listing_live`, `content` | `kd-listing`, `content`, `listing-export` | content + kd_listing_live (còn bản sao content-lite.ts) |
| sales-04.1 | Người phụ trách khách trong ngày | P1 | co_code | Đủ | `crm`, `sales_director` | `crm`, `sales-director`, `lead-store` |  |
| sales-04.2 | Chuyển khách về đại lý gần nhất | P1 | co_code | Đủ | `crm` | `crm` |  |
| sales-05 | Báo giá B2B quà Tết | P1 | co_code | Đủ | `kd_quote`, `channels`, `sales_director` | `kd-quote`, `kd-catalog`, `da-b2b`, `b2b-form` |  |
| sales-06.1 | Giám sát giá và phá giá | P1 | co_code | Đủ | `kd_price`, `sales_director` | `kd-price`, `sales-director`, `dealer-price` |  |
| sales-06.2 | Cảnh báo đơn trễ, hủy, hoàn bất thường | P1 | co_code | Đủ | `market`, `kd_orders_care`, `sales_director` | `market-csv`, `kd-orders` |  |
| sales-07.1 | Kịch bản và giỏ hàng livestream | P1 | co_code | Đủ | `kd_listing_live` | `kd-live` |  |
| sales-07.2 | Sau bán: xin đánh giá | P1 | co_code | Đủ | `kd_orders_care` | `kd-care` |  |
| sales-07.3 | Kịch bản bán mùa 11.11, 12.12, Tết | P1 | co_code | Đủ | `sales_director`, `fin_cash` | `kd-forecast`, `scenario` | kd-forecast còn bản sao engine scenario |
| sales-08 | Website bán hàng | P1 | lam_rieng | — | — | — | làm riêng (repo website) |

### marketing (14 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| marketing-01.1 | Soạn 3 bài mỗi ngày | P1 | co_code | Đủ | `content` | `content`, `mkt-calendar` |  |
| marketing-01.2 | Lịch mùa vụ (brief chiến dịch) | P1 | co_code | Đủ | `mkt_ads`, `content` | `mkt-director`, `mkt-calendar` |  |
| marketing-02.1 | Ảnh bối cảnh AI quanh ảnh sản phẩm thật | P1 | mot_phan | Một phần | `image_video` | `image-studio` | provider ảnh cloud bị chặn: AI Gateway TS chưa có `imageGate` |
| marketing-02.2 | Video 15–45 giây từ tư liệu thật | P1 | co_code | Đủ | `image_video` | `video-studio` | test dựng mp4 thật skip khi máy không có ffmpeg |
| marketing-03.1 | Đề xuất quảng cáo thử nghiệm | P1 | co_code | Đủ | `mkt_ads` | `mkt-ads` |  |
| marketing-03.2 | Theo dõi chi phí mỗi đơn, đề xuất giữ hay tắt | P1 | co_code | Đủ | `mkt_ads` | `mkt-ads` |  |
| marketing-04.1 | Bộ tài liệu chuẩn cho KOC/đại lý affiliate | P1 | co_code | Đủ | `mkt_koc_ugc_seo`, `kd_orders_care` | `mkt-koc`, `kd-affiliate` |  |
| marketing-04.2 | Kiểm tra bài đăng của đối tác | P1 | co_code | Đủ | `ra_kenh` | `ra-kenh` |  |
| marketing-05.1 | Phân loại bình luận | P1 | co_code | Đủ | `intel_import` | `intel-import` |  |
| marketing-05.2 | Soạn nháp trả lời bình luận, đánh giá | P1 | co_code | Đủ | `mkt_koc_ugc_seo` | `mkt-ugc` |  |
| marketing-06.1 | Chuẩn hóa trang sản phẩm trên web | P1 | co_code | Đủ | `mkt_koc_ugc_seo` | `seo-web` | `--fetch` port xong ở lượt sửa r3 |
| marketing-06.2 | Báo cáo kênh | P1 | co_code | Đủ | `ceo_report` | `cockpit` |  |
| marketing-07.1 | SEO sàn | P2 | co_code | Đủ | `mkt_koc_ugc_seo` | `seo-san` |  |
| marketing-07.2 | YouTube dài | P2 | co_code | Đủ | `mkt_koc_ugc_seo` | `mkt-youtube` | dựng Short xong ở lượt sửa r3; test mp4 cần ffmpeg |

### intel (11 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| intel-01.1 | Bản tin thị trường 7h | P1 | co_code | Đủ | `intel_crawl`, `intel_alert` | `crawler-intel`, `intel-bulletin` |  |
| intel-01.2 | Gợi ý chủ đề cho Marketing | P1 | co_code | Đủ | `intel_alert` | `intel-bulletin` |  |
| intel-02.1 | Báo động sâm giả, mạo danh Ngọc Linh | P1 | co_code | Đủ | `intel_alert`, core, `intel_crawl` | `intel-alert`, `red-alert`, `crawler-intel` | người nhận cảnh báo đỏ rỗng = chặn như Python |
| intel-02.2 | Báo động quy định mới | P1 | co_code | Đủ | `intel_alert`, core, `intel_crawl` | `intel-alert`, `red-alert`, `crawler-intel` |  |
| intel-02.3 | Báo động tin xấu về Sâm Sâm | P1 | co_code | Đủ | `intel_alert`, core, `intel_crawl` | `intel-alert`, `red-alert`, `crawler-intel` |  |
| intel-03 | Theo dõi đối thủ | P1 | co_code | Đủ | `intel_import` | `intel-import`, `intel-weekly` |  |
| intel-04.1 | Xu hướng Google Trends theo tuần | P1 | co_code | Đủ | `intel_import` | `intel-import`, `intel-weekly` |  |
| intel-04.2 | Gợi ý từ khóa an toàn pháp lý | P1 | co_code | Đủ | `intel_import` | `intel-weekly`, `intel-import` |  |
| intel-05.1 | Thử thông điệp trên khách hàng giả lập | P1 | co_code | Một phần | `intel_alert` | `persona-sim` | chỉ `--dry-run`; lượt thật cần ≥3 nhà cung cấp, gateway chỉ local/Claude |
| intel-05.2 | Thử giá combo | P1 | co_code | Đủ | `kd_price` | `combo-price` |  |
| intel-06 | Kịch bản mùa | P1 | co_code | Đủ | `fin_cash` | `scenario` | engine `scenario` dùng chung (còn 2 bản sao ở nhóm khác) |

### finance (10 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| finance-01 | Đối soát tiền sàn | P1 | co_code | Đủ | `settlement`, `kd_orders_care` | `settlement-csv`, `kd-orders` |  |
| finance-02 | Hóa đơn điện tử | P1 | co_code | Đủ | `fin_ar_pnl` | `acc-invoice` |  |
| finance-03.1 | Bảng tuổi nợ đại lý | P1 | co_code | Đủ | `fin_ar_pnl` | `acc-ar` |  |
| finance-03.2 | Hoa hồng affiliate | P1 | co_code | Đủ | `kd_orders_care` | `kd-affiliate` |  |
| finance-03.3 | Nháp thư nhắc nợ | P1 | co_code | Đủ | `fin_ar_pnl` | `acc-ar` |  |
| finance-04.1 | Biên lợi nhuận từng sản phẩm, từng kênh | P1 | co_code | Đủ | `fin_ar_pnl` | `fp-pnl` |  |
| finance-04.2 | Chặn khuyến mãi bị lỗ | P1 | co_code | Đủ | `kd_price`, `mkt_ads` | `kd-price`, `fp-ads` |  |
| finance-05.1 | So chi phí AI, quảng cáo với ngân sách | P1 | co_code | Đủ | `fin_cash`, `fin_ar_pnl` | `fp-opscost`, `fin-director` | nguồn fp-opscost/fp-cash nối qua FinCashModule ở CLI |
| finance-05.2 | Dự báo dòng tiền 13 tuần | P1 | co_code | Đủ | `fin_cash` | `fp-cash` |  |
| finance-06 | Doanh thu thuần trực tuyến + biên bản đối soát quý | P1 | co_code | Đủ | `settlement` | `rev-share` |  |

### production (6 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| production-01 | Báo cáo sản xuất | P1 | co_code | Đủ | `production` | `production`, `inventory-csv` |  |
| production-02 | Hồ sơ sản phẩm | P1 | mot_phan | Đủ | `loaders`, `sx_docs` | `golden-store`, `core-store`, `product-dossiers` | Python cũng `mot_phan`: chờ 14 hồ sơ gốc Bên B |
| production-03 | Đối soát nhãn | P1 | mot_phan | Đủ | `sx_docs` | `sx-label` | `--image` đi qua ai_worker (OCR) — chưa chạy worker thật |
| production-04.3 | Hồ sơ lô, cảnh báo cận hạn | P1 | co_code | Đủ | `production` | `production`, `production cert` |  |
| production-05.1 | Tra cứu tài liệu R&D | P2 | co_code | Đủ | `sx_docs` | `sx-tracuu` |  |
| production-05.2 | Tóm tắt tài liệu R&D | P2 | co_code | Đủ | `sx_docs` | `sx-tracuu` |  |

### farming (10 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| farming-01 | Nhật ký vườn qua Zalo | P1 | mot_phan | Một phần | `garden_zalo` | `garden`, `zalo-garden` | grant `svc_webhook` + trigger nay ở `roles.sql`/`schema.sql` (r22 A2), chưa áp DB thật; STT thật chưa kiểm |
| farming-02.1 | Nhắc người phụ trách khoảnh | P1 | co_code | Đủ | `garden_director`, `garden_zalo` | `garden-director`, `zalo-garden` |  |
| farming-02.2 | Báo giám đốc khi vẫn bỏ trống | P1 | co_code | Đủ | `garden_director`, `garden_zalo` | `garden-director`, `zalo-garden` |  |
| farming-03.1 | Nối lô thu hoạch với lô sản xuất | P1 | co_code | Đủ | `qr_anchor` | `qr-trace` |  |
| farming-03.2 | Trang và tem QR cho khách quét | P1 | co_code | Đủ | `qr_anchor` | `qr-trace` |  |
| farming-04 | Kho tư liệu vườn | P1 | co_code | Đủ | `garden_zalo` | `garden-media`, `garden-media-mkt` |  |
| farming-05.3 | Cảnh báo thời tiết | P2 | co_code | Đủ | `garden_director` | `vt-thoitiet` | collector thật nối ở lượt sửa r3; `fetch.enabled=false` → BLOCKED như Python |
| farming-05.4 | Cảnh báo sâu bệnh | P2 | co_code | Đủ | `garden_director` | `vt-thoitiet` |  |
| farming-05.2 | Dự báo sản lượng thu hoạch | P2 | co_code | Đủ | `garden_director` | `vt-thuhoach` |  |
| farming-06 | Neo mã xác thực lên blockchain | P2 | mot_phan | Đủ | `qr_anchor` | `anchor` | chưa neo thật (provider chờ hai bên) như Python |

### legal_hr (10 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| legal_hr-01 | Kiểm duyệt nội dung tự động | P1 | co_code | Đủ | core | — | core security (guardrail, guardrail-llm, kb-filter) |
| legal_hr-02 | Hồ sơ xác nhận quảng cáo | P1 | co_code | Đủ | `legal_hr` | `xnqc` |  |
| legal_hr-03.2 | Xếp mức được phép quảng bá | P1 | co_code | Đủ | `legal_hr`, `loaders` | `xnqc`, `golden-store` |  |
| legal_hr-04 | Quét kênh, gỡ bài | P1 | co_code | Đủ | `ra_kenh`, `messenger_fanpage` | `ra-kenh` |  |
| legal_hr-05.1 | Hợp đồng mẫu KOC, đại lý | P1 | co_code | Đủ | `legal_hr` | `contract-check` |  |
| legal_hr-05.2 | Mẫu xin đồng ý của khách | P1 | co_code | Một phần | `crm`, giữ Python | `crm` | đồng ý khách ở `crm` đủ; `dpia_draft.py` giữ Python |
| legal_hr-06.1 | Mô tả công việc | P1 | co_code | Đủ | `legal_hr` | `pc-hr` |  |
| legal_hr-06.2 | Sàng lọc hồ sơ | P1 | co_code | Đủ | `legal_hr` | `pc-hr` |  |
| legal_hr-06.3 | Chấm công | P1 | co_code | Đủ | `legal_hr` | `pc-hr` |  |
| legal_hr-07 | Cập nhật văn bản pháp luật mới | P2 | co_code | Đủ | `intel_crawl`, `intel_alert` | `crawler-intel`, `intel-alert`, `legal-updates` |  |

### data_platform (12 mục)

| Mã | Tính năng | GĐ | Python | TS | Module TS | Lệnh TS | Ghi chú |
|---|---|---|---|---|---|---|---|
| data_platform-01 | Kho dữ liệu chung | P1 | co_code | Một phần | schema dùng lại, giữ Python, `loaders`, core | `core-store`, `golden-store` | loader đủ; schema/roles dùng lại; `apply_schema.py` giữ Python; `schema_ts.sql` chưa áp DB thật |
| data_platform-02.1 | Đọc chữ tự động từ giấy tờ | P1 | mot_phan | Một phần | `sx_docs` | `doc-intake` | bộ đọc chữ PDF tối thiểu (khớp pypdf 44/45 golden); OCR qua ai_worker chưa chạy thật |
| data_platform-02.2 | Lưu bản gốc kèm mã kiểm tra | P1 | co_code | Đủ | `sx_docs` | `doc-intake` |  |
| data_platform-03 | Kho tri thức cho chatbot | P1 | co_code | Đủ | `rag` | `embed-store`, `kb-internal`, `kb-gaps` | mặc định ghi `embedding_v2` song song Python; `--cutover` khi chuyển |
| data_platform-04 | Cổng AI an toàn | P1 | co_code | Đủ | core | — | core ai/gateway + security/pii (MINOR: lớp dữ liệu 'do') |
| data_platform-05 | Kết nối dữ liệu sàn (nhập file) | P1 | co_code | Đủ | `market` | `market-csv` |  |
| data_platform-07.1 | Giám sát lỗi | P1 | mot_phan | Đủ | `pmo_ops`, core | `health-bulletin`, `job-runs` | Python `mot_phan`: máy giám sát ngoài chưa có |
| data_platform-07.2 | Backup hằng ngày | P1 | co_code | Một phần | `ops_scripts`, giữ Python | `db-backup`, `dr-drill` | `db_restore_drill.py` giữ Python; image pg_dump 17/openssl chưa build |
| data_platform-07.3 | Kiểm thử trước khi đưa thay đổi lên | P1 | co_code | Giữ Python | giữ Python | — | `deploy_gate.py`/`agent_eval.py` giữ Python theo KE_HOACH |
| data_platform-06 | Kết nối API sàn chỉ đọc | P2 | mot_phan | Đủ | `market`, `settlement` | `market-api`, `market-api --kind settlement` | BLOCKED ngoài như Python (chưa có app/key sàn) |
| data_platform-08 | Sổ triển khai 3 bước + hồ sơ nghiệm thu + báo cáo vận hành tháng | P1 | co_code | Đủ | core, `pmo_ops` | `rollout`, `ops-monthly` | `rollout` CLI ở core.commands; `ops-incidents` |
| data_platform-90 | Hạ tầng độc lập trên server Bên B | P1 | ngoai_code | — | `ops_scripts` | `onprem-preflight` | ngoài code; `onprem-preflight` đã port |

## Việc còn lại (xếp theo mức độ)

### A. Chặn việc chuyển sang TS — cần quyết định của user/Bên B

1. **RAG chưa dùng được cho khách:** phải embed lại toàn bộ `chunks`/`chunks_internal` bằng BGE-M3
   (`embed-store --cutover`, `kb-internal --cutover`) trên server đích; mặc định TS chỉ ghi `embedding_v2`
   song song Python. Chưa chạy với Ollama/BGE-M3 thật.
2. **Quyền webhook ghi vườn chưa áp lên DB thật:** r22 A2 (31/10/2026) đưa grant `svc_webhook` cho nhật ký
   vườn qua Zalo vào `docs/roles.sql` + trigger `webhook_garden_guard` vào `docs/schema.sql` (dùng chung
   Python/TS, áp bằng `apply_schema.py --roles`; `schema_ts.sql` chỉ còn `embedding_v2`). Lúc áp lên DB
   thật = quyết của user/Bên B. Ảnh hưởng: farming-01.
3. **Cổng ảnh cloud (`imageGate`) chưa làm:** cần chốt schema `ai_policy.json` cho ảnh (người duyệt, hạn,
   lớp dữ liệu, giá). Tới lúc đó marketing-02.1 chặn (fail-closed).
4. **intel-05.1 lượt thật:** luật ≥3 nhà cung cấp không đạt với gateway chỉ Ollama/Claude → hoặc
   `ai_policy` cho cloud đa nhà cung cấp, hoặc ghi BLOCKED theo kiến trúc "không cloud".
5. **Quyết định cutover:** không chạy webhook Zalo/Messenger TS song song bản Python trên cùng `data/`
   (mất dòng convlog); job nào chuyển BullMQ thì tắt timer systemd trước (khóa TS không loại trừ khóa
   Python); `WORKER_JOBS` liệt kê tường minh (`all` = 32/34 job — `restore_drill`, `dr_drill` giữ systemd).
6. **Gói npm chưa có quyết định** trong `npm_decisions.json`: `exceljs` (apps/api) và `jose` (devDependency
   apps/api) — hiện chỉ resolve nhờ hoisting workspace.

### B. Nên làm trước khi chạy thật

1. ceo-01: nối 3 section (CeoMiscModule / `wireCeoSections()`) vào API khi có trang TGĐ trên web.
2. Gom bản sao logic nghiệp vụ, có so golden: engine scenario ×3 (`fin_cash/scenario.ts`,
   `garden_director/scenario.ts`, `sales_director/kd-forecast.deps.ts`), `golden_store.read_golden` ×4+,
   bảng `market_csv` ×3, `content.py` (content-lite, seo-san), `pyDumps`/`pyJson`, `cmpCp`,
   `pyRound1/pyFixed1/pyPct0`, `isoDay`, retention (pmo_ops ↔ ops_scripts).
3. Quyền DB thật: `svc_ui` thiếu SELECT `orders` → tab Báo cáo ra DEGRADED (Python cùng hành vi, cần
   quyết ở `roles.sql`); grant `svc_job` cho health_bulletin/ops_monthly/kpi_snapshot chưa kiểm trên DB thật.
4. Đề nghị sửa ĐỒNG THỜI Python + TS: `fp` của `bks_audit --chain-alert` bị `maskPii` che ~2% hash →
   dedup theo ngày trượt, sinh cảnh báo mới.
5. Compose: `webhook-probe` (job `webhook_health`) dò `127.0.0.1:<cổng>` nhưng API ở container khác → có
   thể luôn "không sẵn sàng"; người nhận `email:$BIEN` phải thêm biến vào env worker.
6. Content Studio: khóa ký nháp sinh ngẫu nhiên mỗi lần khởi động API (restart → nháp chưa lưu mất hiệu
   lực; nhiều instance cần khóa chung), chưa chống gửi lại token → có thể nhân đôi nháp bài.
7. `next build` ghi lại `apps/web/next-env.d.ts` → `tsc -p apps/web` lỗi TS2882 khi thiếu `.next/`
   (CI: typecheck trước build hoặc khôi phục tệp).

### C. MINOR từ review cuối + review loaders/ops_scripts chưa sửa

Đối chiếu mã ngày 30/10 bằng grep: các mục kiểm được bằng grep đều còn (`'do'` trong gateway, telemetry,
`.dockerignore`, logout, Keycloak `8080`, `callHuman` export, webhook trong `AppModule`, ép số nguyên ở
`core-store`, `normalize`, ts không múi giờ ở preflight); số còn lại lấy nguyên từ review.

MINOR của review port từng nhóm: xem [Phụ lục](#phụ-lục-minor-của-review-port-theo-nhóm-chưa-sửa).
Đã sửa ở lượt 3 (không còn trong danh sách): `WORKER_JOBS` trống → exit 78, `all` bỏ
`restore_drill`/`dr_drill`; lệnh CLI core (`rollout`, `approval-queue`, `director`, `store`,
`acceptance`, `loader-gate`, `job-runs`, `report`) đã đăng ký.

Bảo mật / hạ tầng:
- Webhook Zalo/Messenger (công khai) chạy chung tiến trình API với pool `svc_ui` + phiên quyết định của
  người (`app.module.ts`, compose) — tách service `webhook` chỉ có `WEBHOOK_DATABASE_URL`.
- Đăng xuất web không đóng phiên quyết định (`logout/route.ts` không gọi `/approval/person/close`, cookie
  `samsam_pc` còn); phiên chỉ hết sau 30 phút rảnh, không có hạn tuyệt đối.
- `PersonSessions`: một `pg.Client` dùng chung, không tuần tự hóa → quyết định gửi cùng lúc có thể bị
  rollback theo `saveDraft` (xác suất thấp).
- Keycloak publish `8080` trên `WG_BIND_IP` + tin `X-Forwarded-*`; chung mạng `backend` với Postgres.
- Thiếu `NODE_EXTRA_CA_CERTS`/`extra_hosts` cho `sso.samsam.internal` (fail-closed nhưng chặn triển khai).
- AI Gateway nhận lớp dữ liệu `'do'` cho cloud (`gateway.ts`) — trái định nghĩa lớp Đỏ trong data_flow_map.
- Chưa đặt `NEXT_TELEMETRY_DISABLED=1` (web.Dockerfile, CI) → egress không khai.
- `.dockerignore` thiếu `data/co_khi_mat/`, `.streamlit/`.
- `rollout.callHuman` bản riêng vẫn export (nguy cơ lệch ánh xạ 42501/P0001 với `security/auth.callHuman`).

Đúng nghĩa Python:
- loaders `core-store`: số thực ở cột nguyên — Python làm tròn và nạp, TS từ chối (exit 1, chưa ghi
  vào `TS_STRICTER`).
- loaders `golden-store`: `repr` PyFloat lồng trong list/dict khác Python (chỉ thông điệp).
- loaders: thông điệp JSON hỏng / thứ tự lỗi / kiểu `id` khác Python (exit code giống).
- loaders: thiếu test chế độ thực `--approve-price` (sai khối, `--by` lệch login, đúng người); comment
  `loaders.module.ts` gợi ý web gọi `approvePrice` không qua `cliGate`.
- loaders `--file` qua `path.normalize` (Python giữ `..`).
- `onprem-preflight`: `ts` không múi giờ đọc như +07 (Python: UTC); dòng cuối có NaN bị bỏ; mục
  `lich:systemd` luôn CHUA_DAT với triển khai BullMQ — cần chốt cách đo.
- `backup.db.test.ts` `afterAll` không bảo vệ từng bước dọn → máy tải nặng có thể sót DB/role test.

Khác biệt nhỏ có chủ đích (để nguyên): cảnh báo `ExperimentalWarning` của `node:sqlite`; giới hạn JSON
100 kB của Express (Python 1 MB); `report` khi tính năng TẮT exit 2 (Python traceback exit 1);
XLSX không đọc kiểu stream; 36 cảnh báo biome.

## Chưa kiểm được trên máy này

- Ollama + Qwen3 8B, BGE-M3 (không tải model); **chất lượng tiếng Việt của Qwen3** — cần `agent_eval`,
  `eval_qa` trên server đích trước khi chuyển chatbot.
- Keycloak thật (đăng nhập/refresh/đăng xuất `end_session`), web chạy trong trình duyệt (chưa E2E/ảnh chụp).
- `docker compose up`; build image api/worker/web/ai_worker (tag `node:22-trixie-slim`,
  `postgresql-client-17`, `openssl` CHƯA kiểm — không kéo image).
- `next build`: chỉ chạy ở bước web, không chạy lại trong lượt kiểm cuối.
- Worker BullMQ với Redis thật (lập lịch, gia hạn khóa job dài).
- ai_worker OCR/STT thật (PaddleOCR, faster-whisper); Zalo/Meta/SMTP/sàn/RSS thật.
- CI job `ts` trên GitHub (`gh auth` lỗi 401, chưa push).
- 9 test skip vì thiếu môi trường: ffmpeg (6, dựng mp4) và dr-drill Docker thật (3).
- Máy RTX 5060 Ti có phải server vật lý của Sâm Sâm theo HĐ hay không.

## Phụ lục: MINOR của review port theo nhóm (chưa sửa)

Nguồn: `reviews/<nhóm>.json` ở scratchpad session `65ba0df6-…` (Temp, có thể bị dọn). Nhóm PASS không có
lượt sửa nên MINOR còn nguyên, trừ phần bước tích hợp đã làm (bảng SQLSTATE đầy đủ của `pgErrName`, cờ
CLI lạ → exit 2, đăng ký module/lệnh, nối nguồn fin-director). MINOR của 15 nhóm FIX nhiều mục đã sửa ở
lượt sửa, phần còn lại chưa đối chiếu lại từng mục. Đã kiểm bằng grep ngày 30/10: tên DB test cố định
`samsam_ts_<nhóm>` (trái CONVENTIONS `testDbName`) còn ở 13 tệp test (channels ×2, content, crm,
garden_director, image_video, kd_listing_live, kd_orders_care, kd_price, kd_quote, messenger_fanpage,
mkt_ads, sales_director); ký tự U+FEFF vô hình viết thẳng trong mã còn ở `garden_zalo/garden-zalo.service.ts`,
`kd_orders_care/kd-orders.ts`, `qr_anchor/qr-trace.ts` (và 10 tệp test).

| Nhóm | MINOR (tóm tắt) |
|---|---|
| ceo_misc | `MARKUP_RE` bỏ sót İ/ı mà Python bắt (lỏng hơn); `--now ""` khác Python; `rank` chép cả mảng mỗi lần thêm (O(n²)); `--follow` id vượt int8 đổi exit code; đường ghi thật `record`/`follow` với `pg.Pool` chưa có test |
| ceo_report | lọc markup nhận xét LLM lỏng hơn Python; thiếu vài ca test; `cockpit` `store()` trên client đang trong giao dịch có thể rollback cả giao dịch ngoài |
| channels | server form B2B dùng chung một pool của lease; `pyRegex` không dịch `.` trần; khác biệt có chủ đích của server B2B chỉ ghi ở báo cáo port, chưa có trong test |
| content | `specLike` lỏng hơn Python (bỏ sót chữ số Hán mà `str.isnumeric()` nhận — fail-open, cũng ở `kd_listing_live/content-lite.ts`); `POST /content/draft` nhận mọi `contentType` (Studio Python chỉ loại công khai trừ image/video); `contentMain` nối lại toàn cục core vào pool của lệnh rồi đóng pool; bản sao `guardrail._load_rules` |
| crm | `--handoff` (chế độ thực) vẫn ghi log `crm_handoff` pii_included=true khi giải mã lỗi (Python không ghi); JSON liên hệ có surrogate lẻ xử lý khác; bỏ qua tham số vị trí thừa; `crm.service` import `provinceOf` từ `channels/b2b-form.service` (kéo theo `node:http`) |
| fin_ar_pnl | các chỗ TS chặt hơn chưa liệt kê đủ trong `TS_STRICTER` (fp-pnl) |
| intel_alert | `persona-sim` kết nối DB trước khi xét `quickMode 'tat'`; `published_at`/`fetched_at` trong `red_alerts.detail` không khớp `isoformat()` Python |
| intel_import | XLSX không đọc kiểu stream; `cellOf` khác `_cell` ở 2 kiểu ô XLSX; `--out-dir` rỗng khác Python; job `intel_weekly` dùng đường tương đối (phụ thuộc cwd) |
| kd_listing_live | vài lỗi thoát `*Main` không bắt → exit 0 (Python 1); `kd-listing --run` luôn mở login `job`; `kd-live` lệch nhỏ ở nhánh lỗi |
| kd_orders_care | kiểm cấu hình `--sync` fail-open ở chỗ Python dừng |
| kd_price | `kd-price --run` bị cổng chặn thì log job mất lý do; thiếu test tương đương `test_no_write_sql_no_egress`; `TS_STRICTER` chưa đủ; `combo-price --as-of` chỉ nhận YYYY-MM-DD/YYYYMMDD; thông điệp `dealer-price` còn bảo chạy `python -m agents.kd_price`; script sinh golden không được giữ |
| kd_quote | `--followups --out F` rò kết nối job; id vượt bigint đổi exit code; tên lỗi ở dòng cảnh báo `--verify-send` khác Python; dev không có DSN in thông điệp khác; test "không đường ra ngoài" chỉ quét 3 tệp |
| legal_hr | `pyDumps` (pc-hr) khác `json.dumps(sort_keys=True)` với vài số; khác biệt TS chặt hơn chỉ ghi ở comment; `insideRepo` khác Python khi thư mục CV chưa có mà thư mục cha là symlink |
| messenger_fanpage | chế độ chạy trong API cần `rawBody: true` (bật parser JSON toàn cục); `fanpage.readUpTo` nuốt lỗi giữa thân 2xx → báo "JSON hỏng"; chưa dịch test `--help` exit 0 |
| mkt_ads | `num()` với số > 2^53 / ≥ 1e16 không ra cùng chuỗi `Decimal` Python; vài lệch nhỏ ở lớp CLI; dựa vào bản tạm/import chéo (`fp-pnl.ts`) |
| pmo_ops | thiếu vài ca test Python (`--board` khi mốc chưa có ngày hỏng → exit 1…); `da-pmo` gọi `wireCore` trên pool riêng rồi đóng pool (cùng lớp lỗi đã sửa ở fin_cash); `health-bulletin` gửi Telegram bằng `fetch` trực tiếp; `ops-monthly` nhận `reply_ms` số thực như số nguyên |
| qr_anchor | bỏ qua tham số vị trí thừa; `--media` lặp thì cộng dồn; ngày chỉ nhận `YYYY-MM-DD`; `humanCall` không truyền `env` cho `callHuman` (log từ chối dùng `process.env`); chưa dịch test `test_upgrade_human_function_rejects`; `lotLines`/plan B đọc `product.name` không kiểm |
| sales_director | lỗi ghi tệp bản tin bị báo là lỗi DB, exit 2; payload `lead_followup` tra nhãn qua cả `Object.prototype`; `kd-forecast` (CLI người) mở `servicePool('job')`; dòng chẩn đoán mất tên lỗi |
