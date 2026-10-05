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
    data/ thật, mỗi test bắt đầu với dedup/log rỗng. Xoá cả _histories —
    state multi-turn in-memory không được rò sang test sau."""
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    zalo._histories.clear()
    _reset_seen_conn()
    yield
    zalo._histories.clear()
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


def test_payload_too_large_rejected(server, monkeypatch):
    # Ship-pass v0.5: Content-Length vượt cap -> 413, không đọc body
    # (trước đây read không cap — body khổng lồ = memory DoS).
    monkeypatch.setattr(zalo, "MAX_BODY", 10)
    r = httpx.post(server, content=b"x" * 100,
                   headers={"X-ZEvent-Signature": "mac=whatever"})
    assert r.status_code == 413


def test_bad_signature_rejected(server):
    r = httpx.post(server, content=json.dumps(_event()).encode(),
                   headers={"X-ZEvent-Signature": "mac=bad"})
    assert r.status_code == 403


def test_ack_fast_while_reply_slow(server, monkeypatch):
    # ACK 200 trong khi reply vẫn block -> dispatch async. Event-based
    # thay assert <1s — flake dưới load (localhost POST đo tới ~4s lúc
    # máy nặng). Nếu dispatch sync, reply block mãi -> post timeout fail.
    started, release = threading.Event(), threading.Event()

    def slow_reply(u, t, m=None):
        started.set()
        release.wait()

    monkeypatch.setattr(zalo, "handle_text", slow_reply)
    raw = json.dumps(_event()).encode()
    try:
        r = httpx.post(server, content=raw, timeout=10,
                       headers={"X-ZEvent-Signature": _sign(raw)})
        assert r.status_code == 200 and r.json()["ok"]
        assert started.wait(10)  # reply thread thật sự đã chạy
    finally:
        release.set()  # nhả reply thread dù assert fail — không leak


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


def test_startup_error_fail_closed(monkeypatch):
    # D4.2 + D5.1: DEPLOY truthy (1/true/yes) mà thiếu secret HOẶC token
    # -> refuse to serve; dev local (tắt/sai format) vẫn serve.
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setattr(zalo, "APP_SECRET", "")
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    assert zalo._startup_error() is not None   # thiếu secret
    monkeypatch.setattr(zalo, "APP_SECRET", SECRET)
    assert zalo._startup_error() is not None   # thiếu token vẫn refuse
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "tok")
    assert zalo._startup_error() is None       # đủ env -> serve
    for v in ("true", "YES"):                  # truthy variants (D5.1)
        monkeypatch.setenv("DEPLOY", v)
        monkeypatch.setattr(zalo, "APP_SECRET", "")
        assert zalo._startup_error() is not None
    monkeypatch.setenv("DEPLOY", "0")          # không phải truthy -> dev
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    assert zalo._startup_error() is None
    monkeypatch.delenv("DEPLOY")
    assert zalo._startup_error() is None


def _mock_ok_answer(calls):
    """answer giả ghi lại (question, history) từng lượt gọi."""
    def fake(q, history=None):
        calls.append((q, history))
        return {"answer": f"trả lời: {q}", "sources": []}
    return fake


def test_multi_turn_history_per_user(monkeypatch):
    # D4.1: lượt 2 cùng user_id phải thấy lượt 1 trong history.
    calls = []
    monkeypatch.setattr("api.rag.answer", _mock_ok_answer(calls))
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u1", "Saphraton giá bao nhiêu?")
    zalo.handle_text("u1", "còn loại rẻ hơn?")
    assert calls[0] == ("Saphraton giá bao nhiêu?", None)
    assert calls[1][1] == [
        {"role": "user", "content": "Saphraton giá bao nhiêu?"},
        {"role": "assistant", "content": "trả lời: Saphraton giá bao nhiêu?"}]


def test_flagged_turn_not_added_to_history(monkeypatch):
    # Lượt bị guardrail flag không vào history — lượt sau chỉ thấy các
    # lượt hợp lệ trước đó.
    calls, guard = [], iter([{"ok": True}, {"ok": False}, {"ok": True}])
    monkeypatch.setattr("api.rag.answer", _mock_ok_answer(calls))
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: next(guard))
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    for q in ("câu 1", "câu 2 bị flag", "câu 3"):
        zalo.handle_text("u1", q)
    # history của lượt 3 chỉ chứa lượt 1, không có "câu 2 bị flag"
    assert calls[2][1] == [
        {"role": "user", "content": "câu 1"},
        {"role": "assistant", "content": "trả lời: câu 1"}]


def test_histories_cap_evicts_oldest_inactive(monkeypatch):
    # _histories bounded: đầy HIST_MAX_USERS -> evict user ít hoạt động
    # nhất (LRU); user vừa chat được refresh nên không bị evict oan.
    monkeypatch.setattr(zalo, "HIST_MAX_USERS", 3)
    monkeypatch.setattr("api.rag.answer",
                        lambda q, history=None: {"answer": "a",
                                                 "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    for u in ("u1", "u2", "u3"):
        zalo.handle_text(u, "q")
    zalo.handle_text("u1", "q2")   # refresh u1 -> u2 giờ là cũ nhất
    zalo.handle_text("u4", "q")    # vượt cap -> evict u2
    assert sorted(zalo._histories) == ["u1", "u3", "u4"]
    assert len(zalo._histories["u1"]) == 4  # 2 lượt Q&A của u1 vẫn giữ


def test_same_user_messages_serialize(monkeypatch):
    # D5.5: 2 message concurrent cùng user xử lý tuần tự — lượt sau phải
    # thấy lượt trước trong history (trước đây cả hai cùng snapshot rỗng,
    # append sai thứ tự). answer chậm 0.2s để chắc chắn 2 thread overlap:
    # code cũ -> calls[1][1] cũng None -> test này fail deterministic.
    calls = []

    def slow_answer(q, history=None):
        calls.append((q, history))
        time.sleep(0.2)
        return {"answer": "a", "sources": []}

    monkeypatch.setattr("api.rag.answer", slow_answer)
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    threads = [threading.Thread(target=zalo.handle_text,
                                args=("u1", f"câu {i}"))
               for i in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls[0][1] is None  # lượt đầu không có history
    assert calls[1][1] == [{"role": "user", "content": calls[0][0]},
                           {"role": "assistant", "content": "a"}]


def test_convlog_question_masks_pii(monkeypatch, tmp_path):
    # D5.3: question chứa SĐT/email -> log chỉ lưu bản đã mask.
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u5", "gọi 0901234567 hoặc a@b.com giúp tôi",
                     msg_id="m-pii")
    rec = json.loads((tmp_path / "conversations.jsonl")
                     .read_text(encoding="utf-8").strip())
    assert rec["question"] == "gọi *** hoặc *** giúp tôi"
    assert "0901234567" not in rec["question"]
    assert "a@b.com" not in rec["question"]


def test_convlog_rotates_when_over_cap(monkeypatch, tmp_path):
    # D5.4: file log vượt cap -> rotate sang .1, entry mới vào file mới.
    monkeypatch.setattr(zalo, "CONV_LOG_MAX", 10)  # 10B — entry nào cũng vượt
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u6", "câu 1")
    zalo.handle_text("u6", "câu 2")  # lúc này file đã > cap -> rotate
    log = tmp_path / "conversations.jsonl"
    bak = tmp_path / "conversations.jsonl.1"
    assert bak.exists()
    assert len(log.read_text(encoding="utf-8").splitlines()) == 1
    assert "câu 1" in bak.read_text(encoding="utf-8")


def test_conversation_log_sent_false_on_send_fail(monkeypatch, tmp_path):
    # D4.4: send_text trả False -> log "sent": false, không ghi như đã xử lý.
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: False)
    zalo.handle_text("u2", "câu hỏi", msg_id="m-sendfail")
    log = tmp_path / "conversations.jsonl"
    rec = json.loads(log.read_text(encoding="utf-8").strip())
    assert rec["sent"] is False and rec["answered"] is True


def test_answer_crash_logs_error_and_sends_fallback(monkeypatch, tmp_path):
    # D4.4: answer() raise -> thread không chết câm: đúng 1 dòng log có
    # `error` + `sent`, user nhận ERROR_FALLBACK.
    sent = []

    def boom(q, history=None):
        raise RuntimeError("DB chết")

    monkeypatch.setattr("api.rag.answer", boom)
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    r = zalo.handle_text("u3", "câu hỏi?", msg_id="m-crash")  # không propagate
    assert sent == [zalo.ERROR_FALLBACK]
    assert r["text"] == zalo.ERROR_FALLBACK
    log = tmp_path / "conversations.jsonl"
    recs = [json.loads(x) for x in
            log.read_text(encoding="utf-8").strip().splitlines()]
    assert len(recs) == 1
    rec = recs[0]
    assert rec["sent"] is True and "RuntimeError" in rec["error"]
    assert rec["answer"] == "" and rec["answered"] is False
    # crash trước check() -> null, không phải False (False = đã flag)
    assert rec["guardrail_ok"] is None
    assert rec["question"] == "câu hỏi?"  # không mất vết câu hỏi


def test_guardrail_flagged_text_kept_in_log(monkeypatch, tmp_path):
    # D4.4: answer log = text THẬT gửi (FALLBACK); raw bị flag giữ riêng
    # ở `flagged_text` để debug guardrail.
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "chữa khỏi ung thư",
                                   "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": False})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u4", "x", msg_id="m-flag")
    log = tmp_path / "conversations.jsonl"
    rec = json.loads(log.read_text(encoding="utf-8").strip())
    assert rec["answer"] == zalo.FALLBACK
    assert rec["flagged_text"] == "chữa khỏi ung thư"
    assert rec["guardrail_ok"] is False
