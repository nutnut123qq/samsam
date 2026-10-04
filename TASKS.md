# TASKS — Pilot board (M1–M4)

Quy ước: mỗi task có **owner / boundary / gate / evidence**. Junior chỉ đụng file
trong boundary. Xong = gate xanh + evidence file commit vào repo. Controller audit
evidence, không tin lời.

Status: `[ ]` todo · `[~]` doing · `[x]` done (kèm link evidence)

---

## M1 — Data pipeline (crawl → jsonl)

- [x] **T1.1 Crawl samsamngoclinh.com** (WooCommerce — ưu tiên `/wp-json/wp/v2/`, `wc/store/v1/products`)
  - Boundary: `crawler/collect.py`, `crawler/sources.py`, `data/products.jsonl`, `data/articles.jsonl`
  - Gate: `python -m crawler.collect` exit 0; ≥20 products đúng tên+giá; ≥20 articles
  - Evidence: `data/*.jsonl` + `evidence/m1_crawl.log` (stdout) — 27 products (18 wc + 9 shop net.vn; 15 có giá), 90 articles
- [x] **T1.2 Crawl samsam.net.vn** (NukeViet, fallback HTML parse)
  - Boundary: `crawler/sources.py`, `data/about.jsonl`, `data/news.jsonl`
  - Gate: ≥10 records có title+body+url
  - Evidence: jsonl + log — 4 about + 31 news (site chỉ chạy http, sitemap làm entry)
- [x] **T1.3 Claims whitelist** — trích công dụng ĐÃ CÔNG BỐ từng SKU từ text crawl được
  - Boundary: `data/claims_whitelist.json`, `data/banned_words.txt`
  - Gate: mọi SKU trong products.jsonl có entry claims (hoặc "chưa có công bố — không suy diễn")
  - Evidence: 2 file data — 10 SKU: 6 TPBVSK có CÔNG DỤNG+ĐKSP, 4 (rượu/củ) chưa có công bố
- [x] **T1.4 Mở rộng M1b** — thêm hệ thống phân phối (13 điểm) + cẩm nang sâm (10 bài)
  - Boundary: `crawler/`, `data/`, `evidence/` (không đụng ingest/ — gộp articles/news)
  - Gate: collect exit 0, jsonl +23 records, bot trả được địa chỉ showroom kèm nguồn
  - Evidence: `evidence/m1b_crawl.log` — articles 90→103, news 31→41; hỏi "Sâm Sâm có showroom ở đâu" → "425 Phan Bội Châu, phường Bàn Thạch, Thành Phố Đà Nẵng" + nguồn he-thong-phan-phoi
  - Lý do gộp: schema `{id,title,body,url,published_at}` khớp articles; REST `wp/v2/he-thong-phan-phoi` chỉ trả title (acf rỗng, detail page 301 về home) → render listing Bricks AJAX bằng playwright, ghi record `dist-*` vào `articles.jsonl`; camnang = bài nv_article thường → `news.jsonl`. KHÔNG crawl slider-home/videos/phan-hoi.

## M2 — Knowledge base + chatbot RAG

- [x] **T2.1 Postgres local schema + ingest** (`createdb samsam` + chạy `docs/schema.sql`, bảng `chunks`)
  - Boundary: `ingest/`, `docs/schema.sql`
  - Gate: `python -m ingest.embed_store` nạp hết jsonl, `select count(*)` đúng
  - Evidence: `evidence/m2_ingest.log` — 816 chunks / 153 docs; thêm cột `lang` (audit M1: EN/VI dupes) + doc `catalog-products` tổng hợp
- [x] **T2.2 Chat UI** — hỏi/đáp kèm link nguồn
  - Boundary: `app/streamlit_app.py` (tab Chat), `api/rag.py` nếu cần tách
  - Gate: **8/10 câu hỏi test** (`tests/questions.md`) trả đúng + có nguồn
  - Evidence: `evidence/m2_qa.md` ghi 10 Q/A thật, ảnh màn hình `evidence/m2_chat.png` — 10/10 + 2/2 câu bẫy

## M3 — Content Studio + guardrail

- [x] **T3.1 Guardrail** — `check(text) -> {ok, violations[], matched_claims[]}`
  - Boundary: `pipelines/guardrail.py`, `tests/test_guardrail.py`
  - Gate: pytest xanh; chặn đúng case "chữa khỏi tiểu đường" trong test
  - Evidence: `evidence/m3_pytest.log` — 13/13 passed; match có dấu + không dấu, approved claim miễn banned span con ("hỗ trợ hạ đường huyết" pass), "thuộc" không bị bắt nhầm "thuốc"; vá lỗ hổng mệnh đề ghép (claim đúng + claim bịa nối "và" → flag)
- [x] **T3.2 Draft pipeline** — ý tưởng → bài FB → qua guardrail → hiển thị violations
  - Boundary: `pipelines/content.py`, tab Content Studio trong `app/`
  - Gate: sinh được bài; bài cố tình vi phạm bị flag đỏ
  - Evidence: `evidence/m3_studio.png` — draft PASS xanh + text "chữa khỏi tiểu đường" flag đỏ 7 violations; `content.draft()` có 1 lượt rewrite-khi-vi phạm rồi check() lại trước khi trả

## M4 — Đóng gói demo

- [x] **T4.1** README chạy 1 lệnh; video quay ≤3 phút demo chat + guardrail
  - Evidence: `evidence/demo.mp4` (38s — chat trả giá kèm nguồn → Studio draft PASS → text vi phạm flag đỏ); `python demo.py` verify chạy được trên máy này (máy sạch cần Python + Postgres + .env — NEEDS-INPUT: chưa có máy sạch để verify)

## M5 — Connector v0.2 (Zalo OA bot)

Checklist/DoD chi tiết: `DONE.md` mục v0.2-connector. Quy ước: "CODE xong"
≠ "PLATFORM duyệt" — không task nào treo chờ sàn.

- [~] **C2.0 Platform prep** — submit Zalo OA webhook app + Shopee/TikTok
  dev app NGÀY 1 (chạy nền, duyệt 1–2 tuần)
  - Evidence: `evidence/v02_platform.md` — NEEDS-INPUT: owner submit trên
    console sàn (agent không tạo tài khoản ngoài)
- [x] **C2.1 Zalo webhook server** — `python -m connectors.zalo` :8788
  - Boundary: `connectors/`, `tests/test_zalo.py` (stdlib http.server +
    httpx có sẵn — 0 dep mới)
  - Gate: verify `X-ZEvent-Signature` (sha256 spec Zalo), dedup msg_id
    chống retry nhân đôi, ACK 200 nhanh + reply async thread
    (answer() ~10s không block webhook)
  - Evidence: `evidence/v02_pytest.log` — 11 case: signature ok/bad,
    dedup, non-text ignore, ACK <1s khi reply sleep 2s
- [x] **C2.2 Reply pipeline** — event → `answer()` → guardrail → send API
  - Boundary: `connectors/zalo.py` (reuse `api/rag.py` + `guardrail.py`
    nguyên trạng — không đụng)
  - Gate: mọi outbound qua `check()`; flag → FALLBACK hotline thay text
    vi phạm; reply kèm "Nguồn: <url>"
  - Evidence: `evidence/v02_pytest.log` — 3 case pipeline mock
- [x] **C2.3 Mock E2E** — `scripts/zalo_mock.py` replay ≥3 hội thoại
  - Evidence: `evidence/v02_zalo_mock.log` — 3/3 đúng end-to-end: giá
    Saphraton 2 quy cách + nguồn · showroom "425 Phan Bội Châu" + nguồn ·
    câu bẫy "Chưa đủ dữ liệu để trả lời."
- [x] **C2.4 Human-gate** — `connectors/` không có endpoint đăng
  bài/listing mới (verify bằng diff: chỉ nhận/reply)
- [x] **C2.5 Gate + docs** — pytest 26/26, ruff clean; `python demo.py`
  verify :8501 HTTP 200; AGENTS.md thêm lệnh webhook + mock

---

## Lề (không đụng trong pilot)
Messenger integration, agent vườn, dashboard, training, deploy public, auth.
