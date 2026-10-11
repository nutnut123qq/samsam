"""Apply `docs/schema.sql` vào DB `DATABASE_URL` trong .env (idempotent).

Máy Windows này không có psql — psycopg `execute()` nhận multi-statement
khi không có params (precedent `demo.py:52`). An toàn chạy lại: schema
toàn `create table/index if not exists` + `create or replace function`,
không drop.

`search_path` đặt tường minh `public, pg_temp` trước khi chạy (v3.4):
function SECURITY DEFINER ghim search_path lúc tạo — pg_temp phải CUỐI.

Chạy:
  python scripts/apply_schema.py            # chỉ schema.sql
  python scripts/apply_schema.py --roles    # schema.sql rồi docs/roles.sql
In danh sách bảng public (+ role khi --roles); exit 1 nếu thiếu
DATABASE_URL hoặc không connect được.
"""

import argparse
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
ROLES = ("agent_writer", "app_human")
CONNECT_TIMEOUT_S = 5


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/apply_schema.py")
    ap.add_argument("--roles", action="store_true",
                    help="chạy thêm docs/roles.sql (role agent_writer/"
                         "app_human)")
    args = ap.parse_args(argv)
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    roles_sql = ((ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
                 if args.roles else None)
    try:
        with psycopg.connect(dsn, autocommit=True,
                             connect_timeout=CONNECT_TIMEOUT_S) as conn:
            conn.execute("set search_path to public, pg_temp")
            conn.execute(sql)
            if roles_sql:
                conn.execute(roles_sql)
            tables = [r[0] for r in conn.execute(
                "select table_name from information_schema.tables"
                " where table_schema = 'public'"
                " and table_type = 'BASE TABLE' order by 1")]
            roles = ([tuple(r) for r in conn.execute(
                "select rolname, rolcanlogin from pg_roles"
                " where rolname = any(%s) order by 1", (list(ROLES),))]
                if roles_sql else [])
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {e}")
        return 1
    print(f"[done] schema applied — {len(tables)} bảng public: "
          + ", ".join(tables))
    if roles_sql:
        print(f"[done] roles applied — {len(roles)} role: "
              + ", ".join(f"{n} (login={c})" for n, c in roles))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
