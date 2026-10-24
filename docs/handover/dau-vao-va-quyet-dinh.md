# Gói đầu vào và quyết định (đợt hợp đồng 20/10/2026; cập nhật đợt hoàn thiện 22/10/2026)

Một bảng tập trung cho mọi việc cần NGƯỜI có thẩm quyền hoặc nhà cung cấp.
Mỗi dòng: ai quyết/cấp → cần chính xác gì → phương án → khuyến nghị (lý do)
→ ảnh hưởng nếu chưa có → nơi cấu hình → bằng chứng quyết định → cách kiểm
sau khi áp dụng. **Chưa trả lời ≠ đồng ý**: thiếu quyết định thì hệ thống giữ
mặc định an toàn (đã có trong code) và báo rõ. Agent/dev không điền tên người
duyệt, số tiền, tỷ lệ, ngày ký hay chữ ký.

Trạng thái chi tiết từng tính năng: `docs/handover/doi-chieu-docx.md` mục A (đợt hoàn thiện) + mục 4.
Nghĩa vụ ngoài code: `docs/handover/so-nghia-vu-hop-dong.md`.

## A. Hai bên (đại diện hợp pháp TEDO + Sâm Sâm)

| Mã | Cần chính xác gì | Phương án | Khuyến nghị | Ảnh hưởng nếu chưa có | Nơi cấu hình | Bằng chứng | Kiểm sau áp dụng |
|---|---|---|---|---|---|---|---|
| D-HB-01 | Danh mục 89 mục (mỗi khối đủ số HĐ) | (1) chấp nhận ứng viên tách ở doi-chieu mục 1.2; (2) phân rã khác; (3) phụ lục điều chỉnh số | (1) — mỗi ứng viên có căn cứ chữ PL01, không thêm chức năng mới | Hồ sơ nghiệm thu không khớp số HĐ; không thể đề nghị nghiệm thu P1 "80 tính năng" | `data/contract_features.json` (thêm mục `<nhóm>.<n>`, giữ id cũ) → owner `rollout --seed` | Biên bản/phụ lục (PL01 mục 9) | `python -m pipelines.rollout --catalog` = 89 AI; `tong_hop` khớp từng khối |
| D-HB-01 (cập nhật 22/10/2026) | **ĐÃ QUYẾT phạm vi: THEO DOCX** (user chốt) — danh mục chuẩn hóa 89 AI, đúng số từng khối | — | — | Không còn là blocker tổng phạm vi; ranh giới NỘI DUNG từng mục (cách tách dòng PL01) vẫn là đề xuất Bên A | `data/contract_features.json` (`da_thay_the` giữ truy vết id cũ) | Biên bản PL01 mục 9 cho nội dung từng mục | `rollout --catalog`: 89 AI, 9 khối khớp |
| D-HB-02 (cập nhật 22/10/2026) | **ĐÃ QUYẾT: P1 80 / P2 9 theo chữ PL01** — 9 mục P2 = HĐTV, SEO sàn, YouTube dài, tra cứu R&D, tóm tắt R&D, cảnh báo thời tiết, cảnh báo sâu bệnh, dự báo sản lượng, cập nhật VBPL (không chuyển việc P1 sang P2) | — | — | — | như trên | như trên | `--catalog`: P1 80 / P2 9 |
| D-HB-02 | Phân P1 80 / P2 9 (2 mục P2 chưa xác định) | tách dòng P2 sẵn có (farming-05 → 3; marketing-07 theo sàn) hoặc chuyển 2 mục khác sang P2 | tách dòng đã ghi "(P2)" — không chuyển việc P1 sang P2 để đóng đợt | Không chốt được phạm vi P1 | như D-HB-01 (`giai_doan`) | như D-HB-01 | `--catalog`: P1 80 / P2 9 |
| D-HB-03 | Ngày ký HĐ, ngày bắt đầu vận hành thương mại (biên bản P1) | — | điền đúng văn bản | `rev_share` không tính năm hợp tác/phí; mốc PL01 mục 7 "chưa có ngày" | `data/rev_share.json` `ngay_ky_hop_dong`, `ngay_bat_dau_van_hanh` | HĐ đã ký; biên bản P1 | `python -m agents.rev_share --quarter <kỳ> --dry-run` có năm hợp tác |
| D-HB-04 | Tỷ lệ phí vận hành, mức thưởng 3 bậc + cách cộng bậc, thời hạn xác định thưởng/quyết toán (PL02 mục 4–5) | — | điền đúng văn bản; ghi rõ "% phần vượt" từng bậc | Đối soát quý chỉ ra số đề xuất, không tính phí/thưởng | `data/rev_share.json` | PL02 đã ký | `rev_share --quarter … --dry-run` |
| D-HB-05 | PL05: mẫu biên bản nghiệm thu, giao nhận, đối soát | dùng dự thảo của dev làm nền / mẫu luật sư | luật sư soạn trên nền dự thảo | Mọi biên bản chỉ là dự thảo | `--dossier`, `rev_share`, `ops_monthly` đọc mẫu | PL05 đã ký | đối chiếu cột mẫu ↔ output |
| D-HB-06 | Neo blockchain: chuỗi/provider/phí/tài khoản (PL01 mục 4b) | OpenTimestamps (miễn phí, chỉ gửi digest 32 byte, xác nhận qua Bitcoin, cần `ots upgrade` sau vài giờ) / chuỗi khác có phí | OTS cho thí điểm mật ong sâm — dữ liệu tối thiểu, không phí giao dịch; quyết định cuối thuộc hai bên | "CHƯA NEO"; truy xuất chỉ là chuỗi nội bộ | `data/anchor_config.json` | Biên bản chọn | `anchor --build` → `--submit` → `--export` → bên thứ ba `ots verify` |
| D-HB-07 | PL03/PL04: lịch giao sản phẩm, quy cách, đơn giá quy đổi, tài sản/quyền truy cập/bàn giao | — | ngoài phần mềm — theo dõi ở sổ nghĩa vụ | Không ảnh hưởng code; ảnh hưởng HĐ Điều 7.7 | `docs/handover/so-nghia-vu-hop-dong.md`, `data/tai_san_hop_tac.json` | Phụ lục/biên bản giao nhận | `ops_monthly` bảng tài sản 8 cột |
| D-HB-08 | Website + chatbot website: owner, repo, tên miền, hosting | repo riêng do Bên A / do bên thứ ba | repo riêng, hai bên có quyền truy cập (PL01 mục 8c), dùng hợp đồng giao tiếp doi-chieu mục 1.5 | sales-08/09 không có tiến độ | `contract_features.json` sales-08/09 | Văn bản giao việc | demo giao tiếp giá/đơn/chatbot |

## B. Chủ khối (GĐ Marketing, GĐ bán hàng, GĐ tài chính, GĐ sản xuất, GĐ vùng trồng, TGĐ)

| Mã | Ai | Cần chính xác gì | Nơi cấu hình | Hiện trạng an toàn | Kiểm sau áp dụng |
|---|---|---|---|---|---|
| D-KH-01 | GĐ Marketing | tỷ lệ trần, số ngày chạy, thời điểm bắt đầu, `success_metric`, `stop_rules`, `chot_boi`, `can_cu` | `data/ads_proposal.json` | null → `mkt_ads --propose` exit 2 BLOCKED | `mkt_ads --propose --dry-run` |
| D-KH-02 | GĐ Marketing | lịch nội dung/trụ bài, creative | `data/marketing_calendar.json` | GIẢ ĐỊNH → nháp vẫn là nháp | `content --daily --dry-run` |
| D-KH-03 | GĐ bán hàng | ngưỡng giá/KM, ngưỡng đơn hủy/hoàn, mã nhân viên kinh doanh, giờ làm việc/ngày nghỉ khối sales | `data/price_watch.json`, `data/sales_watch.json`, `data/directors/sales.json` | GIẢ ĐỊNH; `staff_codes` rỗng → lead không gán | `kd_price --run --dry-run`, `kd_orders --watch --dry-run` |
| D-KH-04 | GĐ bán hàng + GĐ tài chính | bảng chiết khấu B2B, chi phí bao bì | `data/b2b_pricing.json` | GIẢ ĐỊNH | `kd_quote --check-matrix` |
| D-KH-05 | GĐ tài chính | số dư đầu kỳ, giả định dòng tiền, giá vốn (duyệt), trần ngân sách | `data/fpa_config.json`, `fp_pnl --cogs-approve` | null → dự báo thiếu số | `fp_cash --forecast --dry-run` |
| D-KH-06 | GĐ KD/TC | giả định mùa 11.11/12.12/Tết | `data/scenario_assumptions.json` | GIẢ ĐỊNH | `pipelines.scenario --sku … --json` |
| D-KH-07 | GĐ sản xuất | mốc sản xuất, `near_expiry_days` (FEFO), BOM thật | `data/production_config.json` | GIẢ ĐỊNH 90 ngày | `production bulletin` |
| D-KH-08 | Phụ trách nhân sự | luật ca, ngày nghỉ | `data/hr/attendance_rules.json` | GIẢ ĐỊNH | `pc_hr --attendance F --month M --dry-run` |
| D-KH-09 | GĐ vùng trồng | (vòng 2 C02) kênh nhắc nhân viên: `thu_cong` (người nhắc theo `--reminders`, đánh dấu `--mark-reminded`) hay tự động Zalo OA/ZNS (cần QUYẾT ĐỊNH lưu user_id thô — PII — + chi phí ZNS; adapter viết sau quyết định); `leo_thang_sau_ngay`; danh sách `khoanh` mỗi nhân viên | `data/garden_remind.json`, `data/garden_staff.json` (`khoanh`) | `kenh` null → không ai được nhắc, khoảnh bỏ trống báo thẳng GĐ kèm lý do | `garden_director --remind --submit` rồi `--reminders` |
| D-KH-10 | TGĐ / chủ khối | giờ chạy các job (đều GIẢ ĐỊNH) + bật timer | `deploy/onprem/jobs.json` | repo không tự cài lịch | `python -m pipelines.job_runs --list` trên server |
| D-KH-11 | GĐ bán hàng + Marketing | (C09) mức chiết khấu thử cho giá combo, kênh | `data/combo_price.json` | GIẢ ĐỊNH 5/10/15% → chỉ là nháp phương án | `python -m agents.combo_price --dry-run` |
| D-KH-12 | GĐ sản xuất | (C10) kế hoạch sản xuất (SKU, số lượng, khung ngày) + gắn lô; (C03) phiếu kiểm nghiệm từng lô + thư mục kho `LOT_CERT_DIR` NGOÀI repo | `production plan-add/plan-link/cert` (người khối production) | bản tin hiện "THIẾU DỮ LIỆU" / "THIẾU phiếu" | `production bulletin`, `production cert-verify` |
| D-KH-13 | GĐ vùng trồng | (C11) nguồn dự báo thời tiết (điều khoản nhà cung cấp) → `fetch.enabled` | cấu hình `agents/vt_thoitiet` | job `vt_weather` exit 2 BLOCKED | `python -m agents.vt_thoitiet --digest --fetch --submit` |
| D-KH-14 | Quản lý AI (Bên B) | trần chi phí AI USD/tháng TỪNG TÍNH NĂNG (PL01 Cổng AI an toàn) + danh sách tắt khẩn | `data/llm_gateway.json` `feature_caps_usd`, `kill_features` (env `LLM_KILL_FEATURES`) | GIẢ ĐỊNH = trần agent mặc định 5 USD; vượt/trần 0/không đọc được chi tiêu → chặn | `tests/test_contract_finalize.py::test_feature_cap_*` + `llm_usage.feature_id` |
| D-KH-15 | Quản lý MXH | từ khóa nhãn `nghi_hang_gia` (khách nghi hàng giả/nhái) | `data/social_rules.json` | từ khóa ĐỀ XUẤT dev soạn | nạp file comment thật → nhãn đúng |

## C. Bên B — ủy quyền và tài khoản (theo văn bản ủy quyền)

| Mã | Cần chính xác gì | Nơi cấu hình | Mặc định khi thiếu | Kiểm sau áp dụng |
|---|---|---|---|---|
| D-UQ-01 | Người duyệt + vai trò từng khối (9 khối) | `data/directors/<khối>.json` `approvers`, `approver_roles` | rỗng = chặn duyệt ở chế độ thực | đúng người duyệt được; sai khối/sai người/agent → `authz_denied` (`tests/test_v13_c04_authz.py` mẫu) |
| D-UQ-02 | Login Postgres riêng từng người + ánh xạ người↔khối | `data/users.json` (gitignored), bảng `human_logins` (owner ghi) | repo trống | probe login thật: đúng khối ghi được, khác khối 42501 |
| D-UQ-03 | Vai trò QR (GĐ SX, GĐ vùng trồng, Pháp chế QA) — 3 người khác nhau | `data/qr_signers.json` + `human_qr_roles` (phải thống nhất) | rỗng → không ký/phát hành | `qr_trace sign` đủ 3 vai, vai sai bị chặn |
| D-UQ-04 | Login dịch vụ: webhook/job/loader/backup/UI/Bên A/BKS (không owner/superuser) | `docs/roles.sql` + `*_DATABASE_URL` | chế độ thực thiếu → từ chối | `auth.bind_service`; job exit 78 khi sai |
| D-UQ-05 | Người nhận cảnh báo đỏ ĐỘC LẬP, người trực ngoài giờ, cấp 2, chính sách cảnh báo tồn | `data/red_alert_routing.json` | rỗng → cảnh báo ghi `route_error`, `--check-routing` exit 1 | `red_alert --check-routing` exit 0 |
| D-UQ-06 | Người giữ break-glass đóng băng Tết | `data/freeze_calendar.json` | rỗng → chỉ `--hotfix` | `deploy_gate.py --sha … --approved-by …` |
| D-UQ-07 | Giới hạn đã biết: `svc_ui` tin danh tính UI đã xác thực — DB KHÔNG ràng buộc mỗi người UI với 1 login; ai có DSN UI ghi được tên người tùy ý | quyết định chấp nhận rủi ro hoặc cấp login DB riêng từng người cho UI | giữ nguyên, ghi rõ | — |
| D-UQ-08 | (C01) secret Zalo OA/Meta + `WEBHOOK_DATABASE_URL` (login svc_webhook) + `CHANNEL_HASH_SALT` vào `/etc/samsam/webhook.env` (chmod 600, NGOÀI repo); bật 2 unit `samsam-webhook-*.service` + timer `webhook_health` | `deploy/onprem/webhook-env.example`, `deploy/onprem/systemd/` | chưa chạy 24/7 | `curl http://127.0.0.1:8788/readyz` → 200 `ready: true`; `systemctl status` |

## D. Pháp chế / DPO

| Mã | Cần chính xác gì | Nơi cấu hình | Mặc định | Kiểm |
|---|---|---|---|---|
| D-PC-01 | Duyệt nhãn 50 ca red-team + danh sách từ `ngam_y_suc_khoe`; "đối tượng sử dụng" trùng hồ sơ công bố có được miễn không | `data/eval/redteam.jsonl`, `pipelines/guardrail.py` `_HEALTH_W`… | chặt, không miễn | `python scripts/redteam.py`, `tests/test_guardrail_implied.py` |
| D-PC-02 | Severity/mode từng code guardrail | `data/guardrail_rules.json` | "chờ Pháp chế duyệt" | `tests/test_guardrail_v2.py` |
| D-PC-03 | (a) OpenRouter có là "dịch vụ AI ở nước ngoài" theo HĐ Điều 12.1; (b) mở rộng bộ lọc câu hỏi sức khỏe chatbot (mệt mỏi, dị ứng, tên thuốc…) | `pipelines/llm_gateway.py` `_HEALTH_VI/_HEALTH_ASCII` | danh sách hiện tại | eval `kd_a1` + câu sức khỏe mới phải chuyển người |
| D-PC-03 (cập nhật 22/10/2026) | (b) bộ lọc đã MỞ RỘNG trong code: triệu chứng/thể trạng/thuốc (mệt mỏi, dị ứng, kháng sinh, paracetamol, aspirin, metformin…) → chuyển người trước khi gọi AI; Pháp chế RÀ danh sách (thêm/bớt) — vẫn là danh sách từ, không bắt mọi diễn đạt. (a) vẫn chờ | `pipelines/llm_gateway.py` `_HEALTH_VI`/`_HEALTH_ASCII` | chặn rộng (lệch về chuyển người) | `tests/test_contract_finalize.py` (câu sức khỏe + đối chứng bán hàng) |
| D-PC-04 | DPIA/TIA/DPA ký; bật giả lập persona | `data/sim_config.json` `dpia_signed`, `scripts/dpia_draft.py` | false → dry-run | `dpia_draft.py --check` |
| D-PC-05 | Thời hạn lưu (retention) từng loại dữ liệu | `data/retention.json` | TTL null → không xóa, cảnh báo | `retention_purge.py --dry-run` |
| D-PC-06 | Chính sách loader khi tính năng tắt (8 loader) | `data/loader_gate.json` | null + tắt → loader exit 2 | `pipelines.loader_gate --status` |
| D-PC-07 | Thương hiệu/xuất xứ đối thủ trong gợi ý từ khóa | `data/keyword_competitors.json` | chưa duyệt → nhóm CHỜ QUYẾT | `intel_weekly --suggest-keywords --dry-run` |
| D-PC-08 | Mã đối tác lạ trong file bài KOC | `data/partner_policy.json` | `tu_choi_file` | `ra_kenh --partner-file --dry-run` |
| D-PC-09 | Từ khóa cảnh báo đỏ (gồm luật `counterfeit` mới) + nguồn văn bản pháp luật | `data/intel_alert_rules.json`, `data/intel_sources.json` | GIẢ ĐỊNH | `tests/test_intel_alert.py` |
| D-PC-10 | Chỉ dẫn địa lý "Ngọc Linh" (SKU được xác nhận), danh mục hồ sơ XNQC, luật nhãn | `guardrail_rules.json` `ngoc_linh`, `data/xnqc_draft.json`, `data/label_rules.json` | chặn | `sx_label`, `xnqc --draft` |
| D-PC-11 | Hợp đồng mẫu KOC/đại lý, mẫu đồng ý | `docs/legal/*-NHAP.md` | NHÁP | `scripts/contract_check.py` |

## E. Dữ liệu (Bên B cung cấp — kiểm nguồn/quyền/đủ/provenance trước khi nạp)

| Mã | Dữ liệu | Loader / nơi | Kiểm trước nạp |
|---|---|---|---|
| D-DL-01 | 14 hồ sơ sản phẩm gốc + ánh xạ 13 SKU golden (thiếu trường thành phần) | `data/product_dossiers.json`, `golden_store` | đối chiếu số công bố, không tự bịa |
| D-DL-02 | File Seller Center thật (listing/order/ads, có cột ngày đặt/hạn giao), quyết toán | `market_csv`, `settlement_csv` — mapping `data/market_csv_map.json` CHƯA xác minh | chạy `--report` trên file thật, sửa mapping, rồi mới nạp |
| D-DL-03 | Công nợ, sổ đại lý, vùng–đại lý | `acc_ar`, `crm --load-dealers`, `data/dealer_regions.json` (MẪU) | consent theo `crm.can_contact` |
| D-DL-04 | Kết quả quảng cáo, giá đại lý quan sát, dữ liệu đối thủ K5/TRIMICO/KGC | `mkt_ads`, `dealer_price`, `intel_import` | file nhập tay, idempotent sha256 |
| D-DL-05 | Nhật ký/ảnh vườn thật, danh sách nhân viên vườn | `connectors.zalo_garden`, `garden_media` | gỡ EXIF/GPS |
| D-DL-06 | (C04) mẫu tải lên hàng loạt (mass upload) THẬT của Shopee/TikTok Shop | `data/listing_export_map.json` (người sửa tiêu đề cột + `xac_minh_boi`) | so tiêu đề cột với mẫu; `listing_export --verify` |
| D-DL-07 | (C06) file xuất listing Seller Center CÓ cột mô tả | `data/market_csv_map.json` + `market_csv` | `ceo_audit` mục giá & mô tả hết "không so được" |
| D-DL-08 | Bên B (GĐ sản xuất) — danh mục 14 HỒ SƠ GỐC: mã, tên, thành phần, quy cách, số công bố, SKU golden ứng với hồ sơ, người xác nhận + căn cứ | `data/product_dossiers.json` `danh_muc_ho_so_goc`, `sku[].ho_so_goc` | `python -m ingest.product_dossiers --check` exit 2 (BLOCKED 0/14) |
| D-DL-09 | GĐ bán hàng — giá `list` kênh `web` trong `price_list` ĐÃ duyệt (`golden_store --approve-price`) còn hiệu lực + `allowed_channels` gồm web trong golden; mô tả chuẩn listing kênh web được người duyệt (vá controller 22/10 F2: giá JSON không còn được dùng) | `price_list` (nạp từ `data/golden_skus.json` rồi người duyệt), hàng duyệt nội dung | `listing_export --website-feed`: hiện 0 SKU bán được (ghi ly_do) |
| D-DL-10 | Bên B / owner website — định dạng xuất ĐƠN website (cột, trạng thái, mã đơn, không PII) để nhập về `orders`/đối soát | (chưa có adapter — không đoán) | nhập đơn web BLOCKED |
| D-DL-11 (đợt an toàn S02, 22/10/2026) | DBA/quản trị viên Bên B — bản backup/dump `samsam` CÓ TRƯỚC 20/10/2026 03:03 UTC (nếu có) + quyền đọc BẢN SAO cô lập để đối soát sự cố test | ngoài repo | không có → sự cố giữ UNVERIFIED vĩnh viễn | `docs/handover/su-co-db-samsam.md` mục 5 |
| D-DL-09 (cập nhật S03) | GĐ bán hàng — giá `list` ĐÃ duyệt còn hiệu lực cho TỪNG kênh xuất (shopee, tiktok, web) trong `price_list`; từ đợt an toàn S03 tệp xuất sàn cũng KHÔNG dùng giá JSON | `golden_store --approve-price` (NGƯỜI) | thiếu → `listing_export` từ chối, không tệp | `tests/test_contract_c04_listing_export.py` |

## F. Hạ tầng (Bên B — PL01 mục 8, PL02 mục 2)

| Mã | Cần | Bằng chứng nghiệm thu |
|---|---|---|
| D-HT-01 | Server vật lý, UPS, mạng, lưu trữ + offsite, monitor NGOÀI máy | ảnh/biên bản lắp đặt; `db_backup` 100% số ngày; offsite có bản |
| D-HT-02 | SMTP + người nhận độc lập + người trực | `red_alert --check-routing` exit 0; 1 cảnh báo thử nhận được |
| D-HT-03 | Tài khoản quản trị cao nhất do Bên B giữ | biên bản bàn giao (PL04 mục 3) |
| D-HT-04 | Lịch nghỉ/Tết, múi giờ VN | `data/rollout_config.json` `holidays`, `directors/sales.json` |
| D-HT-05 | Rotation mật khẩu DB từng lộ trong lịch sử Git — **chưa có bằng chứng rotation**. Kế hoạch: tạo mật khẩu mới → cập nhật `.env`/biến dịch vụ trên server → kiểm kết nối từng dịch vụ → thu hồi mật khẩu cũ; rollback = giữ mật khẩu cũ tới khi mọi dịch vụ xanh. Không rewrite lịch sử Git như việc tiện tay | người quản trị DB Bên B thực hiện; ghi ngày + ai làm (không ghi secret) |
| D-HT-06 | Diễn tập khôi phục 30/11/2026, 18/12/2026, sau đó mỗi quý — trên hạ tầng Bên B | `db_restore_drill.py` log trên server (Docker máy dev KHÔNG thay được) |
| D-HT-07 | Máy giám sát NGOÀI server + kênh báo của máy đó (PL01 giám sát lỗi; server sập thì cảnh báo trong server không gửi được) | máy chạy `webhook_probe.py --url … --dry-run` theo lịch (runbook 10.6); thử tắt webhook → nhận báo |
| D-HT-05 (cập nhật 22/10/2026) | Kiểm boolean: mật khẩu DB trong `.env` máy dev VẪN TRÙNG giá trị đã lộ trong lịch sử Git repo public — checklist rotation runbook 10.7 (quản trị viên làm, agent không đổi credential) | đăng nhập mật khẩu cũ bị từ chối; biên bản đổi (không ghi giá trị) |
| D-HT-05 (cập nhật đợt an toàn S01) | Quản trị viên TỪNG môi trường chạy gói `scripts/db_rotate_password.py` (runbook 10.8): check → rotate → cập nhật nơi dùng → verify-consumers → verify (mới ok, sai+cũ 28P01); ghi ngày/môi trường/role/người/exit, không giá trị | dev 22/10: CÒN trùng (exit 1); server/CI/máy khác: chưa kiểm |
| D-HT-08 (đợt an toàn S05) | Người giữ khóa mã hóa backup (passphrase/`age`) + nơi lưu bản sao ngoài hệ thống — trạng thái RIÊNG với backup chạy được | `BACKUP_PASSPHRASE_FILE`, `BACKUP_OFFSITE` trên server; `backup_runs.jsonl` ghi `encrypted` + offsite |
| D-HT-09 (đợt an toàn S04) | Login Postgres RIÊNG cho từng người duyệt (`in role app_human`) + dòng `human_logins` (owner ghi theo văn bản ủy quyền) + `db_login` trong `data/users.json`; quyết định kiến trúc nối SSO/proxy ↔ danh tính DB (chưa làm) | UI chế độ thực mở quyền bằng login người; `svc_ui` không ghi tên người (DB 42501) |

## V. Lựa chọn nhà cung cấp — tiêu chí kỹ thuật cho người có thẩm quyền

Không ký DPA, không mua dịch vụ, không gọi thật khi chưa chọn. Khi đã chọn:
dev đọc tài liệu chính thức còn hiệu lực, ghi phiên bản API + giả định vào
docstring adapter, viết contract test với transport giả (lỗi/timeout/mapping),
rồi chạy 1 lần nhỏ với dữ liệu được duyệt — evidence ghi riêng mức "sandbox".

| Tiêu chí | OCR | STT | Ảnh AI | API sàn |
|---|---|---|---|---|
| Xử lý dữ liệu | trong nước (tài liệu chưa OCR coi như có PII) | trong nước (giọng nói nhân viên) | không gửi ảnh có người/PII; chỉ packshot được phép | chỉ đọc, scope tối thiểu |
| Hợp đồng | DPA + điều khoản không huấn luyện trên dữ liệu | như OCR | điều khoản bản quyền ảnh sinh | Partner/Open Platform app do Bên B đứng tên |
| Kỹ thuật bắt buộc | PDF/JPG/PNG, timeout ≤30s, mã lỗi rõ, idempotent | m4a/aac/mp3, ≤25 MB, timeout | giữ vùng nhãn sản phẩm, metadata, nhãn AI | ký request, token refresh, phân trang, 429/backoff, dedup |
| Chi phí | theo trang | theo phút | theo ảnh — trần tháng agent `image` | miễn phí/quota |
| Ứng viên đã nhắc trong repo | FPT.AI Reader (chưa đánh giá) | — | — | Shopee Open Platform, TikTok Shop Partner |

Bổ sung vòng 2 — **Fanpage (C12):** quét bài Fanpage tự động cần Meta Graph
API (page access token do Bên B cấp, quyền đọc bài của Page, phiên bản API
còn hiệu lực). Hiện: thiếu credential + thiếu đặc tả quyền/phiên bản → KHÔNG
viết adapter (không đoán endpoint). Dự phòng: `ra_kenh --file` CSV xuất tay.
Web công khai + listing sàn đã tự thu (`ra_kenh --scan-auto`, job
`channel_scan`).
