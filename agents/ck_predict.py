"""v11.0 CK-A5 (WP17) — bảo trì dự đoán BƯỚC 1: quy tắc trên lịch sử sự cố.

Contract:
  - Nguồn: view `downtime_log` (sự cố ĐÃ ĐÓNG — CMMS v9.5) + `machines`
    active. KHÔNG đọc `incidents.description`/`reported_by`. Không PLC/
    cảm biến (bước 2 = external-dep), không LLM, không mạng.
  - `data_status(rows, *, now)`: bỏ dòng tương lai; `coverage_days` = ngày
    VN của `now` − ngày VN sự cố sớm nhất; BẬT ⇔ có sự cố ∧ coverage >=
    `MIN_DAYS`. Chưa bật → báo cáo "ĐÃ XÂY, CHƯA BẬT" + số liệu thiếu, 0
    danh sách máy, 0 backtest, `--submit` bị từ chối (exit 1).
  - `score(rows, machines, *, now)` (chỉ khi bật): trong `WINDOW_DAYS` —
    >= `REPEAT_MIN` sự cố; cùng bộ phận lặp >= `REPEAT_MIN`; tổng downtime
    >= `DOWNTIME_MIN_PHUT` phút; lần kế dự kiến (sự cố cuối + trung vị khoảng
    cách) trong `SOON_DAYS` ngày. Đầu ra chỉ là GỢI Ý đưa bảo trì lên sớm —
    Kỹ sư trưởng quyết; agent không ra lệnh vận hành máy.
  - `backtest(rows, machines, *, now)`: cắt tại `now − BACKTEST_DAYS`, chấm
    `score` trên dữ liệu trước mốc, so máy có sự cố sau mốc → precision/
    recall (mẫu số 0 → "không xác định").
  - Ngưỡng là GIẢ ĐỊNH — Kỹ sư trưởng chốt (external-dep):
    MIN_DAYS 90 (≈3 tháng), WINDOW_DAYS 90, REPEAT_MIN 2,
    DOWNTIME_MIN_PHUT 240, SOON_DAYS 14, BACKTEST_DAYS 30.

Chạy: python -m agents.ck_predict [--date YYYY-MM-DD] [--submit]
Exit: 0 ok · 1 từ chối submit khi chưa bật / lỗi cấu hình · 2 usage / DB down.
"""

import argparse
import datetime as dt
import hashlib
import itertools
import re
import statistics
import sys
from contextlib import suppress

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.job_runs import job_run
from pipelines.pii import _mask_pii
from pipelines.production import TZ_VN

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

AGENT = "agent:CK-A5"
BLOCK = "mechanical"
OBJECT_TYPE = "maintenance_risk"
MIN_DAYS = 90
WINDOW_DAYS = 90
REPEAT_MIN = 2
DOWNTIME_MIN_PHUT = 240
SOON_DAYS = 14
BACKTEST_DAYS = 30
SUGGEST = "đề xuất đưa bảo trì lên sớm — Kỹ sư trưởng quyết"
UNKNOWN = "không xác định"


def _utc(ts: dt.datetime) -> dt.datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)


def _day(ts: dt.datetime) -> dt.date:
    return _utc(ts).astimezone(TZ_VN).date()


def _past(rows, now):
    return [r for r in rows if _utc(r["started_at"]) <= now]


def data_status(rows, *, now: dt.datetime) -> dict:
    past = _past(rows, now)
    if not past:
        return {"enabled": False, "n": 0, "first": None, "last": None,
                "coverage_days": 0, "need_days": MIN_DAYS}
    first = min(_utc(r["started_at"]) for r in past)
    last = max(_utc(r["started_at"]) for r in past)
    cov = (_day(now) - _day(first)).days
    return {"enabled": cov >= MIN_DAYS, "n": len(past),
            "first": _day(first).isoformat(), "last": _day(last).isoformat(),
            "coverage_days": cov, "need_days": MIN_DAYS}


_SUA_CHUA_RE = re.compile(r"(?i)sửa\s+chữa")


def _part(p) -> str:
    """Nhãn bộ phận cho payload duyệt. Ghi chú kỹ thuật hay có từ cấm của
    guardrail TPBVSK ('sửa chữa' ∋ 'chữa', 'bơm thuốc' ∋ 'thuốc') — payload
    trượt guardrail thì mục kẹt pending mãi (duyệt kiểm lại sẽ từ chối).
    'sửa chữa' → 'sửa'; còn trượt → mã trung tính (vẫn gom nhóm được)."""
    k = " ".join(_mask_pii(str(p)).split())[:60]
    k = _SUA_CHUA_RE.sub("sửa", k)
    if guardrail.check(k).get("ok") is not True:
        k = "mã " + hashlib.sha256(k.encode("utf-8")).hexdigest()[:8]
    return k


def score(rows, machines, *, now: dt.datetime) -> list[dict]:
    """→ [{machine_code, level, reasons, suggest, next_expected}] chỉ máy
    active có >= 1 lý do; sắp theo (số lý do giảm dần, mã máy)."""
    since = now - dt.timedelta(days=WINDOW_DAYS)
    active = {m["code"] for m in machines if m.get("active", True)}
    by: dict[str, list] = {}
    for r in _past(rows, now):
        if r["machine_code"] in active and _utc(r["started_at"]) > since:
            by.setdefault(r["machine_code"], []).append(r)
    out = []
    for code, rs in by.items():
        rs.sort(key=lambda r: _utc(r["started_at"]))
        reasons, nxt = [], None
        if len(rs) >= REPEAT_MIN:
            reasons.append(f"{len(rs)} sự cố trong {WINDOW_DAYS} ngày")
        parts: dict[str, int] = {}
        for r in rs:
            if r.get("part"):
                k = _part(r["part"])
                parts[k] = parts.get(k, 0) + 1
        for k in sorted(parts):
            if parts[k] >= REPEAT_MIN:
                reasons.append(f"bộ phận '{k}' lặp {parts[k]} lần")
        tot = sum(r.get("downtime_phut") or 0 for r in rs)
        if tot >= DOWNTIME_MIN_PHUT:
            reasons.append(f"tổng downtime {tot} phút")
        if len(rs) >= 2:
            ts = [_utc(r["started_at"]) for r in rs]
            gap = statistics.median((b - a).total_seconds()
                                    for a, b in itertools.pairwise(ts))
            nxt = ts[-1] + dt.timedelta(seconds=gap)
            if nxt <= now + dt.timedelta(days=SOON_DAYS):
                reasons.append(f"lần kế dự kiến ~{_day(nxt).isoformat()} "
                               f"(trong {SOON_DAYS} ngày)")
        if reasons:
            out.append({"machine_code": code, "reasons": reasons,
                        "level": "cao" if len(reasons) >= 2 else "theo dõi",
                        "suggest": SUGGEST,
                        "next_expected": _day(nxt).isoformat() if nxt
                        else None})
    out.sort(key=lambda d: (-len(d["reasons"]), d["machine_code"]))
    return out


def _ratio(a: int, b: int):
    return round(a / b, 3) if b else UNKNOWN


def backtest(rows, machines, *, now: dt.datetime) -> dict:
    cut = now - dt.timedelta(days=BACKTEST_DAYS)
    past = _past(rows, now)
    train = [r for r in past if _utc(r["started_at"]) < cut]
    test = [r for r in past if _utc(r["started_at"]) >= cut]
    active = {m["code"] for m in machines if m.get("active", True)}
    pred = {d["machine_code"] for d in score(train, machines, now=cut)}
    actual = {r["machine_code"] for r in test} & active
    tp, fp, fn = len(pred & actual), len(pred - actual), len(actual - pred)
    first = min((_day(r["started_at"]) for r in train), default=None)
    return {"tp": tp, "fp": fp, "fn": fn,
            "precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn),
            "train_range": (f"{first.isoformat() if first else '—'} → "
                            f"{(_day(cut) - dt.timedelta(days=1)).isoformat()}"),
            "test_range": f"{_day(cut).isoformat()} → {_day(now).isoformat()}",
            "n_train": len(train), "n_test": len(test)}


def render(status: dict, risks, bt, *, now: dt.datetime) -> str:
    day = _day(now).isoformat()
    L = [f"# CK-A5 bảo trì dự đoán (bước 1, quy tắc) — {day}", ""]
    rng = (f"từ {status['first']} đến {status['last']}" if status["n"]
           else "chưa có sự cố đã đóng")
    if not status["enabled"]:
        L += [(f"**CK-A5: ĐÃ XÂY, CHƯA BẬT — downtime_log có "
              f"{status['coverage_days']} ngày / cần ≥ {MIN_DAYS} ngày "
              f"({status['n']} sự cố, {rng})**"), "",
              ("- Chưa đủ dữ liệu: không lập danh sách máy rủi ro, không "
              "backtest."),
              ("- Bằng chứng thiếu dữ liệu: số ngày phủ và số sự cố ở trên đọc"
              " trực tiếp từ view `downtime_log` (sự cố đã đóng)."), ""]
    else:
        L += [(f"Dữ liệu: downtime_log {status['coverage_days']} ngày "
              f"({status['n']} sự cố, {rng}) — đã bật."), "",
              f"## Máy có rủi ro ({len(risks)})", ""]
        for r in risks:
            L.append(f"- {r['machine_code']} [{r['level']}]: "
                     f"{'; '.join(r['reasons'])} → {r['suggest']}")
        if not risks:
            L.append("- (không có máy vượt ngưỡng)")
        L += ["", f"## Backtest (cắt {BACKTEST_DAYS} ngày gần nhất)", "",
              f"- train: {bt['train_range']} ({bt['n_train']} sự cố)",
              f"- test: {bt['test_range']} ({bt['n_test']} sự cố)",
              f"- TP {bt['tp']} · FP {bt['fp']} · FN {bt['fn']}",
              f"- precision: {bt['precision']} · recall: {bt['recall']}", ""]
    L += ["## Quy tắc (GIẢ ĐỊNH — Kỹ sư trưởng chốt)", "",
          (f"- bật khi downtime_log ≥ {MIN_DAYS} ngày; cửa sổ {WINDOW_DAYS} "
          f"ngày; lặp ≥ {REPEAT_MIN}; tổng downtime ≥ {DOWNTIME_MIN_PHUT} "
          f"phút; lần kế dự kiến trong {SOON_DAYS} ngày"),
          ("- Chỉ gợi ý lịch bảo trì; agent không ra lệnh vận hành máy. "
          "Cảm biến/giờ chạy máy = bước 2 (external-dep)."), ""]
    return "\n".join(L)


# ---------- DB ----------

def load_downtime(conn) -> tuple[list[dict], list[dict]]:
    rows = [dict(zip(("machine_code", "started_at", "ended_at",
                      "downtime_phut", "part"), r)) for r in conn.execute(
        "select machine_code, started_at, ended_at, downtime_phut, part"
        " from downtime_log order by started_at").fetchall()]
    machines = [{"code": c, "active": True} for (c,) in conn.execute(
        "select code from machines where active order by code").fetchall()]
    return rows, machines


def submit(conn, day: str, text: str) -> tuple[str, int]:
    oid = f"ck-a5:{day}"
    row = conn.execute(
        "select id from approval_queue where block = %s and object_type = %s"
        " and object_id = %s and status = 'pending' order by id limit 1",
        (BLOCK, OBJECT_TYPE, oid)).fetchone()
    if row:
        conn.commit()
        return "skipped", row[0]
    qid = director.submit(conn, BLOCK, OBJECT_TYPE, oid,
                          f"CK-A5 máy có rủi ro {day}", text,
                          created_by=AGENT)
    conn.commit()
    return "pending", qid


# ---------- CLI ----------

def _date(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from e
    if not dt.date(2000, 1, 1) <= d <= dt.date(2100, 12, 31):
        raise argparse.ArgumentTypeError("ngày ngoài khoảng hợp lệ")
    return d


def main(argv=None, now: dt.datetime | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ck_predict",
        description="CK-A5 bảo trì dự đoán bước 1 (quy tắc trên downtime_log;"
                    " chỉ bật khi đủ 90 ngày dữ liệu)")
    ap.add_argument("--date", type=_date, help="ngày chấm (giờ VN)")
    ap.add_argument("--submit", action="store_true",
                    help="đẩy danh sách máy rủi ro vào hàng duyệt mechanical")
    a = ap.parse_args(argv)
    if a.date:
        now = dt.datetime.combine(a.date, dt.time(23, 59), TZ_VN)
    now = now or dt.datetime.now(TZ_VN)
    conn = connect()
    if conn is None:
        print("[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc "
              "host chết)", file=sys.stderr)
        return 2
    try:
        rows, machines = load_downtime(conn)
        conn.commit()
        st = data_status(rows, now=now)
        risks, bt = [], None
        if st["enabled"]:
            risks = score(rows, machines, now=now)
            bt = backtest(rows, machines, now=now)
        text = render(st, risks, bt, now=now)
        day = _day(now).isoformat()
        path = write_report(text, REPORTS_DIR, f"ck-a5-{day}.md")
        print(text)
        print(f"[write] {path}")
        if a.submit:
            if not st["enabled"]:
                print("[err] chưa đủ 3 tháng dữ liệu — từ chối bật "
                      f"({st['coverage_days']}/{MIN_DAYS} ngày)",
                      file=sys.stderr)
                return 1
            if not risks:
                print("[submit] 0 máy rủi ro — không đẩy hàng duyệt")
                return 0
            g = guardrail.check(text)
            if g.get("ok") is not True:     # parity VT — không đẩy mục kẹt
                print(f"[err] bản rủi ro không qua guardrail "
                      f"({len(g.get('violations') or [])} vi phạm)",
                      file=sys.stderr)
                return 1
            s, qid = submit(conn, day, text)
            print(f"[submit] {s} #{qid} ({BLOCK}/{OBJECT_TYPE})")
    except psycopg.Error as e:
        print(f"[warn] lỗi DB ({type(e).__name__})", file=sys.stderr)
        return 2
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[err] không ghi được báo cáo ({type(e).__name__})",
              file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    return 0


if __name__ == "__main__":
    with job_run("agents.ck_predict") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
