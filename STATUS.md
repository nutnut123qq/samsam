# STATUS — v1.0-live-prep (2026-10-07)

## v1.0 — plug-and-play khi có OA creds (contract trong DONE.md)

**6/6 mục xong, gate xanh.** `python -m pytest` 77/77, `ruff check .`
clean, `zalo_mock.py` 3/3 exit 0, `zalo_preflight.py` exit 1 báo đúng
mục thiếu trên dev. Reviewer FIX→PASS; cold-check auditor lạ chạy lại
toàn bộ gate: UNVERIFIED **chỉ** ở live Zalo contract (oauth refresh
v4, getoa, mã lỗi token, OA-secret signature) — theo thiết kế chờ creds
C2.0, verify lúc go-live bằng `scripts/zalo_preflight.py`.

### Đọc diff cần biết

- **`connectors/zalo.py`**: tách 2 secret — `OA_SECRET` (signature
  webhook) vs `APP_SECRET` (oauth refresh header `secret_key`).
  Token store `data/zalo_tokens.json` (gitignored, atomic write,
  chmod 600 POSIX) là source-of-truth sau refresh đầu; env chỉ seed.
  `refresh_access_token()` dưới `_token_lock` (rotation serialize);
  send-fail → refresh (throttle 60s — reviewer M3) → retry 1 lần;
  transport error không retry (tránh reply đôi). Non-text
  `user_send_*` → `NON_TEXT_TEXT` + convlog `answered:false`
  (`question=[non-text:<event[:50]>]`).
- **`scripts/zalo_preflight.py`** (mới): 5 check env/db/openrouter/
  token(getoa)/signature round-trip; `--refresh` ép rotation thật
  (reviewer M1); `check_env` mirror `_startup_error` đọc store.
- **`scripts/zalo_mock.py`**: `APP_SECRET`→`OA_SECRET` — mock verify
  signature thật lại.
- **`env.example`** (mới, tên không-dot — `.env*` bị write-policy
  chặn), **`docs/zalo-webhook.service`** (systemd mẫu — comment tách
  dòng riêng, systemd không hỗ trợ inline), **`docs/deploy.md`**
  rewrite: auto-refresh, HTTPS bắt buộc, go-live checklist.

### Evidence v1.0

| Mục | File |
|---|---|
| Gate chung | `evidence/v10_pytest.log` — 77/77 + ruff clean |
| Mock E2E | `evidence/v10_mock.log` — 3/3 |

---

# STATUS — v0.3-hardening (2026-10-04) + ca đêm M1→M4

## v0.3 — ops: log + eval + gate (contract trong DONE.md)

**6/6 mục xong, gate xanh.** `pytest` 29/29 (×3 lần, không flaky),
`ruff check .` clean, `eval_qa` 12/12 ×2 lần chạy thật, mock E2E 3/3.

```
(uncommitted) — chờ duyệt đóng version ở cửa người 2
```

### Đọc diff cần biết

- **`connectors/zalo.py`**: `_seen` dict → sqlite `data/zalo_seen.db`
  (lazy init — file chỉ sinh ở dedup đầu, không phải lúc import);
  `handle_text(u, q, msg_id="")` ghi `data/conversations.jsonl`
  {ts,msg_id,user_hash,question,answer[:500],sources,guardrail_ok,
  latency_ms,answered}. Dedup/non-text → không log. `answered` dùng
  `NO_DATA not in answer` — khớp semantics rag.py.
- **`scripts/eval_qa.py`** (mới): eval 12 câu questions.md — exit 0 iff
  ≥10/12 VÀ 2 bẫy pass. EXPECTED hardcode theo số câu; sanity check
  parse-vs-map bắt lệch file.
- **`scripts/zalo_mock.py`**: UTF-8 stdout guard — console Windows
  cp1258 crash khi in tiếng Việt; bỏ noqa E402 thừa (RUF100).
- **`tests/test_zalo.py`**: autouse fixture trỏ SEEN_DB/CONV_LOG →
  tmp_path; +3 case (persist-qua-restart, log schema, answered:false).
- **`.gitignore`**: +`data/conversations.jsonl`, +`data/zalo_seen.db`
  (runtime, có user_hash — không commit).
- Reviewer độc lập KHÔNG chạy được (hết quota subagent) — coordinator
  tự review: không blocker, 3 NIT đã ghi someday (convlog `sent`/
  crash-log/raw-flag, PII trong question, signature-bypass-khi-deploy).

### Evidence v0.3

| Mục | File |
|---|---|
| D3.2 eval | `evidence/v03_eval.log` — 12/12 |
| D3.3+D3.4 log | `evidence/v03_convlog.log` — mock + 3 dòng jsonl |
| D3.5+D3.6 gate | `evidence/v03_pytest.log` — 29/29 + ruff clean |

---

## Ca đêm M1→M4 (viết cho người đọc diff)

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
