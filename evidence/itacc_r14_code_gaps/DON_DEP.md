# Dọn tài nguyên thử — lượt r14 (25/10/2026)

Chỉ dọn tài nguyên do CHÍNH lượt này tạo, sau khi đã lưu evidence + quét secret (`gate/secret_scan.txt`, EXIT 0).

| Tài nguyên | Xác minh trước khi dọn | Kết quả |
|---|---|---|
| Container `samsam-itacc-r14` (postgres:17-alpine, 127.0.0.1:55455) + volume ẩn danh | chỉ chứa DB tiền tố `samsam_itacc_r14_` (base1, base2, a1, a2, up1, full1, p03, dp021, f06, dp06) | đã xóa (`docker rm -f -v`), 0 container r14 |
| Login tạm `r14p2_*` (probe P2) | probe tự `revoke connect` + `drop role` khi xong; cụm đã xóa cùng container | không còn |
| DB lô k1 (`samsam_itacc_r14_f06`) / k2 (4 DB mục) | `runs/drop_truoc_k2.txt`, `runs/drop_truoc_k3.txt` | drop trước khi chạy lại |
| Scratchpad `…/scratchpad/r14/` (mật khẩu admin cụm, env DB thử, kho token thử `ext_dp06`), `r14w/` (script vá tạm), `r14_fp/` | đường dẫn khớp harness lượt này | đã xóa |
| Tab trình duyệt trong app mở tài liệu Shopee/TikTok (chỉ đọc, không đăng nhập) | — | đóng |

GIỮ LẠI: snapshot baseline `D:\code\samsam_r14_baseline` (= `git archive 0afa388`, 15247 tệp — tái tạo được từ commit);
snapshot/tài nguyên các lượt trước không đụng. Model PaddleOCR `~/.paddleocr/whl` có sẵn từ trước, không tải thêm.

Ghi chú trung thực: lô k1 dừng có chủ đích bằng TaskStop (đã kiểm không còn tiến trình con). Lô k2 farming-06 FAIL do chữ ký
`anchor.upgrade` mới làm vỡ harness r13 (`__defaults__`) — đã sửa mã (keyword-only `by`) và chạy lại toàn bộ (k3).
