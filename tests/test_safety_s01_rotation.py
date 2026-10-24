"""Đợt an toàn S01 — `scripts/db_rotate_password.py` trên Postgres Docker TẠM.

Container thử riêng (không phải DB dev/samsam/server Bên B), mật khẩu ngẫu
nhiên sinh trong test, truyền qua TỆP env (không argv). Chứng minh CƠ CHẾ:
đổi bằng verifier SCRAM (log câu lệnh của server không chứa mật khẩu mới,
argv/stdout không chứa secret), mới vào được, cũ + sai bị từ chối 28P01 trên
đường TCP kiểm mật khẩu, thuộc tính role giữ nguyên, nơi dùng cũ bị phát hiện;
đường trust → KHÔNG KẾT LUẬN (exit 3). Không chứng minh rotation môi trường
thật nào. Skip khi không có docker/image postgres:16-alpine."""

import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts" / "db_rotate_password.py"
IMAGE = "postgres:16-alpine"
ROLE = "app_s01"


def _docker(*args, check=True):
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", check=check,
                          timeout=120)


def _have_docker() -> bool:
    if not shutil.which("docker"):
        return False
    r = _docker("image", "inspect", IMAGE, check=False)
    return r.returncode == 0


def _start(tmp: Path, *, trust=False):
    name = f"samsam-s01-{uuid.uuid4().hex[:8]}"
    admin_pw = secrets.token_urlsafe(18)
    envf = tmp / f"{name}.env"
    envf.write_text(f"POSTGRES_PASSWORD={admin_pw}\n" + (
        "POSTGRES_HOST_AUTH_METHOD=trust\n" if trust else ""),
        encoding="utf-8")
    _docker("run", "-d", "--rm", "--name", name, "--env-file", str(envf),
            "-p", "127.0.0.1::5432", IMAGE, "postgres", "-c",
            "log_statement=all")
    port = _docker("port", name, "5432/tcp").stdout.strip().rsplit(":", 1)[1]
    dsn = conninfo.make_conninfo(host="127.0.0.1", port=port, dbname="postgres",
                                 user="postgres", password=admin_pw)
    deadline = time.monotonic() + 60
    while True:
        try:
            with psycopg.connect(dsn, connect_timeout=2) as c:
                c.execute("select 1")
            break
        except psycopg.Error:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)
    return name, dsn


def _run(args, env, tmp):
    p = subprocess.run([sys.executable, str(TOOL), *args], cwd=tmp,
                       env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120,
                       check=False)
    return p.returncode, p.stdout + p.stderr, args


def _env(**kv):
    env = {k: v for k, v in os.environ.items()
           if not k.endswith("DATABASE_URL") and not k.startswith("PG")}
    env.update(PYTHONIOENCODING="utf-8", **kv)
    return env


@pytest.fixture
def pg(tmp_path):
    if not _have_docker():
        pytest.skip(f"không có docker/image {IMAGE}")
    started = []

    def start(**kw):
        name, dsn = _start(tmp_path, **kw)
        started.append(name)
        return name, dsn
    yield start
    for n in started:
        _docker("rm", "-f", n, check=False)


def test_rotate_new_works_old_rejected_no_secret_leak(pg, tmp_path):
    name, admin = pg()
    old = secrets.token_urlsafe(16)
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f"create role {ROLE} login password '{old}'")
        c.execute(f"grant pg_read_all_data to {ROLE}")
        attrs0 = c.execute("select rolsuper, rolcreaterole, rolcreatedb from"
                           " pg_roles where rolname = %s", (ROLE,)).fetchone()
    d = conninfo.conninfo_to_dict(admin)
    app = conninfo.make_conninfo(**{**d, "user": ROLE, "password": old})
    oldf, newf = tmp_path / "old.txt", tmp_path / "new.txt"
    oldf.write_text(old, encoding="utf-8")
    envf = tmp_path / "svc.env"
    envf.write_text(f"APP_DATABASE_URL={app}\n", encoding="utf-8")
    base = ["--role", ROLE]
    outs = []

    rc, out, argv = _run(["--check", *base, "--env-file", str(envf),
                          "--old-password-file", str(oldf)], _env(), tmp_path)
    outs.append((out, argv))
    assert rc == 1 and "trùng giá trị lộ=True" in out
    assert "kiểm mật khẩu=True" in out

    rc, out, argv = _run(["--rotate", *base, "--new-password-file", str(newf)],
                         _env(ADMIN_DATABASE_URL=admin), tmp_path)
    outs.append((out, argv))
    assert rc == 0, out
    assert "không tăng quyền" in out
    new = newf.read_text(encoding="utf-8").strip()
    assert new and new != old

    rc, out, argv = _run(["--verify", *base, "--dsn-env", "APP_DATABASE_URL",
                          "--new-password-file", str(newf),
                          "--old-password-file", str(oldf)],
                         _env(APP_DATABASE_URL=app), tmp_path)
    outs.append((out, argv))
    assert rc == 0, out
    assert "mật khẩu MỚI: ok" in out and "['28P01']" in out

    # nơi dùng còn mật khẩu cũ → phát hiện; cập nhật → đạt
    rc, out, argv = _run(["--verify-consumers", *base, "--env-file",
                          str(envf)], _env(), tmp_path)
    outs.append((out, argv))
    assert rc == 1 and "28P01" in out
    envf.write_text("APP_DATABASE_URL=" + conninfo.make_conninfo(
        **{**d, "user": ROLE, "password": new}) + "\n", encoding="utf-8")
    rc, out, argv = _run(["--verify-consumers", *base, "--env-file",
                          str(envf)], _env(), tmp_path)
    outs.append((out, argv))
    assert rc == 0, out

    with psycopg.connect(admin) as c:
        assert c.execute("select rolsuper, rolcreaterole, rolcreatedb from"
                         " pg_roles where rolname = %s", (ROLE,)).fetchone() \
            == attrs0
        ver = c.execute("select rolpassword from pg_authid where rolname = %s",
                        (ROLE,)).fetchone()[0]
    assert ver.startswith("SCRAM-SHA-256$")
    logs = _docker("logs", name).stdout + _docker("logs", name).stderr
    assert "alter role" in logs.lower()          # log câu lệnh BẬT
    assert new not in logs                       # chỉ verifier đi qua server
    for out, argv in outs:
        assert new not in out and old not in out
        assert not any(new in a or old in a for a in argv)


def test_trust_path_is_inconclusive(pg, tmp_path):
    _name, admin = pg(trust=True)
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f"create role {ROLE} login password 'x-{uuid.uuid4().hex}'")
    newf, oldf = tmp_path / "new.txt", tmp_path / "old.txt"
    newf.write_text(secrets.token_urlsafe(16), encoding="utf-8")
    oldf.write_text(secrets.token_urlsafe(16), encoding="utf-8")
    d = conninfo.conninfo_to_dict(admin)
    app = conninfo.make_conninfo(**{**d, "user": ROLE, "password": "?"})
    rc, out, _ = _run(["--verify", "--role", ROLE, "--dsn-env", "APP_DSN",
                       "--new-password-file", str(newf),
                       "--old-password-file", str(oldf)],
                      _env(APP_DSN=app), tmp_path)
    assert rc == 3 and "KHÔNG KẾT LUẬN" in out, out


def test_scram_verifier_rejects_non_ascii():
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import db_rotate_password as t
    finally:
        sys.path.pop(0)
    v = t.scram_verifier("abcDEF123-_", salt=b"\0" * 16)
    assert v.startswith("SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$")
    for bad in ("", "có dấu", "a b"):
        with pytest.raises(ValueError):
            t.scram_verifier(bad)
