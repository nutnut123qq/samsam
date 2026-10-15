"""v10.3 W103.4 — retrieve() tách backend float8 | pgvector (fake conn, không
DB/OpenRouter thật). Fake conn pgvector trả rows ĐÃ sort theo cosine tính
trong test (mô phỏng `order by embedding_v <=> q`), không gọi code numpy
của rag."""

import math
from types import SimpleNamespace

import psycopg
import pytest

from api import rag


def _cos(a, b):
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


class _Fake:
    """rows = [(title, url, lang, content, emb, doc_id, chunk_index, coll)]."""

    def __init__(self, st):
        self.st = st

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def rollback(self):
        self.st.rollbacks += 1

    def execute(self, sql, params=None):
        st = self.st
        st.sql.append((sql, params))
        if sql.startswith("set local"):
            return SimpleNamespace(fetchall=list)
        ident = "chunk_index" in sql
        internal = "chunks_internal" in sql
        pool = [r for r in st.rows if (r[7] is not None) == internal
                and (not internal or r[7] == params[1 if "<=>" in sql
                                                    else 0])]
        if "<=>" in sql:
            if st.raise_pg:
                raise st.raise_pg("column embedding_v does not exist")
            q = [float(x) for x in params[0].strip("[]").split(",")]

            def shape(r):
                out = (r[0], r[1], r[2], r[3], _cos(r[4], q), r[5])
                return out + ((r[6],) if ident else ())
            if "catalog-products" in sql:
                got = [shape(r) for r in pool if r[5] == "catalog-products"]
            else:
                got = sorted((shape(r) for r in pool), key=lambda t: -t[4])
                got = got[:params[-1]]
            return SimpleNamespace(fetchall=lambda: got)
        got = [(*r[:6], r[6]) if ident else r[:6] for r in pool]
        return SimpleNamespace(fetchall=lambda: got)


@pytest.fixture
def env(monkeypatch):
    st = SimpleNamespace(sql=[], rows=[], embeds=0, rollbacks=0,
                         raise_pg=None, connects=0)

    def connect(dsn, **kw):
        assert kw.get("connect_timeout")
        st.connects += 1
        return _Fake(st)

    def fake_embed(agent, text, **kw):
        st.embeds += 1
        return SimpleNamespace(data=[SimpleNamespace(embedding=Q)])

    monkeypatch.setattr(rag.psycopg, "connect", connect)
    monkeypatch.setattr(rag, "embed", fake_embed)
    monkeypatch.setattr(rag, "_pg_warned", False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/x")
    monkeypatch.delenv("RAG_VECTOR_BACKEND", raising=False)
    return st


Q = [1.0, 0.2, 0.0]


def _row(doc, content, emb, i=0, title="t", coll=None):
    return (title, f"http://x/{doc}", "vi", content, emb, doc, i, coll)


CORPUS = [
    _row("ruou", "Rượu sâm No.9 giá tốt", [1.0, 0.2, 0.0]),
    _row("a", "Saphraton 80 viên", [1.0, 0.25, 0.05]),
    _row("a", "Saphraton 20V", [0.9, 0.5, 0.1], i=1),
    _row("b", "Savina tuýp", [0.7, 0.7, 0.2]),
    _row("c", "Lịch sử công ty", [0.2, 1.0, 0.3]),
    _row("d", "Trồng sâm", [0.1, 0.3, 1.0]),
    _row("catalog-products", "Danh mục sản phẩm", [0.3, 0.6, 0.8]),
    _row("kd-1", "Rượu — quy trình kho", [1.0, 0.2, 0.0], coll="internal:kd"),
    _row("kd-2", "Quy trình B", [0.5, 0.5, 0.5], coll="internal:kd"),
]


def _sig(hits):
    return [(h["doc_id"], h.get("chunk_index"), h["score"]) for h in hits]


def _same(a, b):
    assert [x[:2] for x in _sig(a)] == [x[:2] for x in _sig(b)]
    assert all(abs(x[2] - y[2]) < 1e-9 for x, y in zip(_sig(a), _sig(b)))
    assert [{k: v for k, v in h.items() if k != "score"} for h in a] == \
        [{k: v for k, v in h.items() if k != "score"} for h in b]


@pytest.mark.parametrize("k", [1, 2, 3, 8])
def test_float8_and_pgvector_identical(env, k):
    env.rows = CORPUS
    f8 = rag.retrieve_by_vector(Q, k, backend="float8")
    pg = rag.retrieve_by_vector(Q, k, backend="pgvector")
    _same(f8, pg)
    ids = [h["doc_id"] for h in f8]
    assert "ruou" not in ids
    if k <= 3:   # catalog không trong top-k → ghim cuối (điểm ≥ 0.15)
        assert ids[-1] == "catalog-products" and len(ids) == k + 1
    f8i = rag.retrieve_by_vector(Q, k, backend="float8", ident=True)
    pgi = rag.retrieve_by_vector(Q, k, backend="pgvector", ident=True)
    _same(f8i, pgi)
    assert all("chunk_index" in h for h in f8i)
    assert all("chunk_index" not in h for h in f8)


def test_pgvector_sql_shape(env):
    env.rows = CORPUS
    rag.retrieve_by_vector(Q, 3, backend="pgvector")
    sqls = [s for s, _p in env.sql]
    assert any("hnsw.ef_search" in s for s in sqls)
    assert all("float8" not in s for s in sqls)
    main = [s for s in sqls if "order by embedding_v <=>" in s]
    assert len(main) == 1 and "limit %s" in main[0]
    assert "from chunks " in main[0] and "chunks_internal" not in main[0]
    (_s, params), = [x for x in env.sql if "order by" in x[0]]
    assert params[-1] == rag.PGVECTOR_CANDIDATES
    ef = next(s for s in sqls if "ef_search" in s)
    assert int(ef.rsplit("=", 1)[1]) >= rag.PGVECTOR_CANDIDATES


@pytest.mark.parametrize("val", ["abc", "PGVECTOR", "float8 ", "numpy"])
def test_bad_backend_value_error_before_embed(env, monkeypatch, val):
    monkeypatch.setenv("RAG_VECTOR_BACKEND", val)
    if val.strip() == "float8":
        rag.retrieve("x")   # strip → hợp lệ
        return
    with pytest.raises(ValueError):
        rag.retrieve("x")
    assert env.embeds == 0 and env.sql == [] and env.connects == 0


def test_default_backend_float8(env, monkeypatch):
    env.rows = CORPUS
    monkeypatch.setenv("RAG_VECTOR_BACKEND", "")
    rag.retrieve("x")
    assert not any("<=>" in s for s, _p in env.sql)
    assert rag.vector_backend() == "float8"


@pytest.mark.parametrize("exc", [psycopg.errors.UndefinedColumn,
                                 psycopg.errors.UndefinedObject,
                                 psycopg.errors.UndefinedFunction])
def test_pg_missing_falls_back_warn_once(env, monkeypatch, capsys, exc):
    env.rows = CORPUS
    want = rag.retrieve_by_vector(Q, 3, backend="float8")
    env.raise_pg = exc
    monkeypatch.setenv("RAG_VECTOR_BACKEND", "pgvector")
    a = rag.retrieve("x", 3)
    b = rag.retrieve("y", 3)
    _same(a, want)
    _same(b, want)
    err = capsys.readouterr().err
    assert err.count("[warn]") == 1 and exc.__name__ in err
    assert env.rollbacks == 2


def test_alcohol_flood_pgvector_still_returns_k(env, monkeypatch):
    monkeypatch.setattr(rag, "PGVECTOR_CANDIDATES", 64)
    flood = [_row(f"r{i}", f"Rượu sâm số {i}", [1.0, 0.2, 0.0001 * i])
             for i in range(70)]
    env.rows = flood + CORPUS
    f8 = rag.retrieve_by_vector(Q, 4, backend="float8")
    pg = rag.retrieve_by_vector(Q, 4, backend="pgvector")
    assert len(pg) == 4 and len(f8) == 4
    _same(f8, pg)
    assert any("<=>" in s for s, _p in env.sql)   # đã thử pgvector trước


def test_small_corpus_pgvector_no_fallback(env):
    env.rows = CORPUS
    rag.retrieve_by_vector(Q, 8, backend="pgvector")
    # < limit ứng viên = đã hết corpus → không chạy lại đường float8
    assert not any("embedding, doc_id" in s for s, _p in env.sql)


@pytest.mark.parametrize("backend", ["float8", "pgvector"])
def test_internal_collection_both_backends(env, backend):
    env.rows = CORPUS
    hits = rag.retrieve_by_vector(Q, 1, collection="internal:kd",
                                  backend=backend)
    assert [h["doc_id"] for h in hits] == ["kd-1"]   # nội bộ không lọc rượu
    assert all("chunks_internal" in s for s, _p in env.sql
               if "select" in s)
    assert all(p == ("internal:kd",) or (p and "internal:kd" in p)
               for s, p in env.sql if "select" in s)


@pytest.mark.parametrize("backend", ["float8", "pgvector"])
@pytest.mark.parametrize("bad", [None, "", "internal:", "internal:KD",
                                 "chunks", "internal:kd' or '1'='1"])
def test_bad_collection_before_embed(env, monkeypatch, backend, bad):
    monkeypatch.setenv("RAG_VECTOR_BACKEND", backend)
    with pytest.raises(ValueError):
        rag.retrieve("x", collection=bad)
    assert env.embeds == 0 and env.sql == []
