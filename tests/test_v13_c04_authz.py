"""v13.5 C04 (F08) — danh tính người duyệt, ủy quyền theo khối, least
privilege dưới LOGIN thật, audit trail.

Probe F08 (findings): `--by` là chuỗi tùy ý — người KHÔNG được Bên B ủy
quyền (approvers 9 khối đang rỗng) vẫn duyệt được; agent giữ DSN app_human
gọi `decide_item(.., 'agent:x', 'approved')` được; FinOps không chạy được
dưới login agent (thiếu grant `llm_usage`). Mỗi nhóm test dưới FAIL trên code
trước v13.5.

3 tầng:
  A. `auth.authorize` thuần (không DB) — chế độ dev/thực, approvers rỗng,
     chéo khối, tự duyệt, vai trò, gắn `--by` với login Postgres.
  B. DB thật, schema tạm trong transaction (rollback) — `approval_queue.
     decide`/`store.set_status` cưỡng chế + `authz_denied` vào log hash
     chain, function DB chặn agent, nâng cấp schema không mất audit.
  C. DB thật, schema tạm ĐÃ COMMIT + login Postgres TẠM (không superuser,
     không owner) `in role agent_writer|app_human|ben_a_reader` — flow
     chính chạy đúng quyền, CLI chế độ thực. Dọn schema + login cuối module.
Skip khi không có DATABASE_URL (gate yêu cầu 0 skipped)."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import (
    CheckViolation,
    InsufficientPrivilege,
    RaiseException,
)
from psycopg.types.json import Jsonb

from pipelines import approval_queue as aq
from pipelines import auth, llm_gateway, store

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
OK_G = {"ok": True, "violations": [], "matched_claims": []}
PAYLOAD = "Đề xuất rà giá tuần: 3 SKU lệch bảng giá đã duyệt."
DRAFT_TEXT = "Sâm Sâm — bài mẫu. Nội dung có sử dụng AI"
BH, TC = "gd.bh@test.vn", "gd.tc@test.vn"      # người GIẢ của test


# ------------------------------------------------------------ cấu hình giả

@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Bản sao data/directors với approvers GIẢ cho sales/finance (dữ liệu
    test, không đụng cấu hình thật) + users file giả; `.env` không rò."""
    d = tmp_path / "directors"
    shutil.copytree(ROOT / "data" / "directors", d)
    for block, who in (("sales", BH), ("finance", TC)):
        p = d / f"{block}.json"
        c = json.loads(p.read_text(encoding="utf-8"))
        c["approvers"] = [who]
        p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
    users = {BH: {"role": "gd_ban_hang", "db_login": "login_bh"},
             TC: {"role": "tgd", "db_login": "login_tc"},
             "khong.uy.quyen@test.vn": {"role": "gd_ban_hang",
                                         "db_login": "login_x"}}
    uf = tmp_path / "users.json"
    uf.write_text(json.dumps(users), encoding="utf-8")
    monkeypatch.setattr(auth, "DIRECTORS_DIR", d)
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    monkeypatch.setenv("AUTH_USERS_FILE", str(uf))
    return {"dir": d, "users": uf}


@pytest.fixture
def enforce(monkeypatch):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)


# ===================================================== A. authorize thuần

def test_dev_mode_still_blocks_agents_and_self(cfg):
    for who in ("agent:kd_price", "AGENT:x", " system:sla",
                "auto_policy:p1", "", "   ", None):
        for act in ("approve", "reject", "override_qa", "schedule"):
            ok, why = auth.authorize(who, "sales", act)
            assert not ok and why, (who, act)
    ok, why = auth.authorize("Lan", "sales", "approve", created_by=" lan ")
    assert not ok and "người tạo" in why
    assert auth.authorize("Lan", "sales", "approve",
                          created_by="agent:x") == (True, None)
    assert not auth.authorize("Lan", "sales", "xoa")[0]


def test_enforced_empty_approvers_fail_closed(monkeypatch, tmp_path,
                                              enforce):
    """Probe F08: approvers THẬT của cả 9 khối đang rỗng → chế độ thực
    không ai duyệt được (Bên B chưa ủy quyền) — không tự điền."""
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    from pipelines.director import BLOCKS
    for b in BLOCKS:
        ok, why = auth.authorize("Bất Kỳ Ai", b, "approve",
                                 role="tgd", via="ui")
        assert not ok and "CHƯA có người được Bên B ủy quyền" in why, b


def test_enforced_matrix(cfg, enforce):
    a = auth.authorize
    assert a(BH, "sales", "approve", db_login="LOGIN_BH") == (True, None)
    assert a(BH, "sales", "reject", db_login="login_bh") == (True, None)
    assert a(BH, "sales", "approve", role="gd_ban_hang",
             via="ui") == (True, None)
    cases = [
        ((BH, "finance", "approve"), {"db_login": "login_bh"}, "không thuộc"),
        ((TC, "sales", "approve"), {"db_login": "login_tc"}, "không thuộc"),
        (("khong.uy.quyen@test.vn", "sales", "approve"),
         {"db_login": "login_x"}, "không thuộc"),
        ((BH, "sales", "approve"), {"db_login": "login_tc"}, "login Postgres"),
        ((BH, "sales", "approve"), {}, "login Postgres"),
        ((BH, "sales", "approve"), {"role": "mxh", "via": "ui"}, "vai trò"),
        ((BH, "sales", "approve"), {"created_by": BH.upper(),
                                    "db_login": "login_bh"}, "người tạo"),
        ((BH, "khoi_la", "approve"), {"db_login": "login_bh"}, "cấu hình"),
        (("agent:kd", "sales", "approve"), {"db_login": "login_bh"},
         "không phải người"),
    ]
    for args, kw, frag in cases:
        ok, why = a(*args, **kw)
        assert not ok and frag in why, (args, kw, why)


def test_enforced_user_file_role_and_missing(cfg, enforce, monkeypatch):
    # Tên trong approvers nhưng KHÔNG có tài khoản → chặn.
    (cfg["users"]).write_text(json.dumps({}), encoding="utf-8")
    ok, why = auth.authorize(BH, "sales", "approve", db_login="login_bh")
    assert not ok and "chưa có tài khoản" in why
    # Tài khoản có nhưng vai trò không phải người duyệt khối.
    cfg["users"].write_text(json.dumps(
        {BH: {"role": "mxh", "db_login": "login_bh"}}), encoding="utf-8")
    ok, why = auth.authorize(BH, "sales", "approve", db_login="login_bh")
    assert not ok and "vai trò tài khoản" in why


def test_schedule_role_gate(cfg, enforce):
    assert auth.authorize(BH, "marketing", "schedule", role="mxh",
                          via="ui")[0] is False      # BH không có tài khoản mxh
    ok, why = auth.authorize(BH, "marketing", "schedule",
                             role="gd_ban_hang", via="ui")
    assert not ok and "vai trò" in why


@pytest.mark.parametrize("env, want", [
    ({}, False), ({"AUTH_MODE": "dev"}, False), ({"AUTH_MODE": "local"}, True),
    ({"AUTH_MODE": "PROXY"}, True), ({"APPROVAL_ENFORCE": "1"}, True),
    ({"APPROVAL_ENFORCE": "0"}, False), ({"DEPLOY": "yes"}, True),
    ({"AUTH_MODE": "dev", "DEPLOY": "1"}, True)])
def test_approval_enforced_env(monkeypatch, env, want):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", None)
    assert auth.approval_enforced(env) is want


def test_decidable_blocks(cfg, monkeypatch):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", False)
    assert auth.decidable_blocks("ai", "gd_ban_hang") == ["sales"]
    assert set(auth.decidable_blocks("ai", "tgd")) >= {"ceo", "finance"}
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    assert auth.decidable_blocks("ai", "gd_ban_hang") == []
    assert auth.decidable_blocks(BH, "gd_ban_hang") == ["sales"]
    assert auth.decidable_blocks(TC, "tgd") == ["finance"]


def test_load_users_db_login_only_when_present(tmp_path):
    p = tmp_path / "u.json"
    p.write_text(json.dumps({"A": {"role": "tgd", "db_login": " Login_A "},
                             "b": {"role": "mxh", "db_login": 5}}),
                 encoding="utf-8")
    assert auth.load_users(p) == {
        "a": {"role": "tgd", "password_hash": "", "db_login": "login_a"},
        "b": {"role": "mxh", "password_hash": ""}}


def test_ui_and_cli_route_through_authorize():
    """UI duyệt dùng danh tính phiên (via='ui', role) cho cả draft lẫn hàng
    duyệt chung; không còn ô gõ tên tự do cho người quyết."""
    src = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    assert src.count('via="ui", role=_role') >= 3
    assert "_aq.decide(" in src and "decidable_blocks(_ident, _role)" in src
    assert 'value=_ident, disabled=True' in src
    for t in ("Duyệt & Lịch",):
        for r in ("gd_ban_hang", "ha_tang"):
            assert t in auth.tabs_for(r)


# ================================================ B. DB, schema tạm (rollback)

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
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_c04_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield _TxConn(conn)
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit() của module = no-op (giữ trong tx fixture để rollback)."""

    def __init__(self, c):
        self._c = c

    def execute(self, *a, **k):
        return self._c.execute(*a, **k)

    def transaction(self):
        return self._c.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass


@contextmanager
def _as(conn, role):
    with conn.transaction():
        conn.execute(f"set local role {role}")
        yield
        conn.execute("reset role")


def _item(conn, block="sales", otype="price_review", by="agent:kd_price",
          qa="none"):
    with _as(conn, "agent_writer"):
        return aq.enqueue(conn, object_type=otype, object_id=uuid.uuid4().hex,
                          block=block, title="t", payload=PAYLOAD, risk="low",
                          created_by=by, sla_hours=24, qa_status=qa)


def _status(conn, qid):
    return conn.execute("select status from approval_queue where id = %s",
                        (qid,)).fetchone()[0]


def _chain_ok(conn):
    return conn.execute("select count(*) from verify_action_log()"
                        ).fetchone()[0] == 0


def test_decide_enforced_empty_approvers_blocks_and_logs(db, enforce,
                                                         tmp_path,
                                                         monkeypatch):
    """Probe F08: chế độ thực + approvers thật rỗng → --by tùy ý KHÔNG
    duyệt được; lần bị chặn vào log hash chain (lưu toàn kỳ)."""
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    qid = _item(db)
    ok, msg = aq.decide(db, qid, "Bất Kỳ Ai", "approved")
    assert not ok and "Bên B ủy quyền" in msg
    assert _status(db, qid) == "pending"
    ok, msg = aq.override(db, qid, "Bất Kỳ Ai", "lý do đủ dài để override")
    assert not ok and "Bên B ủy quyền" in msg
    rows = db.execute("select actor, object_type, object_id, detail"
                      " from agent_action_log where action = 'authz_denied'"
                      " order by id").fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [
        ("Bất Kỳ Ai", "approval_queue", str(qid))] * 2
    assert rows[0][3]["block"] == "sales" and rows[1][3]["action"] == \
        "override_qa"
    assert _chain_ok(db)


def test_decide_enforced_cross_block_self_role(db, cfg, enforce):
    sales, fin = _item(db), _item(db, "finance", "budget_change",
                                  "agent:fp_pnl")
    mine = _item(db, by=BH)
    # chéo khối: người duyệt sales quyết mục finance
    ok, msg = aq.decide(db, fin, BH, "approved", via="ui", role="gd_ban_hang")
    assert not ok and "vai trò" in msg
    ok, msg = aq.decide(db, fin, BH, "rejected", via="ui", role="tgd")
    assert not ok and "không thuộc" in msg
    # tự duyệt mục chính mình tạo
    ok, msg = aq.decide(db, mine, BH, "approved", via="ui", role="gd_ban_hang")
    assert not ok and "người tạo" in msg
    # CLI: --by đúng người nhưng login DB không phải của họ
    ok, msg = aq.decide(db, sales, BH, "approved")
    assert not ok and "login Postgres" in msg
    assert {_status(db, q) for q in (sales, fin, mine)} == {"pending"}
    # đúng người, đúng khối, đúng vai trò (UI phiên đăng nhập) → duyệt
    ok, msg = aq.decide(db, sales, BH, "approved", via="ui",
                        role="gd_ban_hang")
    assert ok, msg
    assert _status(db, sales) == "approved"
    log = db.execute(
        "select l.actor, l.detail->>'content_sha256', q.content_sha256"
        " from agent_action_log l join approval_queue q"
        " on q.id = (l.detail->>'queue_id')::bigint"
        " where l.action = 'queue_approve'").fetchall()
    assert log == [(BH, log[0][2], log[0][2])] and log[0][2] != "0" * 64
    assert _chain_ok(db)


def test_store_enforced_blocks_unauthorized(db, cfg, enforce):
    with _as(db, "agent_writer"):
        did = db.execute(
            "insert into content_drafts (brief, channel, text, guardrail,"
            " source, created_by) values ('b', 'facebook', %s, %s, 'cli',"
            " 'agent:mkt02') returning id",
            (DRAFT_TEXT, Jsonb(OK_G))).fetchone()[0]
    # marketing chưa có approvers (bản sao thật) → chặn mọi người
    for st in ("approved", "rejected"):
        ok, msg = store.set_status(db, did, st, "Mai", via="ui",
                                   role="gd_marketing")
        assert not ok and "Bên B ủy quyền" in msg, msg
    assert db.execute("select status from content_drafts where id = %s",
                      (did,)).fetchone()[0] == "pending"


def test_db_functions_refuse_agent_decider(db):
    """Gọi thẳng function bằng role app_human (bỏ qua Python) với tên agent
    → DB từ chối duyệt/override (trước v13.5: duyệt được)."""
    qid = _item(db, by="Hoa")
    qfail = _item(db, by="Hoa", qa="fail")
    for sql, args in (
            ("select decide_item(%s, %s, 'approved', null)",
             (qid, "agent:kd_price2")),
            ("select decide_item(%s, %s, 'approved', null)",
             (qid, "System: sla")),
            ("select override_qa(%s, %s, 'lý do đủ mười ký tự')",
             (qfail, "agent:x"))):
        with pytest.raises(RaiseException) as e, _as(db, "app_human"):
            db.execute(sql, args)
        assert "không phải người" in str(e.value)
    with _as(db, "agent_writer"):
        did = db.execute(
            "insert into content_drafts (brief, channel, text, guardrail,"
            " source, created_by) values ('b', 'facebook', %s, %s, 'cli',"
            " 'Lan') returning id", (DRAFT_TEXT, Jsonb(OK_G))).fetchone()[0]
    with pytest.raises(RaiseException) as e, _as(db, "app_human"):
        db.execute("select approve_draft(%s, 'agent:mkt02', null)", (did,))
    assert "không phải người" in str(e.value)
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('S1', 'x', 'food', 'manual')")
    cid = db.execute("insert into cogs_versions (sku_key, cost_vnd,"
                     " valid_from, created_by) values ('S1', 1000,"
                     " current_date, 'Lan') returning id").fetchone()[0]
    with pytest.raises(RaiseException) as e, _as(db, "app_human"):
        db.execute("select approve_cogs(%s, 'agent:fp', null)", (cid,))
    assert "không phải người" in str(e.value)
    # agent tự rút (reject) mục của chính mình vẫn được — không phải duyệt
    with _as(db, "app_human"):
        db.execute("select decide_item(%s, 'agent:kd_price', 'rejected',"
                   " null)", (_item(db),))
    assert _chain_ok(db)


def test_llm_usage_rejects_negative_cost(db):
    with pytest.raises(CheckViolation), _as(db, "agent_writer"):
        db.execute("insert into llm_usage (agent_id, model, cost_usd, ok)"
                   " values ('kd_a1', 'm', -5, true)")


def test_reapply_schema_roles_keeps_audit(db):
    """Nâng cấp (schema + roles chạy lại với function mới) không xóa/sửa
    audit cũ — kể cả bản duyệt LỊCH SỬ do 'agent:' (ghi trước v13.5)."""
    qid = _item(db, by="Hoa")
    with _as(db, "app_human"):
        db.execute("select decide_item(%s, 'Lan', 'approved', 'ok')", (qid,))
    db.execute("insert into approvals (object_type, object_id,"
               " content_sha256, decision, approved_by) values"
               " ('legacy', '1', %s, 'approved', 'agent:legacy')",
               ("a" * 64,))
    before = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("agent_action_log", "approvals", "decisions",
                        "approval_queue")}
    db.execute(SCHEMA_SQL)
    db.execute(ROLES_SQL)
    after = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
             for t in before}
    assert after == before and before["approvals"] == 2
    assert _chain_ok(db)


# ======================================== C. login Postgres thật (committed)

def _dsn():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    return dsn


def _login_dsn(base, user, pw, schema):
    d = conninfo.conninfo_to_dict(base)
    d.update(user=user, password=pw, options=f"-c search_path={schema}")
    return conninfo.make_conninfo(**d)


@pytest.fixture(scope="module")
def live():
    base = _dsn()
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_c04l_{tag}"
    logins = {r: (f"t_c04_{r}_{tag}", secrets.token_urlsafe(18))
              for r in ("agent_writer", "app_human", "ben_a_reader")}
    try:
        admin.execute("set lock_timeout = '60s'")
        admin.execute(f"create schema {schema}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}, pg_temp")
            admin.execute(SCHEMA_SQL)
            admin.execute(ROLES_SQL)
        for grp, (name, pw) in logins.items():
            admin.execute(f"create role {name} login password '{pw}'"
                          f" nosuperuser nocreatedb nocreaterole"
                          f" in role {grp}")
        yield {"admin": admin, "schema": schema, "base": base,
               "dsn": {g: _login_dsn(base, n, p, schema)
                       for g, (n, p) in logins.items()},
               "name": {g: n for g, (n, _) in logins.items()}}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for name, _ in logins.values():
            admin.execute(f"drop role if exists {name}")
        admin.close()


def _login(live, grp):
    return psycopg.connect(live["dsn"][grp], connect_timeout=5)


def _admin_q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        return a.execute(sql, args).fetchall()


def _deny(conn, sql, args=()):
    with pytest.raises(InsufficientPrivilege), conn.transaction():
        conn.execute(sql, args)


def test_logins_are_not_owner_or_superuser(live):
    for grp in live["dsn"]:
        with _login(live, grp) as c:
            sup, = c.execute("select rolsuper from pg_roles"
                             " where rolname = session_user").fetchone()
            owners = c.execute(
                "select distinct tableowner from pg_tables"
                " where schemaname = current_schema()").fetchall()
            assert sup is False
            assert (live["name"][grp],) not in owners


def test_agent_login_flows_and_limits(live, monkeypatch):
    with _login(live, "agent_writer") as c:
        qid = aq.enqueue(c, object_type="price_review", object_id="L1",
                         block="sales", title="t", payload=PAYLOAD,
                         risk="low", created_by="agent:kd_price",
                         sla_hours=24)
        _deny(c, "select decide_item(%s, 'Lan', 'approved', null)", (qid,))
        _deny(c, "select override_qa(%s, 'Lan', 'lý do đủ mười ký tự')",
              (qid,))
        _deny(c, "select approve_draft(1, 'Lan', null)")
        _deny(c, "update agent_action_log set actor = 'x'")
        _deny(c, "delete from agent_action_log")
        _deny(c, "insert into approvals (object_type, object_id,"
                 " content_sha256, decision, approved_by) values"
                 " ('content_draft', '1', %s, 'approved', 'x')", ("a" * 64,))
        _deny(c, "update approval_queue set status = 'approved'")
        _deny(c, "select payload from approval_queue")
        _deny(c, "select * from contacts")
        _deny(c, "update llm_usage set cost_usd = 0")
    # FinOps (trần chi phí) chạy được dưới login agent: đọc chi tiêu + ghi.
    monkeypatch.setattr(llm_gateway, "_connect", lambda: _login(live,
                                                               "agent_writer"))
    assert llm_gateway._month_spend("kd_a1") == 0.0
    llm_gateway._record("kd_a1", "m", 3, 4, 0.002, True)
    assert llm_gateway._month_spend("kd_a1") == pytest.approx(0.002)
    rows = _admin_q(live, "select agent_id, ok from llm_usage")
    assert rows == [("kd_a1", True)]
    assert _admin_q(live, "select status from approval_queue where id = %s",
                    (qid,)) == [("pending",)]


def test_human_login_decides_only_when_authorized(live, cfg, enforce):
    human = live["name"]["app_human"]
    cfg["users"].write_text(json.dumps({
        BH: {"role": "gd_ban_hang", "db_login": human},
        TC: {"role": "tgd", "db_login": "login_khac"}}), encoding="utf-8")
    with _login(live, "agent_writer") as c:
        sales = aq.enqueue(c, object_type="price_review", object_id="H1",
                           block="sales", title="t", payload=PAYLOAD,
                           risk="low", created_by="agent:kd_price",
                           sla_hours=24)
        fin = aq.enqueue(c, object_type="budget_change", object_id="H2",
                         block="finance", title="t", payload=PAYLOAD,
                         risk="low", created_by="agent:fp_pnl",
                         sla_hours=24)
    with _login(live, "app_human") as h:
        ok, msg = aq.decide(h, fin, TC, "approved")      # login không khớp
        assert not ok and "login Postgres" in msg
        ok, msg = aq.decide(h, fin, BH, "approved")      # chéo khối
        assert not ok and "không thuộc" in msg
        ok, msg = aq.decide(h, sales, BH, "approved", "duyệt thật")
        assert ok, msg
        _deny(h, "update approval_queue set status = 'approved'")
        _deny(h, "delete from approvals")
        _deny(h, "update agent_action_log set actor = 'x'")
        with pytest.raises(RaiseException), h.transaction():
            h.execute("select decide_item(%s, 'agent:kd', 'approved', null)",
                      (fin,))
    got = _admin_q(live, "select approved_by, db_role from approvals")
    assert got == [(BH, human)]
    log = _admin_q(live, "select actor, action, db_role from agent_action_log"
                   " where action in ('queue_approve', 'authz_denied')"
                   " order by id")
    assert log == [(TC, "authz_denied", human), (BH, "authz_denied", human),
                   (BH, "queue_approve", human)]
    assert _admin_q(live, "select count(*) from verify_action_log()") == [(0,)]


def test_ben_a_login_reads_numbers_only(live):
    with _login(live, "ben_a_reader") as c:
        for v in ("v_ben_a_settlement_daily", "v_ben_a_orders_daily",
                  "revenue_quarters"):
            c.execute(f"select * from {v} limit 1").fetchall()
        for t in ("contacts", "orders", "settlement_rows", "leads",
                  "agent_action_log", "approval_queue", "v_settlement_khoan"):
            _deny(c, f"select * from {t} limit 1")
        _deny(c, "insert into revenue_quarters (quarter, period_start,"
                 " period_end) values ('2027-Q1', '2027-01-01', '2027-04-01')")


def test_cli_enforced_arbitrary_by_rejected(live):
    """Probe F08 ở biên CLI thật: `APPROVAL_ENFORCE=1`, approvers thật rỗng,
    login app_human → `--approve --by <tên tùy ý>` exit 1, mục còn pending
    (trước v13.5: exit 0 'approved')."""
    with _login(live, "agent_writer") as c:
        qid = aq.enqueue(c, object_type="price_review", object_id="C1",
                         block="sales", title="t", payload=PAYLOAD,
                         risk="low", created_by="agent:kd_price",
                         sla_hours=24)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", APPROVAL_ENFORCE="1",
               DATABASE_URL=live["dsn"]["app_human"])
    env.pop("AUTH_MODE", None)
    r = subprocess.run([sys.executable, "-m", "pipelines.approval_queue",
                        "--approve", str(qid), "--by", "Bất Kỳ Ai"],
                       cwd=ROOT, env=env, capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 1, (r.stdout, r.stderr)
    assert "Bên B ủy quyền" in r.stderr
    assert _admin_q(live, "select status from approval_queue where id = %s",
                    (qid,)) == [("pending",)]
