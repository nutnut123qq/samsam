"""Apply `docs/schema.sql` vào DB `DATABASE_URL` trong .env (idempotent).

Máy Windows này không có psql — psycopg `execute()` nhận multi-statement
khi không có params (precedent `demo.py:52`). An toàn chạy lại: schema
toàn `create table/index if not exists`, không drop.

Chạy: `python scripts/apply_schema.py` — in danh sách bảng public sau
apply; exit 1 nếu thiếu DATABASE_URL hoặc không connect được.
"""

import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(sql)
            tables = [r[0] for r in conn.execute(
                "select table_name from information_schema.tables"
                " where table_schema = 'public' order by 1")]
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {e}")
        return 1
    print(f"[done] schema applied — {len(tables)} bảng public: "
          + ", ".join(tables))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
