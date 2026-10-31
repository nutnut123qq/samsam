"""v10.0 W100.1–W100.4 + W100.7 — bảng `audit_runs`, role `bks_reader`,
`agents.bks_audit` (audit inside-out BKS) + guard chỉ-đọc 3 module.

DB thật: schema tạm + `docs/schema.sql` ×2 + `docs/roles.sql` ×2 → ROLLBACK
(`tests.test_ceo_audit.ceo_db`). Giả mạo bằng superuser `set local
session_replication_role = replica` trong savepoint `force_rollback`
(precedent `tests/test_auth_approval.py`). Tên người là giả lập.
"""

import ast
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from psycopg.errors import (
    CheckViolation,
    InsufficientPrivilege,
    RaiseException,
)
from psycopg.types.json import Jsonb

from agents import bks_audit as ba
from pipelines import guardrail, store
from pipelines.period import VN_TZ
from scripts import dpia_draft
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
OK_G = {"ok": True, "violations": [], "matched_claims": []}
DRAFT_TEXT = "Sâm Sâm — bài mẫu kiểm soát. Nội dung có sử dụng AI"
ENQ = "select enqueue_item(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
CREATOR = "agent:test-bks"
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
MODULES = ("agents/bks_audit.py", "agents/bks_recon.py",
           "agents/hdtv_report.py")
BKS_SELECT = (
    "agent_action_log", "approvals", "approval_queue", "decisions",
    "decision_log", "content_drafts", "channel_posts", "plot_logs",
    "settlement_rows", "recon_results", "market_snapshots", "market_rows",
    "market_alerts", "channel_snapshots", "cogs_versions", "sku_master",
    "llm_usage", "opex_entries", "project_milestones", "red_alerts",
    "red_alert_acks", "xnqc_dossiers", "audit_runs")


@pytest.fixture
def db():
    yield from ceo_db()


@contextmanager
def tamper(db):
    """Superuser tắt trigger trong savepoint — ROLLBACK khi ra."""
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        yield


@contextmanager
def as_role(db, role="bks_reader"):
    with db.transaction(force_rollback=True):
        db.execute(f"set local role {role}")
        yield


def _denied(db, sql, params=None, role="bks_reader"):
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute(f"set local role {role}")
        db.execute(sql, params)


def _log(db, n=3):
    for i in range(n):
        db.execute("insert into agent_action_log (actor, action, detail)"
                   " values (%s, 'test', %s)", (f"a{i}", Jsonb({"i": i})))
    return [r[0] for r in db.execute(
        "select id from agent_action_log order by id")]


def _plot_logs(db, n=3):
    db.execute("insert into plots (id, location, source) values"
               " ('KV-BKS', 'x', 'manual')")
    for i in range(n):
        db.execute("insert into plot_logs (plot_id, ts, activity, detail,"
                   " author, source) values ('KV-BKS', now() - %s *"
                   " interval '1 day', 'tưới', 'ok', 'Ky thuat', 'manual')",
                   (i + 1,))
    return [r[0] for r in db.execute(
        "select id from plot_logs order by id")]


def _codes(fs):
    return sorted(f["code"] for f in fs)


def _enq(db, oid, qa="none", by=CREATOR, payload=None):
    return db.execute(ENQ, ("board_pack", oid, "ceo", "t",
                            payload or f"payload {oid}",
                            "medium", Jsonb(OK_G), qa, by, 48)
                      ).fetchone()[0]


def _decide(db, qid, by, decision="approved"):
    db.execute("select decide_item(%s, %s, %s, %s)", (qid, by, decision,
                                                     None))


def _override(db, qid, by):
    return db.execute("select override_qa(%s, %s, %s)",
                      (qid, by, "đã xác nhận rủi ro, ép trình")).fetchone()[0]


def _draft(db):
    tx = TxConn(db)
    did = store.save_draft(tx, "brief", "facebook", DRAFT_TEXT,
                           guardrail.check(DRAFT_TEXT), created_by=CREATOR)
    assert store.set_status(tx, did, "approved", "Phap Che Gia Lap") == (
        True, None)
    return did


def _window(db):
    now = db.execute("select now()").fetchone()[0]
    return now - timedelta(days=1), now + timedelta(days=1)


# ------------------------------------------------------------ W100.1 schema

def test_audit_runs_append_only_and_checks(db):
    ins = ("insert into audit_runs (kind, period_label, findings,"
           " report_sha256, run_by) values (%s, %s, 0, %s, 'agent:x')")
    db.execute(ins, ("recon", "2026-Q3", "a" * 64))
    for sql in ("update audit_runs set findings = 1",
                "delete from audit_runs", "truncate audit_runs"):
        with pytest.raises(RaiseException, match="append-only"), \
                db.transaction():
            db.execute(sql)
    for bad in ("2026-13", "2026-Q5", "2026-W41", "2026-Q0", "26-09"):
        with pytest.raises(CheckViolation), db.transaction():
            db.execute(ins, ("recon", bad, "a" * 64))
    for kind, sha, by in (("khac", "a" * 64, "agent:x"),
                          ("recon", "A" * 64, "agent:x")):
        with pytest.raises(CheckViolation), db.transaction():
            db.execute(ins.replace("'agent:x'", "%s"), (kind, "2026-09", sha,
                                                        by))
    with pytest.raises(CheckViolation), db.transaction():
        db.execute(ins.replace("'agent:x'", "' '"), ("recon", "2026-09",
                                                     "a" * 64))


def test_bks_reader_read_only_role(db):
    assert db.execute("select rolcanlogin from pg_roles where rolname ="
                      " 'bks_reader'").fetchone() == (False,)
    with as_role(db):
        for t in BKS_SELECT:
            db.execute(f"select count(*) from {t}").fetchone()
        rid = db.execute(
            "insert into audit_runs (kind, period_label, params, findings,"
            " report_sha256, run_by) values ('inside_out', '2026-09', '{}',"
            " 0, %s, 'agent:bks_audit') returning id", ("b" * 64,)
        ).fetchone()[0]
        assert rid
        db.execute("select count(*) from verify_action_log()")
        db.execute("select count(*) from verify_plot_logs()")
        db.execute("select verify_publish('content_draft', '1', 'x')")
    _denied(db, "insert into approvals (object_type, object_id,"
                " content_sha256, decision, approved_by) values ('x', '1', %s,"
                " 'approved', 'BKS')", ("c" * 64,))
    _denied(db, "update content_drafts set text = 'x'")
    _denied(db, "delete from agent_action_log")
    _denied(db, "select decide_item(1, 'BKS', 'approved', null)")
    _denied(db, "select override_qa(1, 'BKS', 'ly do du muoi ky tu')")
    _denied(db, "select approve_draft(1, 'BKS', null)")
    _denied(db, "insert into audit_runs (kind, period_label, findings,"
                " report_sha256, run_by, created_at) values ('recon',"
                " '2026-09', 0, %s, 'x', now())", ("d" * 64,))
    _denied(db, "select count(*) from chunks")
    for role in ("agent_writer", "app_human"):
        q = "select has_table_privilege(%s, 'audit_runs', %s)"
        for priv in ("SELECT", "INSERT"):
            assert db.execute(q, (role, priv)).fetchone()[0] is False


def test_roles_sql_lists_tables_not_all_tables():
    roles = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
    # v14.2: khối BKS kết thúc ở khối kế tiếp — khối login dịch vụ v14.2
    # (svc_loader UPDATE/DELETE bảng nạp) không thuộc phạm vi kiểm này.
    block = roles[roles.index("v10.0 HĐTV/BKS"):
                  roles.index("-- ===== v12.1 B1 =====")]
    assert "all tables" not in block.split("do $$")[1].split("end $$")[1]
    for t in BKS_SELECT:
        assert re.search(rf"(?<!\w){t}(?!\w)", block), t
    assert not re.search(r"grant\s+(update|delete|truncate)", block,
                         re.IGNORECASE)


# ------------------------------------------------------------ W100.2 chuỗi

def test_chain_clean_then_tampered(db):
    ids = _log(db, 4)
    pids = _plot_logs(db, 3)
    heads, fs = ba.check_chains(db, None)
    assert fs == []
    assert heads["agent_action_log"]["max_id"] == ids[-1]
    assert heads["plot_logs"]["n"] == 3
    with tamper(db):                                           # (b)
        db.execute("update agent_action_log set detail = '{\"x\":1}' where"
                   " id = %s", (ids[1],))
        _, fs = ba.check_chains(db, None)
        assert fs == [{"code": "chuoi_bi_sua", "table": "agent_action_log",
                       "id": ids[1], "problem": "row_hash"}]
    with tamper(db):                                           # (c)
        db.execute("delete from agent_action_log where id = %s", (ids[1],))
        _, fs = ba.check_chains(db, None)
        assert fs == [{"code": "chuoi_bi_sua", "table": "agent_action_log",
                       "id": ids[2], "problem": "prev_hash"}]
    with tamper(db):                                           # (d)
        db.execute("update plot_logs set detail = 'sua' where id = %s",
                   (pids[1],))
        _, fs = ba.check_chains(db, None)
        assert fs == [{"code": "chuoi_bi_sua", "table": "plot_logs",
                       "id": pids[1], "problem": "row_hash"}]
    with tamper(db):                                           # (e)
        new = db.execute(
            "insert into plot_logs (plot_id, ts, activity, source) values"
            " ('KV-BKS', now(), 'bón', 'manual') returning id").fetchone()[0]
        _, fs = ba.check_chains(db, None)
        assert fs == [{"code": "chuoi_bi_sua", "table": "plot_logs",
                       "id": new, "problem": "unchained"}]
    assert ba.check_chains(db, None)[1] == []


def test_tail_anchor_catches_last_row_delete(db):
    ids = _log(db, 3)
    tx = TxConn(db)
    assert ba.latest_heads(tx) is None
    heads, fs = ba.check_chains(tx, None)
    assert fs == []
    ba.record_run(tx, "inside_out", "2026-09", {"heads": heads}, 0, "x",
                  ba.RUN_BY)
    prev = ba.latest_heads(tx)
    assert prev["agent_action_log"]["max_id"] == ids[-1]
    assert ba.check_chains(tx, prev)[1] == []
    with tamper(db):                                           # (f)
        db.execute("delete from agent_action_log where id = %s", (ids[-1],))
        # Đối chứng: chuỗi thuần KHÔNG thấy xóa dòng cuối, audit không neo
        # cũng không thấy — neo là thứ bắt được.
        assert db.execute("select count(*) from verify_action_log()"
                          ).fetchone()[0] == 0
        assert ba.check_chains(tx, None)[1] == []
        fs = ba.check_chains(tx, ba.latest_heads(tx))[1]
        assert fs == [{"code": "mat_duoi_chuoi", "table": "agent_action_log",
                       "id": ids[-1],
                       "problem": "dong_neo_mat,so_dong_giam"}]


def test_chain_unverifiable_is_not_clean(db):
    _plot_logs(db, 2)
    with db.transaction(force_rollback=True):                  # (g)
        db.execute("revoke execute on function verify_plot_logs()"
                   " from bks_reader")
        db.execute("set local role bks_reader")
        heads, fs = ba.check_chains(db, None)
        assert [(f["code"], f["table"]) for f in fs] == [
            ("khong_kiem_duoc", "plot_logs")]
        assert "chuoi_bi_sua" not in _codes(fs)
        assert heads["plot_logs"]["n"] == 2


def test_tail_anchor_row_hash_changed(db):
    """Neo trỏ dòng VẪN CÒN nhưng row_hash khác bản đã neo → row_hash_khac
    (giữ nhánh `cur != prev.row_hash`)."""
    ids = _log(db, 2)
    heads, _ = ba.check_chains(db, None)
    prev = {"agent_action_log": dict(heads["agent_action_log"],
                                     row_hash="0" * 64)}
    assert ba.check_chains(db, prev)[1] == [{
        "code": "mat_duoi_chuoi", "table": "agent_action_log",
        "id": ids[-1], "problem": "row_hash_khac"}]


JUNK_HEADS = [None, [], "x", 5, True,
              {"agent_action_log": [1, 2], "plot_logs": "x"}]


@pytest.mark.parametrize("raw", JUNK_HEADS)
def test_valid_heads_non_dict_or_junk_entries(raw):
    got = ba._valid_heads(raw)
    assert got is None if not isinstance(raw, dict) else got == {}


def test_recorded_junk_heads_dropped_no_crash(db):
    """audit_runs.params.heads bị ghi rác → mục hỏng bị bỏ, check_chains
    không raise (mất `_valid_heads` → so `n` str/int TypeError)."""
    _log(db, 2)
    tx = TxConn(db)
    good = "a" * 64
    junk = {"agent_action_log": {"max_id": "5", "row_hash": good, "n": "3"},
            "plot_logs": {"max_id": None, "row_hash": None, "n": 0},
            "khac": {"max_id": 1, "row_hash": good, "n": 1}}
    for bad in ({"max_id": "5", "row_hash": good, "n": "3"},
                {"max_id": True, "row_hash": good, "n": 1},
                {"max_id": 1, "row_hash": "XYZ", "n": 1},
                {"max_id": 1, "row_hash": good.upper(), "n": 1},
                {"max_id": 1, "row_hash": good, "n": -1},
                {"max_id": 1, "row_hash": good, "n": False},
                {"max_id": 1.0, "row_hash": good, "n": 1}):
        with db.transaction(force_rollback=True):
            ba.record_run(tx, "inside_out", "2026-09",
                          {"heads": dict(junk, agent_action_log=bad)}, 0,
                          "x", ba.RUN_BY)
            prev = ba.latest_heads(tx)
            assert prev == {"plot_logs": {"max_id": None, "row_hash": None,
                                          "n": 0}}, bad
            assert ba.check_chains(tx, prev)[1] == []
    with db.transaction(force_rollback=True):
        ba.record_run(tx, "inside_out", "2026-09", {"heads": "rac"}, 0, "x",
                      ba.RUN_BY)
        assert ba.latest_heads(tx) is None
        assert ba.check_chains(tx, ba.latest_heads(tx))[1] == []


# ------------------------------------------------------------ W100.3 duyệt

def _approved_world(db):
    did = _draft(db)
    q1 = _enq(db, "BP-1")
    _decide(db, q1, "Hoa Gia Lap")
    q2 = _enq(db, "BP-2", qa="fail")
    _override(db, q2, "Mai Gia Lap")
    _decide(db, q2, "Hoa Gia Lap")
    return did, q1, q2


def test_approvals_clean_then_each_tamper_one_code(db):
    did, q1, q2 = _approved_world(db)
    assert ba.check_approvals(db) == []
    with tamper(db):                                           # (a)
        db.execute("update content_drafts set text = text || ' sửa' where"
                   " id = %s", (did,))
        assert ba.check_approvals(db) == [{
            "code": "noi_dung_lech_ban_duyet", "table": "content_drafts",
            "id": did}]
    with tamper(db):                                           # (b)
        db.execute("update approval_queue set payload = 'payload khac' where"
                   " id = %s", (q1,))
        fs = ba.check_approvals(db)
        assert [(f["code"], f["table"], f["id"]) for f in fs] == [
            ("noi_dung_lech_ban_duyet", "approval_queue", q1)]
    with tamper(db):                                           # (c)
        aid = db.execute(
            "insert into approvals (object_type, object_id, content_sha256,"
            " decision, approved_by) values ('x_test', '999', %s,"
            " 'approved', 'Ai Do') returning id", ("e" * 64,)).fetchone()[0]
        assert ba.check_approvals(db) == [{
            "code": "duyet_ngoai_function", "table": "approvals", "id": aid,
            "object_type": "x_test"}]
    with tamper(db):                                           # (d)
        db.execute("update approval_queue set decided_by = created_by where"
                   " id = %s", (q1,))
        assert ba.check_approvals(db) == [{
            "code": "tu_duyet", "table": "approval_queue", "id": q1,
            "block": "ceo"}]
    with tamper(db):                                           # (e)
        db.execute("delete from decisions where queue_id = %s", (q2,))
        fs = ba.check_approvals(db)
        assert [(f["code"], f["id"]) for f in fs] == [
            ("qa_fail_khong_override", q2)]


def test_queue_resubmit_same_object_not_flagged(db):
    """Nộp lại CÙNG object sau khi đã quyết (bị từ chối / duyệt bản khác) là
    luồng thường — mục cũ đã duyệt đúng KHÔNG bị báo lệch; sửa payload mục
    cũ thì báo đúng 1."""
    q1 = _enq(db, "BP-R")
    _decide(db, q1, "Hoa Gia Lap")
    assert ba.check_approvals(db) == []
    q2 = _enq(db, "BP-R", payload="payload BP-R v2")
    _decide(db, q2, "Hoa Gia Lap", "rejected")
    assert ba.check_approvals(db) == []
    q3 = _enq(db, "BP-R", payload="payload BP-R v3")
    _decide(db, q3, "Lan Gia Lap")
    assert ba.check_approvals(db) == []
    with tamper(db):
        db.execute("update approval_queue set payload = 'payload BP-R v3'"
                   " where id = %s", (q1,))
        assert [(f["code"], f["id"]) for f in ba.check_approvals(db)] == [
            ("noi_dung_lech_ban_duyet", q1)]
    with tamper(db):     # payload + sha mục cũ đổi sang bản v2 BỊ TỪ CHỐI
        db.execute("update approval_queue set payload = 'payload BP-R v2',"
                   " content_sha256 = (select content_sha256 from"
                   " approval_queue where id = %s) where id = %s", (q2, q1))
        assert [(f["code"], f["id"]) for f in ba.check_approvals(db)] == [
            ("noi_dung_lech_ban_duyet", q1)]


def test_forged_log_by_agent_writer_still_outside_function(db):
    """agent_writer có INSERT agent_action_log → tự ghi được log
    'draft_approve' trỏ approval_id của dòng approvals chèn thẳng. Trigger
    ép db_role = session_user ('agent_writer') ≠ approvals.db_role → vẫn
    `duyet_ngoai_function`."""
    _approved_world(db)
    assert ba.check_approvals(db) == []
    with tamper(db):
        aid = db.execute(
            "insert into approvals (object_type, object_id, content_sha256,"
            " decision, approved_by) values ('content_draft', '999', %s,"
            " 'approved', 'Ai Do') returning id", ("e" * 64,)).fetchone()[0]
        db.execute("set local session_replication_role = origin")
        db.execute("set local session authorization agent_writer")
        db.execute("insert into agent_action_log (actor, action, object_type,"
                   " object_id, detail) values ('Ai Do', 'draft_approve',"
                   " 'content_draft', '999', %s)",
                   (Jsonb({"approval_id": aid, "content_sha256": "e" * 64}),))
        db.execute("reset session authorization")
        assert db.execute(
            "select db_role from agent_action_log order by id desc limit 1"
        ).fetchone() == ("agent_writer",)
        assert ba.check_approvals(db) == [{
            "code": "duyet_ngoai_function", "table": "approvals", "id": aid,
            "object_type": "content_draft"}]


def test_approvals_overrides_unverifiable_not_clean(db):
    """Thiếu quyền đọc approvals/decisions → `khong_kiem_duoc`, không []."""
    _approved_world(db)
    with db.transaction(force_rollback=True):
        db.execute("revoke select on approvals, decisions from bks_reader")
        db.execute("set local role bks_reader")
        fs = ba.check_approvals(db)
        assert [(f["code"], f["table"]) for f in fs] == [
            ("khong_kiem_duoc", "approval_queue"),
            ("khong_kiem_duoc", "approvals"),
            ("khong_kiem_duoc", "tu_duyet"),
            ("khong_kiem_duoc", "approval_queue")]
        start, end = _window(db)
        res = ba.check_overrides(db, start, end)
        assert res["overrides"] == []
        assert [(f["code"], f["table"]) for f in res["findings"]] == [
            ("khong_kiem_duoc", "decisions")]


# ------------------------------------------------------ W100.4 override

def test_overrides_listed_and_anomalies(db):
    _approved_world(db)
    q3 = _enq(db, "BP-3", qa="fail")
    _override(db, q3, "Lan Gia Lap")
    _decide(db, q3, "Hoa Gia Lap")
    start, end = _window(db)
    res = ba.check_overrides(db, start, end)
    assert len(res["overrides"]) == 2 and res["findings"] == []
    assert db.execute("select count(*) from decisions where kind ="
                      " 'override_qa'").fetchone()[0] == 2
    # ngoài kỳ → không liệt kê
    assert ba.check_overrides(db, start - timedelta(days=9),
                              start - timedelta(days=8))["overrides"] == []
    q = _enq(db, "BP-4", qa="fail")      # enqueue thật (trigger còn bật)
    with tamper(db):                                 # override_tu_trinh
        did = db.execute(
            "insert into decisions (kind, queue_id, decided_by, reason)"
            " values ('override_qa', %s, %s, 'tu ep trinh ban cua minh')"
            " returning id", (q, CREATOR)).fetchone()[0]
        fs = ba.check_overrides(db, start, end)["findings"]
        assert [(f["code"], f["id"]) for f in fs] == [
            ("override_tu_trinh", did)]
    with db.transaction(force_rollback=True):        # tu_ep_tu_duyet
        q = _enq(db, "BP-5", qa="fail")
        did = _override(db, q, "Binh Gia Lap")
        _decide(db, q, "Binh Gia Lap")
        fs = ba.check_overrides(db, start, end)["findings"]
        assert [(f["code"], f["id"]) for f in fs] == [("tu_ep_tu_duyet", did)]
    with db.transaction(force_rollback=True):        # override_don_dap
        ids = []
        for i in range(4):
            q = _enq(db, f"BP-D{i}", qa="fail")
            ids.append(_override(db, q, "Tuan Gia Lap"))
            _decide(db, q, "Hoa Gia Lap")
        fs = ba.check_overrides(db, start, end)["findings"]
        assert [(f["code"], f["ids"]) for f in fs] == [
            ("override_don_dap", ids)]
    with db.transaction(force_rollback=True):        # can_cu_sai
        q = _enq(db, "BP-6")
        lid = db.execute(
            "insert into decision_log (entry_kind, decided_on, topic,"
            " decision, decided_by, basis_kind, basis_id, recorded_by)"
            " values ('quyet_dinh', current_date, 'chu de', 'quyet', 'TGD"
            " Gia Lap', 'approval_queue', %s, 'Thu Ky Gia Lap') returning id",
            (q,)).fetchone()[0]
        fs = ba.check_overrides(db, start, end)["findings"]
        assert [(f["code"], f["id"]) for f in fs] == [("can_cu_sai", lid)]


def test_privileges_clean_then_excess(db):
    assert ba.check_privileges(db) == []
    with db.transaction(force_rollback=True):
        db.execute("grant update on approvals to agent_writer")
        assert ba.check_privileges(db) == [{
            "code": "quyen_vuot", "role": "agent_writer",
            "table": "approvals", "priv": "UPDATE"}]
    with db.transaction(force_rollback=True):
        db.execute("grant insert on approvals to app_human")
        assert ba.check_privileges(db) == [{
            "code": "quyen_vuot", "role": "app_human", "table": "approvals",
            "priv": "INSERT"}]
    with db.transaction(force_rollback=True):
        db.execute("grant delete on content_drafts to bks_reader")
        db.execute("grant execute on function decide_item(bigint, text,"
                   " text, text) to bks_reader")
        got = {(f["role"], f["table"], f["priv"])
               for f in ba.check_privileges(db)}
        assert got == {("bks_reader", "content_drafts", "DELETE"),
                       ("bks_reader",
                        "function decide_item(bigint,text,text,text)",
                        "EXECUTE")}
    # Function SECDEF ngoài danh sách cũ (sign_qr_lot ghi approvals) — lấy
    # từ catalog nên không lọt.
    with db.transaction(force_rollback=True):
        db.execute("grant execute on function sign_qr_lot(text, text, text,"
                   " text, text) to bks_reader")
        assert ba.check_privileges(db) == [{
            "code": "quyen_vuot", "role": "bks_reader",
            "table": "function sign_qr_lot(text,text,text,text,text)",
            "priv": "EXECUTE"}]


def test_read_funcs_match_schema():
    """Drift-guard: READ_FUNCS là function có thật trong schema.sql."""
    schema = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    for f in ba.READ_FUNCS:
        assert re.search(rf"create or replace function {f}\(", schema), f


# ------------------------------------------------------------ W100.4 CLI

def _cli(db, monkeypatch, *argv, log=None):
    monkeypatch.setattr(ba, "connect", lambda: TxConn(db, log))
    return ba.main(list(argv), now=NOW)


def _is_read(sql: str) -> bool:
    s = sql.strip().lower()
    return s.startswith("select") and not re.search(
        r"\b(insert|update|delete)\b", s.split("from", 1)[0])


def test_cli_report_read_only_sql_log(db, monkeypatch, tmp_path, capsys):
    _approved_world(db)
    log: list[str] = []
    n0 = db.execute("select count(*) from audit_runs").fetchone()[0]
    rc = _cli(db, monkeypatch, "--report", "--month", "2026-09",
              "--out-dir", str(tmp_path), log=log)
    assert rc == 0 and log
    assert all(_is_read(s) for s in log), [s for s in log if not _is_read(s)]
    assert db.execute("select count(*) from audit_runs").fetchone()[0] == n0
    text = (tmp_path / "bks-audit-2026-09.md").read_text(encoding="utf-8")
    assert ba.FIRST_RUN in text and "external-dep" in text
    assert DRAFT_TEXT not in text and "payload BP" not in text
    assert "không ghi sổ" in capsys.readouterr().out


def test_cli_record_one_insert_and_as_bks_reader(db, monkeypatch, tmp_path):
    _approved_world(db)
    _log(db, 2)
    log: list[str] = []
    assert _cli(db, monkeypatch, "--report", "--record", "--month",
                "2026-09", "--out-dir", str(tmp_path), log=log) == 0
    writes = [s for s in log if not _is_read(s)]
    assert len(writes) == 1 and writes[0].lower().startswith(
        "insert into audit_runs")
    row = db.execute("select kind, period_label, findings, report_sha256,"
                     " run_by, params from audit_runs").fetchall()
    assert len(row) == 1 and row[0][:3] == ("inside_out", "2026-09", 0)
    import hashlib
    body = (tmp_path / "bks-audit-2026-09.md").read_bytes()
    assert row[0][3] == hashlib.sha256(body).hexdigest()
    assert row[0][4] == "agent:bks_audit"
    assert set(row[0][5]["heads"]) == {"agent_action_log", "plot_logs"}
    # Toàn bộ --report --record dưới role bks_reader (không cần owner).
    with as_role(db):
        assert _cli(db, monkeypatch, "--report", "--record", "--month",
                    "2026-09", "--out-dir", str(tmp_path)) == 0
        assert db.execute("select count(*) from audit_runs").fetchone()[0] \
            == 2
    text = (tmp_path / "bks-audit-2026-09.md").read_text(encoding="utf-8")
    assert ba.FIRST_RUN not in text


def test_cli_dry_run_prints_no_write(db, monkeypatch, tmp_path, capsys):
    assert _cli(db, monkeypatch, "--report", "--dry-run", "--month",
                "2026-09", "--out-dir", str(tmp_path)) == 0
    assert list(tmp_path.iterdir()) == []
    assert "# Audit inside-out BKS" in capsys.readouterr().out
    assert db.execute("select count(*) from audit_runs").fetchone()[0] == 0


@pytest.mark.parametrize("argv", [
    ["--report", "--dry-run", "--record"], [], ["--report", "--now", "x"],
    ["--report", "--bogus"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(ba, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        ba.main(argv, now=NOW)
    assert e.value.code == 2


@pytest.mark.parametrize("month", ["2026-10", "2026-13", "2026-9"])
def test_cli_open_or_bad_month_exit2(monkeypatch, month):
    monkeypatch.setattr(ba, "connect", lambda: pytest.fail("connect"))
    assert ba.main(["--report", "--month", month], now=NOW) == 2


def test_cli_db_down_exit2(monkeypatch, tmp_path):
    monkeypatch.setattr(ba, "connect", lambda: None)
    assert ba.main(["--report", "--out-dir", str(tmp_path)], now=NOW) == 2
    assert list(tmp_path.iterdir()) == []


def test_cli_dead_host_subprocess(tmp_path):
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "agents.bks_audit", "--report",
                        "--month", "2026-09", "--out-dir", str(tmp_path)],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2 and "không kết nối" in r.stderr


# ------------------------------------------------------ W100.7 chỉ-đọc guard

# Tên bảng: ident thường | "quoted" | placeholder .format {}/{t} | %s/%(t)s
# (nội suy runtime không phải f-string vẫn phải khớp guard).
TBL = r'(?:\w+\.)?(?:\w+|"[^"]+"|\{\w*\}|%(?:\(\w+\))?s)'
# Ghép chuỗi "update " + t + " set": hằng KẾT THÚC ngay sau động từ cần
# tên bảng → tự nó là câu ghi (bảng tới từ biến).
BARE_TAIL_RE = re.compile(r"\b(?:update(?:\s+only)?|truncate(?:\s+table)?)"
                          r"\s+$", re.IGNORECASE)
WRITE_RE = re.compile(
    rf"\b(insert\s+into\b(?:\s+{TBL})?|update\s+(?:only\s+)?{TBL}\s+set|"
    rf"delete\s+from|truncate\s+(?:table\s+)?{TBL}|"
    r"(?:alter|drop|create)\s+(?:or\s+replace\s+)?"
    r"(?:table|role|function|schema|index|trigger|view|sequence|policy)\b|"
    r"grant\s+[\w ,()]+\s+(?:on|to)\b)", re.IGNORECASE)
FORBIDDEN_CALL_RE = re.compile(
    r"\bset_status\b|approval_queue\s+import|\baq\.decide\b|\.decide\(|"
    r"from ingest\.\w+ import [^\n]*\bload\b|"
    r"^\s*import\s+ingest\b|^\s*from\s+ingest\s+import\b|"
    r"\b(?:mc|sc|market_csv|settlement_csv|core_store)\.load\(",
    re.MULTILINE)
PLACEHOLDER = "_X_"


def _sql_strings(src: str) -> list[str]:
    """Hằng chuỗi KHÔNG phải docstring (SQL nằm ở đây; docstring/comment mô
    tả "không UPDATE/TRUNCATE" không tính)."""
    tree = ast.parse(src)
    docs = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef,
                             ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if (isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)):
                docs.add(id(first.value))
    out = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docs):
            out.append(node.value)
        elif isinstance(node, ast.JoinedStr):
            # Phần nội suy → token giữ chỗ (KHÔNG bỏ): f"update {t} set" →
            # "update _X_ set" vẫn khớp guard.
            out.append("".join(v.value if isinstance(v, ast.Constant)
                               else PLACEHOLDER for v in node.values))
    return out


def write_hits(src: str) -> list[str]:
    strs = _sql_strings(src)
    hits = [m.group(0) for s in strs for m in WRITE_RE.finditer(
        " ".join(s.split()))]
    hits += [m.group(0) for s in strs for m in [BARE_TAIL_RE.search(s)] if m]
    return [h for h in hits if " ".join(h.lower().split())
            != "insert into audit_runs"]  # miễn ĐÚNG bảng báo cáo


def test_bks_modules_write_only_audit_runs():
    for mod in MODULES:
        src = (ROOT / mod).read_text(encoding="utf-8")
        assert write_hits(src) == [], mod
        assert not FORBIDDEN_CALL_RE.search(src), mod
        assert mod not in dpia_draft.egress_modules(ROOT)
        assert "llm_gateway" not in src
    # Đúng 1 đường ghi: insert into audit_runs (record_run, bks_audit).
    sql = [" ".join(s.split()).lower() for m in MODULES
           for s in _sql_strings((ROOT / m).read_text(encoding="utf-8"))]
    assert sum("insert into audit_runs" in s for s in sql) == 1


@pytest.mark.parametrize("inject", [
    'X = "update approvals set decision = 1"',
    'X = "delete from agent_action_log"',
    'X = f"truncate {T}"',
    'X = "grant select on approvals to x"',
    'X = "insert into approvals values (1)"',
    "from pipelines.store import set_status",
    "from ingest.market_csv import load",
    'X = f"insert into {t} (a) values (1)"',
    'X = f"update {t} set a = 1"',
    'X = "update public.approvals set a=1"',
    'X = "insert into public.approvals (a) values (1)"',
    'X = "insert into audit_runs_x (a) values (1)"',
    "import ingest.market_csv as m\nm.load(1)",
    "from ingest import market_csv",
    'X = "update {} set a=1".format(t)',
    'X = "update %s set a=1" % t',
    'X = "update " + t + " set a=1"',
    """X = 'update "approvals" set a=1'""",
    'X = "truncate table " + t',
    'X = "insert into {t} values (1)".format(t=t)'])
def test_write_guard_mutation_caught(inject):
    """Mutation: thêm câu ghi giả vào module → guard ĐỎ."""
    src = (ROOT / "agents" / "bks_recon.py").read_text(encoding="utf-8")
    bad = src + "\n" + inject.replace("{T}", "{t} approvals") + "\n"
    assert write_hits(bad) or FORBIDDEN_CALL_RE.search(bad)


def test_override_line_masks_pii_and_markdown():
    """OWASP A03: lý do/tên do người nhập không tạo link/HTML/bảng; SĐT bị
    che."""
    line = ba.override_line({
        "id": 1, "queue_id": 2, "block": "ceo",
        "created_at": datetime(2026, 9, 1, tzinfo=VN_TZ),
        "by": "Mai <b>|</b>", "reason": "gọi 0905123456 [x](http://e.vn)"
                                        " `code` ![a](b)"})
    assert "0905123456" not in line
    for bad in ("](", "<b>", "`", "|"):
        assert bad not in line, bad


# ------------------------------------------------ đợt hợp đồng: chain_watch

def test_chain_alert_clean_tampered_dup_and_svc_job(db):
    """PL01 Ban TGĐ 'báo khi nhật ký bị sửa': sạch → không cảnh báo; sửa 1
    dòng → đúng 1 cảnh báo đỏ (thiếu người nhận → route_error, không im);
    chạy lại cùng phát hiện → dup, không báo lặp; chạy bằng role svc_job
    (login job lịch, không owner) vẫn kiểm + báo được."""
    ids = _log(db, 4)
    _plot_logs(db, 2)
    c = TxConn(db)
    r = ba.chain_alert(c, routing={})
    assert r["findings"] == [] and r["alert_id"] is None
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("update agent_action_log set detail = '{\"x\":1}' where"
                   " id = %s", (ids[1],))
        db.execute("set local session_replication_role = origin")
        r = ba.chain_alert(c, routing={})
        assert [f["code"] for f in r["findings"]] == ["chuoi_bi_sua"]
        assert r["alert_id"] and r["routed"] is False and not r["dup"]
        row = db.execute("select source_agent, route_error, detail from"
                         " red_alerts where id = %s",
                         (r["alert_id"],)).fetchone()
        assert row[0] == ba.CHAIN_AGENT and row[1]
        assert row[2]["by_code"]["chuoi_bi_sua"] == 1
        assert ids[1] in row[2]["ids"]
        r2 = ba.chain_alert(c, routing={})
        assert r2["dup"] and r2["alert_id"] is None
        n = db.execute("select count(*) from red_alerts where source_agent"
                       " = %s", (ba.CHAIN_AGENT,)).fetchone()[0]
        assert n == 1
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("update agent_action_log set detail = '{\"y\":2}' where"
                   " id = %s", (ids[2],))
        db.execute("set local session_replication_role = origin")
        db.execute("set local role svc_job")
        r = ba.chain_alert(c, routing={})
        assert r["alert_id"] and [f["code"] for f in r["findings"]] == [
            "chuoi_bi_sua"]


# r22 A3: fp hex có dãy giống SĐT (84 + ≥8 số) → `raise_alert` che khi lưu.
FP_FOUND = {"code": "chuoi_bi_sua", "table": "agent_action_log", "id": 18,
            "problem": "row_hash lệch"}
FP_HEX = "4d5775af4d885d729cb5638f43f38b85828d0397554326314dc04ffa15f91e43"
FP_MASKED = "4d5775af4d885d729cb5638f43f38b85828d***dc04ffa15f91e43"


def _fixed_finding(monkeypatch):
    monkeypatch.setattr(ba, "latest_heads", lambda conn: None)
    monkeypatch.setattr(ba, "check_chains",
                        lambda conn, prev: ({}, [dict(FP_FOUND)]))


def _n_chain(db):
    return db.execute("select count(*) from red_alerts where source_agent"
                      " = %s", (ba.CHAIN_AGENT,)).fetchone()[0]


def test_chain_alert_dup_when_stored_fp_masked(db, monkeypatch):
    """fp bị che khi lưu vẫn khớp khóa chống lặp: 3 lần chạy cùng phát hiện
    → đúng 1 cảnh báo đỏ (trước vá: mỗi lần chạy 1 cảnh báo mới)."""
    _fixed_finding(monkeypatch)
    c = TxConn(db)
    rs = [ba.chain_alert(c, routing={}) for _ in range(3)]
    stored = db.execute("select detail ->> 'fp' from red_alerts where id ="
                        " %s", (rs[0]["alert_id"],)).fetchone()[0]
    assert stored == FP_MASKED != FP_HEX      # tiền đề: fp bị che khi lưu
    assert [r["dup"] for r in rs] == [False, True, True]
    assert _n_chain(db) == 1


def test_chain_alert_dup_against_old_masked_row(db, monkeypatch):
    """Dòng CŨ (trước vá) đã lưu fp bị che → không mở thêm cảnh báo."""
    _fixed_finding(monkeypatch)
    db.execute("insert into red_alerts (source_agent, title, detail) values"
               " (%s, 'cũ', %s)", (ba.CHAIN_AGENT, Jsonb({"fp": FP_MASKED})))
    r = ba.chain_alert(TxConn(db), routing={})
    assert r["dup"] and r["alert_id"] is None
    assert _n_chain(db) == 1


def test_chain_alert_cli_flags_exclusive():
    with pytest.raises(SystemExit) as e:
        ba.main(["--chain-alert", "--report"])
    assert e.value.code == 2
