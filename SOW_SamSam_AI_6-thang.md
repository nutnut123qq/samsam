# PHƯƠNG ÁN TRIỂN KHAI & PHẠM VI CÔNG VIỆC (SOW — Draft để đàm phán)

**Dự án:** Chuyển đổi số & Hệ sinh thái AI — Công ty TNHH Sâm Sâm
**Thời gian:** 6 tháng · **Đội thực hiện:** 3 người (1 senior lead + 2 thành viên)
**Giá trị hợp đồng:** 1.000.000.000 VNĐ — thanh toán bằng quyền hưởng vườn sâm Ngọc Linh (xem Mục 8)
**Bản draft:** v1 — dùng làm phụ lục đàm phán, cần luật sư rà soát trước khi ký

---

## 1. Mục tiêu

1. Số hóa các nhóm dữ liệu ưu tiên của công ty thành kho dữ liệu có cấu trúc, tra cứu được.
2. Vận hành được hệ sinh thái AI hỗ trợ Marketing/Truyền thông (sản xuất nội dung có kiểm soát pháp lý, chatbot CSKH, dashboard).
3. Triển khai 2–3 AI agent phục vụ vận hành nội bộ theo use-case chốt trước.
4. Đào tạo đội ngũ công ty tự vận hành hệ thống sau khi bàn giao.

## 2. Phạm vi công việc (Scope)

### WS1 — Số hóa dữ liệu

**Trong phạm vi:**
- Rà soát & lập danh mục dữ liệu (data audit) trong 2 tuần đầu — kết quả là bảng kê số lượng thật, đính kèm làm Phụ lục A.
- Số hóa (scan/OCR/cấu trúc hóa) các domain **P0**: hồ sơ pháp lý & công bố sản phẩm từng SKU, catalog sản phẩm + bảng giá, tài sản truyền thông (ảnh/video/bài báo).
- Số hóa domain **P1**: dữ liệu vùng trồng (khoảnh/tiểu khu, số cây, giống, nhật ký), dữ liệu bán hàng/điểm phân phối.
- Dựng kho lưu trữ chuẩn (cloud drive có cây thư mục + quy ước tên) và DB lõi (products, claims_approved, plots, orders, assets).
- Dựng quy trình **nhập liệu mới** cho dữ liệu chưa tồn tại dạng số (form nhật ký vườn).
- Vector index toàn bộ dữ liệu P0/P1 phục vụ WS2/WS3.

**Ngoài phạm vi (out-of-scope):**
- Số hóa dữ liệu tài chính/kế toán đã có trong phần mềm kế toán.
- Dữ liệu lịch sử trước mốc [X năm — chốt sau data audit].
- Nhập liệu thay công ty cho dữ liệu chưa được bàn giao.

### WS2 — Hệ sinh thái AI MKT/Truyền thông

**Trong phạm vi:**
- Knowledge base thương hiệu + **guardrail công dụng đã cấp phép** theo hồ sơ công bố từng SKU (claim whitelist + danh sách từ cấm).
- Pipeline nội dung: brief → AI draft → kiểm tra compliance → duyệt người → format đa kênh (Facebook, TikTok script, blog, Zalo OA) → lịch đăng.
- Chatbot CSKH trên Fanpage (và website nếu khả thi): trả lời FAQ từ knowledge base, gom lead, chuyển người khi vượt phạm vi.
- Dashboard số liệu kênh + leads.
- Thư viện prompt/brand voice + template Canva/CapCut.

**Ngoài phạm vi:** chạy/ngân sách quảng cáo (công ty tự chi trả và vận hành sau đào tạo), quay chụp studio chuyên nghiệp, mở kênh mới ngoài danh sách chốt.

### WS3 — AI agent vận hành

**Trong phạm vi — đúng 3 agent:**
1. Trợ lý tri thức nội bộ (tra cứu hồ sơ/sản phẩm/SOP đã số hóa, trả lời kèm nguồn).
2. Agent báo cáo định kỳ (tổng hợp sales + social metrics → Zalo/email lãnh đạo).
3. Pilot agent nhật ký vùng trồng (nhập qua form/chat → chuẩn hóa → cảnh báo bất thường). Mức pilot, không cam kết adoption.

**Ngoài phạm vi:** agent tự động ghi/sửa dữ liệu tài chính, đơn hàng, hoặc hành động với khách không qua duyệt người.

### WS4 — Đào tạo & chuyển giao

**Trong phạm vi:**
- Giáo trình tiếng Việt theo vai trò (MKT / sales-admin / vườn).
- Tối thiểu 4 workshop + playbook từng vai trò.
- Đào tạo 1–2 "AI champion" nội bộ; nghiệm thu = tự vận hành pipeline 2 tuần không cần đội dự án.
- Bộ tài liệu bàn giao: SOP, tài khoản, kiến trúc hệ thống, prompt library.

## 3. Timeline 6 tháng

| Tháng | Nội dung | Cửa ngõ (gate) |
|---|---|---|
| T1 | Data audit → **Phụ lục A**; hạ tầng cloud; KB v0; chatbot FAQ v0 | Chốt scope ký lại |
| T2–T3 | Số hóa P0→P1 hàng loạt; content pipeline + guardrail | Nghiệm thu P1 |
| T3–T4 | Chatbot live; dashboard; số hóa P2 | Nghiệm thu P2 |
| T4–T5 | 3 agent vận hành; hardening, audit log | Nghiệm thu P3 |
| T5–T6 | Training, playbook, bàn giao; buffer | Nghiệm thu tổng + "2 tuần tự vận hành" |

## 4. Phân công

- **Senior lead**: kiến trúc, RAG/guardrail, tích hợp, review toàn bộ code trước khi lên prod.
- **Thành viên 1**: pipeline số hóa/OCR, data entry, content ops.
- **Thành viên 2**: chatbot/agent theo ticket, tài liệu, training support.
- Quy tắc: mọi code qua review + staging; tài khoản/hệ thống thuộc sở hữu công ty.

## 5. Nghĩa vụ của Công ty (điều kiện tiên quyết — quan trọng)

1. Chỉ định **1 người phối hợp có quyền quyết định** (PM nội bộ), họp steering 1 lần/tuần.
2. Bàn giao quyền truy cập data/tài liệu theo Phụ lục A trong 5 ngày làm việc từ yêu cầu.
3. Bố trí nhân viên cho phỏng vấn/nhập liệu/đào tạo theo lịch hẹn.
4. Chi trả **chi phí hạ tầng & SaaS** (cloud, LLM API, Canva, hosting…) — ước 3–8 triệu/tháng, tài khoản đứng tên công ty.
5. Cung cấp hồ sơ công bố sản phẩm & giấy xác nhận nội dung quảng cáo còn hiệu lực cho guardrail.
6. Chỗ làm việc có **internet ổn định** (tại Tam Kỳ/Đà Nẵng); chỗ ăn ở cho đội dự án theo thỏa thuận.
7. Duyệt nội dung/nghiệm thu trong **5 ngày làm việc**; quá hạn xem như đạt.

## 6. Nghĩa vụ của Đơn vị thực hiện

1. Giao deliverable đúng gate; báo cáo tuần.
2. Bảo mật dữ liệu công ty; không publish nội dung khi chưa duyệt.
3. Mọi tài khoản MXH/hệ thống tạo bằng danh nghĩa công ty, bàn giao khi kết thúc.
4. Tài liệu hóa toàn bộ hệ thống trước nghiệm thu.

## 7. Tiêu chí nghiệm thu (viết trước — đo được)

- **Số hóa**: 100% domain P0 + P1 theo Phụ lục A tra cứu được qua assistant; trả lời đúng ≥90% bộ câu hỏi kiểm thử.
- **AI MKT**: pipeline vận hành ≥[X] bài/tuần trong 4 tuần liên tục; guardrail chặn đúng ≥95% bộ test vi phạm claim; chatbot live trên fanpage.
- **Agents**: 3 agent chạy được trên dữ liệu thật, có audit log.
- **Training**: AI champion tự vận hành 2 tuần; ≥[X] nhân viên qua workshop có bài kiểm đầu ra.
- Nghiệm thu theo từng phase, ký biên bản từng phase.

## 8. Thanh toán — vườn sâm (phần phải thương lượng kỹ nhất)

Giá trị 1 tỷ quy đổi thành quyền hưởng vườn sâm. **Điều khoản bắt buộc đề xuất:**

1. Định danh tài sản: vị trí, khoảnh/tiểu khu, diện tích, **số cây**, tuổi cây — đính kèm bản đồ + biên bản kiểm kê có con dấu.
2. Bản chất quyền: vì đất là quyền thuê dịch vụ môi trường rừng, ghi rõ đây là **quyền hưởng thành quả** trên số cây định danh — văn bản hóa bằng phụ lục có công chứng.
3. Trách nhiệm chăm sóc 5 năm: công ty chăm sóc/bảo vệ; tỷ lệ hao hụt cho phép [__%]; cây chết vượt tỷ lệ → công ty bù cây tương đương hoặc tiền.
4. **Buyback**: công ty cam kết mua lại tối thiểu [1 tỷ / giá sàn __] vào cuối năm 5, hoặc bên thực hiện được quyền bán cho bên thứ ba.
5. Định giá: nếu bán theo thị trường, cơ chế thẩm định giá do bên thứ ba.
6. Rủi ro hủy/thay đổi: hợp đồng chấm dứt giữa chừng → thanh toán **tiền mặt** theo tỷ lệ phase đã nghiệm thu (P1=20%, P2=40%, P3=70%, tổng=100%).
7. Thuế/hóa đơn trên khoản 1 tỷ: làm rõ phương thức (HĐ dịch vụ — cần pháp nhân/GTGT, hoặc cấu trúc khác) với kế toán hai bên.

> **Khuyến nghị thương lượng**: đề xuất mô hình lai — 20–30% tiền mặt theo milestone + phần còn lại vườn sâm, hoặc giữ nguyên vườn sâm nhưng có buyback giá sàn. Không nên nhận 100% hiện vật không văn bản định danh.

## 9. Out-of-scope tổng thể

- Không cam kết "số hóa toàn bộ" theo nghĩa đen — chỉ theo Phụ lục A.
- Không phát triển phần mềm bán hàng/ERP mới; không thay thế phần mềm kế toán.
- Không cam kết KPI kinh doanh (doanh số, follower tuyệt đối) — cam kết hệ thống & sản lượng vận hành.
- Yêu cầu phát sinh ngoài Phụ lục = change request, báo giá & gia hạn riêng.

## 10. Quản lý rủi ro đã lường trước

| Rủi ro | Giảm thiểu |
|---|---|
| Data không có/không bàn giao | Data audit T1 + nghĩa vụ Mục 5.2 + scope theo Phụ lục A |
| Scope creep | Steering tuần + change request có giá |
| Nội dung vi phạm QC TPBVSK | Guardrail claim-whitelist + duyệt người |
| Chất lượng code junior | Review gate + staging; junior không chạm auth/thanh toán |
| Internet chỗ làm việc | Hệ thống 100% cloud; kiểm tra sóng chuyến khảo sát đầu |
| Hệ thống "chết" sau bàn giao | Train-the-trainer + nghiệm thu "2 tuần tự vận hành" |
| Thanh toán hiện vật | Định danh cây + công chứng + buyback + pro-rata tiền mặt |

## 11. Phụ lục cần ký kèm

- **Phụ lục A**: Danh mục & số lượng dữ liệu số hóa (điền sau data audit tuần 1–2).
- **Phụ lục B**: Định danh vườn sâm quy đổi (bản đồ, số cây, tuổi, biên bản kiểm kê, công chứng).
- **Phụ lục C**: Danh sách tài khoản/quyền truy cập công ty cung cấp.
- **Phụ lục D**: Bộ câu hỏi/test-set nghiệm thu chatbot & guardrail.

---

*Checklist mang đi gặp bác Lực: (1) hỏi PM nội bộ là ai; (2) hỏi 2-3 use-case agent họ đau nhất; (3) hỏi đã có xác nhận nội dung QC cho TPBVSK chưa; (4) chốt con số Phụ lục B bằng văn bản; (5) mang file này + nhờ luật sư đọc trước khi ký.*
