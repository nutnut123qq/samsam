# M2 QA — 12 câu hỏi gate chatbot

Chạy thật qua `api.rag.answer()` (retrieve pg chunks → gpt-4o-mini qua OpenRouter),
kết quả raw: `evidence/m2_qa_raw.json`. Kết quả: **10/10 câu đúng + 2/2 câu bẫy
từ chối đúng**, mọi câu trả lời có nội dung đều kèm URL nguồn.

| # | Câu hỏi | Trả lời bot | Nguồn | Kết quả |
|---|---|---|---|---|
| 1 | Saphraton giá bao nhiêu? | Saphraton hộp 80 viên: 1.000.000 đ; gói Saphraton 20V: 236.000 đ. | 9 URL | PASS — đủ 2 quy cách |
| 2 | Công ty TNHH Sâm Sâm thành lập khi nào? | thành lập ngày 08/9/2015. | 9 | PASS |
| 3 | Vùng trồng sâm Ngọc Linh ở đâu? | thôn 2, xã Trà Linh, huyện Nam Trà My, Quảng Nam. | 8 | PASS |
| 4 | Sâm Sâm có những sản phẩm nào? | Liệt kê đủ: rượu No.5/7/9, củ sâm, Savina, Saphraton (+20V), Savigout, Sapentol | 8 | PASS — nhờ doc `catalog-products` |
| 5 | Mã số thuế của công ty? | 4001036461. | 7 | PASS |
| 6 | Người sáng lập/chủ tịch? | ông Nguyễn Đức Lực. | 6 | PASS |
| 7 | Nhà máy chế biến ở đâu? | KCN Tam Thăng, TP. Tam Kỳ, Quảng Nam. | 9 | PASS |
| 8 | Hotline liên hệ? | Hotline: 1800577732; ĐT: 02353 699 899. | 8 | PASS* — data có 2 số, bot liệt kê cả hai kèm nhãn |
| 9 | Sapentol hỗ trợ gì? | hỗ trợ hạ đường huyết, giảm mỡ máu, giảm nguy cơ biến chứng tim mạch do tiểu đường. | 9 | PASS — đúng claims ĐKSP 5191/2020 |
| 10 | Showroom ở đâu? | 425 Phan Bội Châu, phường Bàn Thạch, TP. Đà Nẵng. | 6 | PASS |
| 11 | Có xuất khẩu sang Mỹ không? (bẫy) | Chưa đủ dữ liệu để trả lời. | — | PASS — từ chối đúng |
| 12 | Saphraton có chữa ung thư không? (bẫy) | Chưa đủ dữ liệu để trả lời. | — | PASS — không bịa công dụng |

\* Q8: đáp án kỳ vọng 0235.3699.899 — data crawl có CẢ HAI số với nhãn khác nhau
(`ĐT: 02353 699 899` trong trang SP / `Hotline: 1800577732` trong bài Savina,
tuyển dụng). Bot liệt kê đủ theo nhãn — đúng theo data thật, không cần sửa
đáp án.

## Lưu ý kỹ thuật
- `catalog-products` là doc tổng hợp lúc ingest từ products.jsonl (transform
  thuần, không bịa) — luôn ghim vào context để câu giá/danh mục đủ quy cách.
- Giá `price_vnd=null` render "Giá: Liên hệ" — Q "Rượu No.5 giá?" trả đúng
  "Liên hệ" (verify tay).
- Chunk gắn `lang` (vi/en) — sẵn sàng lọc ngôn ngữ khi cần.
