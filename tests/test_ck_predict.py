"""v11.0 W110.3 — CK-A5 bảo trì dự đoán bước 1 (`agents.ck_predict`).

`now` LUÔN là tham số (không đồng hồ): 6 tuần → chưa bật; biên 89/90 ngày;
≥ 3 tháng → máy rủi ro + backtest đếm tay. DB THẬT trong schema tạm
(schema.sql + roles.sql) → ROLLBACK cuối test.
"""

import datetime as dt
import re
from pathlib import Path

import pytest

from agents import ck_predict as ck
from pipelines import approval_queue as aq
from pipelines import guardrail
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "ck_predict.py").read_text(encoding="utf-8")
VN = ck.TZ_VN
T0 = dt.datetime(2026, 6, 1, 8, tzinfo=VN)        # sự cố đầu tiên
A, B, C = "SS-EQ-01", "SS-EQ-02", "SS-EQ-03"
MACHINES = [{"code": A, "active": True}, {"code": B, "active": True},
            {"code": C, "active": True}]


@pytest.fixture
def db():
    yield from da_db()


def _r(code, day, phut=60, part="bạc đạn"):
    s = T0 + dt.timedelta(days=day)
    return {"machine_code": code, "started_at": s,
            "ended_at": s + dt.timedelta(minutes=phut), "downtime_phut": phut,
            "part": part}


# A: 4 sự cố cùng bộ phận, cách đều 20 ngày (ngày 40, 60, 80, 100).
# B: 1 sự cố ngày 0 (mốc phủ dữ liệu), C: 1 sự cố sau mốc backtest.
ROWS = [_r(B, 0, part="dây curoa"), _r(A, 40), _r(A, 60), _r(A, 80),
        _r(A, 100), _r(C, 115, part="cảm biến")]
NOW_ON = T0 + dt.timedelta(days=120)              # 4 tháng


def test_six_weeks_not_enabled_and_score_never_called(monkeypatch,
                                                      tmp_path):
    rows = [_r(A, 0), _r(A, 10), _r(A, 20), _r(B, 30)]
    now = T0 + dt.timedelta(days=42)
    st = ck.data_status(rows, now=now)
    assert st["enabled"] is False and st["coverage_days"] == 42
    assert st["n"] == 4
    calls = []
    monkeypatch.setattr(ck, "score", lambda *a, **k: calls.append(1) or [])
    monkeypatch.setattr(ck, "backtest", lambda *a, **k: calls.append(2))
    monkeypatch.setattr(ck, "connect", lambda: _FakeConn(rows))
    monkeypatch.setattr(ck, "REPORTS_DIR", tmp_path)
    assert ck.main([], now=now) == 0
    assert calls == []
    text = ck.render(st, [], None, now=now)
    assert "ĐÃ XÂY, CHƯA BẬT" in text and "42 ngày / cần ≥ 90 ngày" in text
    assert "(4 sự cố, từ 2026-06-01 đến 2026-07-01)" in text
    assert not re.search(r"SS-EQ-\d+", text)
    assert "precision" not in text


class _FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.sql = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        if "downtime_log" in sql:
            data = [(r["machine_code"], r["started_at"], r["ended_at"],
                     r["downtime_phut"], r["part"]) for r in self.rows]
        else:
            data = [(m["code"],) for m in MACHINES]
        return type("C", (), {"fetchall": lambda s: data})()

    def commit(self):
        pass

    def close(self):
        pass


@pytest.mark.parametrize("days,enabled", [(89, False), (90, True)])
def test_coverage_boundary(days, enabled):
    now = dt.datetime.combine(T0.date() + dt.timedelta(days=days),
                              dt.time(0, 5), VN)
    st = ck.data_status([_r(A, 0)], now=now)
    assert st["coverage_days"] == days and st["enabled"] is enabled


def test_zero_rows_not_enabled():
    st = ck.data_status([], now=NOW_ON)
    assert st == {"enabled": False, "n": 0, "first": None, "last": None,
                  "coverage_days": 0, "need_days": 90}
    assert "(0 sự cố, chưa có sự cố đã đóng)" in ck.render(st, [], None,
                                                          now=NOW_ON)


def test_future_rows_do_not_add_coverage():
    now = T0 + dt.timedelta(days=42)
    rows = [_r(A, 0), {**_r(A, 0), "started_at": now + dt.timedelta(days=1)}]
    st = ck.data_status(rows, now=now)
    assert st["n"] == 1 and st["coverage_days"] == 42
    assert st["last"] == "2026-06-01"


def test_score_rules_and_suggest_only():
    risks = ck.score(ROWS, MACHINES, now=NOW_ON)
    assert [r["machine_code"] for r in risks] == [A]
    a = risks[0]
    assert a["level"] == "cao"
    joined = "; ".join(a["reasons"])
    assert "4 sự cố trong 90 ngày" in joined
    assert "bộ phận 'bạc đạn' lặp 4 lần" in joined
    assert "tổng downtime 240 phút" in joined
    assert "lần kế dự kiến ~2026-09-29" in joined      # 100 + 20 ngày
    assert a["suggest"] == ck.SUGGEST


def test_inactive_machine_not_scored():
    risks = ck.score(ROWS, [{"code": A, "active": False}], now=NOW_ON)
    assert risks == []


def test_backtest_hand_counted():
    # Mốc cắt = ngày 90. Train (< ngày 90): B@0, A@40/60/80 → dự đoán {A}
    # (3 sự cố, bộ phận lặp, lần kế ~ngày 100 trong 14 ngày của mốc).
    # Test (>= ngày 90): A@100, C@115 → thực tế {A, C}.
    bt = ck.backtest(ROWS, MACHINES, now=NOW_ON)
    assert (bt["tp"], bt["fp"], bt["fn"]) == (1, 0, 1)
    assert bt["precision"] == 1.0 and bt["recall"] == 0.5
    assert bt["n_train"] == 4 and bt["n_test"] == 2
    assert bt["train_range"] == "2026-06-01 → 2026-08-29"
    assert bt["test_range"] == "2026-08-30 → 2026-09-29"


def test_backtest_zero_denominator_undefined():
    rows = [_r(B, 0), _r(B, 100)]
    bt = ck.backtest(rows, MACHINES, now=NOW_ON)
    assert (bt["tp"], bt["fp"]) == (0, 0)
    assert bt["precision"] == ck.UNKNOWN
    rows = [_r(B, 0)]
    bt = ck.backtest(rows, MACHINES, now=NOW_ON)
    assert bt["precision"] == ck.UNKNOWN and bt["recall"] == ck.UNKNOWN


def test_render_enabled_has_list_backtest_no_stop_command():
    st = ck.data_status(ROWS, now=NOW_ON)
    assert st["enabled"]
    text = ck.render(st, ck.score(ROWS, MACHINES, now=NOW_ON),
                     ck.backtest(ROWS, MACHINES, now=NOW_ON), now=NOW_ON)
    assert f"- {A} [cao]" in text and "precision: 1.0 · recall: 0.5" in text
    assert "train: 2026-06-01 → 2026-08-29 (4 sự cố)" in text
    assert "dừng máy" not in text.lower()
    assert "ĐÃ XÂY, CHƯA BẬT" not in text


def test_part_text_masked():
    rows = [_r(A, 0, part="gọi 0905123456"), _r(A, 95, part="gọi 0905123456"),
            _r(A, 100, part="gọi 0905123456")]
    risks = ck.score(rows, MACHINES, now=NOW_ON)
    assert "0905123456" not in "; ".join(risks[0]["reasons"])


@pytest.mark.parametrize("part,shown", [
    ("cần sửa chữa bạc đạn", "cần sửa bạc đạn"),
    ("Sửa  chữa motor", "sửa motor"),
    ("bơm thuốc sát trùng", None),          # -> mã trung tính
])
def test_part_with_banned_word_neutralized(part, shown):
    """Finding v11.0 MINOR: ghi chú bộ phận chứa từ cấm TPBVSK làm payload
    trượt guardrail -> mục kẹt pending không duyệt được."""
    rows = [_r(A, 95, part=part), _r(A, 100, part=part)]
    risks = ck.score(rows, MACHINES, now=NOW_ON)
    reasons = "; ".join(risks[0]["reasons"])
    assert guardrail.check(reasons)["ok"] is True
    if shown:
        assert f"bộ phận '{shown}' lặp 2 lần" in reasons
    else:
        assert re.search(r"bộ phận 'mã [0-9a-f]{8}' lặp 2 lần", reasons)
        assert "thuốc" not in reasons


def test_module_no_plc_no_llm_no_http():
    assert not re.search(r"pymodbus|snap7|opcua|modbus|192\.168\.", SRC)
    assert not re.search(r"llm_gateway|import httpx|import requests|\.post\(",
                         SRC)
    # chỉ đọc view downtime_log — không đọc mô tả/người báo của incidents
    assert not re.search(r"(?i)from\s+incidents|reported_by\s*[,f]", SRC)


# ---------------------------------------------------------------- DB


def _use(db, monkeypatch, tmp_path):
    monkeypatch.setattr(ck, "connect", lambda: TxConn(db))
    monkeypatch.setattr(ck, "REPORTS_DIR", tmp_path / "reports")


def _seed(db, rows):
    for code in (A, B, C):
        db.execute("insert into machines (code, name, source) values"
                   " (%s, 'Máy MẪU', 'test-v110')", (code,))
    for r in rows:
        db.execute(
            "insert into incidents (machine_code, started_at, ended_at,"
            " downtime_phut, part, description, reported_by) values"
            " (%s, %s, %s, %s, %s, 'mô tả MẪU', 'nv01')",
            (r["machine_code"], r["started_at"], r["ended_at"],
             r["downtime_phut"], r["part"]))
    # sự cố đang mở — KHÔNG vào downtime_log
    db.execute("insert into incidents (machine_code, started_at) values"
               " (%s, %s)", (B, T0 + dt.timedelta(days=1)))


def _queue(db):
    return db.execute("select block, object_type, status, created_by, risk"
                      " from approval_queue order by id").fetchall()


def _gok(db):
    return [r[0] for r in db.execute("select (guardrail->>'ok')::boolean from approval_queue"
                                     " order by id")]


def test_db_six_weeks_submit_refused(db, monkeypatch, tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    _seed(db, [_r(A, 0), _r(A, 10), _r(A, 20), _r(B, 30)])
    now = T0 + dt.timedelta(days=42)
    assert ck.main(["--submit"], now=now) == 1
    cap = capsys.readouterr()
    assert "chưa đủ 3 tháng dữ liệu — từ chối bật" in cap.err
    assert "ĐÃ XÂY, CHƯA BẬT" in cap.out and "(4 sự cố" in cap.out
    assert _queue(db) == []


def test_db_four_months_submit_pending_then_skipped(db, monkeypatch,
                                                    tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    _seed(db, ROWS)
    assert ck.main(["--submit"], now=NOW_ON) == 0
    assert _queue(db) == [("mechanical", "maintenance_risk", "pending",
                           "agent:CK-A5", "medium")]
    payload = db.execute("select payload from approval_queue").fetchone()[0]
    assert A in payload and "mô tả MẪU" not in payload and "nv01" not in \
        payload
    assert _gok(db) == [True]
    assert (tmp_path / "reports" / "ck-a5-2026-09-29.md").exists()
    assert ck.main(["--submit"], now=NOW_ON) == 0
    assert "skipped" in capsys.readouterr().out
    assert len(_queue(db)) == 1


def test_db_banned_word_part_queued_guardrail_ok_and_approvable(
        db, monkeypatch, tmp_path):
    _use(db, monkeypatch, tmp_path)
    _seed(db, [{**r, "part": "bơm thuốc sát trùng"} if r["machine_code"] == A
               else r for r in ROWS])
    assert ck.main(["--submit"], now=NOW_ON) == 0
    assert _gok(db) == [True]
    qid = db.execute("select id from approval_queue").fetchone()[0]
    ok, msg = aq.decide(TxConn(db), qid, "nguoi_duyet_gia_lap", "approved")
    assert ok, msg


def test_db_payload_failing_guardrail_refused_no_queue(db, monkeypatch,
                                                       tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    _seed(db, ROWS)
    real = ck.render
    monkeypatch.setattr(ck, "render",
                        lambda *a, **k: real(*a, **k) + "\nthuốc\n")
    assert ck.main(["--submit"], now=NOW_ON) == 1
    assert "không qua guardrail" in capsys.readouterr().err
    assert _queue(db) == []


def test_cli_db_down_and_usage(monkeypatch):
    monkeypatch.setattr(ck, "connect", lambda: None)
    assert ck.main([], now=NOW_ON) == 2
    calls = []
    monkeypatch.setattr(ck, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        ck.main(["--date", "29/09/2026"])
    assert e.value.code == 2 and calls == []
