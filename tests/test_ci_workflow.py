"""W35.5 — drift-guard .github/workflows/ci.yml (parse YAML, không chạy CI).

PyYAML không nằm trong requirements -> importorskip. PyYAML (YAML 1.1)
đọc key `on:` thành True."""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parent.parent
CI = ROOT / ".github" / "workflows" / "ci.yml"


@pytest.fixture(scope="module")
def doc():
    return yaml.safe_load(CI.read_text(encoding="utf-8"))


def _runs(job: dict) -> list[str]:
    return [s["run"] for s in job["steps"] if "run" in s]


def test_triggers_and_permissions(doc):
    on = doc.get("on", doc.get(True))
    assert {"push", "pull_request", "workflow_dispatch", "schedule"} <= set(on)
    # nightly 02:00 VN = 19:00 UTC (eval LLM, không chạy mỗi push)
    assert on["schedule"] == [{"cron": "0 19 * * *"}]
    assert doc["permissions"] == {"contents": "read"}


def test_jobs_have_timeout_and_pinned_actions(doc):
    assert {"test", "eval"} <= set(doc["jobs"])
    for name, job in doc["jobs"].items():
        assert job.get("timeout-minutes"), name
        for s in job["steps"]:
            if "uses" in s:
                assert re.fullmatch(r"actions/[\w-]+@v\d+", s["uses"]), s


def test_test_job_postgres_and_commands(doc):
    job = doc["jobs"]["test"]
    pg = job["services"]["postgres"]
    assert pg["image"].startswith("postgres:16")
    assert "pg_isready" in pg["options"]
    assert job["env"]["DATABASE_URL"].startswith("postgresql://")
    runs = "\n".join(_runs(job))
    for cmd in ("ruff check", "python -m pytest", "apply_schema.py",
                "ingest.core_store", "agent_eval.py --deterministic",
                "redteam.py"):
        assert cmd in runs, cmd
    # v4.5: eval tất định (validate mọi suite + guardrail), không chạy
    # suite gọi LLM trong job test.
    assert "agent_eval.py --agent chatbot" not in runs


def test_deterministic_suites_are_guardrail_and_co_khi():
    """v4.5i: --deterministic (job test, mỗi push) chạy đúng suite active
    có runner tất định (guardrail + co_khi); chatbot (RAG/LLM thật) + 10
    khung skeleton KHÔNG chạy."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    import agent_eval as ae

    det = {n for n in ae.suite_names() if ae._deterministic(ae.load_suite(n))}
    # FLIP v5.1: + kd_a1 (KD-A1 CSKH, runner cskh — gateway giả, không
    # LLM/secret) chạy trong job test mỗi push.
    assert det == {"guardrail", "co_khi", "kd_a1"}
    assert not ae._deterministic(ae.load_suite("chatbot"))
    skel = [n for n in ae.suite_names()
            if ae.load_suite(n)["status"] == "skeleton"]
    assert len(skel) == 10 and not any(
        ae._deterministic(ae.load_suite(n)) for n in skel)
    ci = CI.read_text(encoding="utf-8")
    assert "guardrail + co_khi" in ci and "+ kd_a1 — v4.5i/v5.1" in ci


def test_test_job_has_no_secrets(doc):
    blob = yaml.safe_dump(doc["jobs"]["test"])
    assert "OPENROUTER" not in blob and "secrets." not in blob


def test_eval_job_dispatch_only_and_guarded(doc):
    job = doc["jobs"]["eval"]
    needs = job["needs"]
    assert needs == "test" or "test" in needs
    # chỉ chạy tay hoặc nightly — không push/pull_request (tốn phí LLM)
    events = set(re.findall(r"github\.event_name == '(\w+)'", job["if"]))
    assert events == {"workflow_dispatch", "schedule"}, job["if"]
    assert "push" not in job["if"] and "pull_request" not in job["if"]
    assert "secrets" not in job["if"]  # secrets không dùng được ở job-if
    assert "secrets.OPENROUTER_API_KEY" in job["env"]["OPENROUTER_API_KEY"]
    first, *rest = job["steps"]
    assert "skip" in first["run"] and "external-dep" in first["run"]
    for s in rest:
        assert s.get("if") == "env.OPENROUTER_API_KEY != ''", s
    assert "agent_eval.py --agent chatbot" in "\n".join(_runs(job))


def test_referenced_scripts_exist():
    src = CI.read_text(encoding="utf-8")
    scripts = re.findall(r"python (scripts/[\w/]+\.py)", src)
    modules = re.findall(r"python -m ([\w.]+)", src)
    assert scripts and modules
    for s in scripts:
        assert (ROOT / s).is_file(), s
    for m in modules:
        if m in ("pytest",):
            continue
        p = ROOT / m.replace(".", "/")
        assert p.with_suffix(".py").is_file() or (p / "__main__.py"
                                                  ).is_file(), m
