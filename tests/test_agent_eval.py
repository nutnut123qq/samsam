"""W35.1 + W35.3 — bộ ca data/eval + harness scripts/agent_eval.py.

DB qua fake conn, git qua monkeypatch, RAG qua fake answer — không mạng,
không LLM, không wall-clock."""
import json
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


def _rows(name: str) -> tuple[list[dict], list[dict]]:
    lines = [json.loads(line) for line in (EVAL_DIR / name).read_text(
        encoding="utf-8").split("\n") if line.strip()]
    return ([r for r in lines if "_doc" in r],
            [r for r in lines if "_doc" not in r])


# --- W35.1 bộ ca + config ---------------------------------------------------

@pytest.mark.parametrize("name", ["guardrail.jsonl", "chatbot.jsonl"])
def test_case_files_parse_unique_and_unapproved(name):
    docs, cases = _rows(name)
    assert docs and "chưa được công ty duyệt" in docs[0]["_doc"].casefold()
    ids = [str(c["id"]) for c in cases]
    assert len(ids) == len(set(ids)), "id trùng"
    assert all(c["text"].strip() and c.get("kind") for c in cases)
    assert ae.load_cases(EVAL_DIR / name) == cases


def test_chatbot_cases_match_questions_md():
    _, cases = _rows("chatbot.jsonl")
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

    _, cases = _rows("guardrail.jsonl")
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
    """v4.1 (FLIP có chủ đích, trước: 100% khớp expect): nhãn bộ ca ghi
    theo Ý ĐỊNH pháp lý, ca biên được phép fail — mọi ca thuộc kind bắt
    buộc (trap_block/trap_critical/trap_disclaimer) pass + tổng >= ngưỡng."""
    _, cases = _rows("guardrail.jsonl")
    res = ae.run_guardrail(cases)
    must = ae.load_config()["agents"]["guardrail"]["must_pass_kinds"]
    bad = [(c["id"], d) for c, ok, d in res if not ok and c["kind"] in must]
    assert not bad, bad
    assert sum(ok for _, ok, _ in res) / len(res) >= 0.95
    # Ca fail CÓ CHỦ ĐÍCH (lý do ở evidence/v41_eval.log) — ca pass/edge
    # khác hồi quy thì đỏ ngay, không trốn trong biên 5%. Thêm ca fail mới
    # phải ghi rõ vào đây + evidence.
    known = {"v41-edge-01", "v41-edge-02"}
    assert {c["id"] for c, ok, _ in res if not ok} <= known


def test_config_thresholds_and_trap_kinds():
    cfg = ae.load_config()
    assert cfg["required_agents"] == ["guardrail", "chatbot"]
    assert cfg["approvers"] == []  # external-dep: chưa ai được cấp quyền
    # v4.0: lịch đóng băng chỉ ở data/freeze_calendar.json (1 nguồn).
    assert "freeze" not in cfg
    assert "người duyệt" in cfg["_doc"]
    for agent, acfg in cfg["agents"].items():
        _, cases = _rows(Path(acfg["cases"]).name)
        traps = {c["kind"] for c in cases if c["kind"].startswith("trap_")}
        assert traps == set(acfg["must_pass_kinds"]), agent
        for f in acfg["prompt_files"]:
            assert (ROOT / f).is_file(), f
    assert cfg["agents"]["guardrail"]["min_pass_rate"] == 0.95


# --- W35.3 harness ----------------------------------------------------------

class FakeConn:
    def __init__(self, sink):
        self.sink = sink
        self.committed = False

    def execute(self, sql, params=None):
        self.sink.append((sql, params))

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
    [(sql, row)] = env["inserts"]
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
    [(_, row)] = env["inserts"]
    assert row["passed"] is False  # FAIL vẫn được ghi (deploy thấy FAIL)
    out = capsys.readouterr().out
    assert "core-dieu-tri" in out and "FAIL" in out


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
    [(_, row)] = chat_env["inserts"]
    assert row["passed"] is True and row["n_pass"] == row["n_total"] - 1
    assert row["model"] != "rules"


def test_chatbot_trap_guard_fail_blocks(chat_env, monkeypatch):
    monkeypatch.setattr(ae, "_rag_answer",
                        _fake_answer(fail_ids={eval_qa.TRAP_GUARD}))
    assert ae.main(["--agent", "chatbot"]) == 1
    [(_, row)] = chat_env["inserts"]
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
    assert chat_env["inserts"][0][1]["n_pass"] == 13


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
    assert env["inserts"][0][1]["commit_sha"] == SHA


def test_dirty_tree_refused_unless_allowed(env, monkeypatch):
    monkeypatch.setattr(ae, "_git_dirty", lambda inputs: True)
    assert ae.main(["--agent", "guardrail"]) == 1
    assert env["inserts"] == []
    assert ae.main(["--agent", "guardrail", "--allow-dirty"]) == 0
    assert env["inserts"][0][1]["commit_sha"] == SHA + "-dirty"


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
              "kind": "pass"}]
    monkeypatch.setattr(ae, "load_cases", lambda p: cases)
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
    assert chat_env["inserts"][0][1]["n_pass"] == 13


def test_chatbot_threshold_parity_eval_qa(chat_env, monkeypatch, capsys):
    """Ngưỡng chatbot ~ eval_qa >=10/12: trượt 2 fact PASS, 3 fact FAIL
    thuần vì pass_rate (không ca bắt buộc nào FAIL)."""
    acfg = ae.load_config()["agents"]["chatbot"]
    cases = ae.load_cases(ROOT / acfg["cases"])
    n = len(cases)
    assert (n - 3) / n < acfg["min_pass_rate"] <= (n - 2) / n
    facts = sorted(eval_qa.EXPECTED)
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(set(facts[:2])))
    assert ae.main(["--agent", "chatbot"]) == 0
    assert chat_env["inserts"][-1][1]["passed"] is True
    monkeypatch.setattr(ae, "_rag_answer", _fake_answer(set(facts[:3])))
    assert ae.main(["--agent", "chatbot"]) == 1
    row = chat_env["inserts"][-1][1]
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
