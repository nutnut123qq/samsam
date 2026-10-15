"""v9.3 W93.5 — scripts/garden_media.py: gỡ TOÀN BỘ EXIF/GPS/XMP/text,
lưu ngoài repo theo sha256, metadata `garden_media`.

Ảnh test sinh trong bộ nhớ / `tmp_path` (không file nào vào repo). Tiền
điều kiện: ảnh nguồn CÓ GPS — nếu không, test "0 GPS" pass ảo.
"""

import io
import struct
import sys
from pathlib import Path

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image
from PIL.PngImagePlugin import PngInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import garden_media as gm

from tests.test_garden_chain import _TxConn, temp_schema_conn

LAT = (15.0, 4.0, 37.29)
LON = (108.0, 1.0, 59.77)
XMP = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
       b'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude='
       b'"15,4.62N"/></rdf:RDF></x:xmpmeta>')
DEAD_DSN = "postgresql://u@10.255.255.1:5432/x"
LEAKS = (b"Exif\x00\x00", b"GPS", b"ns.adobe.com/xap", b"eXIf", b"tEXt",
         b"iTXt", b"Canon", b"EOS-R")


@pytest.fixture
def db():
    yield from temp_schema_conn()


def _exif():
    e = Image.Exif()
    e[0x010F] = "Canon"           # Make
    e[0x0110] = "EOS-R"           # Model
    e[0x0112] = 6                 # Orientation: xoay 90°
    e.get_ifd(0x8769)[0x9003] = "2026:10:01 08:00:00"   # DateTimeOriginal
    gps = e.get_ifd(0x8825)
    gps[1], gps[2], gps[3], gps[4] = "N", LAT, "E", LON
    return e


def _with_xmp(jpeg: bytes) -> bytes:
    """Chèn segment APP1 XMP ngay sau SOI."""
    payload = b"http://ns.adobe.com/xap/1.0/\x00" + XMP
    seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    return jpeg[:2] + seg + jpeg[2:]


def _jpeg_gps(size=(32, 16)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (20, 160, 40)).save(buf, "JPEG", exif=_exif())
    return _with_xmp(buf.getvalue())


def _png_gps(alpha=True) -> bytes:
    info = PngInfo()
    info.add_text("Comment", "GPS 15.077 108.033")
    info.add_itxt("XML:com.adobe.xmp", XMP.decode())
    buf = io.BytesIO()
    mode, color = ("RGBA", (1, 2, 3, 120)) if alpha else ("RGB", (1, 2, 3))
    Image.new(mode, (8, 8), color).save(buf, "PNG", exif=_exif(),
                                        pnginfo=info)
    return buf.getvalue()


def _assert_source_has_gps(data: bytes):
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        assert dict(im.getexif().get_ifd(0x8825))[2] == LAT


def _assert_clean(out: bytes):
    with Image.open(io.BytesIO(out)) as im:
        im.load()
        assert len(im.getexif()) == 0
        for k in ("exif", "xmp", "icc_profile", "XML:com.adobe.xmp",
                  "Comment"):
            assert k not in im.info, k
        assert getattr(im, "text", {}) == {}
    for leak in LEAKS:
        assert leak not in out, leak


# ------------------------------------------------------------ strip_image

def test_jpeg_with_gps_stripped():
    src = _jpeg_gps()
    _assert_source_has_gps(src)
    assert b"ns.adobe.com/xap" in src and b"Canon" in src
    out, ext, info = gm.strip_image(src)
    assert ext == "jpg"
    _assert_clean(out)
    assert info["had_gps"] is True and info["exif_removed"] >= 7
    # Orientation 6 áp vào pixel trước khi bỏ thẻ → ảnh dựng đứng 16x32.
    assert (info["width"], info["height"]) == (16, 32)
    assert set(info) == {"exif_removed", "had_gps", "width", "height"}


def test_png_with_exif_and_text_stripped():
    src = _png_gps(alpha=True)
    _assert_source_has_gps(src)
    assert b"eXIf" in src and b"tEXt" in src
    out, ext, info = gm.strip_image(src)
    assert ext == "png" and info["had_gps"] is True
    _assert_clean(out)
    with Image.open(io.BytesIO(out)) as im:
        assert im.mode == "RGBA"


def test_png_without_alpha_becomes_jpeg_and_clean():
    out, ext, _ = gm.strip_image(_png_gps(alpha=False))
    assert ext == "jpg"
    _assert_clean(out)


def test_no_exif_image_ok():
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, "WEBP")
    out, ext, info = gm.strip_image(buf.getvalue())
    _assert_clean(out)
    assert ext == "jpg" and info["had_gps"] is False
    assert info["exif_removed"] == 0


@pytest.mark.parametrize("data", [b"", b"khong phai anh", b"\xff\xd8\xff"])
def test_reject_non_image(data):
    with pytest.raises(ValueError):
        gm.strip_image(data)


def test_mpo_multi_frame_phone_jpeg_stripped():
    """iPhone 'Most Compatible'/Samsung: .jpg nhiều khung, Pillow báo 'MPO'
    — phải nhận (không ValueError), bản lưu 1 khung, 0 EXIF/GPS."""
    a = Image.new("RGB", (32, 16), (20, 160, 40))
    b = Image.new("RGB", (32, 16), (200, 10, 10))
    buf = io.BytesIO()
    a.save(buf, "MPO", exif=_exif(), save_all=True, append_images=[b])
    src = buf.getvalue()
    with Image.open(io.BytesIO(src)) as im:
        assert im.format == "MPO" and im.n_frames == 2
    _assert_source_has_gps(src)
    out, ext, info = gm.strip_image(src)
    assert ext == "jpg" and info["had_gps"] is True
    _assert_clean(out)
    with Image.open(io.BytesIO(out)) as im:
        assert im.format == "JPEG" and getattr(im, "n_frames", 1) == 1


def test_reject_gif_and_oversize(monkeypatch):
    buf = io.BytesIO()
    Image.new("P", (4, 4)).save(buf, "GIF")
    with pytest.raises(ValueError, match="GIF"):
        gm.strip_image(buf.getvalue())
    monkeypatch.setattr(gm, "MAX_BYTES", 100)
    with pytest.raises(ValueError, match="MB"):
        gm.strip_image(_jpeg_gps())


@pytest.mark.parametrize("limit", [10, 400])    # Error (>2x) / Warning (>1x)
def test_reject_decompression_bomb(monkeypatch, limit):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", limit)
    with pytest.raises(ValueError, match="bomb"):
        gm.strip_image(_jpeg_gps())             # 32x16 = 512 px


# ------------------------------------------------------------------ store

def test_store_content_addressed_idempotent(tmp_path):
    out, ext, _ = gm.strip_image(_jpeg_gps())
    sha, path = gm.store(out, ext, tmp_path)
    sha2, path2 = gm.store(out, ext, tmp_path)
    assert (sha, path) == (sha2, path2)
    assert path == tmp_path / sha[:2] / f"{sha}.jpg"
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == [path]
    assert path.read_bytes() == out


# -------------------------------------------------------------------- CLI

def _cli(tmp_path, store, plot="KV-T01", name="IMG_2026_GPS.jpg"):
    src = tmp_path / name
    src.write_bytes(_jpeg_gps())
    return ["--file", str(src), "--plot", plot, "--date", "2026-10-12",
            "--by", "Bé Na", "--store", str(store)]


def _files(d: Path):
    return [p for p in d.rglob("*") if p.is_file()] if d.exists() else []


def test_cli_store_inside_repo_exit2(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("connect() không được gọi")
    monkeypatch.setattr(gm, "connect", boom)
    inside = gm.ROOT / "data" / "tmp_garden_media_test"
    assert gm.main(_cli(tmp_path, inside)) == 2
    assert not inside.exists()
    assert gm.main(_cli(tmp_path, gm.ROOT / "data" / ".." / "x")) == 2


def test_cli_missing_store_exit2(tmp_path, monkeypatch):
    monkeypatch.setenv("GARDEN_MEDIA_DIR", "")
    argv = _cli(tmp_path, "x")[:-2]
    assert gm.main(argv) == 2


@pytest.mark.parametrize("argv_patch", [("--by", "  "), ("--date", "12/10"),
                                        ("--plot", " ")])
def test_cli_usage_errors(tmp_path, argv_patch):
    argv = _cli(tmp_path, tmp_path / "store")
    argv[argv.index(argv_patch[0]) + 1] = argv_patch[1]
    with pytest.raises(SystemExit) as e:
        gm.main(argv)
    assert e.value.code == 2


def test_cli_dead_db_exit2_no_file(tmp_path, monkeypatch):
    """Host chết THẬT — connect TRƯỚC khi xử lý ảnh → 0 file ghi."""
    monkeypatch.setenv("DATABASE_URL", DEAD_DSN)
    store = tmp_path / "store"
    assert gm.main(_cli(tmp_path, store)) == 2
    assert _files(store) == []


# ------------------------------------------------------- DB (rollback)

def _plot(db, pid="KV-T01"):
    db.execute("insert into plots (id, location, source) values (%s,"
               " 'Trà My', 'manual')", (pid,))


def test_record_and_cli_end_to_end(db, tmp_path, monkeypatch, capsys):
    _plot(db)
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    store = tmp_path / "store"
    argv = _cli(tmp_path, store)
    assert gm.main(argv) == 0
    out = capsys.readouterr().out
    assert "có GPS: có" in out
    for leak in ("37.29", "59.77", "15.0", "IMG_2026_GPS", str(tmp_path),
                 "Bé Na"):
        assert leak not in out, leak
    files = _files(store)
    assert len(files) == 1
    _assert_clean(files[0].read_bytes())
    row = db.execute("select sha256, plot_id, taken_on::text, author,"
                     " had_gps, exif_removed, bytes from garden_media"
                     ).fetchall()
    assert len(row) == 1
    sha, plot, day, author, had_gps, n, nbytes = row[0]
    assert files[0].name == f"{sha}.jpg" and sha[:12] in out
    assert (plot, day, author, had_gps) == ("KV-T01", "2026-10-12", "Bé Na",
                                            True)
    assert n >= 7 and nbytes == files[0].stat().st_size
    # Nạp lại cùng ảnh → 1 file, 1 dòng.
    assert gm.main(argv) == 0
    assert "đã có trong kho" in capsys.readouterr().out
    assert len(_files(store)) == 1
    assert db.execute("select count(*) from garden_media").fetchone()[0] == 1


def test_cli_unknown_plot_exit1_no_file(db, tmp_path, monkeypatch):
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    store = tmp_path / "store"
    assert gm.main(_cli(tmp_path, store, plot="KV-NONE")) == 1
    assert _files(store) == []


def test_cli_rejects_non_image_no_file(db, tmp_path, monkeypatch):
    _plot(db)
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    store = tmp_path / "store"
    argv = _cli(tmp_path, store, name="x.jpg")
    Path(argv[1]).write_bytes(b"not an image")
    assert gm.main(argv) == 1
    assert _files(store) == []
    assert db.execute("select count(*) from garden_media").fetchone()[0] == 0


def test_record_fk_unknown_plot(db):
    import psycopg

    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        gm.record(_TxConn(db), "d" * 64, "jpg", 5,
                  {"width": 1, "height": 1, "exif_removed": 0,
                   "had_gps": False}, "KV-NONE", "2026-10-12", "Bé")
