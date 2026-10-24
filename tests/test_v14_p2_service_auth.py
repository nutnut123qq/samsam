"""v14.2 (p2, F08 phần code) — quyền dịch vụ + quyết định người ở CLI.

Hở tái hiện (đọc code thật trên `v14-hop-dong`, mỗi nhóm FAIL trên code cũ):
  1. CLI quyết định người ngoài hàng duyệt chung (production approve/reject/
     intake, golden --approve-price, qr_trace sign/issue/revoke, xnqc --set,
     rollout --promote/--severe/--disable, red_alert --ack, crm consent/
     assign/handoff/load-dealers, doc_intake --verify/--reject, fp_pnl
     --cogs-approve, garden_director --purge-sample/--adopt-plot) nhận `--by`
     TỰ KHAI ở chế độ thực — không đối chiếu người được Bên B ủy quyền, không
     gắn login Postgres, không ghi `authz_denied`.
  2. `auth.deny_log` gọi `conn.commit()` — chốt luôn việc DỞ của caller.
  3. Dịch vụ (webhook, job lịch, loader, backup) chỉ có DSN owner: không có
     role/login riêng, không chọn DSN theo dịch vụ, chế độ thực không từ chối
     login superuser/owner.
  4. `settlement_rows` / `orders` thật xóa/sửa được (HĐ 7.3 iii) — mất giá trị
     cũ, không lịch sử.
  5. `bks_audit.WATCH_ROLES` không theo dõi `ben_a_reader` (+ login dịch vụ).

Tầng: A thuần (không DB); B DB schema tạm rollback; C DB schema tạm ĐÃ COMMIT
+ LOGIN Postgres THẬT tạm (không superuser, không owner) cho từng dịch vụ —
dọn schema + login cuối module. Skip khi không có DATABASE_URL (gate đòi 0
skipped)."""

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import InsufficientPrivilege, RaiseException

from agents import bks_audit, fp_pnl, garden_director, kd_orders, xnqc
from connectors import channels
from ingest import core_store, crm, doc_intake, golden_store
from pipelines import auth, job_runs, production, qr_trace, rollout
from pipelines import red_alert as ra

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
PERSON = "gd.sx@test.vn"           # người GIẢ của test (không phải người thật)
ANY = "Bất Kỳ Ai"
SERVICE_GROUPS = ("svc_webhook", "svc_job", "svc_loader", "svc_backup")
VN_TZ = timezone(timedelta(hours=7))


# ------------------------------------------------------------ cấu hình giả

@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Bản sao data/directors (approvers THẬT rỗng) + users file giả rỗng;
    `.env` không rò. Test tự ghi approvers/users khi cần ca dương."""
    d = tmp_path / "directors"
    shutil.copytree(ROOT / "data" / "directors", d)
    uf = tmp_path / "users.json"
    uf.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(auth, "DIRECTORS_DIR", d)
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    monkeypatch.setenv("AUTH_USERS_FILE", str(uf))

    def approve(block, who):
        p = d / f"{block}.json"
        c = json.loads(p.read_text(encoding="utf-8"))
        c["approvers"] = [who]
        p.write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")

    def users(obj):
        uf.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    return {"approve": approve, "users": users, "dir": d}


@pytest.fixture
def enforce(monkeypatch):
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)


# ===================================================== A. thuần (không DB)

def test_authorize_allow_list(cfg, enforce):
    """`allow` (người ký QR / người nhận cảnh báo đỏ) thay approvers khối,
    vẫn bắt tài khoản + login khớp."""
    a = auth.authorize
    ok, why = a("Nguyễn Ký", "production", "sign", allow=[],
                allow_src="data/qr_signers.json", db_login="l1")
    assert not ok and "rỗng" in why
    ok, why = a("Người Khác", "production", "sign", allow=["Nguyễn  Ký"],
                db_login="l1")
    assert not ok and "không thuộc" in why
    ok, why = a("nguyễn ký", "production", "sign", allow=["Nguyễn  Ký"],
                db_login="l1")
    assert not ok and "chưa có tài khoản" in why
    cfg["users"]({"nguyễn ký": {"role": "phap_che", "db_login": "l1"}})
    assert a("Nguyễn Ký", "production", "sign", allow=["nguyễn ký"],
             db_login="L1") == (True, None)
    ok, why = a("Nguyễn Ký", "production", "sign", allow=["nguyễn ký"],
                db_login="l2")
    assert not ok and "login Postgres" in why
    # agent/system không bao giờ, kể cả có tên trong allow
    assert not a("agent:qr", "production", "sign", allow=["agent:qr"])[0]


def test_authorize_new_actions_dev_mode(cfg):
    """Dev: hành động mới hợp lệ, vẫn chặn agent/system; hành động lạ chặn."""
    for act in ("intake", "approve_price", "sign", "issue", "revoke",
                "set_status", "promote", "severe", "disable", "ack",
                "verify", "consent", "assign", "handoff", "load_dealers",
                "purge_sample", "adopt_plot"):
        assert auth.authorize("Lan", "sales", act) == (True, None), act
        assert not auth.authorize("system:cron", "sales", act)[0], act
    assert not auth.authorize("Lan", "sales", "xoa_het")[0]


# Mỗi CLI quyết định người → cổng `auth.cli_gate` với khối đúng việc.
GATES = [
    ("pipelines/production.py", (r'cli_gate\(conn, args\.by, "production",'
                                 r'\s+"approve" if')),
    ("pipelines/production.py", (r'cli_gate\(conn, args\.by, "production", '
                                 r'"intake"')),
    ("ingest/golden_store.py", r'cli_gate\(conn, by, "sales", "approve_price"'),
    ("pipelines/qr_trace.py", r'_gate\(conn, args\.by, "sign"'),
    ("pipelines/qr_trace.py", r'_gate\(conn, args\.by, "issue"'),
    ("pipelines/qr_trace.py", r'_gate\(conn, args\.by, "revoke"'),
    ("agents/xnqc.py", r'cli_gate\(conn, a\.by, "legal_hr", "set_status"'),
    ("pipelines/rollout.py", r'cli_gate\(conn, a\.by, blk, act'),
    ("pipelines/red_alert.py", r'cli_gate\(conn, by, None, "ack"'),
    ("ingest/crm.py", r'cli_gate\(conn, by, "sales", gated'),
    ("ingest/doc_intake.py", r'cli_gate\(conn, by, "legal_hr"'),
    ("agents/fp_pnl.py", r'cli_gate\(conn, by, "finance", "approve"'),
    ("agents/garden_director.py", r'conn, args\.by, "farming",'),
    ("ingest/kb_internal.py", (r'cli_gate\(hconn, a\.approved_by, '
                               r'"data_platform", "approve"')),
]


@pytest.mark.parametrize("path, pat", GATES)
def test_decision_clis_route_through_cli_gate(path, pat):
    src = (ROOT / path).read_text(encoding="utf-8")
    assert re.search(pat, src), (path, pat)


def test_service_dsn_selection(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    dev = {"DATABASE_URL": "postgresql://dev/x"}
    assert auth.service_dsn("job", {**dev, "AUTH_MODE": "dev"}) == (
        "postgresql://dev/x", None)
    assert auth.service_dsn("job", {**dev, "JOB_DATABASE_URL": "j"}) == (
        "j", None)
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    dsn, why = auth.service_dsn("webhook", dev)
    assert dsn is None and "WEBHOOK_DATABASE_URL" in why
    # chế độ thực thiếu biến → bind_service từ chối, KHÔNG rơi về DSN owner
    assert "WEBHOOK_DATABASE_URL" in auth.bind_service("webhook", dev)
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://giu/nguyen")
    monkeypatch.delenv("LOADER_DATABASE_URL", raising=False)
    # dev thiếu biến dịch vụ → không đổi DATABASE_URL đang có
    assert auth.bind_service("loader") is None
    assert os.environ["DATABASE_URL"] == "postgresql://giu/nguyen"
    assert set(auth.SERVICES) == {"webhook", "job", "loader", "backup"}
    assert {r for _, r in auth.SERVICES.values()} == set(SERVICE_GROUPS)


def test_service_entry_points_bind_login():
    """Webhook + job lịch + loader + backup chọn DSN dịch vụ ở đầu tiến trình."""
    for path, svc in (("connectors/zalo.py", "webhook"),
                      ("connectors/messenger.py", "webhook"),
                      ("pipelines/job_runs.py", None),
                      ("ingest/core_store.py", "loader"),
                      ("ingest/golden_store.py", "loader"),
                      ("ingest/market_csv.py", "loader"),
                      ("ingest/settlement_csv.py", "loader"),
                      ("ingest/inventory_csv.py", "loader"),
                      ("ingest/intel_import.py", "loader"),
                      ("ingest/embed_store.py", "loader"),
                      ("ingest/kb_internal.py", "loader"),
                      ("ingest/lead_store.py", "loader"),
                      ("agents/kd_orders.py", "loader")):
        src = (ROOT / path).read_text(encoding="utf-8")
        want = "bind_service(svc)" if svc is None else \
            f'bind_service("{svc}")'
        assert want in src, path
    assert job_runs.JOB_SERVICE["backup"] == "backup"
    jobs = job_runs.load_jobs()
    assert {n for n in jobs if job_runs.JOB_SERVICE.get(n, "job") is None} \
        <= {"restore_drill", "dr_drill"}


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
        schema = f"t_v14p2_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _Tx:
    """commit() = no-op (giữ trong tx fixture để rollback)."""

    def __init__(self, c):
        self._c = c

    def execute(self, *a, **k):
        return self._c.execute(*a, **k)

    def cursor(self, *a, **k):
        return self._c.cursor(*a, **k)

    def transaction(self):
        return self._c.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass


def _raises(conn, sql, args=(), exc=RaiseException):
    with pytest.raises(exc) as e, conn.transaction():
        conn.execute(sql, args)
    return str(e.value)


def _order(conn, oid, source, status="new"):
    conn.execute("insert into orders (id, ts, channel, qty, total_vnd,"
                 " status, source) values (%s, now(), 'shopee', 1, 100000,"
                 " %s, %s)", (oid, status, source))


def test_settlement_rows_append_only(db):
    """HĐ 7.3 iii: dòng quyết toán thật không sửa/xóa — kể cả owner."""
    db.execute("insert into settlement_rows (file_sha256, file_name, channel,"
               " row_no, order_id_hash, order_amount_vnd, payout_vnd)"
               " values (%s, 'qt.csv', 'shopee', 2, %s, 100000, 90000)",
               ("a" * 64, "b" * 16))
    for sql in ("update settlement_rows set payout_vnd = 1",
                "delete from settlement_rows",
                "truncate settlement_rows cascade"):
        assert "append-only" in _raises(db, sql)
    assert db.execute("select payout_vnd from settlement_rows").fetchone() \
        == (90000,)


def test_orders_real_rows_kept_with_history(db):
    _order(db, "shopee:aaaa", "market:shopee", "new")
    _order(db, "mau-1", "sample:sample_orders.jsonl")
    # đơn thật: không xóa / không đổi mã / không chuyển thành mẫu / không TRUNCATE
    assert "không xóa" in _raises(
        db, "delete from orders where id = 'shopee:aaaa'")
    assert "mã đơn" in _raises(
        db, "update orders set id = 'x' where id = 'shopee:aaaa'")
    assert "mẫu" in _raises(db, "update orders set source = 'sample:x'"
                                " where id = 'shopee:aaaa'")
    _raises(db, "truncate orders cascade")
    # đổi trạng thái hợp lệ → lịch sử append-only giữ giá trị cũ
    db.execute("update orders set status = 'cancelled' where id ="
               " 'shopee:aaaa'")
    db.execute("update orders set status = status where id = 'shopee:aaaa'")
    hist = db.execute("select order_id, old_row->>'status',"
                      " new_row->>'status' from order_history").fetchall()
    assert hist == [("shopee:aaaa", "new", "cancelled")]
    assert "append-only" in _raises(db, "delete from order_history")
    assert "append-only" in _raises(db, "update order_history set"
                                        " order_id = 'x'")
    # đơn mẫu: core_store vẫn xóa/nạp lại theo source
    core_store.apply_rows(_Tx(db), [("orders", "sample:sample_orders.jsonl", [{
        "id": "mau-2", "ts": "2026-10-01T00:00:00+07:00", "channel": "web",
        "product_id": None, "qty": 1, "total_vnd": 10, "status": "new",
        "note": None, "source": "sample:sample_orders.jsonl"}])])
    ids = [r[0] for r in db.execute("select id from orders order by id")]
    assert ids == ["mau-2", "shopee:aaaa"]
    assert db.execute("select count(*) from order_history").fetchone() == (1,)


def test_kd_orders_resync_idempotent_and_history(db):
    """Nạp lại cùng snapshot → 0 lịch sử; snapshot sau đổi trạng thái → 1."""
    sid = db.execute(
        "insert into market_snapshots (channel, export_kind, file_name,"
        " file_sha256, row_count) values ('shopee', 'order', 'o.csv',"
        " %s, 1) returning id", ("c" * 64,)).fetchone()[0]
    db.execute("insert into market_rows (snapshot_id, row_no, channel,"
               " export_kind, order_id_hash, status, qty, price_vnd, raw)"
               " values (%s, 2, 'shopee', 'order', %s, 'Hoàn thành', 1,"
               " 100000, '{}')", (sid, "d" * 16))
    tx = _Tx(db)
    assert kd_orders.sync(tx)["inserted"] == 1
    assert kd_orders.sync(tx)["unchanged"] == 1
    assert db.execute("select count(*) from order_history").fetchone() == (0,)
    sid2 = db.execute(
        "insert into market_snapshots (channel, export_kind, file_name,"
        " file_sha256, row_count) values ('shopee', 'order', 'o2.csv',"
        " %s, 1) returning id", ("e" * 64,)).fetchone()[0]
    db.execute("insert into market_rows (snapshot_id, row_no, channel,"
               " export_kind, order_id_hash, status, qty, price_vnd, raw)"
               " values (%s, 2, 'shopee', 'order', %s, 'Đã hủy', 1,"
               " 100000, '{}')", (sid2, "d" * 16))
    assert kd_orders.sync(tx)["updated"] == 1
    assert db.execute("select count(*) from order_history").fetchone() == (1,)


# ======================================== C. login Postgres thật (committed)

def _login_dsn(base, user, pw, schema):
    d = conninfo.conninfo_to_dict(base)
    d.update(user=user, password=pw, options=f"-c search_path={schema}")
    return conninfo.make_conninfo(**d)


@pytest.fixture(scope="module")
def live():
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_v14p2l_{tag}"
    groups = ("app_human", "ben_a_reader", *SERVICE_GROUPS)
    logins = {g: (f"t_p2_{g}_{tag}", secrets.token_urlsafe(18))
              for g in groups}
    own_role, own_login = f"t_p2own_{tag}", (f"t_p2ownl_{tag}",
                                             secrets.token_urlsafe(18))
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
        # login thành viên role SỞ HỮU 1 bảng của schema (owner giả lập)
        admin.execute(f"create role {own_role} nologin")
        admin.execute(f"create table {schema}.t_owned (id int)")
        admin.execute(f"alter table {schema}.t_owned owner to {own_role}")
        admin.execute(f"create role {own_login[0]} login password"
                      f" '{own_login[1]}' nosuperuser in role {own_role}")
        dsn = {g: _login_dsn(base, n, p, schema)
               for g, (n, p) in logins.items()}
        dsn["owner"] = _login_dsn(base, *own_login, schema)
        d = conninfo.conninfo_to_dict(base)
        d.update(options=f"-c search_path={schema}")
        dsn["admin"] = conninfo.make_conninfo(**d)
        yield {"admin": admin, "schema": schema, "dsn": dsn,
               "name": {g: n for g, (n, _) in logins.items()}}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for name, _ in (*logins.values(), own_login):
            admin.execute(f"drop role if exists {name}")
        admin.execute(f"drop role if exists {own_role}")
        admin.close()


def _login(live, grp):
    return psycopg.connect(live["dsn"][grp], connect_timeout=5)


def _admin_q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        return a.execute(sql, args or None).fetchall()


def _deny(conn, sql, args=()):
    with pytest.raises(InsufficientPrivilege), conn.transaction():
        conn.execute(sql, args)


def _denied(live, otype, oid):
    return _admin_q(live, "select count(*) from agent_action_log where action"
                    " = 'authz_denied' and object_type = %s and object_id"
                    " = %s", (otype, str(oid)))[0][0]


# ---------- 1. CLI quyết định người — chế độ thực

@pytest.fixture
def human(live, cfg, enforce, monkeypatch):
    """CLI chạy bằng login người (`in role app_human`) ở chế độ thực."""
    monkeypatch.setenv("DATABASE_URL", live["dsn"]["app_human"])
    monkeypatch.setenv("PYTHONIOENCODING", "utf-8")
    return cfg


CLI_CASES = [
    ("production approve", production.main,
     ["approve", "--run", "abcdef123456", "--by", ANY],
     "allocation_run", "abcdef123456", "Bên B ủy quyền"),
    ("production reject", production.main,
     ["reject", "--run", "abcdef123456", "--by", ANY],
     "allocation_run", "abcdef123456", "Bên B ủy quyền"),
    ("production intake", production.main,
     ["intake", "--lot", "LOT-P2", "--result", "passed", "--by", ANY],
     "production_lot", "LOT-P2", "Bên B ủy quyền"),
    ("golden approve-price", golden_store.main,
     ["--approve-price", "7", "--by", ANY], "price_list", "7",
     "Bên B ủy quyền"),
    ("qr issue", qr_trace.main, ["issue", "--lot", "LOT-P2", "--by", ANY],
     "qr_lot", "LOT-P2", "qr_signers"),
    ("qr revoke", qr_trace.main,
     ["revoke", "--code", "A" * 22, "--by", ANY], "qr_code", "A" * 12,
     "qr_signers"),
    ("xnqc set", xnqc.main,
     ["--set", "5", "--status", "da_nop", "--ngay-nop", "2026-10-01",
      "--by", ANY], "xnqc_dossier", "5", "Bên B ủy quyền"),
    ("rollout promote", rollout.main, ["--promote", "sales-01", "--by", ANY],
     "feature_rollout", "sales-01", "Bên B ủy quyền"),
    ("rollout severe", rollout.main,
     ["--severe", "sales-01", "--reason", min(rollout.SEVERE),
      "--by", ANY], "feature_rollout", "sales-01", "Bên B ủy quyền"),
    ("rollout disable", rollout.main, ["--disable", "sales-01", "--by", ANY],
     "feature_rollout", "sales-01", "Bên B ủy quyền"),
    ("crm consent", crm.main,
     ["--consent", "3", "--purpose", "cskh", "--grant", "--source", "zalo",
      "--evidence", "BB-1", "--policy-version", "v1", "--by", ANY],
     "crm", "3", "Bên B ủy quyền"),
    ("crm assign", crm.main,
     ["--assign", "4", "--dealer", "DL-01", "--by", ANY], "crm", "4",
     "Bên B ủy quyền"),
    ("crm load-dealers", crm.main, ["--load-dealers", "--by", ANY],
     "crm", "dealers", "Bên B ủy quyền"),
    ("doc verify", doc_intake.main, ["--verify", "f" * 64, "--by", ANY],
     "document", "f" * 12, "Bên B ủy quyền"),
    ("doc reject", doc_intake.main, ["--reject", "f" * 64, "--by", ANY],
     "document", "f" * 12, "Bên B ủy quyền"),
    ("cogs approve", fp_pnl.main, ["--cogs-approve", "9", "--by", ANY],
     "cogs_versions", "9", "Bên B ủy quyền"),
    ("garden purge", garden_director.main,
     ["--purge-sample", "--by", ANY], "plots", "sample", "Bên B ủy quyền"),
    ("garden adopt", garden_director.main,
     ["--adopt-plot", "K-01", "--by", ANY], "plots", "K-01",
     "Bên B ủy quyền"),
]


@pytest.mark.parametrize("label, fn, argv, otype, oid, frag",
                         CLI_CASES, ids=[c[0] for c in CLI_CASES])
def test_cli_enforced_arbitrary_by_rejected(live, human, capsys, label, fn,
                                            argv, otype, oid, frag):
    """Probe F08 ở biên CLI: chế độ thực, approvers/qr_signers THẬT rỗng,
    login app_human → `--by <tên tùy ý>` bị chặn TRƯỚC khi ghi, lần bị chặn
    vào log hash chain (code cũ: không cổng, không `authz_denied`)."""
    before = _denied(live, otype, oid)
    rc = fn(argv)
    out = capsys.readouterr()
    text = out.out + out.err
    assert rc != 0, (label, text)
    assert frag in text, (label, text)
    assert _denied(live, otype, oid) == before + 1, (label, text)


def test_qr_sign_requires_account_and_login(live, human, capsys, tmp_path,
                                            monkeypatch):
    """Người ký có tên trong qr_signers nhưng không có tài khoản/login của
    mình → chặn (code cũ: tên tự khai trong allowlist là đủ)."""
    sf = tmp_path / "qr_signers.json"
    sf.write_text(json.dumps({"status": "test", "roles": {
        "gd_san_xuat": ["Nguyễn Ký"], "gd_vung_trong": [],
        "phap_che_qa": []}}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(qr_trace, "SIGNERS_FILE", sf)
    argv = ["sign", "--lot", "LOT-P2", "--role", "gd_san_xuat", "--by",
            "Nguyễn Ký"]
    before = _denied(live, "qr_lot", "LOT-P2")
    assert qr_trace.main(argv) == 1
    assert "chưa có tài khoản" in capsys.readouterr().out
    human["users"]({"nguyễn ký": {"role": "tgd", "db_login": "khac"}})
    assert qr_trace.main(argv) == 1
    assert "login Postgres" in capsys.readouterr().out
    assert _denied(live, "qr_lot", "LOT-P2") == before + 2
    human["users"]({"nguyễn ký": {"role": "tgd",
                                  "db_login": live["name"]["app_human"]}})
    assert qr_trace.main(argv) == 1          # qua cổng → lô không tồn tại
    out = capsys.readouterr().out
    assert "login" not in out and "tài khoản" not in out, out
    assert _denied(live, "qr_lot", "LOT-P2") == before + 2


def test_cli_authorized_person_passes_gate(live, human, capsys):
    """Đúng người được ủy quyền khối + login của chính họ → qua cổng (lỗi
    sau đó là nghiệp vụ: run/lô không tồn tại), không ghi `authz_denied`."""
    human["approve"]("production", PERSON)
    human["users"]({PERSON: {"role": "tgd",
                             "db_login": live["name"]["app_human"]}})
    before = _denied(live, "production_lot", "LOT-OK")
    rc = production.main(["intake", "--lot", "LOT-OK", "--result", "passed",
                          "--by", PERSON])
    out = capsys.readouterr().out
    assert rc == 1 and "ủy quyền" not in out and "login" not in out, out
    assert _denied(live, "production_lot", "LOT-OK") == before
    # sai login (người khác chạy bằng login này) → chặn
    human["users"]({PERSON: {"role": "tgd", "db_login": "login_khac"}})
    assert production.main(["intake", "--lot", "LOT-OK", "--result",
                            "passed", "--by", PERSON]) == 1
    assert "login Postgres" in capsys.readouterr().out
    assert _denied(live, "production_lot", "LOT-OK") == before + 1


# ---------- v14 vá review (MINOR): KB nội bộ — người duyệt qua cổng

def _kb_file(tmp_path):
    f = tmp_path / "quy_trinh_MAU.md"
    f.write_text("# Quy trình MẪU\n\nBước 1: kiểm hàng. Bước 2: ghi sổ.\n",
                 encoding="utf-8")
    return f


def test_kb_internal_agent_approver_rejected_before_connect(monkeypatch,
                                                            tmp_path):
    """`--approved-by agent:*` / `system:*` = không phải người → exit 2
    TRƯỚC khi connect/embed (code cũ: chỉ kiểm không rỗng → nạp)."""
    from ingest import kb_internal

    def boom(*a, **k):
        raise AssertionError("không được connect/embed")
    monkeypatch.setattr(kb_internal, "connect", boom)
    monkeypatch.setattr(kb_internal, "embed_all", boom)
    for who in ("agent:kb", "system:cron"):
        with pytest.raises(SystemExit) as e:
            kb_internal.main(["--file", str(_kb_file(tmp_path)),
                              "--collection", "internal:kd",
                              "--approved-by", who])
        assert e.value.code == 2, who


def test_kb_internal_enforced_gate_human_login_then_loader(live, human,
                                                           capsys, tmp_path,
                                                           monkeypatch):
    """Chế độ thực: `--approved-by` tự khai không thuộc approvers khối
    data_platform → chặn, `authz_denied`, 0 embed. Đúng người + login của
    chính họ → qua cổng, ghi bằng login svc_loader (người không cần quyền
    ghi `chunks_internal`)."""
    from ingest import kb_internal
    calls = []

    def fake_embed(_client, _model, chunks):
        calls.append(len(chunks))
        return [[1.0, 0.0] for _ in chunks]
    monkeypatch.setattr(kb_internal, "embed_all", fake_embed)
    monkeypatch.setattr(kb_internal, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("LOADER_DATABASE_URL", live["dsn"]["svc_loader"])
    oid = "internal:kd/quy-trinh-mau"
    argv = ["--file", str(_kb_file(tmp_path)), "--collection", "internal:kd"]
    before = _denied(live, "chunks_internal", oid)
    assert kb_internal.main([*argv, "--approved-by", ANY]) == 1
    assert "Bên B ủy quyền" in capsys.readouterr().out
    assert _denied(live, "chunks_internal", oid) == before + 1
    assert calls == []
    human["approve"]("data_platform", PERSON)
    human["users"]({PERSON: {"role": "tgd",
                             "db_login": live["name"]["app_human"]}})
    assert kb_internal.main([*argv, "--approved-by", PERSON]) == 0, \
        capsys.readouterr()
    assert calls and _denied(live, "chunks_internal", oid) == before + 1
    assert _admin_q(live, "select distinct approved_by from chunks_internal"
                    " where doc_id = 'quy-trinh-mau'") == [(PERSON,)]
    # login người (app_human) tự ghi chunks_internal: không có quyền
    with _login(live, "app_human") as c:
        _deny(c, "delete from chunks_internal")


def test_red_alert_ack_needs_own_login(live, cfg, enforce):
    """Người nhận độc lập phải ack bằng login của chính họ."""
    with _login(live, "svc_job") as j:
        ok, _ = ra.raise_alert(j, "agent:p2", "Lô lỗi p2",
                               routing={"recipients": []})
    aid = _admin_q(live, "select max(id) from red_alerts")[0][0]
    routing = {"recipients": [{"name": "PC Giả Lập", "role": "phap_che",
                               "channel": "email:pc@vi-du.test"}]}
    with _login(live, "app_human") as h:
        ok, msg = ra.ack(h, aid, "PC Giả Lập", routing=routing)
        assert not ok and "tài khoản" in msg
        cfg["users"]({"pc giả lập": {"role": "phap_che",
                                     "db_login": live["name"]["app_human"]}})
        # docx P0c: DB bắt buộc `acked_by` = người của login (`human_logins`,
        # Bên B điền) — login người chưa ánh xạ bị chặn ở trigger.
        _admin_q(live, "insert into human_logins (db_login, person, blocks,"
                 " granted_by) values (%s, 'PC Giả Lập', '{}', 'test-p2') on"
                 " conflict (db_login) do update set person ="
                 " excluded.person returning db_login",
                 (live["name"]["app_human"],))
        ok, msg = ra.ack(h, aid, "PC Giả Lập", routing=routing)
        assert ok, msg
    assert _denied(live, "red_alert", aid) == 1
    assert _admin_q(live, "select acked_by from red_alert_acks where"
                    " alert_id = %s", (aid,)) == [("PC Giả Lập",)]


# ---------- 2. deny_log không commit việc dở của caller

def test_deny_log_does_not_commit_caller_work(live, enforce):
    with _login(live, "app_human") as c:
        # việc dở của caller: login người không ánh xạ không tạo được draft
        # (đợt an toàn S04b) → dùng 1 dòng red_alerts (không giữ khóa chuỗi)
        c.execute("insert into red_alerts (source_agent, title) values"
                  " ('agent:p2', 'p2-dang-do')")
        auth.deny_log(c, ANY, "sales", "approve", "p2_probe", "dang-do",
                      "lý do thử")
        c.rollback()
        # kết nối rảnh → ghi trong transaction riêng, không để tx mở
        auth.deny_log(c, ANY, "sales", "approve", "p2_probe", "ranh",
                      "lý do thử")
        assert c.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
    assert _admin_q(live, "select count(*) from red_alerts where title"
                    " = 'p2-dang-do'") == [(0,)]
    assert _denied(live, "p2_probe", "dang-do") == 1
    assert _denied(live, "p2_probe", "ranh") == 1
    assert _admin_q(live, "select count(*) from verify_action_log()") == [(0,)]


def test_deny_log_no_hang_when_caller_holds_chain_lock(live, enforce):
    """Caller đã ghi log trong tx đang mở (giữ khóa chuỗi) → kết nối phụ
    không chờ vô hạn: hết hạn chờ → savepoint trong tx caller."""
    import time
    with _login(live, "app_human") as c:
        # docx P0c: dòng caller ghi bằng tên agent (login người không ghi
        # được nhật ký mang tên NGƯỜI khác — trigger `person_login_guard`);
        # test này chỉ cần caller giữ khóa chuỗi.
        c.execute("insert into agent_action_log (actor, action, object_type,"
                  " object_id) values ('agent:p2', 'p2_caller', 'p2_probe',"
                  " 'giu-khoa')")
        t0 = time.monotonic()
        auth.deny_log(c, ANY, "sales", "approve", "p2_probe", "giu-khoa",
                      "lý do thử")
        assert time.monotonic() - t0 < 30
        c.commit()
    assert _denied(live, "p2_probe", "giu-khoa") == 1
    assert _admin_q(live, "select count(*) from verify_action_log()") == [(0,)]


# ---------- 3. login dịch vụ

def test_service_logins_not_owner_and_role_checked(live, enforce):
    for grp in SERVICE_GROUPS:
        with _login(live, grp) as c:
            assert auth.privileged_login(c) is None, grp
            svc = grp.removeprefix("svc_")
            assert auth.service_login_problem(c, svc) is None, grp
    with _login(live, "svc_job") as c:
        assert "không thuộc role 'svc_webhook'" in \
            auth.service_login_problem(c, "webhook")
    with _login(live, "owner") as c:
        assert "CHỦ SỞ HỮU" in auth.privileged_login(c)
        assert "CHỦ SỞ HỮU" in auth.service_login_problem(c, "job")
    with psycopg.connect(live["dsn"]["admin"], connect_timeout=5) as c:
        sup = c.execute("select rolsuper from pg_roles where rolname ="
                        " session_user").fetchone()[0]
        why = auth.privileged_login(c)
        assert why and ("SUPERUSER" if sup else "CHỦ SỞ HỮU") in why


def test_bind_service_enforced(live, enforce, monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    monkeypatch.setenv("DATABASE_URL", "postgresql://khong-dung/x")
    monkeypatch.setenv("WEBHOOK_DATABASE_URL", live["dsn"]["admin"])
    assert auth.bind_service("webhook")            # owner/superuser → chặn
    monkeypatch.setenv("WEBHOOK_DATABASE_URL", live["dsn"]["svc_loader"])
    assert "svc_webhook" in auth.bind_service("webhook")
    monkeypatch.setenv("WEBHOOK_DATABASE_URL", live["dsn"]["svc_webhook"])
    assert auth.bind_service("webhook") is None
    assert os.environ["DATABASE_URL"] == live["dsn"]["svc_webhook"]


def test_job_wrapper_runs_steps_under_job_login(live, enforce, monkeypatch,
                                                tmp_path):
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    monkeypatch.setenv("DATABASE_URL", live["dsn"]["admin"])
    rec = []
    monkeypatch.setattr(job_runs, "_record", lambda *a: rec.append(a))
    jobs = {"x": {"on_calendar": "*-*-* 01:00:00", "max_gap_hours": 1,
                  "steps": [["-m", "a"]]}}
    seen = []

    def runner(argv, cwd, timeout):
        seen.append(os.environ["DATABASE_URL"])
        return type("R", (), {"returncode": 0})

    def run():
        return job_runs.run_scheduled("x", jobs=jobs, lock_dir=tmp_path,
                                      runner=runner)
    monkeypatch.delenv("JOB_DATABASE_URL", raising=False)
    assert run() == job_runs.EXIT_SERVICE and seen == []   # thiếu biến
    monkeypatch.setenv("JOB_DATABASE_URL", live["dsn"]["admin"])
    assert run() == job_runs.EXIT_SERVICE and seen == []   # owner/superuser
    monkeypatch.setenv("JOB_DATABASE_URL", live["dsn"]["svc_webhook"])
    assert run() == job_runs.EXIT_SERVICE and seen == []   # sai role
    monkeypatch.setenv("JOB_DATABASE_URL", live["dsn"]["svc_job"])
    assert run() == 0 and seen == [live["dsn"]["svc_job"]]
    assert rec and rec[-1][3] is True


def test_webhook_login_does_its_job_only(live):
    """Webhook: đồng ý chat + mục handoff/gợi ý + đọc KB công khai được;
    KB nội bộ, PII, đơn, payload hàng duyệt, duyệt — không."""
    uh = "ab" * 16
    inb = channels.Inbound("zalo", uh, "hỏi giá hộp quà", "2026-10-16T08:00")
    with _login(live, "svc_webhook") as c:
        assert channels.record_consent(inb, "prompted", "m1", conn=c)
        assert channels.consent_state(c, "zalo", uh) == "prompted"
        assert channels.record_handoff(inb, "health", "m1", conn=c)
        assert channels.record_suggestion(inb, "Dạ hộp quà 6 năm ạ.", "m2",
                                          conn=c)
        c.execute("select count(*) from chunks").fetchone()
        c.commit()
        for sql in ("select count(*) from chunks_internal",
                    "select count(*) from contacts",
                    "select count(*) from consents",
                    "select count(*) from orders",
                    "select payload from approval_queue",
                    "select user_hash from leads",
                    "update chat_consents set action = 'granted'",
                    ("insert into approvals (object_type, object_id,"
                     " content_sha256, decision, approved_by) values ('x',"
                     " '1', repeat('a', 64), 'approved', 'x')")):
            _deny(c, sql)
        with pytest.raises(psycopg.Error), c.transaction():
            c.execute("select decide_item(1, 'Lan', 'approved', null)")
    rows = _admin_q(live, "select object_type, created_by from approval_queue"
                    " where created_by = 'agent:kd_a1' order by id")
    assert rows == [("cskh_handoff", "agent:kd_a1"),
                    ("cskh_reply", "agent:kd_a1")]


def _run(argv, dsn, tmp_path, **env):
    e = dict(os.environ, DATABASE_URL=dsn, PYTHONIOENCODING="utf-8",
             OPENROUTER_API_KEY="", RED_ALERT_NOTIFY="", SMTP_HOST="", **env)
    for k in ("APPROVAL_ENFORCE", "AUTH_MODE", "DEPLOY", "JOB_DATABASE_URL",
              "LOADER_DATABASE_URL", "WEBHOOK_DATABASE_URL"):
        e.pop(k, None)
    r = subprocess.run([sys.executable, *argv], cwd=ROOT, env=e,
                       capture_output=True, timeout=300, encoding="utf-8",
                       errors="replace", check=False)
    return r.returncode, r.stdout + r.stderr


# Chạy `main(argv, now=<ghim>)` của module trong tiến trình con (giữ cách ly
# env/login như `_run`) — đồng hồ tất định, không sleep.
_PINNED = ("import sys; from datetime import datetime; "
           "m = __import__(sys.argv[1], fromlist=['main']); "
           "raise SystemExit(m.main(sys.argv[3:],"
           " now=datetime.fromisoformat(sys.argv[2])))")


def _pinned_argv(mod, now, argv):
    return ["-c", _PINNED, mod, now.isoformat(), *argv]


def test_job_login_report_steps_match_owner(live, tmp_path):
    """Bước lịch đọc nhiều bảng (báo cáo TGĐ, báo cáo vận hành tháng) chạy
    dưới login svc_job cho ĐÚNG kết quả như owner — không có mục âm thầm
    'lỗi đọc … InsufficientPrivilege'."""
    # v15.1 (P7.5): hai lần chạy (owner, svc_job) dùng CHUNG một đồng hồ
    # ghim — báo cáo in "lập lúc dd/mm/yyyy HH:MM"; đồng hồ thật làm hai lần
    # chạy vắt phút → so khác nhau (chập chờn) dù quyền đúng. Tuần dữ liệu
    # mẫu cũng tính từ đồng hồ ghim (không từ now() của DB).
    # lệch 7 phút so với giờ máy → kiểm được báo cáo in giờ GHIM.
    pinned = (datetime.now(VN_TZ).replace(second=0, microsecond=0)
              - timedelta(minutes=7))
    last_week = (pinned - timedelta(days=7)).date()
    last_monday = last_week - timedelta(days=last_week.weekday())
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        a.execute("insert into channel_snapshots (channel, metric_id,"
                  " period_kind, period_start, value, source, source_ref,"
                  " captured_by) values ('shopee', 'gmv', 'week', %s,"
                  " 1000000, 'manual_export', 'f.csv', 'Lan')",
                  (last_monday,))
    for mod, argv in (("agents.ceo_report", ["--period", "week"]),
                      ("scripts.ops_monthly", ["--month", "prev"])):
        outs = {}
        for who in ("admin", "svc_job"):
            d = tmp_path / f"{mod}-{who}"
            rc, text = _run(_pinned_argv(mod, pinned,
                                         [*argv, "--out-dir", str(d)]),
                            live["dsn"][who], tmp_path)
            assert rc == 0, (argv, who, text)
            assert "InsufficientPrivilege" not in text, text
            outs[who] = {p.name: p.read_text(encoding="utf-8")
                         for p in d.iterdir()}
        assert outs["svc_job"] == outs["admin"], mod
        # đồng hồ ghim thật sự là giờ in trong báo cáo (không phải giờ máy)
        assert any(f"{pinned:%d/%m/%Y %H:%M}" in t
                   for t in outs["admin"].values()), mod
        assert "InsufficientPrivilege" not in json.dumps(outs, ensure_ascii=False)
    for argv in (["-m", "pipelines.intel_alert", "--run"],
                 ["-m", "pipelines.red_alert", "--deliver"],
                 ["scripts/ops_monthly.py", "--snapshot"],
                 ["-m", "pipelines.legal_updates", "--submit"]):
        rc, text = _run(argv, live["dsn"]["svc_job"], tmp_path)
        assert "InsufficientPrivilege" not in text and \
            "permission denied" not in text, (argv, text)
    with _login(live, "svc_job") as c:
        for sql in ("select count(*) from contacts",
                    "select count(*) from consents",
                    "select count(*) from chunks_internal",
                    "update agent_action_log set actor = 'x'",
                    "delete from orders",
                    "delete from settlement_rows",
                    "update approval_queue set status = 'approved'"):
            _deny(c, sql)
        with pytest.raises(psycopg.Error), c.transaction():
            c.execute("select decide_item(1, 'Lan', 'approved', null)")


def test_loader_login_loads_files_and_cannot_erase(live, tmp_path):
    fx = ROOT / "tests" / "fixtures"
    dsn = live["dsn"]["svc_loader"]
    for argv in (["-m", "ingest.market_csv", "--file",
                  str(fx / "market" / "fixture_shopee_order.csv"),
                  "--channel", "shopee", "--kind", "order"],
                 ["-m", "agents.kd_orders", "--sync"],
                 ["-m", "ingest.settlement_csv", "--file",
                  str(fx / "finance" / "settlement_shopee_MAU.csv"),
                  "--channel", "shopee"],
                 ["-m", "ingest.inventory_csv", "--file",
                  str(ROOT / "data" / "sample_inventory.csv"),
                  "--source", "sample"]):
        rc, text = _run(argv, dsn, tmp_path)
        assert rc == 0, (argv, text)
    rc, text = _run(["-m", "ingest.settlement_csv", "--file",
                     str(fx / "finance" / "settlement_shopee_MAU.csv"),
                     "--channel", "shopee"], dsn, tmp_path)
    assert rc == 0 and "[skip]" in text                    # nạp lại idempotent
    n_orders = _admin_q(live, "select count(*) from orders where source like"
                        " 'market:%'")[0][0]
    n_settle = _admin_q(live, "select count(*) from settlement_rows")[0][0]
    assert n_orders > 0 and n_settle > 0
    with _login(live, "svc_loader") as c:
        _deny(c, "delete from settlement_rows")
        with pytest.raises(RaiseException), c.transaction():
            c.execute("delete from orders where source like 'market:%'")
        for sql in ("select count(*) from contacts",
                    "select count(*) from consents",
                    "select count(*) from approval_queue",
                    ("insert into approvals (object_type, object_id,"
                     " content_sha256, decision, approved_by) values ('x',"
                     " '1', repeat('a', 64), 'approved', 'x')"),
                    "update agent_action_log set actor = 'x'"):
            _deny(c, sql)
    assert _admin_q(live, "select count(*) from orders where source like"
                    " 'market:%'")[0][0] == n_orders
    assert _admin_q(live, "select count(*) from settlement_rows")[0][0] \
        == n_settle


def test_loader_login_golden_cannot_self_approve(live, tmp_path):
    """v14 vá review (MAJOR): login svc_loader nạp golden được nhưng KHÔNG
    tự duyệt giá/map, KHÔNG quyết/xóa phiếu lệch đã quyết. Code cũ: UPDATE
    toàn bảng price_list/sku_map + mọi quyền golden_discrepancies → 4 câu
    probe đều chạy được."""
    dsn = live["dsn"]["svc_loader"]
    rc, text = _run(["-m", "ingest.golden_store"], dsn, tmp_path)
    assert rc == 0, text
    open_id = _admin_q(live, "select min(id) from price_list where"
                       " approved_by is null and valid_to is null")[0][0]
    assert open_id is not None
    pid, sku = _admin_q(live, "select product_id, sku_key from sku_map"
                        " order by product_id limit 1")[0]
    other = _admin_q(live, "select sku_key from sku_master where sku_key"
                     " <> %s order by 1 limit 1", (sku,))[0][0]
    n_disc = _admin_q(live, "select count(*) from golden_discrepancies")[0][0]
    assert n_disc > 0
    with _login(live, "svc_loader") as c:
        _deny(c, "update price_list set approved_by = 'svc', approved_at ="
                 " now() where id = %s", (open_id,))
        _deny(c, "update sku_map set approved_by = 'svc'")
        _deny(c, "update golden_discrepancies set status = 'resolved',"
                 " resolved_by = 'svc'")
        # INSERT sẵn-duyệt cũng phải bị chặn (sku_map: quyền theo cột;
        # price_list: trigger append-only).
        _deny(c, "insert into sku_map (product_id, sku_key, approved_by,"
                 " source) values ('x-new', %s, 'svc', 'svc')", (sku,))
    with _login(live, "svc_loader") as c,             pytest.raises(psycopg.errors.RaiseException), c.transaction():
        c.execute("insert into price_list (sku_key, channel, kind,"
                  " price_vnd, valid_from, approved_by) values (%s,"
                  " 'web', 'list', 1, current_date, 'svc')", (sku,))
    # Phiếu người đã quyết: không role nào xóa được (loader dọn pending).
    _admin_q(live, "update golden_discrepancies set status = 'resolved',"
             " resolved_by = 'Lan' where id = (select min(id) from"
             " golden_discrepancies) returning id")
    _admin_q(live, "update sku_map set approved_by = 'Sản xuất' where"
             " product_id = %s returning 1", (pid,))
    with _login(live, "svc_loader") as c:
        with pytest.raises(psycopg.errors.CheckViolation), c.transaction():
            c.execute("delete from golden_discrepancies")
        # đổi map (việc loader) → duyệt cũ tự xóa, không cần quyền cột duyệt
        c.execute("update sku_map set sku_key = %s, note = 'x' where"
                  " product_id = %s", (other, pid))
        assert c.execute("select approved_by from sku_map where product_id"
                         " = %s", (pid,)).fetchone()[0] is None
        c.rollback()
    assert _admin_q(live, "select count(*) from golden_discrepancies where"
                    " status = 'resolved'")[0][0] == 1
    # Phiếu pending hết điều kiện vẫn được loader dọn khi nạp lại.
    _admin_q(live, "insert into golden_discrepancies (kind, sku_key, detail,"
             " source) values ('price_mismatch', 'khong-con', '{}',"
             " 'golden_store') returning id")
    rc, text = _run(["-m", "ingest.golden_store"], dsn, tmp_path)
    assert rc == 0, text
    assert _admin_q(live, "select count(*) from golden_discrepancies where"
                    " sku_key = 'khong-con'")[0][0] == 0
    assert _admin_q(live, "select count(*) from golden_discrepancies where"
                    " status = 'resolved'")[0][0] == 1
    assert _admin_q(live, "select approved_by from sku_map where"
                    " product_id = %s", (pid,))[0][0] == "Sản xuất"


def test_backup_login_reads_everything_writes_nothing(live):
    tables = [r[0] for r in _admin_q(
        live, "select tablename from pg_tables where schemaname ="
              " current_schema() and tablename <> 't_owned' order by 1")]
    assert len(tables) > 50
    with _login(live, "svc_backup") as c:
        for t in tables:
            c.execute(f"select count(*) from {t}").fetchone()
        c.commit()
        for sql in (("insert into job_runs (job, started_at, finished_at,"
                     " ok) values ('x', now(), now(), true)"),
                    "delete from leads", "update orders set status = 'x'",
                    ("insert into red_alerts (source_agent, title) values"
                     " ('x', 'y')")):
            _deny(c, sql)


# ---------- 4. BKS theo dõi Bên A + login dịch vụ

def test_bks_audit_watches_ben_a_and_service_roles(live):
    assert {"ben_a_reader", *SERVICE_GROUPS} <= set(bks_audit.WATCH_ROLES)
    with psycopg.connect(live["dsn"]["admin"], connect_timeout=5,
                         autocommit=True) as c:
        assert bks_audit.check_privileges(c) == []
        c.execute("grant select on orders to ben_a_reader")
        c.execute("grant delete on settlement_rows to svc_job")
        c.execute("grant insert on job_runs to svc_backup")
        try:
            got = {(f["role"], f["table"], f["priv"])
                   for f in bks_audit.check_privileges(c)}
        finally:
            c.execute("revoke select on orders from ben_a_reader")
            c.execute("revoke delete on settlement_rows from svc_job")
            c.execute("revoke insert on job_runs from svc_backup")
    assert got == {("ben_a_reader", "orders", "SELECT"),
                   ("svc_job", "settlement_rows", "DELETE"),
                   ("svc_backup", "job_runs", "INSERT")}
