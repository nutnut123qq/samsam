"""v3.7 W37.3/W37.4 — bản tin sức khỏe (hàm thuần + fake conn, không DB/mạng)."""
import importlib.util
import ssl
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg
import pytest

from pipelines import llm_gateway

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "health_bulletin", ROOT / "scripts" / "health_bulletin.py")
hb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hb)

CAPS = {"default": 5.0, "chatbot": 20.0, "smoke": 0.0}
HEADINGS = (hb.H_DB, hb.H_JOBS, hb.H_COST, hb.H_ERR, hb.H_QUEUE)


def _label(rows, agent):
    return next(r for r in rows if r[0] == agent)[4]


@pytest.mark.parametrize("ratio,label", [(0.79, "OK"), (0.80, "CẢNH BÁO"),
                                         (0.99, "CẢNH BÁO"),
                                         (1.0, "ĐÃ CHẶN (gateway)"),
                                         (1.5, "ĐÃ CHẶN (gateway)")])
def test_cost_rows_thresholds(ratio, label):
    rows = hb.cost_rows({"chatbot": ratio * 20.0}, CAPS)
    assert _label(rows, "chatbot") == label


def test_cost_rows_default_cap_and_zero_cap():
    rows = hb.cost_rows({"newagent": 4.0, "smoke": 0.3}, CAPS)
    a = next(r for r in rows if r[0] == "newagent")
    assert a[2] == 5.0 and a[4] == "CẢNH BÁO" and round(a[3]) == 80
    s = next(r for r in rows if r[0] == "smoke")
    # cap 0: gateway chặn mọi lời gọi (spend 0 >= 0) -> nhãn "ĐÃ CHẶN"
    assert s[3] is None and s[4].startswith("ĐÃ CHẶN")  # không chia 0
    # agent có cap riêng nhưng chưa dùng vẫn hiện, không gồm key default
    assert _label(rows, "chatbot") == "OK"
    assert all(r[0] != "default" for r in rows)


def test_month_start_matches_gateway():
    """Drift-guard: cùng mốc tháng giờ VN với _SPEND_SQL của gateway."""
    assert hb.MONTH_START_SQL in llm_gateway._SPEND_SQL


def test_warn_ratio_from_gateway():
    assert hb.WARN_RATIO is llm_gateway.WARN_RATIO


def test_late_jobs():
    late = {j: (h, lim) for j, h, lim in hb.late_jobs(
        {"ingest.lead_store": 30.0, "agents.report": 100.0})}
    assert late == {"ingest.lead_store": (30.0, 24)}
    assert {j for j, _, _ in hb.late_jobs({})} == set(hb.EXPECTED_JOBS)


def _data():
    ts = datetime(2026, 10, 10, 1, 0, tzinfo=timezone.utc)
    return {
        "db_ok": True,
        "jobs": {"counts": [("agents.report", 1, 0),
                            ("ingest.lead_store", 0, 1)],
                 "failed": [("ingest.lead_store", ts,
                             ("OperationalError: gọi 0905123456 | x\ny "
                              "postgresql://u:pw9@h/x"))],
                 "last_ok_hours": {"agents.report": 2.0}},
        "spend": {"chatbot": 16.0, "content": 1.0},
        "llm_errors": [("chatbot", 3)],
        "pending": 7,
    }


def test_render_all_sections():
    md = hb.render(_data(), date(2026, 10, 11), CAPS)
    pos = [md.index(h) for h in HEADINGS]
    assert pos == sorted(pos)
    assert "DB: sống" in md
    assert "| agents.report | 1 | 0 |" in md
    assert "KHÔNG CHẠY/TRỄ `ingest.lead_store` — chưa có lần OK nào" in md
    assert "0905123456" not in md and "x y" in md  # mask + không vỡ bảng
    assert "pw9" not in md and "x y <secret>" in md
    assert "08:00" in md  # 01:00 UTC → 08:00 giờ VN
    assert "| chatbot | 16.0000 | 20.00 | 80% | CẢNH BÁO |" in md
    assert "Tổng: 3" in md and "Draft chờ duyệt: 7" in md
    for table in ("job_runs", "llm_usage", "content_drafts"):
        assert f"`{table}`" in md  # mục ghi bảng nguồn


def test_render_missing_table_other_sections_ok():
    d = _data()
    d["jobs"] = hb.MISSING
    d["pending"] = {"error": "InsufficientPrivilege"}
    md = hb.render(d, date(2026, 10, 11), CAPS)
    assert "chưa có bảng `job_runs` — chạy `python scripts/apply_schema.py`" \
        in md
    assert "lỗi đọc `content_drafts` (InsufficientPrivilege)" in md
    assert "CẢNH BÁO" in md and "Tổng: 3" in md


def test_render_cap_error():
    md = hb.render(_data(), date(2026, 10, 11), None, "GatewayError")
    assert "không đọc được trần chi phí (GatewayError)" in md


class _Res:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0]


class FakeConn:
    """Trả kết quả theo bảng trong SQL; bảng trong `missing` → UndefinedTable.

    Mô phỏng psycopg thật: KHÔNG autocommit thì lỗi đầu tiên làm transaction
    aborted → mọi câu sau raise InFailedSqlTransaction (fake không mô phỏng
    điều này = pass-ảo, gotcha v2.1)."""

    def __init__(self, missing=(), autocommit=True):
        self.missing, self.closed = set(missing), False
        self.autocommit, self.aborted = autocommit, False

    def execute(self, sql, params=None):
        if self.aborted:
            raise psycopg.errors.InFailedSqlTransaction("aborted")
        for t in self.missing:
            if f"from {t}" in sql:
                self.aborted = not self.autocommit
                raise psycopg.errors.UndefinedTable(t)
        if "from job_runs" in sql:
            if "extract(epoch" in sql:
                return _Res([("agents.report", 5.0)])
            if "detail" in sql:
                return _Res([])
            return _Res([("agents.report", 1, 0)])
        if "sum(cost_usd)" in sql:
            assert hb.MONTH_START_SQL in sql
            return _Res([("chatbot", 1.5)])
        if "from llm_usage" in sql:
            return _Res([("content", 2)])
        if "from content_drafts" in sql:
            return _Res([(4,)])
        raise AssertionError(sql)

    def close(self):
        self.closed = True


def test_collect_fake_conn_missing_table():
    data = hb.collect(FakeConn(missing={"job_runs"}))
    assert data["jobs"] == hb.MISSING
    assert data["spend"] == {"chatbot": 1.5}
    assert data["llm_errors"] == [("content", 2)]
    assert data["pending"] == 4


def test_gather_missing_table_needs_autocommit(monkeypatch):
    """gather() phải mở conn autocommit — thiếu `job_runs` chỉ hỏng mục đó.
    Bỏ autocommit=True → FakeConn aborted → 3 mục sau thành lỗi đọc."""
    conns = []

    def _connect(dsn, **kw):
        conns.append(FakeConn(missing={"job_runs"},
                              autocommit=kw.get("autocommit", False)))
        return conns[-1]

    monkeypatch.setenv("DATABASE_URL", "postgresql://u@fake-host/x")
    monkeypatch.setattr(hb.psycopg, "connect", _connect)
    data = hb.gather()
    assert data["jobs"] == hb.MISSING
    assert data["spend"] == {"chatbot": 1.5}
    assert data["llm_errors"] == [("content", 2)]
    assert data["pending"] == 4
    assert conns[0].closed


@pytest.fixture
def no_net(monkeypatch):
    """Mọi lời gọi mạng ghi vào `calls`; DB fake."""
    calls = []

    class FakeSMTP:
        def __init__(self, *a, **k):
            calls.append(("smtp", a, k))

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def starttls(self, context=None):
            calls.append(("starttls", context))

        def login(self, *a):
            calls.append(("login",))

        def send_message(self, msg):
            calls.append(("send", msg.get_content()))

    def fake_urlopen(url, data=None, timeout=None):
        calls.append(("urlopen", url, data, timeout))

        class _R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        return _R()

    monkeypatch.setattr(hb.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(hb.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@fake-host/x")
    monkeypatch.setattr(hb.psycopg, "connect", lambda *a, **k: FakeConn(
        autocommit=k.get("autocommit", False)))
    for k in ("HEALTH_NOTIFY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
              "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "HEALTH_MAIL_TO"):
        monkeypatch.delenv(k, raising=False)
    return calls


def test_main_db_down_still_writes(monkeypatch, tmp_path, capsys, no_net):
    seen = {}

    def _boom(*a, **k):
        seen.update(k)
        raise psycopg.OperationalError("timeout expired")

    monkeypatch.setattr(hb.psycopg, "connect", _boom)
    assert hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-11"]) == 0
    out = capsys.readouterr().out
    md = (tmp_path / "health-2026-10-11.md").read_text(encoding="utf-8")
    assert "DB không truy cập được" in md and "DB không truy cập được" in out
    assert "OperationalError" in md and "fake-host" not in md
    assert all(h in md for h in HEADINGS)
    assert seen.get("connect_timeout") == hb.CONNECT_TIMEOUT_S
    assert seen.get("autocommit") is True  # mục thiếu bảng không kéo mục khác
    assert no_net == []


def test_main_missing_dsn(monkeypatch, tmp_path, no_net):
    monkeypatch.delenv("DATABASE_URL")
    assert hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-11"]) == 0
    assert "thiếu DATABASE_URL" in (tmp_path / "health-2026-10-11.md") \
        .read_text(encoding="utf-8")


def test_main_bad_date(tmp_path, no_net):
    with pytest.raises(SystemExit) as e:
        hb.main(["--out-dir", str(tmp_path), "--date", "../../x"])
    assert e.value.code == 2
    assert list(tmp_path.iterdir()) == []


def test_no_notify_flag_no_network(monkeypatch, tmp_path, capsys, no_net):
    monkeypatch.setenv("HEALTH_NOTIFY", "telegram")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:SECRETTOKEN")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    assert hb.main(["--out-dir", str(tmp_path)]) == 0
    assert no_net == []
    assert "[notify] bỏ qua" in capsys.readouterr().out


def test_notify_unconfigured_no_network(tmp_path, capsys, no_net):
    assert hb.main(["--out-dir", str(tmp_path), "--notify"]) == 0
    assert no_net == []
    assert "[notify] bỏ qua (chưa cấu hình)" in capsys.readouterr().out


def test_notify_telegram_one_call(monkeypatch, tmp_path, capsys, no_net):
    monkeypatch.setenv("HEALTH_NOTIFY", "telegram")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:SECRETTOKEN")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    assert hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-11",
                    "--notify"]) == 0
    assert len(no_net) == 1 and no_net[0][0] == "urlopen"
    _, url, data, timeout = no_net[0]
    assert "SECRETTOKEN" in url and timeout == hb.NOTIFY_TIMEOUT_S
    from urllib.parse import parse_qs
    sent = parse_qs(data.decode())["text"][0]
    md = (tmp_path / "health-2026-10-11.md").read_text(encoding="utf-8")
    assert sent == md[:hb.TELEGRAM_MAX]
    out = capsys.readouterr().out
    assert "SECRETTOKEN" not in out and "api.telegram.org" not in out


def test_notify_email(monkeypatch, no_net):
    monkeypatch.setenv("HEALTH_NOTIFY", "email")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("SMTP_USER", "bot@example.test")
    monkeypatch.setenv("SMTP_PASSWORD", "pw-secret")
    monkeypatch.setenv("HEALTH_MAIL_TO", "ops@example.test")
    assert hb.notify("bản tin") == "sent"
    kinds = [c[0] for c in no_net]
    assert kinds == ["smtp", "starttls", "login", "send"]
    ctx = no_net[1][1]  # starttls() trần không verify server → MITM lộ mật khẩu
    assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True
    assert no_net[-1][1].strip() == "bản tin"


def test_notify_error_exit_0(monkeypatch, tmp_path, capsys, no_net):
    def _boom(*a, **k):
        raise OSError("network down api.telegram.org/bot123:SECRETTOKEN")

    monkeypatch.setattr(hb.urllib.request, "urlopen", _boom)
    monkeypatch.setenv("HEALTH_NOTIFY", "telegram")
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:SECRETTOKEN")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    assert hb.main(["--out-dir", str(tmp_path), "--notify"]) == 0
    out = capsys.readouterr().out
    assert "[notify] gửi lỗi (OSError)" in out and "SECRETTOKEN" not in out
