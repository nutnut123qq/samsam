"""W35.4 — scripts/deploy_gate.py: chỉ in kế hoạch khi đủ PASS + người
duyệt + luật đóng băng. DB qua fake conn; approvers inject qua config tạm
(NGƯỜI DUYỆT GIẢ LẬP TRONG TEST — không phải danh sách thật)."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import deploy_gate as dg

SHA = "c" * 40
APPROVER = "Nguoi Duyet Gia Lap (test)"  # người duyệt giả lập trong test
T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
T1 = datetime(2026, 10, 2, tzinfo=timezone.utc)


class FakeConn:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params):
        sha = params[0]
        self.result = [r for r in self.rows if r[0] == sha]
        return self

    def fetchall(self):
        return self.result

    def close(self):
        pass


@pytest.fixture
def gate(monkeypatch, tmp_path):
    """rows = list (commit_sha, agent, passed, ts, id); approvers giả lập."""
    cfg = json.loads(dg.CONFIG.read_text(encoding="utf-8"))
    cfg["approvers"] = [APPROVER]
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(dg, "CONFIG", p)
    monkeypatch.setattr(dg, "load_dotenv", lambda *a, **k: None)
    state = {"rows": [(SHA, "guardrail", True, T0, 1),
                      (SHA, "chatbot", True, T0, 2)], "cfg": p}
    monkeypatch.setattr(dg, "_connect", lambda: FakeConn(state["rows"]))
    return state


def _run(*extra, today="2026-11-01", by=APPROVER, sha=SHA):
    argv = ["--sha", sha, "--today", today, *extra]
    if by is not None:
        argv += ["--approved-by", by]
    return dg.main(argv)


def test_all_ok_prints_plan(gate, capsys):
    assert _run() == 0
    out = capsys.readouterr().out
    assert SHA in out and f"releases/{SHA}" in out
    assert "guardrail_ver=" + SHA in out and "KHÔNG chạy" in out


def test_plan_keeps_shared_state_and_smoke(gate, capsys):
    """Release mới không mất .env / token rotate / dedup / convlog; pip
    trỏ đúng release; có smoke + rollback mang state theo."""
    assert _run() == 0
    out = capsys.readouterr().out
    rel = f"{dg.RELEASES}/{SHA}"
    assert "shared" in out and f"{dg.SHARED}/.env {rel}/.env" in out
    assert f"-r {rel}/requirements.txt" in out
    for f in ("zalo_tokens.json", "zalo_seen.db", "conversations.jsonl"):
        assert f"$PREV/data/{f}" in out and f"{rel}/data/{f}" in out
        # KHÔNG symlink từng file state: os.replace/rename thay mất link
        assert not re.search(r"ln -s\S* \S*" + re.escape(f), out)
    switch = out.index(f"ln -sfn {rel} /opt/samsam/current")
    assert out.index("systemctl stop") < out.index("mv $PREV/data/") < switch
    assert switch < out.index("/healthz") < out.index("Rollback")
    assert "agent_eval.py --agent chatbot --no-record" in out
    rb = out[out.index("Rollback"):]
    assert f"mv {rel}/data/zalo_tokens.json" in rb and "ln -sfn $PREV" in rb


def test_approver_casefold_strip(gate):
    assert _run(by="  " + APPROVER.upper() + " ") == 0


def test_no_eval_rows_denied(gate, capsys):
    gate["rows"] = []
    assert _run() == 1
    out = capsys.readouterr().out
    assert "guardrail: chưa có eval_runs" in out
    assert "chatbot: chưa có eval_runs" in out


def test_one_agent_missing_pass(gate, capsys):
    gate["rows"] = [(SHA, "guardrail", True, T0, 1),
                    (SHA, "chatbot", False, T0, 2)]
    assert _run() == 1
    assert "chatbot: lần eval mới nhất FAIL" in capsys.readouterr().out


def test_pass_then_newer_fail_denied(gate):
    gate["rows"] = [(SHA, "chatbot", False, T1, 3),  # thứ tự trả về bất kỳ
                    (SHA, "guardrail", True, T0, 1),
                    (SHA, "chatbot", True, T0, 2)]
    assert _run() == 1


def test_fail_then_newer_pass_allowed(gate):
    gate["rows"] = [(SHA, "chatbot", True, T1, 3),
                    (SHA, "guardrail", True, T0, 1),
                    (SHA, "chatbot", False, T0, 2)]
    assert _run() == 0


def test_same_ts_tiebreak_by_id(gate):
    gate["rows"] = [(SHA, "guardrail", True, T0, 1),
                    (SHA, "chatbot", True, T0, 2),
                    (SHA, "chatbot", False, T0, 5)]
    assert _run() == 1


def test_dirty_rows_never_match(gate):
    gate["rows"] = [(SHA + "-dirty", "guardrail", True, T0, 1),
                    (SHA + "-dirty", "chatbot", True, T0, 2)]
    assert _run() == 1
    assert _run(sha=SHA + "-dirty") == 1


def test_approval_required(gate, capsys):
    assert _run(by=None) == 1
    assert "thiếu --approved-by" in capsys.readouterr().out
    assert _run(by="   ") == 1
    assert _run(by="Nguoi La") == 1
    assert "không thuộc danh sách" in capsys.readouterr().out


def test_empty_approvers_external_dep(gate, capsys):
    cfg = json.loads(gate["cfg"].read_text(encoding="utf-8"))
    cfg["approvers"] = []
    gate["cfg"].write_text(json.dumps(cfg), encoding="utf-8")
    assert _run() == 1
    assert "external-dep" in capsys.readouterr().out


@pytest.mark.parametrize("required", [[], None, "missing"])
def test_empty_required_agents_fail_closed(gate, capsys, required):
    """required_agents rỗng/thiếu không được bỏ qua bước eval (A04)."""
    cfg = json.loads(gate["cfg"].read_text(encoding="utf-8"))
    if required == "missing":
        del cfg["required_agents"]
    else:
        cfg["required_agents"] = required
    gate["cfg"].write_text(json.dumps(cfg), encoding="utf-8")
    gate["rows"] = []  # SHA không có row eval_runs nào
    assert _run() == 1
    assert "required_agents" in capsys.readouterr().out


def test_real_config_has_no_approvers():
    """Config thật: approvers rỗng -> gate từ chối mọi deploy."""
    cfg = json.loads(dg.CONFIG.read_text(encoding="utf-8"))
    assert cfg["approvers"] == []


@pytest.mark.parametrize("day,hotfix,code", [
    ("2026-12-20", False, 0),
    ("2026-12-21", False, 1),
    ("2027-01-15", False, 1),
    ("2027-02-10", False, 1),
    ("2027-02-11", False, 0),
    ("2026-12-22", True, 0),
    ("2027-02-10", True, 0),
])
def test_freeze_window_boundaries(gate, day, hotfix, code):
    assert _run(*(["--hotfix"] if hotfix else []), today=day) == code


def test_hotfix_still_needs_pass(gate, capsys):
    gate["rows"] = [(SHA, "guardrail", True, T0, 1)]
    assert _run("--hotfix", today="2026-12-22") == 1
    assert "chatbot" in capsys.readouterr().out


def test_hotfix_still_needs_approver(gate):
    assert _run("--hotfix", today="2026-12-22", by="Nguoi La") == 1


@pytest.mark.parametrize("bad", ["2026/12/21", "21-12-2026", "2026-13-01",
                                 "2026-02-30", "x"])
def test_bad_today_exit_2(gate, bad, capsys):
    with pytest.raises(SystemExit) as e:
        _run(today=bad)
    assert e.value.code == 2
    assert "Traceback" not in capsys.readouterr().err


def test_bad_sha_denied_without_db(gate, monkeypatch, capsys):
    monkeypatch.setattr(dg, "_connect", lambda: pytest.fail("db"))
    assert _run(sha="abc") == 1
    assert "40 hex" in capsys.readouterr().out


def test_db_down_fail_closed(gate, monkeypatch, capsys):
    def boom():
        raise psycopg.OperationalError("timeout")
    monkeypatch.setattr(dg, "_connect", boom)
    assert _run() == 1
    out = capsys.readouterr().out
    assert "DB lỗi" in out and "fail-closed" in out


def test_all_reasons_listed(gate, capsys):
    gate["rows"] = []
    assert _run(today="2026-12-25", by="Nguoi La") == 1
    out = capsys.readouterr().out
    assert "chưa có eval_runs" in out
    assert "không thuộc danh sách" in out
    assert "đóng băng" in out


def test_default_today_is_vn_date(gate, monkeypatch):
    """Không --today: ngày theo UTC+7 (17:30 UTC 20/12 = 00:30 21/12 VN)."""
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 12, 20, 17, 30, tzinfo=timezone.utc
                            ).astimezone(tz)
    monkeypatch.setattr(dg, "datetime", FakeDT)
    assert dg.main(["--sha", SHA, "--approved-by", APPROVER]) == 1
    assert dg.main(["--sha", SHA, "--approved-by", APPROVER,
                    "--hotfix"]) == 0
