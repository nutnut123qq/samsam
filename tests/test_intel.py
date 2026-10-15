"""v7.0-collector-chung — `crawler.intel` (WP09 Collector + luật Dedup &
Classifier).

Mạng = `http.server` local chạy thread (port 0); nhịp đo bằng clock/sleep
GIẢ tiêm vào Fetcher (không assert wall-clock). Spy transport bọc
`handle_request` để chứng minh 0 request tới host bị chặn. Phần DB chạy
trên `DATABASE_URL` (samsam_infra) trong schema tạm + ROLLBACK cuối test.
"""

import ast
import copy
import gzip
import json
import os
import re
import threading
import types
import uuid
import zlib
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import psycopg
import pytest

from crawler import intel
from pipelines import guardrail, job_runs, kb_filter, llm_gateway

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "intel"
RSS = (FIX / "rss_sample.xml").read_bytes()
ATOM = (FIX / "atom_sample.xml").read_bytes()
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
TOPICS = json.loads((ROOT / "data" / "intel_sources.json")
                    .read_text(encoding="utf-8"))["topics"]


# ---------------------------------------------------------------- helpers


class Clock:
    """Clock/sleep giả: chỉ sleep mới làm thời gian trôi."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


class Spy(httpx.HTTPTransport):
    def __init__(self):
        super().__init__()
        self.hosts = []

    def handle_request(self, request):
        self.hosts.append(request.url.host)
        return super().handle_request(request)


class Server:
    """http.server local; routes: path -> (status, headers, body) | callable."""

    def __init__(self, routes):
        self.routes = routes
        self.hits = []
        self.uas = []
        srv = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                srv.hits.append(self.path)
                srv.uas.append(self.headers.get("User-Agent", ""))
                route = srv.routes.get(self.path, (404, {}, b"not found"))
                try:
                    if callable(route):
                        route(self)
                        return
                    st, hdrs, body = route
                    self.send_response(st)
                    for k, v in hdrs.items():
                        self.send_header(k, v)
                    if "Content-Length" not in hdrs:
                        self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (ConnectionError, OSError):
                    pass

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.t = threading.Thread(target=self.httpd.serve_forever,
                                  kwargs={"poll_interval": 0.05},
                                  daemon=True)
        self.t.start()

    def url(self, path, host="127.0.0.1"):
        return f"http://{host}:{self.port}{path}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def servers():
    made = []

    def make(routes):
        s = Server(routes)
        made.append(s)
        return s
    yield make
    for s in made:
        s.close()


ROBOTS_OK = (200, {}, b"User-agent: *\nDisallow: /private/\n")


def _fetcher(clk, logs, spy=None, **kw):
    return intel.Fetcher(transport=spy or Spy(), sleep=clk.sleep,
                         clock=clk.clock, log=logs.append, **kw)


def _reqs(lines):
    return [json.loads(ln.split(" ", 1)[1]) for ln in lines
            if ln.startswith("[req] ")]


# ---------------------------------------------------------------- W70.1


def test_real_sources_file_gate():
    cfg, errs = intel.load_sources(ROOT / "data" / "intel_sources.json")
    assert errs == [] and cfg is not None
    ab = [s for s in cfg["sources"] if s["tier"] in ("A", "B")]
    assert ab and all(s["status"] == "cho_duyet" for s in ab)
    assert any(s["tier"] == "C" for s in cfg["sources"])
    assert cfg["llm"]["enabled"] is False
    assert "chờ" in cfg["_doc"] and "chờ" in cfg["llm"]["_doc"]
    assert set(cfg["topics"]) == {"sam", "tpbvsk", "gioi_tre", "quang_cao",
                                  "doi_thu", "chuong_trinh", "phap_ly"}
    # Host tầng C được thêm vào danh sách chặn.
    c_hosts = intel.tier_c_hosts(cfg)
    assert "linkedin.com" in c_hosts
    assert intel.is_blocked("www.linkedin.com", c_hosts)


def _base_cfg():
    return json.loads((ROOT / "data" / "intel_sources.json")
                      .read_text(encoding="utf-8"))


def _bad(mut):
    cfg = _base_cfg()
    mut(cfg)
    return cfg


BAD_CASES = [
    (lambda c: c.update(sources=[]), "sources"),
    (lambda c: c["sources"].append(copy.deepcopy(c["sources"][0])),
     "vnexpress-suc-khoe.id"),
    (lambda c: c["sources"][1].update(tier="X"), "vnexpress-kinh-doanh.tier"),
    (lambda c: c["sources"][1].update(url="ftp://a.vn/x"),
     "vnexpress-kinh-doanh.url"),
    (lambda c: c["sources"][1].update(kind="html"),
     "vnexpress-kinh-doanh.kind"),
    (lambda c: c["sources"][1].update(status="ok"),
     "vnexpress-kinh-doanh.status"),
    (lambda c: c.update(topics={}), "topics"),
    (lambda c: c["topics"].update(sam=[]), "topics.sam"),
    (lambda c: c["sources"][1].update(id="Bad Id!"), "sources[1].id"),
    (lambda c: c["llm"].update(enabled="yes"), "llm.enabled"),
]


@pytest.mark.parametrize("mut,field", BAD_CASES)
def test_load_sources_fail_closed(tmp_path, mut, field):
    p = tmp_path / "s.json"
    p.write_text(json.dumps(_bad(mut), ensure_ascii=False), encoding="utf-8")
    cfg, errs = intel.load_sources(p)
    assert cfg is None
    assert any(e.startswith(field) for e in errs), errs


def test_load_sources_missing_and_broken(tmp_path):
    cfg, errs = intel.load_sources(tmp_path / "khong-co.json")
    assert cfg is None and "khong-co.json" in errs[0]
    p = tmp_path / "b.json"
    p.write_text("{hỏng", encoding="utf-8")
    cfg, errs = intel.load_sources(p)
    assert cfg is None and errs


# ---------------------------------------------------------------- W70.2


@pytest.mark.parametrize("host", [
    "shopee.vn", "m.shopee.vn", "SHOPEE.VN", "shopee.vn.", "vt.tiktok.com",
    "www.facebook.com", "https://user@shopee.vn:443/x", "shopee.vn:443",
    "ｓｈｏｐｅｅ.vn"])
def test_is_blocked_true(host):
    assert intel.is_blocked(host)


@pytest.mark.parametrize("host", [
    "shopee.vn.evil.com", "notshopee.vn", "vnexpress.net", "", "x.com.vn"])
def test_is_blocked_false(host):
    assert not intel.is_blocked(host)


@pytest.mark.parametrize("url", [
    "https://shopee.vn/x", "http://user@m.shopee.vn:443/a",
    "https://www.tiktok.com/@a", "ftp://vnexpress.net/rss",
    "javascript:alert(1)"])
def test_fetch_blocked_raises_no_request(url):
    clk, logs, spy = Clock(), [], Spy()
    with _fetcher(clk, logs, spy) as f, pytest.raises(intel.BlockedDomain):
        f.fetch(url, "t")
    assert spy.hosts == [] and f.used == 0
    assert any(ln.startswith("[blocked] ") for ln in logs)


def test_robots_disallow_private(servers):
    s = servers({"/robots.txt": ROBOTS_OK,
                 "/public/c": (200, {}, b"<rss/>")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        assert f.fetch(s.url("/private/a"), "t") is None
        assert f.fetch(s.url("/private/b"), "t") is None
        r = f.fetch(s.url("/public/c"), "t")
    assert r.status == 200 and r.body == b"<rss/>"
    assert s.hits == ["/robots.txt", "/public/c"]
    assert sum(ln.startswith("[robots-deny] ") for ln in logs) == 2
    reqs = _reqs(logs)
    assert reqs[0]["kind"] == "robots" and reqs[0]["robots_ok"] is None
    assert reqs[1]["robots_ok"] is True


@pytest.mark.parametrize("st,hits", [
    (500, ["/robots.txt"]),
    (429, ["/robots.txt"]),
    (403, ["/robots.txt"]),
    (401, ["/robots.txt"]),
    (404, ["/robots.txt", "/feed"]),
    (410, ["/robots.txt", "/feed"]),
])
def test_robots_status_policy(servers, st, hits):
    s = servers({"/robots.txt": (st, {}, b"x"), "/feed": (200, {}, b"ok")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        r = f.fetch(s.url("/feed"), "t")
        f.fetch(s.url("/feed"), "t")  # lần 2: robots cache, không tải lại
    assert s.hits.count("/robots.txt") == 1
    assert [h for h in s.hits if h != "/feed"] == ["/robots.txt"]
    assert sorted(set(s.hits)) == sorted(set(hits))
    if "/feed" not in hits:
        assert r is None
    if st in (401, 403):
        assert any(ln.startswith("[robots-deny] ") for ln in logs)


def test_robots_too_large_skips_host(servers):
    s = servers({"/robots.txt": (200, {}, b"#" * 600_000),
                 "/feed": (200, {}, b"ok")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        assert f.fetch(s.url("/feed"), "t") is None
    assert s.hits == ["/robots.txt"]
    assert _reqs(logs)[0]["status"] == "too_large"


def test_content_429_no_retry(servers):
    s = servers({"/robots.txt": ROBOTS_OK, "/a": (429, {}, b"slow down"),
                 "/b": (200, {}, b"ok")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        r = f.fetch(s.url("/a"), "t")
        assert f.fetch(s.url("/b"), "t") is None
    assert r.status == 429
    assert s.hits == ["/robots.txt", "/a"]


def test_redirect_to_tier_c_and_marketplace_blocked(servers):
    c = servers({"/x": (200, {}, b"KHONG DUOC TOI")})
    a = servers({
        "/robots.txt": ROBOTS_OK,
        "/r1": (302, {"Location": c.url("/x", host="localhost")}, b""),
        "/r2": (302, {"Location": "https://shopee.vn/x"}, b""),
        "/r3": (301, {"Location": "https://m.tiktok.com/@a"}, b""),
    })
    cfg = {"sources": [{"tier": "C", "url": c.url("/", host="localhost")}]}
    extra = intel.tier_c_hosts(cfg)
    assert extra == ("localhost",)
    clk, logs, spy = Clock(), [], Spy()
    with _fetcher(clk, logs, spy, extra_block=extra) as f:
        for path in ("/r1", "/r2", "/r3"):
            with pytest.raises(intel.BlockedDomain):
                f.fetch(a.url(path), "t")
    assert c.hits == []
    assert all(not intel.is_blocked(h, extra) for h in spy.hosts)
    assert set(spy.hosts) == {"127.0.0.1"}
    blocked = [json.loads(ln.split(" ", 1)[1]) for ln in logs
               if ln.startswith("[blocked] ")]
    assert [b["reason"] for b in blocked] == ["tier_c", "hard", "hard"]


def test_redirect_loop_stops_after_3_hops(servers):
    s = servers({"/robots.txt": ROBOTS_OK,
                 "/loop": (302, {"Location": "/loop"}, b"")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        assert f.fetch(s.url("/loop"), "t") is None
    # 1 request gốc + tối đa 3 hop theo redirect.
    assert s.hits.count("/loop") == 1 + intel.MAX_HOPS
    assert any("quá 3 redirect" in ln for ln in logs)


def _big_no_length(h):
    h.send_response(200)
    h.end_headers()
    for _ in range(50):
        h.wfile.write(b"x" * 1000)


def test_too_large_content_length_and_stream(servers):
    s = servers({"/robots.txt": ROBOTS_OK,
                 "/big": (200, {"Content-Length": "5000000"}, b"x" * 100),
                 "/stream": _big_no_length,
                 "/bomb": (200, {"Content-Encoding": "gzip"},
                           gzip.compress(b"\0" * 5_000_000))})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        r1 = f.fetch(s.url("/big"), "t")
        r3 = f.fetch(s.url("/bomb"), "t")
    with _fetcher(Clock(), logs, max_bytes=10_000) as f:
        r2 = f.fetch(s.url("/stream"), "t")
    for r in (r1, r2, r3):
        assert r.status == "too_large" and r.body is None
    st = {q["url"].rsplit("/", 1)[-1]: q for q in _reqs(logs)}
    assert st["big"]["status"] == "too_large" and st["big"]["bytes"] == 0
    assert st["stream"]["status"] == "too_large"
    assert st["stream"]["bytes"] <= 10_000 + 65_536


def test_pacing_fake_clock_20_urls(servers):
    routes = {"/robots.txt": ROBOTS_OK}
    routes.update({f"/f{i}": (200, {}, b"ok") for i in range(20)})
    s = servers(routes)
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        for i in range(20):
            assert f.fetch(s.url(f"/f{i}"), "t").status == 200
    reqs = _reqs(logs)
    assert len(reqs) == 21 and reqs[0]["gap_s"] is None
    gaps = [q["gap_s"] for q in reqs[1:]]
    assert all(g >= 1.0 for g in gaps)
    assert sum(clk.sleeps) >= 20 * 1.0


def test_crawl_delay_respected(servers):
    s = servers({"/robots.txt": (200, {}, b"User-agent: *\nCrawl-delay: 3\n"),
                 "/a": (200, {}, b"ok"), "/b": (200, {}, b"ok")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        f.fetch(s.url("/a"), "t")
        f.fetch(s.url("/b"), "t")
    gaps = [q["gap_s"] for q in _reqs(logs)[1:]]
    assert len(gaps) == 2 and all(g >= 3.0 for g in gaps)


def test_user_agent_has_identity(servers, monkeypatch):
    monkeypatch.delenv("INTEL_CONTACT", raising=False)
    s = servers({"/robots.txt": ROBOTS_OK, "/a": (200, {}, b"ok")})
    with _fetcher(Clock(), []) as f:
        f.fetch(s.url("/a"), "t")
    assert len(s.uas) == 2
    assert all("samsam-intel" in ua and "mailto:" in ua for ua in s.uas)
    monkeypatch.setenv("INTEL_CONTACT", "x\r\nInjected: 1")
    assert "Injected" not in intel.user_agent()


def test_budget_total_includes_robots(servers):
    s = servers({"/robots.txt": ROBOTS_OK, "/f1": (200, {}, b"1"),
                 "/f2": (200, {}, b"2"), "/f3": (200, {}, b"3")})
    with _fetcher(Clock(), [], budget=3) as f:
        f.fetch(s.url("/f1"), "t")
        f.fetch(s.url("/f2"), "t")
        with pytest.raises(intel.BudgetExhausted):
            f.fetch(s.url("/f3"), "t")
    assert len(s.hits) == 3


# ---------------------------------------------------------------- W70.3


def test_parse_rss_sample():
    es = intel.parse_feed(RSS)
    assert len(es) == 4
    assert es[0]["title"] == "Sâm Ngọc Linh giả bị thu giữ tại Quảng Nam"
    assert es[0]["link"].startswith("https://bao.example.vn/bai/sam-gia/")
    assert str(intel.parse_date(es[0]["published"])) == "2026-10-12 08:00:00+07:00"
    assert intel.parse_date(es[2]["published"]) is None
    assert intel.parse_date(es[3]["published"]) is None


def test_parse_atom_sample():
    es = intel.parse_feed(ATOM)
    assert len(es) == 2
    assert es[0]["link"] == "https://nganh.example.org/tin/tra-sua"
    assert "Toàn văn" not in es[0]["desc"]  # có summary → bỏ content
    assert es[1]["link"] == "https://nganh.example.org/tin/nhan-sam"
    assert "KGC" in es[1]["desc"]
    d = intel.parse_date(es[1]["published"])
    assert d.utcoffset().total_seconds() == 7 * 3600  # naive → giờ VN
    assert str(intel.parse_date(es[0]["published"])) == "2026-10-10 07:00:00+00:00"


def test_snippet_cut_and_pii_masked():
    long = "Thông tin thị trường sâm. " * 200
    assert len(long) > 5000
    assert len(intel.clean_text(long)) <= 300
    raw = ("<p>Liên hệ 0905 123 456 hoặc a.b@gmail.com — lô hàng "
           "10.050.000.000 đồng</p>")
    s = intel.clean_text(raw)
    assert "0905 123 456" not in s and "a.b@gmail.com" not in s
    assert "10.050.000.000" in s
    assert intel.clean_text("a\u2028b\x00c\u202ed") == "a b c d"
    # Mép cắt PRE_MAX rơi giữa SĐT: không lọt đuôi số dở.
    edge = "x " * ((intel.PRE_MAX - 6) // 2) + "0905 123 456"
    assert "0905" not in intel.clean_text(edge, 2000)


def test_doctype_entity_rejected_fast():
    bomb = (b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa">'
            b'<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
            b"<rss><channel><item><title>&b;</title></item></channel></rss>")
    logs = []
    assert intel.parse_feed(bomb, logs.append) == []
    assert logs and "DOCTYPE" in logs[0]
    assert intel.parse_feed(bomb.replace(b"DOCTYPE", b"doctype"),
                            logs.append) == []


def test_broken_xml_warns():
    logs = []
    assert intel.parse_feed(b"<rss><channel><item>", logs.append) == []
    assert logs and logs[0].startswith("[warn]")
    assert intel.parse_feed("<rss/>".encode("utf-16"), logs.append) == []
    # Encoding khai báo lạ: LookupError không được làm chết lượt.
    assert intel.parse_feed(b'<?xml version="1.0" encoding="bogus"?><rss/>',
                            logs.append) == []


def test_max_entries_capped():
    items = b"".join(b"<item><title>t%d</title></item>" % i
                     for i in range(300))
    es = intel.parse_feed(b"<rss><channel>" + items + b"</channel></rss>")
    assert len(es) == intel.MAX_ENTRIES


@pytest.mark.parametrize("title,want", [
    ("Sâm Ngọc Linh giả bị thu giữ", ["sam"]),
    ("sam ngoc linh gia re", ["sam"]),
    ("Săm lốp xe máy tăng giá", []),
    ("Cục ATTP xử phạt quảng cáo TPBVSK", ["quang_cao", "tpbvsk"]),
    ("Trà sữa hút giới trẻ", ["gioi_tre"]),
])
def test_classify_topics(title, want):
    assert intel.classify(title, "", TOPICS)[0] == want


def test_classify_flags():
    assert "ruou" in intel.classify("rượu sâm 40 độ", "", TOPICS)[1]
    assert "suc_khoe" in intel.classify("Sâm và bệnh ung thư", "", TOPICS)[1]
    assert intel.classify("Sâm Ngọc Linh giả", "", TOPICS)[1] == []


@pytest.fixture
def broken_kb(tmp_path, monkeypatch):
    empty = tmp_path / "ruou.txt"
    empty.write_text("# chỉ comment\n", encoding="utf-8")
    monkeypatch.setattr(kb_filter, "KEYWORDS_FILE", empty)
    kb_filter.reset_cache()
    yield
    kb_filter.reset_cache()


def test_classify_kb_broken_raises(broken_kb):
    with pytest.raises(kb_filter.KbFilterError):
        intel.classify("rượu sâm", "", TOPICS)


def test_cli_kb_broken_exit1_before_connect(broken_kb, monkeypatch):
    calls, spy = _no_connect(monkeypatch)
    assert intel.main(["--run", "--source", "vnexpress-suc-khoe"],
                      transport=spy) == 1
    assert calls == [] and spy.hosts == []


def test_build_items_off_topic_and_relative_link():
    es = intel.parse_feed(RSS)
    items, off = intel.build_items(es, {"id": "s", "tier": "A"},
                                   "https://bao.example.vn/rss", TOPICS)
    assert off == 1 and len(items) == 3
    assert items[0]["url"] == "https://bao.example.vn/bai/sam-gia"
    assert items[2]["url"] == "https://bao.example.vn/bai/ruou-sam"
    assert items[2]["flags"] == ["ruou"]
    for it in items:
        assert len(it["title"]) <= 300 and len(it["snippet"] or "") <= 300


# ---------------------------------------------------------------- W70.4


def test_normalize_url():
    assert (intel.normalize_url("HTTPS://Bao.VN:443/a/?utm_source=x&b=2&a=1#c")
            == "https://bao.vn/a?a=1&b=2")
    assert (intel.normalize_url("http://u:p@bao.vn:8080/?fbclid=1&gclid=2"
                                "&zarsrc=3") == "http://bao.vn:8080/")
    assert intel.normalize_url("https://bao.vn") == "https://bao.vn/"


def test_schema_block_no_fulltext_column():
    block = SCHEMA_SQL.split("v7.0 intel collector", 1)[1]
    assert "create table if not exists intel_items" in block
    assert not re.search(r"\b(body|content|html|raw_text)\b +text", block,
                         re.IGNORECASE)


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
        schema = f"t_intel_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.intel_items",)).fetchone()[0]
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = self.rolled_back = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        pass


def _items():
    es = intel.parse_feed(RSS)
    return intel.build_items(es, {"id": "fx-t", "tier": "A"},
                             "https://bao.example.vn/rss", TOPICS)[0]


def _count(conn, table="intel_items"):
    return conn.execute(f"select count(*) from {table}").fetchone()[0]


def test_db_store_idempotent(db):
    proxy = TxConn(db)
    r1 = intel.store_items(proxy, _items())
    assert r1 == {"new": 3, "dup_url": 0, "dup_content": 0}
    n = _count(db)
    r2 = intel.store_items(proxy, _items())
    assert r2["new"] == 0 and r2["dup_url"] == 3 and _count(db) == n
    assert proxy.committed == 2 and proxy.rolled_back == 0
    assert db.execute("select max(char_length(snippet)) from intel_items"
                      ).fetchone()[0] <= 300


def test_db_dedup_url_variants_and_content(db):
    proxy = TxConn(db)
    base = _items()[0]
    v1 = dict(base, url=intel.normalize_url(
        "https://bao.example.vn/bai/sam-gia/?utm_campaign=x"))
    v2 = dict(base, url="https://bao.example.vn/khac", title=base["title"])
    r = intel.store_items(proxy, [base, v1])
    assert r == {"new": 1, "dup_url": 1, "dup_content": 0}
    r = intel.store_items(proxy, [v2])
    assert r == {"new": 0, "dup_url": 0, "dup_content": 1}
    assert _count(db) == 1


@pytest.mark.parametrize("col,val", [("snippet", "x" * 301),
                                     ("title", "x" * 301),
                                     ("summary", "x" * 301),
                                     ("tier", "C")])
def test_db_check_constraints(db, col, val):
    row = {"url": "https://a.vn/1", "domain": "a.vn", "source": "fx-t",
           "tier": "A", "title": "t", "snippet": "s", "summary": None,
           "content_sha256": "0" * 64, "topics": ["sam"]}
    row[col] = val
    cols = ", ".join(row)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute(f"insert into intel_items ({cols}) values "
                   f"({', '.join(['%s'] * len(row))})", list(row.values()))


# ---------------------------------------------------------------- W70.5


def _no_connect(monkeypatch):
    calls = []

    def boom(dsn):
        calls.append(dsn)
        raise psycopg.OperationalError("down")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", boom)
    return calls, Spy()


def _rc(argv, **kw):
    try:
        return intel.main(argv, **kw)
    except SystemExit as e:
        return e.code


@pytest.mark.parametrize("argv", [
    ["--run", "--report"], [], ["--run", "--max-requests", "0"],
    ["--run", "--max-requests", "201"], ["--run", "--source", "khong-co"],
    ["--run", "--source", "c-shopee"], ["--run", "--source", "c-linkedin"],
    ["--report", "--source", "vnexpress-suc-khoe"]])
def test_cli_usage_exit2_before_connect(monkeypatch, capsys, argv):
    calls, spy = _no_connect(monkeypatch)
    assert _rc(argv, transport=spy) == 2
    assert calls == [] and spy.hosts == []
    if "c-shopee" in argv:
        assert "[blocked]" in capsys.readouterr().out


def test_cli_bad_config_exit1_before_connect(monkeypatch, tmp_path):
    calls, spy = _no_connect(monkeypatch)
    p = tmp_path / "s.json"
    p.write_text("{}", encoding="utf-8")
    assert intel.main(["--run", "--sources", str(p)], transport=spy) == 1
    assert calls == [] and spy.hosts == []


def test_cli_connect_error_exit1_no_network(monkeypatch):
    calls, spy = _no_connect(monkeypatch)
    assert intel.main(["--run", "--source", "vnexpress-suc-khoe"],
                      transport=spy) == 1
    assert calls and spy.hosts == []


@contextmanager
def _fake_job(name, seen):
    seen.append(name)
    run = {"ok": True}
    yield run
    seen.append(run["ok"])


def _patch_job(monkeypatch):
    seen = []
    monkeypatch.setattr(intel, "job_run", lambda n: _fake_job(n, seen))
    return seen


def test_cli_no_approved_sources_warn_exit0(db, monkeypatch, capsys):
    proxy, spy = TxConn(db), Spy()
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: proxy)
    seen = _patch_job(monkeypatch)
    assert intel.main(["--run"], transport=spy) == 0
    assert "0 nguồn đã duyệt" in capsys.readouterr().out
    assert spy.hosts == [] and seen == ["crawler.intel", True]


def test_cli_missing_table_exit1(db, monkeypatch, capsys):
    # cascade: phòng khi bảng khác có FK → intel_items (schema tạm).
    db.execute("drop table intel_items cascade")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: TxConn(db))
    spy = Spy()
    assert intel.main(["--report"], transport=spy) == 1
    assert "apply_schema" in capsys.readouterr().out and spy.hosts == []


def _site(servers, feed=None):
    feed = feed or (FIX / "site" / "feed.xml").read_bytes()
    return servers({"/robots.txt": ROBOTS_OK, "/feed.xml": (200, {}, feed),
                    "/private/feed.xml": (200, {}, feed)})


def _sources_file(tmp_path, s, llm=False, extra=()):
    cfg = json.loads((FIX / "sources_e2e.json").read_text(encoding="utf-8"))
    cfg["llm"]["enabled"] = llm
    cfg["topics"] = TOPICS
    cfg["sources"][0]["url"] = s.url("/feed.xml")
    cfg["sources"][1]["url"] = s.url("/private/feed.xml")
    cfg["sources"] += list(extra)
    p = tmp_path / "src.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    return p


def _cli(db, monkeypatch, argv, spy=None):
    proxy, spy = TxConn(db), spy or Spy()
    clk = Clock()
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: proxy)
    rc = intel.main(argv, transport=spy, sleep=clk.sleep, clock=clk.clock)
    return rc, proxy, spy


def _done(out):
    line = [ln for ln in out.splitlines() if ln.startswith("[done] ")][-1]
    return dict(kv.split("=") for kv in line.split()[1:])


def test_cli_e2e_fixture_twice(db, monkeypatch, capsys, servers, tmp_path):
    s = _site(servers)
    c = servers({"/feed.xml": (200, {}, b"x")})
    tier_c = {"id": "fx-c2", "name": "c", "tier": "C",
              "url": c.url("/feed.xml", host="localhost"), "kind": "rss",
              "status": "cho_duyet"}
    redir = servers({"/robots.txt": ROBOTS_OK, "/feed.xml": (
        302, {"Location": c.url("/feed.xml", host="localhost")}, b"")})
    to_c = {"id": "fx-redir", "name": "r", "tier": "B",
            "url": redir.url("/feed.xml"), "kind": "rss",
            "status": "cho_duyet"}
    p = _sources_file(tmp_path, s, extra=[tier_c, to_c])
    seen = _patch_job(monkeypatch)
    before = (_count(db, "content_drafts"), _count(db, "agent_action_log"))
    argv = ["--run", "--source", "fx-a", "--source", "fx-private",
            "--source", "fx-redir", "--sources", str(p)]
    rc, proxy, spy = _cli(db, monkeypatch, argv)
    out = capsys.readouterr().out
    d1 = _done(out)
    assert rc == 0 and int(d1["new"]) == 2 and d1["off_topic"] == "1"
    assert d1["robots_deny"] == "1" and d1["blocked"] == "1"
    assert "chạy thử" in out and '"reason": "tier_c"' in out
    n = _count(db)
    rc, proxy, spy2 = _cli(db, monkeypatch, argv)
    d2 = _done(capsys.readouterr().out)
    assert rc == 0 and d2["new"] == "0" and d2["dup_url"] == "2"
    assert _count(db) == n
    # Không bao giờ GET trang bài; không request tới host tầng C.
    assert not any(h.startswith("/bai/") for h in s.hits)
    assert c.hits == [] and "localhost" not in spy.hosts + spy2.hosts
    # W70.7: không đụng hàng duyệt nội dung / nhật ký hành động.
    assert (_count(db, "content_drafts"),
            _count(db, "agent_action_log")) == before
    assert seen == ["crawler.intel", True, "crawler.intel", True]
    assert proxy.committed >= 1
    db_srcs = {r[0] for r in db.execute("select source from intel_items")}
    assert db_srcs == {"fx-a"}


def test_cli_all_sources_fail_exit1(db, monkeypatch, servers, tmp_path):
    s = _site(servers)
    p = _sources_file(tmp_path, s)
    _patch_job(monkeypatch)
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-private",
                                      "--sources", str(p)])
    assert rc == 1


def test_cli_job_detail_reports_failed_source(db, monkeypatch, servers,
                                              tmp_path):
    """v7.1 W71.3: job_runs.detail mang id nguồn lỗi cho bản tin intel."""
    s = _site(servers)
    bad = servers({"/robots.txt": ROBOTS_OK,
                   "/feed.xml": (500, {}, b"loi")})
    src500 = {"id": "fx-500", "name": "x", "tier": "B",
              "url": bad.url("/feed.xml"), "kind": "rss",
              "status": "cho_duyet"}
    p = _sources_file(tmp_path, s, extra=[src500])
    runs = []

    @contextmanager
    def capture(name):
        run = {"ok": True, "detail": None}
        yield run
        runs.append((name, run))
    monkeypatch.setattr(intel, "job_run", capture)
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-a",
                                      "--source", "fx-500", "--source",
                                      "fx-private", "--sources", str(p)])
    assert rc == 0 and len(runs) == 1
    name, run = runs[0]
    detail = job_runs.clean_detail(run["detail"])
    assert name == "crawler.intel" and run["ok"] is True
    assert detail.startswith("fail=fx-500,fx-private ")
    assert "robots_deny=1" in detail and "blocked=0" in detail
    assert "http" not in detail and "127.0.0.1" not in detail


def test_cli_budget_stops(db, monkeypatch, capsys, servers, tmp_path):
    s = _site(servers)
    p = _sources_file(tmp_path, s)
    _patch_job(monkeypatch)
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-a",
                                      "--max-requests", "1",
                                      "--sources", str(p)])
    assert rc == 1 and len(s.hits) == 1
    assert "hết ngân sách" in capsys.readouterr().out


def test_cli_report(db, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: TxConn(db))
    assert intel.main(["--report"]) == 0
    assert "chưa có tin" in capsys.readouterr().out
    intel.store_items(TxConn(db), _items())
    assert intel.main(["--report"]) == 0
    out = capsys.readouterr().out
    assert "Tổng tin: 3" in out and "ruou=1" in out
    assert "https://bao.example.vn/bai/sam-gia" in out


# ---------------------------------------------------------------- W70.6


def _fake_chat(calls, reply="Tin về sâm Ngọc Linh giả bị thu giữ.", exc=None):
    def chat(agent_id, messages, **kw):
        calls.append((agent_id, json.dumps(messages, ensure_ascii=False)))
        if exc:
            raise exc
        msg = types.SimpleNamespace(content=reply)
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=msg)])
    return chat


def _llm_run(db, monkeypatch, servers, tmp_path, argv_extra, llm, **chat_kw):
    s = servers({"/robots.txt": ROBOTS_OK, "/feed.xml": (200, {}, RSS)})
    p = _sources_file(tmp_path, s, llm=llm)
    calls = []
    monkeypatch.setattr(llm_gateway, "chat", _fake_chat(calls, **chat_kw))
    _patch_job(monkeypatch)
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-a",
                                      "--sources", str(p), *argv_extra])
    return rc, calls


def test_llm_default_off(db, monkeypatch, servers, tmp_path):
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, [], llm=True)
    assert rc == 0 and calls == []
    assert db.execute("select count(*) from intel_items where summary is"
                      " not null").fetchone()[0] == 0


def test_llm_flag_but_config_off(db, monkeypatch, servers, tmp_path, capsys):
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                         llm=False)
    assert rc == 0 and calls == []
    assert "LLM tắt — chờ Pháp chế xác nhận" in capsys.readouterr().out


def test_llm_on_masked_payload_and_dedup(db, monkeypatch, servers, tmp_path):
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                         llm=True)
    assert rc == 0 and len(calls) == 3
    assert all(a == "intel" for a, _ in calls)
    payload = "".join(m for _, m in calls)
    assert "0905 123 456" not in payload and "a.b@gmail.com" not in payload
    assert db.execute("select count(*) from intel_items where summary is"
                      " not null").fetchone()[0] == 3
    rc, calls2 = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                          llm=True)
    assert rc == 0 and calls2 == []  # tin trùng → 0 gọi


def test_llm_guardrail_fail(db, monkeypatch, servers, tmp_path):
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                         llm=True, reply="Sâm giúp chữa bệnh ung thư.")
    assert rc == 0 and calls
    rows = db.execute("select summary, flags from intel_items").fetchall()
    assert rows and all(s is None and "llm_guardrail_fail" in f
                        for s, f in rows)


def test_llm_gateway_blocked_items_saved(db, monkeypatch, servers, tmp_path):
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                         llm=True, exc=llm_gateway.GatewayBlocked("cap"))
    assert rc == 0 and len(calls) == 1
    assert _count(db) == 3


# ---------------------------------------------------------------- W70.7


SRC = (ROOT / "crawler" / "intel.py").read_text(encoding="utf-8")


def test_no_path_to_content_drafts_grep():
    assert not re.search(r"content_drafts|pipelines\.store|pipelines\."
                         r"content|save_draft|connectors\.", SRC)
    writes = re.findall(r"(?:insert into|update|delete from) +([a-z_]+)",
                        SRC, re.IGNORECASE)
    assert writes and set(writes) == {"intel_items"}
    assert not re.search(r"^(import|from) +openai", SRC, re.MULTILINE)


def test_no_path_to_content_drafts_ast():
    mods = set()
    for node in ast.walk(ast.parse(SRC)):
        if isinstance(node, ast.Import):
            mods |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            mods.add(node.module)
            mods |= {f"{node.module}.{a.name}" for a in node.names}
    assert mods & {"pipelines.store", "pipelines.content", "connectors.zalo",
                   "agents.report"} == set()
    assert "pipelines.llm_gateway" in mods  # AST thật sự quét được import


# ---------------------------------------------------------------- cold-check v7.0


def test_llm_entity_decoded_before_guardrail(db, monkeypatch, servers,
                                             tmp_path):
    # strip_html giải mã entity: kiểm text thô sẽ lọt "chữa" vào summary.
    reply = "Tin tức sâm: &#99;hữa bệnh"
    assert guardrail.check(reply).get("ok") is True  # tiền đề: thô thì lọt
    assert guardrail.check(intel.clean_text(reply)).get("ok") is not True
    rc, calls = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                         llm=True, reply=reply)
    assert rc == 0 and calls
    rows = db.execute("select summary, flags from intel_items").fetchall()
    assert rows and all(s is None and "llm_guardrail_fail" in f
                        for s, f in rows)


def test_llm_summary_is_checked_string(db, monkeypatch, servers, tmp_path):
    reply = "Tin &amp; sâm <b>Ngọc Linh</b>   giả"
    rc, _ = _llm_run(db, monkeypatch, servers, tmp_path, ["--llm"],
                     llm=True, reply=reply)
    assert rc == 0
    sums = {r[0] for r in db.execute("select summary from intel_items")}
    assert sums == {intel.clean_text(reply)} == {"Tin & sâm Ngọc Linh giả"}


BAD_LINK_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title>
<item><title>Sâm Ngọc Linh link hỏng 1</title><link>http://[::1</link></item>
<item><title>Sâm Ngọc Linh link hỏng 2</title><link>http://[bad]/x</link></item>
<item><title>Sâm Ngọc Linh link hỏng 3</title><link>//[x]/</link></item>
<item><title>Sâm Ngọc Linh tin hợp lệ</title><link>/bai/hop-le</link></item>
</channel></rss>""".encode()


def test_build_items_bad_bracket_link_skipped():
    es = intel.parse_feed(BAD_LINK_RSS)
    assert len(es) == 4
    items, off = intel.build_items(es, {"id": "s", "tier": "A"},
                                   "https://bao.example.vn/rss", TOPICS)
    assert off == 0
    assert [i["url"] for i in items] == ["https://bao.example.vn/bai/hop-le"]


def test_fetch_bad_redirect_location_returns_none(servers):
    # "http://[bad]/x": httpx tự từ chối (RemoteProtocolError → None).
    # "http://a]b/x" / "http://[a/": httpx NHẬN nhưng urljoin raise
    # ValueError → phải bắt ở _get, không traceback.
    s = servers({"/robots.txt": ROBOTS_OK,
                 "/r1": (302, {"Location": "http://[bad]/x"}, b""),
                 "/r2": (302, {"Location": "http://a]b/x"}, b""),
                 "/r3": (301, {"Location": "http://[a/"}, b"")})
    clk, logs = Clock(), []
    with _fetcher(clk, logs) as f:
        for path in ("/r1", "/r2", "/r3"):
            assert f.fetch(s.url(path), "t") is None
    assert s.hits == ["/robots.txt", "/r1", "/r2", "/r3"]
    assert sum("redirect Location hỏng" in ln for ln in logs) == 2


def test_cli_bad_link_and_bad_location_run_continues(db, monkeypatch, capsys,
                                                     servers, tmp_path):
    s = _site(servers, feed=BAD_LINK_RSS)
    bad = servers({"/robots.txt": ROBOTS_OK,
                   "/feed.xml": (302, {"Location": "http://a]b/x"}, b"")})
    badloc = {"id": "fx-badloc", "name": "b", "tier": "B",
              "url": bad.url("/feed.xml"), "kind": "rss",
              "status": "cho_duyet"}
    p = _sources_file(tmp_path, s, extra=[badloc])
    seen = _patch_job(monkeypatch)
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-badloc",
                                      "--source", "fx-a", "--sources", str(p)])
    out = capsys.readouterr().out
    assert rc == 0 and "Traceback" not in out
    assert "fx-badloc: redirect Location hỏng" in out
    d = _done(out)
    assert d["ok"] == "1" and d["new"] == "1"
    assert seen == ["crawler.intel", True]
    urls = [r[0] for r in db.execute("select url from intel_items")]
    assert urls == [s.url("/bai/hop-le")]
    # Chỉ nguồn redirect hỏng → mọi nguồn fail → exit 1 (không traceback).
    rc, _, _ = _cli(db, monkeypatch, ["--run", "--source", "fx-badloc",
                                      "--sources", str(p)])
    assert rc == 1


NOW = datetime(2026, 10, 12, tzinfo=timezone.utc)


@pytest.mark.parametrize("s", [
    "9999-12-31T20:00:00+00:00", "Fri, 31 Dec 9999 23:00:00 +0000",
    "0001-01-01T00:00:00", "0001-01-01T03:00:00+05:00",
    "1999-12-31T23:00:00+00:00", "2026-10-14T01:00:00+00:00",
    "2030-01-01T00:00:00Z",
    # Trường số tràn C long/int → OverflowError (không phải ValueError).
    "Fri, 31 Dec 2147483648 23:00:00 +0000",
    "Fri, 31 Dec 2026 99999999999999999999:00:00 +0000",
    "Fri, 31 Dec 2026 23:00:99999999999999999999 +0000",
    "Fri, 99999999999999999999 Dec 2026 23:00:00 +0000",
    "Fri, 31 Dec 2026 23:00:00 +99999999999999999999"])
def test_parse_date_out_of_window_none(s):
    assert intel.parse_date(s, now=NOW) is None


@pytest.mark.parametrize("s,want", [
    ("2000-01-01T00:00:00+00:00", "2000-01-01 00:00:00+00:00"),
    ("2026-10-13T23:00:00+00:00", "2026-10-13 23:00:00+00:00"),
    ("Mon, 12 Oct 2026 08:00:00 +0700", "2026-10-12 08:00:00+07:00")])
def test_parse_date_in_window_kept(s, want):
    assert str(intel.parse_date(s, now=NOW)) == want


OVERFLOW_DATE_RSS = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>t</title>
<item><title>Sâm Ngọc Linh ngày độc</title><link>/bai/ngay-doc</link>
<pubDate>Fri, 31 Dec 2147483648 23:00:00 +0000</pubDate></item>
<item><title>Sâm Ngọc Linh tin hợp lệ</title><link>/bai/hop-le</link>
<pubDate>Mon, 12 Oct 2026 08:00:00 +0700</pubDate></item>
</channel></rss>""".encode()


def test_build_items_overflow_pubdate_does_not_kill_run():
    # 1 pubDate tràn int không được raise ra khỏi build_items (giết cả
    # lượt run); entry đó giữ với published_at None, entry sau vẫn giữ.
    es = intel.parse_feed(OVERFLOW_DATE_RSS)
    items, off = intel.build_items(es, {"id": "s", "tier": "A"},
                                   "https://bao.example.vn/rss", TOPICS)
    assert off == 0
    assert [i["url"] for i in items] == [
        "https://bao.example.vn/bai/ngay-doc",
        "https://bao.example.vn/bai/hop-le"]
    assert items[0]["published_at"] is None
    assert str(items[1]["published_at"]) == "2026-10-12 08:00:00+07:00"


def test_report_overflow_date_row_no_crash(db, monkeypatch, capsys):
    # Dòng cũ (trước khi chặn ngày) có published_at năm 9999 → '?' thay vì
    # OverflowError ở astimezone(VN_TZ).
    db.execute("set local timezone = 'UTC'")
    it = _items()[0]
    it["published_at"] = datetime(9999, 12, 31, 20, tzinfo=timezone.utc)
    intel.store_items(TxConn(db), [it])
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: TxConn(db))
    assert intel.main(["--report"]) == 0
    out = capsys.readouterr().out
    assert "  ? [fx-t]" in out


def test_gzip_bomb_decompress_capped(servers, monkeypatch):
    # Bomb 5MB 0-byte: KHÔNG có max_length thì vẫn ra too_large ở hậu kiểm
    # → phải spy chứng minh decompress bị chặn ở cap+1 (không bung hết).
    cap = intel.MAX_BYTES
    seen = []
    real = zlib.decompressobj

    def spy_obj(*a, **kw):
        d = real(*a, **kw)

        class W:
            def decompress(self, data, max_length=0):
                out = d.decompress(data, max_length)
                seen.append((max_length, len(out)))
                return out
        return W()
    monkeypatch.setattr(intel, "zlib", types.SimpleNamespace(
        decompressobj=spy_obj, MAX_WBITS=zlib.MAX_WBITS, error=zlib.error))
    s = servers({"/robots.txt": ROBOTS_OK,
                 "/bomb": (200, {"Content-Encoding": "gzip"},
                           gzip.compress(b"\0" * 5_000_000))})
    with _fetcher(Clock(), []) as f:
        r = f.fetch(s.url("/bomb"), "t")
    assert r.status == "too_large" and r.body is None
    assert seen and all(m == cap + 1 and n <= cap + 1 for m, n in seen)


class StepClock(Clock):
    """Mỗi lần đọc clock trôi `step` giây (server nhỏ giọt)."""

    def __init__(self, step):
        super().__init__()
        self.step = step

    def clock(self):
        self.now += self.step
        return self.now


def _drip(h):
    h.send_response(200)
    h.end_headers()
    for _ in range(5):  # >64KiB/lần → httpx chắc chắn nhận ≥2 chunk
        h.wfile.write(b"x" * 70_000)
        h.wfile.flush()


def test_total_timeout_slow_drip(servers):
    s = servers({"/robots.txt": ROBOTS_OK, "/drip": _drip})
    clk, logs = StepClock(20.0), []
    with _fetcher(clk, logs) as f:
        r = f.fetch(s.url("/drip"), "t")
    assert r.status == "timeout" and r.body is None
    st = {q["url"].rsplit("/", 1)[-1]: q for q in _reqs(logs)}
    assert st["robots.txt"]["status"] == 200
    assert st["drip"]["status"] == "timeout"
    assert 0 < st["drip"]["bytes"] < 350_000
