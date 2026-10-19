"""Bản tin sức khỏe hằng ngày (v3.7, F17.2 chế độ P1 + F17.3 FinOps).

Contract:
  - Mọi số lấy từ SQL — 0 lời gọi LLM/gateway. Mỗi mục ghi kèm bảng nguồn.
  - 6 mục (heading cố định): DB · Job 24h · Chi phí AI tháng này theo agent
    · Lời gọi LLM lỗi 24h · Hàng chờ duyệt · Hạn lưu dữ liệu cá nhân (v13.4,
    đọc `data/retention.json` không cần DB: TTL null = CẢNH BÁO chưa chốt).
  - Chi phí so với trần `pipelines.llm_gateway._config()["monthly_cap_usd"]`
    (giữ env override + key `default`): ≥80% "CẢNH BÁO", ≥100% "ĐÃ CHẶN
    (gateway)" — bản tin CHỈ báo, việc chặn do gateway làm. Cap 0 = gateway chặn hẳn agent đó ("ĐÃ CHẶN (cap 0)").
    Tháng tính theo giờ Asia/Ho_Chi_Minh (cùng mốc với gateway `_SPEND_SQL`).
  - DB chết/thiếu DSN → vẫn ra bản tin "DB không truy cập được", exit 0.
    Thiếu bảng → mục đó ghi "chưa có bảng — chạy apply_schema".
  - Output: in stdout + ghi `<out-dir>/health-<YYYY-MM-DD>.md` (mặc định
    `data/reports/`, gitignored). `--date` chỉ là nhãn ngày của bản tin;
    số liệu luôn tính tại thời điểm chạy.
  - Gửi (human-gate C2.4): mặc định KHÔNG gửi. `--notify` + env
    `HEALTH_NOTIFY=email|telegram` + biến kênh đủ mới mở kết nối; gửi lỗi
    → cảnh báo, exit 0. Không in token/mật khẩu/URL bot.
  - Lịch 07:30 giờ VN: xem docs/handover/sop.md mục "Giám sát vận hành".

Chạy: `python scripts/health_bulletin.py [--out-dir DIR] [--date YYYY-MM-DD]
[--notify]`
"""

import argparse
import os
import smtplib
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipelines.job_runs import clean_detail
from pipelines.llm_gateway import WARN_RATIO, _config

load_dotenv(ROOT / ".env")
VN = ZoneInfo("Asia/Ho_Chi_Minh")
REPORTS_DIR = ROOT / "data" / "reports"
CONNECT_TIMEOUT_S = 3  # bản tin DB chết phải ra ≤10s (gồm thời gian import)
NOTIFY_TIMEOUT_S = 10
TELEGRAM_MAX = 4000  # giới hạn Telegram 4096 ký tự/tin
# Job lịch → số giờ tối đa giữa 2 lần chạy OK; quá hạn = "không chạy/trễ".
EXPECTED_JOBS = {"ingest.lead_store": 24, "agents.report": 24 * 8}


def expected_jobs() -> dict:
    """v13.7: + mọi job lịch on-prem (`deploy/onprem/jobs.json`, dòng
    `job:<tên>` do `pipelines.job_runs --run` ghi). Lịch hỏng → chỉ danh sách
    cũ + dòng lỗi riêng ở mục Job (không im lặng)."""
    from pipelines.job_runs import JobConfigError, load_jobs
    try:
        sched = {f"job:{n}": j["max_gap_hours"] for n, j in load_jobs().items()}
    except JobConfigError:
        sched = {}
    return {**EXPECTED_JOBS, **sched}
# Mốc 00:00 ngày 1 tháng này giờ VN — PHẢI giống `_SPEND_SQL` của gateway
# (test drift-guard).
MONTH_START_SQL = ("(date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')"
                   " at time zone 'Asia/Ho_Chi_Minh')")
MISSING = "missing"

H_DB = "## 1. DB"
H_JOBS = "## 2. Job 24h"
H_COST = "## 3. Chi phí AI tháng này theo agent"
H_ERR = "## 4. Lời gọi LLM lỗi 24h"
H_QUEUE = "## 5. Hàng chờ duyệt"
H_RETENTION = "## 6. Hạn lưu dữ liệu cá nhân"


def retention_lines() -> list[str]:
    """v13.4 — tình trạng `data/retention.json` (không DB): TTL null = CẢNH
    BÁO chưa chốt; cấu hình hỏng = báo lỗi (job không xóa gì)."""
    from scripts.retention_purge import RetentionError, load_config, status_lines
    try:
        return status_lines(load_config())
    except RetentionError as e:
        return [f"- LỖI cấu hình hạn lưu ({e}) — job xóa không chạy"]


def _jobs(conn) -> dict:
    counts = conn.execute(
        "select job, count(*) filter (where ok),"
        " count(*) filter (where ok is not true) from job_runs"
        " where started_at >= now() - interval '24 hours'"
        " group by job order by job").fetchall()
    failed = conn.execute(
        "select job, started_at, detail from job_runs"
        " where started_at >= now() - interval '24 hours' and ok is not true"
        " order by started_at desc limit 20").fetchall()
    exp = expected_jobs()
    last_ok = conn.execute(
        "select job, extract(epoch from now() - max(started_at)) / 3600"
        " from job_runs where ok and job = any(%s) group by job",
        (list(exp),)).fetchall()
    return {"counts": counts, "failed": failed, "expected": exp,
            "last_ok_hours": {j: float(h) for j, h in last_ok}}


def _spend(conn) -> dict:
    rows = conn.execute(
        "select agent_id, coalesce(sum(cost_usd), 0) from llm_usage"
        f" where ts >= {MONTH_START_SQL} group by agent_id").fetchall()
    return {a: float(c) for a, c in rows}


def _llm_errors(conn) -> list:
    return conn.execute(
        "select agent_id, count(*) from llm_usage where not ok"
        " and ts >= now() - interval '24 hours'"
        " group by agent_id order by agent_id").fetchall()


def _pending(conn) -> int:
    return conn.execute("select count(*) from content_drafts"
                        " where status = 'pending'").fetchone()[0]


def collect(conn) -> dict:
    """Số liệu 4 mục sau DB. Lỗi từng mục không làm hỏng mục khác
    (conn autocommit → không kẹt transaction aborted)."""
    data = {"db_ok": True}
    for key, fn in (("jobs", _jobs), ("spend", _spend),
                    ("llm_errors", _llm_errors), ("pending", _pending)):
        try:
            data[key] = fn(conn)
        except psycopg.errors.UndefinedTable:
            data[key] = MISSING
        except psycopg.Error as e:
            data[key] = {"error": type(e).__name__}
    return data


def gather() -> dict:
    """Connect (timeout) + collect; DB chết → {db_ok: False}."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return {"db_ok": False, "db_error": "thiếu DATABASE_URL"}
    try:
        conn = psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S,
                               autocommit=True)
    except Exception as e:  # noqa: BLE001 — chỉ in tên lỗi, không lộ DSN
        return {"db_ok": False, "db_error": type(e).__name__}
    try:
        return collect(conn)
    finally:
        conn.close()


def late_jobs(last_ok_hours: dict, expected: dict = EXPECTED_JOBS) -> list:
    """[(job, giờ từ lần OK gần nhất | None, hạn giờ)] cho job quá hạn."""
    out = []
    for job, limit in expected.items():
        h = last_ok_hours.get(job)
        if h is None or h > limit:
            out.append((job, h, limit))
    return out


def cost_rows(spend: dict, caps: dict) -> list:
    """[(agent, spend, cap, pct|None, nhãn)] — so sánh giống `_gate`."""
    agents = sorted(set(spend) | (set(caps) - {"default"}))
    rows = []
    for a in agents:
        s = float(spend.get(a, 0.0))
        cap = float(caps.get(a, caps.get("default", 0.0)))
        if cap <= 0:
            rows.append((a, s, cap, None, "ĐÃ CHẶN (cap 0)"))
            continue
        if s >= cap:
            label = "ĐÃ CHẶN (gateway)"
        elif s >= WARN_RATIO * cap:
            label = "CẢNH BÁO"
        else:
            label = "OK"
        rows.append((a, s, cap, 100 * s / cap, label))
    return rows


def _cell(v) -> str:
    """Giá trị từ DB vào markdown: mask PII/secret, bỏ xuống dòng/|."""
    s = clean_detail(v) or ""
    return " ".join(s.replace("|", "/").split())[:300]


def _section_state(val, table: str) -> str | None:
    if val == MISSING:
        return f"chưa có bảng `{table}` — chạy `python scripts/apply_schema.py`"
    if isinstance(val, dict) and "error" in val:
        return f"lỗi đọc `{table}` ({val['error']})"
    return None


def render(data: dict, day: date, caps: dict | None = None,
           cap_error: str | None = None,
           retention: list[str] | None = None) -> str:
    L = [f"# Bản tin sức khỏe hệ thống — {day:%Y-%m-%d}", "",
         (f"_Sinh lúc {datetime.now(VN):%Y-%m-%d %H:%M} giờ VN — số liệu "
          "từ SQL, không dùng LLM. Bản tin chỉ BÁO, không tự xử lý._"), "",
         H_DB, ""]
    down = not data.get("db_ok")
    if down:
        L.append(f"- **DB không truy cập được** ({data.get('db_error')}) — "
                 "kiểm service Postgres / `DATABASE_URL` (SOP mục 7).")
    else:
        L.append("- DB: sống (connect + query OK)")
    na = "- không có số liệu (DB không truy cập được)"

    L += ["", H_JOBS, "", "_Nguồn: bảng `job_runs` (24h qua)._", ""]
    jobs = data.get("jobs")
    if down:
        L.append(na)
    elif (msg := _section_state(jobs, "job_runs")):
        L.append(f"- {msg}")
    else:
        if jobs["counts"]:
            L += ["| Job | OK | Lỗi |", "|---|---:|---:|"]
            L += [f"| {_cell(j)} | {ok} | {bad} |"
                  for j, ok, bad in jobs["counts"]]
        else:
            L.append("- không có lần chạy nào trong 24h")
        for j, ts, detail in jobs["failed"]:
            when = ts.astimezone(VN).strftime("%Y-%m-%d %H:%M") \
                if hasattr(ts, "astimezone") else _cell(ts)
            L.append(f"- LỖI `{_cell(j)}` lúc {when}: {_cell(detail)}")
        for j, h, limit in late_jobs(jobs["last_ok_hours"],
                                     jobs.get("expected", EXPECTED_JOBS)):
            seen = "chưa có lần OK nào" if h is None \
                else f"lần OK gần nhất {h:.1f} giờ trước"
            L.append(f"- KHÔNG CHẠY/TRỄ `{j}` — {seen} (hạn {limit} giờ)")

    L += ["", H_COST, "",
          ("_Nguồn: bảng `llm_usage` (`sum(cost_usd)` từ 00:00 ngày 1 giờ "
           "VN) + trần `data/llm_gateway.json` `monthly_cap_usd`. "
           f"Ngưỡng: ≥{WARN_RATIO:.0%} cảnh báo, ≥100% gateway chặn._"), ""]
    spend = data.get("spend")
    if down:
        L.append(na)
    elif (msg := _section_state(spend, "llm_usage")):
        L.append(f"- {msg}")
    elif cap_error or caps is None:
        L.append(f"- không đọc được trần chi phí ({cap_error})")
    else:
        L += ["| Agent | Đã dùng (USD) | Trần (USD) | % | Trạng thái |",
              "|---|---:|---:|---:|---|"]
        for a, s, cap, pct, label in cost_rows(spend, caps):
            p = "—" if pct is None else f"{pct:.0f}%"
            L.append(f"| {_cell(a)} | {s:.4f} | {cap:.2f} | {p} | {label} |")

    L += ["", H_ERR, "", "_Nguồn: bảng `llm_usage` `ok = false` (24h qua)._",
          ""]
    errs = data.get("llm_errors")
    if down:
        L.append(na)
    elif (msg := _section_state(errs, "llm_usage")):
        L.append(f"- {msg}")
    else:
        L.append(f"- Tổng: {sum(n for _, n in errs)}")
        L += [f"  - `{_cell(a)}`: {n}" for a, n in errs]

    L += ["", H_QUEUE, "",
          "_Nguồn: bảng `content_drafts` `status = 'pending'`._", ""]
    pend = data.get("pending")
    if down:
        L.append(na)
    elif (msg := _section_state(pend, "content_drafts")):
        L.append(f"- {msg}")
    else:
        L.append(f"- Draft chờ duyệt: {pend}")

    L += ["", H_RETENTION, "",
          ("_Nguồn: `data/retention.json` (CV / chấm công / ảnh-video / ghi "
           "âm vườn); job `scripts/retention_purge.py`._"), ""]
    L += retention if retention is not None else retention_lines()
    return "\n".join(L) + "\n"


def notify(text: str, env=None) -> str:
    """Cổng gửi — 'skipped' | 'sent' | 'error'. Chỉ mở mạng khi đủ biến."""
    env = os.environ if env is None else env
    kind = (env.get("HEALTH_NOTIFY") or "").strip().lower()
    try:
        if kind == "telegram" and env.get("TELEGRAM_BOT_TOKEN") \
                and env.get("TELEGRAM_CHAT_ID"):
            body = urllib.parse.urlencode(
                {"chat_id": env["TELEGRAM_CHAT_ID"],
                 "text": text[:TELEGRAM_MAX]}).encode()
            url = ("https://api.telegram.org/bot"
                   f"{env['TELEGRAM_BOT_TOKEN']}/sendMessage")
            with urllib.request.urlopen(url, data=body,
                                        timeout=NOTIFY_TIMEOUT_S):
                pass
        elif kind == "email" and env.get("SMTP_HOST") \
                and env.get("HEALTH_MAIL_TO"):
            msg = EmailMessage()
            msg["Subject"] = "[Sâm Sâm AI] Bản tin sức khỏe hệ thống"
            msg["From"] = env.get("SMTP_USER") or "health-bulletin@localhost"
            msg["To"] = env["HEALTH_MAIL_TO"]
            msg.set_content(text)
            with smtplib.SMTP(env["SMTP_HOST"], int(env.get("SMTP_PORT")
                                                    or 587),
                              timeout=NOTIFY_TIMEOUT_S) as s:
                # context verify cert+hostname — starttls() trần KHÔNG
                # xác thực server (MITM đọc được SMTP_PASSWORD)
                s.starttls(context=ssl.create_default_context())
                if env.get("SMTP_USER"):
                    s.login(env["SMTP_USER"], env.get("SMTP_PASSWORD", ""))
                s.send_message(msg)
        else:
            print("[notify] bỏ qua (chưa cấu hình)", flush=True)
            return "skipped"
    except Exception as e:  # noqa: BLE001 — gửi lỗi không làm hỏng bản tin
        print(f"[notify] gửi lỗi ({type(e).__name__}) — bản tin vẫn ở "
              "file/stdout", flush=True)
        return "error"
    print(f"[notify] đã gửi qua {kind}", flush=True)
    return "sent"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python scripts/health_bulletin.py",
        description="Bản tin sức khỏe hệ thống (chỉ số SQL, không LLM)")
    ap.add_argument("--out-dir", default=str(REPORTS_DIR),
                    help="thư mục ghi bản tin (mặc định data/reports)")
    ap.add_argument("--date", default=None,
                    help="YYYY-MM-DD — nhãn ngày bản tin (mặc định hôm nay "
                         "giờ VN; số liệu luôn tính lúc chạy)")
    ap.add_argument("--notify", action="store_true",
                    help="gửi qua kênh cấu hình HEALTH_NOTIFY (mặc định tắt)")
    args = ap.parse_args(argv)
    try:
        day = date.fromisoformat(args.date) if args.date \
            else datetime.now(VN).date()
    except ValueError:
        ap.error("--date sai định dạng YYYY-MM-DD")

    data = gather()
    caps = cap_error = None
    try:
        caps = {k: float(v) for k, v in _config()["monthly_cap_usd"].items()}
    except Exception as e:  # noqa: BLE001
        caps, cap_error = None, type(e).__name__
    text = render(data, day, caps, cap_error)
    print(text, flush=True)

    rc = 0
    name = f"health-{day:%Y-%m-%d}.md"
    # docx P2 (data_platform-07.1, HĐ 6.7, PL02 mục 1): bản tin ghi qua
    # `write_report` như mọi báo cáo của danh mục — tính năng TẮT → không
    # sinh; chạy thử / có người duyệt → nhãn trong nội dung; sổ
    # `report_outputs` để đếm đầu ra + người duyệt từng bản (trước đây ghi
    # file thẳng: không cổng, không nhãn, không bao giờ đếm được).
    # sample=False: số đo trực tiếp DB/job lúc chạy (không có đường mẫu).
    from agents.report import write_report
    from pipelines import rollout
    sent = text
    try:
        path = write_report(text, Path(args.out_dir), name, sample=False)
        sent = path.read_bytes().decode("utf-8")   # đúng bản có nhãn
        print(f"[done] {path}", flush=True)
    except rollout.RolloutBlocked as e:
        print(f"[rollout] {e} — không gửi", flush=True)
        return 2
    except OSError as e:
        print(f"[err] không ghi được file bản tin ({type(e).__name__}) — "
              "nội dung đã in stdout", flush=True)
        rc = 1
    if args.notify:
        # Thông báo NỘI BỘ vận hành (như cảnh báo đỏ — vẫn gửi khi chạy thử,
        # chỉ dừng khi TẮT); gửi đúng bản có nhãn giai đoạn.
        notify(sent)
    else:
        print("[notify] bỏ qua (chưa cấu hình — cần --notify)", flush=True)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
