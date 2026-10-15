"""v5.1 (WP07, KD-A1) — Messenger (Facebook Page) webhook: nhận tin → ACK
200 nhanh → trả lời async qua CHUNG pipeline Zalo (`zalo.handle_text(...,
channel="messenger", send=send_text)`: lock per user, history, convlog
`_uhash`+`_mask_pii`, `channels.pre_route` rượu/sức khỏe trước LLM, handoff,
đồng ý). Chỉ inbox reply — không đăng bài (C2.4).

Bảo mật:
  - POST phải có `X-Hub-Signature-256` = "sha256=" + HMAC-SHA256(
    MESSENGER_APP_SECRET, raw body) (so `hmac.compare_digest`). KHÔNG có
    bypass dev: thiếu secret / chữ ký sai / thiếu → 403, không parse.
  - GET verify của Meta: `hub.mode=subscribe` + `hub.verify_token` khớp
    MESSENGER_VERIFY_TOKEN (rỗng → 403) → trả `hub.challenge` (chỉ chữ số).
  - DEPLOY tắt (≠ 1/true/yes, đọc lúc gọi) → `send_text` KHÔNG chạm mạng,
    chỉ in [dry-run]. DEPLOY bật → Graph API, token ở header Bearer (không
    nằm trong URL); thiếu 1 trong 4 biến env → fatal, không serve.
  - Dedup theo `mid` vào `data/zalo_seen.db` (khóa tiền tố `msgr:`) — không
    thêm file runtime. Log chỉ `_uhash`, không psid thô.
Meta app review + page token thật + webhook HTTPS public = external-dep.

Chạy: `python -m connectors.messenger` → :8789/messenger-webhook (port env
MESSENGER_WEBHOOK_PORT). Env: MESSENGER_APP_SECRET, MESSENGER_PAGE_TOKEN,
MESSENGER_VERIFY_TOKEN, CHANNEL_HASH_SALT, DEPLOY.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from dotenv import load_dotenv

from connectors import channels, zalo

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu (fatal/warn prints). Ép UTF-8 — no-op nếu đã là UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

PATH = "/messenger-webhook"
GRAPH_VERSION = "v21.0"
SEND_URL = f"https://graph.facebook.com/{GRAPH_VERSION}/me/messages"
MAX_BODY = 1024 * 1024    # 1MB — event Messenger là JSON nhỏ
MAX_TEXT = 2000           # giới hạn text tin nhắn Messenger
KEY_PREFIX = "messenger:"
_CHALLENGE_RE = re.compile(r"\d{1,64}")
_PSID_RE = re.compile(r"\d{1,32}")
REQUIRED_ENV = ("MESSENGER_APP_SECRET", "MESSENGER_PAGE_TOKEN",
                "MESSENGER_VERIFY_TOKEN")


def _env(key: str) -> str:
    return os.environ.get(key, "").strip()


def _deploy_on() -> bool:
    return os.environ.get("DEPLOY", "").strip().lower() in zalo._DEPLOY_ON


def _startup_error() -> str | None:
    """DEPLOY bật mà thiếu secret/token/muối → thông điệp fatal; dev → None."""
    if not _deploy_on():
        return None
    missing = [k for k in REQUIRED_ENV if not _env(k)]
    if not channels._salt():
        missing.append(f"{channels.SALT_ENV} (≥{channels.MIN_SALT_LEN} ký tự)")
    if missing:
        return (f"[fatal] messenger: DEPLOY bật nhưng thiếu {', '.join(missing)}"
                " — từ chối serve")
    return None


def verify_signature(raw: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(app secret, body).
    Thiếu secret hoặc header → False (không có bypass dev)."""
    secret = _env("MESSENGER_APP_SECRET")
    if not secret or not header:
        return False
    expect = "sha256=" + hmac.new(secret.encode("utf-8"), raw,
                                  hashlib.sha256).hexdigest()
    return hmac.compare_digest(header.strip().encode("latin-1", "replace"),
                               expect.encode("ascii"))


def send_text(user_key: str, text: str) -> bool:
    """Gửi 1 tin qua Graph API. DEPLOY tắt → không gửi gì ra Meta."""
    uh = zalo._uhash(user_key)
    if not _deploy_on():
        print(f"[dry-run] messenger: DEPLOY tắt — không gửi (uh={uh})",
              flush=True)
        return False
    token = _env("MESSENGER_PAGE_TOKEN")
    psid = user_key.removeprefix(KEY_PREFIX)
    if not token or not _PSID_RE.fullmatch(psid):
        print(f"[warn] messenger: thiếu page token hoặc psid lạ — không gửi"
              f" (uh={uh})", flush=True)
        return False
    try:
        r = httpx.post(SEND_URL,
                       headers={"Authorization": f"Bearer {token}"},
                       json={"recipient": {"id": psid},
                             "messaging_type": "RESPONSE",
                             "message": {"text": text[:MAX_TEXT]}},
                       timeout=zalo.SEND_TIMEOUT_S)  # v13.7 ngân sách 30s
    except httpx.HTTPError as e:
        print(f"[warn] messenger: send lỗi {type(e).__name__} (uh={uh})",
              flush=True)
        return False
    if not 200 <= r.status_code < 300:
        # Không in body — có thể lặp lại psid/chi tiết token.
        print(f"[warn] messenger: send HTTP {r.status_code} (uh={uh})",
              flush=True)
        return False
    return True


def _non_text(user_key: str) -> None:
    with zalo._ulock(user_key):  # cùng lock với text — không đảo thứ tự
        send_text(user_key, zalo.NON_TEXT_TEXT)


def dispatch(ev) -> int:
    """Event `object=page` → mỗi tin (không echo, mid chưa thấy) chạy 1
    thread. → số tin đã dispatch."""
    if not isinstance(ev, dict) or ev.get("object") != "page":
        return 0
    n = 0
    for entry in ev.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for m in entry.get("messaging") or []:
            if not isinstance(m, dict):
                continue
            msg = m.get("message")
            psid = (m.get("sender") or {}).get("id")
            if not isinstance(msg, dict) or msg.get("is_echo"):
                continue
            mid = msg.get("mid")
            if not (isinstance(psid, str) and _PSID_RE.fullmatch(psid)
                    and isinstance(mid, str) and mid):
                continue
            if zalo._dedup(f"msgr:{mid[:200]}"):
                continue
            key = KEY_PREFIX + psid
            text = msg.get("text")
            if isinstance(text, str) and text.strip():
                target, args, kw = zalo.handle_text, (key, text.strip(),
                                                      mid[:200]), {
                    "channel": "messenger", "send": send_text}
            else:
                target, args, kw = _non_text, (key,), {}
            threading.Thread(target=target, args=args, kwargs=kw,
                             daemon=True).start()
            n += 1
    return n


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: bytes,
               ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _json(self, code: int, obj: dict) -> None:
        self._reply(code, json.dumps(obj).encode())

    def do_GET(self) -> None:
        # Không đọc body GET — framing có body thì đóng connection (mẫu
        # zalo V8.1: byte sót không đầu độc request kế).
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
        else:
            try:
                if int(self.headers.get("Content-Length", 0)) != 0:
                    self.close_connection = True
            except ValueError:
                self.close_connection = True
        u = urlsplit(self.path)
        if u.path == "/healthz":
            return self._json(200, {"status": "up"})
        if u.path != PATH:
            return self._json(404, {"error": "not found"})
        q = parse_qs(u.query)
        mode = (q.get("hub.mode") or [""])[0]
        token = (q.get("hub.verify_token") or [""])[0]
        challenge = (q.get("hub.challenge") or [""])[0]
        expect = _env("MESSENGER_VERIFY_TOKEN")
        if not (expect and mode == "subscribe" and hmac.compare_digest(
                token.encode("utf-8"), expect.encode("utf-8"))):
            return self._json(403, {"error": "forbidden"})
        if not _CHALLENGE_RE.fullmatch(challenge):
            return self._json(400, {"error": "bad challenge"})
        self._reply(200, challenge.encode("ascii"), "text/plain")

    def do_POST(self) -> None:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            return self._json(411, {"error": "length required"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.close_connection = True
            return self._json(411 if not self.headers.get("Content-Length")
                              else 400, {"error": "bad content-length"})
        if length < 0:
            self.close_connection = True
            return self._json(400, {"error": "bad content-length"})
        if length > MAX_BODY:
            self.close_connection = True
            return self._json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
        if urlsplit(self.path).path != PATH:
            return self._json(404, {"error": "not found"})
        if not verify_signature(raw, self.headers.get("X-Hub-Signature-256")):
            return self._json(403, {"error": "bad signature"})
        try:
            ev = json.loads(raw)
        except ValueError:
            return self._json(400, {"error": "bad json"})
        self._json(200, {"ok": True})  # ACK nhanh — trả lời async
        dispatch(ev)

    def log_message(self, fmt: str, *args: object) -> None:
        pass  # yên console — không in path/query (verify_token)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m connectors.messenger",
        description="Messenger webhook (Facebook Page) — dùng chung pipeline "
                    "Zalo; DEPLOY tắt = không gửi gì ra Meta")
    ap.parse_args(argv)
    if err := _startup_error():
        print(err, flush=True)
        return 1
    # v14.2: login DB dịch vụ riêng (WEBHOOK_DATABASE_URL, role svc_webhook).
    from pipelines import auth  # lười: auth → director → ...
    if err := auth.bind_service("webhook"):
        print(f"[fatal] messenger: {err}", flush=True)
        return 1
    port = int(_env("MESSENGER_WEBHOOK_PORT") or "8789")
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    st = {k: "set" if _env(k) else "MISSING" for k in REQUIRED_ENV}
    print(f"[messenger] webhook :{port}{PATH} (app_secret="
          f"{st['MESSENGER_APP_SECRET']}, page_token="
          f"{st['MESSENGER_PAGE_TOKEN']}, verify_token="
          f"{st['MESSENGER_VERIFY_TOKEN']}, salt="
          f"{'set' if channels._salt() else 'MISSING'}, deploy="
          f"{'ON' if _deploy_on() else 'OFF (dry-run)'})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
