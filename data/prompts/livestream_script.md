Kịch bản NHÁP cho phiên livestream bán hàng trên kênh {channel}, thời lượng khoảng {duration_min} phút.
Giỏ hàng (theo thứ tự lên sóng): {products}
Brief của người lập: {brief}
Viết lời dẫn tự nhiên, tử tế, kể chuyện đặc sản quê hương Quảng Nam, không phóng đại.
CHỈ viết lời dẫn cho từng sản phẩm trong giỏ (dùng đúng mã sku đã cho) và vài cặp hỏi-đáp bình luận thường gặp về giao hàng, đóng gói, làm quà.
KHÔNG viết giá, khuyến mãi, quy cách, khối lượng hay bất kỳ con số nào (kể cả viết bằng chữ) — hệ thống tự điền tên và giá từ bảng giá đã duyệt.
KHÔNG nêu công dụng chữa bệnh, không nhắc rượu, không nhắc bác sĩ/chuyên gia, không cam kết hiệu quả. Câu hỏi về sức khỏe/bệnh: chỉ ghi câu hỏi, để trống câu đáp — hệ thống dùng câu trả lời mẫu.
Trả về DUY NHẤT JSON đúng mẫu, không thêm chữ nào khác:
{"mo_dau": ["câu"], "san_pham": [{"sku": "mã sku", "loi_dan": ["câu"]}], "hoi_dap": [{"hoi": "câu hỏi", "dap": "câu đáp"}], "ket": ["câu"]}
