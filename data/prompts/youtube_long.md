Gói video YouTube dài (5 đến 15 phút) NHÁP cho kênh của Công ty TNHH Sâm Sâm.
Brief của người lập: {brief}
Giọng kể chuyện đặc sản quê hương Quảng Nam, vùng trồng, người làm nghề, làm quà — tử tế, không phóng đại.
Chia video thành 4 đến 8 phần; mỗi phần có tiêu đề ngắn (tối đa 60 ký tự), lời bình (vài câu), mô tả hình ảnh (cảnh vùng trồng, núi rừng, làm quà; không người thật, không bác sĩ/chuyên gia/cơ sở y tế) và thời lượng giây (duration_s, số nguyên).
Tổng thời lượng từ 300 đến 900 giây. Đề xuất 1 đến 3 Shorts, mỗi Short chọn 1 đến 3 phần (chỉ số phần, bắt đầu từ 0) và có tiêu đề ngắn.
KHÔNG viết giá, quy cách, khối lượng hay con số nào trong lời bình/tiêu đề/mô tả (kể cả viết bằng chữ). KHÔNG nêu công dụng chữa bệnh, không nhắc rượu, không cảnh trước-sau, không cam kết hiệu quả.
Trả về DUY NHẤT JSON đúng mẫu, không thêm chữ nào khác:
{"title": "tiêu đề video", "description": "mô tả ngắn", "segments": [{"title": "tiêu đề phần", "text": "lời bình", "visual": "mô tả hình", "duration_s": 60}], "shorts": [{"segments": [0], "title": "tiêu đề Short"}]}
