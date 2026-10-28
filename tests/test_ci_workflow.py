"""W35.5 — drift-guard .github/workflows/ci.yml (parse YAML, không chạy CI).

r20: PyYAML đã vào requirements (CI chạy được tệp này); importorskip chỉ còn
cho máy thiếu gói. PyYAML (YAML 1.1) đọc key `on:` thành True."""
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


def test_ruff_pinned_exact():
    """r20: CI cài ruff từ requirements; repo không cấu hình ruff nên bản mới
    đổi mặc định là CI đỏ (0.17: target 3.10 → 3.11, UP017 ×117) — ghim."""
    req = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    pins = re.findall(r"(?m)^ruff\b.*$", req)
    assert len(pins) == 1, pins
    assert re.fullmatch(r"ruff==\d+\.\d+\.\d+", pins[0].strip()), pins


def test_test_job_db_setup_matches_preflight(doc):
    """r20: job test dựng DB đúng các lệnh `_db_guard._FIX` TRƯỚC pytest —
    thiếu role agent_writer / sku_master rỗng thì preflight dừng exit 4."""
    from tests import _db_guard
    runs = _runs(doc["jobs"]["test"])
    before = runs[:runs.index("python -m pytest -q")]
    need = re.findall(r"`([^`]+)`", _db_guard._FIX)
    assert need and all(c in before for c in need), (need, before)
    assert before.count("python scripts/apply_schema.py --roles") == 2
    # đúng thứ tự của _FIX: schema+role (cả 2 lần) → core_store → golden_store
    last = [len(before) - 1 - before[::-1].index(c) for c in need]
    first = [before.index(c) for c in need]
    assert all(last[k] < first[k + 1] for k in range(len(need) - 1)), before


def test_test_job_timeout_covers_full_suite(doc):
    # r20: full suite đo local 46–173 phút — 20 phút cũ hủy job giữa pytest
    assert doc["jobs"]["test"]["timeout-minutes"] >= 180


def test_deterministic_suites_are_rule_based():
    """v4.5i: --deterministic (job test, mỗi push) chạy đúng suite active
    có runner tất định (guardrail; v12.0 gỡ suite cơ khí — ngoài phạm vi
    HĐ; gộp M31 đợt 4 thêm mkt02 +
    sales_director — đều luật, 0 LLM; gộp v6.2 thêm mkt03 — provider ảnh
    giả; v6.4 thêm mkt_ads_ugc — hàm thuần); chatbot (RAG/LLM thật) + 8 khung skeleton KHÔNG chạy
    (v12.0 gỡ khung ck_a6/da_qa của 2 khối ngoài HĐ)."""
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    import agent_eval as ae

    det = {n for n in ae.suite_names() if ae._deterministic(ae.load_suite(n))}
    # v6.5: + mkt_seo (seo_san.suggest thuần — 0 mạng/LLM/DB); v6.3: + mkt04
    # v6.4: + mkt_ads_ugc; v8.2: + kd_a3; v10.1: + kd_a7, kd_a9, mkt12
    assert det == {"guardrail", "mkt02", "mkt03", "mkt04",
                   "sales_director", "kd_a1", "mkt_seo", "kd_a5",
                   "mkt_ads_ugc", "kd_a3", "kd_a7", "kd_a9", "mkt12"}
    assert not ae._deterministic(ae.load_suite("chatbot"))
    skel = [n for n in ae.suite_names()
            if ae.load_suite(n)["status"] == "skeleton"]
    assert len(skel) == 8 and not any(
        ae._deterministic(ae.load_suite(n)) for n in skel)
    ci = CI.read_text(encoding="utf-8")
    assert "(guardrail — v4.5i;" in ci and "mkt02 + sales_director" in ci \
        and "+ kd_a1 — v4.5i/v5.1" in ci and "+ mkt03 — gộp v6.2" in ci \
        and "+ mkt_seo — v6.5" in ci and "+ kd_a5 — v5.3" in ci \
        and "+ mkt04 — v6.3" in ci and "+ mkt_ads_ugc" in ci \
        and "+ kd_a3 — v8.2" in ci


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
