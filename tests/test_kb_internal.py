"""v3.9 W39.5 — CLI `ingest.kb_internal`: validate HẾT trước connect/embed
(exit 2), nạp lại không đổi = 0 embed, sửa file -> doc_version 2, ghi vào
`chunks_internal` KHÔNG vào `chunks`. DB thật nhưng chỉ temp table cùng tên
(pg_temp trước public) — không ghi bảng thật. `--approved-by` chỉ dùng giá
trị mẫu `MAU-test` (agent không tự điền tên người thật)."""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from ingest import embed_store, kb_internal

SAMPLE = Path(__file__).parent / "fixtures" / "kb_noi_bo_MAU.md"
BY = "MAU-test"


class _Embed:
    def __init__(self):
        self.calls = self.texts = 0

    def __call__(self, agent_id, batch, model=None, feature=None):
        assert agent_id == "ingest"
        self.calls += 1
        self.texts += len(batch)
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1, 0.2])
                                     for _ in batch])


@pytest.fixture
def fake_embed(monkeypatch):
    fe = _Embed()
    monkeypatch.setattr(embed_store, "embed", fe)
    return fe


@pytest.fixture
def no_connect(monkeypatch):
    def boom():
        raise AssertionError("connect không được gọi khi validate lỗi")
    monkeypatch.setattr(kb_internal, "connect", boom)


def test_sample_file_marked_mau():
    first = SAMPLE.read_text(encoding="utf-8").split("\n")[0]
    assert first.startswith("MẪU") and "KHÔNG phải tài liệu thật" in first


def _bad_files(tmp_path):
    f = {}
    f["missing"] = tmp_path / "nope.md"
    f["zero"] = tmp_path / "zero.md"
    f["zero"].write_bytes(b"")
    f["blank"] = tmp_path / "blank.md"
    f["blank"].write_bytes(b" \n\t\r\n")
    f["suffix"] = tmp_path / "doc.pdf"
    f["suffix"].write_bytes(b"MAU")
    f["nonutf8"] = tmp_path / "latin.txt"
    f["nonutf8"].write_bytes(b"MAU \xff\xfe s\xe2m")
    f["big"] = tmp_path / "big.md"
    f["big"].write_bytes(b"a" * (kb_internal.MAX_BYTES + 1))
    return f


@pytest.mark.parametrize("args", [
    ["--collection", "internal:kd"],  # thiếu --approved-by
    ["--collection", "internal:kd", "--approved-by", ""],
    ["--collection", "internal:kd", "--approved-by", "   "],
    ["--collection", "public", "--approved-by", BY],
    ["--collection", "internal:", "--approved-by", BY],
    ["--collection", "internal:KD", "--approved-by", BY],
    ["--collection", "internal:kd;x", "--approved-by", BY],
    ["--collection", "internal:kd", "--approved-by", BY, "--doc-id", "../x"],
])
def test_bad_args_exit2(no_connect, fake_embed, args):
    with pytest.raises(SystemExit) as e:
        kb_internal.main(["--file", str(SAMPLE), *args])
    assert e.value.code == 2 and fake_embed.calls == 0


@pytest.mark.parametrize("kind", ["missing", "zero", "blank", "suffix",
                                  "nonutf8", "big"])
def test_bad_file_exit2(tmp_path, no_connect, fake_embed, kind):
    path = _bad_files(tmp_path)[kind]
    with pytest.raises(SystemExit) as e:
        kb_internal.main(["--file", str(path), "--collection", "internal:kd",
                          "--approved-by", BY])
    assert e.value.code == 2 and fake_embed.calls == 0


def test_slug_default_doc_id():
    assert kb_internal.slug("Quy trình Kho Đà Nẵng") == "quy-trinh-kho-da-nang"
    assert kb_internal.slug("kb_noi_bo_MAU") == "kb-noi-bo-mau"


@pytest.fixture
def conn():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        c = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError:
        pytest.skip("DB không kết nối được")
    n_real = c.execute("select count(*) from public.chunks_internal").fetchone()[0]
    c.execute("create temp table chunks_internal"
              " (like public.chunks_internal including all)")
    c.execute("create temp table chunks (like public.chunks including all)")
    c.commit()
    yield c
    c.rollback()
    c.execute("drop table if exists pg_temp.chunks_internal")
    c.execute("drop table if exists pg_temp.chunks")
    c.commit()
    assert c.execute("select count(*) from public.chunks_internal"
                     ).fetchone()[0] == n_real
    c.close()


class _NoClose:
    def __init__(self, c):
        self._c = c

    def __getattr__(self, n):
        return getattr(self._c, n)

    def close(self):
        pass


def test_cli_load_reload_edit(conn, fake_embed, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(kb_internal, "connect", lambda: _NoClose(conn))
    f = tmp_path / "quy_trinh_MAU.md"
    shutil.copy(SAMPLE, f)
    argv = ["--file", str(f), "--collection", "internal:kd", "--approved-by", BY]

    assert kb_internal.main(argv) == 0
    n1 = len(embed_store.chunk_text(f.read_text(encoding="utf-8")))
    assert fake_embed.texts == n1
    rows = conn.execute("select collection, doc_id, doc_version, approved_by,"
                        " source_ref from chunks_internal").fetchall()
    assert len(rows) == n1
    assert set(rows) == {("internal:kd", "quy-trinh-mau", 1, BY, f.name)}
    assert conn.execute("select count(*) from chunks").fetchone()[0] == 0
    out = capsys.readouterr().out
    assert "Xử lý đơn đại lý" not in out  # không in nội dung file

    fake_embed.calls = fake_embed.texts = 0
    assert kb_internal.main(argv) == 0
    assert fake_embed.calls == 0
    assert "không đổi" in capsys.readouterr().out

    f.write_bytes(f.read_bytes() + ("\n\nBổ sung MẪU. " * 120).encode("utf-8"))
    assert kb_internal.main(argv) == 0
    n2 = len(embed_store.chunk_text(f.read_text(encoding="utf-8")))
    assert n2 > n1 and fake_embed.texts == n2
    vers = conn.execute("select distinct doc_version from chunks_internal"
                        " where doc_id = 'quy-trinh-mau'").fetchall()
    assert vers == [(2,)]
    assert conn.execute("select count(*) from chunks_internal").fetchone()[0] == n2
    assert conn.execute("select count(*) from chunks").fetchone()[0] == 0


def test_db_check_rejects_blank_approver_even_bypassing_cli(conn, fake_embed):
    with pytest.raises(psycopg.errors.CheckViolation):
        kb_internal.ingest_doc(conn, collection="internal:kd", doc_id="x",
                               title="t", source_ref="x.md", text="MẪU",
                               approved_by="  ")
    conn.rollback()


# --- v9.5 W95.3: tài liệu MẬT bị chặn trước connect/embed --------------------
# v12.0: gỡ CK-A1 (tài liệu mẫu cơ khí + thư mục mật riêng) — giữ chặn
# front-matter `confidential`, collection mẫu đổi sang khối sản xuất.


@pytest.fixture
def count_embed_all(monkeypatch):
    n = {"embed_all": 0}

    def fake(_c, _model, texts):
        n["embed_all"] += 1
        return [[0.1, 0.2] for _ in texts]
    monkeypatch.setattr(kb_internal, "embed_all", fake)
    return n


@pytest.mark.parametrize("head", [
    "confidential: true\n",
    "Confidential: TRUE\n",
    "   confidential :   true  \r\n",
    "\ufeffconfidential: true\n",
    "MẪU\n" * 19 + "confidential: true\n",   # dòng 20 vẫn quét
    # fail-closed (cold-check v9.5): biến thể cú pháp từng lọt fullmatch
    "confidential: true # mật\n",
    'confidential: "true"\n',
    "confidential: yes\n",
    '"confidential": true,\n',
    "- confidential: true\n",
    "**confidential: true**\n",
    "**confidential**: true\n",
    "confidential=true\n",
    "confidential:\n",                     # giá trị rỗng → chặn
    "confidential: mật\n",                 # giá trị lạ → chặn
])
def test_confidential_front_matter_exit2(tmp_path, no_connect, fake_embed,
                                         count_embed_all, head):
    f = tmp_path / "ban_ve_MAU.md"
    f.write_bytes((head + "MẪU tủ điện 3 pha\n").encode("utf-8"))
    with pytest.raises(SystemExit) as e:
        kb_internal.main(["--file", str(f), "--collection", "internal:san_xuat",
                          "--approved-by", BY])
    assert e.value.code == 2
    assert fake_embed.calls == 0 and count_embed_all["embed_all"] == 0


@pytest.mark.parametrize("head", [
    "confidential: false\n",
    "Confidential: FALSE # tài liệu thường\n",
    'confidential: "false"\n',
    "- confidential: no\n",
    "confidential = 0\n",
    "confidential: không\n",
    "Confidentiality: thấp\n",             # khóa khác, không phải confidential
    "Tài liệu này không confidential.\n",  # văn xuôi, không có [:=]
])
def test_confidential_false_passes(tmp_path, head):
    f = tmp_path / "thuong_MAU.md"
    f.write_text("MẪU\n" + head + "nội dung thường\n", encoding="utf-8")
    a, text = kb_internal.parse_args(["--file", str(f), "--collection",
                                      "internal:san_xuat", "--approved-by", BY])
    assert a.collection == "internal:san_xuat" and "nội dung thường" in text


class _FakeIngestConn:
    def __init__(self):
        self.rows = []

    def execute(self, sql, params=()):
        return SimpleNamespace(fetchone=lambda: (None, None, 0, None))

    def transaction(self):
        import contextlib
        return contextlib.nullcontext()

    def cursor(self):
        conn = self

        class _Cur:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def executemany(self, sql, rows):
                conn.rows.extend(rows)
        return _Cur()

    def commit(self):
        pass


def test_normal_mau_doc_loads_into_san_xuat(tmp_path, count_embed_all):
    f = tmp_path / "quy-trinh-dong-goi-mau.md"
    f.write_text("MẪU quy trình đóng gói\nconfidential: false\n"
                 + "Bước 1: kiểm nhãn trước khi đóng hộp.\n" * 40,
                 encoding="utf-8")
    a, text = kb_internal.parse_args(
        ["--file", str(f),
         "--collection", "internal:san_xuat", "--approved-by", BY])
    assert text.split("\n")[0].startswith("MẪU")
    conn = _FakeIngestConn()
    r = kb_internal.ingest_doc(conn, collection=a.collection, doc_id=a.doc_id,
                               title=a.path.stem, source_ref=a.path.name,
                               text=text, approved_by=a.approved_by)
    assert r["status"] == "loaded" and r["chunks"] == len(conn.rows) > 0
    assert count_embed_all["embed_all"] == 1
    assert {row[0] for row in conn.rows} == {"internal:san_xuat"}
    assert {row[9] for row in conn.rows} == {BY}
    assert a.doc_id == "quy-trinh-dong-goi-mau"
