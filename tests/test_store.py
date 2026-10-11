"""v2.2-content-pipeline (W5.2/W5.5) — `pipelines.store`: save/list
fake-conn, set_status transitions đủ nhánh (pending→approved,
pending→rejected, sai-id, non-pending, approve-guardrail-fail, input
xấu, race no-row), schedule (chỉ approved, quá khứ reject), calendar
shape + edge, schema drift guard `content_drafts`. Không cần DB thật.

v3.4: chuyển trạng thái đi qua function DB (`approve_draft` /
`reject_draft` / `schedule_draft`) — fake-conn route theo `select
<function>(`; save_draft bắt buộc created_by + log `draft_create`;
drift-guard nới HẸP (chỉ `alter table <t> add column if not exists`).
Test DB thật ở tests/test_auth_approval.py."""

import re
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import psycopg
import pytest

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
            "source": "manual:studio", "created_by": "agent:studio"}
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

def _save_routes(new_id):
    return [_route("insert into content_drafts", rows=[(new_id,)]),
            _route("insert into agent_action_log", rows=[])]


def test_save_draft_inserts_and_commits():
    conn = _Conn(_save_routes(7))
    g = {"ok": True, "violations": [], "matched_claims": []}
    did = store.save_draft(conn, "  brief x ", "facebook", "text bài", g,
                           created_by=" Lan ")
    assert did == 7
    # Ghi trên conn chia sẻ phải commit() tường minh — v2.1 precedent.
    assert conn.committed == 1
    sql, params = conn.calls[0]
    assert "returning id" in sql and "created_by" in sql
    assert params[0] == "brief x" and params[1] == "facebook"
    assert params[2] == "text bài" and params[4] == "manual:studio"
    assert params[5] == "Lan"
    # guardrail bọc Jsonb — fake-conn nhận wrapper, .obj là dict gốc.
    assert getattr(params[3], "obj", params[3]) == g
    # v3.4: 1 dòng log draft_create cùng transaction, sha256 text.
    lsql, lparams = conn.calls[1]
    assert "insert into agent_action_log" in lsql
    assert lparams[:4] == ("Lan", "draft_create", "content_draft", "7")
    assert getattr(lparams[4], "obj", {})["content_sha256"] == \
        store.content_sha256("text bài")


def test_save_draft_source_cli():
    conn = _Conn(_save_routes(8))
    store.save_draft(conn, "b", "tiktok", "t", {}, source="cli",
                     created_by="cli-user")
    assert conn.calls[0][1][4] == "cli"


def test_save_draft_requires_created_by_no_db_touch():
    for by in (None, "", "   "):
        conn = _Conn([])
        with pytest.raises(ValueError):
            store.save_draft(conn, "b", "facebook", "t", {"ok": True},
                             created_by=by)
        assert conn.calls == [] and conn.committed == 0


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

def test_set_status_approve_happy_via_function():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(1,),
               rows=[_row(id=1)]),
        _route("select approve_draft(", rows=[(11,)]),
    ])
    ok, warn = store.set_status(conn, 1, "approved", " Lan ", "đẹp")
    assert (ok, warn) == (True, None)
    sql, params = conn.calls[1]
    # v3.4: chuyển trạng thái CHỈ qua function DB (atomic + quyền).
    assert "approve_draft(%s, %s, %s)" in sql
    assert "update" not in sql.lower()
    assert params == (1, "Lan", "đẹp")
    assert conn.committed == 1


def test_set_status_reject_happy_no_guardrail_req():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(2,),
               rows=[_row(id=2, guardrail={"ok": False,
                                           "violations": [{}]})]),
        _route("select reject_draft(", rows=[(12,)]),
    ])
    ok, warn = store.set_status(conn, 2, "rejected", "Lan")
    assert (ok, warn) == (True, None)
    sql, params = conn.calls[1]
    assert "reject_draft(%s, %s, %s)" in sql
    assert params == (2, "Lan", None)
    # Reject không đòi guardrail ok (bài vi phạm VẪN reject được).
    assert "approve_draft" not in sql


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


class _RaiseConn(_Conn):
    """Function DB raise (race: người khác duyệt trước → function thấy
    không còn pending) → (False, thông điệp function), không raise."""

    def __init__(self, routes, fn, msg):
        super().__init__(routes)
        self.fn, self.msg = fn, msg

    def execute(self, sql, params=None):
        if self.fn in sql:
            self.calls.append((sql, tuple(params or ())))
            raise psycopg.errors.RaiseException(self.msg)
        return super().execute(sql, params)


def test_set_status_race_function_raises_warns():
    conn = _RaiseConn(
        [_route("from content_drafts", "where id = %s", rows=[_row()])],
        "approve_draft(", "draft #1 đã ở trạng thái approved")
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "đã ở trạng thái approved" in warn
    assert conn.committed == 0
    conn = _RaiseConn(
        [_route("from content_drafts", "where id = %s", rows=[_row()])],
        "reject_draft(", "permission denied for function reject_draft")
    ok, warn = store.set_status(conn, 1, "rejected", "Lan")
    assert not ok and "permission denied" in warn


def test_set_status_recheck_guardrail_snapshot_forged():
    """Snapshot jsonb ok:true (agent tự ghi) nhưng text chứa từ cấm →
    check() chạy lại trên text DB chặn — KHÔNG gọi approve_draft."""
    conn = _Conn([_route("from content_drafts", "where id = %s",
                         rows=[_row(text="Sâm giúp chữa bệnh tiểu đường")])])
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "kiểm lại" in warn
    assert len(conn.calls) == 1 and conn.committed == 0
    assert not any("approve_draft" in c[0] for c in conn.calls)


def test_set_status_creator_and_missing_creator_precheck():
    for creator in ("lan", " LAN "):
        conn = _Conn([_route("from content_drafts", "where id = %s",
                             rows=[_row(created_by=creator)])])
        ok, warn = store.set_status(conn, 1, "approved", "Lan ")
        assert not ok and "người tạo" in warn, creator
        assert len(conn.calls) == 1
    conn = _Conn([_route("from content_drafts", "where id = %s",
                         rows=[_row(created_by=None)])])
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "không có người tạo" in warn
    # Người tạo tự rút bài (reject) được — đi qua reject_draft.
    conn = _Conn([_route("from content_drafts", "where id = %s",
                         rows=[_row(created_by="Lan")]),
                  _route("select reject_draft(", rows=[(3,)])])
    assert store.set_status(conn, 1, "rejected", "lan") == (True, None)


# ---------- schedule ----------

def test_schedule_approved_happy():
    conn = _Conn([
        _route("from content_drafts", "where id = %s", params=(1,),
               rows=[_row(id=1, status="approved")]),
        _route("select schedule_draft(", rows=[("",)]),
    ])
    ok, warn = store.schedule(conn, 1, "2026-10-20", "Hoa", today=TODAY)
    assert (ok, warn) == (True, None)
    assert "schedule_draft(%s, %s, %s)" in conn.calls[1][0]
    assert conn.calls[1][1] == (1, date(2026, 10, 20), "Hoa")
    assert conn.committed == 1


def test_schedule_only_approved():
    for st in ("pending", "rejected"):
        conn = _Conn([_route("from content_drafts", "where id = %s",
                             rows=[_row(status=st)])])
        ok, warn = store.schedule(conn, 1, TODAY, "Hoa", today=TODAY)
        assert not ok and "approved" in warn, st
        assert conn.committed == 0


def test_schedule_past_and_bad_date_no_db_touch():
    conn = _Conn([])
    ok, warn = store.schedule(conn, 1, TODAY - timedelta(days=1), "Hoa",
                              today=TODAY)
    assert not ok and "đã qua" in warn                 # quá khứ
    ok, warn = store.schedule(conn, 1, "2026-10-14", "Hoa", today=TODAY)
    assert not ok and "đã qua" in warn  # str quá khứ — CLI luôn truyền
    # str; f-string format-spec trên str từng crash ValueError
    # (cold-check v2.2 MAJOR, store.py:190).
    ok, warn = store.schedule(conn, 1, "20/10/2026", "Hoa", today=TODAY)
    assert not ok and "không hợp lệ" in warn           # sai format
    ok, warn = store.schedule(conn, 1, None, "Hoa", today=TODAY)
    assert not ok and "không hợp lệ" in warn
    for by in (None, "", "  "):                         # v3.4: thiếu --by
        ok, warn = store.schedule(conn, 1, TODAY, by, today=TODAY)
        assert not ok and "người xếp lịch" in warn
    assert conn.calls == []
    # Biên: hôm nay được phép (không quá khứ).
    conn2 = _Conn([
        _route("from content_drafts", "where id = %s", rows=[_row(status="approved")]),
        _route("select schedule_draft(", rows=[("",)]),
    ])
    assert store.schedule(conn2, 1, TODAY, "Hoa", today=TODAY)[0] is True


def test_schedule_unknown_id_warns():
    conn = _Conn([_route("from content_drafts", "where id = %s", rows=[])])
    ok, warn = store.schedule(conn, 9, TODAY, "Hoa", today=TODAY)
    assert not ok and "không tìm thấy" in warn
    # Function từ chối (sha lệch sau khi sửa text) → warn, không raise.
    conn = _RaiseConn([_route("from content_drafts", "where id = %s",
                              rows=[_row(status="approved")])],
                      "schedule_draft(", "nội dung draft #1 không khớp")
    ok, warn = store.schedule(conn, 1, TODAY, "Hoa", today=TODAY)
    assert not ok and "không khớp" in warn and conn.committed == 0


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
    assert "created_by text" in lower                  # v3.4 add column
    assert len(re.findall(
        r"^create table if not exists", lower, re.MULTILINE)) >= 24
    assert _forbidden_ddl(lower) == []


# v3.4: drift-guard nới HẸP — chỉ cho `alter table <t> add column if not
# exists <c> <type>;` (1 action, không dấu phẩy); mọi alter/drop khác bị bắt.
_ALTER_ADD_OK = re.compile(
    r"\balter\s+table\s+\w+\s+add\s+column\s+if\s+not\s+exists\s+\w+"
    r"[^;,]*;")


def _forbidden_ddl(lower: str) -> list[str]:
    return re.findall(r"\b(?:alter|drop)\s+table\b",
                      _ALTER_ADD_OK.sub("", lower))


def test_drift_guard_narrow_alter_only():
    for bad in ("drop table x;", "alter table x drop column y;",
                "alter table x rename to y;",
                "alter table x alter column y type int;",
                ("alter table x add column if not exists y text, "
                 "drop column z;"),
                "alter table x add column y text;",
                ("alter table x add column if not exists y text; "
                 "drop table z;")):
        assert _forbidden_ddl(bad), bad
    assert _forbidden_ddl(
        "alter table x add column if not exists y text;") == []


def test_cli_one_op_only():
    """Cold-check v2.2 MINOR: nhiều op cùng lúc (`--approve 1
    --reject 2`, `--pending --calendar`) trước đây op sau bị nuốt câm
    — nay argparse error exit 2 trước khi connect."""
    for argv in (["--approve", "1", "--reject", "2", "--by", "x"],
                 ["--approve", "1", "--schedule", "1", "2026-10-20",
                  "--by", "x"],
                 ["--pending", "--calendar"],
                 ["--pending", "--approve", "1", "--by", "x"],
                 ["--verify-log", "--pending"],
                 ["--verify-log", "--approve", "1", "--by", "x"]):
        with pytest.raises(SystemExit) as e:
            store.main(argv)
        assert e.value.code == 2, argv


def test_cli_schedule_requires_by_before_connect(monkeypatch):
    """v3.4: --schedule thiếu/rỗng --by → usage exit 2, KHÔNG connect."""
    called = []
    monkeypatch.setattr(store, "connect", lambda: called.append(1))
    for argv in (["--schedule", "1", "2026-10-20"],
                 ["--schedule", "1", "2026-10-20", "--by", "  "],
                 ["--verify-log", "--pending"]):
        with pytest.raises(SystemExit) as e:
            store.main(argv)
        assert e.value.code == 2, argv
    assert called == []


def test_cli_verify_log_exit_codes(monkeypatch, capsys):
    class _C(_Conn):
        def close(self):
            pass

    ok_conn = _C([_route("count(*) from agent_action_log", rows=[(3,)]),
                  _route("from verify_action_log()", rows=[])])
    monkeypatch.setattr(store, "connect", lambda: ok_conn)
    assert store.main(["--verify-log"]) == 0
    assert "[ok] chuỗi nguyên vẹn (3 dòng)" in capsys.readouterr().out
    bad = _C([_route("count(*) from agent_action_log", rows=[(3,)]),
              _route("from verify_action_log()", rows=[(2, "row_hash")])])
    monkeypatch.setattr(store, "connect", lambda: bad)
    assert store.main(["--verify-log"]) == 1
    assert "id=2 problem=row_hash" in capsys.readouterr().out
    monkeypatch.setattr(store, "connect", lambda: None)
    assert store.main(["--verify-log"]) == 2


def test_store_module_exports_contract():
    """Contract theo checklist: đủ hàm + hằng channel đúng spec."""
    assert store.CHANNELS == ("facebook", "tiktok", "blog", "zalo")
    for fn in ("save_draft", "list_drafts", "set_status", "schedule",
               "calendar", "verify_publish", "verify_log",
               "content_sha256"):
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
