"""v2.2-content-pipeline (W5.2/W5.5) — `pipelines.store`: save/list
fake-conn, set_status transitions đủ nhánh (pending→approved,
pending→rejected, sai-id, non-pending, approve-guardrail-fail, input
xấu, race no-row), schedule (chỉ approved, quá khứ reject), calendar
shape + edge, schema drift guard `content_drafts`. Không cần DB thật."""

import re
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import psycopg

from pipelines import store

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 10, 15)
COLS = store.COLS


def _row(**kw):
    """Tuple đủ COLS; default = draft pending guardrail-ok."""
    base = {"id": 1, "created_at": None, "brief": "b",
            "channel": "facebook", "text": "t",
            "guardrail": {"ok": True, "violations": [],
                          "matched_claims": []},
            "status": "pending", "reviewer": None, "reviewed_at": None,
            "review_note": None, "scheduled_date": None,
            "source": "manual:studio"}
    base.update(kw)
    return tuple(base[c] for c in COLS)


class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    """Route theo (MỌI substring khớp, params đúng nếu khai báo) —
    style test_garden/test_report."""

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


def _route(*subs, params=None, rows=()):
    return (subs, params, rows)


# ---------- save_draft / list_drafts ----------

def test_save_draft_inserts_and_commits():
    conn = _Conn([_route("insert into content_drafts", rows=[(7,)])])
    g = {"ok": True, "violations": [], "matched_claims": []}
    did = store.save_draft(conn, "  brief x ", "facebook", "text bài", g)
    assert did == 7
    # Ghi trên conn chia sẻ phải commit() tường minh — v2.1 precedent.
    assert conn.committed == 1
    sql, params = conn.calls[0]
    assert "returning id" in sql
    assert params[0] == "brief x" and params[1] == "facebook"
    assert params[2] == "text bài" and params[4] == "manual:studio"
    # guardrail bọc Jsonb — fake-conn nhận wrapper, .obj là dict gốc.
    assert getattr(params[3], "obj", params[3]) == g


def test_save_draft_source_cli():
    conn = _Conn([_route("insert into content_drafts", rows=[(8,)])])
    store.save_draft(conn, "b", "tiktok", "t", {}, source="cli")
    assert conn.calls[0][1][4] == "cli"


def test_list_drafts_status_filter_and_shape():
    conn = _Conn([
        _route("from content_drafts", "where status = %s",
               params=("pending", 50), rows=[_row(id=1)]),
    ])
    out = store.list_drafts(conn, status="pending")
    assert len(out) == 1 and out[0]["id"] == 1
    assert out[0]["guardrail"]["ok"] is True
    assert set(out[0]) == set(COLS)
    # status=None → không WHERE, chỉ limit.
    conn2 = _Conn([_route("order by created_at desc", params=(5,),
                          rows=[_row(id=2, status="approved"),
                                  _row(id=1)])])
    out2 = store.list_drafts(conn2, limit=5)
    assert [d["id"] for d in out2] == [2, 1]
    assert "where" not in conn2.calls[0][0].lower()


# ---------- set_status ----------

def test_set_status_approve_happy_atomic_guard():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(1,),
               rows=[_row(id=1)]),
        _route("update content_drafts set status", rows=[(1,)]),
    ])
    ok, warn = store.set_status(conn, 1, "approved", "Lan", "đẹp")
    assert (ok, warn) == (True, None)
    sql, params = conn.calls[1]
    # Double-gate atomic: WHERE status='pending' + guardrail->>'ok'.
    assert "status = 'pending'" in sql
    assert "guardrail->>'ok' = 'true'" in sql
    assert params == ("approved", "Lan", "đẹp", 1)
    assert conn.committed == 1


def test_set_status_reject_happy_no_guardrail_req():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(2,),
               rows=[_row(id=2, guardrail={"ok": False,
                                           "violations": [{}]})]),
        _route("update content_drafts set status", rows=[(2,)]),
    ])
    ok, warn = store.set_status(conn, 2, "rejected", "Lan")
    assert (ok, warn) == (True, None)
    sql, params = conn.calls[1]
    assert params[0] == "rejected"
    # Reject không đòi guardrail ok (bài vi phạm VẪN reject được).
    assert "guardrail->>'ok'" not in sql


def test_set_status_unknown_id_warns():
    conn = _Conn([_route("from content_drafts", "where id = %s", rows=[])])
    ok, warn = store.set_status(conn, 99, "approved", "Lan")
    assert not ok and "không tìm thấy" in warn


def test_set_status_non_pending_warns():
    conn = _Conn([_route("from content_drafts", "where id = %s",
                         rows=[_row(status="approved")])])
    ok, warn = store.set_status(conn, 1, "rejected", "Lan")
    assert not ok and "'approved'" in warn and "pending" in warn


def test_set_status_approve_guardrail_fail_no_update():
    conn = _Conn([_route("from content_drafts",
        "where id = %s",
        rows=[_row(guardrail={"ok": False,
                              "violations": [{"type": "banned_word"}]})])])
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "guardrail" in warn and "reject" in warn
    # Chỉ SELECT — không UPDATE nào chạy (double-gate chặn trước).
    assert len(conn.calls) == 1 and conn.committed == 0


def test_set_status_bad_inputs_no_db_touch():
    conn = _Conn([])
    ok, warn = store.set_status(conn, 1, "pending", "Lan")
    assert not ok and "không hợp lệ" in warn        # status đích lạ
    ok, warn = store.set_status(conn, 1, "approved", "  ")
    assert not ok and "người duyệt" in warn          # thiếu reviewer
    ok, warn = store.set_status(conn, "abc", "approved", "Lan")
    assert not ok and "không hợp lệ" in warn         # id không phải số
    assert conn.calls == []


def test_set_status_race_no_row_warns():
    """SELECT thấy pending nhưng UPDATE returning rỗng (người khác
    duyệt trước) → warn thay vì báo done ảo."""
    conn = _Conn([
        # Route SELECT phải có "from content_drafts" — UPDATE cũng chứa
        # "where id = %s" nên route lỏng sẽ bắt nhầm cả UPDATE.
        _route("from content_drafts", "where id = %s", rows=[_row()]),
        _route("update content_drafts set status", rows=[]),
    ])
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "tải lại" in warn


# ---------- schedule ----------

def test_schedule_approved_happy():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(1,),
               rows=[_row(id=1, status="approved")]),
        _route("update content_drafts set scheduled_date", rows=[(1,)]),
    ])
    ok, warn = store.schedule(conn, 1, "2026-10-20", today=TODAY)
    assert (ok, warn) == (True, None)
    assert conn.calls[1][1] == (date(2026, 10, 20), 1)
    assert conn.committed == 1


def test_schedule_only_approved():
    for st in ("pending", "rejected"):
        conn = _Conn([_route("from content_drafts", "where id = %s",
                             rows=[_row(status=st)])])
        ok, warn = store.schedule(conn, 1, TODAY, today=TODAY)
        assert not ok and "approved" in warn, st
        assert conn.committed == 0


def test_schedule_past_and_bad_date_no_db_touch():
    conn = _Conn([])
    ok, warn = store.schedule(conn, 1, TODAY - timedelta(days=1),
                              today=TODAY)
    assert not ok and "đã qua" in warn                 # quá khứ
    ok, warn = store.schedule(conn, 1, "20/10/2026", today=TODAY)
    assert not ok and "không hợp lệ" in warn           # sai format
    ok, warn = store.schedule(conn, 1, None, today=TODAY)
    assert not ok and "không hợp lệ" in warn
    assert conn.calls == []
    # Biên: hôm nay được phép (không quá khứ).
    conn2 = _Conn([
        _route("from content_drafts", "where id = %s", rows=[_row(status="approved")]),
        _route("update content_drafts set scheduled_date", rows=[(1,)]),
    ])
    assert store.schedule(conn2, 1, TODAY, today=TODAY)[0] is True


def test_schedule_unknown_id_warns():
    conn = _Conn([_route("from content_drafts", "where id = %s", rows=[])])
    ok, warn = store.schedule(conn, 9, TODAY, today=TODAY)
    assert not ok and "không tìm thấy" in warn


# ---------- calendar ----------

def test_calendar_shape_and_edges():
    horizon = TODAY + timedelta(days=14)
    sched = [_row(id=5, status="approved", scheduled_date=TODAY),
             _row(id=6, status="approved", scheduled_date=horizon)]
    unsched = [_row(id=7, status="approved")]
    conn = _Conn([
        _route("scheduled_date >= %s", params=(TODAY, horizon),
               rows=sched),
        _route("scheduled_date is null", rows=unsched),
    ])
    cal = store.calendar(conn, days=14, today=TODAY)
    assert cal["today"] == TODAY and cal["days"] == 14
    assert [d["id"] for d in cal["scheduled"]] == [5, 6]
    assert [d["id"] for d in cal["unscheduled"]] == [7]
    # Khung ngày đúng [today, today+days], biên inclusive phía SQL.
    sql, params = conn.calls[0]
    assert "scheduled_date >= %s" in sql and "scheduled_date <= %s" in sql
    assert params == (TODAY, date(2026, 10, 29))


def test_calendar_empty():
    conn = _Conn([
        _route("scheduled_date >= %s", rows=[]),
        _route("scheduled_date is null", rows=[]),
    ])
    cal = store.calendar(conn, today=TODAY)
    assert cal["scheduled"] == [] and cal["unscheduled"] == []


# ---------- misc helpers + drift guard ----------

def test_coerce_date_variants():
    assert store._coerce_date(TODAY) == TODAY
    assert store._coerce_date("2026-10-20") == date(2026, 10, 20)
    assert store._coerce_date(" 2026-10-20 ") == date(2026, 10, 20)
    assert store._coerce_date("20/10/2026") is None
    assert store._coerce_date(None) is None
    assert store._coerce_date(123) is None


def test_schema_sql_has_content_drafts_table():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    lower = sql.lower()
    match = re.search(
        r"create table if not exists content_drafts\s*\((.*?)\);",
        lower, re.DOTALL)
    assert match
    columns = match.group(1)
    for name in ("id", "created_at", "brief", "channel", "text",
                 "guardrail", "status", "reviewer", "reviewed_at",
                 "review_note", "scheduled_date", "source"):
        assert re.search(rf"^\s*{name}\s", columns, re.MULTILINE), name
    assert "id bigint generated always as identity primary key" in columns
    assert "guardrail jsonb not null" in columns
    assert "status text not null default 'pending'" in columns
    assert "scheduled_date date" in columns
    assert len(re.findall(
        r"^create table if not exists", lower, re.MULTILINE)) == 9
    assert not re.search(r"\b(alter|drop)\s+table\b", lower)


def test_store_module_exports_contract():
    """Contract theo checklist: đủ hàm + hằng channel đúng spec."""
    assert store.CHANNELS == ("facebook", "tiktok", "blog", "zalo")
    for fn in ("save_draft", "list_drafts", "set_status", "schedule",
               "calendar"):
        assert callable(getattr(store, fn))
    # psycopg.Error từ _get → warn không raise (conn chết giữa chừng).
    class Dead:
        def execute(self, *a):
            raise psycopg.OperationalError("dead")

        @contextmanager
        def transaction(self):
            yield

    ok, warn = store.set_status(Dead(), 1, "approved", "Lan")
    assert not ok and "không tìm thấy" in warn
