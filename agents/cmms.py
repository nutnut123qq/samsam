"""v9.5 CK-A2 — CMMS nhẹ trung tâm điện–cơ khí: sổ máy, kế hoạch bảo trì
theo chu kỳ, sự cố + downtime, nhắc việc đến hạn.

Contract:
  - Bảng `machines`, `maintenance_plans`, `incidents` + view `downtime_log`
    (docs/schema.sql). KHÔNG có op xóa máy — thôi dùng = `--retire`.
  - `due_items(plans, machines, today, horizon_days=7, cert_days=30)` hàm
    THUẦN (today là tham số): hạn kế = coalesce(last_done_on, start_on) +
    interval_days; `overdue` khi < today, `due` khi <= today + horizon.
    Hạn kiểm định / hiệu chuẩn nhắc khi còn <= cert_days (kể cả đã quá).
    Chỉ máy + plan `active`.
  - `--done` việc `major` HOẶC máy `ho_so_gmp` bắt buộc `--approved-by`
    (tên Kỹ sư trưởng — người thật; agent/test không tự điền) — thiếu →
    exit 2, KHÔNG ghi. `--on` ở tương lai → exit 2.
  - Validate hết tham số trước khi connect; >1 op → exit 2 trước connect.
  - `--now` CHỈ đi với `--due` (xem trước nhắc việc). Op GHI (`--done`,
    `--add-plan`...) luôn so với hôm nay THẬT — `--now` kèm op ghi → exit
    2 (chặn `--done --on 2099 --now 2099` đẩy hạn kế đi hàng chục năm).
  - `--kiem-dinh` / `--phuong-tien-do` đánh dấu máy thuộc diện kiểm định /
    là phương tiện đo kể cả khi CHƯA biết hạn → `--incomplete` báo thiếu
    hạn. Có `--kiem-dinh-han` / `--hieu-chuan-han` thì cờ tự bật.
  - Mô tả sự cố qua `_mask_pii` trước khi ghi; `--by` là MÃ nhân sự.
    Print chỉ mã máy / plan id / số đếm / ngày — không in mô tả.
  - "Hôm nay" mặc định theo giờ VN (UTC+7); giờ naive của `--start/--end`
    hiểu là +07:00.

Chạy: `python -m agents.cmms --add-machine --code SS-EQ-03 --name "..."
[--location --maker --year --kiem-dinh [--kiem-dinh-han] --phuong-tien-do
[--hieu-chuan-han] --gmp]` ·
`--add-plan --code --task --every-days N [--major]` · `--done <plan_id>
--on YYYY-MM-DD --by <ma_nv> [--approved-by "<Kỹ sư trưởng>"]` ·
`--incident --code --start ISO [--end ISO] --by <ma_nv> [--part --desc]` ·
`--due [--now YYYY-MM-DD] [--horizon N]` · `--incomplete` · `--retire <code>`.
"""

import argparse
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
VN = timezone(timedelta(hours=7))  # không zoneinfo — Windows thiếu tzdata
CONNECT_TIMEOUT_S = 5
CODE_RE = re.compile(r"SS-EQ-[0-9]{2,4}")
STAFF_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")
OPS = ("add_machine", "add_plan", "done", "incident", "due", "incomplete",
       "retire")


class ApprovalRequired(Exception):
    """Việc lớn / máy GMP mà thiếu người duyệt — không ghi."""


def today_vn() -> date:
    return datetime.now(VN).date()


def due_items(plans: list[dict], machines: list[dict], today: date,
              horizon_days: int = 7, cert_days: int = 30) -> list[dict]:
    """Việc đến hạn/quá hạn — hàm thuần. → [{kind, machine_code, plan_id,
    due_on, status, days_left}] sắp theo (due_on, machine_code, kind, plan_id)."""
    active = {m["code"]: m for m in machines if m.get("active", True)}
    out = []
    for p in plans:
        if not p.get("active", True) or p["machine_code"] not in active:
            continue
        base = p.get("last_done_on") or p["start_on"]
        due_on = base + timedelta(days=int(p["interval_days"]))
        if due_on <= today + timedelta(days=horizon_days):
            out.append({"kind": "bao_tri", "machine_code": p["machine_code"],
                        "plan_id": p["id"], "due_on": due_on,
                        "status": "overdue" if due_on < today else "due",
                        "days_left": (due_on - today).days})
    for code, m in active.items():
        for kind, col in (("kiem_dinh", "han_kiem_dinh"),
                          ("hieu_chuan", "han_hieu_chuan")):
            han = m.get(col)
            if han is not None and (han - today).days <= cert_days:
                out.append({"kind": kind, "machine_code": code, "plan_id": None,
                            "due_on": han,
                            "status": "overdue" if han < today else "due",
                            "days_left": (han - today).days})
    return sorted(out, key=lambda r: (r["due_on"], r["machine_code"], r["kind"],
                                      r["plan_id"] or 0))


def incomplete(machines: list[dict]) -> list[dict]:
    """Máy active thiếu hồ sơ → [{code, missing: [...]}]."""
    out = []
    for m in machines:
        if not m.get("active", True):
            continue
        miss = [f for f in ("maker", "year", "location") if m.get(f) in (None, "")]
        if m.get("thuoc_dien_kiem_dinh") and m.get("han_kiem_dinh") is None:
            miss.append("han_kiem_dinh")
        if m.get("la_phuong_tien_do") and m.get("han_hieu_chuan") is None:
            miss.append("han_hieu_chuan")
        if miss:
            out.append({"code": m["code"], "missing": miss})
    return out


def downtime_minutes(start: datetime, end: datetime) -> int:
    if end < start:
        raise ValueError("thời điểm kết thúc trước bắt đầu")
    return int((end - start).total_seconds() // 60)


# --- DB ------------------------------------------------------------------
_MACHINE_COLS = ("code", "name", "location", "maker", "year",
                 "thuoc_dien_kiem_dinh", "han_kiem_dinh", "la_phuong_tien_do",
                 "han_hieu_chuan", "ho_so_gmp", "active")
_PLAN_COLS = ("id", "machine_code", "task", "interval_days", "major",
              "start_on", "last_done_on", "active")


def _rows(conn, sql, cols, params=()):
    return [dict(zip(cols, r)) for r in conn.execute(sql, params).fetchall()]


def load_machines(conn) -> list[dict]:
    return _rows(conn, f"select {', '.join(_MACHINE_COLS)} from machines"
                 " order by code", _MACHINE_COLS)


def load_plans(conn) -> list[dict]:
    return _rows(conn, f"select {', '.join(_PLAN_COLS)} from maintenance_plans"
                 " order by id", _PLAN_COLS)


def add_machine(conn, *, code, name, location=None, maker=None, year=None,
                han_kiem_dinh=None, han_hieu_chuan=None, gmp=False,
                kiem_dinh=False, phuong_tien_do=False) -> None:
    conn.execute(
        "insert into machines (code, name, location, maker, year,"
        " thuoc_dien_kiem_dinh, han_kiem_dinh, la_phuong_tien_do,"
        " han_hieu_chuan, ho_so_gmp) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (code, name, location, maker, year,
         bool(kiem_dinh) or han_kiem_dinh is not None, han_kiem_dinh,
         bool(phuong_tien_do) or han_hieu_chuan is not None, han_hieu_chuan,
         gmp))
    conn.commit()


def add_plan(conn, *, code, task, every_days, major=False,
             start_on: date | None = None) -> int:
    pid = conn.execute(
        "insert into maintenance_plans (machine_code, task, interval_days,"
        " major, start_on) values (%s,%s,%s,%s,%s) returning id",
        (code, task, every_days, major, start_on or today_vn())).fetchone()[0]
    conn.commit()
    return pid


def mark_done(conn, plan_id: int, on: date, by: str,
              approved_by: str | None = None) -> None:
    row = conn.execute(
        "select p.major, m.ho_so_gmp from maintenance_plans p join machines m"
        " on m.code = p.machine_code where p.id = %s", (plan_id,)).fetchone()
    if row is None:
        conn.rollback()
        raise LookupError(f"không có plan #{plan_id}")
    if (row[0] or row[1]) and not approved_by:
        conn.rollback()
        raise ApprovalRequired(
            f"plan #{plan_id} là việc lớn / máy hồ sơ GMP — cần --approved-by"
            " (Kỹ sư trưởng)")
    conn.execute(
        "update maintenance_plans set last_done_on = %s, last_done_by = %s,"
        " last_approved_by = %s where id = %s",
        (on, by, approved_by, plan_id))
    conn.commit()


def add_incident(conn, *, code, start: datetime, end: datetime | None, by,
                 part=None, desc=None) -> int:
    mins = downtime_minutes(start, end) if end is not None else None
    iid = conn.execute(
        "insert into incidents (machine_code, started_at, ended_at,"
        " downtime_phut, part, description, reported_by)"
        " values (%s,%s,%s,%s,%s,%s,%s) returning id",
        (code, start, end, mins, _mask_pii(part) if part else None,
         _mask_pii(desc) if desc else None, by)).fetchone()[0]
    conn.commit()
    return iid


def retire(conn, code: str) -> bool:
    n = conn.execute("update machines set active = false where code = %s",
                     (code,)).rowcount
    conn.commit()
    return n > 0


def connect():
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)


# --- CLI -----------------------------------------------------------------
def _iso_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from None


def _iso_dt(s: str) -> datetime:
    try:
        d = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("thời điểm phải dạng ISO") from None
    return d if d.tzinfo else d.replace(tzinfo=VN)


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m agents.cmms",
                                 description="CK-A2 CMMS nhẹ")
    ap.add_argument("--add-machine", action="store_true")
    ap.add_argument("--add-plan", action="store_true")
    ap.add_argument("--done", type=int, metavar="PLAN_ID")
    ap.add_argument("--incident", action="store_true")
    ap.add_argument("--due", action="store_true")
    ap.add_argument("--incomplete", action="store_true")
    ap.add_argument("--retire", metavar="CODE")
    ap.add_argument("--code")
    ap.add_argument("--name")
    ap.add_argument("--location")
    ap.add_argument("--maker")
    ap.add_argument("--year", type=int)
    ap.add_argument("--kiem-dinh", action="store_true",
                    help="máy thuộc diện kiểm định (kể cả chưa biết hạn)")
    ap.add_argument("--phuong-tien-do", action="store_true",
                    help="là phương tiện đo phải hiệu chuẩn (kể cả chưa biết hạn)")
    ap.add_argument("--kiem-dinh-han", type=_iso_date)
    ap.add_argument("--hieu-chuan-han", type=_iso_date)
    ap.add_argument("--gmp", action="store_true")
    ap.add_argument("--task")
    ap.add_argument("--every-days", type=int)
    ap.add_argument("--major", action="store_true")
    ap.add_argument("--on", type=_iso_date)
    ap.add_argument("--by")
    ap.add_argument("--approved-by")
    ap.add_argument("--start", type=_iso_dt)
    ap.add_argument("--end", type=_iso_dt)
    ap.add_argument("--part")
    ap.add_argument("--desc")
    ap.add_argument("--now", type=_iso_date,
                    help="chỉ với --due: xem nhắc việc tại ngày này")
    ap.add_argument("--horizon", type=int, default=7)
    return ap


def _text(ap, val, flag, cap, required=True):
    v = (val or "").strip()
    if required and not v:
        ap.error(f"thiếu {flag}")
    if len(v) > cap:
        ap.error(f"{flag} dài quá {cap} ký tự")
    return v or None


def parse_args(argv=None) -> argparse.Namespace:
    """Validate toàn bộ tham số TRƯỚC connect. Lỗi → ap.error (exit 2)."""
    ap = _parser()
    a = ap.parse_args(argv)
    chosen = [o for o in OPS if getattr(a, o) not in (None, False)]
    if len(chosen) != 1:
        ap.error("chọn đúng 1 thao tác: --add-machine | --add-plan | --done |"
                 " --incident | --due | --incomplete | --retire")
    a.op = chosen[0]
    if a.now is not None and a.op != "due":
        ap.error("--now chỉ dùng với --due — thao tác ghi luôn theo hôm nay thật")
    a.today = a.now or today_vn()
    code = a.retire if a.op == "retire" else a.code
    if a.op in ("add_machine", "add_plan", "incident", "retire") and (
            not code or not CODE_RE.fullmatch(code)):
        ap.error("mã máy phải dạng SS-EQ-NN (2-4 chữ số)")
    if a.op == "add_machine":
        a.name = _text(ap, a.name, "--name", 200)
        a.location = _text(ap, a.location, "--location", 200, required=False)
        a.maker = _text(ap, a.maker, "--maker", 200, required=False)
        if a.year is not None and not 1950 <= a.year <= 2100:
            ap.error("--year phải trong 1950-2100")
    elif a.op == "add_plan":
        a.task = _text(ap, a.task, "--task", 300)
        if a.every_days is None or not 1 <= a.every_days <= 3660:
            ap.error("--every-days phải trong 1-3660")
    elif a.op == "done":
        if a.done <= 0:
            ap.error("plan id phải > 0")
        if a.on is None:
            ap.error("thiếu --on YYYY-MM-DD")
        if a.on > a.today:
            ap.error(f"--on {a.on.isoformat()} ở tương lai so với hôm nay"
                     f" {a.today.isoformat()}")
        if not a.by or not STAFF_RE.fullmatch(a.by):
            ap.error("--by phải là MÃ nhân sự [A-Za-z0-9_-]{1,32}")
        a.approved_by = _text(ap, a.approved_by, "--approved-by", 200,
                              required=False)
    elif a.op == "incident":
        if a.start is None:
            ap.error("thiếu --start")
        if a.end is not None and a.end < a.start:
            ap.error("--end trước --start")
        if not a.by or not STAFF_RE.fullmatch(a.by):
            ap.error("--by phải là MÃ nhân sự [A-Za-z0-9_-]{1,32}")
        a.part = _text(ap, a.part, "--part", 200, required=False)
        a.desc = _text(ap, a.desc, "--desc", 2000, required=False)
    elif a.op == "due" and not 0 <= a.horizon <= 365:
        ap.error("--horizon phải trong 0-365")
    return a


def run(a: argparse.Namespace, conn) -> int:
    if a.op == "add_machine":
        add_machine(conn, code=a.code, name=a.name, location=a.location,
                    maker=a.maker, year=a.year, han_kiem_dinh=a.kiem_dinh_han,
                    han_hieu_chuan=a.hieu_chuan_han, gmp=a.gmp,
                    kiem_dinh=a.kiem_dinh, phuong_tien_do=a.phuong_tien_do)
        print(f"[cmms] đã thêm máy {a.code}", flush=True)
    elif a.op == "add_plan":
        pid = add_plan(conn, code=a.code, task=a.task, every_days=a.every_days,
                       major=a.major, start_on=a.today)
        print(f"[cmms] plan #{pid} cho {a.code}: mỗi {a.every_days} ngày",
              flush=True)
    elif a.op == "done":
        try:
            mark_done(conn, a.done, a.on, a.by, a.approved_by)
        except LookupError as e:
            print(f"[cmms] lỗi: {e}", flush=True)
            return 1
        except ApprovalRequired as e:
            print(f"[cmms] KHÔNG ghi: {e}", flush=True)
            return 2
        print(f"[cmms] plan #{a.done} xong ngày {a.on.isoformat()}", flush=True)
    elif a.op == "incident":
        iid = add_incident(conn, code=a.code, start=a.start, end=a.end,
                           by=a.by, part=a.part, desc=a.desc)
        mins = (downtime_minutes(a.start, a.end) if a.end is not None
                else None)
        state = f"downtime {mins} phút" if mins is not None else "đang mở"
        print(f"[cmms] sự cố #{iid} máy {a.code}: {state}", flush=True)
    elif a.op == "due":
        items = due_items(load_plans(conn), load_machines(conn), a.today,
                          horizon_days=a.horizon)
        print(f"[cmms] hôm nay {a.today.isoformat()} — {len(items)} việc đến"
              f" hạn trong {a.horizon} ngày (hạn kiểm định/hiệu chuẩn ≤30"
              " ngày)", flush=True)
        for r in items:
            pid = f" plan #{r['plan_id']}" if r["plan_id"] else ""
            print(f"  [{r['status']}] {r['machine_code']} {r['kind']}{pid}"
                  f" hạn {r['due_on'].isoformat()} ({r['days_left']:+d} ngày)",
                  flush=True)
    elif a.op == "incomplete":
        items = incomplete(load_machines(conn))
        print(f"[cmms] {len(items)} máy thiếu hồ sơ", flush=True)
        for r in items:
            print(f"  {r['code']}: thiếu {', '.join(r['missing'])}", flush=True)
    elif a.op == "retire":
        ok = retire(conn, a.retire)
        print(f"[cmms] {a.retire}: {'đã ngừng dùng' if ok else 'không có máy'}",
              flush=True)
        return 0 if ok else 1
    return 0


def main(argv=None) -> int:
    a = parse_args(argv)
    try:
        conn = connect()
    except psycopg.Error as e:
        print(f"[cmms] không kết nối được DB ({type(e).__name__})", flush=True)
        return 1
    if conn is None:
        print("[cmms] thiếu DATABASE_URL", flush=True)
        return 1
    try:
        return run(a, conn)
    except psycopg.Error as e:
        print(f"[cmms] lỗi DB ({type(e).__name__}) — không ghi", flush=True)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
