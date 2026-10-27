# Hồ sơ sẵn sàng chạy thử (PL02 mục 1a–b) — đầu vào cần Bên B / hai bên

Đợt an toàn + nghiệm thu A02/A04 (22/10/2026). Mỗi dòng: chủ trách nhiệm (vai
trò, không ghi tên người trong repo public), nơi điền, LỆNH KIỂM, hiện trạng
kiểm ngày 22/10/2026 trên máy dev (DB test `samsam_contract_r6probe`, không
phải server Bên B), điều kiện đóng. Agent KHÔNG tự điền tên, chữ ký, ngày ký,
mức phí/thưởng, cờ DPIA, người duyệt hay người nhận cảnh báo; giá trị `null`/
rỗng giữ nguyên tới khi có văn bản.

Kiểm tổng: `python -m pipelines.acceptance --summary` (READY_FOR_TRIAL hiện
**0/96**) — ma trận chi tiết `docs/handover/ma-tran-nghiem-thu.md`.

## 0. Gói đầu vào theo ưu tiên (vòng r8, 22/10/2026) — người dùng chuyển cho đúng người quyết

Gửi qua kênh an toàn của Bên B; KHÔNG gửi mật khẩu/key vào chat hay repo (secret → trình quản lý mật khẩu/biến môi trường trên server).

| Ưu tiên | Cần | Ai quyết/cung cấp | Mục bị chặn | Cách kiểm sau khi nhận |
|---|---|---|---|---|
| 1 | Server Bên B (môi trường + quyền quản trị cho Bên A, đúng phạm vi) | Bên B | MỌI chạy thử/nghiệm thu (E1), H1–H4 | `deploy/onprem/README.md` checklist; `acceptance --summary --db` trên server |
| 1 | Rotation mật khẩu DB từng lộ trên mọi môi trường dùng giá trị đó + người thực hiện/cửa sổ | Quản trị viên từng môi trường | N21, an toàn chung | `db_rotate_password.py --verify` + `--verify-consumers` exit 0 (runbook 10.8) |
| 1 | Người được ủy quyền 9 khối + login Postgres riêng + ánh xạ `human_logins` + vai QR | TGĐ Bên B | B1–B3 mọi mục, QR | Mỗi người mở phiên UI 1 lần (`human_login_checks`, đúng login + đúng người ánh xạ hiện hành; đổi ánh xạ → người mới mở lại) → ma trận B3 đạt |
| 1 | Người nhận cảnh báo độc lập, trực ngoài giờ, cấp 2, SMTP | Pháp chế + TGĐ | E3, KPI 2 giờ | `red_alert --check-routing` exit 0 + thử gửi |
| 2 | Lịch nghỉ lễ/Tết | Hành chính | đếm 5/10 ngày LV | cảnh báo `rollout --status` biến mất |
| 2 | 14 hồ sơ gốc, giá/mô tả đã duyệt, file sàn/đơn/công nợ/vườn thật | GĐ từng khối | production-02, giá, KPI | `product_dossiers --check` exit 0; loader nạp file thật |
| 3 | Chọn vendor OCR/STT/ảnh AI + đặc tả API + DPA + key; app key sàn | QL AI / Bên B | 02.1, 03, farming-01, marketing-02.1, data_platform-06 | OCR/STT/ảnh AI: adapter CHƯA viết (registry chỉ `none`) — dev viết adapter sau khi chọn vendor + contract test, rồi sandbox có trần chi phí; sàn: listing/đơn/refresh + quyết toán (r15) có code, kiểm sandbox |
| 3 | Bảng ánh xạ quyết toán API (thành phần → cột/dấu/bỏ qua; loại giao dịch TikTok → mã đơn + txn_type) + 1 file income thật + quyền app Payment/Finance | Kế toán Bên B / chủ shop | data_platform-06, finance-01, finance-06 | `market_api --kind settlement --dry-run` trên sandbox: 0 thành phần CHƯA CHỐT/LẠ; ghi sổ trên shop thật rồi đối chiếu file income |
| 3 | Trần chi phí AI từng tính năng, retention, loader, guardrail (Pháp chế rà), DPIA, tham số nghiệp vụ | Chủ khối / Pháp chế / QL AI | mục 2 dưới | lệnh kiểm từng dòng mục 2 |
| 4 | Repo + owner website/chatbot website, định dạng đơn web | Bên B / owner website | sales-08, sales-09 | kiểm xuyên repo trên staging |
| 4 | Ngày ký, ngày vận hành, phí/thưởng, PL05, chuỗi neo blockchain | Hai bên | finance-06, nghiệm thu, farming-06 | biên bản ký |

## 1. Người và quyền

| # | Đầu vào | Chủ trách nhiệm | Nơi điền | Lệnh kiểm | Hiện trạng 22/10 | Điều kiện đóng |
|---|---|---|---|---|---|---|
| P1 | Người được ủy quyền duyệt theo 9 khối (PL01 mục 2: TGĐ, GĐ bán hàng, GĐ marketing, QL Marketing, GĐ tài chính, GĐ sản xuất, GĐ vùng trồng, CV pháp chế, QL AI) | TGĐ Bên B (văn bản ủy quyền) | `data/directors/<khối>.json` `approvers` + `data/users.json` (vai trò, `db_login`) | `python -m pipelines.acceptance --summary`; `python -m pipelines.approval_queue --pending` (chế độ thực chặn khi rỗng) | 9/9 khối `approvers` RỖNG | Mỗi khối có ≥1 người theo văn bản; users.json khớp |
| P2 | Login Postgres RIÊNG cho từng người duyệt + ánh xạ `human_logins` (người ↔ khối) — bắt buộc cho quyết định ở UI chế độ thực từ đợt S04 | Quản trị hạ tầng Bên B (tạo login) + TGĐ (ánh xạ) | `create role … login … in role app_human` (runbook 9.7); `human_logins` CHỈ owner ghi | `python -m pipelines.acceptance --summary --db` (B2: MỖI người duyệt đã cấu hình phải có ánh xạ active đúng khối tới login đăng nhập được; không `--db` = CHƯA KIỂM → không READY) trên server Bên B; thử `auth.person_connect` | chưa có login thật; `human_logins` trống | Mỗi người duyệt mở được phiên quyết định; người khác/khối khác bị 42501 |
| P3 | Vai trò QR (ký: GĐ sản xuất, GĐ vùng trồng, pháp chế/QA — 3 người KHÁC nhau; phát hành/thu hồi) | TGĐ Bên B | `data/qr_signers.json` + `human_qr_roles` (owner ghi) | `python -m pipelines.qr_trace sign …` bị chặn khi thiếu vai | `qr_signers.json` external-dep; `human_qr_roles` trống | 3 vai có người khác nhau, login đúng vai |
| P4 | Người nhận cảnh báo đỏ ĐỘC LẬP (pháp chế/BKS), trực ngoài giờ, cấp leo thang 2, chính sách cảnh báo tồn | Pháp chế + TGĐ Bên B | `data/red_alert_routing.json` (`recipients`, `ngoai_gio`, `cap2`, `backlog`) + biến SMTP | `python -m pipelines.red_alert --check-routing` | exit 1 (chưa có người nhận) | exit 0 + thử gửi thật nhận được |
| P5 | Lịch làm việc + ngày nghỉ lễ/Tết (đếm 5/10 ngày làm việc) | Hành chính Bên B | `data/rollout_config.json` `holidays`; ca ở `data/directors/*.json` | `python -m pipelines.rollout --status` (cảnh báo khi rỗng) | `holidays` rỗng, ca GIẢ ĐỊNH | Lịch có văn bản; cảnh báo biến mất |

## 2. Chính sách chưa chốt (giữ null/GIẢ ĐỊNH tới khi có quyết định)

| # | Chính sách | Chủ trách nhiệm | Nơi | Lệnh kiểm | Hiện trạng |
|---|---|---|---|---|---|
| C1 | Trần chi phí AI từng tính năng + nút tắt | QL AI Bên B | `data/llm_gateway.json` `feature_caps_usd`/`kill_features` | `python -m pytest tests/test_contract_finalize.py -k feature_cap` | chỉ `default` (GIẢ ĐỊNH) |
| C2 | Thời hạn lưu dữ liệu (TTL từng loại) | Pháp chế + QL AI | `data/retention.json` | `python scripts/retention_purge.py --dry-run` | TTL null = không xóa, có cảnh báo |
| C3 | Loader khi tính năng tắt | Chủ từng khối | `data/loader_gate.json` `chinh_sach` | `python -m pipelines.loader_gate --status` | chưa cấu hình → loader của tính năng tắt exit 2 |
| C4 | Nội dung/guardrail: claim whitelist, từ cấm, câu khuyến cáo, nhãn AI, danh sách sức khỏe (D-PC-03) | Pháp chế | `data/claims_whitelist.json`, `data/banned_words.txt`, gateway `_HEALTH_*` | `python scripts/agent_eval.py --deterministic --no-record`; `python scripts/redteam.py` | dev soạn, Pháp chế chưa rà |
| C5 | Tham số nghiệp vụ (ngưỡng giá/đơn, kịch bản mùa, ads, lịch marketing, SLA) | GĐ từng khối | `data/sales_watch.json`, `price_watch.json`, `scenario_assumptions.json`, `ads_proposal.json`, `marketing_calendar.json` | đọc cờ GIẢ ĐỊNH trong `_doc` | GIẢ ĐỊNH |
| C6 | Phí vận hành, thưởng, ngày ký, ngày vận hành thương mại | Hai bên | `data/rev_share.json` | `python -m agents.rev_share --quarter …` (báo "chưa chốt") | null |
| C7 | DPIA cho giả lập khách hàng | Pháp chế/DPO Bên B | `data/sim_config.json` `dpia_signed` | `python scripts/persona_sim.py` (exit 2 khi chưa ký) | `false` |

## 3. Dữ liệu gốc và quyền sử dụng

| # | Dữ liệu | Chủ trách nhiệm | Lệnh kiểm | Hiện trạng |
|---|---|---|---|---|
| D1 | 14 hồ sơ sản phẩm gốc ↔ SKU golden | GĐ sản xuất | `python -m ingest.product_dossiers --check` | exit 2 BLOCKED (0/14) |
| D2 | Giá list/floor từng kênh ĐÃ duyệt (website + sàn — từ S03 xuất sàn cũng chỉ dùng giá DB đã duyệt) | GĐ bán hàng | `python -m ingest.golden_store --report`; `--approve-price <id> --by` (NGƯỜI) | chưa có giá duyệt thật trên server Bên B |
| D3 | File xuất đơn/listing/quảng cáo/quyết toán sàn thật (xác minh mapping cột) | GĐ bán hàng / tài chính | `python -m ingest.market_csv --file …`; `ingest.settlement_csv` | mapping CHƯA XÁC MINH với file thật |
| D4 | Công nợ đại lý, danh sách đại lý, đồng ý liên hệ | GĐ tài chính / bán hàng | `python -m agents.acc_ar --bulletin`; `ingest.crm --report` | chưa có file thật |
| D5 | Tư liệu vườn (nhật ký, ảnh/video, khoảnh), nhân viên vườn | GĐ vùng trồng | `python -m agents.garden_director --precheck`; `--verify` | dữ liệu mẫu; chưa nhận khoảnh thật |
| D6 | Quyền sử dụng dữ liệu (khách, ảnh, tài liệu) | Pháp chế | văn bản | chưa có |

## 4. Hạ tầng và nhà cung cấp

| # | Hạng mục (PL01 mục 8) | Chủ trách nhiệm | Lệnh kiểm | Hiện trạng |
|---|---|---|---|---|
| H1 | Server vật lý, UPS, lưu trữ, mạng nội bộ, quyền quản trị cao nhất do Bên B giữ | Bên B | `deploy/onprem/README.md` checklist; `data/tai_san_hop_tac.json` | chưa bàn giao (`cho_xac_nhan`) |
| H2 | Backup hằng ngày + BẢN SAO NGOÀI HỆ THỐNG + MÃ HÓA + người giữ khóa (trạng thái RIÊNG từng phần) | Bên B (khóa) / Bên A (cài) | `python scripts/db_backup.py` (`BACKUP_OFFSITE`, `BACKUP_PASSPHRASE_FILE`) → `backup_runs.jsonl` | chưa chạy trên server; mã hóa/offsite là tùy chọn chưa cấu hình; người giữ khóa chưa chỉ định |
| H3 | Diễn tập khôi phục trên server Bên B 30/11/2026, 18/12/2026, sau đó mỗi quý | Bên A thực hiện, Bên B chứng kiến | `python scripts/db_restore_drill.py`; `scripts/dr_drill.py` | CHỈ có DR Docker dev — không thay diễn tập server |
| H4 | Giám sát NGOÀI server chính (vẫn báo khi server chết) + kênh báo | Bên B (máy) | `python scripts/webhook_probe.py --url … --dry-run` từ máy ngoài (runbook 10.6) | chưa có máy giám sát |
| H5 | Credential: rotation mật khẩu DB từng lộ trên MỌI môi trường dùng giá trị đó | Quản trị viên từng môi trường | `python scripts/db_rotate_password.py --check/--rotate/--verify/--verify-consumers` (runbook 10.7) | dev: CÒN trùng giá trị lộ (kiểm 22/10); server/CI/máy khác: chưa kiểm |
| V1 | AI provider (OpenRouter, provider allowlist `azure`), key thật | QL AI Bên B | `data/llm_gateway.json` `provider_only`; gateway fail-closed | chưa có key vận hành |
| V2 | OCR/STT/ảnh AI trong nước, neo blockchain | Hai bên | `OCR_PROVIDER`, `zalo_garden --transcribe`, `IMAGE_PROVIDER`, `data/anchor_config.json` | `none` → exit 2 BLOCKED (OCR/STT/ảnh AI: adapter nhà cung cấp chưa viết — không chỉ thiếu key) |
| V3 | API sàn (P2), token Zalo OA/Meta, tên miền QR | Bên B | `connectors.*` preflight | BLOCKED (chưa cấp) |
| V4 | Website + chatbot website (repo riêng) | Bên A (repo riêng) / Bên B (tên miền, hosting) | nguồn dữ liệu `listing_export --website-feed` | repo riêng chưa có bằng chứng triển khai |

## 5. Lịch chạy thử (A04) — CHƯA bắt đầu

Không mục nào bắt đầu chạy thử thật: chưa có server Bên B, người được ủy quyền,
login, dữ liệu thật (mục 1–4). Khi đủ điều kiện cho một mục
(`acceptance --matrix --db` báo READY_FOR_TRIAL trên server Bên B):

1. Người chịu trách nhiệm của khối ghi ngày bắt đầu THẬT bằng
   `python -m pipelines.rollout --seed --by "<người>"` (mốc = thời điểm ghi, không
   lùi ngày); không bật hàng loạt — từng mục hoặc nhóm nhỏ đã thống nhất.
2. Chạy thử ≥5 ngày làm việc + ≥50 đầu ra DISTINCT từ dữ liệu thật, chỉ ghi
   nội bộ; theo dõi `python -m pipelines.rollout --status`.
3. Nâng giai đoạn chỉ bằng NGƯỜI được ủy quyền (`--promote --by`, DB tự đếm
   lại); có người duyệt ≥10 ngày làm việc, duyệt TỪNG đầu ra đúng phiên bản
   (`--outputs`, `--review-output`).
4. Lỗi nghiêm trọng (PL02 mục 2) → `--severe ID --reason <mã> --by` (tự về
   chạy thử, đếm lại từ đầu).
5. Ghi nhận ở sổ: ngày thật, người, đầu ra, lỗi, quyết định. Không tuyên bố đủ
   5/10 ngày trong một phiên làm việc; mục chưa đủ thời gian giữ "đang chạy".

Lịch theo dõi đề xuất (người chịu trách nhiệm Bên A, sau khi có server): kiểm
`rollout --status` mỗi sáng ngày làm việc; báo cáo vận hành tháng trước ngày 05
(`scripts/ops_monthly.py`). Agent không tự cài lịch/timer production.
