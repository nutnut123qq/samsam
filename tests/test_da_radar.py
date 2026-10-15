"""v8.3 W83.2–W83.3 — DA-03 radar chương trình.

W83.2: nguồn `chuong_trinh` trong `data/intel_sources.json` (tầng A/B,
`cho_duyet`) + E2E qua CHÍNH collector v7.0 (`crawler.intel.main`) với
server local, Spy transport, Clock giả: 0 request tầng C/sàn, 0 request
path robots cấm, nhịp ≥1s/host.
W83.3: `deadline_of`/`organizer_of`/`reminders` thuần; `scan` → `programs`
(bỏ rượu, bỏ host tầng C, idempotent); `da_radar` không tự ra mạng; CLI.
DB thật trong schema tạm + ROLLBACK.
"""

import json
import re
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from agents import da_radar
from crawler import intel
from tests.test_da_schema import TxConn, da_db
from tests.test_intel import Clock, Server, Spy, _reqs

ROOT = Path(__file__).resolve().parent.parent
FEED = (ROOT / "tests" / "fixtures" / "du_an" / "feed_chuong_trinh.xml"
        ).read_bytes()
VN = timezone(timedelta(hours=7))
CFG, _ERRS = intel.load_sources(ROOT / "data" / "intel_sources.json")
PUB = datetime(2026, 10, 12, 9, tzinfo=VN)


@pytest.fixture
def db():
    yield from da_db()


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


@contextmanager
def _fake_job(name, seen):
    seen.append(name)
    run = {"ok": True, "detail": None}
    yield run
    seen.append(run["ok"])


# ---------------------------------------------------------------- W83.2


def test_real_sources_chuong_trinh():
    assert _ERRS == [] and CFG is not None
    assert "chuong_trinh" in CFG["topics"]
    ct = [s for s in CFG["sources"]
          if "chuong_trinh" in s.get("topics_hint", [])]
    assert len(ct) >= 4
    for s in ct:
        assert s["tier"] in ("A", "B") and s["status"] == "cho_duyet", s["id"]
        assert "CHƯA xác minh" in s["note"] and "GĐ dự án" in s["note"]
        assert not intel.is_blocked(s["url"], intel.tier_c_hosts(CFG))
    assert "DA-03 (v8.3)" in CFG["_doc"] and "chờ GĐ dự án duyệt" in CFG["_doc"]


@pytest.mark.parametrize("title,hit", [
    ("Hội chợ xúc tiến thương mại Đà Nẵng 2026", True),
    ("hoi cho xuc tien thuong mai da nang", True),
    ("Chương trình OCOP tỉnh nhận hồ sơ", True),
    ("Săm lốp giảm giá", False),
    ("Giá vàng hôm nay", False),
])
def test_classify_chuong_trinh(title, hit):
    assert ("chuong_trinh" in intel.classify(title, "", CFG["topics"])[0]) \
        is hit


def _e2e_sources(tmp_path, s, c_url):
    cfg = {"_doc": "fixture v8.3", "llm": {"enabled": False},
           "topics": CFG["topics"], "sources": [
               {"id": "fx-ct", "name": "ct", "tier": "A",
                "url": s.url("/feed.xml"), "kind": "rss",
                "status": "cho_duyet"},
               {"id": "fx-admin", "name": "robots cấm", "tier": "B",
                "url": s.url("/admin/feed.xml"), "kind": "rss",
                "status": "cho_duyet"},
               {"id": "fx-c", "name": "tầng C", "tier": "C", "url": c_url,
                "kind": "rss", "status": "cho_duyet"},
               {"id": "fx-shopee", "name": "sàn", "tier": "B",
                "url": "https://shopee.vn/feed.xml", "kind": "rss",
                "status": "cho_duyet"}]}
    p = tmp_path / "src.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    return p, cfg


def _collect(db, monkeypatch, capsys, servers, tmp_path):
    robots = (200, {}, b"User-agent: *\nDisallow: /admin/\n")
    s = servers({"/robots.txt": robots, "/feed.xml": (200, {}, FEED),
                 "/admin/feed.xml": (200, {}, FEED)})
    c = servers({"/feed.xml": (200, {}, FEED)})
    p, cfg = _e2e_sources(tmp_path, s, c.url("/feed.xml", host="localhost"))
    spy, clk, seen = Spy(), Clock(), []
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(intel, "_connect", lambda _d: TxConn(db))
    monkeypatch.setattr(intel, "job_run", lambda n: _fake_job(n, seen))
    rc = intel.main(["--run", "--source", "fx-ct", "--source", "fx-admin",
                     "--source", "fx-shopee", "--sources", str(p)],
                    transport=spy, sleep=clk.sleep, clock=clk.clock)
    out = capsys.readouterr().out
    return rc, out, s, c, spy, cfg


def test_e2e_collector_only_ab_robots_pacing(db, monkeypatch, capsys,
                                             servers, tmp_path):
    rc, out, s, c, spy, _ = _collect(db, monkeypatch, capsys, servers,
                                     tmp_path)
    assert rc == 0
    # 0 request tầng C (localhost) / sàn (shopee) — chặn trước request.
    assert c.hits == []
    assert not [h for h in spy.hosts if h in ("localhost", "shopee.vn")]
    assert '"reason": "hard"' in out and "[robots-deny]" in out
    # 0 request path robots cấm; không bao giờ GET trang bài.
    assert not [h for h in s.hits if h.startswith("/admin/")]
    assert not [h for h in s.hits if h.startswith("/ct/")]
    reqs = _reqs(out.splitlines())
    assert reqs and {q["host"] for q in reqs} == {"127.0.0.1"}
    gaps = [q["gap_s"] for q in reqs if q["gap_s"] is not None]
    assert gaps and all(g >= 1.0 for g in gaps)
    rows = db.execute("select title, topics, flags from intel_items"
                      " order by id").fetchall()
    ct = [r for r in rows if "chuong_trinh" in r[1]]
    assert len(ct) == 3 and len(rows) == 3          # tin lạc đề không lưu
    assert sum("ruou" in r[2] for r in ct) == 1


def test_cli_tier_c_source_exit2_no_request(monkeypatch, tmp_path, servers):
    s = servers({"/feed.xml": (200, {}, FEED)})
    p, _ = _e2e_sources(tmp_path, s, s.url("/feed.xml", host="localhost"))
    spy = Spy()
    monkeypatch.setattr(intel, "_connect", lambda _d: pytest.fail("connect"))
    assert intel.main(["--run", "--source", "fx-c", "--sources", str(p)],
                      transport=spy) == 2
    assert spy.hosts == [] and s.hits == []


# ---------------------------------------------------------------- W83.3 pure


@pytest.mark.parametrize("text,pub,want", [
    ("Hạn đăng ký: 25/10/2026", PUB, date(2026, 10, 25)),
    ("đăng ký trước ngày 5/11", PUB, date(2026, 11, 5)),
    ("hạn chót 10/01", datetime(2026, 12, 20, tzinfo=VN), date(2027, 1, 10)),
    ("giá 10.050.000 đồng, hạn 30/11/2026", PUB, date(2026, 11, 30)),
    ("phí 1.500.000 đ", PUB, None),
    ("hạn 31/02/2026", PUB, None),
    ("diễn ra 20-22/11/2026", PUB, None),
    ("giai đoạn 2025-2026", PUB, None),
    ("han dang ky 15/11/2026", PUB, date(2026, 11, 15)),
    ("Hạn đăng ký sẽ công bố sau. Khai mạc 20/11/2026", PUB, None),
    ("Hạn đăng ký 25/10/2026; hạn bổ sung 30/10/2026", PUB,
     date(2026, 10, 25)),
    ("HẠN CHÓT 01.11.2026", PUB, date(2026, 11, 1)),
    ("deadline 3-11-2026", PUB, date(2026, 11, 3)),
    ("Sâm Hàn Quốc 25/10/2026", PUB, None),
    ("hạn 20-22/11/2026", PUB, None),
    ("đến hết ngày 5/11 (liên hệ ***)", PUB, date(2026, 11, 5)),
    ("hạn 5/11", None, None),
    # "hạn" trần khác nghĩa → KHÔNG phải hạn nộp (ngày sự kiện/khai mạc).
    ("hạn chế 200 gian hàng, khai mạc 20/11/2026", PUB, None),
    ("HẠN CHẾ số lượng, GIỚI HẠN 20/11/2026", PUB, None),
    ("Số gian hàng có giới hạn, diễn ra từ 20/11/2026", PUB, None),
    ("Thời hạn 3 ngày từ 20/11/2026", PUB, None),
    ("Hỗ trợ vùng hạn hán, khai mạc 20/11/2026", PUB, None),
    ("hạn mức 50 gian, mở 20/11/2026", PUB, None),
    ("Công ty trách nhiệm hữu hạn MẪU tổ chức ngày 20/11/2026", PUB, None),
    ("Sam Han Quoc khai mac 25/10/2026", PUB, None),   # không dấu
    ("han: 15/11/2026", PUB, date(2026, 11, 15)),
    ("han den ngay 15/11/2026", PUB, date(2026, 11, 15)),
    # khoảng "từ X đến Y" / "X - Y" sau từ khóa hạn → lấy Y.
    ("Thời hạn đăng ký: từ 01/10/2026 đến 05/11/2026", PUB,
     date(2026, 11, 5)),
    ("Hạn nộp hồ sơ từ 01/11 đến 10/11", PUB, date(2026, 11, 10)),
    ("hạn 01/11/2026 - 05/11/2026", PUB, date(2026, 11, 5)),
    ("Gia hạn đăng ký đến 30/11/2026", PUB, date(2026, 11, 30)),
    ("hạn đến ngày 30/11/2026", PUB, date(2026, 11, 30)),
    ("Hạn đăng ký 25/10/2026, đến 30/10 bổ sung", PUB, date(2026, 10, 25)),
])
def test_deadline_of(text, pub, want):
    got, snip = da_radar.deadline_of(text, pub)
    assert got == want
    assert (snip is None) is (want is None)
    if snip:
        assert len(snip) <= 120


def test_deadline_text_shows_range_end():
    got, snip = da_radar.deadline_of(
        "Thời hạn đăng ký: từ 01/10/2026 đến 05/11/2026. Khai mạc 20/11", PUB)
    assert got == date(2026, 11, 5)
    assert snip == "hạn đăng ký: từ 01/10/2026 đến 05/11/2026"


@pytest.mark.parametrize("text,want", [
    ("Hội chợ do Sở Công Thương Đà Nẵng tổ chức từ 20/11",
     "Sở Công Thương Đà Nẵng"),
    ("Chương trình bởi UBND TP Đà Nẵng phối hợp với VCCI", "UBND TP Đà Nẵng"),
    ("do Cục Xúc tiến thương mại, Bộ Công Thương chủ trì",
     "Cục Xúc tiến thương mại"),
    ("Hội chợ OCOP 2026", "chưa công bố"),
    ("do " + "Sở " + "x" * 300, "chưa công bố"),
    (None, "chưa công bố"),
])
def test_organizer_of(text, want):
    got = da_radar.organizer_of(text)
    assert got == want and len(got) <= 120


def _p(i, dl, seen):
    return {"id": i, "title": f"P{i}", "deadline": dl,
            "first_seen": datetime(seen.year, seen.month, seen.day, 8,
                                   tzinfo=VN)}


def test_reminders_cases():
    r = da_radar.reminders([_p(1, date(2026, 10, 25), date(2026, 10, 12))],
                           date(2026, 10, 12))
    assert [(x["remind_on"], x["kind"]) for x in r] == [
        (date(2026, 10, 18), "T-7"), (date(2026, 10, 23), "T-2")]
    r = da_radar.reminders([_p(2, date(2026, 10, 16), date(2026, 10, 13))],
                           date(2026, 10, 13))
    assert [(x["remind_on"], x["kind"]) for x in r] == [
        (date(2026, 10, 13), "phat_hien_muon"), (date(2026, 10, 14), "T-2")]
    r = da_radar.reminders([_p(3, date(2026, 10, 12), date(2026, 10, 12))],
                           date(2026, 10, 12))
    assert [(x["remind_on"], x["kind"]) for x in r] == [
        (date(2026, 10, 12), "phat_hien_muon")]
    # hạn đã qua → không nhắc; không hạn → mục chưa công bố hạn
    assert da_radar.reminders([_p(4, date(2026, 10, 1), date(2026, 9, 1))],
                              date(2026, 10, 12)) == []
    r = da_radar.reminders([_p(5, None, date(2026, 10, 12))],
                           date(2026, 10, 12))
    assert [x["kind"] for x in r] == ["chua_cong_bo_han"]


def test_render_list_draft_banner():
    progs = [{**_p(1, date(2026, 10, 25), date(2026, 10, 12)),
              "organizer": "Sở A", "url": "https://a.vn/x|y",
              "source": "fx", "deadline_text": "Hạn đăng ký: 25/10/2026"},
             {**_p(2, None, date(2026, 10, 12)), "organizer": "chưa công bố",
              "url": "https://a.vn/2", "source": "fx"}]
    md = da_radar.render_list(progs, date(2026, 10, 18))
    assert "BẢN NHÁP — KHÔNG tự đăng ký/gửi" in md
    assert "25/10/2026" in md and "còn 7 ngày" in md
    assert "https://a.vn/x\\|y" in md and "## Chưa công bố hạn" in md
    row = next(ln for ln in md.splitlines() if ln.startswith("| 1 |"))
    assert "Trích hạn" in md and "| Hạn đăng ký: 25/10/2026 |" in row


# ---------------------------------------------------------------- W83.3 DB


def _insert_item(db, url, tier="B", topics=("chuong_trinh",), flags=(),
                 title="Hội chợ MẪU"):
    db.execute("insert into intel_items (url, domain, source, tier, title,"
               " content_sha256, topics, flags) values (%s, 'x', 'fx', %s,"
               " %s, encode(sha256(convert_to(%s, 'UTF8')), 'hex'), %s, %s)",
               (url, tier, title, url, list(topics), list(flags)))


def test_scan_after_e2e(db, monkeypatch, capsys, servers, tmp_path):
    _collect(db, monkeypatch, capsys, servers, tmp_path)
    _, _, _, _, _, cfg = _collect(db, monkeypatch, capsys, servers, tmp_path)
    _insert_item(db, "https://shopee.vn/x")
    _insert_item(db, "http://localhost:9/x", tier="A")
    _insert_item(db, "https://m.facebook.com/hoi-cho")
    logs = []
    proxy = TxConn(db)
    st = da_radar.scan(proxy, cfg=cfg, log=logs.append)
    assert st["inserted"] == 2 and st["skipped_ruou"] == 1
    assert st["blocked"] == 3 and len(logs) == 3
    assert all(ln.startswith("[blocked] ") for ln in logs)
    assert proxy.committed == 1
    rows = db.execute("select title, deadline, organizer, url from programs"
                      " order by id").fetchall()
    assert len(rows) == 2
    hc = next(r for r in rows if "Hội chợ Tết" in r[0])
    oc = next(r for r in rows if "OCOP" in r[0])
    assert hc[1] == date(2026, 11, 25) and hc[2] == "Sở Công Thương Đà Nẵng"
    assert oc[1] is None and oc[2] == "chưa công bố"
    assert not [r for r in rows if "rượu" in r[0].lower()
                or "shopee" in r[3] or "localhost" in r[3]]
    n = db.execute("select count(*) from programs").fetchone()[0]
    st2 = da_radar.scan(proxy, cfg=cfg, log=logs.append)
    assert st2["inserted"] == 0 and st2["dup"] == 2
    assert db.execute("select count(*) from programs").fetchone()[0] == n
    dry = da_radar.scan(proxy, cfg=cfg, dry_run=True, log=logs.append)
    assert dry["inserted"] == 0 and dry["dup"] == 2


def test_scan_dry_run_no_write_and_since_days(db):
    _insert_item(db, "https://a.vn/1")
    st = da_radar.scan(TxConn(db), cfg=CFG, dry_run=True)
    assert st["inserted"] == 1
    assert db.execute("select count(*) from programs").fetchone()[0] == 0
    old = datetime.now(VN) + timedelta(days=40)
    assert da_radar.scan(TxConn(db), cfg=CFG, now=old)["seen"] == 0


def test_radar_never_opens_network(db, monkeypatch, tmp_path):
    def boom(*a, **kw):
        raise AssertionError("da_radar không được mở kết nối mạng")
    monkeypatch.setattr(httpx.Client, "__init__", boom)
    _insert_item(db, "https://a.vn/1", title="Hội chợ MẪU hạn 25/12/2026")
    st = da_radar.scan(TxConn(db), cfg=CFG)
    assert st["inserted"] == 1
    # first_seen mặc định = now() thật của DB → cố định để test không phụ
    # thuộc đồng hồ (sau 18/12 thật, 25/12 − first_seen < 7 → "phát hiện
    # muộn", mất nhắc T-7).
    db.execute("update programs set first_seen = '2026-10-12 10:00+07'")
    monkeypatch.setattr(da_radar, "connect", lambda: TxConn(db))
    assert da_radar.main(["--list", "--date", "2026-12-18", "--out-dir",
                          str(tmp_path)]) == 0
    md = (tmp_path / "da-radar-2026-12-18.md").read_text(encoding="utf-8")
    assert "Hội chợ MẪU" in md and "còn 7 ngày" in md
    assert "| hạn 25/12/2026 |" in md            # cột trích hạn đọc từ DB


def test_module_has_no_network_imports():
    src = (ROOT / "agents" / "da_radar.py").read_text(encoding="utf-8")
    assert not re.search(r"import (httpx|requests|socket|smtplib)|from "
                         r"(httpx|requests|smtplib|urllib\.request|"
                         r"http\.client)|urllib\.request|email\.mime|"
                         r"webbrowser", src)


# ---------------------------------------------------------------- CLI


@pytest.mark.parametrize("argv", [
    ["--scan", "--list"], [], ["--scan", "--days", "0"],
    ["--list", "--dry-run"], ["--scan", "--date", "2026-10-12"],
    ["--list", "--date", "12/10/2026"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(da_radar, "connect",
                        lambda: pytest.fail("không được connect"))
    with pytest.raises(SystemExit) as e:
        da_radar.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(da_radar, "connect", lambda: None)
    assert da_radar.main(["--scan"]) == 2
    assert "không kết nối" in capsys.readouterr().err


def test_cli_scan_wrapped_in_job_run(db, monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(da_radar, "job_run", lambda n: _fake_job(n, seen))
    monkeypatch.setattr(da_radar, "connect", lambda: TxConn(db))
    _insert_item(db, "https://a.vn/9")
    assert da_radar.main(["--scan"]) == 0
    assert seen == ["agents.da_radar", True]
    assert "inserted=1" in capsys.readouterr().out
    seen.clear()
    assert da_radar.main(["--scan", "--dry-run"]) == 0
    assert seen == []                 # dry-run không ghi job_runs
