"""v6.5 W65.4 — `agents.seo_web` (MKT-10): rà SEO website CỦA CÔNG TY, chỉ đọc.

- from-crawl: fixture jsonl tmp, Fetcher bị monkeypatch raise → 0 request.
- fetch: `httpx.MockTransport` + `sleep`/`clock` tiêm (không wall-clock) —
  chỉ GET, robots trước, robots Disallow tôn trọng, ≥1s/host theo clock giả,
  ngân sách, host ngoài own_hosts / redirect ra ngoài → 0 request.
- submit: DB thật schema tạm + ROLLBACK (precedent test_cockpit), `_TxConn`.
"""

import itertools
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import psycopg
import pytest

from agents import seo_web as sw

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
VN = timezone(timedelta(hours=7))
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
A = "https://samsam.net.vn"
B = "https://samsamngoclinh.com"


def _jsonl(path: Path, recs):
    path.write_bytes(b"".join(
        (r if isinstance(r, bytes) else json.dumps(r, ensure_ascii=False)
         .encode("utf-8")) + b"\n" for r in recs))


def _crawl(tmp_path: Path) -> Path:
    _jsonl(tmp_path / "products.jsonl", [
        {"id": "p1", "name": "Saphraton 20 viên", "description": "Hộp 20 viên",
         "url": f"{B}/san-pham/saphraton-20/", "images": [f"{B}/a.webp"]},
        {"id": "p2", "name": "saphraton 20 VIÊN ", "description": "Hộp",
         "url": f"{B}/san-pham/saphraton-20-b/", "images": []},
        {"id": "p3", "name": "Sapentol", "description": "Mô tả",
         "url": "https://evilsamsam.net.vn/x", "images": ["x"]},
        {"_doc": "ghi chú"},
        b"{hong",
    ])
    _jsonl(tmp_path / "articles.jsonl", [
        {"id": "a1", "title": "T" * 61, "body": "Bài viết bình thường",
         "url": f"{A}/vi/news/a1.html"},
        {"id": "a2", "title": "", "body": "Sâm giúp chữa bệnh",
         "url": f"{A}/vi/news/chua-benh.html"},
        {"id": "a3", "title": "Saphraton 20 viên", "body": "x",
         "url": f"{A}/vi/news/a3.html"},          # khác host p1 → không trùng
        {"id": "a4", "title": "Ngoài", "body": "x",
         "url": "https://example.com/a4"},
    ])
    return tmp_path


def _rules():
    return sw.load_rules()


def test_rules_and_is_own():
    r = _rules()
    assert r["web"]["own_hosts"] == ["samsam.net.vn", "samsamngoclinh.com"]
    assert sw.is_own("samsam.net.vn", r["web"]["own_hosts"])
    assert sw.is_own("www.samsamngoclinh.com", r["web"]["own_hosts"])
    assert not sw.is_own("evilsamsam.net.vn", r["web"]["own_hosts"])
    assert not sw.is_own("samsam.net.vn.evil.com", r["web"]["own_hosts"])
    assert not sw.is_own("", r["web"]["own_hosts"])


def test_rules_validation(tmp_path):
    good = json.loads((ROOT / "data" / "seo_rules.json").read_bytes()
                      .decode("utf-8"))
    for mut in (lambda d: d["web"].update(max_requests=0),
                lambda d: d["web"].update(max_requests=201),
                lambda d: d["web"].update(own_hosts=[]),
                lambda d: d["web"].update(desc_min=200),
                lambda d: d.pop("san"),
                lambda d: d["san"].update(title_sep="")):
        d = json.loads(json.dumps(good))
        mut(d)
        p = tmp_path / "r.json"
        p.write_text(json.dumps(d), encoding="utf-8")
        with pytest.raises(sw.SeoRulesError):
            sw.load_rules(p)
    assert "GIẢ ĐỊNH" in good["_doc"]


def test_from_crawl_zero_requests(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("from-crawl không được tạo Fetcher")

    monkeypatch.setattr(sw, "OwnFetcher", boom)
    monkeypatch.setattr(sw, "Fetcher", boom)
    monkeypatch.setattr(httpx.Client, "send", boom)
    res = sw.run(mode="from-crawl", data_dir=_crawl(tmp_path), now=NOW)
    st = res["stats"]
    assert st["requests"] == 0
    assert st["external"] == 2 and st["bad"] == 2 and st["pages"] == 5
    by = {}
    for it in res["issues"]:
        by.setdefault(it["code"], []).append(it)
    assert {i["url"] for i in by["title_trung"]} == {
        f"{B}/san-pham/saphraton-20/", f"{B}/san-pham/saphraton-20-b/"}
    assert [i["url"] for i in by["title_dai"]] == [f"{A}/vi/news/a1.html"]
    assert by["title_dai"][0]["detail"] == {"ky_tu": 61}
    assert [i["url"] for i in by["title_thieu"]] == [
        f"{A}/vi/news/chua-benh.html"]
    assert [i["url"] for i in by["sp_khong_anh"]] == [
        f"{B}/san-pham/saphraton-20-b/"]
    g = by["guardrail"][0]
    assert g["url"] == f"{A}/vi/news/chua-benh.html"
    assert "banned_word" in g["detail"]["types"]
    assert "tu_cam" in g["detail"]["codes"]
    assert by["url_guardrail"][0]["url"] == f"{A}/vi/news/chua-benh.html"
    # không trích text vi phạm vào issue/report
    assert "chữa" not in json.dumps(res["issues"], ensure_ascii=False)
    assert "Sâm giúp chữa" not in res["text"]
    assert "chưa kiểm — cần `--fetch`" in res["text"]
    assert "evilsamsam" not in res["text"] and "example.com" not in res["text"]


def test_payload_no_violating_text_and_guardrail_ok(tmp_path):
    res = sw.run(mode="from-crawl", data_dir=_crawl(tmp_path), now=NOW)
    p = sw.build_payload(res["day"], "from-crawl", res["issues"])
    assert "chữa" not in p and "chua-benh" not in p
    assert sw.guardrail.check(p)["ok"] is True
    d = json.loads(p)
    assert d["so_van_de"] == len(res["issues"])
    assert all(set(x) == {"url", "code", "chi_tiet", "de_xuat"}
               for x in d["van_de"])


# ------------------------------------------------------------ fetch

PAGE_A = b"""<html><head><title>Trang A</title></head><body>
<img src="/1.jpg"><img src="/2.jpg" alt="  "><img src="/3.jpg" alt="sam">
<a href="/vi/b.html">b</a><a href="/vi/c.html">c</a>
<a href="https://samsam.net.vn/vi/a.html#top">self</a>
<a href="https://evil.example/x">ngoai</a><a href="mailto:x@y.z">m</a>
</body></html>"""
PAGE_P = (b"<html><head><title>Trang A</title><meta name='Description' "
          b"content='" + ("m" * 80).encode() + b"'></head><body><h1>x</h1>"
          b"<h1>y</h1></body></html>")
PAGE_D = (b"<html><head><title> Trang a </title><meta name='description' "
          b"content='" + ("d" * 200).encode() + b"'></head><body><h1>x</h1>"
          b"</body></html>")


class _Net:
    """MockTransport + clock giả: sleep cộng dồn clock, ghi (method, url,
    host, t) từng request."""

    def __init__(self, routes):
        self.routes = routes
        self.t = 0.0
        self.slept = 0.0
        self.reqs = []

    def clock(self):
        return self.t

    def sleep(self, s):
        self.slept += s
        self.t += s

    def handler(self, request):
        self.reqs.append((request.method, str(request.url),
                          request.url.host, self.t))
        self.t += 0.05                         # thời gian xử lý giả
        st, body, hdr = self.routes.get(str(request.url), (404, b"", {}))
        # stream (không content=) — Fetcher đọc qua iter_raw có trần.
        return httpx.Response(st, stream=httpx.ByteStream(body), headers=hdr)

    def fetcher(self, own, budget):
        return sw.OwnFetcher(own, budget=budget,
                             transport=httpx.MockTransport(self.handler),
                             sleep=self.sleep, clock=self.clock,
                             log=lambda s: None)


def _routes():
    return {
        f"{A}/robots.txt": (200, b"User-agent: *\nDisallow: /private\n", {}),
        f"{A}/vi/a.html": (200, PAGE_A, {}),
        f"{A}/vi/b.html": (404, b"", {}),
        f"{A}/private/x.html": (200, b"<html></html>", {}),
        f"{A}/vi/r.html": (301, b"", {"location": "https://evil.example/x"}),
        f"{A}/vi/d.html": (200, PAGE_D, {}),
        f"{B}/robots.txt": (404, b"", {}),
        f"{B}/p/": (200, PAGE_P, {}),
    }


def _fetch_crawl(tmp_path):
    _jsonl(tmp_path / "articles.jsonl", [
        {"title": "a", "body": "x", "url": f"{A}/vi/a.html"},
        {"title": "b", "body": "x", "url": f"{A}/vi/b.html"},
        {"title": "p", "body": "x", "url": f"{A}/private/x.html"},
        {"title": "r", "body": "x", "url": f"{A}/vi/r.html"},
        {"title": "d", "body": "x", "url": f"{A}/vi/d.html"},
        {"title": "e", "body": "x", "url": "https://evilsamsam.net.vn/e"},
        {"title": "q", "body": "x", "url": f"{B}/p/"},
    ])
    return tmp_path


def test_fetch_get_only_robots_delay_and_html_checks(tmp_path):
    net = _Net(_routes())
    res = sw.run(mode="fetch", data_dir=_fetch_crawl(tmp_path), now=NOW,
                 max_requests=40,
                 fetcher_factory=lambda n: net.fetcher(
                     _rules()["web"]["own_hosts"], n))
    assert net.reqs and all(m == "GET" for m, *_ in net.reqs)
    hosts = [h for _, _, h, _ in net.reqs]
    assert "evilsamsam.net.vn" not in hosts and "evil.example" not in hosts
    # request đầu mỗi origin là /robots.txt
    first = {}
    for _, url, h, _ in net.reqs:
        first.setdefault(h, url)
    assert first == {"samsam.net.vn": f"{A}/robots.txt",
                     "samsamngoclinh.com": f"{B}/robots.txt"}
    assert f"{A}/private/x.html" not in [u for _, u, _, _ in net.reqs]
    # ≥1s giữa 2 lần bắt đầu request cùng host (clock giả)
    for h in set(hosts):
        ts = [t for _, _, hh, t in net.reqs if hh == h]
        assert all(b - a >= 1.0 - 1e-9
                   for a, b in itertools.pairwise(ts)), (h, ts)
    assert net.slept > 0
    st = res["stats"]
    assert st["robots_cam"] == 1 and st["blocked"] == 1
    assert st["requests"] == len(net.reqs)
    by = {}
    for it in res["issues"]:
        by.setdefault(it["code"], []).append(it)
    a = f"{A}/vi/a.html"
    assert [i["url"] for i in by["meta_desc_thieu"]] == [a]
    h1 = {i["url"]: i["detail"]["h1"] for i in by["h1_khong_bang_1"]}
    assert h1 == {a: 0, f"{B}/p/": 2}
    assert by["img_thieu_alt"][0]["detail"] == {"anh": 2, "tong": 3}
    assert by["link_gay"] == [{"url": a, "code": "link_gay", "detail": {
        "toi": f"{A}/vi/b.html", "status": 404}}]
    assert st["link_chua_kiem"] == 1                 # /vi/c.html
    # <title> trùng trong cùng host (khác host "Trang A" của B không tính)
    assert {i["url"] for i in by["html_title_trung"]} == {a, f"{A}/vi/d.html"}
    assert [i["url"] for i in by["trang_loi"]] == [f"{A}/vi/b.html"]
    assert [i["url"] for i in by["meta_desc_dai"]] == [f"{A}/vi/d.html"]
    assert "meta_desc_ngan" not in by and "meta_desc_trung" not in by


def test_fetch_budget_caps_requests(tmp_path):
    net = _Net(_routes())
    res = sw.run(mode="fetch", data_dir=_fetch_crawl(tmp_path), now=NOW,
                 max_requests=3,
                 fetcher_factory=lambda n: net.fetcher(
                     _rules()["web"]["own_hosts"], n))
    assert len(net.reqs) <= 3
    assert res["stats"]["het_ngan_sach"] >= 1


def test_fetch_only_external_hosts_zero_requests(tmp_path):
    _jsonl(tmp_path / "news.jsonl", [
        {"title": "e", "body": "x", "url": "https://evilsamsam.net.vn/e"},
        {"title": "f", "body": "x", "url": "http://example.com/"}])
    net = _Net(_routes())
    res = sw.run(mode="fetch", data_dir=tmp_path, now=NOW,
                 fetcher_factory=lambda n: net.fetcher(
                     _rules()["web"]["own_hosts"], n))
    assert net.reqs == [] and res["stats"]["requests"] == 0
    assert res["stats"]["external"] == 2


def test_no_write_path_in_module():
    src = (ROOT / "agents" / "seo_web.py").read_text(encoding="utf-8")
    for bad in (".post(", ".put(", ".patch(", ".delete(", "import httpx",
                "import requests", "wp-json"):
        assert bad not in src, bad


# ------------------------------------------------------------ CLI

def test_cli_two_modes_exit2_before_connect(monkeypatch):
    monkeypatch.setattr(sw, "connect",
                        lambda: pytest.fail("không được connect"))
    with pytest.raises(SystemExit) as e:
        sw.main(["--from-crawl", "--fetch"], now=NOW)
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        sw.main(["--max-requests", "3"], now=NOW)
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        sw.main(["--fetch", "--max-requests", "0"], now=NOW)
    assert e.value.code == 2


def test_cli_from_crawl_writes_report_vn_day(tmp_path, monkeypatch, capsys):
    _crawl(tmp_path)
    monkeypatch.setattr(sw, "connect",
                        lambda: pytest.fail("không --submit → không DB"))
    late = datetime(2026, 10, 12, 18, 30, tzinfo=timezone.utc)  # 13/10 VN
    out = tmp_path / "rep"
    real_run = sw.run
    monkeypatch.setattr(sw, "run", lambda **k: real_run(
        **{**k, "data_dir": tmp_path}))
    assert sw.main(["--out-dir", str(out)], now=late) == 0
    assert (out / "seo-web-2026-10-13.md").exists()
    assert "requests=0" in capsys.readouterr().out


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
        schema = f"t_w65w_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def close(self):
        pass


def test_submit_queue_marketing_pending_then_skipped(db, tmp_path):
    res = sw.run(mode="from-crawl", data_dir=_crawl(tmp_path), now=NOW)
    tc = _TxConn(db)
    out = sw.submit(tc, res["day"], "from-crawl", res["issues"])
    assert out["status"] == "created"
    row = db.execute(
        "select block, object_type, object_id, status, created_by,"
        " guardrail->>'ok', risk, payload from approval_queue").fetchall()
    assert len(row) == 1
    blk, ot, oid, st, by, ok, risk, payload = row[0]
    assert (blk, ot, st, by, ok, risk) == ("marketing", "seo_web_fix",
                                           "pending", "agent:MKT-10", "true",
                                           "medium")
    assert oid.startswith("seo-web:2026-10-12:") and len(oid) == 35
    assert "chữa" not in payload
    assert tc.committed >= 1
    again = sw.submit(tc, res["day"], "from-crawl", res["issues"])
    assert again["status"] == "skipped"
    assert db.execute("select count(*) from approval_queue").fetchone()[0] \
        == 1
