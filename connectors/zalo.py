"""Zalo OA webhook connector — nhận event -> ACK 200 nhanh -> reply async.

Spec webhook (docs.zaloplatforms.com):
- POST JSON, header `X-ZEvent-Signature` =
  `mac=` + sha256(app_id + raw_body + timestamp + OA_secret_key).
- event_name `user_send_text`: sender.id + message.{msg_id,text}.
- Zalo retry khi webhook timeout -> phải dedup msg_id, không thì reply nhân đôi.

`answer()` mất ~10s -> KHÔNG sync-block trong handler: ACK 200 trước rồi
trả lời async qua send API. Reply qua `pipelines.guardrail.check()`; bị flag
-> gửi FALLBACK, không gửi text vi phạm. Chỉ inbox reply — không endpoint
nào đăng bài/listing mới (C2.4).

Chạy: `python -m connectors.zalo` -> :8788/zalo-webhook (port qua
ZALO_WEBHOOK_PORT). Env: ZALO_APP_ID, ZALO_APP_SECRET, ZALO_ACCESS_TOKEN.
"""

import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

APP_ID = os.environ.get("ZALO_APP_ID", "")
APP_SECRET = os.environ.get("ZALO_APP_SECRET", "")
ACCESS_TOKEN = os.environ.get("ZALO_ACCESS_TOKEN", "")
PORT = int(os.environ.get("ZALO_WEBHOOK_PORT", "8788"))

SEND_URL = "https://openapi.zalo.me/v3.0/oa/message/cs"
MAX_TEXT = 2000  # giới hạn text của Zalo CS message
FALLBACK = ("Sâm Sâm xin lỗi, câu trả lời tự động chưa đạt kiểm duyệt nội "
            "bộ. Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.")

SEEN_TTL_S = 3600
SEEN_DB = ROOT / "data" / "zalo_seen.db"   # dedup sống qua restart (D3.5)
CONV_LOG = ROOT / "data" / "conversations.jsonl"  # log hội thoại (D3.3)

_seen_lock = threading.Lock()
_seen_conn: sqlite3.Connection | None = None  # lazy — không tạo file khi import
_log_lock = threading.Lock()


def verify_signature(raw: bytes, header: str) -> bool:
    """mac = sha256(app_id + raw_body + timestamp + OA_secret). Chưa cấu hình
    secret (dev local) -> bỏ qua; có secret mà sai/thiếu signature -> False."""
    if not APP_SECRET:
        return True
    try:
        data = json.loads(raw)
        expect = "mac=" + hashlib.sha256(
            (data["app_id"] + raw.decode() + str(data["timestamp"])
             + APP_SECRET).encode()).hexdigest()
        return hmac.compare_digest(header, expect)
    except (KeyError, ValueError, TypeError):
        return False


def _seen_db() -> sqlite3.Connection:
    """Mở connection lazy — file db chỉ sinh ra ở lần dedup đầu tiên,
    không phải lúc import module (giữ import nhẹ cho test/dev)."""
    global _seen_conn
    if _seen_conn is None:
        SEEN_DB.parent.mkdir(parents=True, exist_ok=True)
        _seen_conn = sqlite3.connect(SEEN_DB, check_same_thread=False)
        _seen_conn.execute(
            "CREATE TABLE IF NOT EXISTS seen("
            "event_id TEXT PRIMARY KEY, ts REAL)")
    return _seen_conn


def _dedup(event_id: str) -> bool:
    """True nếu event đã xử lý — Zalo retry khi timeout sẽ nhân đôi reply.
    Persist sqlite trên đĩa nên restart process không mất state."""
    now = time.time()
    with _seen_lock:
        conn = _seen_db()
        conn.execute("DELETE FROM seen WHERE ts < ?", (now - SEEN_TTL_S,))
        cur = conn.execute(
            "INSERT OR IGNORE INTO seen(event_id, ts) VALUES(?, ?)",
            (event_id, now))
        conn.commit()
        return cur.rowcount == 0  # 0 row = event_id đã tồn tại


def _log_conversation(entry: dict) -> None:
    """Append 1 dòng JSON vào conversations.jsonl. Lock vì nhiều thread
    reply song song; chỉ lưu user_hash, không lưu raw user_id (PII)."""
    CONV_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _log_lock, CONV_LOG.open("a", encoding="utf-8") as f:
        f.write(line)


def send_text(user_id: str, text: str) -> bool:
    """Gọi Zalo CS message API. Thiếu token -> warn + False (pipeline vẫn
    test được qua mock)."""
    if not ACCESS_TOKEN:
        print(f"[warn] zalo: chưa có ZALO_ACCESS_TOKEN — không gửi "
              f"(user={user_id})", flush=True)
        return False
    try:
        r = httpx.post(SEND_URL, params={"access_token": ACCESS_TOKEN},
                       json={"recipient": {"user_id": user_id},
                             "message": {"text": text[:MAX_TEXT]}},
                       timeout=15)
        ok = r.status_code == 200 and r.json().get("error") == 0
        if not ok:
            print(f"[warn] zalo: send API trả {r.status_code} "
                  f"{r.text[:200]}", flush=True)
        return ok
    except (httpx.HTTPError, ValueError) as e:
        print(f"[warn] zalo: send API lỗi {e!r}", flush=True)
        return False


def handle_text(user_id: str, question: str, msg_id: str = "") -> dict:
    """answer() -> guardrail -> send -> ghi conversation log. Lazy import
    vì api.rag nặng (numpy/psycopg/openai) — phần webhook thuần test
    không cần nó."""
    from api.rag import NO_DATA, answer
    from pipelines.guardrail import check

    t0 = time.time()
    res = answer(question)
    latency_ms = int((time.time() - t0) * 1000)
    text = res["answer"]
    # Check TRƯỚC khi append nguồn — URL là citation, slug tiếng Việt có
    # thể chứa từ cấm dạng viết trần ("chua-") và flag oan câu trả lời đúng.
    guardrail_ok = check(text)["ok"]
    if not guardrail_ok:
        print(f"[warn] zalo: reply bị guardrail chặn -> fallback "
              f"(user={user_id})", flush=True)
        text = FALLBACK
    elif res["sources"]:
        text += "\nNguồn: " + res["sources"][0]
    sent = send_text(user_id, text)
    _log_conversation({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "msg_id": msg_id,
        "user_hash": hashlib.sha256(user_id.encode()).hexdigest()[:16],
        "question": question,
        "answer": text[:500],
        "sources": res["sources"],
        "guardrail_ok": guardrail_ok,
        "latency_ms": latency_ms,
        # `in` thay `==`: rag.py cũng coi NO_DATA-là-substring là không có
        # data (line `if NO_DATA in text: sources = []`).
        "answered": NO_DATA not in res["answer"],
    })
    return {"sent": sent, "text": text, "sources": res["sources"]}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._json(200, {"status": "up"})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path != "/zalo-webhook":
            return self._json(404, {"error": "not found"})
        sig = self.headers.get("X-ZEvent-Signature", "")
        if not verify_signature(raw, sig):
            return self._json(403, {"error": "bad signature"})
        try:
            ev = json.loads(raw)
        except ValueError:
            return self._json(400, {"error": "bad json"})
        self._json(200, {"ok": True})  # ACK nhanh — reply async bên dưới
        if ev.get("event_name") != "user_send_text":
            return
        msg, sender = ev.get("message") or {}, ev.get("sender") or {}
        text, uid = (msg.get("text") or "").strip(), sender.get("id", "")
        if not text or not uid:
            return
        mid = msg.get("msg_id") or ""
        eid = f"{uid}:{mid or ev.get('timestamp', '')}"
        # Dedup/non-text return sớm ở trên -> chỉ event thật sự xử lý mới log.
        if not _dedup(eid):
            threading.Thread(target=handle_text, args=(uid, text, mid),
                             daemon=True).start()

    def log_message(self, fmt: str, *args: object) -> None:
        pass  # yên console — evidence do script/test ghi


def main() -> None:
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[zalo] webhook :{PORT}/zalo-webhook "
          f"(secret={'set' if APP_SECRET else 'MISSING'}, "
          f"token={'set' if ACCESS_TOKEN else 'MISSING'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
