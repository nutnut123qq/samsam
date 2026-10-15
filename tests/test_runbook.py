"""v3.10 — drift-guard cho docs/handover/runbook-ha-tang.md.

- Mọi lệnh `python ...` trong runbook trỏ file có thật trong repo HOẶC dòng
  của nó đánh dấu `(nhánh khác: vX.Y)` — chống "lệnh ma".
- Runbook nhắc đủ agent_id parse từ code thật (word-boundary).
- Không secret (DSN có mật khẩu, key OpenRouter).
- Lệnh kiểm kill switch (`python -c ... _gate('smoke')`) chạy được thật.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUNBOOK = ROOT / "docs" / "handover" / "runbook-ha-tang.md"
OTHER_BRANCH = re.compile(r"\(nhánh khác: v\d+\.\d+\)")
_MOD = re.compile(r"python\s+-m\s+([\w.]+)")
_SCRIPT = re.compile(r"python\s+([\w./-]+\.py)")
_SKIP_MOD = {"pytest", "py_compile", "venv", "pip"}
AGENT_DIRS = ("api", "pipelines", "ingest", "agents", "connectors")


def check_commands(text: str, root: Path = ROOT) -> tuple[int, list[str]]:
    """(số lệnh đã kiểm, danh sách lệnh ma)."""
    n, bad = 0, []
    for no, line in enumerate(text.splitlines(), 1):
        marked = bool(OTHER_BRANCH.search(line))
        targets = [(m, (root / (m.replace(".", "/") + ".py"),
                        root / m.replace(".", "/") / "__init__.py"))
                   for m in _MOD.findall(line) if m not in _SKIP_MOD]
        targets += [(s, (root / s,)) for s in _SCRIPT.findall(line)]
        for name, cands in targets:
            n += 1
            if not marked and not any(p.is_file() for p in cands):
                bad.append(f"dòng {no}: {name}")
    return n, bad


def agent_ids() -> set[str]:
    ids = set()
    for d in AGENT_DIRS:
        for p in (ROOT / d).rglob("*.py"):
            src = p.read_text(encoding="utf-8")
            ids |= set(re.findall(r"\b(?:chat|embed)\(\s*\"([\w-]+)\"", src))
            ids |= set(re.findall(r"(?m)^AGENT\s*=\s*\"([\w-]+)\"", src))
    return ids


def _body() -> str:
    return RUNBOOK.read_text(encoding="utf-8")


def test_runbook_commands_exist():
    n, bad = check_commands(_body())
    assert not bad, "lệnh ma trong runbook:\n" + "\n".join(bad)
    assert n >= 10, f"chỉ kiểm được {n} lệnh — guard rỗng?"


def test_check_commands_catches_ghosts():
    n, bad = check_commands("chạy `python scripts/khong_co.py`\n"
                            "và `python -m agents.khong_co --x`\n")
    assert n == 2 and len(bad) == 2
    n, bad = check_commands("`python scripts/khong_co.py` (nhánh khác: v3.7)")
    assert n == 1 and bad == []
    # Package (`__init__.py`) và module thật qua; pytest/pip bị bỏ.
    n, bad = check_commands("python -m agents · python -m agents.report · "
                            "python -m pytest -q · python -m pip install x")
    assert n == 2 and bad == []
    # Marker sai dạng không được tính.
    n, bad = check_commands("python scripts/khong_co.py (nhánh khác)")
    assert bad


def test_runbook_required_terms():
    body = _body()
    for term in ("S1", "S2", "S3", "LLM_KILL", "data/llm_gateway.json",
                 "monthly_cap_usd", "21/12", "10/02", "break_glass",
                 "dr_drill", "db_backup", "db_restore_drill", "RPO", "RTO",
                 "external-dep"):
        assert term in body, f"runbook thiếu '{term}'"
    assert body.count("- [ ]") >= 6


def test_runbook_lists_real_agent_ids():
    ids = agent_ids()
    assert len(ids) >= 3, f"chỉ parse được {ids} — regex/code đổi?"
    assert {"chatbot", "content", "ingest"} <= ids
    body = _body()
    for a in sorted(ids):
        assert re.search(rf"(?<![\w-]){re.escape(a)}(?![\w-])", body), (
            f"runbook thiếu agent_id '{a}'")


def test_other_branch_tools_marked():
    lines = _body().splitlines()
    for word in ("health_bulletin",):
        hits = [ln for ln in lines if word in ln]
        assert hits, f"runbook không nhắc {word}"
        for ln in hits:
            assert OTHER_BRANCH.search(ln), (
                f"'{word}' ở dòng không đánh dấu nhánh khác: {ln.strip()}")


def test_deploy_gate_marked_wired_not_other_branch():
    """v4.0 đã nối deploy_gate ↔ pipelines.freeze — runbook không được còn
    nói 'nhánh khác'/'sau khi gộp' (vận hành tưởng cổng chưa áp đóng băng)."""
    body = _body()
    hits = [ln for ln in body.splitlines() if "deploy_gate" in ln]
    assert hits, "runbook không nhắc deploy_gate"
    for ln in hits:
        assert not OTHER_BRANCH.search(ln), ln.strip()
    assert "sau khi gộp nhánh đó" not in body
    assert re.search(r"deploy_gate\.py`[^\n]*ĐÃ nối", body)
    assert "pipelines.freeze.check()" in body


def test_runbook_no_secrets():
    for no, ln in enumerate(_body().splitlines(), 1):
        assert not re.search(r"postgresql://[^<\s:/]+:[^<\s@]+@", ln), no
        assert "sk-or-v1" not in ln, no


def test_kill_switch_check_command_runs(monkeypatch, capsys):
    """Lệnh kiểm kill switch trong runbook (mục 5) chạy được thật: chưa
    kill → in OK; `smoke` trong kill → GatewayBlocked. Không gọi LLM/DB."""
    from pipelines import llm_gateway as g
    lines = [ln for ln in _body().splitlines()
             if ln.startswith('python -c "') and "_gate('smoke')" in ln]
    assert len(lines) == 1, "runbook thiếu lệnh kiểm kill switch smoke"
    code = lines[0][len('python -c "'):-1]
    # v13.1: không đọc được chi tiêu = chặn (fail-closed) — lệnh runbook
    # giả định DB đọc được (chi tiêu 0); trước đây None = "cho qua".
    monkeypatch.setattr(g, "_month_spend", lambda a: 0.0)
    monkeypatch.setenv("LLM_PROVIDER_ONLY", "openai")
    monkeypatch.setenv("LLM_KILL", "")
    exec(code, {})  # noqa: S102 — chính dòng lệnh trong runbook
    assert "OK: smoke NOT blocked" in capsys.readouterr().out
    monkeypatch.setenv("LLM_KILL", "smoke")
    with pytest.raises(g.GatewayBlocked, match="smoke"):
        exec(code, {})  # noqa: S102
    assert "OK" not in capsys.readouterr().out
