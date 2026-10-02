# samsam — Pilot chuyển đổi số + AI cho Công ty TNHH Sâm Sâm

Pilot thu nhỏ của SOW 6 tháng (`SOW_SamSam_AI_6-thang.md`), dùng data public từ
website công ty để demo trước khi ký hợp đồng.

## Setup

```bash
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

Tự tạo file `.env` (KHÔNG commit) với các biến:

```
ANTHROPIC_API_KEY=    # Claude — sinh nội dung + trả lời chat
OPENAI_API_KEY=       # embeddings
SUPABASE_URL=         # Postgres+pgvector hosted
SUPABASE_KEY=
```

## Chạy

```bash
python -m crawler.collect          # M1: crawl site → data/*.jsonl
python -m ingest.embed_store       # nạp vào pgvector
streamlit run app/streamlit_app.py # M2/M3: demo chatbot + content studio
pytest                             # gate
ruff check .                       # lint
```

## Luật

- Junior chỉ đụng file trong boundary của task đang nhận (xem TASKS.md).
- Không commit `.env`, không hard-code key.
- Crawl chỉ trang public, delay ≥1s giữa request.
- Không ghi đè contract trong docstring stub khi chưa đổi TASKS.md.
