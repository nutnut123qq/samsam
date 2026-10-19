"""Đợt DOCX vòng 2 — provenance dữ kiện KPI chat cũ (PL02 mục 3, HĐ 7.3).

Trước sửa: `chat_kpi_facts` (không cột provenance) chụp cả dòng mock/demo/cũ;
`ops_monthly` gộp mọi dòng bảng này vào KPI vận hành (`_q_chat_facts` +
`merge_chat`) — lọc convlog mới không làm sạch số tổng hợp. Sau sửa: KPI chỉ
đọc sổ `chat_kpi_live` (dữ kiện có bằng chứng convlog `provenance: live`,
khóa qkey + sha nội dung) + convlog live; dòng cũ = UNKNOWN đếm riêng, không
xóa/sửa, không che dòng live cùng khóa.

DB: schema tạm + ROLLBACK (`tests.test_ceo_audit.ceo_db`), dữ liệu GIẢ."""

import hashlib
import json
from datetime import datetime

import psycopg
import pytest

from scripts import ops_monthly as om
from tests.test_ceo_audit import TxConn, ceo_db

START = datetime.fromisoformat("2026-10-01T00:00:00+07:00")
END = datetime.fromisoformat("2026-11-01T00:00:00+07:00")


@pytest.fixture
def db():
    yield from ceo_db()


def _qkey(mid):
    return hashlib.sha256(f"convlog:{mid}".encode()).hexdigest()


def _old(db, mid, handled=True):
    """Dòng `chat_kpi_facts` chụp TRƯỚC bản lọc (không provenance)."""
    db.execute("insert into chat_kpi_facts (qkey, ts, channel, is_question,"
               " handled_by_bot, group_oid, reply_ms) values (%s,"
               " '2026-10-05T03:00:00Z', 'zalo', true, %s, null, 900)",
               (_qkey(mid), handled))


def _conv(tmp_path, recs):
    base = {"user_hash": "h" * 16, "question": "giá bao nhiêu",
            "channel": "zalo", "sent": True, "reply_ms": 1000}
    (tmp_path / "conversations.jsonl").write_text("\n".join(
        json.dumps({**base, **r}, ensure_ascii=False) for r in recs) + "\n",
        encoding="utf-8")


def _kpi(db, tmp_path):
    dbf = om.collect_db(TxConn(db), START, END)
    conv = om.merge_chat(om.read_convlog(tmp_path, START, END),
                         dbf.get("chat_facts"))
    return conv, dbf


def _report(db, tmp_path):
    f = om.gather(START, END, END, conn=TxConn(db), data_dir=tmp_path,
                  assets=om.load_assets(om.ASSETS))
    return om.render(f)


def test_kpi_old_unknown_rows_not_counted(db, tmp_path):
    for i in range(4):
        _old(db, f"mock0-{i}")                      # snapshot cũ chứa mock
    conv, dbf = _kpi(db, tmp_path)                  # không còn convlog
    assert conv["questions"] == [] and not conv["exists"]
    assert dbf["chat_unknown"] == 4
    md = _report(db, tmp_path)
    assert "4 dữ kiện chụp trước bản lọc provenance" in md
    assert "không có convlog" in md          # KPI = thiếu dữ liệu, không "đạt"


def test_kpi_live_snapshot_counted_after_convlog_gone(db, tmp_path):
    _conv(tmp_path, [
        {"ts": "2026-10-06T02:00:00Z", "msg_id": "z1", "answered": True,
         "provenance": "live"},
        {"ts": "2026-10-06T02:05:00Z", "msg_id": "mock0-9", "answered": True,
         "provenance": "sample", "is_sample": True},
        {"ts": "2026-10-06T02:06:00Z", "msg_id": "demo-1", "answered": True,
         "provenance": "demo", "is_sample": True},
        {"ts": "2026-10-06T02:07:00Z", "msg_id": "old-1", "answered": True}])
    assert om.snapshot(TxConn(db), tmp_path) == (1, 1)
    assert om.snapshot(TxConn(db), tmp_path) == (1, 0)     # chạy lại
    assert db.execute("select count(*) from chat_kpi_facts").fetchone()[0] \
        == 0                                                # không ghi bảng cũ
    (tmp_path / "conversations.jsonl").unlink()            # convlog đã xoay
    conv, _ = _kpi(db, tmp_path)
    assert len(conv["questions"]) == 1 and conv["exists"]


def test_kpi_same_key_live_not_shadowed_no_double(db, tmp_path):
    _old(db, "z7", handled=False)                    # dòng cũ cùng khóa
    _conv(tmp_path, [{"ts": "2026-10-07T02:00:00Z", "msg_id": "z7",
                      "answered": True, "provenance": "live"}])
    assert om.snapshot(TxConn(db), tmp_path) == (1, 1)     # không bị chặn
    for keep_conv in (True, False):
        if not keep_conv:
            (tmp_path / "conversations.jsonl").unlink()
        conv, dbf = _kpi(db, tmp_path)
        assert len(conv["questions"]) == 1, conv["questions"]
        assert conv["questions"][0][1] is True       # bản LIVE, không bản cũ
        assert dbf["chat_unknown"] == 0              # đã có bản live cùng khóa
    # lịch sử dòng cũ giữ nguyên, bất biến
    assert db.execute("select handled_by_bot from chat_kpi_facts").fetchall() \
        == [(False,)]
    with pytest.raises(psycopg.errors.RaiseException):
        db.execute("update chat_kpi_facts set handled_by_bot = true")


def test_kpi_no_trusted_data_reports_missing(db, tmp_path):
    _old(db, "x1")
    _conv(tmp_path, [{"ts": "2026-10-08T02:00:00Z", "msg_id": "x2",
                      "answered": True}])                  # thiếu provenance
    conv, dbf = _kpi(db, tmp_path)
    assert conv["questions"] == [] and dbf["chat_unknown"] == 1
    md = _report(db, tmp_path)
    row = next(ln for ln in md.splitlines()
               if ln.startswith("| Câu hỏi khách xử lý"))
    assert "— (0/0)" in row and "Đạt" not in row and "ĐẠT" not in row, row
    assert "1 dữ kiện chụp trước bản lọc provenance" in md
