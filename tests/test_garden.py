"""v2.1-garden-log (W4.x) — `agents.garden`: normalize vocab/alias,
add_log fake-conn (happy + FK/unique → warnings không raise), flags_for
keyword, anomaly_check đủ nhánh no-logs/gap/fresh/keyword, shape helpers.
Không cần DB thật."""

from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

import psycopg

from agents import garden as g

UTC = timezone.utc
NOW = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
S_DT = datetime(2026, 10, 9, 8, 30, tzinfo=UTC)


class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    """Route theo (MỌI substring khớp, params đúng nếu khai báo)."""

    def __init__(self, routes=()):
        self.routes = list(routes)
        self.calls = []
        self.committed = 0

    def execute(self, sql, params=None):
        self.calls.append((sql, tuple(params or ())))
        for subs, want, rows in self.routes:
            if want is not None and tuple(params or ()) != want:
                continue
            if all(s in sql for s in subs):
                return _Cur(rows)
        raise AssertionError(f"no route: {sql!r} params={params!r}")

    @contextmanager
    def transaction(self):
        yield

    def commit(self):
        self.committed += 1


class _ErrConn:
    """execute raise psycopg error cố định (FK/unique)."""

    def __init__(self, exc):
        self.exc = exc

    def execute(self, *a):
        raise self.exc

    @contextmanager
    def transaction(self):
        yield


def _route(*subs, params=None, rows=()):
    return (subs, params, rows)


# ---------- normalize_activity / _coerce_ts / flags_for ----------

def test_normalize_activity():
    assert g.normalize_activity("tưới") == ("tưới", True)
    assert g.normalize_activity("TUOI NUOC") == ("tưới", True)
    assert g.normalize_activity("sau benh") == ("kiểm tra sâu bệnh", True)
    assert g.normalize_activity("Làm Cỏ") == ("làm cỏ", True)
    assert g.normalize_activity("đắp mô") == ("đắp mô", False)
    assert g.normalize_activity("") == ("ghi nhận", False)
    assert g.normalize_activity(None) == ("ghi nhận", False)


def test_coerce_ts_variants():
    # naive → coi UTC (DTZ001: cố ý tạo naive để test coerce).
    naive = datetime(2026, 10, 9)  # noqa: DTZ001
    assert g._coerce_ts(naive) == naive.replace(tzinfo=UTC)
    assert g._coerce_ts(date(2026, 10, 9)) == datetime(
        2026, 10, 9, tzinfo=UTC)
    assert g._coerce_ts("2026-10-09T01:02:03Z") == datetime(
        2026, 10, 9, 1, 2, 3, tzinfo=UTC)
    assert g._coerce_ts("2026-10-09") == datetime(
        2026, 10, 9, tzinfo=UTC)
    assert g._coerce_ts("09/10/2026") is None
    assert g._coerce_ts(None) is None
    assert g._coerce_ts("") is None


def test_flags_for_activity_and_detail():
    # 'bệnh' là substring của 'sâu bệnh' → cả hai hit theo thứ tự list.
    assert g.flags_for("kiểm tra sâu bệnh", None) == [
        "sâu bệnh", "bệnh"]
    assert g.flags_for("tưới", "phát hiện rệp vùng rìa") == ["rệp"]
    assert g.flags_for("tưới", "") == []
    assert g.flags_for("tưới", None) == []


# ---------- add_log ----------

def test_add_log_happy_normalized():
    conn = _Conn([_route("insert into plot_logs", rows=[(42,)])])
    lid, warns = g.add_log(conn, " KV-A01 ", S_DT, "tuoi nuoc",
                           "sáng", "Minh")
    assert lid == 42
    assert warns == []
    # add_log phải commit() tường minh — caller có thể đang trong tx
    # ngoài (SELECT trước) thì with-transaction chỉ là savepoint.
    assert conn.committed == 1
    sql, params = conn.calls[0]
    assert "insert into plot_logs" in sql and "returning id" in sql
    assert params[:4] == ("KV-A01", S_DT, "tưới", "sáng")
    assert params[4] == "Minh" and params[5] == "manual:garden"


def test_add_log_unknown_activity_warns_but_inserts():
    conn = _Conn([_route("insert into plot_logs", rows=[(7,)])])
    lid, warns = g.add_log(conn, "KV-A01", S_DT, "đắp mô", None, None)
    assert lid == 7
    assert any("chưa có trong vocab" in w for w in warns)
    # detail/author rỗng → NULL chứ không phải chuỗi rỗng.
    assert conn.calls[0][1][3] is None and conn.calls[0][1][4] is None


def test_add_log_keyword_flag_in_warnings():
    conn = _Conn([_route("insert into plot_logs", rows=[(8,)])])
    lid, warns = g.add_log(conn, "KV-A01", S_DT, "kiểm tra sâu bệnh",
                           "phát hiện rệp")
    assert lid == 8
    assert any("cần chú ý" in w and "rệp" in w for w in warns)


def test_add_log_fk_violation_friendly_no_raise():
    conn = _ErrConn(psycopg.errors.ForeignKeyViolation("fk"))
    lid, warns = g.add_log(conn, "KV-XX", S_DT, "tưới")
    assert lid is None
    assert any("không tồn tại" in w for w in warns)


def test_add_log_unique_violation_friendly_no_raise():
    conn = _ErrConn(psycopg.errors.UniqueViolation("dup"))
    lid, warns = g.add_log(conn, "KV-A01", S_DT, "tưới")
    assert lid is None
    assert any("trùng" in w for w in warns)


def test_add_log_bad_input_no_insert():
    conn = _Conn([])
    lid, warns = g.add_log(conn, "  ", S_DT, "tưới")
    assert lid is None and warns == ["thiếu --plot"]
    lid, warns = g.add_log(conn, "KV-A01", "not-a-date", "tưới")
    assert lid is None and any("ts không hợp lệ" in w for w in warns)
    assert conn.calls == []            # không execute khi input hỏng


# ---------- collect helpers ----------

def test_active_plots_and_recent_logs_passthrough():
    conn = _Conn([
        _route("from plots", "status = 'active'",
               rows=[("KV-A", "khu A"), ("KV-B", "")]),
        _route("from plot_logs", "limit %s",
               rows=[(S_DT, "KV-A", "tưới", "d", "a",
                      "manual:garden")]),
    ])
    assert g.active_plots(conn) == [("KV-A", "khu A"), ("KV-B", "")]
    rows = g.recent_logs(conn, limit=5)
    assert rows[0][1] == "KV-A" and rows[0][5] == "manual:garden"
    assert conn.calls[1][1] == (5,)


def test_anomaly_check_branches():
    horizon = NOW - timedelta(days=14)
    conn = _Conn([
        _route("from plots", "status = 'active'",
               rows=[("KV-A", "a"), ("KV-B", "b"), ("KV-C", "c")]),
        _route("max(ts)",
               rows=[("KV-A", NOW - timedelta(days=20)),
                     ("KV-B", NOW - timedelta(days=1))]),
        # KV-C vắng trong max-map → 'no-logs'.
        _route("order by ts desc", params=(horizon,),
               rows=[(NOW - timedelta(days=2), "KV-A",
                      "kiểm tra sâu bệnh", "phát hiện rệp")]),
    ])
    items = g.anomaly_check(conn, gap_days=14, now=NOW)
    by_type = {}
    for it in items:
        by_type.setdefault(it["type"], []).append(it["plot"])
    assert by_type["gap"] == ["KV-A"]
    assert by_type["no-logs"] == ["KV-C"]
    assert by_type["keyword"] == ["KV-A"]
    assert "KV-B" not in [p for v in by_type.values() for p in v]
    # Message thân thiện cho người đọc.
    gap_msg = next(i["msg"] for i in items if i["type"] == "gap")
    assert "20 ngày" in gap_msg


def test_anomaly_check_no_anomaly():
    conn = _Conn([
        _route("from plots", "status = 'active'",
               rows=[("KV-A", "a")]),
        _route("max(ts)", rows=[("KV-A", NOW - timedelta(days=1))]),
        _route("order by ts desc",
               rows=[(NOW - timedelta(days=1), "KV-A", "tưới",
                      "bình thường")]),
    ])
    assert g.anomaly_check(conn, now=NOW) == []
