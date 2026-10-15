"""v13.7 (F06) — Sổ sự cố vận hành theo PL02 mục 2 (tiêu chí kỹ thuật).

Contract:
  - Bảng `ops_incidents` (1 dòng/sự cố) + `ops_incident_events` (mốc sau
    đó) — APPEND-ONLY (trigger `append_only_guard`): sửa sai = ghi sự kiện
    `note`, không sửa dòng cũ. `recorded_at` do DB đặt (lúc ghi sổ ≠ lúc
    xảy ra — cả hai đều lưu để soát ghi muộn).
  - Mốc và chỉ tiêu (hằng code, số trong HĐ — không cấu hình):
      * phát hiện ≤ 15 phút: `occurred_at` (lúc sự cố bắt đầu, theo log/
        monitor) → `detected_at`. Không biết `occurred_at` = "chưa đo" (KHÔNG
        tính đạt).
      * phản hồi lỗi nghiêm trọng ≤ 03 giờ / lỗi thường ≤ 03 ngày làm việc:
        `detected_at` → sự kiện `responded` đầu tiên (ack KỸ THUẬT của Bên
        chịu trách nhiệm). Ngày làm việc = `pipelines.rollout.load_shift`
        (`data/rollout_config.json`; lịch nghỉ rỗng → cảnh báo, không bịa).
      * sửa lỗi ≤ 07 ngày: `detected_at` → sự kiện `fixed` đầu tiên.
      * `customer_resolved` (khách/đối tác đã được xử lý xong) là sự kiện
        RIÊNG — KHÔNG thay cho `responded`/`fixed` và ngược lại.
  - Lỗi nghiêm trọng theo PL02: từ cấm trong đầu ra; rượu trong nội dung
    công khai; TPBVSK chưa XNQC ở quảng cáo/KOC/livestream; thiếu câu khuyến
    cáo; nội dung AI thiếu nhãn; lộ dữ liệu cá nhân; số liệu không có nguồn
    — người ghi sổ chọn `--severity nghiem_trong` (code không tự đoán).
  - `--by` là NGƯỜI thật (không `agent:`/`system:`); tiêu đề/ghi chú qua
    `_mask_pii` + cắt độ dài. Thời điểm không được ở tương lai (> 5 phút) và
    sự kiện không trước `detected_at`. Giờ không kèm múi = giờ VN.
  - `evaluate`/`summarize` THUẦN — `scripts/ops_monthly.py` dùng cho mục 2.

Chạy:
  python -m pipelines.ops_incidents --open --title T --severity nghiem_trong|thuong
      --source S --ben ben_a|ben_b|chua_xac_dinh --detected-at ISO
      [--occurred-at ISO] --by "Tên"
  python -m pipelines.ops_incidents --event ID --kind responded|fixed|
      customer_resolved|note [--at ISO] [--note ..] --by "Tên"
  python -m pipelines.ops_incidents --list [--month YYYY-MM]
Exit: 0 ok · 1 từ chối/DB lỗi · 2 tham số sai.
"""

import argparse
import sys
from datetime import date, datetime, timedelta

import psycopg

from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

SEVERITIES = ("nghiem_trong", "thuong")
BEN = ("ben_a", "ben_b", "chua_xac_dinh")
KINDS = ("responded", "fixed", "customer_resolved", "note")
DETECT_LIMIT = timedelta(minutes=15)
RESPOND_SEVERE = timedelta(hours=3)
RESPOND_NORMAL_WORKDAYS = 3
FIX_LIMIT = timedelta(days=7)
FUTURE_SKEW = timedelta(minutes=5)
TITLE_MAX = 200
SOURCE_MAX = 100
NOTE_MAX = 500
BY_MAX = 100


class IncidentError(ValueError):
    """Đầu vào bị từ chối — không ghi gì."""


def parse_ts(v, name: str) -> datetime:
    """ISO 8601; không kèm múi giờ = giờ VN (+07:00)."""
    if isinstance(v, datetime):
        ts = v
    else:
        try:
            ts = datetime.fromisoformat(str(v).strip())
        except ValueError:
            raise IncidentError(f"{name}: cần thời điểm ISO (YYYY-MM-DD "
                                "HH:MM[+07:00])") from None
    return ts.replace(tzinfo=VN_TZ) if ts.tzinfo is None else ts


def _by(by) -> str:
    from pipelines import auth
    s = " ".join(str(by or "").split())
    if not s or len(s) > BY_MAX or not auth.is_human(s):
        raise IncidentError(f"--by phải là tên NGƯỜI thật (1..{BY_MAX} ký "
                            "tự, không agent:/system:)")
    return _mask_pii(s)


def _text(v, name: str, n: int, required: bool = True) -> str | None:
    s = " ".join(str(v or "").split())[:n * 2]
    s = _mask_pii(s)[:n].strip()
    if required and not s:
        raise IncidentError(f"thiếu {name}")
    return s or None


def open_incident(conn, *, title, severity, source, ben, detected_at,
                  occurred_at=None, by, now: datetime) -> int:
    if severity not in SEVERITIES:
        raise IncidentError(f"--severity chỉ nhận {', '.join(SEVERITIES)}")
    if ben not in BEN:
        raise IncidentError(f"--ben chỉ nhận {', '.join(BEN)}")
    det = parse_ts(detected_at, "--detected-at")
    occ = parse_ts(occurred_at, "--occurred-at") if occurred_at else None
    if det > now + FUTURE_SKEW:
        raise IncidentError("--detected-at ở tương lai")
    if occ is not None and occ > det:
        raise IncidentError("--occurred-at phải trước/bằng --detected-at")
    row = (_text(title, "--title", TITLE_MAX), severity,
           _text(source, "--source", SOURCE_MAX), ben, occ, det, _by(by))
    iid = conn.execute(
        "insert into ops_incidents (title, severity, source, ben_trach_nhiem,"
        " occurred_at, detected_at, created_by) values (%s, %s, %s, %s, %s,"
        " %s, %s) returning id", row).fetchone()[0]
    conn.commit()
    return iid


def add_event(conn, incident_id, kind, *, by, at=None, note=None,
              now: datetime) -> int:
    if kind not in KINDS:
        raise IncidentError(f"--kind chỉ nhận {', '.join(KINDS)}")
    by = _by(by)
    ts = parse_ts(at, "--at") if at else now
    if ts > now + FUTURE_SKEW:
        raise IncidentError("--at ở tương lai")
    row = conn.execute("select detected_at from ops_incidents where id = %s",
                       (int(incident_id),)).fetchone()
    if row is None:
        conn.commit()
        raise IncidentError(f"không có sự cố #{incident_id}")
    if ts < row[0]:
        conn.commit()
        raise IncidentError("--at trước lúc phát hiện sự cố")
    eid = conn.execute(
        "insert into ops_incident_events (incident_id, kind, at, by_name,"
        " note) values (%s, %s, %s, %s, %s) returning id",
        (int(incident_id), kind, ts, by,
         _text(note, "--note", NOTE_MAX, required=False))).fetchone()[0]
    conn.commit()
    return eid


_INC_SQL = (
    "select id, title, severity, source, ben_trach_nhiem, occurred_at,"
    " detected_at from ops_incidents where detected_at >= %s"
    " and detected_at < %s order by detected_at, id")
_EV_SQL = (
    "select e.incident_id, e.kind, e.at from ops_incident_events e"
    " join ops_incidents i on i.id = e.incident_id"
    " where i.detected_at >= %s and i.detected_at < %s order by e.at, e.id")


def load(conn, start: datetime, end: datetime) -> dict:
    """CHỈ SELECT — sự cố phát hiện trong [start, end) + sự kiện của chúng."""
    incs = conn.execute(_INC_SQL, (start, end)).fetchall()
    evs = conn.execute(_EV_SQL, (start, end)).fetchall()
    return {"incidents": incs, "events": evs}


def _first(events, iid, kind):
    ts = [at for i, k, at in events if i == iid and k == kind]
    return min(ts) if ts else None


def evaluate(incidents, events, shift, now: datetime) -> list[dict]:
    """THUẦN → mỗi sự cố {id, severity, ben, detect, respond, fix,
    customer_resolved_at}; trạng thái ∈ ok|late|pending|unmeasured."""
    from pipelines.rollout import business_days
    out = []
    for iid, _t, sev, _src, ben, occ, det in incidents:
        r = {"id": iid, "severity": sev, "ben": ben}
        r["detect"] = ("unmeasured" if occ is None else
                       "ok" if det - occ <= DETECT_LIMIT else "late")
        resp = _first(events, iid, "responded")
        if sev == "nghiem_trong":
            due = det + RESPOND_SEVERE
            r["respond"] = ("ok" if resp is not None and resp <= due else
                            "late" if resp is not None or now > due else
                            "pending")
        else:
            end = resp if resp is not None else now
            within = business_days(det, end, shift) <= RESPOND_NORMAL_WORKDAYS
            r["respond"] = ("ok" if resp is not None and within else
                            "pending" if resp is None and within else "late")
        fix = _first(events, iid, "fixed")
        due = det + FIX_LIMIT
        r["fix"] = ("ok" if fix is not None and fix <= due else
                    "late" if fix is not None or now > due else "pending")
        r["customer_resolved_at"] = _first(events, iid, "customer_resolved")
        out.append(r)
    return out


def summarize(rows: list[dict], key: str, severity: str | None = None
              ) -> dict:
    c = {"ok": 0, "late": 0, "pending": 0, "unmeasured": 0}
    for r in rows:
        if severity is None or r["severity"] == severity:
            c[r[key]] += 1
    return c


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.ops_incidents",
                                 description="Sổ sự cố vận hành (PL02 mục 2)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--open", action="store_true", help="ghi sự cố mới")
    g.add_argument("--event", type=int, metavar="ID",
                   help="ghi mốc phản hồi/sửa/xử lý khách cho sự cố ID")
    g.add_argument("--list", action="store_true", help="liệt kê + SLA")
    ap.add_argument("--title")
    ap.add_argument("--severity", choices=SEVERITIES)
    ap.add_argument("--source")
    ap.add_argument("--ben", choices=BEN)
    ap.add_argument("--detected-at")
    ap.add_argument("--occurred-at")
    ap.add_argument("--kind", choices=KINDS)
    ap.add_argument("--at")
    ap.add_argument("--note")
    ap.add_argument("--by")
    ap.add_argument("--month", help="YYYY-MM cho --list (mặc định tháng này)")
    args = ap.parse_args(argv)
    if args.open and not all((args.title, args.severity, args.source,
                              args.ben, args.detected_at, args.by)):
        ap.error("--open cần --title --severity --source --ben --detected-at"
                 " --by")
    if args.event is not None and not (args.kind and args.by):
        ap.error("--event cần --kind --by")
    from ingest.lead_store import connect
    from pipelines import period
    now = datetime.now(VN_TZ)
    start = end = None
    if args.list:
        try:
            ref = (date.fromisoformat(f"{args.month}-01")
                   if args.month else now.date())
        except ValueError:
            ap.error("--month cần YYYY-MM")
        start, end = period.period_bounds("month", ref.replace(day=1))
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres", flush=True)
        return 1
    try:
        if args.open:
            iid = open_incident(
                conn, title=args.title, severity=args.severity,
                source=args.source, ben=args.ben,
                detected_at=args.detected_at, occurred_at=args.occurred_at,
                by=args.by, now=now)
            print(f"[done] đã ghi sự cố #{iid}", flush=True)
            return 0
        if args.event is not None:
            eid = add_event(conn, args.event, args.kind, by=args.by,
                            at=args.at, note=args.note, now=now)
            print(f"[done] sự cố #{args.event}: ghi mốc {args.kind} "
                  f"(#{eid})", flush=True)
            return 0
        from pipelines.rollout import holiday_warning, load_shift
        data = load(conn, start, end)
        rows = evaluate(data["incidents"], data["events"], load_shift(), now)
        print(f"[list] {len(rows)} sự cố phát hiện trong {start:%m/%Y}")
        for r in rows:
            cr = r["customer_resolved_at"]
            print(f"  #{r['id']} {r['severity']} ({r['ben']}): phát hiện "
                  f"{r['detect']} · phản hồi {r['respond']} · sửa {r['fix']}"
                  f" · xử lý khách {'xong' if cr else 'chưa ghi'}")
        if w := holiday_warning():
            print(f"[warn] {w}")
        return 0
    except IncidentError as e:
        print(f"[warn] {e} — không ghi", flush=True)
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
