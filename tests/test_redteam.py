"""v4.2 W42.6 — bộ red-team PC-A9 `data/eval/redteam.jsonl` +
`scripts/redteam.py` (bộ cố định không LLM; --generate qua gateway GIẢ).
Ký tự vô hình/homoglyph trong jsonl viết escape. Không wall-clock."""

import json
import sys
import types
from collections import Counter
from pathlib import Path

import pytest

from pipelines import llm_gateway

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import redteam

CASES = ROOT / "data" / "eval" / "redteam.jsonl"


def _rows():
    return [json.loads(line) for line in
            CASES.read_text(encoding="utf-8").split("\n") if line.strip()]


def _write(tmp_path, rows) -> Path:
    p = tmp_path / "rt.jsonl"
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n"
                         for r in rows), encoding="utf-8")
    return p


def test_fixed_set_schema_and_counts():
    rows = _rows()
    assert "chờ pháp chế duyệt nhãn" in rows[0]["_doc"].casefold()
    cases = redteam.load_cases(CASES)
    assert len(cases) >= 40
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids))
    by = Counter(c["attack"] for c in cases)
    assert set(by) == set(redteam.ATTACKS)
    assert all(n >= 4 for n in by.values()), by
    assert sum(c["severity"] == "critical" for c in cases) >= 20
    assert all(c["label_status"] == "chờ Pháp chế duyệt nhãn"
               for c in cases)
    # Không literal ký tự vô hình/homoglyph trong file (viết escape).
    raw = CASES.read_text(encoding="utf-8")
    for bad in ("\u200b", "\u0441", "\u043e", "\U0001f48a", "\u2009"):
        assert bad not in raw, repr(bad)


def test_main_fixed_exit0(capsys):
    assert redteam.main([]) == 0
    out = capsys.readouterr().out
    assert "tỷ lệ lọt:" in out and "[done] redteam PASS" in out


def test_critical_cases_blocked_or_known_gap():
    for c in redteam.load_cases(CASES):
        if c["severity"] != "critical":
            continue
        blocked, _ = redteam.judge(c["text"], redteam._ctx(c), c["code"])
        assert blocked or c.get("known_gap"), c["id"]


def test_removing_known_gap_of_leak_exits_1(tmp_path, capsys):
    rows = _rows()
    i = next(i for i, r in enumerate(rows) if "known_gap" in r)
    gid = rows[i]["id"]
    del rows[i]["known_gap"]
    assert redteam.main(["--cases", str(_write(tmp_path, rows))]) == 1
    assert f"[LỌT] {gid}" in capsys.readouterr().out


def test_known_gap_on_blocked_case_is_stale_exit_1(tmp_path, capsys):
    rows = _rows()
    i = next(i for i, r in enumerate(rows)
             if "id" in r and "known_gap" not in r)
    rows[i]["known_gap"] = "nhãn cũ"
    assert redteam.main(["--cases", str(_write(tmp_path, rows))]) == 1
    assert f"[STALE] {rows[i]['id']}" in capsys.readouterr().out


@pytest.mark.parametrize("mut", [
    lambda r: r.update(attack="la"), lambda r: r.update(severity="minor"),
    lambda r: r.pop("code"), lambda r: r.update(ctx={"kenh": "web"}),
    lambda r: r.update(known_gap=" "), lambda r: r.pop("label_status"),
    lambda r: r.update(text="")])
def test_schema_errors_exit_2(tmp_path, mut):
    rows = _rows()
    mut(rows[1])
    assert redteam.main(["--cases", str(_write(tmp_path, rows))]) == 2


def test_bad_file_exit_2(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text("{hỏng\n", encoding="utf-8")
    assert redteam.main(["--cases", str(p)]) == 2
    assert redteam.main(["--cases", str(tmp_path / "missing.jsonl")]) == 2
    rows = _rows()
    rows.append(dict(rows[1]))                                 # id trùng
    assert redteam.main(["--cases", str(_write(tmp_path, rows))]) == 2


class _Fake:
    def __init__(self, log, replies):
        self.log, self.replies = log, replies
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create))

    def _create(self, model=None, messages=None, **kw):
        self.log.append(model)
        r = self.replies[(len(self.log) - 1) % len(self.replies)]
        if isinstance(r, BaseException):
            raise r
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(content=r))], usage=None)


@pytest.fixture
def gen(monkeypatch):
    log, agents = [], []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    real_gate = llm_gateway._gate

    def spy(agent_id):
        agents.append(agent_id)
        return real_gate(agent_id)
    monkeypatch.setattr(llm_gateway, "_gate", spy)

    def set_replies(*replies):
        monkeypatch.setattr(llm_gateway, "_client",
                            lambda: _Fake(log, list(replies)))
        return log
    set_replies.agents = agents
    return set_replies


@pytest.mark.parametrize("n", ["0", "21", "-1"])
def test_generate_out_of_range_exit2_no_call(gen, monkeypatch, n):
    log = gen("[]")
    monkeypatch.setenv("REDTEAM_MODEL", "google/x")
    assert redteam.main(["--generate", n]) == 2
    assert log == []


@pytest.mark.parametrize("model", ["openai/x", "OpenAI/gpt-4o", "", "noslash"])
def test_generate_same_family_or_missing_model_exit2(gen, monkeypatch,
                                                     model):
    log = gen("[]")
    monkeypatch.setenv("REDTEAM_MODEL", model)
    assert redteam.main(["--generate", "3"]) == 2
    assert log == []
    # Họ content đổi theo OR_CHAT_MODEL.
    monkeypatch.setenv("OR_CHAT_MODEL", "google/gemini-x")
    assert redteam.main(["--generate", "1", "--model", "google/y"]) == 2
    assert log == []


def test_generate_junk_and_leak_reported_exit0(gen, tmp_path, capsys):
    leak = "Sâm Sâm natural medicine. Nội dung có sử dụng AI."
    blocked = "Sâm Sâm chữa mất ngủ. Nội dung có sử dụng AI."
    log = gen("không phải json", json.dumps([leak, blocked],
                                            ensure_ascii=False),
              RuntimeError("boom"), '```json\n["' + blocked + '"]\n```')
    out = tmp_path / "gen.jsonl"
    rc = redteam.main(["--generate", "4", "--model", "google/x",
                       "--out", str(out)])
    assert rc == 0
    text = capsys.readouterr().out
    assert "phản hồi hỏng 1" in text and "[LỌT]" in text
    assert log == ["google/x"] * 4
    assert set(gen.agents) == {"redteam"}
    rows = [json.loads(line) for line in out.read_text(
        encoding="utf-8").split("\n") if line.strip()]
    assert [r["blocked"] for r in rows] == [False, True, True]
    assert all(r["source"] == "llm:google/x" for r in rows)
    # Bộ chính thức không bị đụng.
    assert redteam.load_cases(CASES)


def test_generate_all_fail_exit1_and_blocked_stops(gen, monkeypatch, capsys):
    log = gen("rác", "[]", '{"a": 1}')
    assert redteam.main(["--generate", "3", "--model", "google/x"]) == 1
    assert len(log) == 3
    log2 = gen('["x"]')
    monkeypatch.setenv("LLM_KILL", "redteam")
    assert redteam.main(["--generate", "5", "--model", "google/x"]) == 1
    assert "dừng sớm" in capsys.readouterr().out
    assert len(log2) == 3                       # không thêm call nào


def test_generate_refuses_out_to_official_set(gen):
    log = gen("[]")
    assert redteam.main(["--generate", "1", "--model", "google/x",
                         "--out", str(CASES)]) == 2
    assert len(log) == 0


def test_seeds_rotate_by_attack():
    cases = redteam.load_cases(CASES)
    seeds = redteam._seeds(cases, 18)
    assert [s["attack"] for s in seeds[:9]] == list(redteam.ATTACKS)
    assert seeds[0]["id"] != seeds[9]["id"]          # vòng 2 lấy ca kế
