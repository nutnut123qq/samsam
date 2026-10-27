"""r16 legal_hr-04 — `connectors.fanpage` (Graph API chỉ đọc) + nguồn Fanpage
của `agents.ra_kenh --scan-auto`.

Mạng: server giả 127.0.0.1 (tái dùng `tests.test_market_api._Server`), ĐẾM
request — không gọi Graph thật (CONTRACT_TESTED theo tài liệu chính thức
v26.0). DB: `ceo_db` (schema tạm, ROLLBACK). Token giả rõ ràng.
"""

from datetime import date, datetime, timedelta

import pytest

from agents import ra_kenh as rk
from connectors import fanpage as fp
from ingest.market_api import ConfigError
from pipelines import rollout
from pipelines.period import VN_TZ
from tests import test_market_api as tma
from tests.test_ceo_audit import TxConn, ceo_db

servers = tma.servers
TOKEN = "FBTOKEN_SECRET_r16xyz"
PAGE = "1234567890"
NOW = datetime(2026, 10, 27, 9, tzinfo=VN_TZ)
BAD = "Sâm Sâm chữa khỏi bệnh tiểu đường cho người bị tiểu đường."
OK = "Sâm Sâm ra mắt hộp quà Tết mới."
POST_PATH = f"/v26.0/{PAGE}/published_posts"


def _post(i, text=OK, link=None, ct="2026-10-20T03:00:00+0000"):
    return {"id": f"{PAGE}_{i}", "message": text, "created_time": ct,
            "permalink_url": link or f"https://www.facebook.com/{PAGE}/posts/{i}"}


def _page(data, after=None):
    doc = {"data": data}
    if after:
        doc["paging"] = {"cursors": {"before": "B", "after": after},
                         "next": f"https://graph.facebook.com/v26.0/x?after={after}"}
    return doc


@pytest.fixture
def env(monkeypatch):
    def set_(base):
        monkeypatch.setenv(fp.ENV_PAGE, PAGE)
        monkeypatch.setenv(fp.ENV_TOKEN, TOKEN)
        monkeypatch.setenv(fp.ENV_BASE, base)
        return fp.config()
    monkeypatch.setattr(fp, "_sleep", lambda s: None)
    return set_


def _pages(*docs):
    it = iter(docs)
    return lambda m, p, q, b: next(it)


def test_paging_until_no_next_empty_page_is_not_end(servers, env):
    s = servers(_pages((200, _page([_post(1)], "A1"), None),
                       (200, _page([], "A2"), None),
                       (200, _page([_post(2)]), None)))
    posts = fp.fetch_posts(env(s.url))
    assert [p["id"] for p in posts] == [f"{PAGE}_1", f"{PAGE}_2"]
    assert [r["path"] for r in s.requests] == [POST_PATH] * 3
    q = s.requests[0]["query"]
    assert q["fields"] == ["id,message,created_time,permalink_url"]
    assert q["limit"] == ["100"] and q["access_token"] == [TOKEN]
    assert "after" not in q
    assert [r["query"]["after"] for r in s.requests[1:]] == [["A1"], ["A2"]]
    assert {r["method"] for r in s.requests} == {"GET"}


def test_temporary_code_retried_then_ok(servers, env, capsys):
    s = servers(_pages((400, {"error": {"code": 4, "message": TOKEN}}, None),
                       (503, b"down", None),
                       (200, _page([_post(1)]), None)))
    assert len(fp.fetch_posts(env(s.url))) == 1
    assert len(s.requests) == 3
    assert TOKEN not in capsys.readouterr().out


@pytest.mark.parametrize("code,sub,want", [
    (190, None, "Bên B cấp lại"), (102, None, "Bên B cấp lại"),
    (100, 463, "Bên B cấp lại"), (10, None, "thiếu quyền"),
    (200, None, "thiếu quyền")])
def test_token_and_permission_errors_not_retried(servers, env, code, sub,
                                                 want):
    err = {"code": code, "message": f"bad {TOKEN}", "fbtrace_id": "T"}
    if sub:
        err["error_subcode"] = sub
    s = servers(lambda *a: (400, {"error": err}, None))
    with pytest.raises(fp.FanpageError) as e:
        fp.fetch_posts(env(s.url))
    msg = str(e.value)
    assert want in msg and f"mã {code}" in msg
    assert TOKEN not in msg and "127.0.0.1" not in msg and "bad" not in msg
    assert len(s.requests) == 1


def test_retry_budget_exhausted(servers, env):
    s = servers(lambda *a: (400, {"error": {"code": 17}}, None))
    with pytest.raises(fp.FanpageError, match="sau 4 lần"):
        fp.fetch_posts(env(s.url))
    assert len(s.requests) == fp.RETRY_MAX + 1


def test_redirect_not_followed(servers, env):
    other = servers()
    s = servers(lambda *a: (302, b"", {"Location": other.url + "/steal"}))
    with pytest.raises(fp.FanpageError, match="HTTP 302"):
        fp.fetch_posts(env(s.url))
    assert other.requests == []


@pytest.mark.parametrize("doc", [
    b"not json", [1], {"data": "x"},
    {"data": [], "paging": {"next": "u"}},
    {"data": [], "paging": {"next": "u", "cursors": {"after": "a b"}}}])
def test_bad_response_shape(servers, env, doc):
    s = servers(lambda *a: (200, doc, None))
    with pytest.raises(fp.FanpageError):
        fp.fetch_posts(env(s.url))


def test_max_pages_no_partial(servers, env, monkeypatch):
    monkeypatch.setattr(fp, "MAX_PAGES", 2)
    s = servers(lambda *a: (200, _page([_post(1)], "A"), None))
    with pytest.raises(fp.FanpageError, match="vượt 2 trang"):
        fp.fetch_posts(env(s.url))
    assert len(s.requests) == 2


def test_config(monkeypatch):
    for k in (fp.ENV_PAGE, fp.ENV_TOKEN, fp.ENV_BASE):
        monkeypatch.delenv(k, raising=False)
    assert fp.config() is None
    monkeypatch.setenv(fp.ENV_PAGE, PAGE)
    with pytest.raises(ConfigError, match=fp.ENV_TOKEN):
        fp.config()
    monkeypatch.setenv(fp.ENV_TOKEN, TOKEN)
    assert fp.config()["base"] == "https://graph.facebook.com"
    monkeypatch.setenv(fp.ENV_PAGE, "me")
    with pytest.raises(ConfigError, match=fp.ENV_PAGE):
        fp.config()
    monkeypatch.setenv(fp.ENV_PAGE, PAGE)
    monkeypatch.setenv(fp.ENV_BASE, "http://evil.example")
    with pytest.raises(ConfigError, match=fp.ENV_BASE):
        fp.config()


def test_post_url():
    assert fp.post_url("https://www.facebook.com/1/posts/2")
    assert fp.post_url("https://m.facebook.com/x")
    for bad in ("http://www.facebook.com/x", "https://evilfacebook.com/x",
                "https://facebook.com.evil.example/x", "javascript:x", None,
                "https://u:p@www.facebook.com/x", 5):
        assert fp.post_url(bad) is None


# ------------------------------------------------------------ ra_kenh nguồn
def test_fanpage_rows_mapping(servers, env):
    s = servers(_pages((200, _page([
        _post(1, BAD, ct="2026-10-20T20:00:00+0000"),     # 03:00 VN 21/10
        _post(2, OK, ct=1760000000),
        _post(3, OK, ct="hôm qua"),
        _post(4, "   "),
        _post(5, OK, link="http://www.facebook.com/x"),
        {**_post(6), "message": None},
        _post(1, BAD, ct="2026-10-20T20:00:00+0000")]), None)))
    env(s.url)
    rows, notes, rc = rk.fanpage_rows(None)
    assert rc is None
    assert [r["url"] for r in rows] == [
        f"https://www.facebook.com/{PAGE}/posts/{i}" for i in (1, 2, 3)]
    assert rows[0]["posted_on"] == date(2026, 10, 21)
    assert rows[1]["posted_on"] == datetime.fromtimestamp(
        1760000000, VN_TZ).date()
    assert rows[2]["posted_on"] is None
    assert {(r["channel"], r["content_type"], r["is_ai"]) for r in rows} == {
        ("facebook", "post", False)}
    assert notes == [(f"fanpage: bỏ 3 bài không có chữ, dài quá {rk.MAX_TEXT}"
                      " ký tự hoặc permalink không hợp lệ")]
    assert rk.scan_row(rows[0], rk.load_config())["severity"] == "S1"


def test_fanpage_rows_not_configured_and_broken(monkeypatch):
    for k in (fp.ENV_PAGE, fp.ENV_TOKEN, fp.ENV_BASE):
        monkeypatch.delenv(k, raising=False)
    rows, notes, rc = rk.fanpage_rows(None)
    assert (rows, rc) == ([], None) and "chưa cấu hình" in notes[0]
    monkeypatch.setenv(fp.ENV_TOKEN, TOKEN)
    rows, notes, rc = rk.fanpage_rows(None)
    assert (rows, rc) == ([], 2) and TOKEN not in notes[0]


def test_fanpage_rows_feature_off_no_request(servers, env, monkeypatch):
    s = servers()
    env(s.url)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)
    rows, notes, rc = rk.fanpage_rows(None)
    assert (rows, rc) == ([], rollout.EXIT_BLOCKED)
    assert "legal_hr-04" in notes[0] and s.requests == []


def test_fanpage_rows_source_error(servers, env):
    s = servers(lambda *a: (400, {"error": {"code": 190}}, None))
    env(s.url)
    rows, notes, rc = rk.fanpage_rows(None)
    assert (rows, rc) == ([], 1) and "mã 190" in notes[0]


def test_scan_auto_dry_run_cli(servers, env, monkeypatch, capsys):
    monkeypatch.setattr(rk, "web_rows", lambda now: ([], []))
    s = servers(_pages((200, _page([_post(1, BAD)]), None)))
    env(s.url)
    assert rk.main(["--scan-auto", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "1 bài web/Fanpage" in out and "[S1]" in out and TOKEN not in out
    s2 = servers(lambda *a: (500, b"x", None))
    env(s2.url)
    assert rk.main(["--scan-auto", "--dry-run"]) == 1
    assert TOKEN not in capsys.readouterr().out


@pytest.fixture
def db():
    yield from ceo_db()


def test_ingest_fanpage_ticket_idempotent_svc_job(db, servers, env):
    s = servers(lambda *a: (200, _page([_post(1, BAD), _post(2, OK)]), None))
    env(s.url)
    rows, _, rc = rk.fanpage_rows(TxConn(db))
    assert rc is None and len(rows) == 2
    c = TxConn(db)
    with db.transaction(force_rollback=True):
        db.execute("set local role svc_job")
        st = rk.ingest(c, rows, rk.load_config(), by=rk.AUTO_BY, now=NOW,
                       auto=True)
        assert st["new"] == 2
    st = rk.ingest(c, rows, rk.load_config(), by=rk.AUTO_BY, now=NOW,
                   auto=True)
    assert st["new"] == 2 and st["S1"] == 1
    url = f"https://www.facebook.com/{PAGE}/posts/1"
    assert db.execute("select channel, due_at - first_detected_at,"
                      " imported_by from channel_posts where url = %s",
                      (url,)).fetchone() == ("facebook", timedelta(hours=24),
                                             rk.AUTO_BY)
    assert db.execute("select count(*) from approval_queue where block ="
                      " 'legal_hr' and object_type = 'channel_takedown'"
                      ).fetchone()[0] >= 1
    st2 = rk.ingest(c, rows, rk.load_config(), by=rk.AUTO_BY, now=NOW,
                    auto=True)
    assert st2["new"] == 0 and st2["skip"] == 2


# ------------------------------------- cold-check vòng 1 FIX1: CSV ↔ tự thu
T0 = datetime(2026, 10, 12, 9, tzinfo=VN_TZ)
NEUTRAL = ("Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem"
           " sản phẩm mới. Nội dung có sử dụng AI.")
NO_AI_LABEL = ("Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem"
               " sản phẩm mới.")
HUMAN = "Quan ly MXH (test)"


def _alternate(c, csv_row, auto_row, days=4):
    """Ngày chẵn: NGƯỜI nạp CSV `--file`; ngày lẻ: `--scan-auto` (giờ thật
    khác nhau mỗi ngày)."""
    out = []
    for day in range(days):
        now = T0 + timedelta(days=day)
        if day % 2 == 0:
            out.append(rk.ingest(c, [csv_row], rk.load_config(), by=HUMAN,
                                 now=now))
        else:
            out.append(rk.ingest(c, [auto_row], rk.load_config(),
                                 by=rk.AUTO_BY, now=now, auto=True))
    return out


def _row(url, channel, text, **kw):
    return dict({"line": None, "url": url, "channel": channel,
                 "content_type": "post", "posted_on": None, "is_ai": False,
                 "is_sponsored": False, "sku": None, "draft_id": None,
                 "text": text, "sha": rk.store.content_sha256(text)}, **kw)


@pytest.mark.parametrize("channel,url", [
    ("facebook", f"https://www.facebook.com/{PAGE}/posts/78"),
    ("web", "https://samsamngoclinh.com/bai-78/")])
def test_fix1a_auto_inherits_ai_flag_no_fake_close(db, channel, url):
    """(a) CSV khai is_ai=1 → S2 thiếu nhãn AI. Tự thu cùng URL cùng chữ
    KHÔNG được đóng `da_sua`, không ghi `channel_post_fixed`, không đếm lại
    hạn 24h, không mở ticket mới."""
    c = TxConn(db)
    csv_row = _row(url, channel, NO_AI_LABEL, line=2,
                   posted_on=date(2026, 10, 1), is_ai=True)
    auto_row = _row(url, channel, NO_AI_LABEL,
                    posted_on=date(2026, 10, 1))   # nguồn tự thu không biết AI
    st = _alternate(c, csv_row, auto_row)
    assert st[0]["new"] == 1 and st[0]["S2"] == 1
    assert [(s["new"], s["closed"], s["tickets"]) for s in st[1:]] == [
        (0, 0, 0)] * 3
    rows = db.execute("select id, closed_at, first_detected_at, due_at from"
                      " channel_posts where url = %s", (url,)).fetchall()
    assert len(rows) == 1 and rows[0][1] is None
    assert rows[0][2] == T0 and rows[0][3] == T0 + timedelta(hours=24)
    assert db.execute("select count(*) from agent_action_log where action ="
                      " 'channel_post_fixed' and object_id = %s",
                      (str(rows[0][0]),)).fetchone()[0] == 0


def test_fix1b_auto_inherits_approved_draft_no_ticket(db):
    """(b) CSV có draft đã duyệt → sạch; tự thu cùng URL cùng chữ không được
    thành S2 `thieu_ban_duyet` + ticket (xen kẽ = nhân ticket bài hợp lệ)."""
    c = TxConn(db)
    did = rk.store.save_draft(c, "brief", "facebook", NEUTRAL,
                              rk.guardrail.check(NEUTRAL),
                              created_by="agent:mkt-test")
    assert rk.store.set_status(c, did, "approved", "Phap Che Gia Lap") == (
        True, None)
    url = f"https://www.facebook.com/{PAGE}/posts/77"
    csv_row = _row(url, "facebook", NEUTRAL, line=2, posted_on=T0.date(),
                   is_ai=True, draft_id=did)
    auto_row = _row(url, "facebook", NEUTRAL, posted_on=T0.date())
    st = _alternate(c, csv_row, auto_row)
    assert [(s["S1"], s["S2"], s["tickets"]) for s in st] == [(0, 0, 0)] * 4
    assert db.execute("select count(*) from channel_posts where url = %s",
                      (url,)).fetchone()[0] == 1
    assert db.execute("select count(*) from approval_queue where object_type"
                      " = 'channel_takedown'").fetchone()[0] == 0


def test_fix1_no_human_snapshot_keeps_defaults_and_agent_ignored(db):
    """Chưa từng có snapshot NGƯỜI → mặc định cũ (is_ai False, không bản
    duyệt); snapshot do agent nạp không phải nguồn kế thừa."""
    c = TxConn(db)
    url = f"https://www.facebook.com/{PAGE}/posts/79"
    row = _row(url, "facebook", NO_AI_LABEL, posted_on=T0.date())
    st = rk.ingest(c, [row], rk.load_config(), by=rk.AUTO_BY, now=T0,
                   auto=True)
    assert st["new"] == 1 and st["items"][0]["codes"] == ["thieu_ban_duyet"]
    st = rk.ingest(c, [row], rk.load_config(), by=rk.AUTO_BY,
                   now=T0 + timedelta(days=1), auto=True)
    assert (st["new"], st["skip"]) == (0, 1)


# ------------------------------------- cold-check vòng 1 FIX2: http.client
def _raw_server(payload: bytes):
    """Server socket thô (Gotcha AGENTS.md: lỗi tầng HTTP không giả được
    bằng http.server)."""
    import socket
    import threading
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(5)

    def run():
        while True:
            try:
                cl, _ = s.accept()
            except OSError:
                return
            try:
                cl.recv(65536)
                cl.sendall(payload)
            finally:
                cl.close()
    threading.Thread(target=run, daemon=True).start()
    return s, f"http://127.0.0.1:{s.getsockname()[1]}"


@pytest.mark.parametrize("payload,want", [
    # thân bị cắt: read(amt) trả phần đã nhận → "JSON hỏng" (đã bắt ở vòng 1)
    ((b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
      b"Content-Length: 500\r\n\r\n{\"data\": ["), "JSON hỏng"),
    (b"GARBAGE NOT HTTP\r\n\r\n", "lỗi mạng (BadStatusLine)"),
    (b"HTTP/1.1 200 OK\r\n" + b"".join(b"X-H%d: v\r\n" % i for i in range(150))
     + b"Content-Length: 11\r\n\r\n{\"data\":[]}", "lỗi mạng (HTTPException)"),
    (b"HTTP/1.1 200 OK\r\nX-Long: " + b"a" * 70000 + b"\r\n\r\n",
     "lỗi mạng (LineTooLong)")], ids=["cut", "status", "headers", "line"])
def test_fix2_http_client_errors_become_fanpage_error(env, payload, want):
    s, url = _raw_server(payload)
    try:
        env(url)
        rows, notes, rc = rk.fanpage_rows(None)
    finally:
        s.close()
    assert (rows, rc) == ([], 1)
    assert want in notes[0]
    assert TOKEN not in notes[0] and "127.0.0.1" not in notes[0]


# ------------------------------------- cold-check vòng 2 FIX: biểu diễn chữ
# Bất biến: CÙNG một bài thật, đường CSV (người) và đường tự thu chạy xen kẽ
# ra CÙNG codes/mức — không `lech_ban_duyet` giả vì khác biểu diễn chữ (web =
# tiêu đề + thân), không `thieu_ban_duyet` giả vì mất draft_id; nhưng bài
# Fanpage bị sửa sau duyệt vẫn phải `lech_ban_duyet`.
TITLE = "Tuần mới vui vẻ"


def _draft(c, channel, text):
    did = rk.store.save_draft(c, "brief", channel, text,
                              rk.guardrail.check(text),
                              created_by="agent:mkt-test")
    assert rk.store.set_status(c, did, "approved", "Phap Che Gia Lap") == (
        True, None)
    return did


def _counts(db, url):
    ids = [str(r[0]) for r in db.execute(
        "select id from channel_posts where url = %s", (url,)).fetchall()]
    fixed = db.execute("select count(*) from agent_action_log where action ="
                       " 'channel_post_fixed' and object_id = any(%s)",
                       (ids,)).fetchone()[0]
    tickets = db.execute(
        "select count(*) from approval_queue where object_type ="
        " 'channel_takedown' and object_id = any(%s)",
        ([f"channel_post:{i}" for i in ids],)).fetchone()[0]
    return fixed, tickets


@pytest.mark.parametrize("posted", [date(2026, 10, 1), date(2026, 10, 20)],
                         ids=["truoc_12_10", "tu_12_10"])
def test_fix2a_web_title_body_vs_csv_body_with_draft(db, tmp_path, posted):
    """(a) web: tự thu = đúng cách `web_rows` dựng (tiêu đề + thân), CSV =
    thân khớp bản duyệt, có draft_id; xen kẽ 4 ngày → 0 ticket, 0
    `channel_post_fixed`, cùng codes/mức ở mọi lượt."""
    from tests.test_contract_c12_channel_scan import _crawl
    c = TxConn(db)
    did = _draft(c, "blog", NEUTRAL)
    url = "https://samsamngoclinh.com/bai-fix2a/"
    _crawl(tmp_path, "articles", [{"title": TITLE, "body": NEUTRAL,
                                   "url": url,
                                   "published_at": posted.isoformat()}])
    auto_rows, _ = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    # web_rows nối title/name/body/description bằng " " (trường rỗng → 2 dấu
    # cách) — biểu diễn KHÁC chữ CSV/bản duyệt.
    assert auto_rows[0]["text"] == f"{TITLE}  {NEUTRAL}"
    csv_row = _row(url, "web", NEUTRAL, line=2, posted_on=posted, is_ai=True,
                   draft_id=did)
    st = _alternate(c, csv_row, auto_rows[0])
    assert [(s["S1"], s["S2"], s["tickets"], s["closed"]) for s in st] == [
        (0, 0, 0, 0)] * 4
    assert [s["items"][0]["codes"] for s in st if s["items"]] == [
        []] * len([s for s in st if s["items"]])
    assert _counts(db, url) == (0, 0)


def test_fix2a_web_violation_period_not_reset(db, tmp_path):
    """(a) web có vi phạm THẬT ở cả hai đường (CSV khai is_ai=1, bài thiếu
    nhãn AI): đợt giữ nguyên — 1 ticket, hạn 24h không đếm lại, 0
    `channel_post_fixed`."""
    from tests.test_contract_c12_channel_scan import _crawl
    c = TxConn(db)
    url = "https://samsamngoclinh.com/bai-fix2a-vp/"
    _crawl(tmp_path, "articles", [{"title": TITLE, "body": NO_AI_LABEL,
                                   "url": url, "published_at": "2026-10-01"}])
    auto_rows, _ = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    csv_row = _row(url, "web", NO_AI_LABEL, line=2,
                   posted_on=date(2026, 10, 1), is_ai=True)
    st = _alternate(c, csv_row, auto_rows[0])
    assert [s["S2"] for s in st if s["new"]] and all(
        s["closed"] == 0 for s in st)
    codes = {tuple(s["items"][0]["codes"]) for s in st if s["items"]}
    assert len(codes) == 1, codes
    dues = db.execute("select distinct first_detected_at, due_at from"
                      " channel_posts where url = %s and severity is not null",
                      (url,)).fetchall()
    assert dues == [(T0, T0 + timedelta(hours=24))]
    assert _counts(db, url) == (0, 1)


def test_fix2b_same_text_still_green(db):
    """(b) cùng chữ ở hai đường + draft đã duyệt → vẫn sạch, 1 snapshot."""
    c = TxConn(db)
    did = _draft(c, "facebook", NEUTRAL)
    url = f"https://www.facebook.com/{PAGE}/posts/81"
    csv_row = _row(url, "facebook", NEUTRAL, line=2, posted_on=T0.date(),
                   is_ai=True, draft_id=did)
    auto_row = _row(url, "facebook", NEUTRAL, posted_on=T0.date())
    st = _alternate(c, csv_row, auto_row)
    assert [(s["S2"], s["tickets"]) for s in st] == [(0, 0)] * 4
    assert db.execute("select count(*) from channel_posts where url = %s",
                      (url,)).fetchone()[0] == 1


def test_fix2c_fanpage_edited_after_approval_still_lech(db, servers, env):
    """(c) snapshot NGƯỜI khớp bản duyệt; Graph trả message đã SỬA → đường tự
    thu phải mở `lech_ban_duyet` (phát hiện thật, không mất)."""
    c = TxConn(db)
    did = _draft(c, "facebook", NEUTRAL)
    url = f"https://www.facebook.com/{PAGE}/posts/82"
    csv_row = _row(url, "facebook", NEUTRAL, line=2, posted_on=T0.date(),
                   is_ai=True, draft_id=did)
    st = rk.ingest(c, [csv_row], rk.load_config(), by=HUMAN, now=T0)
    assert st["S2"] == 0
    edited = NEUTRAL + " Giảm giá 50% hôm nay."
    s = servers(lambda *a: (200, _page([_post(82, edited, link=url)]), None))
    env(s.url)
    rows, _, rc = rk.fanpage_rows(None)
    assert rc is None and rows[0]["text"] == edited
    st = rk.ingest(c, rows, rk.load_config(), by=rk.AUTO_BY,
                   now=T0 + timedelta(days=1), auto=True)
    assert "lech_ban_duyet" in st["items"][0]["codes"] and st["tickets"] == 1


def test_fix2_minor_fanpage_text_kept_like_csv(db, servers, env):
    """MINOR: bản duyệt + CSV có khoảng trắng/xuống dòng cuối; message Graph
    giữ nguyên → đường tự thu không được strip (CSV không strip) → xen kẽ 0
    ticket, 0 đóng giả. Message dài quá MAX_TEXT → bỏ (CSV cũng từ chối)."""
    c = TxConn(db)
    text = NEUTRAL + "\n#samsam\n"
    did = _draft(c, "facebook", text)
    url = f"https://www.facebook.com/{PAGE}/posts/83"
    s = servers(lambda *a: (200, _page([
        _post(83, text, link=url),
        _post(84, "x" * (rk.MAX_TEXT + 1))]), None))
    env(s.url)
    rows, notes, rc = rk.fanpage_rows(None)
    assert rc is None and [r["url"] for r in rows] == [url]
    assert rows[0]["text"] == text
    assert any("bỏ 1 bài" in n for n in notes)
    csv_row = _row(url, "facebook", text, line=2, posted_on=T0.date(),
                   is_ai=True, draft_id=did)
    st = _alternate(c, csv_row, rows[0])
    assert [(s["S2"], s["tickets"], s["closed"]) for s in st] == [
        (0, 0, 0)] * 4
    assert _counts(db, url) == (0, 0)


def test_fix2_nit_dry_run_notes_no_db(servers, env, monkeypatch, capsys):
    monkeypatch.setattr(rk, "web_rows", lambda now: ([], []))
    s = servers(_pages((200, _page([_post(1, OK)]), None)))
    env(s.url)
    assert rk.main(["--scan-auto", "--dry-run"]) == 0
    assert "không kế thừa snapshot người" in capsys.readouterr().out


def test_fix2a_web_carries_human_thieu_ban_duyet(db, tmp_path):
    """Web: CSV người KHÔNG có draft, bài từ 12/10 → S2 `thieu_ban_duyet`;
    tự thu (tiêu đề + thân) mang đúng phán quyết đó → cùng đợt, 1 ticket,
    0 đóng giả."""
    from tests.test_contract_c12_channel_scan import _crawl
    c = TxConn(db)
    url = "https://samsamngoclinh.com/bai-fix2a-thieu/"
    _crawl(tmp_path, "articles", [{"title": TITLE, "body": NEUTRAL,
                                   "url": url, "published_at": "2026-10-20"}])
    auto_rows, _ = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    csv_row = _row(url, "web", NEUTRAL, line=2, posted_on=date(2026, 10, 20),
                   is_ai=True)
    st = _alternate(c, csv_row, auto_rows[0])
    assert {tuple(s["items"][0]["codes"]) for s in st if s["items"]} == {
        ("thieu_ban_duyet",)}
    assert all(s["closed"] == 0 for s in st)
    assert _counts(db, url) == (0, 1)
