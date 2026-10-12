"""v4.0 W40.1–W40.6 — hàng duyệt dùng chung trên DB THẬT (schema tạm,
rollback) — precedent `tests/test_auth_approval.py`.

Mỗi test: 1 transaction trên `DATABASE_URL`, `create schema` tạm +
docs/schema.sql ×2 + docs/roles.sql ×2 → ROLLBACK cuối test. Case lỗi chạy
trong savepoint; thử quyền bằng `set local role agent_writer|app_human`;
đi tắt thời gian (due_at quá khứ) bằng superuser `session_replication_role
= replica` rồi trả về `origin` ngay (SET LOCAL sống tới hết transaction).
`now()` cố định trong 1 transaction → due_at/created_at so khớp tuyệt đối.
Skip khi không có DB — gate yêu cầu 0 skipped. NGƯỜI/AGENT trong test là
tên giả lập, không phải người duyệt thật.
"""

import os
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import (
    CheckViolation,
    InsufficientPrivilege,
    RaiseException,
    UniqueViolation,
)
from psycopg.types.json import Jsonb

from pipelines import approval_queue as aq
from pipelines import director, red_alert, store

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
OK_G = {"ok": True, "violations": [], "matched_claims": []}
BAD_G = {"ok": False, "violations": [{"type": "banned_word"}]}
# Có dấu + CRLF + emoji — viết escape (gotcha ký tự vô hình).
TEXT = "Bảng giá Tết — hộp quà Sâm Ngọc Linh\r\n\U0001f33f"
NEW_FUNCS = ("enqueue_item", "decide_item", "auto_approve_item",
             "override_qa", "expire_overdue")
ENQ = "select enqueue_item(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
DECIDE = "select decide_item(%s, %s, %s, %s)"
AW, AH = "agent_writer", "app_human"


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
        schema = f"t_w40_{uuid.uuid4().hex[:12]}"
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


def _verify(conn):
    return [tuple(r) for r in conn.execute(
        "select id, problem from verify_action_log()").fetchall()]


def _one(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]


def _enq(conn, oid="sku-1", *, ot="price_change", block="sales",
         payload=TEXT, risk="medium", g=OK_G, qa="none", by="agent:a3",
         sla=24, role=AW):
    with _as(conn, role):
        return conn.execute(ENQ, (ot, oid, block, "Đổi giá hộp quà",
                                  payload, risk, Jsonb(g), qa, by, sla)
                            ).fetchone()[0]


def _decide(conn, qid, by, decision="approved", role=AH):
    with _as(conn, role):
        return conn.execute(DECIDE, (qid, by, decision, None)).fetchone()[0]


def _overdue(conn, qid):
    """Đẩy due_at về quá khứ (superuser, bỏ trigger) rồi bật lại trigger."""
    conn.execute("set local session_replication_role = replica")
    conn.execute("update approval_queue set due_at = now() - interval '1 h'"
                 " where id = %s", (qid,))
    conn.execute("set local session_replication_role = origin")


def _status(conn, qid):
    return _one(conn, "select status from approval_queue where id = %s",
                (qid,))


def _vp(conn, oid, text, ot="price_change"):
    with _as(conn, AH):
        return _one(conn, "select verify_publish(%s, %s, %s)", (ot, oid, text))


# ---------- W40.1 schema ----------

def test_insert_forces_sha_and_pending(db):
    qid = _one(db, "insert into approval_queue (object_type, object_id, block,"
               " title, payload, content_sha256, risk, guardrail, created_by,"
               " due_at, status, lane, decided_by) values ('price_change',"
               " 'x', 'sales', 't', %s, %s, 'low', %s, 'agent:a', now() +"
               " interval '1 h', 'approved', 'per_item', 'Hoa') returning id",
               (TEXT, "a" * 64, Jsonb(OK_G)))
    row = db.execute("select content_sha256, status, lane, decided_by from"
                     " approval_queue where id = %s", (qid,)).fetchone()
    assert row == (store.content_sha256(TEXT), "pending", None, None)


def test_content_draft_forbidden_and_pending_unique(db):
    _raises(db, ENQ, ("content_draft", "1", "marketing", "t", "x", "low",
                      Jsonb(OK_G), "none", "agent:a", 24),
            exc=CheckViolation)
    q1 = _enq(db, "sku-9")
    _raises(db, ENQ, ("price_change", "sku-9", "sales", "t", "y", "low",
                      Jsonb(OK_G), "none", "agent:a", 24),
            exc=UniqueViolation)
    _decide(db, q1, "agent:a3", "rejected")      # người tạo tự rút được
    q2 = _enq(db, "sku-9")                        # sau rejected → enqueue lại
    _overdue(db, q2)
    with _as(db, AW):
        assert _one(db, "select expire_overdue()") == 1
    q3 = _enq(db, "sku-9")                        # sau expired → lại được
    assert len({q1, q2, q3}) == 3
    assert _status(db, q3) == "pending"


def test_queue_immutable_and_no_delete_even_superuser(db):
    qid = _enq(db)
    for col, val in (("payload", "'khác'"), ("created_by", "'Hoa'"),
                     ("due_at", "now() + interval '9 days'"),
                     ("content_sha256", "repeat('b', 64)"),
                     ("guardrail", "'{\"ok\": true}'"), ("risk", "'low'"),
                     ("qa_status", "'pass'"), ("block", "'ceo'")):
        _raises(db, f"update approval_queue set {col} = {val}"
                    f" where id = {qid}")
    _raises(db, "update approval_queue set status = 'pending' where id = %s",
            (qid,))
    _raises(db, "update approval_queue set status = 'approved' where id = %s",
            (qid,))                               # thiếu người quyết định
    _decide(db, qid, "Hoa")
    _raises(db, "update approval_queue set status = 'pending',"
                " decided_by = 'x' where id = %s", (qid,))
    _raises(db, "delete from approval_queue")
    _raises(db, "truncate approval_queue cascade")
    assert _status(db, qid) == "approved"


def test_auto_policies_decisions_snapshots_constraints(db):
    _raises(db, "insert into auto_policies (id, object_type, max_risk) values"
                " ('p1', 'intel_bulletin', 'medium')", exc=CheckViolation)
    _raises(db, "insert into auto_policies (id, object_type, max_risk,"
                " enabled) values ('p1', 'intel_bulletin', 'low', true)",
            exc=CheckViolation)
    _raises(db, "insert into auto_policies (id, object_type, max_risk,"
                " enabled, signed_by, signed_at) values ('p1', 'x', 'low',"
                " true, '   ', now())", exc=CheckViolation)
    assert _one(db, "select count(*) from auto_policies") == 0  # ship rỗng
    qid = _enq(db)
    _raises(db, "insert into decisions (kind, queue_id, decided_by, reason)"
                " values ('override_qa', %s, 'Hoa', '  123456789  ')",
            (qid,), exc=CheckViolation)
    db.execute("insert into decisions (kind, queue_id, decided_by, reason)"
               " values ('override_qa', %s, 'Hoa', '1234567890')", (qid,))
    snap = ("insert into channel_snapshots (channel, metric_id, period_kind,"
            " period_start, value, source, captured_by) values ('shopee',"
            " 'orders.count', 'week', '2026-09-28', 12, %s, 'agent:mkt09')")
    _raises(db, snap, ("scrape",), exc=CheckViolation)
    with _as(db, AW):
        db.execute(snap, ("manual_export",))
    _raises(db, snap, ("manual_export",), exc=UniqueViolation)
    db.execute(snap, ("api",))                    # khác source → được
    with _as(db, AW):
        db.execute("insert into red_alerts (source_agent, title) values"
                   " ('agent:intel', 'test')")
    for t, col in (("decisions", "reason"), ("red_alerts", "title")):
        _raises(db, f"update {t} set {col} = {col}")
        _raises(db, f"delete from {t}")
        # cascade: v7.1 red_alert_acks FK → red_alerts (truncate trần lỗi FK
        # trước trigger). Cascade kéo cả red_alert_acks (cũng append-only) —
        # assert ĐÚNG bảng chặn, không thì gỡ trigger gốc vẫn xanh.
        msg = _raises(db, f"truncate {t} cascade")
        assert msg.startswith(f"{t} append-only"), msg
    assert _one(db, "select count(*) from decisions") == 1
    assert _one(db, "select count(*) from red_alerts") == 1


# ---------- W40.2 function + quyền ----------

def test_functions_security_definer_and_grants(db):
    schema = _one(db, "select current_schema()")
    rows = db.execute(
        "select proname, prosecdef, proconfig from pg_proc where"
        " pronamespace = %s::regnamespace and proname = any(%s)",
        (schema, list(NEW_FUNCS))).fetchall()
    assert {r[0] for r in rows} == set(NEW_FUNCS)
    for name, secdef, cfg in rows:
        assert secdef is True, name
        sp = [c for c in (cfg or []) if c.startswith("search_path=")]
        assert sp == [f"search_path={schema}, pg_temp"], (name, cfg)
    sigs = {"enqueue_item": "enqueue_item(text,text,text,text,text,text,"
                            "jsonb,text,text,int)",
            "decide_item": "decide_item(bigint,text,text,text)",
            "auto_approve_item": "auto_approve_item(bigint)",
            "override_qa": "override_qa(bigint,text,text)",
            "expire_overdue": "expire_overdue(text)"}
    q = "select has_function_privilege(%s, %s, 'execute')"
    for name, sig in sigs.items():
        assert _one(db, q, ("public", sig)) is False, sig
        assert _one(db, q, (AH, sig)) is True, sig
        want_aw = name not in ("decide_item", "override_qa")
        assert _one(db, q, (AW, sig)) is want_aw, sig
    assert db.execute("select rolcanlogin from pg_roles where rolname = any("
                      "%s)", ([AW, AH],)).fetchall() == [(False,), (False,)]


def test_agent_writer_cannot_decide_or_touch(db):
    qid = _enq(db)
    _denied(db, AW, "update approval_queue set status = 'approved',"
                    " decided_by = 'bot'")
    _denied(db, AW, "delete from approval_queue")
    _denied(db, AW, "insert into approvals (object_type, object_id,"
                    " content_sha256, decision, approved_by) values"
                    " ('price_change', 'sku-1', %s, 'approved', 'bot')",
            ("a" * 64,))
    _denied(db, AW, DECIDE, (qid, "bot2", "approved", None))
    _denied(db, AW, "select override_qa(%s, 'bot2', 'lý do đủ dài rồi')",
            (qid,))
    _denied(db, AW, "insert into approval_queue (object_type, object_id,"
                    " block, title, payload, content_sha256, risk,"
                    " guardrail, created_by, due_at) values ('x1', '1',"
                    " 'sales', 't', 'p', %s, 'low', '{}', 'bot', now())",
            ("a" * 64,))
    _denied(db, AW, "insert into auto_policies (id, object_type, max_risk)"
                    " values ('p', 'x', 'low')")
    _denied(db, AW, "insert into decisions (kind, queue_id, decided_by,"
                    " reason) values ('override_qa', %s, 'bot',"
                    " 'lý do đủ dài rồi')", (qid,))
    with _as(db, AW):
        db.execute("insert into red_alerts (source_agent, title) values"
                   " ('agent:intel', 'đỏ')")
    _denied(db, AW, "delete from red_alerts")
    _denied(db, AW, "update red_alerts set title = 'x'")
    _denied(db, AW, "update channel_snapshots set value = 0")
    # Least privilege: agent chỉ đọc metadata, KHÔNG đọc payload/guardrail.
    for col in ("payload", "*", "guardrail", "content_sha256"):
        _denied(db, AW, f"select {col} from approval_queue")
    now = _one(db, "select now()")
    with _as(db, AW):                    # query bản tin GĐ vẫn chạy được
        rows = db.execute(director._ITEM_SQL, ("sales", now, now)).fetchall()
    assert [r[0] for r in rows] == [qid]
    with _as(db, AH):
        assert _one(db, "select payload from approval_queue where id = %s",
                    (qid,)) == TEXT
    assert _status(db, qid) == "pending"
    assert _one(db, "select count(*) from approvals") == 0
    assert _verify(db) == []


def test_red_alerts_human_and_superuser_cannot_erase(db):
    """TGĐ/Quản lý hạ tầng AI là NGƯỜI = app_human: không xóa/sửa được;
    superuser (owner) bị trigger chặn."""
    _denied(db, AW, "insert into red_alerts (source_agent, title, ts)"
                    " values ('agent:intel', 'đỏ', '2000-01-01')")
    _denied(db, AW, "select title from red_alerts")
    db.execute("insert into red_alerts (source_agent, title, ts, db_role)"
               " values ('agent:intel', 'đỏ', '2000-01-01', 'fake')")
    row = db.execute("select ts > now() - interval '1 h', db_role ="
                     " session_user from red_alerts").fetchone()
    assert row == (True, True)                     # DB đóng dấu, không tin client
    _denied(db, AH, "delete from red_alerts")
    _denied(db, AH, "update red_alerts set title = 'đã xử lý'")
    _denied(db, AH, "truncate red_alerts")
    _raises(db, "delete from red_alerts")
    _raises(db, "update red_alerts set recipients = '{}'")
    # v7.1: FK từ acks → cascade; assert trigger GỐC chặn, không phải
    # trigger của red_alert_acks bị cascade kéo theo.
    msg = _raises(db, "truncate red_alerts cascade")
    assert msg.startswith("red_alerts append-only"), msg
    assert _one(db, "select count(*) from red_alerts") == 1


def test_decide_item_rules_and_publish_hash(db):
    bad = _enq(db, "bad", g=BAD_G)
    good = _enq(db, "good", by=" Lan ")
    q = DECIDE
    assert "guardrail" in _raises(db, q, (bad, "Hoa", "approved", None),
                                  role=AH)
    for same in ("lan", "LAN ", " Lan "):
        assert "người tạo" in _raises(db, q, (good, same, "approved", None),
                                      role=AH)
    for empty in ("", "   ", None):
        assert "thiếu" in _raises(db, q, (good, empty, "approved", None),
                                  role=AH)
    assert "không hợp lệ" in _raises(db, q, (good, "Hoa", "expired", None),
                                     role=AH)
    assert "không tìm thấy" in _raises(db, q, (999999, "Hoa", "approved",
                                                None), role=AH)
    assert _one(db, "select count(*) from approvals") == 0
    aid = _decide(db, good, "Hoa")
    row = db.execute("select status, lane, decided_by from approval_queue"
                     " where id = %s", (good,)).fetchone()
    assert row == ("approved", "per_item", "Hoa")
    assert db.execute("select id, object_type, object_id, content_sha256,"
                      " decision, approved_by from approvals").fetchall() == [
        (aid, "price_change", "good", store.content_sha256(TEXT),
         "approved", "Hoa")]
    assert _vp(db, "good", TEXT) is True
    assert _vp(db, "good", TEXT[:-1] + "x") is False
    assert "pending" in _raises(db, q, (good, "Mai", "approved", None),
                                role=AH)
    assert _one(db, "select count(*) from agent_action_log where action ="
                    " 'queue_approve' and detail->>'queue_id' = %s",
                (str(good),)) == 1
    assert _one(db, "select count(*) from agent_action_log where"
                    " detail ? 'payload'") == 0
    assert _verify(db) == []


def test_override_qa_flow(db):
    qid = _enq(db, "qa", qa="fail", by="agent:a3")
    ov = "select override_qa(%s, %s, %s)"
    assert "QA FAIL" in _raises(db, DECIDE, (qid, "Hoa", "approved", None),
                                role=AH)
    for reason in ("", None, "   ngắn   ", "\n" * 12, "\t" * 10,
                   " \r\n\t" * 5, "\n123456789\t"):
        assert "10 ký tự" in _raises(db, ov, (qid, "Hoa", reason), role=AH)
    assert _one(db, "select count(*) from decisions") == 0
    # Wrapper Python cũng chặn (trước DB) — không ghi decisions.
    with _as(db, AH):
        tx = _TxConn(db)
        for reason in ("\n" * 12, "\t" * 10):
            ok, msg = aq.override(tx, qid, "Hoa", reason)
            assert ok is False and "10 ký tự" in msg
    assert _one(db, "select count(*) from decisions") == 0
    # CHECK bảng (cài mới) cũng đếm không-khoảng-trắng.
    _raises(db, "insert into decisions (kind, queue_id, decided_by, reason)"
                " values ('override_qa', %s, 'Hoa', %s)", (qid, "\n" * 12),
            exc=CheckViolation)
    assert "người tạo" in _raises(db, ov, (qid, " AGENT:A3 ",
                                           "lý do đủ dài để ép trình"),
                                  role=AH)
    assert "thiếu" in _raises(db, ov, (qid, "  ", "lý do đủ dài để ép"),
                              role=AH)
    pass_item = _enq(db, "qa-pass", qa="pass")
    assert "QA FAIL" in _raises(db, ov, (pass_item, "Hoa",
                                         "lý do đủ dài để ép"), role=AH)
    with _as(db, AH):
        did = _one(db, ov, (qid, "Hoa",
                             "  khách B2B cần gấp, QA lỗi định dạng  "))
    assert db.execute("select kind, queue_id, decided_by, reason from"
                      " decisions").fetchall() == [
        ("override_qa", qid, "Hoa", "khách B2B cần gấp, QA lỗi định dạng")]
    assert _status(db, qid) == "pending"           # override KHÔNG duyệt
    _decide(db, qid, "Mai")
    assert _status(db, qid) == "approved"
    assert did and _verify(db) == []


def test_expire_never_approves(db):
    qid = _enq(db, "late")
    fresh = _enq(db, "fresh", sla=24)              # còn trong SLA
    _overdue(db, qid)
    assert "quá hạn" in _raises(db, DECIDE, (qid, "Hoa", "approved", None),
                                role=AH)
    assert "quá hạn" in _raises(db, "select auto_approve_item(%s)", (qid,),
                                role=AW)
    with _as(db, AW):
        assert _one(db, "select expire_overdue()") == 1
    # Mục chưa tới hạn KHÔNG bị expire (khóa điều kiện due_at <= now()).
    assert _status(db, fresh) == "pending"
    assert _one(db, "select count(*) from decisions where queue_id = %s",
                (fresh,)) == 0
    row = db.execute("select status, lane, decided_by from approval_queue"
                     " where id = %s", (qid,)).fetchone()
    assert row == ("expired", None, "system:sla")
    assert db.execute("select kind, decided_by from decisions where queue_id"
                      " = %s", (qid,)).fetchall() == [("expired",
                                                       "system:sla")]
    assert "giờ VN" in _one(db, "select reason from decisions where"
                                " queue_id = %s", (qid,))
    assert _one(db, "select count(*) from approvals where object_id ="
                    " 'late'") == 0
    assert _vp(db, "late", TEXT) is False
    with _as(db, AW):
        assert _one(db, "select expire_overdue()") == 0
    assert _status(db, fresh) == "pending"
    assert _verify(db) == []


def test_auto_approve_fail_closed_then_signed_policy(db):
    low = _enq(db, "b1", ot="intel_bulletin", block="intel", risk="low",
               qa="pass", by="agent:intel")
    aa = "select auto_approve_item(%s)"
    assert "không có auto_policy" in _raises(db, aa, (low,), role=AW)
    db.execute("insert into auto_policies (id, object_type, max_risk) values"
               " ('intel_low', 'intel_bulletin', 'low')")  # enabled=false
    assert "không có auto_policy" in _raises(db, aa, (low,), role=AW)
    # Chủ khối ký (giả lập trong test — bảng thật ship rỗng).
    db.execute("update auto_policies set enabled = true, signed_by ="
               " 'Chu Khoi Gia Lap (test)', signed_at = now()")
    med = _enq(db, "b2", ot="intel_bulletin", block="intel", risk="medium",
               qa="pass")
    nqa = _enq(db, "b3", ot="intel_bulletin", block="intel", risk="low")
    badg = _enq(db, "b4", ot="intel_bulletin", block="intel", risk="low",
                qa="pass", g=BAD_G)
    other = _enq(db, "b5", ot="competitor_report", block="intel",
                 risk="low", qa="pass")
    assert "rủi ro medium" in _raises(db, aa, (med,), role=AW)
    assert "QA none" in _raises(db, aa, (nqa,), role=AW)
    assert "guardrail" in _raises(db, aa, (badg,), role=AW)
    assert "không có auto_policy" in _raises(db, aa, (other,), role=AW)
    with _as(db, AW):
        aid = _one(db, aa, (low,))
    row = db.execute("select status, lane, decided_by from approval_queue"
                     " where id = %s", (low,)).fetchone()
    assert row == ("approved", "auto_policy", "auto_policy:intel_low")
    assert _one(db, "select approved_by from approvals where id = %s",
                (aid,)).startswith("auto_policy:")
    assert _one(db, "select detail->>'signed_by' from agent_action_log where"
                    " action = 'queue_auto_approve'") == \
        "Chu Khoi Gia Lap (test)"
    assert _vp(db, "b1", TEXT, ot="intel_bulletin") is True
    assert _verify(db) == []


# ---------- W40.3 wrapper Python (DB thật, _TxConn) ----------

class _TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

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


def test_wrapper_flow_roles(db):
    tx = _TxConn(db)
    db.execute(f"set local role {AW}")
    qid = aq.enqueue(tx, object_type="b2b_quote", object_id="Q-1",
                     block="sales", title="Báo giá B2B", payload=TEXT,
                     risk="high", created_by="agent:a3", sla_hours=24)
    assert tx.committed == 1
    ok, msg = aq.decide(tx, qid, "Hoa", "approved")   # agent không duyệt được
    assert not ok and "permission denied" in msg
    db.execute(f"set local role {AH}")
    assert aq.decide(tx, qid, " agent:A3 ", "approved")[0] is False
    assert aq.decide(tx, qid, "Hoa", "approved", "ok") == (True, None)
    assert aq.verify(tx, qid, TEXT) is True
    assert aq.verify(tx, qid, TEXT + " ") is False
    assert aq.verify(tx, 999999, TEXT) is False
    assert aq.pending(tx) == []
    db.execute("reset role")
    assert _verify(db) == []


def test_wrapper_recheck_forged_snapshot(db):
    """Snapshot guardrail ok:true do agent ghi thẳng function → Python kiểm
    lại payload, không gọi decide_item."""
    qid = _enq(db, "forged", payload="Sâm chữa khỏi tiểu đường")
    db.execute(f"set local role {AH}")
    tx = _TxConn(db)
    ok, msg = aq.decide(tx, qid, "Hoa", "approved")
    assert not ok and "kiểm lại" in msg and tx.committed == 0
    db.execute("reset role")
    assert _status(db, qid) == "pending"


def _cli(module, *args):
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, "-m", module, *args], cwd=ROOT,
                          env=env, capture_output=True, timeout=120,
                          encoding="utf-8", errors="replace", check=False)


def test_cli_real_db_negative_only(db):
    r = _cli("pipelines.approval_queue", "--approve", "999999999", "--by",
             "X")
    assert r.returncode == 1 and "không tìm thấy" in r.stderr, r.stderr
    r = _cli("pipelines.approval_queue", "--pending")
    assert r.returncode == 0 and "[pending]" in r.stdout, (r.stdout,
                                                           r.stderr)


# ---------- W40.4 cảnh báo đỏ (DB) ----------

def test_raise_alert_as_agent_writer(db):
    db.execute(f"set local role {AW}")
    tx = _TxConn(db)
    routed, msg = red_alert.raise_alert(tx, "agent:intel-red",
                                        "Gọi 0912 345 678 về lô lỗi",
                                        {"sdt": "0912345678", "n": 3})
    assert routed is False and "thiếu người nhận" in msg
    ok_routing = {"recipients": [{"name": "Nguoi Nhan Gia Lap (test)",
                                  "role": "phap_che", "channel": "email"}]}
    routed2, _ = red_alert.raise_alert(tx, "agent:intel-red", "Lô B",
                                       routing=ok_routing)
    assert routed2 is True and tx.committed == 2
    db.execute("reset role")
    rows = db.execute("select title, detail, recipients, route_error from"
                      " red_alerts order by id").fetchall()
    assert "0912" not in rows[0][0] and "0912" not in str(rows[0][1])
    assert rows[0][1]["n"] == 3
    assert rows[0][2] == [] and "thiếu người nhận" in rows[0][3]
    assert rows[1][2] == ["Nguoi Nhan Gia Lap (test)"] and rows[1][3] is None
    assert _one(db, "select count(*) from agent_action_log where action ="
                    " 'red_alert_raise'") == 2
    assert _verify(db) == []


# ---------- W40.6 director submit/run (DB) ----------

def test_director_submit_and_run_expires(db, tmp_path):
    cfg = director.load_config("sales")
    db.execute(f"set local role {AW}")
    tx = _TxConn(db)
    qid = director.submit(tx, "sales", "price_change", "SKU-T1",
                          "Giảm giá hộp quà", TEXT, "agent:a5", cfg=cfg)
    fresh = director.submit(tx, "sales", "price_change", "SKU-T2",
                            "Giá hộp lẻ", TEXT, "agent:a5", cfg=cfg)
    gap =_one(db, "select due_at - created_at from approval_queue where"
                   " id = %s", (qid,))
    assert gap == timedelta(hours=cfg["object_types"]["price_change"]
                            ["sla_hours"])
    assert _one(db, "select risk from approval_queue where id = %s",
                (qid,)) == cfg["object_types"]["price_change"]["risk"]
    db.execute("reset role")
    _overdue(db, qid)
    n_appr = _one(db, "select count(*) from approvals")
    now = _one(db, "select now()")
    db.execute(f"set local role {AW}")
    path, text = director.run(tx, "sales", now=now, cfg=cfg,
                              out_dir=tmp_path)
    db.execute("reset role")
    assert _status(db, qid) == "expired"
    assert _status(db, fresh) == "pending"         # chưa tới hạn → giữ
    assert _one(db, "select count(*) from decisions where queue_id = %s",
                (fresh,)) == 0
    assert "| Đang chờ duyệt (tồn) | 1 |" in text
    assert _one(db, "select count(*) from approvals") == n_appr
    assert path.parent == tmp_path and path.name.startswith(
        "director-sales-")
    assert f"#{qid}" in text.split("## Hết hạn hôm nay")[1]
    assert "| Hết hạn SLA (expired) | 1 |" in text
    assert "BẢN NHÁP" in text and "external-dep" in text
    assert _verify(db) == []
