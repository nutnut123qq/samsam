"""v4.0 W40.4 — `pipelines.red_alert`: routing fail-closed + người nhận độc
lập (không TGĐ/ha_tang) + mask PII trước khi ghi. Fake conn; đường DB thật
ở tests/test_director_framework.py."""

import json
import os
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path

import pytest

from pipelines import red_alert as ra

ROOT = Path(__file__).resolve().parent.parent
GOOD = {"name": "Nguoi Nhan Gia Lap (test)", "role": "phap_che",
        "channel": "email"}


def _write(tmp_path, content: bytes | None):
    p = tmp_path / "routing.json"
    if content is not None:
        p.write_bytes(content)
    return p


@pytest.mark.parametrize("content", [
    None,                                   # file thiếu
    b"",                                    # rỗng
    b"{recipients: [",                      # JSON hỏng
    b"{}",
    json.dumps({"_doc": "chỉ ghi chú"}).encode(),
    b"[]",                                  # không phải object
    b"\xff\xfe{}",                          # UTF-8 lỗi
])
def test_broken_routing_files_give_no_recipients(tmp_path, content):
    r = ra.load_routing(_write(tmp_path, content))
    assert r["recipients"] == []
    assert {"tgd", "ha_tang"} <= set(r["excluded_roles"])


def test_excluded_and_incomplete_recipients_dropped(tmp_path):
    cfg = {"excluded_roles": [], "recipients": [
        {**GOOD, "role": "tgd"}, {**GOOD, "role": "ha_tang"},
        {**GOOD, "role": " TGD "}, {**GOOD, "name": "  "},
        {**GOOD, "channel": None}, {**GOOD, "role": ""}, "Nguoi X", GOOD]}
    r = ra.load_routing(_write(tmp_path, json.dumps(cfg).encode()))
    assert r["recipients"] == [GOOD]
    assert len(r["problems"]) == 7
    # excluded_roles bỏ trống trong file vẫn loại tgd/ha_tang (luôn loại).
    assert set(ra.ALWAYS_EXCLUDED) <= set(r["excluded_roles"])


def test_real_config_has_no_recipients():
    """Khóa: không ai tự điền người nhận thật (Pháp chế xác nhận —
    external-dep)."""
    raw = json.loads(ra.ROUTING.read_text(encoding="utf-8"))
    assert raw["recipients"] == []
    assert raw["excluded_roles"] == ["tgd", "ha_tang"]
    assert ra.load_routing()["recipients"] == []


class FakeConn:
    def __init__(self):
        self.calls = []
        self.commits = 0

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self

    def fetchone(self):
        return (11,)

    def transaction(self):
        return nullcontext()

    def commit(self):
        self.commits += 1


def test_raise_alert_no_recipients_fail_closed(capsys):
    conn = FakeConn()
    routed, msg = ra.raise_alert(conn, "agent:intel-red", "Lô lỗi",
                                 routing={"recipients": []})
    assert routed is False and ra.MISSING in msg
    sql, params = conn.calls[0]
    assert "insert into red_alerts" in sql
    assert params[3] == [] and params[4] == ra.MISSING
    log_sql, log_params = conn.calls[1]
    assert "agent_action_log" in log_sql and log_params[1] == "red_alert_raise"
    assert log_params[4].obj == {"alert_id": 11, "routed": False,
                                 "n_recipients": 0}
    assert conn.commits == 1
    assert "thiếu người nhận" in capsys.readouterr().err


def test_raise_alert_masks_pii_and_routes():
    # v13.7 (F06, flip có chủ đích): True = ĐÃ GỬI tới ≥1 người — routing hợp
    # lệ nhưng kênh "email" thiếu địa chỉ/SMTP thì KHÔNG còn là "đã thông
    # báo" (trước v13.7 trả True dù chưa gửi gì).
    conn = FakeConn()
    routed, msg = ra.raise_alert(
        conn, "agent:intel-red", "Khách 0912 345 678 báo lỗi",
        {"lien_he": "gọi 0912 345 678", "list": ["a@b.vn"], "n": 5},
        routing={"recipients": [GOOD]}, sender=None)
    assert routed is False and ra.NOT_SENT in msg
    sent = []
    conn = FakeConn()
    routed, _ = ra.raise_alert(
        conn, "agent:intel-red", "Khách 0912 345 678 báo lỗi",
        {"lien_he": "gọi 0912 345 678", "list": ["a@b.vn"], "n": 5},
        routing={"recipients": [{**GOOD, "channel": "email:pc@vi-du.test"}]},
        sender=lambda to, subj, body: sent.append((to, subj, body)))
    assert routed is True and sent[0][0] == "pc@vi-du.test"
    assert "0912" not in sent[0][1] + sent[0][2]
    params = conn.calls[0][1]
    assert "0912" not in params[1] and "345 678" not in params[1]
    detail = params[2].obj
    assert "0912" not in json.dumps(detail, ensure_ascii=False)
    assert "a@b.vn" not in json.dumps(detail) and detail["n"] == 5
    assert params[3] == [GOOD["name"]] and params[4] is None


def test_raise_alert_requires_agent_and_title():
    for agent, title in (("  ", "x"), ("agent:a", "   ")):
        conn = FakeConn()
        with pytest.raises(ValueError):
            ra.raise_alert(conn, agent, title, routing={"recipients": []})
        assert conn.calls == []


def test_check_routing_cli_real_config_exit_1():
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, "-m", "pipelines.red_alert",
                        "--check-routing"], cwd=ROOT, env=env,
                       capture_output=True, timeout=60, encoding="utf-8",
                       errors="replace", check=False)
    assert r.returncode == 1 and "thiếu người nhận" in r.stdout, r.stdout


def test_check_routing_ok_when_valid(monkeypatch, tmp_path, capsys):
    # v13.7 (flip có chủ đích): có người nhận nhưng CHƯA có kênh gửi (SMTP
    # chưa bật / kênh không có địa chỉ) → exit 1 — trước đây exit 0 dù cảnh
    # báo chỉ nằm trong DB.
    for k in ("RED_ALERT_NOTIFY", "SMTP_HOST", "RA_MAIL_PC"):
        monkeypatch.delenv(k, raising=False)
    p = _write(tmp_path, json.dumps({"recipients": [GOOD]}).encode())
    monkeypatch.setattr(ra, "ROUTING", p)
    assert ra.main(["--check-routing"]) == 1
    out = capsys.readouterr().out
    assert "1 người nhận" in out and "chưa có kênh gửi" in out
    p.write_text(json.dumps({"recipients": [
        {**GOOD, "channel": "email:$RA_MAIL_PC"}]}), encoding="utf-8")
    monkeypatch.setenv("RED_ALERT_NOTIFY", "email")
    monkeypatch.setenv("SMTP_HOST", "smtp.vi-du.test")
    assert ra.main(["--check-routing"]) == 1          # biến địa chỉ chưa đặt
    monkeypatch.setenv("RA_MAIL_PC", "pc@vi-du.test")
    assert ra.main(["--check-routing"]) == 0          # không mở mạng khi kiểm
    assert "pc@vi-du.test" not in capsys.readouterr().out


@pytest.mark.parametrize("role", [
    "TG\u0110", "tg\u0111", "tong_giam_doc", "giam_doc", "quan_ly_ha_tang",
    "ke_toan", "bks_x"])
def test_allowlist_rejects_non_independent_roles(tmp_path, role):
    """Allowlist (không deny-list nhãn): 'TGĐ' có dấu, biến thể tên, vai trò
    lạ → bỏ; chỉ phap_che/bks qua."""
    cfg = {"recipients": [{**GOOD, "role": role},
                          {**GOOD, "name": "BKS Gia Lap", "role": " BKS "}]}
    r = ra.load_routing(_write(tmp_path, json.dumps(cfg).encode()))
    assert [x["role"] for x in r["recipients"]] == ["bks"]
    assert len(r["problems"]) == 1


@pytest.mark.parametrize("bad", [
    {"name": "X", "role": "tgd", "channel": "zalo"},
    {"name": "X", "role": " HA_TANG ", "channel": "zalo"},
    {"name": "X", "role": "TG\u0110", "channel": "zalo"},
    {"name": "X", "role": "phap_che", "channel": "  "},
])
def test_raise_alert_refilters_passed_routing(bad, capsys):
    """routing truyền tay KHÔNG được bỏ qua luật người nhận độc lập."""
    conn = FakeConn()
    routed, msg = ra.raise_alert(conn, "agent:intel-red", "Lô lỗi",
                                 routing={"recipients": [bad]})
    assert routed is False and ra.MISSING in msg
    params = conn.calls[0][1]
    assert params[3] == [] and params[4] == ra.MISSING
    assert conn.calls[1][1][4].obj["routed"] is False


def test_raise_alert_routing_excluded_roles_respected():
    conn = FakeConn()
    routed, _ = ra.raise_alert(
        conn, "agent:intel-red", "Lô lỗi",
        routing={"recipients": [GOOD], "excluded_roles": ["PHAP_CHE"]})
    assert routed is False and conn.calls[0][1][3] == []
