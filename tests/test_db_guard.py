"""Đợt hợp đồng P0 — probe cổng DB test (`tests/_db_guard.py`).

Mọi ca "trỏ samsam" dùng driver GIẢ (`_db_guard._driver`) hoặc host chết /
chương trình không tồn tại: nếu cổng hỏng thì cũng không có kết nối thật nào
tới DB production. Không bao giờ chạy với DSN samsam thật."""

import os
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

from tests import _db_guard as g

ROOT = Path(__file__).resolve().parent.parent
DEAD = "10.255.255.1"


@pytest.fixture
def fake_driver(monkeypatch):
    calls = []
    monkeypatch.setattr(g, "_driver",
                        lambda cls, ci, **kw: calls.append((ci, kw)) or "conn")
    return calls


@pytest.mark.parametrize("dsn,kw", [
    (f"postgresql://u:SECRETPW@{DEAD}:5432/samsam", {}),
    (f"postgres://u@{DEAD}/samsam_contract_x?dbname=samsam", {}),
    (f"host={DEAD} dbname=samsam user=u", {}),
    (f"host={DEAD} dbname=SamSam", {}),
    (f"postgresql://u@{DEAD}/samsam_contract_g", {"dbname": "samsam"}),
    (f"host={DEAD} service=prod", {}),
    ("postgresql://[broken", {}),
])
def test_refused_before_driver(fake_driver, dsn, kw):
    with pytest.raises(g.TestDbRefused) as e:
        psycopg.connect(dsn, connect_timeout=1, **kw)
    assert fake_driver == []
    assert "SECRETPW" not in str(e.value)


@pytest.mark.parametrize("env", [
    {"PGDATABASE": "samsam"},
    {"PGUSER": "samsam", "PGDATABASE": ""},
    {"PGSERVICE": "prod"},
])
def test_env_default_refused(fake_driver, monkeypatch, env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(g.TestDbRefused):
        psycopg.connect(f"host={DEAD}", connect_timeout=1)
    assert fake_driver == []


def test_test_db_allowed_and_kwargs_override(fake_driver):
    assert psycopg.connect(f"postgresql://u@{DEAD}/samsam_contract_g") \
        == "conn"
    assert psycopg.connect(f"host={DEAD} dbname=samsam",
                           dbname="samsam_contract_g", autocommit=True) \
        == "conn"
    assert len(fake_driver) == 2
    assert fake_driver[1][1]["dbname"] == "samsam_contract_g"


def test_denylist_from_env_file():
    d = g.denied_names({"DATABASE_URL": "postgresql://u:p@h/proddb",
                        "JOB_DATABASE_URL": "host=h dbname=JobProd",
                        "OTHER": "postgresql://u@h/khong_lien_quan"})
    assert {"samsam", "proddb", "jobprod"} <= d
    assert "khong_lien_quan" not in d


def test_psycopg2_refused():
    psycopg2 = pytest.importorskip("psycopg2")
    with pytest.raises(g.TestDbRefused):
        psycopg2.connect(f"postgresql://u@{DEAD}:1/samsam", connect_timeout=1)


def test_dotenv_never_loads_dsn(tmp_path, monkeypatch):
    import dotenv
    f = tmp_path / ".env"
    f.write_text("DATABASE_URL=postgresql://u@h/samsam\nPGDATABASE=samsam\n"
                 "JOB_DATABASE_URL=dbname=samsam\nG_FOO=bar\n",
                 encoding="utf-8")
    for k in ("DATABASE_URL", "PGDATABASE", "JOB_DATABASE_URL", "G_FOO"):
        monkeypatch.delenv(k, raising=False)
    dotenv.load_dotenv(f)
    assert os.environ.get("G_FOO") == "bar"
    for k in ("DATABASE_URL", "PGDATABASE", "JOB_DATABASE_URL"):
        assert k not in os.environ


def test_session_dsn_vars_not_from_dotenv():
    # Không có DSN tường minh → "" (không phải giá trị .env); có → giữ.
    v = os.environ.get("DATABASE_URL")
    assert v is not None
    if v:
        assert g.check(v) not in g.DENIED


@pytest.mark.parametrize("args", [
    ["pg_dump_khong_ton_tai", f"postgresql://u@{DEAD}/samsam"],
    ["pg_dump_khong_ton_tai", "-d", "samsam"],
    ["pg_dump_khong_ton_tai", "--dbname=samsam"],
    ["pg_dump_khong_ton_tai", f"host={DEAD} dbname=samsam"],
])
def test_subprocess_args_refused(args):
    with pytest.raises(g.TestDbRefused):
        subprocess.run(args, check=False)


def test_subprocess_env_refused_and_filled():
    env = {k: v for k, v in os.environ.items()
           if not k.endswith("DATABASE_URL")}
    with pytest.raises(g.TestDbRefused):
        subprocess.run([sys.executable, "-c", "pass"], check=False,
                       env={**env, "DATABASE_URL": f"postgresql://u@{DEAD}/"
                                                   "samsam"})
    # env truyền tay THIẾU DSN → con nhận "" → load_dotenv(.env) THẬT trong
    # tiến trình con không lấp DSN production.
    code = ("import os; from dotenv import load_dotenv; "
            "load_dotenv(r'%s'); print(repr(os.environ.get('DATABASE_URL')))"
            % (ROOT / ".env"))
    r = subprocess.run([sys.executable, "-c", code], env=env,
                       capture_output=True, text=True, check=True)
    assert r.stdout.strip() == "''"


def test_explicit_prod_dsn_aborts_session_import():
    env = {**os.environ, "PYTHONIOENCODING": "utf-8",
           "DATABASE_URL": f"postgresql://u@{DEAD}:1/samsam"}
    # Popen đã bọc sẽ từ chối env này → dùng Popen gốc của stdlib (lớp cha);
    # con chỉ import conftest (install) — không kết nối (host chết).
    assert subprocess.Popen is g._GuardedPopen
    p = subprocess.Popen.__mro__[1](
        [sys.executable, "-c", "import tests.conftest"], cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8")
    _out, err = p.communicate(timeout=60)
    assert p.returncode != 0 and "production" in err


class _FakeConn:
    """Conn giả cho preflight: ghi lại SQL; `fail` = lỗi ném ở execute."""

    def __init__(self, row=(True, True, True, True), fail=None):
        self.row, self.fail, self.sql = row, fail, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, *a):
        self.sql.append(sql)
        if self.fail:
            raise self.fail("giả")
        return type("R", (), {"fetchone": lambda s: self.row})()


def _preflight_with(monkeypatch, conn=None, connect_exc=None):
    monkeypatch.setenv("DATABASE_URL",
                       f"postgresql://u:SECRETPW@{DEAD}/samsam_contract_trong")

    def fake(*a, **k):
        if connect_exc:
            raise connect_exc("giả")
        return conn
    monkeypatch.setattr(psycopg, "connect", fake)
    return g.preflight()


def test_preflight_unbuilt_db_message(monkeypatch):
    msg = _preflight_with(monkeypatch, _FakeConn(row=(False,) * 4))
    assert msg and "apply_schema" in msg and "samsam_contract_trong" in msg


# ---- vá 21/10 (controller tái hiện 3 lỗ; probe trước/sau ở evidence) ----

@pytest.mark.parametrize("fail", [
    psycopg.errors.UndefinedTable, psycopg.errors.InsufficientPrivilege,
    psycopg.errors.SyntaxError])
def test_preflight_query_errors_block(monkeypatch, fail):
    # G3: trước đây `except psycopg.Error: return None` → "đạt" giả.
    conn = _FakeConn(fail=fail)
    msg = _preflight_with(monkeypatch, conn)
    assert msg and "không sẵn sàng" in msg and "SECRETPW" not in msg
    assert all(q.lstrip().lower().startswith("select") for q in conn.sql)


def test_preflight_connect_error_blocks(monkeypatch):
    msg = _preflight_with(monkeypatch,
                          connect_exc=psycopg.OperationalError)
    assert msg and "OperationalError" in msg and "SECRETPW" not in msg


def test_preflight_ready_db_select_only(monkeypatch):
    conn = _FakeConn()
    assert _preflight_with(monkeypatch, conn) is None
    assert conn.sql and all(q.lstrip().lower().startswith("select")
                            for q in conn.sql)
    assert getattr(conn, "read_only", None) is True


def test_preflight_unit_run_without_dsn(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setattr(psycopg, "connect",
                        lambda *a, **k: pytest.fail("không được kết nối"))
    assert g.preflight() is None


@pytest.mark.parametrize("dsn,env", [
    ("", {}), (f"host={DEAD}", {}), (f"host={DEAD} user=u", {}),
    (f"host={DEAD}", {"PGUSER": "u"})])
def test_missing_explicit_dbname_refused(fake_driver, monkeypatch, dsn, env):
    # G2: trước đây suy DB từ user/PGUSER/user OS → tới driver.
    monkeypatch.delenv("PGDATABASE", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(g.TestDbRefused, match="tường minh"):
        psycopg.connect(dsn, connect_timeout=1)
    assert fake_driver == []


def test_pgdatabase_explicit_test_db_allowed(fake_driver, monkeypatch):
    monkeypatch.setenv("PGDATABASE", "samsam_contract_g")
    assert psycopg.connect(f"host={DEAD}") == "conn"
    assert len(fake_driver) == 1


def test_psycopg2_database_kw_and_missing_db_refused():
    psycopg2 = pytest.importorskip("psycopg2")
    for kw in ({"database": "samsam"}, {}):
        with pytest.raises(g.TestDbRefused):
            psycopg2.connect(f"host={DEAD} port=1", connect_timeout=1, **kw)


@pytest.fixture
def spawn_spy(monkeypatch):
    """Đếm lần TẠO tiến trình thật (Popen gốc `_execute_child`) + env gửi."""
    base = subprocess.Popen.__mro__[1]
    orig, seen = base._execute_child, []

    def spy(self, args, executable, preexec_fn, close_fds, pass_fds, cwd,
            env, *a, **kw):
        seen.append(env)
        return orig(self, args, executable, preexec_fn, close_fds, pass_fds,
                    cwd, env, *a, **kw)
    monkeypatch.setattr(base, "_execute_child", spy)
    return seen


CHILD = [sys.executable, "-I", "-c",
         "import os; print(repr(os.environ.get('DATABASE_URL')))"]


@pytest.mark.parametrize("var,val,kw", [
    ("DATABASE_URL", f"postgresql://u:SECRETPW@{DEAD}/samsam", {}),
    ("DATABASE_URL", f"postgresql://u:SECRETPW@{DEAD}/samsam",
     {"env": None}),
    ("JOB_DATABASE_URL", f"host={DEAD} dbname=samsam", {}),
    ("PGDATABASE", "samsam", {}),
    ("PGSERVICE", "prod", {})])
def test_inherited_env_checked_at_spawn(spawn_spy, monkeypatch, var, val, kw):
    # G1: đổi os.environ SAU install() rồi spawn không truyền env/env=None.
    monkeypatch.setenv(var, val)
    before = dict(os.environ)
    with pytest.raises(g.TestDbRefused) as e:
        subprocess.run(CHILD, capture_output=True, check=False, **kw)
    assert spawn_spy == [] and dict(os.environ) == before
    assert "SECRETPW" not in str(e.value)


def test_spawn_env_copies_blank_dsn_and_keeps_caller_dict(spawn_spy):
    caller = {"SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
    snap = dict(caller)
    r = subprocess.run(CHILD, env=caller, capture_output=True, text=True,
                       check=True)
    assert r.stdout.strip() == "''" and caller == snap
    assert all(spawn_spy[0].get(k) == "" for k in g.DSN_VARS)
    subprocess.run(CHILD, env={}, capture_output=True, check=False)
    assert all(spawn_spy[1].get(k) == "" for k in g.DSN_VARS)


def test_spawn_inherited_valid_env_runs(spawn_spy, monkeypatch):
    monkeypatch.setenv("DATABASE_URL",
                       f"postgresql://u@{DEAD}/samsam_contract_g")
    r = subprocess.run(CHILD, capture_output=True, text=True, check=True)
    assert "samsam_contract_g" in r.stdout and len(spawn_spy) == 1
