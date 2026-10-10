# Playbook — Sales-admin (chăm sóc khách hàng + leads)

**Dành cho ai:** nhân viên sales/admin — người theo dõi câu hỏi khách,
trả lời phần bot không trả lời được, và xử lý lead có ý định mua.
**Làm việc gì:** rà queue "Chưa trả lời" mỗi ngày → follow-up khách →
theo dõi dashboard leads → báo cáo câu hỏi mới để bổ sung knowledge base.
**Cần gì:** app đang chạy (`streamlit run app/streamlit_app.py`); phần
leads cần DB (`DATABASE_URL` trong `.env`, xem `sop.md`).

## Tab bạn dùng

| Tab | Dùng để |
|---|---|
| **Chat Sâm Sâm** | Chatbot RAG trả lời trên knowledge base public — mỗi câu kèm link nguồn; bạn dùng để thử câu hỏi trước khi trả lời khách / kiểm tra bot |
| **Chưa trả lời** | Queue các câu bot trả "Chưa đủ dữ liệu" (convlog `answered:false`) — việc follow-up của bạn mỗi ngày |
| **Leads** | Dashboard: số tin nhắn/tỉ lệ trả lời theo kênh + bảng `leads` (câu hỏi có ý định mua/giá/địa-điểm/đại-lý) |

## Nguyên tắc không đổi

- Bot **không bịa**: thiếu dữ liệu nó nói "Chưa đủ dữ liệu để trả lời."
  và đẩy khách sang nhân viên — đó là lý do queue tồn tại.
- Câu trả lời bot luôn kèm **nguồn (URL)** — khi follow-up khách, trích
  đúng nguồn đó, đừng thêm công dụng ngoài dữ liệu.
- Tab Leads ở pilot là **read-only** — đổi trạng thái lead (new →
  contacted/won/lost) cập nhật trực tiếp trong DB (xem `sop.md`).
- Hệ thống KHÔNG tự gọi/nhắn khách — mọi follow-up do bạn thực hiện.

## Quy trình ngày mẫu

1. **Sáng — rà queue "Chưa trả lời":** mở tab **Chưa trả lời**, đọc bảng
   (Thời gian UTC / Câu hỏi / user_hash, mới nhất lên đầu). Với mỗi câu:
   - Thuộc phạm vi trả lời được (giá, địa chỉ, sản phẩm có trong KB)
     → inbox/gọi khách trả lời tay theo thông tin chính thức.
   - Câu hỏi hay/chủ đề mới → ghi vào sổ "đề xuất bổ sung KB" để gửi
     người vận hành (họ crawl/nạp thêm — xem `sop.md`).
2. **Rà dashboard "Leads":**
   - Hàng "Kênh chat (convlog)": số tin nhắn, tỉ lệ trả lời được, tách
     Zalo/Streamlit. Tỉ lệ trả lời tụt → nhiều câu lọt queue → báo bổ
     sung KB.
   - Bảng "Leads": các câu hỏi được gom khi chạy `python -m
     ingest.lead_store` (xem `sop.md` — nên chạy đầu ngày). Intent:
     `partner` (đại lý/sỉ) > `order` (mua/ship) > `price` (giá) >
     `contact` (địa chỉ/liên hệ). Ưu tiên gọi `partner`/`order` trước.
   - `user_hash` là mã băm — không phải SĐT; kết hợp kênh Zalo OA để
     biết khách nào và nhắn lại trong OA.
3. **Cập nhật trạng thái lead** sau khi xử lý: `new` → `contacted` /
   `won` / `lost` — cập nhật trong DB (chưa có nút trên UI ở pilot;
   hướng dẫn SQL ở `sop.md` mục "Cập nhật status lead").
4. **Trước khi trả lời câu khó:** hỏi thử tab **Chat Sâm Sâm** để xem
   bot trích nguồn nào — dùng nguồn đó làm căn cứ trả lời khách, tránh
   nói sai công dụng TPBVSK.
5. **Báo cáo tuần:** phần leads + kênh chat nằm sẵn trong báo cáo định
   kỳ (tab **Báo cáo** hoặc `python -m agents.report`) — bạn chỉ cần
   gửi số liệu đó, không tổng hợp tay.

## CLI liên quan

```
python -m ingest.lead_store     # gom lead mới từ convlog vào bảng leads
                                # (idempotent — chạy lại không nhân đôi)
python scripts/eval_qa.py       # đo chất lượng chatbot 12 câu (xem phu-luc-d.md)
```

## Khi nào gọi người khác

| Tình huống | Gọi ai |
|---|---|
| Nhiều câu hay lọt queue "Chưa trả lời" | Người vận hành — crawl/nạp thêm nội dung vào KB (`sop.md` mục "Cập nhật knowledge base") |
| Bảng leads trống/hiện "Chưa có dữ liệu leads" | Người vận hành — chạy `python -m ingest.lead_store`; vẫn trống nghĩa là convlog chưa có câu ý định mua |
| Câu hỏi có ý mua nhưng không lên leads | Báo đội dự án — intent hiện là heuristic keyword, có thể sót cụm |
| Khách khiếu nại bot trả lời sai | Quản lý + đội dự án — lưu lại câu hỏi + câu trả lời + nguồn bot trích |
| Muốn sửa trạng thái lead mà không rành SQL | Người vận hành |
