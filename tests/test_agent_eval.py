"""W35.1 + W35.3 (+ v4.5 suites) — bộ ca data/eval/suites + harness
scripts/agent_eval.py.

DB qua fake conn, git qua monkeypatch, RAG qua fake answer — không mạng,
không LLM, không wall-clock."""
import contextlib
import shutil
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import agent_eval as ae
import eval_qa

from pipelines import guardrail

SHA = "a" * 40
EVAL_DIR = ROOT / "data" / "eval"
CORE_WORDS = ("chữa", "điều trị", "thuốc", "khỏi bệnh")


def _rows(name: str) -> tuple[list[str], list[dict]]:
    """(doc, ca) của suite data/eval/suites/<name>.json (v4.5)."""
    d = ae.load_suite(name)
    return [d["_doc"]], d["cases"]


def _runs(env) -> list[dict]:
    """Chỉ các INSERT eval_runs (bỏ SELECT chốt version/ngưỡng)."""
    return [p for sql, p in env["inserts"] if "insert into eval_runs" in sql]


# --- W35.1 bộ ca + config ---------------------------------------------------

@pytest.mark.parametrize("name", ["guardrail", "chatbot"])
def test_case_files_parse_unique_and_unapproved(name):
    docs, cases = _rows(name)
    assert docs and "chưa được công ty duyệt" in docs[0].casefold()
    ids = [str(c["id"]) for c in cases]
    assert len(ids) == len(set(ids)), "id trùng"
    assert all(c["text"].strip() and c.get("kind") for c in cases)
    d = ae.load_suite(name)
    assert ae.validate_suite(d, EVAL_DIR / "suites" / f"{name}.json") == []
    assert d["frozen"] is False and d["labeled_by"] is None
    assert {c["label"] for c in cases} == {"dev_draft"}


def test_chatbot_cases_match_questions_md():
    _, cases = _rows("chatbot")
    qs = eval_qa.load_questions()
    numbered = {c["id"]: c for c in cases if isinstance(c["id"], int)}
    assert sorted(numbered) == sorted(qs) == list(range(1, 13))
    for n, q in qs.items():
        assert numbered[n]["text"] == q, f"Q{n} lệch questions.md"
    assert numbered[eval_qa.TRAP_NO_DATA]["kind"] == "trap_no_data"
    assert numbered[eval_qa.TRAP_GUARD]["kind"] == "trap_guard"
    # fact = đúng các câu có luật chấm trong eval_qa.EXPECTED (drift-guard)
    assert {n for n, c in numbered.items() if c["kind"] == "fact"} == \
        set(eval_qa.EXPECTED)
    health = [c for c in cases if c["kind"] == "trap_health"]
    assert len(health) >= 2


def test_guardrail_cases_cover_core_words_and_v30_sets():
    import test_guardrail as tg

    _, cases = _rows("guardrail")
    texts = {c["text"]: c["expect"] for c in cases}
    for t in tg.AFFIRMATIVE_THAY_THE_THUOC:
        assert texts.get(t) == "block"
    for t in tg.DISCLAIMER_VARIANTS:
        assert texts.get(t) == "pass"
    blocks = [c["text"].casefold() for c in cases if c["expect"] == "block"]
    for w in CORE_WORDS:
        assert any(w in t for t in blocks), f"thiếu ca block cho '{w}'"
    assert all(c["expect"] in ("block", "pass") for c in cases)


def test_guardrail_cases_match_current_behavior():
    """Bộ ca phản ánh đúng hành vi đã nghiệm thu (v4.1: 3 kind bắt buộc
    100%, tổng >= 0.95). v4.5i: ngưỡng/kind đọc từ suite (không còn
    config["agents"])."""
    d = ae.load_suite("guardrail")
    cases = d["cases"]
    res = ae.run_guardrail(cases)
    must = d["threshold"]["must_pass_kinds"]
    assert set(must) == {"trap_block", "trap_critical", "trap_disclaimer"}
    bad = [(c["id"], d) for c, ok, d in res if not ok and c["kind"] in must]
    assert not bad, bad
    assert sum(ok for _, ok, _ in res) / len(res) >= \
        d["threshold"]["min_pass_rate"] == 0.95
    # Ca fail CÓ CHỦ ĐÍCH (lý do ở evidence/v41_eval.log) — ca pass/edge
    # khác hồi quy thì đỏ ngay, không trốn trong biên 5%. Thêm ca fail mới
    # phải ghi rõ vào đây + evidence.
    known = {"v41-edge-01", "v41-edge-02"}
    assert {c["id"] for c, ok, _ in res if not ok} <= known


def test_config_thresholds_and_trap_kinds():
    """FLIP v4.5i: ngưỡng guardrail 1.0 (suite v1, 39 ca) → 0.95 + 3 kind
    bắt buộc (suite v2 = 132 ca v4.1, DONE v4.1 W41.4). Ca bẫy = kind bắt
    buộc soát trên MỌI suite active (gồm co_khi — v9.5; mkt02 v6.1,
    sales_director v5.0 — gộp M31 đợt 4; mkt03 v6.2)."""
    cfg = ae.load_config()
    assert cfg["required_agents"] == ["guardrail", "chatbot"]
    assert cfg["approvers"] == []  # external-dep: chưa ai được cấp quyền
    # v4.0: lịch đóng băng chỉ ở data/freeze_calendar.json (1 nguồn).
    assert "freeze" not in cfg
    assert "người duyệt" in cfg["_doc"]
    # v4.5: ca + ngưỡng chuyển sang data/eval/suites/<agent>.json.
    assert "agents" not in cfg and "suites" in cfg["_doc"]
    active = [n for n in ae.suite_names()
              if ae.load_suite(n)["status"] == "active"]
    assert set(cfg["required_agents"]) < set(active)
    for agent in active:
        d = ae.load_suite(agent)
        traps = {c["kind"] for c in d["cases"]
                 if c["kind"].startswith("trap_")}
        must = set(d["threshold"]["must_pass_kinds"])
        # v6.1 (nới có chủ đích): kind bắt buộc không-bẫy (mkt02
        # `golden_exact`) được phép — bẫy vẫn phải khớp đúng tập trap_*
        # bắt buộc, và MỌI kind bắt buộc phải có ca trong bộ.
        assert traps == {k for k in must if k.startswith("trap_")}, agent
        assert must <= {c["kind"] for c in d["cases"]}, agent
        for f in d["prompt_files"]:
            assert (ROOT / f).is_file(), f
    assert ae.load_suite("guardrail")["threshold"]["min_pass_rate"] == 0.95


# --- W35.3 harness ----------------------------------------------------------

class _Cur:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConn:
    """SELECT chốt version/ngưỡng → không có row; INSERT ... returning id
    → (1,). transaction() là no-op (raise_alert dùng)."""

    def __init__(self, sink):
        self.sink = sink
        self.committed = False

    def execute(self, sql, params=None):
        self.sink.append((sql, params))
        return _Cur((1,) if "returning id" in sql else None)

    def transaction(self):
        return contextlib.nullcontext()

    def commit(self):
        self.committed = True

    def close(self):
        pass


@pytest.fixture
def env(monkeypatch):
    """git sạch tại SHA, DB fake, không đọc .env thật."""
    inserts, conns = [], []

    def _conn():
        c = FakeConn(inserts)
        conns.append(c)
        return c

    monkeypatch.setattr(ae, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(ae, "_git_head", lambda: SHA)
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: False)
    monkeypatch.setattr(ae, "_connect", _conn)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    return {"inserts": inserts, "conns": conns}


def test_guardrail_run_records_pass(env, capsys):
    assert ae.main(["--agent", "guardrail"]) == 0
    [(sql, row)] = [(q, p) for q, p in env["inserts"]
                    if q.lstrip().lower().startswith("insert")]
    assert "insert into eval_runs" in sql
    assert env["conns"][0].committed
    assert row["commit_sha"] == SHA and row["agent"] == "guardrail"
    assert row["passed"] is True and row["pass_rate"] >= row["threshold"] == 0.95
    assert row["model"] == "rules"
    assert len(row["prompt_version"]) == 12
    int(row["prompt_version"], 16)
    assert "PASS" in capsys.readouterr().out


def test_removing_dieu_tri_fails(env, monkeypatch, tmp_path, capsys):
    """Acceptance F17.1: xoá 'điều trị' khỏi banned list -> FAIL, exit 1."""
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
        assert ae.main(["--agent", "guardrail"]) == 1
    finally:
        guardrail._load_config.cache_clear()
    [row] = _runs(env)
    assert row["passed"] is False  # FAIL vẫn được ghi (deploy thấy FAIL)
    out = capsys.readouterr().out
    assert "core-dieu-tri" in out and "FAIL" in out
    # v4.5: suite risk high FAIL → cảnh báo đỏ (cùng conn)
    assert any("insert into red_alerts" in sql for sql, _ in env["inserts"])


def _res(ok_ids, cases):
    return [(c, str(c["id"]) in ok_ids, "") for c in cases]


def test_score_trap_fail_blocks_even_above_threshold():
    cases = [{"id": i, "kind": "fact"} for i in range(9)] + [
        {"id": "t", "kind": "trap_x"}]
    acfg = {"min_pass_rate": 0.8, "must_pass_kinds": ["trap_x"]}
    s = ae.score(_res({str(i) for i in range(9)}, cases), acfg)
    assert s["pass_rate"] == 0.9 and s["passed"] is False
    assert s["trap_fail"] == ["t"]
    s = ae.score(_res({str(i) for i in range(8)} | {"t"}, cases), acfg)
    assert s["passed"] is True


def test_score_missing_kind_or_empty_fails():
    acfg = {"min_pass_rate": 0.5, "must_pass_kinds": ["trap_x"]}
    cases = [{"id": 1, "kind": "fact"}]
    s = ae.score(_res({"1"}, cases), acfg)
    assert s["passed"] is False and s["missing_kinds"] == ["trap_x"]
    assert ae.score([], {"min_pass_rate": 0.0})["passed"] is False


def _fake_answer(fail_ids=()):
    """Trả answer đúng luật eval_qa cho mọi câu, trừ fail_ids."""
    qs = eval_qa.load_questions()
    by_text = {v: k for k, v in qs.items()}

    def answer(q):
        n = by_text.get(q)
        if n is None:  # câu sức khỏe -> handoff như api.rag W31.5
            if "health" in fail_ids:
                return {"answer": "x", "sources": []}
            return {"answer": "Chưa đủ dữ liệu để trả lời.", "sources": [],
                    "handoff": "health"}
        if n in fail_ids:
            return {"answer": "Saphraton chữa ung thư", "sources": []}
        if n in eval_qa.EXPECTED:
            text = " ".join(g[0] for g in eval_qa.EXPECTED[n])
            return {"answer": text, "sources": ["https://x"]}
        if n == eval_qa.TRAP_NO_DATA:
            return {"answer": "Chưa đủ dữ liệu để trả lời.", "sources": []}
        return {"answer": "Saphraton hỗ trợ bồi bổ sức khỏe.", "sources": []}
    return answer


@pytest.fixture
def chat_env(env, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key-not-real")
    return env


def test_chatbot_one_fact_miss_passes(chat_env, monkeypatch):
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(fail_ids={3}))
    assert ae.main(["--agent", "chatbot"]) == 0
    [row] = _runs(chat_env)
    assert row["passed"] is True and row["n_pass"] == row["n_total"] - 1
    assert row["model"] != "rules"


def test_chatbot_trap_guard_fail_blocks(chat_env, monkeypatch):
    monkeypatch.setattr(ae, "_rag_answer",
                        _fake_answer(fail_ids={eval_qa.TRAP_GUARD}))
    assert ae.main(["--agent", "chatbot"]) == 1
    [row] = _runs(chat_env)
    assert row["passed"] is False


def test_chatbot_health_handoff_scored(chat_env, monkeypatch, capsys):
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(fail_ids={"health"}))
    assert ae.main(["--agent", "chatbot"]) == 1
    out = capsys.readouterr().out
    assert "health-1" in out and "handoff=None" in out


def test_chatbot_exception_is_case_fail(chat_env, monkeypatch):
    base = _fake_answer()

    def answer(q):
        if q == eval_qa.load_questions()[1]:
            raise RuntimeError("boom")
        return base(q)
    monkeypatch.setattr(ae, "_rag_answer", answer)
    assert ae.main(["--agent", "chatbot"]) == 0  # 1 fact miss vẫn PASS
    assert _runs(chat_env)[0]["n_pass"] == 13


def test_chatbot_missing_key_no_insert(env, monkeypatch, capsys):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    called = []
    monkeypatch.setattr(ae, "_rag_answer", lambda q: called.append(q))
    assert ae.main(["--agent", "chatbot"]) == 1
    assert env["inserts"] == [] and called == []
    assert "OPENROUTER_API_KEY" in capsys.readouterr().out


def test_db_down_warns_nonzero(env, monkeypatch, capsys):
    def boom():
        raise psycopg.OperationalError("connection timeout")
    monkeypatch.setattr(ae, "_connect", boom)
    assert ae.main(["--agent", "guardrail"]) == 1
    out = capsys.readouterr().out
    assert "[warn]" in out and "Traceback" not in out


def test_bad_sha_exit_2(env):
    with pytest.raises(SystemExit) as e:
        ae.main(["--agent", "guardrail", "--sha", "abc123"])
    assert e.value.code == 2
    assert env["inserts"] == []


def test_bad_github_sha_env_exit_2(env, monkeypatch):
    monkeypatch.setenv("GITHUB_SHA", "not-a-sha")
    with pytest.raises(SystemExit) as e:
        ae.main(["--agent", "guardrail"])
    assert e.value.code == 2


def test_sha_must_match_head(env):
    assert ae.main(["--agent", "guardrail", "--sha", "b" * 40]) == 1
    assert env["inserts"] == []
    assert ae.main(["--agent", "guardrail", "--sha", SHA.upper()]) == 0
    assert _runs(env)[0]["commit_sha"] == SHA


def test_dirty_tree_refused_unless_allowed(env, monkeypatch):
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: True)
    assert ae.main(["--agent", "guardrail"]) == 1
    assert env["inserts"] == []
    assert ae.main(["--agent", "guardrail", "--allow-dirty"]) == 0
    assert _runs(env)[0]["commit_sha"] == SHA + "-dirty"


def test_git_unreadable_refused(env, monkeypatch):
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: None)
    assert ae.main(["--agent", "guardrail", "--allow-dirty"]) == 1
    monkeypatch.setattr(ae, "_git_head", lambda: None)
    assert ae.main(["--agent", "guardrail"]) == 1
    assert env["inserts"] == []


def test_no_record_skips_git_and_db(env, monkeypatch):
    monkeypatch.setattr(ae, "_git_head", lambda: pytest.fail("git"))
    monkeypatch.setattr(ae, "_connect", lambda: pytest.fail("db"))
    assert ae.main(["--agent", "guardrail", "--no-record"]) == 0


def test_prompt_version_ignores_crlf(tmp_path, monkeypatch):
    (tmp_path / "a.txt").write_bytes(b"x\ny\n")
    monkeypatch.setattr(ae, "ROOT", tmp_path)
    v1 = ae.prompt_version(["a.txt"])
    (tmp_path / "a.txt").write_bytes(b"x\r\ny\r\n")
    assert ae.prompt_version(["a.txt"]) == v1
    (tmp_path / "a.txt").write_bytes(b"x\ny\nz\n")
    assert ae.prompt_version(["a.txt"]) != v1


def test_fail_output_masks_pii(env, monkeypatch, capsys):
    cases = [{"id": "p", "text": "gọi 0901234567 mua thuốc", "expect": "pass",
              "kind": "pass", "scorer": "guardrail"}]
    suite = {**ae.load_suite("guardrail"), "cases": cases}
    monkeypatch.setattr(ae, "load_suite", lambda a: suite)
    ae.main(["--agent", "guardrail", "--no-record"])
    out = capsys.readouterr().out
    assert "0901234567" not in out and "[done]" in out


def test_chatbot_malformed_result_is_case_fail(chat_env, monkeypatch):
    """Lỗi khi CHẤM (result thiếu key) cũng chỉ FAIL ca đó, chạy tiếp."""
    base = _fake_answer()
    q1 = eval_qa.load_questions()[1]
    monkeypatch.setattr(ae, "_rag_answer",
                        lambda q: {"answer": "x"} if q == q1 else base(q))
    assert ae.main(["--agent", "chatbot"]) == 0
    assert _runs(chat_env)[0]["n_pass"] == 13


def test_chatbot_threshold_parity_eval_qa(chat_env, monkeypatch, capsys):
    """Ngưỡng chatbot ~ eval_qa >=10/12: trượt 2 fact PASS, 3 fact FAIL
    thuần vì pass_rate (không ca bắt buộc nào FAIL)."""
    suite = ae.load_suite("chatbot")
    acfg, cases = suite["threshold"], suite["cases"]
    n = len(cases)
    assert (n - 3) / n < acfg["min_pass_rate"] <= (n - 2) / n
    facts = sorted(eval_qa.EXPECTED)
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(set(facts[:2])))
    assert ae.main(["--agent", "chatbot"]) == 0
    assert _runs(chat_env)[-1]["passed"] is True
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(set(facts[:3])))
    assert ae.main(["--agent", "chatbot"]) == 1
    row = _runs(chat_env)[-1]
    assert row["passed"] is False and row["n_pass"] == n - 3
    assert "ca bắt buộc FAIL" not in capsys.readouterr().out
    s = ae.score([(c, c["id"] not in facts[:3], "") for c in cases], acfg)
    assert s["passed"] is False and s["trap_fail"] == []
    assert s["missing_kinds"] == []


@pytest.mark.skipif(shutil.which("git") is None, reason="không có git")
def test_git_dirty_and_head_real_repo(tmp_path, monkeypatch):
    """Chốt chống ghi PASS cho tree bẩn chạy git THẬT (không monkeypatch
    _git_head/_git_dirty): tracked sửa -> bẩn; untracked trong input
    harness -> bẩn; untracked ngoài input -> sạch."""
    def git(*a):
        subprocess.run(["git", "-C", str(tmp_path), "-c", "user.name=t",
                        "-c", "user.email=t@example.invalid", *a],
                       check=True, capture_output=True)
    (tmp_path / "data" / "eval").mkdir(parents=True)
    (tmp_path / "data" / "eval" / "x.jsonl").write_bytes(b"{}\n")
    (tmp_path / "other.txt").write_bytes(b"a\n")
    git("init", "-q")
    git("config", "core.autocrlf", "false")
    git("add", "-A")
    git("commit", "-q", "-m", "init")
    monkeypatch.setattr(ae, "ROOT", tmp_path)
    inputs = ["data/eval"]

    head = ae._git_head()
    assert head and ae.SHA_RE.fullmatch(head)
    assert ae._git_dirty(inputs) is False
    (tmp_path / "new.txt").write_bytes(b"x\n")  # untracked ngoài input
    assert ae._git_dirty(inputs) is False
    (tmp_path / "data" / "eval" / "new.jsonl").write_bytes(b"{}\n")
    assert ae._git_dirty(inputs) is True  # input harness chưa commit
    (tmp_path / "data" / "eval" / "new.jsonl").unlink()
    assert ae._git_dirty(inputs) is False
    (tmp_path / "other.txt").write_bytes(b"b\n")  # tracked ngoài input
    assert ae._git_dirty(inputs) is True
    monkeypatch.setattr(ae, "ROOT", tmp_path / "khong-ton-tai")
    assert ae._git_head() is None and ae._git_dirty(inputs) is None


# --- v9.5 W95.7 bộ ca MẪU co_khi ---------------------------------------------
def test_co_khi_cases_shape():
    docs, cases = _rows("co_khi")
    assert docs and "chờ kỹ sư trưởng sửa" in docs[0].casefold()
    assert len(cases) == 23
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids))
    kinds = [c["kind"] for c in cases]
    assert kinds.count("fact") == 17 and kinds.count("high_risk") == 3
    assert kinds.count("trap_no_data") == 3
    assert all(c["source"] == "MẪU" and c["text"].strip() for c in cases)
    for c in cases:
        if c["kind"] != "trap_no_data":
            assert (ae.CO_KHI_ROOT / c["expect_file"]).is_file(), c["id"]
            assert isinstance(c["expect_page"], int) and c["expect_page"] >= 1
    cfg = ae.load_config()
    assert "co_khi" in ae.suite_names() and \
        "co_khi" not in cfg["required_agents"]
    assert ae.load_suite("co_khi")["threshold"]["min_pass_rate"] == 0.9


def test_co_khi_runner_local_deterministic_and_threshold():
    _, cases = _rows("co_khi")
    acfg = ae.load_suite("co_khi")["threshold"]
    r1 = ae.run_co_khi(cases)
    r2 = ae.run_co_khi(cases)
    assert [(c["id"], ok, d) for c, ok, d in r1] == \
        [(c["id"], ok, d) for c, ok, d in r2]
    s = ae.score(r1, acfg)
    assert s["passed"] is True and s["trap_fail"] == []
    assert all(ok for c, ok, _ in r1 if c["kind"] != "fact")


def test_co_khi_trap_fail_scored_failed(monkeypatch):
    from agents import ck_mat
    _, cases = _rows("co_khi")
    trap = next(c for c in cases if c["kind"] == "trap_no_data")
    fake = {"answer": "Máy SS-EQ-99 bảo trì mỗi 30 ngày", "high_risk": False,
            "sources": [{"file": "x.md", "page": 1}]}
    monkeypatch.setattr(ck_mat, "ask", lambda *a, **k: fake)
    res = ae.run_co_khi([trap])
    assert res[0][1] is False
    # tài liệu MẬT: answer KHÔNG được lọt vào detail FAIL (stdout/CI log)
    assert "SS-EQ-99" not in res[0][2] and "answer=" not in res[0][2]
    s = ae.score(res + [(c, True, "") for c in cases if c is not trap],
                 ae.load_suite("co_khi")["threshold"])
    assert s["passed"] is False and s["trap_fail"] == [trap["id"]]


def test_co_khi_cli_no_record_twice_identical():
    cmd = [sys.executable, str(ROOT / "scripts" / "agent_eval.py"), "--agent",
           "co_khi", "--no-record"]
    outs = [subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=120,
                           check=False) for _ in range(2)]
    assert [o.returncode for o in outs] == [0, 0]
    assert outs[0].stdout == outs[1].stdout
    assert b"co_khi v1 PASS 21/23" in outs[0].stdout and b"/23" in outs[0].stdout
    assert b"model=rules" in outs[0].stdout
    assert b"answer=" not in outs[0].stdout  # 2 ca FAIL không in answer MẬT


# --- v4.5i tích hợp: runner guardrail ctx/code + co_khi trong format suite ---

def test_runners_single_source_and_same_signature():
    """RUNNER_SCORERS là nguồn duy nhất tên runner; mọi runner gọi được
    với (cases, None) — _score_and_record truyền judge_model."""
    assert ae.RUNNERS.keys() == ae.RUNNER_SCORERS.keys()
    # gộp M31 đợt 4: + mkt02 (v6.1) + sales_director (v5.0) — đều luật;
    # gộp đợt 5: + cskh (v5.1, gateway giả — tất định); gộp v6.2: + mkt03
    # (provider giả eval_stub — tất định); v5.3: + kd_a5 (luật giá/KM).
    assert set(ae.DETERMINISTIC_RUNNERS) == {"guardrail", "co_khi", "mkt02",
                                             "mkt03", "sales_director",
                                             "cskh", "kd_a5"}
    assert not hasattr(ae, "RULE_AGENTS")
    for name, fn in ae.RUNNERS.items():
        if name == "chatbot":
            continue  # RAG thật — chữ ký kiểm qua test chatbot fake
        d = ae.load_suite("kd_a1" if name == "cskh" else name)
        [(c, ok, _)] = fn(d["cases"][:1], None)
        assert c is d["cases"][0] and isinstance(ok, bool), name


def test_guardrail_ctx_uses_check_publish_and_code_must_match(monkeypatch):
    """v4.1: ca có ctx → check_publish(text, **ctx); ca block có code chỉ
    pass khi bị chặn ĐÚNG code — chặn bằng code khác = FAIL."""
    calls = []

    def fake_publish(text, **ctx):
        calls.append(ctx)
        return {"ok": False, "violations": [
            {"code": "tu_cam", "detail": "từ cấm"}]}
    monkeypatch.setattr(guardrail, "check_publish", fake_publish)
    base = {"text": "x", "kind": "trap_critical", "expect": "block",
            "scorer": "guardrail", "ctx": {"channel": "shopee"}}
    good = {**base, "id": "g", "code": "tu_cam"}
    wrong = {**base, "id": "w", "code": "sku_chua_xnqc"}
    nocode = {**base, "id": "n"}
    res = {c["id"]: (ok, d) for c, ok, d in
           ae.run_guardrail([good, wrong, nocode])}
    assert calls == [{"channel": "shopee"}] * 3
    assert res["g"] == (True, "") and res["n"] == (True, "")
    ok, detail = res["w"]
    assert ok is False and "(sku_chua_xnqc)" in detail
    assert "tu_cam: từ cấm" in detail


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.update(ctx={"channel": "shopee", "x": 1}), "ctx key lạ"),
    (lambda c: c.update(ctx={"content_type": "ads"}), "thiếu channel"),
    (lambda c: c.update(ctx="shopee"), "ctx phải object"),
    (lambda c: c.update(expect="pass", code="tu_cam"),
     "code chỉ đi với expect block"),
    (lambda c: c.update(code=""), "code phải chuỗi"),
])
def test_validate_guardrail_ctx_and_code(mutate, needle):
    d = ae.load_suite("guardrail")
    c = next(dict(x) for x in d["cases"] if x["expect"] == "block")
    mutate(c)
    errs = ae._validate_case(c, 0, d)
    assert any(needle in e for e in errs), errs


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.update(expect_file="khong-co.md"), "expect_file"),
    (lambda c: c.update(expect_file="../mau/may-co-mang-ss-eq-03.md"),
     "expect_file"),
    (lambda c: c.update(expect_page=0), "expect_page"),
    (lambda c: c.update(expect_page=True), "expect_page"),
    (lambda c: c.update(expect="pass"), "expect phải null"),
    (lambda c: c.update(kind="other"), "kind phải"),
    (lambda c: c.update(kind="trap_no_data"), "trap_no_data không có"),
])
def test_validate_co_khi_case(mutate, needle):
    d = ae.load_suite("co_khi")
    c = dict(next(x for x in d["cases"] if x["kind"] == "fact"))
    assert ae._validate_case(c, 0, d) == []
    mutate(c)
    errs = ae._validate_case(c, 0, d)
    assert any(needle in e for e in errs), errs


# --- v6.1 W61.5 mkt02 (Agent Content & Listing) ----------------------------
# Gộp M31 đợt 4: bộ ca chuyển từ data/eval/mkt02.jsonl sang suite v4.5
# (data/eval/suites/mkt02.json) — giữ nguyên 14 ca + mọi assert v6.1.

def _mkt02_counting_client(monkeypatch):
    """Gateway giả đếm call — runner mkt02 phải 0 call (kể cả khi env bật
    lớp LLM-check)."""
    import types

    from pipelines import llm_gateway

    calls = []

    def _create(**kw):
        calls.append(kw)
        raise AssertionError("mkt02 runner không được gọi LLM")

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("GUARDRAIL_LLM_MODEL", "google/gemini-test")
    monkeypatch.setattr(llm_gateway, "_client", lambda: types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create))))
    return calls


def _patched_suite(monkeypatch, agent, cases):
    """Suite `agent` với bộ ca đã sửa — bỏ qua chốt hash (thay cho
    monkeypatch `load_cases` của bản jsonl v6.1/v5.0)."""
    d = {**ae.load_suite(agent), "cases": cases}
    monkeypatch.setattr(ae, "load_suite", lambda name, base=None: d)


def test_mkt02_cases_shape_and_unapproved():
    docs, cases = _rows("mkt02")
    assert docs and "chưa được công ty duyệt" in docs[0].casefold()
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)) and len(cases) >= 12
    assert len(cases) == 14   # chuyển nguyên văn từ jsonl v6.1
    kinds = [c["kind"] for c in cases]
    assert kinds.count("golden_exact") == 7
    assert kinds.count("trap_alcohol") >= 2
    assert kinds.count("trap_readiness") >= 2
    assert kinds.count("trap_xnqc") >= 1
    assert all(c.get("label_status") for c in cases)
    alc = [c for c in cases if c["kind"] == "trap_alcohol"]
    assert len({c["sku"] for c in alc}) >= 2
    assert any(c.get("readiness") for c in alc)     # map tiêm QC_DAY_DU
    # format suite: scorer/label thêm khi chuyển, ca không có text
    assert all(c["scorer"] == "mkt02" and c["label"] == "dev_draft"
               and "text" not in c for c in cases)
    d = ae.load_suite("mkt02")
    assert ae.validate_suite(d, EVAL_DIR / "suites" / "mkt02.json") == []
    assert (d["owner_block"], d["runner"], d["agent_model"], d["status"],
            d["frozen"]) == ("marketing", "mkt02", "rules", "active", False)
    assert d["threshold"] == {"min_pass_rate": 1.0, "must_pass_kinds": [
        "golden_exact", "trap_alcohol", "trap_readiness", "trap_xnqc"]}
    assert "mkt02" not in ae.load_config()["required_agents"]
    assert not (EVAL_DIR / "mkt02.jsonl").exists()


def test_mkt02_runner_all_pass_zero_llm_calls(env, monkeypatch, capsys):
    import os

    calls = _mkt02_counting_client(monkeypatch)
    _, cases = _rows("mkt02")
    res = ae.run_mkt02(cases)
    assert [(c["id"], d) for c, ok, d in res if not ok] == []
    assert calls == []
    assert os.environ["GUARDRAIL_LLM_MODEL"] == "google/gemini-test"
    assert ae.main(["--agent", "mkt02", "--no-record"]) == 0
    out = capsys.readouterr().out
    assert "[done] mkt02 v1 PASS 14/14" in out and "model=rules" in out
    assert calls == []


def test_mkt02_flipped_alcohol_case_fails(env, monkeypatch, capsys):
    _, cases = _rows("mkt02")
    cases = [dict(c) for c in cases]
    for c in cases:
        if c["kind"] == "trap_alcohol":
            c["expect"] = "listing"
            break
    _patched_suite(monkeypatch, "mkt02", cases)
    assert ae.main(["--agent", "mkt02", "--no-record"]) == 1
    out = capsys.readouterr().out
    assert "FAIL (trap_alcohol)" in out and "ruou" in out
    # ca không có text → dòng FAIL in "sku × kênh"
    assert f'text="{c["sku"]} × {c["channel"]}"' in out


def test_mkt02_missing_required_kind_fails(env, monkeypatch, capsys):
    _, cases = _rows("mkt02")
    cases = [c for c in cases if c["kind"] != "trap_xnqc"]
    _patched_suite(monkeypatch, "mkt02", cases)
    assert ae.main(["--agent", "mkt02", "--no-record"]) == 1
    assert "trap_xnqc" in capsys.readouterr().out


def test_mkt02_golden_mismatch_fails():
    """Ca golden_exact với SKU khác -> fields lệch golden -> FAIL."""
    _, cases = _rows("mkt02")
    c = dict(next(c for c in cases if c["kind"] == "golden_exact"))
    good = ae.run_mkt02([c])
    assert good[0][1] is True
    gold = {"sku_key": c["sku"], "name": "TÊN KHÁC", "category": "tpbvsk",
            "pack_spec": "x", "receipt_no": None, "prices": {}}
    r = {"ok": True, "guardrail": {"violations": []},
         "fields": {"name": "a", "pack_spec": "x", "receipt_no": None,
                    "price": "Liên hệ"}, "text": "Quy cách: x"}
    assert "name" in ae._golden_exact(c, r, {c["sku"]: gold})


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.update(op="post"), "op phải"),
    (lambda c: c.pop("sku"), "thiếu 'sku'"),
    (lambda c: c.update(expect="pass"), "expect phải listing|refuse"),
    (lambda c: c.update(expect="refuse"), "ca refuse cần code"),
    (lambda c: c.update(code="ruou"), "code chỉ đi với expect refuse"),
    (lambda c: c.update(readiness=[["a", "b"]]), "readiness phải"),
    (lambda c: c.pop("source"), "thiếu 'source'"),
    (lambda c: c.update(text=""), "thiếu 'text'"),
])
def test_validate_mkt02_case(mutate, needle):
    """Ca mkt02 hợp lệ không cần `text`; có `text` thì phải khác rỗng."""
    d = ae.load_suite("mkt02")
    c = dict(next(x for x in d["cases"] if x["kind"] == "golden_exact"))
    assert ae._validate_case(c, 0, d) == []
    mutate(c)
    errs = ae._validate_case(c, 0, d)
    assert any(needle in e for e in errs), errs


# --- v6.2 W62.5 mkt03 (Agent Ảnh AI) ---------------------------------------
# Gộp v6.2 vào ai-infra: bộ ca chuyển từ data/eval/mkt03.jsonl sang suite
# v4.5 (data/eval/suites/mkt03.json) — giữ nguyên 15 ca + mọi assert v6.2.

MKT03_KINDS = {"ai_label_meta", "packshot_intact", "tamper_detect", "no_exif",
               "trap_alcohol", "trap_tpbvsk_maket", "trap_prompt",
               "trap_readiness", "trap_headline"}


def test_mkt03_cases_shape_and_unapproved():
    docs, cases = _rows("mkt03")
    d = docs[0]
    assert "chưa được công ty duyệt" in d.casefold()
    assert "chờ GĐ Marketing/Pháp chế duyệt nhãn" in d
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)) and len(cases) >= 14
    assert len(cases) == 15   # chuyển nguyên văn từ jsonl v6.2
    kinds = [c["kind"] for c in cases]
    assert set(kinds) == MKT03_KINDS
    ai = [c for c in cases if c["kind"] == "ai_label_meta"]
    assert len(ai) == 4 and {c["format"] for c in ai} == {
        "1:1", "4:5", "9:16", "banner"}
    assert all(c["provider"] == "eval_stub" for c in ai)
    assert kinds.count("trap_alcohol") >= 2
    assert any(c.get("readiness") for c in cases
               if c["kind"] == "trap_alcohol")          # map tiêm QC_DAY_DU
    assert any(c.get("scene") == "bác sĩ áo blouse cầm sản phẩm"
               for c in cases if c["kind"] == "trap_prompt")
    assert any(c["sku"] == "sapentol-30v" and c["format"] == "banner"
               for c in cases if c["kind"] == "trap_tpbvsk_maket")
    assert all(c.get("label_status") for c in cases)
    # format suite: scorer/label/source thêm khi chuyển, ca không có text
    assert all(c["scorer"] == "mkt03" and c["label"] == "dev_draft"
               and "text" not in c for c in cases)
    s = ae.load_suite("mkt03")
    assert ae.validate_suite(s, EVAL_DIR / "suites" / "mkt03.json") == []
    assert (s["owner_block"], s["runner"], s["agent_model"], s["status"],
            s["frozen"], s["labeled_by"]) == (
        "marketing", "mkt03", "rules", "active", False, None)
    # ngưỡng v6.2 (config.json "agents.mkt03") chuyển vào threshold suite
    assert set(s["threshold"]["must_pass_kinds"]) == MKT03_KINDS
    assert s["threshold"]["min_pass_rate"] == 1.0
    assert "mkt03" not in ae.load_config()["required_agents"]
    assert not (EVAL_DIR / "mkt03.jsonl").exists()


def test_mkt03_runner_all_pass_zero_llm_and_stub_removed(env, monkeypatch,
                                                         capsys):
    import os

    from pipelines import image_studio as ims

    calls = _mkt02_counting_client(monkeypatch)   # bật GUARDRAIL_LLM_MODEL
    before = dict(ims.PROVIDERS)
    _, cases = _rows("mkt03")
    res = ae.run_mkt03(cases)
    assert [(c["id"], d) for c, ok, d in res if not ok] == []
    assert calls == [] and ims.PROVIDERS == before
    assert os.environ["GUARDRAIL_LLM_MODEL"] == "google/gemini-test"
    assert ae.main(["--agent", "mkt03", "--no-record"]) == 0
    out = capsys.readouterr().out
    assert "[done] mkt03 v1 PASS 15/15" in out and "model=rules" in out
    assert calls == [] and ims.PROVIDERS == before


def test_mkt03_flipped_alcohol_case_fails(env, monkeypatch, capsys):
    _, cases = _rows("mkt03")
    cases = [dict(c) for c in cases]
    c = next(c for c in cases if c["kind"] == "trap_alcohol")
    c["expect"] = "image"
    _patched_suite(monkeypatch, "mkt03", cases)
    assert ae.main(["--agent", "mkt03", "--no-record"]) == 1
    out = capsys.readouterr().out
    assert "FAIL (trap_alcohol)" in out and "ruou" in out
    # ca không có text → dòng FAIL in "sku × kênh"
    assert f'text="{c["sku"]} × {c["channel"]}"' in out


@pytest.mark.parametrize("kind", ["trap_tpbvsk_maket", "tamper_detect"])
def test_mkt03_missing_required_kind_fails(env, monkeypatch, capsys, kind):
    _, cases = _rows("mkt03")
    cases = [c for c in cases if c["kind"] != kind]
    _patched_suite(monkeypatch, "mkt03", cases)
    assert ae.main(["--agent", "mkt03", "--no-record"]) == 1
    assert kind in capsys.readouterr().out


def test_mkt03_unlabeled_image_fails(env, monkeypatch, capsys):
    """Ảnh thiếu nhãn AI đứng đầu (labels bị đổi) -> ca ai_label_meta FAIL."""
    from pipelines import image_studio as ims

    real = ims.compose

    def no_label(*a, **k):
        r = real(*a, **k)
        if r["ok"]:
            r["meta"] = {**r["meta"], "labels": r["meta"]["labels"][1:]}
        return r

    monkeypatch.setattr(ims, "compose", no_label)
    _, cases = _rows("mkt03")
    res = ae.run_mkt03([c for c in cases if c["kind"] == "ai_label_meta"])
    assert res and not any(ok for _, ok, _ in res)
    assert all("nhãn AI" in d for _, _, d in res)


def test_mkt03_plate_without_label_text_fails(env, monkeypatch):
    """Nghiệm thu v6.2: đột biến bỏ CHỮ nhãn, giữ tấm nền (meta/text_layer
    vẫn có nhãn) — kiểm cũ "vùng nhãn khác nền" chấm 4/4 PASS; kiểm pixel
    màu chữ nhãn phải FAIL cả 4 format."""
    from PIL import ImageDraw

    from pipelines import content

    ai = content._publish_texts()[1][0]
    real = ImageDraw.ImageDraw.multiline_text

    def no_label(self, xy, text, *a, **kw):
        if ai in text:
            return None
        return real(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "multiline_text", no_label)
    _, cases = _rows("mkt03")
    res = ae.run_mkt03([c for c in cases if c["kind"] == "ai_label_meta"])
    assert len(res) == 4 and not any(ok for _, ok, _ in res)
    assert all("không có chữ nhãn" in d for _, _, d in res), res


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.pop("headline"), "thiếu 'headline'"),
    (lambda c: c.update(format=""), "thiếu 'format'"),
    (lambda c: c.update(provider="openai"), "provider phải"),
    (lambda c: c.update(scene=""), "scene phải"),
    (lambda c: c.update(packshot_exif="yes"), "packshot_exif phải bool"),
    (lambda c: c.update(expect="pass"), "expect phải image|refuse"),
    (lambda c: c.update(expect="refuse"), "ca refuse cần code"),
    (lambda c: c.update(code="ruou"), "code chỉ đi với expect refuse"),
    (lambda c: c.update(kind="trap_alcohol"), "ca image cần kind"),
    (lambda c: c.update(readiness=[["a", "b"]]), "readiness phải"),
    (lambda c: c.pop("source"), "thiếu 'source'"),
    (lambda c: c.update(text=""), "thiếu 'text'"),
])
def test_validate_mkt03_case(mutate, needle):
    """Ca mkt03 hợp lệ không cần `text`; provider chỉ none|eval_stub (runner
    tất định — không kéo provider thật/mạng)."""
    d = ae.load_suite("mkt03")
    c = dict(next(x for x in d["cases"] if x["kind"] == "ai_label_meta"))
    assert ae._validate_case(c, 0, d) == []
    mutate(c)
    errs = ae._validate_case(c, 0, d)
    assert any(needle in e for e in errs), errs


# --- v5.0 W50.8 bộ ca MẪU sales_director --------------------------------------
# Gộp M31 đợt 4: chuyển từ data/eval/sales_director.jsonl sang suite v4.5.

def test_sales_director_cases_shape():
    docs, cases = _rows("sales_director")
    assert docs and "chờ gđ kd sửa" in docs[0].casefold()
    assert len(cases) >= 20
    assert len(cases) == 26   # chuyển nguyên văn từ jsonl v5.0
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids))
    kinds = [c["kind"] for c in cases]
    assert kinds.count("trap_offhours") >= 6 and "trap_no_auto" in kinds
    assert {"route", "sla"} <= set(kinds)
    assert all(c["text"].strip() and c["expect"] for c in cases)
    cfg = ae.load_config()
    d = ae.load_suite("sales_director")
    acfg = d["threshold"]
    assert "sales_director" not in cfg["required_agents"]
    assert acfg["min_pass_rate"] == 1.0
    assert acfg["must_pass_kinds"] == ["trap_offhours", "trap_no_auto"]
    # thay `RULE_AGENTS` (bỏ ở v4.5i): runner tất định + chấm bằng luật
    assert "sales_director" in ae.DETERMINISTIC_RUNNERS
    assert (d["owner_block"], d["agent_model"], d["judge"]) == (
        "sales", "rules", None)
    assert not (EVAL_DIR / "sales_director.jsonl").exists()


def test_sales_director_runner_deterministic_pass():
    _, cases = _rows("sales_director")
    acfg = ae.load_suite("sales_director")["threshold"]
    r1 = ae.run_sales_director(cases)
    r2 = ae.run_sales_director(cases)
    assert [(c["id"], ok, d) for c, ok, d in r1] == \
        [(c["id"], ok, d) for c, ok, d in r2]
    s = ae.score(r1, acfg)
    assert s["passed"] is True and s["n_pass"] == len(cases), [
        (c["id"], d) for c, ok, d in r1 if not ok]


def test_sales_director_wrong_offhours_expectation_fails():
    _, cases = _rows("sales_director")
    trap = next(c for c in cases if c["kind"] == "trap_offhours"
                and c["expect"]["state"] == "on_time")
    bad = dict(trap, expect=dict(trap["expect"], state="overdue"))
    res = ae.run_sales_director([bad])
    assert res[0][1] is False
    s = ae.score(res + [(c, True, "") for c in cases if c is not trap],
                 ae.load_suite("sales_director")["threshold"])
    assert s["passed"] is False and s["trap_fail"] == [trap["id"]]


def test_sales_director_cli_no_record_twice_identical():
    _, cases = _rows("sales_director")
    cmd = [sys.executable, str(ROOT / "scripts" / "agent_eval.py"), "--agent",
           "sales_director", "--no-record"]
    outs = [subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=120,
                           check=False) for _ in range(2)]
    assert [o.returncode for o in outs] == [0, 0]
    assert outs[0].stdout == outs[1].stdout
    assert b"sales_director v1 PASS" in outs[0].stdout
    assert f"/{len(cases)} ".encode() in outs[0].stdout
    assert b"model=rules" in outs[0].stdout


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c.update(kind="other"), "kind phải"),
    (lambda c: c.update(expect={}), "expect phải object"),
    (lambda c: c.update(now="2026-10-12T09:00"), "ISO có múi giờ"),
    (lambda c: c.pop("object_type"), "cần object_type hoặc severity"),
    (lambda c: c.update(expect={"business_due_at": "2026-10-12T10:00+07:00"}),
     "expect thiếu state"),
])
def test_validate_sales_director_case(mutate, needle):
    d = ae.load_suite("sales_director")
    c = dict(next(x for x in d["cases"] if x["kind"] == "sla"))
    assert ae._validate_case(c, 0, d) == []
    mutate(c)
    errs = ae._validate_case(c, 0, d)
    assert any(needle in e for e in errs), errs
