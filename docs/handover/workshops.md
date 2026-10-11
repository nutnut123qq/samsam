# Giáo trình 4 workshop — Đào tạo & chuyển giao (WS4)

**Dành cho ai:** đội dự án dạy + "AI champion" nội bộ Sâm Sâm học — mỗi
buổi 90–120 phút, học-viên thao tác trên app thật.
**Làm việc gì:** outline 4 buổi theo hợp đồng WS4 ("tối thiểu 4 workshop
+ playbook từng vai trò"). Mỗi buổi gồm: mục tiêu / đối tượng / chuẩn bị /
agenda / bài tập vận hành / đầu ra đo được.
**Cần gì:** máy chiếu + máy mỗi học viên chạy được app (`streamlit run
app/streamlit_app.py`), `.env` đủ `OPENROUTER_API_KEY` + `DATABASE_URL`,
DB đã nạp (`python scripts/apply_schema.py` → `python -m
ingest.core_store` → `python -m ingest.embed_store`), playbook của vai
trò tương ứng in sẵn.

> Lưu ý scope: đây là **giáo trình/outline**. Buổi dạy thật + nghiệm thu
> "2 tuần tự vận hành" là sự kiện với công ty (SOW §3 T5–T6). Nghiệm thu
> chung: AI champion tự vận hành pipeline 2 tuần không cần đội dự án.

---

## W1 — Knowledge base & chatbot (buổi nền)

**Mục tiêu:** hiểu chatbot trả lời dựa trên gì, biết dùng tab **Chat Sâm
Sâm** + **Chưa trả lời**, phân biệt "bot biết" vs "bot chịu" vs "bot
trả lời sai".
**Đối tượng:** tất cả vai trò (MKT, sales-admin, vườn, quản lý).
**Playbook kèm:** `playbook-sales-admin.md`.

Agenda:

1. (15') Bức tranh hệ thống theo `kien-truc.md`: crawl web public →
   jsonl → nạp Postgres (`chunks`) → hỏi → embed câu hỏi → tìm chunk
   gần nhất → LLM trả lời kèm nguồn.
2. (15') Ba quy tắc sống còn: (a) trả lời CHỈ từ ngữ cảnh KB, thiếu →
   "Chưa đủ dữ liệu để trả lời."; (b) mọi câu phải kèm nguồn URL;
   (c) không khẳng định công dụng y tế ngoài công bố.
3. (30') Thực hành tab **Chat Sâm Sâm**: mỗi học viên hỏi ≥5 câu trong
   `tests/questions.md` (Q1–Q10) — quan sát câu trả lời + link nguồn +
   caption "Nguồn:".
4. (20') Hai câu bẫy: hỏi Q11 (xuất khẩu Mỹ) → bot phải nói chưa đủ dữ
   liệu + caption "đã chuyển nhân viên"; hỏi Q12 (chữa ung thư) → bot
   phải từ chối khẳng định. Mở tab **Chưa trả lời** thấy câu vừa hỏi
   nằm trong queue.
5. (15') Giới hạn pilot: KB = data public (chưa có data nội bộ — SOW
   §5.2); trợ lý tri thức nội bộ cần data công ty bàn giao.
6. (10') Bài tập giao về + Q&A.

**Bài tập vận hành (bắt buộc nộp):**
- Hỏi đủ Q1–Q10 trong app, chụp 3 câu trả lời kèm nguồn.
- Hỏi 1 câu ngoài KB tự chọn → xác nhận nó vào tab **Chưa trả lời**.

**Đầu ra đo được:** học viên chỉ đúng nguồn trích của 1 câu trả lời;
giải thích được vì sao Q11/Q12 phải trả lời kiểu đó.

---

## W2 — Content Studio + guardrail + duyệt

**Mục tiêu:** sinh được draft đa kênh, đọc được kết quả guardrail, vận
hành hàng duyệt đúng "double-gate" (guardrail PASS → NGƯỜI duyệt).
**Đối tượng:** MKT (chính), quản lý duyệt bài.
**Playbook kèm:** `playbook-mkt.md`. Prompt mẫu: `prompt-library.md`.

Agenda:

1. (15') Luật TPBVSK trong hệ thống: từ cấm (`data/banned_words.txt`)
   + whitelist công dụng (`data/claims_whitelist.json`) → guardrail 2
   lớp; ví dụ `test_banned_word_case_bat_buoc` và
   `test_approved_claim_pass_sach` (xem `phu-luc-d.md`).
2. (25') Thực hành **Content Studio**: nhập brief mẫu (lấy ở
   `prompt-library.md` mục "Template brief"), chọn 2 kênh
   (facebook + tiktok), "Sinh bài" → đọc từng draft + violation tô đỏ.
3. (15') Check tay: dán text "Saphraton chữa khỏi tiểu đường" vào ô
   "Text cần check" → thấy `banned_word`; dán claim whitelist Sapentol
   → thấy PASS + `matched_claims`.
4. (20') **"Lưu vào hàng duyệt"** → qua **Duyệt & Lịch**: đọc draft,
   điền Người duyệt + ghi chú → Duyệt. Chứng minh: draft guardrail VI
   PHẠM có nút Duyệt bị khóa.
5. (15') Xếp lịch + xem "Lịch đăng 14 ngày". **Nhấn mạnh: hệ thống
   KHÔNG tự đăng — đến ngày NGƯỜI copy đăng tay.**
6. (10') Khi nào whitelist thiếu → báo bổ sung `claims_whitelist.json`
   (quy trình trong `sop.md`).

**Bài tập vận hành:**
- Sinh ≥3 draft (≥2 kênh), lưu hàng duyệt, duyệt 2 từ chối 1 (ghi note
  lý do), xếp lịch 2 bài approved.
- CLI: `python -m pipelines.store --pending` và `--calendar` — đối
  chiếu với UI.

**Đầu ra đo được:** hàng duyệt có draft do học viên tạo; calendar có
đúng bài đã xếp; học viên giải thích được vì sao nút Duyệt bị khóa.

---

## W3 — Leads + báo cáo

**Mục tiêu:** đọc dashboard leads, gom lead mới, sinh + đọc báo cáo
định kỳ, hiểu nguồn số liệu và nhãn *(mẫu)*.
**Đối tượng:** sales-admin (chính), MKT, quản lý.
**Playbook kèm:** `playbook-sales-admin.md` + `playbook-mkt.md`.

Agenda:

1. (15') Convlog là gì: `data/conversations.jsonl` (1 dòng/hội thoại,
   question đã mask PII, rotate >5MB, purge 30 ngày) — nguồn của queue
   "Chưa trả lời" và của leads.
2. (20') Chạy `python -m ingest.lead_store` trên terminal: đọc dòng
   `[scan]` (bao nhiêu record, bao nhiêu lead suy ra, bao nhiêu bị bỏ
   qua vì không-khớp-intent) + `[done] mới=.. trùng=..`.
3. (20') Tab **Leads**: 3 metric đầu (Tin nhắn / Đã trả lời / Zalo/
   Streamlit) + bảng leads (kênh, intent, câu hỏi, trạng thái). Ý
   nghĩa 4 intent partner/order/price/contact và thứ tự ưu tiên gọi.
4. (20') Tab **Báo cáo**: "Sinh báo cáo" 7 ngày → mở file trong
   `data/reports/` → đọc từng mục (Bán hàng / Leads / Kênh chat /
   Vùng trồng / Social metrics "chờ bàn giao" / Nguồn dữ liệu).
   Nhãn *(mẫu)* = dữ liệu mẫu chờ công ty bàn giao — **không được
   đem số mẫu báo lãnh đạo như số thật.**
5. (15') Chạy CLI `python -m agents.report --days 30` + đối chiếu file
   mới. Nhấn mạnh: báo cáo là BẢN NHÁP, người duyệt rồi gửi — hệ thống
   không tự gửi Zalo/email.
6. (10') Bài tập + Q&A.

**Bài tập vận hành:**
- Chạy `python -m ingest.lead_store` trước buổi; trong buổi sinh 1 báo
  cáo và chỉ ra 1 dòng *(mẫu)*.
- Trình bày 2 câu: "tỉ lệ trả lời được tuần này" và "bao nhiêu lead
  `new` đang chờ xử lý".

**Đầu ra đo được:** học viên đọc đúng metric + phân biệt số mẫu/số
thật; sinh được file báo cáo đúng kỳ.

---

## W4 — Vận hành + tự-chữa-lỗi (cho AI champion)

**Mục tiêu:** 1–2 AI champion chạy được chu trình vận hành ngày/tuần và
xử lý 3 sự cố thường gặp không cần đội dự án.
**Đối tượng:** AI champion / người vận hành (bắt buộc), quản lý (khuyến
khích).
**Tài liệu chính:** `sop.md` (in bản mới nhất).

Agenda:

1. (20') Đọc `sop.md` từ đầu: chu trình ngày (mở app → rà queue →
   harvest leads → rà hàng duyệt → ghi nhật ký), chu trình tuần (báo
   cáo, rà "Cần chú ý" vườn, backup).
2. (25') Thực hành chu trình đầy đủ trên máy thật:
   `python -m ingest.lead_store` → `python -m pipelines.store
   --pending` → `python -m pipelines.store --calendar` →
   `python -m agents.garden --check` → `python -m agents.report`.
3. (25') **Diễn tập sự cố** (đội dự án dựng tình huống):
   - DB chết: dừng Postgres → các tab hiện "Chưa nạp", CLI đọc in
     "chưa nạp" thoát êm, CLI ghi báo lỗi exit≠0 → khởi động lại theo
     `sop.md`.
   - Hết quota OpenRouter: chat lỗi / draft không sinh → đọc dấu hiệu,
     kiểm `OPENROUTER_API_KEY` trong `.env`, nạp credit.
   - Convlog/KB: câu hỏi mới cần bổ sung KB → chạy lại
     `python -m crawler.collect` + `python -m ingest.embed_store`.
4. (15') Backup + file trên đĩa đừng-xóa: `data/conversations.jsonl`,
   `data/zalo_tokens.json`, `data/zalo_seen.db`, `data/reports/` — và
   lệnh `db_backup`/`db_restore_drill` trong `sop.md` mục 6.
5. (15') Ôn lại toàn bộ human-gate: không tự đăng/gửi/gọi khách —
   ai làm gì ở điểm nào (`kien-truc.md` mục human-gate).
6. (10') Chốt lịch "2 tuần tự vận hành" + kênh hỗ trợ.

**Bài tập vận hành:**
- Chạy đủ 5 lệnh chu trình trên, chụp output từng lệnh.
- Tự mô tả lại các bước khi tab hiện "Chưa nạp" mà không nhìn tài liệu
  (sau đó đối chiếu `sop.md`).

**Đầu ra đo được:** AI champion chạy chu trình không cần hỗ trợ; diễn
tả đúng quy trình khi DB chết và khi hết quota OpenRouter.

---

## Ma trận vai trò × workshop

| Vai trò | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| MKT | ✔ | ✔ (chính) | khuyến khích | khuyến khích |
| Sales-admin | ✔ | khuyến khích | ✔ (chính) | khuyến khích |
| Vườn | ✔ | — | khuyến khích | khuyến khích |
| AI champion | ✔ | ✔ | ✔ | ✔ (chính) |
| Quản lý | ✔ | ✔ (duyệt bài) | ✔ | khuyến khích |
