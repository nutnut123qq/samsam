"""v3.6 — scripts/db_backup.py + scripts/db_restore_drill.py + deploy/cloud.

Unit (không DB): usage exit 2 trước connect, resolver công cụ 4 bước, argv
docker không chứa mật khẩu, retention theo created_at, drift-guard README.
E2E (DB thật `DATABASE_URL`, gate yêu cầu 0 skipped): backup → manifest/
sha256/row_counts khớp live; retention + offsite; mã hóa; s3 exit 3;
drill khớp + DB tạm bị drop; guard từ chối; byte hỏng; manifest lệch.
Mọi DB diễn tập do test tạo đều bị drop (kiểm cuối mỗi test).
"""

import json
import os
import re
import secrets
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest

# Số bảng lấy từ schema.sql — không hằng số (bảng chỉ được THÊM, version
# song song không phải sửa test này).
N_TABLES = len(re.findall(
    r"^create table if not exists (\w+)",
    (Path(__file__).resolve().parent.parent / "docs" / "schema.sql")
    .read_text(encoding="utf-8"), re.MULTILINE))
from dotenv import dotenv_values
from psycopg import sql

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import db_backup as bk
import db_restore_drill as dr

DEAD_DSN = "postgresql://u@10.255.255.1:5432/x"
# Hậu tố riêng mỗi phiên pytest: pg_database là cluster-wide — nhiều
# worktree chạy song song trên cùng server PG không đụng tên DB tạm của nhau.
RUN = secrets.token_hex(3)
DRILL_PREFIX = f"samsam_drill_test_{RUN}_"


# ---------------- unit ----------------

def _no_connect(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("không được connect khi usage sai")
    monkeypatch.setattr(bk.psycopg, "connect", boom)


# Biến script đọc từ env. main() gọi load_dotenv(<repo thật>/.env), mà
# load_dotenv KHÔNG ghi đè biến đã tồn tại → test phải setenv "" (rỗng =
# chưa cấu hình trong read_config/find_tool/drill) thay vì delenv: delenv
# để .env thật (BACKUP_OFFSITE/KEEP của operator) lấp vào → test chạy
# retention trên thư mục offsite thật + rò biến sang cả phiên pytest.
SCRIPT_VARS = ("BACKUP_DIR", "BACKUP_KEEP", "BACKUP_OFFSITE",
               "BACKUP_PASSPHRASE_FILE", "DRILL_DATABASE_URL", "PG_BIN")


@pytest.fixture
def clean_env(monkeypatch):
    for k in SCRIPT_VARS:
        monkeypatch.setenv(k, "")


@pytest.mark.parametrize("env", [
    {},
    {"BACKUP_DIR": str(ROOT / "backups")},
    {"BACKUP_KEEP": "0"}, {"BACKUP_KEEP": "-1"}, {"BACKUP_KEEP": "abc"},
    {"BACKUP_OFFSITE": "dir:" + str(ROOT / "off")},
    {"BACKUP_OFFSITE": "ftp://x"},
    {"BACKUP_PASSPHRASE_FILE": str(ROOT / "AGENTS.md")},
])
def test_usage_exit2_before_connect(monkeypatch, tmp_path, clean_env, env):
    _no_connect(monkeypatch)
    full = {"BACKUP_DIR": str(tmp_path / "bk")} if env else {}
    full.update(env)
    for k, v in full.items():
        monkeypatch.setenv(k, v)
    assert bk.main() == 2
    assert not (ROOT / "backups").exists()
    assert not (ROOT / "off").exists()


def test_find_tool_order(monkeypatch, tmp_path):
    exe = bk._exe("pg_dump")
    pgbin = tmp_path / "pgbin"
    pgbin.mkdir()
    (pgbin / exe).write_bytes(b"")
    base = tmp_path / "PostgreSQL"
    (base / "17" / "bin").mkdir(parents=True)
    (base / "17" / "bin" / exe).write_bytes(b"")
    monkeypatch.setattr(bk, "PG_WIN_BASE", str(base))
    monkeypatch.setattr(bk.shutil, "which", lambda n: "/usr/bin/pg_dump")
    monkeypatch.setattr(bk, "_docker_has_image", lambda img: True)
    # (1) PG_BIN
    monkeypatch.setenv("PG_BIN", str(pgbin))
    assert bk.find_tool("pg_dump", 17) == ("native",
                                           (pgbin / exe).as_posix())
    # (2) PATH
    monkeypatch.delenv("PG_BIN")
    assert bk.find_tool("pg_dump", 17) == (
        "native", Path("/usr/bin/pg_dump").as_posix())
    # (3) bộ cài Windows theo major server
    monkeypatch.setattr(bk.shutil, "which", lambda n: None)
    assert bk.find_tool("pg_dump", 17) == (
        "native", (base / "17" / "bin" / exe).as_posix())
    # (4) docker image có sẵn
    assert bk.find_tool("pg_dump", 16) == ("docker", "postgres:16-alpine")
    monkeypatch.setattr(bk, "_docker_has_image", lambda img: False)
    assert bk.find_tool("pg_dump", 16) is None


def test_docker_argv_no_password():
    env = bk.pg_env("postgresql://usr:s3cretPW@localhost:5432/db1")
    argv = bk.tool_argv(("docker", "postgres:17-alpine"), "pg_dump",
                        ["-Fc"], env)
    joined = " ".join(argv)
    assert "PGHOST=host.docker.internal" in argv
    assert argv[argv.index("PGPASSWORD") - 1] == "-e"
    assert "s3cretPW" not in joined and "usr" not in argv
    assert env["PGPASSWORD"] == "s3cretPW"
    assert env["PGCONNECT_TIMEOUT"] == str(bk.CONNECT_TIMEOUT)
    native = bk.tool_argv(("native", "/x/pg_dump"), "pg_dump", ["-Fc"], env)
    assert "s3cretPW" not in " ".join(native)


def test_scrub_hides_secrets():
    dsn = "postgresql://bkuser:s3cretPW@db.example.vn:5432/samsam"
    out = bk.scrub(f'connection to "db.example.vn" user "bkuser" '
                   f"pw s3cretPW dsn {dsn}", dsn)
    for s in ("s3cretPW", "bkuser", "db.example.vn", "postgresql://"):
        assert s not in out


def _fake_manifest(d: Path, name: str, created: str, db="samsam_v36"):
    (d / name).write_bytes(b"PGDMP")
    m = {"format": 1, "created_at": created, "db_name": db,
         "server_version": "17", "pg_dump_version": "17", "tool": "x",
         "file": name, "size_bytes": 5, "sha256": "0", "encrypted": False,
         "cipher": None, "row_counts": {}}
    (d / (name + bk.MANIFEST_SUFFIX)).write_text(json.dumps(m),
                                                 encoding="utf-8")


def test_retention_by_created_at_not_mtime(tmp_path):
    # Tên file (giờ trong tên) cố tình NGƯỢC thứ tự created_at.
    days = ["2026-10-05", "2026-10-01", "2026-10-04", "2026-10-02",
            "2026-10-03"]
    for i, day in enumerate(days):
        _fake_manifest(tmp_path, f"samsam_v36_2026010{i}_000000_vn.dump",
                       f"{day}T01:30:00+07:00")
    (tmp_path / "notes.txt").write_text("x")
    (tmp_path / "samsam_v36_20250101_000000_vn.dump.manifest.json"
     ).write_text("{hỏng", encoding="utf-8")
    (tmp_path / "x_20250101_000000_vn.dump.partial").write_bytes(b"x")
    (tmp_path / "backup_runs.jsonl").write_bytes(b"{}\n")
    _fake_manifest(tmp_path, "other_20200101_000000_vn.dump",
                   "2020-01-01T00:00:00+07:00", db="other")
    removed, errors = bk.apply_retention(tmp_path, 3, "samsam_v36")
    assert errors == []
    kept = sorted(m["created_at"][:10]
                  for _, _, m in bk.valid_manifests(tmp_path, "samsam_v36"))
    assert kept == ["2026-10-03", "2026-10-04", "2026-10-05"]
    assert len(removed) == 2
    for f in ("notes.txt", "samsam_v36_20250101_000000_vn.dump.manifest.json",
              "x_20250101_000000_vn.dump.partial", "backup_runs.jsonl",
              "other_20200101_000000_vn.dump"):
        assert (tmp_path / f).exists(), f


def test_manifest_file_must_match_name(tmp_path):
    """Manifest trỏ `file` khác tên (vd ../../x) → không hợp lệ, không xóa."""
    _fake_manifest(tmp_path, "samsam_v36_20260101_000000_vn.dump",
                   "2026-01-01T00:00:00+07:00")
    mp = tmp_path / "samsam_v36_20260101_000000_vn.dump.manifest.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["file"] = "../victim.txt"
    mp.write_text(json.dumps(m), encoding="utf-8")
    assert bk.load_manifest(mp) is None
    assert bk.apply_retention(tmp_path, 1, "samsam_v36") == ([], [])


def test_guard_name_unit():
    with pytest.raises(dr.Refuse):
        dr.guard_name("samsam_v36", ["postgresql://u@h/samsam_v36"])
    with pytest.raises(dr.Refuse):
        dr.guard_name("postgres", ["postgresql://u@h/samsam_v36"])
    with pytest.raises(dr.Refuse):  # khớp mẫu nhưng trùng DB đang dùng
        dr.guard_name("samsam_drill_x", ["postgresql://u@127.0.0.1/a",
                                         "postgresql://u@localhost/samsam_drill_x"])
    with pytest.raises(dr.Refuse):
        dr.guard_name("samsam_drill_X; drop", ["postgresql://u@h/a"])
    dr.guard_name("samsam_drill_20261012_010101_ab12",
                  ["postgresql://u@h/samsam_v36"])


def test_no_network_libs_in_backup():
    src = (ROOT / "scripts" / "db_backup.py").read_text(encoding="utf-8")
    assert not re.search(r"boto3|requests|httpx", src)


def test_dotenv_backup_vars_loaded_before_config(monkeypatch, tmp_path):
    """BACKUP_* chỉ nằm trong .env (README mục 2: chép env mẫu thành .env)
    vẫn có hiệu lực; env tiến trình thắng .env (setup lẫn lộn shell/.env
    không làm mất passphrase/offsite câm)."""
    repo = tmp_path / "repo"
    repo.mkdir()
    pf = tmp_path / "pass.txt"
    pf.write_bytes(b"dung-passphrase-test-dai\n")
    (repo / ".env").write_text(
        f"BACKUP_DIR={(tmp_path / 'bk').as_posix()}\n"
        f"BACKUP_PASSPHRASE_FILE={pf.as_posix()}\n"
        f"BACKUP_OFFSITE=dir:{(tmp_path / 'off').as_posix()}\n"
        "BACKUP_KEEP=4\n", encoding="utf-8")
    monkeypatch.setattr(bk, "ROOT", repo)
    for k in ("BACKUP_DIR", "BACKUP_PASSPHRASE_FILE", "BACKUP_OFFSITE",
              "BACKUP_KEEP"):
        monkeypatch.setenv(k, "x")  # ghi nhận giá trị gốc để teardown khôi phục
        monkeypatch.delenv(k)
    monkeypatch.setenv("BACKUP_KEEP", "5")  # env tiến trình thắng .env
    monkeypatch.setenv("DATABASE_URL", DEAD_DSN)
    seen = {}

    def fake_backup(cfg, dsn):
        seen.update(cfg)
        return 0, {"status": "ok"}
    monkeypatch.setattr(bk, "run_backup", fake_backup)
    assert bk.main() == 0
    assert seen["dir"] == (tmp_path / "bk").resolve()
    assert seen["passfile"] == pf.resolve()
    assert seen["offsite"] == ("dir", (tmp_path / "off").resolve())
    assert seen["keep"] == 5
    # Drill đọc BACKUP_DIR cũng sau khi nạp .env.
    monkeypatch.delenv("BACKUP_DIR")
    got = []
    monkeypatch.setattr(dr, "run_drill",
                        lambda args, bdir, dsn: got.append(bdir) or (0, {}))
    assert dr.main([]) == 0
    assert got == [(tmp_path / "bk").resolve()]


def test_clean_env_blocks_dotenv_backup_vars(monkeypatch, tmp_path,
                                             clean_env):
    """Regression (nghiệm thu v3.6 MAJOR): .env của operator có BACKUP_*/
    DRILL_DATABASE_URL/PG_BIN → fixture test KHÔNG được để main() nạp lại
    (delenv + load_dotenv = test chạy retention trên offsite THẬT)."""
    repo = tmp_path / "repo"
    repo.mkdir()
    real_off = tmp_path / "real_off"
    real_off.mkdir()
    pf = tmp_path / "pass.txt"
    pf.write_bytes(b"dung-passphrase-test-dai\n")
    (repo / ".env").write_text(
        f"BACKUP_DIR={(tmp_path / 'real_bk').as_posix()}\n"
        f"BACKUP_OFFSITE=dir:{real_off.as_posix()}\n"
        "BACKUP_KEEP=2\n"
        f"BACKUP_PASSPHRASE_FILE={pf.as_posix()}\n"
        "DRILL_DATABASE_URL=postgresql://u@other.example/x\n"
        f"PG_BIN={(tmp_path / 'pgbin').as_posix()}\n", encoding="utf-8")
    monkeypatch.setattr(bk, "ROOT", repo)
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("DATABASE_URL", DEAD_DSN)
    seen = {}

    def fake_backup(cfg, dsn):
        seen.update(cfg)
        return 0, {"status": "ok"}
    monkeypatch.setattr(bk, "run_backup", fake_backup)
    assert bk.main() == 0
    assert seen["offsite"] is None and seen["keep"] == 7
    assert seen["passfile"] is None
    assert seen["dir"] == (tmp_path / "bk").resolve()
    (tmp_path / "bk").mkdir(exist_ok=True)
    got = []
    monkeypatch.setattr(dr, "run_drill", lambda args, bdir, dsn: got.append(
        os.environ.get("DRILL_DATABASE_URL")) or (0, {}))
    assert dr.main([]) == 0
    assert got == [""]
    for k in SCRIPT_VARS[1:]:
        assert os.environ[k] == "", k  # .env không lấp biến đã set rỗng


@pytest.mark.parametrize("body", [
    b"\n", b"\r\n", b"   \n", b"\ndung-passphrase-o-dong-hai\n",
    b"ngan-qua\n", b"",
    # UTF-16LE (PowerShell 5.1 `>`/Out-File, Notepad 'Unicode'): >16 byte
    # nhưng openssl cắt ở NUL → khóa thật = BOM + 'M' (3 byte).
    b"\xff\xfe" + "MatKhauRatDaiVaManh2026\n".encode("utf-16-le"),
    "MatKhauRatDaiVaManh2026\n".encode("utf-16-be"),  # không BOM, NUL đầu
    b"\xfe\xff" + "MatKhauRatDaiVaManh2026\n".encode("utf-16-be"),
    b"0123456789abcdef\x00tail\n",  # NUL giữa dòng → khóa thật 16 byte đầu
])
def test_weak_passphrase_file_refused(monkeypatch, tmp_path, clean_env,
                                      body):
    """openssl `-pass file:` chỉ dùng dòng đầu: dòng đầu trống/ngắn → mã hóa
    bằng khóa rỗng/yếu mà manifest ghi `encrypted` → phải từ chối."""
    _no_connect(monkeypatch)
    pf = tmp_path / "pass.txt"
    pf.write_bytes(body)
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("BACKUP_PASSPHRASE_FILE", str(pf))
    assert bk.main() == 2
    # Drill: kiểm cùng luật TRƯỚC khi gọi openssl, không tạo file tạm.
    monkeypatch.setattr(bk, "find_openssl",
                        lambda: pytest.fail("không được gọi openssl"))
    with pytest.raises(RuntimeError, match="dòng đầu"):
        dr._decrypt(tmp_path / "x.enc", str(pf), tmp_path)
    assert not list(tmp_path.glob("drill_*.partial"))


def test_passphrase_first_line_ok(tmp_path):
    pf = tmp_path / "p.txt"
    pf.write_bytes(b"0123456789abcdef\r\nbo-qua\n")
    bk.check_passfile(pf)  # 16 ký tự, CRLF → hợp lệ
    pf.write_bytes(b"0123456789abcdef")  # không xuống dòng
    bk.check_passfile(pf)


# ---------------- drift-guard deploy/cloud ----------------

def test_cloud_readme_drift_guard():
    readme = (ROOT / "deploy" / "cloud" / "README.md").read_text(
        encoding="utf-8")
    env = (ROOT / "deploy" / "cloud" / "env.cloud.example").read_text(
        encoding="utf-8")
    schema = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    tables = re.findall(r"^create table if not exists (\w+)", schema, re.MULTILINE)
    assert len(tables) == N_TABLES
    for t in tables:
        assert f"`{t}`" in readme, f"README thiếu bảng {t}"
    assert "sslmode=require" in readme and "sslmode=require" in env
    for key in ("DATABASE_URL", "DRILL_DATABASE_URL", "BACKUP_DIR",
                "BACKUP_KEEP", "BACKUP_OFFSITE", "BACKUP_PASSPHRASE_FILE",
                "PG_BIN"):
        assert re.search(rf"^{key}=", env, re.MULTILINE), key
    for body in (readme, env):
        for line in body.splitlines():
            assert not re.search(r"postgresql://[^<\s:/]+:[^<\s@]+@", line)
            assert "sk-or-v1" not in line
    targets = re.findall(r"python (?:-m )?([\w./]+\w)", readme)
    assert len(targets) >= 6
    for target in targets:
        if target.endswith(".py"):
            assert (ROOT / target).is_file(), target
        else:
            assert (ROOT / (target.replace(".", "/") + ".py")).is_file(), \
                target


# ---------------- E2E DB thật ----------------

@pytest.fixture(scope="module")
def live():
    # dotenv_values (không load_dotenv): không nạp BACKUP_* của .env vào
    # os.environ cho cả phiên; env fixture setenv DATABASE_URL có teardown.
    dsn = (os.environ.get("DATABASE_URL")
           or dotenv_values(ROOT / ".env").get("DATABASE_URL"))
    if not dsn:
        pytest.skip("thiếu DATABASE_URL")
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            major = c.info.server_version // 10000
    except psycopg.Error:
        pytest.skip("không connect được DATABASE_URL")
    if bk.find_tool("pg_dump", major) is None:
        pytest.skip("không có pg_dump")
    return dsn


def _counts(dsn):
    with psycopg.connect(dsn, connect_timeout=5) as c:
        return bk._snapshot_counts(c)


def _exists(dsn, name):
    with psycopg.connect(dsn, connect_timeout=5) as c:
        return c.execute("select 1 from pg_database where datname=%s",
                         (name,)).fetchone() is not None


def _drop(dsn, name):
    with psycopg.connect(dsn, autocommit=True, connect_timeout=5) as c:
        c.execute(sql.SQL("drop database if exists {} with (force)")
                  .format(sql.Identifier(name)))


@pytest.fixture
def env(monkeypatch, tmp_path, live, clean_env):
    """BACKUP_* sạch (clean_env) trỏ tmp_path; vn_now tăng dần 1 phút/lần
    (tên file theo giây — chạy nhanh liên tiếp không đụng tên)."""
    monkeypatch.setenv("DATABASE_URL", live)
    bdir = tmp_path / "bk"
    monkeypatch.setenv("BACKUP_DIR", str(bdir))
    t = [bk.vn_now()]

    def fake_now():
        t[0] += timedelta(minutes=1)
        return t[0]
    monkeypatch.setattr(bk, "vn_now", fake_now)
    return bdir


def _dumps(d: Path):
    return sorted(p.name for p in d.glob("*_vn.dump*")
                  if not p.name.endswith(bk.MANIFEST_SUFFIX))


def _last(path: Path) -> dict:
    return json.loads(path.read_bytes().split(b"\n")[-2])


def test_backup_manifest_matches_live(env, live):
    before = _counts(live)
    assert bk.main() == 0
    (mp,) = list(env.glob("*" + bk.MANIFEST_SUFFIX))
    m = json.loads(mp.read_text(encoding="utf-8"))
    dump = env / m["file"]
    assert set(m) == set(bk.MANIFEST_KEYS)
    assert m["created_at"].endswith("+07:00")
    assert re.fullmatch(r"\w+_\d{8}_\d{6}_vn\.dump", m["file"])
    assert bk.sha256_file(dump) == m["sha256"]
    assert m["size_bytes"] == dump.stat().st_size
    assert dump.read_bytes()[:5] == b"PGDMP"
    assert len(m["row_counts"]) == N_TABLES
    # v15 fix P8.7c: backup ghi ĐÚNG 1 dòng bằng chứng đầu ra SAU snapshot
    # (manifest khớp trạng thái lúc dump; ngoài sổ bằng chứng không đổi gì).
    ev = "file_output_evidence"
    assert m["row_counts"] == before
    assert _counts(live) == {**before, ev: before[ev] + 1}
    assert m["encrypted"] is False and m["cipher"] is None
    pw = psycopg.conninfo.conninfo_to_dict(live).get("password")
    for f in (mp, env / "backup_runs.jsonl"):
        body = f.read_text(encoding="utf-8")
        assert live not in body
        if pw:
            assert pw not in body
    assert _last(env / "backup_runs.jsonl")["status"] == "ok"
    assert not list(env.glob("*.partial"))


def test_backup_dead_host_exit1_no_files(env, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", DEAD_DSN)
    monkeypatch.setattr(bk, "CONNECT_TIMEOUT", 2)
    assert bk.main() == 1
    assert _dumps(env) == []
    assert not list(env.glob("*" + bk.MANIFEST_SUFFIX))
    rec = _last(env / "backup_runs.jsonl")
    assert rec["status"] == "fail" and "10.255.255.1" not in rec["error"]


def test_backup_tool_major_too_old(env, monkeypatch):
    monkeypatch.setattr(bk, "tool_major", lambda *a: (9, "pg_dump 9.6"))
    assert bk.main() == 1
    assert _dumps(env) == [] and not list(env.glob("*.partial"))


def test_retention_and_offsite_dir(env, monkeypatch, tmp_path):
    off = tmp_path / "off"
    monkeypatch.setenv("BACKUP_KEEP", "3")
    monkeypatch.setenv("BACKUP_OFFSITE", f"dir:{off}")
    env.mkdir(parents=True)
    (env / "notes.txt").write_text("giữ", encoding="utf-8")
    broken = env / "samsam_v36_20200101_000000_vn.dump.manifest.json"
    broken.write_text("{", encoding="utf-8")
    names = []
    for _ in range(4):
        assert bk.main() == 0
        names.append(_dumps(env)[-1])
    for d in (env, off):
        assert _dumps(d) == sorted(names[1:]), d
        ms = bk.valid_manifests(d)
        assert len(ms) == 3
        for _, _, m in ms:
            assert bk.sha256_file(d / m["file"]) == m["sha256"]
    assert names[0] not in _dumps(env)
    assert (env / "notes.txt").exists() and broken.exists()


def test_encrypted_backup_and_drill(env, monkeypatch, tmp_path, live):
    openssl = bk.find_openssl()
    assert openssl, "máy gate phải có openssl"
    pf = tmp_path / "pass.txt"
    pf.write_text("dung-passphrase-test\n", encoding="utf-8")
    monkeypatch.setenv("BACKUP_PASSPHRASE_FILE", str(pf))
    assert bk.main() == 0
    files = list(env.iterdir())
    assert not [p for p in files if p.name.endswith("_vn.dump")]
    for p in files:
        if p.is_file():
            assert p.read_bytes()[:5] != b"PGDMP", p.name
    (enc,) = [p for p in files if p.name.endswith(".dump.enc")]
    m = json.loads((env / (enc.name + bk.MANIFEST_SUFFIX))
                   .read_text(encoding="utf-8"))
    assert m["encrypted"] is True and m["cipher"] == bk.CIPHER
    assert bk.sha256_file(enc) == m["sha256"]
    out = tmp_path / "plain.dump"
    r = subprocess.run([openssl, *bk.OPENSSL_ENC, "-d", "-pass",
                        f"file:{pf}", "-in", str(enc), "-out", str(out)],
                       capture_output=True, timeout=60, check=False)
    assert r.returncode == 0 and out.read_bytes()[:5] == b"PGDMP"
    out.unlink()
    # Drill với đúng passphrase → ok, DB tạm bị drop.
    t1 = DRILL_PREFIX + "enc_ok"
    try:
        assert dr.main(["--target-db", t1]) == 0
        rec = _last(env / "drill_runs.jsonl")
        assert rec["status"] == "ok" and rec["dropped"] is True
        assert not _exists(live, t1)
        # Sai passphrase → exit 1, KHÔNG tạo DB.
        bad = tmp_path / "bad.txt"
        bad.write_text("sai-passphrase-khac-hoan-toan\n",
                       encoding="utf-8")
        monkeypatch.setenv("BACKUP_PASSPHRASE_FILE", str(bad))
        t2 = DRILL_PREFIX + "enc_bad"
        assert dr.main(["--target-db", t2]) == 1
        rec = _last(env / "drill_runs.jsonl")
        assert rec["status"] == "fail" and rec["dropped"] is None
        assert not _exists(live, t2)
        assert not list(env.glob("drill_*.partial"))
    finally:
        _drop(live, t1)
        _drop(live, DRILL_PREFIX + "enc_bad")


def test_offsite_s3_exit3_keeps_local(env, monkeypatch):
    monkeypatch.setenv("BACKUP_OFFSITE", "s3://b/p")
    assert bk.main() == 3
    assert len(_dumps(env)) == 1
    rec = _last(env / "backup_runs.jsonl")
    assert rec["status"] == "offsite_fail"
    assert "external-dep" in rec["error"]


def test_drill_ok_and_dropped(env, live, capsys):
    assert bk.main() == 0
    capsys.readouterr()
    assert dr.main([]) == 0
    out = capsys.readouterr().out
    assert f"{N_TABLES}/{N_TABLES} bảng khớp" in out and "RTO" in out
    rec = _last(env / "drill_runs.jsonl")
    assert rec["status"] == "ok" and rec["dropped"] is True
    assert rec["tables_checked"] == N_TABLES and rec["mismatches"] == {}
    assert isinstance(rec["rto_seconds"], float)
    assert not _exists(live, rec["drill_db"])


@pytest.mark.parametrize("target", ["samsam_v36", "postgres", "CURRENT"])
def test_drill_refuses_current_db(env, live, monkeypatch, target):
    assert bk.main() == 0
    if target == "CURRENT":
        target = psycopg.conninfo.conninfo_to_dict(live)["dbname"]
    before = _counts(live)
    calls = []
    monkeypatch.setattr(dr.subprocess, "run",
                        lambda *a, **k: calls.append(a) or 1 / 0)
    assert dr.main(["--target-db", target]) == 2
    assert calls == []  # pg_restore không được gọi
    assert _last(env / "drill_runs.jsonl")["status"] == "refused"
    assert _counts(live) == before


def test_drill_refuses_existing_drill_db(env, live):
    assert bk.main() == 0
    name = DRILL_PREFIX + "preexisting"
    _drop(live, name)
    with psycopg.connect(live, autocommit=True, connect_timeout=5) as c:
        c.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    try:
        assert dr.main(["--target-db", name]) == 2
        assert _exists(live, name)  # KHÔNG bị drop
        assert _last(env / "drill_runs.jsonl")["status"] == "refused"
    finally:
        _drop(live, name)
    assert not _exists(live, name)


def test_drill_corrupt_byte_fails_before_create(env, live):
    assert bk.main() == 0
    (dump,) = [env / n for n in _dumps(env)]
    b = bytearray(dump.read_bytes())
    b[len(b) // 2] ^= 0xFF
    dump.write_bytes(bytes(b))
    name = DRILL_PREFIX + "corrupt"
    assert dr.main(["--target-db", name]) == 1
    rec = _last(env / "drill_runs.jsonl")
    assert rec["status"] == "fail" and rec["dropped"] is None
    assert "sha256" in rec["error"]
    assert not _exists(live, name)


def test_drill_newest_broken_no_fallback(env, live):
    assert bk.main() == 0
    assert bk.main() == 0
    newest = bk.valid_manifests(env)[0][2]["file"]
    (env / newest).unlink()
    assert dr.main(["--target-db", DRILL_PREFIX + "nofallback"]) == 1
    rec = _last(env / "drill_runs.jsonl")
    assert rec["backup_file"] == newest and rec["status"] == "fail"
    assert not _exists(live, DRILL_PREFIX + "nofallback")


def test_drill_mismatch_still_drops(env, live):
    assert bk.main() == 0
    (mp,) = list(env.glob("*" + bk.MANIFEST_SUFFIX))
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["row_counts"]["products"] += 1
    mp.write_text(json.dumps(m), encoding="utf-8")
    name = DRILL_PREFIX + "mismatch"
    assert dr.main(["--target-db", name]) == 1
    rec = _last(env / "drill_runs.jsonl")
    assert rec["status"] == "mismatch" and rec["dropped"] is True
    assert list(rec["mismatches"]) == ["products"]
    assert not _exists(live, name)


def test_retention_error_does_not_block_offsite_or_log(env, monkeypatch,
                                                      tmp_path):
    """Xóa bản cũ lỗi (file bị khóa) → vẫn exit 0, offsite vẫn chạy,
    backup_runs vẫn có dòng, lỗi ghi ở `retention_error`."""
    off = tmp_path / "off"
    monkeypatch.setenv("BACKUP_KEEP", "1")
    monkeypatch.setenv("BACKUP_OFFSITE", f"dir:{off}")
    assert bk.main() == 0
    first = _dumps(env)
    real_unlink = Path.unlink

    def locked(self, missing_ok=False):
        if "_vn.dump" in self.name and not self.name.endswith(".partial"):
            raise PermissionError(13, "file đang bị khóa")
        return real_unlink(self, missing_ok=missing_ok)
    monkeypatch.setattr(Path, "unlink", locked)
    assert bk.main() == 0
    lines = (env / "backup_runs.jsonl").read_bytes().split(b"\n")
    assert len([x for x in lines if x]) == 2
    rec = _last(env / "backup_runs.jsonl")
    assert rec["status"] == "ok" and rec["offsite"] == "dir"
    assert "local" in rec["retention_error"]
    assert "offsite" in rec["retention_error"]
    assert "khóa" in rec["retention_error"]
    assert len(_dumps(env)) == 2 and first[0] in _dumps(env)
    assert _dumps(off) == _dumps(env)  # bản mới vẫn sang offsite
    for _, _, m in bk.valid_manifests(off):
        assert bk.sha256_file(off / m["file"]) == m["sha256"]


@pytest.mark.parametrize("stage", ["pg_dump", "openssl"])
def test_failure_after_partial_cleans_up(env, monkeypatch, tmp_path, stage):
    """Lỗi SAU khi `.partial` đã có dữ liệu (pg_dump/openssl exit≠0) → exit 1,
    không còn `.partial` (bản rõ có PII), không dump/manifest, nhật ký fail."""
    if stage == "openssl":
        pf = tmp_path / "pass.txt"
        pf.write_bytes(b"dung-passphrase-test-dai\n")
        monkeypatch.setenv("BACKUP_PASSPHRASE_FILE", str(pf))
    real_run = bk.subprocess.run
    seen = []

    def fake_run(argv, *a, **k):
        if stage == "pg_dump" and "-Fc" in argv:
            k["stdout"].write(b"PGDMP-du-lieu-dang-do")
            k["stdout"].flush()
            seen.append(Path(k["stdout"].name))
            assert seen[-1].exists() and seen[-1].stat().st_size > 0
            return subprocess.CompletedProcess(argv, 1, b"", b"boom")
        if stage == "openssl" and argv[1:2] == ["enc"]:
            out = Path(argv[argv.index("-out") + 1])
            out.write_bytes(b"Salted__dang-do")
            plain = Path(argv[argv.index("-in") + 1])
            assert plain.name.endswith(".partial")
            assert plain.read_bytes()[:5] == b"PGDMP"
            seen.extend([plain, out])
            return subprocess.CompletedProcess(argv, 1, b"", b"bad")
        return real_run(argv, *a, **k)
    monkeypatch.setattr(bk.subprocess, "run", fake_run)
    assert bk.main() == 1
    assert seen, "lỗi phải xảy ra SAU khi .partial đã tồn tại"
    for p in seen:
        assert not p.exists(), p.name
    assert not list(env.glob("*.partial"))
    assert _dumps(env) == []
    assert not list(env.glob("*" + bk.MANIFEST_SUFFIX))
    assert _last(env / "backup_runs.jsonl")["status"] == "fail"


@pytest.mark.parametrize("mode", ["oserror", "sha_mismatch"])
def test_offsite_dir_failure_exit3_keeps_local(env, monkeypatch, tmp_path,
                                               mode):
    off = tmp_path / "off"
    monkeypatch.setenv("BACKUP_OFFSITE", f"dir:{off}")

    def bad_copy(src, dst):
        Path(dst).write_bytes(b"ban-chep-hong")
        if mode == "oserror":
            raise OSError(28, "No space left on device")
        return dst
    monkeypatch.setattr(bk.shutil, "copyfile", bad_copy)
    assert bk.main() == 3
    rec = _last(env / "backup_runs.jsonl")
    assert rec["status"] == "offsite_fail" and rec["offsite"] is None
    (mp,) = list(env.glob("*" + bk.MANIFEST_SUFFIX))
    m = json.loads(mp.read_text(encoding="utf-8"))
    assert bk.sha256_file(env / m["file"]) == m["sha256"]  # local nguyên vẹn
    # Offsite không giữ bản hỏng mang tên thật, không `.partial` dở.
    assert _dumps(off) == [] and not list(off.glob("*.partial"))
    assert not list(off.glob("*" + bk.MANIFEST_SUFFIX))


def test_passphrase_without_openssl_fails_closed(env, monkeypatch, tmp_path):
    pf = tmp_path / "pass.txt"
    pf.write_bytes(b"dung-passphrase-test-dai\n")
    monkeypatch.setenv("BACKUP_PASSPHRASE_FILE", str(pf))
    monkeypatch.setattr(bk, "find_openssl", lambda: None)
    assert bk.main() == 1
    for p in env.iterdir():
        assert p.read_bytes()[:5] != b"PGDMP", p.name
    assert not list(env.glob("*.partial")) and _dumps(env) == []
    rec = _last(env / "backup_runs.jsonl")
    assert rec["status"] == "fail" and "openssl" in rec["error"]


def test_no_drill_db_left(live):
    """Chạy cuối file: không DB diễn tập nào do PHIÊN NÀY tạo còn sót (lọc
    theo RUN — DB của worktree khác chạy song song không tính)."""
    pattern = DRILL_PREFIX.replace("_", r"\_") + "%"
    with psycopg.connect(live, connect_timeout=5) as c:
        left = [r[0] for r in c.execute(
            "select datname from pg_database where datname like %s",
            (pattern,))]
    assert left == []
