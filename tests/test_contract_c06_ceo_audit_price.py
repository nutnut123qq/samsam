"""Đợt hợp đồng C06 — ceo-04.1 giá/mô tả listing đang chạy so bản duyệt
(agents.ceo_audit.collect checks). DB thật (schema tạm + roles ×2, ROLLBACK)."""

import json

import pytest

from agents import ceo_audit as ca
from pipelines import store
from tests.test_ceo_audit import ceo_db

SKU = "mat-ong-sam-120ml-1hu"
CFG = {"quy_trinh_duyet_tu": __import__("datetime").date(2026, 1, 1)}


@pytest.fixture
def db():
    yield from ceo_db()


def _setup(db, prices, desc=None):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values (%s, 'SKU giả', 'food', 'manual') on conflict do"
               " nothing", (SKU,))
    # dữ liệu giá LỊCH SỬ giả cho test: tắt trigger append-only trong setup
    db.execute("set local session_replication_role = replica")
    for p, vf, vt, by in prices:
        db.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
                   " valid_from, valid_to, approved_by) values (%s, 'shopee',"
                   " 'list', %s, %s, %s, %s)", (SKU, p, vf, vt, by))
    db.execute("set local session_replication_role = origin")
    text = "Mật ong sâm 120ml\nMô tả chuẩn đã duyệt. Nội dung có sử dụng AI."
    did = store.save_draft(db, "listing", "shopee", text,
                           {"ok": True, "violations": []}, store.SOURCE_CLI,
                           created_by="agent:mkt02", content_type="listing",
                           sku=SKU, is_ai=True)
    db.execute("select approve_draft(%s, 'GĐ Bán Hàng', null)", (did,))
    sid = db.execute("insert into market_snapshots (channel, export_kind,"
                     " file_name, file_sha256, row_count, imported_at) values"
                     " ('shopee', 'listing', 'f.csv', %s, 1,"
                     " '2026-10-15T09:00:00+07') returning id",
                     ("c" * 64,)).fetchone()[0]
    raw = {"title": "Mật ong sâm 120ml"}
    if desc is not None:
        raw["description"] = desc
    db.execute("insert into market_rows (snapshot_id, row_no, channel,"
               " export_kind, item_id, sku_key, title, price_vnd, raw) values"
               " (%s, 2, 'shopee', 'listing', 'it1', %s, 'Mật ong sâm 120ml',"
               " 250000, %s)", (sid, SKU, json.dumps(raw)))


def _check(db):
    [c] = ca.collect(db, CFG)["checks"]
    return c


def test_price_match_and_desc_match(db):
    _setup(db, [(250000, "2026-01-01", None, "GĐ Bán Hàng")],
           desc="Mô tả chuẩn  đã duyệt.  Nội dung có sử dụng AI.")
    c = _check(db)
    assert (c["price"], c["desc"]) == (ca.KHOP, ca.KHOP)
    assert c["observed"] == "2026-10-15"


def test_price_lech_and_desc_lech(db):
    _setup(db, [(260000, "2026-01-01", None, "GĐ Bán Hàng")],
           desc="Mô tả khác — chữa bệnh")
    c = _check(db)
    assert c["price"] == ca.LECH and "duyệt 260000" in c["price_why"]
    assert c["desc"] == ca.LECH
    lines = "\n".join(ca.check_lines([c]))
    assert "giá lech_ban_duyet" in lines and "market_rows #" in lines


def test_unapproved_or_expired_price_not_compared(db):
    _setup(db, [(250000, "2026-01-01", "2026-10-01", "GĐ Bán Hàng"),
                (250000, "2026-10-01", None, None)])
    c = _check(db)
    assert c["price"] == "khong_so_duoc"
    assert "chưa có giá list ĐÃ DUYỆT" in c["price_why"]
    assert c["desc"] == "khong_so_duoc"
    assert "chưa có cột mô tả" in "\n".join(ca.check_lines([c]))


def test_no_snapshot_no_data():
    assert "chưa có dữ liệu quan sát" in "\n".join(ca.check_lines([]))
