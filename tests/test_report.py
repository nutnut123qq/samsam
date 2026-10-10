"""v2.0-report-agent (W3.x) — `agents.report`: period math + collect
(fake-conn dispatch, convlog edge enumerate đủ) + render (đủ section,
nhãn *(mẫu)*, degraded "[chưa nạp]", footer human-gate) + write/
generate end-to-end vào tmp_path. Không cần DB thật."""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

from agents import report as rep

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UTC = timezone.utc
S = datetime(2026, 10, 4, tzinfo=UTC)      # since
U = datetime(2026, 10, 11, tzinfo=UTC)     # until_excl (kỳ tới 10/10)
PS = S - (U - S)                           # prev since = 2026-09-27


def _conv_rec(**kw):
    base = {"ts": "2026-10-08T01:02:03Z", "msg_id": "m1",
            "user_hash": "abc123", "question": "giá bao nhiêu",
            "answered": True}
    base.update(kw)
    return base


# ---------- period + fmt ----------

def test_period_bounds_date_until_is_end_inclusive():
    since, until = rep.period_bounds(7, date(2026, 10, 10))
    assert since == datetime(2026, 10, 4, tzinfo=UTC)
    # Ngày cuối kỳ inclusive → exclusive = hôm sau 00:00 UTC.
    assert until == datetime(2026, 10, 11, tzinfo=UTC)
    assert until.tzinfo is not None and since.tzinfo is not None


def test_period_bounds_default_and_datetime():
    since, until = rep.period_bounds(7)
    assert until.tzinfo is not None
    assert until - since == timedelta(days=7)
    assert abs((datetime.now(UTC) - until).total_seconds()) < 60
    # naive → coi UTC (DTZ001: cố ý tạo naive để test coerce).
    naive = datetime(2026, 10, 11, 5, 30)  # noqa: DTZ001
    assert rep.period_bounds(7, naive)[1] == naive.replace(tzinfo=UTC)
    aware = datetime(2026, 10, 11, 5, 30, tzinfo=UTC)
    assert rep.period_bounds(7, aware)[1] == aware


def test_fmt_vnd():
    assert rep._fmt_vnd(6720000) == "6.720.000 ₫"
    assert rep._fmt_vnd(0) == "0 ₫"
    assert rep._fmt_vnd(None) == "—"


def test_report_name_deterministic():
    name = rep.report_name(S, U)
    assert name == "report-2026-10-04_2026-10-10.md"
    assert rep.report_name(S, U) == name
    # Kỳ khác → tên khác (không đè lẫn nhau).
    assert rep.report_name(S - timedelta(days=7), S) != name


# ---------- collect_chat (convlog edge enumerate đủ) ----------

def test_collect_chat_period_filter_and_edges(tmp_path):
    inside = _conv_rec(msg_id="in", ts="2026-10-08T00:00:00Z")
    edge_lo = _conv_rec(msg_id="lo", ts="2026-10-04T00:00:00Z",
                        answered=False)          # biên dưới inclusive
    edge_hi = _conv_rec(msg_id="hi", ts="2026-10-11T00:00:00Z")  # ngoài
    before = _conv_rec(msg_id="bf", ts="2026-10-03T23:59:59Z")
    bad_ts = _conv_rec(msg_id="bt", ts="10/10/2026")
    str_false = _conv_rec(msg_id="sf", answered="false")  # truthy str
    lines = [json.dumps(r) for r in
             (inside, edge_lo, edge_hi, before, bad_ts, str_false)]
    lines.append("{corrupt")
    lines.append(json.dumps({"_doc": "ghi chú"}))
    (tmp_path / "conversations.jsonl").write_bytes(
        ("\n".join(lines) + "\n").encode("utf-8"))

    st = rep.collect_chat(tmp_path, S, U)

    # in+lo+sf trong kỳ (zalo); hi/before ngoài; bt ts hỏng.
    assert st["in_period"] == 3
    assert st["answered_period"] == 1            # chỉ `inside`
    assert st["by_channel_period"] == {"zalo": 3, "streamlit": 0}
    assert st["total"] == 6
    # "false" (str) KHÔNG đếm answered — strict `is True`:
    # in+hi+bf+bt(True, ts hỏng vẫn đếm all-time) = 4.
    assert st["answered"] == 4
    assert st["bad_ts"] == 1
    assert st["skipped"] == 2                    # corrupt + _doc


def test_collect_chat_missing_and_empty(tmp_path):
    st = rep.collect_chat(tmp_path, S, U)
    assert st["total"] == 0 and st["in_period"] == 0
    (tmp_path / "conversations.jsonl").write_bytes(b"")
    st = rep.collect_chat(tmp_path, S, U)
    assert st["total"] == 0


# ---------- collect_db qua fake-conn ----------

class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    """Route theo (MỌI substring phải khớp, params đúng nếu khai báo).
    Cần multi-substring vì nhiều query share `from leads where ts` +
    cùng params (count vs group-by vs recent)."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, tuple(params or ())))
        for subs, want, rows in self.routes:
            if want is not None and tuple(params or ()) != want:
                continue
            if all(s in sql for s in subs):
                return _Cur(rows)
        raise AssertionError(f"no route: {sql!r} params={params!r}")


def _route(*subs, params=None, rows=()):
    return (subs, params, rows)


def _db_conn():
    return _Conn([
        _route("select count(*)", "from orders", params=(S, U),
               rows=[(3, 6720000)]),
        _route("select count(*)", "from orders", params=(PS, S),
               rows=[(2, 2280000)]),
        _route("from orders", "group by channel",
               rows=[("showroom", 2, 5540000), ("zalo", 1, 1180000)]),
        _route("from orders", "group by status",
               rows=[("done", 2), ("new", 1)]),
        _route("left join products",
               rows=[("Ngoài catalog", 1, 5000000),
                     ("SAPHRATON", 5, 1180000)]),
        _route("from orders", "group by source",
               rows=[("sample:sample_orders.jsonl", 5)]),
        _route("group by intent", rows=[("price", 14),
                                        ("contact", 14),
                                        ("order", 2)]),
        _route("from leads", "group by channel",
               rows=[("zalo", 24), ("streamlit", 6)]),
        _route("from leads", "order by ts desc",
               rows=[(datetime(2026, 10, 8, tzinfo=UTC), "zalo",
                      "price", "giá bao nhiêu?")]),
        _route("from leads", "where ts", params=(S, U), rows=[(30,)]),
        _route("from leads", "where ts", params=(PS, S), rows=[(0,)]),
        _route("status = 'new'", rows=[(30,)]),
        _route("from leads", "group by source",
               rows=[("conversations.jsonl", 30)]),
        _route("from leads", params=(), rows=[(30,)]),
        _route("select count(*)", "from plot_logs", rows=[(6,)]),
        _route("group by plot_id", rows=[("KV-A01", 2),
                                         ("KV-A02", 2),
                                         ("KV-B01", 2)]),
        _route("group by activity", rows=[("tưới", 2),
                                          ("kiểm tra sâu bệnh", 1)]),
        _route("from plot_logs", "select ts,",
               rows=[(datetime(2026, 10, 5, tzinfo=UTC), "KV-A01",
                      "tưới", "tưới phun sương"),
                     (datetime(2026, 10, 7, tzinfo=UTC), "KV-A01",
                      "kiểm tra sâu bệnh", "phát hiện rệp"),
                     (datetime(2026, 10, 8, tzinfo=UTC), "KV-A02",
                      "làm cỏ", None)]),
        _route("sum(tree_count)", rows=[(3, 5300)]),
        _route("from plot_logs", "group by source",
               rows=[("sample:sample_plot_logs.jsonl", 6)]),
        _route("from plots", "group by source",
               rows=[("sample:sample_plots.jsonl", 3)]),
    ])


def test_collect_db_happy_path_and_prev_params():
    conn = _db_conn()
    db = rep.collect_db(conn, S, U)

    assert db["db_ok"] is True
    s = db["sales"]
    assert (s["count"], s["revenue"]) == (3, 6720000)
    assert (s["prev_count"], s["prev_revenue"]) == (2, 2280000)
    assert s["by_status"] == {"done": 2, "new": 1}
    assert s["top"][0][0] == "Ngoài catalog"
    assert s["sample"] is True                  # toàn 'sample:*'
    l = db["leads"]
    assert (l["new"], l["prev_new"], l["total"], l["pending"]) \
        == (30, 0, 30, 30)
    assert l["by_intent"]["price"] == 14
    assert l["sample"] is False                 # 'conversations.jsonl'
    f = db["farm"]
    assert f["count"] == 6 and f["plots"] == 3 and f["trees"] == 5300
    assert f["sample"] is True
    # Flag bất-thường: keyword trong activity/detail.
    assert len(f["flags"]) == 1
    assert f["flags"][0][1] == "KV-A01"
    # Query kỳ trước phải đúng cặp params (prev_since, since).
    assert any("from orders" in sql and params == (PS, S)
               for sql, params in conn.calls)


def test_collect_db_error_returns_degraded():
    class Dead:
        def execute(self, *a):
            raise psycopg.OperationalError("connection dead")

    db = rep.collect_db(Dead(), S, U)
    assert db["db_ok"] is False
    assert "connection dead" in db["db_error"]


# ---------- render ----------

def _full_rep(tmp_path=None, db=None):
    """rep hoàn chỉnh để render — db=None → nhánh degraded."""
    data_dir = tmp_path or DATA
    return {"period": {"days": 7, "since": S, "until": U},
            "generated_at": datetime(2026, 10, 10, 16, 0, tzinfo=UTC),
            "db": (db if db is not None
                   else rep.collect_db(_db_conn(), S, U)),
            "chat": rep.collect_chat(data_dir, S, U)}


def test_render_full_sections_and_flags(tmp_path):
    text = rep.render(_full_rep(tmp_path))
    assert text.startswith("# Báo cáo định kỳ")
    assert "2026-10-04 → 2026-10-10" in text
    assert "BẢN NHÁP" in text and "KHÔNG tự gửi" in text
    assert "## 1. Bán hàng *(mẫu)*" in text      # toàn sample: → gắn nhãn
    assert "6.720.000 ₫" in text
    assert "| Đơn hàng | 3 | 2 |" in text        # kỳ này | kỳ trước
    assert "## 2. Leads" in text and "Mới trong kỳ: **30**" in text
    assert "Chờ xử lý (new): 30" in text
    assert "## 4. Vùng trồng *(mẫu)*" in text
    assert "Cần chú ý" in text                   # flag sâu bệnh
    assert "## 5. Social metrics" in text and "Chờ bàn giao" in text
    assert "sample:sample_orders.jsonl=5 *(mẫu)*" in text
    assert "Kiểm chứng số liệu" in text


def test_render_degraded_marks_db_sections(tmp_path):
    db = {"db_ok": False, "db_error": "không kết nối được Postgres"}
    text = rep.render(_full_rep(tmp_path, db=db))
    assert text.count("[chưa nạp") == 3          # mục 1, 2, 4
    assert "không kết nối được Postgres" in text
    assert "DB:** không khả dụng" in text
    # Mục 3 (convlog file-based) vẫn đầy đủ khi DB chết.
    assert "## 3. Kênh chat" in text and "Tin nhắn trong kỳ" in text
    # Degraded không crash khi không có section data.
    assert "## 1. Bán hàng" in text and "*(mẫu)*" not in text.split(
        "## 1. Bán hàng")[1].split("\n")[0]


def test_render_sample_flag_only_when_all_sample(tmp_path):
    db = rep.collect_db(_db_conn(), S, U)
    db["leads"]["sources"] = {"conversations.jsonl": 29, "manual": 1}
    db["leads"]["sample"] = rep._sample(db["leads"]["sources"])
    text = rep.render(_full_rep(tmp_path, db=db))
    # leads trộn nguồn → KHÔNG gắn *(mẫu)* ở tiêu đề section 2.
    assert "## 2. Leads (kênh chat)\n" in text


# ---------- write / generate end-to-end ----------

def test_write_report_atomic_overwrite(tmp_path):
    out = tmp_path / "deep" / "reports"          # chưa tồn tại → mkdir
    p1 = rep.write_report("nội dung có dấu\nline2", out, "r.md")
    assert p1.read_bytes() == "nội dung có dấu\nline2".encode()
    p2 = rep.write_report("ghi đè", out, "r.md")  # cùng tên → overwrite
    assert p1 == p2 and p2.read_text(encoding="utf-8") == "ghi đè"
    assert not list(out.glob("*.tmp"))           # không sót tmp


def test_list_reports_newest_first(tmp_path):
    for name in ("report-2026-09-01_2026-09-07.md",
                 "report-2026-10-04_2026-10-10.md"):
        rep.write_report("x", tmp_path, name)
    assert [p.name for p in rep.list_reports(tmp_path)] == [
        "report-2026-10-04_2026-10-10.md",
        "report-2026-09-01_2026-09-07.md"]
    assert rep.list_reports(tmp_path / "nope") == []


def test_generate_with_fake_conn_writes_real_numbers(tmp_path):
    conv = tmp_path / "conversations.jsonl"
    conv.write_bytes(json.dumps(_conv_rec()).encode() + b"\n")
    path, r = rep.generate(until=date(2026, 10, 10), out_dir=tmp_path,
                           data_dir=tmp_path, conn=_db_conn())
    assert path.name == "report-2026-10-04_2026-10-10.md"
    assert r["db"]["db_ok"] is True
    body = path.read_text(encoding="utf-8")
    assert "6.720.000 ₫" in body and "Mới trong kỳ: **30**" in body


def test_generate_db_down_still_writes_degraded(tmp_path, monkeypatch):
    monkeypatch.setattr(rep, "connect", lambda: None)
    path, r = rep.generate(until=date(2026, 10, 10), out_dir=tmp_path,
                           data_dir=tmp_path)
    assert path.exists()
    assert r["db"]["db_ok"] is False
    body = path.read_text(encoding="utf-8")
    assert "[chưa nạp" in body


def test_generate_closes_only_own_conn(tmp_path, monkeypatch):
    class C(_Conn):
        closed = False

        def close(self):
            self.closed = True

    # conn truyền sẵn → generate KHÔNG đóng (caller sở hữu).
    conn = C([])
    conn.routes = _db_conn().routes
    rep.generate(until=date(2026, 10, 10), out_dir=tmp_path,
                 data_dir=tmp_path, conn=conn)
    assert conn.closed is False

    # conn do generate tự connect (monkeypatch) → đóng sau collect.
    conn2 = C([])
    conn2.routes = _db_conn().routes
    monkeypatch.setattr(rep, "connect", lambda: conn2)
    rep.generate(until=date(2026, 10, 10), out_dir=tmp_path,
                 data_dir=tmp_path)
    assert conn2.closed is True
