"""v5.1 KD-A1 — Messenger webhook (connectors/messenger.py): chữ ký HMAC
X-Hub-Signature-256, GET verify, dedup mid, DEPLOY tắt = 0 lời gọi ra Meta,
token trong header Bearer. Secret TEST sinh trong test — không Meta thật."""
import hashlib
import hmac
import json
import secrets
import socket
import threading
from urllib.parse import urlparse

import httpx
import pytest

from connectors import channels, messenger, zalo

ORIG_HTTPX_POST = httpx.post   # client test gọi server local bằng bản thật


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    """Secret test ngẫu nhiên mỗi test; dedup/convlog Zalo sang tmp; không
    muối, DEPLOY tắt mặc định."""
    secret = secrets.token_hex(16)
    monkeypatch.setenv("MESSENGER_APP_SECRET", secret)
    monkeypatch.setenv("MESSENGER_VERIFY_TOKEN", "verify-test")
    monkeypatch.delenv("MESSENGER_PAGE_TOKEN", raising=False)
    monkeypatch.delenv("CHANNEL_HASH_SALT", raising=False)
    monkeypatch.delenv("DEPLOY", raising=False)
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "_last_purge", float("-inf"))
    monkeypatch.setattr(zalo, "_last_purge_attempt", float("-inf"))
    if zalo._seen_conn is not None:
        zalo._seen_conn.close()
        zalo._seen_conn = None
    zalo._histories.clear()
    channels.reset_cache()
    yield secret
    if zalo._seen_conn is not None:
        zalo._seen_conn.close()
        zalo._seen_conn = None
    zalo._histories.clear()


@pytest.fixture
def server():
    srv = messenger.ThreadingHTTPServer(("127.0.0.1", 0), messenger.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def _sign(raw: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), raw,
                                hashlib.sha256).hexdigest()


def _event(*msgs) -> bytes:
    return json.dumps({"object": "page", "entry": [{"id": "page1",
                                                    "messaging": list(msgs)}]
                       }).encode()


def _msg(text="Saphraton giá?", mid="mid.1", psid="1234567890123456",
         **extra):
    m = {"mid": mid, **extra}
    if text is not None:
        m["text"] = text
    return {"sender": {"id": psid}, "recipient": {"id": "page1"},
            "timestamp": 1, "message": m}


def _post(url, raw, headers):
    return ORIG_HTTPX_POST(url + messenger.PATH, content=raw, headers=headers,
                           timeout=10)


@pytest.fixture
def spy(monkeypatch):
    """handle_text giả: ghi tham số + set Event (không sleep)."""
    got, ev = [], threading.Event()

    def fake(user_key, text, mid="", **kw):
        got.append((user_key, text, mid, kw))
        ev.set()
    monkeypatch.setattr(zalo, "handle_text", fake)
    return got, ev


def test_valid_signature_processed(server, spy, _env):
    got, ev = spy
    raw = _event(_msg())
    r = _post(server, raw, {"X-Hub-Signature-256": _sign(raw, _env)})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert ev.wait(10)
    [(key, text, mid, kw)] = got
    assert (key, text, mid) == ("messenger:1234567890123456",
                                "Saphraton giá?", "mid.1")
    assert kw["channel"] == "messenger" and kw["send"] is messenger.send_text


@pytest.mark.parametrize("case", ["sai", "thieu", "sua-1-byte", "secret-rong",
                                  "secret-khac"])
def test_bad_signature_403_not_processed(server, spy, monkeypatch, _env,
                                         case):
    got, _ = spy
    raw = _event(_msg())
    sig = _sign(raw, _env)
    headers = {"X-Hub-Signature-256": sig}
    if case == "sai":
        headers["X-Hub-Signature-256"] = "sha256=" + "0" * 64
    elif case == "thieu":
        headers = {}
    elif case == "sua-1-byte":
        raw = raw.replace(b"Saphraton", b"Saphratom")   # ký xong mới sửa
    elif case == "secret-rong":
        monkeypatch.setenv("MESSENGER_APP_SECRET", "")
    elif case == "secret-khac":
        headers["X-Hub-Signature-256"] = _sign(raw, "khac-secret")
    r = _post(server, raw, headers)
    assert r.status_code == 403
    assert got == []
    assert not (zalo.SEEN_DB.exists())   # không tới bước dedup


def test_verify_signature_unit(_env, monkeypatch):
    raw = b'{"object":"page"}'
    assert messenger.verify_signature(raw, _sign(raw, _env))
    assert not messenger.verify_signature(raw, None)
    assert not messenger.verify_signature(raw, "sha256=é" + "a" * 63)
    monkeypatch.delenv("MESSENGER_APP_SECRET")
    assert not messenger.verify_signature(raw, _sign(raw, ""))


def test_get_verify(server):
    base = server + messenger.PATH
    ok = httpx.get(base, params={"hub.mode": "subscribe",
                                 "hub.verify_token": "verify-test",
                                 "hub.challenge": "1158201444"}, timeout=10)
    assert ok.status_code == 200 and ok.text == "1158201444"
    bad = httpx.get(base, params={"hub.mode": "subscribe",
                                  "hub.verify_token": "sai",
                                  "hub.challenge": "1"}, timeout=10)
    assert bad.status_code == 403
    xss = httpx.get(base, params={"hub.mode": "subscribe",
                                  "hub.verify_token": "verify-test",
                                  "hub.challenge": "<script>"}, timeout=10)
    assert xss.status_code == 400 and "<script>" not in xss.text
    assert httpx.get(base, params={"hub.mode": "unsubscribe",
                                   "hub.verify_token": "verify-test",
                                   "hub.challenge": "1"},
                     timeout=10).status_code == 403


def test_get_verify_empty_env_token_403(server, monkeypatch):
    monkeypatch.setenv("MESSENGER_VERIFY_TOKEN", "")
    r = httpx.get(server + messenger.PATH,
                  params={"hub.mode": "subscribe", "hub.verify_token": "",
                          "hub.challenge": "1"}, timeout=10)
    assert r.status_code == 403


def test_echo_skipped_and_dup_mid_once(server, spy, _env):
    got, ev = spy
    raw = _event(_msg(text="echo", mid="mid.e", is_echo=True),
                 _msg(mid="mid.dup"))
    assert _post(server, raw, {"X-Hub-Signature-256":
                               _sign(raw, _env)}).status_code == 200
    assert ev.wait(10)
    assert [g[2] for g in got] == ["mid.dup"]          # echo bị bỏ
    # Meta retry cùng mid: dispatch đồng bộ trong test (không sleep) →
    # dedup qua zalo_seen.db khóa 'msgr:' → 0 tin, không thread mới.
    assert messenger.dispatch(json.loads(raw)) == 0
    assert [g[2] for g in got] == ["mid.dup"]
    rows = zalo._seen_db().execute("select event_id from seen").fetchall()
    assert rows == [("msgr:mid.dup",)]


def test_dispatch_ignores_bad_shapes(spy):
    got, _ = spy
    for ev in (None, [], {"object": "user"}, {"object": "page",
                                              "entry": ["x"]},
               {"object": "page", "entry": [{"messaging": [
                   {"sender": {"id": "abc"}, "message": {"mid": "m",
                                                         "text": "x"}},
                   {"sender": {"id": "123"}, "message": {"text": "x"}},
                   {"sender": {"id": "123"}, "postback": {"title": "x"}}]}]}):
        assert messenger.dispatch(ev) == 0
    assert got == []


def test_non_text_sends_nontext_reply(monkeypatch):
    sent, ev = [], threading.Event()
    monkeypatch.setattr(messenger, "send_text",
                        lambda k, t: sent.append((k, t)) or ev.set() or True)
    n = messenger.dispatch(json.loads(_event(_msg(
        text=None, mid="mid.img", attachments=[{"type": "image"}]))))
    assert n == 1 and ev.wait(10)
    assert sent == [("messenger:1234567890123456", zalo.NON_TEXT_TEXT)]


def test_deploy_off_full_flow_zero_httpx(server, monkeypatch, _env, capsys):
    """POST hợp lệ chạy TRỌN pipeline (câu thường + rượu + sức khỏe) với
    DEPLOY tắt → 0 lời gọi httpx ra Meta; stdout không có psid thô."""
    def no_net(*a, **k):
        raise AssertionError("DEPLOY tắt mà gọi httpx.post")
    monkeypatch.setattr(messenger.httpx, "post", no_net)
    calls, done = [], threading.Semaphore(0)
    monkeypatch.setattr("api.rag.answer", lambda q, history=None: calls.append(
        q) or {"answer": "Saphraton: 1.000.000 đ", "sources": ["http://x"]})
    real = messenger.send_text

    def spy_send(key, text):
        res = real(key, text)
        done.release()
        return res
    monkeypatch.setattr(messenger, "send_text", spy_send)
    raw = _event(_msg("Saphraton giá?", "mid.a"),
                 _msg("rượu sâm giá bao nhiêu", "mid.b"),
                 _msg("tôi mất ngủ uống gì", "mid.c"))
    assert _post(server, raw, {"X-Hub-Signature-256":
                               _sign(raw, _env)}).status_code == 200
    for _ in range(3):
        assert done.acquire(timeout=10)
    assert calls == ["Saphraton giá?"]     # rượu/sức khỏe: 0 lời gọi answer
    out = capsys.readouterr().out
    assert out.count("[dry-run] messenger: DEPLOY tắt") == 3
    assert "1234567890123456" not in out


def test_deploy_on_bearer_header_not_url(monkeypatch):
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setenv("MESSENGER_PAGE_TOKEN", "PAGE-TOKEN-TEST")
    seen = {}

    class R:
        status_code = 200

    def fake_post(url, **kw):
        seen.update(url=url, **kw)
        return R()
    monkeypatch.setattr(messenger.httpx, "post", fake_post)
    assert messenger.send_text("messenger:42", "x" * 3000) is True
    assert "PAGE-TOKEN-TEST" not in seen["url"]
    assert seen["url"].startswith("https://graph.facebook.com/")
    assert seen["headers"] == {"Authorization": "Bearer PAGE-TOKEN-TEST"}
    assert seen["json"]["recipient"] == {"id": "42"}
    assert len(seen["json"]["message"]["text"]) == messenger.MAX_TEXT
    assert "params" not in seen


def test_deploy_on_send_errors_false_no_token_leak(monkeypatch, capsys):
    monkeypatch.setenv("DEPLOY", "yes")
    monkeypatch.setenv("MESSENGER_PAGE_TOKEN", "PAGE-TOKEN-TEST")

    class R:
        status_code = 400
    monkeypatch.setattr(messenger.httpx, "post", lambda url, **kw: R())
    assert messenger.send_text("messenger:42", "x") is False

    def boom(url, **kw):
        raise httpx.ConnectError("PAGE-TOKEN-TEST")
    monkeypatch.setattr(messenger.httpx, "post", boom)
    assert messenger.send_text("messenger:42", "x") is False
    monkeypatch.setattr(messenger.httpx, "post",
                        lambda *a, **k: pytest.fail("psid lạ vẫn gửi"))
    assert messenger.send_text("messenger:abc", "x") is False
    out = capsys.readouterr().out
    assert "PAGE-TOKEN-TEST" not in out and "messenger:42" not in out
    assert out.count("(uh=") == 3


@pytest.mark.parametrize("missing", ["MESSENGER_APP_SECRET",
                                     "MESSENGER_PAGE_TOKEN",
                                     "MESSENGER_VERIFY_TOKEN",
                                     "CHANNEL_HASH_SALT"])
def test_startup_error_deploy_missing_env(monkeypatch, missing):
    full = {"MESSENGER_APP_SECRET": "s", "MESSENGER_PAGE_TOKEN": "t",
            "MESSENGER_VERIFY_TOKEN": "v",
            "CHANNEL_HASH_SALT": "test-salt-0123456789abcdef"}
    for k, v in full.items():
        monkeypatch.setenv(k, v)
    assert messenger._startup_error() is None          # DEPLOY tắt
    monkeypatch.setenv("DEPLOY", "true")
    assert messenger._startup_error() is None          # đủ biến
    monkeypatch.setenv(missing, "")
    err = messenger._startup_error()
    assert err and missing in err and "[fatal]" in err
    assert messenger.main([]) == 1


def test_startup_error_short_salt(monkeypatch):
    for k in messenger.REQUIRED_ENV:
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setenv("CHANNEL_HASH_SALT", "ngan")
    assert "CHANNEL_HASH_SALT" in messenger._startup_error()


def _raw_exchange(server, data: bytes) -> bytes:
    u = urlparse(server)
    with socket.create_connection((u.hostname, u.port), timeout=10) as s:
        s.sendall(data)
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
    return resp.split(b"\r\n")[0]


def test_post_framing_rejects(server, spy, monkeypatch):
    """Raw socket (server đóng sớm — httpx flake, gotcha v0.5.1)."""
    got, _ = spy
    monkeypatch.setattr(messenger, "MAX_BODY", 10)
    p = messenger.PATH.encode()
    assert b"413" in _raw_exchange(
        server, b"POST " + p + b" HTTP/1.1\r\nHost: x\r\nContent-Length: 100"
        b"\r\n\r\n" + b"x" * 100)
    assert b"411" in _raw_exchange(
        server, b"POST " + p + b" HTTP/1.1\r\nHost: x\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
    assert b"411" in _raw_exchange(
        server, b"POST " + p + b" HTTP/1.1\r\nHost: x\r\n\r\n")
    assert b"400" in _raw_exchange(
        server, b"POST " + p + b" HTTP/1.1\r\nHost: x\r\nContent-Length: -1"
        b"\r\n\r\n")
    assert got == []


def test_unknown_path_404_and_bad_json_400(server, _env):
    raw = b"{not json"
    r = ORIG_HTTPX_POST(server + "/khac", content=raw,
                        headers={"X-Hub-Signature-256": _sign(raw, _env)},
                        timeout=10)
    assert r.status_code == 404
    r = _post(server, raw, {"X-Hub-Signature-256": _sign(raw, _env)})
    assert r.status_code == 400
    assert httpx.get(server + "/healthz", timeout=10).json() == {
        "status": "up"}


def test_cli_help_exits_zero(capsys):
    with pytest.raises(SystemExit) as e:
        messenger.main(["--help"])
    assert e.value.code == 0 and "Messenger" in capsys.readouterr().out
