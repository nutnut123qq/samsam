# Tiêu chí kiểm lại r12 — định dạng và luật (đọc TRƯỚC khi viết)

Mỗi nhóm viết **một** tệp `evidence/itacc_r12/criteria/r12_<nhom>.json`, khóa bằng
`r12_<nhom>.lock.txt` (một dòng: `<tên tệp> <sha256> <thời điểm ISO>`), rồi mới chạy
`python -I evidence/itacc_r12/harness/runner_r12.py.txt <criteria> <lock> <item_id> <env_file>`.
Runner từ chối chạy nếu sha256 ≠ khóa hoặc DB không phải DB của mục.

## Cấu trúc
```json
{"_doc": "...", "fingerprint_code": "<fp_r12 lúc khóa>", "moi_truong": "...",
 "items": [{"id": "<id>", "db": "samsam_itacc_r12_<mã ngắn>",
            "tieu_chi_cu_the": ["T1 ...", "T2 ...", "T3 ...", "T4 ..."],
            "ca": [{"ma": "<id>__C01", "nguon_r10": "C01", "mo_ta": "...", "tien_quyet": false,
                    "buoc": [{"argv": ["python", "-m", "agents.x", "--y", "{FX12}/items/<id>/f.csv"],
                              "env": {"BIEN": "giá trị" | null}, "stdin": "{FX12}/...",
                              "expect_exit": 0 | [0, 2], "stdout_re": "...", "stderr_re": "...", "out_re": "..."}],
                    "kiem": [{"sql": "select ...", "expect": 3},
                             {"file_glob": "{OUT}/ceo-*.md", "count": 1},
                             {"file_re": "{OUT}/ceo-*.md", "re": "CHẠY THỬ", "expect": true}]},
                   {"ma": "<id>__C09", "nguon_r10": "C09", "mo_ta": "...", "not_run": "lý do (khóa trước)"}]}]}
```
Placeholder: `{REPO}` repo, `{FX12}` evidence/itacc_r12/fixtures, `{FX10}`/`{FX11}` evidence r10/r11 (chỉ ĐỌC),
`{H}` evidence/itacc_r12/harness, `{OUT}` thư mục out của ca, `{SCR}` scratch của lượt chạy, `{sql:select ...}` giá trị
1 ô. Bước fake AI ở biên cuối: `["python", "{H}/wrap.py.txt", "-m", "<module>", ...]` + `env` `PROBE_ROOT: "{REPO}"`,
`PROBE_LLM_RESPONSES` (JSON list chuỗi) — wrap chặn mạng ngoài localhost, đếm lời gọi vào `PROBE_LLM_LOG` nếu đặt.

## Luật (vi phạm = tiêu chí không dùng được)
1. **Trung thành với ca đã khóa của lượt trước** (bản ghi hiện hành theo `evidence/itacc_r11/source_map.json`):
   mỗi ca cũ có đúng 1 ca r12 (`nguon_r10`), cùng lệnh/đầu vào (đường dẫn fixture đổi sang bản CHÉP trong
   `{FX12}/items/<id>/`, giữ nguyên nội dung + ghi sha256 vào `evidence/itacc_r12/fixtures/items/<id>/SHA256SUMS.txt`),
   cùng kỳ vọng — dịch câu "expected" thành exit/regex/SQL/tệp **không nới**. Ca cũ FAIL vì lỗi đã vá: kỳ vọng là
   hành vi ĐÚNG như tiêu chí cũ đã viết (không phải hành vi thực tế cũ). Được THÊM ca (ghi `nguon_r10: "MOI"`),
   không được bỏ ca; ca không chạy được → `not_run` + lý do.
2. Viết xong → khóa → **dừng, không sửa tiêu chí sau khi đã thấy kết quả chạy**. Lỗi harness thật (đường dẫn fixture
   sai, thiếu bước seed) → tệp MỚI `r12_<nhom>_v2.json` + khóa mới + ghi lý do trong `_doc`; lượt hỏng giữ nguyên.
3. Mỗi mục 1 DB riêng, dựng bằng `bash evidence/itacc_r12/harness/mkdb_r12.sh.txt /d/code/samsam <db> <admin_env>
   <env_out> evidence/itacc_r12/runs/dung_db_<db>.txt` (schema/roles ×2 + core + golden). Ca đầu thường là seed
   `python -m pipelines.rollout --seed --by "Người Thử R12"` (tien_quyet).
4. KHÔNG dùng DB `samsam`, KHÔNG đọc/sửa `.env`, KHÔNG dùng owner để chứng minh luồng quyền của app (luồng quyền
   dùng login thật `in role app_human/svc_ui` tạo trong ca và DROP cuối ca), KHÔNG cấp quyền rộng, KHÔNG điền
   approver/quyết định pháp lý, KHÔNG sửa mã sản phẩm/test, KHÔNG commit/push. Không secret trong argv/log/evidence.
5. Ca UI (Streamlit/trình duyệt) → `not_run: "UI — xem evidence/itacc_r12/ui/ui_sau_*"`; điều phối viên ghép kết quả UI
   thật.
