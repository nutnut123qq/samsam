"""v3.7 W37.1 — job_run context manager ghi job_runs (fake conn, không DB thật)."""
import re

import psycopg
import pytest

from pipelines import job_runs


class FakeConn:
    def __init__(self, fail_insert=False):
        self.calls, self.committed, self.closed = [], False, False
        self.fail_insert = fail_insert

    def execute(self, sql, params=None):
        if self.fail_insert:
            raise psycopg.errors.UndefinedTable("job_runs không tồn tại")
        self.calls.append((sql, params))
        return self

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


@pytest.fixture
def fake(monkeypatch):
    conn = FakeConn()
    seen = {}

    def _connect(dsn, **kw):
        seen.update(kw)
        return conn

    monkeypatch.setenv("DATABASE_URL", "postgresql://u@fake-host/x")
    monkeypatch.setattr(job_runs.psycopg, "connect", _connect)
    conn.kw = seen
    return conn


def _row(conn):
    assert len(conn.calls) == 1, conn.calls
    sql, params = conn.calls[0]
    assert sql.startswith("insert into job_runs")
    job, started, finished, ok, detail, host = params
    return {"job": job, "started": started, "finished": finished, "ok": ok,
            "detail": detail, "host": host}


def test_ok_body_inserts_one_row(fake):
    with job_runs.job_run("agents.report") as run:
        run["x"] = 1
    r = _row(fake)
    assert r["job"] == "agents.report" and r["ok"] is True
    assert r["detail"] is None
    assert r["started"].tzinfo is not None
    assert r["finished"] >= r["started"]
    assert r["host"]
    assert fake.committed and fake.closed
    assert fake.kw.get("connect_timeout") == job_runs.CONNECT_TIMEOUT_S


def test_exception_reraised_detail_masked(fake):
    with (pytest.raises(ValueError, match="0905123456"),
          job_runs.job_run("ingest.lead_store")):
        raise ValueError("gọi 0905123456 " + "x" * 500)
    r = _row(fake)
    assert r["ok"] is False
    assert r["detail"].startswith("ValueError: ")
    assert not re.search(r"0\d{9}", r["detail"])
    assert len(r["detail"]) <= 300


def test_detail_hides_dsn(fake):
    with pytest.raises(RuntimeError), job_runs.job_run("x"):
        raise RuntimeError("fail postgresql://user:pw1@db:5432/samsam key "
                           "sk-or-v1-abcdef123456 Authorization: Bearer tok99")
    d = _row(fake)["detail"]
    assert "pw1" not in d and "abcdef123456" not in d and "tok99" not in d
    assert d.startswith("RuntimeError: fail <secret>")


def test_body_marks_not_ok(fake):
    rc = 1
    with job_runs.job_run("agents.report") as run:
        run["ok"] = rc == 0
    assert _row(fake)["ok"] is False


@pytest.mark.parametrize("code,ok", [(0, True), (None, True), (2, False),
                                     ("boom", False)])
def test_system_exit(fake, code, ok):
    with pytest.raises(SystemExit), job_runs.job_run("x"):
        raise SystemExit(code)
    assert _row(fake)["ok"] is ok


def test_connect_error_job_still_runs(monkeypatch, capsys):
    def _boom(dsn, **kw):
        raise psycopg.OperationalError("timeout postgresql://u:pw@h/x")

    monkeypatch.setenv("DATABASE_URL", "postgresql://u:pw@h/x")
    monkeypatch.setattr(job_runs.psycopg, "connect", _boom)

    def body():
        with job_runs.job_run("x") as run:
            run["ok"] = True
            return 42

    assert body() == 42
    out = capsys.readouterr().out
    assert "[job-runs]" in out and "OperationalError" in out
    assert "pw@" not in out and "postgresql://" not in out


def test_insert_error_and_missing_dsn_warn(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@fake-host/x")
    conn = FakeConn(fail_insert=True)
    monkeypatch.setattr(job_runs.psycopg, "connect", lambda d, **k: conn)
    with job_runs.job_run("x"):
        pass
    assert conn.closed
    assert "UndefinedTable" in capsys.readouterr().out

    monkeypatch.delenv("DATABASE_URL")
    with job_runs.job_run("x"):
        pass
    assert "không có DATABASE_URL" in capsys.readouterr().out


def test_schema_has_job_runs():
    src = (job_runs.ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    assert "create table if not exists job_runs" in src
    assert "create index if not exists job_runs_job_started_idx" in src


@pytest.mark.parametrize("path", ["agents/report.py", "ingest/lead_store.py"])
def test_main_blocks_wrapped(path):
    """W37.2: job lịch bọc job_run đúng ở khối __main__, giữ exit code."""
    src = (job_runs.ROOT / path).read_text(encoding="utf-8")
    block = src.split('if __name__ == "__main__":', 1)[1]
    job = path[:-3].replace("/", ".")
    assert f'with job_run("{job}") as run:' in block
    assert 'run["ok"] = rc == 0' in block and "raise SystemExit(rc)" in block


def test_clean_detail_precut_before_regex(monkeypatch):
    """DoS: regex chỉ chạy trên ≤PRE_MAX ký tự (spy độ dài, không đo giờ)."""
    seen = []
    real_sub, real_mask = job_runs._SECRET_RE.sub, job_runs._mask_pii

    class _Spy:
        def sub(self, repl, s):
            seen.append(len(s))
            return real_sub(repl, s)

    monkeypatch.setattr(job_runs, "_SECRET_RE", _Spy())
    monkeypatch.setattr(job_runs, "_mask_pii",
                        lambda s: (seen.append(len(s)), real_mask(s))[1])
    out = job_runs.clean_detail("a." * 50000)
    assert len(out) <= job_runs.DETAIL_MAX
    assert seen and max(seen) <= job_runs.PRE_MAX


def test_clean_detail_pathological_returns():
    """Không spy — regex thật trên input bệnh lý; chậm bậc 2 = test treo."""
    for s in ("a." * 50000, "a+" * 50000, "(" * 100000, " " * 5000):
        assert len(job_runs.clean_detail(s)) <= job_runs.DETAIL_MAX


def test_clean_detail_cut_edge_no_partial_phone():
    """Mask URL dài làm chuỗi ngắn lại → mép cắt PRE_MAX lọt vào 300 ký tự:
    SĐT bị cắt dở (chưa đủ 9 số, regex PII không bắt) không được lộ."""
    pre = "fail postgresql://u:pw@h/" + "x" * (job_runs.PRE_MAX - 37)
    s = pre + " goi 0905 123 456 tiep"
    assert len(pre) + 9 < job_runs.PRE_MAX < len(pre) + 15  # cắt giữa SĐT
    out = job_runs.clean_detail(s)
    assert "<secret>" in out and "pw" not in out
    assert not re.search(r"\d", out), out


def test_clean_detail_masks_libpq_password():
    d = job_runs.clean_detail("connect host=db user=samsam password=S3cretPw dbname=x")
    assert "S3cretPw" not in d
