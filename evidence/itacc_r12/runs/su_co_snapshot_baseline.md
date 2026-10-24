# Sự cố harness r12 — snapshot baseline bị dọn một phần (24/10/2026)

- Bối cảnh: máy khởi động lại qua đêm 23→24/10; Docker Desktop không lên (socket cũ
  `%LOCALAPPDATA%\Docker\run\dockerInference`), đã đổi tên thư mục `run` → `run.r12-stale-*` rồi khởi động lại;
  container `samsam-itacc-r12` dữ liệu còn nguyên.
- Snapshot baseline trong scratchpad (`r12/before`, 1150 tệp theo `snap_list.txt`) chỉ còn 360 tệp (Temp bị dọn).
  Các lượt probe `dot1_truoc`, `dot2_truoc`, `dot3_truoc` chạy ngày 23/10 khi snapshot còn đủ.
- Dựng lại `r12/before`: 360 tệp còn lại giữ nguyên; 10 tệp bị mất mà r12 đã sửa (acc_ar, fp_opscost, garden, pc_hr,
  qr_trace, test_kd_catalog/forecast/quote, test_rollout_enforce, test_v13_c01_pii_guardrail) — diff hiện tại so HEAD
  của chúng chỉ gồm thay đổi r12 → lấy `git show HEAD:<tệp>`; 780 tệp còn lại không bị r12 sửa → chép từ working tree.
- Kiểm: fingerprint (cùng phương pháp alternate index, 9 tệp mới, trừ DONE.md/v13-board.md) của bản dựng lại =
  `97051e55c1191625638de98047c896b6b2bc893e63e90e6695915b580c388001` = fingerprint baseline đã chốt.
- Lượt thử `dot4_truoc` đầu tiên KHÔNG chạy (mkdb lỗi do snapshot thiếu `scripts/apply_schema.py`; DB
  `samsam_itacc_r12_d4b1` dựng dở, bỏ). Log dựng DB của lần thử trước đó (DB timeout khi Docker tắt) đã bị xóa nhầm khi
  dọn — chỉ chứa lỗi kết nối, không có kết quả probe.
