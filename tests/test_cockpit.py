"""v8.0 W80.1–W80.4 — `pipelines.cockpit`: từ điển chỉ số, collector nội bộ
kỳ ĐÃ ĐÓNG theo giờ VN, ghi insert-only `channel_snapshots`, nạp CSV
`manual_export` (kiểm toàn file trước connect, idempotent), thời gian duyệt
của TGĐ.

Test DB: 1 transaction trên `DATABASE_URL`, schema tạm + docs/schema.sql +
docs/roles.sql → ROLLBACK cuối test (precedent test_director_framework).
Mốc thời gian quá khứ của approval_queue đặt bằng superuser
`session_replication_role = replica` (bỏ trigger) rồi trả `origin`. Code gọi
`conn.commit()` → bọc `_TxConn` (commit chỉ ghi nhận). Skip khi không có DB
— gate yêu cầu 0 skipped. Số trong fixture CSV là số MẪU bịa.
"""

import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

from pipelines import cockpit as ck
from pipelines.period import period_bounds

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
FIX = ROOT / "tests" / "fixtures" / "cockpit"
VN = timezone(timedelta(hours=7))
UTC = timezone.utc
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
HEADER = "channel,metric_id,period_kind,period_start,value\n"
REQUIRED = {
    "leads.new", "chatbot.questions", "chatbot.unanswered",
    "content.drafts_created", "content.drafts_approved",
    "content.drafts_pending_end", "market.alerts_open_end", "ai.cost_usd",
    "jobs.failed", "approvals.overdue", "approvals.ceo_decided",
    "approvals.ceo_hours_median", "approvals.ceo_hours_max",
    "approvals.ceo_expired", "sales.gmv_vnd", "sales.orders_completed",
    "sales.orders_cancelled", "sales.settlement_vnd", "social.followers",
    "social.reach"}
EXT_CHANNELS = {"shopee", "tiktok_shop", "facebook", "youtube", "zalo_oa",
                "website"}


# ------------------------------------------------------------ W80.1

def test_metrics_file_loads():
    m = ck.load_metrics()
    assert REQUIRED <= set(m)
    for mid, s in m.items():
        assert ck.METRIC_RE.fullmatch(mid), mid
        assert s["unit"] in ck.UNITS
        if s["kind"] == "external":
            assert set(s["channels"]) <= EXT_CHANNELS, mid
            assert s["source"] == "manual_export"
        else:
            assert s["channels"] == ["noi_bo"]
    assert [k for k, s in m.items() if s.get("per_agent")] == ["ai.cost_usd"]
    assert "không phải doanh thu thực nhận" in m["sales.gmv_vnd"]["name"]
    assert m["sales.orders_cancelled"]["better"] == "down"


def _metrics_cfg():
    return json.loads((ROOT / "data" / "metrics.json").read_bytes()
                      .decode("utf-8"))


def _bad_metric(cfg, mid, **kw):
    cfg["metrics"][mid].update(kw)
    return cfg


@pytest.mark.parametrize("make", [
    lambda c: {"metrics": {"Leads.New": c["metrics"]["leads.new"]}},
    lambda c: _bad_metric(c, "leads.new", better="cao"),
    lambda c: _bad_metric(c, "leads.new", kind="x"),
    lambda c: _bad_metric(c, "sales.gmv_vnd", channels=None),
    lambda c: _bad_metric(c, "leads.new", channels=["shopee"]),
    lambda c: _bad_metric(c, "leads.new", unit=""),
    lambda c: {},
    lambda c: "{hỏng",
], ids=["id-hoa", "better-cao", "kind-x", "ext-thieu-channels",
        "int-channels-shopee", "unit-rong", "rong", "json-hong"])
def test_load_metrics_rejects(tmp_path, make):
    data = make(_metrics_cfg())
    p = tmp_path / "metrics.json"
    p.write_bytes((data if isinstance(data, str)
                   else json.dumps(data, ensure_ascii=False)).encode("utf-8"))
    with pytest.raises(ck.MetricsError):
        ck.load_metrics(p)


def test_metric_spec_per_agent():
    m = ck.load_metrics()
    assert ck.metric_spec(m, "ai.cost_usd.chatbot") is m["ai.cost_usd"]
    assert ck.metric_spec(m, "ai.cost_usdx") is None
    assert ck.metric_spec(m, "leads.new.x") is None      # không per_agent
    assert ck.metric_spec(m, "Leads.new") is None
    assert ck.agent_metric_id("Persona-Sim") == "ai.cost_usd.persona_sim"
    assert ck.METRIC_RE.fullmatch(ck.agent_metric_id("a" * 64))


def test_cli_metrics(capsys):
    assert ck.main(["--metrics"]) == 0
    out = capsys.readouterr().out
    assert "internal" in out and "external" in out


# ------------------------------------------------------------ W80.2 thuần

class _FakeConn:
    def __init__(self):
        self.n = 0

    def execute(self, *a, **kw):
        self.n += 1
        raise AssertionError("không được execute")

    def transaction(self):
        raise AssertionError("không được mở transaction")

    def commit(self):
        pass


def test_collect_unclosed_period_rejected():
    fc = _FakeConn()
    with pytest.raises(ValueError, match="kỳ chưa đóng"):
        ck.collect_internal(fc, "week", date(2026, 10, 12), now=NOW)
    assert fc.n == 0


def test_default_last_closed_period():
    wref = ck.last_closed_ref("week", NOW)
    ws, we = period_bounds("week", wref)
    assert ws.date() == date(2026, 10, 5) and we <= NOW
    assert f"{ws.date().isocalendar().year}-W" \
           f"{ws.date().isocalendar().week:02d}" == "2026-W41"
    ms, _ = period_bounds("month", ck.last_closed_ref("month", NOW))
    assert ms.date() == date(2026, 9, 1)


def _row(**kw):
    r = {"channel": "noi_bo", "metric_id": "leads.new", "period_kind": "week",
         "period_start": date(2026, 10, 5), "value": Decimal(3),
         "source": "api", "source_ref": "db:leads"}
    r.update(kw)
    return r


@pytest.mark.parametrize("bad", [
    {"metric_id": "leads.newx"},
    {"channel": "shopee"},
    {"period_kind": "year"},
    {"value": Decimal(-1)},
    {"value": Decimal("NaN")},
    {"source": "internal"},
], ids=["metric-la", "kenh-ngoai", "kind-la", "am", "nan", "source-la"])
def test_store_rejects_before_execute(bad):
    fc = _FakeConn()
    with pytest.raises(ValueError):
        ck.store(fc, [_row(), _row(**bad)], "agent:cockpit")
    assert fc.n == 0


def test_summarize_hours():
    assert ck.summarize_hours([]) == {"n": 0, "median_h": None,
                                      "max_h": None}
    assert ck.summarize_hours([2, 30]) == {"n": 2, "median_h": 16.0,
                                           "max_h": 30.0}


# ------------------------------------------------------------ W80.3 thuần

def _csv(tmp_path, body: str, name="f.csv", raw: bytes | None = None):
    p = tmp_path / name
    p.write_bytes(raw if raw is not None else body.encode("utf-8"))
    return p


# (thân CSV, chuỗi giá trị ô KHÔNG được xuất hiện trong lỗi)
CSV_BAD = {
    "header-sai": (("kenh,metric_id,period_kind,period_start,value\n"
                    "shopee,sales.gmv_vnd,week,2026-10-05,100\n"), "kenh"),
    "thieu-cot": (("channel,metric_id,period_kind,period_start\n"
                   "shopee,sales.gmv_vnd,week,2026-10-05\n"), None),
    "khong-dong": (HEADER, None),
    "metric-noi-bo": (HEADER + "noi_bo,leads.new,week,2026-10-05,5\n",
                      "leads.new"),
    "metric-la": (HEADER + "shopee,sales.bogus_x,week,2026-10-05,5\n",
                  "sales.bogus_x"),
    "kenh-khong-cho-phep": (HEADER + "lazada,sales.gmv_vnd,week,"
                            "2026-10-05,5\n", "lazada"),
    "tuan-thu-ba": (HEADER + "shopee,sales.orders_completed,week,"
                    "2026-09-29,40\n", "2026-09-29"),
    "thang-ngay-2": (HEADER + "shopee,sales.gmv_vnd,month,2026-09-02,7\n",
                     "2026-09-02"),
    "ky-chua-dong": (HEADER + "shopee,sales.gmv_vnd,week,2026-10-12,7\n",
                     "2026-10-12"),
    "dau-nghin": (HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,"
                  "\"21.585.320\"\n", "21.585.320"),
    "thap-phan-phay": (HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,"
                       "\"21,5\"\n", "21,5"),
    "am": (HEADER + "shopee,sales.orders_completed,week,2026-10-05,-5\n",
           "-5"),
    "nan": (HEADER + "shopee,sales.orders_completed,week,2026-10-05,nan\n",
            "nan"),
    "rong": (HEADER + "shopee,sales.orders_completed,week,2026-10-05,\n",
             None),
    "trung-khoa": (HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,100\n"
                   "shopee,sales.gmv_vnd,week,2026-10-05,100\n", None),
    "ky-la": (HEADER + "shopee,sales.gmv_vnd,quarter,2026-10-05,1\n",
              "quarter"),
    "so-cot-sai": (HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,1,9\n",
                   None),
    # chữ số full-width: Decimal() nhận nhưng CSV phải từ chối (A03)
    "so-fullwidth": (HEADER + "shopee,sales.orders_completed,week,"
                     "2026-10-05,１２\n", "１２"),
}


@pytest.mark.parametrize("case", sorted(CSV_BAD))
def test_read_csv_rejects_without_echoing_cells(tmp_path, case):
    body, needle = CSV_BAD[case]
    rows, errors = ck.read_csv(_csv(tmp_path, body), ck.load_metrics(),
                               now=NOW)
    assert rows == [] and errors, case
    assert all(e.startswith("dòng ") for e in errors), errors
    if needle:
        assert not any(needle in e for e in errors), errors


def test_read_csv_non_utf8_byte(tmp_path):
    raw = (HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,1\n"
           ).encode("utf-8") + b"facebook,social.reach,week,2026-10-05,\xff\n"
    rows, errors = ck.read_csv(_csv(tmp_path, "", raw=raw), ck.load_metrics(),
                               now=NOW)
    assert rows == []
    assert errors == ["dòng 3, cột (file): byte không phải UTF-8"]


def test_read_csv_too_big(tmp_path, monkeypatch):
    monkeypatch.setattr(ck, "CSV_MAX_BYTES", 10)
    rows, errors = ck.read_csv(_csv(tmp_path, HEADER), ck.load_metrics(),
                               now=NOW)
    assert rows == [] and "byte" in errors[0]


def test_read_csv_bom_and_sample_ok(tmp_path):
    body = HEADER + "shopee,sales.gmv_vnd,week,2026-10-05,100\n"
    rows, errors = ck.read_csv(
        _csv(tmp_path, "", raw=b"\xef\xbb\xbf" + body.encode("utf-8")),
        ck.load_metrics(), now=NOW)
    assert errors == [] and rows[0]["value"] == Decimal(100)
    rows, errors = ck.read_csv(FIX / "kenh_MAU.csv", ck.load_metrics(),
                               now=NOW)
    assert errors == [] and len(rows) >= 10
    rows, errors = ck.read_csv(FIX / "kenh_loi.csv", ck.load_metrics(),
                               now=NOW)
    assert rows == [] and len(errors) >= 4


def test_source_ref_sample_prefix():
    ref = ck.csv_source_ref(FIX / "kenh_MAU.csv", True)
    assert ref.startswith("sample:kenh_MAU.csv#sha256:")
    assert len(ref.split("#sha256:")[1]) == 12
    assert not ck.csv_source_ref(FIX / "kenh_MAU.csv", False).startswith(
        "sample:")


def _no_connect():
    raise AssertionError("connect không được gọi")


def test_cli_import_bad_file_no_connect(monkeypatch, capsys):
    monkeypatch.setattr(ck, "connect", _no_connect)
    rc = ck.main(["--import", str(FIX / "kenh_loi.csv"), "--by", "X"],
                 now=NOW)
    assert rc == 1
    err = capsys.readouterr().err
    assert "0 dòng" in err and "21.585.320" not in err and "lazada" not in err


@pytest.mark.parametrize("argv", [
    ["--import", "x.csv"],
    ["--import", "x.csv", "--by", "  "],
    ["--import", "x.csv", "--by", "X", "--collect"],
    ["--metrics", "--collect"],
    [],
    ["--collect", "--by", "X"],
    ["--metrics", "--dry-run"],
    ["--collect", "--ref", "12/10/2026"],
], ids=["thieu-by", "by-trang", "import+collect", "metrics+collect",
        "khong-op", "collect+by", "metrics+dryrun", "ref-sai"])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(ck, "connect", _no_connect)
    with pytest.raises(SystemExit) as e:
        ck.main(argv, now=NOW)
    assert e.value.code == 2


def test_cli_collect_unclosed_exit2_before_connect(monkeypatch):
    monkeypatch.setattr(ck, "connect", _no_connect)
    assert ck.main(["--collect", "--period", "week", "--ref", "2026-10-12"],
                   now=NOW) == 2
    assert ck.main(["--collect", "--period", "month", "--ref", "2026-10-01"],
                   now=NOW) == 2


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(ck, "connect", lambda: None)
    assert ck.main(["--collect", "--ref", "2026-10-05"], now=NOW) == 2
    assert ck.main(["--import", str(FIX / "kenh_MAU.csv"), "--by", "X",
                    "--sample"], now=NOW) == 2


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
        # 60s (không 10s): roles.sql đụng role toàn cluster — nhiều worktree
        # chạy test DB song song từng làm LockNotAvailable ở mốc 10s.
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w80_{uuid.uuid4().hex[:12]}"
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


def _lead(db, ts: str):
    db.execute("insert into leads (dedup_key, ts, channel, user_hash, intent,"
               " source) values (%s, %s, 'zalo', 'h', 'price', 'test')",
               (f"t:{uuid.uuid4().hex}", _u(ts)))


def _queue(db, block, status, created: str, decided: str | None,
           due: str | None = None):
    """Hàng duyệt với mốc quá khứ (replica bỏ trigger) — tên giả lập."""
    db.execute("set local session_replication_role = replica")
    db.execute(
        "insert into approval_queue (object_type, object_id, block, title,"
        " payload, content_sha256, risk, guardrail, created_by, created_at,"
        " due_at, status, decided_by, decided_at, lane) values ('weekly_report',"
        " %s, %s, 't', 'p', %s, 'medium', '{}', 'agent:test', %s, %s, %s, %s,"
        " %s, %s)",
        (uuid.uuid4().hex, block, "0" * 64, _u(created),
         _u(due) if due else _u(created) + timedelta(hours=48), status,
         None if decided is None or status == "expired" else "Người Test",
         _u(decided) if decided else None,
         "per_item" if status in ("approved", "rejected") else None))
    db.execute("set local session_replication_role = origin")


def _vals(rows) -> dict:
    return {r["metric_id"]: r["value"] for r in rows}


def test_week_spanning_two_months_vn(db, tmp_path):
    # Kỳ tuần chứa 01/10 = 28/09..05/10 giờ VN.
    s, e = period_bounds("week", date(2026, 10, 1))
    assert (s.date(), e.date()) == (date(2026, 9, 28), date(2026, 10, 5))
    for ts in ("2026-09-27T16:59:59Z",     # 23:59:59 27/09 VN — KHÔNG
               "2026-09-27T17:00:00Z",     # 00:00 28/09 VN — tính
               "2026-10-04T16:59:59Z",     # 23:59:59 04/10 VN — tính
               "2026-10-04T17:00:00Z"):    # 00:00 05/10 VN — KHÔNG
        _lead(db, ts)
    conv = tmp_path / "conversations.jsonl"
    recs = [{"ts": "2026-09-28T01:00:00Z", "answered": True},
            {"ts": "2026-09-29T01:00:00Z", "answered": False},
            {"ts": "2026-09-30T01:00:00Z", "answered": None},
            {"ts": "2026-09-30T02:00:00Z"},
            {"ts": "2026-09-27T16:00:00Z", "answered": False}]  # ngoài kỳ
    conv.write_bytes("\n".join(json.dumps(r) for r in recs).encode("utf-8")
                     + b"\n")
    rows, errors = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 1),
                                       data_dir=tmp_path, now=NOW)
    v = _vals(rows)
    assert errors == []
    assert v["leads.new"] == 2
    assert v["chatbot.questions"] == 4 and v["chatbot.unanswered"] == 3
    assert all(r["period_start"] == date(2026, 9, 28) for r in rows)
    assert all(r["channel"] == "noi_bo" and r["source"] == "api"
               for r in rows)
    srcs = {r["metric_id"]: r["source_ref"] for r in rows}
    assert srcs["leads.new"] == "db:leads"
    assert srcs["chatbot.questions"] == "file:conversations.jsonl"
    # Tháng: lead 2026-09-30T17:00Z (= 00:00 01/10 VN) thuộc tháng 10.
    _lead(db, "2026-09-30T17:00:00Z")
    m9, _ = ck.collect_internal(_TxConn(db), "month", date(2026, 9, 15),
                                data_dir=tmp_path, now=NOW)
    assert _vals(m9)["leads.new"] == 2    # 27/09 16:59:59Z + 27/09 17:00Z
    m10, _ = ck.collect_internal(
        _TxConn(db), "month", date(2026, 10, 1), data_dir=tmp_path,
        now=datetime(2026, 11, 2, tzinfo=VN))
    assert _vals(m10)["leads.new"] == 3   # 30/09 17Z, 04/10 16:59Z, 04/10 17Z


def test_collect_internal_metrics_fixture(db, tmp_path):
    s = "2026-10-05T01:00:00Z"            # trong W41
    before = "2026-10-01T01:00:00Z"
    after = "2026-10-12T01:00:00Z"        # sau end W41
    for ts in (before, s, s):
        db.execute("insert into content_drafts (created_at, brief, channel,"
                   " text, guardrail, source) values (%s, 'b', 'facebook',"
                   " 't', '{}', 'cli')", (_u(ts),))
    ids = [r[0] for r in db.execute(
        "select id from content_drafts order by id").fetchall()]
    # draft 1 duyệt trước end; draft 2 duyệt SAU end → vẫn chờ cuối kỳ.
    for oid, ts, dec in ((ids[0], s, "approved"), (ids[1], after, "approved")):
        db.execute("insert into approvals (object_type, object_id,"
                   " content_sha256, decision, approved_by, approved_at)"
                   " values ('content_draft', %s, %s, %s, 'Người Test', %s)",
                   (str(oid), "0" * 64, dec, _u(ts)))
    for opened, closed in ((before, None), (before, "2026-10-08T01:00:00Z"),
                           (before, after), (after, None)):
        db.execute("insert into market_alerts (kind, severity, channel,"
                   " export_kind, item_id, detail, opened_at, closed_at,"
                   " status) values ('price_mismatch', 'S2', 'shopee', 'x',"
                   " %s, '{}', %s, %s, %s)",
                   (uuid.uuid4().hex, _u(opened),
                    _u(closed) if closed else None,
                    "closed" if closed else "open"))
    for agent, cost, ts in (("chatbot", "0.25", s), ("chatbot", "0.5", s),
                            ("Persona-Sim", "1.125", s),
                            ("chatbot", "9", after)):
        db.execute("insert into llm_usage (ts, agent_id, model, cost_usd, ok)"
                   " values (%s, %s, 'm', %s, true)", (_u(ts), agent, cost))
    for ok, ts in ((False, s), (None, s), (True, s), (False, before)):
        db.execute("insert into job_runs (job, started_at, ok) values"
                   " ('j', %s, %s)", (_u(ts), ok))
    _queue(db, "sales", "pending", "2026-10-01T01:00:00Z", None,
           due="2026-10-06T01:00:00Z")                  # quá hạn trong kỳ
    _queue(db, "marketing", "expired", "2026-10-01T01:00:00Z",
           "2026-10-07T01:00:00Z", due="2026-10-07T01:00:00Z")
    _queue(db, "sales", "approved", "2026-10-01T01:00:00Z",
           "2026-10-02T01:00:00Z", due="2026-10-06T01:00:00Z")  # đã duyệt
    _queue(db, "sales", "pending", "2026-10-01T01:00:00Z", None,
           due="2026-10-13T01:00:00Z")                  # hạn ngoài kỳ
    (tmp_path / "conversations.jsonl").write_bytes(b"")
    rows, errors = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=NOW)
    v = _vals(rows)
    assert errors == []
    assert v["content.drafts_created"] == 2
    assert v["content.drafts_approved"] == 1
    assert v["content.drafts_pending_end"] == 2    # draft 2 + draft 3
    assert v["market.alerts_open_end"] == 2        # mở + đóng sau end
    assert v["ai.cost_usd"] == Decimal("1.875")
    assert v["ai.cost_usd.chatbot"] == Decimal("0.75")
    assert v["ai.cost_usd.persona_sim"] == Decimal("1.125")
    assert v["jobs.failed"] == 2
    assert v["approvals.overdue"] == 2
    assert v["chatbot.questions"] == 0             # file có, 0 câu — số thật


def test_missing_table_goes_to_errors_not_zero(db, tmp_path):
    db.execute("drop table job_runs")
    rows, errors = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=NOW)
    ids = {r["metric_id"] for r in rows}
    assert "jobs.failed" not in ids
    assert any(e.startswith("jobs.failed:") for e in errors)
    # Không có file convlog → lỗi nguồn, không phải 0.
    assert "chatbot.questions" not in ids
    assert any(e.startswith("chatbot.questions:") for e in errors)
    assert "leads.new" in ids                      # savepoint giữ metric khác


def test_store_idempotent_and_conflict_keeps_old(db, tmp_path):
    _lead(db, "2026-10-06T01:00:00Z")
    tc = _TxConn(db)
    rows, _ = ck.collect_internal(tc, "week", date(2026, 10, 5),
                                  data_dir=tmp_path, now=NOW)
    n = len(rows)
    st = ck.store(tc, rows, "agent:cockpit")
    assert st == {"inserted": n, "unchanged": 0, "conflict": 0,
                  "unverified": 0, "rolled_back": False}
    count = db.execute("select count(*) from channel_snapshots").fetchone()[0]
    assert count == n
    st = ck.store(tc, rows, "agent:cockpit")
    assert (st["inserted"], st["unchanged"], st["conflict"]) == (0, n, 0)
    changed = [dict(r) for r in rows]
    lead = next(r for r in changed if r["metric_id"] == "leads.new")
    lead["value"] = Decimal(99)
    st = ck.store(tc, changed, "agent:cockpit")
    assert (st["inserted"], st["unchanged"], st["conflict"]) == (0, n - 1, 1)
    assert db.execute("select count(*) from channel_snapshots"
                      ).fetchone()[0] == count
    assert db.execute("select value from channel_snapshots where metric_id ="
                      " 'leads.new'").fetchone()[0] == 1   # giữ bản cũ
    assert tc.committed >= 3


def test_approval_times_ceo_week41(db, tmp_path):
    _queue(db, "ceo", "approved", "2026-10-05T01:00:00Z",   # 08:00 VN 05/10
           "2026-10-05T03:00:00Z")                          # 2h
    _queue(db, "ceo", "rejected", "2026-10-06T02:00:00Z",   # 09:00 VN 06/10
           "2026-10-07T08:00:00Z")                          # 15:00 07/10 — 30h
    _queue(db, "ceo", "approved", "2026-10-09T13:00:00Z",   # 20:00 VN 09/10
           "2026-10-11T17:30:00Z")                          # 00:30 12/10 VN
    _queue(db, "ceo", "approved", "2026-10-03T01:00:00Z",
           "2026-10-04T16:59:00Z")                          # 23:59 04/10 VN
    _queue(db, "ceo", "expired", "2026-10-03T01:00:00Z",
           "2026-10-08T01:00:00Z")
    _queue(db, "marketing", "approved", "2026-10-05T01:00:00Z",
           "2026-10-06T01:00:00Z")
    s, e = period_bounds("week", date(2026, 10, 5))
    t = ck.approval_times(db, s, e, "ceo")
    assert t == {"n": 2, "median_h": 16.0, "max_h": 30.0, "expired": 1}
    rows, _ = ck.collect_internal(_TxConn(db), "week", date(2026, 10, 5),
                                  data_dir=tmp_path, now=NOW)
    v = _vals(rows)
    assert v["approvals.ceo_decided"] == 2
    assert v["approvals.ceo_hours_median"] == Decimal("16.0")
    assert v["approvals.ceo_hours_max"] == Decimal("30.0")
    assert v["approvals.ceo_expired"] == 1
    # Tuần W39 không có quyết định ceo → KHÔNG có row giờ (không ghi 0).
    rows, _ = ck.collect_internal(_TxConn(db), "week", date(2026, 9, 21),
                                  data_dir=tmp_path, now=NOW)
    ids = {r["metric_id"] for r in rows}
    assert "approvals.ceo_hours_median" not in ids
    assert "approvals.ceo_hours_max" not in ids
    assert _vals(rows)["approvals.ceo_decided"] == 0


def test_cli_import_sample_idempotent_and_conflict(db, tmp_path, monkeypatch,
                                                   capsys):
    tc = _TxConn(db)
    monkeypatch.setattr(ck, "connect", lambda: tc)
    n = len(ck.read_csv(FIX / "kenh_MAU.csv", ck.load_metrics(), now=NOW)[0])
    argv = ["--import", str(FIX / "kenh_MAU.csv"), "--by", "Người Xuất Test",
            "--sample"]
    assert ck.main(argv, now=NOW) == 0
    assert f"inserted={n}" in capsys.readouterr().out

    def snap():
        return db.execute("select channel, metric_id, period_kind,"
                          " period_start, value, source, source_ref,"
                          " captured_by from channel_snapshots order by id"
                          ).fetchall()

    first = snap()
    assert len(first) == n
    assert all(r[5] == "manual_export" and r[6].startswith("sample:")
               and r[7] == "Người Xuất Test" for r in first)
    assert ck.main(argv, now=NOW) == 0
    assert f"inserted=0 unchanged={n}" in capsys.readouterr().out
    assert snap() == first
    # File sửa 1 giá trị cùng khóa + thêm 1 dòng mới → hủy CẢ file.
    body = (FIX / "kenh_MAU.csv").read_bytes().decode("utf-8")
    body = body.replace("shopee,sales.orders_completed,week,2026-10-05,44",
                        "shopee,sales.orders_completed,week,2026-10-05,45")
    body += "youtube,social.followers,week,2026-10-05,10\n"
    p = _csv(tmp_path, body, name="kenh_MAU_sua.csv")
    rc = ck.main(["--import", str(p), "--by", "X", "--sample"], now=NOW)
    assert rc == 1
    assert "0 dòng" in capsys.readouterr().err
    assert snap() == first


# ------------------------------------------------------------ vá nghiệm thu v8.0


class _FailConn:
    """Mọi query DB lỗi → chỉ còn nhánh convlog (file) chạy thật."""

    def transaction(self):
        from contextlib import nullcontext
        return nullcontext()

    def execute(self, *a, **kw):
        raise psycopg.OperationalError("db down (fake)")


def _conv(tmp_path):
    (tmp_path / "conversations.jsonl").write_bytes(
        b'{"ts": "2026-10-06T01:00:00Z", "answered": true}\n')


@pytest.mark.parametrize("kind,ref", [
    ("month", date(2026, 9, 1)),          # tháng 9 chụp ngày 12/10 — mất 1..11/9
    ("week", date(2026, 9, 7)),           # tuần 07/09 — đầu kỳ cách now > 30 ngày
], ids=["thang-9", "tuan-cu"])
def test_chatbot_beyond_convlog_retention_is_error_not_number(tmp_path, kind,
                                                              ref):
    _conv(tmp_path)
    rows, errors = ck.collect_internal(_FailConn(), kind, ref,
                                       data_dir=tmp_path, now=NOW)
    ids = {r["metric_id"] for r in rows}
    assert not ids & {"chatbot.questions", "chatbot.unanswered"}
    for m in ("chatbot.questions", "chatbot.unanswered"):
        assert any(e.startswith(f"{m}:") and "hạn lưu" in e for e in errors)


def test_chatbot_within_retention_still_counted(tmp_path):
    _conv(tmp_path)
    rows, errors = ck.collect_internal(_FailConn(), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=NOW)
    v = _vals(rows)
    assert v["chatbot.questions"] == 1 and v["chatbot.unanswered"] == 0
    assert not any("hạn lưu" in e for e in errors)
    # Mốc biên: đầu kỳ đúng bằng now − 30 ngày vẫn trong hạn.
    edge = datetime(2026, 11, 4, 0, 0, tzinfo=VN)   # 05/10 + 30 ngày
    rows, errors = ck.collect_internal(_FailConn(), "week", date(2026, 10, 5),
                                       data_dir=tmp_path, now=edge)
    assert "chatbot.questions" in {r["metric_id"] for r in rows}
    rows, errors = ck.collect_internal(
        _FailConn(), "week", date(2026, 10, 5), data_dir=tmp_path,
        now=edge + timedelta(seconds=1))
    assert "chatbot.questions" not in {r["metric_id"] for r in rows}


@pytest.mark.parametrize("name,want", [
    ("kenh_MAU.csv", True), ("kenh_mẫu.csv", True), ("sample.csv", True),
    ("MAU-shopee.csv", True), ("kenh_sample_w41.csv", True),
    ("kenh_loi.csv", False), ("shopee_w41.csv", False),
    ("maudon.csv", False), ("samples2.csv", False), ("tamau.csv", False),
])
def test_is_sample_name(name, want):
    assert ck.is_sample_name(name) is want


def test_cli_import_sample_flag_must_match_filename(monkeypatch, capsys,
                                                    tmp_path):
    monkeypatch.setattr(ck, "connect", _no_connect)
    # File MẪU thiếu --sample → exit 2 (không nạp số mẫu như số thật).
    assert ck.main(["--import", str(FIX / "kenh_MAU.csv"), "--by", "X"],
                   now=NOW) == 2
    assert "--sample" in capsys.readouterr().err
    # File thật + --sample → exit 2 (không gắn MẪU lên số thật).
    real = tmp_path / "shopee_w41.csv"
    real.write_bytes((FIX / "kenh_MAU.csv").read_bytes())
    assert ck.main(["--import", str(real), "--by", "X", "--sample"],
                   now=NOW) == 2
    assert "--sample" in capsys.readouterr().err


AW = "agent_writer"


def test_store_and_import_under_agent_writer(db, tmp_path, monkeypatch,
                                             capsys):
    """Collector/nạp CSV chạy dưới role agent_writer thật (chỉ INSERT 8 cột,
    KHÔNG SELECT channel_snapshots) — không cần DSN có quyền duyệt."""
    metrics = ck.load_metrics()
    rows, _ = ck.read_csv(FIX / "kenh_MAU.csv", metrics, now=NOW)
    n = len(rows)
    tc = _TxConn(db)
    monkeypatch.setattr(ck, "connect", lambda: tc)
    db.execute(f"set local role {AW}")
    with pytest.raises(psycopg.errors.InsufficientPrivilege), \
            db.transaction():
        db.execute("select value from channel_snapshots")
    argv = ["--import", str(FIX / "kenh_MAU.csv"), "--by", "X", "--sample"]
    assert ck.main(argv, now=NOW) == 0
    assert f"inserted={n}" in capsys.readouterr().out
    # Nạp lại y nguyên: đã có hết, không so được giá trị → KHÔNG phân biệt
    # được với file đã sửa số → fail-closed exit 1, 0 dòng, không [done].
    assert ck.main(argv, now=NOW) == 1
    out, err = capsys.readouterr()
    assert "[done]" not in out and f"[fail] {n} dòng" in err
    assert "SELECT" in err and "0 dòng" in err
    # File SỬA 1 số cùng khóa (Seller Center xuất lại) dưới agent_writer:
    # exit 1, không [done], sổ GIỮ số cũ (trước fix: exit 0 [done] câm).
    body0 = (FIX / "kenh_MAU.csv").read_bytes().decode("utf-8")
    assert body0.count(",11111000") == 1
    p_fix = _csv(tmp_path, body0.replace(",11111000", ",99999000"),
                 name="kenh_MAU_sua.csv")
    assert ck.main(["--import", str(p_fix), "--by", "X", "--sample"],
                   now=NOW) == 1
    out, err = capsys.readouterr()
    assert "[done]" not in out and f"[fail] {n} dòng" in err
    assert "KHÔNG được nạp" in err
    db.execute("reset role")
    gmv = db.execute("select value from channel_snapshots where channel ="
                     " 'shopee' and metric_id = 'sales.gmv_vnd' and"
                     " period_start = '2026-09-28'").fetchall()
    assert [int(v) for (v,) in gmv] == [11111000]
    db.execute(f"set local role {AW}")
    # Dòng mới + dòng đã có (không kiểm được giá trị) → fail-closed cả file.
    body = body0 + "youtube,social.followers,week,2026-10-05,10\n"
    p = _csv(tmp_path, body, name="kenh_MAU_them.csv")
    assert ck.main(["--import", str(p), "--by", "X", "--sample"],
                   now=NOW) == 1
    assert "0 dòng" in capsys.readouterr().err
    # store nội bộ (collector) dưới agent_writer: insert OK, lần 2 unverified.
    internal = [ck._row("jobs.failed", "week", datetime(2026, 10, 5,
                                                        tzinfo=VN), 2,
                        "db:job_runs")]
    st = ck.store(tc, internal, ck.CAPTURED_BY, metrics=metrics)
    assert (st["inserted"], st["unverified"]) == (1, 0)
    st = ck.store(tc, internal, ck.CAPTURED_BY, metrics=metrics)
    assert (st["inserted"], st["unverified"], st["conflict"]) == (0, 1, 0)
    db.execute("reset role")
    got = db.execute("select count(*), count(*) filter (where metric_id ="
                     " 'social.followers' and channel = 'youtube')"
                     " from channel_snapshots").fetchone()
    assert got == (n + 1, 0)
