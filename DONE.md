# Done — samsam pilot

Khán giả/mục đích: **bác Lực / Sâm Sâm trong buổi gặp sắp tới** — demo bằng chứng
"team làm được", làm đà đàm phán hợp đồng số hóa + AI 1 tỷ. *(giả định từ context —
sửa nếu sai)*

Version đang mở: **v0.1-pilot** — demo chạy được trên data public, mang đi trình diễn.

## Checklist v0.1-pilot

- [ ] `python -m crawler.collect` exit 0; `data/products.jsonl` ≥20 dòng đúng tên+giá; `data/articles.jsonl` ≥20 dòng — *(evidence: file + `evidence/m1_crawl.log`)*
- [ ] `python -m ingest.embed_store` nạp hết vào Postgres `samsam.chunks` — *(evidence: `evidence/m2_ingest.log` + select count khớp)*
- [ ] Chatbot trả đúng ≥8/10 câu `tests/questions.md` + 2 câu bẫy từ chối đúng, mọi câu kèm URL nguồn — *(evidence: `evidence/m2_qa.md` + `m2_chat.png`)*
- [ ] Content Studio sinh được bài FB và guardrail tô đỏ bài cố tình vi phạm — *(evidence: `evidence/m3_studio.png` 2 case + `m3_pytest.log`)*
- [ ] `pytest` + `ruff check .` xanh
- [ ] Video demo ≤3 phút 1 mạch: chat + guardrail — *(evidence: `evidence/demo.mp4` hoặc link)*

## Someday (chưa vào version nào)

- Chatbot production trên Fanpage/Zalo OA (Messenger API, Pancake hook)
- Agent vận hành vườn + agent báo cáo định kỳ
- Dashboard số liệu kênh
- Hồ sơ công bố SKU thật thay claims_whitelist tự trích
- TikTok pipeline, media generation (ảnh/video/avatar)
- Training package + playbook nhân viên
- Deploy public + auth
- pgvector (hiện float8[] + numpy)

## Lịch sử version

| Version | Đích | Đóng lúc | Evidence |
|---|---|---|---|
