"""v2.2-content-pipeline (W5.3) — `pipelines.content`: CHANNEL_HINT
tiktok + `draft_multi` (đủ key từng kênh, mỗi result có
text+guardrail; prompt tiktok chứa hint kịch bản; kênh lạ fallback
facebook; `draft()` contract giữ nguyên). OpenAI client mock —
không gọi mạng, guardrail chạy thật trên text sạch."""

import types

from pipelines import content

SAFE_TEXT = "Sâm Ngọc Linh Quảng Nam — đặc sản quê hương, quà tặng sức khỏe."


def _resp(text):
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(
            message=types.SimpleNamespace(content=text))])


class _FakeClient:
    """Ghi messages mỗi lần completions.create + trả text cố định."""

    def __init__(self, log, text):
        self._log = log
        self._text = text
        self.chat = types.SimpleNamespace(
            completions=types.SimpleNamespace(create=self._create))

    def _create(self, model=None, messages=None, **kw):
        self._log.append(list(messages))
        return _resp(self._text)


def _patch_openai(monkeypatch, text=SAFE_TEXT):
    """Mock `content.OpenAI` → log các `messages` call (log[i][0] =
    system prompt của call thứ i)."""
    log = []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(content, "OpenAI",
                        lambda **kw: _FakeClient(log, text))
    return log


def test_draft_multi_all_channels_each_with_guardrail(monkeypatch):
    log = _patch_openai(monkeypatch)
    res = content.draft_multi("giới thiệu Saphraton",
                              ["facebook", "tiktok", "blog", "zalo"])
    assert set(res) == {"facebook", "tiktok", "blog", "zalo"}
    for ch, r in res.items():
        assert isinstance(r["text"], str) and r["text"], ch
        assert set(r["guardrail"]) >= {"ok", "violations",
                                       "matched_claims"}, ch
        assert r["guardrail"]["ok"] is True, ch
    # Mỗi kênh 1 draft() riêng — guardrail độc lập từng bài.
    assert len(log) == 4


def test_draft_multi_tiktok_prompt_has_script_hint(monkeypatch):
    log = _patch_openai(monkeypatch)
    content.draft_multi("quay video giới thiệu", ["tiktok"])
    system = log[0][0]["content"]       # messages[0] = system prompt
    assert "kịch bản" in system
    assert "hook" in system and "overlay" in system
    assert "CTA" in system


def test_draft_multi_unknown_channel_facebook_fallback(monkeypatch):
    log = _patch_openai(monkeypatch)
    res = content.draft_multi("x", ["kênh-lạ"])
    # Key giữ nguyên tên kênh caller truyền; hint rơi về facebook.
    assert set(res) == {"kênh-lạ"}
    assert "Facebook" in log[0][0]["content"]


def test_draft_multi_dedupe_and_str_input(monkeypatch):
    log = _patch_openai(monkeypatch)
    res = content.draft_multi("x", ["facebook", "facebook", "zalo"])
    assert set(res) == {"facebook", "zalo"}
    assert len(log) == 2                        # kênh trùng tự gộp
    res2 = content.draft_multi("x", "facebook")  # str → bọc 1 kênh
    assert set(res2) == {"facebook"}


def test_draft_contract_unchanged(monkeypatch):
    log = _patch_openai(monkeypatch)
    r = content.draft("x", "blog")
    assert set(r) == {"text", "guardrail"}
    assert r["guardrail"]["ok"] is True
    assert "blog" in log[0][0]["content"]


def test_draft_retry_prompt_on_guardrail_fail(monkeypatch):
    """draft() cũ: text vi phạm → 1 lượt viết lại có feedback (vòng
    for-range(2) giữ nguyên)."""
    # Call 1 trả text có từ cấm → guardrail fail → call 2 trả sạch.
    texts = iter(["Saphraton chữa khỏi bệnh tiểu đường", SAFE_TEXT])
    log = []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    class Flaky:
        def __init__(self):
            self.chat = types.SimpleNamespace(
                completions=types.SimpleNamespace(create=self._c))

        def _c(self, model=None, messages=None, **kw):
            log.append(list(messages))
            return _resp(next(texts))

    monkeypatch.setattr(content, "OpenAI", lambda **kw: Flaky())
    r = content.draft("x", "facebook")
    assert len(log) == 2                        # retry đúng 1 lần
    assert r["text"] == SAFE_TEXT and r["guardrail"]["ok"] is True
    # Lượt retry có feedback vi phạm trong user message cuối.
    assert "vi phạm guardrail" in log[1][-1]["content"]
