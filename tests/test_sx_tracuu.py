"""v10.2 W102.3 — SX-A7 tra cứu khoa học nội bộ (`agents.sx_tracuu`).

DB THẬT trong schema tạm + docs/schema.sql → ROLLBACK cuối test (không
commit dòng nào vào `chunks_internal` thật). `api.rag.retrieve_by_vector`
mở conn riêng → monkeypatch `rag.psycopg` trả conn fixture (cùng tx, cùng
search_path tạm). Embed/chat là bản GIẢ (đếm lời gọi) — 0 mạng. Tên người
duyệt trong fixture là tên GIẢ.
"""

import os
import re
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from agents import sx_tracuu as sx
from api import rag
from pipelines import guardrail, llm_gateway

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
SRC = (ROOT / "agents" / "sx_tracuu.py").read_text(encoding="utf-8")
Q = [1.0, 0.0, 0.0, 0.0]
APPROVER = "GD SX GIA LAP (test)"
TITLE_A = "Saponin trong sâm Ngọc Linh trồng dưới tán rừng (MẪU)"
DOI = "10.1234/sam.2026.001"
HEAD_A = (f"# {TITLE_A}\nTác giả: Nhóm MẪU\nDOI: {DOI}\n\n"
          "Hàm lượng saponin tổng được đo bằng HPLC trên 30 mẫu củ.")


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
        schema = f"t_w102s_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _Conn:
    """Bọc conn fixture: context manager + commit/rollback/close no-op."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _ins(db, coll, doc_id, idx, content, vec, title=TITLE_A,
         ref="saponin_a.md"):
    db.execute(
        "insert into chunks_internal (collection, doc_id, chunk_index, title,"
        " source_ref, content, embedding, doc_sha256, approved_by) values"
        " (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (coll, doc_id, idx, title, ref, content, vec, "0" * 64, APPROVER))


@pytest.fixture
def env(db, monkeypatch, tmp_path):
    _ins(db, "internal:sx", "sx-saponin-a", 0, HEAD_A, Q)
    _ins(db, "internal:sx", "sx-saponin-a", 1,
         "Kết quả: mẫu dưới tán rừng có hàm lượng cao hơn mẫu đối chứng.",
         [0.9, 0.1, 0.0, 0.0])
    _ins(db, "internal:sx", "sx-saponin-b", 0,
         "Ghi chép thí nghiệm nhiệt độ sấy củ sâm (MẪU, chưa có DOI).",
         [0.95, 0.0, 0.05, 0.0], title="Nhiệt độ sấy (MẪU)",
         ref="say_cu_mau.md")
    _ins(db, "internal:mkt", "mkt-ke-hoach", 0,
         "Kế hoạch marketing nội bộ MẪU.", Q, title="KH MKT", ref="mkt.md")
    db.execute(
        "insert into chunks (doc_id, chunk_index, source_url, title, lang,"
        " content, embedding) values ('pub-gioi-thieu', 0,"
        " 'https://samsam.example.vn/gioi-thieu', 'Giới thiệu', 'vi',"
        " 'Giới thiệu công ty Sâm Sâm (MẪU công khai).', %s)",
        ([0.6, 0.8, 0.0, 0.0],))
    monkeypatch.delenv("RAG_VECTOR_BACKEND", raising=False)
    monkeypatch.setattr(rag, "psycopg", SimpleNamespace(
        connect=lambda *a, **kw: _Conn(db)))
    monkeypatch.setattr(sx, "connect", lambda: _Conn(db))
    monkeypatch.setattr(sx, "REPORTS_DIR", tmp_path / "reports")
    calls = {"embed": 0, "chat": []}

    def embed(agent, text, **kw):
        calls["embed"] += 1
        calls.setdefault("agents", []).append(agent)
        return SimpleNamespace(data=[SimpleNamespace(embedding=Q)])
    monkeypatch.setattr(llm_gateway, "embed", embed)
    monkeypatch.setattr(rag, "embed", embed)
    return SimpleNamespace(db=db, calls=calls, tmp=tmp_path, mp=monkeypatch)


def _chat_reply(env, text):
    def chat(agent, msgs, **kw):
        env.calls["chat"].append((agent, msgs))
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=text))])
    env.mp.setattr(llm_gateway, "chat", chat)
    env.mp.setattr(rag, "chat", chat)


# ---------------------------------------------------------------- cách ly


def test_public_retrieve_and_answer_never_return_sx(env):
    hits = rag.retrieve_by_vector(Q)                 # mặc định = public
    ids = [h["doc_id"] for h in hits]
    assert ids == ["pub-gioi-thieu"]
    assert not any(i.startswith(("sx-", "mkt-")) for i in ids)
    _chat_reply(env, "Công ty Sâm Sâm giới thiệu trên website [1].")
    out = rag.answer(TITLE_A)                        # đúng tiêu đề tài liệu sx
    assert out["sources"] == ["https://samsam.example.vn/gioi-thieu"]
    assert not any(s in str(out) for s in ("saponin_a.md", "say_cu_mau.md",
                                           "sx-saponin", DOI))
    ctx = env.calls["chat"][-1][1][-1]["content"]
    assert "HPLC" not in ctx and "sx-saponin" not in ctx


def test_ask_sources_cite_and_collection_isolated(env):
    r = sx.ask("hàm lượng saponin dưới tán rừng", k=5)
    assert r["mode"] == "extract" and r["label"] == sx.LABEL
    ids = [s["doc_id"] for s in r["sources"]]
    assert ids and all(i.startswith("sx-saponin-") for i in ids)
    assert "mkt-ke-hoach" not in ids and "pub-gioi-thieu" not in ids
    cites = {s["doc_id"]: s["cite"] for s in r["sources"]}
    assert cites["sx-saponin-a"] == f"DOI: {DOI}"
    assert "chưa có DOI/URL" in cites["sx-saponin-b"]
    assert "say_cu_mau.md" in cites["sx-saponin-b"]
    assert env.calls["agents"] == ["sx_tracuu"]
    # trích NGUYÊN VĂN, có [n], ≤3 đoạn, ≤600 ký tự/đoạn
    paras = r["answer"].split("\n\n")
    assert 1 <= len(paras) <= sx.MAX_EXTRACTS
    assert all(re.match(r"^\[\d\] \"", p) for p in paras)
    assert "Hàm lượng saponin tổng được đo bằng HPLC" in r["answer"]
    assert all(len(p) <= sx.EXTRACT_MAX + 10 for p in paras)
    assert env.calls["chat"] == []                   # mặc định 0 LLM


def test_cite_not_taken_from_other_collection_same_doc_id(env):
    """Cùng tên file nạp vào 2 phòng → cùng doc_id; cite chỉ lấy chunk 0
    của internal:sx (khóa `collection = %s` trong _CITE_SQL)."""
    _ins(env.db, "internal:mkt", "sx-saponin-b", 0,
         "DOI: 10.9999/mkt-leak\nTài liệu phòng MKT trùng tên (MẪU).",
         [0.0, 0.0, 0.0, 1.0], ref="say_cu_mau.md")
    cites = {s["doc_id"]: s["cite"]
             for s in sx.ask("hàm lượng saponin dưới tán rừng", k=5)["sources"]}
    assert "chưa có DOI/URL" in cites["sx-saponin-b"]
    assert "mkt-leak" not in str(cites)


def test_cite_parser_variants():
    assert sx._cite("d", "f.md", "Url : https://x.example/a?b=1") == \
        "URL: https://x.example/a?b=1"
    assert sx._cite("d", "f.md", "doi:10.5555/AbC-1") == "DOI: 10.5555/AbC-1"
    head = "\n".join(["x"] * 20 + ["DOI: 10.1234/qua-dong-20"])
    assert "chưa có DOI/URL" in sx._cite("d", "f.md", head)
    assert "chưa có DOI/URL" in sx._cite("d", "f.md",
                                         "URL: javascript:alert(1)")
    assert "chưa có DOI/URL — tên file f.md" in sx._cite("d", "f.md", None)


def test_label_on_every_output(env):
    outs = [sx.ask("saponin"), sx.ask("   ?!  "),
            sx.ask("rượu sâm ngâm bao lâu")]
    _chat_reply(env, "Tài liệu [1] mô tả cách đo mẫu củ bằng HPLC.")
    outs.append(sx.ask("saponin", llm=True))
    assert [o["mode"] for o in outs] == ["extract", "no_data", "no_data",
                                         "llm"]
    for o in outs:
        assert o["label"] == sx.LABEL
        assert sx.render(o, "câu").startswith(f"**{sx.LABEL}**")


def test_llm_banned_word_falls_back_to_extract(env):
    _chat_reply(env, "sản phẩm chữa ung thư")
    assert guardrail.check("sản phẩm chữa ung thư")["ok"] is False
    r = sx.ask("saponin", llm=True)
    assert r["mode"] == "extract" and "banned_word" in r["reason"]
    assert "chữa" not in r["answer"] and "chữa" not in r["reason"]
    assert len(env.calls["chat"]) == 1 and env.calls["chat"][0][0] == \
        "sx_tracuu"
    sysmsg = env.calls["chat"][0][1][0]["content"]
    assert "Chỉ dựa vào NGỮ CẢNH" in sysmsg and "[n]" in sysmsg
    assert "Không kết luận công dụng" in sysmsg


@pytest.mark.parametrize("reply", [None, "   ", llm_gateway.GatewayBlocked(
    "cap")])
def test_llm_empty_or_error_falls_back(env, reply):
    if isinstance(reply, Exception):
        def boom(*a, **kw):
            raise reply
        env.mp.setattr(llm_gateway, "chat", boom)
    else:
        _chat_reply(env, reply)
    r = sx.ask("saponin", llm=True)
    assert r["mode"] == "extract" and r["reason"].startswith("LLM bị loại")


def test_no_data_paths_zero_embed(env):
    for q in ("", "   ", "?!...", "rượu sâm 40 độ", "Ruou sam ngam"):
        r = sx.ask(q)
        assert r["answer"] == rag.NO_DATA and r["sources"] == []
    assert env.calls["embed"] == 0
    # điểm thấp → NO_DATA
    env.mp.setattr(llm_gateway, "embed", lambda a, t, **kw: SimpleNamespace(
        data=[SimpleNamespace(embedding=[0.0, 0.0, 0.0, 1.0])]))
    assert sx.ask("chủ đề khác hẳn")["mode"] == "no_data"


def test_cli_out_file_and_exit_codes(env, capsys):
    assert sx.main(["--ask", "saponin", "--out"]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"**{sx.LABEL}**")
    files = list((env.tmp / "reports").glob("sx-tracuu-*.md"))
    assert len(files) == 1
    assert re.fullmatch(r"sx-tracuu-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md",
                        files[0].name)
    assert files[0].read_text(encoding="utf-8").startswith(f"**{sx.LABEL}**")


@pytest.mark.parametrize("argv", [["--ask", "x" * 2001], ["--ask", "a",
                                                          "--k", "0"], []])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(sx, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        sx.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(sx, "connect", lambda: None)
    assert sx.main(["--ask", "saponin"]) == 2
    assert "[warn]" in capsys.readouterr().err


def test_module_isolation_grep():
    assert not re.search(r"director|save_draft|content_drafts|approval_queue|"
                         r"insert into|update .* set|import httpx|"
                         r"import requests", SRC, re.IGNORECASE)
    assert 'COLLECTION = "internal:sx"' in SRC
    assert "collection=COLLECTION" in SRC
    for d in ("connectors", "app", "api"):
        for f in (ROOT / d).rglob("*.py"):
            assert "sx_tracuu" not in f.read_text(encoding="utf-8"), f


def test_gateway_cap_configured():
    import json
    cfg = json.loads((ROOT / "data" / "llm_gateway.json")
                     .read_text(encoding="utf-8"))
    assert cfg["monthly_cap_usd"]["sx_tracuu"] == 1.0
