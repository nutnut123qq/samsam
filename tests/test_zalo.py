"""Zalo webhook — signature, dedup retry, ACK nhanh, guardrail gate,
conversation log, dedup persistence. Mock toàn bộ: không cần OA thật,
không gọi send API ngoài."""
import hashlib
import json
import sqlite3
import threading
import time

import httpx
import pytest

from connectors import zalo

SECRET, APP_ID = "test-secret", "app123"


def _sign(raw: bytes, secret: str = SECRET) -> str:
    """mac = sha256(app_id + raw_body + timestamp + secret) — đúng spec Zalo."""
    data = json.loads(raw)
    return "mac=" + hashlib.sha256(
        (data["app_id"] + raw.decode() + str(data["timestamp"]) + secret)
        .encode()).hexdigest()


def _event(text="Saphraton giá bao nhiêu", event="user_send_text",
           msg_id="m1", uid="u1"):
    return {"app_id": APP_ID, "sender": {"id": uid},
            "recipient": {"id": "oa1"}, "event_name": event,
            "message": {"msg_id": msg_id, "text": text},
            "timestamp": "1700000000000"}


def _reset_seen_conn() -> None:
    """Đóng + quên connection dedup đang cache — tương đương 'restart'
    process (mọi state còn lại phải nằm trên đĩa)."""
    if zalo._seen_conn is not None:
        zalo._seen_conn.close()
        zalo._seen_conn = None


@pytest.fixture(autouse=True)
def _isolated_files(monkeypatch, tmp_path):
    """SEEN_DB + CONV_LOG trỏ sang tmp_path mỗi test: không động vào
    data/ thật, mỗi test bắt đầu với dedup/log rỗng."""
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    _reset_seen_conn()
    yield
    _reset_seen_conn()


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setattr(zalo, "APP_SECRET", SECRET)
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    srv = zalo.ThreadingHTTPServer(("127.0.0.1", 0), zalo.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/zalo-webhook"
    srv.shutdown()


def test_signature_ok_and_bad(monkeypatch):
    monkeypatch.setattr(zalo, "APP_SECRET", SECRET)
    raw = json.dumps(_event()).encode()
    assert zalo.verify_signature(raw, _sign(raw))
    assert not zalo.verify_signature(raw, "mac=deadbeef")
    assert not zalo.verify_signature(raw, "")


def test_signature_skip_when_no_secret(monkeypatch):
    monkeypatch.setattr(zalo, "APP_SECRET", "")
    assert zalo.verify_signature(b"{}", "anything")


def test_post_text_dispatches(server, monkeypatch):
    got, done = [], threading.Event()
    monkeypatch.setattr(zalo, "handle_text",
                        lambda u, t, m=None: got.append((u, t))
                        or done.set())
    raw = json.dumps(_event()).encode()
    r = httpx.post(server, content=raw,
                   headers={"X-ZEvent-Signature": _sign(raw)})
    assert r.status_code == 200 and r.json()["ok"]
    assert done.wait(3)
    assert got == [("u1", "Saphraton giá bao nhiêu")]


def test_dedup_same_msg_id(server, monkeypatch):
    got = []
    monkeypatch.setattr(zalo, "handle_text",
                        lambda u, t, m=None: got.append(u))
    raw = json.dumps(_event(msg_id="dup1")).encode()
    for _ in range(2):  # Zalo retry khi timeout
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    time.sleep(0.3)
    assert got == ["u1"]


def test_non_text_event_ignored(server, monkeypatch):
    got = []
    monkeypatch.setattr(zalo, "handle_text",
                        lambda u, t, m=None: got.append(u))
    raw = json.dumps(_event(event="user_send_image")).encode()
    assert httpx.post(server, content=raw,
                      headers={"X-ZEvent-Signature": _sign(raw)}
                      ).status_code == 200
    time.sleep(0.2)
    assert not got


def test_bad_signature_rejected(server):
    r = httpx.post(server, content=json.dumps(_event()).encode(),
                   headers={"X-ZEvent-Signature": "mac=bad"})
    assert r.status_code == 403


def test_ack_fast_while_reply_slow(server, monkeypatch):
    # answer() ~10s — webhook trả 200 ngay, reply chạy async.
    monkeypatch.setattr(zalo, "handle_text",
                        lambda u, t, m=None: time.sleep(2))
    raw = json.dumps(_event()).encode()
    t0 = time.time()
    r = httpx.post(server, content=raw,
                   headers={"X-ZEvent-Signature": _sign(raw)})
    assert r.status_code == 200 and time.time() - t0 < 1


def test_send_text_without_token(monkeypatch, capsys):
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    assert not zalo.send_text("u", "t")
    assert "ZALO_ACCESS_TOKEN" in capsys.readouterr().out


def test_reply_pipeline_sends_text_with_source(monkeypatch):
    sent = {}
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "Saphraton: 1.000.000 đ",
                                   "sources": ["http://x"]})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(text=t) or True)
    r = zalo.handle_text("u1", "giá?")
    assert sent["text"] == "Saphraton: 1.000.000 đ\nNguồn: http://x"
    assert r["sent"]


def test_reply_guardrail_flag_sends_fallback(monkeypatch):
    sent = {}
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "chữa khỏi tiểu đường",
                                   "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": False})
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(text=t) or True)
    zalo.handle_text("u1", "x")
    assert sent["text"] == zalo.FALLBACK


def test_source_url_with_banned_slug_still_sends(monkeypatch):
    # Regression: check() chạy trên answer TRƯỚC khi append nguồn — slug
    # "chua" trong URL citation không được làm flag oan câu trả lời sạch.
    # Dùng guardrail THẬT, không mock check.
    sent = {}
    monkeypatch.setattr("api.rag.answer", lambda q: {
        "answer": "Saphraton: 1.000.000 đ",
        "sources": ["http://samsam.net.vn/vi/news/bai-chua-benh-1.html"]})
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(text=t) or True)
    zalo.handle_text("u1", "giá?")
    assert sent["text"].startswith("Saphraton")
    assert "Nguồn: http://samsam.net.vn/vi/news/bai-chua-benh-1.html" \
        in sent["text"]


def test_signature_timestamp_as_number(monkeypatch):
    # Regression: timestamp là JSON number -> TypeError trước đây làm rớt
    # connection thay vì verify sạch.
    monkeypatch.setattr(zalo, "APP_SECRET", SECRET)
    ev = _event()
    ev["timestamp"] = 1700000000000  # number, không phải string
    raw = json.dumps(ev).encode()
    assert zalo.verify_signature(raw, _sign(raw))


def test_every_outbound_passes_check(monkeypatch):
    calls = []
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check",
                        lambda t: calls.append(t) or {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u", "x")
    assert calls == ["ok"]  # reply nào cũng qua check() trước khi gửi


def test_dedup_persists_across_restart(tmp_path):
    # D3.5: state dedup nằm trên đĩa — "restart" (drop toàn bộ in-memory)
    # vẫn nhớ event đã xử lý, Zalo retry không gây reply nhân đôi.
    assert not zalo._dedup("x")          # lần đầu: chưa thấy
    _reset_seen_conn()                   # giả lập restart process
    assert zalo._dedup("x")              # restart xong vẫn nhớ
    # Chứng minh data thật sự ở file sqlite, không phải cache memory:
    # mở connection mới hoàn toàn đọc lại.
    rows = sqlite3.connect(tmp_path / "zalo_seen.db").execute(
        "SELECT event_id FROM seen").fetchall()
    assert rows == [("x",)]


def _wait_log_lines(path, n, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            lines = path.read_text(encoding="utf-8").strip().splitlines()
            if len(lines) >= n:
                return [json.loads(x) for x in lines]
        time.sleep(0.05)
    return []


def test_conversation_log_schema_and_dedup_skip(server, monkeypatch,
                                                tmp_path):
    # D3.3: event text -> đúng 1 dòng jsonl đủ schema; event trùng
    # msg_id (Zalo retry) -> KHÔNG thêm dòng.
    log = tmp_path / "conversations.jsonl"
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "Giá 1.000.000 đ",
                                   "sources": ["http://x"]})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    raw = json.dumps(_event(msg_id="m-log")).encode()
    for _ in range(2):  # retry cùng msg_id
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    recs = _wait_log_lines(log, 1)
    time.sleep(0.3)  # chắc chắn không có dòng thứ 2 trễ
    assert len(recs) == 1
    rec = recs[0]
    assert rec["msg_id"] == "m-log"
    assert rec["user_hash"] == hashlib.sha256(b"u1").hexdigest()[:16]
    assert rec["question"] == "Saphraton giá bao nhiêu"
    assert rec["answer"] == "Giá 1.000.000 đ\nNguồn: http://x"
    assert rec["sources"] == ["http://x"]
    assert rec["guardrail_ok"] is True
    assert rec["answered"] is True
    assert isinstance(rec["latency_ms"], int)
    assert rec["ts"].endswith("Z")
    assert '"u1"' not in json.dumps(rec)  # không lưu raw user_id (PII)


def test_conversation_log_no_data_answered_false(monkeypatch, tmp_path):
    # D3.4: reply là NO_DATA -> answered:false trong log.
    from api.rag import NO_DATA
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": NO_DATA, "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u9", "Saphraton chữa được ung thư không?",
                     msg_id="m-nd")
    log = tmp_path / "conversations.jsonl"
    rec = json.loads(log.read_text(encoding="utf-8").strip())
    assert rec["msg_id"] == "m-nd" and rec["answered"] is False
    assert rec["answer"] == NO_DATA
