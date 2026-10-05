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

Multi-turn (D4.1): history hội thoại giữ in-memory per user (tối đa 4 lượt
Q&A gần nhất, tối đa HIST_MAX_USERS user — LRU evict) — restart process
mất history, chấp nhận được cho pilot.

Chạy: `python -m connectors.zalo` -> :8788/zalo-webhook (port qua
ZALO_WEBHOOK_PORT). Env: ZALO_APP_ID, ZALO_APP_SECRET, ZALO_ACCESS_TOKEN.
DEPLOY=1/true/yes khi public -> fail-closed nếu thiếu secret/token (D5.1);
mặc định dev bypass signature — runbook: docs/deploy.md.
"""

import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu (fatal/warn prints). Ép UTF-8 — no-op nếu đã là UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

APP_ID = os.environ.get("ZALO_APP_ID", "")
APP_SECRET = os.environ.get("ZALO_APP_SECRET", "")
ACCESS_TOKEN = os.environ.get("ZALO_ACCESS_TOKEN", "")
PORT = int(os.environ.get("ZALO_WEBHOOK_PORT", "8788"))

SEND_URL = "https://openapi.zalo.me/v3.0/oa/message/cs"
MAX_TEXT = 2000  # giới hạn text của Zalo CS message
MAX_BODY = 1024 * 1024  # 1MB — event Zalo là JSON nhỏ; body lớn = DoS
FALLBACK = ("Sâm Sâm xin lỗi, câu trả lời tự động chưa đạt kiểm duyệt nội "
            "bộ. Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.")
# Hằng an toàn viết tay — gửi khi answer() crash; không cần qua check().
ERROR_FALLBACK = ("Sâm Sâm xin lỗi, hệ thống đang gặp sự cố. Quý khách "
                  "vui lòng gọi hotline 1800577732 để được hỗ trợ.")
# Hằng viết tay — gửi khi answer() trả NO_DATA (D6.1): khách có lối
# thoát thay vì câu NO_DATA trần; câu hỏi vẫn log answered:false vào
# queue cho nhân viên follow-up. Không cần qua check() (text viết tay).
HANDOFF_TEXT = ("Sâm Sâm chưa đủ dữ liệu để trả lời câu này — nhân "
                "viên sẽ phản hồi sớm nhất. Quý khách cần gấp vui lòng "
                "gọi hotline 1800577732 để được hỗ trợ.")

SEEN_TTL_S = 3600
SEEN_DB = ROOT / "data" / "zalo_seen.db"   # dedup sống qua restart (D3.5)
CONV_LOG = ROOT / "data" / "conversations.jsonl"  # log hội thoại (D3.3)
CONV_LOG_MAX = 5 * 1024 * 1024  # 5MB -> rotate sang .1 (D5.4)
# Entry convlog (user_hash + question đã mask) không nằm lại >30 ngày
# trên đĩa — purge lúc startup + ngay sau rotate (D5.11).
RETAIN_DAYS = 30
# SĐT VN (0 + >=9 số, kể cả viết cách "0901 234 567" / dash / dot —
# D5.10) hoặc email trong câu hỏi -> mask trước khi log (D5.3).
# `(?<!\d)` = số 0 mở đầu không được đứng sau chữ số khác -> giá
# "10.050.000.000" không bị ăn giữa chừng; `{9,}` greedy mask hết cả
# run dài bất thường, không lộ đuôi số. Separator tối đa 1 ký tự giữa
# 2 số -> ngày "05.10.2026" (7 số) hay "1.500.000" không bị ăn.
# Tên người + số không bắt đầu bằng 0 (+84...) không detect được.
_PII_RE = re.compile(r"(?<!\d)0(?:[ .-]?\d){9,}|[\w.+-]+@[\w-]+\.[\w.]+")

_seen_lock = threading.Lock()
_seen_conn: sqlite3.Connection | None = None  # lazy — không tạo file khi import
_log_lock = threading.Lock()
# user_id -> deque messages OpenAI-style; maxlen=8 = 4 cặp Q&A (D4.1)
# OrderedDict làm LRU: cap số user để dict không phình vô hạn khi webhook
# public — evict user lâu hoạt động nhất (D-nit v0.4).
HIST_MAX_USERS = 1000
_hist_lock = threading.Lock()
_histories: OrderedDict[str, deque] = OrderedDict()
# Lock striping (D5.5): cùng user -> cùng lock -> 2 message concurrent
# xử lý tuần tự (history append + reply đúng thứ tự). 64 lock bounded
# sẵn — va chạm stripe chỉ serialize 2 user khác nhau, vô hại.
_ULOCKS = [threading.Lock() for _ in range(64)]


_DEPLOY_ON = ("1", "true", "yes")


def _startup_error() -> str | None:
    """DEPLOY bật (1/true/yes) mà thiếu ZALO_APP_SECRET hoặc
    ZALO_ACCESS_TOKEN -> refuse to serve: thiếu secret = webhook nhận
    request giả mạo; thiếu token = ACK 200 nhưng reply không bao giờ tới
    (khó chẩn đoán hơn crash — D5.1). Dev local (DEPLOY tắt) vẫn serve.
    Đọc DEPLOY lúc call (không lúc import) để test monkeypatch env được."""
    if os.environ.get("DEPLOY", "").strip().lower() not in _DEPLOY_ON:
        return None
    if not APP_SECRET:
        return ("[fatal] zalo: DEPLOY bật nhưng thiếu ZALO_APP_SECRET — "
                "webhook không verify signature được, từ chối serve")
    if not ACCESS_TOKEN:
        return ("[fatal] zalo: DEPLOY bật nhưng thiếu ZALO_ACCESS_TOKEN — "
                "ACK được nhưng send API luôn fail, từ chối serve")
    return None


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


def _purge_convlog(path: Path) -> None:
    """Rewrite `path` bỏ dòng có ts cũ hơn RETAIN_DAYS (D5.11) — ts
    ISO-8601 Z so sánh lexicographic đúng. Đọc/ghi bytes: byte lỗi
    (dòng ghi dở khi crash) hay U+2028 trong question không phá purge/
    cắt đôi record. Dòng parse lỗi/thiếu ts giữ lại — thà giữ thừa còn
    hơn phá log vì 1 dòng hỏng. Ghi tmp + os.replace để crash giữa
    chừng không mất cả file."""
    if not path.exists():
        return
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                           time.gmtime(time.time() - RETAIN_DAYS * 86400))
    kept = []
    for line in path.read_bytes().split(b"\n"):
        if not line:
            continue
        try:
            obj = json.loads(line.decode("utf-8", "surrogateescape"))
        except ValueError:
            obj = None
        ts = obj.get("ts") if isinstance(obj, dict) else None
        if not isinstance(ts, str) or ts >= cutoff:
            kept.append(line)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(b"\n".join(kept) + (b"\n" if kept else b""))
    os.replace(tmp, path)


# Purge file active tối đa 1 lần/ngày khi có ghi — process chạy lâu ít
# traffic không giữ entry quá hạn tới tận restart (D5.11).
_last_purge = 0.0


def _log_conversation(entry: dict) -> None:
    """Append 1 dòng JSON vào conversations.jsonl; vượt CONV_LOG_MAX ->
    rotate sang `.1` (xóa `.1` cũ — 1 backup đủ cho pilot, D5.4) rồi
    purge entry quá hạn trong backup (D5.11). Lock vì nhiều thread reply
    song song; chỉ lưu user_hash, không lưu raw user_id (PII)."""
    global _last_purge
    CONV_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _log_lock:
        if time.time() - _last_purge > 86400:
            _last_purge = time.time()
            _purge_convlog(CONV_LOG)
        if (CONV_LOG.exists()
                and CONV_LOG.stat().st_size > CONV_LOG_MAX):
            bak = Path(str(CONV_LOG) + ".1")
            bak.unlink(missing_ok=True)
            CONV_LOG.rename(bak)
            _purge_convlog(bak)
        with CONV_LOG.open("a", encoding="utf-8") as f:
            f.write(line)


def unanswered() -> list[dict]:
    """Queue câu chưa trả lời cho nhân viên (D6.2): đọc convlog (+ `.1`
    backup nếu có — `.1` cũ hơn đọc trước), trả mọi entry
    `answered:false`. Đọc BYTES + split `\\n` — byte lỗi/U+2028 trong
    question không phá reader (bài học `_purge_convlog` v0.5.1). Reader
    chỉ để hiển thị nên decode `replace` (U+FFFD) — surrogateescape chỉ
    cần cho purge round-trip; lone surrogate làm crash st.dataframe."""
    out = []
    for p in (Path(str(CONV_LOG) + ".1"), CONV_LOG):
        if not p.exists():
            continue
        for line in p.read_bytes().split(b"\n"):
            if not line:
                continue
            try:
                e = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(e, dict) and e.get("answered") is False:
                out.append(e)
    return out


def _history(user_id: str) -> deque:
    """Deque history của user: get-or-create + mark mới-dùng-nhất (LRU).
    PHẢI gọi dưới _hist_lock. Đầy HIST_MAX_USERS -> evict entry cũ nhất —
    bound RAM khi public (signature đã chặn user giả, evict nhầm chỉ làm
    mất context follow-up, không mất an toàn)."""
    h = _histories.get(user_id)
    if h is None:
        if len(_histories) >= HIST_MAX_USERS:
            _histories.popitem(last=False)
        h = _histories[user_id] = deque(maxlen=8)
    else:
        _histories.move_to_end(user_id)
    return h


def _ulock(user_id: str) -> threading.Lock:
    """Lock per user qua striping — hash ổn định trong 1 process là đủ,
    không cần persist."""
    return _ULOCKS[hash(user_id) % len(_ULOCKS)]


def _uhash(user_id: str) -> str:
    """user_hash như field convlog — mọi print/log chỉ được dùng hash
    này, KHÔNG raw user_id (invariant: id thật không lọt ra stdout)."""
    return hashlib.sha256(user_id.encode()).hexdigest()[:16]


def _mask_pii(text: str) -> str:
    """Che SĐT/email user gõ vào câu hỏi trước khi ghi convlog — file đã
    gitignore nhưng vẫn nằm plaintext trên đĩa khi deploy. Tên người
    không detect được bằng regex — production cần retention policy."""
    return _PII_RE.sub("***", text)


def send_text(user_id: str, text: str) -> bool:
    """Gọi Zalo CS message API. Thiếu token -> warn + False (pipeline vẫn
    test được qua mock)."""
    if not ACCESS_TOKEN:
        print(f"[warn] zalo: chưa có ZALO_ACCESS_TOKEN — không gửi "
              f"(uh={_uhash(user_id)})", flush=True)
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
    """Điểm vào từ webhook thread — serialize per user (D5.5): 2 message
    concurrent cùng user_id xử lý tuần tự (lượt sau thấy history lượt
    trước, reply ra đúng thứ tự); user khác nhau vẫn song song."""
    with _ulock(user_id):
        return _reply(user_id, question, msg_id)


def _reply(user_id: str, question: str, msg_id: str = "") -> dict:
    """answer() -> guardrail -> send -> ghi conversation log. Lazy import
    vì api.rag nặng (numpy/psycopg/openai) — phần webhook thuần test
    không cần nó. History per user truyền vào answer() để câu follow-up
    ("còn loại kia?") resolve đúng ngữ cảnh."""
    from api.rag import NO_DATA, answer
    from pipelines.guardrail import check

    t0 = time.time()
    with _hist_lock:
        history = list(_history(user_id))
    try:
        # Chỉ truyền kwarg history khi đã có lượt trước — 1-turn gọi
        # y hệt signature cũ (mock `lambda q:` trong test cũ vẫn dùng được).
        res = (answer(question, history=history) if history
               else answer(question))
    except Exception as e:  # noqa: BLE001 — catch-all có chủ đích ở
        # thread boundary (D4.4): MỌI crash của answer() phải log +
        # fallback, thread không được chết câm mất vết câu hỏi.
        sent = send_text(user_id, ERROR_FALLBACK)
        _log_conversation({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "msg_id": msg_id,
            "user_hash": _uhash(user_id),
            "question": _mask_pii(question),
            "answer": "",
            "sources": [],
            # null chứ không phải False — guardrail chưa chạy (crash
            # trước check()); False sẽ đếm nhầm crash vào "violation".
            "guardrail_ok": None,
            "latency_ms": int((time.time() - t0) * 1000),
            "answered": False,
            "sent": sent,
            "error": repr(e)[:300],
        })
        return {"sent": sent, "text": ERROR_FALLBACK, "sources": []}
    latency_ms = int((time.time() - t0) * 1000)
    raw = res["answer"]
    # Check TRƯỚC khi append nguồn — URL là citation, slug tiếng Việt có
    # thể chứa từ cấm dạng viết trần ("chua-") và flag oan câu trả lời đúng.
    guardrail_ok = check(raw)["ok"]
    if not guardrail_ok:
        print(f"[warn] zalo: reply bị guardrail chặn -> fallback "
              f"(uh={_uhash(user_id)})", flush=True)
        text = FALLBACK
    else:
        if NO_DATA in raw:
            # D6.1: khách nhận handoff text có lối thoát, không phải câu
            # NO_DATA trần — câu hỏi vẫn log answered:false vào queue.
            text = HANDOFF_TEXT
            print(f"[handoff] zalo: NO_DATA -> handoff "
                  f"(uh={_uhash(user_id)})", flush=True)
        else:
            text = raw
            if res["sources"]:
                text += "\nNguồn: " + res["sources"][0]
        # Lượt hợp lệ (kể cả NO_DATA -> handoff) mới vào history — câu
        # bị flag thì không cho LLM "nhớ" text vi phạm ở lượt sau.
        with _hist_lock:
            h = _history(user_id)
            h.append({"role": "user", "content": question})
            h.append({"role": "assistant", "content": raw})
    sent = send_text(user_id, text)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "msg_id": msg_id,
        "user_hash": _uhash(user_id),
        "question": _mask_pii(question),
        "answer": text[:500],
        "sources": res["sources"],
        "guardrail_ok": guardrail_ok,
        "latency_ms": latency_ms,
        # `in` thay `==`: rag.py cũng coi NO_DATA-là-substring là không có
        # data (line `if NO_DATA in text: sources = []`).
        "answered": NO_DATA not in raw,
        "sent": sent,  # send-fail khác "đã xử lý" — giữ riêng để đối soát
    }
    if not guardrail_ok:
        entry["flagged_text"] = raw[:500]  # raw bị flag, debug guardrail
    _log_conversation(entry)
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
        # Chunked body không parse được (stdlib) — reject rõ 411 thay vì
        # coi length=0 rồi 403/400 mập mờ; định nghĩa trước để lỡ bật
        # keep-alive sau này không bị body sót đầu độc request kế (D5.9).
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self._json(411, {"error": "length required"})
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "bad content-length"})
        if length < 0:
            # read(-1) = đọc tới EOF — client giữ connection mở được
            return self._json(400, {"error": "bad content-length"})
        if length > MAX_BODY:
            return self._json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
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
    if err := _startup_error():
        print(err, flush=True)
        sys.exit(1)
    _purge_convlog(CONV_LOG)  # retention theo tuổi mỗi lần boot (D5.11)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[zalo] webhook :{PORT}/zalo-webhook "
          f"(secret={'set' if APP_SECRET else 'MISSING'}, "
          f"token={'set' if ACCESS_TOKEN else 'MISSING'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
