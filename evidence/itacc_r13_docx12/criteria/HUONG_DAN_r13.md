# Tiêu chí kiểm lại r13 — định dạng + luật (đọc TRƯỚC khi viết nháp)

Định dạng giống r12 (`evidence/itacc_r12/criteria/HUONG_DAN.md` — ĐỌC tệp đó), runner r13:
`python -I evidence/itacc_r13_docx12/harness/runner_r13.py.txt <criteria> <lock> <item_id> <env_file>` (đọc mã runner để biết
chính xác `buoc`/`kiem`: `argv`, `env` (giá trị null = xóa biến), `stdin`, `expect_exit` (số hoặc list), `stdout_re`,
`stderr_re`, `out_re`, `bg_start`/`bg_stop`; `kiem`: `sql`+`expect`, `file_glob`+`count`, `file_re`+`re`+`expect`,
`file_glob_dq`/`file_re_dq` (cho phép `*` ở thư mục); ca `tien_quyet` không PASS → ca sau NOT_RUN; `not_run` = lý do khóa trước).

Placeholder r13 (chú ý KHÁC r12): `{REPO}` repo · `{H}` = evidence/itacc_r13_docx12/harness · `{FX13}` =
evidence/itacc_r13_docx12/fixtures · `{H12}` = evidence/itacc_r12/harness · `{FX12}` = evidence/itacc_r12/fixtures ·
`{HF}`/`{FXF}` = harness/fixtures evidence/itacc_r12_fix_d2_l3 · `{FX10}` = evidence/itacc_r10 · `{OUT}` thư mục out của ca ·
`{SCR}` scratch của lượt chạy · `{sql:select ...}` = giá trị 1 ô. Tiêu chí chép từ r12/r12-fix: đổi `{H}` → `{H12}` (harness
r12), giữ `{FX12}`/`{HF}`/`{FXF}`. Bước gọi `python` → interpreter của runner; tệp `.py.txt` chạy được bằng `python <tệp>`.

Môi trường mỗi mục: DB MỚI `samsam_itacc_r13_<mã ngắn>` trên Postgres thử 127.0.0.1:55453, dựng bằng working tree hiện tại
(schema/roles ×2 + `ingest.core_store` + `ingest.golden_store`) — DB RỖNG nghiệp vụ ngoài golden/core thật của repo. Ca đầu
thường là seed `python -m pipelines.rollout --seed --by "Người Thử R13"` (tien_quyet). Env của bước: chỉ `DATABASE_URL` của DB
mục + `INTEL_HASH_SALT` + `CONTACT_VAULT_KEY` (runner tự nạp), `OPENROUTER_API_KEY` rỗng, KHÔNG AUTH_MODE/DEPLOY.

Luật (vi phạm = nháp không khóa được):
1. Trung thành: MỖI ca của bản ghi hiện hành (r10: `evidence/itacc_r10/items/<id>.json`; r12/r12-fix: tiêu chí đã khóa ghi trong
   đề bài) ↔ đúng 1 ca r13 (`nguon_r10` = mã ca cũ), cùng lệnh/đầu vào/kỳ vọng — dịch "expected" thành exit/regex/SQL/tệp KHÔNG
   nới. Lệnh r10 dùng harness r10 (`evidence/itacc_r10/gN/harness/*.py.txt`) và fixture r10 — đọc harness đó: nếu nó trỏ đường
   scratchpad r10 cố định / không chạy độc lập được thì viết bản chuyển MỚI dưới `evidence/itacc_r13_docx12/harness/` (ghi rõ
   chuyển từ đâu, đổi gì) — KHÔNG sửa tệp r10/r12. Fixture cần chép → `evidence/itacc_r13_docx12/fixtures/items/<id>/` (chép
   nguyên byte + `SHA256SUMS.txt` + `NGUON.txt`). Trạng thái DB mà r10 có sẵn từ ca của mục KHÁC (DB chung r10) → thêm ca tiền đề
   `nguon_r10: "MOI"` dựng lại tối thiểu (seed/nạp fixture), ghi lý do.
2. Ca cũ chứng minh "chặn an toàn khi chưa có provider" (OCR none, IMAGE_PROVIDER none, STT none, provider anchor none…) VẪN
   giữ (mặc định provider vẫn none). Ca MỚI cho mã r13 ghi `nguon_r10: "MOI_R13"` theo đặc tả trong đề bài.
3. Không chạy gì chạm DB, không kết nối DB, không chạy lệnh sản phẩm để "xem kết quả" (viết tiêu chí từ đọc mã). Được đọc mọi
   tệp. Không secret/credential thật; dữ liệu thử ghi rõ "Thử R13"/fixture.
4. Ca không chạy được trong môi trường này → `not_run` + lý do cụ thể (UI, server thật, repo riêng, cần model/vendor thật…).
5. Mỗi mục: `tieu_chi_cu_the` (T1…Tn, chép tiêu chí cũ + thêm tiêu chí r13 MỚI cho mã mới), `muc_kiem_de_xuat` LOCAL|MOCK|UI.
6. Đầu ra: `evidence/itacc_r13_docx12/criteria/drafts/r13_<nhom>.json` (cấu trúc `{"_doc", "items": [...]}` như r12, `db` mỗi
   mục duy nhất) + liệt kê tệp harness/fixture mới. Điều phối viên duyệt, sửa và khóa — người viết nháp KHÔNG khóa.
