"""Multi-turn (D4.1): answer(question, history) — câu follow-up được
rewrite thành standalone trước retrieve, còn prompt trả lời giữ câu hỏi
GỐC + history. Mock _clients + retrieve: không gọi OpenRouter/DB thật."""
from types import SimpleNamespace

from api import rag

HITS = [{"title": "Saphraton", "url": "http://x/saphraton", "lang": "vi",
         "content": "Saphraton — 1.000.000 đ", "score": 0.9,
         "doc_id": "p1"}]
HISTORY = [{"role": "user", "content": "Saphraton giá bao nhiêu?"},
           {"role": "assistant", "content": "Saphraton: 1.000.000 đ"}]


class _FakeChat:
    """Fake OpenAI client — ghi `messages` từng call chat.completions.
    Phân biệt call rewrite (system chứa 'Viết lại') vs call trả lời."""

    STANDALONE = "các sản phẩm nào rẻ hơn Saphraton?"
    ANSWER = "Saphraton 20V rẻ hơn: 236.000 đ"

    def __init__(self):
        self.calls = []  # list[list[dict]] — messages của từng call
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._create))

    def _create(self, model=None, messages=None, **kw):
        self.calls.append(list(messages))
        is_rewrite = "Viết lại" in messages[0]["content"]
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(
                content=self.STANDALONE if is_rewrite else self.ANSWER))])


def _patch(monkeypatch):
    """Mock _clients (fake chat) + retrieve (hits giả, ghi query)."""
    fake = _FakeChat()
    queries = []
    monkeypatch.setattr(rag, "_clients", lambda: (fake, "embed", "chat"))
    monkeypatch.setattr(rag, "retrieve",
                        lambda q: queries.append(q) or HITS)
    return fake, queries


def test_history_rewrite_for_retrieve_prompt_keeps_original(monkeypatch):
    fake, queries = _patch(monkeypatch)
    r = rag.answer("còn loại rẻ hơn?", history=HISTORY)
    assert len(fake.calls) == 2  # 1 call rewrite + 1 call trả lời
    # Retrieve bằng câu STANDALONE, không phải câu gốc trần.
    assert queries == [_FakeChat.STANDALONE]
    # Prompt trả lời: system + history + user(câu hỏi GỐC).
    msgs = fake.calls[1]
    assert msgs[0]["role"] == "system"
    assert msgs[1:-1] == HISTORY
    assert msgs[-1]["role"] == "user"
    assert "còn loại rẻ hơn?" in msgs[-1]["content"]
    assert r["answer"] == _FakeChat.ANSWER


def test_no_history_no_rewrite_call(monkeypatch):
    fake, queries = _patch(monkeypatch)
    rag.answer("Saphraton giá bao nhiêu?")
    assert len(fake.calls) == 1  # 1-turn không tốn call rewrite
    assert queries == ["Saphraton giá bao nhiêu?"]  # retrieve câu gốc


def test_empty_history_behaves_like_no_history(monkeypatch):
    fake, queries = _patch(monkeypatch)
    rag.answer("giá?", history=[])
    assert len(fake.calls) == 1 and queries == ["giá?"]
