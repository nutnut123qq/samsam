"""v3.10 — scripts/dr_drill.py (DR drill trên Postgres docker tạm).

Unit (không docker, `subprocess.run` giả): argv docker an toàn, external-dep
exit 3, dọn container khi lỗi/ngắt, cleanup_failed, RPO theo `now` tham số,
usage exit 2 trước docker.
E2E (docker + image postgres:<major>-alpine có sẵn + DB thật — gate yêu cầu
0 skipped): backup → dr_drill khớp 14 bảng, container bị dọn; manifest lệch
→ exit 1 và container VẪN bị dọn; server thật không bị đụng.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import db_backup as bk
import db_restore_drill as rd
import dr_drill as dd

NAME_RE = re.compile(r"^samsam-dr-\d{8}_\d{6}-[0-9a-f]{4}$")
CREATED = datetime(2026, 10, 11, 1, 30, tzinfo=bk.VN_TZ)
SCRIPT_VARS = ("BACKUP_DIR", "BACKUP_KEEP", "BACKUP_OFFSITE",
               "BACKUP_PASSPHRASE_FILE", "DRILL_DATABASE_URL", "PG_BIN",
               "DR_RPO_MAX_HOURS", "DR_READY_TIMEOUT_S")


@pytest.fixture
def clean_env(monkeypatch):
    """setenv "" (không delenv): main() gọi load_dotenv(.env thật) mà
    load_dotenv không ghi đè biến đã có — chặn BACKUP_* thật lấp vào."""
    for k in SCRIPT_VARS:
        monkeypatch.setenv(k, "")


def _last(path: Path) -> dict:
    return json.loads(path.read_bytes().split(b"\n")[-2])


# ---------------- unit ----------------

def test_rpo_seconds_pure():
    m = {"created_at": CREATED.isoformat()}
    assert dd.rpo_seconds(m, CREATED + timedelta(hours=30)) == 30 * 3600
    assert dd.rpo_seconds(m, CREATED) == 0
    with pytest.raises(ValueError):
        dd.rpo_seconds(m, datetime(2026, 10, 12))  # noqa: DTZ001


def _manifest(d: Path) -> Path:
    name = f"samsam_v36_{CREATED:%Y%m%d_%H%M%S}_vn.dump"
    (d / name).write_bytes(b"PGDMP")
    m = {"format": 1, "created_at": CREATED.isoformat(),
         "db_name": "samsam_v36", "server_version": "17.6",
         "pg_dump_version": "17", "tool": "x", "file": name,
         "size_bytes": 5, "sha256": "0", "encrypted": False, "cipher": None,
         "row_counts": {"products": 1}}
    p = d / (name + bk.MANIFEST_SUFFIX)
    p.write_text(json.dumps(m), encoding="utf-8")
    return p


class FakeDocker:
    """Giả `subprocess.run` cho lệnh docker; ghi lại argv + env."""

    def __init__(self, *, version_rc=0, image_rc=0, ps_after_rm="",
                 leftover=""):
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []
        self.version_rc, self.image_rc = version_rc, image_rc
        self.ps_after_rm, self.leftover = ps_after_rm, leftover
        self.removed = False
        self.image_vols = '{"/var/lib/postgresql/data":{}}'
        self.vols = ""          # volume gắn container (docker inspect)
        self.vol_left = False   # volume còn sau rm (giả lập rm thiếu -v)

    def __call__(self, argv, *a, **k):
        argv = list(argv)
        self.calls.append(argv)
        self.envs.append(k.get("env"))
        sub = argv[1:3]
        out, rc = "", 0
        if sub[0] == "version":
            rc, out = self.version_rc, "28.4.0"
        elif sub == ["image", "inspect"]:
            rc = self.image_rc
            if "-f" in argv:
                out = self.image_vols
        elif sub[0] == "inspect":
            rc, out = (1, "") if self.removed else (0, self.vols)
        elif sub == ["volume", "ls"]:
            out = self.vols if (self.vol_left or not self.removed) else ""
        elif sub[0] == "port":
            out = "127.0.0.1:55999\n"
        elif sub[0] == "rm":
            self.removed = True
        elif sub[0] == "ps":
            out = self.ps_after_rm if self.removed else self.leftover
        return subprocess.CompletedProcess(argv, rc, out.encode(), b"")

    def ops(self) -> list[str]:
        return [" ".join(c[1:3]) for c in self.calls]


@pytest.fixture
def unit(monkeypatch, tmp_path, clean_env):
    bdir = tmp_path / "bk"
    bdir.mkdir()
    _manifest(bdir)
    monkeypatch.setenv("BACKUP_DIR", str(bdir))
    monkeypatch.setattr(dd.shutil, "which", lambda n: "docker")
    monkeypatch.setattr(dd, "wait_ready", lambda dsn, t: None)
    seen = {}

    def fake_drill(args, bdir_, dsn, drill_server=None):
        seen["server"] = drill_server
        return 0, {"status": "ok", "rto_seconds": 1.5, "tables_checked": 1,
                   "mismatches": {}}
    monkeypatch.setattr(dd.rd, "run_drill", fake_drill)
    fake = FakeDocker()
    monkeypatch.setattr(dd.subprocess, "run", fake)
    return bdir, fake, seen


def test_docker_run_argv_safe(unit, capsys):
    bdir, fake, seen = unit
    assert dd.main([], now=CREATED + timedelta(hours=2)) == 0
    (run,) = [c for c in fake.calls if c[1] == "run"]
    env = fake.envs[fake.calls.index(run)]
    pw = env["POSTGRES_PASSWORD"]
    assert len(pw) >= 20
    for flag in ("--rm", "-d"):
        assert flag in run
    assert run[run.index("--pull") + 1] == "never"
    assert run[run.index("-p") + 1] == "127.0.0.1::5432"
    assert run[run.index("-e") + 1] == "POSTGRES_PASSWORD"
    assert not any("POSTGRES_PASSWORD=" in a for a in run)
    assert run[-1] == "postgres:17-alpine"
    # Data dir = tmpfs (RAM): không anonymous volume chứa dữ liệu khôi phục.
    assert run[run.index("--tmpfs") + 1] == "/var/lib/postgresql/data"
    name = run[run.index("--name") + 1]
    assert NAME_RE.match(name), name
    assert pw not in " ".join(run)
    assert "pull" not in fake.ops()
    # Chỉ docker run nhận env có mật khẩu.
    assert sum(1 for e in fake.envs if e and "POSTGRES_PASSWORD" in e) == 1
    assert "55999" in seen["server"] and pw in seen["server"]
    assert ["rm", "-f", "-v", name] == fake.calls[
        fake.ops().index("rm -f")][1:]
    body = (bdir / "dr_runs.jsonl").read_bytes().decode("utf-8")
    for secret in (pw, "55999", "postgresql://", "password"):
        assert secret not in body
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "ok" and rec["container"] == name
    assert rec["container_removed"] is True
    assert rec["rpo_seconds"] == 7200 and rec["rpo_max_hours"] == 24
    assert rec["restore_rto_seconds"] == 1.5
    assert set(rec) >= {"ts", "backup_file", "image", "rto_seconds",
                        "tables_checked", "mismatches"}
    out = capsys.readouterr().out
    assert "RTO" in out and "RPO 2.00h" in out and pw not in out


@pytest.mark.parametrize("mode", ["no_cli", "daemon_down", "no_image"])
def test_no_docker_exit3_no_run(unit, monkeypatch, capsys, mode):
    bdir, fake, _ = unit
    if mode == "no_cli":
        monkeypatch.setattr(dd.shutil, "which", lambda n: None)
    elif mode == "daemon_down":
        fake.version_rc = 1
    else:
        fake.image_rc = 1
    assert dd.main([], now=CREATED) == 3
    assert all(c[1] not in ("run", "pull", "rm") for c in fake.calls)
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "khong_chay" and rec["container"] is None
    assert "[external-dep]" in capsys.readouterr().out


@pytest.mark.parametrize("exc", [RuntimeError("boom"), KeyboardInterrupt(),
                                 ValueError("lạ")])
def test_cleanup_when_drill_raises(unit, monkeypatch, exc):
    bdir, fake, _ = unit

    def boom(*a, **k):
        raise exc
    monkeypatch.setattr(dd.rd, "run_drill", boom)
    if isinstance(exc, RuntimeError):
        assert dd.main([], now=CREATED) == 1
        assert _last(bdir / "dr_runs.jsonl")["status"] == "fail"
    else:
        with pytest.raises(type(exc)):
            dd.main([], now=CREATED)
    assert "rm -f" in fake.ops()


def test_cleanup_failed_alert(unit, monkeypatch, capsys):
    bdir, fake, _ = unit

    def ps_reports_name(argv, *a, **k):
        r = fake(argv, *a, **k)
        if argv[1] == "ps" and fake.removed:
            run = next(c for c in fake.calls if c[1] == "run")
            name = run[run.index("--name") + 1]
            return subprocess.CompletedProcess(argv, 0, name.encode() + b"\n",
                                               b"")
        return r
    monkeypatch.setattr(dd.subprocess, "run", ps_reports_name)
    assert dd.main([], now=CREATED) == 1
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "cleanup_failed"
    assert rec["container_removed"] is False
    assert "[ALERT] container DR" in capsys.readouterr().out


def test_cleanup_checks_container_volumes(unit, capsys):
    """Volume của container còn sau rm (rm thiếu -v / race --rm) = còn bản
    sao dữ liệu trên đĩa → cleanup_failed + ALERT nêu volume."""
    bdir, fake, _ = unit
    fake.vols, fake.vol_left = "anonvol123", True
    assert dd.main([], now=CREATED) == 1
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "cleanup_failed"
    assert rec["container_removed"] is False
    out = capsys.readouterr().out
    assert "anonvol123" in out and "docker volume rm" in out


def test_cleanup_volume_gone_ok(unit):
    bdir, fake, _ = unit
    fake.vols = "anonvol123"   # có volume nhưng rm -v đã xóa
    assert dd.main([], now=CREATED) == 0
    assert _last(bdir / "dr_runs.jsonl")["container_removed"] is True
    assert "volume ls" in fake.ops()


def test_image_volumes_fallback(unit):
    _, fake, _ = unit
    assert dd.image_volumes("postgres:17-alpine") == [
        "/var/lib/postgresql/data"]
    fake.image_vols = '{"/var/lib/postgresql":{}}'   # kiểu postgres:18
    assert dd.image_volumes("postgres:18-alpine") == ["/var/lib/postgresql"]
    for bad in ("", "null", "{}", "rác"):
        fake.image_vols = bad
        assert dd.image_volumes("x") == [dd.DEFAULT_PGDATA]
    fake.image_vols, fake.image_rc = '{"/a":{}}', 1
    assert dd.image_volumes("x") == [dd.DEFAULT_PGDATA]


def test_run_drill_restores_into_drill_server(tmp_path, monkeypatch,
                                              clean_env):
    """v3.6 run_drill(drill_server=X): MỌI kết nối + pg_restore đi tới X,
    không tới `dsn` (server thật) hay DRILL_DATABASE_URL."""
    from types import SimpleNamespace

    from psycopg.conninfo import conninfo_to_dict
    mp = _manifest(tmp_path)
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["sha256"] = bk.sha256_file(tmp_path / m["file"])
    mp.write_text(json.dumps(m), encoding="utf-8")
    monkeypatch.setenv("DRILL_DATABASE_URL",
                       "host=drillenv port=6001 user=u dbname=postgres")
    live = "host=livehost port=5433 user=u dbname=samsam_v36"
    drill = "host=127.0.0.1 port=55999 user=postgres password=pw dbname=postgres"
    hit: list[tuple] = []

    def rec(dsn):
        d = conninfo_to_dict(dsn)
        hit.append((d.get("host"), d.get("port")))

    class Conn:
        info = SimpleNamespace(server_version=170006)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, *a, **k):
            return self

    exists: set[str] = set()

    def db_exists(dsn, name):
        rec(dsn)
        return name in exists
    monkeypatch.setattr(rd, "db_exists", db_exists)
    monkeypatch.setattr(rd, "_admin", lambda dsn: rec(dsn) or Conn())
    monkeypatch.setattr(rd, "count_tables",
                        lambda dsn: rec(dsn) or {"products": 1})
    monkeypatch.setattr(rd.bk, "resolve_tool",
                        lambda n, major, env: (("native", "pg_restore"), "17"))
    envs = []

    def run(argv, *a, **k):
        envs.append(k["env"])
        return subprocess.CompletedProcess(argv, 0, b"", b"")
    monkeypatch.setattr(rd.subprocess, "run", run)
    code, r = rd.run_drill(SimpleNamespace(backup=None, target_db=None),
                           tmp_path, live, drill_server=drill)
    assert code == 0 and r["status"] == "ok", r
    assert hit and set(hit) == {("127.0.0.1", "55999")}, hit
    assert [(e.get("PGHOST"), e.get("PGPORT")) for e in envs] == [
        ("127.0.0.1", "55999")]
    assert envs[0]["PGDATABASE"] == r["drill_db"]


def test_rpo_breach_exit1(unit):
    bdir, _, _ = unit
    assert dd.main([], now=CREATED + timedelta(hours=30)) == 1
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "rpo_breach" and rec["rpo_seconds"] == 108000
    assert rec["container_removed"] is True


def test_rpo_max_env_respected(unit, monkeypatch):
    bdir, _, _ = unit
    monkeypatch.setenv("DR_RPO_MAX_HOURS", "36")
    assert dd.main([], now=CREATED + timedelta(hours=30)) == 0
    assert _last(bdir / "dr_runs.jsonl")["rpo_max_hours"] == 36


@pytest.mark.parametrize("var,val", [
    ("DR_RPO_MAX_HOURS", "0"), ("DR_RPO_MAX_HOURS", "-1"),
    ("DR_RPO_MAX_HOURS", "abc"), ("DR_RPO_MAX_HOURS", "nan"),
    ("DR_RPO_MAX_HOURS", "inf"), ("DR_READY_TIMEOUT_S", "0"),
])
def test_usage_exit2_before_docker(unit, monkeypatch, var, val):
    bdir, fake, _ = unit
    monkeypatch.setenv(var, val)
    assert dd.main([], now=CREATED) == 2
    assert fake.calls == []
    assert not (bdir / "dr_runs.jsonl").exists()


def test_backup_dir_inside_repo_exit2(unit, monkeypatch):
    _, fake, _ = unit
    monkeypatch.setenv("BACKUP_DIR", str(ROOT / "backups"))
    assert dd.main([], now=CREATED) == 2
    assert fake.calls == [] and not (ROOT / "backups").exists()


def test_leftover_warned_not_removed(unit, capsys):
    _, fake, _ = unit
    fake.leftover = "samsam-dr-20260101_000000-abcd\nother\n"
    assert dd.main([], now=CREATED) == 0
    out = capsys.readouterr().out
    assert "[warn]" in out and "samsam-dr-20260101_000000-abcd" in out
    rms = [c for c in fake.calls if c[1] == "rm"]
    assert len(rms) == 1 and "samsam-dr-20260101_000000-abcd" not in rms[0]


def test_run_drill_backward_compatible_signature():
    import inspect
    sig = inspect.signature(rd.run_drill)
    assert list(sig.parameters) == ["args", "bdir", "dsn", "drill_server"]
    assert sig.parameters["drill_server"].default is None


# ---------------- E2E docker thật ----------------

def _docker_names(prefix="samsam-dr-") -> list[str]:
    r = subprocess.run(["docker", "ps", "-a", "--filter", f"name={prefix}",
                        "--format", "{{.Names}}"], capture_output=True,
                       timeout=30, check=False)
    return [n for n in r.stdout.decode().split() if n.startswith(prefix)]


@pytest.fixture(scope="module")
def live():
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
    if not shutil.which("docker") or dd.probe_docker(
            f"postgres:{major}-alpine"):
        pytest.skip("không có docker/image postgres:<major>-alpine")
    return dsn


def _counts(dsn):
    with psycopg.connect(dsn, connect_timeout=5) as c:
        return bk._snapshot_counts(c)


def _hp(params: dict) -> tuple[str, str]:
    return (params.get("host") or "localhost", str(params.get("port") or 5432))


@pytest.fixture
def env(monkeypatch, tmp_path, live, clean_env):
    monkeypatch.setenv("DATABASE_URL", live)
    bdir = tmp_path / "bk"
    monkeypatch.setenv("BACKUP_DIR", str(bdir))
    pws = []
    real_run = subprocess.run

    def spy(argv, *a, **k):
        e = k.get("env")
        if e and "POSTGRES_PASSWORD" in e:
            pws.append(e["POSTGRES_PASSWORD"])
        return real_run(argv, *a, **k)
    monkeypatch.setattr(dd.subprocess, "run", spy)
    assert bk.main() == 0
    return bdir, pws


@pytest.fixture
def trace(monkeypatch, env):
    """Spy SAU backup: mọi psycopg.connect, env pg_restore, cổng container,
    tên DB drill, volume container — để chứng minh khôi phục vào container
    chứ không vào server thật (mutation bỏ qua drill_server phải đỏ)."""
    t = {"connects": [], "restores": [], "ports": [], "targets": [],
         "vols": []}
    real_connect = psycopg.connect
    real_run = subprocess.run   # đã là spy của fixture env

    def connect(conninfo="", **kw):
        d = psycopg.conninfo.conninfo_to_dict(conninfo)
        d.update({k: kw[k] for k in ("host", "port", "dbname") if k in kw})
        t["connects"].append((*_hp(d), d.get("dbname")))
        return real_connect(conninfo, **kw)

    def run(argv, *a, **k):
        e = k.get("env") or {}
        if "PGDATABASE" in e:
            t["restores"].append((e.get("PGHOST"), e.get("PGPORT"),
                                  e["PGDATABASE"]))
        return real_run(argv, *a, **k)

    def wrap(fn, key):
        def w(*a, **k):
            v = fn(*a, **k)
            t[key].append(v)
            return v
        return w
    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(dd, "host_port", wrap(dd.host_port, "ports"))
    monkeypatch.setattr(rd, "default_target",
                        wrap(rd.default_target, "targets"))
    monkeypatch.setattr(dd, "container_volumes",
                        wrap(dd.container_volumes, "vols"))
    return t


def _assert_restored_into_container(t: dict, live: str):
    (cport,) = t["ports"]
    (target,) = t["targets"]
    cont = ("127.0.0.1", str(cport))
    assert _hp(psycopg.conninfo.conninfo_to_dict(live)) != cont
    assert t["connects"], "không bắt được kết nối nào"
    bad = [c for c in t["connects"] if c[:2] != cont]
    assert not bad, f"kết nối ra ngoài container: {bad}"
    assert any(c[2] == target for c in t["connects"])
    # pg_restore --version + restore: cùng env PG* → cùng container.
    assert t["restores"] and set(t["restores"]) == {(*cont, target)}
    return target


def _assert_no_volume_left(t: dict):
    # tmpfs → docker run không sinh volume; nếu có thì phải đã bị xóa.
    assert t["vols"] and t["vols"][0] == set(), t["vols"]
    seen = set().union(*t["vols"])
    if seen:
        r = subprocess.run(["docker", "volume", "ls", "-q"],
                           capture_output=True, timeout=30, check=False)
        assert not seen & set(r.stdout.decode().split())


def _no_secrets(bdir: Path, live: str, pws: list[str]):
    body = (bdir / "dr_runs.jsonl").read_bytes().decode("utf-8")
    assert pws and all(p not in body for p in pws)
    live_pw = psycopg.conninfo.conninfo_to_dict(live).get("password")
    if live_pw:
        assert live_pw not in body
    assert "postgresql://" not in body and live not in body


def test_dr_drill_real_ok(env, live, trace, capsys):
    bdir, pws = env
    before = _counts(live)
    trace["connects"].clear()
    capsys.readouterr()
    assert dd.main([]) == 0
    out = capsys.readouterr().out
    assert "14/14 bảng khớp" in out and "RTO" in out and "RPO" in out
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "ok" and rec["container_removed"] is True
    assert rec["tables_checked"] == 14 and rec["mismatches"] == {}
    assert rec["rto_seconds"] >= rec["restore_rto_seconds"] > 0
    assert 0 <= rec["rpo_seconds"] < 3600
    assert rec["container"] not in _docker_names()
    _no_secrets(bdir, live, pws)
    _assert_no_volume_left(trace)
    # Khôi phục vào container (cổng `docker port`), KHÔNG vào server thật;
    # chỉ kiểm DB drill của CHÍNH lần chạy này (pg_database là cluster-wide
    # — worktree khác chạy song song tạo samsam_drill_test_* hợp lệ).
    target = _assert_restored_into_container(trace, live)
    assert not rd.db_exists(live, target)
    assert _counts(live) == before


def test_dr_drill_real_mismatch_still_cleans(env, live, trace):
    bdir, pws = env
    trace["connects"].clear()
    (mp,) = list(bdir.glob("*" + bk.MANIFEST_SUFFIX))
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["row_counts"]["products"] += 1
    mp.write_text(json.dumps(m), encoding="utf-8")
    assert dd.main([]) == 1
    rec = _last(bdir / "dr_runs.jsonl")
    assert rec["status"] == "mismatch" and list(rec["mismatches"]) == [
        "products"]
    assert rec["container_removed"] is True
    assert rec["container"] not in _docker_names()
    _no_secrets(bdir, live, pws)
    _assert_no_volume_left(trace)
    _assert_restored_into_container(trace, live)


def test_zz_no_dr_container_left(live):
    """Chạy cuối file: 0 container samsam-dr-* còn lại."""
    assert _docker_names() == []
