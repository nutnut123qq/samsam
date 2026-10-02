"""Chay demo 1 lenh: python demo.py

Tu dong: check .env -> cai deps thieu -> tao schema + ingest neu DB trong
-> mo Streamlit. Yeu cau co san: Python 3.12+, PostgreSQL local dang chay,
file .env da dien OPENROUTER_API_KEY + DATABASE_URL (xem README).
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

ENV_REQUIRED = ("OPENROUTER_API_KEY", "DATABASE_URL")


def sh(args: list[str]) -> int:
    return subprocess.call([sys.executable, "-m", *args])


def ensure_env() -> None:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    missing = [k for k in ENV_REQUIRED if not os.environ.get(k)]
    if missing:
        sys.exit(
            f"[demo] .env thieu: {', '.join(missing)}\n"
            "  Tao .env theo mau trong README roi chay lai.")


def ensure_deps() -> None:
    try:
        import streamlit  # noqa: F401
    except ImportError:
        print("[demo] cai deps vao interpreter dang chay...")
        sh(["pip", "install", "-r", "requirements.txt"])


def ensure_db() -> None:
    import psycopg
    try:
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            n = conn.execute(
                "select count(*) from chunks").fetchone()[0]
    except psycopg.OperationalError as e:
        sys.exit(f"[demo] khong ket noi duoc Postgres: {e}\n"
                 "  Can Postgres local + DB 'samsam' (xem README phan DB).")
    except psycopg.errors.UndefinedTable:
        print("[demo] tao schema tu docs/schema.sql...")
        with psycopg.connect(os.environ["DATABASE_URL"],
                             autocommit=True) as conn:
            conn.execute((ROOT / "docs" / "schema.sql")
                         .read_text(encoding="utf-8"))
        n = 0
    if n == 0:
        print("[demo] DB trong -> ingest data/*.jsonl (co goi embed API)...")
        if sh(["ingest.embed_store"]):
            sys.exit("[demo] ingest loi — xem log tren.")
    else:
        print(f"[demo] DB san sang: {n} chunks.")


def main() -> None:
    ensure_env()
    ensure_deps()
    ensure_db()
    print("[demo] mo UI tai http://localhost:8501")
    sys.exit(subprocess.call(
        [sys.executable, "-m", "streamlit", "run", "app/streamlit_app.py",
         "--server.headless", "true"]))


if __name__ == "__main__":
    main()
