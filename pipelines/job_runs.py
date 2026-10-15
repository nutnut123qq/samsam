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
  - v13.7 (F06): `python -m pipelines.job_runs --run <tên>` = wrapper lịch
    on-prem (systemd timer `deploy/onprem/systemd/`, lịch
    `deploy/onprem/jobs.json`): khóa file chống chạy chồng (bị khóa → dòng
    `job:<tên>` ok=false + exit 75, không chạy bước nào) + 1 dòng `job:<tên>`
    mỗi lần chạy. `--list` in lịch.
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


# ---------------------------------------------------------------- v13.7 lịch
# Wrapper DUY NHẤT cho job lịch trên server (systemd timer → `python -m
# pipelines.job_runs --run <tên>`): khóa file (flock/msvcrt — hệ điều hành
# tự nhả khi process chết, không có khóa mồ côi) chống chạy chồng khi lần
# trước còn chạy / timer bắn bù (Persistent) / người chạy tay cùng lúc; bị
# khóa → 1 dòng `job:<tên>` ok=false "chạy chồng — bỏ lượt" + exit 75, KHÔNG
# chạy bước nào. Mỗi bước chạy subprocess có timeout; chạy HẾT các bước,
# exit = mã lỗi đầu tiên ≠ 0.
JOBS_FILE = ROOT / "deploy" / "onprem" / "jobs.json"
LOCK_DIR_DEFAULT = ROOT / "data" / "job_locks"
STEP_TIMEOUT_S = 3 * 3600
EXIT_LOCKED = 75
_NAME_RE = re.compile(r"[a-z0-9_]{1,40}")


class JobConfigError(ValueError):
    """Lịch job thiếu/hỏng — không chạy gì."""


def load_jobs(path: Path | None = None) -> dict:
    """→ {tên: {"on_calendar", "max_gap_hours", "steps"}} đã kiểm: bước là
    `-m <module tồn tại>` hoặc `scripts/<file>.py` tồn tại."""
    p = Path(path) if path is not None else JOBS_FILE
    try:
        import json
        jobs = json.loads(p.read_bytes().decode("utf-8")).get("jobs")
    except (OSError, ValueError, AttributeError) as e:
        raise JobConfigError(f"{p.name} hỏng: {type(e).__name__}") from None
    if not isinstance(jobs, dict) or not jobs:
        raise JobConfigError(f"{p.name}: thiếu 'jobs'")
    out = {}
    for name, j in jobs.items():
        if not _NAME_RE.fullmatch(str(name)) or not isinstance(j, dict):
            raise JobConfigError(f"job '{name}': tên/cấu trúc sai")
        steps, gap = j.get("steps"), j.get("max_gap_hours")
        if (not isinstance(steps, list) or not steps or not all(
                isinstance(s, list) and s and all(isinstance(a, str)
                                                  for a in s)
                for s in steps)):
            raise JobConfigError(f"job '{name}': steps phải là list argv")
        if isinstance(gap, bool) or not isinstance(gap, int) or gap < 1:
            raise JobConfigError(f"job '{name}': max_gap_hours phải ≥ 1")
        if not isinstance(j.get("on_calendar"), str) or not j["on_calendar"]:
            raise JobConfigError(f"job '{name}': thiếu on_calendar")
        for s in steps:
            if s[0] == "-m":
                mod = s[1] if len(s) > 1 else ""
                target = ROOT / (mod.replace(".", "/") + ".py")
            else:
                target = ROOT / s[0]
                if not s[0].startswith("scripts/") or ".." in s[0]:
                    raise JobConfigError(f"job '{name}': script phải ở "
                                         "scripts/")
            if not target.is_file():
                raise JobConfigError(f"job '{name}': không có {target.name}")
        out[name] = {"on_calendar": j["on_calendar"], "max_gap_hours": gap,
                     "steps": steps}
    return out


@contextmanager
def _file_lock(path: Path):
    """Khóa độc quyền KHÔNG chờ → yield True (giữ khóa) | False (đang bị
    giữ). Nhả khi thoát hoặc khi process chết."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+b")  # noqa: SIM115 — giữ mở suốt thời gian khóa
    got = False
    try:
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            got = True
        except OSError:
            got = False
        yield got
    finally:
        if got:
            try:
                if os.name == "nt":
                    import msvcrt
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        fh.close()


def _lock_dir() -> Path:
    v = os.environ.get("JOB_LOCK_DIR")
    return Path(v).expanduser() if v else LOCK_DIR_DEFAULT


def run_scheduled(name: str, *, jobs: dict | None = None,
                  lock_dir: Path | None = None, runner=None) -> int:
    """Chạy 1 job lịch có khóa + ghi `job_runs` (`job:<tên>`) → exit code."""
    import subprocess
    jobs = jobs if jobs is not None else load_jobs()
    if name not in jobs:
        raise JobConfigError(f"không có job '{name}' trong lịch")
    runner = runner or subprocess.run
    lock = (lock_dir or _lock_dir()) / f"{name}.lock"
    with _file_lock(lock) as got:
        if not got:
            now = datetime.now(timezone.utc)
            _record(f"job:{name}", now, now, False,
                    "chạy chồng — lần trước còn đang chạy, bỏ lượt")
            _warn(f"job '{name}' đang chạy ở tiến trình khác — bỏ lượt")
            return EXIT_LOCKED
        rc_first, fails = 0, []
        with job_run(f"job:{name}") as jr:
            for i, step in enumerate(jobs[name]["steps"], 1):
                try:
                    rc = runner([sys.executable, *step], cwd=ROOT,
                                timeout=STEP_TIMEOUT_S).returncode
                except subprocess.TimeoutExpired:
                    rc = 124
                if rc != 0:
                    fails.append(f"bước {i} exit {rc}")
                    rc_first = rc_first or rc
            jr["ok"] = not fails
            jr["detail"] = "; ".join(fails) or None
        return rc_first


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m pipelines.job_runs",
                                 description="Chạy job lịch có khóa + ghi "
                                             "job_runs (deploy/onprem)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--run", metavar="TEN", help="chạy 1 job trong lịch")
    g.add_argument("--list", action="store_true", help="liệt kê lịch")
    args = ap.parse_args(argv)
    try:
        jobs = load_jobs()
        if args.list:
            for n, j in jobs.items():
                print(f"{n}: {j['on_calendar']} (hạn {j['max_gap_hours']}h) "
                      + " ; ".join(" ".join(s) for s in j["steps"]))
            return 0
        return run_scheduled(args.run, jobs=jobs)
    except JobConfigError as e:
        print(f"[err] lịch job: {e}", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
