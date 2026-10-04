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
_seen: dict[str, float] = {}  # event_id đã xử lý -> ts


def verify_signature(raw: bytes, header: str) -> bool:
    """mac = sha256(app_id + raw_body + timestamp + OA_secret). Chưa cấu hình
    secret (dev local) -> bỏ qua; có secret mà sai/thiếu signature -> False."""
    if not APP_SECRET:
        return True
    try:
        data = json.loads(raw)
        expect = "mac=" + hashlib.sha256(
            (data["app_id"] + raw.decode() + data["timestamp"] + APP_SECRET)
            .encode()).hexdigest()
        return hmac.compare_digest(header, expect)
    except (KeyError, ValueError):
        return False


def _dedup(event_id: str) -> bool:
    """True nếu event đã xử lý — Zalo retry khi timeout sẽ nhân đôi reply."""
    now = time.time()
    for k in [k for k, t in _seen.items() if now - t > SEEN_TTL_S]:
        del _seen[k]
    if event_id in _seen:
        return True
    _seen[event_id] = now
    return False


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


def handle_text(user_id: str, question: str) -> dict:
    """answer() -> guardrail -> send. Lazy import vì api.rag nặng
    (numpy/psycopg/openai) — phần webhook thuần test không cần nó."""
    from api.rag import answer
    from pipelines.guardrail import check

    res = answer(question)
    text = res["answer"]
    if res["sources"]:
        text += "\nNguồn: " + res["sources"][0]
    if not check(text)["ok"]:
        print(f"[warn] zalo: reply bị guardrail chặn -> fallback "
              f"(user={user_id})", flush=True)
        text = FALLBACK
    sent = send_text(user_id, text)
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
        eid = f"{uid}:{msg.get('msg_id') or ev.get('timestamp', '')}"
        if not _dedup(eid):
            threading.Thread(target=handle_text, args=(uid, text),
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
