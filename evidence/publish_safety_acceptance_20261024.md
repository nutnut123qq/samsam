# Quét trước xuất bản safety-acceptance — 24/10/2026

- Người dùng đã cho phép quét secret, sạch thì commit, merge vào main và push.
- Baseline Git: `16b33fc9b4f0e0ff45dbeab78972100909ec0340`.
- Mã đã nghiệm thu: fingerprint `8f9188ade140c8aea64162400a772ae3f41c2780f788edb40fc9b254ae82aed3`.
- Quét 10.815 tệp (36.448.105 byte): toàn bộ phần thay đổi thuộc phạm vi và toàn bộ evidence hiện có. Đối chiếu giá trị bí mật từ cấu hình local, mẫu key/private key, DSN URL và libpq; đối chiếu định danh từ DOCX mà không ghi giá trị vào log.
- Kết quả: không phát hiện secret thật cần che. Các khớp còn lại được kiểm ngữ cảnh: số/mã test trùng chuỗi số ngắn, MST công khai có sẵn trong lịch sử, biến/regex/placeholder DSN và token giả của fixture.
- Đã đọc hằng bytecode của 9 tệp pyc, các hàng dữ liệu của 3 SQLite thử bằng chế độ chỉ đọc. 5 tệp mang đuôi PDF là fixture giả rất ngắn (1–62 byte), đã kiểm trực tiếp byte; không phải tài liệu hợp đồng thật.
- Bốn thư mục evidence itacc_r10/r11/r12/r12_fix_d2_l3 được đặt `-text` trong `.gitattributes` để Git giữ nguyên byte, không làm sai SHA256 manifest khi chuyển nền tảng.
- Full pytest của bản mã đã kiểm: 6.773 passed, 0 failed, 0 skipped; lượt này đối chiếu log và fingerprint, không chạy lại full. Probe D2/L3 đã được controller chạy lại trước/sau và đạt. Kiểm tài liệu có một lỗi kết nối DB; ba lần chạy lại nhóm đó đều pass, chưa xác định chắc nguyên nhân.
- Nội bộ: 84 ĐẠT / 12 BỊ CHẶN; nghiệm thu hợp đồng vẫn 0/96. Không dùng DB samsam, không deploy, không bật lịch hoặc đổi credential.
- Giữ ngoài commit: `.agents/`, `founder/`, `lv2-market-top.png`, cấu hình và credential local. Snapshot baseline ngoài repo được giữ.

Đây là bản ghi kiểm trước commit; kết quả commit/push được báo riêng sau khi Git xác nhận.
