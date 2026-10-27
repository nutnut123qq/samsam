# Dọn dẹp tài nguyên thử r15 (25/10/2026)

- **Đã xóa:** container Docker `samsam-itacc-r15` (127.0.0.1:55457) + volume dữ liệu của nó — chỉ chứa DB thử của lượt này
  (`samsam_itacc_r15_*`, `samsam_itacc_r14_hqr15`/`hqr15b`, `samsam_itacc_r14f2_hist|new_r15`/`r15b`); trước khi xóa kiểm 0 login
  tạm còn lại. Thư mục scratchpad `r15/` (mật khẩu admin sinh ngẫu nhiên, tệp env DB thử), `r15smoke/`, `r15gen/`, `r15_fp/`;
  thư mục tạm `%TEMP%\r15_probe_*` (kho token GIẢ, bảng ánh xạ fixture, gói faster_whisper giả).
- **Giữ:** snapshot baseline `D:\code\samsam_r15_baseline` (git archive 70ff9f7, ngoài repo — dùng tái lập phía "trước" của
  probe); các snapshot lượt trước giữ nguyên. Không đụng DB `samsam`, `.agents/`, `founder/`, `lv2-market-top.png`.
- **Smoke không ghi evidence:** trước khi khóa probe, chạy thử probe S/T/M trong scratchpad để kiểm harness (đã xóa); bản ghi
  chính thức là `probes/*` (khóa ở `KHOA_PROBE_truoc_sua.txt`).
