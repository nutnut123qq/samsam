# STATUS — ca đêm M1→M4 (viết cho người đọc diff)

## Kết quả

**M1–M4 hoàn tất, 4 commit mới, gate xanh.** `pytest` 11/11, `ruff check .` clean.

```
f035812 T4.1: demo.py 1-lenh (env+deps+db+streamlit) + video demo.mp4 38s + script quay
54bc05f T3.2: content.draft() qua OpenRouter + Content Studio tab; guardrail them claim-core match + disclaimer TPBVSK exemption
85ae7b7 T3.1: guardrail 2 lop — banned words (co dau + viet tran) + claim whitelist theo SKU
a6f28fe M2: ingest 816 chunks vao Postgres + chat RAG kem nguon   (ca truoc)
eb5fab7 M1: crawl 2 site public -> jsonl + claims whitelist        (ca truoc)
```

## Đọc diff đêm nay cần biết

**`pipelines/guardrail.py`** (T3.1 + 2 vá trong T3.2):
- Match banned words cả có dấu lẫn viết trần; span không dấu chỉ flag khi
  text gốc cũng viết trần → "thuộc" (belong) không bị bắt nhầm "thuốc".
- Approved claim là "vùng an toàn": banned span con trong claim đã công bố
  (vd "hỗ trợ hạ đường huyết" ⊃ "hạ đường huyết") không flag.
- `SAFE_PHRASES`: disclaimer pháp lý bắt buộc TPBVSK ("không phải là
  thuốc", "thay thế thuốc chữa bệnh") chứa từ cấm theo nghĩa phủ định →
  miễn. Nếu không có exemption này, mọi bài hợp lệ đều bị flag.
- Claim match theo SKU được nhắc trong text; không nhắc → pool tất cả SKU.
  Claim "cùng ý" (khác động từ dẫn hỗ trợ/giúp) match qua claim-core;
  substance phải nguyên văn → "tăng cường trí nhớ" vẫn flag.
- Clause có claim-verb mà không khớp whitelist → `unverified_claim`.

**`pipelines/content.py`**: draft() gọi OpenRouter (OR_CHAT_MODEL), system
prompt nhét whitelist + luật TPBVSK; vi phạm → 1 lượt rewrite có feedback
rồi check() lại; trả {"text","guardrail"} — text luôn đã qua check().

**`app/streamlit_app.py`**: tab Content Studio = brief + kênh → draft →
hiển thị text + guardrail (violations đỏ, matched_claims caption) + ô
"check text có sẵn" chạy guardrail trực tiếp. Draft persist trong
session_state để còn nhìn khi rerun.

**`demo.py`** (T4.1): 1 lệnh = check .env → pip deps thiếu → tạo schema +
ingest nếu `chunks` trống → `streamlit run`. Verify thật trên máy này:
DB 816 chunks sẵn → skip ingest → UI lên :8501 HTTP 200.

**`requirements.txt`**: thêm playwright + imageio-ffmpeg dưới comment
"chi can khi quay lai video demo".

## Evidence

| Task | File | Nội dung |
|---|---|---|
| T3.1 | `evidence/m3_pytest.log` | 11/11 pass gồm case "chữa khỏi tiểu đường" |
| T3.2 | `evidence/m3_studio.png` | Draft PASS xanh + text vi phạm flag đỏ 7 violation |
| T4.1 | `evidence/demo.mp4` | 38s: chat trả giá Saphraton kèm nguồn → Studio draft PASS → "chữa khỏi tiểu đường" flag đỏ |

## NEEDS-INPUT / lưu ý review

- **"README verify trên máy sạch"** — chỉ verify được trên máy này
  (`.venv` + Postgres + `.env` có sẵn). Máy sạch cần: Python 3.12,
  PostgreSQL local, `.env` 2 key. Chưa test được path cài mới 100%.
- Guardrail heuristic ở lớp claim — đủ cho demo; sản xuất cần review bằng
  người/LLM-check nếu dùng thật.
- `git push` chưa chạy (theo luật). DB chỉ ghi vào `samsam` local.
