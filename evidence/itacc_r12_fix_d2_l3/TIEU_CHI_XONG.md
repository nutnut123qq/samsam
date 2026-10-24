# Tiêu chí xong — lượt r12-fix D2/L3 (24/10/2026)

Ghi chú trung thực: tệp này được GHI RA sau khi đã vá; trước khi sửa, tiêu chí nằm trong docstring hai probe (khóa bằng
sha256 `probes/*_truoc/ban_ghi.json`) và yêu cầu lượt. Nội dung dưới đây không nới các tiêu chí đó.

Bàn giao đã kiểm: nhánh `codex/safety-acceptance`, HEAD `16b33fc9…`, index sạch, fp code `57538e89…`, fp full `116fc4a9…`.

1. Snapshot working tree r12 hiện tại ở `D:\code\samsam_itacc_r12fix_baseline` (ngoài checkout, SHA256SUMS, không
   credential), fingerprint khớp bàn giao.
2. Probe D2 và probe L3 (cùng mã/input/assertion/điều kiện thời gian): baseline FAIL đúng lỗi nghiệp vụ (D2: SĐT ngoặc
   ok=True không mã; L3: câu gửi lúc quá hạn hứa nhân viên), bản sửa PASS, cùng sha256 probe; ghi fp, lệnh, exit.
3. D2: `check_publish` chặn SĐT ngoặc trên kênh công khai bằng chính bước phẳng hóa của `pipelines.pii` (luật chống nối,
   ngân sách tuyến tính); giữ pii_allow/hotline/giá/ngày/mã SP; `check()` chat + internal_note giữ phạm vi; `_mask_pii`
   đầu ra không đổi.
4. L3: quá 30 giây → câu hotline không hứa, gửi trước, ghi handoff đúng 1 lần sau gửi, không crash khi DB lỗi/rollout
   chặn; ngân sách 30 s + phần dự trữ gửi giữ nguyên; Messenger đi cùng đường; các template khác không đổi.
5. Test hồi quy bền trong `tests/` + test cũ cập nhật (không bỏ assertion an toàn); test tập trung xanh.
6. Mục ảnh hưởng (legal_hr-01, sales-01 + đại diện content/listing/livestream) kiểm lại bằng tiêu chí phiên bản MỚI khóa
   hash TRƯỚC khi chạy, DB mới trên container mới; ghi lý do/mức kiểm; tiêu chí cũ + evidence cũ giữ nguyên.
7. Full pytest `python -m pytest -q -ra -p no:cacheprovider` trên DB mới, code cuối; script dừng khi dựng DB/preflight
   lỗi, exit code truyền qua ống log, che URL DSN + libpq `password=`. Số pass/fail/skip thật, DR ghi rõ.
8. ruff, eval `--deterministic --no-record`, DPIA, red-team EXIT 0; quét secret 0 giá trị thật.
9. Tổng hợp đúng 96 ID, mỗi ID 1 nguồn hiện hành, file/hash nhất quán; số ĐẠT/CHƯA KIỂM/BỊ CHẶN thật (không ép).
10. Docs (`nghiem-thu-ky-thuat-noi-bo.md`, DONE.md, v13-board.md) cập nhật đúng; doc tests xanh; fp code không đổi sau docs.
11. Không DB `samsam`; không commit/merge/push/deploy; không đụng `.agents/`, `founder/`, `lv2-market-top.png`; dọn
    container/DB/secret của lượt sau khi lưu evidence.
