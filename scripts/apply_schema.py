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
  python scripts/apply_schema.py --pgvector # schema.sql rồi (nếu Postgres
                                            # có extension `vector`)
                                            # docs/schema_pgvector.sql
In danh sách bảng public (+ role khi --roles); exit 1 nếu thiếu
DATABASE_URL hoặc không connect được.

v10.3 `--pgvector`: schema.sql vẫn apply như cũ, rồi kiểm
`pg_available_extensions` có `vector` → apply `schema_pgvector.sql` (THÊM
cột `embedding_v` + trigger + index HNSW, giữ `embedding float8[]`); không
có → `[external-dep]` exit 3, KHÔNG đụng gì thêm (backend RAG giữ float8).
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
    ap.add_argument("--pgvector", action="store_true",
                    help="thêm docs/schema_pgvector.sql nếu Postgres có "
                         "extension vector (thiếu → exit 3)")
    args = ap.parse_args(argv)
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    roles_sql = ((ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
                 if args.roles else None)
    pgv_sql = ((ROOT / "docs" / "schema_pgvector.sql").read_text(
        encoding="utf-8") if args.pgvector else None)
    pgv_missing = False
    try:
        with psycopg.connect(dsn, autocommit=True,
                             connect_timeout=CONNECT_TIMEOUT_S) as conn:
            conn.execute("set search_path to public, pg_temp")
            conn.execute(sql)
            if roles_sql:
                conn.execute(roles_sql)
            if pgv_sql:
                pgv_missing = conn.execute(
                    "select count(*) from pg_available_extensions"
                    " where name = 'vector'").fetchone()[0] == 0
                if not pgv_missing:
                    conn.execute(pgv_sql)
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
    if pgv_sql:
        if pgv_missing:
            print("[external-dep] Postgres chưa cài pgvector — giữ backend "
                  "float8 (schema.sql đã apply; cài extension cần quyền "
                  "superuser/nhà cung cấp cloud).")
            return 3
        print("[done] pgvector applied — chunks/chunks_internal.embedding_v "
              "+ trigger đồng bộ + index HNSW (float8[] giữ nguyên)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
