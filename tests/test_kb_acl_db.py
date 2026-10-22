"""v3.9 W39.1 + W39.4 — DB THẬT (DATABASE_URL của worktree): CHECK của
`chunks_internal` (tx + ROLLBACK) và retrieve() mặc định không trả chunk
nội bộ / chunk rượu. retrieve mở conn riêng nên row test phải COMMIT thật
-> prefix `test-v39-` / `internal:test_v39`, dọn trong finally + assert."""
import os
from types import SimpleNamespace

import psycopg
import pytest

from api import rag
from ingest import embed_store, kb_internal

DIM = 1536  # cùng số chiều với embedding corpus thật (numpy stack)
Q = [1.0] + [0.0] * (DIM - 1)
COLL = "internal:test_v39"


@pytest.fixture
def conn():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        c = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError:
        pytest.skip("DB không kết nối được")
    yield c
    c.close()


def _cleanup(c):
    c.rollback()
    c.execute("delete from chunks where doc_id like 'test-v39-%'")
    c.execute("delete from chunks_internal where collection = %s", (COLL,))
    c.commit()
    assert c.execute("select count(*) from chunks where doc_id like 'test-v39-%'"
                     ).fetchone()[0] == 0
    assert c.execute("select count(*) from chunks_internal where collection = %s",
                     (COLL,)).fetchone()[0] == 0


@pytest.mark.parametrize("coll,by", [
    ("public", "MAU-test"), ("internal:", "MAU-test"), ("internal:KD", "MAU-test"),
    ("internal:kd;x", "MAU-test"), ("internal:kd", ""), ("internal:kd", "   "),
    ("internal:kd", None), (None, "MAU-test")])
def test_chunks_internal_checks(conn, coll, by):
    with pytest.raises((psycopg.errors.CheckViolation,
                        psycopg.errors.NotNullViolation)):
        conn.execute(
            "insert into chunks_internal (collection, doc_id, chunk_index,"
            " content, doc_sha256, approved_by) values (%s,'test-v39-x',0,"
            "'MẪU','x',%s)", (coll, by))
    conn.rollback()


def test_chunks_has_incremental_columns(conn):
    cols = {r[0] for r in conn.execute(
        "select column_name from information_schema.columns"
        " where table_schema='public' and table_name='chunks'")}
    assert {"id", "doc_id", "chunk_index", "source_url", "title", "lang",
            "content", "embedding", "source", "doc_sha256", "doc_version",
            "ingested_at"} <= cols


def test_retrieve_default_hides_internal_and_alcohol(conn, monkeypatch):
    monkeypatch.setattr(embed_store, "embed",
                        lambda agent, batch, model=None, feature=None:
                        SimpleNamespace(data=[SimpleNamespace(embedding=Q)
                                              for _ in batch]))
    monkeypatch.setattr(rag, "embed", lambda agent, text, **kw:
                        SimpleNamespace(data=[SimpleNamespace(embedding=Q)]))
    try:
        r = kb_internal.ingest_doc(
            conn, collection=COLL, doc_id="test-v39-mau", title="MẪU",
            source_ref="kb_noi_bo_MAU.md", approved_by="MAU-test",
            text="MẪU nội bộ — quy trình kiểm thử, không phải tài liệu thật.")
        assert r["status"] == "loaded"
        for doc_id, content in (("test-v39-ruou", "Rượu sâm Ngọc Linh No.9 giá tốt"),
                                ("test-v39-pub", "MẪU công khai Saphraton")):
            conn.execute(
                "insert into chunks (doc_id, chunk_index, source_url, title, lang,"
                " content, embedding, source) values (%s,0,'http://test-v39',"
                "'MẪU','vi',%s,%s,'test-v39')", (doc_id, content, Q))
        conn.commit()

        hits = rag.retrieve("bất kỳ")
        ids = [h["doc_id"] for h in hits]
        assert ids[0] == "test-v39-pub"  # retrieval chạy, top-1 là chunk q
        assert "test-v39-ruou" not in ids and "test-v39-mau" not in ids
        assert not any("MẪU nội bộ" in h["content"] for h in hits)

        hits_i = rag.retrieve("bất kỳ", collection=COLL)
        assert hits_i[0]["doc_id"] == "test-v39-mau"
        assert all(h["doc_id"] == "test-v39-mau" for h in hits_i)
    finally:
        _cleanup(conn)


# Quét ĐỘC LẬP với data/ruou_keywords.txt (nghiệm thu v3.9: gate quét bằng
# chính is_alcohol là vòng tròn — thiếu "alcoholic" thì quét vẫn ra 0).
# Regex Postgres riêng, trạng thái corpus SAU ingest của DB worktree.
_INDEP_RE = (r"alcohol|rượu|ruou|\mwines?\M|liquor|liqueur|vodka|whiske?y"
             r"|brandy|\msoju\M|có cồn|độ cồn|% ?vol\M|ginseng spirits?")


def test_public_corpus_has_no_alcohol_independent_scan(conn):
    rows = conn.execute(
        "select doc_id, chunk_index from chunks where content ~* %s"
        " or coalesce(title, '') ~* %s order by 1, 2",
        (_INDEP_RE, _INDEP_RE)).fetchall()
    assert rows == []
    assert conn.execute("select count(*) from chunks where content ilike"
                        " '%alcohol%'").fetchone()[0] == 0
