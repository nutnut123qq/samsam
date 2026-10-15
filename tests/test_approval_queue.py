"""v4.0 W40.3 — `pipelines.approval_queue` qua fake conn + argparse (không
cần DB; đường DB thật ở tests/test_director_framework.py)."""

from contextlib import nullcontext

import psycopg
import pytest

from pipelines import approval_queue as aq
from pipelines.guardrail import check as guardrail_check

SAFE = "Hộp quà Sâm Ngọc Linh dịp Tết"
BAD = "Sâm chữa khỏi tiểu đường"


class _Cur:
    def __init__(self, rows):
        self.rows = rows

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeConn:
    """Route theo substring SQL → rows; `raise_on` substring → psycopg lỗi."""

    def __init__(self, routes=None, raise_on=None):
        self.routes = routes or {}
        self.raise_on = raise_on
        self.calls = []
        self.commits = 0

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if self.raise_on and self.raise_on in sql:
            raise psycopg.errors.RaiseException("mục #1 quá hạn SLA")
        for key, rows in self.routes.items():
            if key in sql:
                return _Cur(rows)
        return _Cur([])

    def transaction(self):
        return nullcontext()

    def commit(self):
        self.commits += 1


def _kw(**over):
    kw = {"object_type": "b2b_quote", "object_id": "Q-1", "block": "sales",
          "title": "Báo giá", "payload": SAFE, "risk": "high",
          "created_by": "agent:a3", "sla_hours": 24}
    kw.update(over)
    return kw


def test_enqueue_computes_guardrail_itself():
    for payload in (SAFE, BAD):
        conn = FakeConn({"enqueue_item": [(7,)]})
        assert aq.enqueue(conn, **_kw(payload=payload)) == 7
        sql, params = conn.calls[-1]
        assert "enqueue_item" in sql
        assert params[6].obj == guardrail_check(payload)
        assert params[8] == "agent:a3" and params[9] == 24
        assert conn.commits == 1
    assert conn.calls[-1][1][6].obj["ok"] is False   # BAD vẫn vào hàng


@pytest.mark.parametrize("over", [{"created_by": "  "}, {"created_by": None},
                                  {"payload": "   "}, {"payload": ""}])
def test_enqueue_rejects_blank_before_db(over):
    conn = FakeConn()
    with pytest.raises(ValueError):
        aq.enqueue(conn, **_kw(**over))
    assert conn.calls == [] and conn.commits == 0


def test_decide_rechecks_payload_not_snapshot():
    """DB snapshot nói ok:true nhưng payload có từ cấm → không gọi
    decide_item."""
    conn = FakeConn({"select payload": [(BAD,)],
                     "guardrail": [({"ok": True},)]})
    ok, msg = aq.decide(conn, 1, "Hoa", "approved")
    assert not ok and "kiểm lại" in msg
    assert not any("decide_item" in s for s, _ in conn.calls)
    assert conn.commits == 0


def test_decide_happy_and_reject_skips_recheck():
    conn = FakeConn({"select payload": [(SAFE,)], "decide_item": [(3,)]})
    assert aq.decide(conn, "1", " Hoa ", "approved", "ok") == (True, None)
    sql, params = conn.calls[-1]
    assert "decide_item" in sql and params == (1, "Hoa", "approved", "ok")
    conn = FakeConn({"decide_item": [(4,)]})
    assert aq.decide(conn, 2, "Hoa", "rejected") == (True, None)
    assert not any("select payload" in s for s, _ in conn.calls)


def test_decide_function_error_returns_message():
    conn = FakeConn({"select payload": [(SAFE,)]}, raise_on="decide_item")
    ok, msg = aq.decide(conn, 1, "Hoa", "approved")
    assert not ok and "quá hạn SLA" in msg and conn.commits == 0


@pytest.mark.parametrize("args,frag", [
    ((1, "  ", "approved"), "thiếu"),
    ((1, "Hoa", "expired"), "không hợp lệ"),
    (("x", "Hoa", "approved"), "không hợp lệ"),
])
def test_decide_bad_input_no_db(args, frag):
    conn = FakeConn()
    ok, msg = aq.decide(conn, *args)
    assert not ok and frag in msg and conn.calls == []


def test_decide_not_found():
    ok, msg = aq.decide(FakeConn(), 5, "Hoa", "approved")
    assert not ok and "không tìm thấy" in msg


def test_override_auto_expire_verify():
    conn = FakeConn(raise_on="override_qa")
    ok, msg = aq.override(conn, 1, "Hoa", "lý do đủ dài để ép trình")
    assert ok is False and "quá hạn" in msg            # lỗi function → msg
    # Lý do toàn khoảng trắng (\n/\t — btrim không cắt) hoặc ngắn: chặn
    # TRƯỚC khi chạm DB.
    for reason in ("ngắn", "\n" * 12, "\t" * 10, " \r\n\t" * 5, None,
                   "  12345  6789 \n"):
        conn = FakeConn()
        ok, msg = aq.override(conn, 1, "Hoa", reason)
        assert ok is False and "10 ký tự" in msg, repr(reason)
        assert conn.calls == [], repr(reason)
    conn = FakeConn({"auto_approve_item": [(9,)]})
    assert aq.auto_approve(conn, 1) == (True, None)
    conn = FakeConn({"expire_overdue": [(2,)]})
    assert aq.expire_overdue(conn) == 2 and conn.commits == 1
    assert conn.calls[-1][1] == ("system:sla",)
    assert aq.verify(FakeConn(), "x", "t") is False
    assert aq.verify(FakeConn(), 1, "t") is False          # không thấy mục
    conn = FakeConn({"object_type, object_id": [("b2b_quote", "Q-1")],
                     "verify_publish": [(True,)]})
    assert aq.verify(conn, 1, SAFE) is True
    assert conn.calls[-1][1] == ("b2b_quote", "Q-1", SAFE)


def test_pending_truncates_payload():
    conn = FakeConn({"from approval_queue": []})
    assert aq.pending(conn, "sales") == []
    sql, params = conn.calls[-1]
    assert "left(payload, %s)" in sql and params == [aq.PREVIEW, "sales"]


# ---------- CLI: lỗi tham số → exit 2 TRƯỚC connect ----------

@pytest.fixture
def no_connect(monkeypatch):
    monkeypatch.setattr(aq, "connect", lambda: pytest.fail("connect gọi"))


@pytest.mark.parametrize("argv", [
    [],
    ["--approve", "1"],
    ["--reject", "1", "--by", "  "],
    ["--approve", "1", "--by", "X", "--expire"],
    ["--pending", "--expire"],
    ["--override-qa", "1", "--by", "X"],
    ["--override-qa", "1", "--by", "X", "--reason", "  "],
])
def test_cli_usage_exit_2_before_connect(no_connect, argv):
    with pytest.raises(SystemExit) as e:
        aq.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit_2(monkeypatch, capsys):
    monkeypatch.setattr(aq, "connect", lambda: None)
    assert aq.main(["--pending"]) == 2
    assert "không kết nối" in capsys.readouterr().err


def test_cli_decision_error_exit_1(monkeypatch, capsys):
    monkeypatch.setattr(aq, "connect", lambda: FakeConn())
    assert aq.main(["--approve", "5", "--by", "Hoa"]) == 1
    assert "không tìm thấy" in capsys.readouterr().err
