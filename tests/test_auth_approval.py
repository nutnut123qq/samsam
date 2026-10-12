"""v3.4 W34.1–W34.3 — duyệt & phân quyền trên DB THẬT (schema tạm, rollback).

Mỗi test chạy trong 1 transaction trên `DATABASE_URL`: `create schema` tạm
+ `set local search_path to <tmp>, pg_temp` + docs/schema.sql ×2 +
docs/roles.sql ×2 (idempotent) → ROLLBACK cuối test bỏ sạch (precedent
v3.2). Mỗi case lỗi chạy trong savepoint riêng. Thử quyền bằng `set local
role agent_writer|app_human` (role NOLOGIN — superuser của test SET ROLE
được). Hàm store gọi `conn.commit()` → bọc `_TxConn` chỉ ghi nhận commit.
Skip khi không có DB — gate yêu cầu 0 skipped.
"""

import os
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import CheckViolation, InsufficientPrivilege, RaiseException
from psycopg.types.json import Jsonb

from pipelines import store

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
ZERO = "0" * 64
VN_TODAY = "(now() at time zone 'Asia/Ho_Chi_Minh')::date"
OK_G = {"ok": True, "violations": [], "matched_claims": []}
# Có dấu + CRLF + emoji — viết escape (gotcha ký tự vô hình). v4.2: approve
# chạy lại check_publish (kênh facebook) -> bỏ "Ngọc Linh" + có nhãn AI.
TEXT_VI = "Sâm Sâm — quà tặng\r\nNội dung có sử dụng AI \U0001f33f"
DRAFT_TEXT = "Sâm Sâm — bài mẫu. Nội dung có sử dụng AI"
FUNCS = ("approve_draft", "reject_draft", "schedule_draft", "verify_publish",
         "verify_action_log", "agent_action_log_chain")


@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_auth_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)       # idempotent ×2
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


@contextmanager
def _as(conn, role):
    """Chạy trong savepoint dưới role; thoát êm → reset role (lỗi →
    savepoint rollback tự bỏ `set local role`)."""
    with conn.transaction():
        conn.execute(f"set local role {role}")
        yield
        conn.execute("reset role")


def _denied(conn, role, sql, params=None):
    with pytest.raises(InsufficientPrivilege), conn.transaction():
        conn.execute(f"set local role {role}")
        conn.execute(sql, params)


def _raises(conn, sql, params=None, role=None, exc=RaiseException):
    with pytest.raises(exc) as e, conn.transaction():
        if role:
            conn.execute(f"set local role {role}")
        conn.execute(sql, params)
    return str(e.value)


def _log(conn, actor, action="test", detail=None):
    conn.execute("insert into agent_action_log (actor, action, detail) "
                 "values (%s, %s, %s)", (actor, action, Jsonb(detail or {})))


def _verify(conn):
    return [tuple(r) for r in conn.execute(
        "select id, problem from verify_action_log()").fetchall()]


def _draft(conn, created_by="agent:studio", text=DRAFT_TEXT,
           g=OK_G, role="agent_writer"):
    with _as(conn, role):
        if created_by is None:
            return conn.execute(
                "insert into content_drafts (brief, channel, text, guardrail,"
                " source) values ('b', 'facebook', %s, %s, 'cli') returning id",
                (text, Jsonb(g))).fetchone()[0]
        return conn.execute(
            "insert into content_drafts (brief, channel, text, guardrail,"
            " source, created_by) values ('b', 'facebook', %s, %s, 'cli', %s)"
            " returning id", (text, Jsonb(g), created_by)).fetchone()[0]


def _approve(conn, did, by, role="app_human"):
    with _as(conn, role):
        return conn.execute("select approve_draft(%s, %s, %s)",
                            (did, by, "ok")).fetchone()[0]


# ---------- W34.1 hash chain + append-only ----------

def test_chain_three_rows_linked(db):
    for a in ("a1", "a2", "a3"):
        _log(db, a, detail={"k": a})
    rows = db.execute("select id, prev_hash, row_hash from agent_action_log"
                      " order by id").fetchall()
    assert len(rows) == 3
    assert rows[0][1] == ZERO
    for k in (1, 2):
        assert rows[k][1] == rows[k - 1][2]
    assert len({r[2] for r in rows}) == 3
    assert _verify(db) == []


def test_chain_client_values_overwritten(db):
    _log(db, "a0")
    db.execute(
        "insert into agent_action_log (actor, action, prev_hash, row_hash,"
        " ts, db_role) values ('x', 'y', %s, %s, '2000-01-01', 'fake')",
        ("f" * 64, "e" * 64))
    r = db.execute("select prev_hash, row_hash, ts > now() - interval '1 h',"
                   " db_role = session_user from agent_action_log"
                   " order by id desc limit 1").fetchone()
    first = db.execute("select row_hash from agent_action_log order by id"
                       " limit 1").fetchone()[0]
    assert r[0] == first and r[1] != "e" * 64
    assert r[2] is True and r[3] is True
    assert _verify(db) == []


def test_append_only_triggers_block_superuser(db):
    _log(db, "a1")
    did = _draft(db)
    _approve(db, did, "Hoa")
    for t, col in (("agent_action_log", "action"), ("approvals", "note")):
        _raises(db, f"update {t} set {col} = {col}")
        _raises(db, f"delete from {t}")
        _raises(db, f"truncate {t}")


def test_verify_detects_update_and_delete(db):
    for a in ("a1", "a2", "a3"):
        _log(db, a)
    ids = [r[0] for r in db.execute(
        "select id from agent_action_log order by id")]
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("update agent_action_log set detail = '{\"x\": 1}'"
                   " where id = %s", (ids[1],))
        assert _verify(db) == [(ids[1], "row_hash")]
    assert _verify(db) == []
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("delete from agent_action_log where id = %s", (ids[1],))
        assert _verify(db) == [(ids[2], "prev_hash")]
    assert _verify(db) == []
    # Giới hạn đã ghi: xóa dòng CUỐI không phát hiện bằng chuỗi thuần.
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("delete from agent_action_log where id = %s", (ids[2],))
        assert _verify(db) == []


def test_hash_independent_of_timezone_datestyle(db):
    db.execute("set local timezone = 'UTC'")
    _log(db, "utc")
    db.execute("set local timezone = 'Asia/Ho_Chi_Minh'")
    db.execute("set local datestyle = 'SQL, DMY'")
    _log(db, "vn")
    assert _verify(db) == []
    db.execute("set local timezone = 'UTC'")
    db.execute("set local datestyle = 'ISO, MDY'")
    assert _verify(db) == []


def test_approvals_sha_check_and_parity(db):
    _raises(db, "insert into approvals (object_type, object_id,"
                " content_sha256, decision, approved_by) values"
                " ('content_draft', '1', 'ABC', 'approved', 'x')",
            exc=CheckViolation)
    _raises(db, "insert into approvals (object_type, object_id,"
                " content_sha256, decision, approved_by) values"
                " ('content_draft', '1', %s, 'approved', '  ')",
            ("a" * 64,), exc=CheckViolation)
    pg = db.execute("select encode(sha256(convert_to(%s, 'UTF8')), 'hex')",
                    (TEXT_VI,)).fetchone()[0]
    assert pg == store.content_sha256(TEXT_VI)
    assert "\r\n" in TEXT_VI and len(TEXT_VI.encode("utf-8")) > len(TEXT_VI)


# ---------- W34.2 role + function ----------

def test_functions_security_definer_pinned(db):
    schema = db.execute("select current_schema()").fetchone()[0]
    rows = db.execute(
        "select proname, prosecdef, proconfig from pg_proc where"
        " pronamespace = %s::regnamespace and proname = any(%s)",
        (schema, list(FUNCS))).fetchall()
    assert {r[0] for r in rows} == set(FUNCS)
    for name, secdef, cfg in rows:
        assert secdef is True, name
        sp = [c for c in (cfg or []) if c.startswith("search_path=")]
        assert sp == [f"search_path={schema}, pg_temp"], (name, cfg)
    for fn in ("approve_draft(bigint,text,text)",
               "reject_draft(bigint,text,text)",
               "schedule_draft(bigint,date,text)",
               "verify_publish(text,text,text)", "verify_action_log()"):
        q = "select has_function_privilege(%s, %s, 'execute')"
        assert db.execute(q, ("agent_writer", fn)).fetchone()[0] is False, fn
        assert db.execute(q, ("app_human", fn)).fetchone()[0] is True, fn
        assert db.execute(q, ("public", fn)).fetchone()[0] is False, fn
    assert db.execute("select rolcanlogin from pg_roles where rolname = any("
                      "%s)", (["agent_writer", "app_human"],)).fetchall() \
        == [(False,), (False,)]


def test_agent_writer_cannot_self_approve(db):
    did = _draft(db)
    aw = "agent_writer"
    _denied(db, aw, "update content_drafts set status = 'approved'")
    _denied(db, aw, "update content_drafts set reviewer = 'x'")
    _denied(db, aw, "update content_drafts set reviewed_at = now()")
    _denied(db, aw, "update content_drafts set text = 'x'")
    _denied(db, aw, "delete from content_drafts")
    _denied(db, aw, "insert into content_drafts (brief, channel, text,"
                    " guardrail, source, created_by, status) values ('b',"
                    " 'facebook', 't', '{}', 'cli', 'bot', 'approved')")
    _denied(db, aw, "insert into approvals (object_type, object_id,"
                    " content_sha256, decision, approved_by) values"
                    " ('content_draft', %s, %s, 'approved', 'bot')",
            (str(did), "a" * 64))
    _denied(db, aw, "select approve_draft(%s, 'bot2', null)", (did,))
    _denied(db, aw, "select schedule_draft(%s, current_date, 'bot2')",
            (did,))
    _denied(db, aw, "update agent_action_log set actor = 'x'")
    _denied(db, aw, "delete from agent_action_log")
    _denied(db, aw, "select * from leads")
    _denied(db, aw, "select * from approvals")
    _denied(db, aw, "set local session_replication_role = replica")
    # Được phép: insert 6 cột → status pending; log insert 5 cột.
    assert db.execute("select status, created_by from content_drafts where"
                      " id = %s", (did,)).fetchone() == ("pending",
                                                         "agent:studio")
    with _as(db, aw):
        _log(db, "agent:studio", "draft_create")
    assert _verify(db) == []


def test_app_human_only_via_function(db):
    bad = _draft(db, g={"ok": False, "violations": [{"type": "x"}]})
    good = _draft(db, created_by=" Lan ", text=TEXT_VI)
    nocreator = _draft(db, created_by=None)
    ah = "app_human"
    _denied(db, ah, "update content_drafts set status = 'approved'")
    _denied(db, ah, "insert into approvals (object_type, object_id,"
                    " content_sha256, decision, approved_by) values"
                    " ('content_draft', '1', %s, 'approved', 'x')",
            ("a" * 64,))
    q = "select approve_draft(%s, %s, null)"
    assert "guardrail" in _raises(db, q, (bad, "Hoa"), role=ah)
    for same in ("lan", "LAN ", " Lan "):
        assert "người tạo" in _raises(db, q, (good, same), role=ah)
    assert "không có người tạo" in _raises(db, q, (nocreator, "Hoa"),
                                           role=ah)
    for empty in ("", "   ", None):
        assert "thiếu" in _raises(db, q, (good, empty), role=ah)
    assert "không tìm thấy" in _raises(db, q, (999999, "Hoa"), role=ah)
    assert db.execute("select count(*) from approvals").fetchone()[0] == 0

    aid = _approve(db, good, "Hoa")
    assert db.execute("select status, reviewer from content_drafts where"
                      " id = %s", (good,)).fetchone() == ("approved", "Hoa")
    rows = db.execute("select id, object_id, content_sha256, decision,"
                      " approved_by from approvals").fetchall()
    assert rows == [(aid, str(good), store.content_sha256(TEXT_VI),
                     "approved", "Hoa")]
    assert db.execute("select count(*) from agent_action_log where action ="
                      " 'draft_approve' and object_id = %s",
                      (str(good),)).fetchone()[0] == 1
    assert _verify(db) == []
    assert "pending" in _raises(db, q, (good, "Mai"), role=ah)   # lần 2

    vp = "select verify_publish('content_draft', %s, %s)"
    with _as(db, ah):
        assert db.execute(vp, (str(good), TEXT_VI)).fetchone()[0] is True
        assert db.execute(vp, (str(good), TEXT_VI + " ")).fetchone()[0] \
            is False
        assert db.execute(vp, (str(bad), "x")).fetchone()[0] is False

    sq = "select schedule_draft(%s, " + VN_TODAY + " + %s::int, %s)"
    assert "đã qua" in _raises(db, sq, (good, -1, "Hoa"), role=ah)
    assert "thiếu" in _raises(db, sq, (good, 0, " "), role=ah)
    assert "approved" in _raises(db, sq, (bad, 0, "Hoa"), role=ah)
    with _as(db, ah):
        db.execute(sq, (good, 0, "Hoa"))
    assert db.execute("select scheduled_date = " + VN_TODAY + " from"
                      " content_drafts where id = %s",
                      (good,)).fetchone()[0] is True

    # Sửa text sau duyệt (superuser) → verify_publish false, không xếp lịch.
    db.execute("update content_drafts set text = text || '!' where id = %s",
               (good,))
    with _as(db, ah):
        assert db.execute(vp, (str(good), TEXT_VI + "!")).fetchone()[0] \
            is False
    assert "không khớp" in _raises(db, sq, (good, 1, "Hoa"), role=ah)

    # Reject (người tạo tự rút được) → approvals rejected, publish false.
    with _as(db, ah):
        db.execute("select reject_draft(%s, %s, 'rút')", (bad, "x"))
        assert db.execute(vp, (str(bad), "Sâm Ngọc Linh — bài mẫu")
                          ).fetchone()[0] is False
    assert db.execute("select decision from approvals where object_id = %s",
                      (str(bad),)).fetchone() == ("rejected",)
    assert _verify(db) == []


# ---------- W34.3 store qua function (DB thật, _TxConn) ----------

class _TxConn:
    """Bọc conn test: commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại
    trong tx của fixture (rollback cuối test). transaction() = savepoint
    thật (lỗi function rollback đúng phần đó)."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def test_store_flow_as_app_human(db):
    db.execute("set local role app_human")
    tx = _TxConn(db)
    did = store.save_draft(tx, "brief", "facebook", TEXT_VI, OK_G,
                           created_by="agent:studio")
    assert tx.committed == 1
    assert db.execute("select actor, action from agent_action_log where"
                      " object_id = %s", (str(did),)).fetchall() == \
        [("agent:studio", "draft_create")]
    # Người tạo tự duyệt → pre-check Python chặn; function cũng chặn.
    assert store.set_status(tx, did, "approved", " AGENT:studio ")[0] is False
    assert store.set_status(tx, did, "approved", "Hoa", "ok") == (True, None)
    assert tx.committed == 2
    assert store.verify_publish(tx, did, TEXT_VI) is True
    assert store.verify_publish(tx, did, TEXT_VI[:-1] + "x") is False
    ok, warn = store.set_status(tx, did, "approved", "Mai")
    assert not ok and "approved" in warn
    ok, warn = store.schedule(tx, did, store._vn_today(), "Hoa")
    assert (ok, warn) == (True, None)
    n, probs = store.verify_log(tx)
    assert n == 3 and probs == []
    db.execute("reset role")


def test_store_snapshot_forged_not_approved(db):
    """Agent ghi snapshot ok:true cho text có từ cấm → store chặn (re-check)."""
    did = _draft(db, text="Sâm chữa khỏi tiểu đường")
    db.execute("set local role app_human")
    tx = _TxConn(db)
    ok, warn = store.set_status(tx, did, "approved", "Hoa")
    assert not ok and "kiểm lại" in warn and tx.committed == 0
    db.execute("reset role")
    assert db.execute("select status from content_drafts where id = %s",
                      (did,)).fetchone() == ("pending",)


def test_store_function_error_returns_warn(db):
    """Function raise (permission/guard) → (False, message_primary)."""
    did = _draft(db)
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    ok, warn = store.set_status(tx, did, "approved", "Hoa")
    assert not ok and "permission denied" in warn and tx.committed == 0
    db.execute("reset role")


# ---------- CLI trên DB thật — CHỈ case âm (không duyệt gì thật) ----------

def _cli(*args):
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, "-m", "pipelines.store", *args],
                          cwd=ROOT, env=env, capture_output=True,
                          timeout=120, encoding="utf-8", errors="replace",
                          check=False)


def test_cli_real_db_negative_only(db):
    r = _cli("--approve", "999999", "--by", "X")
    assert r.returncode == 2 and "không tìm thấy" in r.stderr, r.stderr
    r = _cli("--verify-log")
    assert r.returncode == 0 and "[ok] chuỗi nguyên vẹn" in r.stdout, \
        (r.stdout, r.stderr)


# ---------- W34.1 chuỗi: isolation + id cấp sau khóa (conn riêng) ----------

def _own_conn(**kw):
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        return psycopg.connect(dsn, connect_timeout=5, **kw)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")


@pytest.mark.parametrize("level, name", [
    (psycopg.IsolationLevel.REPEATABLE_READ, "repeatable read"),
    (psycopg.IsolationLevel.SERIALIZABLE, "serializable")])
def test_chain_rejects_non_read_committed(level, name):
    """Snapshot RR/SERIALIZABLE không thấy dòng tx khác vừa commit → 2 dòng
    cùng prev_hash (rẽ nhánh). Trigger phải từ chối ghi ngoài READ
    COMMITTED. Schema tạm tạo TRONG tx isolation đó, rollback cuối."""
    conn = _own_conn()
    try:
        conn.isolation_level = level
        conn.execute("set local lock_timeout = '10s'")
        assert conn.execute("select current_setting('transaction_isolation')"
                            ).fetchone()[0] == name
        schema = f"t_auth_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        with pytest.raises(RaiseException, match="READ COMMITTED"), \
                conn.transaction():
            _log(conn, "a1")
        assert conn.execute("select count(*) from agent_action_log"
                            ).fetchone()[0] == 0
    finally:
        conn.rollback()
        conn.close()


def test_chain_id_assigned_after_lock_concurrent():
    """2 tx chèn log song song: B lấy id (default) TRƯỚC khi chờ advisory
    lock A đang giữ; A chèn thêm rồi commit. id phải cấp SAU khóa → thứ tự
    id == thứ tự chuỗi, verify sạch (nếu id lấy trước khóa: B id nhỏ hơn
    A2 nhưng prev_hash = A2 → chuỗi theo id gãy). Cần schema COMMITTED để
    2 conn cùng thấy — drop cascade ở finally. Chờ B bằng trạng thái DB
    (pg_locks advisory chưa granted), không assert wall-clock."""
    import threading
    import time

    schema = f"t_auth_{uuid.uuid4().hex[:12]}"
    setup = _own_conn(autocommit=True)
    a = b = None
    try:
        setup.execute(f"create schema {schema}")
        with setup.transaction():
            setup.execute(f"set local search_path to {schema}, pg_temp")
            setup.execute(SCHEMA_SQL)
        a, b = _own_conn(), _own_conn()
        for c in (a, b):
            c.execute(f"set search_path to {schema}, pg_temp")
            c.execute("set lock_timeout = '30s'")
            c.commit()
        _log(a, "A1")                      # A giữ advisory lock tới commit
        b_pid, err = b.info.backend_pid, []

        def run_b():
            try:
                _log(b, "B")
                b.commit()
            except Exception as e:          # noqa: BLE001 — trả về main
                err.append(e)
                b.rollback()

        t = threading.Thread(target=run_b)
        t.start()
        waiting, deadline = False, time.monotonic() + 20
        while time.monotonic() < deadline and t.is_alive():
            waiting = setup.execute(
                "select exists (select 1 from pg_locks where pid = %s and "
                "locktype = 'advisory' and not granted)",
                (b_pid,)).fetchone()[0]
            if waiting:
                break
            time.sleep(0.05)
        _log(a, "A2")
        a.commit()
        t.join(timeout=40)
        assert waiting and not t.is_alive() and not err, err
        rows = setup.execute(
            f"select id, actor, prev_hash, row_hash from {schema}."
            f"agent_action_log order by id").fetchall()
        assert [r[1] for r in rows] == ["A1", "A2", "B"]
        assert rows[0][2] == ZERO
        for k in (1, 2):
            assert rows[k][2] == rows[k - 1][3]
        assert setup.execute(
            f"select count(*) from {schema}.verify_action_log()"
        ).fetchone()[0] == 0
    finally:
        for c in (a, b):
            if c is not None:
                c.rollback()
                c.close()
        setup.execute(f"drop schema if exists {schema} cascade")
        setup.close()


# ---------- v4.2 W42.4: readiness từ view DB dưới role app_human ----------

def test_store_readiness_view_as_app_human_gates_approve(db):
    """Grant `select on sku_readiness` (roles.sql v4.2) -> store đọc được view
    dưới app_human; approve claim Savina chỉ qua khi view nói QC_DAY_DU
    (sửa tay xnqc_status trên bản copy golden — mẫu parity v4.1)."""
    import copy
    import json

    from ingest import golden_store as gs

    doc = json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8"))
    doc1 = copy.deepcopy(doc)
    sav = next(s for s in doc1["skus"] if s["sku_key"] == "savina-12v")
    sav["allowed_channels"] = sorted(set(sav["allowed_channels"])
                                     | {"facebook"})
    gs.load(db, doc1)
    canon = ("Thực phẩm này không phải là thuốc và không có tác dụng thay "
             "thế thuốc chữa bệnh")
    text = f"Savina 12 viên hỗ trợ giảm ho. {canon}.\nNội dung có sử dụng AI"
    did = _draft(db, text=text)

    db.execute("set local role app_human")
    tx = _TxConn(db)
    m = store.readiness_from_db(tx)
    assert m is not None and len(m) == 13 * 6
    assert m[("savina-12v", "facebook")] == "MO_TA"
    ok, warn = store.set_status(tx, did, "approved", "Hoa")
    assert not ok and "sku_chua_xnqc" in warn and tx.committed == 0
    db.execute("reset role")
    # agent_writer cũng đọc được (app_human kế thừa grant này).
    with _as(db, "agent_writer"):
        assert db.execute("select count(*) from sku_readiness").fetchone()[0] \
            == 13 * 6

    doc2 = copy.deepcopy(doc1)
    next(s for s in doc2["skus"]
         if s["sku_key"] == "savina-12v")["xnqc_status"] = "approved"
    gs.load(db, doc2)
    db.execute("set local role app_human")
    tx = _TxConn(db)
    assert store.readiness_from_db(tx)[("savina-12v", "facebook")] == \
        "QC_DAY_DU"
    assert store.set_status(tx, did, "approved", "Hoa", "ok") == (True, None)
    db.execute("reset role")
    assert db.execute("select status from content_drafts where id = %s",
                      (did,)).fetchone() == ("approved",)
