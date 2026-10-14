"""v10.2 W102.1 — PC-A8 Theo dõi văn bản pháp luật: nguồn văn bản tầng A
qua collector chung (`crawler.intel`, robots + nhịp + chặn tầng C) và luật
`legal_doc` → `red_alerts` (`pipelines.intel_alert.scan`).

Mạng = `httpx.MockTransport` (0 request ra Internet thật, URL nguồn chưa
xác minh); nhịp đo bằng clock/sleep GIẢ. DB THẬT trong schema tạm +
docs/schema.sql + docs/roles.sql → ROLLBACK cuối test.
"""

import json
import os
import re
import uuid
from datetime import timedelta
from pathlib import Path

import httpx
import psycopg
import pytest

from crawler import intel
from pipelines import intel_alert as ia
from pipelines import red_alert

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC_FILE = ROOT / "data" / "intel_sources.json"
LEGAL = ia.load_rules()["legal_sources"]
LEGAL_ID = "cuc-attp-van-ban"
FEED = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Văn bản mới</title>
<item><title>Nghị định quy định về thực phẩm bảo vệ sức khỏe</title>
<link>https://vfa.gov.vn/van-ban/nd-01</link>
<description>Văn bản quy phạm pháp luật mới ban hành.</description>
<pubDate>Mon, 12 Oct 2026 02:00:00 GMT</pubDate></item>
<item><title>Thông tư hướng dẫn quảng cáo thực phẩm</title>
<link>https://vfa.gov.vn/van-ban/tt-02</link>
<description>Hướng dẫn thủ tục.</description></item>
</channel></rss>""".encode()
ROBOTS_OK = b"User-agent: *\nDisallow: /private/\n"


# ---------------------------------------------------------------- helpers


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


class Mock:
    """MockTransport ghi mọi request; routes: (host, path) -> Response."""

    def __init__(self, routes):
        self.routes = routes
        self.reqs = []

    def __call__(self, request):
        self.reqs.append(request)
        key = (request.url.host, request.url.path)
        st, hdrs, body = self.routes.get(key, (404, {}, b"not found"))
        # stream (không content=) — Fetcher đọc iter_raw có trần byte.
        return httpx.Response(st, headers=hdrs,
                              stream=httpx.ByteStream(body))

    def transport(self):
        return httpx.MockTransport(self)


class TxConn:
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
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w102a_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _NullJob:
    def __enter__(self):
        return {"ok": True, "detail": None}

    def __exit__(self, *a):
        return False


def _cli(db, monkeypatch, routes, argv=None):
    mock, clk = Mock(routes), Clock()
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: TxConn(db))
    monkeypatch.setattr(intel, "job_run", lambda n: _NullJob())
    rc = intel.main(argv or ["--run", "--source", LEGAL_ID],
                    transport=mock.transport(), sleep=clk.sleep,
                    clock=clk.clock)
    return rc, mock, clk


def _reqs(out):
    return [json.loads(ln.split(" ", 1)[1]) for ln in out.splitlines()
            if ln.startswith("[req] ")]


def _src(sid):
    cfg, _ = intel.load_sources(SRC_FILE)
    return {s["id"]: s for s in cfg["sources"]}[sid]


# ---------------------------------------------------------------- cấu hình


def test_real_sources_and_rules_drift_both_ways():
    cfg, errs = intel.load_sources(SRC_FILE)
    assert errs == [] and cfg is not None
    by_id = {s["id"]: s for s in cfg["sources"]}
    assert len(LEGAL) >= 3
    for sid in LEGAL:                       # rules → sources: tồn tại, tầng A
        s = by_id[sid]
        assert s["tier"] == "A" and s["status"] == "cho_duyet"
        assert s["kind"] == "rss" and "Pháp chế duyệt nguồn" in s["note"]
        assert "phap_ly" in s["topics_hint"]
    # sources → rules: mọi nguồn gợi ý phap_ly đều nằm trong legal_sources.
    assert {s["id"] for s in cfg["sources"]
            if "phap_ly" in s.get("topics_hint", [])} == set(LEGAL)
    ph = cfg["topics"]["phap_ly"]
    assert {"nghị định", "thông tư", "dự thảo", "văn bản hợp nhất",
            "quyết định số", "luật an toàn thực phẩm", "luật quảng cáo",
            "tác hại của rượu, bia"} <= set(ph)
    assert "luật" not in ph                 # không cụm trần
    assert "PC-A8" in cfg["_doc"]
    raw = json.loads(ia.RULES_FILE.read_text(encoding="utf-8"))
    assert "legal_doc" in raw["_doc"] and raw["status"] == "gia_dinh"


def test_phap_ly_topic_classify():
    topics = intel.load_sources(SRC_FILE)[0]["topics"]
    assert "phap_ly" in intel.classify(
        "Dự thảo nghị định về quảng cáo", "", topics)[0]
    assert "phap_ly" not in intel.classify(
        "Luật sư tư vấn ly hôn", "", topics)[0]


@pytest.mark.parametrize("legal", [None, [], [""], "x", ["Bad Id"],
                                   ["ok", "Bad Id"], [3]])
def test_load_rules_legal_sources_fail_closed(tmp_path, legal):
    doc = json.loads(ia.RULES_FILE.read_text(encoding="utf-8"))
    if legal is None:
        doc.pop("legal_sources")
    else:
        doc["legal_sources"] = legal
    p = tmp_path / "rules.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ia.IntelAlertConfigError, match="legal_sources"):
        ia.load_rules(p)


def test_cli_bad_legal_sources_exit1_before_connect(monkeypatch, tmp_path,
                                                    capsys):
    doc = json.loads(ia.RULES_FILE.read_text(encoding="utf-8"))
    doc["legal_sources"] = []
    p = tmp_path / "rules.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(ia, "RULES_FILE", p)
    calls = []
    monkeypatch.setattr(ia, "connect", lambda: calls.append(1))
    assert ia.main(["--run"]) == 1
    assert calls == [] and "legal_sources" in capsys.readouterr().out


# ---------------------------------------------------------------- match thuần


def _m(source, topics, flags=(), title="Văn bản mới ban hành"):
    return ia.match({"title": title, "snippet": "", "topics": list(topics),
                     "flags": list(flags), "source": source}, ia.load_rules())


def test_match_legal_doc_pure():
    assert "legal_doc" in _m(LEGAL_ID, ["phap_ly", "tpbvsk"])
    assert "legal_doc" in _m("chinhphu-van-ban", ["quang_cao"])
    # cờ rượu (không tpbvsk) → legal_doc
    assert "legal_doc" in _m("boyte-van-ban", ["phap_ly"], ["ruou"])
    assert "legal_doc" in _m("boyte-van-ban", ["phap_ly"],
                             title="Nghị định về kinh doanh rượu")
    # nguồn văn bản chỉ chủ đề sâm → không
    assert "legal_doc" not in _m(LEGAL_ID, ["sam"], title="Sâm mùa thu")
    # nguồn báo + tpbvsk → không legal_doc
    assert "legal_doc" not in _m("vnexpress-suc-khoe", ["tpbvsk"])
    assert "legal_doc" not in _m(None, ["tpbvsk"])
    assert ia.RULES[-1] == "legal_doc" and len(ia.RULES) == 4


# ---------------------------------------------------------------- collector


def _host(sid=LEGAL_ID):
    return httpx.URL(_src(sid)["url"]).host


def _feed_path(sid=LEGAL_ID):
    return httpx.URL(_src(sid)["url"]).path


def test_collector_robots_first_get_only_delay_and_store(db, monkeypatch,
                                                         capsys):
    h = _host()
    rc, mock, clk = _cli(db, monkeypatch, {
        (h, "/robots.txt"): (200, {}, ROBOTS_OK),
        (h, _feed_path()): (200, {}, FEED)})
    out = capsys.readouterr().out
    assert rc == 0, out
    paths = [r.url.path for r in mock.reqs]
    assert paths == ["/robots.txt", _feed_path()]
    assert all(r.method == "GET" for r in mock.reqs)
    assert {r.url.host for r in mock.reqs} == {h}
    reqs = _reqs(out)
    assert reqs[0]["kind"] == "robots" and reqs[1]["kind"] == "feed"
    assert reqs[1]["gap_s"] >= 1.0 and sum(clk.sleeps) >= 1.0 - 1e-9
    assert "[warn] cuc-attp-van-ban: nguồn chưa duyệt — chạy thử" in out
    rows = db.execute("select source, tier, topics from intel_items"
                      " order by id").fetchall()
    assert len(rows) == 2
    assert all(src == LEGAL_ID and tier == "A" and "phap_ly" in tps
               for src, tier, tps in rows)
    assert any("tpbvsk" in tps for _, _, tps in rows)
    assert any("quang_cao" in tps for _, _, tps in rows)


def test_collector_robots_disallow_zero_feed_get(db, monkeypatch, capsys):
    h = _host()
    deny = b"User-agent: *\nDisallow: /\n"
    rc, mock, _ = _cli(db, monkeypatch, {
        (h, "/robots.txt"): (200, {}, deny),
        (h, _feed_path()): (200, {}, FEED)})
    out = capsys.readouterr().out
    assert rc == 1                         # 0 nguồn thành công
    assert [r.url.path for r in mock.reqs] == ["/robots.txt"]
    assert "[robots-deny] " in out
    assert db.execute("select count(*) from intel_items").fetchone()[0] == 0


@pytest.mark.parametrize("target", ["https://shopee.vn/rss",
                                    "https://www.facebook.com/feed",
                                    "https://m.tiktok.com/x"])
def test_collector_redirect_to_blocked_host(db, monkeypatch, capsys, target):
    h = _host()
    rc, mock, _ = _cli(db, monkeypatch, {
        (h, "/robots.txt"): (200, {}, ROBOTS_OK),
        (h, _feed_path()): (302, {"Location": target}, b"")})
    out = capsys.readouterr().out
    assert rc == 1
    assert "[blocked] " in out
    blocked = httpx.URL(target).host
    assert blocked not in {r.url.host for r in mock.reqs}
    assert [r.url.path for r in mock.reqs] == ["/robots.txt", _feed_path()]


def test_collector_tier_c_source_refused_zero_requests(db, monkeypatch,
                                                       capsys):
    rc, mock, _ = _cli(db, monkeypatch, {},
                       ["--run", "--source", "c-shopee"])
    assert rc == 2 and mock.reqs == []
    assert '"reason": "tier_c"' in capsys.readouterr().out


# ---------------------------------------------------------------- red alert


def _item(db, title, topics, source=LEGAL_ID, flags=()):
    return db.execute(
        "insert into intel_items (url, domain, source, tier, title,"
        " content_sha256, topics, flags) values (%s, 'vfa.gov.vn', %s, 'A',"
        " %s, %s, %s, %s) returning id",
        (f"https://vfa.gov.vn/{uuid.uuid4().hex}", source, title,
         uuid.uuid4().hex, list(topics), list(flags))).fetchone()[0]


def test_legal_doc_goes_to_red_alert_once_then_escalates(db):
    tx = TxConn(db)
    # Tiêu đề KHÔNG chạm nhóm regulation/brand → chỉ luật legal_doc.
    iid = _item(db, "Văn bản mới về ghi nhãn thực phẩm chức năng",
                ["phap_ly", "tpbvsk"])
    _item(db, "Văn bản mới về thuế", ["phap_ly"])            # không tpbvsk
    _item(db, "Thực phẩm chức năng bán chạy", ["tpbvsk"],
          source="vnexpress-suc-khoe")                        # nguồn báo
    now = db.execute("select now()").fetchone()[0]
    s = ia.scan(tx, now)
    assert s["scanned"] == 3 and s["alerts"] == 1
    rows = db.execute(
        "select id, source_agent, detail, route_error from red_alerts"
        " order by id").fetchall()
    assert len(rows) == 1
    aid, agent, detail, err = rows[0]
    assert agent == "intel_red_alert" and detail["intel_item_id"] == iid
    assert detail["rules"] == ["legal_doc"] and detail["source"] == LEGAL_ID
    assert err == red_alert.MISSING        # chưa có người nhận thật
    assert ia.scan(tx, now)["alerts"] == 0                    # chạy lại
    assert db.execute("select count(*) from red_alerts").fetchone()[0] == 1
    ts = db.execute("select ts from red_alerts where id = %s",
                    (aid,)).fetchone()[0]
    assert ia.escalate(tx, ts + timedelta(hours=1, minutes=59))[
        "escalated"] == 0
    e = ia.escalate(tx, ts + timedelta(hours=2, minutes=1))
    assert e["escalated"] == 1 and e["ids"] == [aid]
    assert ia.escalate(tx, ts + timedelta(hours=5))["escalated"] == 0


def test_item_matching_two_rules_one_alert(db):
    tx = TxConn(db)
    _item(db, "Dự thảo nghị định về quảng cáo thực phẩm bảo vệ sức khỏe",
          ["phap_ly", "tpbvsk", "quang_cao"])
    s = ia.scan(tx, db.execute("select now()").fetchone()[0])
    assert s["alerts"] == 1
    (detail,) = db.execute("select detail from red_alerts").fetchone()
    assert detail["rules"] == ["regulation", "legal_doc"]


def test_intel_alert_no_network_no_llm():
    src = (ROOT / "pipelines" / "intel_alert.py").read_text(encoding="utf-8")
    assert not re.search(r"import httpx|import requests|llm_gateway", src)
