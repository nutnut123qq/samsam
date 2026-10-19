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

from pipelines import guardrail, store

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 10, 15)
COLS = store.COLS
# v4.2: approve chạy lại check_publish (kênh draft) — text mặc định phải
# đạt luật đăng bài: có nhãn AI, không "Ngọc Linh", không claim/SKU.
TEXT_OK = "Quà biếu gia đình dịp Tết.\nNội dung có sử dụng AI"


def _row(**kw):
    """Tuple đủ COLS; default = draft pending guardrail-ok."""
    base = {"id": 1, "created_at": None, "brief": "b",
            "channel": "facebook", "text": TEXT_OK,
            "guardrail": {"ok": True, "violations": [],
                          "matched_claims": []},
            "status": "pending", "reviewer": None, "reviewed_at": None,
            "review_note": None, "scheduled_date": None,
            "source": "manual:studio", "created_by": "agent:studio",
            # v6.1: cột ngữ cảnh draft (mặc định = draft cũ).
            "content_type": "post", "sku": None, "is_ai": True,
            "prompt_version": None, "prompt_sha256": None}
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
            _route("insert into agent_action_log", rows=[]),
            _route("from sku_readiness", rows=[])]


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
    # v4.2: snapshot lưu = luật check_publish chạy lại (kênh draft) — text
    # thiếu nhãn AI -> ok False dù caller ghi ok:true.
    assert getattr(params[3], "obj", params[3]) == \
        guardrail.check_publish("text bài", channel="facebook")
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


# v8.2 KD-A3: thêm ĐÚNG cặp drop+add CHECK mục đích `consents` (thêm 'b2b')
# — tên bảng/constraint/dạng check cố định (cùng luật tests/test_lead_store).
_CONSENT_B2B_OK = re.compile(
    r"\balter\s+table\s+consents\s+(?:drop\s+constraint\s+if\s+exists\s+"
    r"consents_purpose_check|add\s+constraint\s+consents_purpose_check\s+"
    r"check\s*\(\s*purpose\s+in\s*\(\s*'cskh',\s*'marketing',\s*"
    r"'dai_ly',\s*'b2b'\s*\)\s*\))\s*;")


# v13 (c00 nới CHECK id `feature_rollout`, c02 thêm CHECK `txn_type`): chỉ
# ĐÚNG cặp drop+add CHECK theo tên cố định — cùng cách nới hẹp như consents.
_V13_CHECK_OK = re.compile(
    r"\balter\s+table\s+(?:feature_rollout\s+(?:drop\s+constraint\s+if\s+"
    r"exists\s+feature_rollout_feature_id_check|add\s+constraint\s+"
    r"feature_rollout_feature_id_check\s+check\s*\([^;]*\))|settlement_rows"
    r"\s+(?:drop\s+constraint\s+if\s+exists\s+settlement_rows_txn_type_check"
    r"|add\s+constraint\s+settlement_rows_txn_type_check\s+check\s*"
    r"\([^;]*\))|garden_media\s+(?:drop\s+constraint\s+if\s+exists\s+"
    r"garden_media_ext_check|add\s+constraint\s+garden_media_ext_check\s+"
    r"check\s*\(\s*ext\s+in\s*\([^;()]*\)\s*\)))\s*;")
# v13.4 c05: cặp CHECK `garden_media_ext_check` (thêm video mp4/mov) — cùng
# allowlist hẹp; chỉ dạng `check (ext in (...))`.


# docx P0: cặp CHECK `file_output_evidence` (thêm nguồn `conversations` +
# khóa `cv:<kênh>/<msg_id>`) — chỉ ĐÚNG 2 tên constraint cố định của đúng
# bảng, dạng drop-if-exists / add ... check (...).
_DOCX_CHECK_OK = re.compile(
    r"\balter\s+table\s+file_output_evidence\s+(?:drop\s+constraint\s+if"
    r"\s+exists\s+file_output_evidence_(?:nguon|output_key)_check|add\s+"
    r"constraint\s+file_output_evidence_(?:nguon|output_key)_check\s+check"
    r"\s*\([^;]*\))\s*;")


def _forbidden_ddl(lower: str) -> list[str]:
    return re.findall(r"\b(?:alter|drop)\s+table\b", _DOCX_CHECK_OK.sub(
        "", _V13_CHECK_OK.sub("", _CONSENT_B2B_OK.sub(
            "", _ALTER_ADD_OK.sub("", lower)))))


def test_drift_guard_narrow_alter_only():
    for bad in ("drop table x;", "alter table x drop column y;",
                "alter table x rename to y;",
                "alter table x alter column y type int;",
                ("alter table x add column if not exists y text, "
                 "drop column z;"),
                "alter table x add column y text;",
                ("alter table x add column if not exists y text; "
                 "drop table z;"),
                ("alter table consents drop constraint if exists "
                 "consents_purpose_check; alter table consents drop "
                 "column purpose;"),
                ("alter table consents add constraint "
                 "consents_purpose_check check (purpose in ('x'));"),
                ("alter table settlement_rows drop constraint if exists "
                 "settlement_rows_txn_type_check, drop column x;"),
                ("alter table settlement_rows add constraint "
                 "settlement_rows_txn_type_check check (x), drop column y;"),
                ("alter table orders add constraint "
                 "settlement_rows_txn_type_check check (x);"),
                ("alter table garden_media add constraint "
                 "garden_media_ext_check check (ext in ('mp4')), drop "
                 "column plot_id;"),
                ("alter table garden_media drop constraint if exists "
                 "garden_media_plot_id_fkey;"),
                ("alter table plots add constraint garden_media_ext_check "
                 "check (ext in ('x'));"),
                ("alter table file_output_evidence drop constraint if exists "
                 "file_output_evidence_nguon_check, drop column nguon;"),
                "alter table file_output_evidence drop column ban_ghi;",
                ("alter table orders add constraint "
                 "file_output_evidence_nguon_check check (x);"),
                ("alter table file_output_evidence drop constraint if exists "
                 "file_output_evidence_pkey;")):
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
    # psycopg.Error từ _get PROPAGATE lên caller (v2.4 V9.3 — trước
    # nuốt thành 'không tìm thấy' ảo khi conn chết giữa chừng);
    # set_status/schedule bắt → warn 'lỗi DB', vẫn không raise.
    class Dead:
        def execute(self, *a):
            raise psycopg.OperationalError("dead")

        @contextmanager
        def transaction(self):
            yield

    ok, warn = store.set_status(Dead(), 1, "approved", "Lan")
    assert not ok and "lỗi DB" in warn
    ok, warn = store.schedule(Dead(), 1, "2026-10-20", "Lan", today=TODAY)
    assert not ok and "lỗi DB" in warn
    with pytest.raises(psycopg.Error):
        store._get(Dead(), 1)


def test_fmt_guardrail_missing_ok_branch():
    """v2.4 V9.4: snapshot guardrail thiếu key 'ok' (draft ngoại lai)
    → 'KHÔNG RÕ' thay 'VI PHẠM'; ok=False violations thật vẫn
    'VI PHẠM (n)'."""
    assert store._fmt_guardrail({"guardrail": {"ok": True}}) == "PASS"
    assert store._fmt_guardrail(
        {"guardrail": {"ok": False,
                       "violations": [{"type": "x"}, {"type": "y"}]}}) \
        == "VI PHẠM (2)"
    assert store._fmt_guardrail({"guardrail": {"ok": False}}) \
        == "VI PHẠM"
    assert store._fmt_guardrail(
        {"guardrail": {"violations": [{"type": "x"}]}}) == "KHÔNG RÕ"
    assert store._fmt_guardrail({"guardrail": None}) == "KHÔNG RÕ"
    assert store._fmt_guardrail({}) == "KHÔNG RÕ"


# ---------- v4.2 W42.4: save/approve chạy lại check_publish ----------

CANON = ("Thực phẩm này không phải là thuốc và không có tác dụng thay thế "
         "thuốc chữa bệnh")
SAVINA = f"Savina 12 viên hỗ trợ giảm ho. {CANON}.\nNội dung có sử dụng AI"


def _approve_conn(row, readiness_rows=None):
    routes = [_route("from content_drafts", "where id = %s", rows=[row]),
              _route("select approve_draft(", rows=[(11,)])]
    if readiness_rows is not None:
        routes.append(_route("from sku_readiness", rows=readiness_rows))
    return _Conn(routes)


def _snap(conn):
    """Snapshot jsonb đã INSERT (sau lần đọc view nếu có)."""
    return next(c[1][3].obj for c in conn.calls
                if "insert into content_drafts" in c[0])


def _called(conn, sub):
    return any(sub in c[0] for c in conn.calls)


def test_approve_rechecks_publish_missing_ai_label():
    conn = _approve_conn(_row(text="t"))           # snapshot ok:true giả
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "kiểm lại" in warn and "thieu_nhan_ai" in warn
    assert not _called(conn, "approve_draft") and conn.committed == 0


def test_approve_unknown_channel_config_blog_alias_ok():
    conn = _approve_conn(_row(channel="insta"))
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "config" in warn
    assert not _called(conn, "approve_draft")
    conn = _approve_conn(_row(channel="blog"))
    assert store.set_status(conn, 1, "approved", "Lan") == (True, None)
    assert _called(conn, "approve_draft(")


def test_approve_readiness_from_view_and_fallback():
    # View nói QC_DAY_DU cho savina×facebook -> duyệt được (gọi function).
    conn = _approve_conn(_row(text=SAVINA),
                         [("savina-12v", "facebook", "QC_DAY_DU")])
    assert store.set_status(conn, 1, "approved", "Lan") == (True, None)
    assert _called(conn, "from sku_readiness")
    assert _called(conn, "approve_draft(")
    # View chỉ có kênh khác -> thiếu key = CAM -> chặn.
    conn = _approve_conn(_row(text=SAVINA),
                         [("savina-12v", "shopee", "QC_DAY_DU")])
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "sku_chua_xnqc" in warn
    # View lỗi (psycopg.Error) -> fallback golden file -> chặn.
    conn = _RaiseConn([_route("from content_drafts", "where id = %s",
                              rows=[_row(text=SAVINA)])],
                      "from sku_readiness", "permission denied for view")
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "sku_chua_xnqc" in warn
    assert not _called(conn, "approve_draft")


def test_readiness_from_db_shapes():
    assert store.readiness_from_db(None) is None
    conn = _Conn([_route("from sku_readiness",
                         rows=[("savina-12v", "web", "MO_TA")])])
    assert store.readiness_from_db(conn) == {("savina-12v", "web"): "MO_TA"}
    bad = _Conn([_route("from sku_readiness", rows=[("only-one",)])])
    assert store.readiness_from_db(bad) is None             # hàng sai shape


def test_save_draft_snapshot_never_looser():
    # Caller ghi ok:true nhưng text có từ cấm -> snapshot lưu ok False.
    conn = _Conn(_save_routes(9))
    store.save_draft(conn, "b", "facebook",
                     "Savina chữa ho.\nNội dung có sử dụng AI",
                     {"ok": True, "violations": []}, created_by="Lan")
    snap = _snap(conn)
    assert snap["ok"] is False
    assert "tu_cam" in [v["code"] for v in snap["violations"]]
    # Caller có violation LLM + text sạch theo luật -> giữ code, ok False.
    caller = {"ok": False, "llm_check": "flag", "llm_model": "m/x",
              "violations": [{"code": "llm_ngam_y_suc_khoe",
                              "detail": "ẩn ý", "span": "Quà", "start": 0,
                              "end": 3, "severity": "major",
                              "type": "llm_ngam_y_suc_khoe"}]}
    conn = _Conn(_save_routes(10))
    store.save_draft(conn, "b", "facebook", TEXT_OK, caller,
                     created_by="Lan")
    snap = _snap(conn)
    assert snap["ok"] is False
    assert [v["code"] for v in snap["violations"]] == ["llm_ngam_y_suc_khoe"]
    assert snap["llm_check"] == "flag" and snap["llm_model"] == "m/x"
    # Caller ok:false không lý do (CLI `{}`) + luật sạch -> vẫn False.
    conn = _Conn(_save_routes(11))
    store.save_draft(conn, "b", "facebook", TEXT_OK, {}, created_by="Lan")
    assert _snap(conn)["ok"] is False
    # Luật sạch + caller ok:true -> ok True; không đọc view khi không SKU.
    conn = _Conn(_save_routes(12))
    store.save_draft(conn, "b", "blog", TEXT_OK,
                     {"ok": True, "violations": []}, created_by="Lan")
    assert _snap(conn)["ok"] is True
    assert not _called(conn, "from sku_readiness")


def test_save_draft_reads_view_when_sku_mentioned():
    conn = _Conn(_save_routes(13)[:2] + [_route(
        "from sku_readiness", rows=[("savina-12v", "facebook", "QC_DAY_DU")])])
    store.save_draft(conn, "b", "facebook", SAVINA,
                     {"ok": True, "violations": []}, created_by="Lan")
    assert _called(conn, "from sku_readiness")
    snap = _snap(conn)
    assert snap["ok"] is True, snap["violations"]


def test_approve_llm_layer_raise_fail_closed(monkeypatch):
    from pipelines import llm_gateway

    monkeypatch.setenv("GUARDRAIL_LLM_MODEL", "google/gemini-test")
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    class Boom:
        def __init__(self):
            import types
            self.chat = types.SimpleNamespace(
                completions=types.SimpleNamespace(create=self._c))

        def _c(self, **kw):
            raise TimeoutError("read timeout")

    monkeypatch.setattr(llm_gateway, "_client", lambda: Boom())
    conn = _approve_conn(_row())
    ok, warn = store.set_status(conn, 1, "approved", "Lan")
    assert not ok and "llm_check_unavailable" in warn
    assert not _called(conn, "approve_draft")


@pytest.mark.parametrize("g,first", [
    ({"ok": True, "violations": [], "matched_claims": []}, "success"),
    # snapshot v3 (chỉ type/detail/span)
    ({"ok": False, "violations": [{"type": "banned_word", "detail": "x",
                                   "span": "thuốc"}]}, "error"),
    # snapshot v4.1/v4.2 đầy đủ
    ({"ok": False, "violations": [{"type": "banned_word", "code": "tu_cam",
                                   "severity": "critical", "detail": "d",
                                   "span": "thuốc", "start": 3, "end": 8}],
      "warnings": [{"code": "sku_chua_mo_kenh", "severity": "minor",
                    "detail": "w"}],
      "required_labels": ["Nội dung có sử dụng AI"],
      "llm_check": "skipped", "llm_model": "m/x"}, "error"),
    ({}, "error"), (None, "error"), ({"ok": 0}, "error"),
    ({"ok": True, "violations": "rác"}, "success"),
    ("chuỗi", "error"),
])
def test_guardrail_lines_levels_no_raise(g, first):
    lines = store.guardrail_lines(g)
    assert lines and lines[0][0] == first
    assert all(lv in ("success", "error", "warning", "info")
               for lv, _ in lines)
    assert all(isinstance(t, str) for _, t in lines)
    if first == "error" and not (isinstance(g, dict) and g.get("violations")):
        assert "KHÔNG RÕ" in lines[0][1]


def test_guardrail_lines_full_format():
    g = {"ok": False, "violations": [{"type": "banned_word", "code": "tu_cam",
                                      "severity": "critical", "detail": "d",
                                      "span": "thuốc", "start": 3, "end": 8},
                                     {"type": "banned_word", "detail": "cũ",
                                      "span": None}],
         "warnings": [{"code": "sku_chua_mo_kenh", "severity": "minor",
                       "detail": "w"}],
         "required_labels": ["Nội dung có sử dụng AI"],
         "llm_check": "flag", "llm_model": "m/x",
         "matched_claims": [{"sku": "savina", "claim": "hỗ trợ giảm ho"}]}
    lines = store.guardrail_lines(g)
    assert lines[0] == ("error", '[critical] tu_cam — d → "thuốc" (3–8)')
    assert lines[1] == ("error", "banned_word — cũ")     # thiếu code -> type
    assert ("warning", "[minor] sku_chua_mo_kenh — w") in lines
    assert ("info", "Lớp LLM-check: flag (m/x)") in lines
    assert ("info", "Nhãn bắt buộc: Nội dung có sử dụng AI") in lines
    assert ("info", "Claim khớp whitelist: savina: hỗ trợ giảm ho") in lines


def test_store_uses_check_publish_not_chat_check():
    src = (ROOT / "pipelines" / "store.py").read_text(encoding="utf-8")
    assert "check_publish_llm(" in src and "check_publish(" in src
    assert "guardrail_check(" not in src
    assert not re.search(r"(?<![\w.])check\(", src)


# ---------- v4.2 fix nghiệm thu: readiness DB trên luồng Studio thật ----------

_QC_VIEW = [("savina-12v", "facebook", "QC_DAY_DU")]
_QC_MAP = {("savina-12v", "facebook"): "QC_DAY_DU"}


def _fake_llm(monkeypatch, text):
    """Gateway giả cho content.draft — trả `text`, đếm call."""
    import types

    from pipelines import llm_gateway

    calls = []

    def _create(**kw):
        calls.append(kw)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(
            message=types.SimpleNamespace(content=text))])

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm_gateway, "_client", lambda: types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create))))
    return calls


def test_studio_flow_draft_save_approve_with_view(monkeypatch):
    """Luồng thật: kết quả draft() (không phải {'ok': True} tổng hợp) ->
    save_draft (view QC_DAY_DU) -> approve gọi function. Trước fix draft()
    luôn soi golden file -> sku_chua_xnqc -> snapshot ok False, violations
    [] -> Studio 'KHÔNG RÕ' + không duyệt được."""
    from pipelines import content

    # Không truyền readiness (DB chết) -> fail-closed file như cũ.
    calls = _fake_llm(monkeypatch, SAVINA)
    r0 = content.draft("giới thiệu Savina", "facebook")
    assert r0["guardrail"]["ok"] is False
    assert "sku_chua_xnqc" in [v["code"] for v in r0["guardrail"]["violations"]]
    assert len(calls) == 2                      # file chặn -> có lượt sửa
    # Có map view -> pass ngay lượt 1, không feedback gỡ claim hợp lệ.
    calls = _fake_llm(monkeypatch, SAVINA)
    r = content.draft("giới thiệu Savina", "facebook", readiness=_QC_MAP)
    assert r["guardrail"]["ok"] is True, r["guardrail"]["violations"]
    assert len(calls) == 1
    multi = content.draft_multi("b", ["facebook"], readiness=_QC_MAP)
    assert multi["facebook"]["guardrail"]["ok"] is True
    # Lưu: snapshot = luật chạy lại với view + caller thật.
    conn = _Conn(_save_routes(21)[:2] + [_route("from sku_readiness",
                                                rows=_QC_VIEW)])
    store.save_draft(conn, "b", "facebook", r["text"], r["guardrail"],
                     created_by="agent:studio")
    snap = _snap(conn)
    assert snap["ok"] is True, snap["violations"]
    assert store.guardrail_lines(snap)[0][0] == "success"
    # Duyệt: người khác duyệt, view QC_DAY_DU -> gọi approve_draft.
    conn = _approve_conn(_row(text=r["text"], guardrail=snap), _QC_VIEW)
    assert store.set_status(conn, 1, "approved", "Lan") == (True, None)
    assert _called(conn, "approve_draft(")


def test_merge_snapshot_never_unexplained_not_ok():
    """ok False mà violations rỗng -> luôn có violation giải thích (UI
    không 'KHÔNG RÕ'), ok giữ False."""
    # Caller soi file (sku_chua_xnqc), lưu dùng view QC_DAY_DU -> luật sạch.
    caller = {"ok": False, "violations": [
        {"code": "sku_chua_xnqc", "detail": "file", "span": "Savina",
         "start": 0, "end": 6, "severity": "critical"}]}
    conn = _Conn(_save_routes(22)[:2] + [_route("from sku_readiness",
                                                rows=_QC_VIEW)])
    store.save_draft(conn, "b", "facebook", SAVINA, caller, created_by="Lan")
    snap = _snap(conn)
    assert snap["ok"] is False
    assert [v["code"] for v in snap["violations"]] == ["sku_chua_xnqc"]
    assert "snapshot lúc sinh" in snap["violations"][0]["detail"]
    # Caller không chi tiết ({}, {"ok": False}) -> violation config.
    for c in ({}, {"ok": False}, {"ok": False, "violations": "rác"}, None):
        conn = _Conn(_save_routes(23))
        store.save_draft(conn, "b", "facebook", TEXT_OK, c, created_by="Lan")
        snap = _snap(conn)
        assert snap["ok"] is False
        assert [v["code"] for v in snap["violations"]] == ["config"]
        assert all("KHÔNG RÕ" not in t for _, t in store.guardrail_lines(snap))


def test_readiness_now_opens_closes_and_fallback(monkeypatch):
    closed = []

    class C(_Conn):
        def close(self):
            closed.append(1)

    monkeypatch.setattr(store, "connect",
                        lambda: C([_route("from sku_readiness",
                                          rows=_QC_VIEW)]))
    assert store.readiness_now() == _QC_MAP and closed == [1]
    monkeypatch.setattr(store, "connect", lambda: None)
    assert store.readiness_now() is None


def _md_tokens_safe(out: str) -> bool:
    """Mọi ký tự markdown đặc biệt trong `out` đều đứng sau đúng 1
    backslash escape (bỏ cặp `\\x` rồi không còn ký tự đặc biệt trần)."""
    special = set("\\`*_{}[]()#+-.!<>|~$:")
    i = 0
    while i < len(out):
        if out[i] == "\\":
            if i + 1 >= len(out) or out[i + 1] not in special:
                return False
            i += 2
            continue
        if out[i] in special:
            return False
        i += 1
    return True


@pytest.mark.parametrize("payload", [
    "[x](http://t)", "![a](u)", "[x]: http://t", "a\\[x](u)",
    "**đậm** _nghiêng_ `code` # h", ":red[đỏ] <img src=x>",
    '[critical] tu_cam — d → "![a](http://t/p.png)" (3–8)',
])
def test_md_plain_escapes_link_image(payload):
    out = store.md_plain(payload)
    assert _md_tokens_safe(out), out
    # Bỏ escape -> đúng text gốc (không mất chữ).
    assert re.sub(r"\\(.)", r"\1", out) == payload


def test_streamlit_studio_calls_check_publish_drift_guard():
    """Studio (W42.5): ô check tay gọi check_publish (+ readiness view),
    sinh bài truyền readiness, _render_guardrail đi qua guardrail_lines +
    md_plain; `check()` chế độ chat CHỈ ở tab Chat."""
    src = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    chat_i = src.index('if "Chat Sâm Sâm" in _tabs')
    studio_i = src.index('if "Content Studio" in _tabs')
    end_i = src.index('if "Chưa trả lời" in _tabs')
    studio = src[studio_i:end_i]
    imports = [m.start() for m in re.finditer(
        r"^\s*from pipelines\.guardrail import check\s*$", src,
        re.MULTILINE)]
    assert len(imports) == 1 and chat_i < imports[0] < studio_i
    assert not re.search(r"(?<![\w.])check\(", studio)
    assert re.search(r"_render_guardrail\(check_publish\(", studio)
    assert "readiness=readiness_now()" in studio
    # v6.1 FLIP có chủ đích: + listing(sku, kênh, readiness=_rmap).
    assert studio.count("readiness=_rmap") == 3  # draft + multi + listing
    rg = src[src.index("def _render_guardrail"):chat_i]
    assert "guardrail_lines(g)" in rg and "md_plain(line)" in rg
    assert "def _md_plain" not in src           # 1 bản escape duy nhất (store)
