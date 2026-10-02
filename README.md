# samsam — Pilot chuyển đổi số + AI cho Công ty TNHH Sâm Sâm

Pilot thu nhỏ của SOW 6 tháng (`SOW_SamSam_AI_6-thang.md`), dùng data public từ
website công ty để demo trước khi ký hợp đồng.

## Setup

```bash
python -m venv .venv
source .venv/Scripts/activate      # Git Bash — cmd thì .venv\Scripts\activate
pip install -r requirements.txt
```

Tự tạo file `.env` (KHÔNG commit) — chỉ cần **1 key OpenRouter** (chat + embedding
đều qua nó) + Postgres local:

```
OPENROUTER_API_KEY=sk-or-...     # https://openrouter.ai/keys
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/samsam
OR_CHAT_MODEL=openai/gpt-4o-mini
OR_EMBED_MODEL=openai/text-embedding-3-small
```

DB: cài PostgreSQL trên máy (nếu chưa có: installer EDB), tạo DB
`createdb samsam` (hoặc pgAdmin) — schema tự tạo khi chạy demo.

## Chạy — 1 lệnh

```bash
python demo.py
```

Script tự: check `.env` → cài deps còn thiếu → tạo schema + ingest
`data/*.jsonl` nếu DB trống → mở Streamlit tại http://localhost:8501.
(Chạy lần đầu bằng `.venv/Scripts/python.exe demo.py` nếu chưa activate venv.)

## Chạy từng bước (dev)

```bash
python -m crawler.collect          # M1: crawl site → data/*.jsonl
python -m ingest.embed_store       # nạp vào Postgres (bảng chunks)
streamlit run app/streamlit_app.py # M2/M3: demo chatbot + content studio
pytest                             # gate
ruff check .                       # lint
```

## Luật

- Junior chỉ đụng file trong boundary của task đang nhận (xem TASKS.md).
- Không commit `.env`, không hard-code key.
- Crawl chỉ trang public, delay ≥1s giữa request.
- Không ghi đè contract trong docstring stub khi chưa đổi TASKS.md.
