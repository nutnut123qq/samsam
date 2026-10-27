"""r17 (/cycle 10 lượt 10) — cổng TẮT (HĐ 6.7) + lỗi transport còn sót từ
cold-check r15/r16 (someday có file:line, DONE.md):

  - M1 (r16 someday 13): legal_hr-04 TẮT mà `ra_kenh.ingest` vẫn ghi snapshot
    `channel_posts` / đóng `da_sua` + `channel_post_fixed` rồi mới bị
    `director.submit` chặn → nay kiểm cổng SINH TRƯỚC mọi ghi, chung `--file`
    và `--scan-auto`; CLI `[rollout]` exit 2.
  - M2 (r15 someday 5): `settlement_csv.main` KeyError `thieu_chung_tu` sau
    commit khi đối soát bị chặn (finance-01 TẮT) → in kết quả nạp, exit 2
    (`EXIT_BLOCKED` một phần) — cùng mã ở đường API `settlement_api._write`.
  - M3 (r16 someday 11 + cụm cùng idiom): `http.client.HTTPException`
    (BadStatusLine/LineTooLong/quá 100 header) lọt khỏi transport urllib →
    lỗi có kiểm soát ở `market_api._send`, `anchor.submit/upgrade`,
    `webhook_probe.probe`. Server socket thô (Gotcha AGENTS.md).

DB thật: schema tạm + ROLLBACK (`tests.test_ceo_audit.ceo_db`).
"""

import http.client
import urllib.request
from datetime import timedelta

import pytest

from agents import ra_kenh as rk
from ingest import market_api as ma
from ingest import settlement_api as sa
from ingest import settlement_csv as sc
from pipelines import anchor as an
from pipelines import rollout
from tests import test_settlement_csv as tsc
from tests.test_ceo_audit import ceo_db
from tests.test_contract_c01_webhook import wp
from tests.test_contract_c12_channel_scan import _crawl
from tests.test_r16_fanpage import _raw_server
from tests.test_ra_kenh import CFG, NEUTRAL, T0, _csv, _n, _TxConn
from tests.test_v13_c09_anchor_legal import (  # noqa: F401 — fixture DB anchor
    OTS_CFG,
    _fake_post,
    _issued,
    _now,
    proxy,
    run,
)

URL = "https://samsam.net.vn/vi/news/r17-bai-thu.html"
BAD = "Sâm Sâm chữa khỏi bệnh tiểu đường cho người bị tiểu đường."


@pytest.fixture
def db():
    yield from ceo_db()


@pytest.fixture
def off(monkeypatch):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)


def _file_rows(tmp_path, text, name="x.csv"):
    p = _csv(tmp_path, f"{URL},web,0,2021-01-11,,{text}\n", name)
    return p, rk.read_export(p, CFG)


def _state(db):
    return (_n(db, "channel_posts"), _n(db, "approval_queue"),
            _n(db, "red_alerts"),
            _n(db, "agent_action_log", "action = 'channel_post_fixed'"),
            _n(db, "channel_posts", "closed_at is null and severity is not"
               " null"))


# ------------------------------------------------------------------ M1
def test_m1_ingest_off_writes_nothing_both_paths(db, tmp_path, monkeypatch):
    tx = _TxConn(db)
    _p, bad = _file_rows(tmp_path, BAD)
    st = rk.ingest(tx, bad, CFG, by="Quản lý MXH", now=T0)
    assert st["new"] == 1 and st["tickets"] == 1           # đợt mở sẵn
    before = _state(db)
    assert before[4] == 1
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)
    _p, clean = _file_rows(tmp_path, NEUTRAL, "sach.csv")
    # đường file (người): bài đã sạch KHÔNG được đóng đợt khi tính năng tắt
    with pytest.raises(rollout.RolloutBlocked, match="legal_hr-04"):
        rk.ingest(tx, clean, CFG, by="Quản lý MXH",
                  now=T0 + timedelta(hours=1))
    # đường tự thu (agent): cả bài vi phạm lẫn bài sạch
    _crawl(tmp_path, "articles", [{"title": "T", "body": NEUTRAL, "url": URL},
                                  {"title": "T2", "body": BAD,
                                   "url": URL + "?b"}])
    web, _ = rk.web_rows(T0, tmp_path)
    assert len(web) == 2
    with pytest.raises(rollout.RolloutBlocked, match="legal_hr-04"):
        rk.ingest(tx, web, CFG, by=rk.AUTO_BY, now=T0 + timedelta(hours=2),
                  auto=True)
    assert _state(db) == before


def test_m1_cli_file_and_scan_auto_off_exit2_zero_rows(db, tmp_path,
                                                       monkeypatch, capsys,
                                                       off):
    monkeypatch.setattr(rk, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(rk, "_now", lambda: T0)
    p, _ = _file_rows(tmp_path, BAD)
    assert rk.main(["--file", str(p), "--by", "Quản lý MXH"]) == 2
    out = capsys.readouterr().out
    assert "[rollout]" in out and "legal_hr-04" in out
    _crawl(tmp_path, "articles", [{"title": "T", "body": BAD, "url": URL}])
    monkeypatch.setattr(rk, "web_rows", lambda now: _WEB_ROWS(now, tmp_path))
    for k in ("FANPAGE_PAGE_ID", "FANPAGE_READ_TOKEN", "FANPAGE_API_BASE"):
        monkeypatch.delenv(k, raising=False)
    assert rk.main(["--scan-auto"]) == 2
    out = capsys.readouterr().out
    assert "[rollout]" in out and "legal_hr-04" in out
    assert _state(db) == (0, 0, 0, 0, 0)


_WEB_ROWS = rk.web_rows


# ------------------------------------------------------------------ M2
def test_m2_csv_recon_blocked_prints_load_exit2(db, monkeypatch, capsys, off):
    rc, committed = tsc._run(db, monkeypatch, "--file", str(tsc.SETTLE),
                             "--channel", "shopee")
    out = capsys.readouterr().out
    assert (rc, committed) == (rollout.EXIT_BLOCKED, 1)
    assert "[blocked]" in out and "[load]" in out and "Traceback" not in out
    assert _n(db, "settlement_rows") == 16 and _n(db, "recon_results") == 0
    # chạy lại: file đã nạp → skip, không ghi thêm
    assert tsc._run(db, monkeypatch, "--file", str(tsc.SETTLE), "--channel",
                    "shopee")[0] == 0
    assert "[skip]" in capsys.readouterr().out
    assert _n(db, "settlement_rows") == 16


def test_m2_api_recon_blocked_exit2(db, monkeypatch, capsys, off):
    monkeypatch.setattr(sa, "_connect", lambda _dsn: tsc._TxConn(db))
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    fees = sc.load_fees()[0]
    row = {**dict.fromkeys(sc.MONEY, 0),
           "order_id_hash": sc.order_hash("tiktok", "R17FAKE"),
           "order_amount": 100, "payout": 90, "txn_type": "ORDER",
           "settled_on": sa.date(2026, 10, 3), "row_no": 2}
    assert sa._write("tiktok", [row], "api_live", fees, sa.date(2026, 10, 1),
                     sa.date(2026, 10, 7)) == rollout.EXIT_BLOCKED
    out = capsys.readouterr().out
    assert "[blocked]" in out and "[load]" in out
    assert _n(db, "settlement_rows") == 1 and _n(db, "recon_results") == 0


# ------------------------------------------------------------------ M3
RAW = [
    (b"GARBAGE NOT HTTP\r\n\r\n", "BadStatusLine"),
    (b"HTTP/1.1 200 OK\r\n" + b"".join(b"X-H%d: v\r\n" % i for i in range(150))
     + b"Content-Length: 2\r\n\r\n{}", "HTTPException"),
    (b"HTTP/1.1 200 OK\r\nX-Long: " + b"a" * 70000 + b"\r\n\r\n",
     "LineTooLong")]
IDS = ["status", "headers", "line"]


@pytest.fixture
def raw():
    socks = []

    def make(payload):
        s, url = _raw_server(payload)
        socks.append(s)
        return url
    yield make
    for s in socks:
        s.close()


@pytest.mark.parametrize("payload,name", RAW, ids=IDS)
def test_m3_market_api_send_http_client_error_is_api_error(raw, payload,
                                                           name):
    url = raw(payload)
    req = urllib.request.Request(url + "/api/v2/x?access_token=TOKENBIMAT")
    with pytest.raises(ma.ApiError) as e:
        ma._send(req, "shopee: thử")
    msg = str(e.value)
    assert f"lỗi mạng ({name})" in msg
    assert "TOKENBIMAT" not in msg and "127.0.0.1" not in msg


@pytest.mark.parametrize("payload,name", RAW, ids=IDS)
def test_m3_webhook_probe_http_client_error_not_ready(raw, payload, name):
    assert wp.probe(raw(payload) + "/readyz") == (False, name)


# anchor chỉ https (`http_post`/`http_get` từ chối http) → không trỏ được tới
# server socket thô; giả `post`/`get` ném ĐÚNG lớp lỗi mà opener urllib ném ra
# (hai test trên chứng minh opener thật ném các lớp này).
HTTP_ERRS = [http.client.BadStatusLine("GARBAGE"),
             http.client.HTTPException("got more than 100 headers"),
             http.client.LineTooLong("header line")]


@pytest.mark.parametrize("exc", HTTP_ERRS, ids=IDS)
def test_m3_anchor_submit_upgrade_http_client_error(db, proxy, run, exc):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    calls, ok, bad = [], _fake_post([]), ("https://cal-a",)

    def post(u, body, t):
        calls.append(u)
        if u.startswith(bad):
            raise exc
        return ok(u, body, t)
    bad = ("https://cal-a", "https://cal-b")      # mọi calendar hỏng → `loi`
    r = an.submit(proxy, bid, OTS_CFG, post=post)
    name = type(exc).__name__
    assert r["status"] == "loi" and r["errors"] == [
        f"cal-a.test: {name}", f"cal-b.test: {name}"]
    bad, calls[:] = ("https://cal-a",), []        # chạy lại: A hỏng → thử B
    r = an.submit(proxy, bid, OTS_CFG, post=post)
    assert r["status"] == "da_gui" and r["calendar"] == "https://cal-b.test"
    assert calls == ["https://cal-a.test/digest", "https://cal-b.test/digest"]

    def get(u, t):
        raise exc
    r = an.upgrade(proxy, bid, OTS_CFG, get=get)
    assert r["status"] == "cho" and r["errors"] == [f"cal-b.test: {name}"]
