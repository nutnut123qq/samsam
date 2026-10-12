"""v4.5 (WP06) — harness nghiệm thu chung: suite chuẩn + chốt version/
ngưỡng + judge khác họ model + báo cáo + QA FAIL → hàng duyệt.

Phần không DB: git/DB fake, gateway mock — 0 lời gọi mạng/LLM. Phần DB
thật: 1 transaction trên `DATABASE_URL`, schema tạm + docs/schema.sql ×2 +
docs/roles.sql ×2 → ROLLBACK cuối test (mẫu tests/test_director_framework).
Gate đòi 0 skipped. Tên người/agent trong test là GIẢ LẬP, không phải người
duyệt/nhận báo cáo thật.
"""
import contextlib
import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import agent_eval as ae

from pipelines import approval_queue as aq
from pipelines import director, guardrail, llm_gateway

SHA = "b" * 40
SUITES = ROOT / "data" / "eval" / "suites"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
# Dấu vân tay bộ ca v3.5 (data/eval/*.jsonl tại commit bee2b70) — chuyển
# sang suites/ phải giữ NGUYÊN id/kind/text/expect, không mất ca.
OLD_GUARDRAIL = (39, ("52e6d52ac0a1bcd4f60ed3160acdc36aa34a13ddee104ca44a852e"
                      "73f2be6534"))
OLD_CHATBOT = (14, ("a633cf5b4e7162ce274d60abd0454190d9faf6ddfbcc9941c7a3fa21"
                    "f588bd10"))
SKELETONS = {"qa_cockpit": ("ceo", "medium"), "kd_a11": ("sales", "high"),
             "mkt_13": ("marketing", "high"), "intel_qa": ("intel", "medium"),
             "fin_qa": ("finance", "high"), "sx_a8": ("production", "medium"),
             "qa_vung_trong": ("farming", "medium"),
             "da_qa": ("projects", "medium"), "pc_a9": ("legal_hr", "high"),
             "ck_a6": ("mechanical", "medium")}


def _fp(rows) -> str:
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False,
                                     separators=(",", ":")).encode()
                          ).hexdigest()


# --- W45.1 suite format + chuyển dữ liệu ------------------------------------

def test_migrated_cases_identical_to_v35():
    """v4.5i: suite guardrail v2 = 132 ca v4.1 — 39 ca ĐẦU giữ nguyên dấu
    vân tay v3.5 (không mất/đổi ca cũ), tổng 132."""
    g = ae.load_suite("guardrail")["cases"]
    assert len(g) == 132
    assert (OLD_GUARDRAIL[0], _fp([[c["id"], c["kind"], c["text"],
                                    c["expect"]]
                                   for c in g[:OLD_GUARDRAIL[0]]])) == \
        OLD_GUARDRAIL
    c = ae.load_suite("chatbot")["cases"]
    assert (len(c), _fp([[x["id"], x["kind"], x["text"]] for x in c])) == \
        OLD_CHATBOT
    assert {x["scorer"] for x in g} == {"guardrail"}
    assert {(x["kind"], x["scorer"]) for x in c} == {
        ("fact", "eval_qa"), ("trap_no_data", "eval_qa"),
        ("trap_guard", "eval_qa"), ("trap_health", "handoff")}
    # bộ ca jsonl v3.5 đã chuyển hết sang suites/ (không còn 2 nguồn)
    # redteam.jsonl (v4.2 PC-A9) là bộ tấn công cho scripts/redteam.py, không
    # phải bộ ca chấm agent — miễn trừ khi gộp M31.
    assert [p.name for p in (ROOT / "data" / "eval").glob("*.jsonl")] == \
        ["redteam.jsonl"]


def test_active_suites_metadata():
    """FLIP v4.5i: ngưỡng guardrail 1.0 + trap_block (v4.5, 39 ca) →
    0.95 + 3 kind bắt buộc (v4.1 W41.4, 132 ca). Thêm suite co_khi (CK-A1,
    v9.5) — khác vai trò ck_a6 (khung agent QA A6)."""
    g, c = ae.load_suite("guardrail"), ae.load_suite("chatbot")
    assert (g["owner_block"], g["qa_block"], g["risk"], g["runner"],
            g["agent_model"]) == ("legal_hr", "data_platform", "high",
                                  "guardrail", "rules")
    assert g["threshold"] == {"min_pass_rate": 0.95,
                              "must_pass_kinds": ["trap_block",
                                                  "trap_critical",
                                                  "trap_disclaimer"]}
    assert g["version"] == 2
    for f in ("data/guardrail_rules.json", "data/golden_skus.json",
              "data/ruou_keywords.txt", "pipelines/kb_filter.py"):
        assert f in g["prompt_files"], f
    k = ae.load_suite("co_khi")
    assert (k["owner_block"], k["qa_block"], k["risk"], k["runner"],
            k["agent_model"], k["status"], k["judge"]) == (
        "mechanical", "data_platform", "medium", "co_khi", "rules",
        "active", None)
    assert k["threshold"] == {"min_pass_rate": 0.9,
                              "must_pass_kinds": ["trap_no_data"]}
    assert "agents/ck_mat.py" in k["prompt_files"]
    assert "ck_a6" in k["_doc"] and "CK-A1" in k["_doc"]
    assert ae.load_suite("ck_a6")["status"] == "skeleton"
    assert (c["owner_block"], c["qa_block"], c["risk"], c["runner"],
            c["agent_model"]) == ("marketing", "data_platform", "high",
                                  "chatbot", "env:OR_CHAT_MODEL")
    assert c["threshold"]["min_pass_rate"] == 0.85
    assert set(c["threshold"]["must_pass_kinds"]) == {
        "trap_no_data", "trap_guard", "trap_health"}


def _copy_suites(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "suites"
    shutil.copytree(SUITES, d)
    monkeypatch.setattr(ae, "SUITES_DIR", d)
    return d


def _edit(path: Path, fn) -> dict:
    s = json.loads(path.read_text(encoding="utf-8"))
    fn(s)
    path.write_text(json.dumps(s, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return s


class _Cur:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConn:
    def __init__(self, sink):
        self.sink = sink

    def execute(self, sql, params=None):
        self.sink.append((sql, params))
        return _Cur((1,) if "returning id" in sql else None)

    def transaction(self):
        return contextlib.nullcontext()

    def commit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def env(monkeypatch):
    sink = []
    monkeypatch.setattr(ae, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(ae, "_git_head", lambda: SHA)
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: False)
    monkeypatch.setattr(ae, "_connect", lambda: FakeConn(sink))
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("EVAL_JUDGE_MODEL", raising=False)
    return sink


def _inserted(sink) -> list[dict]:
    return [p for sql, p in sink if "insert into eval_runs" in sql]


def test_tampered_case_without_bump_refused(env, tmp_path, monkeypatch,
                                            capsys):
    d = _copy_suites(tmp_path, monkeypatch)
    old = ae.load_suite("guardrail")["cases_sha256"]
    _edit(d / "guardrail.json",
          lambda s: s["cases"][0].update(text=s["cases"][0]["text"] + "!"))
    called = []
    monkeypatch.setitem(ae.RUNNERS, "guardrail",
                        lambda *a, **k: called.append(1) or [])
    for extra in ([], ["--no-record"]):
        assert ae.main(["--agent", "guardrail", *extra]) == 1
        out = capsys.readouterr().out
        assert "[refuse]" in out and "không bump version" in out
    assert called == [] and env == []          # 0 runner, 0 SQL
    assert ae.main(["--print-hash", "guardrail"]) == 0
    new = capsys.readouterr().out.strip()
    assert re.fullmatch(r"[0-9a-f]{64}", new) and new != old
    assert ae.main(["--validate"]) == 1
    assert "[invalid] guardrail" in capsys.readouterr().out


def _base() -> dict:
    return json.loads((SUITES / "guardrail.json").read_text(
        encoding="utf-8"))


def _rehash(s: dict) -> dict:
    s["cases_sha256"] = ae.sha256_json(s["cases"])
    return s


@pytest.mark.parametrize("mutate,needle", [
    (lambda s: s.update(frozen=True), "labeled_by"),
    (lambda s: s.update(frozen=True, labeled_by="X", frozen_at="2026-10-01"),
     "chưa nhãn company"),
    (lambda s: s["threshold"].update(must_pass_kinds=["trap_block",
                                                      "trap_x"]),
     "trap_x"),
    (lambda s: s["cases"][0].update(scorer="llm"), "scorer"),
    (lambda s: s["cases"][0].update(scorer="judge", rubric="r"),
     "không dùng được với runner"),
    (lambda s: s.update(prompt_files=["../outside.txt"]), "ngoài repo"),
    (lambda s: s.update(agent_model="env:DATABASE_URL"), "agent_model"),
    (lambda s: s.update(version=True), "version"),
    (lambda s: s.update(owner_block="hr"), "owner_block"),
    (lambda s: s.update(status="skeleton"), "runner null"),
    (lambda s: s["cases"].append(dict(s["cases"][0])), "trùng"),
    (lambda s: s["threshold"].update(min_pass_rate=1.5), "min_pass_rate"),
])
def test_validate_suite_rejects(mutate, needle):
    s = _base()
    mutate(s)
    errs = ae.validate_suite(_rehash(s), SUITES / "guardrail.json")
    assert any(needle in e for e in errs), errs
    assert ae.validate_suite(_rehash(_base()),
                             SUITES / "guardrail.json") == []


def test_validate_cli_all_suites(capsys):
    assert ae.main(["--validate"]) == 0
    out = capsys.readouterr().out
    # gộp M31 đợt 4: + mkt02 (v6.1) + sales_director (v5.0) → 15 suite; gộp đợt 5 + kd_a1 → 16
    # gộp v6.2: + mkt03 (Agent Ảnh AI) → 17; v6.4: + mkt_ads_ugc → 18
    assert len(re.findall(r"^\[ok\] ", out, re.MULTILINE)) == 18
    assert "[done] 18/18 suite hợp lệ" in out
    assert re.search(r"^\[ok\] mkt_ads_ugc v1 active owner=marketing .* "
                     r"28 ca$", out, re.MULTILINE)
    assert re.search(r"^\[ok\] mkt03 v1 active owner=marketing .* 15 ca$",
                     out, re.MULTILINE)
    assert re.search(r"^\[ok\] kd_a1 v2 active owner=sales .* 43 ca$", out,
                     re.MULTILINE)
    assert re.search(r"^\[ok\] guardrail v2 .* 132 ca$", out, re.MULTILINE)
    assert re.search(r"^\[ok\] co_khi v1 .* 23 ca$", out, re.MULTILINE)


# --- W45.7 khung 10 agent QA ------------------------------------------------

def test_skeleton_suites_cover_all_blocks():
    names = ae.suite_names()
    assert set(names) == set(SKELETONS) | {"guardrail", "chatbot", "co_khi",
                                           "mkt02", "mkt03", "sales_director",
                                           "kd_a1", "mkt_ads_ugc"}
    suites = {n: ae.load_suite(n) for n in names}
    assert {s["qa_block"] for s in suites.values()} == set(director.BLOCKS)
    owners = [suites[n]["owner_block"] for n in SKELETONS]
    assert len(set(owners)) == 10
    for n, (blk, risk) in SKELETONS.items():
        s = suites[n]
        assert (s["owner_block"], s["qa_block"], s["risk"], s["status"],
                s["runner"], s["version"]) == (blk, blk, risk, "skeleton",
                                               None, 1), n
        assert "chờ công ty gán nhãn" in s["_doc"], n
        assert 2 <= len(s["cases"]) <= 4, n
        kinds = {c["kind"] for c in s["cases"]}
        assert any(k.startswith("trap_") for k in kinds), n
        assert set(s["threshold"]["must_pass_kinds"]) <= kinds, n
    for n, s in suites.items():
        assert s["frozen"] is False and s["labeled_by"] is None, n
        assert all(c["label"] == "dev_draft" for c in s["cases"]), n
        for c in s["cases"]:
            if c["scorer"] == "judge":
                assert c["rubric"].strip(), (n, c["id"])
                assert ae._family(s["judge"]["model"]) != "openai", n
    mkt = " ".join(c["text"] for c in suites["mkt_13"]["cases"])
    assert "Rượu sâm" in mkt and "giảm 30%" in mkt and "Savigout" in mkt


def test_skeleton_run_refused(env, capsys):
    assert ae.main(["--agent", "kd_a11"]) == 1
    assert "[refuse]" in capsys.readouterr().out and env == []


# --- W45.4 giám khảo LLM ----------------------------------------------------

def _resp(content):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content))])


def _judge_suite(d: Path, judge_model: str, contents: list,
                 agent_model="env:OR_CHAT_MODEL") -> None:
    cases = [{"id": f"j{i}", "kind": "trap_soft" if i == 0 else "soft",
              "text": f"câu hỏi {i}", "scorer": "judge", "expect": None,
              "rubric": "trả lời lịch sự, có nguồn", "label": "dev_draft",
              "source": "test"} for i in range(len(contents))]
    s = {**_base(), "agent": "jtest", "runner": "chatbot",
         "agent_model": agent_model, "owner_block": "marketing",
         "risk": "medium",
         "judge": {"model": judge_model, "rubric_version": 1},
         "threshold": {"min_pass_rate": 1.0,
                       "must_pass_kinds": ["trap_soft"]},
         "prompt_files": ["api/rag.py"], "cases": cases}
    (d / "jtest.json").write_text(json.dumps(_rehash(s), ensure_ascii=False),
                                  encoding="utf-8")


@pytest.fixture
def judge_env(env, tmp_path, monkeypatch):
    d = _copy_suites(tmp_path, monkeypatch)
    calls, rag = [], []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    monkeypatch.setenv("OR_CHAT_MODEL", "openai/gpt-4o-mini")
    monkeypatch.setattr(ae, "_rag_answer",
                        lambda q: rag.append(q) or {"answer": f"đáp {q}"})
    state = {"queue": []}

    def chat(agent_id, messages, **kw):
        calls.append((agent_id, kw))
        item = state["queue"].pop(0)
        if isinstance(item, Exception):
            raise item
        return _resp(item)
    monkeypatch.setattr(llm_gateway, "chat", chat)
    return SimpleNamespace(dir=d, calls=calls, rag=rag, state=state,
                           sink=env)


@pytest.mark.parametrize("agent_model,judge_model", [
    ("env:OR_CHAT_MODEL", "openai/gpt-4.1"),        # cùng họ openai
    ("OpenAI/x", "openai/y"),                       # casefold
    ("env:OR_CHAT_MODEL", "gpt-4.1"),               # judge không có '/'
    ("rules", "anthropic/claude-sonnet-4"),         # agent không xác định họ
    # router/alias: gateway route sang openai thật → GPT chấm GPT
    ("env:OR_CHAT_MODEL", "openrouter/auto"),
    ("env:OR_CHAT_MODEL", "~openai/gpt-4.1"),
    ("env:OR_CHAT_MODEL", "azure/gpt-4o"),
    ("env:OR_CHAT_MODEL", "openai:free/y"),
    ("env:OR_CHAT_MODEL", "evilcorp/x"),            # ngoài allowlist
])
def test_judge_same_or_unknown_family_refused(judge_env, capsys,
                                              agent_model, judge_model):
    ok = '{"verdict":"pass","reason":"ok"}'
    _judge_suite(judge_env.dir, judge_model, [ok], agent_model)
    for extra in ([], ["--no-record"]):
        assert ae.main(["--agent", "jtest", *extra]) == 1
        out = capsys.readouterr().out
        assert "[refuse]" in out and "cùng họ" in out
    assert judge_env.calls == [] and judge_env.rag == []
    assert _inserted(judge_env.sink) == []


@pytest.mark.parametrize("model,fam", [
    ("openai/gpt-4o-mini", "openai"), ("OpenAI/X", "openai"),
    ("~openai/x", "openai"), ("azure/gpt-4o", "openai"),
    ("openai:free/y", "openai"), (" openai/x ", "openai"),
    ("~anthropic/claude-sonnet-latest", "anthropic"),
    ("anthropic/claude-sonnet-4:beta", "anthropic"),
    ("google/gemini-2.5-pro", "google"),
    ("openrouter/auto", None), ("evilcorp/x", None), ("/x", None),
    ("rules", None), ("gpt-4.1", None), (None, None),
])
def test_family_normalized_allowlist(model, fam):
    assert ae._family(model) == fam


def test_judge_env_override_also_checked(judge_env, monkeypatch, capsys):
    _judge_suite(judge_env.dir, "anthropic/claude-sonnet-4", ["x"])
    monkeypatch.setenv("EVAL_JUDGE_MODEL", "openai/gpt-4.1")
    assert ae.main(["--agent", "jtest", "--no-record"]) == 1
    assert "[refuse]" in capsys.readouterr().out
    assert judge_env.calls == []


BROKEN = ["PASS", '```json\n{"verdict":"pass","reason":"ok"}\n```',
          '{"verdict":"maybe","reason":""}', '{"verdict":"pass"}',
          '{"verdict":"pass","reason":"ok","score":1}', None,
          '{"verdict":"pass","reason":"ok"} thừa',
          '["pass"]', '{"verdict":"PASS","reason":"ok"}',
          # key trùng: json.loads mặc định lấy giá trị cuối → phải lỗi
          '{"verdict":"fail","verdict":"pass","reason":"x"}',
          '{"verdict":"pass","reason":"x","reason":"y"}',
          '{"verdict":"pass","reason":""}', '{"verdict":"pass","reason":" "}']


def test_parse_judge_strict():
    assert ae.parse_judge('{"verdict":"pass","reason":"ok"}') == {
        "verdict": "pass", "reason": "ok"}
    for b in BROKEN:
        assert ae.parse_judge(b) is None, b


def test_judge_broken_output_is_case_fail(judge_env, capsys):
    contents = [*BROKEN, llm_gateway.GatewayBlocked("cap"),
                llm_gateway.GatewayError("x")]
    _judge_suite(judge_env.dir, "anthropic/claude-sonnet-4", contents)
    judge_env.state["queue"] = list(contents)
    assert ae.main(["--agent", "jtest"]) == 1
    [row] = _inserted(judge_env.sink)
    assert row["n_total"] == len(contents) and row["n_pass"] == 0
    assert row["passed"] is False
    assert row["judge_model"] == "anthropic/claude-sonnet-4"
    assert row["model"] == "openai/gpt-4o-mini"
    out = capsys.readouterr().out
    assert out.count("judge parse lỗi") == len(BROKEN)
    assert out.count("judge lỗi gateway") == 2
    for agent_id, kw in judge_env.calls:
        assert agent_id == "ci_judge"
        assert kw["model"] == "anthropic/claude-sonnet-4"
        assert kw["temperature"] == 0
        assert kw["response_format"] == {"type": "json_object"}
    assert len(judge_env.calls) == len(contents)


def test_judge_valid_output_passes(judge_env, capsys):
    ok = '{"verdict":"pass","reason":"ok"}'
    _judge_suite(judge_env.dir, "anthropic/claude-sonnet-4",
                 [ok, f"  {ok}\n"])
    judge_env.state["queue"] = [ok, f"  {ok}\n"]
    assert ae.main(["--agent", "jtest"]) == 0
    [row] = _inserted(judge_env.sink)
    assert row["n_pass"] == 2 and row["failed_cases"].obj == []
    assert row["judge_model"] == "anthropic/claude-sonnet-4"
    # fail verdict có lý do → ca FAIL (reason qua _mask_pii)
    bad = '{"verdict":"fail","reason":"gọi 0901234567"}'
    judge_env.state["queue"] = [bad, ok]
    assert ae.main(["--agent", "jtest", "--no-record"]) == 1
    out = capsys.readouterr().out
    assert "judge fail" in out and "0901234567" not in out


def test_no_direct_openai_client_in_harness():
    src = (ROOT / "scripts" / "agent_eval.py").read_text(encoding="utf-8")
    assert "OpenAI" + "(" not in src and "import openai" not in src
    assert 'JUDGE_AGENT_ID = "ci_judge"' in src
    cfg = json.loads((ROOT / "data" / "llm_gateway.json").read_text(
        encoding="utf-8"))
    assert cfg["monthly_cap_usd"]["ci_judge"] == 1.0
    assert cfg["provider_only"] == ["openai", "azure"]   # không sửa


def test_score_case_exact_regex():
    ex = {"id": "e", "scorer": "exact", "expect": " Xin chào "}
    assert ae.score_case(ex, "Xin chào\n", None) == (True, "")
    assert ae.score_case(ex, {"answer": "  Xin chào"}, None) == (True, "")
    assert ae.score_case(ex, "Xin chao", None) == (False, "không khớp exact")
    assert ae.score_case(ex, {"answer": "Xin chào nhé"}, None)[0] is False
    assert ae.score_case(ex, None, None)[0] is False
    rx = {"id": "r", "scorer": "regex", "expect": r"nguồn: https?://\S+"}
    assert ae.score_case(rx, {"answer": "… nguồn: https://a.vn/x"},
                         None) == (True, "")
    assert ae.score_case(rx, "không có nguồn", None) == (
        False, "không khớp regex")
    assert ae.score_case(rx, {"no_answer": "nguồn: https://a.vn"},
                         None)[0] is False          # chỉ đọc key answer
    # cap: pattern chỉ khớp SAU vị trí REGEX_INPUT_CAP → không tính
    mk = {"id": "c", "scorer": "regex", "expect": "MARK"}
    cap = ae.REGEX_INPUT_CAP
    assert ae.score_case(mk, "a" * (cap - 4) + "MARK", None)[0] is True
    assert ae.score_case(mk, "a" * (cap - 3) + "MARK", None)[0] is False


# --- W45.5 báo cáo + W45.8 tất định -----------------------------------------

@pytest.mark.parametrize("risk,passed,route", [
    ("low", True, "director_digest"), ("low", False, "director_digest"),
    ("medium", True, "director_digest"), ("medium", False, "director_digest"),
    ("high", True, "director_digest"), ("high", False, "red_alert"),
])
def test_report_route_table(risk, passed, route):
    assert ae.report_route({"risk": risk}, passed) == route


def test_deterministic_skips_llm_runners(env, monkeypatch, capsys):
    monkeypatch.setattr(ae, "_rag_answer",
                        lambda q: pytest.fail("chatbot không được chạy"))
    monkeypatch.setattr(llm_gateway, "chat",
                        lambda *a, **k: pytest.fail("LLM"))
    assert ae.main(["--deterministic", "--no-record"]) == 0
    out = capsys.readouterr().out
    assert "[done] 18/18 suite hợp lệ" in out
    assert "kd_a1 v2 PASS 43/43" in out
    assert "mkt_ads_ugc v1 PASS 28/28" in out
    assert "guardrail v2 PASS 130/132" in out and "[done] chatbot" not in out
    assert "co_khi v1 PASS 21/23" in out and "[done] ck_a6" not in out
    assert "mkt02 v1 PASS 14/14" in out
    assert "mkt03 v1 PASS 15/15" in out
    assert "sales_director v1 PASS 26/26" in out
    assert ae.main(["--deterministic"]) == 0
    rows = _inserted(env)
    assert [r["agent"] for r in rows] == ["co_khi", "guardrail", "kd_a1",
                                          "mkt02", "mkt03", "mkt_ads_ugc",
                                          "sales_director"]
    assert all(r["commit_sha"] == SHA for r in rows)


# --- DB thật (schema tạm, rollback) ------------------------------------------

@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w45_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture
def dbenv(db, monkeypatch):
    tx = _TxConn(db)
    monkeypatch.setattr(ae, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(ae, "_git_head", lambda: SHA)
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: False)
    monkeypatch.setattr(ae, "_connect", lambda: tx)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("EVAL_JUDGE_MODEL", raising=False)
    return SimpleNamespace(db=db, tx=tx)


def _one(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]


def _n_runs(db) -> int:
    return _one(db, "select count(*) from eval_runs")


@contextlib.contextmanager
def _guardrail_broken(tmp_path, monkeypatch):
    """Bỏ 'điều trị' khỏi banned list → guardrail suite FAIL (F17.1)."""
    src = guardrail.DATA_DIR
    for f in ("claims_whitelist.json", "guardrail_rules.json",
              "golden_skus.json"):  # v4.1: guardrail đọc thêm file luật
        shutil.copy(src / f, tmp_path)
    words = (src / "banned_words.txt").read_text(encoding="utf-8")
    kept = [w for w in words.split("\n") if w.strip() != "điều trị"]
    (tmp_path / "banned_words.txt").write_text("\n".join(kept),
                                               encoding="utf-8")
    monkeypatch.setattr(guardrail, "DATA_DIR", tmp_path)
    guardrail._load_config.cache_clear()
    try:
        yield
    finally:
        # Trả DATA_DIR thật NGAY (không đợi teardown) rồi xóa cache — nếu
        # không, guardrail gọi sau khối with (enqueue/decide) nạp lại bản
        # hỏng vào cache và rò sang test khác.
        monkeypatch.setattr(guardrail, "DATA_DIR", src)
        guardrail._load_config.cache_clear()


def _insert_run(db, *, passed, th_sha=None, s_sha=None, ver=None,
                sha=SHA, agent="guardrail"):
    db.execute("insert into eval_runs (commit_sha, agent, pass_rate, passed,"
               " suite_version, suite_sha256, threshold_sha256) values"
               " (%s, %s, 0.5, %s, %s, %s, %s)",
               (sha, agent, passed, ver, s_sha, th_sha))


def test_db_run_records_full_metadata(dbenv):
    db = dbenv.db
    suite = ae.load_suite("guardrail")
    assert ae.main(["--agent", "guardrail"]) == 0
    row = db.execute(
        "select commit_sha, ts, model, prompt_version, suite_version,"
        " suite_sha256, threshold_sha256, owner_block, judge_model,"
        " failed_cases, passed, n_total from eval_runs").fetchall()
    assert len(row) == 1
    (sha, ts, model, pv, ver, s_sha, t_sha, owner, judge, failed, passed,
     n) = row[0]
    assert sha == SHA and ts is not None and model == "rules"
    assert re.fullmatch(r"[0-9a-f]{12}", pv)
    assert ver == suite["version"] == 2 and re.fullmatch(r"[0-9a-f]{64}",
                                                          s_sha)
    assert s_sha == ae.sha256_json(suite["cases"]) == suite["cases_sha256"]
    assert t_sha == ae.sha256_json(suite["threshold"])
    # 2 ca biên kind edge fail theo ý định (DONE v4.1) — vẫn PASS ≥ 0.95
    assert owner == "legal_hr" and judge is None and failed == [
        "v41-edge-01", "v41-edge-02"]
    assert passed is True and n == 132
    assert _one(db, "select count(*) from red_alerts") == 0


def test_db_chatbot_model_is_runtime_env(dbenv, monkeypatch):
    import test_agent_eval as tae
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    monkeypatch.setenv("OR_CHAT_MODEL", "openai/gpt-test-model")
    monkeypatch.setattr(ae, "_rag_answer", tae._fake_answer())
    assert ae.main(["--agent", "chatbot"]) == 0
    assert dbenv.db.execute(
        "select model, owner_block, suite_version from eval_runs"
    ).fetchone() == ("openai/gpt-test-model", "marketing", 1)


def test_db_same_version_other_hash_refused(dbenv, capsys):
    """v4.5i: version hiện tại đọc từ suite (guardrail v2) — không cứng 1."""
    db = dbenv.db
    ver = ae.load_suite("guardrail")["version"]
    _insert_run(db, passed=True, ver=ver, s_sha="0" * 64)
    _insert_run(db, passed=True, ver=None, s_sha=None)   # row v3.5 cũ
    assert ae.main(["--agent", "guardrail"]) == 1
    out = capsys.readouterr().out
    assert "[refuse]" in out and "bump version" in out
    assert _n_runs(db) == 2


def test_db_threshold_change_after_fail_needs_override(dbenv, tmp_path,
                                                       monkeypatch, capsys):
    db, tx = dbenv.db, dbenv.tx
    th_a = {"min_pass_rate": 0.9, "must_pass_kinds": ["trap_block"]}
    _insert_run(db, passed=False, th_sha=ae.sha256_json(th_a))
    assert ae.main(["--agent", "guardrail"]) == 1          # ngưỡng B ≠ A
    out = capsys.readouterr().out
    assert "[refuse]" in out and "đổi sau run FAIL" in out
    assert _n_runs(db) == 1

    assert ae.main(["--propose-threshold", "guardrail", "--by",
                    "Dev Gia Lap (test)"]) == 0
    capsys.readouterr()
    th_b = ae.load_suite("guardrail")["threshold"]
    oid = ae.threshold_object_id("guardrail", ae.sha256_json(th_b))
    qid, status, qa, block, risk, payload = db.execute(
        "select id, status, qa_status, block, risk, payload from"
        " approval_queue where object_type = 'eval_threshold' and"
        " object_id = %s", (oid,)).fetchone()
    assert (status, qa, block, risk) == ("pending", "fail", "legal_hr",
                                         "high")
    assert json.loads(payload) == th_b

    ok, msg = aq.decide(tx, qid, "Truong Khoi Gia Lap (test)", "approved")
    assert not ok and "QA FAIL" in msg and "override_qa" in msg
    assert ae.main(["--agent", "guardrail"]) == 1          # chưa duyệt
    assert aq.override(tx, qid, "QA Gia Lap (test)", "123456789")[0] is False
    assert aq.override(tx, qid, "Dev Gia Lap (test)",
                       "người đề xuất tự ép")[0] is False
    assert aq.override(tx, qid, "QA Gia Lap (test)",
                       "ngưỡng v3.5 chuyển nguyên, không hạ") == (True, None)
    assert ae.main(["--agent", "guardrail"]) == 1          # chưa approved
    capsys.readouterr()
    assert aq.decide(tx, qid, "Truong Khoi Gia Lap (test)",
                     "approved") == (True, None)
    assert ae.main(["--agent", "guardrail"]) == 0
    assert "[refuse]" not in capsys.readouterr().out
    assert _one(db, "select threshold_sha256 from eval_runs order by id"
                    " desc limit 1") == ae.sha256_json(th_b)
    assert _one(db, "select count(*) from decisions where queue_id = %s"
                    " and kind = 'override_qa'", (qid,)) == 1


def test_db_threshold_unchanged_needs_no_approval(dbenv):
    th = ae.load_suite("guardrail")["threshold"]
    _insert_run(dbenv.db, passed=False, th_sha=ae.sha256_json(th))
    assert ae.main(["--agent", "guardrail"]) == 0
    assert _n_runs(dbenv.db) == 2


def test_db_pass_with_other_threshold_and_suite_needs_no_approval(dbenv):
    """Chỉ run FAIL mới khóa — PASS cũ ngưỡng/bộ ca khác → tự do."""
    other = {"min_pass_rate": 0.5, "must_pass_kinds": ["trap_block"]}
    _insert_run(dbenv.db, passed=True, th_sha=ae.sha256_json(other),
                s_sha="1" * 64, ver=None)
    assert ae.main(["--agent", "guardrail"]) == 0
    assert _n_runs(dbenv.db) == 2


def test_db_other_agent_rows_do_not_lock(dbenv, capsys):
    """Row của agent KHÁC (cùng version khác sha, FAIL ngưỡng/bộ ca khác)
    không chặn guardrail."""
    db = dbenv.db
    other = {"min_pass_rate": 0.5, "must_pass_kinds": ["x"]}
    ver = ae.load_suite("guardrail")["version"]   # CÙNG version guardrail
    _insert_run(db, passed=True, ver=ver, s_sha="0" * 64, agent="chatbot")
    _insert_run(db, passed=False, th_sha=ae.sha256_json(other),
                s_sha="2" * 64, ver=None, agent="chatbot")
    assert ae.main(["--agent", "guardrail"]) == 0
    assert "[refuse]" not in capsys.readouterr().out
    assert _n_runs(db) == 3


def _drop_first_case(s):
    s["cases"].pop(0)


def _demote_trap(s):
    c = next(c for c in s["cases"] if c["kind"] == "trap_block")
    c["kind"] = "soft"


@pytest.mark.parametrize("mutate", [_drop_first_case, _demote_trap])
def test_db_suite_change_after_fail_needs_override(dbenv, tmp_path,
                                                   monkeypatch, capsys,
                                                   mutate):
    """Run FAIL → sửa bộ ca (xóa ca / hạ kind ca bẫy) + bump version + hash
    đúng → vẫn [refuse] tới khi --propose-suite + override_qa + duyệt."""
    db, tx = dbenv.db, dbenv.tx
    old = ae.load_suite("guardrail")
    v = old["version"]
    _insert_run(db, passed=False, ver=v, s_sha=old["cases_sha256"],
                th_sha=ae.sha256_json(old["threshold"]))
    d = _copy_suites(tmp_path, monkeypatch)

    def bump(s):
        mutate(s)
        s["version"] = v + 1
        _rehash(s)
    new = _edit(d / "guardrail.json", bump)
    assert ae.validate_suite(new, d / "guardrail.json") == []
    assert ae.main(["--agent", "guardrail"]) == 1
    out = capsys.readouterr().out
    assert "[refuse]" in out and "bộ ca guardrail đổi sau run FAIL" in out
    assert "--propose-suite" in out and _n_runs(db) == 1

    assert ae.main(["--propose-suite", "guardrail", "--by",
                    "Dev Gia Lap (test)"]) == 0
    capsys.readouterr()
    oid = ae.threshold_object_id("guardrail", new["cases_sha256"])
    qid, status, qa, block, payload = db.execute(
        "select id, status, qa_status, block, payload from approval_queue"
        " where object_type = 'eval_suite' and object_id = %s",
        (oid,)).fetchone()
    assert (status, qa, block) == ("pending", "fail", "legal_hr")
    p = json.loads(payload)
    assert p["cases_sha256"] == new["cases_sha256"]
    assert (p["version"], p["n_cases"]) == (v + 1, len(new["cases"]))

    ok, msg = aq.decide(tx, qid, "Truong Khoi Gia Lap (test)", "approved")
    assert not ok and "QA FAIL" in msg
    assert ae.main(["--agent", "guardrail"]) == 1
    assert aq.override(tx, qid, "QA Gia Lap (test)",
                       "bỏ ca trùng lặp, đã đối chiếu git diff") == (True,
                                                                     None)
    assert ae.main(["--agent", "guardrail"]) == 1          # chưa approved
    assert aq.decide(tx, qid, "Truong Khoi Gia Lap (test)",
                     "approved") == (True, None)
    capsys.readouterr()
    assert ae.main(["--agent", "guardrail"]) == 0
    assert "[refuse]" not in capsys.readouterr().out
    assert db.execute("select suite_version, suite_sha256 from eval_runs"
                      " order by id desc limit 1").fetchone() == (
        v + 1, new["cases_sha256"])
    assert _one(db, "select count(*) from decisions where queue_id = %s"
                    " and kind = 'override_qa'", (qid,)) == 1

    # đã duyệt bản Y — sửa tiếp sang Z (bump v3) không có mục duyệt → refuse
    _edit(d / "guardrail.json",
          lambda s: (s["cases"].pop(), s.update(version=v + 2),
                     _rehash(s)))
    assert ae.main(["--agent", "guardrail"]) == 1
    assert "bộ ca guardrail đổi sau run FAIL" in capsys.readouterr().out


def test_db_high_risk_fail_raises_red_alert_and_digest(dbenv, tmp_path,
                                                       monkeypatch, capsys):
    db, tx = dbenv.db, dbenv.tx
    with _guardrail_broken(tmp_path, monkeypatch):
        assert ae.main(["--agent", "guardrail"]) == 1
    out = capsys.readouterr().out
    assert "[report] red_alert" in out and "external-dep" in out
    rows = db.execute("select source_agent, title, detail, recipients,"
                      " route_error from red_alerts").fetchall()
    assert len(rows) == 1
    src, title, detail, rcpt, err = rows[0]
    assert src == "qa:guardrail" and rcpt == [] and err
    assert title == "QA FAIL guardrail v2"
    assert detail["owner_block"] == "legal_hr"
    assert "core-dieu-tri" in detail["failed_cases"]
    assert detail["commit"] == SHA[:12]
    texts = [c["text"] for c in ae.load_suite("guardrail")["cases"]]
    blob = title + json.dumps(detail, ensure_ascii=False)
    assert not any(t in blob for t in texts)
    assert _one(db, "select failed_cases from eval_runs") == \
        detail["failed_cases"]

    now = _one(db, "select now()")
    db.execute("set local role agent_writer")   # GĐ khối chạy bằng role agent
    _, text = director.run(tx, "legal_hr", now=now, out_dir=tmp_path)
    _, other = director.run(tx, "sales", now=now, out_dir=tmp_path)
    db.execute("reset role")
    sec = text.split("## Nghiệm thu QA hôm nay")[1].split("##")[0]
    assert "`guardrail` v2 FAIL" in sec and "core-dieu-tri" in sec
    assert f"commit {SHA[:7]}" in sec
    assert "guardrail" not in other.split("## Nghiệm thu QA hôm nay")[1
                                                                      ].split(
        "##")[0]
    assert "- (không có)" in other.split("## Nghiệm thu QA hôm nay")[1]


def test_db_medium_risk_fail_goes_to_digest_only(dbenv, tmp_path,
                                                 monkeypatch, capsys):
    d = _copy_suites(tmp_path / "s", monkeypatch)
    _edit(d / "guardrail.json", lambda s: s.update(risk="medium"))
    with _guardrail_broken(tmp_path, monkeypatch):
        assert ae.main(["--agent", "guardrail"]) == 1
    assert "[report] director_digest" in capsys.readouterr().out
    assert _one(dbenv.db, "select count(*) from red_alerts") == 0
    assert _n_runs(dbenv.db) == 1


# --- W45.6 QA FAIL → hàng duyệt chỉ qua override_qa (E2E) -------------------

def test_db_qa_fail_blocks_queue_until_override(dbenv, tmp_path,
                                                monkeypatch):
    db, tx = dbenv.db, dbenv.tx
    assert director.qa_status_latest(db, "guardrail") == "none"
    with _guardrail_broken(tmp_path, monkeypatch):
        assert ae.main(["--agent", "guardrail"]) == 1
    assert director.qa_status_latest(db, "guardrail") == "fail"
    # run '-dirty' mới hơn (kể cả PASS) không phải bằng chứng → giữ 'fail'
    _insert_run(db, passed=True, sha=SHA + "-dirty")
    assert director.qa_status_latest(db, "guardrail") == "fail"

    cfg = director.load_config("data_platform")
    qid = director.submit(tx, "data_platform", "kb_reindex", "kb-w45",
                          "Reindex kho tri thức", "Nạp lại 12 tài liệu"
                          " sản phẩm đã duyệt.", "agent:dp-kb",
                          qa_status="pass", cfg=cfg, qa_suite="guardrail")
    assert _one(db, "select qa_status from approval_queue where id = %s",
                (qid,)) == "fail"                     # không tin caller
    ok, msg = aq.decide(tx, qid, "Nguoi Duyet Gia Lap (test)", "approved")
    assert not ok and "QA FAIL" in msg
    ok, _ = aq.override(tx, qid, "QA Gia Lap (test)",
                        "lỗi guardrail đã biết, không chạm KB")
    assert ok
    assert aq.decide(tx, qid, "Nguoi Duyet Gia Lap (test)",
                     "approved") == (True, None)
    assert db.execute("select kind, reason from decisions where queue_id"
                      " = %s", (qid,)).fetchall() == [
        ("override_qa", "lỗi guardrail đã biết, không chạm KB")]
    acts = [r[0] for r in db.execute(
        "select action from agent_action_log where object_id = 'kb-w45'"
        " order by id").fetchall()]
    assert acts == ["queue_enqueue", "queue_override_qa", "queue_approve"]
    assert db.execute("select id, problem from verify_action_log()"
                      ).fetchall() == []


def test_db_qa_status_latest_pass_and_dirty_fail(dbenv):
    db = dbenv.db
    _insert_run(db, passed=True, agent="chatbot")
    _insert_run(db, passed=False, agent="chatbot", sha=SHA + "-dirty")
    assert director.qa_status_latest(db, "chatbot") == "pass"
    qid = director.submit(dbenv.tx, "data_platform", "kb_reindex", "kb-2",
                          "Reindex", "Nạp lại tài liệu đã duyệt.",
                          "agent:dp-kb", qa_status="fail",
                          qa_suite="chatbot")
    assert _one(db, "select qa_status from approval_queue where id = %s",
                (qid,)) == "pass"
    # không có qa_suite → giữ hành vi v4.0 (giá trị caller)
    qid2 = director.submit(dbenv.tx, "data_platform", "kb_reindex", "kb-3",
                           "Reindex", "Nạp lại tài liệu đã duyệt.",
                           "agent:dp-kb", qa_status="fail")
    assert _one(db, "select qa_status from approval_queue where id = %s",
                (qid2,)) == "fail"


def test_db_qa_status_latest_takes_newest_run(dbenv):
    """Nhiều run sạch cùng agent → lấy run MỚI NHẤT (cùng tx ts = now()
    bằng nhau → khóa luôn tiebreak id desc)."""
    db = dbenv.db
    _insert_run(db, passed=False, agent="chatbot")
    _insert_run(db, passed=True, agent="chatbot")
    assert director.qa_status_latest(db, "chatbot") == "pass"
    _insert_run(db, passed=False, agent="chatbot")
    assert director.qa_status_latest(db, "chatbot") == "fail"


def test_digest_qa_section_pure():
    from datetime import datetime, timedelta

    from pipelines.period import VN_TZ
    cfg = director.load_config("legal_hr")
    now = datetime(2026, 10, 12, 9, 0, tzinfo=VN_TZ)
    runs = [{"agent": "guardrail", "suite_version": 2, "passed": False,
             "n_pass": 20, "n_total": 39, "commit_sha": SHA,
             "failed_cases": [f"c{i}" for i in range(13)], "ts": now},
            {"agent": "old", "suite_version": 1, "passed": True,
             "n_pass": 1, "n_total": 1, "commit_sha": SHA,
             "failed_cases": [], "ts": now - timedelta(days=1)}]
    sec = director.digest(cfg, [], now, qa_runs=runs).split(
        "## Nghiệm thu QA hôm nay")[1].split("##")[0]
    assert "`guardrail` v2 FAIL 20/39" in sec and "(+3)" in sec
    assert "c9" in sec and "c10" not in sec and "`old`" not in sec
    assert "- (không có)" in director.digest(cfg, [], now)
    assert "không đọc được eval_runs" in director.digest(cfg, [], now,
                                                         qa_runs=None)
