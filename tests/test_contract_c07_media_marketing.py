"""Đợt hợp đồng C07 — farming-04 cấp tư liệu vườn cho Marketing
(garden_media_releases, v_garden_media_marketing, scripts/garden_media_mkt.py).
DB thật (schema tạm + roles ×2, ROLLBACK); kho tệp = tmp_path."""

import io
from datetime import date

import psycopg
import pytest

from scripts import garden_media as gm
from scripts import garden_media_mkt as mk
from tests.test_ceo_audit import TxConn, ceo_db


@pytest.fixture
def db():
    yield from ceo_db()


def _png(color=(10, 120, 30), exif=False) -> bytes:
    Image, _ = gm._pil()
    img = Image.new("RGB", (8, 8), color)
    buf = io.BytesIO()
    if exif:
        ex = img.getexif()
        ex[0x010F] = "Camera Gia"          # Make
        img.save(buf, "JPEG", exif=ex)
    else:
        img.save(buf, "PNG")
    return buf.getvalue()


def _media(db, store, data, ext, source="cli:garden_media"):
    sha, _ = gm.store(data, ext, store)
    db.execute("insert into plots (id, location, source) values ('KV-C7',"
               " 'x', 'manual') on conflict do nothing")
    db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
               " taken_on, author, source) values (%s, %s, %s, 'KV-C7', %s,"
               " 'Ky thuat', %s)", (sha, ext, len(data), date(2026, 10, 1),
                                    source))
    return sha


def _rel(db, sha, action="cap", by="GĐ Vùng Trồng"):
    return db.execute("select garden_media_release_human(%s, %s, %s, null)",
                      (sha, action, by)).fetchone()[0]


def test_release_get_revoke(db, tmp_path):
    store, out = tmp_path / "kho", tmp_path / "mkt"
    clean, ext, _info = gm.strip_image(_png())
    sha = _media(db, store, clean, ext)
    c = TxConn(db)
    with pytest.raises(mk.MediaError, match="chưa được cấp"):
        mk.get(c, sha, out, store)
    assert _rel(db, sha) is True and _rel(db, sha) is False   # không lặp
    rows = db.execute("select * from v_garden_media_marketing").fetchall()
    assert len(rows) == 1 and rows[0][0] == sha
    cols = [d.name for d in db.execute(
        "select * from v_garden_media_marketing").description]
    assert "plot_id" not in cols and "author" not in cols
    dst = mk.get(c, sha, out, store)
    assert dst.read_bytes() == clean
    assert _rel(db, sha, "thu_hoi") is True
    with pytest.raises(mk.MediaError, match="chưa được cấp"):
        mk.get(c, sha, tmp_path / "mkt2", store)


def test_tampered_missing_exif_and_repo_out(db, tmp_path):
    store, out = tmp_path / "kho", tmp_path / "mkt"
    clean, ext, _ = gm.strip_image(_png((1, 2, 3)))
    sha = _media(db, store, clean, ext)
    _rel(db, sha)
    c = TxConn(db)
    with pytest.raises(mk.MediaError, match="trong repo"):
        mk.get(c, sha, mk.ROOT / "data" / "x", store)
    f = store / sha[:2] / f"{sha}.{ext}"
    f.write_bytes(clean + b"x")
    with pytest.raises(mk.MediaError, match="lệch sha256"):
        mk.get(c, sha, out, store)
    f.unlink()
    with pytest.raises(mk.MediaError, match="thiếu tệp"):
        mk.get(c, sha, out, store)
    dirty = _png(exif=True)               # tệp còn EXIF (ghi sai quy trình)
    sha2 = _media(db, store, dirty, "jpg")
    _rel(db, sha2)
    with pytest.raises(mk.MediaError, match="EXIF"):
        mk.get(c, sha2, out, store)
    assert not out.exists() or list(out.iterdir()) == []


def test_sample_hidden_agent_refused_and_privileges(db, tmp_path):
    clean, ext, _ = gm.strip_image(_png((9, 9, 9)))
    sha = _media(db, tmp_path / "kho", clean, ext, source="sample:test")
    _rel(db, sha)
    assert db.execute("select count(*) from v_garden_media_marketing"
                      ).fetchone()[0] == 0
    with pytest.raises(psycopg.Error), db.transaction():
        _rel(db, sha, "thu_hoi", by="agent:mkt")
    with db.transaction(force_rollback=True):
        db.execute("set local role app_human")
        db.execute("select sha256 from v_garden_media_marketing").fetchall()
        with pytest.raises(psycopg.errors.InsufficientPrivilege), \
                db.transaction():
            db.execute("select author from garden_media")
        with pytest.raises(psycopg.errors.InsufficientPrivilege), \
                db.transaction():
            db.execute("insert into garden_media_releases (sha256, action,"
                       " by_person) values (%s, 'cap', 'x')", (sha,))
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("delete from garden_media_releases")
