"""Zalo webhook — signature, dedup retry, ACK nhanh, guardrail gate,
conversation log, dedup persistence. Mock toàn bộ: không cần OA thật,
không gọi send API ngoài."""
import hashlib
import itertools
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
    """SEEN_DB + CONV_LOG + TOKEN_STORE trỏ sang tmp_path mỗi test:
    không động vào data/ thật, mỗi test bắt đầu với dedup/log/token
    store rỗng. Xoá cả _histories — state multi-turn in-memory không
    được rò sang test sau."""
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "TOKEN_STORE", tmp_path / "zalo_tokens.json")
    # M3 throttle là module-global — test trước refresh xong sẽ để lại
    # mốc _last_refresh làm test sau thấy "fresh" giả -> reset mỗi test.
    monkeypatch.setattr(zalo, "_last_refresh", 0.0)
    # V2.2/V2.3: _last_refresh_ok (throttle retry) + _mem_tokens (token
    # fallback) cũng là module-global — sót lại làm test sau thấy token/
    # mốc giả theo thứ tự chạy (gotcha v1.0).
    monkeypatch.setattr(zalo, "_last_refresh_ok", 0.0)
    monkeypatch.setattr(zalo, "_mem_tokens", {})
    # V4.1: daily-purge globals cũng module-global. _last_purge trước
    # đây CHƯA từng reset (latent leak — test làm purge thành công để
    # timestamp sót lại, test sau thấy "vừa purge" giả → skip daily
    # nhánh theo thứ tự chạy); _last_purge_attempt (throttle retry
    # purge-fail mới) cùng reset mỗi test.
    monkeypatch.setattr(zalo, "_last_purge", 0.0)
    monkeypatch.setattr(zalo, "_last_purge_attempt", 0.0)
    zalo._histories.clear()
    _reset_seen_conn()
    yield
    zalo._histories.clear()
    _reset_seen_conn()


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setattr(zalo, "OA_SECRET", SECRET)
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    srv = zalo.ThreadingHTTPServer(("127.0.0.1", 0), zalo.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/zalo-webhook"
    srv.shutdown()


def test_signature_ok_and_bad(monkeypatch):
    monkeypatch.setattr(zalo, "OA_SECRET", SECRET)
    raw = json.dumps(_event()).encode()
    assert zalo.verify_signature(raw, _sign(raw))
    assert not zalo.verify_signature(raw, "mac=deadbeef")
    assert not zalo.verify_signature(raw, "")


def test_signature_skip_when_no_secret(monkeypatch):
    monkeypatch.setattr(zalo, "OA_SECRET", "")
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
    # Zalo retry khi timeout -> cùng msg_id chỉ dispatch 1 lần. Wait
    # event cho dispatch lượt 1 thay sleep-mò trước assert — thread
    # startup >0.3s dưới load từng flake (v0.6 ship-pass).
    got, done = [], threading.Event()
    monkeypatch.setattr(zalo, "handle_text",
                        lambda u, t, m=None: got.append(u) or done.set())
    raw = json.dumps(_event(msg_id="dup1")).encode()
    assert httpx.post(server, content=raw,
                      headers={"X-ZEvent-Signature": _sign(raw)}
                      ).status_code == 200
    assert done.wait(5)  # lượt 1 đã dispatch xong
    assert httpx.post(server, content=raw,
                      headers={"X-ZEvent-Signature": _sign(raw)}
                      ).status_code == 200
    time.sleep(0.3)  # dup dispatch (nếu bug) cần cơ hội chạy trước assert
    assert got == ["u1"]


def test_non_text_event_sends_nontext_reply(server, monkeypatch,
                                            tmp_path):
    # V1.4: event user_send_* không phải text (ảnh/file/...) -> khách
    # không bị câm: ACK + reply hằng NON_TEXT_TEXT + convlog
    # answered:false, question dạng [non-text:<event>]; dedup msg_id
    # như event text.
    sent, done = [], threading.Event()
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or done.set() or True)
    monkeypatch.setattr(zalo, "handle_text",
                        lambda *a: sent.append("WRONG-PATH"))
    # V2.4: dispatch phải qua wrapper handle_non_text (có _ulock), không
    # phải _reply_non_text trần — spy call-through chứng minh đúng target.
    dispatched = []
    orig_nt = zalo.handle_non_text

    def spy_nt(u, e, m=""):
        dispatched.append(u)
        return orig_nt(u, e, m)

    monkeypatch.setattr(zalo, "handle_non_text", spy_nt)
    raw = json.dumps(_event(event="user_send_image",
                            msg_id="img1")).encode()
    for _ in range(2):  # lần 2 = Zalo retry cùng msg_id -> dedup
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    assert done.wait(5)
    time.sleep(0.3)  # dup dispatch (nếu bug) cần cơ hội chạy trước assert
    assert sent == [zalo.NON_TEXT_TEXT]
    assert dispatched == ["u1"]  # qua wrapper handle_non_text (V2.4)
    recs = _wait_log_lines(tmp_path / "conversations.jsonl", 1)
    assert len(recs) == 1
    rec = recs[0]
    assert rec["question"] == "[non-text:user_send_image]"
    assert rec["answer"] == zalo.NON_TEXT_TEXT
    assert rec["answered"] is False
    assert rec["guardrail_ok"] is None  # text viết tay, check() không chạy
    assert rec["sent"] is True
    assert rec["msg_id"] == "img1"


def test_follow_sends_welcome(server, monkeypatch, tmp_path):
    # V2.5: event "follow" -> khách nhận WELCOME_TEXT (đổi contract từ
    # v1.0 — trước đây ignore). uid lấy follower.id theo spec Zalo;
    # convlog answered:null (follow không phải câu hỏi — KHÔNG vào queue
    # "Chưa trả lời"); dedup theo timestamp cho retry.
    sent, done = [], threading.Event()
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append((u, t)) or done.set()
                        or True)
    ev = _event(event="follow")
    del ev["message"]                      # payload follow không có message
    ev["follower"] = {"id": "u-fol"}       # spec: follower.id
    raw = json.dumps(ev).encode()
    for _ in range(2):  # Zalo retry cùng timestamp -> dedup
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    assert done.wait(5)
    time.sleep(0.3)  # dup dispatch (nếu bug) cần cơ hội chạy trước assert
    assert sent == [("u-fol", zalo.WELCOME_TEXT)]
    recs = _wait_log_lines(tmp_path / "conversations.jsonl", 1)
    assert len(recs) == 1
    rec = recs[0]
    assert rec["question"] == "[event:follow]"
    assert rec["answer"] == zalo.WELCOME_TEXT
    assert rec["answered"] is None    # null — không phải câu hỏi
    assert rec["guardrail_ok"] is None
    assert rec["sent"] is True
    assert rec["user_hash"] == zalo._uhash("u-fol")


def test_follow_refollow_dedup_within_ttl(server, monkeypatch, tmp_path):
    # V3.2: dedup key follow bỏ timestamp -> per-user. 2 event follow
    # cùng uid nhưng ts KHÁC (user unfollow/refollow trong SEEN_TTL_S)
    # -> chỉ 1 welcome / 1 dòng convlog; uid khác -> welcome riêng.
    sent, done = [], threading.Event()
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(u) or done.set() or True)
    ev = _event(event="follow")
    del ev["message"]
    ev["follower"] = {"id": "u-fol"}
    ev["timestamp"] = "1700000000000"
    raw1 = json.dumps(ev).encode()
    raw2 = json.dumps(dict(ev, timestamp="1700000001000")).encode()
    for raw in (raw1, raw2):  # lần 2 = refollow ts khác -> dedup
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    assert done.wait(5)
    time.sleep(0.3)  # dup dispatch (nếu bug) cần cơ hội chạy trước assert
    assert sent == ["u-fol"]
    recs = _wait_log_lines(tmp_path / "conversations.jsonl", 1)
    assert len(recs) == 1
    # uid khác -> vẫn được welcome riêng (dedup per-user).
    done.clear()
    ev3 = dict(ev, timestamp="1700000002000")
    ev3["follower"] = {"id": "u-fol2"}
    raw3 = json.dumps(ev3).encode()
    assert httpx.post(server, content=raw3,
                      headers={"X-ZEvent-Signature": _sign(raw3)}
                      ).status_code == 200
    assert done.wait(5)
    assert sent == ["u-fol", "u-fol2"]


def test_follow_sender_fallback_and_no_id(server, monkeypatch):
    # V2.5 biên: thiếu `follower` -> fallback sender.id; không có id
    # nào -> ignore (không gửi, không crash).
    sent, done = [], threading.Event()
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(u) or done.set() or True)
    raw = json.dumps(_event(event="follow", uid="u-sender")).encode()
    assert httpx.post(server, content=raw,
                      headers={"X-ZEvent-Signature": _sign(raw)}
                      ).status_code == 200
    assert done.wait(5)
    assert sent == ["u-sender"]
    ev = _event(event="follow")
    ev["sender"] = {}
    raw2 = json.dumps(ev).encode()
    assert httpx.post(server, content=raw2,
                      headers={"X-ZEvent-Signature": _sign(raw2)}
                      ).status_code == 200
    time.sleep(0.3)  # dispatch nhầm (nếu bug) cần cơ hội chạy
    assert sent == ["u-sender"]


def test_other_events_still_ignored(server, monkeypatch, tmp_path):
    # Event không phải user_send_*/follow (unfollow, oa_..., ...) vẫn
    # ignore hoàn toàn — không dispatch, không convlog.
    calls = []
    monkeypatch.setattr(zalo, "handle_text", lambda *a: calls.append(a))
    monkeypatch.setattr(zalo, "_reply_non_text", lambda *a: calls.append(a))
    monkeypatch.setattr(zalo, "handle_follow", lambda *a: calls.append(a))
    for event in ("unfollow", "user_gets_feedback"):
        raw = json.dumps(_event(event=event)).encode()
        assert httpx.post(server, content=raw,
                          headers={"X-ZEvent-Signature": _sign(raw)}
                          ).status_code == 200
    time.sleep(0.2)
    assert not calls
    assert not (tmp_path / "conversations.jsonl").exists()


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
    monkeypatch.setattr(zalo, "OA_SECRET", SECRET)
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
    # D6.1: answer trong log = text ĐÃ GỬI (HANDOFF_TEXT), `answered`
    # vẫn tính trên raw NO_DATA của answer().
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
    assert rec["answer"] == zalo.HANDOFF_TEXT


def test_no_data_sends_handoff_text(monkeypatch):
    # D6.1: answer() NO_DATA -> khách nhận HANDOFF_TEXT (có hotline),
    # không phải câu "Chưa đủ dữ liệu" trần; lượt vẫn vào history.
    from api.rag import NO_DATA
    sent, calls = {}, []
    monkeypatch.setattr("api.rag.answer",
                        lambda q, history=None: calls.append((q, history))
                        or {"answer": NO_DATA, "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(text=t) or True)
    r = zalo.handle_text("u10", "Saphraton chữa ung thư không?")
    assert sent["text"] == zalo.HANDOFF_TEXT
    assert r["text"] == zalo.HANDOFF_TEXT
    assert "1800577732" in sent["text"]
    # Lượt 2: history phải chứa lượt 1 (NO_DATA vẫn là lượt hợp lệ).
    zalo.handle_text("u10", "vậy còn loại khác?")
    assert calls[1][1] == [{"role": "user", "content": calls[0][0]},
                           {"role": "assistant", "content": NO_DATA}]


def test_unanswered_reads_queue(monkeypatch, tmp_path):
    # D6.2: unanswered() đọc convlog + backup .1, trả đúng entry
    # answered:false; dòng lỗi/answered:true bị bỏ qua.
    log = tmp_path / "conversations.jsonl"
    bak = tmp_path / "conversations.jsonl.1"
    bak.write_text(json.dumps({"answered": False, "question": "cũ"}) + "\n",
                   encoding="utf-8")
    log.write_bytes(
        (json.dumps({"answered": False, "question": "mới"}) + "\n"
         + json.dumps({"answered": True, "question": "ok"}) + "\n"
         + "dòng hỏng\n").encode() + b"\xff\xfe\n")
    recs = zalo.unanswered()
    assert [r["question"] for r in recs] == ["cũ", "mới"]


def test_unanswered_missing_empty_bak_only(tmp_path):
    # D6.2 edge: chưa có convlog -> [] (empty-state); chỉ có .1 (file
    # mới sau rotate chưa ghi) -> vẫn đọc entry cũ; file rỗng -> [].
    assert zalo.unanswered() == []
    (tmp_path / "conversations.jsonl.1").write_text(
        json.dumps({"answered": False, "question": "cũ"}) + "\n",
        encoding="utf-8")
    assert [r["question"] for r in zalo.unanswered()] == ["cũ"]
    (tmp_path / "conversations.jsonl").write_bytes(b"")
    assert [r["question"] for r in zalo.unanswered()] == ["cũ"]


def test_startup_error_fail_closed(monkeypatch):
    # D4.2+D5.1+V1.1/V1.2: DEPLOY truthy (1/true/yes) mà thiếu
    # ZALO_OA_SECRET (không verify signature được) HOẶC không có đường
    # send nào (thiếu access token lẫn bộ refresh) -> refuse to serve;
    # chỉ có bộ refresh (không access token) vẫn serve được — send_text
    # sẽ lazy-refresh lần đầu. Dev local (tắt/sai format) vẫn serve.
    monkeypatch.setenv("DEPLOY", "1")
    for attr in ("OA_SECRET", "APP_SECRET", "APP_ID",
                 "ACCESS_TOKEN", "REFRESH_TOKEN"):
        monkeypatch.setattr(zalo, attr, "")
    assert zalo._startup_error() is not None   # thiếu OA_SECRET
    monkeypatch.setattr(zalo, "OA_SECRET", SECRET)
    assert zalo._startup_error() is not None   # không đường send nào
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "tok")
    assert zalo._startup_error() is None       # send qua access token
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "rtok")
    # refresh_token trần không đủ — cần đủ bộ APP_ID+APP_SECRET mới
    # gọi oauth refresh được.
    assert zalo._startup_error() is not None
    monkeypatch.setattr(zalo, "APP_ID", "app")
    assert zalo._startup_error() is not None   # vẫn thiếu APP_SECRET
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    assert zalo._startup_error() is None       # send qua refresh flow
    for v in ("true", "YES"):                  # truthy variants (D5.1)
        monkeypatch.setenv("DEPLOY", v)
        monkeypatch.setattr(zalo, "OA_SECRET", "")
        assert zalo._startup_error() is not None
    monkeypatch.setenv("DEPLOY", "0")          # không phải truthy -> dev
    monkeypatch.setattr(zalo, "OA_SECRET", "")
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


def test_chunked_post_rejected_411(server):
    # D5.9: request chunked (không Content-Length) -> 411 rõ ràng thay
    # vì length=0 -> body bỏ sót/403 mập mờ. Hành vi định nghĩa trước
    # khi ai đó bật keep-alive. Raw socket: httpx flake ReadError khi
    # server reject sớm + đóng connection giữa chừng client stream body.
    import socket
    from urllib.parse import urlparse
    u = urlparse(server)
    with socket.create_connection((u.hostname, u.port), timeout=5) as s:
        s.sendall(b"POST /zalo-webhook HTTP/1.1\r\n"
                  b"Host: x\r\n"
                  b"Content-Type: application/json\r\n"
                  b"Transfer-Encoding: chunked\r\n\r\n"
                  b"2\r\n{}\r\n0\r\n\r\n")
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
    assert resp.split(b"\r\n")[0].startswith(b"HTTP/1.0 411")


def test_convlog_masks_spaced_phone(monkeypatch, tmp_path):
    # D5.10: SĐT viết cách (space/dash/dot) cũng phải mask — regex cũ
    # chỉ bắt dính liền. Giá tiền "1.500.000" không bị ăn oan.
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u7",
                     "gọi 0901 234 567 hoặc 0901-234-567, giá 1.500.000?",
                     msg_id="m-pii2")
    rec = json.loads((tmp_path / "conversations.jsonl")
                     .read_text(encoding="utf-8").strip())
    assert rec["question"] == "gọi *** hoặc ***, giá 1.500.000?"


def test_mask_pii_regex_boundaries():
    # D5.10 biên: không ăn số đứng trước (giá "10.050.000.000"), mask
    # hết run số dài (không lộ đuôi), không đụng ngày "05.10.2026".
    m = zalo._mask_pii
    assert m("giá 10.050.000.000 đ") == "giá 10.050.000.000 đ"
    assert m("giá 1.500.000") == "giá 1.500.000"
    assert m("ngày 05.10.2026") == "ngày 05.10.2026"
    assert m("090123456789012") == "***"          # run dài -> mask hết
    assert m("0901 234 567 890") == "***"          # spaced run dài cũng vậy
    assert m("2026 0901 234 567") == "2026 ***"    # phone sau số khác
    assert m("0901234567") == "***"                # regression: dính liền
    assert m("gọi 0901 234 567 giúp") == "gọi *** giúp"


def test_convlog_purges_entries_older_than_retain_days(tmp_path,
                                                      monkeypatch):
    # D5.11 + V3.3: retention theo tuổi — dòng ts cũ hơn RETAIN_DAYS bị
    # purge. ĐỔI CONTRACT v1.2 — trước "thà giữ thừa": giờ dòng corrupt /
    # thiếu ts / ts sai format cũng bị DROP (không chứng minh được tuổi
    # = không được nằm lại — dòng corrupt giữ PII mãi mãi mà unanswered()
    # vốn skip nó). ts len-20 nhưng strptime fail + ts tương lai xa
    # (> now+1d slack clock-skew) cũng drop; ts now+1h trong slack vẫn
    # giữ. Byte lỗi UTF-8 (dòng ghi dở) + U+2028 trong question vẫn
    # không được phá purge hay cắt đôi record: purge không throw trên
    # input xấu, chỉ drop dòng.
    log = tmp_path / "conversations.jsonl"
    old_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                           time.gmtime(time.time() - (zalo.RETAIN_DAYS + 1)
                                       * 86400))
    new_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # F2: ts valid-format nhưng tương lai xa (now+2d > horizon now+1d)
    # -> drop; ts now+1h trong slack clock-skew -> KEEP.
    future_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                              time.gmtime(time.time() + 2 * 86400))
    skew_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                            time.gmtime(time.time() + 3600))
    # ensure_ascii=False de U+2028 nam raw trong dong — splitlines()
    # cua ban cu se cat doi record nay lam no song sot qua purge.
    old_with_u2028 = json.dumps(
        {"ts": old_ts, "question": "a\u2028b"}, ensure_ascii=False)
    log.write_bytes(
        (json.dumps({"ts": old_ts, "question": "cũ"}) + "\n"
         + old_with_u2028 + "\n"
         + json.dumps({"ts": new_ts, "question": "mới"}) + "\n"
         + "dòng hỏng không phải json\n").encode()
        + b"\xff\xfe byte loi\n"  # byte không decode được UTF-8 -> drop
        # dict hợp lệ nhưng THIẾU ts -> drop; ts sai format -> drop
        + json.dumps({"question": "không ts"}).encode() + b"\n"
        + json.dumps({"ts": "không-phải-iso", "question": "x"}).encode()
        + b"\n"
        # F2: len 20 nhưng strptime fail -> drop; ts future xa -> drop;
        # ts trong slack +1d -> KEEP.
        + json.dumps({"ts": "9999-99-99T99:99:99Z",
                      "question": "rác"}).encode() + b"\n"
        + json.dumps({"ts": future_ts, "question": "xa"}).encode()
        + b"\n"
        + json.dumps({"ts": skew_ts, "question": "skew"}).encode()
        + b"\n")
    zalo._purge_convlog(log)
    raw = log.read_bytes()
    assert b"\xff\xfe" not in raw  # V3.3: dòng lỗi bị drop, không crash
    lines = [x for x in
             raw.decode("utf-8", "surrogateescape").split("\n") if x]
    assert len(lines) == 2  # chỉ "mới" + "skew" (slack clock-skew) còn
    recs = [json.loads(x) for x in lines]
    assert [r["question"] for r in recs] == ["mới", "skew"]
    assert "a\u2028b" not in raw.decode("utf-8", "surrogateescape")


def test_log_write_triggers_daily_purge(monkeypatch, tmp_path):
    # D5.11 (contract-gap): file ACTIVE cũng được purge khi có ghi mới
    # mà lần purge trước >1 ngày — process chạy lâu không giữ entry
    # quá hạn tới restart.
    log = tmp_path / "conversations.jsonl"
    old_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                           time.gmtime(time.time() - (zalo.RETAIN_DAYS + 1)
                                       * 86400))
    log.write_text(json.dumps({"ts": old_ts, "question": "cũ"}) + "\n",
                   encoding="utf-8")
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": "ok", "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    zalo.handle_text("u8", "câu mới")
    recs = [json.loads(x) for x in
            log.read_text(encoding="utf-8").splitlines()]
    assert [r["question"] for r in recs] == ["câu mới"]  # entry cũ bị purge


def test_purge_failure_still_logs_and_retries(monkeypatch, tmp_path):
    # D6.9: _purge_convlog throw (PermissionError/disk full) không được
    # giết _log_conversation — entry vẫn append; _last_purge KHÔNG set.
    # ĐỔI CONTRACT v1.3 (V4.1): trước đây lần ghi kế retry NGAY — đĩa
    # hỏng dai dẳng kéo mọi reply thread xếp hàng O(file) trong
    # _log_lock (audit v0.6.2 NIT). Giờ retry bị throttle PURGE_RETRY_S
    # qua _last_purge_attempt (set TRƯỚC try, ghi MỌI attempt).
    calls = []

    def boom(path):
        calls.append(path)
        raise PermissionError("locked")

    monkeypatch.setattr(zalo, "_purge_convlog", boom)
    zalo._log_conversation({"ts": "t1", "question": "a"})
    log = tmp_path / "conversations.jsonl"
    recs = [json.loads(x) for x in
            log.read_text(encoding="utf-8").splitlines()]
    assert [r["question"] for r in recs] == ["a"]  # entry vẫn ghi được
    assert zalo._last_purge == 0.0  # purge fail -> không đánh dấu
    assert zalo._last_purge_attempt > 0.0  # attempt ĐÃ đánh dấu
    # Ghi tiếp trong window PURGE_RETRY_S -> KHÔNG retry purge.
    zalo._log_conversation({"ts": "t2", "question": "b"})
    assert len(calls) == 1
    # Lùi attempt-stamp quá window -> lần ghi kế retry purge.
    monkeypatch.setattr(zalo, "_last_purge_attempt",
                        time.time() - zalo.PURGE_RETRY_S - 1)
    zalo._log_conversation({"ts": "t3", "question": "c"})
    assert len(calls) == 2
    # Purge thành công -> _last_purge set; ghi sau không attempt thêm.
    ok_calls = []
    monkeypatch.setattr(zalo, "_purge_convlog",
                        lambda p: ok_calls.append(p))
    monkeypatch.setattr(zalo, "_last_purge_attempt",
                        time.time() - zalo.PURGE_RETRY_S - 1)
    zalo._log_conversation({"ts": "t4", "question": "d"})
    assert len(ok_calls) == 1
    assert zalo._last_purge > 0.0  # thành công mới đánh dấu
    zalo._log_conversation({"ts": "t5", "question": "e"})
    assert len(ok_calls) == 1  # đã purge hôm nay -> daily gate chặn
    recs = [json.loads(x) for x in
            log.read_text(encoding="utf-8").splitlines()]
    assert [r["question"] for r in recs] == ["a", "b", "c", "d", "e"]


def test_rotate_purge_failure_still_appends(monkeypatch, tmp_path):
    # D6.9 cùng lớp lỗi: _purge_convlog(bak) throw trong nhánh rotate
    # cũng chỉ warn — entry vẫn append, rotate xảy ra bình thường.
    def boom(path):
        raise PermissionError("locked")

    monkeypatch.setattr(zalo, "CONV_LOG_MAX", 10)  # entry nào cũng vượt
    monkeypatch.setattr(zalo, "_last_purge", time.time())  # skip daily
    monkeypatch.setattr(zalo, "_purge_convlog", boom)
    log = tmp_path / "conversations.jsonl"
    bak = tmp_path / "conversations.jsonl.1"
    zalo._log_conversation({"ts": "t1", "question": "a"})
    zalo._log_conversation({"ts": "t2", "question": "b"})
    assert bak.exists()  # rotate vẫn chạy
    recs = [json.loads(x) for x in
            log.read_text(encoding="utf-8").splitlines()]
    assert [r["question"] for r in recs] == ["b"]


def test_ui_hash_per_session_stable():
    # D6.10: 2 session khác nhau -> 2 user_hash khác nhau (queue phân
    # biệt user UI); cùng session gọi lại (Streamlit rerun) -> hash
    # ổn định, vẫn đúng dạng sha256[:16].
    s1, s2 = {}, {}
    h1, h2 = zalo._ui_hash(s1), zalo._ui_hash(s2)
    assert h1 != h2
    assert zalo._ui_hash(s1) == h1
    assert len(h1) == 16
    assert h1 != zalo._uhash("streamlit")  # không còn gộp chung 1 hash


def test_mask_pii_vn_prefix_and_multi_sep():
    # D6.11: SĐT dạng +84/84 (không bắt đầu bằng 0) và sep lặp >=2 ký
    # tự cũng mask; regression giá/ngày/số ngắn không bị ăn oan.
    m = zalo._mask_pii
    assert m("+84901234567") == "***"
    assert m("84901234567") == "***"
    assert m("gọi +84 901 234 567 giúp") == "gọi *** giúp"
    assert m("0901  234  567") == "***"    # 2 dấu cách liền
    assert m("0901--234--567") == "***"    # 2 gạch liền
    # Regression biên — KHÔNG mask:
    assert m("giá 1.500.000") == "giá 1.500.000"
    assert m("giá 8.400.000") == "giá 8.400.000"
    assert m("giá 10.050.000.000") == "giá 10.050.000.000"
    assert m("giá 1.840.000") == "giá 1.840.000"
    assert m("giá 84.500.000") == "giá 84.500.000"
    assert m("ngày 05.10.2026") == "ngày 05.10.2026"
    assert m("năm 1984") == "năm 1984"     # "84" sau digit -> chặn
    assert m("mã 84") == "mã 84"           # "84" trần, không đủ số
    # Khoảng giá/ngày nối bằng " - " (sep TRỘN) không được nối thành 1
    # run — reviewer M1: `[ .-]*` cũ nuốt " - " -> mất cả khoảng.
    assert (m("50.000.000 - 100.000.000 - 200.000.000")
            == "50.000.000 - 100.000.000 - 200.000.000")
    assert (m("từ 01.01.2026 - 05.01.2026")
            == "từ 01.01.2026 - 05.01.2026")
    assert (m("lô 20.10.2026 - 05.11.2026 - 30.12.2026")
            == "lô 20.10.2026 - 05.11.2026 - 30.12.2026")
    assert m("giá 84 - 100.000.000") == "giá 84 - 100.000.000"
    assert (m("50.000.000 -100.000.000") == "50.000.000 -100.000.000")
    assert (m("50.000.000- 100.000.000") == "50.000.000- 100.000.000")


def test_mask_pii_parenthesized_phone():
    # V3.1: SĐT dạng ngoặc — _mask_pii chỉ unwrap nhóm ngoặc TOÀN-digit
    # (kèm '+' đầu) trước khi sub nên "+84 (90) ..." / "(0901) ..." vẫn
    # mask; sep class `[ .-]` giữ nguyên (nới nó sẽ mở lại bridging).
    m = zalo._mask_pii
    for s in ("+84 (90) 123 4567", "(+84) 901234567",
              "(0901) 234 567", "0 (901) 234 567"):
        assert m(s).strip() == "***", s
    # Regression biên — KHÔNG over-match khi có ngoặc lân cận: ngoặc
    # bọc NON-digit (giá có '.') giữ nguyên văn -> ")" tự chặn bridging
    # (reviewer F1: normalize mọi ngoặc -> space cũ làm ")(" -> sep-run
    # nối "1.500.000"+"2.000.000" thành run >=9 -> ăn cả 2 giá).
    assert (m("(50.000.000) - (100.000.000)")
            == "(50.000.000) - (100.000.000)")
    assert m("1.500.000 (đã gồm VAT)") == "1.500.000 (đã gồm VAT)"
    assert m("05.10.2026") == "05.10.2026"
    assert m("(1.500.000)(2.000.000)") == "(1.500.000)(2.000.000)"
    assert (m("gia 1.500.000 (2.000.000)")
            == "gia 1.500.000 (2.000.000)")
    assert (m("(1.000.000) (2.000.000)") == "(1.000.000) (2.000.000)")
    assert (m("(100.000.000)(50.000.000)")
            == "(100.000.000)(50.000.000)")


def test_mask_pii_paren_mixed_sep_and_nested():
    # V5.1: 2 lớp lách cold-check v1.2 flag (MINOR) — verify probe
    # 2026-10-09 còn lọt trên code trước vá:
    # (a) SĐT chia qua nhóm ngoặc nối sep TRỘN: "(0901) - (234) - (567)"
    #     — sau unwrap, joint ") - (" thành " - " (space+dash+space) mà
    #     luật sep cùng-ký-tự (D6.11) chặn -> từng cụm <9 số không mask.
    # (b) ngoặc lồng / ngoặc có space trong: "((0901))234567",
    #     "( 0901 ) 234 567" — unwrap strict `\+?\d+` của V3.1 không bắt
    #     lớp ngoài -> ")" chặn bridge.
    # r2 (cold-check v1.4): quét 1 lượt O(n) thay fixpoint regex (bản
    # fixpoint O(n*depth) — DoS CPU) + không còn cap-32-vòng (MINOR 1:
    # nesting >32 lọt — scanner khớp depth tùy ý).
    m = zalo._mask_pii
    for s in ("(0901) - (234) - (567)", "(0901)-(234)-(567)",
              "(0901).(234).(567)", "(0901) (234) (567)",
              "(0901)((234))(567)", "(0) - (901) - (234) - (567)",
              "(09) (01) (23) (45) (67)", "(+84) (901) - (234) - (567)",
              "(0901) - (234) - (567) - (8901)",
              "((0901)) 234 567", "(((0901))) 234 567",
              "((0901)) - (234) - (567)",
              "((0901)) - ((234)) - ((567))",
              "call ((0901))234567 now", "x(0901) - (234) - (567)y",
              "( 0901 ) 234 567", "(0 901) 234 567",
              # MINOR 1 cũ: nesting vượt cap-32 -> lọt; scanner không cap
              "(" * 40 + "0901" + ")" * 40 + "234567"):
        assert "***" in m(s), s
    # Regression biên — KHÔNG over-match: ngoặc bọc NON-digit (giá có
    # '.') không merge -> ")" vẫn chặn bridge (lớp lỗi reviewer F1 v1.2).
    assert (m("(50.000.000) - (100.000.000)")
            == "(50.000.000) - (100.000.000)")
    assert m("(1.500.000)(2.000.000)") == "(1.500.000)(2.000.000)"
    assert (m("(1.000.000) (2.000.000)") == "(1.000.000) (2.000.000)")
    assert m("gia 1.500.000 (2.000.000)") == "gia 1.500.000 (2.000.000)"
    assert (m("50.000.000 - 100.000.000 - 200.000.000")
            == "50.000.000 - 100.000.000 - 200.000.000")
    assert m("từ 01.01.2026 - 05.01.2026") == "từ 01.01.2026 - 05.01.2026"
    # Cụm ngoặc-digit đứng RIÊNG (không kề nhóm ngoặc khác / không đủ
    # số) vẫn không bị cuốn: "(0901) - (234)" chỉ 7 số.
    assert "12345" in m("đơn (12345)")          # distortion MINOR giữ
    assert m("(0901) - (234)") == " 0901 234 "  # <9 số -> không mask
    assert "(abc)" in m("(abc) (123)")          # non-digit group giữ


def test_mask_pii_paren_merge_overmask_accepted():
    # cold-check v1.4 MINOR 2 — ACCEPT có chủ đích, ghi nhận bằng test:
    # nhóm ngoặc toàn-digit không phải SĐT mà merge đủ >=9 số vẫn bị
    # mask ("che thừa, không rò" — consistent someday over-mask nhẹ).
    # Vá rẻ (gate first-digit 0/+/8) bị loại: phá group giữa-chuỗi
    # "(90)" trong "+84 (90) 123 4567" — group con hợp lệ không tự
    # biết nó là đầu hay giữa run (lookahead = phi tuyến).
    m = zalo._mask_pii
    assert m("giá (500) - (0) - (000) - (000) - (000)") == "giá  500 *** "
    assert m("(01) - (02) - (2026) 0123") == " ***"


def test_mask_pii_pathological_input_bounded():
    # cold-check v1.4 MAJOR — perf contract: O(n), không quadratic.
    # Event-based: scanner phải XONG (không treo) trên paren sâu/chuỗi
    # dài; kết quả đúng khi input hợp lệ, raw-tail chấp nhận khi input
    # pathological vượt budget.
    m = zalo._mask_pii
    assert "***" in m("(" * 800 + "0901" + ")" * 800 + "234567")
    assert "***" in m("(0901) - " * 400 + "(234) - (567)")
    # unclosed pathological — abort budget, không treo, không crash;
    # V6.1: đuôi còn '(' -> '***' (không emit raw -> không lọt digit).
    out = m("(" * 5000 + "0901234567")
    assert isinstance(out, str)
    assert "0901234567" not in out


def test_mask_pii_budget_abort_masks_tail():
    # V6.1 (cold-check v1.4 MINOR): "(" * ~26 + ký tự lạ + SĐT ngoặc —
    # mỗi '(' rescan tới 'x'/EOF, budget 4n cạn giữa chừng -> bản cũ
    # emit đuôi RAW -> "(0901) - (234) - (567)" lọt trọn. Vá: đuôi còn
    # '(' -> "***" (không-rò hơn mất context của input bệnh lý); đuôi
    # không ngoặc vẫn emit raw (bare digit _PII_RE tự bắt).
    m = zalo._mask_pii
    for s in ("(" * 26 + "x" + "(0901) - (234) - (567)",
              "(" * 26 + "x" + "(0901) 234 567",
              "(" * 40 + "(0901) - (234) - (567)" + ")" * 30):
        r = m(s)
        assert "***" in r, s
        assert "0901" not in r, s


def test_mask_pii_paren_bare_mixed_bridge():
    # V6.2: SĐT lẫn ngoặc + bare qua sep TRỘN — "(0901) - 234.567" và
    # "0901 - (234) - (567)" trước lọt (group unwrap nhưng " - " trộn
    # không nối bare-run, '.' cắt run -> mỗi cụm <10 số). Vá: group
    # ngoặc là "mỏ neo", nối bare-run kề trước/sau vào blob sep ' '
    # CHỈ khi tổng digit >= 10 — 2 bare-run trần vẫn không nối được
    # (giữ luật chống bridging khoảng giá reviewer M1).
    m = zalo._mask_pii
    for s in ("(0901) - 234.567", "0901 - (234) - (567)",
              "goi (0901) - 234.567 nhe", "(0901).234.567",
              "0901- (234) -567", "+84 - (901) - 234567",
              "(+84) - 901.234.567", "0901 - (234) - 567",
              "(1) 0901 - (234) - (567)"):
        assert "***" in m(s), s
    # <10 digit -> KHÔNG bridge, hành vi cũ giữ nguyên.
    assert m("(0901) - (234)") == " 0901 234 "
    assert m("đơn 05.10 (2)") == "đơn 05.10  2 "
    # 2 bare-run không có group neo vẫn không nối — khoảng giá an toàn.
    assert m("0901 - 234.567") == "0901 - 234.567"
    assert (m("50.000.000 - 100.000.000") == "50.000.000 - 100.000.000")
    # Group non-digit (giá trong ngoặc) vẫn không làm mỏ neo.
    assert (m("gia 1.500.000 (2.000.000)") == "gia 1.500.000 (2.000.000)")
    assert "(abc)" in m("(abc) (123)")
    # Over-mask hướng an toàn giữ: blob >=10 digit quanh group ngoặc
    # vẫn bị che ("giá 50.000.000 - (1)" 9 số -> không bridge).
    assert (m("gia 50.000.000 - (1)") == "gia 50.000.000 -  1 ")


def test_mask_pii_email_rfc_bound_edge():
    # V6.3 (cold-check v1.4 MINOR): local-part/label quá bound cũ
    # ({1,64}/{1,63}) mask một phần -> lộ đầu local. Bound nới 256/253
    # (vẫn bounded -> O(n), khác unbounded `+` quadratic); email thật
    # đủ, RFC-invalid dài vẫn mask trọn — hướng che thừa.
    m = zalo._mask_pii
    assert m("mail a@b.com nhe") == "mail *** nhe"
    assert m("a" * 64 + "@b.co") == "***"
    assert m("a" * 70 + "@gmail.com") == "***"      # >64 cũ lộ đầu
    assert m("a" * 256 + "@b.co") == "***"          # biên trong
    assert m("u@" + "b" * 70 + ".com") == "***"     # label >63 cũ lọt
    # Residual chấp nhận: local >256 vẫn lộ phần đầu (pathological,
    # RFC-invalid) — nhưng domain + đuôi local vẫn bị che.
    r = m("a" * 300 + "@x.co")
    assert "***" in r and "@x.co" not in r


class _Resp:
    """Response giả cho httpx.post mock — đủ 3 member zalo.py đọc."""

    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def _env_full_refresh(monkeypatch):
    """Seed env đủ bộ refresh (access token cũ + refresh creds)."""
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "old-tok")
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "old-rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")


def test_token_store_env_seed_and_file_priority(monkeypatch, tmp_path):
    # V1.1: store chưa có -> env ZALO_ACCESS_TOKEN/ZALO_REFRESH_TOKEN
    # làm seed; store có -> file là source-of-truth thắng env. File
    # hỏng -> fallback env, không crash.
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "env-tok")
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "env-rtok")
    assert zalo._current_access_token() == "env-tok"
    assert zalo._current_refresh_token() == "env-rtok"
    zalo._write_token_store({"access_token": "file-tok",
                             "refresh_token": "file-rtok",
                             "expires_at": 1.0})
    assert zalo._current_access_token() == "file-tok"
    assert zalo._current_refresh_token() == "file-rtok"
    (tmp_path / "zalo_tokens.json").write_bytes(b"{not json")
    assert zalo._current_access_token() == "env-tok"


def test_send_fail_refreshes_then_retries_once(monkeypatch):
    # V1.1: send API báo lỗi rõ (token hết hạn) + đủ credential refresh
    # -> refresh rồi retry ĐÚNG 1 lần với token mới từ store.
    _env_full_refresh(monkeypatch)
    calls = []

    def fake_post(url, **kw):
        calls.append((url, kw))
        if url == zalo.OAUTH_URL:
            assert kw["headers"]["secret_key"] == "sec"
            assert kw["data"]["refresh_token"] == "old-rtok"
            assert kw["data"]["grant_type"] == "refresh_token"
            return _Resp(200, {"access_token": "new-tok",
                               "refresh_token": "new-rtok",
                               "expires_in": "3600"})
        tok = kw["params"]["access_token"]
        return (_Resp(200, {"error": -216, "message": "token expired"})
                if tok == "old-tok"
                else _Resp(200, {"error": 0, "message": "success"}))

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "xin chào") is True
    sends = [c for c in calls if c[0] == zalo.SEND_URL]
    assert [s[1]["params"]["access_token"] for s in sends] == [
        "old-tok", "new-tok"]


def test_send_fail_refresh_fail_returns_false(monkeypatch):
    # V1.1: send lỗi mà refresh cũng lỗi -> False, KHÔNG retry send,
    # không throw (reply path sống tiếp).
    _env_full_refresh(monkeypatch)
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(500, {})
        return _Resp(200, {"error": -216, "message": "token expired"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is False
    assert calls.count(zalo.SEND_URL) == 1  # không retry khi refresh fail
    assert calls.count(zalo.OAUTH_URL) == 1


def test_send_without_token_refreshes_first(monkeypatch):
    # V1.1 nhánh deploy chỉ có bộ refresh (không seed access token):
    # send_text tự refresh lấy token trước rồi mới gọi send API — đây
    # là lý do _startup_error cho serve khi chỉ có REFRESH+APP_ID+SECRET.
    monkeypatch.setattr(zalo, "ACCESS_TOKEN", "")
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(200, {"access_token": "new-tok",
                               "refresh_token": "new-rtok",
                               "expires_in": "3600"})
        assert kw["params"]["access_token"] == "new-tok"
        return _Resp(200, {"error": 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is True
    assert calls == [zalo.OAUTH_URL, zalo.SEND_URL]  # refresh trước send


def test_refresh_rotates_and_persists_store(monkeypatch, tmp_path):
    # V1.1: refresh thành công -> persist cả access_token lẫn
    # refresh_token MỚI (rotation) + expires_at; các getter đọc lại
    # thấy token mới, token cũ không còn đâu.
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "old-rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")

    def fake_post(url, **kw):
        return _Resp(200, {"access_token": "new-tok",
                           "refresh_token": "new-rtok",
                           "expires_in": "3600"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.refresh_access_token() is True
    store = json.loads((tmp_path / "zalo_tokens.json")
                       .read_text(encoding="utf-8"))
    assert store["access_token"] == "new-tok"
    assert store["refresh_token"] == "new-rtok"
    assert store["expires_at"] > time.time()
    assert zalo._current_access_token() == "new-tok"
    assert zalo._current_refresh_token() == "new-rtok"


def test_refresh_without_credentials_fails_closed(monkeypatch):
    # V1.1: thiếu refresh_token/app creds -> warn + False, KHÔNG gọi
    # network, không throw.
    def boom(url, **kw):
        raise AssertionError("không được gọi network")

    monkeypatch.setattr(httpx, "post", boom)
    for attr in ("REFRESH_TOKEN", "APP_ID", "APP_SECRET"):
        monkeypatch.setattr(zalo, attr, "")
    assert zalo.refresh_access_token() is False


def test_concurrent_refresh_serializes_rotation(monkeypatch):
    # V1.1 thread-safety: 2 reply thread cùng thấy send fail -> cùng
    # refresh; _token_lock buộc tuần tự nên lần refresh sau phải gửi
    # refresh_token ĐÃ ROTATE của lần trước (không lock -> cả hai gửi
    # token cũ, bên thua ghi đè mất token mới nhất).
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "rtok-0")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    seen_refresh = []
    seq = itertools.count(1)
    first_entered, release = threading.Event(), threading.Event()

    def fake_post(url, **kw):
        seen_refresh.append(kw["data"]["refresh_token"])
        n = next(seq)
        if n == 1:
            first_entered.set()
            release.wait(5)  # giữ thread 1 trong critical section
        return _Resp(200, {"access_token": f"at-{n}",
                           "refresh_token": f"rtok-{n}",
                           "expires_in": "3600"})

    monkeypatch.setattr(httpx, "post", fake_post)
    t1 = threading.Thread(target=zalo.refresh_access_token)
    t2 = threading.Thread(target=zalo.refresh_access_token)
    t1.start()
    assert first_entered.wait(5)
    t2.start()
    time.sleep(0.2)  # cho t2 cơ hội chạy — nó phải đang chờ lock
    try:
        assert seen_refresh == ["rtok-0"]  # t2 chưa vào được oauth
    finally:
        release.set()
    t1.join()
    t2.join()
    assert seen_refresh == ["rtok-0", "rtok-1"]


def test_send_fail_refresh_throttled_within_interval(monkeypatch):
    # Reviewer M3: send-fail thứ 2 trong REFRESH_MIN_INTERVAL_S không
    # rotate lại (lỗi không-liên-quan-token không burn oauth); retry
    # vẫn 1 lần với token hiện hành (vừa rotate <interval trước).
    _env_full_refresh(monkeypatch)
    monkeypatch.setattr(zalo, "_last_refresh", 0.0)
    calls = []
    n = itertools.count(1)

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(200, {"access_token": f"tok-{next(n)}",
                               "refresh_token": "rtok-x",
                               "expires_in": "3600"})
        return _Resp(200, {"error": -216, "message": "fail"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is False  # refresh 1 lần rồi vẫn fail
    assert calls.count(zalo.OAUTH_URL) == 1
    assert zalo.send_text("u1", "x") is False  # fail nữa — KHÔNG refresh
    assert calls.count(zalo.OAUTH_URL) == 1    # throttled
    assert calls.count(zalo.SEND_URL) == 4     # mỗi lần: try + retry


def test_send_proactively_refreshes_expiring_token(monkeypatch):
    # V2.1: store có expires_at sắp tới (< REFRESH_AHEAD_S) -> refresh
    # TRƯỚC khi send, khách không ăn lượt reply fail khi token vừa chết.
    _env_full_refresh(monkeypatch)
    zalo._write_token_store({"access_token": "old-tok",
                             "refresh_token": "old-rtok",
                             "expires_at": time.time() + 60})
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            assert kw["data"]["refresh_token"] == "old-rtok"
            return _Resp(200, {"access_token": "new-tok",
                               "refresh_token": "new-rtok",
                               "expires_in": "3600"})
        assert kw["params"]["access_token"] == "new-tok"  # send = token mới
        return _Resp(200, {"error": 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is True
    assert calls == [zalo.OAUTH_URL, zalo.SEND_URL]  # refresh trước send


def test_send_skips_refresh_when_token_fresh(monkeypatch):
    # V2.1: expires_at còn xa REFRESH_AHEAD_S -> KHÔNG gọi oauth, send
    # thẳng token hiện tại.
    _env_full_refresh(monkeypatch)
    zalo._write_token_store({"access_token": "old-tok",
                             "refresh_token": "old-rtok",
                             "expires_at": time.time() + 3600})
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        return _Resp(200, {"error": 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is True
    assert calls == [zalo.SEND_URL]  # không oauth


def test_send_proactive_refresh_fail_still_sends_old(monkeypatch):
    # V2.1 best-effort: proactive refresh fail (oauth 500) -> vẫn thử
    # send bằng token hiện tại (expires_at có thể lạc quan).
    _env_full_refresh(monkeypatch)
    zalo._write_token_store({"access_token": "old-tok",
                             "refresh_token": "old-rtok",
                             "expires_at": time.time() + 60})
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(500, {})
        assert kw["params"]["access_token"] == "old-tok"  # fallback token cũ
        return _Resp(200, {"error": 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is True
    assert calls == [zalo.OAUTH_URL, zalo.SEND_URL]


def test_send_fail_after_failed_refresh_no_stale_retry(monkeypatch):
    # V2.2: refresh attempt vừa fail (<REFRESH_MIN_INTERVAL_S) mà send
    # cũng fail -> KHÔNG retry với token hỏng (waste). Code cũ đánh dấu
    # _last_refresh cả attempt-fail -> nhánh "fresh" retry bằng token
    # chết (SEND sẽ là 3 thay vì 2).
    _env_full_refresh(monkeypatch)
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(500, {})      # refresh luôn fail
        return _Resp(200, {"error": -216, "message": "token expired"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is False
    # Lần 1: send-fail -> không ai refresh gần -> attempt refresh (fail)
    # -> không retry: SEND=1, OAUTH=1.
    assert calls.count(zalo.SEND_URL) == 1
    assert calls.count(zalo.OAUTH_URL) == 1
    assert zalo.send_text("u1", "x") is False
    # Lần 2 <60s: attempt-fail gần đây -> không rotate thêm, cũng không
    # retry stale: SEND=2 (không phải 3), OAUTH vẫn 1 (throttle giữ).
    assert calls.count(zalo.SEND_URL) == 2
    assert calls.count(zalo.OAUTH_URL) == 1


def test_refresh_persist_fail_keeps_tokens_in_memory(monkeypatch):
    # V2.3: _write_token_store OSError (disk full/lock) sau khi server
    # đã rotate refresh_token -> token chỉ còn bản MỚI trong _mem_tokens
    # (bản trên đĩa/env đã vô hiệu). refresh vẫn trả True (token dùng
    # được trong-process); refresh LẦN SAU phải gửi rotated token từ
    # mem, không phải bản chết.
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "old-rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    seen_refresh = []

    def fake_post(url, **kw):
        seen_refresh.append(kw["data"]["refresh_token"])
        n = len(seen_refresh)
        return _Resp(200, {"access_token": f"at-{n}",
                           "refresh_token": f"rt-{n}",
                           "expires_in": "3600"})

    monkeypatch.setattr(httpx, "post", fake_post)

    def boom(obj):
        raise OSError("disk full")

    monkeypatch.setattr(zalo, "_write_token_store", boom)
    assert zalo.refresh_access_token() is True
    assert zalo._current_access_token() == "at-1"
    assert zalo._current_refresh_token() == "rt-1"   # từ mem, không phải env
    assert zalo.refresh_access_token() is True
    assert seen_refresh == ["old-rtok", "rt-1"]      # lần 2 gửi rotated
    assert zalo._current_access_token() == "at-2"


def test_mem_tokens_cleared_after_successful_persist(monkeypatch):
    # V2.3 + cold-check v1.1 F1: persist OK -> _mem_tokens xoá, store
    # lại là source-of-truth — process khác (preflight --refresh hay
    # operator sửa tay data/zalo_tokens.json) ghi store mới phải được
    # tôn trọng. Nếu mem đè store, server refresh bằng refresh_token đã
    # bị rotate -> fail vĩnh viễn tới restart (regression v1.0).
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "old-rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp(
        200, {"access_token": "at-1", "refresh_token": "rt-1",
              "expires_in": "3600"}))
    assert zalo.refresh_access_token() is True
    assert zalo._mem_tokens == {}              # persist OK -> mem trống
    # Process khác ghi store trực tiếp (preflight rotate):
    zalo._write_token_store({"access_token": "ext-tok",
                             "refresh_token": "ext-rtok",
                             "expires_at": time.time() + 3600})
    assert zalo._current_access_token() == "ext-tok"   # không bị mem đè
    assert zalo._current_refresh_token() == "ext-rtok"


def test_non_text_waits_for_text_lock(monkeypatch):
    # V2.4: handle_non_text đi qua cùng _ulock(user) với handle_text —
    # ảnh đến trong lúc text reply đang chạy phải CHỜ, không chen gửi
    # trước (code cũ dispatch _reply_non_text trần -> gửi NGAY trong
    # lúc text còn đang answer -> đảo thứ tự).
    entered, release = threading.Event(), threading.Event()
    sent = []

    def slow_answer(q, history=None):
        entered.set()
        release.wait(5)          # giữ _ulock trong khi answer chạy
        return {"answer": "a", "sources": []}

    monkeypatch.setattr("api.rag.answer", slow_answer)
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    t1 = threading.Thread(target=zalo.handle_text, args=("u1", "q"))
    t1.start()
    assert entered.wait(5)       # t1 đang giữ _ulock bên trong answer()
    t2 = threading.Thread(target=zalo.handle_non_text,
                          args=("u1", "user_send_image"))
    t2.start()
    time.sleep(0.3)              # t2 không lock sẽ gửi NGAY trong lúc này
    assert sent == []            # vẫn chờ lock -> chưa gửi gì
    release.set()
    t1.join()
    t2.join()
    assert sent == ["a", zalo.NON_TEXT_TEXT]  # đúng thứ tự dispatch


def test_proactive_refresh_throttled_when_oauth_down(monkeypatch):
    # V2.1+F1: token sắp hết + oauth sập -> send_text KHÔNG gọi oauth
    # mỗi lần (mỗi call tới 15s-timeout = hammer + reply chậm); throttle
    # trên _last_refresh (attempt) — send thứ 2 trong interval đi thẳng
    # bằng token hiện tại.
    _env_full_refresh(monkeypatch)
    zalo._write_token_store({"access_token": "old-tok",
                             "refresh_token": "old-rtok",
                             "expires_at": time.time() + 60})
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if url == zalo.OAUTH_URL:
            return _Resp(500, {})      # oauth sập
        return _Resp(200, {"error": 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert zalo.send_text("u1", "x") is True   # attempt refresh fail -> send cũ
    assert zalo.send_text("u1", "x") is True   # throttled — không oauth lại
    assert calls.count(zalo.OAUTH_URL) == 1
    assert calls.count(zalo.SEND_URL) == 2


def test_send_fail_waits_for_inflight_refresh(monkeypatch):
    # V2.2+F2: send-fail trong lúc thread khác ĐANG refresh (_token_lock
    # đang giữ, _last_refresh vừa set) -> chờ refresh xong rồi retry bằng
    # token MỚI — không return False mất reply. Code cũ coi "attempt
    # gần đây" = "đã fail" -> bỏ retry.
    _env_full_refresh(monkeypatch)
    entered, release = threading.Event(), threading.Event()
    sent_tokens = []

    def fake_post(url, **kw):
        if url == zalo.OAUTH_URL:
            entered.set()
            release.wait(5)          # giữ _token_lock trong oauth call
            return _Resp(200, {"access_token": "new-tok",
                               "refresh_token": "new-rtok",
                               "expires_in": "3600"})
        tok = kw["params"]["access_token"]
        sent_tokens.append(tok)
        return _Resp(200, {"error": -216 if tok == "old-tok" else 0})

    monkeypatch.setattr(httpx, "post", fake_post)
    t1 = threading.Thread(target=zalo.refresh_access_token)
    t1.start()
    assert entered.wait(5)           # t1 đang giữ _token_lock trong oauth
    res = {}
    t2 = threading.Thread(target=lambda: res.update(
        ok=zalo.send_text("u1", "x")))
    t2.start()
    time.sleep(0.3)                  # t2 phải đang block trên _token_lock
    assert "ok" not in res           # chưa return — đang chờ refresh
    release.set()
    t1.join(5)
    t2.join(5)
    assert res["ok"] is True         # retry bằng token mới thành công
    assert sent_tokens == ["old-tok", "new-tok"]


def test_refresh_expires_in_zero_stored_as_unknown(monkeypatch):
    # V2.1+F1c: oauth thiếu/trả expires_in=0 -> expires_at = 0 ("không
    # biết"), KHÔNG phải ~now — nếu không _token_expiring_soon luôn đúng
    # và mọi send_text đều rotate token (poison qua proactive refresh).
    monkeypatch.setattr(zalo, "REFRESH_TOKEN", "rtok")
    monkeypatch.setattr(zalo, "APP_ID", "app")
    monkeypatch.setattr(zalo, "APP_SECRET", "sec")
    monkeypatch.setattr(httpx, "post", lambda url, **kw: _Resp(
        200, {"access_token": "new-tok", "refresh_token": "new-rtok",
              "expires_in": "0"}))
    assert zalo.refresh_access_token() is True
    assert zalo._current_expires_at() == 0.0
    assert not zalo._token_expiring_soon()
