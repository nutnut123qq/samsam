# Đối chiếu Hợp đồng TEDO–Sâm Sâm (HĐ + PL01–PL04) ↔ repo

**Checkpoint hiện tại: đợt hợp đồng 20/10/2026 — VÒNG 2 (P0 cổng DB test, P1 vá
guardrail livestream, C01–C12), nhánh `codex/contract-completion` từ `main` =
`dda0089`. CHƯA commit/merge/push/deploy.** Vòng 1 giữ dưới đây như lịch sử
(đánh dấu "vòng 1"). Bảng trạng thái
duy nhất của từng mục vẫn là `data/contract_features.json` + sổ rollout trong
DB; tài liệu này là bảng đối chiếu nguồn ↔ mục ↔ bằng chứng, gói quyết định ở
`docs/handover/dau-vao-va-quyet-dinh.md`.

Quy ước nguồn: chỉ ghi số điều/mục và tóm tắt kỹ thuật. Không chép toàn văn
HĐ/phụ lục, thông tin người ký, mã số, giá trị thương mại vào repo (repo
public). Bản trích đầy đủ nằm ngoài repo. **PL05 (mẫu biên bản nghiệm thu,
giao nhận, đối soát) CHƯA được cung cấp** — mọi mẫu do dev soạn
(`--dossier`, `rev_share`, `ops_monthly`) chỉ là dự thảo, không phải PL05 đã
được hai bên chấp nhận.

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

Bảng dưới sinh từ catalog (code_status + blocker) + rà tay; **mọi mục
`acceptance_status = chua_nghiem_thu`; không mục nào có sổ rollout trên server
Bên B** (thiếu bằng chứng: server, người duyệt được ủy quyền, dữ liệu thật, đủ
ngày làm việc).

| Mục | Phạm vi | GĐ | Tên | code_status | Trạng thái đợt này | Rà tay PL01 / đợt này | Blocker trong catalog (rút gọn) |
|---|---|---|---|---|---|---|---|
| ceo-01 | tinh nang ai | P1 | Báo cáo tuần tự động | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | vòng 1: job thứ Hai chụp số nội bộ trước báo cáo; doanh số/đơn kênh ngoài vẫn CSV tay | — |
| ceo-02.1 | tinh nang ai | P1 | Theo dõi tiến độ (sổ mốc) | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C05 xong: mục 'chờ quyết định / chờ ký' (hàng duyệt ceo, mốc sign_required, đối soát quý) | — |
| ceo-02.2 | tinh nang ai | P1 | Sổ quyết định TGĐ | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C05 xong (như ceo-02.1) | — |
| ceo-03 | tinh nang ai | P1 | Sổ rủi ro pháp lý | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| ceo-04.1 | tinh nang ai | P1 | So đầu ra đang chạy với bản đã duyệt | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C06 xong: so giá với giá list ĐÃ DUYỆT hiệu lực; mô tả so khi file có cột (hiện chưa có cột → không so được) | GĐ bán hàng cung cấp kế hoạch KM ĐÃ chốt (CSV định dạng kd_price --plan) hoặc duyệt giá KM golden (price_list kind promo); Quản lý MXH xuất … |
| ceo-04.2 | tinh nang ai | P1 | Báo khi nhật ký bị sửa | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | vòng 1: job chain_watch + cảnh báo đỏ | — |
| ceo-05 | tinh nang ai | P2 | Báo cáo HĐTV | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C11 xong: job hdtv_month (--month prev, chạy lại không nhân bản) | — |
| sales-01 | tinh nang ai | P1 | Chatbot chăm sóc khách (Zalo, Messenger) | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C01 xong (cấu hình): unit 24/7 + /readyz + job webhook_health; CHƯA vận hành 24/7 trên server | C01: có CẤU HÌNH chạy 24/7 nhưng CHƯA vận hành 24/7 — cần server Bên B bật 2 unit + secret OA/Meta + người nhận cảnh báo |
| sales-09 | tinh nang ai | P1 | Chatbot trên website | lam_rieng | BLOCKED_DECISION | — | Repo/owner website + chatbot website chưa xác định — không xây ở repo này (quyết định user 15/10/2026) |
| sales-02 | tinh nang ai | P1 | Gợi ý trả lời chat sàn | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Bên B ủy quyền người MXH được đánh dấu đã dán (`approvers` khối sales trong data/directors/sales.json + login `db_login`) — rỗng thì chế độ … |
| sales-03 | tinh nang ai | P1 | Listing đa sàn | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | C04 xong: mô tả chuẩn đã duyệt + xuất CSV/manifest theo sàn; mapping cột chưa xác minh với mẫu thật | C04: mô tả chuẩn = listing web ĐÃ duyệt; xuất CSV + manifest sha cho shopee/tiktok — tiêu đề cột data/listing_export_map.json CHƯA XÁC MINH … |
| sales-04.1 | tinh nang ai | P1 | Người phụ trách khách trong ngày | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B cấp danh sách MÃ nhân viên kinh doanh (data/sales_watch.json lead_owner.staff_codes rỗng — CLI chỉ kiểm mẫu mã); GĐ bán hàng chốt giờ … |
| sales-04.2 | tinh nang ai | P1 | Chuyển khách về đại lý gần nhất | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bảng vùng–đại lý thật (data/dealer_regions.json là MẪU) — Bên B cung cấp |
| sales-05 | tinh nang ai | P1 | Báo giá B2B quà Tết | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Form B2B mặc định TẮT (B2B_FORM_ENABLED — Bên B quyết bật khi có tên miền/hạ tầng); GĐ bán hàng chốt ngưỡng nhắc chốt đơn (sales_watch.json … |
| sales-06.1 | tinh nang ai | P1 | Giám sát giá và phá giá | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Nguồn giá đại lý TỰ ĐỘNG (API/crawl gian hàng đại lý) chưa có — Bên B cấp nguồn/quyền; hiện chỉ file quan sát tay (python -m ingest.dealer_p… |
| sales-06.2 | tinh nang ai | P1 | Cảnh báo đơn trễ, hủy, hoàn bất thường | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | BLOCKED dữ liệu: đơn TRỄ 'chưa đo' (file thiếu cột ngày đặt) | Bên B xuất file Seller Center thật có cột ngày đặt/hạn giao (đơn TRỄ hiện 'chưa đo', không suy) + tên trạng thái hoàn/trả thật (sales_watch.… |
| sales-07.1 | tinh nang ai | P1 | Kịch bản và giỏ hàng livestream | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Tài khoản live sàn = external-dep (module không lên sóng) |
| sales-07.2 | tinh nang ai | P1 | Sau bán: xin đánh giá | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | giới hạn: chỉ kênh sở hữu | Gửi Zalo OA/ZNS do người làm tay (external-dep) |
| sales-07.3 | tinh nang ai | P1 | Kịch bản bán mùa 11.11, 12.12, Tết | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Giả định số bán data/scenario_assumptions.json chờ GĐ KD/TC chốt |
| marketing-01 | tinh nang ai | P1 | Nội dung hằng ngày | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Trụ nội dung thường ngày + lịch chiến dịch GIẢ ĐỊNH (data/marketing_calendar.json — GĐ Marketing chốt); hiện 0 SKU đủ readiness bài đăng (TP… |
| marketing-02.1 | tinh nang ai | P1 | Ảnh bối cảnh AI quanh ảnh sản phẩm thật | mot_phan | MISSING_CODE, BLOCKED_VENDOR, UNVERIFIED_LIVE | — | Provider sinh nền ảnh AI chỉ có 'none' (nền gradient) — cần vendor + hợp đồng/DPA + key (C05 ghi BLOCKED) |
| marketing-02.2 | tinh nang ai | P1 | Video 15–45 giây từ tư liệu thật | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | chưa có tư liệu video thật được cấp | — |
| marketing-03 | tinh nang ai | P1 | Quảng cáo thử nghiệm | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Tham số đề xuất `data/ads_proposal.json` (tỷ lệ trần, số ngày, chỉ tiêu thành công/dừng) CHƯA CHỐT — GĐ Marketing chốt (chot_boi + can_cu); … |
| marketing-04.1 | tinh nang ai | P1 | Bộ tài liệu chuẩn cho KOC/đại lý affiliate | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | KOC thật + hợp đồng ký = external-dep (danh sách KOC đang MẪU) |
| marketing-04.2 | tinh nang ai | P1 | Kiểm tra bài đăng của đối tác | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B/GĐ marketing cung cấp file xuất bài KOC/đại lý ĐÃ đăng (chưa có nguồn tự động — API/crawl MXH của đối tác ngoài phạm vi); KOC thật + h… |
| marketing-05 | tinh nang ai | P1 | Bình luận, đánh giá | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | đầu vào CSV xuất tay; chưa lịch | — |
| marketing-06.1 | tinh nang ai | P1 | Chuẩn hóa trang sản phẩm trên web | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-06.2 | tinh nang ai | P1 | Báo cáo kênh | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Số lượt xem kênh chỉ có từ file xuất tay (manual_export) — chưa có API kênh |
| marketing-07.1 | tinh nang ai | P2 | SEO sàn | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| marketing-07.2 | tinh nang ai | P2 | YouTube dài | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| intel-01.1 | tinh nang ai | P1 | Bản tin thị trường 7h | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | bản tin chỉ ghi file, không bước giao 7h | Danh sách nguồn data/intel_sources.json chờ duyệt |
| intel-01.2 | tinh nang ai | P1 | Gợi ý chủ đề cho Marketing | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| intel-02 | tinh nang ai | P1 | Báo động đỏ | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | vòng 1: luật counterfeit + thu RSS mỗi giờ | Người nhận cảnh báo đỏ rỗng (data/red_alert_routing.json) — Pháp chế/Bên B cử người nhận độc lập + địa chỉ email + SMTP_* (v14.6 đã có leo t… |
| intel-03 | tinh nang ai | P1 | Theo dõi đối thủ | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | vòng 1: độ phủ K5/TRIMICO/KGC; dữ liệu nhập tay | Dữ liệu đối thủ nhập tay (file) — chưa có nguồn tự động hợp lệ |
| intel-04.1 | tinh nang ai | P1 | Xu hướng Google Trends theo tuần | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | File Google Trends xuất tay |
| intel-04.2 | tinh nang ai | P1 | Gợi ý từ khóa an toàn pháp lý | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | File Google Trends related xuất tay (Quản lý MXH); Pháp chế duyệt bộ luật lọc (từ cấm/claim/sức khỏe/ rượu) — chưa có lớp LLM-check cho ẩn ý… |
| intel-05 | tinh nang ai | P1 | Giả lập khách hàng | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | C09 xong: phương án nháp giá combo; thử trên khách giả lập vẫn chờ DPIA | DPIA chưa ký (data/sim_config.json dpia_signed=false) → chỉ chạy --dry-run; CHỈ người thật đổi cờ; C09: phương án nháp giá combo đã có (BOM … |
| intel-06 | tinh nang ai | P1 | Kịch bản mùa | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Giả định data/scenario_assumptions.json chờ GĐ KD/TC chốt |
| finance-01 | tinh nang ai | P1 | Đối soát tiền sàn | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| finance-02 | tinh nang ai | P1 | Hóa đơn điện tử | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Phát hành trên hệ thống HĐĐT do kế toán làm tay (external-dep) |
| finance-03.1 | tinh nang ai | P1 | Bảng tuổi nợ đại lý | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Sổ công nợ nạp tay (file) — dữ liệu thật Bên B cung cấp |
| finance-03.2 | tinh nang ai | P1 | Hoa hồng affiliate | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Tỷ lệ hoa hồng cấu hình MẪU — GĐ tài chính chốt |
| finance-03.3 | tinh nang ai | P1 | Nháp thư nhắc nợ | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Sổ công nợ thật (dealer_ar nạp tay) + sổ đại lý `dealers` do Bên B cung cấp; người duyệt GĐ tài chính (approvers rỗng — C04); kế toán gửi th… |
| finance-04.1 | tinh nang ai | P1 | Biên lợi nhuận từng sản phẩm, từng kênh | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Giá vốn cần người duyệt (cogs_versions) — GĐ tài chính |
| finance-04.2 | tinh nang ai | P1 | Chặn khuyến mãi bị lỗ | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | C08 xong: KM nội bộ đã duyệt + không tính được biên + mục finance/promo_loss | giá vốn đã duyệt (cogs_versions) + tỷ lệ thực nhận fpa_config GIẢ ĐỊNH |
| finance-05.1 | tinh nang ai | P1 | So chi phí AI, quảng cáo với ngân sách | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Trần ngân sách cấu hình GIẢ ĐỊNH — GĐ tài chính chốt |
| finance-05.2 | tinh nang ai | P1 | Dự báo dòng tiền 13 tuần | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Số dư đầu kỳ thật + giả định data/fpa_config.json chờ GĐ tài chính |
| production-01 | tinh nang ai | P1 | Báo cáo sản xuất | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, MISSING_CODE, UNVERIFIED_LIVE | C10 xong: mục Tiến độ (kế hoạch + lô gắn); chưa có kế hoạch thật → THIẾU DỮ LIỆU | Mốc data/production_config.json GIẢ ĐỊNH; tồn kho nạp tay; chưa có kế hoạch sản xuất thật được ghi → bản tin hiện THIẾU DỮ LIỆU |
| production-02 | tinh nang ai | P1 | Hồ sơ sản phẩm | mot_phan | MISSING_CODE, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | 13 SKU golden vs 14 hồ sơ gốc; chưa có trường thành phần | Golden có 13 SKU (gồm combo) — chưa đối chiếu 14 hồ sơ gốc PL01; Bên B cung cấp danh mục 14 hồ sơ gốc; chính sách cổng tắt loader nạp file C… |
| production-03 | tinh nang ai | P1 | Đối soát nhãn | mot_phan | MISSING_CODE, BLOCKED_VENDOR, UNVERIFIED_LIVE | — | Đọc ẢNH nhãn cần OCR trong nước — registry chỉ có 'none' (exit 2); cần vendor + hợp đồng/DPA + key |
| production-04.1 | tinh nang ai | P1 | Hồ sơ lô | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C03 xong: sổ phiếu kiểm nghiệm (phiên bản, hash, tệp ngoài repo) | kho LOT_CERT_DIR trên server + phiếu kiểm nghiệm thật do Bên B cung cấp |
| production-04.2 | tinh nang ai | P1 | Cảnh báo hàng cận hạn | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | near_expiry_days GIẢ ĐỊNH 90 — GĐ sản xuất chốt |
| production-05 | tinh nang ai | P2 | Kho tài liệu R&D | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Tài liệu nội bộ do GĐ SX duyệt nạp (chưa có) |
| farming-01 | tinh nang ai | P1 | Nhật ký vườn qua Zalo | mot_phan | MISSING_CODE, BLOCKED_VENDOR, UNVERIFIED_LIVE | STT chưa có vendor | Giọng nói chưa có STT (giữ nháp chờ người chép) — cần vendor STT trong nước + DPA |
| farming-02 | tinh nang ai | P1 | Nhắc ghi nhật ký | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C02 xong (cơ chế): nhắc người phụ trách trước GĐ; kênh tự động BLOCKED_DECISION | C02: cơ chế nhắc người phụ trách khoảnh đã có (sổ garden_reminders, --reminders/--mark-reminded); THIẾU QUYẾT ĐỊNH kênh nhắc tự động (data/g… |
| farming-03.1 | tinh nang ai | P1 | Nối lô thu hoạch với lô sản xuất | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| farming-03.2 | tinh nang ai | P1 | Trang và tem QR cho khách quét | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Domain công khai cho trang QR chưa có; danh sách người ký data/qr_signers.json rỗng; nhà in tạo ảnh QR |
| farming-04 | tinh nang ai | P1 | Kho tư liệu vườn | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C07 xong: cấp/thu hồi cho Marketing + view tối thiểu + lấy tệp kiểm hash/EXIF | Video đã nhận ở code (C05 v13.4: magic bytes + remux ffmpeg gỡ metadata/GPS, thiếu ffmpeg → từ chối). Còn: event video Zalo OA + host CDN GI… |
| farming-05.1 | tinh nang ai | P2 | Cảnh báo thời tiết, sâu bệnh | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C11 xong: job vt_weather (BLOCKED tới khi bật nguồn dự báo) | nguồn dự báo thời tiết fetch.enabled=false (điều khoản nhà cung cấp chưa xác minh) → job exit 2 BLOCKED |
| farming-05.2 | tinh nang ai | P2 | Dự báo sản lượng thu hoạch | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | C11 xong: job vt_harvest | — |
| legal_hr-01 | tinh nang ai | P1 | Kiểm duyệt nội dung tự động | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | vòng 1 + P1 vòng 2: bỏ ngoại lệ hình thức 'Hỏi: …?' (controller tái hiện lọt) | Pháp chế chốt bộ ca red-team (label_status 'chờ Pháp chế duyệt nhãn') + danh sách từ cấm tiếng Anh v14.1; đợt hợp đồng 20/10/2026: 3 known_g… |
| legal_hr-02 | tinh nang ai | P1 | Hồ sơ xác nhận quảng cáo | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | — |
| legal_hr-03.1 | tinh nang ai | P1 | Lưu giấy tờ sản phẩm | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | CHỒNG LẤN với data_platform-02 (ứng viên gộp) | chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json — chủ khối/hai bên chọn chan_khi_tat/nap_ca_khi_tat; hiện: tính năn… |
| legal_hr-03.2 | tinh nang ai | P1 | Xếp mức được phép quảng bá | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json — chủ khối/hai bên chọn chan_khi_tat/nap_ca_khi_tat; hiện: tính năn… |
| legal_hr-04 | tinh nang ai | P1 | Quét kênh, gỡ bài | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | C12 xong: web (crawl công khai) + listing tự thu + job channel_scan; Fanpage cần Graph API (BLOCKED) | Fanpage: cần Graph API + page token do Bên B cấp — CHƯA có adapter (không đoán endpoint), vẫn CSV --file; web/listing đã tự thu — chưa chạy … |
| legal_hr-05.1 | tinh nang ai | P1 | Hợp đồng mẫu KOC, đại lý | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Hợp đồng mẫu là NHÁP — luật sư/Pháp chế rà |
| legal_hr-05.2 | tinh nang ai | P1 | Mẫu xin đồng ý của khách | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | DPIA chưa ký; mẫu văn bản đồng ý chờ Pháp chế |
| legal_hr-06.1 | tinh nang ai | P1 | Mô tả công việc | co_code | CODE_VERIFIED, UNVERIFIED_LIVE | — | Mẫu data/hr/jd_templates.json BẢN DEV SOẠN |
| legal_hr-06.2 | tinh nang ai | P1 | Sàng lọc hồ sơ | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Thời hạn lưu CV chưa chốt (C05 retention TTL null) |
| legal_hr-06.3 | tinh nang ai | P1 | Chấm công | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Luật ca data/hr/attendance_rules.json GIẢ ĐỊNH; thời hạn lưu chưa chốt |
| legal_hr-07 | tinh nang ai | P2 | Cập nhật văn bản pháp luật mới | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | URL nguồn văn bản tầng A chưa xác minh (Pháp chế duyệt data/intel_sources.json); bộ từ khóa legal_doc GIẢ ĐỊNH (data/intel_alert_rules.json … |
| data_platform-01 | tinh nang ai | P1 | Kho dữ liệu chung | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Server nội bộ Bên B chưa có bằng chứng (data_platform-90); Hạ tầng Bên B tạo login thật `in role svc_webhook/svc_job/svc_loader/svc_backup/b… |
| data_platform-02 | tinh nang ai | P1 | Số hóa giấy tờ | mot_phan | MISSING_CODE, BLOCKED_VENDOR, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | vòng 1: --reprocess-pending; OCR chưa có vendor | OCR registry chỉ có 'none' — cần vendor OCR trong nước + hợp đồng/DPA + key; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_… |
| data_platform-03 | tinh nang ai | P1 | Kho tri thức cho chatbot | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Bên B ủy quyền người duyệt tài liệu nội bộ (approvers khối data_platform đang rỗng) + login Postgres riêng của người đó (db_login trong user… |
| data_platform-04 | tinh nang ai | P1 | Cổng AI an toàn | co_code | CODE_VERIFIED, BLOCKED_VENDOR, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | trần chi phí theo agent, chưa theo từng mục catalog | v13.1 che tên/địa chỉ theo mẫu + FinOps fail-closed; v14.1 che tên KHÔNG theo mẫu bằng từ điển công khai data/vn_names.json (họ/đệm/tên/địa … |
| data_platform-05 | tinh nang ai | P1 | Kết nối dữ liệu sàn (nhập file) | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Mapping cột data/market_csv_map.json chưa xác minh với file thật; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate.json —… |
| data_platform-07.1 | tinh nang ai | P1 | Giám sát lỗi | mot_phan | MISSING_CODE, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | THIẾU: giám sát ngoài máy chủ (hạ tầng Bên B) | C07 v13.7 đã có sổ sự cố ops_incidents + SLA 15 phút/3 giờ/3 ngày làm việc/7 ngày trong ops_monthly. Đợt docx P2: bản tin health ghi qua wri… |
| data_platform-07.2 | tinh nang ai | P1 | Backup hằng ngày | co_code | CODE_VERIFIED, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | Offsite/NAS + lịch chạy trên server Bên B chưa có bằng chứng |
| data_platform-07.3 | tinh nang ai | P1 | Kiểm thử trước khi đưa thay đổi lên | co_code | CODE_VERIFIED, BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA, UNVERIFIED_LIVE | — | approvers cổng deploy rỗng — Bên B cử người duyệt; 22 suite chưa frozen; chính sách cổng tắt loader nạp file CHƯA CẤU HÌNH (data/loader_gate… |
| sales-08 | nen tang tmdt | P1 | Website bán hàng | lam_rieng | BLOCKED_DECISION | — | Repo/owner website chưa xác định — không xây ở repo này (quyết định user 15/10/2026) |
| data_platform-06 | nen tang tmdt | P2 | Kết nối API sàn chỉ đọc | mot_phan | MISSING_CODE, BLOCKED_VENDOR, UNVERIFIED_LIVE | — | BLOCKED — chưa có app key/sandbox Shopee Open Platform/TikTok Shop (Bên B cấp): chữ ký/endpoint/field/phân trang/rate limit CHƯA VERIFIED, c… |
| farming-06 | truy xuat blockchain | P2 | Neo mã xác thực lên blockchain | mot_phan | MISSING_CODE, BLOCKED_VENDOR, UNVERIFIED_LIVE | provider none — CHƯA NEO | Hai bên chọn chuỗi/provider/phí/tài khoản neo (data/anchor_config.json provider 'none' = CHƯA NEO); chưa có biên nhận neo thật nào — adapter… |
| finance-06 | nghia vu hd | P1 | Doanh thu thuần trực tuyến + biên bản đối soát quý | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Tỷ lệ phí/mức thưởng/ngày ký/ngày vận hành null = chưa chốt (data/rev_share.json) |
| data_platform-08 | nghia vu hd | P1 | Sổ triển khai 3 bước + hồ sơ nghiệm thu + báo cáo vận hành tháng | co_code | CODE_VERIFIED, BLOCKED_DECISION, UNVERIFIED_LIVE | — | Lịch nghỉ data/rollout_config.json chưa chốt; danh mục 89 mục chưa chốt |
| ceo-90 | nghia vu hd | P1 | Nghĩa vụ hợp đồng ngoài phần mềm | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA | — | Sổ nghĩa vụ đã lập (docs/handover/so-nghia-vu-hop-dong.md, N01–N20 trạng thái de_xuat) — các nghĩa vụ chờ hai bên thực hiện/xác nhận; PL05 c… |
| data_platform-90 | nghia vu hd | P1 | Hạ tầng độc lập trên server Bên B | ngoai_code | BLOCKED_DECISION, BLOCKED_INFRA_OR_DATA | — | Chưa có bằng chứng server vật lý/UPS/NAS-offsite/monitor độc lập/người giữ tài khoản cao nhất (F08) |

Đếm nhãn (một mục có thể nhiều nhãn): BLOCKED_DECISION 42, BLOCKED_INFRA_OR_DATA 31, BLOCKED_VENDOR 7, CODE_VERIFIED 74, MISSING_CODE 9, UNVERIFIED_LIVE 82

Nhãn `MISSING_CODE` còn lại trong bảng = mục `code_status: mot_phan` (adapter OCR/STT/ảnh AI/API sàn/neo chưa viết vì CHƯA chọn nhà cung cấp — không viết adapter đoán) + giám sát ngoài máy (hạ tầng); 12 mục MISSING_CODE của vòng 1 đã có mã ở vòng 2.
