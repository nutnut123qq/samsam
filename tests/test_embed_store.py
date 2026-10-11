"""v3.9 W39.3 — ingest.embed_store.sync(): incremental theo doc_sha256, lọc
rượu, guard nguồn trống (delete-trắng), JSON hỏng/embed lỗi = 0 ghi.

DB thật nhưng KHÔNG ghi bảng `chunks` thật: conn riêng + `create temp table
chunks (like public.chunks including all)` — pg_temp đứng trước public trong
search_path nên SQL không-qualify của sync() trúng bảng tạm (tự mất khi đóng
conn). Embed giả đếm lời gọi qua monkeypatch `ingest.embed_store.embed`."""
import json
import os
from types import SimpleNamespace

import psycopg
import pytest

from ingest import embed_store as es
from pipelines.kb_filter import is_alcohol

LONG = ("Sâm Ngọc Linh được trồng dưới tán rừng ở Trà Linh, Nam Trà My. " * 14)
PRODUCTS = [
    {"id": "p-sap", "name": "Saphraton", "price_vnd": 1000000,
     "description": "Hộp 80 viên.", "url": "https://x.vn/product/saphraton/"},
    {"id": "p-sav", "name": "Savina", "price_vnd": 128000,
     "description": "Tuýp 12 viên ngậm.", "url": "https://x.vn/product/savina/"},
    {"id": "p-ruou", "name": "Rượu Sâm Ngọc Linh No. 9", "price_vnd": None,
     "description": "Chai 500ml.", "url": "https://x.vn/product/ruou-no-9/"},
]
ARTICLES = [
    {"id": "a-1", "title": "Vùng trồng sâm", "body": LONG,
     "url": "https://x.vn/a-1/"},
    # Bài dài có 1 đoạn nhắc rượu ở giữa: chỉ chunk đó bị bỏ.
    {"id": "a-2", "title": "Showroom Đà Nẵng",
     "body": LONG + " Khách được thử sâm ngâm rượu tại quầy. " + LONG,
     "url": "https://x.vn/a-2/"},
]
ABOUT = [{"id": "ab-1", "title": "Giới thiệu", "body": "Công ty TNHH Sâm Sâm.",
          "url": "https://x.vn/about/"}]
NEWS = [{"id": "n-1", "title": "Khai trương", "body": "Showroom 425 Phan Bội Châu.",
         "url": "https://x.vn/n-1/"}]


def _write(path, recs):
    path.write_bytes(b"".join(json.dumps(r, ensure_ascii=False).encode("utf-8")
                              + b"\n" for r in recs))


@pytest.fixture
def data_dir(tmp_path):
    _write(tmp_path / "products.jsonl", PRODUCTS)
    _write(tmp_path / "articles.jsonl", ARTICLES)
    _write(tmp_path / "about.jsonl", ABOUT)
    _write(tmp_path / "news.jsonl", NEWS)
    return tmp_path


@pytest.fixture
def conn():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        c = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError:
        pytest.skip("DB không kết nối được")
    n_real = c.execute("select count(*) from public.chunks").fetchone()[0]
    c.execute("create temp table chunks (like public.chunks including all)")
    c.commit()
    yield c
    c.rollback()
    c.execute("drop table if exists pg_temp.chunks")
    c.commit()
    assert c.execute("select count(*) from public.chunks").fetchone()[0] == n_real
    c.close()


class _Embed:
    """Fake gateway embed: đếm lời gọi + số text; raise ở lời gọi thứ N."""

    def __init__(self, fail_at=None):
        self.calls, self.texts, self.fail_at = 0, 0, fail_at

    def __call__(self, agent_id, batch, model=None):
        assert agent_id == "ingest"
        self.calls += 1
        if self.fail_at == self.calls:
            raise RuntimeError("embed down")
        self.texts += len(batch)
        return SimpleNamespace(data=[SimpleNamespace(embedding=[1.0, 0.5, 0.25])
                                     for _ in batch])


@pytest.fixture
def fake_embed(monkeypatch):
    fe = _Embed()
    monkeypatch.setattr(es, "embed", fe)
    return fe


def _rows(c):
    return {(r[0], r[1]): r[2:] for r in c.execute(
        "select doc_id, chunk_index, id, ingested_at, doc_version, source,"
        " doc_sha256, content, title from chunks")}


def _docs(c):
    return {r[0] for r in c.execute("select distinct doc_id from chunks")}


def test_second_run_zero_embed(conn, data_dir, fake_embed):
    st1 = es.sync(conn, data_dir)
    assert fake_embed.calls >= 1 and st1["new"] == len(_docs(conn))
    before = _rows(conn)
    fake_embed.calls = fake_embed.texts = 0
    st2 = es.sync(conn, data_dir)
    assert fake_embed.calls == 0 and fake_embed.texts == 0
    assert st2["new"] == st2["changed"] == st2["deleted"] == 0
    assert st2["embed_calls"] == 0
    assert _rows(conn) == before  # id + ingested_at y nguyên


def test_edit_one_record_reembeds_only_that_doc(conn, data_dir, fake_embed):
    es.sync(conn, data_dir)
    before = _rows(conn)
    fake_embed.calls = fake_embed.texts = 0
    _write(data_dir / "about.jsonl",
           [{**ABOUT[0], "body": "Công ty TNHH Sâm Sâm, thành lập 2015."}])
    st = es.sync(conn, data_dir)
    after = _rows(conn)
    n_about = sum(1 for k in after if k[0] == "ab-1")
    assert st["changed"] == 1 and st["new"] == 0
    assert fake_embed.texts == n_about
    assert {v[2] for k, v in after.items() if k[0] == "ab-1"} == {2}
    for k, v in after.items():
        if k[0] != "ab-1":
            assert before[k] == v  # doc khác không đổi id/ingested_at/version


def test_removed_record_deleted(conn, data_dir, fake_embed):
    es.sync(conn, data_dir)
    assert "n-1" in _docs(conn)
    _write(data_dir / "news.jsonl", [{**NEWS[0], "id": "n-2"}])
    st = es.sync(conn, data_dir)
    assert "n-1" not in _docs(conn) and "n-2" in _docs(conn)
    assert st["deleted"] == 1


@pytest.mark.parametrize("variant", ["missing", "zero", "blank", "doc_only"])
def test_empty_products_source_keeps_chunks(conn, data_dir, fake_embed, variant):
    es.sync(conn, data_dir)
    before = _rows(conn)
    p = data_dir / "products.jsonl"
    if variant == "missing":
        p.unlink()
    elif variant == "zero":
        p.write_bytes(b"")
    elif variant == "blank":
        p.write_bytes(b"\n   \n\r\n")
    else:
        p.write_bytes(b'{"_doc": "comment"}\n')
    fake_embed.calls = 0
    st = es.sync(conn, data_dir)
    assert st["deleted"] == 0 and fake_embed.calls == 0
    assert "products.jsonl" not in st["trusted"] and "catalog" not in st["trusted"]
    assert _rows(conn) == before  # products + catalog còn nguyên
    assert {"p-sap", "p-sav", "catalog-products"} <= _docs(conn)


def test_corrupt_json_aborts_before_embed_and_write(conn, data_dir, fake_embed):
    es.sync(conn, data_dir)
    before = _rows(conn)
    fake_embed.calls = 0
    _write(data_dir / "about.jsonl", [{**ABOUT[0], "body": "đổi"}])
    with open(data_dir / "news.jsonl", "ab") as f:
        f.write(b'{"id": "n-9", "title": "hong\n')
    with pytest.raises(es.SourceError):
        es.sync(conn, data_dir)
    conn.rollback()
    assert fake_embed.calls == 0
    assert _rows(conn) == before


def test_embed_fail_batch2_no_write(conn, data_dir, monkeypatch):
    monkeypatch.setattr(es, "embed", _Embed())
    es.sync(conn, data_dir)
    before = _rows(conn)
    for fn, recs in (("articles.jsonl", ARTICLES), ("about.jsonl", ABOUT)):
        _write(data_dir / fn, [{**r, "body": r["body"] + " Cập nhật."} for r in recs])
    fe = _Embed(fail_at=2)
    monkeypatch.setattr(es, "embed", fe)
    monkeypatch.setattr(es, "EMBED_BATCH", 2)
    with pytest.raises(RuntimeError, match="embed down"):
        es.sync(conn, data_dir)
    conn.rollback()
    assert fe.calls == 2
    assert _rows(conn) == before


def test_alcohol_filtered(conn, data_dir, fake_embed):
    st = es.sync(conn, data_dir)
    rows = _rows(conn)
    assert "p-ruou" not in _docs(conn)
    assert st["alcohol_records"]["products.jsonl"] == 1
    assert st["alcohol_chunks"]["articles.jsonl"] >= 1
    assert "a-2" in _docs(conn)  # chỉ chunk nhắc rượu bị bỏ, bài còn
    for (doc_id, _), v in rows.items():
        assert not is_alcohol(v[5]) and not is_alcohol(v[6]), doc_id
    cat = " ".join(v[5] for k, v in rows.items() if k[0] == "catalog-products")
    assert "Saphraton" in cat and "rượu" not in cat.casefold()


def test_legacy_null_source_alcohol_removed(conn, data_dir, fake_embed):
    conn.execute("insert into chunks (doc_id, chunk_index, source_url, title,"
                 " lang, content) values ('wc-legacy-ruou', 0, 'u', 'Rượu No.7',"
                 " 'vi', 'Rượu sâm No.7')")
    conn.commit()
    p = data_dir / "products.jsonl"
    p.unlink()
    es.sync(conn, data_dir)  # 1 nguồn không tin cậy -> legacy giữ
    assert "wc-legacy-ruou" in _docs(conn)
    _write(p, PRODUCTS)
    es.sync(conn, data_dir)  # mọi nguồn tin cậy -> legacy bị xóa
    assert "wc-legacy-ruou" not in _docs(conn)
    assert conn.execute("select count(*) from chunks where source is null"
                        ).fetchone()[0] == 0


def test_legacy_row_matching_doc_reembedded_with_hash(conn, data_dir, fake_embed):
    conn.execute("insert into chunks (doc_id, chunk_index, source_url, title,"
                 " lang, content) values ('ab-1', 0, 'u', 't', 'vi', 'cũ')")
    conn.commit()
    es.sync(conn, data_dir)
    r = conn.execute("select source, doc_sha256, doc_version, content from chunks"
                     " where doc_id = 'ab-1'").fetchall()
    assert len(r) == 1 and r[0][0] == "about.jsonl" and r[0][1] and r[0][2] == 2
    assert "Sâm Sâm" in r[0][3]


def test_manual_source_row_untouched(conn, data_dir, fake_embed):
    conn.execute("insert into chunks (doc_id, chunk_index, source_url, title,"
                 " lang, content, source, doc_sha256) values ('m-1', 0, 'u', 't',"
                 " 'vi', 'nạp tay', 'manual', 'x')")
    conn.commit()
    es.sync(conn, data_dir)
    es.sync(conn, data_dir)
    assert "m-1" in _docs(conn)


def test_read_source_variants(tmp_path):
    p = tmp_path / "x.jsonl"
    assert es.read_source(p) is None
    for raw in (b"", b"\n \n", b'{"_doc": "c"}\n\n'):
        p.write_bytes(raw)
        assert es.read_source(p) is None
    for bad in (b'{"id": "a"}\n[1, 2]\n', b'{"id": "a"}\n{"title": "no id"}\n',
                b'{"id": "a"}\n\xff\xfe\n'):
        p.write_bytes(bad)
        with pytest.raises(es.SourceError):
            es.read_source(p)
    p.write_bytes(b'{"id": "a", "body": "x\\u2028y"}\r\n')
    assert es.read_source(p) == [{"id": "a", "body": "x\u2028y"}]
