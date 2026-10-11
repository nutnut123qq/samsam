"""W35.4 — Cổng deploy theo commit SHA (F17.1). CHỈ IN kế hoạch, không
chạy lệnh nào, không SSH.

Cho phép (exit 0) khi ĐỦ cả 4:
  1. SHA đủ 40 hex.
  2. Với MỌI agent trong `required_agents` (data/eval/config.json), row
     `eval_runs` MỚI NHẤT (ts, rồi id) của đúng SHA có passed=true — PASS
     cũ rồi FAIL sau -> từ chối; row '<sha>-dirty' không bao giờ khớp.
     `required_agents` rỗng/thiếu -> từ chối (fail-closed, không bỏ qua
     bước eval).
  3. `--approved-by` thuộc `approvers` (casefold/strip). approvers rỗng ->
     từ chối (danh sách người duyệt thật là external-dep) — KHÔNG tự coi
     ai đã duyệt.
  4. Luật đóng băng (đã nối v4.0): `pipelines.freeze.check(kind, now)`
     với kind "hotfix" (`--hotfix`) hoặc "feature" — lịch DUY NHẤT
     `data/freeze_calendar.json` (21/12/2026–10/02/2027, gồm 2 đầu, giờ
     Asia/Saigon) + break-glass còn hạn (env `BREAK_GLASS_LOG`, ghi bởi
     `scripts/break_glass.py`). Lịch hỏng → fail-closed (feature bị chặn,
     hotfix qua). Hotfix/break-glass vẫn cần đủ 1–3.
     Mốc thời gian: không `--today` → giờ THẬT (cửa sổ break-glass mở
     14:00 phải có hiệu lực lúc 15:00); `--today` → 12:00 VN ngày đó
     (mô phỏng theo ngày, không mô phỏng giờ).
Thiếu điều kiện -> exit 1, in TỪNG lý do. DB lỗi/down -> từ chối
(fail-closed, connect_timeout). Tham số sai (--today) -> exit 2.

Chạy: `python scripts/deploy_gate.py --sha <SHA> --approved-by "<tên>"
[--hotfix] [--today YYYY-MM-DD]`.
"""

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, time
from pathlib import Path

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # chạy `python scripts/deploy_gate.py`
from pipelines import freeze
from pipelines.freeze import VN_TZ

CONFIG = ROOT / "data" / "eval" / "config.json"
SHA_RE = re.compile(r"[0-9a-f]{40}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
CONNECT_TIMEOUT_S = 5
BASE = "/opt/samsam"
RELEASES = f"{BASE}/releases"
SHARED = f"{BASE}/shared"
# File runtime gitignored mà connectors/zalo.py ghi ở ROOT/data/.
STATE_FILES = ("zalo_tokens.json", "zalo_seen.db*", "conversations.jsonl*")


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("thiếu DATABASE_URL")
    return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)


def latest_runs(sha: str) -> dict[str, bool]:
    """{agent: passed} của row MỚI NHẤT (ts, id) cho đúng commit_sha."""
    conn = _connect()
    try:
        rows = conn.execute(
            "select commit_sha, agent, passed, ts, id from eval_runs"
            " where commit_sha = %s", (sha,)).fetchall()
    finally:
        conn.close()
    best: dict[str, tuple] = {}
    for commit_sha, agent, passed, ts, id_ in rows:
        if commit_sha != sha:
            continue
        if agent not in best or (ts, id_) > best[agent][:2]:
            best[agent] = (ts, id_, passed)
    return {a: v[2] is True for a, v in best.items()}


def _parse_day(s: str) -> date:
    if not DATE_RE.fullmatch(s):
        raise ValueError(s)
    return date.fromisoformat(s)


def check(sha: str, approved_by: str, hotfix: bool, today: date,
          cfg: dict, now: datetime | None = None,
          notices: list[str] | None = None) -> list[str]:
    """Trả list lý do từ chối (rỗng = cho phép). `now` None → 12:00 VN
    của `today` (mô phỏng `--today`). `notices` (tùy chọn) nhận lý do
    freeze CHO QUA nhưng bất thường (hotfix/break-glass trong đóng băng,
    lịch hỏng) để main in `[warn]` — bypass không được câm."""
    reasons = []
    if not SHA_RE.fullmatch(sha):
        reasons.append(f"SHA {sha!r} không phải commit 40 hex")
    else:
        try:
            runs = latest_runs(sha)
        except (psycopg.Error, OSError, RuntimeError) as e:
            runs = None
            reasons.append(f"DB lỗi ({type(e).__name__}) — không đọc được"
                           " eval_runs, từ chối (fail-closed)")
        required = cfg.get("required_agents") or []
        if not required:
            reasons.append("config không có required_agents — từ chối"
                           " (fail-closed)")
        if runs is not None:
            for agent in required:
                if agent not in runs:
                    reasons.append(f"agent {agent}: chưa có eval_runs cho"
                                   " SHA này")
                elif not runs[agent]:
                    reasons.append(f"agent {agent}: lần eval mới nhất FAIL")
    approvers = {a.strip().casefold() for a in cfg.get("approvers", [])
                 if a.strip()}
    who = approved_by.strip().casefold()
    if not approvers:
        reasons.append("danh sách người duyệt chưa được công ty cấp"
                       " (external-dep) — không ai duyệt được")
    elif not who:
        reasons.append("thiếu --approved-by (phiếu duyệt)")
    elif who not in approvers:
        reasons.append(f"{approved_by.strip()!r} không thuộc danh sách"
                       " người duyệt")
    if now is None:
        now = datetime.combine(today, time(12), VN_TZ)
    try:
        ok, why = freeze.check("hotfix" if hotfix else "feature", now)
    except ValueError as e:  # lịch thiếu kind hotfix/feature → fail-closed
        ok, why = False, f"lịch đóng băng lỗi ({e}) — fail-closed"
    if not ok:
        reasons.append(f"{why} (--hotfix hoặc break-glass)")
    elif notices is not None and why != freeze.OUTSIDE_FREEZE:
        notices.append(why)
    return reasons


def plan(sha: str, approved_by: str, hotfix: bool) -> str:
    """Kế hoạch cho người vận hành. State runtime của zalo (token store
    rotate, dedup seen.db, convlog) nằm ở `ROOT/data/` của release đang
    chạy -> CHUYỂN (mv, service đã dừng) sang release mới, không symlink
    từng file: `os.replace`/`rename` của token store + rotate convlog sẽ
    thay chính symlink bằng file thường trong release. `.env` chỉ đọc ->
    symlink từ thư mục shared."""
    rel = f"{RELEASES}/{sha}"
    cur = f"{BASE}/current"
    state = " ".join(f"$PREV/data/{f}" for f in STATE_FILES)
    back = " ".join(f"{rel}/data/{f}" for f in STATE_FILES)
    tag = " (HOTFIX)" if hotfix else ""
    return "\n".join([
        (f"[plan] deploy {sha}{tag} — duyệt bởi {approved_by.strip()!r}."
         " KHÔNG chạy gì — người vận hành làm tay:"),
        (f"  0. PREV=$(readlink -f {cur})  (release đang chạy; lần đầu:"
         f" đặt .env thật vào {SHARED}/.env)"),
        f"  1. git clone/fetch rồi checkout {sha} vào {rel}",
        (f"  2. python3.12 -m venv {rel}/.venv && {rel}/.venv/bin/pip"
         f" install -r {rel}/requirements.txt  (cài sạch, không dùng lại"
         " venv cũ)"),
        (f"  3. ln -sfn {SHARED}/.env {rel}/.env  (.env dùng chung — unit"
         f" EnvironmentFile={cur}/.env vẫn đúng sau khi đổi symlink)"),
        (f"  4. systemctl stop zalo-webhook && mv {state} {rel}/data/"
         "  (state runtime: refresh token rotate, dedup, convlog — file"
         " chưa có thì bỏ qua)"),
        f"  5. ln -sfn {rel} {cur} && systemctl start zalo-webhook",
        (f"  6. smoke: curl -fsS http://127.0.0.1:8788/healthz && cd {cur}"
         " && .venv/bin/python scripts/agent_eval.py --agent chatbot"
         " --no-record  (FAIL -> Rollback ngay)"),
        f"  7. ghi guardrail_ver={sha} (hậu kiểm F17.5 dùng đúng bản này)",
        (f"  8. giữ 10 release mới nhất trong {RELEASES}, xoá bản cũ hơn"
         " (state đã chuyển sang release đang chạy, bản cũ không còn"
         " token/convlog)"),
        (f"  Rollback: systemctl stop zalo-webhook && mv {back} $PREV/data/"
         f" && ln -sfn $PREV {cur} && systemctl start zalo-webhook"
         "  (mang state theo — refresh token cũ đã vô hiệu sau rotate)"),
    ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--sha", required=True)
    ap.add_argument("--approved-by", default="")
    ap.add_argument("--hotfix", action="store_true")
    ap.add_argument("--today", help="YYYY-MM-DD (mặc định hôm nay"
                    " Asia/Saigon) — mô phỏng ngày")
    args = ap.parse_args(argv)
    now = None  # --today → mốc 12:00 VN của ngày đó (trong check)
    try:
        if args.today:
            today = _parse_day(args.today)
        else:
            now = datetime.now(VN_TZ)
            today = now.date()
    except ValueError:
        ap.error("--today phải dạng YYYY-MM-DD hợp lệ")

    load_dotenv(ROOT / ".env")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    sha = args.sha.strip().lower()
    notices: list[str] = []
    reasons = check(sha, args.approved_by, args.hotfix, today, cfg, now,
                    notices)
    if reasons:
        print(f"[deny] không deploy {sha!r}:", flush=True)
        for r in reasons:
            print(f"  - {r}", flush=True)
        return 1
    for n in notices:
        print(f"[warn] {n} — deploy cho qua TRONG đóng băng, ghi lại phiếu/"
              "lý do", flush=True)
    print(plan(sha, args.approved_by, args.hotfix), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
