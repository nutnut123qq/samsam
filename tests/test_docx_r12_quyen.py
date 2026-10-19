"""Đợt DOCX vòng 2 — R1/R2: hai đường vượt quyền controller tái hiện trên
working tree đợt DOCX (fingerprint 349a3af…).

R1: login NGƯỜI (app_human, chỉ khối sales) gọi thẳng
    `record_lot_intake(lô, 'passed', 'agent:controller', null)` → lô passed,
    `checked_by` mang tên giả — `person_login_guard` bỏ qua kiểm khi tên
    không phải "người" (ngoại lệ cho luồng agent thành đường thoát).
R2: cùng login, gọi `revoke_qr` bằng tên CHÍNH người của login → mã QR bị
    thu hồi — trigger chỉ kiểm danh tính, không kiểm quyền QR.

Sau sửa: action QUYẾT ĐỊNH của người không bao giờ ghi bằng tên agent/hệ
thống (mọi login không owner, chuẩn hóa NFKC); login người luôn qua
`human_actor` + khối; ký/phát hành/thu hồi QR đòi vai QR của CHÍNH login
trong `human_qr_roles` (owner quản lý, mirror `data/qr_signers.json`).
Luồng agent ghi nhật ký nghiệp vụ không phải quyết định vẫn chạy; dòng
`authz_denied` vẫn ghi được nhưng không đổi nghiệp vụ.

Login Postgres THẬT tạm (không owner/superuser) — fixture của
`test_docx_p0c_person_login` (schema tạm, người/khối GIẢ)."""

import uuid

import psycopg
import pytest

from tests.test_docx_p0c_person_login import (  # noqa: F401 — fixture
    P_PROD,
    P_SALES,
    _as,
    _denied,
    _q,
    live,
)

AGENTISH = ["agent:controller", "system:controller", "auto_policy:x",
            " AGENT :x", "Agent:x", "agent：x"]


def _lot(live, status="pending"):  # noqa: F811
    code = "R12-" + uuid.uuid4().hex[:8].upper()
    _q(live, "insert into production_lots (lot_code, sku_key, mfg_date,"
       " exp_date, qty, source) values (%s, 'p0c-sku', current_date,"
       " current_date + 365, 1, 'manual')", (code,))
    if status != "pending":
        _q(live, "update production_lots set intake_status = %s, checked_by"
           " = 'Owner Mồi', checked_at = now() where lot_code = %s",
           (status, code))
    return code


def _state(live, code):  # noqa: F811
    return _q(live, "select intake_status, checked_by from production_lots"
              " where lot_code = %s", (code,))[0]


def _napprovals(live):  # noqa: F811
    return _q(live, "select count(*) from approvals")[0][0]


@pytest.mark.parametrize("actor", AGENTISH)
@pytest.mark.parametrize("who", ["sales", "prod", "ui"])
def test_r1_decision_never_under_agent_name(live, actor, who):  # noqa: F811
    """Kể cả login ĐÚNG khối production và login UI tin cậy: kiểm nhập lô
    bằng tên agent/hệ thống bị DB chặn, 0 thay đổi."""
    code, n0 = _lot(live), _napprovals(live)
    _denied(live, who, "select record_lot_intake(%s, 'passed', %s, null)",
            (code, actor))
    assert _state(live, code) == ("pending", None)
    assert _napprovals(live) == n0


@pytest.mark.parametrize("actor", AGENTISH[:2])
def test_r1_allocation_decision_never_under_agent_name(live, actor):  # noqa: F811
    run = "R12RUN" + uuid.uuid4().hex[:6]
    _q(live, "insert into allocation_proposals (run_id, cutoff_id,"
       " cutoff_date, start_week, sku_key, channel, demand_low, demand_base,"
       " demand_high, proposed_qty) values (%s, 'c1', current_date,"
       " current_date, 'p0c-sku', 'shopee', 1, 2, 3, 2)", (run,))
    for who in ("sales", "prod"):
        _denied(live, who, "select * from decide_allocation_run(%s,"
                " 'approved', %s, null)", (run, actor))
    assert _q(live, "select status, decided_by from allocation_proposals"
              " where run_id = %s", (run,)) == [("pending", None)]


def test_r1_right_person_right_block_still_completes(live):  # noqa: F811
    code = _lot(live)
    _as(live, "prod", "select record_lot_intake(%s, 'passed', %s, null)",
        (code, P_PROD))
    assert _state(live, code) == ("passed", P_PROD)
    code = _lot(live)
    _denied(live, "sales", "select record_lot_intake(%s, 'passed', %s,"
            " null)", (code, P_SALES))                 # sai khối
    assert _state(live, code) == ("pending", None)


def test_r1_agent_flow_logs_and_denied_attempts_still_recorded(live):  # noqa: F811
    # luồng agent (không phải quyết định) vẫn ghi nhật ký
    _as(live, "agent", "insert into agent_action_log (actor, action,"
        " object_type, object_id) values ('agent:r12', 'note', 'x', 'r12')")
    _as(live, "sales", "insert into agent_action_log (actor, action,"
        " object_type, object_id) values ('agent:r12', 'queue_enqueue',"
        " 'x', 'r12b')")
    # dòng ghi lần BỊ từ chối: vẫn ghi được (bằng chứng), không đổi nghiệp vụ
    code = _lot(live)
    _as(live, "sales", "insert into agent_action_log (actor, action,"
        " object_type, object_id) values ('agent:controller', 'authz_denied',"
        " 'lot_intake', %s)", (code,))
    assert _state(live, code) == ("pending", None)
    # nhật ký QUYẾT ĐỊNH mạo tên agent ghi thẳng → chặn
    for who in ("sales", "ui", "agent"):
        _denied(live, who, "insert into agent_action_log (actor, action,"
                " object_type, object_id) values ('agent:x', 'lot_intake',"
                " 'lot_intake', %s)", (code,))


# ------------------------------------------------------------------ R2

def _qr(live, lot):  # noqa: F811
    code = "r12_" + uuid.uuid4().hex
    _q(live, "insert into qr_codes (code, lot_code, snapshot_sha256,"
       " text_sha256, issued_by) values (%s, %s, %s, %s, 'Owner Mồi')",
       (code, lot, "a" * 64, "b" * 64))
    return code


def _revoked(live, code):  # noqa: F811
    return _q(live, "select revoked_at is not null, revoked_by from qr_codes"
              " where code = %s", (code,))[0]


def _grant(live, who, role):  # noqa: F811
    _q(live, "insert into human_qr_roles (db_login, role, granted_by) values"
       " (%s, %s, 'test-r12')", (live["login"][who], role))


def test_r2_own_name_without_qr_role_cannot_revoke(live):  # noqa: F811
    code = _qr(live, _lot(live, "passed"))
    m = _denied(live, "sales", "select revoke_qr(%s, %s, 'thử r12')",
                (code, P_SALES))
    assert "QR" in m, m
    assert _revoked(live, code) == (False, None)
    # agent name / ui login cũng không thu hồi được
    _denied(live, "ui", "select revoke_qr(%s, 'agent:x', 'thử')", (code,))
    assert _revoked(live, code) == (False, None)


@pytest.mark.parametrize("action,detail", [
    ("qr_lot_sign", '{"role": "gd_san_xuat"}'), ("qr_issue", "{}"),
    ("qr_revoke", "{}")])
def test_r2_qr_decision_log_requires_qr_role(live, action, detail):  # noqa: F811
    """Cùng cơ chế cho ký/phát hành/thu hồi: nhật ký quyết định QR của login
    không có vai QR bị chặn (function ghi log trong cùng tx → rollback)."""
    m = _denied(live, "sales", "insert into agent_action_log (actor, action,"
                " object_type, object_id, detail) values (%s, %s, 'qr', 'x',"
                " %s::jsonb)", (P_SALES, action, detail))
    assert "QR" in m, m


def test_r2_qr_role_grants_exactly_that_role(live):  # noqa: F811
    _grant(live, "prod", "gd_san_xuat")
    code = _qr(live, _lot(live, "passed"))
    _as(live, "prod", "select revoke_qr(%s, %s, 'lô lỗi r12')",
        (code, P_PROD))
    assert _revoked(live, code) == (True, P_PROD)
    _as(live, "prod", "insert into agent_action_log (actor, action,"
        " object_type, object_id, detail) values (%s, 'qr_lot_sign', 'qr',"
        " 'ok', '{\"role\": \"gd_san_xuat\"}')", (P_PROD,))
    m = _denied(live, "prod", "insert into agent_action_log (actor, action,"
                " object_type, object_id, detail) values (%s, 'qr_lot_sign',"
                " 'qr', 'sai', '{\"role\": \"phap_che_qa\"}')", (P_PROD,))
    assert "QR" in m, m
    # vai QR không cho mạo tên người khác
    code = _qr(live, _lot(live, "passed"))
    _denied(live, "prod", "select revoke_qr(%s, %s, 'mạo')", (code, P_SALES))
    assert _revoked(live, code) == (False, None)


def test_r2_qr_roles_owner_only_and_audited(live):  # noqa: F811
    for who in ("sales", "prod", "ui", "agent"):
        with pytest.raises(psycopg.Error):
            _as(live, who, "insert into human_qr_roles (db_login, role,"
                " granted_by) values (%s, 'phap_che_qa', 'tự cấp')",
                (live["login"][who],))
    _grant(live, "fin", "phap_che_qa")
    assert _q(live, "select count(*) from agent_action_log where action ="
              " 'human_qr_role_change' and object_id = %s",
              (live["login"]["fin"],))[0][0] == 1
    with pytest.raises(psycopg.Error):        # 1 người không ở 2 vai
        _grant(live, "fin", "gd_vung_trong")


def _cli(live, who, *args):  # noqa: F811
    import os
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    env = {k: v for k, v in os.environ.items()
           if not k.endswith("DATABASE_URL") and k not in (
               "AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE", "APPROVAL_ENFORCE")}
    env.update(DATABASE_URL=live["dsn"][who], APPROVAL_ENFORCE="1",
               AUTH_USERS_FILE=str(live["users"]), PYTHONIOENCODING="utf-8",
               OPENROUTER_API_KEY="")
    p = subprocess.run(
        [sys.executable, str(live["launcher"]), str(root), str(live["dirs"]),
         "pipelines.production", *args], cwd=root, env=env,
        capture_output=True, timeout=180, encoding="utf-8", errors="replace",
        check=False)
    return p.returncode, p.stdout + p.stderr


def test_r1_cli_intake_right_person_completes_others_blocked(live):  # noqa: F811
    code = _lot(live)
    rc, out = _cli(live, "sales", "intake", "--lot", code, "--result",
                   "passed", "--by", "agent:controller")
    assert rc != 0 and _state(live, code) == ("pending", None), out
    rc, out = _cli(live, "sales", "intake", "--lot", code, "--result",
                   "passed", "--by", P_SALES)
    assert rc != 0 and _state(live, code) == ("pending", None), out
    rc, out = _cli(live, "prod", "intake", "--lot", code, "--result",
                   "passed", "--by", P_PROD)
    assert rc == 0 and _state(live, code) == ("passed", P_PROD), out
