"""v3.9 W39.4 — retrieve() DENY-BY-DEFAULT + chatbot không trả rượu (unit,
fake conn ghi SQL; không DB/OpenRouter thật)."""
import inspect
from types import SimpleNamespace

import pytest

from api import rag
from pipelines import llm_gateway

Q = [1.0, 0.0, 0.0]


class _FakeConn:
    def __init__(self, rows, log):
        self.rows, self.log = rows, log

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.log.append((sql, params))
        return SimpleNamespace(fetchall=lambda: list(self.rows))


@pytest.fixture
def env(monkeypatch):
    st = SimpleNamespace(sql=[], embeds=0, connect_kw=None, rows=[])

    def fake_embed(agent, text, **kw):
        st.embeds += 1
        return SimpleNamespace(data=[SimpleNamespace(embedding=Q)])

    def fake_connect(dsn, **kw):
        st.connect_kw = kw
        return _FakeConn(st.rows, st.sql)

    monkeypatch.setattr(rag, "embed", fake_embed)
    monkeypatch.setattr(rag.psycopg, "connect", fake_connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/x")
    return st


def _row(doc_id, content, emb, title="t"):
    return (title, f"http://x/{doc_id}", "vi", content, emb, doc_id)


def test_public_reads_only_chunks(env):
    env.rows = [_row("d1", "Saphraton 80 viên", [1.0, 0.1, 0.0])]
    hits = rag.retrieve("Saphraton?")
    assert [h["doc_id"] for h in hits] == ["d1"]
    (sql, params), = env.sql
    assert " from chunks" in sql and "chunks_internal" not in sql
    assert not params
    assert env.connect_kw.get("connect_timeout")


def test_internal_reads_only_chunks_internal_with_param(env):
    env.rows = [_row("kd-1", "MẪU nội bộ", [1.0, 0.0, 0.0])]
    hits = rag.retrieve("quy trình?", collection="internal:kd")
    (sql, params), = env.sql
    assert "from chunks_internal where collection = %s" in sql
    assert params == ("internal:kd",)
    assert hits[0]["doc_id"] == "kd-1"


@pytest.mark.parametrize("bad", [None, "", "Public", "internal:", "chunks",
                                 "internal:kd' or '1'='1", "internal:KD",
                                 "internal:kd\n", "internal:" + "a" * 33, 1])
def test_bad_collection_value_error_before_embed(env, bad):
    with pytest.raises(ValueError):
        rag.retrieve("x", collection=bad)
    assert env.embeds == 0 and env.sql == []


def test_alcohol_row_excluded_even_top_score(env):
    env.rows = [_row("ruou", "Rượu sâm No.9 giá tốt", [1.0, 0.0, 0.0]),
                _row("ruou-title", "Chai 500ml", [1.0, 0.0, 0.0],
                     title="Ngoc Linh Ginseng Wine No. 7"),
                _row("ok", "Saphraton", [0.9, 0.3, 0.0])]
    hits = rag.retrieve("x")
    assert [h["doc_id"] for h in hits] == ["ok"]


def test_alcohol_catalog_row_not_pinned(env):
    env.rows = [_row("ok", "Saphraton", [1.0, 0.0, 0.0]),
                _row("catalog-products", "- Rượu Sâm No.9 — Giá: Liên hệ",
                     [0.5, 0.5, 0.0])]
    assert [h["doc_id"] for h in rag.retrieve("x")] == ["ok"]


def test_internal_not_alcohol_filtered_and_no_catalog_pin(env):
    env.rows = [_row("kd-1", "Rượu sâm — quy trình kho", [1.0, 0.0, 0.0]),
                _row("catalog-products", "Danh mục", [0.2, 1.0, 0.0])]
    hits = rag.retrieve("x", k=1, collection="internal:kho")
    assert [h["doc_id"] for h in hits] == ["kd-1"]


def test_answer_has_no_collection_param():
    assert "collection" not in inspect.signature(rag.answer).parameters


class _NoLLM:
    def __getattr__(self, name):
        raise AssertionError("LLM client không được gọi")


@pytest.mark.parametrize("q", ["Rượu sâm giá bao nhiêu?",
                               "ruou sam No.9 mua o dau",
                               "ginseng wine price"])
def test_alcohol_question_handoff_no_llm(monkeypatch, q):
    monkeypatch.setattr(llm_gateway, "_client", lambda: _NoLLM())
    monkeypatch.setattr(rag, "retrieve",
                        lambda *a, **k: pytest.fail("không được retrieve"))
    r = rag.answer(q)
    assert r == {"answer": rag.NO_DATA, "sources": [], "handoff": "alcohol"}


def test_alcohol_standalone_rewrite_handoff(monkeypatch):
    calls = []

    def fake_chat(agent, messages, **kw):
        calls.append(messages)
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content="Rượu sâm No.9 giá bao nhiêu?"))])

    monkeypatch.setattr(rag, "chat", fake_chat)
    monkeypatch.setattr(rag, "retrieve",
                        lambda *a, **k: pytest.fail("không được retrieve"))
    r = rag.answer("loại đó giá sao?", history=[
        {"role": "user", "content": "có những loại gì"},
        {"role": "assistant", "content": "Saphraton, Savina"}])
    assert r["handoff"] == "alcohol" and r["sources"] == []
    assert len(calls) == 1  # chỉ call rewrite, không call trả lời


def test_normal_question_still_retrieves(monkeypatch):
    seen = []
    monkeypatch.setattr(rag, "retrieve",   # + feature= (vá F1 22/10)
                        lambda q, feature=None: seen.append(q) or [])
    r = rag.answer("Saphraton giá bao nhiêu?")
    assert seen == ["Saphraton giá bao nhiêu?"]
    assert r == {"answer": rag.NO_DATA, "sources": []}


def test_health_checked_before_alcohol(monkeypatch):
    monkeypatch.setattr(rag, "retrieve", lambda *a, **k: pytest.fail("x"))
    assert rag.answer("rượu sâm chữa bệnh gout không")["handoff"] == "health"


# --- Hậu kiểm định danh bịa (nghiệm thu v3.9: MST 4001036461 chỉ ở record
# rượu đã lọc -> LLM bịa 0402021985). 0 LLM thật: chat/retrieve giả.
_CTX = ("Công ty TNHH Sâm Sâm. Hotline: 0905.123.456. "
        "Saphraton — 1.000.000 đ; Saphraton 20V — 236.000 đ")


def _answer_with(monkeypatch, llm_text, question="Mã số thuế công ty?",
                 history=None, ctx=_CTX):
    monkeypatch.setattr(rag, "retrieve", lambda q, feature=None: [{  # vá F1
        "title": "about", "url": "https://samsam.net.vn/x", "lang": "vi",
        "content": ctx, "score": 0.9, "doc_id": "about-1"}])
    monkeypatch.setattr(rag, "chat", lambda agent, messages, **kw:
                        SimpleNamespace(choices=[SimpleNamespace(
                            message=SimpleNamespace(content=llm_text))]))
    return rag.answer(question, history=history)


@pytest.mark.parametrize("llm_text", [
    "Mã số doanh nghiệp của công ty là 0402021985.",
    "MST: 0402021234",
    "Hotline 0905123456 hoặc 0911222333.",  # 1 số thật + 1 số bịa
])
def test_fabricated_long_number_returns_no_data(monkeypatch, llm_text):
    r = _answer_with(monkeypatch, llm_text)
    assert r == {"answer": rag.NO_DATA, "sources": []}


@pytest.mark.parametrize("llm_text", [
    "Hotline: 0905.123.456",
    "Hotline: 0905123456",  # ngữ cảnh viết có chấm -> vẫn có nguồn
    "Saphraton hộp 80 viên: 1.000.000 đ; gói Saphraton 20V: 236.000 đ",
    "Công ty TNHH Sâm Sâm.",
])
def test_grounded_numbers_pass_through(monkeypatch, llm_text):
    r = _answer_with(monkeypatch, llm_text)
    assert r["answer"] == llm_text and r["sources"] == ["https://samsam.net.vn/x"]


def test_number_from_question_or_history_is_grounded(monkeypatch):
    r = _answer_with(monkeypatch, "Đơn 123456789 đã ghi nhận.",
                     question="Đơn 123456789 của tôi sao rồi?")
    assert r["answer"].startswith("Đơn 123456789")
    r = _answer_with(monkeypatch, "Số 0977888999 bạn gửi đã ghi nhận.",
                     question="nhận được chưa?", history=[
                         {"role": "user", "content": "sđt tôi 0977888999"},
                         {"role": "assistant", "content": "Cảm ơn bạn"}])
    assert "0977888999" in r["answer"]
