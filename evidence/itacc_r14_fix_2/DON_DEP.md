# Dọn tài nguyên thử — lượt r14-fix2 (25/10/2026)

Chỉ dọn tài nguyên do CHÍNH lượt này tạo, sau khi đã lưu evidence + quét secret (`gate/secret_scan.txt`, EXIT 0).

| Tài nguyên | Xác minh trước khi dọn | Kết quả |
|---|---|---|
| Container `samsam-itacc-r14fix2` (postgres:17-alpine, 127.0.0.1:55456) + volume ẩn danh | chỉ chứa DB của lượt: `samsam_itacc_r14fix2_{t1,t2,f06,dp06,full1}`, `samsam_itacc_r14f2_{hist,new}_{truoc,sau}` (probe Q2), `samsam_itacc_r14_hq1` (bản sao template t1 cho probe hồi quy r14 P2 — `runs/db_hq1.txt`); 0 login tạm `r14f2_*` còn lại (probe tự xóa) | đã xóa (`docker rm -f -v`), 0 container r14fix2 |
| Scratchpad `…/scratchpad/r14fix2/` (mật khẩu admin cụm, env DB thử, kho token thử) và script vá tạm `f2_*.py` | đường dẫn khớp lượt này | đã xóa |

GIỮ LẠI: snapshot r14 CHƯA vá `D:\code\samsam_r14fix_snapshot` (manifest `SNAPSHOT_r14_chua_va_SHA256SUMS.txt`, fp mã
`ed6a3551…`); `D:\code\samsam_r14_baseline` (lượt r14, = `git archive 0afa388`) và mọi tài nguyên lượt trước không đụng.

Ghi chú: credential trong log probe Q1/pytest là giá trị GIẢ đặt tên `FAKE_*`/`*_SECRET_*` — không phải khóa thật.
