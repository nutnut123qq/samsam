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
  contacted → qualified → won, hoặc lost) bằng CLI `python -m ingest.crm
  --status <id> <trạng thái> --by "<tên>"` (xem `sop.md` mục 5c).
- Chỉ liên hệ marketing / chuyển SĐT-tên khách cho đại lý khi khách đã
  đồng ý đúng mục đích (bảng `consents`) — chưa có đồng ý = KHÔNG.
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
3. **CRM — gán đại lý + trạng thái (v5.2):** chạy `python -m ingest.crm
   --report` xem lead CHƯA gán (kèm tỉnh suy ra + đại lý gợi ý theo
   vùng) → gán `--assign <id> --dealer <mã> --by "<tên>"` (tỉnh không suy
   được thì thêm `--province`). Khách để lại SĐT/tên → nhập qua stdin
   `--add-contact - --lead <id> --by "<tên>"` (KHÔNG gõ SĐT trên dòng
   lệnh). Khách đồng ý (phiếu/biên bản có mã) → `--consent <contact>
   --purpose dai_ly --grant --source ... --evidence <mã> --policy-version
   <v> --dealer <mã> --by "<tên>"`; khách rút → `--withdraw`. Chuyển lead
   cho đại lý: `--handoff <id> --dealer <mã> --by "<tên>"` in nội dung để
   BẠN tự gửi (có SĐT chỉ khi khách đồng ý đích danh đại lý đó). Sau khi
   xử lý: `--status <id> contacted|qualified|won|lost --by "<tên>"` (không
   lùi trạng thái).
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
python -m ingest.crm --report   # CRM: lead theo tỉnh/đại lý/trạng thái, không PII
python -m ingest.crm --help     # đủ lệnh gán/đồng ý/trạng thái/handoff (sop.md mục 5c)
```

## Khi nào gọi người khác

| Tình huống | Gọi ai |
|---|---|
| Nhiều câu hay lọt queue "Chưa trả lời" | Người vận hành — crawl/nạp thêm nội dung vào KB (`sop.md` mục "Cập nhật knowledge base") |
| Bảng leads trống/hiện "Chưa có dữ liệu leads" | Người vận hành — chạy `python -m ingest.lead_store`; vẫn trống nghĩa là convlog chưa có câu ý định mua |
| Câu hỏi có ý mua nhưng không lên leads | Báo đội dự án — intent hiện là heuristic keyword, có thể sót cụm |
| Khách khiếu nại bot trả lời sai | Quản lý + đội dự án — lưu lại câu hỏi + câu trả lời + nguồn bot trích |
| Lệnh CRM báo thiếu `CONTACT_VAULT_KEY` | Người phụ trách hạ tầng — khóa do công ty giữ (`sop.md` mục 5c) |
| Hai đại lý cùng muốn nhận 1 lead | GĐ bán hàng quyết — CLI từ chối gán đè |
