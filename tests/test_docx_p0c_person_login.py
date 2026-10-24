"""Đợt DOCX P0c — tên người trong quyết định/nhật ký phải là người của LOGIN.

Lỗi trước sửa (nền 667f763, runbook 9.7 "rủi ro còn lại"): function quyết
định có trước v15 (`decide_item`, `approve_cogs`, `decide_allocation_run`,
`record_lot_intake`, `sign_qr_lot`...) nhận tên người làm tham số; `app_human`
INSERT thẳng cột tên ở `red_alert_acks`, `ops_incidents`,
`ops_incident_events`, `san_suggestion_uses`, `cogs_versions` và kế thừa
INSERT `agent_action_log` → login của người A gọi thẳng psql ghi quyết định/
nhật ký mang tên người B, hoặc duyệt mục khối không được ủy quyền (HĐ 6.7,
7.2).

Sau sửa: trigger `person_login_guard` — login NGƯỜI (app_human, không
svc_ui/owner) ghi tên người → bắt buộc `human_actor` (đúng người của login
trong `human_logins`, đúng khối với quyết định hàng duyệt/phân bổ/kiểm nhập/
giá vốn); sai → 42501, function rollback (không ghi dở). Login UI `svc_ui`
từ đợt an toàn S04 cũng bị kiểm (không còn được tin tên); dòng `agent:` của luồng agent
và dòng `authz_denied` không bị chặn. Đúng người hoàn tất việc qua CLI thật.

Probe: schema tạm ĐÃ COMMIT, login Postgres THẬT tạm (không owner/superuser),
CLI subprocess chế độ thực. Người/khối là dữ liệu GIẢ. Skip khi không có
DATABASE_URL."""

import json
import os
import secrets
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")

P_SALES = "Bán Hàng Giả P0c"
P_PROD = "Sản Xuất Giả P0c"
P_FIN = "Tài Chính Giả P0c"

LAUNCHER = '''import runpy, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from pipelines import auth
auth.DIRECTORS_DIR = Path(sys.argv[2])
mod = sys.argv[3]
sys.argv = [mod] + sys.argv[4:]
runpy.run_module(mod, run_name="__main__", alter_sys=True)
'''


def _login_dsn(base, user, pw, schema):
    d = conninfo.conninfo_to_dict(base)
    d.update(user=user, password=pw, options=f"-c search_path={schema}")
    return conninfo.make_conninfo(**d)


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_docxp0c_{tag}"
    kinds = {"sales": "app_human", "prod": "app_human", "fin": "app_human",
             "unmapped": "app_human", "agent": "agent_writer"}
    logins = {k: (f"t_p0c_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    ui = (f"t_p0c_ui_{tag}", secrets.token_urlsafe(18))
    tmp = tmp_path_factory.mktemp("docxp0c")
    try:
        admin.execute("set lock_timeout = '60s'")
        admin.execute(f"create schema {schema}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}, pg_temp")
            admin.execute(SCHEMA_SQL)
            admin.execute(ROLES_SQL)
        for k, (name, pw) in logins.items():
            admin.execute(f"create role {name} login password '{pw}'"
                          f" nosuperuser nocreatedb nocreaterole"
                          f" in role {kinds[k]}")
        # login UI: role svc_ui có từ bản vá; nền cũ → app_human (UI dùng
        # login app_human chung như trước)
        has_ui = admin.execute("select exists (select 1 from pg_roles where"
                               " rolname = 'svc_ui')").fetchone()[0]
        admin.execute(f"create role {ui[0]} login password '{ui[1]}'"
                      f" nosuperuser in role "
                      f"{'svc_ui' if has_ui else 'app_human'}")
        name = {k: n for k, (n, _) in logins.items()}
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}")
            for k, person, blocks in (("sales", P_SALES, ["sales"]),
                                      ("prod", P_PROD, ["production"]),
                                      ("fin", P_FIN, ["finance"])):
                admin.execute("insert into human_logins (db_login, person,"
                              " blocks, granted_by) values (%s, %s, %s,"
                              " 'test-docx-p0c')", (name[k], person, blocks))
            admin.execute("insert into sku_master (sku_key, name, category,"
                          " source) values ('p0c-sku', 'SKU giả', 'food',"
                          " 'manual')")
        d = tmp / "directors"
        shutil.copytree(ROOT / "data" / "directors", d)
        for blk, who in (("sales", P_SALES), ("production", P_PROD),
                         ("finance", P_FIN)):
            p = d / f"{blk}.json"
            c = json.loads(p.read_text(encoding="utf-8"))
            c["approvers"] = [who]
            p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        users = tmp / "users.json"
        users.write_text(json.dumps({
            P_SALES.casefold(): {"role": "gd_ban_hang",
                                 "db_login": name["sales"]},
            P_PROD.casefold(): {"role": "tgd",
                                "db_login": name["prod"]},
            P_FIN.casefold(): {"role": "tgd",
                               "db_login": name["fin"]},
        }, ensure_ascii=False), encoding="utf-8")
        launcher = tmp / "launch_p0c.py"
        launcher.write_text(LAUNCHER, encoding="utf-8")
        dsn = {k: _login_dsn(base, n, p, schema)
               for k, (n, p) in logins.items()}
        dsn["ui"] = _login_dsn(base, ui[0], ui[1], schema)
        yield {"admin": admin, "schema": schema, "dsn": dsn, "dirs": d,
               "users": users, "launcher": launcher,
               "login": {**name, "ui": ui[0]}}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for n, _ in [*logins.values(), ui]:
            admin.execute(f"drop role if exists {n}")
        admin.close()


def _q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        cur = a.execute(sql, args or None)
        return cur.fetchall() if cur.description else []


def _as(live, who, sql, args=()):
    with psycopg.connect(live["dsn"][who], connect_timeout=5) as c:
        cur = c.execute(sql, args or None)
        return cur.fetchall() if cur.description else []


def _denied(live, who, sql, args=()):
    with pytest.raises(psycopg.Error) as ei:
        _as(live, who, sql, args)
    return str(ei.value)


_n = iter(range(10_000))


def _item(live, block="production", otype="alloc_review"):
    i = next(_n)
    return _q(live, "insert into approval_queue (object_type, object_id,"
              " block, title, payload, content_sha256, risk, guardrail,"
              " created_by, due_at) values (%s, %s, %s, 'mục p0c', 'p', %s,"
              " 'low', '{\"ok\": true}', 'agent:p0c', now() + interval"
              " '1 day') returning id",
              (otype, f"p0c-{i}", block, "a" * 64))[0][0]


def _status(live, qid):
    return _q(live, "select status, decided_by from approval_queue where id"
              " = %s", (qid,))[0]


def test_p0c_queue_decision_bound_to_login_and_block(live):
    qid = _item(live)
    n0 = _q(live, "select count(*) from approvals")[0][0]
    m = _denied(live, "sales", "select decide_item(%s, %s, 'approved')",
                (qid, P_PROD))                        # mạo tên người khác
    assert "không phải người của login" in m, m
    m = _denied(live, "sales", "select decide_item(%s, %s, 'approved')",
                (qid, P_SALES))                       # tên mình, sai khối
    assert "khối production" in m, m
    m = _denied(live, "unmapped", "select decide_item(%s, %s, 'approved')",
                (qid, P_PROD))                        # login chưa ánh xạ
    assert "chưa được ánh xạ" in m, m
    assert _status(live, qid) == ("pending", None)
    assert _q(live, "select count(*) from approvals")[0][0] == n0
    _as(live, "prod", "select decide_item(%s, %s, 'approved')",
        (qid, P_PROD))                                # đúng người, đúng khối
    assert _status(live, qid) == ("approved", P_PROD)


def test_p0c_cli_right_person_completes_wrong_person_blocked(live):
    qid = _item(live)
    e = {k: v for k, v in os.environ.items()
         if not k.endswith("DATABASE_URL") and k not in (
             "AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE", "APPROVAL_ENFORCE")}

    def cli(who, *args):
        env = {**e, "DATABASE_URL": live["dsn"][who], "APPROVAL_ENFORCE": "1",
               "AUTH_USERS_FILE": str(live["users"]),
               "PYTHONIOENCODING": "utf-8", "OPENROUTER_API_KEY": ""}
        p = subprocess.run(
            [sys.executable, str(live["launcher"]), str(ROOT),
             str(live["dirs"]), "pipelines.approval_queue", *args], cwd=ROOT,
            env=env, capture_output=True, timeout=180, encoding="utf-8",
            errors="replace", check=False)
        return p.returncode, p.stdout + p.stderr
    rc, out = cli("sales", "--approve", str(qid), "--by", P_PROD)
    assert rc != 0, out
    assert _status(live, qid) == ("pending", None)
    rc, out = cli("prod", "--approve", str(qid), "--by", P_PROD)
    assert rc == 0, out
    assert _status(live, qid) == ("approved", P_PROD)


def test_p0c_ui_shared_login_cannot_write_person_names(live):
    # Đợt an toàn S04 (lật test cũ `..._keeps_session_trust...`): trước đây
    # login UI dùng chung (svc_ui) được DB tin tên người tự truyền → giả danh
    # bất kỳ ai. Nay svc_ui không ánh xạ người → 42501, mục giữ pending; UI
    # chế độ thực quyết định bằng login riêng của người (auth.person_connect).
    qid = _item(live, block="sales", otype="price_review")
    _denied(live, "ui", "select decide_item(%s, %s, 'approved')",
            (qid, "Người Dùng UI Giả"))
    _denied(live, "ui", "select decide_item(%s, %s, 'approved')",
            (qid, P_SALES))
    assert _status(live, qid) == ("pending", None)
    _denied(live, "ui", "select decide_item(%s, 'agent:x', 'approved')",
            (qid,))
    assert _status(live, qid) == ("pending", None)


def test_p0c_cogs_create_and_approve_bound(live):
    m = _denied(live, "sales", "insert into cogs_versions (sku_key, cost_vnd,"
                " valid_from, created_by) values ('p0c-sku', 1000,"
                " current_date, %s)", (P_FIN,))
    assert "không phải người của login" in m, m
    _as(live, "sales", "insert into cogs_versions (sku_key, cost_vnd,"
        " valid_from, created_by) values ('p0c-sku', 1000, current_date, %s)",
        (P_SALES,))
    cid = _q(live, "select id from cogs_versions where created_by = %s",
             (P_SALES,))[0][0]
    m = _denied(live, "sales", "select approve_cogs(%s, %s)", (cid, P_FIN))
    assert "không phải người của login" in m, m
    assert _q(live, "select approved_by from cogs_versions where id = %s",
              (cid,)) == [(None,)]
    _as(live, "fin", "select approve_cogs(%s, %s)", (cid, P_FIN))
    assert _q(live, "select approved_by from cogs_versions where id = %s",
              (cid,)) == [(P_FIN,)]


def test_p0c_direct_name_columns_bound(live):
    rid = _q(live, "insert into red_alerts (source_agent, title, detail) values"
             " ('agent:p0c', 'cảnh báo giả p0c', '{}')"
             " returning id")[0][0]
    m = _denied(live, "sales", "insert into red_alert_acks (alert_id,"
                " acked_by) values (%s, %s)", (rid, P_PROD))
    assert "không phải người của login" in m, m
    m = _denied(live, "sales", "insert into ops_incidents (title, severity,"
                " source, ben_trach_nhiem, detected_at, created_by) values"
                " ('sự cố giả', 'thuong', 'p0c', 'ben_a', now(), %s)",
                (P_PROD,))
    assert "không phải người của login" in m, m
    m = _denied(live, "sales", "insert into agent_action_log (actor, action,"
                " object_type, object_id) values (%s, 'queue_approve',"
                " 'x', 'y')", (P_PROD,))
    assert "không phải người của login" in m, m
    assert _q(live, "select count(*) from red_alert_acks") == [(0,)]
    assert _q(live, "select count(*) from agent_action_log where actor = %s"
              " and object_type = 'x'", (P_PROD,)) == [(0,)]
    # được: tên CHÍNH mình; dòng ghi lần bị từ chối; dòng agent của luồng agent
    _as(live, "sales", "insert into red_alert_acks (alert_id, acked_by)"
        " values (%s, %s)", (rid, P_SALES))
    _as(live, "sales", "insert into agent_action_log (actor, action,"
        " object_type, object_id) values (%s, 'authz_denied', 'x', 'y')",
        (P_PROD,))
    _as(live, "agent", "insert into agent_action_log (actor, action,"
        " object_type, object_id) values ('agent:p0c', 'note', 'x', 'y')")
