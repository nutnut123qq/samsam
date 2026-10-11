"""Lịch sử chạy job lịch (v3.7, F17.2) — bảng `job_runs`.

Contract:
  with job_run("agents.report") as run:
      rc = main()
      run["ok"] = rc == 0          # body tự đánh dấu lỗi khi exit code ≠ 0

  - Ghi ĐÚNG 1 INSERT lúc job kết thúc (started_at/finished_at UTC aware,
    host = socket.gethostname()). Process bị kill cứng → không có dòng →
    bản tin sức khỏe báo "không chạy/trễ" (ponytail, không cần dòng "đang
    chạy").
  - Exception trong body → ok=false, detail "<TênLỗi>: <msg>" qua
    `_mask_pii` + che URL/DSN + cắt 300 ký tự, rồi RE-RAISE nguyên
    exception. `SystemExit(0|None)` = ok; SystemExit khác 0 = lỗi.
  - Ghi lỗi (thiếu DSN / connect lỗi / insert lỗi) → in cảnh báo (KHÔNG in
    DSN), job vẫn chạy bình thường, exit code giữ nguyên.
"""

import os
import re
import socket
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
CONNECT_TIMEOUT_S = 5
DETAIL_MAX = 300
PRE_MAX = DETAIL_MAX * 4  # cắt trước regex (chống DoS)
# URL/DSN (có thể chứa user:pass), DSN libpq key=value (password=...),
# khóa API dạng sk-... / Bearer token.
_SECRET_RE = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+|\bsk-[\w-]{8,}"
                        r"|\bbearer\s+\S+|\bpass(?:word)?\s*=\s*\S+",
                        re.IGNORECASE)
_INSERT = ("insert into job_runs (job, started_at, finished_at, ok, detail,"
           " host) values (%s, %s, %s, %s, %s, %s)")


def _warn(msg: str) -> None:
    print(f"[job-runs] {msg}", flush=True)


def clean_detail(detail) -> str | None:
    """Mask SĐT/email + che URL/DSN/khóa API + cắt 300.

    Cắt PRE_MAX TRƯỚC regex: alt scheme của `_SECRET_RE` backtrack bậc 2
    trên run dài `a.a.a...` (64KB ~18s) mà str(exception) không giới hạn
    — chạy trong `finally` của job_run sẽ treo job. Mask làm chuỗi NGẮN
    lại (URL dài → `<secret>`) nên mép cắt có thể lọt vào 300 ký tự cuối:
    bỏ token dở ở mép (email/URL dở) + đuôi số/dấu (SĐT dở có khoảng).
    """
    if detail is None:
        return None
    s = str(detail)
    if len(s) > PRE_MAX:
        s = (s[:PRE_MAX].rsplit(None, 1) or [""])[0]
        s = s.rstrip("0123456789 .+-()")
    return _mask_pii(_SECRET_RE.sub("<secret>", s))[:DETAIL_MAX]


def _record(job, started, finished, ok, detail) -> None:
    try:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            _warn("không có DATABASE_URL — bỏ ghi job_runs")
            return
        conn = psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)
        try:
            conn.execute(_INSERT, (job, started, finished, ok, detail,
                                   socket.gethostname()))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 — ghi lịch sử không được phá job
        _warn(f"ghi job_runs lỗi ({type(e).__name__}) — job vẫn chạy bình "
              "thường")


@contextmanager
def job_run(job: str):
    run = {"ok": True, "detail": None}
    started = datetime.now(timezone.utc)
    try:
        yield run
    except SystemExit as e:
        if e.code not in (0, None):
            run["ok"] = False
            run["detail"] = run["detail"] or f"SystemExit: {e.code}"
        raise
    except BaseException as e:
        run["ok"] = False
        run["detail"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        _record(job, started, datetime.now(timezone.utc), bool(run["ok"]),
                clean_detail(run["detail"]))
