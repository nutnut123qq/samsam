"""v2.2-content-pipeline (W5.3) — `pipelines.content`: CHANNEL_HINT
tiktok + `draft_multi` (đủ key từng kênh, mỗi result có
text+guardrail; prompt tiktok chứa hint kịch bản; kênh lạ fallback
facebook; `draft()` contract giữ nguyên). OpenAI client mock —
không gọi mạng, guardrail chạy thật trên text sạch."""

import json
import re
import types
from pathlib import Path

from pipelines import content, llm_gateway

ROOT = Path(__file__).resolve().parent.parent

# v4.2: guardrail đăng bài — text sạch không có "Ngọc Linh" (chỉ dẫn địa lý
# chưa xác nhận) và đã mang nhãn AI (draft không phải nối thêm).
SAFE_TEXT = ("Sâm Sâm Quảng Nam — đặc sản quê hương, quà tặng sức khỏe."
             "\n\nNội dung có sử dụng AI")


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
    """Mock gateway `_client` → log các `messages` call (log[i][0] =
    system prompt của call thứ i)."""
    log = []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm_gateway, "_client",
                        lambda: _FakeClient(log, text))
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
    assert set(r) == {"text", "guardrail", "meta"}   # v6.1 FLIP: + meta
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

    monkeypatch.setattr(llm_gateway, "_client", lambda: Flaky())
    r = content.draft("x", "facebook")
    assert len(log) == 2                        # retry đúng 1 lần
    assert r["text"] == SAFE_TEXT and r["guardrail"]["ok"] is True
    # Lượt retry có feedback vi phạm trong user message cuối.
    assert "vi phạm guardrail" in log[1][-1]["content"]


# ---------- v4.2 W42.3: draft() đi qua guardrail ĐĂNG BÀI ----------

LABEL = "Nội dung có sử dụng AI"


def _canon():
    return json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
        encoding="utf-8"))["disclaimer"]["canonical"]


def test_content_calls_check_publish_not_chat_check():
    src = (ROOT / "pipelines" / "content.py").read_text(encoding="utf-8")
    assert "check_publish" in src
    assert not re.search(r"(?<![\w.])check\(", src)
    assert "from pipelines.guardrail import check" not in src


def test_prompt_canonical_disclaimer_no_variant_no_ngoc_linh_voice(
        monkeypatch):
    log = _patch_openai(monkeypatch)
    content.draft("x", "facebook")
    system = log[0][0]["content"]
    assert _canon() in system                 # nguyên văn, đọc từ json
    assert "Sản phẩm không phải là thuốc" not in system
    assert LABEL in system
    # "Ngọc Linh" chỉ còn trong dòng CẤM dùng — không còn ở brand voice.
    nl = [ln for ln in system.split("\n") if "ngọc linh" in ln.casefold()]
    assert nl and all("Không dùng" in ln for ln in nl), nl
    assert "sâm\nNgọc Linh" not in system and "Ngọc Linh Quảng Nam" \
        not in system


def test_missing_ai_label_appended_deterministically(monkeypatch):
    bare = "Sâm Sâm Quảng Nam — đặc sản quê hương."
    log = _patch_openai(monkeypatch, text=bare)
    r = content.draft("x", "facebook")
    assert r["text"] == bare + "\n\n" + LABEL
    assert r["text"].endswith(LABEL)
    assert r["guardrail"]["ok"] is True, r["guardrail"]["violations"]
    assert len(log) == 1                      # không tốn lượt sửa
    assert r["guardrail"]["llm_check"] == "off"


def test_ngoc_linh_feedback_on_retry(monkeypatch):
    log = _patch_openai(monkeypatch, text="Sâm Ngọc Linh chính gốc")
    r = content.draft("x", "facebook")
    assert len(log) == 2
    assert "ngoc_linh_chua_xac_nhan" in log[1][-1]["content"]
    assert r["guardrail"]["ok"] is False
    assert "ngoc_linh_chua_xac_nhan" in [
        v["code"] for v in r["guardrail"]["violations"]]


def test_blog_checked_as_web_unknown_channel_config(monkeypatch):
    log = _patch_openai(monkeypatch,
                        text="Savina 12 viên. " + _canon() + ".")
    r = content.draft("x", "blog")
    assert r["guardrail"]["ok"] is True, r["guardrail"]["violations"]
    assert "web" in r["guardrail"]["warnings"][0]["detail"]   # alias
    r = content.draft("x", "kênh-lạ")
    assert r["guardrail"]["ok"] is False
    assert [v["code"] for v in r["guardrail"]["violations"]] == ["config"]
    assert "Facebook" in log[-1][0]["content"]                # hint fallback


def test_llm_layer_active_in_generation(monkeypatch):
    """Env GUARDRAIL_LLM_MODEL + LLM-check giả cờ true trên text sạch ->
    draft bị chặn llm_ngam_y_suc_khoe (lớp LLM có hiệu lực trong luồng
    sinh). Client giả phân biệt theo model."""
    calls = []
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("GUARDRAIL_LLM_MODEL", "google/gemini-test")

    class Two:
        def __init__(self):
            self.chat = types.SimpleNamespace(
                completions=types.SimpleNamespace(create=self._c))

        def _c(self, model=None, messages=None, **kw):
            calls.append(model)
            if model == "google/gemini-test":
                return _resp('{"flag": true, "reasons": [{"quote": '
                             '"quà tặng sức khỏe", "why": "ẩn ý"}]}')
            return _resp(SAFE_TEXT)

    monkeypatch.setattr(llm_gateway, "_client", lambda: Two())
    r = content.draft("x", "facebook")
    g = r["guardrail"]
    assert g["ok"] is False and g["llm_check"] == "flag"
    assert [v["code"] for v in g["violations"]] == ["llm_ngam_y_suc_khoe"]
    assert calls.count("google/gemini-test") == 2   # mỗi lượt 1 LLM-check
