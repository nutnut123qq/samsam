"""r18 (/cycle 20 lượt 1) — dữ liệu nguồn hỏng → lỗi có kiểm soát + dry-run
khi TẮT (someday có file:line, DONE.md):

  - M1 (r16 someday 15 + cùng idiom `web_rows`): nguồn tự thu `--scan-auto`
    có ký tự Postgres/UTF-8 không lưu được (NUL, surrogate lẻ từ JSON
    `\\u0000`/`\\ud800`) hoặc permalink kèm khoảng trắng/điều khiển → bỏ bài/
    dòng đó + ghi chú; KHÔNG `psycopg.DataError`/`UnicodeEncodeError`, bài
    khác + web/listing vẫn nạp (hợp đồng r16 M2 "lỗi nguồn → ghi chú").
  - M2 (r17 someday 1): `webhook_probe.probe` thân 200 là JSON không phải
    object / lồng quá sâu → không sẵn sàng, không `AttributeError`/
    `RecursionError` lọt.
  - M3 (r17 someday 2 + cùng idiom): `ra_kenh` dry-run khi tính năng TẮT
    (`--scan-auto`/`--file` legal_hr-04, `--partner-file` marketing-04.2) →
    `[rollout]` exit 2, không in kế hoạch, 0 request Fanpage.

DB thật: schema tạm + ROLLBACK (`tests.test_ceo_audit.ceo_db`). Mạng: server
giả 127.0.0.1 (không gọi Graph thật).
"""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from agents import ra_kenh as rk
from connectors import fanpage as fp
from pipelines import rollout
from pipelines.period import VN_TZ
from tests import test_market_api as tma
from tests import test_r16_fanpage as t16
from tests.test_ceo_audit import ceo_db
from tests.test_contract_c01_webhook import wp
from tests.test_r16_fanpage import BAD, OK, PAGE, TOKEN, _page, _post, _raw_server
from tests.test_ra_kenh import _csv, _n, _TxConn
from tests.test_v14_p5_mkt_ceo_intel import BAD_TEXT, URL1, _pcsv

servers = tma.servers
env = t16.env
WEB = "https://samsam.net.vn/vi/news/r18-"
FB = f"https://www.facebook.com/{PAGE}/posts/"


@pytest.fixture
def db():
    yield from ceo_db()


@pytest.fixture
def off(monkeypatch):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)


def _fb_posts(sur=True):
    """1 bài sạch (vi phạm S1) + 5 bài hỏng (3 khi `sur=False`: chỉ NUL +
    xuống dòng). Server giả `json.dumps` (ensure_ascii) → client nhận đúng
    `\\u0000`/`\\ud800`."""
    posts = [_post(1, BAD),
             _post(2, "Sâm Sâm\x00 chữa khỏi bệnh"),          # NUL ở chữ
             _post(3, "Sâm Sâm \ud800 ra mắt"),                # surrogate lẻ
             _post(4, OK, link=FB + "4\x00"),                  # NUL permalink
             _post(5, OK, link=FB + "5\n"),                    # xuống dòng
             _post(6, OK, link=FB + "\udc806")]                # surrogate URL
    return posts if sur else [posts[i] for i in (0, 1, 3, 4)]


def _web_file(d, sur=True):
    """Tệp crawl viết TAY bằng escape JSON (không qua `ensure_ascii=False`
    — surrogate lẻ không ghi UTF-8 được). 1 dòng sạch + 4 hỏng (2 khi
    `sur=False`)."""
    recs = [{"title": "T", "body": BAD, "url": WEB + "sach.html"},
            {"title": "T", "body": "a\x00b", "url": WEB + "nul-chu.html"},
            {"title": "T", "body": "a\ud800b", "url": WEB + "sur-chu.html"},
            {"title": "T", "body": OK, "url": WEB + "nul-url\x00.html"},
            {"title": "T", "body": OK, "url": WEB + "sur-url\udc80.html"}]
    if not sur:
        recs = [recs[i] for i in (0, 1, 3)]
    (d / "articles.jsonl").write_bytes(
        "\n".join(json.dumps(r) for r in recs).encode("ascii") + b"\n")


# ------------------------------------------------------------------ M1
def test_m1_post_url_rejects_space_control_surrogate():
    assert fp.post_url(FB + "1") == FB + "1"
    for bad in (FB + "1\n", FB + "1\x00", "\t" + FB + "1", FB + "1 2",
                FB + "\ud8001", FB + "1\x7f"):
        assert fp.post_url(bad) is None, repr(bad)


def test_m1_fanpage_rows_skips_unstorable(servers, env):
    s = servers(lambda *a: (200, _page(_fb_posts()), None))
    env(s.url)
    rows, notes, rc = rk.fanpage_rows(None)
    assert rc is None and [r["url"] for r in rows] == [FB + "1"]
    assert len(notes) == 1 and "bỏ 5 bài" in notes[0]
    assert "NUL" in notes[0] and TOKEN not in notes[0]


def test_m1_web_rows_skips_unstorable(tmp_path):
    _web_file(tmp_path)
    rows, notes = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    assert [r["url"] for r in rows] == [WEB + "sach.html"]
    assert any("web/articles: bỏ 4 dòng" in n and "NUL" in n for n in notes)
    assert not any("cũ" in n for n in notes)     # không đổi mã thoát rc 1


@pytest.mark.parametrize("sur,n_fb,n_web", [(False, 3, 2), (True, 5, 4)],
                         ids=["nul", "nul+surrogate"])
def test_m1_scan_auto_cli_unstorable_rows_db(db, tmp_path, servers, env,
                                             monkeypatch, capsys, sur, n_fb,
                                             n_web):
    """`nul`: trước vá NUL ở URL web → `psycopg.DataError` trong
    `_inherit_human` TRƯỚC mọi ghi ([err] exit 2, 0 bài); `nul+surrogate`:
    trước vá `UnicodeEncodeError` lọt khỏi `web_rows` (traceback)."""
    _web_file(tmp_path, sur)
    monkeypatch.setattr(rk, "web_rows",
                        lambda now: _WEB_ROWS(now, tmp_path))
    monkeypatch.setattr(rk, "connect", lambda: _TxConn(db))
    s = servers(lambda *a: (200, _page(_fb_posts(sur)), None))
    env(s.url)
    assert rk.main(["--scan-auto"]) == 0
    out = capsys.readouterr().out
    assert "[err]" not in out and "Traceback" not in out and TOKEN not in out
    assert f"bỏ {n_fb} bài" in out and f"bỏ {n_web} dòng" in out
    assert {r[0] for r in db.execute("select url from channel_posts")} == {
        WEB + "sach.html", FB + "1"}
    assert _n(db, "channel_posts", "severity = 'S1'") == 2


_WEB_ROWS = rk.web_rows


# ------------------------------------------------------------------ M2
def _http200(body: bytes) -> bytes:
    return (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            b"Content-Length: %d\r\n\r\n" % len(body)) + body


# Cold-check r18 vòng 1: trần đệ quy C của bộ giải JSON (CPython 3.12) là 3000
# trên Windows, 10000 trên Linux — 4096 byte `[` chỉ chạm trần ở Windows; Linux
# (CI, server on-prem) ra JSONDecodeError. Cả hai đều phải "không sẵn sàng".
DEEP = {"RecursionError", "JSONDecodeError"}


@pytest.mark.parametrize("body,ok,status", [
    (b"[1]", False, {"HTTP 200"}), (b'"ready"', False, {"HTTP 200"}),
    (b"null", False, {"HTTP 200"}), (b"5", False, {"HTTP 200"}),
    (b"[" * 2000, False, {"JSONDecodeError"}),   # dưới trần cả hai hệ
    (b"[" * 4096, False, DEEP), (b'{"ready": true}', True, {"HTTP 200"})],
    ids=["list", "str", "null", "num", "deep2000", "deep", "ok"])
def test_m2_webhook_probe_non_object_json_not_ready(body, ok, status):
    s, url = _raw_server(_http200(body))
    try:
        got_ok, got_status = wp.probe(url + "/readyz")
        assert got_ok is ok and got_status in status
        if not ok:
            assert wp.main(["--url", url + "/readyz", "--dry-run"]) == 1
    finally:
        s.close()


def test_m2_webhook_probe_recursion_error_any_os(monkeypatch):
    """Nhánh RecursionError kiểm trên MỌI hệ: `json.loads` của module ném đúng
    lớp đó (không phụ thuộc trần đệ quy nền tảng)."""
    def deep(_raw):
        raise RecursionError("maximum recursion depth exceeded")
    monkeypatch.setattr(wp, "json", SimpleNamespace(loads=deep))
    s, url = _raw_server(_http200(b'{"ready": true}'))
    try:
        assert wp.probe(url + "/readyz") == (False, "RecursionError")
    finally:
        s.close()


# ------------------------------------------------------------------ M3
def _plan_printed(out):
    return "[dry-run]" in out or "trích:" in out or "[S1]" in out


def test_m3_scan_auto_dry_run_off_no_plan_no_request(servers, env, off,
                                                     monkeypatch, capsys):
    monkeypatch.setattr(rk, "web_rows", lambda now: ([{
        "line": 1, "url": WEB + "x.html", "channel": "web",
        "content_type": "post", "posted_on": None, "is_ai": False,
        "is_sponsored": False, "sku": None, "draft_id": None, "text": BAD,
        "sha": "x"}], []))
    monkeypatch.setattr(rk, "connect", lambda: pytest.fail("connect"))
    for k in (fp.ENV_PAGE, fp.ENV_TOKEN, fp.ENV_BASE):
        monkeypatch.delenv(k, raising=False)
    assert rk.main(["--scan-auto", "--dry-run"]) == rollout.EXIT_BLOCKED
    out = capsys.readouterr().out
    assert "[rollout]" in out and "legal_hr-04" in out
    assert not _plan_printed(out)
    s = servers(lambda *a: (200, _page([_post(1, BAD)]), None))
    env(s.url)
    assert rk.main(["--scan-auto", "--dry-run"]) == rollout.EXIT_BLOCKED
    out = capsys.readouterr().out
    assert "[rollout]" in out and not _plan_printed(out)
    assert s.requests == []


def test_m3_file_and_partner_dry_run_off(tmp_path, off, monkeypatch, capsys):
    monkeypatch.setattr(rk, "connect", lambda: pytest.fail("connect"))
    p = _csv(tmp_path, f"{WEB}f.html,web,0,2021-01-11,,{BAD}\n")
    assert rk.main(["--file", str(p), "--by", "Quản lý MXH",
                    "--dry-run"]) == rollout.EXIT_BLOCKED
    out = capsys.readouterr().out
    assert "[rollout]" in out and "legal_hr-04" in out
    assert not _plan_printed(out)
    f = _pcsv(tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\","
                        "2026-10-13,\n")
    assert rk.main(["--partner-file", str(f), "--by", "Lan",
                    "--dry-run"]) == rollout.EXIT_BLOCKED
    out = capsys.readouterr().out
    assert "[rollout]" in out and "marketing-04.2" in out
    assert "tu_cam" not in out and "[dry-run]" not in out


@pytest.mark.parametrize("stage", ["chay_thu", "van_hanh"])
def test_m3_dry_run_on_still_prints_plan(tmp_path, monkeypatch, capsys,
                                         stage):
    monkeypatch.setattr(rollout, "_FORCE_MODE", stage, raising=False)
    monkeypatch.setattr(rk, "connect", lambda: pytest.fail("connect"))
    p = _csv(tmp_path, f"{WEB}f.html,web,0,2021-01-11,,{BAD}\n")
    assert rk.main(["--file", str(p), "--by", "Quản lý MXH",
                    "--dry-run"]) == 0
    assert "[dry-run]" in capsys.readouterr().out
