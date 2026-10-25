# Dọn tài nguyên lượt r13 (24/10/2026)

- Đã xác minh rồi xóa: container `samsam-itacc-r13` (postgres:17-alpine, 127.0.0.1:55453, tạo 11:31Z lượt này) kèm volume
  ẩn danh — gồm mọi DB `samsam_itacc_r13_*` (17 DB mục lô lo3, DB lo1/lo2 còn lại, `full1`, `full2`, `t1`, `up1`, `up3`,
  `up4`); trước lô lo3 đã drop 17 DB mục lo1/v2 để chạy lại trên fp mã cuối (`runs/drop_truoc_lo3.txt`).
- Xóa thư mục scratchpad của lượt: `r13/secret` (mật khẩu admin cluster + env DSN/muối/khóa vault từng DB), `r13/ext_farming`
  (kho media/model GIẢ của farming-01), `r13/ext_dp072` (bản backup THỬ + tệp passphrase THỬ của data_platform-07.2),
  `r13_fp` (index tạm fingerprint).
- Xóa SAU khi đã lưu evidence (runs/, gate/, probes/, items/, criteria/) và quét secret (gate/secret_scan*.txt — 0 giá trị thật).
- GIỮ: snapshot baseline `D:\code\samsam_r13_baseline` (git archive 1ad90df + SHA256SUMS — căn cứ probe "trước"; người dùng
  quyết định xóa); tài nguyên các lượt cũ không đụng.
- Ghi chú: passphrase THỬ của data_platform-07.2 R13-04 nằm trong tiêu chí/log ca (giá trị giả "Thử R13", không phải khóa thật).
- Không đụng: DB `samsam`, `.agents/`, `founder/`, `lv2-market-top.png`, container khác trên máy.
