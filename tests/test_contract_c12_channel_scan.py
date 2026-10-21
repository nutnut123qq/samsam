"""Đợt hợp đồng C12 — legal_hr-04 quét kênh tự thu (agents.ra_kenh
web_rows/listing_rows/--scan-auto). Fixture crawl giả + DB thật (schema tạm,
ROLLBACK). Không request mạng."""

import json
import os
import time
from datetime import datetime, timedelta

import pytest

from agents import ra_kenh as rk
from pipelines.period import VN_TZ
from tests.test_ceo_audit import TxConn, ceo_db

NOW = datetime(2026, 10, 20, 9, tzinfo=VN_TZ)
BAD = ("Sâm Sâm chữa khỏi bệnh tiểu đường cho người bị tiểu đường.")
OK = "Sâm Sâm ra mắt hộp quà Tết mới."


def _crawl(d, name, rows, age_days=0):
    f = d / f"{name}.jsonl"
    f.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows)
                 + "\nkhong-phai-json\n", encoding="utf-8")
    t = time.time() - age_days * 86400
    os.utime(f, (t, t))
    return f


def test_web_rows_fresh_stale_missing(tmp_path):
    _crawl(tmp_path, "articles", [
        {"id": 1, "title": "Bài A", "body": BAD,
         "url": "https://samsam.example/a", "published_at": "2026-10-01"},
        {"id": 2, "title": "Bài B", "body": OK, "url": "javascript:x"}])
    _crawl(tmp_path, "news", [{"title": "Tin", "body": OK,
                               "url": "https://samsam.example/n"}],
           age_days=30)
    rows, notes = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    assert [r["url"] for r in rows] == ["https://samsam.example/a"]
    assert rows[0]["posted_on"].isoformat() == "2026-10-01"
    assert any("news: dữ liệu crawl cũ" in n for n in notes)
    assert any("products: chưa có tệp" in n for n in notes)
    assert any("dòng 3 hỏng" in n for n in notes)


@pytest.fixture
def db():
    yield from ceo_db()


def _cfg():
    return rk.load_config()


def test_scan_auto_ingest_ticket_and_idempotent(db, tmp_path):
    _crawl(tmp_path, "articles", [
        {"title": "Bài A", "body": BAD, "url": "https://samsam.example/a",
         "published_at": "2026-10-01"},
        {"title": "Bài B", "body": OK, "url": "https://samsam.example/b",
         "published_at": "2025-01-01"}])
    rows, _ = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    c = TxConn(db)
    st = rk.ingest(c, rows, _cfg(), by=rk.AUTO_BY, now=NOW, auto=True)
    assert st["new"] == 2 and st["S1"] >= 1
    due = db.execute("select due_at - first_detected_at, imported_by from"
                     " channel_posts where url = 'https://samsam.example/a'"
                     ).fetchone()
    assert due == (timedelta(hours=24), rk.AUTO_BY)
    assert db.execute("select count(*) from approval_queue where block ="
                      " 'legal_hr'").fetchone()[0] >= 1
    st2 = rk.ingest(c, rows, _cfg(), by=rk.AUTO_BY, now=NOW, auto=True)
    assert st2["new"] == 0 and st2["skip"] == 2
    with pytest.raises(ValueError):
        rk.ingest(c, rows, _cfg(), by="Người Thật", now=NOW, auto=True)
    with pytest.raises(ValueError):
        rk.ingest(c, rows, _cfg(), by=rk.AUTO_BY, now=NOW)  # file cần người


def test_listing_rows_from_latest_snapshot_no_draft_code(db):
    for i, (fn, title) in enumerate((("cu.csv", "cũ"), ("moi.csv", BAD))):
        sid = db.execute("insert into market_snapshots (channel, export_kind,"
                         " file_name, file_sha256, row_count, imported_at)"
                         " values ('shopee', 'listing', %s, %s, 1, now() +"
                         " %s * interval '1 minute') returning id",
                         (fn, str(i) * 64, i)).fetchone()[0]
        db.execute("insert into market_rows (snapshot_id, row_no, channel,"
                   " export_kind, item_id, title, raw) values (%s, 2,"
                   " 'shopee', 'listing', 'IT9', %s, '{}')", (sid, title))
    rows = rk.listing_rows(db)
    assert [(r["url"], r["text"]) for r in rows] == [("shopee:listing:IT9",
                                                       BAD)]
    s = rk.scan_row(rows[0], _cfg())
    assert "thieu_ban_duyet" not in s["codes"] and s["severity"] == "S1"


def test_svc_job_can_ingest(db, tmp_path):
    _crawl(tmp_path, "articles", [{"title": "Bài A", "body": BAD,
                                   "url": "https://samsam.example/a"}])
    rows, _ = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    with db.transaction(force_rollback=True):
        db.execute("set local role svc_job")
        st = rk.ingest(TxConn(db), rows, _cfg(), by=rk.AUTO_BY, now=NOW,
                       auto=True)
        assert st["new"] == 1


def test_cli_rejects_by_with_scan_auto():
    with pytest.raises(SystemExit):
        rk.main(["--scan-auto", "--by", "Người"])
