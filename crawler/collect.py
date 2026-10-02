"""Entry point: `python -m crawler.collect` → ghi data/*.jsonl

Contract output (mỗi dòng JSONL = 1 record):
  products.jsonl : {"id","name","price_vnd"|null,"description","url","images":[url]}
  articles.jsonl : {"id","title","body","url","published_at"|null}
  about.jsonl    : {"id","title","body","url"}
  news.jsonl     : giống articles nhưng từ samsam.net.vn

Luật: delay ≥1s/request (CRAWL_DELAY_S), chỉ trang public, log ra stdout
để tee vào evidence/m1_crawl.log. Lỗi 1 item không được làm chết cả job —
ghi warning rồi chạy tiếp.
"""


def main() -> int:
    """Crawl tất cả SOURCES, ghi jsonl, return exit code."""
    raise NotImplementedError("T1.1/T1.2 — xem TASKS.md")


if __name__ == "__main__":
    raise SystemExit(main())
