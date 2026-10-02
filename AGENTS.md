# samsam — Agent Guide

## Overview
Pilot "chuyển đổi số + AI" cho Công ty TNHH Sâm Sâm (sâm Ngọc Linh, Quảng Nam/Đà Nẵng).
Bản thu nhỏ của SOW (`SOW_SamSam_AI_6-thang.md`): crawl data public → knowledge base
→ chatbot RAG + content studio có guardrail pháp lý TPBVSK. Python 3.12 + Supabase
(Postgres+pgvector) + Claude/OpenAI API + Streamlit.

## Commands
| Việc | Lệnh |
|---|---|
| Setup | `pip install -r requirements.txt` |
| Crawl | `python -m crawler.collect` |
| Ingest | `python -m ingest.embed_store` |
| Demo UI | `streamlit run app/streamlit_app.py` |
| Test/lint | `pytest` · `ruff check .` |

## Structure
- `crawler/` — collect public site data → `data/*.jsonl`
- `ingest/` — chunk + embed + nạp pgvector
- `pipelines/` — content draft + guardrail check (claim whitelist + banned words)
- `app/` — Streamlit demo (2 tab: Chat, Content Studio)
- `data/` — jsonl dump, `claims_whitelist.json`, `banned_words.txt`
- `tests/` — pytest
- `TASKS.md` — task board M1–M4, boundary + gate + evidence từng task
- `SOW_SamSam_AI_6-thang.md` — hợp đồng draft là context gốc

## Invariants
- **Guardrail trước content**: mọi text AI sinh ra phải qua `pipelines.guardrail.check()` trước khi hiển thị/đăng.
- Chatbot trả lời phải kèm nguồn (URL); không bịa công dụng y tế.
- Từ cấm tuyệt đối trong output: "chữa", "điều trị", "thuốc", "khỏi bệnh" — list đầy đủ ở `data/banned_words.txt`.
- Tài khoản/keys đọc từ `.env`; secret không vào code/git.
- Crawl delay ≥1s/request, chỉ trang public.

## Conventions
- Tiếng Việt trong docstring/comment khi giải thích business; code English.
- JSONL 1 dòng = 1 record, schema định nghĩa trong docstring module sinh ra nó.
- Commit message ngắn, tiếng Việt hoặc Anh đều được, nói "why".

## Gotchas
- `samsam.net.vn` là NukeViet (HTML render phức tạp); `samsamngoclinh.com` là
  WooCommerce — **thử WP REST API `/wp-json/wp/v2/...` trước**, dễ hơn parse HTML.
- pgvector cần bật extension trên Supabase trước khi ingest.
- Nội dung sâm hay bị phóng đại trên web — guardrail phải filter cả data ingest.
