"""v6.5 W65.1/W65.2 — `pipelines.mkt_metrics` (số đo marketing THUẦN + query)
và mục 5 "Marketing" của `agents.report` end-to-end trên DB thật.

Test DB: 1 transaction trên `DATABASE_URL`, schema tạm + docs/schema.sql +
docs/roles.sql → ROLLBACK cuối test (precedent tests/test_cockpit.py). Mốc
quá khứ của approval_queue chèn bằng superuser `session_replication_role =
replica` (bỏ trigger). Code gọi `conn.commit()` → bọc `_TxConn`. Skip khi
không có DB — gate yêu cầu 0 skipped. Số kênh trong fixture là số MẪU bịa.
"""

import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import report as rep
from pipelines import cockpit as ck
from pipelines import mkt_metrics as mm
from pipelines.period import period_bounds, rolling_bounds

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
VN = timezone(timedelta(hours=7))
OK_SNAP = {"ok": True, "violations": []}


# ------------------------------------------------------------ thuần

def test_review_summary_pure():
    assert mm.review_summary([]) == {"n": 0, "median_h": None,
                                     "p90_h": None, "max_h": None}
    assert mm.review_summary([5]) == {"n": 1, "median_h": 5.0,
                                      "p90_h": 5.0, "max_h": 5.0}
    s = mm.review_summary(range(1, 11))
    assert s == {"n": 10, "median_h": 5.5, "p90_h": 9.0, "max_h": 10.0}
    # nearest-rank không phụ thuộc thứ tự vào
    assert mm.review_summary([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]) == s


def test_rate_zero_denominator_is_none():
    assert mm.rate(1, 3) == 33.3
    assert mm.rate(0, 0) is None
    assert mm.rate(0, 4) == 0.0


class _Count:
    def __init__(self):
        self.n = 0

    def execute(self, *a, **kw):
        self.n += 1
        raise AssertionError("không được execute")


def test_naive_datetime_rejected_before_execute():
    c = _Count()
    naive = datetime(2026, 10, 4, 12, 0)  # noqa: DTZ001 — cố ý naive
    aware = datetime(2026, 10, 4, tzinfo=VN)
    for a, b in ((naive, aware), (aware, naive), (date(2026, 10, 1), aware)):
        with pytest.raises(ValueError):
            mm.collect(c, a, b)
        with pytest.raises(ValueError):
            mm.draft_decisions(c, a, b)
    assert c.n == 0


def test_closed_week_matches_cockpit():
    for until in (datetime(2026, 10, 5, tzinfo=VN),
                  datetime(2026, 10, 8, 15, 30, tzinfo=VN),
                  datetime(2026, 10, 4, 16, 59, tzinfo=timezone.utc)):
        start, label = mm.closed_week(until)
        ref = ck.last_closed_ref("week", now=until)
        assert start == period_bounds("week", ref)[0]
        y, w, _ = start.date().isocalendar()
        assert label == f"{y}-W{w:02d}"
    assert mm.closed_week(datetime(2026, 10, 5, tzinfo=VN))[1] == "2026-W40"


# ------------------------------------------------------------ DB thật

@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w65_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại tx của fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _u(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _draft(db, channel, ctype, status, created, reviewed=None,
           by="agent:mkt02", snap=OK_SNAP):
    db.execute(
        "insert into content_drafts (created_at, brief, channel, text,"
        " guardrail, status, reviewer, reviewed_at, source, created_by,"
        " content_type) values (%s, 'b', %s, 't', %s, %s, %s, %s, 'cli',"
        " %s, %s)",
        (_u(created), channel, json.dumps(snap), status,
         "Người Test" if reviewed else None,
         _u(reviewed) if reviewed else None, by, ctype))


def _queue(db, block, otype, status, created, decided=None,
           by="agent:mkt01", snap=OK_SNAP):
    db.execute("set local session_replication_role = replica")
    db.execute(
        "insert into approval_queue (object_type, object_id, block, title,"
        " payload, content_sha256, risk, guardrail, created_by, created_at,"
        " due_at, status, decided_by, decided_at, lane) values (%s, %s, %s,"
        " 't', 'p', %s, 'medium', %s, %s, %s, %s, %s, %s, %s, %s)",
        (otype, uuid.uuid4().hex, block, "0" * 64, json.dumps(snap), by,
         _u(created), _u(created) + timedelta(hours=48), status,
         "Người Test" if status in ("approved", "rejected") else None,
         _u(decided) if decided else None,
         "per_item" if status in ("approved", "rejected") else None))
    db.execute("set local session_replication_role = origin")


def _snap(db, channel, metric, start, value, ref):
    db.execute(
        "insert into channel_snapshots (channel, metric_id, period_kind,"
        " period_start, value, source, source_ref, captured_by) values"
        " (%s, %s, 'week', %s, %s, %s, %s, 'Người Xuất Test')",
        (channel, metric, start, value,
         "api" if channel == "noi_bo" else "manual_export", ref))


def _fixture(db):
    """Kỳ rolling_bounds(7, 04/10) = 28/09 00:00 VN → 05/10 00:00 VN."""
    # 3 nháp facebook: 2 approved (2h, 4h) + 1 rejected ở biên 23:59:59 VN
    _draft(db, "facebook", "post", "approved", "2026-10-01T01:00:00Z",
           "2026-10-01T03:00:00Z")
    _draft(db, "facebook", "post", "approved", "2026-10-02T01:00:00Z",
           "2026-10-02T05:00:00Z")
    _draft(db, "facebook", "post", "rejected", "2026-10-03T01:00:00Z",
           "2026-10-04T16:59:59Z",
           snap={"ok": False, "violations": [{"type": "banned_word"}]})
    # 1 listing shopee rejected (10h)
    _draft(db, "shopee", "listing", "rejected", "2026-10-01T00:00:00Z",
           "2026-10-01T10:00:00Z", by="agent:MKT-11",
           snap={"ok": False, "violations": [
               {"code": "tu_cam", "type": "banned_word"}, {"x": 1}]})
    # pending trong kỳ → không vào mẫu số
    _draft(db, "facebook", "post", "pending", "2026-10-02T02:00:00Z",
           by="", snap="hong")
    # quyết định 00:00 05/10 VN → NGOÀI kỳ (vẫn chờ ở cuối kỳ)
    _draft(db, "facebook", "post", "approved", "2026-10-04T10:00:00Z",
           "2026-10-04T17:00:00Z")
    # mốc âm (duyệt trước lúc tạo) → bad_ts
    _draft(db, "zalo", "post", "approved", "2026-10-03T10:00:00Z",
           "2026-10-03T05:00:00Z")
    # tạo trước kỳ, duyệt trước kỳ → không tính
    _draft(db, "facebook", "post", "rejected", "2026-09-20T01:00:00Z",
           "2026-09-21T01:00:00Z")
    # hàng chờ khối marketing
    _queue(db, "marketing", "listing_copy", "approved",
           "2026-10-01T01:00:00Z", "2026-10-01T07:00:00Z")
    _queue(db, "marketing", "koc_brief", "rejected", "2026-10-02T00:00:00Z",
           "2026-10-02T12:00:00Z", by="agent:MKT-03")
    _queue(db, "marketing", "koc_brief", "expired", "2026-09-29T00:00:00Z",
           "2026-10-03T00:00:00Z")
    _queue(db, "marketing", "campaign_brief", "pending",
           "2026-10-01T05:00:00Z")
    _queue(db, "ceo", "weekly_report", "rejected", "2026-10-01T01:00:00Z",
           "2026-10-01T02:00:00Z", by="agent:ceo")
    # kênh: tuần đã đóng 28/09 (W40) + tuần đang mở 05/10 (không lấy)
    w40, w41 = date(2026, 9, 28), date(2026, 10, 5)
    _snap(db, "facebook", "social.reach", w40, 1000, "sample:kenh_MAU.csv")
    _snap(db, "facebook", "social.engagement", w40, 50,
          "sample:kenh_MAU.csv")
    _snap(db, "tiktok_shop", "sales.orders_completed", w40, 7,
          "file:tiktok.csv")
    _snap(db, "youtube", "social.reach", w40, 0, "file:yt.csv")
    _snap(db, "youtube", "social.engagement", w40, 3, "file:yt.csv")
    _snap(db, "facebook", "social.reach", w41, 999, "file:fb.csv")
    _snap(db, "noi_bo", "content.drafts_created", w40, 5, "db:x")


def test_collect_fixture_rates_hours_boundary(db):
    _fixture(db)
    since, until = rolling_bounds(7, date(2026, 10, 4))
    m = mm.collect(_TxConn(db), since, until)
    fb = m["drafts"][("facebook", "post")]
    assert (fb["decided"], fb["approved"], fb["rejected"]) == (3, 2, 1)
    assert fb["rate"] == 33.3
    # pending trong kỳ + nháp quyết định SAU kỳ = còn chờ cuối kỳ
    assert fb["pending_end"] == 2
    sh = m["drafts"][("shopee", "listing")]
    assert (sh["decided"], sh["rejected"], sh["rate"]) == (1, 1, 100.0)
    t = m["drafts_total"]
    assert (t["decided"], t["approved"], t["rejected"]) == (5, 3, 2)
    assert t["rate"] == 40.0
    # giờ: 2, 4, 39.9997, 10 (zalo âm → bad_ts, không vào median)
    assert m["drafts_hours"] == {"n": 4, "median_h": 7.0, "p90_h": 40.0,
                                 "max_h": 40.0, "bad_ts": 1}
    # hàng chờ: expired không vào rate; khối ceo không lọt
    assert set(m["queue"]) == {"listing_copy", "koc_brief", "campaign_brief"}
    qt = m["queue_total"]
    assert (qt["decided"], qt["rejected"], qt["rate"]) == (2, 1, 50.0)
    assert qt["pending_end"] == 1
    assert m["queue"]["koc_brief"]["rate"] == 100.0
    assert m["queue_expired"] == 1
    assert m["queue_hours"] == {"n": 2, "median_h": 9.0, "p90_h": 12.0,
                                "max_h": 12.0, "bad_ts": 0}
    # nháp tạo trong kỳ theo agent (content_drafts + hàng chờ marketing)
    assert m["by_agent"] == {"agent:mkt02": 5, "agent:MKT-11": 1,
                             "(không rõ)": 1, "agent:mkt01": 3,
                             "agent:MKT-03": 1}
    # snapshot cũ chỉ có type → đếm theo type; thiếu cả 2 → '?'
    assert m["guardrail_codes"] == {"banned_word": 1, "tu_cam": 1, "?": 1,
                                    "snapshot_hong": 1}
    ch = m["channels"]
    assert ch["week"] == "2026-W40"
    rows = {r["channel"]: r for r in ch["rows"]}
    assert set(rows) == {"facebook", "tiktok_shop", "youtube"}
    assert rows["facebook"] == {"channel": "facebook", "reach": 1000,
                                "engagement": 50, "orders": None,
                                "eng_rate": 5.0, "sample": True}
    assert rows["tiktok_shop"]["orders"] == 7
    assert rows["tiktok_shop"]["sample"] is False
    assert rows["youtube"]["eng_rate"] is None        # reach 0 → None


def test_boundary_vn_midnight(db):
    _draft(db, "facebook", "post", "rejected", "2026-10-04T10:00:00Z",
           "2026-10-04T16:59:59Z")                     # 23:59:59 04/10 VN
    _draft(db, "facebook", "post", "rejected", "2026-10-04T10:00:00Z",
           "2026-10-04T17:00:00Z")                     # 00:00 05/10 VN
    _draft(db, "facebook", "post", "approved", "2026-09-27T10:00:00Z",
           "2026-09-27T16:59:59Z")                     # 23:59:59 27/09 VN
    _draft(db, "facebook", "post", "approved", "2026-09-27T10:00:00Z",
           "2026-09-27T17:00:00Z")                     # 00:00 28/09 VN
    since, until = rolling_bounds(7, date(2026, 10, 4))
    d = mm.draft_decisions(_TxConn(db), since, until)
    assert d["total"]["decided"] == 2
    assert (d["total"]["approved"], d["total"]["rejected"]) == (1, 1)


def test_missing_table_raises_psycopg_error(db):
    db.execute("drop table channel_snapshots")
    since, until = rolling_bounds(7, date(2026, 10, 4))
    with pytest.raises(psycopg.Error):
        mm.collect(_TxConn(db), since, until)


def test_report_generate_end_to_end(db, tmp_path):
    _fixture(db)
    path, r = rep.generate(until=date(2026, 10, 4), out_dir=tmp_path,
                           data_dir=tmp_path, conn=_TxConn(db))
    assert r["marketing"]["ok"] is True
    body = path.read_text(encoding="utf-8")
    sec = body.split("## 5. Marketing")[1].split("## 6.")[0]
    assert "| facebook · post | 1/3 | 33.3% | 2 |" in sec
    assert "| shopee · listing | 1/1 | 100.0% | 0 |" in sec
    assert "| **Tổng** | 2/5 | 40.0% |" in sec
    assert ("Nháp nội dung: trung vị 7.0 giờ · p90 40.0 giờ · lâu nhất "
            "40.0 giờ (n=4) — loại 1 mục") in sec
    assert "Hàng chờ khối marketing: trung vị 9.0 giờ · p90 12.0 giờ" in sec
    assert "tuần 2026-W40" in sec and "facebook (MẪU)" in sec
    assert "| tiktok_shop | [chưa có dữ liệu] | [chưa có dữ liệu] | 7 |" \
        in sec
    assert "Hết hạn không ai duyệt (không tính trả lại): 1" in sec
    assert "`content_drafts`" in body.split("## 6.")[1]
    # mục 1 vẫn có số (DB thật, bảng orders rỗng)
    assert "| Đơn hàng | 0 | 0 |" in body


def test_cockpit_collect_internal_marketing(db, tmp_path):
    # W41 (05/10–11/10): 2 approved + 1 rejected
    for created, reviewed, st in (
            ("2026-10-05T01:00:00Z", "2026-10-05T03:00:00Z", "approved"),
            ("2026-10-06T01:00:00Z", "2026-10-06T07:00:00Z", "approved"),
            ("2026-10-06T01:00:00Z", "2026-10-07T01:00:00Z", "rejected")):
        _draft(db, "facebook", "post", st, created, reviewed)
    now = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
    rows, errors = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=now)
    v = {r["metric_id"]: r for r in rows}
    assert not [e for e in errors if e.startswith("content.")]
    assert v["content.drafts_rejected"]["value"] == 1
    assert str(v["content.review_hours_median"]["value"]) == "6.0"
    assert str(v["content.review_hours_p90"]["value"]) == "24.0"
    assert v["content.drafts_rejected"]["source_ref"] == "db:content_drafts"
    # tuần không có quyết định → không ghi giờ (thiếu ≠ 0)
    rows, _ = ck.collect_internal(_TxConn(db), "week", date(2026, 9, 21),
                                  data_dir=tmp_path, now=now)
    ids = {r["metric_id"]: r["value"] for r in rows}
    assert "content.review_hours_median" not in ids
    assert "content.review_hours_p90" not in ids
    assert ids["content.drafts_rejected"] == 0
    # lỗi DB → errors từng metric, không chết
    db.execute("drop table content_drafts cascade")
    rows, errors = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=now)
    assert {e.split(":")[0] for e in errors} >= set(ck.MKT_METRICS)
    assert "leads.new" in {r["metric_id"] for r in rows}
