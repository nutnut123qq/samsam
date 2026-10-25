# Dọn tài nguyên thử — lượt r13-fix4 (25/10/2026)

Chỉ dọn tài nguyên do CHÍNH lượt này tạo, sau khi đã lưu evidence + quét secret (`gate/secret_scan.txt`, EXIT 0).

| Tài nguyên | Xác minh trước khi dọn | Kết quả |
|---|---|---|
| Container Docker `samsam-itacc-r13fix4` (postgres:17-alpine, 127.0.0.1:55454) + volume ẩn danh của nó | tên/ảnh/cổng khớp `harness/setup_env_r13fix4.sh.txt`; chỉ chứa DB tiền tố `samsam_itacc_r13fix4_` (t1, p03, dp021v2, m021, dp90, dp072, f06, full1) | đã xóa (`docker rm -f -v`), 0 container r13fix4 còn lại |
| DB `samsam_itacc_r13fix4_dp90`, `_dp072` (lô k1) | DB thử của lượt, trước khi chạy lô k2 | drop — `runs/drop_truoc_k2.txt` |
| Scratchpad `…/scratchpad/r13fix4/` (secret: mật khẩu admin cluster, env DB thử; `ext_dp90`, `ext_dp072`, `ext_farming` — thư mục backup/ảnh thử ngoài repo) | đường dẫn khớp harness lượt này | đã xóa |
| Scratchpad `…/scratchpad/fix4/` (t1.py, crit_dump.txt, mk_j_v3.py — bản sao đã lưu `harness/mk_probe_j_v3.py.txt`) | tệp tạm của lượt | đã xóa |

GIỮ LẠI (không dọn): snapshot r13 chưa vá `D:\code\samsam_r13fix_baseline` (manifest `SNAPSHOT_r13_chua_va_SHA256SUMS.txt`,
fp mã `1975775d…`) — baseline để kiểm lại probe trước/sau; snapshot r13 cũ `D:\code\samsam_r13_baseline` và mọi tài nguyên
lượt trước không đụng. Model PaddleOCR `~/.paddleocr/whl` có sẵn từ trước, không tải thêm.

Ghi chú trung thực: trong lượt có chạy nhầm `git -C /d/code/samsam checkout --` KHÔNG kèm đường dẫn — lệnh chỉ liệt kê tệp
đã đổi, không khôi phục gì (đã kiểm ngay: bản vá còn nguyên, fp không đổi).
