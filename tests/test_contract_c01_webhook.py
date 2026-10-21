"""Đợt hợp đồng C01 — sales-01 webhook 24/7: unit systemd, env mẫu ngoài
repo, `/readyz`, job `webhook_health` (scripts/webhook_probe.py).

Smoke khởi động THẬT tiến trình webhook qua wrapper: state (convlog/dedup/
token) trỏ `tmp_path` — không động `data/` của máy dev. Có cấu hình 24/7 ≠
đã vận hành 24/7 (bằng chứng vận hành chỉ có trên server Bên B)."""

import http.server
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
UNITS = ROOT / "deploy" / "onprem" / "systemd"
DEAD_DSN = "postgresql://u@10.255.255.1:1/khong_ton_tai"

_spec = importlib.util.spec_from_file_location(
    "webhook_probe", ROOT / "scripts" / "webhook_probe.py")
wp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wp)


def _unit(name):
    return (UNITS / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name,mod", [
    ("samsam-webhook-zalo.service", "connectors.zalo"),
    ("samsam-webhook-messenger.service", "connectors.messenger")])
def test_units_drift(name, mod):
    u = _unit(name)
    assert re.search(rf"^ExecStart=\S+ -m {re.escape(mod)}$", u, re.MULTILINE)
    assert (ROOT / (mod.replace(".", "/") + ".py")).is_file()
    for k in ("Restart=always", "RestartSec=", "StartLimitBurst=",
              "EnvironmentFile=/etc/samsam/webhook.env", "User=",
              "NoNewPrivileges=yes", "WantedBy=multi-user.target"):
        assert k in u, (name, k)
    assert "User=root" not in u
    # không secret/DSN trong unit
    assert not re.search(r"postgres(ql)?://|SECRET=|TOKEN=", u)


def test_env_example_names_only():
    t = (ROOT / "deploy" / "onprem" / "webhook-env.example").read_text(
        encoding="utf-8")
    keys = dict(ln.split("=", 1) for ln in t.splitlines()
                if ln and not ln.startswith("#"))
    for k in ("WEBHOOK_DATABASE_URL", "ZALO_OA_SECRET", "MESSENGER_APP_SECRET",
              "MESSENGER_PAGE_TOKEN", "MESSENGER_VERIFY_TOKEN",
              "CHANNEL_HASH_SALT", "DEPLOY"):
        assert k in keys
    secrets_ = {k: v for k, v in keys.items() if not k.endswith("_PORT")}
    assert all(v == "" for v in secrets_.values())


def test_health_job_and_timer():
    jobs = json.loads((ROOT / "deploy" / "onprem" / "jobs.json").read_text(
        encoding="utf-8"))["jobs"]
    j = jobs["webhook_health"]
    assert j["steps"] == [["scripts/webhook_probe.py"]]
    assert "OnCalendar=*-*-* *:00/5:00" in _unit(
        "samsam-job-webhook_health.timer")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wrapper(tmp_path, mod):
    w = tmp_path / "run_wh.py"
    w.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(ROOT)!r})\n"
        "from pathlib import Path\n"
        "from connectors import zalo\n"
        f"t = Path({str(tmp_path)!r})\n"
        "zalo.CONV_LOG = t / 'c.jsonl'\n"
        "zalo.SEEN_DB = t / 'seen.db'\n"
        "zalo.TOKEN_STORE = t / 'tok.json'\n"
        f"import {mod} as m\n"
        "r = m.main()\n"
        "sys.exit(r or 0)\n", encoding="utf-8")
    return w


def _start(tmp_path, mod, port_var, extra):
    port = _free_port()
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("ZALO_", "MESSENGER_")) and k != "DEPLOY"}
    env.update({port_var: str(port), "PYTHONIOENCODING": "utf-8"}, **extra)
    p = subprocess.Popen([sys.executable, str(_wrapper(tmp_path, mod))],
                         env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8")
    return p, port


def _get(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}",
                                    timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _wait_up(p, port, deadline=30):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if p.poll() is not None:
            return False
        try:
            if _get(port, "/healthz")[0] == 200:
                return True
        except OSError:
            time.sleep(0.2)
    return False


@pytest.mark.parametrize("mod,port_var", [
    ("connectors.zalo", "ZALO_WEBHOOK_PORT"),
    ("connectors.messenger", "MESSENGER_WEBHOOK_PORT")])
def test_smoke_ready_and_db_down(tmp_path, mod, port_var):
    dsn = os.environ.get("DATABASE_URL")
    for d, want in (([dsn, 200] if dsn else [None, None]),
                    [DEAD_DSN, 503]):
        if d is None:
            continue
        p, port = _start(tmp_path, mod, port_var, {"DATABASE_URL": d})
        try:
            assert _wait_up(p, port), "webhook không lên"
            code, body = _get(port, "/readyz")
            assert code == want, body
            assert body["checks"]["config"] == "ok"
            assert body["checks"]["db"] == ("ok" if want == 200 else "loi")
            assert "postgres" not in json.dumps(body)
        finally:
            p.kill()
            p.communicate(timeout=10)


@pytest.mark.parametrize("mod,port_var", [
    ("connectors.zalo", "ZALO_WEBHOOK_PORT"),
    ("connectors.messenger", "MESSENGER_WEBHOOK_PORT")])
def test_config_error_exits_nonzero(tmp_path, mod, port_var):
    """DEPLOY bật thiếu secret → exit 1 (systemd Restart + StartLimit)."""
    p, _port = _start(tmp_path, mod, port_var, {"DEPLOY": "1"})
    out, _ = p.communicate(timeout=60)
    assert p.returncode == 1 and "[fatal]" in out


class _H(http.server.BaseHTTPRequestHandler):
    status, body = 200, b'{"ready": true}'

    def do_GET(self):
        self.send_response(self.status)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *a):
        pass


@pytest.fixture
def fake_srv():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv
    srv.shutdown()


def test_probe_ready_notready_down(fake_srv):
    url = f"http://127.0.0.1:{fake_srv.server_port}/readyz"
    _H.status, _H.body = 200, b'{"ready": true}'
    assert wp.probe(url) == (True, "HTTP 200")
    _H.status, _H.body = 503, b'{"ready": false}'
    assert wp.probe(url)[0] is False
    _H.status, _H.body = 302, b"{}"
    assert wp.probe(url)[0] is False          # không theo redirect
    assert wp.probe(f"http://127.0.0.1:{_free_port()}/readyz")[0] is False


def test_probe_alert_once_per_outage(fake_srv):
    """DB test thật (schema tạm + rollback): 1 cảnh báo/đợt, lần 2 không lặp."""
    from tests.test_ceo_audit import TxConn, ceo_db
    gen = ceo_db()
    db = next(gen)
    try:
        c = TxConn(db)
        a1 = wp.alert(c, [("http://x/readyz", "HTTP 503")], routing={})
        a2 = wp.alert(c, [("http://x/readyz", "HTTP 503")], routing={})
        assert a1 and a2 is None
        assert db.execute("select count(*) from red_alerts where source_agent"
                          " = 'webhook_probe'").fetchone()[0] == 1
    finally:
        gen.close()
