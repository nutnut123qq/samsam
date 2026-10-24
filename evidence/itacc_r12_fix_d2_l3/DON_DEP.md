# Dọn tài nguyên lượt r12-fix (24/10/2026)

- Đã xác minh rồi xóa: container `samsam-itacc-r12fix` (postgres:17-alpine, 127.0.0.1:55452, tạo 07:32Z lượt này) kèm volume
  ẩn danh — gồm DB `samsam_itacc_r12fix_{full1,l01,m011,s01,s03,s071}`; thư mục secret scratchpad `r12fix/secret`
  (mật khẩu admin cluster + env DSN/muối/khóa vault từng DB); index tạm fingerprint `r12fix_fp`.
- Xóa SAU khi đã lưu evidence (runs/, gate/, probes/, items/) và quét secret (gate/secret_scan*.txt — 0 giá trị thật).
- GIỮ (không phải secret): snapshot baseline `D:\code\samsam_itacc_r12fix_baseline` (căn cứ probe "trước"; người dùng
  quyết định xóa), `runs/r12_evidence_sha_{truoc,sau}.txt` (chứng minh evidence r12 không đổi trong lượt — khớp).
- Không đụng: DB `samsam`, `.agents/`, `founder/`, `lv2-market-top.png`, container/tài nguyên khác trên máy.
