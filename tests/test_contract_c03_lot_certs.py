"""Đợt hợp đồng C03 — production-04.1 phiếu kiểm nghiệm lô
(pipelines/lot_certs.py, bảng lot_test_certificates, CLI production cert).
DB thật (schema tạm + roles ×2, ROLLBACK); kho tệp = tmp_path."""

import datetime as dt

import psycopg
import pytest

from pipelines import lot_certs, production
from tests.test_ceo_audit import TxConn, ceo_db

PDF = b"%PDF-1.4 phieu kiem nghiem gia"
PNG = bytes.fromhex("89504e470d0a1a0a") + b"anh phieu"


@pytest.fixture
def db():
    yield from ceo_db()


@pytest.fixture
def lot(db):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('c3-sku', 'SKU giả', 'food', 'manual')"
               " on conflict do nothing")
    db.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
               " exp_date, qty, source) values ('C3-LOT', 'c3-sku',"
               " '2026-10-01', '2027-10-01', 5, 'manual'), ('C3-OLD',"
               " 'c3-sku', '2026-09-01', '2027-09-01', 5, 'manual')")
    return "C3-LOT"


def _f(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return p


def test_versions_hash_and_history(db, lot, tmp_path):
    store = tmp_path / "kho"
    c = TxConn(db)
    v1 = lot_certs.record(c, lot, _f(tmp_path, "a.pdf", PDF), "KN-001",
                          "Tổ Trưởng SX", lab="Lab A",
                          issued=dt.date(2026, 10, 2), store=store)
    v2 = lot_certs.record(c, lot, _f(tmp_path, "b.bin", PNG), "KN-001b",
                          "Tổ Trưởng SX", store=store)
    assert (v1, v2) == (1, 2)
    rows = db.execute("select version, cert_no, file_ext, recorded_by from"
                      " lot_test_certificates order by version").fetchall()
    assert rows == [(1, "KN-001", "pdf", "Tổ Trưởng SX"),
                    (2, "KN-001b", "png", "Tổ Trưởng SX")]
    # tệp lưu theo hash ngoài repo
    shas = [r[0] for r in db.execute("select file_sha256 from"
                                     " lot_test_certificates")]
    assert all((store / s).is_file() for s in shas)
    # cùng tệp ghi lại → từ chối; append-only
    with pytest.raises(ValueError, match="đã ghi"), db.transaction():
        lot_certs.record(c, lot, _f(tmp_path, "c.pdf", PDF), "KN-002",
                         "Tổ Trưởng SX", store=store)
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("update lot_test_certificates set cert_no = 'x'")
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("delete from lot_test_certificates")


def test_wrong_lot_bad_file_agent_refused(db, lot, tmp_path):
    store = tmp_path / "kho"
    c = TxConn(db)
    with pytest.raises(ValueError, match="không tồn tại"), db.transaction():
        lot_certs.record(c, "KHONG-CO", _f(tmp_path, "a.pdf", PDF), "KN",
                         "Tổ Trưởng SX", store=store)
    with pytest.raises(lot_certs.CertError, match="magic"):
        lot_certs.record(c, lot, _f(tmp_path, "x.pdf", b"khong phai pdf"),
                         "KN", "Tổ Trưởng SX", store=store)
    with pytest.raises(lot_certs.CertError, match="rỗng"):
        lot_certs.record(c, lot, _f(tmp_path, "e.pdf", b""), "KN",
                         "Tổ Trưởng SX", store=store)
    from pipelines import auth
    with pytest.raises((psycopg.Error, auth.HumanDenied)), db.transaction():
        lot_certs.record(c, lot, _f(tmp_path, "g.pdf", PDF + b"2"), "KN",
                         "agent:sx", store=store)
    assert db.execute("select count(*) from lot_test_certificates"
                      ).fetchone()[0] == 0


def test_cert_dir_outside_repo(monkeypatch, tmp_path):
    monkeypatch.delenv("LOT_CERT_DIR", raising=False)
    with pytest.raises(lot_certs.CertError, match="chưa cấu hình"):
        lot_certs.cert_dir()
    monkeypatch.setenv("LOT_CERT_DIR", str(lot_certs.ROOT / "data" / "x"))
    with pytest.raises(lot_certs.CertError, match="trong repo"):
        lot_certs.cert_dir()
    monkeypatch.setenv("LOT_CERT_DIR", str(tmp_path))
    assert lot_certs.cert_dir() == tmp_path.resolve()


def test_verify_missing_tampered_and_old_lot(db, lot, tmp_path):
    store = tmp_path / "kho"
    c = TxConn(db)
    lot_certs.record(c, lot, _f(tmp_path, "a.pdf", PDF), "KN-1", "A",
                     store=store)
    st = {r["lot"]: r["state"] for r in lot_certs.verify(db, store)}
    assert st == {"C3-LOT": "ok", "C3-OLD": "thieu_phieu"}
    sha = db.execute("select file_sha256 from lot_test_certificates"
                     ).fetchone()[0]
    (store / sha).chmod(0o644)
    (store / sha).write_bytes(b"%PDF-sua")
    assert lot_certs.verify(db, store, lot)[0]["state"] == "lech_hash"
    (store / sha).unlink()
    assert lot_certs.verify(db, store, lot)[0]["state"] == "thieu_tep"


def test_bulletin_shows_missing(db, lot, tmp_path):
    lot_certs.record(TxConn(db), lot, _f(tmp_path, "a.pdf", PDF), "KN-9",
                     "A", store=tmp_path / "kho")
    data = production.collect(db, None)
    txt = production.render_bulletin(
        data, dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc),
        production.load_config())
    sec = txt.split("## Phiếu kiểm nghiệm lô")[1].split("## ")[0]
    assert "C3-LOT (pending) · phiếu KN-9 (v1)" in sec
    assert "C3-OLD (pending) · THIẾU phiếu" in sec
